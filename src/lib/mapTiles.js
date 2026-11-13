// A small map made of the tiles of OpenStreetMap (Web Mercator, 256 px tiles), laid out by this page: no static-map
// service in between. Pure functions; the component is src/ProbeMap.jsx.

export const TILE = 256;
const MAX_LAT = 85.0511;

// A place as a point of the world at zoom z, in pixels from the top left corner.
export function project(lat, lon, z) {
  const size = TILE * 2 ** z;
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const s = Math.sin((la * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size };
}

// The view that shows all the points in a frame of width x height pixels: the deepest zoom (between minZoom and maxZoom)
// at which they fit with a margin, centred on them, without going past the top or the bottom of the world. At the
// shallowest zoom the world is narrower than the frame, and repeats at its sides.
// Returns { z, left, top } (the corner of the frame in world pixels), the tiles to draw and the points in the frame.
export function mapView(points, { width = 800, height = 320, pad = 40, minZoom = 1, maxZoom = 7 } = {}) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!pts.length) return null;
  let z = maxZoom;
  let box = null;
  for (; z >= minZoom; z--) {
    const xy = pts.map((p) => project(p.lat, p.lon, z));
    box = { x0: Math.min(...xy.map((p) => p.x)), x1: Math.max(...xy.map((p) => p.x)), y0: Math.min(...xy.map((p) => p.y)), y1: Math.max(...xy.map((p) => p.y)) };
    if (box.x1 - box.x0 <= width - 2 * pad && box.y1 - box.y0 <= height - 2 * pad) break;
  }
  if (z < minZoom) z = minZoom;
  const size = TILE * 2 ** z;
  const left = Math.round((box.x0 + box.x1) / 2 - width / 2);
  const top = Math.round(Math.max(0, Math.min(size - height, (box.y0 + box.y1) / 2 - height / 2)));

  const n = 2 ** z;
  const tiles = [];
  for (let ty = Math.floor(top / TILE); ty * TILE < top + height; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / TILE); tx * TILE < left + width; tx++) {
      tiles.push({ z, x: ((tx % n) + n) % n, y: ty, px: tx * TILE - left, py: ty * TILE - top });
    }
  }
  const marks = pts.map((p) => {
    const q = project(p.lat, p.lon, z);
    return { ...p, px: q.x - left, py: q.y - top };
  });
  return { z, left, top, width, height, tiles, marks };
}

export const tileUrl = (t) => `https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`;
