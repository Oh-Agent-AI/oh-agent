# Cline 执行环境接入评估（v0.10 三层参与度）

> 日期：2026-09-08
> 语料：**本机实测**，`~/.cline/data/`（13 文件）+ VS Code 扩展
> `hybridtalentcomputing.cline-chinese`（仅 4 个模型目录缓存）。
> **语料规模：1 个会话 / 6 条消息**（`1785404902274_cqsc8`，2026-07-30）。
> 判定框架：v0.10 spec §2.5。

## 0. 结论

**T1 / T2 / T3 全部可行**，而且 Cline 在两个维度上是**五个目标执行环境里最强的**：

1. **子代理模型最干净**——`parent_session_id` / `parent_agent_id` / `agent_id` /
   `conversation_id` / `is_subagent` 五个字段 + 独立的 `subagent_spawn_queue` 表 +
   会话级 `aggregatedAgentsCost`（子代理成本已汇总）。对照 DSH 的 `parentSession`
   实测 **5/19 可靠**、Codex 的 `agent_thread_id` 只数覆盖率未提取，Cline 是唯一
   把父子关系当一等公民建模的。
2. **per-message 成本自报**——`metrics.cost`，与 Pi 同属 `pricing_basis =
   provider-reported`（最强档）。

但**语料只有 1 个会话 6 条消息**，下文一切「未观察到」均为 provisional，
**不得写成 `unavailable`**。

---

## 1. 存储面（已枚举）

| 入口 | 内容 |
|---|---|
| `~/.cline/data/sessions/<id>/<id>.json` | 会话元 + 聚合用量/成本 |
| `~/.cline/data/sessions/<id>/<id>.messages.json` | 逐消息（含 per-message metrics） |
| `~/.cline/data/db/sessions.db` (45 KB) | `sessions` / `subagent_spawn_queue` / `schedules` / `schedule_executions` |
| `~/.cline/data/settings/providers.json` · `global-settings.json` · `cline_mcp_settings.json` | provider / MCP 配置 |
| `~/.cline/data/globalState.json` | 全局状态 |
| `~/.cline/data/workspaces/<hash>/workspaceState.json` | 工作区状态 |
| `~/.cline/data/workspaces/chat/AGENTS.md` | 项目指令 |
| **`~/.cline/data/secrets.json`** | **凭证——审计面永不读取** |
| VS Code `globalStorage/hybridtalentcomputing.cline-chinese/cache/` | `openrouter_models.json` (157 KB) · `shengSuanYun_models.json` (101 KB) · `vercel_ai_gateway_models.json` (136 KB) · `hicap_models.json` |

> 注意：本机装的是**中文分支** `hybridtalentcomputing.cline-chinese`，不是上游的
> `saoudrizwan.claude-dev`；后者的 `tasks/<ts>/` 结构在本机**不存在**。接适配器时
> 两种扩展 id 都要枚举。

## 2. 会话形状（实测）

### 2.1 会话元

```jsonc
{
  "version": 1, "session_id": "…", "source": "vscode", "pid": 4203,
  "started_at": "2026-07-30T09:48:22.280Z", "exit_code": null,
  "status": "idle", "interactive": true,
  "provider": "shengsuanyun", "model": "anthropic/claude-sonnet-5",
  "cwd": "/Users/Admin/Desktop", "workspace_root": "/Users/Admin/Desktop",
  "enable_tools": true, "enable_spawn": false, "enable_teams": false,
  "metadata": {
    "totalCost": 0.01191, "aggregatedAgentsCost": 0.01191,
    "usage": { "inputTokens": 4763, "outputTokens": 79,
               "cacheReadTokens": 0, "cacheWriteTokens": 4761,
               "totalCost": 0.01191 },
    "aggregateUsage": { … }
  },
  "messages_path": "…"
}
```

`cwd` **与** `workspace_root` 都在（Hermes 的 `git_repo_root` 是 0/15，对比明显）。

### 2.2 逐消息

键：`id` / `role` / `content[]` / `ts` / `modelInfo{id, provider, family}` /
`metrics{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, **cost**}`。

**4 桶**（无 reasoning 桶）。

### 2.3 `sessions.db`

- **`sessions`**：含 `parent_session_id` / `parent_agent_id` / `agent_id` /
  `conversation_id` / `is_subagent` / `team_name` / `enable_teams`；另有
  `pid` / `status` / `status_lock` / `exit_code` —— **进程存活性**（此前只有 WorkBuddy
  有 partial）；`transcript_path` / `metadata_json`。
- **`subagent_spawn_queue`**：`root_session_id` / `parent_agent_id` / `task` /
  `system_prompt` / `created_at` / `consumed_at`。
- **`schedules`** + **`schedule_executions`**：cron 驱动的自主运行，执行行带
  `exit_code` / `iterations` / **`tokens_used`** / **`cost_usd`** / `error_message`。
  **这是一类其他执行环境都没有的会话来源**——无人值守的定时任务。

行数：`sessions` = 1，其余表均 0。

---

## 3. 实测数据陷阱：同一条记录里三处模型 id / 两处 token 互相矛盾

同一个会话记录内：

| 字段 | 值 |
|---|---|
| 顶层 `model` | `anthropic/claude-sonnet-5` |
| 逐消息 `modelInfo.id` | `anthropic/claude-sonnet-5` |
| **`metadata.modelId`** | **`anthropic/claude-sonnet-4.6`** ← 不一致 |

| 字段 | 值 |
|---|---|
| `metadata.usage.inputTokens` | 4,763 |
| **`metadata.tokensIn`** | **2** ← 不一致 |
| `metadata.cacheWrites` | 4,761（与 `usage.cacheWriteTokens` 一致 ✓） |

`metadata` 块里携带了**过时/遗留的重复字段**，与权威的 `usage` / `modelInfo` 冲突。
一个读 `metadata.modelId` 或 `metadata.tokensIn` 的适配器会**静默算错模型归属和用量**
——正是 CLAUDE.md「形状来源纪律」要防的：**先读产生方的权威字段，用 fixture 钉死**。

**接入规则（写死）**：权威取 `modelInfo`（逐消息）与 `metadata.usage`（会话聚合）；
`metadata.{modelId, tokensIn, tokensOut, cacheWrites, cacheReads}` 一律**不读**，
并加一条 fixture 测试钉住这个选择。

---

## 4. 三层参与度判定

| 层 | Cline | 说明 |
|---|---|---|
| **T1 账单级** | ✅ | 会话级 `totalCost` + `aggregatedAgentsCost` 直接可用 |
| **T2 证据级** | ✅ | JSON transcript + SQLite；`workspace_root` 齐全，SV605 不必降级 |
| **T3 事实级** | ✅ | 4 桶 + per-message `cost`；`provider` + `modelInfo` 齐全 |

### 4.1 计价归属：模型 id 带 provider 前缀

`model = "anthropic/claude-sonnet-5"`、`provider = "shengsuanyun"` —— **模型名里的
`anthropic/` 是模型族，`provider` 才是收费方**（本例是胜算云中转）。这正是
`ATTRIBUTABLE_WASTE` §8 铁律 8「**Harness ≠ BillingSource**，执行入口不决定收费方」的
教科书案例：按 `anthropic/` 前缀归到 Anthropic 计价就是编造。

归属必须走 `provider` 字段，且 `pricing.json` 的 `billing_modes` 里目前**没有
`shengsuanyun`** —— 接入前需补一条 billing route，否则落 `billing-route-unknown`。

### 4.2 SV 规则可跑性

语料仅 1 会话 6 消息（全是 `text` 块，无 `toolCall`），**工具面完全未观察到**，
无法预估 SV601–614。已知的正面信号：`enable_tools` / `enable_spawn` / `enable_teams`
三个开关存在，说明工具与子代理是一等能力。**扩语料是前置。**

---

## 5. opencode：本机未安装，无法一手评估

已枚举检查（全部不存在）：

```
~/.opencode
~/.local/share/opencode
~/.config/opencode
~/Library/Application Support/opencode
```

VS Code `globalStorage` 里也无 opencode 相关扩展。

按仓库纪律，**不写二手形状**：这里只记录「本机无实例、已枚举试过的路径」，
与 `RUNTIME_EVIDENCE_CONTRACT` §13 当初对 Hermes / OpenClaw 的处置一致。
需要评估请先在本机跑一次 opencode 产生语料，或提供一份 corpus。

---

## 6. 接入清单

| 步骤 | 内容 | 备注 |
|---|---|---|
| 0 | **扩语料**——当前 1 会话 6 消息、零工具调用 | SV 规则可跑性完全未验 |
| 1 | 补 `pricing.json` 的 `shengsuanyun` billing route | 否则 `billing-route-unknown`（§4.1） |
| 2 | `harnesses/cline/sessions/evidence.rs`：读 `<id>.json` + `.messages.json` | **权威字段选择见 §3，必须带 fixture** |
| 3 | 子代理：读 `sessions.db` 的 `is_subagent` / `parent_*` / `subagent_spawn_queue` | Cline 是最干净的父子模型，可作为 TraceGraph subagent 边的**参考实现** |
| 4 | `HarnessProfile{ id:"cline", session_store:true, fold:Some(TokenBuckets) }` | 无 reasoning 桶，如实声明 |
| 5 | `harnesses/cline/sources/usage_fact.rs` + Python 同构 → `FACT_HARNESSES` 扩容 | 4 桶 |
| 6 | 扩展 id 枚举两种（上游 `saoudrizwan.claude-dev` + 中文分支） | 本机只有后者 |

> **待扩查**（未展开，不得据此报 unavailable）：`globalState.json` ·
> `workspaces/*/workspaceState.json` · `cline_mcp_settings.json`（MCP 服务器清单，
> 可能是 skill/工具面的来源）· 三个模型目录缓存（`openrouter_models.json` 157 KB 等，
> 与 Hermes 的 `models_dev_cache.json` 同类，属 `catalog-fallback` 价卡候选）。
