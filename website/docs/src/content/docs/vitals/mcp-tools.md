---
draft: true
title: "Agent Vitals Data MCP tools: let your AI agent read your agent data locally"
description: Oh Agent's CLI includes a local stdio MCP server, agent-vitals data-mcp serve, that lets Claude Code, Codex or another MCP client query your agent usage data. Read-only by default.
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
          {"@type": "ListItem", "position": 4, "name": "Data MCP tools", "item": "https://ohagent.ai/docs/vitals/mcp-tools"}
        ]
      }
---

Agent Vitals, the data layer of Oh Agent, has a local MCP server. Run `agent-vitals data-mcp serve`, register it in an MCP client such as Claude Code or Codex, and that agent can ask typed questions about your usage: data status, hourly usage, sessions, cost breakdowns, data-quality issues. It talks over stdio only, opens the database read-only, and can only change settings if you start it with `--allow-local-writes`.

## Key facts

- **Command:** `agent-vitals data-mcp serve`. The handshake `serverInfo.name` is `Oh Agent MCP`. The sample client key is `oh-agent`.
- **Transport:** stdio, JSON-RPC 2.0, one JSON message per line. MCP protocol version `2025-06-18`.
- **Methods:** `initialize`, `tools/list`, `tools/call`, `ping`. No resources or prompts.
- **Read-only by default.** It opens the database read-only and never creates or migrates it.
- **Writes need a flag.** `--allow-local-writes` turns on typed settings and billing actions. There is still no arbitrary SQL, URL fetching or general file writing.
- **No network listener.** It only runs while a client keeps its stdin open.

<!-- source: apps/cli/src/main.rs (DataMcp / DataMcpAction::Serve { allow_local_writes }: "Arbitrary SQL, raw source payloads, and generic filesystem writes remain unavailable") -->
<!-- source: apps/cli/src/mcp.rs (PROTOCOL_VERSION = "2025-06-18"; SERVER_NAME = "Oh Agent MCP"; line-delimited framing; methods; stdin EOF → exit 0) -->
<!-- source: docs/AGENT_VITALS_DATA_MCP_SPEC.md §6.4 ("不实现 resources/*、prompts/*"); crates/agent-vitals-mcp/src/mcp/mod.rs (AuthorityHandle: 只读打开权威库，不建库、不迁移) -->

## Which tools are available?

| Tool | What it answers |
| --- | --- |
| `data_status` | Is the data fresh? Coverage per source, last sync |
| `usage_hourly` | Token usage by hour and source |
| `sessions_search` / `session_detail` / `session_trace` | Find sessions and inspect a redacted session summary or trace |
| `cost_breakdown` | Estimated cost by price version, currency and billing basis, with unresolved usage shown separately |
| `budget_profiles` | Budget settings and status |
| `price_cards` | Models missing a price card; with `--allow-local-writes`, your agent can add user-set price cards |
| `data_quality_issues` | Data-quality problems, filtered, with redacted details |
| `issues_summary` / `skills_summary` | Behaviour findings and skill-usage summaries |
| `control_plane` | Source status, extra folders, exclusions, retention, time zone, sync pause/run, catalog policy (writes need the flag) |
| `trust_profile_*` | Schema, list, validate, stage and status for Trust audit profiles |
| `get_building` / `preview_building` / `set_building_model` / `reset_building` | Read, validate, replace, or reset one Agent City session building model (`session-kit/v1`, ≤64 parts). Writes need `--allow-local-writes`. An open City window plays construction from the shared `CityEntityChanged` host event; preview shows a ghost; compliance / detail-regression / disconnected-part / massing-drift rejects flash the lot. `data.ok` is not design approval — agents must show `data.warnings`. Successful and failed writes also fan out a squad IM envelope (`docs/CITY_SQUAD_IM.md`) |
| `im_publish` | Publish a squad IM envelope (`chat` / `claim` / `release` only). Server assigns `id`/`ts`. Writes need `--allow-local-writes`. Building preview/set/reset are not Agent-reported |

Three more tools (`query_sql_readonly`, `billing_workflow`, `authority_audit`) are only compiled in with the internal `mcp-internal` feature, so they aren't in normal builds.

<!-- source: crates/agent-vitals-mcp/src/mcp/mod.rs (dispatch match: data_status, usage_hourly, budget_profiles, cost_breakdown, sessions_search, session_detail, session_trace, control_plane, price_cards, data_quality_issues, issues_summary, skills_summary, trust_profile_schema/list/validate/stage/proposal_status, get_building, preview_building, set_building_model, reset_building, im_publish; #[cfg(feature = "mcp-internal")] query_sql_readonly, billing_workflow, authority_audit) -->
<!-- note: docs/AGENT_VITALS_DATA_MCP_SPEC.md §7 lists billing_workflow as "v1.0 local control plane", but in code it is behind mcp-internal. Code wins here. -->

## How do I connect it to Claude Code or Codex?

Point your MCP client at the `agent-vitals` binary with the arguments `data-mcp serve`. A generic MCP client entry looks like this:

```json
{
  "mcpServers": {
    "oh-agent": {
      "command": "/path/to/agent-vitals",
      "args": ["data-mcp", "serve"]
    }
  }
}
```

**TBD:** the binary's exact path inside the installed app. The bundle places it as a resource at `bin/agent-vitals`, which on macOS is likely `/Applications/Oh Agent.app/Contents/Resources/bin/agent-vitals` (note the space in the app name; quote the path). Verify on a real install. A developer build is at `target/release/agent-vitals`.

**TBD:** tested, copy-paste setup steps for Claude Code (`claude mcp add …`) and Codex (`~/.codex/config.toml`). The repo doesn't document client setup.

<!-- source: apps/desktop/src-tauri/tauri.conf.json (bundle.resources "../../../target/release/agent-vitals": "bin/agent-vitals"); README.md (cargo build --release → ./target/release/agent-vitals) -->
<!-- source: docs/v1.0.0/UAT_SMALL_LOOPS.md (manual check: printf … | agent-vitals data-mcp serve) -->

## What does the MCP server never reveal?

- Raw error text and tool-call arguments, which are redacted in issue summaries.
- Native session IDs. Sessions are referred to by keyed one-way references.
- Absolute file paths, which `control_plane` reads never return.
- Credentials and confidential probe tasks.

Keep in mind that whatever the server returns lands in your agent's context, and that agent may send it to its model provider. Connecting MCP isn't the same as viewing data locally in the app.

The repo treats this as an egress boundary. `crates/agent-vitals-mcp` is the outbound face where the redaction rules are reviewed, and the stdio transport lives separately in `apps/cli/src/mcp.rs`. Redaction is applied when data is served, never by dropping data at ingest.

<!-- source: CLAUDE.md (crates/agent-vitals-mcp: "L6 Data MCP 工具应用层——出口面，脱敏红线在这里审（传输层在 apps/cli/src/mcp.rs）"; "出口收口（脱敏是呈现期投影）"); AGENTS.md policy item 2 ("local agents are networked consumers, so anything served over data-mcp can leave the machine inside an agent's context"); item 3 (canaries never exposed via MCP) -->
<!-- source: docs/AGENT_VITALS_DATA_MCP_SPEC.md (control_plane: "读取安全可用且不返回绝对路径"; session_ref HMAC) -->

## Does the MCP server let my agent edit the city?

No. No current tool edits Agent City or its map. Letting agents help build the city is a planned idea; see the [Roadmap](/docs/integrations#roadmap--规划中).

## Related

- [Agent Vitals engine overview](/docs/vitals/overview) · [CLI](/docs/vitals/cli)
- [Integrations overview](/docs/integrations)
- [Does Oh Agent upload my sessions?](/docs/privacy-and-data)
- [Architecture overview](/docs/architecture/overview)
