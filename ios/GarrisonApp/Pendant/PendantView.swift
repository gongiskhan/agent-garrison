import SwiftUI

/// The pendant session screen: connection state, battery, capture policy
/// indicator, the live feedback strip (every tier event as it happens, so
/// quality and latency are never invisible), and the live transcript
/// streaming from the capture service's SSE feed.
struct PendantView: View {
    // The controller OUTLIVES this view (PendantController.shared): leaving the
    // screen must not disconnect the wearable. Observed, never owned.
    @ObservedObject private var controller = PendantController.shared
    @StateObject private var transcript = TranscriptStream()
    @State private var showAmbientConsent = false

    var body: some View {
        List {
            Section {
                statusRow
                if let battery = controller.battery {
                    LabeledContent("Battery", value: "\(battery)%")
                }
                if let supported = controller.hapticSupported {
                    LabeledContent("Device haptic", value: supported ? "available" : "unavailable (phone carries feedback)")
                }
                if controller.lostFrames > 0 {
                    LabeledContent("Lost frames", value: "\(controller.lostFrames)")
                }
                policyRow
                controlButton
            }

            Section("Feedback") {
                if controller.feedbackLog.isEmpty {
                    Text("Events appear here as they happen: wake, capture, window close, card.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(controller.feedbackLog) { entry in
                        HStack {
                            Image(systemName: icon(for: entry.name))
                                .foregroundStyle(color(for: entry.name))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(label(for: entry.name)).font(.subheadline)
                                if let detail = entry.detail {
                                    Text(detail).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Text(entry.at, style: .time).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            Section("Live transcript") {
                if controller.capturePolicy == "wake_only" {
                    Text("Listening for \u{201C}Zeca\u{201D} only. Speech shown here is transient - nothing is stored.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if transcript.segments.isEmpty {
                    Text(controller.sessionId == nil ? "Connect the pendant to start." : "Waiting for speech.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(transcript.segments) { segment in
                        Text(segment.text)
                            .font(.callout)
                            .foregroundStyle(segment.final ? .primary : .secondary)
                            .italic(!segment.final)
                    }
                }
            }
        }
        .navigationTitle("Pendant")
        .onChange(of: controller.sessionId) { _, id in
            if let id { transcript.start(sessionId: id) } else { transcript.stop() }
        }
        .onAppear { controller.refreshServiceState() }
        .sheet(isPresented: $showAmbientConsent) {
            AmbientConsentSheet(
                onProceed: {
                    AppGroup.pendantAmbientConsent = true
                    showAmbientConsent = false
                    controller.connect()
                },
                onCancel: { showAmbientConsent = false }
            )
        }
    }

    @ViewBuilder private var statusRow: some View {
        switch controller.connectionState {
        case .disconnected: LabeledContent("Pendant", value: "disconnected")
        case .scanning: LabeledContent("Pendant", value: "scanning")
        case .connecting: LabeledContent("Pendant", value: "connecting")
        case .connected:
            HStack {
                Text("Pendant")
                Spacer()
                Label("connected", systemImage: "dot.radiowaves.left.and.right")
                    .foregroundStyle(.green)
            }
        case .reconnecting: LabeledContent("Pendant", value: "reconnecting")
        case .pairingLost: LabeledContent("Pendant", value: "pairing lost - re-pair in Bluetooth settings")
        case .bluetoothOff: LabeledContent("Pendant", value: "Bluetooth is off")
        }
    }

    @ViewBuilder private var policyRow: some View {
        if controller.pendantFlagOn == false {
            Label("The pendant path is disabled on the server (pendant_enabled).", systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.orange)
        } else if let policy = controller.capturePolicy {
            LabeledContent("Capture policy", value: policy == "ambient" ? "ambient (sessions stored)" : "wake only (nothing stored)")
        }
    }

    @ViewBuilder private var controlButton: some View {
        if controller.isActive {
            Button(role: .destructive) {
                controller.disconnect()
            } label: {
                Label("Disconnect pendant", systemImage: "stop.circle")
            }
        } else {
            Button {
                if controller.capturePolicy == "ambient", !AppGroup.pendantAmbientConsent {
                    showAmbientConsent = true
                } else {
                    controller.connect()
                }
            } label: {
                Label("Connect pendant", systemImage: "wave.3.right.circle")
            }
        }
    }

    private func label(for name: String) -> String {
        switch name {
        case "wake_detected": return "Wake detected"
        case "wake_lapsed": return "Wake not confirmed"
        case "segment_captured": return "Segment captured"
        case "window_closed": return "Window closed"
        case "task_created": return "Card created"
        case "task_failed": return "Failed"
        default: return name
        }
    }

    private func icon(for name: String) -> String {
        switch name {
        case "wake_detected": return "ear"
        case "wake_lapsed": return "ear.trianglebadge.exclamationmark"
        case "segment_captured": return "text.bubble"
        case "window_closed": return "checkmark.circle"
        case "task_created": return "rectangle.stack.badge.plus"
        case "task_failed": return "xmark.octagon"
        default: return "circle"
        }
    }

    private func color(for name: String) -> Color {
        switch name {
        case "task_created": return .green
        case "task_failed": return .red
        default: return .secondary
        }
    }
}

/// The stronger one-time notice for ambient capture (ADR D6), consistent
/// with the existing consent decision: shown once, acknowledged forever.
struct AmbientConsentSheet: View {
    let onProceed: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("Ambient capture")
                .font(.headline)
            Text(
                "Under the ambient policy the pendant records and transcribes continuously while connected, and transcripts are stored. If you have people around, always ask for consent - continuous capture affects everyone in the room."
            )
            .font(.subheadline)
            .multilineTextAlignment(.center)
            HStack {
                Button("Cancel", action: onCancel)
                    .buttonStyle(.bordered)
                Button("I understand - connect", action: onProceed)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .presentationDetents([.medium])
    }
}

// MARK: - Live transcript over SSE

/// Minimal SSE reader for the capture service's per-session events feed.
/// Interims replace the previous interim; finals accumulate (bounded).
@MainActor
final class TranscriptStream: ObservableObject {
    struct Segment: Identifiable, Equatable {
        let id: String
        let text: String
        let final: Bool
    }

    @Published private(set) var segments: [Segment] = []
    private var task: Task<Void, Never>?

    func start(sessionId: String) {
        stop()
        segments = []
        guard let base = AppGroup.baseURL else { return }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = "/sessions/\(sessionId)/events"
        guard let url = components.url else { return }
        task = Task { [weak self] in
            guard let self else { return }
            // The session is created on the phone and only exists server-side
            // once the websocket session_start lands, so the first request
            // usually loses that race and is answered 404. bytes(from:) does
            // NOT throw on 404 - it hands back the error body - so the status
            // has to be checked explicitly, and the attempt retried, or the
            // strip stays empty for the whole session.
            while !Task.isCancelled {
                let opened = await self.streamOnce(url: url)
                if opened { return } // ran to done, or was cancelled mid-stream
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    /// Returns true when the stream reached its natural end and should not be
    /// retried; false when it never opened and the caller should try again.
    private func streamOnce(url: URL) async -> Bool {
        do {
            let (bytes, response) = try await URLSession.shared.bytes(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                return false // usually the session_start race; try again shortly
            }
            do {
                for try await line in bytes.lines {
                    if Task.isCancelled { return true }
                    guard line.hasPrefix("data: "), let data = line.dropFirst(6).data(using: .utf8),
                          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    else { continue }
                    if object["done"] as? Bool == true { return true }
                    guard let text = object["text"] as? String else { continue }
                    let isFinal = object["final"] as? Bool ?? false
                    await MainActor.run {
                        if let last = self.segments.last, !last.final {
                            self.segments.removeLast()
                        }
                        self.segments.append(Segment(id: UUID().uuidString, text: text, final: isFinal))
                        if self.segments.count > 40 {
                            self.segments.removeFirst(self.segments.count - 40)
                        }
                    }
                }
            } catch {
                // Mid-stream drop: reconnect rather than going quiet for good.
                return false
            }
            // Server closed without "done" - the session may still be live.
            return false
        } catch {
            return false
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}
