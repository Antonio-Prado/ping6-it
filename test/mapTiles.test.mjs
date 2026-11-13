// Unit tests for src/lib/mapTiles.js. Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { mapView, project, tileUrl } from "../src/lib/mapTiles.js";

test("Web Mercator: the middle of the world, its edges, and the poles kept inside", () => {
  assert.deepEqual(project(0, 0, 0), { x: 128, y: 128 });
  assert.equal(project(0, -180, 2).x, 0);
  assert.equal(project(0, 180, 2).x, 1024);
  assert.ok(project(90, 0, 0).y >= 0 && project(90, 0, 0).y < 0.01);
  assert.ok(project(-90, 0, 0).y <= 256 && project(-90, 0, 0).y > 255.99);
  // London at zoom 7 is on tile 63/42
  const p = project(51.5074, -0.1278, 7);
  assert.deepEqual([Math.floor(p.x / 256), Math.floor(p.y / 256)], [63, 42]);
});

test("the view holds every probe, as deep as they fit, and its tiles cover the frame", () => {
  const pts = [{ lat: 51.5, lon: -0.1, label: "GB" }, { lat: 53.3, lon: -6.3, label: "IE" }, { lat: 48.9, lon: 2.3, label: "FR" }];
  const v = mapView(pts);
  assert.ok(v.z >= 5 && v.z <= 7, `zoom ${v.z}`);
  for (const m of v.marks) assert.ok(m.px >= 40 && m.px <= 760 && m.py >= 40 && m.py <= 280, `${m.label} at ${m.px},${m.py}`);
  assert.deepEqual(v.marks.map((m) => m.label), ["GB", "IE", "FR"]);
  // every pixel of the frame is under a tile
  for (const [x, y] of [[0, 0], [799, 0], [0, 319], [799, 319], [400, 160]]) {
    assert.ok(v.tiles.some((t) => x >= t.px && x < t.px + 256 && y >= t.py && y < t.py + 256), `${x},${y}`);
  }
  assert.ok(v.tiles.length <= 15);
  assert.match(tileUrl(v.tiles[0]), /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
});

test("probes all over the world: the shallowest zoom, tiles that wrap, nothing past the poles", () => {
  const v = mapView([{ lat: 64, lon: -150 }, { lat: -34, lon: 151 }, { lat: 1, lon: 103 }]);
  assert.equal(v.z, 1);
  const n = 2;
  for (const m of v.marks) assert.ok(m.px >= 0 && m.px <= 800 && m.py >= 0 && m.py <= 320, `${m.px},${m.py}`);
  for (const t of v.tiles) assert.ok(t.x >= 0 && t.x < n && t.y >= 0 && t.y < n);
  assert.ok(v.top >= 0 && v.top + 320 <= 512);
  // one probe alone: the deepest zoom, the probe in the middle
  const one = mapView([{ lat: 45.46, lon: 9.19 }]);
  assert.equal(one.z, 7);
  assert.ok(Math.abs(one.marks[0].px - 400) <= 1 && Math.abs(one.marks[0].py - 160) <= 1);
  assert.equal(mapView([]), null);
  assert.equal(mapView([{ lat: NaN, lon: 1 }]), null);
});
