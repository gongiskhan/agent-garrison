import XCTest
@testable import GarrisonApp

/// Self-tests for the pendant mock harness layer 1: the BLE framing, the
/// drop-on-gap reassembler, the fixture loader, and MockPendantTransport's
/// scripted scenarios and haptic write log. The real BLE transport is
/// covered separately against the CoreBluetoothMock scripted peripheral.
final class PendantFramingTests: XCTestCase {
    func testEncodeDecodeRoundTrip() {
        let payload = Data([0xAA, 0xBB, 0xCC])
        let framed = PendantFraming.encode(packetId: 0x1234, frameIndex: 2, payload: payload)
        XCTAssertEqual(framed.count, 3 + payload.count)
        XCTAssertEqual(Array(framed.prefix(3)), [0x34, 0x12, 2])
        let decoded = PendantFraming.decode(framed)
        XCTAssertEqual(decoded?.packetId, 0x1234)
        XCTAssertEqual(decoded?.frameIndex, 2)
        XCTAssertEqual(decoded?.payload, payload)
    }

    func testDecodeRejectsRunt() {
        XCTAssertNil(PendantFraming.decode(Data([0x01, 0x02])))
    }

    func testSingleNotificationFramesCloseOnNextIndexZero() {
        let reassembler = PendantFrameReassembler()
        XCTAssertNil(reassembler.feed(PendantFraming.encode(packetId: 0, frameIndex: 0, payload: Data([1]))))
        let first = reassembler.feed(PendantFraming.encode(packetId: 1, frameIndex: 0, payload: Data([2])))
        XCTAssertEqual(first, Data([1]))
        let second = reassembler.feed(PendantFraming.encode(packetId: 2, frameIndex: 0, payload: Data([3])))
        XCTAssertEqual(second, Data([2]))
        XCTAssertEqual(reassembler.flush(), Data([3]))
        XCTAssertEqual(reassembler.lostFrames, 0)
        XCTAssertEqual(reassembler.completedFrames, 3)
    }

    func testFragmentedFrameReassembles() {
        let reassembler = PendantFrameReassembler()
        XCTAssertNil(reassembler.feed(PendantFraming.encode(packetId: 10, frameIndex: 0, payload: Data([1, 2]))))
        XCTAssertNil(reassembler.feed(PendantFraming.encode(packetId: 11, frameIndex: 1, payload: Data([3, 4]))))
        XCTAssertNil(reassembler.feed(PendantFraming.encode(packetId: 12, frameIndex: 2, payload: Data([5]))))
        let closed = reassembler.feed(PendantFraming.encode(packetId: 13, frameIndex: 0, payload: Data([9])))
        XCTAssertEqual(closed, Data([1, 2, 3, 4, 5]))
    }

    func testPacketIdGapDropsPendingFrame() {
        let reassembler = PendantFrameReassembler()
        XCTAssertNil(reassembler.feed(PendantFraming.encode(packetId: 0, frameIndex: 0, payload: Data([1]))))
        // Packet 1 lost; packet 2 arrives and still starts a fresh frame.
        XCTAssertNil(reassembler.feed(PendantFraming.encode(packetId: 2, frameIndex: 0, payload: Data([3]))))
        XCTAssertEqual(reassembler.lostFrames, 1)
        let closed = reassembler.feed(PendantFraming.encode(packetId: 3, frameIndex: 0, payload: Data([4])))
        XCTAssertEqual(closed, Data([3]))
    }

    func testFrameIndexGapDropsPendingFrame() {
        let reassembler = PendantFrameReassembler()
        XCTAssertNil(reassembler.feed(PendantFraming.encode(packetId: 0, frameIndex: 0, payload: Data([1]))))
        // Fragment 1 lost: index jumps 0 -> 2 with contiguous packet ids.
        XCTAssertNil(reassembler.feed(PendantFraming.encode(packetId: 1, frameIndex: 2, payload: Data([2]))))
        XCTAssertEqual(reassembler.lostFrames, 1)
        XCTAssertNil(reassembler.flush())
    }

    func testPacketIdWrapsAt65536WithoutLoss() {
        let reassembler = PendantFrameReassembler()
        XCTAssertNil(reassembler.feed(PendantFraming.encode(packetId: 65535, frameIndex: 0, payload: Data([1]))))
        let closed = reassembler.feed(PendantFraming.encode(packetId: 0, frameIndex: 0, payload: Data([2])))
        XCTAssertEqual(closed, Data([1]))
        XCTAssertEqual(reassembler.lostFrames, 0)
    }

    func testMalformedPacketCountedAndIgnored() {
        let reassembler = PendantFrameReassembler()
        XCTAssertNil(reassembler.feed(Data([0x00])))
        XCTAssertEqual(reassembler.malformedPackets, 1)
        XCTAssertNil(reassembler.feed(PendantFraming.encode(packetId: 5, frameIndex: 0, payload: Data([1]))))
        XCTAssertEqual(reassembler.flush(), Data([1]))
    }
}

final class PendantFixtureTests: XCTestCase {
    func testParsesJsonlPackets() throws {
        let text = """
        {"seq": 1, "ts": 0, "bytes": "AQI="}
        {"seq": 2, "ts": 20, "bytes": "AwQ="}
        """
        let packets = try PendantFixture.parse(text)
        XCTAssertEqual(packets.count, 2)
        XCTAssertEqual(packets[0].bytes, Data([1, 2]))
        XCTAssertEqual(packets[1].ts, 20)
    }

    func testBadLineThrows() {
        XCTAssertThrowsError(try PendantFixture.parse("{\"seq\": 1}"))
    }
}

final class MockPendantTransportTests: XCTestCase {
    /// Every transport a test starts, stopped here. MockPendantTransport keeps
    /// streaming on its own timer after a test's wait returns, so a leaked one
    /// goes on firing callbacks into whatever test runs NEXT. That surfaces as
    /// an over-fulfilled expectation crashing an unrelated case - the failure
    /// is reported against the innocent test, and it only appears when timing
    /// shifts, which is what makes it look like flakiness.
    private var startedTransports: [MockPendantTransport] = []

    override func tearDown() {
        for transport in startedTransports { transport.disconnect() }
        startedTransports.removeAll()
        super.tearDown()
    }

    private func makeTransport(
        packets: [PendantFixturePacket],
        script: MockPendantTransport.Script
    ) -> MockPendantTransport {
        let transport = MockPendantTransport(packets: packets, script: script)
        startedTransports.append(transport)
        return transport
    }

    private func packets(_ count: Int, stepMs: Double = 20) -> [PendantFixturePacket] {
        (0 ..< count).map { i in
            PendantFixturePacket(seq: i + 1, ts: Double(i) * stepMs, bytes: Data([UInt8(i % 256), 0xEE]))
        }
    }

    private func fastScript() -> MockPendantTransport.Script {
        var script = MockPendantTransport.Script()
        script.speed = 50
        script.connectDelayMs = 1
        return script
    }

    func testStreamsFixtureFramesInOrder() {
        let transport = makeTransport(packets: packets(20), script: fastScript())
        let done = expectation(description: "frames")
        var frames: [Data] = []
        transport.onAudioFrame = { frame in
            frames.append(frame.payload)
            if frames.count == 19 { done.fulfill() }
        }
        transport.connect()
        wait(for: [done], timeout: 5)
        // The trailing frame stays pending until the next index-0 packet; a
        // live stream never "ends", so 19 of 20 close during playback.
        XCTAssertEqual(frames.prefix(3), [Data([0, 0xEE]), Data([1, 0xEE]), Data([2, 0xEE])])
    }

    func testRecordsHapticWritesWithTimestamps() {
        let transport = makeTransport(packets: [], script: fastScript())
        let connected = expectation(description: "connected")
        transport.onConnectionState = { if $0 == .connected { connected.fulfill() } }
        transport.connect()
        wait(for: [connected], timeout: 5)
        let wrote = expectation(description: "haptic")
        transport.writeHaptic(.medium) { ok in
            XCTAssertTrue(ok)
            wrote.fulfill()
        }
        wait(for: [wrote], timeout: 5)
        XCTAssertEqual(transport.hapticWrites.map(\.level), [.medium])
        XCTAssertGreaterThanOrEqual(transport.hapticWrites[0].sinceConnectMs, 0)
    }

    func testHapticUnsupportedFailsWrite() {
        var script = fastScript()
        script.hapticSupported = false
        let transport = makeTransport(packets: [], script: script)
        let connected = expectation(description: "connected")
        transport.onConnectionState = { if $0 == .connected { connected.fulfill() } }
        transport.connect()
        wait(for: [connected], timeout: 5)
        let wrote = expectation(description: "haptic")
        transport.writeHaptic(.long) { ok in
            XCTAssertFalse(ok)
            wrote.fulfill()
        }
        wait(for: [wrote], timeout: 5)
        XCTAssertTrue(transport.hapticWrites.isEmpty)
    }

    func testMalformedInjectionCountsWithoutBreakingStream() {
        var script = fastScript()
        script.malformedPacketAtIndex = 3
        let transport = makeTransport(packets: packets(10), script: script)
        let done = expectation(description: "frames")
        var frameCount = 0
        transport.onAudioFrame = { _ in
            frameCount += 1
            if frameCount == 9 { done.fulfill() }
        }
        transport.connect()
        wait(for: [done], timeout: 5)
    }

    func testDroppedPacketCountsOneLoss() {
        var script = fastScript()
        script.dropPacketAtIndex = 4
        let transport = makeTransport(packets: packets(10), script: script)
        let loss = expectation(description: "loss")
        loss.assertForOverFulfill = false
        transport.onAudioLoss = { lost in
            if lost == 1 { loss.fulfill() }
        }
        transport.connect()
        wait(for: [loss], timeout: 5)
    }

    func testOutOfOrderDeliveryCountsLoss() {
        var script = fastScript()
        script.swapPacketsAtIndex = 4
        let transport = makeTransport(packets: packets(10), script: script)
        let loss = expectation(description: "loss")
        // Cumulative loss keeps climbing, so this predicate matches again on
        // every later report.
        loss.assertForOverFulfill = false
        transport.onAudioLoss = { lost in
            if lost >= 1 { loss.fulfill() }
        }
        transport.connect()
        wait(for: [loss], timeout: 5)
    }

    func testScriptedDisconnectAndReconnectResumesLive() {
        var script = fastScript()
        script.disconnectAtMs = 60
        script.reconnectAfterMs = 40
        let transport = makeTransport(packets: packets(20), script: script)
        var states: [PendantConnectionState] = []
        let reconnected = expectation(description: "reconnected")
        transport.onConnectionState = { state in
            states.append(state)
            if states.contains(.reconnecting), state == .connected { reconnected.fulfill() }
        }
        let resumed = expectation(description: "post-outage frame")
        resumed.assertForOverFulfill = false
        transport.onAudioFrame = { frame in
            if frame.timestampMs > 100 { resumed.fulfill() }
        }
        transport.connect()
        wait(for: [reconnected, resumed], timeout: 5)
        XCTAssertEqual(states.filter { $0 == .connected }.count, 2)
    }

    func testLowBatteryEventFires() {
        var script = fastScript()
        script.lowBatteryAtMs = 30
        let transport = makeTransport(packets: packets(5), script: script)
        let low = expectation(description: "battery")
        transport.onBattery = { level in
            if level == 8 { low.fulfill() }
        }
        transport.connect()
        wait(for: [low], timeout: 5)
    }

    func testReadsCodecFeaturesBattery() {
        let transport = makeTransport(packets: [], script: fastScript())
        let connected = expectation(description: "connected")
        transport.onConnectionState = { if $0 == .connected { connected.fulfill() } }
        transport.connect()
        wait(for: [connected], timeout: 5)
        let reads = expectation(description: "reads")
        reads.expectedFulfillmentCount = 3
        transport.readCodec { codec in
            XCTAssertEqual(codec, .opusFS320)
            reads.fulfill()
        }
        transport.readFeatures { features in
            XCTAssertTrue(features.contains(.haptic))
            XCTAssertFalse(features.contains(.speaker))
            reads.fulfill()
        }
        transport.readBattery { level in
            XCTAssertEqual(level, 87)
            reads.fulfill()
        }
        wait(for: [reads], timeout: 5)
    }
}
