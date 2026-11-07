import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.js";

const SESSION_SECRET = "device-cloud-test-session-secret";
const ENCRYPTION_KEY = "device-cloud-test-segmentation-encryption-key";
const HOST_TOKEN = "segmentation-host-test-bearer-do-not-store";
const OWNER = { id: "owner-cloud-1", username: "owner", display_name: "Owner", session_version: 1 };
const DEVICE_ID = "esp32-s3-camera-01";
const BOOT_ID = "boot-abc-01";

class DeviceCloudDB {
  claims = new Map();
  pairings = new Map();
  segmentation = { endpoint_url: "", encrypted_service_token: "", updated_at: null };
  writes = [];
  history = [];

  prepare(sql) {
    let values = [];
    const statement = {
      sql: sql.replace(/\s+/g, " ").trim(),
      get values() { return values; },
      bind(...args) { values = args; return statement; },
      first: async () => this.first(statement.sql, values),
      all: async () => this.all(statement.sql, values),
      run: async () => this.run(statement.sql, values),
    };
    return statement;
  }

  async first(sql, values) {
    if (sql === "SELECT * FROM users WHERE id = ?") return values[0] === OWNER.id ? { ...OWNER } : null;
    if (sql.startsWith("SELECT value FROM app_settings WHERE key = ?")) return { value: OWNER.id };
    if (sql.startsWith("SELECT endpoint_url, encrypted_service_token, updated_at FROM segmentation_host_config")) return { ...this.segmentation };
    if (sql.startsWith("SELECT provider, model_name, encrypted_api_key, updated_at FROM assistant_model_config")) return null;
    if (sql.startsWith("SELECT last_seen_at_ms, last_device_id, last_boot_id, last_telemetry_json, last_event_at_ms, last_event_json FROM device_pairings")) {
      return this.pairings.get(values[0]) || null;
    }
    if (sql.startsWith("SELECT user_id, token_sha256, last_seen_at_ms, last_device_id, last_boot_id, last_telemetry_json,")) {
      return [...this.pairings.values()].find((row) => row.token_sha256 === values[0]) || null;
    }
    if (sql.startsWith("SELECT paired_at_ms, last_seen_at_ms, last_device_id, last_boot_id, last_seq, last_telemetry_json,")) {
      return this.pairings.get(values[0]) || null;
    }
    if (sql.startsWith("SELECT last_button_event_id, last_button_event_at_ms, last_button_event_json, last_seen_at_ms,")) {
      return this.pairings.get(values[0]) || null;
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  async all(sql, values) {
    if (sql.startsWith("SELECT question, answer FROM history WHERE user_id=?")) {
      return { results: this.history.filter((row) => row.user_id === values[0]).slice(-values[1]).map(({ question, answer }) => ({ question, answer })) };
    }
    throw new Error(`Unexpected all query: ${sql}`);
  }

  async run(sql, values) {
    if (sql.startsWith("INSERT INTO history(user_id, question, answer, labels_json, created_at)")) {
      const [userId, question, answer, labelsJson, createdAt] = values;
      this.history.push({ user_id: userId, question, answer, labels_json: labelsJson, created_at: createdAt });
      this.writes.push({ table: "history" });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO device_pair_claims")) {
      const [userId, hash, issuedAt, expiresAt] = values;
      this.claims.set(userId, { user_id: userId, token_sha256: hash, issued_at_ms: issuedAt, expires_at_ms: expiresAt, consumed_at_ms: null });
      this.writes.push({ table: "device_pair_claims", row: this.claims.get(userId) });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE segmentation_host_config")) {
      [this.segmentation.endpoint_url, this.segmentation.encrypted_service_token, this.segmentation.updated_at] = values;
      this.writes.push({ table: "segmentation_host_config" });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE device_pairings SET last_device_id=COALESCE(last_device_id,?), last_event_id=?")) {
      const [deviceId, eventId, receivedAt, bootId, seq, json, userId, tokenHash, expectedDevice, expectedBoot, minSeen, eventBoot, minEventSeq, excludedEventId] = values;
      const row = this.pairings.get(userId);
      if (!row || row.token_sha256 !== tokenHash || row.last_device_id !== expectedDevice || row.last_boot_id !== expectedBoot
          || row.last_seen_at_ms <= minSeen
          || (row.last_event_boot_id === eventBoot && Number.isInteger(row.last_event_seq) && row.last_event_seq >= minEventSeq)
          || row.last_event_id === excludedEventId) return { meta: { changes: 0 } };
      row.last_device_id ??= deviceId;
      row.last_event_id = eventId;
      row.last_event_at_ms = receivedAt;
      row.last_event_boot_id = bootId;
      row.last_event_seq = seq;
      row.last_event_json = json;
      this.writes.push({ table: "device_pairings", row: { ...row } });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE device_pairings SET last_button_event_id=?, last_button_event_at_ms=?")) {
      const [eventId, at, bootId, pressId, eventJson, userId, tokenHash, deviceId, expectedBoot,
        minSeen, eventBoot, minPressId, excludedEventId] = values;
      const row = this.pairings.get(userId);
      const telemetry = row ? JSON.parse(row.last_telemetry_json || "null") : null;
      if (!row || row.token_sha256 !== tokenHash || row.last_device_id !== deviceId
          || row.last_boot_id !== expectedBoot || row.last_seen_at_ms <= minSeen
          || telemetry?.operation_enabled !== true
          || (row.last_button_event_boot_id === eventBoot && Number.isInteger(row.last_button_event_press_id)
            && row.last_button_event_press_id >= minPressId)
          || row.last_button_event_id === excludedEventId) return { meta: { changes: 0 } };
      row.last_button_event_id = eventId;
      row.last_button_event_at_ms = at;
      row.last_button_event_boot_id = bootId;
      row.last_button_event_press_id = pressId;
      row.last_button_event_json = eventJson;
      row.last_button_event_claimed_at_ms = null;
      this.writes.push({ table: "device_pairings", row: { ...row } });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE device_pairings SET last_button_event_claimed_at_ms=?")) {
      const [claimedAt, userId, eventId, minEventAt, maxEventAt, minSeen, bootId] = values;
      const row = this.pairings.get(userId);
      const telemetry = row ? JSON.parse(row.last_telemetry_json || "null") : null;
      if (!row || row.last_button_event_id !== eventId || row.last_button_event_claimed_at_ms !== null
          || row.last_button_event_at_ms <= minEventAt || row.last_button_event_at_ms > maxEventAt
          || row.last_seen_at_ms <= minSeen || row.last_boot_id !== bootId
          || telemetry?.operation_enabled !== true) return { meta: { changes: 0 } };
      row.last_button_event_claimed_at_ms = claimedAt;
      this.writes.push({ table: "device_pairings", row: { ...row } });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("DELETE FROM device_pairings WHERE user_id=?")) {
      const changes = this.pairings.delete(values[0]) ? 1 : 0;
      return { meta: { changes } };
    }
    if (sql.startsWith("DELETE FROM device_pair_claims WHERE user_id=?")) {
      const changes = this.claims.delete(values[0]) ? 1 : 0;
      return { meta: { changes } };
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      const sql = statement.sql;
      const values = statement.values;
      if (sql.startsWith("UPDATE device_pair_claims SET consumed_at_ms=?")) {
        const [now, hash] = values;
        const claim = [...this.claims.values()].find((row) => row.token_sha256 === hash);
        if (claim && claim.expires_at_ms > now && claim.consumed_at_ms === null) {
          claim.consumed_at_ms = now;
          results.push({ results: [{ user_id: claim.user_id }], meta: { changes: 1 } });
        } else results.push({ results: [], meta: { changes: 0 } });
      } else if (sql.startsWith("INSERT INTO device_pairings(user_id, token_sha256, paired_at_ms, last_device_id)")) {
        const [tokenHash, pairedAt, deviceId, claimHash, consumedAt, expiresAfter] = values;
        const claim = [...this.claims.values()].find((row) => row.token_sha256 === claimHash && row.consumed_at_ms === consumedAt && row.expires_at_ms > expiresAfter);
        if (!claim) { results.push({ meta: { changes: 0 } }); continue; }
        const row = {
          user_id: claim.user_id, token_sha256: tokenHash, paired_at_ms: pairedAt, last_seen_at_ms: null,
          last_device_id: deviceId, last_boot_id: null, last_seq: null, last_telemetry_json: null,
          last_event_id: null, last_event_at_ms: null, last_event_boot_id: null, last_event_seq: null, last_event_json: null,
          last_button_event_id: null, last_button_event_at_ms: null, last_button_event_boot_id: null,
          last_button_event_press_id: null, last_button_event_json: null, last_button_event_claimed_at_ms: null,
        };
        this.pairings.set(claim.user_id, row);
        this.writes.push({ table: "device_pairings", row: { ...row } });
        results.push({ meta: { changes: 1 } });
      } else if (sql.startsWith("DELETE FROM device_pair_claims WHERE token_sha256=?")) {
        const [hash, consumedAt] = values;
        const claim = [...this.claims.values()].find((row) => row.token_sha256 === hash && row.consumed_at_ms === consumedAt);
        if (claim) this.claims.delete(claim.user_id);
        results.push({ meta: { changes: claim ? 1 : 0 } });
      } else if (sql === "DELETE FROM device_pairings WHERE user_id=?") {
        results.push({ meta: { changes: this.pairings.delete(values[0]) ? 1 : 0 } });
      } else if (sql === "DELETE FROM device_pair_claims WHERE user_id=?") {
        results.push({ meta: { changes: this.claims.delete(values[0]) ? 1 : 0 } });
      } else throw new Error(`Unexpected batch query: ${sql}`);
    }
    return results;
  }
}

async function signedCookie() {
  const payload = { sub: OWNER.id, ver: OWNER.session_version, exp: Math.floor(Date.now() / 1000) + 60 };
  const encoded = btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
  return `ro_session=${encoded}.${btoa(String.fromCharCode(...sig)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "")}`;
}

const envFor = (DB, extra = {}) => ({
  DB,
  SESSION_SECRET,
  MODEL_SETTINGS_ENCRYPTION_KEY: ENCRYPTION_KEY,
  AI: { run: async (_model, options) => ({ response: options.messages.at(-1)?.content ? "Câu trả lời thử nghiệm." : "" }) },
  ...extra,
});

async function request(path, { method = "GET", cookie, body, origin, token } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  if (origin) headers.set("Origin", origin);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body instanceof FormData) return new Request(`https://app.example${path}`, { method, headers, body });
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    return new Request(`https://app.example${path}`, { method, headers, body: JSON.stringify(body) });
  }
  return new Request(`https://app.example${path}`, { method, headers });
}

async function issueClaim(DB, cookie) {
  return worker.fetch(await request("/api/device/pair", { method: "POST", cookie, origin: "https://app.example", body: {} }), envFor(DB));
}

async function redeem(DB, claimCode) {
  return worker.fetch(await request("/api/device/claim/redeem", { method: "POST", body: { claim_code: claimCode, device_id: DEVICE_ID } }), envFor(DB));
}

async function pairDevice(DB, cookie) {
  const issued = await issueClaim(DB, cookie);
  const claim = await issued.json();
  const response = await redeem(DB, claim.claim_code);
  return { response, payload: await response.json(), claim };
}

async function configureSegmentation(DB, cookie) {
  const response = await worker.fetch(await request("/api/segmentation-settings", {
    method: "PUT", cookie, origin: "https://app.example",
    body: { endpoint_url: "https://segmentation.trycloudflare.com", service_token: HOST_TOKEN },
  }), envFor(DB));
  assert.equal(response.status, 200);
}

function seedFreshTelemetry(DB, { bootId = BOOT_ID, frameSeq = 7, operationEnabled = true, lastSeenAtMs = Date.now() } = {}) {
  const row = [...DB.pairings.values()][0];
  row.last_seen_at_ms = lastSeenAtMs;
  row.last_boot_id = bootId;
  row.last_seq = 10;
  row.last_telemetry_json = JSON.stringify({ operation_enabled: operationEnabled, camera_frame_seq: frameSeq, tof_age_ms: 35, tof_ok: true,
    zones: ["left", "center", "right"].map((zone) => ({ zone, tof_valid: zone === "center", nearest_cm: zone === "center" ? 52.25 : null })) });
  return row;
}

function eventForm(overrides = {}, image = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])) {
  const values = {
    event_id: "capture_001", device_id: DEVICE_ID, boot_id: BOOT_ID, seq: "11", frame_seq: "7",
    tof_age_ms: "35", tof_center_cm: "52.25",
    ...overrides,
  };
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, String(value));
  form.set("image", new File([image], "frame.jpg", { type: "image/jpeg" }));
  return form;
}

function askButtonEvent(overrides = {}) {
  return {
    event_id: "esp32-s3-camera-01-boot-abc-01-7",
    device_id: DEVICE_ID,
    boot_id: BOOT_ID,
    press_id: 7,
    button_id: "ask_llm",
    action: "pressed",
    operation_enabled: true,
    ...overrides,
  };
}

function mockSegmentation(t, { status = 200, payload, onCall } = {}) {
  const before = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    onCall?.(url, options);
    return Response.json(payload || segmentationResult(), { status });
  };
  t.after(() => { globalThis.fetch = before; });
}

function segmentationResult(overrides = {}) {
  return {
    model_id: "segformer-b2-sanpo-epoch5", calibration_status: "experimental", navigation_decision_enabled: true,
    image_width: 640, image_height: 480, inference_ms: 201.5,
    classes_present: [{ class_id: 1, class_name: "road", pixels: 1200, area_ratio: 0.62, mean_confidence: 0.9 }],
    mask_encoding: "png_rgba_palette", mask_png_base64: "iVBORw0KGgo=", images_saved: false,
    guidance: { state: "center", label_vi: "Giữ hướng giữa", reason: "center_has_walkable_candidate", zones: { center: { status: "open_candidate", walkable_score: 0.8 } }, secret: "never store" },
    stream_id: "capture_001", frame_id: 7,
    ...overrides,
  };
}

test("pair endpoint returns one-use hashed claim without replacing an existing pairing", async () => {
  const DB = new DeviceCloudDB();
  const cookie = await signedCookie();
  DB.pairings.set(OWNER.id, { user_id: OWNER.id, token_sha256: "previous-pairing-hash", paired_at_ms: 1, last_device_id: "old-device" });
  const response = await issueClaim(DB, cookie);
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.match(payload.claim_code, /^roclaim_[A-Za-z0-9_-]{43}$/);
  assert.equal(payload.expires_at_ms - Date.now() <= 10 * 60 * 1000, true);
  assert.equal(DB.pairings.get(OWNER.id).token_sha256, "previous-pairing-hash");
  assert.notEqual(DB.claims.get(OWNER.id).token_sha256, payload.claim_code);
  assert.doesNotMatch(JSON.stringify(DB.claims), new RegExp(payload.claim_code));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("redeem consumes a valid claim once, binds the device and replaces the previous pairing", async () => {
  const DB = new DeviceCloudDB();
  const cookie = await signedCookie();
  const oldPair = await pairDevice(DB, cookie);
  const oldHash = DB.pairings.get(OWNER.id).token_sha256;
  const claimResponse = await issueClaim(DB, cookie);
  const { claim_code: claimCode } = await claimResponse.json();
  assert.equal(DB.pairings.get(OWNER.id).token_sha256, oldHash, "issuing a claim must preserve the existing device token");
  const first = await redeem(DB, claimCode);
  const payload = await first.json();
  assert.equal(first.status, 200);
  assert.equal(payload.paired, true);
  assert.equal(payload.transport, "cloud_uplink");
  assert.match(payload.device_token, /^rodev_[A-Za-z0-9_-]{43}$/);
  assert.equal(DB.pairings.get(OWNER.id).last_device_id, DEVICE_ID);
  assert.notEqual(DB.pairings.get(OWNER.id).token_sha256, oldHash);
  assert.notEqual(DB.pairings.get(OWNER.id).token_sha256, payload.device_token);
  assert.equal(DB.claims.size, 0);
  assert.doesNotMatch(JSON.stringify(DB.pairings), new RegExp(payload.device_token));
  assert.doesNotMatch(JSON.stringify(payload), /secret|ciphertext/i);
  assert.equal((await (await redeem(DB, claimCode)).json()).error, "Mã ghép đã hết hạn hoặc đã được dùng.");
  const oldTokenResponse = await worker.fetch(await request("/api/device/event", {
    method: "POST", token: oldPair.payload.device_token, body: eventForm(),
  }), envFor(DB));
  assert.equal(oldTokenResponse.status, 401, "re-pair must revoke the prior device token");
});

test("expired claims cannot be redeemed and unpair revokes pairing and pending claims", async () => {
  const DB = new DeviceCloudDB();
  const cookie = await signedCookie();
  const claimResponse = await issueClaim(DB, cookie);
  const { claim_code: claimCode } = await claimResponse.json();
  DB.claims.get(OWNER.id).expires_at_ms = Date.now() - 1;
  assert.equal((await redeem(DB, claimCode)).status, 401);
  DB.claims.get(OWNER.id).expires_at_ms = Date.now() + 60_000;
  const paired = await pairDevice(DB, cookie);
  assert.equal(paired.response.status, 200);
  const unpair = await worker.fetch(await request("/api/device/unpair", { method: "POST", cookie, origin: "https://app.example", body: {} }), envFor(DB));
  assert.equal(unpair.status, 200);
  assert.equal(DB.pairings.has(OWNER.id), false);
  assert.equal(DB.claims.has(OWNER.id), false);
  assert.equal((await redeem(DB, claimCode)).status, 401);
});

test("device event forwards JPEG to mocked segmentation and persists bounded metadata only", async (t) => {
  const DB = new DeviceCloudDB();
  const cookie = await signedCookie();
  const paired = await pairDevice(DB, cookie);
  seedFreshTelemetry(DB);
  await configureSegmentation(DB, cookie);
  let seenImage = false;
  mockSegmentation(t, { onCall: (url, options) => {
    assert.equal(String(url), "https://segmentation.trycloudflare.com/api/segment");
    assert.equal(options.headers.Authorization, `Bearer ${HOST_TOKEN}`);
    const body = JSON.parse(options.body);
    assert.equal(body.stream_id, "capture_001");
    assert.equal(body.frame_id, 7);
    seenImage = typeof body.image_base64 === "string";
  } });
  const response = await worker.fetch(await request("/api/device/event", { method: "POST", token: paired.payload.device_token, body: eventForm() }), envFor(DB));
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.accepted, true);
  assert.equal(payload.images_saved, false);
  assert.equal(payload.event.guidance.label_vi, "Giữ hướng giữa");
  assert.equal(payload.event.tof_center_cm, 52.25);
  assert.equal(seenImage, true);
  const stored = DB.pairings.get(OWNER.id).last_event_json;
  assert.ok(Buffer.byteLength(stored) < 32 * 1024);
  assert.match(stored, /capture_001/);
  assert.doesNotMatch(stored, /mask_png_base64|image_base64|iVBORw0KGgo=|never store/);
  assert.doesNotMatch(JSON.stringify(DB.pairings), /image_base64|mask_png_base64|iVBORw0KGgo=/);
});

test("event rejects malformed metadata, unknown fields, mismatched identity, stale state and replay", async (t) => {
  const DB = new DeviceCloudDB();
  const cookie = await signedCookie();
  const paired = await pairDevice(DB, cookie);
  seedFreshTelemetry(DB);
  await configureSegmentation(DB, cookie);
  let calls = 0;
  mockSegmentation(t, { onCall: () => { calls += 1; } });
  const badForms = [
    eventForm({ event_id: "not an id" }),
    eventForm({ seq: "4294967296" }),
    eventForm({ frame_seq: "0" }),
    eventForm({ tof_age_ms: "NaN" }),
  ];
  for (const form of badForms) {
    const response = await worker.fetch(await request("/api/device/event", { method: "POST", token: paired.payload.device_token, body: form }), envFor(DB));
    assert.equal(response.status, 400);
  }
  const extra = eventForm(); extra.set("unknown", "bad");
  assert.equal((await worker.fetch(await request("/api/device/event", { method: "POST", token: paired.payload.device_token, body: extra }), envFor(DB))).status, 400);
  assert.equal(calls, 0);
  const ok = await worker.fetch(await request("/api/device/event", { method: "POST", token: paired.payload.device_token, body: eventForm() }), envFor(DB));
  assert.equal(ok.status, 202);
  const replay = await worker.fetch(await request("/api/device/event", { method: "POST", token: paired.payload.device_token, body: eventForm() }), envFor(DB));
  assert.equal(replay.status, 409);
  assert.equal(calls, 1);
  const staleRow = DB.pairings.get(OWNER.id);
  staleRow.last_seen_at_ms = Date.now() - 6000;
  const stale = await worker.fetch(await request("/api/device/event", { method: "POST", token: paired.payload.device_token, body: eventForm({ event_id: "capture_002", seq: "12" }) }), envFor(DB));
  assert.equal(stale.status, 409);
  assert.equal(calls, 1);
});

test("event rejects oversized media and invalid bearer without reaching segmentation", async (t) => {
  const DB = new DeviceCloudDB();
  const cookie = await signedCookie();
  const paired = await pairDevice(DB, cookie);
  seedFreshTelemetry(DB);
  await configureSegmentation(DB, cookie);
  mockSegmentation(t, { onCall: () => assert.fail("invalid event reached model") });
  const tooLarge = eventForm({}, new Uint8Array(8 * 1024 * 1024 + 1));
  const oversizedResponse = await worker.fetch(await request("/api/device/event", { method: "POST", token: paired.payload.device_token, body: tooLarge }), envFor(DB));
  assert.equal(oversizedResponse.status, 413);
  const noToken = await worker.fetch(await request("/api/device/event", { method: "POST", body: eventForm() }), envFor(DB));
  assert.equal(noToken.status, 401);
});

test("cloud Ask button event is authenticated, status-compatible, separate from capture, and claimed once", async () => {
  const DB = new DeviceCloudDB();
  const cookie = await signedCookie();
  const paired = await pairDevice(DB, cookie);
  const row = seedFreshTelemetry(DB);
  row.last_event_id = "capture_001";
  row.last_event_at_ms = Date.now();
  row.last_event_json = JSON.stringify({ event_id: "capture_001", action: "capture_image", guidance: { label_vi: "Giữ hướng giữa" } });

  const accepted = await worker.fetch(await request("/api/device/button", {
    method: "POST", token: paired.payload.device_token, body: askButtonEvent(),
  }), envFor(DB));
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).accepted, true);
  assert.equal(row.last_event_id, "capture_001", "Ask must not overwrite the latest image result");

  const status = await worker.fetch(await request("/api/device/status", { cookie }), envFor(DB));
  const payload = await status.json();
  assert.equal(payload.status.button_event.button_id, "ask_llm");
  assert.equal(payload.status.button_event.action, "pressed");
  assert.equal(payload.status.button_event.operation_enabled, true);
  assert.equal(payload.status.button_event_age_ms <= 10_000, true);

  const claims = await Promise.all([1, 2].map(async () => worker.fetch(await request("/api/device/button/claim", {
    method: "POST", cookie, origin: "https://app.example", body: { event_id: askButtonEvent().event_id },
  }), envFor(DB))));
  const claimed = await Promise.all(claims.map((response) => response.json()));
  assert.equal(claimed.filter((result) => result.claimed === true).length, 1, "only one polling tab may trigger the phone microphone");
  const successfulClaim = claimed.find((result) => result.claimed === true);
  assert.equal(successfulClaim.event.button_id, "ask_llm");
  const afterClaim = await (await worker.fetch(await request("/api/device/status", { cookie }), envFor(DB))).json();
  assert.equal(afterClaim.status.button_event, null);
  assert.equal(afterClaim.latest_event.event_id, "capture_001");
});

test("cloud Ask button event rejects invalid schema, identity, inactive mode, replays, and stale telemetry", async () => {
  const DB = new DeviceCloudDB();
  const cookie = await signedCookie();
  const paired = await pairDevice(DB, cookie);
  const row = seedFreshTelemetry(DB);
  const post = async (body = askButtonEvent(), token = paired.payload.device_token) => worker.fetch(
    await request("/api/device/button", { method: "POST", token, body }), envFor(DB));
  assert.equal((await post({ ...askButtonEvent(), extra: true })).status, 400);
  assert.equal((await post(askButtonEvent({ button_id: "capture_image" }))).status, 400);
  assert.equal((await post(askButtonEvent({ device_id: "other-device" }))).status, 409);
  assert.equal((await post(askButtonEvent(), "rodev_" + "x".repeat(43))).status, 401);
  row.last_telemetry_json = JSON.stringify({ operation_enabled: false });
  assert.equal((await post(askButtonEvent({ press_id: 8 }))).status, 409);
  row.last_telemetry_json = JSON.stringify({ operation_enabled: true });
  row.last_seen_at_ms = Date.now() - 6000;
  assert.equal((await post(askButtonEvent({ press_id: 9 }))).status, 409);
  row.last_seen_at_ms = Date.now();
  assert.equal((await post()).status, 202);
  assert.equal((await post()).status, 409);
  assert.equal((await post(askButtonEvent({ press_id: 6, event_id: "older-press" }))).status, 409);
});

test("authenticated device status exposes only the fresh compact event and expires it", async () => {
  const DB = new DeviceCloudDB();
  const cookie = await signedCookie();
  const paired = await pairDevice(DB, cookie);
  const row = seedFreshTelemetry(DB);
  row.last_event_at_ms = Date.now();
  row.last_event_json = JSON.stringify({ event_id: "capture_1", action: "capture_image", frame_seq: 7, guidance: { label_vi: "Giữ hướng giữa" } });
  const fresh = await worker.fetch(await request("/api/device/status", { cookie }), envFor(DB));
  const freshPayload = await fresh.json();
  assert.equal(fresh.status, 200);
  assert.equal(freshPayload.latest_event_fresh, true);
  assert.equal(freshPayload.latest_event.event_id, "capture_1");
  assert.equal(freshPayload.status.camera_input_state, "not_relayed");
  row.last_event_at_ms = Date.now() - 31_000;
  const expiredPayload = await (await worker.fetch(await request("/api/device/status", { cookie }), envFor(DB))).json();
  assert.equal(expiredPayload.latest_event, null);
  assert.equal(expiredPayload.latest_event_fresh, false);
  assert.equal(expiredPayload.state, "device_connected");
});

test("cloud device Ask accepts text without a relayed image and uses only fresh sensor summaries", async () => {
  const DB = new DeviceCloudDB();
  const cookie = await signedCookie();
  await pairDevice(DB, cookie);
  const row = seedFreshTelemetry(DB);
  row.last_event_at_ms = Date.now();
  row.last_event_json = JSON.stringify({
    event_id: "capture_context_1",
    classes_present: [{ class_name: "person", area_ratio: 0.12 }],
    guidance: { label_vi: "Giữ hướng giữa" },
    image_saved: false,
  });
  let seen;
  const env = envFor(DB, { AI: { run: async (model, options) => {
    seen = { model, options };
    return { response: "Câu trả lời thử nghiệm." };
  } } });
  const response = await worker.fetch(await request("/api/device/ask", {
    method: "POST", cookie, origin: "https://app.example", body: { question: "Tôi nên chú ý điều gì?", trigger: "button_event" },
  }), env);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.answer, "Câu trả lời thử nghiệm.");
  assert.equal(payload.image_available, false);
  assert.equal(payload.sensor_context_used, true);
  assert.equal(payload.tof_used, true);
  assert.equal(seen.model, "@cf/qwen/qwen3.8-27b");
  const message = seen.options.messages.at(-1).content;
  assert.match(message, /Tôi nên chú ý điều gì/);
  assert.match(message, /person 12\.0% diện tích ảnh/);
  assert.match(message, /ToF trung tâm ESP32 đo gần nhất 52\.3 cm/);
  assert.doesNotMatch(JSON.stringify(seen.options.messages), /image_url|data:image/);
  assert.equal(DB.history.length, 1);
  assert.equal(DB.history[0].question, "Tôi nên chú ý điều gì?");
});

test("cloud device Ask requires an authenticated owner, fresh paired device, and active MODE", async () => {
  const DB = new DeviceCloudDB();
  const noAuth = await worker.fetch(await request("/api/device/ask", {
    method: "POST", body: { question: "Xin chào" },
  }), envFor(DB));
  assert.equal(noAuth.status, 401);

  const cookie = await signedCookie();
  const noPair = await worker.fetch(await request("/api/device/ask", {
    method: "POST", cookie, body: { question: "Xin chào" },
  }), envFor(DB));
  assert.equal(noPair.status, 409);

  await pairDevice(DB, cookie);
  const row = seedFreshTelemetry(DB, { operationEnabled: false });
  const paused = await worker.fetch(await request("/api/device/ask", {
    method: "POST", cookie, body: { question: "Xin chào" },
  }), envFor(DB));
  assert.equal(paused.status, 409);
  row.last_seen_at_ms = Date.now() - 6000;
  const stale = await worker.fetch(await request("/api/device/ask", {
    method: "POST", cookie, body: { question: "Xin chào" },
  }), envFor(DB));
  assert.equal(stale.status, 409);
  const malformed = await worker.fetch(await request("/api/device/ask", {
    method: "POST", cookie, body: { question: "Xin chào", unexpected: true },
  }), envFor(DB));
  assert.equal(malformed.status, 400);
});
