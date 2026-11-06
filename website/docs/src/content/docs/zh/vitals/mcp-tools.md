---
lastUpdated: 2026-11-06
title: Oh Agent 的 Data MCP 服务：让你的 AI Agent 查询自己的用量
description: 运行 agent-vitals data-mcp serve，让 Claude Code、Codex 等 MCP 客户端通过类型化工具查询本机的用量、会话和费用数据。只走 stdio，默认只读，返回内容经过脱敏。
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
          {"@type": "ListItem", "position": 2, "name": "文档", "item": "https://ohagent.ai/docs/zh"},
          {"@type": "ListItem", "position": 3, "name": "Agent Vitals 引擎", "item": "https://ohagent.ai/docs/zh/vitals/overview"},
          {"@type": "ListItem", "position": 4, "name": "Data MCP 工具", "item": "https://ohagent.ai/docs/zh/vitals/mcp-tools"}
        ]
      }
---

Oh Agent 的数据层 Agent Vitals 带一个本地 MCP 服务。运行 `agent-vitals data-mcp serve`，在 Claude Code 或 Codex 这类 MCP 客户端里注册它，那个 Agent 就能用类型化的问题查询你的用量：数据状态、按小时用量、会话、费用拆分、数据质量问题。它只走 stdio，以只读方式打开数据库，只有用 `--allow-local-writes` 启动时才能改设置。

## 关键事实

- **命令**：`agent-vitals data-mcp serve`。握手里的 `serverInfo.name` 是 `Oh Agent MCP`。配置样例的连接键是 `oh-agent`。
- **传输**：stdio，JSON-RPC 2.0，每行一条 JSON 消息。MCP 协议版本 `2025-06-18`。
- **方法**：`initialize`、`tools/list`、`tools/call`、`ping`。没有 resources 和 prompts。
- **默认只读**：只读打开数据库，从不建库或迁移。
- **写入要加参数**：`--allow-local-writes` 打开类型化的设置和计费操作。即便如此，也没有任意 SQL、URL 抓取或通用文件写入。
- **不监听网络**：只在客户端保持 stdin 打开时运行。

<!-- source: apps/cli/src/main.rs (DataMcp / DataMcpAction::Serve { allow_local_writes }) -->
<!-- source: apps/cli/src/mcp.rs (PROTOCOL_VERSION = "2025-06-18"; SERVER_NAME = "Oh Agent MCP"; line-delimited framing; methods; stdin EOF → exit 0) -->
<!-- source: docs/AGENT_VITALS_DATA_MCP_SPEC.md §6.4; crates/agent-vitals-mcp/src/mcp/mod.rs (AuthorityHandle: 只读打开权威库，不建库、不迁移) -->

## 有哪些工具？

| 工具 | 回答什么问题 |
| --- | --- |
| `data_status` | 数据是不是最新的？各数据源的覆盖情况、上次同步时间 |
| `usage_hourly` | 按小时和数据源的 Token 用量 |
| `sessions_search` / `session_detail` / `session_trace` | 查找会话，查看脱敏后的会话摘要或轨迹 |
| `cost_breakdown` | 按价格版本、币种和计费依据拆分的估算费用，未解析的用量单独列出 |
| `budget_profiles` | 预算设置和状态 |
| `price_cards` | 缺价格卡的模型；加 `--allow-local-writes` 后，你的 Agent 可以添加用户自定义价格卡 |
| `data_quality_issues` | 数据质量问题，可筛选，细节已脱敏 |
| `issues_summary` / `skills_summary` | 行为发现和 skill 使用摘要 |
| `control_plane` | 数据源状态、其他目录、排除项、保留期、时区、暂停/运行同步、目录策略（写入要加参数） |
| `trust_profile_*` | 信任审计配置的 schema、列表、校验、暂存和状态 |
| `get_building` / `preview_building` / `set_building_model` / `reset_building` | 读取、校验、替换或重置一栋 Agent City 会话楼的模型（`session-kit/v1`，最多 64 个件）。写入需要 `--allow-local-writes`。城里的施工动画来自共享 `CityEntityChanged` 事件；preview 显示幽灵楼；合规 / 细节回退 / 构件脱离 / 体量漂移拒绝会闪一下地块。`data.ok` 不是设计合格——Agent 必须展示 `data.warnings`。成功或失败的写入还会向小队 IM 频道扇出信封（`docs/CITY_SQUAD_IM.md`） |
| `im_publish` | 向小队 IM 频道发布信封（仅 `chat` / `claim` / `release`）。服务端分配 `id`/`ts`。写入需要 `--allow-local-writes`。建筑 preview/set/reset 不由 Agent 再报一遍 |

另外三个工具（`query_sql_readonly`、`billing_workflow`、`authority_audit`）只有在启用内部 `mcp-internal` feature 时才会编译进去，正常构建里没有。

<!-- source: crates/agent-vitals-mcp/src/mcp/mod.rs (dispatch match; #[cfg(feature = "mcp-internal")] query_sql_readonly, billing_workflow, authority_audit) -->
<!-- note: docs/AGENT_VITALS_DATA_MCP_SPEC.md §7 lists billing_workflow as "v1.0 local control plane", but in code it is behind mcp-internal. Code wins here. -->

## 怎么接到 Claude Code 或 Codex？

让 MCP 客户端调用 `agent-vitals` 二进制，参数是 `data-mcp serve`。通用 MCP 客户端配置大致如下：

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

已安装应用把二进制作为资源打包在 `bin/agent-vitals`。在 macOS 上通常是 `/Applications/Oh Agent.app/Contents/Resources/bin/agent-vitals`（应用名里有空格，路径要加引号）。开发构建在 `target/release/agent-vitals`。

不同 MCP 客户端的注册方式不一样。可以用上面的通用 `mcpServers` JSON，或各客户端自己的配置格式（例如 Codex 常用 `~/.codex/config.toml`）。`claude mcp add …` 的具体参数随 Claude Code 版本变化——以客户端当前文档为准，不要硬编码一套未核实的 flag。

<!-- source: apps/desktop/src-tauri/tauri.conf.json (bundle.resources → "bin/agent-vitals"); README.md (cargo build --release) -->
<!-- source: docs/v1.0.0/UAT_SMALL_LOOPS.md (manual check: printf … | agent-vitals data-mcp serve) -->

## MCP 服务绝不返回什么？

- 原始错误文本和工具调用参数，在问题摘要里已脱敏。
- 原生会话 ID。会话用带密钥的单向引用表示。
- 绝对文件路径，`control_plane` 读取时从不返回。
- 凭据和保密的探测任务。

要注意：服务返回的内容会进入你的 Agent 的上下文，那个 Agent 可能把它发给模型服务商。接上 MCP 和在应用里本地查看数据不是一回事。

仓库把这里当作数据出口边界。`crates/agent-vitals-mcp` 是对外出口，脱敏规则在这里审查；stdio 传输层单独放在 `apps/cli/src/mcp.rs`。脱敏发生在对外提供数据时，而不是在导入时丢弃数据。

<!-- source: CLAUDE.md (crates/agent-vitals-mcp: "L6 Data MCP 工具应用层——出口面，脱敏红线在这里审（传输层在 apps/cli/src/mcp.rs）"; "出口收口（脱敏是呈现期投影）"); AGENTS.md policy items 2–3 -->
<!-- source: docs/AGENT_VITALS_DATA_MCP_SPEC.md (control_plane 不返回绝对路径; session_ref HMAC) -->

## MCP 服务能让我的 Agent 编辑城市吗？

可以部分编辑，而且一次只动一栋会话楼。上表里的 `get_building`、`preview_building`、`set_building_model`、`reset_building` 可以读取、校验、替换或重置一栋 Agent City 会话楼的模型（`session-kit/v1`）。写入需要 `--allow-local-writes`。preview/set/reset 不是整座城或地图编辑——没有工具能改整座城的布局。

## 相关

- [Agent Vitals 引擎总览](/docs/zh/vitals/overview) · [命令行](/docs/zh/vitals/cli)
- [Oh Agent 会上传我的会话吗？](/docs/zh/privacy-and-data)
