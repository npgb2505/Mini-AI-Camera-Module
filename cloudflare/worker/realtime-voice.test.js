import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.js";

function voiceRequest({ origin = "https://app.example", upgrade = true } = {}) {
  const headers = new Headers({ Origin: origin });
  if (upgrade) headers.set("Upgrade", "websocket");
  return new Request("https://app.example/api/voice/realtime", { method: "GET", headers });
}

const configuredEnv = () => ({
  AI: {
    run() {
      throw new Error("AI provider must not be called by a route guard");
    },
  },
});

async function jsonResponse(request, env) {
  const response = await worker.fetch(request, env);
  return { response, payload: await response.json() };
}

test("status reports VieNeu self-hosted TTS separately from ElevenLabs STT", async () => {
  const env = (configured) => ({
    AI: { async run() { return {}; } },
    DB: { prepare() { return { bind() { return this; }, async first() { return null; } }; } },
    ...(configured ? {
      ELEVENLABS_API_KEY: "test-stt-key",
      VIENEU_TTS_ENDPOINT: "https://tts.example/v1/audio/speech",
      VIENEU_TTS_SHARED_TOKEN: "test-shared-token",
    } : {}),
  });

  const configuredResponse = await jsonResponse(new Request("https://app.example/api/status"), env(true));
  assert.equal(configuredResponse.response.status, 200);
  assert.equal(configuredResponse.payload.transcription_provider, "elevenlabs");
  assert.equal(configuredResponse.payload.shared_voice_speech_synthesis, "vieneu_self_hosted");
  assert.equal(configuredResponse.payload.voice_tts_ready, true);
  assert.equal(configuredResponse.payload.voice_tts_provider, "vieneu_self_hosted");
  assert.equal(configuredResponse.payload.voice_tts_model, "vieneu-v3-turbo");
  assert.match(configuredResponse.payload.voice_tts_note, /VieNeu-TTS tự host/);

  const fallback = await jsonResponse(new Request("https://app.example/api/status"), env(false));
  assert.equal(fallback.payload.shared_voice_speech_synthesis, "device_tts");
  assert.equal(fallback.payload.voice_tts_ready, false);
  assert.equal(fallback.payload.voice_tts_model, null);
});

test("file STT posts Scribe v2 multipart directly without loading the ElevenLabs SDK", async () => {
  const nativeFetch = globalThis.fetch;
  const secret = "elevenlabs-file-stt-test-secret";
  const cookie = await signedVoiceCookie(secret);
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return Response.json({ text: "xin chào" });
  };
  try {
    const form = new FormData();
    form.set("audio", new File([new Uint8Array([1, 2, 3])], "question.webm", { type: "audio/webm" }));
    const request = new Request("https://app.example/api/transcribe", {
      method: "POST",
      headers: { Origin: "https://app.example", Cookie: cookie },
      body: form,
    });
    const { response, payload } = await jsonResponse(request, {
      SESSION_SECRET: secret,
      ELEVENLABS_API_KEY: "test-only-key",
      DB: new VoiceTestDB(),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { text: "xin chào", transcription_provider: "elevenlabs", transcription_model: "scribe_v2" });
    assert.equal(captured.url, "https://api.elevenlabs.io/v1/speech-to-text");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers["xi-api-key"], "test-only-key");
    assert.equal(captured.init.body.get("model_id"), "scribe_v2");
    assert.equal(captured.init.body.get("language_code"), "vie");
    assert.equal(captured.init.body.get("tag_audio_events"), "false");
    assert.equal(captured.init.body.get("file").name, "question.webm");
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.binaryType = "blob";
    this.listeners = new Map();
    this.sent = [];
    this.accepted = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  accept() {
    this.accepted = true;
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  async dispatch(type, event) {
    for (const listener of this.listeners.get(type) || []) await listener(event);
  }
}

class VoiceTestDB {
  prepare(sql) {
    let values = [];
    return {
      bind(...args) {
        values = args;
        return this;
      },
      async first() {
        if (/SELECT provider, model_name, encrypted_api_key, updated_at FROM assistant_model_config/.test(sql)) return {
          provider: "cloudflare",
          model_name: "@cf/qwen/qwen3.8-27b",
          encrypted_api_key: "",
          updated_at: null,
        };
        assert.match(sql, /SELECT \* FROM users WHERE id = \?/);
        return values[0] === "voice-user" ? {
          id: "voice-user",
          username: "voice-tester",
          display_name: "Voice tester",
          session_version: 2,
        } : null;
      },
      async all() {
        assert.match(sql, /SELECT question, answer FROM history/);
        return { results: [] };
      },
      async run() {
        assert.match(sql, /INSERT INTO history/);
        return { meta: { changes: 1 } };
      },
    };
  }
}

async function signedVoiceCookie(secret) {
  const payload = { sub: "voice-user", ver: 2, exp: Math.floor(Date.now() / 1000) + 60 };
  const encoded = btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
  const encodedSignature = btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  return `ro_session=${encoded}.${encodedSignature}`;
}

test("realtime voice rejects a cross-origin WebSocket before opening a provider", async () => {
  const env = configuredEnv();
  const { response, payload } = await jsonResponse(
    voiceRequest({ origin: "https://attacker.example" }), env,
  );
  assert.equal(response.status, 403);
  assert.match(payload.error, /Nguồn yêu cầu/);
});

test("realtime voice requires a WebSocket upgrade", async () => {
  const { response, payload } = await jsonResponse(
    voiceRequest({ upgrade: false }), configuredEnv(),
  );
  assert.equal(response.status, 426);
  assert.match(payload.error, /WebSocket/);
});

test("realtime voice reports unavailable when the Workers AI binding is absent", async () => {
  const { response, payload } = await jsonResponse(voiceRequest(), {});
  assert.equal(response.status, 503);
  assert.match(payload.error, /chưa sẵn sàng/);
});

test("realtime voice requires a signed-in profile before opening a provider", async () => {
  const env = configuredEnv();
  const { response, payload } = await jsonResponse(voiceRequest(), env);
  assert.equal(response.status, 401);
  assert.match(payload.error, /Đăng nhập lại/);
});

test("ElevenLabs TTS requires an authenticated profile before calling the provider", async () => {
  const nativeFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error("provider must not be called"); };
  try {
    const request = new Request("https://app.example/api/voice/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.example" },
      body: JSON.stringify({ text: "Xin chào" }),
    });
    const { response, payload } = await jsonResponse(request, {
      ELEVENLABS_API_KEY: "test-only-key",
      SESSION_SECRET: "voice-route-test-secret",
      DB: new VoiceTestDB(),
    });
    assert.equal(response.status, 401);
    assert.match(payload.error, /Chưa đăng nhập/);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("authenticated VieNeu TTS uses protected self-host endpoint and returns WAV bytes", async () => {
  const nativeFetch = globalThis.fetch;
  const secret = "voice-route-test-secret";
  const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  const providerCalls = [];
  globalThis.fetch = async (url, init) => {
    providerCalls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(audio, { status: 200, headers: { "Content-Type": "audio/wav" } });
  };
  try {
    const request = new Request("https://app.example/api/voice/synthesize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.example",
        Cookie: await signedVoiceCookie(secret),
      },
      body: JSON.stringify({ text: "Xin chào, mình đang kiểm tra giọng đọc." }),
    });
    const response = await worker.fetch(request, {
      ELEVENLABS_API_KEY: "test-only-key",
      VIENEU_TTS_ENDPOINT: "https://tts.example/v1/audio/speech",
      VIENEU_TTS_SHARED_TOKEN: "test-shared-token",
      SESSION_SECRET: secret,
      DB: new VoiceTestDB(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.equal(response.headers.get("x-voice-provider"), "vieneu_self_hosted");
    assert.equal(response.headers.get("x-voice-model"), "vieneu-v3-turbo");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio);
    assert.equal(providerCalls.length, 1);
    const providerHeaders = new Headers(providerCalls[0].headers);
    assert.equal(providerCalls[0].url, "https://tts.example/v1/audio/speech");
    assert.equal(providerHeaders.get("authorization"), "Bearer test-shared-token");
    assert.deepEqual(providerCalls[0].body, {
      model: "vieneu-v3-turbo",
      input: "Xin chào, mình đang kiểm tra giọng đọc.",
      voice: "Hải Đăng",
      response_format: "wav",
    });
    assert.equal(response.headers.has("authorization"), false);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("VieNeu TTS sanitizes host authentication, queue, and availability errors", async () => {
  const nativeFetch = globalThis.fetch;
  const secret = "voice-route-test-secret";
  try {
    for (const [status, expected] of [
      [401, /Token dịch vụ tới gateway VieNeu-TTS không hợp lệ/],
      [429, /đang bận/],
      [403, /Token dịch vụ tới gateway VieNeu-TTS không hợp lệ/],
      [503, /máy chủ VieNeu-TTS hiện chưa sẵn sàng/i],
    ]) {
      globalThis.fetch = async () => new Response("private provider error details", { status });
      const request = new Request("https://app.example/api/voice/synthesize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.example",
          Cookie: await signedVoiceCookie(secret),
        },
        body: JSON.stringify({ text: "Xin chào" }),
      });
      const { response, payload } = await jsonResponse(request, {
        VIENEU_TTS_ENDPOINT: "https://tts.example/v1/audio/speech",
        VIENEU_TTS_SHARED_TOKEN: "test-shared-token",
        SESSION_SECRET: secret,
        DB: new VoiceTestDB(),
      });
      assert.equal(response.status, 502);
      assert.match(payload.error, expected);
      assert.doesNotMatch(JSON.stringify(payload), /private provider error details|test-shared-token/);
    }
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("authenticated realtime session keeps the same socket open for consecutive spoken turns", async () => {
  const nativeResponse = globalThis.Response;
  const nativeWebSocket = globalThis.WebSocket;
  const nativeWebSocketPair = globalThis.WebSocketPair;
  const provider = new FakeSocket();
  const pair = { client: new FakeSocket(), server: new FakeSocket() };
  globalThis.Response = class TestResponse extends nativeResponse {
    constructor(body, init = {}) {
      const { webSocket, ...responseInit } = init;
      super(body, responseInit.status === 101 ? { ...responseInit, status: 200 } : responseInit);
      if (responseInit.status === 101) this.webSocket = webSocket;
    }
  };
  globalThis.WebSocket = { OPEN: 1 };
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = pair.client;
      this[1] = pair.server;
    }
  };

  try {
    const secret = "voice-route-test-secret";
    const cookie = await signedVoiceCookie(secret);
    const calls = [];
    const env = {
      SESSION_SECRET: secret,
      DB: new VoiceTestDB(),
      AI: {
        async run(model, options, runtimeOptions) {
          calls.push({ model, options, runtimeOptions });
          if (runtimeOptions?.websocket) return { webSocket: provider };
          return { response: `Đã nghe lượt ${calls.filter((call) => !call.runtimeOptions?.websocket).length}.` };
        },
      },
    };
    const headers = new Headers({
      Origin: "https://app.example",
      Upgrade: "websocket",
      Cookie: cookie,
    });
    const response = await worker.fetch(
      new Request("https://app.example/api/voice/realtime", { method: "GET", headers }), env,
    );
    assert.equal(response.status, 200, "Node adapter wraps Cloudflare's 101 response for local testing");
    assert.equal(response.webSocket, pair.client);
    assert.equal(pair.server.accepted, true);

    await pair.server.dispatch("message", { data: JSON.stringify({ type: "start" }) });
    assert.equal(calls.length, 1);
    assert.equal(provider.binaryType, "arraybuffer");
    assert.equal(calls[0].options.sample_rate, "16000");
    assert.equal(calls[0].options.encoding, "linear16");
    assert.equal(JSON.parse(provider.sent[0]).type, "Configure");
    assert.equal(JSON.parse(pair.server.sent[0]).type, "session_ready");

    const pcm = new Uint8Array([1, 0, 2, 0]);
    await pair.server.dispatch("message", { data: pcm });
    assert.equal(provider.sent[1], pcm);

    await provider.dispatch("message", { data: JSON.stringify({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "phía trước có gì" }] },
    }) });
    const messages = pair.server.sent.map((value) => JSON.parse(value));
    assert.ok(messages.some((message) => message.type === "transcript" && message.final === true));
    assert.ok(messages.some((message) => message.type === "assistant_start"));
    assert.ok(messages.some((message) => message.type === "assistant_delta" && message.text === "Đã nghe lượt 1."));
    assert.ok(messages.some((message) => message.type === "assistant_done" && message.text === "Đã nghe lượt 1."));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.stream, true);
    assert.match(JSON.stringify(calls[1].options.messages), /phía trước có gì/);

    await provider.dispatch("message", { data: JSON.stringify({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "còn phía bên trái thì sao" }] },
    }) });
    const followUpMessages = pair.server.sent.map((value) => JSON.parse(value));
    assert.equal(followUpMessages.filter((message) => message.type === "assistant_done").length, 2);
    assert.equal(followUpMessages.filter((message) => message.type === "assistant_start").length, 2);
    assert.equal(calls.length, 3);
    assert.match(JSON.stringify(calls[2].options.messages), /phía trước có gì/);
    assert.match(JSON.stringify(calls[2].options.messages), /phía bên trái thì sao/);
    assert.match(JSON.stringify(calls[2].options.messages), /Đã nghe lượt 2/);
    await pair.server.dispatch("close", {});
  } finally {
    await pair.server.dispatch("close", {});
    globalThis.Response = nativeResponse;
    globalThis.WebSocket = nativeWebSocket;
    globalThis.WebSocketPair = nativeWebSocketPair;
  }
});

test("ElevenLabs Scribe session accepts a second committed transcript after playback acknowledgement", async () => {
  const nativeResponse = globalThis.Response;
  const nativeWebSocket = globalThis.WebSocket;
  const nativeWebSocketPair = globalThis.WebSocketPair;
  const nativeFetch = globalThis.fetch;
  const provider = new FakeSocket();
  const pair = { client: new FakeSocket(), server: new FakeSocket() };
  globalThis.Response = class TestResponse extends nativeResponse {
    constructor(body, init = {}) {
      const { webSocket, ...responseInit } = init;
      super(body, responseInit.status === 101 ? { ...responseInit, status: 200 } : responseInit);
      if (responseInit.status === 101) this.webSocket = webSocket;
    }
  };
  globalThis.WebSocket = { OPEN: 1 };
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = pair.client;
      this[1] = pair.server;
    }
  };

  try {
    const secret = "elevenlabs-voice-route-test-secret";
    const cookie = await signedVoiceCookie(secret);
    const providerRequests = [];
    const aiCalls = [];
    globalThis.fetch = async (url, init) => {
      providerRequests.push({ url: String(url), headers: init.headers });
      return { status: 101, webSocket: provider, async text() { return ""; } };
    };
    const env = {
      SESSION_SECRET: secret,
      ELEVENLABS_API_KEY: "test-only-key",
      DB: new VoiceTestDB(),
      AI: {
        async run(model, options) {
          aiCalls.push({ model, options });
          return { response: `Trả lời lượt ${aiCalls.length}.` };
        },
      },
    };
    const headers = new Headers({
      Origin: "https://app.example",
      Upgrade: "websocket",
      Cookie: cookie,
    });
    const response = await worker.fetch(
      new Request("https://app.example/api/voice/realtime", { method: "GET", headers }), env,
    );
    assert.equal(response.status, 200);
    assert.equal(response.webSocket, pair.client);
    await pair.server.dispatch("message", { data: JSON.stringify({ type: "start", language: "vi" }) });
    assert.equal(providerRequests.length, 1);
    assert.match(providerRequests[0].url, /model_id=scribe_v2_realtime/);
    assert.match(providerRequests[0].url, /language_code=vie/);
    assert.equal(providerRequests[0].headers["xi-api-key"], "test-only-key");
    await provider.dispatch("message", { data: JSON.stringify({ message_type: "session_started" }) });
    assert.ok(pair.server.sent.map((value) => JSON.parse(value)).some((message) => message.type === "session_ready"));

    const pcm = new Uint8Array([1, 0, 2, 0]);
    await pair.server.dispatch("message", { data: pcm });
    assert.equal(JSON.parse(provider.sent[0]).message_type, "input_audio_chunk");
    for (const [index, text] of ["xin chào", "tiếp tục giúp tôi"].entries()) {
      await provider.dispatch("message", { data: JSON.stringify({ message_type: "committed_transcript", text }) });
      if (index === 0) {
        await pair.server.dispatch("message", { data: JSON.stringify({ type: "assistant_playback_done", reply_id: 1 }) });
      }
    }

    const messages = pair.server.sent.map((value) => JSON.parse(value));
    assert.deepEqual(messages.filter((message) => message.type === "transcript" && message.final).map((message) => message.text), ["xin chào", "tiếp tục giúp tôi"]);
    assert.deepEqual(messages.filter((message) => message.type === "assistant_done").map((message) => message.text), ["Trả lời lượt 1.", "Trả lời lượt 2."]);
    assert.equal(aiCalls.length, 2);
    assert.match(JSON.stringify(aiCalls[1].options.messages), /xin chào/);
    assert.match(JSON.stringify(aiCalls[1].options.messages), /tiếp tục giúp tôi/);
    await pair.server.dispatch("close", {});
  } finally {
    await pair.server.dispatch("close", {});
    globalThis.Response = nativeResponse;
    globalThis.WebSocket = nativeWebSocket;
    globalThis.WebSocketPair = nativeWebSocketPair;
    globalThis.fetch = nativeFetch;
  }
});
