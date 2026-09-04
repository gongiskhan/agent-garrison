import Capacitor
import XCTest
@testable import GarrisonApp

/// The page codes against `window.Capacitor.Plugins.<jsName>.<method>()`, so
/// the names below are the contract: a renamed plugin or method here is a
/// broken page with no compiler to say so. `make(host:)` is @MainActor (it
/// builds the @MainActor capture backend), hence the isolated test case.
@MainActor
final class BridgePluginRegistryTests: XCTestCase {
    private static let expectedMethods: [String: Set<String>] = [
        "GarrisonNode": ["current", "list", "add", "select", "remove", "reload", "info"],
        "GarrisonCapture": ["status", "start", "stop", "consent", "setConsentSuppressed"],
        "GarrisonSpeech": ["speak", "stop", "voices", "settings", "configure", "muteFor", "unmute"],
        "GarrisonPush": ["register", "status", "pendingRoute"],
        "GarrisonPendant": ["status", "connect", "disconnect", "forget"],
    ]

    func testJsNamesAreTheFiveInOrder() {
        XCTAssertEqual(GarrisonPlugins.jsNames, ["GarrisonNode", "GarrisonCapture", "GarrisonSpeech", "GarrisonPush", "GarrisonPendant"])
        XCTAssertEqual(Set(GarrisonPlugins.jsNames), Set(Self.expectedMethods.keys), "every listed plugin has a method table here")
    }

    // The bridge must not take the notification-center delegate away from
    // PushManager: Capacitor's router would then present a notification that
    // arrives while the app is open with no options (no banner) and route no
    // tap. Read off the descriptor, so the test needs no bridge.
    func testBridgeLeavesNotificationsToPushManager() {
        XCTAssertFalse(GarrisonBridgeViewController().instanceDescriptor().handleApplicationNotifications)
    }

    // Constructing the host is enough: its view is never loaded, so no bridge
    // and no web view come up in the test host.
    func testMakeBuildsOneInstancePerNameInOrder() {
        let host = GarrisonBridgeViewController()
        let plugins = GarrisonPlugins.make(host: host)

        XCTAssertEqual(plugins.map(\.jsName), GarrisonPlugins.jsNames)
        for plugin in plugins {
            XCTAssertEqual(plugin.identifier, plugin.jsName, "the bridge keys plugins by identifier and the page by jsName; they must agree")
            XCTAssertTrue(GarrisonPlugins.jsNames.contains(plugin.jsName))
        }
    }

    func testEachPluginExposesExactlyTheContractMethods() {
        let plugins = GarrisonPlugins.make(host: GarrisonBridgeViewController())
        for plugin in plugins {
            let expected = Self.expectedMethods[plugin.jsName] ?? []
            // CAPPluginMethod.h is not nullability-audited, so `name` arrives as
            // an implicitly unwrapped optional; the annotation collapses it.
            let names: [String] = plugin.pluginMethods.map { $0.name }
            XCTAssertEqual(Set(names), expected, plugin.jsName)
            XCTAssertEqual(names.count, expected.count, "\(plugin.jsName) lists a method twice")
        }
    }

    // A plugin method is invoked by selector `<name>:` on the ObjC side; a
    // typo between the table and the Swift method surfaces only at runtime as
    // a rejected call. Prove every declared method resolves.
    func testEveryDeclaredMethodHasAnObjCImplementation() {
        let plugins = GarrisonPlugins.make(host: GarrisonBridgeViewController())
        for plugin in plugins {
            for method in plugin.pluginMethods {
                XCTAssertTrue(
                    plugin.responds(to: method.selector),
                    "\(plugin.jsName).\(method.name as String) declares selector \(NSStringFromSelector(method.selector)) but does not implement it"
                )
            }
        }
    }
}
