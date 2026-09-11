import AVFoundation
import Foundation

@MainActor
final class ListeningRecovery {
    static let category: AVAudioSession.Category = .playAndRecord
    static let mode: AVAudioSession.Mode = .default
    static let options: AVAudioSession.CategoryOptions = [.mixWithOthers, .allowBluetoothA2DP, .defaultToSpeaker]
    private(set) var intent = false
    private(set) var actual = "off"
    private var retryIndex = 0
    private var began: Date?
    private var generation = 0
    let now: () -> Date
    let schedule: (TimeInterval, @escaping @MainActor () -> Void) -> Void
    var startEngine: () throws -> Void = {}
    var pauseEngine: () -> Void = {}
    var rebuildEngine: () -> Void = {}
    var report: (String, String) -> Void = { _, _ in }

    init(now: @escaping () -> Date = Date.init,
         schedule: @escaping (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, block in
             Task { @MainActor in try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)); block() }
         }) {
        self.now = now
        self.schedule = schedule
    }
    func transition(_ actual: String, _ reason: String) { self.actual = actual; report(actual, reason) }
    func start(reason: String = "user_start") {
        intent = true
        generation += 1
        began = nil
        retryIndex = 0
        attempt(reason)
    }
    func stop(reason: String = "user_stop") {
        intent = false
        generation += 1
        pauseEngine()
        transition("off", reason)
    }
    func attempt(_ reason: String) {
        guard intent else { return }
        transition("starting", reason)
        do {
            try startEngine()
            generation += 1
            began = nil
            retryIndex = 0
            transition("listening", reason)
        } catch {
            pauseEngine()
            transition("interrupted", "engine_error")
            retry()
        }
    }
    func retry() {
        guard intent else { return }
        if began == nil { began = now() }
        let remaining = TimeInterval(ListeningConstants.RESUME_GIVE_UP_MINUTES * 60) - now().timeIntervalSince(began!)
        if remaining <= 0 { transition("failed", "resume_gave_up"); return }
        let delays = ListeningConstants.RESUME_RETRY_SCHEDULE_SECONDS
        let delay = min(remaining, delays[min(retryIndex, delays.count - 1)])
        retryIndex += 1
        let expected = generation
        schedule(delay) { [weak self] in
            guard let self, self.intent, self.generation == expected else { return }
            if self.now().timeIntervalSince(self.began ?? self.now()) >= TimeInterval(ListeningConstants.RESUME_GIVE_UP_MINUTES * 60) {
                self.transition("failed", "resume_gave_up")
            } else { self.attempt("resume_retry") }
        }
    }
    func interruption(_ notification: Notification) {
        guard intent, let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            generation += 1
            pauseEngine()
            transition("interrupted", "interruption_began")
        } else {
            let options = AVAudioSession.InterruptionOptions(rawValue: notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            if options.contains(.shouldResume) { attempt("interruption_ended_resumed") }
            else { transition("interrupted", "interruption_ended_no_resume"); retry() }
        }
    }
    func routeChange(_ notification: Notification) {
        guard intent, let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
              reason == .oldDeviceUnavailable || reason == .newDeviceAvailable else { return }
        generation += 1
        pauseEngine()
        attempt("route_change")
    }
    func mediaReset() {
        guard intent else { return }
        generation += 1
        pauseEngine()
        rebuildEngine()
        attempt("media_services_reset")
    }
    func foreground() {
        if intent && actual != "listening" { start(reason: "resume_on_foreground") }
    }
}
