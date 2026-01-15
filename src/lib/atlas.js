const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_POLL_MIN_MS = 1200;
const DEFAULT_POLL_MAX_MS = 12000;
const DEFAULT_STABLE_POLLS = 3;
const DEFAULT_SETTLE_AFTER_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStoredAtlasKey() {
  if (typeof window === "undefined") return "";
  try {
    return String(window.localStorage.getItem("PING6_ATLAS_API_KEY") || "").trim();
  } catch {
    return "";
  }
}

function buildHeaders({ atlasKey } = {}, extra = {}) {
  const headers = { ...extra };
  const key = String(atlasKey || getStoredAtlasKey() || "").trim();
  if (key) headers["X-Atlas-Key"] = key;
  return headers;
}

export function setStoredAtlasKey(key) {
  if (typeof window === "undefined") return;
  try {
    const clean = String(key || "").trim();
    if (clean) window.localStorage.setItem("PING6_ATLAS_API_KEY", clean);
    else window.localStorage.removeItem("PING6_ATLAS_API_KEY");
  } catch {
    // ignore
  }
}

export async function getAtlasMeasurement(id, { signal, atlasKey } = {}) {
  const url = `/api/atlas/measurements/${encodeURIComponent(id)}`;
  const res = await fetch(url, { method: "GET", headers: buildHeaders({ atlasKey }), signal });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!res.ok) {
    const msg =
      (data && (data.error || data.message)) ||
      (text && text.slice(0, 300)) ||
      `Atlas request failed (${res.status})`;
    throw new Error(String(msg));
  }
  return data;
}

export async function waitForAtlasMeasurement(
  id,
  {
    onUpdate,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,

    // Backwards compatible:
    // - pollMs (fixed interval) is still accepted
    // - settlePolls (number of stable polls before "settled") is still accepted
    pollMs,
    settlePolls,

    // Preferred (adaptive polling):
    pollMinMs = DEFAULT_POLL_MIN_MS,
    pollMaxMs = DEFAULT_POLL_MAX_MS,
    stablePolls = DEFAULT_STABLE_POLLS,
    settleAfterMs = DEFAULT_SETTLE_AFTER_MS,

    atlasKey,
  } = {}
) {
  const start = Date.now();
  let lastLen = null;
  let stable = 0;
  let firstResultAt = null;

  // If pollMs is provided, behave like legacy fixed polling (but still with jitter).
  let currentPollMs = Number.isFinite(Number(pollMs)) ? Math.max(250, Number(pollMs)) : pollMinMs;
  const effectiveStablePolls = Number.isFinite(Number(settlePolls))
    ? Math.max(1, Number(settlePolls))
    : Math.max(1, Number(stablePolls));

  function expectedTotal(measurement) {
    const n =
      Number(
        measurement?.atlas?.measurement?.probes_scheduled ??
          measurement?.atlas?.measurement?.probes_requested ??
          measurement?.atlas?.measurement?.probes ??
          measurement?.atlas?.measurement?.probes_count
      ) || 0;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  for (;;) {
    if (signal?.aborted) throw new Error("Aborted");

    const m = await getAtlasMeasurement(id, { signal, atlasKey });
    if (onUpdate) onUpdate(m);

    const status = String(m?.status || "").toLowerCase();
    const resultsLen = Array.isArray(m?.results) ? m.results.length : 0;
    const total = expectedTotal(m);

    if (status === "finished") return m;

    // If we know how many probes were scheduled, consider the measurement complete
    // once we have at least that many probe results.
    if (total && resultsLen >= total) {
      return { ...m, status: "finished", statusReason: "complete" };
    }

    if (resultsLen > 0 && !firstResultAt) firstResultAt = Date.now();

    if (lastLen !== null && resultsLen === lastLen) stable += 1;
    else stable = 0;
    lastLen = resultsLen;

    // "Settled" means no new results for a while. Only use it when we don't know
    // how many probes are expected, to avoid cutting off late-arriving probes.
    if (!total && resultsLen > 0 && firstResultAt && stable >= effectiveStablePolls) {
      if (Date.now() - firstResultAt >= settleAfterMs) {
        return { ...m, status: "finished", statusReason: "settled" };
      }
    }

    if (Date.now() - start > timeoutMs) {
      return { ...m, status: status || "unknown", statusReason: "timeout" };
    }

    // Adaptive polling:
    // - If no results yet, back off quickly.
    // - If results are streaming in, poll more frequently.
    // - If results stall (but we still expect more), back off slowly.
    if (!Number.isFinite(Number(pollMs))) {
      if (resultsLen === 0) {
        currentPollMs = Math.min(pollMaxMs, Math.round(currentPollMs * 1.6));
      } else if (stable === 0) {
        currentPollMs = pollMinMs;
      } else {
        currentPollMs = Math.min(pollMaxMs, Math.round(currentPollMs * 1.25));
      }
    }

    const jitter = Math.floor(Math.random() * 250);
    await sleep(currentPollMs + jitter);
  }
}
