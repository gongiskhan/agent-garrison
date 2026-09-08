import AVFoundation
import Capacitor
import Foundation

/// Voice-out for the page: speak a pre-rendered sentence through the same
/// SpeechUtterer the native ack sink uses, and read/write the speak.* keys
/// that sink honours. The keys live in the App Group because the broadcast
/// extension and the native sink read them too; the page is one more writer,
/// not the owner, so every write goes through the same key set with the same
/// types SpeechSink reads back (Float for rate/volume, Int hours, seconds for
/// muteUntil), or the sink would silently fall back to its defaults.
final class GarrisonSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GarrisonSpeech"
    let jsName = "GarrisonSpeech"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "muteFor", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unmute", returnType: CAPPluginReturnPromise),
    ]

    /// Its own utterer rather than the sink's: an ack must be able to cut a
    /// page-requested read-out short, not queue behind it.
    private let utterer = SpeechUtterer()

    private var defaults: UserDefaults? { AppGroup.defaults }

    // MARK: - Methods

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text")?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            call.reject("text must not be empty", "EMPTY_TEXT")
            return
        }
        let rate = Self.clamp(
            call.getDouble("rate") ?? storedNumber(AppGroup.Key.speakRate) ?? Double(AVSpeechUtteranceDefaultSpeechRate),
            Double(AVSpeechUtteranceMinimumSpeechRate), Double(AVSpeechUtteranceMaximumSpeechRate)
        )
        let volume = Self.clamp(call.getDouble("volume") ?? storedNumber(AppGroup.Key.speakVolume) ?? 1.0, 0, 1)
        let voiceId = Self.nonEmpty(call.getString("voiceId"))
            ?? Self.nonEmpty(defaults?.string(forKey: AppGroup.Key.speakVoiceId))
            ?? SpeechSink.localVoice(for: call.getString("lang"))
        // Main: the utterer's completion table is driven by delegate callbacks
        // on the main thread, and SpeechSink drives it from there too.
        Task { @MainActor in
            self.utterer.utter(text, rate: Float(rate), volume: Float(volume), voiceId: voiceId) { finished in
                call.resolve(["completed": finished])
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        Task { @MainActor in
            self.utterer.stop()
            call.resolve([:])
        }
    }

    @objc func voices(_ call: CAPPluginCall) {
        let prefix = Self.nonEmpty(call.getString("lang"))?.lowercased()
        let voices = AVSpeechSynthesisVoice.speechVoices()
            .filter { voice in
                guard let prefix else { return true }
                return voice.language.lowercased().hasPrefix(prefix)
            }
            .sorted { ($0.language, $0.name) < ($1.language, $1.name) }
            .map { voice -> [String: Any] in
                [
                    "identifier": voice.identifier,
                    "name": voice.name,
                    "language": voice.language,
                    "quality": Self.qualityName(voice.quality),
                ]
            }
        call.resolve(["voices": voices])
    }

    @objc func settings(_ call: CAPPluginCall) {
        call.resolve(settingsPayload())
    }

    /// Any subset of the settings keys. A known key with the wrong type or an
    /// out-of-range value rejects the whole call rather than half-applying;
    /// unknown keys are ignored so an older native build tolerates a newer page.
    @objc func configure(_ call: CAPPluginCall) {
        let options = call.options ?? [:]
        var writes: [() -> Void] = []

        for (key, storageKey) in [("master", AppGroup.Key.speakMaster), ("info", AppGroup.Key.speakInfo), ("cues", AppGroup.Key.speakCues)] {
            guard let raw = options[key] else { continue }
            guard let value = raw as? Bool else {
                call.reject("\(key) must be a boolean", "BAD_ARGS")
                return
            }
            writes.append { [weak self] in self?.defaults?.set(value, forKey: storageKey) }
        }

        if let raw = options["rate"] {
            guard let value = (raw as? NSNumber)?.doubleValue,
                  value >= Double(AVSpeechUtteranceMinimumSpeechRate), value <= Double(AVSpeechUtteranceMaximumSpeechRate)
            else {
                call.reject("rate must be a number between \(AVSpeechUtteranceMinimumSpeechRate) and \(AVSpeechUtteranceMaximumSpeechRate)", "BAD_ARGS")
                return
            }
            writes.append { [weak self] in self?.defaults?.set(Float(value), forKey: AppGroup.Key.speakRate) }
        }

        if let raw = options["volume"] {
            guard let value = (raw as? NSNumber)?.doubleValue, value >= 0, value <= 1 else {
                call.reject("volume must be a number between 0 and 1", "BAD_ARGS")
                return
            }
            writes.append { [weak self] in self?.defaults?.set(Float(value), forKey: AppGroup.Key.speakVolume) }
        }

        if let raw = options["voiceId"] {
            if raw is NSNull {
                writes.append { [weak self] in self?.defaults?.removeObject(forKey: AppGroup.Key.speakVoiceId) }
            } else if let value = raw as? String {
                // Empty string means "back to automatic", the same as null.
                writes.append { [weak self] in
                    if value.isEmpty {
                        self?.defaults?.removeObject(forKey: AppGroup.Key.speakVoiceId)
                    } else {
                        self?.defaults?.set(value, forKey: AppGroup.Key.speakVoiceId)
                    }
                }
            } else {
                call.reject("voiceId must be a string or null", "BAD_ARGS")
                return
            }
        }

        for (key, storageKey) in [("quietStart", AppGroup.Key.quietHoursStart), ("quietEnd", AppGroup.Key.quietHoursEnd)] {
            guard let raw = options[key] else { continue }
            guard let number = raw as? NSNumber, let value = Int(exactly: number.doubleValue), (-1 ... 23).contains(value) else {
                call.reject("\(key) must be an hour 0-23, or -1 for off", "BAD_ARGS")
                return
            }
            writes.append { [weak self] in self?.defaults?.set(value, forKey: storageKey) }
        }

        if let raw = options["muteUntil"] {
            guard let millis = (raw as? NSNumber)?.doubleValue, millis >= 0 else {
                call.reject("muteUntil must be an epoch timestamp in ms, or 0", "BAD_ARGS")
                return
            }
            writes.append { [weak self] in self?.defaults?.set(millis / 1000, forKey: AppGroup.Key.muteUntil) }
        }

        writes.forEach { $0() }
        call.resolve(settingsPayload())
    }

    @objc func muteFor(_ call: CAPPluginCall) {
        guard let minutes = call.getInt("minutes"), minutes > 0 else {
            call.reject("minutes must be a positive integer", "BAD_ARGS")
            return
        }
        defaults?.set(Date().timeIntervalSince1970 + Double(minutes) * 60, forKey: AppGroup.Key.muteUntil)
        call.resolve(settingsPayload())
    }

    @objc func unmute(_ call: CAPPluginCall) {
        defaults?.set(0.0, forKey: AppGroup.Key.muteUntil)
        call.resolve(settingsPayload())
    }

    // MARK: - Payload

    /// Same defaults SpeechSink applies when a key is unset, so the page shows
    /// what the sink will actually do. muteUntil crosses the bridge in ms like
    /// every other timestamp; the key itself holds seconds.
    private func settingsPayload() -> [String: Any] {
        var payload: [String: Any] = [
            "master": storedBool(AppGroup.Key.speakMaster, true),
            "info": storedBool(AppGroup.Key.speakInfo, true),
            "cues": storedBool(AppGroup.Key.speakCues, true),
            "rate": storedNumber(AppGroup.Key.speakRate) ?? Double(AVSpeechUtteranceDefaultSpeechRate),
            "volume": storedNumber(AppGroup.Key.speakVolume) ?? 1.0,
            "quietStart": storedInt(AppGroup.Key.quietHoursStart, -1),
            "quietEnd": storedInt(AppGroup.Key.quietHoursEnd, -1),
            "muteUntil": (storedNumber(AppGroup.Key.muteUntil) ?? 0) * 1000,
        ]
        if let voiceId = Self.nonEmpty(defaults?.string(forKey: AppGroup.Key.speakVoiceId)) {
            payload["voiceId"] = voiceId
        }
        return payload
    }

    private func storedBool(_ key: String, _ fallback: Bool) -> Bool {
        defaults?.object(forKey: key) as? Bool ?? fallback
    }

    private func storedInt(_ key: String, _ fallback: Int) -> Int {
        (defaults?.object(forKey: key) as? NSNumber).flatMap { Int(exactly: $0.doubleValue) } ?? fallback
    }

    /// Via NSNumber: the key may hold a Float (the sink's type) or a Double
    /// (older settings writes), and `as? Double` on a Float NSNumber can fail.
    private func storedNumber(_ key: String) -> Double? {
        (defaults?.object(forKey: key) as? NSNumber)?.doubleValue
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private static func clamp(_ value: Double, _ low: Double, _ high: Double) -> Double {
        min(max(value, low), high)
    }

    private static func qualityName(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        switch quality {
        case .premium: return "premium"
        case .enhanced: return "enhanced"
        default: return "default"
        }
    }
}
