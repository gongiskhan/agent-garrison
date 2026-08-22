// Layer 2 of the mock harness (ADR D11): the TEST target recompiles this
// exact file with PENDANT_MOCK_BLE defined, mapping the CoreBluetooth
// surface onto Nordic's CoreBluetoothMock so the real central-manager logic
// (discovery, connection, subscription, writes, reconnection) runs against a
// scripted peripheral without radio. The app target compiles the plain
// CoreBluetooth branch and stays zero-dependency.
#if PENDANT_MOCK_BLE
import CoreBluetoothMock
// Recompiled into the TEST module, this copy is no longer in the same
// module as the Shared/ pendant types it is written against, so they must
// be imported explicitly. The app-target branch below needs no import:
// there the file and those types are one module.
@testable import GarrisonApp

typealias CBCentralManager = CBMCentralManager
typealias CBCentralManagerDelegate = CBMCentralManagerDelegate
typealias CBPeripheral = CBMPeripheral
typealias CBPeripheralDelegate = CBMPeripheralDelegate
typealias CBService = CBMService
typealias CBCharacteristic = CBMCharacteristic
typealias CBUUID = CBMUUID
typealias CBError = CBMError

let CBCentralManagerScanOptionAllowDuplicatesKey = CBMCentralManagerScanOptionAllowDuplicatesKey
let CBCentralManagerRestoredStatePeripheralsKey = CBMCentralManagerRestoredStatePeripheralsKey

private func makeCentralManager(
    delegate: CBMCentralManagerDelegate,
    queue: DispatchQueue,
    options: [String: Any]
) -> CBMCentralManager {
    CBMCentralManagerFactory.instance(delegate: delegate, queue: queue, options: options, forceMock: true)
}
#else
import CoreBluetooth

private func makeCentralManager(
    delegate: CBCentralManagerDelegate,
    queue: DispatchQueue,
    options: [String: Any]
) -> CBCentralManager {
    CBCentralManager(delegate: delegate, queue: queue, options: options)
}
#endif

import Foundation

/// The real pendant transport: a CoreBluetooth central implementing the
/// profile and lifecycle rules in docs/pendant-protocol.md sections 2 and 9.
/// The load-bearing decisions, all ported from the upstream device layer:
///
/// - Connect by retrieval when a stored identifier exists; scan (filtered on
///   the advertised audio service - a nil filter cannot run in background)
///   only when there is none.
/// - No reconnect backoff: on an unexpected drop, re-issue connect() after a
///   fixed 200 ms and let the chipset wait for free. Never chase peripherals
///   that were never connected; treat peerRemovedPairingInformation as
///   terminal.
/// - Ready only when every discovered service has its characteristics; then
///   codec read, features read, battery read + subscribe, button subscribe,
///   audio subscribe - in that order.
/// - Post-reconnect notifications can be silently dead: re-arm every
///   subscription and run a 4 s audio liveness watchdog with exactly one
///   forced re-subscribe.
/// - Fail pending read/write completions on disconnect or callers hang.
final class PendantBLETransport: NSObject, DeviceTransport {
    var onConnectionState: ((PendantConnectionState) -> Void)?
    var onAudioFrame: ((PendantAudioFrame) -> Void)?
    var onBattery: ((Int) -> Void)?
    var onButton: ((PendantButtonEvent) -> Void)?
    var onAudioLoss: ((Int) -> Void)?
    /// Fired once per discovery so the owner can persist the identifier for
    /// future retrieval-based connects.
    var onIdentified: ((UUID, String) -> Void)?

    private(set) var connectionState: PendantConnectionState = .disconnected

    private let queue = DispatchQueue(label: "pendant-ble-transport")
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var storedIdentifier: UUID?
    private var wantsConnection = false
    private var manualDisconnect = false
    private var everConnected = false
    private var connectedAt: Date?

    private var characteristics: [String: CBCharacteristic] = [:]
    /// Services that still owe a didDiscoverCharacteristicsFor callback in
    /// the current discovery cycle. Keyed by object identity, not UUID:
    /// duplicate service UUIDs are legal on a peripheral and would collapse.
    private var pendingCharacteristicDiscovery: Set<ObjectIdentifier> = []
    private var subscribed: Set<String> = []
    private let reassembler = PendantFrameReassembler()
    private var reportedLoss = 0

    private var readCompletions: [String: [(Data?) -> Void]] = [:]
    private var writeCompletions: [String: [(Bool) -> Void]] = [:]

    /// Set when a retrieval-based connect timed out, so the next attempt scans
    /// instead of retrying the same unreachable peripheral. Cleared on a
    /// successful connection.
    private var preferScan = false
    private var retrievalTimer: DispatchSourceTimer?
    private var livenessTimer: DispatchSourceTimer?
    private var livenessResubscribes = 0
    private var sawAudioSinceArm = false

    private static let restoreIdentifier = "com.gomes.garrison.pendant.restore"
    private static let reconnectDelayMs = 200
    /// CBCentralManager.connect() never times out by design. A stored
    /// identifier that no longer exists nearby - a pendant left at home, or a
    /// Mac running the emulator that has since quit - would therefore pin the
    /// transport to a device that will never answer, and it would never look
    /// for the real one. Give retrieval this long, then scan.
    private static let retrievalTimeoutSeconds = 8
    private static let livenessWindowSeconds = 4

    /// Everything keys on full 128-bit lowercase UUID strings; 16-bit
    /// constants ("2A19") and CoreBluetooth's short forms are expanded with
    /// the Bluetooth base UUID. One normalizer for constants and callbacks
    /// alike, or the two sides silently miss each other.
    static func normalizedUuid(_ uuid: String) -> String {
        uuid.count == 4 ? "0000\(uuid)-0000-1000-8000-00805f9b34fb".lowercased() : uuid.lowercased()
    }

    init(identifier: UUID? = nil) {
        storedIdentifier = identifier
        super.init()
        #if os(iOS) && !PENDANT_MOCK_BLE
        let options: [String: Any] = [
            CBCentralManagerOptionRestoreIdentifierKey: Self.restoreIdentifier,
            CBCentralManagerOptionShowPowerAlertKey: true
        ]
        #else
        let options: [String: Any] = [:]
        #endif
        central = makeCentralManager(delegate: self, queue: queue, options: options)
    }

    // MARK: - DeviceTransport

    func connect() {
        queue.async { [self] in
            wantsConnection = true
            manualDisconnect = false
            startConnecting()
        }
    }

    func disconnect() {
        queue.async { [self] in
            wantsConnection = false
            manualDisconnect = true
            central.stopScan()
            if let peripheral {
                central.cancelPeripheralConnection(peripheral)
            }
            teardownSession()
            setState(.disconnected)
        }
    }

    func readCodec(_ completion: @escaping (PendantCodec?) -> Void) {
        readCharacteristic(PendantUUID.audioCodec) { data in
            guard let byte = data?.first else { return completion(nil) }
            completion(PendantCodec(rawValue: byte))
        }
    }

    func readFeatures(_ completion: @escaping (PendantFeatures) -> Void) {
        readCharacteristic(PendantUUID.features) { data in
            guard let data else { return completion([]) }
            completion(PendantFeatures.from(characteristicValue: data))
        }
    }

    func readBattery(_ completion: @escaping (Int?) -> Void) {
        readCharacteristic(PendantUUID.batteryLevel) { data in
            guard let byte = data?.first else { return completion(nil) }
            completion(Int(byte))
        }
    }

    func writeHaptic(_ level: PendantHapticLevel, completion: ((Bool) -> Void)?) {
        queue.async { [self] in
            guard let peripheral, let characteristic = characteristics[Self.normalizedUuid(PendantUUID.haptic)] else {
                completion?(false)
                return
            }
            if let completion {
                writeCompletions[Self.normalizedUuid(PendantUUID.haptic), default: []].append(completion)
            }
            peripheral.writeValue(Data([level.rawValue]), for: characteristic, type: .withResponse)
        }
    }

    // MARK: - Connect flow

    private func startConnecting() {
        guard wantsConnection else { return }
        guard central.state == .poweredOn else {
            if central.state == .poweredOff { setState(.bluetoothOff) }
            return // centralManagerDidUpdateState fires the pending connect
        }
        if peripheral == nil, !preferScan, let storedIdentifier,
           let known = central.retrievePeripherals(withIdentifiers: [storedIdentifier]).first {
            adopt(known)
            armRetrievalTimeout()
        }
        if let peripheral {
            setState(everConnected ? .reconnecting : .connecting)
            central.connect(peripheral, options: nil)
            return
        }
        setState(.scanning)
        central.scanForPeripherals(
            withServices: [CBUUID(string: PendantUUID.audioService)],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
    }

    private func adopt(_ found: CBPeripheral) {
        peripheral = found
        found.delegate = self
    }

    private func scheduleReconnect() {
        queue.asyncAfter(deadline: .now() + .milliseconds(Self.reconnectDelayMs)) { [weak self] in
            guard let self, self.wantsConnection, !self.manualDisconnect else { return }
            self.startConnecting()
        }
    }

    private func teardownSession() {
        cancelRetrievalTimeout()
        characteristics.removeAll()
        pendingCharacteristicDiscovery.removeAll()
        subscribed.removeAll()
        reassembler.reset()
        connectedAt = nil
        cancelLivenessWatchdog()
        failPendingCompletions()
    }

    private func failPendingCompletions() {
        for completions in readCompletions.values {
            for completion in completions { completion(nil) }
        }
        readCompletions.removeAll()
        for completions in writeCompletions.values {
            for completion in completions { completion(false) }
        }
        writeCompletions.removeAll()
    }

    private func setState(_ state: PendantConnectionState) {
        guard connectionState != state else { return }
        connectionState = state
        onConnectionState?(state)
    }

    // MARK: - Reads

    private func readCharacteristic(_ uuid: String, completion: @escaping (Data?) -> Void) {
        queue.async { [self] in
            guard let peripheral, let characteristic = characteristics[Self.normalizedUuid(uuid)] else {
                completion(nil)
                return
            }
            readCompletions[Self.normalizedUuid(uuid), default: []].append(completion)
            peripheral.readValue(for: characteristic)
        }
    }

    // MARK: - Subscriptions + liveness

    private func armSubscriptions() {
        guard let peripheral else { return }
        for uuid in [PendantUUID.audioData, PendantUUID.batteryLevel, PendantUUID.buttonTrigger] {
            if let characteristic = characteristics[Self.normalizedUuid(uuid)],
               characteristic.properties.contains(.notify) {
                peripheral.setNotifyValue(true, for: characteristic)
                subscribed.insert(Self.normalizedUuid(uuid))
            }
        }
        armLivenessWatchdog()
    }

    /// The classic silent failure: GATT connected, CCCD dead. One forced
    /// re-subscribe, then give up to a logged state (the owner sees no
    /// frames and the connection state stays connected - honest).
    /// Only armed for a RETRIEVED peripheral: a scanned one was just seen
    /// advertising, so its connect is not a shot in the dark.
    private func armRetrievalTimeout() {
        cancelRetrievalTimeout()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .seconds(Self.retrievalTimeoutSeconds))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.cancelRetrievalTimeout()
            guard self.wantsConnection, self.connectionState != .connected else { return }
            // Stop chasing the stored device and go find one that is actually here.
            if let peripheral = self.peripheral {
                self.central.cancelPeripheralConnection(peripheral)
            }
            self.peripheral = nil
            self.preferScan = true
            self.startConnecting()
        }
        timer.resume()
        retrievalTimer = timer
    }

    private func cancelRetrievalTimeout() {
        retrievalTimer?.cancel()
        retrievalTimer = nil
    }

    private func armLivenessWatchdog() {
        cancelLivenessWatchdog()
        sawAudioSinceArm = false
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .seconds(Self.livenessWindowSeconds))
        timer.setEventHandler { [weak self] in
            guard let self, self.connectionState == .connected, !self.sawAudioSinceArm else { return }
            guard self.livenessResubscribes < 1 else { return }
            self.livenessResubscribes += 1
            if let peripheral = self.peripheral,
               let audio = self.characteristics[Self.normalizedUuid(PendantUUID.audioData)] {
                peripheral.setNotifyValue(true, for: audio)
                self.armLivenessWatchdog()
            }
        }
        timer.resume()
        livenessTimer = timer
    }

    private func cancelLivenessWatchdog() {
        livenessTimer?.cancel()
        livenessTimer = nil
    }
}

// MARK: - CBCentralManagerDelegate

extension PendantBLETransport: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if wantsConnection { startConnecting() }
        case .poweredOff:
            setState(.bluetoothOff)
        default:
            break
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        // The scan filter already guarantees the audio service; adopt the
        // strongest first hit.
        central.stopScan()
        adopt(peripheral)
        storedIdentifier = peripheral.identifier
        onIdentified?(peripheral.identifier, peripheral.name ?? "Pendant")
        setState(.connecting)
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        cancelRetrievalTimeout()
        preferScan = false
        everConnected = true
        connectedAt = Date()
        reassembler.reset()
        livenessResubscribes = 0
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard !manualDisconnect else { return }
        // Never chase strangers: only retry peripherals that were connected.
        guard everConnected else {
            self.peripheral = nil
            if wantsConnection { startConnecting() }
            return
        }
        if isPairingLost(error) {
            setState(.pairingLost)
            wantsConnection = false
            return
        }
        setState(.reconnecting)
        scheduleReconnect()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        // Finalize in-flight audio: no further packet will trigger a gap
        // close, so flush the pending frame now.
        if let tail = reassembler.flush(), let connectedAt {
            onAudioFrame?(PendantAudioFrame(payload: tail, timestampMs: Date().timeIntervalSince(connectedAt) * 1000))
        }
        teardownSession()
        guard !manualDisconnect else {
            setState(.disconnected)
            return
        }
        if isPairingLost(error) {
            setState(.pairingLost)
            wantsConnection = false
            return
        }
        setState(.reconnecting)
        scheduleReconnect()
    }

    #if os(iOS) && !PENDANT_MOCK_BLE
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        // Re-adopt restored peripherals and mark them ever-connected, or the
        // reconnect pass will ignore them.
        let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        if let first = restored.first {
            adopt(first)
            storedIdentifier = first.identifier
            everConnected = true
            wantsConnection = true
        }
    }
    #endif

    private func isPairingLost(_ error: Error?) -> Bool {
        guard let cbError = error as? CBError else { return false }
        return cbError.code == .peerRemovedPairingInformation
    }
}

// MARK: - CBPeripheralDelegate

extension PendantBLETransport: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let services = peripheral.services else { return }
        pendingCharacteristicDiscovery = Set(services.map(ObjectIdentifier.init))
        for service in services {
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        // A FAILED discovery still retires the service. No further callback is
        // coming for it and there is no discovery timeout, so leaving it
        // pending would wedge the transport in .connecting forever. Continue
        // with a partial profile instead: absent characteristics make their
        // reads return nil and their subscriptions get skipped, which the
        // callers already handle.
        let wasPending = pendingCharacteristicDiscovery.remove(ObjectIdentifier(service)) != nil
        if error == nil {
            for characteristic in service.characteristics ?? [] {
                characteristics[fullUuid(characteristic.uuid)] = characteristic
            }
        }
        // Ready only when EVERY service has reported its characteristics -
        // counted from the callbacks WE received. Inspecting
        // service.characteristics instead is wrong on a reconnect:
        // CoreBluetooth keeps the objects discovered by the previous
        // connection, so every service reads as already-discovered, ready
        // fires on the first callback, and the subscriptions are armed
        // against a still-empty map - the silently-dead notifications this
        // class exists to defend against. Requiring the service to have been
        // pending also stops a late callback arriving after teardown from
        // finding the set empty and reporting ready again.
        guard wasPending, pendingCharacteristicDiscovery.isEmpty else { return }
        setState(.connected)
        armSubscriptions()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        let uuid = fullUuid(characteristic.uuid)
        if let completions = readCompletions.removeValue(forKey: uuid) {
            for completion in completions { completion(error == nil ? characteristic.value : nil) }
            // A read response doubles as a notification only for notify
            // characteristics; fall through for those.
            if !subscribed.contains(uuid) { return }
        }
        guard error == nil, let data = characteristic.value else { return }
        switch uuid {
        case Self.normalizedUuid(PendantUUID.audioData):
            sawAudioSinceArm = true
            if let frame = reassembler.feed(data), let connectedAt {
                onAudioFrame?(PendantAudioFrame(
                    payload: frame,
                    timestampMs: Date().timeIntervalSince(connectedAt) * 1000
                ))
            }
            if reassembler.lostFrames != reportedLoss {
                reportedLoss = reassembler.lostFrames
                onAudioLoss?(reportedLoss)
            }
        case Self.normalizedUuid(PendantUUID.batteryLevel):
            if let level = data.first { onBattery?(Int(level)) }
        case Self.normalizedUuid(PendantUUID.buttonTrigger):
            if let event = PendantButtonEvent.from(characteristicValue: data) { onButton?(event) }
        default:
            break
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        let uuid = fullUuid(characteristic.uuid)
        if let completions = writeCompletions.removeValue(forKey: uuid) {
            for completion in completions { completion(error == nil) }
        }
    }

    private func fullUuid(_ uuid: CBUUID) -> String {
        Self.normalizedUuid(uuid.uuidString)
    }
}
