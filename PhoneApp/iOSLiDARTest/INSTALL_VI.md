# Cài và thử Ro Sight miễn phí trên iPhone, không cần Mac

Cần máy Windows để chạy backend/AltServer, iPhone, Internet và Apple Account
miễn phí. Không cần sở hữu Mac. **PWA là đường thử ngay**; native cần một IPA
được build trên runner macOS của GitHub Actions rồi ký trên Windows trước khi
cài.

**Tình trạng ngày 22/10/2026:** PWA cloud hiện chạy bản `voice-vi-v3` trên
Cloudflare với Qwen 3.8 27B, Moondream 3.1 và Whisper Large v3 Turbo. Thoại
PWA dùng Speech Recognition của Safari/iOS (cần bật Siri), truyền câu trả lời
Qwen theo luồng và đọc bằng giọng iPhone. Tài khoản preview là tạm; cần claim
qua link gửi riêng trước hạn để giữ preview.

Native app và workflow đã được đẩy lên fork công khai
`npgb2505/Mini-AI-Camera-Module`; repo gốc vẫn chỉ có quyền đọc. GitHub Actions
run [39811695629](https://github.com/npgb2505/Mini-AI-Camera-Module/actions/runs/39811695629)
đã thành công: 10 kiểm tra depth, 1 UI test vào/ra chế độ iPhone, mở app trên
iPhone Simulator và build/upload IPA cho iPhone. IPA unsigned mới nhất nằm ở
`../../../04_App/ios_builds/2026-10-22-run-39811695629/RoSight-unsigned.ipa`.
Ảnh khởi chạy Simulator nằm ở
`../../../04_App/ios_builds/2026-10-22-run-39811695629-simulator/launch.png`.
Simulator không có LiDAR iPhone; IPA chưa được ký, cài hoặc đo thử trên iPhone
12 Pro Max thật.

## Chọn đường thử

| | Native iPhone app | PWA trong Safari |
| --- | --- | --- |
| Yêu cầu iOS | iOS 16 trở lên | Safari iOS hiện hành |
| Camera iPhone | Có, chỉ mở ở mode **Chỉ dùng iPhone** | Có, khi mở qua HTTPS và cho phép Camera |
| Khoảng cách LiDAR | ARKit `sceneDepth` khi runtime hỗ trợ; iPhone 12 Pro/12 Pro Max có LiDAR | Không có ARKit/sceneDepth. Khoảng cách luôn “chưa khả dụng”; không ước lượng mét từ ảnh |
| Mic câu hỏi | Dictation hoặc hội thoại native bằng iOS Speech; transcript và ảnh mới gửi Cloudflare; Qwen trả lời theo stream, iPhone đọc câu trả lời | Speech Recognition Safari/iOS (cần Siri bật) hoặc Dictation bàn phím; Qwen trả lời theo stream |
| ESP32 | BLE discovery/status/ToF/nút; FOMO cục bộ đang chờ artifact; Wi‑Fi/Flask lấy JPEG, FOMO snapshot và gọi Vision | Flask qua Wi‑Fi firmware hoặc USB bridge; không dùng BLE |
| Đọc câu trả lời | `AVSpeechSynthesizer` trên iPhone | `speechSynthesis` của trình duyệt |

Ở ESP32 mode, nút **MODE** trên board bật/tắt operation và app phản ánh trạng
thái; **CHỤP** lấy JPEG mới nhưng không gọi Vision; **HỎI AI** lấy frame/context
mới rồi gửi đúng một yêu cầu Vision. BLE chỉ mang sự kiện/trạng thái và lệnh
replay cursor; không có lệnh bật MODE/chụp/hỏi từ xa. Nếu backend Wi‑Fi/Flask
không lấy được ảnh mới thì chụp/hỏi không hoàn tất. Firmware source hiện có
GATT server và ring replay 64 event/10 giây, nhưng `sdkconfig` checked-in vẫn
tắt Bluetooth. Completion GATT hiện báo `history_truncated`, `oldest_press_id`
và `latest_press_id`; app cảnh báo nếu lịch sử thiếu và không xác nhận đủ khi
metadata không hợp lệ. Firmware bỏ ID 0 dành riêng và chuyển từ
`4294967295` sang `1`; parser, cursor và thứ tự event native dùng uint32
serial arithmetic. GPIO nút cũng chưa được xác minh, nên chưa có bằng chứng ba
nút vật lý đang hoạt động trên board.

Moondream trên Cloudflare hoặc YOLO chạy trên Flask là detector riêng cho camera
iPhone; cả hai đều không thay model ESP32. Cloud backend có thể ghép box với
LiDAR trong app native; PWA không đọc ARKit depth. Khi có artifact FOMO đã huấn luyện,
firmware sẽ phát `detections` qua WebSocket Wi‑Fi; Flask đưa model, trạng thái
inference, boot/frame và tuổi dữ liệu vào `/api/device/status`. App chỉ hiện
FOMO khi `model_id` bắt đầu bằng `fomo:`, `inference_status` là `ok`, và output
cùng boot/frame JPEG còn mới. BLE không mang detections; BLE giữ discovery,
status, ToF và ba nút.

GATT characteristic hiện không yêu cầu mã hóa hoặc xác thực BLE. App mở kết
nối CoreBluetooth và xác minh identity/status theo protocol; đây chưa phải ghép
cặp bảo mật ở tầng BLE. Không gửi bí mật hoặc lệnh nhạy cảm qua link này.

Trong native app, chỉ hiện BLE v1 **LIVE** khi `device_info` và `status` cùng
schema `1.0`, đúng cả `device_id`/`boot_id`, `seq` và `t_ms` tiến lên với so
sánh uint32 wrap-safe, hai notification đang bật và status còn mới không quá
một giây tính từ fragment BLE đầu tiên. Có link Bluetooth nhưng sai phiên
hoặc status cũ thì vẫn là “đang xác minh”, không được xem là đã kết nối; ToF
và sự kiện nút cũ cũng bị ẩn/bỏ. PWA không dùng BLE.

## 1. PWA Safari: đường miễn phí và nhanh nhất

1. Trên Windows, cài/chạy dependencies theo [README của PWA](../../../04_App/ro-app/README.md), khởi động backend bằng `run.ps1`, rồi chạy `start_phone.ps1` trong cửa sổ khác.
2. Script mở Cloudflare Quick Tunnel HTTPS tạm thời. Mở URL và thông tin đăng nhập được in ra bằng Safari trên iPhone, tạo hồ sơ rồi chọn **Chia sẻ → Thêm vào Màn hình chính** nếu muốn có icon.
3. Cho Safari quyền Camera. Dùng mic Dictation của bàn phím để nhập câu hỏi; nút ghi âm trong PWA chỉ hoạt động khi backend có API phiên âm. Câu trả lời có thể đọc qua loa iPhone.
4. Trang chính nói rõ Safari PWA không có LiDAR/ARKit `sceneDepth`; khoảng cách phone-only sẽ luôn chưa khả dụng. ESP32 trong PWA đi qua Flask/Wi‑Fi hoặc USB bridge, không phải BLE.

PWA không cần IPA, chứng chỉ ký hay Apple Developer Program. Quick Tunnel là dịch vụ bên ngoài: trang, API, ảnh và khung hình stream đi qua Cloudflare. Chỉ dùng tunnel tạm cho thử nghiệm; xem README để biết giới hạn quyền riêng tư và cách cấu hình backend.

## 2. Native: build cloud miễn phí, ký trên Windows

### Chuẩn bị một workflow IPA

1. Nhánh app đã được đưa lên fork công khai [`npgb2505/Mini-AI-Camera-Module`](https://github.com/npgb2505/Mini-AI-Camera-Module), branch `codex/ios-lidar-test-2026-10-11`. Chỉ mã native app, tài liệu app và workflow được gửi lên; không có file KiCad.
2. Bản mới nhất đã qua 10 kiểm tra depth, 1 UI test vào/ra chế độ iPhone, mở app trên Simulator và build thành công là [GitHub Actions run 39811695629](https://github.com/npgb2505/Mini-AI-Camera-Module/actions/runs/39811695629). IPA đã tải về máy tại `../../../04_App/ios_builds/2026-10-22-run-39811695629/RoSight-unsigned.ipa`. Ảnh màn hình khởi chạy Simulator nằm tại `../../../04_App/ios_builds/2026-10-22-run-39811695629-simulator/launch.png`. Artifact trên GitHub được giữ ba ngày; mỗi lần push mã app, bài kiểm tra hoặc cấu hình build sẽ tự chạy lại; chỉ sửa tài liệu thì không chạy lại build.
3. iOS native cần Xcode trên macOS; Windows hiện tại không có `xcodebuild`/Swift iOS SDK. GitHub Actions đã dùng runner `macos-15` để build nên không cần sở hữu Mac. Lượt CI đã chứng minh app mở được ở Simulator và tạo IPA unsigned; phần cài trên iPhone vẫn phải ký bằng AltServer. Runner chuẩn miễn phí cho repo công khai; repo riêng dùng quota plan. Xem [runner GitHub-hosted](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) và [yêu cầu Xcode của Apple](https://developer.apple.com/xcode/system-requirements/) nếu cần thay đổi cách build.
4. Với lần build mới, mở tab **Actions** trong fork, chọn **Build iOS test IPA**, tải artifact `RoSight-unsigned-ipa` rồi giải nén để lấy `RoSight-unsigned.ipa`.

Workflow build **unsigned**. Build PASS tạo gói cài, nhưng chưa chứng minh camera, ARKit, BLE, âm thanh hoặc ESP32 chạy thật. Bước tiếp theo là ký IPA bằng AltServer trên Windows và kiểm tra ứng dụng trực tiếp trên iPhone 12 Pro Max.

### Cài AltServer trên Windows

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
theo khu vực và không phải đường cài được mô tả ở đây. IPA cài trực tiếp qua
AltServer cần cài lại sau mỗi 7 ngày; có thể sideload tối đa ba app miễn phí
đang hoạt động theo giới hạn iOS/AltStore. Xem [quy tắc refresh của
AltStore](https://faq.altstore.io/altstore-classic/your-altstore) và
[sideload IPA trực tiếp](https://faq.altstore.io/release-notes/altserver).

### Kết nối app với backend

Mở Ro Sight, vào phần thiết lập và nhập URL Flask backend cùng tài khoản Ro
Sight. `127.0.0.1` trên iPhone trỏ về chính iPhone, nên hãy dùng địa chỉ máy
tính có thể truy cập từ điện thoại hoặc URL HTTPS có xác thực. Nếu tunnel cần
Basic Auth, nhập thông tin tunnel trong trường riêng. Đừng gửi thông tin đăng
nhập qua HTTP trên mạng không tin cậy.

Chế độ **Chỉ dùng iPhone** gửi ảnh và câu hỏi tới `/api/analyze`. Chế độ
**Kết nối ESP32** gửi câu hỏi thủ công tới `/api/device/ask`; backend lấy frame
mới từ thiết bị. Ở cả hai chế độ, kết quả có thể phát qua loa iPhone bằng nút
**Đọc câu trả lời**.

Trong chế độ ESP32, tùy chọn **Nói qua loa ESP32** chỉ dùng được khi kết nối
firmware Wi-Fi trực tiếp trả status mới, `audio_ok=true` và
`operation_enabled=true`. GPIO, mạch khuếch đại, loa và nguồn của board hiện
chưa được xác minh nên firmware giữ đầu ra bị khóa. App không dùng microphone
ESP32 và status firmware không xác nhận có âm thanh nghe được.

Màn **Kết nối ESP32** cũng có thẻ fusion frame/ToF và điều khiển âm lượng hoặc
bật/tắt cảnh báo. Chúng chỉ gửi qua firmware Wi-Fi trực tiếp; USB bridge chỉ
đọc. Fusion chuyển thành `unknown` nếu frame, ToF, phiên boot hoặc event cũ.
Firmware chỉ hỗ trợ `set_volume` và `set_alerts`; ACK xác nhận nhận lệnh, không
xác nhận có tiếng hay cảnh báo thật, và không bật MODE.

### Mic, hỏi API/LLM và đọc câu trả lời

- **Native:** chạm ô câu hỏi rồi chạm mic **Dictation** trên bàn phím iPhone.
  iOS chuyển lời nói thành text; app gửi text và ảnh mới tới Flask
  (`/api/analyze` ở phone-only, `/api/device/ask` ở ESP32). App không thu audio
  câu hỏi và không xin quyền microphone riêng. Câu trả lời đọc trên iPhone bằng
  `AVSpeechSynthesizer`; ở ESP32 mode, phát qua loa ESP32 là lựa chọn khác và
  cần firmware Wi-Fi hỗ trợ.
- PWA có thêm tùy chọn ghi âm trong app khi backend đã cấu hình API phiên âm;
  nếu không, dùng Speech Recognition của Safari/iOS để nhận tiếng Việt và gửi
  phần chữ tới Qwen trên Cloudflare. PWA cần Safari qua HTTPS và bật Siri để
  mở camera/mic; `speechSynthesis` đọc câu trả lời. Đây là hội thoại từng lượt,
  chưa full-duplex.
- Câu hỏi gửi tới máy chủ Ro Sight. Moondream/YOLO server chỉ dùng cho camera
  iPhone; ESP32 cần FOMO cục bộ sau khi có artifact đã huấn luyện. Vision
  có thể chạy cục bộ nếu backend được cấu hình model local; nếu chọn dịch vụ API
  bên ngoài, phí phụ thuộc nhà cung cấp và tài khoản của bạn.
- IPA từ workflow là **unsigned**; bước cài qua AltServer mới ký cho tài khoản
  và thiết bị của bạn. Build hoặc cài được app không xác nhận LiDAR chính xác,
  hành vi camera/micro, kết nối ESP32 hay độ an toàn khi di chuyển. Cần thử
  trực tiếp trên iPhone và backend của bạn.
