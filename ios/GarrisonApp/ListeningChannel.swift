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
    private var ready = false
    private(set) var deviceId: String?
    var pendant: PendantController { GarrisonPendantPlugin.controllerOverride ?? PendantController.shared }
    var onRecord: ((DeviceListeningState) -> Void)?

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
                if self.ready { let queued = self.pending; self.pending = []; for (source, intent) in queued { self.intent(source, intent) } }
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
        if record.reason == "watchdog_recovered" && previous?.reason != record.reason { toast("Listening again") }
        if record.reason == "source_switch" && previous?.intent == "listening" {
            toast(record.source == "phone" ? "Switched from phone to pendant" : "Switched from pendant to phone")
        }
        onRecord?(record)
        if record.source == "phone" {
            let controller = CaptureController.shared
            if record.intent == "off" {
                if controller.isRunning || controller.recovery.intent { controller.stopForServer(reason: record.reason ?? "user_stop") }
            } else if !controller.recovery.intent && UIApplication.shared.applicationState == .active && (previous == nil || (record.intent_changed_at != previous?.intent_changed_at && record.reason == "user_start")) {
                controller.beginListening(reason: record.reason == "user_start" ? "user_start" : "resume_on_foreground")
            }
        } else if record.intent == "off" {
            if pendant.connectionState != .disconnected || pendant.sessionId != nil { pendant.disconnect() }
        } else if record.intent == "listening" && (previous == nil || (record.intent_changed_at != previous?.intent_changed_at && record.reason == "user_start")) {
            pendant.connect()
        }
    }
    func intent(_ source: String, _ intent: String) {
        connect()
        guard let deviceId else { return }
        guard ready else { pending.append((source, intent)); return }
        uploader?.sendListening(ListeningMessage(type: "listening.intent", device_id: deviceId, source: source, intent: intent))
        if source == "phone" && intent == "listening" && CaptureController.shared.recovery.intent && !CaptureController.shared.engineRunning { CaptureController.shared.recovery.start() }
    }
    func report(source: String, actual: String, reason: String) {
        guard let deviceId else { return }
        uploader?.sendListening(ListeningMessage(type: "listening.transition", device_id: deviceId, source: source, actual: actual, reason: reason))
    }
    func terminating() {
        for record in records.values where record.intent == "listening" { report(source: record.source, actual: "interrupted", reason: "app_terminated") }
    }
    func foreground() {
        connect()
        if records["pendant"]?.intent == "listening" { pendant.reconnectIfNeeded() }
        if records["phone"]?.intent == "listening" {
            if !CaptureController.shared.recovery.intent || records["phone"]?.actual == "stalled" { CaptureController.shared.beginListening(reason: "resume_on_foreground") }
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
