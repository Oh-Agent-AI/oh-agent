# `_ms` 契约字段全量体检 · 2026-09-13

> 触发：`TraceNode.started_at_ms` 被发现是执行环境决定单位（claude-code 秒 / codex 毫秒），
> 而那已是**同一根因第二次**出现（首次是 `issue_instances.opened_at_ms`）。
> 本体检要在**第三颗雷**出现前，把全仓纪元类 `_ms` 字段扫一遍。
>
> 结论：**没有发现新的单位漂移。** 已确认的只有 trace 一处，已修。
> 但另有一条**声明了却从未落地**的契约字段值得处置（§4）。

---

## 1. 方法

三层各扫一遍，**每层都要求覆盖到真实数据**（避免"扫了个寂寞"式的假绿）：

| 层 | 手段 | 覆盖 |
|---|---|---|
| **SQL 权威库** | `PRAGMA table_info` 枚举所有 `_ms` 列 → 逐列 `MIN/MAX` + 统计 `< 1e11` 的行数 | 真机副本，30+ 列 / 165K+ 行 |
| **CLI DTO** | 跑 `sessions list` / `data coverage` / `data daily` / `data-status` / `trace-ref`，递归扫所有 `_ms` 键 | 113 个值 |
| **MCP DTO** | stdio JSON-RPC 同时调 9 个工具，递归扫所有 `_ms` 键 | 6 个不同键 / 9,721 次出现 |

判据：纪元类 `_ms` 值若 `< 1e11` 即判「疑似秒级」。
**时长类**（`duration`/`elapsed`/`latency`/`window_minutes`/`timeout`）排除——
`duration_ms = 12` 是对的，不是漂移。

---

## 2. 结果

### 2.1 SQL 层 —— 干净

所有纪元类 `_ms` 列的值都在 **1.785e12 ~ 1.789e12** 量级（毫秒），
**零个** `< 1e11` 的可疑值。包含先前出过事的两列：

```
issue_instances.opened_at_ms   min = 1785687129000   ← 先前修复生效
usage_facts.event_ts_ms        min = 1784978588000
workflow_events.event_ts_ms    min = 1784978579264
sessions.started_at_ms         min = 1788964225932
```

### 2.2 MCP 层 —— 干净（含修复后的 trace）

| `_ms` 键 | 出现次数 | 最小值 | 判定 |
|---|---|---|---|
| `started_at_ms` | 4,849 | `1788449204000` | ✅ 毫秒 |
| `ended_at_ms` | 4,843 | `1788449209000` | ✅ 毫秒 |
| `captured_at_ms` | 24 | `1788964228819` | ✅ 毫秒 |
| `last_event_at_ms` | 3 | `1788515994000` | ✅ 毫秒 |
| `latest_captured_at_ms` | 1 | `1789272796452` | ✅ 毫秒 |
| `known_tool_duration_ms` | 1 | `63853000` | 时长 |

`started_at_ms` 的最小值 **`1788449204000`** 正是本次修复的那个 claude-code 值
（修复前为 `1788449204`）——**修复在 MCP 面同样生效**。

### 2.3 CLI 层 —— 干净

113 个 `_ms` 值，无 `< 1e11` 者。

---

## 3. 逐个纪元字段的归属（可核对）

| 字段 | 产生方 | 单位保证 | 判定 |
|---|---|---|---|
| `TraceNode.started_at_ms` / `ended_at_ms` | `domain/trace.rs`（3 处）+ `runtime/trace_service.rs`（1 处） | **本次修复**：全部过 `util::to_epoch_ms` | ✅ 已修 |
| `WorkflowEvent.event_ts_ms` | 各执行环境 `sources/workflow.rs` | `iso_to_epoch_ms`（ISO → 毫秒） | ✅ |
| `QuotaWindow.resets_at_ms` | `harnesses/codex/sessions/usage.rs:270` | 产生方做秒→毫秒转换，单测钉 `1_787_858_552_000` | ✅ |
| `TimeSpan.start_ms` / `end_ms` | 无产生方 —— 但**空值语义正确**（见 §4） | — | ✅ 非缺陷 |
| `BillingPeriod.effective_from_ms` / `_to_ms` | 桌面 IPC 用户输入 | 需另行核（桌面面未扫，见 §5） | ⚠️ 未覆盖 |
| `usage_facts.event_ts_ms` 等 SQL 列 | 事实写入路径 | 权威库契约，真机实测毫秒 | ✅ |

---

## 4. 附带发现：`observed_span` **不是缺陷**——但值得留一条注记

> **本节为 2026-09-13 的自我纠正。** 初稿把 `observed_span` 判为「声明了却从未落地的
> 契约字段 / 空着的洞」，并建议「接线或删除」。**该判定是错的**，逐产生方核证后撤回。

`crates/agent-vitals-domain/src/contracts/evidence.rs:441`

```rust
/// 这个来源**实际**覆盖到的时间跨度。不能假设它等于报告请求的窗口——
/// surface 2/3（钩子 / 遥测）只从配置那一刻开始才有数据（§14.8.6）。
pub observed_span: Option<TimeSpan>,
```

**全部会话 `SourceAttempt` 都在失败路径上。** 三个执行环境适配器都在 `unknown` 派生
的 attempt 里写死 `None`：

```
harnesses/codex/sessions/evidence.rs:892        在 unknown.map(...) 内，available: false
harnesses/claude_code/sessions/evidence.rs:638  同上
harnesses/workbuddy/sessions/evidence.rs:848    同上
```

这些 attempt 的语义是「**这条信号压根没能 derive 出来**」（`available: false` +
`error: Some(..)`）。**来源根本没读成，就没有"实际覆盖的时间跨度"可言**——`None`
在这里是正确的，不是缺失。

（`available: true` 的两处命中——`openclaw/sources/skills.rs` 与
`codex/sources/skills.rs`——属于 `CodexRuntime`/技能运行时可用性，**是另一个结构体**，
与 `SourceAttempt` 无关。）

**结论**：`observed_span` 是**面向未来的契约字段**——为 §14.8.6 那种
「钩子/遥测类表面只从配置那一刻起才有数据」的场景预留，而当前三个执行环境都没有这种
表面，所以没有产生方。**不接线、不删除、不改代码**；把它当"洞"去填，反而是造一个
没有证据支撑的值。

**唯一可选的动作**：在 `evidence.rs` 该字段上补一句「当前无产生方，因为三个执行环境的
attempt 都只在失败路径产出」——避免下一个读者（就是我）再次误判。**本轮未改**，
留给代码所有者决定措辞。

---

## 4bis. 初稿这条错误本身的教训

初稿的推理链是「契约里声明了 → 全仓没有构造点 → 所以是未落地的洞」。**漏掉的一步是
"这个字段在成功路径上是否该出现"**。审计一个字段是否为缺陷，必须先确定**它的产生
路径在当前产品形态下是否存在**，再判断空值是否可疑。

这与本仓反复记录的那类缺陷同形：**看到空/零就当成缺失去填**，而不是先问
「这里本来会有值吗」。


---

## 5. 本体检**未覆盖**的部分（诚实边界）

1. **桌面侧 IPC 的 DTO** —— `read_overview` / `read_calendar_month` / `budget_config` /
   `data_source_status` / `public_pricing_catalog_status` / `about_diagnostics` /
   `harness_bills_for_period` / `billing_*`。这些只在 `.app` 里可调，本次**没有实跑取值**，
   因而它们的 `_ms` 值未被扫描。已读过的产生方代码（如 `overview.rs` 的
   `budget.generated_at` 用 `SyncStatus.at`）看起来是毫秒，但**没有实测背书**。
2. `sessions_search` 在本次窗口内返回空（2026-09-10..11 无会话），其字段未被实际取到。
3. **Rust 结构体里从不序列化的 `_ms` 字段** —— 无运行时风险，未逐个人工判定。
4. 未扫 Python 侧（`packages/agent-vitals-python/`）的 `_ms` 键。Python 是双实现之一，
   若它自产 DTO 而非转发 Rust 结果，理论上存在同源风险。

---

## 6. 建议

| 序 | 事项 | 理由 |
|---|---|---|
| 1 | **不要**为 `_ms` 再加"防御性归一"散点 | 三层实测均干净；散点内联归一正是 `ISSUE_OPENED_AT_MS_UNIT_DRIFT.md` §7 禁止的形态 |
| 2 | ~~处置 `observed_span`~~ → **撤回**（见 §4） | 空值语义正确，无产生方是因为当前没有需要它的表面 |
| 3 | **把桌面 IPC 那一批补进体检** | 唯一还没被实测覆盖的 DTO 面；需要 `.app` 可交互 |
| 4 | 归档或修路径 `docs/RUNTIME_EVIDENCE_CONVERGENCE_SPEC.md` | 路径已随 v0.8 拆 crate 失效，它误导出一条注释（把 trace 单位问题挂给了它） |
| 5 | 建立**回归护栏**：新增 `_ms` 字段时，端点测试断言其值 `>= 1e11` | 这次两颗雷都是"值看着像时间、其实差 1000 倍"，只有量级断言能自动挡住 |
