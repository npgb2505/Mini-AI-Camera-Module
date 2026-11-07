from __future__ import annotations

import atexit
import io
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


# Isolate Flask's database/session initialization from the user's profile.
_TEST_HOME = tempfile.TemporaryDirectory(prefix="ro-voice-transcribe-test-")
os.environ["LOCALAPPDATA"] = _TEST_HOME.name
os.environ["RO_DATABASE"] = str(Path(_TEST_HOME.name) / "ro-test.sqlite3")
os.environ["RO_ACCESS_PASSWORD"] = ""
atexit.register(_TEST_HOME.cleanup)

import app as app_module  # noqa: E402


def mock_openai_module(transcription_result="Rẽ trái trước cửa."):
    openai_module = types.ModuleType("openai")
    client = types.SimpleNamespace(
        audio=types.SimpleNamespace(
            transcriptions=types.SimpleNamespace(
                create=Mock(return_value=transcription_result),
            ),
        ),
    )
    openai_module.OpenAI = Mock(return_value=client)
    return openai_module, client


class VoiceTranscribeTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def post_audio(self, *, content=b"mock audio", filename="question.m4a", mime="audio/mp4"):
        return self.client.post(
            "/api/transcribe",
            data={"audio": (io.BytesIO(content), filename, mime)},
            content_type="multipart/form-data",
        )

    def test_success_returns_text_and_actual_transcription_model_without_history_write(self):
        openai_module, client = mock_openai_module()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}), patch.dict(
            sys.modules, {"openai": openai_module}
        ), patch.object(app_module, "TRANSCRIPTION_MODEL", "gpt-transcribe"), patch.object(
            app_module, "require_user", return_value=(object(), None)
        ), patch.object(app_module, "database") as database:
            response = self.post_audio()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {
            "text": "Rẽ trái trước cửa.",
            "transcription_provider": "openai",
            "transcription_model": "gpt-transcribe",
        })
        openai_module.OpenAI.assert_called_once_with(timeout=35, max_retries=0)
        client.audio.transcriptions.create.assert_called_once()
        request = client.audio.transcriptions.create.call_args.kwargs
        self.assertEqual(request["model"], "gpt-transcribe")
        self.assertEqual(request["file"], ("question.m4a", b"mock audio", "audio/mp4"))
        database.assert_not_called()

    def test_requires_login_before_checking_api_key_or_calling_provider(self):
        response = self.client.post("/api/transcribe")
        self.assertEqual(response.status_code, 401)
        self.assertIn("đăng nhập", response.json["error"])

    def test_missing_provider_key_returns_not_ready_without_calling_openai(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OPENAI_API_KEY", None)
            with patch.object(app_module, "require_user", return_value=(object(), None)):
                response = self.client.post("/api/transcribe")
        self.assertEqual(response.status_code, 503)
        self.assertIn("cấu hình khóa OpenAI", response.json["error"])

    def test_rejects_unsupported_mime_before_provider_call(self):
        openai_module, _ = mock_openai_module()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}), patch.dict(
            sys.modules, {"openai": openai_module}
        ), patch.object(app_module, "require_user", return_value=(object(), None)):
            response = self.post_audio(mime="application/octet-stream")
        self.assertEqual(response.status_code, 415)
        openai_module.OpenAI.assert_not_called()

    def test_rejects_empty_and_oversized_audio_before_provider_call(self):
        openai_module, _ = mock_openai_module()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}), patch.dict(
            sys.modules, {"openai": openai_module}
        ), patch.object(app_module, "require_user", return_value=(object(), None)):
            empty = self.post_audio(content=b"")
            with patch.object(app_module, "MAX_AUDIO_BYTES", 5):
                oversized = self.post_audio(content=b"123456")

        self.assertEqual(empty.status_code, 400)
        self.assertEqual(oversized.status_code, 413)
        openai_module.OpenAI.assert_not_called()


if __name__ == "__main__":
    unittest.main()
