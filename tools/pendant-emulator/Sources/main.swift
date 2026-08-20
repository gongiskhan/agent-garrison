import CoreBluetooth
import Foundation

// The over-the-air pendant emulator (mock harness layer 3): advertises the
// Omi pendant's GATT profile over REAL Bluetooth via CBPeripheralManager and
// streams committed Opus fixture audio with the documented 3-byte framing,
// so a real iPhone running the Companion connects to it before the human
// ever picks up the real pendant. Haptic writes from the phone are printed
// with timestamps - that printout is the "device speaker write log" of a
// rehearsal run.
//
// Usage:
//   pendant-emulator [--fixture <packets.jsonl>] [--codec 20|21]
//                    [--battery N] [--features hex] [--name Omi] [--loop]
//
// Interactive commands on stdin while running:
//   b     send a single-tap button notification
//   low   notify battery 8 percent
//   again restream the fixture from the start
//   q     quit
//
// Profile per docs/pendant-protocol.md. UUID strings duplicated here on
// purpose: the emulator is a standalone macOS tool, not an app target.

let audioServiceUUID = CBUUID(string: "19B10000-E8F2-537E-4F6C-D104768A1214")
let audioDataUUID = CBUUID(string: "19B10001-E8F2-537E-4F6C-D104768A1214")
let audioCodecUUID = CBUUID(string: "19B10002-E8F2-537E-4F6C-D104768A1214")
let featuresServiceUUID = CBUUID(string: "19B10020-E8F2-537E-4F6C-D104768A1214")
let featuresUUID = CBUUID(string: "19B10021-E8F2-537E-4F6C-D104768A1214")
let hapticServiceUUID = CBUUID(string: "CAB1AB95-2EA5-4F4D-BB56-874B72CFC984")
let hapticUUID = CBUUID(string: "CAB1AB96-2EA5-4F4D-BB56-874B72CFC984")
let batteryServiceUUID = CBUUID(string: "180F")
let batteryLevelUUID = CBUUID(string: "2A19")
let buttonServiceUUID = CBUUID(string: "23BA7924-0000-1000-7450-346EAC492E92")
let buttonTriggerUUID = CBUUID(string: "23BA7925-0000-1000-7450-346EAC492E92")

struct Options {
    var fixture = "../../fittings/seed/capture-service/fixtures/audio-pt-hellogarrison.jsonl"
    var codec: UInt8 = 21
    var battery: UInt8 = 87
    var features: UInt32 = 0x1EC
    var name = "Omi"
    var loop = false

    static func parse() -> Options {
        var options = Options()
        var args = Array(CommandLine.arguments.dropFirst())
        while !args.isEmpty {
            let flag = args.removeFirst()
            switch flag {
            case "--fixture": if !args.isEmpty { options.fixture = args.removeFirst() }
            case "--codec": if !args.isEmpty { options.codec = UInt8(args.removeFirst()) ?? 21 }
            case "--battery": if !args.isEmpty { options.battery = UInt8(args.removeFirst()) ?? 87 }
            case "--features": if !args.isEmpty { options.features = UInt32(args.removeFirst().replacingOccurrences(of: "0x", with: ""), radix: 16) ?? 0x1EC }
            case "--name": if !args.isEmpty { options.name = args.removeFirst() }
            case "--loop": options.loop = true
            default:
                print("unknown flag \(flag)")
                exit(2)
            }
        }
        return options
    }
}

struct FixturePacket {
    let seq: Int
    let ts: Double
    let bytes: Data
}

func loadFixture(_ path: String) -> [FixturePacket] {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
        print("cannot read fixture \(path)")
        exit(1)
    }
    var packets: [FixturePacket] = []
    for line in text.split(separator: "\n") {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let seq = object["seq"] as? Int,
              let base64 = object["bytes"] as? String,
              let bytes = Data(base64Encoded: base64)
        else { continue }
        let ts = (object["ts"] as? Double) ?? Double(object["ts"] as? Int ?? 0)
        packets.append(FixturePacket(seq: seq, ts: ts, bytes: bytes))
    }
    return packets
}

func frame(packetId: UInt16, payload: Data) -> Data {
    var out = Data(capacity: 3 + payload.count)
    out.append(UInt8(packetId & 0xFF))
    out.append(UInt8(packetId >> 8))
    out.append(0)
    out.append(payload)
    return out
}

final class Emulator: NSObject, CBPeripheralManagerDelegate {
    let options: Options
    let packets: [FixturePacket]
    var manager: CBPeripheralManager!
    var audioData: CBMutableCharacteristic!
    var battery: CBMutableCharacteristic!
    var button: CBMutableCharacteristic!
    var startedAt = Date()
    var streamIndex = 0
    var packetId: UInt16 = 0
    var streaming = false
    var subscribers = 0

    init(options: Options) {
        self.options = options
        packets = loadFixture(options.fixture)
        super.init()
        print("fixture: \(options.fixture) (\(packets.count) packets, \(String(format: "%.1f", (packets.last?.ts ?? 0) / 1000))s)")
        manager = CBPeripheralManager(delegate: self, queue: nil)
    }

    func elapsedMs() -> Int {
        Int(Date().timeIntervalSince(startedAt) * 1000)
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard peripheral.state == .poweredOn else {
            print("bluetooth state: \(peripheral.state.rawValue) (need poweredOn)")
            return
        }
        audioData = CBMutableCharacteristic(type: audioDataUUID, properties: [.notify, .read], value: nil, permissions: [.readable])
        let codec = CBMutableCharacteristic(type: audioCodecUUID, properties: [.read], value: Data([options.codec]), permissions: [.readable])
        let audioService = CBMutableService(type: audioServiceUUID, primary: true)
        audioService.characteristics = [audioData, codec]

        var rawFeatures = options.features.littleEndian
        let featuresValue = withUnsafeBytes(of: &rawFeatures) { Data($0) }
        let features = CBMutableCharacteristic(type: featuresUUID, properties: [.read], value: featuresValue, permissions: [.readable])
        let featuresService = CBMutableService(type: featuresServiceUUID, primary: true)
        featuresService.characteristics = [features]

        let haptic = CBMutableCharacteristic(type: hapticUUID, properties: [.write], value: nil, permissions: [.writeable])
        let hapticService = CBMutableService(type: hapticServiceUUID, primary: true)
        hapticService.characteristics = [haptic]

        battery = CBMutableCharacteristic(type: batteryLevelUUID, properties: [.read, .notify], value: nil, permissions: [.readable])
        let batteryService = CBMutableService(type: batteryServiceUUID, primary: true)
        batteryService.characteristics = [battery]

        button = CBMutableCharacteristic(type: buttonTriggerUUID, properties: [.notify], value: nil, permissions: [])
        let buttonService = CBMutableService(type: buttonServiceUUID, primary: true)
        buttonService.characteristics = [button]

        for service in [audioService, featuresService, hapticService, batteryService, buttonService] {
            peripheral.add(service)
        }
        peripheral.startAdvertising([
            CBAdvertisementDataLocalNameKey: options.name,
            CBAdvertisementDataServiceUUIDsKey: [audioServiceUUID]
        ])
        print("advertising as \"\(options.name)\" with the pendant audio service - connect from the Companion's Pendant screen")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        if characteristic.uuid == audioDataUUID {
            subscribers += 1
            print("+\(elapsedMs())ms central subscribed to audio (mtu \(central.maximumUpdateValueLength)) - streaming")
            if !streaming { startStream() }
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        if characteristic.uuid == audioDataUUID {
            subscribers = max(0, subscribers - 1)
            print("+\(elapsedMs())ms central unsubscribed from audio")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        if request.characteristic.uuid == batteryLevelUUID {
            request.value = Data([options.battery])
            peripheral.respond(to: request, withResult: .success)
            return
        }
        peripheral.respond(to: request, withResult: .attributeNotFound)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests {
            if request.characteristic.uuid == hapticUUID, let value = request.value?.first {
                print("+\(elapsedMs())ms HAPTIC write: level \(value)")
                peripheral.respond(to: request, withResult: .success)
            } else {
                peripheral.respond(to: request, withResult: .writeNotPermitted)
            }
        }
    }

    func startStream() {
        guard !packets.isEmpty else { return }
        streaming = true
        streamIndex = 0
        let base = Date()
        let baseTs = packets[0].ts
        func scheduleNext() {
            guard streamIndex < packets.count else {
                print("+\(elapsedMs())ms fixture complete (\(packets.count) packets)")
                streaming = false
                if options.loop {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.startStream() }
                }
                return
            }
            let packet = packets[streamIndex]
            let due = base.addingTimeInterval((packet.ts - baseTs) / 1000)
            let delay = max(0, due.timeIntervalSinceNow)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self else { return }
                _ = self.manager.updateValue(
                    frame(packetId: self.packetId, payload: packet.bytes),
                    for: self.audioData,
                    onSubscribedCentrals: nil
                )
                self.packetId &+= 1
                self.streamIndex += 1
                scheduleNext()
            }
        }
        scheduleNext()
    }

    func sendButtonTap() {
        var payload = Data(count: 8)
        payload[0] = 1 // single tap
        _ = manager.updateValue(payload, for: button, onSubscribedCentrals: nil)
        print("+\(elapsedMs())ms button single-tap notified")
    }

    func sendLowBattery() {
        _ = manager.updateValue(Data([8]), for: battery, onSubscribedCentrals: nil)
        print("+\(elapsedMs())ms battery 8 percent notified")
    }
}

let options = Options.parse()
let emulator = Emulator(options: options)

// Interactive stdin commands without blocking the run loop.
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: 0, queue: .main)
stdinSource.setEventHandler {
    guard let line = readLine(strippingNewline: true) else { return }
    switch line {
    case "q": exit(0)
    case "b": emulator.sendButtonTap()
    case "low": emulator.sendLowBattery()
    case "again": emulator.startStream()
    default: print("commands: b (button tap), low (battery 8), again (restream), q (quit)")
    }
}
stdinSource.resume()

RunLoop.main.run()
