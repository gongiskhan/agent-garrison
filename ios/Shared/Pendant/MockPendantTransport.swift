import Foundation

/// The in-process pendant: streams Opus fixture packets at real cadence with
/// the real 3-byte BLE framing through the same reassembler the BLE
/// transport uses, reports a scripted features bitmask, records every haptic
/// write with timestamps so tests assert the exact feedback sequence and
/// timing, and can script disconnects, reconnects, low battery, malformed
/// packets, dropped packets, and out-of-order delivery. Runs headless under
/// xcodebuild test on the simulator; also drives the DEBUG pendant fixture
/// mode in the app.
final class MockPendantTransport: DeviceTransport {
    struct HapticWrite {
        let level: PendantHapticLevel
        let at: Date
        /// Milliseconds since connect(), in the mock's scaled clock.
        let sinceConnectMs: Double
    }

    struct Script {
        var codec: PendantCodec = .opusFS320
        /// Consumer-pendant shape by default: haptic yes, speaker no.
        var features: PendantFeatures = [.haptic, .button, .battery, .offlineStorage, .ledDimming, .micGain]
        var batteryLevel: Int = 87
        /// When false, haptic writes fail (a DevKit1: nothing app-triggerable).
        var hapticSupported = true
        /// 1.0 = real cadence; larger = faster playback for slow suites.
        var speed: Double = 1.0
        var connectDelayMs: Double = 30
        /// Scripted mid-stream drop, in fixture-timeline ms.
        var disconnectAtMs: Double?
        /// Reconnect this long after the drop; packets whose ts falls inside
        /// the outage are lost, as on a real live stream.
        var reconnectAfterMs: Double?
        /// Inject a 2-byte runt notification before this packet index.
        var malformedPacketAtIndex: Int?
        /// Deliver packet i+1 before packet i (out-of-order).
        var swapPacketsAtIndex: Int?
        /// Silently skip one notification (a loss the reassembler must count).
        var dropPacketAtIndex: Int?
        /// Battery notify of 8 percent at this timeline ms.
        var lowBatteryAtMs: Double?

        init() {}
    }

    var onConnectionState: ((PendantConnectionState) -> Void)?
    var onAudioFrame: ((PendantAudioFrame) -> Void)?
    var onBattery: ((Int) -> Void)?
    var onButton: ((PendantButtonEvent) -> Void)?
    var onAudioLoss: ((Int) -> Void)?

    private(set) var connectionState: PendantConnectionState = .disconnected
    private(set) var hapticWrites: [HapticWrite] = []
    /// Notifications actually delivered (post-scripting), for harness
    /// self-tests.
    private(set) var deliveredNotifications = 0

    private let packets: [PendantFixturePacket]
    private let script: Script
    private let queue = DispatchQueue(label: "mock-pendant-transport")
    private let reassembler = PendantFrameReassembler()
    private var generation = 0
    private var connectedAt: Date?
    private var reportedLoss = 0

    init(packets: [PendantFixturePacket], script: Script = Script()) {
        self.packets = packets
        self.script = script
    }

    // MARK: - DeviceTransport

    func connect() {
        queue.async { [self] in
            guard connectionState == .disconnected else { return }
            generation += 1
            let thisGeneration = generation
            setState(.connecting)
            schedule(afterMs: script.connectDelayMs, generation: thisGeneration) { [self] in
                connectedAt = Date()
                reassembler.reset()
                setState(.connected)
                streamPackets(from: 0, generation: thisGeneration)
                scheduleScriptedEvents(generation: thisGeneration)
            }
        }
    }

    func disconnect() {
        queue.async { [self] in
            generation += 1
            setState(.disconnected)
        }
    }

    func readCodec(_ completion: @escaping (PendantCodec?) -> Void) {
        queue.async { [self] in completion(connectionState == .connected ? script.codec : nil) }
    }

    func readFeatures(_ completion: @escaping (PendantFeatures) -> Void) {
        queue.async { [self] in completion(connectionState == .connected ? script.features : []) }
    }

    func readBattery(_ completion: @escaping (Int?) -> Void) {
        queue.async { [self] in completion(connectionState == .connected ? script.batteryLevel : nil) }
    }

    func writeHaptic(_ level: PendantHapticLevel, completion: ((Bool) -> Void)?) {
        queue.async { [self] in
            guard connectionState == .connected, script.hapticSupported else {
                completion?(false)
                return
            }
            let now = Date()
            let sinceMs: Double
            if let connectedAt {
                sinceMs = now.timeIntervalSince(connectedAt) * 1000 * script.speed
            } else {
                sinceMs = 0
            }
            hapticWrites.append(HapticWrite(level: level, at: now, sinceConnectMs: sinceMs))
            completion?(true)
        }
    }

    // MARK: - Streaming

    private func streamPackets(from startIndex: Int, generation: Int) {
        guard startIndex < packets.count else { return }
        let baseTs = packets[startIndex].ts
        var index = startIndex
        var packetId: UInt16 = UInt16(truncatingIfNeeded: startIndex)
        while index < packets.count {
            let packet = packets[index]
            let thisIndex = index
            let thisId = packetId
            schedule(afterMs: packet.ts - baseTs, generation: generation) { [self] in
                deliver(packet: packet, index: thisIndex, packetId: thisId, generation: generation)
            }
            index += 1
            packetId &+= 1
        }
    }

    private func deliver(packet: PendantFixturePacket, index: Int, packetId: UInt16, generation gen: Int) {
        guard gen == generation, connectionState == .connected else { return }
        if let dropAt = script.dropPacketAtIndex, dropAt == index { return }
        if let malformedAt = script.malformedPacketAtIndex, malformedAt == index {
            feed(notification: Data([0x00, 0x01]))
        }
        if let swapAt = script.swapPacketsAtIndex {
            // Deliver i+1 at i's slot and i at i+1's slot.
            if swapAt == index, index + 1 < packets.count {
                feed(notification: PendantFraming.encode(packetId: packetId &+ 1, frameIndex: 0, payload: packets[index + 1].bytes))
                return
            }
            if swapAt == index - 1 {
                feed(notification: PendantFraming.encode(packetId: packetId &- 1, frameIndex: 0, payload: packets[index - 1].bytes))
                return
            }
        }
        feed(notification: PendantFraming.encode(packetId: packetId, frameIndex: 0, payload: packet.bytes))
    }

    private func feed(notification: Data) {
        deliveredNotifications += 1
        let frame = reassembler.feed(notification)
        if reassembler.lostFrames != reportedLoss {
            reportedLoss = reassembler.lostFrames
            onAudioLoss?(reportedLoss)
        }
        guard let frame else { return }
        let sinceMs: Double
        if let connectedAt {
            sinceMs = Date().timeIntervalSince(connectedAt) * 1000 * script.speed
        } else {
            sinceMs = 0
        }
        onAudioFrame?(PendantAudioFrame(payload: frame, timestampMs: sinceMs))
    }

    private func scheduleScriptedEvents(generation gen: Int) {
        if let lowAt = script.lowBatteryAtMs {
            schedule(afterMs: lowAt, generation: gen) { [self] in
                onBattery?(8)
            }
        }
        if let dropAt = script.disconnectAtMs {
            schedule(afterMs: dropAt, generation: gen) { [self] in
                generation += 1
                let outageGeneration = generation
                setState(.reconnecting)
                if let backMs = script.reconnectAfterMs {
                    schedule(afterMs: backMs, generation: outageGeneration) { [self] in
                        reassembler.reset()
                        setState(.connected)
                        // Resume the live stream: packets during the outage
                        // are gone; continue from the first packet at or
                        // after the current timeline position.
                        let resumeTs = dropAt + backMs
                        if let resumeIndex = packets.firstIndex(where: { $0.ts >= resumeTs }) {
                            streamPackets(from: resumeIndex, generation: outageGeneration)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Plumbing

    private func setState(_ state: PendantConnectionState) {
        connectionState = state
        onConnectionState?(state)
    }

    private func schedule(afterMs: Double, generation gen: Int, _ work: @escaping () -> Void) {
        let scaled = max(0, afterMs) / max(script.speed, 0.001)
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(scaled))) { [weak self] in
            guard let self, gen == self.generation else { return }
            work()
        }
    }
}
