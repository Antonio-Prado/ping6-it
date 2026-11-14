// Tests for the rate limits of the endpoints that read (counted in the cache of the data centre, faked here). Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { tooManyRequests } from "../functions/api/_lib/rateLimit.js";
import { onRequestGet as readReport } from "../functions/api/report/[id].js";

let kvWrites;
const kv = { get: async () => null, put: async () => void (kvWrites += 1) };
const ctx = (ip = "192.0.2.7") => ({ request: new Request("https://ping6.it/api/x", { headers: { "CF-Connecting-IP": ip } }), env: { ASN_META_KV: kv }, params: { id: "abcdefgh" } });

beforeEach(() => {
  kvWrites = 0;
  const m = new Map();
  globalThis.caches = { default: { match: async (r) => m.get(r.url)?.clone(), put: async (r, res) => void m.set(r.url, res) } };
});
afterEach(() => {
  delete globalThis.caches;
});

test("over the limit the answer is 429 with Retry-After, for that address only, and KV is not written", async () => {
  const options = { scope: "t", limit: 3, windowSec: 300, cacheOnly: true };
  for (let i = 0; i < 3; i++) assert.equal(await tooManyRequests(ctx(), options), null);
  const res = await tooManyRequests(ctx(), options);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  assert.equal((await res.json()).error, "rate_limited");
  assert.equal(await tooManyRequests(ctx("192.0.2.8"), options), null);
  assert.equal(kvWrites, 0);
});

test("reading reports stops at 120 requests in five minutes", async () => {
  for (let i = 0; i < 120; i++) assert.equal((await readReport(ctx())).status, 404);
  assert.equal((await readReport(ctx())).status, 429);
});
