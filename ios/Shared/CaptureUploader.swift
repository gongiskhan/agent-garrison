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
    private let connectionTimeout: TimeInterval
    private var reconnectWork: DispatchWorkItem?
    private var connectionDeadline: DispatchWorkItem?
    private var finished = false

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
    /// Pendant sessions: server-pushed feedback lifecycle events. The sink
    /// acts (device haptic, phone sounds, UI strip) and MUST call
    /// sendFeedbackAck so the server's latency metrics mean something.
    var onFeedback: ((FeedbackEvent) -> Void)?
    /// Pendant sessions only: the device codec announced in session_start.
    var codec: String?
    /// The conversation the recording reports back into, when started from one.
    var conversationId: String?

    init(baseURL: URL, token: String, sessionId: String, mode: SessionMode, deviceName: String, consent: ConsentState, spoolDirectory: URL, connectionTimeout: TimeInterval = 10) {
        self.baseURL = baseURL
        self.token = token
        self.sessionId = sessionId
        self.mode = mode
        self.deviceName = deviceName
        self.consent = consent
        self.connectionTimeout = connectionTimeout
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
            guard let self, !self.finished, self.task == nil, self.reconnectWork == nil else { return }
            self.shouldReconnect = true
            self.openTask()
        }
    }

    private func openTask() {
        guard !finished, shouldReconnect, task == nil else { return }
        state = .connecting
        serverConfirmedStart = false
        var request = URLRequest(url: socketURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        self.task = task
        // waitsForConnectivity and an open WebSocket without session_started
        // can otherwise leave the page saying "connecting" indefinitely.
        let deadline = DispatchWorkItem { [weak self, weak task] in
            guard let self, let task, self.task === task, !self.serverConfirmedStart else { return }
            self.handleFailure("Capture connection timed out", from: task)
        }
        connectionDeadline = deadline
        queue.asyncAfter(deadline: .now() + connectionTimeout, execute: deadline)
        task.resume()
        receiveLoop(task)
    }

    private func sendControl<T: Encodable>(_ message: T) {
        guard let task, let data = try? JSONEncoder().encode(message), let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { [weak self] error in
            if let error { self?.handleFailure(error.localizedDescription, from: task) }
        }
    }

    // MARK: - Media

    /// Spool-then-send: the frame is durable before the network sees it.
    func sendAudioPacket(_ payload: Data, ts: Double) {
        queue.async { [weak self] in
            guard let self, !self.finished else { return }
            let seq = self.nextAudioSeq
            self.nextAudioSeq += 1
            let frame = CaptureFraming.encode(kind: .audio, seq: seq, ts: ts, payload: payload)
            self.spool.append(frame)
            self.sendFrameIfReady(frame)
        }
    }

    func sendVideoFrame(_ payload: Data, ts: Double) {
        queue.async { [weak self] in
            guard let self, !self.finished else { return }
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
            if let error { self?.handleFailure(error.localizedDescription, from: task) }
        }
    }

    func sendSpokenReceipt(ackId: String, ok: Bool, reason: String? = nil) {
        queue.async { [weak self] in
            self?.sendControl(SpokenReceiptMessage(spoken: ackId, ok: ok, reason: reason))
        }
    }

    func sendFeedbackAck(eventId: String) {
        queue.async { [weak self] in
            self?.sendControl(FeedbackAckMessage(eventId: eventId))
        }
    }

    func end(reason: String = "user") {
        queue.async { [weak self] in
            guard let self else { return }
            guard !self.finished else { return }
            self.shouldReconnect = false
            self.reconnectWork?.cancel()
            self.reconnectWork = nil
            self.connectionDeadline?.cancel()
            self.connectionDeadline = nil
            guard self.task != nil, self.serverConfirmedStart else {
                self.finish(state: .ended)
                return
            }
            self.sendControl(SessionEndMessage(reason: reason))
            // Give the server time to acknowledge the end, but never keep an
            // uploader (and URLSession's strong delegate reference) alive forever.
            self.queue.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, !self.finished, !self.shouldReconnect else { return }
                self.finish(state: .ended)
            }
        }
    }

    func abandon() {
        queue.async { [weak self] in
            guard let self else { return }
            self.finish(state: .idle)
        }
    }

    // MARK: - Inbound

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard self.task === task, !self.finished else { return }
                switch result {
                case .success(let message):
                    if case .string(let text) = message, let parsed = ServerMessage.parse(text) {
                        self.handleServerMessage(parsed)
                    }
                    if self.task === task { self.receiveLoop(task) }
                case .failure(let error):
                    self.handleFailure(error.localizedDescription, from: task)
                }
            }
        }
    }

    private func handleServerMessage(_ message: ServerMessage) {
        switch message {
        case .sessionStarted:
            confirmStart()
            drainSpool(afterAudio: 0, video: 0)
        case .sessionResumed(_, let audioSeq, let videoSeq):
            confirmStart()
            ackedAudio = audioSeq
            ackedVideo = videoSeq
            drainSpool(afterAudio: audioSeq, video: videoSeq)
        case .ack(let stream, let seq):
            if stream == "audio" { ackedAudio = max(ackedAudio, seq) } else { ackedVideo = max(ackedVideo, seq) }
            onAck?(stream, seq)
        case .speak(let ack):
            onSpeak?(ack)
        case .feedback(let event):
            onFeedback?(event)
        case .sessionEnded(let reason):
            finish(state: .ended)
            spool.removeAll()
            onSessionEnded?(reason)
        case .serverError(let error):
            finish(state: .failed(error))
        }
    }

    private func confirmStart() {
        connectionDeadline?.cancel()
        connectionDeadline = nil
        reconnectDelay = 1.0
        serverConfirmedStart = true
        state = .streaming
    }

    private func finish(state: State) {
        finished = true
        shouldReconnect = false
        reconnectWork?.cancel()
        reconnectWork = nil
        connectionDeadline?.cancel()
        connectionDeadline = nil
        let oldTask = task
        task = nil
        serverConfirmedStart = false
        oldTask?.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
        self.state = state
    }

    /// Replay everything the server has not confirmed, in stored order.
    private func drainSpool(afterAudio audioSeq: UInt32, video videoSeq: UInt32) {
        guard let task else { return }
        for frame in spool.frames(afterAudio: audioSeq, video: videoSeq) {
            task.send(.data(frame)) { [weak self] error in
                if let error { self?.handleFailure(error.localizedDescription, from: task) }
            }
        }
    }

    private func handleFailure(_ message: String, from failedTask: URLSessionWebSocketTask) {
        queue.async { [weak self] in
            // A socket may fail through receive, close and hundreds of pending
            // sends. Only its first failure owns recovery. Late callbacks must
            // never clear a newer socket or start another competing reconnect.
            guard let self, !self.finished, self.task === failedTask else { return }
            self.task = nil
            self.serverConfirmedStart = false
            self.connectionDeadline?.cancel()
            self.connectionDeadline = nil
            failedTask.cancel(with: .goingAway, reason: nil)
            self.state = .failed(message)
            guard self.shouldReconnect else {
                self.finish(state: .ended)
                return
            }
            let delay = self.reconnectDelay
            self.reconnectDelay = min(self.maxReconnectDelay, self.reconnectDelay * 2)
            let retry = DispatchWorkItem { [weak self] in
                guard let self, self.shouldReconnect, !self.finished else { return }
                self.reconnectWork = nil
                self.openTask()
            }
            self.reconnectWork = retry
            self.queue.asyncAfter(deadline: .now() + delay, execute: retry)
        }
    }
}

extension CaptureUploader: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        queue.async { [weak self] in
            guard let self, self.task === webSocketTask, !self.finished, self.shouldReconnect else { return }
            // (Re)announce the session; the server answers session_started or
            // session_resumed with its high-water marks.
            self.sendControl(SessionStartMessage(
                sessionId: self.sessionId,
                mode: self.mode.rawValue,
                deviceName: self.deviceName,
                consent: self.consent.rawValue,
                startedAt: ISO8601DateFormatter().string(from: Date()),
                codec: self.codec,
                conversationId: self.conversationId
            ))
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        handleFailure("closed: \(closeCode.rawValue)", from: webSocketTask)
    }
}
