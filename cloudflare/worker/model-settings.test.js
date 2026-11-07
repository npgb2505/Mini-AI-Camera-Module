import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.js";

const SESSION_SECRET = "model-settings-test-session-secret";
const CONFIG_KEY = "model-settings-test-encryption-key-long-enough";
const API_TOKEN = "model-host-test-token-never-return-this";

class ModelSettingsDB {
  config = {
    provider: "cloudflare",
    model_name: "moondream-cloud",
    endpoint_url: "",
    encrypted_api_key: "",
    updated_at: null,
  };
  assistantConfig = {
    provider: "cloudflare",
    model_name: "@cf/qwen/qwen3.8-27b",
    encrypted_api_key: "",
    updated_at: null,
  };

  prepare(sql) {
    let values = [];
    const statement = {
      bind(...args) { values = args; return statement; },
      first: async () => {
        if (/SELECT \* FROM users WHERE id = \?/.test(sql)) return values[0] === "owner-1" ? {
          id: "owner-1", username: "owner", display_name: "Owner", session_version: 1,
        } : null;
        if (/SELECT value FROM app_settings/.test(sql)) return { value: "owner-1" };
        if (/SELECT provider, model_name, encrypted_api_key, updated_at FROM assistant_model_config/.test(sql)) return { ...this.assistantConfig };
        if (/SELECT provider, model_name, endpoint_url, encrypted_api_key, updated_at FROM model_host_config/.test(sql)) return { ...this.config };
        throw new Error(`Unexpected first query: ${sql}`);
      },
      run: async () => {
        if (/UPDATE assistant_model_config/.test(sql)) {
          [this.assistantConfig.provider, this.assistantConfig.model_name, this.assistantConfig.encrypted_api_key, this.assistantConfig.updated_at] = values;
          return { meta: { changes: 1 } };
        }
        if (/UPDATE model_host_config/.test(sql)) {
          [this.config.provider, this.config.model_name, this.config.endpoint_url, this.config.encrypted_api_key, this.config.updated_at] = values;
          return { meta: { changes: 1 } };
        }
        throw new Error(`Unexpected run query: ${sql}`);
      },
    };
    return statement;
  }
}

async function ownerCookie() {
  const payload = { sub: "owner-1", ver: 1, exp: Math.floor(Date.now() / 1000) + 60 };
  const encoded = btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
  const signed = btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  return `ro_session=${encoded}.${signed}`;
}

async function request(path, { method = "GET", body, cookie } = {}) {
  const headers = new Headers({ Origin: "https://app.example" });
  if (cookie) headers.set("Cookie", cookie);
  if (body instanceof FormData) {
    return new Request(`https://app.example${path}`, { method, headers, body });
  }
  if (body) {
    headers.set("Content-Type", "application/json");
    return new Request(`https://app.example${path}`, { method, headers, body: JSON.stringify(body) });
  }
  return new Request(`https://app.example${path}`, { method, headers });
}

function env(DB) {
  return { DB, SESSION_SECRET, MODEL_SETTINGS_ENCRYPTION_KEY: CONFIG_KEY, AI: { run: async () => ({ objects: [] }) } };
}

test("model settings require a signed app session", async () => {
  const response = await worker.fetch(await request("/api/model-settings"), env(new ModelSettingsDB()));
  assert.equal(response.status, 401);
});

test("assistant settings save GPT-6 Luna and keep the OpenAI key encrypted", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  const response = await worker.fetch(await request("/api/assistant-model-settings", {
    method: "PUT", cookie, body: { provider: "openai", model_name: "gpt-6-luna", api_key: API_TOKEN },
  }), env(DB));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.settings.provider, "openai");
  assert.equal(payload.settings.model_name, "gpt-6-luna");
  assert.equal(payload.settings.api_key_configured, true);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(API_TOKEN));
  assert.notEqual(DB.assistantConfig.encrypted_api_key, API_TOKEN);
  assert.match(DB.assistantConfig.encrypted_api_key, /^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/);
});

test("status describes the configured YOLO host as a general COCO baseline", async () => {
  const DB = new ModelSettingsDB();
  DB.config = {
    provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com",
    encrypted_api_key: "encrypted-token", updated_at: null,
  };
  const response = await worker.fetch(await request("/api/status"), env(DB));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.app_build, "20261106-device-cloud-ask-v1");
  assert.equal(payload.detector_provider, "yolo_host");
  assert.equal(payload.detector_model, "YOLO26n");
  assert.match(payload.detector_target, /COCO-pretrained/);
  assert.match(payload.detector_target, /not fine-tuned or validated/);
  assert.doesNotMatch(payload.detector_target, /stairs, or objects that could block/);
});

test("model settings validate the public tunnel origin and encrypt the host key", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  const invalid = await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "http://127.0.0.1:8795", api_key: API_TOKEN },
  }), env(DB));
  assert.equal(invalid.status, 400);

  const response = await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com", api_key: API_TOKEN },
  }), env(DB));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.settings.api_key_configured, true);
  assert.equal(JSON.stringify(payload).includes(API_TOKEN), false);
  assert.notEqual(DB.config.encrypted_api_key, API_TOKEN);
  assert.match(DB.config.encrypted_api_key, /^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/);
});

test("model smoke check runs inference with a synthetic image and never returns the stored key", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com", api_key: API_TOKEN },
  }), env(DB));
  const originalFetch = globalThis.fetch;
  let receivedAuthorization = "";
  globalThis.fetch = async (input, init = {}) => {
    receivedAuthorization = new Headers(init.headers).get("Authorization") || "";
    assert.equal(receivedAuthorization, `Bearer ${API_TOKEN}`);
    if (String(input) === "https://demo.trycloudflare.com/api/inference/health") {
      return Response.json({ provider: "ro-yolo-host", ready: true, model: "yolo26n.pt", device: "cpu" });
    }
    assert.equal(String(input), "https://demo.trycloudflare.com/api/inference/yolo");
    assert.equal(init.method, "POST");
    assert.ok(init.body instanceof FormData);
    return Response.json({ provider: "ro-yolo-host", model: "yolo26n.pt", detections: [], inference_ms: 41 });
  };
  try {
    const response = await worker.fetch(await request("/api/model-settings", { method: "POST", cookie }), env(DB));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true, provider: "yolo_host", model: "yolo26n.pt", device: "cpu",
      inference_ms: 41, detection_count: 0, sample: "synthetic",
    });
    assert.equal(receivedAuthorization, `Bearer ${API_TOKEN}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model smoke check explains an encryption-key mismatch without leaking credentials", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com", api_key: API_TOKEN },
  }), env(DB));
  const wrongKeyEnv = { ...env(DB), MODEL_SETTINGS_ENCRYPTION_KEY: "different-model-settings-key-also-long-enough" };
  const response = await worker.fetch(await request("/api/model-settings", { method: "POST", cookie }), wrongKeyEnv);
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.match(payload.error, /giải mã được API key/);
  assert.equal(JSON.stringify(payload).includes(API_TOKEN), false);
});

test("Cloudflare model smoke check performs one synthetic inference", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  let calls = 0;
  const testEnv = env(DB);
  testEnv.AI = { run: async (_model, input) => {
    calls += 1;
    assert.equal(input.task, "detect");
    assert.equal(input.stream, false);
    return { objects: [{ label: "person", confidence: 0.8, bbox: [0, 0, 1, 1] }] };
  } };
  const response = await worker.fetch(await request("/api/model-settings", { method: "POST", cookie }), testEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, provider: "cloudflare", model: "@cf/moondream/moondream3.1-9B-A2B", detection_count: 1, sample: "synthetic",
  });
  assert.equal(calls, 1);
});

test("live detection proxies image bytes to YOLO host and normalizes its response", async () => {
  const DB = new ModelSettingsDB();
  DB.config = {
    provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com",
    encrypted_api_key: "", updated_at: null,
  };
  const cookie = await ownerCookie();
  const save = await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com", api_key: API_TOKEN },
  }), env(DB));
  assert.equal(save.status, 200);
  const form = new FormData();
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nNXOQREAIADDsFLjs44IHlyjIGcbZRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncf4OvLrJKgHdr9YYigAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));
  form.set("image", new File([png], "frame.png", { type: "image/png" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init = {}) => {
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${API_TOKEN}`);
    return Response.json({ provider: "ro-yolo-host", model: "yolo26n.pt", inference_ms: 42, detections: [
      { label: "person", confidence: 0.9, box: [0.1, 0.1, 0.9, 0.9] },
      { label: "car", confidence: 0.88, box: [0.1, 0.1, 0.2, 0.2] },
      { label: "traffic_light", confidence: 0.83, box: [0.1, 0.1, 0.2, 0.2] },
      { label: "chair", confidence: 0.81, box: [0.1, 0.1, 0.2, 0.2] },
      { label: "stairs", confidence: 0.80, box: [0.1, 0.1, 0.2, 0.2] },
    ] });
  };
  try {
    const response = await worker.fetch(await request("/api/detect", { method: "POST", cookie, body: form }), env(DB));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.detector_provider, "yolo_host");
    assert.equal(payload.detector_model, "yolo26n.pt");
    assert.equal(payload.inference_ms, 42);
    assert.equal(payload.detections[0].label, "person");
    assert.equal(payload.detections[0].region_vi, "ở giữa");
    assert.equal(payload.detections[0].navigation_role, "person");
    assert.equal(payload.detections[0].navigation_assessment, "unvalidated_candidate_only");
    assert.equal(payload.detections.find((item) => item.label === "car").navigation_role, "vehicle");
    assert.equal(payload.detections.find((item) => item.label === "traffic_light").navigation_role, "traffic_control");
    assert.equal(payload.detections.find((item) => item.label === "chair").navigation_role, "static_object_candidate");
    assert.equal(payload.detections.find((item) => item.label === "stairs").navigation_role, "unmapped");
    assert.equal(payload.image_saved, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("path health proxies only allowlisted nonsecret YOLO metadata", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com", api_key: API_TOKEN },
  }), env(DB));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), "https://demo.trycloudflare.com/api/inference/path/health");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${API_TOKEN}`);
    return Response.json({
      service: "yolo-bbox-path", available: true, model_ready: true,
      model_id: "yolo26n.pt", policy_id: "roi-test-v1",
      calibration_status: "validated", geometry_source: "mask",
      tracking_calibrated: true, camera_motion_compensated: true,
      growth_warning_enabled: true, private_field: "should-not-pass",
    });
  };
  try {
    const response = await worker.fetch(await request("/api/path/health", { cookie }), env(DB));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.available, true);
    assert.equal(payload.geometry_source, "bbox_proxy");
    assert.equal(payload.calibration_status, "experimental");
    assert.equal(payload.tracking_calibrated, false);
    assert.equal(payload.camera_motion_compensated, false);
    assert.equal(payload.growth_warning_enabled, false);
    assert.equal("private_field" in payload, false);
    assert.equal(JSON.stringify(payload).includes(API_TOKEN), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("path health exposes a safe policy-missing reason without leaking host details", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com", api_key: API_TOKEN },
  }), env(DB));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    service: "yolo-bbox-path", available: false, model_ready: true,
    geometry_source: "bbox_proxy", reason: "path_policy_missing",
    disk_path: "C:\\private\\camera\\path_policy.json",
  });
  try {
    const response = await worker.fetch(await request("/api/path/health", { cookie }), env(DB));
    const payload = await response.json();
    assert.equal(payload.available, false);
    assert.equal(payload.reason, "path_policy_missing");
    assert.equal("disk_path" in payload, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("path health reports when the configured host is running an older API build", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com", api_key: API_TOKEN },
  }), env(DB));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });
  try {
    const response = await worker.fetch(await request("/api/path/health", { cookie }), env(DB));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.available, false);
    assert.equal(payload.reason, "path_host_update_required");
    assert.equal(payload.geometry_source, "bbox_proxy");
    assert.equal(JSON.stringify(payload).includes(API_TOKEN), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("path detect validates frame metadata and proxies YOLO occupancy without ToF", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com", api_key: API_TOKEN },
  }), env(DB));
  const form = new FormData();
  form.set("image", new File([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], "frame.jpg", { type: "image/jpeg" }));
  form.set("stream_id", "iphone-stream-a");
  form.set("frame_id", "7");
  form.set("timestamp_ms", "1730000000000");
  form.set("frame_age_ms", "45");
  form.set("roi_valid", "true");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), "https://demo.trycloudflare.com/api/inference/path/detect");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${API_TOKEN}`);
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get("stream_id"), "iphone-stream-a");
    assert.equal(init.body.get("frame_id"), "7");
    assert.equal(init.body.get("roi_valid"), "true");
    return Response.json({
      state: "caution", valid: true, frame_id: 7, timestamp_ms: 1730000000000,
      stream_id: "iphone-stream-a", occupancy_ratio: 0.32,
      tracks: [{ track_id: 2, class_name: "person", confidence: 0.9,
        intrusion: true, path_occupancy_share: 0.32, growth_per_second: 9,
        time_to_threshold_s: 0.2, approaching: true }],
      reason: "current_frame_intrusion", model_id: "yolo26n.pt", policy_id: "roi-v1",
      geometry_source: "bbox_proxy", calibration_status: "validated",
      growth_warning_enabled: true, camera_motion_compensated: true,
      prediction_and_adapter_ms: 38, frame_age_at_decision_ms: 131,
    });
  };
  try {
    const response = await worker.fetch(await request("/api/path/detect", {
      method: "POST", cookie, body: form,
    }), env(DB));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.state, "caution");
    assert.equal(payload.frame_id, 7);
    assert.equal(payload.stream_id, "iphone-stream-a");
    assert.equal(payload.geometry_source, "bbox_proxy");
    assert.equal(payload.calibration_status, "experimental");
    assert.equal(payload.growth_warning_enabled, false);
    assert.equal(payload.tracks[0].growth_per_second, null);
    assert.equal(payload.tracks[0].approaching, false);
    assert.equal("tof_mm" in payload, false);
    assert.equal(JSON.stringify(payload).includes(API_TOKEN), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("path detect rejects invalid image, stream, frame numbers and extra ToF fields", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com", api_key: API_TOKEN },
  }), env(DB));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  try {
    for (const [field, value] of [["stream_id", "bad/stream"], ["frame_id", "-1"], ["frame_age_ms", "60001"]]) {
      const form = new FormData();
      form.set("image", new File([new Uint8Array([1])], "frame.jpg", { type: "image/jpeg" }));
      form.set("stream_id", "iphone-stream-a"); form.set("frame_id", "1");
      form.set("timestamp_ms", "1000"); form.set("frame_age_ms", "0"); form.set("roi_valid", "true");
      form.set(field, value);
      const response = await worker.fetch(await request("/api/path/detect", { method: "POST", cookie, body: form }), env(DB));
      assert.equal(response.status, 400);
    }
    const extra = new FormData();
    extra.set("image", new File([new Uint8Array([1])], "frame.jpg", { type: "image/jpeg" }));
    extra.set("stream_id", "iphone-stream-a"); extra.set("frame_id", "1");
    extra.set("timestamp_ms", "1000"); extra.set("frame_age_ms", "0"); extra.set("roi_valid", "true");
    extra.set("tof_mm", "400");
    const response = await worker.fetch(await request("/api/path/detect", { method: "POST", cookie, body: extra }), env(DB));
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live detection forwards path metadata and returns object/path output from one host inference", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com", api_key: API_TOKEN },
  }), env(DB));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init = {}) => {
    calls += 1;
    assert.equal(String(input), "https://demo.trycloudflare.com/api/inference/yolo");
    assert.equal(init.method, "POST");
    const forwarded = init.body;
    assert.equal(forwarded.get("path_stream_id"), "iphone-a");
    assert.equal(forwarded.get("path_frame_id"), "7");
    assert.equal(forwarded.get("path_timestamp_ms"), "12345");
    assert.equal(forwarded.get("path_frame_age_ms"), "12");
    return Response.json({
      provider: "ro-yolo-host", model: "yolo26n.pt", inference_ms: 45,
      detections: [{ label: "person", confidence: 0.9, box: [0.2, 0.2, 0.8, 0.9] }],
      path_result: { state: "caution", valid: true, stream_id: "iphone-a", frame_id: 7,
        timestamp_ms: 12345, occupancy_ratio: 0.31, reason: "single_frame_or_unconfirmed_intrusion",
        geometry_source: "mask", calibration_status: "validated", growth_warning_enabled: true,
        tracks: [{ class_name: "person", confidence: 0.9, intrusion: true, growth_per_second: 4 }] },
    });
  };
  try {
    const form = new FormData();
    form.set("image", new File([new Uint8Array([1, 2, 3])], "frame.jpg", { type: "image/jpeg" }));
    form.set("path_stream_id", "iphone-a"); form.set("path_frame_id", "7");
    form.set("path_timestamp_ms", "12345"); form.set("path_frame_age_ms", "12");
    const response = await worker.fetch(await request("/api/detect", { method: "POST", cookie, body: form }), env(DB));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(calls, 1);
    assert.equal(payload.detections[0].label, "person");
    assert.equal(payload.path_result.state, "caution");
    assert.equal(payload.path_result.frame_id, 7);
    assert.equal(payload.path_result.stream_id, "iphone-a");
    assert.equal(payload.path_result.geometry_source, "bbox_proxy");
    assert.equal(payload.path_result.calibration_status, "experimental");
    assert.equal(payload.path_result.growth_warning_enabled, false);
    assert.equal(payload.path_result.tracks[0].growth_per_second, null);
    assert.equal("tof_mm" in payload.path_result, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live detection rejects malformed optional path metadata before calling the host", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  try {
    const form = new FormData();
    form.set("image", new File([new Uint8Array([1])], "frame.jpg", { type: "image/jpeg" }));
    form.set("path_stream_id", "bad/stream"); form.set("path_frame_id", "7");
    form.set("path_timestamp_ms", "12345"); form.set("path_frame_age_ms", "12");
    const response = await worker.fetch(await request("/api/detect", { method: "POST", cookie, body: form }), env(DB));
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("live detection failures do not write API credentials to Worker logs", async () => {
  const DB = new ModelSettingsDB();
  const cookie = await ownerCookie();
  const save = await worker.fetch(await request("/api/model-settings", {
    method: "PUT", cookie, body: { provider: "yolo_host", model_name: "yolo26n", endpoint_url: "https://demo.trycloudflare.com", api_key: API_TOKEN },
  }), env(DB));
  assert.equal(save.status, 200);

  const form = new FormData();
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nNXOQREAIADDsFLjs44IHlyjIGcbZRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncf4OvLrJKgHdr9YYigAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));
  form.set("image", new File([png], "frame.png", { type: "image/png" }));

  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logged = [];
  globalThis.fetch = async () => { throw new Error(`simulated upstream failure: ${API_TOKEN}`); };
  console.error = (...args) => logged.push(args.map((value) => String(value)).join(" "));
  try {
    const response = await worker.fetch(await request("/api/detect", { method: "POST", cookie, body: form }), env(DB));
    assert.equal(response.status, 503);
    assert.ok(logged.length > 0);
    assert.doesNotMatch(logged.join("\n"), new RegExp(API_TOKEN));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});
