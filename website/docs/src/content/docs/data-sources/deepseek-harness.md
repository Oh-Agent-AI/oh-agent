---
lastUpdated: 2026-10-27
title: Where does DeepSeek Harness (DSH) store sessions, and how does Oh Agent read them?
description: Oh Agent reads DeepSeek Harness session logs from $DSH_HOME/sessions (default ~/.dsh), including zstd-compressed files, and builds a DSH district in Agent City.
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
          {"@type": "ListItem", "position": 3, "name": "DeepSeek Harness data source", "item": "https://ohagent.ai/docs/data-sources/deepseek-harness"}
        ]
      }
---

DeepSeek Harness (DSH) keeps each session as a `session.jsonl` file, sometimes compressed as `session.jsonl.zstd`, under the `sessions/` folder of its home directory. That directory is `$DSH_HOME`, or `~/.dsh` if the variable isn't set. Agent Vitals reads these files on your Mac and shows each session as a building in the DSH district of Agent City.

## Key facts

- **Location:** `$DSH_HOME/sessions/`, recursively. `DSH_HOME` defaults to `~/.dsh`.
- **Files read:** `session.jsonl` and `session.jsonl.zstd`.
- **`DSH_HOME` is followed**, even outside your home folder. This is the only built-in source that honours an environment variable for its location.
- **Titles** come from DSH's workspace index, `storages/workspace.json`.
- **Behaviour checks:** yes. DSH sessions get the same SV6xx findings as Claude Code and Codex.
- **Extra folders:** supported in Settings.

<!-- source: crates/agent-vitals-harnesses/src/harnesses/dsh/sources/discovery.rs (dsh_session_files_with_errors: dsh_home.join("sessions"), "session.jsonl" || "session.jsonl.zstd") -->
<!-- source: crates/agent-vitals-query/src/sessions/discovery.rs (DSH_HOME env → default ~/.dsh); crates/agent-vitals-query/src/sources/watch_topology.rs ("Configured：内置执行环境的明确运行时根配置（当前仅 DSH_HOME）") -->
<!-- source: crates/agent-vitals-harnesses/src/sources/session_harnesses.rs (dsh: findings Some, accepts_custom_roots true, title_index dsh_title_index → storages/workspace.json) -->

## What does Oh Agent take from DSH sessions?

The same summary as for other sources: time range, event count, token counts and a bounded title. DSH logs record provider evidence, so cost estimates for DSH can tell routes apart better than for Claude Code.

<!-- source: AGENTS.md (Cross-harness audit status: "DSH already persists provider evidence (provider_raw and the provider/billing fields)") -->

## Is there also a DSH plugin?

Yes, but it's separate from session reading. The `dsh-agent-vitals` bundle in `integrations/dsh/` adds the older skill auditor as a skill inside DSH (`dsh plugin --profile web add dsh-agent-vitals`). You don't need it for Agent City.

<!-- source: integrations/dsh/README.md -->

In Agent City the district label for this harness is **DSH** (fixture `id: "dsh"`, `display_name: "DSH"`).

<!-- source: apps/agent-city/ui/src/data/provider.ts (fixture harnesses: { id: "dsh", display_name: "DSH" }) -->

## Related

- [Claude Code data source](/docs/data-sources/claude-code)
- [Codex data source](/docs/data-sources/codex)
- [What each building in Agent City means](/docs/city-guide)
- [Install](/docs/install) · [FAQ](https://ohagent.ai/#faq)
