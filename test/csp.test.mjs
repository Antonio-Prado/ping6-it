// Tests for the Content-Security-Policy: the fixed header and the one with a nonce. Run with: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { cspHeader } from "../functions/api/_lib/csp.js";
import { onRequest } from "../functions/_middleware.js";

const page = (type = "text/html; charset=utf-8") =>
  new Response("<!doctype html>", { headers: { "content-type": type, "content-security-policy": cspHeader(), "x-frame-options": "DENY" } });

test("public/_headers carries the policy of functions/api/_lib/csp.js", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.ok(headers.includes(`\n  Content-Security-Policy: ${cspHeader()}\n`));
});

test("the page gets a new nonce at each request, and keeps its other headers", async () => {
  const nonces = [];
  for (let i = 0; i < 2; i++) {
    const res = await onRequest({ next: async () => page() });
    const csp = res.headers.get("content-security-policy");
    const m = /script-src [^;]*'nonce-([A-Za-z0-9+/]{24})'/.exec(csp);
    assert.ok(m, csp);
    assert.equal(csp.replace(` 'nonce-${m[1]}'`, ""), cspHeader());
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(await res.text(), "<!doctype html>");
    nonces.push(m[1]);
  }
  assert.notEqual(nonces[0], nonces[1]);
});

test("the answers of the API are left as they are", async () => {
  const api = new Response("{}", { headers: { "content-type": "application/json" } });
  assert.equal(await onRequest({ next: async () => api }), api);
});
