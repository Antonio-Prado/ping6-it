# ping6.it

**ping6.it** is a small web UI that runs the same network measurement over **IPv4 and IPv6** from multiple vantage points (Globalping probes) and presents a side-by-side comparison.

It is intended for **quick, reproducible v4 vs v6 troubleshooting**: reachability differences, latency deltas, loss anomalies, and routing/path asymmetries.

> Experimental beta: features may change and results may vary.

Live: https://ping6.it  
Feedback: mailto:antonio@prado.it?subject=Ping6%20feedback

---

## Table of contents

- [What ping6.it is for](#what-ping6it-is-for)
- [How the v4/v6 comparison works](#how-the-v4v6-comparison-works)
- [Common controls](#common-controls)
- [Commands](#commands)
  - [ping](#ping)
  - [traceroute](#traceroute)
  - [mtr](#mtr)
  - [dns](#dns)
  - [http](#http)
- [Interpreting results](#interpreting-results)
- [Limitations and notes](#limitations-and-notes)

---

## What ping6.it is for

Typical use cases:

- Validate whether a hostname behaves differently on **IPv4 vs IPv6** (reachability, latency, loss).
- Compare **performance** from multiple networks/locations (per-probe deltas + simple summaries).
- Spot **routing/path differences** that only show up on one IP version (traceroute/MTR).
- Debug **DNS timing** and **HTTP total time** differences over v4/v6.

ping6.it does not run probes itself. Measurements are executed by Globalping probes; ping6.it orchestrates runs and renders results.

---

## How the v4/v6 comparison works

For each run, ping6.it creates **two measurements**:

1. A first measurement forced to **IPv4** (`ipVersion: 4`) to select the probes.
2. A second measurement forced to **IPv6** (`ipVersion: 6`) executed **on the same probes** as the IPv4 measurement.

This “same-probes” approach keeps the comparison fair: v4 and v6 results come from identical vantage points.

### Target validation

- For `ping`, `traceroute`, `mtr`, and `http`, the target must be a **hostname** (IP literals are rejected) to keep the comparison meaningful.
- For `dns`, the input may also be an **IP literal** (e.g., for `PTR`).

---

## Common controls

### Command
Selects the measurement type:

- `ping`
- `traceroute`
- `mtr`
- `dns`
- `http`

Changing the command resets the UI to **Basic** mode.

### Net
Filters probes by network type:

- `any` (no filter)
- `eyeball`
- `datacenter`

This filter is applied by appending `+eyeball` or `+datacenter` to the location expression (and it supports comma-separated locations).

### From
Defines where probes should be selected from. The value is passed to Globalping as a location “magic” expression.

Examples (Globalping-style “magic” strings):
- `Western Europe`
- `Africa`
- `New York`
- `IT` (country codes may work depending on Globalping’s parsing)
- `Europe+eyeball` (Net filter is normally appended automatically via the `Net` selector)

#### Location presets (macro + sub-regions)
The UI includes presets that simply fill the **From** field:

- Macro buttons: `Europe`, `North America`, `South America`, `Africa`, `Asia`, `World`
- A sub-region dropdown appears for macros that have sub-regions.

**Oceania is offered under Asia** (UI grouping choice) as:
- Oceania · Australia & NZ
- Oceania · Melanesia
- Oceania · Micronesia
- Oceania · Polynesia

The **From** field remains fully editable and is authoritative.

### Probes
Number of probes used for the IPv4 measurement (and thus also for IPv6, since probes are reused).

- Allowed range: **1–10**
- Values are clamped to this range.

### Run / Cancel
- **Run** starts the IPv4 + IPv6 measurement sequence.
- **Cancel** aborts the in-progress run.

### Basic / Advanced
Toggles the visibility of additional options. Advanced options depend on the selected command.

### Raw
Enabled once both v4 and v6 results are present. Shows the **raw command output** returned by each probe for both IP versions.

---

## Commands

### ping

**Purpose:** measure RTT and loss.

**Target:** hostname only (no IP literal).

**Options (Advanced):**
- **Packets**: number of ICMP echo requests per probe  
  Range: **1–10** (clamped)

**Output table:**
- `v4 avg`, `v6 avg`: average RTT (ms) when meaningful  
  (avg is not considered if loss is 100% or timings are missing)
- `v4 loss`, `v6 loss`: loss as reported by the probe
- `Δ v6-v4`: delta in average RTT (ms)
- `winner`: `v4`, `v6`, `tie`, or `-` when not comparable

---

### traceroute

**Purpose:** trace the path to destination and compare reachability and destination timing.

**Target:** hostname only (no IP literal).

**Options:**
- **Proto**: `ICMP`, `UDP`, `TCP`
- **Port (Advanced)**: shown only when `Proto = TCP`  
  Range: **1–65535** (clamped)

**Output:**
A comparison table plus a small summary (median/p95 when available).

Per probe:
- `v4 reached`, `v6 reached`: whether the destination hop was identified
- `v4 hops`, `v6 hops`: hop count
- `v4 dst`, `v6 dst`: destination RTT estimate (ms)
- `Δ v6-v4`
- `winner`:
  - if only one version reaches the destination, that version wins
  - if both reach, lower destination time wins (or `tie`)

---

### mtr

**Purpose:** MTR-style measurement comparing hop count, loss and average latency to destination.

**Target:** hostname only (no IP literal).

**Options:**
- **Proto**: `ICMP`, `UDP`, `TCP`
- **Packets/hop (Advanced)**: number of packets used per hop  
  Range: **1–16** (clamped)
- **Port (Advanced)**: shown when `Proto != ICMP`  
  Range: **1–65535** (clamped)

**Output:**
A comparison table plus a small summary (medians for avg/loss and deltas when available).

Per probe:
- reachability (`v4 reached`, `v6 reached`)
- hop count (`v4 hops`, `v6 hops`)
- loss (`v4 loss`, `v6 loss`)
- average RTT (`v4 avg`, `v6 avg`)
- `Δ avg`, `Δ loss`
- `winner`:
  - reachability first
  - then (when loss differs meaningfully) lower loss wins
  - otherwise lower avg RTT wins (or `tie`)

---

### dns

**Purpose:** DNS query timing comparison over v4/v6.

**Target:**
- hostname (typical), or
- IP literal (useful with `PTR`)

**Options:**
- **Query (Basic):** `A`, `AAAA`, `CNAME`, `MX`, `NS`, `TXT`, `SOA`, `PTR`, `SRV`, `CAA`, `ANY`
- **Proto (Advanced):** `UDP` or `TCP`
- **Port (Advanced):** 1–65535 (clamped), default 53
- **Resolver (Advanced):** optional; empty means probe default resolver
- **trace (Advanced):** enable trace mode (as supported by the underlying measurement)

**Output:**
A comparison table plus a summary (median/p95 where available).

Per probe:
- `v4 total`, `v6 total`: total DNS time (ms) when finished and error-free
- `Δ v6-v4`
- `ratio`: `v6_total / v4_total`
- `winner`: lower total time wins (or `tie` / `-`)

---

### http

**Purpose:** HTTP timing comparison over v4/v6 (total time + status code).

**Target:**
- hostname, or
- a full URL (recommended if you need path/query/port)

If a URL is provided, ping6.it extracts:
- `host` as the measurement target
- `path` and `query` as request parameters
- `protocol` (HTTP/HTTPS) and `port` if present

If the URL scheme is `http://` or `https://`, the UI aligns the selected Proto accordingly.

**Options:**
- **Method (Basic):** `GET`, `HEAD`, `OPTIONS`
- **Proto (Basic):** `HTTP`, `HTTPS`, `HTTP2`

**Advanced:**
- **Path:** request path (default `/`)
- **Query:** query string (optional; leading `?` is not required)
- **Port:** optional; empty uses protocol default (80/443).  
  If set: 1–65535 (clamped)
- **Resolver:** optional; empty means probe default resolver

**Output:**
A comparison table plus a summary (median/p95 where available).

Per probe:
- `v4 status`, `v6 status`: HTTP status code (when available)
- `v4 total`, `v6 total`: total request time (ms) when finished and error-free
- `Δ v6-v4`
- `ratio`: `v6_total / v4_total`
- `winner`: lower total time wins (or `tie` / `-`)

---

## Interpreting results

### winner
- `v4` / `v6`: the IP version with the better metric (lower time, or better reachability/loss depending on command)
- `tie`: both are equal (within the reported value granularity)
- `-`: not comparable (missing timings, errors, unfinished measurements, or 100% loss where averages would be misleading)

### Δ v6-v4
- Positive delta means **IPv6 is slower** (higher time).
- Negative delta means **IPv6 is faster**.

### ratio (DNS/HTTP)
- `ratio > 1` means IPv6 is slower.
- `ratio < 1` means IPv6 is faster.

---

## Limitations and notes

- **Probe distribution is uneven.** Some regions (and especially some Net filters) may have limited probe availability.
- **Caching and transient conditions matter.** DNS caching, CDN steering, routing changes, and congestion can change outcomes between runs.
- **Not all failures are symmetric.** A measurement may succeed on v4 and fail on v6 (or vice versa); this is often the primary signal.
- **The From field is passed through.** If a location string is too specific or invalid, Globalping may return “no probes found” or validation errors.
- **Experimental beta.** Defaults, UI layout, and comparison logic may evolve.

---

### Acknowledgements

ping6.it is built on top of the Globalping measurement platform (API + distributed probes).

