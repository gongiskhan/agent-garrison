import XCTest
import AVFoundation
@testable import GarrisonApp

@MainActor
final class ListeningRecoveryTests: XCTestCase {
    func testAudioSessionContract() {
        XCTAssertEqual(ListeningRecovery.category, .playAndRecord)
        XCTAssertEqual(ListeningRecovery.mode, .default)
        XCTAssertEqual(ListeningRecovery.options, [.mixWithOthers, .allowBluetoothA2DP, .defaultToSpeaker])
    }
    func testNotificationsDriveProductionController() async {
        let recovery = ListeningRecovery()
        let controller = CaptureController(recovery: recovery)
        var reports: [(String, String)] = []
        recovery.startEngine = {}
        recovery.pauseEngine = {}
        recovery.report = { reports.append(($0, $1)) }
        recovery.start()
        NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: nil,
            userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
        await Task.yield(); await Task.yield()
        XCTAssertEqual(recovery.actual, "interrupted")
        XCTAssertEqual(reports.last?.1, "interruption_began")
        NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: nil,
            userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue,
                AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume.rawValue])
        await Task.yield(); await Task.yield()
        XCTAssertEqual(recovery.actual, "listening")
        XCTAssertEqual(reports.last?.1, "interruption_ended_resumed")
        NotificationCenter.default.post(name: AVAudioSession.routeChangeNotification, object: nil,
            userInfo: [AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue])
        await Task.yield(); await Task.yield()
        XCTAssertEqual(reports.last?.1, "route_change")
        withExtendedLifetime(controller) {}
    }
    func testRetryScheduleAndGiveUpWithInjectedClock() {
        var date = Date(timeIntervalSince1970: 0)
        var queued: [(TimeInterval, @MainActor () -> Void)] = []
        var delays: [TimeInterval] = []
        let state = ListeningRecovery(now: { date }, schedule: { delay, block in queued.append((delay, block)); delays.append(delay) })
        state.startEngine = { throw NSError(domain: "test", code: 1) }
        state.start()
        while !queued.isEmpty {
            let next = queued.removeFirst(); date = date.addingTimeInterval(next.0); next.1()
        }
        XCTAssertEqual(Array(delays.prefix(6)), [2, 5, 15, 30, 60, 60])
        XCTAssertEqual(date.timeIntervalSince1970, 600)
        XCTAssertEqual(state.actual, "failed")
        XCTAssertTrue(state.intent)
    }
    func testNoResumeRetriesThenStopCancelsQueuedAttempt() {
        var queued: [@MainActor () -> Void] = []
        var starts = 0
        let state = ListeningRecovery(schedule: { _, block in queued.append(block) })
        state.startEngine = { starts += 1 }
        state.start()
        state.interruption(Notification(name: AVAudioSession.interruptionNotification,
            userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue]))
        XCTAssertEqual(state.actual, "interrupted")
        XCTAssertEqual(queued.count, 1)
        state.stop(); queued.removeFirst()()
        XCTAssertEqual(starts, 1)
        XCTAssertEqual(state.actual, "off")
    }
    func testDuplicateNoResumeNotificationsDoNotCreateCompetingRetries() {
        var queued: [@MainActor () -> Void] = []
        var starts = 0
        let state = ListeningRecovery(schedule: { _, block in queued.append(block) })
        state.startEngine = { starts += 1 }
        state.start()
        let ended = Notification(name: AVAudioSession.interruptionNotification,
            userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue])
        state.interruption(ended); state.interruption(ended)
        for retry in queued { retry() }
        XCTAssertEqual(starts, 2)
    }
    func testMediaResetRebuildsAndForegroundRetriesImmediately() {
        let state = ListeningRecovery()
        var rebuilds = 0
        var reason = ""
        state.rebuildEngine = { rebuilds += 1 }
        state.report = { _, r in reason = r }
        state.start(); state.mediaReset()
        XCTAssertEqual(rebuilds, 1); XCTAssertEqual(reason, "media_services_reset")
        state.transition("failed", "resume_gave_up"); state.foreground()
        XCTAssertEqual(state.actual, "listening"); XCTAssertEqual(reason, "resume_on_foreground")
    }
    func testSnapshotRetainsExplicitNullFields() throws {
        let state = DeviceListeningState(device_id: "test", device_name: "iPhone", source: "phone", intent: "off", actual: "off", reason: nil, last_seen_at: nil, intent_changed_at: "now", actual_changed_at: "now", stall_episode_id: nil, stall_pushes_sent: 0, app_version: "1")
        for key in ["reason", "last_seen_at", "stall_episode_id"] { XCTAssertTrue(state.payload[key] is NSNull) }
    }
    func testPendingStopPreventsForegroundResumeUntilAcknowledgedOrRestarted() throws {
        let savedDefaults = AppGroup.defaults
        AppGroup.defaults = UserDefaults(suiteName: "listening-stop-\(UUID().uuidString)")
        AppGroup.defaults?.set("http://127.0.0.1:1", forKey: AppGroup.Key.baseURL)
        AppGroup.defaults?.set("isolated-test", forKey: AppGroup.Key.token)
        let phone = CaptureController.shared
        phone.stopForServer(reason: "user_stop")
        var starts = 0
        defer {
            phone.stopForServer(reason: "user_stop")
            AppGroup.defaults = savedDefaults
        }
        let channel = ListeningChannel(startPhone: { _ in starts += 1 })
        channel.intent("phone", "off")
        let device = try XCTUnwrap(channel.deviceId)
        func record(_ intent: String, at: String) -> DeviceListeningState {
            DeviceListeningState(device_id: device, device_name: "iPhone", source: "phone", intent: intent, actual: "interrupted", reason: "user_start", last_seen_at: nil, intent_changed_at: at, actual_changed_at: at, stall_episode_id: nil, stall_pushes_sent: 0, app_version: "1")
        }
        channel.receive(record("listening", at: "1")); channel.foreground()
        XCTAssertEqual(starts, 0, "A stale server intent must not undo a queued Stop")
        channel.intent("phone", "listening"); channel.foreground()
        XCTAssertEqual(starts, 1, "An explicit new Start supersedes the pending Stop")
        channel.intent("phone", "off"); phone.stopForServer(reason: "user_stop")
        channel.receive(record("off", at: "2"))
        channel.receive(record("listening", at: "3")); channel.foreground()
        XCTAssertGreaterThan(starts, 1, "After acknowledgement a fresh server intent can resume")
    }
    func testWakeProtocolAndGeneratedTone() {
        let message = ServerMessage.parse("{\"type\":\"wake.detected\",\"device_id\":\"device\",\"source\":\"phone\",\"at\":\"2026-09-11T12:00:00Z\"}")
        guard case .wakeDetected(_, let source, let at) = message else { return XCTFail("wake message missing") }
        XCTAssertEqual(source, "phone")
        let tone = WakeAcknowledgement(); tone.play(at: at)
        XCTAssertEqual(tone.invocations, 1)
        XCTAssertEqual(WakeAcknowledgement.wave().count, 7244)
    }
}
