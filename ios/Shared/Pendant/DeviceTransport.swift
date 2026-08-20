import Foundation

/// One reassembled codec frame off the pendant, timestamped at reassembly on
/// the host clock (the pendant carries no per-packet timestamps on the audio
/// characteristic).
struct PendantAudioFrame {
    let payload: Data
    /// Milliseconds since the transport connected (session-relative, the
    /// uploader's ts domain).
    let timestampMs: Double
}

/// The pendant abstraction. Three implementations: PendantBLETransport
/// (CoreBluetooth central, the real device), MockPendantTransport
/// (in-process, fixtures at real cadence, for tests and the simulator), and
/// the CoreBluetoothMock-backed harness that exercises the real BLE
/// transport code against a scripted peripheral.
///
/// Callback discipline: all callbacks are delivered on the transport's own
/// serial queue; consumers hop to the main queue themselves when needed.
protocol DeviceTransport: AnyObject {
    var onConnectionState: ((PendantConnectionState) -> Void)? { get set }
    var onAudioFrame: ((PendantAudioFrame) -> Void)? { get set }
    var onBattery: ((Int) -> Void)? { get set }
    var onButton: ((PendantButtonEvent) -> Void)? { get set }
    /// Cumulative reassembly losses, reported when the count changes.
    var onAudioLoss: ((Int) -> Void)? { get set }

    var connectionState: PendantConnectionState { get }

    func connect()
    func disconnect()

    /// One-shot reads. Completions fire on the transport queue; a nil codec
    /// means the read failed (callers fall back to .opusFS320, the consumer
    /// default).
    func readCodec(_ completion: @escaping (PendantCodec?) -> Void)
    /// A failed read maps to [] (devkit) - capability is then probed by
    /// attempting the haptic write, as upstream does.
    func readFeatures(_ completion: @escaping (PendantFeatures) -> Void)
    func readBattery(_ completion: @escaping (Int?) -> Void)

    /// The device feedback primitive. Completion reports write acceptance
    /// (false = characteristic missing or write failed = treat the device
    /// sink as unsupported and let the phone carry the tiers).
    func writeHaptic(_ level: PendantHapticLevel, completion: ((Bool) -> Void)?)
}
