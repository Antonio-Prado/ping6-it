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
- **RIPE Atlas** (experimental) for broader probe availability (no API key needed when the site provides its own; currently supports fewer commands).

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
- **Trombone routing** hints on `traceroute`/`mtr`: a family that takes a detour on a probe where the other one proves the target is near
- **Probe location check**: probes that cannot be where they are said to be, proved with the speed of light in fibre (exchange points, DNS root servers, RIPE Atlas anchors)
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
- [Trombone routing and probe locations](#trombone-routing-and-probe-locations)
  - [The speed of Internet](#the-speed-of-internet)
  - [Trombone routing](#trombone-routing)
  - [Where the probes are](#where-the-probes-are)
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

- Needs a **RIPE Atlas API key**: the one of the site (`ATLAS_API_KEY`, see [Cloudflare Pages configuration](#cloudflare-pages-configuration)), within its limits, or one that the visitor pastes in the UI (kept in memory, never stored).
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

When the site has a RIPE Atlas key of its own, no key is asked for: measurements run with the key of the site, on up to 25 probes for each test and 6 tests an hour for each address (200 a day for everybody). You can still paste your **own Atlas API key** to use your credits and lift those limits (up to 50 probes). Without a key of the site, your own key is required.

**Privacy note:** your own Atlas API key is not stored locally in your browser and is **never included in share links**.

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
- **Report mode**: creates a shareable, read-only view that includes the results.
  - With `REPORT_KV` (or `ASN_META_KV` fallback) configured, results are stored in KV and shared as a short link: `/r/<id>`.
  - Without KV, ping6.it falls back to a long URL that embeds the full report bundle (may hit URL size limits).

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

## Trombone routing and probe locations

Under the tables of a `traceroute` or an `mtr`, ping6.it reads the two families of each probe for **trombone routing**, and can check **where each probe really is**. For the probes of RIPE Atlas the location check is available under every command.

The method was built and tested in [ASPA Explorer](https://aspa.ping6.it/guide.html#probe-place) (University of Padova) and is adapted here to what ping6.it measures: the same target, over IPv4 and IPv6, from the same probes. The code is in `src/lib/soi.js` (pure functions, with tests in `test/`).

### The speed of Internet

Light in fibre travels at about two thirds of its speed in vacuum: about **200 km in a millisecond**. Izhikevich and others call it the *speed of Internet* (SOI). It turns a delay into a bound on a distance:

- a round trip of `t` ms proves that the two ends are **at most** `t/2 × 200` km apart;
- a round trip to a point `d` km away takes **at least** `2 × d / 200` ms.

Queues, slow answers and tunnels only add time, so the bound never lies in the other direction: a path can look longer than it is, never shorter.

### Trombone routing

A trombone is a path between two points that are near each other which goes far away and comes back (in the literature, a path that starts and ends in one country and crosses another one). Told by its delay, it needs to know that the two points are near, and ping6.it does not know where a target is. But it reaches the same target twice from the same probe, and **the faster family is the proof**: if IPv4 gets there in 8 ms, the target is within 800 km of the probe, and no distance explains an IPv6 round trip of 140 ms.

For each probe, the round trip to the target is taken **net of the access network**: from the first public address of the path to the target (a modem, a tunnel or a mobile network add a delay that says nothing about the route). The shortest round trip of each hop is used. Then:

| Faster family | Slower family | Reading |
| --- | --- | --- |
| up to 50 ms | 100 ms or more | **trombone over** the slower family |
| up to 50 ms | more than 50 ms, and at least 25 ms more than the faster one | the slower family is **longer** than it should be |
| up to 50 ms | anything else | no trombone |
| more than 50 ms | | *far on both*: the target may simply be far, nothing is said |

A probe whose trace stops before the target on either family is not read (the delay of a router on the way says nothing about the target), and neither is a probe that is not where it is said to be.

What it cannot tell: a name can be served to one family from elsewhere (an anycast or a CDN with fewer sites over IPv6), which looks the same as a detour of the path. Either way it is a **lead** to follow in the hops of that probe, not a proof.

The bands (50 and 100 ms) are the ones ASPA Explorer uses. They follow the LACNIC 2022 Connectivity Study, which finds that the round trips that stay inside a country are mostly below 50 ms and that those that leave it are typically above 100 ms; they are a reading, not a standard.

### Where the probes are

Every reading supposes that a probe is where it is said to be. Globalping places a probe by the address it connects from (geolocation databases); the hosts of RIPE Atlas place their probes on a map. Both can be wrong: [Izhikevich and others](https://doi.org/10.1145/3777912.3839804) ("Rooting Out Incorrect RIPE Atlas Probe Geolocations", IMC 2026) found that 2.4% of the probes of RIPE Atlas could not be where they were said to be, about half of them more than 1,000 km away. A probe that is not where it is said to be makes a detour that is not there.

The check is the SOI bound, applied to points whose place is known: **a round trip to such a point shorter than light in fibre needs from the declared place of the probe, less a margin, is impossible from that place**, so the probe is elsewhere, within the distance that the round trip allows from that point. The probe is marked in the table with the figures that prove it, and its delays are not read as a trombone. Three kinds of points are used:

- **Exchange points** (`traceroute` and `mtr`, both backends). A traceroute has its own reference points: a hop that answers from the LAN of an exchange is on the other side of its switch, so the packet went at least to the nearest site of that exchange and came back. The prefixes of the LANs and the coordinates of the facilities come from [PeeringDB](https://www.peeringdb.com/). The hops of both families are used. Margin: 100 km, because both places are cities and not points.
- **DNS root servers** (RIPE Atlas probes, every command). This is the method of the study above. Every probe of RIPE Atlas asks each of the thirteen root servers, every four minutes, which of its instances answers (`hostname.bind`, public built-in measurements). The place of an instance (`public/data/root-sites.json`, about 1,600 of them) comes from the list that its operator publishes on [root-servers.org](https://root-servers.org/) (sites, coordinates of the town, identifiers) or, where the operator publishes no identifiers (C and E, part of A and J), from the code of a city or airport in the name of the instance. The anchors of RIPE Atlas are the judges: an instance that an anchor reaches in less time than light allows from that place is dropped, whoever placed it, and an instance placed only by its name is kept when an anchor reached it within 5 ms. An answer that is not an instance of the root (often a resolver or a firewall of the network of the probe) is not used. Margin: 300 km, because the place is the one of a city.
- **Anchors of RIPE Atlas** (every command, both backends, on request). The anchors are probes of RIPE Atlas in data centres, whose places are checked. A probe that is elsewhere shows it with a round trip too short to an anchor near where it really is, so the anchors are spread: up to three in the countries of the probes, as far from each other as they can be, and one near each of a few points of the world (eleven for RIPE Atlas: Frankfurt, London, Ashburn, San Jose, São Paulo, Johannesburg, Dubai, Mumbai, Singapore, Tokyo and Sydney; four for Globalping: Frankfurt, Ashburn, São Paulo and Singapore). The pings are new measurements on the same probes, so they start only when you press *Ping the anchors of RIPE Atlas*: up to 7 more measurements on Globalping, up to 14 one-off pings on RIPE Atlas (they count as one test against the limits of the key of the site). Margin: 100 km.

Not every probe can be checked without the anchors: a path may cross no exchange, and Globalping cannot ask a root server which instance answers. The result says how many probes could be checked.

**Privacy.** The check is off until you press *Check where the probes are* (the choice is remembered in your browser, and a checkbox turns it off). When it is on, your browser asks PeeringDB for five tables, once a day (they are kept in your browser; PeeringDB limits how often an address can ask for them, and its data are not copied to ping6.it), and RIPE Atlas for the answers of the root servers to the probes of the measurement, for the list of the anchors (once a day) and for the results of the pings to the anchors, which are public. Both see your address. The reading of the trombone uses only the results already on the page.

`public/data/root-sites.json` is rebuilt by hand with `node scripts/build-root-sites.mjs` (data of root-servers.org, of RIPE Atlas and of [OurAirports](https://ourairports.com/), public domain).

## API endpoints

This repo includes Cloudflare Pages Functions used by the UI:

- `POST /api/measurements-pair`
  Creates a Globalping v4/v6 measurement pair and validates **Cloudflare Turnstile** server-side.

- `POST /api/atlas/measurements-pair`
  Creates a RIPE Atlas v4/v6 measurement pair (single Atlas API request) and validates **Cloudflare Turnstile** server-side.

- `GET /api/atlas/measurements/:id`
  Reads and normalizes RIPE Atlas measurement results (with best-effort probe metadata caching).

- `GET /api/atlas/config`
  Tells the UI whether the site has a RIPE Atlas key of its own, and the limits that go with it (nothing about the key).

- `POST /api/atlas/anchor-pings`
  Creates one-off pings from the probes of a measurement to a few RIPE Atlas anchors, for the probe location check (Turnstile, rate limits; only anchors can be aimed at).

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
- **Trombone readings are leads, not proofs**, and the probe location check needs a reference point on the path or, for RIPE Atlas, an answer of a root server (see [Trombone routing and probe locations](#trombone-routing-and-probe-locations)).
- **Report mode prefers short links** when `REPORT_KV` (or `ASN_META_KV` fallback) is configured. Without KV, it falls back to embedding results into the URL (large reports may hit URL size limits).

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

Test and lint:
```bash
npm test
npm run lint
```

### Cloudflare Pages configuration

ping6.it is designed to run on **Cloudflare Pages** with Pages Functions.

#### Required

- `TURNSTILE_SECRET` (Pages environment variable)
- `VITE_TURNSTILE_SITEKEY` (Pages environment variable for the frontend build)

#### Optional

- `ATLAS_API_KEY` (Pages secret): the RIPE Atlas key of the site. When it is set, visitors need no key of their own; a visitor can still send one (`X-Atlas-Key`), which is then used instead. The key of the site spends the credits of its owner, so its use is bounded (the limits need a KV binding to be kept reliably):
  - `ATLAS_SHARED_HOURLY_PER_IP` (default 6): tests an hour for each address
  - `ATLAS_SHARED_DAILY` (default 200): tests a day for everybody
  - `ATLAS_SHARED_MAX_PROBES` (default 25): probes for each test
  The key of the site is never used to read a measurement, so it cannot open private measurements of its owner; give it only the permission to create measurements.
  A secret set after a deployment is read only by the next one: deploy again (any push to the production branch) and check that `GET /api/atlas/config` answers `sharedKey: true`.
- KV binding **`ASN_META_KV`** (recommended)
  - Used for ASN metadata caching
  - Can also be used for rate limiting storage (zero-config)
- KV binding `REPORT_KV` (recommended)
  - Enables short report links (`/r/<id>`) by storing report bundles with a TTL (default: 30 days; configurable via `REPORT_TTL_DAYS`).
- KV binding `RATE_LIMIT_KV` (optional separate storage for rate limiting)

#### SEO & social previews

Static assets in `public/` help discoverability and richer link previews:

- `robots.txt` and `sitemap.xml` for search engines
- `og.png` used by Open Graph / Twitter card meta tags (default social preview)
- `logo-badge.svg` used in the README and as a lightweight logo asset
- `manifest.webmanifest` + icons (PWA metadata)
- `.well-known/security.txt` for vuln disclosure contact

The `public/_headers` file also sets cache and content-type headers for these resources on Cloudflare Pages.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](./SECURITY.md).

## Acknowledgements

ping6.it is built on top of:
- Globalping (API + distributed probes)
- RIPE Atlas (API + distributed probes, built-in measurements and anchors)
- PeeringDB (exchange points and their facilities)
- root-servers.org and the root server operators (sites and identifiers of the instances)
- Izhikevich and others, "Rooting Out Incorrect RIPE Atlas Probe Geolocations" (IMC 2026), for the method of the probe location check
- ASPA Explorer (University of Padova), where the trombone and probe location checks were first built
- OurAirports (public domain airport data)

## License

- Source code: GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](./LICENSE).
- Documentation and website content: Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0) — see [LICENSE-DOCS](./LICENSE-DOCS).
