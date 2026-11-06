---
title: What does each building in Agent City mean? How is height calculated?
lastUpdated: 2026-10-22
description: In Agent City each session building is one agent session, and its height follows the session's total tokens on a log curve. What every building means.
head:
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
          {"@type": "ListItem", "position": 1, "name": "Oh Agent", "item": "https://ohagent.ai/"},
          {"@type": "ListItem", "position": 2, "name": "Docs", "item": "https://ohagent.ai/docs"},
          {"@type": "ListItem", "position": 3, "name": "What each building in Agent City means", "item": "https://ohagent.ai/docs/city-guide"}
        ]
      }
---

In Agent City, every session building stands for one agent session, and its height grows with that session's total token count on a logarithmic curve. Districts are agents (one per agent, such as Claude Code or Codex), and almost everything else (landmarks, beaches, traffic) is decoration that does not represent data.

## Key facts

- **1 session building = 1 session** within the selected time window.
- **Height = total tokens** (input + cache read + cache write + output) on a log curve, from **2.6** to **48** scene units.
- **1 district = 1 agent**; building colour = its district.
- **Up to 4,000** sessions per window are loaded, each as its own building (most recent first).
- **Facilities** (schools, malls, hospitals) appear about **once per 45 sessions**.
- The island grows **one tier per 400 sessions**, up to **10 tiers**.
- Desktop time windows: **7, 30, 90 or 366 days**.

<!-- source: apps/agent-city/ui/src/cityModel.ts (tokensToHeight; RENDER_CAP = 4_000; height uses row.tokens.total) -->
<!-- source: crates/agent-vitals-query/src/query/app_local.rs (SESSION_CAP = 4_000; input = uncached_input + cache_read + cache_write; total = input + output, window-scoped) -->
<!-- source: apps/agent-city/ui/src/engine/cityLayout.ts (CIVIC_PER_SESSIONS = 45) -->
<!-- source: apps/agent-city/ui/src/engine/scaleTier.ts (SESSIONS_PER_TIER = 400, MAX_TIER = 10) -->
<!-- source: apps/agent-city/ui/src/CityApp.tsx (windowOptions = [7, 30, 90, 366]) -->

## How is building height calculated?

Height comes only from the session's total tokens in the current window:

```
m      = max(0, log10(tokens) − 1)
height = clamp(0.75 × m^2.2, 2.6, 48)
```

| Tokens in the session | Height (scene units) |
|---|---|
| 575 or fewer | 2.6 (minimum) |
| 1,000 | 3.4 |
| 10,000 | 8.4 |
| 100,000 | 15.8 |
| 1,000,000 | 25.9 |
| 10,000,000 | 38.6 |
| about 42,000,000 or more | 48 (maximum) |

The log curve keeps the order (more tokens is always at least as tall) while keeping mid-sized sessions readable next to very large ones. Scene units are the city's internal scale.

<!-- source: apps/agent-city/ui/src/cityModel.ts tokensToHeight(); table values computed from that formula -->

## Which tokens count?

The total includes uncached input, cache reads, cache writes and output tokens recorded for the session inside the selected window. Recorded tokens reflect what the agent logged on this computer. They are not necessarily your complete history across devices.

<!-- source: crates/agent-vitals-query/src/query/app_local.rs (SUM(uncached_input_tokens + cache_read_tokens + cache_write_tokens), SUM(output_tokens)); README.md ("Read the numbers honestly") -->

## Why do buildings have different shapes?

Shape follows land value, not data. Session buildings on the district's most valuable lots (near the district centre, main roads and the water) grow into glass towers; on cheaper lots they become wide slabs or blocks. Low session buildings by the sea take a Miami Art Deco style, and a session on a seaside hotel lot becomes a hotel. In every case, **height still comes from tokens**.

<!-- source: apps/agent-city/ui/src/i18n.tsx (building guide: "Session tower", "Session slab / block", "Seaside Art Deco building", "Seaside hotel") -->

## What do districts, landmarks and the city hall mean?

| Element | What it shows | Data? |
|---|---|---|
| District | One agent (harness), such as Claude Code or Codex; buildings take the district colour | Yes |
| District landmark | A stepped Art Deco tower at each district centre; it grows with the district's session count and rises floor by floor during replay | Yes (session count) |
| "Top of the city" | The session with the most tokens in the window wears a spire crown and, from dusk, a searchlight beam | Yes |
| City hall | Flags in front show each district's share of sessions; a beacon on the dome means a district has anomalies | Yes |
| Schools, malls, hospitals | City size: about one per 45 sessions; not any single session | Scale only |
| Island tier | The land expands one tier per 400 sessions, up to 10 tiers | Scale only |
| Backdrop towers | Muted skyline fill; can be turned off in City settings; not clickable, not counted | No |
| Seed landmarks (TV tower, lighthouse, Ferris wheel, pagoda…) | Chosen by the island seed | No |
| Beach, harbor, airport island, volcano, bridges, ring expressway | City scenery and skeleton | No |
| Cars, boats, pedestrians | Ambient animation | No |

<!-- source: apps/agent-city/ui/src/i18n.tsx (building guide strings: district landmark, top of the city, city hall, backdrop towers, landmarks, seaside, airport) -->
<!-- source: Haru analysis city-traffic-feasibility.md (traffic, boats and pedestrians are decoration only) — maintainer: please confirm before publishing -->

## What happens with more than 4,000 sessions?

The desktop app loads at most 4,000 sessions per window, keeping the most recent ones by activity, and the city reports its coverage (sessions shown out of sessions found). Missing records are never filled in with invented activity. The City renderer can also merge sessions beyond its 4,000-building capacity into low-detail aggregated blocks; with the current 4,000 load limit this should not normally be reached.

<!-- source: crates/agent-vitals-query/src/query/app_local.rs (SESSION_CAP = 4_000; ORDER BY recent activity LIMIT; total count returned) -->
<!-- source: apps/agent-city/ui/src/cityModel.ts (RENDER_CAP = 4_000; UI shows coverage.returned/total) -->
<!-- source: apps/agent-city/ui/src/i18n.tsx ("Aggregated block ... 4,000 buildings"); website/landing/i18n.js faq.4 ("Missing records are not filled with invented activity" — NOTE faq.4 still says 500, outdated) -->

## Is the city layout random?

No. The layout is generated from a seed plus the island tier, so the same seed and tier give the same city. The seed is stored locally in the app's data folder (`state/plugins/city.json`).

<!-- source: apps/agent-city/ui/src/engine/cityPlan.ts (createCityPlan(seed, tier)); apps/desktop/src-tauri/src/plugin_projections.rs (state/plugins/city.json) -->

## Can I replay how the city grew?

Yes. The desktop app replays activity within the loaded window, with adjustable replay speed. The [web demo](https://ohagent.ai/) supports exploring buildings and replay on synthetic data, but it hides game, export and seed controls.

<!-- source: README.md ("Activity replay"); apps/agent-city/ui/src/i18n.tsx ("Replay speed"); website/landing/README.md (presentation=landing hides game, export and seed controls) -->

## Does a taller city mean I worked better?

No. The city is a visual interpretation of recorded activity, not a productivity score. Building growth does not prove a task succeeded, and repetition alone does not prove wasted work. A building's details show an estimated cost, but cost never changes its height, and an estimate isn't a bill.

<!-- source: README.md ("not a productivity score"); website/landing/i18n.js (faq.6: city not connected to cost data) -->

## Related

- [Agent City overview](https://ohagent.ai/#city)
- [Claude Code data source](/docs/data-sources/claude-code) · [Codex data source](/docs/data-sources/codex)
- [Does Oh Agent upload my sessions?](/docs/privacy-and-data)
- [FAQ](https://ohagent.ai/#faq)
