const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ATLAS_BASE = "https://atlas.ripe.net";

const ALLOWED_TYPES = new Set(["ping", "traceroute", "dns"]);
const ALLOWED_HOSTNAMES = new Set(["ping6.it", "www.ping6.it", "ping6-it.pages.dev"]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
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

function normalizeMagic(magic) {
  // Globalping tag helpers append " +network=...". Atlas doesn't understand those.
  return String(magic || "")
    .replace(/\s\+network=[^\s]+/g, "")
    .replace(/\s\+tag=[^\s]+/g, "")
    .trim();
}


const PRESET_COUNTRY_NAME_TO_CODE = {
  brazil: "BR",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
};

// ping6.it geo presets use UN M49 region labels (e.g. "Asia", "Western Europe").
// RIPE Atlas probe selection does not support those directly, so we map them to Atlas "area" buckets.
// This is an approximation (Atlas areas are coarse).
const PRESET_REGION_TO_ATLAS_AREAS = {
  // Macro regions
  europe: ["West"],
  africa: ["West"],
  "north america": ["North-Central"],
  "south america": ["South-Central"],
  asia: ["North-East", "South-East"],

  // Europe (UN M49 subregions)
  "western europe": ["West"],
  "northern europe": ["West"],
  "southern europe": ["West"],
  "eastern europe": ["West"],

  // Africa (UN M49 subregions)
  "northern africa": ["West"],
  "western africa": ["West"],
  "middle africa": ["West"],
  "eastern africa": ["West"],
  "southern africa": ["West"],

  // Americas
  "northern america": ["North-Central"],
  "central america": ["North-Central"],
  caribbean: ["North-Central"],

  // Asia (UN M49 subregions)
  "western asia": ["North-East"],
  "central asia": ["North-East"],
  "southern asia": ["South-East"],
  "south-eastern asia": ["South-East"],
  "eastern asia": ["North-East"],

  // Oceania moved under Asia in the UI
  "australia and new zealand": ["South-East"],
  melanesia: ["South-East"],
  micronesia: ["South-East"],
  polynesia: ["South-East"],
};

function distributeRequested(total, buckets) {
  const t = Math.max(1, Math.trunc(Number(total) || 1));
  const b = Math.max(1, Math.trunc(Number(buckets) || 1));
  const base = Math.floor(t / b);
  const rem = t % b;
  const out = [];
  for (let i = 0; i < b; i += 1) {
    const n = base + (i < rem ? 1 : 0);
    if (n > 0) out.push(n);
  }
  return out;
}

function presetToAtlasProbeSelection(label, requested, warnings) {
  const raw = String(label || "").trim();
  const key = raw.toLowerCase();
  if (!key) return null;

  const cc = PRESET_COUNTRY_NAME_TO_CODE[key];
  if (cc) {
    warnings.push(`Mapped preset "${raw}" to RIPE Atlas country=${cc}.`);
    return { probes: [{ requested, type: "country", value: cc }], warnings };
  }

  const areas = PRESET_REGION_TO_ATLAS_AREAS[key];
  if (Array.isArray(areas) && areas.length) {
    const counts = distributeRequested(requested, areas.length);
    const usedAreas = areas.slice(0, counts.length);
    const probes = usedAreas.map((a, i) => ({ requested: counts[i], type: "area", value: a }));
    warnings.push(
      `Mapped preset "${raw}" to RIPE Atlas area${usedAreas.length > 1 ? "s" : ""}: ${usedAreas.join(", ")}. (Atlas areas are coarse and may not match the Globalping region exactly.)`
    );
    return { probes, warnings };
  }

  return null;
}

function parseAtlasProbeRequest(location, requested) {
  const req = clampInt(requested, { min: 1, max: 50, fallback: 3 });

  const asn = Number(location?.asn);
  if (Number.isFinite(asn) && asn > 0) {
    return { probes: [{ requested: req, type: "asn", value: String(asn) }], warnings: [] };
  }

  const raw = normalizeMagic(location?.magic);
  const s = raw.trim();
  const warnings = [];

  const areas = new Set(["WW", "West", "North-Central", "South-Central", "North-East", "South-East"]);
  const area = Array.from(areas).find((a) => a.toLowerCase() === s.toLowerCase());
  if (!s || s.toLowerCase() === "world") {
    return { probes: [{ requested: req, type: "area", value: "WW" }], warnings };
  }
  if (area) {
    return { probes: [{ requested: req, type: "area", value: area }], warnings };
  }

  const mapped = presetToAtlasProbeSelection(s, req, warnings);
  if (mapped) return mapped;

  const mAsn = s.match(/^(?:asn:|AS)(\d+)$/i);
  if (mAsn) {
    return { probes: [{ requested: req, type: "asn", value: String(Number(mAsn[1])) }], warnings };
  }

  if (/^[A-Za-z]{2}$/.test(s)) {
    return { probes: [{ requested: req, type: "country", value: s.toUpperCase() }], warnings };
  }

  if (s.includes("/") && !s.includes(" ")) {
    // IPv4/IPv6 prefix
    return { probes: [{ requested: req, type: "prefix", value: s }], warnings };
  }

  const mProbes = s.match(/^(?:probes:)(.+)$/i);
  if (mProbes) {
    const ids = mProbes[1]
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => /^\d+$/.test(x));
    if (ids.length) {
      return { probes: [{ requested: ids.length, type: "probes", value: ids.join(",") }], warnings };
    }
  }

  // Fallback
  warnings.push(
    "Atlas probe selection syntax differs from Globalping. Unknown regions/names will fall back to area=WW. Examples: WW, IT, AS3269, asn:3356, prefix:2001:db8::/32, probes:123,456."
  );
  return { probes: [{ requested: req, type: "area", value: "WW" }], warnings };
}

function mergeCsvTags(existingCsv, addTags) {
  const base = String(existingCsv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const add = (addTags || []).map((s) => String(s).trim()).filter(Boolean);
  const out = new Set([...base, ...add]);
  return Array.from(out).join(",");
}

function enforceDualStackProbes(probes, flow) {
  // ping6.it always creates a v4+v6 pair.
  // If the user enables "IPv6-capable probes only" (flow=v6first), we must ensure probes can do BOTH
  // protocols; otherwise the v4 side may fail (e.g., v6-only probes) or Atlas may allocate probes that
  // cannot execute one of the two measurements.
  // If the user disables it (flow=v4first), we prioritise IPv4 coverage and accept that some probes may
  // not return IPv6 results.
  const mustHave = flow === "v6first" ? ["system-ipv4-works", "system-ipv6-works"] : ["system-ipv4-works"];
  return (probes || []).map((p) => ({
    ...p,
    tags_include: mergeCsvTags(p.tags_include, mustHave),
  }));
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
    // Keep default traceroute packet count (3) unless explicitly provided.
    const packets = clampInt(measurementOptions?.packets, { min: 1, max: 16, fallback: 3 });
    base.packets = packets;
    return base;
  }

  if (type === "dns") {
    // In Atlas, target is the resolver, and query_argument is the qname.
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
    // Prefer Retry-After, but support X-RateLimit-Reset (seconds) if present.
    const retryAfterHeader = res.headers.get("retry-after") || "";
    const rateLimitResetHeader = res.headers.get("x-ratelimit-reset") || "";
    const rateLimitResetSec = Number(rateLimitResetHeader);
    err.retryAfter = retryAfterHeader
      ? retryAfterHeader
      : Number.isFinite(rateLimitResetSec) && rateLimitResetSec > 0
        ? `${Math.ceil(rateLimitResetSec)}s`
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

  const apiKey = extractAtlasKey(request, env);
  if (!apiKey) return badRequest("missing_atlas_api_key", "RIPE Atlas needs an API key.", { hint: "Paste it in Settings (Atlas API key) and retry." });

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid_json", "Invalid JSON body.", { hint: "Send a JSON object with turnstileToken, base, measurementOptions, and flow." });
  }

  const { turnstileToken, base, measurementOptions, flow } = body || {};

  const missing = [];
  if (!turnstileToken) missing.push("turnstileToken");
  if (!base) missing.push("base");
  if (!measurementOptions) missing.push("measurementOptions");
  if (!flow) missing.push("flow");
  if (missing.length) {
    return badRequest("missing_fields", `Missing required field(s): ${missing.join(", ")}.`, { missing });
  }

  if (!ALLOWED_TYPES.has(base.type)) {
    return badRequest("unsupported_type", `Unsupported measurement type for RIPE Atlas: ${String(base.type)}.`, { type: base.type, allowed: Array.from(ALLOWED_TYPES) });
  }
  if (typeof base.target !== "string" || !base.target.trim()) {
    return badRequest("invalid_target", 'Invalid "target". Expected a non-empty hostname/IP/URL string.', { target: base.target });
  }

  // Atlas needs a v6-first flow to enforce the same probes for v4/v6.
  // We'll still accept both values for compatibility with the current client.
  if (flow !== "v4first" && flow !== "v6first") {
    return badRequest("invalid_flow", 'Invalid "flow". Expected "v4first" or "v6first".', { flow, allowed: ["v4first", "v6first"] });
  }

  const limit = clampInt(base.limit, { min: 1, max: 50, fallback: 3 });

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

  const { probes, warnings } = parseAtlasProbeRequest(base.locations?.[0] || {}, limit);
  const probesDualStack = enforceDualStackProbes(probes, flow);

  if (flow !== "v6first") {
    warnings.push(
      "IPv6-capable probes only is disabled: Atlas will prioritise IPv4 coverage; the IPv6 side may have fewer results if some probes lack IPv6 connectivity."
    );
  }

  try {
    // Create the IPv4+IPv6 pair in a *single* Atlas API request.
    // RIPE Atlas guarantees that measurements created in one request share the same allocated probes,
    // and the response "measurements" array matches the order in "definitions".
    const def4 = atlasDefinitionFor(base.type, 4, String(base.target).trim(), measurementOptions);
    const def6 = atlasDefinitionFor(base.type, 6, String(base.target).trim(), measurementOptions);
    const created = await atlasPost(
      "/api/v2/measurements/",
      { definitions: [def4, def6], probes: probesDualStack },
      apiKey,
      request.signal
    );
    const ids = Array.isArray(created?.measurements) ? created.measurements : [];
    const msm4 = ids[0];
    const msm6 = ids[1];
    if (!msm4 || !msm6) return json({ error: "atlas_create_failed", details: created || {} }, 502);

    // Mirror the Globalping handler response shape.
    return json({
      backend: "atlas",
      warnings,
      m4: { id: String(msm4) },
      m6: { id: String(msm6) },
    });
  } catch (e) {
    return json(
      {
        error: "atlas_failed",
        status: e.status || 500,
        retryAfter: e.retryAfter || undefined,
        details: e.data || {},
      },
      e.status || 500
    );
  }
}
