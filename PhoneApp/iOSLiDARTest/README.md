# Ro Sight iPhone test app

This is a small native iOS test app for an iPhone with LiDAR. It shows the
rear-camera view, reads ARKit scene depth, sends one JPEG frame per second to
the existing Flask YOLO endpoint, samples LiDAR depth at the center of each
YOLO bounding box, and can send a typed question and the latest frame to the
existing Vision endpoint. The app does not use a separate microphone module.
The iPhone keyboard's built-in dictation can be used in the question field.

Depth-to-box association is a first-pass estimate for the portrait rear-camera
orientation. Check the distance against known objects on the iPhone before
depending on it. If the depth map has low confidence or no valid sample, the
app displays that the distance is unavailable.

## Create the iPhone install file

The GitHub Actions workflow at the repository root creates an unsigned iOS
package on a hosted macOS runner. It needs no Apple signing certificate or
paid developer membership. After this folder and the workflow are pushed to
the repository, open Actions, run “Build iOS test IPA”, and download the
RoSight-unsigned-ipa artifact.

An unsigned package cannot be opened by itself. On Windows, install AltServer
using the Windows instructions from AltStore, connect and trust the iPhone,
then hold Shift while clicking AltServer in the system tray and choose
“Sideload .ipa…” to select the downloaded package. AltServer signs and
installs it with the free Apple Account. Enable Developer Mode on the iPhone
if prompted. Free sideloaded apps expire after seven days; connect the iPhone
to AltServer and refresh or reinstall them before they expire.

## Connect the app to the existing backend

Run `start_phone.ps1` on the Windows computer and enter its generated HTTPS
tunnel URL in the iPhone settings. The current scripts bind Flask to
`127.0.0.1`, so a LAN IP will not work by default. LAN access requires
intentionally binding Flask to the computer's network interface and allowing
the port through Windows Firewall; use HTTPS on a trusted network because
Basic Auth over plain HTTP does not encrypt the credentials. Never enter
`127.0.0.1` on the iPhone; that address points back to the phone. If the
tunnel uses Basic Auth, enter its username and password separately from the
Ro Sight account. Passwords stay in the app's current session.

Create an account in Ro Sight first, or use an account that already exists.
Enter that app username and password in the iPhone settings. The app signs in
through `POST /api/auth/login` and keeps the session cookie in its current
network session. These credentials are kept in memory by the app. If the
tunnel itself asks for HTTP Basic Auth, enter those separate credentials in
the Basic Auth fields.

Press the play button to send live frames to `POST /api/detect`. The backend
returns normalized YOLO boxes; the app samples LiDAR at each box center using
the same normalized image coordinates. Ask a typed question to send the latest
frame and question to `POST /api/analyze`. This is the Flask endpoint used by
the existing app. The server needs its YOLO model, plus an available Vision
provider (local Ollama or the configured OpenAI API) for a Vision LLM answer.
If Vision is unavailable, the app displays the backend's YOLO summary and says
that Vision was not called.
