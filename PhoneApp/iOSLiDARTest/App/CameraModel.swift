import Foundation
import SwiftUI

struct FusedDetection: Identifiable {
    let id = UUID()
    let label: String
    let confidence: Double
    let distanceMeters: Double?
}

@MainActor
final class CameraModel: ObservableObject {
    @Published var detectionEnabled = false
    @Published var isDetecting = false
    @Published var isAsking = false
    @Published var centerDistance: Double?
    @Published var detections: [FusedDetection] = []
    @Published var answer = ""
    @Published var status = "Đang khởi động camera LiDAR…"

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
            || accountUsername != self.accountUsername
            || accountPassword != self.accountPassword
            || accessUsername != self.accessUsername
            || accessPassword != self.accessPassword {
            authenticationGeneration += 1
            authenticationTask?.cancel()
            authenticationTask = nil
            isAuthenticated = false
            authenticationError = nil
            authenticationRetryAfter = .distantPast
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
        centerDistance = value
        if value == nil, !detectionEnabled {
            status = "Chưa nhận được dữ liệu LiDAR."
        }
    }

    func updateCameraStatus(_ value: String) {
        status = value
    }

    func receiveFrame(_ jpeg: Data, depth: DepthSnapshot, shouldRunYOLO: Bool) async {
        latestJPEG = jpeg
        centerDistance = depth.centerDistance()
        guard shouldRunYOLO, detectionEnabled, !isDetecting else { return }
        guard !backendBaseURL.isEmpty else {
            status = "Cần nhập địa chỉ Flask trước khi chạy YOLO."
            detectionEnabled = false
            return
        }

        isDetecting = true
        defer { isDetecting = false }
        status = "Đang gửi khung hình sang YOLO…"
        do {
            let (data, response) = try await sendImage(endpoint: "detect", image: jpeg)
            let payload = try Self.decode(YOLOPayload.self, data: data, response: response)
            detections = payload.detections.prefix(12).map { item in
                FusedDetection(
                    label: item.label,
                    confidence: item.confidence,
                    distanceMeters: depth.distance(normalizedBox: item.box)
                )
            }
            let timing = payload.inferenceMs.map { " · \(Int($0)) ms" } ?? ""
            status = "YOLO: \(detections.count) vật thể\(timing) · khoảng cách ghép từ LiDAR."
        } catch {
            status = error.localizedDescription
        }
    }

    func ask(question: String) async {
        let cleanedQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedQuestion.isEmpty else {
            status = "Nhập câu hỏi về cảnh trước."
            return
        }
        guard let latestJPEG else {
            status = "Đang chờ khung hình camera đầu tiên."
            return
        }
        guard !backendBaseURL.isEmpty else {
            status = "Nhập địa chỉ Flask trong phần cài đặt trước."
            return
        }

        isAsking = true
        answer = ""
        status = "Đang gửi ảnh và câu hỏi tới Vision LLM…"
        defer { isAsking = false }
        do {
            let (data, response) = try await sendImage(
                endpoint: "analyze",
                image: latestJPEG,
                question: cleanedQuestion
            )
            let payload = try Self.decode(AnswerPayload.self, data: data, response: response)
            guard let answer = payload.answer, !answer.isEmpty else {
                throw APIError.message(payload.error ?? "Vision LLM chưa trả lời được.")
            }
            self.answer = answer
            status = payload.visionUsed == true
                ? "Đã nhận câu trả lời từ Vision LLM."
                : payload.visionError ?? "Đây là tóm tắt YOLO; Vision LLM chưa được gọi."
        } catch {
            status = error.localizedDescription
        }
    }

    private func sendImage(
        endpoint: String,
        image: Data,
        question: String? = nil
    ) async throws -> (Data, URLResponse) {
        try await ensureAuthenticated()
        let url = try makeEndpoint(endpoint)
        let boundary = "RoSight-\(UUID().uuidString)"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 45
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
        var (data, response) = try await URLSession.shared.data(for: request)
        if (response as? HTTPURLResponse)?.statusCode == 401 {
            isAuthenticated = false
            authenticationError = nil
            authenticationRetryAfter = .distantPast
            try await ensureAuthenticated()
            (data, response) = try await URLSession.shared.data(for: request)
            if (response as? HTTPURLResponse)?.statusCode == 401 {
                isAuthenticated = false
                authenticationError = "Phiên đăng nhập bị từ chối. Kiểm tra tài khoản Ro Sight và Basic Auth của tunnel trong cài đặt."
            }
        }
        return (data, response)
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
