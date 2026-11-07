import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.js";

const SESSION_SECRET = "worker-device-test-secret";
const TEST_USER = {
  id: "user-1",
  username: "tester",
  display_name: "Tester",
  session_version: 1,
};

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (this.sql === "SELECT * FROM users WHERE id = ?") {
      return this.values[0] === TEST_USER.id ? { ...TEST_USER } : null;
    }
    if (this.sql.startsWith("SELECT user_id, token_sha256, last_device_id, last_boot_id, last_seq FROM device_pairings WHERE token_sha256=?")) {
      return [...this.db.pairings.values()].find((row) => row.token_sha256 === this.values[0]) || null;
    }
    if (this.sql.startsWith("SELECT paired_at_ms, last_seen_at_ms, last_device_id, last_boot_id, last_seq, last_telemetry_json")) {
      return this.db.pairings.get(this.values[0]) || null;
    }
    throw new Error(`Unsupported first() query: ${this.sql}`);
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO device_pair_claims")) {
      const [userId, tokenHash, issuedAt, expiresAt] = this.values;
      this.db.claims.set(userId, { user_id: userId, token_sha256: tokenHash, issued_at_ms: issuedAt, expires_at_ms: expiresAt, consumed_at_ms: null });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO device_pairings(")) {
      const [userId, tokenHash, pairedAt] = this.values;
      this.db.pairings.set(userId, {
        user_id: userId,
        token_sha256: tokenHash,
        paired_at_ms: pairedAt,
        last_seen_at_ms: null,
        last_device_id: null,
        last_boot_id: null,
        last_seq: null,
        last_telemetry_json: null,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE device_pairings SET last_seen_at_ms=?")) {
      const [receivedAt, deviceId, bootId, seq, telemetryJson, userId, tokenHash, expectedDeviceId, expectedBootId, expectedSeq, minimumReceivedAt] = this.values;
      const row = this.db.pairings.get(userId);
      if (!row || row.token_sha256 !== tokenHash
          || (row.last_device_id !== null && row.last_device_id !== expectedDeviceId)
          || (row.last_boot_id !== null && row.last_boot_id === expectedBootId
            && row.last_seq !== null && !(row.last_seq < expectedSeq))
          || (row.last_seen_at_ms !== null && row.last_seen_at_ms > minimumReceivedAt)) {
        return { meta: { changes: 0 } };
      }
      row.last_seen_at_ms = receivedAt;
      row.last_device_id ??= deviceId;
      row.last_boot_id = bootId;
      row.last_seq = seq;
      row.last_telemetry_json = telemetryJson;
      return { meta: { changes: 1 } };
    }
    if (this.sql === "DELETE FROM device_pairings WHERE user_id=?") {
      const changes = this.db.pairings.delete(this.values[0]) ? 1 : 0;
      return { meta: { changes } };
    }
    if (this.sql === "DELETE FROM device_pair_claims WHERE user_id=?") {
      const changes = this.db.claims.delete(this.values[0]) ? 1 : 0;
      return { meta: { changes } };
    }
    throw new Error(`Unsupported run() query: ${this.sql}`);
  }
}

class FakeDB {
  constructor() {
    this.pairings = new Map();
    this.claims = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
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
        const [tokenHash, pairedAt, deviceId, claimHash, consumedAt, expiryAfter] = values;
        const claim = [...this.claims.values()].find((row) => row.token_sha256 === claimHash && row.consumed_at_ms === consumedAt && row.expires_at_ms > expiryAfter);
        if (!claim) { results.push({ meta: { changes: 0 } }); continue; }
        this.pairings.set(claim.user_id, {
          user_id: claim.user_id, token_sha256: tokenHash, paired_at_ms: pairedAt, last_seen_at_ms: null,
          last_device_id: deviceId, last_boot_id: null, last_seq: null, last_telemetry_json: null,
        });
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
      } else throw new Error(`Unsupported batch() query: ${sql}`);
    }
    return results;
  }
}

const envFor = () => ({ DB: new FakeDB(), SESSION_SECRET });

async function sessionCookie() {
  const payload = {
    sub: TEST_USER.id,
    ver: TEST_USER.session_version,
    exp: Math.floor(Date.now() / 1000) + 60,
  };
  const encoded = btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
  const encodedSignature = btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  return `ro_session=${encoded}.${encodedSignature}`;
}

function request(path, { method = "GET", cookie, origin, token, body } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  if (origin) headers.set("Origin", origin);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`https://app.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function tofTelemetry(overrides = {}) {
  return {
    schema_version: "1.0",
    device_id: "ov3660-board-01",
    boot_id: "boot-2026-10-30-01",
    seq: 1,
    t_ms: 1000,
    operation_enabled: true,
    camera_ok: true,
    camera_frame_seq: 40,
    camera_age_ms: 25,
    network_ok: true,
    tof_ok: true,
    tof_age_ms: 20,
    zones: [
      { zone: "left", tof_valid: false, nearest_cm: null },
      { zone: "center", tof_valid: true, nearest_cm: 62.5 },
      { zone: "right", tof_valid: false, nearest_cm: null },
    ],
    ...overrides,
  };
}

async function pairDevice(env, cookie) {
  const claimResponse = await worker.fetch(request("/api/device/pair", {
    method: "POST",
    cookie,
    origin: "https://app.example",
    body: {},
  }), env);
  const claim = await claimResponse.json();
  const response = await worker.fetch(request("/api/device/claim/redeem", {
    method: "POST", body: { claim_code: claim.claim_code, device_id: "ov3660-board-01" },
  }), env);
  return { response, payload: await response.json(), claim };
}

test("pairing requires an authenticated same-origin browser request and stores only a claim hash until USB redemption", async () => {
  const env = envFor();
  const cookie = await sessionCookie();
  const missingOrigin = await worker.fetch(request("/api/device/pair", { method: "POST", cookie, body: {} }), env);
  assert.equal(missingOrigin.status, 403);
  assert.equal(env.DB.claims.size, 0);

  const crossOrigin = await worker.fetch(request("/api/device/pair", {
    method: "POST", cookie, origin: "https://attacker.example", body: {},
  }), env);
  assert.equal(crossOrigin.status, 403);
  assert.equal(env.DB.claims.size, 0);

  const wrongScheme = await worker.fetch(request("/api/device/pair", {
    method: "POST", cookie, origin: "http://app.example", body: {},
  }), env);
  assert.equal(wrongScheme.status, 403);
  assert.equal(env.DB.claims.size, 0);

  const unauthenticated = await worker.fetch(request("/api/device/pair", {
    method: "POST", origin: "https://app.example", body: {},
  }), env);
  assert.equal(unauthenticated.status, 401);

  const { response, payload } = await pairDevice(env, cookie);
  assert.equal(response.status, 200);
  assert.match(payload.device_token, /^rodev_[A-Za-z0-9_-]{43}$/);
  assert.equal(payload.transport, "cloud_uplink");
  const stored = env.DB.pairings.get(TEST_USER.id);
  assert.equal(stored.token_sha256.length, 64);
  assert.notEqual(stored.token_sha256, payload.device_token);
  assert.equal(JSON.stringify(stored).includes(payload.device_token), false);
});

test("authenticated status reports unpaired and awaiting-telemetry states", async () => {
  const env = envFor();
  const cookie = await sessionCookie();
  const unauthorized = await worker.fetch(request("/api/device/status"), env);
  assert.equal(unauthorized.status, 401);

  const unpaired = await worker.fetch(request("/api/device/status", { cookie }), env);
  assert.equal(unpaired.status, 200);
  assert.equal((await unpaired.json()).state, "unpaired");

  await pairDevice(env, cookie);
  const awaiting = await worker.fetch(request("/api/device/status", { cookie }), env);
  const payload = await awaiting.json();
  assert.equal(payload.state, "awaiting_first_telemetry");
  assert.equal(payload.available, true);
  assert.equal(payload.device_connected, false);
});

test("device telemetry is bearer-authenticated, ordered, sanitized, and remains separate from camera inference", async () => {
  const env = envFor();
  const cookie = await sessionCookie();
  const { payload: pairing } = await pairDevice(env, cookie);
  const upload = await worker.fetch(request("/api/device/telemetry", {
    method: "POST", token: pairing.device_token,
    body: { ...tofTelemetry(), detections: [{ label: "person" }], image: "must-not-be-stored" },
  }), env);
  assert.equal(upload.status, 202);
  assert.deepEqual(await upload.json().then(({ accepted, device_id, seq }) => ({ accepted, device_id, seq })), {
    accepted: true,
    device_id: "ov3660-board-01",
    seq: 1,
  });

  const statusResponse = await worker.fetch(request("/api/device/status", { cookie }), env);
  const status = await statusResponse.json();
  assert.equal(status.transport, "cloud_uplink");
  assert.equal(status.device_connected, true);
  assert.equal(status.status.source, "device");
  assert.equal(status.status.camera_input_state, "not_relayed");
  assert.equal(status.status.camera_stream_available, false);
  assert.equal(status.status.tof_boot_id, status.status.boot_id);
  assert.equal(status.status.tof_ok, true);
  assert.equal(status.status.zones[1].nearest_cm, 62.5);
  assert.equal(status.status.zones[0].tof_valid, false);
  assert.equal("detections" in status.status, false);
  assert.equal("image" in status.status, false);
  const storedTelemetry = JSON.parse(env.DB.pairings.get(TEST_USER.id).last_telemetry_json);
  assert.equal("detections" in storedTelemetry, false);
  assert.equal("image" in storedTelemetry, false);

  const replay = await worker.fetch(request("/api/device/telemetry", {
    method: "POST", token: pairing.device_token, body: tofTelemetry(),
  }), env);
  assert.equal(replay.status, 409);

  const badToken = await worker.fetch(request("/api/device/telemetry", {
    method: "POST", token: "rodev_" + "A".repeat(43), body: tofTelemetry({ seq: 2 }),
  }), env);
  assert.equal(badToken.status, 401);

  env.DB.pairings.get(TEST_USER.id).last_seen_at_ms = Date.now();
  const rateLimited = await worker.fetch(request("/api/device/telemetry", {
    method: "POST", token: pairing.device_token, body: tofTelemetry({ seq: 2 }),
  }), env);
  assert.equal(rateLimited.status, 429);
});

test("telemetry schema, content type, and 4 KB limit fail closed", async () => {
  const env = envFor();
  const cookie = await sessionCookie();
  const { payload: pairing } = await pairDevice(env, cookie);

  const wrongOrigin = await worker.fetch(request("/api/device/telemetry", {
    method: "POST", origin: "https://attacker.example", token: pairing.device_token, body: tofTelemetry(),
  }), env);
  assert.equal(wrongOrigin.status, 403);

  const badSchema = await worker.fetch(request("/api/device/telemetry", {
    method: "POST", token: pairing.device_token, body: tofTelemetry({ zones: [{ zone: "center", tof_valid: true, nearest_cm: 1 }] }),
  }), env);
  assert.equal(badSchema.status, 400);

  const contentType = new Headers({ Authorization: `Bearer ${pairing.device_token}`, "Content-Type": "text/plain" });
  const unsupported = await worker.fetch(new Request("https://app.example/api/device/telemetry", {
    method: "POST", headers: contentType, body: "{}",
  }), env);
  assert.equal(unsupported.status, 415);

  const large = await worker.fetch(request("/api/device/telemetry", {
    method: "POST", token: pairing.device_token, body: " ".repeat(4097),
  }), env);
  assert.equal(large.status, 413);
  assert.equal(env.DB.pairings.get(TEST_USER.id).last_seen_at_ms, null);
});

test("stale telemetry becomes unknown and unpair revokes its token", async () => {
  const env = envFor();
  const cookie = await sessionCookie();
  const { payload: pairing } = await pairDevice(env, cookie);
  const upload = await worker.fetch(request("/api/device/telemetry", {
    method: "POST", token: pairing.device_token, body: tofTelemetry(),
  }), env);
  assert.equal(upload.status, 202);

  env.DB.pairings.get(TEST_USER.id).last_seen_at_ms -= 6000;
  const staleResponse = await worker.fetch(request("/api/device/status", { cookie }), env);
  const stale = await staleResponse.json();
  assert.equal(stale.state, "device_stale");
  assert.equal(stale.device_connected, false);
  assert.equal(stale.status.operation_enabled, false);
  assert.equal(stale.status.tof_ok, false);
  assert.equal(stale.status.zones[1].tof_valid, false);
  assert.equal(stale.status.zones[1].nearest_cm, null);

  const noOrigin = await worker.fetch(request("/api/device/unpair", { method: "POST", cookie, body: {} }), env);
  assert.equal(noOrigin.status, 403);
  const unpair = await worker.fetch(request("/api/device/unpair", {
    method: "POST", cookie, origin: "https://app.example", body: {},
  }), env);
  assert.equal(unpair.status, 200);
  assert.equal((await unpair.json()).state, "unpaired");

  const revokedUpload = await worker.fetch(request("/api/device/telemetry", {
    method: "POST", token: pairing.device_token, body: tofTelemetry({ seq: 2 }),
  }), env);
  assert.equal(revokedUpload.status, 401);
});
