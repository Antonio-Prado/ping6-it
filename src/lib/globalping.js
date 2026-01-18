const API = "/api/globalping";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readTextSafe(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function headerSafe(headers, name) {
  try {
    return headers?.get?.(name) || "";
  } catch {
    return "";
  }
}

function buildRateLimitMeta(headers) {
  const retryAfterHeader = headerSafe(headers, "retry-after");
  const rateLimitResetHeader = headerSafe(headers, "x-ratelimit-reset");
  const resetSec = Number(rateLimitResetHeader);

  const retryAfter = retryAfterHeader
    ? retryAfterHeader
    : Number.isFinite(resetSec) && resetSec > 0
      ? `${Math.ceil(resetSec)}s`
      : undefined;

  return {
    retryAfter,
    rateLimitLimit: headerSafe(headers, "x-ratelimit-limit") || undefined,
    rateLimitRemaining: headerSafe(headers, "x-ratelimit-remaining") || undefined,
    rateLimitReset: rateLimitResetHeader || undefined,
    creditsRemaining: headerSafe(headers, "x-credits-remaining") || undefined,
    requestCost: headerSafe(headers, "x-request-cost") || undefined,
  };
}

function makeHttpError(message, meta) {
  const err = new Error(message);
  err.kind = "http";
  if (meta && typeof meta === "object") {
    Object.assign(err, meta);
  }
  return err;
}

export async function createMeasurement(body, signal) {
  const url = `${API}/measurements`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const text = await readTextSafe(resp);
    const data = tryParseJson(text) || null;
    throw makeHttpError(`Globalping request failed (${resp.status})`, {
      status: resp.status,
      url,
      data,
      text,
      ...buildRateLimitMeta(resp.headers),
    });
  }

  return resp.json();
}

export async function getMeasurement(id, { etag, signal } = {}) {
  const headers = {};
  if (etag) headers["if-none-match"] = etag;

  const url = `${API}/measurements/${encodeURIComponent(id)}`;
  const resp = await fetch(url, {
    method: "GET",
    headers,
    signal,
  });

  if (resp.status === 304) return { notModified: true, etag };

  if (!resp.ok) {
    const text = await readTextSafe(resp);
    const data = tryParseJson(text) || null;
    throw makeHttpError(`Globalping request failed (${resp.status})`, {
      status: resp.status,
      url,
      data,
      text,
      ...buildRateLimitMeta(resp.headers),
    });
  }

  const newEtag = resp.headers.get("etag") || undefined;
  const json = await resp.json();
  return { notModified: false, etag: newEtag, json };
}

export async function waitForMeasurement(
  id,
  { onUpdate, onMeta, signal, pollMs = 500, timeoutMs = 120000 } = {}
) {
  let etag;
  let lastJson = null;
  let consecutiveErrors = 0;
  const start = Date.now();

  const transientHttp = new Set([408, 425, 500, 502, 503, 504, 520, 521, 522, 524]);

  function isTransientError(err, elapsedMs) {
    const status = Number(err?.status);
    if (!Number.isFinite(status)) return true; // network / CORS / fetch aborted, etc.
    if (status == 404 && elapsedMs < 5000) return true; // eventual consistency
    return transientHttp.has(status);
  }

  while (true) {
    if (signal?.aborted) throw new Error("Aborted");

    const now = Date.now();
    const elapsedMs = now - start;
    if (elapsedMs > timeoutMs) {
      if (lastJson) return { ...lastJson, status: lastJson.status || "unknown", statusReason: "timeout" };
      const err = new Error("Timed out while waiting for measurement");
      err.kind = "timeout";
      throw err;
    }

    try {
      const res = await getMeasurement(id, { etag, signal });
      consecutiveErrors = 0;
      if (!res.notModified) {
        etag = res.etag;
        lastJson = res.json;
        onUpdate?.(res.json);
        if (res.json?.status !== "in-progress") return res.json;
      }

      if (onMeta) {
        try {
          onMeta({
            polledAt: Date.now(),
            status: String(lastJson?.status || "").toLowerCase() || "unknown",
            etag,
            elapsedMs,
            timeoutMs,
          });
        } catch {
          // ignore
        }
      }

      await sleep(Math.max(250, Number(pollMs) || 500));
    } catch (err) {
      consecutiveErrors += 1;

      const transient = isTransientError(err, elapsedMs);
      if (!transient || consecutiveErrors >= 6) throw err;

      // Back off on transient failures.
      const backoffMs = Math.min(5000, 300 * Math.pow(2, Math.min(6, consecutiveErrors)));

      if (onMeta) {
        try {
          onMeta({
            polledAt: Date.now(),
            status: String(lastJson?.status || "").toLowerCase() || "unknown",
            etag,
            elapsedMs,
            timeoutMs,
            error: String(err?.message || "request failed"),
            consecutiveErrors,
            nextPollInMs: backoffMs,
          });
        } catch {
          // ignore
        }
      }

      await sleep(backoffMs);
    }
  }
}

