import Foundation
import SwiftUI

/// Owns the pendant loop on the phone: BLE transport -> the existing
/// spool-then-send uploader (mode "pendant") -> capture service; and the
/// return path: server feedback events -> device haptic patterns + phone
/// sinks + the UI strip, each acked back so the server can measure
/// wake_to_device_ack_ms and card_commit_to_created_ack_ms honestly.
///
/// Session lifecycle: one capture session per BLE connection epoch. The
/// session survives BLE drops (the server holds it open for resume; audio
/// during the outage is simply lost, as on any live stream) and ends on
/// explicit disconnect.
@MainActor
final class PendantController: ObservableObject {
    struct FeedbackEntry: Identifiable, Equatable {
        let id: String
        let name: String
        let detail: String?
        let at: Date
        let deviceAcked: Bool
    }

    @Published private(set) var connectionState: PendantConnectionState = .disconnected
    @Published private(set) var uploaderState: CaptureUploader.State = .idle
    @Published private(set) var battery: Int?
    @Published private(set) var lostFrames = 0
    @Published private(set) var sessionId: String?
    @Published private(set) var feedbackLog: [FeedbackEntry] = []
    @Published private(set) var hapticSupported: Bool? // nil until probed
    /// From the service's /health: whether the pendant flag is on and which
    /// capture policy applies. Drives the "nothing is being stored" banner.
    @Published private(set) var capturePolicy: String?
    @Published private(set) var pendantFlagOn: Bool?

    private var transport: DeviceTransport
    private var uploader: CaptureUploader?
    private let phoneSink: PhoneFeedbackSink?
    private let speechSink: SpeechSink
    private var codec: PendantCodec = .opusFS320

    /// The device haptic vocabulary (ADR D4): patterns composed from the
    /// three fixed firmware levels. window_closed (double medium) and
    /// task_created (single long) stay clearly distinguishable.
    ///
    /// wake_lapsed is the retraction of a wake_detected. The wake pulse fires
    /// off an unstable Deepgram interim so it can be fast, which means it can
    /// also be wrong: when the authoritative final drops the name, no capture
    /// window ever opens. Without this the wearer feels the promise, dictates a
    /// whole task, and never learns it went nowhere. A double SHORT tick - the
    /// wake tier repeated - reads as "that wake did not stick"; window_closed's
    /// double MEDIUM is a different tier and stays distinct.
    ///
    /// segment_captured also stops being an identical single short. It is the
    /// one buzz that fires while the wearer is mid-sentence, i.e. exactly when
    /// they are most likely to misread it as a fresh wake.
    static func hapticPattern(for name: String) -> [(level: PendantHapticLevel, delayMs: Int)] {
        switch name {
        case "wake_detected": return [(.short, 0)]
        case "wake_lapsed": return [(.short, 0), (.short, 150)]
        case "segment_captured": return [(.short, 0), (.short, 400)]
        case "window_closed": return [(.medium, 0), (.medium, 250)]
        case "task_created": return [(.long, 0)]
        case "task_failed": return [(.medium, 0), (.medium, 350), (.medium, 700)]
        default: return []
        }
    }

    /// The app-lifetime pendant.
    ///
    /// The controller used to be a `@StateObject` inside PendantView, so
    /// navigating to Settings - or anywhere - tore it down: BLE dropped, the
    /// session ended, and the wearable went deaf until you walked back to that
    /// one screen. A pendant is an always-on device; its owner has to be the
    /// app, not a view. Views observe this; nobody else constructs one except
    /// tests, which pass their own transport.
    static let shared = PendantController()

    init(
        transport: DeviceTransport? = nil,
        phoneSink: PhoneFeedbackSink? = PhoneFeedbackSink(),
        speechSink: SpeechSink = SpeechSink()
    ) {
        self.transport = transport ?? PendantBLETransport(identifier: AppGroup.pendantIdentifier)
        self.phoneSink = phoneSink
        self.speechSink = speechSink
        wireTransport()
    }

    var isActive: Bool { connectionState != .disconnected }

    func connect() {
        refreshServiceState()
        transport.connect()
    }

    func disconnect() {
        transport.disconnect()
        endSession(reason: "user")
    }

    // MARK: - Transport wiring

    private func wireTransport() {
        if let ble = transport as? PendantBLETransport {
            ble.onIdentified = { identifier, _ in
                Task { @MainActor in AppGroup.pendantIdentifier = identifier }
            }
        }
        transport.onConnectionState = { [weak self] state in
            Task { @MainActor in self?.handleConnectionState(state) }
        }
        transport.onAudioFrame = { [weak self] frame in
            // Off the main actor on purpose: frames arrive 50/s and the
            // uploader has its own queue.
            self?.uploader?.sendAudioPacket(frame.payload, ts: frame.timestampMs)
        }
        transport.onBattery = { [weak self] level in
            Task { @MainActor in self?.battery = level }
        }
        transport.onAudioLoss = { [weak self] lost in
            Task { @MainActor in self?.lostFrames = lost }
        }
        transport.onButton = { _ in
            // Button semantics stay with the Omi app for now; recorded so a
            // later task can bind them.
        }
    }

    private func handleConnectionState(_ state: PendantConnectionState) {
        connectionState = state
        switch state {
        case .connected:
            transport.readBattery { [weak self] level in
                Task { @MainActor in self?.battery = level }
            }
            transport.readFeatures { [weak self] features in
                Task { @MainActor in
                    // Optimistic (protocol doc section 5): a failed read means
                    // devkit; the first haptic write settles it for real.
                    self?.hapticSupported = features.isEmpty ? nil : features.contains(.haptic)
                }
            }
            transport.readCodec { [weak self] codec in
                Task { @MainActor in
                    self?.codec = codec ?? .opusFS320
                    self?.startSessionIfNeeded()
                }
            }
        case .pairingLost, .bluetoothOff:
            endSession(reason: "error")
        case .disconnected:
            break // manual disconnect already ended the session
        default:
            break // scanning/connecting/reconnecting: session (if any) stays open for resume
        }
    }

    // MARK: - Session

    private func startSessionIfNeeded() {
        guard uploader == nil else { return } // reconnect epoch: same session resumes
        guard let baseURL = AppGroup.baseURL, let token = AppGroup.token else { return }
        let id = SessionId.generate()
        sessionId = id
        let uploader = CaptureUploader(
            baseURL: baseURL,
            token: token,
            sessionId: id,
            mode: .pendant,
            deviceName: "\(AppGroup.deviceName) pendant",
            consent: AppGroup.consentSuppressed || AppGroup.pendantAmbientConsent ? .suppressed : .shown,
            spoolDirectory: AppGroup.spoolDirectory(sessionId: id)
        )
        uploader.codec = codec == .opus ? "opus" : "opus_fs320"
        uploader.onStateChange = { [weak self] state in
            Task { @MainActor in self?.uploaderState = state }
        }
        uploader.onFeedback = { [weak self] event in
            Task { @MainActor in self?.handleFeedback(event) }
        }
        // The mouth. Until 2026-08-27 the server refused to speak to a pendant
        // session at all, so this was never wired - and the moment the server
        // started forwarding, the message arrived at a nil handler: no speech,
        // no receipt, silence that looked exactly like a broken voice.
        //
        // The wearer of a pendant is precisely who wants to be answered out
        // loud, and it is the same phone and the same speaker as the companion
        // lane, so the sink and the receipt path are identical to
        // CaptureController's.
        uploader.onSpeak = { [weak self] ack in
            Task { @MainActor in
                guard let self else { return }
                self.speechSink.onReceipt = { receipt in
                    uploader.sendSpokenReceipt(ackId: receipt.ackId, ok: receipt.ok, reason: receipt.reason)
                    AckLog.shared.append(AckLogEntry(
                        id: receipt.ackId,
                        at: Date(),
                        kind: ack.kind,
                        severity: ack.severity,
                        text: ack.text,
                        via: receipt.ok ? "spoken" : "dropped:\(receipt.reason ?? "unknown")"
                    ))
                }
                self.speechSink.handle(ack)
            }
        }
        self.uploader = uploader
        uploader.connect()
    }

    private func endSession(reason: String) {
        uploader?.end(reason: reason)
        uploader = nil
        sessionId = nil
    }

    // MARK: - Feedback

    private func handleFeedback(_ event: FeedbackEvent) {
        phoneSink?.play(event)
        // The spoken cue, if this event carries one. Non-blocking and dropped
        // rather than queued, so it can never sit in front of the haptic write
        // below - the feedback_ack rides that write, and wake_to_device_ack_ms
        // measures it.
        if let speak = event.speak {
            speechSink.speakCue(
                SpeechSink.Cue(
                    eventId: event.eventId,
                    text: speak.text,
                    lang: speak.lang,
                    audioPath: speak.audioPath,
                    at: ISO8601DateFormatter().date(from: event.at)
                )
            )
        }
        let pattern = Self.hapticPattern(for: event.name)
        if let first = pattern.first {
            // The ack rides on the FIRST physical device write - that is the
            // moment the wearer feels it, which is what the latency metric
            // claims to measure. Later pulses of the pattern follow behind.
            transport.writeHaptic(first.level) { [weak self] ok in
                self?.uploader?.sendFeedbackAck(eventId: event.eventId)
                Task { @MainActor in
                    if self?.hapticSupported == nil { self?.hapticSupported = ok }
                    self?.appendLog(event, deviceAcked: ok)
                }
            }
            for step in pattern.dropFirst() {
                let level = step.level
                DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(step.delayMs)) { [weak self] in
                    self?.transport.writeHaptic(level, completion: nil)
                }
            }
        } else {
            uploader?.sendFeedbackAck(eventId: event.eventId)
            appendLog(event, deviceAcked: false)
        }
    }

    private func appendLog(_ event: FeedbackEvent, deviceAcked: Bool) {
        let detail: String? = event.title ?? event.reason
        feedbackLog.insert(
            FeedbackEntry(id: event.eventId, name: event.name, detail: detail, at: Date(), deviceAcked: deviceAcked),
            at: 0
        )
        if feedbackLog.count > 50 { feedbackLog.removeLast(feedbackLog.count - 50) }
    }

    // MARK: - Service state

    /// Unauthenticated /health read: which flags are on and which capture
    /// policy applies (drives the wake_only "nothing stored" banner).
    func refreshServiceState() {
        guard let base = AppGroup.baseURL else { return }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = "/health"
        guard let url = components.url else { return }
        Task {
            guard let (data, _) = try? await URLSession.shared.data(from: url),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let flags = object["flags"] as? [String: Any]
            else { return }
            await MainActor.run {
                self.pendantFlagOn = flags["pendant"] as? Bool
                self.capturePolicy = flags["capturePolicy"] as? String
            }
        }
    }
}
