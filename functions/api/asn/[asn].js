const RIPESTAT_AS_OVERVIEW = "https://stat.ripe.net/data/as-overview/data.json";

function json(body, status = 200, cacheControl = "public, max-age=86400, stale-while-revalidate=43200") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}

function normalizeAsnParam(v) {
  const s = String(v || "").trim();
  if (!/^[0-9]{1,10}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n > 4294967295) return null;
  return String(Math.trunc(n));
}

export async function onRequest(context) {
  const asn = normalizeAsnParam(context?.params?.asn);
  if (!asn) {
    return json({ error: "bad_request", message: "Invalid ASN." }, 400, "no-store");
  }

  const upstream = new URL(RIPESTAT_AS_OVERVIEW);
  upstream.searchParams.set("resource", asn);

  let resp;
  try {
    resp = await fetch(upstream.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch (e) {
    return json({ error: "upstream_unreachable", message: "RIPEstat request failed." }, 502, "no-store");
  }

  if (!resp.ok) {
    return json(
      { error: "upstream_error", message: "RIPEstat returned an error.", status: resp.status },
      502,
      "no-store"
    );
  }

  let body;
  try {
    body = await resp.json();
  } catch {
    return json({ error: "upstream_invalid", message: "RIPEstat returned invalid JSON." }, 502, "no-store");
  }

  const data = body && typeof body === "object" ? body.data : null;
  const block = data && typeof data === "object" ? data.block : null;

  return json({
    asn: Number(asn),
    holder: data?.holder ?? null,
    announced: typeof data?.announced === "boolean" ? data.announced : null,
    registry: block
      ? {
          name: block?.name ?? null,
          desc: block?.desc ?? null,
          resource: block?.resource ?? null,
        }
      : null,
    source: "ripestat-as-overview",
  });
}
