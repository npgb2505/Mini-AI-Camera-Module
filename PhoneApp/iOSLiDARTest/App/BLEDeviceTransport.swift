import Combine
import CoreBluetooth
import Foundation

struct BLEDiscoveredDevice: Identifiable, Equatable {
    let id: UUID
    let name: String
    let rssi: Int
}

struct BLEDeviceIdentity: Decodable, Equatable {
    let schemaVersion: String
    let deviceId: String
    let bootId: String
    let firmwareVersion: String?

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case deviceId = "device_id"
        case bootId = "boot_id"
        case firmwareVersion = "firmware_version"
    }
}

struct BLEToFZone: Decodable, Equatable, Identifiable {
    let zone: String
    let tofValid: Bool
    let nearestCm: Double?

    enum CodingKeys: String, CodingKey {
        case zone
        case tofValid = "tof_valid"
        case nearestCm = "nearest_cm"
    }

    var id: String { zone }
}

struct BLEDeviceStatus: Decodable, Equatable {
    let schemaVersion: String
    let deviceId: String
    let bootId: String
    let sequence: UInt32
    let tMs: UInt32
    let latestButtonPressId: UInt32
    let operationEnabled: Bool
    let cameraOK: Bool
    let cameraFrameSeq: UInt32?
    let cameraAgeMs: UInt32?
    let networkOK: Bool?
    let tofOK: Bool
    let tofAgeMs: UInt32?
    let zones: [BLEToFZone]

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case deviceId = "device_id"
        case bootId = "boot_id"
        case sequence = "seq"
        case tMs = "t_ms"
        case latestButtonPressId = "latest_button_press_id"
        case operationEnabled = "operation_enabled"
        case cameraOK = "camera_ok"
        case cameraFrameSeq = "camera_frame_seq"
        case cameraAgeMs = "camera_age_ms"
        case networkOK = "network_ok"
        case tofOK = "tof_ok"
        case tofAgeMs = "tof_age_ms"
        case zones
    }
}

struct BLEButtonEvent: Decodable, Equatable, Identifiable {
    let schemaVersion: String
    let type: String
    let deviceId: String
    let bootId: String
    let buttonId: String
    let action: String
    let pressId: UInt32
    let pressedAtMs: UInt32
    let tMs: UInt32
    let operationEnabled: Bool
    let ageMs: UInt32
    let replayed: Bool

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case type, action
        case deviceId = "device_id"
        case bootId = "boot_id"
        case buttonId = "button_id"
        case pressId = "press_id"
        case pressedAtMs = "pressed_at_ms"
        case tMs = "t_ms"
        case operationEnabled = "operation_enabled"
        case ageMs = "age_ms"
        case replayed
    }

    var id: String { "\(deviceId.utf8.count):\(deviceId):\(bootId.utf8.count):\(bootId):\(pressId)" }

    var devicePayload: DeviceButtonEventPayload {
        DeviceButtonEventPayload(
            type: type,
            deviceId: deviceId,
            bootId: bootId,
            buttonId: buttonId,
            action: action,
            pressedAtMs: Int(pressedAtMs),
            pressId: Int(pressId),
            tMs: Int(tMs),
            operationEnabled: operationEnabled
        )
    }
}

private struct BLEButtonReplayRequest: Encodable {
    let schemaVersion = "1.0"
    let type = "button_event_replay"
    let deviceId: String
    let bootId: String
    let afterPressId: UInt32

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case type
        case deviceId = "device_id"
        case bootId = "boot_id"
        case afterPressId = "after_press_id"
    }
}

private struct BLEButtonReplayComplete: Decodable {
    let schemaVersion: String
    let type: String
    let deviceId: String
    let bootId: String
    let latestPressId: UInt32
    let historyTruncated: Bool?
    let oldestPressId: UInt32?
    let oldestPressIdWasReported: Bool

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case type
        case deviceId = "device_id"
        case bootId = "boot_id"
        case latestPressId = "latest_press_id"
        case historyTruncated = "history_truncated"
        case oldestPressId = "oldest_press_id"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(String.self, forKey: .schemaVersion)
        type = try container.decode(String.self, forKey: .type)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        bootId = try container.decode(String.self, forKey: .bootId)
        latestPressId = try container.decode(UInt32.self, forKey: .latestPressId)
        historyTruncated = try container.decodeIfPresent(Bool.self, forKey: .historyTruncated)
        oldestPressId = try container.decodeIfPresent(UInt32.self, forKey: .oldestPressId)
        oldestPressIdWasReported = container.contains(.oldestPressId)
    }
}

@MainActor
final class BLEDeviceTransport: NSObject, ObservableObject,
    @preconcurrency CBCentralManagerDelegate,
    @preconcurrency CBPeripheralDelegate {

    static let serviceUUID = CBUUID(string: "A72C0001-5E9B-4A2C-9F4B-4E2D6A610000")
    static let identityUUID = CBUUID(string: "A72C0001-5E9B-4A2C-9F4B-4E2D6A610001")
    static let statusUUID = CBUUID(string: "A72C0001-5E9B-4A2C-9F4B-4E2D6A610002")
    static let buttonEventsUUID = CBUUID(string: "A72C0001-5E9B-4A2C-9F4B-4E2D6A610003")
    private static let maximumStatusAgeMs = 1_000.0

    @Published private(set) var managerMessage = "Bluetooth chưa được khởi tạo."
    @Published private(set) var connectionMessage = "Chưa kết nối ESP32 qua Bluetooth."
    @Published private(set) var discoveredDevices: [BLEDiscoveredDevice] = []
    @Published private(set) var isScanning = false
    @Published private(set) var isLinkConnected = false
    @Published private(set) var connectedPeripheralID: UUID?
    @Published private(set) var contractReady = false
    @Published private(set) var connectedName: String?
    @Published private(set) var identity: BLEDeviceIdentity?
    @Published private(set) var status: BLEDeviceStatus?
    @Published private(set) var statusAgeMs: Int?
    @Published private(set) var latestButtonEvent: BLEButtonEvent?
    @Published private(set) var replayHistoryMessage: String?
    @Published private(set) var replayHistoryNeedsAttention = false
    @Published private(set) var errorMessage: String?

    var isContractFresh: Bool {
        contractReady
            && isLinkConnected
            && statusMatchesIdentity
            && hasFreshStatus
            && statusNotificationsReady
            && eventNotificationsReady
    }

    var displayedConnectionMessage: String {
        guard contractReady && !isContractFresh else { return connectionMessage }
        return hasFreshStatus
            ? "GATT chưa sẵn sàng; đang xác minh status BLE v1."
            : "Status BLE quá hạn 1 giây; chưa xác nhận kết nối thiết bị."
    }

    var onButtonEvent: ((BLEButtonEvent) -> Void)?
    var lastHandledPressID: ((String, String) -> UInt32?)?

    private static let savedPeripheralKey = "roSight.ble.peripheral.v1"
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var central: CBCentralManager?
    private var peripheralsByID: [UUID: CBPeripheral] = [:]
    private var activePeripheral: CBPeripheral?
    private var identityCharacteristic: CBCharacteristic?
    private var statusCharacteristic: CBCharacteristic?
    private var buttonEventsCharacteristic: CBCharacteristic?
    private var statusNotificationsReady = false
    private var eventNotificationsReady = false
    private var pendingScan = false
    private var pendingReconnectLookup = false
    private var shouldReconnect = false
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    private var scanTimeoutTask: Task<Void, Never>?
    private var requestedReplayFor: String?
    private var pendingStatusPayload: BLEAssembledPayload?
    private var nextReplayWriteMessageID: UInt8 = 0
    private var lastIdentityRefreshRequestAt: TimeInterval?
    private var pendingWriteFragments: [Data] = []
    private var pendingWriteCharacteristic: CBCharacteristic?
    private var isWritingFragments = false
    private var statusAssembler = BLEFragmentAssembler()
    private var eventAssembler = BLEFragmentAssembler()
    private var replayCursorForCurrentRequest: UInt32?

    func startScan() {
        ensureCentral()
        guard let central else { return }
        reconnectTask?.cancel()
        reconnectTask = nil
        pendingScan = true
        shouldReconnect = false
        pendingReconnectLookup = false
        discoveredDevices = []
        if central.state == .poweredOn {
            beginScan(using: central)
        } else {
            managerMessage = managerStateMessage(central.state)
        }
    }

    func stopScan() {
        pendingScan = false
        scanTimeoutTask?.cancel()
        scanTimeoutTask = nil
        if central?.isScanning == true { central?.stopScan() }
        isScanning = false
    }

    func connect(to id: UUID) {
        ensureCentral()
        guard let central, central.state == .poweredOn,
              let peripheral = peripheralsByID[id] else {
            errorMessage = "Đang chờ Bluetooth sẵn sàng hoặc thiết bị đã rời khỏi vùng quét."
            return
        }
        stopScan()
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempt = 0
        shouldReconnect = true
        UserDefaults.standard.set(id.uuidString, forKey: Self.savedPeripheralKey)
        if let current = activePeripheral, current.identifier != id {
            central.cancelPeripheralConnection(current)
        }
        activePeripheral = peripheral
        connectedName = peripheral.name
        connectionMessage = "Đang kết nối Bluetooth…"
        clearGattState()
        central.connect(peripheral, options: nil)
    }

    func disconnectByUser() {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        UserDefaults.standard.removeObject(forKey: Self.savedPeripheralKey)
        if let peripheral = activePeripheral {
            central?.cancelPeripheralConnection(peripheral)
        }
        clearGattState()
        connectionMessage = "Đã ngắt Bluetooth theo yêu cầu."
    }

    func suspendDeviceModeConnection() {
        shouldReconnect = false
        pendingReconnectLookup = false
        reconnectTask?.cancel()
        reconnectTask = nil
        stopScan()
        if let peripheral = activePeripheral {
            central?.cancelPeripheralConnection(peripheral)
        }
        connectionMessage = "Bluetooth tạm ngắt khi rời chế độ ESP32."
    }

    func reconnectSavedDeviceIfAvailable() {
        guard UserDefaults.standard.string(forKey: Self.savedPeripheralKey) != nil else { return }
        shouldReconnect = true
        ensureCentral()
        pendingReconnectLookup = true
        if let central, central.state == .poweredOn {
            connectToSavedPeripheral(using: central)
        }
    }

    func refreshStatusAge() {
        guard let receivedAt = statusReceivedAtUptime else {
            statusAgeMs = nil
            updateContractReady()
            return
        }
        let elapsed = max(0, (ProcessInfo.processInfo.systemUptime - receivedAt) * 1000)
        statusAgeMs = Int(elapsed.rounded())
        if elapsed > Self.maximumStatusAgeMs {
            contractReady = false
            if isLinkConnected {
                connectionMessage = "Status BLE quá hạn 1 giây; chưa xác nhận kết nối thiết bị."
            }
        } else {
            updateContractReady()
        }
    }

    private var statusReceivedAtUptime: TimeInterval?

    private var hasFreshStatus: Bool {
        guard let receivedAt = statusReceivedAtUptime else { return false }
        let elapsed = max(0, (ProcessInfo.processInfo.systemUptime - receivedAt) * 1000)
        return elapsed <= Self.maximumStatusAgeMs
    }

    private var statusMatchesIdentity: Bool {
        guard let identity, let status else { return false }
        return status.schemaVersion == "1.0"
            && status.deviceId == identity.deviceId
            && status.bootId == identity.bootId
    }

    private func ensureCentral() {
        guard central == nil else { return }
        central = CBCentralManager(
            delegate: self,
            queue: .main,
            options: [CBCentralManagerOptionShowPowerAlertKey: true]
        )
    }

    private func beginScan(using central: CBCentralManager) {
        guard central.state == .poweredOn else {
            managerMessage = managerStateMessage(central.state)
            isScanning = false
            return
        }
        central.scanForPeripherals(withServices: [Self.serviceUUID], options: nil)
        isScanning = true
        managerMessage = "Đang tìm thiết bị Ro Sight BLE trong tối đa 15 giây."
        scanTimeoutTask?.cancel()
        scanTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard !Task.isCancelled else { return }
            self?.stopScan()
            if self?.discoveredDevices.isEmpty == true {
                self?.managerMessage = "Không thấy ESP32 quảng bá service Ro Sight BLE v1."
            }
            if self?.shouldReconnect == true, self?.isLinkConnected == false { self?.scheduleReconnect() }
        }
    }

    private func managerStateMessage(_ state: CBManagerState) -> String {
        switch state {
        case .poweredOn:
            return "Bluetooth sẵn sàng."
        case .poweredOff:
            return "Bật Bluetooth trên iPhone để tìm ESP32."
        case .unauthorized:
            return "Quyền Bluetooth bị từ chối; bật quyền cho Ro Sight trong Cài đặt iPhone."
        case .unsupported:
            return "Thiết bị này không hỗ trợ Bluetooth LE."
        case .resetting:
            return "Bluetooth đang khởi động lại."
        case .unknown:
            return "Đang chờ trạng thái Bluetooth."
        @unknown default:
            return "Bluetooth chưa sẵn sàng."
        }
    }

    private func connectToSavedPeripheral(using central: CBCentralManager) {
        guard let value = UserDefaults.standard.string(forKey: Self.savedPeripheralKey),
              let identifier = UUID(uuidString: value) else {
            pendingReconnectLookup = false
            return
        }
        guard let peripheral = central.retrievePeripherals(withIdentifiers: [identifier]).first else {
            pendingReconnectLookup = false
            pendingScan = true
            beginScan(using: central)
            return
        }
        if activePeripheral?.identifier == identifier,
           (peripheral.state == .connected || peripheral.state == .connecting) {
            pendingReconnectLookup = false
            if peripheral.state == .connected { connectedPeripheralID = identifier }
            return
        }
        pendingReconnectLookup = false
        if let current = activePeripheral,
           current.identifier != peripheral.identifier,
           (current.state == .connected || current.state == .connecting) {
            central.cancelPeripheralConnection(current)
        }
        activePeripheral = peripheral
        connectedName = peripheral.name
        connectionMessage = "Đang kết nối lại với ESP32…"
        central.connect(peripheral, options: nil)
    }

    private func scheduleReconnect() {
        guard shouldReconnect, reconnectTask == nil else { return }
        pendingReconnectLookup = true
        reconnectAttempt += 1
        let delaySeconds = min(30, 1 << min(reconnectAttempt - 1, 5))
        connectionMessage = "Bluetooth bị ngắt; đang thử kết nối lại sau \(delaySeconds) giây."
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delaySeconds) * 1_000_000_000)
            guard !Task.isCancelled, let self else { return }
            self.reconnectTask = nil
            guard self.shouldReconnect else { return }
            guard let central = self.central, central.state == .poweredOn else {
                self.pendingReconnectLookup = true
                return
            }
            self.pendingReconnectLookup = false
            self.connectToSavedPeripheral(using: central)
        }
    }

    private func clearGattState() {
        isLinkConnected = false
        connectedPeripheralID = nil
        contractReady = false
        identity = nil
        status = nil
        statusAgeMs = nil
        statusReceivedAtUptime = nil
        latestButtonEvent = nil
        replayHistoryMessage = nil
        replayHistoryNeedsAttention = false
        identityCharacteristic = nil
        statusCharacteristic = nil
        buttonEventsCharacteristic = nil
        statusNotificationsReady = false
        eventNotificationsReady = false
        requestedReplayFor = nil
        pendingStatusPayload = nil
        nextReplayWriteMessageID = 0
        lastIdentityRefreshRequestAt = nil
        pendingWriteFragments = []
        pendingWriteCharacteristic = nil
        isWritingFragments = false
        replayCursorForCurrentRequest = nil
        statusAssembler.reset()
        eventAssembler.reset()
    }

    private func requestButtonReplayIfReady() {
        guard isContractFresh,
              eventNotificationsReady,
              let identity,
              let characteristic = buttonEventsCharacteristic,
              status != nil else { return }
        let replayKey = "\(identity.deviceId.utf8.count):\(identity.deviceId):\(identity.bootId.utf8.count):\(identity.bootId)"
        guard requestedReplayFor != replayKey else { return }
        requestedReplayFor = replayKey
        replayHistoryMessage = nil
        replayHistoryNeedsAttention = false
        let cursor = lastHandledPressID?(identity.deviceId, identity.bootId)
            ?? status?.latestButtonPressId
            ?? 0
        replayCursorForCurrentRequest = cursor
        let request = BLEButtonReplayRequest(
            deviceId: identity.deviceId,
            bootId: identity.bootId,
            afterPressId: cursor
        )
        do {
            let data = try encoder.encode(request)
            writeChunked(data, to: characteristic)
        } catch {
            requestedReplayFor = nil
            errorMessage = "Không tạo được yêu cầu đồng bộ sự kiện nút Bluetooth."
        }
    }

    private func writeChunked(_ message: Data, to characteristic: CBCharacteristic) {
        guard let peripheral = activePeripheral else { return }
        let payloadLimit = min(508, max(0, peripheral.maximumWriteValueLength(for: .withResponse) - 4))
        guard payloadLimit > 0 else {
            requestedReplayFor = nil
            errorMessage = "Bluetooth không thương lượng được kích thước gói để đồng bộ nút."
            return
        }
        let bytes = [UInt8](message)
        let count = Int(ceil(Double(bytes.count) / Double(payloadLimit)))
        guard count > 0, count <= 255 else {
            requestedReplayFor = nil
            errorMessage = "Thông điệp đồng bộ nút vượt giới hạn BLE."
            return
        }
        let messageID = nextReplayWriteMessageID
        nextReplayWriteMessageID &+= 1
        pendingWriteFragments = (0..<count).map { index in
            let start = index * payloadLimit
            let end = min(bytes.count, start + payloadLimit)
            var fragment: [UInt8] = [1, messageID, UInt8(index), UInt8(count)]
            fragment.append(contentsOf: bytes[start..<end])
            return Data(fragment)
        }
        pendingWriteCharacteristic = characteristic
        writeNextFragmentIfPossible()
    }

    private func writeNextFragmentIfPossible() {
        guard !isWritingFragments,
              !pendingWriteFragments.isEmpty,
              let peripheral = activePeripheral,
              let characteristic = pendingWriteCharacteristic else { return }
        isWritingFragments = true
        let fragment = pendingWriteFragments.removeFirst()
        peripheral.writeValue(fragment, for: characteristic, type: .withResponse)
    }

    private func consumeCharacteristicValue(_ characteristic: CBCharacteristic) {
        guard let value = characteristic.value else { return }
        let payload: Data?
        var receivedAtUptime = ProcessInfo.processInfo.systemUptime
        if characteristic.uuid == Self.statusUUID {
            let assembled = statusAssembler.append(value)
            payload = assembled?.data
            receivedAtUptime = assembled?.receivedAtUptime ?? receivedAtUptime
        } else if characteristic.uuid == Self.buttonEventsUUID {
            payload = eventAssembler.append(value)?.data
        } else {
            payload = value
        }
        guard let payload else { return }
        if characteristic.uuid == Self.identityUUID {
            decodeIdentity(payload)
        } else if characteristic.uuid == Self.statusUUID {
            decodeStatus(payload, receivedAtUptime: receivedAtUptime)
        } else if characteristic.uuid == Self.buttonEventsUUID {
            decodeButtonEvent(payload)
        }
    }

    private func decodeIdentity(_ data: Data) {
        do {
            let value = try decoder.decode(BLEDeviceIdentity.self, from: data)
            guard value.schemaVersion == "1.0",
                  !value.deviceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  value.deviceId == value.deviceId.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.bootId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  value.bootId == value.bootId.trimmingCharacters(in: .whitespacesAndNewlines) else {
                throw BLETransportError.invalidIdentity
            }
            let identityRefreshWasRequested = lastIdentityRefreshRequestAt != nil
            let identityChanged = identity.map {
                $0.deviceId != value.deviceId || $0.bootId != value.bootId
            } ?? false
            if identityChanged {
                status = nil
                statusAgeMs = nil
                statusReceivedAtUptime = nil
                latestButtonEvent = nil
                replayHistoryMessage = nil
                replayHistoryNeedsAttention = false
                requestedReplayFor = nil
                contractReady = false
            }
            identity = value
            errorMessage = nil
            if let pendingStatusPayload {
                self.pendingStatusPayload = nil
                decodeStatus(pendingStatusPayload.data, receivedAtUptime: pendingStatusPayload.receivedAtUptime)
            } else if identityChanged || identityRefreshWasRequested,
                      let activePeripheral,
                      let statusCharacteristic {
                activePeripheral.readValue(for: statusCharacteristic)
            }
            requestButtonReplayIfReady()
            updateContractReady()
        } catch {
            identity = nil
            status = nil
            statusAgeMs = nil
            statusReceivedAtUptime = nil
            latestButtonEvent = nil
            replayHistoryMessage = nil
            replayHistoryNeedsAttention = false
            pendingStatusPayload = nil
            requestedReplayFor = nil
            contractReady = false
            connectionMessage = "Identity BLE sai schema v1; chưa xác minh kết nối."
            errorMessage = "Thiết bị BLE trả identity không đúng schema v1."
        }
    }

    private func decodeStatus(_ data: Data, receivedAtUptime: TimeInterval) {
        guard let identity else {
            pendingStatusPayload = (data, receivedAtUptime)
            return
        }
        do {
            let value = try decoder.decode(BLEDeviceStatus.self, from: data)
            guard value.schemaVersion == "1.0",
                  value.deviceId == identity.deviceId,
                  value.bootId == identity.bootId,
                  !value.bootId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  value.deviceId == value.deviceId.trimmingCharacters(in: .whitespacesAndNewlines),
                  value.bootId == value.bootId.trimmingCharacters(in: .whitespacesAndNewlines) else {
                status = nil
                statusAgeMs = nil
                statusReceivedAtUptime = nil
                latestButtonEvent = nil
                requestedReplayFor = nil
                contractReady = false
                requestIdentityRefreshIfNeeded()
                connectionMessage = "BLE status khác identity/device/boot; đang xác minh lại."
                throw BLETransportError.invalidStatus
            }
            if let previous = status {
                let sequenceDelta = value.sequence &- previous.sequence
                let timeDelta = value.tMs &- previous.tMs
                guard sequenceDelta > 0,
                      sequenceDelta < 0x8000_0000,
                      timeDelta > 0,
                      timeDelta < 0x8000_0000 else {
                    throw BLETransportError.staleStatus
                }
            }
            status = value
            statusReceivedAtUptime = receivedAtUptime
            let elapsed = max(0, (ProcessInfo.processInfo.systemUptime - receivedAtUptime) * 1000)
            statusAgeMs = Int(elapsed.rounded())
            lastIdentityRefreshRequestAt = nil
            errorMessage = nil
            updateContractReady()
            requestButtonReplayIfReady()
        } catch {
            errorMessage = error is BLETransportError
                ? "Thiết bị BLE trả status v1 lặp, cũ hoặc khác identity/device/boot."
                : "Thiết bị BLE trả status không đúng schema v1."
        }
    }

    private func requestIdentityRefreshIfNeeded() {
        let now = ProcessInfo.processInfo.systemUptime
        if let lastRequest = lastIdentityRefreshRequestAt, now - lastRequest < 1 {
            return
        }
        guard let activePeripheral, let identityCharacteristic else { return }
        lastIdentityRefreshRequestAt = now
        activePeripheral.readValue(for: identityCharacteristic)
    }

    private func decodeButtonEvent(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else {
            errorMessage = "Không đọc được thông điệp sự kiện BLE."
            return
        }
        if type == "button_event_replay_complete" {
            guard isContractFresh,
                  let identity,
                  let completion = try? decoder.decode(BLEButtonReplayComplete.self, from: data),
                  completion.schemaVersion == "1.0",
                  completion.type == "button_event_replay_complete",
                  completion.deviceId == identity.deviceId,
                  completion.bootId == identity.bootId else {
                errorMessage = "Thiết bị BLE trả xác nhận replay nút sai schema hoặc phiên."
                return
            }
            updateReplayHistoryStatus(completion, afterPressID: replayCursorForCurrentRequest)
            replayCursorForCurrentRequest = nil
            return
        }
        do {
            let event = try decoder.decode(BLEButtonEvent.self, from: data)
            guard isContractFresh,
                  event.schemaVersion == "1.0",
                  event.type == "button_event",
                  event.action == "pressed",
                  ["mode", "capture_image", "ask_llm"].contains(event.buttonId),
                  event.deviceId == identity?.deviceId,
                  event.bootId == identity?.bootId,
                  event.pressId > 0,
                  event.ageMs <= 10_000 else {
                throw BLETransportError.invalidEvent
            }
            latestButtonEvent = event
            onButtonEvent?(event)
        } catch {
            errorMessage = "Thiết bị BLE trả button_event không đúng schema hoặc phiên."
        }
    }

    private func updateReplayHistoryStatus(
        _ completion: BLEButtonReplayComplete,
        afterPressID: UInt32?
    ) {
        guard let historyTruncated = completion.historyTruncated else {
            replayHistoryNeedsAttention = true
            replayHistoryMessage = "Firmware chưa báo metadata đầy đủ để xác nhận lịch sử nút có bị thiếu hay không."
            return
        }

        if historyTruncated {
            replayHistoryNeedsAttention = true
            guard completion.oldestPressIdWasReported else {
                replayHistoryMessage = "Firmware báo thiếu lịch sử replay nhưng không gửi oldest_press_id; không thể xác định các press còn giữ."
                return
            }
            guard let oldest = completion.oldestPressId else {
                replayHistoryMessage = "Firmware báo thiếu lịch sử replay và hiện không còn press nào trong cửa sổ lưu 10 giây."
                return
            }
            if !Self.isWrapSafePressRange(oldest: oldest, latest: completion.latestPressId) {
                replayHistoryMessage = "Firmware báo thiếu lịch sử replay nhưng metadata khoảng press không nhất quán; không thể xác định vùng còn giữ."
                return
            }
            replayHistoryMessage = "Firmware báo thiếu lịch sử replay; các press còn giữ bắt đầu từ #\(oldest) và kết thúc tại #\(completion.latestPressId). Những press ngoài vùng lưu không thể khôi phục."
            return
        }

        guard completion.oldestPressIdWasReported else {
            replayHistoryNeedsAttention = true
            replayHistoryMessage = "Firmware chưa gửi oldest_press_id; chưa thể xác nhận lịch sử replay đầy đủ."
            return
        }

        guard let afterPressID else {
            replayHistoryNeedsAttention = true
            replayHistoryMessage = "Không có cursor của yêu cầu replay; app chưa thể xác nhận phạm vi lịch sử."
            return
        }

        if !Self.isWrapSafePressAtOrAfter(completion.latestPressId, afterPressID) {
            replayHistoryNeedsAttention = true
            replayHistoryMessage = "Firmware trả latest_press_id cũ hơn hoặc quá xa cursor; app chưa thể xác nhận phạm vi replay."
            return
        }

        guard let oldest = completion.oldestPressId else {
            replayHistoryNeedsAttention = false
            replayHistoryMessage = "Firmware báo không thiếu press sau cursor; hiện không còn event nào trong cửa sổ replay 10 giây."
            return
        }

        guard Self.isWrapSafePressRange(oldest: oldest, latest: completion.latestPressId) else {
            replayHistoryNeedsAttention = true
            replayHistoryMessage = "Firmware trả press range không nhất quán; chưa thể xác nhận lịch sử replay đầy đủ."
            return
        }

        replayHistoryNeedsAttention = false
        replayHistoryMessage = "Firmware báo replay không bị cắt (press #\(oldest) đến #\(completion.latestPressId)); app vẫn kiểm tra từng event trước khi xử lý."
    }

    private static func isWrapSafePressAtOrAfter(_ candidate: UInt32, _ reference: UInt32) -> Bool {
        let distance = candidate &- reference
        return distance < 0x8000_0000
    }

    private static func isWrapSafePressRange(oldest: UInt32, latest: UInt32) -> Bool {
        let distance = latest &- oldest
        return oldest != 0 && latest != 0 && distance < 0x8000_0000
    }

    private func updateContractReady() {
        guard isLinkConnected,
              statusMatchesIdentity,
              hasFreshStatus,
              statusNotificationsReady,
              eventNotificationsReady else {
            contractReady = false
            if isLinkConnected {
                if statusReceivedAtUptime != nil && !hasFreshStatus {
                    connectionMessage = "Status BLE quá hạn 1 giây; chưa xác nhận kết nối thiết bị."
                } else if status != nil && !statusMatchesIdentity {
                    connectionMessage = "BLE status không khớp identity/device/boot; đang xác minh lại."
                } else if identity == nil || status == nil {
                    connectionMessage = "Đang xác minh identity và status BLE v1."
                } else {
                    connectionMessage = "Đang chờ status và sự kiện nút BLE v1 sẵn sàng."
                }
            }
            return
        }
        contractReady = true
        connectionMessage = "BLE v1 hợp lệ · identity khớp status mới dưới 1 giây."
    }

    private func reconnectLookupAfterStateChange() {
        guard pendingReconnectLookup, let central, central.state == .poweredOn else { return }
        reconnectTask?.cancel()
        reconnectTask = nil
        connectToSavedPeripheral(using: central)
    }
}

extension BLEDeviceTransport {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        managerMessage = managerStateMessage(central.state)
        guard central.state == .poweredOn else {
            if shouldReconnect { pendingReconnectLookup = true }
            if central.state == .poweredOff || central.state == .unauthorized || central.state == .unsupported {
                clearGattState()
            }
            isScanning = false
            return
        }
        if pendingScan { beginScan(using: central) }
        reconnectLookupAfterStateChange()
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        peripheralsByID[peripheral.identifier] = peripheral
        let advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let name = advertisedName ?? peripheral.name ?? "ESP32 Ro Sight"
        let item = BLEDiscoveredDevice(id: peripheral.identifier, name: name, rssi: RSSI.intValue)
        if let index = discoveredDevices.firstIndex(where: { $0.id == item.id }) {
            discoveredDevices[index] = item
        } else {
            discoveredDevices.append(item)
        }
        discoveredDevices.sort { $0.rssi > $1.rssi }

        if shouldReconnect,
           let saved = UserDefaults.standard.string(forKey: Self.savedPeripheralKey),
           saved == peripheral.identifier.uuidString,
           activePeripheral?.identifier != peripheral.identifier {
            stopScan()
            activePeripheral = peripheral
            connectedName = name
            connectionMessage = "Đang kết nối lại với ESP32…"
            central.connect(peripheral, options: nil)
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral.identifier == activePeripheral?.identifier else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempt = 0
        activePeripheral = peripheral
        connectedName = peripheral.name ?? connectedName
        connectionMessage = "Đang xác minh GATT v1 và status mới; Bluetooth chưa được xác nhận."
        errorMessage = nil
        clearGattState()
        isLinkConnected = true
        connectedPeripheralID = peripheral.identifier
        peripheral.delegate = self
        peripheral.discoverServices([Self.serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheral.identifier == activePeripheral?.identifier else { return }
        clearGattState()
        connectionMessage = "Không kết nối được ESP32 qua Bluetooth."
        errorMessage = error == nil ? nil : "Không kết nối được ESP32 qua Bluetooth. Kiểm tra nguồn thiết bị rồi thử lại."
        scheduleReconnect()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral.identifier == activePeripheral?.identifier else { return }
        clearGattState()
        if shouldReconnect {
            connectionMessage = "Bluetooth đã ngắt; sẽ thử kết nối lại."
            scheduleReconnect()
        } else {
            connectionMessage = "Bluetooth đã ngắt."
        }
        if error != nil { errorMessage = "Kết nối Bluetooth bị gián đoạn. App sẽ thử kết nối lại." }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral.identifier == activePeripheral?.identifier else { return }
        guard error == nil,
              let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
            errorMessage = "Firmware chưa cung cấp service Ro Sight BLE v1."
            contractReady = false
            return
        }
        peripheral.discoverCharacteristics(
            [Self.identityUUID, Self.statusUUID, Self.buttonEventsUUID],
            for: service
        )
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        guard peripheral.identifier == activePeripheral?.identifier else { return }
        guard error == nil else {
            errorMessage = "Không đọc được characteristic của service BLE."
            return
        }
        for characteristic in service.characteristics ?? [] {
            switch characteristic.uuid {
            case Self.identityUUID:
                identityCharacteristic = characteristic
            case Self.statusUUID:
                statusCharacteristic = characteristic
            case Self.buttonEventsUUID:
                buttonEventsCharacteristic = characteristic
            default:
                continue
            }
        }
        guard let identityCharacteristic,
              let statusCharacteristic,
              let buttonEventsCharacteristic,
              identityCharacteristic.properties.contains(.read),
              statusCharacteristic.properties.contains(.read),
              statusCharacteristic.properties.contains(.notify),
              buttonEventsCharacteristic.properties.contains(.write),
              buttonEventsCharacteristic.properties.contains(.notify) else {
            errorMessage = "GATT chưa đủ characteristic read/notify/write theo hợp đồng v1."
            contractReady = false
            return
        }
        peripheral.readValue(for: identityCharacteristic)
        peripheral.readValue(for: statusCharacteristic)
        peripheral.setNotifyValue(true, for: statusCharacteristic)
        peripheral.setNotifyValue(true, for: buttonEventsCharacteristic)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard peripheral.identifier == activePeripheral?.identifier else { return }
        guard error == nil else {
            if characteristic.uuid == Self.statusUUID {
                statusNotificationsReady = false
            } else if characteristic.uuid == Self.buttonEventsUUID {
                eventNotificationsReady = false
            }
            updateContractReady()
            errorMessage = "Không bật được thông báo BLE cho \(characteristic.uuid.uuidString)."
            return
        }
        if characteristic.uuid == Self.statusUUID {
            statusNotificationsReady = characteristic.isNotifying
        } else if characteristic.uuid == Self.buttonEventsUUID {
            eventNotificationsReady = characteristic.isNotifying
        }
        updateContractReady()
        requestButtonReplayIfReady()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral.identifier == activePeripheral?.identifier else { return }
        guard error == nil else {
            errorMessage = "Không đọc được dữ liệu BLE từ \(characteristic.uuid.uuidString)."
            return
        }
        consumeCharacteristicValue(characteristic)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard peripheral.identifier == activePeripheral?.identifier else { return }
        isWritingFragments = false
        if let error {
            pendingWriteFragments = []
            pendingWriteCharacteristic = nil
            requestedReplayFor = nil
            errorMessage = "Không đồng bộ được sự kiện nút qua Bluetooth. Kết nối lại ESP32 rồi thử lại."
            return
        }
        if pendingWriteFragments.isEmpty {
            pendingWriteCharacteristic = nil
            return
        }
        writeNextFragmentIfPossible()
    }
}

private struct BLEFragmentAssembler {
    private var messageID: UInt8?
    private var fragmentCount: Int?
    private var fragments: [Int: Data] = [:]
    private var startedAt: TimeInterval?
    private var totalBytes = 0

    mutating func reset() {
        messageID = nil
        fragmentCount = nil
        fragments.removeAll(keepingCapacity: false)
        startedAt = nil
        totalBytes = 0
    }

    mutating func append(_ data: Data) -> BLEAssembledPayload? {
        if data.first == 0x7B {
            reset()
            guard data.count <= 8_192 else { return nil }
            return BLEAssembledPayload(data: data, receivedAtUptime: ProcessInfo.processInfo.systemUptime)
        }
        guard data.count >= 5, data.count <= 512 else {
            reset()
            return nil
        }
        let bytes = [UInt8](data)
        guard bytes[0] == 1,
              bytes[3] > 0,
              bytes[2] < bytes[3] else {
            reset()
            return nil
        }
        let now = ProcessInfo.processInfo.systemUptime
        if let startedAt, now - startedAt > 2 { reset() }
        if messageID != bytes[1] || fragmentCount != Int(bytes[3]) {
            reset()
            messageID = bytes[1]
            fragmentCount = Int(bytes[3])
            startedAt = now
        }
        let index = Int(bytes[2])
        guard fragments[index] == nil else { return nil }
        let chunk = Data(bytes.dropFirst(4))
        totalBytes += chunk.count
        guard totalBytes <= 8_192 else {
            reset()
            return nil
        }
        fragments[index] = chunk
        guard let count = fragmentCount, fragments.count == count else { return nil }
        var message = Data()
        for fragmentIndex in 0..<count {
            guard let fragment = fragments[fragmentIndex] else { return nil }
            message.append(fragment)
        }
        let completedAtUptime = ProcessInfo.processInfo.systemUptime
        let receivedAtUptime = startedAt ?? completedAtUptime
        reset()
        return BLEAssembledPayload(data: message, receivedAtUptime: receivedAtUptime)
    }
}

private struct BLEAssembledPayload {
    let data: Data
    let receivedAtUptime: TimeInterval
}

private enum BLETransportError: Error {
    case invalidIdentity
    case invalidStatus
    case staleStatus
    case invalidEvent
}
