# Oh Agent landing — preserved design system

## Design read (2026-10-19)

Extension of the existing City-first developer-product landing. Audience: people using local desktop agents who want to explore their activity and inspect usage. Preserve the recognizable page and clarify current capabilities and availability. Dials (1–10): visual variance 3, motion 3, information density 4, asset dependence 8, brand fidelity 10.

## Assets and tokens

- Logo/wordmark asset: `assets/app-icon.png` with the existing Oh Agent text lockup.
- English product imagery with synthetic sessions: `assets/city-workspace.jpg`, `assets/city-building.jpg`; provenance remains in `RELEASE_REVIEW.md`. The exploration routes are explicitly conceptual overlays.
- Existing palette: background `--bg: #0a1111`; surface `--surface: #101a19`; line `--line: #243532`; ink `--ink: #edf5ef`; muted `--muted: #a1b5ac`; mint `--mint: #bcf4cd`; amber `--amber: #edc47c`.
- Type: existing OS sans-serif body/headings, Georgia italic emphasis and OS monospace labels. No external font requests.
- Spacing: existing shell and section rhythm; component padding uses 4px multiples, generally 12–24px. Existing 7–18px corner treatments are retained. New platform summaries use simple dividing rules.
- Motion: existing dotted route animation and gentle image transforms; disabled by the existing reduced-motion rule. No new animation dependency.

## Preserved contracts and changes

Preserve `#city`, `#play`, `#how`, `#insights`, `#privacy`, `#faq`, `#download`, locale preference, local synthetic data host, same-origin scripts/assets and privacy/cost explanations. Add a third VTOL conceptual preview, clear public source links and truthful platform release summaries. Installer links point only at published, API-verified release assets for a specific tag (currently `app-v1.0.0-beta.3`), never `/releases/latest`. Desktop selectors/platform summaries use three columns; below 700px they stack without fixed content widths.
