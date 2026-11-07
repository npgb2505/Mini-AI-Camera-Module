# YOLO26 host trên máy cá nhân

## Luồng kết nối

```text
iPhone/PWA → Cloudflare Worker (đăng nhập, xác thực, giới hạn ảnh)
           → HTTPS Quick Tunnel → máy của bạn: YOLO26n
```

Worker chỉ gọi YOLO host theo endpoint cố định. Host chỉ bind `127.0.0.1:8795`, yêu cầu bearer token, giới hạn ảnh 8 MB/1.228.800 pixel, không bật CORS và không ghi ảnh ra đĩa. D1 chỉ lưu API token đã mã hóa bằng Worker secret `MODEL_SETTINGS_ENCRYPTION_KEY`.

## Path occupancy qua Cloudflare (experimental)

Worker có `GET /api/path/health` và `POST /api/path/detect`. Các route này chỉ chuyển tiếp request đã đăng nhập tới YOLO host hiện được cấu hình; không có ToF field trong request, và server không gán ToF vào bbox. Path service ở host dùng chung `PathOccupancyEngine` trong `06_AI_phan_mem/software/path_occupancy.py`, nhưng tạo mask chữ nhật từ mỗi YOLO box (`geometry_source=bbox_proxy`). Vì vậy diện tích có thể phóng đại hình dạng thật của vật thể.

Muốn endpoint báo `available=true`, phải chuẩn bị policy camera cụ thể tại `yolo_host/path_policy.json`, hoặc đặt đường dẫn tuyệt đối/relative với `yolo_host/` trong `RO_YOLO_PATH_POLICY_FILE` của `yolo_host/.env`; sau đó khởi động lại host. Không có ROI, lớp, threshold hay độ trễ mặc định. Policy JSON có đúng bốn trường cấp cao: `policy_id`, `config`, `class_map`, `transport_age_budget_ms`. `config` phải cung cấp các tham số `PathOccupancyConfig`: polygon ROI chuẩn hóa theo ảnh hiện tại, lớp/footpoint classes, `min_confidence`, `class_confidence_thresholds` tùy chọn (map lớp đã chuẩn hóa → ngưỡng 0..1; lớp không có entry dùng `min_confidence`), `occupancy_threshold`, `object_intrusion_ratio`, `track_entry_ratio`, `persistence_window`, `persistence_required`, gap/history/frame-age limits, và các trường config bắt buộc còn lại trong [core](../../06_AI_phan_mem/software/path_occupancy.py). Kết quả từng track trả `confidence_threshold` để giải thích vì sao detection được giữ. `class_map` ánh xạ tên COCO của YOLO26n sang taxonomy policy. Giá trị được chọn phải đo/hiệu chuẩn trên video và nhãn đúng camera; không điền theo ví dụ cảm tính. Hiện chưa có policy được hiệu chuẩn nên không thêm giá trị vận hành.

Các phép đo cơ bản vẫn là `r_i = |B_i ∩ C| / |B_i|` và `o_t = |(∪B_i) ∩ C| / |C|`, trong đó `B_i` là box raster thành mask chữ nhật và `C` là polygon ROI. `PathOccupancyEngine` áp `K/N` và clear hysteresis theo policy. Đây là **candidate experimental**, không phải xác nhận lối đi an toàn. `calibration_status` luôn bị ép về `experimental`, `tracking_calibrated=false`, `camera_motion_compensated=false`, `growth_warning_enabled=false`; dữ liệu stale, ROI chưa xác nhận hoặc lỗi model trả `UNKNOWN`. “Chưa thấy lấn ROI” chỉ là `clear_candidate`, không phải `CLEAR`.

Host build cũ chưa có `/api/inference/path/*`; khởi động lại bằng `start_yolo_host.ps1` để nạp phiên bản code mới. Khi thiếu policy, `GET /api/inference/path/health` trả `available=false` với reason an toàn `path_policy_missing`; ảnh chưa được gửi ở chế độ path cho tới khi người dùng bật nhánh này trong app.

## Chạy để demo

1. Cài dependencies từ `04_App/ro-app`: `python -m pip install -r requirements.txt`. Phiên bản Ultralytics cần hỗ trợ YOLO26 (`ultralytics>=8.4,<9`). Weights `yolo26n.pt` được giữ cạnh app ở máy host và bị `.gitignore` loại khỏi commit; máy tải weights nếu chưa có. Lúc khởi động, host tải model và warm-up một ảnh tổng hợp để lượt gọi thật đầu tiên không phải chịu độ trễ khởi tạo.
2. Chạy `start_yolo_host.ps1`. Script tạo `yolo_host/.env` với token ngẫu nhiên nếu chưa có. Không chia sẻ file; chỉ sao chép `RO_YOLO_HOST_TOKEN` vào mục API key trong app.
3. Chạy `start_yolo_tunnel.ps1` trong cửa sổ thứ hai. Sao chép URL `https://...trycloudflare.com` từ log.
4. Trong PWA: Hồ sơ → **Cấu hình AI nâng cao** → chọn **Máy của tôi · YOLO26n**, dán URL tunnel và token, lưu rồi chọn **Kiểm tra kết nối**.
5. Để cấu hình hoạt động trên Worker đã deploy, áp migration `0003_model_host_settings.sql` và đặt secret Worker `MODEL_SETTINGS_ENCRYPTION_KEY` (tối thiểu 32 ký tự) trước khi lưu cấu hình.

Quick Tunnel tạo URL tạm; URL đổi khi tunnel khởi động lại nên cần cập nhật cài đặt trong app. Máy phải bật, có Internet và không ngủ. Đây là demo một model/host, không phải hạ tầng có SLA; CPU-only có thể chậm khi nhiều người gửi ảnh cùng lúc.

## Bằng chứng và giới hạn

**Runtime recheck 2026-11-03:** authenticated health báo `yolo26n.pt` đã load trên CPU. Một JPEG tổng hợp 320×240 trả HTTP 200, inference 35 ms, round-trip 91.6 ms, 0 detections và `image_saved=false`. Đây chỉ xác nhận luồng request/model runtime; ảnh tổng hợp không đánh giá accuracy. Path health vẫn `available=false`, `path_policy_missing`.

- `YOLO26n` là checkpoint COCO pretrained dùng để chứng minh app → Worker → máy host → app. Chưa fine-tune trên dữ liệu lối đi của dự án, nên chưa dùng kết quả để quyết định đường đi hoặc tuyên bố độ chính xác an toàn.
- Worker proxy không ghép khoảng cách ToF vào detection. Kết quả host luôn trả `distance_m: null`.
- Thay đổi provider nhận diện không thay model hỏi đáp ảnh hoặc voice.
- **Giấy phép:** Ultralytics ghi YOLO26 và weights theo AGPL-3.0 mặc định. Hướng dẫn của họ yêu cầu công khai mã nguồn phù hợp nếu dùng AGPL; API/SaaS đóng cần Enterprise. Xem [Ultralytics license](https://www.ultralytics.com/license) trước khi mở endpoint cho công chúng.
