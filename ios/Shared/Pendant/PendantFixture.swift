import Foundation

/// One line of a fixtures/audio-*.jsonl file: a raw Opus packet with its
/// session-relative timestamp, exactly what the fixture generator emits and
/// what the wire protocol carries.
struct PendantFixturePacket {
    let seq: Int
    let ts: Double
    let bytes: Data
}

enum PendantFixtureError: Error {
    case unreadable(String)
    case badLine(Int)
}

enum PendantFixture {
    static func load(url: URL) throws -> [PendantFixturePacket] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            throw PendantFixtureError.unreadable(url.path)
        }
        return try parse(text)
    }

    static func parse(_ text: String) throws -> [PendantFixturePacket] {
        var packets: [PendantFixturePacket] = []
        for (lineNumber, line) in text.split(separator: "\n").enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            guard let data = trimmed.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let seq = object["seq"] as? Int,
                  let base64 = object["bytes"] as? String,
                  let bytes = Data(base64Encoded: base64)
            else { throw PendantFixtureError.badLine(lineNumber + 1) }
            let ts = (object["ts"] as? Double) ?? Double(object["ts"] as? Int ?? 0)
            packets.append(PendantFixturePacket(seq: seq, ts: ts, bytes: bytes))
        }
        return packets
    }
}
