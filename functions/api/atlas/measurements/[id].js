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

function normalizeProbe(p) {
  const id = String(p?.id ?? p?.pk ?? p?.prb_id ?? p?.probe_id ?? "");

  const coords = p?.geometry?.coordinates;
  const lon = Array.isArray(coords) ? toNumber(coords[0]) : null;
  const lat = Array.isArray(coords) ? toNumber(coords[1]) : null;

  const asn = toNumber(p?.asn_v4 ?? p?.asn_v6 ?? p?.asn);
  const network = String(p?.asn_v4_name ?? p?.asn_v6_name ?? p?.network ?? "");

  return {
    id,
    city: p?.city || "",
    country: p?.country_code || p?.country || "",
    asn: asn || undefined,
    network: network || undefined,
    latitude: lat || undefined,
    longitude: lon || undefined,
  };
}

async function fetchProbeMap(ids, apiKey, signal) {
  const unique = Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)));
  if (!unique.length) return {};

  // Try a batched query first. If it fails, fall back to per-probe calls.
  const joined = unique.join(",");
  try {
    const data = await atlasGetJson(`/api/v2/probes/?id__in=${encodeURIComponent(joined)}&limit=${unique.length}`, apiKey, signal);
    const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    const map = {};
    for (const p of results) {
      const np = normalizeProbe(p);
      if (np.id) map[np.id] = np;
    }
    if (Object.keys(map).length) return map;
  } catch {
    // ignore
  }

  const map = {};
  await Promise.all(
    unique.map(async (id) => {
      try {
        const p = await atlasGetJson(`/api/v2/probes/${encodeURIComponent(id)}/`, apiKey, signal);
        const np = normalizeProbe(p);
        if (np.id) map[np.id] = np;
      } catch {
        // ignore
      }
    })
  );
  return map;
}

function computePingStats(r) {
  const sent = toNumber(r?.sent) ?? (Array.isArray(r?.result) ? r.result.length : null);
  const rcvd = toNumber(r?.rcvd) ?? (Array.isArray(r?.result) ? r.result.filter((x) => Number.isFinite(Number(x?.rtt))).length : null);

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
  const total = toNumber(r?.rt);
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

  const apiKey = extractAtlasKey(request, env);
  if (!apiKey && !env.ATLAS_API_KEY) {
    // Results for private measurements may require auth; fail early with a helpful message.
    return json({ error: "missing_atlas_api_key" }, 400);
  }

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
    const prbIds = rows.map((r) => String(r?.prb_id || "")).filter(Boolean);
    const probeMap = await fetchProbeMap(prbIds, apiKey, request.signal);

    const normalized = rows
      .map((r) => {
        const prbId = String(r?.prb_id || "");
        const probe = probeMap[prbId] || { id: prbId };
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
