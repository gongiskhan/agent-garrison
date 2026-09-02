import Capacitor
import Combine
import Foundation

/// The wearable for the page. The pendant belongs to the APP (it must
/// outlive any screen: the link used to die when a view that owned the
/// controller went away), so this plugin only observes and commands
/// `PendantController.shared` and never builds a controller of its own. It
/// also never connects on its own: the app reconnects a known pendant on
/// launch and foreground, and a page load is neither.
final class GarrisonPendantPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GarrisonPendant"
    let jsName = "GarrisonPendant"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
    ]

    /// Scan -> connecting -> connected arrive within one runloop turn on a
    /// warm reconnect; one event per burst is all the page can show.
    private static let minEmitInterval: TimeInterval = 0.15

    private var cancellables: Set<AnyCancellable> = []
    private var emitScheduled = false
    private var lastEmitAt = Date.distantPast

    /// Runs once after registration, when notifyListeners can reach the page.
    override func load() {
        Task { @MainActor in
            let pendant = PendantController.shared
            // @Published fires on willSet; the Task hop in each sink lands after
            // the write so the payload carries the NEW value.
            pendant.$connectionState
                .sink { [weak self] _ in Task { @MainActor in self?.scheduleStateEmit() } }
                .store(in: &self.cancellables)
            pendant.$sessionId
                .sink { [weak self] _ in Task { @MainActor in self?.scheduleStateEmit() } }
                .store(in: &self.cancellables)
            pendant.$uploaderState
                .sink { [weak self] _ in Task { @MainActor in self?.scheduleStateEmit() } }
                .store(in: &self.cancellables)
            pendant.$battery
                .dropFirst()
                .removeDuplicates()
                .sink { [weak self] battery in
                    guard let battery else { return }
                    self?.notifyListeners("pendantBattery", data: ["battery": battery])
                }
                .store(in: &self.cancellables)
        }
    }

    // MARK: - Methods

    @objc func status(_ call: CAPPluginCall) {
        Task { @MainActor in
            call.resolve(self.statusPayload())
        }
    }

    @objc func connect(_ call: CAPPluginCall) {
        Task { @MainActor in
            PendantController.shared.connect()
            call.resolve(self.statusPayload())
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        Task { @MainActor in
            PendantController.shared.disconnect()
            call.resolve(self.statusPayload())
        }
    }

    /// Drops the pairing this device remembers, so launch and foreground stop
    /// reconnecting to it. The next connect() is a deliberate first pairing.
    @objc func forget(_ call: CAPPluginCall) {
        Task { @MainActor in
            PendantController.shared.disconnect()
            AppGroup.pendantIdentifier = nil
            call.resolve(self.statusPayload())
        }
    }

    // MARK: - Payload and events

    @MainActor
    private func statusPayload() -> [String: Any] {
        let pendant = PendantController.shared
        var payload: [String: Any] = [
            "connectionState": Self.connectionName(pendant.connectionState),
            "paired": AppGroup.pendantIdentifier != nil,
            "lostFrames": pendant.lostFrames,
            "ambientConsent": AppGroup.pendantAmbientConsent,
        ]
        switch pendant.uploaderState {
        case .idle: payload["uploaderState"] = "idle"
        case .connecting: payload["uploaderState"] = "connecting"
        case .streaming: payload["uploaderState"] = "streaming"
        case .ended: payload["uploaderState"] = "ended"
        case .failed(let message):
            payload["uploaderState"] = "failed"
            payload["uploaderError"] = message
        }
        if let battery = pendant.battery { payload["battery"] = battery }
        if let sessionId = pendant.sessionId { payload["sessionId"] = sessionId }
        if let hapticSupported = pendant.hapticSupported { payload["hapticSupported"] = hapticSupported }
        if let capturePolicy = pendant.capturePolicy { payload["capturePolicy"] = capturePolicy }
        if let pendantFlagOn = pendant.pendantFlagOn { payload["pendantFlagOn"] = pendantFlagOn }
        return payload
    }

    /// The enum case names as written, so the page and the Swift source
    /// share one vocabulary and a renamed case breaks loudly here.
    private static func connectionName(_ state: PendantConnectionState) -> String {
        switch state {
        case .disconnected: return "disconnected"
        case .scanning: return "scanning"
        case .connecting: return "connecting"
        case .connected: return "connected"
        case .reconnecting: return "reconnecting"
        case .pairingLost: return "pairingLost"
        case .bluetoothOff: return "bluetoothOff"
        }
    }

    @MainActor
    private func scheduleStateEmit() {
        guard !emitScheduled else { return }
        emitScheduled = true
        let wait = max(0, Self.minEmitInterval - Date().timeIntervalSince(lastEmitAt))
        Task { @MainActor [weak self] in
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            guard let self else { return }
            self.emitScheduled = false
            self.lastEmitAt = Date()
            self.notifyListeners("pendantState", data: self.statusPayload())
        }
    }
}
