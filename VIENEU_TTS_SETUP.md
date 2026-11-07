# VieNeu-TTS tự host

## Mục tiêu và trạng thái

- STT file và STT realtime tiếp tục dùng ElevenLabs Scribe khi `ELEVENLABS_API_KEY` được cấu hình.
- TTS chuyển sang VieNeu-TTS v3 Turbo chạy trên máy tính của dự án. Cloudflare Worker proxy audio về PWA; API key/token không đưa xuống trình duyệt.
- Đã cài và chạy model CPU/ONNX, gateway token-authenticated, Quick Tunnel và production Worker. App production đã nhận audio thử thành công qua toàn tuyến.
- Nếu host/tunnel tắt, `voice_tts_ready` không còn bảo đảm synthesis đang chạy; app sẽ báo lỗi TTS server. TTS của thiết bị vẫn có thể dùng khi `/api/status` báo provider chưa sẵn sàng.

### Kết quả host hiện tại (2026-11-01)

- Máy host: Intel Core Ultra 7 255H, RAM 32 GB, Intel Arc Pro 140T; hiện dùng CPU/ONNX, không dùng CUDA/NVIDIA.
- VieNeu local API nghe ở `127.0.0.1:8000`; gateway có token ở `127.0.0.1:8001`; cả hai đang chạy trên máy Windows này.
- VieNeu model cold start khoảng 78,9 giây. Một câu thử tổng hợp 2,4 giây audio mất 799 ms warm local (~0,33 RTF). Một câu qua Quick Tunnel/gateway mất 872 ms và trả WAV hợp lệ 192 KB. Đây là smoke ngắn, không đại diện p50/p95 hay chất lượng giọng.
- Thử ngay trên app production nhận `audio/wav` 284.204 byte và UI xác nhận đang phát. Chưa làm bài nghe mù/chấm phát âm, chưa đo end-to-end hội thoại STT + Qwen + TTS.
- Model upstream gửi WAV header kiểu streaming với kích thước sentinel; gateway đã sửa kích thước RIFF/data sau khi buffer để trình duyệt giải mã được.
- Tên Quick Tunnel hiện tại là `https://prize-cms-murphy-giving.trycloudflare.com`; URL này tạm thời, có thể đổi sau khi tunnel khởi động lại. Đã lưu endpoint, token dùng chung và voice `Hải Đăng` trong Worker secrets; token không hiển thị trong app/chat/log.
- Build production hiện tại `20261101-autodetect-runtime-copy-v3`, Worker version `971f0e3b-1f93-42f1-b334-6be80a4af74c`. `/api/status` vẫn báo STT ElevenLabs, TTS VieNeu v3 Turbo sẵn sàng; bản deploy mới sửa copy tốc độ/geometry trong Auto Detect, không đổi voice route.

## Cài model và mở local API

VieNeu-TTS upstream hiện mô tả v3 Turbo là bản mã nguồn mở; repo Apache-2.0 có API OpenAI-compatible `/v1/audio/speech`. Voice presets có vùng Bắc/Trung/Nam. Các số đo host ở trên là smoke test đơn lẻ; benchmark upstream là số do maintainer báo cáo.

1. Cài `uv` nếu chưa có và clone repo chính thức vào thư mục ngoài project:

   ```powershell
   git clone https://github.com/pnnbao97/VieNeu-TTS.git D:\Models\VieNeu-TTS
   cd D:\Models\VieNeu-TTS
   ```

2. Chọn một runtime:

   ```powershell
   # CPU-only (không cần NVIDIA/CUDA)
   uv sync
   uv run python -m apps.openai_speech
   ```

   Nếu máy có NVIDIA GPU và CUDA stack tương thích theo README upstream:

   ```powershell
   uv sync --extra cuda
   uv run python -m apps.openai_speech
   ```

   Server model mặc định nghe ở `127.0.0.1:8000`. Để host trên Windows, kiểm tra kỹ đúng lệnh cài GPU/CPU của README VieNeu tại thời điểm cài; model download có thể chiếm nhiều GB.

## Chạy gateway có token

1. Tạo token ngẫu nhiên dài. Dùng cùng một giá trị trong file `vieneu_host/.env` và Cloudflare Worker secret; không đưa token vào chat, commit hoặc log.
2. Tạo `04_App/ro-app/vieneu_host/.env` từ `.env.example`, điền `VIENEU_TTS_SHARED_TOKEN`. Mặc định upstream là `http://127.0.0.1:8000/v1/audio/speech`.
3. Mở terminal thứ hai:

   ```powershell
   cd D:\KLTN\Camera_Edge_AI_Khiem_Thi\04_App\ro-app
   .\start_vieneu_gateway.ps1
   ```

   Gateway bind loopback `127.0.0.1:8001`, bắt buộc Bearer token, giới hạn text 1.800 ký tự và 2 synthesis đồng thời. Nó chỉ forward đến VieNeu local, không lưu nội dung/audio.

4. Mở terminal thứ ba và tạo Cloudflare Quick Tunnel:

   ```powershell
   .\start_vieneu_tunnel.ps1
   ```

   Sao chép hostname HTTPS `https://…trycloudflare.com` trong output. Chỉ tunnel gateway port 8001, không expose thẳng port 8000 của model.

## Nối Worker

Từ `04_App/ro-app`, dùng Wrangler để lưu ba secret (nhập token tương tự token trong file `.env`):

```powershell
npx wrangler secret put VIENEU_TTS_ENDPOINT --config cloudflare/wrangler.jsonc
npx wrangler secret put VIENEU_TTS_SHARED_TOKEN --config cloudflare/wrangler.jsonc
npx wrangler secret put VIENEU_TTS_VOICE --config cloudflare/wrangler.jsonc
```

- Endpoint: `https://<hostname-quick-tunnel>/v1/audio/speech`
- Voice preset ban đầu: `Hải Đăng`; đổi sau khi nghe các mẫu Bắc/Trung/Nam.
- `ELEVENLABS_API_KEY` hiện có tiếp tục dùng cho STT. Không xóa key đó.
- Deploy Worker bằng quy trình trong `cloudflare/README.md`; xác nhận `/api/status` trả `transcription_provider=elevenlabs`, `voice_tts_provider=vieneu_self_hosted`, `voice_tts_model=vieneu-v3-turbo`, `voice_tts_ready=true`. Sau đó dùng **Cấu hình AI nâng cao → Thử giọng VieNeu-TTS**.

Quick Tunnel URL đổi sau khi restart; khi đổi URL phải cập nhật secret endpoint và deploy lại. Host, model API, gateway và tunnel đều phải đang chạy để TTS hoạt động. Đây là demo cá nhân, không phải server production ổn định; kiểm soát quota/requests vẫn cần khi chia sẻ công khai.

## Kiểm tra đầu ra và độ trễ

Chấm ít nhất 10 câu đại diện (câu cảnh báo ngắn, tên vật/địa điểm, câu trả lời dài) với cùng text và nghe trên iPhone/laptop. Lưu voice preset, first-byte/TTFA, tổng thời gian, RTF và lỗi phát WAV; không log audio hoặc transcript riêng tư. Không tuyên bố phản hồi end-to-end 1–2 giây cho tới khi đo STT + Qwen + TTS + mạng với p50/p95 trên thiết bị.

### Nguồn

- [VieNeu-TTS upstream](https://github.com/pnnbao97/VieNeu-TTS) — Apache-2.0; API server, các lệnh cài và voice list.
- [ElevenLabs Scribe supported languages](https://elevenlabs.io/docs/overview/capabilities/speech-to-text) — Vietnamese được liệt kê là ngôn ngữ hỗ trợ.
