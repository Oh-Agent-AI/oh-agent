# Hermes 执行环境接入评估（v0.10 三层参与度）

> 日期：2026-09-08
> 语料：**本机实测第一手**，`~/.hermes/`（7.5 GB / 127,032 文件）。
> 主证据：`state.db`（11.8 MB，`schema_version = 23`），15 会话 / 2,092 消息 /
> 967 次 API 调用，跨度 2026-07-25 → 2026-09-06。
> 判定框架：v0.10 spec §2.5（三层参与度）。
>
> **这是 Hermes 的第一份一手证据**：`RUNTIME_EVIDENCE_CONTRACT` §13 的执行环境矩阵里
> Hermes 是缺席的（当时审计机器上没有实例，§14.9 只有二手线索）。本文可作为把它
> 填进 §13 的依据。

## 0. 结论

**T1 退化可用 / T2 强 / T3 可行。** 但最值得记的不是分层结论，而是两件事：

1. **Hermes 的数据模型与本仓库 v0.9 独立推导出的结论高度重合**——`(model,
   billing_provider, billing_base_url, billing_mode)` 的归属粒度、`estimated_cost_usd`
   与 `actual_cost_usd` 分列、`cost_status` / `cost_source` 的 basis 字段、
   甚至 **`pricing_version`**（正是 `ATTRIBUTABLE_WASTE` §9 未落地第 8 条与本 spec
   §2.3 `pricing_snapshot_id` 要的东西）。两个项目各自走到同一处。
2. **但这些字段一个都没被填。** 成本列全 0，`cost_status` 是空串或 `unknown`，
   `cost_source = none`，`pricing_version` 在 15 个会话里**填充数为 0**。
   —— 与本仓库 `timeline_series`「设计了、从未落地」是同一种形态。

**Schema 富、数据缺**，是 Hermes 的一句话画像。

---

## 1. 存储面（已枚举，避免重蹈 WorkBuddy 覆辙）

按仓库纪律「adapter 报 unavailable 必须枚举它试过哪些 store」，`~/.hermes/` 下的
持久化入口全列如下：

| 入口 | 内容 | 审计价值 |
|---|---|---|
| **`state.db`** (11.8 MB) | `sessions` / `messages` / `session_model_usage` / `messages_fts(+trigram)` / `async_delegations` / `delivery_obligations` / `gateway_routing` / `compression_locks` / `schema_version` / `state_meta` | **主证据面** |
| `kanban.db` (118 KB) | 看板 | 任务跟踪，可能对应 `task` 维度 |
| `projects.db` (45 KB) | 项目 | 工作区归属 |
| `verification_evidence.db` (32 KB) | 验证证据 | 与 `finish_reason='verification_required'` 呼应 |
| `sessions/` | 仅 2 个文件（`sessions.json` + 一份 request dump） | **不是**会话主存储 |
| `skills/` (56 目录) | **92 个 `SKILL.md`**，三层嵌套 | 静态体检面，见 §4 |
| `models_dev_cache.json` (4.5 MB) | 213 provider / 7,561 模型 / **7,126 带价** | 见 §5 |
| `memories/` `notes/` `cron/` `hooks/` `gateway/` `logs/` `state/` | 记忆/笔记/定时/钩子/网关/日志 | 未展开，待扩查 |
| `.env` · `auth.json` | **凭证——审计面永不读取** | — |

> `sessions/` 目录名有误导性：Hermes 的会话**不在**那里，在 `state.db`。一个只扫
> `sessions/` 的适配器会报「2 个文件、无会话」，实际有 15 个会话 2,092 条消息。

---

## 2. 数据模型（`state.db`，schema v23）

### 2.1 `session_model_usage` —— 与 v0.9 归属决策重合的那张表

```sql
PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
-- 5 桶：input_tokens / output_tokens / cache_read_tokens / cache_write_tokens / reasoning_tokens
-- api_call_count · estimated_cost_usd · actual_cost_usd · cost_status · cost_source
-- first_seen · last_seen
```

归属粒度是 **(model, provider, base_url, billing_mode, task)** ——比本仓库 v0.9 定的
`(harness, provider)` 还细一级（多了 `base_url` 与 `task`）。`base_url` 尤其值得注意：
它把「同一个 provider 走不同中转」区分开了，正是 CLAUDE.md 里
「claude-code 执行环境内 anthropic(USD)+minimax(CNY) 同桶跨币相加就是编造」那类问题的
上游解法。

### 2.2 `sessions`

值得点名的列：`parent_session_id`（自引用 FK，子代理树）· `cwd` / `git_branch` /
`git_repo_root` · `billing_provider` / `billing_base_url` / `billing_mode` ·
`estimated_cost_usd` / `actual_cost_usd` / `cost_status` / `cost_source` /
**`pricing_version`** · `compression_failure_streak` / `compression_ineffective_count`
（**压缩有效性计数**——没有第二个执行环境有这个）· `rewind_count`（回滚次数，线性化信号）·
`handoff_state` / `handoff_platform`（跨平台交接）· `source` / `chat_id` / `chat_type` /
`thread_id` / `user_id`（**聊天平台来源**，见 §6.1）。

### 2.3 `messages`

`role` / `content` / `tool_call_id` / `tool_calls` / `tool_name` / `token_count` /
`finish_reason` / `reasoning*` / **`compacted`**（逐消息压缩标记）/ `active` /
`api_content` / `effect_disposition`（schema 有、**数据全 NULL**）。
另有 `messages_fts` + `messages_fts_trigram` 两套全文索引。

---

## 3. 实测数据

### 3.1 规模与用量

| 项 | 值 |
|---|---|
| 会话 / 消息 / 工具调用 | 15 / 2,092（active 1,704）/ 750 |
| API 调用 | 967 |
| input | 3,415,689 |
| output | 258,172 |
| **cache_read** | **68,857,374** |
| cache_write / reasoning | 0 / 0 |
| 模型 | **仅 `MiniMax-M3`** |
| billing_provider | `minimax-cn`（899 调用）· `auto`（68） |

`cache_read / (input + cache_read) = 95.3%`。**这是观察不是结论**——按
`ATTRIBUTABLE_WASTE` §8 铁律 3，「命中率高」是观察，「缓存很好」是结论，不得代写；
且 W1 的 eligibility 要求排除首请求与模型切换边界。

### 3.2 成本字段：schema 有，数据无

| 字段 | 实测 |
|---|---|
| `estimated_cost_usd` / `actual_cost_usd` | **全 0** |
| `cost_status` | 20 行空串、14 行 `unknown` |
| `cost_source` | `none` |
| `pricing_version` | **15 个会话填充数 0** |
| `billing_mode` | **全空串** |
| `parent_session_id` | **填充数 0**（无子代理树实例） |
| `cwd` / `git_repo_root` | 8/15 / **0/15** |

### 3.3 会话来源：多面，含聊天平台

`source` = **cli 8 · discord 5 · desktop 1 · tui 1**。

### 3.4 工具词表（决定 SV 规则可跑性）

`terminal` 505 · `process` 101 · `search_files` 55 · `clarify` 45 · `read_file` 38 ·
`execute_code` 38 · `browser_navigate` 25 · `write_file` 23 · `patch` 19 ·
`browser_vision` 11 · `todo` 9 · `browser_console` 9 · `skill_view` 6 ·
`memory` 5 · `browser_snapshot` 5。

`finish_reason` = `tool_calls` 820 · `stop` 161 · **`verification_required` 2**。
`compacted` = 388 / 2,092 消息（18.5%）。

---

## 4. 陷阱：嵌套技能命名空间，扁平扫描少报 87%

```
SKILL.md 深度分布：  第 1 层 12 个 ·  第 2 层 76 个 ·  第 3 层 4 个  →  合计 92
```

Hermes 的 skill 是**三层嵌套的 bundle**（`apple/apple-notes`、
`autonomous-ai-agents/claude-code`、`creative/architecture-diagram`…），另有 26 个
`manifest.json` / `DESCRIPTION.md` 作为 bundle 级清单。

**一个按「`skills/<name>/SKILL.md`」扁平假设扫描的适配器会报 12 个，实际 92 个——
少报 87%。** 本文第一轮扫描就踩了这个坑（`-maxdepth 2` 得 12），是
`RUNTIME_EVIDENCE_CONTRACT` §14.6「WorkBuddy 的 `traces/` 整轮被漏掉」的同型复现。

**对本仓库的直接后果**：现有 dedup 键是 `(namespace, name)`（plugin skill 用
`<plugin>:<name>`）。Hermes 需要**路径式身份**（`bundle/sub/subsub`），否则
`apple/apple-notes` 与另一个 bundle 下的同名 skill 会撞键。接 Hermes 前必须先定这个。

---

## 5. `models_dev_cache.json`：7,126 个带价模型

213 个 provider、7,561 个模型，其中 **7,126 个带 `cost: {input, output, cache_read}`
+ `limit: {context, output}`**（models.dev 的本地缓存镜像）。

对照本仓库 `assets/pricing.json` 的 `catalog_2026_09` 只有四族
（anthropic / minimax / moonshot / deepseek），这是一个数量级差距的价卡来源，**直接
对着 `unpriced_tokens` 这个缺口**。

**但必须按 basis 分级**：社区目录属 `ATTRIBUTABLE_WASTE` §3 的
**`catalog-fallback`**（最弱的已计价档，低于 `catalog-provider`），
**不得冒充 `provider-reported`**。且它是执行环境已缓存在本地的文件，读它不违反
「扫描时不拉第三方代码」——但**数据质量责任要标在 basis 上**。

---

## 6. Hermes 暴露的两个 spec 缺口

### 6.1 聊天平台来源的会话没有工作区（P1）

15 个会话里 discord 5 个，且 **`git_repo_root` 填充数为 0、`cwd` 只有 8/15**。
v0.10 的会话模型（`session_key`、workspace root、TraceGraph 的 `scope`）默认会话
发生在一个终端/工作区里。Discord 会话的身份维度是
`(user_id, chat_id, chat_type, thread_id)`，与 cwd 正交。

**后果**：SV605 在无 workspace root 时按 CLAUDE.md 已有的降级路径退到绝对路径启发式
——这条**已经存在**，但 spec §2.5.3 的能力表没有「无工作区执行环境」这一行。
建议补：`Workspace root` 缺失 → 依赖它的规则显式降级，**不得用 `cwd` 猜 repo root**。

### 6.2 `estimated` vs `actual` 双列是 spec 该有而没有的形状（P2）

Hermes 的 `sessions` 与 `session_model_usage` **都**同时有 `estimated_cost_usd` 和
`actual_cost_usd`，外加 `cost_status` / `cost_source` 说明这两个数从哪来。这正是
本 spec §2.2.1 想表达的「名义 / 实付分栏永不相加」，但 v0.10 的
`outcome_measurements` 只有单列 `savings_value_minor` + `savings_basis` 标签。

Hermes 的形状更直白：**两个数各占一列，basis 字段解释各自来源**。建议在 §10.2.5
评估是否比「单列 + basis 标签」更不易误用——单列靠标签区分，正是 §10.7 第 1 条
担心的 `SUM` 误聚合的温床。

---

## 7. 三层参与度判定

| 层 | Hermes | 说明 |
|---|---|---|
| **T1 账单级** | ⚠️ **退化可用** | 自身成本列全 0，读不到账单。需按 `harness_bills` 手工录入 MiniMax 订阅（`billing_basis='fixed_subscription'`，`pricing.json` 已记 ¥114/月） |
| **T2 证据级** | ✅ **强** | `messages` 有 `tool_name` / `tool_calls` / `finish_reason` / `compacted`；SV601–606、611 可跑 |
| **T3 事实级** | ✅ **可行** | 5 桶 token 填得很满，model + provider 齐全；**`assets/pricing.json` 已认识 `MiniMax-M3`（含 ≤512K / >512K 分档价）**，无需新增价卡 |

### 7.1 计价归属

`pricing.json` 的 `billing_modes/minimax = {mode: "subscription"}`，
`subscriptions/minimax-sub = ¥114/月`。所以 Hermes 的用量属**订阅摊销**，
按本 spec §2.2.1 硬规则 2，其 savings **落在 token 与配额余量上，不落在钱上**。

**粗估名义成本**（`catalog-provider` 档，仅供订阅利用率参考，**不是账单**）：
uncached input 3.42 M × ¥2.1/M ≈ ¥7.2；cache_read 68.86 M × ¥0.42/M ≈ ¥28.9；
output 0.26 M × ¥8.4/M ≈ ¥2.2 → **合计 ≈ ¥38**（跨 6 周）。对 ¥114/月的订阅，
**利用率显著低于 1×**——与 CLAUDE.md 记的 anthropic 380× 是两个极端。
按 §6.7，`>50×` 是「归属待核」告警；**低利用率不是告警，是用户自己的决策信息**。

### 7.2 SV 规则可跑性预估

| 规则族 | 预估 | 依据 |
|---|---|---|
| SV601/602/603 | **可跑** | `terminal` 505 + `execute_code` 38，`tool_calls` 带参数 |
| SV604/605 | **可跑（605 需降级）** | `write_file` / `patch`；但 `git_repo_root` 全空 → SV605 走绝对路径启发式 |
| SV606 | **可跑，且更强** | `browser_navigate` / `browser_console` / `browser_snapshot` / `browser_vision` 是一等工具 |
| SV607/608 | **待验** | `role='tool'` 有 907 行但错误面未验；`finish_reason` 无 error 档 |
| SV611 | **可跑** | `(tool_name, tool_calls)` 签名齐全 |
| SV612/613 | **derived** | 无独立 turn 事件，需从 role 转换推导 |
| SV609/610/614 | **待验** | 未见审批/沙箱事件；但有 `finish_reason='verification_required'`（2 次）与 `sandboxes/` 目录，值得挖 |
| SV-COST-01/02 | 需先跨执行环境化 | 同 spec §2.4.5 |

---

## 8. 接入清单

| 步骤 | 内容 | 备注 |
|---|---|---|
| 0 | **先定嵌套 skill 的身份键**（§4） | 不定就会撞键少报 |
| 1 | `harnesses/hermes/sources/skills.rs`：**递归**扫 `skills/**/SKILL.md` + `manifest.json` / `DESCRIPTION.md` | 本仓库本职；**禁止 maxdepth 假设** |
| 2 | `harnesses/hermes/sessions/evidence.rs`：读 `state.db` 的 `sessions` + `messages` | rusqlite 已是 harnesses 的 `sources` feature 依赖 |
| 3 | `HARNESSES` 加 `HarnessProfile{ id:"hermes", session_store:true, fold:Some(TokenBuckets) }` | `unmeasured_signals` 如实填；`※` 项先不填 measured |
| 4 | `harnesses/hermes/sources/usage_fact.rs` + Python 同构 | 5 桶直接来自 `session_model_usage` |
| 5 | `FACT_HARNESSES` 扩容 `"hermes"` | 封闭词表显式扩容 |
| 6 | 计价：用**我们的** `pricing.json`（`catalog-provider`），Hermes 自身成本列为 0 → `cost_source=none` 如实记录 | 见 §7.1 |
| 7 | 手工录 MiniMax 订阅进 `harness_bills` | `fixed_subscription` |

> **待扩查**（本次未展开，不得据此报 unavailable）：`memories/` · `notes/` ·
> `cron/` · `hooks/` · `gateway/` · `logs/`（19 项）· `sandboxes/` ·
> `verification_evidence.db` · `kanban.db` · `projects.db`。
> 审批/沙箱信号很可能藏在 `sandboxes/` 与 `verification_evidence.db` 里。
