<p align="center">
  <a href="https://ping6.it">
    <img src="./public/logo-badge.svg" alt="ping6.it logo" width="220" />
  </a>
</p>

# ping6.it

**ping6.it** is a small web UI that runs the same network measurement over **IPv4 and IPv6** on the **same set of probes** (Globalping) and presents a side-by-side comparison.

It is intended for **quick, reproducible v4 vs v6 troubleshooting**: reachability gaps, latency deltas, loss anomalies, and routing/path asymmetries.

> Experimental beta: defaults, UI layout, and comparison logic may evolve.

Live: https://ping6.it  
Feedback: mailto:antonio@prado.it

## Main features

- **Fair v4/v6 comparison** by pinning both runs to the **same probes**
- **Commands:** `ping`, `traceroute`, `mtr`, `dns`, `http`
- **Geo selection** (macro region + sub-regions) and **Net** filter (eyeball/datacenter)
- Probe filters: **limit**, **ASN**, **ISP**, **IPv6-capable probes only**
- **Multi-target** mode (run the same command over multiple targets)
- **Exports:** JSON (raw bundle) and CSV (per-probe rows)
- **Share link** (settings) and **Report mode** (shareable link embedding results)
- **History (local)** stored in your browser (and run-to-run comparison)

## Table of contents

- [What ping6.it is for](#what-ping6it-is-for)
- [How the v4v6 comparison works](#how-the-v4v6-comparison-works)
  - [Target validation](#target-validation)
- [Common controls](#common-controls)
- [Commands](#commands)
  - [ping](#ping)
  - [traceroute](#traceroute)
  - [mtr](#mtr)
  - [dns](#dns)
  - [http](#http)
- [Interpreting results](#interpreting-results)
- [API endpoints](#api-endpoints)
- [Limitations and notes](#limitations-and-notes)
- [Development](#development)
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

## How the v4/v6 comparison works

ping6.it creates **two Globalping measurements** (v4 and v6) and ensures they run on the **same probe set**:

- First run selects probes normally (based on `From`, `Net`, limit, ASN/ISP filters, etc.)
- Second run is executed on the **exact same probes** by referencing the first measurement id as `locations`

The ordering depends on the **IPv6-capable probes only** toggle:

- **Enabled (default):**
  1) run **IPv6 first** (`ipVersion: 6`) to select probes that can actually execute IPv6  
  2) run **IPv4** (`ipVersion: 4`) on the **same probes** by referencing the IPv6 measurement id

- **Disabled:**
  1) run **IPv4 first** (`ipVersion: 4`) to select probes  
  2) run **IPv6** (`ipVersion: 6`) on the **same probes** by referencing the IPv4 measurement id

### Target validation

- For `ping`, `traceroute`, `mtr`, and `http`, the target must be a **hostname** (IP literals are rejected) to keep the comparison meaningful.
- For `dns`, the input may also be an **IP literal** (e.g. `PTR`).
- When the target is an IP literal, **IPv6-capable probes only** is disabled (probe selection cannot be safely pinned via hostname rules).

## Common controls

### Language
The UI supports English and Italian. Language is stored locally in your browser.

### Target / Multi-target
- **Single target:** one hostname (or IP literal for DNS).
- **Multi-target:** paste multiple targets (one per line). ping6.it will run them sequentially and show a consolidated summary.

### Command
Selects the measurement type:

- `ping`
- `traceroute`
- `mtr`
- `dns`
- `http`

Changing the command resets the UI to **Basic** mode.

### From (geo)
Selects probe location(s). The UI provides macro regions and sub-regions; the resulting string is sent to Globalping.

### Net
Filters probes by network type:
- `any`
- `eyeball` (access/consumer)
- `datacenter`

Internally this is implemented via Globalping location tags.

### Probes
Number of probes to select (clamped to a small max to reduce abuse and keep results readable).

### ASN / ISP
Optional filters that constrain probe selection:
- **ASN:** numeric ASN (e.g. `12345`)
- **ISP:** free-text label (as supported by Globalping metadata)

### IPv6-capable probes only
Ensures probe selection is driven by IPv6 reachability, then reuses the same probes for IPv4.

### Δ alert (ms)
Optional threshold used in summaries/reports to highlight large v6-v4 deltas.

### Run / Cancel
- **Run** starts the v4/v6 measurement pair on the same probes.
- **Cancel** aborts the in-progress run.

> Note: a Cloudflare Turnstile challenge is used to reduce automated abuse. Verification is performed server-side.

### Basic / Advanced
Toggles the visibility of additional options. Advanced options depend on the selected command.

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
- **Proto:** `icmp` / `udp` / `tcp` (depending on Globalping support)
- **Port:** for UDP/TCP modes when applicable

Output:
- reached/last hop, hop count, and timing summaries (v4 vs v6)

### mtr

Basic:
- target (hostname)

Advanced:
- **Packets/hop:** packets per hop

Output:
- loss and latency summaries (v4 vs v6), reached flags

### dns

Basic:
- target (hostname or IP literal for PTR)

Advanced:
- **Query:** record type / query string (as supported by Globalping DNS measurement)
- **Proto / Port**
- **Resolver:** optional; empty means probe default resolver
- **trace:** if enabled, include trace information when supported

Output:
- totals (ms) and ratio v6/v4 where applicable

### http

Basic:
- target (hostname, or a full URL which is split into host/path/query)

Advanced:
- **Method**
- **Proto:** `http` / `https`
- **Path / Query / Port**
- **Resolver:** optional; empty means probe default resolver

Output:
- status codes and total times (ms), ratio v6/v4 where applicable

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
  Creates a v4/v6 measurement pair and validates **Cloudflare Turnstile** server-side.

- `POST /api/globalping/measurements`  
  Proxy/sanitizer for Globalping create requests (defensive validation/clamping).

- `GET /api/globalping/measurements/:id`  
  Proxy for reading measurement results.

There is also an NLNOG Looking Glass proxy endpoint under `functions/api/nlnog/` (currently not exposed in the UI).

## Limitations and notes

- **Globalping availability varies.** Some geos and filters can return “no probes found”.
- **IPv6-capable probes only** can reduce availability significantly in sparse regions.
- **The From field is passed through.** If a location string is invalid, Globalping may return validation errors.
- **Turnstile is enforced for pair creation.** Automated usage without a valid challenge token will fail.
- **Experimental beta.** Defaults, UI layout, and comparison logic may evolve.

## Development

Requirements:
- Node.js (the CI uses Node 20)

Install and run:
```bash
npm ci
npm run dev
```

Build:
```bash
npm run build
npm run preview
```

### Cloudflare Pages / Functions configuration

The pair endpoint requires a Turnstile secret configured as an environment variable in Cloudflare:

- `TURNSTILE_SECRET` (Pages environment variable)

The frontend also needs the corresponding Turnstile site key (as configured in the UI code/deployment). Keep the secret server-side only.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](./SECURITY.md).

## Acknowledgements

ping6.it is built on top of the Globalping measurement platform (API + distributed probes).

## License

- Source code: GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](./LICENSE).
- Documentation and website content: Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0) — see [LICENSE-DOCS](./LICENSE-DOCS).
