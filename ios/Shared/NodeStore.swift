import Combine
import Foundation

// Compiled into the app AND the broadcast extension (the `Shared` source
// folder), so Foundation + Combine only: no SwiftUI, no UIKit. The extension
// never instantiates the store; it keeps reading the mirrored legacy keys.

/// One Garrison machine as this device knows it. `name` is the key.
struct NodeRecord: Codable, Equatable {
    /// "goncalos-macbook-pro": the first DNS label by default, unique in the list.
    var name: String
    /// scheme + host [+ port], no path: what the web view loads.
    var shellOrigin: URL
    /// The capture-service base the native capture path talks to.
    var captureBaseURL: URL
    /// Capture token. Held natively; never returned to the web view.
    var token: String

    /// Mesh invariant: tailnet serve port = 8400 + fitting port % 1000, and
    /// capture-service sits on 8097 on every node.
    static let captureServePort = 8497

    static func defaultCaptureBaseURL(for shellOrigin: URL) -> URL {
        var components = URLComponents()
        components.scheme = shellOrigin.scheme
        components.host = shellOrigin.host
        components.port = captureServePort
        return components.url ?? shellOrigin
    }

    static func defaultName(for shellOrigin: URL) -> String {
        let host = shellOrigin.host ?? ""
        return host.split(separator: ".").first.map(String.init) ?? host
    }

    /// Trims, assumes https when no scheme is given, keeps scheme + host
    /// [+ port], lowercases the host and drops path/query/fragment. Rejects
    /// anything that is not an http(s) origin with a plain host: iOS 17's URL
    /// parser percent-encodes rather than refusing, so the host charset is
    /// checked here instead of trusting the parse.
    static func normalizedOrigin(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if text.range(of: "^[A-Za-z][A-Za-z0-9+.-]*://", options: .regularExpression) == nil {
            text = "https://" + text
        }
        guard let parsed = URLComponents(string: text),
              let scheme = parsed.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = parsed.host?.lowercased(), !host.isEmpty,
              host.range(of: "^[a-z0-9.:-]+$", options: .regularExpression) != nil
        else { return nil }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = parsed.port
        return origin.url
    }
}

/// The device's node list and the selected node, persisted in the App Group.
/// Main-thread only: the published properties drive SwiftUI (the bridge is
/// rebuilt whenever `current` changes origin) and plugin calls hop to main
/// before touching it.
final class NodeStore: ObservableObject {
    static let shared = NodeStore()

    @Published private(set) var nodes: [NodeRecord] = []
    @Published private(set) var current: NodeRecord?
    /// Set when a failover actually moved the app. The app renders it once and
    /// the user is told which node they are on; nothing else reads it.
    @Published private(set) var lastFailover: NodeFailoverNotice?

    private let defaults: UserDefaults?

    /// Injectable for tests (a plain suite name instead of the group). The
    /// legacy keys are read and mirrored through the SAME defaults so a test
    /// suite sees the whole migration without touching the real group.
    init(defaults: UserDefaults? = AppGroup.defaults) {
        self.defaults = defaults
        nodes = Self.decodeNodes(defaults?.data(forKey: AppGroup.Key.nodeList))
        if let name = defaults?.string(forKey: AppGroup.Key.nodeCurrent) {
            current = nodes.first { $0.name == name }
        }
        migrateLegacyIfNeeded()
    }

    var currentOrigin: String? { current?.shellOrigin.absoluteString }

    /// Insert or replace by name; order stays stable so the list does not
    /// jump under the user's finger. Editing the current node re-mirrors.
    func upsert(_ record: NodeRecord) {
        if let index = nodes.firstIndex(where: { $0.name == record.name }) {
            nodes[index] = record
        } else {
            nodes.append(record)
        }
        persistNodes()
        if current?.name == record.name {
            current = record
            mirrorLegacy(record)
        }
    }

    /// Selecting mirrors capture.baseURL / capture.token so the broadcast
    /// extension, CaptureController, PendantController, ClipPlayer and
    /// PushManager keep reading AppGroup.baseURL/token unchanged.
    @discardableResult
    func select(name: String) -> Bool {
        guard let record = nodes.first(where: { $0.name == name }) else { return false }
        current = record
        defaults?.set(record.name, forKey: AppGroup.Key.nodeCurrent)
        mirrorLegacy(record)
        return true
    }

    /// Move off a dead node, on our own, before the user is looking at a blank
    /// page they cannot navigate away from.
    ///
    /// Called at launch and every time the app comes back to the foreground: a
    /// node can die mid-session, and on a flapping tunnel it does. Four rules,
    /// and the last two matter more than the first two:
    ///
    ///   * the CURRENT node is probed first, and a reachable one is never
    ///     switched away from;
    ///   * an unreachable current moves to the first peer that answers, in list
    ///     order, so the choice is predictable rather than "whichever raced
    ///     home first";
    ///   * if NOTHING answers, `current` stays exactly as it was - the user
    ///     picked it, the bootstrap page still offers a way out, and thrashing
    ///     between dead nodes helps nobody;
    ///   * it fails OVER, never automatically BACK. Nothing here moves the app
    ///     while the node it is on still answers, so a recovered node is a
    ///     deliberate switch by the person, not a jump under their hands.
    ///
    /// Main-actor isolated: it reads and writes the published state, and every
    /// await hands off to URLSession and resumes back here.
    @MainActor
    @discardableResult
    func failoverIfNeeded(prober: NodeProber, now: Date = Date()) async -> NodeFailoverOutcome {
        guard let from = current else { return .noCurrentNode }
        if await prober.reachable(from.shellOrigin) { return .currentReachable }
        // `nodes` is re-read after the await on purpose: a node could have been
        // added or removed from the page while the probe was in flight.
        for candidate in nodes where candidate.name != from.name {
            guard await prober.reachable(candidate.shellOrigin) else { continue }
            guard select(name: candidate.name) else { continue }
            lastFailover = NodeFailoverNotice(from: from.name, to: candidate.name, at: now)
            return .switched(from: from.name, to: candidate.name)
        }
        return .noneReachable
    }

    /// The app dismisses its own notice; the store does not time it.
    @MainActor
    func clearFailoverNotice() {
        lastFailover = nil
    }

    func remove(name: String) {
        guard nodes.contains(where: { $0.name == name }) else { return }
        nodes.removeAll { $0.name == name }
        persistNodes()
        if current?.name == name {
            current = nil
            defaults?.removeObject(forKey: AppGroup.Key.nodeCurrent)
            clearLegacy()
        }
    }

    /// Pre-G3 installs stored one endpoint: the capture-service base (port
    /// 84xx) plus its token. That becomes the one node, selected. The shell
    /// origin is the same host with the port dropped, because the capture
    /// port is the serve port of one fitting, not of the shell.
    func migrateLegacyIfNeeded() {
        guard nodes.isEmpty, let base = legacyBaseURL, let token = legacyToken, let host = base.host else { return }
        var origin = URLComponents()
        origin.scheme = Self.shellScheme(from: base.scheme)
        origin.host = host
        guard let shellOrigin = origin.url else { return }
        let record = NodeRecord(
            name: NodeRecord.defaultName(for: shellOrigin),
            shellOrigin: shellOrigin,
            captureBaseURL: base,
            token: token
        )
        nodes = [record]
        persistNodes()
        select(name: record.name)
    }

    #if DEBUG
    /// Simulator iteration seam: `xcrun simctl launch` hands SIMCTL_CHILD_<VAR>
    /// to the app as <VAR>. Origin + token upsert and select a node so a fresh
    /// simulator lands on the shell without typing into the bootstrap page.
    /// The token is never logged. Compiled out of Release.
    func seedFromEnvironmentIfRequested() {
        let env = ProcessInfo.processInfo.environment
        guard let rawOrigin = env["GARRISON_NODE_ORIGIN"],
              let origin = NodeRecord.normalizedOrigin(rawOrigin),
              let token = env["GARRISON_CAPTURE_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty
        else { return }
        let name = env["GARRISON_NODE_NAME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let capture = env["GARRISON_CAPTURE_URL"].flatMap(NodeRecord.normalizedOrigin)
        let record = NodeRecord(
            name: (name?.isEmpty == false) ? name! : NodeRecord.defaultName(for: origin),
            shellOrigin: origin,
            captureBaseURL: capture ?? NodeRecord.defaultCaptureBaseURL(for: origin),
            token: token
        )
        upsert(record)
        select(name: record.name)
    }
    #endif

    // MARK: - Private

    private var legacyBaseURL: URL? {
        guard let raw = defaults?.string(forKey: AppGroup.Key.baseURL)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty
        else { return nil }
        return URL(string: raw)
    }

    private var legacyToken: String? {
        let value = defaults?.string(forKey: AppGroup.Key.token)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (value?.isEmpty ?? true) ? nil : value
    }

    /// First pairing could store a bare ws:// base; the shell is plain HTTP(S).
    private static func shellScheme(from scheme: String?) -> String {
        switch scheme?.lowercased() {
        case "ws", "http": return "http"
        default: return "https"
        }
    }

    private func mirrorLegacy(_ record: NodeRecord) {
        defaults?.set(record.captureBaseURL.absoluteString, forKey: AppGroup.Key.baseURL)
        defaults?.set(record.token, forKey: AppGroup.Key.token)
    }

    private func clearLegacy() {
        defaults?.removeObject(forKey: AppGroup.Key.baseURL)
        defaults?.removeObject(forKey: AppGroup.Key.token)
    }

    private func persistNodes() {
        guard let data = try? JSONEncoder().encode(nodes) else { return }
        defaults?.set(data, forKey: AppGroup.Key.nodeList)
    }

    private static func decodeNodes(_ data: Data?) -> [NodeRecord] {
        guard let data else { return [] }
        return (try? JSONDecoder().decode([NodeRecord].self, from: data)) ?? []
    }
}
