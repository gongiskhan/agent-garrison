import Foundation
import AVFoundation

#if DEBUG
/// DEBUG-only harness: streams the bundled Opus fixture through the REAL
/// uploader as if the microphone had produced it - the deterministic
/// "fixture microphone input" of the M6 acceptance, driveable headlessly via
/// `simctl launch` environment:
///
///   GARRISON_AUTOSTART=fixture GARRISON_BASE_URL=... GARRISON_TOKEN=...
///
/// Ships nothing in Release: the whole file is compiled out.
enum FixtureStreamer {
    @MainActor
    private static var listeningUITest: Bool {
        ProcessInfo.processInfo.environment["GARRISON_LISTENING_UI_TEST"] == "1" && AppGroup.baseURL?.host == "127.0.0.1"
    }

    @MainActor
    static func configureListeningJourneyIfRequested() {
        guard listeningUITest else { return }
        AppGroup.consentSuppressed = true
        AppGroup.pendantIdentifier = nil
        for event in ["interruption-began", "interruption-ended", "pair-pendant"] {
            CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, name, _, _ in
                guard let name else { return }
                let event = name.rawValue as String
                Task { @MainActor in FixtureStreamer.handleListeningTestEvent(event) }
            }, "com.gomes.garrison.listening-test.\(event)" as CFString, nil, .deliverImmediately)
        }
        if let control = ProcessInfo.processInfo.environment["GARRISON_LISTENING_PROOF_CONTROL"],
           let url = URL(string: control + "/event/fixture-ready"), url.host == "127.0.0.1" {
            Task { _ = try? await URLSession.shared.data(from: url) }
        }
    }

    // XCTest's separate UI driver injects only these events into an isolated
    // simulator app. This hook is absent from Release and refuses live nodes.
    @MainActor
    private static func handleListeningTestEvent(_ event: String) {
        guard listeningUITest else { return }
        switch event {
        case "com.gomes.garrison.listening-test.interruption-began":
            NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: nil, userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
        case "com.gomes.garrison.listening-test.interruption-ended":
            NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: nil, userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue, AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume.rawValue])
        case "com.gomes.garrison.listening-test.pair-pendant":
            var script = MockPendantTransport.Script(); script.connectDelayMs = 1
            let packets = (0..<6000).map { PendantFixturePacket(seq: $0 + 1, ts: Double($0) * 20, bytes: Data([0xf8, 0xff, 0xfe])) }
            GarrisonPendantPlugin.controllerOverride = PendantController(transport: MockPendantTransport(packets: packets, script: script), phoneSink: nil)
            AppGroup.pendantIdentifier = UUID()
            if let record = ListeningChannel.shared.records["phone"] { ListeningChannel.shared.receive(record) }
        default: return
        }
    }

    static func autostartIfRequested() {
        let env = ProcessInfo.processInfo.environment
        guard env["GARRISON_AUTOSTART"] == "fixture" else { return }
        if let base = env["GARRISON_BASE_URL"], !base.isEmpty {
            AppGroup.defaults?.set(base, forKey: AppGroup.Key.baseURL)
        }
        if let token = env["GARRISON_TOKEN"], !token.isEmpty {
            AppGroup.defaults?.set(token, forKey: AppGroup.Key.token)
        }
        AppGroup.defaults?.set("simulator-fixture", forKey: AppGroup.Key.deviceName)
        stream()
    }

    private struct FixturePacket: Decodable {
        let seq: UInt32
        let ts: Double
        let bytes: String
    }

    static func stream() {
        guard let baseURL = AppGroup.baseURL, let token = AppGroup.token else {
            print("[fixture-streamer] no endpoint configured")
            return
        }
        guard let url = Bundle.main.url(forResource: "audio-pt-command", withExtension: "jsonl"),
              let content = try? String(contentsOf: url, encoding: .utf8)
        else {
            print("[fixture-streamer] bundled fixture missing")
            return
        }
        let decoder = JSONDecoder()
        let packets = content.split(separator: "\n").compactMap { line -> (UInt32, Double, Data)? in
            guard let packet = try? decoder.decode(FixturePacket.self, from: Data(line.utf8)),
                  let bytes = Data(base64Encoded: packet.bytes)
            else { return nil }
            return (packet.seq, packet.ts, bytes)
        }
        guard !packets.isEmpty else {
            print("[fixture-streamer] fixture decoded to zero packets")
            return
        }

        let sessionId = SessionId.generate()
        print("[fixture-streamer] session \(sessionId): \(packets.count) packets")
        let uploader = CaptureUploader(
            baseURL: baseURL,
            token: token,
            sessionId: sessionId,
            mode: .audio,
            deviceName: AppGroup.deviceName,
            consent: .shown,
            spoolDirectory: AppGroup.spoolDirectory(sessionId: sessionId)
        )
        uploader.onStateChange = { state in print("[fixture-streamer] state: \(state)") }
        uploader.onSessionEnded = { reason in print("[fixture-streamer] ended: \(reason)") }
        uploader.connect()

        // ~4x realtime: fast enough to finish promptly, paced enough to look
        // like a stream rather than a file dump.
        Task.detached {
            for (index, packet) in packets.enumerated() {
                uploader.sendAudioPacket(packet.2, ts: packet.1)
                if index % 4 == 3 {
                    try? await Task.sleep(nanoseconds: 20_000_000)
                }
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            uploader.end(reason: "user")
            print("[fixture-streamer] done")
        }
    }
}
#endif
