"""Experimental YOLO-box to corridor-occupancy adapter.

Bounding boxes are rasterized as filled rectangles and passed through the
project's shared PathOccupancyEngine. This deliberately reports
``geometry_source=bbox_proxy`` and never enables growth warnings because box
area can overstate object silhouette and camera motion is not compensated.
"""

from __future__ import annotations

from collections import OrderedDict
import json
from pathlib import Path
import re
import sys
import time
from typing import Any

import numpy as np


_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_PATH_SOFTWARE = _PROJECT_ROOT / "06_AI_phan_mem" / "software"
if str(_PATH_SOFTWARE) not in sys.path:
    sys.path.insert(0, str(_PATH_SOFTWARE))

from iou_tracker import ClassAwareIoUTracker  # noqa: E402
from path_occupancy import InstanceMask, PathOccupancyConfig, PathOccupancyEngine  # noqa: E402


STREAM_ID = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
MAX_STREAMS = 4
STREAM_TTL_S = 60.0


def load_policy(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    """Load an explicit bbox-proxy policy. No guessed ROI/threshold defaults."""
    if not path.is_file():
        return None, "path_policy_missing"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or set(raw) != {
            "policy_id", "config", "class_map", "transport_age_budget_ms",
        }:
            return None, "invalid_path_policy_fields"
        if not isinstance(raw["policy_id"], str) or not raw["policy_id"].strip():
            return None, "invalid_policy_id"
        if type(raw["transport_age_budget_ms"]) is not int or raw["transport_age_budget_ms"] < 0:
            return None, "invalid_transport_age_budget"
        config = raw["config"]
        if not isinstance(config, dict):
            return None, "invalid_path_config"
        config = dict(config)
        class_thresholds = config.get("class_confidence_thresholds", {})
        if not isinstance(class_thresholds, dict) or any(
            not isinstance(label, str) or not isinstance(value, (int, float))
            or isinstance(value, bool)
            for label, value in class_thresholds.items()
        ):
            return None, "invalid_class_confidence_thresholds"
        config["class_confidence_thresholds"] = tuple(sorted(class_thresholds.items()))
        config["roi_polygon"] = tuple(tuple(point) for point in config["roi_polygon"])
        config["required_classes"] = frozenset(config.get("required_classes", ()))
        config["footpoint_required_classes"] = frozenset(config.get("footpoint_required_classes", ()))
        cfg = PathOccupancyConfig(**config)
        class_map = raw["class_map"]
        if not isinstance(class_map, dict) or any(
            not isinstance(key, str) or not isinstance(value, str) or not value.strip()
            for key, value in class_map.items()
        ):
            return None, "invalid_class_map"
        return {"policy_id": raw["policy_id"], "config": cfg,
                "class_map": dict(class_map),
                "transport_age_budget_ms": raw["transport_age_budget_ms"]}, None
    except (OSError, ValueError, TypeError, KeyError):
        return None, "invalid_path_policy"


def detections_to_box_masks(boxes, names, *, width: int, height: int,
                            class_map: dict[str, str]) -> tuple[InstanceMask, ...]:
    """Convert normalized YOLO outputs into conservative filled-box masks."""
    converted: list[InstanceMask] = []
    for box in boxes or ():
        class_id = int(box.cls[0].item())
        label = names.get(class_id, str(class_id)) if isinstance(names, dict) else names[class_id]
        label = class_map.get(str(label), str(label)).strip().lower()
        confidence = float(box.conf[0].item())
        coords = box.xyxy[0].tolist()
        if len(coords) != 4 or not np.all(np.isfinite(coords)):
            raise ValueError("invalid_detection_box")
        x1f, y1f, x2f, y2f = (float(value) for value in coords)
        x1 = max(0, min(width, int(np.floor(x1f))))
        y1 = max(0, min(height, int(np.floor(y1f))))
        x2 = max(0, min(width, int(np.ceil(x2f))))
        y2 = max(0, min(height, int(np.ceil(y2f))))
        if x2 <= x1 or y2 <= y1:
            continue
        mask = np.zeros((height, width), dtype=np.bool_)
        mask[y1:y2, x1:x2] = True
        converted.append(InstanceMask(
            track_id=None,
            class_name=label,
            confidence=confidence,
            mask=mask,
            footpoint=((x1 + x2) / (2 * width), y2 / height),
            bbox_xyxy_norm=(x1 / width, y1 / height, x2 / width, y2 / height),
        ))
    return tuple(converted)


class YoloBoxPathService:
    def __init__(self, policy: dict[str, Any], *, max_streams: int = MAX_STREAMS,
                 stream_ttl_s: float = STREAM_TTL_S):
        if max_streams < 1 or stream_ttl_s <= 0:
            raise ValueError("invalid stream limits")
        self.policy = policy
        self.max_streams = max_streams
        self.stream_ttl_s = stream_ttl_s
        self.streams: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def reset_stream(self, stream_id: str) -> None:
        state = self.streams.pop(stream_id, None)
        if state is not None:
            state["engine"].reset()
            state["tracker"].reset()

    def health(self, *, model_ready: bool, model_id: str) -> dict[str, Any]:
        return {
            "service": "yolo-bbox-path",
            "available": bool(model_ready and self.policy),
            "model_ready": bool(model_ready),
            "model_id": model_id,
            "policy_id": self.policy["policy_id"],
            "calibration_status": "experimental",
            "geometry_source": "bbox_proxy",
            "occupancy_threshold": self.policy["config"].occupancy_threshold,
            "clear_occupancy_threshold": self.policy["config"].effective_clear_occupancy_threshold,
            "clear_hysteresis_enabled": self.policy["config"].clear_hysteresis_enabled,
            "min_confidence": self.policy["config"].min_confidence,
            "class_confidence_thresholds": dict(self.policy["config"].class_confidence_thresholds),
            "transport_age_budget_ms": self.policy["transport_age_budget_ms"],
            "tracking_ready": True,
            "tracking_method": ClassAwareIoUTracker.method,
            "tracking_calibrated": False,
            "camera_motion_compensated": False,
            "growth_warning_enabled": False,
        }

    def unavailable(self, *, model_id: str) -> dict[str, Any]:
        return {
            "service": "yolo-bbox-path",
            "available": False,
            "model_ready": bool(model_id),
            "model_id": model_id,
            "policy_id": None,
            "calibration_status": "unavailable",
            "geometry_source": "bbox_proxy",
            "tracking_ready": False,
            "tracking_calibrated": False,
            "camera_motion_compensated": False,
            "growth_warning_enabled": False,
        }

    def _new_stream(self) -> dict[str, Any]:
        cfg: PathOccupancyConfig = self.policy["config"]
        return {
            "engine": PathOccupancyEngine(cfg),
            "tracker": ClassAwareIoUTracker(max_gap_ms=cfg.max_track_gap_ms),
            "last_frame": -1,
            "last_timestamp": -1,
            "last_seen": time.monotonic(),
        }

    def evaluate(self, *, stream_id: str, frame_id: int, timestamp_ms: int,
                 frame_age_ms: int, width: int, height: int, boxes, names,
                 model_id: str, inference_ms: float) -> dict[str, Any]:
        started = time.perf_counter()
        if not isinstance(stream_id, str) or not STREAM_ID.fullmatch(stream_id):
            raise ValueError("invalid_stream_id")
        for key, value in (("frame_id", frame_id), ("timestamp_ms", timestamp_ms), ("frame_age_ms", frame_age_ms)):
            if type(value) is not int or value < 0:
                raise ValueError(f"invalid_{key}")
        now = time.monotonic()
        for expired in [key for key, state in self.streams.items()
                        if now - state["last_seen"] > self.stream_ttl_s]:
            del self.streams[expired]
        state = self.streams.get(stream_id)
        if state is None:
            if len(self.streams) >= self.max_streams:
                raise RuntimeError("stream_capacity_reached")
            state = self._new_stream()
        if frame_id <= state["last_frame"] or timestamp_ms <= state["last_timestamp"]:
            state["engine"].reset()
            state["tracker"].reset()
            raise ValueError("replayed_or_nonmonotonic_frame")

        age_ms = frame_age_ms + self.policy["transport_age_budget_ms"]
        cfg: PathOccupancyConfig = self.policy["config"]
        if age_ms > cfg.max_frame_age_ms:
            state["engine"].reset()
            state["tracker"].reset()
        else:
            instances = detections_to_box_masks(
                boxes, names, width=width, height=height,
                class_map=self.policy["class_map"],
            )
            tracked = state["tracker"].update(instances, timestamp_ms=timestamp_ms)
            result = state["engine"].update(
                frame_id=frame_id,
                timestamp_ms=timestamp_ms,
                width=width,
                height=height,
                instances=tracked,
                frame_age_ms=age_ms,
                model_valid=True,
                roi_valid=True,
                motion_compensated=False,
            ).to_dict()
            elapsed_ms = (time.perf_counter() - started) * 1000
            decision_age_ms = age_ms + int(np.ceil(elapsed_ms + max(0.0, inference_ms)))
            if decision_age_ms > cfg.max_frame_age_ms:
                state["engine"].reset()
                state["tracker"].reset()
                result = state["engine"].update(
                    frame_id=frame_id, timestamp_ms=timestamp_ms, width=width,
                    height=height, instances=(), frame_age_ms=decision_age_ms,
                    model_valid=False, roi_valid=True, motion_compensated=False,
                ).to_dict()
            state.update(last_frame=frame_id, last_timestamp=timestamp_ms, last_seen=time.monotonic())
            self.streams[stream_id] = state
            result.update({
                "schema_version": "yolo-bbox-path-result-v1",
                "model_id": model_id,
                "policy_id": self.policy["policy_id"],
                "calibration_status": "experimental",
                "geometry_source": "bbox_proxy",
                "prediction_and_adapter_ms": round(inference_ms + elapsed_ms, 3),
                "frame_age_at_decision_ms": decision_age_ms,
                "tracking_ready": bool(result.get("valid")),
                "tracking_method": ClassAwareIoUTracker.method,
                "tracking_calibrated": False,
                "camera_motion_compensated": False,
                "growth_warning_enabled": False,
                "transport_age_budget_ms": self.policy["transport_age_budget_ms"],
                "age_measurement": "client_age_plus_configured_transport_budget_and_server_elapsed",
                "occupancy_threshold": cfg.occupancy_threshold,
                "clear_occupancy_threshold": cfg.effective_clear_occupancy_threshold,
                "clear_hysteresis_enabled": cfg.clear_hysteresis_enabled,
                "min_confidence": cfg.min_confidence,
                "class_confidence_thresholds": dict(cfg.class_confidence_thresholds),
                "stream_id": stream_id,
            })
            return result

        state.update(last_frame=frame_id, last_timestamp=timestamp_ms, last_seen=now)
        state["engine"].reset()
        state["tracker"].reset()
        self.streams[stream_id] = state
        return {
            "schema_version": "yolo-bbox-path-result-v1",
            "state": "unknown",
            "valid": False,
            "frame_id": frame_id,
            "timestamp_ms": timestamp_ms,
            "occupancy_ratio": None,
            "corridor_pixels": None,
            "occupied_pixels": None,
            "tracks": [],
            "reason": "stale_frame",
            "model_id": model_id,
            "policy_id": self.policy["policy_id"],
            "calibration_status": "experimental",
            "geometry_source": "bbox_proxy",
            "frame_age_at_decision_ms": age_ms,
            "tracking_ready": False,
            "tracking_method": ClassAwareIoUTracker.method,
            "tracking_calibrated": False,
            "camera_motion_compensated": False,
            "growth_warning_enabled": False,
            "stream_id": stream_id,
        }
