import Foundation

/// The Omi pendant's BLE surface, per docs/pendant-protocol.md (clean-room
/// notes read from the BasedHardware/omi firmware and device layer; nothing
/// vendored). String UUIDs live here so the CoreBluetooth transport, the
/// CoreBluetoothMock peripheral, and the over-the-air emulator all agree.
enum PendantUUID {
    /// Advertised primary service; the scan filter.
    static let audioService = "19B10000-E8F2-537E-4F6C-D104768A1214"
    /// Framed audio packets, notify.
    static let audioData = "19B10001-E8F2-537E-4F6C-D104768A1214"
    /// One byte, the codec id, read.
    static let audioCodec = "19B10002-E8F2-537E-4F6C-D104768A1214"

    /// Features bitmask service + characteristic (consumer pendant only; a
    /// failed read means "devkit", treat as no features).
    static let featuresService = "19B10020-E8F2-537E-4F6C-D104768A1214"
    static let features = "19B10021-E8F2-537E-4F6C-D104768A1214"

    /// Haptic trigger: 1-byte write, levels 1-3, firmware-side durations.
    static let hapticService = "CAB1AB95-2EA5-4F4D-BB56-874B72CFC984"
    static let haptic = "CAB1AB96-2EA5-4F4D-BB56-874B72CFC984"

    /// Speaker PCM upload (DevKit2 builds only; not a product surface).
    static let speaker = "19B10003-E8F2-537E-4F6C-D104768A1214"

    static let buttonService = "23BA7924-0000-1000-7450-346EAC492E92"
    static let buttonTrigger = "23BA7925-0000-1000-7450-346EAC492E92"

    static let batteryService = "180F"
    static let batteryLevel = "2A19"

    static let deviceInformationService = "180A"
}

/// Codec ids from the codec characteristic (one byte).
enum PendantCodec: UInt8 {
    case pcm16 = 0
    case pcm8 = 1
    case mulaw16 = 10
    case mulaw8 = 11
    /// Opus, 160-sample (10 ms) frames at 100/s - DevKit default.
    case opus = 20
    /// Opus, 320-sample (20 ms) frames at 50/s - consumer pendant default.
    case opusFS320 = 21

    var isOpus: Bool { self == .opus || self == .opusFS320 }
    /// All pendant codecs are 16 kHz mono on the wire.
    var sampleRate: Int { 16000 }
    var frameMs: Int { self == .opusFS320 ? 20 : 10 }
}

/// Features bitmask (uint32 little-endian). A read failure maps to [] and
/// capability is then probed by characteristic presence, as upstream does.
struct PendantFeatures: OptionSet {
    let rawValue: UInt32
    static let speaker = PendantFeatures(rawValue: 1 << 0)
    static let accelerometer = PendantFeatures(rawValue: 1 << 1)
    static let button = PendantFeatures(rawValue: 1 << 2)
    static let battery = PendantFeatures(rawValue: 1 << 3)
    static let usb = PendantFeatures(rawValue: 1 << 4)
    static let haptic = PendantFeatures(rawValue: 1 << 5)
    static let offlineStorage = PendantFeatures(rawValue: 1 << 6)
    static let ledDimming = PendantFeatures(rawValue: 1 << 7)
    static let micGain = PendantFeatures(rawValue: 1 << 8)

    static func from(characteristicValue data: Data) -> PendantFeatures {
        guard data.count >= 4 else { return [] }
        let raw = data.subdata(in: data.startIndex ..< data.startIndex + 4).withUnsafeBytes {
            UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))
        }
        return PendantFeatures(rawValue: raw)
    }
}

/// Haptic levels - the only app-triggerable device output. Durations are
/// firmware-side (consumer pendant: 100/300/500 ms). Level 3 is the only
/// timing-consistent one across firmwares.
enum PendantHapticLevel: UInt8 {
    case short = 1
    case medium = 2
    case long = 3
}

/// Button notify payload is 8 bytes, two int32 LE, event code in byte 0.
enum PendantButtonEvent: UInt8 {
    case singleTap = 1
    case doubleTap = 2
    case longTap = 3
    case press = 4
    case release = 5

    static func from(characteristicValue data: Data) -> PendantButtonEvent? {
        guard let first = data.first else { return nil }
        return PendantButtonEvent(rawValue: first)
    }
}

enum PendantConnectionState: Equatable {
    case disconnected
    case scanning
    case connecting
    case connected
    /// Dropped unexpectedly; a reconnect is pending at the chipset level.
    case reconnecting
    /// The peripheral removed its pairing; auto-reconnect must stop.
    case pairingLost
    case bluetoothOff
}
