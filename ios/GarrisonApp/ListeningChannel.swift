import Foundation
import SwiftUI
import UIKit

// App-lifetime view of server records, delivered through the existing uploader.
// No durable local intent. After process death the server is read again.
@MainActor
final class ListeningChannel: ObservableObject {
    static let shared = ListeningChannel()
    @Published private(set) var records: [String: DeviceListeningState] = [:]
    @Published private(set) var error: String?
    @Published private(set) var notice: String?
    private var uploader: CaptureUploader?
    private var endpoint: URL?
    private var pending: [(String, String)] = []
    // A transient user request must win over a stale server snapshot while
    // Stop is queued or in flight. No intent is persisted on the device.
    private var pendingStops = Set<String>()
    private var pendingReports: [String: ListeningMessage] = [:]
    private var ready = false
    private let startPhone: @MainActor (String) -> Void
    private(set) var deviceId: String?
    var pendant: PendantController { GarrisonPendantPlugin.controllerOverride ?? PendantController.shared }
    var onRecord: ((DeviceListeningState) -> Void)?

    init(startPhone: @escaping @MainActor (String) -> Void = { CaptureController.shared.beginListening(reason: $0) }) {
        self.startPhone = startPhone
    }

    func connect() {
        guard let base = AppGroup.baseURL, let token = AppGroup.token else { return }
        if uploader != nil && endpoint == base { return }
        do { deviceId = try ListeningIdentity.load() } catch { self.error = error.localizedDescription; return }
        uploader?.abandon()
        records = [:]
        ready = false
        endpoint = base
        let id = SessionId.generate()
        let socket = CaptureUploader(baseURL: base, token: token, sessionId: id, mode: .audio,
            deviceName: UIDevice.current.name, consent: .suppressed, spoolDirectory: AppGroup.spoolDirectory(sessionId: id))
        socket.deviceId = deviceId
        socket.controlOnly = true
        socket.onStateChange = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                self.ready = state == .streaming
                if self.ready {
                    let queued = self.pending; self.pending = []
                    for (source, intent) in queued { self.intent(source, intent) }
                    for source in Array(self.pendingStops) where !queued.contains(where: { $0.0 == source && $0.1 == "off" }) { self.intent(source, "off") }
                    let reports = self.pendingReports; self.pendingReports = [:]
                    for report in reports.values { self.uploader?.sendListening(report) }
                    for record in Array(self.records.values) where record.intent == "off" && record.actual != "off" { self.receive(record) }
                }
            }
        }
        socket.onListeningState = { [weak self] record in Task { @MainActor in self?.receive(record) } }
        uploader = socket
        socket.connect()
    }
    func receive(_ record: DeviceListeningState) {
        guard record.device_id == deviceId else { return }
        let previous = records[record.source]
        records[record.source] = record
        if record.intent == "off" { pendingStops.remove(record.source) }
        if record.reason == "watchdog_recovered" && previous?.reason != record.reason { toast("Listening again") }
        if record.reason == "source_switch" && previous?.intent == "listening" {
            toast(record.source == "phone" ? "Switched from phone to pendant" : "Switched from pendant to phone")
        }
        onRecord?(record)
        if record.intent == "listening" && pendingStops.contains(record.source) { return }
        if record.source == "phone" {
            let controller = CaptureController.shared
            if record.intent == "off" {
                if controller.isRunning || controller.recovery.intent { controller.stopForServer(reason: record.reason ?? "user_stop") }
                else if record.actual != "off" { report(source: "phone", actual: "off", reason: record.reason == "source_switch" ? "source_switch" : "user_stop") }
            } else if UIApplication.shared.applicationState == .active && (previous == nil || (record.intent_changed_at != previous?.intent_changed_at && record.reason == "user_start")) {
                startPhone(record.reason == "user_start" ? "user_start" : "resume_on_foreground")
            }
        } else if record.intent == "off" {
            if pendant.connectionState != .disconnected || pendant.sessionId != nil { pendant.disconnect() }
            else if record.actual != "off" { report(source: "pendant", actual: "off", reason: record.reason == "source_switch" ? "source_switch" : "user_stop") }
        } else if record.intent == "listening" && (previous == nil || (record.intent_changed_at != previous?.intent_changed_at && record.reason == "user_start")) {
            pendant.connect()
        }
    }
    func intent(_ source: String, _ intent: String) {
        if intent == "off" { pendingStops.insert(source) } else { pendingStops.remove(source) }
        connect()
        guard let deviceId else { return }
        guard ready else { pending.append((source, intent)); return }
        uploader?.sendListening(ListeningMessage(type: "listening.intent", device_id: deviceId, source: source, intent: intent))
    }
    func report(source: String, actual: String, reason: String) {
        guard let deviceId else { return }
        let message = ListeningMessage(type: "listening.transition", device_id: deviceId, source: source, actual: actual, reason: reason)
        guard ready else { pendingReports[source] = message; return }
        uploader?.sendListening(message)
    }
    func terminating() {
        for record in records.values where record.intent == "listening" { report(source: record.source, actual: "interrupted", reason: "app_terminated") }
    }
    func foreground() {
        connect()
        if records["pendant"]?.intent == "listening" && !pendingStops.contains("pendant") { pendant.reconnectIfNeeded() }
        if records["phone"]?.intent == "listening" && !pendingStops.contains("phone") {
            if !CaptureController.shared.recovery.intent || records["phone"]?.actual == "stalled" { startPhone("resume_on_foreground") }
            else { CaptureController.shared.recovery.foreground() }
        }
    }
    func toast(_ message: String) {
        notice = message
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if self.notice == message { self.notice = nil }
        }
    }
}
