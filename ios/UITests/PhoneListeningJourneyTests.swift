import XCTest
import Foundation

// A separate runner remains available while the app under test is backgrounded.
@MainActor
final class PhoneListeningJourneyTests: XCTestCase {
    func testStartInterruptStallDeepLinkSwitchAndDeliberateStop() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let shell = env["GARRISON_LISTENING_PROOF_SHELL"], shell.hasPrefix("http://127.0.0.1:"),
              let base = env["GARRISON_LISTENING_PROOF_URL"],
              let control = env["GARRISON_LISTENING_PROOF_CONTROL"],
              let token = env["GARRISON_LISTENING_PROOF_TOKEN"] else { throw XCTSkip("Requires the isolated listening node") }
        continueAfterFailure = false
        executionTimeAllowance = 300
        var device: String?
        func probe(_ route: String) async throws -> [String: Any] {
            var url = URLComponents(string: control + "/" + route)!
            if let device { url.queryItems = [URLQueryItem(name: "device", value: device)] }
            let (data, _) = try await URLSession.shared.data(from: url.url!)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        func record(_ source: String = "phone") async throws -> [String: Any]? {
            let state = try await probe("state")
            return (state["records"] as? [[String: Any]])?.first { $0["source"] as? String == source }
        }
        func waitFor(_ source: String = "phone", actual: String, timeout: TimeInterval = 30) async throws {
            let end = Date().addingTimeInterval(timeout)
            while Date() < end {
                if try await record(source)?["actual"] as? String == actual { return }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            let state = try await probe("state")
            let attachment = XCTAttachment(string: String(describing: state)); attachment.name = "listening-state-failure"; attachment.lifetime = .keepAlways; add(attachment)
            XCTFail("Expected \(source) actual \(actual)")
            throw NSError(domain: "ListeningUIJourney", code: 1)
        }
        let app = XCUIApplication(bundleIdentifier: "com.gomes.garrison")
        app.launchEnvironment = [
            "GARRISON_NODE_ORIGIN": shell, "GARRISON_NODE_NAME": "listening-proof",
            "GARRISON_CAPTURE_URL": base, "GARRISON_CAPTURE_TOKEN": token,
            "GARRISON_OPEN_PATH": "/", "GARRISON_LISTENING_UI_TEST": "1"
        ]
        _ = try await probe("unblock"); _ = try await probe("reset-pushes")
        app.launch()
        let start = app.buttons["Start listening"].firstMatch
        XCTAssertTrue(start.waitForExistence(timeout: 45))
        device = try await record()?["device_id"] as? String
        XCTAssertNotNil(device)
        _ = try await probe("event/start-home")
        start.tap()
        try await waitFor(actual: "listening")
        XCTAssertTrue(app.links["Listening"].firstMatch.waitForExistence(timeout: 5))
        let first = XCTAttachment(screenshot: app.screenshot()); first.name = "e2e-home-listening"; first.lifetime = .keepAlways; add(first)

        app.open(URL(string: "garrison://listening-test/interruption-began")!)
        try await waitFor(actual: "interrupted")
        app.open(URL(string: "garrison://listening-test/interruption-ended")!)
        try await waitFor(actual: "listening")
        _ = try await probe("event/interruption-resumed")

        _ = try await probe("cut")
        try await waitFor(actual: "stalled", timeout: 25)
        let stalled = try await probe("state")
        let pushes = try XCTUnwrap(stalled["pushes"] as? [[String: Any]])
        XCTAssertEqual(pushes.count, 1)
        XCTAssertEqual(pushes.first?["title"] as? String, "Zeca stopped listening")
        XCTAssertEqual(pushes.first?["body"] as? String, "The phone microphone stopped sending audio. Tap to resume.")
        XCTAssertEqual(pushes.first?["path"] as? String, "/capture?source=phone")
        XCTAssertTrue(app.staticTexts["Stopped listening"].firstMatch.waitForExistence(timeout: 5))

        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10) || app.state == .runningBackgroundSuspended)
        _ = try await probe("event/app-backgrounded")
        try await Task.sleep(nanoseconds: 3_000_000_000)
        _ = try await probe("unblock")
        app.open(URL(string: "garrison://open?path=%2Fcapture%3Fsource%3Dphone")!)
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        XCTAssertTrue(app.staticTexts["Capture"].firstMatch.waitForExistence(timeout: 15))
        try await waitFor(actual: "listening")
        _ = try await probe("event/deep-link-resumed")
        let resumed = XCTAttachment(screenshot: app.screenshot()); resumed.name = "e2e-capture-resumed"; resumed.lifetime = .keepAlways; add(resumed)

        _ = try await probe("cut")
        try await waitFor(actual: "stalled", timeout: 25)
        _ = try await probe("unblock")
        let resume = app.buttons["Resume"].firstMatch
        XCTAssertTrue(resume.waitForExistence(timeout: 5)); resume.tap()
        try await waitFor(actual: "listening")
        _ = try await probe("event/manual-resume")

        app.open(URL(string: "garrison://listening-test/pair-pendant")!)
        let pendantStart = app.buttons["Start listening"].firstMatch
        XCTAssertTrue(pendantStart.waitForExistence(timeout: 5)); pendantStart.tap()
        try await waitFor("pendant", actual: "listening")
        try await waitFor(actual: "off")
        let switchedPhoneIntent = try await record()?["intent"] as? String
        XCTAssertEqual(switchedPhoneIntent, "off")
        _ = try await probe("event/switched-to-pendant")
        app.buttons["Start listening"].firstMatch.tap()
        try await waitFor(actual: "listening")
        try await waitFor("pendant", actual: "off")
        _ = try await probe("event/switched-to-phone")

        let stop = app.buttons["Hold to stop"].firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 5)); stop.press(forDuration: 1)
        let shortHoldIntent = try await record()?["intent"] as? String
        XCTAssertEqual(shortHoldIntent, "listening")
        _ = try await probe("event/short-hold-cancelled")
        stop.press(forDuration: 1.7)
        try await waitFor(actual: "off")
        XCTAssertTrue(app.staticTexts["Not listening"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.links["Listening"].firstMatch.exists)
        let count = ((try await probe("state"))["pushes"] as? [[String: Any]])?.count
        try await Task.sleep(nanoseconds: 25_000_000_000)
        let stoppedCount = ((try await probe("state"))["pushes"] as? [[String: Any]])?.count
        XCTAssertEqual(stoppedCount, count)
        _ = try await probe("event/stopped-without-push")
        let stopped = XCTAttachment(screenshot: app.screenshot()); stopped.name = "e2e-deliberate-stop"; stopped.lifetime = .keepAlways; add(stopped)
    }
}
