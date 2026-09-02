import AVFoundation
import Foundation
import SwiftUI

/// Audio-only capture sessions (dictation, meetings, car): AVAudioEngine mic
/// tap -> OpusEncoder -> CaptureUploader, with the speech sink riding the
/// same socket.
///
/// The audio session uses .playAndRecord + .voiceChat + .defaultToSpeaker:
/// the voice-processing I/O unit applies hardware echo cancellation, which is
/// what makes speaking while the mic is hot survivable (ADR §6) - the echo
/// guard server-side mops up the residue. VPIO also attenuates the input;
/// that cost is paid back by the encoder's guarded normalization, not by
/// giving up AEC. Interruptions (calls, Siri) pause the tap and resume when
/// the system hands the session back; route changes (headset, CarPlay)
/// rebuild the tap for the new hardware format instead of dying silently.
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
        // A route change mid-session (Bluetooth/CarPlay/headset - routine for
        // the car use case) changes the input hardware format and stops the
        // engine; without this observer capture dies silently under a UI that
        // still says live.
        NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.rebuildTapAfterConfigChange() }
        }
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.rebuildTapAfterConfigChange() }
        }
    }

    var isRunning: Bool { phase == .live || phase == .connecting || phase == .interrupted }

    func start(consent: ConsentState) {
        guard !isRunning else { return }
        guard let baseURL = AppGroup.baseURL, let token = AppGroup.token else {
            phase = .failed("Set the base URL and token in Settings first.")
            return
        }
        // Without this gate a denied-permission session streams valid Opus
        // packets of pure silence under a live UI - the least diagnosable
        // failure the capture path can produce.
        switch AVAudioApplication.shared.recordPermission {
        case .denied:
            phase = .failed("Microphone access is denied. Enable it in Settings > Privacy > Microphone.")
            return
        case .undetermined:
            phase = .connecting
            Task { @MainActor in
                let granted = await AVAudioApplication.requestRecordPermission()
                if granted {
                    self.phase = .idle
                    self.beginSession(baseURL: baseURL, token: token, consent: consent)
                } else {
                    self.phase = .failed("Microphone access is denied. Enable it in Settings > Privacy > Microphone.")
                }
            }
            return
        default:
            break
        }
        beginSession(baseURL: baseURL, token: token, consent: consent)
    }

    private func beginSession(baseURL: URL, token: String, consent: ConsentState) {
        guard !isRunning else { return }
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
        try installTap()
        engine.prepare()
        try engine.start()
    }

    private func installTap() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let encoder = OpusEncoder(inputFormat: format) else {
            throw NSError(domain: "garrison", code: 1, userInfo: [NSLocalizedDescriptionKey: "Opus encoder unavailable for \(format)"])
        }
        self.encoder = encoder
        // The tap closure runs on the engine's render thread: everything it
        // touches is captured immutably HERE, so it never reads MainActor
        // state mid-teardown.
        guard let uploader = self.uploader, let start = self.sessionStartTime else {
            throw NSError(domain: "garrison", code: 2, userInfo: [NSLocalizedDescriptionKey: "No uploader for tap"])
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            for packet in encoder.encode(buffer) {
                uploader.sendAudioPacket(packet, ts: Date().timeIntervalSince(start) * 1000)
            }
        }
    }

    /// Route change / media-services reset: the input format may have changed
    /// under the engine. Rebuild the tap and encoder for whatever the
    /// hardware is now, sending the old encoder's tail first.
    private func rebuildTapAfterConfigChange() {
        guard isRunning, phase != .interrupted else { return }
        engine.inputNode.removeTap(onBus: 0)
        flushEncoderTail()
        do {
            try installTap()
            engine.prepare()
            try engine.start()
        } catch {
            phase = .failed("Audio route changed and capture could not resume: \(error.localizedDescription)")
        }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        flushEncoderTail()
        speechSink.stopAll()
        uploader?.end(reason: "user")
        // finishLocally runs when the server confirms session_ended; if the
        // link is down, fall back after a short grace so the UI never wedges.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if self.phase != .idle { self.finishLocally() }
        }
    }

    /// Drain the converter's buffered tail (the end of the last spoken word -
    /// wake commands end on their payload, so this tail is never filler) and
    /// ship it before the session closes.
    private func flushEncoderTail() {
        guard let encoder, let uploader, let start = sessionStartTime else { return }
        for packet in encoder.flush() {
            uploader.sendAudioPacket(packet, ts: Date().timeIntervalSince(start) * 1000)
        }
        self.encoder = nil
    }

    private func finishLocally() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
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
            // Ship the tail now: if the interruption never ends (call runs
            // long, session times out server-side) the last word is not lost.
            engine.inputNode.removeTap(onBus: 0)
            flushEncoderTail()
        case .ended:
            let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
            if options.contains(.shouldResume) {
                do {
                    try AVAudioSession.sharedInstance().setActive(true)
                    // The encoder was flushed at .began; build a fresh one.
                    try installTap()
                    engine.prepare()
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
