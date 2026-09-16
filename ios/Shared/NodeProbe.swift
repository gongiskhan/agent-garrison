import Foundation

// Is the node this app is pinned to actually there?
//
// The webview's server URL is fixed for the lifetime of its controller, so the
// app is pinned to whichever origin NodeStore persisted. When that origin dies
// the page is blank, and the only node switcher lives inside the page that will
// not load - a relaunch reloads the same dead origin, so the user is locked out
// of their own app. The way back is for the app to notice on its own, which
// means a reachability check that is honest about what "dead" means here.
//
// Compiled into the broadcast extension along with the rest of Shared, so:
// Foundation and URLSession only, no UIKit, no SwiftUI.

/// Injectable so failover is testable without a network.
protocol NodeProber: Sendable {
    /// True when a shell is answering at this origin RIGHT NOW.
    func reachable(_ origin: URL) async -> Bool
}

struct URLSessionNodeProber: NodeProber {
    /// Allow a cellular/tailnet connection to wake up. A healthy Madrid root
    /// took 3.1 seconds on a cold connection; that is not a dead node.
    static let defaultTimeout: TimeInterval = 8

    let timeout: TimeInterval
    private let session: URLSession

    init(timeout: TimeInterval = URLSessionNodeProber.defaultTimeout, session: URLSession? = nil) {
        self.timeout = timeout
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = timeout
            config.timeoutIntervalForResource = timeout
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    func reachable(_ origin: URL) async -> Bool {
        var request = URLRequest(url: origin.appendingPathComponent("api/mesh/self"))
        // GET, not HEAD: the shell is a Next app behind a tunnel, and neither
        // is obliged to answer a HEAD. The body is discarded either way.
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return false }
            return Self.isAlive(status: http.statusCode)
        } catch {
            // Refused, timed out, TLS failure, no route: all the same answer.
            return false
        }
    }

    /// A 502 from a flapping tunnel is the case this whole feature exists for,
    /// so 5xx is DEAD - the origin resolves and the transport answers, but
    /// nothing is serving the shell behind it. Anything else that came back as
    /// HTTP means a server is there: a 401, a 403, a redirect or a 404 on the
    /// root are all live shells as far as "can the user get their app" goes.
    static func isAlive(status: Int) -> Bool {
        status > 0 && status < 500
    }
}

/// What a failover pass did, for the caller and for the tests.
enum NodeFailoverOutcome: Equatable {
    /// No node selected yet - the bootstrap page owns this case.
    case noCurrentNode
    case currentReachable
    case switched(from: String, to: String)
    /// Nothing answered. `current` is deliberately left alone: a blank page on
    /// the node the user chose beats silently hopping to another one that is
    /// equally dead, and the bootstrap/error page still offers a way out.
    case noneReachable
    /// Another check, a manual selection, or cancellation owns the decision.
    case superseded
}

/// The one thing the user sees. Held on NodeStore, rendered by the app.
struct NodeFailoverNotice: Equatable {
    let from: String
    let to: String
    let at: Date
}
