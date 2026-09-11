import XCTest
import Foundation

private final class ListeningProbeResult: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Result<(Data, URLResponse), Error>?
    func set(_ result: Result<(Data, URLResponse), Error>) { lock.lock(); defer { lock.unlock() }; value = result }
    func get() -> Result<(Data, URLResponse), Error>? { lock.lock(); defer { lock.unlock() }; return value }
}

// A separate runner remains available while the app under test is backgrounded.
@MainActor
final class PhoneListeningJourneyTests: XCTestCase {
    func testStartInterruptStallDeepLinkSwitchAndDeliberateStop() throws {
        let env = ProcessInfo.processInfo.environment
        guard let shell = env["GARRISON_LISTENING_PROOF_SHELL"], shell.hasPrefix("http://127.0.0.1:"),
              let base = env["GARRISON_LISTENING_PROOF_URL"],
              let control = env["GARRISON_LISTENING_PROOF_CONTROL"],
              let token = env["GARRISON_LISTENING_PROOF_TOKEN"] else { throw XCTSkip("Requires the isolated listening node") }
        continueAfterFailure = false
        executionTimeAllowance = 300
        var device: String?
        func pause(_ seconds: TimeInterval) {
            let deadline = Date().addingTimeInterval(seconds)
            while Date() < deadline { RunLoop.current.run(until: min(deadline, Date().addingTimeInterval(0.05))) }
        }
        func signal(_ event: String) {
            CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName("com.gomes.garrison.listening-test.\(event)" as CFString), nil, nil, true)
        }
        func probe(_ route: String) throws -> [String: Any] {
            var url = URLComponents(string: control + "/" + route)!
            if let device { url.queryItems = [URLQueryItem(name: "device", value: device)] }
            let result = ListeningProbeResult()
            let request = URLRequest(url: url.url!, timeoutInterval: 30)
            let task = URLSession.shared.dataTask(with: request) { data, response, error in
                if let data, let response { result.set(.success((data, response))) }
                else { result.set(.failure(error ?? NSError(domain: "ListeningProbe", code: 1))) }
            }
            task.resume()
            let deadline = Date().addingTimeInterval(35)
            while result.get() == nil && Date() < deadline { pause(0.05) }
            defer { task.cancel() }
            let (data, response) = try XCTUnwrap(result.get(), "The listening probe timed out").get()
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw NSError(domain: "ListeningUIControl", code: (response as? HTTPURLResponse)?.statusCode ?? 0) }
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        func record(_ source: String = "phone") throws -> [String: Any]? {
            let state = try probe("state")
            return (state["records"] as? [[String: Any]])?.first { $0["source"] as? String == source }
        }
        func eventCount(_ event: String) throws -> Int {
            let events = (try probe("state"))["hostEvents"] as? [[String: Any]] ?? []
            return events.filter { $0["type"] as? String == "journey:" + event }.count
        }
        func waitForEvent(_ event: String, after count: Int) throws {
            let deadline = Date().addingTimeInterval(15)
            while Date() < deadline {
                if try eventCount(event) > count { return }
                pause(0.1)
            }
            throw NSError(domain: "ListeningLifecycle-" + event, code: 1)
        }
        func waitFor(_ source: String = "phone", actual: String, timeout: TimeInterval = 30) throws {
            let end = Date().addingTimeInterval(timeout)
            while Date() < end {
                if try record(source)?["actual"] as? String == actual { return }
                pause(0.1)
            }
            let state = try probe("state")
            let attachment = XCTAttachment(string: String(describing: state)); attachment.name = "listening-state-failure"; attachment.lifetime = .keepAlways; add(attachment)
            XCTFail("Expected \(source) actual \(actual)")
            throw NSError(domain: "ListeningUIJourney", code: 1)
        }
        let app = XCUIApplication(bundleIdentifier: "com.gomes.garrison")
        app.launchEnvironment = [
            "GARRISON_NODE_ORIGIN": shell, "GARRISON_NODE_NAME": "listening-proof",
            "GARRISON_CAPTURE_URL": base, "GARRISON_CAPTURE_TOKEN": token,
            "GARRISON_OPEN_PATH": "/", "GARRISON_LISTENING_UI_TEST": "1",
            "GARRISON_LISTENING_PROOF_CONTROL": control
        ]
        _ = try probe("unblock"); _ = try probe("reset-pushes")
        app.launch()
        let start = app.buttons["Start listening"].firstMatch
        XCTAssertTrue(start.waitForExistence(timeout: 45))
        device = try record()?["device_id"] as? String
        XCTAssertNotNil(device)
        let setupEvents = (try probe("state"))["hostEvents"] as? [[String: Any]] ?? []
        XCTAssertTrue(setupEvents.contains { $0["type"] as? String == "journey:fixture-ready" })
        let initialBackground = try eventCount("app-backgrounded")
        let initialForeground = try eventCount("app-foregrounded")
        XCUIApplication(bundleIdentifier: "com.apple.Preferences").activate()
        try waitForEvent("app-backgrounded", after: initialBackground)
        app.activate()
        try waitForEvent("app-foregrounded", after: initialForeground)
        XCTAssertTrue(start.waitForExistence(timeout: 15))
        _ = try probe("event/app-switch-before-capture")
        _ = try probe("event/start-home")
        start.tap()
        try waitFor(actual: "listening")
        XCTAssertTrue(app.links["Listening"].firstMatch.waitForExistence(timeout: 5))

        signal("interruption-began")
        try waitFor(actual: "interrupted")
        signal("interruption-ended")
        try waitFor(actual: "listening")
        _ = try probe("event/interruption-resumed")

        _ = try probe("cut")
        try waitFor(actual: "stalled", timeout: 25)
        let stalled = try probe("state")
        let pushes = try XCTUnwrap(stalled["pushes"] as? [[String: Any]])
        XCTAssertEqual(pushes.count, 1)
        XCTAssertEqual(pushes.first?["title"] as? String, "Zeca stopped listening")
        XCTAssertEqual(pushes.first?["body"] as? String, "The phone microphone stopped sending audio. Tap to resume.")
        XCTAssertEqual(pushes.first?["path"] as? String, "/capture?source=phone")
        XCTAssertTrue(app.staticTexts["Stopped listening"].firstMatch.waitForExistence(timeout: 5))

        let backgroundCount = try eventCount("app-backgrounded")
        let foregroundCount = try eventCount("app-foregrounded")
        let pingCount = try eventCount("native-ping")
        signal("native-ping")
        try waitForEvent("native-ping", after: pingCount)
        XCUIApplication(bundleIdentifier: "com.apple.Preferences").activate()
        try waitForEvent("app-backgrounded", after: backgroundCount)
        pause(3.0)
        _ = try probe("unblock")
        app.launchEnvironment.removeValue(forKey: "GARRISON_OPEN_PATH")
        app.open(URL(string: "garrison://open?path=%2Fcapture%3Fsource%3Dphone")!)
        try waitForEvent("app-foregrounded", after: foregroundCount)
        XCTAssertTrue(app.staticTexts["Capture"].firstMatch.waitForExistence(timeout: 15))
        try waitFor(actual: "listening")
        _ = try probe("event/deep-link-resumed")

        let previousSessions = Set((try probe("state"))["session_ids"] as? [String] ?? [])
        _ = try probe("cut")
        try waitFor(actual: "stalled", timeout: 25)
        _ = try probe("unblock")
        let resume = app.buttons["Resume"].firstMatch
        XCTAssertTrue(resume.waitForExistence(timeout: 5)); resume.tap()
        try waitFor(actual: "listening")
        var openedNewSession = false
        let sessionDeadline = Date().addingTimeInterval(5)
        while Date() < sessionDeadline && !openedNewSession {
            let resumedSessions = Set((try probe("state"))["session_ids"] as? [String] ?? [])
            openedNewSession = !resumedSessions.subtracting(previousSessions).isEmpty
            if !openedNewSession { pause(0.1) }
        }
        XCTAssertTrue(openedNewSession)
        _ = try probe("event/manual-resume")

        signal("pair-pendant")
        let pendantStart = app.buttons["Start listening"].firstMatch
        XCTAssertTrue(pendantStart.waitForExistence(timeout: 5)); pendantStart.tap()
        try waitFor("pendant", actual: "listening")
        try waitFor(actual: "off")
        let switchedPhoneIntent = try record()?["intent"] as? String
        XCTAssertEqual(switchedPhoneIntent, "off")
        _ = try probe("event/switched-to-pendant")
        app.buttons["Start listening"].firstMatch.tap()
        try waitFor(actual: "listening")
        try waitFor("pendant", actual: "off")
        _ = try probe("event/switched-to-phone")

        let stop = app.buttons["Hold to stop"].firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 5)); stop.press(forDuration: 1)
        let shortHoldIntent = try record()?["intent"] as? String
        XCTAssertEqual(shortHoldIntent, "listening")
        _ = try probe("event/short-hold-cancelled")
        stop.press(forDuration: 1.7)
        try waitFor(actual: "off")
        XCTAssertTrue(app.staticTexts["Not listening"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.links["Listening"].firstMatch.exists)
        let count = ((try probe("state"))["pushes"] as? [[String: Any]])?.count
        pause(25.0)
        let stoppedCount = ((try probe("state"))["pushes"] as? [[String: Any]])?.count
        XCTAssertEqual(stoppedCount, count)
        _ = try probe("event/stopped-without-push")
    }
}
