export async function fetchNlnogPrefix({ q, nodes, signal }) {
  const url = new URL("/api/nlnog/prefix", window.location.origin);
  url.searchParams.set("q", q);
  url.searchParams.set("nodes", nodes);

  const resp = await fetch(url.toString(), { signal });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`NLNOG prefix failed (${resp.status}): ${txt}`);
  }

  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) return resp.json();
  return resp.text();
}

