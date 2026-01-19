/**
 * Minimal IP-based fixed-window rate limiter.
 *
 * Storage order:
 * - env.RATE_LIMIT_KV (if present)
 * - env.ASN_META_KV (recommended for zero-config)
 * - caches.default (best-effort)
 */

function getClientIp(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp.trim();

  const xff = request.headers.get("X-Forwarded-For");
  if (xff) {
    const first = String(xff).split(",")[0]?.trim();
    if (first) return first;
  }

  // Best-effort fallback.
  return "unknown";
}

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function buildHeaders({ limit, remaining, resetEpochSec, retryAfterSec }) {
  const headers = {
    "cache-control": "no-store",
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(Math.max(0, remaining)),
    "x-ratelimit-reset": String(Math.max(0, resetEpochSec)),
  };
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfterSec)));
  }
  return headers;
}

async function kvGetJson(kv, key) {
  if (!kv?.get) return null;
  try {
    // Cloudflare KV supports get(key, { type: "json" }).
    return await kv.get(key, { type: "json" });
  } catch {
    // Some environments support get(key, "json").
    try {
      return await kv.get(key, "json");
    } catch {
      return null;
    }
  }
}

async function kvPutJson(kv, key, value, ttlSec) {
  if (!kv?.put) return false;
  try {
    await kv.put(key, JSON.stringify(value), {
      expirationTtl: Math.max(1, Math.ceil(ttlSec)),
    });
    return true;
  } catch {
    return false;
  }
}

function cacheKeyFor(key) {
  // Deterministic, short, and avoids leaking user info in logs.
  return new Request(`https://rate-limit.local/${encodeURIComponent(key)}`);
}

async function cacheGetJson(key) {
  try {
    const hit = await caches.default.match(cacheKeyFor(key));
    if (!hit) return null;
    const text = await hit.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function cachePutJson(key, value, ttlSec) {
  try {
    const res = new Response(JSON.stringify(value), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${Math.max(1, Math.ceil(ttlSec))}`,
      },
    });
    await caches.default.put(cacheKeyFor(key), res);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply a fixed-window rate limit.
 *
 * Returns:
 * - { limited: boolean, retryAfterSec?: number, headers: Record<string,string> }
 */
export async function applyRateLimit({
  request,
  env,
  scope = "default",
  limit = 30,
  windowSec = 600,
}) {
  const ip = getClientIp(request);
  const nowSec = Math.floor(Date.now() / 1000);

  const l = clampInt(limit, { min: 1, max: 10_000, fallback: 30 });
  const w = clampInt(windowSec, { min: 5, max: 86_400, fallback: 600 });

  const storage = env?.RATE_LIMIT_KV || env?.ASN_META_KV || null;
  const key = `__rl:v1:${scope}:${ip}`;

  let entry = null;
  let storedVia = "none";

  // Read
  if (storage) {
    entry = await kvGetJson(storage, key);
    storedVia = "kv";
  }
  if (!entry) {
    entry = await cacheGetJson(key);
    if (entry) storedVia = "cache";
  }

  const reset = Number(entry?.resetEpochSec);
  const sameWindow = Number.isFinite(reset) && reset > nowSec;

  let count = sameWindow ? Number(entry?.count || 0) : 0;
  const resetEpochSec = sameWindow ? reset : nowSec + w;

  // Update (we still update the counter when not limited; when limited, keep count as-is).
  const nextCount = count + 1;

  const remaining = Math.max(0, l - nextCount);
  const limited = nextCount > l;
  const retryAfterSec = limited ? Math.max(1, resetEpochSec - nowSec) : undefined;

  if (!limited) {
    const value = { count: nextCount, resetEpochSec };
    const ttl = resetEpochSec - nowSec + 5;

    const okKv = storage ? await kvPutJson(storage, key, value, ttl) : false;
    if (!okKv) {
      await cachePutJson(key, value, ttl);
    }
  }

  return {
    limited,
    retryAfterSec,
    headers: buildHeaders({
      limit: l,
      remaining: limited ? 0 : remaining,
      resetEpochSec,
      retryAfterSec,
    }),
    debug: { storedVia },
  };
}
