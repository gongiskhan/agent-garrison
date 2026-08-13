import AVFoundation
import XCTest

@testable import GarrisonApp

/// Exercises the real AudioToolbox Opus codec on the simulator: packet
/// production, the guarded gain normalization (the -21 dBFS lesson), and the
/// end-of-stream flush that stops last-word tails being dropped.
final class OpusEncoderTests: XCTestCase {
    private func makeFormat(rate: Double = 48_000) -> AVAudioFormat {
        AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
    }

    /// ~200 ms of a 440 Hz tone at the given peak amplitude.
    private func toneBuffer(format: AVAudioFormat, peak: Float, frames: AVAudioFrameCount = 9600) -> AVAudioPCMBuffer {
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        let data = buffer.floatChannelData![0]
        for i in 0 ..< Int(frames) {
            data[i] = peak * sin(2 * .pi * 440 * Float(i) / Float(format.sampleRate))
        }
        return buffer
    }

    func testEncodeProducesPackets() throws {
        let format = makeFormat()
        let encoder = try XCTUnwrap(OpusEncoder(inputFormat: format))
        var packets: [Data] = []
        for _ in 0 ..< 5 {
            packets.append(contentsOf: encoder.encode(toneBuffer(format: format, peak: 0.5)))
        }
        // 1 s of audio = ~50 x 20 ms packets, allowing for converter latency.
        XCTAssertGreaterThan(packets.count, 30)
        XCTAssertTrue(packets.allSatisfy { !$0.isEmpty })
    }

    func testGainRisesForQuietInputAndFreezesOnSilence() throws {
        let format = makeFormat()
        let encoder = try XCTUnwrap(OpusEncoder(inputFormat: format))
        // Quiet speech-level input (-40 dBFS): gain must climb toward the cap.
        for _ in 0 ..< 8 {
            _ = encoder.encode(toneBuffer(format: format, peak: 0.01))
        }
        XCTAssertEqual(encoder.gain, 8, accuracy: 0.01, "quiet input should reach the +18 dB cap")
        // Near-silence must not change the gain (no noise pumping).
        let before = encoder.gain
        _ = encoder.encode(toneBuffer(format: format, peak: 0.0005))
        XCTAssertEqual(encoder.gain, before)
        // Loud input drops the gain immediately (fast attack down).
        _ = encoder.encode(toneBuffer(format: format, peak: 0.9))
        XCTAssertLessThan(encoder.gain, 1.01)
    }

    func testFlushDrainsTailAndFinishesEncoder() throws {
        let format = makeFormat()
        let encoder = try XCTUnwrap(OpusEncoder(inputFormat: format))
        _ = encoder.encode(toneBuffer(format: format, peak: 0.5))
        let tail = encoder.flush()
        // The converter holds a partial frame + SRC filter tail; flushing after
        // real input must produce at least one packet.
        XCTAssertFalse(tail.isEmpty)
        // Finished: further encodes and flushes are inert, not crashes.
        XCTAssertTrue(encoder.encode(toneBuffer(format: format, peak: 0.5)).isEmpty)
        XCTAssertTrue(encoder.flush().isEmpty)
    }

    func testInputFormatExposedForChangeDetection() throws {
        let f48 = makeFormat(rate: 48_000)
        let f44 = makeFormat(rate: 44_100)
        let encoder = try XCTUnwrap(OpusEncoder(inputFormat: f48))
        XCTAssertEqual(encoder.inputFormat, f48)
        XCTAssertNotEqual(encoder.inputFormat, f44)
    }
}
