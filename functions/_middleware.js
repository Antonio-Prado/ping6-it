// Adds a nonce to the Content-Security-Policy of the page. Cloudflare reads the nonce from the header and puts it on
// the inline script it adds to the page for bot detection, which the fixed policy of public/_headers would block.
// public/_routes.json limits this to the page and the API; anything that goes wrong here leaves the fixed policy.
//
// The address of the project on pages.dev serves the same site outside the zone of ping6.it, so without its firewall,
// bot detection and rate limiting rule: the page and the API are sent to ping6.it. The previews of the branches
// (<branch>.ping6-it.pages.dev) are left alone.
import { cspHeader, newNonce } from "./api/_lib/csp.js";

const PAGES_HOST = "ping6-it.pages.dev";
const SITE_ORIGIN = "https://ping6.it";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === PAGES_HOST) return Response.redirect(`${SITE_ORIGIN}${url.pathname}${url.search}`, 308);

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
