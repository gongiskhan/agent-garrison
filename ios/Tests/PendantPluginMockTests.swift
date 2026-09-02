import Capacitor
import XCTest
@testable import GarrisonApp

/// The pendant reaches the capture page through GarrisonPendantPlugin and
/// nothing else, so this is the mock harness for that seam: the plugin is
/// driven exactly as the Capacitor bridge drives it (a CAPPluginCall in, a
/// resolved payload out, addListener + notifyListeners for events) against a
/// controller built on MockPendantTransport. What the page reads
/// (connectionState / paired / lostFrames / ambientConsent / uploaderState /
/// battery) is proven here without hardware; the real pendant is the
/// operator's phone criterion.
///
/// No node is configured in these tests, so the controller never opens a
/// capture session: uploaderState stays "idle" and no sessionId appears.
@MainActor
final class PendantPluginMockTests: XCTestCase {
    private var savedDefaults: UserDefaults?
    private var transports: [MockPendantTransport] = []

    override func setUp() {
        super.setUp()
        savedDefaults = AppGroup.defaults
        AppGroup.defaults = UserDefaults(suiteName: "pendant-plugin-tests-\(UUID().uuidString)")
        AppGroup.pendantIdentifier = nil
        AppGroup.pendantAmbientConsent = false
    }

    override func tearDown() {
        for transport in transports { transport.disconnect() }
        transports = []
        GarrisonPendantPlugin.controllerOverride = nil
        AppGroup.defaults = savedDefaults
        super.tearDown()
    }

    // MARK: - Harness

    private func fastScript() -> MockPendantTransport.Script {
        var script = MockPendantTransport.Script()
        script.speed = 50
        script.connectDelayMs = 1
        return script
    }

    private func packets(_ count: Int, stepMs: Double = 20) -> [PendantFixturePacket] {
        (0..<count).map { i in
            PendantFixturePacket(seq: i + 1, ts: Double(i) * stepMs, bytes: Data([UInt8(i % 256), 0xEE]))
        }
    }

    /// A plugin wired to a mock-backed controller and loaded the way the
    /// bridge loads it. Capacitor's `load(on:)` (CAPPlugin+LoadInstance) is
    /// what gives a plugin its listener tables; a bare `init` has none and
    /// `notifyListeners` then drops every event on the floor. Mirror it minus
    /// the bridge and web view, which no test host has.
    private func makePlugin(
        packets: [PendantFixturePacket] = [],
        script: MockPendantTransport.Script? = nil
    ) -> GarrisonPendantPlugin {
        let transport = MockPendantTransport(packets: packets, script: script ?? fastScript())
        transports.append(transport)
        GarrisonPendantPlugin.controllerOverride = PendantController(transport: transport, phoneSink: nil)
        let plugin = GarrisonPendantPlugin()
        plugin.eventListeners = [:]
        plugin.retainedEventArguments = [:]
        plugin.pluginId = plugin.identifier
        plugin.pluginName = plugin.jsName
        plugin.load()
        return plugin
    }

    /// Invokes one plugin method as the bridge does and returns what it resolved.
    private func invoke(
        _ method: (CAPPluginCall) -> Void,
        named name: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async -> [String: Any] {
        await withCheckedContinuation { continuation in
            // The ObjC initializer is not nullability-audited, so it imports
            // as failable; it never fails for a well-formed call.
            guard let call = CAPPluginCall(
                callbackId: UUID().uuidString,
                methodName: name,
                options: [:],
                success: { result, _ in continuation.resume(returning: result?.data ?? [:]) },
                error: { error in
                    XCTFail("\(name) rejected: \(error?.message ?? "no message")", file: file, line: line)
                    continuation.resume(returning: [:])
                }
            ) else {
                XCTFail("CAPPluginCall init returned nil", file: file, line: line)
                continuation.resume(returning: [:])
                return
            }
            method(call)
        }
    }

    /// Subscribes to a plugin event the way `Plugins.GarrisonPendant.addListener`
    /// does: a kept-alive call whose success handler fires per notification.
    private func listen(_ plugin: GarrisonPendantPlugin, _ event: String, _ onEvent: @escaping ([String: Any]) -> Void) {
        guard let call = CAPPluginCall(
            callbackId: UUID().uuidString,
            methodName: "addListener",
            options: ["eventName": event],
            success: { result, _ in onEvent(result?.data ?? [:]) },
            error: { _ in }
        ) else {
            XCTFail("CAPPluginCall init returned nil")
            return
        }
        plugin.addListener(call)
    }

    // MARK: - Tests

    func testStatusBeforeAnyConnectIsDisconnectedUnpairedAndIdle() async {
        let plugin = makePlugin()
        let status = await invoke(plugin.status, named: "status")

        XCTAssertEqual(status["connectionState"] as? String, "disconnected")
        XCTAssertEqual(status["paired"] as? Bool, false)
        XCTAssertEqual(status["lostFrames"] as? Int, 0)
        XCTAssertEqual(status["ambientConsent"] as? Bool, false)
        XCTAssertEqual(status["uploaderState"] as? String, "idle")
        XCTAssertNil(status["battery"], "no battery before the first connection")
        XCTAssertNil(status["sessionId"], "no node configured, so no capture session")
        XCTAssertNil(status["uploaderError"])
    }

    func testConnectReachesConnectedThroughPendantStateAndReportsBattery() async {
        let plugin = makePlugin()
        let connected = expectation(description: "pendantState says connected")
        connected.assertForOverFulfill = false
        let batteryEvent = expectation(description: "pendantBattery carries the mock level")
        batteryEvent.assertForOverFulfill = false
        var states: [String] = []
        listen(plugin, "pendantState") { payload in
            if let state = payload["connectionState"] as? String {
                states.append(state)
                if state == "connected" { connected.fulfill() }
            }
        }
        listen(plugin, "pendantBattery") { payload in
            if payload["battery"] as? Int == 87 { batteryEvent.fulfill() }
        }

        let immediate = await invoke(plugin.connect, named: "connect")
        XCTAssertNotNil(immediate["connectionState"] as? String, "connect resolves with a status payload")

        await fulfillment(of: [connected, batteryEvent], timeout: 5)
        XCTAssertFalse(states.contains("disconnected"), "the burst debounce may skip intermediates but never reports a disconnect on the way up: \(states)")

        let status = await invoke(plugin.status, named: "status")
        XCTAssertEqual(status["connectionState"] as? String, "connected")
        XCTAssertEqual(status["battery"] as? Int, 87)
        XCTAssertEqual(status["hapticSupported"] as? Bool, true, "the mock script advertises haptics")
        XCTAssertEqual(status["uploaderState"] as? String, "idle", "no node configured: connected but not streaming")
    }

    func testDisconnectResolvesDisconnectedAndStaysPaired() async {
        AppGroup.pendantIdentifier = UUID()
        let plugin = makePlugin()
        let connected = expectation(description: "connected")
        connected.assertForOverFulfill = false
        listen(plugin, "pendantState") { payload in
            if payload["connectionState"] as? String == "connected" { connected.fulfill() }
        }
        _ = await invoke(plugin.connect, named: "connect")
        await fulfillment(of: [connected], timeout: 5)

        // The transport settles off the main actor, so the resolve is the
        // status at call time and the pendantState event carries the drop.
        let dropped = expectation(description: "disconnected")
        dropped.assertForOverFulfill = false
        listen(plugin, "pendantState") { payload in
            if payload["connectionState"] as? String == "disconnected" { dropped.fulfill() }
        }
        let immediate = await invoke(plugin.disconnect, named: "disconnect")
        XCTAssertEqual(immediate["paired"] as? Bool, true, "disconnect keeps the pairing; only forget drops it")
        await fulfillment(of: [dropped], timeout: 5)

        let status = await invoke(plugin.status, named: "status")
        XCTAssertEqual(status["connectionState"] as? String, "disconnected")
        XCTAssertEqual(status["paired"] as? Bool, true)
        XCTAssertEqual(status["uploaderState"] as? String, "idle")
    }

    func testForgetDropsThePairingAndDisconnects() async {
        AppGroup.pendantIdentifier = UUID()
        let plugin = makePlugin()
        let before = await invoke(plugin.status, named: "status")
        XCTAssertEqual(before["paired"] as? Bool, true)

        let status = await invoke(plugin.forget, named: "forget")
        XCTAssertEqual(status["paired"] as? Bool, false)
        XCTAssertEqual(status["connectionState"] as? String, "disconnected")
        XCTAssertNil(AppGroup.pendantIdentifier, "forget clears the remembered peripheral so launch stops reconnecting")
    }

    func testLostFramesReachThePayload() async {
        var script = fastScript()
        script.dropPacketAtIndex = 4
        let plugin = makePlugin(packets: packets(12), script: script)
        _ = await invoke(plugin.connect, named: "connect")

        // lostFrames is not one of the published properties the plugin
        // debounces on (it rides the next state emit), so read it back the
        // way the page does on open: through status.
        var seen = 0
        var tries = 0
        while seen == 0 && tries < 50 {
            tries += 1
            try? await Task.sleep(nanoseconds: 50_000_000)
            let status = await invoke(plugin.status, named: "status")
            seen = status["lostFrames"] as? Int ?? 0
        }
        XCTAssertEqual(seen, 1, "one dropped packet is one lost frame in the payload")
    }

    func testAmbientConsentFlagIsMirroredFromAppGroup() async {
        AppGroup.pendantAmbientConsent = true
        let plugin = makePlugin()
        let status = await invoke(plugin.status, named: "status")
        XCTAssertEqual(status["ambientConsent"] as? Bool, true)
    }
}
