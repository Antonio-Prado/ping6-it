import { useMemo, useRef, useState } from "react";
import { waitForMeasurement } from "./lib/globalping";
import { GEO_PRESETS } from "./geoPresets";
// Turnstile (Cloudflare) - load on demand (only when the user presses Run).
let __turnstileScriptPromise = null;
function loadTurnstileScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("Turnstile can only run in the browser."));
  if (window.turnstile) return Promise.resolve();
  if (__turnstileScriptPromise) return __turnstileScriptPromise;

  __turnstileScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-turnstile="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Turnstile script.")), { once: true });
      return;
    }

    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.defer = true;
    s.dataset.turnstile = "1";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Turnstile script."));
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

const TOOLTIP_CSS = `
.tt{position:relative;display:inline-flex;align-items:center}
.tt-bubble{position:absolute;left:50%;top:100%;transform:translateX(-50%) translateY(-2px);margin-top:8px;padding:8px 10px;width:max-content;max-width:360px;white-space:normal;font-size:12px;line-height:1.35;border-radius:10px;background:#111827;color:#fff;box-shadow:0 12px 28px rgba(0,0,0,.22);opacity:0;pointer-events:none;z-index:9999;transition:opacity 120ms ease,transform 120ms ease}
.tt-bubble::before{content:"";position:absolute;top:-6px;left:50%;transform:translateX(-50%);border-width:0 6px 6px 6px;border-style:solid;border-color:transparent transparent #111827 transparent}
.tt:hover .tt-bubble,.tt:focus .tt-bubble,.tt:focus-within .tt-bubble{opacity:1;transform:translateX(-50%) translateY(0)}
.tt-info{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:999px;border:1px solid rgba(17,24,39,.35);color:rgba(17,24,39,.9);font-size:11px;line-height:1;opacity:.75;cursor:help;user-select:none}
@media (prefers-reduced-motion: reduce){.tt-bubble{transition:none}}
`;

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



function probeHeader(x, idx) {
  const p = x?.probe || {};
  return `--- probe ${idx + 1}: ${p.city || ""} ${p.country || ""} AS${p.asn || ""} ${p.network || ""}`.trim();
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
  const [cmd, setCmd] = useState("ping"); // ping | traceroute | mtr | dns | http
  const [from, setFrom] = useState("Western Europe");
  const [gpTag, setGpTag] = useState("any"); // any | eyeball | datacenter
  const [limit, setLimit] = useState(3);
  const [requireV6Capable, setRequireV6Capable] = useState(true);

  // Geo presets UI (macro + sub-regions)
  const [macroId, setMacroId] = useState("eu");
  const [subId, setSubId] = useState("eu-w");

  const macroPreset = useMemo(
    () => GEO_PRESETS.find((p) => p.id === macroId) ?? GEO_PRESETS[0],
    [macroId]
  );
  const subPresets = macroPreset?.sub ?? [];
  const canRequireV6Capable = !isIpLiteral((target || "").trim());

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


  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
  const [v4, setV4] = useState(null);
  const [v6, setV6] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const abortRef = useRef(null);

  // Turnstile (Cloudflare) - on-demand, executed only when the user presses Run.
  const turnstileContainerRef = useRef(null);
  const turnstileWidgetIdRef = useRef(null);
  const turnstilePendingRef = useRef(null);
  const [showTurnstile, setShowTurnstile] = useState(false);

  async function getTurnstileToken(signal) {
    const sitekey = import.meta.env.VITE_TURNSTILE_SITEKEY;
    if (!sitekey) {
      throw new Error('Turnstile is not configured. Set "VITE_TURNSTILE_SITEKEY" in Cloudflare Pages env vars.');
    }

    // Ensure the script is loaded.
    await loadTurnstileScript();
    if (!window.turnstile) throw new Error("Turnstile script loaded but API is not available.");

    // Ensure we have a container.
    const el = turnstileContainerRef.current;
    if (!el) throw new Error("Turnstile container is missing.");

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
          pending.reject(new Error(`Turnstile error: ${code || "unknown"}`));
        },
        "expired-callback": () => {
          const pending = turnstilePendingRef.current;
          if (!pending || pending.done) return;
          pending.done = true;
          pending.cleanup();
          pending.reject(new Error("Turnstile token expired. Please press Run again."));
        },
        "timeout-callback": () => {
          const pending = turnstilePendingRef.current;
          if (!pending || pending.done) return;
          pending.done = true;
          pending.cleanup();
          pending.reject(new Error("Turnstile timed out. Please press Run again."));
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
        reject(new Error("Cancelled."));
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

  async function createMeasurementsPair({ turnstileToken, base, measurementOptions, flow }, signal) {
    const res = await fetch("/api/measurements-pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      const msg =
        data?.error === "turnstile_failed"
          ? "Human verification failed. Please retry."
          : data?.error || `Request failed (${res.status})`;
      const err = new Error(msg);
      err.details = data;
      throw err;
    }

    return data;
  }
  async function run() {
    setErr("");
    setV4(null);
    setV6(null);
    setShowRaw(false);

    const t = target.trim();
    if (!t) return;

    let effectiveTarget = t;

    // HTTP: we also accept a full URL and split it into host/path/query.
    let httpParsed = null;
    let httpEffectiveProto = httpProto;
    let httpEffectivePath = (httpPath || "/").trim() || "/";
    let httpEffectiveQuery = (httpQuery || "").trim();
    let httpEffectivePort = (httpPort || "").trim();

    if (cmd === "http") {
      httpParsed = parseHttpInput(t);
      if (!httpParsed?.host) {
        setErr("For HTTP, enter a valid URL or hostname.");
        return;
      }

      effectiveTarget = httpParsed.host;

      if (httpParsed.protocol) {
        httpEffectiveProto = httpParsed.protocol;
        // manteniamo il selettore coerente se l'utente ha scritto http:// o https://
        if (httpProto !== httpParsed.protocol) setHttpProto(httpParsed.protocol);
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
      setErr("For the IPv4/IPv6 comparison, enter a hostname (not an IP).");
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setRunning(true);
    try {
      const probes = Math.max(1, Math.min(10, Number(limit) || 3));
      const fromWithTag = applyGpTag(from, gpTag);

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

      const base = {
        type: cmd,
        target: effectiveTarget,
        locations: [{ magic: fromWithTag || "world" }],
        limit: probes,
        inProgressUpdates: true,
      };

      const canEnforceV6 = requireV6Capable && !isIpLiteral(effectiveTarget);

      const flow = canEnforceV6 ? "v6first" : "v4first";

      // Human verification (Turnstile) is mandatory before creating measurements.
      const turnstileToken = await getTurnstileToken(ac.signal);

      // Create the IPv4/IPv6 pair server-side so the Turnstile token is validated only once.
      const { m4, m6 } = await createMeasurementsPair({ turnstileToken, base, measurementOptions, flow }, ac.signal);

      const [r4, r6] = await Promise.all([
        waitForMeasurement(m4.id, { onUpdate: setV4, signal: ac.signal }),
        waitForMeasurement(m6.id, { onUpdate: setV6, signal: ac.signal }),
      ]);

      setV4(r4);
      setV6(r6);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }

  function cancel() {
    abortRef.current?.abort();

    // Best-effort: stop any pending Turnstile flow.
    try {
      if (turnstilePendingRef.current && !turnstilePendingRef.current.done) {
        turnstilePendingRef.current.done = true;
        turnstilePendingRef.current.cleanup();
        turnstilePendingRef.current.reject(new Error("Cancelled."));
      }
    } catch {}
    try {
      if (window.turnstile && turnstileWidgetIdRef.current !== null) {
        window.turnstile.reset(turnstileWidgetIdRef.current);
      }
    } catch {}
    setShowTurnstile(false);

    setRunning(false);
  }

  }

  const showPingTable = cmd === "ping" && v4 && v6;
  const showTracerouteTable = cmd === "traceroute" && v4 && v6;
  const showMtrTable = cmd === "mtr" && v4 && v6;

  const showDnsTable = cmd === "dns" && v4 && v6;
  const showHttpTable = cmd === "http" && v4 && v6;

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

  return (
    <div style={{ fontFamily: "ui-monospace, Menlo, monospace", padding: 16, maxWidth: 1100, margin: "0 auto", minHeight: "100vh", display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
      <style>{TOOLTIP_CSS}</style>
<div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
  <img src="/logo-badge.svg" alt="Ping6" width="28" height="28" />
  <span style={{ fontSize: 18, fontWeight: 700 }}>ping6.it</span>
 {" · "}
  <span style={{ fontSize: 14, opacity: 0.85 }}>
    IPv4 vs IPv6, side by side
  </span>
</div>
<div style={{ marginTop: 8, marginBottom: 16, fontSize: 14, opacity: 0.85 }}>
  Experimental beta: features may change and results may vary{" "}
 {" · "}
  <a href="mailto:antonio@prado.it?subject=Ping6%20feedback" style={{ textDecoration: "underline" }}>
    Feedback welcome
  </a>
  {" · "}
  <a
    href="https://github.com/Antonio-Prado/ping6-it#readme"
    target="_blank"
    rel="noopener noreferrer"
    style={{ textDecoration: "underline" }}
  >
    Docs
  </a>
  {" · "}
  <a href={sourceUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
    Source{shortSha ? ` @ ${shortSha}` : ""}
  </a>
  {" · "}
  <a href={agplUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
    AGPL
  </a>
  {" · "}
  <a href={ccUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
    CC BY-NC
  </a>
</div>


      {/* Globalping controls */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Command <Help text="Measurement type to run. IPv4 and IPv6 are executed on the same probes for a fair comparison." />{" "}
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
            <option value="mtr">mtr</option>
            <option value="dns">dns</option>
            <option value="http">http</option>
          </select>
        </label>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Net <Help text="Probe network profile filter: any, eyeball (access/consumer), or datacenter." />{" "}
          <select value={gpTag} onChange={(e) => setGpTag(e.target.value)} disabled={running} style={{ padding: 6 }}>
            <option value="any">any</option>
            <option value="eyeball">eyeball</option>
            <option value="datacenter">datacenter</option>
          </select>
        </label>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          From <Help text="Where probes are selected (Globalping location string). Presets below can fill this automatically." />{" "}
          <input value={from} onChange={(e) => setFrom(e.target.value)} disabled={running} style={{ padding: 6, width: 220 }} />
        </label>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Probes <Help text="Number of probes to run (1–10). More probes improve coverage but take longer." />{" "}
          <input value={limit} onChange={(e) => setLimit(e.target.value)} disabled={running} style={{ padding: 6, width: 70 }} />
        </label>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={requireV6Capable}
              onChange={(e) => setRequireV6Capable(e.target.checked)}
              disabled={running || !canRequireV6Capable}
            />
            IPv6-capable probes only
          </label>
          <Help text="Select only probes that can run IPv6, then run IPv4 on the same probes for a fair comparison. Requires a hostname target." />
        </div>


        {advanced && (cmd === "ping" || cmd === "mtr") && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {cmd === "mtr" ? "Packets/hop" : "Packets"} <Help text="Packets per probe (ping) or per hop (mtr)." />{" "}
            <input value={packets} onChange={(e) => setPackets(e.target.value)} disabled={running} style={{ padding: 6, width: 70 }} />
          </label>
        )}

        {(cmd === "traceroute" || cmd === "mtr") && (
          <>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              Proto <Help text="Transport protocol used by traceroute/mtr (ICMP, UDP, TCP)." />{" "}
              <select value={trProto} onChange={(e) => setTrProto(e.target.value)} disabled={running} style={{ padding: 6 }}>
                <option value="ICMP">ICMP</option>
                <option value="UDP">UDP</option>
                <option value="TCP">TCP</option>
              </select>
            </label>

            {advanced && ((cmd === "traceroute" && trProto === "TCP") || (cmd === "mtr" && trProto !== "ICMP")) && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                Port <Help text="Destination port (used for TCP traceroute or UDP/TCP mtr when applicable)." />{" "}
                <input value={trPort} onChange={(e) => setTrPort(e.target.value)} disabled={running} style={{ padding: 6, width: 90 }} />
              </label>
            )}
          </>
        )}

        {cmd === "dns" && (
          <>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              Query <Help text="DNS record type to query (A, AAAA, MX, TXT, etc.)." />{" "}
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
                  Proto <Help text="DNS transport protocol: UDP (default) or TCP." />{" "}
                  <select value={dnsProto} onChange={(e) => setDnsProto(e.target.value)} disabled={running} style={{ padding: 6 }}>
                    <option value="UDP">UDP</option>
                    <option value="TCP">TCP</option>
                  </select>
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Port <Help text="DNS server port (default: 53)." />{" "}
                  <input
                    value={dnsPort}
                    onChange={(e) => setDnsPort(e.target.value)}
                    disabled={running}
                    style={{ padding: 6, width: 70 }}
                  />
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Resolver <Help text="Override the resolver used by probes (IP or hostname). Leave empty to use the probe default resolver." />{" "}
                  <input
                    value={dnsResolver}
                    onChange={(e) => setDnsResolver(e.target.value)}
                    disabled={running}
                    placeholder="(empty = default)"
                    style={{ padding: 6, width: 220 }}
                  />
                </label>

                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={dnsTrace} onChange={(e) => setDnsTrace(e.target.checked)} disabled={running} />
                    trace
                  </label>
                  <Help text="Enable DNS trace (when supported) to see the resolution path and timing details." />
                </div>
              </>
            )}
          </>
        )}
        {cmd === "http" && (
          <>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              Method <Help text="HTTP method used for the request." />{" "}
              <select value={httpMethod} onChange={(e) => setHttpMethod(e.target.value)} disabled={running} style={{ padding: 6 }}>
                {["GET", "HEAD", "OPTIONS"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              Proto <Help text="HTTP protocol: HTTP, HTTPS, or HTTP2 (HTTPS implies TLS)." />{" "}
              <select value={httpProto} onChange={(e) => setHttpProto(e.target.value)} disabled={running} style={{ padding: 6 }}>
                <option value="HTTP">HTTP</option>
                <option value="HTTPS">HTTPS</option>
                <option value="HTTP2">HTTP2</option>
              </select>
            </label>

            {advanced && (
              <>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Path <Help text="Request path (e.g. / or /index.html). If you paste a full URL in Target, path may be extracted automatically." />{" "}
                  <input value={httpPath} onChange={(e) => setHttpPath(e.target.value)} disabled={running} style={{ padding: 6, width: 180 }} />
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Query <Help text="Query string without '?', e.g. a=1&b=2. If you paste a full URL in Target, query may be extracted automatically." />{" "}
                  <input
                    value={httpQuery}
                    onChange={(e) => setHttpQuery(e.target.value)}
                    disabled={running}
                    placeholder="(optional)"
                    style={{ padding: 6, width: 160 }}
                  />
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Port <Help text="Override destination port. Leave empty for defaults (80/443)." />{" "}
                  <input
                    value={httpPort}
                    onChange={(e) => setHttpPort(e.target.value)}
                    disabled={running}
                    placeholder="default"
                    style={{ padding: 6, width: 90 }}
                  />
                </label>

                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Resolver <Help text="Override the resolver used by probes for the HTTP target (IP or hostname). Leave empty to use the probe default resolver." />{" "}
                  <input
                    value={httpResolver}
                    onChange={(e) => setHttpResolver(e.target.value)}
                    disabled={running}
                    placeholder="(empty = default)"
                    style={{ padding: 6, width: 220 }}
                  />
                </label>
              </>
            )}
          </>
        )}

        <Tip text="Target hostname. For HTTP you can paste a full URL; for DNS choose the record type above. Using a hostname is recommended for a fair IPv4/IPv6 comparison.">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={cmd === "dns" ? "name (e.g. example.com)" : cmd === "http" ? "URL or hostname (e.g. https://example.com/)" : "hostname (e.g. example.com)"}
          style={{ padding: 8, minWidth: 260 }}
          disabled={running}
        />
        </Tip>

        <Tip text="Start the measurements (IPv4 and IPv6 side by side).">
          <button onClick={run} disabled={running} style={{ padding: "8px 12px" }}>
            Run
          </button>
        </Tip>
        <Tip text="Abort the current run.">
          <button onClick={cancel} disabled={!running} style={{ padding: "8px 12px" }}>
            Cancel
          </button>
        </Tip>
        <Tip text="Toggle advanced options for the selected command.">
          <button onClick={() => setAdvanced((s) => !s)} disabled={running} style={{ padding: "8px 12px" }}>
            {advanced ? "Basic" : "Advanced"}
          </button>
        </Tip>
        <Tip text="Show or hide the raw Globalping output for each probe (IPv4 and IPv6).">
          <button
            onClick={() => setShowRaw((s) => !s)}
            disabled={!v4 || !v6}
            style={{ padding: "8px 12px" }}
          >
            {showRaw ? "Hide raw" : "Raw"}
          </button>
        </Tip>
        <div style={{ display: showTurnstile ? "block" : "none", width: "100%" }}>
          <div style={{ marginTop: 6 }}>
            <div ref={turnstileContainerRef} />
          </div>
        </div>

      </div>

      {/* quick presets: macro regions + sub-regions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        {GEO_PRESETS.map((p) => (
          <Tip key={p.id} text={`Preset: ${p.label}. Updates the "From" field.`}>
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
          <Tip text="Refine probes within the selected macro-region.">
            <select
              value={subId}
              onChange={(e) => selectSub(e.target.value)}
              disabled={running}
              style={{ padding: 6 }}
            >
            <option value="">All {macroPreset.label}</option>
            {subPresets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          </Tip>
        )}
      </div>

      {err && (
        <div style={{ background: "#fee", color: "#111", border: "1px solid #f99", padding: 12, marginBottom: 12, whiteSpace: "pre-wrap" }}>
          {err}
        </div>
      )}

            {/* Ping compare table */}
      {showPingTable && pingCompare && (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <div style={{ margin: "0 0 8px 0" }}>
            <h3 style={{ margin: "0 0 6px 0" }}>Ping RTT (v4 vs v6)</h3>
            <div style={{ opacity: 0.85 }}>
              both: {pingCompare.summary.both}/{pingCompare.summary.n} · median avg v4 {ms(pingCompare.summary.median_avg_v4)} · median avg v6{" "}
              {ms(pingCompare.summary.median_avg_v6)} · Δ {ms(pingCompare.summary.median_delta_avg)}
              <br />
              p95 avg v4 {ms(pingCompare.summary.p95_avg_v4)} · p95 avg v6 {ms(pingCompare.summary.p95_avg_v6)} · median loss v4{" "}
              {pct(pingCompare.summary.median_loss_v4)} · median loss v6 {pct(pingCompare.summary.median_loss_v6)}
            </div>
          </div>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {["#", "location", "ASN", "network", "v4 avg", "v4 loss", "v6 avg", "v6 loss", "Δ v6-v4", "winner"].map((h) => (
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
                    {r.probe ? `${r.probe.city}, ${r.probe.country}` : "-"}
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
            <h3 style={{ margin: "0 0 6px 0" }}>Traceroute to destination (v4 vs v6)</h3>
            <div style={{ opacity: 0.85 }}>
              both: {trCompare.summary.both}/{trCompare.summary.n} · median v4 {ms(trCompare.summary.median_v4)} · median v6 {ms(trCompare.summary.median_v6)} · Δ{" "}
              {ms(trCompare.summary.median_delta)}
              <br />
              p95 v4 {ms(trCompare.summary.p95_v4)} · p95 v6 {ms(trCompare.summary.p95_v6)}
            </div>
          </div>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {[
                  "#",
                  "location",
                  "ASN",
                  "network",
                  "v4 reached",
                  "v4 hops",
                  "v4 dst",
                  "v6 reached",
                  "v6 hops",
                  "v6 dst",
                  "Δ v6-v4",
                  "winner",
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
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.city ? `${r.probe.city}, ${r.probe.country}` : "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.asn ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>

                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4reached ? "yes" : "no"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4hops ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v4dst)}</td>

                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v6reached ? "yes" : "no"}</td>
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

      {/* MTR compare table */}
      {showMtrTable && mtrCompare && (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <div style={{ margin: "0 0 8px 0" }}>
            <h3 style={{ margin: "0 0 6px 0" }}>MTR to destination (v4 vs v6)</h3>
            <div style={{ opacity: 0.85 }}>
              both: {mtrCompare.summary.both}/{mtrCompare.summary.n} · median avg v4 {ms(mtrCompare.summary.median_avg_v4)} · median avg v6{" "}
              {ms(mtrCompare.summary.median_avg_v6)} · Δ {ms(mtrCompare.summary.median_delta_avg)}
              <br />
              median loss v4 {pct(mtrCompare.summary.median_loss_v4)} · median loss v6 {pct(mtrCompare.summary.median_loss_v6)} · Δ{" "}
              {pct(mtrCompare.summary.median_delta_loss)}
            </div>
          </div>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {[
                  "#",
                  "location",
                  "ASN",
                  "network",
                  "v4 reached",
                  "v4 hops",
                  "v4 loss",
                  "v4 avg",
                  "v6 reached",
                  "v6 hops",
                  "v6 loss",
                  "v6 avg",
                  "Δ avg",
                  "Δ loss",
                  "winner",
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
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.city ? `${r.probe.city}, ${r.probe.country}` : "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.asn ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.network ?? "-"}</td>

                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4reached ? "yes" : "no"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v4hops ?? "-"}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{pct(r.v4loss)}</td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r.v4avg)}</td>

                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.v6reached ? "yes" : "no"}</td>
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

      {/* DNS timing compare table */}
      {showDnsTable && dnsCompare && (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <div style={{ margin: "0 0 8px 0" }}>
            <h3 style={{ margin: "0 0 6px 0" }}>DNS timings (v4 vs v6)</h3>
            <div style={{ opacity: 0.85 }}>
              both: {dnsCompare.summary.both}/{dnsCompare.summary.n} · median v4 {ms(dnsCompare.summary.median_v4)} ·
              median v6 {ms(dnsCompare.summary.median_v6)} · Δ {ms(dnsCompare.summary.median_delta)}
              <br />
              p95 v4 {ms(dnsCompare.summary.p95_v4)} · p95 v6 {ms(dnsCompare.summary.p95_v6)}
            </div>
          </div>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {["#", "location", "ASN", "network", "v4 total", "v6 total", "Δ v6-v4", "ratio", "winner"].map((h) => (
                  <th
                    key={h}
                    style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}
                  >
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
                    {r.probe?.city ? `${r.probe.city}, ${r.probe.country}` : "-"}
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
            <h3 style={{ margin: "0 0 6px 0" }}>HTTP timings (v4 vs v6)</h3>
            <div style={{ opacity: 0.85 }}>
              both: {httpCompare.summary.both}/{httpCompare.summary.n} · median v4 {ms(httpCompare.summary.median_v4)} ·
              median v6 {ms(httpCompare.summary.median_v6)} · Δ {ms(httpCompare.summary.median_delta)}
              <br />
              p95 v4 {ms(httpCompare.summary.p95_v4)} · p95 v6 {ms(httpCompare.summary.p95_v6)}
            </div>
          </div>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {["#", "location", "ASN", "network", "v4 status", "v6 status", "v4 total", "v6 total", "Δ v6-v4", "ratio", "winner"].map((h) => (
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
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.probe?.city ? `${r.probe.city}, ${r.probe.country}` : "-"}</td>
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
            <h3 style={{ margin: "0 0 6px 0" }}>RAW v4</h3>
            <pre style={preStyle}>
              {v4.results?.map((x, idx) => `${probeHeader(x, idx)}\n${x.result?.rawOutput ?? ""}\n`).join("\n")}
            </pre>
          </div>

          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: "0 0 6px 0" }}>RAW v6</h3>
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
        Made by{" "}
        <a href="https://www.linkedin.com/in/antoniopradoit/" target="_blank" rel="noopener noreferrer">
          The Internet Floopaloo
        </a>
      </footer>
    </div>
  );
}
