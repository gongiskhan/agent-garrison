import Foundation

// Shared between the app and the broadcast extension (compiled into both
// targets — no framework; the extension must stay small). The App Group is
// the ONLY channel between the two processes: the app writes the endpoint and
// token, the extension reads them at broadcast start.
enum AppGroup {
    static let identifier = "group.com.gomes.garrison"

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: identifier)
    }

    // Settings keys (written by the app's Settings screen at M6).
    enum Key {
        static let baseURL = "capture.baseURL"       // e.g. https://host.ts.net:84xx
        static let token = "capture.token"           // CAPTURE_TOKEN value
        static let deviceName = "capture.deviceName"
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
}
