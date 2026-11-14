import { applyRateLimit } from "../_lib/rateLimit.js";
import { resolveAtlasKey, sharedAtlasLimits, spendSharedAtlasBudget } from "../_lib/atlasKey.js";

// The check of the place of the probes of RIPE Atlas with the anchors (src/lib/soi.js): one-off pings from the probes of a
// measurement to a few anchors, whose places are checked by RIPE Atlas. The page chooses the anchors and names them by their
// numbers; the targets are read here from RIPE Atlas, so that nothing but an anchor can be aimed at.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ATLAS_BASE = "https://atlas.ripe.net";
const ALLOWED_HOSTNAMES = new Set(["ping6.it", "www.ping6.it"]);
const MAX_ANCHORS = 14;
const MAX_PROBES = 50;
const PACKETS = 3;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

function idList(value, max) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(value) ? value : []) {
    const n = Number(x);
    if (!Number.isInteger(n) || n <= 0 || n > 1e9 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

async function anchorById(id, signal) {
  const res = await fetch(`${ATLAS_BASE}/api/v2/anchors/${id}/`, { signal });
  if (!res.ok) return null;
  const a = await res.json().catch(() => null);
  const c = a?.geometry?.coordinates;
  const fqdn = String(a?.fqdn || "").trim().toLowerCase();
  if (!a || a.is_disabled || !a.ip_v4 || !Array.isArray(c) || !/^[a-z0-9-]+\.anchors\.atlas\.ripe\.net$/.test(fqdn)) return null;
  const latitude = Number(c[1]);
  const longitude = Number(c[0]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { id: a.id, fqdn, city: a.city || null, country: a.country || null, latitude, longitude };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const secret = env.TURNSTILE_SECRET;
  if (!secret) return json({ error: "TURNSTILE_SECRET not set" }, 500);

  const { key: apiKey, shared: sharedKey } = resolveAtlasKey(request, env);
  if (!apiKey) return json({ error: "missing_atlas_api_key", message: "RIPE Atlas needs an API key." }, 400);

  const rl = await applyRateLimit({ request, env, scope: "atlas_anchors", limit: 12, windowSec: 600 });
  if (rl.limited) return json({ error: "rate_limited", retryAfter: rl.retryAfterSec }, 429, rl.headers);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", message: "Invalid JSON body." }, 400);
  }

  const maxProbes = sharedKey ? sharedAtlasLimits(env).maxProbes : MAX_PROBES;
  const probes = idList(body?.probes, maxProbes);
  const anchorIds = idList(body?.anchors, MAX_ANCHORS);
  if (!body?.turnstileToken || !probes.length || !anchorIds.length) {
    return json({ error: "missing_fields", message: "Send turnstileToken, probes and anchors." }, 400);
  }

  const remoteip =
    request.headers.get("CF-Connecting-IP") || (request.headers.get("X-Forwarded-For") || "").split(",")[0]?.trim() || undefined;
  const fd = new FormData();
  fd.append("secret", secret);
  fd.append("response", body.turnstileToken);
  if (remoteip) fd.append("remoteip", remoteip);
  const verify = await (await fetch(SITEVERIFY_URL, { method: "POST", body: fd, signal: request.signal })).json();
  if (!verify?.success) return json({ error: "turnstile_failed", codes: verify?.["error-codes"] || [] }, 403);
  if (verify.action && verify.action !== "ping6_run") return json({ error: "turnstile_bad_action", action: verify.action }, 403);
  if (verify.hostname && !ALLOWED_HOSTNAMES.has(verify.hostname)) {
    return json({ error: "turnstile_bad_hostname", hostname: verify.hostname }, 403);
  }

  if (sharedKey) {
    const refused = await spendSharedAtlasBudget({ request, env });
    if (refused) return json(refused.body, refused.status, refused.headers);
  }

  const anchors = (await Promise.all(anchorIds.map((id) => anchorById(id, request.signal).catch(() => null)))).filter(Boolean);
  if (!anchors.length) return json({ error: "no_anchor", message: "None of these anchors can be used." }, 400);

  const res = await fetch(`${ATLAS_BASE}/api/v2/measurements/`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Key ${apiKey}` },
    body: JSON.stringify({
      definitions: anchors.map((a) => ({
        type: "ping",
        af: 4,
        target: a.fqdn,
        packets: PACKETS,
        is_oneoff: true,
        description: `ping6.it probe location check, anchor ${a.fqdn}`,
      })),
      probes: [{ requested: probes.length, type: "probes", value: probes.join(",") }],
    }),
    signal: request.signal,
  });
  const created = await res.json().catch(() => null);
  const ids = Array.isArray(created?.measurements) ? created.measurements : [];
  if (!res.ok || ids.length !== anchors.length) {
    return json({ error: "atlas_failed", status: res.status, details: created || {} }, res.ok ? 502 : res.status);
  }

  return json({ probes, pings: anchors.map((anchor, i) => ({ id: String(ids[i]), anchor })) });
}
