export async function onRequest(context) {
  const req = context.request;
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const id = context.params.id;
  const upstream = `https://api.globalping.io/v1/measurements/${encodeURIComponent(id)}`;

  const headers = new Headers(req.headers);
  headers.delete("host");

  const resp = await fetch(upstream, { method: "GET", headers });

  const outHeaders = new Headers(resp.headers);
  outHeaders.set("Cache-Control", "no-store");

  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

