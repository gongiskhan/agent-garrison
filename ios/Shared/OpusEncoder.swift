import AVFoundation
import CoreMedia

/// PCM -> raw Opus packets, 16 kHz mono ~20 ms frames — exactly what the wire
/// protocol carries and what the service hands Deepgram (`encoding=opus`).
/// One AVAudioConverter does both the sample-rate conversion (mic native,
/// typically 48 kHz Float32) and the encode. Used by the app's AVAudioEngine
/// tap AND the broadcast extension's CMSampleBuffer path.
final class OpusEncoder {
    private let converter: AVAudioConverter
    /// Exposed so callers can detect a mid-stream format change (route change,
    /// headset connect) and rebuild the encoder instead of feeding a converter
    /// whose input format no longer matches.
    let inputFormat: AVAudioFormat
    private let outputFormat: AVAudioFormat
    private var pending: [AVAudioPCMBuffer] = []
    /// Buffers discarded because the converter errored — surfaced instead of
    /// silently growing `pending` while the UI says live.
    private(set) var droppedBuffers: Int = 0
    private var flushed = false

    // Guarded input normalization. 2026-08-13 forensics on real captured
    // sessions: speech peaked at -21 dBFS (under 10% of full scale) and the
    // same audio normalized +18 dB lifted transcription confidence from 0.92
    // to 0.99 and fixed a verb misrecognition. The mic level itself is not
    // settable on iPhones, so gain is applied here, before the encode:
    // target peak -12 dBFS, capped at 8x (+18 dB), hard-clamped so it can
    // never clip, and frozen during near-silence so noise floors are not
    // pumped up between utterances.
    private(set) var gain: Float = 1
    private let targetPeak: Float = 0.25 // -12 dBFS
    private let maxGain: Float = 8 // +18 dB
    private let silenceFloor: Float = 0.001

    init?(inputFormat: AVAudioFormat) {
        guard let opusFormat = AVAudioFormat(settings: [
            AVFormatIDKey: kAudioFormatOpus,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1
        ]) else { return nil }
        guard let converter = AVAudioConverter(from: inputFormat, to: opusFormat) else { return nil }
        self.inputFormat = inputFormat
        self.outputFormat = opusFormat
        self.converter = converter
        // 24k VBR measured ~18 kbps effective on speech — below the 24-32k
        // band where Opus wideband stops smearing consonants. Constant 32k
        // keeps every frame in the safe band; ~4 KB/s is nothing to the spool.
        converter.bitRate = 32_000
        converter.bitRateStrategy = AVAudioBitRateStrategy_Constant
        converter.sampleRateConverterQuality = AVAudioQuality.max.rawValue
    }

    /// Encode one PCM buffer; returns zero or more complete Opus packets
    /// (the converter buffers partial frames internally).
    func encode(_ buffer: AVAudioPCMBuffer) -> [Data] {
        guard !flushed else { return [] }
        normalize(buffer)
        pending.append(buffer)
        var packets: [Data] = []
        while true {
            let compressed = AVAudioCompressedBuffer(
                format: outputFormat,
                packetCapacity: 8,
                maximumPacketSize: converter.maximumOutputPacketSize
            )
            var consumedAll = false
            var conversionError: NSError?
            let status = converter.convert(to: compressed, error: &conversionError) { [weak self] _, outStatus in
                guard let self, !self.pending.isEmpty else {
                    consumedAll = true
                    outStatus.pointee = .noDataNow
                    return nil
                }
                outStatus.pointee = .haveData
                return self.pending.removeFirst()
            }
            if conversionError != nil || status == .error {
                // A converter that errors once will error again on the same
                // queue: drop what it will not take so memory stays bounded
                // and the loss is countable, not silent.
                droppedBuffers += pending.count
                pending.removeAll()
                break
            }
            packets.append(contentsOf: Self.extractPackets(from: compressed))
            if compressed.packetCount == 0 || consumedAll { break }
        }
        return packets
    }

    /// Drain the converter's internal state (the partial 20 ms frame plus the
    /// sample-rate converter's filter tail — the end of the last spoken word).
    /// The encoder is finished afterwards: sessions end here, they do not
    /// resume through a drained converter.
    func flush() -> [Data] {
        guard !flushed else { return [] }
        flushed = true
        var packets: [Data] = []
        while true {
            let compressed = AVAudioCompressedBuffer(
                format: outputFormat,
                packetCapacity: 8,
                maximumPacketSize: converter.maximumOutputPacketSize
            )
            var conversionError: NSError?
            let status = converter.convert(to: compressed, error: &conversionError) { [weak self] _, outStatus in
                if let self, !self.pending.isEmpty {
                    outStatus.pointee = .haveData
                    return self.pending.removeFirst()
                }
                outStatus.pointee = .endOfStream
                return nil
            }
            if conversionError != nil || status == .error { break }
            let drained = Self.extractPackets(from: compressed)
            packets.append(contentsOf: drained)
            if status == .endOfStream || drained.isEmpty { break }
        }
        return packets
    }

    private func normalize(_ buffer: AVAudioPCMBuffer) {
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return }
        let channels = Int(buffer.format.channelCount)
        if let ch = buffer.floatChannelData {
            var peak: Float = 0
            for c in 0 ..< channels {
                for i in 0 ..< frames { peak = max(peak, abs(ch[c][i])) }
            }
            updateGain(peak: peak)
            guard gain != 1 else { return }
            for c in 0 ..< channels {
                for i in 0 ..< frames { ch[c][i] = max(-1, min(1, ch[c][i] * gain)) }
            }
        } else if let ch = buffer.int16ChannelData {
            var peak: Float = 0
            for c in 0 ..< channels {
                for i in 0 ..< frames { peak = max(peak, abs(Float(ch[c][i])) / 32768) }
            }
            updateGain(peak: peak)
            guard gain != 1 else { return }
            for c in 0 ..< channels {
                for i in 0 ..< frames {
                    let scaled = Float(ch[c][i]) * gain
                    ch[c][i] = Int16(max(-32768, min(32767, scaled)))
                }
            }
        }
    }

    private func updateGain(peak: Float) {
        guard peak > silenceFloor else { return } // freeze during silence
        let desired = min(maxGain, targetPeak / peak)
        if desired < gain {
            gain = desired // fast attack down: never amplify into the clamp
        } else {
            // Release upward over a few buffers (~0.4 s at tap sizes) so a
            // session's opening wake word is already usable by its second
            // syllable without pumping breath noise to full gain instantly.
            gain = min(gain * 1.5, desired)
        }
    }

    private static func extractPackets(from buffer: AVAudioCompressedBuffer) -> [Data] {
        guard buffer.packetCount > 0, let descriptions = buffer.packetDescriptions else { return [] }
        let base = buffer.data
        var packets: [Data] = []
        for i in 0 ..< Int(buffer.packetCount) {
            let description = descriptions[i]
            let start = Int(description.mStartOffset)
            let length = Int(description.mDataByteSize)
            guard length > 0 else { continue }
            packets.append(Data(bytes: base.advanced(by: start), count: length))
        }
        return packets
    }

    /// Convert a mic CMSampleBuffer (broadcast extension path) into a PCM
    /// buffer this encoder accepts. Returns nil for unsupported formats.
    static func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else { return nil }
        guard let format = AVAudioFormat(streamDescription: asbd) else { return nil }
        let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frameCount > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return nil }
        pcm.frameLength = frameCount
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frameCount),
            into: pcm.mutableAudioBufferList
        )
        return status == noErr ? pcm : nil
    }
}
