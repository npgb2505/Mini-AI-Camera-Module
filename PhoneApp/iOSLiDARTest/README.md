# Ro Sight native iPhone app

The app opens with a mode chooser. Camera access starts only after choosing a
mode, so an ESP32-only session does not open the iPhone camera. iPhone 12 Pro
and 12 Pro Max have a LiDAR Scanner, but the app still checks ARKit scene-depth
support and waits for a real depth frame before showing a measurement. The
physical validation target is iPhone 12 Pro Max.

The native app includes a CoreBluetooth client for the versioned Ro Sight GATT
contract. The ESP-IDF source now includes a GATT service for identity, status,
and button-event replay. Its `sdkconfig.defaults` enables NimBLE, but the
checked-in `sdkconfig` still disables Bluetooth, so advertising and board
interoperability are not confirmed. The GATT characteristics do not require
BLE encryption or authentication; identity/status validation is not secure
pairing. Replay completion reports
`history_truncated`, `oldest_press_id`, and `latest_press_id`; the app shows
incomplete history or an unknown state when metadata is missing or invalid.
Firmware press IDs skip reserved zero and advance from `4294967295` to `1`.
The iOS parser uses wrap-safe cursor/range ordering and rejects ID zero. See the concrete
[BLE GATT handoff](../../../04_App/BLE_GATT_HANDOFF_v1.md),
[transport architecture decision](../../../04_App/TRANSPORT_ARCHITECTURE.md),
and [app-facing protocol handoff](../../../04_App/APP_DEVICE_PROTOCOL_v1.md).

The transport is hybrid: BLE carries identity, status, ToF, and button events.
The ESP32's local FOMO detections are expected over the existing firmware
Wi-Fi WebSocket `detections` event and Flask `/api/device/status` snapshot; they
do not travel over BLE. JPEG/video, Vision requests, and speaker PCM also stay
on Wi-Fi/Flask. Cloudflare/Flask detection is a separate iPhone-camera path and
is never the ESP32 model. BLE cannot save a capture or complete an `ask_llm` action
without the Wi-Fi/backend media path. The only GATT write currently supported
is a button replay cursor; there is no remote MODE, capture, ask, volume, or
alert command. The PWA uses Cloudflare for standalone phone vision/voice and
Flask/Wi-Fi/USB for ESP32 media; it does not use Bluetooth.

The native screen shows **BLE v1 · LIVE** only after `device_info` and `status`
both decode as schema `1.0`, their `device_id` and `boot_id` match exactly, the
status sequence and firmware monotonic time advance with wrap-safe uint32
comparisons, both notifications are active, and the newest status is at most
one second old from its first BLE fragment. A CoreBluetooth link by itself, a
mismatched boot, or a stale status stays in verification and cannot supply
button events or ToF readings.

## ESP32 mode

This mode can show direct BLE connection/status/ToF and fresh ESP32 FOMO
detections/ToF from the Flask snapshot. FOMO detections remain pending until a
trained artifact is installed and firmware returns successful FOMO output. The
phone still uses Flask for JPEG, Vision, and existing device controls; it does
not connect directly to USB or bypass the backend session for media. The
backend can reach the board through either of its existing transports:

- **USB bridge:** connect the computer to the ESP32 and start
  `04_App/ios_app/start_device_bridge.ps1` on that computer.
- **Firmware Wi-Fi:** configure `RO_DEVICE_FIRMWARE_URL` on the Flask server to
  the ESP32 firmware address.

The backend requires an explicit `operation_enabled=true` before returning an
image or accepting a Vision question. A legacy read-only USB probe that does
not report operation state can appear connected but remains locked; the app
does not infer that standby is off or bypass the backend check.

Firmware may start every boot with `operation_enabled=false`. When status
reports `mode_button_configured=false` or `button_inputs_configured=false`, the
screen explains that standby will persist on that pin profile; it includes the
`pin_profile` ID and camera/external map states when the optional fields are
present. There is no remote operation-enable command. Network and status remain
available, while capture, inference, ToF, alerts, and Vision asking remain
locked until a verified physical MODE input exists. Older firmware can omit
these optional status fields; the app decodes them as unknown.

The native app reads `GET /api/device/status` for its Wi-Fi/USB media session.
BLE status is displayed separately and is never used as a substitute for a
JPEG or backend Vision response. Button capture/ask events arriving over BLE
are accepted for media work only when the backend status has the same
`device_id` and `boot_id`.

The app treats a backend device as ready
only when the backend reports `source=device`, `device_connected=true`,
`operation_enabled=true`, a live camera, a positive frame sequence, and a
camera age of at most 350 ms. The app continues aging the received status while
it polls, so a delayed status response cannot keep an old preview, detection,
or ToF reading marked as fresh. Standby, unknown operation state, a stale
frame, or a disconnected device disables asking and hides the old preview.

For preview, the app requests `GET /api/device/frame?frame_seq=…`, verifies the
JPEG bytes and `X-Frame-Seq`, and matches the returned sequence to the status
snapshot. The USB bridge requires the exact requested sequence. Direct
firmware Wi-Fi may return a newer sequence because it fetches the latest image.
ESP32 detections are shown only when the firmware identifies a FOMO model,
reports `inference_status: "ok"`, and the detection frame, boot, and freshness
match the displayed image. Server-side detector results are not reused in ESP32
mode. ToF is shown only when the backend marks the reading as
device-originated and fresh; zones are separate sensor readings and are not
assigned to objects in the JPEG.

The firmware already has the transport hook: `camera_status_task` runs the
detector and `publish_device_events` emits a `detections` WebSocket event with
`frame_seq`, `model_id`, `inference_status`, and `items`. Flask maps that event
to `/api/device/status` with the detector model, inference status, boot, frame,
age, and items. The app accepts ESP32 detections only on direct firmware Wi-Fi
when `model_id` starts with `fomo:`, inference succeeds, and the result matches
the current JPEG within 350 ms. BLE GATT carries identity/status/ToF/buttons,
not detection payloads. The current firmware still uses
`stub-awaiting-fomo-model`; no trained FOMO artifact or on-device output is
installed.

The **Fusion · frame và ToF** card is shown only for direct firmware Wi-Fi,
while operation is enabled and the camera, ToF, and device-originated fusion
event are fresh and tied to the same boot. If any of those checks fail, it shows
unknown; the USB bridge does not provide confirmed fusion. The displayed risk
and suggested zone are firmware reports, not a safe-path recommendation.

The firmware controls send only `set_volume` (0–100) and `set_alerts` through
authenticated `POST /api/device/command` on direct firmware Wi-Fi. USB bridge is
read-only, and there is no remote MODE-enable command. The screen labels the
volume as the value being sent because firmware does not report its current
setting. A matching ACK confirms receipt by firmware only; it does not confirm
that the speaker or alerts work, and these settings do not take the device out
of standby.

Flask keeps up to 64 recent firmware `button_event`s per device boot for 10
seconds and returns a chronological `button_events` batch in the firmware Wi-Fi
status response, while retaining the older single-event fields for legacy
clients. The app processes the oldest unhandled event on each poll, verifies
`button_id`, `action`, `press_id`, event age, device ID, and boot ID, then
deduplicates by `(device_id, boot_id, press_id)` across launches on this
installation. A USB bridge that only exposes one snapshot keeps its existing
single-event behavior.
The event's operation state is used only when its device-clock `t_ms` is newer
than the matching health snapshot. `mode` updates the shown operation state.
`capture_image` fetches one new JPEG through the backend, validates its bytes
and frame sequence, and keeps/displays it in the app session; it never calls
Vision. `ask_llm` submits one `trigger: "button_event"` request only while the
same login generation and ESP32 boot remain active, the frame is fresh, Vision
is ready, and configured ToF data is still valid and within 350 ms. If ToF is
reported unavailable, the prompt does not claim a distance. The backend checks
device operation, frame, and required ToF freshness again before using Vision.
For direct BLE, the app requests replay after its stored per-device/boot press
cursor; firmware should retain at least 64 events for 10 seconds. The app
consumes a media event once after matching the backend device/boot, even when a
freshness or Vision check fails; it does not retry that physical press.
BLE event IDs are deduplicated by the same full tuple, `(device_id, boot_id,
press_id)`, and events are accepted only while the matching BLE status remains
fresh. Firmware source now has a 64-record GATT ring with a 10-second replay
window and reports truncation metadata in its completion message. The app
surfaces incomplete replay and does not treat a missing or invalid range as
complete. Cursor, range, and merged button-event ordering use wrap-safe uint32
comparison. Firmware skips reserved ID zero and advances from `4294967295` to
`1`; source review confirms the client handles this sequence, but rollover has
not been exercised on an iPhone and board.

When the user asks a question, the app sends JSON to
`POST /api/device/ask` with `question` and `trigger: "manual"`; it does not send
the preview JPEG as the Vision input. Flask obtains a current ESP32 image and
rechecks operation state, camera/frame age, and available sensor context before
calling the configured Vision provider. The backend remains the final
freshness check, so a frame that expires after the status response is rejected
instead of being sent to Vision.

## iPhone-only mode

Choose **Chỉ dùng iPhone** to use the rear camera and native ARKit scene depth
without an ESP32. Scene depth is available only on supported iPhone hardware;
the app checks ARKit frame-semantics support at runtime rather than assuming it
from a model name. If ARKit camera tracking is supported but sceneDepth is not,
camera frames, backend detection, and image questions remain available while
distances stay unavailable. The phone-camera detector is separate from
ESP32-local FOMO. The app waits for an actual frame with `sceneDepth` before
reporting depth; it does not label depth as available merely because an AR
session was started. The center-distance display also clears a sample after
one second without a newer depth update.

### Cloudflare phone backend

The native **Chỉ dùng iPhone** mode can use the Cloudflare Worker preview for
cloud detection and image questions while ARKit supplies depth locally. The
current preview URL is prefilled in native settings. Create a Ro Sight account
directly in **Cài đặt backend → Tạo tài khoản Cloudflare** with the preview
registration code; the code is used once and is not saved. The username is kept
in app preferences and the password is stored in this iPhone's Keychain. Leave
the optional tunnel Basic Auth fields blank. Select **Chỉ dùng iPhone**. The app
logs into `/api/auth/login`, reads `/api/status`,
sends detector frames to `/api/detect` (Moondream 3.1), and sends a fresh image
plus question to `/api/analyze` (Moondream detection plus Qwen 3.8 27B vision).
The live request cadence is capped at one frame per second to limit cloud use.

When a recent detector result is available, native questions and voice turns
send the exact JPEG used for that detector result, its box-level LiDAR estimates,
and optional three-zone probabilities to Qwen. If detection is off, only the
fresh center LiDAR sample may be attached; the server explicitly tells Qwen not
to assign that center sample to a particular object. All distances remain
estimates and never mean that a path is safe.

The cloud Worker does not expose `/api/device/*`; ESP32 mode still requires the
local Flask backend and its USB/Wi-Fi bridge. Native **Chỉ dùng iPhone** voice
checks `voice_realtime_ready` in `/api/status`. If enabled, it opens the
authenticated `/api/voice/realtime` WebSocket, streams iPhone microphone audio
as mono 16 kHz linear PCM, sends a fresh camera JPEG about every two seconds,
and receives Vietnamese transcript plus streamed Qwen answer events. iPhone
`AVSpeechSynthesizer` speaks response chunks, then the app starts listening
again. If the route is absent or fails, iOS Speech Recognition shows interim
text and detects the end of a phrase. When cloud transcription is ready, every
turn's captured WAV goes to `/api/transcribe` and Whisper supplies the primary
Vietnamese transcript; if it fails, the app uses the iPhone transcript. The
transcript and a fresh frame then go to `/api/voice/turn`. This is turn-taking,
not full-duplex. Raw microphone upload is disclosed by the permission prompt
and voice-screen privacy text. The Worker does not store audio or camera frames
in D1.

The current preview is a temporary Cloudflare account at
`https://ro-mobile-assistant-preview.slimy-kettle.workers.dev`. D1 is created
and migration `0001_init.sql` is applied. `/api/status` reports Qwen 3.8 27B,
Moondream 3.1, and Whisper Large v3 Turbo as ready. The Cloudflare claim page
is open in Codex; the account must be claimed within 60 minutes to retain the
Worker and D1. The app defaults to this endpoint and migrates both retired
preview URLs on launch. A previous preview run on the same Worker build
answered a Simulator screenshot with Qwen Vision in 6.6 seconds; its text voice
turn streamed the first Qwen delta in 1.7 seconds and completed in 2.4 seconds.
These are single preview measurements, not iPhone microphone latency.

Nova-3 microphone WebSocket remains disabled because this Worker has no AI
Gateway credentials and Vietnamese streaming has not been verified on this
account. The native app uses iPhone Speech Recognition to show interim text and
detect the end of each phrase, then sends captured audio to Cloudflare Whisper
Large v3 Turbo for the primary Vietnamese transcript. If cloud transcription
fails, it keeps the iPhone transcript and still sends the question and a fresh
frame to Qwen. Qwen streams answer text back and iPhone reads it aloud. This is
turn-taking near-realtime, not full-duplex. Cloudflare model inference remains
off the iPhone; ARKit LiDAR and camera capture stay on the phone.
Safari's PWA also supports voice, but cannot read ARKit depth, so the native app
is the path that pairs vision boxes with sceneDepth from the same camera frame.

The native iPhone screen can read a local Vietnamese proximity cue from the
iPhone speaker without a backend connection. It triggers once when a fresh
center sample is at or below 0.8 m, then rearms after a fresh sample reaches
1.05 m. The **Đọc cảnh báo khoảng cách** switch can turn it off. VoiceOver gets
a system announcement instead of a second synthesized voice. The cue reports
only an estimated surface distance at the center of the image; it does not
identify an object, choose a direction, or certify a safe path. The PWA stays
browser-only and does not receive LiDAR measurements.

For the iPhone-camera mode, enabling detection sends a portrait JPEG to
`POST /api/detect`, where the configured backend runs its detector. The response returns normalized
`[x1, y1, x2, y2]` coordinates in the range 0–1; the app maps the central half
of each box back to the depth map copied from the exact same ARKit frame as the
JPEG. It reports the median of valid medium- or high-confidence LiDAR samples;
if that region has no reliable depth, it reports no distance. Raw `sceneDepth`
is preferred for lower latency, with `smoothedSceneDepth` as a fallback. The
app sends at most one frame per second and skips frames while one inference is
in progress; live requests time out after 12 seconds. Depth snapshots are
copied only when detection is enabled to avoid needless work. There is no FOMO
artifact involved in this path; it does not use a development mock as a
detection result. These detections and their paired depth estimates are hidden once
the processed frame is more than 2.5 seconds old; the live camera may have
advanced since that detector frame. This is an estimate that still needs a
known-distance check on the phone. A typed question is enabled only while the local camera
frame is at most 2.5 seconds old; it sends that iPhone JPEG and the question as
multipart form data to `POST /api/analyze`. Vision can fall back to the
backend's detector summary when no Vision provider is configured.

For a first-pass path hint, the live camera displays a tinted trapezoid that is
narrow toward the image horizon and wider near the phone. A detection's lower
edge must overlap that corridor; wide boxes count when they cross the corridor
even if their center lies outside it. Paired depth up to 0.8 m is marked as a
very-near candidate; above 0.8 m through 2.5 m it is inside the trial walking
horizon. Beyond 2.5 m it is context only, so a very distant object does not by
itself make the near path appear blocked. A fresh-frame summary distinguishes
near, distant, and unknown-depth detections. No detection is described as proof
that the path is clear. Missing depth remains unknown. The overlay geometry and
2.5 m horizon are starting values, not calibrated safety limits; box depth can
still sample floor or background, and the iPhone 12 Pro Max needs validation at
known distances and camera angles.

When the backend response also includes `hazard_zones`, the app shows MobileNet's
left/center/right hazard probabilities and maps each full-height image region
to `sceneDepth` from the same ARKit frame. This is displayed as **Depth vùng**:
the median can include floor or background depth and is not a verified
distance to the detected obstacle. Missing or low-confidence depth stays
unknown. The current preview uses a 0.35 hazard threshold selected on public
validation data; recalibrate it with iPhone/OV3660 camera scenes before any
real navigation use.

### ESP32 FOMO artifact handoff

ESP32-local FOMO is the target detector. The current ESP-IDF detector backend
is `stub-awaiting-fomo-model`; it reports inference unavailable and no trained
artifact is installed. The app and PWA keep ESP32 FOMO pending and never use
server YOLO, a development mock, or empty stub output as an FOMO result.

To connect a real model, select and install the trained FOMO artifact and its
runtime, implement input preprocessing and centroid/output decoding in the
firmware detector backend, and map labels into the product detection classes.
The firmware should emit `model_id: "fomo:<artifact-id>"` and
`inference_status: "ok"` for completed inference (including a valid frame with
zero detections), then publish `items` with `class_name`, `confidence`,
normalized center/bbox, and `zone` in the existing Wi-Fi WebSocket `detections`
event. Flask must preserve model ID/status plus device/boot/frame/timestamp in
`GET /api/device/status`; the native and PWA ESP32 screens then require a fresh
same-boot, same-frame result before showing it. BLE is not the detection
transport. The artifact, runtime, labels, and output contract remain to be
selected and validated on the ESP32-S3.

For voice input, the user can tap the iPhone keyboard's Dictation microphone.
The native app itself does not record audio or request microphone permission:
iOS turns speech into text, and the app sends the resulting question text to
the Flask backend. The input control in both modes uses this same iPhone
Dictation path; no ESP32 microphone is used. iOS Dictation behavior follows
the user's iPhone settings.

After an answer appears, tap **Đọc câu trả lời** to have the iPhone read it
with `AVSpeechSynthesizer`. In ESP32 mode, **Nói qua loa ESP32** is a separate
option: iOS exports Vietnamese TTS buffers, converts them to PCM16LE 16 kHz
mono, and sends up to 8 seconds/256,000 bytes through the authenticated Flask
backend. Flask relays only to a direct Wi-Fi firmware connection; the USB
bridge and PWA do not send speaker audio. The app requires direct firmware mode,
a status younger than one second, `audio_ok=true`, and `operation_enabled=true`,
and does not retry after a partial/uncertain result. Firmware keeps this
endpoint closed until its external GPIO map, MAX98357A, speaker, supply and
I²S initialization are verified. Even
an `audio_ok=true` report means firmware initialization only; it does not prove
that sound is audible. A completed firmware response confirms its PCM byte
count, not acoustic output. Leaving ESP32 mode cancels the app's in-progress
export/transfer when possible. If firmware has already accepted all PCM, the
app has no remote stop command and playback may finish. This is output only:
the app does not request
microphone access, and question input remains iOS keyboard Dictation.

## Backend connection

Open settings and enter the Flask base URL, a Ro Sight account, and optional
tunnel Basic Auth credentials. The app account and tunnel credentials are
separate. The account password remains in app memory; the base URL is saved by
iOS app storage. Do not enter `127.0.0.1` on the phone because that points back
to the phone. A LAN URL works only when Flask is bound to the computer's LAN
interface and the firewall permits the connection. Otherwise use a reachable,
trusted HTTPS URL. Avoid sending account credentials over plain HTTP on an
untrusted network.

## Build and install

The workflow definition at `.github/workflows/ios-lidar-test.yml` runs on pushes
that change the native app or workflow. It generates the Xcode project with
XcodeGen, runs eleven LiDAR-depth checks, builds and launches the app in an iPhone
16 Simulator, exercises iPhone-mode navigation and the LiDAR readout, checks
the native cloud-account form with two UI tests, saves a launch screenshot, and packages an unsigned device IPA
retained for three days. It does not sign the app.

The original repository is read-only for the connected account, so the app-only
branch was pushed to the public fork
[`npgb2505/Mini-AI-Camera-Module`](https://github.com/npgb2505/Mini-AI-Camera-Module)
as `codex/ios-lidar-test-2026-10-11`. No KiCad files were included. GitHub
Actions run [39881683311](https://github.com/npgb2505/Mini-AI-Camera-Module/actions/runs/39881683311)
succeeded in 6m49s, passed eleven depth checks and two UI tests: one enters iPhone mode,
finds the LiDAR readout, and returns to the mode chooser; the other checks the
native cloud-account form. It launched the app in the simulator, built the
device app, and created `RoSight-unsigned-ipa`.
The IPA is saved at
`../../../04_App/ios_builds/2026-10-23-run-39881683311/RoSight-unsigned.ipa`
(675,594 bytes, SHA-256 `B7D21FAE36DB7A26D71F0B4726DBB0D3C919B14A2A9732B19F9C1BFCDBDA1DB0`);
the simulator launch image is at
`../../../04_App/ios_builds/2026-10-23-run-39881683311-simulator/launch.png`.
The IPA is arm64, targets iOS 16.0+, and is unsigned; AltServer on Windows must
sign it before installation.
Standard hosted runners are free for public repositories; private repositories
use the account's included quota. See the no-Mac [installation guide](INSTALL_VI.md).

The current development host is Windows and has neither `xcodebuild` nor the
Swift toolchain. The macOS workflow has compiled the current native source,
including CoreBluetooth, LiDAR, and speech playback. Apple desktop iTunes
12.13.11.1 and Apple Mobile Device Support 20.0.0.35 are now installed on the
Windows host, and Apple Mobile Device Service is running automatically. Windows
still does not enumerate an iPhone USB device and iTunes shows no device, so
the IPA has not been signed or installed on a physical iPhone. Camera
permission, ARKit depth, BLE, audio, and ESP32 behavior remain unverified on
hardware.

An unsigned IPA must be signed for installation. AltServer/AltStore can
sideload it with a free Apple Account; follow the current AltStore instructions
for setup and refresh timing. See the step-by-step [Vietnamese free install and
sideload guide](INSTALL_VI.md).

## Verification limits

Source review and CI confirm the app's request paths, JSON fields,
frame-sequence checks, normalized Flask YOLO boxes mapped to a confidence-
filtered median from the matching ARKit frame's depth map, synthetic
depth-buffer handling, simulator launch,
and navigation into the iPhone-mode readout. The simulator does not provide the
iPhone 12 Pro Max LiDAR sensor; it cannot confirm camera permissions or physical
LiDAR alignment and accuracy, device standby behavior, JPEG cadence, speech
playback/routing, or Vision latency on hardware. The proximity threshold and speech behavior also
have not been calibrated on an iPhone. The app has not been installed on a
physical iPhone or connected ESP32. Do not treat simulator launch or an
unsigned IPA build as a real-device test.
