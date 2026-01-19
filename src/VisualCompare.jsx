import { memo, useEffect, useMemo, useState } from "react";

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

function percentile(arr, p) {
  const a = Array.isArray(arr) ? arr.filter(isFiniteNum) : [];
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
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

function escapeXml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildShareSvg({
  appName,
  kindLabel,
  targetLabel,
  metricLabel,
  sortLabel,
  unit,
  rows,
  getV4,
  getV6,
  getDelta,
}) {
  const W = 960;
  const headerH = 92;
  const rowH = 34;
  const pad = 18;
  const footerH = 44;
  const N = Math.min(10, rows.length);
  const H = headerH + N * rowH + footerH;

  const labelX = pad;
  const labelW = 390;
  const barsX = labelX + labelW + 14;
  const barsW = 360;
  const deltaX = barsX + barsW + 14;

  const shareRows = rows.slice(0, N);

  const maxVal = shareRows.reduce((m, r) => {
    const a = getV4(r);
    const b = getV6(r);
    return Math.max(m, isFiniteNum(a) ? a : 0, isFiniteNum(b) ? b : 0);
  }, 0);
  const denom = maxVal || 1;

  const fmt = unit === "%" ? (x) => (isFiniteNum(x) ? `${x.toFixed(1)}%` : "-") : (x) => (isFiniteNum(x) ? `${x.toFixed(1)} ms` : "-");

  const title = `${appName} · ${kindLabel}`;
  const sub = `Target: ${targetLabel}`;
  const meta = `Metric: ${metricLabel} · Sort: ${sortLabel}`;
  const now = new Date();
  const stamp = `Generated: ${now.toISOString().replace("T", " ").replace("Z", " UTC")}`;

  const svg = [];
  svg.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  );
  svg.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="#ffffff" stroke="#e5e7eb"/>`);

  // Header
  svg.push(`<text x="${pad}" y="34" font-family="ui-sans-serif,system-ui" font-size="22" font-weight="800" fill="#111827">${escapeXml(title)}</text>`);
  svg.push(`<text x="${pad}" y="56" font-family="ui-sans-serif,system-ui" font-size="13" fill="#374151">${escapeXml(sub)}</text>`);
  svg.push(`<text x="${pad}" y="74" font-family="ui-sans-serif,system-ui" font-size="13" fill="#374151">${escapeXml(meta)}</text>`);
  svg.push(`<text x="${pad}" y="88" font-family="ui-sans-serif,system-ui" font-size="11" fill="#6b7280">${escapeXml(stamp)}</text>`);

  // Legend
  svg.push(`<rect x="${W - 170}" y="22" width="12" height="12" rx="3" fill="#2563eb"/>`);
  svg.push(`<text x="${W - 152}" y="32" font-family="ui-sans-serif,system-ui" font-size="12" fill="#111827">v4</text>`);
  svg.push(`<rect x="${W - 120}" y="22" width="12" height="12" rx="3" fill="#ea580c"/>`);
  svg.push(`<text x="${W - 102}" y="32" font-family="ui-sans-serif,system-ui" font-size="12" fill="#111827">v6</text>`);

  // Row headers
  svg.push(`<line x1="${pad}" y1="${headerH}" x2="${W - pad}" y2="${headerH}" stroke="#e5e7eb"/>`);

  for (let i = 0; i < N; i++) {
    const r = shareRows[i];
    const yTop = headerH + i * rowH;
    const yMid = yTop + rowH / 2;

    const label = String(r?.label || "-");
    const v4 = getV4(r);
    const v6 = getV6(r);
    const d = getDelta(r);

    const excluded = Boolean(r?.excluded);
    const opacity = excluded ? 0.55 : 1;

    const w4 = isFiniteNum(v4) ? Math.max(0, (v4 / denom) * barsW) : 0;
    const w6 = isFiniteNum(v6) ? Math.max(0, (v6 / denom) * barsW) : 0;

    const deltaText = isFiniteNum(d)
      ? unit === "%"
        ? `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`
        : `${d >= 0 ? "+" : ""}${d.toFixed(1)} ms`
      : "-";

    const deltaColor = isFiniteNum(d) ? (d > 0 ? "#b91c1c" : d < 0 ? "#166534" : "#111827") : "#6b7280";

    // zebra background
    if (i % 2 === 1) {
      svg.push(`<rect x="${pad}" y="${yTop}" width="${W - pad * 2}" height="${rowH}" fill="#f9fafb" opacity="${opacity}"/>`);
    }

    svg.push(
      `<text x="${labelX}" y="${yMid + 5}" font-family="ui-sans-serif,system-ui" font-size="12" fill="#111827" opacity="${opacity}">${escapeXml(label.length > 54 ? label.slice(0, 51) + "…" : label)}</text>`
    );

    // bars background
    svg.push(`<rect x="${barsX}" y="${yTop + 7}" width="${barsW}" height="8" rx="999" fill="#f3f4f6" opacity="${opacity}"/>`);
    svg.push(`<rect x="${barsX}" y="${yTop + 7}" width="${w4}" height="8" rx="999" fill="#2563eb" opacity="${opacity}"/>`);

    svg.push(`<rect x="${barsX}" y="${yTop + 19}" width="${barsW}" height="8" rx="999" fill="#f3f4f6" opacity="${opacity}"/>`);
    svg.push(`<rect x="${barsX}" y="${yTop + 19}" width="${w6}" height="8" rx="999" fill="#ea580c" opacity="${opacity}"/>`);

    // right-side values (compact)
    const vText = `${fmt(v4)} / ${fmt(v6)}`;
    svg.push(
      `<text x="${barsX + barsW + 8}" y="${yMid + 5}" font-family="ui-sans-serif,system-ui" font-size="11" fill="#374151" opacity="${opacity}">${escapeXml(vText)}</text>`
    );

    svg.push(
      `<text x="${deltaX}" y="${yMid + 5}" font-family="ui-sans-serif,system-ui" font-size="12" font-weight="700" fill="${deltaColor}" opacity="${opacity}">Δ ${escapeXml(deltaText)}</text>`
    );
  }

  // Footer
  svg.push(`<line x1="${pad}" y1="${H - footerH}" x2="${W - pad}" y2="${H - footerH}" stroke="#e5e7eb"/>`);
  svg.push(
    `<text x="${pad}" y="${H - 18}" font-family="ui-sans-serif,system-ui" font-size="12" fill="#6b7280">Top ${N} rows shown. Lower is better.</text>`
  );

  svg.push(`</svg>`);
  return { svg: svg.join(""), width: W, height: H };
}

async function svgToPngBlob(svgString, width, height, scale = 2) {
  const blob = new Blob([svgString], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context not available");

    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);

    const out = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!out) throw new Error("Failed to encode PNG");
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default memo(function VisualCompare({
  t,
  rows,
  defaultMetric = "latency",
  showSparklines = false,
  shareContext,
}) {
  const data = Array.isArray(rows) ? rows : [];

  const hasLoss = useMemo(
    () => data.some((r) => isFiniteNum(r?.v4loss) || isFiniteNum(r?.v6loss)),
    [data]
  );

  const hasRegions = useMemo(() => data.some((r) => String(r?.regionKey || "").trim()), [data]);

  const [metric, setMetric] = useState(() => (hasLoss ? defaultMetric : "latency"));
  const [sortBy, setSortBy] = useState("worst");

  const metricKey = metric === "loss" ? "loss" : "latency";

  useEffect(() => {
    if (!hasLoss && metric === "loss") setMetric("latency");
  }, [hasLoss, metric]);

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

  const fixedScale = useMemo(() => {
    if (metricKey === "loss") return { good: 1, bad: 5 };
    return { good: 40, bad: 120 };
  }, [metricKey]);

  const [heatMode, setHeatMode] = useState(() => (hasRegions ? "adaptive_region" : "adaptive_global"));

  useEffect(() => {
    // If we have no region metadata, force global adaptive.
    if (!hasRegions && heatMode === "adaptive_region") setHeatMode("adaptive_global");
  }, [hasRegions, heatMode]);

  const adaptiveScales = useMemo(() => {
    const effective = selected.arr.some((r) => !r?.excluded) ? selected.arr.filter((r) => !r?.excluded) : selected.arr;

    const collectAll = () =>
      effective
        .flatMap((r) => [selected.getV4(r), selected.getV6(r)])
        .filter(isFiniteNum);

    const compute = (values) => {
      const v = Array.isArray(values) ? values.filter(isFiniteNum) : [];
      if (v.length < 5) return null;

      if (metricKey === "loss") {
        const good = percentile(v, 0.25);
        const bad = percentile(v, 0.9);
        if (!isFiniteNum(good) || !isFiniteNum(bad) || bad <= good) return null;
        return { good, bad };
      }

      const good = percentile(v, 0.3);
      const bad = percentile(v, 0.85);
      if (!isFiniteNum(good) || !isFiniteNum(bad) || bad <= good) return null;
      return { good, bad };
    };

    const global = compute(collectAll()) || fixedScale;

    const byRegion = {};
    if (hasRegions) {
      const buckets = new Map();
      effective.forEach((r) => {
        const k = String(r?.regionKey || "").trim() || "(unknown)";
        const prev = buckets.get(k) || [];
        const a = selected.getV4(r);
        const b = selected.getV6(r);
        if (isFiniteNum(a)) prev.push(a);
        if (isFiniteNum(b)) prev.push(b);
        buckets.set(k, prev);
      });

      for (const [k, vals] of buckets.entries()) {
        byRegion[k] = compute(vals) || global;
      }
    }

    return { global, byRegion };
  }, [selected, metricKey, fixedScale, hasRegions]);

  const getHeatScaleForRow = useMemo(() => {
    if (heatMode === "fixed") return () => fixedScale;
    if (heatMode === "adaptive_region" && hasRegions) {
      return (r) => {
        const k = String(r?.regionKey || "").trim() || "(unknown)";
        return adaptiveScales.byRegion?.[k] || adaptiveScales.global || fixedScale;
      };
    }
    // adaptive_global
    return () => adaptiveScales.global || fixedScale;
  }, [heatMode, hasRegions, adaptiveScales, fixedScale]);

  const [shareOpen, setShareOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState(null);

  const title = t ? t("visualCompareTitle") : "Visual compare";
  const metricLabelLatency = t ? t("visualCompareMetricLatency") : "Latency";
  const metricLabelLoss = t ? t("visualCompareMetricLoss") : "Packet loss";
  const sortWorst = t ? t("visualCompareSortWorst") : "Worst IPv6 (Δ v6−v4)";
  const sortBest = t ? t("visualCompareSortBest") : "Best IPv6 (Δ v6−v4)";
  const sortLabel = t ? t("visualCompareSortLabel") : "Label";
  const heatmapTitle = t ? t("visualCompareHeatmap") : "Heatmap";
  const hopProfile = t ? t("visualCompareHopProfile") : "Hop RTT profile";

  const heatScaleLabel = t ? t("visualCompareHeatScaleLabel") : "Heatmap scale";
  const heatScaleAdaptiveRegion = t ? t("visualCompareHeatScaleAdaptiveRegion") : "Adaptive (by region)";
  const heatScaleAdaptiveGlobal = t ? t("visualCompareHeatScaleAdaptiveGlobal") : "Adaptive (global)";
  const heatScaleFixed = t ? t("visualCompareHeatScaleFixed") : "Fixed";

  const heatLegendTitle = t ? t("visualCompareHeatLegendTitle") : "Legend";
  const heatLegendNoData = t ? t("visualCompareHeatLegendNoData") : "No data";
  const heatLegendVaries = t
    ? t("visualCompareHeatLegendVaries")
    : "Thresholds vary by region; hover a cell for details.";

  const shareBtn = t ? t("visualCompareShare") : "Share";
  const shareCardTitle = t ? t("visualCompareShareCardTitle") : "Share-ready card";
  const copyImageLabel = t ? t("visualCompareCopyImage") : "Copy image";
  const downloadPngLabel = t ? t("visualCompareDownloadPng") : "Download PNG";
  const shareNote = t ? t("visualCompareShareNote", { n: 10 }) : "Top 10 rows shown (excluding incomplete pairs when possible).";

  const sortLabelResolved = sortBy === "best" ? sortBest : sortBy === "label" ? sortLabel : sortWorst;
  const metricLabelResolved = metricKey === "loss" ? metricLabelLoss : metricLabelLatency;
  const unit = metricKey === "loss" ? "%" : "ms";

  const shareRows = useMemo(() => {
    const arr = selected.arr;
    const nonExcluded = arr.filter((r) => !r?.excluded);
    const base = nonExcluded.length ? nonExcluded : arr;
    return base;
  }, [selected]);

  const shareSvgSpec = useMemo(() => {
    const ctx = shareContext || {};
    const appName = String(ctx.appName || "ping6.it");
    const kindLabel = String(ctx.kindLabel || "").trim() || "Compare";
    const targetLabel = String(ctx.targetLabel || "").trim() || "-";

    return buildShareSvg({
      appName,
      kindLabel,
      targetLabel,
      metricLabel: metricLabelResolved,
      sortLabel: sortLabelResolved,
      unit,
      rows: shareRows,
      getV4: selected.getV4,
      getV6: selected.getV6,
      getDelta: selected.getDelta,
    });
  }, [shareContext, metricLabelResolved, sortLabelResolved, unit, shareRows, selected]);

  async function copyShareImage() {
    setShareStatus(null);
    try {
      const blob = await svgToPngBlob(shareSvgSpec.svg, shareSvgSpec.width, shareSvgSpec.height, 2);
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        setShareStatus(t ? t("visualCompareCopyOk") : "Copied to clipboard.");
      } else {
        setShareStatus(t ? t("visualCompareCopyUnsupported") : "Clipboard image copy is not supported in this browser.");
      }
    } catch (e) {
      setShareStatus(t ? t("visualCompareExportFailed") : "Export failed.");
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }

  async function downloadSharePng() {
    setShareStatus(null);
    try {
      const blob = await svgToPngBlob(shareSvgSpec.svg, shareSvgSpec.width, shareSvgSpec.height, 2);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeKind = String(shareContext?.kindLabel || "compare").toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
      const safeMetric = metricKey;
      const safeSort = sortBy;
      a.download = `ping6-${safeKind}-${safeMetric}-${safeSort}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setShareStatus(t ? t("visualCompareExportFailed") : "Export failed.");
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }

  const heatHint = useMemo(() => {
    const g = adaptiveScales.global || fixedScale;
    const fmt = metricKey === "loss" ? fmtPct : fmtMs;

    if (heatMode === "fixed") return `${heatScaleFixed} · good ≈ ${fmt(fixedScale.good)} · bad ≈ ${fmt(fixedScale.bad)}`;
    if (heatMode === "adaptive_region" && hasRegions) return `${heatScaleAdaptiveRegion} · thresholds vary by region`;
    return `${heatScaleAdaptiveGlobal} · good ≈ ${fmt(g.good)} · bad ≈ ${fmt(g.bad)}`;
  }, [adaptiveScales, fixedScale, metricKey, heatMode, hasRegions, heatScaleFixed, heatScaleAdaptiveRegion, heatScaleAdaptiveGlobal]);

  const heatLegend = useMemo(() => {
    const scale = heatMode === "fixed" ? fixedScale : adaptiveScales.global || fixedScale;
    const fmt = metricKey === "loss" ? fmtPct : fmtMs;

    const good = scale?.good;
    const bad = scale?.bad;
    if (!isFiniteNum(good) || !isFiniteNum(bad) || good === bad) {
      return {
        good: t ? t("visualCompareHeatLegendGood", { value: "-" }) : "Good",
        moderate: t ? t("visualCompareHeatLegendModerate", { from: "-", to: "-" }) : "Moderate",
        high: t ? t("visualCompareHeatLegendHigh", { value: "-" }) : "High",
      };
    }

    const b1 = good + 0.5 * (bad - good);
    const b2 = good + 0.85 * (bad - good);
    const v1 = fmt(b1);
    const v2 = fmt(b2);

    const goodLabel = t ? t("visualCompareHeatLegendGood", { value: v1 }) : `Good (<= ${v1})`;
    const modLabel = t ? t("visualCompareHeatLegendModerate", { from: v1, to: v2 }) : `Moderate (${v1} - ${v2})`;
    const highLabel = t ? t("visualCompareHeatLegendHigh", { value: v2 }) : `High (>= ${v2})`;

    return { good: goodLabel, moderate: modLabel, high: highLabel };
  }, [adaptiveScales, fixedScale, metricKey, heatMode, t]);

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

          <button
            type="button"
            onClick={() => setShareOpen((v) => !v)}
            style={{
              padding: "6px 10px",
              borderRadius: 10,
              border: "1px solid #e5e7eb",
              background: shareOpen ? "#111827" : "#fff",
              color: shareOpen ? "#fff" : "#111827",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {shareBtn}
          </button>
        </div>
      </div>

      {shareOpen ? (
        <div style={{ marginTop: 10, border: "1px solid #e5e7eb", borderRadius: 12, padding: 10, background: "#fafafa" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 13 }}>{shareCardTitle}</div>
              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>{shareNote}</div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={copyShareImage}
                style={{
                  padding: "6px 10px",
                  borderRadius: 10,
                  border: "1px solid #e5e7eb",
                  background: "#fff",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {copyImageLabel}
              </button>
              <button
                type="button"
                onClick={downloadSharePng}
                style={{
                  padding: "6px 10px",
                  borderRadius: 10,
                  border: "1px solid #e5e7eb",
                  background: "#fff",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {downloadPngLabel}
              </button>
            </div>
          </div>

          {shareStatus ? <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>{shareStatus}</div> : null}

          <div style={{ marginTop: 10, overflowX: "auto" }}>
            <div
              style={{
                width: 960,
                maxWidth: "100%",
                background: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: 16,
                padding: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 18, color: "#111827" }}>
                    {String(shareContext?.appName || "ping6.it")} · {String(shareContext?.kindLabel || "Compare")}
                  </div>
                  <div style={{ fontSize: 12, color: "#374151", marginTop: 2 }}>
                    Target: {String(shareContext?.targetLabel || "-")}
                  </div>
                  <div style={{ fontSize: 12, color: "#374151", marginTop: 2 }}>
                    Metric: {metricLabelResolved} · Sort: {sortLabelResolved}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#111827", display: "flex", gap: 10, alignItems: "center" }}>
                  <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: "#2563eb", display: "inline-block" }} /> v4
                  </div>
                  <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: "#ea580c", display: "inline-block" }} /> v6
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb" }}>
                {shareRows.slice(0, 10).map((r, idx) => {
                  const v4 = selected.getV4(r);
                  const v6 = selected.getV6(r);
                  const d = selected.getDelta(r);
                  const denom = selected.maxVal || 1;

                  const w4 = isFiniteNum(v4) ? Math.max(2, (v4 / denom) * 100) : 0;
                  const w6 = isFiniteNum(v6) ? Math.max(2, (v6 / denom) * 100) : 0;

                  const excluded = Boolean(r?.excluded);
                  const rowOpacity = excluded ? 0.55 : 1;

                  const deltaColor = isFiniteNum(d) ? (d > 0 ? "#b91c1c" : d < 0 ? "#166534" : "#111827") : "#6b7280";

                  const fmt = metricKey === "loss" ? fmtPct : fmtMs;

                  return (
                    <div
                      key={r?.id || r?.label || idx}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "380px 1fr 150px",
                        gap: 12,
                        alignItems: "center",
                        padding: "8px 0",
                        borderBottom: "1px solid #f3f4f6",
                        opacity: rowOpacity,
                      }}
                    >
                      <div style={{ fontSize: 12, color: "#111827", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {r?.label || "-"}
                      </div>

                      <div style={{ display: "grid", gap: 6 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "34px 1fr 100px", gap: 8, alignItems: "center" }}>
                          <div style={{ fontSize: 11, opacity: 0.8, color: "#111827" }}>v4</div>
                          <div style={{ height: 9, background: "#f3f4f6", borderRadius: 999, overflow: "hidden" }}>
                            <div style={{ width: `${w4}%`, height: "100%", background: "#2563eb" }} />
                          </div>
                          <div style={{ fontSize: 11, textAlign: "right", color: "#374151" }}>{fmt(v4)}</div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "34px 1fr 100px", gap: 8, alignItems: "center" }}>
                          <div style={{ fontSize: 11, opacity: 0.8, color: "#111827" }}>v6</div>
                          <div style={{ height: 9, background: "#f3f4f6", borderRadius: 999, overflow: "hidden" }}>
                            <div style={{ width: `${w6}%`, height: "100%", background: "#ea580c" }} />
                          </div>
                          <div style={{ fontSize: 11, textAlign: "right", color: "#374151" }}>{fmt(v6)}</div>
                        </div>
                      </div>

                      <div style={{ fontSize: 12, textAlign: "right", color: deltaColor, fontWeight: 800, whiteSpace: "nowrap" }}>
                        Δ {isFiniteNum(d) ? (metricKey === "loss" ? fmtPct(d) : fmtMs(d)) : "-"}
                      </div>
                    </div>
                  );
                })}

                <div style={{ marginTop: 8, fontSize: 11, color: "#6b7280" }}>Top 10 rows shown. Lower is better.</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

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
                gridTemplateColumns: showSparklines
                  ? "minmax(180px, 1fr) 1fr 130px 140px"
                  : "minmax(180px, 1fr) 1fr 130px",
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
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ fontWeight: 700, fontSize: 12 }}>{heatmapTitle}</div>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, opacity: 0.9 }}>
            <span style={{ opacity: 0.75 }}>{heatScaleLabel}</span>
            <select value={heatMode} onChange={(e) => setHeatMode(e.target.value)} style={{ padding: 6 }}>
              {hasRegions ? <option value="adaptive_region">{heatScaleAdaptiveRegion}</option> : null}
              <option value="adaptive_global">{heatScaleAdaptiveGlobal}</option>
              <option value="fixed">{heatScaleFixed}</option>
            </select>
          </label>
        </div>
        <div style={{ marginTop: 4, fontSize: 11, opacity: 0.75 }}>{heatHint}</div>

        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.9 }}>{heatLegendTitle}</div>

          <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span style={{ width: 12, height: 12, borderRadius: 4, background: "#dcfce7", border: "1px solid #e5e7eb" }} />
            <span style={{ fontSize: 11, opacity: 0.85 }}>{heatLegend.good}</span>
          </div>

          <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span style={{ width: 12, height: 12, borderRadius: 4, background: "#fef9c3", border: "1px solid #e5e7eb" }} />
            <span style={{ fontSize: 11, opacity: 0.85 }}>{heatLegend.moderate}</span>
          </div>

          <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span style={{ width: 12, height: 12, borderRadius: 4, background: "#fee2e2", border: "1px solid #e5e7eb" }} />
            <span style={{ fontSize: 11, opacity: 0.85 }}>{heatLegend.high}</span>
          </div>

          <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span style={{ width: 12, height: 12, borderRadius: 4, background: "#ffffff", border: "1px dashed #9ca3af" }} />
            <span style={{ fontSize: 11, opacity: 0.85 }}>{heatLegendNoData}</span>
          </div>
        </div>

        {heatMode === "adaptive_region" && hasRegions ? (
          <div style={{ marginTop: 6, fontSize: 11, opacity: 0.75 }}>{heatLegendVaries}</div>
        ) : null}

        <div style={{ overflowX: "auto", marginTop: 8 }}>
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

                const scale = getHeatScaleForRow(r);
                const c4 = heatColor(v4, scale);
                const c6 = heatColor(v6, scale);

                const regionLabel = String(r?.regionLabel || r?.regionKey || "").trim();
                const titleParts = [];
                if (regionLabel) titleParts.push(`Region: ${regionLabel}`);
                titleParts.push(`good≈${metricKey === "loss" ? fmtPct(scale.good) : fmtMs(scale.good)}`);
                titleParts.push(`bad≈${metricKey === "loss" ? fmtPct(scale.bad) : fmtMs(scale.bad)}`);
                const cellTitle = titleParts.join(" · ");

                return (
                  <tr key={`hm-${r?.id || r?.label}`} style={r?.excluded ? { opacity: 0.55 } : undefined}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #f3f4f6", wordBreak: "break-word" }}>{r?.label || "-"}</td>
                    <td title={cellTitle} style={{ padding: "6px 8px", borderBottom: "1px solid #f3f4f6", background: c4 }}>
                      {fmt(v4)}
                    </td>
                    <td title={cellTitle} style={{ padding: "6px 8px", borderBottom: "1px solid #f3f4f6", background: c6 }}>
                      {fmt(v6)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 11, opacity: 0.75 }}>
        Colors are indicative (lower is better). Exported images include exact numbers.
      </div>
    </div>
  );
});
