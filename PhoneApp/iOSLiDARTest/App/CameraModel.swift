import Foundation
import SwiftUI
import AVFoundation
import Speech
import UIKit

struct FusedDetection: Identifiable {
    let id = UUID()
    let label: String
    let confidence: Double
    let distanceMeters: Double?
    let pathAssessment: DetectionPathAssessment
}

struct PhonePathSummary {
    let title: String
    let detail: String
    let tint: Color
}

enum DetectionPathAssessment {
    case immediateCandidate
    case nearCandidate
    case farContext
    case outsideCorridor
    case unknownDistance

    var title: String {
        switch self {
        case .immediateCandidate: return "Ứng viên vật cản · rất gần"
        case .nearCandidate: return "Ứng viên vật cản · trong tầm"
        case .farContext: return "Ở xa · chỉ tham khảo"
        case .outsideCorridor: return "Ngoài hành lang giữa"
        case .unknownDistance: return "Chưa rõ cự ly"
        }
    }

    var tint: Color {
        switch self {
        case .immediateCandidate: return .red
        case .nearCandidate: return .orange
        case .farContext, .outsideCorridor: return .white.opacity(0.68)
        case .unknownDistance: return .yellow
        }
    }

    var wireValue: String {
        switch self {
        case .immediateCandidate: return "very_near"
        case .nearCandidate: return "near"
        case .farContext: return "far"
        case .outsideCorridor: return "outside_corridor"
        case .unknownDistance: return "unknown_distance"
        }
    }
}

struct FusedHazardZone: Identifiable {
    let zone: String
    let hazardProbability: Double
    let isHazard: Bool
    let depthMeters: Double?

    var id: String { zone }

    var displayName: String {
        switch zone {
        case "left": return "Trái"
        case "center": return "Giữa"
        case "right": return "Phải"
        default: return zone.capitalized
        }
    }
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
final class CameraModel: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published var detectionEnabled = false
    @Published var isDetecting = false
    @Published var isAsking = false
    @Published var centerDistance: Double?
    @Published private(set) var phoneSceneDepthSupported: Bool?
    @Published private(set) var phoneProximityAlertStatus = "Chưa có số đo LiDAR mới."
    @Published var detections: [FusedDetection] = []
    @Published private(set) var phoneHazardZones: [FusedHazardZone] = []
    @Published var answer = ""
    @Published private(set) var isSpeakingAnswer = false
    @Published private(set) var speechError: String?
    @Published private(set) var isVoiceConnecting = false
    @Published private(set) var isVoiceConversationActive = false
    @Published private(set) var isVoiceListening = false
    @Published private(set) var isVoiceThinking = false
    @Published private(set) var voiceTranscript = ""
    @Published private(set) var voiceStatus = "Thoại native chưa bắt đầu."
    @Published var status = "Chọn chế độ camera để bắt đầu."
    @Published private(set) var phoneFrameFresh = false
    @Published private(set) var phoneDetectionsFresh = false
    @Published private(set) var phoneDetectorReady: Bool?
    @Published private(set) var phoneDetectorModel: String?
    @Published private(set) var phoneDetectorProvider: String?
    @Published private(set) var phoneTranscriptionReady: Bool?
    @Published private(set) var phoneTranscriptionModel: String?
    @Published private(set) var phoneVoiceRealtimeReady: Bool?
    @Published private(set) var phoneVoiceRealtimeModel: String?
    @Published private(set) var phoneVoiceRealtimeNote: String?
    @Published private(set) var backendCapabilityCheckMessage: String?
    @Published private(set) var backendCapabilityCheckSucceeded: Bool?
    @Published private(set) var isCheckingBackendCapabilities = false

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
    private var phoneDetectionFrameJPEG: Data?
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
    private let voiceAudioEngine = AVAudioEngine()
    private let vietnameseSpeechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "vi-VN"))
    private var voiceRecognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var voiceRecognitionTask: SFSpeechRecognitionTask?
    private var voiceAudioTapInstalled = false
    private let voiceAudioCapture = VoiceAudioCapture()
    private var lastVoiceCaptureWAV: Data?
    private var voiceDebounceTask: Task<Void, Never>?
    private var voiceResponseTask: Task<Void, Never>?
    private var voiceSessionGeneration = 0
    private var voiceRecognitionGeneration = 0
    private var latestVoiceTranscript = ""
    private var voiceHistory: [[String: String]] = []
    private var voiceSpeechBuffer = ""
    private var voiceSpeechUtteranceIDs: Set<ObjectIdentifier> = []
    private var voiceReplyStreamFinished = false
    private var voiceRealtimeSocket: URLSessionWebSocketTask?
    private var voiceRealtimeSocketWriter: RealtimeVoiceSocketWriter?
    private var voiceRealtimeReceiveTask: Task<Void, Never>?
    private var voiceRealtimeFrameTask: Task<Void, Never>?
    private var voiceRealtimeHandshakeTimeoutTask: Task<Void, Never>?
    private var voiceRealtimePCMEncoder: RealtimeVoicePCMEncoder?
    private var voiceRealtimeSessionReady = false
    private var voiceRealtimeFailedForSession = false
    private let voiceRealtimeSendQueue = DispatchQueue(label: "vn.khiemthi.rosight.voice.websocket")

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
    static let phoneNavigationHorizonMeters = 2.5

    var phonePathSummary: PhonePathSummary? {
        guard phoneDetectionsFresh else { return nil }
        if detections.contains(where: { $0.pathAssessment == .immediateCandidate }) {
            return PhonePathSummary(
                title: "Có vật thể rất gần trong hành lang",
                detail: "Có phát hiện ước tính trong khoảng 0,8 m. Số đo cần được kiểm tra thực tế.",
                tint: .red
            )
        }
        if let item = detections.first(where: { $0.pathAssessment == .nearCandidate }) {
            let distance = item.distanceMeters.map { String(format: "%.1f", $0) } ?? ""
            return PhonePathSummary(
                title: "Có vật thể trong tầm hành lang gần",
                detail: "Ước tính khoảng \(distance) m, trong tầm thử đến 2,5 m. App chưa xác nhận đường an toàn.",
                tint: .orange
            )
        }
        if detections.contains(where: { $0.pathAssessment == .unknownDistance }) {
            return PhonePathSummary(
                title: "Có vật trong vùng đi, chưa rõ khoảng cách",
                detail: "LiDAR chưa có số đo đủ tin cậy; không xem trạng thái này là đường trống.",
                tint: .yellow
            )
        }
        if detections.contains(where: { $0.pathAssessment == .farContext }) {
            return PhonePathSummary(
                title: "Có vật phía xa",
                detail: "Vật ngoài tầm thử 2,5 m chỉ để tham khảo, chưa tính là chặn đoạn đường gần.",
                tint: .white
            )
        }
        return PhonePathSummary(
            title: "Chưa thấy vật trong hành lang gần",
            detail: "Không phát hiện vật cản trong vùng thử đến 2,5 m ở frame này; điều đó chưa chứng minh đường trống.",
            tint: .white
        )
    }

    var phoneCorridorTint: Color {
        guard phoneDetectionsFresh else { return .mint }
        if detections.contains(where: { $0.pathAssessment == .immediateCandidate }) { return .red }
        if detections.contains(where: { $0.pathAssessment == .nearCandidate }) { return .orange }
        if detections.contains(where: { $0.pathAssessment == .unknownDistance }) { return .yellow }
        return .white
    }

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
        if !detectionFresh, !phoneHazardZones.isEmpty { phoneHazardZones = [] }
        if !detectionFresh { phoneDetectionFrameJPEG = nil }
    }

    private func currentPhoneVisionSnapshot() -> (image: Data?, spatialContext: [String: Any]) {
        let now = Date()
        var spatialContext: [String: Any] = [:]
        let centerDepthAgeMs = phoneDepthUpdatedAt.map { now.timeIntervalSince($0) * 1_000 }
        if let centerDepthAgeMs,
           centerDepthAgeMs >= 0,
           centerDepthAgeMs <= Self.phoneDepthFreshnessSeconds * 1_000,
           let centerDistance,
           centerDistance.isFinite {
            spatialContext["center_distance_m"] = centerDistance
            spatialContext["center_depth_age_ms"] = Int(centerDepthAgeMs)
        }

        let detectionAgeMs = phoneDetectionsCapturedAt.map { now.timeIntervalSince($0) * 1_000 }
        let hasFreshDetectionSnapshot = phoneDetectionsFresh
            && detectionAgeMs.map { $0 >= 0 && $0 <= Self.phoneDetectionFreshnessSeconds * 1_000 } == true
            && phoneDetectionFrameJPEG != nil
        let image: Data?
        if hasFreshDetectionSnapshot, let phoneDetectionFrameJPEG, let detectionAgeMs {
            image = phoneDetectionFrameJPEG
            spatialContext["detection_frame_age_ms"] = Int(detectionAgeMs)
            spatialContext["detections"] = detections.prefix(8).map { detection in
                var item: [String: Any] = [
                    "label": detection.label,
                    "confidence": detection.confidence,
                    "path": detection.pathAssessment.wireValue
                ]
                if let distance = detection.distanceMeters, distance.isFinite {
                    item["distance_m"] = distance
                }
                return item
            }
            if !phoneHazardZones.isEmpty {
                spatialContext["zones"] = phoneHazardZones.map { zone in
                    var item: [String: Any] = [
                        "zone": zone.zone,
                        "hazard_probability": zone.hazardProbability,
                        "is_hazard": zone.isHazard
                    ]
                    if let distance = zone.depthMeters, distance.isFinite {
                        item["depth_m"] = distance
                    }
                    return item
                }
            }
        } else if phoneHasFreshFrame {
            image = latestJPEG
        } else {
            image = nil
        }

        let imageAgeMs = hasFreshDetectionSnapshot
            ? detectionAgeMs
            : latestJPEGAt.map { now.timeIntervalSince($0) * 1_000 }
        if let imageAgeMs, imageAgeMs >= 0, imageAgeMs <= Self.phoneFrameFreshnessSeconds * 1_000 {
            spatialContext["camera_frame_age_ms"] = Int(imageAgeMs)
        }
        return (image, spatialContext)
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
            if isVoiceConversationActive || isVoiceConnecting {
                stopVoiceConversation()
            }
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
            phoneDetectorProvider = nil
            phoneTranscriptionReady = nil
            phoneTranscriptionModel = nil
            phoneVoiceRealtimeReady = nil
            phoneVoiceRealtimeModel = nil
            phoneVoiceRealtimeNote = nil
            backendCapabilityCheckMessage = nil
            backendCapabilityCheckSucceeded = nil
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
            status = "Nhập địa chỉ backend để hỏi ảnh hoặc chạy nhận diện camera iPhone."
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
        if isVoiceConversationActive || isVoiceConnecting {
            stopVoiceConversation()
        }
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
        stopVoiceConversation()
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
        phoneDetectionFrameJPEG = nil
        phoneDepthUpdatedAt = nil
        phoneFrameFresh = false
        phoneDetectionsCapturedAt = nil
        phoneDetectionsFresh = false
        centerDistance = nil
        phoneSceneDepthSupported = nil
        phoneNearReadingLatched = false
        phoneProximityAlertStatus = "Chưa có số đo LiDAR mới."
        detections = []
        phoneHazardZones = []
        answer = ""
        status = "Đang khởi động camera LiDAR…"
        Task { await refreshVisionCapabilitiesIfNeeded(force: true) }
    }

    func stopPhoneMode() {
        stopVoiceConversation()
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
        phoneDetectionFrameJPEG = nil
        phoneDepthUpdatedAt = nil
        phoneFrameFresh = false
        phoneDetectionsCapturedAt = nil
        phoneDetectionsFresh = false
        centerDistance = nil
        phoneSceneDepthSupported = nil
        phoneNearReadingLatched = false
        phoneProximityAlertStatus = "Chưa có số đo LiDAR mới."
        detections = []
        phoneHazardZones = []
        phoneDetectionFrameJPEG = nil
        answer = ""
    }

    func speakAnswer(_ text: String) {
        speakOnPhone(text, isAnswer: true, isProximityAlert: false)
    }

    var phoneDetectorStatusMessage: String {
        switch phoneDetectorReady {
        case .some(true):
            let model: String
            if phoneDetectorProvider == "cloudflare" {
                model = phoneDetectorModel?.localizedCaseInsensitiveContains("moondream") == true
                    ? "Moondream 3.1 trên Cloudflare"
                    : "detector Cloudflare"
            } else {
                model = phoneDetectorModel ?? "detector trên backend"
            }
            return "Camera iPhone gửi frame tới \(model); đây không phải model chạy trên ESP32. FOMO cục bộ ESP32 vẫn chờ artifact đã huấn luyện."
        case .some(false):
            return "Detector trên backend chưa sẵn sàng cho camera iPhone. FOMO cục bộ ESP32 vẫn chờ artifact đã huấn luyện."
        case .none:
            return "Chưa xác minh detector của backend cho camera iPhone. FOMO cục bộ ESP32 vẫn chờ artifact đã huấn luyện."
        }
    }

    var phoneVoicePathDescription: String {
        if phoneVoiceRealtimeReady == true {
            return "Khi luồng realtime báo sẵn sàng, tiếng Microphone được truyền tới Cloudflare/Deepgram để nhận dạng; câu hỏi và ảnh mới có thể gửi tới Qwen. Nếu luồng lỗi, app chuyển sang Speech của iPhone."
        }
        let note = phoneVoiceRealtimeNote?.trimmingCharacters(in: .whitespacesAndNewlines)
        let availability = note.map { $0.isEmpty ? "" : " " + $0 } ?? ""
        if phoneTranscriptionReady == true {
            return "Speech của iPhone hiện chữ tạm và phát hiện lúc kết thúc câu. Mỗi lượt Microphone được gửi tới Whisper trên Cloudflare để lấy transcript chính; nếu Whisper lỗi, app dùng transcript iPhone. Transcript và ảnh mới gửi tới Qwen; audio không được lưu trong cơ sở dữ liệu app.\(availability)"
        }
        return "Speech của iPhone nhận dạng tiếng Việt; transcript và ảnh mới gửi tới Qwen. Nhận dạng tiếng Việt trên cloud hiện chưa sẵn sàng.\(availability)"
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
            self?.finishVoiceSpeech(utteranceID: utteranceID)
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in
            self?.finishSpeech(utteranceID: utteranceID)
            self?.finishVoiceSpeech(utteranceID: utteranceID)
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
        phoneHazardZones = []
        phoneDetectionFrameJPEG = nil
        phoneDetectionsCapturedAt = nil
        phoneDetectionsFresh = false
        status = enabled ? "Đang chờ detector server xử lý frame iPhone mới…" : "Đã tạm dừng gửi frame iPhone tới detector server."
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

    private func isSupportedDeviceDetectorModel(_ modelID: String?) -> Bool {
        guard let modelID else {
            return false
        }
        let normalized = modelID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.hasPrefix("fomo:") || normalized.hasPrefix("espdet:")
    }

    var deviceFomoOutputForCurrentFrame: Bool {
        guard deviceConnection?.transport == "firmware_wifi",
              deviceConnection?.deviceConnected == true,
              deviceOperationEnabled == true,
              let status = deviceStatusSnapshot,
              status.source == "device",
              isSupportedDeviceDetectorModel(status.detectorModel),
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
            return "ESP32 detector đang chờ model và output từ firmware qua Wi-Fi. BLE chỉ mang status, ToF và nút; USB bridge không xác nhận inference."
        }
        guard let status = deviceStatusSnapshot,
              status.source == "device" else {
            return "Đang chờ snapshot detector từ firmware."
        }
        let modelID = status.detectorModel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard isSupportedDeviceDetectorModel(modelID) else {
            return "ESP32 chưa báo model detector được hỗ trợ (FOMO hoặc ESPDet-Pico)."
        }
        guard status.inferenceStatus == "ok" else {
            return "Firmware có model \(modelID) nhưng chưa báo inference thành công. App chưa hiển thị kết quả."
        }
        guard deviceFomoOutputForCurrentFrame else {
            return "Đang chờ detection mới cùng boot và frame JPEG hiện tại; output cũ hoặc không khớp bị ẩn."
        }
        if deviceDetections.isEmpty {
            return "Firmware đã xử lý frame \(deviceFrameSequence ?? 0); chưa phát hiện vật thể trong frame này."
        }
        return "ESP32 detector · frame \(deviceFrameSequence ?? 0) · model \(modelID)."
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
            status = "Cần địa chỉ backend trong Cài đặt để nhận diện camera iPhone."
            detectionEnabled = false
            detections = []
            phoneHazardZones = []
            phoneDetectionFrameJPEG = nil
            phoneDetectionsCapturedAt = nil
            phoneDetectionsFresh = false
            return
        }

        isDetecting = true
        let detectionGeneration = phoneDetectionGeneration
        defer { if modeGeneration == phoneModeGeneration { isDetecting = false } }
        status = "Đang gửi frame iPhone tới detector server…"
        do {
            let (data, response) = try await sendImage(endpoint: "detect", image: jpeg, timeoutInterval: 12)
            guard phoneModeActive,
                  modeGeneration == phoneModeGeneration,
                  detectionEnabled,
                  detectionGeneration == phoneDetectionGeneration else { return }
            let payload = try Self.decode(YOLOPayload.self, data: data, response: response)
            detections = payload.detections.prefix(12).map { item in
                let distance = depth?.distance(normalizedBox: item.box)
                return FusedDetection(
                    label: item.label,
                    confidence: item.confidence,
                    distanceMeters: distance,
                    pathAssessment: Self.assessDetectionPath(box: item.box, distanceMeters: distance)
                )
            }
            phoneHazardZones = fuseHazardZones(payload.hazardZones, depth: depth)
            phoneDetectionFrameJPEG = jpeg
            phoneDetectionsCapturedAt = capturedAt
            let detectionAge = Date().timeIntervalSince(capturedAt)
            phoneDetectionsFresh = detectionAge >= 0 && detectionAge <= Self.phoneDetectionFreshnessSeconds
            let timing = payload.inferenceMs.map { " · \(Int($0)) ms" } ?? ""
            let depthStatus: String
            if depth == nil {
                depthStatus = "sceneDepth chưa có ở khung này."
            } else {
                depthStatus = "khoảng cách sceneDepth là ước tính."
            }
            let zoneStatus: String
            if phoneHazardZones.isEmpty {
                zoneStatus = ""
            } else if phoneHazardZones.contains(where: { $0.isHazard }) {
                zoneStatus = " · MobileNet gợi ý vùng ảnh có nguy cơ"
            } else {
                zoneStatus = " · MobileNet đã phân tích ba vùng ảnh"
            }
            let detectorName = phoneDetectorProvider == "cloudflare" ? "Moondream cloud" : "Detector server"
            status = "\(detectorName): \(detections.count) vật thể\(timing)\(zoneStatus) · \(depthStatus)"
        } catch {
            if phoneModeActive,
               modeGeneration == phoneModeGeneration,
               detectionGeneration == phoneDetectionGeneration,
               !Task.isCancelled {
                detections = []
                phoneHazardZones = []
                phoneDetectionFrameJPEG = nil
                phoneDetectionsCapturedAt = nil
                phoneDetectionsFresh = false
                status = userFacingErrorMessage(error, fallback: "Chưa gửi được frame tới backend. Kiểm tra kết nối rồi thử lại.")
            }
        }
    }

    private func fuseHazardZones(_ payload: YOLOHazardZones?, depth: DepthSnapshot?) -> [FusedHazardZone] {
        guard payload?.status == "ready", let zones = payload?.zones else { return [] }
        return zones.compactMap { zone in
            guard let probability = zone.hazardProbability,
                  probability.isFinite,
                  (0...1).contains(probability),
                  let box = Self.normalizedZoneBox(zone.id) else {
                return nil
            }
            let isHazard = zone.isHazard ?? (probability >= (payload?.threshold ?? 0.35))
            return FusedHazardZone(
                zone: zone.id,
                hazardProbability: probability,
                isHazard: isHazard,
                depthMeters: depth?.distance(normalizedBox: box)
            )
        }
    }

    private static func normalizedZoneBox(_ zone: String) -> [Double]? {
        switch zone {
        case "left": return [0, 0, 1.0 / 3.0, 1]
        case "center": return [1.0 / 3.0, 0, 2.0 / 3.0, 1]
        case "right": return [2.0 / 3.0, 0, 1, 1]
        default: return nil
        }
    }

    private static func assessDetectionPath(box: [Double], distanceMeters: Double?) -> DetectionPathAssessment {
        guard box.count >= 4, box.prefix(4).allSatisfy({ $0.isFinite }) else {
            return .unknownDistance
        }
        let left = min(1, max(0, box[0]))
        let top = min(1, max(0, box[1]))
        let right = min(1, max(0, box[2]))
        let bottom = min(1, max(0, box[3]))
        guard right > left, bottom > top else { return .unknownDistance }

        // Approximate the path as a trapezoid: narrow toward the horizon,
        // wider near the phone. Use the detection's lower-center point as a
        // first-pass estimate of where it meets the walking surface.
        let minimumPathY = 0.25
        guard bottom >= minimumPathY else { return .outsideCorridor }
        let nearFactor = min(1, max(0, (bottom - minimumPathY) / (1 - minimumPathY)))
        let halfWidth = 0.12 + 0.22 * nearFactor
        let corridorLeft = 0.5 - halfWidth
        let corridorRight = 0.5 + halfWidth
        // A wide object may block the corridor even when its center lies
        // outside it, so test the box's horizontal overlap at its ground edge.
        guard right >= corridorLeft, left <= corridorRight else { return .outsideCorridor }

        guard let distanceMeters,
              distanceMeters.isFinite,
              distanceMeters >= 0.15 else {
            return .unknownDistance
        }
        if distanceMeters <= Self.phoneProximityAlertThresholdMeters {
            return .immediateCandidate
        }
        if distanceMeters <= Self.phoneNavigationHorizonMeters {
            return .nearCandidate
        }
        return .farContext
    }

    func ask(question: String) async {
        guard phoneModeActive else { return }
        let cleanedQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedQuestion.isEmpty else {
            status = "Nhập câu hỏi về cảnh trước."
            return
        }
        let sceneSnapshot = currentPhoneVisionSnapshot()
        guard let latestJPEG = sceneSnapshot.image, phoneHasFreshFrame else {
            status = "Đang chờ khung hình camera mới."
            return
        }
        guard !backendBaseURL.isEmpty else {
            status = "Nhập địa chỉ backend trong phần cài đặt trước."
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
                spatialContext: sceneSnapshot.spatialContext,
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
                : payload.visionError ?? "Đây là tóm tắt detector; Vision LLM chưa được gọi."
        } catch {
            if phoneModeActive,
               modeGeneration == phoneModeGeneration,
               askGeneration == phoneAskGeneration,
               !Task.isCancelled {
                status = userFacingErrorMessage(error, fallback: "Chưa gửi được ảnh và câu hỏi tới Vision. Kiểm tra kết nối rồi thử lại.")
            }
        }
    }

    func startVoiceConversation() async {
        guard !isVoiceConversationActive, !isVoiceConnecting else { return }
        guard phoneModeActive else {
            voiceStatus = "Chọn chế độ Chỉ dùng iPhone trước."
            return
        }
        guard !backendBaseURL.isEmpty else {
            voiceStatus = "Nhập URL Cloudflare và đăng nhập trong Cài đặt trước."
            return
        }
        if phoneTranscriptionReady == nil || phoneVoiceRealtimeReady == nil {
            voiceStatus = "Đang kiểm tra khả năng thoại cloud…"
            await refreshVisionCapabilitiesIfNeeded(force: true)
        }
        let useRealtimeCloud = phoneVoiceRealtimeReady == true
        let recognizer = vietnameseSpeechRecognizer
        if !useRealtimeCloud, recognizer == nil {
            voiceStatus = "iPhone hiện không có bộ nhận dạng giọng nói tiếng Việt."
            return
        }

        voiceSessionGeneration += 1
        let requestedVoiceGeneration = voiceSessionGeneration
        isVoiceConnecting = true
        voiceStatus = useRealtimeCloud
            ? "Đang xin quyền Microphone để mở thoại realtime cloud…"
            : "Đang xin quyền Microphone và Speech…"
        var waitForRealtimeHandshake = false
        defer {
            if !waitForRealtimeHandshake { isVoiceConnecting = false }
        }

        if !useRealtimeCloud {
            let speechAuthorization = await requestVoiceSpeechAuthorization()
            guard requestedVoiceGeneration == voiceSessionGeneration else { return }
            guard speechAuthorization == .authorized else {
                voiceStatus = "Cần cho phép Nhận dạng giọng nói trong iPhone để bắt đầu."
                return
            }
            guard let recognizer else {
                voiceStatus = "iPhone hiện không có bộ nhận dạng giọng nói tiếng Việt."
                return
            }
            guard recognizer.isAvailable else {
                voiceStatus = "Dịch vụ nhận tiếng Việt của iPhone đang ngoại tuyến hoặc bận."
                return
            }
        }

        let microphoneAuthorized = await requestVoiceMicrophoneAuthorization()
        guard requestedVoiceGeneration == voiceSessionGeneration else { return }
        guard microphoneAuthorized else {
            voiceStatus = "Cần cho phép Microphone trong iPhone để bắt đầu."
            return
        }
        guard phoneModeActive, requestedVoiceGeneration == voiceSessionGeneration else { return }

        stopSpeakingAnswer()
        isVoiceConversationActive = true
        isVoiceListening = false
        isVoiceThinking = false
        voiceTranscript = ""
        latestVoiceTranscript = ""
        voiceHistory = []

        if useRealtimeCloud {
            voiceStatus = phoneVoiceRealtimeModel.map { "Đang mở luồng Microphone tới \($0)…" }
                ?? "Đang mở luồng Microphone tới nhận dạng tiếng Việt trên cloud…"
            waitForRealtimeHandshake = true
            do {
                try await connectRealtimeVoiceSession(generation: requestedVoiceGeneration)
            } catch {
                waitForRealtimeHandshake = false
                await fallbackToOnDeviceVoice(
                    reason: userFacingErrorMessage(error, fallback: "Không mở được thoại realtime cloud."),
                    generation: requestedVoiceGeneration
                )
            }
            return
        }

        voiceStatus = phoneTranscriptionReady == true
            ? "Đang nghe tiếng Việt trên iPhone; Whisper cloud hỗ trợ khi nhận dạng chưa chắc."
            : "Đang nghe bằng Speech của iPhone; transcript và ảnh mới được gửi tới trợ lý cloud."
        do {
            try startVoiceRecognition()
        } catch {
            isVoiceConversationActive = false
            voiceStatus = userFacingErrorMessage(error, fallback: "Chưa mở được Microphone trên iPhone.")
            stopVoiceCapture()
        }
    }

    func stopVoiceConversation() {
        guard isVoiceConversationActive || isVoiceConnecting || isVoiceListening || isVoiceThinking else { return }
        voiceSessionGeneration += 1
        voiceResponseTask?.cancel()
        voiceResponseTask = nil
        voiceDebounceTask?.cancel()
        voiceDebounceTask = nil
        stopVoiceCapture()
        stopRealtimeVoiceSession()
        if !voiceSpeechUtteranceIDs.isEmpty {
            speechSynthesizer.stopSpeaking(at: .immediate)
            voiceSpeechUtteranceIDs.removeAll()
        }
        voiceSpeechBuffer = ""
        voiceReplyStreamFinished = false
        isVoiceConnecting = false
        isVoiceConversationActive = false
        isVoiceListening = false
        isVoiceThinking = false
        deactivateSpeechSession()
        voiceStatus = "Đã kết thúc hội thoại giọng nói."
    }

    private func connectRealtimeVoiceSession(generation: Int) async throws {
        try await ensureAuthenticated()
        guard generation == voiceSessionGeneration,
              isVoiceConversationActive else { return }

        let httpURL = try makeEndpoint("voice/realtime")
        guard var socketComponents = URLComponents(url: httpURL, resolvingAgainstBaseURL: false),
              var originComponents = URLComponents(url: httpURL, resolvingAgainstBaseURL: false) else {
            throw APIError.message("Không tạo được địa chỉ thoại realtime.")
        }
        socketComponents.scheme = socketComponents.scheme?.lowercased() == "https" ? "wss" : "ws"
        guard let socketURL = socketComponents.url else {
            throw APIError.message("Địa chỉ thoại realtime không hợp lệ.")
        }
        originComponents.path = ""
        originComponents.query = nil
        originComponents.fragment = nil
        guard let origin = originComponents.string else {
            throw APIError.message("Không xác định được nguồn của backend.")
        }

        var request = URLRequest(url: socketURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.setValue(origin, forHTTPHeaderField: "Origin")
        applyAccessAuthorization(to: &request)
        if let cookies = HTTPCookieStorage.shared.cookies(for: httpURL), !cookies.isEmpty {
            let cookieHeader = HTTPCookie.requestHeaderFields(with: cookies)["Cookie"]
            if let cookieHeader { request.setValue(cookieHeader, forHTTPHeaderField: "Cookie") }
        }

        let socket = URLSession.shared.webSocketTask(with: request)
        voiceRealtimeSocket = socket
        voiceRealtimeSessionReady = false
        voiceRealtimeFailedForSession = false
        let writer = RealtimeVoiceSocketWriter(
            socket: socket,
            queue: voiceRealtimeSendQueue,
            onFailure: { [weak self] error in
                Task { @MainActor [weak self] in
                    self?.handleRealtimeVoiceDisconnect(error, generation: generation)
                }
            }
        )
        voiceRealtimeSocketWriter = writer
        socket.resume()
        voiceRealtimeReceiveTask?.cancel()
        voiceRealtimeReceiveTask = Task { [weak self] in
            guard let self else { return }
            await self.receiveRealtimeVoiceMessages(socket: socket, generation: generation)
        }
        voiceRealtimeHandshakeTimeoutTask?.cancel()
        voiceRealtimeHandshakeTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            guard let self,
                  generation == self.voiceSessionGeneration,
                  self.isVoiceConnecting,
                  !self.voiceRealtimeSessionReady else { return }
            await self.fallbackToOnDeviceVoice(
                reason: "Cloud thoại chưa xác nhận phiên trong 12 giây.",
                generation: generation
            )
        }

        let startMessage = try Self.jsonString(["type": "start", "language": "vi"])
        writer.send(.string(startMessage))
    }

    private func receiveRealtimeVoiceMessages(socket: URLSessionWebSocketTask, generation: Int) async {
        do {
            while !Task.isCancelled {
                let message = try await socket.receive()
                guard generation == voiceSessionGeneration,
                      voiceRealtimeSocket === socket else { return }
                guard case let .string(text) = message,
                      let data = text.data(using: .utf8),
                      let event = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let type = event["type"] as? String else { continue }
                handleRealtimeVoiceEvent(type: type, event: event, generation: generation)
            }
        } catch {
            guard !Task.isCancelled else { return }
            handleRealtimeVoiceDisconnect(error, generation: generation)
        }
    }

    private func handleRealtimeVoiceEvent(type: String, event: [String: Any], generation: Int) {
        guard generation == voiceSessionGeneration,
              isVoiceConversationActive else { return }
        switch type {
        case "session_ready":
            guard !voiceRealtimeSessionReady,
                  let socket = voiceRealtimeSocket else { return }
            voiceRealtimeHandshakeTimeoutTask?.cancel()
            voiceRealtimeSessionReady = true
            isVoiceConnecting = false
            phoneVoiceRealtimeModel = event["stt_model"] as? String ?? phoneVoiceRealtimeModel
            startRealtimeVoiceFramePump(generation: generation)
            do {
                try startRealtimeVoiceCapture(socket: socket, generation: generation)
            } catch {
                Task { @MainActor [weak self] in
                    await self?.fallbackToOnDeviceVoice(
                        reason: userFacingErrorMessage(error, fallback: "Không mở được Microphone cho thoại cloud."),
                        generation: generation
                    )
                }
            }
        case "transcript":
            let transcript = (event["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !transcript.isEmpty else { return }
            voiceTranscript = transcript
            latestVoiceTranscript = transcript
            voiceStatus = "Đang nhận dạng tiếng Việt trực tiếp trên cloud…"
            if event["final"] as? Bool == true, !isVoiceThinking {
                stopVoiceCapture()
                voiceRealtimeFrameTask?.cancel()
                voiceRealtimeFrameTask = nil
                isVoiceListening = false
                isVoiceThinking = true
                answer = ""
                voiceSpeechBuffer = ""
                voiceReplyStreamFinished = false
                voiceStatus = "Đã nhận câu nói; đang hỏi trợ lý cloud…"
            }
        case "assistant_start":
            if !isVoiceThinking {
                stopVoiceCapture()
                voiceRealtimeFrameTask?.cancel()
                voiceRealtimeFrameTask = nil
            }
            isVoiceListening = false
            isVoiceThinking = true
            answer = ""
            voiceSpeechBuffer = ""
            voiceReplyStreamFinished = false
            voiceStatus = "Đang tạo câu trả lời tiếng Việt trên cloud…"
        case "assistant_delta":
            let delta = event["text"] as? String ?? ""
            guard !delta.isEmpty else { return }
            isVoiceThinking = true
            answer += delta
            voiceStatus = "Đang trả lời bằng giọng nói…"
            queueVoiceSpeech(delta, flush: false)
        case "assistant_done":
            let fullText = (event["text"] as? String ?? answer).trimmingCharacters(in: .whitespacesAndNewlines)
            answer = fullText
            if !latestVoiceTranscript.isEmpty, !fullText.isEmpty {
                voiceHistory = Array((voiceHistory + [
                    ["role": "user", "content": latestVoiceTranscript],
                    ["role": "assistant", "content": fullText]
                ]).suffix(8))
            }
            voiceReplyStreamFinished = true
            queueVoiceSpeech("", flush: true)
            finishVoiceReplyIfReady()
        case "voice_error":
            let message = event["message"] as? String ?? "Luồng thoại cloud gặp lỗi."
            if !voiceRealtimeSessionReady || !isVoiceThinking {
                Task { @MainActor [weak self] in
                    await self?.fallbackToOnDeviceVoice(reason: message, generation: generation)
                }
            } else {
                voiceStatus = message
                if isVoiceThinking {
                    isVoiceThinking = false
                    voiceReplyStreamFinished = true
                    queueVoiceSpeech("", flush: true)
                    finishVoiceReplyIfReady()
                } else if !isVoiceListening, let socket = voiceRealtimeSocket {
                    Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: 450_000_000)
                        guard let self,
                              generation == self.voiceSessionGeneration,
                              self.voiceRealtimeSessionReady,
                              !self.isVoiceThinking,
                              !self.isVoiceListening else { return }
                        try? self.startRealtimeVoiceCapture(socket: socket, generation: generation)
                    }
                }
            }
        default:
            break
        }
    }

    private func startRealtimeVoiceCapture(socket: URLSessionWebSocketTask, generation: Int) throws {
        guard isVoiceConversationActive,
              voiceRealtimeSessionReady,
              !voiceRealtimeFailedForSession,
              !voiceAudioTapInstalled else { return }

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playAndRecord,
                                     mode: .voiceChat,
                                     options: [.defaultToSpeaker, .allowBluetooth])
        try audioSession.setActive(true, options: [.notifyOthersOnDeactivation])
        speechSessionActive = true

        let input = voiceAudioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0,
              format.sampleRate > 0,
              let encoder = RealtimeVoicePCMEncoder(sourceFormat: format),
              let writer = voiceRealtimeSocketWriter,
              voiceRealtimeSocket === socket else {
            throw APIError.message("Không thể chuyển Microphone iPhone sang PCM 16 kHz.")
        }
        voiceRealtimePCMEncoder = encoder
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            for packet in encoder.append(buffer) {
                writer.send(.data(packet))
            }
        }
        voiceAudioTapInstalled = true
        voiceAudioEngine.prepare()
        try voiceAudioEngine.start()
        isVoiceListening = true
        isVoiceThinking = false
        voiceStatus = "Đang nghe tiếng Việt trực tiếp trên cloud…"
    }

    private func startRealtimeVoiceFramePump(generation: Int) {
        voiceRealtimeFrameTask?.cancel()
        voiceRealtimeFrameTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled,
                  generation == self.voiceSessionGeneration,
                  self.isVoiceConversationActive,
                  self.voiceRealtimeSessionReady {
                self.sendFreshFrameToRealtimeVoice()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func sendFreshFrameToRealtimeVoice() {
        let sceneSnapshot = currentPhoneVisionSnapshot()
        guard let image = sceneSnapshot.image,
              image.count <= 360_000,
              let writer = voiceRealtimeSocketWriter else { return }
        let dataURL = "data:image/jpeg;base64," + image.base64EncodedString()
        var payload: [String: Any] = ["type": "frame", "data": dataURL]
        if !sceneSnapshot.spatialContext.isEmpty {
            payload["spatial_context"] = sceneSnapshot.spatialContext
        }
        guard dataURL.utf8.count < 500_000,
              let message = try? Self.jsonString(payload) else { return }
        writer.send(.string(message))
    }

    private func handleRealtimeVoiceDisconnect(_ error: Error, generation: Int) {
        guard generation == voiceSessionGeneration,
              isVoiceConversationActive,
              !voiceRealtimeFailedForSession else { return }
        Task { @MainActor [weak self] in
            await self?.fallbackToOnDeviceVoice(
                reason: userFacingErrorMessage(error, fallback: "Luồng thoại realtime đã ngắt."),
                generation: generation
            )
        }
    }

    private func fallbackToOnDeviceVoice(reason: String, generation: Int) async {
        guard generation == voiceSessionGeneration,
              isVoiceConversationActive,
              !voiceRealtimeFailedForSession else { return }
        voiceRealtimeFailedForSession = true
        voiceRealtimeSessionReady = false
        voiceRealtimeHandshakeTimeoutTask?.cancel()
        voiceRealtimeFrameTask?.cancel()
        voiceRealtimeFrameTask = nil
        voiceRealtimeReceiveTask?.cancel()
        voiceRealtimeReceiveTask = nil
        if let socket = voiceRealtimeSocket {
            socket.cancel(with: .goingAway, reason: nil)
        }
        voiceRealtimeSocket = nil
        voiceRealtimeSocketWriter = nil
        stopVoiceCapture()
        isVoiceConnecting = false
        voiceStatus = "Cloud realtime chưa sẵn sàng (\(reason)); đang chuyển sang Speech của iPhone…"

        if isVoiceThinking || !voiceSpeechUtteranceIDs.isEmpty {
            isVoiceThinking = false
            voiceReplyStreamFinished = true
            queueVoiceSpeech("", flush: true)
            finishVoiceReplyIfReady()
            return
        }
        await startOnDeviceVoiceFallback(generation: generation)
    }

    private func startOnDeviceVoiceFallback(generation: Int) async {
        guard generation == voiceSessionGeneration,
              isVoiceConversationActive,
              !isVoiceThinking,
              !isVoiceListening else { return }
        let speechAuthorization = await requestVoiceSpeechAuthorization()
        guard generation == voiceSessionGeneration,
              isVoiceConversationActive else { return }
        guard speechAuthorization == .authorized else {
            isVoiceConversationActive = false
            voiceStatus = "Cloud realtime chưa sẵn sàng; cần cho phép Speech iPhone để dùng phương án dự phòng."
            return
        }
        guard let recognizer = vietnameseSpeechRecognizer, recognizer.isAvailable else {
            isVoiceConversationActive = false
            voiceStatus = "Cloud realtime chưa sẵn sàng và Speech tiếng Việt trên iPhone đang ngoại tuyến."
            return
        }
        do {
            try startVoiceRecognition()
            voiceStatus = "Đang nghe bằng Speech của iPhone; câu nói và ảnh mới được gửi tới trợ lý cloud."
        } catch {
            isVoiceConversationActive = false
            voiceStatus = userFacingErrorMessage(error, fallback: "Chưa mở lại được Microphone trên iPhone.")
        }
    }

    private func stopRealtimeVoiceSession() {
        voiceRealtimeHandshakeTimeoutTask?.cancel()
        voiceRealtimeHandshakeTimeoutTask = nil
        voiceRealtimeFrameTask?.cancel()
        voiceRealtimeFrameTask = nil
        voiceRealtimeReceiveTask?.cancel()
        voiceRealtimeReceiveTask = nil
        if let socket = voiceRealtimeSocket {
            socket.cancel(with: .normalClosure, reason: nil)
        }
        voiceRealtimeSocket = nil
        voiceRealtimeSocketWriter = nil
        voiceRealtimePCMEncoder = nil
        voiceRealtimeSessionReady = false
        voiceRealtimeFailedForSession = false
    }

    private func requestVoiceSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        guard current == .notDetermined else { return current }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private func requestVoiceMicrophoneAuthorization() async -> Bool {
        let audioSession = AVAudioSession.sharedInstance()
        switch audioSession.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                audioSession.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
    }

    private func startVoiceRecognition() throws {
        guard isVoiceConversationActive,
              let recognizer = vietnameseSpeechRecognizer,
              recognizer.isAvailable else {
            throw APIError.message("Nhận dạng giọng nói tiếng Việt trên iPhone chưa sẵn sàng.")
        }

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playAndRecord,
                                     mode: .voiceChat,
                                     options: [.defaultToSpeaker, .allowBluetooth])
        try audioSession.setActive(true, options: [.notifyOthersOnDeactivation])
        speechSessionActive = true

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        voiceRecognitionRequest = request

        let input = voiceAudioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            throw APIError.message("iPhone chưa mở được luồng âm thanh từ Microphone.")
        }
        voiceAudioCapture.reset(sampleRate: format.sampleRate)
        lastVoiceCaptureWAV = nil
        let audioCapture = voiceAudioCapture
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            request.append(buffer)
            audioCapture.append(buffer)
        }
        voiceAudioTapInstalled = true

        voiceRecognitionGeneration += 1
        let recognitionGeneration = voiceRecognitionGeneration
        voiceRecognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString ?? ""
            let isFinal = result?.isFinal ?? false
            let errorMessage = error?.localizedDescription
            Task { @MainActor [weak self] in
                self?.handleVoiceRecognition(text: text,
                                              isFinal: isFinal,
                                              errorMessage: errorMessage,
                                              generation: recognitionGeneration)
            }
        }

        voiceAudioEngine.prepare()
        try voiceAudioEngine.start()
        isVoiceListening = true
        isVoiceThinking = false
        voiceStatus = phoneTranscriptionReady == true
            ? "Đang nghe tiếng Việt; Whisper cloud sẽ xác nhận từng câu."
            : "Đang nghe… nói tự nhiên bằng tiếng Việt."
    }

    private func handleVoiceRecognition(
        text: String,
        isFinal: Bool,
        errorMessage: String?,
        generation: Int
    ) {
        guard generation == voiceRecognitionGeneration,
              isVoiceConversationActive,
              !isVoiceThinking else { return }

        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleaned.isEmpty {
            latestVoiceTranscript = cleaned
            voiceTranscript = cleaned
            voiceStatus = "Đang nghe tiếng Việt…"
            voiceDebounceTask?.cancel()
            if isFinal {
                Task { await submitVoiceTurn(cleaned) }
            } else {
                voiceDebounceTask = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 1_250_000_000)
                    guard let self,
                          !Task.isCancelled,
                          self.isVoiceConversationActive,
                          !self.isVoiceThinking,
                          self.latestVoiceTranscript == cleaned else { return }
                    await self.submitVoiceTurn(cleaned)
                }
            }
            return
        }

        if let errorMessage, !errorMessage.isEmpty {
            let isNoSpeech = errorMessage.localizedCaseInsensitiveContains("no speech")
            voiceStatus = isNoSpeech
                ? "Chưa nghe rõ; đang mở lại Microphone…"
                : "Nhận giọng nói bị gián đoạn. \(errorMessage)"
            stopVoiceCapture()
            guard isVoiceConversationActive else { return }
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 450_000_000)
                guard let self, self.isVoiceConversationActive, !self.isVoiceThinking else { return }
                do {
                    try self.startVoiceRecognition()
                } catch {
                    self.voiceStatus = userFacingErrorMessage(error, fallback: "Chưa mở lại được Microphone.")
                    self.isVoiceConversationActive = false
                }
            }
        }
    }

    private func stopVoiceCapture(preserveAudioForTurn: Bool = false) {
        voiceRecognitionGeneration += 1
        if let finalPacket = voiceRealtimePCMEncoder?.finish(),
           let writer = voiceRealtimeSocketWriter {
            writer.send(.data(finalPacket))
        }
        voiceRealtimePCMEncoder = nil
        if voiceAudioEngine.isRunning { voiceAudioEngine.stop() }
        if voiceAudioTapInstalled {
            voiceAudioEngine.inputNode.removeTap(onBus: 0)
            voiceAudioTapInstalled = false
        }
        voiceRecognitionRequest?.endAudio()
        voiceRecognitionRequest = nil
        voiceRecognitionTask?.cancel()
        voiceRecognitionTask = nil
        lastVoiceCaptureWAV = preserveAudioForTurn ? voiceAudioCapture.makeWAV() : nil
        if !preserveAudioForTurn {
            voiceAudioCapture.reset(sampleRate: 0)
        }
        isVoiceListening = false
        deactivateSpeechSession()
    }

    private func submitVoiceTurn(_ transcript: String) async {
        let cleanedTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isVoiceConversationActive,
              !isVoiceThinking,
              cleanedTranscript.count >= 2 else { return }

        voiceDebounceTask?.cancel()
        voiceDebounceTask = nil
        let shouldUseCloudTranscription = phoneTranscriptionReady == true
        stopVoiceCapture(preserveAudioForTurn: shouldUseCloudTranscription)
        let capturedAudio = shouldUseCloudTranscription ? lastVoiceCaptureWAV : nil
        lastVoiceCaptureWAV = nil
        isVoiceThinking = true
        voiceStatus = capturedAudio != nil
            ? "Đang gửi lời nói lên Whisper Cloudflare…"
            : "Đang gửi bản nhận dạng trực tiếp và ảnh mới tới Qwen…"
        answer = ""
        voiceSpeechBuffer = ""
        voiceReplyStreamFinished = false
        let voiceGeneration = voiceSessionGeneration
        let modeGeneration = phoneModeGeneration
        let history = voiceHistory
        let sceneSnapshot = currentPhoneVisionSnapshot()
        let image = sceneSnapshot.image
        let spatialContext = sceneSnapshot.spatialContext

        voiceResponseTask?.cancel()
        voiceResponseTask = Task { [weak self] in
            await self?.streamVoiceAnswer(cleanedTranscript,
                                          history: history,
                                          image: image,
                                          spatialContext: spatialContext,
                                          audioWAV: capturedAudio,
                                          voiceGeneration: voiceGeneration,
                                          modeGeneration: modeGeneration)
        }
    }

    private func streamVoiceAnswer(
        _ transcript: String,
        history: [[String: String]],
        image: Data?,
        spatialContext: [String: Any],
        audioWAV: Data?,
        voiceGeneration: Int,
        modeGeneration: Int
    ) async {
        do {
            var effectiveTranscript = transcript
            if phoneTranscriptionReady == true, let audioWAV, !audioWAV.isEmpty {
                do {
                    voiceStatus = "\(voiceTranscriptionModelName) đang nhận dạng câu nói trên cloud…"
                    let cloudTranscript = try await transcribeVoiceAudio(audioWAV)
                    try Task.checkCancellation()
                    guard voiceGeneration == voiceSessionGeneration,
                          modeGeneration == phoneModeGeneration,
                          isVoiceConversationActive else { return }
                    if !cloudTranscript.isEmpty {
                        effectiveTranscript = cloudTranscript
                        voiceTranscript = cloudTranscript
                        latestVoiceTranscript = cloudTranscript
                    }
                } catch is CancellationError {
                    return
                } catch {
                    guard voiceGeneration == voiceSessionGeneration,
                          modeGeneration == phoneModeGeneration,
                          isVoiceConversationActive,
                          !Task.isCancelled else { return }
                    voiceStatus = "Whisper cloud chưa trả lời; dùng nhận dạng tiếng Việt của iPhone…"
                }
            }

            let request = try makeVoiceTurnRequest(
                effectiveTranscript,
                history: history,
                image: image,
                spatialContext: spatialContext
            )
            let (bytes, response) = try await performAuthenticatedStreamRequest(request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.message("Cloudflare không trả trạng thái HTTP hợp lệ.")
            }
            guard http.statusCode == 200 else {
                throw APIError.message("Cloudflare chưa nhận được câu thoại (HTTP \(http.statusCode)). Kiểm tra URL và đăng nhập.")
            }

            var completed = false
            for try await line in bytes.lines {
                try Task.checkCancellation()
                guard voiceGeneration == voiceSessionGeneration,
                      modeGeneration == phoneModeGeneration,
                      isVoiceConversationActive else { return }
                guard line.hasPrefix("data:") else { continue }
                let json = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                guard let data = json.data(using: .utf8),
                      let event = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let type = event["type"] as? String else { continue }

                if type == "delta" {
                    let delta = event["text"] as? String ?? ""
                    guard !delta.isEmpty else { continue }
                    answer += delta
                    voiceStatus = "Qwen đang trả lời bằng giọng nói…"
                    queueVoiceSpeech(delta, flush: false)
                } else if type == "done" {
                    let fullText = (event["text"] as? String ?? answer).trimmingCharacters(in: .whitespacesAndNewlines)
                    answer = fullText
                    voiceHistory = Array((history + [
                        ["role": "user", "content": effectiveTranscript],
                        ["role": "assistant", "content": fullText]
                    ]).suffix(8))
                    completed = true
                    voiceReplyStreamFinished = true
                    queueVoiceSpeech("", flush: true)
                    finishVoiceReplyIfReady()
                } else if type == "error" {
                    throw APIError.message(event["message"] as? String ?? "Qwen chưa trả lời được lượt này.")
                }
            }
            guard completed else {
                throw APIError.message("Luồng trả lời cloud kết thúc trước khi hoàn tất.")
            }
        } catch {
            guard voiceGeneration == voiceSessionGeneration,
                  modeGeneration == phoneModeGeneration,
                  isVoiceConversationActive,
                  !Task.isCancelled else { return }
            voiceStatus = userFacingErrorMessage(error, fallback: "Mất kết nối khi hỏi Qwen trên Cloudflare.")
            isVoiceThinking = false
            voiceReplyStreamFinished = true
            finishVoiceReplyIfReady()
        }
    }

    private func transcribeVoiceAudio(_ wavData: Data) async throws -> String {
        let boundary = "RoSight-ASR-\(UUID().uuidString)"
        var request = try makeRequest(endpoint: "transcribe", method: "POST", timeoutInterval: 45)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.appendUTF8("--\(boundary)\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"voice-turn.wav\"\r\nContent-Type: audio/wav\r\n\r\n")
        body.append(wavData)
        body.appendUTF8("\r\n--\(boundary)--\r\n")
        request.httpBody = body

        let (data, response) = try await performAuthenticatedRequest(request)
        let payload = try Self.decode(CloudTranscriptionPayload.self, data: data, response: response)
        let transcript = payload.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !transcript.isEmpty else {
            throw APIError.message("Whisper không nhận ra câu nói lần này.")
        }
        return transcript
    }

    private var voiceTranscriptionModelName: String {
        phoneTranscriptionModel?.localizedCaseInsensitiveContains("whisper-large-v3-turbo") == true
            ? "Whisper Large v3 Turbo"
            : "Whisper Cloudflare"
    }

    private func makeVoiceTurnRequest(
        _ transcript: String,
        history: [[String: String]],
        image: Data?,
        spatialContext: [String: Any]
    ) throws -> URLRequest {
        let boundary = "RoSight-Voice-\(UUID().uuidString)"
        var request = try makeRequest(endpoint: "voice/turn", method: "POST", timeoutInterval: 150)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        var body = Data()
        body.appendUTF8("--\(boundary)\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\n\(transcript)\r\n")
        let historyData = try JSONSerialization.data(withJSONObject: history)
        let historyText = String(data: historyData, encoding: .utf8) ?? "[]"
        body.appendUTF8("--\(boundary)\r\nContent-Disposition: form-data; name=\"history\"\r\n\r\n\(historyText)\r\n")
        if !spatialContext.isEmpty {
            let contextData = try JSONSerialization.data(withJSONObject: spatialContext)
            let contextText = String(data: contextData, encoding: .utf8) ?? "{}"
            body.appendUTF8("--\(boundary)\r\nContent-Disposition: form-data; name=\"spatial_context\"\r\n\r\n\(contextText)\r\n")
        }
        if let image, image.count <= 240_000 {
            body.appendUTF8("--\(boundary)\r\nContent-Disposition: form-data; name=\"image\"; filename=\"iphone-frame.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n")
            body.append(image)
            body.appendUTF8("\r\n")
        }
        body.appendUTF8("--\(boundary)--\r\n")
        request.httpBody = body
        return request
    }

    private func queueVoiceSpeech(_ text: String, flush: Bool) {
        voiceSpeechBuffer += text
        let sentencePattern = #"[.!?…](?:\s+|$)"#
        while let range = voiceSpeechBuffer.range(of: sentencePattern, options: .regularExpression) {
            let chunk = String(voiceSpeechBuffer[..<range.upperBound])
            voiceSpeechBuffer.removeSubrange(..<range.upperBound)
            enqueueVoiceSpeechChunk(chunk)
        }
        if !flush, voiceSpeechBuffer.count > 100,
           let split = voiceSpeechBuffer.prefix(90).lastIndex(of: " ") {
            let chunk = String(voiceSpeechBuffer[..<split])
            voiceSpeechBuffer.removeSubrange(...split)
            enqueueVoiceSpeechChunk(chunk)
        }
        if flush {
            enqueueVoiceSpeechChunk(voiceSpeechBuffer)
            voiceSpeechBuffer = ""
        }
    }

    private func enqueueVoiceSpeechChunk(_ text: String) {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try audioSession.setActive(true)
            speechSessionActive = true
        } catch {
            voiceStatus = "Đang hiện chữ; iPhone không mở được loa để đọc câu trả lời."
            return
        }
        let utterance = AVSpeechUtterance(string: cleaned)
        utterance.voice = AVSpeechSynthesisVoice(language: "vi-VN")
        utterance.rate = 0.92
        let identifier = ObjectIdentifier(utterance)
        voiceSpeechUtteranceIDs.insert(identifier)
        speechSynthesizer.speak(utterance)
    }

    private func finishVoiceSpeech(utteranceID: ObjectIdentifier) {
        guard voiceSpeechUtteranceIDs.remove(utteranceID) != nil else { return }
        finishVoiceReplyIfReady()
    }

    private func finishVoiceReplyIfReady() {
        guard voiceReplyStreamFinished, voiceSpeechUtteranceIDs.isEmpty else { return }
        voiceReplyStreamFinished = false
        isVoiceThinking = false
        deactivateSpeechSession()
        guard isVoiceConversationActive else { return }
        voiceStatus = "Đã xong lượt này; đang mở lại Microphone…"
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 650_000_000)
            guard let self,
                  self.isVoiceConversationActive,
                  !self.isVoiceThinking,
                  !self.isVoiceListening else { return }
            do {
                if let socket = self.voiceRealtimeSocket,
                   self.voiceRealtimeSessionReady,
                   !self.voiceRealtimeFailedForSession {
                    try self.startRealtimeVoiceCapture(socket: socket, generation: self.voiceSessionGeneration)
                } else if self.voiceRealtimeFailedForSession {
                    await self.startOnDeviceVoiceFallback(generation: self.voiceSessionGeneration)
                } else {
                    try self.startVoiceRecognition()
                }
            } catch {
                self.voiceStatus = userFacingErrorMessage(error, fallback: "Chưa mở lại được Microphone.")
                self.isVoiceConversationActive = false
            }
        }
    }

    private func sendImage(
        endpoint: String,
        image: Data,
        question: String? = nil,
        spatialContext: [String: Any] = [:],
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
        if !spatialContext.isEmpty {
            let contextData = try JSONSerialization.data(withJSONObject: spatialContext)
            let contextText = String(data: contextData, encoding: .utf8) ?? "{}"
            body.appendUTF8("--\(boundary)\r\nContent-Disposition: form-data; name=\"spatial_context\"\r\n\r\n\(contextText)\r\n")
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

    private func performAuthenticatedStreamRequest(
        _ request: URLRequest
    ) async throws -> (URLSession.AsyncBytes, URLResponse) {
        let generation = authenticationGeneration
        try Task.checkCancellation()
        try await ensureAuthenticated()
        try Task.checkCancellation()
        guard generation == authenticationGeneration else {
            throw APIError.message("Cài đặt backend đã đổi. Thử lại với thông tin mới.")
        }
        var result = try await URLSession.shared.bytes(for: request)
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
        result = try await URLSession.shared.bytes(for: request)
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

    func checkBackendCapabilities() async {
        guard !isCheckingBackendCapabilities else { return }
        isCheckingBackendCapabilities = true
        backendCapabilityCheckMessage = nil
        backendCapabilityCheckSucceeded = nil
        defer { isCheckingBackendCapabilities = false }
        await loadVisionCapabilities()
    }

    private func refreshVisionCapabilitiesIfNeeded(force: Bool = false) async {
        if !force, let lastVisionStatusCheck,
           Date().timeIntervalSince(lastVisionStatusCheck) < 15 {
            return
        }
        await loadVisionCapabilities()
    }

    private func loadVisionCapabilities() async {
        lastVisionStatusCheck = Date()
        do {
            let request = try makeRequest(endpoint: "status")
            // /api/status is intentionally public so the connection and model check
            // works before a user signs in. Basic Auth is still applied for tunnels.
            let (data, response) = try await URLSession.shared.data(for: request)
            let payload = try Self.decode(DeviceCapabilitiesPayload.self, data: data, response: response)
            deviceVisionReady = payload.visionReady
            deviceVisionProvider = payload.visionProvider
            phoneDetectorReady = payload.detectorReady
            phoneDetectorModel = payload.detectorModel
            phoneDetectorProvider = payload.detectorProvider
            phoneTranscriptionReady = payload.transcriptionReady
            phoneTranscriptionModel = payload.transcriptionModel
            phoneVoiceRealtimeReady = payload.voiceRealtimeReady
            phoneVoiceRealtimeModel = payload.voiceSttModel
            phoneVoiceRealtimeNote = payload.voiceRealtimeNote
            if isCheckingBackendCapabilities {
                let vision = payload.visionReady
                    ? (payload.visionModel ?? payload.visionProvider ?? "sẵn sàng")
                    : "chưa sẵn sàng"
                let detector = payload.detectorReady == true
                    ? (payload.detectorModel ?? "sẵn sàng")
                    : "chưa sẵn sàng"
                let transcription = payload.transcriptionReady == true
                    ? (payload.transcriptionModel ?? "sẵn sàng")
                    : "chưa sẵn sàng"
                let realtime: String
                if payload.voiceRealtimeReady == true {
                    realtime = payload.voiceSttModel ?? "đang bật"
                } else {
                    realtime = "chưa bật; app dùng Speech iPhone/Whisper dự phòng"
                }
                backendCapabilityCheckSucceeded = true
                backendCapabilityCheckMessage = "Backend phản hồi thành công.\nVision: \(vision)\nNhận diện: \(detector)\nNhận giọng nói: \(transcription)\nThoại realtime: \(realtime)"
            }
        } catch {
            if !Task.isCancelled {
                deviceVisionReady = nil
                deviceVisionProvider = nil
                phoneDetectorReady = nil
                phoneDetectorModel = nil
                phoneDetectorProvider = nil
                phoneTranscriptionReady = nil
                phoneTranscriptionModel = nil
                phoneVoiceRealtimeReady = nil
                phoneVoiceRealtimeModel = nil
                phoneVoiceRealtimeNote = nil
                if isCheckingBackendCapabilities {
                    backendCapabilityCheckSucceeded = false
                    backendCapabilityCheckMessage = userFacingErrorMessage(
                        error,
                        fallback: "Không đọc được trạng thái backend. Kiểm tra địa chỉ và thử lại."
                    )
                }
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
        let firmwareDetectorOutput = deviceConnection?.transport == "firmware_wifi"
            && status.source == "device"
            && isSupportedDeviceDetectorModel(status.detectorModel)
            && status.inferenceStatus == "ok"
        if firmwareDetectorOutput, detectionsFresh, detectionsBootMatches,
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

    func registerCloudAccount(
        displayName: String,
        username: String,
        password: String,
        registrationCode: String
    ) async throws {
        let url = try makeEndpoint("auth/register")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        applyAccessAuthorization(to: &request)
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "display_name": displayName,
            "username": username,
            "password": password,
            "registration_code": registrationCode
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.validateHTTPResponse(data: data, response: response)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw APIError.message("Worker không xác nhận đã tạo tài khoản.")
        }
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

    private static func jsonString(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let value = String(data: data, encoding: .utf8) else {
            throw APIError.message("Không mã hóa được tin nhắn thoại realtime.")
        }
        return value
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
    let hazardZones: YOLOHazardZones?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case detections, error
        case inferenceMs = "inference_ms"
        case hazardZones = "hazard_zones"
    }
}

private struct YOLOHazardZones: Decodable {
    let status: String?
    let threshold: Double?
    let zones: [YOLOHazardZone]?
}

private struct YOLOHazardZone: Decodable {
    let id: String
    let hazardProbability: Double?
    let isHazard: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case hazardProbability = "hazard_probability"
        case isHazard = "is_hazard"
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

private struct CloudTranscriptionPayload: Decodable {
    let text: String?
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

private final class VoiceAudioCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var sampleRate = 0.0
    private var pcm16Mono = Data()
    private let maximumPCMBytes = 5 * 1_024 * 1_024

    func reset(sampleRate: Double) {
        lock.lock()
        self.sampleRate = sampleRate
        if !pcm16Mono.isEmpty {
            pcm16Mono.resetBytes(in: 0..<pcm16Mono.count)
        }
        pcm16Mono.removeAll(keepingCapacity: false)
        lock.unlock()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData else { return }
        let channelCount = Int(buffer.format.channelCount)
        let frameCount = Int(buffer.frameLength)
        guard channelCount > 0, frameCount > 0 else { return }

        lock.lock()
        defer { lock.unlock() }
        let availableFrames = max(0, (maximumPCMBytes - pcm16Mono.count) / 2)
        let framesToAppend = min(frameCount, availableFrames)
        guard framesToAppend > 0 else { return }

        var chunk = Data(capacity: framesToAppend * 2)
        for frame in 0..<framesToAppend {
            var mixedSample: Float = 0
            for channel in 0..<channelCount {
                mixedSample += channels[channel][frame]
            }
            mixedSample /= Float(channelCount)
            mixedSample = mixedSample.isFinite ? min(1, max(-1, mixedSample)) : 0
            let pcmSample = Int16(mixedSample * Float(Int16.max))
            let littleEndianSample = UInt16(bitPattern: pcmSample)
            chunk.append(UInt8(littleEndianSample & 0x00ff))
            chunk.append(UInt8((littleEndianSample >> 8) & 0x00ff))
        }
        pcm16Mono.append(chunk)
    }

    func makeWAV() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        guard sampleRate.isFinite,
              sampleRate >= 8_000,
              sampleRate <= 192_000,
              !pcm16Mono.isEmpty,
              pcm16Mono.count <= Int(UInt32.max) - 36 else {
            if !pcm16Mono.isEmpty {
                pcm16Mono.resetBytes(in: 0..<pcm16Mono.count)
            }
            pcm16Mono.removeAll(keepingCapacity: false)
            sampleRate = 0
            return nil
        }

        let sampleRateHz = UInt32(sampleRate.rounded())
        let dataSize = UInt32(pcm16Mono.count)
        var wav = Data(capacity: 44 + pcm16Mono.count)
        wav.appendUTF8("RIFF")
        wav.appendLittleEndian(dataSize + 36)
        wav.appendUTF8("WAVEfmt ")
        wav.appendLittleEndian(UInt32(16))
        wav.appendLittleEndian(UInt16(1))
        wav.appendLittleEndian(UInt16(1))
        wav.appendLittleEndian(sampleRateHz)
        wav.appendLittleEndian(sampleRateHz * 2)
        wav.appendLittleEndian(UInt16(2))
        wav.appendLittleEndian(UInt16(16))
        wav.appendUTF8("data")
        wav.appendLittleEndian(dataSize)
        wav.append(pcm16Mono)

        pcm16Mono.resetBytes(in: 0..<pcm16Mono.count)
        pcm16Mono.removeAll(keepingCapacity: false)
        sampleRate = 0
        return wav
    }
}

private final class RealtimeVoiceSocketWriter: @unchecked Sendable {
    private let socket: URLSessionWebSocketTask
    private let queue: DispatchQueue
    private let onFailure: (Error) -> Void

    init(socket: URLSessionWebSocketTask, queue: DispatchQueue, onFailure: @escaping (Error) -> Void) {
        self.socket = socket
        self.queue = queue
        self.onFailure = onFailure
    }

    func send(_ message: URLSessionWebSocketTask.Message) {
        queue.async { [socket, onFailure] in
            socket.send(message) { error in
                if let error { onFailure(error) }
            }
        }
    }
}

private final class RealtimeVoicePCMEncoder: @unchecked Sendable {
    private static let outputSampleRate = 16_000.0
    private static let packetByteCount = 3_200 // 100 ms, mono signed 16-bit PCM.

    private let lock = NSLock()
    private let converter: AVAudioConverter
    private let outputFormat: AVAudioFormat
    private var pendingPCM = Data()

    init?(sourceFormat: AVAudioFormat) {
        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Self.outputSampleRate,
            channels: 1,
            interleaved: false
        ), let converter = AVAudioConverter(from: sourceFormat, to: outputFormat) else {
            return nil
        }
        self.outputFormat = outputFormat
        self.converter = converter
    }

    func append(_ source: AVAudioPCMBuffer) -> [Data] {
        lock.lock()
        defer { lock.unlock() }

        let ratio = Self.outputSampleRate / source.format.sampleRate
        let capacity = AVAudioFrameCount(max(64, ceil(Double(source.frameLength) * ratio) + 64))
        guard source.frameLength > 0,
              let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            return []
        }

        var suppliedInput = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            guard !suppliedInput else {
                inputStatus.pointee = .noDataNow
                return nil
            }
            suppliedInput = true
            inputStatus.pointee = .haveData
            return source
        }
        guard status != .error,
              output.frameLength > 0,
              let channels = output.int16ChannelData else { return [] }

        for index in 0..<Int(output.frameLength) {
            let bits = UInt16(bitPattern: channels[0][index].littleEndian)
            pendingPCM.append(UInt8(bits & 0x00ff))
            pendingPCM.append(UInt8((bits >> 8) & 0x00ff))
        }

        var packets: [Data] = []
        while pendingPCM.count >= Self.packetByteCount {
            packets.append(Data(pendingPCM.prefix(Self.packetByteCount)))
            pendingPCM.removeSubrange(..<Self.packetByteCount)
        }
        return packets
    }

    func finish() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        guard !pendingPCM.isEmpty else { return nil }
        let remainder = pendingPCM
        pendingPCM.removeAll(keepingCapacity: false)
        return remainder
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
        return "Không kết nối được backend. Kiểm tra URL, mạng hoặc máy chủ rồi thử lại nhé."
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

    mutating func appendLittleEndian(_ value: UInt16) {
        append(UInt8(value & 0x00ff))
        append(UInt8((value >> 8) & 0x00ff))
    }

    mutating func appendLittleEndian(_ value: UInt32) {
        append(UInt8(value & 0x000000ff))
        append(UInt8((value >> 8) & 0x000000ff))
        append(UInt8((value >> 16) & 0x000000ff))
        append(UInt8((value >> 24) & 0x000000ff))
    }
}
