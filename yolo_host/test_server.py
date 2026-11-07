import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("RO_YOLO_HOST_TOKEN", "unit-test-token-with-more-than-32-characters")

import server
from path_occupancy import PathOccupancyConfig
from path_occupancy_adapter import YoloBoxPathService, load_policy


class Value:
    def __init__(self, value):
        self.value = value

    def item(self):
        return self.value


class FakeBox:
    cls = [Value(0)]
    conf = [Value(0.91)]
    xyxy = [SimpleNamespace(tolist=lambda: [2.0, 1.0, 18.0, 9.0])]


class FakeModel:
    def predict(self, **kwargs):
        assert kwargs["imgsz"] == server.IMAGE_SIZE
        return [SimpleNamespace(names={0: "person"}, boxes=[FakeBox()])]


def png_bytes(width=20, height=10):
    from PIL import Image

    image = Image.new("RGB", (width, height), (120, 80, 30))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def jpeg_bytes(width=20, height=10):
    from PIL import Image

    image = Image.new("RGB", (width, height), (120, 80, 30))
    output = io.BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


def path_policy():
    config = PathOccupancyConfig(
        roi_polygon=((0.25, 0.1), (0.75, 0.1), (0.95, 1.0), (0.05, 1.0)),
        min_confidence=0.2,
        occupancy_threshold=0.4,
        object_intrusion_ratio=0.3,
        track_entry_ratio=0.1,
        growth_threshold_per_second=0.2,
        warning_horizon_s=2.0,
        persistence_window=3,
        persistence_required=2,
        min_track_observations=3,
        max_track_gap_ms=1500,
        max_history_ms=4000,
        max_frame_age_ms=5000,
        required_classes=frozenset({"person"}),
        footpoint_required_classes=frozenset({"person"}),
        clear_occupancy_threshold=0.25,
    )
    return {"policy_id": "test-roi-v1", "config": config,
            "class_map": {}, "transport_age_budget_ms": 0}


class YoloHostTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()

    def auth(self):
        return {"Authorization": f"Bearer {server.API_TOKEN}"}

    def test_health_requires_token_and_reports_nonsecret_runtime(self):
        denied = self.client.get("/api/inference/health")
        self.assertEqual(denied.status_code, 401)
        allowed = self.client.get("/api/inference/health", headers=self.auth())
        self.assertEqual(allowed.status_code, 200)
        payload = allowed.get_json()
        self.assertEqual(payload["provider"], "ro-yolo-host")
        self.assertEqual(payload["model"], "yolo26n.pt")
        self.assertNotIn(server.API_TOKEN, allowed.get_data(as_text=True))

    def test_inference_requires_token_and_returns_normalized_boxes_without_saving_image(self):
        with patch.object(server, "_get_model", return_value=FakeModel()), patch.object(server, "_device_name", return_value="cpu"):
            denied = self.client.post("/api/inference/yolo", data={"image": (io.BytesIO(png_bytes()), "frame.png")})
            self.assertEqual(denied.status_code, 401)
            response = self.client.post(
                "/api/inference/yolo",
                headers=self.auth(),
                data={"image": (io.BytesIO(png_bytes()), "frame.png")},
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["provider"], "ro-yolo-host")
        self.assertEqual(payload["image_saved"], False)
        self.assertEqual(payload["detections"][0]["label"], "person")
        self.assertEqual(payload["detections"][0]["box"], [0.1, 0.1, 0.9, 0.9])
        self.assertAlmostEqual(payload["detections"][0]["confidence"], 0.91)

    def test_inference_rejects_invalid_image(self):
        response = self.client.post(
            "/api/inference/yolo", headers=self.auth(),
            data={"image": (io.BytesIO(b"not an image"), "frame.bin")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "invalid_image")

    def test_combined_inference_returns_detections_and_path_from_one_model_call(self):
        service = YoloBoxPathService(path_policy())
        model = FakeModel()
        form = {
            "image": (io.BytesIO(jpeg_bytes()), "frame.jpg"),
            "path_stream_id": "iphone-a", "path_frame_id": "1",
            "path_timestamp_ms": "1000", "path_frame_age_ms": "0",
        }
        with patch.object(server, "PATH_SERVICE", service), patch.object(server, "_get_model", return_value=model), patch.object(server, "_device_name", return_value="cpu"), patch.object(model, "predict", wraps=model.predict) as predict:
            first = self.client.post("/api/inference/yolo", headers=self.auth(), data=form, content_type="multipart/form-data")
            form2 = {**form, "image": (io.BytesIO(jpeg_bytes()), "frame.jpg"), "path_frame_id": "2", "path_timestamp_ms": "1100"}
            second = self.client.post("/api/inference/yolo", headers=self.auth(), data=form2, content_type="multipart/form-data")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(predict.call_count, 2)
        first_payload = first.get_json()
        second_payload = second.get_json()
        self.assertEqual(first_payload["detections"][0]["label"], "person")
        self.assertEqual(first_payload["path_result"]["state"], "caution")
        self.assertEqual(second_payload["path_result"]["state"], "blocked")
        self.assertEqual(second_payload["path_result"]["frame_id"], 2)
        self.assertEqual(second_payload["path_result"]["stream_id"], "iphone-a")

    def test_combined_inference_keeps_detection_when_path_policy_missing(self):
        with patch.object(server, "PATH_SERVICE", None), patch.object(server, "PATH_POLICY_ERROR", "path_policy_missing"), patch.object(server, "_get_model", return_value=FakeModel()), patch.object(server, "_device_name", return_value="cpu"):
            response = self.client.post(
                "/api/inference/yolo", headers=self.auth(),
                data={"image": (io.BytesIO(jpeg_bytes()), "frame.jpg"),
                      "path_stream_id": "iphone-a", "path_frame_id": "1",
                      "path_timestamp_ms": "1000", "path_frame_age_ms": "0"},
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["detections"][0]["label"], "person")
        self.assertEqual(payload["path_result"]["state"], "unknown")
        self.assertEqual(payload["path_result"]["reason"], "path_policy_missing")

    def test_combined_inference_rejects_partial_path_metadata(self):
        response = self.client.post(
            "/api/inference/yolo", headers=self.auth(),
            data={"image": (io.BytesIO(jpeg_bytes()), "frame.jpg"), "path_stream_id": "iphone-a"},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "invalid_path_metadata")

    def test_path_health_requires_token_and_never_claims_calibration(self):
        service = YoloBoxPathService(path_policy())
        with patch.object(server, "PATH_SERVICE", service), patch.object(server, "_model", object()):
            denied = self.client.get("/api/inference/path/health")
            allowed = self.client.get("/api/inference/path/health", headers=self.auth())
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(allowed.status_code, 200)
        payload = allowed.get_json()
        self.assertTrue(payload["available"])
        self.assertEqual(payload["geometry_source"], "bbox_proxy")
        self.assertEqual(payload["calibration_status"], "experimental")
        self.assertFalse(payload["growth_warning_enabled"])
        self.assertNotIn(server.API_TOKEN, allowed.get_data(as_text=True))

    def test_path_policy_missing_fails_closed(self):
        with patch.object(server, "PATH_SERVICE", None), patch.object(server, "PATH_POLICY_ERROR", "path_policy_missing"):
            health = self.client.get("/api/inference/path/health", headers=self.auth())
            detect = self.client.post(
                "/api/inference/path/detect", headers=self.auth(),
                data={"stream_id": "iphone-a", "frame_id": "1", "timestamp_ms": "1000",
                      "frame_age_ms": "0", "roi_valid": "true",
                      "image": (io.BytesIO(jpeg_bytes()), "frame.jpg")},
                content_type="multipart/form-data",
            )
        self.assertEqual(health.status_code, 200)
        self.assertFalse(health.get_json()["available"])
        self.assertEqual(detect.status_code, 503)
        self.assertEqual(detect.get_json()["state"], "unknown")

    def test_path_bbox_proxy_uses_roi_k_of_n_and_keeps_growth_disabled(self):
        service = YoloBoxPathService(path_policy())
        data = {"image": (io.BytesIO(jpeg_bytes()), "frame.jpg"),
                "stream_id": "iphone-a", "frame_id": "1", "timestamp_ms": "1000",
                "frame_age_ms": "0", "roi_valid": "true"}
        with patch.object(server, "PATH_SERVICE", service), patch.object(server, "_get_model", return_value=FakeModel()), patch.object(server, "_device_name", return_value="cpu"):
            first = self.client.post("/api/inference/path/detect", headers=self.auth(),
                                     data=data, content_type="multipart/form-data")
            data2 = {**data, "image": (io.BytesIO(jpeg_bytes()), "frame.jpg"),
                     "frame_id": "2", "timestamp_ms": "1100"}
            second = self.client.post("/api/inference/path/detect", headers=self.auth(),
                                      data=data2, content_type="multipart/form-data")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        first_payload = first.get_json()
        second_payload = second.get_json()
        self.assertEqual(first_payload["state"], "caution")
        self.assertEqual(second_payload["state"], "blocked")
        self.assertEqual(second_payload["geometry_source"], "bbox_proxy")
        self.assertEqual(second_payload["stream_id"], "iphone-a")
        self.assertEqual(second_payload["frame_id"], 2)
        self.assertEqual(second_payload["calibration_status"], "experimental")
        self.assertFalse(second_payload["tracking_calibrated"])
        self.assertFalse(second_payload["camera_motion_compensated"])
        self.assertFalse(second_payload["growth_warning_enabled"])

    def test_path_policy_loads_class_confidence_cutoffs_and_reports_them(self):
        raw = {
            "policy_id": "class-threshold-fixture",
            "config": {
                "roi_polygon": [[0.25, 0.1], [0.75, 0.1], [0.95, 1.0], [0.05, 1.0]],
                "min_confidence": 0.2,
                "class_confidence_thresholds": {"person": 0.82},
                "occupancy_threshold": 0.4,
                "object_intrusion_ratio": 0.3,
                "track_entry_ratio": 0.1,
                "growth_threshold_per_second": 0.2,
                "warning_horizon_s": 2.0,
                "persistence_window": 3,
                "persistence_required": 2,
                "min_track_observations": 3,
                "max_track_gap_ms": 1500,
                "max_history_ms": 4000,
                "max_frame_age_ms": 5000,
                "required_classes": ["person"],
                "footpoint_required_classes": ["person"],
            },
            "class_map": {},
            "transport_age_budget_ms": 0,
        }
        with tempfile.TemporaryDirectory() as directory:
            policy_path = Path(directory) / "path_policy.json"
            policy_path.write_text(json.dumps(raw), encoding="utf-8")
            loaded, error = load_policy(policy_path)

        self.assertIsNone(error)
        self.assertEqual(dict(loaded["config"].class_confidence_thresholds), {"person": 0.82})
        health = YoloBoxPathService(loaded).health(model_ready=True, model_id="test")
        self.assertEqual(health["class_confidence_thresholds"], {"person": 0.82})

    def test_path_roi_invalid_and_stale_frame_return_unknown(self):
        service = YoloBoxPathService(path_policy())
        with patch.object(server, "PATH_SERVICE", service), patch.object(server, "_get_model", return_value=FakeModel()), patch.object(server, "_device_name", return_value="cpu"):
            invalid_roi = self.client.post(
                "/api/inference/path/detect", headers=self.auth(),
                data={"image": (io.BytesIO(jpeg_bytes()), "frame.jpg"),
                      "stream_id": "iphone-b", "frame_id": "1", "timestamp_ms": "1000",
                      "frame_age_ms": "0", "roi_valid": "false"},
                content_type="multipart/form-data",
            )
            stale = self.client.post(
                "/api/inference/path/detect", headers=self.auth(),
                data={"image": (io.BytesIO(jpeg_bytes()), "frame.jpg"),
                      "stream_id": "iphone-c", "frame_id": "1", "timestamp_ms": "1000",
                      "frame_age_ms": "6000", "roi_valid": "true"},
                content_type="multipart/form-data",
            )
        self.assertEqual(invalid_roi.status_code, 200)
        self.assertEqual(invalid_roi.get_json()["state"], "unknown")
        self.assertEqual(stale.status_code, 200)
        self.assertEqual(stale.get_json()["state"], "unknown")
        self.assertIsNone(stale.get_json()["occupancy_ratio"])


if __name__ == "__main__":
    unittest.main()
