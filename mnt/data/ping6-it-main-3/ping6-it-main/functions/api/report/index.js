import { applyRateLimit } from "../_lib/rateLimit.js";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Keep aligned with front-end regexp: /^[A-Za-z0-9_-]{8,64}$/
const REPORT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const ALLOWED_HOSTNAMES = new Set(["ping6.it", "www.ping6.it", "ping6-it.pages.dev"]);

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function badRequest(error, message, params) {
  return json({ error, message, params }, 400);
}

function b64Url(bytes) {
  // bytes: Uint8Array
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  // btoa expects Latin-1.
  const b64 = btoa(s);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomId(byteLen = 12) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  const id = b64Url(bytes);
  // Safety: ensure it matches the front-end regexp.
  return REPORT_ID_RE.test(id) ? id : id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function verifyTurnstile({ request, secret, token, signal }) {
  const remoteip =
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0]?.trim() ||
    undefined;

  const fd = new FormData();
  fd.append("secret", secret);
  fd.append("response", token);
  if (remoteip) fd.append("remoteip", remoteip);

  const verifyRes = await fetch(SITEVERIFY_URL, { method: "POST", body: fd, signal });
  return await verifyRes.json();
}

function getReportsKv(env) {
  // Zero-config fallback: reuse ASN_META_KV if you don't want to create a dedicated namespace.
  return env?.REPORT_KV || env?.ASN_META_KV || null;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const secret = env.TURNSTILE_SECRET;
  if (!secret) return json({ error: "TURNSTILE_SECRET not set" }, 500);

  const kv = getReportsKv(env);
  if (!kv?.put || !kv?.get) {
    return json({ error: "REPORT_KV (or ASN_META_KV fallback) not bound" }, 501);
  }

  // Rate limit early.
  const rl = await applyRateLimit({ request, env, scope: "report_create", limit: 60, windowSec: 600 });
  if (rl.limited) return json({ error: "rate_limited", retryAfter: rl.retryAfterSec }, 429, rl.headers);

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid_json", "Invalid JSON body.", { hint: "Send a JSON object with turnstileToken and payload." });
  }

  const { turnstileToken, payload } = body || {};

  const missing = [];
  if (!turnstileToken) missing.push("turnstileToken");
  if (!payload) missing.push("payload");
  if (missing.length) {
    return badRequest("missing_fields", `Missing required field(s): ${missing.join(", ")}.`, { missing });
  }

  // Basic payload sanity. We store JSON as-is, but cap size to prevent abuse.
  if (typeof payload !== "object") {
    return badRequest("invalid_payload", "Invalid payload. Expected an object.", { typeof: typeof payload });
  }

  let payloadJson;
  try {
    payloadJson = JSON.stringify(payload);
  } catch {
    return badRequest("invalid_payload", "Invalid payload. Must be JSON-serializable.");
  }

  // Default TTL: 30 days.
  const ttlDays = clampInt(env.REPORT_TTL_DAYS, { min: 1, max: 365, fallback: 30 });
  const ttlSec = ttlDays * 24 * 60 * 60;

  // 64 KiB cap on serialized JSON.
  if (payloadJson.length > 65_536) {
    return badRequest("payload_too_large", "Payload too large.", { maxBytes: 65536, bytes: payloadJson.length });
  }

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();

  // Turnstile siteverify.
  const verify = await verifyTurnstile({ request, secret, token: turnstileToken, signal: request.signal });
  if (!verify?.success) {
    return json({ error: "turnstile_failed", codes: verify?.["error-codes"] || [] }, 403);
  }
  if (verify.action && verify.action !== "ping6_run") {
    return json({ error: "turnstile_bad_action", action: verify.action }, 403);
  }
  if (verify.hostname && !ALLOWED_HOSTNAMES.has(verify.hostname)) {
    return json({ error: "turnstile_bad_hostname", hostname: verify.hostname }, 403);
  }

  // Create ID and store.
  const id = randomId(12);
  const key = `__report:v1:${id}`;

  const value = {
    id,
    createdAt,
    expiresAt,
    payload,
  };

  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSec });
  } catch (e) {
    return json({ error: "kv_put_failed", message: String(e?.message || e || "kv_put_failed") }, 500);
  }

  return json({ id, createdAt, expiresAt }, 200);
}
