"""Small, authenticated YOLO inference service for a user's own computer.

Run only on loopback and expose it through a Cloudflare Tunnel. This service
does not save uploaded images or enable browser CORS.
"""

from __future__ import annotations

import hmac
import io
import os
import threading
import time
from pathlib import Path
import re

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.exceptions import RequestEntityTooLarge
from path_occupancy_adapter import YoloBoxPathService, load_policy


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

API_TOKEN = os.environ.get("RO_YOLO_HOST_TOKEN", "").strip()
MODEL_ID = os.environ.get("RO_YOLO_MODEL", "yolo26n").strip().lower()
MODEL_NAMES = {"yolo26n": "yolo26n.pt"}
MODEL_PATH = ROOT.parent / MODEL_NAMES.get(MODEL_ID, "unsupported.pt")
IMAGE_SIZE = max(320, min(960, int(os.environ.get("RO_YOLO_IMAGE_SIZE", "640"))))
CONFIDENCE = max(0.05, min(0.95, float(os.environ.get("RO_YOLO_CONFIDENCE", "0.28"))))
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 1280 * 960
MAX_PATH_IMAGE_BYTES = 2 * 1024 * 1024
MAX_PATH_IMAGE_PIXELS = 1280 * 960
PATH_POLICY_FILE = Path(os.environ.get("RO_YOLO_PATH_POLICY_FILE", str(ROOT / "path_policy.json")))
if not PATH_POLICY_FILE.is_absolute():
    PATH_POLICY_FILE = ROOT / PATH_POLICY_FILE
PATH_POLICY, PATH_POLICY_ERROR = load_policy(PATH_POLICY_FILE)
PATH_SERVICE = YoloBoxPathService(PATH_POLICY) if PATH_POLICY else None
STREAM_ID = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_IMAGE_BYTES + 128 * 1024
_model = None
_model_lock = threading.RLock()


def _authorized() -> bool:
    if not API_TOKEN:
        return False
    supplied = request.headers.get("Authorization", "")
    if not supplied.startswith("Bearer "):
        return False
    return hmac.compare_digest(supplied[7:].strip(), API_TOKEN)


def _get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from ultralytics import YOLO

                _model = YOLO(str(MODEL_PATH))
    return _model


def _device_name() -> str:
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "unknown"


def _warm_model() -> float:
    started = time.perf_counter()
    image = Image.new("RGB", (640, 480), (0, 0, 0))
    with _model_lock:
        _get_model().predict(
            source=image,
            imgsz=IMAGE_SIZE,
            conf=CONFIDENCE,
            max_det=1,
            device=0 if _device_name() == "cuda" else "cpu",
            verbose=False,
        )
    return round((time.perf_counter() - started) * 1000)


@app.get("/api/inference/health")
def health():
    if not _authorized():
        return jsonify(error="unauthorized"), 401
    return jsonify(
        provider="ro-yolo-host",
        ready=_model is not None,
        model=MODEL_NAMES.get(MODEL_ID, "unsupported"),
        model_id=MODEL_ID,
        weights_loaded=_model is not None,
        device=_device_name(),
        image_saved=False,
    )


@app.post("/api/inference/yolo")
def infer():
    if not _authorized():
        return jsonify(error="unauthorized"), 401
    if MODEL_ID not in MODEL_NAMES:
        return jsonify(error="unsupported_model"), 503
    path_fields = {"path_stream_id", "path_frame_id", "path_timestamp_ms", "path_frame_age_ms"}
    if set(request.form.keys()) - path_fields or set(request.files.keys()) != {"image"}:
        return jsonify(error="invalid_request_fields"), 400
    supplied_path_fields = set(request.form.keys()) & path_fields
    if supplied_path_fields and supplied_path_fields != path_fields:
        return jsonify(error="invalid_path_metadata", state="unknown", valid=False), 400
    path_meta = None
    if supplied_path_fields:
        path_meta = {"stream_id": request.form.get("path_stream_id", "")}
        if not STREAM_ID.fullmatch(path_meta["stream_id"]):
            return jsonify(error="invalid_path_stream_id", state="unknown", valid=False), 400
        for field, target, upper in (
            ("path_frame_id", "frame_id", 2**53 - 1),
            ("path_timestamp_ms", "timestamp_ms", 2**53 - 1),
            ("path_frame_age_ms", "frame_age_ms", 60_000),
        ):
            raw = request.form.get(field, "")
            if not raw.isascii() or not raw.isdecimal() or int(raw) > upper:
                return jsonify(error=f"invalid_{field}", state="unknown", valid=False), 400
            path_meta[target] = int(raw)
    uploaded = request.files.get("image")
    if uploaded is None:
        return jsonify(error="missing_image"), 400
    payload = uploaded.read(MAX_IMAGE_BYTES + 1)
    if not payload or len(payload) > MAX_IMAGE_BYTES:
        return jsonify(error="image_size_invalid"), 413
    try:
        with Image.open(io.BytesIO(payload)) as check:
            if check.width * check.height > MAX_IMAGE_PIXELS:
                return jsonify(error="image_pixel_limit"), 413
            check.verify()
        with Image.open(io.BytesIO(payload)) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            width, height = image.size
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        return jsonify(error="invalid_image"), 400

    started = time.perf_counter()
    try:
        prediction_confidence = CONFIDENCE
        if path_meta is not None and PATH_SERVICE is not None:
            prediction_confidence = min(CONFIDENCE, PATH_SERVICE.policy["config"].min_confidence)
        with _model_lock:
            result = _get_model().predict(
                source=image,
                imgsz=IMAGE_SIZE,
                conf=prediction_confidence,
                max_det=20,
                device=0 if _device_name() == "cuda" else "cpu",
                verbose=False,
            )[0]
        names = result.names
        detections = []
        if result.boxes is not None:
            for box in result.boxes[:20]:
                class_id = int(box.cls[0].item())
                confidence = float(box.conf[0].item())
                if confidence < CONFIDENCE:
                    continue
                coords = box.xyxy[0].tolist()
                detections.append({
                    "label": str(names.get(class_id, class_id)),
                    "confidence": confidence,
                    "box": [
                        max(0.0, min(1.0, coords[0] / width)),
                        max(0.0, min(1.0, coords[1] / height)),
                        max(0.0, min(1.0, coords[2] / width)),
                        max(0.0, min(1.0, coords[3] / height)),
                    ],
                })
    except Exception:
        app.logger.exception("YOLO inference failed")
        return jsonify(error="inference_failed"), 503
    path_result = None
    if path_meta is not None:
        if PATH_SERVICE is None:
            path_result = {
                "state": "unknown", "valid": False,
                "reason": PATH_POLICY_ERROR or "path_policy_unavailable",
                **path_meta,
            }
        else:
            try:
                path_result = PATH_SERVICE.evaluate(
                    stream_id=path_meta["stream_id"],
                    frame_id=path_meta["frame_id"],
                    timestamp_ms=path_meta["timestamp_ms"],
                    frame_age_ms=path_meta["frame_age_ms"],
                    width=width,
                    height=height,
                    boxes=result.boxes,
                    names=result.names,
                    model_id=MODEL_NAMES[MODEL_ID],
                    inference_ms=round((time.perf_counter() - started) * 1000, 3),
                )
            except Exception:
                PATH_SERVICE.reset_stream(path_meta["stream_id"])
                app.logger.exception("Path occupancy evaluation failed")
                path_result = {
                    "state": "unknown", "valid": False,
                    "reason": "path_evaluation_failed",
                    **path_meta,
                }
    response = dict(
        provider="ro-yolo-host",
        model=MODEL_NAMES[MODEL_ID],
        model_id=MODEL_ID,
        image_width=width,
        image_height=height,
        detections=detections,
        inference_ms=round((time.perf_counter() - started) * 1000),
        distance_m=None,
        image_saved=False,
    )
    if path_meta is not None:
        response["path_result"] = path_result
    return jsonify(response)


@app.get("/api/inference/path/health")
def path_health():
    if not _authorized():
        return jsonify(error="unauthorized"), 401
    model_id = MODEL_NAMES.get(MODEL_ID, "unsupported")
    if PATH_SERVICE is None:
        return jsonify(
            service="yolo-bbox-path", available=False, model_ready=_model is not None,
            model_id=model_id, policy_id=None, calibration_status="unavailable",
            geometry_source="bbox_proxy", tracking_ready=False,
            tracking_calibrated=False, camera_motion_compensated=False,
            growth_warning_enabled=False, reason=PATH_POLICY_ERROR or "path_policy_unavailable",
        )
    return jsonify(PATH_SERVICE.health(model_ready=_model is not None, model_id=model_id))


@app.post("/api/inference/path/detect")
def infer_path():
    if not _authorized():
        return jsonify(error="unauthorized", state="unknown", valid=False), 401
    if PATH_SERVICE is None:
        return jsonify(error=PATH_POLICY_ERROR or "path_policy_unavailable", state="unknown", valid=False), 503
    expected_fields = {"stream_id", "frame_id", "timestamp_ms", "frame_age_ms", "roi_valid"}
    if set(request.form.keys()) != expected_fields or set(request.files.keys()) != {"image"}:
        return jsonify(error="invalid_request_fields", state="unknown", valid=False), 400
    stream_id = request.form.get("stream_id", "")
    if not STREAM_ID.fullmatch(stream_id):
        return jsonify(error="invalid_stream_id", state="unknown", valid=False), 400
    values = {}
    for name, upper in (("frame_id", 2**53 - 1), ("timestamp_ms", 2**53 - 1), ("frame_age_ms", 60_000)):
        raw = request.form.get(name, "")
        if not raw.isascii() or not raw.isdecimal() or int(raw) > upper:
            return jsonify(error=f"invalid_{name}", state="unknown", valid=False), 400
        values[name] = int(raw)
    if request.form.get("roi_valid") not in {"true", "false"}:
        return jsonify(error="invalid_roi_valid", state="unknown", valid=False), 400
    if request.form.get("roi_valid") != "true":
        PATH_SERVICE.reset_stream(stream_id)
        return jsonify(error="roi_invalid", state="unknown", valid=False,
                       frame_id=values["frame_id"], stream_id=stream_id), 200
    uploaded = request.files.get("image")
    jpeg = uploaded.read(MAX_PATH_IMAGE_BYTES + 1) if uploaded else b""
    if not jpeg:
        return jsonify(error="empty_jpeg", state="unknown", valid=False), 400
    if len(jpeg) > MAX_PATH_IMAGE_BYTES:
        return jsonify(error="jpeg_size_limit", state="unknown", valid=False), 413
    try:
        with Image.open(io.BytesIO(jpeg)) as header:
            if header.format != "JPEG":
                return jsonify(error="jpeg_required", state="unknown", valid=False), 415
            width, height = header.size
            if width * height > MAX_PATH_IMAGE_PIXELS:
                return jsonify(error="image_pixel_limit", state="unknown", valid=False), 413
            header.verify()
        with Image.open(io.BytesIO(jpeg)) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            width, height = image.size
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        PATH_SERVICE.reset_stream(stream_id)
        return jsonify(error="invalid_jpeg", state="unknown", valid=False), 400

    started = time.perf_counter()
    try:
        with _model_lock:
            result = _get_model().predict(
                source=image,
                imgsz=IMAGE_SIZE,
                conf=PATH_SERVICE.policy["config"].min_confidence,
                max_det=20,
                device=0 if _device_name() == "cuda" else "cpu",
                verbose=False,
            )[0]
        inference_ms = round((time.perf_counter() - started) * 1000, 3)
        output = PATH_SERVICE.evaluate(
            stream_id=stream_id,
            frame_id=values["frame_id"],
            timestamp_ms=values["timestamp_ms"],
            frame_age_ms=values["frame_age_ms"],
            width=width,
            height=height,
            boxes=result.boxes,
            names=result.names,
            model_id=MODEL_NAMES[MODEL_ID],
            inference_ms=inference_ms,
        )
        return jsonify(output)
    except RuntimeError as exc:
        PATH_SERVICE.reset_stream(stream_id)
        if str(exc) == "stream_capacity_reached":
            return jsonify(error="stream_capacity_reached", state="unknown", valid=False), 429
        app.logger.exception("YOLO path inference failed")
        return jsonify(error="inference_failed", state="unknown", valid=False), 503
    except Exception:
        PATH_SERVICE.reset_stream(stream_id)
        app.logger.exception("YOLO path inference failed")
        return jsonify(error="inference_failed", state="unknown", valid=False), 503


@app.errorhandler(RequestEntityTooLarge)
def handle_large_request(_error):
    return jsonify(error="request_too_large"), 413


@app.errorhandler(404)
def not_found(_error):
    return jsonify(error="not_found"), 404


if __name__ == "__main__":
    if not API_TOKEN or len(API_TOKEN) < 32:
        raise SystemExit("RO_YOLO_HOST_TOKEN must be set to a random secret with at least 32 characters.")
    if MODEL_ID not in MODEL_NAMES:
        raise SystemExit("RO_YOLO_MODEL must be yolo26n.")
    warmup_ms = _warm_model()
    app.logger.info("YOLO model warmed: model=%s device=%s startup_ms=%d", MODEL_ID, _device_name(), warmup_ms)
    app.run(host="127.0.0.1", port=8795, threaded=True, debug=False)
