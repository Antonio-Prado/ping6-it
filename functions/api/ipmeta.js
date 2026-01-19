import { applyRateLimit } from "./_lib/rateLimit";
import { isIpLiteral, isPrivateIpLiteral } from "./_lib/guardrails";

const RIPENETWORKINFO = "https://stat.ripe.net/data/network-info/data.json";
const RIPEASOVERVIEW = "https://stat.ripe.net/data/as-overview/data.json";
const BGPVIEW_IP = "https://api.bgpview.io/ip";

const IPMETA_TTL_SEC = 7 * 24 * 60 * 60;
const ASN_HOLDER_TTL_SEC = 30 * 24 * 60 * 60;

function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function cacheKeyForIp(ip) {
  return new Request(`https://ipmeta.local/${encodeURIComponent(ip)}`);
}

async function kvGetJson(kv, key) {
  if (!kv?.get) return null;
  try {
    return await kv.get(key, { type: "json" });
  } catch {
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

async function cacheGetJson(ip) {
  try {
    const hit = await caches.default.match(cacheKeyForIp(ip));
    if (!hit) return null;
    const text = await hit.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function cachePutJson(ip, value, ttlSec) {
  try {
    const res = new Response(JSON.stringify(value), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${Math.max(60, Math.ceil(ttlSec))}`,
      },
    });
    await caches.default.put(cacheKeyForIp(ip), res);
    return true;
  } catch {
    return false;
  }
}

async function fetchJsonWithTimeout(url, { timeoutMs = 8000, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try {
      ac.abort();
    } catch {}
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...headers,
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      const err = new Error(`Upstream ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(s) {
  const v = typeof s === "string" ? s.trim() : "";
  if (!v) return "";
  return v.replace(/\s+/g, " ").trim();
}

function parseRipestatNetworkInfo(body) {
  const data = body && typeof body === "object" ? body.data : null;
  if (!data || typeof data !== "object") return null;

  const asns = Array.isArray(data.asns) ? data.asns : null;
  const asn = Number.isFinite(Number(data.asn)) ? Number(data.asn) : asns && asns.length ? Number(asns[0]) : null;
  const prefix = cleanText(data.prefix);

  if (!Number.isFinite(asn)) return null;
  return { asn: Number(asn), prefix: prefix || null };
}

async function ripestatHolder(asn, { timeoutMs = 7000 } = {}) {
  const url = new URL(RIPEASOVERVIEW);
  url.searchParams.set("resource", `AS${asn}`);
  const body = await fetchJsonWithTimeout(url.toString(), { timeoutMs });
  const data = body && typeof body === "object" ? body.data : null;
  const holder = cleanText(data?.holder);
  return holder || null;
}

function reverseIpv4(ip) {
  return ip
    .trim()
    .split(".")
    .reverse()
    .join(".");
}

function expandIpv6ToHex32(ip) {
  const raw = String(ip || "").trim().toLowerCase();
  if (!raw || !raw.includes(":")) return null;
  if (raw.includes("%")) return null;

  // IPv4-mapped IPv6 is not expected here; ignore if present.
  const v = raw.includes(".") ? raw.slice(0, raw.lastIndexOf(":")) + ":0" : raw;

  const parts = v.split("::");
  if (parts.length > 2) return null;

  const left = parts[0] ? parts[0].split(":").filter((x) => x.length > 0) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":").filter((x) => x.length > 0) : [];

  const total = left.length + right.length;
  if (total > 8) return null;

  const missing = 8 - total;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return null;

  const hex = groups
    .map((g) => {
      const h = String(g).trim();
      if (!h) return "0000";
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      return h.padStart(4, "0");
    })
    .filter((x) => x !== null);

  if (hex.length !== 8) return null;
  return hex.join("");
}

function nibbleReverse(hex32) {
  return hex32.split("").reverse().join(".");
}

async function cymruLookup(ip, { timeoutMs = 6000 } = {}) {
  const isV6 = String(ip).includes(":");
  let qname = null;
  if (!isV6) {
    qname = `${reverseIpv4(ip)}.origin.asn.cymru.com`;
  } else {
    const hex32 = expandIpv6ToHex32(ip);
    if (!hex32) return null;
    qname = `${nibbleReverse(hex32)}.origin6.asn.cymru.com`;
  }

  const doh = new URL("https://dns.google/resolve");
  doh.searchParams.set("name", qname);
  doh.searchParams.set("type", "TXT");

  const body = await fetchJsonWithTimeout(doh.toString(), { timeoutMs });
  const ans = Array.isArray(body?.Answer) ? body.Answer : [];
  const txt = cleanText(ans?.[0]?.data || "");
  const cleaned = txt.replace(/^"|"$/g, "");
  const parts = cleaned.split("|").map((x) => x.trim()).filter(Boolean);
  const asn = Number(parts[0]);
  const prefix = cleanText(parts[1] || "");
  if (!Number.isFinite(asn)) return null;

  let holder = null;
  try {
    const q2 = new URL("https://dns.google/resolve");
    q2.searchParams.set("name", `AS${asn}.asn.cymru.com`);
    q2.searchParams.set("type", "TXT");
    const body2 = await fetchJsonWithTimeout(q2.toString(), { timeoutMs: Math.min(timeoutMs, 5000) });
    const ans2 = Array.isArray(body2?.Answer) ? body2.Answer : [];
    const txt2 = cleanText(ans2?.[0]?.data || "").replace(/^"|"$/g, "");
    const parts2 = txt2.split("|").map((x) => x.trim()).filter(Boolean);
    if (parts2.length) holder = cleanText(parts2[parts2.length - 1]);
  } catch {
    // ignore
  }

  return {
    asn,
    prefix: prefix || null,
    holder: holder || null,
    source: "cymru-doh",
  };
}

async function bgpviewLookup(ip, { timeoutMs = 8000 } = {}) {
  const url = `${BGPVIEW_IP}/${encodeURIComponent(ip)}`;
  const body = await fetchJsonWithTimeout(url, { timeoutMs });
  const data = body && typeof body === "object" ? body.data : null;
  const p0 = Array.isArray(data?.prefixes) ? data.prefixes[0] : null;
  const asn = Number(p0?.asn?.asn);
  if (!Number.isFinite(asn)) return null;

  const prefix = cleanText(p0?.prefix);
  const holder = cleanText(p0?.asn?.description || p0?.asn?.name);

  return {
    asn,
    prefix: prefix || null,
    holder: holder || null,
    source: "bgpview",
  };
}

async function resolveIpMeta(ip, { kv } = {}) {
  // 1) RIPEstat network-info
  try {
    const u = new URL(RIPENETWORKINFO);
    u.searchParams.set("resource", ip);
    const body = await fetchJsonWithTimeout(u.toString(), { timeoutMs: 8000 });
    const info = parseRipestatNetworkInfo(body);
    if (info?.asn) {
      let holder = null;
      // Prefer cached ASN holder if available
      if (kv) {
        const h = await kvGetJson(kv, `asnholder:v1:${info.asn}`);
        if (h && typeof h === "object") holder = cleanText(h?.holder) || null;
      }
      if (!holder) {
        try {
          holder = await ripestatHolder(info.asn, { timeoutMs: 7000 });
          if (holder && kv) {
            await kvPutJson(kv, `asnholder:v1:${info.asn}`, { holder, fetchedAt: Date.now() }, ASN_HOLDER_TTL_SEC);
          }
        } catch {
          // ignore
        }
      }

      return {
        ip,
        asn: info.asn,
        prefix: info.prefix || null,
        holder: holder || null,
        source: "ripestat",
        fetchedAt: Date.now(),
      };
    }
  } catch {
    // ignore
  }

  // 2) Team Cymru via DNS-over-HTTPS
  try {
    const c = await cymruLookup(ip, { timeoutMs: 6500 });
    if (c?.asn) {
      return {
        ip,
        asn: c.asn,
        prefix: c.prefix || null,
        holder: c.holder || null,
        source: c.source || "cymru-doh",
        fetchedAt: Date.now(),
      };
    }
  } catch {
    // ignore
  }

  // 3) BGPView
  try {
    const b = await bgpviewLookup(ip, { timeoutMs: 8000 });
    if (b?.asn) {
      return {
        ip,
        asn: b.asn,
        prefix: b.prefix || null,
        holder: b.holder || null,
        source: b.source || "bgpview",
        fetchedAt: Date.now(),
      };
    }
  } catch {
    // ignore
  }

  return {
    ip,
    asn: null,
    prefix: null,
    holder: null,
    source: "none",
    fetchedAt: Date.now(),
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, { status: 405 });
  }

  const rl = await applyRateLimit({ request, env, scope: "ipmeta", limit: 90, windowSec: 600 });
  if (rl.limited) {
    return json({ error: "rate_limited", retryAfterSec: rl.retryAfterSec }, { status: 429, headers: rl.headers });
  }

  let payload = null;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400, headers: rl.headers });
  }

  const ipsRaw = Array.isArray(payload?.ips) ? payload.ips : [];
  const maxN = clampInt(payload?.max || ipsRaw.length || 0, { min: 1, max: 200, fallback: 200 });

  const ips = [];
  const seen = new Set();
  for (const raw of ipsRaw) {
    const ip = String(raw || "").trim();
    if (!ip) continue;
    if (seen.has(ip)) continue;
    seen.add(ip);

    if (!isIpLiteral(ip)) continue;
    if (isPrivateIpLiteral(ip)) continue;

    ips.push(ip);
    if (ips.length >= maxN) break;
  }

  if (!ips.length) {
    return json({ ips: [], meta: {} }, { status: 200, headers: rl.headers });
  }

  const kv = env?.ASN_META_KV || env?.IPMETA_KV || null;
  const out = {};

  // 1) cache lookup (KV, then caches.default)
  const toFetch = [];
  for (const ip of ips) {
    const key = `ipmeta:v1:${ip}`;
    let hit = null;
    if (kv) hit = await kvGetJson(kv, key);
    if (!hit) hit = await cacheGetJson(ip);

    if (hit && typeof hit === "object") {
      out[ip] = hit;
    } else {
      toFetch.push(ip);
    }
  }

  // 2) fetch missing
  for (const ip of toFetch) {
    const resolved = await resolveIpMeta(ip, { kv });
    out[ip] = resolved;

    const key = `ipmeta:v1:${ip}`;
    const okKv = kv ? await kvPutJson(kv, key, resolved, IPMETA_TTL_SEC) : false;
    if (!okKv) {
      await cachePutJson(ip, resolved, 3600);
    }
  }

  return json(
    {
      ips,
      meta: out,
      cache: {
        ttlSec: IPMETA_TTL_SEC,
        source: kv ? "kv" : "cache",
      },
    },
    { status: 200, headers: rl.headers }
  );
}
