import Capacitor
import Combine
import Foundation
import UserNotifications

/// Push for the page: ask for permission in context, report where the
/// registration stands, and hand over the shell path a tapped notification
/// carried. The route event is retained until consumed because a cold start
/// registers the page's listener only after the notification was already
/// tapped; without retention the tap would route nowhere.
final class GarrisonPushPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GarrisonPush"
    let jsName = "GarrisonPush"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pendingRoute", returnType: CAPPluginReturnPromise),
    ]

    private var cancellables: Set<AnyCancellable> = []

    /// Runs once after registration, when the bridge is attached and
    /// notifyListeners can reach the page.
    override func load() {
        Task { @MainActor in
            // dropFirst: the initial value is state the page reads via
            // status(), not a change worth an event.
            PushManager.shared.$status
                .dropFirst()
                .sink { [weak self] detail in
                    self?.notifyListeners("pushStatus", data: ["detail": detail])
                }
                .store(in: &self.cancellables)
        }
    }

    // MARK: - Methods

    @objc func register(_ call: CAPPluginCall) {
        Task { @MainActor in
            await PushManager.shared.requestAuthorizationAndRegister()
            call.resolve(await self.statusPayload())
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        Task { @MainActor in
            call.resolve(await self.statusPayload())
        }
    }

    @objc func pendingRoute(_ call: CAPPluginCall) {
        Task { @MainActor in
            if let path = PushRouter.shared.takePendingPath() {
                call.resolve(["path": path])
            } else {
                call.resolve([:])
            }
        }
    }

    // MARK: - Host seam

    /// The host calls this when a route arrives while the page is live. False
    /// when nobody listens, so the host can fall back to a plain navigation.
    func emitRoute(_ path: String) -> Bool {
        guard hasListeners("pushRoute") else { return false }
        notifyListeners("pushRoute", data: ["path": path], retainUntilConsumed: true)
        return true
    }

    // MARK: - Payload

    @MainActor
    private func statusPayload() async -> [String: Any] {
        let authorization = await PushManager.shared.authorizationStatus()
        let detail = PushManager.shared.status
        return [
            "authorization": Self.authorizationName(authorization),
            "registered": detail == "registered",
            "detail": detail,
        ]
    }

    private static func authorizationName(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "notDetermined"
        }
    }
}
