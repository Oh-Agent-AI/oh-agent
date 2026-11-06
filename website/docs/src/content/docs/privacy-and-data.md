---
title: Does Oh Agent upload my sessions? Data and privacy explained
lastUpdated: 2026-10-22
description: Oh Agent analyzes Claude Code and Codex history on your computer and never uploads sessions. What it reads, when it goes online, and what MCP changes.
head:
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
          {
            "@type": "ListItem",
            "position": 1,
            "name": "Oh Agent",
            "item": "https://ohagent.ai/"
          },
          {
            "@type": "ListItem",
            "position": 2,
            "name": "Docs",
            "item": "https://ohagent.ai/docs"
          },
          {
            "@type": "ListItem",
            "position": 3,
            "name": "Data and privacy",
            "item": "https://ohagent.ai/docs/privacy-and-data"
          }
        ]
      }
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
          {
            "@type": "Question",
            "name": "Does Oh Agent upload my sessions?",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "No. Oh Agent analyzes your agent history on your computer and never uploads sessions, logs or analysis results. No cloud account and no API key are required."
            }
          },
          {
            "@type": "Question",
            "name": "What files does Oh Agent read?",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "Oh Agent reads the session logs that supported agents already keep in your home folder: ~/.claude/projects for Claude Code, ~/.codex/sessions and ~/.codex/archived_sessions for Codex, ~/.workbuddy for WorkBuddy, and ~/.dsh (or $DSH_HOME) for DeepSeek Harness."
            }
          },
          {
            "@type": "Question",
            "name": "When does the Oh Agent app use the network?",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "Only for a few public requests that carry no local data: downloading public price and exchange-rate tables, checking for a new release on GitHub, and, if you choose to, downloading the official plugin index or signed packages."
            }
          },
          {
            "@type": "Question",
            "name": "What can the Agent City view see?",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "The City receives only declared, bounded fields. Per session: an opaque ID, the agent, start and end time, event count, token counts split into uncached input, cache read, cache write and output, the model IDs used, an estimated cost with its status, a short bounded title and up to two short task excerpts, and a stable City asset ID. For the whole window: totals, daily activity, findings counted per agent and severity, and recorded skill use (skill name, invocation count, outcomes, last use). It cannot see full prompts, raw logs, file paths, working directories, tool arguments or raw error messages."
            }
          },
          {
            "@type": "Question",
            "name": "Does connecting Oh Agent to an AI agent over MCP change privacy?",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "Yes. MCP serves redacted data to agents running on your computer, but if that agent talks to a cloud model, whatever it receives can leave your machine inside its context. Connecting an agent is your decision and is not the same as viewing data locally."
            }
          }
        ]
      }
---

No. Oh Agent analyzes your agent history on your computer and never uploads sessions, logs or analysis results. This page explains exactly what the app reads, the few times it goes online, and where the boundaries change (MCP and export). For the legal policy, see the [privacy policy](https://ohagent.ai/#privacy).

<!-- source: README.md ("Your history stays on your machine"); AGENTS.md ("Data Retention & Serving-Face Policy (2026-09-19)") -->

## Key facts

- Sessions are analyzed locally. **No upload, no telemetry, no cloud sync.**
- **No account and no API key** needed.
- Network requests are limited to public files (price tables, exchange rates, release check, optional official plugin index) and **carry no local data**.
- The City view gets a bounded per-session summary. It **never sees file paths, working directories, tool arguments, raw errors or full prompts**.
- Raw conversation text stays in your agents' own log files; Oh Agent's database stores pointers and statistics, not full copies.
- MIT-licensed source you can inspect. Open source is not a security certification.

<!-- source: AGENTS.md policy items 2, 4, 6; README.md ("MIT licensing makes the implementation inspectable; it is not a security certification") -->

## Does Oh Agent upload my sessions?

No. Oh Agent analyzes your agent history on your computer and never uploads sessions, logs or analysis results. No cloud account and no API key are required.

Analysis results stay in a local database on your computer. The [web demo](https://ohagent.ai/) uses synthetic sessions only and does not read anything from your computer.

<!-- source: README.md; AGENTS.md ("the app never uploads user data ... do not add telemetry, payload-bearing crash reports, cloud sync"); website/landing/i18n.js faq.1, faq.7 -->

## What files does Oh Agent read?

Oh Agent reads the session logs that supported agents already keep in your home folder: ~/.claude/projects for Claude Code, ~/.codex/sessions and ~/.codex/archived_sessions for Codex, ~/.workbuddy for WorkBuddy, and ~/.dsh (or $DSH_HOME) for DeepSeek Harness.

| Agent | Folder read | Details |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | [Claude Code data source](/docs/data-sources/claude-code) |
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` (`rollout-*.jsonl`) | [Codex data source](/docs/data-sources/codex) |
| WorkBuddy | `~/.workbuddy` | — |
| DeepSeek Harness | `~/.dsh`, or `$DSH_HOME` if set | — |

Raw conversation text stays in those files. Oh Agent's own database keeps pointers into the logs (source and event IDs, offsets) plus derived statistics, not a full copy. If an agent deletes or rotates an old log, Oh Agent says the source has expired instead of keeping its own copy.

Your operating system may ask you to allow access to these folders.

<!-- source: crates/agent-vitals-query/src/sources/watch_topology.rs (default_source_watch_roots) -->
<!-- source: crates/agent-vitals-harnesses/src/harnesses/claude_code/sources/mod.rs (claude_project_files: ~/.claude/projects, *.jsonl) -->
<!-- source: crates/agent-vitals-harnesses/src/harnesses/codex/sources/mod.rs (codex_rollout_files: sessions + archived_sessions, rollout-*.jsonl) -->
<!-- source: crates/agent-vitals-harnesses/src/harnesses/workbuddy/sources/mod.rs (workbuddy_root); crates/agent-vitals-runtime-core/src/core/home.rs (dsh_home, DSH_HOME) -->
<!-- source: AGENTS.md policy item 4 ("Raw text lives in the harnesses' logs, not in the authority DB"); website/landing/i18n.js faq.7 (macOS may ask for permission) -->

## When does the Oh Agent app use the network?

Only for a few public requests that carry no local data: downloading public price and exchange-rate tables, checking for a new release on GitHub, and, if you choose to, downloading the official plugin index or signed packages.

| Request | Destination | What is sent |
|---|---|---|
| Price table and exchange-rate snapshot (checked about every 6 hours, behind an update switch) | Static JSON files on `raw.githubusercontent.com` in the project repository | A plain file download, no user data |
| New-version check | GitHub Releases API for the project repository | A plain request, no user data |
| Official plugin index or signed packages (only when you opt in) | Fixed public HTTPS sources | A plain download, no user data |

No request may include local logs, machine identifiers, credentials or analysis data. The price-table and exchange-rate update is **off by default**: the app only checks after you explicitly allow it.

<!-- source: apps/desktop/src-tauri/src/lib.rs (PUBLIC_PRICING_CATALOG_URL, PUBLIC_FX_SNAPSHOT_URL, PRICING_CHECK_INTERVAL_MS = 6h, LATEST_RELEASE_API) -->
<!-- source: crates/agent-vitals-ingest/src/ingest/vendor_manifest_install.rs (official catalog index URL) -->
<!-- source: AGENTS.md ("No request may include local logs, machine identifiers, grants, credentials, or analytical user data") -->
<!-- source: apps/desktop/src-tauri/src/lib.rs (PricingCatalogPolicy.network_enabled defaults to false; update refuses until explicitly allowed). URLs point at Oh-Agent-AI/oh-agent. -->

## What can the Agent City view see?

The City receives only declared, bounded fields. Per session: an opaque ID, the agent, start and end time, event count, token counts split into uncached input, cache read, cache write and output, the model IDs used, an estimated cost with its status, a short bounded title and up to two short task excerpts, and a stable City asset ID. For the whole window: totals, daily activity, findings counted per agent and severity, and recorded skill use (skill name, invocation count, outcomes, last use). It cannot see full prompts, raw logs, file paths, working directories, tool arguments or raw error messages.

Session IDs given to the City are salted, app-specific identifiers, not the agent's own session IDs. The City runs as a built-in plugin: it never touches the database or log files directly, cannot run arbitrary SQL, and only receives the fields the host declares for it. Cost figures are estimates, not bills. The City asset ID is random and kept in a separate local registry; it isn't derived from your files.

<!-- source: crates/agent-vitals-query/src/query/app_local.rs (dev bf7196a city:v2 fields: id = session_ref(salt, ...), harness, title, title_source, first/last_event_at, event_count, tokens incl. uncached_input/cache_read/cache_write, model_ids, cost_minor, cost_breakdown, cost_status, task_excerpts; summary, models, activity, findings) -->
<!-- source: crates/agent-vitals-query/src/query/city_v3.rs (asset_ref; module.read findings current_backlog/window_new counts; skills → session_statistics::skill_activity, ≤200 rows); city_assets.rs ("No title, excerpt, path, native id or reward is persisted here") -->
<!-- source: AGENTS.md policy item 6 ("Full prompts/raw JSONL, raw anchors, log paths, working directories, invocation arguments and raw errors are not enabled"; "plugins never access the authority DB or harness logs directly") -->

## Does connecting Oh Agent to an AI agent over MCP change privacy?

Yes. MCP serves redacted data to agents running on your computer, but if that agent talks to a cloud model, whatever it receives can leave your machine inside its context. Connecting an agent is your decision and is not the same as viewing data locally.

The built-in MCP server keeps its redaction rules: it never exposes raw errors or tool-call arguments. Exports are redacted by default; a private export has to be chosen explicitly.

<!-- source: AGENTS.md policy item 2 ("never expose raw errors or invocation arguments"; data-export-redacted default, data-export-private explicit); README.md ("connecting a networked agent is not equivalent to viewing data locally") -->

## Does Oh Agent store my API keys?

No. Credentials are never saved in anything Oh Agent owns. Some test features can pass a key to a child process in memory only.

<!-- source: AGENTS.md policy item 3 -->

## Related

- [Privacy policy](https://ohagent.ai/#privacy)
- [What each building in Agent City means](/docs/city-guide)
- [Claude Code data source](/docs/data-sources/claude-code) · [Codex data source](/docs/data-sources/codex)
- [FAQ](https://ohagent.ai/#faq)
