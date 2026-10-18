import SwiftUI
import UIKit

private enum RoSightMode: Equatable {
    case device
    case phone
}

struct CameraScreen: View {
    @StateObject private var model = CameraModel()
    @StateObject private var bluetoothTransport = BLEDeviceTransport()
    @AppStorage("roSight.backendURL") private var backendURL = ""
    @AppStorage("roSight.phoneProximityAlertsEnabled") private var phoneProximityAlertsEnabled = true
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
    @State private var deviceControlTask: Task<Void, Never>?
    @State private var deviceSpeechTask: Task<Void, Never>?
    @State private var requestedDeviceVolume = 50.0

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
                deviceSpeechTask?.cancel()
                deviceSpeechTask = nil
                model.cancelDeviceSpeech()
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
            let cameraModel = model
            bluetoothTransport.onButtonEvent = { event in
                cameraModel.receiveBLEButtonEvent(event)
            }
            bluetoothTransport.lastHandledPressID = { deviceID, bootID in
                cameraModel.lastHandledBLEPressID(deviceID: deviceID, bootID: bootID)
            }
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
                    tint: .orange,
                    identifier: "mode.device"
                ) {
                    selectMode(.device)
                }

                modeCard(
                    title: "Chỉ dùng iPhone",
                    subtitle: "Camera sau và ARKit sceneDepth khi iPhone hỗ trợ; không cần ESP32.",
                    symbol: "iphone.gen3",
                    tint: .mint,
                    identifier: "mode.phone"
                ) {
                    selectMode(.phone)
                }

                Spacer(minLength: 0)
                Text("YOLO trên Flask chỉ dùng cho prototype camera iPhone. ESP32 cần model FOMO chạy cục bộ; camera iPhone chỉ khởi động khi chọn chế độ iPhone.")
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
        identifier: String,
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
        .accessibilityIdentifier(identifier)
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
            .task {
                while !Task.isCancelled {
                    model.refreshPhoneFreshness()
                    do {
                        try await Task.sleep(nanoseconds: 250_000_000)
                    } catch {
                        break
                    }
                }
            }
            .onAppear {
                model.setPhoneProximityAlertsEnabled(phoneProximityAlertsEnabled)
            }
            .onChange(of: phoneProximityAlertsEnabled) { enabled in
                model.setPhoneProximityAlertsEnabled(enabled)
            }
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
                    .frame(width: 48, height: 48)
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
                    .fill(model.phoneSceneDepthSupported == true && model.centerDistance != nil ? .mint : .orange)
                    .frame(width: 7, height: 7)
                Text(phoneDepthStatusLabel)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .background(.black.opacity(0.55), in: Capsule())
            .accessibilityElement(children: .combine)
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
                .frame(width: 48, height: 48)
                .background(.black.opacity(0.55), in: Circle())
        }
        .accessibilityLabel("Cài đặt backend")
    }

    private func answerSpeechControl(for text: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Button {
                if model.isSpeakingAnswer {
                    model.stopSpeakingAnswer()
                } else {
                    model.speakAnswer(text)
                }
            } label: {
                Label(
                    model.isSpeakingAnswer ? "Dừng đọc" : "Đọc câu trả lời",
                    systemImage: model.isSpeakingAnswer ? "stop.fill" : "speaker.wave.2.fill"
                )
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(.black)
                .frame(minHeight: 44)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(.mint, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Phát giọng nói bằng loa iPhone; không dùng loa ESP32.")

            Text(model.isSpeakingAnswer
                 ? "Đang phát âm thanh từ iPhone."
                 : "Đọc qua iPhone; loa ESP32 không tham gia.")
                .font(.system(size: 9, weight: .regular, design: .rounded))
                .foregroundStyle(.white.opacity(0.52))

            if let speechError = model.speechError {
                Text(speechError)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
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
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Khoảng cách LiDAR tại tâm khung hình")
        .accessibilityIdentifier("phone.distance.readout")
        .accessibilityValue(model.centerDistance.map { String(format: "%.2f mét", $0) } ?? "Chưa có số đo mới")
        .accessibilityHint("Số đo sceneDepth là ước tính; app không dùng số đo này để khẳng định lối đi an toàn.")
        .padding(.horizontal, 20)
        .padding(.vertical, 15)
        .background(.black.opacity(0.52), in: RoundedRectangle(cornerRadius: 22))
        .overlay {
            RoundedRectangle(cornerRadius: 22).stroke(.white.opacity(0.13), lineWidth: 1)
        }
    }

    private var phoneControlPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle(isOn: $phoneProximityAlertsEnabled) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Đọc cảnh báo khoảng cách")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                    Text("iPhone sẽ đọc số đo tâm dưới 0,8 m; phát lại sau khi vượt 1,05 m.")
                        .font(.system(size: 10, weight: .regular, design: .rounded))
                        .foregroundStyle(.white.opacity(0.65))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .tint(.mint)
            .accessibilityLabel("Cảnh báo khoảng cách LiDAR trên iPhone")
            .accessibilityValue(phoneProximityAlertsEnabled ? "Bật" : "Tắt")
            .accessibilityHint("Chỉ đọc số đo sceneDepth mới tại tâm khung hình. Cảnh báo không phân loại vật cản hoặc lối đi.")

            Text(model.phoneProximityAlertStatus)
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.7))
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.phoneDetectionsFresh
                         ? "YOLO FLASK · KẾT QUẢ MỚI"
                         : model.isDetecting
                           ? "ĐANG CHỜ YOLO FLASK"
                           : model.detectionEnabled ? "YOLO FLASK ĐANG BẬT" : "YOLO FLASK TẠM DỪNG")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .tracking(1)
                        .foregroundStyle(model.phoneDetectionsFresh ? .mint : model.detectionEnabled ? .orange : .white.opacity(0.65))
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
                        model.setPhoneDetectionEnabled(!model.detectionEnabled)
                    }
                } label: {
                    Image(systemName: model.detectionEnabled ? "pause.fill" : "play.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.black)
                        .frame(width: 48, height: 48)
                        .background(.mint, in: Circle())
                }
                .accessibilityLabel(model.detectionEnabled ? "Tạm dừng gửi khung camera iPhone tới YOLO server Flask" : "Bật YOLO server Flask cho camera iPhone")
            }

            if model.phoneDetectionsFresh, !model.detections.isEmpty {
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
                Text("Box YOLO Flask dùng tọa độ theo tỷ lệ của ảnh; app lấy depth từ cùng frame iPhone. Nếu thiếu depth tin cậy thì không hiện khoảng cách. Kết quả cũ tự ẩn.")
                    .font(.system(size: 9, weight: .regular, design: .rounded))
                    .foregroundStyle(.white.opacity(0.5))
            } else if model.phoneDetectionsFresh {
                Text("YOLO server chưa thấy vật thể rõ trong frame iPhone mới.")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.55))
            } else {
                Text(model.detectionEnabled ? "Đang chờ kết quả YOLO server từ frame iPhone mới." : "Bật YOLO server cho camera iPhone; kết quả cũ sẽ tự ẩn.")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.55))
            }

            Text(model.phoneDetectorStatusMessage)
                .font(.system(size: 10, weight: .regular, design: .rounded))
                .foregroundStyle(.white.opacity(0.5))
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 9) {
                TextField("Hỏi về khung hình hiện tại…", text: $phoneQuestion, axis: .vertical)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .lineLimit(1...3)
                    .textInputAutocapitalization(.sentences)
                    .accessibilityLabel("Câu hỏi về hình ảnh iPhone")
                    .accessibilityHint("Dùng mic Dictation trên bàn phím nếu muốn nói câu hỏi. App chỉ gửi phần chữ.")
                    .padding(.horizontal, 13)
                    .padding(.vertical, 10)
                    .background(.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
                Button {
                    phoneAskTask?.cancel()
                    phoneAskTask = Task { await model.ask(question: phoneQuestion) }
                } label: {
                    if model.isAsking {
                        ProgressView().tint(.black)
                            .frame(width: 48, height: 48)
                            .background(.mint, in: Circle())
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.black)
                            .frame(width: 48, height: 48)
                            .background(.mint, in: Circle())
                    }
                }
                .disabled(model.isAsking || !model.phoneFrameFresh || phoneQuestion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Hỏi Vision LLM về ảnh iPhone")
            }
            Text("Chạm mic Dictation trên bàn phím iPhone để nói; app gửi phần chữ, không gửi bản ghi âm.")
                .font(.system(size: 10, weight: .regular, design: .rounded))
                .foregroundStyle(.white.opacity(0.55))
            Text(model.phoneFrameFresh ? "Khung camera mới sẵn sàng để hỏi." : "Đang chờ khung camera mới; thao tác hỏi đang khóa.")
                .font(.system(size: 10, weight: .regular, design: .rounded))
                .foregroundStyle(model.phoneFrameFresh ? .mint.opacity(0.8) : .orange.opacity(0.85))

            if !model.answer.isEmpty {
                VStack(alignment: .leading, spacing: 9) {
                    Text(model.answer)
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                    answerSpeechControl(for: model.answer)
                }
                .padding(11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
            }

            Text("Ảnh từ camera iPhone; ARKit sceneDepth được dùng khi có dữ liệu. Khoảng cách là ước tính và cần kiểm tra thực tế.")
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
                                .frame(width: 48, height: 48)
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

                    BLEDevicePanel(transport: bluetoothTransport)

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
                    if let message = model.deviceButtonMessage {
                        Text(message)
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(.mint)
                            .fixedSize(horizontal: false, vertical: true)
                    }

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

                    if let error = model.deviceCaptureError {
                        Text(error)
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if model.isCapturingDeviceFrame {
                        ProgressView("Đang lấy JPEG từ nút chụp…")
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .tint(.mint)
                    }
                    if let data = model.deviceCapturedFrameData,
                       let uiImage = UIImage(data: data) {
                        VStack(alignment: .leading, spacing: 9) {
                            sectionLabel("ẢNH ĐÃ CHỤP TỪ NÚT")
                            Image(uiImage: uiImage)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity)
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                            Text("JPEG \(model.deviceCapturedFrameSequence ?? 0) · press #\(model.deviceCapturedFramePressId ?? 0) · giữ trong phiên app; không gọi Vision")
                                .font(.system(size: 10, weight: .medium, design: .rounded))
                                .foregroundStyle(.white.opacity(0.55))
                        }
                        .padding(12)
                        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 17))
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        sectionLabel(model.deviceFomoOutputForCurrentFrame
                                     ? "FOMO ESP32 · FRAME MỚI"
                                     : "FOMO CỤC BỘ ESP32 · ĐANG CHỜ")
                        if model.deviceFomoOutputForCurrentFrame, !model.deviceDetections.isEmpty {
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
                        } else {
                            Text(model.deviceFomoStatusMessage)
                                .font(.system(size: 12, weight: .regular, design: .rounded))
                                .foregroundStyle(.white.opacity(0.65))
                                .fixedSize(horizontal: false, vertical: true)
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
                        sectionLabel("FUSION · FRAME VÀ TOF")
                        if let decision = model.deviceCorridorDecision {
                            Text(fusionRiskLabel(decision.risk))
                                .font(.system(size: 15, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white)
                            if let zone = decision.recommendedZone, zone != "unknown" {
                                Text("Vùng firmware đề xuất: \(fusionZoneLabel(zone)).")
                                    .font(.system(size: 12, weight: .medium, design: .rounded))
                                    .foregroundStyle(.mint)
                            }
                            Text("Frame fusion \(decision.frameSeq ?? 0) · ToF event \(decision.tofSeq.map { String($0) } ?? "không có") · cùng phiên firmware")
                                .font(.system(size: 10, weight: .medium, design: .rounded))
                                .foregroundStyle(.white.opacity(0.58))
                        } else if model.deviceConnection?.transport != "firmware_wifi" {
                            Text("USB bridge hiện chưa cung cấp fusion đã xác nhận; trạng thái là unknown.")
                                .font(.system(size: 12, weight: .regular, design: .rounded))
                                .foregroundStyle(.white.opacity(0.62))
                        } else {
                            Text(model.deviceOperationEnabled == false
                                 ? "Thiết bị tạm dừng nên chưa có quyết định fusion mới."
                                 : "Chưa có quyết định fusion mới, còn hạn và cùng phiên; giữ trạng thái unknown.")
                                .font(.system(size: 12, weight: .regular, design: .rounded))
                                .foregroundStyle(.white.opacity(0.62))
                        }
                        Text("Trạng thái fusion của firmware không xác nhận lối đi an toàn.")
                            .font(.system(size: 10, weight: .regular, design: .rounded))
                            .foregroundStyle(.white.opacity(0.48))
                    }
                    .padding(13)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 17))

                    VStack(alignment: .leading, spacing: 10) {
                        sectionLabel("ĐIỀU KHIỂN ĐƯỢC FIRMWARE HỖ TRỢ")
                        Text("Chỉ Wi-Fi firmware trực tiếp nhận lệnh âm lượng và bật/tắt cảnh báo. USB bridge chỉ đọc; cài đặt không bật MODE.")
                            .font(.system(size: 11, weight: .regular, design: .rounded))
                            .foregroundStyle(.white.opacity(0.6))
                            .fixedSize(horizontal: false, vertical: true)
                        Stepper("Âm lượng gửi · \(Int(requestedDeviceVolume))%", value: $requestedDeviceVolume, in: 0...100, step: 5)
                            .disabled(!model.deviceCanControl || model.isSendingDeviceControl)
                            .accessibilityHint("Gửi cài đặt set volume tới firmware; đây không phải số đo âm lượng hiện tại.")
                        Button {
                            deviceControlTask?.cancel()
                            deviceControlTask = Task {
                                await model.sendDeviceControl(command: "set_volume", volume: Int(requestedDeviceVolume))
                            }
                        } label: {
                            Label(model.isSendingDeviceControl ? "Đang gửi lệnh…" : "Gửi âm lượng", systemImage: "slider.horizontal.3")
                                .font(.system(size: 13, weight: .semibold, design: .rounded))
                                .foregroundStyle(.black)
                                .frame(maxWidth: .infinity, minHeight: 50)
                                .background(.mint, in: RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
                        .disabled(!model.deviceCanControl || model.isSendingDeviceControl)
                        .accessibilityLabel("Gửi mức âm lượng tới ESP32")

                        HStack(spacing: 9) {
                            deviceAlertControlButton(title: "Bật cảnh báo", enabled: true)
                            deviceAlertControlButton(title: "Tắt cảnh báo", enabled: false)
                        }
                        if !model.deviceCanControl {
                            Text("\(model.deviceControlUnavailableMessage) Firmware chưa có lệnh bật MODE từ xa.")
                                .font(.system(size: 10, weight: .regular, design: .rounded))
                                .foregroundStyle(.orange.opacity(0.9))
                        }
                        if model.deviceOperationEnabled == false {
                            Text("ESP32 vẫn standby; firmware ACK cài đặt không có nghĩa thiết bị đã bắt đầu hoạt động.")
                                .font(.system(size: 10, weight: .regular, design: .rounded))
                                .foregroundStyle(.orange.opacity(0.9))
                        }
                        Text("ACK chỉ xác nhận firmware nhận lệnh; chưa xác nhận loa, cảm biến hoặc cảnh báo hoạt động. Firmware hiện không báo lại giá trị cài đặt hiện tại.")
                            .font(.system(size: 10, weight: .regular, design: .rounded))
                            .foregroundStyle(.white.opacity(0.5))
                            .fixedSize(horizontal: false, vertical: true)
                        if let error = model.deviceControlError {
                            Text(error)
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.isStaticText)
                        }
                        if let message = model.deviceControlMessage {
                            Text(message)
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundStyle(.mint)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.isStaticText)
                        }
                    }
                    .padding(13)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 17))

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
                                        .frame(width: 48, height: 48)
                                        .background(.mint, in: Circle())
                                } else {
                                    Image(systemName: "arrow.up")
                                        .font(.system(size: 15, weight: .bold))
                                        .foregroundStyle(.black)
                                        .frame(width: 48, height: 48)
                                        .background(.mint, in: Circle())
                                }
                            }
                            .disabled(!model.deviceCanAsk || deviceQuestion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityLabel("Hỏi Vision về ảnh ESP32")
                        }
            Text("Chạm mic Dictation trên bàn phím iPhone để nói; app gửi phần chữ, không gửi bản ghi âm.")
                            .font(.system(size: 10, weight: .regular, design: .rounded))
                            .foregroundStyle(.white.opacity(0.52))
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
                                Text("TRẢ LỜI VỀ KHUNG \(model.deviceAnswerFrameSequence.map { String($0) } ?? "MỚI NHẤT")\(model.deviceAnswerButtonSourceLabel)")
                                    .font(.system(size: 9, weight: .bold, design: .rounded))
                                    .tracking(1)
                                    .foregroundStyle(.mint)
                                Text(model.deviceAnswer)
                                    .font(.system(size: 13, weight: .medium, design: .rounded))
                                    .foregroundStyle(.white)
                                    .fixedSize(horizontal: false, vertical: true)
                                answerSpeechControl(for: model.deviceAnswer)
                                Button {
                                    deviceSpeechTask = Task {
                                        await model.sendAnswerToDeviceSpeaker(model.deviceAnswer)
                                    }
                                } label: {
                                    Label(
                                        model.isSendingDeviceSpeech ? "Đang gửi tới loa…" : "Nói qua loa ESP32",
                                        systemImage: "antenna.radiowaves.left.and.right"
                                    )
                                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 9)
                                    .background(.white.opacity(0.12), in: Capsule())
                                }
                                .buttonStyle(.plain)
                                .disabled(!model.deviceSpeakerReady || model.isSendingDeviceSpeech)
                                .accessibilityHint("Tạo PCM trên iPhone rồi chuyển qua Flask tới firmware ESP32; chỉ phát khi loa và trạng thái MODE đã được xác minh.")
                                Text("Tối đa 8 giây, gửi qua Flask; rời mode sẽ hủy tác vụ còn tại app. Firmware có thể phát hết PCM đã nhận; không dùng micro ESP32.")
                                    .font(.system(size: 9, weight: .regular, design: .rounded))
                                    .foregroundStyle(.white.opacity(0.5))
                                Text(model.deviceSpeakerMessage ?? model.deviceSpeakerUnavailableMessage)
                                    .font(.system(size: 10, weight: .regular, design: .rounded))
                                    .foregroundStyle(model.deviceSpeakerReady ? .mint : .orange)
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
        .task {
            while !Task.isCancelled {
                model.refreshDeviceFreshness()
                do {
                    try await Task.sleep(nanoseconds: 100_000_000)
                } catch {
                    break
                }
            }
        }
        .onDisappear {
            model.clearDevicePreview()
        }
    }

    private var phoneDepthStatusLabel: String {
        switch model.phoneSceneDepthSupported {
        case .some(false):
            return "sceneDepth không hỗ trợ"
        case .some(true):
            return model.centerDistance == nil ? "LiDAR · chờ dữ liệu" : "LiDAR · có dữ liệu"
        case .none:
            return "LiDAR · kiểm tra"
        }
    }

    private func deviceAlertControlButton(title: String, enabled: Bool) -> some View {
        Button {
            deviceControlTask?.cancel()
            deviceControlTask = Task {
                await model.sendDeviceControl(command: "set_alerts", alertsEnabled: enabled)
            }
        } label: {
            Text(title)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(enabled ? .black : .white)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(enabled ? Color.mint : Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .disabled(!model.deviceCanControl || model.isSendingDeviceControl)
        .accessibilityLabel("\(title) trên ESP32")
        .accessibilityHint("Gửi lệnh cấu hình tới firmware Wi-Fi. ACK không xác nhận loa hoặc cảnh báo đang hoạt động.")
    }

    private func fusionRiskLabel(_ risk: String?) -> String {
        switch risk {
        case "clear": return "Firmware fusion: clear"
        case "caution": return "Firmware fusion: cần thận trọng"
        case "stop": return "Firmware fusion: dừng"
        default: return "Firmware fusion: chưa đủ dữ liệu"
        }
    }

    private func fusionZoneLabel(_ zone: String) -> String {
        switch zone {
        case "left": return "trái"
        case "center": return "giữa"
        case "right": return "phải"
        case "stop": return "dừng"
        default: return "chưa xác định"
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
        if selectedMode != mode {
            model.stopSpeakingAnswer()
        }
        if selectedMode == .phone, mode != .phone {
            phoneAskTask?.cancel()
            phoneAskTask = nil
            model.stopPhoneMode()
        }
        if selectedMode == .device, mode != .device {
            bluetoothTransport.suspendDeviceModeConnection()
            deviceAskTask?.cancel()
            deviceAskTask = nil
            deviceControlTask?.cancel()
            deviceControlTask = nil
            deviceSpeechTask?.cancel()
            deviceSpeechTask = nil
            model.cancelDeviceAsk()
            model.cancelDeviceSpeech()
            model.clearDevicePreview()
        }
        if selectedMode != .phone, mode == .phone {
            model.startPhoneMode()
        }
        selectedMode = mode
    }
}

private struct BLEDevicePanel: View {
    @ObservedObject var transport: BLEDeviceTransport

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 9) {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.mint)
                Text("BLUETOOTH · ESP32")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .tracking(0.8)
                    .foregroundStyle(.white)
                Spacer(minLength: 6)
                Text(transport.isContractFresh ? "BLE v1 · LIVE" : transport.isLinkConnected ? "ĐANG XÁC MINH" : "CHƯA KẾT NỐI")
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundStyle(transport.isContractFresh ? .mint : .orange)
            }

            Text(transport.managerMessage)
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.66))
            Text(transport.displayedConnectionMessage)
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.66))

            HStack(spacing: 9) {
                Button {
                    transport.startScan()
                } label: {
                    Label(transport.isScanning ? "Đang quét…" : "Quét ESP32 BLE", systemImage: "magnifyingglass")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(.mint, in: RoundedRectangle(cornerRadius: 13))
                }
                .buttonStyle(.plain)
                .disabled(transport.isScanning || transport.isLinkConnected)
                .accessibilityHint("Tìm thiết bị quảng bá service Ro Sight BLE v1.")

                if transport.isLinkConnected {
                    Button {
                        transport.disconnectByUser()
                    } label: {
                        Label("Ngắt", systemImage: "xmark.circle")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white)
                            .frame(minWidth: 78, minHeight: 44)
                            .background(.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 13))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Ngắt Bluetooth với ESP32")
                }
            }

            if !transport.discoveredDevices.isEmpty {
                VStack(spacing: 7) {
                    ForEach(transport.discoveredDevices) { device in
                        HStack(spacing: 9) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(device.name)
                                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                Text("Tín hiệu \(device.rssi) dBm")
                                    .font(.system(size: 9, weight: .regular, design: .rounded))
                                    .foregroundStyle(.white.opacity(0.5))
                            }
                            Spacer(minLength: 4)
                            let isCurrentPeripheral = transport.connectedPeripheralID == device.id
                            Button(transport.isContractFresh && isCurrentPeripheral ? "BLE v1 live" : isCurrentPeripheral ? "Đang xác minh" : "Kết nối") {
                                transport.connect(to: device.id)
                            }
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundStyle(.mint)
                            .disabled(isCurrentPeripheral)
                            .accessibilityLabel(isCurrentPeripheral
                                ? "Đang xác minh hợp đồng BLE v1 với \(device.name)"
                                : "Kết nối Bluetooth tới \(device.name)")
                        }
                        .padding(10)
                        .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }

            if let identity = transport.identity {
                Text("\(transport.connectedName ?? "ESP32") · device \(identity.deviceId.prefix(8)) · boot \(identity.bootId.prefix(8))")
                    .font(.system(size: 9, weight: .medium, design: .rounded).monospaced())
                    .foregroundStyle(.white.opacity(0.48))
                    .textSelection(.enabled)
            }

            if transport.isContractFresh, let status = transport.status {
                HStack(spacing: 7) {
                    Circle()
                        .fill(status.operationEnabled ? .mint : .orange)
                        .frame(width: 7, height: 7)
                    Text(status.operationEnabled ? "ESP32 đang hoạt động" : "ESP32 đang tạm dừng")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                    Spacer(minLength: 4)
                    Text("status \(transport.statusAgeMs.map { "\($0) ms" } ?? "—")")
                        .font(.system(size: 9, weight: .regular, design: .rounded).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.5))
                }
                .padding(10)
                .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 12))

                Text("Camera \(status.cameraOK ? "sẵn sàng" : "chưa sẵn sàng") · frame #\(status.cameraFrameSeq.map { String($0) } ?? "—") · Wi-Fi \(status.networkOK.map { $0 ? "đang nối" : "mất kết nối" } ?? "chưa rõ")")
                    .font(.system(size: 9, weight: .regular, design: .rounded).monospacedDigit())
                    .foregroundStyle(.white.opacity(0.55))

                if status.zones.isEmpty {
                    Text("ESP32 chưa gửi vùng ToF hợp lệ.")
                        .font(.system(size: 10, weight: .regular, design: .rounded))
                        .foregroundStyle(.white.opacity(0.5))
                } else {
                    HStack(spacing: 7) {
                        ForEach(status.zones) { zone in
                            let fresh = isToFSampleFresh(status)
                            VStack(spacing: 4) {
                                Text(zoneLabel(zone.zone))
                                    .font(.system(size: 9, weight: .bold, design: .rounded))
                                    .foregroundStyle(.white.opacity(0.55))
                                Text(fresh && zone.tofValid
                                     ? zone.nearestCm.map { String(format: "%.0f cm", $0) } ?? "—"
                                     : "—")
                                    .font(.system(size: 12, weight: .semibold, design: .rounded).monospacedDigit())
                                    .foregroundStyle(fresh && zone.tofValid ? .mint : .white.opacity(0.4))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                            .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 11))
                        }
                    }
                }
                Text(isToFSampleFresh(status)
                     ? "ToF trực tiếp qua BLE · đo mới dưới 350 ms · không gắn với vật thể trong ảnh."
                     : "Đang chờ ToF hợp lệ, cùng phiên và mới dưới 350 ms.")
                    .font(.system(size: 9, weight: .regular, design: .rounded))
                    .foregroundStyle(.white.opacity(0.5))
                    .fixedSize(horizontal: false, vertical: true)
            } else if transport.status != nil {
                Text("Status BLE đã cũ hoặc GATT chưa sẵn sàng; đang chờ dữ liệu mới.")
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(.orange.opacity(0.9))
            }

            if transport.isContractFresh, let event = transport.latestButtonEvent {
                Text("Nút BLE gần nhất: \(buttonLabel(event.buttonId)) · press #\(event.pressId). Ảnh và hỏi Vision vẫn cần Wi-Fi.")
                    .font(.system(size: 9, weight: .medium, design: .rounded))
                    .foregroundStyle(.mint.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let replayHistoryMessage = transport.replayHistoryMessage {
                Text(replayHistoryMessage)
                    .font(.system(size: 9, weight: .medium, design: .rounded))
                    .foregroundStyle(transport.replayHistoryNeedsAttention ? .orange : .mint.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(replayHistoryMessage)
            }

            if let error = transport.errorMessage {
                Text(error)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text("BLE dùng cho discovery, status, ToF và nút. FOMO ESP32 đi qua sự kiện detections trên Wi-Fi firmware rồi tới snapshot Flask; YOLO Flask chỉ là prototype camera iPhone. JPEG/video, Vision và PCM loa dùng Wi-Fi/Flask.")
                .font(.system(size: 9, weight: .regular, design: .rounded))
                .foregroundStyle(.white.opacity(0.46))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(13)
        .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 17))
        .onAppear { transport.reconnectSavedDeviceIfAvailable() }
        .task {
            while !Task.isCancelled {
                transport.refreshStatusAge()
                do {
                    try await Task.sleep(nanoseconds: 100_000_000)
                } catch {
                    break
                }
            }
        }
    }

    private func isToFSampleFresh(_ status: BLEDeviceStatus) -> Bool {
        let hasValidZone = status.zones.contains { zone in
            guard zone.tofValid, let distance = zone.nearestCm else { return false }
            return distance.isFinite && (0...100_000).contains(distance)
        }
        guard transport.isContractFresh,
              status.tofOK,
              hasValidZone,
              let statusAge = transport.statusAgeMs,
              let tofAge = status.tofAgeMs else {
            return false
        }
        return Double(statusAge) + Double(tofAge) <= 350
    }

    private func zoneLabel(_ zone: String) -> String {
        switch zone {
        case "left": return "TRÁI"
        case "center": return "GIỮA"
        case "right": return "PHẢI"
        default: return zone.uppercased()
        }
    }

    private func buttonLabel(_ buttonID: String) -> String {
        switch buttonID {
        case "mode": return "MODE"
        case "capture_image": return "CHỤP"
        case "ask_llm": return "HỎI AI"
        default: return buttonID
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
