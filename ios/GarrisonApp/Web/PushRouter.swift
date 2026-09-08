import Foundation

/// Hands a shell path (a push tap, a garrison:// link) to whichever bridge
/// view controller is live. The VC is recreated on every node switch and does
/// not exist yet on a cold start, so a route with no host waits in
/// `pendingPath` until the next VC attaches or the page asks for it through
/// GarrisonPush.pendingRoute().
@MainActor
final class PushRouter {
    static let shared = PushRouter()

    private weak var host: GarrisonBridgeViewController?
    private(set) var pendingPath: String?

    /// Internal so a test can hold its own router instead of the shared one.
    init() {}

    /// Weak on purpose: a superseded VC must be free to deinit on node switch.
    func attach(_ host: GarrisonBridgeViewController) {
        self.host = host
    }

    func route(path: String) {
        if let host {
            host.open(path: path)
        } else {
            pendingPath = path
        }
    }

    /// Parks a route for the NEXT bridge without offering it to the live one.
    /// A node switch tears the current VC down and builds a fresh one on the
    /// new origin; a path armed just before the switch is what that VC lands
    /// on after its first load, so a conversation opened from another node's
    /// list arrives at `/talk/<id>` there, not at the bare landing. Returns
    /// false (and arms nothing) for anything but a bare shell path.
    @discardableResult
    func arm(path: String) -> Bool {
        guard Self.isShellPath(path) else { return false }
        pendingPath = path
        return true
    }

    /// Returns and clears, so a route is delivered exactly once whichever side
    /// (native fallback or the page) gets to it first.
    func takePendingPath() -> String? {
        defer { pendingPath = nil }
        return pendingPath
    }

    /// URL scheme entry: `garrison://open?path=/talk/...`. Only a bare shell
    /// path is accepted; anything carrying its own scheme or host is dropped
    /// so an external link can never steer the web view off the node origin.
    func open(_ url: URL) {
        guard url.scheme?.lowercased() == "garrison",
              url.host?.lowercased() == "open",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let path = components.queryItems?.first(where: { $0.name == "path" })?.value,
              Self.isShellPath(path)
        else { return }
        route(path: path)
    }

    /// Server payloads put the route under `data.path` (the talk push helper);
    /// a flat `path` is accepted for hand-built test pushes. Called from
    /// UNUserNotificationCenterDelegate, which is not main-actor bound.
    nonisolated static func path(fromNotification userInfo: [AnyHashable: Any]) -> String? {
        let nested = (userInfo["data"] as? [AnyHashable: Any])?["path"] as? String
        let flat = userInfo["path"] as? String
        guard let path = nested ?? flat, isShellPath(path) else { return nil }
        return path
    }

    /// Absolute, host-less: "/talk/abc", not "//evil.example/x" and not a URL.
    nonisolated private static func isShellPath(_ path: String) -> Bool {
        path.hasPrefix("/") && !path.hasPrefix("//") && !path.contains("://")
    }
}
