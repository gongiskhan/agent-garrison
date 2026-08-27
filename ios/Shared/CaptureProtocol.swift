import Foundation

/// Wire framing per the capture-service contract (spec §4). Each binary
/// WebSocket message is one self-contained unit:
///
///   byte 0       : kind  (UInt8)   0 = Opus audio packet, 1 = JPEG still
///   bytes 1..4   : seq   (UInt32)  per-stream sequence, little-endian, from 1
///   bytes 5..12  : ts    (Float64) ms (session-relative), little-endian
///   bytes 13..16 : len   (UInt32)  payload byte count, little-endian
///   bytes 17..   : payload
///
/// Control messages are JSON text frames; the server acks media with
/// {type:"ack", stream, seq} carrying the highest CONTIGUOUS persisted seq —
/// the uploader resumes from the last acked seq after a drop.
enum MediaKind: UInt8 {
    case audio = 0
    case video = 1

    var streamName: String { self == .audio ? "audio" : "video" }
}

enum CaptureFraming {
    static let headerLength = 17

    static func encode(kind: MediaKind, seq: UInt32, ts: Double, payload: Data) -> Data {
        var out = Data(capacity: headerLength + payload.count)
        out.append(kind.rawValue)
        var seqLE = seq.littleEndian
        withUnsafeBytes(of: &seqLE) { out.append(contentsOf: $0) }
        var tsLE = ts.bitPattern.littleEndian
        withUnsafeBytes(of: &tsLE) { out.append(contentsOf: $0) }
        var lenLE = UInt32(payload.count).littleEndian
        withUnsafeBytes(of: &lenLE) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }

    /// Decode a framed message (the spool replays stored frames; tests
    /// round-trip). Returns nil on a short or inconsistent buffer.
    static func decode(_ data: Data) -> (kind: MediaKind, seq: UInt32, ts: Double, payload: Data)? {
        guard data.count >= headerLength, let kind = MediaKind(rawValue: data[data.startIndex]) else { return nil }
        let seq = data.subdata(in: data.startIndex + 1 ..< data.startIndex + 5).withUnsafeBytes {
            UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))
        }
        let tsBits = data.subdata(in: data.startIndex + 5 ..< data.startIndex + 13).withUnsafeBytes {
            UInt64(littleEndian: $0.loadUnaligned(as: UInt64.self))
        }
        let len = data.subdata(in: data.startIndex + 13 ..< data.startIndex + 17).withUnsafeBytes {
            UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))
        }
        guard data.count == Self.headerLength + Int(len) else { return nil }
        return (kind, seq, Double(bitPattern: tsBits), data.subdata(in: data.startIndex + 17 ..< data.endIndex))
    }
}

// MARK: - Control messages (client -> server)

enum SessionMode: String, Codable {
    case audio
    case screenAudio = "screen_audio"
    /// Pendant Direct: the app relaying the BLE pendant's Opus stream. The
    /// server applies its capture_policy to this mode only.
    case pendant
}

enum ConsentState: String, Codable {
    case shown
    case suppressed
}

struct SessionStartMessage: Codable {
    var type = "session_start"
    let sessionId: String
    let mode: String
    let deviceName: String
    let consent: String
    let startedAt: String
    /// Pendant sessions only: which Opus framing the device ships
    /// ("opus" 10 ms / "opus_fs320" 20 ms). Omitted for mic modes.
    var codec: String?

    enum CodingKeys: String, CodingKey {
        case type
        case sessionId = "session_id"
        case mode
        case deviceName = "device_name"
        case consent
        case startedAt = "started_at"
        case codec
    }
}

struct SessionEndMessage: Codable {
    var type = "session_end"
    let reason: String
}

struct SpokenReceiptMessage: Codable {
    var type = "spoken"
    let spoken: String
    let ok: Bool
    let reason: String?
}

/// Receipt for a {type:"feedback"} event: the sink acted (or declined); the
/// server closes its latency measurement on arrival.
struct FeedbackAckMessage: Codable {
    var type = "feedback_ack"
    let eventId: String

    enum CodingKeys: String, CodingKey {
        case type
        case eventId = "event_id"
    }
}

// MARK: - Server messages

/// The ack payload delivered over {type:"speak"} — pre-rendered, pre-validated
/// upstream (wake-word check, referent rule). The app SPEAKS `text`; it never
/// composes sentences.
struct AckPayload: Codable {
    let id: String
    let kind: String?
    let severity: String?
    let templateId: String?
    let text: String
    let cardId: String?
    let idempotencyKey: String?
    let emittedAt: String?
    /// Server-relative path to a pre-rendered clip of Zeca's voice
    /// (`/speak/<hash>.mp3`), when the service could render one. Absent means
    /// speak `text` with the on-device synthesizer, exactly as before.
    let audioPath: String?
}

/// One pendant feedback lifecycle event (wake_detected, segment_captured,
/// window_closed, task_created, task_failed) as delivered over the session
/// socket. snake_case keys as the server sends them.
struct FeedbackEvent: Codable, Equatable {
    let eventId: String
    let name: String
    let sessionId: String
    let at: String
    let reason: String?
    let cardId: String?
    let title: String?
    let interim: Bool?

    enum CodingKeys: String, CodingKey {
        case eventId = "event_id"
        case name
        case sessionId = "session_id"
        case at
        case reason
        case cardId = "card_id"
        case title
        case interim
    }
}

enum ServerMessage {
    case sessionStarted(sessionId: String)
    case sessionResumed(sessionId: String, audioSeq: UInt32, videoSeq: UInt32)
    case ack(stream: String, seq: UInt32)
    case sessionEnded(reason: String)
    case speak(AckPayload)
    case feedback(FeedbackEvent)
    case serverError(String)

    static func parse(_ text: String) -> ServerMessage? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String
        else { return nil }
        switch type {
        case "session_started":
            return .sessionStarted(sessionId: object["session_id"] as? String ?? "")
        case "session_resumed":
            return .sessionResumed(
                sessionId: object["session_id"] as? String ?? "",
                audioSeq: UInt32(object["audio_seq"] as? Int ?? 0),
                videoSeq: UInt32(object["video_seq"] as? Int ?? 0)
            )
        case "ack":
            guard let stream = object["stream"] as? String, let seq = object["seq"] as? Int else { return nil }
            return .ack(stream: stream, seq: UInt32(max(0, seq)))
        case "session_ended":
            return .sessionEnded(reason: object["reason"] as? String ?? "user")
        case "speak":
            guard let ackObject = object["ack"],
                  let ackData = try? JSONSerialization.data(withJSONObject: ackObject),
                  let ack = try? JSONDecoder().decode(AckPayload.self, from: ackData)
            else { return nil }
            return .speak(ack)
        case "feedback":
            guard let eventObject = object["event"],
                  let eventData = try? JSONSerialization.data(withJSONObject: eventObject),
                  let event = try? JSONDecoder().decode(FeedbackEvent.self, from: eventData)
            else { return nil }
            return .feedback(event)
        case "error":
            return .serverError(object["error"] as? String ?? "unknown error")
        default:
            return nil
        }
    }
}

// MARK: - Session ids

enum SessionId {
    /// Client-generated, ULID-flavoured: sortable time prefix + random tail,
    /// matching the server's accepted charset [A-Za-z0-9_-]{10,40}.
    static func generate(now: Date = Date()) -> String {
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        var time = UInt64(now.timeIntervalSince1970 * 1000)
        var prefix = [Character](repeating: "0", count: 10)
        for i in stride(from: 9, through: 0, by: -1) {
            prefix[i] = alphabet[Int(time % 32)]
            time /= 32
        }
        let tail = (0 ..< 12).map { _ in alphabet[Int.random(in: 0 ..< alphabet.count)] }
        return String(prefix + tail)
    }
}
