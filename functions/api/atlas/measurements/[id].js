const ATLAS_BASE = "https://atlas.ripe.net";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
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

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}


function normalizeProbeMeta(p) {
  const id = String(p?.id ?? "").trim();

  // RIPE Atlas probe API generally exposes a 2-letter country code.
  // Be tolerant to schema differences across API versions.
  const countryCode = String(p?.country_code ?? p?.country ?? p?.countryCode ?? "").trim();

  // City is not guaranteed, but include it if available.
  const city = String(p?.city ?? p?.location?.city ?? p?.place?.city ?? "").trim();

  const asnV6 = toNumber(p?.asn_v6);
  const asnV4 = toNumber(p?.asn_v4);
  const asnAny = toNumber(p?.asn);

  // Atlas may report 0 when the ASN is unknown for a given address-family.
  // Prefer the first positive ASN we can find (v6, then v4, then generic).
  const asn = [asnV6, asnV4, asnAny].find((n) => Number.isFinite(n) && n > 0) ?? undefined;

  let latitude;
  let longitude;
  const coords = p?.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      latitude = lat;
      longitude = lon;
    }
  }

  return {
    id: id || undefined,
    city: city || undefined,
    country: countryCode || undefined,
    country_code: countryCode || undefined,
    asn,
    latitude,
    longitude,
  };
}


const PROBE_META_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PROBE_META_CACHE_PREFIX = "https://ping6.it/_cache/atlas/probe-meta/";

function probeMetaCacheKey(pid) {
  return `${PROBE_META_CACHE_PREFIX}${encodeURIComponent(String(pid))}`;
}

function getDefaultCache() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

async function cacheReadProbeMeta(cache, pid) {
  if (!cache) return null;
  try {
    const req = new Request(probeMetaCacheKey(pid));
    const res = await cache.match(req);
    if (!res) return null;
    const data = await res.json();
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

async function cacheWriteProbeMeta(cache, pid, meta) {
  if (!cache || !meta || typeof meta !== "object") return;
  try {
    const req = new Request(probeMetaCacheKey(pid));
    const res = new Response(JSON.stringify(meta), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${PROBE_META_CACHE_TTL_SECONDS}`,
      },
    });
    await cache.put(req, res);
  } catch {
    // ignore
  }
}

async function fetchProbeMetaMap(probeIds, apiKey, signal) {
  const ids = Array.from(new Set((probeIds || []).map((x) => String(x).trim()).filter(Boolean)));
  if (!ids.length) return new Map();

  // Keep it bounded to avoid slow responses.
  const MAX = 80;
  const limited = ids.slice(0, MAX);

  const fields = "id,country_code,asn_v4,asn_v6,geometry,city";
  const cache = getDefaultCache();

  // 1) Try cache first.
  const map = new Map();
  if (cache) {
    const cached = await Promise.all(limited.map((pid) => cacheReadProbeMeta(cache, pid)));
    for (const meta of cached) {
      if (meta?.id) map.set(String(meta.id), meta);
    }
  }

  const remaining = limited.filter((pid) => !map.has(String(pid)));
  if (!remaining.length) return map;

  // 2) Attempt a batched lookup. If the API doesn't support the filter, we'll
  // still fall back to per-probe lookups for the missing ids.
  try {
    const qs = new URLSearchParams({
      id__in: remaining.join(","),
      limit: String(remaining.length),
      fields,
    });
    const data = await atlasGetJson(`/api/v2/probes/?${qs.toString()}`, apiKey, signal);
    const list = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    for (const p of list) {
      const meta = normalizeProbeMeta(p);
      if (meta.id) {
        map.set(String(meta.id), meta);
        await cacheWriteProbeMeta(cache, meta.id, meta);
      }
    }
  } catch {
    // ignore
  }

  // 3) Fill gaps (or fully resolve) via per-probe lookups.
  const missing = remaining.filter((pid) => !map.has(String(pid)));
  if (!missing.length) return map;

  const settled = await Promise.all(
    missing.map(async (pid) => {
      // Cache might have been populated by a previous request while we were waiting.
      const cached = await cacheReadProbeMeta(cache, pid);
      if (cached?.id) return cached;

      try {
        let p;
        try {
          p = await atlasGetJson(
            `/api/v2/probes/${encodeURIComponent(pid)}/?fields=${encodeURIComponent(fields)}`,
            apiKey,
            signal
          );
        } catch {
          // Some Atlas deployments are picky about the `fields=` parameter.
          // Fallback to the full probe payload if the filtered request fails.
          p = await atlasGetJson(`/api/v2/probes/${encodeURIComponent(pid)}/`, apiKey, signal);
        }
        const meta = normalizeProbeMeta(p);
        if (meta?.id) await cacheWriteProbeMeta(cache, meta.id, meta);
        return meta;
      } catch {
        return null;
      }
    })
  );

  for (const meta of settled) {
    if (meta?.id) map.set(String(meta.id), meta);
  }
  return map;
}


function computePingStats(r) {
  const sent = toNumber(r?.sent) ?? (Array.isArray(r?.result) ? r.result.length : null);
  const rcvd =
    toNumber(r?.rcvd) ??
    (Array.isArray(r?.result) ? r.result.filter((x) => Number.isFinite(Number(x?.rtt))).length : null);

  let avg = toNumber(r?.avg);
  if (avg === null && Array.isArray(r?.result)) {
    const rtts = r.result.map((x) => toNumber(x?.rtt)).filter((x) => x !== null);
    if (rtts.length) {
      avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
    }
  }

  let loss = null;
  if (sent && rcvd !== null) {
    loss = ((sent - rcvd) / sent) * 100;
  }

  return { avg: avg ?? undefined, loss: loss ?? undefined };
}

function normalizePingResult(r, probe) {
  const stats = computePingStats(r);
  const status = r?.error ? "failed" : "finished";
  return {
    probe,
    result: {
      status,
      stats,
      atlas: {
        timestamp: r?.timestamp,
        from: r?.from,
      },
    },
  };
}

function normalizeTracerouteResult(r, probe) {
  const hopsRaw = Array.isArray(r?.result) ? r.result : [];
  const hops = hopsRaw
    .map((h) => {
      const hop = toNumber(h?.hop) ?? undefined;
      const responses = Array.isArray(h?.result) ? h.result : [];
      const timings = responses
        .map((x) => {
          const rtt = toNumber(x?.rtt);
          return rtt === null ? null : { rtt };
        })
        .filter(Boolean);

      const firstFrom = responses.map((x) => String(x?.from || "").trim()).find(Boolean) || "";
      if (!firstFrom && !timings.length) return null;

      return {
        hop,
        resolvedAddress: firstFrom || undefined,
        resolvedHostname: undefined,
        timings,
      };
    })
    .filter(Boolean);

  return {
    probe,
    result: {
      status: r?.error ? "failed" : "finished",
      resolvedAddress: r?.dst_addr || undefined,
      resolvedHostname: r?.dst_name || undefined,
      hops,
      atlas: {
        timestamp: r?.timestamp,
        from: r?.from,
        paris_id: r?.paris_id,
      },
    },
  };
}

function normalizeDnsResult(r, probe) {
  const rts = [];
  const addRt = (val) => {
    const n = toNumber(val);
    if (n !== null) rts.push(n);
  };
  const collectFromResultset = (resultset) => {
    if (!Array.isArray(resultset)) return;
    for (const entry of resultset) {
      addRt(entry?.rt);
      if (Array.isArray(entry?.result)) {
        for (const sub of entry.result) addRt(sub?.rt);
      }
    }
  };

  addRt(r?.rt);
  collectFromResultset(r?.resultset);

  const nested = Array.isArray(r?.result) ? r.result : r?.result ? [r.result] : [];
  for (const entry of nested) {
    addRt(entry?.rt);
    collectFromResultset(entry?.resultset);
    if (Array.isArray(entry?.result)) {
      for (const sub of entry.result) addRt(sub?.rt);
    }
  }

  const total = rts.length ? rts.reduce((sum, val) => sum + val, 0) / rts.length : null;
  return {
    probe,
    result: {
      status: r?.error ? "failed" : "finished",
      timings: {
        total: total ?? undefined,
      },
      atlas: {
        timestamp: r?.timestamp,
        from: r?.from,
        err: r?.err,
        resultset: r?.resultset,
      },
    },
  };
}

function deriveStatus(meta, resultsLen) {
  const name = String(meta?.status?.name || meta?.status_name || meta?.status || "").toLowerCase();
  if (name.includes("stopped") || name.includes("finished") || name.includes("completed")) return "finished";

  const now = Math.floor(Date.now() / 1000);
  const stop = toNumber(meta?.stop_time);
  if (stop && stop <= now) return "finished";

  if (resultsLen > 0 && meta?.is_oneoff) {
    const start = toNumber(meta?.start_time);
    if (start && now - start > 120) return "finished";
  }

  return "in-progress";
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const id = String(params?.id || "").trim();
  if (!id) return json({ error: "missing_id" }, 400);

  // NOTE: results are usually public. We try without auth when no key is provided.
  const apiKey = extractAtlasKey(request, env);

  const now = Math.floor(Date.now() / 1000);
  const start = now - 3600;

  try {
    const meta = await atlasGetJson(`/api/v2/measurements/${encodeURIComponent(id)}/`, apiKey, request.signal);
    const rawResults = await atlasGetJson(
      `/api/v2/measurements/${encodeURIComponent(id)}/results/?format=json&start=${start}`,
      apiKey,
      request.signal
    );

    const rows = Array.isArray(rawResults) ? rawResults : [];

    const probeMeta = await fetchProbeMetaMap(
      rows.map((r) => r?.prb_id),
      apiKey,
      request.signal
    );

    const normalized = rows
      .map((r) => {
        const prbId = String(r?.prb_id || "");
        const probe = probeMeta.get(prbId) || { id: prbId };
        const type = String(r?.type || meta?.type || "").toLowerCase();
        if (type === "ping") return normalizePingResult(r, probe);
        if (type === "traceroute") return normalizeTracerouteResult(r, probe);
        if (type === "dns") return normalizeDnsResult(r, probe);
        return null;
      })
      .filter(Boolean);

    const status = deriveStatus(meta, normalized.length);

    return json({
      backend: "atlas",
      id,
      status,
      statusName: meta?.status?.name || meta?.status_name || meta?.status || undefined,
      type: meta?.type || undefined,
      af: meta?.af || undefined,
      results: normalized,
      atlas: {
        measurement: meta,
        results: rows,
      },
    });
  } catch (e) {
    return json({ error: "atlas_failed", status: e.status || 500, details: e.data || {} }, e.status || 500);
  }
}
