import XCTest
@testable import GarrisonApp

@MainActor
final class PendantRecoveryTests: XCTestCase {
    private var savedDefaults: UserDefaults?
    private var controller: PendantController?
    private var servers: [MockCaptureServer] = []
    private var spoolDirectories: [URL] = []

    override func setUp() {
        savedDefaults = AppGroup.defaults
        AppGroup.defaults = UserDefaults(suiteName: "pendant-recovery-\(UUID().uuidString)")
        AppGroup.pendantIdentifier = UUID()
    }

    override func tearDown() {
        controller?.disconnect()
        controller = nil
        servers.forEach { $0.stop() }
        servers.removeAll()
        spoolDirectories.forEach { try? FileManager.default.removeItem(at: $0) }
        spoolDirectories.removeAll()
        AppGroup.defaults = savedDefaults
    }

    private func makeServer() throws -> MockCaptureServer {
        let server = try MockCaptureServer()
        servers.append(server)
        return server
    }

    private func select(_ server: MockCaptureServer, token: String = "test-token") {
        AppGroup.defaults?.set("http://127.0.0.1:\(server.port)", forKey: AppGroup.Key.baseURL)
        AppGroup.defaults?.set(token, forKey: AppGroup.Key.token)
    }

    private func connect() async -> PendantController {
        let controller = PendantController(transport: MockPendantTransport(packets: []), phoneSink: nil)
        self.controller = controller
        controller.reconnectIfNeeded()
        await waitUntil { controller.uploaderState == .streaming }
        rememberSpool(controller)
        return controller
    }

    private func rememberSpool(_ controller: PendantController) {
        if let id = controller.sessionId { spoolDirectories.append(AppGroup.spoolDirectory(sessionId: id)) }
    }

    private func waitUntil(_ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(5)
        while !condition(), Date() < deadline { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(condition())
    }

    func testConnectedPendantFollowsSelectedNodeWithoutBluetoothReconnect() async throws {
        let first = try makeServer()
        let second = try makeServer()
        select(first)
        let controller = await connect()
        let firstId = controller.sessionId
        XCTAssertEqual(first.snapshotSessionStarts(), 1)

        select(second)
        controller.reconnectIfNeeded()
        await waitUntil { second.snapshotSessionStarts() == 1 && controller.uploaderState == .streaming }
        rememberSpool(controller)
        XCTAssertEqual(controller.connectionState, .connected)
        XCTAssertNotEqual(controller.sessionId, firstId)

        // Old session-ended callbacks must not overwrite the new session.
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(controller.uploaderState, .streaming)
        for _ in 0..<10 { controller.reconnectIfNeeded() }
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(second.snapshotSessionStarts(), 1)
        XCTAssertEqual(first.snapshotSessionStarts(), 1)
    }

    func testCredentialChangeReplacesUploaderOnSameNode() async throws {
        let server = try makeServer()
        select(server)
        let controller = await connect()
        let oldId = controller.sessionId
        select(server, token: "replacement-test-token")
        controller.reconnectIfNeeded()
        await waitUntil { server.snapshotSessionStarts() == 2 && controller.uploaderState == .streaming }
        rememberSpool(controller)
        XCTAssertNotEqual(controller.sessionId, oldId)
        XCTAssertEqual(controller.connectionState, .connected)
    }

    func testManualDisconnectRemainsPausedAfterNodeChange() async throws {
        let first = try makeServer()
        let second = try makeServer()
        select(first)
        let controller = await connect()
        controller.disconnect()
        await waitUntil { controller.connectionState == .disconnected }
        select(second)
        controller.reconnectIfNeeded()
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(second.snapshotSessionStarts(), 0)
        XCTAssertFalse(AppGroup.pendantAutoConnect)
        XCTAssertNil(controller.sessionId)
        XCTAssertEqual(controller.uploaderState, .idle)
    }
}
