---
title: Where does Claude Code store session history, and how does Oh Agent read it?
lastUpdated: 2026-10-22
description: Claude Code saves each session as a JSONL file under ~/.claude/projects. Oh Agent reads those files locally and turns every session into a building.
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
          {"@type": "ListItem", "position": 3, "name": "Claude Code data source", "item": "https://ohagent.ai/docs/data-sources/claude-code"}
        ]
      }
---

Claude Code saves each session as a JSON Lines file under `~/.claude/projects/`, one folder per project and one `.jsonl` file per session. Oh Agent reads those files on your computer, without uploading them, and turns each session into a building in the Claude Code district of Agent City.

## Key facts

- **Location read:** `~/.claude/projects/**/*.jsonl` (all `.jsonl` files, recursively).
- **One file = one session.** The file name (without `.jsonl`) is the session ID.
- **Live updates:** Oh Agent watches `~/.claude/projects` and picks up new or growing sessions.
- **Tokens counted:** input, cache read, cache write and output tokens recorded in the log.
- **Read-only:** Oh Agent does not modify or move Claude Code's files.
- **Not followed yet:** a custom `CLAUDE_CONFIG_DIR` location (see below). You can add extra folders in Settings → Additional read locations.

<!-- source: crates/agent-vitals-harnesses/src/harnesses/claude_code/sources/mod.rs (claude_project_files: home/.claude/projects, extension == "jsonl", recursive WalkDir) -->
<!-- source: crates/agent-vitals-harnesses/src/sources/session_harnesses.rs (claude_session_sources: file_stem == native session id) -->
<!-- source: crates/agent-vitals-query/src/sources/watch_topology.rs (watch root: .claude/projects) -->
<!-- source: crates/agent-vitals-query/src/query/app_local.rs (uncached_input + cache_read + cache_write, output) -->

## Where exactly are Claude Code sessions stored?

On macOS the path is:

```
~/.claude/projects/<project-folder>/<session-id>.jsonl
```

Each line in the file is one event in the conversation (messages, tool calls, token usage). Claude Code creates `<project-folder>` from the directory you started it in.

<!-- source: docs/CLAUDE_CODE_INTEGRATION.md (~/.claude/projects/**/*.jsonl) -->

## What does Oh Agent take from these files?

For each session Oh Agent records the time range, number of events and token counts, plus a short bounded title or task excerpt where available. Those feed the city: one building per session, with height from its total tokens. See [What each building means](/docs/city-guide).

The Agent City view never receives full prompts, file paths, working directories, tool arguments or raw errors. Raw conversation text stays in Claude Code's own files. See [Does Oh Agent upload my sessions?](/docs/privacy-and-data).

<!-- source: crates/agent-vitals-query/src/query/app_local.rs (projected fields); AGENTS.md policy items 4 and 6 -->

## Why is my Claude Code district empty or smaller than expected?

- **No sessions yet in the window.** The desktop city shows the last 7, 30, 90 or 366 days; widen the window.
- **Old transcripts were cleaned up.** If Claude Code deleted a transcript before Oh Agent imported it, that session cannot be imported. Statistics already imported remain available within Oh Agent's retention window; deleting the source log only makes its original conversation unavailable. By default Claude Code deletes transcripts after 30 days; see [Why are my older sessions missing?](#why-are-my-older-sessions-missing-from-agent-city)
- **Another device.** History from other computers isn't merged.
- **Custom config folder.** If you set `CLAUDE_CONFIG_DIR`, Claude Code stores session history there instead of `~/.claude` (per [Anthropic's settings docs](https://docs.anthropic.com/en/docs/claude-code/settings)). Oh Agent 1.0.0-beta.3 doesn't follow that variable. You can add extra folders in Settings → Additional read locations, but each one is read as `<folder>/.claude/projects`, so it doesn't cover most custom config folders.
- **More than 4,000 sessions.** The most recent 4,000 sessions in the window are loaded.
- **Permission.** macOS may ask you to allow Oh Agent to read the folder.

<!-- source: apps/agent-city/ui/src/CityApp.tsx (windowOptions); website/landing/i18n.js faq.4, faq.5, faq.7; crates/agent-vitals-query/src/query/app_local.rs (SESSION_CAP = 4_000) -->
<!-- source: claude_code/sources/mod.rs hard-codes home/.claude/projects; no CLAUDE_CONFIG_DIR handling found in the repo (rg) -->
<!-- source: crates/agent-vitals-query/src/sources/custom_sources.rs (claude-code accepted); sync_service.rs (custom root passed to files_under, which joins .claude/projects) -->
<!-- source (external): docs.anthropic.com/en/docs/claude-code/settings — "set CLAUDE_CONFIG_DIR; Claude Code then stores your settings, session history, and plugins there" (fetched 2026-10-20) -->
<!-- note: crates/agent-vitals-query has a custom_sources module; UI entry point unverified -->

## Why are my older sessions missing from Agent City?

Claude Code deletes old session transcripts by itself. Its `cleanupPeriodDays` setting defaults to **30 days**, and the cleanup runs quietly in the background after a session starts. Oh Agent can only import sessions whose log files are still on your computer. So if Claude Code removed a transcript before Oh Agent ever read it, that session can't appear in Agent City, even in the 90- or 366-day window.

To keep more history, raise the value in `~/.claude/settings.json`:

```json
{
  "cleanupPeriodDays": 365
}
```

The value is a whole number of days, at least 1. `0` is rejected; for very long retention, Anthropic suggests a large value such as `3650`. The setting only affects transcripts that still exist. It can't bring back deleted ones.

Statistics Oh Agent has already imported stay in its own database after Claude Code deletes the log file, subject to Oh Agent's retention (13 months by default) and explicit source-data deletion in Settings. The original conversation stays in Claude Code's log file; if that file is gone, original-text viewing is unavailable, while the retained statistics can still appear in City within the selected time window.

<!-- source (external): https://code.claude.com/docs/en/settings-reference#cleanupperioddays — "Set how many days Claude Code keeps session transcripts … Default: 30 … Setting 0 fails validation, so pick a large value such as 3650"; scope Any file, User = ~/.claude/settings.json (fetched 2026-10-21) -->
<!-- source: crates/agent-vitals-ingest/src/ingest/sync_service.rs (a vanished file is a traversal error, not a delete); apps/desktop/src-tauri/src/lib.rs (delete_imported_source_data is an explicit user action); crates/agent-vitals-runtime-core/src/core/retention.rs (DEFAULT_RETENTION_MONTHS = 13) -->

## Do I need an API key or to be logged in?

No. Oh Agent reads files Claude Code already wrote. It needs no Anthropic API key and no Oh Agent account.

<!-- source: README.md ("No cloud account or API key is required"); website/landing/i18n.js faq.7 -->

## Related

- [Codex data source](/docs/data-sources/codex)
- [What each building in Agent City means](/docs/city-guide)
- [Install](/docs/install) · [FAQ](https://ohagent.ai/#faq)
