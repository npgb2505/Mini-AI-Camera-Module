"""Small authenticated gateway for a local VieNeu-TTS OpenAI-compatible server."""

from __future__ import annotations

import hmac
import json
import os
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent


def load_dotenv() -> None:
    env_file = ROOT / ".env"
    if not env_file.is_file():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"\''))


load_dotenv()
TOKEN = os.environ.get("VIENEU_TTS_SHARED_TOKEN", "").strip()
UPSTREAM = os.environ.get("VIENEU_TTS_LOCAL_ENDPOINT", "http://127.0.0.1:8000/v1/audio/speech").strip()
HOST = "127.0.0.1"
PORT = int(os.environ.get("VIENEU_TTS_GATEWAY_PORT", "8001"))
MAX_BODY_BYTES = 64 * 1024
MAX_TEXT_CHARS = 1800
SYNTHESIS_SLOTS = threading.BoundedSemaphore(2)


def finalize_streaming_wav(audio: bytes) -> bytes:
    """Replace streaming WAV sentinel lengths with actual RIFF/data sizes."""
    if len(audio) < 12 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        return audio
    finalized = bytearray(audio)
    struct.pack_into("<I", finalized, 4, len(finalized) - 8)
    offset = 12
    while offset + 8 <= len(finalized):
        chunk_id = bytes(finalized[offset:offset + 4])
        chunk_start = offset + 8
        if chunk_id == b"data":
            struct.pack_into("<I", finalized, offset + 4, len(finalized) - chunk_start)
            return bytes(finalized)
        chunk_size = struct.unpack_from("<I", finalized, offset + 4)[0]
        if chunk_size == 0xFFFFFFFF or chunk_start + chunk_size > len(finalized):
            return audio
        offset = chunk_start + chunk_size + (chunk_size & 1)
    return audio


class GatewayHandler(BaseHTTPRequestHandler):
    server_version = "VieNeuGateway/1.0"

    def _send_json(self, status: int, payload: dict[str, str]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not TOKEN:
            self._send_json(503, {"error": "TTS service token is not configured"})
            return False
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {TOKEN}"
        if not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
            self._send_json(401, {"error": "Unauthorized"})
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != "/health":
            self._send_json(404, {"error": "Not found"})
            return
        if self._authorized():
            self._send_json(200, {"ok": "true", "provider": "vieneu-self-hosted"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != "/v1/audio/speech":
            self._send_json(404, {"error": "Not found"})
            return
        if not self._authorized():
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "Invalid content length"})
            return
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "Request size is outside the allowed limit"})
            return
        try:
            payload = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "Invalid JSON"})
            return
        text = str(payload.get("input", "")).strip() if isinstance(payload, dict) else ""
        if not text or len(text) > MAX_TEXT_CHARS:
            self._send_json(400 if not text else 413, {"error": "Text is empty or too long"})
            return
        if not SYNTHESIS_SLOTS.acquire(blocking=False):
            self._send_json(429, {"error": "Synthesis queue is full"})
            return

        upstream_payload = {
            "model": "vieneu-v3-turbo",
            "input": text,
            "voice": str(payload.get("voice") or "Hải Đăng")[:80],
            "response_format": "wav",
        }
        upstream_request = Request(
            UPSTREAM,
            data=json.dumps(upstream_payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(upstream_request, timeout=90) as upstream:
                audio = upstream.read()
                content_type = upstream.headers.get("Content-Type", "audio/wav")
                if not content_type.lower().startswith("audio/") or not audio:
                    self._send_json(502, {"error": "VieNeu-TTS returned an invalid audio response"})
                    return
                if "wav" in content_type.lower():
                    audio = finalize_streaming_wav(audio)
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(audio)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(audio)
        except HTTPError as error:
            status = 429 if error.code == 429 else 502
            self._send_json(status, {"error": "VieNeu-TTS could not synthesize this request"})
        except (TimeoutError, URLError, OSError):
            self._send_json(503, {"error": "VieNeu-TTS is unavailable"})
        finally:
            SYNTHESIS_SLOTS.release()

    def log_message(self, fmt: str, *args: object) -> None:
        # Do not log request bodies, authorization headers, or user speech text.
        print(f"[vieneu-gateway] {self.address_string()} - {fmt % args}")


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("Set VIENEU_TTS_SHARED_TOKEN in vieneu_host/.env before starting the gateway.")
    server = ThreadingHTTPServer((HOST, PORT), GatewayHandler)
    print(f"Authenticated VieNeu gateway listening on http://{HOST}:{PORT}")
    print(f"Upstream model endpoint: {UPSTREAM}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
