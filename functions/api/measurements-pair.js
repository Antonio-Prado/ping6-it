const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const GLOBALPING_URL = "https://api.globalping.io/v1/measurements";

const ALLOWED_TYPES = new Set(["ping", "traceroute", "mtr", "dns", "http"]);
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
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error("Upstream error");
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
  if (flow !== "v4first" && flow !== "v6first") {
    return json({ error: "invalid_flow" }, 400);
  }

  // Defensive validation / clamping to reduce abuse.
  if (!ALLOWED_TYPES.has(base.type)) return json({ error: "invalid_type" }, 400);
  if (typeof base.target !== "string" || !base.target.trim()) return json({ error: "invalid_target" }, 400);

  const limit = Math.max(1, Math.min(10, Number(base.limit) || 3));

  // 1) Turnstile siteverify (server-side validation is mandatory).
  const remoteip =
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0]?.trim() ||
    undefined;

  const fd = new FormData();
  fd.append("secret", secret);
  fd.append("response", turnstileToken);
  if (remoteip) fd.append("remoteip", remoteip);

  const verifyRes = await fetch(SITEVERIFY_URL, { method: "POST", body: fd });
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

  // 2) Create the IPv4/IPv6 pair (same probes) server-side.
  const baseSanitized = {
    type: base.type,
    target: String(base.target).trim(),
    locations: base.locations,
    limit,
    inProgressUpdates: true,
  };

  try {
    let m4, m6;

    if (flow === "v6first") {
      m6 = await postJson(
        GLOBALPING_URL,
        { ...baseSanitized, measurementOptions: { ...measurementOptions, ipVersion: 6 } },
        request.signal
      );

      m4 = await postJson(
        GLOBALPING_URL,
        {
          ...baseSanitized,
          locations: m6.id,
          measurementOptions: { ...measurementOptions, ipVersion: 4 },
        },
        request.signal
      );
    } else {
      m4 = await postJson(
        GLOBALPING_URL,
        { ...baseSanitized, measurementOptions: { ...measurementOptions, ipVersion: 4 } },
        request.signal
      );

      m6 = await postJson(
        GLOBALPING_URL,
        {
          ...baseSanitized,
          locations: m4.id,
          measurementOptions: { ...measurementOptions, ipVersion: 6 },
        },
        request.signal
      );
    }

    return json({ m4, m6 });
  } catch (e) {
    return json({ error: "globalping_failed", status: e.status || 500, details: e.data || {} }, e.status || 500);
  }
}
