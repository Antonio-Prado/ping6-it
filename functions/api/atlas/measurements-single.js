import { applyRateLimit } from "../_lib/rateLimit.js";
import { sanitizeMeasurementOptions, sanitizeTarget } from "../_lib/guardrails.js";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ATLAS_BASE = "https://atlas.ripe.net";

const ALLOWED_TYPES = new Set(["ping", "traceroute", "dns"]);
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

function clampInt(x, { min, max, fallback }) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function verifyTurnstile({ token, secret, remoteip, signal }) {
  const fd = new FormData();
  fd.append("secret", secret);
  fd.append("response", token);
  if (remoteip) fd.append("remoteip", remoteip);

  const verifyRes = await fetch(SITEVERIFY_URL, { method: "POST", body: fd, signal });
  const verify = await verifyRes.json();
  return verify;
}

function extractAtlasKey(request, env) {
  const headerKey = request.headers.get("X-Atlas-Key") || "";
  const key = String(headerKey || env.ATLAS_API_KEY || "").trim();
  return key;
}

async function atlasGetJson(path, apiKey, signal) {
  const headers = {};
  if (apiKey) headers.authorization = `Key ${apiKey}`;

  const res = await fetch(`${ATLAS_BASE}${path}`, {
    method: "GET",
    headers,
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
    const err = new Error("Atlas upstream error");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function atlasPost(path, payload, apiKey, signal) {
  const res = await fetch(`${ATLAS_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Key ${apiKey}`,
    },
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
    const err = new Error("Atlas upstream error");
    err.status = res.status;
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

function atlasDefinitionFor(cmd, af, target, measurementOptions) {
  const type = String(cmd);
  const base = {
    description: `ping6.it ${type} ${target} (IPv${af})`,
    af,
    type,
    is_oneoff: true,
  };

  if (type === "ping") {
    base.target = target;
    const packets = clampInt(measurementOptions?.packets, { min: 1, max: 16, fallback: 3 });
    base.packets = packets;
    return base;
  }

  if (type === "traceroute") {
    base.target = target;
    const proto = String(measurementOptions?.protocol || "ICMP").toUpperCase();
    base.protocol = proto;
    if (proto !== "ICMP") {
      base.port = clampInt(measurementOptions?.port, { min: 1, max: 65535, fallback: 80 });
    }
    const packets = clampInt(measurementOptions?.packets, { min: 1, max: 16, fallback: 3 });
    base.packets = packets;
    return base;
  }

  if (type === "dns") {
    const qType = String(measurementOptions?.query?.type || "A").toUpperCase();
    const proto = String(measurementOptions?.protocol || "UDP").toUpperCase();
    const port = clampInt(measurementOptions?.port, { min: 1, max: 65535, fallback: 53 });

    const resolver = String(measurementOptions?.resolver || "").trim() || "one.one.one.one";

    base.target = resolver;
    base.query_class = "IN";
    base.query_type = qType;
    base.query_argument = target;
    base.protocol = proto;
    base.port = port;

    return base;
  }

  throw new Error(`unsupported_type:${type}`);
}

function normalizeProbeId(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return String(Math.trunc(n));
}

function uniqueIds(ids) {
  const out = [];
  const seen = new Set();
  (ids || []).forEach((x) => {
    const s = String(x || "").trim();
    if (!s) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  });
  return out;
}

function extractProbeIdsFromProbeListPayload(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  const ids = results
    .map((p) => normalizeProbeId(p?.id ?? p?.prb_id ?? p))
    .filter(Boolean);
  return uniqueIds(ids);
}

async function fetchAllocatedProbeIds(measurementId, apiKey, signal) {
  const id = String(measurementId || "").trim();
  if (!id) return [];

  // 1) Preferred: explicit probes endpoint.
  try {
    const probesPayload = await atlasGetJson(`/api/v2/measurements/${encodeURIComponent(id)}/probes/`, apiKey, signal);
    const ids = extractProbeIdsFromProbeListPayload(probesPayload);
    if (ids.length) return ids;
  } catch {
    // ignore
  }

  // 2) Best-effort fallback: derive from results (only probes that produced a result).
  try {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 3600;
    const rows = await atlasGetJson(
      `/api/v2/measurements/${encodeURIComponent(id)}/results/?format=json&start=${start}`,
      apiKey,
      signal
    );
    const list = Array.isArray(rows) ? rows : [];
    const ids = list.map((r) => normalizeProbeId(r?.prb_id)).filter(Boolean);
    return uniqueIds(ids);
  } catch {
    return [];
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const secret = env.TURNSTILE_SECRET;
  if (!secret) return json({ error: "TURNSTILE_SECRET not set" }, 500);

  const apiKey = extractAtlasKey(request, env);
  if (!apiKey) {
    return badRequest("missing_atlas_api_key", "RIPE Atlas needs an API key.", {
      hint: "Paste it in Settings (Atlas API key) and retry.",
    });
  }

  const rl = await applyRateLimit({ request, env, scope: "atlas_single", limit: 25, windowSec: 600 });
  if (rl.limited) {
    return json({ error: "rate_limited", retryAfter: rl.retryAfterSec }, 429, rl.headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid_json", "Invalid JSON body.", {
      hint: "Send a JSON object with turnstileToken, base, measurementOptions, ipVersion, and sameProbesAs.",
    });
  }

  const { turnstileToken, base, measurementOptions, ipVersion, sameProbesAs } = body || {};

  const missing = [];
  if (!turnstileToken) missing.push("turnstileToken");
  if (!base) missing.push("base");
  if (!measurementOptions) missing.push("measurementOptions");
  if (!ipVersion) missing.push("ipVersion");
  if (!sameProbesAs) missing.push("sameProbesAs");
  if (missing.length) {
    return badRequest("missing_fields", `Missing required field(s): ${missing.join(", ")}.`, { missing });
  }

  if (!ALLOWED_TYPES.has(base.type)) {
    return badRequest("unsupported_type", `Unsupported measurement type for RIPE Atlas: ${String(base.type)}.`, {
      type: base.type,
      allowed: Array.from(ALLOWED_TYPES),
    });
  }

  const ipVer = Number(ipVersion);
  if (ipVer !== 4 && ipVer !== 6) {
    return badRequest("invalid_ip_version", 'Invalid "ipVersion". Expected 4 or 6.', { ipVersion });
  }

  const targetCheck = sanitizeTarget({ type: base.type, target: base.target, allowIp: false });
  if (!targetCheck.ok) {
    return badRequest(targetCheck.error || "invalid_target", targetCheck.message || "Invalid target.", {
      target: base.target,
    });
  }

  const moCheck = sanitizeMeasurementOptions(base.type, measurementOptions, { backend: "atlas" });
  if (!moCheck.ok) {
    return badRequest(moCheck.error || "invalid_measurement_options", moCheck.message || "Invalid measurement options.", {
      measurementOptions,
    });
  }

  const remoteip =
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0]?.trim() ||
    undefined;

  const verify = await verifyTurnstile({ token: turnstileToken, secret, remoteip, signal: request.signal });
  if (!verify?.success) {
    return json({ error: "turnstile_failed", codes: verify?.["error-codes"] || [] }, 403);
  }
  if (verify.action && verify.action !== "ping6_run") {
    return json({ error: "turnstile_bad_action", action: verify.action }, 403);
  }
  if (verify.hostname && !ALLOWED_HOSTNAMES.has(verify.hostname)) {
    return json({ error: "turnstile_bad_hostname", hostname: verify.hostname }, 403);
  }

  const warnings = [];
  let probeIds;
  try {
    probeIds = await fetchAllocatedProbeIds(String(sameProbesAs || ""), apiKey, request.signal);
  } catch {
    probeIds = [];
  }

  if (!Array.isArray(probeIds) || probeIds.length === 0) {
    return json(
      {
        error: "atlas_probe_list_failed",
        message: "Unable to derive the probe list from the reference measurement.",
        sameProbesAs,
      },
      502
    );
  }

  // Atlas probe selection requests can be large; keep it bounded.
  const MAX_PROBES = 50;
  if (probeIds.length > MAX_PROBES) {
    warnings.push(`Reference measurement used ${probeIds.length} probes; retry is limited to ${MAX_PROBES}.`);
    probeIds = probeIds.slice(0, MAX_PROBES);
  }

  try {
    const def = atlasDefinitionFor(base.type, ipVer, targetCheck.value, moCheck.value);
    const created = await atlasPost(
      "/api/v2/measurements/",
      {
        definitions: [def],
        probes: [{ requested: probeIds.length, type: "probes", value: probeIds.join(",") }],
      },
      apiKey,
      request.signal
    );

    const ids = Array.isArray(created?.measurements) ? created.measurements : [];
    const msm = ids[0] || created?.measurement || created?.id;
    if (!msm) {
      return json({ error: "atlas_create_failed", details: created || {} }, 502);
    }

    return json({ backend: "atlas", warnings, m: { id: String(msm) } });
  } catch (e) {
    const status = e.status || 500;
    const retryAfter = e.retryAfter;
    const headers = status === 429 && retryAfter ? { "retry-after": String(retryAfter) } : {};
    return json(
      {
        error: "atlas_failed",
        status,
        retryAfter: retryAfter || undefined,
        details: e.data || {},
        warnings,
      },
      status,
      headers
    );
  }
}
