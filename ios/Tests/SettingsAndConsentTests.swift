import XCTest
@testable import GarrisonApp

final class SettingsAndConsentTests: XCTestCase {
    private var savedDefaults: UserDefaults?

    override func setUp() {
        savedDefaults = AppGroup.defaults
        AppGroup.defaults = UserDefaults(suiteName: "settings-tests-\(UUID().uuidString)")
    }

    override func tearDown() {
        AppGroup.defaults = savedDefaults
    }

    func testConsentSuppressionPersists() {
        XCTAssertFalse(AppGroup.consentSuppressed)
        AppGroup.consentSuppressed = true
        XCTAssertTrue(AppGroup.consentSuppressed)
    }

    func testEndpointSettingsRoundTrip() {
        AppGroup.defaults?.set("https://host.ts.net:8497", forKey: AppGroup.Key.baseURL)
        AppGroup.defaults?.set("  secret-token  ", forKey: AppGroup.Key.token)
        AppGroup.defaults?.set("Goncalo's iPhone", forKey: AppGroup.Key.deviceName)

        XCTAssertEqual(AppGroup.baseURL?.absoluteString, "https://host.ts.net:8497")
        XCTAssertEqual(AppGroup.token, "secret-token") // trimmed
        XCTAssertEqual(AppGroup.deviceName, "Goncalo's iPhone")
    }

    func testUnsetEndpointYieldsNilNotGarbage() {
        XCTAssertNil(AppGroup.baseURL)
        XCTAssertNil(AppGroup.token)
        XCTAssertEqual(AppGroup.deviceName, "iPhone")
        XCTAssertNil(AppGroup.request(path: "/capture/sessions"))
    }

    func testAuthedRequestCarriesBearerAndPath() throws {
        AppGroup.defaults?.set("https://host.ts.net:8497", forKey: AppGroup.Key.baseURL)
        AppGroup.defaults?.set("tok", forKey: AppGroup.Key.token)
        let request = try XCTUnwrap(AppGroup.request(path: "/capture/devices", method: "POST", body: Data("{}".utf8)))
        XCTAssertEqual(request.url?.absoluteString, "https://host.ts.net:8497/capture/devices")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func testAckLogAppendsBoundedNewestFirst() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("acklog-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let log = AckLog(directory: directory)
        for i in 1 ... 5 {
            log.append(AckLogEntry(id: "a\(i)", at: Date(), kind: "created", severity: "info", text: "entry \(i)", via: "push"))
        }
        let entries = log.entries()
        XCTAssertEqual(entries.count, 5)
        XCTAssertEqual(entries.first?.id, "a5") // newest first
        XCTAssertEqual(entries.first?.text, "entry 5")
    }

    // The broadcast runs in another process, so "can Zeca see my screen right
    // now" is only answerable through the shared App Group. A stale stamp must
    // read as NOT broadcasting - the extension can be killed without ever
    // running its teardown, and claiming eyes it does not have is what would
    // make "reply to her" act on a screen from an hour ago.
    func testBroadcastLivenessIsAHeartbeatNotAFlag() {
        AppGroup.clearBroadcast()
        XCTAssertFalse(AppGroup.isBroadcasting())

        let now = Date()
        AppGroup.noteBroadcastAlive(now: now)
        XCTAssertTrue(AppGroup.isBroadcasting(now: now))
        XCTAssertTrue(AppGroup.isBroadcasting(now: now.addingTimeInterval(AppGroup.broadcastStaleAfter - 1)))
        XCTAssertFalse(
            AppGroup.isBroadcasting(now: now.addingTimeInterval(AppGroup.broadcastStaleAfter + 1)),
            "a stale heartbeat means the extension died - never claim the screen is live"
        )

        AppGroup.clearBroadcast()
        XCTAssertFalse(AppGroup.isBroadcasting())
    }

    // The extension dies in its own process. Without this channel a refusal to
    // start is invisible and the app can only say "not shared", which is true
    // and useless - it sends the user back to the developer instead of to the
    // thing they need to fix.
    func testTheExtensionCanExplainWhyItRefusedToStart() {
        AppGroup.clearBroadcast()
        AppGroup.clearBroadcastError()
        XCTAssertNil(AppGroup.broadcastError())

        let now = Date()
        AppGroup.noteBroadcastError("No capture URL set", now: now)
        XCTAssertEqual(AppGroup.broadcastError(now: now)?.0, "No capture URL set")
        // An error must never read as a live broadcast.
        XCTAssertFalse(AppGroup.isBroadcasting(now: now))
        // ...and it ages out rather than explaining today's silence forever.
        XCTAssertNil(AppGroup.broadcastError(now: now.addingTimeInterval(7200)))

        AppGroup.clearBroadcastError()
        XCTAssertNil(AppGroup.broadcastError())
    }
}
