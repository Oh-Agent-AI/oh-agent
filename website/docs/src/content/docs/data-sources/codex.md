---
title: Where does Codex store session logs, and how does Oh Agent visualize them?
lastUpdated: 2026-10-22
description: Codex CLI saves each session as a rollout-*.jsonl file under ~/.codex/sessions. Oh Agent reads them on your computer and builds a Codex district in Agent City.
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
          {"@type": "ListItem", "position": 3, "name": "Codex data source", "item": "https://ohagent.ai/docs/data-sources/codex"}
        ]
      }
---

Codex saves each session as a "rollout" file, `rollout-*.jsonl`, under `~/.codex/sessions/` (organised by date), and archived sessions under `~/.codex/archived_sessions/`. Oh Agent reads both folders on your computer, without uploading anything, and shows each session as a building in the Codex district of Agent City.

## Key facts

- **Locations read:** `~/.codex/sessions/` and `~/.codex/archived_sessions/`, recursively.
- **Files read:** only names matching `rollout-*.jsonl`.
- **One rollout file = one session.**
- **Archived sessions count too**, so archiving in Codex doesn't remove them from the city.
- **Live updates:** Oh Agent watches `~/.codex` for changes.
- **Not followed yet:** a custom `CODEX_HOME` location (see below). You can add extra folders in Settings → Additional read locations.

<!-- source: crates/agent-vitals-harnesses/src/harnesses/codex/sources/mod.rs (codex_rollout_files: [("live","sessions"),("archived","archived_sessions")], name starts_with "rollout-" && ends_with ".jsonl") -->
<!-- source: crates/agent-vitals-query/src/sources/watch_topology.rs (watch root: .codex; comment: real discovery roots are sessions + archived_sessions) -->

## Where exactly are Codex sessions stored?

A typical path looks like this:

```
~/.codex/sessions/2026/08/22/rollout-2026-08-22T22-06-31-<id>.jsonl
```

Sessions are grouped into year/month/day folders, and the file name starts with the session's start time. Each line is one event (messages, tool calls, token counts).

<!-- source: docs/CODEX_SESSION_ENRICHMENT.md (example path ~/.codex/sessions/2026/08/22/rollout-2026-08-22T22-06-31-<uuid>.jsonl) -->

## What does Oh Agent take from these files?

The same per-session summary as for other agents: time range, event count, token counts (input, cache read, cache write, output) and a short bounded title or task excerpt where available. Height in the city comes from total tokens. See [What each building means](/docs/city-guide).

File paths, working directories, tool arguments and raw errors are never passed to the City view. Details: [Does Oh Agent upload my sessions?](/docs/privacy-and-data).

<!-- source: crates/agent-vitals-query/src/query/app_local.rs; AGENTS.md policy item 6 -->

## Why are some Codex sessions missing?

- **Outside the time window.** Widen it to 30, 90 or 366 days.
- **Custom `CODEX_HOME`.** Codex can keep its data in another folder via the `CODEX_HOME` environment variable. Oh Agent 1.0.0-beta.3 doesn't follow that variable. You can add extra folders in Settings → Additional read locations, but each one is read as `<folder>/.codex/sessions` and `<folder>/.codex/archived_sessions`.
- **Deleted log files.** If a rollout file was deleted before Oh Agent imported it, that session cannot be imported. Already imported statistics remain available within Oh Agent's retention window (13 months by default), unless you explicitly delete the source's data in Settings. They can still appear in City within the selected time window, but the original conversation is unavailable once its source file is gone.
- **Other devices.** History from other computers isn't merged.
- **More than 4,000 sessions.** The most recent 4,000 in the window are loaded.

<!-- source: apps/agent-city/ui/src/CityApp.tsx (windowOptions); codex/sources/mod.rs hard-codes home/.codex (no CODEX_HOME handling found by rg); website/landing/i18n.js faq.4; app_local.rs SESSION_CAP = 4_000 -->

## Does Oh Agent need my OpenAI API key?

No. It reads the files Codex already saved. No API key and no Oh Agent account are needed.

<!-- source: README.md; website/landing/i18n.js faq.7 -->

## Related

- [Claude Code data source](/docs/data-sources/claude-code)
- [What each building in Agent City means](/docs/city-guide)
- [Install](/docs/install) · [FAQ](https://ohagent.ai/#faq)
