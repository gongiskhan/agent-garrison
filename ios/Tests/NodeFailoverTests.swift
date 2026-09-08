import XCTest
@testable import GarrisonApp

/// Failover off a dead node.
///
/// The bug this closes: the webview is pinned to the persisted origin for the
/// bridge's lifetime, so when that origin dies the page is blank AND the only
/// node switcher lives inside the page that will not load. A relaunch reloads
/// the same dead origin. The user is locked out of their own app until someone
/// deletes and reinstalls it.
///
/// The prober is injected here, so none of this touches a network.
final class NodeFailoverTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        suiteName = "garrison.tests.failover.\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        suite.removePersistentDomain(forName: suiteName)
    }

    /// Answers for the origins it was given, refuses everything else, and
    /// counts what it was asked - the order of the asking is part of the
    /// contract (current first, then list order).
    private final class FakeProber: NodeProber, @unchecked Sendable {
        private let lock = NSLock()
        private var alive: Set<String>
        private(set) var asked: [String] = []

        init(alive: [String]) {
            self.alive = Set(alive)
        }

        func reachable(_ origin: URL) async -> Bool {
            lock.lock()
            defer { lock.unlock() }
            asked.append(origin.absoluteString)
            return alive.contains(origin.absoluteString)
        }

        func setAlive(_ origins: [String]) {
            lock.lock()
            defer { lock.unlock() }
            alive = Set(origins)
        }
    }

    private static func record(name: String, token: String = "tok") -> NodeRecord {
        let origin = URL(string: "https://\(name).tail31efa.ts.net")!
        return NodeRecord(
            name: name,
            shellOrigin: origin,
            captureBaseURL: NodeRecord.defaultCaptureBaseURL(for: origin),
            token: token
        )
    }

    private func storeWithNodes(_ names: [String], selected: String) -> NodeStore {
        let store = NodeStore(defaults: suite)
        for name in names { store.upsert(Self.record(name: name)) }
        XCTAssertTrue(store.select(name: selected))
        return store
    }

    // (a) The reported case: csg's origin 502s, another node answers.
    @MainActor
    func testUnreachableCurrentSwitchesToTheFirstReachablePeer() async throws {
        let store = storeWithNodes(["csg", "dev-madrid", "mac-mini"], selected: "csg")
        let prober = FakeProber(alive: ["https://dev-madrid.tail31efa.ts.net"])

        let outcome = await store.failoverIfNeeded(prober: prober)

        XCTAssertEqual(outcome, .switched(from: "csg", to: "dev-madrid"))
        XCTAssertEqual(store.current?.name, "dev-madrid")
        XCTAssertEqual(store.currentOrigin, "https://dev-madrid.tail31efa.ts.net")
        // The user has to be able to tell it happened.
        XCTAssertEqual(store.lastFailover?.from, "csg")
        XCTAssertEqual(store.lastFailover?.to, "dev-madrid")
        // Current first, then list order - not a race between probes.
        XCTAssertEqual(prober.asked.first, "https://csg.tail31efa.ts.net")
        // The capture lane follows the app: the mirrored legacy keys are what
        // the broadcast extension and PushManager read.
        XCTAssertEqual(
            suite.string(forKey: AppGroup.Key.baseURL),
            "https://dev-madrid.tail31efa.ts.net:8497"
        )
    }

    // (b) Everything is down - typically the tunnel, not the nodes. Staying put
    // beats hopping between dead origins: the node the user chose is the one
    // the bootstrap/error page is about.
    @MainActor
    func testAllUnreachableKeepsCurrent() async throws {
        let store = storeWithNodes(["csg", "dev-madrid"], selected: "csg")
        let prober = FakeProber(alive: [])

        let outcome = await store.failoverIfNeeded(prober: prober)

        XCTAssertEqual(outcome, .noneReachable)
        XCTAssertEqual(store.current?.name, "csg")
        XCTAssertNil(store.lastFailover, "nothing moved, so there is nothing to tell the user")
    }

    // (c) A reachable node is never switched away from, and no peer is even
    // probed - the peers' health is none of this pass's business.
    @MainActor
    func testReachableCurrentIsNeverSwitchedAwayFrom() async throws {
        let store = storeWithNodes(["csg", "dev-madrid"], selected: "csg")
        let prober = FakeProber(alive: [
            "https://csg.tail31efa.ts.net",
            "https://dev-madrid.tail31efa.ts.net"
        ])

        let outcome = await store.failoverIfNeeded(prober: prober)

        XCTAssertEqual(outcome, .currentReachable)
        XCTAssertEqual(store.current?.name, "csg")
        XCTAssertEqual(prober.asked, ["https://csg.tail31efa.ts.net"])
        XCTAssertNil(store.lastFailover)
    }

    // (d) Fail over, never automatically back. csg recovering must not yank the
    // app off the node it landed on mid-sentence; going back is the person's
    // call, from the switcher they can now reach.
    @MainActor
    func testNeverFailsBackWhenTheOriginalNodeRecovers() async throws {
        let store = storeWithNodes(["csg", "dev-madrid"], selected: "csg")
        let prober = FakeProber(alive: ["https://dev-madrid.tail31efa.ts.net"])
        // Awaited into a local first: XCTAssert takes autoclosures, which
        // cannot carry an await.
        let first = await store.failoverIfNeeded(prober: prober)
        XCTAssertEqual(first, .switched(from: "csg", to: "dev-madrid"))

        // csg comes back; both nodes are healthy now.
        prober.setAlive(["https://csg.tail31efa.ts.net", "https://dev-madrid.tail31efa.ts.net"])
        let second = await store.failoverIfNeeded(prober: prober)

        XCTAssertEqual(second, .currentReachable)
        XCTAssertEqual(store.current?.name, "dev-madrid")

        // And again on the next foregrounding, however many times it runs.
        let third = await store.failoverIfNeeded(prober: prober)
        XCTAssertEqual(third, .currentReachable)
        XCTAssertEqual(store.current?.name, "dev-madrid")
    }

    // A node that dies AFTER a failover moves again - including back to the one
    // it came from. That is still failover: the node it is on stopped
    // answering, which is the only thing that ever moves this app.
    @MainActor
    func testMovesAgainWhenTheNodeItLandedOnDies() async throws {
        let store = storeWithNodes(["csg", "dev-madrid"], selected: "csg")
        let prober = FakeProber(alive: ["https://dev-madrid.tail31efa.ts.net"])
        _ = await store.failoverIfNeeded(prober: prober)
        XCTAssertEqual(store.current?.name, "dev-madrid")

        prober.setAlive(["https://csg.tail31efa.ts.net"])
        let outcome = await store.failoverIfNeeded(prober: prober)

        XCTAssertEqual(outcome, .switched(from: "dev-madrid", to: "csg"))
        XCTAssertEqual(store.current?.name, "csg")
    }

    // The bootstrap page owns the no-node case; failover must not invent one.
    @MainActor
    func testNoCurrentNodeIsLeftToTheBootstrapPage() async throws {
        let store = NodeStore(defaults: suite)
        let prober = FakeProber(alive: ["https://dev-madrid.tail31efa.ts.net"])

        let outcome = await store.failoverIfNeeded(prober: prober)

        XCTAssertEqual(outcome, .noCurrentNode)
        XCTAssertNil(store.current)
        XCTAssertTrue(prober.asked.isEmpty, "nothing to probe, so nothing was probed")
    }

    // What "dead" means here. The reported failure was a 502 from a flapping
    // dev tunnel: the origin resolves and answers, but nothing is serving the
    // shell behind it. A 404 or a 401 on the root is a live shell.
    func testAliveIsAnyHTTPAnswerBelowFiveHundred() {
        XCTAssertTrue(URLSessionNodeProber.isAlive(status: 200))
        XCTAssertTrue(URLSessionNodeProber.isAlive(status: 302))
        XCTAssertTrue(URLSessionNodeProber.isAlive(status: 401))
        XCTAssertTrue(URLSessionNodeProber.isAlive(status: 404))
        XCTAssertFalse(URLSessionNodeProber.isAlive(status: 500))
        XCTAssertFalse(URLSessionNodeProber.isAlive(status: 502))
        XCTAssertFalse(URLSessionNodeProber.isAlive(status: 503))
    }

    // The probe budget is the launch path: a node that cannot answer its own
    // root in three seconds is not one the user can work on.
    func testProbeTimeoutStaysShort() {
        XCTAssertEqual(URLSessionNodeProber.defaultTimeout, 3)
        XCTAssertEqual(URLSessionNodeProber().timeout, 3)
    }
}
