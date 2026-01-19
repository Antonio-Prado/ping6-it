# Changelog

All notable changes to this project will be documented in this file.

The format is based on **Keep a Changelog**, and this project aims to follow **Semantic Versioning** (SemVer).

## [Unreleased]

- None.

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

## [1.0.0] - 2025-??-??
- Initial public release.
