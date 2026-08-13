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
}
