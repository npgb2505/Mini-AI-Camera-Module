import Foundation
import SwiftUI
import AVFoundation

struct FusedDetection: Identifiable {
    let id = UUID()
    let label: String
    let confidence: Double
    let distanceMeters: Double?
}

@MainActor
final class CameraModel: NSObject, ObservableObject, @preconcurrency AVSpeechSynthesizerDelegate {
    @Published var detectionEnabled = false
    @Published var isDetecting = false
    @Published var isAsking = false
    @Published var centerDistance: Double?
    @Published var detections: [FusedDetection] = []
    @Published var answer = ""
    @Published private(set) var isSpeakingAnswer = false
    @Published private(set) var speechError: String?
    @Published var status = "Đang khởi động camera LiDAR…"
    @Published private(set) var phoneFrameFresh = false
    @Published private(set) var phoneDetectionsFresh = false

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
    private var phoneDetectionsCapturedAt: Date?
    private var lastVisionStatusCheck: Date?
    private var phoneModeActive = false
    private var phoneModeGeneration = 0
    private var phoneDetectionGeneration = 0
    private var phoneAskGeneration = 0
    private var deviceAskGeneration = 0
    private let speechSynthesizer = AVSpeechSynthesizer()
    private var activeSpeechUtteranceID: ObjectIdentifier?
    private var speechSessionActive = false

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
    @Published private(set) var isRefreshingDevice = false
    @Published private(set) var deviceFreshnessRevision = 0

    private var deviceStatusReceivedAtUptime: TimeInterval?
    private var lastDeviceCameraReady: Bool?
    private static let deviceFrameFreshnessMs = 350.0
    private static let maximumDeviceFrameBytes = 2 * 1024 * 1024
    private static let phoneFrameFreshnessSeconds = 2.5
    private static let phoneDetectionFreshnessSeconds = 2.5

    override init() {
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
            deviceConnection = nil
            deviceError = nil
            deviceAskError = nil
            deviceAnswer = ""
            deviceAnswerFrameSequence = nil
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
            status = "Nhập địa chỉ Flask để bật YOLO hoặc hỏi AI."
        } else if self.accountUsername.isEmpty || self.accountPassword.isEmpty {
            status = "Nhập tài khoản Ro Sight trong cài đặt để kết nối."
        } else {
            status = "Đã lưu địa chỉ backend cho phiên này."
        }
    }

    func updateCenterDistance(_ value: Double?) {
        guard phoneModeActive else { return }
        centerDistance = value
        if value == nil, !detectionEnabled {
            status = "Chưa nhận được dữ liệu LiDAR."
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
        phoneFrameFresh = false
        phoneDetectionsCapturedAt = nil
        phoneDetectionsFresh = false
        centerDistance = nil
        detections = []
        answer = ""
        status = "Đang khởi động camera LiDAR…"
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
        phoneFrameFresh = false
        phoneDetectionsCapturedAt = nil
        phoneDetectionsFresh = false
        centerDistance = nil
        detections = []
        answer = ""
    }

    func speakAnswer(_ text: String) {
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
            speechError = "Không mở được âm thanh trên iPhone: \(error.localizedDescription)"
            deactivateSpeechSession()
            return
        }

        let utterance = AVSpeechUtterance(string: cleanedText)
        utterance.voice = AVSpeechSynthesisVoice(language: "vi-VN")
        activeSpeechUtteranceID = ObjectIdentifier(utterance)
        isSpeakingAnswer = true
        speechSynthesizer.speak(utterance)
    }

    func stopSpeakingAnswer() {
        if activeSpeechUtteranceID != nil {
            speechSynthesizer.stopSpeaking(at: .immediate)
        }
        activeSpeechUtteranceID = nil
        isSpeakingAnswer = false
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
        status = enabled ? "Đang chờ kết quả YOLO mới…" : "YOLO đã tạm dừng; camera và LiDAR vẫn đang chạy."
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

    var deviceStatusSnapshot: DeviceStatusPayload? {
        deviceConnection?.status
    }

    var deviceOperationEnabled: Bool? {
        deviceStatusSnapshot?.resolvedOperationEnabled
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
              status.resolvedOperationEnabled == true,
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
        if status.resolvedOperationEnabled == false {
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
        guard status.resolvedOperationEnabled == true else {
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
        } catch {
            guard !Task.isCancelled, generation == authenticationGeneration else { return }
            deviceStatusReceivedAtUptime = nil
            deviceConnection = nil
            deviceError = error.localizedDescription
            clearDevicePreview()
            return
        }

        await refreshVisionCapabilitiesIfNeeded()
        guard !Task.isCancelled, generation == authenticationGeneration else { return }
        guard deviceCameraReady,
              let expectedSequence = deviceConnection?.status?.cameraFrame else {
            clearDevicePreview()
            return
        }

        if deviceFrameData != nil, deviceFrameMatchesCurrentStatus {
            updateDeviceContext(for: deviceFrameSequence)
            return
        }

        clearDevicePreview()
        do {
            try await fetchDeviceFrame(expectedSequence: expectedSequence)
            guard generation == authenticationGeneration else { return }
            deviceError = nil
        } catch {
            guard !Task.isCancelled else { return }
            clearDevicePreview()
            deviceError = error.localizedDescription
        }
    }

    func askAboutDevice(question: String) async {
        let cleanedQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedQuestion.isEmpty else {
            deviceAskError = "Nhập câu hỏi về camera ESP32 trước."
            return
        }
        guard deviceCanAsk else {
            deviceAskError = deviceVisionReady == false
                ? "Vision chưa sẵn sàng trên máy chủ."
                : "Chỉ có thể hỏi khi ESP32 đang hoạt động và có JPEG mới."
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
        defer { if askGeneration == deviceAskGeneration { isDeviceAsking = false } }

        do {
            let request = try makeRequest(
                endpoint: "device/ask",
                method: "POST",
                timeoutInterval: 210,
                jsonBody: ["question": cleanedQuestion, "trigger": "manual"]
            )
            let (data, response) = try await performAuthenticatedRequest(request)
            guard generation == authenticationGeneration,
                  askGeneration == deviceAskGeneration,
                  !Task.isCancelled else { return }
            let payload = try Self.decode(DeviceAskPayload.self, data: data, response: response)
            guard let answer = payload.answer, !answer.isEmpty, payload.visionUsed == true else {
                throw APIError.message(payload.error ?? "Vision chưa trả lời được về khung hình ESP32.")
            }
            deviceAnswer = answer
            deviceAnswerFrameSequence = payload.frameSeq
        } catch {
            if askGeneration == deviceAskGeneration, !Task.isCancelled {
                deviceAskError = error.localizedDescription
            }
        }
    }

    func receiveFrame(_ jpeg: Data, depth: DepthSnapshot, shouldRunYOLO: Bool) async {
        guard phoneModeActive else { return }
        let modeGeneration = phoneModeGeneration
        let capturedAt = Date()
        latestJPEG = jpeg
        latestJPEGAt = capturedAt
        phoneFrameFresh = true
        centerDistance = depth.centerDistance()
        guard shouldRunYOLO, detectionEnabled, !isDetecting else { return }
        guard !backendBaseURL.isEmpty else {
            status = "Cần nhập địa chỉ Flask trước khi chạy YOLO."
            detectionEnabled = false
            detections = []
            phoneDetectionsCapturedAt = nil
            phoneDetectionsFresh = false
            return
        }

        isDetecting = true
        let detectionGeneration = phoneDetectionGeneration
        defer { if modeGeneration == phoneModeGeneration { isDetecting = false } }
        status = "Đang gửi khung hình sang YOLO…"
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
                    distanceMeters: depth.distance(normalizedBox: item.box)
                )
            }
            phoneDetectionsCapturedAt = capturedAt
            let detectionAge = Date().timeIntervalSince(capturedAt)
            phoneDetectionsFresh = detectionAge >= 0 && detectionAge <= Self.phoneDetectionFreshnessSeconds
            let timing = payload.inferenceMs.map { " · \(Int($0)) ms" } ?? ""
            status = "YOLO: \(detections.count) vật thể\(timing) · khoảng cách ghép từ LiDAR."
        } catch {
            if phoneModeActive,
               modeGeneration == phoneModeGeneration,
               detectionGeneration == phoneDetectionGeneration,
               !Task.isCancelled {
                detections = []
                phoneDetectionsCapturedAt = nil
                phoneDetectionsFresh = false
                status = error.localizedDescription
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
                status = error.localizedDescription
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
        } catch {
            if !Task.isCancelled {
                deviceVisionReady = nil
                deviceVisionProvider = nil
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
        if detectionsFresh, detectionsBootMatches,
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

private extension Data {
    mutating func appendUTF8(_ value: String) {
        append(contentsOf: value.utf8)
    }
}
