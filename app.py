from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import secrets
import sqlite3
import sys
import time
from contextlib import contextmanager
from collections import Counter, deque
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener, urlopen
from urllib.parse import urlparse, urlunparse

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory, session, stream_with_context
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.datastructures import FileStorage
from werkzeug.security import check_password_hash, generate_password_hash
from flask.sessions import SecureCookieSessionInterface


ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT
DIST = ROOT / "dist"
load_dotenv(ROOT / ".env")
ASSISTANT_PROFILE = json.loads((ROOT / "assistant_profile.json").read_text(encoding="utf-8"))
ASSISTANT_PROFILE_VERSION = ASSISTANT_PROFILE["version"]
SHARED_RUNTIME = ASSISTANT_PROFILE["shared_runtime"]
SHARED_ASSISTANT_URL = SHARED_RUNTIME["web_app_url"]
SHARED_ASSISTANT_MODEL = ASSISTANT_PROFILE["models"][SHARED_RUNTIME["canonical_llm_model_key"]]
SHARED_REALTIME_STT_MODEL = ASSISTANT_PROFILE["models"][SHARED_RUNTIME["realtime_transcription_model_key"]]
ASSISTANT_CORE_PROMPT = ASSISTANT_PROFILE["prompts"]["core"]
ASSISTANT_VISION_PROMPT = ASSISTANT_PROFILE["prompts"]["vision"]

DATA_HOME = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "RoPhone"
DATA_HOME.mkdir(parents=True, exist_ok=True)
DB_PATH = Path(os.environ.get("RO_DATABASE", DATA_HOME / "profiles.sqlite3"))
SECRET_PATH = DATA_HOME / "session-secret"
if not SECRET_PATH.exists():
    SECRET_PATH.write_text(secrets.token_urlsafe(48), encoding="utf-8")
    try:
        SECRET_PATH.chmod(0o600)
    except OSError:
        pass

MODEL_PATH = Path(os.environ.get("YOLO_MODEL", PROJECT_ROOT / "yolo11n.pt")).expanduser()
def parse_yolo_image_size(value: str) -> int | list[int]:
    parts = [part.strip() for part in value.replace("x", ",").lower().split(",") if part.strip()]
    if len(parts) == 1:
        return int(parts[0])
    if len(parts) == 2:
        return [int(parts[0]), int(parts[1])]
    raise ValueError("RO_YOLO_IMAGE_SIZE must be an integer or HEIGHT,WIDTH")


YOLO_IMAGE_SIZE = parse_yolo_image_size(os.environ.get("RO_YOLO_IMAGE_SIZE", "640"))
YOLO_CONFIDENCE = float(os.environ.get("RO_YOLO_CONFIDENCE", "0.28"))
def parse_yolo_class_confidence(value: str) -> dict[str, float]:
    if not value.strip():
        return {}
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("RO_YOLO_CLASS_CONFIDENCE must be a JSON object")
    thresholds = {}
    for label, threshold in parsed.items():
        if not isinstance(label, str) or not label.strip():
            raise ValueError("RO_YOLO_CLASS_CONFIDENCE labels must be non-empty strings")
        number = float(threshold)
        if not 0.01 <= number <= 0.99:
            raise ValueError(f"Class confidence for {label!r} must be between 0.01 and 0.99")
        thresholds[label] = number
    return thresholds


YOLO_CLASS_CONFIDENCE = parse_yolo_class_confidence(
    os.environ.get("RO_YOLO_CLASS_CONFIDENCE", "")
)
YOLO_INFERENCE_CONFIDENCE = min([YOLO_CONFIDENCE, *YOLO_CLASS_CONFIDENCE.values()])
ZONE_MODEL_VALUE = os.environ.get("RO_ZONE_MODEL", "").strip()
ZONE_MODEL_PATH = Path(ZONE_MODEL_VALUE).expanduser() if ZONE_MODEL_VALUE else None
ZONE_IMAGE_SIZE = max(32, int(os.environ.get("RO_ZONE_IMAGE_SIZE", "96")))
ZONE_HAZARD_THRESHOLD = min(0.99, max(0.01, float(os.environ.get("RO_ZONE_THRESHOLD", "0.5"))))
OBJECT_CLASSIFIER_VALUE = os.environ.get("RO_OBJECT_CLASSIFIER_MODEL", "").strip()
OBJECT_CLASSIFIER_PATH = Path(OBJECT_CLASSIFIER_VALUE).expanduser() if OBJECT_CLASSIFIER_VALUE else None
OBJECT_CLASSIFIER_IMAGE_SIZE = max(32, int(os.environ.get("RO_OBJECT_CLASSIFIER_IMAGE_SIZE", "128")))
OBJECT_CLASSIFIER_THRESHOLD = min(0.99, max(0.01, float(os.environ.get("RO_OBJECT_CLASSIFIER_THRESHOLD", "0.65"))))
OBJECT_CLASSIFIER_CONTEXT = min(1.0, max(0.0, float(os.environ.get("RO_OBJECT_CLASSIFIER_CONTEXT", "0.15"))))
ESP_DETECTION_PATH = Path(os.environ.get(
    "ESP_DETECTION_PATH", PROJECT_ROOT / "08_Thu_vien" / "third_party" / "esp-detection"
)).expanduser()
VISION_MODEL = os.environ.get("OPENAI_VISION_MODEL", ASSISTANT_PROFILE["models"]["openai_vision_fallback"])
TRANSCRIPTION_MODEL = os.environ.get("OPENAI_TRANSCRIPTION_MODEL", ASSISTANT_PROFILE["models"]["transcription_file"])
LOCAL_VISION_MODEL = os.environ.get("RO_LOCAL_VISION_MODEL", ASSISTANT_PROFILE["models"]["laptop_vision"])
LOCAL_OLLAMA_URL = "http://127.0.0.1:11434"
DEVICE_BRIDGE_URL = os.environ.get("RO_DEVICE_BRIDGE_URL", "http://127.0.0.1:8787").rstrip("/")
DEVICE_FIRMWARE_URL = os.environ.get("RO_DEVICE_FIRMWARE_URL", "").rstrip("/")
PATH_INFERENCE_URL = os.environ.get("RO_PATH_INFERENCE_URL", "http://127.0.0.1:8794").rstrip("/")
PATH_INFERENCE_TOKEN = os.environ.get("RO_VISION_TOKEN", "").strip()
SEGMENTATION_URL = os.environ.get("RO_SEGMENTATION_URL", "http://127.0.0.1:8796").rstrip("/")
SEGMENTATION_TOKEN = os.environ.get("RO_SEGMENTATION_TOKEN", PATH_INFERENCE_TOKEN).strip()
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_DEVICE_FRAME_BYTES = 2 * 1024 * 1024
MAX_PATH_JPEG_BYTES = 2 * 1024 * 1024
MAX_PATH_IMAGE_PIXELS = 1280 * 960
MAX_DEVICE_SPEAKER_PCM_BYTES = 256_000
DEVICE_SPEAKER_SAMPLE_RATE_HZ = 16_000
DEVICE_SPEAKER_MAX_DURATION_MS = 8_000
FIRMWARE_EVENT_FRESH_MS = 350
FIRMWARE_DETECTION_DISPLAY_FRESH_MS = 750
FIRMWARE_CAMERA_FRAME_FRESH_MS = 1000
BUTTON_EVENT_FRESH_MS = 10000
BUTTON_EVENT_IDS = {"mode", "capture_image", "ask_llm"}
ALLOWED_AUDIO = {"audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/m4a"}
ASSET_MIME = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

logging.basicConfig(level=os.environ.get("RO_LOG_LEVEL", "INFO"))
log = logging.getLogger("ro")
app = Flask(__name__)
app.secret_key = SECRET_PATH.read_text(encoding="utf-8").strip()
app.config.update(
    SESSION_COOKIE_NAME="ro_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_PATH="/",
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,
    MAX_CONTENT_LENGTH=MAX_IMAGE_BYTES + MAX_AUDIO_BYTES + 1024 * 1024,
)
ACCESS_USERNAME = os.environ.get("RO_ACCESS_USERNAME", "ro")
ACCESS_PASSWORD = os.environ.get("RO_ACCESS_PASSWORD", "")


class RequestAwareCookieSession(SecureCookieSessionInterface):
    def get_cookie_secure(self, app):
        return bool(request.is_secure)


app.session_interface = RequestAwareCookieSession()

_firmware_events_lock = Lock()
_firmware_events = {
    "detections": None,
    "detections_at": None,
    "corridor_decision": None,
    "corridor_decision_at": None,
    "button_event": None,
    "button_event_at": None,
    "connected": False,
}
_firmware_button_event_history = deque(maxlen=64)
_firmware_ws_started = False
# The development tunnel adds one trusted proxy hop and forwards HTTPS/host headers.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


class StaleDeviceContextError(Exception):
    pass

MODEL_LOCK = Lock()
DETECTOR_INFERENCE_LOCK = Lock()
ZONE_MODEL_LOCK = Lock()
OBJECT_CLASSIFIER_LOCK = Lock()
_detector = None
_zone_classifier = None
_object_classifier = None
_object_classifier_class_names: list[str] = []

LABELS_VI = {
    "person": "người", "vehicle": "phương tiện", "obstacle": "chướng ngại vật",
    "stairs": "cầu thang hoặc bậc thềm", "traffic_signal": "đèn giao thông",
    "crossing_cue": "tín hiệu qua đường", "bicycle": "xe đạp", "car": "ô tô", "motorcycle": "xe máy",
    "airplane": "máy bay", "bus": "xe buýt", "train": "tàu hỏa", "truck": "xe tải",
    "boat": "thuyền", "traffic light": "đèn giao thông", "fire hydrant": "trụ cứu hỏa",
    "stop sign": "biển dừng", "parking meter": "đồng hồ đỗ xe", "bench": "ghế băng",
    "bird": "chim", "cat": "mèo", "dog": "chó", "horse": "ngựa", "sheep": "cừu",
    "cow": "bò", "elephant": "voi", "bear": "gấu", "zebra": "ngựa vằn",
    "giraffe": "hươu cao cổ", "backpack": "ba lô", "umbrella": "ô", "handbag": "túi xách",
    "tie": "cà vạt", "suitcase": "va li", "frisbee": "đĩa ném", "skis": "ván trượt tuyết",
    "snowboard": "ván trượt tuyết", "sports ball": "bóng", "kite": "diều",
    "baseball bat": "gậy bóng chày", "baseball glove": "găng bóng chày", "skateboard": "ván trượt",
    "surfboard": "ván lướt sóng", "tennis racket": "vợt tennis", "bottle": "chai",
    "wine glass": "ly rượu", "cup": "cốc", "fork": "nĩa", "knife": "dao",
    "spoon": "thìa", "bowl": "bát", "banana": "chuối", "apple": "táo",
    "sandwich": "bánh mì kẹp", "orange": "cam", "broccoli": "bông cải xanh",
    "carrot": "cà rốt", "hot dog": "xúc xích", "pizza": "pizza", "donut": "bánh vòng",
    "cake": "bánh kem", "chair": "ghế", "couch": "ghế sofa", "potted plant": "chậu cây",
    "bed": "giường", "dining table": "bàn ăn", "toilet": "bồn cầu", "tv": "ti vi",
    "laptop": "máy tính xách tay", "mouse": "chuột máy tính", "remote": "điều khiển từ xa",
    "keyboard": "bàn phím", "cell phone": "điện thoại", "microwave": "lò vi sóng",
    "oven": "lò nướng", "toaster": "máy nướng bánh", "sink": "bồn rửa", "refrigerator": "tủ lạnh",
    "book": "sách", "clock": "đồng hồ", "vase": "bình hoa", "scissors": "kéo",
    "teddy bear": "gấu bông", "hair drier": "máy sấy tóc", "toothbrush": "bàn chải đánh răng",
}


def connect_db():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA journal_mode=WAL")
    return connection


@contextmanager
def database():
    connection = connect_db()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def init_db():
    with database() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE COLLATE NOCASE,
              password_hash TEXT NOT NULL,
              display_name TEXT NOT NULL,
              text_scale REAL NOT NULL DEFAULT 1.0,
              high_contrast INTEGER NOT NULL DEFAULT 0,
              speak_answers INTEGER NOT NULL DEFAULT 0,
              voice_rate REAL NOT NULL DEFAULT 0.92,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              question TEXT NOT NULL DEFAULT '',
              answer TEXT NOT NULL,
              labels_json TEXT NOT NULL DEFAULT '[]',
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS history_user_created ON history(user_id, created_at DESC);
            """
        )


init_db()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def user_payload(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
    }


def profile_payload(row):
    return {
        "display_name": row["display_name"],
        "text_scale": row["text_scale"],
        "high_contrast": bool(row["high_contrast"]),
        "speak_answers": bool(row["speak_answers"]),
        "voice_rate": row["voice_rate"],
    }


def current_user_row():
    user_id = session.get("user_id")
    if not user_id:
        return None
    with database() as db:
        return db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def require_user():
    row = current_user_row()
    if row is None:
        return None, (jsonify(error="Bạn cần đăng nhập để tiếp tục."), 401)
    return row, None


@app.before_request
def protect_temporary_phone_session():
    if not ACCESS_PASSWORD:
        return None
    auth = request.authorization
    if auth and secrets.compare_digest(auth.username or "", ACCESS_USERNAME) and secrets.compare_digest(auth.password or "", ACCESS_PASSWORD):
        return None
    return Response(
        "Phiên dùng thử riêng tư.\n",
        status=401,
        headers={"WWW-Authenticate": 'Basic realm="Ro private", charset="UTF-8"', "Cache-Control": "no-store"},
        content_type="text/plain; charset=utf-8",
    )


@app.before_request
def protect_state_changes():
    if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return None
    origin = request.headers.get("Origin")
    if origin and origin.rstrip("/") != request.host_url.rstrip("/"):
        return jsonify(error="Yêu cầu không hợp lệ."), 403
    return None


@app.after_request
def security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    if request.is_secure:
        response.headers.setdefault("Strict-Transport-Security", "max-age=86400")
    return response


def local_vision_ready():
    try:
        with urlopen(f"{LOCAL_OLLAMA_URL}/api/tags", timeout=0.4) as response:
            models = json.load(response).get("models", [])
        return any(item.get("name") == LOCAL_VISION_MODEL for item in models)
    except Exception:
        return False


def active_vision_provider():
    if local_vision_ready():
        return "ollama"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    return None


def device_bridge_request(path, *, accept="application/json"):
    """Read a bounded resource from the laptop-side ESP32 HTTP bridge."""
    req = Request(f"{DEVICE_BRIDGE_URL}{path}", headers={"Accept": accept})
    return urlopen(req, timeout=2.5)


def firmware_ws_url():
    parsed = urlparse(DEVICE_FIRMWARE_URL)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunparse((scheme, parsed.netloc, "/ws", "", "", ""))


def valid_firmware_button_event(event):
    if not isinstance(event, dict):
        return False
    allowed_fields = {
        "schema_version", "origin", "device_id", "boot_id", "seq", "t_ms",
        "timestamp_source", "boot_id_source", "utc_ms", "type", "button_id",
        "action", "pressed_at_ms", "press_id", "operation_enabled",
    }
    return (
        set(event).issubset(allowed_fields)
        and event.get("schema_version") == "1.0"
        and event.get("origin") == "device"
        and event.get("type") == "button_event"
        and event.get("button_id") in BUTTON_EVENT_IDS
        and event.get("action") == "pressed"
        and isinstance(event.get("device_id"), str) and 1 <= len(event["device_id"]) <= 64
        and isinstance(event.get("boot_id"), str) and 1 <= len(event["boot_id"]) <= 64
        and isinstance(event.get("seq"), int) and not isinstance(event.get("seq"), bool) and event["seq"] >= 0
        and isinstance(event.get("t_ms"), int) and not isinstance(event.get("t_ms"), bool) and event["t_ms"] >= 0
        and isinstance(event.get("pressed_at_ms"), int)
        and not isinstance(event.get("pressed_at_ms"), bool) and event["pressed_at_ms"] >= 0
        and isinstance(event.get("press_id"), int)
        and not isinstance(event.get("press_id"), bool) and 1 <= event["press_id"] <= 4294967295
        and isinstance(event.get("operation_enabled"), bool)
        and ("timestamp_source" not in event or event["timestamp_source"] in {"device_clock", "host_monotonic", "simulated"})
        and ("boot_id_source" not in event or event["boot_id_source"] in {"device", "host_bridge", "simulator"})
        and ("utc_ms" not in event or event["utc_ms"] is None
             or isinstance(event["utc_ms"], int) and not isinstance(event["utc_ms"], bool) and event["utc_ms"] >= 0)
    )


def press_id_after(candidate, reference):
    """Return whether a nonzero uint32 press ID follows another within half-range."""
    delta = (candidate - reference) & 0xFFFFFFFF
    return delta != 0 and delta < 0x80000000


def store_firmware_event(event):
    if not isinstance(event, dict):
        return False
    event_type = event.get("type")
    if (event.get("schema_version") != "1.0" or event.get("origin") != "device"
            or event_type not in {"detections", "corridor_decision", "button_event"}):
        return False
    if event_type == "button_event" and not valid_firmware_button_event(event):
        return False
    with _firmware_events_lock:
        if event_type == "button_event":
            previous = _firmware_events["button_event"]
            if (isinstance(previous, dict)
                    and previous.get("device_id") == event.get("device_id")
                    and previous.get("boot_id") == event.get("boot_id")
                    and not press_id_after(event["press_id"], previous.get("press_id", 0))):
                return False
            if (isinstance(previous, dict)
                    and (previous.get("device_id"), previous.get("boot_id"))
                    != (event.get("device_id"), event.get("boot_id"))):
                _firmware_button_event_history.clear()
            stored_event = dict(event)
            _firmware_button_event_history.append((stored_event, time.monotonic()))
        else:
            stored_event = dict(event)
        _firmware_events[event_type] = stored_event
        _firmware_events[f"{event_type}_at"] = time.monotonic()
    return True


def device_operation_enabled(status):
    if not isinstance(status, dict):
        return None
    value = status.get("operation_enabled")
    if isinstance(value, bool):
        return value
    health = status.get("device_health")
    if isinstance(health, dict) and isinstance(health.get("operation_enabled"), bool):
        return health["operation_enabled"]
    event = status.get("button_event")
    if isinstance(event, dict) and isinstance(event.get("operation_enabled"), bool):
        return event["operation_enabled"]
    return None


def firmware_tof_zones(event, health):
    """Return only validated, physical-device ToF readings from a fresh scan."""
    if (not isinstance(event, dict) or not isinstance(health, dict)
            or health.get("tof_ok") is not True
            or event.get("origin") != "device"
            or event.get("input_origins") != ["device"]
            or event.get("device_id") != health.get("device_id")
            or event.get("boot_id") != health.get("boot_id")):
        return []
    tof_seq = event.get("tof_seq")
    if not isinstance(tof_seq, int) or isinstance(tof_seq, bool) or tof_seq < 1:
        return []
    lanes = event.get("lanes")
    expected_zones = ("left", "center", "right")
    if not isinstance(lanes, list) or len(lanes) != len(expected_zones):
        return []
    zones = []
    for lane, expected_zone in zip(lanes, expected_zones):
        if (not isinstance(lane, dict) or lane.get("zone") != expected_zone
                or not isinstance(lane.get("tof_valid"), bool)):
            return []
        distance_mm = lane.get("nearest_mm")
        if lane["tof_valid"]:
            if (not isinstance(distance_mm, int) or isinstance(distance_mm, bool)
                    or distance_mm < 1):
                return []
            distance_cm = distance_mm / 10
        else:
            if distance_mm is not None:
                return []
            distance_cm = None
        zones.append({
            "zone": expected_zone,
            "nearest_cm": distance_cm,
            "tof_valid": lane["tof_valid"],
            "blocked_by_camera": lane.get("camera_blocked") is True,
            "status": lane.get("status", "unknown"),
        })
    return zones


def operation_paused_response(status):
    if device_operation_enabled(status) is False:
        return jsonify(error="Thiết bị đang tạm dừng. Bật lại bằng nút mode trước khi chụp hoặc hỏi Vision."), 409
    return jsonify(error="Chưa nhận được trạng thái hoạt động của thiết bị. Chưa chụp ảnh hoặc gửi tới Vision."), 409


def send_firmware_product_command(command, **fields):
    """Send one bounded v1 product command and wait for its matching ACK."""
    if not DEVICE_FIRMWARE_URL:
        raise RuntimeError("firmware_command_transport_unavailable")
    try:
        import websocket
    except ImportError as exc:
        raise RuntimeError("websocket_client_unavailable") from exc

    host = urlparse(DEVICE_FIRMWARE_URL).hostname
    request_id = secrets.token_hex(16)
    client = websocket.create_connection(
        firmware_ws_url(), timeout=2.5, enable_multithread=True,
        http_no_proxy=[host] if host else [],
    )
    try:
        message = {"type": command, "request_id": request_id, **fields}
        client.send(json.dumps(message, separators=(",", ":")))
        deadline = time.monotonic() + 2.5
        while time.monotonic() < deadline:
            try:
                payload = client.recv()
            except websocket.WebSocketTimeoutException:
                continue
            if not payload:
                break
            try:
                ack = json.loads(payload)
            except (TypeError, ValueError):
                continue
            if not isinstance(ack, dict):
                continue
            if (ack.get("type") != "command_ack" or ack.get("request_id") != request_id
                    or ack.get("command") != command):
                continue
            if ack.get("ok") is not True:
                raise RuntimeError(f"{command}_rejected:{ack.get('error_code') or 'unknown'}")
            return ack
        raise TimeoutError(f"{command}_ack_timeout")
    finally:
        try:
            client.close()
        except Exception:
            pass


def send_firmware_ocr_request():
    """Send the v1 request_ocr phone command and wait for its matching ACK."""
    return send_firmware_product_command("request_ocr")


def ensure_firmware_events():
    """Maintain one WebSocket subscription to the IDF v1 event stream."""
    global _firmware_ws_started
    with _firmware_events_lock:
        if not DEVICE_FIRMWARE_URL or _firmware_ws_started:
            return
        _firmware_ws_started = True

    def worker():
        global _firmware_ws_started
        try:
            import websocket
        except ImportError:
            log.warning("Direct ESP32 mode needs websocket-client; REST status and JPEG remain available")
            with _firmware_events_lock:
                _firmware_ws_started = False
            return
        while DEVICE_FIRMWARE_URL:
            client = None
            try:
                host = urlparse(DEVICE_FIRMWARE_URL).hostname
                client = websocket.create_connection(
                    firmware_ws_url(), timeout=3, enable_multithread=True,
                    http_no_proxy=[host] if host else [],
                )
                client.settimeout(1)
                with _firmware_events_lock:
                    _firmware_events["connected"] = True
                while True:
                    try:
                        payload = client.recv()
                    except websocket.WebSocketTimeoutException:
                        continue
                    if not payload:
                        break
                    try:
                        event = json.loads(payload)
                    except (TypeError, ValueError):
                        continue
                    if not isinstance(event, dict):
                        continue
                    if not store_firmware_event(event):
                        continue
            except Exception as exc:
                log.debug("ESP32 firmware WebSocket unavailable: %s", exc)
            finally:
                if client is not None:
                    try:
                        client.close()
                    except Exception:
                        pass
                with _firmware_events_lock:
                    _firmware_events["connected"] = False
            time.sleep(2)

    from threading import Thread
    Thread(target=worker, name="ro-esp32-events", daemon=True).start()


def firmware_request(path, *, accept="application/json", method="GET", body=None,
                     headers=None, timeout=2.5):
    request_headers = {"Accept": accept, "Cache-Control": "no-cache"}
    if headers:
        request_headers.update(headers)
    req = Request(f"{DEVICE_FIRMWARE_URL}{path}", data=body,
                  headers=request_headers, method=method)
    return build_opener(ProxyHandler({})).open(req, timeout=timeout)


def path_inference_request(path, *, method="GET", body=None, timeout=2.5):
    """Call the loopback Detectron2 service without exposing its token to the PWA."""
    headers = {"Accept": "application/json", "Cache-Control": "no-cache"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if PATH_INFERENCE_TOKEN:
        headers["Authorization"] = f"Bearer {PATH_INFERENCE_TOKEN}"
    req = Request(f"{PATH_INFERENCE_URL}{path}", data=body, headers=headers,
                  method=method)
    return build_opener(ProxyHandler({})).open(req, timeout=timeout)


def segmentation_request(path, *, method="GET", body=None, timeout=2.5):
    """Proxy requests to the local semantic-mask server without exposing its token."""
    headers = {"Accept": "application/json", "Cache-Control": "no-cache"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if SEGMENTATION_TOKEN:
        headers["Authorization"] = f"Bearer {SEGMENTATION_TOKEN}"
    req = Request(f"{SEGMENTATION_URL}{path}", data=body, headers=headers, method=method)
    return build_opener(ProxyHandler({})).open(req, timeout=timeout)


def firmware_status_snapshot():
    ensure_firmware_events()
    with firmware_request("/api/status") as response:
        health = json.load(response)
    if (not isinstance(health, dict) or health.get("type") != "device_health"
            or health.get("origin") != "device"
            or not isinstance(health.get("device_id"), str) or not health["device_id"]
            or not isinstance(health.get("boot_id"), str) or not health["boot_id"]
            or not isinstance(health.get("t_ms"), int) or isinstance(health.get("t_ms"), bool)
            or health["t_ms"] < 0
            or not isinstance(health.get("operation_enabled"), bool)):
        raise ValueError("unexpected_firmware_status_contract")
    with _firmware_events_lock:
        events = dict(_firmware_events)
        button_event_history = list(_firmware_button_event_history)

    now = time.monotonic()
    def age_ms(received_at):
        return max(0, int((now - received_at) * 1000)) if received_at is not None else None

    def source_age_ms(event):
        if (not isinstance(event, dict)
                or event.get("device_id") != health["device_id"]
                or event.get("boot_id") != health["boot_id"]
                or not isinstance(event.get("t_ms"), int) or isinstance(event.get("t_ms"), bool)
                or event["t_ms"] < 0):
            return None
        source_age = health["t_ms"] - event["t_ms"]
        return source_age if source_age >= 0 else None

    detections_event = events["detections"] or {}
    corridor_event = events["corridor_decision"] or {}
    detections_age_ms = source_age_ms(detections_event)
    corridor_age_ms = source_age_ms(corridor_event)
    button_age_ms = age_ms(events["button_event_at"])
    detection_frame_seq = detections_event.get("frame_seq")
    camera_frame_seq = health.get("camera_frame_seq")
    camera_frame_seq_valid = (
        isinstance(camera_frame_seq, int)
        and not isinstance(camera_frame_seq, bool)
        and camera_frame_seq > 0
    )
    detection_frame_matches_camera = (
        camera_frame_seq_valid
        and isinstance(detection_frame_seq, int)
        and not isinstance(detection_frame_seq, bool)
        and detection_frame_seq == camera_frame_seq
    )
    detections_fresh = detections_age_ms is not None and (
        (detections_age_ms <= FIRMWARE_DETECTION_DISPLAY_FRESH_MS
         and detection_frame_matches_camera)
        or (detections_age_ms <= FIRMWARE_EVENT_FRESH_MS
            and not camera_frame_seq_valid)
    )
    corridor_fresh = corridor_age_ms is not None and corridor_age_ms <= FIRMWARE_EVENT_FRESH_MS
    button_event = events["button_event"]
    button_fresh = (
        button_age_ms is not None and button_age_ms <= BUTTON_EVENT_FRESH_MS
        and isinstance(button_event, dict)
        and button_event.get("device_id") == health["device_id"]
        and button_event.get("boot_id") == health["boot_id"]
    )
    button_events = []
    for event, received_at in button_event_history:
        event_age_ms = age_ms(received_at)
        if (event_age_ms is not None and event_age_ms <= BUTTON_EVENT_FRESH_MS
                and event.get("device_id") == health["device_id"]
                and event.get("boot_id") == health["boot_id"]):
            button_events.append({"event": event, "age_ms": event_age_ms})
    detections_frame = detections_event.get("frame_seq") if detections_fresh else None
    corridor_frame = corridor_event.get("frame_seq") if corridor_fresh else None
    if (isinstance(detections_frame, int) and isinstance(corridor_frame, int)
            and not isinstance(detections_frame, bool) and not isinstance(corridor_frame, bool)
            and detections_frame != corridor_frame):
        corridor_fresh = False
    detection_frame_seq = detection_frame_seq if detections_fresh else None
    device_camera_frame_seq = health.get("camera_frame_seq")
    if (isinstance(device_camera_frame_seq, bool)
            or not isinstance(device_camera_frame_seq, int)
            or device_camera_frame_seq < 1):
        device_camera_frame_seq = None
    if device_camera_frame_seq is None and isinstance(detection_frame_seq, int) and not isinstance(detection_frame_seq, bool) and detection_frame_seq > 0:
        device_camera_frame_seq = detection_frame_seq
    device_camera_age_ms = health.get("camera_frame_age_ms")
    if (isinstance(device_camera_age_ms, bool)
            or not isinstance(device_camera_age_ms, int)
            or device_camera_age_ms < 0):
        device_camera_age_ms = detections_age_ms if detections_fresh else None
    camera_frame_seen = health.get("camera_frame_seen") is True or detections_fresh
    zones = firmware_tof_zones(corridor_event, health) if corridor_fresh else []
    operation_enabled = health.get("operation_enabled") if isinstance(health.get("operation_enabled"), bool) else None
    if (button_fresh and isinstance(button_event, dict)
            and isinstance(button_event.get("operation_enabled"), bool)
            and (operation_enabled is None or isinstance(button_event.get("t_ms"), int)
                 and button_event["t_ms"] > health["t_ms"])):
        operation_enabled = button_event["operation_enabled"]
    camera_ok = health.get("camera_ok") is True
    connected = health.get("network_ok") is not False
    camera_frame_live = (
        camera_ok and camera_frame_seen and device_camera_frame_seq is not None
    )
    status = {
        "source": "device",
        "camera_input_state": "live" if camera_frame_live else "unavailable",
        "camera_frame": device_camera_frame_seq if camera_frame_live else None,
        "camera_frame_source": "camera_health" if health.get("camera_frame_seen") is True else "detections_event" if detections_fresh else "unavailable",
        "camera_age_ms": device_camera_age_ms if camera_frame_live else None,
        "camera_error": health.get("last_error"),
        "detections": detections_event.get("items", []) if detections_fresh else [],
        "detections_frame_seq": detection_frame_seq if detections_fresh else None,
        "detections_boot_id": detections_event.get("boot_id") if detections_fresh else None,
        "detections_event_t_ms": detections_event.get("t_ms") if detections_fresh else None,
        "detections_age_ms": detections_age_ms,
        "detector_model": detections_event.get("model_id") if detections_fresh else None,
        "inference_status": detections_event.get("inference_status") if detections_fresh else None,
        "zones": zones,
        "tof_age_ms": corridor_age_ms,
        "tof_frame_seq": corridor_frame if corridor_fresh else None,
        "tof_boot_id": corridor_event.get("boot_id") if corridor_fresh else None,
        "tof_event_t_ms": corridor_event.get("t_ms") if corridor_fresh else None,
        "tof_mode": "device" if any(zone["tof_valid"] and zone["nearest_cm"] is not None for zone in zones) else "unknown",
        "tof_ok": health.get("tof_ok"),
        "audio_ok": health.get("audio_ok"),
        "network_ok": health.get("network_ok"),
        "device_link": {"state": "live" if connected else "unavailable", "transport": "ESP32 firmware Wi-Fi · REST + WebSocket v1"},
        "corridor_decision": corridor_event if corridor_fresh else None,
        "button_event": button_event if button_fresh else None,
        "button_event_age_ms": button_age_ms,
        "button_events": button_events,
        "operation_enabled": operation_enabled,
        "device_health": health,
        "events_connected": events["connected"],
    }
    return {
        "available": True,
        "device_connected": connected,
        "state": "device_connected" if connected else "device_stale",
        "transport": "firmware_wifi",
        "status": status,
    }


@app.get("/api/status")
def api_status():
    local_ready = local_vision_ready()
    openai_ready = bool(os.environ.get("OPENAI_API_KEY"))
    vision_provider = "ollama" if local_ready else "openai" if openai_ready else None
    return jsonify(
        app_name="Rõ",
        app_build=os.environ.get("RO_APP_BUILD", "20261103-sanpo-navigation-live-v1"),
        assistant_profile_version=ASSISTANT_PROFILE_VERSION,
        shared_assistant_url=SHARED_ASSISTANT_URL,
        shared_assistant_model=SHARED_ASSISTANT_MODEL,
        shared_voice_realtime_model=SHARED_REALTIME_STT_MODEL,
        shared_voice_realtime_provider="cloudflare_workers_ai",
        shared_history_store=SHARED_RUNTIME["history_store"],
        shared_voice_audio_transport=SHARED_RUNTIME["audio_transport"],
        shared_voice_speech_synthesis=SHARED_RUNTIME["speech_synthesis"],
        detector_ready=MODEL_PATH.is_file(),
        detector_model=MODEL_PATH.name if MODEL_PATH.is_file() else None,
        detector_image_size=YOLO_IMAGE_SIZE,
        detector_confidence=YOLO_CONFIDENCE,
        detector_inference_confidence=YOLO_INFERENCE_CONFIDENCE,
        detector_class_confidence=YOLO_CLASS_CONFIDENCE or None,
        object_classifier_ready=bool(OBJECT_CLASSIFIER_PATH and OBJECT_CLASSIFIER_PATH.is_file()),
        object_classifier_model=OBJECT_CLASSIFIER_PATH.name if OBJECT_CLASSIFIER_PATH and OBJECT_CLASSIFIER_PATH.is_file() else None,
        object_classifier_threshold=OBJECT_CLASSIFIER_THRESHOLD if OBJECT_CLASSIFIER_PATH else None,
        zone_classifier_ready=bool(ZONE_MODEL_PATH and ZONE_MODEL_PATH.is_file()),
        zone_classifier_model=ZONE_MODEL_PATH.name if ZONE_MODEL_PATH and ZONE_MODEL_PATH.is_file() else None,
        zone_classifier_threshold=ZONE_HAZARD_THRESHOLD if ZONE_MODEL_PATH and ZONE_MODEL_PATH.is_file() else None,
        zone_classifier_image_size=ZONE_IMAGE_SIZE if ZONE_MODEL_PATH and ZONE_MODEL_PATH.is_file() else None,
        openai_configured=openai_ready,
        vision_ready=vision_provider is not None,
        vision_provider=vision_provider,
        vision_model=LOCAL_VISION_MODEL if local_ready else VISION_MODEL if openai_ready else None,
        local_vision_ready=local_ready,
        transcription_ready=openai_ready,
        transcription_model=TRANSCRIPTION_MODEL if openai_ready else None,
        transcription_provider="openai" if openai_ready else None,
        transcription_live_recommended_model=ASSISTANT_PROFILE["models"]["transcription_live"],
        voice_realtime_ready=False,
        voice_browser_fallback_ready=local_ready,
        voice_stt_model=None,
        voice_browser_stt_model="Speech Recognition của trình duyệt (vi-VN)",
        voice_assistant_provider="ollama" if local_ready else None,
        voice_assistant_model=LOCAL_VISION_MODEL if local_ready else None,
        lidar_available=False,
        lidar_note="Trình duyệt web không truy cập được ARKit scene depth.",
        images_saved=False,
    )


@app.get("/api/device/status")
def api_device_status():
    _, error = require_user()
    if error:
        return error
    if DEVICE_FIRMWARE_URL:
        try:
            return jsonify(firmware_status_snapshot())
        except Exception:
            return jsonify(
                available=False,
                device_connected=False,
                state="firmware_offline",
                error="Không tới được firmware ESP32. Kiểm tra Wi-Fi và RO_DEVICE_FIRMWARE_URL.",
            ), 503
    try:
        with device_bridge_request("/api/status") as response:
            status = json.load(response)
    except Exception:
        return jsonify(
            available=False,
            device_connected=False,
            state="bridge_offline",
            error="Chưa kết nối bridge thiết bị. Hãy khởi động bridge USB trên máy tính rồi thử làm mới.",
        ), 503

    is_device = status.get("source") == "device"
    link_state = (status.get("device_link") or {}).get("state")
    connected = is_device and link_state == "live"
    return jsonify(
        available=True,
        device_connected=connected,
        state="device_connected" if connected else "device_stale" if is_device else "no_device",
        status=status,
    )


@app.post("/api/device/command")
def api_device_command():
    _, error = require_user()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    command = payload.get("command")
    if command == "set_volume":
        value = payload.get("value")
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
            return jsonify(error="Âm lượng phải là số nguyên từ 0 đến 100."), 400
        fields = {"value": value}
    elif command == "set_alerts":
        enabled = payload.get("enabled")
        if not isinstance(enabled, bool):
            return jsonify(error="Trạng thái cảnh báo phải là bật hoặc tắt."), 400
        fields = {"enabled": enabled}
    else:
        return jsonify(error="Firmware hiện không hỗ trợ lệnh điều khiển này."), 400

    if not DEVICE_FIRMWARE_URL:
        return jsonify(
            error="USB bridge hiện chỉ đọc; điều khiển cần Wi-Fi firmware trực tiếp.",
            state="unsupported_transport",
        ), 409

    try:
        connection = firmware_status_snapshot()
    except Exception:
        return jsonify(error="Không xác minh được kết nối ESP32 trước khi gửi lệnh."), 503
    status = connection.get("status") if isinstance(connection, dict) else None
    if (not connection.get("device_connected") or not isinstance(status, dict)
            or status.get("source") != "device"):
        return jsonify(error="Chưa có ESP32 firmware Wi-Fi đang kết nối."), 409

    try:
        ack = send_firmware_product_command(command, **fields)
    except TimeoutError:
        return jsonify(error="Firmware chưa trả ACK cho lệnh điều khiển."), 504
    except Exception:
        log.exception("ESP32 product command failed")
        return jsonify(error="Firmware đã từ chối hoặc chưa nhận được lệnh điều khiển."), 503
    return jsonify(
        command=command,
        ack=ack,
        operation_enabled=status.get("operation_enabled"),
        note="ACK xác nhận firmware nhận lệnh; không xác nhận cảm biến, loa hoặc cảnh báo đã hoạt động.",
    )


@app.get("/api/device/speaker/status")
def api_device_speaker_status():
    _, error = require_user()
    if error:
        return error
    if not DEVICE_FIRMWARE_URL:
        return jsonify(
            available=False,
            speaker_configured=False,
            operation_enabled=False,
            state="unsupported_transport",
            error="Phát qua loa ESP32 cần kết nối Wi-Fi firmware; USB bridge chưa chuyển tiếp audio.",
        ), 200
    try:
        with firmware_request("/api/speaker/v2/status") as response:
            payload = json.load(response)
    except Exception:
        return jsonify(
            available=False,
            speaker_configured=False,
            state="firmware_offline",
            error="Không đọc được trạng thái loa từ firmware ESP32.",
        ), 503
    if (not isinstance(payload, dict) or payload.get("schema_version") != "2.0"
            or not isinstance(payload.get("speaker_configured"), bool)
            or not isinstance(payload.get("operation_enabled"), bool)):
        return jsonify(error="Firmware không trả đúng trạng thái loa v2."), 502
    return jsonify(available=True, **payload)


@app.post("/api/device/speaker")
def api_device_speaker():
    _, error = require_user()
    if error:
        return error
    if not DEVICE_FIRMWARE_URL:
        return jsonify(error="Phát qua loa cần Wi-Fi firmware; USB bridge chưa hỗ trợ audio."), 409
    if request.mimetype != "application/vnd.ro-assistive.pcm16le":
        return jsonify(error="Chỉ nhận PCM16LE mono thô."), 415
    content_length = request.content_length
    if content_length is None:
        return jsonify(error="Thiếu Content-Length; audio không được gửi dạng vô hạn."), 411
    if content_length <= 0 or content_length > MAX_DEVICE_SPEAKER_PCM_BYTES:
        return jsonify(error="Audio phải dài từ 1 đến 256.000 byte."), 413
    if content_length % 2:
        return jsonify(error="PCM16LE phải có số byte chẵn."), 422
    if (request.headers.get("X-Audio-Sample-Rate") != str(DEVICE_SPEAKER_SAMPLE_RATE_HZ)
            or request.headers.get("X-Audio-Channels") != "1"):
        return jsonify(error="Audio phải là PCM16LE 16 kHz, mono."), 422
    request_id = request.headers.get("X-Audio-Request-Id", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", request_id):
        return jsonify(error="X-Audio-Request-Id không hợp lệ."), 400

    pcm = request.get_data(cache=False, as_text=False)
    if len(pcm) != content_length:
        return jsonify(error="Độ dài audio không khớp Content-Length."), 400

    try:
        connection = firmware_status_snapshot()
    except Exception:
        return jsonify(error="Không xác minh được ESP32 trước khi gửi audio."), 503
    status = connection.get("status") if isinstance(connection, dict) else None
    if (not isinstance(connection, dict) or not connection.get("device_connected")
            or not isinstance(status, dict)):
        return jsonify(error="Chưa có firmware ESP32 kết nối qua Wi-Fi."), 409
    if device_operation_enabled(status) is not True:
        return operation_paused_response(status)

    try:
        with firmware_request("/api/speaker/v2/status") as response:
            speaker_status = json.load(response)
    except Exception:
        return jsonify(error="Không xác minh được trạng thái đầu ra loa."), 503
    if (not isinstance(speaker_status, dict)
            or speaker_status.get("schema_version") != "2.0"
            or speaker_status.get("speaker_configured") is not True):
        return jsonify(error="Loa ESP32 chưa được xác minh hoặc chưa khởi tạo."), 503
    if speaker_status.get("operation_enabled") is not True:
        return jsonify(error="ESP32 đang ở chế độ chờ; bật nút MODE trước."), 409
    if (speaker_status.get("sample_rate_hz") != DEVICE_SPEAKER_SAMPLE_RATE_HZ
            or speaker_status.get("channels") != 1
            or speaker_status.get("sample_bits") != 16
            or speaker_status.get("max_bytes", 0) < content_length
            or speaker_status.get("max_duration_ms", 0) < 1):
        return jsonify(error="Định dạng loa firmware không khớp PCM16LE 16 kHz mono."), 422

    headers = {
        "Content-Type": "application/vnd.ro-assistive.pcm16le",
        "X-Audio-Sample-Rate": str(DEVICE_SPEAKER_SAMPLE_RATE_HZ),
        "X-Audio-Channels": "1",
        "X-Audio-Request-Id": request_id,
    }
    try:
        with firmware_request(
            "/api/speaker/v2/pcm", method="POST", body=pcm,
            headers=headers, timeout=18,
        ) as response:
            result = json.load(response)
            status_code = response.status
    except HTTPError as exc:
        try:
            result = json.loads(exc.read(4096).decode("utf-8"))
            if not isinstance(result, dict):
                raise ValueError("invalid speaker response")
        except Exception:
            return jsonify(error="Firmware từ chối audio nhưng phản hồi không đọc được."), exc.code
        result.setdefault("error", {
            "speaker_hardware_unverified": "Loa ESP32 chưa được xác minh; audio chưa được phát.",
            "operation_disabled": "ESP32 đang chờ nút MODE; audio chưa được phát.",
            "duplicate_request_id": "Yêu cầu này đã được xử lý; app không phát lại.",
            "preempted_by_local_alert": "Cảnh báo cục bộ đã ưu tiên; câu trả lời dừng giữa chừng.",
            "speaker_busy": "Loa ESP32 đang phát một yêu cầu khác.",
        }.get(result.get("error_code"), "Firmware chưa xác nhận phát trọn vẹn câu trả lời."))
        return jsonify(result), exc.code
    except (URLError, TimeoutError, OSError, ValueError):
        return jsonify(error="Mất kết nối khi truyền audio; app sẽ không tự phát lại."), 504

    if (not isinstance(result, dict) or result.get("schema_version") != "2.0"
            or result.get("request_id") != request_id
            or result.get("state") != "completed"
            or result.get("bytes_played") != content_length):
        return jsonify(error="Firmware chưa xác nhận phát hết câu trả lời.", result=result), 502
    return jsonify(result), status_code


@app.get("/api/device/frame")
def api_device_frame():
    _, error = require_user()
    if error:
        return error
    try:
        if DEVICE_FIRMWARE_URL:
            connection = firmware_status_snapshot()
            status = connection.get("status") if isinstance(connection, dict) else None
            connected = bool(connection.get("device_connected")) if isinstance(connection, dict) else False
        else:
            with device_bridge_request("/api/status") as response:
                status = json.load(response)
            connected = (
                isinstance(status, dict) and status.get("source") == "device"
                and (status.get("device_link") or {}).get("state") == "live"
            )
    except Exception:
        return jsonify(error="Không xác minh được trạng thái ESP32 trước khi lấy ảnh."), 503
    if not connected or not isinstance(status, dict):
        return jsonify(error="Chưa có ESP32 kết nối để lấy ảnh."), 409
    if device_operation_enabled(status) is not True:
        return operation_paused_response(status)
    camera_age_ms = status.get("camera_age_ms")
    camera_frame = status.get("camera_frame")
    if (status.get("camera_input_state") != "live"
            or not isinstance(camera_age_ms, (int, float)) or isinstance(camera_age_ms, bool)
            or not 0 <= camera_age_ms <= FIRMWARE_CAMERA_FRAME_FRESH_MS
            or not isinstance(camera_frame, int) or isinstance(camera_frame, bool) or camera_frame < 1):
        return jsonify(error="Chưa có frame camera mới trong giới hạn 1 giây."), 409
    if DEVICE_FIRMWARE_URL:
        try:
            with firmware_request("/api/ocr.jpg", accept="image/jpeg") as response:
                body = response.read(MAX_DEVICE_FRAME_BYTES + 1)
                content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                received_seq = response.headers.get("X-Frame-Seq")
            if (len(body) > MAX_DEVICE_FRAME_BYTES or content_type != "image/jpeg"
                    or not body.startswith(b"\xff\xd8") or not body.endswith(b"\xff\xd9")
                or not received_seq or not received_seq.isdigit() or int(received_seq) < camera_frame):
                raise ValueError("invalid_frame")
        except Exception:
            return jsonify(error="Firmware chưa trả được khung JPEG mới."), 503
        result = Response(body, mimetype="image/jpeg")
        result.headers["Cache-Control"] = "no-store"
        if received_seq:
            result.headers["X-Frame-Seq"] = received_seq
        return result
    try:
        frame_seq = int(request.args.get("frame_seq", ""))
    except (TypeError, ValueError):
        return jsonify(error="Thiếu số thứ tự khung hình."), 400
    try:
        with device_bridge_request(f"/api/ocr.jpg?frame_seq={frame_seq}", accept="image/jpeg") as response:
            body = response.read(MAX_DEVICE_FRAME_BYTES + 1)
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
            received_seq = response.headers.get("X-Frame-Seq")
        if (len(body) > MAX_DEVICE_FRAME_BYTES or content_type != "image/jpeg"
                or not body.startswith(b"\xff\xd8") or not body.endswith(b"\xff\xd9")
                or received_seq != str(frame_seq)):
            raise ValueError("invalid_frame")
    except Exception:
        return jsonify(error="Khung hình thiết bị đã cũ hoặc chưa sẵn sàng. Đang chờ ảnh mới."), 503
    response = Response(body, mimetype="image/jpeg")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Frame-Seq"] = str(frame_seq)
    return response


@app.post("/api/device/ask")
def api_device_ask():
    row, error = require_user()
    if error:
        return error
    snapshot_started = time.monotonic()
    payload = request.get_json(silent=True) or {}
    question = str(payload.get("question", "")).strip()[:400]
    trigger = str(payload.get("trigger", "manual"))
    if trigger not in {"manual", "button_event"}:
        return jsonify(error="Nguồn yêu cầu không hợp lệ."), 400
    if not question:
        return jsonify(error="Bạn nhập hoặc đọc câu hỏi trước nhé."), 400

    try:
        if DEVICE_FIRMWARE_URL:
            connection = firmware_status_snapshot()
        else:
            with device_bridge_request("/api/status") as response:
                status = json.load(response)
            if not isinstance(status, dict):
                raise ValueError("invalid_bridge_status")
            is_device = status.get("source") == "device"
            link_state = (status.get("device_link") or {}).get("state")
            connected = is_device and link_state == "live"
            connection = {
                "available": True,
                "device_connected": connected,
                "state": "device_connected" if connected else "device_stale" if is_device else "no_device",
                "status": status,
            }
    except Exception:
        return jsonify(error="Không đọc được trạng thái ESP32. Kiểm tra kết nối rồi thử lại nhé."), 503

    status = connection.get("status") if isinstance(connection, dict) else None
    if not connection.get("device_connected") or not isinstance(status, dict):
        return jsonify(error="Chưa có ESP32 kết nối để hỏi về khung hình."), 409
    if device_operation_enabled(status) is not True:
        return operation_paused_response(status)
    frame_seq = status.get("camera_frame")
    age_ms = status.get("camera_age_ms")
    camera_live = status.get("camera_input_state") == "live"
    age_invalid = (
        not isinstance(age_ms, (int, float)) or isinstance(age_ms, bool)
        or not 0 <= age_ms <= FIRMWARE_CAMERA_FRAME_FRESH_MS
    )
    if (not camera_live or not isinstance(frame_seq, int) or isinstance(frame_seq, bool) or age_invalid):
        return jsonify(error="Chưa có khung hình camera mới. Đợi ảnh cập nhật rồi thử lại nhé."), 409

    provider = active_vision_provider()
    if not provider:
        return jsonify(error="Qwen3-VL chưa sẵn sàng trên máy chủ. Kiểm tra model Vision rồi thử lại nhé."), 503

    if DEVICE_FIRMWARE_URL and trigger == "manual":
        try:
            command_connection = firmware_status_snapshot()
            command_status = command_connection.get("status") if isinstance(command_connection, dict) else None
            if (not command_connection.get("device_connected") or not isinstance(command_status, dict)
                    or device_operation_enabled(command_status) is not True):
                return operation_paused_response(command_status)
            send_firmware_ocr_request()
        except Exception:
            log.exception("ESP32 request_ocr command failed")
            return jsonify(error="Không gửi được lệnh request_ocr tới firmware ESP32."), 503

    try:
        if DEVICE_FIRMWARE_URL:
            with firmware_request("/api/ocr.jpg", accept="image/jpeg") as response:
                image_bytes = response.read(MAX_DEVICE_FRAME_BYTES + 1)
                content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                received_seq = response.headers.get("X-Frame-Seq")
            if not received_seq or not received_seq.isdigit() or int(received_seq) <= 0:
                raise ValueError("missing_or_invalid_frame_seq")
            received_frame_seq = int(received_seq)
            if received_frame_seq < frame_seq:
                raise ValueError("stale_frame")
            frame_seq = received_frame_seq
        else:
            with device_bridge_request(f"/api/ocr.jpg?frame_seq={frame_seq}", accept="image/jpeg") as response:
                image_bytes = response.read(MAX_DEVICE_FRAME_BYTES + 1)
                content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                received_seq = response.headers.get("X-Frame-Seq")
            if received_seq != str(frame_seq):
                raise ValueError("stale_frame")
        image_received_at = time.monotonic()
        if (len(image_bytes) > MAX_DEVICE_FRAME_BYTES or content_type != "image/jpeg"
                or not image_bytes.startswith(b"\xff\xd8") or not image_bytes.endswith(b"\xff\xd9")):
            raise ValueError("invalid_frame")
        image = prepare_image(FileStorage(stream=io.BytesIO(image_bytes), filename=f"device-{frame_seq}.jpg", content_type="image/jpeg"))
    except Exception:
        return jsonify(error="Không lấy được ảnh ESP32 mới nhất. Đợi khung hình tiếp theo rồi thử lại nhé."), 503

    if int((time.monotonic() - image_received_at) * 1000) > FIRMWARE_EVENT_FRESH_MS:
        return jsonify(error="Ảnh mới đã hết hạn trước khi phân tích. Hãy chụp lại rồi thử nhé."), 409

    used_detection_t_ms = None
    used_tof_t_ms = None
    if DEVICE_FIRMWARE_URL:
        try:
            context_check_started = time.monotonic()
            current_connection = firmware_status_snapshot()
        except Exception:
            return jsonify(error="Không xác minh lại được dữ liệu ESP32 trước khi phân tích."), 503
        current_status = current_connection.get("status") if isinstance(current_connection, dict) else None
        initial_health = status.get("device_health") if isinstance(status.get("device_health"), dict) else {}
        current_health = current_status.get("device_health") if isinstance(current_status, dict) and isinstance(current_status.get("device_health"), dict) else {}
        initial_boot_id = initial_health.get("boot_id")
        current_boot_id = current_health.get("boot_id")
        if (not current_connection.get("device_connected") or not isinstance(current_status, dict)
                or current_status.get("camera_input_state") != "live"
                or not initial_boot_id or current_boot_id != initial_boot_id):
            return jsonify(error="ESP32 đã đổi phiên hoặc camera không còn hoạt động. Nhấn lại để thử ảnh mới."), 409

        context_elapsed_ms = int((time.monotonic() - context_check_started) * 1000)
        detections_age_ms = current_status.get("detections_age_ms")
        detection_frame_seq = current_status.get("detections_frame_seq")
        detector_model = current_status.get("detector_model")
        fomo_inference_ok = (
            isinstance(detector_model, str)
            and detector_model.lower().startswith(("fomo:", "espdet:"))
            and current_status.get("inference_status") == "ok"
        )
        detections = current_status.get("detections") if (
            fomo_inference_ok
            and isinstance(detections_age_ms, int) and not isinstance(detections_age_ms, bool)
            and 0 <= detections_age_ms + context_elapsed_ms <= FIRMWARE_EVENT_FRESH_MS
            and current_status.get("detections_boot_id") == current_boot_id
            and detection_frame_seq == frame_seq
            and isinstance(current_status.get("detections"), list)
        ) else []
        used_detection_t_ms = current_status.get("detections_event_t_ms") if detections else None

        tof_age_ms = current_status.get("tof_age_ms")
        tof_boot_valid = current_status.get("tof_boot_id") == current_boot_id
        tof_fresh = (
            isinstance(tof_age_ms, int) and not isinstance(tof_age_ms, bool)
            and 0 <= tof_age_ms + context_elapsed_ms <= FIRMWARE_EVENT_FRESH_MS
            and tof_boot_valid
        )
        zones = current_status.get("zones") if tof_fresh and isinstance(current_status.get("zones"), list) else []
        used_tof_t_ms = current_status.get("tof_event_t_ms") if zones else None
        tof_available = any(
            isinstance(zone, dict) and zone.get("tof_valid") is True
            and isinstance(zone.get("nearest_cm"), (int, float)) and not isinstance(zone.get("nearest_cm"), bool)
            and 0 < zone.get("nearest_cm") <= 100000
            for zone in zones
        )
        if current_health.get("tof_ok") is True and not tof_available:
            return jsonify(error="Số đo ToF của ESP32 đã cũ hoặc chưa sẵn sàng. Chưa gửi ảnh tới Vision."), 409
    else:
        context_elapsed_ms = int((time.monotonic() - snapshot_started) * 1000)
        camera_age_ms = status.get("camera_age_ms")
        if (not isinstance(camera_age_ms, (int, float)) or isinstance(camera_age_ms, bool)
                or camera_age_ms < 0 or camera_age_ms + context_elapsed_ms > FIRMWARE_EVENT_FRESH_MS):
            return jsonify(error="Khung hình bridge đã hết hạn trước khi phân tích. Hãy chụp lại rồi thử nhé."), 409
        frame_info = status.get("camera_frame_info") if isinstance(status.get("camera_frame_info"), dict) else {}
        device_link = status.get("device_link") if isinstance(status.get("device_link"), dict) else {}
        inference_age_ms = device_link.get("inference_age_ms")
        detections = status.get("detections") if (
            frame_info.get("detections_frame_seq") == frame_seq
            and isinstance(inference_age_ms, (int, float)) and not isinstance(inference_age_ms, bool)
            and 0 <= inference_age_ms + context_elapsed_ms <= FIRMWARE_EVENT_FRESH_MS
            and isinstance(status.get("detections"), list)
        ) else []
        zones = []
        if status.get("tof_ok") is True:
            return jsonify(error="Bridge chưa cung cấp ToF còn hạn. Chưa gửi ảnh tới Vision."), 409

    def assert_device_context_fresh():
        if int((time.monotonic() - image_received_at) * 1000) > FIRMWARE_EVENT_FRESH_MS:
            raise StaleDeviceContextError("jpeg_ttl_expired")
        if DEVICE_FIRMWARE_URL:
            check_started = time.monotonic()
            latest = firmware_status_snapshot()
            latest_status = latest.get("status") if isinstance(latest, dict) else None
            latest_health = latest_status.get("device_health") if isinstance(latest_status, dict) else None
            if (not isinstance(latest, dict) or not latest.get("device_connected")
                    or not isinstance(latest_status, dict) or not isinstance(latest_health, dict)
                    or latest_health.get("boot_id") != current_boot_id
                    or latest_status.get("camera_input_state") != "live"):
                raise StaleDeviceContextError("device_session_or_camera_changed")
            if device_operation_enabled(latest_status) is not True:
                raise StaleDeviceContextError("device_operation_paused")
            check_elapsed_ms = int((time.monotonic() - check_started) * 1000)
            current_device_ms = latest_health.get("t_ms")
            if detections:
                source_age = current_device_ms - used_detection_t_ms if (
                    isinstance(current_device_ms, int) and not isinstance(current_device_ms, bool)
                    and isinstance(used_detection_t_ms, int) and not isinstance(used_detection_t_ms, bool)
                ) else None
                latest_detector_model = latest_status.get("detector_model")
                latest_fomo_is_current = (
                    isinstance(latest_detector_model, str)
                    and latest_detector_model == detector_model
                    and latest_detector_model.lower().startswith(("fomo:", "espdet:"))
                    and latest_status.get("inference_status") == "ok"
                )
                if (not latest_fomo_is_current
                        or source_age is None or source_age < 0
                        or source_age + check_elapsed_ms > FIRMWARE_EVENT_FRESH_MS
                        or latest_status.get("detections_frame_seq") != frame_seq):
                    raise StaleDeviceContextError("detections_ttl_expired_or_frame_mismatch")
            if zones:
                if latest_health.get("tof_ok") is not True or latest_status.get("tof_boot_id") != current_boot_id:
                    raise StaleDeviceContextError("tof_sensor_or_boot_changed")
                source_age = current_device_ms - used_tof_t_ms if (
                    isinstance(current_device_ms, int) and not isinstance(current_device_ms, bool)
                    and isinstance(used_tof_t_ms, int) and not isinstance(used_tof_t_ms, bool)
                ) else None
                if (source_age is None or source_age < 0
                        or source_age + check_elapsed_ms > FIRMWARE_EVENT_FRESH_MS):
                    raise StaleDeviceContextError("tof_ttl_expired")
            if latest_health.get("tof_ok") is True:
                latest_tof_age = latest_status.get("tof_age_ms")
                latest_zones = latest_status.get("zones") if isinstance(latest_status.get("zones"), list) else []
                latest_tof_valid = any(
                    isinstance(zone, dict) and zone.get("tof_valid") is True
                    and isinstance(zone.get("nearest_cm"), (int, float))
                    and not isinstance(zone.get("nearest_cm"), bool)
                    for zone in latest_zones
                )
                if (not latest_tof_valid or not isinstance(latest_tof_age, int)
                        or isinstance(latest_tof_age, bool) or latest_tof_age + check_elapsed_ms > FIRMWARE_EVENT_FRESH_MS
                        or latest_status.get("tof_boot_id") != current_boot_id):
                    raise StaleDeviceContextError("required_tof_context_unavailable")
        else:
            elapsed_ms = int((time.monotonic() - snapshot_started) * 1000)
            try:
                with device_bridge_request("/api/status") as response:
                    latest_bridge_status = json.load(response)
            except Exception as exc:
                raise StaleDeviceContextError("bridge_status_unavailable") from exc
            if device_operation_enabled(latest_bridge_status) is not True:
                raise StaleDeviceContextError("bridge_operation_paused")
            if not isinstance(age_ms, (int, float)) or isinstance(age_ms, bool) or age_ms + elapsed_ms > FIRMWARE_EVENT_FRESH_MS:
                raise StaleDeviceContextError("bridge_camera_ttl_expired")
            if detections:
                inference_age = (status.get("device_link") or {}).get("inference_age_ms")
                if (not isinstance(inference_age, (int, float)) or isinstance(inference_age, bool)
                        or inference_age + elapsed_ms > FIRMWARE_EVENT_FRESH_MS):
                    raise StaleDeviceContextError("bridge_detections_ttl_expired")

    try:
        answer = vision_answer(
            image, question, detections, provider, distance_zones=zones,
            freshness_guard=assert_device_context_fresh,
        )
    except StaleDeviceContextError:
        return jsonify(error="Ảnh hoặc dữ liệu thiết bị đã hết hạn trước khi gửi tới Vision. Nhấn lại để lấy dữ liệu mới."), 409
    except Exception:
        log.exception("ESP32 frame question failed")
        return jsonify(error="Chưa trả lời được câu hỏi về khung hình ESP32. Thử lại nhé."), 502

    labels = []
    for item in detections:
        if not isinstance(item, dict):
            continue
        label = str(item.get("class_name") or item.get("label_vi") or item.get("label") or "").strip()
        if label and label not in labels:
            labels.append(label[:80])
        if len(labels) >= 12:
            break
    with database() as db:
        db.execute(
            "INSERT INTO history(user_id,question,answer,labels_json,created_at) VALUES(?,?,?,?,?)",
            (row["id"], question, answer, json.dumps(labels, ensure_ascii=False), now_iso()),
        )
    tof_available = any(
        isinstance(zone, dict) and zone.get("tof_valid") is True
        and isinstance(zone.get("nearest_cm"), (int, float))
        for zone in zones
    )
    return jsonify(
        answer=answer,
        detections=detections,
        zones=zones,
        frame_seq=frame_seq,
        trigger=trigger,
        vision_used=True,
        vision_provider=provider,
        vision_model=LOCAL_VISION_MODEL if provider == "ollama" else VISION_MODEL,
        distance_source="tof" if tof_available else "unavailable",
        image_saved=False,
    )


@app.post("/api/auth/register")
def register():
    body = request.get_json(silent=True) or {}
    username = str(body.get("username", "")).strip().lower()
    display_name = str(body.get("display_name", "")).strip()[:50]
    password = str(body.get("password", ""))
    if not re.fullmatch(r"[a-z0-9_.-]{3,32}", username):
        return jsonify(error="Tên đăng nhập cần 3–32 ký tự: chữ thường, số, dấu chấm, gạch dưới hoặc gạch nối."), 400
    if len(password) < 8 or len(password) > 128:
        return jsonify(error="Mật khẩu cần từ 8 đến 128 ký tự."), 400
    if not display_name:
        return jsonify(error="Bạn nhập tên muốn được gọi nhé."), 400
    try:
        with database() as db:
            cursor = db.execute(
                "INSERT INTO users(username,password_hash,display_name,created_at) VALUES(?,?,?,?)",
                (username, generate_password_hash(password, method="scrypt"), display_name, now_iso()),
            )
            row = db.execute("SELECT * FROM users WHERE id=?", (cursor.lastrowid,)).fetchone()
    except sqlite3.IntegrityError:
        return jsonify(error="Tên đăng nhập này đã có. Bạn chọn tên khác nhé."), 409
    session.clear()
    session.permanent = True
    session["user_id"] = row["id"]
    return jsonify(user=user_payload(row), profile=profile_payload(row))


@app.post("/api/auth/login")
def login():
    body = request.get_json(silent=True) or {}
    username = str(body.get("username", "")).strip().lower()
    password = str(body.get("password", ""))
    with database() as db:
        row = db.execute("SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
    if row is None or not check_password_hash(row["password_hash"], password):
        return jsonify(error="Tên đăng nhập hoặc mật khẩu chưa đúng."), 401
    session.clear()
    session.permanent = True
    session["user_id"] = row["id"]
    return jsonify(user=user_payload(row), profile=profile_payload(row))


@app.get("/api/auth/me")
def me():
    row = current_user_row()
    if row is None:
        return jsonify(error="Chưa đăng nhập."), 401
    return jsonify(user=user_payload(row), profile=profile_payload(row))


@app.post("/api/auth/logout")
def logout():
    session.clear()
    return "", 204


@app.get("/api/profile")
def get_profile():
    row, error = require_user()
    if error:
        return error
    return jsonify(profile=profile_payload(row))


@app.put("/api/profile")
def update_profile():
    row, error = require_user()
    if error:
        return error
    body = request.get_json(silent=True) or {}
    try:
        scale = round(float(body.get("text_scale", row["text_scale"])), 1)
        voice_rate = float(body.get("voice_rate", row["voice_rate"]))
    except (TypeError, ValueError):
        return jsonify(error="Cài đặt chưa hợp lệ."), 400
    scale = max(0.9, min(1.3, scale))
    voice_rate = max(0.75, min(1.15, voice_rate))
    display_name = str(body.get("display_name", row["display_name"])).strip()[:50] or row["display_name"]
    high_contrast = 1 if body.get("high_contrast") else 0
    speak_answers = 1 if body.get("speak_answers") else 0
    with database() as db:
        db.execute(
            "UPDATE users SET display_name=?,text_scale=?,high_contrast=?,speak_answers=?,voice_rate=? WHERE id=?",
            (display_name, scale, high_contrast, speak_answers, voice_rate, row["id"]),
        )
        updated = db.execute("SELECT * FROM users WHERE id=?", (row["id"],)).fetchone()
    return jsonify(profile=profile_payload(updated))


@app.get("/api/history")
def get_history():
    row, error = require_user()
    if error:
        return error
    with database() as db:
        records = db.execute(
            "SELECT id,question,answer,labels_json,created_at FROM history WHERE user_id=? ORDER BY id DESC LIMIT 100",
            (row["id"],),
        ).fetchall()
    items = [
        {"id": item["id"], "question": item["question"], "answer": item["answer"],
         "labels": json.loads(item["labels_json"]), "created_at": item["created_at"]}
        for item in records
    ]
    return jsonify(items=items)


@app.delete("/api/history")
def delete_history():
    row, error = require_user()
    if error:
        return error
    with database() as db:
        db.execute("DELETE FROM history WHERE user_id=?", (row["id"],))
    return "", 204


def load_detector():
    global _detector
    if _detector is not None:
        return _detector
    if not MODEL_PATH.is_file():
        raise RuntimeError("Không tìm thấy model YOLO trên máy chủ.")
    with MODEL_LOCK:
        if _detector is None:
            custom_repo = str(ESP_DETECTION_PATH.resolve())
            if ESP_DETECTION_PATH.is_dir() and custom_repo not in sys.path:
                sys.path.insert(0, custom_repo)
            from ultralytics import YOLO
            _detector = YOLO(str(MODEL_PATH), task="detect")
    return _detector


def image_region(cx, cy):
    horizontal = "bên trái" if cx < 0.36 else "bên phải" if cx > 0.64 else "ở giữa"
    vertical = "phía trên" if cy < 0.34 else "phía dưới" if cy > 0.68 else "tầm giữa"
    return f"{vertical}, {horizontal}"


def load_object_classifier():
    global _object_classifier, _object_classifier_class_names
    if _object_classifier is not None:
        return _object_classifier, _object_classifier_class_names
    if OBJECT_CLASSIFIER_PATH is None or not OBJECT_CLASSIFIER_PATH.is_file():
        return None, []
    with OBJECT_CLASSIFIER_LOCK:
        if _object_classifier is None:
            import torch
            from torch import nn
            from torchvision.models import mobilenet_v3_small

            checkpoint = torch.load(OBJECT_CLASSIFIER_PATH, map_location="cpu", weights_only=True)
            class_names = [str(name) for name in checkpoint["class_names"]]
            model = mobilenet_v3_small(weights=None)
            model.classifier[-1] = nn.Linear(model.classifier[-1].in_features, len(class_names))
            model.load_state_dict(checkpoint["model"])
            model.eval()
            _object_classifier = model
            _object_classifier_class_names = class_names
    return _object_classifier, _object_classifier_class_names


def expanded_object_crop(image, box):
    width, height = image.size
    x1, y1, x2, y2 = box
    pad_x = max(0.0, x2 - x1) * OBJECT_CLASSIFIER_CONTEXT
    pad_y = max(0.0, y2 - y1) * OBJECT_CLASSIFIER_CONTEXT
    bounds = (
        max(0, int(x1 - pad_x)),
        max(0, int(y1 - pad_y)),
        min(width, int(x2 + pad_x + 0.999)),
        min(height, int(y2 + pad_y + 0.999)),
    )
    if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
        return image.copy()
    return image.crop(bounds)


def object_classifier_tensor(image):
    import numpy as np
    import torch

    width, height = image.size
    scale = min(OBJECT_CLASSIFIER_IMAGE_SIZE / width, OBJECT_CLASSIFIER_IMAGE_SIZE / height)
    resized = image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.BILINEAR)
    canvas = Image.new("RGB", (OBJECT_CLASSIFIER_IMAGE_SIZE, OBJECT_CLASSIFIER_IMAGE_SIZE), (114, 114, 114))
    canvas.paste(resized, ((OBJECT_CLASSIFIER_IMAGE_SIZE - resized.width) // 2, (OBJECT_CLASSIFIER_IMAGE_SIZE - resized.height) // 2))
    array = np.asarray(canvas, dtype=np.float32) / 255.0
    tensor = torch.from_numpy(array).permute(2, 0, 1)
    mean = torch.tensor((0.485, 0.456, 0.406), dtype=tensor.dtype)[:, None, None]
    std = torch.tensor((0.229, 0.224, 0.225), dtype=tensor.dtype)[:, None, None]
    return (tensor - mean) / std


def detect_objects(image):
    model = load_detector()
    with DETECTOR_INFERENCE_LOCK:
        predictions = model.predict(
            source=image,
            imgsz=YOLO_IMAGE_SIZE,
            rect=isinstance(YOLO_IMAGE_SIZE, list),
            conf=YOLO_INFERENCE_CONFIDENCE,
            device="cpu",
            verbose=False,
            max_det=20,
        )
    result = predictions[0]
    detections = []
    width, height = image.size
    names = result.names
    boxes = result.boxes
    if boxes is None:
        return detections
    classifier, classifier_class_names = load_object_classifier()
    candidate_crops = []
    candidate_records = []
    for box in boxes:
        cls_id = int(box.cls[0].item())
        label = str(names.get(cls_id, cls_id))
        confidence = float(box.conf[0].item())
        if confidence < YOLO_CLASS_CONFIDENCE.get(label, YOLO_CONFIDENCE):
            continue
        x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
        cx = ((x1 + x2) / 2) / max(width, 1)
        cy = ((y1 + y2) / 2) / max(height, 1)
        detection = {
            "label": label,
            "label_vi": LABELS_VI.get(label, label),
            "confidence": round(confidence, 4),
            "region_vi": image_region(cx, cy),
            "box": [round(x1 / width, 4), round(y1 / height, 4), round(x2 / width, 4), round(y2 / height, 4)],
        }
        if classifier is not None:
            detection["detector_label"] = label
            candidate_crops.append(object_classifier_tensor(expanded_object_crop(image, [x1, y1, x2, y2])))
            candidate_records.append(detection)
        else:
            detections.append(detection)
    if classifier is not None and candidate_crops:
        import torch

        with OBJECT_CLASSIFIER_LOCK, torch.inference_mode():
            probabilities = classifier(torch.stack(candidate_crops)).softmax(1).cpu()
        for detection, row in zip(candidate_records, probabilities):
            refined_class = int(row.argmax())
            refined_confidence = float(row[refined_class])
            detection["classifier_confidence"] = round(refined_confidence, 4)
            if refined_confidence >= OBJECT_CLASSIFIER_THRESHOLD:
                detection["label"] = classifier_class_names[refined_class]
                detection["label_vi"] = LABELS_VI.get(detection["label"], detection["label"])
            detections.append(detection)
    detections.sort(key=lambda item: item["confidence"], reverse=True)
    return detections


def load_zone_classifier():
    global _zone_classifier
    if _zone_classifier is not None:
        return _zone_classifier
    if ZONE_MODEL_PATH is None or not ZONE_MODEL_PATH.is_file():
        raise RuntimeError("Không tìm thấy checkpoint MobileNet chia vùng.")
    with ZONE_MODEL_LOCK:
        if _zone_classifier is None:
            import torch
            from torch import nn
            from torchvision.models import mobilenet_v3_small

            checkpoint = torch.load(ZONE_MODEL_PATH, map_location="cpu", weights_only=True)
            model = mobilenet_v3_small(weights=None)
            model.classifier[-1] = nn.Linear(model.classifier[-1].in_features, 2)
            model.load_state_dict(checkpoint["model"])
            model.eval()
            _zone_classifier = model
    return _zone_classifier


def detect_hazard_zones(image):
    if ZONE_MODEL_PATH is None:
        return None
    import numpy as np
    import torch

    model = load_zone_classifier()
    width, height = image.size
    crops = []
    for index in range(3):
        left = round(width * index / 3)
        right = round(width * (index + 1) / 3)
        crop = image.crop((left, 0, right, height))
        crop_width, crop_height = crop.size
        scale = min(ZONE_IMAGE_SIZE / crop_width, ZONE_IMAGE_SIZE / crop_height)
        resized = crop.resize((max(1, round(crop_width * scale)), max(1, round(crop_height * scale))), Image.Resampling.BILINEAR)
        canvas = Image.new("RGB", (ZONE_IMAGE_SIZE, ZONE_IMAGE_SIZE), (114, 114, 114))
        canvas.paste(resized, ((ZONE_IMAGE_SIZE - resized.width) // 2, (ZONE_IMAGE_SIZE - resized.height) // 2))
        array = np.asarray(canvas, dtype=np.float32) / 255.0
        tensor = torch.from_numpy(array).permute(2, 0, 1)
        mean = torch.tensor((0.485, 0.456, 0.406), dtype=tensor.dtype)[:, None, None]
        std = torch.tensor((0.229, 0.224, 0.225), dtype=tensor.dtype)[:, None, None]
        crops.append((tensor - mean) / std)

    with ZONE_MODEL_LOCK, torch.inference_mode():
        probabilities = model(torch.stack(crops)).softmax(1)[:, 1].tolist()
    names = (("left", "bên trái"), ("center", "ở giữa"), ("right", "bên phải"))
    zones = [
        {
            "id": zone_id,
            "label_vi": label_vi,
            "hazard_probability": round(float(probability), 4),
            "is_hazard": float(probability) >= ZONE_HAZARD_THRESHOLD,
        }
        for (zone_id, label_vi), probability in zip(names, probabilities)
    ]
    return {
        "status": "ready",
        "model": "MobileNetV3-Small 3-zone binary classifier",
        "threshold": ZONE_HAZARD_THRESHOLD,
        "imgsz": ZONE_IMAGE_SIZE,
        "zones": zones,
        "distance_source": "unavailable",
    }


def concise_summary(detections):
    if not detections:
        return "Mình chưa nhận ra rõ vật thể nào trong ảnh. Bạn thử chụp nơi đủ sáng và đưa vật thể vào giữa khung hình nhé."
    counts = Counter(item["label_vi"] for item in detections)
    parts = []
    for label, amount in counts.most_common(5):
        parts.append(f"{amount} {label}" if amount > 1 else label)
    joined = ", ".join(parts)
    if len(parts) > 1:
        joined = ", ".join(parts[:-1]) + " và " + parts[-1]
    return f"Mình nhận diện được {joined}. Đây là kết quả từ hình ảnh; mình chưa đo khoảng cách."


def vision_answer(image, question, detections, provider, distance_zones=None, freshness_guard=None):
    encoded = io.BytesIO()
    image.save(encoded, format="JPEG", quality=84, optimize=True)
    image_b64 = base64.b64encode(encoded.getvalue()).decode("ascii")
    prompt = question.strip() or "Hãy mô tả ngắn gọn những gì quan trọng mà người dùng có thể nhìn thấy trong ảnh."
    metadata = []
    for item in detections[:12] if isinstance(detections, list) else []:
        if not isinstance(item, dict):
            continue
        label = str(item.get("class_name") or item.get("label_vi") or item.get("label") or "").strip()
        if not label:
            continue
        zone = str(item.get("zone") or item.get("region_vi") or "").strip()
        confidence = item.get("confidence")
        detail = label[:80]
        if zone:
            detail += f" ({zone[:60]})"
        if isinstance(confidence, (int, float)):
            detail += f", độ tin cậy {max(0, min(100, round(confidence * 100)))}%"
        metadata.append(detail)
    if metadata:
        prompt += "\n\nCác nhãn detector đính kèm ảnh này (nguồn tùy chế độ camera): " + "; ".join(metadata) + "."

    valid_distances = []
    for zone in distance_zones or []:
        if not isinstance(zone, dict) or zone.get("tof_valid") is not True:
            continue
        distance = zone.get("nearest_cm")
        if not isinstance(distance, (int, float)) or not 0 <= distance <= 100000:
            continue
        zone_name = {"left": "trái", "center": "giữa", "right": "phải"}.get(str(zone.get("zone")), str(zone.get("zone") or "không rõ"))
        valid_distances.append(f"{zone_name}: {distance:.1f} cm")
    if valid_distances:
        prompt += "\nSố đo ToF riêng từ lần quét mới nhất của ESP32 (không đồng bộ với JPEG và không gắn với vật thể nhìn thấy): " + "; ".join(valid_distances) + "."
    elif distance_zones is not None:
        prompt += "\nKhông có số đo ToF đủ mới và hợp lệ cho yêu cầu này. Không ước lượng khoảng cách từ ảnh."

    instructions = f"{ASSISTANT_CORE_PROMPT} {ASSISTANT_VISION_PROMPT}"
    if provider == "ollama":
        body = json.dumps({
            "model": LOCAL_VISION_MODEL,
            "messages": [
                {"role": "system", "content": instructions},
                {"role": "user", "content": prompt, "images": [image_b64]},
            ],
            "stream": False,
            "think": False,
            "keep_alive": "10m",
            "options": {
                "temperature": ASSISTANT_PROFILE["generation"]["vision_temperature"],
                "num_predict": ASSISTANT_PROFILE["generation"]["local_vision_max_tokens"],
            },
        }).encode("utf-8")
        req = Request(f"{LOCAL_OLLAMA_URL}/api/chat", data=body, headers={"Content-Type": "application/json"})
        if freshness_guard:
            freshness_guard()
        with urlopen(req, timeout=180) as response:
            answer = str(json.load(response).get("message", {}).get("content", "")).strip()
    else:
        from openai import OpenAI
        data_url = "data:image/jpeg;base64," + image_b64
        client = OpenAI()
        if freshness_guard:
            freshness_guard()
        response = client.responses.create(
            model=VISION_MODEL,
            store=False,
            max_output_tokens=ASSISTANT_PROFILE["generation"]["cloud_vision_max_tokens"],
            instructions=instructions,
            input=[{"role": "user", "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": data_url, "detail": "high"},
            ]}],
        )
        answer = (response.output_text or "").strip()
    if not answer:
        raise RuntimeError("Mô hình không trả về nội dung.")
    return answer


def prepare_image(file_storage):
    raw = file_storage.stream.read(MAX_IMAGE_BYTES + 1)
    if not raw:
        raise ValueError("Ảnh đang trống. Bạn chọn ảnh khác nhé.")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Ảnh lớn hơn 12 MB. Bạn chọn ảnh nhỏ hơn nhé.")
    try:
        image = Image.open(io.BytesIO(raw))
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        return image
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ValueError("Định dạng ảnh chưa hỗ trợ. Dùng JPEG, PNG hoặc WebP nhé.")


@app.get("/api/path/health")
def path_inference_health():
    row, error = require_user()
    if error:
        return error
    try:
        with path_inference_request("/health", timeout=2.0) as response:
            health = json.load(response)
        if not isinstance(health, dict):
            raise ValueError("invalid_health_response")
        allowed_health_fields = {
            "service", "model_ready", "model_id", "policy_id",
            "calibration_status", "transport_age_budget_ms", "tracking_ready",
            "tracking_method", "tracking_calibrated", "growth_warning_enabled",
            "occupancy_threshold", "clear_occupancy_threshold",
            "clear_hysteresis_enabled",
        }
        safe_health = {
            key: value for key, value in health.items()
            if key in allowed_health_fields
        }
        safe_health["available"] = True
        return jsonify(safe_health)
    except Exception as exc:
        # Do not include request data, tokens, or local exception details in the API.
        log.info("Local path inference health unavailable (%s)", type(exc).__name__)
        return jsonify(
            available=False,
            service="detectron2-path",
            calibration_status="unavailable",
            tracking_ready=False,
            tracking_calibrated=False,
            growth_warning_enabled=False,
            occupancy_threshold=None,
            clear_occupancy_threshold=None,
            clear_hysteresis_enabled=False,
        )


@app.post("/api/path/detect")
def detect_path_occupancy_frame():
    row, error = require_user()
    if error:
        return error
    expected_fields = {"stream_id", "frame_id", "timestamp_ms", "frame_age_ms", "roi_valid"}
    uploaded = request.files.get("image")
    if set(request.form.keys()) != expected_fields or set(request.files.keys()) != {"image"} or not uploaded:
        return jsonify(error="invalid_request_fields", state="unknown", valid=False), 400

    stream_id = request.form.get("stream_id", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", stream_id):
        return jsonify(error="invalid_stream_id", state="unknown", valid=False), 400

    numeric_fields = {}
    for field, upper_bound in (("frame_id", 2**53 - 1), ("timestamp_ms", 2**53 - 1), ("frame_age_ms", 60_000)):
        raw_value = request.form.get(field, "")
        if not raw_value.isascii() or not raw_value.isdecimal():
            return jsonify(error=f"invalid_{field}", state="unknown", valid=False), 400
        value = int(raw_value)
        if value > upper_bound:
            return jsonify(error=f"invalid_{field}", state="unknown", valid=False), 400
        numeric_fields[field] = value

    roi_valid_value = request.form.get("roi_valid")
    if roi_valid_value not in {"true", "false"}:
        return jsonify(error="invalid_roi_valid", state="unknown", valid=False), 400

    jpeg = uploaded.stream.read(MAX_PATH_JPEG_BYTES + 1)
    if not jpeg:
        return jsonify(error="empty_jpeg", state="unknown", valid=False), 400
    if len(jpeg) > MAX_PATH_JPEG_BYTES:
        return jsonify(error="jpeg_size_limit", state="unknown", valid=False), 413
    try:
        with Image.open(io.BytesIO(jpeg)) as header:
            if header.format != "JPEG":
                return jsonify(error="jpeg_required", state="unknown", valid=False), 415
            width, height = header.size
            if width * height > MAX_PATH_IMAGE_PIXELS:
                return jsonify(error="image_pixel_limit", state="unknown", valid=False), 413
            header.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        return jsonify(error="invalid_jpeg", state="unknown", valid=False), 400

    payload = {
        "stream_id": stream_id,
        **numeric_fields,
        "roi_valid": roi_valid_value == "true",
        "image_base64": base64.b64encode(jpeg).decode("ascii"),
    }
    try:
        with path_inference_request(
            "/api/path/detect",
            method="POST",
            body=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            timeout=45.0,
        ) as response:
            result = json.load(response)
        if not isinstance(result, dict) or result.get("state") not in {
            "unknown", "clear_candidate", "caution", "approaching", "blocked"
        }:
            raise ValueError("invalid_path_response")
        # Allowlist the vision-only contract; sensor and unrelated upstream fields stay private.
        allowed_result_fields = {
            "state", "valid", "frame_id", "timestamp_ms", "occupancy_ratio",
            "corridor_pixels", "occupied_pixels", "tracks", "reason",
            "schema_version", "model_id", "prediction_and_adapter_ms",
            "frame_age_at_decision_ms", "tracking_ready", "tracking_method",
            "tracking_calibrated", "camera_motion_compensated",
            "growth_warning_enabled", "stream_id", "policy_id",
            "calibration_status", "transport_age_budget_ms", "age_measurement",
            "occupancy_threshold", "clear_occupancy_threshold",
            "clear_hysteresis_enabled",
        }
        return jsonify({key: value for key, value in result.items() if key in allowed_result_fields})
    except HTTPError as exc:
        log.info("Local path inference rejected request (HTTP %s)", exc.code)
        return jsonify(error="path_inference_rejected", state="unknown", valid=False), 503
    except (URLError, TimeoutError, OSError) as exc:
        log.info("Local path inference request unavailable (%s)", type(exc).__name__)
        return jsonify(error="path_inference_unavailable", state="unknown", valid=False), 503
    except (ValueError, json.JSONDecodeError) as exc:
        log.warning("Local path inference returned an invalid response (%s)", type(exc).__name__)
        return jsonify(error="invalid_path_response", state="unknown", valid=False), 503


@app.get("/api/segmentation/health")
def segmentation_health():
    _, error = require_user()
    if error:
        return error
    try:
        with segmentation_request("/health", timeout=3.0) as response:
            health = json.load(response)
        if not isinstance(health, dict):
            raise ValueError("invalid_health_response")
        allowed = {
            "service", "model_ready", "model_id", "class_names", "device",
            "calibration_status", "output_kind", "navigation_decision_enabled",
            "navigation_status", "navigation_policy", "input_size", "preprocessing",
            "images_saved",
        }
        return jsonify({**{key: value for key, value in health.items() if key in allowed},
                        "available": True})
    except Exception as exc:
        log.info("Local segmentation health unavailable (%s)", type(exc).__name__)
        return jsonify(available=False, model_ready=False,
                       calibration_status="unavailable",
                       navigation_decision_enabled=False, images_saved=False)


@app.post("/api/segmentation/infer")
def segment_uploaded_frame():
    _, error = require_user()
    if error:
        return error
    uploaded = request.files.get("image")
    if (set(request.files.keys()) != {"image"}
            or set(request.form.keys()) - {"stream_id", "frame_id"}
            or not uploaded):
        return jsonify(error="invalid_request_fields"), 400
    stream_id = request.form.get("stream_id")
    frame_id = request.form.get("frame_id")
    if stream_id is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,96}", stream_id):
        return jsonify(error="invalid_stream_id"), 400
    if frame_id is not None and (not frame_id.isascii() or not frame_id.isdecimal()
                                 or not 1 <= int(frame_id) <= 2**53 - 1):
        return jsonify(error="invalid_frame_id"), 400
    jpeg = uploaded.stream.read(MAX_PATH_JPEG_BYTES + 1)
    if not jpeg:
        return jsonify(error="empty_jpeg"), 400
    if len(jpeg) > MAX_PATH_JPEG_BYTES:
        return jsonify(error="jpeg_size_limit"), 413
    try:
        with Image.open(io.BytesIO(jpeg)) as header:
            if header.format != "JPEG":
                return jsonify(error="jpeg_required"), 415
            width, height = header.size
            if width * height > MAX_PATH_IMAGE_PIXELS:
                return jsonify(error="image_pixel_limit"), 413
            header.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        return jsonify(error="invalid_jpeg"), 400
    payload = {"image_base64": base64.b64encode(jpeg).decode("ascii")}
    if stream_id is not None:
        payload["stream_id"] = stream_id
    if frame_id is not None:
        payload["frame_id"] = int(frame_id)
    body = json.dumps(payload,
                      separators=(",", ":")).encode("utf-8")
    try:
        with segmentation_request("/api/segment", method="POST", body=body, timeout=15.0) as response:
            result = json.load(response)
        required = {"model_id", "calibration_status", "navigation_decision_enabled",
                    "image_width", "image_height", "inference_ms", "classes_present",
                    "mask_encoding", "mask_png_base64", "images_saved", "guidance",
                    "stream_id", "frame_id"}
        if not isinstance(result, dict) or not required.issubset(result):
            raise ValueError("invalid_segmentation_response")
        if (result["calibration_status"] != "experimental"
                or result["navigation_decision_enabled"] is not True
                or result["images_saved"] is not False):
            raise ValueError("unsafe_segmentation_response")
        if stream_id is not None and result["stream_id"] != stream_id:
            raise ValueError("segmentation_stream_mismatch")
        if frame_id is not None and result["frame_id"] != int(frame_id):
            raise ValueError("segmentation_frame_mismatch")
        allowed_result_fields = required | {"navigation_status"}
        return jsonify({key: value for key, value in result.items() if key in allowed_result_fields})
    except HTTPError as exc:
        log.info("Local segmentation rejected frame (HTTP %s)", exc.code)
        return jsonify(error="segmentation_rejected"), 503
    except (URLError, TimeoutError, OSError) as exc:
        log.info("Local segmentation unavailable (%s)", type(exc).__name__)
        return jsonify(error="segmentation_unavailable"), 503
    except (ValueError, json.JSONDecodeError) as exc:
        log.warning("Local segmentation returned an invalid response (%s)", type(exc).__name__)
        return jsonify(error="invalid_segmentation_response"), 503


@app.post("/api/detect")
def detect_live_frame():
    row, error = require_user()
    if error:
        return error
    uploaded = request.files.get("image")
    if not uploaded:
        return jsonify(error="Không nhận được khung hình camera."), 400
    try:
        image = prepare_image(uploaded)
        started = time.perf_counter()
        detections = detect_objects(image)
        inference_ms = round((time.perf_counter() - started) * 1000)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    except Exception:
        log.exception("Live YOLO detection failed")
        return jsonify(error="YOLO chưa chạy được khung hình này. Kiểm tra model và thử lại nhé."), 503
    zone_warnings = None
    zone_inference_ms = None
    if ZONE_MODEL_PATH is not None:
        zone_started = time.perf_counter()
        try:
            zone_warnings = detect_hazard_zones(image)
        except Exception:
            log.exception("Live MobileNet zone inference failed")
            zone_warnings = {"status": "unavailable", "zones": [], "distance_source": "unavailable"}
        zone_inference_ms = round((time.perf_counter() - zone_started) * 1000)
    return jsonify(
        detections=detections,
        inference_ms=inference_ms,
        hazard_zones=zone_warnings,
        zone_inference_ms=zone_inference_ms,
        distance_m=None,
        distance_source="unavailable",
        image_saved=False,
    )


@app.post("/api/analyze")
def analyze():
    row, error = require_user()
    if error:
        return error
    uploaded = request.files.get("image")
    if not uploaded:
        return jsonify(error="Bạn chọn ảnh trước nhé."), 400
    try:
        image = prepare_image(uploaded)
        detections = detect_objects(image)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    except Exception:
        log.exception("Local object detection failed")
        return jsonify(error="Máy chưa chạy được nhận diện. Kiểm tra model YOLO và thử lại nhé."), 503

    question = str(request.form.get("question", "")).strip()[:400]
    answer = concise_summary(detections)
    vision_used = False
    vision_error = None
    provider = active_vision_provider()
    if provider and question:
        try:
            answer = vision_answer(image, question, detections, provider)
            vision_used = True
        except Exception:
            log.exception("Vision model image response failed")
            vision_error = "Chưa gọi được AI hỏi ảnh; phần bên dưới chỉ là nhận diện vật thể trên máy."
    elif question:
        vision_error = "Chưa có Vision LLM trên máy chủ; hiện chỉ có nhận diện vật thể YOLO."

    labels = list(dict.fromkeys(item["label_vi"] for item in detections[:12]))
    with database() as db:
        db.execute(
            "INSERT INTO history(user_id,question,answer,labels_json,created_at) VALUES(?,?,?,?,?)",
            (row["id"], question, answer, json.dumps(labels, ensure_ascii=False), now_iso()),
        )
    return jsonify(
        answer=answer,
        detections=detections,
        vision_used=vision_used,
        vision_provider=provider if vision_used else None,
        vision_error=vision_error,
        distance_m=None,
        distance_source="unavailable",
        image_saved=False,
    )


@app.post("/api/voice/turn")
def local_voice_turn():
    row, error = require_user()
    if error:
        return error
    if request.content_length and request.content_length > 1_000_000:
        return jsonify(error="Lượt thoại gửi lên quá lớn."), 413

    transcript = str(request.form.get("text", "")).strip()[:400]
    if not transcript:
        return jsonify(error="Mình chưa nhận được câu bạn vừa nói."), 400
    if not local_vision_ready():
        return jsonify(error="Qwen-VL trên laptop chưa sẵn sàng."), 503

    previous_messages = []
    try:
        parsed = json.loads(str(request.form.get("history", "[]")))
        if isinstance(parsed, list):
            for item in parsed[-ASSISTANT_PROFILE["generation"]["voice_history_messages"]:]:
                if not isinstance(item, dict) or item.get("role") not in {"user", "assistant"}:
                    continue
                content = str(item.get("content", "")).strip()[:600]
                if content:
                    previous_messages.append({"role": item["role"], "content": content})
    except (TypeError, ValueError):
        previous_messages = []

    user_message = {"role": "user", "content": transcript}
    image_file = request.files.get("image")
    if image_file:
        try:
            image = prepare_image(image_file)
            encoded = io.BytesIO()
            image.save(encoded, format="JPEG", quality=80, optimize=True)
            image_bytes = encoded.getvalue()
            if len(image_bytes) > 240_000:
                return jsonify(error="Ảnh thoại quá lớn; thử lại nhé."), 413
            user_message["images"] = [base64.b64encode(image_bytes).decode("ascii")]
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

    try:
        voice_profile = json.loads((ROOT / "assistant_profile.json").read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        voice_profile = ASSISTANT_PROFILE
    messages = [
        {"role": "system", "content": f"{voice_profile['prompts']['core']} {voice_profile['prompts']['voice']}"},
        *previous_messages,
        user_message,
    ]
    body = json.dumps({
        "model": LOCAL_VISION_MODEL,
        "messages": messages,
        "stream": True,
        "think": False,
        "keep_alive": "10m",
        "options": {
            "temperature": ASSISTANT_PROFILE["generation"]["voice_temperature"],
            "num_predict": ASSISTANT_PROFILE["generation"]["cloud_voice_max_tokens"],
        },
    }, ensure_ascii=False).encode("utf-8")
    upstream_request = Request(
        f"{LOCAL_OLLAMA_URL}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
    )

    def event(payload):
        return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

    def stream_answer():
        answer_parts = []
        try:
            with urlopen(upstream_request, timeout=180) as upstream:
                for raw_line in upstream:
                    if not raw_line.strip():
                        continue
                    try:
                        chunk = json.loads(raw_line)
                    except (TypeError, ValueError):
                        continue
                    delta = str(chunk.get("message", {}).get("content", ""))
                    if delta:
                        answer_parts.append(delta)
                        yield event({"type": "delta", "text": delta})
                    if chunk.get("done") is True:
                        break

            answer = "".join(answer_parts).strip()
            if not answer:
                yield event({"type": "error", "message": "Mô hình chưa trả lời được lượt này."})
                return
            with database() as db:
                db.execute(
                    "INSERT INTO history(user_id,question,answer,labels_json,created_at) VALUES(?,?,?,?,?)",
                    (row["id"], transcript, answer, "[]", now_iso()),
                )
            yield event({"type": "done", "text": answer})
        except GeneratorExit:
            raise
        except Exception:
            log.exception("Local streaming voice response failed")
            yield event({"type": "error", "message": "Qwen trên laptop chưa trả lời được. Thử lại sau nhé."})

    return Response(
        stream_with_context(stream_answer()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/transcribe")
def transcribe():
    row, error = require_user()
    if error:
        return error
    if not os.environ.get("OPENAI_API_KEY"):
        return jsonify(error="Ghi âm cần cấu hình khóa OpenAI trên máy chủ."), 503
    audio = request.files.get("audio")
    if not audio:
        return jsonify(error="Không nhận được đoạn ghi âm."), 400
    content = audio.read(MAX_AUDIO_BYTES + 1)
    if not content:
        return jsonify(error="Đoạn ghi âm đang trống."), 400
    if len(content) > MAX_AUDIO_BYTES:
        return jsonify(error="Đoạn ghi âm quá dài. Bạn thử nói ngắn hơn nhé."), 413
    mime = (audio.mimetype or "").split(";")[0].lower()
    if mime and mime not in ALLOWED_AUDIO:
        return jsonify(error="Định dạng ghi âm chưa hỗ trợ."), 415
    try:
        from openai import OpenAI
        name = Path(audio.filename or "question.webm").name
        transcript = OpenAI(timeout=35, max_retries=0).audio.transcriptions.create(
            model=TRANSCRIPTION_MODEL,
            file=(name, content, mime or "audio/webm"),
            response_format="text",
            languages=[ASSISTANT_PROFILE["transcription"]["language"]],
            prompt=ASSISTANT_PROFILE["prompts"]["transcription"],
            keywords=ASSISTANT_PROFILE["transcription"]["keywords"],
        )
        text = str(transcript).strip() if isinstance(transcript, str) else str(getattr(transcript, "text", "")).strip()
        return jsonify(
            text=text,
            transcription_provider="openai",
            transcription_model=TRANSCRIPTION_MODEL,
        )
    except Exception:
        log.exception("Audio transcription failed")
        return jsonify(error="Chưa chuyển giọng nói thành chữ được. Kiểm tra khóa API rồi thử lại nhé."), 502


@app.get("/")
def index():
    if not (DIST / "index.html").is_file():
        return "App chưa được build. Chạy npm install rồi npm run build trong design/ro-app.", 503, {"Content-Type": "text/plain; charset=utf-8"}
    return send_from_directory(DIST, "index.html")


@app.get("/<path:path>")
def static_or_app_route(path):
    if path.startswith("api/"):
        return jsonify(error="Không tìm thấy API."), 404
    candidate = (DIST / path).resolve()
    if DIST.resolve() not in candidate.parents and candidate != DIST.resolve():
        return jsonify(error="Không tìm thấy trang."), 404
    if candidate.is_file():
        response = send_from_directory(DIST, path)
        content_type = ASSET_MIME.get(candidate.suffix.lower())
        if content_type:
            response.headers["Content-Type"] = content_type
            response.headers["Cache-Control"] = "no-store"
        return response
    if (DIST / "index.html").is_file():
        return send_from_directory(DIST, "index.html")
    return "Không tìm thấy tệp.", 404


@app.errorhandler(413)
def file_too_large(_error):
    return jsonify(error="Ảnh hoặc ghi âm quá lớn. Bạn chọn tệp nhỏ hơn nhé."), 413


if __name__ == "__main__":
    if os.environ.get("RO_PRELOAD_MODELS", "").strip().lower() in {"1", "true", "yes"}:
        log.info("Preloading navigation detector and zone classifier")
        load_detector()
        if ZONE_MODEL_PATH is not None:
            load_zone_classifier()
        log.info("Navigation models loaded; ready for live frames")
    port = int(os.environ.get("RO_PORT", "8790"))
    app.run(host=os.environ.get("RO_HOST", "127.0.0.1"), port=port, debug=False, threaded=True)
