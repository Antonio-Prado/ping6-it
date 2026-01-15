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
    "Atlas probe selection syntax differs from Globalping. Falling back to area=WW. Examples: WW, IT, AS3269, asn:3356, prefix:2001:db8::/32, probes:123,456."
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
  if (!apiKey) return json({ error: "missing_atlas_api_key" }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { turnstileToken, base, measurementOptions, flow } = body || {};
  if (!turnstileToken || !base || !measurementOptions || !flow) {
    return json({ error: "missing_fields" }, 400);
  }

  if (!ALLOWED_TYPES.has(base.type)) return json({ error: "unsupported_type" }, 400);
  if (typeof base.target !== "string" || !base.target.trim()) return json({ error: "invalid_target" }, 400);

  // Atlas needs a v6-first flow to enforce the same probes for v4/v6.
  // We'll still accept both values for compatibility with the current client.
  if (flow !== "v4first" && flow !== "v6first") return json({ error: "invalid_flow" }, 400);

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
        details: e.data || {},
      },
      e.status || 500
    );
  }
}
