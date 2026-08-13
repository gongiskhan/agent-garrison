import ReplayKit

// M0 skeleton. The real handler (JPEG stills under the throttle/drop/
// autoreleasepool discipline, PCM downmix, framed upload with acks and App
// Group buffering) is ported from the proven ios-thing implementation at M6.
final class SampleHandler: RPBroadcastSampleHandler {
    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        // Nothing to stream yet: end immediately with a clear message so a
        // premature broadcast attempt on a skeleton build is not a silent hang.
        let error = NSError(
            domain: "com.gomes.garrison.broadcast",
            code: 1,
            userInfo: [NSLocalizedFailureReasonErrorKey: "Screen capture is not available in this build yet."]
        )
        finishBroadcastWithError(error)
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        // Unreachable in M0: broadcastStarted always finishes the broadcast.
    }
}
