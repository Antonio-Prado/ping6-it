import { memo, useMemo } from "react";
import { TILE, mapView, tileUrl } from "./lib/mapTiles";

// The probes on a map of OpenStreetMap tiles. Everything is placed in percentages of the frame, so the map follows the
// width of the page without measuring it.
const W = 800;
const H = 320;
const pc = (v, of) => `${(v / of) * 100}%`;

function ProbeMap({ points, label }) {
  const view = useMemo(() => mapView(points, { width: W, height: H }), [points]);
  if (!view) return null;
  return (
    <div
      role="img"
      aria-label={label}
      style={{ position: "relative", width: "100%", maxWidth: 820, aspectRatio: `${W} / ${H}`, overflow: "hidden", borderRadius: 8, border: "1px solid #e5e7eb", background: "#aad3df" }}
    >
      {view.tiles.map((t) => (
        <img
          key={`${t.z}/${t.x}/${t.y}/${t.px}`}
          src={tileUrl(t)}
          alt=""
          loading="lazy"
          draggable={false}
          style={{ position: "absolute", left: pc(t.px, W), top: pc(t.py, H), width: pc(TILE, W), height: pc(TILE, H), maxWidth: "none", display: "block" }}
        />
      ))}
      {view.marks.map((m, i) => (
        <span
          key={`${m.lat},${m.lon},${i}`}
          title={m.label || `${m.lat.toFixed(2)}, ${m.lon.toFixed(2)}`}
          style={{ position: "absolute", left: pc(m.px, W), top: pc(m.py, H), width: 12, height: 12, marginLeft: -6, marginTop: -6, borderRadius: "50%", background: "#dc2626", border: "2px solid #fff", boxShadow: "0 0 2px rgba(0,0,0,0.6)", boxSizing: "border-box" }}
        />
      ))}
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noopener noreferrer"
        style={{ position: "absolute", right: 0, bottom: 0, padding: "1px 5px", fontSize: 10, background: "rgba(255,255,255,0.8)", color: "#111" }}
      >
        © OpenStreetMap contributors
      </a>
    </div>
  );
}

export default memo(ProbeMap);
