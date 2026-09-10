import Foundation

struct MeshPeer: Codable, Sendable {
    let name: String
    let origin: String?
}

struct MeshBootstrap: Codable, Sendable {
    let name: String
    let shellOrigin: String
    let captureBaseURL: String
    let token: String
    let nodes: [MeshPeer]

    func record(requestedOrigin: URL) throws -> NodeRecord {
        guard !name.isEmpty, !token.isEmpty,
              let shell = NodeRecord.normalizedOrigin(shellOrigin), shell == requestedOrigin,
              let capture = NodeRecord.normalizedOrigin(captureBaseURL),
              capture.scheme == "https", capture.host == shell.host
        else { throw MeshDiscoveryError.invalidResponse }
        return NodeRecord(name: name, shellOrigin: shell, captureBaseURL: capture, token: token)
    }
}

enum MeshDiscoveryError: LocalizedError {
    case unavailable, invalidResponse
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Mesh discovery is unavailable. Check Tailscale and refresh when a node is ready."
        case .invalidResponse: return "The node returned an invalid mesh address."
        }
    }
}

protocol MeshDiscovering: Sendable {
    func bootstrap(_ origin: URL) async throws -> MeshBootstrap
}

// Do not follow a redirect while provisioning a device. No credential enters
// the webview, a request URL, a log or a non-private browser cache.
private final class NoMeshRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct URLSessionMeshDiscovery: MeshDiscovering {
    private let session: URLSession
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 5
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.waitsForConnectivity = false
        session = URLSession(configuration: config, delegate: NoMeshRedirect(), delegateQueue: nil)
    }

    func bootstrap(_ origin: URL) async throws -> MeshBootstrap {
        guard origin.scheme == "https" else { throw MeshDiscoveryError.invalidResponse }
        var request = URLRequest(url: origin.appendingPathComponent("api/capture/bootstrap"))
        request.setValue("capture-bootstrap", forHTTPHeaderField: "x-garrison-native")
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              data.count < 128_000 else { throw MeshDiscoveryError.unavailable }
        let result = try JSONDecoder().decode(MeshBootstrap.self, from: data)
        _ = try result.record(requestedOrigin: origin)
        return result
    }
}

extension NodeStore {
    // Peers must belong to the same private tailnet as the seed. For a custom
    // standalone domain, only that host is trusted automatically.
    static func trustedMeshOrigin(_ raw: String, seed: URL) -> URL? {
        guard let url = NodeRecord.normalizedOrigin(raw), url.scheme == "https",
              let host = url.host, let seedHost = seed.host else { return nil }
        if host == seedHost { return url }
        guard seedHost.hasSuffix(".ts.net"), let dot = seedHost.firstIndex(of: ".") else { return nil }
        let suffix = String(seedHost[dot...])
        return host.hasSuffix(suffix) ? url : nil
    }

    @MainActor
    @discardableResult
    func refreshMesh(using discovery: any MeshDiscovering = URLSessionMeshDiscovery(), seed: URL? = nil) async throws -> NodeRecord {
        let origins = seed.map { [$0] } ?? ([current?.shellOrigin].compactMap { $0 } + nodes.map(\.shellOrigin))
        var visited = Set<URL>()
        for origin in origins where visited.insert(origin).inserted {
            guard let bootstrap = try? await discovery.bootstrap(origin),
                  let root = try? bootstrap.record(requestedOrigin: origin) else { continue }
            adoptDiscovered(root)
            let peers = bootstrap.nodes.prefix(64).compactMap { peer -> (String, URL)? in
                guard let raw = peer.origin, let url = Self.trustedMeshOrigin(raw, seed: origin), url != origin else { return nil }
                return (peer.name, url)
            }
            // Preserve offline nodes and existing credentials. New offline
            // peers appear immediately; capture provisions when they return.
            for (name, url) in peers where !nodes.contains(where: { $0.shellOrigin == url }) {
                upsert(NodeRecord(name: name, shellOrigin: url,
                                  captureBaseURL: NodeRecord.defaultCaptureBaseURL(for: url), token: ""))
            }
            let records = await withTaskGroup(of: NodeRecord?.self, returning: [NodeRecord].self) { group in
                for (_, url) in peers {
                    group.addTask {
                        guard let result = try? await discovery.bootstrap(url) else { return nil }
                        return try? result.record(requestedOrigin: url)
                    }
                }
                var records: [NodeRecord] = []
                for await record in group { if let record { records.append(record) } }
                return records
            }
            for record in records { adoptDiscovered(record) }
            return root
        }
        throw MeshDiscoveryError.unavailable
    }

    @MainActor
    private func adoptDiscovered(_ record: NodeRecord) {
        // Old hand-added names are kept so the selected node never disappears
        // or switches while discovery fills in its native capture settings.
        var next = record
        if let existing = nodes.first(where: { $0.shellOrigin == record.shellOrigin }) { next.name = existing.name }
        upsert(next)
    }
}
