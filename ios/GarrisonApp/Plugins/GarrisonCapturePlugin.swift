import AVFoundation
import Capacitor
import Combine
import ReplayKit
import SwiftUI
import UIKit

/// Microphone capture and the screen broadcast for the page. The capture
/// engine is native (CaptureController owns the audio session, the encoder
/// and the upload); the broadcast runs in the upload extension's process and
/// is only observable through the App Group heartbeat. Both surface here as
/// one `status()` shape and one `captureState` event, so the page renders a
/// single "what can Zeca hear and see right now" from one source.
final class GarrisonCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GarrisonCapture"
    let jsName = "GarrisonCapture"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setConsentSuppressed", returnType: CAPPluginReturnPromise),
    ]

    /// The system sheet needs ~10 s of user interaction on a slow day; 30 s
    /// bounds a promise the page would otherwise await forever.
    private static let broadcastStartTimeoutSeconds = 30
    /// Phase flips (connecting -> live, ack counter ticks) arrive in bursts;
    /// one event per burst is what the page can render anyway.
    private static let minEmitInterval: TimeInterval = 0.15

    private let controller: CaptureController
    private let consentPresenter: ConsentPresenter
    private var cancellables: Set<AnyCancellable> = []
    private var broadcastPoll: Task<Void, Never>?
    private var emitScheduled = false
    private var lastEmitAt = Date.distantPast
    private var lastBroadcastEmitted: (broadcasting: Bool, error: String?)?

    /// Main actor: CaptureController's init is, and the plugin is created from
    /// capacitorDidLoad() on main. Plugin CALLS run on the bridge's queue and
    /// hop to main per method below.
    @MainActor
    init(controller: CaptureController) {
        self.controller = controller
        self.consentPresenter = ConsentPresenter()
        super.init()
    }

    deinit {
        // Task.cancel is thread-safe; a Timer would have to be invalidated on
        // the run loop that installed it, and deinit makes no such promise.
        broadcastPoll?.cancel()
    }

    /// Runs once after registration. Event wiring lives here, not in init,
    /// because notifyListeners needs the bridge, which is attached after init.
    override func load() {
        Task { @MainActor in
            self.controller.$phase
                .sink { [weak self] _ in Task { @MainActor in self?.scheduleEmit() } }
                .store(in: &self.cancellables)
            self.controller.$sessionId
                .sink { [weak self] _ in Task { @MainActor in self?.scheduleEmit() } }
                .store(in: &self.cancellables)
            self.controller.$ackedFrames
                .sink { [weak self] _ in Task { @MainActor in self?.scheduleEmit() } }
                .store(in: &self.cancellables)
            // The heartbeat is written by another process; nothing here can
            // observe it, so it is polled. Emits only on change, and the loop
            // ends by itself once the plugin is gone.
            self.broadcastPoll = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard let self else { return }
                    self.emitIfBroadcastChanged()
                }
            }
        }
    }

    // MARK: - Methods

    @objc func status(_ call: CAPPluginCall) {
        Task { @MainActor in
            call.resolve(self.statusPayload())
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let kind = call.getString("kind") ?? "microphone"
        switch kind {
        case "microphone":
            Task { @MainActor in self.startMicrophone(call) }
        case "screen_audio":
            Task { @MainActor in self.startBroadcast(call) }
        default:
            call.reject("kind must be microphone or screen_audio", "BAD_KIND")
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        let kind = call.getString("kind") ?? "microphone"
        switch kind {
        case "microphone":
            Task { @MainActor in
                self.controller.stop()
                call.resolve(self.statusPayload())
            }
        case "screen_audio":
            // The system sheet is the only way to end a broadcast: present it
            // and answer at once; the heartbeat going stale reports the end.
            Task { @MainActor in
                guard let hostView = self.bridge?.viewController?.view else {
                    call.reject("no host view to present the broadcast picker from", "NO_HOST")
                    return
                }
                let picker = self.triggerBroadcastPicker(in: hostView)
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: UInt64(Self.broadcastStartTimeoutSeconds) * 1_000_000_000)
                    picker?.removeFromSuperview()
                }
                call.resolve(self.statusPayload())
            }
        default:
            call.reject("kind must be microphone or screen_audio", "BAD_KIND")
        }
    }

    @objc func consent(_ call: CAPPluginCall) {
        call.resolve(["suppressed": AppGroup.consentSuppressed])
    }

    @objc func setConsentSuppressed(_ call: CAPPluginCall) {
        guard let suppressed = call.getBool("suppressed") else {
            call.reject("suppressed must be a boolean", "BAD_ARGS")
            return
        }
        AppGroup.consentSuppressed = suppressed
        call.resolve(["suppressed": suppressed])
    }

    // MARK: - Microphone

    @MainActor
    private func startMicrophone(_ call: CAPPluginCall) {
        guard AppGroup.baseURL != nil, AppGroup.token != nil else {
            call.reject("no node selected: capture URL and token are unset", "NO_NODE")
            return
        }
        guard !controller.isRunning, !consentPresenter.isPresenting else {
            call.reject("capture is already running", "ALREADY_RUNNING")
            return
        }
        if AppGroup.consentSuppressed {
            controller.start(consent: .suppressed)
            call.resolve(statusPayload())
            return
        }
        guard let presenter = bridge?.viewController else {
            call.reject("no host view controller to present the consent sheet from", "NO_HOST")
            return
        }
        consentPresenter.present(over: presenter) { [weak self] consent in
            guard let self else { return }
            guard let consent else {
                call.reject("consent declined", "CONSENT_DECLINED")
                return
            }
            self.controller.start(consent: consent)
            call.resolve(self.statusPayload())
        }
    }

    // MARK: - Screen broadcast

    @MainActor
    private func startBroadcast(_ call: CAPPluginCall) {
        guard !AppGroup.isBroadcasting() else {
            call.reject("screen broadcast is already running", "ALREADY_RUNNING")
            return
        }
        guard let hostView = bridge?.viewController?.view else {
            call.reject("no host view to present the broadcast picker from", "NO_HOST")
            return
        }
        guard let picker = triggerBroadcastPicker(in: hostView) else {
            call.reject("the system broadcast picker exposed no button to trigger", "BROADCAST_NOT_STARTED")
            return
        }
        // Only an error stamped AFTER this attempt explains this attempt; an
        // hour-old refusal would otherwise be blamed for a plain cancel.
        let attemptStart = Date().addingTimeInterval(-1)
        Task { @MainActor [weak self] in
            defer { picker.removeFromSuperview() }
            for _ in 0 ..< Self.broadcastStartTimeoutSeconds {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if AppGroup.isBroadcasting() {
                    call.resolve(self?.statusPayload() ?? [:])
                    return
                }
            }
            var message = "screen broadcast did not start"
            if let failure = AppGroup.broadcastError(), failure.1 >= attemptStart {
                message += ": \(failure.0)"
            }
            call.reject(message, "BROADCAST_NOT_STARTED")
        }
    }

    /// RPSystemBroadcastPickerView has no API to open the system sheet; the
    /// documented shape is a button the user taps. The page's button IS the
    /// user's tap, so the picker is added off-screen and its button's action
    /// fired. The picker must stay in the hierarchy while the sheet is up.
    @MainActor
    private func triggerBroadcastPicker(in hostView: UIView) -> RPSystemBroadcastPickerView? {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 60, height: 60))
        picker.preferredExtension = BroadcastPicker.extensionBundleID
        picker.showsMicrophoneButton = true
        picker.isHidden = true
        hostView.addSubview(picker)
        guard let button = picker.subviews.compactMap({ $0 as? UIButton }).first else {
            picker.removeFromSuperview()
            return nil
        }
        button.sendActions(for: .touchUpInside)
        return picker
    }

    // MARK: - Payload and events

    @MainActor
    private func statusPayload() -> [String: Any] {
        var payload: [String: Any] = [
            "ackedFrames": controller.ackedFrames,
            "broadcasting": AppGroup.isBroadcasting(),
            "microphone": Self.microphoneState(),
            "consentSuppressed": AppGroup.consentSuppressed,
        ]
        switch controller.phase {
        case .idle: payload["phase"] = "idle"
        case .connecting: payload["phase"] = "connecting"
        case .live: payload["phase"] = "live"
        case .interrupted: payload["phase"] = "interrupted"
        case .failed(let message):
            payload["phase"] = "failed"
            payload["error"] = message
        }
        if let sessionId = controller.sessionId { payload["sessionId"] = sessionId }
        if let startedAt = controller.startedAt { payload["startedAt"] = startedAt.timeIntervalSince1970 * 1000 }
        if let failure = AppGroup.broadcastError() { payload["broadcastError"] = failure.0 }
        return payload
    }

    private static func microphoneState() -> String {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "undetermined"
        }
    }

    /// @Published fires on willSet, so a sink sees the OLD value; the Task hop
    /// in each sink lands after the write. Bursts coalesce here.
    @MainActor
    private func scheduleEmit() {
        guard !emitScheduled else { return }
        emitScheduled = true
        let wait = max(0, Self.minEmitInterval - Date().timeIntervalSince(lastEmitAt))
        Task { @MainActor [weak self] in
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            guard let self else { return }
            self.emitScheduled = false
            self.emitState()
        }
    }

    @MainActor
    private func emitState() {
        lastEmitAt = Date()
        let payload = statusPayload()
        lastBroadcastEmitted = (payload["broadcasting"] as? Bool ?? false, payload["broadcastError"] as? String)
        notifyListeners("captureState", data: payload)
    }

    @MainActor
    private func emitIfBroadcastChanged() {
        let now = (AppGroup.isBroadcasting(), AppGroup.broadcastError()?.0)
        guard let last = lastBroadcastEmitted else {
            lastBroadcastEmitted = now
            return
        }
        if last.broadcasting != now.0 || last.error != now.1 {
            emitState()
        }
    }
}

// MARK: - Consent sheet presenter

/// Presents the existing ConsentSheet over the bridge and turns its three
/// exits (proceed, cancel, swipe-down) into exactly one callback. A promise
/// that never settles is the one failure the page cannot recover from, and
/// a swipe-down is neither button.
@MainActor
private final class ConsentPresenter: NSObject, UIAdaptivePresentationControllerDelegate {
    private var finish: (@MainActor (ConsentState?) -> Void)?

    var isPresenting: Bool { finish != nil }

    func present(over presenter: UIViewController, completion: @escaping @MainActor (ConsentState?) -> Void) {
        finish = completion
        let hosting = UIHostingController(rootView: ConsentSheet(onProceed: { _ in }, onCancel: {}))
        hosting.rootView = ConsentSheet(
            onProceed: { [weak self, weak hosting] consent in
                hosting?.dismiss(animated: true)
                self?.settle(consent)
            },
            onCancel: { [weak self, weak hosting] in
                hosting?.dismiss(animated: true)
                self?.settle(nil)
            }
        )
        hosting.modalPresentationStyle = .pageSheet
        hosting.sheetPresentationController?.detents = [.medium()]
        hosting.presentationController?.delegate = self
        presenter.present(hosting, animated: true)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        settle(nil)
    }

    private func settle(_ consent: ConsentState?) {
        guard let done = finish else { return }
        finish = nil
        done(consent)
    }
}
