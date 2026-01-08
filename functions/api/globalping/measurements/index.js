const UPSTREAM = "https://api.globalping.io/v1/measurements";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function hasSchemeOrPath(t) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) return true;
  if (t.includes("/") || t.includes("?") || t.includes("#")) return true;
  return false;
}

function isIpv4Literal(t) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(t);
}

function isIpv6Literal(t) {
  return t.includes(":") && /^[0-9a-fA-F:]+$/.test(t);
}

function isBlockedIpLiteral(t) {
  const s = t.toLowerCase();

  if (isIpv4Literal(s)) {
    const p = s.split(".").map((x) => Number(x));
    if (p.some((x) => !Number.isFinite(x) || x < 0 || x > 255)) return true;
    const [a, b] = p;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224 && a <= 239) return true;
    return false;
  }

  if (isIpv6Literal(s)) {
    if (s === "::1" || s === "::") return true;
    if (s.startsWith("fe80:")) return true;
    if (s.startsWith("fc") || s.startsWith("fd")) return true;
    if (s.startsWith("ff")) return true;
    return false;
  }

  return false;
}

function sanitize(body) {
  if (!body || typeof body !== "object") throw new Error("Invalid JSON body");

  const type = String(body.type || "").trim();
  if (!["ping", "traceroute", "mtr", "dns"].includes(type)) {
    throw new Error("Unsupported type (allowed: ping, traceroute, mtr, dns)");
  }

  const target = String(body.target || "").trim();
  if (!target) throw new Error("Missing target");
  if (target.length > 253) throw new Error("Target too long");
  if (/\s/.test(target)) throw new Error("Target contains spaces");
  if (hasSchemeOrPath(target)) throw new Error("Target must be hostname/IP only (no scheme/path)");
  if (isBlockedIpLiteral(target)) throw new Error("Blocked target IP (private/local)");

  let locations = body.locations;
  if (typeof locations === "string") {
    const id = locations.trim();
    if (!id) throw new Error("Invalid locations id");
    if (id.length > 64) throw new Error("locations id too long");
    locations = id;
  } else if (Array.isArray(locations)) {
    if (locations.length > 10) throw new Error("Too many locations");
  } else {
    throw new Error("Missing/invalid locations");
  }

  const limit = clampInt(body.limit, 1, 10, 3);
  const inProgressUpdates = Boolean(body.inProgressUpdates);

  const moIn = body.measurementOptions && typeof body.measurementOptions === "object" ? body.measurementOptions : {};
  const mo = {};

  if (moIn.ipVersion !== undefined) {
    const ipV = Number(moIn.ipVersion);
    if (ipV !== 4 && ipV !== 6) throw new Error("Invalid ipVersion (only 4 or 6)");
    mo.ipVersion = ipV;
  }

  if (type === "ping") {
    mo.packets = clampInt(moIn.packets, 1, 10, 3);
  }

  if (type === "traceroute") {
    const proto = String(moIn.protocol || "ICMP").toUpperCase();
    if (!["ICMP", "TCP", "UDP"].includes(proto)) throw new Error("Invalid traceroute protocol");
    mo.protocol = proto;
    if (proto === "TCP") mo.port = clampInt(moIn.port, 1, 65535, 80);
  }

  if (type === "mtr") {
    const proto = String(moIn.protocol || "ICMP").toUpperCase();
    if (!["ICMP", "TCP", "UDP"].includes(proto)) throw new Error("Invalid mtr protocol");
    mo.protocol = proto;
    mo.packets = clampInt(moIn.packets, 1, 16, 3);
    if (proto !== "ICMP") mo.port = clampInt(moIn.port, 1, 65535, 80);
  }

  if (type === "dns") {
			// query può arrivare come stringa ("A") oppure come oggetto { type: "A" }
let qType = "A";
if (typeof moIn.query === "string") qType = moIn.query;
else if (moIn.query && typeof moIn.query === "object") qType = moIn.query.type || "A";

qType = String(qType).toUpperCase();

const allowedQ = new Set([
  "A","AAAA","ANY","CNAME","DNSKEY","DS","HTTPS","MX","NS","NSEC","PTR","RRSIG","SOA","TXT","SRV","SVCB"
]);
if (!allowedQ.has(qType)) throw new Error("Invalid dns query type");

mo.query = { type: qType };

  }

  return {
    type,
    target,
    locations,
    limit,
    inProgressUpdates,
    measurementOptions: mo,
  };
}

export async function onRequest(context) {
  const req = context.request;

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  let sanitized;
  try {
    sanitized = sanitize(body);
  } catch (e) {
    return json(400, { error: e.message || "Bad request" });
  }

  const headers = new Headers();
  headers.set("content-type", "application/json");

  const auth = req.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) headers.set("x-api-key", xApiKey);

  const resp = await fetch(UPSTREAM, {
    method: "POST",
    headers,
    body: JSON.stringify(sanitized),
  });

  const outHeaders = new Headers(resp.headers);
  outHeaders.set("cache-control", "no-store");

  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

