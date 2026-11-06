# Landing visual review · 2026-09-28

Scope: `website/landing`; one landing page, reviewed section by section before redesign. No application UI or backend changes.

| Section | Observed issue | Redesign decision |
| --- | --- | --- |
| Navigation / hero | Crowded bilingual lockup, uncontrolled headline wrapping, weak visual hierarchy | Two-line brand, deliberate headline lines, graphite/mint instrumentation aesthetic, immediate local-analysis assurance |
| Product demo | Tiny labels; failure CTA only opens token composition | Legible dashboard and a mock event trace with selectable evidence; label all figures as illustrative |
| Features | Equal-weight generic illustrations lack narrative | Three steps: collect local records, inspect failure evidence, distinguish cost bases |
| Privacy | Important differentiation below the fold; mostly text | Repeat concise promise in hero; show a bounded local data pipeline and explicit network exceptions |
| Harness coverage | Support scope buried in FAQ | Visible source strip with coverage caveat; retain detailed FAQ |
| FAQ | Begins with negative limitations | Lead with privacy/setup, then financial honesty and capability boundaries |
| Download | Repeats abstract metaphor | Concrete first-use steps and clearly identified macOS beta release link |

## Motion and trust

Use local SVG/CSS signal animation, not Three.js. This is a two-dimensional event-monitoring story, not a spatial scene. No CDN, external fonts, telemetry, fabricated testimonials or savings claims. Provide a motion toggle and honor reduced motion. Pause animation when the page is hidden. The landing demo is not a screenshot or exact implementation claim.

## Acceptance

- Desktop and narrow mobile layout: readable labels, no horizontal document overflow.
- Week/month switch updates totals and chart; session evidence opens and closes with keyboard support.
- FAQ, anchors and release links work; all illustrative data labeled.
- Sessions stay local; public price/version checks described separately.
- Run syntax check and browser checks; record actual results in landing README.
