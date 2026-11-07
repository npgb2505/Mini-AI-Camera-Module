import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.js";

const SESSION_SECRET = "segmentation-test-session-secret";
const CONFIG_KEY = "segmentation-test-encryption-key-long-enough";
const SERVICE_TOKEN = "segmentation-service-token-do-not-echo";
const USER = { id: "owner-1", username: "owner", display_name: "Owner", session_version: 1 };

class SegmentationDB {
  settings = { endpoint_url: "", encrypted_service_token: "", updated_at: null };
  writes = 0;
  prepare(sql) {
    let values = [];
    const statement = {
      bind(...args) { values = args; return statement; },
      first: async () => {
        if (/SELECT \* FROM users WHERE id = \?/.test(sql)) return values[0] === USER.id ? { ...USER } : null;
        if (/SELECT value FROM app_settings/.test(sql)) return { value: "owner-1" };
        if (/SELECT endpoint_url, encrypted_service_token, updated_at FROM segmentation_host_config/.test(sql)) return { ...this.settings };
        throw new Error(`Unexpected DB query: ${sql}`);
      },
      run: async () => {
        if (/UPDATE segmentation_host_config/.test(sql)) {
          [this.settings.endpoint_url, this.settings.encrypted_service_token, this.settings.updated_at] = values;
          this.writes += 1;
          return { meta: { changes: 1 } };
        }
        throw new Error(`Unexpected DB write: ${sql}`);
      },
    };
    return statement;
  }
}

async function cookie() {
  const payload = { sub: USER.id, ver: USER.session_version, exp: Math.floor(Date.now() / 1000) + 60 };
  const encoded = btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
  return `ro_session=${encoded}.${btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "")}`;
}

function env(DB) { return { DB, SESSION_SECRET, MODEL_SETTINGS_ENCRYPTION_KEY: CONFIG_KEY }; }

async function send(path, { method = "GET", session, body } = {}) {
  const headers = new Headers({ Origin: "https://app.example" });
  if (session) headers.set("Cookie", session);
  if (body instanceof FormData) return new Request(`https://app.example${path}`, { method, headers, body });
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    return new Request(`https://app.example${path}`, { method, headers, body: JSON.stringify(body) });
  }
  return new Request(`https://app.example${path}`, { method, headers });
}

async function configure(DB, session) {
  const response = await worker.fetch(await send("/api/segmentation-settings", {
    method: "PUT", session, body: { endpoint_url: "https://segmentation.trycloudflare.com", service_token: SERVICE_TOKEN },
  }), env(DB));
  assert.equal(response.status, 200);
  return response.json();
}

function mockUpstream(t, handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = previous; });
}

const healthPayload = {
  service: "segformer", model_ready: true, model_id: "segformer-b2-sanpo", class_names: ["road", "sidewalk"],
  device: "cpu", calibration_status: "experimental", output_kind: "mask", navigation_decision_enabled: true,
  images_saved: true, private_debug_path: "must-not-pass", service_token: SERVICE_TOKEN,
};

function resultPayload(overrides = {}) {
  return {
    model_id: "segformer-b2-sanpo", calibration_status: "experimental", navigation_decision_enabled: true,
    image_width: 640, image_height: 480, inference_ms: 215.4,
    classes_present: [{ class_id: 1, class_name: "road", pixels: 190464, area_ratio: 0.62, mean_confidence: 0.91 }],
    mask_encoding: "png_rgba_palette", mask_png_base64: "iVBORw0KGgo=", images_saved: false,
    guidance: { state: "unknown", zones: { center: { status: "walkable_candidate", walkable_score: 0.7, secret: SERVICE_TOKEN } }, private_debug_path: "must-not-pass" },
    stream_id: "stream_1", frame_id: 42, navigation_status: "experimental_candidate_only", private_debug_path: "must-not-pass",
    ...overrides,
  };
}

test("SegFormer settings require a signed session and admin access", async () => {
  const DB = new SegmentationDB();
  assert.equal((await worker.fetch(await send("/api/segmentation-settings"), env(DB))).status, 401);
  const nonAdmin = await cookie();
  const response = await worker.fetch(await send("/api/segmentation-settings", { session: nonAdmin }), env({
    prepare(sql) {
      const statement = { bind() { return statement; }, first: async () => /SELECT \* FROM users/.test(sql) ? { ...USER } : { value: "another-user" } };
      return statement;
    },
  }));
  assert.equal(response.status, 403);
});

test("health and inference routes require an authenticated session", async () => {
  const DB = new SegmentationDB();
  assert.equal((await worker.fetch(await send("/api/segmentation/health"), env(DB))).status, 401);
  const form = new FormData();
  form.set("image", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "frame.jpg", { type: "image/jpeg" }));
  assert.equal((await worker.fetch(await send("/api/segmentation/infer", { method: "POST", body: form }), env(DB))).status, 401);
});

test("settings encrypt token, never echo it, and reject invalid host settings", async () => {
  const DB = new SegmentationDB();
  const session = await cookie();
  const invalid = await worker.fetch(await send("/api/segmentation-settings", {
    method: "PUT", session, body: { endpoint_url: "http://127.0.0.1:8796", service_token: SERVICE_TOKEN },
  }), env(DB));
  assert.equal(invalid.status, 400);
  assert.equal(DB.writes, 0);
  const saved = await configure(DB, session);
  assert.equal(saved.settings.token_configured, true);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(SERVICE_TOKEN));
  assert.notEqual(DB.settings.encrypted_service_token, SERVICE_TOKEN);
  const read = await worker.fetch(await send("/api/segmentation-settings", { session }), env(DB));
  const readPayload = await read.json();
  assert.equal(read.status, 200);
  assert.equal(readPayload.settings.token_configured, true);
  assert.doesNotMatch(JSON.stringify(readPayload), new RegExp(SERVICE_TOKEN));
  assert.doesNotMatch(JSON.stringify(readPayload), /encrypted_service_token/);
});

test("health proxy authenticates upstream, allowlists response, and forces no retention", async (t) => {
  const DB = new SegmentationDB();
  const session = await cookie();
  await configure(DB, session);
  let calls = 0;
  mockUpstream(t, async (url, options) => {
    calls += 1;
    assert.equal(String(url), "https://segmentation.trycloudflare.com/health");
    assert.equal(options.headers.Authorization, `Bearer ${SERVICE_TOKEN}`);
    return Response.json(healthPayload);
  });
  const response = await worker.fetch(await send("/api/segmentation/health", { session }), env(DB));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(payload.model_ready, true);
  assert.equal(payload.images_saved, false);
  assert.equal("private_debug_path" in payload, false);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(SERVICE_TOKEN));
  assert.equal(calls, 1);
});

test("inference forwards only allowed fields and returns mask/guidance without storing input", async (t) => {
  const DB = new SegmentationDB();
  const session = await cookie();
  await configure(DB, session);
  const beforeWrites = DB.writes;
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  let forwarded;
  mockUpstream(t, async (url, options) => {
    assert.equal(String(url), "https://segmentation.trycloudflare.com/api/segment");
    assert.equal(options.headers.Authorization, `Bearer ${SERVICE_TOKEN}`);
    forwarded = JSON.parse(options.body);
    return Response.json(resultPayload());
  });
  const form = new FormData();
  form.set("image", new File([jpeg], "frame.jpg", { type: "image/jpeg" }));
  form.set("stream_id", "stream_1");
  form.set("frame_id", "42");
  const response = await worker.fetch(await send("/api/segmentation/infer", { method: "POST", session, body: form }), env(DB));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(forwarded).sort(), ["frame_id", "image_base64", "stream_id"]);
  assert.equal(forwarded.stream_id, "stream_1");
  assert.equal(forwarded.frame_id, 42);
  assert.equal(payload.guidance.state, "unknown");
  assert.equal(payload.guidance.zones.center.walkable_score, 0.7);
  assert.equal("secret" in payload.guidance.zones.center, false);
  assert.equal("private_debug_path" in payload.guidance, false);
  assert.equal(payload.mask_png_base64, resultPayload().mask_png_base64);
  assert.equal(payload.images_saved, false);
  assert.equal("private_debug_path" in payload, false);
  assert.equal(DB.writes, beforeWrites);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("inference rejects extra fields, invalid IDs, non-JPEG, and oversized frames before proxying", async (t) => {
  const DB = new SegmentationDB();
  const session = await cookie();
  await configure(DB, session);
  mockUpstream(t, async () => { throw new Error("proxy must not be called for invalid input"); });
  const makeForm = (overrides = {}) => {
    const form = new FormData();
    form.set("image", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "frame.jpg", { type: "image/jpeg" }));
    for (const [key, value] of Object.entries(overrides)) form.set(key, value);
    return form;
  };
  for (const form of [makeForm({ extra: "x" }), makeForm({ stream_id: "bad id" }), makeForm({ frame_id: "0" }), makeForm({ frame_id: "1.2" })]) {
    const response = await worker.fetch(await send("/api/segmentation/infer", { method: "POST", session, body: form }), env(DB));
    assert.equal(response.status, 400);
  }
  const wrongType = new FormData();
  wrongType.set("image", new File(["hello"], "frame.png", { type: "image/png" }));
  assert.equal((await worker.fetch(await send("/api/segmentation/infer", { method: "POST", session, body: wrongType }), env(DB))).status, 415);
  const tooLarge = new FormData();
  tooLarge.set("image", new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" }));
  assert.equal((await worker.fetch(await send("/api/segmentation/infer", { method: "POST", session, body: tooLarge }), env(DB))).status, 413);
});

test("inference rejects upstream identity mismatch and oversized responses", async (t) => {
  const DB = new SegmentationDB();
  const session = await cookie();
  await configure(DB, session);
  const form = new FormData();
  form.set("image", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "frame.jpg", { type: "image/jpeg" }));
  form.set("stream_id", "stream_1");
  mockUpstream(t, async () => Response.json(resultPayload({ stream_id: "wrong_stream" })));
  let response = await worker.fetch(await send("/api/segmentation/infer", { method: "POST", session, body: form }), env(DB));
  assert.equal(response.status, 503);
  mockUpstream(t, async () => new Response("x".repeat(16 * 1024), { headers: { "Content-Type": "application/json" } }));
  response = await worker.fetch(await send("/api/segmentation/health", { session }), env(DB));
  assert.equal(response.status, 503);
  const frame = new FormData();
  frame.set("image", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "frame.jpg", { type: "image/jpeg" }));
  mockUpstream(t, async () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": String(13 * 1024 * 1024) } }));
  response = await worker.fetch(await send("/api/segmentation/infer", { method: "POST", session, body: frame }), env(DB));
  assert.equal(response.status, 503);
});
