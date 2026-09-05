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
    private let prober: NodeProber = URLSessionNodeProber()

    init() {
        #if DEBUG
        // Before the first body: seeding in onAppear would first build a
        // no-node bridge (bootstrap page) and tear it down a frame later.
        NodeStore.shared.seedFromEnvironmentIfRequested()
        // GARRISON_OPEN_PATH=/capture takes the cold-start route lane: the
        // path waits in PushRouter until the first load settles, exactly as a
        // push tap on a closed app does. Simulator iteration only.
        if let path = ProcessInfo.processInfo.environment["GARRISON_OPEN_PATH"],
           PushRouter.path(fromNotification: ["path": path]) != nil {
            PushRouter.shared.route(path: path)
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            // The id IS the node switch: a bridge's serverURL is fixed for its
            // lifetime, so a new origin means a new controller, not a reload.
            // Which is also why failover needs no plumbing beyond changing the
            // selected node: the bridge re-mounts against the new origin, and
            // BridgeHost's onAppear re-fires, so the pendant reconnects and the
            // push token re-registers with the node the app actually landed on.
            ZStack(alignment: .top) {
                BridgeHost()
                    .id(store.currentOrigin ?? "none")
                    .ignoresSafeArea()
                    .onAppear {
                        #if DEBUG
                        FixtureStreamer.autostartIfRequested()
                        #endif
                        // A paired pendant reconnects with the app, not with
                        // one screen. Only when we already know the peripheral
                        // - a first pairing is still a deliberate act, from the
                        // page.
                        if AppGroup.pendantIdentifier != nil {
                            PendantController.shared.connect()
                        }
                        // Silent re-registration only: never a permission
                        // prompt at launch. The first prompt is
                        // GarrisonPush.register() from the page, in context.
                        // Re-fires on node switch (new identity), which is when
                        // the new node needs the token - a failover is exactly
                        // such a switch.
                        if NodeStore.shared.current != nil {
                            PushManager.shared.refreshRegistrationIfAuthorized()
                        }
                    }
                    .onOpenURL { url in
                        PushRouter.shared.open(url)
                    }
                if let notice = store.lastFailover {
                    FailoverBanner(notice: notice) { store.clearFailoverNotice() }
                }
            }
            // The launch probe. On the ZStack, not on BridgeHost: BridgeHost's
            // identity changes with the origin, so a task there would re-run on
            // every switch and could walk the node list in one launch.
            .task {
                await store.failoverIfNeeded(prober: prober)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            // Coming back from the background: CoreBluetooth may have dropped
            // the link while suspended, and the wearable is worn all day. A
            // connect on an already-connected transport is a no-op.
            if AppGroup.pendantIdentifier != nil {
                PendantController.shared.connect()
            }
            // A node can die while the app is in someone's pocket, and on a
            // flapping tunnel it does. Same rules as the launch probe: a
            // reachable node is never switched away from.
            Task { await store.failoverIfNeeded(prober: prober) }
        }
    }
}

/// "You are not where you asked to be, and here is why." Auto-dismisses, and
/// never eats a touch meant for the page underneath.
private struct FailoverBanner: View {
    let notice: NodeFailoverNotice
    let dismiss: () -> Void
    @State private var shown = true

    var body: some View {
        Group {
            if shown {
                Text("\(notice.from) was not reachable. Switched to \(notice.to).")
                    .font(.footnote)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.black.opacity(0.82), in: Capsule())
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .allowsHitTesting(false)
                    .task {
                        try? await Task.sleep(nanoseconds: 6_000_000_000)
                        withAnimation { shown = false }
                        dismiss()
                    }
            }
        }
        .animation(.default, value: shown)
    }
}
