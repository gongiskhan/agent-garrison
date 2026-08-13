import AVFoundation
import CoreMedia

/// PCM -> raw Opus packets, 16 kHz mono ~20 ms frames — exactly what the wire
/// protocol carries and what the service hands Deepgram (`encoding=opus`).
/// One AVAudioConverter does both the sample-rate conversion (mic native,
/// typically 48 kHz Float32) and the encode. Used by the app's AVAudioEngine
/// tap AND the broadcast extension's CMSampleBuffer path.
final class OpusEncoder {
    private let converter: AVAudioConverter
    private let inputFormat: AVAudioFormat
    private let outputFormat: AVAudioFormat
    private var pending: [AVAudioPCMBuffer] = []

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
        converter.bitRate = 24_000
    }

    /// Encode one PCM buffer; returns zero or more complete Opus packets
    /// (the converter buffers partial frames internally).
    func encode(_ buffer: AVAudioPCMBuffer) -> [Data] {
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
            if conversionError != nil || status == .error { break }
            packets.append(contentsOf: Self.extractPackets(from: compressed))
            if compressed.packetCount == 0 || consumedAll { break }
        }
        return packets
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
