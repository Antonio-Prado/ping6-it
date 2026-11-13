// Unit tests for src/lib/soi.js (no dependencies). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FIBRE_KM_PER_MS, aggregateReadings, analysePair, distanceKm, familyReading, hopsOf, isPrivate, ixpIndex, ixpOf, ixpRefs, ixpsFrom,
  lanPrefix, pairResults, parseIp, rootAnswersFrom, rootPlace, rootRefs, soiCheck, soiFloor, soiReach, summarise,
} from "../src/lib/soi.js";

const IXPS = [
  { id: 31, name: "DE-CIX Frankfurt", city: "Frankfurt", country: "DE", prefixes: ["80.81.192.0/21", "2001:7f8::/64"], sites: [[50.119, 8.735], [50.098, 8.632]] },
  { id: 9, name: "A wide LAN", city: "Nowhere", country: "ZZ", prefixes: ["80.81.0.0/16"], sites: [[0.5, 0.5]] },
  { id: 62, name: "MIX-IT", city: "Milan", country: "IT", prefixes: ["217.29.66.0/23"], sites: [[45.476, 9.106]] },
];
const MILAN = { city: "Milan", country: "IT", asn: 6517, network: "LAKE", latitude: 45.464, longitude: 9.19 };
const hop = (ip, rtts) => ({ resolvedAddress: ip, resolvedHostname: ip, timings: rtts.map((rtt) => ({ rtt })) });
const trace = (probe, dst, hops) => ({ probe, result: { status: "finished", resolvedAddress: dst, hops: hops.map(([ip, ...rtts]) => hop(ip, rtts)) } });

test("light in fibre: about 200 km in a millisecond, and what a round trip allows", () => {
  assert.ok(FIBRE_KM_PER_MS > 199.8 && FIBRE_KM_PER_MS < 199.9);
  assert.equal(soiFloor(80), 0); // within the margin
  assert.ok(Math.abs(soiFloor(1100) - 10) < 0.01); // 1,000 km of fibre there and back: 10 ms
  assert.ok(Math.abs(soiReach(10) - 999.3) < 0.1); // 10 ms of round trip: the other end is within 1,000 km
  const km = distanceKm([45.464, 9.19], [50.11, 8.68]);
  assert.ok(km > 500 && km < 530); // Milan to Frankfurt
});

test("addresses: families, and those that say nothing about the route", () => {
  assert.equal(parseIp("193.0.0.1").family, 4);
  assert.equal(parseIp("2001:67c:2e8::1").family, 6);
  assert.equal(parseIp("2001:7F8::1").n, parseIp("2001:7f8:0:0:0:0:0:1").n);
  for (const bad of ["", "x", "300.1.1.1", "1.2.3", "2001:::1", "1::2::3", null, undefined]) assert.equal(parseIp(bad), null, String(bad));
  for (const ip of ["10.1.2.3", "192.168.0.1", "172.16.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "224.0.0.1", "fd00::1", "fe80::1", null]) assert.equal(isPrivate(ip), true, String(ip));
  for (const ip of ["193.0.0.1", "172.32.0.1", "8.8.8.8", "2001:67c:2e8::1"]) assert.equal(isPrivate(ip), false, ip);
});

test("the exchanges from the tables of PeeringDB: a usable prefix and a facility with coordinates", () => {
  assert.equal(lanPrefix("80.81.192.0/21"), "80.81.192.0/21");
  assert.equal(lanPrefix("2001:7F8::/64"), "2001:7f8::/64");
  for (const bad of ["0.0.0.0/0", "10.0.0.0/8", "1.2.3.4/32", "2001:db8::/29", "2001:db8::1/128", "x", null]) assert.equal(lanPrefix(bad), null, String(bad));
  const ixps = ixpsFrom({
    ixpfx: [{ ixlan_id: 1, prefix: "80.81.192.0/21" }, { ixlan_id: 1, prefix: "2001:7f8::/64" }, { ixlan_id: 2, prefix: "217.29.66.0/23" }, { ixlan_id: 3, prefix: "198.51.100.0/24" }, { ixlan_id: 99, prefix: "203.0.113.0/24" }],
    ixlan: [{ id: 1, ix_id: 31 }, { id: 2, ix_id: 62 }, { id: 3, ix_id: 70 }],
    ix: [{ id: 62, name: "MIX-IT", city: "Milan", country: "IT", status: "ok" }, { id: 31, name: "DE-CIX Frankfurt", city: "Frankfurt", country: "DE", status: "ok" }, { id: 70, name: "No site", city: "X", country: "ZZ", status: "ok" }],
    ixfac: [{ ix_id: 31, fac_id: 1 }, { ix_id: 31, fac_id: 2 }, { ix_id: 31, fac_id: 3 }, { ix_id: 62, fac_id: 4 }, { ix_id: 70, fac_id: 5 }],
    fac: [{ id: 1, latitude: 50.1187, longitude: 8.7352, status: "ok" }, { id: 2, latitude: "50.0981", longitude: "8.6324", status: "ok" }, { id: 3, latitude: null, longitude: null, status: "ok" },
      { id: 4, latitude: 45.4761, longitude: 9.1064, status: "ok" }, { id: 5, latitude: 0, longitude: 0, status: "ok" }],
  });
  assert.deepEqual(ixps.map((x) => x.name), ["DE-CIX Frankfurt", "MIX-IT"]); // sorted by id; an exchange without a site is left out
  assert.deepEqual(ixps[0].prefixes, ["2001:7f8::/64", "80.81.192.0/21"]);
  assert.deepEqual(ixps[0].sites, [[50.119, 8.735], [50.098, 8.632]]);
});

test("the exchange of an address: the longest prefix, both families, nothing outside", () => {
  const idx = ixpIndex(IXPS);
  assert.equal(ixpOf(idx, "80.81.196.146").name, "DE-CIX Frankfurt"); // in the /21 and in the /16: the /21
  assert.equal(ixpOf(idx, "80.81.10.1").name, "A wide LAN");
  assert.equal(ixpOf(idx, "2001:7f8::a16f:0:1").name, "DE-CIX Frankfurt");
  assert.equal(ixpOf(idx, "217.29.67.200").name, "MIX-IT");
  assert.equal(ixpOf(idx, "193.0.0.1"), null);
  assert.equal(ixpOf(idx, "not an address"), null);
  assert.equal(ixpOf(null, "193.0.0.1"), null);
  assert.deepEqual(ixpIndex(null), []);
});

test("the hops of a result: the shortest round trip of each, traceroute and mtr, nothing from a failed one", () => {
  const x = { probe: MILAN, result: { status: "finished", resolvedAddress: "193.0.0.1", hops: [
    hop("192.168.1.1", [0.5, 0.4]), { resolvedAddress: null, timings: [] }, { hop: 7, resolvedAddress: "193.0.0.1", timings: [{ rtt: 9.1 }, { rtt: 8.7 }] },
    { resolvedAddress: "195.0.0.1", stats: { min: 2.5, avg: 3, max: 9 }, timings: [] }, { resolvedAddress: "195.0.0.2", stats: { avg: 4 } }, { resolvedAddress: "gw.example", timings: [{ rtt: 1 }] },
  ] } };
  assert.deepEqual(hopsOf(x).map((h) => [h.n, h.ip, h.rtt]), [[1, "192.168.1.1", 0.4], [2, null, null], [7, "193.0.0.1", 8.7], [4, "195.0.0.1", 2.5], [5, "195.0.0.2", 4], [6, null, 1]]);
  assert.deepEqual(hopsOf({ probe: MILAN, result: { status: "failed", hops: [hop("193.0.0.1", [1])] } }), []);
  assert.deepEqual(hopsOf({ probe: MILAN, result: { error: "x", hops: [hop("193.0.0.1", [1])] } }), []);
  assert.deepEqual(hopsOf(null), []);
});

test("the round trip to the target: net of the access network, and nothing when the trace stops before it", () => {
  const s = summarise(trace(MILAN, "193.0.0.1", [["192.168.1.1", 0.4], ["10.0.0.1", 8.2], ["195.0.0.1", 9.5, 9.1], ["193.0.0.1", 16.5, 16.9]]));
  assert.equal(s.reached, true);
  assert.equal(s.access, 9.1); // the first public address: what comes before is the access network
  assert.equal(s.total, 16.5);
  assert.ok(Math.abs(s.net - 7.4) < 1e-9);
  const stopped = summarise(trace(MILAN, "193.0.0.1", [["195.0.0.1", 3], ["195.0.0.9", 140]]));
  assert.equal(stopped.reached, false);
  assert.equal(stopped.net, null);
  // a router on the way that answers slowly never gives a negative round trip
  assert.equal(summarise(trace(MILAN, "193.0.0.1", [["195.0.0.1", 30], ["193.0.0.1", 12]])).net, 0);
  // the same address written in two ways is the same target
  assert.equal(summarise(trace(MILAN, "2001:67C:2E8::1", [["2001:db8::1", 1], ["2001:67c:2e8:0::1", 5]])).reached, true);
});

test("the reading of the two families of one probe", () => {
  assert.equal(familyReading(8, 11).verdict, "none");
  assert.deepEqual([familyReading(8, 140).verdict, familyReading(8, 140).level], ["v6", "trombone"]);
  assert.deepEqual([familyReading(140, 8).verdict, familyReading(140, 8).level], ["v4", "trombone"]);
  assert.equal(familyReading(8, 140).withinKm, 799); // 8 ms: the target is within 800 km
  assert.deepEqual([familyReading(20, 70).verdict, familyReading(20, 70).level], ["v6", "long"]);
  assert.equal(familyReading(40, 60).verdict, "none"); // above the band, but the families are close to each other
  assert.equal(familyReading(50, 100).level, "trombone"); // the bands include their ends
  assert.equal(familyReading(80, 190).verdict, "far"); // neither is near: the target may simply be far
  assert.equal(familyReading(null, 190).verdict, "unknown");
  assert.equal(familyReading(8, undefined).verdict, "unknown");
});

test("a probe said to be in Milan whose path crosses Frankfurt in 1.5 ms is not in Milan", () => {
  const idx = ixpIndex(IXPS);
  const v4 = [trace(MILAN, "193.0.0.1", [["192.168.1.1", 0.4], ["195.0.0.1", 1], ["80.81.196.146", 1.5], ["193.0.0.1", 9]])];
  const v6 = [trace(MILAN, "2001:67c:2e8::1", [["2001:db8::1", 1], ["2001:7f8::a16f:0:1", 1.2], ["2001:67c:2e8::1", 150]])];
  const [r] = analysePair(v4, v6, { index: idx });
  assert.equal(r.place.checked, 2);
  assert.equal(r.place.misplaced.kind, "ixp");
  assert.equal(r.place.misplaced.family, "IPv6"); // the stronger proof of the two
  assert.equal(r.place.misplaced.ixp, "DE-CIX Frankfurt");
  assert.equal(r.place.misplaced.hop, 2);
  assert.equal(r.place.misplaced.sites, undefined);
  assert.ok(r.place.misplaced.km > 500 && r.place.misplaced.km < 530);
  assert.ok(r.place.misplaced.atLeast > 4 && r.place.misplaced.atLeast < 4.5); // 2 x (km - 100) at 200 km a millisecond
  assert.ok(r.place.misplaced.within > 210 && r.place.misplaced.within < 230); // where it can be: 100 km + 1.2 ms / 2 of fibre
  assert.equal(r.reading.verdict, "misplaced"); // and its delays are not read as a trombone
  assert.equal(aggregateReadings([r]).misplaced, 1);
  assert.equal(aggregateReadings([r]).read, 0);
});

test("a round trip long enough for the distance, a nearby site, no coordinates, no table: nothing to say", () => {
  const idx = ixpIndex(IXPS);
  const one = (probe, hops, index = idx) => analysePair([trace(probe, "193.0.0.1", hops)], [], { index })[0].place;
  assert.equal(one(MILAN, [["80.81.196.146", 6], ["193.0.0.1", 9]]).misplaced, null); // 6 ms covers 520 km
  assert.equal(one(MILAN, [["217.29.66.10", 0.3], ["193.0.0.1", 9]]).misplaced, null); // MIX is in Milan
  assert.equal(one({ ...MILAN, latitude: 50.0, longitude: 8.7 }, [["80.81.196.146", 0.5]]).misplaced, null); // a probe in Frankfurt
  assert.deepEqual(one({ city: "Milan" }, [["80.81.196.146", 0.5]]), { checked: 0, misplaced: null });
  assert.deepEqual(one(MILAN, [["80.81.196.146", 0.5]], null), { checked: 0, misplaced: null });
  assert.deepEqual(ixpRefs([{ n: 1, ip: "80.81.196.146", rtt: null }, { n: 2, ip: "193.0.0.1", rtt: 0.5 }], idx, "IPv4"), []);
});

test("the strongest of several proofs", () => {
  const refs = [
    { kind: "x", name: "de-fra", sites: [[50.11, 8.68]], rtt: 2 }, // Frankfurt, 507 km: at least 4.07 ms
    { kind: "x", name: "us-iad", sites: [[39.04, -77.49]], rtt: 20 }, // Ashburn, 6,700 km: at least 66 ms, the stronger proof
    { kind: "x", name: "it-mil", sites: [[45.47, 9.18]], rtt: 0.5 }, // Milan itself: fine
    { kind: "x", name: "none", sites: [[1, 1]], rtt: null }, // no answer: not used
  ];
  const r = soiCheck(45.464, 9.19, refs);
  assert.equal(r.checked, 3);
  assert.equal(r.misplaced.name, "us-iad");
  assert.ok(r.misplaced.atLeast > 60);
  assert.ok(r.misplaced.within > 2000 && r.misplaced.within < 2200); // 100 km + 10 ms of fibre
  assert.deepEqual(soiCheck(45.464, 9.19, refs.slice(2)), { checked: 1, misplaced: null });
  assert.deepEqual(soiCheck(undefined, 9, refs), { checked: 0, misplaced: null });
});

test("the instances of the root servers: the naming schemes of the operators, and nothing else", () => {
  const cases = [
    ["a", "nnn1-ams5", "AMS", null], ["a", "nnn1-usmia-2b", "MIA", "US"], ["a", "nnn1-jptyo-3", "TYO", "JP"],
    ["b", "b1-sin", "SIN", null], ["c", "fra1b.c.root-servers.org", "FRA", null], ["e", "c01.TPE.eroot", "TPE", null], ["e", "p04.ams.eroot", "AMS", null],
    ["f", "TPE.cf.f.root-servers.org", "TPE", null], ["f", "ams1a.f.root-servers.org", "AMS", null], ["h", "001.hkg.h.root-servers.org", "HKG", null],
    ["j", "rootns-elgva1", "GVA", null], ["j", "rootns-ams6", "AMS", null], ["j", "rootns-elp2", "ELP", null], ["j", "nnn1-ams1", "AMS", null],
    ["k", "ns1.nl-ams.k.ripe.net", "AMS", "NL"], ["l", "de-ham-aa", "HAM", "DE"], ["l", "flr01.l.root-servers.org", "FLR", null],
    ["m", "M-ORY-2", "ORY", null], ["m", "M-NRT-DIXIE-1", "NRT", null],
  ];
  for (const [l, h, code, cc] of cases) assert.deepEqual(rootPlace(l, h), { code, cc }, `${l} ${h}`);
  for (const [l, h] of [["a", "OPNsense.internal"], ["b", "wall.obskure.net"], ["c", "gw01.jacobsylvia.com"], ["l", "There is no hostname, only Zuul!"],
    ["g", "groot-eur1-1"], ["d", "mcva3.droot.maxgigapop.net"], ["i", "s1.mtv"], ["k", "ns1.nl-ams.k.ripe.net.evil"], ["m", "m-ory-2"], ["x", "b1-sin"]]) {
    assert.equal(rootPlace(l, h), null, `${l} ${h}`);
  }
});

test("the root servers as reference points for a probe of RIPE Atlas, on a ping too", () => {
  const sites = { k: { "ns1.nl-ams.k.ripe.net": [52.31, 4.76, "AMS"] }, m: { "M-ORY-2": [48.72, 2.38, "ORY"] } };
  const answers = rootAnswersFrom("k", [
    { prb_id: 6001, result: { rt: 1.1, answers: [{ TYPE: "TXT", NAME: "hostname.bind", RDATA: ["ns1.nl-ams.k.ripe.net"] }] } },
    { prb_id: 6002, result: { rt: 0.2, answers: [{ RDATA: "OPNsense.internal" }] } },
    { prb_id: 6003, error: { timeout: 5000 } },
  ]);
  rootAnswersFrom("m", [{ prb_id: 6001, result: { rt: 9, answers: [{ RDATA: ["M-CDG-2"] }] } }], answers);
  assert.deepEqual(answers.get("6001").map((a) => a.letter), ["k", "m"]);
  assert.equal(answers.has("6003"), false);
  assert.deepEqual(rootRefs(answers.get("6001"), sites), [{ kind: "root", letter: "k", hostname: "ns1.nl-ams.k.ripe.net", code: "AMS", sites: [[52.31, 4.76]], rtt: 1.1, margin: 300 }]);
  assert.deepEqual(rootRefs(answers.get("6002"), sites), []); // a resolver that answers in the place of the root is not a root

  // a probe declared in Milan that reaches the instance of Amsterdam in 1.1 ms is not in Milan; with the margin of a root, it
  // can be up to 300 km + 0.55 ms of fibre from Amsterdam
  const ping = (id, latitude, longitude) => ({ probe: { id, country: "IT", asn: 3269, latitude, longitude }, result: { status: "finished", stats: { avg: 20, loss: 0 } } });
  const rows = analysePair([ping(6001, 45.464, 9.19), ping(6002, 45.464, 9.19)], [ping(6001, 45.464, 9.19)], { rootSites: sites, rootAnswers: answers, paths: false });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].place.misplaced.code, "AMS");
  assert.equal(rows[0].place.misplaced.margin, 300);
  assert.equal(rows[0].place.misplaced.within, 410);
  assert.equal(rows[0].reading, null); // a ping has no hops: no reading of the trombone
  assert.deepEqual(rows[1].place, { checked: 0, misplaced: null });
  // a probe declared in Brussels (about 170 km away) is within the margin of the instance of Amsterdam
  assert.equal(analysePair([ping(6001, 50.85, 4.35)], [], { rootSites: sites, rootAnswers: answers, paths: false })[0].place.misplaced, null);
});

test("the probes of two measurements side by side, and the headline counts", () => {
  const rome = { city: "Rome", country: "IT", asn: 3269, network: "TIM", latitude: 41.9, longitude: 12.5 };
  const turin = { city: "Turin", country: "IT", asn: 12874, network: "Fastweb", latitude: 45.07, longitude: 7.69 };
  const far = { city: "Sydney", country: "AU", asn: 1221, network: "Telstra", latitude: -33.87, longitude: 151.21 };
  const t4 = (p, ms) => trace(p, "193.0.0.1", [["195.0.0.1", 1], ["193.0.0.1", 1 + ms]]);
  const t6 = (p, ms) => trace(p, "2001:67c:2e8::1", [["2001:db8::1", 1], ["2001:67c:2e8::1", 1 + ms]]);
  const v4 = [t4(MILAN, 8), t4(rome, 12), t4(turin, 130), t4(far, 280), t4(MILAN, 99)];
  const v6 = [t6(rome, 150), t6(MILAN, 9), t6(turin, 10), t6(far, 300)];
  assert.deepEqual(pairResults(v4, v6).map((r) => [r.probe.city, !!r.v4, !!r.v6]), [["Milan", true, true], ["Rome", true, true], ["Turin", true, true], ["Sydney", true, true]]);
  assert.equal(pairResults(v4, v6, new Set(["Rome|IT|3269|TIM"])).length, 3);
  const rows = analysePair(v4, v6, {});
  assert.deepEqual(rows.map((r) => `${r.reading.verdict}/${r.reading.level}`), ["none/null", "v6/trombone", "v4/trombone", "far/null"]);
  assert.ok(Math.abs(rows[0].n4 - 8) < 1e-9); // the first result of a probe, as in the tables
  assert.deepEqual(aggregateReadings(rows), { probes: 4, read: 3, none: 1, tromboneV4: 1, tromboneV6: 1, longV4: 0, longV6: 0, far: 1, unknown: 0, misplaced: 0, checked: 0 });
  // one family only: nothing to compare
  assert.equal(analysePair([t4(MILAN, 8)], [], {})[0].reading.verdict, "unknown");
});
