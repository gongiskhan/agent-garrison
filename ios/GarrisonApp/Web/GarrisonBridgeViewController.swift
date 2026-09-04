import Capacitor
import UIKit
import UserNotifications
import WebKit

/// The one screen: a Capacitor bridge pointed at the selected node's shell.
/// With no node it serves the bundled bootstrap page from capacitor://localhost
/// instead. One instance per node selection; GarrisonApp rebuilds it on switch.
final class GarrisonBridgeViewController: CAPBridgeViewController {
    /// Captured at construction: the bridge's serverURL is fixed for its
    /// lifetime, and NodeStore.current can move on before this VC is torn down.
    private let node: NodeRecord? = NodeStore.shared.current

    private var pushPlugin: GarrisonPushPlugin?
    private var loadObservation: NSKeyValueObservation?

    // MARK: - CAPBridgeViewController

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = InstanceDescriptor()
        if let node {
            descriptor.serverURL = node.shellOrigin.absoluteString
            // loadWebView() lands on serverURL + appStartPath, but it exit(1)s
            // unless <public>/<appStartPath> exists on disk; the bundled
            // public/talk/ placeholder satisfies that guard. With no node the
            // path stays nil so public/index.html (the bootstrap page) loads.
            descriptor.appStartPath = "talk"
        }
        // A failed navigation (node down, no network) lands on the bundled page,
        // which explains and offers Retry / another node instead of a blank view.
        descriptor.errorPath = "index.html"
        descriptor.appendedUserAgentString = Self.userAgentSuffix
        // The page owns its safe areas (viewport-fit=cover + env() insets).
        descriptor.contentInsetAdjustmentBehavior = .never
        descriptor.allowLinkPreviews = false
        // Capacitor defaults to making its NotificationRouter the
        // UNUserNotificationCenter delegate when the bridge is built, which
        // silently replaces PushManager (installed at launch): with no push
        // handler registered on that router a notification arriving while the
        // app is open is presented with no options - no banner, no sound - and
        // a tap routes nowhere. This app handles notifications itself.
        descriptor.handleApplicationNotifications = false
        return descriptor
    }

    override func capacitorDidLoad() {
        // Belt to the descriptor's braces: whatever a future Capacitor does at
        // bridge construction, the app's own delegate is in place once the
        // bridge is up.
        UNUserNotificationCenter.current().delegate = PushManager.shared
        for plugin in GarrisonPlugins.make(host: self) {
            bridge?.registerPluginInstance(plugin)
            if let push = plugin as? GarrisonPushPlugin {
                pushPlugin = push
            }
        }
    }

    override func viewDidLoad() {
        // super issues the ONE load (appStartServerURL). Never load again here:
        // a superseded provisional load fires didFailProvisionalNavigation and
        // drags the errorPath page in over the real shell.
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        PushRouter.shared.attach(self)
        armColdStartRoute()
    }

    // MARK: - Shell control (PushRouter, GarrisonNode, GarrisonPush)

    /// Delivers a shell path. The page takes it as a `pushRoute` event when it
    /// is listening (client-side navigation, state kept); otherwise the web
    /// view navigates to it. Ignored with no node: there is no shell to route.
    func open(path: String) {
        guard let node, path.hasPrefix("/") else { return }
        if let pushPlugin, pushPlugin.emitRoute(path) {
            return
        }
        guard let url = URL(string: path, relativeTo: node.shellOrigin)?.absoluteURL else { return }
        webView?.load(URLRequest(url: url))
    }

    /// Back to the launch landing: the node's /talk when a node is selected
    /// (the same URL loadWebView() opened, not the bare origin, which is the
    /// desktop dashboard), else the bundled bootstrap page.
    func reloadShell() {
        guard let bridge else { return }
        let url = node != nil
            ? bridge.config.appStartServerURL
            : bridge.config.localURL.appendingPathComponent("index.html")
        webView?.load(URLRequest(url: url))
    }

    // MARK: - Private

    /// Cold-start push tap (D5): the route arrived before any VC existed, so it
    /// waits in PushRouter. Deliver it once the first load settles; before that
    /// the page has no listener and a second load would cancel the first.
    /// Armed only when a node exists: with none, open(path:) would drop the
    /// route, so it stays pending for the VC built after the user adds a node.
    private func armColdStartRoute() {
        guard node != nil, PushRouter.shared.pendingPath != nil, let webView else { return }
        // The KVO handler is @Sendable, but WKWebView posts isLoading on the
        // main thread, so the hop is asserted rather than scheduled: a Task
        // would land one turn later than the page's own listener registration.
        loadObservation = webView.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            guard change.newValue == false else { return }
            MainActor.assumeIsolated {
                guard let self else { return }
                self.loadObservation?.invalidate()
                self.loadObservation = nil
                if let path = PushRouter.shared.takePendingPath() {
                    self.open(path: path)
                }
            }
        }
    }

    /// "GarrisonApp/1.4 (27)": lets the shell tell the app from Safari.
    private static var userAgentSuffix: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "GarrisonApp/\(short) (\(build))"
    }
}
