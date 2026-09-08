import XCTest
@testable import GarrisonApp

/// NodeStore against an injected suite: the App Group container is not
/// available to a test host, and the legacy capture.* keys the store migrates
/// from and mirrors into live in the SAME defaults it is handed, so the whole
/// contract is observable without touching the real group.
final class NodeRecordTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        suiteName = "garrison.tests.node.\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        suite.removePersistentDomain(forName: suiteName)
    }

    // Pre-G3 installs stored one capture endpoint plus its token. That is the
    // one node the user has, so it must come back selected, with the shell on
    // the same host minus the capture port (8497 is one fitting's serve port,
    // not the shell's).
    func testMigratesLegacyKeysIntoOneSelectedNode() throws {
        suite.set("https://goncalos-macbook-pro.tail31efa.ts.net:8497", forKey: AppGroup.Key.baseURL)
        suite.set("legacy-token", forKey: AppGroup.Key.token)

        let store = NodeStore(defaults: suite)

        XCTAssertEqual(store.nodes.count, 1)
        let node = try XCTUnwrap(store.current)
        XCTAssertEqual(node.name, "goncalos-macbook-pro")
        XCTAssertEqual(node.shellOrigin.absoluteString, "https://goncalos-macbook-pro.tail31efa.ts.net")
        XCTAssertEqual(node.captureBaseURL.absoluteString, "https://goncalos-macbook-pro.tail31efa.ts.net:8497")
        XCTAssertEqual(node.token, "legacy-token")
        XCTAssertEqual(store.currentOrigin, "https://goncalos-macbook-pro.tail31efa.ts.net")

        // Persisted: a second store over the same suite sees the same node
        // without migrating again.
        let reopened = NodeStore(defaults: suite)
        XCTAssertEqual(reopened.nodes, store.nodes)
        XCTAssertEqual(reopened.current?.name, "goncalos-macbook-pro")
    }

    func testNoLegacyKeysMeansNoNodes() {
        let store = NodeStore(defaults: suite)
        XCTAssertTrue(store.nodes.isEmpty)
        XCTAssertNil(store.current)
        XCTAssertNil(store.currentOrigin)
    }

    // The broadcast extension, CaptureController, PendantController and
    // PushManager keep reading AppGroup.baseURL/token; selecting a node is what
    // keeps those readers pointed at the right machine.
    func testSelectMirrorsCaptureURLAndTokenIntoTheLegacyKeys() throws {
        let store = NodeStore(defaults: suite)
        store.upsert(Self.record(name: "madrid", host: "dev-madrid.tail31efa.ts.net", token: "tok-madrid"))
        store.upsert(Self.record(name: "mini", host: "mac-mini.tail31efa.ts.net", token: "tok-mini"))
        XCTAssertNil(store.current, "upsert must not select")
        XCTAssertNil(suite.string(forKey: AppGroup.Key.baseURL))

        XCTAssertTrue(store.select(name: "mini"))
        XCTAssertEqual(store.current?.name, "mini")
        XCTAssertEqual(suite.string(forKey: AppGroup.Key.baseURL), "https://mac-mini.tail31efa.ts.net:8497")
        XCTAssertEqual(suite.string(forKey: AppGroup.Key.token), "tok-mini")
        XCTAssertEqual(suite.string(forKey: AppGroup.Key.nodeCurrent), "mini")

        XCTAssertTrue(store.select(name: "madrid"))
        XCTAssertEqual(suite.string(forKey: AppGroup.Key.baseURL), "https://dev-madrid.tail31efa.ts.net:8497")
        XCTAssertEqual(suite.string(forKey: AppGroup.Key.token), "tok-madrid")

        XCTAssertFalse(store.select(name: "nowhere"))
        XCTAssertEqual(store.current?.name, "madrid", "an unknown name leaves the selection alone")
    }

    // Removing the selected node must not leave the capture path pointed at a
    // machine the user just deleted.
    func testRemovingTheCurrentNodeClearsTheLegacyKeys() {
        let store = NodeStore(defaults: suite)
        store.upsert(Self.record(name: "madrid", host: "dev-madrid.tail31efa.ts.net", token: "tok-madrid"))
        store.upsert(Self.record(name: "mini", host: "mac-mini.tail31efa.ts.net", token: "tok-mini"))
        store.select(name: "mini")

        store.remove(name: "madrid")
        XCTAssertEqual(store.nodes.map(\.name), ["mini"])
        XCTAssertEqual(store.current?.name, "mini", "removing another node keeps the selection")
        XCTAssertEqual(suite.string(forKey: AppGroup.Key.token), "tok-mini")

        store.remove(name: "mini")
        XCTAssertTrue(store.nodes.isEmpty)
        XCTAssertNil(store.current)
        XCTAssertNil(suite.string(forKey: AppGroup.Key.baseURL))
        XCTAssertNil(suite.string(forKey: AppGroup.Key.token))
        XCTAssertNil(suite.string(forKey: AppGroup.Key.nodeCurrent))
    }

    func testNormalizedOriginAddsHTTPSStripsPathAndRejectsGarbage() {
        XCTAssertEqual(
            NodeRecord.normalizedOrigin("goncalos-macbook-pro.tail31efa.ts.net")?.absoluteString,
            "https://goncalos-macbook-pro.tail31efa.ts.net"
        )
        XCTAssertEqual(
            NodeRecord.normalizedOrigin("  https://Dev-Madrid.tail31efa.ts.net/talk/abc?x=1#frag \n")?.absoluteString,
            "https://dev-madrid.tail31efa.ts.net"
        )
        XCTAssertEqual(
            NodeRecord.normalizedOrigin("http://localhost:8777/")?.absoluteString,
            "http://localhost:8777",
            "an explicit port survives; only the path goes"
        )

        XCTAssertNil(NodeRecord.normalizedOrigin(""))
        XCTAssertNil(NodeRecord.normalizedOrigin("   "))
        XCTAssertNil(NodeRecord.normalizedOrigin("https://"))
        XCTAssertNil(NodeRecord.normalizedOrigin("not a host name"))
        XCTAssertNil(NodeRecord.normalizedOrigin("ftp://dev-madrid.tail31efa.ts.net"), "only http(s) can be a shell origin")
    }

    // Mesh invariant: capture-service is 8097 on every node and the tailnet
    // serve port is 8400 + port % 1000, so the capture base is derivable from
    // the shell host alone.
    func testDefaultCaptureBaseURLIsPort8497OnTheSameHost() throws {
        XCTAssertEqual(NodeRecord.captureServePort, 8497)
        let origin = try XCTUnwrap(URL(string: "https://goncalos-macbook-pro.tail31efa.ts.net"))
        XCTAssertEqual(
            NodeRecord.defaultCaptureBaseURL(for: origin).absoluteString,
            "https://goncalos-macbook-pro.tail31efa.ts.net:8497"
        )
        let withPort = try XCTUnwrap(URL(string: "http://localhost:8777"))
        XCTAssertEqual(
            NodeRecord.defaultCaptureBaseURL(for: withPort).absoluteString,
            "http://localhost:8497",
            "the shell's own port is replaced, not appended to"
        )
        XCTAssertEqual(NodeRecord.defaultName(for: origin), "goncalos-macbook-pro")
    }

    func testUpsertReplacesByNameAndKeepsOrderStable() {
        let store = NodeStore(defaults: suite)
        store.upsert(Self.record(name: "madrid", host: "dev-madrid.tail31efa.ts.net", token: "tok-1"))
        store.upsert(Self.record(name: "mini", host: "mac-mini.tail31efa.ts.net", token: "tok-2"))
        store.upsert(Self.record(name: "air", host: "macbook-air.tail31efa.ts.net", token: "tok-3"))
        store.select(name: "madrid")

        store.upsert(Self.record(name: "madrid", host: "dev-madrid.tail31efa.ts.net", token: "tok-1-rotated"))

        XCTAssertEqual(store.nodes.map(\.name), ["madrid", "mini", "air"])
        XCTAssertEqual(store.nodes.first?.token, "tok-1-rotated")
        XCTAssertEqual(store.current?.token, "tok-1-rotated", "editing the current node updates the selection")
        XCTAssertEqual(suite.string(forKey: AppGroup.Key.token), "tok-1-rotated", "and re-mirrors it")

        // A different node's edit leaves the mirror alone.
        store.upsert(Self.record(name: "mini", host: "mac-mini.tail31efa.ts.net", token: "tok-2-rotated"))
        XCTAssertEqual(suite.string(forKey: AppGroup.Key.token), "tok-1-rotated")
        XCTAssertEqual(store.nodes.map(\.name), ["madrid", "mini", "air"])
    }

    // MARK: - Helpers

    private static func record(name: String, host: String, token: String) -> NodeRecord {
        let origin = URL(string: "https://\(host)")!
        return NodeRecord(
            name: name,
            shellOrigin: origin,
            captureBaseURL: NodeRecord.defaultCaptureBaseURL(for: origin),
            token: token
        )
    }
}
