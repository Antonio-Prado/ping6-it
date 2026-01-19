import { applyRateLimit } from "./_lib/rateLimit.js";
import {
  sanitizeLocations,
  sanitizeMeasurementOptions,
  sanitizeTarget,
} from "./_lib/guardrails.js";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const GLOBALPING_URL = "https://api.globalping.io/v1/measurements";

const ALLOWED_TYPES = new Set(["ping", "traceroute", "mtr", "dns", "http"]);
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

function normalizeSameProbesAs(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.length > 128) return "";
  // Globalping measurement IDs are typically URL-safe strings.
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return "";
  return s;
}

async function postJson(url, payload, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error("Upstream error");
    err.status = res.status;

    // Prefer Retry-After, but support X-RateLimit-Reset (seconds) if present.
    const retryAfterHeader = res.headers.get("retry-after") || "";
    const rateLimitResetHeader = res.headers.get("x-ratelimit-reset") || "";
    const rateLimitResetSec = Number(rateLimitResetHeader);
    err.retryAfter = retryAfterHeader
      ? retryAfterHeader
      : Number.isFinite(rateLimitResetSec) && rateLimitResetSec > 0
        ? `${Math.ceil(rateLimitResetSec)}`
        : undefined;

    err.data = data;
    throw err;
  }

  return data;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const secret = env.TURNSTILE_SECRET;
  if (!secret) return json({ error: "TURNSTILE_SECRET not set" }, 500);

  // Rate limit early (before Turnstile verification) to protect upstream APIs.
  const rl = await applyRateLimit({ request, env, scope: "gp_single", limit: 30, windowSec: 600 });
  if (rl.limited) {
    return json({ error: "rate_limited", retryAfter: rl.retryAfterSec }, 429, rl.headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid_json", "Invalid JSON body.", {
      hint: "Send a JSON object with turnstileToken, base, measurementOptions, ipVersion, and optional sameProbesAs.",
    });
  }

  const { turnstileToken, base, measurementOptions, ipVersion, sameProbesAs } = body || {};

  const missing = [];
  if (!turnstileToken) missing.push("turnstileToken");
  if (!base) missing.push("base");
  if (!measurementOptions) missing.push("measurementOptions");
  if (!ipVersion) missing.push("ipVersion");
  if (missing.length) {
    return badRequest("missing_fields", `Missing required field(s): ${missing.join(", ")}.`, { missing });
  }

  const ipVer = Number(ipVersion);
  if (ipVer !== 4 && ipVer !== 6) {
    return badRequest("invalid_ip_version", 'Invalid "ipVersion". Expected 4 or 6.', { ipVersion, allowed: [4, 6] });
  }

  // Defensive validation / clamping to reduce abuse.
  if (!ALLOWED_TYPES.has(base.type)) {
    return badRequest("invalid_type", `Unsupported measurement type: ${String(base.type)}.`, {
      type: base.type,
      allowed: Array.from(ALLOWED_TYPES),
    });
  }
  if (typeof base.target !== "string" || !base.target.trim()) {
    return badRequest("invalid_target", 'Invalid "target". Expected a non-empty hostname/IP/URL string.', { target: base.target });
  }

  const targetCheck = sanitizeTarget({ type: base.type, target: base.target, allowIp: base.type === "dns" });
  if (!targetCheck.ok) {
    return badRequest(targetCheck.error || "invalid_target", targetCheck.message || "Invalid target.", { target: base.target });
  }

  const moCheck = sanitizeMeasurementOptions(base.type, measurementOptions, { backend: "globalping" });
  if (!moCheck.ok) {
    return badRequest(moCheck.error || "invalid_measurement_options", moCheck.message || "Invalid measurement options.", { measurementOptions });
  }

  const limit = Math.max(1, Math.min(10, Number(base.limit) || 3));

  const same = normalizeSameProbesAs(sameProbesAs);
  const locations = same ? same : sanitizeLocations(base.locations);
  const effectiveLocations = locations && (Array.isArray(locations) ? locations.length : true) ? locations : [{ magic: "world" }];

  // 1) Turnstile siteverify (server-side validation is mandatory).
  const remoteip =
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0]?.trim() ||
    undefined;

  const fd = new FormData();
  fd.append("secret", secret);
  fd.append("response", turnstileToken);
  if (remoteip) fd.append("remoteip", remoteip);

  const verifyRes = await fetch(SITEVERIFY_URL, { method: "POST", body: fd, signal: request.signal });
  const verify = await verifyRes.json();

  if (!verify?.success) {
    return json({ error: "turnstile_failed", codes: verify?.["error-codes"] || [] }, 403);
  }

  // Extra sanity checks: action + hostname, if present.
  if (verify.action && verify.action !== "ping6_run") {
    return json({ error: "turnstile_bad_action", action: verify.action }, 403);
  }
  if (verify.hostname && !ALLOWED_HOSTNAMES.has(verify.hostname)) {
    return json({ error: "turnstile_bad_hostname", hostname: verify.hostname }, 403);
  }

  // 2) Create the measurement server-side.
  const payload = {
    type: base.type,
    target: targetCheck.value,
    locations: effectiveLocations,
    limit,
    inProgressUpdates: true,
    measurementOptions: { ...moCheck.value, ipVersion: ipVer },
  };

  try {
    const m = await postJson(GLOBALPING_URL, payload, request.signal);
    return json({ m, warnings: [] });
  } catch (e) {
    const status = e.status || 500;
    const retryAfter = e.retryAfter;
    const headers = status === 429 && retryAfter ? { "retry-after": String(retryAfter) } : {};
    return json(
      {
        error: "globalping_failed",
        status,
        retryAfter: retryAfter || undefined,
        details: e.data || {},
      },
      status,
      headers
    );
  }
}
