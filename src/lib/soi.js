// Trombone routing and the place of the probes, read with the speed of Internet (SOI).
//
// Ported from ASPA Explorer (site/traceroute.js, University of Padova), where the method was built and tested, and adapted to
// what this site measures: the same target over IPv4 and IPv6 from the same probes.
//
// Two facts carry everything here.
// 1. Light in fibre travels at about two thirds of its speed in vacuum, about 200 km in a millisecond. A round trip of t ms
//    therefore proves that the two ends are at most t/2 * 200 km apart: a delay is an upper bound on a distance. Queues, slow
//    answers and tunnels only add time, so the bound never lies in the other direction.
// 2. A probe is placed by somebody: Globalping by the address it connects from (geolocation databases), RIPE Atlas by its
//    host. Izhikevich and others ("Rooting Out Incorrect RIPE Atlas Probe Geolocations", IMC 2026, doi:10.1145/3777912.3839804)
//    test that place with the round trips to the DNS root servers: a round trip shorter than light in fibre allows from the
//    declared place proves that the probe is elsewhere. The same rule works with any reference point whose place is known, and
//    a traceroute carries its own: a hop that answers from the LAN of an exchange point is on the other side of that exchange's
//    switch, so the packet went at least to the nearest site of the exchange and came back.
//
// Pure functions only: the page does the requests (src/lib/placeData.js).

export const FIBRE_KM_PER_MS = (299792.458 * 2) / 3 / 1000; // light in fibre, 2/3 of c: about 200 km in a millisecond
export const PLACE_MARGIN_KM = 100; // places are cities, not points
export const ROOT_MARGIN_KM = 300; // the place of a root instance is read from the code of its city or airport
export const LONG_DELAY_MS = 50; // a net round trip up to this is the one of a target that is near
export const TROMBONE_MS = 100; // from here the packet has crossed an ocean, or gone round a continent twice
export const LONG_GAP_MS = 25; // the least difference between the families that is worth calling "longer"

const toNum = (s) => s.split(".").reduce((n, x) => n * 256 + Number(x), 0);

// An address as a family and a number (BigInt), or null: dotted IPv4, IPv6 with or without ::
export function parseIp(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) {
    const parts = t.split(".").map(Number);
    return parts.some((x) => x > 255) ? null : { family: 4, bits: 32, n: BigInt(toNum(t)) };
  }
  if (!/^[0-9a-f:]+$/.test(t) || !t.includes(":") || (t.match(/::/g) || []).length > 1 || t.includes(":::")) return null;
  const [head, tail] = t.includes("::") ? t.split("::") : [t, null];
  const h = head ? head.split(":") : [];
  const tl = tail ? tail.split(":") : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - tl.length).fill("0"), ...tl];
  if (groups.length !== 8 || (tail !== null && h.length + tl.length > 7) || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return { family: 6, bits: 128, n: groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g, 16)), 0n) };
}

// Addresses that say nothing about the route: private, shared, link-local, loopback.
export function isPrivate(ip) {
  if (!ip) return true;
  if (ip.includes(":")) return /^(fc|fd|fe[89ab]|::1$|::$)/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) || a === 0 || a >= 224
  );
}

// The distance on the Earth between two [latitude, longitude], in km.
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// From a place, a round trip to a point `km` away takes at least this many milliseconds: light in fibre there and back, less
// the margin.
export const soiFloor = (km, margin = PLACE_MARGIN_KM) => (2 * Math.max(0, km - margin)) / FIBRE_KM_PER_MS;

// How far the other end of a round trip can be, in km.
export const soiReach = (rtt) => (rtt / 2) * FIBRE_KM_PER_MS;

// A declared place against reference points whose place is known: refs [{ sites: [[lat, lon], ...], rtt, margin?, ...what to tell }].
// A round trip shorter than the floor for the nearest site of a reference proves that the probe is elsewhere. How many
// references could be used, the strongest proof (the round trip that misses the floor by most), or null, and every reference
// that was used with its figures (points: km to its nearest site, the least round trip from the place, how far from it the
// probe can be, and whether the round trip is long enough for the place).
export function soiCheck(lat, lon, refs) {
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return { checked: 0, misplaced: null, points: [] };
  let checked = 0;
  let worst = null;
  const points = [];
  for (const r of refs || []) {
    if (typeof r.rtt !== "number" || !(r.rtt > 0) || !Array.isArray(r.sites) || !r.sites.length) continue;
    checked++;
    const margin = typeof r.margin === "number" ? r.margin : PLACE_MARGIN_KM;
    const km = Math.min(...r.sites.map((s) => distanceKm([lat, lon], s)));
    const atLeast = soiFloor(km, margin);
    const { sites: _sites, ...rest } = r;
    const point = { ...rest, margin, km: Math.round(km), atLeast: Math.round(atLeast * 10) / 10, within: Math.round(margin + soiReach(r.rtt)), ok: !(r.rtt < atLeast) };
    points.push(point);
    if (!point.ok && (!worst || atLeast - r.rtt > worst.gap)) worst = { point, gap: atLeast - r.rtt };
  }
  return { checked, misplaced: worst ? worst.point : null, points };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Exchange points (PeeringDB)

// A prefix of a LAN as it can be used: IPv4 from /16 to /30, IPv6 from /32 to /126, in lower case; null for anything else.
export function lanPrefix(text) {
  const m = /^([0-9a-f.:]+)\/(\d{1,3})$/i.exec(String(text || "").trim());
  const net = m && parseIp(m[1]);
  const len = m ? Number(m[2]) : 0;
  if (!net || (net.family === 6 ? len < 32 || len > 126 : len < 16 || len > 30)) return null;
  return `${m[1].toLowerCase()}/${len}`;
}

// The exchanges from the tables of PeeringDB (ixpfx, ixlan, ix, ixfac, fac, as the API gives them with depth=0): those with a
// usable prefix and a facility with coordinates. A site is [latitude, longitude] rounded to three decimals (about 100 m),
// once for each place.
export function ixpsFrom({ ixpfx = [], ixlan = [], ix = [], ixfac = [], fac = [] }) {
  const ixOfLan = new Map(ixlan.map((l) => [l.id, l.ix_id]));
  const place = new Map();
  for (const f of fac) {
    const lat = Number(f.latitude);
    const lon = Number(f.longitude);
    if (f.status !== "ok" || f.latitude === null || f.longitude === null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    place.set(f.id, [Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000]);
  }
  const prefixes = new Map();
  const sites = new Map();
  for (const p of ixpfx) {
    const id = ixOfLan.get(p.ixlan_id);
    const pfx = lanPrefix(p.prefix);
    if (id === undefined || !pfx) continue;
    if (!prefixes.has(id)) prefixes.set(id, new Set());
    prefixes.get(id).add(pfx);
  }
  for (const l of ixfac) {
    const s = place.get(l.fac_id);
    if (!s) continue;
    if (!sites.has(l.ix_id)) sites.set(l.ix_id, new Map());
    sites.get(l.ix_id).set(s.join(","), s);
  }
  return ix
    .filter((x) => x.status === "ok" && prefixes.has(x.id) && sites.has(x.id))
    .sort((a, b) => a.id - b.id)
    .map((x) => ({ id: x.id, name: x.name, city: x.city, country: x.country, prefixes: [...prefixes.get(x.id)].sort(), sites: [...sites.get(x.id).values()] }));
}

// The LANs of the exchanges (ixpsFrom) as an index for the addresses of the hops: one table for each length of prefix, the
// longest first.
export function ixpIndex(ixps) {
  const groups = new Map();
  for (const x of ixps || []) {
    for (const p of x.prefixes || []) {
      const m = /^([0-9a-f.:]+)\/(\d{1,3})$/i.exec(p);
      const net = m && parseIp(m[1]);
      if (!net || Number(m[2]) > net.bits) continue;
      const key = `${net.family}/${m[2]}`;
      if (!groups.has(key)) groups.set(key, { family: net.family, len: Number(m[2]), shift: BigInt(net.bits - Number(m[2])), nets: new Map() });
      const g = groups.get(key);
      g.nets.set(String(net.n >> g.shift), x);
    }
  }
  return [...groups.values()].sort((a, b) => b.len - a.len);
}

// The exchange whose LAN has the address, or null.
export function ixpOf(index, address) {
  const ip = parseIp(address);
  if (!ip || !index) return null;
  for (const g of index) {
    if (g.family !== ip.family) continue;
    const x = g.nets.get(String(ip.n >> g.shift));
    if (x) return x;
  }
  return null;
}

// The hops of a path that answer from the LAN of an exchange with known sites, as reference points. `family`: "IPv4" or "IPv6".
export function ixpRefs(hops, index, family) {
  const out = [];
  if (!index) return out;
  for (const h of hops || []) {
    if (!h.ip || h.rtt === null || isPrivate(h.ip)) continue;
    const x = ixpOf(index, h.ip);
    if (!x || !x.sites || !x.sites.length) continue;
    out.push({ kind: "ixp", family, hop: h.n, ip: h.ip, ixp: x.name, city: x.city || null, country: x.country || null, sites: x.sites, rtt: h.rtt });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// DNS root servers (RIPE Atlas probes only)

// The built-in measurements of RIPE Atlas that ask each root server for hostname.bind, from every probe, every four minutes.
export const ROOT_MEASUREMENTS = { a: 10309, b: 10310, c: 10311, d: 10312, e: 10313, f: 10304, g: 10314, h: 10315, i: 10305, j: 10316, k: 10301, l: 10308, m: 10306 };

// The instance of a root server that answered hostname.bind, as the code of a place: an IATA code of an airport or of a city,
// and a country when the name has one. Only the naming schemes of the operators are read: anything else, such as a resolver or
// a firewall of the network of the probe that answers in their place (which is common, and fast), gives null. D, G and I
// have no code of a place in their names: their instances are placed by the lists of their operators only
// (scripts/build-root-sites.mjs).
const ROOT_NAMES = {
  a: [[/^nnn1-([a-z]{2})([a-z]{3})\d*(?:-[0-9a-z]+)?$/, 2, 1], [/^nnn1-([a-z]{3})\d*(?:-[0-9a-z]+)?$/, 1, 0]],
  b: [[/^b\d+-([a-z]{3})$/, 1, 0]],
  c: [[/^([a-z]{3})\d+[a-z]?\.c\.root-servers\.org$/, 1, 0]],
  e: [[/^[a-z]\d+\.([a-z]{3})\.eroot$/i, 1, 0]],
  f: [[/^([A-Z]{3})\.cf\.f\.root-servers\.org$/, 1, 0], [/^([a-z]{3})\d+[a-z]?\.f\.root-servers\.org$/, 1, 0]],
  h: [[/^\d+\.([a-z]{3})\.h\.root-servers\.org$/, 1, 0]],
  j: [[/^rootns-(?:el)?([a-z]{3})\d+$/, 1, 0], [/^nnn1-([a-z]{2})([a-z]{3})\d*(?:-[0-9a-z]+)?$/, 2, 1], [/^nnn1-([a-z]{3})\d*(?:-[0-9a-z]+)?$/, 1, 0]],
  k: [[/^ns\d+\.([a-z]{2})-([a-z]{3})\.k\.ripe\.net$/, 2, 1]],
  l: [[/^([a-z]{2})-([a-z]{3})-[a-z]{2}$/, 2, 1], [/^([a-z]{3})\d+\.l\.root-servers\.org$/, 1, 0]],
  m: [[/^M-([A-Z]{3})(?:-[A-Z]+)?-\d+$/, 1, 0]],
};
export function rootPlace(letter, hostname) {
  for (const [re, code, cc] of ROOT_NAMES[letter] || []) {
    const m = re.exec(String(hostname || "").trim());
    if (m) return { code: m[code].toUpperCase(), cc: cc ? m[cc].toUpperCase() : null };
  }
  return null;
}

// The answers of the root servers to a probe [{ letter, hostname, rtt }] as reference points, with the instances whose place has
// been checked (sites: { letter: { hostname: [lat, lon, code] } }, public/data/root-sites.json, built and tested against the
// anchors of RIPE Atlas by scripts/build-root-sites.mjs). An instance that is not in the list is left out.
export function rootRefs(answers, sites) {
  const out = [];
  for (const a of answers || []) {
    const s = sites && sites[a.letter] && sites[a.letter][a.hostname];
    if (s && typeof a.rtt === "number") {
      out.push({ kind: "root", letter: a.letter, hostname: a.hostname, code: s[2], sites: [[s[0], s[1]]], rtt: a.rtt, margin: ROOT_MARGIN_KM });
    }
  }
  return out;
}

// The latest results of one of those measurements, as RIPE Atlas gives them, as answers by probe: Map(id -> [{ letter, hostname, rtt }]).
export function rootAnswersFrom(letter, results, into = new Map()) {
  for (const x of Array.isArray(results) ? results : []) {
    const a = x?.result || {};
    const hostname = (a.answers || []).map((y) => (Array.isArray(y.RDATA) ? y.RDATA.join(" ") : y.RDATA)).find(Boolean);
    if (!hostname || typeof a.rt !== "number") continue;
    const id = String(x.prb_id);
    if (!into.has(id)) into.set(id, []);
    into.get(id).push({ letter, hostname: String(hostname), rtt: a.rt });
  }
  return into;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Anchors of RIPE Atlas

// The anchors are probes of RIPE Atlas in data centres, whose places are checked. A probe that is not where it is said to be
// shows it with a round trip that is too short to an anchor near where it really is, so the anchors to ping are spread: up to
// `inCountry` in the countries of the probes, as far from each other as they can be, and the one nearest to each point of a
// world-wide list (Frankfurt, London, Ashburn, San Jose, Sao Paulo, Johannesburg, Dubai, Mumbai, Singapore, Tokyo, Sydney).
// anchors: [{ id, fqdn, latitude, longitude, country, city }]; countries: the country codes of the probes.
export const WORLD_POINTS = [[50.11, 8.68], [51.51, -0.13], [39.04, -77.49], [37.34, -121.89], [-23.55, -46.63], [-26.2, 28.05], [25.2, 55.27], [19.08, 72.88], [1.35, 103.82], [35.68, 139.69], [-33.87, 151.21]];
// Fewer points, for the platforms where each ping is a measurement of its own: Frankfurt, Ashburn, Sao Paulo, Singapore.
export const WORLD_POINTS_SHORT = [WORLD_POINTS[0], WORLD_POINTS[2], WORLD_POINTS[4], WORLD_POINTS[8]];

export function pickAnchors(anchors, countries, inCountry = 3, points = WORLD_POINTS) {
  const ok = (anchors || [])
    .filter((a) => a && a.fqdn && typeof a.latitude === "number" && typeof a.longitude === "number")
    .sort((a, b) => a.id - b.id);
  const at = (a) => [a.latitude, a.longitude];
  const wanted = new Set((Array.isArray(countries) ? countries : [countries]).map((c) => String(c || "").toUpperCase()).filter(Boolean));
  const home = ok.filter((a) => wanted.has(String(a.country || "").toUpperCase()));
  const chosen = [];
  if (home.length && inCountry > 0) {
    const mid = [home.reduce((t, a) => t + a.latitude, 0) / home.length, home.reduce((t, a) => t + a.longitude, 0) / home.length];
    chosen.push(home.reduce((b, a) => (distanceKm(at(a), mid) < distanceKm(at(b), mid) ? a : b)));
    while (chosen.length < Math.min(inCountry, home.length)) {
      const rest = home.filter((a) => !chosen.includes(a));
      chosen.push(
        rest.reduce((b, a) => {
          const da = Math.min(...chosen.map((c) => distanceKm(at(a), at(c))));
          const db = Math.min(...chosen.map((c) => distanceKm(at(b), at(c))));
          return da > db ? a : b;
        })
      );
    }
  }
  for (const p of points) {
    const rest = ok.filter((a) => !chosen.includes(a));
    if (rest.length) chosen.push(rest.reduce((b, a) => (distanceKm(at(a), p) < distanceKm(at(b), p) ? a : b)));
  }
  return chosen;
}

// The pings of a probe to the anchors [{ anchor, rtt }] as reference points (the shortest round trip of each).
export const anchorRefs = (pings) =>
  (pings || [])
    .filter((p) => p && p.anchor && typeof p.rtt === "number")
    .map((p) => ({ kind: "anchor", anchor: p.anchor.fqdn, city: p.anchor.city || null, country: p.anchor.country || null, sites: [[p.anchor.latitude, p.anchor.longitude]], rtt: p.rtt }));

// ---------------------------------------------------------------------------------------------------------------------------
// The results of this site (the shape of Globalping, which the results of RIPE Atlas are brought to)

function hopRtt(h) {
  const xs = [];
  for (const t of Array.isArray(h?.timings) ? h.timings : []) {
    const v = typeof t === "number" ? t : t?.rtt;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) xs.push(v);
  }
  if (xs.length) return Math.min(...xs);
  // mtr: the shortest round trip of the hop, then its average
  for (const k of ["min", "avg"]) {
    const v = h?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

// The hops of one result (traceroute or mtr of one probe): [{ n, ip, rtt }], with the shortest round trip of each hop, because
// the shortest is the one nearest to the time that the distance takes.
export function hopsOf(x) {
  const r = x?.result;
  if (!r || r.error || (r.status && r.status !== "finished")) return [];
  return (Array.isArray(r.hops) ? r.hops : []).map((h, i) => {
    const raw = String(h?.resolvedAddress || h?.address || h?.ip || "").trim();
    const hopNo = Number(h?.hop);
    return { n: Number.isFinite(hopNo) && hopNo > 0 ? hopNo : i + 1, ip: parseIp(raw) ? raw.toLowerCase() : null, rtt: hopRtt(h) };
  });
}

// One result as a round trip to the target: `access` is the delay that the probe has before the first public address,
// whatever the route (a modem, a tunnel, a mobile network); `net` is the round trip from there to the target, and is null
// when the trace stops before the target (the delay of a router on the way says nothing about the target).
export function summarise(x) {
  const hops = hopsOf(x);
  const dst = String(x?.result?.resolvedAddress || "").trim().toLowerCase();
  const answering = hops.filter((h) => h.ip && h.rtt !== null);
  const dstN = dst && parseIp(dst) ? parseIp(dst).n : null;
  const end = dstN === null ? null : answering.filter((h) => parseIp(h.ip).n === dstN).pop() || null;
  const firstPublic = answering.find((h) => !isPrivate(h.ip)) || null;
  const access = firstPublic ? firstPublic.rtt : 0;
  return {
    hops,
    reached: !!end,
    access,
    total: end ? end.rtt : null,
    net: end ? Math.max(0, end.rtt - access) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Trombone routing, read on the two families of one probe.
//
// A trombone is a path between two points that are near each other which goes far away and comes back. Told by its delay, it
// needs to know that the two points are near, and this site does not know where a target is. But it measures the same target
// twice from the same probe, and the faster family is a proof: a net round trip of f ms means that the target, as that family
// reaches it, is within f/2 * 200 km. When one family gets there within LONG_DELAY_MS and the other needs TROMBONE_MS or more,
// the distance cannot explain the slower one: its path goes elsewhere, or the name is served to that family from elsewhere
// (an anycast or a CDN with fewer sites on one family). Either way it is a lead worth a look at the hops, not a proof.
//
// verdict: "none" (both near), "v4" or "v6" (that family is the slow one; level "trombone" or "long"), "far" (neither family
// gets there within LONG_DELAY_MS: the target may simply be far, nothing can be said), "unknown" (one family did not reach it).
export function familyReading(n4, n6) {
  if (typeof n4 !== "number" || typeof n6 !== "number") return { verdict: "unknown", level: null, fast: null, slow: null, withinKm: null };
  const fast = Math.min(n4, n6);
  const slow = Math.max(n4, n6);
  const base = { fast, slow, withinKm: Math.round(soiReach(fast)) };
  if (fast > LONG_DELAY_MS) return { verdict: "far", level: null, ...base };
  const slower = n6 > n4 ? "v6" : "v4";
  if (slow >= TROMBONE_MS) return { verdict: slower, level: "trombone", ...base };
  if (slow > LONG_DELAY_MS && slow - fast >= LONG_GAP_MS) return { verdict: slower, level: "long", ...base };
  return { verdict: "none", level: null, ...base };
}

// The key of a probe, as the tables of the page tell probes apart.
export function probeKeyOf(x) {
  const p = x?.probe || {};
  return String(p.id ?? `${p.city ?? ""}|${p.country ?? ""}|${p.asn ?? ""}|${p.network ?? ""}`);
}

// The two measurements side by side: one row for each probe, the first result of each key on either side (as the tables do).
export function pairResults(v4Results, v6Results, excludeKeys = null) {
  const rows = new Map();
  const add = (list, side) => {
    (Array.isArray(list) ? list : []).forEach((x, i) => {
      let k = probeKeyOf(x);
      if (!k || k === "|||") k = `${side}-${i}`;
      if (excludeKeys && excludeKeys.has(k)) return;
      if (!rows.has(k)) rows.set(k, { key: k, probe: x?.probe || {}, v4: null, v6: null });
      const row = rows.get(k);
      if (!row[side]) row[side] = x;
    });
  };
  add(v4Results, "v4");
  add(v6Results, "v6");
  return [...rows.values()];
}

// Every probe of a pair of measurements, with its round trips, the check of its place and the reading of the trombone.
// opts: { index (ixpIndex), rootSites, rootAnswers (Map id -> answers), anchorPings (Map key of the probe -> [{ anchor, rtt }]),
// paths (false for ping and dns: no hops to read) }.
// A probe that is not where it is said to be keeps its figures but gets no reading: its place is what the reading stands on
// when it is compared with the others, and what a reader would use to make sense of its delays.
export function analysePair(v4Results, v6Results, opts = {}) {
  const { index = null, rootSites = null, rootAnswers = null, anchorPings = null, excludeKeys = null, paths = true } = opts;
  return pairResults(v4Results, v6Results, excludeKeys).map((row) => {
    const s4 = paths && row.v4 ? summarise(row.v4) : null;
    const s6 = paths && row.v6 ? summarise(row.v6) : null;
    const p = row.probe;
    const lat = typeof p.latitude === "number" ? p.latitude : Number(p.latitude ?? NaN);
    const lon = typeof p.longitude === "number" ? p.longitude : Number(p.longitude ?? NaN);
    const refs = [
      ...(s4 ? ixpRefs(s4.hops, index, "IPv4") : []),
      ...(s6 ? ixpRefs(s6.hops, index, "IPv6") : []),
      ...(rootAnswers && p.id !== undefined && p.id !== null ? rootRefs(rootAnswers.get(String(p.id)), rootSites) : []),
      ...(anchorPings ? anchorRefs(anchorPings.get(row.key)) : []),
    ];
    const place = soiCheck(lat, lon, refs);
    const n4 = s4 ? s4.net : null;
    const n6 = s6 ? s6.net : null;
    return {
      key: row.key,
      probe: p,
      placed: Number.isFinite(lat) && Number.isFinite(lon),
      n4,
      n6,
      place,
      reading: paths ? (place.misplaced ? { ...familyReading(n4, n6), verdict: "misplaced", level: null } : familyReading(n4, n6)) : null,
    };
  });
}

// The rows together, for the headline.
export function aggregateReadings(rows) {
  const c = { probes: rows.length, read: 0, none: 0, tromboneV4: 0, tromboneV6: 0, longV4: 0, longV6: 0, far: 0, unknown: 0, misplaced: 0, checked: 0 };
  for (const r of rows) {
    if (r.place && r.place.checked) c.checked++;
    if (r.place && r.place.misplaced) c.misplaced++;
    const v = r.reading;
    if (!v) continue;
    if (v.verdict === "misplaced") continue;
    if (v.verdict === "unknown") c.unknown++;
    else if (v.verdict === "far") c.far++;
    else {
      c.read++;
      if (v.verdict === "none") c.none++;
      else if (v.level === "trombone") c[v.verdict === "v6" ? "tromboneV6" : "tromboneV4"]++;
      else c[v.verdict === "v6" ? "longV6" : "longV4"]++;
    }
  }
  return c;
}
