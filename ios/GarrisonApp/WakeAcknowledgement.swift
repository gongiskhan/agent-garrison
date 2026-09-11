import AVFoundation
import Foundation

@MainActor
final class WakeAcknowledgement {
    private var player: AVAudioPlayer?
    private(set) var invocations = 0
    func play(at: String) {
        // Server timestamp is diagnostic; dispatch immediately on receipt so
        // clock skew cannot turn a valid acknowledgement into silence.
        invocations += 1
        do { player = try AVAudioPlayer(data: Self.wave()); player?.play() } catch { }
    }
    static func wave() -> Data {
        let rate = 24000, frames = 3600
        var pcm = Data()
        for i in 0..<frames {
            let local = i % (frames / 2)
            let envelope = min(1, Double(local) / 120) * min(1, Double(frames / 2 - local) / 120)
            let hz = i < frames / 2 ? 660.0 : 880.0
            var sample = Int16(sin(2 * .pi * hz * Double(local) / Double(rate)) * envelope * 7000).littleEndian
            withUnsafeBytes(of: &sample) { pcm.append(contentsOf: $0) }
        }
        var out = Data("RIFF".utf8)
        func u32(_ n: Int) { var v = UInt32(n).littleEndian; withUnsafeBytes(of: &v) { out.append(contentsOf: $0) } }
        func u16(_ n: Int) { var v = UInt16(n).littleEndian; withUnsafeBytes(of: &v) { out.append(contentsOf: $0) } }
        u32(36 + pcm.count); out.append(Data("WAVEfmt ".utf8)); u32(16); u16(1); u16(1)
        u32(rate); u32(rate * 2); u16(2); u16(16); out.append(Data("data".utf8)); u32(pcm.count); out.append(pcm)
        return out
    }
}
