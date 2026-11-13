// The reference points for the check of the place of the probes (src/lib/soi.js). Everything here is asked from the browser of
// the visitor, and only once the visitor has turned the check on, because each of these services then sees the visitor's address.
//
// - PeeringDB: the prefixes of the LANs of the exchange points and the coordinates of their facilities, five tables, kept in
//   this browser for a day, because PeeringDB limits how often an address can ask for them. The data are not copied to this
//   site (the acceptable use policy of PeeringDB does not allow passing them on in bulk).
// - RIPE Atlas: the latest answers of the DNS root servers to the probes of the measurement (hostname.bind, public built-in
//   measurements), and the list of the instances whose place has been checked, a file of this site.

import { ROOT_MEASUREMENTS, ixpIndex, ixpsFrom, rootAnswersFrom } from "./soi";

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
