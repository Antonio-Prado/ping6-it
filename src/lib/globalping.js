const API = "/api/globalping";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createMeasurement(body, signal) {
  const resp = await fetch(`${API}/measurements`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Globalping create failed (${resp.status}): ${txt}`);
  }
  return resp.json();
}

export async function getMeasurement(id, { etag, signal } = {}) {
  const headers = {};
  if (etag) headers["if-none-match"] = etag;

  const resp = await fetch(`${API}/measurements/${encodeURIComponent(id)}`, {
    method: "GET",
    headers,
    signal,
  });

  if (resp.status === 304) return { notModified: true, etag };

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Globalping get failed (${resp.status}): ${txt}`);
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

