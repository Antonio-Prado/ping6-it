import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { waitForMeasurement } from "./lib/globalping";
import { setStoredAtlasKey, waitForAtlasMeasurement } from "./lib/atlas";
import { GEO_PRESETS } from "./geoPresets";
import VisualCompare from "./VisualCompare";
// Turnstile (Cloudflare) - load on demand (only when the user presses Run).
let __turnstileScriptPromise = null;
const TURNSTILE_LOAD_TIMEOUT_MS = 8000;
const TURNSTILE_EXEC_TIMEOUT_MS = 30000;

// ASN metadata cache (in-browser, per page load)
const ASN_META_CACHE = new Map();
const ASN_META_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IP_META_CACHE = new Map();
const IP_META_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getIpMetaCache(ip) {
  const key = String(ip || "").trim();
  if (!key) return null;
  const entry = IP_META_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > IP_META_CACHE_TTL_MS) {
    IP_META_CACHE.delete(key);
    return null;
  }
  return entry.data || null;
}

function setIpMetaCache(ip, data) {
  const key = String(ip || "").trim();
  if (!key) return;
  IP_META_CACHE.set(key, { ts: Date.now(), data });
}
function loadTurnstileScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("Turnstile can only run in the browser."));
  if (window.turnstile) return Promise.resolve();
  if (__turnstileScriptPromise) return __turnstileScriptPromise;

  __turnstileScriptPromise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      __turnstileScriptPromise = null;
      reject(new Error("Turnstile script timed out. Please disable blockers and try again."));
    }, TURNSTILE_LOAD_TIMEOUT_MS);
    const existing = document.querySelector('script[data-turnstile="1"]');
    if (existing) {
      existing.addEventListener(
        "load",
        () => {
          clearTimeout(timeoutId);
          resolve();
        },
        { once: true }
      );
      existing.addEventListener(
        "error",
        () => {
          clearTimeout(timeoutId);
          __turnstileScriptPromise = null;
          reject(new Error("Failed to load Turnstile script."));
        },
        { once: true }
      );
      return;
    }

    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.defer = true;
    s.dataset.turnstile = "1";
    s.onload = () => {
      clearTimeout(timeoutId);
      resolve();
    };
    s.onerror = () => {
      clearTimeout(timeoutId);
      __turnstileScriptPromise = null;
      reject(new Error("Failed to load Turnstile script."));
    };
    document.head.appendChild(s);
  });

  return __turnstileScriptPromise;
}
function isIpLiteral(s) {
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  return ipv4.test(s) || (s.includes(":") && ipv6.test(s));
}

function isIPv4LiteralStrict(s) {
  const m = String(s || "").trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  for (let i = 1; i <= 4; i += 1) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

function isIPv6LiteralLoose(s) {
  const v = String(s || "").trim();
  if (!v || !v.includes(":")) return false;
  if (v.includes("%")) return false;
  if (!/^[0-9a-fA-F:]+$/.test(v)) return false;
  const parts = v.split(":");
  if (parts.length < 3 || parts.length > 9) return false;
  return true;
}

function isIpLiteralStrict(s) {
  return isIPv4LiteralStrict(s) || isIPv6LiteralLoose(s);
}

function ms(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return `${n.toFixed(1)} ms`;
}

function pct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return `${n.toFixed(1)}%`;
}

function formatElapsed(msValue) {
  const ms = Number(msValue);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatAgeHuman(msValue) {
  const ms = Number(msValue);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  const minutesTotal = Math.floor(totalSeconds / 60);
  const hoursTotal = Math.floor(minutesTotal / 60);
  const days = Math.floor(hoursTotal / 24);

  const seconds = totalSeconds % 60;
  const minutes = minutesTotal % 60;
  const hours = hoursTotal % 24;

  if (days > 0) return `${days}d ${hours}h`;
  if (hoursTotal > 0) return `${hoursTotal}h ${minutes}m`;
  if (minutesTotal > 0) return `${minutesTotal}m ${seconds}s`;
  return `${totalSeconds}s`;
}

function clampInputValue(value, { min, max, fallback, allowEmpty = false }) {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return allowEmpty ? "" : String(fallback);
  const num = Number(raw);
  if (!Number.isFinite(num)) return allowEmpty ? "" : String(fallback);
  const clamped = Math.min(max, Math.max(min, num));
  return String(clamped);
}


function sortRowsStable(rows, getVal, dir = "asc") {
  const arr = Array.isArray(rows) ? rows : [];
  const mult = dir === "desc" ? -1 : 1;
  const isNil = (v) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));

  return arr
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const va = getVal(a.r);
      const vb = getVal(b.r);

      const na = isNil(va);
      const nb = isNil(vb);
      if (na && nb) return a.i - b.i;
      if (na) return 1;
      if (nb) return -1;

      if (typeof va === "number" && typeof vb === "number") {
        const d = (va - vb) * mult;
        return d !== 0 ? d : a.i - b.i;
      }

      const sa = String(va);
      const sb = String(vb);
      const d = sa.localeCompare(sb) * mult;
      return d !== 0 ? d : a.i - b.i;
    })
    .map((x) => x.r);
}

function getCompareSortValue(_table, key, row) {
  const r = row || {};
  const p = r.probe || {};

  if (key === "idx") return Number.isFinite(r.idx) ? r.idx : 0;
  if (key === "location") return formatProbeLocation(p) || "";
  if (key === "asn") {
    const n = Number(p.asn);
    return Number.isFinite(n) ? n : 0;
  }
  if (key === "network") return p.network || "";

  const v = r[key];
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function sortCompareRows(rows, table, sort) {
  const s = sort || {};
  if (!s.key || s.table !== table) return rows;
  return sortRowsStable(rows, (r) => getCompareSortValue(table, s.key, r), s.dir || "asc");
}

const TOOLTIP_CSS = `
.tt{position:relative;display:inline-flex;align-items:center}
.tt-bubble{position:absolute;left:50%;top:100%;transform:translateX(-50%) translateY(-2px);margin-top:8px;padding:8px 10px;width:max-content;max-width:360px;white-space:normal;font-size:12px;line-height:1.35;border-radius:10px;background:#111827;color:#fff;box-shadow:0 12px 28px rgba(0,0,0,.22);opacity:0;pointer-events:none;z-index:9999;transition:opacity 120ms ease,transform 120ms ease}
.tt-bubble::before{content:"";position:absolute;top:-6px;left:50%;transform:translateX(-50%);border-width:0 6px 6px 6px;border-style:solid;border-color:transparent transparent #111827 transparent}
.tt:hover .tt-bubble,.tt:focus .tt-bubble,.tt:focus-within .tt-bubble{opacity:1;transform:translateX(-50%) translateY(0)}
.tt-info{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:999px;border:1px solid rgba(17,24,39,.35);color:rgba(17,24,39,.9);font-size:11px;line-height:1;opacity:.75;cursor:help;user-select:none}
@media (prefers-reduced-motion: reduce){.tt-bubble{transition:none}}
`;

const ATLAS_PROGRESS_CSS = `
.p6-spin{width:14px;height:14px;border-radius:999px;border:2px solid rgba(17,24,39,.2);border-top-color:rgba(17,24,39,.75);animation:p6rot 900ms linear infinite}
@keyframes p6rot{to{transform:rotate(360deg)}}
.p6-dots{display:inline-flex;gap:3px;align-items:center}
.p6-dots span{width:4px;height:4px;border-radius:999px;background:rgba(17,24,39,.65);animation:p6dot 1200ms ease-in-out infinite}
.p6-dots span:nth-child(2){animation-delay:150ms}
.p6-dots span:nth-child(3){animation-delay:300ms}
@keyframes p6dot{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}
.p6-indet{position:relative;height:3px;border-radius:999px;background:rgba(17,24,39,.12);overflow:hidden}
.p6-indet::after{content:"";position:absolute;top:0;left:0;height:100%;width:40%;border-radius:999px;background:rgba(17,24,39,.35);transform:translateX(-60%);animation:p6bar 1100ms ease-in-out infinite}
@keyframes p6bar{to{transform:translateX(320%)}}
@media (prefers-reduced-motion: reduce){.p6-spin,.p6-dots span,.p6-indet::after{animation:none}}
`;

const COPY = {
  en: {
    tagline: "IPv4 vs IPv6, side by side",
    visualCompareTitle: "Visual compare",
    visualCompareMetricLatency: "Latency",
    visualCompareMetricLoss: "Packet loss",
    visualCompareSortWorst: "Worst IPv6 (Δ v6−v4)",
    visualCompareSortBest: "Best IPv6 (Δ v6−v4)",
    visualCompareSortLabel: "Label",
    visualCompareHeatmap: "Heatmap",
    visualCompareHopProfile: "Hop RTT profile",
    feedback: "Feedback welcome",
    docs: "Docs",
    source: "Source",
    backend: "Backend",
    backendGlobalping: "Globalping",
    backendAtlas: "RIPE Atlas (experimental)",
    atlasApiKey: "Atlas API key",
    command: "Command",
    net: "Net",
    from: "From",
    probes: "Probes",
    asn: "ASN",
    isp: "ISP",
    deltaAlert: "Δ alert (ms)",

    excludeUnstableProbes: "Exclude unstable probes",
    helpExcludeUnstableProbes: "Exclude probes that frequently miss v4 or v6 results in recent History. This only affects comparison rows/statistics; it does not change how measurements are executed.",
    unstableProbesDetected: ({ n }) => `${n} unstable probe(s) detected in recent history.`,
    probeBlacklist: "Probe blacklist",
    placeholderProbeBlacklist: "IDs/keys (comma, space, or newline separated)",
    helpProbeBlacklist: "Exclude specific probe IDs/keys from comparison (comma/space/newline separated). Useful to manually mute known flapping probes.",

    asnMetaRpkiShare: "share",
    asnMetaRpkiByFamily: "By family",
    asnMetaRpkiHintOk: "No obvious RPKI issues in this sample.",
    asnMetaRpkiHintWarn: ({ pct }) => `Invalid share is ${pct} in this sample. If this ASN originates these prefixes, review ROAs; otherwise investigate upstream/downstream policy.`,
    asnMetaRpkiHintAlert: ({ pct }) => `Invalid share is ${pct} in this sample. Investigate invalid routes/ROAs and possible leaks or mis-origination.`,
    ipv6Only: "IPv6-capable probes only",
    packets: "Packets",
    packetsHop: "Packets/hop",
    proto: "Proto",
    port: "Port",
    query: "Query",
    resolver: "Resolver",
    trace: "trace",
    method: "Method",
    path: "Path",
    queryString: "Query",
    target: "Target",
    multiTarget: "Multi-target",
    run: "Run",
    cancel: "Cancel",
    advanced: "Advanced",
    basic: "Basic",
    raw: "Raw",
    hideRaw: "Hide raw",
    exportJson: "Export JSON",
    exportCsv: "Export CSV",
    exportAllJson: "Export all JSON",
    exportAllCsvSummary: "Export all CSV (summary)",
    exportAllCsvRows: "Export all CSV (rows)",
    includeRaw: "Include raw",
    tipIncludeRaw: "Include raw backend payloads in the exported JSON (may be large).",
    shareLink: "Share link",
    reportMode: "Report mode",
    linkReady: "Link ready:",
    multiTargetResults: "Multi-target results",
    viewResults: "View results",
    viewing: "Viewing",
    waitingFirstResult: "Waiting for the first result…",
    runningWithTarget: ({ current, total, target }) => `Running ${current}/${total} · ${target}`,
    progress: ({ done, total }) => `Progress: ${done}/${total} completed.`,
    completedTargets: ({ done }) => `Completed targets: ${done}.`,
    clickTargetToLoad: "Click a target to load its full results below.",
    historyTitle: "History (local)",
    clear: "Clear",
    historyNote: "Stored in your browser only.",
    filters: "filters",
    loadSettings: "Load settings",
    noHistory: "No history yet. Run a measurement to start tracking your last runs.",
    compareRuns: "Compare runs",
    runA: "Run A",
    runB: "Run B",
    selectRun: "Select…",
    compareMismatch: "Select two runs with the same command to compare.",
    deltaRunLabel: "Δ = Run B - Run A",
    metric: "Metric",
    report: "Report",
    exitReportMode: "Exit report mode",
    reportLinkShort: "Short report link",
    reportExpires: "Expires",
    reportLoading: "Loading report…",
    reportCreateFailed: "Short report link unavailable. Falling back to an encoded URL.",
    reportNotFound: "Report not found or expired.",
    reportAll: "Report all",
    tipReportAll: "Generate a short report link for the whole multi-target run.",
    generated: "Generated",
    ipv6OnlyYes: "yes",
    ipv6OnlyNo: "no",
    ipv6OnlyShort: "IPv6-only",
    deltaAlertNotice: ({ label, delta, threshold }) => `${label} is ${ms(delta)} (threshold ${threshold} ms).`,
    probeMap: "Probe map",
    probeMapAlt: "Map of probe locations",
    noProbeCoordinates: "No coordinates available for these probes.",
    coverageTitle: "Probe coverage",
    measurementStatusTitle: "Measurement status",
    measurementStatusBody: ({ v4, v6 }) => `IPv4: ${v4} · IPv6: ${v6}. Some rows may be missing or incomplete.`,
    coverageV4: "IPv4 responses",
    coverageV6: "IPv6 responses",
    coverageBoth: "Both (v4+v6)",
    coverageHint: "Some probes may be offline or unable to reach the target. Try increasing the probe count or changing the region/preset.",
    pingTitle: "Ping RTT (v4 vs v6)",
    tracerouteTitle: "Traceroute to destination (v4 vs v6)",
    traceroutePathsTitle: "Traceroute paths (v4 vs v6)",
    pathDiff: "diff",
    showHops: "hops",
    hideHops: "hide",
    perHopDiffTitle: "Per-hop diff",
    hop: "hop",
    pathDivergeAt: ({ n }) => `diverge @ hop ${n}`,
    pathNoDivergence: ({ n }) => `no divergence in first ${n} hop(s)`,
    pathMissingCounts: ({ v4, v6 }) => `missing: v4 ${v4}, v6 ${v6}`,
    pathNoHopData: "No hop data.",
    perHopAsnLoading: "ASN lookup…",
    pathShowingFirstHops: ({ n }) => `Showing first ${n} hops.`,
    asnLookupLoading: "ASN lookup…",

    mtrTitle: "MTR to destination (v4 vs v6)",
    mtrPathsTitle: "MTR paths (v4 vs v6)",
    dnsTitle: "DNS timings (v4 vs v6)",
    httpTitle: "HTTP timings (v4 vs v6)",
    rawV4: "RAW v4",
    rawV6: "RAW v6",
    footer: "If it works, thank",
    footerTail: "If not, blame IPv4!",
    summaryBoth: "both",
    comparedOnDualStack: ({ both, n }) => `Compared on ${both}/${n} dual-stack probes. Rows missing v4 or v6 are excluded from statistics.`,
    excludedBadge: "excluded",
    all: "All",
    summaryMedianV4: "median v4",
    summaryMedianV6: "median v6",
    summaryMedianAvgV4: "median avg v4",
    summaryMedianAvgV6: "median avg v6",
    summaryMedianLossV4: "median loss v4",
    summaryMedianLossV6: "median loss v6",
    summaryMedianDelta: "Δ",
    deltaPingLabel: "Ping median Δ",
    deltaTracerouteLabel: "Traceroute median Δ",
    deltaMtrLabel: "MTR median Δ",
    deltaDnsLabel: "DNS median Δ",
    deltaHttpLabel: "HTTP median Δ",
    summaryP95V4: "p95 v4",
    summaryP95V6: "p95 v6",
    summaryP95AvgV4: "p95 avg v4",
    summaryP95AvgV6: "p95 avg v6",
    summaryDeltaLoss: "Δ",
    location: "location",
    network: "network",
    v4Avg: "v4 avg",
    v4Loss: "v4 loss",
    v6Avg: "v6 avg",
    v6Loss: "v6 loss",
    deltaV6V4: "Δ v6-v4",
    winner: "winner",
    v4Reached: "v4 reached",
    v4Hops: "v4 hops",
    v4Dst: "v4 dst",
    v6Reached: "v6 reached",
    v6Hops: "v6 hops",
    v6Dst: "v6 dst",
    probe: "probe",
    v4Path: "v4 path",
    v6Path: "v6 path",
    v4Total: "v4 total",
    v6Total: "v6 total",
    ratio: "ratio",
    v4Status: "v4 status",
    v6Status: "v6 status",
    v4LossShort: "v4 loss",
    v6LossShort: "v6 loss",
    deltaAvg: "Δ avg",
    deltaLoss: "Δ loss",
    yes: "yes",
    no: "no",
    helpCommand: "Measurement type to run. IPv4 and IPv6 are executed on the same probes for a fair comparison.",
    helpNet: "Probe network profile filter: any, eyeball (access/consumer), or datacenter.",
    helpFrom: "Where probes are selected (Globalping location string). Presets below can fill this automatically.",
    helpProbes: "Number of probes to run (Globalping: 1–10, Atlas: 1–50). More probes improve coverage but take longer.",
    helpBackend: "Choose the measurement network backend. Globalping is the default. RIPE Atlas can provide many more probes but requires an API key.",
    helpAtlasKey: "Get an API key from RIPE Atlas: log in → My Atlas → Keys (API Keys) → Create key. Paste it here. Kept in memory (not stored) and never included in share links.",
    helpAsn: "Filter probes by ASN (e.g. 12345).",
    helpIsp: "ISP name filtering is not supported by the Globalping API: use an ASN when possible.",
    asnCellHint: "Click for ASN details.",
    asnDetailsTitle: "ASN details",
    asnDetailsAbout: "An ASN (Autonomous System Number) identifies the network announcing the probe's public IP. Atlas/Globalping may not always know it for both address families.",
    asnDetailsInTable: ({ n }) => `In this table: ${n} probe(s) with this ASN.`,
    asnDetailsCopy: "Copy ASN",
    asnDetailsUseFilter: "Use as ASN filter",
    asnDetailsClose: "Close",
    asnMetaLoading: "Loading ASN metadata…",
    asnMetaUnavailable: "ASN metadata unavailable.",
    asnMetaRetry: "Retry",
    asnMetaErrorHint: "Please try again. If the problem persists, the upstream service may be temporarily unavailable.",
    asnMetaRefreshing: "refreshing…",
    asnMetaWarming: "warming cache…",
    asnMetaShowMore: "Show more",
    asnMetaShowLess: "Show less",
    asnMetaHolder: "Holder",
    asnMetaRegistry: "Registry",
    asnMetaIana: "IANA block",
    asnMetaAnnounced: "Announced",
    asnMetaAnnouncedHelpAria: "What does Announced mean?",
    asnMetaAnnouncedHelp: "Seen announcing at least one prefix in BGP (per RIPEstat). Useful as a quick signal that the ASN is currently active in the global routing table.",
    asnMetaAnnouncedPrefixes: "Announced prefixes",
    asnMetaAnnouncedPrefixesTotal: "total",
    asnMetaAnnouncedPrefixesV4: "v4",
    asnMetaAnnouncedPrefixesV6: "v6",
    asnMetaRpkiTitle: "RPKI validation (sample)",
    asnMetaRpkiValid: "valid",
    asnMetaRpkiInvalid: "invalid",
    asnMetaRpkiUnknown: "unknown",
    asnMetaRpkiPrefix: "prefix",
    asnMetaRpkiStatus: "status",
    asnMetaRpkiSampleNote: ({ n, v4, v6 }) => `Sample: ${n} prefix(es) (${v4} v4, ${v6} v6).`,
    asnMetaProvenance: ({ source, cache, refreshing, warming, age, fetchedAt }) => {
      const parts = [];
      if (source) parts.push(`source: ${source}`);
      if (cache) parts.push(`cache: ${cache}`);
      if (refreshing) parts.push(refreshing);
      if (warming) parts.push(warming);
      if (age) parts.push(`fetched ${age} ago`);
      if (fetchedAt) parts.push(`at ${fetchedAt}`);
      return parts.length ? `Metadata · ${parts.join(' · ')}` : 'Metadata';
    },
    helpDeltaAlert: "Show a warning when the median v6-v4 delta exceeds this threshold.",
    helpIpv6Only:
      "Select only probes that can run IPv6, then run IPv4 on the same probes for a fair comparison. Requires a hostname target.",
    helpPackets: "Packets per probe (ping) or per hop (mtr).",
    helpProto: "Transport protocol used by traceroute/mtr (ICMP, UDP, TCP).",
    helpPort: "Destination port (used for TCP traceroute or UDP/TCP mtr when applicable).",
    helpDnsQuery: "DNS record type to query (A, AAAA, MX, TXT, etc.).",
    helpDnsProto: "DNS transport protocol: UDP (default) or TCP.",
    helpDnsPort: "DNS server port (default: 53).",
    helpDnsResolver:
      "Override the resolver used by probes (IP or hostname). Leave empty to use the probe default resolver.",
    helpDnsTrace: "Enable DNS trace (when supported) to see the resolution path and timing details.",
    helpHttpMethod: "HTTP method used for the request.",
    helpHttpProto: "HTTP protocol: HTTP, HTTPS, or HTTP2 (HTTPS implies TLS).",
    helpHttpPath: "Request path (e.g. / or /index.html). If you paste a full URL in Target, path may be extracted automatically.",
    helpHttpQuery:
      "Query string without '?', e.g. a=1&b=2. If you paste a full URL in Target, query may be extracted automatically.",
    helpHttpPort: "Override destination port. Leave empty for defaults (80/443).",
    helpHttpResolver:
      "Override the resolver used by probes for the HTTP target (IP or hostname). Leave empty to use the probe default resolver.",
    helpMultiTarget:
      "Click the “Multi-target” label to enable the multi-line input. Run the same measurement against multiple targets (one per line). Results are listed below; click one to load it.",
    tipMultiTargetInput:
      "Enter one target per line. For HTTP you can paste full URLs; for DNS choose the record type above.",
    tipTargetInput:
      "Target hostname. For HTTP you can paste a full URL; for DNS choose the record type above. Using a hostname is recommended for a fair IPv4/IPv6 comparison.",
    tipRun: "Start the measurements (IPv4 and IPv6 side by side).",
    tipCancel: "Abort the current run.",
    tipAdvanced: "Toggle advanced options for the selected command.",
    tipRaw: "Show or hide the raw Globalping output for each probe (IPv4 and IPv6).",
    tipExportJson: "Export the current results as JSON (raw values).",
    tipExportCsv: "Export the current results as CSV (per-probe rows).",
    tipExportAllJson: "Export multi-target results as JSON (one entry per target).",
    tipExportAllCsvSummary: "Export multi-target results as CSV (one row per target).",
    tipExportAllCsvRows: "Export multi-target results as CSV (per-probe rows, all targets).",
    tipShareLink: "Create a shareable link with the current settings.",
    tipReportMode: "Generate a report link from the latest completed run.",
    tipPreset: ({ label }) => `Preset: ${label}. Updates the "From" field.`,
    tipSubPreset: "Refine probes within the selected macro-region.",
    placeholderProbes: "1-10",
    placeholderAsn: "e.g. 12345",
    placeholderIsp: "ISP name",
    placeholderDeltaAlert: "e.g. 25",
    placeholderPort: "1-65535",
    placeholderResolver: "(empty = default)",
    placeholderOptional: "(optional)",
    placeholderMultiDns: "name (e.g. example.com)\nname2.example",
    placeholderMultiHttp: "https://example.com/\nhttps://example.net/",
    placeholderMultiDefault: "hostname (e.g. example.com)\nexample.net",
    placeholderTargetDns: "name (e.g. example.com)",
    placeholderTargetHttp: "URL or hostname (e.g. https://example.com/)",
    placeholderTargetDefault: "hostname (e.g. example.com)",
    statusPreparing: "Preparing measurement...",
    statusWaitingVerification: ({ stepLabel }) => `Waiting for human verification${stepLabel}...`,
    statusWaitingVerificationRetry: ({ ip }) => `Waiting for human verification (retry ${ip})...`,
    retryIpv4: "Retry IPv4",
    retryIpv6: "Retry IPv6",
    retryNotice: ({ v4, v6 }) => `Missing/failed probe results — IPv4: ${v4}, IPv6: ${v6}.`,
    tipRetryIpv4: "Re-run the IPv4 measurement only, keeping the same probes (Globalping/Atlas).",
    tipRetryIpv6: "Re-run the IPv6 measurement only, keeping the same probes (Globalping/Atlas).",
    retryHint: ({ v4, v6 }) => `Missing/failed rows: IPv4 ${v4}, IPv6 ${v6}.`,
    retryNotAvailable: "Retry is currently available only for Globalping and RIPE Atlas single-target runs.",
    errorTargetRequired: "Please enter a target hostname or URL.",
    errorHttpTarget: "For HTTP, enter a valid URL or hostname.",
    errorHostnameRequired: "For the IPv4/IPv6 comparison, enter a hostname (not an IP).",
    errorMultiTargetRequired: "Enter one or more targets (one per line).",
    errorTurnstileMissing:
      'Turnstile is not configured. Set "VITE_TURNSTILE_SITEKEY" in Cloudflare Pages env vars.',
    errorTurnstileUnavailable: "Turnstile script loaded but API is not available.",
    errorTurnstileMissingContainer: "Turnstile container is missing.",
    errorTurnstileTokenExpired: "Turnstile token expired. Please press Run again.",
    errorTurnstileTimeout: "Turnstile timed out. Please press Run again.",
    errorCancelled: "Cancelled.",
    errorHumanVerification: "Human verification failed. Please retry.",
    errorHumanVerificationTimeout: "Human verification timed out. Please retry.",
    errorRequestFailed: ({ status }) => `Request failed (${status})`,
    errorInvalidRequest: "Invalid request. Please review your input and retry.",
    errorRateLimited: ({ retryAfter }) =>
      `Too many requests (rate limit). Please wait${retryAfter ? ` ${retryAfter}` : ""} and try again.`,
    rateLimitRetryIn: ({ seconds }) => `Rate limited. Retry in ${seconds}s.`,
    errorTitle: "Error",
    copy: "Copy",
    errorUpstreamUnavailable: "The measurement service is temporarily unavailable. Please retry in a moment.",
    errorNetworkFailure: "Network error. Please check your connection and retry.",
    errorTurnstileChallengeFailed: ({ code }) =>
      `Human verification failed (Turnstile error ${code}). Try refreshing the page, disabling blockers/VPN, or switching browser/network.`,
    errorTurnstileConfig: ({ code }) =>
      `Human verification is misconfigured (Turnstile error ${code}). Please contact the site owner.`,
    errorTurnstileNetwork: ({ code }) =>
      `Human verification could not load (Turnstile error ${code}). Please check your connection and disable blockers, then retry.`,
  },
};


const HISTORY_STORAGE_KEY = "ping6_history_v1";
const HISTORY_LIMIT = 10;
const SHARE_VERSION = 1;

const EXCLUDED_ROW_STYLE = { opacity: 0.55 };
const EXCLUDED_BADGE_STYLE = {
  display: "inline-block",
  padding: "1px 6px",
  border: "1px solid #d1d5db",
  borderRadius: 999,
  fontSize: 11,
  marginRight: 6,
  verticalAlign: "baseline",
  opacity: 0.85,
};

function Tip({ text, children }) {
  return (
    <span className="tt">
      {children}
      <span className="tt-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}

function Help({ text }) {
  return (
    <span className="tt" tabIndex={0} aria-label={text}>
      <span className="tt-info" aria-hidden="true">
        i
      </span>
      <span className="tt-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}


function SortTh({ table, colKey, label, sort, onToggle, defaultDir = "asc" }) {
  const active = sort?.table === table && sort?.key === colKey;
  const arrow = active ? (sort?.dir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
      <button
        type="button"
        onClick={() => onToggle?.(table, colKey, defaultDir)}
        style={{
          padding: 0,
          margin: 0,
          background: "transparent",
          border: "none",
          font: "inherit",
          color: "inherit",
          cursor: "pointer",
          textAlign: "left",
        }}
        title="Click to sort"
      >
        {label}
        {arrow}
      </button>
    </th>
  );
}


const VirtualList = memo(function VirtualList({
  items,
  height = 420,
  itemHeight = 118,
  overscan = 3,
  renderItem,
  style,
}) {
  const scrollerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);

  const onScroll = useCallback((e) => {
    setScrollTop(e.currentTarget.scrollTop || 0);
  }, []);

  const total = Array.isArray(items) ? items.length : 0;
  const viewportHeight = Math.max(1, Number(height) || 1);
  const rowH = Math.max(1, Number(itemHeight) || 1);

  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowH) + overscan);

  const offsetY = start * rowH;
  const visible = total ? items.slice(start, end) : [];

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      style={{
        height: viewportHeight,
        overflowY: "auto",
        overflowX: "hidden",
        position: "relative",
        borderRadius: 10,
        ...style,
      }}
    >
      <div style={{ height: total * rowH, position: "relative" }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {visible.map((item, i) => renderItem(item, start + i))}
        </div>
      </div>
    </div>
  );
});

const MultiRunResultsList = memo(function MultiRunResultsList({ items, activeId, onSelect, t }) {
  const entries = Array.isArray(items) ? items : [];
  const useVirtual = entries.length > 35;

  const renderEntry = useCallback(
    (entry) => {
      const isActive = entry.id === activeId;
      return (
        <div
          key={entry.id}
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: 10,
            background: isActive ? "#f8fafc" : "transparent",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <strong>{entry.target}</strong>
            <span style={{ opacity: 0.8 }}>{entry.cmd}</span>
          </div>
          {entry.summary && (
            <div
              style={{
                fontSize: 13,
                marginTop: 4,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={`${t("summaryMedianV4")} ${ms(entry.summary.medianV4)} · ${t("summaryMedianV6")} ${ms(
                entry.summary.medianV6
              )} · ${t("summaryMedianDelta")} ${ms(entry.summary.medianDelta)}`}
            >
              {t("summaryMedianV4")} {ms(entry.summary.medianV4)} · {t("summaryMedianV6")} {ms(entry.summary.medianV6)} ·{" "}
              {t("summaryMedianDelta")} {ms(entry.summary.medianDelta)}
              {(entry.summary.kind === "ping" || entry.summary.kind === "mtr") && (
                <>
                  {" · "}
                  {t("v4LossShort")} {pct(entry.summary.medianLossV4)} · {t("v6LossShort")} {pct(entry.summary.medianLossV6)}
                </>
              )}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <button
              onClick={() => onSelect?.(entry)}
              style={{ padding: "6px 10px" }}
              aria-current={isActive ? "true" : "false"}
            >
              {isActive ? t("viewing") : t("viewResults")}
            </button>
          </div>
        </div>
      );
    },
    [activeId, onSelect, t]
  );

  if (!entries.length) return <div style={{ fontSize: 13, opacity: 0.7 }}>{t("waitingFirstResult")}</div>;

  if (!useVirtual) {
    return <div style={{ display: "grid", gap: 10, marginTop: 12 }}>{entries.map(renderEntry)}</div>;
  }

  const ITEM_HEIGHT = 118;
  const height = typeof window === "undefined" ? 420 : Math.min(520, Math.max(260, Math.round(window.innerHeight * 0.45 || 420)));

  return (
    <div style={{ marginTop: 12 }}>
      <VirtualList
        items={entries}
        height={height}
        itemHeight={ITEM_HEIGHT}
        overscan={3}
        style={{ border: "1px solid #e5e7eb" }}
        renderItem={(entry) => <div style={{ height: ITEM_HEIGHT, paddingBottom: 10, boxSizing: "border-box" }}>{renderEntry(entry)}</div>}
      />
    </div>
  );
});

function loadHistory() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeHistorySummary(cmd, v4, v6, { strict = false, excludeKeys = null } = {}) {
  if (!v4 || !v6) return null;
  if (cmd === "ping") {
    const { summary } = buildPingCompare(v4, v6, { strict, excludeKeys });
    return {
      kind: "ping",
      medianV4: summary.median_avg_v4,
      medianV6: summary.median_avg_v6,
      medianDelta: summary.median_delta_avg,
      medianLossV4: summary.median_loss_v4,
      medianLossV6: summary.median_loss_v6,
    };
  }
  if (cmd === "traceroute") {
    const { summary } = buildTracerouteCompare(v4, v6, { strict, excludeKeys });
    return {
      kind: "traceroute",
      medianV4: summary.median_v4,
      medianV6: summary.median_v6,
      medianDelta: summary.median_delta,
    };
  }
  if (cmd === "mtr") {
    const { summary } = buildMtrCompare(v4, v6, { strict, excludeKeys });
    return {
      kind: "mtr",
      medianV4: summary.median_avg_v4,
      medianV6: summary.median_avg_v6,
      medianDelta: summary.median_delta_avg,
      medianLossV4: summary.median_loss_v4,
      medianLossV6: summary.median_loss_v6,
    };
  }
  if (cmd === "dns") {
    const { summary } = buildDnsCompare(v4, v6, { strict, excludeKeys });
    return {
      kind: "dns",
      medianV4: summary.median_v4,
      medianV6: summary.median_v6,
      medianDelta: summary.median_delta,
    };
  }
  if (cmd === "http") {
    const { summary } = buildHttpCompare(v4, v6, { strict, excludeKeys });
    return {
      kind: "http",
      medianV4: summary.median_v4,
      medianV6: summary.median_v6,
      medianDelta: summary.median_delta,
    };
  }
  return null;
}

function parseKeyList(raw) {
  const set = new Set();
  String(raw || "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .forEach((t) => set.add(t));
  return set;
}

function snapshotProbeStates(v4, v6) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const keys = buildProbeUnionKeys(a, b);
  const aMap = buildResultMap(a, "v4");
  const bMap = buildResultMap(b, "v6");
  return keys.map((k) => {
    const s4 = resultState(aMap.get(k) ?? null);
    const s6 = resultState(bMap.get(k) ?? null);
    return { key: k, v4: s4, v6: s6 };
  });
}

function computeUnstableProbeKeys(history, { backend, cmd, windowN = 5, minObs = 3, badRatio = 0.6 } = {}) {
  const items = Array.isArray(history) ? history : [];
  const filtered = items
    .filter((h) => (backend ? h?.backend === backend : true))
    .filter((h) => (cmd ? h?.cmd === cmd : true))
    .slice(-windowN);

  const counts = new Map();
  filtered.forEach((h) => {
    const ps = Array.isArray(h?.probeStates) ? h.probeStates : [];
    ps.forEach((p) => {
      const key = String(p?.key || "").trim();
      if (!key) return;
      const entry = counts.get(key) || { obs: 0, bad: 0 };
      entry.obs += 1;
      const v4ok = String(p?.v4 || "").toLowerCase() === "ok";
      const v6ok = String(p?.v6 || "").toLowerCase() === "ok";
      if (!v4ok || !v6ok) entry.bad += 1;
      counts.set(key, entry);
    });
  });

  const unstable = new Set();
  counts.forEach((c, key) => {
    if (c.obs >= minObs && c.bad / c.obs >= badRatio) unstable.add(key);
  });
  return unstable;
}

function encodeReportPayload(payload) {
  if (typeof window === "undefined") return "";
  try {
    return window.btoa(encodeURIComponent(JSON.stringify(payload)));
  } catch {
    return "";
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadFile(filename, content, type) {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function parseMultiTargets(raw) {
  return String(raw || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function decodeReportPayload(raw) {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(decodeURIComponent(window.atob(raw)));
  } catch {
    return null;
  }
}


const REPORT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function applyUrlSettings(params, setters) {
  const {
    setCmd,
    setBackend,
    setTarget,
    setFrom,
    setGpTag,
    setLimit,
    setRequireV6Capable,
    setPackets,
    setTrProto,
    setTrPort,
    setDnsQuery,
    setDnsProto,
    setDnsPort,
    setDnsResolver,
    setDnsTrace,
    setHttpMethod,
    setHttpProto,
    setHttpPath,
    setHttpQuery,
    setHttpPort,
    setHttpResolver,
    setProbeAsn,
    setProbeIsp,
    setDeltaThreshold,
  } = setters;

  const cmd = params.get("cmd");
  if (cmd) setCmd(cmd);
  const backend = params.get("backend");
  if (backend && (backend === "globalping" || backend === "atlas")) setBackend(backend);
  const target = params.get("target");
  if (target) setTarget(target);
  const from = params.get("from");
  if (from) setFrom(from);
  const gpTag = params.get("net");
  if (gpTag) setGpTag(gpTag);
  const limit = params.get("limit");
  if (limit) setLimit(limit);
  const requireV6Capable = params.get("v6only");
  if (requireV6Capable !== null) setRequireV6Capable(requireV6Capable === "1");

  const packets = params.get("packets");
  if (packets) setPackets(packets);
  const trProto = params.get("trproto");
  if (trProto) setTrProto(trProto);
  const trPort = params.get("trport");
  if (trPort) setTrPort(trPort);

  const dnsQuery = params.get("dnsq");
  if (dnsQuery) setDnsQuery(dnsQuery);
  const dnsProto = params.get("dnsproto");
  if (dnsProto) setDnsProto(dnsProto);
  const dnsPort = params.get("dnsport");
  if (dnsPort) setDnsPort(dnsPort);
  const dnsResolver = params.get("dnsresolver");
  if (dnsResolver) setDnsResolver(dnsResolver);
  const dnsTrace = params.get("dnstrace");
  if (dnsTrace !== null) setDnsTrace(dnsTrace === "1");

  const httpMethod = params.get("httpmethod");
  if (httpMethod) setHttpMethod(httpMethod);
  const httpProto = params.get("httpproto");
  if (httpProto) setHttpProto(httpProto);
  const httpPath = params.get("httppath");
  if (httpPath) setHttpPath(httpPath);
  const httpQuery = params.get("httpquery");
  if (httpQuery) setHttpQuery(httpQuery);
  const httpPort = params.get("httpport");
  if (httpPort) setHttpPort(httpPort);
  const httpResolver = params.get("httpresolver");
  if (httpResolver) setHttpResolver(httpResolver);

  const asn = params.get("asn");
  if (asn) setProbeAsn(asn);
  const isp = params.get("isp");
  if (isp) setProbeIsp(isp);
  const threshold = params.get("delta");
  if (threshold) setDeltaThreshold(threshold);
}



function probeHeader(x, idx) {
  const p = x?.probe || {};
  return `--- probe ${idx + 1}: ${p.city || ""} ${p.country || ""} AS${p.asn || ""} ${p.network || ""}`.trim();
}


const REGION_DISPLAY = (() => {
  try {
    if (typeof Intl !== "undefined" && Intl.DisplayNames) {
      return new Intl.DisplayNames(["en"], { type: "region" });
    }
  } catch {
    // ignore
  }
  return null;
})();

function normalizeCountryLabel(country) {
  const c = String(country ?? "").trim();
  if (!c) return { code: "", name: "" };

  // If it looks like an ISO-3166 alpha-2 code, expand it to a readable name.
  const code = c.length === 2 ? c.toUpperCase() : "";
  const name = code && REGION_DISPLAY ? String(REGION_DISPLAY.of(code) || "").trim() : "";

  if (code && name) return { code, name };
  if (code) return { code, name: code };
  return { code: "", name: c };
}

function formatProbeLocation(probe) {
  if (!probe) return "-";
  const city = String(probe.city ?? "").trim();
  const rawCountry = probe.country ?? probe.country_code ?? probe.countryCode ?? "";
  const { code, name } = normalizeCountryLabel(rawCountry);
  const id = probe.id !== undefined && probe.id !== null ? String(probe.id).trim() : "";

  if (city && name) return `${city}, ${name}`;
  if (city) return city;

  if (name && id) return `${name} · Probe ${id}`;
  if (name) return name;
  if (id) return `Probe ${id}`;
  return "-";
}


function applyGpTag(fromStr, tag) {
  const t = (tag || "").trim();
  if (!t || t === "any") return (fromStr || "").trim();

  const raw = (fromStr || "").trim();
  if (!raw) return t;

  if (raw.includes(`+${t}`) || raw === t) return raw;

  return raw
    .split(",")
    .map((p) => {
      const s = p.trim();
      if (!s) return s;
      if (s.includes(`+${t}`) || s === t) return s;
      if (t === "eyeball" && (s.includes("+datacenter") || s === "datacenter")) return s;
      if (t === "datacenter" && (s.includes("+eyeball") || s === "eyeball")) return s;
      return `${s}+${t}`;
    })
    .join(", ");
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i),
    hi = Math.ceil(i);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function probeKey(x) {
  const p = x?.probe || {};
  return p.id ?? `${p.city ?? ""}|${p.country ?? ""}|${p.asn ?? ""}|${p.network ?? ""}`;
}

function rowKeyFromResult(x, idx, side) {
  const k = probeKey(x);
  const s = k === null || k === undefined ? "" : String(k);
  if (s && s !== "|||") return s;
  return `${side}-${idx}`;
}

function buildProbeUnionKeys(v4Results, v6Results, { excludeKeys } = {}) {
  const keys = [];
  const seen = new Set();
  const ex = excludeKeys instanceof Set ? excludeKeys : null;

  (Array.isArray(v4Results) ? v4Results : []).forEach((x, i) => {
    const k = rowKeyFromResult(x, i, "v4");
    if (ex && ex.has(k)) return;
    if (seen.has(k)) return;
    seen.add(k);
    keys.push(k);
  });

  (Array.isArray(v6Results) ? v6Results : []).forEach((x, i) => {
    const k = rowKeyFromResult(x, i, "v6");
    if (ex && ex.has(k)) return;
    if (seen.has(k)) return;
    seen.add(k);
    keys.push(k);
  });

  return keys;
}

function buildResultMap(results, side) {
  const map = new Map();
  (Array.isArray(results) ? results : []).forEach((x, i) => {
    const k = rowKeyFromResult(x, i, side);
    if (!map.has(k)) map.set(k, x);
  });
  return map;
}

function resultState(x) {
  if (!x) return "missing";
  const r = x?.result;
  if (!r) return "missing";
  if (r?.error) return "error";
  const s = String(r?.status || "").toLowerCase();
  if (s === "finished" || s === "completed") return "ok";
  if (s === "failed") return "failed";
  return s || "unknown";
}

function isRetryableState(state) {
  const s = String(state || "").toLowerCase();
  return s === "missing" || s === "error" || s === "failed" || s === "timeout";
}

function measurementLooksFailed(m) {
  const s = String(m?.status || "").toLowerCase();
  const r = String(m?.statusReason || "").toLowerCase();
  if (s === "failed" || s === "error") return true;
  if (r === "timeout") return true;
  return false;
}

function computeFamilyIssues(v4, v6) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const keys = buildProbeUnionKeys(a, b);
  const aMap = buildResultMap(a, "v4");
  const bMap = buildResultMap(b, "v6");

  let badV4 = 0;
  let badV6 = 0;
  keys.forEach((k) => {
    const s4 = resultState(aMap.get(k) ?? null);
    const s6 = resultState(bMap.get(k) ?? null);
    if (isRetryableState(s4)) badV4 += 1;
    if (isRetryableState(s6)) badV6 += 1;
  });

  // If the measurement itself looks failed (and results may be empty), expose that too.
  if (measurementLooksFailed(v4) && badV4 === 0) badV4 = Math.max(1, badV4);
  if (measurementLooksFailed(v6) && badV6 === 0) badV6 = Math.max(1, badV6);

  return { badV4, badV6 };
}

function stateTitle(prefix, state) {
  if (!state || state === "ok") return "";
  return `${prefix}: ${state}`;
}

function probeCoords(p) {
  if (!p) return null;
  const lat = Number(p.latitude ?? p.lat);
  const lon = Number(p.longitude ?? p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function buildStaticMapUrl(points) {
  if (!points.length) return "";
  const avg = points.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }),
    { lat: 0, lon: 0 }
  );
  const centerLat = avg.lat / points.length;
  const centerLon = avg.lon / points.length;
  const markers = points
    .map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)},red-pushpin`)
    .join("|");
  const params = new URLSearchParams({
    center: `${centerLat.toFixed(5)},${centerLon.toFixed(5)}`,
    zoom: "2",
    size: "800x320",
    markers,
  });
  return `https://staticmap.openstreetmap.de/staticmap.php?${params.toString()}`;
}

function formatHopPath(result, maxHops = 12) {
  const hops = Array.isArray(result?.result?.hops) ? result.result.hops : [];
  const labels = hops
    .map((h) => h?.resolvedHostname || h?.resolvedAddress || h?.address || h?.hostname || "")
    .filter(Boolean);
  if (!labels.length) return "-";
  const sliced = labels.slice(0, maxHops);
  return labels.length > maxHops ? `${sliced.join(" → ")} → …` : sliced.join(" → ");
}


function hopLabelFromHop(h) {
  const s = h?.resolvedHostname || h?.resolvedAddress || h?.address || h?.hostname || h?.ip || "";
  const v = String(s || "").trim();
  return v;
}

function hopIpFromHop(h) {
  const candidates = [h?.resolvedAddress, h?.address, h?.ip, h?.hostname, h?.resolvedHostname];
  for (const c of candidates) {
    const v = String(c || "").trim();
    if (!v) continue;
    // Some backends return 'hostname (ip)' style strings.
    const paren = v.match(/\(([^)]+)\)/);
    if (paren && isIpLiteralStrict(paren[1])) return paren[1].trim();
    if (isIpLiteralStrict(v)) return v;
  }
  return "";
}

function buildHopIndexMap(result) {
  const hops = Array.isArray(result?.result?.hops) ? result.result.hops : [];
  const map = new Map();
  const ipMap = new Map();
  let maxHop = 0;
  let hasHopNumbers = false;

  hops.forEach((h, idx) => {
    const hopNoRaw = Number(h?.hop);
    const hopNo = Number.isFinite(hopNoRaw) && hopNoRaw > 0 ? hopNoRaw : null;
    if (hopNo !== null) hasHopNumbers = true;

    const label = hopLabelFromHop(h);
    const ip = hopIpFromHop(h);
    const key = hopNo !== null ? hopNo : idx + 1;
    if (key > maxHop) maxHop = key;
    if (!map.has(key)) map.set(key, label);
    if (ip && !ipMap.has(key)) ipMap.set(key, ip);
  });

  // Fallback when we have hops but no explicit hop numbers.
  if (!maxHop && hops.length) maxHop = hops.length;

  return { map, ipMap, maxHop, hasHopNumbers };
}

function computeHopDiffSummary(v4res, v6res, maxHops = 30) {
  const a = buildHopIndexMap(v4res);
  const b = buildHopIndexMap(v6res);
  const maxOriginal = Math.max(a.maxHop || 0, b.maxHop || 0);
  const maxHop = Math.min(maxHops, maxOriginal);

  let firstDiffHop = null;
  let diffCount = 0;
  let missingV4 = 0;
  let missingV6 = 0;

  for (let i = 1; i <= maxHop; i += 1) {
    const ha = String(a.map.get(i) || "").trim();
    const hb = String(b.map.get(i) || "").trim();

    const va = ha || "*";
    const vb = hb || "*";

    if (va !== vb) {
      diffCount += 1;
      if (firstDiffHop === null) firstDiffHop = i;
    }

    if (va === "*" && vb !== "*") missingV4 += 1;
    if (vb === "*" && va !== "*") missingV6 += 1;
  }

  return {
    maxHop,
    maxOriginal,
    truncated: maxOriginal > maxHop,
    firstDiffHop,
    diffCount,
    missingV4,
    missingV6,
  };
}

function buildHopAlignment(v4res, v6res, maxHops = 30) {
  const summary = computeHopDiffSummary(v4res, v6res, maxHops);
  const a = buildHopIndexMap(v4res);
  const b = buildHopIndexMap(v6res);

  const rows = [];
  for (let i = 1; i <= summary.maxHop; i += 1) {
    const ha = String(a.map.get(i) || "").trim();
    const hb = String(b.map.get(i) || "").trim();
    const v4 = ha || "*";
    const v6 = hb || "*";
    const diff = v4 !== v6;
    rows.push({ hop: i, v4, v6, v4ip: String(a.ipMap?.get(i) || ""), v6ip: String(b.ipMap?.get(i) || ""), diff, isFirstDiff: summary.firstDiffHop === i });
  }

  return { rows, summary };
}


function pickPingStats(x) {
  const r = x?.result;
  if (r?.status && r.status !== "finished") return { avgMs: null, lossPct: null };
  if (r?.error) return { avgMs: null, lossPct: null };

  const lossRaw = Number(r?.stats?.loss);
  const avgRaw = Number(r?.stats?.avg);

  const lossPct = Number.isFinite(lossRaw) ? lossRaw : null;
  const avgMs =
    Number.isFinite(avgRaw) && avgRaw > 0 && (lossPct === null || lossPct < 100) ? avgRaw : null;

  return { avgMs, lossPct };
}

function buildPingCompare(v4, v6, { strict = false, excludeKeys = null } = {}) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const keys = buildProbeUnionKeys(a, b, { excludeKeys });
  const aMap = buildResultMap(a, "v4");
  const bMap = buildResultMap(b, "v6");

  const rows = keys.map((k, i) => {
    const x = aMap.get(k) ?? null;
    const y = bMap.get(k) ?? null;
    const p = x?.probe || y?.probe || {};

    const s4 = pickPingStats(x);
    const s6 = pickPingStats(y);

    const deltaAvg = Number.isFinite(s4.avgMs) && Number.isFinite(s6.avgMs) ? s6.avgMs - s4.avgMs : null;
    const deltaLoss = Number.isFinite(s4.lossPct) && Number.isFinite(s6.lossPct) ? s6.lossPct - s4.lossPct : null;

    let winner = "-";
    if (Number.isFinite(s4.lossPct) && Number.isFinite(s6.lossPct) && Math.abs(s4.lossPct - s6.lossPct) >= 0.1) {
      winner = s4.lossPct < s6.lossPct ? "v4" : "v6";
    } else if (Number.isFinite(s4.avgMs) && Number.isFinite(s6.avgMs)) {
      winner = s4.avgMs < s6.avgMs ? "v4" : s6.avgMs < s4.avgMs ? "v6" : "tie";
    }

    return {
      key: k,
      idx: i,
      probe: p,
      v4state: resultState(x),
      v6state: resultState(y),
      v4avg: s4.avgMs,
      v4loss: s4.lossPct,
      v6avg: s6.avgMs,
      v6loss: s6.lossPct,
      deltaAvg,
      deltaLoss,
      winner,
    };
  });

  const avgBase = strict ? rows.filter((r) => Number.isFinite(r.v4avg) && Number.isFinite(r.v6avg)) : rows;
  const lossBase = strict ? rows.filter((r) => Number.isFinite(r.v4loss) && Number.isFinite(r.v6loss)) : rows;

  const v4AvgArr = avgBase.map((r) => r.v4avg).filter(Number.isFinite);
  const v6AvgArr = avgBase.map((r) => r.v6avg).filter(Number.isFinite);
  const dAvgArr = avgBase.map((r) => r.deltaAvg).filter(Number.isFinite);

  const v4LossArr = lossBase.map((r) => r.v4loss).filter(Number.isFinite);
  const v6LossArr = lossBase.map((r) => r.v6loss).filter(Number.isFinite);
  const dLossArr = lossBase.map((r) => r.deltaLoss).filter(Number.isFinite);

  const summary = {
    n: rows.length,
    both: rows.filter((r) => Number.isFinite(r.v4avg) && Number.isFinite(r.v6avg)).length,
    median_avg_v4: percentile(v4AvgArr, 0.5),
    median_avg_v6: percentile(v6AvgArr, 0.5),
    p95_avg_v4: percentile(v4AvgArr, 0.95),
    p95_avg_v6: percentile(v6AvgArr, 0.95),
    median_loss_v4: percentile(v4LossArr, 0.5),
    median_loss_v6: percentile(v6LossArr, 0.5),
    median_delta_avg: percentile(dAvgArr, 0.5),
    median_delta_loss: percentile(dLossArr, 0.5),
  };

  return { rows, summary };
}

function pickDnsTotalMs(x) {
  const r = x?.result;
  // If it's not finished, we don't compare.
  if (r?.status && r.status !== "finished") return null;
  // If there is an error/timeout, avoid letting a 0 ms value 'win' the comparison.
  if (r?.error) return null;
  const t = r?.timings?.total;
  return Number.isFinite(t) && t > 0 ? t : null;
}

function buildDnsCompare(v4, v6, { strict = false, excludeKeys = null } = {}) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const keys = buildProbeUnionKeys(a, b, { excludeKeys });
  const aMap = buildResultMap(a, "v4");
  const bMap = buildResultMap(b, "v6");

  const rows = keys.map((k, i) => {
    const x = aMap.get(k) ?? null;
    const y = bMap.get(k) ?? null;
    const p = x?.probe || y?.probe || {};

    const v4ms = pickDnsTotalMs(x);
    const v6ms = pickDnsTotalMs(y);

    const delta = Number.isFinite(v4ms) && Number.isFinite(v6ms) ? v6ms - v4ms : null;
    const ratio = Number.isFinite(v4ms) && Number.isFinite(v6ms) && v4ms > 0 ? v6ms / v4ms : null;

    return {
      key: k,
      idx: i,
      probe: p,
      v4state: resultState(x),
      v6state: resultState(y),
      v4ms,
      v6ms,
      delta,
      ratio,
      winner:
        Number.isFinite(v4ms) && v4ms > 0 && Number.isFinite(v6ms) && v6ms > 0
          ? v4ms < v6ms
            ? "v4"
            : v6ms < v4ms
              ? "v6"
              : "tie"
          : "-",
    };
  });

  const baseRows = strict ? rows.filter((r) => Number.isFinite(r.v4ms) && Number.isFinite(r.v6ms)) : rows;

  const v4msArr = baseRows.map((r) => r.v4ms).filter(Number.isFinite);
  const v6msArr = baseRows.map((r) => r.v6ms).filter(Number.isFinite);
  const dArr = baseRows.map((r) => r.delta).filter(Number.isFinite);

  const summary = {
    n: rows.length,
    both: rows.filter((r) => Number.isFinite(r.v4ms) && Number.isFinite(r.v6ms)).length,
    median_v4: percentile(v4msArr, 0.5),
    median_v6: percentile(v6msArr, 0.5),
    p95_v4: percentile(v4msArr, 0.95),
    p95_v6: percentile(v6msArr, 0.95),
    median_delta: percentile(dArr, 0.5),
  };

  return { rows, summary };
}


function parseHttpInput(raw) {
  const s = (raw || "").trim();
  if (!s) return null;

  try {
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
    const u = hasScheme ? new URL(s) : new URL(`https://${s}`);
    return {
      host: u.hostname,
      path: u.pathname || "/",
      query: u.search ? u.search.slice(1) : "",
      protocol: u.protocol === "http:" ? "HTTP" : u.protocol === "https:" ? "HTTPS" : null,
      port: u.port ? Number(u.port) : null,
    };
  } catch {
    return null;
  }
}

function pickHttpTotalMs(x) {
  const r = x?.result;
  if (r?.status && r.status !== "finished") return null;
  if (r?.error) return null;
  const t = r?.timings?.total;
  return Number.isFinite(t) && t > 0 ? t : null;
}

function pickHttpStatusCode(x) {
  const r = x?.result;
  if (r?.status && r.status !== "finished") return null;
  const sc = r?.statusCode;
  return Number.isFinite(sc) ? sc : null;
}

function buildHttpCompare(v4, v6, { strict = false, excludeKeys = null } = {}) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const keys = buildProbeUnionKeys(a, b, { excludeKeys });
  const aMap = buildResultMap(a, "v4");
  const bMap = buildResultMap(b, "v6");

  const rows = keys.map((k, i) => {
    const x = aMap.get(k) ?? null;
    const y = bMap.get(k) ?? null;
    const p = x?.probe || y?.probe || {};

    const v4ms = pickHttpTotalMs(x);
    const v6ms = pickHttpTotalMs(y);

    const v4sc = pickHttpStatusCode(x);
    const v6sc = pickHttpStatusCode(y);

    const delta = Number.isFinite(v4ms) && Number.isFinite(v6ms) ? v6ms - v4ms : null;
    const ratio = Number.isFinite(v4ms) && Number.isFinite(v6ms) && v4ms > 0 ? v6ms / v4ms : null;

    return {
      key: k,
      idx: i,
      probe: p,
      v4state: resultState(x),
      v6state: resultState(y),
      v4ms,
      v6ms,
      v4sc,
      v6sc,
      delta,
      ratio,
      winner:
        Number.isFinite(v4ms) && v4ms > 0 && Number.isFinite(v6ms) && v6ms > 0
          ? v4ms < v6ms
            ? "v4"
            : v6ms < v4ms
              ? "v6"
              : "tie"
          : "-",
    };
  });

  const baseRows = strict ? rows.filter((r) => Number.isFinite(r.v4ms) && Number.isFinite(r.v6ms)) : rows;

  const v4msArr = baseRows.map((r) => r.v4ms).filter(Number.isFinite);
  const v6msArr = baseRows.map((r) => r.v6ms).filter(Number.isFinite);
  const dArr = baseRows.map((r) => r.delta).filter(Number.isFinite);

  const summary = {
    n: rows.length,
    both: rows.filter((r) => Number.isFinite(r.v4ms) && Number.isFinite(r.v6ms)).length,
    median_v4: percentile(v4msArr, 0.5),
    median_v6: percentile(v6msArr, 0.5),
    p95_v4: percentile(v4msArr, 0.95),
    p95_v6: percentile(v6msArr, 0.95),
    median_delta: percentile(dArr, 0.5),
  };

  return { rows, summary };
}


function pickTracerouteHopSeries(x, maxHops = 30) {
  const r = x?.result;
  if (!r || (r.status && r.status !== "finished")) return [];
  if (r.error) return [];

  const hops = Array.isArray(r.hops) ? r.hops : [];
  return hops.slice(0, maxHops).map((h) => {
    const rtts = (h?.timings || []).map((t) => t?.rtt).filter((v) => Number.isFinite(v) && v > 0);
    return rtts.length ? Math.min(...rtts) : null;
  });
}

function pickTracerouteDstMs(x) {
  const r = x?.result;
  if (!r || (r.status && r.status !== "finished")) return { reached: null, hops: null, dstMs: null };
  if (r.error) return { reached: null, hops: null, dstMs: null };

  const hops = Array.isArray(r.hops) ? r.hops : [];
  const hopCount = hops.length;

  const dstAddr = r.resolvedAddress || null;
  const dstHost = r.resolvedHostname || null;

  const dstHop =
    dstAddr || dstHost
      ? hops.find((h) => (dstAddr && h?.resolvedAddress === dstAddr) || (dstHost && h?.resolvedHostname === dstHost))
      : null;

  const rtts = (dstHop?.timings || []).map((t) => t?.rtt).filter((v) => Number.isFinite(v) && v > 0);
  const dstMs = rtts.length ? Math.min(...rtts) : null;

  return { reached: Boolean(dstHop), hops: hopCount, dstMs };
}

function pickMtrDstStats(x) {
  const r = x?.result;
  if (!r || (r.status && r.status !== "finished")) return { reached: null, hops: null, avgMs: null, lossPct: null };
  if (r.error) return { reached: null, hops: null, avgMs: null, lossPct: null };

  const hops = Array.isArray(r.hops) ? r.hops : [];
  const hopCount = hops.length;

  const dstAddr = r.resolvedAddress || null;
  const dstHost = r.resolvedHostname || null;

  const dstHop =
    dstAddr || dstHost
      ? hops.find((h) => (dstAddr && h?.resolvedAddress === dstAddr) || (dstHost && h?.resolvedHostname === dstHost))
      : null;

  const hopForStats = dstHop || (hops.length ? hops[hops.length - 1] : null);
  const stats = hopForStats?.stats || null;

  const avgMs = Number.isFinite(stats?.avg) && stats.avg > 0 ? stats.avg : null;
  const lossPct = Number.isFinite(stats?.loss) ? stats.loss : null; // already a percentage in Globalping

  return { reached: Boolean(dstHop), hops: hopCount, avgMs, lossPct };
}

function buildTracerouteCompare(v4, v6, { strict = false, excludeKeys = null } = {}) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const keys = buildProbeUnionKeys(a, b, { excludeKeys });
  const aMap = buildResultMap(a, "v4");
  const bMap = buildResultMap(b, "v6");

  const rows = keys.map((k, i) => {
    const x = aMap.get(k) ?? null;
    const y = bMap.get(k) ?? null;
    const p = x?.probe || y?.probe || {};

    const s4 = pickTracerouteDstMs(x);
    const s6 = pickTracerouteDstMs(y);

    const delta = Number.isFinite(s4.dstMs) && Number.isFinite(s6.dstMs) ? s6.dstMs - s4.dstMs : null;

    let winner = "-";
    if (s4.reached === true && s6.reached === false) winner = "v4";
    else if (s4.reached === false && s6.reached === true) winner = "v6";
    else if (s4.reached === true && s6.reached === true && Number.isFinite(s4.dstMs) && Number.isFinite(s6.dstMs)) {
      winner = s4.dstMs < s6.dstMs ? "v4" : s6.dstMs < s4.dstMs ? "v6" : "tie";
    }

    return {
      key: k,
      idx: i,
      probe: p,
      v4state: resultState(x),
      v6state: resultState(y),
      v4reached: s4.reached,
      v4hops: s4.hops,
      v4dst: s4.dstMs,
      v6reached: s6.reached,
      v6hops: s6.hops,
      v6dst: s6.dstMs,
      v4series: pickTracerouteHopSeries(x, 30),
      v6series: pickTracerouteHopSeries(y, 30),
      delta,
      winner,
    };
  });
  const baseRows = strict ? rows.filter((r) => Number.isFinite(r.v4dst) && Number.isFinite(r.v6dst)) : rows;

  const v4Arr = baseRows.map((r) => r.v4dst).filter(Number.isFinite);
  const v6Arr = baseRows.map((r) => r.v6dst).filter(Number.isFinite);
  const dArr = baseRows.map((r) => r.delta).filter(Number.isFinite);

  const summary = {
    n: rows.length,
    both: rows.filter((r) => Number.isFinite(r.v4dst) && Number.isFinite(r.v6dst)).length,
    median_v4: percentile(v4Arr, 0.5),
    median_v6: percentile(v6Arr, 0.5),
    p95_v4: percentile(v4Arr, 0.95),
    p95_v6: percentile(v6Arr, 0.95),
    median_delta: percentile(dArr, 0.5),
  };

  return { rows, summary };
}


function buildMtrCompare(v4, v6, { strict = false, excludeKeys = null } = {}) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const keys = buildProbeUnionKeys(a, b, { excludeKeys });
  const aMap = buildResultMap(a, "v4");
  const bMap = buildResultMap(b, "v6");

  const rows = keys.map((k, i) => {
    const x = aMap.get(k) ?? null;
    const y = bMap.get(k) ?? null;
    const p = x?.probe || y?.probe || {};

    const s4 = pickMtrDstStats(x);
    const s6 = pickMtrDstStats(y);

    const deltaAvg = Number.isFinite(s4.avgMs) && Number.isFinite(s6.avgMs) ? s6.avgMs - s4.avgMs : null;
    const deltaLoss = Number.isFinite(s4.lossPct) && Number.isFinite(s6.lossPct) ? s6.lossPct - s4.lossPct : null;

    let winner = "-";
    if (s4.reached === true && s6.reached === false) winner = "v4";
    else if (s4.reached === false && s6.reached === true) winner = "v6";
    else if (s4.reached === true && s6.reached === true) {
      if (Number.isFinite(s4.lossPct) && Number.isFinite(s6.lossPct) && Math.abs(s4.lossPct - s6.lossPct) >= 0.1) {
        winner = s4.lossPct < s6.lossPct ? "v4" : "v6";
      } else if (Number.isFinite(s4.avgMs) && Number.isFinite(s6.avgMs)) {
        winner = s4.avgMs < s6.avgMs ? "v4" : s6.avgMs < s4.avgMs ? "v6" : "tie";
      }
    }

    return {
      key: k,
      idx: i,
      probe: p,
      v4state: resultState(x),
      v6state: resultState(y),
      v4reached: s4.reached,
      v4hops: s4.hops,
      v4loss: s4.lossPct,
      v4avg: s4.avgMs,
      v6reached: s6.reached,
      v6hops: s6.hops,
      v6loss: s6.lossPct,
      v6avg: s6.avgMs,
      deltaAvg,
      deltaLoss,
      winner,
    };
  });
  const avgBase = strict ? rows.filter((r) => Number.isFinite(r.v4avg) && Number.isFinite(r.v6avg)) : rows;
  const lossBase = strict ? rows.filter((r) => Number.isFinite(r.v4loss) && Number.isFinite(r.v6loss)) : rows;

  const v4AvgArr = avgBase.map((r) => r.v4avg).filter(Number.isFinite);
  const v6AvgArr = avgBase.map((r) => r.v6avg).filter(Number.isFinite);
  const dAvgArr = avgBase.map((r) => r.deltaAvg).filter(Number.isFinite);

  const v4LossArr = lossBase.map((r) => r.v4loss).filter(Number.isFinite);
  const v6LossArr = lossBase.map((r) => r.v6loss).filter(Number.isFinite);
  const dLossArr = lossBase.map((r) => r.deltaLoss).filter(Number.isFinite);

  const summary = {
    n: rows.length,
    both: rows.filter((r) => Number.isFinite(r.v4avg) && Number.isFinite(r.v6avg)).length,
    median_avg_v4: percentile(v4AvgArr, 0.5),
    median_avg_v6: percentile(v6AvgArr, 0.5),
    median_loss_v4: percentile(v4LossArr, 0.5),
    median_loss_v6: percentile(v6LossArr, 0.5),
    median_delta_avg: percentile(dAvgArr, 0.5),
    median_delta_loss: percentile(dLossArr, 0.5),
  };

  return { rows, summary };
}


function normalizeAsn(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function computeAsnSummary(kind, rows) {
  const r = Array.isArray(rows) ? rows : [];
  const pick = (k) => r.map((row) => row?.[k]).filter(Number.isFinite);

  if (kind === 'ping' || kind === 'mtr') {
    const v4 = pick('v4avg');
    const v6 = pick('v6avg');
    const d = pick('deltaAvg');
    const l4 = pick('v4loss');
    const l6 = pick('v6loss');
    const dl = pick('deltaLoss');
    return {
      n: r.length,
      median_v4: percentile(v4, 0.5),
      median_v6: percentile(v6, 0.5),
      median_delta: percentile(d, 0.5),
      median_loss_v4: percentile(l4, 0.5),
      median_loss_v6: percentile(l6, 0.5),
      median_loss_delta: percentile(dl, 0.5),
    };
  }

  if (kind === 'traceroute') {
    const v4 = pick('v4dst');
    const v6 = pick('v6dst');
    const d = pick('delta');
    return {
      n: r.length,
      median_v4: percentile(v4, 0.5),
      median_v6: percentile(v6, 0.5),
      median_delta: percentile(d, 0.5),
    };
  }

  // dns/http
  const v4 = pick('v4ms');
  const v6 = pick('v6ms');
  const d = pick('delta');
  const ratio = pick('ratio');
  return {
    n: r.length,
    median_v4: percentile(v4, 0.5),
    median_v6: percentile(v6, 0.5),
    median_delta: percentile(d, 0.5),
    median_ratio: percentile(ratio, 0.5),
  };
}



function cleanUiText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low === "n/a" || low === "na" || low === "none" || low === "null" || low === "unknown" || low === "-") return null;
  return s;
}

function SkeletonLine({ width = "100%", height = 12 }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width,
        height,
        borderRadius: 999,
        background: "#e5e7eb",
      }}
    />
  );
}

function ExpandableText({ text, lines = 2, moreLabel = "Show more", lessLabel = "Show less" }) {
  const [expanded, setExpanded] = useState(false);
  const s = cleanUiText(text) || "-";

  if (s === "-") return <div>{s}</div>;

  const showToggle = s.length > 140 || s.includes("\n");

  const clampStyle = expanded
    ? {}
    : {
        display: "-webkit-box",
        WebkitLineClamp: lines,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      };

  return (
    <div>
      <div style={{ whiteSpace: "pre-wrap", ...clampStyle }}>{s}</div>
      {showToggle ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginTop: 6,
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "pointer",
            textDecoration: "underline",
            color: "#2563eb",
            font: "inherit",
            fontSize: 12,
          }}
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      ) : null}
    </div>
  );
}

async function fetchAsnMeta(asn, signal) {
  const url = `/api/asn/${encodeURIComponent(String(asn))}`;
  const resp = await fetch(url, { method: 'GET', signal, cache: 'no-store' });
  if (!resp.ok) throw new Error(`ASN metadata request failed (${resp.status})`);
  return await resp.json();
}


export default function App() {
  // Globalping UI
  const [target, setTarget] = useState("example.com");
  const [multiTargetMode, setMultiTargetMode] = useState(false);
  const [multiTargetInput, setMultiTargetInput] = useState("");
  const [multiRunResults, setMultiRunResults] = useState([]);
  const [multiRunStatus, setMultiRunStatus] = useState(null);
  const [multiActiveId, setMultiActiveId] = useState(null);
  const [multiExportIncludeRaw, setMultiExportIncludeRaw] = useState(false);
  const [cmd, setCmd] = useState("ping"); // ping | traceroute | mtr | dns | http
  const [backend, setBackend] = useState("globalping"); // globalping | atlas
  const [atlasApiKey, setAtlasApiKey] = useState("");
  const [from, setFrom] = useState("Western Europe");
  const [gpTag, setGpTag] = useState("any"); // any | eyeball | datacenter
  const [limit, setLimit] = useState(3);
  const [requireV6Capable, setRequireV6Capable] = useState(true);
  const [runWarnings, setRunWarnings] = useState([]);
  // Probe stability / exclusions (local UI preferences)
  const [excludeUnstableProbes, setExcludeUnstableProbes] = useState(false);
  const [probeBlacklist, setProbeBlacklist] = useState("");

  // Compare table sorting
  const [tableSort, setTableSort] = useState({ table: "", key: "", dir: "asc" });
  const toggleTableSort = useCallback((table, key, defaultDir = "asc") => {
    startTransition(() => {
      setTableSort((prev) => {
        if (prev.table === table && prev.key === key) {
          return { table, key, dir: prev.dir === "asc" ? "desc" : "asc" };
        }
        return { table, key, dir: defaultDir };
      });
    });
  }, []);

  // Paths (traceroute/mtr): per-hop diff expander
  const [expandedPathKey, setExpandedPathKey] = useState(null);

  // Hop IP -> ASN/org enrichment (best-effort, cached in-browser)
  const [ipMetaByIp, setIpMetaByIp] = useState(() => ({}));
  const ipMetaInFlightRef = useRef(new Set());


  // ASN details (in-app)
  const [asnCard, setAsnCard] = useState(null);
  const [asnCardFromUrl, setAsnCardFromUrl] = useState(null);



  // Geo presets UI (macro + sub-regions)
  const [macroId, setMacroId] = useState("eu");
  const [subId, setSubId] = useState("eu-w");
  const t = useCallback((key, vars = {}) => {
    const entry = COPY.en[key];
    if (typeof entry === "function") return entry(vars);
    return entry ?? key;
  }, []);

  const fetchIpMeta = useCallback(async (ips) => {
    const list = Array.from(new Set((Array.isArray(ips) ? ips : []).map((x) => String(x || "").trim()).filter(Boolean)));
    if (!list.length) return;

    const missing = list.filter((ip) => !getIpMetaCache(ip));
    if (!missing.length) return;

    const inFlight = ipMetaInFlightRef.current;
    const todo = missing.filter((ip) => !inFlight.has(ip));
    if (!todo.length) return;

    todo.forEach((ip) => inFlight.add(ip));
    try {
      const res = await fetch("/api/ipmeta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ips: todo }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const meta = data?.meta && typeof data.meta === "object" ? data.meta : {};
      const keys = Object.keys(meta);
      if (!keys.length) return;

      setIpMetaByIp((prev) => {
        const next = { ...prev };
        keys.forEach((ip) => {
          const m = meta[ip];
          if (m && typeof m === "object") {
            next[ip] = m;
            setIpMetaCache(ip, m);
          }
        });
        return next;
      });
    } catch {
      // ignore
    } finally {
      todo.forEach((ip) => inFlight.delete(ip));
    }
  }, []);

  const prefetchHopMeta = useCallback(
    (v4res, v6res) => {
      const { rows } = buildHopAlignment(v4res, v6res, 30);
      const ips = [];
      rows.forEach((r) => {
        if (r.v4ip) ips.push(r.v4ip);
        if (r.v6ip) ips.push(r.v6ip);
      });
      fetchIpMeta(ips);
    },
    [fetchIpMeta]
  );


  const openAsnCard = useCallback((asnValue, kind, rows) => {
    const asn = normalizeAsn(asnValue);
    if (!asn) return;
    setAsnCard({ asn, kind, rows, meta: null, metaStatus: 'loading', metaError: null, metaReqId: 0, metaAutoRefreshLeft: 2, metaMissRetryLeft: 1, metaMissRetryPending: false });
  }, []);

  const renderAsnCell = useCallback((asnValue, kind, rows) => {
    const asn = normalizeAsn(asnValue);
    if (!asn) return '-';
    return (
      <span className="tt">
        <button
          type="button"
          onClick={() => openAsnCard(asn, kind, rows)}
          style={{
            border: 'none',
            background: 'transparent',
            padding: 0,
            margin: 0,
            cursor: 'pointer',
            textDecoration: 'underline',
            color: '#2563eb',
            fontFamily: 'inherit',
            fontSize: 'inherit',
          }}
        >
          {asn}
        </button>
        <span className="tt-bubble">{t('asnCellHint')}</span>
      </span>
    );
  }, [openAsnCard, t]);

  const dateLocale = "en-US";
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = "en";
    }
  }, []);

  useEffect(() => {
    if (!asnCard) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setAsnCard(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [asnCard]);


  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (asnCard?.asn) url.searchParams.set('asncard', String(asnCard.asn));
    else url.searchParams.delete('asncard');
    window.history.replaceState(null, '', url.toString());
  }, [asnCard?.asn]);

  useEffect(() => {
    const asn = asnCard?.asn;
    const reqId = Number(asnCard?.metaReqId || 0);
    if (!asn) return;

    const force = reqId > 0;

    const cached = ASN_META_CACHE.get(asn);
    const now = Date.now();
    if (!force && cached && now - cached.at < ASN_META_CACHE_TTL_MS && cached?.data?.cache?.status !== 'miss') {
      setAsnCard((prev) => (prev && prev.asn === asn ? { ...prev, meta: cached.data, metaStatus: 'ok', metaError: null, metaMissRetryPending: false } : prev));
      return;
    }

    const ac = new AbortController();
    setAsnCard((prev) => (prev && prev.asn === asn ? { ...prev, metaStatus: 'loading', metaError: null } : prev));

    let revalTimer = null;

    (async () => {
      try {
        const meta = await fetchAsnMeta(asn, ac.signal);
        ASN_META_CACHE.set(asn, { at: Date.now(), data: meta });

        setAsnCard((prev) => {
          if (!prev || prev.asn !== asn) return prev;
          const missLeft = Number(prev.metaMissRetryLeft || 0);
          const shouldWarm = meta?.cache?.status === 'miss' && missLeft > 0;
          return { ...prev, meta, metaStatus: 'ok', metaError: null, metaMissRetryPending: shouldWarm };
        });

        const shouldAutoRefresh = meta?.cache?.status === 'stale' && meta?.cache?.revalidating === true;
        if (shouldAutoRefresh) {
          revalTimer = setTimeout(() => {
            setAsnCard((prev) => {
              if (!prev || prev.asn !== asn) return prev;
              const left = Number(prev.metaAutoRefreshLeft || 0);
              if (left <= 0) return prev;

              const stillStale = prev?.meta?.cache?.status === 'stale' && prev?.meta?.cache?.revalidating === true;
              if (!stillStale) return prev;

              return {
                ...prev,
                metaReqId: Number(prev.metaReqId || 0) + 1,
                metaAutoRefreshLeft: left - 1,
              };
            });
          }, 1200);
        }

        const shouldWarmMiss = meta?.cache?.status === 'miss';
        if (shouldWarmMiss) {
          revalTimer = setTimeout(() => {
            setAsnCard((prev) => {
              if (!prev || prev.asn !== asn) return prev;
              const left = Number(prev.metaMissRetryLeft || 0);
              if (left <= 0) return { ...prev, metaMissRetryPending: false };
              const stillMiss = prev?.meta?.cache?.status === 'miss';
              const alreadyLoading = prev?.metaStatus === 'loading';
              if (!stillMiss || alreadyLoading) return { ...prev, metaMissRetryPending: false };
              return {
                ...prev,
                metaReqId: Number(prev.metaReqId || 0) + 1,
                metaMissRetryLeft: left - 1,
                metaMissRetryPending: true,
              };
            });
          }, 450);
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        setAsnCard((prev) =>
          prev && prev.asn === asn ? { ...prev, metaStatus: 'error', metaError: String(e || ''), metaMissRetryPending: false } : prev
        );
      }
    })();

    return () => {
      try {
        ac.abort();
      } catch {}
      if (revalTimer) clearTimeout(revalTimer);
    };
  }, [asnCard?.asn, asnCard?.metaReqId]);


  const macroPreset = useMemo(
    () => GEO_PRESETS.find((p) => p.id === macroId) ?? GEO_PRESETS[0],
    [macroId]
  );
  const subPresets = macroPreset?.sub ?? [];
  const parsedMultiTargets = useMemo(() => parseMultiTargets(multiTargetInput), [multiTargetInput]);
  const canRequireV6Capable = multiTargetMode
    ? parsedMultiTargets.length > 0 && parsedMultiTargets.every((item) => !isIpLiteral(item))
    : !isIpLiteral((target || "").trim());

  const strictCompare = requireV6Capable && canRequireV6Capable;

  const maxProbes = backend === "atlas" ? 50 : 10;

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const b = String(window.localStorage.getItem("PING6_BACKEND") || "").trim();
      if (b === "atlas" || b === "globalping") setBackend(b);
    } catch {}
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("PING6_BACKEND", backend);
    } catch {}
  }, [backend]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const v = String(window.localStorage.getItem("PING6_EXCLUDE_UNSTABLE_PROBES") || "").trim();
      if (v === "1") setExcludeUnstableProbes(true);
      const bl = String(window.localStorage.getItem("PING6_PROBE_BLACKLIST") || "");
      if (bl) setProbeBlacklist(bl);
    } catch {}
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("PING6_EXCLUDE_UNSTABLE_PROBES", excludeUnstableProbes ? "1" : "0");
      window.localStorage.setItem("PING6_PROBE_BLACKLIST", probeBlacklist || "");
    } catch {}
  }, [excludeUnstableProbes, probeBlacklist]);

  useEffect(() => {
    setStoredAtlasKey(atlasApiKey);
  }, [atlasApiKey]);

  function selectMacro(id) {
    const p = GEO_PRESETS.find((x) => x.id === id) ?? GEO_PRESETS[0];
    setMacroId(p.id);
    setSubId("");
    setFrom(p.magic);
  }

  function selectSub(id) {
    setSubId(id);
    if (!id) {
      setFrom(macroPreset.magic);
      return;
    }
    const s = (macroPreset.sub ?? []).find((x) => x.id === id);
    if (s?.magic) setFrom(s.magic);
  }


  // ping/mtr
  const [packets, setPackets] = useState(3);

  // traceroute/mtr
  const [trProto, setTrProto] = useState("ICMP"); // ICMP | TCP | UDP
  const [trPort, setTrPort] = useState(80);

  // dns
  const [dnsQuery, setDnsQuery] = useState("A"); // A, AAAA, MX, TXT, NS, SOA, CNAME, PTR, SRV, CAA, ANY
  const [dnsProto, setDnsProto] = useState("UDP"); // UDP | TCP
  const [dnsPort, setDnsPort] = useState(53);
  const [dnsResolver, setDnsResolver] = useState(""); // empty => default resolver on probe
  const [dnsTrace, setDnsTrace] = useState(false);

  // http
  const [httpMethod, setHttpMethod] = useState("GET"); // GET | HEAD | OPTIONS
  const [httpProto, setHttpProto] = useState("HTTPS"); // HTTP | HTTPS | HTTP2
  const [httpPath, setHttpPath] = useState("/");
  const [httpQuery, setHttpQuery] = useState("");
  const [httpPort, setHttpPort] = useState(""); // empty => default (80/443)
  const [httpResolver, setHttpResolver] = useState(""); // empty => default resolver on probe

  const [probeAsn, setProbeAsn] = useState("");
  const [probeIsp, setProbeIsp] = useState("");
  const [deltaThreshold, setDeltaThreshold] = useState("");

  const [history, setHistory] = useState(() => loadHistory());

  const probeBlacklistSet = useMemo(() => parseKeyList(probeBlacklist), [probeBlacklist]);
  const unstableProbeKeys = useMemo(() => computeUnstableProbeKeys(history, { backend, cmd }), [history, backend, cmd]);
  const probeExcludeKeys = useMemo(() => {
    const s = new Set();
    probeBlacklistSet.forEach((k) => s.add(k));
    if (excludeUnstableProbes) unstableProbeKeys.forEach((k) => s.add(k));
    return s;
  }, [probeBlacklistSet, unstableProbeKeys, excludeUnstableProbes]);

  const [historyCompareA, setHistoryCompareA] = useState("");
  const [historyCompareB, setHistoryCompareB] = useState("");
  const [reportMode, setReportMode] = useState(false);
  const [reportData, setReportData] = useState(null);
  const [reportMeta, setReportMeta] = useState(null);
  const [reportNotice, setReportNotice] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState("");

  const [running, setRunning] = useState(false);
  const [retryingFamily, setRetryingFamily] = useState(""); // "v4" | "v6" | ""
  const [err, setErr] = useState("");
  const [rateLimitUntil, setRateLimitUntil] = useState(0);
  const [rateLimitLeft, setRateLimitLeft] = useState(0);
  const [v4, setV4] = useState(null);
  const [v6, setV6] = useState(null);
  // Defer heavy compare computations while results stream in (keeps inputs responsive).
  const deferredV4 = useDeferredValue(v4);
  const deferredV6 = useDeferredValue(v6);
  const v4ForCompute = running ? deferredV4 : v4;
  const v6ForCompute = running ? deferredV6 : v6;

  const [atlasUiNow, setAtlasUiNow] = useState(() => Date.now());
  const [atlasPollV4, setAtlasPollV4] = useState(null);
  const [atlasPollV6, setAtlasPollV6] = useState(null);
  const [atlasRunStartedAt, setAtlasRunStartedAt] = useState(0);
  const [gpUiNow, setGpUiNow] = useState(() => Date.now());
  const [gpRunStartedAt, setGpRunStartedAt] = useState(0);
  const [gpLastUpdateAt, setGpLastUpdateAt] = useState(0);
  const [showRaw, setShowRaw] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const abortRef = useRef(null);

  useEffect(() => {
    if (!rateLimitUntil) {
      setRateLimitLeft(0);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((rateLimitUntil - Date.now()) / 1000));
      setRateLimitLeft(left);
      if (left <= 0) setRateLimitUntil(0);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [rateLimitUntil]);

  // Turnstile (Cloudflare) - on-demand, executed only when the user presses Run.
  const turnstileContainerRef = useRef(null);
  const turnstileWidgetIdRef = useRef(null);
  const turnstilePendingRef = useRef(null);
  const [showTurnstile, setShowTurnstile] = useState(false);
  const [turnstileStatus, setTurnstileStatus] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch {}
  }, [history]);

  useEffect(() => {
    if (!(running && backend === "atlas")) return;
    const id = setInterval(() => setAtlasUiNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running, backend]);

  useEffect(() => {
    if (!(running && backend !== "atlas")) return;
    const id = setInterval(() => setGpUiNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running, backend]);

  useEffect(() => {
    if (!history.length) return;
    setHistoryCompareA((prev) => prev || history[0]?.id || "");
    setHistoryCompareB((prev) => prev || history[1]?.id || "");
  }, [history]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Short report links: /r/<id>
    const path = window.location.pathname || "/";
    const m = path.match(/^\/r\/([A-Za-z0-9_-]{8,64})\/?$/);
    if (m) {
      const id = m[1];
      const ac = new AbortController();

      setReportMode(true);
      setReportData(null);
      setReportMeta({ id, createdAt: null, expiresAt: null });
      setReportNotice("");
      setShareUrl(window.location.href);

      (async () => {
        try {
          const data = await loadShortReport(id, ac.signal);
          if (data?.payload) {
            setReportMode(true);
            setReportData(data.payload);
            setReportMeta({
              id: String(data?.id || id),
              createdAt: data?.createdAt || null,
              expiresAt: data?.expiresAt || null,
            });
          } else {
            setErr(t("reportNotFound"));
          }
        } catch (e) {
          const status = e?.status;
          if (status === 404) setErr(t("reportNotFound"));
          else setErr(String(e?.message || e || "report_load_failed"));
        }
      })();

      return () => {
        try {
          ac.abort();
        } catch {}
      };
    }

    const params = new URLSearchParams(window.location.search);
    applyUrlSettings(params, {
      setCmd,
      setBackend,
      setTarget,
      setFrom,
      setGpTag,
      setLimit,
      setRequireV6Capable,
      setPackets,
      setTrProto,
      setTrPort,
      setDnsQuery,
      setDnsProto,
      setDnsPort,
      setDnsResolver,
      setDnsTrace,
      setHttpMethod,
      setHttpProto,
      setHttpPath,
      setHttpQuery,
      setHttpPort,
      setHttpResolver,
      setProbeAsn,
      setProbeIsp,
      setDeltaThreshold,
    });

    const asnCardRaw = params.get("asncard");
    const asnCardAsn = normalizeAsn(asnCardRaw);
    if (asnCardAsn) setAsnCardFromUrl(asnCardAsn);

    const reportRaw = params.get("report");
    const dataRaw = params.get("data");
    if (reportRaw === "1" && dataRaw) {
      const decoded = decodeReportPayload(dataRaw);
      if (decoded) {
        setReportMode(true);
        setReportData(decoded);
        setReportMeta(null);
        setReportNotice("");
      }
    }
  }, []);

  async function getTurnstileToken(signal) {
    const sitekey = import.meta.env.VITE_TURNSTILE_SITEKEY;
    if (!sitekey) {
      throw new Error(t("errorTurnstileMissing"));
    }

    // Ensure the script is loaded.
    await loadTurnstileScript();
    if (!window.turnstile) throw new Error(t("errorTurnstileUnavailable"));

    // Ensure we have a container.
    const el = turnstileContainerRef.current;
    if (!el) throw new Error(t("errorTurnstileMissingContainer"));

    // Ensure we have a rendered widget (render once, then execute per run).
    if (turnstileWidgetIdRef.current === null) {
      el.innerHTML = "";
      turnstileWidgetIdRef.current = window.turnstile.render(el, {
        sitekey,
        action: "ping6_run",
        cData: "ping6",
        execution: "execute",
        appearance: "interaction-only",
        callback: (token) => {
          const pending = turnstilePendingRef.current;
          if (!pending || pending.done) return;
          pending.done = true;
          pending.cleanup();
          pending.resolve(token);
        },
        "error-callback": (code) => {
          const pending = turnstilePendingRef.current;
          if (!pending || pending.done) return;
          pending.done = true;
          pending.cleanup();

          const raw = code ?? "unknown";
          const n = Number(raw);
          const family = Number.isFinite(n) ? Math.floor(n / 1000) : null;

          let msg;
          if (family === 600 || family === 300) msg = t("errorTurnstileChallengeFailed", { code: raw });
          else if (family === 110 || family === 400) msg = t("errorTurnstileConfig", { code: raw });
          else if (family === 120 || family === 102 || family === 103 || family === 104 || family === 106)
            msg = t("errorTurnstileNetwork", { code: raw });
          else msg = t("errorTurnstileChallengeFailed", { code: raw });

          const err = new Error(msg);
          err.kind = "turnstile";
          err.turnstileCode = raw;
          pending.reject(err);
        },
        "expired-callback": () => {
          const pending = turnstilePendingRef.current;
          if (!pending || pending.done) return;
          pending.done = true;
          pending.cleanup();
          pending.reject(new Error(t("errorTurnstileTokenExpired")));
        },
        "timeout-callback": () => {
          const pending = turnstilePendingRef.current;
          if (!pending || pending.done) return;
          pending.done = true;
          pending.cleanup();
          pending.reject(new Error(t("errorTurnstileTimeout")));
        },
      });
    }

    // Execute and wait for token.
    setShowTurnstile(true);
    const widgetId = turnstileWidgetIdRef.current;

    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = turnstilePendingRef.current;
        if (!pending || pending.done) return;
        pending.done = true;
        pending.cleanup();
        reject(new Error(t("errorCancelled")));
      };

      const cleanup = () => {
        try {
          if (signal) signal.removeEventListener("abort", onAbort);
        } catch {}
        turnstilePendingRef.current = null;
        setShowTurnstile(false);
      };

      turnstilePendingRef.current = { resolve, reject, cleanup, done: false };

      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      try {
        window.turnstile.reset(widgetId);
        window.turnstile.execute(widgetId);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  function formatRetryAfterHeader(value) {
    const s = String(value || "").trim();
    if (!s) return "";

    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return `${Math.round(n)}s`;

    const d = Date.parse(s);
    if (!Number.isNaN(d)) {
      const delta = Math.round((d - Date.now()) / 1000);
      if (Number.isFinite(delta) && delta > 0) return `${delta}s`;
    }

    return s;
  }

  function retryAfterToSeconds(value) {
    const s = String(value || "").trim();
    if (!s) return null;

    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);

    // Accept values like "10s".
    const m = s.match(/^\s*(\d+)\s*s\s*$/i);
    if (m) return Math.ceil(Number(m[1]));

    // Or HTTP-date.
    const d = Date.parse(s);
    if (!Number.isNaN(d)) {
      const delta = Math.ceil((d - Date.now()) / 1000);
      return Number.isFinite(delta) && delta > 0 ? delta : null;
    }

    return null;
  }

  function extractRetryAfterSeconds(e) {
    if (!e || typeof e !== "object") return null;
    return (
      retryAfterToSeconds(e.retryAfter) ||
      retryAfterToSeconds(e.rateLimitReset) ||
      retryAfterToSeconds(e?.details?.retryAfter) ||
      retryAfterToSeconds(e?.details?.rateLimitReset) ||
      retryAfterToSeconds(e?.data?.retryAfter) ||
      retryAfterToSeconds(e?.data?.rateLimitReset) ||
      null
    );
  }

  function formatParamsList(params) {
    if (!params || typeof params !== "object") return "";
    const entries = Object.entries(params)
      .map(([k, v]) => [String(k), typeof v === "string" ? v : JSON.stringify(v)])
      .filter(([k, v]) => k && v);

    if (!entries.length) return "";
    return entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
  }

  function buildPairErrorMessage({ status, data, retryAfter }) {
    const retry = formatRetryAfterHeader(retryAfter || data?.retryAfter || data?.rateLimitReset);
    const code = data?.error;

    if (status === 429) {
      return t("errorRateLimited", { retryAfter: retry });
    }

    if (code === "turnstile_failed") {
      const codes = Array.isArray(data?.codes) ? data.codes.filter(Boolean) : [];
      const norm = codes.map((c) => String(c).trim().toLowerCase()).filter(Boolean);

      // Server-side Turnstile siteverify failure codes are strings.
      if (norm.includes("timeout-or-duplicate")) return t("errorTurnstileTokenExpired");
      if (norm.includes("missing-input-secret") || norm.includes("invalid-input-secret")) {
        return t("errorTurnstileConfig", { code: codes[0] || "server" });
      }
      if (norm.includes("internal-error")) return t("errorUpstreamUnavailable");

      return codes.length ? `${t("errorHumanVerification")}
Codes: ${codes.join(", ")}` : t("errorHumanVerification");
    }

    if (code === "turnstile_bad_action" || code === "turnstile_bad_hostname") {
      return t("errorTurnstileConfig", { code: "server" });
    }

    if (code === "missing_atlas_api_key") {
      return "RIPE Atlas needs an API key. Paste it in the Settings panel and retry.";
    }


    if (code === "atlas_probe_list_failed") {
      const header = data?.message || "Unable to derive the probe list from the reference RIPE Atlas measurement.";
      const hint = "Hint: run a fresh measurement (or reduce the probe count) and retry.";
      const source = data?.probeListSource ? "Probe list source: " + String(data.probeListSource) : "";
      const parts = [header, hint];
      if (source) parts.push(source);
      return parts.join("\n");
    }

    if (
      code === "invalid_json" ||
      code === "missing_fields" ||
      code === "invalid_target" ||
      code === "invalid_type" ||
      code === "invalid_flow" ||
      code === "unsupported_type"
    ) {
      const header = data?.message || t("errorInvalidRequest");
      const paramLines = formatParamsList(data?.params);
      return paramLines ? `${header}
${paramLines}` : header;
    }

    if (code === "globalping_failed") {
      const upstream = data?.details || {};
      const isValidation = upstream?.error?.type === "validation_error";
      const header = isValidation
        ? `Globalping rejected the request (${data?.status || status})`
        : `Globalping failed (${data?.status || status})`;
      const detailMsg =
        upstream?.error?.message || upstream?.error?.type || upstream?.message || upstream?.error || upstream?.raw || "";

      const paramLines = formatParamsList(upstream?.error?.params);
      const pieces = [header];
      if (detailMsg) pieces.push(String(detailMsg));
      if (paramLines) pieces.push(paramLines);
      return pieces.join("\n");
    }

    if (code === "atlas_failed") {
      const upstream = data?.details || {};
      const header = `RIPE Atlas failed (${data?.status || status})`;
      const detailMsg = upstream?.message || upstream?.error || upstream?.raw || "";
      const pieces = [header];
      if (detailMsg) pieces.push(String(detailMsg));
      return pieces.join("\n");
    }

    // Generic fallbacks.
    if (status >= 500) return t("errorUpstreamUnavailable");
    return code || t("errorRequestFailed", { status });
  }

  function toUserFacingError(e) {
    if (!e) return t("errorUpstreamUnavailable");

    // AbortController / fetch abort.
    if (e.name === "AbortError" || e.message === "Aborted") {
      return t("errorCancelled");
    }

    // Our API errors (createMeasurementsPair).
    if (e.kind === "api" && typeof e.message === "string" && e.message) {
      return e.message;
    }

    // Globalping/Atlas polling errors.
    const status = e.status;
    if (status === 429) {
      const ra = e.retryAfter || e.rateLimitReset || e?.details?.retryAfter || e?.details?.rateLimitReset || e?.data?.retryAfter || e?.data?.rateLimitReset;
      return t("errorRateLimited", { retryAfter: formatRetryAfterHeader(ra) });
    }

    if (status && status >= 500) {
      return t("errorUpstreamUnavailable");
    }

    // Typical fetch network errors.
    if (e instanceof TypeError && String(e.message || "").toLowerCase().includes("fetch")) {
      return t("errorNetworkFailure");
    }

    return e.message || String(e);
  }

  async function createMeasurementsPair({ turnstileToken, base, measurementOptions, flow }, signal) {
    const url = backend === "atlas" ? "/api/atlas/measurements-pair" : "/api/measurements-pair";
    const headers = { "content-type": "application/json" };
    if (backend === "atlas" && String(atlasApiKey || "").trim()) {
      headers["X-Atlas-Key"] = String(atlasApiKey || "").trim();
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ turnstileToken, base, measurementOptions, flow }),
      signal,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const retryAfterHeader = res.headers.get("retry-after") || "";
      const rateLimitResetHeader = res.headers.get("x-ratelimit-reset") || "";
      const resetSec = Number(rateLimitResetHeader);
      const retryAfter = retryAfterHeader
        ? retryAfterHeader
        : Number.isFinite(resetSec) && resetSec > 0
          ? `${Math.ceil(resetSec)}s`
          : undefined;
      const msg = buildPairErrorMessage({ status: res.status, data, retryAfter });
      const err = new Error(msg);
      err.kind = "api";
      err.status = res.status;
      err.code = data?.error;
      err.retryAfter = retryAfter || data?.retryAfter;
      err.rateLimitReset = rateLimitResetHeader || data?.rateLimitReset;
      err.details = data;
      throw err;
    }

    return data;
  }

  async function createMeasurementSingle({ turnstileToken, base, measurementOptions, ipVersion, sameProbesAs }, signal) {
    const isAtlas = backend === "atlas";
    const isGp = backend === "globalping";

    if (!isAtlas && !isGp) {
      const err = new Error(t("retryNotAvailable"));
      err.kind = "api";
      err.status = 400;
      throw err;
    }

    const url = isAtlas ? "/api/atlas/measurements-single" : "/api/measurements-single";
    const headers = { "content-type": "application/json" };
    if (isAtlas && String(atlasApiKey || "").trim()) {
      headers["X-Atlas-Key"] = String(atlasApiKey || "").trim();
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ turnstileToken, base, measurementOptions, ipVersion, sameProbesAs }),
      signal,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const retryAfterHeader = res.headers.get("retry-after") || "";
      const rateLimitResetHeader = res.headers.get("x-ratelimit-reset") || "";
      const resetSec = Number(rateLimitResetHeader);
      const retryAfter = retryAfterHeader
        ? retryAfterHeader
        : Number.isFinite(resetSec) && resetSec > 0
          ? `${Math.ceil(resetSec)}s`
          : undefined;

      const msg = buildPairErrorMessage({ status: res.status, data, retryAfter });
      const err = new Error(msg);
      err.kind = "api";
      err.status = res.status;
      err.code = data?.error;
      err.retryAfter = retryAfter || data?.retryAfter;
      err.rateLimitReset = rateLimitResetHeader || data?.rateLimitReset;
      err.details = data;
      throw err;
    }

    return data;
  }

  function buildMeasurementRequest(rawTarget, { syncHttpFields = true } = {}) {
    const trimmedTarget = String(rawTarget || "").trim();
    if (!trimmedTarget) {
      throw new Error(t("errorTargetRequired"));
    }

    let effectiveTarget = trimmedTarget;

    // HTTP: we also accept a full URL and split it into host/path/query.
    let httpParsed = null;
    let httpEffectiveProto = httpProto;
    let httpEffectivePath = (httpPath || "/").trim() || "/";
    let httpEffectiveQuery = (httpQuery || "").trim();
    let httpEffectivePort = (httpPort || "").trim();

    if (cmd === "http") {
      httpParsed = parseHttpInput(trimmedTarget);
      if (!httpParsed?.host) {
        throw new Error(t("errorHttpTarget"));
      }

      effectiveTarget = httpParsed.host;

      if (httpParsed.protocol) {
        httpEffectiveProto = httpParsed.protocol;
        // manteniamo il selettore coerente se l'utente ha scritto http:// o https://
        if (syncHttpFields && httpProto !== httpParsed.protocol) setHttpProto(httpParsed.protocol);
      }

      if ((httpEffectivePath === "/" || !httpEffectivePath) && httpParsed.path && httpParsed.path !== "/") {
        httpEffectivePath = httpParsed.path;
      }
      if (!httpEffectiveQuery && httpParsed.query) httpEffectiveQuery = httpParsed.query;
      if (!httpEffectivePort && Number.isFinite(httpParsed.port) && httpParsed.port > 0) httpEffectivePort = String(httpParsed.port);
    }

    // For ping/traceroute/mtr/http we want a hostname (not an IP literal) for a fair IPv4/IPv6 comparison.
    // For DNS the input may also be an IP literal (e.g. PTR), so we don't block it.
    if (cmd !== "dns" && isIpLiteral(effectiveTarget)) {
      throw new Error(t("errorHostnameRequired"));
    }

    let measurementOptions = {};

    if (cmd === "ping") {
      measurementOptions = { packets: Math.max(1, Math.min(10, Number(packets) || 3)) };
    } else if (cmd === "traceroute") {
      measurementOptions = { protocol: trProto };
      if (trProto === "TCP") {
        measurementOptions.port = Math.max(1, Math.min(65535, Number(trPort) || 80));
      }
    } else if (cmd === "mtr") {
      measurementOptions = {
        packets: Math.max(1, Math.min(16, Number(packets) || 3)),
        protocol: trProto,
      };
      if (trProto !== "ICMP") {
        measurementOptions.port = Math.max(1, Math.min(65535, Number(trPort) || 80));
      }
    } else if (cmd === "dns") {
      measurementOptions = {
        query: { type: (dnsQuery || "A").toUpperCase() },
        protocol: (dnsProto || "UDP").toUpperCase(),
        port: Math.max(1, Math.min(65535, Number(dnsPort) || 53)),
        trace: Boolean(dnsTrace),
      };
      const r = (dnsResolver || "").trim();
      if (r) measurementOptions.resolver = r;
    } else if (cmd === "http") {
      const method = (httpMethod || "GET").toUpperCase();
      const proto = (httpEffectiveProto || "HTTPS").toUpperCase();

      let path = (httpEffectivePath || "/").trim() || "/";
      if (!path.startsWith("/")) path = `/${path}`;

      let q = (httpEffectiveQuery || "").trim();
      if (q.startsWith("?")) q = q.slice(1);

      measurementOptions = {
        request: { method, path },
        protocol: proto,
      };

      if (q) measurementOptions.request.query = q;

      const r = (httpResolver || "").trim();
      if (r) measurementOptions.resolver = r;

      const p = (httpEffectivePort || "").trim();
      if (p) {
        const port = Math.max(1, Math.min(65535, Number(p) || 0));
        if (port) measurementOptions.port = port;
      }
    }

    return {
      rawTarget: trimmedTarget,
      effectiveTarget,
      measurementOptions,
      httpEffectiveProto,
      httpEffectivePath,
      httpEffectiveQuery,
      httpEffectivePort,
    };
  }

  async function run() {
    setErr("");
    setV4(null);
    setV6(null);
    setAtlasPollV4(null);
    setAtlasPollV6(null);
    setAtlasRunStartedAt(0);
    setGpRunStartedAt(0);
    setGpLastUpdateAt(0);
    setShowRaw(false);
    setTurnstileStatus(t("statusPreparing"));
    setRunning(true);
    let turnstileTimedOut = false;
    try {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      const probes = Math.max(1, Math.min(maxProbes, Number(limit) || 3));
      const fromWithTag = applyGpTag(from, gpTag);
      const location = { magic: fromWithTag || "world" };
      const parsedAsn = Number(probeAsn);
      if (Number.isFinite(parsedAsn) && parsedAsn > 0) location.asn = parsedAsn;
      if (probeIsp.trim()) location.isp = probeIsp.trim();

      const targets = multiTargetMode ? parsedMultiTargets : [target];
      if (!targets.length) {
        throw new Error(multiTargetMode ? t("errorMultiTargetRequired") : t("errorTargetRequired"));
      }

      if (multiTargetMode) {
        setMultiRunResults([]);
        setMultiActiveId(null);
      }

      for (let i = 0; i < targets.length; i += 1) {
        const rawTarget = targets[i];
        if (multiTargetMode) {
          setMultiRunStatus({ current: i + 1, total: targets.length, target: rawTarget });
        }

        const {
          rawTarget: normalizedTarget,
          effectiveTarget,
          measurementOptions,
          httpEffectiveProto,
          httpEffectivePath,
          httpEffectiveQuery,
          httpEffectivePort,
        } = buildMeasurementRequest(rawTarget, { syncHttpFields: !multiTargetMode });

        if (backend === "atlas") {
          if (!String(atlasApiKey || "").trim()) {
            throw new Error("RIPE Atlas API key is required when using the Atlas backend.");
          }
          if (!["ping", "traceroute", "dns"].includes(cmd)) {
            throw new Error("RIPE Atlas backend currently supports ping, traceroute and dns only.");
          }
          if (isIpLiteral(effectiveTarget)) {
            throw new Error("RIPE Atlas backend requires a hostname target (not an IP literal) for IPv4/IPv6 comparison.");
          }
        }

        setTarget(normalizedTarget);
        setV4(null);
        setV6(null);
        setRunWarnings([]);

        const atlasStartedAt = backend === "atlas" ? Date.now() : 0;
        const gpStartedAt = backend !== "atlas" ? Date.now() : 0;
        if (atlasStartedAt) {
          setAtlasRunStartedAt(atlasStartedAt);
          setAtlasUiNow(atlasStartedAt);
          setAtlasPollV4({ startedAt: atlasStartedAt, checks: 0, lastPollAt: null, nextPollAt: null });
          setAtlasPollV6({ startedAt: atlasStartedAt, checks: 0, lastPollAt: null, nextPollAt: null });
        }

        if (gpStartedAt) {
          setGpRunStartedAt(gpStartedAt);
          setGpUiNow(gpStartedAt);
          setGpLastUpdateAt(0);
        }

        const base = {
          type: cmd,
          target: effectiveTarget,
          locations: [location],
          limit: probes,
          inProgressUpdates: true,
        };

        const canEnforceV6 = requireV6Capable && !isIpLiteral(effectiveTarget);

        const flow = canEnforceV6 ? "v6first" : "v4first";

        const stepLabel = multiTargetMode ? ` (${i + 1}/${targets.length})` : "";

        // Human verification (Turnstile) is mandatory before creating measurements.
        setTurnstileStatus(t("statusWaitingVerification", { stepLabel }));
        const turnstileTimeoutId = setTimeout(() => {
          turnstileTimedOut = true;
          ac.abort();
        }, TURNSTILE_EXEC_TIMEOUT_MS);
        const turnstileToken = await getTurnstileToken(ac.signal);
        clearTimeout(turnstileTimeoutId);
        setTurnstileStatus("");

        // Create the IPv4/IPv6 pair server-side so the Turnstile token is validated only once.
        const { m4, m6, warnings } = await createMeasurementsPair({ turnstileToken, base, measurementOptions, flow }, ac.signal);
        if (Array.isArray(warnings) && warnings.length) setRunWarnings(warnings);

        const [r4, r6] = await Promise.all(
          backend === "atlas"
            ? [
                waitForAtlasMeasurement(m4.id, {
                  onUpdate: setV4,
                  onMeta: (meta) => {
                    if (!atlasStartedAt) return;
                    setAtlasPollV4((prev) => ({
                      ...(prev || { startedAt: atlasStartedAt }),
                      startedAt: prev?.startedAt || atlasStartedAt,
                      checks: (prev?.checks || 0) + 1,
                      lastPollAt: meta?.polledAt || Date.now(),
                      nextPollAt: Number.isFinite(Number(meta?.nextPollInMs)) ? (meta.polledAt || Date.now()) + Number(meta.nextPollInMs) : null,
                      lastStatus: meta?.status,
                      expectedTotal: meta?.expectedTotal ?? null,
                      lastResultsLen: meta?.resultsLen ?? null,
                    }));
                  },
                  signal: ac.signal,
                  atlasKey: atlasApiKey,
                }),
                waitForAtlasMeasurement(m6.id, {
                  onUpdate: setV6,
                  onMeta: (meta) => {
                    if (!atlasStartedAt) return;
                    setAtlasPollV6((prev) => ({
                      ...(prev || { startedAt: atlasStartedAt }),
                      startedAt: prev?.startedAt || atlasStartedAt,
                      checks: (prev?.checks || 0) + 1,
                      lastPollAt: meta?.polledAt || Date.now(),
                      nextPollAt: Number.isFinite(Number(meta?.nextPollInMs)) ? (meta.polledAt || Date.now()) + Number(meta.nextPollInMs) : null,
                      lastStatus: meta?.status,
                      expectedTotal: meta?.expectedTotal ?? null,
                      lastResultsLen: meta?.resultsLen ?? null,
                    }));
                  },
                  signal: ac.signal,
                  atlasKey: atlasApiKey,
                }),
              ]
            : [
                waitForMeasurement(m4.id, {
                  onUpdate: (u) => {
                    setV4(u);
                    setGpLastUpdateAt(Date.now());
                  },
                  signal: ac.signal,
                }),
                waitForMeasurement(m6.id, {
                  onUpdate: (u) => {
                    setV6(u);
                    setGpLastUpdateAt(Date.now());
                  },
                  signal: ac.signal,
                }),
              ]
        );

        setV4(r4);
        setV6(r6);

        const summary = normalizeHistorySummary(cmd, r4, r6, { strict: canEnforceV6 });
        const entry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          backend,
          ts: Date.now(),
          cmd,
          target: normalizedTarget,
          effectiveTarget,
          fromRaw: from,
          from: fromWithTag || "world",
          gpTag,
          limit: probes,
          requireV6Capable: canEnforceV6,
          options: {
            packets,
            trProto,
            trPort,
            dnsQuery,
            dnsProto,
            dnsPort,
            dnsResolver,
            dnsTrace,
            httpMethod,
            httpProto: httpEffectiveProto,
            httpPath: httpEffectivePath,
            httpQuery: httpEffectiveQuery,
            httpPort: httpEffectivePort,
            httpResolver,
          },
          filters: {
            asn: probeAsn,
            isp: probeIsp,
            deltaThreshold,
          },
          summary,
        };
        setHistory((prev) => [entry, ...prev].slice(0, HISTORY_LIMIT));
        if (multiTargetMode) {
          setMultiRunResults((prev) => [
            ...prev,
            {
              id: entry.id,
              cmd: entry.cmd,
              target: normalizedTarget,
              effectiveTarget,
              summary,
              v4: r4,
              v6: r6,
            },
          ]);
          setMultiActiveId(entry.id);
        }
      }
    } catch (e) {
      if (e?.status === 429) {
        const seconds = extractRetryAfterSeconds(e);
        if (seconds) setRateLimitUntil(Date.now() + seconds * 1000);
      }
      const message = toUserFacingError(e);
      if (message === t("errorCancelled") && turnstileTimedOut) {
        setErr(t("errorHumanVerificationTimeout"));
      } else {
        setErr(message);
      }
    } finally {
      setRunning(false);
      setTurnstileStatus("");
      setMultiRunStatus(null);
    }
  }

  async function retryFailedFamily(ipVersion) {
    if (running) return;

    const isAtlas = backend === "atlas";
    const isGp = backend === "globalping";

    if (multiTargetMode || (!isAtlas && !isGp)) {
      setErr(t("retryNotAvailable"));
      return;
    }
    if (!v4 || !v6) return;

    const ipVer = Number(ipVersion);
    if (ipVer !== 4 && ipVer !== 6) return;
    const sameProbesAs = ipVer === 4 ? v6?.id : v4?.id;
    if (!sameProbesAs) {
      setErr(t("retryNotAvailable"));
      return;
    }

    if (isAtlas) {
      if (!String(atlasApiKey || "").trim()) {
        setErr("RIPE Atlas API key is required when retrying Atlas measurements.");
        return;
      }
      if (!["ping", "traceroute", "dns"].includes(cmd)) {
        setErr("RIPE Atlas backend currently supports ping, traceroute and dns only.");
        return;
      }
    }

    setErr("");
    setRunWarnings([]);
    setRetryingFamily(ipVer === 4 ? "v4" : "v6");
    setTurnstileStatus(t("statusWaitingVerificationRetry", { ip: ipVer === 4 ? "IPv4" : "IPv6" }));
    setRunning(true);
    let turnstileTimedOut = false;

    try {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      const probes = Math.max(1, Math.min(maxProbes, Number(limit) || 3));
      const fromWithTag = applyGpTag(from, gpTag);
      const location = { magic: fromWithTag || "world" };
      const parsedAsn = Number(probeAsn);
      if (Number.isFinite(parsedAsn) && parsedAsn > 0) location.asn = parsedAsn;
      if (probeIsp.trim()) location.isp = probeIsp.trim();

      const { effectiveTarget, measurementOptions } = buildMeasurementRequest(target, { syncHttpFields: false });

      if (isIpLiteral(effectiveTarget) && cmd !== "dns") {
        throw new Error(t("errorHostnameRequired"));
      }
      if (isAtlas && isIpLiteral(effectiveTarget)) {
        throw new Error("RIPE Atlas backend requires a hostname target (not an IP literal) for IPv4/IPv6 comparison.");
      }

      const base = {
        type: cmd,
        target: effectiveTarget,
        locations: [location],
        limit: probes,
        inProgressUpdates: true,
      };

      // Human verification (Turnstile) is mandatory before creating measurements.
      const turnstileTimeoutId = setTimeout(() => {
        turnstileTimedOut = true;
        ac.abort();
      }, TURNSTILE_EXEC_TIMEOUT_MS);
      const turnstileToken = await getTurnstileToken(ac.signal);
      clearTimeout(turnstileTimeoutId);
      setTurnstileStatus("");

      const { m, warnings } = await createMeasurementSingle(
        { turnstileToken, base, measurementOptions, ipVersion: ipVer, sameProbesAs },
        ac.signal
      );
      if (Array.isArray(warnings) && warnings.length) setRunWarnings(warnings);

      if (isAtlas) {
        const atlasStartedAt = Date.now();
        setAtlasRunStartedAt(atlasStartedAt);
        setAtlasUiNow(atlasStartedAt);

        if (ipVer === 4) {
          setAtlasPollV4({ startedAt: atlasStartedAt, checks: 0, lastPollAt: null, nextPollAt: null });
        } else {
          setAtlasPollV6({ startedAt: atlasStartedAt, checks: 0, lastPollAt: null, nextPollAt: null });
        }

        // Replace only the family we're retrying.
        const init = { backend: "atlas", id: String(m?.id || ""), status: "in-progress", results: [] };
        if (ipVer === 4) setV4(init);
        else setV6(init);

        const r = await waitForAtlasMeasurement(String(m?.id || ""), {
          signal: ac.signal,
          atlasKey: atlasApiKey,
          onUpdate: (next) => {
            if (ipVer === 4) setV4(next);
            else setV6(next);
          },
          onMeta: (meta) => {
            const polledAt = meta?.polledAt || Date.now();
            const nextPollAt = Number.isFinite(Number(meta?.nextPollInMs)) ? polledAt + Number(meta.nextPollInMs) : null;
            if (ipVer === 4) {
              setAtlasPollV4((prev) => ({
                ...(prev || { startedAt: atlasStartedAt }),
                startedAt: prev?.startedAt || atlasStartedAt,
                checks: (prev?.checks || 0) + 1,
                lastPollAt: polledAt,
                nextPollAt,
                lastStatus: meta?.status,
                expectedTotal: meta?.expectedTotal ?? null,
                lastResultsLen: meta?.resultsLen ?? null,
              }));
            } else {
              setAtlasPollV6((prev) => ({
                ...(prev || { startedAt: atlasStartedAt }),
                startedAt: prev?.startedAt || atlasStartedAt,
                checks: (prev?.checks || 0) + 1,
                lastPollAt: polledAt,
                nextPollAt,
                lastStatus: meta?.status,
                expectedTotal: meta?.expectedTotal ?? null,
                lastResultsLen: meta?.resultsLen ?? null,
              }));
            }
          },
        });

        if (ipVer === 4) setV4(r);
        else setV6(r);
      } else {
        const gpStartedAt = Date.now();
        setGpRunStartedAt(gpStartedAt);
        setGpUiNow(gpStartedAt);
        setGpLastUpdateAt(0);

        // Replace only the family we're retrying.
        const init = { backend: "globalping", id: String(m?.id || ""), status: "in-progress", results: [] };
        if (ipVer === 4) setV4(init);
        else setV6(init);

        const r = await waitForMeasurement(String(m?.id || ""), {
          signal: ac.signal,
          pollMs: 750,
          timeoutMs: 120000,
          onUpdate: (next) => {
            setGpLastUpdateAt(Date.now());
            if (ipVer === 4) setV4(next);
            else setV6(next);
          },
        });

        if (ipVer === 4) setV4(r);
        else setV6(r);
      }
    } catch (e) {
      if (e?.status === 429) {
        const seconds = extractRetryAfterSeconds(e);
        if (seconds) setRateLimitUntil(Date.now() + seconds * 1000);
      }
      const message = toUserFacingError(e);
      if (message === t("errorCancelled") && turnstileTimedOut) {
        setErr(t("errorHumanVerificationTimeout"));
      } else {
        setErr(message);
      }
    } finally {
      setRunning(false);
      setTurnstileStatus("");
      setRetryingFamily("");
    }
  }

  function cancel() {
    abortRef.current?.abort();

    // Best-effort: stop any pending Turnstile flow.
    try {
      if (turnstilePendingRef.current && !turnstilePendingRef.current.done) {
        turnstilePendingRef.current.done = true;
        turnstilePendingRef.current.cleanup();
        turnstilePendingRef.current.reject(new Error(t("errorCancelled")));
      }
    } catch {}
    try {
      if (window.turnstile && turnstileWidgetIdRef.current !== null) {
        window.turnstile.reset(turnstileWidgetIdRef.current);
      }
    } catch {}
    setShowTurnstile(false);
    setTurnstileStatus("");
    setMultiRunStatus(null);
    setRetryingFamily("");

    setRunning(false);
  }

  function applyHistoryEntry(entry) {
    if (!entry) return;
    setMultiTargetMode(false);
    setBackend(entry.backend || "globalping");
    setCmd(entry.cmd);
    setTarget(entry.target || "");
    setFrom(entry.fromRaw || entry.from || "");
    setGpTag(entry.gpTag || "any");
    setLimit(entry.limit || 3);
    setRequireV6Capable(Boolean(entry.requireV6Capable));
    const opts = entry.options || {};
    setPackets(opts.packets ?? 3);
    setTrProto(opts.trProto ?? "ICMP");
    setTrPort(opts.trPort ?? 80);
    setDnsQuery(opts.dnsQuery ?? "A");
    setDnsProto(opts.dnsProto ?? "UDP");
    setDnsPort(opts.dnsPort ?? 53);
    setDnsResolver(opts.dnsResolver ?? "");
    setDnsTrace(Boolean(opts.dnsTrace));
    setHttpMethod(opts.httpMethod ?? "GET");
    setHttpProto(opts.httpProto ?? "HTTPS");
    setHttpPath(opts.httpPath ?? "/");
    setHttpQuery(opts.httpQuery ?? "");
    setHttpPort(opts.httpPort ?? "");
    setHttpResolver(opts.httpResolver ?? "");
    const filters = entry.filters || {};
    setProbeAsn(filters.asn ?? "");
    setProbeIsp(filters.isp ?? "");
    setDeltaThreshold(filters.deltaThreshold ?? "");
  }

  function buildShareParams() {
    const params = new URLSearchParams();
    params.set("backend", backend);
    params.set("cmd", cmd);
    params.set("target", target || "");
    params.set("from", from || "");
    params.set("net", gpTag || "any");
    params.set("limit", String(limit || 3));
    params.set("v6only", requireV6Capable ? "1" : "0");
    if (probeAsn) params.set("asn", probeAsn);
    if (probeIsp) params.set("isp", probeIsp);
    if (deltaThreshold) params.set("delta", deltaThreshold);
    if (asnCard?.asn) params.set("asncard", String(asnCard.asn));

    if (cmd === "ping" || cmd === "mtr") params.set("packets", String(packets || 3));
    if (cmd === "traceroute" || cmd === "mtr") {
      params.set("trproto", trProto || "ICMP");
      if ((cmd === "traceroute" && trProto === "TCP") || (cmd === "mtr" && trProto !== "ICMP")) {
        params.set("trport", String(trPort || 80));
      }
    }
    if (cmd === "dns") {
      params.set("dnsq", dnsQuery || "A");
      params.set("dnsproto", dnsProto || "UDP");
      params.set("dnsport", String(dnsPort || 53));
      if (dnsResolver) params.set("dnsresolver", dnsResolver);
      if (dnsTrace) params.set("dnstrace", "1");
    }
    if (cmd === "http") {
      params.set("httpmethod", httpMethod || "GET");
      params.set("httpproto", httpProto || "HTTPS");
      params.set("httppath", httpPath || "/");
      if (httpQuery) params.set("httpquery", httpQuery);
      if (httpPort) params.set("httpport", httpPort);
      if (httpResolver) params.set("httpresolver", httpResolver);
    }
    return params;
  }

  function buildReportPayload() {
    const summary = normalizeHistorySummary(cmd, v4, v6, { strict: strictCompare });
    if (!summary) return null;
    return {
      v: SHARE_VERSION,
      ts: Date.now(),
      cmd,
      target,
      from,
      net: gpTag,
      limit,
      v6only: requireV6Capable,
      filters: {
        asn: probeAsn,
        isp: probeIsp,
        deltaThreshold,
      },
      summary,
    };
  }

  function buildMultiReportPayload() {
    const arr = Array.isArray(multiRunResults) ? multiRunResults : [];
    if (!arr.length) return null;

    const entries = arr
      .map((e) => {
        const summary = normalizeHistorySummary(e?.cmd, e?.v4, e?.v6, { strict: strictCompare });
        if (!summary) return null;
        return {
          id: e?.id,
          cmd: e?.cmd,
          target: e?.target || "",
          effectiveTarget: e?.effectiveTarget || "",
          summary,
        };
      })
      .filter(Boolean);

    if (!entries.length) return null;

    const cmds = Array.from(new Set(entries.map((x) => x?.cmd).filter(Boolean)));
    const cmdLabel = cmds.length === 1 ? cmds[0] : "mixed";

    return {
      v: SHARE_VERSION,
      ts: Date.now(),
      mode: "multiTarget",
      backend,
      cmd: cmdLabel,
      from,
      net: gpTag,
      limit,
      v6only: requireV6Capable,
      filters: {
        asn: probeAsn,
        isp: probeIsp,
        deltaThreshold,
      },
      options: {
        packets,
        trProto,
        trPort,
        dnsQuery,
        dnsProto,
        dnsPort,
        dnsResolver,
        dnsTrace,
        httpMethod,
        httpProto,
        httpPath,
        httpQuery,
        httpPort,
        httpResolver,
      },
      entries,
    };
  }


  function isDualStackRowForExport(kind, r) {
    if (!r) return false;
    if (kind === "ping") return Number.isFinite(r.v4avg) && Number.isFinite(r.v6avg);
    if (kind === "traceroute") return Number.isFinite(r.v4dst) && Number.isFinite(r.v6dst);
    if (kind === "mtr") return Number.isFinite(r.v4avg) && Number.isFinite(r.v6avg);
    if (kind === "dns") return Number.isFinite(r.v4ms) && Number.isFinite(r.v6ms);
    if (kind === "http") return Number.isFinite(r.v4ms) && Number.isFinite(r.v6ms);
    return false;
  }

  function attachExcludedFlag(kind, rows) {
    const arr = Array.isArray(rows) ? rows : [];
    return arr.map((r) => ({ ...r, excluded: !isDualStackRowForExport(kind, r) }));
  }

  function buildExportBundle() {
    if (!v4 || !v6) return null;
    const summary = normalizeHistorySummary(cmd, v4, v6, { strict: strictCompare });
    const base = {
      generatedAt: new Date().toISOString(),
      cmd,
      target,
      from,
      net: gpTag,
      limit,
      v6only: requireV6Capable,
      filters: {
        asn: probeAsn,
        isp: probeIsp,
        deltaThreshold,
      },
      summary,
    };
    if (cmd === "ping" && pingCompare) return { ...base, rows: attachExcludedFlag("ping", pingCompare.rows) };
    if (cmd === "traceroute" && trCompare) return { ...base, rows: attachExcludedFlag("traceroute", trCompare.rows) };
    if (cmd === "mtr" && mtrCompare) return { ...base, rows: attachExcludedFlag("mtr", mtrCompare.rows) };
    if (cmd === "dns" && dnsCompare) return { ...base, rows: attachExcludedFlag("dns", dnsCompare.rows) };
    if (cmd === "http" && httpCompare) return { ...base, rows: attachExcludedFlag("http", httpCompare.rows) };
    return { ...base, rows: [] };
  }

  function downloadJson() {
    const bundle = buildExportBundle();
    if (!bundle) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `ping6-${cmd}-${stamp}.json`;
    downloadFile(filename, JSON.stringify(bundle, null, 2), "application/json");
  }

  function downloadCsv() {
    const bundle = buildExportBundle();
    if (!bundle) return;
    const rows = bundle.rows || [];
    let headers = [];
    let lines = [];

    if (cmd === "ping") {
      headers = ["idx", "city", "country", "asn", "network", "v4_avg_ms", "v4_loss_pct", "v6_avg_ms", "v6_loss_pct", "delta_avg_ms", "delta_loss_pct", "winner", "v4_state", "v6_state", "excluded"];
      lines = rows.map((r) => [
        r.idx + 1,
        r.probe?.city ?? "",
        r.probe?.country ?? "",
        r.probe?.asn ?? "",
        r.probe?.network ?? "",
        r.v4avg,
        r.v4loss,
        r.v6avg,
        r.v6loss,
        r.deltaAvg,
        r.deltaLoss,
        r.winner,
        r.v4state,
        r.v6state,
        r.excluded ? "yes" : "no",
      ]);
    } else if (cmd === "traceroute") {
      headers = ["idx", "city", "country", "asn", "network", "v4_reached", "v4_hops", "v4_dst_ms", "v6_reached", "v6_hops", "v6_dst_ms", "delta_ms", "winner", "v4_state", "v6_state", "excluded"];
      lines = rows.map((r) => [
        r.idx + 1,
        r.probe?.city ?? "",
        r.probe?.country ?? "",
        r.probe?.asn ?? "",
        r.probe?.network ?? "",
        r.v4reached === null ? "" : r.v4reached ? "yes" : "no",
        r.v4hops,
        r.v4dst,
        r.v6reached === null ? "" : r.v6reached ? "yes" : "no",
        r.v6hops,
        r.v6dst,
        r.delta,
        r.winner,
        r.v4state,
        r.v6state,
        r.excluded ? "yes" : "no",
      ]);
    } else if (cmd === "mtr") {
      headers = ["idx", "city", "country", "asn", "network", "v4_reached", "v4_hops", "v4_loss_pct", "v4_avg_ms", "v6_reached", "v6_hops", "v6_loss_pct", "v6_avg_ms", "delta_avg_ms", "delta_loss_pct", "winner", "v4_state", "v6_state", "excluded"];
      lines = rows.map((r) => [
        r.idx + 1,
        r.probe?.city ?? "",
        r.probe?.country ?? "",
        r.probe?.asn ?? "",
        r.probe?.network ?? "",
        r.v4reached === null ? "" : r.v4reached ? "yes" : "no",
        r.v4hops,
        r.v4loss,
        r.v4avg,
        r.v6reached === null ? "" : r.v6reached ? "yes" : "no",
        r.v6hops,
        r.v6loss,
        r.v6avg,
        r.deltaAvg,
        r.deltaLoss,
        r.winner,
        r.v4state,
        r.v6state,
        r.excluded ? "yes" : "no",
      ]);
    } else if (cmd === "dns") {
      headers = ["idx", "city", "country", "asn", "network", "v4_total_ms", "v6_total_ms", "delta_ms", "ratio", "winner", "v4_state", "v6_state", "excluded"];
      lines = rows.map((r) => [
        r.idx + 1,
        r.probe?.city ?? "",
        r.probe?.country ?? "",
        r.probe?.asn ?? "",
        r.probe?.network ?? "",
        r.v4ms,
        r.v6ms,
        r.delta,
        r.ratio,
        r.winner,
        r.v4state,
        r.v6state,
        r.excluded ? "yes" : "no",
      ]);
    } else if (cmd === "http") {
      headers = ["idx", "city", "country", "asn", "network", "v4_status", "v6_status", "v4_total_ms", "v6_total_ms", "delta_ms", "ratio", "winner", "v4_state", "v6_state", "excluded"];
      lines = rows.map((r) => [
        r.idx + 1,
        r.probe?.city ?? "",
        r.probe?.country ?? "",
        r.probe?.asn ?? "",
        r.probe?.network ?? "",
        r.v4sc,
        r.v6sc,
        r.v4ms,
        r.v6ms,
        r.delta,
        r.ratio,
        r.winner,
        r.v4state,
        r.v6state,
        r.excluded ? "yes" : "no",
      ]);
    }

    const csv = [headers.map(csvEscape).join(","), ...lines.map((row) => row.map(csvEscape).join(","))].join("\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `ping6-${cmd}-${stamp}.csv`;
    downloadFile(filename, csv, "text/csv");
  }

  // Multi-target export helpers.
  function buildExportBundleForPair(pairCmd, r4, r6, { target: targetOverride, effectiveTarget: effectiveOverride } = {}) {
    if (!r4 || !r6) return null;

    const summary = normalizeHistorySummary(pairCmd, r4, r6, { strict: strictCompare });

    let rows = [];
    if (pairCmd === "ping") rows = buildPingCompare(r4, r6, { strict: strictCompare })?.rows || [];
    else if (pairCmd === "traceroute") rows = buildTracerouteCompare(r4, r6, { strict: strictCompare })?.rows || [];
    else if (pairCmd === "mtr") rows = buildMtrCompare(r4, r6, { strict: strictCompare })?.rows || [];
    else if (pairCmd === "dns") rows = buildDnsCompare(r4, r6, { strict: strictCompare })?.rows || [];
    else if (pairCmd === "http") rows = buildHttpCompare(r4, r6, { strict: strictCompare })?.rows || [];

    return {
      generatedAt: new Date().toISOString(),
      backend,
      cmd: pairCmd,
      target: targetOverride || target || "",
      effectiveTarget: effectiveOverride || "",
      from,
      net: gpTag,
      limit,
      v6only: requireV6Capable,
      filters: {
        asn: probeAsn,
        isp: probeIsp,
        deltaThreshold,
      },
      options: {
        packets,
        trProto,
        trPort,
        dnsQuery,
        dnsProto,
        dnsPort,
        dnsResolver,
        dnsTrace,
        httpMethod,
        httpProto,
        httpPath,
        httpQuery,
        httpPort,
        httpResolver,
      },
      summary,
      rows: attachExcludedFlag(pairCmd, rows),
    };
  }

  function buildMultiExportBundle({ includeRaw = false } = {}) {
    const arr = Array.isArray(multiRunResults) ? multiRunResults : [];
    if (!arr.length) return null;

    const cmds = Array.from(new Set(arr.map((x) => x?.cmd).filter(Boolean)));
    const cmdLabel = cmds.length === 1 ? cmds[0] : "mixed";

    const entries = arr
      .map((e) => {
        const b = buildExportBundleForPair(e?.cmd, e?.v4, e?.v6, { target: e?.target, effectiveTarget: e?.effectiveTarget });
        if (!b) return null;
        return {
          id: e?.id,
          cmd: b.cmd,
          target: b.target,
          effectiveTarget: b.effectiveTarget,
          summary: b.summary,
          rows: b.rows,
          ...(includeRaw ? { raw: { v4: e?.v4, v6: e?.v6 } } : {}),
        };
      })
      .filter(Boolean);

    return {
      generatedAt: new Date().toISOString(),
      mode: "multiTarget",
      backend,
      cmd: cmdLabel,
      rawIncluded: includeRaw,
      from,
      net: gpTag,
      limit,
      v6only: requireV6Capable,
      filters: {
        asn: probeAsn,
        isp: probeIsp,
        deltaThreshold,
      },
      options: {
        packets,
        trProto,
        trPort,
        dnsQuery,
        dnsProto,
        dnsPort,
        dnsResolver,
        dnsTrace,
        httpMethod,
        httpProto,
        httpPath,
        httpQuery,
        httpPort,
        httpResolver,
      },
      entries,
    };
  }

  function downloadMultiJson() {
    const bundle = buildMultiExportBundle({ includeRaw: multiExportIncludeRaw });
    if (!bundle) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `ping6-multi-${bundle.cmd}-${stamp}.json`;
    downloadFile(filename, JSON.stringify(bundle, null, 2), "application/json");
  }

  function downloadMultiCsvSummary() {
    const arr = Array.isArray(multiRunResults) ? multiRunResults : [];
    if (!arr.length) return;

    const headers = [
      "target",
      "cmd",
      "median_v4_ms",
      "median_v6_ms",
      "median_delta_ms",
      "median_loss_v4_pct",
      "median_loss_v6_pct",
    ];

    const lines = arr.map((e) => {
      const s = normalizeHistorySummary(e?.cmd, e?.v4, e?.v6, { strict: strictCompare }) || {};
      return [
        e?.target || "",
        e?.cmd || "",
        s.medianV4 ?? "",
        s.medianV6 ?? "",
        s.medianDelta ?? "",
        s.medianLossV4 ?? "",
        s.medianLossV6 ?? "",
      ];
    });

    const csv = [headers.map(csvEscape).join(","), ...lines.map((row) => row.map(csvEscape).join(","))].join("\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `ping6-multi-summary-${stamp}.csv`;
    downloadFile(filename, csv, "text/csv");
  }


  function downloadMultiCsvRows() {
    const arr = Array.isArray(multiRunResults) ? multiRunResults : [];
    if (!arr.length) return;

    const headers = [
      "target",
      "cmd",
      "idx",
      "city",
      "country",
      "asn",
      "network",
      "v4_reached",
      "v4_hops",
      "v4_dst_ms",
      "v4_loss_pct",
      "v4_avg_ms",
      "v4_total_ms",
      "v4_status",
      "v6_reached",
      "v6_hops",
      "v6_dst_ms",
      "v6_loss_pct",
      "v6_avg_ms",
      "v6_total_ms",
      "v6_status",
      "delta_ms",
      "delta_avg_ms",
      "delta_loss_pct",
      "ratio",
      "winner",
      "excluded",
    ];

    const lines = [];

    for (const e of arr) {
      const cmd = e?.cmd;
      const r4 = e?.v4;
      const r6 = e?.v6;
      const tname = e?.target || "";
      if (!cmd || !r4 || !r6) continue;

      const bundle = buildExportBundleForPair(cmd, r4, r6, { target: tname, effectiveTarget: e?.effectiveTarget });
      const rows = Array.isArray(bundle?.rows) ? bundle.rows : [];

      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        const p = r?.probe || {};
        const idx = Number.isFinite(r?.idx) ? r.idx + 1 : i + 1;

        const base = {
          target: tname,
          cmd,
          idx,
          city: p.city ?? "",
          country: p.country ?? "",
          asn: p.asn ?? "",
          network: p.network ?? "",
          v4_reached: "",
          v4_hops: "",
          v4_dst_ms: "",
          v4_loss_pct: "",
          v4_avg_ms: "",
          v4_total_ms: "",
          v4_status: "",
          v6_reached: "",
          v6_hops: "",
          v6_dst_ms: "",
          v6_loss_pct: "",
          v6_avg_ms: "",
          v6_total_ms: "",
          v6_status: "",
          delta_ms: "",
          delta_avg_ms: "",
          delta_loss_pct: "",
          ratio: "",
          winner: r?.winner ?? "",
          excluded: r?.excluded ? "yes" : "no",
        };

        if (cmd === "ping") {
          base.v4_avg_ms = r?.v4avg ?? "";
          base.v4_loss_pct = r?.v4loss ?? "";
          base.v6_avg_ms = r?.v6avg ?? "";
          base.v6_loss_pct = r?.v6loss ?? "";
          base.delta_avg_ms = r?.deltaAvg ?? "";
          base.delta_loss_pct = r?.deltaLoss ?? "";
        } else if (cmd === "traceroute") {
          base.v4_reached = r?.v4reached ? "yes" : "no";
          base.v4_hops = r?.v4hops ?? "";
          base.v4_dst_ms = r?.v4dst ?? "";
          base.v6_reached = r?.v6reached ? "yes" : "no";
          base.v6_hops = r?.v6hops ?? "";
          base.v6_dst_ms = r?.v6dst ?? "";
          base.delta_ms = r?.delta ?? "";
        } else if (cmd === "mtr") {
          base.v4_reached = r?.v4reached ? "yes" : "no";
          base.v4_hops = r?.v4hops ?? "";
          base.v4_loss_pct = r?.v4loss ?? "";
          base.v4_avg_ms = r?.v4avg ?? "";
          base.v6_reached = r?.v6reached ? "yes" : "no";
          base.v6_hops = r?.v6hops ?? "";
          base.v6_loss_pct = r?.v6loss ?? "";
          base.v6_avg_ms = r?.v6avg ?? "";
          base.delta_avg_ms = r?.deltaAvg ?? "";
          base.delta_loss_pct = r?.deltaLoss ?? "";
        } else if (cmd === "dns") {
          base.v4_total_ms = r?.v4ms ?? "";
          base.v6_total_ms = r?.v6ms ?? "";
          base.delta_ms = r?.delta ?? "";
          base.ratio = r?.ratio ?? "";
        } else if (cmd === "http") {
          base.v4_status = r?.v4sc ?? "";
          base.v6_status = r?.v6sc ?? "";
          base.v4_total_ms = r?.v4ms ?? "";
          base.v6_total_ms = r?.v6ms ?? "";
          base.delta_ms = r?.delta ?? "";
          base.ratio = r?.ratio ?? "";
        }

        lines.push([
          base.target,
          base.cmd,
          base.idx,
          base.city,
          base.country,
          base.asn,
          base.network,
          base.v4_reached,
          base.v4_hops,
          base.v4_dst_ms,
          base.v4_loss_pct,
          base.v4_avg_ms,
          base.v4_total_ms,
          base.v4_status,
          base.v6_reached,
          base.v6_hops,
          base.v6_dst_ms,
          base.v6_loss_pct,
          base.v6_avg_ms,
          base.v6_total_ms,
          base.v6_status,
          base.delta_ms,
          base.delta_avg_ms,
          base.delta_loss_pct,
          base.ratio,
          base.winner,
          base.excluded,
        ]);
      }
    }

    const csv = [headers.map(csvEscape).join(","), ...lines.map((row) => row.map(csvEscape).join(","))].join("\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `ping6-multi-rows-${stamp}.csv`;
    downloadFile(filename, csv, "text/csv");
  }



  function updateShareLink() {
    if (typeof window === "undefined") return;
    const params = buildShareParams();
    const url = new URL(window.location.href);
    url.search = params.toString();
    setShareUrl(url.toString());
    return url.toString();
  }

  async function createShortReport(payload, signal) {
    const token = await getTurnstileToken(signal);

    const res = await fetch("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstileToken: token, payload }),
      signal,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(data?.error || "report_create_failed");
      err.status = res.status;
      err.data = data;
      const ra = res.headers.get("retry-after") || "";
      err.retryAfter = ra ? Number(ra) : 0;
      throw err;
    }

    return data;
  }

  async function loadShortReport(id, signal) {
    const res = await fetch(`/api/report/${encodeURIComponent(id)}`, { signal });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(data?.error || "report_load_failed");
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  function setLocationToShortReport(id) {
    const url = new URL(window.location.href);
    url.pathname = `/r/${id}`;
    url.search = "";
    url.hash = "";
    window.history.replaceState({}, "", url.toString());
    setShareUrl(url.toString());
  }

  function setLocationToShareParams() {
    const params = buildShareParams();
    const url = new URL(window.location.href);
    url.pathname = "/";
    url.search = params.toString();
    url.hash = "";
    window.history.replaceState({}, "", url.toString());
    setShareUrl(url.toString());
  }

  async function enterReportMode() {
    if (typeof window === "undefined") return;
    const payload = buildReportPayload();
    if (!payload) return;

    setErr("");
    setReportNotice("");
    setReportBusy(true);

    const ac = new AbortController();

    try {
      const created = await createShortReport(payload, ac.signal);
      const id = String(created?.id || "");
      if (!REPORT_ID_RE.test(id)) throw new Error("invalid_report_id");

      setLocationToShortReport(id);
      setReportMode(true);
      setReportData(payload);
      setReportMeta({ id, createdAt: created?.createdAt || null, expiresAt: created?.expiresAt || null });
    } catch (e) {
      if (e?.status === 429 && e?.retryAfter) {
        const ra = Number(e.retryAfter) || 0;
        if (ra > 0) setRateLimitUntil(Date.now() + ra * 1000);
      }

      // Fallback to URL-encoded report (keeps the previous behavior working without KV).
      const encoded = encodeReportPayload(payload);
      if (!encoded) {
        setErr(String(e?.message || e || "report_create_failed"));
        return;
      }

      const url = new URL(window.location.href);
      url.searchParams.set("report", "1");
      url.searchParams.set("data", encoded);
      window.history.replaceState({}, "", url.toString());
      setReportMode(true);
      setReportData(payload);
      setReportMeta(null);
      setShareUrl(url.toString());
      setReportNotice(t("reportCreateFailed"));
    } finally {
      setReportBusy(false);
    }
  }

  async function enterMultiReportMode() {
    if (typeof window === "undefined") return;
    const payload = buildMultiReportPayload();
    if (!payload) return;

    setErr("");
    setReportNotice("");
    setReportBusy(true);

    const ac = new AbortController();

    try {
      const created = await createShortReport(payload, ac.signal);
      const id = String(created?.id || "");
      if (!REPORT_ID_RE.test(id)) throw new Error("invalid_report_id");

      setLocationToShortReport(id);
      setReportMode(true);
      setReportData(payload);
      setReportMeta({ id, createdAt: created?.createdAt || null, expiresAt: created?.expiresAt || null });
    } catch (e) {
      if (e?.status === 429 && e?.retryAfter) {
        const ra = Number(e.retryAfter) || 0;
        if (ra > 0) setRateLimitUntil(Date.now() + ra * 1000);
      }
      setErr(String(e?.message || e || "report_create_failed"));
    } finally {
      setReportBusy(false);
    }
  }


  function copyToClipboard(value) {
    if (typeof navigator === "undefined") return;
    if (!value) return;
    try {
      navigator.clipboard?.writeText(value);
    } catch {}
  }

  function exitReportMode() {
    if (typeof window === "undefined") return;
    setReportMode(false);
    setReportData(null);
    setReportMeta(null);
    setReportNotice("");
    setLocationToShareParams();
  }



  const handleSelectMultiEntry = useCallback((entry) => {
    if (!entry) return;
    startTransition(() => {
      setV4(entry.v4);
      setV6(entry.v6);
      setTarget(entry.target);
      setShowRaw(false);
      setMultiActiveId(entry.id);
    });
  }, []);


  const showPingTable = cmd === "ping" && v4ForCompute && v6ForCompute;
  const showTracerouteTable = cmd === "traceroute" && v4ForCompute && v6ForCompute;
  const showMtrTable = cmd === "mtr" && v4ForCompute && v6ForCompute;

  useEffect(() => {
    setExpandedPathKey(null);
  }, [cmd, v4?.id, v6?.id]);

  const showDnsTable = cmd === "dns" && v4ForCompute && v6ForCompute;
  const showHttpTable = cmd === "http" && v4ForCompute && v6ForCompute;

  const historyEntryA = useMemo(() => history.find((h) => h.id === historyCompareA) || null, [history, historyCompareA]);
  const historyEntryB = useMemo(() => history.find((h) => h.id === historyCompareB) || null, [history, historyCompareB]);
  const historyCompareMismatch =
    historyEntryA && historyEntryB && historyEntryA.cmd !== historyEntryB.cmd ? t("compareMismatch") : "";
  const historyCompareMetrics = useMemo(() => {
    if (!historyEntryA || !historyEntryB) return [];
    if (!historyEntryA.summary || !historyEntryB.summary) return [];
    if (historyEntryA.summary.kind !== historyEntryB.summary.kind) return [];
    const a = historyEntryA.summary;
    const b = historyEntryB.summary;
    const metrics = [
      { label: t("summaryMedianV4"), format: ms, a: a.medianV4, b: b.medianV4 },
      { label: t("summaryMedianV6"), format: ms, a: a.medianV6, b: b.medianV6 },
      { label: t("deltaV6V4"), format: ms, a: a.medianDelta, b: b.medianDelta },
    ];
    if (a.kind === "ping" || a.kind === "mtr") {
      metrics.push(
        { label: t("summaryMedianLossV4"), format: pct, a: a.medianLossV4, b: b.medianLossV4 },
        { label: t("summaryMedianLossV6"), format: pct, a: a.medianLossV6, b: b.medianLossV6 }
      );
    }
    return metrics;
  }, [historyEntryA, historyEntryB, t]);

  const probePoints = useMemo(() => {
    const results = v4ForCompute?.results || v6ForCompute?.results || [];
    const seen = new Set();
    const points = [];
    results.forEach((x) => {
      const p = x?.probe || {};
      const coords = probeCoords(p);
      if (!coords) return;
      const key = `${coords.lat},${coords.lon}`;
      if (seen.has(key)) return;
      seen.add(key);
      points.push({ ...coords, label: `${p.city || ""} ${p.country || ""}`.trim() });
    });
    return points;
  }, [v4ForCompute, v6ForCompute]);

  const probeMapUrl = useMemo(() => buildStaticMapUrl(probePoints.slice(0, 40)), [probePoints]);

  const traceroutePaths = useMemo(() => {
    if (!showTracerouteTable || !v4ForCompute || !v6ForCompute) return [];
    const a = v4ForCompute?.results ?? [];
    const b = v6ForCompute?.results ?? [];
    const keys = buildProbeUnionKeys(a, b, { excludeKeys: probeExcludeKeys });
    const aMap = buildResultMap(a, "v4");
    const bMap = buildResultMap(b, "v6");

    return keys.map((k, i) => {
      const x = aMap.get(k) ?? null;
      const y = bMap.get(k) ?? null;
      const p = x?.probe || y?.probe || {};
      return {
        key: k,
        probe: p,
        v4path: formatHopPath(x),
        v6path: formatHopPath(y),
        v4res: x,
        v6res: y,
        hopDiff: computeHopDiffSummary(x, y, 30),
      };
    });
  }, [showTracerouteTable, v4ForCompute, v6ForCompute, strictCompare, probeExcludeKeys]);

  const mtrPaths = useMemo(() => {
    if (!showMtrTable || !v4ForCompute || !v6ForCompute) return [];
    const a = v4ForCompute?.results ?? [];
    const b = v6ForCompute?.results ?? [];
    const keys = buildProbeUnionKeys(a, b, { excludeKeys: probeExcludeKeys });
    const aMap = buildResultMap(a, "v4");
    const bMap = buildResultMap(b, "v6");

    return keys.map((k, i) => {
      const x = aMap.get(k) ?? null;
      const y = bMap.get(k) ?? null;
      const p = x?.probe || y?.probe || {};
      return {
        key: k,
        probe: p,
        v4path: formatHopPath(x),
        v6path: formatHopPath(y),
        v4res: x,
        v6res: y,
        hopDiff: computeHopDiffSummary(x, y, 30),
      };
    });
  }, [showMtrTable, v4ForCompute, v6ForCompute, strictCompare, probeExcludeKeys]);

  const pingCompare = useMemo(() => {
    if (!showPingTable) return null;
    return buildPingCompare(v4ForCompute, v6ForCompute, { strict: strictCompare, excludeKeys: probeExcludeKeys });
  }, [showPingTable, v4ForCompute, v6ForCompute, strictCompare, probeExcludeKeys]);

  const dnsCompare = useMemo(() => {
    if (!showDnsTable) return null;
    return buildDnsCompare(v4ForCompute, v6ForCompute, { strict: strictCompare, excludeKeys: probeExcludeKeys });
  }, [showDnsTable, v4ForCompute, v6ForCompute, strictCompare, probeExcludeKeys]);

  const httpCompare = useMemo(() => {
    if (!showHttpTable) return null;
    return buildHttpCompare(v4ForCompute, v6ForCompute, { strict: strictCompare, excludeKeys: probeExcludeKeys });
  }, [showHttpTable, v4ForCompute, v6ForCompute, strictCompare, probeExcludeKeys]);


  const trCompare = useMemo(() => {
    if (!showTracerouteTable) return null;
    return buildTracerouteCompare(v4ForCompute, v6ForCompute, { strict: strictCompare, excludeKeys: probeExcludeKeys });
  }, [showTracerouteTable, v4ForCompute, v6ForCompute, strictCompare, probeExcludeKeys]);

  const mtrCompare = useMemo(() => {
    if (!showMtrTable) return null;
    return buildMtrCompare(v4ForCompute, v6ForCompute, { strict: strictCompare, excludeKeys: probeExcludeKeys });
  }, [showMtrTable, v4ForCompute, v6ForCompute, strictCompare, probeExcludeKeys]);

  const pingRows = useMemo(() => (pingCompare ? sortCompareRows(pingCompare.rows, "ping", tableSort) : []), [pingCompare, tableSort]);
  const tracerouteRows = useMemo(() => (trCompare ? sortCompareRows(trCompare.rows, "traceroute", tableSort) : []), [trCompare, tableSort]);
  const mtrRows = useMemo(() => (mtrCompare ? sortCompareRows(mtrCompare.rows, "mtr", tableSort) : []), [mtrCompare, tableSort]);
  const dnsRows = useMemo(() => (dnsCompare ? sortCompareRows(dnsCompare.rows, "dns", tableSort) : []), [dnsCompare, tableSort]);
  const httpRows = useMemo(() => (httpCompare ? sortCompareRows(httpCompare.rows, "http", tableSort) : []), [httpCompare, tableSort]);

  const pingVizRows = useMemo(() => {
    if (!pingCompare) return [];
    return pingCompare.rows.map((r) => ({
      id: `ping|${r.key}`,
      label: formatProbeLocation(r.probe),
      v4: r.v4avg,
      v6: r.v6avg,
      v4loss: r.v4loss,
      v6loss: r.v6loss,
      excluded: strictCompare && !(Number.isFinite(r.v4avg) && Number.isFinite(r.v6avg)),
    }));
  }, [pingCompare, strictCompare]);

  const tracerouteVizRows = useMemo(() => {
    if (!trCompare) return [];
    return trCompare.rows.map((r) => ({
      id: `traceroute|${r.key}`,
      label: formatProbeLocation(r.probe),
      v4: r.v4dst,
      v6: r.v6dst,
      series4: r.v4series,
      series6: r.v6series,
      excluded: strictCompare && !(Number.isFinite(r.v4dst) && Number.isFinite(r.v6dst)),
    }));
  }, [trCompare, strictCompare]);

  const mtrVizRows = useMemo(() => {
    if (!mtrCompare) return [];
    return mtrCompare.rows.map((r) => ({
      id: `mtr|${r.key}`,
      label: formatProbeLocation(r.probe),
      v4: r.v4avg,
      v6: r.v6avg,
      v4loss: r.v4loss,
      v6loss: r.v6loss,
      excluded: strictCompare && !(Number.isFinite(r.v4avg) && Number.isFinite(r.v6avg)),
    }));
  }, [mtrCompare, strictCompare]);

  const dnsVizRows = useMemo(() => {
    if (!dnsCompare) return [];
    return dnsCompare.rows.map((r) => ({
      id: `dns|${r.key}`,
      label: formatProbeLocation(r.probe),
      v4: r.v4ms,
      v6: r.v6ms,
      excluded: strictCompare && !(Number.isFinite(r.v4ms) && Number.isFinite(r.v6ms)),
    }));
  }, [dnsCompare, strictCompare]);

  const httpVizRows = useMemo(() => {
    if (!httpCompare) return [];
    return httpCompare.rows.map((r) => ({
      id: `http|${r.key}`,
      label: formatProbeLocation(r.probe),
      v4: r.v4ms,
      v6: r.v6ms,
      excluded: strictCompare && !(Number.isFinite(r.v4ms) && Number.isFinite(r.v6ms)),
    }));
  }, [httpCompare, strictCompare]);


  const asnContext = useMemo(() => {
    if (cmd === 'ping' && pingCompare) return { kind: 'ping', rows: pingCompare.rows };
    if (cmd === 'traceroute' && trCompare) return { kind: 'traceroute', rows: trCompare.rows };
    if (cmd === 'mtr' && mtrCompare) return { kind: 'mtr', rows: mtrCompare.rows };
    if (cmd === 'dns' && dnsCompare) return { kind: 'dns', rows: dnsCompare.rows };
    if (cmd === 'http' && httpCompare) return { kind: 'http', rows: httpCompare.rows };
    return { kind: cmd, rows: [] };
  }, [cmd, pingCompare, trCompare, mtrCompare, dnsCompare, httpCompare]);

  useEffect(() => {
    const asn = asnCardFromUrl;
    if (!asn) return;
    if (asnCard) return;

    const kind = asnContext?.kind || cmd;
    const rows = Array.isArray(asnContext?.rows) ? asnContext.rows : [];
    openAsnCard(asn, kind, rows);
    setAsnCardFromUrl(null);
  }, [asnCardFromUrl, asnCard, asnContext, cmd]);

  const deltaThresholdValue = Number(deltaThreshold);
  const thresholdEnabled = Number.isFinite(deltaThresholdValue) && deltaThresholdValue > 0;
  const deltaAlert = useMemo(() => {
    if (!thresholdEnabled) return null;
    let delta = null;
    let label = "";
    if (pingCompare?.summary) {
      delta = pingCompare.summary.median_delta_avg;
      label = t("deltaPingLabel");
    } else if (trCompare?.summary) {
      delta = trCompare.summary.median_delta;
      label = t("deltaTracerouteLabel");
    } else if (mtrCompare?.summary) {
      delta = mtrCompare.summary.median_delta_avg;
      label = t("deltaMtrLabel");
    } else if (dnsCompare?.summary) {
      delta = dnsCompare.summary.median_delta;
      label = t("deltaDnsLabel");
    } else if (httpCompare?.summary) {
      delta = httpCompare.summary.median_delta;
      label = t("deltaHttpLabel");
    }
    if (!Number.isFinite(delta)) return null;
    const absDelta = Math.abs(delta);
    if (absDelta < deltaThresholdValue) return null;
    return { label, delta };
  }, [thresholdEnabled, deltaThresholdValue, pingCompare, trCompare, mtrCompare, dnsCompare, httpCompare, t]);

  const coverageNotice = useMemo(() => {
    if (running) return null;
    if (!v4 || !v6) return null;

    const v4got = Array.isArray(v4?.results) ? v4.results.length : 0;
    const v6got = Array.isArray(v6?.results) ? v6.results.length : 0;

    const expectedFromAtlas = (m) => {
      const n = Number(
        m?.atlas?.measurement?.probes_scheduled ??
          m?.atlas?.measurement?.probes_requested ??
          m?.atlas?.measurement?.probes ??
          m?.atlas?.measurement?.probes_count
      );
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const v4exp = backend === "atlas" ? expectedFromAtlas(v4) ?? limit : limit;
    const v6exp = backend === "atlas" ? expectedFromAtlas(v6) ?? limit : limit;
    const expected = Math.max(1, Math.min(v4exp, v6exp));

    const v4Keys = new Set((v4?.results || []).map(probeKey).filter(Boolean));
    const both = (v6?.results || []).reduce((acc, x) => (v4Keys.has(probeKey(x)) ? acc + 1 : acc), 0);

    const missing = v4got < v4exp || v6got < v6exp || both < expected;
    if (!missing) return null;

    return { v4got, v4exp, v6got, v6exp, both, expected };
  }, [running, v4, v6, backend, limit]);

  const measurementStatusNotice = useMemo(() => {
    if (running) return null;
    if (!v4 || !v6) return null;

    const s4 = String(v4?.status || "").toLowerCase();
    const s6 = String(v6?.status || "").toLowerCase();

    const bad4 = s4 && s4 !== "finished";
    const bad6 = s6 && s6 !== "finished";
    if (!bad4 && !bad6) return null;

    const fmt = (s, m) => {
      const base = s || "unknown";
      const reason = m?.statusReason ? ` (${m.statusReason})` : "";
      const name = m?.statusName ? ` – ${m.statusName}` : "";
      return `${base}${reason}${name}`;
    };

    return { v4: fmt(s4, v4), v6: fmt(s6, v6) };
  }, [running, v4, v6]);

  const familyIssues = useMemo(() => {
    if (!v4 || !v6) return { badV4: 0, badV6: 0 };
    return computeFamilyIssues(v4, v6);
  }, [v4, v6]);

  const showRetryControls =
    (backend === "globalping" || backend === "atlas") &&
    !multiTargetMode &&
    !running &&
    v4 &&
    v6 &&
    (Number(familyIssues?.badV4) > 0 || Number(familyIssues?.badV6) > 0) &&
    (backend !== "atlas" || Boolean(String(atlasApiKey || "").trim()));
  const canRetryV4 = showRetryControls && Number(familyIssues?.badV4) > 0 && Boolean(v6?.id);
  const canRetryV6 = showRetryControls && Number(familyIssues?.badV6) > 0 && Boolean(v4?.id);

  const renderPerHopDiff = useCallback((v4res, v6res) => {
    const aligned = buildHopAlignment(v4res, v6res, 30);
    const rows = aligned.rows || [];
    const s = aligned.summary || {};

    if (!rows.length) {
      return <div style={{ fontSize: 12, opacity: 0.8 }}>{t('pathNoHopData')}</div>;
    }

    const renderHopCell = (label, ip) => {
      const ipStr = String(ip || '').trim();
      const m = ipStr ? (ipMetaByIp?.[ipStr] || getIpMetaCache(ipStr)) : null;
      const asn = m && Number.isFinite(Number(m.asn)) ? Number(m.asn) : null;
      const loading = ipStr && ipMetaInFlightRef.current?.has(ipStr) && !m;

      if (!asn && !loading) {
        return <div style={{ wordBreak: 'break-word' }}>{label}</div>;
      }

      const bits = [];
      if (asn) bits.push(`AS${asn}`);
      if (m?.holder) bits.push(String(m.holder));
      if (m?.prefix) bits.push(String(m.prefix));
      const metaText = bits.join(' · ');

      const titleBits = [];
      if (asn) titleBits.push(`AS${asn}`);
      if (m?.holder) titleBits.push(String(m.holder));
      if (m?.prefix) titleBits.push(String(m.prefix));
      if (m?.source) titleBits.push(String(m.source));
      const title = titleBits.join(' · ');

      return (
        <div style={{ display: 'grid', gap: 2 }}>
          <div style={{ wordBreak: 'break-word' }}>{label}</div>
          {asn ? (
            <div
              style={{
                fontSize: 11,
                opacity: 0.75,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={title}
            >
              {metaText}
            </div>
          ) : (
            <div style={{ fontSize: 11, opacity: 0.6 }}>{t('perHopAsnLoading')}</div>
          )}
        </div>
      );
    };

    return (
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10, background: '#fafafa' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ fontWeight: 800 }}>{t('perHopDiffTitle')}</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {Number.isFinite(Number(s.maxHop)) && Number(s.maxHop) > 0
              ? s.firstDiffHop
                ? t('pathDivergeAt', { n: s.firstDiffHop })
                : t('pathNoDivergence', { n: s.maxHop })
              : '-'}
            {s.truncated ? <span style={{ marginLeft: 10 }}>{t('pathShowingFirstHops', { n: s.maxHop })}</span> : null}
          </div>
        </div>

        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
          <thead>
            <tr>
              {[t('hop'), 'v4', 'v6'].map((h) => (
                <th
                  key={h}
                  style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: '6px 8px' }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const bg = r.isFirstDiff ? '#fee2e2' : r.diff ? '#ffedd5' : 'transparent';
              return (
                <tr key={r.hop} style={{ background: bg }}>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6', width: 60 }}>{r.hop}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>
                    {renderHopCell(r.v4, r.v4ip)}
                  </td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>
                    {renderHopCell(r.v6, r.v6ip)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }, [t, ipMetaByIp]);

  const preStyle = {
    padding: 12,
    background: "#111827",
    color: "#f9fafb",
    border: "1px solid #111827",
    borderRadius: 8,
    maxWidth: "100%",
    width: "100%",
    boxSizing: "border-box",
    overflowX: "auto",
    lineHeight: 1.35,
  };

  // Licensing (AGPL) and build provenance (Cloudflare Pages commit SHA -> VITE_COMMIT_SHA)
  const repoUrl = "https://github.com/Antonio-Prado/ping6-it";
  const commitSha = String(import.meta.env.VITE_COMMIT_SHA || "").trim();
  const commitRef = commitSha || "main";
  const shortSha = commitSha ? commitSha.slice(0, 7) : "";
  const sourceUrl = commitSha ? `${repoUrl}/tree/${commitSha}` : repoUrl;
  const agplUrl = `${repoUrl}/blob/${commitRef}/LICENSE`;
  const ccUrl = `${repoUrl}/blob/${commitRef}/LICENSE-DOCS`;

  const atlasElapsed = atlasRunStartedAt ? formatElapsed(atlasUiNow - atlasRunStartedAt) : "-";

  const atlasLastPollAt = Math.max(
    0,
    Number(atlasPollV4?.lastPollAt || 0),
    Number(atlasPollV6?.lastPollAt || 0)
  );
  const atlasLastUpdateAge = atlasLastPollAt ? formatElapsed(atlasUiNow - atlasLastPollAt) : null;


  const gpElapsed = gpRunStartedAt ? formatElapsed(gpUiNow - gpRunStartedAt) : "-";
  const gpLastUpdateAge = gpLastUpdateAt ? formatElapsed(gpUiNow - gpLastUpdateAt) : null;

  function formatAtlasPollLine(poll) {
    if (!poll || !poll.lastPollAt) return "starting…";
    const lastAgeSec = Math.max(0, (atlasUiNow - poll.lastPollAt) / 1000);
    const nextInSec = poll.nextPollAt ? Math.max(0, (poll.nextPollAt - atlasUiNow) / 1000) : null;
    const checks = poll.checks || 0;
    const last = `${lastAgeSec.toFixed(1)}s ago`;
    const next = nextInSec === null ? "next: ?" : `next in ${nextInSec.toFixed(1)}s`;
    return `checks: ${checks} · last: ${last} · ${next}`;
  }

  const toggleExpandedPath = useCallback((key, v4res, v6res) => {
    setExpandedPathKey((prev) => {
      const next = prev === key ? null : key;
      if (next === key) prefetchHopMeta(v4res, v6res);
      return next;
    });
  }, [prefetchHopMeta]);

  const pingSection = useMemo(() => {
    if (!(showPingTable && pingCompare)) return null;
    return (
      <div style={{ overflowX: "auto", marginBottom: 16 }}>
        <div style={{ margin: "0 0 8px 0" }}>
          <h3 style={{ margin: "0 0 6px 0" }}>{t("pingTitle")}</h3>
          <div style={{ opacity: 0.85 }}>
            {t("summaryBoth")}: {pingCompare.summary.both}/{pingCompare.summary.n} · {t("summaryMedianAvgV4")} {" "}
            {ms(pingCompare.summary.median_avg_v4)} · {t("summaryMedianAvgV6")} {ms(pingCompare.summary.median_avg_v6)} · {" "}
            {t("summaryMedianDelta")} {ms(pingCompare.summary.median_delta_avg)}
            <br />
            {t("summaryP95AvgV4")} {ms(pingCompare.summary.p95_avg_v4)} · {t("summaryP95AvgV6")} {ms(pingCompare.summary.p95_avg_v6)} · {" "}
            {t("summaryMedianLossV4")} {pct(pingCompare.summary.median_loss_v4)} · {t("summaryMedianLossV6")} {" "}
            {pct(pingCompare.summary.median_loss_v6)}
          </div>
          {strictCompare && (
            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
              {t("comparedOnDualStack", { both: pingCompare.summary.both, n: pingCompare.summary.n })}
            </div>
          )}
        </div>


        {pingVizRows.length >= 2 ? (
          <div style={{ margin: "10px 0 12px 0" }}>
            <VisualCompare t={t} rows={pingVizRows} defaultMetric="latency" />
          </div>
        ) : null}

<table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <SortTh table="ping" colKey="idx" label="#" sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="ping" colKey="location" label={t("location")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="ping" colKey="asn" label="ASN" sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="ping" colKey="network" label={t("network")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="ping" colKey="v4avg" label={t("v4Avg")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="ping" colKey="v4loss" label={t("v4Loss")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="ping" colKey="v6avg" label={t("v6Avg")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="ping" colKey="v6loss" label={t("v6Loss")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="ping" colKey="deltaAvg" label={t("deltaV6V4")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="ping" colKey="winner" label={t("winner")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
            </tr>
          </thead>
          <tbody>
            {pingRows.map((r, i) => {
              const excluded = strictCompare && !(Number.isFinite(r.v4avg) && Number.isFinite(r.v6avg));
              return (
                <tr key={r.key} style={excluded ? EXCLUDED_ROW_STYLE : undefined}>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{i + 1}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{formatProbeLocation(r.probe)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{renderAsnCell(r.probe?.asn, "ping", pingCompare.rows)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v4state, "IPv4")}>{ms(r.v4avg)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v4state, "IPv4")}>{pct(r.v4loss)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v6state, "IPv6")}>{ms(r.v6avg)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v6state, "IPv6")}>{pct(r.v6loss)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.deltaAvg)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{excluded ? <span style={EXCLUDED_BADGE_STYLE}>{t("excludedBadge")}</span> : null}{r.winner}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }, [showPingTable, pingCompare, pingRows, strictCompare, tableSort, toggleTableSort, renderAsnCell, t]);

  const traceroutePathsSection = useMemo(() => {
    if (!(showTracerouteTable && traceroutePaths.length > 0)) return null;
    return (
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 6px 0" }}>{t("traceroutePathsTitle")}</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                {["#", t("probe"), t("pathDiff"), t("v4Path"), t("v6Path"), ""].map((h, i) => (
                  <th key={h || `actions-${i}`} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {traceroutePaths.map((row, idx) => {
                const expKey = `tr|${row.key}`;
                const expanded = expandedPathKey === expKey;

                const sum = row?.hopDiff || {};
                const maxHop = Number(sum.maxHop || 0);
                const first = Number(sum.firstDiffHop || 0);
                const diffText =
                  maxHop > 0
                    ? first > 0
                      ? t("pathDivergeAt", { n: first })
                      : t("pathNoDivergence", { n: maxHop })
                    : "-";

                const missV4 = Number(sum.missingV4 || 0);
                const missV6 = Number(sum.missingV6 || 0);
                const showMiss = missV4 > 0 || missV6 > 0;

                return [
                  <tr key={row.key}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{idx + 1}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{formatProbeLocation(row.probe)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 700 }}>{diffText}</div>
                      {showMiss ? (
                        <div style={{ marginTop: 2, fontSize: 11, opacity: 0.8 }}>{t("pathMissingCounts", { v4: missV4, v6: missV6 })}</div>
                      ) : null}
                    </td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", wordBreak: "break-word" }}>{row.v4path}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", wordBreak: "break-word" }}>{row.v6path}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        onClick={() => toggleExpandedPath(expKey, row.v4res, row.v6res)}
                        style={{
                          padding: "4px 8px",
                          borderRadius: 10,
                          border: "1px solid #e5e7eb",
                          background: "#fff",
                          cursor: "pointer",
                          font: "inherit",
                          fontSize: 12,
                        }}
                      >
                        {expanded ? t("hideHops") : t("showHops")}
                      </button>
                    </td>
                  </tr>,
                  expanded ? (
                    <tr key={`${row.key}-details`}>
                      <td colSpan={6} style={{ padding: 10, borderBottom: "1px solid #eee" }}>
                        {renderPerHopDiff(row.v4res, row.v6res)}
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }, [showTracerouteTable, traceroutePaths, expandedPathKey, toggleExpandedPath, renderPerHopDiff, t]);


  const tracerouteSection = useMemo(() => {
    if (!(showTracerouteTable && trCompare)) return null;
    return (
      <>
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <div style={{ margin: "0 0 8px 0" }}>
            <h3 style={{ margin: "0 0 6px 0" }}>{t("tracerouteTitle")}</h3>
            <div style={{ opacity: 0.85 }}>
              {t("summaryBoth")}: {trCompare.summary.both}/{trCompare.summary.n} · {t("summaryMedianV4")} {ms(trCompare.summary.median_v4)} ·{" "}
              {t("summaryMedianV6")} {ms(trCompare.summary.median_v6)} · {t("summaryMedianDelta")} {ms(trCompare.summary.median_delta)}
              <br />
              {t("summaryP95V4")} {ms(trCompare.summary.p95_v4)} · {t("summaryP95V6")} {ms(trCompare.summary.p95_v6)}
            </div>
            {strictCompare && (
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                {t("comparedOnDualStack", { both: trCompare.summary.both, n: trCompare.summary.n })}
              </div>
            )}
          </div>


          {tracerouteVizRows.length >= 2 ? (
            <div style={{ margin: "10px 0 12px 0" }}>
              <VisualCompare t={t} rows={tracerouteVizRows} defaultMetric="latency" showSparklines />
            </div>
          ) : null}

<table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <SortTh table="traceroute" colKey="idx" label="#" sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
                <SortTh table="traceroute" colKey="location" label={t("location")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
                <SortTh table="traceroute" colKey="asn" label="ASN" sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
                <SortTh table="traceroute" colKey="network" label={t("network")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
                <SortTh table="traceroute" colKey="v4reached" label={t("v4Reached")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="traceroute" colKey="v4hops" label={t("v4Hops")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="traceroute" colKey="v4dst" label={t("v4Dst")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="traceroute" colKey="v6reached" label={t("v6Reached")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="traceroute" colKey="v6hops" label={t("v6Hops")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="traceroute" colKey="v6dst" label={t("v6Dst")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="traceroute" colKey="delta" label={t("deltaV6V4")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="traceroute" colKey="winner" label={t("winner")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              </tr>
            </thead>
            <tbody>
              {tracerouteRows.map((r, i) => {
                const excluded = strictCompare && !(Number.isFinite(r.v4dst) && Number.isFinite(r.v6dst));
                return (
                  <tr key={r.key} style={excluded ? EXCLUDED_ROW_STYLE : undefined}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{i + 1}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{formatProbeLocation(r.probe)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{renderAsnCell(r.probe?.asn, "traceroute", trCompare.rows)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>

                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4reached === null ? "-" : r.v4reached ? t("yes") : t("no")}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4hops ?? "-"}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v4state, "IPv4")}>{ms(r.v4dst)}</td>

                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v6reached === null ? "-" : r.v6reached ? t("yes") : t("no")}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v6hops ?? "-"}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v6state, "IPv6")}>{ms(r.v6dst)}</td>

                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.delta)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{excluded ? <span style={EXCLUDED_BADGE_STYLE}>{t("excludedBadge")}</span> : null}{r.winner}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {traceroutePathsSection}
      </>
    );
  }, [showTracerouteTable, trCompare, tracerouteRows, strictCompare, tableSort, toggleTableSort, renderAsnCell, t, traceroutePathsSection]);

  const mtrPathsSection = useMemo(() => {
    if (!(showMtrTable && mtrPaths.length > 0)) return null;
    return (
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 6px 0" }}>{t("mtrPathsTitle")}</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                {["#", t("probe"), t("pathDiff"), t("v4Path"), t("v6Path"), ""].map((h, i) => (
                  <th key={h || `actions-${i}`} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mtrPaths.map((row, idx) => {
                const expKey = `mtr|${row.key}`;
                const expanded = expandedPathKey === expKey;

                const sum = row?.hopDiff || {};
                const maxHop = Number(sum.maxHop || 0);
                const first = Number(sum.firstDiffHop || 0);
                const diffText =
                  maxHop > 0
                    ? first > 0
                      ? t("pathDivergeAt", { n: first })
                      : t("pathNoDivergence", { n: maxHop })
                    : "-";

                const missV4 = Number(sum.missingV4 || 0);
                const missV6 = Number(sum.missingV6 || 0);
                const showMiss = missV4 > 0 || missV6 > 0;

                return [
                  <tr key={row.key}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{idx + 1}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{formatProbeLocation(row.probe)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 700 }}>{diffText}</div>
                      {showMiss ? (
                        <div style={{ marginTop: 2, fontSize: 11, opacity: 0.8 }}>{t("pathMissingCounts", { v4: missV4, v6: missV6 })}</div>
                      ) : null}
                    </td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", wordBreak: "break-word" }}>{row.v4path}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", wordBreak: "break-word" }}>{row.v6path}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        onClick={() => toggleExpandedPath(expKey, row.v4res, row.v6res)}
                        style={{
                          padding: "4px 8px",
                          borderRadius: 10,
                          border: "1px solid #e5e7eb",
                          background: "#fff",
                          cursor: "pointer",
                          font: "inherit",
                          fontSize: 12,
                        }}
                      >
                        {expanded ? t("hideHops") : t("showHops")}
                      </button>
                    </td>
                  </tr>,
                  expanded ? (
                    <tr key={`${row.key}-details`}>
                      <td colSpan={6} style={{ padding: 10, borderBottom: "1px solid #eee" }}>
                        {renderPerHopDiff(row.v4res, row.v6res)}
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }, [showMtrTable, mtrPaths, expandedPathKey, toggleExpandedPath, renderPerHopDiff, t]);


  const mtrSection = useMemo(() => {
    if (!(showMtrTable && mtrCompare)) return null;
    return (
      <>
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <div style={{ margin: "0 0 8px 0" }}>
            <h3 style={{ margin: "0 0 6px 0" }}>{t("mtrTitle")}</h3>
            <div style={{ opacity: 0.85 }}>
              {t("summaryBoth")}: {mtrCompare.summary.both}/{mtrCompare.summary.n} · {t("summaryMedianAvgV4")} {" "}
              {ms(mtrCompare.summary.median_avg_v4)} · {t("summaryMedianAvgV6")} {ms(mtrCompare.summary.median_avg_v6)} · {" "}
              {t("summaryMedianDelta")} {ms(mtrCompare.summary.median_delta_avg)}
              <br />
              {t("summaryMedianLossV4")} {pct(mtrCompare.summary.median_loss_v4)} · {t("summaryMedianLossV6")} {" "}
              {pct(mtrCompare.summary.median_loss_v6)} · {t("summaryDeltaLoss")} {pct(mtrCompare.summary.median_delta_loss)}
            </div>
            {strictCompare && (
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                {t("comparedOnDualStack", { both: mtrCompare.summary.both, n: mtrCompare.summary.n })}
              </div>
            )}
          </div>


          {mtrVizRows.length >= 2 ? (
            <div style={{ margin: "10px 0 12px 0" }}>
              <VisualCompare t={t} rows={mtrVizRows} defaultMetric="latency" />
            </div>
          ) : null}

<table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <SortTh table="mtr" colKey="idx" label="#" sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
                <SortTh table="mtr" colKey="location" label={t("location")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
                <SortTh table="mtr" colKey="asn" label="ASN" sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
                <SortTh table="mtr" colKey="network" label={t("network")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
                <SortTh table="mtr" colKey="v4reached" label={t("v4Reached")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="mtr" colKey="v4hops" label={t("v4Hops")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="mtr" colKey="v4loss" label={t("v4Loss")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="mtr" colKey="v4avg" label={t("v4Avg")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="mtr" colKey="v6reached" label={t("v6Reached")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="mtr" colKey="v6hops" label={t("v6Hops")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="mtr" colKey="v6loss" label={t("v6Loss")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="mtr" colKey="v6avg" label={t("v6Avg")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="mtr" colKey="deltaAvg" label={t("deltaAvg")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="mtr" colKey="deltaLoss" label={t("deltaLoss")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
                <SortTh table="mtr" colKey="winner" label={t("winner")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              </tr>
            </thead>
            <tbody>
              {mtrRows.map((r, i) => {
                const excluded = strictCompare && !(Number.isFinite(r.v4avg) && Number.isFinite(r.v6avg));
                return (
                  <tr key={r.key} style={excluded ? EXCLUDED_ROW_STYLE : undefined}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{i + 1}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{formatProbeLocation(r.probe)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{renderAsnCell(r.probe?.asn, "mtr", mtrCompare.rows)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>

                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4reached === null ? "-" : r.v4reached ? t("yes") : t("no")}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4hops ?? "-"}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v4state, "IPv4")}>{pct(r.v4loss)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v4state, "IPv4")}>{ms(r.v4avg)}</td>

                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v6reached === null ? "-" : r.v6reached ? t("yes") : t("no")}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v6hops ?? "-"}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v6state, "IPv6")}>{pct(r.v6loss)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v6state, "IPv6")}>{ms(r.v6avg)}</td>

                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.deltaAvg)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{pct(r.deltaLoss)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{excluded ? <span style={EXCLUDED_BADGE_STYLE}>{t("excludedBadge")}</span> : null}{r.winner}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {mtrPathsSection}
      </>
    );
  }, [showMtrTable, mtrCompare, mtrRows, strictCompare, tableSort, toggleTableSort, renderAsnCell, t, mtrPathsSection]);

  const dnsSection = useMemo(() => {
    if (!(showDnsTable && dnsCompare)) return null;
    return (
      <div style={{ overflowX: "auto", marginBottom: 16 }}>
        <div style={{ margin: "0 0 8px 0" }}>
          <h3 style={{ margin: "0 0 6px 0" }}>{t("dnsTitle")}</h3>
          <div style={{ opacity: 0.85 }}>
            {t("summaryBoth")}: {dnsCompare.summary.both}/{dnsCompare.summary.n} · {t("summaryMedianV4")} {ms(dnsCompare.summary.median_v4)} ·{" "}
            {t("summaryMedianV6")} {ms(dnsCompare.summary.median_v6)} · {t("summaryMedianDelta")} {ms(dnsCompare.summary.median_delta)}
            <br />
            {t("summaryP95V4")} {ms(dnsCompare.summary.p95_v4)} · {t("summaryP95V6")} {ms(dnsCompare.summary.p95_v6)}
          </div>
          {strictCompare && (
            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
              {t("comparedOnDualStack", { both: dnsCompare.summary.both, n: dnsCompare.summary.n })}
            </div>
          )}
        </div>


        {dnsVizRows.length >= 2 ? (
          <div style={{ margin: "10px 0 12px 0" }}>
            <VisualCompare t={t} rows={dnsVizRows} defaultMetric="latency" />
          </div>
        ) : null}

<table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <SortTh table="dns" colKey="idx" label="#" sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="dns" colKey="location" label={t("location")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="dns" colKey="asn" label="ASN" sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="dns" colKey="network" label={t("network")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="dns" colKey="v4ms" label={t("v4Total")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="dns" colKey="v6ms" label={t("v6Total")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="dns" colKey="delta" label={t("deltaV6V4")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="dns" colKey="ratio" label={t("ratio")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="dns" colKey="winner" label={t("winner")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
            </tr>
          </thead>
          <tbody>
            {dnsRows.map((r, i) => {
              const excluded = strictCompare && !(Number.isFinite(r.v4ms) && Number.isFinite(r.v6ms));
              return (
                <tr key={r.key} style={excluded ? EXCLUDED_ROW_STYLE : undefined}>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{i + 1}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{formatProbeLocation(r.probe)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{renderAsnCell(r.probe?.asn, "dns", dnsCompare.rows)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v4state, "IPv4")}>{ms(r.v4ms)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v6state, "IPv6")}>{ms(r.v6ms)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.delta)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{Number.isFinite(r.ratio) ? r.ratio.toFixed(2) : "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{excluded ? <span style={EXCLUDED_BADGE_STYLE}>{t("excludedBadge")}</span> : null}{r.winner}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }, [showDnsTable, dnsCompare, dnsRows, strictCompare, tableSort, toggleTableSort, renderAsnCell, t]);

  const httpSection = useMemo(() => {
    if (!(showHttpTable && httpCompare)) return null;
    return (
      <div style={{ overflowX: "auto", marginBottom: 16 }}>
        <div style={{ margin: "0 0 8px 0" }}>
          <h3 style={{ margin: "0 0 6px 0" }}>{t("httpTitle")}</h3>
          <div style={{ opacity: 0.85 }}>
            {t("summaryBoth")}: {httpCompare.summary.both}/{httpCompare.summary.n} · {t("summaryMedianV4")} {ms(httpCompare.summary.median_v4)} ·{" "}
            {t("summaryMedianV6")} {ms(httpCompare.summary.median_v6)} · {t("summaryMedianDelta")} {ms(httpCompare.summary.median_delta)}
            <br />
            {t("summaryP95V4")} {ms(httpCompare.summary.p95_v4)} · {t("summaryP95V6")} {ms(httpCompare.summary.p95_v6)}
          </div>
          {strictCompare && (
            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
              {t("comparedOnDualStack", { both: httpCompare.summary.both, n: httpCompare.summary.n })}
            </div>
          )}
        </div>


        {httpVizRows.length >= 2 ? (
          <div style={{ margin: "10px 0 12px 0" }}>
            <VisualCompare t={t} rows={httpVizRows} defaultMetric="latency" />
          </div>
        ) : null}

<table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <SortTh table="http" colKey="idx" label="#" sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="http" colKey="location" label={t("location")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="http" colKey="asn" label="ASN" sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="http" colKey="network" label={t("network")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="http" colKey="v4sc" label={t("v4Status")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="http" colKey="v6sc" label={t("v6Status")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
              <SortTh table="http" colKey="v4ms" label={t("v4Total")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="http" colKey="v6ms" label={t("v6Total")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="http" colKey="delta" label={t("deltaV6V4")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="http" colKey="ratio" label={t("ratio")} sort={tableSort} onToggle={toggleTableSort} defaultDir="desc" />
              <SortTh table="http" colKey="winner" label={t("winner")} sort={tableSort} onToggle={toggleTableSort} defaultDir="asc" />
            </tr>
          </thead>
          <tbody>
            {httpRows.map((r, i) => {
              const excluded = strictCompare && !(Number.isFinite(r.v4ms) && Number.isFinite(r.v6ms));
              return (
                <tr key={r.key} style={excluded ? EXCLUDED_ROW_STYLE : undefined}>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{i + 1}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{formatProbeLocation(r.probe)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{renderAsnCell(r.probe?.asn, "http", httpCompare.rows)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v4state, "IPv4")}>{r.v4sc ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v6state, "IPv6")}>{r.v6sc ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v4state, "IPv4")}>{ms(r.v4ms)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }} title={stateTitle(r.v6state, "IPv6")}>{ms(r.v6ms)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.delta)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{Number.isFinite(r.ratio) ? r.ratio.toFixed(2) : "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{excluded ? <span style={EXCLUDED_BADGE_STYLE}>{t("excludedBadge")}</span> : null}{r.winner}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }, [showHttpTable, httpCompare, httpRows, strictCompare, tableSort, toggleTableSort, renderAsnCell, t]);

  async function copyAsnToClipboard(asn) {
    try {
      await navigator.clipboard?.writeText(String(asn));
    } catch {
      // ignore
    }
  }

  return (
    <div style={{ fontFamily: "ui-monospace, Menlo, monospace", padding: 16, maxWidth: 1100, margin: "0 auto", minHeight: "100vh", display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
      <style>{TOOLTIP_CSS}</style>
      <style>{ATLAS_PROGRESS_CSS}</style>
<div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
  <a href="https://ping6.it" style={{ display: "inline-flex", alignItems: "baseline", gap: "10px", textDecoration: "none", color: "inherit" }}>
    <img src="/logo-badge.svg" alt="Ping6" width="28" height="28" />
    <span style={{ fontSize: 18, fontWeight: 700 }}>ping6.it</span>
  </a>
 {" · "}
  <span style={{ fontSize: 14, opacity: 0.85 }}>
    {t("tagline")}
  </span>
</div>
<div style={{ marginTop: 8, marginBottom: 16, fontSize: 14, opacity: 0.85, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
  <a href="mailto:antonio@prado.it?subject=Ping6%20feedback" style={{ textDecoration: "underline" }}>
    {t("feedback")}
  </a>
  <span aria-hidden="true">·</span>
  <a
    href="https://github.com/Antonio-Prado/ping6-it#readme"
    target="_blank"
    rel="noopener noreferrer"
    style={{ textDecoration: "underline" }}
  >
    {t("docs")}
  </a>
  <span aria-hidden="true">·</span>
  <a href={sourceUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
    {t("source")}{shortSha ? ` @ ${shortSha}` : ""}
  </a>
  <span aria-hidden="true">·</span>
  <a href={agplUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
    AGPL
  </a>
  <span aria-hidden="true">·</span>
  <a href={ccUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
    CC BY-NC
  </a>
</div>


      {!reportMode && (
      <>
      {/* Globalping controls */}
      <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {t("backend")} <Help text={t("helpBackend")} />{" "}
          <select
            value={backend}
            onChange={(e) => {
              const next = e.target.value;
              setBackend(next);
              if (next === "atlas" && (cmd === "mtr" || cmd === "http")) {
                setCmd("ping");
                setAdvanced(false);
              }
            }}
            disabled={running}
            style={{ padding: 6 }}
          >
            <option value="globalping">{t("backendGlobalping")}</option>
            <option value="atlas">{t("backendAtlas")}</option>
          </select>
        </label>

        {backend === "atlas" && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {t("atlasApiKey")} <Help text={t("helpAtlasKey")} />{" "}
            <input
              value={atlasApiKey}
              onChange={(e) => setAtlasApiKey(e.target.value)}
              disabled={running}
              type="password"
              placeholder="e.g. 0123456789abcdef..."
              style={{ padding: 6, width: 220 }}
            />
          </label>
        )}

        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {t("command")} <Help text={t("helpCommand")} />{" "}
          <select
            value={cmd}
            onChange={(e) => {
              setCmd(e.target.value);
              setAdvanced(false);
            }}
            disabled={running}
            style={{ padding: 6 }}
          >
            <option value="ping">ping</option>
            <option value="traceroute">traceroute</option>
            <option value="mtr" disabled={backend === "atlas"}>mtr</option>
            <option value="dns">dns</option>
            <option value="http" disabled={backend === "atlas"}>http</option>
          </select>
        </label>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {t("net")} <Help text={t("helpNet")} />{" "}
          <select value={gpTag} onChange={(e) => setGpTag(e.target.value)} disabled={running || backend === "atlas"} style={{ padding: 6 }}>
            <option value="any">any</option>
            <option value="eyeball">eyeball</option>
            <option value="datacenter">datacenter</option>
          </select>
        </label>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {t("from")} <Help text={t("helpFrom")} />{" "}
          <input value={from} onChange={(e) => setFrom(e.target.value)} disabled={running} style={{ padding: 6, width: 220 }} />
        </label>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {t("probes")} <Help text={t("helpProbes")} />{" "}
          <input
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            onBlur={() => setLimit((current) => clampInputValue(current, { min: 1, max: maxProbes, fallback: 3 }))}
            disabled={running}
            type="number"
            min={1}
            max={maxProbes}
            step={1}
            inputMode="numeric"
            placeholder={t("placeholderProbes")}
            style={{ padding: 6, width: 70 }}
          />
        </label>

        {advanced && (
          <>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("asn")} <Help text={t("helpAsn")} />{" "}
              <input
                value={probeAsn}
                onChange={(e) => setProbeAsn(e.target.value)}
                disabled={running}
                placeholder={t("placeholderAsn")}
                style={{ padding: 6, width: 110 }}
              />
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("isp")} <Help text={t("helpIsp")} />{" "}
              <input
                value={probeIsp}
                onChange={(e) => setProbeIsp(e.target.value)}
                disabled={running || backend === "atlas"}
                placeholder={t("placeholderIsp")}
                style={{ padding: 6, width: 140 }}
              />
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("deltaAlert")} <Help text={t("helpDeltaAlert")} />{" "}
              <input
                value={deltaThreshold}
                onChange={(e) => setDeltaThreshold(e.target.value)}
                disabled={running}
                placeholder={t("placeholderDeltaAlert")}
                style={{ padding: 6, width: 100 }}
              />
            </label>

            <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={excludeUnstableProbes}
                    onChange={(e) => setExcludeUnstableProbes(e.target.checked)}
                    disabled={running}
                  />
                  {t("excludeUnstableProbes")}
                </label>
                <Help text={t("helpExcludeUnstableProbes")} />
              </div>
              {unstableProbeKeys.size ? (
                <span style={{ fontSize: 12, opacity: 0.75 }}>{t("unstableProbesDetected", { n: unstableProbeKeys.size })}</span>
              ) : null}
            </div>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("probeBlacklist")} <Help text={t("helpProbeBlacklist")} />{" "}
              <input
                value={probeBlacklist}
                onChange={(e) => setProbeBlacklist(e.target.value)}
                disabled={running}
                placeholder={t("placeholderProbeBlacklist")}
                style={{ padding: 6, width: 220 }}
              />
            </label>

          </>
        )}

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={requireV6Capable}
                onChange={(e) => setRequireV6Capable(e.target.checked)}
                disabled={running || !canRequireV6Capable}
              />
              {t("ipv6Only")}
            </label>
            <Help text={t("helpIpv6Only")} />
          </div>

          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={multiTargetMode}
                onChange={(e) => {
                  const next = e.target.checked;
                  setMultiTargetMode(next);
                  if (next && !multiTargetInput.trim()) {
                    setMultiTargetInput(target.trim());
                  }
                  if (!next) {
                    const firstTarget = parseMultiTargets(multiTargetInput)[0];
                    if (firstTarget) setTarget(firstTarget);
                  }
                  if (!next) {
                    setMultiRunResults([]);
                    setMultiActiveId(null);
                    setMultiRunStatus(null);
                  }
                }}
                disabled={running}
              />
              {t("multiTarget")}
            </label>
            <Help text={t("helpMultiTarget")} />
          </div>
        </div>


        {advanced && (cmd === "ping" || cmd === "mtr") && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {cmd === "mtr" ? t("packetsHop") : t("packets")} <Help text={t("helpPackets")} />{" "}
            <input
              value={packets}
              onChange={(e) => setPackets(e.target.value)}
              onBlur={() =>
                setPackets((current) =>
                  clampInputValue(current, { min: 1, max: cmd === "mtr" ? 16 : 10, fallback: 3 })
                )
              }
              disabled={running}
              type="number"
              min={1}
              max={cmd === "mtr" ? 16 : 10}
              step={1}
              inputMode="numeric"
              placeholder={cmd === "mtr" ? "1-16" : t("placeholderProbes")}
              style={{ padding: 6, width: 70 }}
            />
          </label>
        )}

        {(cmd === "traceroute" || cmd === "mtr") && (
          <>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("proto")} <Help text={t("helpProto")} />{" "}
              <select value={trProto} onChange={(e) => setTrProto(e.target.value)} disabled={running} style={{ padding: 6 }}>
                <option value="ICMP">ICMP</option>
                <option value="UDP">UDP</option>
                <option value="TCP">TCP</option>
              </select>
            </label>

            {advanced && ((cmd === "traceroute" && trProto === "TCP") || (cmd === "mtr" && trProto !== "ICMP")) && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {t("port")} <Help text={t("helpPort")} />{" "}
                <input
                  value={trPort}
                  onChange={(e) => setTrPort(e.target.value)}
                  onBlur={() =>
                    setTrPort((current) => clampInputValue(current, { min: 1, max: 65535, allowEmpty: true }))
                  }
                  disabled={running}
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  inputMode="numeric"
                  placeholder={t("placeholderPort")}
                  style={{ padding: 6, width: 90 }}
                />
              </label>
            )}
          </>
        )}

        {cmd === "dns" && (
          <>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("query")} <Help text={t("helpDnsQuery")} />{" "}
              <select value={dnsQuery} onChange={(e) => setDnsQuery(e.target.value)} disabled={running} style={{ padding: 6 }}>
                {["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "PTR", "SRV", "CAA", "ANY"].map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </label>

            {advanced && (
              <>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {t("proto")} <Help text={t("helpDnsProto")} />{" "}
                  <select value={dnsProto} onChange={(e) => setDnsProto(e.target.value)} disabled={running} style={{ padding: 6 }}>
                    <option value="UDP">UDP</option>
                    <option value="TCP">TCP</option>
                  </select>
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {t("port")} <Help text={t("helpDnsPort")} />{" "}
                  <input
                    value={dnsPort}
                    onChange={(e) => setDnsPort(e.target.value)}
                    onBlur={() =>
                      setDnsPort((current) => clampInputValue(current, { min: 1, max: 65535, allowEmpty: true }))
                    }
                    disabled={running}
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    inputMode="numeric"
                    placeholder={t("placeholderPort")}
                    style={{ padding: 6, width: 70 }}
                  />
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {t("resolver")} <Help text={t("helpDnsResolver")} />{" "}
                  <input
                    value={dnsResolver}
                    onChange={(e) => setDnsResolver(e.target.value)}
                    disabled={running}
                    placeholder={t("placeholderResolver")}
                    style={{ padding: 6, width: 220 }}
                  />
                </label>

                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={dnsTrace} onChange={(e) => setDnsTrace(e.target.checked)} disabled={running} />
                    {t("trace")}
                  </label>
                  <Help text={t("helpDnsTrace")} />
                </div>
              </>
            )}
          </>
        )}
        {cmd === "http" && (
          <>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("method")} <Help text={t("helpHttpMethod")} />{" "}
              <select value={httpMethod} onChange={(e) => setHttpMethod(e.target.value)} disabled={running} style={{ padding: 6 }}>
                {["GET", "HEAD", "OPTIONS"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("proto")} <Help text={t("helpHttpProto")} />{" "}
              <select value={httpProto} onChange={(e) => setHttpProto(e.target.value)} disabled={running} style={{ padding: 6 }}>
                <option value="HTTP">HTTP</option>
                <option value="HTTPS">HTTPS</option>
                <option value="HTTP2">HTTP2</option>
              </select>
            </label>

            {advanced && (
              <>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {t("path")} <Help text={t("helpHttpPath")} />{" "}
                  <input value={httpPath} onChange={(e) => setHttpPath(e.target.value)} disabled={running} style={{ padding: 6, width: 180 }} />
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {t("queryString")} <Help text={t("helpHttpQuery")} />{" "}
                  <input
                    value={httpQuery}
                    onChange={(e) => setHttpQuery(e.target.value)}
                    disabled={running}
                    placeholder={t("placeholderOptional")}
                    style={{ padding: 6, width: 160 }}
                  />
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {t("port")} <Help text={t("helpHttpPort")} />{" "}
                  <input
                    value={httpPort}
                    onChange={(e) => setHttpPort(e.target.value)}
                    onBlur={() =>
                      setHttpPort((current) => clampInputValue(current, { min: 1, max: 65535, allowEmpty: true }))
                    }
                    disabled={running}
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    inputMode="numeric"
                    placeholder={t("placeholderPort")}
                    style={{ padding: 6, width: 90 }}
                  />
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {t("resolver")} <Help text={t("helpHttpResolver")} />{" "}
                  <input
                    value={httpResolver}
                    onChange={(e) => setHttpResolver(e.target.value)}
                    disabled={running}
                    placeholder={t("placeholderResolver")}
                    style={{ padding: 6, width: 220 }}
                  />
                </label>
              </>
            )}
          </>
        )}

        </div>


        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {multiTargetMode ? (
          <Tip text={t("tipMultiTargetInput")}>
            <textarea
              value={multiTargetInput}
              onChange={(e) => setMultiTargetInput(e.target.value)}
              aria-label={t("multiTarget")}
              placeholder={
                cmd === "dns"
                  ? t("placeholderMultiDns")
                  : cmd === "http"
                    ? t("placeholderMultiHttp")
                    : t("placeholderMultiDefault")
              }
              rows={3}
              style={{ padding: 8, minWidth: 260, flex: "1 1 340px", resize: "vertical" }}
              disabled={running}
            />
          </Tip>
        ) : (
          <Tip text={t("tipTargetInput")}>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-label={t("target")}
              placeholder={
                cmd === "dns" ? t("placeholderTargetDns") : cmd === "http" ? t("placeholderTargetHttp") : t("placeholderTargetDefault")
              }
              style={{ padding: 8, minWidth: 260, flex: "1 1 340px" }}
              disabled={running}
            />
          </Tip>
        )}

        <Tip text={t("tipRun")}>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              run();
            }}
            disabled={running || rateLimitLeft > 0}
            style={{ padding: "8px 12px" }}
          >
            {t("run")}
          </button>
        </Tip>
        <Tip text={t("tipCancel")}>
          <button type="button" onClick={cancel} disabled={!running} style={{ padding: "8px 12px" }}>
            {t("cancel")}
          </button>
        </Tip>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Tip text={t("tipAdvanced")}>
          <button onClick={() => setAdvanced((s) => !s)} disabled={running} style={{ padding: "8px 12px" }}>
            {advanced ? t("basic") : t("advanced")}
          </button>
        </Tip>
        <Tip text={t("tipRaw")}>
          <button
            onClick={() => setShowRaw((s) => !s)}
            disabled={!v4 || !v6}
            style={{ padding: "8px 12px" }}
          >
            {showRaw ? t("hideRaw") : t("raw")}
          </button>
        </Tip>
        <Tip text={t("tipExportJson")}>
          <button onClick={downloadJson} disabled={!v4 || !v6} style={{ padding: "8px 12px" }}>
            {t("exportJson")}
          </button>
        </Tip>
        <Tip text={t("tipExportCsv")}>
          <button onClick={downloadCsv} disabled={!v4 || !v6} style={{ padding: "8px 12px" }}>
            {t("exportCsv")}
          </button>
        </Tip>
        <Tip text={t("tipShareLink")}>
          <button
            onClick={() => {
              const nextUrl = updateShareLink();
              copyToClipboard(nextUrl);
            }}
            disabled={running}
            style={{ padding: "8px 12px" }}
          >
            {t("shareLink")}
          </button>
        </Tip>
        <Tip text={t("tipReportMode")}>
          <button onClick={enterReportMode} disabled={!v4 || !v6 || reportBusy} style={{ padding: "8px 12px" }}>
            {t("reportMode")}
          </button>
        </Tip>
        </div>

        {showRetryControls && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", width: "100%", fontSize: 12, opacity: 0.9 }}>
            <span>{t("retryNotice", { v4: Number(familyIssues?.badV4) || 0, v6: Number(familyIssues?.badV6) || 0 })}</span>
            {canRetryV4 && (
              <Tip text={t("tipRetryIpv4")}>
                <button onClick={() => retryFailedFamily(4)} disabled={running || rateLimitLeft > 0} style={{ padding: "6px 10px" }}>
                  {t("retryIpv4")}
                </button>
              </Tip>
            )}
            {canRetryV6 && (
              <Tip text={t("tipRetryIpv6")}>
                <button onClick={() => retryFailedFamily(6)} disabled={running || rateLimitLeft > 0} style={{ padding: "6px 10px" }}>
                  {t("retryIpv6")}
                </button>
              </Tip>
            )}
          </div>
        )}
        {shareUrl && (
          <div style={{ fontSize: 12, opacity: 0.8, width: "100%" }} role="status" aria-live="polite">
            {t("linkReady")} <a href={shareUrl}>{shareUrl}</a>
          </div>
        )}
        {turnstileStatus && (
          <div style={{ fontSize: 12, opacity: 0.8, width: "100%" }} aria-live="polite">
            {turnstileStatus}
          </div>
        )}

        {runWarnings.length > 0 && (
          <div
            style={{
              fontSize: 12,
              opacity: 0.9,
              width: "100%",
              border: "1px solid rgba(17,24,39,.12)",
              borderRadius: 10,
              padding: 10,
              background: "rgba(17,24,39,.02)",
            }}
            role="note"
          >
            <div style={{ fontWeight: 700, fontSize: 13 }}>{backend === "atlas" ? "RIPE Atlas notes" : "Globalping notes"}</div>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 4 }}>
              {runWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {backend === "atlas" && running && (
          <div
            style={{
              fontSize: 12,
              opacity: 0.85,
              width: "100%",
              border: "1px solid rgba(17,24,39,.12)",
              borderRadius: 10,
              padding: 10,
              background: "rgba(17,24,39,.03)",
            }}
            role="status"
            aria-live="polite"
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                <span className="p6-dots" aria-hidden="true"><span /><span /><span /></span>
                <span>
                  {retryingFamily
                    ? `RIPE Atlas: retrying ${retryingFamily === "v4" ? "IPv4" : "IPv6"}…`
                    : "RIPE Atlas: measurement in progress…"}
                </span>
              </div>
              <div className="p6-spin" aria-hidden="true" />
            </div>

            <div style={{ marginTop: 8 }} className="p6-indet" aria-hidden="true" />

            <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              <div>
                IPv4: {v4?.statusName || v4?.status || "waiting"} · {(v4?.results || []).length}/
                {v4?.atlas?.measurement?.probes_scheduled || v4?.atlas?.measurement?.probes_requested || limit}
                <div style={{ marginTop: 2, fontSize: 11, opacity: 0.75 }}>{formatAtlasPollLine(atlasPollV4)}</div>
              </div>
              <div>
                IPv6: {v6?.statusName || v6?.status || "waiting"} · {(v6?.results || []).length}/
                {v6?.atlas?.measurement?.probes_scheduled || v6?.atlas?.measurement?.probes_requested || limit}
                <div style={{ marginTop: 2, fontSize: 11, opacity: 0.75 }}>{formatAtlasPollLine(atlasPollV6)}</div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, opacity: 0.75, marginTop: 2, fontSize: 11 }}>
                <span>Elapsed: {atlasElapsed}</span>
                {atlasLastUpdateAge && <span>Last update: {atlasLastUpdateAge} ago</span>}
                {!atlasLastUpdateAge && <span>Waiting for the first update…</span>}
                {((v4?.results || []).length + (v6?.results || []).length) === 0 && (
                  <span>Waiting for the first probe response…</span>
                )}
              </div>
              <div style={{ opacity: 0.75, marginTop: 2, fontSize: 11 }}>
                Results can take 10–60 seconds on RIPE Atlas. They will stream in as probes report back.
              </div>
            </div>
          </div>
        )}
        {backend !== "atlas" && running && (
          <div
            style={{
              fontSize: 12,
              opacity: 0.85,
              width: "100%",
              border: "1px solid rgba(17,24,39,.12)",
              borderRadius: 10,
              padding: 10,
              background: "rgba(17,24,39,.03)",
            }}
            role="status"
            aria-live="polite"
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                <span className="p6-dots" aria-hidden="true"><span /><span /><span /></span>
                <span>
                  {retryingFamily
                    ? `Globalping: retrying ${retryingFamily === "v4" ? "IPv4" : "IPv6"}…`
                    : "Globalping: measurement in progress…"}
                </span>
              </div>
              <div className="p6-spin" aria-hidden="true" />
            </div>

            <div style={{ marginTop: 8 }} className="p6-indet" aria-hidden="true" />

            <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              <div>
                IPv4: {v4?.statusName || v4?.status || "waiting"} · {(v4?.results || []).length}/{limit}
              </div>
              <div>
                IPv6: {v6?.statusName || v6?.status || "waiting"} · {(v6?.results || []).length}/{limit}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, opacity: 0.75, marginTop: 2, fontSize: 11 }}>
                <span>Elapsed: {gpElapsed}</span>
                {gpLastUpdateAge && <span>Last update: {gpLastUpdateAge} ago</span>}
                {!gpLastUpdateAge && <span>Waiting for the first update…</span>}
              </div>
              <div style={{ opacity: 0.75, marginTop: 2, fontSize: 11 }}>
                Results typically appear within a few seconds. They will stream in as probes report back.
              </div>
            </div>
          </div>
        )}
        {err && (
          <div
            style={{ background: "#fee", color: "#111", border: "1px solid #f99", padding: 12, width: "100%", whiteSpace: "pre-wrap" }}
            aria-live="polite"
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <div style={{ fontWeight: 700 }}>{t("errorTitle")}</div>
              <button type="button" onClick={() => copyToClipboard(err)} style={{ padding: "6px 10px" }}>
                {t("copy")}
              </button>
            </div>
            {rateLimitLeft > 0 && (
              <div style={{ marginTop: 6, opacity: 0.85 }}>{t("rateLimitRetryIn", { seconds: rateLimitLeft })}</div>
            )}
            <div style={{ marginTop: 8 }}>{err}</div>
          </div>
        )}
        <div style={{ display: showTurnstile ? "block" : "none", width: "100%" }}>
          <div style={{ marginTop: 6 }}>
            <div ref={turnstileContainerRef} />
          </div>
        </div>

      </div>

      <div aria-hidden="true" style={{ height: 1, background: "rgba(17,24,39,.12)", width: "100%", margin: "6px 0 12px" }} />


      {/* quick presets: macro regions + sub-regions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        {GEO_PRESETS.map((p) => (
          <Tip key={p.id} text={t("tipPreset", { label: p.label })}>
            <button
              onClick={() => selectMacro(p.id)}
              disabled={running}
              style={{
                padding: "6px 10px",
                fontWeight: p.id === macroId ? 700 : 400,
                border: p.id === macroId ? "1px solid #111" : "1px solid #ddd",
                borderRadius: 6,
                background: "transparent",
                cursor: running ? "not-allowed" : "pointer",
              }}
            >
              {p.label}
            </button>
          </Tip>
        ))}

        {subPresets.length > 0 && (
          <Tip text={t("tipSubPreset")}>
            <select
              value={subId}
              onChange={(e) => selectSub(e.target.value)}
              disabled={running}
              style={{ padding: 6 }}
            >
              <option value="">{t("all")} {macroPreset.label}</option>
              {subPresets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Tip>
        )}
      </div>
      </>
      )}

      {!reportMode && multiTargetMode && (multiRunResults.length > 0 || multiRunStatus) && (
        <div style={{ marginBottom: 16, padding: 12, border: "1px solid #e5e7eb", borderRadius: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700 }}>{t("multiTargetResults")}</div>
              {multiRunStatus && (
                <div style={{ fontSize: 13, opacity: 0.8 }} role="status" aria-live="polite">
                  {t("runningWithTarget", {
                    current: multiRunStatus.current,
                    total: multiRunStatus.total,
                    target: multiRunStatus.target,
                  })}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Tip text={t("tipReportAll")}>
                <button onClick={enterMultiReportMode} disabled={!multiRunResults.length || reportBusy} style={{ padding: "6px 10px" }}>
                  {t("reportAll")}
                </button>
              </Tip>
              <Tip text={t("tipExportAllJson")}>
                <button onClick={downloadMultiJson} disabled={!multiRunResults.length} style={{ padding: "6px 10px" }}>
                  {t("exportAllJson")}
                </button>
              </Tip>
              <Tip text={t("tipIncludeRaw")}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, opacity: 0.85 }}>
                  <input
                    type="checkbox"
                    checked={multiExportIncludeRaw}
                    onChange={(e) => setMultiExportIncludeRaw(e.target.checked)}
                    disabled={!multiRunResults.length}
                  />
                  {t("includeRaw")}
                </label>
              </Tip>
              <Tip text={t("tipExportAllCsvSummary")}>
                <button onClick={downloadMultiCsvSummary} disabled={!multiRunResults.length} style={{ padding: "6px 10px" }}>
                  {t("exportAllCsvSummary")}
                </button>
              </Tip>
              <Tip text={t("tipExportAllCsvRows")}>
                <button onClick={downloadMultiCsvRows} disabled={!multiRunResults.length} style={{ padding: "6px 10px" }}>
                  {t("exportAllCsvRows")}
                </button>
              </Tip>
            </div>
          </div>
          <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>
            {multiRunStatus
              ? t("progress", { done: multiRunResults.length, total: multiRunStatus.total })
              : t("completedTargets", { done: multiRunResults.length })}
          </div>
          <div style={{ fontSize: 13, opacity: 0.75, marginTop: 2 }}>{t("clickTargetToLoad")}</div>
          <MultiRunResultsList items={multiRunResults} activeId={multiActiveId} onSelect={handleSelectMultiEntry} t={t} />
        </div>
      )}

      {!reportMode && (
      <div style={{ marginBottom: 16, padding: 12, border: "1px solid #e5e7eb", borderRadius: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700 }}>{t("historyTitle")}</div>
          <button
            onClick={() => {
              setHistory([]);
              setHistoryCompareA("");
              setHistoryCompareB("");
            }}
            disabled={!history.length}
            style={{ padding: "6px 10px" }}
          >
            {t("clear")}
          </button>
        </div>
        <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>{t("historyNote")}</div>

        {history.length ? (
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            {history.map((entry) => (
              <div key={entry.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <strong>{new Date(entry.ts).toLocaleString(dateLocale)}</strong>
                  <span style={{ opacity: 0.8 }}>
                    {entry.cmd} · {entry.target}
                  </span>
                </div>
                <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
                  {t("from")} {entry.from} · {t("probes").toLowerCase()} {entry.limit} · {t("net").toLowerCase()} {entry.gpTag}
                  {entry.filters && (entry.filters.asn || entry.filters.isp || entry.filters.deltaThreshold) && (
                    <>
                      {" · "}{t("filters")} {entry.filters.asn ? `ASN ${entry.filters.asn}` : ""}
                      {entry.filters.isp ? `${entry.filters.asn ? ", " : ""}ISP ${entry.filters.isp}` : ""}
                      {entry.filters.deltaThreshold
                        ? `${entry.filters.asn || entry.filters.isp ? ", " : ""}Δ>${entry.filters.deltaThreshold}ms`
                        : ""}
                    </>
                  )}
                </div>
                {entry.summary && (
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    {t("summaryMedianV4")} {ms(entry.summary.medianV4)} · {t("summaryMedianV6")} {ms(entry.summary.medianV6)} ·{" "}
                    {t("summaryMedianDelta")} {ms(entry.summary.medianDelta)}
                    {(entry.summary.kind === "ping" || entry.summary.kind === "mtr") && (
                      <>
                        {" · "}
                        {t("v4LossShort")} {pct(entry.summary.medianLossV4)} · {t("v6LossShort")} {pct(entry.summary.medianLossV6)}
                      </>
                    )}
                  </div>
                )}
                <div style={{ marginTop: 8 }}>
                  <button onClick={() => applyHistoryEntry(entry)} style={{ padding: "6px 10px" }}>
                    {t("loadSettings")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 10, fontSize: 13, opacity: 0.8 }}>
            {t("noHistory")}
          </div>
        )}

        <div style={{ borderTop: "1px dashed #e5e7eb", marginTop: 12, paddingTop: 12 }}>
          <div style={{ fontWeight: 700 }}>{t("compareRuns")}</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("runA")}
              <select value={historyCompareA} onChange={(e) => setHistoryCompareA(e.target.value)} style={{ padding: 6, minWidth: 220 }}>
                <option value="">{t("selectRun")}</option>
                {history.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {new Date(entry.ts).toLocaleString(dateLocale)} · {entry.cmd} · {entry.target}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("runB")}
              <select value={historyCompareB} onChange={(e) => setHistoryCompareB(e.target.value)} style={{ padding: 6, minWidth: 220 }}>
                <option value="">{t("selectRun")}</option>
                {history.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {new Date(entry.ts).toLocaleString(dateLocale)} · {entry.cmd} · {entry.target}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {historyCompareMismatch && (
            <div style={{ marginTop: 8, color: "#b91c1c", fontSize: 13 }}>{historyCompareMismatch}</div>
          )}

          {!historyCompareMismatch && historyEntryA && historyEntryB && historyCompareMetrics.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 13, opacity: 0.8 }}>{t("deltaRunLabel")}</div>
              <div style={{ overflowX: "auto", marginTop: 6 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 4px" }}>{t("metric")}</th>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 4px" }}>{t("runA")}</th>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 4px" }}>{t("runB")}</th>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 4px" }}>{t("summaryMedianDelta")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyCompareMetrics.map((metric) => (
                      <tr key={metric.label}>
                        <td style={{ padding: "6px 4px", borderBottom: "1px solid #f3f4f6" }}>{metric.label}</td>
                        <td style={{ padding: "6px 4px", borderBottom: "1px solid #f3f4f6" }}>{metric.format(metric.a)}</td>
                        <td style={{ padding: "6px 4px", borderBottom: "1px solid #f3f4f6" }}>{metric.format(metric.b)}</td>
                        <td style={{ padding: "6px 4px", borderBottom: "1px solid #f3f4f6" }}>
                          {metric.format(Number.isFinite(metric.a) && Number.isFinite(metric.b) ? metric.b - metric.a : null)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      {reportMode && (
        <div style={{ marginBottom: 16, padding: 12, border: "1px solid #dbeafe", borderRadius: 10, background: "#eff6ff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700 }}>{t("report")}</div>
            <button onClick={exitReportMode} style={{ padding: "6px 10px" }}>
              {t("exitReportMode")}
            </button>
          </div>

          {reportNotice && (
            <div style={{ marginTop: 8, fontSize: 13, opacity: 0.9 }} role="note">
              {reportNotice}
            </div>
          )}

          {shareUrl && (
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
              {t("reportLinkShort")}: <a href={shareUrl}>{shareUrl}</a>
              {reportMeta?.expiresAt && (
                <>
                  {" · "}{t("reportExpires")}: {new Date(reportMeta.expiresAt).toLocaleString(dateLocale)}
                </>
              )}
            </div>
          )}

          {!reportData && (
            <div style={{ fontSize: 13, opacity: 0.8, marginTop: 8 }} role="status" aria-live="polite">
              {t("reportLoading")}
            </div>
          )}

          {reportData && reportData.mode === "multiTarget" && (
            <>
              <div style={{ fontSize: 13, opacity: 0.8, marginTop: 8 }}>
                {t("generated")} {new Date(reportData.ts).toLocaleString(dateLocale)} · {String(reportData.backend || "")} · {reportData.cmd} · {(reportData.entries || []).length} targets
              </div>
              <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
                {t("from")} {reportData.from} · {t("probes").toLowerCase()} {reportData.limit} · {t("net").toLowerCase()} {reportData.net} · {t("ipv6OnlyShort")} {reportData.v6only ? t("ipv6OnlyYes") : t("ipv6OnlyNo")}
              </div>
              <div style={{ overflowX: "auto", marginTop: 10 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 4px" }}>{t("target")}</th>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 4px" }}>{t("command")}</th>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 4px" }}>{t("summaryMedianV4")}</th>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 4px" }}>{t("summaryMedianV6")}</th>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 4px" }}>{t("summaryMedianDelta")}</th>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 4px" }}>{t("summaryMedianLossV4")}</th>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "6px 4px" }}>{t("summaryMedianLossV6")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(reportData.entries || []).map((e) => (
                      <tr key={String(e.id || e.target)}>
                        <td style={{ padding: "6px 4px", borderBottom: "1px solid #f3f4f6", wordBreak: "break-all" }}>{e.target}</td>
                        <td style={{ padding: "6px 4px", borderBottom: "1px solid #f3f4f6" }}>{e.cmd}</td>
                        <td style={{ padding: "6px 4px", borderBottom: "1px solid #f3f4f6" }}>{ms(e.summary?.medianV4)}</td>
                        <td style={{ padding: "6px 4px", borderBottom: "1px solid #f3f4f6" }}>{ms(e.summary?.medianV6)}</td>
                        <td style={{ padding: "6px 4px", borderBottom: "1px solid #f3f4f6" }}>{ms(e.summary?.medianDelta)}</td>
                        <td style={{ padding: "6px 4px", borderBottom: "1px solid #f3f4f6" }}>{Number.isFinite(e.summary?.medianLossV4) ? pct(e.summary.medianLossV4) : "—"}</td>
                        <td style={{ padding: "6px 4px", borderBottom: "1px solid #f3f4f6" }}>{Number.isFinite(e.summary?.medianLossV6) ? pct(e.summary.medianLossV6) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {reportData && reportData.mode !== "multiTarget" && (
            <>
              <div style={{ fontSize: 13, opacity: 0.8, marginTop: 8 }}>
                {t("generated")} {new Date(reportData.ts).toLocaleString(dateLocale)} · {reportData.cmd} · {reportData.target}
              </div>
              <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
                {t("from")} {reportData.from} · {t("probes").toLowerCase()} {reportData.limit} · {t("net").toLowerCase()} {reportData.net} ·{" "}
                {t("ipv6OnlyShort")} {reportData.v6only ? t("ipv6OnlyYes") : t("ipv6OnlyNo")}
                {reportData.filters && (reportData.filters.asn || reportData.filters.isp || reportData.filters.deltaThreshold) && (
                  <>
                    {" · "}{t("filters")} {reportData.filters.asn ? `ASN ${reportData.filters.asn}` : ""}
                    {reportData.filters.isp ? `${reportData.filters.asn ? ", " : ""}ISP ${reportData.filters.isp}` : ""}
                    {reportData.filters.deltaThreshold
                      ? `${reportData.filters.asn || reportData.filters.isp ? ", " : ""}Δ>${reportData.filters.deltaThreshold}ms`
                      : ""}
                  </>
                )}
              </div>
              {reportData.summary && (
                <div style={{ fontSize: 13, marginTop: 6 }}>
                  {t("summaryMedianV4")} {ms(reportData.summary.medianV4)} · {t("summaryMedianV6")} {ms(reportData.summary.medianV6)} ·{" "}
                  {t("summaryMedianDelta")} {ms(reportData.summary.medianDelta)}
                  {(reportData.summary.kind === "ping" || reportData.summary.kind === "mtr") && (
                    <>
                      {" · "}
                      {t("v4LossShort")} {pct(reportData.summary.medianLossV4)} · {t("v6LossShort")} {pct(reportData.summary.medianLossV6)}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}


      {deltaAlert && (
        <div style={{ background: "#fef3c7", color: "#111", border: "1px solid #f59e0b", padding: 12, marginBottom: 12 }} role="alert">
          {t("deltaAlertNotice", { label: deltaAlert.label, delta: deltaAlert.delta, threshold: deltaThresholdValue })}
        </div>
      )}

      {measurementStatusNotice && (
        <div style={{ marginTop: 10, padding: 10, border: "1px solid #f59e0b", borderRadius: 10, background: "#fffbeb", fontSize: 13 }}>
          <div style={{ fontWeight: 700 }}>{t("measurementStatusTitle")}</div>
          <div style={{ opacity: 0.85, marginTop: 4 }}>{t("measurementStatusBody", measurementStatusNotice)}</div>
        </div>
      )}

      {coverageNotice && (
        <div style={{ background: "#ecfeff", color: "#111", border: "1px solid #06b6d4", padding: 12, marginBottom: 12, borderRadius: 10 }} role="note">
          <div style={{ fontWeight: 700 }}>{t("coverageTitle")}</div>
          <div style={{ marginTop: 4, fontSize: 13 }}>
            {t("coverageV4")}: {coverageNotice.v4got}/{coverageNotice.v4exp} · {t("coverageV6")}: {coverageNotice.v6got}/{coverageNotice.v6exp} · {t("coverageBoth")}: {coverageNotice.both}/{coverageNotice.expected}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>{t("coverageHint")}</div>
        </div>
      )}

      {pingSection}


      {probePoints.length > 0 && (
        <div style={{ marginBottom: 16, padding: 12, border: "1px solid #e5e7eb", borderRadius: 10 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{t("probeMap")}</div>
          {probeMapUrl ? (
            <img
              src={probeMapUrl}
              alt={t("probeMapAlt")}
              style={{ width: "100%", maxWidth: 820, borderRadius: 8, border: "1px solid #e5e7eb" }}
            />
          ) : (
            <div style={{ fontSize: 13, opacity: 0.8 }}>{t("noProbeCoordinates")}</div>
          )}
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
            {probePoints.slice(0, 30).map((p, idx) => (
              <a
                key={`${p.lat}-${p.lon}-${idx}`}
                href={`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=6/${p.lat}/${p.lon}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "underline" }}
              >
                {p.label || `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Traceroute compare table */}
      {tracerouteSection}
      {mtrSection}
      {dnsSection}
      {httpSection}


      {asnCard && (() => {
        const rows = Array.isArray(asnCard.rows) ? asnCard.rows : [];
        const related = rows.filter((r) => normalizeAsn(r?.probe?.asn) === asnCard.asn);
        const summary = computeAsnSummary(asnCard.kind, related);

        const isPingLike = asnCard.kind === 'ping' || asnCard.kind === 'mtr';
        const isTrace = asnCard.kind === 'traceroute';
        const isHttp = asnCard.kind === 'http';

        return (
          <div
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setAsnCard(null);
            }}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
              zIndex: 10000,
            }}
          >
            <div
              style={{
                background: '#fff',
                color: '#111',
                borderRadius: 14,
                border: '1px solid #e5e7eb',
                boxShadow: '0 24px 60px rgba(0,0,0,.25)',
                width: 'min(860px, 100%)',
                maxHeight: '80vh',
                overflow: 'auto',
                padding: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 18 }}>{t('asnDetailsTitle')}: {asnCard.asn}</div>
                  <div style={{ marginTop: 4, fontSize: 13, opacity: 0.8 }}>{t('asnDetailsInTable', { n: summary.n })}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={() => copyAsnToClipboard(asnCard.asn)}
                    style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer' }}
                  >
                    {t('asnDetailsCopy')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setProbeAsn(String(asnCard.asn));
                      setAsnCard(null);
                    }}
                    style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer' }}
                  >
                    {t('asnDetailsUseFilter')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAsnCard(null)}
                    style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer' }}
                  >
                    {t('asnDetailsClose')}
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>{t('asnDetailsAbout')}</div>


              {(() => {
                const status = asnCard.metaStatus || 'idle';
                const meta = asnCard.meta;

                const isLoading = status === 'loading' || status === 'idle';
                const isError = status === 'error';

                const holderText = cleanUiText(meta?.holder) || '-';
                const registryName = cleanUiText(meta?.registry?.name) || '-';
                const ianaDesc = cleanUiText(meta?.registry?.desc);
                const announced = typeof meta?.announced === 'boolean' ? (meta.announced ? t('yes') : t('no')) : '-';

                const source = (() => {
                  const s = String(meta?.source || '').trim();
                  if (s === 'ripestat-as-overview') return 'RIPEstat (as-overview)';
                  return s || '-';
                })();

                const cache = (() => {
                  const s = String(meta?.cache?.status || '').trim();
                  return s || '-';
                })();

                const refreshing = meta?.cache?.revalidating === true ? t('asnMetaRefreshing') : null;

                const warming = asnCard?.metaMissRetryPending === true ? t('asnMetaWarming') : null;

                const fetchedAtDate = meta?.fetchedAt ? new Date(meta.fetchedAt) : null;
                const age = fetchedAtDate && Number.isFinite(fetchedAtDate.getTime()) ? formatAgeHuman(Date.now() - fetchedAtDate.getTime()) : null;
                const fetchedAtLabel = fetchedAtDate && Number.isFinite(fetchedAtDate.getTime()) ? fetchedAtDate.toLocaleString(dateLocale) : null;
                const provenance = meta
                  ? t('asnMetaProvenance', { source, cache, refreshing, warming, age, fetchedAt: fetchedAtLabel })
                  : null;

                return (
                  <>
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }} title={provenance || ''}>
                      {isLoading ? <SkeletonLine width="60%" height={12} /> : (provenance || 'Metadata')}
                    </div>

                    {isError ? (
                      <div
                        style={{
                          marginTop: 12,
                          padding: 10,
                          border: '1px solid #fed7aa',
                          borderRadius: 12,
                          background: '#fff7ed',
                          fontSize: 13,
                        }}
                      >
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>{t('asnMetaUnavailable')}</div>
                        <div style={{ opacity: 0.85 }}>{t('asnMetaErrorHint')}</div>
                        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            onClick={() =>
                              setAsnCard((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      metaReqId: Number(prev.metaReqId || 0) + 1,
                                      metaAutoRefreshLeft: 2,
                                      metaMissRetryLeft: 1,
                                      metaMissRetryPending: false,
                                      metaStatus: 'loading',
                                      metaError: null,
                                    }
                                  : prev
                              )
                            }
                            style={{
                              padding: '6px 10px',
                              borderRadius: 10,
                              border: '1px solid #e5e7eb',
                              background: '#fff',
                              cursor: 'pointer',
                            }}
                          >
                            {t('asnMetaRetry')}
                          </button>
                          {asnCard.metaError ? <div style={{ fontSize: 12, opacity: 0.75 }}>{asnCard.metaError}</div> : null}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div
                          style={{
                            marginTop: 12,
                            display: 'grid',
                            gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) minmax(0,1fr)',
                            gap: 10,
                            fontSize: 13,
                          }}
                        >
                          <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                            <div style={{ fontWeight: 800, marginBottom: 6 }}>{t('asnMetaHolder')}</div>
                            {isLoading ? (
                              <div style={{ display: 'grid', gap: 6 }}>
                                <SkeletonLine width="85%" />
                                <SkeletonLine width="65%" />
                              </div>
                            ) : (
                              <ExpandableText
                                text={holderText}
                                lines={2}
                                moreLabel={t('asnMetaShowMore')}
                                lessLabel={t('asnMetaShowLess')}
                              />
                            )}
                          </div>

                          <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                            <div style={{ fontWeight: 800, marginBottom: 6 }}>{t('asnMetaRegistry')}</div>
                            {isLoading ? <SkeletonLine width="70%" /> : <div>{registryName}</div>}
                          </div>

                          <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                            <div style={{ fontWeight: 800, marginBottom: 6 }}><span className="tt">{t('asnMetaAnnounced')}<span className="tt-info" tabIndex={0} aria-label={t('asnMetaAnnouncedHelpAria')}>i</span><span className="tt-bubble">{t('asnMetaAnnouncedHelp')}</span></span></div>
                            {isLoading ? <SkeletonLine width="40%" /> : <div>{announced}</div>}
                          </div>
                        </div>

                        {isLoading ? (
                          <div style={{ marginTop: 10, padding: 10, border: '1px solid #e5e7eb', borderRadius: 12, fontSize: 13 }}>
                            <div style={{ display: 'grid', gap: 6 }}>
                              <SkeletonLine width="30%" />
                              <SkeletonLine width="95%" />
                              <SkeletonLine width="85%" />
                            </div>
                          </div>
                        ) : ianaDesc ? (
                          <div style={{ marginTop: 10, padding: 10, border: '1px solid #e5e7eb', borderRadius: 12, fontSize: 13 }}>
                            <div style={{ fontWeight: 800, marginBottom: 6 }}>{t('asnMetaIana')}</div>
                            <ExpandableText
                              text={ianaDesc}
                              lines={3}
                              moreLabel={t('asnMetaShowMore')}
                              lessLabel={t('asnMetaShowLess')}
                            />
                          </div>
                        ) : null}
                      </>
                    )}

                        {!isError && (
                          <div
                            style={{
                              marginTop: 10,
                              display: 'grid',
                            gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
                            gap: 10,
                            fontSize: 13,
                          }}
                        >
                          <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                            <div style={{ fontWeight: 800, marginBottom: 6 }}>{t('asnMetaAnnouncedPrefixes')}</div>
                            {isLoading ? (
                              <div style={{ display: 'grid', gap: 6 }}>
                                <SkeletonLine width="40%" />
                                <SkeletonLine width="65%" />
                              </div>
                            ) : meta?.announcedPrefixes ? (
                              <div style={{ display: 'grid', gap: 4 }}>
                                <div>
                                  {t('asnMetaAnnouncedPrefixesTotal')}: {Number.isFinite(meta.announcedPrefixes?.total) ? meta.announcedPrefixes.total : '-'}
                                </div>
                                <div>
                                  {t('asnMetaAnnouncedPrefixesV4')}: {Number.isFinite(meta.announcedPrefixes?.v4) ? meta.announcedPrefixes.v4 : '-'} · {t('asnMetaAnnouncedPrefixesV6')}: {Number.isFinite(meta.announcedPrefixes?.v6) ? meta.announcedPrefixes.v6 : '-'}
                                </div>
                              </div>
                            ) : (
                              <div>-</div>
                            )}
                          </div>

                          <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                            <div style={{ fontWeight: 800, marginBottom: 6 }}>{t('asnMetaRpkiTitle')}</div>
                            {isLoading ? (
                              <div style={{ display: 'grid', gap: 6 }}>
                                <SkeletonLine width="55%" />
                                <SkeletonLine width="70%" />
                              </div>
                            ) : meta?.rpkiSample ? (() => {
                              const rp = meta.rpkiSample;
                              const counts = rp?.counts || {};
                              const share = rp?.pct || {};
                              const fam4 = rp?.byFamily?.v4 || null;
                              const fam6 = rp?.byFamily?.v6 || null;
                              const act = rp?.actionable || {};
                              const level = String(act?.level || 'ok');
                              const invalidPct = Number.isFinite(act?.invalidPct) ? act.invalidPct : null;
                              const hint =
                                level === 'alert'
                                  ? t('asnMetaRpkiHintAlert', { pct: pct(invalidPct) })
                                  : level === 'warn'
                                    ? t('asnMetaRpkiHintWarn', { pct: pct(invalidPct) })
                                    : t('asnMetaRpkiHintOk');

                              const fmtCount = (label, n, s) => (
                                <span>
                                  {label}: {Number.isFinite(n) ? n : 0}{' '}
                                  <span style={{ opacity: 0.8 }}>({t('asnMetaRpkiShare')}: {pct(Number.isFinite(s) ? s : null)})</span>
                                </span>
                              );

                              const famLine = (tag, f) => {
                                if (!f) return null;
                                const c = f.counts || {};
                                const p = f.pct || {};
                                return (
                                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                                    <span style={{ fontWeight: 700 }}>{tag}:</span>{' '}
                                    <span>{t('asnMetaRpkiValid')} {Number.isFinite(c.valid) ? c.valid : 0} ({pct(Number.isFinite(p.valid) ? p.valid : null)})</span>
                                    <span style={{ marginLeft: 8 }}>{t('asnMetaRpkiInvalid')} {Number.isFinite(c.invalid) ? c.invalid : 0} ({pct(Number.isFinite(p.invalid) ? p.invalid : null)})</span>
                                    <span style={{ marginLeft: 8 }}>{t('asnMetaRpkiUnknown')} {Number.isFinite(c.unknown) ? c.unknown : 0} ({pct(Number.isFinite(p.unknown) ? p.unknown : null)})</span>
                                  </div>
                                );
                              };

                              return (
                                <div>
                                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                    {fmtCount(t('asnMetaRpkiValid'), counts?.valid, share?.valid)}
                                    {fmtCount(t('asnMetaRpkiInvalid'), counts?.invalid, share?.invalid)}
                                    {fmtCount(t('asnMetaRpkiUnknown'), counts?.unknown, share?.unknown)}
                                  </div>

                                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                                    {t('asnMetaRpkiSampleNote', {
                                      n: Number.isFinite(rp?.n) ? rp.n : (Array.isArray(rp?.sample) ? rp.sample.length : 0),
                                      v4: Number.isFinite(rp?.v4) ? rp.v4 : '-',
                                      v6: Number.isFinite(rp?.v6) ? rp.v6 : '-',
                                    })}
                                  </div>

                                  {(fam4 || fam6) ? (
                                    <div style={{ marginTop: 8 }}>
                                      <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 4 }}>{t('asnMetaRpkiByFamily')}</div>
                                      {famLine('v4', fam4)}
                                      {famLine('v6', fam6)}
                                    </div>
                                  ) : null}

                                  <div
                                    style={{
                                      marginTop: 8,
                                      padding: 8,
                                      border: '1px solid #e5e7eb',
                                      borderRadius: 10,
                                      background: level === 'alert' ? '#fef2f2' : level === 'warn' ? '#fff7ed' : '#f8fafc',
                                      fontSize: 12,
                                      opacity: 0.95,
                                    }}
                                  >
                                    {hint}
                                  </div>

                                  {Array.isArray(rp?.sample) && rp.sample.length ? (
                                    <div style={{ marginTop: 8, maxHeight: 160, overflow: 'auto', border: '1px solid #f3f4f6', borderRadius: 10 }}>
                                      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                                        <thead>
                                          <tr>
                                            <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: '6px 8px' }}>{t('asnMetaRpkiPrefix')}</th>
                                            <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: '6px 8px' }}>{t('asnMetaRpkiStatus')}</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {rp.sample.slice(0, 20).map((row, idx) => (
                                            <tr key={`${row.prefix || ''}-${idx}`}>
                                              <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>
                                                {row.prefix}
                                              </td>
                                              <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>{row.status || '-'}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })() : (
                              <div>-</div>
                            )}
                          </div>
                          </div>
                        )}

                  </>
                );
              })()}

              <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 10, fontSize: 13 }}>
                <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Median v4</div>
                  <div>{ms(summary.median_v4)}</div>
                </div>
                <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Median v6</div>
                  <div>{ms(summary.median_v6)}</div>
                </div>
                <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Median Δ (v6-v4)</div>
                  <div>{ms(summary.median_delta)}</div>
                </div>
              </div>

              {isPingLike && (
                <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 10, fontSize: 13 }}>
                  <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>Median loss v4</div>
                    <div>{pct(summary.median_loss_v4)}</div>
                  </div>
                  <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>Median loss v6</div>
                    <div>{pct(summary.median_loss_v6)}</div>
                  </div>
                  <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>Median Δ loss</div>
                    <div>{pct(summary.median_loss_delta)}</div>
                  </div>
                </div>
              )}

              {!isPingLike && !isTrace && !isHttp && summary.median_ratio !== undefined && (
                <div style={{ marginTop: 10, padding: 10, border: '1px solid #e5e7eb', borderRadius: 12, fontSize: 13 }}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Median ratio (v6/v4)</div>
                  <div>{Number.isFinite(summary.median_ratio) ? summary.median_ratio.toFixed(2) : '-'}</div>
                </div>
              )}

              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>Probes</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr>
                        {['#', 'Location', 'v4', 'v6', 'Δ'].map((h) => (
                          <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: '6px 8px' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {related.slice(0, 30).map((row, i) => {
                        const v4 = row.v4avg ?? row.v4dst ?? row.v4ms;
                        const v6 = row.v6avg ?? row.v6dst ?? row.v6ms;
                        const d = row.deltaAvg ?? row.delta ?? row.delta;
                        return (
                          <tr key={row.key || i}>
                            <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>{i + 1}</td>
                            <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>{formatProbeLocation(row.probe)}</td>
                            <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>{ms(v4)}</td>
                            <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>{ms(v6)}</td>
                            <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>{ms(d)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {related.length > 30 ? (
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>Showing first 30 probes.</div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })()}


      {/* RAW outputs */}
      {showRaw && v4 && v6 && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12, marginBottom: 18 }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: "0 0 6px 0" }}>{t("rawV4")}</h3>
            <pre style={preStyle}>
              {v4.results?.map((x, idx) => `${probeHeader(x, idx)}\n${x.result?.rawOutput ?? ""}\n`).join("\n")}
            </pre>
          </div>

          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: "0 0 6px 0" }}>{t("rawV6")}</h3>
            <pre style={preStyle}>
              {v6.results?.map((x, idx) => `${probeHeader(x, idx)}\n${x.result?.rawOutput ?? ""}\n`).join("\n")}
            </pre>
          </div>
        </div>
      )}

      <footer
        style={{
          marginTop: "auto",
          paddingTop: 24,
          paddingBottom: 8,
          textAlign: "center",
          fontSize: 14,
          opacity: 0.8,
        }}
      >
        {t("footer")}{" "}
        <a href="https://www.linkedin.com/in/antoniopradoit/" target="_blank" rel="noreferrer">
          The Internet Floopaloo
        </a>
        . {t("footerTail")}
      </footer>
    </div>
  );
}
