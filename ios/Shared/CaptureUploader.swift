import Foundation

/// The session engine over one WebSocket (spec §4), shared by the app's
/// audio-only mode and the broadcast extension. Hardened past the ios-thing
/// original it descends from:
///
///  - every media frame is SPOOLED to the App Group container before any send
///    attempt (offline behaviour; disk bounded by the spool's ring);
///  - the server acks the highest contiguous seq per stream; after a drop the
///    uploader reconnects, re-issues session_start, and replays every spooled
///    frame past the server's reported high-water marks;
///  - inbound JSON is parsed: acks advance the resume point, {type:"speak"}
///    reaches the app's speech sink, and the sink's {spoken} receipt rides
///    back on the same socket.
///
/// Reconnect keeps ios-thing's discipline: capped exponential backoff,
/// `isReady`-gated sends (drop to spool, never queue in memory).
final class CaptureUploader: NSObject {
    enum State: Equatable {
        case idle
        case connecting
        case streaming
        case failed(String)
        case ended
    }

    let sessionId: String
    let mode: SessionMode
    private let baseURL: URL
    private let token: String
    private let deviceName: String
    private let consent: ConsentState
    private let spool: SessionSpool
    private let queue = DispatchQueue(label: "garrison.uploader")

    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var shouldReconnect = true
    private var reconnectDelay: TimeInterval = 1.0
    private let maxReconnectDelay: TimeInterval = 16.0

    private var nextAudioSeq: UInt32 = 1
    private var nextVideoSeq: UInt32 = 1
    private(set) var ackedAudio: UInt32 = 0
    private(set) var ackedVideo: UInt32 = 0
    private var serverConfirmedStart = false

    private(set) var state: State = .idle {
        didSet { onStateChange?(state) }
    }

    var onStateChange: ((State) -> Void)?
    var onSpeak: ((AckPayload) -> Void)?
    var onAck: ((String, UInt32) -> Void)?
    var onSessionEnded: ((String) -> Void)?

    init(baseURL: URL, token: String, sessionId: String, mode: SessionMode, deviceName: String, consent: ConsentState, spoolDirectory: URL) {
        self.baseURL = baseURL
        self.token = token
        self.sessionId = sessionId
        self.mode = mode
        self.deviceName = deviceName
        self.consent = consent
        self.spool = SessionSpool(directory: spoolDirectory)
        super.init()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 10
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        // Crash recovery: continue numbering after whatever the spool holds.
        let highWater = spool.highWater()
        nextAudioSeq = highWater.audio + 1
        nextVideoSeq = highWater.video + 1
    }

    private var socketURL: URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/capture/stream"
        return components.url!
    }

    func connect() {
        queue.async { [weak self] in
            guard let self else { return }
            self.shouldReconnect = true
            self.openTask()
        }
    }

    private func openTask() {
        state = .connecting
        serverConfirmedStart = false
        var request = URLRequest(url: socketURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        receiveLoop()
    }

    private func sendControl<T: Encodable>(_ message: T) {
        guard let task, let data = try? JSONEncoder().encode(message), let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { [weak self] error in
            if let error { self?.handleFailure(error.localizedDescription) }
        }
    }

    // MARK: - Media

    /// Spool-then-send: the frame is durable before the network sees it.
    func sendAudioPacket(_ payload: Data, ts: Double) {
        queue.async { [weak self] in
            guard let self else { return }
            let seq = self.nextAudioSeq
            self.nextAudioSeq += 1
            let frame = CaptureFraming.encode(kind: .audio, seq: seq, ts: ts, payload: payload)
            self.spool.append(frame)
            self.sendFrameIfReady(frame)
        }
    }

    func sendVideoFrame(_ payload: Data, ts: Double) {
        queue.async { [weak self] in
            guard let self else { return }
            let seq = self.nextVideoSeq
            self.nextVideoSeq += 1
            let frame = CaptureFraming.encode(kind: .video, seq: seq, ts: ts, payload: payload)
            self.spool.append(frame)
            self.sendFrameIfReady(frame)
        }
    }

    private func sendFrameIfReady(_ frame: Data) {
        guard state == .streaming, serverConfirmedStart, let task else { return } // spooled; drains on resume
        task.send(.data(frame)) { [weak self] error in
            if let error { self?.handleFailure(error.localizedDescription) }
        }
    }

    func sendSpokenReceipt(ackId: String, ok: Bool, reason: String? = nil) {
        queue.async { [weak self] in
            self?.sendControl(SpokenReceiptMessage(spoken: ackId, ok: ok, reason: reason))
        }
    }

    func end(reason: String = "user") {
        queue.async { [weak self] in
            guard let self else { return }
            self.shouldReconnect = false
            self.sendControl(SessionEndMessage(reason: reason))
        }
    }

    func abandon() {
        queue.async { [weak self] in
            guard let self else { return }
            self.shouldReconnect = false
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.state = .idle
        }
    }

    // MARK: - Inbound

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message, let parsed = ServerMessage.parse(text) {
                    self.queue.async { self.handleServerMessage(parsed) }
                }
                self.receiveLoop()
            case .failure(let error):
                self.handleFailure(error.localizedDescription)
            }
        }
    }

    private func handleServerMessage(_ message: ServerMessage) {
        switch message {
        case .sessionStarted:
            serverConfirmedStart = true
            state = .streaming
            drainSpool(afterAudio: 0, video: 0)
        case .sessionResumed(_, let audioSeq, let videoSeq):
            serverConfirmedStart = true
            ackedAudio = audioSeq
            ackedVideo = videoSeq
            state = .streaming
            drainSpool(afterAudio: audioSeq, video: videoSeq)
        case .ack(let stream, let seq):
            if stream == "audio" { ackedAudio = max(ackedAudio, seq) } else { ackedVideo = max(ackedVideo, seq) }
            onAck?(stream, seq)
        case .speak(let ack):
            onSpeak?(ack)
        case .sessionEnded(let reason):
            state = .ended
            spool.removeAll()
            onSessionEnded?(reason)
        case .serverError(let error):
            state = .failed(error)
            shouldReconnect = false
        }
    }

    /// Replay everything the server has not confirmed, in stored order.
    private func drainSpool(afterAudio audioSeq: UInt32, video videoSeq: UInt32) {
        guard let task else { return }
        for frame in spool.frames(afterAudio: audioSeq, video: videoSeq) {
            task.send(.data(frame)) { [weak self] error in
                if let error { self?.handleFailure(error.localizedDescription) }
            }
        }
    }

    private func handleFailure(_ message: String) {
        queue.async { [weak self] in
            guard let self, self.state != .ended else { return }
            self.state = .failed(message)
            self.task = nil
            guard self.shouldReconnect else { return }
            let delay = self.reconnectDelay
            self.reconnectDelay = min(self.maxReconnectDelay, self.reconnectDelay * 2)
            self.queue.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.shouldReconnect else { return }
                self.openTask()
            }
        }
    }
}

extension CaptureUploader: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        queue.async { [weak self] in
            guard let self else { return }
            self.reconnectDelay = 1.0
            // (Re)announce the session; the server answers session_started or
            // session_resumed with its high-water marks.
            self.sendControl(SessionStartMessage(
                sessionId: self.sessionId,
                mode: self.mode.rawValue,
                deviceName: self.deviceName,
                consent: self.consent.rawValue,
                startedAt: ISO8601DateFormatter().string(from: Date())
            ))
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        handleFailure("closed: \(closeCode.rawValue)")
    }
}
