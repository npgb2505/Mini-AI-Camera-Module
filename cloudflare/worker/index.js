import ASSISTANT_PROFILE from "../../assistant_profile.json" with { type: "json" };

const APP_NAME = "Rõ";
const APP_BUILD = "20261106-device-cloud-ask-v1";
const SHARED_RUNTIME = ASSISTANT_PROFILE.shared_runtime;
const VISION_MODEL = ASSISTANT_PROFILE.models[SHARED_RUNTIME.canonical_llm_model_key];
const OPENAI_VISION_MODEL = "gpt-6-luna";
const DETECTOR_MODEL = ASSISTANT_PROFILE.models.cloud_detector;
const DETECTOR_TARGET = "people, vehicles, stairs, or objects that could block a pedestrian's walking path";
const ASR_MODEL = ASSISTANT_PROFILE.models.transcription_fallback;
const OPENAI_TRANSCRIPTION_MODEL = ASSISTANT_PROFILE.models.transcription_file;
const LIVE_TRANSCRIPTION_MODEL = ASSISTANT_PROFILE.models[SHARED_RUNTIME.realtime_transcription_model_key];
const TRANSCRIPTION_PROMPT = ASSISTANT_PROFILE.prompts.transcription;
const TRANSCRIPTION_KEYWORDS = ASSISTANT_PROFILE.transcription.keywords;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENTATION_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_SEGMENTATION_HEALTH_BYTES = 16 * 1024;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;
const DEFAULT_VIENEU_TTS_VOICE = "Hải Đăng";
// Cloudflare Workers Web Crypto limits PBKDF2 iteration counts to 100,000.
const PASSWORD_ITERATIONS = 100000;
const MAX_DETECTIONS = 20;
const MAX_DEVICE_TELEMETRY_BYTES = 4096;
const MAX_DEVICE_EVENT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DEVICE_EVENT_RESULT_BYTES = 32 * 1024;
const DEVICE_EVENT_RESULT_TTL_MS = 30_000;
const DEVICE_BUTTON_EVENT_TTL_MS = 10_000;
const DEVICE_CONNECTION_TTL_MS = 5000;
const DEVICE_TOF_TTL_MS = 350;
const DEVICE_MIN_UPLINK_INTERVAL_MS = 250;

const LABELS_VI = {
  person: "người",
  obstacle: "vật cản",
  bicycle: "xe đạp",
  car: "ô tô",
  motorcycle: "xe máy",
  airplane: "máy bay",
  bus: "xe buýt",
  train: "tàu hỏa",
  truck: "xe tải",
  boat: "thuyền",
  traffic_light: "đèn giao thông",
  fire_hydrant: "trụ cứu hỏa",
  stop_sign: "biển dừng",
  bench: "ghế băng",
  bird: "chim",
  cat: "mèo",
  dog: "chó",
  chair: "ghế",
  couch: "ghế sofa",
  potted_plant: "chậu cây",
  dining_table: "bàn",
  toilet: "bồn cầu",
  tv: "màn hình",
  backpack: "ba lô",
  umbrella: "ô",
  handbag: "túi xách",
  suitcase: "va li",
  skateboard: "ván trượt",
  stroller: "xe đẩy",
};

const NAVIGATION_VEHICLE_CLASSES = new Set(["bicycle", "car", "motorcycle", "bus", "truck"]);
const NAVIGATION_TRAFFIC_CLASSES = new Set(["traffic_light", "stop_sign"]);
const NAVIGATION_STATIC_CANDIDATES = new Set([
  "bench", "chair", "couch", "potted_plant", "dining_table", "backpack",
  "umbrella", "handbag", "suitcase", "skateboard", "stroller", "parking_meter",
  "fire_hydrant", "obstacle",
]);

function navigationClassRole(label) {
  if (label === "person") return { navigation_role: "person", navigation_role_vi: "Người" };
  if (NAVIGATION_VEHICLE_CLASSES.has(label)) return { navigation_role: "vehicle", navigation_role_vi: "Phương tiện" };
  if (NAVIGATION_TRAFFIC_CLASSES.has(label)) return { navigation_role: "traffic_control", navigation_role_vi: "Tín hiệu giao thông" };
  if (NAVIGATION_STATIC_CANDIDATES.has(label)) {
    return { navigation_role: "static_object_candidate", navigation_role_vi: "Vật thể ứng viên cần kiểm tra vùng" };
  }
  return { navigation_role: "unmapped", navigation_role_vi: "Chưa gán vai trò điều hướng" };
}

const PROFILE_PROMPTS = ASSISTANT_PROFILE.prompts;
const VISION_INSTRUCTIONS = [PROFILE_PROMPTS.core, PROFILE_PROMPTS.vision].join(" ");
const VOICE_INSTRUCTIONS = [PROFILE_PROMPTS.core, PROFILE_PROMPTS.voice].join(" ");

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers });
}

function badRequest(message, status = 400) {
  return json({ error: message }, status);
}

function base64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64Url(bytes) {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hexToBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) difference |= (a[i % Math.max(a.length, 1)] || 0) ^ (b[i % Math.max(b.length, 1)] || 0);
  return difference === 0;
}

async function passwordDigest(password, saltHex) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PASSWORD_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function makeSessionCookie(user, env, secure) {
  const payload = {
    sub: user.id,
    ver: user.session_version,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = base64Url(await hmac(env.SESSION_SECRET, encodedPayload));
  const value = encodedPayload + "." + signature;
  const cookie = "ro_session=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_TTL_SECONDS + (secure ? "; Secure" : "");
  return cookie;
}

async function currentUser(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)ro_session=([^;]+)/);
  if (!match || !env.SESSION_SECRET || !env.DB) return null;
  const parts = match[1].split(".");
  if (parts.length !== 2) return null;
  let payload;
  let suppliedSignature;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    suppliedSignature = fromBase64Url(parts[1]);
  } catch {
    return null;
  }
  if (!payload || typeof payload.sub !== "string" || !Number.isInteger(payload.exp) || payload.exp <= Date.now() / 1000) return null;
  const expectedSignature = await hmac(env.SESSION_SECRET, parts[0]);
  if (!constantTimeEqual(base64Url(expectedSignature), base64Url(suppliedSignature))) return null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.sub).first();
  if (!user || user.session_version !== payload.ver) return null;
  return user;
}

function userPayload(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
  };
}

function profilePayload(user) {
  return {
    display_name: user.display_name,
    text_scale: user.text_scale,
    high_contrast: Boolean(user.high_contrast),
    speak_answers: Boolean(user.speak_answers),
    voice_rate: user.voice_rate,
  };
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  return user || null;
}

function requestIsSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function finiteRange(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? Number(value.toFixed(2))
    : null;
}

function sanitizePhoneSpatialContext(input) {
  let value = input;
  if (typeof value === "string") {
    if (value.length === 0 || value.length > 4_096) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const context = {};
  const cameraAge = finiteRange(value.camera_frame_age_ms, 0, 5_000);
  if (cameraAge !== null) context.camera_frame_age_ms = cameraAge;
  const centerAge = finiteRange(value.center_depth_age_ms, 0, 1_000);
  const centerDistance = finiteRange(value.center_distance_m, 0.15, 10);
  if (centerAge !== null && centerDistance !== null) {
    context.center_depth_age_ms = centerAge;
    context.center_distance_m = centerDistance;
  }

  const detectionAge = finiteRange(value.detection_frame_age_ms, 0, 2_500);
  if (detectionAge !== null && Array.isArray(value.detections)) {
    context.detection_frame_age_ms = detectionAge;
    context.detections = value.detections.slice(0, 8).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const label = String(item.label || "vật thể").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 48);
      if (!label) return [];
      const path = ["very_near", "near", "far", "outside_corridor", "unknown_distance"].includes(item.path)
        ? item.path
        : "unknown_distance";
      const detection = { label, path };
      const confidence = finiteRange(item.confidence, 0, 1);
      const distance = finiteRange(item.distance_m, 0.15, 10);
      if (confidence !== null) detection.confidence = confidence;
      if (distance !== null) detection.distance_m = distance;
      return [detection];
    });
  }

  if (Array.isArray(value.zones)) {
    context.zones = value.zones.slice(0, 3).flatMap((item) => {
      if (!item || typeof item !== "object" || !["left", "center", "right"].includes(item.zone)) return [];
      const zone = { zone: item.zone };
      const probability = finiteRange(item.hazard_probability, 0, 1);
      const depth = finiteRange(item.depth_m, 0.15, 10);
      if (probability !== null) zone.hazard_probability = probability;
      if (typeof item.is_hazard === "boolean") zone.is_hazard = item.is_hazard;
      if (depth !== null) zone.depth_m = depth;
      return [zone];
    });
  }

  return Object.keys(context).length ? context : null;
}

function describePhoneSpatialContext(context) {
  if (!context) return "";
  const lines = [];
  if (typeof context.center_distance_m === "number") {
    lines.push(`- LiDAR vùng tâm ảnh: khoảng ${context.center_distance_m.toFixed(1)} m; đây là bề mặt tại tâm, không xác định vật cụ thể.`);
  }
  for (const item of context.detections || []) {
    const confidence = typeof item.confidence === "number" ? `, độ tin cậy ${Math.round(item.confidence * 100)}%` : "";
    const distance = typeof item.distance_m === "number" ? `, LiDAR trong vùng vật thể khoảng ${item.distance_m.toFixed(1)} m` : ", chưa có khoảng cách LiDAR trong vùng vật thể";
    const pathLabels = {
      very_near: "ứng viên rất gần",
      near: "ứng viên trong tầm gần",
      far: "ở xa",
      outside_corridor: "ngoài hành lang giữa",
      unknown_distance: "chưa rõ vị trí/cự ly",
    };
    lines.push(`- Detector: ${item.label}${confidence}${distance}; ${pathLabels[item.path] || pathLabels.unknown_distance}.`);
  }
  for (const item of context.zones || []) {
    const probability = typeof item.hazard_probability === "number" ? `, xác suất nguy cơ mô hình ${Math.round(item.hazard_probability * 100)}%` : "";
    const depth = typeof item.depth_m === "number" ? `, LiDAR vùng này khoảng ${item.depth_m.toFixed(1)} m` : "";
    const zoneName = { left: "trái", center: "giữa", right: "phải" }[item.zone];
    lines.push(`- Phân tích vùng ${zoneName}${probability}${depth}; đây là gợi ý, không phải xác nhận đường đi.`);
  }
  if (!lines.length) return "";
  const age = typeof context.camera_frame_age_ms === "number" ? ` Ảnh cảm biến cách hiện tại khoảng ${Math.round(context.camera_frame_age_ms)} ms.` : "";
  return "GHI CHÚ CAMERA VÀ LiDAR (ước tính, không bảo đảm an toàn):\n" + lines.join("\n") + age;
}

async function authRateAllowed(request, env, action) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = 900;
  const bucket = action + ":" + ip;
  const row = await env.DB.prepare(
    "INSERT INTO auth_rate_limits(bucket, count, reset_at) VALUES(?, 1, ?) " +
    "ON CONFLICT(bucket) DO UPDATE SET " +
    "count = CASE WHEN auth_rate_limits.reset_at <= ? THEN 1 ELSE auth_rate_limits.count + 1 END, " +
    "reset_at = CASE WHEN auth_rate_limits.reset_at <= ? THEN ? ELSE auth_rate_limits.reset_at END " +
    "RETURNING count, reset_at",
  ).bind(bucket, now + windowSeconds, now, now, now + windowSeconds).first();
  return row && row.count <= 10;
}

function sameOriginRequired(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function sha256Hex(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )));
}

async function readJsonLimited(request, maximumBytes) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) return { tooLarge: true, value: null };
  if (!request.body) return { tooLarge: false, value: null };
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true, value: null };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { tooLarge: false, value };
  } catch {
    return { tooLarge: false, value: null };
  }
}

async function readRequestBytesLimited(request, maximumBytes) {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) return { tooLarge: true, bytes: null };
  if (!request.body) return { tooLarge: false, bytes: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true, bytes: null };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { tooLarge: false, bytes };
}

function unsigned32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function deviceIdentifier(value, maximumLength = 96) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function sanitizeDeviceTelemetry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const deviceId = deviceIdentifier(input.device_id);
  const bootId = deviceIdentifier(input.boot_id);
  if (input.schema_version !== "1.0" || !deviceId || !bootId
      || !unsigned32(input.seq) || !unsigned32(input.t_ms)
      || typeof input.operation_enabled !== "boolean"
      || typeof input.tof_ok !== "boolean"
      || !(input.tof_age_ms === null || (typeof input.tof_age_ms === "number"
        && Number.isFinite(input.tof_age_ms) && input.tof_age_ms >= 0 && input.tof_age_ms <= 60_000))
      || !Array.isArray(input.zones) || input.zones.length !== 3) return null;

  const zones = new Map();
  for (const item of input.zones) {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || !["left", "center", "right"].includes(item.zone)
        || typeof item.tof_valid !== "boolean"
        || zones.has(item.zone)) return null;
    if (item.tof_valid && !(typeof item.nearest_cm === "number"
        && Number.isFinite(item.nearest_cm) && item.nearest_cm > 0 && item.nearest_cm <= 100_000)) return null;
    if (!item.tof_valid && item.nearest_cm !== null) return null;
    zones.set(item.zone, {
      zone: item.zone,
      tof_valid: item.tof_valid,
      nearest_cm: item.tof_valid ? Number(item.nearest_cm.toFixed(2)) : null,
    });
  }
  if (!["left", "center", "right"].every((zone) => zones.has(zone))) return null;

  const telemetry = {
    schema_version: "1.0",
    device_id: deviceId,
    boot_id: bootId,
    seq: input.seq,
    t_ms: input.t_ms,
    operation_enabled: input.operation_enabled,
    tof_ok: input.tof_ok,
    tof_age_ms: input.tof_age_ms === null ? null : Number(input.tof_age_ms.toFixed(2)),
    zones: ["left", "center", "right"].map((zone) => zones.get(zone)),
  };

  if (typeof input.camera_ok === "boolean") telemetry.camera_ok = input.camera_ok;
  if (unsigned32(input.camera_frame_seq)) telemetry.camera_frame_seq = input.camera_frame_seq;
  if (input.camera_age_ms === null || (typeof input.camera_age_ms === "number"
      && Number.isFinite(input.camera_age_ms) && input.camera_age_ms >= 0 && input.camera_age_ms <= 60_000)) {
    telemetry.camera_age_ms = input.camera_age_ms === null ? null : Number(input.camera_age_ms.toFixed(2));
  }
  if (typeof input.network_ok === "boolean") telemetry.network_ok = input.network_ok;
  if (unsigned32(input.operation_epoch)) telemetry.operation_epoch = input.operation_epoch;
  return telemetry;
}

async function handleDevicePair(request, env, user) {
  if (!sameOriginRequired(request)) return badRequest("Ghép thiết bị cần yêu cầu cùng nguồn từ ứng dụng.", 403);
  const claimCode = `roclaim_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const claimHash = await sha256Hex(claimCode);
  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + 10 * 60 * 1000;
  await env.DB.prepare(
    "INSERT INTO device_pair_claims(user_id, token_sha256, issued_at_ms, expires_at_ms, consumed_at_ms) VALUES(?,?,?,?,NULL) " +
      "ON CONFLICT(user_id) DO UPDATE SET token_sha256=excluded.token_sha256, issued_at_ms=excluded.issued_at_ms, " +
      "expires_at_ms=excluded.expires_at_ms, consumed_at_ms=NULL",
  ).bind(user.id, claimHash, issuedAtMs, expiresAtMs).run();
  return json({
    claim_code: claimCode,
    expires_at_ms: expiresAtMs,
    claim_notice: "Mã chỉ hiển thị một lần. Gửi theo lệnh PAIR <mã> trên USB trong vòng 10 phút.",
  }, 201, { "Cache-Control": "no-store" });
}

async function redeemDeviceClaim(request, env) {
  if (request.headers.has("Origin")) return badRequest("Mã ghép chỉ nhận trực tiếp từ ESP32.", 403);
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("Content-Type") || "")) return badRequest("Yêu cầu ghép phải ở dạng JSON.", 415);
  const read = await readJsonLimited(request, 2048);
  if (read.tooLarge) return badRequest("Yêu cầu ghép quá lớn.", 413);
  const body = read.value;
  if (!body || Object.keys(body).some((key) => !["claim_code", "device_id"].includes(key))) return badRequest("Dữ liệu ghép chưa hợp lệ.");
  const claimCode = typeof body.claim_code === "string" && /^roclaim_[A-Za-z0-9_-]{43}$/.test(body.claim_code) ? body.claim_code : null;
  const deviceId = deviceIdentifier(body.device_id);
  if (!claimCode || !deviceId) return badRequest("Mã ghép hoặc device_id chưa hợp lệ.");
  const claimHash = await sha256Hex(claimCode);
  const token = `rodev_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const tokenHash = await sha256Hex(token);
  const pairedAtMs = Date.now();
  const batch = await env.DB.batch([
    env.DB.prepare("UPDATE device_pair_claims SET consumed_at_ms=? WHERE token_sha256=? AND expires_at_ms>? AND consumed_at_ms IS NULL RETURNING user_id")
      .bind(pairedAtMs, claimHash, pairedAtMs),
    env.DB.prepare(
      "INSERT INTO device_pairings(user_id, token_sha256, paired_at_ms, last_device_id) " +
      "SELECT user_id, ?, ?, ? FROM device_pair_claims WHERE token_sha256=? AND consumed_at_ms=? AND expires_at_ms>? " +
      "ON CONFLICT(user_id) DO UPDATE SET token_sha256=excluded.token_sha256, paired_at_ms=excluded.paired_at_ms, " +
      "last_seen_at_ms=NULL, last_device_id=excluded.last_device_id, last_boot_id=NULL, last_seq=NULL, last_telemetry_json=NULL, " +
      "last_event_id=NULL, last_event_at_ms=NULL, last_event_boot_id=NULL, last_event_seq=NULL, last_event_json=NULL, " +
      "last_button_event_id=NULL, last_button_event_at_ms=NULL, last_button_event_boot_id=NULL, " +
      "last_button_event_press_id=NULL, last_button_event_json=NULL, last_button_event_claimed_at_ms=NULL",
    ).bind(tokenHash, pairedAtMs, deviceId, claimHash, pairedAtMs, pairedAtMs),
    env.DB.prepare("DELETE FROM device_pair_claims WHERE token_sha256=? AND consumed_at_ms=?").bind(claimHash, pairedAtMs),
  ]);
  if (batch?.[1]?.meta?.changes !== 1) return badRequest("Mã ghép đã hết hạn hoặc đã được dùng.", 401);
  return json({ paired: true, device_token: token, transport: "cloud_uplink", paired_at_ms: pairedAtMs }, 200, { "Cache-Control": "no-store" });
}

async function handleDeviceUnpair(request, env, user) {
  if (!sameOriginRequired(request)) return badRequest("Hủy ghép đôi cần yêu cầu cùng nguồn từ ứng dụng.", 403);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM device_pairings WHERE user_id=?").bind(user.id),
    env.DB.prepare("DELETE FROM device_pair_claims WHERE user_id=?").bind(user.id),
  ]);
  return json({ paired: false, device_connected: false, state: "unpaired" });
}

async function handleDeviceTelemetry(request, env) {
  if (!env.DB) return badRequest("Lưu trữ trạng thái thiết bị chưa sẵn sàng.", 503);
  if (request.headers.has("Origin") && !sameOriginRequired(request)) {
    return badRequest("Nguồn gửi telemetry chưa được xác nhận.", 403);
  }
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer (rodev_[A-Za-z0-9_-]{43})$/);
  if (!match) return badRequest("Thông tin ghép thiết bị chưa hợp lệ.", 401);
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("Content-Type") || "")) {
    return badRequest("Dữ liệu telemetry phải ở dạng JSON.", 415);
  }

  const body = await readJsonLimited(request, MAX_DEVICE_TELEMETRY_BYTES);
  if (body.tooLarge) return badRequest("Gói telemetry vượt quá giới hạn 4 KB.", 413);
  const telemetry = sanitizeDeviceTelemetry(body.value);
  if (!telemetry) return badRequest("Telemetry chưa đúng schema thiết bị 1.0.");

  const tokenHash = await sha256Hex(match[1]);
  const pairing = await env.DB.prepare(
    "SELECT user_id, token_sha256, last_device_id, last_boot_id, last_seq " +
      "FROM device_pairings WHERE token_sha256=?",
  ).bind(tokenHash).first();
  if (!pairing) return badRequest("Thông tin ghép thiết bị chưa hợp lệ.", 401);
  if (pairing.last_device_id && pairing.last_device_id !== telemetry.device_id) {
    return badRequest("Token này đã được ghép với thiết bị khác.", 403);
  }
  if (pairing.last_boot_id === telemetry.boot_id && Number.isInteger(pairing.last_seq)
      && telemetry.seq <= pairing.last_seq) {
    return badRequest("Bỏ telemetry trùng hoặc đến sai thứ tự.", 409);
  }

  const receivedAt = Date.now();
  if (Number.isInteger(pairing.last_seen_at_ms)
      && receivedAt - pairing.last_seen_at_ms < DEVICE_MIN_UPLINK_INTERVAL_MS) {
    return json({ error: "Gửi telemetry tối đa 4 lần mỗi giây." }, 429, { "Retry-After": "1" });
  }
  const update = await env.DB.prepare(
    "UPDATE device_pairings SET last_seen_at_ms=?, last_device_id=COALESCE(last_device_id,?), " +
      "last_boot_id=?, last_seq=?, last_telemetry_json=? WHERE user_id=? AND token_sha256=? " +
      "AND (last_device_id IS NULL OR last_device_id=?) " +
      "AND (last_boot_id IS NULL OR last_boot_id!=? OR last_seq IS NULL OR last_seq<?) " +
      "AND (last_seen_at_ms IS NULL OR last_seen_at_ms<=?)",
  ).bind(receivedAt, telemetry.device_id, telemetry.boot_id, telemetry.seq,
    JSON.stringify(telemetry), pairing.user_id, tokenHash, telemetry.device_id,
    telemetry.boot_id, telemetry.seq, receivedAt - DEVICE_MIN_UPLINK_INTERVAL_MS).run();
  if (update?.meta?.changes !== 1) return badRequest("Telemetry đã được nhận hoặc token vừa bị thay.", 409);
  return json({ accepted: true, device_id: telemetry.device_id, seq: telemetry.seq, received_at_ms: receivedAt }, 202);
}

async function handleDeviceButtonEvent(request, env) {
  if (!env.DB) return badRequest("Lưu trữ trạng thái thiết bị chưa sẵn sàng.", 503);
  if (request.headers.has("Origin") && !sameOriginRequired(request)) {
    return badRequest("Nguồn gửi sự kiện nút chưa được xác nhận.", 403);
  }
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer (rodev_[A-Za-z0-9_-]{43})$/);
  if (!match) return badRequest("Thông tin ghép thiết bị chưa hợp lệ.", 401);
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("Content-Type") || "")) {
    return badRequest("Sự kiện nút phải ở dạng JSON.", 415);
  }
  const read = await readJsonLimited(request, 2048);
  if (read.tooLarge) return badRequest("Sự kiện nút vượt quá giới hạn.", 413);
  const body = read.value;
  const expected = new Set(["event_id", "device_id", "boot_id", "press_id", "button_id", "action", "operation_enabled"]);
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== expected.size || Object.keys(body).some((key) => !expected.has(key))) {
    return badRequest("Sự kiện nút chưa đúng schema.");
  }
  const deviceId = deviceIdentifier(body.device_id);
  const bootId = deviceIdentifier(body.boot_id);
  if (typeof body.event_id !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(body.event_id)
      || !deviceId || !bootId || !Number.isInteger(body.press_id) || body.press_id < 1 || body.press_id > 0xffffffff
      || body.button_id !== "ask_llm" || body.action !== "pressed" || body.operation_enabled !== true) {
    return badRequest("Sự kiện Ask chưa hợp lệ.");
  }

  const tokenHash = await sha256Hex(match[1]);
  const pairing = await env.DB.prepare(
    "SELECT user_id, token_sha256, last_seen_at_ms, last_device_id, last_boot_id, last_telemetry_json, " +
      "last_button_event_id, last_button_event_boot_id, last_button_event_press_id " +
      "FROM device_pairings WHERE token_sha256=?",
  ).bind(tokenHash).first();
  if (!pairing) return badRequest("Thông tin ghép thiết bị chưa hợp lệ.", 401);
  const now = Date.now();
  if (!Number.isInteger(pairing.last_seen_at_ms) || now - pairing.last_seen_at_ms > DEVICE_CONNECTION_TTL_MS
      || pairing.last_device_id !== deviceId || pairing.last_boot_id !== bootId) {
    return badRequest("Thiết bị chưa kết nối hoặc boot/device không khớp.", 409);
  }
  let telemetry;
  try { telemetry = JSON.parse(pairing.last_telemetry_json || "{}"); } catch { telemetry = null; }
  if (!telemetry || telemetry.operation_enabled !== true) return badRequest("Thiết bị chưa ở chế độ hoạt động.", 409);
  if (pairing.last_button_event_boot_id === bootId
      && Number.isInteger(pairing.last_button_event_press_id)
      && body.press_id <= pairing.last_button_event_press_id) {
    return badRequest("Sự kiện nút đã nhận hoặc đến sai thứ tự.", 409);
  }

  const event = {
    type: "button_event",
    event_id: body.event_id,
    button_id: "ask_llm",
    action: "pressed",
    device_id: deviceId,
    boot_id: bootId,
    press_id: body.press_id,
    operation_enabled: true,
  };
  const stored = await env.DB.prepare(
    "UPDATE device_pairings SET last_button_event_id=?, last_button_event_at_ms=?, " +
      "last_button_event_boot_id=?, last_button_event_press_id=?, last_button_event_json=?, " +
      "last_button_event_claimed_at_ms=NULL WHERE user_id=? AND token_sha256=? " +
      "AND last_device_id=? AND last_boot_id=? AND last_seen_at_ms>? " +
      "AND json_extract(last_telemetry_json,'$.operation_enabled')=1 " +
      "AND (last_button_event_boot_id IS NULL OR last_button_event_boot_id!=? " +
      "OR last_button_event_press_id IS NULL OR last_button_event_press_id<?) " +
      "AND (last_button_event_id IS NULL OR last_button_event_id!=?)",
  ).bind(body.event_id, now, bootId, body.press_id, JSON.stringify(event), pairing.user_id, tokenHash,
    deviceId, bootId, now - DEVICE_CONNECTION_TTL_MS, bootId, body.press_id, body.event_id).run();
  if (stored?.meta?.changes !== 1) return badRequest("Sự kiện nút đã nhận hoặc trạng thái thiết bị vừa đổi.", 409);
  return json({ accepted: true, event_id: body.event_id }, 202, { "Cache-Control": "no-store" });
}

async function handleDeviceButtonClaim(request, env, user) {
  if (!sameOriginRequired(request)) return badRequest("Nhận sự kiện nút cần yêu cầu cùng nguồn từ ứng dụng.", 403);
  const body = await readJsonLimited(request, 1024);
  if (body.tooLarge || !body.value || typeof body.value !== "object" || Array.isArray(body.value)
      || Object.keys(body.value).length !== 1 || typeof body.value.event_id !== "string"
      || !/^[A-Za-z0-9_-]{1,96}$/.test(body.value.event_id)) {
    return badRequest("Yêu cầu nhận sự kiện nút chưa hợp lệ.");
  }
  const row = await env.DB.prepare(
    "SELECT last_button_event_id, last_button_event_at_ms, last_button_event_json, last_seen_at_ms, " +
      "last_boot_id, last_telemetry_json FROM device_pairings WHERE user_id=?",
  ).bind(user.id).first();
  if (!row || row.last_button_event_id !== body.value.event_id
      || !Number.isInteger(row.last_button_event_at_ms)) return json({ claimed: false });
  const now = Date.now();
  const age = Math.max(0, now - row.last_button_event_at_ms);
  if (age > DEVICE_BUTTON_EVENT_TTL_MS || !Number.isInteger(row.last_seen_at_ms)
      || now - row.last_seen_at_ms > DEVICE_CONNECTION_TTL_MS) return json({ claimed: false, event_age_ms: age });
  let event;
  let telemetry;
  try {
    event = JSON.parse(row.last_button_event_json || "null");
    telemetry = JSON.parse(row.last_telemetry_json || "null");
  } catch { return json({ claimed: false }); }
  if (!event || event.event_id !== body.value.event_id || event.button_id !== "ask_llm"
      || event.operation_enabled !== true || event.boot_id !== row.last_boot_id
      || !telemetry || telemetry.operation_enabled !== true) return json({ claimed: false });
  const update = await env.DB.prepare(
    "UPDATE device_pairings SET last_button_event_claimed_at_ms=? WHERE user_id=? " +
      "AND last_button_event_id=? AND last_button_event_claimed_at_ms IS NULL " +
      "AND last_button_event_at_ms>? AND last_button_event_at_ms<=? AND last_seen_at_ms>? " +
      "AND last_boot_id=? AND json_extract(last_telemetry_json,'$.operation_enabled')=1",
  ).bind(now, user.id, body.value.event_id, now - DEVICE_BUTTON_EVENT_TTL_MS, now,
    now - DEVICE_CONNECTION_TTL_MS, event.boot_id).run();
  if (update?.meta?.changes !== 1) return json({ claimed: false, event_age_ms: age });
  return json({ claimed: true, event, event_age_ms: age }, 200, { "Cache-Control": "no-store" });
}

function multipartInteger(form, name, { minimum = 0, maximum = 0xffffffff } = {}) {
  const raw = form.get(name);
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]{0,9})$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function multipartNullableNumber(form, name, { minimum = 0, maximum = 60_000 } = {}) {
  const raw = form.get(name);
  if (raw === "null") return null;
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

function compactDeviceSegmentationResult(result, event) {
  const required = ["model_id", "calibration_status", "navigation_decision_enabled", "image_width", "image_height", "inference_ms", "classes_present", "guidance", "stream_id", "frame_id"];
  if (!result || typeof result !== "object" || Array.isArray(result) || required.some((key) => !(key in result))
      || typeof result.model_id !== "string" || result.model_id.length > 256
      || result.calibration_status !== "experimental" || result.navigation_decision_enabled !== true
      || !Number.isInteger(result.image_width) || result.image_width < 1 || result.image_width > 4096
      || !Number.isInteger(result.image_height) || result.image_height < 1 || result.image_height > 4096
      || !Number.isFinite(result.inference_ms) || result.inference_ms < 0 || result.inference_ms > 120_000
      || !Array.isArray(result.classes_present) || result.classes_present.length > 32
      || result.stream_id !== event.event_id || result.frame_id !== event.frame_seq
      || !result.guidance || typeof result.guidance !== "object" || Array.isArray(result.guidance)) throw new Error("invalid_segmentation_result");
  const classes = result.classes_present.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || !Number.isInteger(item.class_id) || item.class_id < 0 || item.class_id > 255
        || typeof item.class_name !== "string" || item.class_name.length > 80
        || !Number.isInteger(item.pixels) || item.pixels < 0
        || !Number.isFinite(item.area_ratio) || item.area_ratio < 0 || item.area_ratio > 1
        || !Number.isFinite(item.mean_confidence) || item.mean_confidence < 0 || item.mean_confidence > 1) throw new Error("invalid_segmentation_class");
    return { class_id: item.class_id, class_name: item.class_name, pixels: item.pixels, area_ratio: item.area_ratio, mean_confidence: item.mean_confidence };
  });
  return {
    action: "capture_image",
    event_id: event.event_id,
    device_id: event.device_id,
    boot_id: event.boot_id,
    seq: event.seq,
    frame_seq: event.frame_seq,
    tof_age_ms: event.tof_age_ms,
    tof_center_cm: event.tof_center_cm,
    created_at_ms: event.created_at_ms,
    model_id: result.model_id,
    image_width: result.image_width,
    image_height: result.image_height,
    inference_ms: result.inference_ms,
    classes_present: classes,
    guidance: safeSegmentationGuidance(result.guidance),
  };
}

async function handleDeviceEvent(request, env) {
  if (request.headers.has("Origin") && !sameOriginRequired(request)) return badRequest("Nguồn gửi sự kiện ESP32 chưa được xác nhận.", 403);
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer (rodev_[A-Za-z0-9_-]{43})$/);
  if (!match) return badRequest("Thông tin ghép thiết bị chưa hợp lệ.", 401);
  if (!/^multipart\/form-data\s*;/i.test(request.headers.get("Content-Type") || "")) return badRequest("Sự kiện camera phải là multipart/form-data.", 415);
  const bodyRead = await readRequestBytesLimited(request, MAX_DEVICE_EVENT_IMAGE_BYTES + 128 * 1024);
  if (bodyRead.tooLarge) return badRequest("Khung camera vượt quá giới hạn 8 MB.", 413);
  let form;
  try {
    const boundedRequest = new Request(request.url, { method: "POST", headers: request.headers, body: bodyRead.bytes });
    form = await boundedRequest.formData();
  } catch { return badRequest("Sự kiện camera chưa hợp lệ."); }
  const expected = new Set(["event_id", "device_id", "boot_id", "seq", "frame_seq", "tof_age_ms", "tof_center_cm", "image"]);
  const keys = Array.from(form.keys());
  if (keys.length !== expected.size || new Set(keys).size !== keys.length || keys.some((key) => !expected.has(key))) return badRequest("Sự kiện phải có đúng các trường được hỗ trợ.");
  const eventId = form.get("event_id");
  const deviceId = deviceIdentifier(form.get("device_id"));
  const bootId = deviceIdentifier(form.get("boot_id"));
  const seq = multipartInteger(form, "seq");
  const frameSeq = multipartInteger(form, "frame_seq", { minimum: 1 });
  const tofAgeMs = multipartNullableNumber(form, "tof_age_ms");
  const tofCenterCm = multipartNullableNumber(form, "tof_center_cm", { minimum: 0.01, maximum: 100_000 });
  const image = form.get("image");
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(eventId)
      || !deviceId || !bootId || seq === null || frameSeq === null
      || tofAgeMs === undefined || tofCenterCm === undefined
      || !(image instanceof File) || image.size === 0) return badRequest("Thông tin sự kiện camera chưa hợp lệ.");
  if (image.size > MAX_DEVICE_EVENT_IMAGE_BYTES) return badRequest("Khung camera vượt quá giới hạn 8 MB.", 413);
  if (image.type && image.type !== "image/jpeg") return badRequest("Sự kiện chỉ nhận ảnh JPEG.", 415);
  const imageBytes = new Uint8Array(await image.arrayBuffer());
  if (imageBytes.length < 4 || imageBytes[0] !== 0xff || imageBytes[1] !== 0xd8 || imageBytes[2] !== 0xff
      || imageBytes.at(-2) !== 0xff || imageBytes.at(-1) !== 0xd9) return badRequest("Nội dung khung hình không phải JPEG hợp lệ.", 415);
  const tokenHash = await sha256Hex(match[1]);
  const pairing = await env.DB.prepare(
    "SELECT user_id, token_sha256, last_seen_at_ms, last_device_id, last_boot_id, last_telemetry_json, " +
    "last_event_id, last_event_boot_id, last_event_seq FROM device_pairings WHERE token_sha256=?",
  ).bind(tokenHash).first();
  if (!pairing) return badRequest("Thông tin ghép thiết bị chưa hợp lệ.", 401);
  const now = Date.now();
  if (pairing.last_seen_at_ms === null || now - pairing.last_seen_at_ms > DEVICE_CONNECTION_TTL_MS
      || pairing.last_device_id !== deviceId || pairing.last_boot_id !== bootId) return badRequest("Telemetry thiết bị cũ hoặc boot/device không khớp.", 409);
  if ((pairing.last_event_boot_id === bootId && Number.isInteger(pairing.last_event_seq) && seq <= pairing.last_event_seq)
      || pairing.last_event_id === eventId) return badRequest("Sự kiện đã nhận hoặc đến sai thứ tự.", 409);
  let telemetry;
  try { telemetry = JSON.parse(pairing.last_telemetry_json || "{}"); } catch { telemetry = null; }
  if (!telemetry || telemetry.operation_enabled !== true) return badRequest("Thiết bị chưa ở chế độ hoạt động.", 409);
  if (Number.isInteger(telemetry.camera_frame_seq) && frameSeq < telemetry.camera_frame_seq) return badRequest("Khung camera đã cũ.", 409);
  const event = { event_id: eventId, device_id: deviceId, boot_id: bootId, seq, frame_seq: frameSeq, tof_age_ms: tofAgeMs, tof_center_cm: tofCenterCm, created_at_ms: now };
  let compact;
  try {
    const result = await segmentationHostRequest(env, "/api/segment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: base64(imageBytes), stream_id: eventId, frame_id: frameSeq }),
    }, MAX_SEGMENTATION_RESPONSE_BYTES);
    compact = compactDeviceSegmentationResult(result, event);
  } catch {
    return badRequest("Không chạy được phân đoạn cho sự kiện camera.", 503);
  }
  const compactJson = JSON.stringify(compact);
  if (new TextEncoder().encode(compactJson).byteLength > MAX_DEVICE_EVENT_RESULT_BYTES) return badRequest("Kết quả phân đoạn vượt quá giới hạn lưu metadata.", 502);
  const stored = await env.DB.prepare(
    "UPDATE device_pairings SET last_device_id=COALESCE(last_device_id,?), last_event_id=?, last_event_at_ms=?, " +
    "last_event_boot_id=?, last_event_seq=?, last_event_json=? WHERE user_id=? AND token_sha256=? " +
    "AND last_device_id=? AND last_boot_id=? AND last_seen_at_ms>? " +
    "AND (last_event_boot_id IS NULL OR last_event_boot_id!=? OR last_event_seq IS NULL OR last_event_seq<?) " +
    "AND (last_event_id IS NULL OR last_event_id!=?)",
  ).bind(deviceId, eventId, now, bootId, seq, compactJson, pairing.user_id, tokenHash,
    deviceId, bootId, now - DEVICE_CONNECTION_TTL_MS, bootId, seq, eventId).run();
  if (stored?.meta?.changes !== 1) return badRequest("Sự kiện đã nhận hoặc trạng thái thiết bị vừa đổi.", 409);
  return json({ accepted: true, event: compact, images_saved: false }, 202, { "Cache-Control": "no-store" });
}

function unavailableCloudDeviceStatus(state = "unpaired", available = false) {
  return {
    available,
    device_connected: false,
    state,
    transport: "cloud_uplink",
    latest_event: null,
    latest_event_age_ms: null,
    latest_event_fresh: false,
    status: {
      source: "device",
      camera_input_state: "not_relayed",
      camera_stream_available: false,
      tof_mode: "device",
      tof_ok: false,
      tof_age_ms: null,
      tof_boot_id: null,
      operation_enabled: false,
      button_event: null,
      button_event_age_ms: null,
      zones: ["left", "center", "right"].map((zone) => ({
        zone,
        tof_valid: false,
        nearest_cm: null,
      })),
    },
  };
}

function latestCloudDeviceEvent(pairing, now = Date.now()) {
  if (!Number.isInteger(pairing?.last_event_at_ms) || typeof pairing.last_event_json !== "string") {
    return { latest_event: null, latest_event_age_ms: null, latest_event_fresh: false };
  }
  const age = Math.max(0, now - pairing.last_event_at_ms);
  if (age > DEVICE_EVENT_RESULT_TTL_MS) return { latest_event: null, latest_event_age_ms: age, latest_event_fresh: false };
  try {
    const event = JSON.parse(pairing.last_event_json);
    if (!event || typeof event !== "object" || typeof event.event_id !== "string") throw new Error("invalid_event");
    return { latest_event: event, latest_event_age_ms: age, latest_event_fresh: true };
  } catch {
    return { latest_event: null, latest_event_age_ms: age, latest_event_fresh: false };
  }
}

function latestCloudButtonEvent(pairing, now = Date.now()) {
  if (!Number.isInteger(pairing?.last_button_event_at_ms)
      || typeof pairing.last_button_event_json !== "string") {
    return { button_event: null, button_event_age_ms: null };
  }
  const age = Math.max(0, now - pairing.last_button_event_at_ms);
  if (age > DEVICE_BUTTON_EVENT_TTL_MS || Number.isInteger(pairing.last_button_event_claimed_at_ms)) {
    return { button_event: null, button_event_age_ms: age };
  }
  try {
    const event = JSON.parse(pairing.last_button_event_json);
    if (!event || typeof event !== "object" || event.button_id !== "ask_llm"
        || event.action !== "pressed" || typeof event.event_id !== "string") throw new Error("invalid_button_event");
    return { button_event: event, button_event_age_ms: age };
  } catch {
    return { button_event: null, button_event_age_ms: age };
  }
}

async function handleDeviceStatus(env, user) {
  const pairing = await env.DB.prepare(
    "SELECT paired_at_ms, last_seen_at_ms, last_device_id, last_boot_id, last_seq, last_telemetry_json, " +
      "last_event_at_ms, last_event_json, last_button_event_at_ms, last_button_event_json, " +
      "last_button_event_claimed_at_ms " +
      "FROM device_pairings WHERE user_id=?",
  ).bind(user.id).first();
  if (!pairing) return json(unavailableCloudDeviceStatus());
  const latestEvent = latestCloudDeviceEvent(pairing);
  const latestButtonEvent = latestCloudButtonEvent(pairing);
  if (!pairing.last_seen_at_ms || typeof pairing.last_telemetry_json !== "string") {
    const unavailable = unavailableCloudDeviceStatus("awaiting_first_telemetry", true);
    return json({ ...unavailable, ...latestEvent, status: { ...unavailable.status, ...latestButtonEvent } });
  }

  let telemetry;
  try { telemetry = JSON.parse(pairing.last_telemetry_json); } catch { telemetry = null; }
  if (!telemetry || typeof telemetry !== "object") {
    const unavailable = unavailableCloudDeviceStatus("device_stale", true);
    return json({ ...unavailable, ...latestEvent, status: { ...unavailable.status, ...latestButtonEvent } });
  }

  const receivedAgeMs = Math.max(0, Date.now() - pairing.last_seen_at_ms);
  const connected = receivedAgeMs <= DEVICE_CONNECTION_TTL_MS;
  const reportedTofAgeMs = typeof telemetry.tof_age_ms === "number"
    ? telemetry.tof_age_ms + receivedAgeMs
    : null;
  const tofFresh = connected && telemetry.tof_ok === true
    && reportedTofAgeMs !== null && reportedTofAgeMs <= DEVICE_TOF_TTL_MS;
  const zones = telemetry.zones.map((zone) => ({
    zone: zone.zone,
    tof_valid: tofFresh && zone.tof_valid === true,
    nearest_cm: tofFresh && zone.tof_valid === true ? zone.nearest_cm : null,
  }));
  return json({
    available: true,
    device_connected: connected,
    state: connected ? "device_connected" : "device_stale",
    transport: "cloud_uplink",
    ...latestEvent,
    status: {
      source: "device",
      device_id: pairing.last_device_id,
      boot_id: pairing.last_boot_id,
      seq: pairing.last_seq,
      operation_enabled: connected ? telemetry.operation_enabled : false,
      operation_epoch: telemetry.operation_epoch ?? null,
      camera_ok: connected && telemetry.camera_ok === true,
      camera_frame_seq: telemetry.camera_frame_seq ?? null,
      camera_age_ms: null,
      camera_input_state: "not_relayed",
      camera_stream_available: false,
      network_ok: connected && telemetry.network_ok === true,
      tof_mode: "device",
      tof_ok: tofFresh,
      tof_age_ms: reportedTofAgeMs,
      tof_boot_id: pairing.last_boot_id,
      telemetry_age_ms: receivedAgeMs,
      ...latestButtonEvent,
      zones,
    },
  });
}

function assistantResponseText(result) {
  const value = result?.response
    ?? result?.choices?.[0]?.message?.content
    ?? result?.output_text
    ?? "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((part) => typeof part === "string" ? part : part?.text || "").join("").trim();
  }
  return "";
}

async function handleCloudDeviceAsk(request, env, user) {
  const body = await readJson(request);
  if (!body || Object.keys(body).some((key) => !["question", "trigger"].includes(key))) {
    return badRequest("Yêu cầu hỏi đáp thiết bị chưa hợp lệ.");
  }
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 400) : "";
  const trigger = body.trigger === undefined ? "manual" : body.trigger;
  if (!question) return badRequest("Bạn nhập hoặc đọc câu hỏi trước nhé.");
  if (!["manual", "button_event"].includes(trigger)) return badRequest("Nguồn yêu cầu không hợp lệ.");

  const pairing = await env.DB.prepare(
    "SELECT last_seen_at_ms, last_device_id, last_boot_id, last_telemetry_json, last_event_at_ms, last_event_json " +
      "FROM device_pairings WHERE user_id=?",
  ).bind(user.id).first();
  const now = Date.now();
  if (!pairing || !Number.isInteger(pairing.last_seen_at_ms)
      || now - pairing.last_seen_at_ms > DEVICE_CONNECTION_TTL_MS) {
    return badRequest("Chưa có ESP32 kết nối gần đây để hỏi đáp.", 409);
  }
  let telemetry;
  try { telemetry = JSON.parse(pairing.last_telemetry_json || "null"); } catch { telemetry = null; }
  if (!telemetry || telemetry.operation_enabled !== true) {
    return badRequest("ESP32 đang tạm dừng; bật chế độ hoạt động rồi thử lại.", 409);
  }

  const assistantConfig = await readAssistantModelConfig(env);
  if (assistantConfig.provider === "cloudflare" && (!env.AI || typeof env.AI.run !== "function")) {
    return badRequest("Mô hình trợ lý trên cloud chưa sẵn sàng.", 503);
  }
  if (assistantConfig.provider === "openai" && !await openAiAssistantKey(env, assistantConfig).catch(() => "")) {
    return badRequest("GPT-6 Luna chưa được cấu hình. Mở Cài đặt AI nâng cao để kiểm tra.", 503);
  }

  let contextLines = [];
  let sceneContextAgeMs = null;
  if (Number.isInteger(pairing.last_event_at_ms) && typeof pairing.last_event_json === "string") {
    sceneContextAgeMs = Math.max(0, now - pairing.last_event_at_ms);
    if (sceneContextAgeMs <= DEVICE_EVENT_RESULT_TTL_MS) {
      try {
        const event = JSON.parse(pairing.last_event_json);
        const classes = Array.isArray(event?.classes_present)
          ? event.classes_present.slice(0, 6).map((item) => {
              const name = String(item?.class_name || "").trim().slice(0, 48);
              const ratio = Number(item?.area_ratio);
              return name ? `${name}${Number.isFinite(ratio) ? ` ${(ratio * 100).toFixed(1)}% diện tích ảnh` : ""}` : "";
            }).filter(Boolean)
          : [];
        if (classes.length) contextLines.push(`Kết quả phân đoạn gần nhất: ${classes.join(", ")}.`);
        const guidance = String(event?.guidance?.label_vi || "").trim().slice(0, 120);
        if (guidance) contextLines.push(`Gợi ý thử nghiệm của mô hình: ${guidance}; đây chưa phải chỉ dẫn an toàn đã kiểm chứng.`);
      } catch { sceneContextAgeMs = null; }
    }
  }
  const telemetryAgeMs = Math.max(0, now - pairing.last_seen_at_ms)
    + (typeof telemetry.tof_age_ms === "number" && Number.isFinite(telemetry.tof_age_ms) ? telemetry.tof_age_ms : 0);
  const center = Array.isArray(telemetry.zones)
    ? telemetry.zones.find((zone) => zone?.zone === "center")
    : null;
  const tofFresh = telemetry.tof_ok === true && center?.tof_valid === true
    && typeof center.nearest_cm === "number" && Number.isFinite(center.nearest_cm)
    && telemetryAgeMs <= DEVICE_TOF_TTL_MS;
  if (tofFresh) contextLines.push(`ToF trung tâm ESP32 đo gần nhất ${center.nearest_cm.toFixed(1)} cm (không ghép với một vật cụ thể).`);

  const userMessage = contextLines.length
    ? `${question}\n\nNgữ cảnh cảm biến ESP32 mới (không có ảnh gốc): ${contextLines.join(" ")}`
    : `${question}\n\nKhông có ảnh hoặc ngữ cảnh cảm biến mới từ ESP32 cho lượt này.`;
  let result;
  try {
    const previousMessages = await loadRecentAssistantMessages(env, user.id);
    result = await callAssistantModel(env, assistantConfig, {
      messages: [
        { role: "system", content: VOICE_INSTRUCTIONS + " Nếu không có ảnh gốc, không được khẳng định đã nhìn thấy chi tiết hình ảnh; hãy nêu giới hạn khi người dùng hỏi về cảnh trước mặt." },
        ...previousMessages,
        { role: "user", content: userMessage },
      ],
      max_completion_tokens: ASSISTANT_PROFILE.generation.cloud_voice_max_tokens,
      temperature: ASSISTANT_PROFILE.generation.voice_temperature,
      reasoning_effort: "low",
      stream: false,
    });
  } catch (error) {
    console.error("Cloud device Ask model request failed");
    return badRequest("Mô hình trợ lý chưa trả lời được. Kiểm tra Cài đặt AI nâng cao rồi thử lại.", 503);
  }
  const answer = assistantResponseText(result);
  if (!answer) return badRequest("Mô hình chưa tạo được câu trả lời. Bạn thử hỏi lại nhé.", 502);
  try {
    await env.DB.prepare(
      "INSERT INTO history(user_id, question, answer, labels_json, created_at) VALUES(?,?,?,?,?)",
    ).bind(user.id, question, answer, "[]", new Date().toISOString()).run();
  } catch (error) {
    console.error("Could not save cloud device Ask history");
  }
  return json({
    answer,
    provider: assistantConfig.provider,
    model: assistantConfig.model_name || VISION_MODEL,
    sensor_context_used: contextLines.length > 0,
    image_available: false,
    scene_context_age_ms: sceneContextAgeMs,
    tof_used: tofFresh,
  }, 200, { "Cache-Control": "no-store" });
}

async function handleRegister(request, env) {
  if (!await authRateAllowed(request, env, "register")) return badRequest("Thử tạo hồ sơ lại sau 15 phút nhé.", 429);
  const body = await readJson(request);
  if (!body) return badRequest("Thông tin tạo hồ sơ chưa hợp lệ.");
  const username = String(body.username || "").trim().toLowerCase();
  const displayName = String(body.display_name || "").trim().slice(0, 50);
  const password = String(body.password || "");
  if (!env.REGISTRATION_CODE) {
    return badRequest("Đăng ký cloud chưa được cấu hình. Thử lại sau nhé.", 503);
  }
  if (!constantTimeEqual(body.registration_code || "", env.REGISTRATION_CODE)) {
    return badRequest("Mã tạo hồ sơ chưa đúng.", 403);
  }
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    return badRequest("Tên đăng nhập cần 3–32 ký tự: chữ thường, số, dấu chấm, gạch dưới hoặc gạch nối.");
  }
  if (password.length < 8 || password.length > 128) return badRequest("Mật khẩu cần từ 8 đến 128 ký tự.");
  if (!displayName) return badRequest("Bạn nhập tên muốn được gọi nhé.");
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const digest = await passwordDigest(password, salt);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO users(id, username, password_salt, password_hash, display_name, created_at) VALUES(?,?,?,?,?,?)",
    ).bind(id, username, salt, digest, displayName, createdAt).run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO app_settings(key, value) VALUES('model_settings_admin_id', ?)",
    ).bind(id).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) return badRequest("Tên đăng nhập này đã có. Bạn chọn tên khác nhé.", 409);
    throw error;
  }
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  return json(
    { user: userPayload(user), profile: profilePayload(user) },
    200,
    { "Set-Cookie": await makeSessionCookie(user, env, new URL(request.url).protocol === "https:") },
  );
}

async function handleLogin(request, env) {
  if (!await authRateAllowed(request, env, "login")) return badRequest("Thử đăng nhập lại sau 15 phút nhé.", 429);
  const body = await readJson(request);
  if (!body) return badRequest("Thông tin đăng nhập chưa hợp lệ.");
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").bind(username).first();
  if (!user || password.length > 128) return badRequest("Tên đăng nhập hoặc mật khẩu chưa đúng.", 401);
  const digest = await passwordDigest(password, user.password_salt);
  if (!constantTimeEqual(digest, user.password_hash)) return badRequest("Tên đăng nhập hoặc mật khẩu chưa đúng.", 401);
  return json(
    { user: userPayload(user), profile: profilePayload(user) },
    200,
    { "Set-Cookie": await makeSessionCookie(user, env, new URL(request.url).protocol === "https:") },
  );
}

async function handleLogout(request, env) {
  const user = await currentUser(request, env);
  if (user) await env.DB.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").bind(user.id).run();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": "ro_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + secure },
  });
}

function boxValue(box, keys) {
  for (const key of keys) {
    if (typeof box?.[key] === "number" && Number.isFinite(box[key])) return box[key];
  }
  return null;
}

function imageDimensions(bytes) {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { width: 0, height: 0 };
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += segmentLength;
  }
  return { width: 0, height: 0 };
}

function normalizeDetections(raw, dimensions) {
  let payload = raw;
  if (payload?.result && !Array.isArray(payload.result)) payload = payload.result;
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.detections) ? payload.detections : Array.isArray(payload?.objects) ? payload.objects : Array.isArray(payload?.result) ? payload.result : [];
  return items.slice(0, MAX_DETECTIONS).map((item) => {
    const boxSource = item.box || item.bbox || item;
    let coordinates = Array.isArray(boxSource) ? boxSource : [
      boxValue(boxSource, ["xmin", "x_min", "x1", "left"]),
      boxValue(boxSource, ["ymin", "y_min", "y1", "top"]),
      boxValue(boxSource, ["xmax", "x_max", "x2", "right"]),
      boxValue(boxSource, ["ymax", "y_max", "y2", "bottom"]),
    ];
    if (coordinates.length !== 4 || coordinates.some((coordinate) => typeof coordinate !== "number")) return null;
    if (coordinates.some((coordinate) => coordinate > 1 || coordinate < 0)) {
      if (!dimensions?.width || !dimensions?.height) return null;
      coordinates = [coordinates[0] / dimensions.width, coordinates[1] / dimensions.height, coordinates[2] / dimensions.width, coordinates[3] / dimensions.height];
    }
    const [x1, y1, x2, y2] = coordinates.map((coordinate) => Math.max(0, Math.min(1, coordinate)));
    const label = String(item.label || item.class || item.class_name || "obstacle").toLowerCase();
    const navigationRole = navigationClassRole(label);
    const cx = (x1 + x2) / 2;
    const regionVi = cx < 0.36 ? "bên trái" : cx > 0.64 ? "bên phải" : "ở giữa";
    const score = Number(item.score ?? item.confidence);
    return {
      label,
      label_vi: LABELS_VI[label] || label.replaceAll("_", " "),
      ...navigationRole,
      navigation_assessment: "unvalidated_candidate_only",
      confidence: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null,
      region_vi: regionVi,
      box: [x1, y1, x2, y2].map((coordinate) => Number(coordinate.toFixed(4))),
    };
  }).filter(Boolean).sort((a, b) => b.confidence - a.confidence);
}

async function cloudDetections(env, imageBytes, mimeType = "image/jpeg") {
  let output = await env.AI.run(DETECTOR_MODEL, {
    image: "data:" + mimeType + ";base64," + base64(imageBytes),
    task: "detect",
    target: DETECTOR_TARGET,
    max_objects: MAX_DETECTIONS,
    stream: false,
  });
  if (output instanceof ReadableStream) {
    const streamedText = await new Response(output).text();
    try { output = JSON.parse(streamedText); } catch { throw new Error("Unexpected streamed response from non-streaming detector"); }
  }
  if (output?.error) throw new Error(String(output.error));
  return normalizeDetections(output, imageDimensions(imageBytes));
}

function safeTunnelOrigin(value, env) {
  let url;
  try { url = new URL(String(value || "")); } catch { return null; }
  const allowlistedHosts = String(env.MODEL_HOST_ALLOWED_HOSTS || "")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  const isQuickTunnel = url.hostname.endsWith(".trycloudflare.com");
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) return null;
  if (!isQuickTunnel && !allowlistedHosts.includes(url.hostname.toLowerCase())) return null;
  return url.origin;
}

async function modelSettingsAdmin(env, user) {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
    .bind("model_settings_admin_id").first();
  return Boolean(row?.value && row.value === user.id);
}

async function readModelHostConfig(env) {
  return await env.DB.prepare("SELECT provider, model_name, endpoint_url, encrypted_api_key, updated_at FROM model_host_config WHERE id = 1").first()
    || { provider: "cloudflare", model_name: "moondream-cloud", endpoint_url: "", encrypted_api_key: "", updated_at: null };
}

async function readAssistantModelConfig(env) {
  return await env.DB.prepare("SELECT provider, model_name, encrypted_api_key, updated_at FROM assistant_model_config WHERE id = 1").first()
    || { provider: "cloudflare", model_name: VISION_MODEL, encrypted_api_key: "", updated_at: null };
}

async function readSegmentationHostConfig(env) {
  return await env.DB.prepare("SELECT endpoint_url, encrypted_service_token, updated_at FROM segmentation_host_config WHERE id = 1").first()
    || { endpoint_url: "", encrypted_service_token: "", updated_at: null };
}

function publicSegmentationHostSettings(config, editable) {
  return {
    editable,
    endpoint_url: editable ? config.endpoint_url : "",
    token_configured: Boolean(config.encrypted_service_token),
    updated_at: config.updated_at,
  };
}

async function readResponseBytesLimited(response, maxBytes) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("upstream_response_too_large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("upstream_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function segmentationHostRequest(env, path, options = {}, responseLimit = MAX_SEGMENTATION_HEALTH_BYTES) {
  const config = await readSegmentationHostConfig(env);
  const endpoint = safeTunnelOrigin(config.endpoint_url, env);
  if (!endpoint || !config.encrypted_service_token) throw new Error("segmentation_host_not_configured");
  const token = await decryptModelToken(config.encrypted_service_token, env.MODEL_SETTINGS_ENCRYPTION_KEY);
  const response = await fetch(`${endpoint}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: AbortSignal.timeout(path === "/health" ? 8_000 : 20_000),
  });
  if (response.status < 200 || response.status >= 300) throw new Error("segmentation_upstream_rejected");
  const bytes = await readResponseBytesLimited(response, responseLimit);
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("segmentation_invalid_json"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("segmentation_invalid_json");
  return payload;
}

const SEGMENTATION_HEALTH_FIELDS = [
  "service", "model_ready", "model_id", "class_names", "device", "calibration_status",
  "output_kind", "navigation_decision_enabled", "navigation_status", "navigation_policy",
  "input_size", "preprocessing", "images_saved",
];

function safeSegmentationHealth(payload) {
  const safe = {};
  for (const key of SEGMENTATION_HEALTH_FIELDS) {
    if (!(key in payload)) continue;
    const value = payload[key];
    if (key === "class_names" && Array.isArray(value)) safe[key] = value.filter((item) => typeof item === "string").slice(0, 64).map((item) => item.slice(0, 80));
    else if (["model_ready", "navigation_decision_enabled"].includes(key) && typeof value === "boolean") safe[key] = value;
    else if (key === "input_size" && Number.isInteger(value) && value > 0 && value <= 4096) safe[key] = value;
    else if (typeof value === "string") safe[key] = value.slice(0, 256);
  }
  return { ...safe, available: true, images_saved: false };
}

function safeSegmentationGuidance(value) {
  const allowed = new Set(["state", "label_vi", "reason", "zones", "policy", "safety_status"]);
  const output = Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
  if (output.state !== undefined && !["left", "center", "right", "stop", "unknown"].includes(output.state)) throw new Error("invalid_guidance_state");
  if (output.label_vi !== undefined && typeof output.label_vi !== "string") throw new Error("invalid_guidance_label");
  if (output.reason !== undefined && typeof output.reason !== "string") throw new Error("invalid_guidance_reason");
  if (output.safety_status !== undefined && typeof output.safety_status !== "string") throw new Error("invalid_guidance_status");
  for (const key of ["label_vi", "reason", "safety_status"]) if (typeof output[key] === "string") output[key] = output[key].slice(0, 240);
  if (output.zones !== undefined) {
    if (!output.zones || typeof output.zones !== "object" || Array.isArray(output.zones)) throw new Error("invalid_guidance_zones");
    const zones = {};
    for (const zone of ["left", "center", "right"]) {
      const entry = output.zones[zone];
      if (!entry) continue;
      if (typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid_guidance_zone");
      const clean = {};
      if (typeof entry.status === "string") clean.status = entry.status.slice(0, 48);
      for (const key of ["walkable_score", "blocker_score", "blocker_share", "evidence_coverage", "confident_walkable_share"]) {
        if (Number.isFinite(entry[key])) clean[key] = entry[key];
      }
      zones[zone] = clean;
    }
    output.zones = zones;
  }
  if (output.policy !== undefined) {
    if (!output.policy || typeof output.policy !== "object" || Array.isArray(output.policy)) throw new Error("invalid_guidance_policy");
    const policyKeys = new Set(["corridor_top_y_ratio", "corridor_top_half_width_ratio", "corridor_bottom_half_width_ratio", "near_field_weight_exponent", "walkable_pixel_probability_threshold", "min_evidence_coverage", "open_walkable_mass", "open_blocker_share_max", "blocked_blocker_share", "calibration"]);
    output.policy = Object.fromEntries(Object.entries(output.policy).filter(([key]) => policyKeys.has(key) && (typeof output.policy[key] === "string" || Number.isFinite(output.policy[key]))).map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 120) : item]));
  }
  return output;
}

async function handleSegmentationSettings(request, env, user) {
  const canEdit = await modelSettingsAdmin(env, user);
  if (!canEdit) return badRequest("Chỉ chủ app được cấu hình máy chủ SegFormer.", 403);
  if (request.method === "GET") {
    return json({ settings: publicSegmentationHostSettings(await readSegmentationHostConfig(env), true) }, 200, { "Cache-Control": "no-store" });
  }
  if (request.method === "PUT") {
    const body = await readJson(request);
    if (!body || Object.keys(body).some((key) => !["endpoint_url", "service_token"].includes(key))) return badRequest("Cấu hình SegFormer chưa hợp lệ.");
    const endpoint = safeTunnelOrigin(body.endpoint_url, env);
    if (!endpoint) return badRequest("Nhập URL HTTPS của Cloudflare Tunnel (trycloudflare.com) hoặc host đã cho phép.");
    const token = String(body.service_token || "").trim();
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) return badRequest("Nhập service token hợp lệ của SegFormer host.");
    if (!env.MODEL_SETTINGS_ENCRYPTION_KEY || String(env.MODEL_SETTINGS_ENCRYPTION_KEY).length < 32) return badRequest("Cloud chưa cấu hình khóa mã hóa cho cấu hình SegFormer.", 503);
    const encryptedToken = await encryptModelToken(token, env.MODEL_SETTINGS_ENCRYPTION_KEY);
    const updatedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE segmentation_host_config SET endpoint_url=?, encrypted_service_token=?, updated_at=? WHERE id=1")
      .bind(endpoint, encryptedToken, updatedAt).run();
    return json({ settings: publicSegmentationHostSettings(await readSegmentationHostConfig(env), true), saved: true }, 200, { "Cache-Control": "no-store" });
  }
  if (request.method === "POST") {
    try {
      const health = await segmentationHostRequest(env, "/health");
      return json({ ok: true, health: safeSegmentationHealth(health) }, 200, { "Cache-Control": "no-store" });
    } catch {
      return json({ ok: false, error: "Không kết nối được SegFormer host đã cấu hình." }, 503, { "Cache-Control": "no-store" });
    }
  }
  return badRequest("Phương thức chưa được hỗ trợ.", 405);
}

async function segmentationHealth(env) {
  try {
    return json(safeSegmentationHealth(await segmentationHostRequest(env, "/health")), 200, { "Cache-Control": "no-store" });
  } catch {
    return json({ available: false, model_ready: false, calibration_status: "unavailable", navigation_decision_enabled: false, images_saved: false }, 503, { "Cache-Control": "no-store" });
  }
}

async function inferSegmentation(request, env) {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES + 128 * 1024) return badRequest("Khung hình lớn hơn giới hạn 8 MB.", 413);
  let form;
  try { form = await request.formData(); } catch { return badRequest("Request phân đoạn chưa hợp lệ."); }
  const expected = new Set(["image", "stream_id", "frame_id"]);
  const keys = Array.from(form.keys());
  if (keys.length !== new Set(keys).size || keys.some((key) => !expected.has(key)) || !keys.includes("image")) return badRequest("Chỉ nhận image, stream_id và frame_id.");
  const image = form.get("image");
  const streamId = form.get("stream_id");
  const frameIdRaw = form.get("frame_id");
  if (!(image instanceof File) || image.size === 0) return badRequest("Ảnh JPEG chưa hợp lệ.");
  if (image.size > MAX_IMAGE_BYTES) return badRequest("Khung hình lớn hơn giới hạn 8 MB.", 413);
  if (image.type && image.type !== "image/jpeg") return badRequest("Chỉ nhận ảnh JPEG.", 415);
  if (streamId !== null && (typeof streamId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(streamId))) return badRequest("stream_id chưa hợp lệ.");
  if (frameIdRaw !== null && (typeof frameIdRaw !== "string" || !/^[0-9]{1,16}$/.test(frameIdRaw) || !Number.isSafeInteger(Number(frameIdRaw)) || Number(frameIdRaw) < 1)) return badRequest("frame_id chưa hợp lệ.");
  const imageBytes = new Uint8Array(await image.arrayBuffer());
  if (imageBytes.length < 4 || imageBytes[0] !== 0xff || imageBytes[1] !== 0xd8 || imageBytes[2] !== 0xff) return badRequest("Nội dung ảnh không phải JPEG hợp lệ.", 415);
  const body = { image_base64: base64(imageBytes) };
  if (streamId !== null) body.stream_id = streamId;
  if (frameIdRaw !== null) body.frame_id = Number(frameIdRaw);
  try {
    const result = await segmentationHostRequest(env, "/api/segment", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, MAX_SEGMENTATION_RESPONSE_BYTES);
    const required = ["model_id", "calibration_status", "navigation_decision_enabled", "image_width", "image_height", "inference_ms", "classes_present", "mask_encoding", "mask_png_base64", "images_saved", "guidance", "stream_id", "frame_id"];
    if (required.some((key) => !(key in result)) || typeof result.model_id !== "string" || result.model_id.length > 256
        || result.calibration_status !== "experimental" || result.navigation_decision_enabled !== true || result.images_saved !== false
        || !Number.isInteger(result.image_width) || result.image_width < 1 || result.image_width > 4096
        || !Number.isInteger(result.image_height) || result.image_height < 1 || result.image_height > 4096
        || !Number.isFinite(result.inference_ms) || result.inference_ms < 0 || result.inference_ms > 120_000
        || !Array.isArray(result.classes_present) || result.classes_present.length > 64
        || typeof result.mask_encoding !== "string" || result.mask_encoding.length > 80
        || typeof result.mask_png_base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.mask_png_base64) || result.mask_png_base64.length > MAX_SEGMENTATION_RESPONSE_BYTES
        || !(result.stream_id === null || (typeof result.stream_id === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(result.stream_id)))
        || !(result.frame_id === null || (Number.isSafeInteger(result.frame_id) && result.frame_id >= 1))
        || !result.guidance || typeof result.guidance !== "object" || Array.isArray(result.guidance)) throw new Error("invalid_segmentation_result");
    if (streamId !== null && result.stream_id !== streamId) throw new Error("segmentation_stream_mismatch");
    if (frameIdRaw !== null && result.frame_id !== Number(frameIdRaw)) throw new Error("segmentation_frame_mismatch");
    const classes = result.classes_present.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)
          || !Number.isInteger(item.class_id) || item.class_id < 0 || item.class_id > 255
          || typeof item.class_name !== "string" || item.class_name.length > 80
          || !Number.isInteger(item.pixels) || item.pixels < 0
          || !Number.isFinite(item.area_ratio) || item.area_ratio < 0 || item.area_ratio > 1
          || !Number.isFinite(item.mean_confidence) || item.mean_confidence < 0 || item.mean_confidence > 1) throw new Error("invalid_segmentation_class");
      return { class_id: item.class_id, class_name: item.class_name, pixels: item.pixels, area_ratio: item.area_ratio, mean_confidence: item.mean_confidence };
    });
    const output = Object.fromEntries(required.map((key) => [key, result[key]]));
    output.classes_present = classes;
    output.guidance = safeSegmentationGuidance(result.guidance);
    if ("navigation_status" in result && typeof result.navigation_status === "string") output.navigation_status = result.navigation_status.slice(0, 120);
    output.images_saved = false;
    return json(output, 200, { "Cache-Control": "no-store" });
  } catch {
    return badRequest("Không kết nối được SegFormer host hoặc kết quả không hợp lệ.", 503);
  }
}

async function aesModelConfigKey(secret) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Model settings encryption key is not configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptModelToken(token, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesModelConfigKey(secret);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptModelToken(value, secret) {
  const [encodedIv, encodedCiphertext, extra] = String(value || "").split(".");
  if (!encodedIv || !encodedCiphertext || extra) throw new Error("Stored model API key is invalid");
  const key = await aesModelConfigKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(encodedIv) }, key, fromBase64Url(encodedCiphertext),
  );
  return new TextDecoder().decode(plaintext);
}

function publicModelSettings(config, canEdit) {
  return {
    editable: canEdit,
    provider: config.provider,
    model_name: config.model_name,
    endpoint_url: canEdit ? config.endpoint_url : "",
    api_key_configured: Boolean(config.encrypted_api_key),
    updated_at: config.updated_at,
  };
}

function publicAssistantModelSettings(config, canEdit, env) {
  return {
    editable: canEdit,
    provider: config.provider,
    model_name: config.model_name,
    api_key_configured: Boolean(config.encrypted_api_key || (config.provider === "openai" && env.OPENAI_API_KEY)),
    updated_at: config.updated_at,
  };
}

async function openAiAssistantKey(env, config) {
  if (config.encrypted_api_key) return await decryptModelToken(config.encrypted_api_key, env.MODEL_SETTINGS_ENCRYPTION_KEY);
  return String(env.OPENAI_API_KEY || "").trim();
}

async function callAssistantModel(env, config, options) {
  if (config.provider !== "openai") {
    if (!env.AI || typeof env.AI.run !== "function") throw new Error("Cloudflare Workers AI is not configured");
    return await env.AI.run(config.model_name || VISION_MODEL, options);
  }
  const token = await openAiAssistantKey(env, config);
  if (!token) throw new Error("OpenAI API key is not configured");
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model_name || OPENAI_VISION_MODEL,
      messages: options.messages,
      max_completion_tokens: options.max_completion_tokens,
      reasoning_effort: options.reasoning_effort || "low",
      stream: Boolean(options.stream),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = String(payload?.error?.message || `HTTP ${response.status}`).slice(0, 240);
    throw new Error(`OpenAI assistant request failed: ${detail}`);
  }
  if (options.stream) return response.body;
  return await response.json();
}

async function modelHostDetections(env, bytes, mimeType, pathMetadata = null) {
  const config = await readModelHostConfig(env);
  if (config.provider !== "yolo_host") return {
    provider: "cloudflare",
    model: DETECTOR_MODEL,
    detections: await cloudDetections(env, bytes, mimeType),
    inference_ms: null,
  };
  const endpoint = safeTunnelOrigin(config.endpoint_url, env);
  if (!endpoint || !config.encrypted_api_key) throw new Error("Personal YOLO host is not configured");
  const token = await decryptModelToken(config.encrypted_api_key, env.MODEL_SETTINGS_ENCRYPTION_KEY);
  const form = new FormData();
  form.set("image", new File([bytes], "frame.jpg", { type: mimeType || "image/jpeg" }));
  if (pathMetadata) {
    form.set("path_stream_id", pathMetadata.stream_id);
    form.set("path_frame_id", String(pathMetadata.frame_id));
    form.set("path_timestamp_ms", String(pathMetadata.timestamp_ms));
    form.set("path_frame_age_ms", String(pathMetadata.frame_age_ms));
  }
  const response = await fetch(`${endpoint}/api/inference/yolo`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Personal YOLO host returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.detections) || payload?.provider !== "ro-yolo-host") throw new Error("Personal YOLO host response is invalid");
  return {
    provider: "yolo_host",
    model: String(payload.model || config.model_name),
    detections: normalizeDetections(payload, imageDimensions(bytes)),
    inference_ms: Number.isFinite(payload.inference_ms) ? payload.inference_ms : null,
    path_result: payload.path_result && typeof payload.path_result === "object" ? payload.path_result : null,
  };
}

function safePathHealth(payload) {
  const fields = [
    "service", "available", "model_ready", "model_id", "policy_id",
    "calibration_status", "geometry_source", "occupancy_threshold",
    "clear_occupancy_threshold", "clear_hysteresis_enabled",
    "transport_age_budget_ms", "tracking_ready", "tracking_method",
    "tracking_calibrated", "camera_motion_compensated", "growth_warning_enabled",
  ];
  const result = {};
  for (const key of fields) if (payload?.[key] !== undefined) result[key] = payload[key];
  result.available = payload?.available === true;
  result.model_ready = payload?.model_ready === true;
  result.service = "yolo-bbox-path";
  result.geometry_source = "bbox_proxy";
  result.calibration_status = result.available ? "experimental" : "unavailable";
  result.tracking_calibrated = false;
  result.camera_motion_compensated = false;
  result.growth_warning_enabled = false;
  if ([
    "path_policy_missing", "invalid_path_policy_fields", "invalid_path_policy", "invalid_path_config",
    "model_host_not_configured", "path_model_requires_yolo_host", "path_host_update_required",
  ].includes(payload?.reason)) {
    result.reason = payload.reason;
  }
  return result;
}

async function modelHostPathHealth(env) {
  const config = await readModelHostConfig(env);
  if (config.provider !== "yolo_host") return json({
    available: false, model_ready: false, service: "yolo-bbox-path",
    calibration_status: "unavailable", geometry_source: "bbox_proxy",
    reason: "path_model_requires_yolo_host",
  });
  const endpoint = safeTunnelOrigin(config.endpoint_url, env);
  if (!endpoint || !config.encrypted_api_key) return json({
    available: false, model_ready: false, service: "yolo-bbox-path",
    calibration_status: "unavailable", geometry_source: "bbox_proxy",
    reason: "model_host_not_configured",
  });
  try {
    const token = await decryptModelToken(config.encrypted_api_key, env.MODEL_SETTINGS_ENCRYPTION_KEY);
    const response = await fetch(`${endpoint}/api/inference/path/health`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404) return json({
      available: false, model_ready: false, service: "yolo-bbox-path",
      calibration_status: "unavailable", geometry_source: "bbox_proxy",
      reason: "path_host_update_required",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`path health HTTP ${response.status}`);
    return json(safePathHealth(payload));
  } catch (error) {
    console.error("YOLO path health unavailable");
    return json({
      available: false, model_ready: false, service: "yolo-bbox-path",
      calibration_status: "unavailable", geometry_source: "bbox_proxy",
      tracking_calibrated: false, camera_motion_compensated: false,
      growth_warning_enabled: false,
    });
  }
}

function boundedIntegerField(form, name, upper) {
  const value = form.get(name);
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= upper ? number : null;
}

function safePathTracks(tracks) {
  if (!Array.isArray(tracks)) return [];
  return tracks.slice(0, 20).filter((track) => track && typeof track === "object").map((track) => ({
    track_id: Number.isSafeInteger(track.track_id) || typeof track.track_id === "string" ? track.track_id : null,
    class_name: typeof track.class_name === "string" ? track.class_name.slice(0, 40) : "",
    confidence: Number.isFinite(track.confidence) ? track.confidence : null,
    object_intrusion_ratio: Number.isFinite(track.object_intrusion_ratio) ? track.object_intrusion_ratio : null,
    path_occupancy_share: Number.isFinite(track.path_occupancy_share) ? track.path_occupancy_share : null,
    footpoint_inside_corridor: typeof track.footpoint_inside_corridor === "boolean" ? track.footpoint_inside_corridor : null,
    intrusion: track.intrusion === true,
    growth_per_second: null,
    time_to_threshold_s: null,
    approaching: false,
  }));
}

function safeInlinePathResult(payload, metadata) {
  const states = new Set(["unknown", "clear_candidate", "caution", "approaching", "blocked"]);
  const state = states.has(payload?.state) ? payload.state : "unknown";
  return {
    state,
    valid: state !== "unknown" && payload?.valid === true,
    stream_id: metadata.stream_id,
    frame_id: metadata.frame_id,
    timestamp_ms: metadata.timestamp_ms,
    occupancy_ratio: Number.isFinite(payload?.occupancy_ratio) ? payload.occupancy_ratio : null,
    corridor_pixels: Number.isSafeInteger(payload?.corridor_pixels) ? payload.corridor_pixels : null,
    occupied_pixels: Number.isSafeInteger(payload?.occupied_pixels) ? payload.occupied_pixels : null,
    tracks: safePathTracks(payload?.tracks),
    reason: typeof payload?.reason === "string" ? payload.reason.slice(0, 80) : "unknown",
    schema_version: "yolo-bbox-path-result-v1",
    model_id: typeof payload?.model_id === "string" ? payload.model_id.slice(0, 100) : "yolo26n.pt",
    policy_id: typeof payload?.policy_id === "string" ? payload.policy_id.slice(0, 100) : null,
    calibration_status: "experimental",
    geometry_source: "bbox_proxy",
    prediction_and_adapter_ms: Number.isFinite(payload?.prediction_and_adapter_ms) ? payload.prediction_and_adapter_ms : null,
    frame_age_at_decision_ms: Number.isFinite(payload?.frame_age_at_decision_ms) ? payload.frame_age_at_decision_ms : null,
    tracking_ready: payload?.tracking_ready === true,
    tracking_method: typeof payload?.tracking_method === "string" ? payload.tracking_method.slice(0, 80) : null,
    tracking_calibrated: false,
    camera_motion_compensated: false,
    growth_warning_enabled: false,
    occupancy_threshold: Number.isFinite(payload?.occupancy_threshold) ? payload.occupancy_threshold : null,
    clear_occupancy_threshold: Number.isFinite(payload?.clear_occupancy_threshold) ? payload.clear_occupancy_threshold : null,
    clear_hysteresis_enabled: payload?.clear_hysteresis_enabled === true,
  };
}

async function detectPathOccupancy(request, env) {
  const config = await readModelHostConfig(env);
  if (config.provider !== "yolo_host") return badRequest("Path occupancy cần YOLO host được cấu hình.", 503);
  const endpoint = safeTunnelOrigin(config.endpoint_url, env);
  if (!endpoint || !config.encrypted_api_key) return badRequest("YOLO host chưa được cấu hình.", 503);
  let form;
  try { form = await request.formData(); } catch { return badRequest("Request path occupancy chưa hợp lệ."); }
  const expected = new Set(["image", "stream_id", "frame_id", "timestamp_ms", "frame_age_ms", "roi_valid"]);
  const keys = Array.from(form.keys());
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) return badRequest("Thiếu hoặc thừa trường path occupancy.");
  const image = form.get("image");
  const streamId = form.get("stream_id");
  const roiValid = form.get("roi_valid");
  const frameId = boundedIntegerField(form, "frame_id", Number.MAX_SAFE_INTEGER);
  const timestampMs = boundedIntegerField(form, "timestamp_ms", Number.MAX_SAFE_INTEGER);
  const frameAgeMs = boundedIntegerField(form, "frame_age_ms", 60_000);
  if (!(image instanceof File) || image.type !== "image/jpeg" || image.size < 1 || image.size > 2 * 1024 * 1024
      || typeof streamId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(streamId)
      || frameId === null || timestampMs === null || frameAgeMs === null
      || !["true", "false"].includes(roiValid)) return badRequest("Ảnh hoặc metadata path occupancy chưa hợp lệ.");
  let token;
  try { token = await decryptModelToken(config.encrypted_api_key, env.MODEL_SETTINGS_ENCRYPTION_KEY); }
  catch { return badRequest("Cloud không giải mã được API key của YOLO host.", 503); }
  const forwarded = new FormData();
  forwarded.set("image", new File([await image.arrayBuffer()], "path-frame.jpg", { type: "image/jpeg" }));
  for (const key of ["stream_id", "frame_id", "timestamp_ms", "frame_age_ms", "roi_valid"]) forwarded.set(key, form.get(key));
  try {
    const response = await fetch(`${endpoint}/api/inference/path/detect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: forwarded,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({}));
    const allowedStates = new Set(["unknown", "clear_candidate", "caution", "approaching", "blocked"]);
    if (!response.ok || payload?.stream_id !== streamId || payload?.frame_id !== frameId
        || !allowedStates.has(payload?.state)) {
      console.error("YOLO path request unavailable", { status: response.status });
      return badRequest("Path occupancy chưa trả được kết quả mới. Trạng thái giữ UNKNOWN.", 503);
    }
    const result = {
      state: payload.state,
      valid: payload.valid === true,
      frame_id: frameId,
      timestamp_ms: timestampMs,
      stream_id: streamId,
      occupancy_ratio: Number.isFinite(payload.occupancy_ratio) ? payload.occupancy_ratio : null,
      corridor_pixels: Number.isSafeInteger(payload.corridor_pixels) ? payload.corridor_pixels : null,
      occupied_pixels: Number.isSafeInteger(payload.occupied_pixels) ? payload.occupied_pixels : null,
      tracks: safePathTracks(payload.tracks),
      reason: typeof payload.reason === "string" ? payload.reason.slice(0, 80) : "unknown",
      schema_version: "yolo-bbox-path-result-v1",
      model_id: typeof payload.model_id === "string" ? payload.model_id.slice(0, 100) : config.model_name,
      policy_id: typeof payload.policy_id === "string" ? payload.policy_id.slice(0, 100) : null,
      calibration_status: "experimental",
      geometry_source: "bbox_proxy",
      prediction_and_adapter_ms: Number.isFinite(payload.prediction_and_adapter_ms) ? payload.prediction_and_adapter_ms : null,
      frame_age_at_decision_ms: Number.isFinite(payload.frame_age_at_decision_ms) ? payload.frame_age_at_decision_ms : null,
      tracking_ready: payload.tracking_ready === true,
      tracking_method: typeof payload.tracking_method === "string" ? payload.tracking_method.slice(0, 80) : null,
      tracking_calibrated: false,
      camera_motion_compensated: false,
      growth_warning_enabled: false,
      transport_age_budget_ms: Number.isSafeInteger(payload.transport_age_budget_ms) ? payload.transport_age_budget_ms : null,
      age_measurement: typeof payload.age_measurement === "string" ? payload.age_measurement.slice(0, 100) : null,
      occupancy_threshold: Number.isFinite(payload.occupancy_threshold) ? payload.occupancy_threshold : null,
      clear_occupancy_threshold: Number.isFinite(payload.clear_occupancy_threshold) ? payload.clear_occupancy_threshold : null,
      clear_hysteresis_enabled: payload.clear_hysteresis_enabled === true,
    };
    return json(result);
  } catch (error) {
    console.error("YOLO path request failed");
    return badRequest("Không kết nối được dịch vụ path occupancy. Trạng thái giữ UNKNOWN.", 503);
  }
}

async function handleModelSettings(request, env, user) {
  const canEdit = await modelSettingsAdmin(env, user);
  if (request.method === "GET") return json({ settings: publicModelSettings(await readModelHostConfig(env), canEdit) });
  if (!canEdit) return badRequest("Chỉ chủ app được sửa model dùng chung.", 403);
  if (request.method === "PUT") {
    const body = await readJson(request);
    if (!body || !["cloudflare", "yolo_host"].includes(body.provider)) return badRequest("Nhà cung cấp model chưa hợp lệ.");
    const modelName = body.provider === "yolo_host" ? String(body.model_name || "") : "moondream-cloud";
    if (body.provider === "yolo_host" && modelName !== "yolo26n") return badRequest("Hiện chỉ hỗ trợ mẫu YOLO26n.");
    let endpoint = "";
    let encryptedToken = "";
    if (body.provider === "yolo_host") {
      if (!env.MODEL_SETTINGS_ENCRYPTION_KEY || String(env.MODEL_SETTINGS_ENCRYPTION_KEY).length < 32) {
        return badRequest("Cloud chưa cấu hình khóa mã hóa cho thông tin model host.", 503);
      }
      endpoint = safeTunnelOrigin(body.endpoint_url, env);
      if (!endpoint) return badRequest("Nhập URL HTTPS của Cloudflare Tunnel (trycloudflare.com) hoặc host đã cho phép.");
      const previous = await readModelHostConfig(env);
      const token = String(body.api_key || "").trim();
      if (token) encryptedToken = await encryptModelToken(token, env.MODEL_SETTINGS_ENCRYPTION_KEY);
      else encryptedToken = previous.provider === "yolo_host" ? previous.encrypted_api_key : "";
      if (!encryptedToken) return badRequest("Nhập API key của YOLO host.");
    }
    const updatedAt = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE model_host_config SET provider=?, model_name=?, endpoint_url=?, encrypted_api_key=?, updated_at=? WHERE id=1",
    ).bind(body.provider, modelName, endpoint, encryptedToken, updatedAt).run();
    return json({ settings: publicModelSettings(await readModelHostConfig(env), true), saved: true });
  }
  if (request.method === "POST") {
    const config = await readModelHostConfig(env);
    if (config.provider !== "yolo_host") {
      if (!env.AI) return json({ ok: false, error: "Cloudflare Workers AI chưa được liên kết." }, 503);
      try {
        const samplePng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nNXOQREAIADDsFLjs44IHlyjIGcbZRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncf4OvLrJKgHdr9YYigAAAABJRU5ErkJggg=="), (value) => value.charCodeAt(0));
        const detections = await cloudDetections(env, samplePng, "image/png");
        return json({ ok: true, provider: "cloudflare", model: DETECTOR_MODEL, detection_count: detections.length, sample: "synthetic" });
      } catch {
        return json({ ok: false, error: "Workers AI đã được cấu hình nhưng lượt nhận diện mẫu thất bại." }, 502);
      }
    }
    const endpoint = safeTunnelOrigin(config.endpoint_url, env);
    if (!endpoint || !config.encrypted_api_key) return badRequest("Cấu hình YOLO host chưa đầy đủ.", 409);
    let token;
    try {
      token = await decryptModelToken(config.encrypted_api_key, env.MODEL_SETTINGS_ENCRYPTION_KEY);
    } catch {
      return json({ ok: false, error: "Cloud không giải mã được API key đã lưu. Hãy nhập lại key rồi lưu cấu hình." }, 503);
    }
    try {
      const healthResponse = await fetch(`${endpoint}/api/inference/health`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(8_000),
      });
      const health = await healthResponse.json().catch(() => ({}));
      if (!healthResponse.ok || health?.provider !== "ro-yolo-host" || health?.ready !== true) {
        return json({ ok: false, error: "YOLO host chưa sẵn sàng hoặc API key không đúng." }, 502);
      }

      const samplePng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nNXOQREAIADDsFLjs44IHlyjIGcbZRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncf4OvLrJKgHdr9YYigAAAABJRU5ErkJggg=="), (value) => value.charCodeAt(0));
      const form = new FormData();
      form.set("image", new File([samplePng], "synthetic-smoke.png", { type: "image/png" }));
      const inferenceResponse = await fetch(`${endpoint}/api/inference/yolo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      const inference = await inferenceResponse.json().catch(() => ({}));
      if (!inferenceResponse.ok || inference?.provider !== "ro-yolo-host" || !Array.isArray(inference?.detections)) {
        return json({ ok: false, error: "YOLO host đã phản hồi health nhưng lượt inference mẫu thất bại." }, 502);
      }
      return json({
        ok: true,
        provider: "yolo_host",
        model: inference.model || health.model,
        device: health.device || "unknown",
        inference_ms: Number.isFinite(inference.inference_ms) ? inference.inference_ms : null,
        detection_count: inference.detections.length,
        sample: "synthetic",
      });
    } catch {
      return json({ ok: false, error: "Không kết nối hoặc chạy inference được YOLO host. Kiểm tra máy đang bật, tunnel còn chạy và API key khớp." }, 502);
    }
  }
  return badRequest("Phương thức chưa được hỗ trợ.", 405);
}

async function handleAssistantModelSettings(request, env, user) {
  const canEdit = await modelSettingsAdmin(env, user);
  const config = await readAssistantModelConfig(env);
  if (request.method === "GET") return json({ settings: publicAssistantModelSettings(config, canEdit, env) });
  if (!canEdit) return badRequest("Chỉ chủ app được sửa mô hình trợ lý dùng chung.", 403);
  if (request.method === "PUT") {
    const body = await readJson(request);
    if (!body || !["cloudflare", "openai"].includes(body.provider)) return badRequest("Nhà cung cấp mô hình chưa hợp lệ.");
    const modelName = body.provider === "openai" ? String(body.model_name || "") : VISION_MODEL;
    if (body.provider === "openai" && modelName !== OPENAI_VISION_MODEL) return badRequest("Hiện hỗ trợ GPT-6 Luna qua OpenAI API.");
    let encryptedApiKey = "";
    if (body.provider === "openai") {
      const apiKey = String(body.api_key || "").trim();
      if (apiKey) {
        if (!env.MODEL_SETTINGS_ENCRYPTION_KEY || String(env.MODEL_SETTINGS_ENCRYPTION_KEY).length < 32) {
          return badRequest("Cloud chưa cấu hình khóa mã hóa cho API key mô hình.", 503);
        }
        encryptedApiKey = await encryptModelToken(apiKey, env.MODEL_SETTINGS_ENCRYPTION_KEY);
      } else if (config.provider === "openai") {
        encryptedApiKey = config.encrypted_api_key || "";
      }
      if (!encryptedApiKey && !env.OPENAI_API_KEY) return badRequest("Nhập OpenAI API key trước khi chuyển sang GPT-6 Luna.");
    }
    const updatedAt = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE assistant_model_config SET provider=?, model_name=?, encrypted_api_key=?, updated_at=? WHERE id=1",
    ).bind(body.provider, modelName, encryptedApiKey, updatedAt).run();
    return json({ settings: publicAssistantModelSettings(await readAssistantModelConfig(env), true, env), saved: true });
  }
  if (request.method === "POST") {
    try {
      const output = await callAssistantModel(env, config, {
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        max_completion_tokens: 8,
        temperature: 0,
        reasoning_effort: "low",
        stream: false,
      });
      const reply = String(output?.response || output?.choices?.[0]?.message?.content || "").trim();
      if (!reply) throw new Error("Model returned an empty reply");
      return json({ ok: true, provider: config.provider, model: config.model_name, sample: "text", response_received: true });
    } catch (error) {
      console.error("Assistant model connectivity check failed", { provider: config.provider, model: config.model_name });
      const status = config.provider === "openai" && !await openAiAssistantKey(env, config).catch(() => "") ? 409 : 502;
      return json({ ok: false, error: status === 409 ? "Chưa có OpenAI API key. Nhập key rồi lưu cấu hình." : "Không gọi được mô hình trợ lý. Kiểm tra provider, key và quyền dùng model." }, status);
    }
  }
  return badRequest("Phương thức chưa được hỗ trợ.", 405);
}

function conciseSummary(detections) {
  if (!detections.length) return "Mình chưa nhận diện chắc được vật thể rõ trong ảnh.";
  const names = [...new Set(detections.slice(0, 4).map((item) => item.label_vi))];
  return "Mình nhận thấy " + names.join(", ") + " trong ảnh.";
}

async function analyzeImage(request, env, user) {
  const form = await request.formData();
  const spatialContext = sanitizePhoneSpatialContext(form.get("spatial_context"));
  const spatialNote = describePhoneSpatialContext(spatialContext);
  const image = form.get("image");
  if (!(image instanceof File)) return badRequest("Bạn chọn ảnh trước nhé.");
  if (image.size === 0) return badRequest("Ảnh đang trống. Bạn chọn ảnh khác nhé.");
  if (image.size > MAX_IMAGE_BYTES) return badRequest("Ảnh lớn hơn 8 MB. Bạn chọn ảnh nhỏ hơn nhé.", 413);
  const question = String(form.get("question") || "").trim().slice(0, 400);
  const bytes = new Uint8Array(await image.arrayBuffer());
  let detectionResult;
  try {
    detectionResult = await modelHostDetections(env, bytes, image.type || "image/jpeg");
  } catch (error) {
    console.error("Configured object detection failed");
    return badRequest("Model nhận diện chưa trả kết quả. Kiểm tra cấu hình và thử lại nhé.", 503);
  }
  const detections = detectionResult.detections;
  const labels = [...new Set(detections.slice(0, 12).map((item) => item.label_vi))];
  const assistantConfig = await readAssistantModelConfig(env);
  let answer = conciseSummary(detections);
  let visionError = null;
  if (question) {
    const imageBase64 = base64(bytes);
    const dataUrl = "data:" + (image.type || "image/jpeg") + ";base64," + imageBase64;
    const metadata = detections.length
      ? "Nhận diện vật thể tự động trong ảnh: " + labels.join(", ") + "."
      : "Bộ phát hiện vật thể chưa nhận ra lớp COCO nào đủ chắc.";
    try {
      const output = await callAssistantModel(env, assistantConfig, {
        messages: [
          { role: "system", content: VISION_INSTRUCTIONS },
          {
            role: "user",
            content: [
              { type: "text", text: "Câu hỏi: " + question + "\n" + metadata + (spatialNote ? "\n" + spatialNote : "") },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_completion_tokens: ASSISTANT_PROFILE.generation.cloud_vision_max_tokens,
        temperature: ASSISTANT_PROFILE.generation.vision_temperature,
        reasoning_effort: "low",
        stream: false,
      });
      answer = String(output?.response || output?.choices?.[0]?.message?.content || "").trim() || answer;
    } catch (error) {
      console.error("Cloud Vision model failed");
      visionError = "Chưa gọi được Vision LLM; phần bên dưới chỉ là nhận diện vật thể.";
    }
  }
  await env.DB.prepare(
    "INSERT INTO history(user_id, question, answer, labels_json, created_at) VALUES(?,?,?,?,?)",
  ).bind(user.id, question, answer, JSON.stringify(labels), new Date().toISOString()).run();
  return json({
    answer,
    detections,
    detector_provider: detectionResult.provider,
    detector_model: detectionResult.model,
    vision_used: Boolean(question && !visionError),
    vision_provider: question && !visionError ? assistantConfig.provider : null,
    vision_model: question && !visionError ? assistantConfig.model_name : null,
    vision_error: visionError,
    distance_m: null,
    distance_source: "unavailable",
    navigation_range_m: null,
    navigation_status: "not_evaluated_without_depth",
    image_saved: false,
  });
}

async function detectImage(request, env) {
  let form;
  try { form = await request.formData(); } catch { return badRequest("Request camera không hợp lệ."); }
  const pathKeys = new Set(["path_stream_id", "path_frame_id", "path_timestamp_ms", "path_frame_age_ms"]);
  const keys = Array.from(form.keys());
  const suppliedPathKeys = keys.filter((key) => pathKeys.has(key));
  if (keys.some((key) => key !== "image" && !pathKeys.has(key))
      || (suppliedPathKeys.length !== 0 && suppliedPathKeys.length !== pathKeys.size)) {
    return badRequest("Metadata khung hình path không hợp lệ.");
  }
  let pathMetadata = null;
  if (suppliedPathKeys.length) {
    pathMetadata = {
      stream_id: form.get("path_stream_id"),
      frame_id: boundedIntegerField(form, "path_frame_id", Number.MAX_SAFE_INTEGER),
      timestamp_ms: boundedIntegerField(form, "path_timestamp_ms", Number.MAX_SAFE_INTEGER),
      frame_age_ms: boundedIntegerField(form, "path_frame_age_ms", 60_000),
    };
    if (typeof pathMetadata.stream_id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(pathMetadata.stream_id)
        || pathMetadata.frame_id === null || pathMetadata.timestamp_ms === null || pathMetadata.frame_age_ms === null) {
      return badRequest("Metadata khung hình path không hợp lệ.");
    }
  }
  const image = form.get("image");
  if (!(image instanceof File) || keys.filter((key) => key === "image").length !== 1) return badRequest("Không nhận được khung hình camera.");
  if (image.size === 0 || image.size > MAX_IMAGE_BYTES) return badRequest("Khung hình camera không hợp lệ hoặc quá lớn.", 413);
  const started = performance.now();
  try {
    const detectionResult = await modelHostDetections(
      env, new Uint8Array(await image.arrayBuffer()), image.type || "image/jpeg", pathMetadata,
    );
    const response = {
      detections: detectionResult.detections,
      detector_provider: detectionResult.provider,
      detector_model: detectionResult.model,
      inference_ms: detectionResult.inference_ms ?? Math.round(performance.now() - started),
      hazard_zones: null,
      distance_m: null,
      distance_source: "unavailable",
      navigation_range_m: null,
      navigation_status: "not_evaluated_without_depth",
      image_saved: false,
    };
    if (pathMetadata) response.path_result = safeInlinePathResult(
      detectionResult.path_result || { state: "unknown", valid: false, reason: "path_unavailable" }, pathMetadata,
    );
    return json(response);
  } catch (error) {
    console.error("Configured live detection failed");
    return badRequest("Model nhận diện chưa trả kết quả. Đang chờ lần thử tiếp theo.", 503);
  }
}

async function transcribe(request, env) {
  const form = await request.formData();
  const audio = form.get("audio");
  if (!(audio instanceof File)) return badRequest("Không nhận được đoạn ghi âm.");
  if (audio.size === 0) return badRequest("Đoạn ghi âm đang trống.");
  if (audio.size > MAX_AUDIO_BYTES) return badRequest("Đoạn ghi âm quá dài. Bạn thử nói ngắn hơn nhé.", 413);

  if (env.ELEVENLABS_API_KEY) {
    try {
      const audioType = (audio.type || "").toLowerCase();
      const fileName = audio.name && /\.[a-z0-9]{2,5}$/i.test(audio.name)
        ? audio.name
        : audioType.includes("mp4") || audioType.includes("m4a") ? "question.m4a"
          : audioType.includes("wav") ? "question.wav"
            : audioType.includes("mpeg") || audioType.includes("mp3") ? "question.mp3"
              : audioType.includes("ogg") ? "question.ogg" : "question.webm";
      const file = new File([await audio.arrayBuffer()], fileName, {
        type: audio.type || "audio/webm",
      });
      const transcriptionForm = new FormData();
      transcriptionForm.set("file", file);
      transcriptionForm.set("model_id", "scribe_v2");
      transcriptionForm.set("language_code", "vie");
      transcriptionForm.set("tag_audio_events", "false");
      const providerResponse = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
        body: transcriptionForm,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (!providerResponse.ok) throw new Error(`ElevenLabs transcription rejected with ${providerResponse.status}`);
      const result = await providerResponse.json();
      const text = String(result?.text || "").trim();
      if (!text) throw new Error("ElevenLabs transcription returned an empty transcript");
      return json({ text, transcription_provider: "elevenlabs", transcription_model: "scribe_v2" });
    } catch (error) {
      console.error("ElevenLabs transcription failed");
      return badRequest("ElevenLabs chưa phiên âm được đoạn ghi âm. Kiểm tra API key/quota rồi thử lại nhé.", 502);
    }
  }

  if (env.OPENAI_API_KEY) {
    try {
      const openAiForm = new FormData();
      const audioType = (audio.type || "").toLowerCase();
      const fileName = audio.name && /\.[a-z0-9]{2,5}$/i.test(audio.name)
        ? audio.name
        : audioType.includes("mp4") || audioType.includes("m4a") ? "question.m4a"
          : audioType.includes("wav") ? "question.wav"
            : audioType.includes("mpeg") || audioType.includes("mp3") ? "question.mp3"
              : audioType.includes("ogg") ? "question.ogg" : "question.webm";
      openAiForm.set("file", new File([await audio.arrayBuffer()], fileName, {
        type: audio.type || "audio/webm",
      }));
      openAiForm.set("model", OPENAI_TRANSCRIPTION_MODEL);
      openAiForm.set("response_format", "json");
      openAiForm.set("prompt", TRANSCRIPTION_PROMPT);
      openAiForm.append("languages[]", "vi");
      for (const keyword of TRANSCRIPTION_KEYWORDS) openAiForm.append("keywords[]", keyword);

      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: openAiForm,
      });
      if (!response.ok) throw new Error(`OpenAI transcription returned ${response.status}`);
      const result = await response.json();
      const text = String(result?.text || "").trim();
      if (!text) throw new Error("OpenAI transcription returned an empty transcript");
      return json({
        text,
        transcription_provider: "openai",
        transcription_model: OPENAI_TRANSCRIPTION_MODEL,
      });
    } catch (error) {
      console.error("Preferred speech transcription failed; trying Workers AI fallback");
    }
  }

  try {
    // Workers AI's Whisper binding accepts audio as base64 (or binary). Send
    // base64 rather than a JSON number array: the latter expands each audio
    // byte into several characters and is rejected for larger browser clips.
    const audioBytes = new Uint8Array(await audio.arrayBuffer());
    const result = await env.AI.run(ASR_MODEL, {
      audio: base64(audioBytes),
      language: "vi",
      task: "transcribe",
      initial_prompt: TRANSCRIPTION_PROMPT,
    });
    const text = String(result?.text || result?.transcription_info?.text || "").trim();
    return json({
      text,
      transcription_provider: "cloudflare",
      transcription_model: ASR_MODEL,
      fallback_used: Boolean(env.OPENAI_API_KEY),
    });
  } catch (error) {
    console.error("Cloud speech transcription failed", {
      model: ASR_MODEL,
      audio_type: audio.type || "unknown",
      audio_size: audio.size,
      error: "transcription_failed",
    });
    return badRequest("Máy chủ chưa phiên âm được đoạn ghi âm. Bạn thử lại; nếu vẫn lỗi, hãy kiểm tra cấu hình phiên âm trên cloud.", 502);
  }
}

async function synthesizeVoice(request, env) {
  const user = await requireUser(request, env);
  if (!user) return badRequest("Phiên đăng nhập đã hết hạn. Đăng nhập lại nhé.", 401);
  const endpoint = String(env.VIENEU_TTS_ENDPOINT || "").trim();
  if (!endpoint || !env.VIENEU_TTS_SHARED_TOKEN) {
    return badRequest("VieNeu-TTS tự host chưa sẵn sàng. Máy chủ cần endpoint HTTPS và token dịch vụ.", 503);
  }
  const body = await readJson(request);
  const text = String(body?.text || "").trim();
  if (!text) return badRequest("Chưa có nội dung để đọc.");
  if (text.length > 1800) return badRequest("Đoạn đọc quá dài.", 413);
  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.VIENEU_TTS_SHARED_TOKEN}`,
      },
      body: JSON.stringify({
        model: "vieneu-v3-turbo",
        input: text,
        voice: env.VIENEU_TTS_VOICE || DEFAULT_VIENEU_TTS_VOICE,
        response_format: "wav",
      }),
    });
    if (!upstream.ok) {
      const status = upstream.status;
      console.error("VieNeu-TTS host rejected synthesis", { status });
      const message = status === 429
        ? "VieNeu-TTS đang bận; thử lại sau một chút nhé."
        : status === 401 || status === 403
          ? "Token dịch vụ tới gateway VieNeu-TTS không hợp lệ."
          : status === 503 || status === 502
            ? "Máy chủ VieNeu-TTS hiện chưa sẵn sàng."
            : "VieNeu-TTS chưa tạo được audio cho câu trả lời này.";
      return badRequest(message, 502);
    }
    const contentType = upstream.headers.get("content-type") || "audio/wav";
    if (!contentType.toLowerCase().startsWith("audio/")) {
      console.error("VieNeu-TTS returned a non-audio response", { contentType });
      return badRequest("VieNeu-TTS trả về định dạng audio không hợp lệ.", 502);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Voice-Provider": "vieneu_self_hosted",
        "X-Voice-Model": "vieneu-v3-turbo",
      },
    });
  } catch (error) {
    console.error("VieNeu-TTS host request failed");
    return badRequest("Không kết nối được máy chủ VieNeu-TTS tự host.", 502);
  }
}

function voiceRealtimeConfigured(env) {
  return Boolean(env.AI && typeof env.AI.run === "function");
}

function voiceTtsConfigured(env) {
  return Boolean(env.VIENEU_TTS_ENDPOINT && env.VIENEU_TTS_SHARED_TOKEN);
}

async function loadRecentAssistantMessages(env, userId) {
  const maxMessages = Math.max(2, ASSISTANT_PROFILE.generation.voice_history_messages);
  const maxPairs = Math.ceil(maxMessages / 2);
  try {
    const result = await env.DB.prepare(
      "SELECT question, answer FROM history WHERE user_id=? AND question<>'' ORDER BY id DESC LIMIT ?",
    ).bind(userId, maxPairs).all();
    const rows = Array.isArray(result?.results) ? result.results.slice().reverse() : [];
    return rows.flatMap((row) => {
      const question = String(row?.question || "").trim().slice(0, 600);
      const answer = String(row?.answer || "").trim().slice(0, 600);
      return question && answer
        ? [{ role: "user", content: question }, { role: "assistant", content: answer }]
        : [];
    }).slice(-maxMessages);
  } catch (error) {
    console.error("Could not load recent assistant context");
    return [];
  }
}

async function handleBrowserVoiceTurn(request, env, user) {
  const assistantConfig = await readAssistantModelConfig(env);
  if (assistantConfig.provider === "cloudflare" && !env.AI) return badRequest("Model trả lời trên cloud chưa sẵn sàng.", 503);
  if (assistantConfig.provider === "openai" && !await openAiAssistantKey(env, assistantConfig).catch(() => "")) return badRequest("Chưa có OpenAI API key. Mở Cài đặt AI nâng cao để cấu hình.", 503);
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > 600_000) {
    return badRequest("Khung hình gửi cùng câu nói quá lớn.", 413);
  }

  const form = await request.formData();
  const spatialContext = sanitizePhoneSpatialContext(form.get("spatial_context"));
  const spatialNote = describePhoneSpatialContext(spatialContext);
  const transcript = String(form.get("text") || "").trim().slice(0, 400);
  if (!transcript) return badRequest("Mình chưa nhận được câu bạn vừa nói.");

  let previousMessages = [];
  try {
    const parsed = JSON.parse(String(form.get("history") || "[]"));
    if (Array.isArray(parsed)) {
      previousMessages = parsed.slice(-ASSISTANT_PROFILE.generation.voice_history_messages).flatMap((item) => {
        if (!item || !["user", "assistant"].includes(item.role)) return [];
        const content = String(item.content || "").trim().slice(0, 600);
        return content ? [{ role: item.role, content }] : [];
      });
    }
  } catch {
    previousMessages = [];
  }
  if (previousMessages.length === 0) {
    previousMessages = await loadRecentAssistantMessages(env, user.id);
  }

  const image = form.get("image");
  let imageDataUrl = null;
  if (image instanceof File) {
    if (image.size === 0 || image.size > 240_000) return badRequest("Ảnh thoại quá lớn; thử lại nhé.", 413);
    imageDataUrl = "data:" + (image.type || "image/jpeg") + ";base64," + base64(new Uint8Array(await image.arrayBuffer()));
  }
  const userContent = imageDataUrl
    ? [
        { type: "text", text: transcript + (spatialNote ? "\n\n" + spatialNote : "") },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ]
    : transcript + (spatialNote ? "\n\n" + spatialNote : "");

  let modelStream;
  try {
    modelStream = await callAssistantModel(env, assistantConfig, {
      messages: [
        { role: "system", content: VOICE_INSTRUCTIONS },
        ...previousMessages,
        { role: "user", content: userContent },
      ],
      max_completion_tokens: ASSISTANT_PROFILE.generation.cloud_voice_max_tokens,
      temperature: ASSISTANT_PROFILE.generation.voice_temperature,
      reasoning_effort: "low",
      stream: true,
    });
  } catch (error) {
    console.error("Browser voice model request failed");
    return badRequest("Mô hình trợ lý chưa trả lời được. Kiểm tra cấu hình trong Cài đặt AI nâng cao rồi thử lại.", 503);
  }

  const encoder = new TextEncoder();
  let activeReader = null;
  let cancelled = false;
  const eventStream = new ReadableStream({
    async start(controller) {
      let answer = "";
      const emit = (payload) => {
        if (cancelled) return;
        try { controller.enqueue(encoder.encode("data: " + JSON.stringify(payload) + "\n\n")); } catch {}
      };
      emit({ type: "context", turns: Math.floor(previousMessages.length / 2) });
      const addText = (text) => {
        if (typeof text !== "string" || !text) return;
        answer += text;
        emit({ type: "delta", text });
      };
      const consumeLine = (line) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        try {
          const event = JSON.parse(data);
          const delta = event.choices?.[0]?.delta?.content ?? event.response ?? "";
          if (typeof delta === "string") addText(delta);
        } catch {
          // Ignore incomplete or non-JSON stream chunks.
        }
      };

      try {
        if (modelStream && typeof modelStream.getReader === "function") {
          const reader = modelStream.getReader();
          activeReader = reader;
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            if (cancelled) break;
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            lines.forEach(consumeLine);
          }
          buffer += decoder.decode();
          if (!cancelled && buffer.trim()) consumeLine(buffer.trim());
        } else {
          addText(String(modelStream?.response || modelStream?.choices?.[0]?.message?.content || "").trim());
        }

        if (cancelled) return;
        if (!answer.trim()) answer = "Mình chưa nghe rõ, bạn nói lại giúp mình nhé.";
        try {
          await env.DB.prepare(
            "INSERT INTO history(user_id, question, answer, labels_json, created_at) VALUES(?,?,?,?,?)",
          ).bind(user.id, transcript, answer, "[]", new Date().toISOString()).run();
        } catch (error) {
          console.error("Could not save browser voice history");
        }
        emit({ type: "done", text: answer });
      } catch (error) {
        console.error("Browser voice stream failed");
        if (!cancelled) emit({ type: "error", message: "Mình chưa trả lời xong lượt này. Bạn thử nói lại nhé." });
      } finally {
        activeReader = null;
        if (!cancelled) controller.close();
      }
    },
    cancel(reason) {
      cancelled = true;
      if (activeReader) void activeReader.cancel(reason).catch(() => {});
    },
  });
  return new Response(eventStream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

function sendVoiceMessage(socket, payload) {
  try {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function isActiveVoiceReply(state, replyId) {
  return !state.closing && state.activeReplyId === replyId && state.replySequence === replyId;
}

function interruptAssistantReply(socket, state, reason = "barge-in") {
  if (!state.assistantOutputActive && !state.activeReplyInProgress) return false;
  const replyId = state.activeReplyId;
  state.replySequence += 1;
  state.activeReplyId = null;
  state.activeReplyInProgress = false;
  state.assistantOutputActive = false;
  const reader = state.activeReplyReader;
  state.activeReplyReader = null;
  if (reader) void reader.cancel(reason).catch(() => {});
  if (replyId !== null && !state.closing) {
    sendVoiceMessage(socket, { type: "assistant_interrupted", reply_id: replyId });
  }
  return true;
}

async function streamAssistantReply(socket, env, state, transcript) {
  const replyId = ++state.replySequence;
  state.activeReplyId = replyId;
  state.activeReplyInProgress = true;
  state.assistantOutputActive = true;
  const currentSpatialContext = state.lastSpatialContext
    && Date.now() - state.lastSpatialContextAt < 5_000
    ? describePhoneSpatialContext(state.lastSpatialContext)
    : "";
  const parts = [{ type: "text", text: transcript + (currentSpatialContext ? "\n\n" + currentSpatialContext : "") }];
  if (state.lastImageDataUrl && Date.now() - state.lastImageAt < 5000) {
    parts.push({ type: "image_url", image_url: { url: state.lastImageDataUrl } });
  }
  state.messages.push({ role: "user", content: parts });
  state.messages = [state.messages[0], ...state.messages.slice(-ASSISTANT_PROFILE.generation.voice_history_messages)];
  sendVoiceMessage(socket, { type: "assistant_start", reply_id: replyId });
  let answer = "";
  let reader = null;
  try {
    const assistantConfig = await readAssistantModelConfig(env);
    const result = await callAssistantModel(env, assistantConfig, {
      messages: state.messages,
      max_completion_tokens: ASSISTANT_PROFILE.generation.cloud_voice_max_tokens,
      temperature: ASSISTANT_PROFILE.generation.voice_temperature,
      reasoning_effort: "low",
      stream: true,
    });
    if (!isActiveVoiceReply(state, replyId)) {
      try { await result?.cancel?.("voice reply interrupted"); } catch {}
      return;
    }
    if (result && typeof result.getReader === "function") {
      reader = result.getReader();
      state.activeReplyReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!isActiveVoiceReply(state, replyId)) {
          try { await reader.cancel("voice reply interrupted"); } catch {}
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const event = JSON.parse(data);
            const delta = event.choices?.[0]?.delta?.content || event.response || "";
            if (typeof delta === "string" && delta) {
              answer += delta;
              sendVoiceMessage(socket, { type: "assistant_delta", reply_id: replyId, text: delta });
            }
          } catch {
            // Ignore incomplete or non-JSON stream chunks.
          }
        }
      }
      const tail = buffer.trim();
      if (tail.startsWith("data:") && tail.slice(5).trim() !== "[DONE]") {
        try {
          const event = JSON.parse(tail.slice(5).trim());
          const delta = event.choices?.[0]?.delta?.content || event.response || "";
          if (typeof delta === "string" && delta) {
            answer += delta;
            sendVoiceMessage(socket, { type: "assistant_delta", reply_id: replyId, text: delta });
          }
        } catch {
          // The final stream buffer may contain a partial event.
        }
      }
    } else {
      answer = String(result?.response || result?.choices?.[0]?.message?.content || "").trim();
      if (answer) sendVoiceMessage(socket, { type: "assistant_delta", reply_id: replyId, text: answer });
    }
    if (!isActiveVoiceReply(state, replyId)) return;
    if (!answer.trim()) answer = "Mình chưa nghe rõ, bạn nói lại giúp mình nhé.";
    state.messages.push({ role: "assistant", content: answer });
    state.messages = [state.messages[0], ...state.messages.slice(-ASSISTANT_PROFILE.generation.voice_history_messages)];
    state.activeReplyInProgress = false;
    sendVoiceMessage(socket, { type: "assistant_done", reply_id: replyId, text: answer });
    try {
      await env.DB.prepare(
        "INSERT INTO history(user_id, question, answer, labels_json, created_at) VALUES(?,?,?,?,?)",
      ).bind(state.userId, transcript, answer, "[]", new Date().toISOString()).run();
    } catch (error) {
      console.error("Could not save cloud voice history");
    }
  } catch (error) {
    if (!isActiveVoiceReply(state, replyId)) return;
    console.error("Cloud voice response failed");
    state.activeReplyInProgress = false;
    state.assistantOutputActive = false;
    state.activeReplyId = null;
    sendVoiceMessage(socket, { type: "turn_error", message: "Mình chưa trả lời được lượt này. Bạn thử nói lại nhé." });
  } finally {
    if (state.activeReplyReader === reader) state.activeReplyReader = null;
  }
}

async function openNova3Transcriber(env) {
  if (env.ELEVENLABS_API_KEY) {
    const url = new URL("https://api.elevenlabs.io/v1/speech-to-text/realtime");
    url.searchParams.set("model_id", "scribe_v2_realtime");
    url.searchParams.set("audio_format", "pcm_16000");
    url.searchParams.set("language_code", "vie");
    url.searchParams.set("commit_strategy", "vad");
    url.searchParams.set("filter_background_audio", "true");
    url.searchParams.set("vad_threshold", "0.55");
    url.searchParams.set("vad_silence_threshold_secs", "0.55");
    url.searchParams.set("min_speech_duration_ms", "350");
    url.searchParams.set("min_silence_duration_ms", "200");
    const response = await fetch(url, {
      headers: { Upgrade: "websocket", "xi-api-key": env.ELEVENLABS_API_KEY },
    });
    if (response.status !== 101 || !response.webSocket) {
      const detail = (await response.text().catch(() => "")).slice(0, 240);
      throw new Error(`ElevenLabs Scribe realtime did not return a WebSocket. HTTP ${response.status}: ${detail}`);
    }
    response.webSocket.binaryType = "arraybuffer";
    response.webSocket.accept();
    return response.webSocket;
  }
    const result = await env.AI.run(LIVE_TRANSCRIPTION_MODEL, {
    encoding: "linear16",
    sample_rate: "16000",
    language: "multi",
    interim_results: true,
    vad_events: true,
    endpointing: "350",
    smart_format: true,
    punctuate: true,
    keyterm: "ESP32-S3",
  }, { websocket: true });
  if (!result?.webSocket) {
    const detail = result instanceof Response && result.status !== 101
      ? ` HTTP ${result.status}: ${(await result.clone().text().catch(() => "")).slice(0, 240)}`
      : "";
    throw new Error(`Workers AI ${LIVE_TRANSCRIPTION_MODEL} did not return a WebSocket.${detail}`);
  }
  result.webSocket.binaryType = "arraybuffer";
  result.webSocket.accept();
  return result.webSocket;
}

async function handleVoiceSocket(request, env) {
  if (!requestIsSameOrigin(request)) return badRequest("Nguồn yêu cầu chưa được xác nhận.", 403);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return badRequest("Cần kết nối WebSocket.", 426);
  if (!voiceRealtimeConfigured(env)) return badRequest("Nhận giọng nói realtime trên Cloudflare chưa sẵn sàng.", 503);
  const user = await requireUser(request, env);
  if (!user) return badRequest("Phiên đăng nhập đã hết hạn. Đăng nhập lại nhé.", 401);
  const recentMessages = await loadRecentAssistantMessages(env, user.id);
  const assistantConfig = await readAssistantModelConfig(env);
  if (assistantConfig.provider === "openai" && !await openAiAssistantKey(env, assistantConfig).catch(() => "")) {
    return badRequest("GPT-6 Luna chưa được cấu hình. Mở Cài đặt AI nâng cao để nhập OpenAI API key.", 503);
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.binaryType = "arraybuffer";
  server.accept({ allowHalfOpen: true });
  const state = {
    userId: user.id,
    upstream: null,
    messages: [{ role: "system", content: VOICE_INSTRUCTIONS }, ...recentMessages],
    lastImageDataUrl: null,
    lastImageAt: 0,
    lastSpatialContext: null,
    lastSpatialContextAt: 0,
    finalParts: [],
    opened: false,
    closing: false,
    audioBytes: 0,
    startedAt: Date.now(),
    replySequence: 0,
    activeReplyId: null,
    activeReplyReader: null,
    activeReplyInProgress: false,
    assistantOutputActive: false,
  };
  const sendError = (message) => {
    try { server.send(JSON.stringify({ type: "voice_error", message })); } catch {}
  };

  const sessionTimer = setTimeout(() => {
    if (state.closing) return;
    state.closing = true;
    interruptAssistantReply(server, state, "session time limit");
    sendError("Phiên thoại đã đạt giới hạn 5 phút. Bạn có thể bắt đầu phiên mới.");
    try { state.upstream?.send(JSON.stringify({ type: "CloseStream" })); } catch {}
    try { state.upstream?.close(1000, "session time limit"); } catch {}
    try { server.close(1000, "session time limit"); } catch {}
  }, 5 * 60 * 1000);

  server.addEventListener("message", async (event) => {
    if (typeof event.data !== "string") {
      if (!state.upstream || state.upstream.readyState !== WebSocket.OPEN) return;
      const audioFrame = event.data && typeof event.data.arrayBuffer === "function"
        ? await event.data.arrayBuffer()
        : event.data;
      const frameBytes = audioFrame?.byteLength || 0;
      if (!frameBytes) return;
      state.audioBytes += frameBytes;
      if (state.audioBytes > 16000 * 2 * 60 * 5) {
        sendError("Đã hết thời lượng thoại miễn phí cho phiên này. Bắt đầu phiên mới nhé.");
        state.upstream.close(1000, "session audio limit");
        return;
      }
      try {
        if (env.ELEVENLABS_API_KEY) {
          state.upstream.send(JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: base64(new Uint8Array(audioFrame)),
          }));
        } else {
          state.upstream.send(audioFrame);
        }
      } catch { sendError("Mất kết nối tới dịch vụ nghe."); }
      return;
    }
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "start" && !state.opened) {
      state.opened = true;
      try {
        state.upstream = await openNova3Transcriber(env);
        if (state.closing) {
          try { state.upstream.close(1000, "client disconnected during startup"); } catch {}
          return;
        }
        state.upstream.addEventListener("message", async (upstreamEvent) => {
          if (typeof upstreamEvent.data !== "string") return;
          let payload;
          try { payload = JSON.parse(upstreamEvent.data); } catch { return; }
          if (env.ELEVENLABS_API_KEY) {
            if (payload.message_type === "session_started") {
              server.send(JSON.stringify({
                type: "session_ready",
                language: "vi",
                stt_model: "scribe_v2_realtime",
                llm_model: assistantConfig.model_name,
                assistant_profile_version: ASSISTANT_PROFILE.version,
                context_turns_loaded: Math.floor(recentMessages.length / 2),
              }));
              return;
            }
            if (payload.message_type === "partial_transcript") {
              const text = String(payload.text || "").trim();
              if (text) server.send(JSON.stringify({ type: "transcript", text, final: false }));
              return;
            }
            if (payload.message_type === "committed_transcript") {
              const utterance = String(payload.text || "").trim();
              if (!utterance) return;
              server.send(JSON.stringify({ type: "transcript", text: utterance, final: true }));
              interruptAssistantReply(server, state, "new user turn");
              await streamAssistantReply(server, env, state, utterance);
              return;
            }
            if (payload.message_type === "error" || payload.message_type === "rate_limited") {
              sendError("ElevenLabs Scribe gặp lỗi hoặc hết giới hạn lượt dùng.");
              try { server.close(1011, "speech provider error"); } catch {}
            }
            return;
          }
          if (payload.type !== "Results") {
            if (payload.type === "ConfigureFailure") {
              console.warn("Nova-3 rejected the streaming vocabulary update; continuing with its initial term");
              return;
            }
            if (payload.type === "Error" || payload.error) {
              sendError("Dịch vụ nhận giọng nói gặp lỗi. Bạn thử lại sau nhé.");
              try { server.close(1011, "speech provider error"); } catch {}
            }
            return;
          }
          const transcript = payload.channel?.alternatives?.[0]?.transcript;
          if (typeof transcript !== "string" || !transcript.trim()) return;
          const clean = transcript.trim();
          const isFinal = payload.is_final === true;
          const speechFinal = payload.speech_final === true;
          const candidate = [...state.finalParts, clean].join(" ").trim();
          const wordCount = candidate.split(/\s+/).filter(Boolean).length;
          if (state.assistantOutputActive && (wordCount >= 2 || (speechFinal && wordCount >= 1))) {
            interruptAssistantReply(server, state, "user started speaking");
          }
          if (isFinal && !speechFinal) state.finalParts.push(clean);
          const interimText = [...state.finalParts, ...(isFinal && speechFinal ? [clean] : isFinal ? [] : [clean])].join(" ").trim();
          server.send(JSON.stringify({ type: "transcript", text: interimText, final: speechFinal }));
          if (speechFinal) {
            const utterance = [...state.finalParts, clean].join(" ").trim();
            state.finalParts = [];
            interruptAssistantReply(server, state, "new user turn");
            if (utterance) await streamAssistantReply(server, env, state, utterance);
          }
        });
        state.upstream.addEventListener("error", () => {
          if (state.closing) return;
          sendError("Mất kết nối tới dịch vụ nghe cloud.");
          try { server.close(1011, "speech stream failed"); } catch {}
        });
        state.upstream.addEventListener("close", () => {
          if (!state.closing) {
            sendError("Kết nối thoại đã đóng. Bạn có thể bắt đầu phiên mới.");
            try { server.close(1011, "speech stream closed"); } catch {}
          }
        });
        if (!env.ELEVENLABS_API_KEY) {
          try {
            state.upstream.send(JSON.stringify({ type: "Configure", keyterms: TRANSCRIPTION_KEYWORDS }));
          } catch (error) {
            console.warn("Nova-3 vocabulary update could not be sent; continuing with its initial term");
          }
        }
        if (!env.ELEVENLABS_API_KEY) {
          server.send(JSON.stringify({
            type: "session_ready",
            language: "multi",
            stt_model: LIVE_TRANSCRIPTION_MODEL,
            llm_model: assistantConfig.model_name,
            assistant_profile_version: ASSISTANT_PROFILE.version,
            context_turns_loaded: Math.floor(recentMessages.length / 2),
          }));
        }
      } catch (error) {
        console.error("Workers AI realtime speech failed");
        sendError("Chưa mở được luồng nghe tiếng Việt trên Cloudflare. App sẽ chuyển sang chế độ dự phòng.");
        server.close(1011, "speech gateway unavailable");
      }
      return;
    }
    if (message.type === "frame") {
      const data = typeof message.data === "string" ? message.data : "";
      if (data.startsWith("data:image/jpeg;base64,") && data.length < 500000) {
        state.lastImageDataUrl = data;
        state.lastImageAt = Date.now();
        state.lastSpatialContext = sanitizePhoneSpatialContext(message.spatial_context);
        state.lastSpatialContextAt = Date.now();
      }
      return;
    }
    if (message.type === "assistant_playback_done") {
      if (Number(message.reply_id) === state.activeReplyId) {
        state.assistantOutputActive = false;
        state.activeReplyId = null;
      }
      return;
    }
    if (message.type === "stop") {
      state.closing = true;
      interruptAssistantReply(server, state, "user ended session");
      try {
        if (state.upstream?.readyState === WebSocket.OPEN) {
          state.upstream.send(JSON.stringify({ type: "CloseStream" }));
        }
      } catch {}
      setTimeout(() => {
        try { state.upstream?.close(1000, "user ended session"); } catch {}
        try { server.close(1000, "conversation ended"); } catch {}
      }, 900);
    }
  });

  server.addEventListener("close", () => {
    clearTimeout(sessionTimer);
    state.closing = true;
    interruptAssistantReply(server, state, "client disconnected");
    try { state.upstream?.close(1000, "client disconnected"); } catch {}
  });
  server.addEventListener("error", () => {
    clearTimeout(sessionTimer);
    state.closing = true;
    try { state.upstream?.close(1011, "client socket error"); } catch {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method !== "GET" && method !== "HEAD" && !requestIsSameOrigin(request)) return badRequest("Nguồn yêu cầu chưa được xác nhận.", 403);

  if (path === "/api/status" && method === "GET") {
    const detectorConfig = await readModelHostConfig(env);
    const assistantConfig = await readAssistantModelConfig(env);
    const assistantKeyConfigured = assistantConfig.provider === "openai"
      && Boolean(assistantConfig.encrypted_api_key || env.OPENAI_API_KEY);
    const assistantReady = assistantConfig.provider === "cloudflare"
      ? Boolean(env.AI)
      : assistantKeyConfigured;
    const personalDetectorConfigured = detectorConfig.provider === "yolo_host"
      && Boolean(detectorConfig.endpoint_url && detectorConfig.encrypted_api_key);
    return json({
      app_name: APP_NAME,
      app_build: APP_BUILD,
      assistant_profile_version: ASSISTANT_PROFILE.version,
      shared_assistant_url: SHARED_RUNTIME.web_app_url,
      shared_assistant_model: assistantConfig.model_name,
      shared_history_store: SHARED_RUNTIME.history_store,
      shared_voice_audio_transport: SHARED_RUNTIME.audio_transport,
      shared_voice_speech_synthesis: voiceTtsConfigured(env) ? "vieneu_self_hosted" : SHARED_RUNTIME.speech_synthesis,
      detector_ready: personalDetectorConfigured || Boolean(env.AI),
      detector_model: personalDetectorConfigured ? "YOLO26n" : DETECTOR_MODEL,
      detector_target: personalDetectorConfigured
        ? "YOLO26n COCO-pretrained object classes; not fine-tuned or validated for stairs, sidewalk hazards, or safe-path decisions"
        : DETECTOR_TARGET,
      detector_provider: personalDetectorConfigured ? "yolo_host" : "cloudflare",
      detector_note: personalDetectorConfigured
        ? "URL và API key YOLO host đã lưu; kiểm tra kết nối và inference mẫu trong Cấu hình AI nâng cao."
        : env.AI ? "Workers AI binding đã được cấu hình; inference thực tế được xác nhận khi kiểm tra model hoặc gửi ảnh." : "Workers AI chưa được cấu hình.",
      vision_ready: assistantReady,
      vision_provider: assistantConfig.provider,
      vision_model: assistantConfig.model_name,
      local_vision_ready: false,
      openai_configured: Boolean(env.OPENAI_API_KEY || assistantConfig.encrypted_api_key),
      transcription_ready: Boolean(env.AI || env.OPENAI_API_KEY),
      transcription_model: env.ELEVENLABS_API_KEY ? "scribe_v2" : env.OPENAI_API_KEY ? OPENAI_TRANSCRIPTION_MODEL : ASR_MODEL,
      transcription_provider: env.ELEVENLABS_API_KEY ? "elevenlabs" : env.OPENAI_API_KEY ? "openai" : "cloudflare",
      transcription_fallback_model: env.OPENAI_API_KEY ? ASR_MODEL : null,
      transcription_live_recommended_model: LIVE_TRANSCRIPTION_MODEL,
      transcription_language: ASSISTANT_PROFILE.transcription.language,
      voice_realtime_configured: voiceRealtimeConfigured(env) && assistantReady,
      voice_realtime_ready: voiceRealtimeConfigured(env) && assistantReady,
      voice_browser_fallback_ready: Boolean(env.AI),
      voice_stt_model: voiceRealtimeConfigured(env) ? (env.ELEVENLABS_API_KEY ? "scribe_v2_realtime" : LIVE_TRANSCRIPTION_MODEL) : null,
      voice_realtime_model: voiceRealtimeConfigured(env) ? (env.ELEVENLABS_API_KEY ? "scribe_v2_realtime" : LIVE_TRANSCRIPTION_MODEL) : null,
      voice_realtime_provider: voiceRealtimeConfigured(env) ? (env.ELEVENLABS_API_KEY ? "elevenlabs" : "cloudflare_workers_ai") : null,
      voice_language_mode: voiceRealtimeConfigured(env) ? (env.ELEVENLABS_API_KEY ? "vietnamese" : "multilingual_auto_detect") : null,
      voice_tts_ready: voiceTtsConfigured(env),
      voice_tts_provider: voiceTtsConfigured(env) ? "vieneu_self_hosted" : null,
      voice_tts_model: voiceTtsConfigured(env) ? "vieneu-v3-turbo" : null,
      voice_tts_note: voiceTtsConfigured(env)
        ? `TTS chạy trên máy chủ VieNeu-TTS tự host; giọng ${env.VIENEU_TTS_VOICE || DEFAULT_VIENEU_TTS_VOICE}.`
        : "VieNeu-TTS tự host chưa được nối. Cần endpoint HTTPS và token dịch vụ ở phía máy chủ.",
      voice_assistant_model: assistantReady ? assistantConfig.model_name : null,
      voice_assistant_provider: assistantReady ? assistantConfig.provider : null,
      voice_browser_stt_model: "Safari/iOS Speech Recognition",
      voice_realtime_note: env.ELEVENLABS_API_KEY
        ? "ElevenLabs Scribe v2 realtime nhận âm thanh trên máy chủ; nếu realtime lỗi, app gửi đoạn ghi âm tới Scribe v2 trên máy chủ."
        : voiceRealtimeConfigured(env)
          ? "Workers AI Nova-3 nhận âm thanh trên máy chủ; khi realtime lỗi, app dùng phiên âm máy chủ. Có thể cấu hình riêng ElevenLabs Scribe cho STT mà không đổi nhà cung cấp TTS."
          : "Chưa có STT realtime trên máy chủ. Trình duyệt không tự chọn model nhận dạng giọng nói riêng.",      registration_code_required: Boolean(env.REGISTRATION_CODE),
      lidar_available: false,
      lidar_note: "LiDAR/ARKit chỉ có trong app iOS native; bản PWA không đọc được sceneDepth.",
      images_saved: false,
    });
  }
  if (path === "/api/auth/register" && method === "POST") return handleRegister(request, env);
  if (path === "/api/auth/login" && method === "POST") return handleLogin(request, env);
  if (path === "/api/auth/logout" && method === "POST") return handleLogout(request, env);
  if (path === "/api/auth/me" && method === "GET") {
    const user = await requireUser(request, env);
    return user ? json({ user: userPayload(user), profile: profilePayload(user) }) : badRequest("Chưa đăng nhập.", 401);
  }
  if (path.startsWith("/api/voice/") && method === "GET") return handleVoiceSocket(request, env);
  if (path === "/api/device/telemetry" && method === "POST") return handleDeviceTelemetry(request, env);
  if (path === "/api/device/claim/redeem" && method === "POST") return redeemDeviceClaim(request, env);
  if (path === "/api/device/event" && method === "POST") return handleDeviceEvent(request, env);
  if (path === "/api/device/button" && method === "POST") return handleDeviceButtonEvent(request, env);

  const user = await requireUser(request, env);
  if (!user) return badRequest("Chưa đăng nhập.", 401);
  if (path === "/api/segmentation-settings" && ["GET", "PUT", "POST"].includes(method)) return handleSegmentationSettings(request, env, user);
  if (path === "/api/segmentation/health" && method === "GET") return segmentationHealth(env);
  if (path === "/api/segmentation/infer" && method === "POST") return inferSegmentation(request, env);
  if (path === "/api/model-settings" && ["GET", "PUT", "POST"].includes(method)) return handleModelSettings(request, env, user);
  if (path === "/api/assistant-model-settings" && ["GET", "PUT", "POST"].includes(method)) return handleAssistantModelSettings(request, env, user);
  if (path === "/api/analyze" && method === "POST") return analyzeImage(request, env, user);
  if (path === "/api/detect" && method === "POST") return detectImage(request, env);
  if (path === "/api/path/health" && method === "GET") return modelHostPathHealth(env);
  if (path === "/api/path/detect" && method === "POST") return detectPathOccupancy(request, env);
  if (path === "/api/voice/turn" && method === "POST") return handleBrowserVoiceTurn(request, env, user);
  if (path === "/api/transcribe" && method === "POST") return transcribe(request, env);
  if (path === "/api/voice/synthesize" && method === "POST") return synthesizeVoice(request, env);
  if (path === "/api/profile" && method === "GET") return json({ profile: profilePayload(user) });
  if (path === "/api/profile" && method === "PUT") {
    const body = await readJson(request);
    if (!body) return badRequest("Cài đặt chưa hợp lệ.");
    const textScale = Math.max(0.9, Math.min(1.3, Number(body.text_scale ?? user.text_scale)));
    const voiceRate = Math.max(0.75, Math.min(1.15, Number(body.voice_rate ?? user.voice_rate)));
    const displayName = String(body.display_name ?? user.display_name).trim().slice(0, 50) || user.display_name;
    if (!Number.isFinite(textScale) || !Number.isFinite(voiceRate)) return badRequest("Cài đặt chưa hợp lệ.");
    await env.DB.prepare(
      "UPDATE users SET display_name=?, text_scale=?, high_contrast=?, speak_answers=?, voice_rate=? WHERE id=?",
    ).bind(displayName, textScale, body.high_contrast ? 1 : 0, body.speak_answers ? 1 : 0, voiceRate, user.id).run();
    const updated = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first();
    return json({ profile: profilePayload(updated) });
  }
  if (path === "/api/history" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT id, question, answer, labels_json, created_at FROM history WHERE user_id=? ORDER BY id DESC LIMIT 100",
    ).bind(user.id).all();
    return json({
      items: (rows.results || []).map((row) => ({
        id: row.id,
        question: row.question,
        answer: row.answer,
        labels: JSON.parse(row.labels_json || "[]"),
        created_at: row.created_at,
      })),
    });
  }
  if (path === "/api/history" && method === "DELETE") {
    await env.DB.prepare("DELETE FROM history WHERE user_id=?").bind(user.id).run();
    return new Response(null, { status: 204 });
  }
  if (path === "/api/device/pair" && method === "POST") return handleDevicePair(request, env, user);
  if (path === "/api/device/unpair" && method === "POST") return handleDeviceUnpair(request, env, user);
  if (path === "/api/device/status" && method === "GET") return handleDeviceStatus(env, user);
  if (path === "/api/device/button/claim" && method === "POST") return handleDeviceButtonClaim(request, env, user);
  if (path === "/api/device/ask" && method === "POST") return handleCloudDeviceAsk(request, env, user);
  if (path.startsWith("/api/device/") && ["POST", "PUT"].includes(method)) {
    return badRequest("Bản cloud hiện chưa nối trực tiếp ESP32. Hãy dùng chế độ camera iPhone.", 409);
  }
  return badRequest("Không tìm thấy API.", 404);
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (error) {
        console.error("Cloud app request failed");
        return badRequest("Máy chủ cloud chưa xử lý được yêu cầu này. Thử lại sau nhé.", 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

