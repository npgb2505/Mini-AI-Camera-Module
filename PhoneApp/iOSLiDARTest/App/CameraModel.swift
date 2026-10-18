import Foundation
import SwiftUI
import AVFoundation
import UIKit

struct FusedDetection: Identifiable {
    let id = UUID()
    let label: String
    let confidence: Double
    let distanceMeters: Double?
}

private struct PendingDeviceButtonAction {
    let event: DeviceButtonEventPayload
    let deviceID: String
    let bootID: String
    let authenticationGeneration: Int
    let statusReceivedAtUptime: TimeInterval
    let eventAgeMs: Double
    let expectedFrameSequence: Int?
}

private struct PendingBLEButtonEvent {
    let event: BLEButtonEvent
    let receivedAtUptime: TimeInterval
}

@MainActor
final class CameraModel: NSObject, ObservableObject, @preconcurrency AVSpeechSynthesizerDelegate {
    @Published var detectionEnabled = false
    @Published var isDetecting = false
    @Published var isAsking = false
    @Published var centerDistance: Double?
    @Published private(set) var phoneSceneDepthSupported: Bool?
    @Published private(set) var phoneProximityAlertStatus = "Chưa có số đo LiDAR mới."
    @Published var detections: [FusedDetection] = []
    @Published var answer = ""
    @Published private(set) var isSpeakingAnswer = false
    @Published private(set) var speechError: String?
    @Published var status = "Chọn chế độ camera để bắt đầu."
    @Published private(set) var phoneFrameFresh = false
    @Published private(set) var phoneDetectionsFresh = false
    @Published private(set) var phoneDetectorReady: Bool?
    @Published private(set) var phoneDetectorModel: String?

    private var backendBaseURL = ""
    private var accountUsername = ""
    private var accountPassword = ""
    private var accessUsername = ""
    private var accessPassword = ""
    private var isAuthenticated = false
    private var authenticationError: String?
    private var authenticationRetryAfter = Date.distantPast
    private var authenticationTask: Task<Void, Error>?
    private var authenticationGeneration = 0
    private var latestJPEG: Data?
    private var latestJPEGAt: Date?
    private var phoneDepthUpdatedAt: Date?
    private var phoneProximityAlertsEnabled = true
    private var phoneNearReadingLatched = false
    private var phoneDetectionsCapturedAt: Date?
    private var lastVisionStatusCheck: Date?
    private var phoneModeActive = false
    private var phoneModeGeneration = 0
    private var phoneDetectionGeneration = 0
    private var phoneAskGeneration = 0
    private var deviceAskGeneration = 0
    private var deviceSpeechGeneration = 0
    private let speechSynthesizer = AVSpeechSynthesizer()
    private var activeSpeechUtteranceID: ObjectIdentifier?
    private var speechSessionActive = false
    private var activeSpeechIsProximityAlert = false

    @Published private(set) var deviceConnection: DeviceConnectionPayload?
    @Published private(set) var deviceFrameData: Data?
    @Published private(set) var deviceFrameSequence: Int?
    @Published private(set) var deviceDetections: [DeviceDetection] = []
    @Published private(set) var deviceZones: [DeviceZone] = []
    @Published private(set) var deviceVisionReady: Bool?
    @Published private(set) var deviceVisionProvider: String?
    @Published private(set) var deviceError: String?
    @Published private(set) var deviceAnswer = ""
    @Published private(set) var deviceAnswerFrameSequence: Int?
    @Published private(set) var deviceAskError: String?
    @Published private(set) var isDeviceAsking = false
    @Published private(set) var isSendingDeviceSpeech = false
    @Published private(set) var deviceSpeakerMessage: String?
    @Published private(set) var isSendingDeviceControl = false
    @Published private(set) var deviceControlMessage: String?
    @Published private(set) var deviceControlError: String?
    @Published private(set) var isRefreshingDevice = false
    @Published private(set) var deviceFreshnessRevision = 0
    @Published private(set) var deviceButtonMessage: String?
    @Published private(set) var deviceCaptureError: String?
    @Published private(set) var deviceCapturedFrameData: Data?
    @Published private(set) var deviceCapturedFrameSequence: Int?
    @Published private(set) var deviceCapturedFramePressId: Int?
    @Published private(set) var deviceAnswerButtonPressId: Int?
    @Published private(set) var isCapturingDeviceFrame = false

    private var deviceStatusReceivedAtUptime: TimeInterval?
    private var lastDeviceCameraReady: Bool?
    private var handledDeviceButtonEventKeys: Set<String>
    private var handledDeviceButtonEventOrder: [String]
    private var pendingBLEButtonEvents: [PendingBLEButtonEvent] = []
    private static let handledDeviceButtonEventsDefaultsKey = "roSight.handledDeviceButtonEvents.v1"
    private static let maximumHandledDeviceButtonEvents = 512
    private static let deviceFrameFreshnessMs = 350.0
    private static let deviceSpeakerStatusFreshnessMs = 1_000.0
    private static let maximumDeviceFrameBytes = 2 * 1024 * 1024
    private static let phoneFrameFreshnessSeconds = 2.5
    private static let phoneDetectionFreshnessSeconds = 2.5
    private static let phoneDepthFreshnessSeconds = 1.0
    static let phoneProximityAlertThresholdMeters = 0.8
    static let phoneProximityResetThresholdMeters = 1.05

    override init() {
        let savedButtonEvents = Array(
            (UserDefaults.standard.stringArray(forKey: Self.handledDeviceButtonEventsDefaultsKey) ?? [])
                .suffix(Self.maximumHandledDeviceButtonEvents)
        )
        handledDeviceButtonEventOrder = savedButtonEvents
        handledDeviceButtonEventKeys = Set(savedButtonEvents)
        super.init()
        speechSynthesizer.delegate = self
    }

    var phoneHasFreshFrame: Bool {
        guard let latestJPEGAt else { return false }
        let age = Date().timeIntervalSince(latestJPEGAt)
        return age >= 0 && age <= Self.phoneFrameFreshnessSeconds
    }

    func refreshPhoneFreshness() {
        let frameFresh = phoneHasFreshFrame
        if phoneFrameFresh != frameFresh { phoneFrameFresh = frameFresh }

        if let phoneDepthUpdatedAt {
            let age = Date().timeIntervalSince(phoneDepthUpdatedAt)
            if age < 0 || age > Self.phoneDepthFreshnessSeconds {
                centerDistance = nil
                self.phoneDepthUpdatedAt = nil
                phoneProximityAlertStatus = "LiDAR quá hạn; đang chờ số đo mới."
                if !detectionEnabled {
                    status = "Đang chờ sceneDepth mới."
                }
            }
        }

        let detectionFresh = phoneDetectionsCapturedAt.map { capturedAt in
            let age = Date().timeIntervalSince(capturedAt)
            return age >= 0 && age <= Self.phoneDetectionFreshnessSeconds
        } ?? false
        if phoneDetectionsFresh != detectionFresh { phoneDetectionsFresh = detectionFresh }
    }

    func configure(
        baseURL: String,
        accountUsername: String,
        accountPassword: String,
        accessUsername: String,
        accessPassword: String,
        forceReauthenticate: Bool = false
    ) {
        let normalizedURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if forceReauthenticate
            || normalizedURL != backendBaseURL
            || accountUsername.trimmingCharacters(in: .whitespacesAndNewlines) != self.accountUsername
            || accountPassword != self.accountPassword
            || accessUsername != self.accessUsername
            || accessPassword != self.accessPassword {
            stopSpeakingAnswer()
            cancelDeviceSpeech()
            authenticationGeneration += 1
            authenticationTask?.cancel()
            authenticationTask = nil
            isAuthenticated = false
            authenticationError = nil
            authenticationRetryAfter = .distantPast
            lastVisionStatusCheck = nil
            deviceStatusReceivedAtUptime = nil
            deviceVisionReady = nil
            deviceVisionProvider = nil
            phoneDetectorReady = nil
            phoneDetectorModel = nil
            deviceConnection = nil
            deviceError = nil
            deviceAskError = nil
            deviceSpeakerMessage = nil
            deviceControlMessage = nil
            deviceControlError = nil
            isSendingDeviceControl = false
            deviceAnswer = ""
            deviceAnswerFrameSequence = nil
            deviceAnswerButtonPressId = nil
            deviceButtonMessage = nil
            deviceCaptureError = nil
            deviceCapturedFrameData = nil
            deviceCapturedFrameSequence = nil
            deviceCapturedFramePressId = nil
            isCapturingDeviceFrame = false
            phoneAskGeneration += 1
            deviceAskGeneration += 1
            isAsking = false
            isDeviceAsking = false
            clearDevicePreview()
        }
        backendBaseURL = normalizedURL
        self.accountUsername = accountUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        self.accountPassword = accountPassword
        self.accessUsername = accessUsername
        self.accessPassword = accessPassword
        if backendBaseURL.isEmpty {
            status = "Nhập địa chỉ Flask để dùng YOLO server trong prototype camera iPhone hoặc hỏi AI."
        } else if self.accountUsername.isEmpty || self.accountPassword.isEmpty {
            status = "Nhập tài khoản Ro Sight trong cài đặt để kết nối."
        } else {
            status = "Đã lưu địa chỉ backend cho phiên này."
        }
    }

    func updateCenterDistance(_ value: Double?) {
        guard phoneModeActive else { return }
        let freshReading = value.flatMap { reading in
            reading.isFinite && (0.15...10).contains(reading) ? reading : nil
        }
        centerDistance = freshReading
        phoneDepthUpdatedAt = freshReading == nil ? nil : Date()
        updatePhoneProximityAlert(for: freshReading)
        if freshReading == nil, !detectionEnabled {
            status = "Chưa nhận được dữ liệu LiDAR."
        }
    }

    func updatePhoneSceneDepthSupport(_ supported: Bool) {
        guard phoneModeActive else { return }
        phoneSceneDepthSupported = supported
    }

    func setPhoneProximityAlertsEnabled(_ enabled: Bool) {
        guard phoneProximityAlertsEnabled != enabled else { return }
        phoneProximityAlertsEnabled = enabled
        if !enabled {
            phoneNearReadingLatched = false
            phoneProximityAlertStatus = "Đã tắt đọc cảnh báo LiDAR."
            if activeSpeechIsProximityAlert {
                stopSpeakingAnswer()
            }
            return
        }
        phoneNearReadingLatched = false
        phoneProximityAlertStatus = "Đã bật; đang chờ số đo LiDAR mới để đọc cảnh báo."
    }

    private func updatePhoneProximityAlert(for distance: Double?) {
        guard phoneProximityAlertsEnabled else { return }
        guard let distance else {
            phoneProximityAlertStatus = "Chưa có số đo LiDAR mới; cảnh báo không dùng dữ liệu cũ."
            return
        }

        if distance <= Self.phoneProximityAlertThresholdMeters {
            guard !phoneNearReadingLatched else { return }
            phoneNearReadingLatched = true
            let formattedDistance = String(format: "%.1f", distance)
                .replacingOccurrences(of: ".", with: ",")
            let message = "LiDAR đo bề mặt tại tâm khung hình ở khoảng \(formattedDistance) mét. Đây là số đo ước tính."
            phoneProximityAlertStatus = "Cảnh báo LiDAR: \(message)"
            announcePhoneProximityAlert(message)
            return
        }

        if distance >= Self.phoneProximityResetThresholdMeters {
            phoneNearReadingLatched = false
            phoneProximityAlertStatus = "Đang chờ số đo ở tâm dưới 0,8 mét."
        } else if !phoneNearReadingLatched {
            let formattedDistance = String(format: "%.1f", distance)
                .replacingOccurrences(of: ".", with: ",")
            phoneProximityAlertStatus = "LiDAR tại tâm: \(formattedDistance) mét; cảnh báo dưới 0,8 mét."
        }
    }

    private func announcePhoneProximityAlert(_ message: String) {
        speechError = nil
        if UIAccessibility.isVoiceOverRunning {
            stopSpeakingAnswer()
            UIAccessibility.post(notification: .announcement, argument: message)
        } else {
            speakOnPhone(message, isAnswer: false, isProximityAlert: true)
        }
    }

    func updateCameraStatus(_ value: String) {
        guard phoneModeActive else { return }
        status = value
    }

    func startPhoneMode() {
        stopSpeakingAnswer()
        phoneModeGeneration += 1
        phoneDetectionGeneration += 1
        phoneAskGeneration += 1
        phoneModeActive = true
        detectionEnabled = false
        isDetecting = false
        isAsking = false
        latestJPEG = nil
        latestJPEGAt = nil
        phoneDepthUpdatedAt = nil
        phoneFrameFresh = false
        phoneDetectionsCapturedAt = nil
        phoneDetectionsFresh = false
        centerDistance = nil
        phoneSceneDepthSupported = nil
        phoneNearReadingLatched = false
        phoneProximityAlertStatus = "Chưa có số đo LiDAR mới."
        detections = []
        answer = ""
        status = "Đang khởi động camera LiDAR…"
        Task { await refreshVisionCapabilitiesIfNeeded(force: true) }
    }

    func stopPhoneMode() {
        stopSpeakingAnswer()
        phoneModeGeneration += 1
        phoneDetectionGeneration += 1
        phoneAskGeneration += 1
        phoneModeActive = false
        isAsking = false
        isDetecting = false
        detectionEnabled = false
        latestJPEG = nil
        latestJPEGAt = nil
        phoneDepthUpdatedAt = nil
        phoneFrameFresh = false
        phoneDetectionsCapturedAt = nil
        phoneDetectionsFresh = false
        centerDistance = nil
        phoneSceneDepthSupported = nil
        phoneNearReadingLatched = false
        phoneProximityAlertStatus = "Chưa có số đo LiDAR mới."
        detections = []
        answer = ""
    }

    func speakAnswer(_ text: String) {
        speakOnPhone(text, isAnswer: true, isProximityAlert: false)
    }

    var phoneDetectorStatusMessage: String {
        switch phoneDetectorReady {
        case true:
            let model = phoneDetectorModel.map { " (\($0))" } ?? ""
            return "YOLO\(model) chạy trên Flask cho prototype camera iPhone; đây không phải model ESP32. FOMO cục bộ ESP32 vẫn chờ artifact đã huấn luyện."
        case false:
            return "YOLO server trên Flask chưa sẵn sàng cho prototype camera iPhone. FOMO cục bộ ESP32 vẫn chờ artifact đã huấn luyện."
        case nil:
            return "Chưa xác minh YOLO server cho prototype camera iPhone. FOMO cục bộ ESP32 vẫn chờ artifact đã huấn luyện."
        }
    }

    private func speakOnPhone(_ text: String, isAnswer: Bool, isProximityAlert: Bool) {
        stopSpeakingAnswer()
        let cleanedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedText.isEmpty else { return }

        speechError = nil
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try audioSession.setActive(true)
            speechSessionActive = true
        } catch {
            speechError = "Không mở được âm thanh trên iPhone. Kiểm tra âm lượng hoặc thiết bị phát rồi thử lại."
            if isProximityAlert {
                phoneProximityAlertStatus = "Không phát được cảnh báo qua loa iPhone. Thử kiểm tra âm lượng hoặc bật lại cảnh báo."
            }
            deactivateSpeechSession()
            return
        }

        let utterance = AVSpeechUtterance(string: cleanedText)
        utterance.voice = AVSpeechSynthesisVoice(language: "vi-VN")
        activeSpeechUtteranceID = ObjectIdentifier(utterance)
        isSpeakingAnswer = isAnswer
        activeSpeechIsProximityAlert = isProximityAlert
        speechSynthesizer.speak(utterance)
    }

    func stopSpeakingAnswer() {
        if activeSpeechUtteranceID != nil {
            speechSynthesizer.stopSpeaking(at: .immediate)
        }
        activeSpeechUtteranceID = nil
        isSpeakingAnswer = false
        activeSpeechIsProximityAlert = false
        deactivateSpeechSession()
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in
            self?.finishSpeech(utteranceID: utteranceID)
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in
            self?.finishSpeech(utteranceID: utteranceID)
        }
    }

    private func finishSpeech(utteranceID: ObjectIdentifier) {
        guard activeSpeechUtteranceID == utteranceID else { return }
        activeSpeechUtteranceID = nil
        isSpeakingAnswer = false
        activeSpeechIsProximityAlert = false
        deactivateSpeechSession()
    }

    private func deactivateSpeechSession() {
        guard speechSessionActive else { return }
        speechSessionActive = false
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    func setPhoneDetectionEnabled(_ enabled: Bool) {
        guard detectionEnabled != enabled else { return }
        phoneDetectionGeneration += 1
        detectionEnabled = enabled
        detections = []
        phoneDetectionsCapturedAt = nil
        phoneDetectionsFresh = false
        status = enabled ? "Đang chờ kết quả YOLO server mới từ Flask…" : "Đã tạm dừng gửi frame iPhone tới YOLO server."
    }

    func clearDevicePreview() {
        deviceFrameData = nil
        deviceFrameSequence = nil
        deviceDetections = []
        deviceZones = []
    }

    func refreshDeviceFreshness() {
        let cameraReady = deviceCameraReady
        if lastDeviceCameraReady != cameraReady {
            lastDeviceCameraReady = cameraReady
            deviceFreshnessRevision &+= 1
        }
        guard deviceConnection != nil else { return }
        guard cameraReady,
              deviceFrameData != nil,
              deviceFrameMatchesCurrentStatus else {
            if deviceFrameData != nil || deviceFrameSequence != nil
                || !deviceDetections.isEmpty || !deviceZones.isEmpty {
                clearDevicePreview()
            }
            return
        }

        guard let status = deviceStatusSnapshot else { return }
        let detectionsFresh = effectiveDeviceAgeMs(status.resolvedDetectionsAgeMs)
            .map { $0 <= Self.deviceFrameFreshnessMs } ?? false
        if !detectionsFresh, !deviceDetections.isEmpty { deviceDetections = [] }
        let tofFresh = effectiveDeviceAgeMs(status.tofAgeMs)
            .map { $0 <= Self.deviceFrameFreshnessMs } ?? false
        if !tofFresh, !deviceZones.isEmpty { deviceZones = [] }
    }

    func cancelDeviceAsk() {
        deviceAskGeneration += 1
        isDeviceAsking = false
    }

    func cancelDeviceSpeech() {
        deviceSpeechGeneration += 1
        guard isSendingDeviceSpeech else { return }
        isSendingDeviceSpeech = false
        deviceSpeakerMessage = "Đã hủy tác vụ gửi audio khi rời mode ESP32; firmware có thể phát hết PCM đã nhận."
    }

    func sendDeviceControl(command: String, volume: Int? = nil, alertsEnabled: Bool? = nil) async {
        guard !isSendingDeviceControl else { return }
        guard deviceCanControl else {
            deviceControlError = "Điều khiển cần kết nối firmware Wi-Fi trực tiếp; USB bridge chỉ đọc."
            return
        }

        var body: [String: Any] = ["command": command]
        let requestedDescription: String
        switch command {
        case "set_volume":
            guard let volume, (0...100).contains(volume) else {
                deviceControlError = "Âm lượng phải từ 0 đến 100 phần trăm."
                return
            }
            body["value"] = volume
            requestedDescription = "mức âm lượng \(volume)%"
        case "set_alerts":
            guard let alertsEnabled else {
                deviceControlError = "Chọn bật hoặc tắt cảnh báo trước khi gửi."
                return
            }
            body["enabled"] = alertsEnabled
            requestedDescription = "cài đặt \(alertsEnabled ? "bật" : "tắt") cảnh báo"
        default:
            deviceControlError = "Firmware hiện chưa hỗ trợ lệnh điều khiển này."
            return
        }

        isSendingDeviceControl = true
        deviceControlMessage = nil
        deviceControlError = nil
        defer { isSendingDeviceControl = false }
        do {
            let request = try makeRequest(
                endpoint: "device/command",
                method: "POST",
                jsonBody: body
            )
            let (data, response) = try await performAuthenticatedRequest(request)
            let payload = try Self.decode(DeviceControlResponse.self, data: data, response: response)
            guard payload.command == command,
                  payload.ack?.type == "command_ack",
                  payload.ack?.command == command,
                  payload.ack?.ok == true else {
                throw APIError.message("Firmware chưa ACK đúng lệnh điều khiển.")
            }
            let standbyNote = payload.operationEnabled == false
                ? " Thiết bị vẫn tạm dừng; lệnh này không bật MODE."
                : ""
            deviceControlMessage = "Firmware đã ACK \(requestedDescription). ACK không xác nhận loa hoặc cảnh báo đã hoạt động.\(standbyNote)"
        } catch {
            guard !Task.isCancelled else { return }
            deviceControlError = userFacingErrorMessage(error, fallback: "Không gửi được lệnh tới ESP32. Kiểm tra kết nối Wi-Fi rồi thử lại.")
        }
    }

    var deviceStatusSnapshot: DeviceStatusPayload? {
        deviceConnection?.status
    }

    var deviceFomoOutputForCurrentFrame: Bool {
        guard deviceConnection?.transport == "firmware_wifi",
              deviceConnection?.deviceConnected == true,
              deviceOperationEnabled == true,
              let status = deviceStatusSnapshot,
              status.source == "device",
              status.detectorModel?.lowercased().hasPrefix("fomo:") == true,
              status.inferenceStatus == "ok",
              let frameSequence = deviceFrameSequence,
              status.resolvedDetectionsFrameSeq == frameSequence,
              effectiveDeviceAgeMs(status.resolvedDetectionsAgeMs)
                .map({ $0 <= Self.deviceFrameFreshnessMs }) == true,
              let bootID = status.deviceHealth?.bootId,
              status.detectionsBootId == bootID else {
            return false
        }
        return true
    }

    var deviceFomoStatusMessage: String {
        guard deviceConnection?.transport == "firmware_wifi" else {
            return "ESP32 FOMO đang chờ artifact đã huấn luyện và output từ firmware qua Wi-Fi. BLE chỉ mang status, ToF và nút; USB bridge không xác nhận FOMO."
        }
        guard let status = deviceStatusSnapshot,
              status.source == "device" else {
            return "Đang chờ snapshot firmware có trạng thái FOMO."
        }
        let modelID = status.detectorModel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard modelID.lowercased().hasPrefix("fomo:") else {
            return "ESP32-local FOMO đang chờ artifact đã huấn luyện; detector firmware hiện chưa báo model FOMO."
        }
        guard status.inferenceStatus == "ok" else {
            return "Firmware có khai báo model FOMO nhưng chưa báo inference thành công. App chưa hiển thị kết quả."
        }
        guard deviceFomoOutputForCurrentFrame else {
            return "Đang chờ output FOMO mới cùng boot và frame JPEG hiện tại; output cũ hoặc không khớp bị ẩn."
        }
        if deviceDetections.isEmpty {
            return "Firmware FOMO đã xử lý frame \(deviceFrameSequence ?? 0); chưa phát hiện vật thể trong frame này."
        }
        return "FOMO ESP32 · frame \(deviceFrameSequence ?? 0) · model \(modelID)."
    }

    var deviceOperationEnabled: Bool? {
        deviceStatusSnapshot?.resolvedOperationEnabled
    }

    var deviceCanControl: Bool {
        deviceConnection?.transport == "firmware_wifi"
            && deviceConnection?.deviceConnected == true
            && deviceStatusSnapshot?.source == "device"
            && deviceStatusElapsedMs.map { $0 <= Self.deviceSpeakerStatusFreshnessMs } == true
    }

    var deviceControlUnavailableMessage: String {
        guard deviceConnection?.transport == "firmware_wifi" else {
            return "Kết nối firmware Wi-Fi để mở điều khiển; USB bridge chỉ đọc."
        }
        guard deviceConnection?.deviceConnected == true,
              deviceStatusSnapshot?.source == "device" else {
            return "Chưa nhận được trạng thái kết nối ESP32 Wi-Fi mới."
        }
        guard deviceStatusElapsedMs.map({ $0 <= Self.deviceSpeakerStatusFreshnessMs }) == true else {
            return "Đang chờ trạng thái ESP32 mới trước khi mở điều khiển."
        }
        return "Điều khiển chưa sẵn sàng."
    }

    var deviceCorridorDecision: DeviceCorridorDecision? {
        guard deviceConnection?.transport == "firmware_wifi",
              deviceConnection?.deviceConnected == true,
              deviceOperationEnabled == true,
              let status = deviceStatusSnapshot,
              status.source == "device",
              status.cameraInputState == "live",
              let cameraFrame = status.cameraFrame,
              cameraFrame > 0,
              effectiveDeviceAgeMs(status.cameraAgeMs).map({ $0 <= Self.deviceFrameFreshnessMs }) == true,
              effectiveDeviceAgeMs(status.tofAgeMs).map({ $0 <= Self.deviceFrameFreshnessMs }) == true,
              let bootID = status.deviceHealth?.bootId,
              status.tofBootId == bootID,
              let decision = status.corridorDecision,
              decision.origin == "device",
              decision.bootId == bootID,
              decision.frameSeq == cameraFrame,
              decision.risk.map({ ["clear", "caution", "stop", "unknown"].contains($0) }) == true else {
            return nil
        }
        return status.corridorDecision
    }

    var deviceSpeakerReady: Bool {
        deviceConnection?.transport == "firmware_wifi"
            && deviceConnection?.deviceConnected == true
            && deviceStatusSnapshot?.audioOk == true
            && deviceOperationEnabled == true
            && deviceStatusElapsedMs.map { $0 <= Self.deviceSpeakerStatusFreshnessMs } == true
    }

    var deviceSpeakerUnavailableMessage: String {
        guard deviceConnection?.transport == "firmware_wifi" else {
            return "Loa ESP32 cần kết nối Wi-Fi firmware; USB bridge chưa chuyển tiếp audio."
        }
        guard deviceConnection?.deviceConnected == true else {
            return "Chưa kết nối được ESP32 qua firmware Wi-Fi."
        }
        guard let statusAge = deviceStatusElapsedMs,
              statusAge <= Self.deviceSpeakerStatusFreshnessMs else {
            return "Đang chờ trạng thái loa mới từ firmware ESP32."
        }
        if deviceOperationEnabled != true {
            return "ESP32 đang chờ nút MODE; chưa thể phát audio."
        }
        if deviceStatusSnapshot?.audioOk != true {
            return "Loa, mạch khuếch đại, nguồn và GPIO chưa được firmware xác minh; câu trả lời vẫn phát được trên iPhone."
        }
        return "Firmware báo ngõ loa đã khởi tạo; chưa xác nhận âm thanh nghe được."
    }

    var deviceAnswerButtonSourceLabel: String {
        deviceAnswerButtonPressId.map { " · NÚT #\($0)" } ?? ""
    }

    private var deviceStatusElapsedMs: Double? {
        guard let receivedAt = deviceStatusReceivedAtUptime else { return nil }
        return max(0, (ProcessInfo.processInfo.systemUptime - receivedAt) * 1000)
    }

    private func effectiveDeviceAgeMs(_ reportedAgeMs: Double?) -> Double? {
        guard let reportedAgeMs, reportedAgeMs.isFinite, reportedAgeMs >= 0,
              let elapsedMs = deviceStatusElapsedMs else {
            return nil
        }
        return reportedAgeMs + elapsedMs
    }

    var deviceCameraReady: Bool {
        guard let connection = deviceConnection,
              connection.deviceConnected == true,
              let status = connection.status,
              status.source == "device",
              deviceOperationEnabled == true,
              status.cameraInputState == "live",
              let age = effectiveDeviceAgeMs(status.cameraAgeMs),
              age <= Self.deviceFrameFreshnessMs,
              let sequence = status.cameraFrame,
              sequence > 0 else {
            return false
        }
        return true
    }

    var deviceFrameMatchesCurrentStatus: Bool {
        guard let connection = deviceConnection,
              let expectedSequence = connection.status?.cameraFrame,
              let receivedSequence = deviceFrameSequence else {
            return false
        }
        if connection.transport == "firmware_wifi" {
            return receivedSequence >= expectedSequence
        }
        return receivedSequence == expectedSequence
    }

    var deviceCanAsk: Bool {
        deviceCameraReady
            && deviceFrameData != nil
            && deviceFrameMatchesCurrentStatus
            && deviceVisionReady == true
            && !isDeviceAsking
    }

    var deviceStatusMessage: String {
        if let deviceError, !deviceError.isEmpty { return deviceError }
        guard let connection = deviceConnection else {
            return backendBaseURL.isEmpty
                ? "Nhập địa chỉ Flask và tài khoản trong cài đặt để kết nối."
                : "Đang kiểm tra kết nối ESP32…"
        }
        guard connection.deviceConnected == true else {
            switch connection.state {
            case "bridge_offline": return connection.error ?? "Chưa kết nối bridge USB."
            case "firmware_offline": return connection.error ?? "Chưa kết nối được firmware ESP32."
            case "device_stale": return "Đã thấy ESP32 nhưng dữ liệu kết nối đã cũ."
            case "no_device": return "Backend sẵn sàng nhưng chưa nhận được ESP32."
            default: return connection.error ?? "Chưa có ESP32 kết nối."
            }
        }
        guard let status = connection.status else {
            return "Backend chưa trả trạng thái camera ESP32."
        }
        if deviceOperationEnabled == false {
            let health = status.deviceHealth
            if health?.modeButtonConfigured == false || health?.buttonInputsConfigured == false {
                let profile = health?.pinProfile
                let inputReason = health?.modeButtonConfigured == false
                    ? "GPIO nút MODE chưa được cấu hình"
                    : "GPIO nút vào chưa được cấu hình"
                var details: [String] = []
                if let id = profile?.id, !id.isEmpty { details.append("profile \(id)") }
                if let camera = profile?.cameraMapStatus { details.append("camera map \(camera)") }
                if let external = profile?.externalMapStatus { details.append("external map \(external)") }
                let profileDescription = details.isEmpty ? "" : " (\(details.joined(separator: "; ")))."
                return "ESP32 giữ standby sau reset vì \(inputReason).\(profileDescription) App không có lệnh bật từ xa; status/mạng vẫn dùng được, còn capture, inference, ToF, cảnh báo và Vision bị khóa."
            }
            if health?.modeButtonConfigured == true {
                return "ESP32 đang tạm dừng. Có thể bật bằng nút MODE vật lý đã cấu hình; app không có lệnh bật từ xa."
            }
            return "ESP32 đang tạm dừng. Chưa xác nhận GPIO nút MODE và app không có lệnh bật từ xa; status/mạng vẫn dùng được."
        }
        guard deviceOperationEnabled == true else {
            return "Đang chờ ESP32 xác nhận trạng thái hoạt động."
        }
        guard status.cameraInputState == "live" else {
            return status.cameraError ?? "Camera ESP32 chưa sẵn sàng."
        }
        guard let age = effectiveDeviceAgeMs(status.cameraAgeMs),
              age <= Self.deviceFrameFreshnessMs else {
            return "Đang chờ một khung hình ESP32 mới, còn hạn."
        }
        guard deviceFrameData != nil, deviceFrameMatchesCurrentStatus else {
            return "Đang lấy JPEG mới từ ESP32…"
        }
        return "ESP32 đang hoạt động · JPEG \(deviceFrameSequence ?? 0)."
    }

    func receiveBLEButtonEvent(_ event: BLEButtonEvent) {
        guard event.schemaVersion == "1.0",
              event.type == "button_event",
              event.action == "pressed",
              ["mode", "capture_image", "ask_llm"].contains(event.buttonId),
              !event.deviceId.isEmpty, !event.bootId.isEmpty,
              event.pressId > 0,
              event.ageMs <= 10_000 else {
            return
        }
        let key = deviceButtonEventKey(
            deviceID: event.deviceId,
            bootID: event.bootId,
            pressID: Int(event.pressId)
        )
        guard !handledDeviceButtonEventKeys.contains(key),
              !pendingBLEButtonEvents.contains(where: { $0.event.id == event.id }) else {
            return
        }

        pendingBLEButtonEvents.append(PendingBLEButtonEvent(
            event: event,
            receivedAtUptime: ProcessInfo.processInfo.systemUptime
        ))
        if pendingBLEButtonEvents.count > 64 {
            pendingBLEButtonEvents.removeFirst(pendingBLEButtonEvents.count - 64)
        }
        switch event.buttonId {
        case "mode":
            deviceButtonMessage = event.operationEnabled
                ? "Nhận nút MODE qua Bluetooth; status báo ESP32 đang hoạt động."
                : "Nhận nút MODE qua Bluetooth; status báo ESP32 đang tạm dừng."
        case "capture_image":
            deviceButtonMessage = "Nhận nút chụp qua Bluetooth; cần backend Wi-Fi để lấy JPEG."
        default:
            deviceButtonMessage = "Nhận nút hỏi AI qua Bluetooth; cần backend Wi-Fi để lấy frame mới."
        }
    }

    func lastHandledBLEPressID(deviceID: String, bootID: String) -> UInt32? {
        let prefix = "\(deviceID.utf8.count):\(deviceID):\(bootID.utf8.count):\(bootID):"
        let pressIDs = handledDeviceButtonEventOrder
            .filter { $0.hasPrefix(prefix) }
            .compactMap { UInt32(String($0.dropFirst(prefix.count))) }
        guard var newest = pressIDs.first else { return nil }
        for pressID in pressIDs.dropFirst() {
            let delta = pressID &- newest
            if delta > 0 && delta < 0x8000_0000 {
                newest = pressID
            }
        }
        return newest
    }

    private func deviceButtonEventKey(deviceID: String, bootID: String, pressID: Int) -> String {
        "\(deviceID.utf8.count):\(deviceID):\(bootID.utf8.count):\(bootID):\(pressID)"
    }

    @discardableResult
    private func markDeviceButtonEventHandled(deviceID: String, bootID: String, pressID: Int) -> Bool {
        let eventKey = deviceButtonEventKey(deviceID: deviceID, bootID: bootID, pressID: pressID)
        guard handledDeviceButtonEventKeys.insert(eventKey).inserted else { return false }
        handledDeviceButtonEventOrder.append(eventKey)
        if handledDeviceButtonEventOrder.count > Self.maximumHandledDeviceButtonEvents {
            let expiredCount = handledDeviceButtonEventOrder.count - Self.maximumHandledDeviceButtonEvents
            handledDeviceButtonEventOrder.removeFirst(expiredCount)
            handledDeviceButtonEventKeys = Set(handledDeviceButtonEventOrder)
        }
        UserDefaults.standard.set(handledDeviceButtonEventOrder, forKey: Self.handledDeviceButtonEventsDefaultsKey)
        return true
    }

    private func acceptDeviceButtonEvent(
        from connection: DeviceConnectionPayload,
        sessionGeneration: Int
    ) -> PendingDeviceButtonAction? {
        guard sessionGeneration == authenticationGeneration,
              connection.deviceConnected == true,
              let status = connection.status,
              status.source == "device",
              let health = status.deviceHealth,
              let receivedAt = deviceStatusReceivedAtUptime else {
            return nil
        }

        let now = ProcessInfo.processInfo.systemUptime
        pendingBLEButtonEvents.removeAll {
            now - $0.receivedAtUptime + Double($0.event.ageMs) / 1000 > 10
        }
        let deviceID = health.deviceId ?? ""
        let bootID = health.bootId ?? ""
        let mismatchedBLEEvents = pendingBLEButtonEvents.filter {
            $0.event.deviceId != deviceID || $0.event.bootId != bootID
        }
        if !mismatchedBLEEvents.isEmpty {
            pendingBLEButtonEvents.removeAll {
                $0.event.deviceId != deviceID || $0.event.bootId != bootID
            }
            deviceButtonMessage = "Bỏ qua nút BLE vì device/boot không khớp ESP32 của backend Wi-Fi."
        }

        var candidates: [(event: DeviceButtonEventPayload, ageMs: Int)] = []
        if let records = status.buttonEvents, !records.isEmpty {
            candidates.append(contentsOf: records.map { ($0.event, $0.ageMs) })
        } else if let event = status.buttonEvent, let eventAge = status.buttonEventAgeMs {
            candidates.append((event, eventAge))
        }
        candidates.append(contentsOf: pendingBLEButtonEvents.map { pending in
            let elapsed = max(0, now - pending.receivedAtUptime) * 1000
            return (pending.event.devicePayload, Int(Double(pending.event.ageMs) + elapsed))
        })
        candidates.sort { first, second in
            let firstMatches = first.event.deviceId == deviceID && first.event.bootId == bootID
            let secondMatches = second.event.deviceId == deviceID && second.event.bootId == bootID
            if firstMatches != secondMatches { return firstMatches }
            if firstMatches,
               let firstPress = first.event.pressId,
               let secondPress = second.event.pressId,
               firstPress > 0,
               firstPress <= Int(UInt32.max),
               secondPress > 0,
               secondPress <= Int(UInt32.max) {
                let firstPressID = UInt32(firstPress)
                let secondPressID = UInt32(secondPress)
                let secondAfterFirst = secondPressID &- firstPressID
                if secondAfterFirst > 0 && secondAfterFirst < 0x8000_0000 {
                    return true
                }
                let firstAfterSecond = firstPressID &- secondPressID
                if firstAfterSecond > 0 && firstAfterSecond < 0x8000_0000 {
                    return false
                }
            }
            return first.ageMs > second.ageMs
        }

        for candidate in candidates {
            let isBLEEvent = pendingBLEButtonEvents.contains(where: {
                $0.event.devicePayload.pressId == candidate.event.pressId
                    && $0.event.devicePayload.deviceId == candidate.event.deviceId
                    && $0.event.devicePayload.bootId == candidate.event.bootId
            })
            let action = acceptDeviceButtonEvent(
                candidate.event,
                ageMs: candidate.ageMs,
                status: status,
                health: health,
                sessionGeneration: sessionGeneration,
                receivedAt: receivedAt
            )
            if isBLEEvent {
                pendingBLEButtonEvents.removeAll {
                    $0.event.devicePayload.pressId == candidate.event.pressId
                        && $0.event.devicePayload.deviceId == candidate.event.deviceId
                        && $0.event.devicePayload.bootId == candidate.event.bootId
                }
            }
            if let action { return action }
        }
        return nil
    }

    private func acceptDeviceButtonEvent(
        _ event: DeviceButtonEventPayload,
        ageMs eventAge: Int,
        status: DeviceStatusPayload,
        health: DeviceHealthPayload,
        sessionGeneration: Int,
        receivedAt: TimeInterval
    ) -> PendingDeviceButtonAction? {
        guard sessionGeneration == authenticationGeneration,
              let deviceID = health.deviceId, !deviceID.isEmpty,
              let bootID = health.bootId, !bootID.isEmpty,
              event.type == "button_event",
              event.deviceId == deviceID,
              event.bootId == bootID,
              event.action == "pressed",
              let buttonID = event.buttonId,
              ["mode", "capture_image", "ask_llm"].contains(buttonID),
              let pressID = event.pressId,
              pressID > 0, pressID <= Int(UInt32.max),
              let pressedAt = event.pressedAtMs, pressedAt >= 0,
              let eventTime = event.tMs, eventTime >= 0,
              let operationEnabled = event.operationEnabled,
              (0...10_000).contains(eventAge) else {
            return nil
        }

        guard markDeviceButtonEventHandled(deviceID: deviceID, bootID: bootID, pressID: pressID) else { return nil }
        deviceCaptureError = nil
        deviceAskError = nil

        if buttonID == "mode" {
            deviceButtonMessage = operationEnabled
                ? "Nút MODE: ESP32 đã bật."
                : "Nút MODE: ESP32 đang tạm dừng."
            if !operationEnabled {
                cancelDeviceAsk()
                clearDevicePreview()
            }
            return nil
        }

        guard operationEnabled, status.resolvedOperationEnabled == true else {
            deviceButtonMessage = "ESP32 đang tạm dừng; thao tác từ nút chưa được chạy."
            if buttonID == "capture_image" {
                deviceCaptureError = deviceButtonMessage
            } else {
                deviceAskError = deviceButtonMessage
            }
            return nil
        }

        deviceButtonMessage = buttonID == "capture_image"
            ? "Nút chụp đã được nhận; đang lấy JPEG mới."
            : "Nút hỏi AI đã được nhận; đang kiểm tra ảnh và ToF."
        return PendingDeviceButtonAction(
            event: event,
            deviceID: deviceID,
            bootID: bootID,
            authenticationGeneration: sessionGeneration,
            statusReceivedAtUptime: receivedAt,
            eventAgeMs: Double(eventAge),
            expectedFrameSequence: status.cameraFrame
        )
    }

    private func currentDeviceSessionMatches(_ action: PendingDeviceButtonAction) -> Bool {
        guard action.authenticationGeneration == authenticationGeneration,
              let connection = deviceConnection,
              connection.deviceConnected == true,
              let health = connection.status?.deviceHealth else {
            return false
        }
        return health.deviceId == action.deviceID && health.bootId == action.bootID
    }

    private func isCurrentDeviceButtonAction(_ action: PendingDeviceButtonAction) -> Bool {
        let elapsedMs = max(0, (ProcessInfo.processInfo.systemUptime - action.statusReceivedAtUptime) * 1000)
        guard action.authenticationGeneration == authenticationGeneration,
              action.eventAgeMs + elapsedMs <= 10_000,
              action.event.operationEnabled == true,
              deviceOperationEnabled == true,
              currentDeviceSessionMatches(action) else {
            return false
        }
        return true
    }

    private func freshDeviceButtonAskContextError(for action: PendingDeviceButtonAction) -> String? {
        guard isCurrentDeviceButtonAction(action) else {
            return "Nút đã hết hạn hoặc ESP32 đã đổi phiên; Vision chưa được gọi."
        }
        guard deviceCameraReady else {
            return "Frame ESP32 đã cũ hoặc chưa sẵn sàng; Vision chưa được gọi."
        }
        guard let connection = deviceConnection,
              let status = connection.status else {
            return "Chưa có trạng thái ESP32 mới để kiểm tra ToF."
        }

        let validToFZone = status.zones?.contains { zone in
            zone.tofValid
                && zone.nearestCm.map { $0.isFinite && $0 > 0 && $0 <= 100_000 } == true
        } ?? false
        let tofRequired = status.tofOk == true || status.deviceHealth?.tofOk == true
        let tofReported = tofRequired || status.tofMode == "device" || validToFZone
        guard tofReported else { return nil }

        guard connection.transport == "firmware_wifi" else {
            return tofRequired
                ? "Bridge chưa cung cấp ToF còn hạn; Vision chưa được gọi."
                : nil
        }
        guard status.tofMode == "device",
              status.tofBootId == action.bootID,
              let age = effectiveDeviceAgeMs(status.tofAgeMs),
              age <= Self.deviceFrameFreshnessMs else {
            return "Số đo ToF đã cũ hoặc không cùng phiên ESP32; Vision chưa được gọi."
        }
        if tofRequired && !validToFZone {
            return "ToF đã được bật nhưng chưa có số đo hợp lệ mới; Vision chưa được gọi."
        }
        if status.tofMode == "device" && !validToFZone {
            return "Không có vùng ToF hợp lệ mới; Vision chưa được gọi."
        }
        return nil
    }

    private func captureDeviceButtonFrame(_ action: PendingDeviceButtonAction) async {
        guard isCurrentDeviceButtonAction(action),
              deviceCameraReady,
              let expectedSequence = action.expectedFrameSequence,
              expectedSequence > 0 else {
            deviceCaptureError = "Frame ESP32 đã cũ hoặc nút không còn thuộc phiên hiện tại; chưa lưu JPEG."
            deviceButtonMessage = "Không chụp được ảnh mới từ nút."
            return
        }

        isCapturingDeviceFrame = true
        deviceCaptureError = nil
        defer { isCapturingDeviceFrame = false }
        do {
            try await fetchDeviceFrame(expectedSequence: expectedSequence)
            guard action.authenticationGeneration == authenticationGeneration,
                  let health = deviceConnection?.status?.deviceHealth,
                  health.deviceId == action.deviceID,
                  health.bootId == action.bootID,
                  let data = deviceFrameData,
                  let sequence = deviceFrameSequence else {
                throw APIError.message("Phiên ESP32 đã đổi trước khi lưu ảnh.")
            }
            deviceCapturedFrameData = data
            deviceCapturedFrameSequence = sequence
            deviceCapturedFramePressId = action.event.pressId
            deviceButtonMessage = "Đã lưu JPEG mới từ nút chụp · khung \(sequence)."
        } catch {
            if action.authenticationGeneration == authenticationGeneration {
                deviceCaptureError = userFacingErrorMessage(error, fallback: "Không lấy được JPEG mới từ ESP32. Kiểm tra kết nối rồi thử lại.")
                deviceButtonMessage = "Không chụp được ảnh mới từ nút."
            }
        }
    }

    private func askVisionFromDeviceButton(_ action: PendingDeviceButtonAction) async {
        let prompt = "Hãy mô tả ngắn gọn những gì nhìn thấy trước camera và nêu vật thể chính hoặc chướng ngại vật rõ ràng. Chỉ nêu khoảng cách khi có số đo ToF hợp lệ; không suy đoán lối đi an toàn."
        await submitDeviceQuestion(
            question: prompt,
            trigger: "button_event",
            sessionGeneration: action.authenticationGeneration,
            buttonAction: action
        )
    }

    func refreshDeviceStatus() async {
        guard !isRefreshingDevice else { return }
        guard !backendBaseURL.isEmpty else {
            deviceError = "Nhập địa chỉ Flask trong cài đặt trước."
            deviceStatusReceivedAtUptime = nil
            deviceConnection = nil
            clearDevicePreview()
            return
        }

        let generation = authenticationGeneration
        var buttonAction: PendingDeviceButtonAction?
        isRefreshingDevice = true
        defer { isRefreshingDevice = false }

        do {
            let request = try makeRequest(endpoint: "device/status")
            let (data, response) = try await performAuthenticatedRequest(request)
            guard generation == authenticationGeneration else { return }
            let connection = try Self.decode(DeviceConnectionPayload.self, data: data, response: response)
            guard !Task.isCancelled else { return }
            deviceStatusReceivedAtUptime = ProcessInfo.processInfo.systemUptime
            deviceConnection = connection
            deviceError = nil
            buttonAction = acceptDeviceButtonEvent(from: connection, sessionGeneration: generation)
        } catch {
            guard !Task.isCancelled, generation == authenticationGeneration else { return }
            deviceStatusReceivedAtUptime = nil
            deviceConnection = nil
            deviceError = userFacingErrorMessage(error, fallback: "Không kết nối được máy chủ app hoặc ESP32. Kiểm tra Wi-Fi/Flask rồi thử lại.")
            clearDevicePreview()
            return
        }

        let isCaptureButtonAction = buttonAction?.event.buttonId == "capture_image"
        if isCaptureButtonAction, let buttonAction {
            await captureDeviceButtonFrame(buttonAction)
        }

        await refreshVisionCapabilitiesIfNeeded()
        guard !Task.isCancelled, generation == authenticationGeneration else { return }
        guard deviceCameraReady,
              let expectedSequence = deviceConnection?.status?.cameraFrame else {
            clearDevicePreview()
            if buttonAction?.event.buttonId == "ask_llm" {
                deviceAskError = "Frame ESP32 đã cũ hoặc chưa sẵn sàng; Vision chưa được gọi."
                deviceButtonMessage = "Nút hỏi AI đã được xử lý nhưng frame chưa sẵn sàng."
            }
            return
        }

        if isCaptureButtonAction {
            updateDeviceContext(for: deviceFrameSequence)
            return
        }

        if deviceFrameData != nil, deviceFrameMatchesCurrentStatus {
            updateDeviceContext(for: deviceFrameSequence)
            if let buttonAction, buttonAction.event.buttonId == "ask_llm" {
                Task { await self.askVisionFromDeviceButton(buttonAction) }
            }
            return
        }

        clearDevicePreview()
        do {
            try await fetchDeviceFrame(expectedSequence: expectedSequence)
            guard generation == authenticationGeneration else { return }
            deviceError = nil
            if let buttonAction, buttonAction.event.buttonId == "ask_llm" {
                Task { await self.askVisionFromDeviceButton(buttonAction) }
            }
        } catch {
            guard !Task.isCancelled else { return }
            clearDevicePreview()
            deviceError = userFacingErrorMessage(error, fallback: "Không lấy được JPEG mới từ ESP32. Kiểm tra Wi-Fi/Flask rồi thử lại.")
            if buttonAction?.event.buttonId == "ask_llm" {
                deviceAskError = "Chưa có JPEG mới khớp frame ESP32; Vision chưa được gọi."
                deviceButtonMessage = "Nút hỏi AI đã được xử lý nhưng JPEG chưa sẵn sàng."
            }
        }
    }

    func askAboutDevice(question: String) async {
        await submitDeviceQuestion(
            question: question,
            trigger: "manual",
            sessionGeneration: authenticationGeneration,
            buttonAction: nil
        )
    }

    func sendAnswerToDeviceSpeaker(_ text: String) async {
        let cleanedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedText.isEmpty else { return }
        guard !isSendingDeviceSpeech else { return }
        guard deviceSpeakerReady else {
            deviceSpeakerMessage = deviceSpeakerUnavailableMessage
            return
        }

        let generation = authenticationGeneration
        let speechGeneration = deviceSpeechGeneration
        let requestId = UUID().uuidString.lowercased()
        stopSpeakingAnswer()
        isSendingDeviceSpeech = true
        deviceSpeakerMessage = "Đang tạo giọng đọc tiếng Việt trên iPhone…"
        defer {
            if speechGeneration == deviceSpeechGeneration {
                isSendingDeviceSpeech = false
            }
        }

        do {
            let pcm = try await SpeechPCMExporter.makePCM16LE(text: cleanedText)
            guard generation == authenticationGeneration,
                  speechGeneration == deviceSpeechGeneration,
                  !Task.isCancelled else { return }
            guard deviceSpeakerReady else {
                throw APIError.message(deviceSpeakerUnavailableMessage)
            }
            guard !pcm.isEmpty, pcm.count.isMultiple(of: 2),
                  pcm.count <= SpeechPCMExporter.maximumBytes else {
                throw APIError.message("Audio tạo ra không đúng PCM16LE hoặc vượt giới hạn 8 giây.")
            }

            var request = try makeRequest(
                endpoint: "device/speaker",
                method: "POST",
                timeoutInterval: 22
            )
            request.setValue("application/vnd.ro-assistive.pcm16le",
                             forHTTPHeaderField: "Content-Type")
            request.setValue("16000", forHTTPHeaderField: "X-Audio-Sample-Rate")
            request.setValue("1", forHTTPHeaderField: "X-Audio-Channels")
            request.setValue(requestId, forHTTPHeaderField: "X-Audio-Request-Id")
            request.httpBody = pcm

            deviceSpeakerMessage = "Đang truyền audio tới ESP32…"
            let (data, response) = try await performAuthenticatedRequest(request)
            guard generation == authenticationGeneration,
                  speechGeneration == deviceSpeechGeneration,
                  !Task.isCancelled else { return }
            let result = try Self.decode(DeviceSpeakerResult.self,
                                         data: data,
                                         response: response)
            guard result.schemaVersion == "2.0",
                  result.requestId == requestId,
                  result.state == "completed",
                  result.bytesPlayed == pcm.count else {
                throw APIError.message("Firmware chưa xác nhận phát đầy đủ câu trả lời; app sẽ không tự gửi lại.")
            }
            deviceSpeakerMessage = "Firmware đã gửi đủ PCM tới I²S; chưa xác nhận âm thanh nghe được."
        } catch {
            guard generation == authenticationGeneration,
                  speechGeneration == deviceSpeechGeneration,
                  !Task.isCancelled else { return }
            deviceSpeakerMessage = userFacingErrorMessage(error, fallback: "Chưa gửi được audio tới loa ESP32. Kiểm tra kết nối Wi-Fi rồi thử lại.")
        }
    }

    private func submitDeviceQuestion(
        question: String,
        trigger: String,
        sessionGeneration: Int,
        buttonAction: PendingDeviceButtonAction?
    ) async {
        guard sessionGeneration == authenticationGeneration else { return }
        let cleanedQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedQuestion.isEmpty else {
            deviceAskError = "Nhập câu hỏi về camera ESP32 trước."
            return
        }
        if let buttonAction,
           let contextError = freshDeviceButtonAskContextError(for: buttonAction) {
            deviceAskError = contextError
            deviceButtonMessage = "Nút hỏi AI đã được xử lý; dữ liệu thiết bị chưa đủ mới."
            return
        }
        guard deviceVisionReady == true else {
            deviceAskError = "Vision chưa sẵn sàng trên máy chủ."
            return
        }
        guard deviceCanAsk else {
            deviceAskError = "Chỉ có thể hỏi khi ESP32 đang hoạt động và có JPEG mới."
            return
        }

        isDeviceAsking = true
        stopSpeakingAnswer()
        deviceAskGeneration += 1
        let askGeneration = deviceAskGeneration
        let generation = authenticationGeneration
        deviceAskError = nil
        deviceAnswer = ""
        deviceAnswerFrameSequence = nil
        deviceAnswerButtonPressId = buttonAction?.event.pressId
        if buttonAction != nil {
            deviceButtonMessage = "Đã gửi một yêu cầu Vision cho nút hỏi AI."
        }
        defer { if askGeneration == deviceAskGeneration { isDeviceAsking = false } }

        do {
            let request = try makeRequest(
                endpoint: "device/ask",
                method: "POST",
                timeoutInterval: 210,
                jsonBody: ["question": cleanedQuestion, "trigger": trigger]
            )
            let (data, response) = try await performAuthenticatedRequest(request)
            guard generation == authenticationGeneration,
                  askGeneration == deviceAskGeneration,
                  buttonAction.map({ currentDeviceSessionMatches($0) }) ?? true,
                  !Task.isCancelled else { return }
            let payload = try Self.decode(DeviceAskPayload.self, data: data, response: response)
            guard let answer = payload.answer, !answer.isEmpty, payload.visionUsed == true else {
                throw APIError.message(payload.error ?? "Vision chưa trả lời được về khung hình ESP32.")
            }
            deviceAnswer = answer
            deviceAnswerFrameSequence = payload.frameSeq
            if buttonAction != nil {
                deviceButtonMessage = "Đã nhận câu trả lời cho nút hỏi AI."
            }
        } catch {
            if generation == authenticationGeneration,
               askGeneration == deviceAskGeneration, !Task.isCancelled {
                deviceAskError = userFacingErrorMessage(error, fallback: "Chưa gửi được câu hỏi tới Vision. Kiểm tra Wi-Fi và trạng thái Vision rồi thử lại.")
                if buttonAction != nil {
                    deviceButtonMessage = "Yêu cầu Vision cho nút hỏi AI đã kết thúc."
                }
            }
        }
    }

    func receiveFrame(_ jpeg: Data, depth: DepthSnapshot?, shouldRunYOLO: Bool) async {
        guard phoneModeActive else { return }
        let modeGeneration = phoneModeGeneration
        let capturedAt = Date()
        latestJPEG = jpeg
        latestJPEGAt = capturedAt
        phoneFrameFresh = true
        guard shouldRunYOLO, detectionEnabled, !isDetecting else { return }
        guard !backendBaseURL.isEmpty else {
            status = "Cần Flask để chạy YOLO server cho prototype camera iPhone."
            detectionEnabled = false
            detections = []
            phoneDetectionsCapturedAt = nil
            phoneDetectionsFresh = false
            return
        }

        isDetecting = true
        let detectionGeneration = phoneDetectionGeneration
        defer { if modeGeneration == phoneModeGeneration { isDetecting = false } }
        status = "Đang gửi frame iPhone tới YOLO server trên Flask…"
        do {
            let (data, response) = try await sendImage(endpoint: "detect", image: jpeg)
            guard phoneModeActive,
                  modeGeneration == phoneModeGeneration,
                  detectionEnabled,
                  detectionGeneration == phoneDetectionGeneration else { return }
            let payload = try Self.decode(YOLOPayload.self, data: data, response: response)
            detections = payload.detections.prefix(12).map { item in
                FusedDetection(
                    label: item.label,
                    confidence: item.confidence,
                    distanceMeters: depth?.distance(normalizedBox: item.box)
                )
            }
            phoneDetectionsCapturedAt = capturedAt
            let detectionAge = Date().timeIntervalSince(capturedAt)
            phoneDetectionsFresh = detectionAge >= 0 && detectionAge <= Self.phoneDetectionFreshnessSeconds
            let timing = payload.inferenceMs.map { " · \(Int($0)) ms" } ?? ""
            let depthStatus = depth == nil
                ? "sceneDepth chưa có ở khung này."
                : "khoảng cách sceneDepth là ước tính."
            status = "YOLO server: \(detections.count) vật thể\(timing) · \(depthStatus)"
        } catch {
            if phoneModeActive,
               modeGeneration == phoneModeGeneration,
               detectionGeneration == phoneDetectionGeneration,
               !Task.isCancelled {
                detections = []
                phoneDetectionsCapturedAt = nil
                phoneDetectionsFresh = false
                status = userFacingErrorMessage(error, fallback: "Chưa gửi được frame tới YOLO Flask. Kiểm tra kết nối rồi thử lại.")
            }
        }
    }

    func ask(question: String) async {
        guard phoneModeActive else { return }
        let cleanedQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedQuestion.isEmpty else {
            status = "Nhập câu hỏi về cảnh trước."
            return
        }
        guard let latestJPEG, phoneHasFreshFrame else {
            status = "Đang chờ khung hình camera mới."
            return
        }
        guard !backendBaseURL.isEmpty else {
            status = "Nhập địa chỉ Flask trong phần cài đặt trước."
            return
        }

        stopSpeakingAnswer()
        isAsking = true
        phoneAskGeneration += 1
        let askGeneration = phoneAskGeneration
        let modeGeneration = phoneModeGeneration
        answer = ""
        status = "Đang gửi ảnh và câu hỏi tới Vision LLM…"
        defer { if askGeneration == phoneAskGeneration { isAsking = false } }
        do {
            let (data, response) = try await sendImage(
                endpoint: "analyze",
                image: latestJPEG,
                question: cleanedQuestion,
                timeoutInterval: 210
            )
            guard phoneModeActive,
                  modeGeneration == phoneModeGeneration,
                  askGeneration == phoneAskGeneration,
                  !Task.isCancelled else { return }
            let payload = try Self.decode(AnswerPayload.self, data: data, response: response)
            guard let answer = payload.answer, !answer.isEmpty else {
                throw APIError.message(payload.error ?? "Vision LLM chưa trả lời được.")
            }
            self.answer = answer
            status = payload.visionUsed == true
                ? "Đã nhận câu trả lời từ Vision LLM."
                : payload.visionError ?? "Đây là tóm tắt YOLO; Vision LLM chưa được gọi."
        } catch {
            if phoneModeActive,
               modeGeneration == phoneModeGeneration,
               askGeneration == phoneAskGeneration,
               !Task.isCancelled {
                status = userFacingErrorMessage(error, fallback: "Chưa gửi được ảnh và câu hỏi tới Vision. Kiểm tra kết nối rồi thử lại.")
            }
        }
    }

    private func sendImage(
        endpoint: String,
        image: Data,
        question: String? = nil,
        timeoutInterval: TimeInterval = 45
    ) async throws -> (Data, URLResponse) {
        let url = try makeEndpoint(endpoint)
        let boundary = "RoSight-\(UUID().uuidString)"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeoutInterval
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        applyAccessAuthorization(to: &request)

        var body = Data()
        body.appendUTF8("--\(boundary)\r\n")
        body.appendUTF8("Content-Disposition: form-data; name=\"image\"; filename=\"iphone-frame.jpg\"\r\n")
        body.appendUTF8("Content-Type: image/jpeg\r\n\r\n")
        body.append(image)
        body.appendUTF8("\r\n")
        if let question {
            body.appendUTF8("--\(boundary)\r\n")
            body.appendUTF8("Content-Disposition: form-data; name=\"question\"\r\n\r\n")
            body.appendUTF8(question)
            body.appendUTF8("\r\n")
        }
        body.appendUTF8("--\(boundary)--\r\n")
        request.httpBody = body
        return try await performAuthenticatedRequest(request)
    }

    private func performAuthenticatedRequest(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let generation = authenticationGeneration
        try Task.checkCancellation()
        try await ensureAuthenticated()
        try Task.checkCancellation()
        guard generation == authenticationGeneration else {
            throw APIError.message("Cài đặt backend đã đổi. Thử lại với thông tin mới.")
        }
        var result = try await URLSession.shared.data(for: request)
        try Task.checkCancellation()
        guard generation == authenticationGeneration else {
            throw APIError.message("Cài đặt backend đã đổi. Thử lại với thông tin mới.")
        }
        guard (result.1 as? HTTPURLResponse)?.statusCode == 401 else { return result }

        isAuthenticated = false
        authenticationError = nil
        authenticationRetryAfter = .distantPast
        try await ensureAuthenticated()
        try Task.checkCancellation()
        guard generation == authenticationGeneration else {
            throw APIError.message("Cài đặt backend đã đổi. Thử lại với thông tin mới.")
        }
        result = try await URLSession.shared.data(for: request)
        try Task.checkCancellation()
        guard generation == authenticationGeneration else {
            throw APIError.message("Cài đặt backend đã đổi. Thử lại với thông tin mới.")
        }
        if (result.1 as? HTTPURLResponse)?.statusCode == 401 {
            isAuthenticated = false
            authenticationError = "Phiên đăng nhập bị từ chối. Kiểm tra tài khoản Ro Sight và Basic Auth của tunnel trong cài đặt."
        }
        return result
    }

    private func refreshVisionCapabilitiesIfNeeded(force: Bool = false) async {
        if !force, let lastVisionStatusCheck,
           Date().timeIntervalSince(lastVisionStatusCheck) < 15 {
            return
        }
        lastVisionStatusCheck = Date()
        do {
            let request = try makeRequest(endpoint: "status")
            let (data, response) = try await performAuthenticatedRequest(request)
            let payload = try Self.decode(DeviceCapabilitiesPayload.self, data: data, response: response)
            deviceVisionReady = payload.visionReady
            deviceVisionProvider = payload.visionProvider
            phoneDetectorReady = payload.detectorReady
            phoneDetectorModel = payload.detectorModel
        } catch {
            if !Task.isCancelled {
                deviceVisionReady = nil
                deviceVisionProvider = nil
                phoneDetectorReady = nil
                phoneDetectorModel = nil
            }
        }
    }

    private func fetchDeviceFrame(expectedSequence: Int) async throws {
        guard let connection = deviceConnection else {
            throw APIError.message("Chưa có trạng thái kết nối ESP32.")
        }
        guard var components = URLComponents(url: try makeEndpoint("device/frame"), resolvingAgainstBaseURL: false) else {
            throw APIError.message("Không tạo được địa chỉ ảnh ESP32.")
        }
        components.queryItems = [
            URLQueryItem(name: "frame_seq", value: String(expectedSequence)),
            URLQueryItem(name: "t", value: UUID().uuidString)
        ]
        guard let url = components.url else {
            throw APIError.message("Không tạo được địa chỉ ảnh ESP32.")
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12)
        request.httpMethod = "GET"
        request.setValue("image/jpeg", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        applyAccessAuthorization(to: &request)

        let (data, response) = try await performAuthenticatedRequest(request)
        try Self.validateHTTPResponse(data: data, response: response)
        guard let http = response as? HTTPURLResponse,
              http.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";", maxSplits: 1).first?.lowercased() == "image/jpeg",
              data.count >= 4,
              data.count <= Self.maximumDeviceFrameBytes,
              data[data.startIndex] == 0xff,
              data[data.index(after: data.startIndex)] == 0xd8,
              data[data.index(data.endIndex, offsetBy: -2)] == 0xff,
              data[data.index(before: data.endIndex)] == 0xd9,
              let sequenceHeader = http.value(forHTTPHeaderField: "X-Frame-Seq"),
              let receivedSequence = Int(sequenceHeader),
              receivedSequence > 0 else {
            throw APIError.message("ESP32 chưa trả được JPEG hợp lệ kèm số frame.")
        }
        let validSequence = connection.transport == "firmware_wifi"
            ? receivedSequence >= expectedSequence
            : receivedSequence == expectedSequence
        guard validSequence else {
            throw APIError.message("JPEG ESP32 không khớp số frame mới nhất.")
        }

        deviceFrameData = data
        deviceFrameSequence = receivedSequence
        updateDeviceContext(for: receivedSequence)
    }

    private func updateDeviceContext(for frameSequence: Int?) {
        guard let status = deviceConnection?.status else {
            deviceDetections = []
            deviceZones = []
            return
        }
        let detectionsFresh = effectiveDeviceAgeMs(status.resolvedDetectionsAgeMs).map {
            $0 <= Self.deviceFrameFreshnessMs
        } ?? false
        let detectionsBootMatches = deviceConnection?.transport != "firmware_wifi"
            || status.detectionsBootId == status.deviceHealth?.bootId
        let firmwareFomoOutput = deviceConnection?.transport == "firmware_wifi"
            && status.source == "device"
            && status.detectorModel?.lowercased().hasPrefix("fomo:") == true
            && status.inferenceStatus == "ok"
        if firmwareFomoOutput, detectionsFresh, detectionsBootMatches,
           status.resolvedDetectionsFrameSeq == frameSequence {
            deviceDetections = status.detections ?? []
        } else {
            deviceDetections = []
        }

        let tofFresh = effectiveDeviceAgeMs(status.tofAgeMs).map {
            $0 <= Self.deviceFrameFreshnessMs
        } ?? false
        let tofBootMatches = deviceConnection?.transport != "firmware_wifi"
            || status.tofBootId == status.deviceHealth?.bootId
        if tofFresh, tofBootMatches, status.tofMode == "device" {
            deviceZones = status.zones ?? []
        } else {
            deviceZones = []
        }
    }

    private func ensureAuthenticated() async throws {
        if isAuthenticated { return }
        if let authenticationError {
            throw APIError.message(authenticationError)
        }
        guard Date() >= authenticationRetryAfter else {
            throw APIError.message("Chưa kết nối được backend. Đợi một lát rồi thử lại nhé.")
        }
        if let authenticationTask {
            try await authenticationTask.value
            return
        }
        guard !accountUsername.isEmpty, !accountPassword.isEmpty else {
            throw APIError.message("Nhập tài khoản và mật khẩu Ro Sight trong cài đặt.")
        }

        let generation = authenticationGeneration
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.performLogin()
                guard self.authenticationGeneration == generation else {
                    throw APIError.message("Cài đặt backend đã đổi. Lưu cài đặt rồi thử lại.")
                }
                self.isAuthenticated = true
            } catch {
                if self.authenticationGeneration == generation {
                    if let apiError = error as? APIError,
                       case let .authentication(message) = apiError {
                        self.authenticationError = message
                    } else {
                        self.authenticationRetryAfter = Date().addingTimeInterval(2)
                    }
                }
                throw error
            }
        }
        authenticationTask = task
        defer {
            if authenticationGeneration == generation {
                authenticationTask = nil
            }
        }
        try await task.value
    }

    private func performLogin() async throws {
        let url = try makeEndpoint("auth/login")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        applyAccessAuthorization(to: &request)
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "username": accountUsername,
            "password": accountPassword
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let message = (try? JSONDecoder().decode(APIErrorPayload.self, from: data))?.error
                ?? "Đăng nhập Ro Sight hoặc Basic Auth của tunnel chưa đúng."
            throw APIError.authentication(message)
        }
        try Self.validateHTTPResponse(data: data, response: response)
    }

    private func applyAccessAuthorization(to request: inout URLRequest) {
        guard !accessUsername.isEmpty else { return }
        let credentials = Data("\(accessUsername):\(accessPassword)".utf8).base64EncodedString()
        request.setValue("Basic \(credentials)", forHTTPHeaderField: "Authorization")
    }

    private func makeRequest(
        endpoint: String,
        method: String = "GET",
        timeoutInterval: TimeInterval = 12,
        jsonBody: [String: Any]? = nil
    ) throws -> URLRequest {
        var request = URLRequest(url: try makeEndpoint(endpoint), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeoutInterval)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let jsonBody {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: jsonBody)
        }
        applyAccessAuthorization(to: &request)
        return request
    }

    private func makeEndpoint(_ endpoint: String) throws -> URL {
        guard var components = URLComponents(string: backendBaseURL),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              components.host != nil else {
            throw APIError.message("Địa chỉ backend không hợp lệ.")
        }
        components.query = nil
        components.fragment = nil
        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }
        components.path = "\(path)/api/\(endpoint)"
        guard let url = components.url else {
            throw APIError.message("Không tạo được URL API.")
        }
        return url
    }

    private static func decode<T: Decodable>(
        _ type: T.Type,
        data: Data,
        response: URLResponse
    ) throws -> T {
        let decoder = JSONDecoder()
        try validateHTTPResponse(data: data, response: response)
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw APIError.message("Phản hồi backend không đúng định dạng.")
        }
    }

    private static func validateHTTPResponse(data: Data, response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) else {
            return
        }
        let message = (try? JSONDecoder().decode(APIErrorPayload.self, from: data))?.error
            ?? "Backend trả mã HTTP \(http.statusCode)."
        throw APIError.message(message)
    }
}

private struct YOLOPayload: Decodable {
    let detections: [YOLODetection]
    let inferenceMs: Double?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case detections, error
        case inferenceMs = "inference_ms"
    }
}

private struct YOLODetection: Decodable {
    let label: String
    let confidence: Double
    let box: [Double]
}

private struct AnswerPayload: Decodable {
    let answer: String?
    let error: String?
    let visionUsed: Bool?
    let visionError: String?

    enum CodingKeys: String, CodingKey {
        case answer, error
        case visionUsed = "vision_used"
        case visionError = "vision_error"
    }
}

private struct APIErrorPayload: Decodable {
    let error: String?
}

private enum APIError: LocalizedError {
    case message(String)
    case authentication(String)

    var errorDescription: String? {
        switch self {
        case let .message(message), let .authentication(message): return message
        }
    }
}

private func userFacingErrorMessage(_ error: Error, fallback: String) -> String {
    if let apiError = error as? APIError,
       let message = apiError.errorDescription,
       !message.isEmpty {
        return message
    }

    let urlErrorCode: URLError.Code?
    if let urlError = error as? URLError {
        urlErrorCode = urlError.code
    } else {
        let nsError = error as NSError
        urlErrorCode = nsError.domain == NSURLErrorDomain
            ? URLError.Code(rawValue: nsError.code)
            : nil
    }

    switch urlErrorCode {
    case .some(.timedOut):
        return "Máy chủ trả lời quá lâu. Kiểm tra kết nối rồi thử lại nhé."
    case .some(.notConnectedToInternet), .some(.networkConnectionLost), .some(.cannotFindHost), .some(.cannotConnectToHost), .some(.dnsLookupFailed):
        return "Không kết nối được máy chủ app. Kiểm tra Wi-Fi/Flask rồi thử lại nhé."
    case .some:
        return fallback
    case .none:
        return fallback
    }
}

private extension Data {
    mutating func appendUTF8(_ value: String) {
        append(contentsOf: value.utf8)
    }
}
