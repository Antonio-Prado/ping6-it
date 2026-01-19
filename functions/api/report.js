// Compatibility shim for Cloudflare Pages Functions routing.
//
// In some deployments, requests to /api/report were not routed to
// functions/api/report/index.js (falling back to the SPA HTML and returning 405
// on POST). Adding this file makes /api/report unambiguous.

export { onRequestPost } from "./report/index.js";

