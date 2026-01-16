const RIPESTAT_AS_OVERVIEW = "https://stat.ripe.net/data/as-overview/data.json";

// Server-side caching (prefer KV if available; fallback to the Cloudflare Cache API).
// KV binding name (recommended): ASN_META_KV
//
// Fresh window: serve from cache without revalidation.
// Stale window: serve stale + revalidate in background (stale-while-revalidate).
const ASN_META_TTL_FRESH_SECONDS = 24 * 60 * 60;
const ASN_META_TTL_STALE_SECONDS = 7 * 24 * 60 * 60;
// Keep cached records for the whole stale window.
const ASN_META_TTL_TOTAL_SECONDS = ASN_META_TTL_STALE_SECONDS;

const ASN_META_CACHE_PREFIX = "https://ping6.it/_cache/asn/meta/";

function json(body, status = 200, cacheControl = "public, max-age=600, stale-while-revalidate=43200") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}

function normalizeAsnParam(v) {
  const s = String(v || "").trim();
  if (!/^[0-9]{1,10}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n > 4294967295) return null;
  return String(Math.trunc(n));
}

function cleanText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low === "n/a" || low === "na" || low === "none" || low === "null" || low === "unknown" || low === "-") return null;
  return s;
}

function getDefaultCache() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

function cacheKey(asn) {
  return `${ASN_META_CACHE_PREFIX}${encodeURIComponent(String(asn))}`;
}

function coerceRecord(rec) {
  if (!rec || typeof rec !== "object") return null;
  const fetchedAt = Number(rec.fetchedAt);
  const payload = rec.payload && typeof rec.payload === "object" ? rec.payload : null;
  if (!Number.isFinite(fetchedAt) || !payload) return null;
  return { fetchedAt, payload };
}

async function readFromKv(kv, asn) {
  if (!kv) return null;
  try {
    const rec = await kv.get(`asn-meta:${asn}`, { type: "json" });
    return coerceRecord(rec);
  } catch {
    return null;
  }
}

async function writeToKv(kv, asn, record) {
  if (!kv || !record) return;
  try {
    await kv.put(`asn-meta:${asn}`, JSON.stringify(record), { expirationTtl: ASN_META_TTL_TOTAL_SECONDS });
  } catch {
    // ignore
  }
}

async function readFromEdgeCache(cache, asn) {
  if (!cache) return null;
  try {
    const req = new Request(cacheKey(asn));
    const res = await cache.match(req);
    if (!res) return null;
    const rec = await res.json();
    return coerceRecord(rec);
  } catch {
    return null;
  }
}

async function writeToEdgeCache(cache, asn, record) {
  if (!cache || !record) return;
  try {
    const req = new Request(cacheKey(asn));
    const res = new Response(JSON.stringify(record), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${ASN_META_TTL_TOTAL_SECONDS}`,
      },
    });
    await cache.put(req, res);
  } catch {
    // ignore
  }
}

function buildResponsePayload(payload, fetchedAtMs, cacheStatus, opts = {}) {
  const now = Date.now();
  const ageSec = Math.max(0, Math.floor((now - fetchedAtMs) / 1000));
  return {
    ...payload,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    cache: {
      status: cacheStatus,
      ageSec,
      freshTtlSec: ASN_META_TTL_FRESH_SECONDS,
      staleTtlSec: ASN_META_TTL_STALE_SECONDS,
      revalidating: Boolean(opts.revalidating),
    },
  };
}

async function fetchRipestat(asn) {
  const upstream = new URL(RIPESTAT_AS_OVERVIEW);
  upstream.searchParams.set("resource", asn);

  const resp = await fetch(upstream.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!resp.ok) {
    const err = new Error("RIPEstat returned an error");
    err.status = resp.status;
    throw err;
  }

  const body = await resp.json();
  const data = body && typeof body === "object" ? body.data : null;
  const block = data && typeof data === "object" ? data.block : null;

  const holder = cleanText(data?.holder);

  const regName = cleanText(block?.name);
  const regDesc = cleanText(block?.desc);
  const regResource = cleanText(block?.resource);

  return {
    asn: Number(asn),
    holder,
    announced: typeof data?.announced === "boolean" ? data.announced : null,
    registry: regName || regDesc || regResource
      ? {
          name: regName,
          desc: regDesc,
          resource: regResource,
        }
      : null,
    source: "ripestat-as-overview",
  };
}

async function refreshRecord({ kv, cache, asn }) {
  const payload = await fetchRipestat(asn);
  const record = { fetchedAt: Date.now(), payload };
  await Promise.all([writeToKv(kv, asn, record), writeToEdgeCache(cache, asn, record)]);
  return record;
}

export async function onRequest(context) {
  const asn = normalizeAsnParam(context?.params?.asn);
  if (!asn) {
    return json({ error: "bad_request", message: "Invalid ASN." }, 400, "no-store");
  }

  const kv = context?.env?.ASN_META_KV || null;
  const cache = getDefaultCache();
  const now = Date.now();

  // 1) Try KV (preferred)
  let rec = await readFromKv(kv, asn);
  if (!rec) {
    // 2) Fallback to edge cache
    rec = await readFromEdgeCache(cache, asn);
  }

  if (rec) {
    const ageSec = Math.max(0, Math.floor((now - rec.fetchedAt) / 1000));

    if (ageSec <= ASN_META_TTL_FRESH_SECONDS) {
      return json(buildResponsePayload(rec.payload, rec.fetchedAt, "hit"));
    }

    // Stale-but-serveable: return it, and revalidate in the background.
    if (ageSec <= ASN_META_TTL_STALE_SECONDS) {
      let revalidating = false;
      try {
        context.waitUntil(refreshRecord({ kv, cache, asn }));
        revalidating = true;
      } catch {
        // ignore
      }
      return json(buildResponsePayload(rec.payload, rec.fetchedAt, "stale", { revalidating }));
    }

    // Too old: try to refresh synchronously. If upstream fails, fall back to the expired record.
    try {
      const freshRec = await refreshRecord({ kv, cache, asn });
      return json(buildResponsePayload(freshRec.payload, freshRec.fetchedAt, "miss"));
    } catch {
      return json(buildResponsePayload(rec.payload, rec.fetchedAt, "stale-expired", { revalidating: false }));
    }
  }

  // 3) Cache miss: fetch now.
  let payload;
  try {
    payload = await fetchRipestat(asn);
  } catch {
    return json({ error: "upstream_error", message: "RIPEstat request failed." }, 502, "no-store");
  }

  const record = { fetchedAt: Date.now(), payload };
  await Promise.all([writeToKv(kv, asn, record), writeToEdgeCache(cache, asn, record)]);

  return json(buildResponsePayload(payload, record.fetchedAt, "miss"));
}
