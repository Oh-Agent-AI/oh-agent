---
draft: true
title: How does Agent City turn sessions into buildings? The city model
description: Agent City reads up to 4,000 recent sessions, with tokens, models and cost estimates, from the Agent Vitals data interface. Height follows total tokens on a log curve, and public buildings open data panels.
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
          {"@type": "ListItem", "position": 3, "name": "City model", "item": "https://ohagent.ai/docs/architecture/city-model"}
        ]
      }
---

Agent City is the game layer on top of Agent Vitals. It asks the host for a paged `city:v3` snapshot by default (the landing host and `?cityData=v2` still use `city:v2`), which holds up to 4,000 of your most recent sessions in the chosen time window. A pure TypeScript model (`cityModel.ts`) maps each session to one building. Then the planner and renderer lay out the island and draw it with three.js. This page covers the data side. For what each building looks like, see [What each building means](/docs/city-guide).

## Key facts

- **Time windows:** 7, 30, 90 or 366 days, rolling. `city:v2` uses UTC; `city:v3` uses your declared time zone.
- **Session cap:** 4,000 per window. The most recent ones by last activity are kept, then ordered oldest first so the city grows outward.
- **1 session = 1 building.** The render cap is also 4,000, so every loaded session gets its own building.
- **Height = total tokens**: uncached input + cache read + cache write + output.
- **Height curve:** `clamp(0.75 × (log10(tokens) − 1)^2.2, 2.6, 48)`, so about 3.4 units at 1K tokens, 15.8 at 100K and 38.6 at 10M.
- **Island tier:** `ceil(windowSessions / 400)`, from 1 to 10, using the full window count so later pages do not retier the island. Each tier plans `ceil(400 × tier × 1.35)` lots.
- **Districts = sources** (Claude Code, Codex, …), ordered by total tokens.
- **Cost is shown as an estimate.** v3 building cards ask you to open details for the estimate (`load_on_demand`); v2 still ships a cost on the list row. When a session can't be priced in full, City shows the reason instead of a number. Cost never affects height.
- **Data facilities:** some public buildings open data panels (city overview, activity and models, findings, skills).

<!-- source: crates/agent-vitals-query/src/query/app_local.rs (dev bf7196a: matches!(days, 7|30|90|366); SESSION_CAP = 4_000; selection "window_last_event_desc_session_key_asc", order "window_first_event_asc_session_key_asc"; window timezone "UTC"; cost via city_v3::cost_breakdown) -->
<!-- source: crates/agent-vitals-query/src/query/city_v3.rs (overview: timezone, calendar_mode rolling, half-open window) -->
<!-- source: apps/agent-city/ui/src/cityModel.ts (RENDER_CAP = 4_000; tokensToHeight; harnessIds sorted by tokens desc) -->
<!-- source: apps/agent-city/ui/src/engine/scaleTier.ts (SESSIONS_PER_TIER = 400; MAX_TIER = 10; scaleTierFor; targetParcels) -->
<!-- source: apps/agent-city/ui/src/CityExperience.tsx (costLabel: estimated → amount; otherwise status reason); apps/agent-city/ui/src/CityApp.tsx (cost_minor / cost_status mapped from projection) -->

## What is in the City projection?

By default City reads one JSON object (`protocol: "city:v2"`) per window:

| Field | Meaning |
| --- | --- |
| `harnesses` | Public source identities: id, display name, capabilities |
| `sessions[]` | Per session: an opaque `id`, `harness`, bounded `title` and `title_source`, first and last event time, `event_count`, `tokens {input, uncached_input, cache_read, cache_write, output, total}`, `model_ids`, `cost_minor`, `cost_breakdown` (per currency and billing basis), `cost_complete`, `cost_status {state, reason, has_unresolved}`, up to 2 `task_excerpts` |
| `summary` | Totals for the whole window (session count, usage events, tokens), not just the loaded sessions |
| `models`, `model_coverage` | Model IDs seen in the whole window, plus counts of usage with an unknown model or legacy data |
| `activity` | Per-day active sessions, usage rows and tokens, and the busiest day |
| `findings[]` | Open findings counted per source and severity (not per session) |
| `coverage` | `total`, `returned`, `truncated`, unknown-time counts, and the selection and order rules |
| `window`, `generated_at`, `data_revision`, `status` | Snapshot metadata; `status` is `ready` or `empty` |

- **Session IDs are one-way.** Each is a salted handle (`sr_` + 32 hex), scoped to City. The plugin never sees native session IDs, paths or database keys.
- **Costs are estimates.** `cost_status.state` is `estimated`, `subscription`, `unpriced` or `unavailable`. Mixed currencies and partly priced sessions get no single total.
- **Excerpts are short and filtered.** At most 2 per session: the first up to 200 characters, a later one up to 120. System wrappers, bare file paths and one-word replies such as "ok" or "继续" are skipped.
- **No fake fallback.** If real data fails, City shows "unavailable"; it doesn't switch to synthetic data.

<!-- source: app_local.rs (dev: city_projection json! output; clean_excerpts → make_presentation_excerpt, out.len()==2; session_ref(&salt, "app:city:{key}")) -->
<!-- source: crates/agent-vitals-domain/src/domain/enrichment.rs (make_presentation_excerpt: <system / <environment_context / <command … prefixes; "ok" | "继续" …; bare path) -->
<!-- source: packages/agent-vitals-app-sdk/src/city-ui-projection.ts (CityUiProjectionV2 fields; cost_status states) -->
<!-- source: docs/CITY_LOCAL_DATA_PROJECTION.md (首次最多 200 字符，后续最多 120 字符; 真实数据失败显示不可用) -->

### What does `city:v3` add?

`city:v3` is a paged, snapshot-based version of the same data, with five operations (see [App SDK](/docs/vitals/app-sdk)). The packaged City plugin loads through v3 by default (the plugin WebView has no query string) and falls back to `city:v2` if v3 errors or exhausts snapshot retries. The website landing host only answers v2; `?cityData=v2` remains an explicit override. Findings, skills, and session details use v3 on demand. It adds:

- **`asset_ref`:** a stable, random City asset ID per session, kept in a separate registry under `~/.agent-vitals/state/plugins/city-assets/`. It holds no title, excerpt, path or native ID.
- **`layout_order`, `usage_event_count`, `title_state`**, and separate window and lifetime first/last event times.
- **Lazy details:** `session.detail` returns one building's cost breakdown and excerpts, scoped to the whole session.

The first page is enough to render; later pages append into a stable island planned for the full window. Native click-through on a macOS bundle is still a separate acceptance.

<!-- source: crates/agent-vitals-query/src/query/city_v3.rs; city_assets.rs ("No title, excerpt, path, native id or reward is persisted here"; home.join("state/plugins/city-assets")); apps/agent-city/ui/src/data/provider.ts (cityDataProtocol: landing/cityData=v2 → v2, else v3 with v2 fallback; onPartial first page; readCityModule) -->
<!-- source: docs/CITY_PROJECTION_DATA_COMPLETION_SPEC.md §12 (v3 default; landing stays v2; packaged fallback) -->

## Which buildings open data panels?

Public buildings are entry points to data, not extra sessions or game income. Each one maps to a data place in `cityDataPlaces.ts`:

| Data place (`id`) | Building (catalog id) | What it shows | State on dev |
| --- | --- | --- | --- |
| City Hall · Overview (`overview`) | `civic-hall` | Whole-window statistics and loading coverage | Live data |
| Observatory · Activity & models (`activity`) | `observation-tower` | Daily active sessions, usage rows and tokens; model IDs seen | Live data |
| Diagnostics · Findings (`findings`) | `hospital` | Current open backlog and findings new in the window, by source and severity | Loaded on demand (`module.read`) |
| Academy · Skills (`skills`) | `school` | Skill invocations with recorded evidence: count, sessions, outcomes, last used | Loaded on demand (`module.read`); up to 200 rows |
| Station · Workflow (`workflow`) | `station` | Tool execution and outcomes | Not available yet: shown as unsupported |

If a building doesn't exist yet because the city is small, its panel still opens from the **Data facilities** list in the city summary.

<!-- source: apps/agent-city/ui/src/cityDataPlaces.ts (CITY_DATA_PLACES; cityDataPlaceForDecor); apps/agent-city/ui/src/CityDataFacility.tsx; city_v3.rs (module.read: skills → stats::skill_activity, truncate(200); findings → current_backlog / window_new; others → invalid_module) -->
<!-- source: docs/CITY_DATA_FACILITIES_PRESENTATION_SPEC.md (§2 table; "当前规模尚未生成该设施"); commits 3405a36, d4479f2 -->

## How is a building computed?

For each session row, `buildCityModel` computes:

| Property | Rule |
| --- | --- |
| `height` | `tokensToHeight(total)` (log curve above). The top ~12 sessions by tokens get ×1.12 as landmarks |
| `seed` | FNV-1a hash of the session ID, so appearance is stable between refreshes |
| `archetype` | Initial form from height and seed: tower, slab, midrise, block or landmark |
| `active` | The session had an event today (local day), the same rule as the menu bar |
| `builtFraction` | 1 for finished sessions; for active ones, tokens ÷ the district's p95, clamped to 0.08–0.92 |
| `busyness` | Recent tokens per hour, which drives crane animation on active sites |
| `startedAt` | First event time, which decides when the building appears during replay |

**TBD:** `cityModel.ts` only sets an initial archetype. The building guide says the final form follows land value (towers on prime lots, slabs and blocks on cheaper ones), and that is decided later in layout. Confirm which file owns the final choice before documenting it in detail.

<!-- source: cityModel.ts (buildCityModel: landmarkThreshold = percentile(1 − 12/n); finalHeight = height × 1.12; hashSeed FNV-1a; archetypeFor; isActiveToday; builtFraction clamp 0.08–0.92; busyness) -->
<!-- source: apps/agent-city/ui/src/i18n.tsx ("区内地价最高 … 长成玻璃幕墙塔楼"; "形态只随地价变化，楼高仍由 token 决定") -->

## What if there are more than 4,000 sessions?

The host returns only the most recent 4,000 and sets `coverage.truncated = true`. The model has a fallback for more rows than the render cap: it splits 4,000 building slots among districts by session share, and merges the rest into 2 to 26 low-detail "aggregated blocks" per district. Because the host cap equals the render cap, that path doesn't run with real data today.

<!-- source: cityModel.ts (quotaOf largest-remainder; fillerCount = min(26, max(2, round(overflow/24)))); app_local.rs (truncated: total > returned) -->

## How does replay work?

Each building grows from its first to its last event. The model has no per-event token series, so growth over a session is a linear approximation. During replay, each rise is clamped to 0.9–3.5 wall-clock seconds so short sessions don't flash and long ones don't crawl.

<!-- source: cityModel.ts (builtFractionAt: "token 在会话生命周期内线性累计是可视化近似"; floor (0.9 + seed × 0.6) × pace, cap 3.5 × pace) -->

## How are findings shown?

Findings are only counted per source, so they appear as a district anomaly marker, not on single buildings. The list is partial: an empty list doesn't prove there were no problems. Findings cover Claude Code, Codex and DSH only. For more detail, open the Diagnostics panel (hospital).

<!-- source: cityModel.ts header ("finding 只到 harness 粒度，因此在 harness 区上标记"); app_local.rs (findings_state: "partial"; FACT_HARNESSES filter); session_harnesses.rs (with_findings = claude-code, codex, dsh); dev app_local.rs: filter is now capability-based (identities…id.findings) -->

## Where does the rendering happen?

After the model, City runs a planner (terrain, roads, lots), a layout step (sessions to lots) and a three.js renderer, under `apps/agent-city/ui/src/engine/`. The target is layers L0 (model) → L5 (runtime) where only L4 knows three.js. That design is still a proposal and only partly carried out.

<!-- source: docs/CITY_ARCHITECTURE.md ("状态：提案"; L0–L5 layering); apps/agent-city/ui/src/engine/ (cityPlan.ts, cityLayout.ts, planner/, render/, systems/) -->

## Related

- [What each building means](/docs/city-guide)
- [Architecture overview](/docs/architecture/overview)
- [Data pipeline](/docs/architecture/data-pipeline)
- [Plugins and the data interface](/docs/vitals/app-sdk)
