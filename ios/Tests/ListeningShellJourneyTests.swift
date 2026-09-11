import XCTest
import AVFoundation
import UIKit
import WebKit
@testable import GarrisonApp

// Test-only state overrides are injected through the same published channel.
// No debug HTTP mutation endpoint or synthetic capture path ships in the app.
@MainActor
final class ListeningShellJourneyTests: XCTestCase {
    func testHomeCaptureScreenshotsAndMockJourney() async throws {
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
            if let detail = try? await js("JSON.stringify({url:location.href,ready:document.readyState,body:document.body.innerText.slice(0,4000),native:!!window.Capacitor?.isNativePlatform?.()})") {
                let attachment = XCTAttachment(string: String(describing: detail)); attachment.name = "navigation-failure"; attachment.lifetime = .keepAlways; add(attachment)
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
    }

    private func wait(timeout: TimeInterval = 15, until condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end { if condition() { return }; try await Task.sleep(nanoseconds: 50_000_000) }
        XCTFail("Native listening state did not arrive"); throw NSError(domain: "ListeningShellJourney", code: 2)
    }
}
