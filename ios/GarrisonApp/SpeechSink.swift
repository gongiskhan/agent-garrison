import AVFoundation
import Foundation

/// Something that can utter a sentence — AVSpeechSynthesizer in the app,
/// a recorder in tests. The sink's POLICY (queue ceiling, staleness, mute
/// rules) is what the tests pin down; the synthesizer is an implementation
/// detail behind this seam.
protocol Utterer {
    func utter(_ text: String, rate: Float, volume: Float, voiceId: String?, completion: @escaping (Bool) -> Void)
    func stop()
}

final class SpeechUtterer: NSObject, Utterer, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var completions: [ObjectIdentifier: (Bool) -> Void] = [:]
    private var ownsSession = false

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func utter(_ text: String, rate: Float, volume: Float, voiceId: String?, completion: @escaping (Bool) -> Void) {
        // Same reason as ClipPlayer: during a PENDANT session nothing has ever
        // configured the audio session, so an utterance went nowhere audible
        // while still reporting that it finished.
        ownsSession = SpeechAudioSession.activateIfNeeded()
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = rate
        utterance.volume = volume
        if let voiceId, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
            utterance.voice = voice
        }
        completions[ObjectIdentifier(utterance)] = completion
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        SpeechAudioSession.release(ownsSession)
        ownsSession = false
        completions.removeValue(forKey: ObjectIdentifier(utterance))?(true)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        SpeechAudioSession.release(ownsSession)
        ownsSession = false
        completions.removeValue(forKey: ObjectIdentifier(utterance))?(false)
    }
}

/// The voice-out sink (spec §5b). Behaviour rules, all testable through the
/// injected Utterer:
///  - speaks `ack.text` verbatim — the text is pre-rendered and pre-validated
///    upstream; the sink NEVER composes sentences;
///  - queue ceiling 3: beyond it the oldest INFO acks are dropped (an error
///    is never the one sacrificed); ten acks in five seconds must not produce
///    ten sentences;
///  - staleness ~30s: an old ack is dropped with an honest receipt, never
///    spoken as if it just happened;
///  - errors speak even when info acks are muted; the MASTER switch, quiet
///    hours and mute-for-N-minutes silence everything;
///  - every decision returns a receipt (spoken/failed + reason) so the server
///    can tell a silent sink from an off one.
final class SpeechSink {
    static let queueCeiling = 3
    static let stalenessSeconds: TimeInterval = 30
    /// A cue is worth saying only while it is still an ANSWER. "Sim?" arriving
    /// three seconds after you spoke is worse than silence - it sounds like a
    /// reply to whatever you said next.
    static let cueStalenessSeconds: TimeInterval = 2.5

    /// A short spoken cue: not an ack, and deliberately not subject to the ack
    /// queue. See `speakCue`.
    struct Cue {
        let eventId: String
        let text: String
        let lang: String?
        let audioPath: String?
        let at: Date?
    }

    struct Receipt {
        let ackId: String
        let ok: Bool
        let reason: String?
    }

    private let utterer: Utterer
    private let defaults: UserDefaults?
    private let now: () -> Date
    private let clipPlayer: ClipPlaying?
    private var queue: [AckPayload] = []
    private var speaking = false
    var onReceipt: ((Receipt) -> Void)?

    init(
        utterer: Utterer = SpeechUtterer(),
        clipPlayer: ClipPlaying? = ClipPlayer(),
        defaults: UserDefaults? = AppGroup.defaults,
        now: @escaping () -> Date = Date.init
    ) {
        self.utterer = utterer
        self.clipPlayer = clipPlayer
        self.defaults = defaults
        self.now = now
    }

    // MARK: - Controls (read live so a toggle applies within one ack)

    private var masterOn: Bool { defaults?.object(forKey: AppGroup.Key.speakMaster) as? Bool ?? true }
    private var infoOn: Bool { defaults?.object(forKey: AppGroup.Key.speakInfo) as? Bool ?? true }
    private var rate: Float { defaults?.object(forKey: AppGroup.Key.speakRate) as? Float ?? AVSpeechUtteranceDefaultSpeechRate }
    private var volume: Float { defaults?.object(forKey: AppGroup.Key.speakVolume) as? Float ?? 1.0 }
    private var voiceId: String? { defaults?.string(forKey: AppGroup.Key.speakVoiceId) }
    private var cuesOn: Bool { defaults?.object(forKey: AppGroup.Key.speakCues) as? Bool ?? true }

    private var mutedNow: Bool {
        if let until = defaults?.object(forKey: AppGroup.Key.muteUntil) as? Double, now().timeIntervalSince1970 < until {
            return true
        }
        let start = defaults?.object(forKey: AppGroup.Key.quietHoursStart) as? Int ?? -1
        let end = defaults?.object(forKey: AppGroup.Key.quietHoursEnd) as? Int ?? -1
        guard start >= 0, end >= 0, start != end else { return false }
        let hour = Calendar.current.component(.hour, from: now())
        return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end)
    }

    // MARK: - Cues

    /// Speak a wake/window cue, or drop it.
    ///
    /// Three deliberate departures from the ack policy above:
    ///
    ///  - a cue NEVER queues. Its entire value is immediacy, so behind anything
    ///    else it is worthless; busy means dropped, and the ack queue is left
    ///    completely untouched.
    ///  - its staleness is 2.5s, not 30s.
    ///  - it is NOT gated on `speakInfo`. That switch means "the operative's
    ///    routine created/finished chatter", and someone who muted that still
    ///    wants to know they were heard. The master switch, quiet hours, mute
    ///    and the dedicated cue toggle all still silence it.
    func speakCue(_ cue: Cue) {
        guard masterOn, !mutedNow, cuesOn else { return }
        if let at = cue.at, now().timeIntervalSince(at) > Self.cueStalenessSeconds { return }
        guard !speaking else { return }
        speaking = true
        if let clipPlayer, let audioPath = cue.audioPath, !audioPath.isEmpty {
            clipPlayer.play(path: audioPath, volume: volume) { [weak self] played in
                guard let self else { return }
                if played {
                    self.speaking = false
                    self.pump()
                } else {
                    self.utterCue(cue)
                }
            }
            return
        }
        utterCue(cue)
    }

    private func utterCue(_ cue: Cue) {
        utterer.utter(cue.text, rate: rate, volume: volume, voiceId: voiceId ?? Self.localVoice(for: cue.lang)) {
            [weak self] _ in
            guard let self else { return }
            self.speaking = false
            self.pump()
        }
    }

    /// Speaking a Portuguese sentence through an English synthesizer voice is
    /// the language-mixing bug one layer down, and it is invisible until you
    /// hear it. Only consulted when the user has not chosen a voice.
    /// The on-device voice for a fallback utterance.
    ///
    /// `AVSpeechSynthesisVoice(language: "pt-PT")` is NOT enough, and this is
    /// the whole "why is it Brazilian" bug: a stock iPhone ships Brazilian
    /// Portuguese and no pt-PT voice at all, so that initialiser returns nil,
    /// the utterance gets no explicit voice, and iOS reads Portuguese text in
    /// its default Portuguese voice - which is Brazilian. The ElevenLabs clip
    /// is European; every line that falls back to the phone is not.
    ///
    /// So: enumerate, take pt-PT explicitly, and prefer a higher-quality one
    /// when several are installed. Returns nil when the device genuinely has
    /// no European voice - the caller then reports which locale it settled
    /// for, rather than leaving it a mystery.
    static func localVoice(for lang: String?) -> String? {
        bestVoice(for: lang)?.identifier
    }

    static func bestVoice(for lang: String?) -> AVSpeechSynthesisVoice? {
        let wanted: [String]
        switch lang {
        case "pt": wanted = ["pt-PT"] // never pt-BR: European is the point
        case "en": wanted = ["en-GB", "en-US"]
        default: return nil
        }
        let installed = AVSpeechSynthesisVoice.speechVoices()
        for code in wanted {
            let matches = installed.filter { $0.language == code }
            if matches.isEmpty { continue }
            // Premium/enhanced first when the user has downloaded one.
            return matches.max { rank($0) < rank($1) }
        }
        return nil
    }

    private static func rank(_ voice: AVSpeechSynthesisVoice) -> Int {
        switch voice.quality {
        case .premium: return 3
        case .enhanced: return 2
        default: return 1
        }
    }

    /// What the phone actually did, for the receipt: the clip, or the
    /// synthesizer and in which locale. Without this the server cannot tell
    /// "spoke in Diogo" from "spoke in a Brazilian system voice" - they are
    /// both just `ok`, which is exactly how this went unnoticed.
    static func synthReason(for lang: String?) -> String {
        if let voice = bestVoice(for: lang) { return "synth:\(voice.language)" }
        let fallback = AVSpeechSynthesisVoice.currentLanguageCode()
        return "synth-default:\(lang ?? "?")→\(fallback)"
    }

    // MARK: - Intake

    func handle(_ ack: AckPayload) {
        let isError = ack.severity == "error"
        if !masterOn {
            onReceipt?(Receipt(ackId: ack.id, ok: false, reason: "sink-off"))
            return
        }
        if mutedNow, !isError {
            onReceipt?(Receipt(ackId: ack.id, ok: false, reason: "muted"))
            return
        }
        if !infoOn, !isError {
            onReceipt?(Receipt(ackId: ack.id, ok: false, reason: "info-muted"))
            return
        }
        if let emitted = ack.emittedAt, let at = ISO8601DateFormatter().date(from: emitted),
           now().timeIntervalSince(at) > Self.stalenessSeconds {
            onReceipt?(Receipt(ackId: ack.id, ok: false, reason: "stale"))
            return
        }
        queue.append(ack)
        enforceCeiling()
        pump()
    }

    private func enforceCeiling() {
        while queue.count > Self.queueCeiling {
            // Sacrifice the oldest INFO ack; an error is never the one dropped.
            if let index = queue.firstIndex(where: { $0.severity != "error" }) {
                let dropped = queue.remove(at: index)
                onReceipt?(Receipt(ackId: dropped.id, ok: false, reason: "queue-overflow"))
            } else {
                let dropped = queue.removeFirst()
                onReceipt?(Receipt(ackId: dropped.id, ok: false, reason: "queue-overflow"))
            }
        }
    }

    private func pump() {
        guard !speaking, !queue.isEmpty else { return }
        let ack = queue.removeFirst()
        speaking = true
        // Zeca's own voice when the service rendered one, the on-device
        // synthesizer otherwise - and ALSO whenever the clip fails to fetch or
        // play. The nicer voice must never be able to cost an acknowledgement:
        // a wearer who hears nothing cannot tell "no clip" from "not listening",
        // and that ambiguity is exactly what this app is bad at.
        if let clipPlayer, let audioPath = ack.audioPath, !audioPath.isEmpty {
            clipPlayer.play(path: audioPath, volume: volume) { [weak self] played in
                guard let self else { return }
                if played {
                    self.speaking = false
                    self.onReceipt?(Receipt(ackId: ack.id, ok: true, reason: "clip"))
                    self.pump()
                } else {
                    self.speakLocally(ack)
                }
            }
            return
        }
        speakLocally(ack)
    }

    private func speakLocally(_ ack: AckPayload) {
        let reason = Self.synthReason(for: ack.lang)
        utterer.utter(ack.text, rate: rate, volume: volume, voiceId: voiceId ?? Self.localVoice(for: ack.lang)) {
            [weak self] finished in
            guard let self else { return }
            self.speaking = false
            // The reason rides even on success: it is the ONLY way the server
            // learns a line was read by a system voice rather than Diogo.
            self.onReceipt?(Receipt(ackId: ack.id, ok: finished, reason: finished ? reason : "interrupted"))
            self.pump()
        }
    }

    func stopAll() {
        for pending in queue {
            onReceipt?(Receipt(ackId: pending.id, ok: false, reason: "sink-off"))
        }
        queue.removeAll()
        clipPlayer?.stop()
        utterer.stop()
    }
}
