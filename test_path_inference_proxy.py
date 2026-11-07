from __future__ import annotations

import atexit
import base64
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from urllib.error import URLError
from unittest.mock import patch

from PIL import Image


# Keep Flask session/database initialization out of the user's profile.
_TEST_HOME = tempfile.TemporaryDirectory(prefix="ro-path-proxy-test-")
os.environ["LOCALAPPDATA"] = _TEST_HOME.name
os.environ["RO_DATABASE"] = str(Path(_TEST_HOME.name) / "ro-test.sqlite3")
os.environ["RO_ACCESS_PASSWORD"] = ""
atexit.register(_TEST_HOME.cleanup)

import app as app_module  # noqa: E402


def jpeg_bytes() -> bytes:
    image = Image.new("RGB", (16, 12), (30, 90, 120))
    output = io.BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


class PathInferenceProxyTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_health_requires_login(self):
        response = self.client.get("/api/path/health")
        self.assertEqual(response.status_code, 401)

    def test_health_marks_local_model_available(self):
        health = {
            "service": "detectron2-path",
            "model_ready": True,
            "model_id": "fixture-model",
            "policy_id": "fixture-policy",
            "calibration_status": "experimental",
            "occupancy_threshold": 0.45,
            "clear_occupancy_threshold": 0.3,
            "clear_hysteresis_enabled": True,
            "tracking_calibrated": False,
            "growth_warning_enabled": False,
            "available": False,
            "tof": {"nearest_cm": 42},
            "distance_m": 0.42,
            "access_token": "must-not-leak",
        }
        with patch.object(app_module, "require_user", return_value=(object(), None)), patch.object(
            app_module, "path_inference_request", return_value=io.BytesIO(json.dumps(health).encode())
        ) as upstream:
            response = self.client.get("/api/path/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["available"])
        self.assertEqual(response.json["calibration_status"], "experimental")
        self.assertEqual(response.json["model_id"], "fixture-model")
        self.assertEqual(response.json["policy_id"], "fixture-policy")
        self.assertEqual(response.json["occupancy_threshold"], 0.45)
        self.assertEqual(response.json["clear_occupancy_threshold"], 0.3)
        self.assertTrue(response.json["clear_hysteresis_enabled"])
        self.assertNotIn("tof", response.json)
        self.assertNotIn("distance_m", response.json)
        self.assertNotIn("access_token", response.json)
        upstream.assert_called_once_with("/health", timeout=2.0)

    def test_detect_forwards_jpeg_and_vision_metadata_only(self):
        raw_jpeg = jpeg_bytes()
        upstream_result = {
            "state": "clear_candidate",
            "valid": True,
            "stream_id": "iphone-test",
            "frame_id": 7,
            "timestamp_ms": 123456,
            "occupancy_ratio": 0.125,
            "reason": "no_threshold_crossing_in_valid_frame",
            "occupancy_threshold": 0.45,
            "clear_occupancy_threshold": 0.3,
            "clear_hysteresis_enabled": True,
            "distance_m": 0.42,
            "tof": {"nearest_cm": 42},
        }
        with patch.object(app_module, "require_user", return_value=(object(), None)), patch.object(
            app_module, "path_inference_request",
            return_value=io.BytesIO(json.dumps(upstream_result).encode()),
        ) as upstream:
            response = self.client.post(
                "/api/path/detect",
                data={
                    "image": (io.BytesIO(raw_jpeg), "frame.jpg"),
                    "stream_id": "iphone-test",
                    "frame_id": "7",
                    "timestamp_ms": "123456",
                    "frame_age_ms": "12",
                    "roi_valid": "true",
                },
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["state"], "clear_candidate")
        self.assertEqual(response.json["clear_occupancy_threshold"], 0.3)
        self.assertTrue(response.json["clear_hysteresis_enabled"])
        self.assertNotIn("distance_m", response.json)
        self.assertNotIn("tof", response.json)
        args, kwargs = upstream.call_args
        self.assertEqual(args[0], "/api/path/detect")
        self.assertEqual(kwargs["method"], "POST")
        self.assertEqual(kwargs["timeout"], 45.0)
        forwarded = json.loads(kwargs["body"])
        self.assertEqual(base64.b64decode(forwarded["image_base64"]), raw_jpeg)
        self.assertEqual(forwarded["frame_id"], 7)
        self.assertTrue(forwarded["roi_valid"])
        self.assertFalse({"tof", "distance_m", "distance_cm"} & forwarded.keys())

    def test_detect_rejects_tof_or_unknown_form_fields(self):
        with patch.object(app_module, "require_user", return_value=(object(), None)), patch.object(
            app_module, "path_inference_request"
        ) as upstream:
            response = self.client.post(
                "/api/path/detect",
                data={
                    "image": (io.BytesIO(jpeg_bytes()), "frame.jpg"),
                    "stream_id": "iphone-test",
                    "frame_id": "1",
                    "timestamp_ms": "123456",
                    "frame_age_ms": "12",
                    "roi_valid": "true",
                    "nearest_cm": "42",
                },
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json["state"], "unknown")
        upstream.assert_not_called()

    def test_unavailable_model_service_returns_unknown(self):
        with patch.object(app_module, "require_user", return_value=(object(), None)), patch.object(
            app_module, "path_inference_request", side_effect=URLError("offline")
        ):
            response = self.client.post(
                "/api/path/detect",
                data={
                    "image": (io.BytesIO(jpeg_bytes()), "frame.jpg"),
                    "stream_id": "iphone-test",
                    "frame_id": "1",
                    "timestamp_ms": "123456",
                    "frame_age_ms": "12",
                    "roi_valid": "true",
                },
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json["state"], "unknown")
        self.assertFalse(response.json["valid"])

    def test_segmentation_health_requires_login_and_reports_experimental_model(self):
        response = self.client.get("/api/segmentation/health")
        self.assertEqual(response.status_code, 401)
        health = {
            "service": "segformer-semantic-mask", "model_ready": True,
            "model_id": "fixture-model", "class_names": ["background", "road"],
            "device": "xpu", "calibration_status": "experimental",
            "output_kind": "semantic_class_mask", "navigation_decision_enabled": True,
            "navigation_status": "experimental_candidate_only",
            "navigation_policy": "sanpo_semantic_tapered_three_zone_v1",
            "images_saved": False, "secret": "not-forwarded",
        }
        with patch.object(app_module, "require_user", return_value=(object(), None)), patch.object(
            app_module, "segmentation_request", return_value=io.BytesIO(json.dumps(health).encode()),
        ) as upstream:
            response = self.client.get("/api/segmentation/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["available"])
        self.assertEqual(response.json["model_id"], "fixture-model")
        self.assertTrue(response.json["navigation_decision_enabled"])
        self.assertNotIn("secret", response.json)
        upstream.assert_called_once_with("/health", timeout=3.0)

    def test_segmentation_infer_forwards_jpeg_and_keeps_experimental_contract(self):
        raw_jpeg = jpeg_bytes()
        result = {
            "model_id": "fixture-model", "calibration_status": "experimental",
            "navigation_decision_enabled": True, "image_width": 16, "image_height": 12,
            "inference_ms": 200.0, "classes_present": [{"class_name": "road"}],
            "mask_encoding": "png_rgba_palette", "mask_png_base64": "cG5n",
            "images_saved": False,
            "guidance": {"state": "center", "label_vi": "Giữ hướng giữa", "zones": {}},
            "stream_id": None, "frame_id": None,
        }
        with patch.object(app_module, "require_user", return_value=(object(), None)), patch.object(
            app_module, "segmentation_request",
            return_value=io.BytesIO(json.dumps(result).encode()),
        ) as upstream:
            response = self.client.post(
                "/api/segmentation/infer",
                data={"image": (io.BytesIO(raw_jpeg), "frame.jpg")},
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["model_id"], "fixture-model")
        self.assertTrue(response.json["navigation_decision_enabled"])
        args, kwargs = upstream.call_args
        self.assertEqual(args[0], "/api/segment")
        self.assertEqual(kwargs["method"], "POST")
        self.assertEqual(kwargs["timeout"], 15.0)
        forwarded = json.loads(kwargs["body"])
        self.assertEqual(base64.b64decode(forwarded["image_base64"]), raw_jpeg)

    def test_segmentation_infer_rejects_nonexperimental_navigation_output(self):
        unsafe = {
            "model_id": "fixture-model", "calibration_status": "validated",
            "navigation_decision_enabled": False, "image_width": 16, "image_height": 12,
            "inference_ms": 200.0, "classes_present": [],
            "mask_encoding": "png_rgba_palette", "mask_png_base64": "cG5n",
            "images_saved": False, "guidance": {"state": "unknown"},
            "stream_id": None, "frame_id": None,
        }
        with patch.object(app_module, "require_user", return_value=(object(), None)), patch.object(
            app_module, "segmentation_request",
            return_value=io.BytesIO(json.dumps(unsafe).encode()),
        ):
            response = self.client.post(
                "/api/segmentation/infer",
                data={"image": (io.BytesIO(jpeg_bytes()), "frame.jpg")},
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json["error"], "invalid_segmentation_response")


if __name__ == "__main__":
    unittest.main()
