import XCTest
@testable import GarrisonApp

final class CaptureProtocolTests: XCTestCase {
    func testFramingRoundTrip() throws {
        let payload = Data([0x01, 0x02, 0x03, 0xFF])
        let frame = CaptureFraming.encode(kind: .audio, seq: 42, ts: 1234.5, payload: payload)
        XCTAssertEqual(frame.count, CaptureFraming.headerLength + payload.count)
        let decoded = try XCTUnwrap(CaptureFraming.decode(frame))
        XCTAssertEqual(decoded.kind, .audio)
        XCTAssertEqual(decoded.seq, 42)
        XCTAssertEqual(decoded.ts, 1234.5, accuracy: 0.001)
        XCTAssertEqual(decoded.payload, payload)

        // The exact byte layout the server parses: kind u8, seq u32 LE,
        // ts f64 LE, len u32 LE.
        XCTAssertEqual(frame[0], 0)
        XCTAssertEqual(frame[1], 42)
        XCTAssertEqual(Array(frame[13 ..< 17]), [4, 0, 0, 0])
    }

    func testFramingRejectsGarbage() {
        XCTAssertNil(CaptureFraming.decode(Data([0, 1, 2])))
        var frame = CaptureFraming.encode(kind: .video, seq: 1, ts: 0, payload: Data([1, 2, 3]))
        frame.removeLast() // length no longer matches
        XCTAssertNil(CaptureFraming.decode(frame))
    }

    func testControlMessageWireShapes() throws {
        let start = SessionStartMessage(sessionId: "01TESTSESSION0001", mode: "audio", deviceName: "Test", consent: "shown", startedAt: "2026-08-13T10:00:00Z")
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(start), encoding: .utf8))
        XCTAssertTrue(json.contains("\"session_id\":\"01TESTSESSION0001\""))
        XCTAssertTrue(json.contains("\"device_name\":\"Test\""))
        XCTAssertTrue(json.contains("\"started_at\""))
        XCTAssertTrue(json.contains("\"type\":\"session_start\""))

        let receipt = SpokenReceiptMessage(spoken: "ack-1", ok: false, reason: "muted")
        let receiptJson = try XCTUnwrap(String(data: JSONEncoder().encode(receipt), encoding: .utf8))
        XCTAssertTrue(receiptJson.contains("\"spoken\":\"ack-1\""))
        XCTAssertTrue(receiptJson.contains("\"reason\":\"muted\""))
    }

    func testServerMessageParsing() throws {
        guard case .sessionResumed(_, let audio, let video)? =
            ServerMessage.parse(#"{"type":"session_resumed","session_id":"S","audio_seq":7,"video_seq":2}"#)
        else { return XCTFail("expected session_resumed") }
        XCTAssertEqual(audio, 7)
        XCTAssertEqual(video, 2)

        guard case .ack(let stream, let seq)? = ServerMessage.parse(#"{"type":"ack","stream":"audio","seq":9}"#)
        else { return XCTFail("expected ack") }
        XCTAssertEqual(stream, "audio")
        XCTAssertEqual(seq, 9)

        guard case .speak(let ack)? = ServerMessage.parse(
            #"{"type":"speak","ack":{"id":"a1","kind":"created","severity":"info","text":"Created a task, test.","idempotencyKey":"k"}}"#
        ) else { return XCTFail("expected speak") }
        XCTAssertEqual(ack.id, "a1")
        XCTAssertEqual(ack.text, "Created a task, test.")

        XCTAssertNil(ServerMessage.parse("not json"))
        XCTAssertNil(ServerMessage.parse(#"{"type":"unknown-kind"}"#))
    }

    func testSessionIdMatchesServerCharset() {
        for _ in 0 ..< 50 {
            let id = SessionId.generate()
            XCTAssertTrue(id.range(of: "^[A-Za-z0-9_-]{10,40}$", options: .regularExpression) != nil, id)
        }
        XCTAssertNotEqual(SessionId.generate(), SessionId.generate())
    }

    // The EXACT frame the server emits once a cue is attached, from
    // scripts/server.mjs: {type:"feedback", event:{...event, speak}}. Pinned
    // with real bytes because a silently-failing decode here is invisible -
    // parse() returns nil and the phone simply stays quiet, which is
    // indistinguishable from "the server sent nothing".
    func testDecodesAFeedbackEventCarryingASpokenCue() {
        let json = """
        {"type":"feedback","event":{"event_id":"01K9","name":"wake_detected",        "session_id":"01SESS","at":"2026-08-28T09:00:00.000Z",        "speak":{"text":"Sim?","lang":"pt","audio_path":"/speak/fb04e04c.mp3","priority":"cue"}}}
        """
        guard case .feedback(let event)? = ServerMessage.parse(json) else {
            return XCTFail("a feedback frame carrying a cue must still decode")
        }
        XCTAssertEqual(event.name, "wake_detected")
        XCTAssertEqual(event.speak?.text, "Sim?")
        XCTAssertEqual(event.speak?.lang, "pt")
        XCTAssertEqual(event.speak?.audioPath, "/speak/fb04e04c.mp3")
    }

    // Backwards compatibility in the other direction: an older server, or any
    // event with no cue, must still decode rather than dropping the haptic.
    func testDecodesAFeedbackEventWithNoCue() {
        let json = """
        {"type":"feedback","event":{"event_id":"01K9","name":"task_created",        "session_id":"01SESS","at":"2026-08-28T09:00:00.000Z","title":"comprar pao"}}
        """
        guard case .feedback(let event)? = ServerMessage.parse(json) else {
            return XCTFail("an event with no cue must still decode")
        }
        XCTAssertNil(event.speak)
        XCTAssertEqual(event.title, "comprar pao")
    }

    // The ack lane gained `lang`; an ack without it must keep decoding.
    func testDecodesAnAckWithAndWithoutLanguage() {
        let withLang = """
        {"type":"speak","ack":{"id":"a1","text":"Criei uma tarefa: pao.","lang":"pt"}}
        """
        guard case .speak(let a)? = ServerMessage.parse(withLang) else { return XCTFail("ack with lang") }
        XCTAssertEqual(a.lang, "pt")
        let noLang = """
        {"type":"speak","ack":{"id":"a2","text":"Created a task, bread."}}
        """
        guard case .speak(let b)? = ServerMessage.parse(noLang) else { return XCTFail("ack without lang") }
        XCTAssertNil(b.lang)
    }
}
