import Foundation

/// Offline buffer for one capture session (spec §4 offline behaviour): every
/// framed media message is appended to disk in the App Group container BEFORE
/// any send attempt, so a dropped link loses nothing — the uploader replays
/// `frames(after:)` when the server reports its high-water marks on resume.
///
/// Layout: two rotating segment files (`spool.0` / `spool.1`) of framed wire
/// messages, each capped at half the ring budget. When the active segment
/// fills, the OTHER segment is truncated and becomes active — so disk stays
/// bounded and the oldest unsent frames are the ones sacrificed (counted by
/// the caller via `droppedRotations`).
///
/// The record format IS the wire format (CaptureFraming) — replay is a byte
/// copy, and the same scan logic the server uses recovers state after a
/// crash (a truncated tail is dead bytes the length-prefix walk skips).
final class SessionSpool {
    static let defaultRingBytes = 48 * 1024 * 1024

    private let directory: URL
    private let ringBytes: Int
    private var activeIndex: Int
    private(set) var droppedRotations = 0

    init(directory: URL, ringBytes: Int = SessionSpool.defaultRingBytes) {
        self.directory = directory
        self.ringBytes = ringBytes
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Resume into whichever segment was most recently written.
        let sizes = (0 ... 1).map { (try? Self.size(of: directory.appendingPathComponent("spool.\($0)"))) ?? 0 }
        let dates = (0 ... 1).map {
            (try? FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("spool.\($0)").path)[.modificationDate] as? Date) ?? .distantPast
        }
        activeIndex = (sizes[1] > 0 && dates[1] ?? .distantPast > dates[0] ?? .distantPast) ? 1 : 0
    }

    private static func size(of url: URL) throws -> Int {
        (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    }

    private func segmentURL(_ index: Int) -> URL {
        directory.appendingPathComponent("spool.\(index)")
    }

    /// Append one framed wire message. Rotates segments when the active one
    /// exceeds half the ring budget.
    func append(_ frame: Data) {
        let active = segmentURL(activeIndex)
        let currentSize = (try? Self.size(of: active)) ?? 0
        if currentSize + frame.count > ringBytes / 2 {
            activeIndex = 1 - activeIndex
            let next = segmentURL(activeIndex)
            if FileManager.default.fileExists(atPath: next.path), ((try? Self.size(of: next)) ?? 0) > 0 {
                droppedRotations += 1
            }
            try? FileManager.default.removeItem(at: next)
        }
        let url = segmentURL(activeIndex)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: frame)
        } else {
            try? frame.write(to: url)
        }
    }

    /// Every stored frame in append order (older segment first).
    func allFrames() -> [Data] {
        var frames: [Data] = []
        for index in [1 - activeIndex, activeIndex] {
            guard let data = try? Data(contentsOf: segmentURL(index)) else { continue }
            var offset = 0
            while offset + CaptureFraming.headerLength <= data.count {
                let lenRange = (offset + 13) ..< (offset + 17)
                let len = data.subdata(in: lenRange).withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
                let end = offset + CaptureFraming.headerLength + len
                guard end <= data.count else { break } // truncated tail: dead bytes
                frames.append(data.subdata(in: offset ..< end))
                offset = end
            }
        }
        return frames
    }

    /// Frames the server has NOT confirmed: audio frames with seq beyond
    /// `audioSeq` and video frames beyond `videoSeq`, in append order.
    func frames(afterAudio audioSeq: UInt32, video videoSeq: UInt32) -> [Data] {
        allFrames().filter { frame in
            guard let decoded = CaptureFraming.decode(frame) else { return false }
            switch decoded.kind {
            case .audio: return decoded.seq > audioSeq
            case .video: return decoded.seq > videoSeq
            }
        }
    }

    /// Highest stored seq per stream (crash recovery: the uploader continues
    /// numbering from here).
    func highWater() -> (audio: UInt32, video: UInt32) {
        var audio: UInt32 = 0
        var video: UInt32 = 0
        for frame in allFrames() {
            guard let decoded = CaptureFraming.decode(frame) else { continue }
            switch decoded.kind {
            case .audio: audio = max(audio, decoded.seq)
            case .video: video = max(video, decoded.seq)
            }
        }
        return (audio, video)
    }

    func removeAll() {
        for index in 0 ... 1 {
            try? FileManager.default.removeItem(at: segmentURL(index))
        }
    }
}
