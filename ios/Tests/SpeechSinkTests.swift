import XCTest
@testable import GarrisonApp

/// A recorder standing in for AVSpeechSynthesizer: utterances complete only
/// when the test says so, which is how the queue policy becomes observable.
final class FakeUtterer: Utterer {
    var spoken: [String] = []
    private var completions: [(Bool) -> Void] = []

    func utter(_ text: String, rate: Float, volume: Float, voiceId: String?, completion: @escaping (Bool) -> Void) {
        spoken.append(text)
        completions.append(completion)
    }

    func stop() {}

    func finishNext(_ ok: Bool = true) {
        guard !completions.isEmpty else { return }
        completions.removeFirst()(ok)
    }

    func finishAll() {
        while !completions.isEmpty { finishNext() }
    }
}

final class SpeechSinkTests: XCTestCase {
    private var defaults: UserDefaults!
    private var utterer: FakeUtterer!
    private var receipts: [SpeechSink.Receipt] = []

    override func setUp() {
        defaults = UserDefaults(suiteName: "speech-sink-tests-\(UUID().uuidString)")
        utterer = FakeUtterer()
        receipts = []
    }

    private func makeSink(now: Date = Date()) -> SpeechSink {
        let sink = SpeechSink(utterer: utterer, defaults: defaults, now: { now })
        sink.onReceipt = { [weak self] receipt in self?.receipts.append(receipt) }
        return sink
    }

    private func ack(_ id: String, severity: String = "info", text: String = "Created a task, test.", emittedAt: String? = nil) -> AckPayload {
        AckPayload(id: id, kind: "created", severity: severity, templateId: "card.created", text: text, cardId: nil, idempotencyKey: nil, emittedAt: emittedAt)
    }

    func testSpeaksTextVerbatimAndReportsReceipt() {
        let sink = makeSink()
        sink.handle(ack("a1", text: "Created a task, hello companion."))
        XCTAssertEqual(utterer.spoken, ["Created a task, hello companion."])
        utterer.finishNext()
        XCTAssertEqual(receipts.map(\.ackId), ["a1"])
        XCTAssertTrue(receipts[0].ok)
    }

    func testTenAcksInFiveSecondsDoNotProduceTenSentences() {
        let sink = makeSink()
        // The first ack starts speaking immediately (slowly); nine more pile up.
        for i in 1 ... 10 { sink.handle(ack("a\(i)")) }
        utterer.finishAll()
        // One speaking + a ceiling of 3 queued: at most 4 sentences total.
        XCTAssertLessThanOrEqual(utterer.spoken.count, SpeechSink.queueCeiling + 1)
        let dropped = receipts.filter { $0.reason == "queue-overflow" }
        XCTAssertEqual(dropped.count + utterer.spoken.count, 10)
    }

    func testCeilingNeverSacrificesAnError() {
        let sink = makeSink()
        sink.handle(ack("busy")) // occupies the utterer
        sink.handle(ack("e1", severity: "error", text: "Could not finish the report."))
        for i in 1 ... 5 { sink.handle(ack("i\(i)")) }
        utterer.finishAll()
        XCTAssertTrue(utterer.spoken.contains("Could not finish the report."))
        XCTAssertFalse(receipts.contains { $0.ackId == "e1" && $0.reason == "queue-overflow" })
    }

    func testStaleAcksAreDroppedHonestly() {
        let now = Date()
        let sink = makeSink(now: now)
        let old = ISO8601DateFormatter().string(from: now.addingTimeInterval(-45))
        sink.handle(ack("stale1", emittedAt: old))
        XCTAssertTrue(utterer.spoken.isEmpty)
        XCTAssertEqual(receipts.first?.reason, "stale")

        let fresh = ISO8601DateFormatter().string(from: now.addingTimeInterval(-5))
        sink.handle(ack("fresh1", emittedAt: fresh))
        XCTAssertEqual(utterer.spoken.count, 1)
    }

    func testMasterAndInfoTogglesWithErrorOverride() {
        defaults.set(false, forKey: AppGroup.Key.speakMaster)
        var sink = makeSink()
        sink.handle(ack("m1"))
        sink.handle(ack("m2", severity: "error"))
        XCTAssertTrue(utterer.spoken.isEmpty) // master off silences EVERYTHING
        XCTAssertEqual(receipts.map(\.reason), ["sink-off", "sink-off"])

        defaults.set(true, forKey: AppGroup.Key.speakMaster)
        defaults.set(false, forKey: AppGroup.Key.speakInfo)
        receipts = []
        sink = makeSink()
        sink.handle(ack("i1"))
        sink.handle(ack("e1", severity: "error", text: "Stopped on the report, it needs you."))
        XCTAssertEqual(utterer.spoken, ["Stopped on the report, it needs you."]) // errors break through
        XCTAssertEqual(receipts.first?.reason, "info-muted")
    }

    func testMuteForMinutesAndQuietHours() {
        defaults.set(Date().addingTimeInterval(600).timeIntervalSince1970, forKey: AppGroup.Key.muteUntil)
        var sink = makeSink()
        sink.handle(ack("m1"))
        XCTAssertEqual(receipts.first?.reason, "muted")
        sink.handle(ack("e1", severity: "error", text: "Could not connect to Trello."))
        XCTAssertEqual(utterer.spoken, ["Could not connect to Trello."]) // errors still speak

        defaults.set(0.0, forKey: AppGroup.Key.muteUntil)
        let hour = Calendar.current.component(.hour, from: Date())
        defaults.set(hour, forKey: AppGroup.Key.quietHoursStart)
        defaults.set((hour + 1) % 24, forKey: AppGroup.Key.quietHoursEnd)
        receipts = []
        sink = makeSink()
        sink.handle(ack("q1"))
        XCTAssertEqual(receipts.first?.reason, "muted")
    }
}
