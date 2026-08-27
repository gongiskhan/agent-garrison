import Foundation

/// The local, readable log of every ack and notification the phone received
/// (spec §5c) — the thing the operator scrolls when they felt a buzz and
/// missed it. Stored in the App Group container as JSONL, newest last,
/// bounded by entry count.
struct AckLogEntry: Codable, Identifiable {
    let id: String
    let at: Date
    let kind: String? // created / completed / failed / ...
    let severity: String?
    let text: String
    let via: String // spoken / push / dropped:<reason>
}

final class AckLog {
    static let maxEntries = 500
    static let shared = AckLog()

    private let fileURL: URL
    private let queue = DispatchQueue(label: "garrison.acklog")

    init(directory: URL? = nil) {
        let base = directory
            ?? FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppGroup.identifier)
            ?? FileManager.default.temporaryDirectory
        fileURL = base.appendingPathComponent("ack-log.jsonl")
    }

    func append(_ entry: AckLogEntry) {
        queue.async { [fileURL] in
            var entries = Self.read(from: fileURL)
            entries.append(entry)
            if entries.count > Self.maxEntries {
                entries.removeFirst(entries.count - Self.maxEntries)
            }
            Self.write(entries, to: fileURL)
        }
    }

    func entries() -> [AckLogEntry] {
        queue.sync { Self.read(from: fileURL).reversed() } // newest first
    }

    private static func read(from url: URL) -> [AckLogEntry] {
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return text.split(separator: "\n").compactMap { line in
            try? decoder.decode(AckLogEntry.self, from: Data(line.utf8))
        }
    }

    private static func write(_ entries: [AckLogEntry], to url: URL) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let lines = entries.compactMap { entry -> String? in
            guard let data = try? encoder.encode(entry) else { return nil }
            return String(data: data, encoding: .utf8)
        }
        try? lines.joined(separator: "\n").appending("\n").write(to: url, atomically: true, encoding: .utf8)
    }
}
