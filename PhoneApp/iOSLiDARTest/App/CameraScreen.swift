import SwiftUI

struct CameraScreen: View {
    @StateObject private var model = CameraModel()
    @AppStorage("roSight.backendURL") private var backendURL = ""
    @State private var accountUsername = ""
    @State private var accountPassword = ""
    @State private var accessUsername = ""
    @State private var accessPassword = ""
    @State private var question = ""
    @State private var showSettings = false

    var body: some View {
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
                header
                Spacer(minLength: 80)
                distanceReadout
                Spacer(minLength: 16)
                controlPanel
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 8)
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
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 5) {
                Text("RO SIGHT")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .tracking(2.4)
                    .foregroundStyle(.white.opacity(0.7))
                Text("Camera LiDAR")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
            }
            Spacer()
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
            RoundedRectangle(cornerRadius: 22)
                .stroke(.white.opacity(0.13), lineWidth: 1)
        }
    }

    private var controlPanel: some View {
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
                    if !model.detectionEnabled && backendURL.isEmpty {
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
                TextField("Hỏi về khung hình hiện tại…", text: $question, axis: .vertical)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .lineLimit(1...3)
                    .textInputAutocapitalization(.sentences)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 10)
                    .background(.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
                Button {
                    Task { await model.ask(question: question) }
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
                .disabled(model.isAsking || question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Hỏi Vision LLM")
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

            Text("LiDAR ghép khoảng cách tại tâm bbox YOLO; số đo cần kiểm tra thực tế.")
                .font(.system(size: 10, weight: .regular, design: .rounded))
                .foregroundStyle(.white.opacity(0.48))
        }
        .padding(15)
        .background(.black.opacity(0.73), in: RoundedRectangle(cornerRadius: 24))
        .overlay {
            RoundedRectangle(cornerRadius: 24)
                .stroke(.white.opacity(0.12), lineWidth: 1)
        }
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
            .navigationTitle("Kết nối YOLO")
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
