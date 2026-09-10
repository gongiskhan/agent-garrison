import XCTest
@testable import GarrisonApp

private struct FixtureMeshDiscovery: MeshDiscovering {
    let responses: [String: MeshBootstrap]
    func bootstrap(_ origin: URL) async throws -> MeshBootstrap {
        guard let result = responses[origin.absoluteString] else { throw MeshDiscoveryError.unavailable }
        return result
    }
}

@MainActor
final class MeshDiscoveryTests: XCTestCase {
    func testRefreshDiscoversPeersPreservesOfflineRecordsAndCurrentSelection() async throws {
        let name = "mesh-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let store = NodeStore(defaults: defaults)
        let a = URL(string: "https://one.tail123.ts.net")!
        let b = URL(string: "https://two.tail123.ts.net")!
        let old = NodeRecord(name: "My node", shellOrigin: a, captureBaseURL: a, token: "previous")
        store.upsert(old)
        store.select(name: old.name)
        let response = MeshBootstrap(name: "one", shellOrigin: a.absoluteString,
            captureBaseURL: "https://one.tail123.ts.net:8497", token: "internal",
            nodes: [MeshPeer(name: "two", origin: b.absoluteString), MeshPeer(name: "bad", origin: "https://attacker.example")])
        try await store.refreshMesh(using: FixtureMeshDiscovery(responses: [a.absoluteString: response]))
        XCTAssertEqual(store.nodes.count, 2)
        XCTAssertEqual(store.current?.name, "My node")
        XCTAssertEqual(store.current?.token, "internal")
        XCTAssertEqual(store.nodes.last?.shellOrigin, b)
        XCTAssertEqual(store.nodes.last?.token, "")
        do {
            try await store.refreshMesh(using: FixtureMeshDiscovery(responses: [:]))
            XCTFail("Expected unavailable")
        } catch {}
        XCTAssertEqual(store.nodes.count, 2)
        XCTAssertEqual(store.current?.shellOrigin, a)
    }

    func testBootstrapRejectsRetargetedCaptureAndWrongShell() throws {
        let origin = URL(string: "https://one.tail123.ts.net")!
        let response = MeshBootstrap(name: "one", shellOrigin: origin.absoluteString,
            captureBaseURL: "https://attacker.example", token: "private", nodes: [])
        XCTAssertThrowsError(try response.record(requestedOrigin: origin))
        XCTAssertNil(NodeStore.trustedMeshOrigin("https://two.different.ts.net", seed: origin))
        XCTAssertNotNil(NodeStore.trustedMeshOrigin("https://two.tail123.ts.net", seed: origin))
        XCTAssertNil(NodeStore.trustedMeshOrigin("https://user:password@one.tail123.ts.net", seed: origin))
    }
}
