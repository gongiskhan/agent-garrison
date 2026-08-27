import Foundation

/// BLE audio packet framing per docs/pendant-protocol.md section 3. Every
/// notification on the audio data characteristic is:
///
///   bytes 0-1 : packet id, UInt16 little-endian, +1 per notification,
///               wraps at 65536
///   byte  2   : frame index within the current codec frame; 0 marks the
///               first fragment of a new frame
///   bytes 3.. : codec payload fragment
///
/// With Opus frames of at most 160 bytes and a normal MTU, one codec frame
/// fits one notification and byte 2 is almost always 0 - but fragmentation
/// is legal and the reassembler must handle it.
enum PendantFraming {
    static let headerLength = 3

    static func encode(packetId: UInt16, frameIndex: UInt8, payload: Data) -> Data {
        var out = Data(capacity: headerLength + payload.count)
        out.append(UInt8(packetId & 0xFF))
        out.append(UInt8(packetId >> 8))
        out.append(frameIndex)
        out.append(payload)
        return out
    }

    static func decode(_ data: Data) -> (packetId: UInt16, frameIndex: UInt8, payload: Data)? {
        guard data.count >= headerLength else { return nil }
        let start = data.startIndex
        let packetId = UInt16(data[start]) | (UInt16(data[start + 1]) << 8)
        return (packetId, data[start + 2], data.subdata(in: start + 3 ..< data.endIndex))
    }
}

/// Reassembles BLE notifications into whole codec frames, mirroring the
/// battle-tested upstream state machine (drop-on-gap, no silence insertion,
/// no retransmit - the decoder just sees one fewer frame):
///
/// - frame index 0 closes the pending frame and starts a new one
/// - a non-contiguous packet id, or a non-contiguous non-zero frame index,
///   drops the pending partial frame, counts a loss, and resets; the very
///   packet that revealed the gap still starts a new frame when its frame
///   index is 0
/// - packets shorter than the header are counted malformed and ignored
final class PendantFrameReassembler {
    private(set) var lostFrames = 0
    private(set) var malformedPackets = 0
    private(set) var completedFrames = 0

    private var pending = Data()
    private var started = false
    private var lastPacketId: Int = -1
    private var lastFrameIndex: Int = -1

    /// Feed one raw notification; returns a completed codec frame when one
    /// closed, else nil.
    func feed(_ notification: Data) -> Data? {
        guard let packet = PendantFraming.decode(notification) else {
            malformedPackets += 1
            return nil
        }
        let id = Int(packet.packetId)
        let index = Int(packet.frameIndex)

        if lastPacketId >= 0 {
            let expected = (lastPacketId + 1) % 65536
            let idGap = id != expected
            let indexGap = index != 0 && index != lastFrameIndex + 1
            if idGap || indexGap {
                if started { lostFrames += 1 }
                pending = Data()
                started = false
            }
        }
        lastPacketId = id
        lastFrameIndex = index

        var completed: Data?
        if index == 0 {
            if started, !pending.isEmpty {
                completed = pending
                completedFrames += 1
            }
            pending = packet.payload
            started = true
        } else if started {
            pending.append(packet.payload)
        }
        return completed
    }

    /// Flush the trailing frame (stream end / disconnect - no further packet
    /// will arrive to close it).
    func flush() -> Data? {
        guard started, !pending.isEmpty else { return nil }
        started = false
        let frame = pending
        pending = Data()
        completedFrames += 1
        return frame
    }

    func reset() {
        pending = Data()
        started = false
        lastPacketId = -1
        lastFrameIndex = -1
    }
}
