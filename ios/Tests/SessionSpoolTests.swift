import XCTest
@testable import GarrisonApp

final class SessionSpoolTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spool-tests-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    private func frame(kind: MediaKind, seq: UInt32, size: Int = 8) -> Data {
        CaptureFraming.encode(kind: kind, seq: seq, ts: Double(seq) * 20, payload: Data(repeating: 0xAB, count: size))
    }

    func testAppendScanAndResumeFilter() {
        let spool = SessionSpool(directory: directory)
        for seq: UInt32 in 1 ... 5 { spool.append(frame(kind: .audio, seq: seq)) }
        spool.append(frame(kind: .video, seq: 1))
        XCTAssertEqual(spool.allFrames().count, 6)

        let high = spool.highWater()
        XCTAssertEqual(high.audio, 5)
        XCTAssertEqual(high.video, 1)

        // Resume: the server confirmed audio 3 and video 1 - only newer
        // audio frames replay.
        let replay = spool.frames(afterAudio: 3, video: 1).compactMap { CaptureFraming.decode($0) }
        XCTAssertEqual(replay.map(\.seq), [4, 5])
        XCTAssertTrue(replay.allSatisfy { $0.kind == .audio })
    }

    func testSurvivesReopenAndSkipsTruncatedTail() throws {
        var spool: SessionSpool? = SessionSpool(directory: directory)
        for seq: UInt32 in 1 ... 3 { spool?.append(frame(kind: .audio, seq: seq)) }
        spool = nil

        // Crash mid-append: garbage tail bytes must be skipped, not fatal.
        let segment = directory.appendingPathComponent("spool.0")
        let handle = try FileHandle(forWritingTo: segment)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data([0x00, 0x01, 0x02]))
        try handle.close()

        let reopened = SessionSpool(directory: directory)
        XCTAssertEqual(reopened.highWater().audio, 3)
        XCTAssertEqual(reopened.allFrames().count, 3)
    }

    func testRingRotationBoundsDiskAndDropsOldest() {
        // Tiny ring: each segment holds ~2 frames of 100 bytes.
        let spool = SessionSpool(directory: directory, ringBytes: 480)
        for seq: UInt32 in 1 ... 12 { spool.append(frame(kind: .audio, seq: seq, size: 100)) }
        XCTAssertGreaterThan(spool.droppedRotations, 0)

        let stored = spool.allFrames().compactMap { CaptureFraming.decode($0) }.map(\.seq)
        // Bounded: far fewer than 12 remain, the NEWEST survive, order holds.
        XCTAssertLessThanOrEqual(stored.count, 4)
        XCTAssertEqual(stored, stored.sorted())
        XCTAssertEqual(stored.last, 12)

        let sizes = (0 ... 1).compactMap { index -> Int? in
            let url = directory.appendingPathComponent("spool.\(index)")
            return (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        }
        XCTAssertLessThanOrEqual(sizes.reduce(0, +), 480 + 200)
    }
}
