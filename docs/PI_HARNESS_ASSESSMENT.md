# Pi 执行环境接入评估（v0.10 三层参与度）

> 日期：2026-09-08
> 语料：**本机实测**，`~/.pi/agent/sessions/--Users-Admin-projects--/2026-09-08T04-06-45-719Z_01a07f32-….jsonl`
> —— **1 个会话 / 93 行 / 421 KB**，Pi 版本 `settings.json:lastChangelogVersion = 0.85.1`，
> 会话头 `{"type":"session","version":3}`。
> 判定框架：v0.10 spec §2.5（三层参与度）。

## 0. 结论

**Pi 在本样本上满足 T3（事实级）的全部字段要求，是五个执行环境里证据面最完整的一个。**
它有两样**现有三执行环境都没有**的东西：

1. **per-message 的 provider 自报成本**（`message.usage.cost.{input,output,cacheRead,cacheWrite,total}`）
   —— 这是 `ATTRIBUTABLE_WASTE` §3 `pricing_basis` 词表里最强的一档 **`provider-reported`**。
   claude-code / codex / dsh 三家都只能靠我们的价卡算 `catalog-provider`。
2. **自带带版本戳的价卡目录**（`~/.pi/agent/models-store.json`，含 `checkedAt` /
   `lastModified` / `etag`）—— 正是 spec §2.3 `pricing_snapshot_id` 想要的东西，执行环境
   自己就提供了快照语义。

> **诚实性声明**：以上基于 **1 个会话**。按本仓库既有纪律（WorkBuddy 的 `traces/` 曾整轮
> 被漏掉，据此立规矩「adapter 报 unavailable 必须枚举它试过哪些 store」），**下文任何
> 「未观察到」都不等于 `unavailable`**，一律标记为 provisional，需扩语料后复核。

---

## 1. 存储与形状

```
~/.pi/agent/
  sessions/<encoded-cwd>/<ISO8601>_<uuid>.jsonl   # 会话，JSONL
  skills/<name>/SKILL.md                          # 技能（4 个：codex/find-skills/plan-execute/plan-review）
  models-store.json                               # 价卡 + 模型能力目录（带 etag/checkedAt）
  settings.json                                   # defaultProvider/defaultModel/compaction.enabled
  trust.json                                      # 工作区信任表
  auth.json                                       # 凭证——**审计面永不读取**
```

`<encoded-cwd>` 编码与 Claude Code 的 `~/.claude/projects/<encoded-cwd>/` 同形状
（`/` → `-`），文件名 = `<ISO 时间戳>_<uuid>`。

### 1.1 事件词表（本样本 93 行）

| type | 条数 | 键 |
|---|---|---|
| `message` | 72 | `id` `parentId` `timestamp` `message` |
| `thinking_level_change` | 13 | + `thinkingLevel` |
| `model_change` | 5 | + `provider` `modelId` |
| `session` | 1 | + `version` `cwd`（**根，无 parentId**） |
| `compaction` | 1 | + `summary` `details` `fromHook` `firstKeptEntryId` `tokensBefore` `usage` |
| `branch_summary` | 1 | + `summary` `details` `fromHook` `fromId` |

`message.role` ∈ {`user` 7, `assistant` 27, `toolResult` 38}；
`content[].type` ∈ {`text` 51, `toolCall` 38, `thinking` 15}；
工具名：`read` 17 / `bash` 16 / `write` 3 / `edit` 2。

### 1.2 实测用量（单会话合计）

| 桶 | token |
|---|---|
| input | 228,677 |
| output | 16,579 |
| cacheRead | 871,424 |
| cacheWrite | 0 |
| reasoning | 990 |
| **totalTokens** | **1,116,680** |

**provider 自报成本合计 `$0.829351`**（27 条 assistant 消息各带一份）。

一次会话里出现 **4 个模型**：`gpt-5.5`(12) / `gpt-5.6-luna`(10) / `gpt-5.6-terra`(4) /
`gpt-5.4`(1)，且有 5 条显式 `model_change` 事件。

> **观察，不是结论**：cacheRead 占 `input+cacheRead` 的 **79.2%**，而 cacheWrite 恒为 0。
> 价卡里 `cost.cacheWrite = 0`（该 provider 不对 cache 写计费），所以 0 可能是「不计费/
> 不上报」而非「没发生」。按 `ATTRIBUTABLE_WASTE` §8 铁律 3，这里只登记观察，
> **不得写成「缓存有问题」或「缓存很好」**。W1 的 eligibility 需按模型族分别计算并排除
> 模型切换边界——本会话 4 次模型切换，正是 W1 必须排除的场景。

---

## 2. 信号矩阵（对齐 `RUNTIME_EVIDENCE_CONTRACT` §13）

| Signal | Pi | 依据 |
|---|---|---|
| ToolCalls | **measured** | `content[].type=="toolCall"` 带 `id` / `name` / `arguments` |
| ToolResults | **measured（一等布尔）** | `role:"toolResult"` 带 `toolCallId` / `toolName` / **`isError`** / `errorMessage` / `details` |
| Usage (per request) | **measured，5 桶** | `message.usage.{input,output,cacheRead,cacheWrite,reasoning}` + `totalTokens` |
| **Cost (per request)** | **measured — provider-reported** | `message.usage.cost.{input,output,cacheRead,cacheWrite,total}` ← **独有** |
| ContextWindow | **measured** | `models-store.json` 每模型 `contextWindow` / `maxTokens` ← claude-code 此格为 unavailable |
| Compaction | **measured + 体积** | `tokensBefore` / `firstKeptEntryId` / `usage` / `summary` ← 优于 claude-code 的 lossy |
| TurnBoundaries | **derived** | 无独立事件；由 `parentId` 树 + role 转换推导 |
| ApprovalPolicy | **partial** | `trust.json` 工作区信任表（安装面，非逐会话） |
| Model switching | **measured** | `model_change` 事件带 `provider` + `modelId` |
| 线性化信号 | **measured** | `branch_summary.fromId`（分支）+ `compaction.firstKeptEntryId` |
| Format version | **measured** | `session.version = 3` ← **Codex 没有**（§14.4 schema-drift sentinel 的痛点） |
| Workspace root | **measured** | `session.cwd` |
| StepBoundaries | 未观察 ※ | — |
| SubagentSpawns | 未观察 ※ | 单会话样本，不能据此判 unavailable |
| SkillInvocations | 未观察 ※ | `~/.pi/agent/skills` 有 4 个 skill，调用是否入日志待验 |
| QuotaConsumption | 未观察 ※ | — |
| SandboxModes / NetworkAccess | 未观察 ※ | — |

`※` = **1 个会话的样本里没出现，不等于执行环境没有**。转 `unavailable` 之前必须：
扩语料 + 枚举试过哪些 store（`~/.pi/agent/` 下 7 个入口已枚举如上）。

---

## 3. 三层参与度判定

| 层 | Pi | 说明 |
|---|---|---|
| **T1 账单级** | ✅ 可用且**更强** | 不必用 `harness_bills` 手工录入——per-message `cost` 就是实付，`billing_basis='metered_actual'` |
| **T2 证据级** | ✅ 可用 | `id`/`parentId` 树 + `isError` 布尔 + 工具名，`CanonicalSession` 可完整构造 |
| **T3 事实级** | ✅ **可用**（本样本上无阻塞） | 5 桶 usage 齐全，`UsageFact` emitter 的每个必填字段都有源 |

### 3.1 SV 规则可跑性预估

| 规则族 | 预估 | 依据 |
|---|---|---|
| SV601/602/603（危险命令） | **可跑** | `bash` 工具 16 次，`arguments` 带命令原文 |
| SV604/605/606（写/编辑/网络） | **可跑** | `write` / `edit` 是一等工具名（WorkBuddy 在这格是降级的） |
| SV607/608（错误码） | **可跑，且比 claude-code 强** | `isError` 是布尔 + `errorMessage`；claude-code 要靠字符串标记匹配（lossy） |
| SV611（重复工具调用） | **可跑** | `(toolName, arguments)` 签名齐全 |
| SV612/613（turn/结果） | **可跑（derived turn）** | turn 由树推导，需按 §2.1.1 的 `(scope, ordinal)` 定序 |
| SV609 / SV610 / SV614（审批/沙箱） | **待验** ※ | 本样本未观察到审批或沙箱事件 |
| SV-COST-01/02（浪费族） | **需先跨执行环境化** | 目前实现只在 `harnesses/dsh/sessions/waste.rs`（spec §2.4.5） |

---

## 4. Pi 会反过来暴露 v0.10 spec 的两个缺口

### 4.1 `pricing_basis = provider-reported` 这条路径 spec 没有走通

spec §2.4.1 的 `pricing_basis` 词表里有 `provider-reported`，但 v0.10 的成本管线
（§2.2 「cost 相关 metric 必须从 `domain::cost` 派生」）默认所有金额都由**我们的价卡**
算出来。Pi 是第一个**自报实付金额**的执行环境，于是产生一个 spec 未回答的问题：

> 当执行环境自报成本与我们价卡算出的成本不一致时，哪个是权威？

**建议**（需 PM 确认）：执行环境自报为权威（`provider-reported` 本就排在词表最前），我们的
价卡算出的值降为**对账用的第二数**，差额进 `data_quality_issues` 而不是静默取其一。
这与 v0.9「权威在 JSONL、索引是可丢弃投影」的分层同构。

### 4.2 一次会话 4 个模型，把「模型归属」从边缘情况变成常态

spec §2.4.1 的 W1 明确要求「按模型族分别计算、排除模型切换边界」。现有三执行环境里模型切换
相对少见；Pi 单会话 4 模型 + 5 次显式 `model_change`，**使它成为默认形态**。好消息是
`model_change` 是一等事件，切换边界**不用猜**——但 v0.10 的 TraceGraph 需要把它建成节点
（`node_type` 应增 `model_change`，现有枚举里没有）。

---

## 5. 接入清单（按 spec §2.5.5）

| 步骤 | 内容 | 备注 |
|---|---|---|
| 0 | **扩语料**——当前只有 1 个会话 93 行 | 转正前必须做；`※` 项全靠它 |
| 1 | `harnesses/pi/sources/skills.rs`：扫 `~/.pi/agent/skills/*/SKILL.md` | 本仓库本职，最先见效 |
| 2 | `harnesses/pi/sessions/evidence.rs`：JSONL → `CanonicalSession` | 树用 `id`/`parentId`；`native` = `id` |
| 3 | `HARNESSES` 加 `HarnessProfile{ id:"pi", session_store:true, fold:Some(TokenBuckets) }` | `unmeasured_signals` **如实填**，`※` 项先不填 measured |
| 4 | `harnesses/pi/sources/usage_fact.rs` + Python 同构 | byte-parity 差分门 |
| 5 | `FACT_HARNESSES` 扩容 `"pi"` | 封闭词表显式扩容 |
| 6 | 价卡：**优先用 `message.usage.cost`**，`models-store.json` 作 fallback | 见 §4.1 |
| 7 | `tests/test_pi_usage_fact.py` 差分测试 | — |

**先决判断（spec §2.5.5）通过**：Pi 暴露 per-request token **且**自报成本，T3 不是硬凑。

> **安全边界**：`~/.pi/agent/auth.json` 是凭证文件，审计面**永不读取**。这与 v0.8
> Phase F1b「读凭证文件」被暂停待评审的决定一致。
