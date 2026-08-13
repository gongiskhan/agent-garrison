import SwiftUI

/// The main surface: a deliberate start/stop control per capture mode.
/// Audio-only runs in-app (AVAudioEngine); screen+audio goes through the
/// system broadcast picker into the upload extension. No ambient mode exists
/// anywhere (invariant I3).
struct ContentView: View {
    @StateObject private var capture = CaptureController()
    @State private var showConsent = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                statusHeader

                if capture.isRunning {
                    Button {
                        capture.stop()
                    } label: {
                        Label("Stop session", systemImage: "stop.circle.fill")
                            .font(.title2.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 64)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                } else {
                    Button {
                        if AppGroup.consentSuppressed {
                            capture.start(consent: .suppressed)
                        } else {
                            showConsent = true
                        }
                    } label: {
                        Label("Start audio session", systemImage: "mic.circle.fill")
                            .font(.title2.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 64)
                    }
                    .buttonStyle(.borderedProminent)

                    VStack(spacing: 6) {
                        Text("Screen + audio")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        BroadcastPicker()
                            .frame(width: 60, height: 60)
                        Text("The system sheet asks which app to broadcast; turn the microphone ON there.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                }

                Spacer()

                List {
                    NavigationLink("Sessions") { SessionsView() }
                    NavigationLink("Messages") { AckLogView() }
                    NavigationLink("Settings") { SettingsView() }
                }
                .listStyle(.inset)
                .frame(maxHeight: 180)
            }
            .padding()
            .navigationTitle("Garrison")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showConsent) {
                ConsentSheet(
                    onProceed: { consent in
                        showConsent = false
                        capture.start(consent: consent)
                    },
                    onCancel: { showConsent = false }
                )
            }
            .onAppear { PushManager.shared.registerOnLaunch() }
        }
    }

    @ViewBuilder private var statusHeader: some View {
        switch capture.phase {
        case .idle:
            Text("Deliberate, session-based capture. Nothing records until you start it.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        case .connecting:
            Label("Connecting", systemImage: "antenna.radiowaves.left.and.right")
                .foregroundStyle(.secondary)
        case .live:
            VStack(spacing: 4) {
                Label("Recording", systemImage: "waveform")
                    .font(.headline)
                    .foregroundStyle(.red)
                if let id = capture.sessionId {
                    Text(id).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
                Text("\(capture.ackedFrames) frames delivered")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .interrupted:
            Label("Paused by the system (call or Siri)", systemImage: "pause.circle")
                .foregroundStyle(.orange)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.red)
        }
    }
}

#Preview {
    ContentView()
}
