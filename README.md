<p align="center">
  <a href="https://ping6.it">
    <img src="./public/logo-badge.svg" alt="ping6.it logo" width="220" />
  </a>
</p>

# ping6.it

**ping6.it** is a small web UI that runs the same network measurement over **IPv4 and IPv6** on the **same set of probes** and presents a side-by-side comparison.

It is intended for **quick, reproducible v4 vs v6 troubleshooting**: reachability gaps, latency deltas, loss anomalies, and routing/path asymmetries.

ping6.it supports two measurement backends:
- **Globalping** (default) for fast, lightweight measurements.
- **RIPE Atlas** (experimental) for broader probe availability (requires an API key and currently supports fewer commands).

> Experimental beta: defaults, UI layout, and comparison logic may evolve.

Live: https://ping6.it
Feedback: mailto:antonio@prado.it

## Main features

- **Fair v4/v6 comparison** by pinning both runs to the **same probes**
- **Backends:** Globalping (default) and **RIPE Atlas** (experimental)
- **Commands:** `ping`, `traceroute`, `mtr`, `dns`, `http` (Atlas: `ping`/`traceroute`/`dns` only)
- **Geo selection** (macro region + sub-regions) and **Net** filter (eyeball/datacenter, Globalping only)
- Probe filters: **limit**, **ASN**, **IPv6-capable probes only**
  - **ISP** filter is best-effort and not guaranteed by upstream metadata; prefer ASN
- **Multi-target** mode (run the same command over multiple targets)
- **Per-probe tables** (sortable) + summary stats (medians/p95 and deltas)
- **ASN details**: click an ASN to open an in-app panel with RIPEstat data (including a RPKI validity breakdown)
- **Exports:** JSON (raw bundle) and CSV (per-probe rows)
- **Share link** (settings) and **Report mode** (shareable link embedding results)
- **History (local)** stored in your browser (and run-to-run comparison)

## Table of contents

- [What ping6.it is for](#what-ping6it-is-for)
- [Backends](#backends)
- [How the v4v6 comparison works](#how-the-v4v6-comparison-works)
  - [Globalping backend](#globalping-backend)
  - [RIPE Atlas backend](#ripe-atlas-backend)
  - [Target validation](#target-validation)
- [Common controls](#common-controls)
- [Commands](#commands)
  - [ping](#ping)
  - [traceroute](#traceroute)
  - [mtr](#mtr)
  - [dns](#dns)
  - [http](#http)
- [ASN details](#asn-details)
- [Interpreting results](#interpreting-results)
- [API endpoints](#api-endpoints)
- [Limitations and notes](#limitations-and-notes)
- [Development](#development)
  - [Cloudflare Pages configuration](#cloudflare-pages-configuration)
- [Contributing](#contributing)
- [Security](#security)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## What ping6.it is for

Typical use cases:

- “IPv6 is slow” → quantify deltas and see where they appear
- “IPv6 fails but IPv4 works” → validate reachability by region / eyeball vs DC
- Resolver differences (DNS) and handshake/transfer timing differences (HTTP)
- Path asymmetry hints (traceroute / mtr), including loss patterns

The goal is not to be a full monitoring suite, but a **fast comparison UI** with reproducible runs.

## Backends

### Globalping (default)

Globalping provides a distributed probe network and an API for measurements. ping6.it uses Globalping for:

- Fast pair creation (v4 + v6) with streaming updates.
- `ping`, `traceroute`, `mtr`, `dns`, `http`.
- `Net` filtering (eyeball/datacenter) via Globalping location tags.

### RIPE Atlas (experimental)

RIPE Atlas can provide significantly more probes in some regions, but it comes with different constraints:

- Requires a **RIPE Atlas API key** (user-provided in the UI; stored locally).
- Currently supported commands: **`ping`, `traceroute`, `dns`**.
- Measurements can take longer to stream results; ping6.it shows a dedicated progress indicator.
- Geo presets are mapped to a curated set of **ISO country codes** (best-effort; see limitations).

## How the v4/v6 comparison works

ping6.it always tries to compare like-for-like by running IPv4 and IPv6 on the **same probes**.

### Globalping backend

ping6.it creates **two Globalping measurements** (v4 and v6) and ensures they run on the **same probe set**:

- First run selects probes normally (based on `From`, `Net`, limit, ASN/ISP filters, etc.)
- Second run is executed on the **exact same probes** by referencing the first measurement id as `locations`

The ordering depends on the **IPv6-capable probes only** toggle:

- **Enabled (default):**
  1) run **IPv6 first** (`ipVersion: 6`) to select probes that can execute IPv6
  2) run **IPv4** (`ipVersion: 4`) on the **same probes** by referencing the IPv6 measurement id

- **Disabled:**
  1) run **IPv4 first** (`ipVersion: 4`) to select probes
  2) run **IPv6** (`ipVersion: 6`) on the **same probes** by referencing the IPv4 measurement id

### RIPE Atlas backend

RIPE Atlas allows creating multiple measurements in a single API call. ping6.it creates the v4 and v6 measurements **together**, so they share the same allocated probes.

- With **IPv6-capable probes only** enabled, probe selection is tightened with Atlas tags so probes are expected to support **both IPv4 and IPv6**.
- With it disabled, probe selection prioritises IPv4 coverage; the IPv6 side may have fewer results if some probes lack IPv6 connectivity.

### Target validation

To keep the v4/v6 comparison meaningful and to reduce abuse, the server applies defensive validation.

- For `ping`, `traceroute`, `mtr`, and `http`, the target must be a **hostname** (IP literals are rejected).
- For `dns`:
  - **Globalping:** the input may also be an **IP literal** (e.g. `PTR`).
  - **RIPE Atlas:** the target must be a **hostname** (Atlas DNS is implemented as “query this name against a resolver”).

For `http`, the UI accepts a full URL (e.g. `https://example.com/path?x=1`) and splits it into host/path/query before calling the API.

## Common controls

### Backend
Choose the measurement network backend:

- **Globalping** (default)
- **RIPE Atlas (experimental)**

When using RIPE Atlas, you must provide an **Atlas API key** in the Settings panel.

**Privacy note:** the Atlas API key is not stored locally in your browser and is **never included in share links**.

### Target / Multi-target
- **Single target:** one hostname (or IP literal for DNS on Globalping).
- **Multi-target:** paste multiple targets (one per line). ping6.it will run them sequentially and show a consolidated summary.

### Command
Selects the measurement type:

- `ping`
- `traceroute`
- `mtr` (Globalping only)
- `dns`
- `http` (Globalping only)

Changing the command resets the UI to **Basic** mode.

### From (geo)
Selects probe location(s). The UI provides macro regions and sub-regions.

- On **Globalping**, the resulting string is sent as a Globalping location expression.
- On **RIPE Atlas**, presets are mapped to a curated set of ISO country codes (best-effort).

### Net (Globalping only)
Filters probes by network type:
- `any`
- `eyeball` (access/consumer)
- `datacenter`

Internally this is implemented via Globalping location tags.

### Probes
Number of probes to select.

- Globalping is clamped to a small max (currently 10).
- RIPE Atlas allows more (currently 50).

### ASN / ISP
Optional filters that constrain probe selection:

- **ASN:** numeric ASN (e.g. `12345`) — recommended.
- **ISP:** best-effort string label. Upstream support and metadata quality vary; prefer ASN when possible.

### IPv6-capable probes only
Ensures probe selection is driven by IPv6 reachability (or dual-stack tags on Atlas), then reuses the same probes for IPv4.

When enabled, ping6.it also uses a stricter comparison mode for summary statistics so medians are not skewed by probes that only returned one side.

### Δ alert (ms)
Optional threshold used in summaries/reports to highlight large v6-v4 deltas.

### Run / Cancel
- **Run** starts the v4/v6 measurement pair on the selected backend.
- **Cancel** aborts the in-progress run.

> A Cloudflare Turnstile challenge is used to reduce automated abuse. Verification is performed server-side.

### Raw
Enabled once both v4 and v6 results are present. Shows the **raw command output** returned by each probe for both IP versions.

### Export JSON / Export CSV
Available once results are present:
- **JSON**: raw bundle (settings + per-probe raw results)
- **CSV**: per-probe rows (useful for quick offline inspection)

### Share link / Report mode
- **Share link**: encodes current settings into URL query parameters.
- **Report mode**: encodes both settings and results into the URL (shareable, read-only view).

## Commands

> Backend availability:
> - Globalping: `ping`, `traceroute`, `mtr`, `dns`, `http`
> - RIPE Atlas: `ping`, `traceroute`, `dns`

### ping

Basic:
- target (hostname)
- probes, from/net filters

Advanced:
- **Packets:** packets per probe

Output:
- per-probe timing and loss
- summary medians for v4/v6 and Δ

### traceroute

Basic:
- target (hostname)

Advanced:
- **Proto:** `icmp` / `udp` / `tcp` (depending on backend support)
- **Port:** for UDP/TCP modes when applicable

Output:
- reached/last hop, hop count, and timing summaries (v4 vs v6)

### mtr

(Globalping only)

Basic:
- target (hostname)

Advanced:
- **Packets/hop:** packets per hop

Output:
- loss and latency summaries (v4 vs v6), reached flags

### dns

Basic:
- target (hostname, or IP literal for PTR on Globalping)

Advanced:
- **Query:** record type
- **Proto / Port**
- **Resolver:** optional; empty means probe default resolver (Globalping) / default resolver is used (Atlas)
- **trace:** if enabled, include trace information when supported

Output:
- totals (ms) and ratio v6/v4 where applicable

### http

(Globalping only)

Basic:
- target hostname, or a full URL which is split into host/path/query

Advanced:
- **Method**
- **Proto:** `http` / `https`
- **Path / Query / Port**
- **Resolver:** optional; empty means probe default resolver

Output:
- status codes and total times (ms), ratio v6/v4 where applicable

## ASN details

In per-probe tables, the ASN column is clickable.

The ASN details panel shows:

- A short explanation of what the ASN represents in the context of a probe.
- The number of probes in the current table that share that ASN.
- Metadata fetched from **RIPEstat** (best-effort):
  - AS overview (holder name, country, etc.)
  - Announced prefixes (sampled) and a prefix-size distribution
  - **RPKI validation** breakdown (valid/invalid/unknown)

The server caches ASN metadata at the edge. If you bind a KV namespace (recommended), caching becomes more reliable and the same KV can also be used for rate limiting.

## Interpreting results

### winner
A compact label indicating which stack “wins” for a given probe/summary:

- `v4` / `v6`: lower time (or better outcome) for that probe
- `tie`: values equal within reported granularity
- `v4 only` / `v6 only`: only one stack returned a usable result

### Δ v6-v4
- Positive: v6 slower than v4
- Negative: v6 faster than v4

### ratio (DNS/HTTP)
For commands where ratio is shown:
- `ratio = v6_total / v4_total`
- `> 1`: v6 slower
- `< 1`: v6 faster

## API endpoints

This repo includes Cloudflare Pages Functions used by the UI:

- `POST /api/measurements-pair`
  Creates a Globalping v4/v6 measurement pair and validates **Cloudflare Turnstile** server-side.

- `POST /api/atlas/measurements-pair`
  Creates a RIPE Atlas v4/v6 measurement pair (single Atlas API request) and validates **Cloudflare Turnstile** server-side.

- `GET /api/atlas/measurements/:id`
  Reads and normalizes RIPE Atlas measurement results (with best-effort probe metadata caching).

- `POST /api/globalping/measurements`
  Proxy/sanitizer for Globalping create requests (defensive validation/clamping).

- `GET /api/globalping/measurements/:id`
  Proxy for reading Globalping measurement results.

- `GET /api/asn/:asn`
  Fetches ASN metadata from RIPEstat (with edge caching; optional KV binding).

There is also an NLNOG Looking Glass proxy endpoint under `functions/api/nlnog/` (currently not exposed in the UI).

## Limitations and notes

- **Globalping and RIPE Atlas are different systems.** Probe availability, metadata quality, and timing differ.
- **RIPE Atlas geo presets are best-effort.** ping6.it maps regions/subregions to a curated set of country codes; Atlas may still allocate probes differently than expected.
- **RIPE Atlas is slower.** Results can take 10–60 seconds (or more) to stream in.
- **Globalping availability varies.** Some geos and filters can return “no probes found”.
- **IPv6-capable probes only** can reduce availability significantly in sparse regions.
- **ISP filtering is best-effort.** Prefer ASN when possible.
- **Turnstile is enforced for pair creation.** Automated usage without a valid challenge token will fail.
- **Pair endpoints are rate-limited.** On `429`, check `Retry-After`.
- **Report mode embeds results into the URL.** Very large results may hit URL size limits.

## Development

Requirements:
- Node.js (CI uses Node 20)

Install and run (frontend):
```bash
npm ci
npm run dev
```

Build:
```bash
npm run build
npm run preview
```

### Cloudflare Pages configuration

ping6.it is designed to run on **Cloudflare Pages** with Pages Functions.

#### Required

- `TURNSTILE_SECRET` (Pages environment variable)
- `VITE_TURNSTILE_SITEKEY` (Pages environment variable for the frontend build)

#### Optional

- `ATLAS_API_KEY` (server-side fallback for RIPE Atlas; the UI can also send `X-Atlas-Key` from the user’s local settings)
- KV binding **`ASN_META_KV`** (recommended)
  - Used for ASN metadata caching
  - Can also be used for rate limiting storage (zero-config)
- KV binding `RATE_LIMIT_KV` (optional separate storage for rate limiting)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](./SECURITY.md).

## Acknowledgements

ping6.it is built on top of:
- Globalping (API + distributed probes)
- RIPE Atlas (API + distributed probes)

## License

- Source code: GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](./LICENSE).
- Documentation and website content: Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0) — see [LICENSE-DOCS](./LICENSE-DOCS).
