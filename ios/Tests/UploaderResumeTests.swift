import Network
import XCTest
@testable import GarrisonApp

/// A minimal WebSocket server on Network.framework, standing in for the
/// capture service: accepts the upgrade, parses control messages, acks media
/// frames with the contiguous high-water, and can drop the connection to
/// force the uploader's resume path.
final class MockCaptureServer {
    let listener: NWListener
    private(set) var port: UInt16 = 0
    private let queue = DispatchQueue(label: "mock-capture-server")
    private var connections: [NWConnection] = []

    // Observable state, guarded by `queue`.
    private(set) var sessionStarts: [[String: Any]] = []
    private(set) var audioSeqs: [UInt32] = []
    private(set) var receipts: [[String: Any]] = []
    var resumeHighWater: (audio: UInt32, video: UInt32) = (0, 0)
    private var seenSession = false

    init() throws {
        let parameters = NWParameters.tcp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        listener = try NWListener(using: parameters, on: .any)
        // `port` already holds its placeholder, so `self` is fully
        // initialized before the handlers capture it.
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        let ready = expectationHolder()
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.fulfill() }
        }
        listener.start(queue: queue)
        ready.wait(timeout: 5)
        port = listener.port?.rawValue ?? 0
    }

    private func accept(_ connection: NWConnection) {
        connections.append(connection)
        connection.start(queue: queue)
        receiveLoop(connection)
    }

    private func receiveLoop(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self, error == nil else { return }
            if let data, let context {
                self.handle(data: data, context: context, on: connection)
            }
            if error == nil { self.receiveLoop(connection) }
        }
    }

    private func handle(data: Data, context: NWConnection.ContentContext, on connection: NWConnection) {
        let isText = context.protocolMetadata(definition: NWProtocolWebSocket.definition)
            .flatMap { ($0 as? NWProtocolWebSocket.Metadata)?.opcode == .text } ?? false
        if isText {
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            switch object["type"] as? String {
            case "session_start":
                sessionStarts.append(object)
                let reply: [String: Any] = seenSession
                    ? ["type": "session_resumed", "session_id": object["session_id"] ?? "", "audio_seq": Int(resumeHighWater.audio), "video_seq": Int(resumeHighWater.video)]
                    : ["type": "session_started", "session_id": object["session_id"] ?? ""]
                seenSession = true
                send(reply, on: connection)
            case "spoken":
                receipts.append(object)
            case "session_end":
                send(["type": "session_ended", "reason": object["reason"] ?? "user"], on: connection)
            default:
                break
            }
            return
        }
        // Binary media frame: parse the header, ack the seq as contiguous.
        guard data.count >= 17 else { return }
        let kind = data[0]
        let seq = data.subdata(in: 1 ..< 5).withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
        if kind == 0 { audioSeqs.append(seq) }
        send(["type": "ack", "stream": kind == 0 ? "audio" : "video", "seq": Int(seq)], on: connection)
    }

    func speak(_ ack: [String: Any]) {
        guard let connection = connections.last else { return }
        queue.async { [weak self] in
            self?.send(["type": "speak", "ack": ack], on: connection)
        }
    }

    private func send(_ object: [String: Any], on connection: NWConnection) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }

    /// Hard-drop every connection (a network blip) without stopping the listener.
    func dropConnections() {
        queue.async { [weak self] in
            self?.connections.forEach { $0.forceCancel() }
            self?.connections.removeAll()
        }
    }

    func snapshotAudioSeqs() -> [UInt32] {
        queue.sync { audioSeqs }
    }

    func snapshotSessionStarts() -> Int {
        queue.sync { sessionStarts.count }
    }

    func snapshotReceipts() -> [[String: Any]] {
        queue.sync { receipts }
    }

    func stop() {
        listener.cancel()
        connections.forEach { $0.cancel() }
    }
}

/// A tiny waitable flag (XCTestExpectation needs a test case; the server
/// boots in init, outside one).
private final class expectationHolder {
    private let semaphore = DispatchSemaphore(value: 0)
    func fulfill() { semaphore.signal() }
    func wait(timeout: TimeInterval) { _ = semaphore.wait(timeout: .now() + timeout) }
}

final class UploaderResumeTests: XCTestCase {
    private var server: MockCaptureServer!
    private var spoolDirectory: URL!

    override func setUpWithError() throws {
        server = try MockCaptureServer()
        spoolDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("uploader-tests-\(UUID().uuidString)")
    }

    override func tearDown() {
        server.stop()
        try? FileManager.default.removeItem(at: spoolDirectory)
    }

    private func makeUploader() -> CaptureUploader {
        CaptureUploader(
            baseURL: URL(string: "http://127.0.0.1:\(server.port)")!,
            token: "test-token",
            sessionId: "01UPLOADTEST00001",
            mode: .audio,
            deviceName: "test",
            consent: .shown,
            spoolDirectory: spoolDirectory
        )
    }

    private func waitUntil(_ timeout: TimeInterval = 8, _ condition: @escaping () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertTrue(condition(), "condition not met within \(timeout)s")
    }

    func testStreamsFramesAndReceivesContiguousAcks() {
        let uploader = makeUploader()
        uploader.connect()
        waitUntil { uploader.state == .streaming }

        for seq in 1 ... 5 {
            uploader.sendAudioPacket(Data("opus-\(seq)".utf8), ts: Double(seq) * 20)
        }
        waitUntil { self.server.snapshotAudioSeqs().count == 5 }
        waitUntil { uploader.ackedAudio == 5 }
        XCTAssertEqual(server.snapshotAudioSeqs(), [1, 2, 3, 4, 5])
    }

    func testResumesFromLastAckedSeqAfterDrop() {
        let uploader = makeUploader()
        uploader.connect()
        waitUntil { uploader.state == .streaming }
        for seq in 1 ... 3 {
            uploader.sendAudioPacket(Data("opus-\(seq)".utf8), ts: Double(seq) * 20)
        }
        waitUntil { uploader.ackedAudio == 3 }

        // The link dies. Frames keep arriving while offline -> spool only.
        server.resumeHighWater = (audio: 3, video: 0)
        server.dropConnections()
        for seq in 4 ... 6 {
            uploader.sendAudioPacket(Data("opus-\(seq)".utf8), ts: Double(seq) * 20)
        }

        // Reconnect happens on backoff; the server answers session_resumed
        // with high-water 3 and the uploader replays exactly 4..6.
        waitUntil(15) { self.server.snapshotSessionStarts() >= 2 }
        waitUntil(15) { uploader.ackedAudio == 6 }
        let delivered = server.snapshotAudioSeqs()
        XCTAssertEqual(delivered.filter { $0 > 3 }, [4, 5, 6])
        // Nothing at-or-below the confirmed high-water was resent.
        XCTAssertEqual(delivered.filter { $0 <= 3 }.count, 3)
    }

    func testSpeakReachesHandlerAndReceiptRidesBack() {
        let uploader = makeUploader()
        var spokenTexts: [String] = []
        uploader.onSpeak = { ack in
            spokenTexts.append(ack.text)
            uploader.sendSpokenReceipt(ackId: ack.id, ok: true)
        }
        uploader.connect()
        waitUntil { uploader.state == .streaming }

        server.speak(["id": "ack-1", "kind": "created", "severity": "info", "text": "Created a task, test."])
        waitUntil { spokenTexts == ["Created a task, test."] }
        waitUntil { self.server.snapshotReceipts().count == 1 }
        let receipt = server.snapshotReceipts()[0]
        XCTAssertEqual(receipt["spoken"] as? String, "ack-1")
        XCTAssertEqual(receipt["ok"] as? Bool, true)
    }
}
