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
      retryAfter: resp.headers.get("retry-after") || undefined,
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
      retryAfter: resp.headers.get("retry-after") || undefined,
    });
  }

  const newEtag = resp.headers.get("etag") || undefined;
  const json = await resp.json();
  return { notModified: false, etag: newEtag, json };
}

export async function waitForMeasurement(id, { onUpdate, signal } = {}) {
  let etag;

  while (true) {
    const res = await getMeasurement(id, { etag, signal });
    if (!res.notModified) {
      etag = res.etag;
      onUpdate?.(res.json);
      if (res.json.status !== "in-progress") return res.json;
    }
    await sleep(500);
  }
}
