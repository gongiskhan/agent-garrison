import AudioToolbox
import Foundation
import UIKit
import UserNotifications

/// The phone-side feedback tiers (ADR D4): since the Companion is the BLE
/// host, terminal events play local haptics and sounds directly - no push
/// round trip. Foreground: UIKit feedback generators plus short system
/// sounds (which respect the ringer switch). Background: a local
/// notification with a distinct sound per tier carries the news instead.
final class PhoneFeedbackSink {
    private let notificationCenter = UNUserNotificationCenter.current()

    func play(_ event: FeedbackEvent) {
        let backgrounded = UIApplication.shared.applicationState != .active
        switch event.name {
        case "wake_detected":
            guard !backgrounded else { return } // the pendant pulse carries it
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case "segment_captured":
            guard !backgrounded else { return }
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        case "window_closed":
            if backgrounded { return } // interim tier; terminal ones notify
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            AudioServicesPlaySystemSound(1057) // short tick
        case "task_created":
            if backgrounded {
                postLocalNotification(
                    title: "Zeca",
                    body: event.title.map { "Card created: \($0)" } ?? "Card created.",
                    sound: .default
                )
                return
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            AudioServicesPlaySystemSound(1054) // positive chime
        case "task_failed":
            if backgrounded {
                postLocalNotification(
                    title: "Zeca",
                    body: event.reason.map { "Couldn't act on that (\($0))." } ?? "Couldn't act on that.",
                    sound: .defaultCritical
                )
                return
            }
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            AudioServicesPlaySystemSound(1053) // low buzz
        default:
            break
        }
    }

    private func postLocalNotification(title: String, body: String, sound: UNNotificationSound) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = sound
        let request = UNNotificationRequest(
            identifier: "pendant-feedback-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        notificationCenter.add(request)
    }
}
