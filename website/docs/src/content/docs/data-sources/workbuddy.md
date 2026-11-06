---
lastUpdated: 2026-10-28
title: How does Oh Agent read WorkBuddy sessions?
description: Oh Agent reads WorkBuddy usage from trace files under ~/.workbuddy/traces and builds a WorkBuddy district in Agent City. Extra folders and behaviour checks are not supported.
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
          {"@type": "ListItem", "position": 3, "name": "WorkBuddy data source", "item": "https://ohagent.ai/docs/data-sources/workbuddy"}
        ]
      }
---

For WorkBuddy, Agent Vitals reads usage from the `trace_*.json` files under `~/.workbuddy/traces/`, on your Mac. Each WorkBuddy session becomes a building in the WorkBuddy district of Agent City. WorkBuddy support is narrower than for the other built-in sources: you can't add extra folders, behaviour checks don't run during sync, and sessions don't get titles yet.

## Key facts

- **Location:** `~/.workbuddy/` (fixed; no environment variable).
- **Usage files:** `trace_*.json` under `~/.workbuddy/traces/`.
- **Session audit** (CLI `workbuddy-session`) also reads `workbuddy.db` (`sessions`, `session_usage`) and `audit-log/*.jsonl`.
- **Extra folders:** not supported.
- **Behaviour findings:** none during normal sync.
- **Titles:** not yet. They live in `workbuddy.db`, which isn't wired up for titles.

<!-- source: crates/agent-vitals-harnesses/src/harnesses/workbuddy/sources/mod.rs (workbuddy_root: home.join(".workbuddy"); workbuddy.db sessions / session_usage; audit-log/*.jsonl) -->
<!-- source: crates/agent-vitals-harnesses/src/harnesses/workbuddy/sources/traces.rs (workbuddy_traces_root → root.join("traces"); trace_*.json) -->
<!-- source: crates/agent-vitals-harnesses/src/sources/session_harnesses.rs (workbuddy: accepts_custom_roots false, findings None, title_index None "workbuddy 的在 workbuddy.db sessions 表，暂未接"); custom_sources.rs (valid_harness excludes workbuddy) -->

## How are WorkBuddy costs shown?

WorkBuddy bills in its own credits. Oh Agent reports credits as credits, not money. A nominal yuan value (credits × 0.05, based on the public top-up price) appears only in the nominal column, never as money actually paid, and the cash-paid field stays empty because there's no payment evidence on your Mac.

<!-- source: workbuddy/sources/mod.rs module doc (credits; cash_cny 恒 null; nominal_cny = credits × 0.05 公开加量包兑换价折算; nominal_basis) -->

In Agent City the district label for this harness is **WorkBuddy** (fixture `id: "workbuddy"`, `display_name: "WorkBuddy"`).

<!-- source: apps/agent-city/ui/src/data/provider.ts (fixture harnesses: { id: "workbuddy", display_name: "WorkBuddy" }) -->

## Related

- [Claude Code data source](/docs/data-sources/claude-code)
- [Codex data source](/docs/data-sources/codex)
- [DeepSeek Harness data source](/docs/data-sources/deepseek-harness)
- [What each building in Agent City means](/docs/city-guide)
- [Install](/docs/install) · [FAQ](https://ohagent.ai/#faq)
