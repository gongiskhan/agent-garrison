import SwiftUI
import UIKit
import UserNotifications

/// UIKit bridge for APNs registration callbacks (ios-thing pattern).
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Set before launch completes, synchronously: a notification tap that
        // cold-starts the app is delivered to the delegate right after this
        // returns, and with none installed the tap opens the app to nothing.
        UNUserNotificationCenter.current().delegate = PushManager.shared
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            PushManager.shared.didRegister(deviceToken: deviceToken)
        }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in
            PushManager.shared.didFailToRegister(error)
        }
    }
}

@main
struct GarrisonApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = NodeStore.shared

    init() {
        #if DEBUG
        // Before the first body: seeding in onAppear would first build a
        // no-node bridge (bootstrap page) and tear it down a frame later.
        NodeStore.shared.seedFromEnvironmentIfRequested()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            // The id IS the node switch: a bridge's serverURL is fixed for its
            // lifetime, so a new origin means a new controller, not a reload.
            BridgeHost()
                .id(store.currentOrigin ?? "none")
                .ignoresSafeArea()
                .onAppear {
                    #if DEBUG
                    FixtureStreamer.autostartIfRequested()
                    #endif
                    // A paired pendant reconnects with the app, not with one
                    // screen. Only when we already know the peripheral - a
                    // first pairing is still a deliberate act, from the page.
                    if AppGroup.pendantIdentifier != nil {
                        PendantController.shared.connect()
                    }
                    // Silent re-registration only: never a permission prompt
                    // at launch. The first prompt is GarrisonPush.register()
                    // from the page, in context. Re-fires on node switch (new
                    // identity), which is when the new node needs the token.
                    if NodeStore.shared.current != nil {
                        PushManager.shared.refreshRegistrationIfAuthorized()
                    }
                }
                .onOpenURL { url in
                    PushRouter.shared.open(url)
                }
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back from the background: CoreBluetooth may have dropped
            // the link while suspended, and the wearable is worn all day. A
            // connect on an already-connected transport is a no-op.
            if phase == .active, AppGroup.pendantIdentifier != nil {
                PendantController.shared.connect()
            }
        }
    }
}
