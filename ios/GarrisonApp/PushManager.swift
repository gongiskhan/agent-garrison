import UIKit
import UserNotifications

/// APNs registration (ios-thing pattern): permission, register, hex the
/// device token, POST it to the capture service's device registry with the
/// Bearer token. The permission prompt is never issued at launch: the page
/// asks through GarrisonPush.register() when the user reaches for it, and
/// launch only re-registers silently when permission is already granted
/// (APNs tokens rotate; the registry must hold the current one). A tapped
/// notification carries a shell path, which PushRouter delivers to the page.
/// AppDelegate installs this object as the notification-center delegate.
@MainActor
final class PushManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = PushManager()

    @Published private(set) var status: String = "not registered"

    /// Prompt if the system has not asked yet, then register. Returns once the
    /// authorization result is known; the token upload finishes later and
    /// lands in `status`, which the page observes as `pushStatus`.
    func requestAuthorizationAndRegister() async {
        let granted: Bool
        do {
            granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            status = "notification permission failed: \(error.localizedDescription)"
            return
        }
        if granted {
            status = "requesting token"
            UIApplication.shared.registerForRemoteNotifications()
        } else {
            status = "notifications denied (enable in Settings)"
        }
    }

    /// Launch-time re-registration. Never prompts: an unasked device stays
    /// unasked until the page asks in context.
    func refreshRegistrationIfAuthorized() {
        Task { @MainActor in
            switch await authorizationStatus() {
            case .authorized, .provisional, .ephemeral:
                status = "requesting token"
                UIApplication.shared.registerForRemoteNotifications()
            default:
                status = "notifications not enabled"
            }
        }
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        uploadToken(token)
    }

    func didFailToRegister(_ error: Error) {
        status = "push registration failed: \(error.localizedDescription)"
    }

    private func uploadToken(_ token: String) {
        guard let request = AppGroup.request(
            path: "/capture/devices",
            method: "POST",
            // The registry names the device the token belongs to; the App Group
            // capture name is whatever the capture settings last said (it read
            // "Mac mini" on a phone), so the system name goes instead.
            body: try? JSONSerialization.data(withJSONObject: ["apns_token": token, "device_name": UIDevice.current.name])
        ) else {
            status = "set the base URL and token first"
            return
        }
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.status = "token upload failed: \(error.localizedDescription)"
                    return
                }
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                self.status = code == 200 ? "registered" : "register-device HTTP \(code)"
            }
        }.resume()
    }

    // Show the banner even when the app is in the foreground: the page may be
    // on another thread than the one the notification is about.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    // Tapping a notification lands on content: the payload names the shell
    // path and PushRouter either hands it to the live page or parks it for
    // the bridge that is about to load. Dismissals carry no intent.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        let userInfo = response.notification.request.content.userInfo
        Task { @MainActor in
            if let path = PushRouter.path(fromNotification: userInfo) {
                PushRouter.shared.route(path: path)
            }
        }
    }
}
