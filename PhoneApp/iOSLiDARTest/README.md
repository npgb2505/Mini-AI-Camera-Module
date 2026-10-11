# Ro Sight native iPhone app

The app opens with a mode chooser. Camera access starts only after choosing a
mode, so an ESP32-only session does not open the iPhone camera.

## ESP32 mode

This mode shows a JPEG and fresh device detections/ToF telemetry, then lets the
user ask Vision about a new ESP32 frame. The phone talks to the existing Flask
backend; it does not connect directly to USB or bypass the backend session.
The backend can reach the board through either of its existing transports:

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

The native app reads `GET /api/device/status`. It treats the device as ready
only when the backend reports `source=device`, `device_connected=true`,
`operation_enabled=true`, a live camera, a positive frame sequence, and a
camera age of at most 350 ms. Standby, unknown operation state, a stale frame,
or a disconnected device disables asking and hides the old preview.

For preview, the app requests `GET /api/device/frame?frame_seq=…`, verifies the
JPEG bytes and `X-Frame-Seq`, and matches the returned sequence to the status
snapshot. The USB bridge requires the exact requested sequence. Direct
firmware Wi-Fi may return a newer sequence because it fetches the latest image.
YOLO detections are shown only when their frame sequence and freshness match
the displayed image. ToF is shown only when the backend marks the reading as
device-originated and fresh; zones are separate sensor readings and are not
assigned to objects in the JPEG.

When the user asks a question, the app sends JSON to
`POST /api/device/ask` with `question` and `trigger: "manual"`; it does not send
the preview JPEG as the Vision input. Flask obtains a current ESP32 image and
rechecks operation state, camera/frame age, and available sensor context before
calling the configured Vision provider. The backend remains the final
freshness check, so a frame that expires after the status response is rejected
instead of being sent to Vision.

## iPhone-only mode

Choose **Chỉ dùng iPhone** to use the rear camera and native ARKit scene depth
without an ESP32. The intended LiDAR target is iPhone 12 Pro and later LiDAR
models. Unsupported devices display an ARKit capability message.

With YOLO enabled, the app sends a portrait JPEG to `POST /api/detect` and maps
the backend's normalized `[x1, y1, x2, y2]` box center back to the landscape
ARKit depth map. It samples a small neighborhood and uses only valid depth
values. YOLO detections and their paired depth estimates are hidden once the
processed frame is more than 2.5 seconds old; the live camera may have advanced
since that YOLO frame. This is an estimate that still needs a known-distance
check on the phone. A typed question is enabled only while the local camera
frame is at most 2.5 seconds old; it sends that iPhone JPEG and the question as
multipart form data to `POST /api/analyze`. Vision can fall back to the
backend's YOLO summary when no Vision provider is configured.

For voice input, the user can tap the iPhone keyboard's Dictation microphone.
The native app itself does not record audio or request microphone permission:
iOS turns speech into text, and the app sends the resulting question text to
the Flask backend. iOS Dictation behavior follows the user's iPhone settings.

After an answer appears in either mode, tap **Đọc câu trả lời** to have the
iPhone read it with `AVSpeechSynthesizer`, or tap **Dừng đọc** to stop. Speech
uses the iPhone playback audio session and speaker route; it does not use or
verify the ESP32 MAX98357A amplifier. This is output only: the app does not
request microphone access for speech, and question input remains the iOS
keyboard's Dictation.

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

The repository workflow at `.github/workflows/ios-lidar-test.yml` runs on pushes
that change the native app or workflow, and also supports manual runs from
GitHub Actions once the workflow file is present on the repository's default
branch. It generates the Xcode project with XcodeGen, builds an unsigned iOS
app, and packages an IPA artifact retained for three days. It does not sign the
app.

The current development host is Windows and has neither `xcodebuild` nor the
Swift toolchain, so the current native source changes, including speech
playback, have not been compiled.

An unsigned IPA must be signed for installation. AltServer/AltStore can
sideload it with a free Apple Account; follow the current AltStore instructions
for setup and refresh timing. See the step-by-step [Vietnamese free install and
sideload guide](INSTALL_VI.md).

## Verification limits

Source review can confirm the app's request paths, JSON fields, frame-sequence
checks, and ARKit coordinate transform. It cannot confirm camera permissions,
LiDAR alignment, device standby behavior, JPEG cadence, speech playback/routing,
or Vision latency on physical hardware. This native app has not been run on an
iPhone or ESP32 as part of the current local changes. Do not treat source review
or an unsigned IPA build as a real-device test.
