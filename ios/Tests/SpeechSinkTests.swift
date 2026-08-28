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

    /// A recorder standing in for the clip player. `outcome` is what a fetch
    /// or a playback attempt reports back: false is every real failure mode
    /// collapsed into one - no key, no network, 404, undecodable audio.
    final class RecordingClipPlayer: ClipPlaying {
        var played: [String] = []
        var outcome = true
        var stopped = 0
        func play(path: String, volume: Float, completion: @escaping (Bool) -> Void) {
            played.append(path)
            completion(outcome)
        }
        func stop() { stopped += 1 }
    }

    private func makeSink(now: Date = Date(), clipPlayer: ClipPlaying? = nil) -> SpeechSink {
        let sink = SpeechSink(utterer: utterer, clipPlayer: clipPlayer, defaults: defaults, now: { now })
        sink.onReceipt = { [weak self] receipt in self?.receipts.append(receipt) }
        return sink
    }

    private func ack(
        _ id: String,
        severity: String = "info",
        text: String = "Created a task, test.",
        emittedAt: String? = nil,
        audioPath: String? = nil
    ) -> AckPayload {
        AckPayload(
            id: id,
            kind: "created",
            severity: severity,
            templateId: "card.created",
            text: text,
            cardId: nil,
            idempotencyKey: nil,
            emittedAt: emittedAt,
            audioPath: audioPath,
            lang: nil
        )
    }

    private func cue(
        _ text: String = "Sim?",
        lang: String? = "pt",
        audioPath: String? = nil,
        at: Date? = nil
    ) -> SpeechSink.Cue {
        SpeechSink.Cue(eventId: "ev-1", text: text, lang: lang, audioPath: audioPath, at: at)
    }

    // Zeca's own voice, when the service managed to render one.
    func testPlaysTheRenderedClipInsteadOfSynthesizing() {
        let clips = RecordingClipPlayer()
        let sink = makeSink(clipPlayer: clips)
        sink.handle(ack("v1", audioPath: "/speak/abc123.mp3"))
        XCTAssertEqual(clips.played, ["/speak/abc123.mp3"])
        XCTAssertEqual(utterer.spoken, [], "the on-device voice must stay quiet when a clip played")
        XCTAssertEqual(receipts.map(\.ok), [true])
    }

    // ...and the whole point of the fallback: a nicer voice must never be able
    // to COST an acknowledgement. A wearer who hears nothing cannot tell "the
    // clip failed" from "it never heard me", and that ambiguity is the one this
    // app has already been bitten by.
    func testFallsBackToTheOnDeviceVoiceWhenTheClipFails() {
        let clips = RecordingClipPlayer()
        clips.outcome = false
        let sink = makeSink(clipPlayer: clips)
        sink.handle(ack("v2", text: "Criei a tarefa.", audioPath: "/speak/dead.mp3"))
        XCTAssertEqual(clips.played, ["/speak/dead.mp3"])
        XCTAssertEqual(utterer.spoken, ["Criei a tarefa."])
        utterer.finishNext()
        XCTAssertEqual(receipts.map(\.ok), [true])
    }

    // No clip offered is the old path, unchanged.
    func testSynthesizesWhenNoClipWasRendered() {
        let clips = RecordingClipPlayer()
        let sink = makeSink(clipPlayer: clips)
        sink.handle(ack("v3", text: "On it."))
        XCTAssertEqual(clips.played, [])
        XCTAssertEqual(utterer.spoken, ["On it."])
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

    // MARK: - Cues

    // The wearer said "Zeca" and heard nothing for 25 seconds. The cue is the
    // answer to "did you hear me", so it is spoken the instant the wake word
    // lands - and its whole value is being immediate.
    func testSpeaksAWakeCue() {
        let sink = makeSink()
        sink.speakCue(cue())
        XCTAssertEqual(utterer.spoken, ["Sim?"])
    }

    func testPrefersTheRenderedClipForACue() {
        let clips = RecordingClipPlayer()
        let sink = makeSink(clipPlayer: clips)
        sink.speakCue(cue(audioPath: "/speak/abc.mp3"))
        XCTAssertEqual(clips.played, ["/speak/abc.mp3"])
        XCTAssertTrue(utterer.spoken.isEmpty)
    }

    func testFallsBackToTheSynthesizerWhenTheCueClipFails() {
        let clips = RecordingClipPlayer()
        clips.outcome = false
        let sink = makeSink(clipPlayer: clips)
        sink.speakCue(cue(audioPath: "/speak/abc.mp3"))
        XCTAssertEqual(utterer.spoken, ["Sim?"], "a failed clip must still be heard, in the phone's own voice")
    }

    // A cue behind something else is worthless - by the time it is spoken the
    // wearer has moved on, and it sounds like an answer to a different
    // sentence. So it is dropped, and crucially the ack queue is untouched.
    func testACueNeverQueuesAndNeverDisturbsTheAckQueue() {
        let sink = makeSink()
        sink.handle(ack("a1", text: "Created a task, one."))
        XCTAssertEqual(utterer.spoken, ["Created a task, one."])
        sink.speakCue(cue())
        XCTAssertEqual(utterer.spoken, ["Created a task, one."], "the cue was dropped, not queued")
        sink.handle(ack("a2", text: "Created a task, two."))
        utterer.finishNext()
        XCTAssertEqual(utterer.spoken, ["Created a task, one.", "Created a task, two."])
        XCTAssertFalse(receipts.contains { $0.ackId == "ev-1" }, "a cue is not an ack and writes no receipt")
    }

    // 2.5s, not the ack's 30s. "Sim?" arriving three seconds late reads as a
    // reply to whatever you said next.
    func testDropsAStaleCue() {
        let now = Date()
        let sink = makeSink(now: now)
        sink.speakCue(cue(at: now.addingTimeInterval(-10)))
        XCTAssertTrue(utterer.spoken.isEmpty)
        sink.speakCue(cue(at: now.addingTimeInterval(-1)))
        XCTAssertEqual(utterer.spoken, ["Sim?"])
    }

    func testMasterSwitchAndMuteSilenceCues() {
        defaults.set(false, forKey: AppGroup.Key.speakMaster)
        makeSink().speakCue(cue())
        XCTAssertTrue(utterer.spoken.isEmpty)

        defaults.set(true, forKey: AppGroup.Key.speakMaster)
        defaults.set(Date().addingTimeInterval(600).timeIntervalSince1970, forKey: AppGroup.Key.muteUntil)
        makeSink().speakCue(cue())
        XCTAssertTrue(utterer.spoken.isEmpty)
    }

    func testTheCueToggleSilencesCuesOnly() {
        defaults.set(false, forKey: AppGroup.Key.speakCues)
        let sink = makeSink()
        sink.speakCue(cue())
        XCTAssertTrue(utterer.spoken.isEmpty)
        sink.handle(ack("a1"))
        XCTAssertEqual(utterer.spoken.count, 1, "acks are unaffected by the cue toggle")
    }

    // The one deliberate departure from the ack rules. speak.info means "the
    // operative's routine created/finished chatter"; someone who muted that
    // still wants to know they were HEARD.
    func testCuesSpeakEvenWhenInfoAcksAreMuted() {
        defaults.set(false, forKey: AppGroup.Key.speakInfo)
        let sink = makeSink()
        sink.handle(ack("a1"))
        XCTAssertTrue(utterer.spoken.isEmpty, "the info ack is muted")
        sink.speakCue(cue())
        XCTAssertEqual(utterer.spoken, ["Sim?"])
    }

    // Speaking Portuguese through an English synthesizer voice is the
    // language-mixing bug one layer down, and it is invisible until you hear it.
    func testPicksAVoiceMatchingTheLanguage() {
        XCTAssertNotEqual(SpeechSink.localVoice(for: "pt"), SpeechSink.localVoice(for: "en"))
        XCTAssertNil(SpeechSink.localVoice(for: nil))
        XCTAssertNil(SpeechSink.localVoice(for: "de"))
    }
}
