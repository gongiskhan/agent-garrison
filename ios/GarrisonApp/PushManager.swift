import UIKit
import UserNotifications

/// APNs registration (ios-thing pattern): request permission, register, hex
/// the device token, POST it to the capture service's device registry with
/// the Bearer token. Foreground notifications show as banners, and every
/// arriving notification is appended to the local ack log (spec §5c).
@MainActor
final class PushManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = PushManager()

    @Published private(set) var status: String = "not registered"

    func registerOnLaunch() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
            Task { @MainActor in
                guard let self else { return }
                if granted {
                    self.status = "requesting token"
                    UIApplication.shared.registerForRemoteNotifications()
                } else {
                    self.status = "notifications denied (enable in Settings)"
                }
            }
        }
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
            body: try? JSONSerialization.data(withJSONObject: ["apns_token": token, "device_name": AppGroup.deviceName])
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

    // Show the banner even when the app is in the foreground, and keep the
    // local readable copy.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let content = notification.request.content
        AckLog.shared.append(AckLogEntry(
            id: notification.request.identifier,
            at: Date(),
            kind: content.userInfo["tag"] as? String,
            severity: nil,
            text: [content.title, content.body].filter { !$0.isEmpty }.joined(separator: ": "),
            via: "push"
        ))
        completionHandler([.banner, .sound, .list])
    }

    // Tapping a notification lands on content (§5c): the ack log holds the
    // full text; deep links open from there.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let content = response.notification.request.content
        AckLog.shared.append(AckLogEntry(
            id: response.notification.request.identifier,
            at: Date(),
            kind: content.userInfo["tag"] as? String,
            severity: nil,
            text: [content.title, content.body].filter { !$0.isEmpty }.joined(separator: ": "),
            via: "push-opened"
        ))
        completionHandler()
    }
}
