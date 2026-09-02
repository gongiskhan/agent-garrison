import Capacitor
import Foundation

/// The native surface the shell page reaches through
/// `window.Capacitor.Plugins.<jsName>`. One instance of each, registered by
/// GarrisonBridgeViewController.capacitorDidLoad() in THIS order; the bridge
/// keys them by jsName, so the names here are the contract the page codes
/// against (and BridgePluginRegistryTests pins).
enum GarrisonPlugins {
    static let jsNames = ["GarrisonNode", "GarrisonCapture", "GarrisonSpeech", "GarrisonPush", "GarrisonPendant"]

    /// Main actor because the capture backend is @MainActor and is built
    /// here, not lazily inside a plugin call that runs on the bridge's
    /// background queue. capacitorDidLoad() runs on main, so the host pays
    /// nothing for the annotation.
    @MainActor
    static func make(host: GarrisonBridgeViewController) -> [CAPPlugin & CAPBridgedPlugin] {
        [
            GarrisonNodePlugin(host: host),
            GarrisonCapturePlugin(controller: CaptureController()),
            GarrisonSpeechPlugin(),
            GarrisonPushPlugin(),
            GarrisonPendantPlugin(),
        ]
    }
}
