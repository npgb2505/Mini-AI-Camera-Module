from __future__ import annotations

import atexit
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


_TEST_HOME = tempfile.TemporaryDirectory(prefix="ro-camera-frame-freshness-test-")
os.environ["LOCALAPPDATA"] = _TEST_HOME.name
os.environ["RO_DATABASE"] = str(Path(_TEST_HOME.name) / "ro-test.sqlite3")
os.environ["RO_ACCESS_PASSWORD"] = ""
atexit.register(_TEST_HOME.cleanup)

import app as app_module  # noqa: E402


class FirmwareResponse(io.BytesIO):
    def __init__(self, body: bytes, *, content_type: str, frame_seq: int):
        super().__init__(body)
        self.headers = {
            "Content-Type": content_type,
            "X-Frame-Seq": str(frame_seq),
        }

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()


def health_payload(**overrides):
    health = {
        "schema_version": "1.0",
        "origin": "device",
        "device_id": "esp32-s3-cam",
        "boot_id": "boot-camera-freshness-test",
        "seq": 9000,
        "t_ms": 5000,
        "type": "device_health",
        "operation_enabled": True,
        "camera_ok": True,
        "camera_frame_seen": True,
        "camera_frame_seq": 103,
        "camera_frame_age_ms": 120,
        "tof_ok": True,
        "network_ok": True,
    }
    health.update(overrides)
    return health


def detection_event(*, t_ms=4400, frame_seq=98):
    return {
        "schema_version": "1.0",
        "origin": "device",
        "device_id": "esp32-s3-cam",
        "boot_id": "boot-camera-freshness-test",
        "seq": 8000,
        "t_ms": t_ms,
        "type": "detections",
        "frame_seq": frame_seq,
        "items": [{"class_name": "person", "confidence": 0.9}],
        "model_id": "espdet:fixture",
        "inference_status": "ok",
    }


class FirmwareCameraFrameFreshnessTests(unittest.TestCase):
    def test_camera_freshness_comes_from_camera_health_not_old_detection_event(self):
        stale_detection = detection_event(t_ms=4400, frame_seq=98)
        with patch.object(app_module, "ensure_firmware_events"), patch.object(
            app_module,
            "firmware_request",
            return_value=FirmwareResponse(
                json.dumps(health_payload()).encode(),
                content_type="application/json",
                frame_seq=0,
            ),
        ), patch.dict(
            app_module._firmware_events,
            {
                "detections": stale_detection,
                "corridor_decision": None,
                "button_event": None,
                "button_event_at": None,
                "connected": True,
            },
        ):
            snapshot = app_module.firmware_status_snapshot()

        status = snapshot["status"]
        self.assertTrue(snapshot["device_connected"])
        self.assertEqual(status["camera_input_state"], "live")
        self.assertEqual(status["camera_frame"], 103)
        self.assertEqual(status["camera_frame_source"], "camera_health")
        self.assertEqual(status["camera_age_ms"], 120)
        self.assertEqual(status["detections_age_ms"], 600)
        self.assertEqual(status["detections"], [])
        self.assertIsNone(status["detections_frame_seq"])
        self.assertEqual(status["zones"], [])

    def test_display_keeps_detection_for_matching_frame_through_measured_interval(self):
        detection = detection_event(t_ms=4400, frame_seq=103)
        with patch.object(app_module, "ensure_firmware_events"), patch.object(
            app_module,
            "firmware_request",
            return_value=FirmwareResponse(
                json.dumps(health_payload()).encode(),
                content_type="application/json",
                frame_seq=0,
            ),
        ), patch.dict(
            app_module._firmware_events,
            {
                "detections": detection,
                "corridor_decision": None,
                "button_event": None,
                "button_event_at": None,
                "connected": True,
            },
        ):
            status = app_module.firmware_status_snapshot()["status"]

        self.assertEqual(status["detections_age_ms"], 600)
        self.assertEqual(status["detections_frame_seq"], 103)
        self.assertEqual(status["detections"], detection["items"])
        self.assertEqual(status["zones"], [])

    def test_old_firmware_falls_back_to_fresh_detection_frame(self):
        fresh_detection = detection_event(t_ms=4900, frame_seq=101)
        with patch.object(app_module, "ensure_firmware_events"), patch.object(
            app_module,
            "firmware_request",
            return_value=FirmwareResponse(
                json.dumps(health_payload(
                    camera_frame_seen=None,
                    camera_frame_seq=None,
                    camera_frame_age_ms=None,
                )).encode(),
                content_type="application/json",
                frame_seq=0,
            ),
        ), patch.dict(
            app_module._firmware_events,
            {
                "detections": fresh_detection,
                "corridor_decision": None,
                "button_event": None,
                "button_event_at": None,
                "connected": True,
            },
        ):
            status = app_module.firmware_status_snapshot()["status"]

        self.assertEqual(status["camera_frame"], 101)
        self.assertEqual(status["camera_frame_source"], "detections_event")
        self.assertEqual(status["camera_age_ms"], 100)
        self.assertEqual(status["detections_frame_seq"], 101)

    def test_frame_route_accepts_fresh_camera_frame_when_detection_context_is_stale(self):
        camera_status = {
            "source": "device",
            "camera_input_state": "live",
            "camera_frame": 103,
            "camera_frame_source": "camera_health",
            "camera_age_ms": 120,
            "detections_age_ms": 600,
            "detections": [],
            "operation_enabled": True,
        }
        snapshot = {"device_connected": True, "status": camera_status}
        jpeg = b"\xff\xd8fixture-jpeg\xff\xd9"
        response = FirmwareResponse(jpeg, content_type="image/jpeg", frame_seq=104)
        client = app_module.app.test_client()
        with patch.object(app_module, "require_user", return_value=(object(), None)), patch.object(
            app_module, "DEVICE_FIRMWARE_URL", "http://192.168.0.101"
        ), patch.object(app_module, "firmware_status_snapshot", return_value=snapshot), patch.object(
            app_module, "firmware_request", return_value=response
        ):
            result = client.get("/api/device/frame?frame_seq=103")

        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.data, jpeg)
        self.assertEqual(result.headers.get("X-Frame-Seq"), "104")

    def test_frame_route_rejects_camera_capture_older_than_one_second(self):
        snapshot = {
            "device_connected": True,
            "status": {
                "source": "device",
                "camera_input_state": "live",
                "camera_frame": 103,
                "camera_age_ms": 1001,
                "operation_enabled": True,
            },
        }
        client = app_module.app.test_client()
        with patch.object(app_module, "require_user", return_value=(object(), None)), patch.object(
            app_module, "DEVICE_FIRMWARE_URL", "http://192.168.0.101"
        ), patch.object(app_module, "firmware_status_snapshot", return_value=snapshot), patch.object(
            app_module, "firmware_request"
        ) as upstream:
            result = client.get("/api/device/frame")

        self.assertEqual(result.status_code, 409)
        upstream.assert_not_called()


if __name__ == "__main__":
    unittest.main()
