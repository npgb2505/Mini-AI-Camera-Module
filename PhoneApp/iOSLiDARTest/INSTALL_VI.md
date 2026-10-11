# Cài thử Ro Sight miễn phí trên iPhone

Tài liệu này hướng dẫn cài bản native thử nghiệm từ IPA unsigned bằng Windows
và AltServer. App chưa phát hành trên App Store; IPA phải được ký lại bằng
Apple Account của người cài. Cần tải IPA từ artifact GitHub Actions trước khi
bắt đầu.

## Chọn bản PWA hay native

- **PWA:** miễn phí, không cần ký app. Chạy server trên máy tính, mở URL HTTPS
  tạm thời trong Safari iPhone rồi chọn **Chia sẻ → Thêm vào Màn hình chính**.
  PWA dùng camera iPhone nhưng không đọc được ARKit `sceneDepth`; xem hướng dẫn
  chạy điện thoại trong [README của PWA](../../../04_App/ro-app/README.md).
- **Native:** có thể dùng ARKit scene depth trên iPhone 12 Pro, bên cạnh chế độ
  kết nối ESP32. Bản native hiện là app thử nghiệm, không phải bản phát hành.

## 1. Lấy IPA từ GitHub Actions

1. Mở repo GitHub `bartsil/Mini-AI-Camera-Module` và chọn **Actions**.
2. Mở lần chạy thành công của workflow **Build iOS test IPA** trên branch app.
   Workflow tự chạy khi có push thay đổi trong `PhoneApp/iOSLiDARTest/` hoặc
   file workflow.
3. Trong mục **Artifacts**, tải `RoSight-unsigned-ipa` rồi giải nén để lấy
   `RoSight-unsigned.ipa`.

Artifact được lưu ba ngày. Nếu không thấy, workflow chưa chạy thành công hoặc
artifact đã hết hạn; chạy lại workflow sau khi source có trên GitHub.

## 2. Cài AltServer trên Windows

1. Làm theo [hướng dẫn AltStore Classic cho Windows](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows).
   Cài iTunes và iCloud bằng bộ cài tải từ Apple, không dùng gói Microsoft
   Store; cài AltServer for Windows và chạy AltServer bằng quyền Administrator.
2. Cắm iPhone vào máy tính, mở khóa máy và chọn **Trust This Computer** nếu
   iPhone hỏi. Có thể bật Wi-Fi Sync trong iTunes để AltServer nhận điện thoại
   qua cùng mạng Wi-Fi ở những lần sau.
3. Trong thanh tác vụ Windows, giữ **Shift** rồi bấm biểu tượng AltServer.
   Chọn **Sideload .ipa…**, chọn `RoSight-unsigned.ipa`, rồi chọn iPhone.
4. Đăng nhập bằng Apple Account miễn phí khi AltServer yêu cầu để ký app cho
   thiết bị. AltServer có thể cài trực tiếp IPA mà không cần cài AltStore
   trước; xem [hướng dẫn sideload IPA](https://faq.altstore.io/release-notes/altserver).
5. Trên iPhone bật **Settings → Privacy & Security → Developer Mode** nếu iOS
   yêu cầu. Sau khi cài, nếu iPhone yêu cầu tin cậy nhà phát triển, mở
   **Settings → General → VPN & Device Management**, chọn Apple Account của bạn
   và xác nhận **Trust**.

AltStore Classic dùng được qua AltServer. AltStore PAL là phương án phân phối
theo khu vực và không phải đường cài được mô tả ở đây.

## 3. Kết nối app với backend

Mở Ro Sight, vào phần thiết lập và nhập URL Flask backend cùng tài khoản Ro
Sight. `127.0.0.1` trên iPhone trỏ về chính iPhone, nên hãy dùng địa chỉ máy
tính có thể truy cập từ điện thoại hoặc URL HTTPS có xác thực. Nếu tunnel cần
Basic Auth, nhập thông tin tunnel trong trường riêng. Đừng gửi thông tin đăng
nhập qua HTTP trên mạng không tin cậy.

Chế độ **Chỉ dùng iPhone** gửi ảnh và câu hỏi tới `/api/analyze`. Chế độ
**Kết nối ESP32** gửi câu hỏi thủ công tới `/api/device/ask`; backend lấy frame
mới từ thiết bị. Ở cả hai chế độ, kết quả có thể phát qua loa iPhone bằng nút
**Đọc câu trả lời**.

## Mic và giới hạn bản thử

- Muốn hỏi bằng giọng nói, chạm vào ô câu hỏi rồi dùng mic **Dictation** trên
  bàn phím iPhone. Người dùng tự chọn khi nào bật Dictation. App native không
  thu âm nền, không xin quyền microphone và chỉ gửi phần văn bản đã nhập tới
  backend. Cách iOS xử lý Dictation phụ thuộc cài đặt của iPhone.
- PWA có thêm tùy chọn ghi âm trong app khi backend đã cấu hình API phiên âm;
  nếu không, dùng Dictation của iPhone. PWA cần Safari qua HTTPS để truy cập
  camera/microphone.
- Với Apple Account miễn phí, app sideload hết hạn sau bảy ngày. IPA cài trực
  tiếp bằng AltServer cần được cài lại định kỳ bằng cùng máy tính và AltServer.
  Apple giới hạn tối đa ba app sideload đang hoạt động trên thiết
  bị cho tài khoản miễn phí; [FAQ AltStore](https://faq.altstore.io/altstore-classic/your-altstore)
  mô tả gia hạn và giới hạn này.
- IPA từ workflow là **unsigned**; bước cài qua AltServer mới ký cho tài khoản
  và thiết bị của bạn. Build hoặc cài được app không xác nhận LiDAR chính xác,
  hành vi camera/micro, kết nối ESP32 hay độ an toàn khi di chuyển. Cần thử
  trực tiếp trên iPhone và backend của bạn.
