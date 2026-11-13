---
lastUpdated: 2026-11-13
title: What can Oh Agent connect to? Integrations and extension points
description: Every real integration point in Oh Agent today (agent data sources, custom folders, manifest sources, the local Data MCP server, built-in plugins, exports), plus what is still planned.
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
          {"@type": "ListItem", "position": 3, "name": "Integrations", "item": "https://ohagent.ai/docs/integrations"}
        ]
      }
---

Oh Agent is built on the open-source Agent Vitals engine, and Agent City is its first app. The engine connects in two directions. **Data comes in** from agents' local session logs: four built-in sources, extra folders you add, and local manifest sources. **Data goes out** only through narrow local interfaces: a stdio Data MCP server for your own AI agent, read-only projections for built-in plugins such as Agent City and Creator Studio, and file exports you start by hand. Everything below exists in the code on the `dev` branch at commit `36e4b55a` unless it's in the Roadmap section.

## What exists today

| Integration | Direction | Who uses it | Status |
| --- | --- | --- | --- |
| [Claude Code](/docs/data-sources/claude-code) | In | Everyone | Built in |
| [Codex](/docs/data-sources/codex) | In | Everyone | Built in |
| [DeepSeek Harness (DSH)](/docs/data-sources/deepseek-harness) | In | Everyone | Built in |
| [WorkBuddy](/docs/data-sources/workbuddy) | In | Everyone | Built in (usage; fewer behaviour checks) |
| Extra folders | In | Users with logs in other places | Desktop Settings, for Claude Code, Codex and DSH |
| Manifest sources | In | Users of agents without built-in support | CLI and desktop; local import only, official catalog empty |
| Skill auditor | In (skills) | Users auditing installed Agent Skills | Agent skill, DSH bundle, CLI |
| [Data MCP server](/docs/vitals/mcp-tools) | Out | Your local AI agent (stdio MCP client) | `agent-vitals data-mcp serve` |
| [Built-in plugins](/docs/vitals/app-sdk) | Out (inside the app) | Contributors building views like City | Official (Agent City, Creator Studio), compiled in; no third-party install |
| Data export | Out (files) | Users, for backup or analysis | `data-export-private` / `data-export-redacted` → one `<harness>.jsonl` per source |
| City photo and film export | Out (files) | Users, for sharing | Native save dialog; stats overlay only, no excerpts |

<!-- source: crates/agent-vitals-harnesses/src/sources/session_harnesses.rs (SESSION_HARNESSES: claude-code, codex, dsh, workbuddy; accepts_custom_roots false for workbuddy; findings None for workbuddy) -->
<!-- source: crates/agent-vitals-query/src/sources/custom_sources.rs (valid_harness: claude-code | codex | dsh); catalog/index.json ("entries": []) -->
<!-- source: apps/cli/src/mcp.rs; apps/desktop/plugins.json (city, creator-studio); apps/cli/src/main.rs (DataExportPrivate / DataExportRedacted: "files land as <harness>.jsonl") -->
<!-- source: docs/CITY_LOCAL_DATA_PROJECTION.md (allowLocalExports: 原生保存对话框; 照片/影片只叠加统计，不把用户摘录写入成片); apps/agent-city/ui/src/export/ (filmJob.ts, film.worker.ts), engine/mp4Muxer.ts, webmMuxer.ts -->

## Which adapters exist in code?

Each folder in `crates/agent-vitals-harnesses/src/harnesses/` is one adapter:

| Adapter folder | Sessions and usage (city district) | Behaviour findings | Skill audit | Docs |
| --- | --- | --- | --- | --- |
| `claude_code` | Yes | Yes | Yes | [Claude Code](/docs/data-sources/claude-code) |
| `codex` | Yes | Yes | Yes | [Codex](/docs/data-sources/codex) |
| `dsh` | Yes | Yes | Yes (agent/preset scopes) | [DeepSeek Harness](/docs/data-sources/deepseek-harness) |
| `workbuddy` | Yes | Not during sync | Yes | [WorkBuddy](/docs/data-sources/workbuddy) |
| `openclaw` (also covers Hermes) | No | No | Yes | Skill auditor |
| `generic` (manifest sources) | Yes, usage only | No | No | Manifest sources |

<!-- source: crates/agent-vitals-harnesses/src/harnesses/mod.rs (claude_code, codex, dsh, generic, openclaw, workbuddy); session_harnesses.rs (findings for claude-code, codex, dsh); claude_code/skills, codex/skills, workbuddy/sources/skills.rs, openclaw/sources/skills.rs; docs/HARNESS_ADAPTER_CONTRACT.md (observer table: dsh agent / preset scope) -->

DSH has no `harnesses/dsh/skills/` folder; its skill scopes are described in `HARNESS_ADAPTER_CONTRACT.md`.

## Which one should I use?

- **You want your own AI agent to answer questions about your usage**: use the [Data MCP server](/docs/vitals/mcp-tools).
- **Your Claude Code, Codex or DSH logs live somewhere else**, such as a backup drive: add an extra folder in Desktop Settings.
- **Your agent isn't supported** but writes JSONL logs with token usage: write a manifest. No code needed.
- **You want full support for a new agent**, including behaviour checks: add a data source in Rust and open a PR.
- **You want a new visual view** on top of Agent Vitals data: see [Built-in plugins](/docs/vitals/app-sdk).

## Older integrations still in the repo

Before Agent City, the project shipped a skill auditor, and it's still in the repo: an agent skill (`SKILL.md`, packaged for ClawHub), a DSH bundle (`integrations/dsh/`), and CLI commands. OpenClaw and Hermes appear only there.

<!-- source: README.md ("The earlier Skill scanner, integrations and CLI remain in the repository, but are not the primary product story") -->

## Roadmap / 规划中

These items are still planned or only partly shipped on `dev` at `36e4b55a`.

- **Partial: Agents that help build your city (MCP).** `get_building` / `preview_building` / `set_building_model` / `reset_building` persist a `session-kit/v1` override keyed by `asset_ref`. An open City window plays construction from a shared `CityEntityChanged` host event (`entity_kind=building`). Successful preview shows a ghost mesh; compliance / detail-regression / design-coherence rejects flash the lot. Soft design issues return `data.warnings`. Writes also fan out a squad IM envelope; agents publish `chat` / `claim` / `release` with `im_publish`. See `docs/CITY_BUILDING_MCP.md` and `docs/CITY_SQUAD_IM.md`.
- **Not yet: Incremental hot update.** Today a data change makes City reload the full projection and rebuild the whole scene, with a stable layout and growth animation (see [Data pipeline](/docs/architecture/data-pipeline#how-does-agent-city-update-when-new-sessions-arrive)). Sending only changed sessions and patching single buildings, Vite-style, isn't implemented.
- **Not yet: City gallery (UGC).** Sharing and browsing other people's cities is not shipped.
- **In progress: Map editor and Creator Studio.** A city "repair" editor exists (its first priorities were finished on 2026-10-12). Creator Studio is also in the `dev` tree as a second official built-in plugin, with a live city viewport. Turning that into a finished product feature (translations, onboarding) and importing/exporting map edits are not done yet.
- **Official manifest catalog.** The download channel and checks exist, but `catalog/index.json` has no entries yet.
- **Not promised:** script adapters for manifests (P1.5), a manifest expression language (P2) and a community manifest catalog (P3) are design reservations, not commitments.
- **Assessed, not built:** the repo has assessment notes for Cline, Pi and Hermes as session sources (`docs/*_HARNESS_ASSESSMENT.md`). This page does not give them a schedule.

<!-- source: apps/cli/src/mcp.rs + crates/agent-vitals-mcp/src/mcp/mod.rs (city building tools: get_building / preview_building / set_building_model / reset_building / im_publish) -->
<!-- source: apps/desktop/plugins.json (creator-studio); docs/CITY_MAP_EDITOR_ROADMAP_SPEC.md ("P0 已完成（2026-10-12）；P1 起待排期"; P3 #10 地图修改导入/导出, #12 产品化); docs/AGENT_CITY_CREATOR_STUDIO_PRD_2026_11_11.md -->
<!-- source: docs/HARNESS_MANIFEST_DSL_SPEC.md §1 (脚本 adapter P1.5 未承诺; DSL P2; 社区目录 P3 未承诺); catalog/README.md -->
<!-- source: docs/CLINE_HARNESS_ASSESSMENT.md, docs/PI_HARNESS_ASSESSMENT.md, docs/HERMES_HARNESS_ASSESSMENT.md (exist; content not reviewed for this page) -->

## Related

- [Agent Vitals engine](/docs/vitals/overview)
- [Architecture overview](/docs/architecture/overview)
- [Data pipeline](/docs/architecture/data-pipeline)
