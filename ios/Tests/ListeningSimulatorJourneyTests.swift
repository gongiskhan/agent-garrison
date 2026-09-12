import XCTest
import AVFoundation
@testable import GarrisonApp

@MainActor
final class ListeningSimulatorJourneyTests: XCTestCase {
    func testNativeFramesInterruptionResumeHeartbeatAndWake() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let base = env["GARRISON_LISTENING_PROOF_URL"], base.hasPrefix("http://127.0.0.1:"),
              let control = env["GARRISON_LISTENING_PROOF_CONTROL"] else { throw XCTSkip("Run the phone listening validation workflow for the local-node journey") }
        let saved = AppGroup.defaults
        AppGroup.defaults = UserDefaults(suiteName: "listening-journey-\(UUID().uuidString)")
        defer { CaptureController.shared.stop(); AppGroup.defaults = saved }
        AppGroup.defaults?.set(base, forKey: AppGroup.Key.baseURL)
        AppGroup.defaults?.set(env["GARRISON_LISTENING_PROOF_TOKEN"], forKey: AppGroup.Key.token)
        AppGroup.consentSuppressed = true
        let channel = ListeningChannel.shared
        channel.connect()
        XCTAssertNil(channel.error, "Listening connection: \(channel.error ?? "none")")
        XCTAssertNotNil(channel.deviceId, "Keychain identity must be available")
        try await wait { channel.records["phone"] != nil }
        channel.intent("phone", "listening")
        // Simulator Core Audio can spend over twelve seconds configuring its
        // first input device. Interruption recovery keeps its two-second bound.
        try await wait(timeout: 30) { CaptureController.shared.engineRunning && channel.records["phone"]?.actual == "listening" }
        let device = try XCTUnwrap(channel.deviceId)
        func probe(_ route: String = "state") async throws -> [String: Any] {
            let url = try XCTUnwrap(URL(string: "\(control)/\(route)?device=\(device)"))
            let (data, _) = try await URLSession.shared.data(from: url)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        try await Task.sleep(nanoseconds: 6_000_000_000)
        let state = try await probe()
        XCTAssertGreaterThan(state["frames"] as? Int ?? 0, 0)
        XCTAssertGreaterThan(state["heartbeats"] as? Int ?? 0, 0)
        NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: nil,
            userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
        try await wait { channel.records["phone"]?.actual == "interrupted" }
        XCTAssertEqual(channel.records["phone"]?.reason, "interruption_began")
        let started = Date()
        NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: nil,
            userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue,
                AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume.rawValue])
        try await wait(timeout: 2) { channel.records["phone"]?.actual == "listening" }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        let toneCount = CaptureController.shared.wakeAcknowledgementInvocations
        _ = try await probe("wake")
        try await wait(timeout: 1) { CaptureController.shared.wakeAcknowledgementInvocations > toneCount }
        channel.intent("phone", "off")
        try await wait { channel.records["phone"]?.intent == "off" && !CaptureController.shared.engineRunning }
    }
    func testSpeechInterruptionTravelsThroughTheNativeSocketAndCancelsLatePlayback() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let base = env["GARRISON_LISTENING_PROOF_URL"], base.hasPrefix("http://127.0.0.1:"),
              let control = env["GARRISON_LISTENING_PROOF_CONTROL"] else { throw XCTSkip("Run the simulator validation workflow") }
        let saved = AppGroup.defaults
        AppGroup.defaults = UserDefaults(suiteName: "voice-journey-\(UUID().uuidString)")
        AppGroup.defaults?.set(base, forKey: AppGroup.Key.baseURL)
        AppGroup.defaults?.set(env["GARRISON_LISTENING_PROOF_TOKEN"], forKey: AppGroup.Key.token)
        let clips = SpeechSinkTests.DeferredClipPlayer()
        let utterer = FakeUtterer()
        let sink = SpeechSink(utterer: utterer, clipPlayer: clips, defaults: AppGroup.defaults!)
        let controller = CaptureController(speechSink: sink)
        defer { controller.stop(); AppGroup.defaults = saved }
        controller.start(consent: .shown)
        try await wait(timeout: 30) { controller.engineRunning && controller.ackedFrames > 0 }
        let session = try XCTUnwrap(controller.sessionId)
        func probe(_ route: String) async throws -> [String: Any] {
            let url = try XCTUnwrap(URL(string: "\(control)/\(route)?session=\(session)"))
            let (data, _) = try await URLSession.shared.data(from: url)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        _ = try await probe("voice-play")
        try await wait { clips.paths.count == 1 }
        _ = try await probe("voice-interrupt")
        try await wait { clips.stops == 1 }
        clips.finish(false)
        XCTAssertTrue(utterer.spoken.isEmpty, "late downloads cannot restart speech")
        try await Task.sleep(nanoseconds: 300_000_000)
        let state = try await probe("state")
        let receipts = state["speechReceipts"] as? [[String: Any]] ?? []
        XCTAssertTrue(receipts.contains { $0["sessionId"] as? String == session && $0["reason"] as? String == "user-speech" })
    }

    private func wait(timeout: TimeInterval = 12, until condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end { if condition() { return }; try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(condition(), "Native journey condition did not arrive")
        if !condition() { throw NSError(domain: "ListeningJourney", code: 1) }
    }
}
