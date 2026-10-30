---
lastUpdated: 2026-10-30
title: agent-vitals 命令行有哪些命令？
description: Agent Vitals 引擎的 agent-vitals 命令行：同步、数据状态、导出、manifest 数据源、会话审计，以及 Data MCP 服务。
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
          {"@type": "ListItem", "position": 4, "name": "命令行", "item": "https://ohagent.ai/docs/zh/vitals/cli"}
        ]
      }
---

`agent-vitals` 是 Agent Vitals 引擎的命令行入口，和桌面应用跑的是同一套 Rust 代码。它可以把 Agent 日志同步进本地数据库、查看数据状态、导出事实、管理 manifest 数据源、审计单个会话，以及启动 Data MCP 服务（stdio）。早期 skill 体检工具的命令也保留着。帮助文字是英文的，大多数命令支持 `--json`。

## 关键事实

- **源码**：`apps/cli/`（子命令在 `apps/cli/src/main.rs`，用 clap 实现）。
- **构建**：`cargo build --release`，产物是 `./target/release/agent-vitals`。完整列表见 `agent-vitals --help`。
- **随应用打包**：桌面应用里带着这个二进制，位置是 `bin/agent-vitals`。
- **数据目录和应用相同**：`~/.agent-vitals/` 或 `AGENT_VITALS_HOME`。

<!-- source: apps/cli/src/main.rs (#[derive(Subcommand)] enum, lines ~144–918); README.md (Development quick start); apps/desktop/src-tauri/tauri.conf.json (bundle.resources) -->

## 数据命令（引擎）

| 命令 | 作用 |
| --- | --- |
| `sync-facts` | 常规同步：找日志、比对、解析、写入 SQL 库。可以重复运行 |
| `data-status` | 数据库状态：表结构版本、最近的同步、各数据源数量、数据质量摘要 |
| `data …` | 只读汇总（比如 `data coverage`、`data daily`） |
| `data-export-private --out DIR` | 按存储原样导出事实（含身份字段），每个数据源一个 `<harness>.jsonl` |
| `data-export-redacted --out DIR` | 同样的导出，但身份字段替换成稳定的假名 |
| `data-unresolved` | 按模型查看某个月未定价或未解析的用量 |
| `billing-groups`、`data-harness-bill` | 计费确认分组；用户录入的数据源账单 |
| `budget`、`budget-sql` | 预算提醒的状态和管理 |
| `data-migrate` | 把旧版事实 JSONL 一次性导入 SQL 库 |
| `data-reimport-verify` | 重新导入到两个临时数据库并比较（不碰你的数据库） |
| `sessions …` | 带版本的只读会话查询 |
| `routes-quality` | 按数据源和模型系列被动报告记录到的模型身份 |
| `data-mcp serve [--allow-local-writes]` | 启动 stdio Data MCP 服务 |

<!-- source: apps/cli/src/main.rs doc comments: SyncFacts, DataStatus, Data, DataExportPrivate/DataExportRedacted, DataUnresolved, BillingGroups, DataHarnessBill, Budget, BudgetSql, DataMigrate, DataReimportVerify, Sessions, RoutesQuality, DataMcp -->

`sync-facts` 的 clap 帮助文字仍写着 “across all three harnesses”；实际默认会同步全部已注册的内置数据源（`claude-code`、`codex`、`dsh`、`workbuddy`），除非你传入 `--harnesses`。

<!-- source: apps/cli/src/main.rs SyncFacts doc + --harnesses; session_harnesses.rs (4 ids) -->

## 数据源命令

| 命令 | 作用 |
| --- | --- |
| `harness-inventory --window-days 30` | 哪些数据源已登记、有数据，或只是候选。不会启用任何东西 |
| `harnesses` | 打印四个内置数据源声明的能力 |
| `manifest-validate`、`manifest-install`、`manifest-list`、`manifest-uninstall`、`manifest-rollback`、`manifest-recompute`、`manifest-catalog-status` | manifest 数据源：试运行、预览 → 确认、列出、移除、回滚 |
| `claude-usage-facts`、`codex-usage-facts`、`dsh-usage-facts`、`workbuddy-usage-facts` | 把某个数据源的文件解析成用量事实行，用于排查 |

<!-- source: main.rs (HarnessInventory, Harnesses, Manifest*, ClaudeUsageFacts, CodexUsageFacts, DshUsageFacts, WorkbuddyUsageFacts) -->

## 会话审计和轨迹命令

| 命令 | 作用 |
| --- | --- |
| `claude-session`、`codex-session`、`workbuddy-session`、`codex-evidence` | 把一个会话审计成标准化会话，带覆盖情况和 SV601–SV614 行为发现 |
| `behavior`、`skill-audit`、`duration-audit` | 审计一份 DSH 会话日志里的风险行为、skill 使用或耗时 |
| `trace-ref` | 根据 `sessions list` 为某个会话生成轨迹图，不暴露文件路径 |
| `trace`、`trace-anchors` | 单个文件的轨迹图；锚点报告只用于本地查看（永远不是 MCP 工具） |
| `codex-cost` | 按模型和日期给 Codex 的 Token 用量计价 |
| `probe`、`trust …` | 桌面“测试”页的探测；本地信任 / 外发历史审计 |

<!-- source: main.rs (ClaudeSession, CodexSession, WorkbuddySession, CodexEvidence, Behavior, SkillAudit, DurationAudit, TraceRef, Trace, TraceAnchors, CodexCost, Probe, Trust) -->

## 旧的 skill 体检命令

`list`、`doctor`、`plan`、`snapshot`、`diff`、`explain` 和 `overlap` 来自早期的 skill 体检工具：列出已安装的 Agent Skills、诊断某个 skill 为什么没加载、规划清理。它们还在，但不是产品主线（早期的 skill 体检工具）。

<!-- source: main.rs (List, Doctor, Plan, Snapshot, Diff, Explain, Overlap); README.md -->

## 示例

```sh
# 立即导入新会话，不等应用的 5 分钟同步
agent-vitals sync-facts

# 数据是不是最新的？
agent-vitals data-status --json

# 备份你的事实数据（假名化）
agent-vitals data-export-redacted --out ~/oh-agent-export
```

上面的参数与 `apps/cli/src/main.rs` 里的 clap 定义一致：`data-status --json` 是布尔开关；`data-export-redacted` 需要 `--out DIR`；`sync-facts` 也支持可选的 `--json` 和 `--harnesses`。

<!-- source: apps/cli/src/main.rs DataStatus / DataExportRedacted / SyncFacts -->

## 相关

- [Agent Vitals 引擎总览](/docs/zh/vitals/overview)
- [Claude Code 数据来源](/docs/zh/data-sources/claude-code) · [Codex 数据来源](/docs/zh/data-sources/codex)
- [DeepSeek Harness 数据来源](/docs/zh/data-sources/deepseek-harness) · [WorkBuddy 数据来源](/docs/zh/data-sources/workbuddy)
- [Agent City 里每栋楼代表什么](/docs/zh/city-guide)
- [数据与隐私](/docs/zh/privacy-and-data) · [安装](/docs/zh/install) · [常见问题](https://ohagent.ai/#faq)
