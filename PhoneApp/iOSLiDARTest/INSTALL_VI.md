# Cài và thử Ro Sight miễn phí trên iPhone, không cần Mac

Cần máy Windows để chạy backend/AltServer, iPhone, Internet và Apple Account
miễn phí. Không cần sở hữu Mac. **PWA là đường thử ngay**; native cần một IPA
được build trên runner macOS của GitHub Actions rồi ký trên Windows trước khi
cài.

**Tình trạng ngày 25/10/2026:** Worker đang chạy tại
`https://ro-mobile-assistant.gfgfhtrffg.workers.dev`. D1 và migration khởi tạo
đã được cấu hình; `SESSION_SECRET` và mã đăng ký nằm trong Worker secrets.
Worker v26 dùng Qwen 3.8 27B, Moondream 3.1, Whisper Large v3 Turbo cho file
ghi âm và Nova-3 cho realtime; `/api/status` báo realtime đã cấu hình.
Đây chưa phải bằng chứng đã mở được phiên WebSocket hoặc nhận transcript từ
micro iPhone.
Một ảnh bus công khai đã trả 4 boxes “vật cản” qua `/api/detect` (model 481 ms,
toàn request khoảng 4 giây); chưa xác nhận trên camera iPhone. App native điền
URL đang chạy và tự chuyển ba địa chỉ preview cũ sang URL đó.

Đo trên preview lần trước: ảnh Simulator được Qwen trả lời trong 6,6 giây,
token đầu của lượt thoại văn bản sau 1,7 giây và hoàn tất sau 2,4 giây. Đây là
một lần đo mạng đơn lẻ, không phải độ trễ mic trên iPhone. Native app ưu tiên
luồng Nova-3, rồi Qwen; nếu realtime lỗi, app dùng Speech `vi-VN` của iPhone
và Whisper Large v3 Turbo theo lượt khi backend sẵn sàng. Nova-3 multilingual
hỗ trợ streaming tiếng Việt theo cập nhật Deepgram ngày 23/10/2026, nhưng phiên
mic và transcript thật vẫn cần kiểm tra trên iPhone.

Native app có hành lang hình thang phủ lên camera, chỉ tính vật giao với vùng
giữa và nằm trong tầm thử 2,5 m; vật xa hơn chỉ là ngữ cảnh. Địa chỉ cloud được
điền sẵn, username được lưu trong cài đặt app và mật khẩu lưu trong iOS Keychain.
Các ngưỡng khoảng cách vẫn cần đo lại trên iPhone 12 Pro Max thật.

Native app và workflow đã được đẩy lên fork công khai
`npgb2505/Mini-AI-Camera-Module`; repo gốc vẫn chỉ có quyền đọc. GitHub Actions
run [39886118187](https://github.com/npgb2505/Mini-AI-Camera-Module/actions/runs/39886118187)
đã thành công sau 6m29s. Bản mới nhất là
[run 39890932193](https://github.com/npgb2505/Mini-AI-Camera-Module/actions/runs/39890932193),
hoàn tất sau 7m34s: 11 kiểm tra depth, 2 UI test (điều hướng chế độ iPhone và
hiển thị form tạo tài khoản), mở app trên iPhone Simulator, build/upload IPA
unsigned với URL Worker mới. IPA nằm ở
`../../../04_App/ios_builds/2026-10-23-run-39890932193/RoSight-unsigned.ipa`
(684.353 byte, SHA-256 `C287DDD5F34C6E8F69B7CB38D69088D4D922FB82E1F58C9F9B4798FDEB5FC1A6`).
Ảnh khởi chạy Simulator nằm ở
`../../../04_App/ios_builds/2026-10-23-run-39890932193-simulator/launch.png`.
Simulator không có LiDAR iPhone; IPA chưa được ký, cài hoặc đo thử trên iPhone
12 Pro Max thật.

## Chọn đường thử

| | Native iPhone app | PWA trong Safari |
| --- | --- | --- |
| Yêu cầu iOS | iOS 16 trở lên | Safari iOS hiện hành |
| Camera iPhone | Có, chỉ mở ở mode **Chỉ dùng iPhone** | Có, khi mở qua HTTPS và cho phép Camera |
| Khoảng cách LiDAR | ARKit `sceneDepth` khi runtime hỗ trợ; iPhone 12 Pro/12 Pro Max có LiDAR | Không có ARKit/sceneDepth. Khoảng cách luôn “chưa khả dụng”; không ước lượng mét từ ảnh |
| Mic câu hỏi | Dictation hoặc hội thoại native: WebSocket PCM cloud nếu Worker bật, nếu không thì iOS Speech; Qwen trả lời theo stream, iPhone đọc câu trả lời | Speech Recognition Safari/iOS (cần Siri bật) hoặc Dictation bàn phím; Qwen trả lời theo stream |
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
2. Bản mới nhất đã qua 11 kiểm tra depth, 2 UI test: điều hướng chế độ iPhone và hiển thị form tạo tài khoản, mở app trên Simulator và build thành công là [GitHub Actions run 39886118187](https://github.com/npgb2505/Mini-AI-Camera-Module/actions/runs/39886118187). IPA đã tải về máy tại `../../../04_App/ios_builds/2026-10-23-run-39886118187/RoSight-unsigned.ipa`. Ảnh màn hình khởi chạy Simulator nằm tại `../../../04_App/ios_builds/2026-10-23-run-39886118187-simulator/launch.png`. Artifact trên GitHub được giữ ba ngày; mỗi lần push mã app, bài kiểm tra hoặc cấu hình build sẽ tự chạy lại; chỉ sửa tài liệu thì không chạy lại build.
3. iOS native cần Xcode trên macOS; Windows hiện tại không có `xcodebuild`/Swift iOS SDK. GitHub Actions đã dùng runner `macos-15` để build nên không cần sở hữu Mac. Lượt CI đã chứng minh app mở được ở Simulator và tạo IPA unsigned; phần cài trên iPhone vẫn phải ký bằng AltServer. Runner chuẩn miễn phí cho repo công khai; repo riêng dùng quota plan. Xem [runner GitHub-hosted](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) và [yêu cầu Xcode của Apple](https://developer.apple.com/xcode/system-requirements/) nếu cần thay đổi cách build.
4. Với lần build mới, mở tab **Actions** trong fork, chọn **Build iOS test IPA**, tải artifact `RoSight-unsigned-ipa` rồi giải nén để lấy `RoSight-unsigned.ipa`.

Workflow build **unsigned**. Build PASS tạo gói cài, nhưng chưa chứng minh camera, ARKit, BLE, âm thanh hoặc ESP32 chạy thật. Bước tiếp theo là ký IPA bằng AltServer trên Windows và kiểm tra ứng dụng trực tiếp trên iPhone 12 Pro Max.

### Cài AltServer trên Windows

**Chẩn đoán PC ngày 23/10/2026:** iTunes desktop 12.13.11.1 và Apple Mobile
Device Support 20.0.0.35 đã có trong `C:\Program Files`; dịch vụ Apple Mobile
Device đang Running/Automatic. iTunes hiện chưa thấy iPhone. Device Manager chỉ
còn mục Apple iPhone USB cũ ở trạng thái không hiện diện, không có thiết bị
Apple USB đang kết nối. AltServer được cài nhưng chưa xác minh nhận iPhone hoặc
cài IPA. iCloud vẫn là bản Microsoft Store; iTunes desktop đã đủ làm thành phần
Apple cần thiết trước khi thử lại. Nếu AltServer vẫn lỗi sau khi Windows nhận
điện thoại, xem mục thay thế cho iCloud Store trong
[hướng dẫn khắc phục AltStore](https://faq.altstore.io/altstore-classic/troubleshooting-guide).
Xem thêm [hướng dẫn Windows của AltStore](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)
và [khắc phục iPhone không được nhận diện của Apple](https://support.apple.com/en-ie/102347).

1. iTunes desktop cùng Apple Mobile Device Service đã có trên PC này. Chạy
   AltServer for Windows bằng quyền Administrator.
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

Mở Ro Sight, vào phần thiết lập và kiểm tra URL backend đã điền sẵn. Với
Cloudflare, nhập username, mật khẩu và mã đăng ký vào mục **Tạo tài khoản
Cloudflare** ngay trong app; mã đăng ký nằm trong file local đã bỏ qua Git
`04_App/ro-app/cloudflare/.preview-secrets.json`. Mã chỉ gửi khi tạo tài khoản,
không được lưu trong app. Nếu đã tạo tài khoản, nhập username/mật khẩu hiện có.
Username được lưu trong cài đặt app, mật khẩu trong iOS Keychain. Để trống
Basic Auth. `127.0.0.1` trên iPhone trỏ về chính iPhone, nên với Flask hãy dùng địa chỉ máy
tính có thể truy cập từ điện thoại hoặc URL HTTPS có xác thực. Nếu tunnel cần
Basic Auth, nhập thông tin tunnel trong trường riêng. Đừng gửi thông tin đăng
nhập qua HTTP trên mạng không tin cậy.

Trong Cài đặt, bấm **Kiểm tra backend** để kiểm tra URL và đọc tên/trạng thái
Vision, detector, phiên âm và thoại realtime. Kiểm tra này gọi `/api/status`,
không cần đăng nhập Ro Sight và không gửi ảnh hoặc chạy inference. Kết quả
“sẵn sàng” là trạng thái backend khai báo; chỉ một lượt hỏi ảnh/nhận diện thật
mới xác nhận model suy luận được. Nếu URL preview lỗi DNS, cần deploy Worker mới
rồi thay URL tại đây.

Chế độ **Chỉ dùng iPhone** gửi ảnh và câu hỏi tới `/api/analyze`; khi có kết quả
detector gần đây, app gửi kèm đúng ảnh detector đã phân tích và ước lượng LiDAR
trong từng box để Qwen trả lời có ngữ cảnh hơn. Số đo tại tâm ảnh được ghi rõ
là số đo bề mặt vùng tâm, không gán cho vật thể. Các số đo đều là ước lượng,
không xác nhận lối đi an toàn. Chế độ
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
- **Native voice conversation:** nút **Trò chuyện bằng giọng nói** cần quyền
  Microphone và Speech Recognition. Worker v26 báo Nova-3 đã cấu hình; app thử
  realtime PCM → Nova-3 → Qwen. Nếu luồng cloud lỗi, app chuyển sang Speech
  `vi-VN` của iPhone, gửi transcript và ảnh/LiDAR hiện hành tới Qwen, rồi đọc
  câu trả lời. Khi phiên âm file được bật, app gửi WAV của lượt nói tới Whisper
  Large v3 Turbo để chỉnh transcript; nếu Whisper lỗi, dùng transcript iPhone.
  Audio không được ghi vào D1. Barge-in và echo-cancellation cần kiểm chứng
  bằng micro/loa thật; status `/api/status` chỉ phản ánh cấu hình.
- **PWA:** ưu tiên truyền PCM realtime tới Nova-3; nếu luồng lỗi, tự chuyển sang
  Speech Recognition của Safari/iOS và gửi transcript từng lượt tới Qwen.
  Cần Safari qua HTTPS và quyền Microphone; nhánh Speech Recognition có thể
  cần Siri được bật. `speechSynthesis` đọc câu trả lời. Mic iPhone thật và
  hành vi ngắt lời vẫn cần thử.
- Câu hỏi gửi tới máy chủ Ro Sight. Moondream/YOLO server chỉ dùng cho camera
  iPhone; ESP32 cần FOMO cục bộ sau khi có artifact đã huấn luyện. Vision
  có thể chạy cục bộ nếu backend được cấu hình model local; nếu chọn dịch vụ API
  bên ngoài, phí phụ thuộc nhà cung cấp và tài khoản của bạn.
- IPA từ workflow là **unsigned**; bước cài qua AltServer mới ký cho tài khoản
  và thiết bị của bạn. Build hoặc cài được app không xác nhận LiDAR chính xác,
  hành vi camera/micro, kết nối ESP32 hay độ an toàn khi di chuyển. Cần thử
  trực tiếp trên iPhone và backend của bạn.
