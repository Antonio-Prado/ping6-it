// The place of the instances of the DNS root servers, for the check of the probes of RIPE Atlas (src/lib/soi.js, rootRefs):
// public/data/root-sites.json, { letter: { hostname: [latitude, longitude, label] } }.
//
// Every probe of RIPE Atlas asks each root server for hostname.bind (built-in measurements). The name of the instance that answers
// is placed in two ways:
// - by the list that its operator publishes on root-servers.org (sites, coordinates of the town, identifiers), for the thirteen
//   letters; C and E publish no identifiers there;
// - by the code of a place in the naming scheme of the operator (rootPlace): a city code of IATA, or an airport of OurAirports
//   (public domain), in the country of the name when it has one.
// The anchors of RIPE Atlas, whose places are checked, are the judges: an instance that one of them reaches in less time than light
// in fibre needs from where the anchor is to that place is dropped, whoever placed it. An instance placed only by its name is kept
// when an anchor reaches it within CONFIRM_MS (so it was seen from near its real place). Anchors that disagree with several
// instances are not used as judges (they may be elsewhere, or behind a resolver that answers).
//
// Ported from ASPA Explorer (scripts/build-root-sites.mjs), with the lists of the operators added. It downloads the latest answers
// of every probe for the thirteen root letters:
// run it by hand, now and then, when the operators add or rename instances.
//
// usage: node scripts/build-root-sites.mjs [OUT]          (OUT: public/data/root-sites.json)
import { writeFileSync } from 'node:fs';

import * as T from '../src/lib/soi.js';

const OUT = process.argv[2] || 'public/data/root-sites.json';
const ATLAS = 'https://atlas.ripe.net/api/v2';
const UA = { 'user-agent': 'ping6.it build-root-sites' };
const MEASUREMENTS = T.ROOT_MEASUREMENTS;
const CONFIRM_MS = 5;           // an anchor this close in time saw the instance from near its real place
const JUDGE_LIMIT = 3;          // an anchor that disagrees with this many instances or more is not a judge

// City codes of IATA that are not airports, with the centre of the city.
const CITIES = {
  BJS: ['CN', 39.904, 116.407], BUE: ['AR', -34.604, -58.382], BUH: ['RO', 44.427, 26.103], CHI: ['US', 41.878, -87.63], DTT: ['US', 42.331, -83.046],
  JKT: ['ID', -6.208, 106.846], LON: ['GB', 51.507, -0.128], MIL: ['IT', 45.464, 9.19], MOW: ['RU', 55.756, 37.617], NYC: ['US', 40.713, -74.006],
  OSA: ['JP', 34.694, 135.502], PAR: ['FR', 48.857, 2.352], REK: ['IS', 64.147, -21.942], RIO: ['BR', -22.907, -43.173], ROM: ['IT', 41.903, 12.496],
  SAO: ['BR', -23.551, -46.633], SEL: ['KR', 37.567, 126.978], SPK: ['JP', 43.062, 141.354], STO: ['SE', 59.329, 18.069], TYO: ['JP', 35.69, 139.692],
  WAS: ['US', 38.907, -77.037], YEA: ['CA', 53.546, -113.494], YMQ: ['CA', 45.502, -73.567], YTO: ['CA', 43.653, -79.383],
};

async function getJson(url) {
  for (let i = 1; ; i++) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(300000) });
    if (r.ok) return r.json();
    if (i >= 3) throw new Error(`${url}: HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 5000 * i));
  }
}

// A line of CSV with quoted fields.
function csvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// IATA code -> [country, lat, lon], the largest airport when a code is used twice
async function airports() {
  const r = await fetch('https://davidmegginson.github.io/ourairports-data/airports.csv', { headers: UA });
  if (!r.ok) throw new Error(`OurAirports: HTTP ${r.status}`);
  const lines = (await r.text()).split('\n');
  const head = csvLine(lines[0]);
  const col = (n) => head.indexOf(n);
  const [iT, iLat, iLon, iC, iI] = ['type', 'latitude_deg', 'longitude_deg', 'iso_country', 'iata_code'].map(col);
  const rank = { large_airport: 3, medium_airport: 2, small_airport: 1 };
  const m = new Map();
  for (const line of lines.slice(1)) {
    const f = csvLine(line);
    const code = (f[iI] || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || !rank[f[iT]]) continue;
    const prev = m.get(code);
    if (!prev || rank[f[iT]] > prev.rank) m.set(code, { rank: rank[f[iT]], at: [f[iC], Number(f[iLat]), Number(f[iLon])] });
  }
  return new Map([...m].map(([k, v]) => [k, v.at]));
}

const placeOf = (code, cc, ap) => {
  const c = CITIES[code] || ap.get(code);
  if (!c || (cc && c[0] !== cc)) return null;
  return [c[1], c[2]];
};

// The sites that the operators publish on root-servers.org, with the identifiers that their instances answer with and the
// coordinates of the town: { exact: Map(identifier -> place), byCode: Map("cc-code" -> place) }, place = [lat, lon, town].
// The site answers 429 to requests that come too close to each other.
async function official(letter) {
  const exact = new Map(), byCode = new Map();
  let d = null;
  for (let i = 1; i <= 4 && !d; i++) {
    const r = await fetch(`https://root-servers.org/root/${letter}/json/`, { headers: UA, signal: AbortSignal.timeout(60000) }).catch(() => null);
    if (r && r.ok) d = await r.json().catch(() => null);
    if (!d) await new Promise((res) => setTimeout(res, 15000 * i));
  }
  for (const site of (d && d.Sites) || []) {
    const lat = Number(site.Latitude), lon = Number(site.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const at = [Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000, String(site.Town || site.Country || '').trim()];
    for (const id of site.Identifiers || []) {
      const k = String(id).trim().toLowerCase();
      if (!k) continue;
      exact.set(k, at);
      const m = /^[a-z]\d+\.([a-z]{2}-[a-z]{3})\.root$/.exec(k);          // A and J: a6.nl-ams.root
      if (m) byCode.set(m[1], at);
    }
  }
  return { exact, byCode, ok: !!d };
}

// The place of an instance from what the operator publishes, or null. I answers "sN.xxx" where the list has "xxx"; A and J answer
// names of another form than the list (nnn1-frpar-1 for the site fr-par), which are matched by the code of the place.
function officialPlace(letter, host, off) {
  const h = host.trim().toLowerCase();
  if (off.exact.has(h)) return off.exact.get(h);
  if (letter === 'i') { const m = /^s\d+\.([a-z0-9]+)$/.exec(h); return (m && off.exact.get(m[1])) || null; }
  if (letter === 'a' || letter === 'j') {
    const p = T.rootPlace(letter, host);
    if (!p) return null;
    const code = p.code.toLowerCase();
    if (p.cc) return off.byCode.get(`${p.cc.toLowerCase()}-${code}`) || null;
    const same = [...off.byCode].filter(([k]) => k.endsWith(`-${code}`));
    return same.length === 1 ? same[0][1] : null;
  }
  return null;
}

const ap = await airports();
console.error(`${ap.size} airports with an IATA code`);
// the anchors that are connected, with their places
const anchors = new Map();
for (let url = `${ATLAS}/probes/?is_anchor=true&status=1&page_size=500&fields=id,geometry,country_code`; url;) {
  const d = await getJson(url);
  for (const p of d.results) if (p.geometry && p.geometry.coordinates) anchors.set(p.id, [p.geometry.coordinates[1], p.geometry.coordinates[0]]);
  url = d.next;
}
console.error(`${anchors.size} connected anchors`);

const sites = {};                            // letter -> hostname -> [lat, lon, label, published by the operator?]
const judgements = [];                       // [letter, hostname, anchor, rtt]
let read = 0, unread = 0;
for (const [letter, id] of Object.entries(MEASUREMENTS)) {
  const off = await official(letter);
  if (!off.ok) console.error(`${letter}: root-servers.org did not answer, the names alone are read`);
  const results = await getJson(`${ATLAS}/measurements/${id}/latest/`);
  sites[letter] = {};
  let published = 0;
  for (const r of results) {
    const res = r.result || {};
    const host = (res.answers || []).map((a) => (Array.isArray(a.RDATA) ? a.RDATA.join(' ') : a.RDATA)).find(Boolean);
    if (!host || typeof res.rt !== 'number') continue;
    if (!sites[letter][host]) {
      const pub = officialPlace(letter, host, off);
      const place = pub ? null : T.rootPlace(letter, host);
      const at = pub || (place && placeOf(place.code, place.cc, ap));
      if (at) { sites[letter][host] = pub ? [pub[0], pub[1], pub[2], true] : [at[0], at[1], place.code, false]; if (pub) published++; }
    }
    if (!sites[letter][host]) { unread++; continue; }
    read++;
    if (anchors.has(r.prb_id)) judgements.push([letter, host, r.prb_id, res.rt]);
  }
  console.error(`${letter}: ${Object.keys(sites[letter]).length} instances placed, ${published} of them by the list of the operator`);
}

// the anchors that disagree with several instances are not judges
const disagree = new Map();
const verdicts = judgements.map(([letter, host, anchor, rtt]) => {
  const s = sites[letter][host];
  const floor = T.soiFloor(T.distanceKm(anchors.get(anchor), [s[0], s[1]]));
  const bad = rtt < floor;
  if (bad) { if (!disagree.has(anchor)) disagree.set(anchor, new Set()); disagree.get(anchor).add(`${letter} ${host}`); }
  return { letter, host, anchor, rtt, bad };
});
const judges = new Set([...anchors.keys()].filter((a) => !disagree.has(a) || disagree.get(a).size < JUDGE_LIMIT));
// An instance that an anchor refutes is dropped, whoever placed it. One that the operator publishes is kept otherwise; one whose
// place is only read from its name is kept when an anchor saw it from near.
const kept = {};
let byList = 0, byAnchor = 0, refuted = 0, unseen = 0;
for (const [letter, list] of Object.entries(sites)) {
  kept[letter] = {};
  for (const [host, s] of Object.entries(list)) {
    const v = verdicts.filter((x) => x.letter === letter && x.host === host && judges.has(x.anchor));
    if (v.some((x) => x.bad)) { refuted++; continue; }
    if (s[3]) byList++;
    else if (v.some((x) => x.rtt <= CONFIRM_MS)) byAnchor++;
    else { unseen++; continue; }
    kept[letter][host] = [s[0], s[1], s[2]];
  }
}
writeFileSync(OUT, `${JSON.stringify({ generated: new Date().toISOString(), confirmMs: CONFIRM_MS, sources: 'root-servers.org (sites and identifiers published by the operators); RIPE Atlas built-in hostname.bind measurements and anchors; OurAirports (public domain)', sites: kept })}\n`);
console.error(`answers read ${read}, not placed ${unread}; instances kept ${byList + byAnchor} (${byList} published by their operator, ${byAnchor} read from the name and confirmed by a near anchor), refuted by an anchor ${refuted}, not confirmed ${unseen}; anchors not judging ${anchors.size - judges.size}`);
