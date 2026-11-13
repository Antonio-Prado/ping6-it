# Changelog

All notable changes to this project will be documented in this file.

The format is based on **Keep a Changelog**, and this project aims to follow **Semantic Versioning** (SemVer).

## [Unreleased]

### Changed
- The RIPE Atlas key of the site is never used to read a measurement (only a key sent by the visitor is), so it cannot open private measurements of its owner.

### Fixed
- The probe map was a broken image: the static-map service it relied on (`staticmap.openstreetmap.de`) no longer answers. The map is now laid out by the page from the tiles of OpenStreetMap, zoomed on the probes of the measurement.
- Pressing *Ping the anchors of RIPE Atlas* on a RIPE Atlas measurement moved the page up to the human verification next to *Run*, away from the results. The page now stays where it is, and the box is brought back into view when the pings end.

### Added
- Trombone routing reading under the `traceroute` and `mtr` tables: for each probe, the round trip to the target net of the access network, over IPv4 and IPv6; when one family proves that the target is near (up to 50 ms) and the other needs 100 ms or more, the slower one is marked as a trombone. Bands and method from ASPA Explorer.
- Probe location check, on request: a round trip shorter than light in fibre (2/3 of c, the "speed of Internet") allows from the declared place of a probe proves that the probe is elsewhere. Reference points: the exchange points that a path crosses (PeeringDB, asked from the browser and kept for a day) and, for RIPE Atlas probes on every command, the instances of the thirteen DNS root servers that answer `hostname.bind` (Izhikevich and others, IMC 2026). A probe that is not where it is said to be is marked with the figures that prove it and is not read as a trombone.
- Probe location check with the anchors of RIPE Atlas, on request and on both backends: the probes of the measurement ping a few anchors (three in their countries, the others spread over the world), and a round trip too short for the declared place proves that the probe is elsewhere. New endpoint `POST /api/atlas/anchor-pings`.
- The instances of the DNS root servers are placed for the thirteen letters (about 1,600 instances, from 695): by the lists that the operators publish on root-servers.org, and by the codes in their names where no identifiers are published; the anchors still refute a wrong place.
- RIPE Atlas without a key of the visitor: when `ATLAS_API_KEY` is set, measurements run with the key of the site, bounded by tests an hour for each address, tests a day for everybody and probes for each test (`ATLAS_SHARED_HOURLY_PER_IP`, `ATLAS_SHARED_DAILY`, `ATLAS_SHARED_MAX_PROBES`); a visitor can still use a key of their own. New endpoint `GET /api/atlas/config`.
- `src/lib/soi.js` (pure functions) with unit tests, and tests of the server functions with RIPE Atlas faked (`npm test`, run by CI), `public/data/root-sites.json` and `scripts/build-root-sites.mjs` to rebuild it.

## [2.1.0] - 2026-02-05

### Added
- RIPE Atlas backend support for ping, traceroute, and DNS measurements (including API key input and local persistence).
- DNS and HTTP timing comparison tables with per-probe v4/v6 totals, deltas, ratios, and medians/p95 summaries.
- MTR path comparison table (v4 vs v6).
- Optional delta alert threshold to highlight large median v6-v4 gaps.
- Heatmap coloring with legend for quick visual comparison.
- Report mode now exposes a direct, copyable link.
- Modal details now include RPKI, announcements, and cache indicators.

### Changed
- Minor UI polish and copy tweaks.
- Additional validation and guardrails around measurement creation.

### Fixed
- Atlas DNS timings now derive totals from nested result/resultset entries when top-level `rt` is missing.

## [2.0.0] - 2026-01-14

### Added
- Multi-target mode (run the same command against multiple targets).
- Export actions for results:
  - JSON (raw bundle)
  - CSV (per-probe rows)
- Shareable URLs:
  - “Share link” for settings
  - “Report mode” for a read-only, shareable view embedding results
- Local (browser) history for past runs.
- Probe filtering enhancements:
  - IPv6-capable probes-only selection
  - ASN filter
  - ISP filter
- Cloudflare Pages Functions endpoints to support the UI workflow:
  - `POST /api/measurements-pair`
  - `POST /api/globalping/measurements`
  - `GET  /api/globalping/measurements/:id`

### Changed
- UI layout:
  - **Run** and **Cancel** are placed next to the target input.
  - Secondary actions moved to a dedicated row.
  - Geo preset controls placed below a thin divider for clearer hierarchy.
- Comparison workflow:
  - The second measurement run is pinned to the same probe set by referencing the first measurement id as locations.
  - Selection order depends on the “IPv6-capable probes only” toggle (IPv6-first by default).
- Input rules:
  - Hostname-only targets enforced for `ping`, `traceroute`, `mtr`, and `http` to keep v4/v6 comparisons meaningful.
  - IP literals allowed for `dns` (e.g., PTR).

### Removed
- Language selector UI. The interface is English-only.

### Improved
- Server-side sanitization and clamping of measurement options before calling the upstream Globalping API.
- Turnstile integration is loaded on demand and validated server-side to reduce automated abuse.
- Error reporting for Turnstile / upstream API failures (more actionable messages).

## [1.0.0] - 2025-01-08
- Initial public release.
