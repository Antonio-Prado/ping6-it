const DNS_QTYPES = new Set([
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "NS",
  "SOA",
  "TXT",
  "PTR",
  "SRV",
  "CAA",
  "NAPTR",
  "DS",
  "DNSKEY",
  "RRSIG",
  "NSEC",
  "NSEC3",
  "TLSA",
  "SVCB",
  "HTTPS",
  "ANY",
]);

const TR_PROTOCOLS = new Set(["ICMP", "UDP", "TCP"]);
const DNS_PROTOCOLS = new Set(["UDP", "TCP"]);
const HTTP_PROTOCOLS = new Set(["HTTP", "HTTPS"]);
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function isIPv4Literal(s) {
  const m = String(s || "").trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  for (let i = 1; i <= 4; i += 1) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

function isIPv6Literal(s) {
  const v = String(s || "").trim();
  if (!v || !v.includes(":")) return false;
  if (v.includes("%")) return false; // zone index not allowed here
  // Very permissive check: hex/colon, possibly with '::'
  if (!/^[0-9a-fA-F:]+$/.test(v)) return false;
  // Limit segments (including empty for ::)
  const parts = v.split(":");
  if (parts.length < 3 || parts.length > 8 + 1) return false;
  return true;
}

export function isIpLiteral(s) {
  return isIPv4Literal(s) || isIPv6Literal(s);
}

function ipv4ToInt(s) {
  const m = String(s).trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if (![a, b, c, d].every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return null;
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

function inCidr4(ipInt, baseInt, maskBits) {
  const mask = maskBits === 0 ? 0 : ((0xffffffff << (32 - maskBits)) >>> 0);
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

function isPrivateIPv4(s) {
  const ipInt = ipv4ToInt(s);
  if (ipInt === null) return false;

  const ranges = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved
  ];

  for (const [base, bits] of ranges) {
    const baseInt = ipv4ToInt(base);
    if (baseInt !== null && inCidr4(ipInt, baseInt, bits)) return true;
  }

  return false;
}

function isPrivateIPv6(s) {
  const v = String(s || "").trim().toLowerCase();
  if (!v) return false;

  if (v === "::" || v === "::1") return true;
  if (v.startsWith("fe80:")) return true; // link-local
  if (v.startsWith("ff")) return true; // multicast

  // ULA fc00::/7
  if (v.startsWith("fc") || v.startsWith("fd")) return true;

  // Documentation 2001:db8::/32
  if (v.startsWith("2001:db8:")) return true;

  return false;
}

export function isPrivateIpLiteral(s) {
  if (isIPv4Literal(s)) return isPrivateIPv4(s);
  if (isIPv6Literal(s)) return isPrivateIPv6(s);
  return false;
}

export function isUnsafeHostname(s) {
  const h = String(s || "").trim().toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home")) return true;
  return false;
}

export function looksLikeUrlOrPath(s) {
  const v = String(s || "");
  if (!v) return false;
  if (/\s/.test(v)) return true;
  if (v.includes("/")) return true;
  if (v.includes("?")) return true;
  if (v.includes("#")) return true;
  if (v.includes("@")) return true;
  if (v.includes("\\")) return true;
  if (v.includes("://")) return true;
  return false;
}

export function sanitizeTarget({ type, target, allowIp = false }) {
  const t = String(target || "").trim();
  if (!t) return { ok: false, error: "invalid_target", message: 'Invalid "target". Expected a non-empty string.' };
  if (t.length > 253) return { ok: false, error: "invalid_target", message: 'Invalid "target". Too long.' };

  // For safety, require a bare host/qname (no scheme/path/query).
  if (looksLikeUrlOrPath(t)) {
    return { ok: false, error: "invalid_target", message: 'Invalid "target". Use a hostname/qname (not a URL/path).' };
  }

  if (isIpLiteral(t)) {
    if (!allowIp) {
      return {
        ok: false,
        error: "invalid_target",
        message: "This backend requires a hostname target (not an IP literal) for IPv4/IPv6 comparison.",
      };
    }
    if (isPrivateIpLiteral(t)) {
      return { ok: false, error: "invalid_target", message: 'Invalid "target". Private/local IPs are not allowed.' };
    }
    return { ok: true, value: t };
  }

  // Hostname checks.
  if (isUnsafeHostname(t)) {
    return { ok: false, error: "invalid_target", message: 'Invalid "target". Local hostnames are not allowed.' };
  }

  // Disallow host:port here. (Port belongs in measurementOptions.port)
  if (t.includes(":")) {
    return { ok: false, error: "invalid_target", message: 'Invalid "target". Do not include a port number.' };
  }

  return { ok: true, value: t };
}

export function sanitizeResolver(raw) {
  const r = String(raw || "").trim();
  if (!r) return { ok: true, value: "" };
  if (r.length > 253) return { ok: false, error: "invalid_resolver", message: "Resolver is too long." };
  if (looksLikeUrlOrPath(r)) return { ok: false, error: "invalid_resolver", message: "Resolver must be a hostname or IP (not a URL/path)." };

  if (isIpLiteral(r)) {
    if (isPrivateIpLiteral(r)) return { ok: false, error: "invalid_resolver", message: "Private/local resolver IPs are not allowed." };
    return { ok: true, value: r };
  }

  if (isUnsafeHostname(r)) return { ok: false, error: "invalid_resolver", message: "Local resolver hostnames are not allowed." };
  if (r.includes(":")) return { ok: false, error: "invalid_resolver", message: "Do not include a port in the resolver field." };

  return { ok: true, value: r };
}

export function sanitizeMeasurementOptions(type, measurementOptions, { backend }) {
  const mo = measurementOptions && typeof measurementOptions === "object" ? measurementOptions : {};

  if (type === "ping") {
    const maxPackets = backend === "atlas" ? 16 : 10;
    return { ok: true, value: { packets: clampInt(mo.packets, { min: 1, max: maxPackets, fallback: 3 }) } };
  }

  if (type === "traceroute") {
    const protocol = String(mo.protocol || "ICMP").toUpperCase();
    const out = { protocol: TR_PROTOCOLS.has(protocol) ? protocol : "ICMP" };
    const packets = mo.packets;
    if (backend === "atlas") {
      out.packets = clampInt(packets, { min: 1, max: 16, fallback: 3 });
    }
    if (out.protocol !== "ICMP") {
      out.port = clampInt(mo.port, { min: 1, max: 65535, fallback: 80 });
    }
    return { ok: true, value: out };
  }

  if (type === "mtr") {
    const protocol = String(mo.protocol || "ICMP").toUpperCase();
    const out = {
      packets: clampInt(mo.packets, { min: 1, max: 16, fallback: 3 }),
      protocol: TR_PROTOCOLS.has(protocol) ? protocol : "ICMP",
    };
    if (out.protocol !== "ICMP") {
      out.port = clampInt(mo.port, { min: 1, max: 65535, fallback: 80 });
    }
    return { ok: true, value: out };
  }

  if (type === "dns") {
    const qType = String(mo?.query?.type || "A").toUpperCase();
    const protocol = String(mo.protocol || "UDP").toUpperCase();
    const out = {
      query: { type: DNS_QTYPES.has(qType) ? qType : "A" },
      protocol: DNS_PROTOCOLS.has(protocol) ? protocol : "UDP",
      port: clampInt(mo.port, { min: 1, max: 65535, fallback: 53 }),
      trace: Boolean(mo.trace),
    };

    const r = sanitizeResolver(mo.resolver);
    if (!r.ok) return r;
    if (r.value) out.resolver = r.value;

    return { ok: true, value: out };
  }

  if (type === "http") {
    const protocol = String(mo.protocol || "HTTPS").toUpperCase();
    const method = String(mo?.request?.method || "GET").toUpperCase();

    let path = String(mo?.request?.path || "/").trim() || "/";
    if (!path.startsWith("/")) path = `/${path}`;
    if (path.length > 1024) path = path.slice(0, 1024);
    if (/[\r\n]/.test(path)) return { ok: false, error: "invalid_http_path", message: "Invalid HTTP path." };

    let query = String(mo?.request?.query || "").trim();
    if (query.startsWith("?")) query = query.slice(1);
    if (query.length > 1024) query = query.slice(0, 1024);
    if (/[\r\n]/.test(query)) return { ok: false, error: "invalid_http_query", message: "Invalid HTTP query." };

    const out = {
      protocol: HTTP_PROTOCOLS.has(protocol) ? protocol : "HTTPS",
      request: {
        method: HTTP_METHODS.has(method) ? method : "GET",
        path,
      },
    };
    if (query) out.request.query = query;

    const r = sanitizeResolver(mo.resolver);
    if (!r.ok) return r;
    if (r.value) out.resolver = r.value;

    if (mo.port != null && mo.port !== "") {
      const port = clampInt(mo.port, { min: 1, max: 65535, fallback: 0 });
      if (port) out.port = port;
    }

    return { ok: true, value: out };
  }

  return { ok: false, error: "invalid_type", message: `Unsupported measurement type: ${String(type)}.` };
}

export function sanitizeLocations(locations) {
  // Only accept a single location object from the client.
  const loc = Array.isArray(locations) ? locations[0] : null;
  if (!loc || typeof loc !== "object") return [];

  const out = {};
  if (typeof loc.magic === "string" && loc.magic.trim()) out.magic = loc.magic.trim();
  const asn = Number(loc.asn);
  if (Number.isFinite(asn) && asn > 0) out.asn = asn;
  if (typeof loc.isp === "string" && loc.isp.trim()) out.isp = loc.isp.trim();

  return Object.keys(out).length ? [out] : [];
}
