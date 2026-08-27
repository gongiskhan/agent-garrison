import AVFoundation
import CoreImage
import CoreMedia
import ReplayKit

/// Broadcast Upload Extension entry point. Runs in its own process with a
/// tight (~50 MB) budget, so the ios-thing discipline is kept verbatim:
///   - never buffer or accumulate in memory; the SessionSpool is DISK
///   - release pixel buffers immediately (autoreleasepool around frame work)
///   - downscale + throttle video to ~1.5 fps JPEG stills — the proven path;
///     no business logic here: encode, hand to the uploader, nothing else.
///
/// Audio is encoded to the same raw Opus packets as the app's audio-only
/// mode, so the service feeds Deepgram identically for both session modes.
final class SampleHandler: RPBroadcastSampleHandler {
    private var uploader: CaptureUploader?
    private var encoder: OpusEncoder?
    private var sessionStart = Date()

    // Video throttling (proven ios-thing constants).
    private let targetFPS: Double = 1.5
    private var lastFrameTime: CFTimeInterval = 0
    private let longestSide: CGFloat = 720
    private let jpegQuality: CGFloat = 0.5

    // Reuse a single CIContext - creating one per frame is expensive and
    // leaks budget.
    private lazy var ciContext = CIContext(options: [.cacheIntermediates: false])

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard let baseURL = AppGroup.baseURL, let token = AppGroup.token else {
            finishBroadcastWithError(NSError(
                domain: "com.gomes.garrison.broadcast",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No capture endpoint set. Open Garrison and fill in Settings first."]
            ))
            return
        }
        sessionStart = Date()
        let sessionId = SessionId.generate()
        let uploader = CaptureUploader(
            baseURL: baseURL,
            token: token,
            sessionId: sessionId,
            mode: .screenAudio,
            deviceName: AppGroup.deviceName,
            consent: AppGroup.consentSuppressed ? .suppressed : .shown,
            spoolDirectory: AppGroup.spoolDirectory(sessionId: sessionId)
        )
        self.uploader = uploader
        uploader.connect()
        // No speech in screen_audio mode (the server never sends it either):
        // this process has no AEC coupling to the app's speaker.
    }

    override func broadcastFinished() {
        // Drain the converter's tail (the end of the last word) before ending.
        if let encoder, let uploader {
            let ts = Date().timeIntervalSince(sessionStart) * 1000
            for packet in encoder.flush() {
                uploader.sendAudioPacket(packet, ts: ts)
            }
        }
        uploader?.end(reason: "user")
        uploader = nil
        encoder = nil
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case .video:
            handleVideo(sampleBuffer)
        case .audioMic:
            handleAudio(sampleBuffer)
        case .audioApp:
            break // deliberate: the user's voice is the signal, not app audio
        @unknown default:
            break
        }
    }

    // MARK: - Video (JPEG stills, throttled)

    private func handleVideo(_ sampleBuffer: CMSampleBuffer) {
        let now = CACurrentMediaTime()
        guard now - lastFrameTime >= (1.0 / targetFPS) else { return }
        guard let uploader, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastFrameTime = now

        autoreleasepool {
            guard let jpeg = jpegFromPixelBuffer(pixelBuffer) else { return }
            uploader.sendVideoFrame(jpeg, ts: Date().timeIntervalSince(sessionStart) * 1000)
        }
    }

    private func jpegFromPixelBuffer(_ pixelBuffer: CVPixelBuffer) -> Data? {
        let width = CGFloat(CVPixelBufferGetWidth(pixelBuffer))
        let height = CGFloat(CVPixelBufferGetHeight(pixelBuffer))
        guard width > 0, height > 0 else { return nil }
        let scale = min(1.0, longestSide / max(width, height))
        var image = CIImage(cvPixelBuffer: pixelBuffer)
        if scale < 1.0 {
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        return ciContext.jpegRepresentation(
            of: image,
            colorSpace: CGColorSpaceCreateDeviceRGB(),
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: jpegQuality]
        )
    }

    // MARK: - Audio (raw Opus packets)

    private func handleAudio(_ sampleBuffer: CMSampleBuffer) {
        guard let uploader else { return }
        guard let pcm = OpusEncoder.pcmBuffer(from: sampleBuffer) else { return }
        // ReplayKit mic buffers can change format mid-broadcast (route change,
        // incoming call, headset connect: 44.1k<->48k, mono<->stereo). A
        // converter fed a mismatched format fails on every call from then on,
        // ending audio for good — rebuild instead, shipping the old tail.
        if let current = encoder, current.inputFormat != pcm.format {
            let ts = Date().timeIntervalSince(sessionStart) * 1000
            for packet in current.flush() {
                uploader.sendAudioPacket(packet, ts: ts)
            }
            encoder = nil
        }
        if encoder == nil {
            encoder = OpusEncoder(inputFormat: pcm.format)
        }
        guard let encoder else { return }
        let ts = Date().timeIntervalSince(sessionStart) * 1000
        for packet in encoder.encode(pcm) {
            uploader.sendAudioPacket(packet, ts: ts)
        }
    }
}
