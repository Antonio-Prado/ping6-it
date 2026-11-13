// The reference points for the check of the place of the probes (src/lib/soi.js). Everything here is asked from the browser of
// the visitor, and only once the visitor has turned the check on, because each of these services then sees the visitor's address.
//
// - PeeringDB: the prefixes of the LANs of the exchange points and the coordinates of their facilities, five tables, kept in
//   this browser for a day, because PeeringDB limits how often an address can ask for them. The data are not copied to this
//   site (the acceptable use policy of PeeringDB does not allow passing them on in bulk).
// - RIPE Atlas: the latest answers of the DNS root servers to the probes of the measurement (hostname.bind, public built-in
//   measurements), the list of the instances whose place has been checked (a file of this site), the list of the anchors,
//   and the results of the pings to the anchors, which are public.

import { ROOT_MEASUREMENTS, ixpIndex, ixpsFrom, probeKeyOf, rootAnswersFrom } from "./soi";
import { createMeasurement, waitForMeasurement } from "./globalping";

const PEERINGDB = "https://www.peeringdb.com/api";
const PEERINGDB_TABLES = {
  ixpfx: "ixlan_id,prefix",
  ixlan: "id,ix_id",
  ix: "id,name,city,country,status",
  ixfac: "ix_id,fac_id",
  fac: "id,latitude,longitude,status",
};
const IXPS_STORE = "PING6_IXPS";
const IXPS_KEEP_MS = 24 * 3600 * 1000;
const ATLAS = "https://atlas.ripe.net/api/v2";
const ROOT_ANSWERS_KEEP_MS = 10 * 60 * 1000;
const ROOT_PROBES_MAX = 100;

async function getJson(url, signal) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered HTTP ${r.status}`);
  return r.json();
}

let ixpIndexAsked = null;

// The index of the LANs of the exchanges, or null when PeeringDB did not give the tables (the next call asks again).
export function loadIxpIndex() {
  if (!ixpIndexAsked) {
    ixpIndexAsked = (async () => {
      try {
        const kept = JSON.parse(window.localStorage.getItem(IXPS_STORE) || "null");
        if (kept && Array.isArray(kept.ixps) && Date.now() - kept.at < IXPS_KEEP_MS) return ixpIndex(kept.ixps);
      } catch {
        // no storage: ask again
      }
      const tables = await Promise.all(
        Object.entries(PEERINGDB_TABLES).map(([name, fields]) =>
          getJson(`${PEERINGDB}/${name}?depth=0&fields=${fields}`).then((d) => [name, d.data])
        )
      );
      const ixps = ixpsFrom(Object.fromEntries(tables));
      try {
        window.localStorage.setItem(IXPS_STORE, JSON.stringify({ at: Date.now(), ixps }));
      } catch {
        // full or blocked
      }
      return ixpIndex(ixps);
    })().catch(() => {
      ixpIndexAsked = null;
      return null;
    });
  }
  return ixpIndexAsked;
}

let rootSitesAsked = null;

// { letter: { hostname: [lat, lon, code] } }, or null.
export function loadRootSites() {
  if (!rootSitesAsked) {
    rootSitesAsked = getJson("/data/root-sites.json")
      .then((d) => (d && typeof d.sites === "object" ? d.sites : null))
      .catch(() => {
        rootSitesAsked = null;
        return null;
      });
  }
  return rootSitesAsked;
}

const rootAnswersKept = new Map(); // probe id -> { at, answers }

// The answers of the root servers to these probes of RIPE Atlas: Map(id -> [{ letter, hostname, rtt }]). The probes asked in
// the last few minutes are not asked again; a letter that does not answer is left out.
export async function loadRootAnswers(probeIds, signal) {
  const ids = [...new Set((probeIds || []).map((x) => String(x).trim()).filter((x) => /^\d+$/.test(x)))].slice(0, ROOT_PROBES_MAX);
  const now = Date.now();
  const todo = ids.filter((id) => !rootAnswersKept.has(id) || now - rootAnswersKept.get(id).at > ROOT_ANSWERS_KEEP_MS);
  if (todo.length) {
    const fresh = new Map();
    const got = await Promise.all(
      Object.entries(ROOT_MEASUREMENTS).map(([letter, id]) =>
        getJson(`${ATLAS}/measurements/${id}/latest/?probe_ids=${todo.join(",")}`, signal)
          .then((res) => {
            rootAnswersFrom(letter, res, fresh);
            return true;
          })
          .catch(() => false)
      )
    );
    if (signal?.aborted) throw new Error("Aborted");
    // when no letter answered, nothing is kept, so that the next call asks again
    if (got.some(Boolean)) for (const id of todo) rootAnswersKept.set(id, { at: now, answers: fresh.get(id) || [] });
  }
  const out = new Map();
  for (const id of ids) if (rootAnswersKept.has(id)) out.set(id, rootAnswersKept.get(id).answers);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Anchors of RIPE Atlas

const ANCHORS_STORE = "PING6_ANCHORS";
const ANCHORS_KEEP_MS = 24 * 3600 * 1000;
let anchorsAsked = null;

// The anchors that can be pinged: [{ id, fqdn, city, country, latitude, longitude }], kept in this browser for a day; null when
// RIPE Atlas did not give the list.
export function loadAnchors() {
  if (!anchorsAsked) {
    anchorsAsked = (async () => {
      try {
        const kept = JSON.parse(window.localStorage.getItem(ANCHORS_STORE) || "null");
        if (kept && Array.isArray(kept.anchors) && kept.anchors.length && Date.now() - kept.at < ANCHORS_KEEP_MS) return kept.anchors;
      } catch {
        // no storage: ask again
      }
      const anchors = [];
      let url = `${ATLAS}/anchors/?page_size=500`;
      for (let page = 0; url && page < 10; page++) {
        const d = await getJson(url);
        for (const a of d.results || []) {
          const c = a?.geometry?.coordinates;
          if (a.is_disabled || !a.fqdn || !a.ip_v4 || !Array.isArray(c)) continue;
          const latitude = Number(c[1]);
          const longitude = Number(c[0]);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
          anchors.push({ id: a.id, fqdn: String(a.fqdn).toLowerCase(), city: a.city || null, country: a.country || null, latitude, longitude });
        }
        url = d.next ? String(d.next).replace(/^http:/, "https:") : null;
      }
      if (!anchors.length) throw new Error("no anchors");
      try {
        window.localStorage.setItem(ANCHORS_STORE, JSON.stringify({ at: Date.now(), anchors }));
      } catch {
        // full or blocked
      }
      return anchors;
    })().catch(() => {
      anchorsAsked = null;
      return null;
    });
  }
  return anchorsAsked;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("Aborted"));
    });
  });

// Pings from the probes of a Globalping measurement to the anchors, one measurement for each anchor, on the very same probes
// (locations = the id of the measurement). Globalping gives no id of a probe: a probe is told by its key, and two probes
// with the same key are not checked. Returns Map(key of the probe -> [{ anchor, rtt }]).
export async function pingAnchorsGlobalping({ measurementId, anchors, signal, onProgress }) {
  let done = 0;
  const runs = await Promise.all(
    anchors.map(async (anchor) => {
      try {
        const created = await createMeasurement(
          { type: "ping", target: anchor.fqdn, locations: String(measurementId), measurementOptions: { packets: 3, ipVersion: 4 } },
          signal
        );
        const m = await waitForMeasurement(created.id, { signal, timeoutMs: 60000 });
        return { anchor, results: Array.isArray(m?.results) ? m.results : [] };
      } catch {
        return { anchor, results: [] };
      } finally {
        done += 1;
        onProgress?.(`${done} of ${anchors.length} anchors pinged`);
      }
    })
  );
  if (signal?.aborted) throw new Error("Aborted");
  const out = new Map();
  let answers = 0;
  for (const { anchor, results } of runs) {
    const seen = new Set();
    const twins = new Set();
    for (const x of results) {
      const k = probeKeyOf(x);
      if (seen.has(k)) twins.add(k);
      seen.add(k);
    }
    for (const x of results) {
      const k = probeKeyOf(x);
      const rtt = x?.result?.stats?.min;
      if (twins.has(k) || typeof rtt !== "number" || !(rtt > 0)) continue;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ anchor, rtt });
      answers += 1;
    }
  }
  if (!answers) throw new Error("No probe answered from the anchors.");
  return out;
}

// The same for the probes of RIPE Atlas: this site creates the pings (functions/api/atlas/anchor-pings.js) with the key of the
// visitor or its own, and the page reads their results, which are public, from RIPE Atlas.
// Returns Map(id of the probe -> [{ anchor, rtt }]).
export async function pingAnchorsAtlas({ probeIds, anchors, turnstileToken, atlasKey, signal, onProgress }) {
  const headers = { "content-type": "application/json" };
  if (String(atlasKey || "").trim()) headers["X-Atlas-Key"] = String(atlasKey).trim();
  const res = await fetch("/api/atlas/anchor-pings", {
    method: "POST",
    headers,
    body: JSON.stringify({ turnstileToken, probes: probeIds.map(Number), anchors: anchors.map((a) => a.id) }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `The pings could not be created (HTTP ${res.status}).`);
  const pings = Array.isArray(body.pings) ? body.pings : [];
  const expected = pings.length * (Array.isArray(body.probes) ? body.probes.length : probeIds.length);

  const got = new Map(); // measurement id -> results
  let still = 0;
  let before = -1;
  for (let i = 0; i < 20; i++) {
    await sleep(i === 0 ? 15000 : 10000, signal);
    await Promise.all(
      pings.map((p) =>
        getJson(`${ATLAS}/measurements/${encodeURIComponent(p.id)}/results/`, signal)
          .then((r) => {
            if (Array.isArray(r)) got.set(p.id, r);
          })
          .catch(() => {})
      )
    );
    const n = [...got.values()].reduce((t, r) => t + r.length, 0);
    onProgress?.(`${n} of ${expected} answers from the anchors`);
    still = n > before ? 0 : still + 1;
    before = n;
    if (n >= expected || (i >= 6 && n > 0 && still >= 2)) break;
  }
  const out = new Map();
  for (const p of pings) {
    for (const x of got.get(p.id) || []) {
      if (typeof x.min !== "number" || !(x.min > 0)) continue;
      const k = String(x.prb_id);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ anchor: p.anchor, rtt: x.min });
    }
  }
  if (!out.size) throw new Error("No probe answered from the anchors in time.");
  return out;
}
