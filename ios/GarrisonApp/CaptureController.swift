import AVFoundation
import Foundation
import SwiftUI

/// Audio-only capture sessions (dictation, meetings, car): AVAudioEngine mic
/// tap -> OpusEncoder -> CaptureUploader, with the speech sink riding the
/// same socket.
///
/// The audio session uses .playAndRecord + .voiceChat + .defaultToSpeaker:
/// the voice-processing I/O unit applies hardware echo cancellation, which is
/// what makes speaking while the mic is hot survivable (ADR §6) — the echo
/// guard server-side mops up the residue. Interruptions (calls, Siri) pause
/// the tap and resume when the system hands the session back.
@MainActor
final class CaptureController: ObservableObject {
    enum Phase: Equatable {
        case idle
        case connecting
        case live
        case interrupted
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var sessionId: String?
    @Published private(set) var startedAt: Date?
    @Published private(set) var ackedFrames: Int = 0

    private let engine = AVAudioEngine()
    private var encoder: OpusEncoder?
    private var uploader: CaptureUploader?
    private let speechSink: SpeechSink
    private var sessionStartTime: Date?

    init(speechSink: SpeechSink = SpeechSink()) {
        self.speechSink = speechSink
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            Task { @MainActor in self?.handleInterruption(notification) }
        }
    }

    var isRunning: Bool { phase == .live || phase == .connecting || phase == .interrupted }

    func start(consent: ConsentState) {
        guard !isRunning else { return }
        guard let baseURL = AppGroup.baseURL, let token = AppGroup.token else {
            phase = .failed("Set the base URL and token in Settings first.")
            return
        }
        let id = SessionId.generate()
        sessionId = id
        startedAt = Date()
        sessionStartTime = Date()
        ackedFrames = 0
        phase = .connecting

        let uploader = CaptureUploader(
            baseURL: baseURL,
            token: token,
            sessionId: id,
            mode: .audio,
            deviceName: AppGroup.deviceName,
            consent: consent,
            spoolDirectory: AppGroup.spoolDirectory(sessionId: id)
        )
        self.uploader = uploader
        uploader.onStateChange = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .streaming: if self.phase == .connecting { self.phase = .live }
                case .failed(let message): if self.phase != .interrupted { self.phase = .failed(message) }
                case .ended: self.finishLocally()
                default: break
                }
            }
        }
        uploader.onAck = { [weak self] stream, _ in
            guard stream == "audio" else { return }
            Task { @MainActor in self?.ackedFrames += 1 }
        }
        // The mouth: acks arrive on the session socket, the sink decides, and
        // the receipt goes straight back so the server can tell silence from off.
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
        uploader.connect()

        do {
            try startEngine()
        } catch {
            phase = .failed("Microphone start failed: \(error.localizedDescription)")
            uploader.abandon()
            return
        }
    }

    private func startEngine() throws {
        let audioSession = AVAudioSession.sharedInstance()
        // .voiceChat routes through the voice-processing unit: hardware AEC,
        // so the sink can speak while the mic is hot (ADR §6).
        try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try audioSession.setActive(true)

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let encoder = OpusEncoder(inputFormat: format) else {
            throw NSError(domain: "garrison", code: 1, userInfo: [NSLocalizedDescriptionKey: "Opus encoder unavailable for \(format)"])
        }
        self.encoder = encoder
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self, let uploader = self.uploader, let start = self.sessionStartTime else { return }
            for packet in encoder.encode(buffer) {
                uploader.sendAudioPacket(packet, ts: Date().timeIntervalSince(start) * 1000)
            }
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        speechSink.stopAll()
        uploader?.end(reason: "user")
        // finishLocally runs when the server confirms session_ended; if the
        // link is down, fall back after a short grace so the UI never wedges.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if self.phase != .idle { self.finishLocally() }
        }
    }

    private func finishLocally() {
        uploader?.abandon()
        uploader = nil
        encoder = nil
        phase = .idle
        sessionId = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func handleInterruption(_ notification: Notification) {
        guard isRunning,
              let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue)
        else { return }
        switch type {
        case .began:
            phase = .interrupted
            engine.pause()
        case .ended:
            let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
            if options.contains(.shouldResume) {
                do {
                    try AVAudioSession.sharedInstance().setActive(true)
                    try engine.start()
                    phase = .live
                } catch {
                    phase = .failed("Could not resume after interruption: \(error.localizedDescription)")
                }
            }
        @unknown default:
            break
        }
    }
}
