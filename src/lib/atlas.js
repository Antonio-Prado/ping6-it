const DEFAULT_TIMEOUT_MS = 60000;

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
  { onUpdate, signal, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = 1500, settlePolls = 2, atlasKey } = {}
) {
  const start = Date.now();
  let lastLen = null;
  let stable = 0;

  for (;;) {
    if (signal?.aborted) throw new Error("Aborted");

    const m = await getAtlasMeasurement(id, { signal, atlasKey });
    if (onUpdate) onUpdate(m);

    const status = String(m?.status || "").toLowerCase();
    const resultsLen = Array.isArray(m?.results) ? m.results.length : 0;

    if (status === "finished") return m;

    if (lastLen !== null && resultsLen === lastLen) stable += 1;
    else stable = 0;
    lastLen = resultsLen;

    if (resultsLen > 0 && stable >= settlePolls) {
      return { ...m, status: "finished", statusReason: "settled" };
    }

    if (Date.now() - start > timeoutMs) {
      return { ...m, status: status || "unknown", statusReason: "timeout" };
    }

    await sleep(pollMs);
  }
}
