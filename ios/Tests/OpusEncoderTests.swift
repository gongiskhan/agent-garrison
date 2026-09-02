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

    func testGainAdaptsToSpeechOnlyAndNeverPumpsNoise() throws {
        let format = makeFormat()
        let encoder = try XCTUnwrap(OpusEncoder(inputFormat: format))
        // Quiet speech-level input (-34 dBFS): the scene gain climbs smoothly.
        for _ in 0 ..< 20 {
            _ = encoder.encode(toneBuffer(format: format, peak: 0.02))
        }
        XCTAssertGreaterThan(encoder.gain, 3, "quiet speech should raise the scene gain")
        XCTAssertLessThanOrEqual(encoder.gain, 8.01, "never past the +18 dB cap")
        // Sub-speech input (noise floor) must not move the gain at all - the
        // 2026-08-14 wall-of-noise regression was exactly this pumping.
        let before = encoder.gain
        for _ in 0 ..< 10 {
            _ = encoder.encode(toneBuffer(format: format, peak: 0.005))
        }
        XCTAssertEqual(encoder.gain, before)
        // Loud input triggers the instant anti-clip.
        _ = encoder.encode(toneBuffer(format: format, peak: 0.9))
        XCTAssertLessThan(encoder.gain, 1.2)
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
