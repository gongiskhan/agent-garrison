import SwiftUI
import UIKit

/// UIKit bridge for APNs registration callbacks (ios-thing pattern).
final class AppDelegate: NSObject, UIApplicationDelegate {
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

    var body: some Scene {
        WindowGroup {
            ContentView()
                .onAppear {
                    #if DEBUG
                    FixtureStreamer.autostartIfRequested()
                    #endif
                    // A paired pendant reconnects with the app, not with one
                    // screen. Only when we already know the peripheral - a
                    // first pairing is still a deliberate act on PendantView.
                    if AppGroup.pendantIdentifier != nil {
                        PendantController.shared.connect()
                    }
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
