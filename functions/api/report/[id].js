const REPORT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function getReportsKv(env) {
  // Zero-config fallback: reuse ASN_META_KV if you don't want to create a dedicated namespace.
  return env?.REPORT_KV || env?.ASN_META_KV || null;
}

export async function onRequestGet(context) {
  const { params, env } = context;

  const id = String(params?.id || "").trim();
  if (!REPORT_ID_RE.test(id)) return json({ error: "invalid_id" }, 400);

  const kv = getReportsKv(env);
  if (!kv?.get) {
    return json({ error: "REPORT_KV (or ASN_META_KV fallback) not bound" }, 501);
  }

  const key = `__report:v1:${id}`;

  let value = null;
  try {
    value = await kv.get(key, { type: "json" });
  } catch {
    try {
      value = await kv.get(key, "json");
    } catch {
      value = null;
    }
  }

  if (!value) return json({ error: "not_found" }, 404);

  const payload = value?.payload;
  if (!payload) return json({ error: "corrupt" }, 500);

  return json(
    {
      id: value?.id || id,
      createdAt: value?.createdAt || null,
      expiresAt: value?.expiresAt || null,
      payload,
    },
    200
  );
}
