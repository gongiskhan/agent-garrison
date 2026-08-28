import Foundation

// Shared between the app and the broadcast extension (compiled into both
// targets — no framework; the extension must stay small). The App Group is
// the ONLY channel between the two processes: the app writes the endpoint,
// token and settings; the extension reads them at broadcast start.
enum AppGroup {
    static let identifier = "group.com.gomes.garrison"

    /// Injectable for tests (a plain suite name instead of the group).
    static var defaults: UserDefaults? = UserDefaults(suiteName: identifier)

    enum Key {
        static let baseURL = "capture.baseURL" // e.g. https://host.ts.net:8498
        static let token = "capture.token" // CAPTURE_TOKEN value
        static let deviceName = "capture.deviceName"
        static let consentSuppressed = "capture.consentSuppressed" // "Don't ask me again"
        // Voice-out sink controls (spec §5b).
        static let speakMaster = "speak.master"
        static let speakInfo = "speak.info" // info-level acks; errors always speak
        static let speakRate = "speak.rate"
        static let speakVolume = "speak.volume"
        static let speakVoiceId = "speak.voiceId"
        static let quietHoursStart = "speak.quietStart" // hour 0-23, -1 = off
        static let quietHoursEnd = "speak.quietEnd"
        static let muteUntil = "speak.muteUntil" // epoch seconds
        static let speakCues = "speak.cues" // the wake/window cues ("Sim?", "Ok.")
        // Pendant Direct.
        static let pendantIdentifier = "pendant.identifier" // CBPeripheral UUID string
        static let pendantAmbientConsent = "pendant.ambientConsent" // stronger one-time notice acknowledged
        static let broadcastHeartbeat = "broadcast.heartbeat" // epoch seconds, written by the extension
    }

    static var pendantIdentifier: UUID? {
        get {
            guard let raw = defaults?.string(forKey: Key.pendantIdentifier) else { return nil }
            return UUID(uuidString: raw)
        }
        set { defaults?.set(newValue?.uuidString, forKey: Key.pendantIdentifier) }
    }

    static var pendantAmbientConsent: Bool {
        get { defaults?.bool(forKey: Key.pendantAmbientConsent) ?? false }
        set { defaults?.set(newValue, forKey: Key.pendantAmbientConsent) }
    }

    static var baseURL: URL? {
        guard let raw = defaults?.string(forKey: Key.baseURL)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty
        else { return nil }
        return URL(string: raw)
    }

    static var token: String? {
        let value = defaults?.string(forKey: Key.token)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (value?.isEmpty ?? true) ? nil : value
    }

    static var deviceName: String {
        let value = defaults?.string(forKey: Key.deviceName)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (value?.isEmpty ?? true) ? "iPhone" : value!
    }

    static var consentSuppressed: Bool {
        get { defaults?.bool(forKey: Key.consentSuppressed) ?? false }
        set { defaults?.set(newValue, forKey: Key.consentSuppressed) }
    }

    /// Per-session spool directory inside the shared container, so the app
    /// and the extension buffer offline media the same way.
    static func spoolDirectory(sessionId: String) -> URL {
        let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
            ?? FileManager.default.temporaryDirectory
        return container.appendingPathComponent("spool", isDirectory: true)
            .appendingPathComponent(sessionId, isDirectory: true)
    }

    /// Authenticated HTTP request against the capture service.
    static func request(path: String, method: String = "GET", body: Data? = nil) -> URLRequest? {
        guard let base = baseURL, let token else { return nil }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = path
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        request.timeoutInterval = 15
        return request
    }
}

// MARK: - Broadcast liveness

/// The broadcast runs in its OWN PROCESS (the upload extension), so the app
/// cannot observe it directly and a user has no way to tell whether Zeca can
/// currently see their screen - which decides whether "reply to her" can work
/// at all. The extension therefore stamps a heartbeat into the shared App
/// Group as it ships frames, and the app reads it.
///
/// A heartbeat rather than a flag because the extension can be killed by the
/// system without ever running its teardown: a stale stamp then reads as
/// "not broadcasting", which is the safe direction.
extension AppGroup {
    /// Frames arrive at ~1.5 fps, so anything fresher than this is live.
    static let broadcastStaleAfter: TimeInterval = 8

    static func noteBroadcastAlive(now: Date = Date()) {
        defaults?.set(now.timeIntervalSince1970, forKey: Key.broadcastHeartbeat)
    }

    static func clearBroadcast() {
        defaults?.removeObject(forKey: Key.broadcastHeartbeat)
    }

    static func isBroadcasting(now: Date = Date()) -> Bool {
        guard let beat = defaults?.object(forKey: Key.broadcastHeartbeat) as? Double else { return false }
        return now.timeIntervalSince1970 - beat < broadcastStaleAfter
    }
}
