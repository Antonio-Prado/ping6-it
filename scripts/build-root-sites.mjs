// The place of the instances of the DNS root servers, for the check of the probes of RIPE Atlas (src/lib/soi.js, rootRefs):
// public/data/root-sites.json, { letter: { hostname: [latitude, longitude, code] } }.
//
// Every probe of RIPE Atlas asks each root server for hostname.bind (built-in measurements), and the name of the instance that
// answers carries the code of its place in the scheme of its operator (rootPlace). The code is read as a city code of IATA, or as
// an airport of OurAirports (public domain), in the country of the name when it has one. An instance is kept only when the anchors
// of RIPE Atlas, whose places are checked, agree with it: one of them reaches it within CONFIRM_MS (so it was seen from near its
// real place), and none reaches it in less time than light in fibre needs from where the anchor is to the place read from the name.
// Anchors that disagree with several instances are not used as judges (they may be elsewhere, or behind a resolver that answers).
//
// Ported from ASPA Explorer (scripts/build-root-sites.mjs). It downloads the latest answers of every probe for ten root letters:
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

const sites = {};
const judgements = [];                       // [letter, hostname, anchor, rtt]
let read = 0, unread = 0;
for (const [letter, id] of Object.entries(MEASUREMENTS)) {
  const results = await getJson(`${ATLAS}/measurements/${id}/latest/`);
  sites[letter] = {};
  for (const r of results) {
    const res = r.result || {};
    const host = (res.answers || []).map((a) => (Array.isArray(a.RDATA) ? a.RDATA.join(' ') : a.RDATA)).find(Boolean);
    if (!host || typeof res.rt !== 'number') continue;
    const place = T.rootPlace(letter, host);
    if (!place) { unread++; continue; }
    read++;
    const at = placeOf(place.code, place.cc, ap);
    if (at && !sites[letter][host]) sites[letter][host] = [at[0], at[1], place.code];
    if (anchors.has(r.prb_id)) judgements.push([letter, host, r.prb_id, res.rt]);
  }
  console.error(`${letter}: ${Object.keys(sites[letter]).length} instances placed`);
}

// the anchors that disagree with several instances are not judges
const disagree = new Map();
const verdicts = judgements.map(([letter, host, anchor, rtt]) => {
  const s = sites[letter][host];
  if (!s) return null;
  const floor = T.soiFloor(T.distanceKm(anchors.get(anchor), [s[0], s[1]]));
  const bad = rtt < floor;
  if (bad) { if (!disagree.has(anchor)) disagree.set(anchor, new Set()); disagree.get(anchor).add(`${letter} ${host}`); }
  return { letter, host, anchor, rtt, bad };
}).filter(Boolean);
const judges = new Set([...anchors.keys()].filter((a) => !disagree.has(a) || disagree.get(a).size < JUDGE_LIMIT));
const kept = {};
let confirmed = 0, refuted = 0, unseen = 0;
for (const [letter, list] of Object.entries(sites)) {
  kept[letter] = {};
  for (const [host, s] of Object.entries(list)) {
    const v = verdicts.filter((x) => x.letter === letter && x.host === host && judges.has(x.anchor));
    if (v.some((x) => x.bad)) { refuted++; continue; }
    if (!v.some((x) => x.rtt <= CONFIRM_MS)) { unseen++; continue; }
    kept[letter][host] = s;
    confirmed++;
  }
}
writeFileSync(OUT, `${JSON.stringify({ generated: new Date().toISOString(), confirmMs: CONFIRM_MS, sources: 'RIPE Atlas built-in hostname.bind measurements and anchors; OurAirports (public domain)', sites: kept })}\n`);
console.error(`answers read ${read}, not in a scheme ${unread}; instances kept ${confirmed}, refuted by an anchor ${refuted}, not confirmed by a near anchor ${unseen}; anchors not judging ${anchors.size - judges.size}`);
