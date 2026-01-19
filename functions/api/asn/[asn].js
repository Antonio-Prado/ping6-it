const RIPESTAT_AS_OVERVIEW = "https://stat.ripe.net/data/as-overview/data.json";
const RIPESTAT_PREFIX_SIZE_DISTRIBUTION = "https://stat.ripe.net/data/prefix-size-distribution/data.json";
const RIPESTAT_RIS_PREFIXES = "https://stat.ripe.net/data/ris-prefixes/data.json";
const RIPESTAT_RPKI_VALIDATION = "https://stat.ripe.net/data/rpki-validation/data.json";

// Server-side caching (prefer KV if available; fallback to the Cloudflare Cache API).
// KV binding name (recommended): ASN_META_KV
//
// Fresh window: serve from cache without revalidation.
// Stale window: serve stale + revalidate in background (stale-while-revalidate).
const ASN_META_TTL_FRESH_SECONDS = 24 * 60 * 60;
const ASN_META_TTL_STALE_SECONDS = 7 * 24 * 60 * 60;
// Keep cached records for the whole stale window.
const ASN_META_TTL_TOTAL_SECONDS = ASN_META_TTL_STALE_SECONDS;

// Bump this when the payload structure changes, so old cached records are refreshed.
const ASN_META_SCHEMA_VERSION = 2;

const ASN_META_CACHE_PREFIX = "https://ping6.it/_cache/asn/meta/";

// NOTE: We do server-side caching (KV/Cache API) and we want the UI to observe the *current*
// cache status (hit/stale/miss). If we allow CDN/browser caching of the API response itself,
// the client may keep seeing the very first "miss" payload for minutes/hours.
function json(body, status = 200, cacheControl = "no-store") {
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
  if (payload.schemaVersion !== ASN_META_SCHEMA_VERSION) return null;
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
      source: opts.source || null,
    },
  };
}

function concatUint8Arrays(chunks, totalLen) {
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function fetchRipestatJson(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000;
  const maxBytes = Number.isFinite(opts.maxBytes) ? Number(opts.maxBytes) : null;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort("timeout");
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!resp.ok) {
      const err = new Error("RIPEstat returned an error");
      err.status = resp.status;
      throw err;
    }

    // Default path: let the runtime parse JSON.
    if (!maxBytes || !resp.body) {
      return await resp.json();
    }

    // Bounded read to avoid huge responses (some ASNs can have *a lot* of prefixes).
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        const err = new Error("RIPEstat response too large");
        err.code = "BODY_TOO_LARGE";
        throw err;
      }
      chunks.push(value);
    }

    const bytes = concatUint8Arrays(chunks, received);
    const text = new TextDecoder("utf-8").decode(bytes);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRpkiStatus(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "valid") return "valid";
  if (s === "invalid") return "invalid";
  if (s === "unknown" || s === "not_found" || s === "notfound" || s === "unverified") return "unknown";
  return s ? s : "unknown";
}

async function mapLimit(items, limit, fn) {
  const arr = Array.isArray(items) ? items : [];
  const out = new Array(arr.length);
  let next = 0;
  const n = Math.max(1, Math.min(Number(limit) || 4, 12, arr.length || 1));

  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= arr.length) return;
      out[idx] = await fn(arr[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

function sumCounts(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  let total = 0;
  for (const r of arr) {
    const n = Number(r?.count);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

function uniqPrefixSample(list, maxN) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== "string") continue;
    const p = raw.trim();
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= maxN) break;
  }
  return out;
}

async function fetchAsOverview(asn) {
  const upstream = new URL(RIPESTAT_AS_OVERVIEW);
  upstream.searchParams.set("resource", `AS${asn}`);

  const body = await fetchRipestatJson(upstream.toString(), { timeoutMs: 8000, maxBytes: 500_000 });
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
    registry:
      regName || regDesc || regResource
        ? {
            name: regName,
            desc: regDesc,
            resource: regResource,
          }
        : null,
    source: "ripestat-as-overview",
  };
}

async function fetchPrefixSizeDistribution(asn) {
  const upstream = new URL(RIPESTAT_PREFIX_SIZE_DISTRIBUTION);
  upstream.searchParams.set("resource", `AS${asn}`);
  upstream.searchParams.set("min_peers_seeing", "0");

  const body = await fetchRipestatJson(upstream.toString(), { timeoutMs: 8000, maxBytes: 750_000 });
  const data = body && typeof body === "object" ? body.data : null;

  const v4 = sumCounts(data?.ipv4);
  const v6 = sumCounts(data?.ipv6);

  return {
    total: v4 + v6,
    v4,
    v6,
    source: "ripestat-prefix-size-distribution",
  };
}

async function fetchRisPrefixSamples(asn) {
  // Much lighter than "announced-prefixes" (no timelines), but can still be big.
  const base = new URL(RIPESTAT_RIS_PREFIXES);
  base.searchParams.set("resource", `AS${asn}`);
  base.searchParams.set("list_prefixes", "true");
  base.searchParams.set("types", "o");
  base.searchParams.set("noise", "filter");

  async function fetchAf(af) {
    const u = new URL(base.toString());
    u.searchParams.set("af", af);
    const body = await fetchRipestatJson(u.toString(), { timeoutMs: 9000, maxBytes: 5_000_000 });
    const data = body && typeof body === "object" ? body.data : null;

    // Common shape (observed in the wild): data.prefixes.v4.originating[] / data.prefixes.v6.originating[]
    const prefixes = data?.prefixes;
    const fam = af === "v6" ? prefixes?.v6 : prefixes?.v4;
    const list = fam?.originating;
    return uniqPrefixSample(list, 10);
  }

  try {
    const [v4, v6] = await Promise.all([fetchAf("v4"), fetchAf("v6")]);
    return { v4, v6, source: "ripestat-ris-prefixes" };
  } catch {
    return { v4: [], v6: [], source: "ripestat-ris-prefixes" };
  }
}

async function fetchRpkiValidation(asn, prefix) {
  const upstream = new URL(RIPESTAT_RPKI_VALIDATION);
  upstream.searchParams.set("resource", `AS${asn}`);
  upstream.searchParams.set("prefix", prefix);

  const body = await fetchRipestatJson(upstream.toString(), { timeoutMs: 6000, maxBytes: 250_000 });
  const data = body && typeof body === "object" ? body.data : null;

  // RIPEstat has used different field names over time; handle common shapes.
  const status = data?.status ?? data?.validation_status ?? data?.validity ?? data?.rpki_status;
  return normalizeRpkiStatus(status);
}

async function fetchRpkiSample(asn, prefixes) {
  const list = Array.isArray(prefixes) ? prefixes.filter(Boolean) : [];
  if (!list.length) return null;

  const isV6 = (pfx) => String(pfx || "").includes(":");
  const v4n = list.filter((p) => !isV6(p)).length;
  const v6n = list.length - v4n;

  const results = await mapLimit(list, 4, async (pfx) => {
    try {
      const status = await fetchRpkiValidation(asn, pfx);
      return { prefix: pfx, status };
    } catch {
      return { prefix: pfx, status: "unknown" };
    }
  });

  const counts = { valid: 0, invalid: 0, unknown: 0 };
  const countsV4 = { valid: 0, invalid: 0, unknown: 0 };
  const countsV6 = { valid: 0, invalid: 0, unknown: 0 };

  for (const r of results) {
    const s = normalizeRpkiStatus(r?.status);
    const fam = isV6(r?.prefix) ? "v6" : "v4";

    if (s === "valid") counts.valid += 1;
    else if (s === "invalid") counts.invalid += 1;
    else counts.unknown += 1;

    const bucket = fam === "v6" ? countsV6 : countsV4;
    if (s === "valid") bucket.valid += 1;
    else if (s === "invalid") bucket.invalid += 1;
    else bucket.unknown += 1;

    if (r) r.status = s;
  }

  const pct = (num, den) => {
    const n = Number(num);
    const d = Number(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
    return Math.round((n / d) * 1000) / 10; // 1 decimal
  };

  const pctAll = {
    valid: pct(counts.valid, list.length),
    invalid: pct(counts.invalid, list.length),
    unknown: pct(counts.unknown, list.length),
  };

  const pctV4 = {
    valid: pct(countsV4.valid, v4n),
    invalid: pct(countsV4.invalid, v4n),
    unknown: pct(countsV4.unknown, v4n),
  };

  const pctV6 = {
    valid: pct(countsV6.valid, v6n),
    invalid: pct(countsV6.invalid, v6n),
    unknown: pct(countsV6.unknown, v6n),
  };

  const invalidPct = pctAll.invalid ?? 0;
  const unknownPct = pctAll.unknown ?? 0;

  let level = "ok";
  if (invalidPct >= 20) level = "alert";
  else if (invalidPct >= 5) level = "warn";

  const actionable = {
    level,
    invalidPct,
    unknownPct,
    thresholds: { warnInvalidPct: 5, alertInvalidPct: 20 },
  };

  return {
    n: list.length,
    v4: v4n,
    v6: v6n,
    counts,
    pct: pctAll,
    byFamily: {
      v4: { n: v4n, counts: countsV4, pct: pctV4 },
      v6: { n: v6n, counts: countsV6, pct: pctV6 },
    },
    actionable,
    sample: results,
    source: "ripestat-rpki-validation",
  };
}

async function fetchRipestat(asn) {
  const base = await fetchAsOverview(asn);

  // Keep this endpoint responsive: avoid "announced-prefixes" (can be huge for large ASNs).
  let announcedPrefixes = null;
  let rpkiSample = null;

  try {
    const [counts, samples] = await Promise.all([
      fetchPrefixSizeDistribution(asn),
      fetchRisPrefixSamples(asn),
    ]);

    announcedPrefixes = {
      ...counts,
      sample: {
        v4: samples?.v4 || [],
        v6: samples?.v6 || [],
      },
      sources: {
        counts: counts?.source,
        sample: samples?.source,
      },
    };

    const sampleList = [];
    if (Array.isArray(announcedPrefixes.sample.v4)) sampleList.push(...announcedPrefixes.sample.v4);
    if (Array.isArray(announcedPrefixes.sample.v6)) sampleList.push(...announcedPrefixes.sample.v6);
    rpkiSample = await fetchRpkiSample(asn, sampleList);
  } catch {
    announcedPrefixes = null;
    rpkiSample = null;
  }

  return {
    schemaVersion: ASN_META_SCHEMA_VERSION,
    ...base,
    announcedPrefixes,
    rpkiSample,
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
  let cacheSource = rec ? "kv" : null;
  if (!rec) {
    // 2) Fallback to edge cache
    rec = await readFromEdgeCache(cache, asn);
    cacheSource = rec ? "edge" : null;
  }

  if (rec) {
    const ageSec = Math.max(0, Math.floor((now - rec.fetchedAt) / 1000));

    if (ageSec <= ASN_META_TTL_FRESH_SECONDS) {
      return json(buildResponsePayload(rec.payload, rec.fetchedAt, "hit", { source: cacheSource }));
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
      return json(buildResponsePayload(rec.payload, rec.fetchedAt, "stale", { revalidating, source: cacheSource }));
    }

    // Too old: try to refresh synchronously. If upstream fails, fall back to the expired record.
    try {
      const freshRec = await refreshRecord({ kv, cache, asn });
      return json(buildResponsePayload(freshRec.payload, freshRec.fetchedAt, "miss", { source: "refresh" }));
    } catch {
      return json(buildResponsePayload(rec.payload, rec.fetchedAt, "stale-expired", { revalidating: false, source: cacheSource }));
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

  return json(buildResponsePayload(payload, record.fetchedAt, "miss", { source: "origin" }));
}
