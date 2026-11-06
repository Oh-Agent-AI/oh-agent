# `observed_span` / 会话跨度接线 —— 实施方案

> 撰写：2026-09-13。前置调研见 `docs/v1.0.0/MS_FIELD_UNIT_AUDIT_2026-09-13.md` §4。
> 触发：审计发现「契约声明了跨度字段，但全仓无产生方」。深入后发现**有两个**这样的字段，
> 且它们的难度与价值差一个量级。

---

## 0. 结论先行：建议拆成两期，一期现在可做，二期不建议现在做

| 期 | 对象 | 建议 | 理由 |
|---|---|---|---|
| **一期** | `SessionMeta.span` | ✅ **现在做** | 单值、四执行环境都可算、语义无歧义、**立即有消费者价值**（解读 `MeasuredZero`/覆盖率时必需） |
| **二期** | `SourceAttempt.observed_span` | ❌ **暂不做** | 它服务 §14.8.6 的「surface 2/3 参差左沿」场景，而**该场景在当前任何执行环境都不存在**（见 §2）。给它填值 = 为不存在的场景发明数据 |

**这个拆分是本方案的核心判断。** 两个字段名字相近，但一个是「已存在能力的字段没接线」，另一个是「为未来场景预留的字段」。

---

## 1. 现状核实（本机实测，非推测）

| 事实 | 证据 |
|---|---|
| `SessionMeta.span` 全仓恒 `None` | Rust：`codex:960` `dsh:469` `claude:652` `workbuddy:858`；Python：`claude:644` `dsh:158` `codex:811` `workbuddy:651` |
| `SourceAttempt.observed_span` 全仓恒 `None` | 3 个 `SourceAttempt` 构造点**全部**是失败路径（`available: false` + `error`） |
| `TimeSpan` **从未被构造** | `grep "TimeSpan {"` 只命中定义处 `evidence.rs:468` |
| `Surface` 只产出过一种 | `SessionLog` ×3；`Telemetry`/`Hook`/`Traces` 在 Rust 与 Python 中产出次数**均为 0** |
| 没有 per-signal span 的位置 | `SignalSet` 是 `u32` 位图；`Coverage` 是 `BTreeMap<Signal, CoverageCounts>`（只有计数） |
| 四执行环境原始记录**都有**时间字段 | claude `"timestamp"`（parse_iso → **秒**）、codex `"timestamp"`（ISO）、dsh `"time"`（**毫秒**）、workbuddy `"timestamp"` |
| codex 的 evidence 适配器**未读** timestamp | `sessions/evidence.rs` 里 `timestamp` 只出现在测试夹具；`sources/workflow.rs:31` 已用 `iso_to_epoch_ms` —— 可复用 |

### 1.1 规格怎么要求的

`docs/RUNTIME_EVIDENCE_CONTRACT.md` §14.8.6「Mixed surfaces have a ragged left edge」：

> Surface 1 covers all retained history. Surfaces 2 and 3 cover only the period since
> someone configured them. A report drawing on both therefore has a **different time
> span per signal**…
> **Every signal carries its own observed span.** A report states the span per signal,
> or states the narrowest span for the whole report.

§15 的反例清单里也有一条：

> Do not state one time window for a report whose signals come from surfaces with
> different observed spans (§14.8.6).

**关键落差**：规格要求的是「**每条 signal 自己的 span**」，而契约里 span 只挂在
`SourceAttempt` 上；`Coverage` 没有位置放 per-signal span。**要完整兑现 §14.8.6
需要契约改造，不是填一个字段。**

---

## 2. 为什么二期现在不该做

§14.8.6 的场景成立需要**同时**满足两条：

1. 某个执行环境实现了 surface 2/3（Hook / Telemetry）；
2. 该表面的起始时间晚于 surface 1。

**第 1 条就不成立**：`Surface::Telemetry` / `Hook` / `Traces` 在两个实现里产出次数都是 0。
所有 attempt 都是 `Surface::SessionLog`，即「整个会话日志」——它的覆盖跨度**就是会话本身的跨度**，
不存在"参差"。

workbuddy 曾有最接近的候选（traces 是第二个表面），但 E2 已明确决定**把 traces 折进 timeline、
不再记 attempt**（`workbuddy/sessions/evidence.rs:840` 的注释）。那是既有设计决策，本方案不改。

**结论**：二期现在做，只能得到一个**没有任何真实输入**的字段。要么等某个执行环境真的接了
hook/telemetry，要么先做 §14.8.6 要求的 per-signal span（契约改造）——两者都不是本轮该顺手做的事。

---

## 3. 一期：`SessionMeta.span` 实施方案

### 3.1 语义定义（**四个必须先拍板的决策**）

| # | 决策 | 建议 | 理由 |
|---|---|---|---|
| **D1** | span 表示什么 | **日志内实测事件时间的 min/max** | 与会话头声明的范围不同：头部可能被截断/轮转，实测值才是"真的有什么" |
| **D2** | 空/单事件 | **0 条原生记录 → `None`**；1 条 → `start == end` | `None` = 「无法给出」，不是 `(0,0)`——后者会被读成 1970。**这是本仓反复栽过的形态** |
| **D3** | 单位 | 一律过 `domain::util::to_epoch_ms` | claude 的 `parse_iso` 出**秒**（已确认），dsh 是毫秒；已有唯一具名函数 |
| **D4** | 是否含派生时间 | **只取原生记录的时间戳** | 合成的 `ordinal` 序数不是时间；派生值会把"我们猜的"冒充成"观测到的" |

> **D2 是四个里最重要的。** 本仓纪律：缺数据要 `None`/`unavailable`，绝不填零——
> `span: {start_ms: 0, end_ms: 0}` 会被下游读成 1970-01-01，正是 `_ms` 体检刚处理过的那类雷。

### 3.2 实施步骤

| 步 | 内容 | 产物 |
|---|---|---|
| **S1** | 在 `contracts/evidence.rs:540` 给 `span` 补文档：语义（D1）、空值规则（D2）、单位（D3）、只取原生（D4） | 契约注释 |
| **S2** | **Rust 四适配器**各算 span：从已解析的原生记录取 min/max 时间，过 `to_epoch_ms` | 4 处 `span: None` → 计算值 |
| **S3** | **Python 四镜像**同改（`claude_evidence.py:644` / `codex_evidence.py:811` / `dsh_evidence.py:158` / `workbuddy_evidence.py:651`） | 跨语言同形 |
| **S4** | codex 特有：其 evidence 适配器目前**不读** `timestamp`，需新增读取（复用 `iso_to_epoch_ms`，与 `sources/workflow.rs:31` 同源） | codex span 可算 |
| **S5** | 内部构造点保持 `span: None`：`compatibility/canonical_session.rs:296`、`domain/canonical_audit.rs:78`（它们是测试/兼容路径，不是真实会话） | 不改 |
| **S6** | 门禁重跑：`golden_runner.py`、`test_cli_matrix.py`（差分）、`test_canonical_schema.py`（逐字段对账 Rust CanonicalSession） | 全绿 |

### 3.3 影响面清单（逐文件，供评估工作量）

**产生方（8 处）**
```
crates/agent-vitals-harnesses/src/harnesses/claude_code/sessions/evidence.rs:652
crates/agent-vitals-harnesses/src/harnesses/codex/sessions/evidence.rs:960
crates/agent-vitals-harnesses/src/harnesses/dsh/sessions/evidence.rs:469
crates/agent-vitals-harnesses/src/harnesses/workbuddy/sessions/evidence.rs:858
packages/agent-vitals-python/agent_vitals/agent/claude_evidence.py:644
packages/agent-vitals-python/agent_vitals/agent/codex_evidence.py:811
packages/agent-vitals-python/agent_vitals/agent/dsh_evidence.py:158
packages/agent-vitals-python/agent_vitals/agent/workbuddy_evidence.py:651
```

**会被 DTO 变化触动的门禁（需同轮验证）**
```
tests/golden_runner.py           字节快照（15 个 case）
tests/test_cli_matrix.py         双实现差分（AGENT_VITALS_BIN）
tests/test_canonical_schema.py   逐字段对账 Rust CanonicalSession
tests/test_characterization.py   纯函数定值
tests/test_regressions.py        含 observed_span 断言（:1471）——一期不动
tests/test_timeline_ordinals.py  序列契约
tests/test_harness_contract.py      执行环境契约
```

**代码引用点（读 `span` 的地方）**：目前**为零**——四个 `span:` 全是写 `None`，无读者。
所以一期是**纯新增**，不改任何现有行为路径，风险集中在 DTO 形状而非逻辑。

### 3.4 验收判据

1. **四执行环境真机各取一个会话**：`span.start_ms` / `span.end_ms` 与该会话**首末事件的实际时间**一致
   （对拍方式：`span` 与 `sessions list` 的 `first_event_at`/`last_event_at` 同一会话内自洽）。
2. **空会话**（0 条原生记录）→ `span == null`，**不是** `{"start_ms":0,"end_ms":0}`。
3. **单事件会话** → `start_ms == end_ms`，不是 `null`。
4. **量级护栏**：claude 的 span（秒源）必须 `>= 1e11`；用 `MS_FIELD_UNIT_AUDIT` 里那个护栏函数断言。
5. **跨语言**：`AGENT_VITALS_BIN=<rust> python3 -m unittest tests.test_cli_matrix` 逐字节一致。
6. **golden 15/15** 逐字节一致（若 span 变化进入快照，需确认差异是预期的再 `--update`）。
7. **`start <= end`** 恒成立（加断言，防 min/max 取反）。

### 3.5 明确不做（一期边界）

- ❌ 不填 `SourceAttempt.observed_span`
- ❌ 不发明 surface 2/3（Hook/Telemetry）
- ❌ 不做 §14.8.6 的 per-signal span（需要 `Coverage`/`SignalSet` 契约改造）
- ❌ 不改 attempt 的语义（它仍是「失败/跳过记录」，不是「读取记录」）
- ❌ 不改节点排序（`(scope, ordinal)` 是权威，`started_at_ms` 只用于展示与分桶）
- ❌ 不改任何现有读 `span` 的路径（现在没有读者，新增是纯增量）

---

## 4. 二期（暂缓）：若将来要做，前置条件是什么

真要做 `observed_span` / §14.8.6，**必须先满足其一**：

| 前置 | 说明 | 性质 |
|---|---|---|
| **P-a** | 某执行环境真的接一个 surface 2/3（hook 或 telemetry），使"参差左沿"成为**可观测事实** | 产品功能 |
| **P-b** | 把 `attempts` 从「失败/跳过记录」扩展为「**读取记录**」——每条成功读取的表面也产 attempt 并带 span | **契约语义变更**：会让 `attempts` 在健康会话上非空（当前真机 0 条），波及 golden、Python 锁步、所有证据 DTO |
| **P-c** | 契约改造：给 `Coverage`（或新的 per-signal 结构）加 span 位置，兑现「每条 signal 自己的 span」 | 契约改造 + 四执行环境 ×2 实现 |

**P-b 是最小可行路径**，但它会改变一直接受验收的形状（`attempts` 从空变非空），
需要先写规格修订并取得确认——**不能作为"顺手补一个字段"混进来**。

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| **把 `None` 偷换成 `(0,0)`** | D2 明文禁止 + 验收判据第 2 条专测；这是本仓反复栽过的形态 |
| **claude 的秒被当毫秒** | D3 强制走 `to_epoch_ms` + 验收判据第 4 条的量级护栏 |
| **golden/差分被"更新快照"掩盖** | 差分门是逐字节的；任何 `--update` 前必须先确认差异来自 **span 由 null 变值**，而不是别的字段漂移 |
| **Python 与 Rust 不同步** | S3/S6 同轮；`test_cli_matrix` 是唯一裁判 |
| **为不存在的场景预建复杂度** | §2 与 §4 —— 一期严格限定在 `SessionMeta.span` |

## 6. 回滚

一期是**纯新增字段值**（`null` → 值），无读方、无逻辑分支，回滚 = 还原 8 处产生方与 4 处 Python 镜像。
但注意：一旦 golden 快照含新值，回滚需同时回滚快照，否则快照会记录一个已不存在的形状。

---

## 7. 建议的排期

| 序 | 内容 | 依赖 |
|---|---|---|
| 1 | **拍板 D1–D4**（尤其 D2/D3） | — |
| 2 | S1 契约文档 + S2/S4 Rust 四适配器 | 1 |
| 3 | S3 Python 四镜像 | 2 |
| 4 | S6 门禁重跑 + 验收 1–7 | 3 |
| 5 | 二期只留规格条目，**不排期** | P-a/P-b/P-c 决策 |

**本方案不改变任何 PRD 勾选状态**，也不声称完成任何 AC。
