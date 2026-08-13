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
}
