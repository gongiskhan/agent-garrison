import Foundation
import Security

// Mirrored from capture-service/lib/listening-config.mjs.
enum ListeningConstants {
    static let HEARTBEAT_SECONDS: TimeInterval = 5
    static let WATCHDOG_TICK_SECONDS: TimeInterval = 5
    static let STALL_AFTER_SECONDS: TimeInterval = 20
    static let STALL_PUSH_REPEAT_MINUTES = 10
    static let STALL_PUSH_MAX_PER_EPISODE = 2
    static let STOP_HOLD_MS = 1500
    static let RESUME_RETRY_SCHEDULE_SECONDS: [TimeInterval] = [2, 5, 15, 30, 60]
    static let RESUME_GIVE_UP_MINUTES = 10
    static let WAKE_ACK_MAX_LATENCY_MS = 1000
}

struct DeviceListeningState: Codable, Equatable {
    let device_id: String
    let device_name: String
    let source: String
    let intent: String
    let actual: String
    let reason: String?
    let last_seen_at: String?
    let intent_changed_at: String
    let actual_changed_at: String
    let stall_episode_id: String?
    let stall_pushes_sent: Int
    let app_version: String

    var payload: [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return value
    }
}

struct ListeningMessage: Encodable {
    let type: String
    let device_id: String
    var source: String?
    var intent: String?
    var actual: String?
    var reason: String?
    var device_name: String?
    var app_version: String?
    var at = ISO8601DateFormatter().string(from: Date())
}

enum ListeningIdentity {
    // The default app Keychain survives app reinstalls. No provider secret is
    // stored here. A failed Keychain write is surfaced instead of changing ID.
    static func load() throws -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.gomes.garrison.listening", kSecAttrAccount as String: "device-id"]
        var found: CFTypeRef?
        let status = SecItemCopyMatching(query.merging([kSecReturnData as String: true]) { _, n in n } as CFDictionary, &found)
        if status == errSecSuccess, let data = found as? Data, let id = String(data: data, encoding: .utf8), UUID(uuidString: id) != nil { return id }
        guard status == errSecItemNotFound else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        let id = UUID().uuidString
        let write = SecItemAdd(query.merging([kSecValueData as String: Data(id.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]) { _, n in n } as CFDictionary, nil)
        guard write == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(write)) }
        return id
    }
}
