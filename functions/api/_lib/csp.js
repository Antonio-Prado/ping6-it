// The Content-Security-Policy of the site. It is sent twice: as a fixed header on every file (public/_headers, which
// test/csp.test.mjs keeps equal to cspHeader() here), and with a nonce on the page itself (functions/_middleware.js).
//
// What the page loads from elsewhere:
// - challenges.cloudflare.com: Turnstile (a script and a frame);
// - static.cloudflareinsights.com, cloudflareinsights.com: Cloudflare Web Analytics (the script, and where it reports);
// - tile.openstreetmap.org: the tiles of the probe map;
// - atlas.ripe.net, www.peeringdb.com: the reference points of the probe location check, asked from the browser.
// The styles are inline (React `style` attributes and two <style> elements), hence 'unsafe-inline' for styles only.

const SCRIPT_SOURCES = ["'self'", "https://challenges.cloudflare.com", "https://static.cloudflareinsights.com"];

export function cspHeader(nonce = "") {
  const scripts = nonce ? [...SCRIPT_SOURCES, `'nonce-${nonce}'`] : SCRIPT_SOURCES;
  return [
    "default-src 'self'",
    `script-src ${scripts.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tile.openstreetmap.org",
    "connect-src 'self' https://atlas.ripe.net https://www.peeringdb.com https://cloudflareinsights.com",
    "frame-src https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function newNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
}
