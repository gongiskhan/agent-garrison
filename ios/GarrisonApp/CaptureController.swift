import AVFoundation
import Foundation
import SwiftUI

/// App-lifetime native microphone capture using the existing Opus ingress.
/// Listening intent is restored from the server; engine state is reported back.
@MainActor
final class CaptureController: ObservableObject {
    static let shared = CaptureController()
    let recovery: ListeningRecovery
    private var observers: [NSObjectProtocol] = []
    private var heartbeat: Task<Void, Never>?
    private var tapInstalled = false
    private var alwaysOn = false
    private var listeningStartReason = "user_start"
    private var requestGeneration = 0
    private let wakeTone = WakeAcknowledgement()
    var engineRunning: Bool { engine.isRunning }
    var wakeAcknowledgementInvocations: Int { wakeTone.invocations }
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

    private var engine = AVAudioEngine()
    private var encoder: OpusEncoder?
    private var uploader: CaptureUploader?
    private let speechSink: SpeechSink
    private var sessionStartTime: Date?

    init(speechSink: SpeechSink = SpeechSink(), recovery: ListeningRecovery? = nil) {
        self.speechSink = speechSink
        self.recovery = recovery ?? ListeningRecovery()
        self.recovery.startEngine = { [weak self] in try self?.startEngine() }
        self.recovery.pauseEngine = { [weak self] in self?.pauseEngine() }
        self.recovery.rebuildEngine = { [weak self] in self?.engine = AVAudioEngine() }
        self.recovery.report = { [weak self] actual, reason in
            guard let self else { return }
            switch actual {
            case "listening": self.phase = .live
            case "starting": self.phase = .connecting
            case "interrupted": self.phase = .interrupted
            case "failed": self.phase = .failed(reason)
            default: self.phase = .idle
            }
            if self.alwaysOn {
                ListeningChannel.shared.report(source: "phone", actual: actual, reason: reason)
                if reason == "resume_on_foreground" && actual == "listening" { ListeningChannel.shared.toast("Resumed listening") }
            }
        }
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in self?.recovery.interruption(note) }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in self?.recovery.routeChange(note) }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.recovery.mediaReset() }
        })
    }

    func beginListening(reason: String = "user_start") {
        alwaysOn = true
        listeningStartReason = reason
        if ListeningChannel.shared.records["phone"]?.actual == "stalled" {
            pauseEngine(); uploader?.abandon(); phase = .idle
        }
        guard !isRunning else { recovery.start(reason: reason); return }
        start(consent: AppGroup.consentSuppressed ? .suppressed : .shown)
        if reason == "resume_on_foreground" && recovery.actual == "listening" { ListeningChannel.shared.toast("Resumed listening") }
    }

    private func pauseEngine() {
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        engine.stop()
        flushEncoderTail()
    }

    var isRunning: Bool { phase == .live || phase == .connecting || phase == .interrupted }

    func start(consent: ConsentState, conversationId: String? = nil) {
        guard !isRunning else { return }
        requestGeneration += 1
        let expected = requestGeneration
        guard let baseURL = AppGroup.baseURL, let token = AppGroup.token else {
            phase = .failed("Set the base URL and token in Settings first.")
            return
        }
        // Without this gate a denied-permission session streams valid Opus
        // packets of pure silence under a live UI - the least diagnosable
        // failure the capture path can produce.
        switch AVAudioApplication.shared.recordPermission {
        case .denied:
            phase = .failed("permission_denied")
            if alwaysOn { ListeningChannel.shared.report(source: "phone", actual: "failed", reason: "permission_denied") }
            return
        case .undetermined:
            phase = .connecting
            Task { @MainActor in
                let granted = await AVAudioApplication.requestRecordPermission()
                guard self.requestGeneration == expected else { return }
                if granted {
                    self.phase = .idle
                    self.beginSession(baseURL: baseURL, token: token, consent: consent, conversationId: conversationId)
                } else {
                    self.phase = .failed("permission_denied")
                    if self.alwaysOn { ListeningChannel.shared.report(source: "phone", actual: "failed", reason: "permission_denied") }
                }
            }
            return
        default:
            break
        }
        beginSession(baseURL: baseURL, token: token, consent: consent, conversationId: conversationId)
    }

    private func beginSession(baseURL: URL, token: String, consent: ConsentState, conversationId: String? = nil) {
        guard !isRunning else { return }
        uploader?.abandon()
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
        uploader.conversationId = conversationId
        if alwaysOn {
            uploader.deviceId = ListeningChannel.shared.deviceId
            uploader.listeningSource = "phone"
            uploader.onWakeDetected = { [weak self] device, source, at in
                Task { @MainActor in
                    guard self?.sessionId == id, device == ListeningChannel.shared.deviceId, source == "phone", self?.engineRunning == true else { return }
                    self?.wakeTone.play(at: at)
                }
            }
        }
        self.uploader = uploader
        uploader.onStateChange = { [weak self] state in
            Task { @MainActor in
                guard let self, self.sessionId == id else { return }
                switch state {
                case .streaming: if self.engineRunning { self.phase = .live; if self.alwaysOn { ListeningChannel.shared.report(source: "phone", actual: "listening", reason: "resume_retry") } }
                case .failed(let message): if self.phase != .interrupted { self.phase = .failed(message) }
                case .ended: if self.recovery.intent { self.phase = .failed("engine_error") } else { self.finishLocally() }
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
        uploader.onInterruptSpeech = { [weak self] ids in
            Task { @MainActor in self?.speechSink.interrupt(ackIds: ids) }
        }
        uploader.onSpeak = { [weak self, weak uploader] ack in
            Task { @MainActor in
                guard let self else { return }
                self.speechSink.onReceipt = { receipt in
                    uploader?.sendSpokenReceipt(ackId: receipt.ackId, ok: receipt.ok, reason: receipt.reason)
                }
                self.speechSink.handle(ack)
            }
        }
        uploader.connect()

        recovery.start(reason: alwaysOn ? listeningStartReason : "user_start")
        heartbeat?.cancel()
        heartbeat = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(ListeningConstants.HEARTBEAT_SECONDS * 1_000_000_000))
                guard !Task.isCancelled, let self else { return }
                if self.alwaysOn && self.engine.isRunning && self.recovery.actual == "listening", let device = ListeningChannel.shared.deviceId {
                    self.uploader?.sendListening(ListeningMessage(type: "listening.heartbeat", device_id: device, source: "phone"))
                } else if self.recovery.intent && self.recovery.actual == "listening" && !self.engine.isRunning {
                    self.recovery.attempt("engine_error")
                }
            }
        }
    }

    private func startEngine() throws {
        pauseEngine()
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(ListeningRecovery.category, mode: ListeningRecovery.mode, options: ListeningRecovery.options)
        try audioSession.setActive(true)
        if let input = audioSession.availableInputs?.first(where: { $0.portType == .builtInMic }) { try audioSession.setPreferredInput(input) }
        try installTap()
        engine.prepare()
        try engine.start()
    }

    private func installTap() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "garrison.audio", code: 1) }
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
        tapInstalled = true
    }

    func stop() {
        if alwaysOn { ListeningChannel.shared.intent("phone", "off") }
        stopForServer(reason: "user_stop")
    }

    func stopForServer(reason: String) {
        requestGeneration += 1
        recovery.stop(reason: reason)
        heartbeat?.cancel()
        heartbeat = nil
        speechSink.stopAll()
        let ending = uploader
        uploader = nil
        sessionId = nil
        phase = .idle
        ending?.end(reason: "user")
        alwaysOn = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
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
        pauseEngine()
        uploader?.abandon()
        uploader = nil
        encoder = nil
        phase = .idle
        sessionId = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
