// Adds a nonce to the Content-Security-Policy of the page. Cloudflare reads the nonce from the header and puts it on
// the inline script it adds to the page for bot detection, which the fixed policy of public/_headers would block.
// public/_routes.json limits this to the page and the API; anything that goes wrong here leaves the fixed policy.
import { cspHeader, newNonce } from "./api/_lib/csp.js";

export async function onRequest(context) {
  const response = await context.next();
  try {
    if (!(response.headers.get("content-type") || "").includes("text/html")) return response;
    const out = new Response(response.body, response);
    out.headers.set("Content-Security-Policy", cspHeader(newNonce()));
    return out;
  } catch {
    return response;
  }
}
