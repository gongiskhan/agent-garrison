import XCTest
import AVFoundation
import UIKit
import WebKit
@testable import GarrisonApp

// Test-only state overrides are injected through the same published channel.
// No debug HTTP mutation endpoint or synthetic capture path ships in the app.
@MainActor
final class ListeningShellJourneyTests: XCTestCase {
    func testHomeCaptureScreenshotsAndCombinedJourney() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let shell = env["GARRISON_LISTENING_PROOF_SHELL"], shell.hasPrefix("http://127.0.0.1:"),
              let base = env["GARRISON_LISTENING_PROOF_URL"], let control = env["GARRISON_LISTENING_PROOF_CONTROL"],
              let token = env["GARRISON_LISTENING_PROOF_TOKEN"] else { throw XCTSkip("Requires the isolated simulator shell") }
        AppGroup.defaults?.set(base, forKey: AppGroup.Key.baseURL)
        AppGroup.defaults?.set(token, forKey: AppGroup.Key.token)
        AppGroup.consentSuppressed = true
        let node = NodeRecord(name: "listening-proof", shellOrigin: try XCTUnwrap(URL(string: shell)), captureBaseURL: try XCTUnwrap(URL(string: base)), token: token)
        NodeStore.shared.upsert(node); NodeStore.shared.select(name: node.name)
        let channel = ListeningChannel.shared
        channel.connect()
        try await wait { channel.records["phone"] != nil }
        let device = try XCTUnwrap(channel.deviceId)
        func probe(_ route: String) async throws -> [String: Any] {
            let (data, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: "\(control)/\(route)?device=\(device)")))
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        func bridge(_ vc: UIViewController?) -> GarrisonBridgeViewController? {
            guard let vc else { return nil }
            if let found = vc as? GarrisonBridgeViewController { return found }
            if let found = bridge(vc.presentedViewController) { return found }
            for child in vc.children { if let found = bridge(child) { return found } }
            return nil
        }
        var host: GarrisonBridgeViewController?
        try await wait {
            host = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).compactMap { bridge($0.rootViewController) }.first
            return host?.webView?.url?.absoluteString.hasPrefix(shell) == true
        }
        let web = try XCTUnwrap(host?.webView)
        func js(_ script: String) async throws -> Any? { try await web.evaluateJavaScript(script) }
        func dom(_ condition: String, timeout: TimeInterval = 45) async throws {
            let end = Date().addingTimeInterval(timeout)
            while Date() < end {
                if (try? await js(condition)) as? Bool == true { return }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            XCTFail("Missing DOM state: \(condition)"); throw NSError(domain: "ListeningShellJourney", code: 1)
        }
        func route(_ path: String) async throws {
            host?.open(path: path)
            try await dom("location.pathname === '\(path)' && !!document.querySelector('[data-testid=\"listening-phone\"]')")
        }
        func actual(_ value: String) async throws {
            try await dom("document.querySelector('[data-testid=\"listening-phone\"]')?.dataset.actual === '\(value)'")
        }
        func click(_ source: String = "phone") async throws {
            _ = try await js("document.querySelector('[data-testid=\"listening-\(source)\"] button[aria-label]').click()")
        }
        func hold(_ milliseconds: Int, source: String = "phone") async throws {
            _ = try await js("window.heldButton=document.querySelector('[data-testid=\"listening-\(source)\"] button[aria-label]');heldButton.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}))")
            try await Task.sleep(nanoseconds: UInt64(milliseconds) * 1_000_000)
            _ = try await js("heldButton.dispatchEvent(new KeyboardEvent('keyup',{key:' ',bubbles:true}))")
        }
        defer { channel.intent("phone", "off"); channel.intent("pendant", "off"); CaptureController.shared.stop(); channel.pendant.disconnect(); GarrisonPendantPlugin.controllerOverride = nil }
        try await dom("location.origin === '\(shell)' && document.readyState === 'complete'", timeout: 90)
        try await wait(timeout: 30) { !web.isLoading }
        // Six states on both actual shell pages, with simulator WebKit snapshots.
        channel.intent("phone", "off")
        try await wait { channel.records["phone"]?.intent == "off" }
        let original = try XCTUnwrap(channel.records["phone"])
        for path in ["/", "/capture"] {
            try await route(path)
            for state in ["off", "starting", "listening", "interrupted", "stalled", "failed"] {
                var payload = original.payload
                payload["actual"] = state; payload["intent"] = "off"; payload["reason"] = state == "failed" ? "engine_error" : "user_stop"
                channel.receive(try JSONDecoder().decode(DeviceListeningState.self, from: JSONSerialization.data(withJSONObject: payload)))
                try await actual(state)
                let snapshot = try await web.takeSnapshot(configuration: nil)
                let attachment = XCTAttachment(image: snapshot); attachment.name = "\(path == "/" ? "home" : "capture")-\(state)"; attachment.lifetime = .keepAlways; add(attachment)
            }
        }
        channel.receive(original)
        // Phase 3 uses the Phase 1 mock as its stream. Only the engine start
        // and its reports are replaced; native intent and UI events stay real.
        let controller = CaptureController.shared
        let nativeStart = controller.recovery.startEngine
        let nativeReport = controller.recovery.report
        defer { controller.recovery.startEngine = nativeStart; controller.recovery.report = nativeReport }
        controller.recovery.startEngine = {}
        controller.recovery.report = { _, _ in }
        _ = try await probe("mock-start")
        try await route("/"); try await actual("off"); try await click(); try await actual("listening")
        try await route("/capture"); try await actual("listening")
        host?.open(path: "/quarters")
        try await dom("location.pathname === '/quarters' && document.querySelector('[data-testid=\"listening-badge\"]')?.textContent === 'Listening'")
        _ = try await probe("mock-stop")
        try await dom("document.querySelector('[data-testid=\"listening-badge\"]')?.textContent === 'Stopped'")
        try await route("/"); try await actual("stalled")
        try await route("/capture"); try await actual("stalled")
        try await click(); _ = try await probe("mock-start"); try await actual("listening")
        try await hold(1000); XCTAssertEqual(channel.records["phone"]?.intent, "listening")
        try await hold(1700); try await actual("off")
        try await dom("!document.querySelector('[data-testid=\"listening-badge\"]')")
        _ = try await probe("mock-stop")
        controller.stopForServer(reason: "user_stop")
        controller.recovery.startEngine = nativeStart; controller.recovery.report = nativeReport
        _ = try await probe("reset-pushes")
        // Phase 4 restores the real microphone, and runs the combined journey.
        try await route("/"); try await actual("off"); try await click()
        try await actual("listening"); try await wait { CaptureController.shared.engineRunning }
        try await route("/capture"); try await actual("listening")
        host?.open(path: "/quarters")
        try await dom("location.pathname === '/quarters' && document.querySelector('[data-testid=\"listening-badge\"]')?.textContent === 'Listening'")
        try await route("/")
        NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: nil, userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
        try await actual("interrupted")
        NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: nil, userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue, AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume.rawValue])
        try await actual("listening")
        // The control server severs and rejects media sockets, without a polite stop.
        _ = try await probe("cut")
        try await actual("stalled")
        let stalled = try await probe("state")
        XCTAssertEqual((stalled["pushes"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual((stalled["pushes"] as? [[String: Any]])?.first?["title"] as? String, "Zeca stopped listening")
        // Host-side simctl backgrounds this app and opens the real scheme URL.
        _ = try await probe("background-and-open")
        try await dom("location.pathname === '/capture'")
        try await actual("listening")
        XCTAssertTrue(CaptureController.shared.engineRunning)
        var script = MockPendantTransport.Script(); script.connectDelayMs = 1
        let packets = (0..<3000).map { PendantFixturePacket(seq: $0 + 1, ts: Double($0) * 20, bytes: Data([0xf8,0xff,0xfe])) }
        let transport = MockPendantTransport(packets: packets, script: script)
        GarrisonPendantPlugin.controllerOverride = PendantController(transport: transport, phoneSink: nil)
        AppGroup.pendantIdentifier = UUID()
        channel.intent("pendant", "listening")
        try await wait { channel.records["pendant"]?.actual == "listening" && channel.records["phone"]?.intent == "off" }
        XCTAssertFalse(CaptureController.shared.engineRunning)
        channel.intent("phone", "listening")
        try await actual("listening")
        XCTAssertEqual(channel.records["pendant"]?.intent, "off")
        try await hold(1000); XCTAssertEqual(channel.records["phone"]?.intent, "listening")
        try await hold(1700); try await actual("off")
        try await dom("!document.querySelector('[data-testid=\"listening-badge\"]')")
        let before = (try await probe("state"))["pushes"] as? [[String: Any]]
        try await Task.sleep(nanoseconds: 25_000_000_000)
        let after = (try await probe("state"))["pushes"] as? [[String: Any]]
        XCTAssertEqual(after?.count, before?.count)
    }
    private func wait(timeout: TimeInterval = 15, until condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end { if condition() { return }; try await Task.sleep(nanoseconds: 50_000_000) }
        XCTFail("Native listening state did not arrive"); throw NSError(domain: "ListeningShellJourney", code: 2)
    }
}
