import { memo, useMemo, useState } from "react";

function isFiniteNum(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function fmtMs(x) {
  if (!isFiniteNum(x)) return "-";
  return `${x.toFixed(1)} ms`;
}

function fmtPct(x) {
  if (!isFiniteNum(x)) return "-";
  return `${x.toFixed(1)}%`;
}

function clamp01(x) {
  if (!isFiniteNum(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function heatColor(value, { good, bad }) {
  if (!isFiniteNum(value)) return "transparent";
  if (!isFiniteNum(good) || !isFiniteNum(bad) || good === bad) return "#f3f4f6";
  // lower is better
  const t = clamp01((value - good) / (bad - good));
  // green -> yellow -> red (very lightweight, no deps)
  if (t <= 0.5) return "#dcfce7"; // green-ish
  if (t <= 0.85) return "#fef9c3"; // yellow-ish
  return "#fee2e2"; // red-ish
}

function buildSparkPoints(values, w, h) {
  const arr = Array.isArray(values) ? values : [];
  const finite = arr.map((v, i) => ({ v, i })).filter((x) => isFiniteNum(x.v));
  if (finite.length < 2) return "";

  const minV = Math.min(...finite.map((x) => x.v));
  const maxV = Math.max(...finite.map((x) => x.v));
  const span = maxV - minV || 1;

  const lastIndex = Math.max(...finite.map((x) => x.i)) || 1;

  return finite
    .map(({ v, i }) => {
      const x = (i / lastIndex) * w;
      const y = h - ((v - minV) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

const DualSparkline = memo(function DualSparkline({ series4, series6 }) {
  const w = 120;
  const h = 28;

  const p4 = useMemo(() => buildSparkPoints(series4, w, h), [series4]);
  const p6 = useMemo(() => buildSparkPoints(series6, w, h), [series6]);

  if (!p4 && !p6) return <span style={{ opacity: 0.6 }}>-</span>;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <rect x="0" y="0" width={w} height={h} fill="#f3f4f6" rx="6" />
      {p4 ? <polyline points={p4} fill="none" stroke="#2563eb" strokeWidth="2" /> : null}
      {p6 ? <polyline points={p6} fill="none" stroke="#ea580c" strokeWidth="2" /> : null}
    </svg>
  );
});

export default memo(function VisualCompare({ t, rows, defaultMetric = "latency", showSparklines = false }) {
  const data = Array.isArray(rows) ? rows : [];

  const hasLoss = useMemo(
    () => data.some((r) => isFiniteNum(r?.v4loss) || isFiniteNum(r?.v6loss)),
    [data]
  );

  const [metric, setMetric] = useState(() => (hasLoss ? defaultMetric : "latency"));
  const [sortBy, setSortBy] = useState("worst");

  const metricKey = metric === "loss" ? "loss" : "latency";

  const selected = useMemo(() => {
    const getV4 = (r) => (metricKey === "loss" ? r?.v4loss : r?.v4);
    const getV6 = (r) => (metricKey === "loss" ? r?.v6loss : r?.v6);
    const getDelta = (r) => {
      const a = getV4(r);
      const b = getV6(r);
      return isFiniteNum(a) && isFiniteNum(b) ? b - a : null;
    };

    const arr = data.slice();
    arr.sort((ra, rb) => {
      if (sortBy === "label") {
        return String(ra?.label || "").localeCompare(String(rb?.label || ""));
      }
      const da = getDelta(ra);
      const db = getDelta(rb);
      const na = !isFiniteNum(da);
      const nb = !isFiniteNum(db);
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      return sortBy === "best" ? da - db : db - da; // best: ascending, worst: descending
    });

    const maxVal = arr.reduce((m, r) => {
      const a = getV4(r);
      const b = getV6(r);
      return Math.max(m, isFiniteNum(a) ? a : 0, isFiniteNum(b) ? b : 0);
    }, 0);

    return { arr, getV4, getV6, getDelta, maxVal: maxVal || 1 };
  }, [data, metricKey, sortBy]);

  const heatScale = useMemo(() => {
    // conservative defaults
    if (metricKey === "loss") return { good: 1, bad: 5 };
    return { good: 40, bad: 120 };
  }, [metricKey]);

  const title = t ? t("visualCompareTitle") : "Visual compare";
  const metricLabelLatency = t ? t("visualCompareMetricLatency") : "Latency";
  const metricLabelLoss = t ? t("visualCompareMetricLoss") : "Packet loss";
  const sortWorst = t ? t("visualCompareSortWorst") : "Worst IPv6 (Δ v6−v4)";
  const sortBest = t ? t("visualCompareSortBest") : "Best IPv6 (Δ v6−v4)";
  const sortLabel = t ? t("visualCompareSortLabel") : "Label";
  const heatmapTitle = t ? t("visualCompareHeatmap") : "Heatmap";
  const hopProfile = t ? t("visualCompareHopProfile") : "Hop RTT profile";

  // keep metric valid if loss isn't available
  if (!hasLoss && metric === "loss") {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    setMetric("latency");
  }

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: 12,
        background: "#fff",
      }}
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 800 }}>{title}</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, opacity: 0.9 }}>
            <span style={{ opacity: 0.75 }}>Metric</span>
            <select value={metricKey} onChange={(e) => setMetric(e.target.value)} style={{ padding: 6 }}>
              <option value="latency">{metricLabelLatency}</option>
              {hasLoss ? <option value="loss">{metricLabelLoss}</option> : null}
            </select>
          </label>

          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, opacity: 0.9 }}>
            <span style={{ opacity: 0.75 }}>Sort</span>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ padding: 6 }}>
              <option value="worst">{sortWorst}</option>
              <option value="best">{sortBest}</option>
              <option value="label">{sortLabel}</option>
            </select>
          </label>
        </div>
      </div>

      <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
        {selected.arr.map((r) => {
          const v4 = selected.getV4(r);
          const v6 = selected.getV6(r);
          const d = selected.getDelta(r);

          const w4 = isFiniteNum(v4) ? Math.max(2, (v4 / selected.maxVal) * 100) : 0;
          const w6 = isFiniteNum(v6) ? Math.max(2, (v6 / selected.maxVal) * 100) : 0;

          const excluded = Boolean(r?.excluded);
          const rowOpacity = excluded ? 0.55 : 1;

          const deltaColor = isFiniteNum(d) ? (d > 0 ? "#b91c1c" : d < 0 ? "#166534" : "#111") : "#6b7280";

          const fmt = metricKey === "loss" ? fmtPct : fmtMs;

          return (
            <div
              key={r?.id || r?.label}
              style={{
                display: "grid",
                gridTemplateColumns: showSparklines ? "minmax(180px, 1fr) 1fr 130px 140px" : "minmax(180px, 1fr) 1fr 130px",
                gap: 10,
                alignItems: "center",
                opacity: rowOpacity,
              }}
            >
              <div style={{ fontSize: 12, wordBreak: "break-word" }}>{r?.label || "-"}</div>

              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: "34px 1fr 86px", gap: 8, alignItems: "center" }}>
                  <div style={{ fontSize: 11, opacity: 0.8 }}>v4</div>
                  <div style={{ height: 10, background: "#f3f4f6", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ width: `${w4}%`, height: "100%", background: "#2563eb" }} />
                  </div>
                  <div style={{ fontSize: 11, textAlign: "right" }}>{fmt(v4)}</div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "34px 1fr 86px", gap: 8, alignItems: "center" }}>
                  <div style={{ fontSize: 11, opacity: 0.8 }}>v6</div>
                  <div style={{ height: 10, background: "#f3f4f6", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ width: `${w6}%`, height: "100%", background: "#ea580c" }} />
                  </div>
                  <div style={{ fontSize: 11, textAlign: "right" }}>{fmt(v6)}</div>
                </div>
              </div>

              <div style={{ fontSize: 12, textAlign: "right", color: deltaColor, whiteSpace: "nowrap" }}>
                Δ {isFiniteNum(d) ? (metricKey === "loss" ? fmtPct(d) : fmtMs(d)) : "-"}
              </div>

              {showSparklines ? (
                <div title={hopProfile} style={{ display: "flex", justifyContent: "flex-end" }}>
                  <DualSparkline series4={r?.series4} series6={r?.series6} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>{heatmapTitle}</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 8px" }}>{sortLabel}</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 8px" }}>v4</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 8px" }}>v6</th>
              </tr>
            </thead>
            <tbody>
              {selected.arr.map((r) => {
                const v4 = selected.getV4(r);
                const v6 = selected.getV6(r);
                const fmt = metricKey === "loss" ? fmtPct : fmtMs;

                const c4 = heatColor(v4, heatScale);
                const c6 = heatColor(v6, heatScale);

                return (
                  <tr key={`hm-${r?.id || r?.label}`} style={r?.excluded ? { opacity: 0.55 } : undefined}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #f3f4f6", wordBreak: "break-word" }}>{r?.label || "-"}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #f3f4f6", background: c4 }}>{fmt(v4)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #f3f4f6", background: c6 }}>{fmt(v6)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 11, opacity: 0.75 }}>
        Colors are indicative (lower is better). Use export to share exact numbers.
      </div>
    </div>
  );
});
