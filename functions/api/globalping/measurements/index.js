export async function onRequest(context) {
  const req = context.request;
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const upstream = "https://api.globalping.io/v1/measurements";
  const headers = new Headers(req.headers);
  headers.delete("host");

  const resp = await fetch(upstream, {
    method: "POST",
    headers,
    body: await req.arrayBuffer(),
  });

  const outHeaders = new Headers(resp.headers);
  outHeaders.set("Cache-Control", "no-store");

  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

