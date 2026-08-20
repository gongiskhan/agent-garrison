import CoreBluetoothMock
import XCTest
@testable import GarrisonApp

/// Mock harness layer 2: the REAL PendantBLETransport (recompiled into this
/// target with PENDANT_MOCK_BLE, so its CoreBluetooth surface is Nordic's
/// CoreBluetoothMock) exercised against a scripted peripheral implementing
/// the documented GATT profile - discovery by advertised service,
/// connection, characteristic subscription, codec/features reads, haptic
/// writes, framed audio notifications, and the disconnect/reconnect path.
/// No radio involved.

// MARK: - The scripted pendant

final class PendantSpec {
    static let audioService = CBMUUID(string: PendantUUID.audioService)

    let audioData = CBMCharacteristicMock(
        type: CBMUUID(string: PendantUUID.audioData),
        properties: [.notify, .read]
    )
    let audioCodec = CBMCharacteristicMock(
        type: CBMUUID(string: PendantUUID.audioCodec),
        properties: [.read]
    )
    let features = CBMCharacteristicMock(
        type: CBMUUID(string: PendantUUID.features),
        properties: [.read]
    )
    let haptic = CBMCharacteristicMock(
        type: CBMUUID(string: PendantUUID.haptic),
        properties: [.write]
    )
    let battery = CBMCharacteristicMock(
        type: CBMUUID(string: PendantUUID.batteryLevel),
        properties: [.read, .notify]
    )
    let button = CBMCharacteristicMock(
        type: CBMUUID(string: PendantUUID.buttonTrigger),
        properties: [.notify]
    )

    let delegate: SpecDelegate
    let spec: CBMPeripheralSpec

    /// Consumer-pendant shape: codec opusFS320 (21), features 0x1EC
    /// (haptic yes, speaker no), battery 87.
    init(codec: UInt8 = 21, featuresValue: UInt32 = 0x1EC, battery: UInt8 = 87) {
        let delegate = SpecDelegate()
        delegate.codecValue = Data([codec])
        var raw = featuresValue.littleEndian
        delegate.featuresValue = withUnsafeBytes(of: &raw) { Data($0) }
        delegate.batteryValue = Data([battery])
        self.delegate = delegate
        spec = CBMPeripheralSpec
            .simulatePeripheral(proximity: .near)
            .advertising(
                advertisementData: [
                    CBMAdvertisementDataLocalNameKey: "Omi",
                    CBMAdvertisementDataServiceUUIDsKey: [Self.audioService],
                    CBMAdvertisementDataIsConnectable: true as NSNumber
                ],
                withInterval: 0.05
            )
            .connectable(
                name: "Omi",
                services: [
                    CBMServiceMock(type: Self.audioService, primary: true, characteristics: audioData, audioCodec),
                    CBMServiceMock(
                        type: CBMUUID(string: PendantUUID.featuresService),
                        primary: true,
                        characteristics: features
                    ),
                    CBMServiceMock(
                        type: CBMUUID(string: PendantUUID.hapticService),
                        primary: true,
                        characteristics: haptic
                    ),
                    CBMServiceMock(
                        type: CBMUUID(string: PendantUUID.batteryService),
                        primary: true,
                        characteristics: battery
                    ),
                    CBMServiceMock(
                        type: CBMUUID(string: PendantUUID.buttonService),
                        primary: true,
                        characteristics: button
                    )
                ],
                delegate: delegate,
                connectionInterval: 0.015,
                mtu: 251
            )
            .build()
        delegate.owner = self
    }

    /// Stream fixture-shaped packets as framed notifications on the audio
    /// characteristic (one Opus packet per notification, frame index 0).
    func streamPackets(_ payloads: [Data], startId: UInt16 = 0) {
        var packetId = startId
        for payload in payloads {
            spec.simulateValueUpdate(
                PendantFraming.encode(packetId: packetId, frameIndex: 0, payload: payload),
                for: audioData
            )
            packetId &+= 1
        }
    }

    final class SpecDelegate: CBMPeripheralSpecDelegate {
        weak var owner: PendantSpec?
        var codecValue = Data([21])
        var featuresValue = Data([0xEC, 0x01, 0x00, 0x00])
        var batteryValue = Data([87])
        /// Every haptic byte written, with its arrival time - the write log
        /// the feedback tests assert against.
        private(set) var hapticWrites: [(value: UInt8, at: Date)] = []

        func peripheral(_ peripheral: CBMPeripheralSpec, didReceiveReadRequestFor characteristic: CBMCharacteristicMock)
            -> Result<Data, Error> {
            guard let owner else { return .failure(CBMATTError(.readNotPermitted)) }
            switch characteristic.uuid {
            case owner.audioCodec.uuid: return .success(codecValue)
            case owner.features.uuid: return .success(featuresValue)
            case owner.battery.uuid: return .success(batteryValue)
            default: return .failure(CBMATTError(.readNotPermitted))
            }
        }

        func peripheral(
            _ peripheral: CBMPeripheralSpec,
            didReceiveWriteRequestFor characteristic: CBMCharacteristicMock,
            data: Data
        ) -> Result<Void, Error> {
            guard let owner, characteristic.uuid == owner.haptic.uuid, let byte = data.first, (1 ... 3).contains(byte)
            else { return .failure(CBMATTError(.writeNotPermitted)) }
            hapticWrites.append((byte, Date()))
            return .success(())
        }

        func peripheral(
            _ peripheral: CBMPeripheralSpec,
            didReceiveSetNotifyRequest enabled: Bool,
            for characteristic: CBMCharacteristicMock
        ) -> Result<Void, Error> {
            .success(())
        }
    }
}

// MARK: - Transport-against-mock tests

final class PendantBLETransportMockTests: XCTestCase {
    private var pendant: PendantSpec!

    override func setUp() {
        super.setUp()
        pendant = PendantSpec()
        CBMCentralManagerMock.simulatePeripherals([pendant.spec])
        CBMCentralManagerMock.simulateInitialState(.poweredOn)
    }

    override func tearDown() {
        CBMCentralManagerMock.tearDownSimulation()
        super.tearDown()
    }

    private func connectTransport() -> PendantBLETransport {
        let transport = PendantBLETransport()
        let connected = expectation(description: "connected")
        transport.onConnectionState = { state in
            if state == .connected { connected.fulfill() }
        }
        transport.connect()
        wait(for: [connected], timeout: 10)
        return transport
    }

    func testDiscoversConnectsAndReadsTheProfile() {
        let transport = connectTransport()
        let reads = expectation(description: "reads")
        reads.expectedFulfillmentCount = 3
        transport.readCodec { codec in
            XCTAssertEqual(codec, .opusFS320)
            reads.fulfill()
        }
        transport.readFeatures { features in
            XCTAssertTrue(features.contains(.haptic))
            XCTAssertFalse(features.contains(.speaker))
            reads.fulfill()
        }
        transport.readBattery { level in
            XCTAssertEqual(level, 87)
            reads.fulfill()
        }
        wait(for: [reads], timeout: 10)
        transport.disconnect()
    }

    func testStreamsFramedAudioThroughTheRealReassembler() {
        let transport = connectTransport()
        var frames: [Data] = []
        let got = expectation(description: "frames")
        transport.onAudioFrame = { frame in
            frames.append(frame.payload)
            if frames.count == 4 { got.fulfill() }
        }
        pendant.streamPackets((0 ..< 5).map { Data([UInt8($0), 0xAB]) })
        wait(for: [got], timeout: 10)
        XCTAssertEqual(frames.prefix(2), [Data([0, 0xAB]), Data([1, 0xAB])])
        transport.disconnect()
    }

    func testHapticWriteReachesThePeripheral() {
        let transport = connectTransport()
        let wrote = expectation(description: "haptic")
        transport.writeHaptic(.long) { ok in
            XCTAssertTrue(ok)
            wrote.fulfill()
        }
        wait(for: [wrote], timeout: 10)
        XCTAssertEqual(pendant.delegate.hapticWrites.map(\.value), [3])
        transport.disconnect()
    }

    func testUnexpectedDisconnectEntersReconnectingAndRecovers() {
        let transport = connectTransport()
        var sawReconnecting = false
        let recovered = expectation(description: "recovered")
        transport.onConnectionState = { state in
            if state == .reconnecting { sawReconnecting = true }
            if sawReconnecting, state == .connected { recovered.fulfill() }
        }
        pendant.spec.simulateDisconnection(withError: CBMError(.connectionTimeout))
        wait(for: [recovered], timeout: 10)
        XCTAssertTrue(sawReconnecting)
        transport.disconnect()
    }
}
