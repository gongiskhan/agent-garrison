import AVFoundation
import SwiftUI

/// Settings: capture endpoint (base URL + token + device name), the voice-out
/// sink controls (spec §5b: master and info toggles in easy reach, quiet
/// hours, mute-for-N-minutes, rate/volume), and push registration status.
/// No hardcoded hosts anywhere (invariant I9) — the base URL is the tailnet
/// address of the node running the capture service.
struct SettingsView: View {
    @AppStorage(AppGroup.Key.baseURL, store: AppGroup.defaults) private var baseURL = ""
    @AppStorage(AppGroup.Key.token, store: AppGroup.defaults) private var token = ""
    @AppStorage(AppGroup.Key.deviceName, store: AppGroup.defaults) private var deviceName = ""
    @AppStorage(AppGroup.Key.consentSuppressed, store: AppGroup.defaults) private var consentSuppressed = false
    @AppStorage(AppGroup.Key.speakMaster, store: AppGroup.defaults) private var speakMaster = true
    @AppStorage(AppGroup.Key.speakInfo, store: AppGroup.defaults) private var speakInfo = true
    @AppStorage(AppGroup.Key.speakRate, store: AppGroup.defaults) private var speakRate = Double(AVSpeechUtteranceDefaultSpeechRate)
    @AppStorage(AppGroup.Key.speakVolume, store: AppGroup.defaults) private var speakVolume = 1.0
    @AppStorage(AppGroup.Key.quietHoursStart, store: AppGroup.defaults) private var quietStart = -1
    @AppStorage(AppGroup.Key.quietHoursEnd, store: AppGroup.defaults) private var quietEnd = -1
    @AppStorage(AppGroup.Key.muteUntil, store: AppGroup.defaults) private var muteUntil = 0.0

    @ObservedObject private var push = PushManager.shared
    @State private var connectionStatus: String?

    var body: some View {
        Form {
            Section("Capture service") {
                TextField("Base URL (https://host.ts.net:8497)", text: $baseURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Capture token", text: $token)
                TextField("Device name", text: $deviceName)
                Button("Test connection") { testConnection() }
                if let connectionStatus {
                    Text(connectionStatus).font(.footnote).foregroundStyle(.secondary)
                }
            }

            Section("Voice") {
                Toggle("Speak acknowledgements", isOn: $speakMaster)
                Toggle("Speak info-level acks", isOn: $speakInfo)
                    .disabled(!speakMaster)
                VStack(alignment: .leading) {
                    Text("Rate").font(.footnote).foregroundStyle(.secondary)
                    Slider(value: $speakRate, in: 0.3 ... 0.7)
                }
                VStack(alignment: .leading) {
                    Text("Volume").font(.footnote).foregroundStyle(.secondary)
                    Slider(value: $speakVolume, in: 0.2 ... 1.0)
                }
                if muteUntil > Date().timeIntervalSince1970 {
                    Button("Unmute (muted until \(Date(timeIntervalSince1970: muteUntil).formatted(date: .omitted, time: .shortened)))") {
                        muteUntil = 0
                    }
                } else {
                    Button("Mute for 60 minutes") {
                        muteUntil = Date().addingTimeInterval(3600).timeIntervalSince1970
                    }
                }
                Picker("Quiet hours start", selection: $quietStart) {
                    Text("Off").tag(-1)
                    ForEach(0 ..< 24, id: \.self) { Text("\($0):00").tag($0) }
                }
                Picker("Quiet hours end", selection: $quietEnd) {
                    Text("Off").tag(-1)
                    ForEach(0 ..< 24, id: \.self) { Text("\($0):00").tag($0) }
                }
            }

            Section("Notifications") {
                LabeledContent("Push status", value: push.status)
                Button("Register for push") { push.registerOnLaunch() }
            }

            Section("Consent") {
                Toggle("Skip the consent notice", isOn: $consentSuppressed)
                Text("Sessions record whether the notice was shown; skipping travels as consent: suppressed.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
    }

    private func testConnection() {
        guard let request = AppGroup.request(path: "/capture/sessions") else {
            connectionStatus = "Set the base URL and token first."
            return
        }
        connectionStatus = "checking..."
        URLSession.shared.dataTask(with: request) { _, response, error in
            let status: String
            if let error {
                status = "Failed: \(error.localizedDescription)"
            } else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                status = code == 200 ? "Connected." : code == 401 ? "Reachable, but the token is wrong." : code == 403 ? "Reachable, but capture is disabled or unconfigured." : "HTTP \(code)"
            }
            DispatchQueue.main.async { connectionStatus = status }
        }.resume()
    }
}
