import SwiftUI
import UIKit

private enum RoSightMode: Equatable {
    case device
    case phone
}

struct CameraScreen: View {
    @StateObject private var model = CameraModel()
    @AppStorage("roSight.backendURL") private var backendURL = ""
    @State private var accountUsername = ""
    @State private var accountPassword = ""
    @State private var accessUsername = ""
    @State private var accessPassword = ""
    @State private var phoneQuestion = ""
    @State private var deviceQuestion = ""
    @State private var selectedMode: RoSightMode?
    @State private var showSettings = false
    @State private var phoneAskTask: Task<Void, Never>?
    @State private var deviceAskTask: Task<Void, Never>?

    var body: some View {
        Group {
            if selectedMode == .phone {
                phoneModeContent
            } else if selectedMode == .device {
                deviceModeContent
            } else {
                modeChooser
            }
        }
        .sheet(isPresented: $showSettings) {
            BackendSettingsSheet(
                backendURL: $backendURL,
                accountUsername: $accountUsername,
                accountPassword: $accountPassword,
                accessUsername: $accessUsername,
                accessPassword: $accessPassword
            ) {
                model.configure(
                    baseURL: backendURL,
                    accountUsername: accountUsername,
                    accountPassword: accountPassword,
                    accessUsername: accessUsername,
                    accessPassword: accessPassword,
                    forceReauthenticate: true
                )
                showSettings = false
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .onAppear {
            model.configure(
                baseURL: backendURL,
                accountUsername: accountUsername,
                accountPassword: accountPassword,
                accessUsername: accessUsername,
                accessPassword: accessPassword
            )
        }
        .preferredColorScheme(.dark)
    }

    private var modeChooser: some View {
        ZStack {
            Color(red: 0.035, green: 0.055, blue: 0.065).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("RO SIGHT")
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .tracking(2.4)
                            .foregroundStyle(.mint)
                        Text("Chọn chế độ camera")
                            .font(.system(size: 27, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white)
                    }
                    Spacer()
                    settingsButton
                }

                Text("Chọn nguồn hình ảnh trước khi bật cảm biến. Chế độ ESP32 không mở camera iPhone.")
                    .font(.system(size: 14, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.68))

                modeCard(
                    title: "Kết nối ESP32",
                    subtitle: "Xem JPEG, trạng thái hoạt động và ToF từ thiết bị; hỏi Vision về frame mới.",
                    symbol: "cpu",
                    tint: .orange
                ) {
                    selectMode(.device)
                }

                modeCard(
                    title: "Chỉ dùng iPhone",
                    subtitle: "Dùng camera sau và ARKit LiDAR trên iPhone 12 Pro trở lên; không cần ESP32.",
                    symbol: "iphone.gen3",
                    tint: .mint
                ) {
                    selectMode(.phone)
                }

                Spacer(minLength: 0)
                Text("Cần backend Ro Sight để chạy YOLO hoặc gửi câu hỏi tới Vision. Camera iPhone chỉ khởi động khi chọn chế độ iPhone.")
                    .font(.system(size: 11, weight: .regular, design: .rounded))
                    .foregroundStyle(.white.opacity(0.48))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(22)
        }
    }

    private func modeCard(
        title: String,
        subtitle: String,
        symbol: String,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 15) {
                Image(systemName: symbol)
                    .font(.system(size: 21, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 48, height: 48)
                    .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 16))
                VStack(alignment: .leading, spacing: 5) {
                    Text(title)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                    Text(subtitle)
                        .font(.system(size: 12, weight: .regular, design: .rounded))
                        .foregroundStyle(.white.opacity(0.65))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.right")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(tint)
            }
            .padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 21))
            .overlay {
                RoundedRectangle(cornerRadius: 21).stroke(.white.opacity(0.12), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint(subtitle)
    }

    private var phoneModeContent: some View {
        ZStack {
            LiDARCameraPreview(model: model)
                .ignoresSafeArea()

            LinearGradient(
                colors: [.black.opacity(0.48), .clear, .black.opacity(0.9)],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 14) {
                phoneHeader
                Spacer(minLength: 80)
                distanceReadout
                Spacer(minLength: 16)
                phoneControlPanel
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 8)
        }
    }

    private var phoneHeader: some View {
        HStack {
            Button {
                selectMode(nil)
            } label: {
                Image(systemName: "square.grid.2x2")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 42, height: 42)
                    .background(.black.opacity(0.55), in: Circle())
            }
            .accessibilityLabel("Chọn chế độ camera")

            VStack(alignment: .leading, spacing: 5) {
                Text("RO SIGHT")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .tracking(2.4)
                    .foregroundStyle(.white.opacity(0.7))
                Text("Chỉ dùng iPhone")
                    .font(.system(size: 18, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
            }
            Spacer(minLength: 6)
            HStack(spacing: 6) {
                Circle()
                    .fill(model.centerDistance == nil ? .orange : .mint)
                    .frame(width: 7, height: 7)
                Text("LiDAR")
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .background(.black.opacity(0.55), in: Capsule())
            settingsButton
        }
    }

    private var settingsButton: some View {
        Button {
            showSettings = true
        } label: {
            Image(systemName: "slider.horizontal.3")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .background(.black.opacity(0.55), in: Circle())
        }
        .accessibilityLabel("Cài đặt backend")
    }

    private var distanceReadout: some View {
        VStack(spacing: 7) {
            Image(systemName: "scope")
                .font(.system(size: 25, weight: .light))
                .foregroundStyle(.mint)
            Text(model.centerDistance.map { String(format: "%.2f m", $0) } ?? "—")
                .font(.system(size: 44, weight: .medium, design: .rounded).monospacedDigit())
                .foregroundStyle(.white)
            Text("KHOẢNG CÁCH Ở TÂM KHUNG HÌNH")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .tracking(1.5)
                .foregroundStyle(.white.opacity(0.72))
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 15)
        .background(.black.opacity(0.52), in: RoundedRectangle(cornerRadius: 22))
        .overlay {
            RoundedRectangle(cornerRadius: 22).stroke(.white.opacity(0.13), lineWidth: 1)
        }
    }

    private var phoneControlPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.detectionEnabled ? "YOLO ĐANG CHẠY" : "YOLO ĐANG TẠM DỪNG")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .tracking(1)
                        .foregroundStyle(model.detectionEnabled ? .mint : .white.opacity(0.65))
                    Text(model.status)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.78))
                        .lineLimit(2)
                }
                Spacer(minLength: 10)
                Button {
                    if backendURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || accountUsername.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || accountPassword.isEmpty {
                        showSettings = true
                    } else {
                        model.detectionEnabled.toggle()
                    }
                } label: {
                    Image(systemName: model.detectionEnabled ? "pause.fill" : "play.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.black)
                        .frame(width: 42, height: 42)
                        .background(.mint, in: Circle())
                }
                .accessibilityLabel(model.detectionEnabled ? "Tạm dừng YOLO" : "Bật YOLO")
            }

            if !model.detections.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.detections) { item in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(item.label.capitalized)
                                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                                    .foregroundStyle(.white)
                                Text(item.distanceMeters.map {
                                    String(format: "≈ %.2f m · %.0f%%", $0, item.confidence * 100)
                                } ?? String(format: "LiDAR chưa rõ · %.0f%%", item.confidence * 100))
                                .font(.system(size: 10, weight: .medium, design: .rounded))
                                .foregroundStyle(.mint.opacity(0.9))
                            }
                            .padding(.horizontal, 11)
                            .padding(.vertical, 9)
                            .background(.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 14))
                        }
                    }
                }
            } else {
                Text("Vật thể YOLO và khoảng cách LiDAR sẽ xuất hiện tại đây.")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.55))
            }

            HStack(spacing: 9) {
                TextField("Hỏi về khung hình hiện tại…", text: $phoneQuestion, axis: .vertical)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .lineLimit(1...3)
                    .textInputAutocapitalization(.sentences)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 10)
                    .background(.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
                Button {
                    phoneAskTask?.cancel()
                    phoneAskTask = Task { await model.ask(question: phoneQuestion) }
                } label: {
                    if model.isAsking {
                        ProgressView().tint(.black)
                            .frame(width: 43, height: 43)
                            .background(.mint, in: Circle())
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.black)
                            .frame(width: 43, height: 43)
                            .background(.mint, in: Circle())
                    }
                }
                .disabled(model.isAsking || !model.phoneHasFreshFrame || phoneQuestion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Hỏi Vision LLM về ảnh iPhone")
            }

            if !model.answer.isEmpty {
                Text(model.answer)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(11)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
            }

            Text("Ảnh do camera iPhone chụp; ARKit LiDAR ghép khoảng cách tại tâm bbox YOLO. Số đo cần kiểm tra thực tế.")
                .font(.system(size: 10, weight: .regular, design: .rounded))
                .foregroundStyle(.white.opacity(0.48))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(15)
        .background(.black.opacity(0.73), in: RoundedRectangle(cornerRadius: 24))
        .overlay {
            RoundedRectangle(cornerRadius: 24).stroke(.white.opacity(0.12), lineWidth: 1)
        }
    }

    private var deviceModeContent: some View {
        ZStack {
            Color(red: 0.035, green: 0.055, blue: 0.065).ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 15) {
                    HStack(spacing: 11) {
                        Button {
                            selectMode(nil)
                        } label: {
                            Image(systemName: "arrow.left")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 42, height: 42)
                                .background(.white.opacity(0.1), in: Circle())
                        }
                        .accessibilityLabel("Chọn chế độ camera")
                        VStack(alignment: .leading, spacing: 4) {
                            Text("RO SIGHT · ESP32")
                                .font(.system(size: 10, weight: .bold, design: .rounded))
                                .tracking(1.6)
                                .foregroundStyle(.mint)
                            Text("Camera thiết bị")
                                .font(.system(size: 21, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white)
                        }
                        Spacer(minLength: 0)
                        settingsButton
                    }

                    HStack(spacing: 10) {
                        Circle()
                            .fill(model.deviceCameraReady ? .mint : .orange)
                            .frame(width: 8, height: 8)
                        Text(deviceStateLabel)
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .tracking(0.6)
                            .foregroundStyle(.white)
                        Spacer(minLength: 0)
                        if model.deviceConnection?.deviceConnected == true {
                            Text(model.deviceConnection?.transport == "firmware_wifi" ? "Wi-Fi firmware" : "Bridge USB")
                                .font(.system(size: 10, weight: .medium, design: .rounded))
                                .foregroundStyle(.white.opacity(0.58))
                        }
                    }
                    .padding(13)
                    .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 17))

                    VStack(spacing: 10) {
                        if model.deviceCameraReady,
                           let data = model.deviceFrameData,
                           let uiImage = UIImage(data: data) {
                            Image(uiImage: uiImage)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity)
                                .frame(maxHeight: 300)
                                .clipShape(RoundedRectangle(cornerRadius: 18))
                            Text("JPEG ESP32 · khung \(model.deviceFrameSequence ?? 0) · frame mới đã xác nhận")
                                .font(.system(size: 10, weight: .medium, design: .rounded))
                                .foregroundStyle(.white.opacity(0.58))
                        } else {
                            VStack(spacing: 9) {
                                Image(systemName: model.deviceOperationEnabled == false ? "pause.circle" : "camera")
                                    .font(.system(size: 29, weight: .light))
                                    .foregroundStyle(.mint)
                                Text(model.deviceStatusMessage)
                                    .font(.system(size: 13, weight: .medium, design: .rounded))
                                    .foregroundStyle(.white.opacity(0.75))
                                    .multilineTextAlignment(.center)
                            }
                            .frame(maxWidth: .infinity, minHeight: 180)
                            .padding(15)
                            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
                        }
                    }

                    if !model.deviceDetections.isEmpty {
                        VStack(alignment: .leading, spacing: 9) {
                            sectionLabel("YOLO KHỚP VỚI FRAME")
                            ForEach(Array(model.deviceDetections.enumerated()), id: \.offset) { entry in
                                let item = entry.element
                                HStack {
                                    Text(item.displayLabel)
                                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                                        .foregroundStyle(.white)
                                    Spacer()
                                    if let confidence = item.confidence {
                                        Text(String(format: "%.0f%%", confidence * 100))
                                            .font(.system(size: 11, weight: .medium, design: .rounded).monospacedDigit())
                                            .foregroundStyle(.mint)
                                    }
                                }
                                .padding(11)
                                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 13))
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        sectionLabel("TOF ESP32 · TRÁI / GIỮA / PHẢI")
                        if model.deviceZones.isEmpty {
                            Text("Chưa có số đo ToF hợp lệ, mới và xác nhận từ thiết bị.")
                                .font(.system(size: 12, weight: .regular, design: .rounded))
                                .foregroundStyle(.white.opacity(0.55))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 13))
                        } else {
                            HStack(spacing: 8) {
                                ForEach(model.deviceZones) { zone in
                                    VStack(spacing: 5) {
                                        Text(zoneLabel(zone.zone))
                                            .font(.system(size: 10, weight: .bold, design: .rounded))
                                            .foregroundStyle(.white.opacity(0.6))
                                        Text(zone.tofValid ? zone.nearestCm.map { String(format: "%.0f cm", $0) } ?? "—" : "—")
                                            .font(.system(size: 14, weight: .semibold, design: .rounded).monospacedDigit())
                                            .foregroundStyle(zone.tofValid ? .mint : .white.opacity(0.45))
                                    }
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 11)
                                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 13))
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        sectionLabel("HỎI VISION VỀ FRAME MỚI")
                        Text("Backend lấy JPEG mới trực tiếp từ ESP32 rồi kiểm tra lại trạng thái hoạt động và độ mới trước khi gửi tới Vision.")
                            .font(.system(size: 11, weight: .regular, design: .rounded))
                            .foregroundStyle(.white.opacity(0.56))
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 9) {
                            TextField("Ví dụ: Trước camera có vật cản gì?", text: $deviceQuestion, axis: .vertical)
                                .font(.system(size: 13, weight: .medium, design: .rounded))
                                .lineLimit(1...3)
                                .textInputAutocapitalization(.sentences)
                                .padding(.horizontal, 13)
                                .padding(.vertical, 10)
                                .background(.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
                            Button {
                                deviceAskTask?.cancel()
                                deviceAskTask = Task { await model.askAboutDevice(question: deviceQuestion) }
                            } label: {
                                if model.isDeviceAsking {
                                    ProgressView().tint(.black)
                                        .frame(width: 43, height: 43)
                                        .background(.mint, in: Circle())
                                } else {
                                    Image(systemName: "arrow.up")
                                        .font(.system(size: 15, weight: .bold))
                                        .foregroundStyle(.black)
                                        .frame(width: 43, height: 43)
                                        .background(.mint, in: Circle())
                                }
                            }
                            .disabled(!model.deviceCanAsk || deviceQuestion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityLabel("Hỏi Vision về ảnh ESP32")
                        }
                        if model.deviceVisionReady == false {
                            Text("Vision chưa sẵn sàng trên máy chủ.")
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundStyle(.orange)
                        } else if let provider = model.deviceVisionProvider {
                            Text(provider == "ollama" ? "Vision chạy cục bộ trên máy chủ." : "Vision dùng provider OpenAI đã cấu hình trên máy chủ.")
                                .font(.system(size: 10, weight: .regular, design: .rounded))
                                .foregroundStyle(.white.opacity(0.48))
                        }
                        if let error = model.deviceAskError {
                            Text(error)
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if !model.deviceAnswer.isEmpty {
                            VStack(alignment: .leading, spacing: 7) {
                                Text("TRẢ LỜI VỀ KHUNG \(model.deviceAnswerFrameSequence.map { String($0) } ?? "MỚI NHẤT")")
                                    .font(.system(size: 9, weight: .bold, design: .rounded))
                                    .tracking(1)
                                    .foregroundStyle(.mint)
                                Text(model.deviceAnswer)
                                    .font(.system(size: 13, weight: .medium, design: .rounded))
                                    .foregroundStyle(.white)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 15))
                        }
                    }

                    Text("Chỉ hoạt động khi `operation_enabled` được xác nhận là true. Ảnh cũ bị ẩn khi thiết bị tạm dừng hoặc frame hết hạn.")
                        .font(.system(size: 10, weight: .regular, design: .rounded))
                        .foregroundStyle(.white.opacity(0.45))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 17)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .task {
            while !Task.isCancelled {
                await model.refreshDeviceStatus()
                if Task.isCancelled { break }
                do {
                    try await Task.sleep(nanoseconds: 250_000_000)
                } catch {
                    break
                }
            }
        }
        .onDisappear {
            model.clearDevicePreview()
        }
    }

    private var deviceStateLabel: String {
        if model.deviceCameraReady { return "FRAME MỚI · HOẠT ĐỘNG" }
        if model.deviceOperationEnabled == false { return "THIẾT BỊ TẠM DỪNG" }
        if model.deviceOperationEnabled == nil { return "CHỜ TRẠNG THÁI ESP32" }
        return model.deviceConnection?.deviceConnected == true ? "CHỜ FRAME MỚI" : "CHỜ ESP32"
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .bold, design: .rounded))
            .tracking(1.25)
            .foregroundStyle(.mint.opacity(0.85))
    }

    private func zoneLabel(_ zone: String) -> String {
        switch zone {
        case "left": return "TRÁI"
        case "center": return "GIỮA"
        case "right": return "PHẢI"
        default: return zone.uppercased()
        }
    }

    private func selectMode(_ mode: RoSightMode?) {
        if selectedMode == .phone, mode != .phone {
            phoneAskTask?.cancel()
            phoneAskTask = nil
            model.stopPhoneMode()
        }
        if selectedMode == .device, mode != .device {
            deviceAskTask?.cancel()
            deviceAskTask = nil
            model.cancelDeviceAsk()
            model.clearDevicePreview()
        }
        if selectedMode != .phone, mode == .phone {
            model.startPhoneMode()
        }
        selectedMode = mode
    }
}

private struct BackendSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var backendURL: String
    @Binding var accountUsername: String
    @Binding var accountPassword: String
    @Binding var accessUsername: String
    @Binding var accessPassword: String
    let onSave: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Flask trên máy tính") {
                    TextField("https://ten-tunnel.ngrok-free.app", text: $backendURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section("Tài khoản Ro Sight") {
                    TextField("Tên đăng nhập app", text: $accountUsername)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Mật khẩu tài khoản (chỉ giữ trong phiên này)", text: $accountPassword)
                }
                Section("Basic Auth của tunnel (nếu có)") {
                    TextField("Tên đăng nhập tunnel", text: $accessUsername)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Mật khẩu tunnel (chỉ giữ trong phiên này)", text: $accessPassword)
                }
                Section {
                    Text("Đăng nhập bằng tài khoản đã tạo trong Ro Sight. Nếu dùng Wi‑Fi nội bộ, nhập IP LAN và cổng Flask. Nếu dùng tunnel có Basic Auth, nhập thêm thông tin tunnel ở trên. Không nhập 127.0.0.1 trên iPhone.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Kết nối backend")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Đóng") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Lưu") { onSave() }
                }
            }
        }
    }
}
