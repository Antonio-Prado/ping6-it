import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { waitForMeasurement } from "./lib/globalping";
import { setStoredAtlasKey, waitForAtlasMeasurement } from "./lib/atlas";
import { GEO_PRESETS } from "./geoPresets";
// Turnstile (Cloudflare) - load on demand (only when the user presses Run).
let __turnstileScriptPromise = null;
const TURNSTILE_LOAD_TIMEOUT_MS = 8000;
const TURNSTILE_EXEC_TIMEOUT_MS = 30000;
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

function clampInputValue(value, { min, max, fallback, allowEmpty = false }) {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return allowEmpty ? "" : String(fallback);
  const num = Number(raw);
  if (!Number.isFinite(num)) return allowEmpty ? "" : String(fallback);
  const clamped = Math.min(max, Math.max(min, num));
  return String(clamped);
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
    generated: "Generated",
    ipv6OnlyYes: "yes",
    ipv6OnlyNo: "no",
    ipv6OnlyShort: "IPv6-only",
    deltaAlertNotice: ({ label, delta, threshold }) => `${label} is ${ms(delta)} (threshold ${threshold} ms).`,
    probeMap: "Probe map",
    probeMapAlt: "Map of probe locations",
    noProbeCoordinates: "No coordinates available for these probes.",
    pingTitle: "Ping RTT (v4 vs v6)",
    tracerouteTitle: "Traceroute to destination (v4 vs v6)",
    traceroutePathsTitle: "Traceroute paths (v4 vs v6)",
    mtrTitle: "MTR to destination (v4 vs v6)",
    mtrPathsTitle: "MTR paths (v4 vs v6)",
    dnsTitle: "DNS timings (v4 vs v6)",
    httpTitle: "HTTP timings (v4 vs v6)",
    rawV4: "RAW v4",
    rawV6: "RAW v6",
    footer: "If it works, thank",
    footerTail: "If not, blame IPv4!",
    summaryBoth: "both",
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
    helpAtlasKey: "Get an API key from RIPE Atlas: log in → My Atlas → Keys (API Keys) → Create key. Paste it here. Stored locally and never included in share links.",
    helpAsn: "Filter probes by ASN (e.g. 12345).",
    helpIsp: "ISP name filtering is not supported by the Globalping API: use an ASN when possible.",
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

function normalizeHistorySummary(cmd, v4, v6) {
  if (!v4 || !v6) return null;
  if (cmd === "ping") {
    const { summary } = buildPingCompare(v4, v6);
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
    const { summary } = buildTracerouteCompare(v4, v6);
    return {
      kind: "traceroute",
      medianV4: summary.median_v4,
      medianV6: summary.median_v6,
      medianDelta: summary.median_delta,
    };
  }
  if (cmd === "mtr") {
    const { summary } = buildMtrCompare(v4, v6);
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
    const { summary } = buildDnsCompare(v4, v6);
    return {
      kind: "dns",
      medianV4: summary.median_v4,
      medianV6: summary.median_v6,
      medianDelta: summary.median_delta,
    };
  }
  if (cmd === "http") {
    const { summary } = buildHttpCompare(v4, v6);
    return {
      kind: "http",
      medianV4: summary.median_v4,
      medianV6: summary.median_v6,
      medianDelta: summary.median_delta,
    };
  }
  return null;
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

function buildPingCompare(v4, v6) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const bMap = new Map(b.map((x) => [probeKey(x), x]));

  const rows = a.map((x, i) => {
    const y = bMap.get(probeKey(x)) ?? b[i];
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
      key: probeKey(x) || String(i),
      idx: i,
      probe: p,
      v4avg: s4.avgMs,
      v4loss: s4.lossPct,
      v6avg: s6.avgMs,
      v6loss: s6.lossPct,
      deltaAvg,
      deltaLoss,
      winner,
    };
  });

  const v4AvgArr = rows.map((r) => r.v4avg).filter(Number.isFinite);
  const v6AvgArr = rows.map((r) => r.v6avg).filter(Number.isFinite);
  const v4LossArr = rows.map((r) => r.v4loss).filter(Number.isFinite);
  const v6LossArr = rows.map((r) => r.v6loss).filter(Number.isFinite);
  const dAvgArr = rows.map((r) => r.deltaAvg).filter(Number.isFinite);
  const dLossArr = rows.map((r) => r.deltaLoss).filter(Number.isFinite);

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

function buildDnsCompare(v4, v6) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const bMap = new Map(b.map((x) => [probeKey(x), x]));

  const rows = a.map((x, i) => {
    const y = bMap.get(probeKey(x)) ?? b[i];
    const p = x?.probe || y?.probe || {};

    const v4ms = pickDnsTotalMs(x);
    const v6ms = pickDnsTotalMs(y);

    const delta = Number.isFinite(v4ms) && Number.isFinite(v6ms) ? v6ms - v4ms : null;
    const ratio = Number.isFinite(v4ms) && Number.isFinite(v6ms) && v4ms > 0 ? v6ms / v4ms : null;

    return {
      key: probeKey(x) || String(i),
      idx: i,
      probe: p,
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

  const v4msArr = rows.map((r) => r.v4ms).filter(Number.isFinite);
  const v6msArr = rows.map((r) => r.v6ms).filter(Number.isFinite);
  const dArr = rows.map((r) => r.delta).filter(Number.isFinite);

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

function buildHttpCompare(v4, v6) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const bMap = new Map(b.map((x) => [probeKey(x), x]));

  const rows = a.map((x, i) => {
    const y = bMap.get(probeKey(x)) ?? b[i];
    const p = x?.probe || y?.probe || {};

    const v4ms = pickHttpTotalMs(x);
    const v6ms = pickHttpTotalMs(y);

    const v4sc = pickHttpStatusCode(x);
    const v6sc = pickHttpStatusCode(y);

    const delta = Number.isFinite(v4ms) && Number.isFinite(v6ms) ? v6ms - v4ms : null;
    const ratio = Number.isFinite(v4ms) && Number.isFinite(v6ms) && v4ms > 0 ? v6ms / v4ms : null;

    return {
      key: probeKey(x) || String(i),
      idx: i,
      probe: p,
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

  const v4msArr = rows.map((r) => r.v4ms).filter(Number.isFinite);
  const v6msArr = rows.map((r) => r.v6ms).filter(Number.isFinite);
  const dArr = rows.map((r) => r.delta).filter(Number.isFinite);

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


function pickTracerouteDstMs(x) {
  const r = x?.result;
  if (!r || (r.status && r.status !== "finished")) return { reached: false, hops: null, dstMs: null };
  if (r.error) return { reached: false, hops: null, dstMs: null };

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
  if (!r || (r.status && r.status !== "finished")) return { reached: false, hops: null, avgMs: null, lossPct: null };
  if (r.error) return { reached: false, hops: null, avgMs: null, lossPct: null };

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

function buildTracerouteCompare(v4, v6) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const bMap = new Map(b.map((x) => [probeKey(x), x]));

  const rows = a.map((x, i) => {
    const y = bMap.get(probeKey(x)) ?? b[i];
    const p = x?.probe || y?.probe || {};

    const s4 = pickTracerouteDstMs(x);
    const s6 = pickTracerouteDstMs(y);

    const delta = Number.isFinite(s4.dstMs) && Number.isFinite(s6.dstMs) ? s6.dstMs - s4.dstMs : null;

    let winner = "-";
    if (s4.reached && !s6.reached) winner = "v4";
    else if (!s4.reached && s6.reached) winner = "v6";
    else if (s4.reached && s6.reached && Number.isFinite(s4.dstMs) && Number.isFinite(s6.dstMs)) {
      winner = s4.dstMs < s6.dstMs ? "v4" : s6.dstMs < s4.dstMs ? "v6" : "tie";
    }

    return {
      key: probeKey(x) || String(i),
      idx: i,
      probe: p,
      v4reached: s4.reached,
      v4hops: s4.hops,
      v4dst: s4.dstMs,
      v6reached: s6.reached,
      v6hops: s6.hops,
      v6dst: s6.dstMs,
      delta,
      winner,
    };
  });

  const v4Arr = rows.map((r) => r.v4dst).filter(Number.isFinite);
  const v6Arr = rows.map((r) => r.v6dst).filter(Number.isFinite);
  const dArr = rows.map((r) => r.delta).filter(Number.isFinite);

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

function buildMtrCompare(v4, v6) {
  const a = v4?.results ?? [];
  const b = v6?.results ?? [];
  const bMap = new Map(b.map((x) => [probeKey(x), x]));

  const rows = a.map((x, i) => {
    const y = bMap.get(probeKey(x)) ?? b[i];
    const p = x?.probe || y?.probe || {};

    const s4 = pickMtrDstStats(x);
    const s6 = pickMtrDstStats(y);

    const deltaAvg = Number.isFinite(s4.avgMs) && Number.isFinite(s6.avgMs) ? s6.avgMs - s4.avgMs : null;
    const deltaLoss = Number.isFinite(s4.lossPct) && Number.isFinite(s6.lossPct) ? s6.lossPct - s4.lossPct : null;

    let winner = "-";
    if (s4.reached && !s6.reached) winner = "v4";
    else if (!s4.reached && s6.reached) winner = "v6";
    else if (s4.reached && s6.reached) {
      if (Number.isFinite(s4.lossPct) && Number.isFinite(s6.lossPct) && Math.abs(s4.lossPct - s6.lossPct) >= 0.1) {
        winner = s4.lossPct < s6.lossPct ? "v4" : "v6";
      } else if (Number.isFinite(s4.avgMs) && Number.isFinite(s6.avgMs)) {
        winner = s4.avgMs < s6.avgMs ? "v4" : s6.avgMs < s4.avgMs ? "v6" : "tie";
      }
    }

    return {
      key: probeKey(x) || String(i),
      idx: i,
      probe: p,
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

  const v4AvgArr = rows.map((r) => r.v4avg).filter(Number.isFinite);
  const v6AvgArr = rows.map((r) => r.v6avg).filter(Number.isFinite);
  const v4LossArr = rows.map((r) => r.v4loss).filter(Number.isFinite);
  const v6LossArr = rows.map((r) => r.v6loss).filter(Number.isFinite);
  const dAvgArr = rows.map((r) => r.deltaAvg).filter(Number.isFinite);
  const dLossArr = rows.map((r) => r.deltaLoss).filter(Number.isFinite);

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

export default function App() {
  // Globalping UI
  const [target, setTarget] = useState("example.com");
  const [multiTargetMode, setMultiTargetMode] = useState(false);
  const [multiTargetInput, setMultiTargetInput] = useState("");
  const [multiRunResults, setMultiRunResults] = useState([]);
  const [multiRunStatus, setMultiRunStatus] = useState(null);
  const [multiActiveId, setMultiActiveId] = useState(null);
  const [cmd, setCmd] = useState("ping"); // ping | traceroute | mtr | dns | http
  const [backend, setBackend] = useState("globalping"); // globalping | atlas
  const [atlasApiKey, setAtlasApiKey] = useState("");
  const [from, setFrom] = useState("Western Europe");
  const [gpTag, setGpTag] = useState("any"); // any | eyeball | datacenter
  const [limit, setLimit] = useState(3);
  const [requireV6Capable, setRequireV6Capable] = useState(true);
  const [runWarnings, setRunWarnings] = useState([]);

  // Geo presets UI (macro + sub-regions)
  const [macroId, setMacroId] = useState("eu");
  const [subId, setSubId] = useState("eu-w");
  const t = useCallback((key, vars = {}) => {
    const entry = COPY.en[key];
    if (typeof entry === "function") return entry(vars);
    return entry ?? key;
  }, []);

  const dateLocale = "en-US";
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = "en";
    }
  }, []);

  const macroPreset = useMemo(
    () => GEO_PRESETS.find((p) => p.id === macroId) ?? GEO_PRESETS[0],
    [macroId]
  );
  const subPresets = macroPreset?.sub ?? [];
  const parsedMultiTargets = useMemo(() => parseMultiTargets(multiTargetInput), [multiTargetInput]);
  const canRequireV6Capable = multiTargetMode
    ? parsedMultiTargets.length > 0 && parsedMultiTargets.every((item) => !isIpLiteral(item))
    : !isIpLiteral((target || "").trim());

  const maxProbes = backend === "atlas" ? 50 : 10;

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const b = String(window.localStorage.getItem("PING6_BACKEND") || "").trim();
      if (b === "atlas" || b === "globalping") setBackend(b);
      const k = String(window.localStorage.getItem("PING6_ATLAS_API_KEY") || "").trim();
      if (k) setAtlasApiKey(k);
    } catch {}
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("PING6_BACKEND", backend);
    } catch {}
  }, [backend]);

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
  const [historyCompareA, setHistoryCompareA] = useState("");
  const [historyCompareB, setHistoryCompareB] = useState("");
  const [reportMode, setReportMode] = useState(false);
  const [reportData, setReportData] = useState(null);
  const [shareUrl, setShareUrl] = useState("");

  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
  const [rateLimitUntil, setRateLimitUntil] = useState(0);
  const [rateLimitLeft, setRateLimitLeft] = useState(0);
  const [v4, setV4] = useState(null);
  const [v6, setV6] = useState(null);
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

    const reportRaw = params.get("report");
    const dataRaw = params.get("data");
    if (reportRaw === "1" && dataRaw) {
      const decoded = decodeReportPayload(dataRaw);
      if (decoded) {
        setReportMode(true);
        setReportData(decoded);
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

        const summary = normalizeHistorySummary(cmd, r4, r6);
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
    const summary = normalizeHistorySummary(cmd, v4, v6);
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

  function buildExportBundle() {
    if (!v4 || !v6) return null;
    const summary = normalizeHistorySummary(cmd, v4, v6);
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
    if (cmd === "ping" && pingCompare) return { ...base, rows: pingCompare.rows };
    if (cmd === "traceroute" && trCompare) return { ...base, rows: trCompare.rows };
    if (cmd === "mtr" && mtrCompare) return { ...base, rows: mtrCompare.rows };
    if (cmd === "dns" && dnsCompare) return { ...base, rows: dnsCompare.rows };
    if (cmd === "http" && httpCompare) return { ...base, rows: httpCompare.rows };
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
      headers = ["idx", "city", "country", "asn", "network", "v4_avg_ms", "v4_loss_pct", "v6_avg_ms", "v6_loss_pct", "delta_avg_ms", "delta_loss_pct", "winner"];
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
      ]);
    } else if (cmd === "traceroute") {
      headers = ["idx", "city", "country", "asn", "network", "v4_reached", "v4_hops", "v4_dst_ms", "v6_reached", "v6_hops", "v6_dst_ms", "delta_ms", "winner"];
      lines = rows.map((r) => [
        r.idx + 1,
        r.probe?.city ?? "",
        r.probe?.country ?? "",
        r.probe?.asn ?? "",
        r.probe?.network ?? "",
        r.v4reached ? "yes" : "no",
        r.v4hops,
        r.v4dst,
        r.v6reached ? "yes" : "no",
        r.v6hops,
        r.v6dst,
        r.delta,
        r.winner,
      ]);
    } else if (cmd === "mtr") {
      headers = ["idx", "city", "country", "asn", "network", "v4_reached", "v4_hops", "v4_loss_pct", "v4_avg_ms", "v6_reached", "v6_hops", "v6_loss_pct", "v6_avg_ms", "delta_avg_ms", "delta_loss_pct", "winner"];
      lines = rows.map((r) => [
        r.idx + 1,
        r.probe?.city ?? "",
        r.probe?.country ?? "",
        r.probe?.asn ?? "",
        r.probe?.network ?? "",
        r.v4reached ? "yes" : "no",
        r.v4hops,
        r.v4loss,
        r.v4avg,
        r.v6reached ? "yes" : "no",
        r.v6hops,
        r.v6loss,
        r.v6avg,
        r.deltaAvg,
        r.deltaLoss,
        r.winner,
      ]);
    } else if (cmd === "dns") {
      headers = ["idx", "city", "country", "asn", "network", "v4_total_ms", "v6_total_ms", "delta_ms", "ratio", "winner"];
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
      ]);
    } else if (cmd === "http") {
      headers = ["idx", "city", "country", "asn", "network", "v4_status", "v6_status", "v4_total_ms", "v6_total_ms", "delta_ms", "ratio", "winner"];
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
      ]);
    }

    const csv = [headers.map(csvEscape).join(","), ...lines.map((row) => row.map(csvEscape).join(","))].join("\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `ping6-${cmd}-${stamp}.csv`;
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

  function enterReportMode() {
    if (typeof window === "undefined") return;
    const payload = buildReportPayload();
    if (!payload) return;
    const encoded = encodeReportPayload(payload);
    const url = new URL(window.location.href);
    url.searchParams.set("report", "1");
    url.searchParams.set("data", encoded);
    window.history.replaceState({}, "", url.toString());
    setReportMode(true);
    setReportData(payload);
    setShareUrl(url.toString());
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
    const url = new URL(window.location.href);
    url.searchParams.delete("report");
    url.searchParams.delete("data");
    window.history.replaceState({}, "", url.toString());
    setReportMode(false);
    setReportData(null);
    updateShareLink();
  }


  const showPingTable = cmd === "ping" && v4 && v6;
  const showTracerouteTable = cmd === "traceroute" && v4 && v6;
  const showMtrTable = cmd === "mtr" && v4 && v6;

  const showDnsTable = cmd === "dns" && v4 && v6;
  const showHttpTable = cmd === "http" && v4 && v6;

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
    const results = v4?.results || v6?.results || [];
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
  }, [v4, v6]);

  const probeMapUrl = useMemo(() => buildStaticMapUrl(probePoints.slice(0, 40)), [probePoints]);

  const traceroutePaths = useMemo(() => {
    if (!showTracerouteTable || !v4 || !v6) return [];
    const a = v4?.results ?? [];
    const b = v6?.results ?? [];
    const bMap = new Map(b.map((x) => [probeKey(x), x]));
    return a.map((x, i) => {
      const y = bMap.get(probeKey(x)) ?? b[i];
      const p = x?.probe || y?.probe || {};
      return {
        key: probeKey(x) || String(i),
        probe: p,
        v4path: formatHopPath(x),
        v6path: formatHopPath(y),
      };
    });
  }, [showTracerouteTable, v4, v6]);

  const mtrPaths = useMemo(() => {
    if (!showMtrTable || !v4 || !v6) return [];
    const a = v4?.results ?? [];
    const b = v6?.results ?? [];
    const bMap = new Map(b.map((x) => [probeKey(x), x]));
    return a.map((x, i) => {
      const y = bMap.get(probeKey(x)) ?? b[i];
      const p = x?.probe || y?.probe || {};
      return {
        key: probeKey(x) || String(i),
        probe: p,
        v4path: formatHopPath(x),
        v6path: formatHopPath(y),
      };
    });
  }, [showMtrTable, v4, v6]);

  const pingCompare = useMemo(() => {
    if (!showPingTable) return null;
    return buildPingCompare(v4, v6);
  }, [showPingTable, v4, v6]);

  const dnsCompare = useMemo(() => {
    if (!showDnsTable) return null;
    return buildDnsCompare(v4, v6);
  }, [showDnsTable, v4, v6]);

  const httpCompare = useMemo(() => {
    if (!showHttpTable) return null;
    return buildHttpCompare(v4, v6);
  }, [showHttpTable, v4, v6]);


  const trCompare = useMemo(() => {
    if (!showTracerouteTable) return null;
    return buildTracerouteCompare(v4, v6);
  }, [showTracerouteTable, v4, v6]);

  const mtrCompare = useMemo(() => {
    if (!showMtrTable) return null;
    return buildMtrCompare(v4, v6);
  }, [showMtrTable, v4, v6]);

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
          <button onClick={enterReportMode} disabled={!v4 || !v6} style={{ padding: "8px 12px" }}>
            {t("reportMode")}
          </button>
        </Tip>
        </div>
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

        {backend === "atlas" && runWarnings.length > 0 && (
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
            <div style={{ fontWeight: 700, fontSize: 13 }}>RIPE Atlas notes</div>
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
                <span>RIPE Atlas: measurement in progress…</span>
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
                <span>Globalping: measurement in progress…</span>
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
          <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>
            {multiRunStatus
              ? t("progress", { done: multiRunResults.length, total: multiRunStatus.total })
              : t("completedTargets", { done: multiRunResults.length })}
          </div>
          <div style={{ fontSize: 13, opacity: 0.75, marginTop: 2 }}>{t("clickTargetToLoad")}</div>
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            {multiRunResults.length ? (
              multiRunResults.map((entry) => {
                const isActive = entry.id === multiActiveId;
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
                      <button
                        onClick={() => {
                          setV4(entry.v4);
                          setV6(entry.v6);
                          setTarget(entry.target);
                          setShowRaw(false);
                          setMultiActiveId(entry.id);
                        }}
                        style={{ padding: "6px 10px" }}
                      >
                        {isActive ? t("viewing") : t("viewResults")}
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <div style={{ fontSize: 13, opacity: 0.7 }}>{t("waitingFirstResult")}</div>
            )}
          </div>
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

      {reportMode && reportData && (
        <div style={{ marginBottom: 16, padding: 12, border: "1px solid #dbeafe", borderRadius: 10, background: "#eff6ff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700 }}>{t("report")}</div>
            <button onClick={exitReportMode} style={{ padding: "6px 10px" }}>
              {t("exitReportMode")}
            </button>
          </div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
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
        </div>
      )}

      {deltaAlert && (
        <div style={{ background: "#fef3c7", color: "#111", border: "1px solid #f59e0b", padding: 12, marginBottom: 12 }} role="alert">
          {t("deltaAlertNotice", { label: deltaAlert.label, delta: deltaAlert.delta, threshold: deltaThresholdValue })}
        </div>
      )}

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

            {/* Ping compare table */}
      {showPingTable && pingCompare && (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <div style={{ margin: "0 0 8px 0" }}>
            <h3 style={{ margin: "0 0 6px 0" }}>{t("pingTitle")}</h3>
            <div style={{ opacity: 0.85 }}>
              {t("summaryBoth")}: {pingCompare.summary.both}/{pingCompare.summary.n} · {t("summaryMedianAvgV4")}{" "}
              {ms(pingCompare.summary.median_avg_v4)} · {t("summaryMedianAvgV6")} {ms(pingCompare.summary.median_avg_v6)} ·{" "}
              {t("summaryMedianDelta")} {ms(pingCompare.summary.median_delta_avg)}
              <br />
              {t("summaryP95AvgV4")} {ms(pingCompare.summary.p95_avg_v4)} · {t("summaryP95AvgV6")} {ms(pingCompare.summary.p95_avg_v6)} ·{" "}
              {t("summaryMedianLossV4")} {pct(pingCompare.summary.median_loss_v4)} · {t("summaryMedianLossV6")}{" "}
              {pct(pingCompare.summary.median_loss_v6)}
            </div>
          </div>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {[
                  "#",
                  t("location"),
                  "ASN",
                  t("network"),
                  t("v4Avg"),
                  t("v4Loss"),
                  t("v6Avg"),
                  t("v6Loss"),
                  t("deltaV6V4"),
                  t("winner"),
                ].map((h) => (
                  <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pingCompare.rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.idx + 1}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                    {formatProbeLocation(r.probe)}
                  </td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.asn ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v4avg)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{pct(r.v4loss)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v6avg)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{pct(r.v6loss)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.deltaAvg)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.winner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Traceroute compare table */}
      {showTracerouteTable && trCompare && (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <div style={{ margin: "0 0 8px 0" }}>
            <h3 style={{ margin: "0 0 6px 0" }}>{t("tracerouteTitle")}</h3>
            <div style={{ opacity: 0.85 }}>
              {t("summaryBoth")}: {trCompare.summary.both}/{trCompare.summary.n} · {t("summaryMedianV4")} {ms(trCompare.summary.median_v4)} ·{" "}
              {t("summaryMedianV6")} {ms(trCompare.summary.median_v6)} · {t("summaryMedianDelta")} {ms(trCompare.summary.median_delta)}
              <br />
              {t("summaryP95V4")} {ms(trCompare.summary.p95_v4)} · {t("summaryP95V6")} {ms(trCompare.summary.p95_v6)}
            </div>
          </div>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {[
                  "#",
                  t("location"),
                  "ASN",
                  t("network"),
                  t("v4Reached"),
                  t("v4Hops"),
                  t("v4Dst"),
                  t("v6Reached"),
                  t("v6Hops"),
                  t("v6Dst"),
                  t("deltaV6V4"),
                  t("winner"),
                ].map((h) => (
                  <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trCompare.rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.idx + 1}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{formatProbeLocation(r.probe)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.asn ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>

                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4reached ? t("yes") : t("no")}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4hops ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v4dst)}</td>

                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v6reached ? t("yes") : t("no")}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v6hops ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v6dst)}</td>

                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.delta)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.winner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showTracerouteTable && traceroutePaths.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 6px 0" }}>{t("traceroutePathsTitle")}</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr>
                  {["#", t("probe"), t("v4Path"), t("v6Path")].map((h) => (
                    <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {traceroutePaths.map((row, idx) => (
                  <tr key={row.key}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{idx + 1}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                      {formatProbeLocation(row.probe)}
                    </td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{row.v4path}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{row.v6path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MTR compare table */}
      {showMtrTable && mtrCompare && (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <div style={{ margin: "0 0 8px 0" }}>
            <h3 style={{ margin: "0 0 6px 0" }}>{t("mtrTitle")}</h3>
            <div style={{ opacity: 0.85 }}>
              {t("summaryBoth")}: {mtrCompare.summary.both}/{mtrCompare.summary.n} · {t("summaryMedianAvgV4")}{" "}
              {ms(mtrCompare.summary.median_avg_v4)} · {t("summaryMedianAvgV6")} {ms(mtrCompare.summary.median_avg_v6)} ·{" "}
              {t("summaryMedianDelta")} {ms(mtrCompare.summary.median_delta_avg)}
              <br />
              {t("summaryMedianLossV4")} {pct(mtrCompare.summary.median_loss_v4)} · {t("summaryMedianLossV6")}{" "}
              {pct(mtrCompare.summary.median_loss_v6)} · {t("summaryDeltaLoss")} {pct(mtrCompare.summary.median_delta_loss)}
            </div>
          </div>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {[
                  "#",
                  t("location"),
                  "ASN",
                  t("network"),
                  t("v4Reached"),
                  t("v4Hops"),
                  t("v4Loss"),
                  t("v4Avg"),
                  t("v6Reached"),
                  t("v6Hops"),
                  t("v6Loss"),
                  t("v6Avg"),
                  t("deltaAvg"),
                  t("deltaLoss"),
                  t("winner"),
                ].map((h) => (
                  <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mtrCompare.rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.idx + 1}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{formatProbeLocation(r.probe)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.asn ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>

                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4reached ? t("yes") : t("no")}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4hops ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{pct(r.v4loss)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v4avg)}</td>

                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v6reached ? t("yes") : t("no")}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v6hops ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{pct(r.v6loss)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v6avg)}</td>

                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.deltaAvg)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{pct(r.deltaLoss)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.winner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showMtrTable && mtrPaths.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 6px 0" }}>{t("mtrPathsTitle")}</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr>
                  {["#", t("probe"), t("v4Path"), t("v6Path")].map((h) => (
                    <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mtrPaths.map((row, idx) => (
                  <tr key={row.key}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{idx + 1}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                      {formatProbeLocation(row.probe)}
                    </td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{row.v4path}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{row.v6path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* DNS timing compare table */}
      {showDnsTable && dnsCompare && (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <div style={{ margin: "0 0 8px 0" }}>
            <h3 style={{ margin: "0 0 6px 0" }}>{t("dnsTitle")}</h3>
            <div style={{ opacity: 0.85 }}>
              {t("summaryBoth")}: {dnsCompare.summary.both}/{dnsCompare.summary.n} · {t("summaryMedianV4")} {ms(dnsCompare.summary.median_v4)} ·{" "}
              {t("summaryMedianV6")} {ms(dnsCompare.summary.median_v6)} · {t("summaryMedianDelta")} {ms(dnsCompare.summary.median_delta)}
              <br />
              {t("summaryP95V4")} {ms(dnsCompare.summary.p95_v4)} · {t("summaryP95V6")} {ms(dnsCompare.summary.p95_v6)}
            </div>
          </div>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {[
                  "#",
                  t("location"),
                  "ASN",
                  t("network"),
                  t("v4Total"),
                  t("v6Total"),
                  t("deltaV6V4"),
                  t("ratio"),
                  t("winner"),
                ].map((h) => (
                  <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dnsCompare.rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.idx + 1}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                    {formatProbeLocation(r.probe)}
                  </td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.asn ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v4ms)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v6ms)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.delta)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                    {Number.isFinite(r.ratio) ? r.ratio.toFixed(2) : "-"}
                  </td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.winner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* HTTP timing compare table */}
      {showHttpTable && httpCompare && (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <div style={{ margin: "0 0 8px 0" }}>
            <h3 style={{ margin: "0 0 6px 0" }}>{t("httpTitle")}</h3>
            <div style={{ opacity: 0.85 }}>
              {t("summaryBoth")}: {httpCompare.summary.both}/{httpCompare.summary.n} · {t("summaryMedianV4")} {ms(httpCompare.summary.median_v4)} ·{" "}
              {t("summaryMedianV6")} {ms(httpCompare.summary.median_v6)} · {t("summaryMedianDelta")} {ms(httpCompare.summary.median_delta)}
              <br />
              {t("summaryP95V4")} {ms(httpCompare.summary.p95_v4)} · {t("summaryP95V6")} {ms(httpCompare.summary.p95_v6)}
            </div>
          </div>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {[
                  "#",
                  t("location"),
                  "ASN",
                  t("network"),
                  t("v4Status"),
                  t("v6Status"),
                  t("v4Total"),
                  t("v6Total"),
                  t("deltaV6V4"),
                  t("ratio"),
                  t("winner"),
                ].map((h) => (
                  <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {httpCompare.rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.idx + 1}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{formatProbeLocation(r.probe)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.asn ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4sc ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v6sc ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v4ms)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v6ms)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.delta)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{Number.isFinite(r.ratio) ? r.ratio.toFixed(2) : "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.winner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}


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
