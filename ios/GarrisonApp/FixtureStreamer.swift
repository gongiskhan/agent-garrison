import Foundation

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
