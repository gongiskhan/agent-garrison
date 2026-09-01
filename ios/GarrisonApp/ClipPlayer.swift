import AVFoundation
import Foundation

/// Plays a pre-rendered clip of Zeca's voice. Behind a protocol for the same
/// reason `Utterer` is: the sink's POLICY is what the tests pin, and neither
/// AVAudioPlayer nor the network belongs in a unit test.
protocol ClipPlaying {
    /// `path` is a server-relative path (`/speak/<hash>.mp3`). Calls back with
    /// false for ANY failure, which is the sink's signal to speak the line with
    /// the on-device synthesizer instead.
    func play(path: String, volume: Float, completion: @escaping (Bool) -> Void)
    func stop()
}

/// Makes sure something audible can actually come out.
///
/// The in-app mic path configures .playAndRecord and activates the session, so
/// speech there has always been audible. The PENDANT path never touches
/// AVAudioSession at all - its audio arrives over BLE - so a clip played during
/// a pendant session went into an unconfigured, inactive session and was simply
/// never heard. The server saw a fetched clip and a successful receipt; the
/// wearer heard nothing, which is the worst combination available.
///
/// If a capture is already running the session is playAndRecord and ACTIVE, and
/// this leaves it strictly alone - reconfiguring it mid-capture would interrupt
/// the recording the clip is acknowledging. Otherwise it claims .playback
/// (.spokenAudio, ducking others) for the duration, and hands it back after.
enum SpeechAudioSession {
    /// True when this call activated the session and must release it later.
    static func activateIfNeeded() -> Bool {
        let session = AVAudioSession.sharedInstance()
        // A live capture owns the session; never touch it.
        if session.category == .playAndRecord || session.category == .playback { return false }
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
            return true
        } catch {
            return false
        }
    }

    static func release(_ owned: Bool) {
        guard owned else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// Fetches the clip from capture-service and plays it.
///
/// The path arrives RELATIVE and is resolved against the app's configured base
/// URL, never against a machine-local address: the phone reaches the service
/// over the tailnet, so an absolute `http://127.0.0.1:...` from the server
/// would be unreachable here. That is the standing house rule, and this is the
/// client half of it.
///
/// Clips are content-addressed and immutable, so URLSession's own cache is
/// allowed to do its job - a repeated line plays without a round trip.
final class ClipPlayer: NSObject, ClipPlaying, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var completion: ((Bool) -> Void)?
    private var task: URLSessionDataTask?
    private var ownsSession = false

    func play(path: String, volume: Float, completion: @escaping (Bool) -> Void) {
        guard let base = AppGroup.baseURL,
              let url = URL(string: path, relativeTo: base)
        else {
            completion(false)
            return
        }
        stop()
        self.completion = completion
        let request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 8)
        task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            guard ok, let data, !data.isEmpty else {
                self.finish(false)
                return
            }
            DispatchQueue.main.async { self.start(data: data, volume: volume) }
        }
        task?.resume()
    }

    private func start(data: Data, volume: Float) {
        do {
            ownsSession = SpeechAudioSession.activateIfNeeded()
            let player = try AVAudioPlayer(data: data)
            player.delegate = self
            player.volume = volume
            self.player = player
            // With the in-app mic running the session is already
            // .playAndRecord/.voiceChat with hardware echo cancellation, so
            // this plays while the mic stays hot and activateIfNeeded left it
            // untouched. On the pendant lane there was no session at all, which
            // is what activateIfNeeded has just claimed.
            guard player.play() else {
                finish(false)
                return
            }
        } catch {
            finish(false)
        }
    }

    private func finish(_ ok: Bool) {
        let done = completion
        completion = nil
        player = nil
        SpeechAudioSession.release(ownsSession)
        ownsSession = false
        done?(ok)
    }

    func stop() {
        task?.cancel()
        task = nil
        player?.stop()
        // A deliberate stop is not a failure to report twice: the sink already
        // wrote a receipt for whatever it cancelled.
        completion = nil
        player = nil
        SpeechAudioSession.release(ownsSession)
        ownsSession = false
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        finish(flag)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        finish(false)
    }
}
