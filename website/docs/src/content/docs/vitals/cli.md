---
lastUpdated: 2026-10-30
title: "Agent Vitals CLI (agent-vitals): commands for syncing, querying and exporting agent data"
description: The agent-vitals command-line tool runs the Agent Vitals engine without the desktop app. Sync agent logs, check data status, export facts, manage manifest sources and start the Data MCP server.
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
          {"@type": "ListItem", "position": 3, "name": "Agent Vitals engine", "item": "https://ohagent.ai/docs/vitals/overview"},
          {"@type": "ListItem", "position": 4, "name": "CLI", "item": "https://ohagent.ai/docs/vitals/cli"}
        ]
      }
---

`agent-vitals` is the command-line front end of the Agent Vitals engine. It runs the same Rust code as the desktop app: sync agent logs into the local database, check data status, export facts, manage manifest sources, audit single sessions, and start the Data MCP server (stdio). It also keeps the commands of the earlier skill auditor. Help text is in English, and most commands take `--json`.

## Key facts

- **Source:** `apps/cli/` (subcommands in `apps/cli/src/main.rs`, built with clap).
- **Build:** `cargo build --release`, which gives `./target/release/agent-vitals`. Run `agent-vitals --help` for the full list.
- **Bundled:** the desktop app includes the binary as `bin/agent-vitals`.
- **Same data folder** as the app: `~/.agent-vitals/` or `AGENT_VITALS_HOME`.

<!-- source: apps/cli/src/main.rs (#[derive(Subcommand)] enum, lines ~144–918); README.md (Development quick start); apps/desktop/src-tauri/tauri.conf.json (bundle.resources) -->

## Data commands (the engine)

| Command | What it does |
| --- | --- |
| `sync-facts` | Routine sync: find logs, diff, parse, write to the SQL store. Safe to re-run |
| `data-status` | Store status: schema version, recent sync runs, source counts, data-quality summary |
| `data …` | Read-only summaries (for example `data coverage`, `data daily`) |
| `data-export-private --out DIR` | Export facts with identities as stored, one `<harness>.jsonl` per source |
| `data-export-redacted --out DIR` | Same export with identity fields replaced by stable pseudonyms |
| `data-unresolved` | Drill into unpriced or unresolved usage per model for a month |
| `billing-groups`, `data-harness-bill` | Billing confirmation groups; user-entered harness bills |
| `budget`, `budget-sql` | Budget alert status and management |
| `data-migrate` | One-time import of legacy facts JSONL into the SQL store |
| `data-reimport-verify` | Re-import into two throwaway databases and compare (doesn't touch your store) |
| `sessions …` | Versioned read-only session queries |
| `routes-quality` | Passive report of recorded model identity by source and model family |
| `data-mcp serve [--allow-local-writes]` | Start the stdio Data MCP server |

<!-- source: apps/cli/src/main.rs doc comments: SyncFacts ("Routine facts sync … Idempotent"), DataStatus, Data ("Read-only Data Query API surface … data coverage"), DataExportPrivate/DataExportRedacted, DataUnresolved, BillingGroups, DataHarnessBill, Budget, BudgetSql, DataMigrate, DataReimportVerify, Sessions, RoutesQuality, DataMcp -->

The clap help string for `sync-facts` still says "across all three harnesses"; the command syncs every registered built-in source (`claude-code`, `codex`, `dsh`, `workbuddy`) unless you pass `--harnesses`.

<!-- source: apps/cli/src/main.rs SyncFacts doc ("across all three harnesses") + --harnesses "Absent = all harnesses"; crates/agent-vitals-harnesses/src/sources/session_harnesses.rs (ids: claude-code, codex, dsh, workbuddy) -->

## Source commands

| Command | What it does |
| --- | --- |
| `harness-inventory --window-days 30` | Which sources are registered, have data, or are only candidates. Never activates anything |
| `harnesses` | Print the declared capabilities of the four built-in sources |
| `manifest-validate`, `manifest-install`, `manifest-list`, `manifest-uninstall`, `manifest-rollback`, `manifest-recompute`, `manifest-catalog-status` | Manifest sources: dry-run, preview → confirm, list, remove, roll back |
| `claude-usage-facts`, `codex-usage-facts`, `dsh-usage-facts`, `workbuddy-usage-facts` | Parse one source's files into usage-fact rows, for diagnosis |

<!-- source: main.rs (HarnessInventory, Harnesses "Print the HarnessProfile registry … the four runtime harnesses", Manifest*, ClaudeUsageFacts, CodexUsageFacts, DshUsageFacts, WorkbuddyUsageFacts) -->

## Session audit and trace commands

| Command | What it does |
| --- | --- |
| `claude-session`, `codex-session`, `workbuddy-session`, `codex-evidence` | Audit one session into a normalized session with coverage and SV601–SV614 findings |
| `behavior`, `skill-audit`, `duration-audit` | Audit a DSH session log for risky behaviour, skill use or durations |
| `trace-ref` | Build the trace graph for a session from `sessions list`, without exposing file paths |
| `trace`, `trace-anchors` | Trace graph for one file; anchor report for local viewing only (never an MCP tool) |
| `codex-cost` | Price Codex token usage per model and day |
| `probe`, `trust …` | Desktop "Test" tab probes; local trust / egress history audit |

<!-- source: main.rs (ClaudeSession, CodexSession, WorkbuddySession, CodexEvidence, Behavior, SkillAudit, DurationAudit, TraceRef, Trace, TraceAnchors "LOCAL presentation layer only, never an MCP tool", CodexCost, Probe, Trust) -->

## Older skill-auditor commands

`list`, `doctor`, `plan`, `snapshot`, `diff`, `explain` and `overlap` come from the earlier skill auditor: they list installed Agent Skills, diagnose why one doesn't load, and plan cleanup. They are kept but aren't the main product story (the older skill auditor).

<!-- source: main.rs (List "List discovered skills and their effective state", Doctor, Plan, Snapshot, Diff, Explain, Overlap); README.md ("The earlier Skill scanner, integrations and CLI remain in the repository") -->

## Examples

```sh
# Import new sessions now instead of waiting for the app's 5-minute sync
agent-vitals sync-facts

# Is the data fresh?
agent-vitals data-status --json

# Back up your facts, pseudonymized
agent-vitals data-export-redacted --out ~/oh-agent-export
```

Flags above match the clap definitions in `apps/cli/src/main.rs`: `data-status --json` is a boolean flag; `data-export-redacted` requires `--out DIR`; `sync-facts` also accepts optional `--json` and `--harnesses`.

<!-- source: apps/cli/src/main.rs DataStatus.rows_json bool; DataExportRedacted.out PathBuf; SyncFacts.rows_json bool + harnesses Option -->

## Related

- [Agent Vitals engine overview](/docs/vitals/overview)
- [Claude Code data source](/docs/data-sources/claude-code) · [Codex data source](/docs/data-sources/codex)
- [DeepSeek Harness data source](/docs/data-sources/deepseek-harness) · [WorkBuddy data source](/docs/data-sources/workbuddy)
- [What each building in Agent City means](/docs/city-guide)
- [Privacy and data](/docs/privacy-and-data) · [Install](/docs/install) · [FAQ](https://ohagent.ai/#faq)
