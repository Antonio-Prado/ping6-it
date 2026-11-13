import { applyRateLimit } from "./rateLimit.js";

// The key of RIPE Atlas that a request runs with: the one that the visitor sends (X-Atlas-Key), or the one of this site
// (ATLAS_API_KEY). The key of the site spends the credits of its owner, so the requests that use it are bounded three ways:
// tests an hour for each address, tests a day for everybody, and probes for each test. A visitor who brings a key is not
// bounded by them.

const DEFAULTS = { hourlyPerIp: 6, daily: 200, maxProbes: 25 };

function intEnv(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function sharedAtlasLimits(env) {
  return {
    hourlyPerIp: intEnv(env?.ATLAS_SHARED_HOURLY_PER_IP, DEFAULTS.hourlyPerIp, 1, 1000),
    daily: intEnv(env?.ATLAS_SHARED_DAILY, DEFAULTS.daily, 1, 100000),
    maxProbes: intEnv(env?.ATLAS_SHARED_MAX_PROBES, DEFAULTS.maxProbes, 1, 50),
  };
}

// { key, shared }: shared is true when the key is the one of the site.
export function resolveAtlasKey(request, env) {
  const own = String(request.headers.get("X-Atlas-Key") || "").trim();
  if (own) return { key: own, shared: false };
  const site = String(env?.ATLAS_API_KEY || "").trim();
  return { key: site, shared: Boolean(site) };
}

// Count one test against the limits of the key of the site. Call it once the request is known to be genuine (after
// Turnstile), so that a request that is refused does not use the budget of the others.
// Returns null when the test may run, or { status, body, headers } to answer with.
export async function spendSharedAtlasBudget({ request, env }) {
  const limits = sharedAtlasLimits(env);

  const mine = await applyRateLimit({ request, env, scope: "atlas_shared_ip", limit: limits.hourlyPerIp, windowSec: 3600 });
  if (mine.limited) {
    return {
      status: 429,
      headers: mine.headers,
      body: {
        error: "atlas_shared_rate_limited",
        message: `The RIPE Atlas key of this site allows ${limits.hourlyPerIp} tests an hour for each address. Try later, or use your own key.`,
        retryAfter: mine.retryAfterSec,
      },
    };
  }

  const all = await applyRateLimit({ request, env, scope: "atlas_shared_day", subject: "everybody", limit: limits.daily, windowSec: 86400 });
  if (all.limited) {
    return {
      status: 429,
      headers: all.headers,
      body: {
        error: "atlas_shared_budget_spent",
        message: "The RIPE Atlas key of this site has reached its limit for today. Try tomorrow, or use your own key.",
        retryAfter: all.retryAfterSec,
      },
    };
  }

  return null;
}
