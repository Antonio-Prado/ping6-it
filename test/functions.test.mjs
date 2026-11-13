// Tests for the server functions that use the RIPE Atlas key of the site, with RIPE Atlas and Turnstile faked. Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { resolveAtlasKey, sharedAtlasLimits, spendSharedAtlasBudget } from "../functions/api/_lib/atlasKey.js";
import { onRequestGet as config } from "../functions/api/atlas/config.js";
import { onRequestPost as pair } from "../functions/api/atlas/measurements-pair.js";
import { onRequestPost as anchorPings } from "../functions/api/atlas/anchor-pings.js";
import { onRequestGet as readMeasurement } from "../functions/api/atlas/measurements/[id].js";

const realFetch = globalThis.fetch;
let calls;

// A KV namespace in memory, as the rate limiter uses it.
function fakeKv() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), put: async (k, v) => void m.set(k, v) };
}

const anchor = (id) => ({ id, fqdn: `xx-yyy-as${id}.anchors.atlas.ripe.net`, ip_v4: "192.0.2.1", is_disabled: false, city: "City", country: "XX", geometry: { coordinates: [9.19, 45.46] } });

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET", auth: init.headers?.authorization || "", body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (u.includes("turnstile")) return ok({ success: true, action: "ping6_run", hostname: "ping6.it" });
    if (u.endsWith("/api/v2/measurements/") && init.method === "POST") return ok({ measurements: JSON.parse(init.body).definitions.map((_, i) => 9000 + i) }, 201);
    const a = /\/api\/v2\/anchors\/(\d+)\/$/.exec(u);
    if (a) return Number(a[1]) === 404 ? ok({}, 404) : Number(a[1]) === 13 ? ok({ ...anchor(13), is_disabled: true }) : ok(anchor(Number(a[1])));
    if (/\/api\/v2\/measurements\/\d+\/$/.test(u)) return ok({ id: 1, status: { name: "Stopped" }, type: "ping" });
    return ok([]);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const post = (path, body, headers = {}) =>
  new Request(`https://ping6.it${path}`, { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers }, body: JSON.stringify(body) });
const pairBody = (limit) => ({ turnstileToken: "t", base: { type: "ping", target: "example.org", limit, locations: [{ magic: "Europe" }] }, measurementOptions: { packets: 3 }, flow: "v6first" });

test("which key a request runs with, and the limits of the key of the site", () => {
  const withKey = new Request("https://ping6.it/", { headers: { "X-Atlas-Key": " mine " } });
  assert.deepEqual(resolveAtlasKey(withKey, { ATLAS_API_KEY: "site" }), { key: "mine", shared: false });
  assert.deepEqual(resolveAtlasKey(new Request("https://ping6.it/"), { ATLAS_API_KEY: "site" }), { key: "site", shared: true });
  assert.deepEqual(resolveAtlasKey(new Request("https://ping6.it/"), {}), { key: "", shared: false });
  assert.deepEqual(sharedAtlasLimits({}), { hourlyPerIp: 6, daily: 200, maxProbes: 25 });
  assert.deepEqual(sharedAtlasLimits({ ATLAS_SHARED_HOURLY_PER_IP: "3", ATLAS_SHARED_DAILY: "50", ATLAS_SHARED_MAX_PROBES: "500" }), { hourlyPerIp: 3, daily: 50, maxProbes: 50 });
});

test("the page is told whether a key is needed, and nothing about the key", async () => {
  assert.deepEqual(await (await config({ env: {} })).json(), { sharedKey: false });
  const body = await (await config({ env: { ATLAS_API_KEY: "secret-of-the-site" } })).json();
  assert.deepEqual(body, { sharedKey: true, maxProbes: 25, hourlyPerIp: 6 });
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("the key of the site: so many tests an hour for an address, so many a day for everybody", async () => {
  const env = { RATE_LIMIT_KV: fakeKv(), ATLAS_SHARED_HOURLY_PER_IP: "2", ATLAS_SHARED_DAILY: "3" };
  const from = (ip) => new Request("https://ping6.it/", { headers: { "CF-Connecting-IP": ip } });
  assert.equal(await spendSharedAtlasBudget({ request: from("203.0.113.1"), env }), null);
  assert.equal(await spendSharedAtlasBudget({ request: from("203.0.113.1"), env }), null);
  const third = await spendSharedAtlasBudget({ request: from("203.0.113.1"), env });
  assert.equal(third.status, 429);
  assert.equal(third.body.error, "atlas_shared_rate_limited");
  assert.equal(await spendSharedAtlasBudget({ request: from("203.0.113.2"), env }), null); // another address, third test of the day
  const fourth = await spendSharedAtlasBudget({ request: from("203.0.113.3"), env });
  assert.equal(fourth.body.error, "atlas_shared_budget_spent");
});

test("a pair without a key of the visitor runs with the key of the site, on fewer probes, within its limits", async () => {
  const env = { TURNSTILE_SECRET: "s", ATLAS_API_KEY: "site-key", RATE_LIMIT_KV: fakeKv(), ATLAS_SHARED_HOURLY_PER_IP: "1" };
  const res = await pair({ request: post("/api/atlas/measurements-pair", pairBody(50)), env });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json().then((b) => [b.m4.id, b.m6.id]), ["9000", "9001"]);
  const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/v2/measurements/"));
  assert.equal(created.auth, "Key site-key");
  const asked = (c) => c.body.probes.reduce((t, x) => t + x.requested, 0);
  assert.equal(asked(created), 25); // not the 50 that were asked
  const again = await pair({ request: post("/api/atlas/measurements-pair", pairBody(5)), env });
  assert.equal(again.status, 429);
  assert.equal((await again.json()).error, "atlas_shared_rate_limited");
  // a visitor who brings a key is not bounded by the limits of the site
  const own = await pair({ request: post("/api/atlas/measurements-pair", pairBody(50), { "X-Atlas-Key": "mine" }), env });
  assert.equal(own.status, 200);
  const last = calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/v2/measurements/")).pop();
  assert.equal(last.auth, "Key mine");
  assert.equal(asked(last), 50);
});

test("without any key the pair is refused before anything is asked", async () => {
  const res = await pair({ request: post("/api/atlas/measurements-pair", pairBody(5)), env: { TURNSTILE_SECRET: "s" } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "missing_atlas_api_key");
  assert.equal(calls.length, 0);
});

test("the pings to the anchors: only anchors can be aimed at, from a bounded set of probes", async () => {
  const env = { TURNSTILE_SECRET: "s", ATLAS_API_KEY: "site-key", RATE_LIMIT_KV: fakeKv() };
  const probes = Array.from({ length: 40 }, (_, i) => 6000 + i);
  const res = await anchorPings({ request: post("/api/atlas/anchor-pings", { turnstileToken: "t", probes: [...probes, "x", -1, 6000], anchors: [11, 12, 13, 404, 11] }), env });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.probes.length, 25); // the limit of the key of the site
  assert.deepEqual(body.pings.map((p) => [p.id, p.anchor.id]), [["9000", 11], ["9001", 12]]); // a disabled anchor and a missing one are left out
  assert.deepEqual([body.pings[0].anchor.latitude, body.pings[0].anchor.longitude], [45.46, 9.19]);
  const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/v2/measurements/"));
  assert.deepEqual(created.body.definitions.map((d) => [d.type, d.af, d.target, d.packets, d.is_oneoff]), [["ping", 4, "xx-yyy-as11.anchors.atlas.ripe.net", 3, true], ["ping", 4, "xx-yyy-as12.anchors.atlas.ripe.net", 3, true]]);
  assert.equal(created.body.probes[0].type, "probes");
  assert.equal(created.body.probes[0].value.split(",").length, 25);

  const none = await anchorPings({ request: post("/api/atlas/anchor-pings", { turnstileToken: "t", probes: [6000], anchors: [404] }), env });
  assert.equal(none.status, 400);
  const empty = await anchorPings({ request: post("/api/atlas/anchor-pings", { turnstileToken: "t", probes: [], anchors: [11] }), env });
  assert.equal(empty.status, 400);
});

test("reading a measurement never uses the key of the site", async () => {
  const env = { ATLAS_API_KEY: "site-key" };
  await readMeasurement({ request: new Request("https://ping6.it/api/atlas/measurements/123"), env, params: { id: "123" } });
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => !c.auth));
  calls = [];
  await readMeasurement({ request: new Request("https://ping6.it/api/atlas/measurements/123", { headers: { "X-Atlas-Key": "mine" } }), env, params: { id: "123" } });
  assert.ok(calls.some((c) => c.auth === "Key mine"));
});
