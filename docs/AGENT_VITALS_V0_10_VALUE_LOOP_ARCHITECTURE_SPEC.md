# Agent Vitals v0.10 Value Loop 架构规格

> 状态：架构草案 R1（2026-09-04）  
> 前置：`AGENT_VITALS_V0_9_DATA_VALUE_ARCHITECTURE_SPEC.md` 已发布并通过其 Definition of Done。  
> 定位：把可信数据转化为普通用户可理解、可执行、可验证收益的问题解决闭环。

## 0. 版本目标

v0.10 的北极星不是“发现多少异常”，而是：

> **多少高可信问题获得了安全的可执行方案，并最终减少了多少浪费、成本或失败。**

```text
v0.9 facts / canonical / billing / coverage
  → task trace + metrics
  → evaluation + root cause
  → issue + remedy plan + potential savings
  → preview / approval / apply / receipt
  → baseline comparison + realized savings
```

## 1. 用户问题

1. 哪些任务最贵、最慢或最容易失败？
2. 具体哪一步造成成本、重试、无效工具调用或上下文浪费？
3. 为什么发生，证据覆盖是否足够？
4. 我现在能安全地做什么？
5. 改完以后，是否真的省钱或降低失败率？

首页仍优先展示月度总感知成本；缓存率、compaction、工具失败率、推理 token 比例等是诊断指标，不应替代用户结果。

## 2. 核心契约

### 2.1 TraceGraph

使用 `TraceGraph`，而非把所有执行环境强行称为 OTel Span。缺 parent/child、精确时间或 status 时，必须在 coverage 中标缺失。

```rust
pub struct TraceGraph {
    pub schema_version: u16,
    pub graph_id: String,
    pub session_key: SessionKey,
    pub task_id: Option<String>,
    pub nodes: Vec<TraceNode>,
    pub edges: Vec<TraceEdge>,
    pub coverage: TraceCoverage,
    pub input_fingerprint: String,
}
```

节点可表示 user task、assistant turn、model invocation、tool call、subagent、compaction、retry 或 outcome；每一个节点和边均应指回 v0.9 的事实/证据 ID。

### 2.2 指标与评估

- `MetricDefinition`：指标 ID、分子、分母、窗口、缺失策略、排序与版本；
- `EvaluationResult`：program 或 LLM evaluator 的结论、版本、coverage、input fingerprint 与证据；
- `IssueInstance`：将多个 Finding/Evaluation 聚为用户问题，保存根因、风险、状态和证据；
- `RemedyDefinition` / `RemedyPlan`：方案、适用条件、权限、风险、预估影响、验证方式与 rollback；
- `ActionReceipt`：真实执行目标、时间、变更指纹、结果和 rollback 引用；
- `OutcomeMeasurement`：baseline、观察窗、覆盖、反事实限制、Potential/Validated/Realized savings。

`Potential`、`Validated`、`Realized` savings 永不混算；所有成本仍继承 v0.9 的 basis 与 unresolved 口径。

## 3. 评估策略

程序评估优先：重复尝试、重复工具调用、失败率、无效读写、上下文增长、模型错配、cache/usage 守恒与覆盖异常等，优先用结构、状态机、统计和守恒律判断。

LLM evaluator 仅用于程序规则无法覆盖的语义问题；默认关闭、须授权和预算、只产生评估证据，不能直接执行修改或把正文默认发往外部服务。

人类反馈是弱信号：用于确认方案是否有帮助，不作为普通用户使用产品的前置要求。

## 4. 问题到方案

每个稳定问题族必须有以下之一：

1. 至少一个可执行、低风险的 remedy；或
2. 明确 `diagnostic-only`，说明为什么当前不能安全自动处理。

首批 remedy 应优先覆盖可逆、可预览的动作，例如：禁用长期未触发且证据充分的 Skill、收紧重复工具调用策略、推荐合适模型/上下文策略、修复可验证的配置错误。禁止默认删除用户文件、改变执行环境配置或进行网络 MCP probe。

## 5. 产品界面

```text
Overview   月度总感知成本、可避免浪费、已实现节省、数据覆盖
Sessions   会话筛选、成本/失败/持续时间、下钻
Traces     轨迹、节点图、时间线、覆盖与缺失说明
Issues     问题、根因、证据、风险、状态
Savings    potential / validated / realized 三层收益
Settings   执行环境、套餐/按量、数据源、隐私、LLM 授权与预算
```

Tauri 与 CLI 消费同一 Runtime projection DTO；状态栏只呈现摘要、同步状态和安全快捷入口，不承载复杂诊断。

## 6. Runtime 与目录增量

```text
vitals-core/
  graph.rs, measurement.rs, action.rs       # 无 Agent 语义的原语

agent-vitals-domain/
  contracts/{trace_graph,evaluation_result,issue,remedy,outcome}.rs
  domain/{metrics,evaluation,remediation,impact}/

agent-vitals-harnesses/src/harnesses/<harness>/sessions/trace.rs
  # harness wire → trace node / invocation / tool observation

agent-vitals-runtime/
  trace_service.rs
  metrics_service.rs
  validation_service.rs
  evaluation_service.rs
  llm_evaluation_service.rs
  issue_service.rs
  remedy_service.rs
  action_service.rs
  outcome_service.rs
  projection_service.rs
```

CLI/Tauri 只发 command、请求授权并展示 DTO；不得复制 token/cost/fact identity、诊断或定价公式。

## 7. 实施阶段

### v0.10-A：Trace & Metrics

- Claude Code、Codex、DSH 的确定性 TraceGraph builder；
- Invocation / tool timing / model / cost / failure metrics；
- Sessions、Traces 查询 DTO、时间线与节点图；
- coverage 与降级显示。

**门槛：**至少三执行环境可生成确定性图；缺失关系不伪造。

### v0.10-B：Issues & Remedies

- EvaluationResult、IssueInstance、根因归并；
- 程序 evaluator；
- remedy catalog、preview 与 potential savings；
- Issues / Savings 页面。

**门槛：**稳定问题族 remedy coverage 100%，其余显式 diagnostic-only。

### v0.10-C：Action & Outcome

- 授权、preview、apply、rollback 与 ActionReceipt；
- baseline/comparison、actual outcome 与 realized savings；
- 至少三个低风险方案端到端闭环。

**门槛：**发现 → 预览 → 授权执行 → 回执 → 结果验证可重放、可回滚。

### v0.10-D：可选 LLM 补盲

独立 feature；不阻塞 A–C。需实现 evaluator registry、脱敏、预算、缓存、schema validation 和明确 unavailable 状态。

## 8. 明确不做

- 不做 Phoenix/Jaeger 的完整替代品；
- 不把缺失 parent/time/status 的日志伪造成完整分布式 trace；
- 不默认上传提示词、会话正文或工具结果；
- 不默认修改或删除 Skill、配置、项目文件；
- 不做主动 MCP 健康探测；
- 不把 DuckDB 引入为运行时第二状态库；
- 不以文件 watcher 的有无作为本版本发布条件。watcher 仅在 v0.9 durable ingest 稳定后另行立项。

## 9. 架构守卫与 Definition of Done

1. 图节点/边引用的 fact/evidence 必须存在；
2. 无证据 parent/time/status 不得由数组顺序或 mtime 补造；
3. EvaluationResult 必含 evaluator version、coverage 和 input fingerprint；
4. 每个稳定 Issue 映射 remedy 或 diagnostic-only；
5. 自动动作须有风险、授权、rollback、verification 与 ActionReceipt；
6. Potential/Validated/Realized savings 的字段与聚合路径严格分离；
7. 同一输入重放不重复写 issue、action 或 outcome；
8. CLI、Tauri、HTML 的关键 projection 一致；
9. LLM 默认关闭仍可完整使用产品，开启后费用可见且绝不直接触发修改；
10. 至少三个低风险方案端到端验证实际结果，不能只展示预计节省。

## 10. v0.10 schema v3 增量

> 本节定义 v0.10 在 v0.9.1 schema v2 之上的持久化增量；派生数据（TraceGraph / MetricDefinition result / EvaluationResult / TraceCoverage）一律不入 schema，从 UsageFact 重算。

### 10.1 设计原则（与 v0.9.1 数据面对齐）

- **权威在 JSONL**：`<data_home>/facts/<harness>.jsonl` 是 append-only 权威源，本规则不破。
- **SQLite 是状态投影**：只持久化需要状态机的实体（IssueInstance / ActionReceipt / OutcomeMeasurement）；可从 UsageFact 重算的派生数据**一律不入 schema**。
- **幂等键统一**：所有新表主键与 `UNIQUE` constraint 用 `fnv1a64_hex(canonical_json(...))` 派生，规则与 v0.9.1 `source_identity::canonical_json` 一致——`§9` DoD 第 7 条的"同一输入重放不重复写"在 schema 层落地。
- **派生数据不持久化**：TraceGraph / MetricDefinition result / EvaluationResult / TraceCoverage 走"现算 + 60s memo"模式（复用 `runtime::summary::codex_merged_cached` 同模式，按 home 键控），memo 失效条件 = session_facts 表新增行（用 `MAX(fact_id) WHERE session_key=?` 计数器对比）。
- **schema bump 是纯增量**：v0.10 不修改 v0.9.1 schema v2 任何已有表；`PRAGMA user_version` 2 → 3，迁移函数只 `CREATE TABLE / INDEX`。

### 10.2 新增表（5 张状态表 + 1 张 catalog + 1 张可选 cache）

#### 10.2.1 `issue_instances`（v0.10-B，根因归并）

```sql
CREATE TABLE issue_instances (
    issue_id TEXT PRIMARY KEY,             -- fnv1a64_hex(canonical_json(harness, issue_type, instance_fingerprint))
    harness TEXT NOT NULL,                    -- claude-code / codex / dsh / 'aggregate'
    session_key TEXT,                      -- nullable（aggregate-level issues 不绑会话；按 v0.9 evidence_ref 规则，写空串而非 NULL）
    issue_type TEXT NOT NULL,              -- 根因族 id（zombie_skill / duplicate_tool_call / ...）
    severity TEXT NOT NULL,                -- critical / warning / info
    status TEXT NOT NULL DEFAULT 'open',   -- open / acknowledged / closed / wontfix
    title TEXT NOT NULL,
    summary TEXT,
    root_cause TEXT,
    instance_fingerprint TEXT NOT NULL,    -- 派生自 UsageFact[] 的 fnv1a64
    opened_at_ms INTEGER NOT NULL,
    closed_at_ms INTEGER,
    metadata_json TEXT,
    UNIQUE(harness, instance_fingerprint, status)  -- §9 DoD 第 7 条幂等性
);
CREATE INDEX idx_issue_harness_status ON issue_instances(harness, status);
CREATE INDEX idx_issue_session ON issue_instances(session_key);
```

#### 10.2.2 `remedy_definitions`（v0.10-B，catalog）

```sql
CREATE TABLE remedy_definitions (
    remedy_id TEXT PRIMARY KEY,            -- 稳定 id，如 'remedy:disable_zombie_skill'
    name TEXT NOT NULL,
    description TEXT,
    applicable_issue_types TEXT NOT NULL,  -- JSON array
    risk_level TEXT NOT NULL,              -- low / medium / high（§4 禁止 high 默认）
    requires_preview BOOLEAN NOT NULL,
    requires_rollback_capability BOOLEAN NOT NULL,
    applies_via_json TEXT NOT NULL,        -- {kind:'sql', sql:'...'} 或 {kind:'mcp', tool:..., args:...}
    verification_query TEXT,
    rollback_query TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
```

**豁免 retention sweep**：catalog 不过期。

#### 10.2.3 `issue_remedies`（v0.10-B，Issue ↔ Remedy 关联）

```sql
CREATE TABLE issue_remedies (
    issue_id TEXT NOT NULL,
    remedy_id TEXT NOT NULL,
    plan_status TEXT NOT NULL DEFAULT 'pending',  -- pending / previewed / approved / applied / rolled_back
    potential_savings_basis TEXT NOT NULL,        -- 'nominal_cost' / 'metered_spend'（ATTRIBUTABLE_WASTE §6/§6.7 口径）
    potential_savings_amount_minor INTEGER,
    potential_savings_currency TEXT,              -- 'CNY' / 'USD'
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (issue_id, remedy_id),
    FOREIGN KEY (issue_id) REFERENCES issue_instances(issue_id),
    FOREIGN KEY (remedy_id) REFERENCES remedy_definitions(remedy_id)
);
```

#### 10.2.4 `action_receipts`（v0.10-C）

```sql
CREATE TABLE action_receipts (
    receipt_id TEXT PRIMARY KEY,           -- fnv1a64_hex(canonical_json(...))
    issue_id TEXT NOT NULL,
    remedy_id TEXT NOT NULL,
    actor TEXT NOT NULL,                   -- 'user' / 'cli' / 'tauri' / 'automation'
    actor_id_hash TEXT,                    -- 人类标识 hash 后（§3 隐私护栏）
    action_target_json TEXT NOT NULL,      -- 修改目标（脱敏后）
    action_fingerprint TEXT NOT NULL,      -- 修改前后状态 hash
    executed_at_ms INTEGER NOT NULL,
    result TEXT NOT NULL,                  -- success / failed / rolled_back
    rollback_receipt_id TEXT DEFAULT '',   -- 空串占位（v0.9 evidence_ref 规则：UNIQUE NULL 语义避免）
    verification_result_json TEXT,
    FOREIGN KEY (issue_id) REFERENCES issue_instances(issue_id),
    FOREIGN KEY (remedy_id) REFERENCES remedy_definitions(remedy_id)
);
CREATE INDEX idx_action_issue ON action_receipts(issue_id);
CREATE INDEX idx_action_executed_at ON action_receipts(executed_at_ms);
```

#### 10.2.5 `outcome_measurements`（v0.10-C，三档严格分离）

```sql
CREATE TABLE outcome_measurements (
    outcome_id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    receipt_id TEXT DEFAULT '',            -- nullable（baseline 测量在执行前）
    metric_id TEXT NOT NULL,
    -- baseline 窗口（历史快照）
    baseline_window_start_ms INTEGER NOT NULL,
    baseline_window_end_ms INTEGER NOT NULL,
    baseline_value_minor INTEGER,
    baseline_currency TEXT,
    baseline_tokens INTEGER,
    -- observed 窗口
    observed_window_start_ms INTEGER NOT NULL,
    observed_window_end_ms INTEGER NOT NULL,
    observed_value_minor INTEGER,
    observed_currency TEXT,
    observed_tokens INTEGER,
    -- 严格只填一档：potential / validated / realized 绝不三档相加（§9 DoD 第 6 条）
    savings_basis TEXT NOT NULL,           -- 'nominal_cost' / 'metered_spend'
    savings_kind TEXT NOT NULL,            -- 'potential' / 'validated' / 'realized'
    CHECK (savings_kind IN ('potential','validated','realized')),
    savings_value_minor INTEGER,
    savings_currency TEXT,
    savings_coverage_json TEXT,            -- coverage / partial / unavailable（v0.9 unaccounted_usage 漏斗同语义）
    counterfactual_note TEXT,              -- 反事实限制说明
    created_at_ms INTEGER NOT NULL,
    UNIQUE(issue_id, metric_id, savings_kind, baseline_window_start_ms, observed_window_start_ms),
    FOREIGN KEY (issue_id) REFERENCES issue_instances(issue_id)
);
CREATE INDEX idx_outcome_issue ON outcome_measurements(issue_id);
CREATE INDEX idx_outcome_kind ON outcome_measurements(savings_kind);
```

#### 10.2.6 `llm_evaluator_cache`（v0.10-D，feature-gated，可选）

```sql
-- 仅在 feature 'llm-evaluator' 启用时建表
CREATE TABLE llm_evaluator_cache (
    cache_id TEXT PRIMARY KEY,             -- fnv1a64_hex(redacted_payload + evaluator_version)
    evaluator_id TEXT NOT NULL,
    evaluator_version TEXT NOT NULL,
    redacted_input_fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    cost_minor INTEGER,
    cost_currency TEXT,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL         -- 默认 7 天
);
CREATE INDEX idx_llm_cache_expires ON llm_evaluator_cache(expires_at_ms);
```

**feature gate 语义**：未启用 LLM evaluator 时本表不存在；`evaluator_registry` 启动时检测该表存在性以决定 cache 路径。

### 10.3 派生数据不入 schema（性能与权威性双约束）

| 契约 | 不入 schema 的原因 | memo/缓存策略 |
|---|---|---|
| `TraceGraph` | 从 CanonicalSession + usage_facts 现算；spec §0 派生原则 | `Arc<RwLock<HashMap<session_ref, TraceGraph>>>`；失效 = session_facts `MAX(fact_id)` 计数器对比 |
| `MetricDefinition` result | cost / token / coverage 必须从 `agent_vitals_domain::cost` / `usage` / `evidence` 派生；spec §2.2"派生关系"约束 | 60s memo，按 `(metric_id, params_fingerprint, home)` 键控 |
| `EvaluationResult` | program evaluator（SV 规则）已是纯函数；memo 复用 MetricDefinition | 同上 |
| `TraceCoverage` | 等价 v0.9 `evidence::Coverage`，从 CanonicalSession.coverage 派生 | 无需 memo，构造代价 O(1) |

**性能形状纪律**：派生层 memo 必须走 Arc——锁内深拷贝几 MB JSON 会把并发命令串行卡在锁上（v0.9.1 工作台 tab 卡顿事故同形态，已修）。

### 10.4 PRAGMA user_version 升级路径

- v0.9.1 `PRAGMA user_version = 2`
- v0.10 启动检测 `PRAGMA user_version < 3` → 跑 `migrate_v2_to_v3()`：
  1. `CREATE TABLE issue_instances / remedy_definitions / issue_remedies / action_receipts / outcome_measurements` + indexes
  2. 若 `feature llm-evaluator` 启用 → `CREATE TABLE llm_evaluator_cache`
  3. `PRAGMA user_version = 3`
- **不动** v0.9.1 schema v2 任何已有表
- **§3.5 部署纪律**：每次 schema bump 必走 `cp -r ~/.agent-vitals ~/.agent-vitals.backup-$(date +%Y%m%d-%H%M%S)` + `data-status --json` 验证 `health: ok / integrity: ok / schema_version=3`

### 10.5 retention 与 v0.9.1 一致

v0.9.1 §5 retention 规则（13 个自然月，含当月，cutoff = current − 12——fencepost 已钉死）扩展到 v0.10 新表：

| 表 | retention 策略 |
|---|---|
| `issue_instances` | 13 个月；`status='open'` 行不过期（与 sync_runs 同一 fencepost） |
| `action_receipts` | 13 个月 |
| `outcome_measurements` | 13 个月 |
| `issue_remedies` | 13 个月 |
| `remedy_definitions` | **不过期**（catalog） |
| `llm_evaluator_cache` | 按 `expires_at_ms` 独立 sweep，不走 13 个月 fencepost |

`sync_facts` 每天首轮在 `.ingest.lock` 内自动跑一次 sweep；`enforce_retention` 新增 4 张表分支（catalog 表豁免）。

### 10.6 与 v0.9.1 既有不变量对齐

| v0.9.1 规则 | v0.10 新表落地 |
|---|---|
| fact_id = `fnv1a64_hex(canonical_json(...))` | `issue_id` / `receipt_id` / `outcome_id` 同款 |
| 货币一律 minor units | `*_value_minor INTEGER` + `*_currency TEXT` 拆分 |
| 跨币相加自动 None（§6.7） | `outcome_measurements.baseline_currency` ≠ `observed_currency` 时 `savings_value_minor` 自动 NULL（聚合层 MoneyMinor 聚合器） |
| evidence_ref 不用 NULL（SQLite UNIQUE 语义） | nullable 字段写空串而非 NULL（`receipt_id TEXT DEFAULT ''` / `rollback_receipt_id TEXT DEFAULT ''`） |
| retention 13 个月 + undated 保留 | 新表加进 retention sweep，catalog 表豁免 |
| writer lease O_EXCL + atomic rename | issue_instances / action_receipts / outcome_measurements 写入走 `runtime::lease` 同接口（v0.9.1 已有） |
| `unaccounted_usage` residual sentinel | `outcome_measurements.savings_coverage_json` 同语义：填 `coverage` / `partial` / `unavailable` 三态，**绝不填 0 假装完整** |
| sync_runs sweep（running → cancelled） | 不适用（一次性写，无 running 状态） |

### 10.7 关键风险（明确列出，便于 v0.10-B/C review 时检查）

1. **`issue_remedies.potential_savings_amount_minor` 与 `outcome_measurements.savings_value_minor` 口径严格区分**：前者是 pre-execution 估算（标 `kind='potential'`），后者是 post-execution 测量（标 `kind='validated'` 或 `'realized'`）；同一 SQL 查询不得 `SUM` 两字段（`§9` DoD 第 6 条 + spec §2.2 三档永不混算）。
2. **`outcome_measurements.savings_kind` 必须是 enum CHECK constraint**（已加 `CHECK (savings_kind IN ('potential','validated','realized'))`）：避免 typo `'realised'` 拼写错误导致聚合错位——v0.9 spec lineage 里的事实教训："形状来源纪律"（CLAUDE.md Stage A–D 审查 10 条确认缺陷的共同根因）。
3. **`remedy_definitions.applies_via_json` 不得直接执行**：必须经 `action_service` 走 §3 授权流程（preview → approve → apply → receipt → verify），catalog 里的 `applies_via` 仅作模板；runtime 不得跳过 preview / approval 直接 exec。
4. **`action_receipts.actor_id_hash` 必须 hash 而非明文**：人类用户标识走 `source_identity::fnv1a64_hex`，与 v0.9 `native_session_id` / `machine_namespace` 同隐私护栏。
5. **`llm_evaluator_cache.redacted_input_fingerprint` 必须先经 v0.9 redaction pipeline**：LLM evaluator 不得自行脱敏（spec §3 已写"输入必须先经过 v0.9 redaction pipeline"）；cache key 由 `fnv1a64_hex(redacted_payload)` 派生，原始 payload 不入表。

## 11. v0.10 spec 与 v0.9/v0.9.1 已落地内容的对齐调整（待合并 patch）

> 本节集中列出 spec §2–§9 既有章节因 v0.9/v0.9.1 已落地而需要做的对齐调整；每条指明**改哪里** + **改成什么** + **为什么**。spec §0–§9 原文不破，本节作为「待合并 patch」按节奏拆 PR 合并进原文。
> 不重复 §10（schema v3 增量），§10 与本节互补——§10 是持久化层新增，本节是 spec 既有 §2–§9 的契约补强。

### 11.1 §2.1 TraceGraph：补 fact_id / evidence_ref 字段定义

**改哪里**：`§2.1` `TraceGraph` 结构定义。

**改成什么**：

```rust
pub struct TraceNode {
    pub node_id: String,                 // fnv1a64_hex(canonical_json(...))，与 UsageFact.fact_id 同源
    pub node_type: TraceNodeType,        // user_task / assistant_turn / model_invocation / tool_call / subagent / compaction / retry / outcome
    pub fact_id: String,                 // 引用的 UsageFact.fact_id（v0.9 已落地）
    pub evidence_ref: String,            // 引用的 evidence_ref（空串占位，非 NULL；v0.9 SQLite UNIQUE 语义）
    pub parent_node_id: Option<String>,  // 不存在的 parent 在 TraceCoverage 里标 missing（§0 原则）
    pub started_at_ms: Option<i64>,      // 不存在时 None，**不得用 mtime / 数组顺序补造**（§0 + §8 DoD）
    pub ended_at_ms: Option<i64>,
    pub status: Option<TraceStatus>,     // ok / error / timeout / cancelled / unknown
    pub metadata: serde_json::Value,
}

pub struct TraceEdge {
    pub edge_id: String,                 // fnv1a64_hex(canonical_json(...))
    pub from_node_id: String,
    pub to_node_id: String,
    pub fact_id: String,                 // 引用的 UsageFact.fact_id
    pub evidence_ref: String,            // 空串占位
    pub edge_type: TraceEdgeType,        // causal / temporal / data_flow / control_flow
}

pub struct TraceCoverage {
    pub missing_parent: u32,             // 节点存在但 parent_node_id 不可解析
    pub missing_time: u32,               // started_at_ms 或 ended_at_ms 缺失
    pub missing_status: u32,             // status 字段缺失
    pub total_nodes: u32,
    pub total_edges: u32,
    pub coverage_ratio: f64,             // 1.0 - (missing_parent + missing_time + missing_status) / (3 * total_nodes)
}
```

**为什么**：spec §0「缺 parent/time/status 时，必须在 coverage 中标缺失」+ §8「不把缺失 parent/time/status 的日志伪造成完整分布式 trace」是原则；字段定义必须显式给出 `fact_id` / `evidence_ref` / `Option<>` 类型，**不允许**用 mtime / 数组顺序补造。`fact_id` 与 v0.9 `source_identity::fnv1a64_hex` 同源——图节点/边**不得自造 ID**。

---

### 11.2 §2.2 MetricDefinition：加「派生关系」段落

**改哪里**：`§2.2` 段落开头。

**改成什么**：在 `MetricDefinition` 定义之前加一段约束：

> **派生关系（v0.9.1 已实现，v0.10 不重写）**：v0.10 MetricDefinition 不得重写 v0.9.1 已实现的算法：
> - cost 相关 metric 必须从 `agent_vitals_domain::cost::{priced_token, priced_day, cost_report}` 派生
> - token bucket 相关 metric 必须从 `agent_vitals_domain::usage::{token_by_model, token_by_date_model, usage_fold_state}` 派生
> - coverage metric 必须从 `agent_vitals_domain::evidence::{Coverage, Signal::Usage::unmetered}` 派生
>
> **新 metric 才允许新增定义**；同名 metric 必须复用 v0.9.1 实现。三消费面（CLI / Tauri IPC / HTML）byte-identical 由 `tests/test_cli_matrix.py::both()` 守。

**为什么**：v0.9 spec lineage 里的"形状来源纪律"——渲染器/verify stub 手写数据期望形状会与 fold/DTO 真实形状互相印证着一起错（CLAUDE.md Stage A–D 审查 10 条确认缺陷的共同根因）。MetricDefinition 是 v0.10 新增层，但其值必须从 v0.9 既有 domain crate 派生，避免三消费面再次出现 r2a_store 旁路 SQL 权威库那种"四份拷贝"的事故（v0.9.1 plan §1 已记录）。

---

### 11.3 §2.2 OutcomeMeasurement：4 档成本口径 → savings 三档映射

**改哪里**：`§2.2` `OutcomeMeasurement` 段落。

**改成什么**：把 spec 现有 `Potential / Validated / Realized` 描述补一段映射规则（引用 ATTRIBUTABLE_WASTE §6/§6.7 4 档成本口径）：

> **与 v0.9.1 4 档成本口径的衔接**（ATTRIBUTABLE_WASTE §6/§6.7）：
>
> | savings_kind | 派生公式 | 货币口径 |
> |---|---|---|
> | `potential` | `nominal_cost - metered_spend`（仅适用于按量计费模型；订阅型模型不产 potential） | `nominal_cost` 所在货币 |
> | `validated` | issue 关闭时的 baseline 差额 | `metered_spend` 所在货币 |
> | `realized` | 执行 remedy 后的实际差额 | `metered_spend` 所在货币 |
>
> **硬规则**：
> 1. `potential` / `validated` / `realized` 三档在同一 SQL 查询里**不得 `SUM`**（§9 DoD 第 6 条 + §10.7 第 1 条）；
> 2. 跨币相加时 `savings_value_minor` 自动 NULL（§6.7 护栏，由 `MoneyMinor` 聚合器实现）；
> 3. `savings_kind` 字段为 enum CHECK constraint（已加 `CHECK (savings_kind IN ('potential','validated','realized'))`）；
> 4. `unpriced_tokens` 不参与任何 savings 派生——它本身已是无价卡 token，强行代入会编造节省。

**为什么**：spec §0 提「`Potential`、`Validated`、`Realized` savings 永不混算；所有成本仍继承 v0.9 的 basis 与 unresolved 口径」是结论，缺中间映射；4 档口径不映射会让 product 三档字段在 SQL 层误聚合，触发"报告 ¥1733 vs 实际 ¥2386"同形态事故（CLAUDE.md 8 月事故同根因）。

---

### 11.4 §3 评估策略：LLM evaluator 走 v0.9 redaction pipeline

**改哪里**：`§3` 评估策略段落末。

**改成什么**：在「LLM evaluator 仅用于…」那段后加一段：

> **LLM evaluator 输入流水线**（v0.9 redaction 复用）：
> 1. 原始 UsageFact 序列 → `agent_vitals.redact(redact_names=True, drop_description=True)`（CLAUDE.md redaction 不变量）
> 2. redacted payload → `source_identity::canonical_json` 序列化
> 3. `fnv1a64_hex(canonical_json)` → `redacted_input_fingerprint`（同时是 `llm_evaluator_cache.cache_id` 派生键，§10.2.6）
> 4. redacted payload 经 LLM evaluator；**原始 payload 不得入 `llm_evaluator_cache.result_json`**（只存 `result_json` + 缓存键）
>
> LLM evaluator 不得在内部自行脱敏——v0.9 redaction 是单一权威（CLAUDE.md 测试层 `tests/test_properties.py` 守「redaction 不得在任何字段任意深度残留真名」）；自造脱敏会绕过验证。

**为什么**：spec §3 已写「只产生评估证据，不能直接执行修改或把正文默认发往外部服务」，但**没指定**脱敏路径。LLM evaluator 在内部自行脱敏会形成"第二份脱敏逻辑"，绕过 v0.9 测试层——这是 `tests/test_properties.py` 钉死的不变量被绕过的典型方式。

---

### 11.5 §5 产品界面：6 tab ↔ 5 tab 对应 + Token 日历归属

**改哪里**：`§5` 产品界面段落。

**改成什么**：把 spec 现有 6 tab 列表替换为下表（含 tab 来源 + 升级路径）：

| v0.10 tab | 当前 v0.9 tab | 动作 | 阶段 |
|---|---|---|---|
| Overview | 总览 | 复用 + 升级（加可避免浪费、已实现节省、数据覆盖） | v0.10-A |
| Sessions | 会话 | 复用（`mcp::sessions_search` 已落 main） | v0.9.1 收口 |
| **Traces** | ❌ 无 | **新增**：节点图、时间线、coverage 降级显示 | v0.10-A |
| **Issues** | Findings | 改名 + 升级：Finding → IssueInstance 聚合（按根因归并） | v0.10-B |
| **Savings** | ❌ 无 | **新增**：remedy catalog + potential / validated / realized 三档 | v0.10-B/C |
| **Settings** | 数据源 | 改名 + 升级：加隐私 / LLM 授权与预算开关 | v0.10-D |

**Token 日历归属**：归 **Overview**（与月度 KPI 同区，作为月度可视化），spec §5 Overview 段补一行：

> Overview 含月度 KPI 行（v0.9 已落地的 5 tile）+ Token 日历（日格 + 小时格）；日历是月度成本的可视化下钻，与月度数字同区域，避免用户在两个 tab 之间切。

**Findings tab 拆分路径**：v0.10-B 把 Findings 重命名为 Issues 并加 IssueInstance 聚合（按 `issue_instances` 表，§10.2.1）；v0.10-C 加 Savings tab 承接 `agent-vitals plan` 命令输出（§11.11）。Findings 名称在 v0.10-B 之后不再使用，DSH audit tab 的 `behaviorFindings` projection 同步改名为 `issueFindings`。

**为什么**：6 tab 与当前 5 tab 的对应关系不写明会让 v0.10-A 实施时返工——Tauri 工作台 HTML 是单一渲染端，新增 Traces tab 必须在 layout 上预留位置；Token 日历归属 Overview 还是 Sessions 不明文会导致它在两个版本里被两边都改一次。

---

### 11.6 §6 Runtime 目录增量：补 v0.9/v0.9.1 基座层

**改哪里**：`§6` Runtime 与目录增量段落。

**改成什么**：在 §6 现有目录树之前加一段「基座层（v0.9 / v0.9.1 已落地，v0.10 不重写）」：

```text
# v0.9 / v0.9.1 已落地基座（v0.10 只派生，不重写）
crates/agent-vitals-data/src/
  store.rs                  # UsageFact JSONL writer + retention (13 个月 + undated 保留)
  authority.rs              # SQLite 权威库（schema v2；v0.10 bump 到 v3 见 §10）
  sql_sync.rs               # JSONL ↔ SQLite 同步（含 sync_runs sweep）
  authority_query.rs        # sessions_in_window / session_facts_timeline / session_cost_minor (Q04)
  billing.rs                # BillingContext + 4 档成本口径（§6.7）

crates/agent-vitals-runtime/src/
  mcp/                      # sessions_search / session_detail / session_ref（Q04 已落 main）
  authority/                # AuthorityHandle / 健康检查
  ingest_service.rs         # 三执行环境 ingest 入口
  lease/                    # writer lease（O_EXCL + atomic rename）

crates/agent-vitals-domain/src/
  contracts/source_identity.rs   # fnv1a64_hex fact_id / source_event_id
  contracts/usage_fact.rs        # UsageFact schema
  contracts/canonical.rs         # CanonicalSession（v0.10 TraceGraph builder 的输入源，§11.8）
  domain/cost/                   # priced_token / priced_day / MoneyMinor 聚合
  domain/usage/                  # token_by_model / token_by_date_model
  domain/evidence/               # Coverage + Signal::Usage::unmetered
  domain/behavior/               # SV601-SV614 纯函数（v0.10-A 升级为 IssueInstance 聚合入口）
  domain/plan/                   # v0.9 plan 命令 ranked 规则（v0.10-B remedy catalog 种子，§11.11）

crates/agent-vitals-harnesses/src/harnesses/<h>/sessions/
  # claude_code / codex / dsh 的 evidence.rs（canonical_session producer）
```

§6 现有目录树作为「v0.10 派生层 / 服务层」列在基座层之后。

**为什么**：spec §6 只列了 v0.10 新增目录会让读 spec 的人误以为这些模块是 v0.10 才有的——v0.9 / v0.9.1 已经把这些模块落到 main，且 `mcp::dispatch` 已经是一等公民（Q04 + 收口 PR #1–#5）。补基座层避免 spec 与代码脱节，并明确「TraceGraph builder 是 CanonicalSession 派生层」的事实输入源。

---

### 11.7 §7 v0.10-A 门槛：从 CanonicalSession 派生

**改哪里**：`§7` v0.10-A 段门槛。

**改成什么**：把 `**门槛：**至少三执行环境可生成确定性图；缺失关系不伪造。` 替换为：

> **门槛：**
> 1. 三执行环境从 `CanonicalSession` 派生确定性图（**不重读 raw event**），输入源唯一；
> 2. 缺失关系（parent / time / status）显式在 `TraceCoverage` 里标 `unavailable`，**不得补造**；
> 3. CLI / Tauri IPC / HTML 三处对同一 `session_ref` 输出的 TraceGraph 节点列表 byte-identical（由 `tests/test_cli_matrix.py::both()` + `tests/mcp_smoke.py` S6 块守，模式同 S5 sessions 三消费面 parity）；
> 4. TraceGraph memo 60s TTL（`Arc<RwLock<HashMap<session_ref, TraceGraph>>>`，按 home 键控），失效条件 = session_facts `MAX(fact_id) WHERE session_key=?` 计数器对比。

**为什么**：v0.9 已经做了 claude/codex/dsh 三执行环境 wire → `CanonicalSession`（`agent-vitals-domain/src/contracts/canonical.rs` + `crates/agent-vitals-harnesses/src/harnesses/<h>/sessions/`）。TraceGraph builder **必须从 CanonicalSession 派生**，否则会出现 v0.9.1 plan §1 列的同样问题——CLI / Tauri / HTML 三处对同一份数据有三份不同形状，TraceGraph builder 也会出现同样风险。

---

### 11.8 §8 明确不做：SQLite 不属于「第二状态库」

**改哪里**：`§8` 第 7 条 `不把 DuckDB 引入为运行时第二状态库`。

**改成什么**：

> **不引入新的运行时状态库**（除 v0.9.1 已落地的 SQLite 权威库外）；TraceGraph builder 不维护独立持久层，所有派生数据从 UsageFact 重算（memo 仅在内存层；§10.3 + §11.7）。

**为什么**：v0.9.1 已经引入 SQLite 作为 SQL 权威库（schema v2 → v0.10 bump 到 v3，见 §10）。spec §8 这条原文可能被误读为「要清掉 SQLite」——v0.10 的事实来源就是 SQLite 权威库，不能误删。

---

### 11.9 §9 DoD 第 7 条：instance_fingerprint 派生规则

**改哪里**：`§9` 第 7 条。

**改成什么**：

> 7. 同一输入重放不重复写 issue、action 或 outcome；幂等键字段为 `instance_fingerprint`，派生规则：`fnv1a64_hex(source_identity::canonical_json(UsageFact[]))`——与 v0.9 `UsageFact.fact_id` / `source_event_id` 同 `canonical_json` 序列化路径；同一输入必得同一指纹，重放同指纹同状态（`issue_instances.UNIQUE(harness, instance_fingerprint, status)` / `outcome_measurements.UNIQUE(issue_id, metric_id, savings_kind, baseline_window_start_ms, observed_window_start_ms)`）不重写。

**为什么**：v0.9.1 `sync_facts` 已经按 `(harness, source_event_id, fact_id)` 去重，writer lease O_EXCL；spec §9 第 7 条原文未指定幂等键派生方式，无法在 review 时检查具体实现是否一致。明确派生规则后，schema 的 `UNIQUE` constraint（§10.2.1 / §10.2.5）与代码层的去重逻辑可在同一 PR 内同步落地。

---

### 11.10 §3 评估策略：补充「程序评估优先」的 v0.9 锚点

**改哪里**：`§3` 第 1 条「程序评估优先」。

**改成什么**：在「程序评估优先：重复尝试…」那段后加：

> **v0.9 锚点**：v0.9 已实现的 SV601-SV614 规则（`crates/agent-vitals-domain/src/domain/behavior/` + `packages/agent-vitals-python/agent_vitals/agent/behavior.py` + wasm `audit_events`）是 v0.10 程序评估的种子；v0.10-A 升级为 IssueInstance 聚合（按 `issue_instances` 表聚合，§10.2.1），不重写规则。**Python ↔ Rust ↔ wasm 三方锁步继续**（CLAUDE.md 锁步层）；differential gate `AGENT_VITALS_BIN` 守 byte-identical，新增任何 evaluator 必须同构三份。

**为什么**：spec §3 把评估策略提到抽象层，不提 v0.9 已落地的 SV 规则会让评估策略看起来是空话——v0.9 已经有 14 条 SV 规则（SV601-SV614），v0.10 应该直接复用 + 升级。

---

### 11.11 §2.2 / §4：v0.9 `plan` 命令作为 remedy 种子

**改哪里**：`§2.2` 末尾（接 `IssueInstance` 段后）+ `§4`「问题到方案」段。

**改成什么**：

`§2.2` 末尾加：

> **v0.9 `plan` 命令是 remedy catalog 的初始种子**：v0.9 `agent-vitals plan` 输出 ranked savings 列表（zombie / oversized / trim-description / shadow），由 `agent_vitals_domain::plan::rank` 纯函数实现（CLAUDE.md「v0.9 plan 命令」段落）；v0.10-B 不重写排名规则，**直接复用**为 `remedy_definitions` catalog 的种子数据。`remedy_definitions.applicable_issue_types` 字段填对应 issue_type id。

`§4` 第 1 条「至少一个可执行、低风险的 remedy」后加：

> v0.10-B 起，remedy 候选必须先在 `remedy_definitions` 表里有 catalog 条目；ranked 顺序继承 `plan::rank` 纯函数（v0.9 已实现），新加 remedy 时同构实现 Python ↔ Rust ↔ wasm 三方锁步。

**为什么**：v0.9 `plan` 命令已经是 remedy 雏形，但 spec §2.2 / §4 都未提它的存在；如果 v0.10-B 完全新建 remedy catalog 排名逻辑，等于把 v0.9 已经测试过的纯函数推翻重写——v0.9 → v0.10 应该走"派生 + 升级"而非"重建"。

---

### 11.12 调整清单总览（便于 review 时逐条核对）

| # | 调整位置 | 落地阶段 | 与 §10 schema 增量关系 |
|---|---|---|---|
| 11.1 | §2.1 TraceGraph 字段 | v0.10-A | 独立（spec 字段定义） |
| 11.2 | §2.2 MetricDefinition 派生关系 | v0.10-A | 独立（约束段落） |
| 11.3 | §2.2 OutcomeMeasurement 4 档口径映射 | v0.10-C | 关联 §10.2.5 savings_kind CHECK |
| 11.4 | §3 LLM redaction pipeline | v0.10-D | 关联 §10.2.6 llm_evaluator_cache |
| 11.5 | §5 产品界面 6 tab ↔ 5 tab | v0.10-A 起 | 独立（UI 文档） |
| 11.6 | §6 Runtime 目录基座层 | v0.10-A 起步 | 独立（参考文档） |
| 11.7 | §7 v0.10-A 门槛 | v0.10-A | 独立（实施门槛） |
| 11.8 | §8 SQLite 不属第二状态库 | v0.10-A 起步 | 关联 §10 schema bump |
| 11.9 | §9 DoD 第 7 条幂等键 | v0.10-B 起步 | 关联 §10.2.1 / §10.2.5 UNIQUE constraint |
| 11.10 | §3 SV 规则锚点 | v0.10-A | 独立（评估策略约束） |
| 11.11 | §2.2/§4 plan 命令种子 | v0.10-B | 独立（remedy catalog 种子） |

**合并建议**：11.1 / 11.7 / 11.8 三条与 v0.10-A 实施门槛强相关，建议合并到 v0.10-A 的首个 PR；11.5 / 11.6 与 v0.10-A 起步相关；其余按 v0.10-B/C/D 阶段合并。
