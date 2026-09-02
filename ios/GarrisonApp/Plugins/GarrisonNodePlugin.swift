import Capacitor
import Foundation

/// Node records for the page: which Garrison machines this device knows,
/// which one the web view is showing, and the switch between them. The
/// token stays native - every payload carries `hasToken`, never the value,
/// because the page is served by the node and must not be able to read the
/// credential that authenticates the device to it.
final class GarrisonNodePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GarrisonNode"
    let jsName = "GarrisonNode"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "current", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "add", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "select", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
    ]

    /// Weak: the host owns the bridge that owns this plugin; a strong back
    /// reference would keep a torn-down web view alive across node switches.
    private weak var host: GarrisonBridgeViewController?

    init(host: GarrisonBridgeViewController) {
        self.host = host
        super.init()
    }

    // MARK: - Methods (bridge queue -> main, NodeStore is main-thread only)

    @objc func current(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let record = NodeStore.shared.current else {
                call.resolve([:])
                return
            }
            call.resolve(Self.payload(record))
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        Task { @MainActor in
            let store = NodeStore.shared
            let nodes = store.nodes.map { record -> [String: Any] in
                var entry = Self.payload(record)
                entry["current"] = record.name == store.current?.name
                return entry
            }
            call.resolve(["nodes": nodes])
        }
    }

    /// Adds or replaces (by name) without selecting: the bootstrap page adds
    /// then selects explicitly, and a settings surface may edit a node that is
    /// not the current one.
    @objc func add(_ call: CAPPluginCall) {
        guard let rawOrigin = call.getString("shellOrigin"),
              let shellOrigin = NodeRecord.normalizedOrigin(rawOrigin)
        else {
            call.reject("shellOrigin must be an http(s) origin", "INVALID_ORIGIN")
            return
        }
        let token = call.getString("token")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !token.isEmpty else {
            call.reject("token must not be blank", "INVALID_TOKEN")
            return
        }
        let captureBaseURL: URL
        if let rawCapture = call.getString("captureBaseURL")?.trimmingCharacters(in: .whitespacesAndNewlines), !rawCapture.isEmpty {
            guard let capture = NodeRecord.normalizedOrigin(rawCapture) else {
                call.reject("captureBaseURL must be an http(s) origin", "INVALID_ORIGIN")
                return
            }
            captureBaseURL = capture
        } else {
            captureBaseURL = NodeRecord.defaultCaptureBaseURL(for: shellOrigin)
        }
        let requestedName = call.getString("name")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let record = NodeRecord(
            name: requestedName.isEmpty ? NodeRecord.defaultName(for: shellOrigin) : requestedName,
            shellOrigin: shellOrigin,
            captureBaseURL: captureBaseURL,
            token: token
        )
        Task { @MainActor in
            NodeStore.shared.upsert(record)
            call.resolve(Self.payload(record))
        }
    }

    /// Selecting a different origin rebuilds the bridge (SwiftUI id change),
    /// which tears down the web view this promise answers into. The result is
    /// queued to the page first and the store mutates on the next main tick,
    /// so the page hears the resolution before it disappears.
    @objc func select(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), !name.isEmpty else {
            call.reject("name is required", "UNKNOWN_NODE")
            return
        }
        Task { @MainActor in
            let store = NodeStore.shared
            guard store.nodes.contains(where: { $0.name == name }) else {
                call.reject("no node named \(name)", "UNKNOWN_NODE")
                return
            }
            call.resolve(["name": name])
            DispatchQueue.main.async {
                store.select(name: name)
            }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), !name.isEmpty else {
            call.reject("name is required", "UNKNOWN_NODE")
            return
        }
        Task { @MainActor in
            let store = NodeStore.shared
            guard store.nodes.contains(where: { $0.name == name }) else {
                call.reject("no node named \(name)", "UNKNOWN_NODE")
                return
            }
            store.remove(name: name)
            call.resolve([:])
        }
    }

    @objc func reload(_ call: CAPPluginCall) {
        Task { @MainActor in
            self.host?.reloadShell()
            call.resolve([:])
        }
    }

    @objc func info(_ call: CAPPluginCall) {
        let bundle = Bundle.main
        call.resolve([
            "appVersion": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "build": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
            "platform": "ios",
            "bundleId": bundle.bundleIdentifier ?? "",
        ])
    }

    // MARK: - Payload

    /// The record as the page sees it. `token` is deliberately absent.
    private static func payload(_ record: NodeRecord) -> [String: Any] {
        [
            "name": record.name,
            "shellOrigin": record.shellOrigin.absoluteString,
            "captureBaseURL": record.captureBaseURL.absoluteString,
            "hasToken": !record.token.isEmpty,
        ]
    }
}
