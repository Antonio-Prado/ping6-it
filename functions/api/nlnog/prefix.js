export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = url.searchParams.get("q");
  const nodes = url.searchParams.get("nodes");

  if (!q || !nodes) {
    return new Response("Missing q or nodes", { status: 400 });
  }

  const upstream = new URL("https://lg.ring.nlnog.net/api/prefix");
  upstream.searchParams.set("q", q);
  upstream.searchParams.set("nodes", nodes);

  const resp = await fetch(upstream.toString(), { method: "GET" });

  const outHeaders = new Headers(resp.headers);
  outHeaders.set("Cache-Control", "public, max-age=30");

  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

