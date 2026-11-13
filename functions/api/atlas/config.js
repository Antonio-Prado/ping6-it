import { resolveAtlasKey, sharedAtlasLimits } from "../_lib/atlasKey.js";

// What the page needs to know before it asks for a key of RIPE Atlas: whether this site has one of its own, and the limits
// that go with it. Nothing about the key itself.
export async function onRequestGet(context) {
  const { env } = context;
  const site = resolveAtlasKey(new Request("https://ping6.it/"), env);
  const limits = sharedAtlasLimits(env);
  const body = site.shared
    ? { sharedKey: true, maxProbes: limits.maxProbes, hourlyPerIp: limits.hourlyPerIp }
    : { sharedKey: false };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
