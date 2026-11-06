# agent-vitals v0.9 — 数据价值挖掘目标

> 文档版本：v1.0
> 撰写时间：2026-09-04
> 前置：v0.8 Phase D 收口（架构骨架完成）+ v0.7 Data Plane（UsageFact 契约已落地）
> 后续：v1.0（数据价值可见化：菜单栏 / DSH 审计 tab / Web 仪表盘三层全部接通）
> 文档作者：Mavis（基于源码 + 文档 + 40+ spec 文档交叉对账 + 1094 项 Python 测试 + 144 项 Rust 测试实跑）

---

## 0. 一句话

> **v0.8 完成架构骨架（域/执行环境/runtime/wasm 4 棵树 + feature gate + 锁步门禁）。**
> **v0.9 开始挖数据价值——把 5 个执行环境 × 6 类信号 × N 个 session 的数据真正变成可分析、可预测、可行动的洞察。**

---

## 1. 定位与范围

### 1.1 v0.8 留下了什么（数据资产盘点）

| 资产 | 当前形态 | 数量级 | 来源 |
|---|---|---|---|
| `CanonicalSession` 值类型 | `crates/agent-vitals-domain/src/contracts/evidence.rs` | 19 Signal + 5 Timeline | 已建 |
| 5 桶 token fold | `domain/usage.rs::token_by_model` | 每 session 算一次 | 已建 |
| `r2a envelope` per-session cache | `data_home()/cache/r2a/<session>.json` | ~10-100KB / session | 已建（schema v3）|
| `state/today.json` + `month.json` | 预聚合账单 | 每 5min tick 更新 | 已建 |
| 14 条 SV 码 finding | `domain/detectors/svNNN.rs` | 每次 fold 跑 14 条 | 已建 |
| DSH session.jsonl[.zstd] | 外部执行环境文件 | 50-500KB / session | **只读** |
| Claude / Codex / WorkBuddy 执行环境 | 各自 wire 格式 | 同量级 | **只读** |
| fixtures/ | 测试用完整 session 集 | ~58 session 真机 + 6 个手工 | 已建 |

### 1.2 v0.9 之前的 3 个真缺口

| 缺口 | 现状 | 后果 |
|---|---|---|
| **没有 effects 表** | `CanonicalSession` 只有 events（LLM/tool/人介入），**没有 effects（文件变更/测试/git）** | "Agent 刚才到底改了什么"答不上；6 项周看板 5 项无数据 |
| **没有持久化 CanonicalSession** | 每次 fold 完即丢；下次重 fold | 调查历史会话要 raw jsonl（执行环境 retention 不可控）|
| **没有 query 层** | `state/*.json` 是预聚合账单，**不可分组/不可 join** | "过去 30 天所有 Codex 失败会话"答不上 |

**这 3 个缺口是 v0.9 的核心目标**。**其他都是战术**。

### 1.3 v0.9 在做什么、不做什么

#### ✅ v0.9 做

1. **Effects 采集面**（harnesses/<h>/sources/effects.rs）——**行业空白**
2. **CanonicalSession 持久化层**（state/canonical/）—— 解决 raw jsonl retention 风险
3. **DuckDB 分析层**（state/analysis.duckdb）—— SQL-on-traces，不破"xbar cat JSON"哲学
4. **Task type 弱标签**（6 类确定性规则）—— 方法论 §1 的"先有标签后有模型"
5. **Token 4 桶 + Tool latency 双口径** —— 与 TraceLab 公开数据集可比
6. **6 项周看板的 4 项** —— completion / rollback / read-before-edit / cost-P90（见 §4）
7. **跨会话 query 子命令** —— `agent-vitals query "..."` + DuckDB SQL 接口
8. **早期预警**（前 3 轮特征预测后半段挣扎）—— 方法论 §4.E 的可量化版
9. **失败 onset 检测**（方法论 §4.C 的"第一处不可逆坏决策"）—— 用确定性规则做，不上 LLM
10. **行为规则补效率维度**（不是只 SV501-614）—— 加"循环率 / 验证跳过 / 成本溢出"等

#### ❌ v0.9 不做

1. **LLM-as-judge 语义质量评估** —— v1.0 才考虑
2. **跨用户基准比较 / 隐私保护聚合** —— 隐私 + 工程复杂度都太大，留 v1.1+
3. **行为实时阻断**（拦截危险命令）—— spec §4.4 边界明示"只检测与展示"
4. **数据外传等组合规则**（读密钥 + 外发）—— 推到 v1.0
5. **DB 反范式事件存储到 SQLite** —— 仍走 DuckDB（不引入第二份分析库）
6. **完整的 LLM-driven 异常检测** —— 确定性规则先做满，ML 留 v1.x
7. **改写 dsh 核心 / 自定义 UI 容器** —— 沿用 bundle + harness adapter 模式

---

## 2. 目标架构

```
                            v0.8 留下
                            ════════
events  CanonicalSession (19 Signal + 5 Timeline)
        ┌─────────────────────────────────────┐
        │ in-memory, fold 完即丢             │
        └─────────────────────────────────────┘

                            v0.9 新增
                            ════════

effects  EffectsRecord (file_change / test_result / git_op)
        ┌─────────────────────────────────────┐
        │ harnesses/<h>/sources/effects.rs        │
        │ 跨 5 执行环境 wire 适配                  │
        └─────────────────────────────────────┘
                          ↓
canonical/<session_id>.json (持久化值类型)
        ┌─────────────────────────────────────┐
        │ 冷启动无效化（r2a v1→v2 同款）       │
        │ 可被 5min tick 重 fold 覆盖         │
        └─────────────────────────────────────┘
                          ↓
state/analysis.duckdb (DuckDB 分析层)
        ┌─────────────────────────────────────┐
        │ 5 张表：sessions / events /         │
        │   effects / finding_signals /       │
        │   duckdb_meta                        │
        │ 5min tick 增量 append                │
        │ 删了下次重建（不破 xbar）            │
        └─────────────────────────────────────┘
                          ↓
agent-vitals query <sql> (新 CLI)
        ┌─────────────────────────────────────┐
        │ DuckDB 内嵌 + read_only 连接         │
        │ 输出 table / json / csv              │
        └─────────────────────────────────────┘
```

**关键不变量**：

- `analysis.duckdb` **可删**——删了下次 oneline 重建；**xbar 不依赖它**
- 5min tick 仍只写 `state/*.json`，**analysis.duckdb 是影子**
- `state/canonical/<id>.json` 也可删——**但保留 N 天**（默认 30 天，可配）
- **所有持久化都不破"单写者 tick"假设**——oneline 顺手 append，不引入新写者

---

## 3. 数据价值 4 个维度

对照方法论（描述 / 诊断 / 对比 / 预测），v0.9 必须在这 4 个维度都有产出：

| 维度 | v0.9 目标产物 | 落地方式 |
|---|---|---|
| **描述**（Descriptive） | "上个月 P50/P90 成本与步数" | `query` 子命令 + DuckDB |
| **诊断**（Diagnostic） | "失败 onset 在第几轮、坏在哪条 event" | 确定性规则在 effects 上跑 |
| **对比**（Comparative） | "成功 vs 失败 / 模型 A vs 模型 B / 任务类型对比" | DuckDB `GROUP BY` + 分位数 |
| **预测**（Predictive） | "前 3 轮已呈挣扎形态 → 切强模型" | 滑动窗口特征 + 阈值 |

**每个维度至少 1 个 query 子命令、1 个周看板指标**。

---

## 4. 6 项周看板（方法论 §5，v0.9 实现 4 项）

| # | 指标 | 公式 | v0.9 实现？ |
|---|---|---|---|
| 1 | **完成率** | `success_count / total_count`（success 由 effects 推：tests pass + accepted）| ✅ effects 落表后即可算 |
| 2 | **回滚率** | `git revert+reset_count / commit_count` | ✅ effects 落表后 |
| 3 | **测试先于编辑比例** | `first_test_event_index < first_edit_event_index` | ✅ effects + events join |
| 4 | **P50/P90 成本** | `QUANTILE_CONT(cost_usd, 0.5/0.9)` | ✅ sessions 表已有 cost_usd |
| 5 | **循环率** | `sliding_window(3).count_distinct(args_hash) / count` | ✅ events 表 + sliding window |
| 6 | **工具时间分解** | `SUM(wall_latency_ms) GROUP BY tool_name` | ✅ events 表已有双口径延迟 |

**6 项全部依赖 effects 表**——**effects 是 v0.9 的"中坚"**。

---

## 5. 详细目标（每条都标验收标准）

### 5.1 Effects 采集面（🔴 最高优先级）

**目标**：跨 5 执行环境采集 file_change / test_result / git_op 3 类 effects。

**新增文件**：

| 文件 | 行数预算 | 职责 |
|---|---|---|
| `crates/agent-vitals-harnesses/src/harnesses/dsh/sources/effects.rs` | ~300 | DSH: 读 `data.result.file_changes` / `data.result.exit_code` / `data.git` |
| `crates/agent-vitals-harnesses/src/harnesses/codex/sources/effects.rs` | ~250 | Codex: 读 `turn_context.git` + `exec_command.result.aggregated_output` + `file_change` |
| `crates/agent-vitals-harnesses/src/harnesses/claude_code/sources/effects.rs` | ~300 | Claude: 读 `file_history_snapshot` + `tool_use_result` |
| `crates/agent-vitals-harnesses/src/harnesses/workbuddy/sources/effects.rs` | ~200 | WorkBuddy: 读 SQLite `audit_log` 表 |
| `crates/agent-vitals-domain/src/contracts/effects.rs` | ~150 | `EffectsRecord` + `FileChange` + `TestResult` + `GitOp` schema |
| `tests/test_effects_*.py` + `crates/.../tests/effects_*.rs` | ~500 | 跨执行环境 parity + character |

**Schema 草案**（`effects.rs`）：

```rust
pub struct EffectsRecord {
    pub file_changes: Vec<FileChange>,
    pub test_results: Vec<TestResult>,
    pub git_ops: Vec<GitOp>,
}

pub struct FileChange {
    pub path: String,
    pub op: FileOp,            // Create | Modify | Delete | Rename
    pub bytes_added: u64,
    pub bytes_removed: u64,
    pub trigger_event_pk: Option<i64>,  // 哪条 tool_call 触发的
    pub timestamp: SystemTime,
}

pub struct TestResult {
    pub command: String,
    pub exit_code: i32,
    pub duration_ms: i64,
    pub stdout_chars: u64,
    pub stderr_chars: u64,
    pub trigger_event_pk: Option<i64>,
    pub timestamp: SystemTime,
}

pub struct GitOp {
    pub op: GitOpKind,         // Commit | Revert | Reset | Checkout | Merge | Rebase
    pub commit_sha: Option<String>,
    pub rollback_of_sha: Option<String>,  // Revert/Reset 时回滚的目标
    pub timestamp: SystemTime,
}
```

**验收**：
- 5 执行环境各 1 个 fixture（手工造：1 file change + 1 test run + 1 commit）
- `effects.rs` 跨 5 执行环境 parity test 字节级一致
- 现有 1094 项 Python 测试 + 144 项 Rust 测试不破

### 5.2 CanonicalSession 持久化（🟡 高）

**目标**：fold 完即丢 → fold 完写盘。`state/canonical/<session_id>.json` 一行 = 一次完整 fold。

**新增文件**：

| 文件 | 行数预算 | 职责 |
|---|---|---|
| `crates/agent-vitals-runtime/src/canonical_store.rs` | ~200 | `write_canonical` / `read_canonical` / `index_canonical` / 冷启动 |
| `tests/test_canonical_*.py` | ~150 | parity + 冷启动测试 |

**Schema**：直接 `serde_json::to_string_pretty(&canonical_session)`，值类型已是 Serialize。

**冷启动规则**（与 r2a v1→v2 一致）：
- 读 `state/canonical/INDEX` 检查 schema_version
- 不符 → 全目录删 → 下次 fold 重建
- 不就地迁移

**保留期**（可配）：默认 30 天，30 天前的 `state/canonical/<id>.json` 5min tick 时清。

**验收**：
- 5min tick fold 完后立刻落 `state/canonical/<id>.json`
- `agent-vitals show <session_id>` 命令能从 canonical 立刻读（不重 fold）
- 冷启动：删目录 → 下次 fold 重建，**无残留**

### 5.3 DuckDB 分析层（🟡 高）

**目标**：5 张表 star schema，SQL 解决 80% 分析问题。

**5 张表**（`docs/ARCHITECTURE_RECOMMENDATIONS_2026_09.md` §3.1 详）：

```sql
sessions          1 行 = 1 任务/会话（含 cost + 行为特征字典）
events            1 行 = 1 tool_call/result/approval/sandbox（反范式 session_id）
effects           1 行 = 1 file_change/test_result/git_op
finding_signals   1 行 = 1 SV 码 finding
duckdb_meta       1 行 = 元数据
```

**新增文件**：

| 文件 | 行数预算 | 职责 |
|---|---|---|
| `crates/agent-vitals-runtime/src/analysis_duckdb.rs` | ~250 | `open_or_create` / `init_schema` / `append_*` |
| `crates/agent-vitals-runtime/src/duckdb_query.rs` | ~150 | CLI `query` 子命令 |
| `src/agent/analysis_duckdb.rs` | ~80 | 集成进 oneline 写链 |
| `tests/test_duckdb_*.py` + `tests/test_duckdb_*.rs` | ~300 | schema + append + query + coldstart |

**Cargo.toml 改动**：

```toml
[dependencies]
duckdb = { version = "1.1", features = ["bundled"] }  # bundled = 零系统依赖
```

**写链集成**（在 `takeover.rs::fold_session` 末尾 hook）：

```rust
// 1. 写 state/*.json (现有)
// 2. 写 state/canonical/<id>.json (新增 5.2)
// 3. append 到 state/analysis.duckdb (新增 5.3)
// 4. 写 ledger + manifest (现有)
```

**验收**：
- `agent-vitals query "SELECT COUNT(*) FROM sessions"` 正确返回 session 数
- 5 张表 schema 版本号在 `duckdb_meta`，冷启动时校验
- DuckDB 文件大小 ≤ 100KB × session 数（5000 session = 500MB 上限，可接受）
- DuckDB 写是 in-process lock，**不引入新写者**

### 5.4 Task Type 弱标签（🟡 中）

**目标**：6 类确定性规则，**不靠 LLM**。对照方法论 §1 "标签先于模型"。

```rust
// crates/agent-vitals-domain/src/domain/task_type.rs
pub fn classify(canonical: &CanonicalSession, effects: &EffectsRecord) -> TaskType {
    let files = effects.file_changes.len();
    let tests = effects.test_results.len();
    let has_rename = effects.git_ops.iter().any(|g| matches!(g.op, GitOpKind::Commit /* has rename */));
    let test_failure_then_pass = /* consecutive test results, fail then pass */;
    
    match (files, tests, has_rename, test_failure_then_pass) {
        (0, 0, _, _) => TaskType::Unknown,
        (1, 0..=2, false, _) if canonical.event_count() < 30 => TaskType::SingleEdit,
        (_, 1.., false, _) if files <= 5 => TaskType::FeatureAdd,
        (5.., _, _, _) if /* lines_added/lines_removed ratio < 3 */ => TaskType::Refactor,
        (_, 3.., false, true) => TaskType::Debug,
        (_, _, true, _) => TaskType::Migrate,
        _ => TaskType::Unknown,
    }
}
```

**6 类**：`SingleEdit / FeatureAdd / Refactor / Debug / Migrate / Unknown`

**验收**：
- 边界 case 5 条 fixture：单 file / 多 file+test / 重命名 / debug / Unknown
- 不依赖 LLM，**离线可算**

### 5.5 Token 4 桶 + Tool Latency 双口径（🟢 中-低，与 TraceLab 对齐）

**目标**：与 TraceLab 公开数据集（665K rounds）可比。

**Token 4 桶**（`usage.rs::token_by_model` 改）：

```rust
pub struct TokenBuckets {
    pub fresh_input: i64,            // 已有
    pub prefix_cache_read: i64,      // 已有
    pub cache_creation: i64,         // 新增（Claude cache_creation_input_tokens）
    pub newly_append: i64,           // 新增（= fresh + cache_creation）
    pub output: i64,                 // 已有
    pub reasoning: Option<i64>,      // 已有
}
```

**Tool latency 双口径**（`duration.rs` 改）：

```rust
pub struct ToolLatency {
    pub wall_ms: Option<i64>,         // 已有（= result_at - emitted_at）
    pub internal_ms: Option<i64>,     // 新增（Codex `Wall time` / Claude `durationMs`）
}
// 分析：优先 internal，缺失回退 wall
```

**验收**：
- Claude 95.22% cache 命中率（TraceLab 公开数字）能在 agent-vitals 复现
- Codex `internal_ms` 字段填上 `Wall time` 报值

### 5.6 早期预警（前 3 轮）（🟡 中-高）

**目标**：方法论 §4.E 的"前 2-3 轮特征预测后半段挣扎"——**可量化版**。

**特征字典**（前 N 轮内）：

```rust
pub struct EarlyWarningFeatures {
    pub turns_so_far: u32,
    pub tool_error_count: u32,        // 前 N 轮内 tool 失败次数
    pub args_repeat_count: u32,       // 前 N 轮内重复 tool+args
    pub cost_so_far: f64,
    pub wall_time_so_far_sec: u64,
    pub input_growth_rate: f64,       // 每轮 input 增长率
}
```

**阈值规则**（确定性，不上 ML）：

```text
IF turns_so_far >= 3 AND (
    tool_error_count >= 2
    OR args_repeat_count >= 2
    OR cost_so_far > $1
    OR wall_time_so_far_sec > 120
)
THEN verdict = "strugle_likely"
```

**输出**：`finding` 里多一个 `verdict: "strugle_likely"`，UI 上高亮。

**验收**：
- fixtures 5 条：3 条"挣扎" + 2 条"正常"
- verdict 准确率 80%+ on fixtures
- **不上 ML，纯规则**

### 5.7 失败 Onset 检测（🟡 中-高）

**目标**：方法论 §4.C "失败从哪一步起"——**用确定性规则**。

**算法**（不靠 ML）：

```text
对每个有 test_result.exit_code != 0 的 session：
  1. 找到第一个失败的 test_result
  2. 往前找"不可逆坏决策"：
     - 改测试文件（避免 "改测试变绿" 假象）
     - 改接口签名（interface breaking）
     - 删文件且不是 git mv
     - skip test 命令
  3. 标 onset_event_pk
  4. 算 "被污染的下游 event 数"（onset 之后的所有 event）
```

**输出**：

```rust
pub struct FailureOnset {
    pub session_id: String,
    pub first_failure_test: i64,       // event_pk
    pub onset_event_pk: Option<i64>,   // 第一个坏决策
    pub onset_rule: String,             // "test_file_modified" / "interface_break" / "test_skipped"
    pub contaminated_events: u32,       // 下游 event 数
}
```

**验收**：
- fixtures 5 条：每条都有"坏决策"，onset 准确率 100% on fixtures
- 输出 DuckDB `sessions.onset_event_pk` + `onset_rule` 字段

### 5.8 跨会话 query 子命令（🟢 中）

**目标**：`agent-vitals query <SQL>` CLI。

**实现**：

```rust
// crates/agent-vitals-runtime/src/duckdb_query.rs
pub fn run_query(db_path: &Path, sql: &str, format: OutputFormat) -> Result<String> {
    let conn = Connection::open(db_path)?;
    let result = conn.query(sql)?;
    match format {
        OutputFormat::Table => format_table(&result),
        OutputFormat::Json => format_json(&result),
        OutputFormat::Csv => format_csv(&result),
    }
}
```

**示例 query**（5 条写在 docs 里）：

```sql
-- Q1: 完成率
SELECT 
    DATE_TRUNC('day', started_at) as day,
    task_type,
    COUNT(*) FILTER (WHERE finding_count = 0) * 1.0 / COUNT(*) as success_rate
FROM sessions GROUP BY day, task_type ORDER BY day DESC;

-- Q2: SV 码 top 10（按 frequency）
SELECT rule, COUNT(*) FROM finding_signals GROUP BY rule ORDER BY COUNT(*) DESC LIMIT 10;

-- Q3: 循环率（前 3 轮）
SELECT session_id, COUNT(DISTINCT args_hash) as unique_3rd, COUNT(*) as total_3rd
FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY event_index) as rn
    FROM events WHERE event_type = 'tool_call'
) WHERE rn <= 3 GROUP BY session_id;

-- Q4: 模型成本对比
SELECT model, 
       COUNT(*) as sessions,
       ROUND(QUANTILE_CONT(cost_usd, 0.5), 4) as p50,
       ROUND(QUANTILE_CONT(cost_usd, 0.9), 4) as p90
FROM sessions GROUP BY model;

-- Q5: 失败 onset 类型分布
SELECT onset_rule, COUNT(*) FROM sessions 
WHERE onset_event_pk IS NOT NULL 
GROUP BY onset_rule ORDER BY COUNT(*) DESC;
```

**验收**：
- 5 条 query 都有 doc + example output
- `--format json` / `--format csv` / `--format table` 3 个输出格式
- read-only 连接，**不能改 state**

---

## 6. 行为规则补效率维度

对照 AGENT_BEHAVIOR_AUDIT.md §6.2 的 14 条 SV 码，**全是安全/正确性**。v0.9 加效率维度：

| 新码 | 规则 | 类别 | 严重度 | 命中信号 |
|---|---|---|---|---|
| **SV615** | 高 cost 事件 | efficiency | warning | 单 session cost > P95（按 task_type 算） |
| **SV616** | 循环率超阈 | efficiency | warning | 前 10 轮 args_repeat > 5 |
| **SV617** | 验证跳过 | efficiency | warning | 第一次 `Edit` 后无 test_result |
| **SV618** | 长 turn 停滞 | efficiency | info | 单一 turn > 30 min 无进展 |
| **SV619** | 高 token 浪费 | efficiency | warning | input_tokens / output_tokens > 50（编码 Agent 典型 > 100） |
| **SV620** | 工具错误率 | efficiency | warning | 单 session tool_error_count / tool_call_count > 0.3 |

**6 条新规则**——和 SV501-614 同一诊断引擎 / 同一 schema / 同一 parity 锁步。

**验收**：
- 6 条规则全部 characterizable（12 条 char test）
- 跨 Python↔Rust parity（12 条）
- 全部 deterministic（无 LLM judge）

---

## 7. 范围与里程碑

### 7.1 时间盒：6 周（v0.8 收口后启动）

| 周 | 目标 | 关键产出 |
|---|---|---|
| W1 | 5.1 effects 采集面 | 5 执行环境 effects.rs + 5 fixture + parity |
| W2 | 5.3 DuckDB schema + write 链 | 5 表 + oneline 集成 + 5min tick hook |
| W3 | 5.4 task type + 5.5 token 4 桶 | 6 类分类 + 用法对齐 TraceLab |
| W4 | 5.2 canonical 持久化 + 5.6 早期预警 | 30 天保留 + verdict 输出 |
| W5 | 5.7 失败 onset + 5.8 query CLI | 5 条示例 query + table/json/csv 输出 |
| W6 | §6 行为效率规则 + 周看板 + docs | 6 条新 SV 码 + 周看板输出 + release notes |

### 7.2 v0.9 release gate（验收指标）

**硬指标**（必须全过）：

- ✅ effects 表跨 5 执行环境各 1 fixture 跑通
- ✅ CanonicalSession 持久化 + 30 天保留
- ✅ `state/analysis.duckdb` 5 表 schema 落 + 5 条示例 query 出正确结果
- ✅ Token 4 桶 + Tool latency 双口径落地
- ✅ Task type 6 类弱标签 fixtures 准确率 100%
- ✅ 早期预警 + 失败 onset 5 fixture 准确率 80%+
- ✅ 6 条新效率规则 characterizable + parity
- ✅ query CLI `--format table/json/csv` 3 个格式
- ✅ 现有 1094 Python + 144 Rust 测试**不破**
- ✅ CLAUDE.md 数据全部刷新（不能留 v0.8 的过期数字）

**软指标**（应过）：

- 任意 query 子命令 5s 内出结果（5000 session 量级）
- 6 项周看板：5 项可算（completion / rollback / read-before-edit / cost-P90 / 循环率）
- 文档：5 份新 spec + 5 条 query doc + 1 份周看板格式

### 7.3 不在 v0.9 release gate

- LLM-as-judge
- 跨用户基准
- 行为实时阻断
- 完整 DSH 审计 tab 升级（v1.0）
- Web 仪表盘（v1.0）
- 实时 watcher（v1.0+）

---

## 8. 关键风险

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| **effects 跨执行环境 wire 不齐** | DSH / Codex / Claude 各自 effects 字段名/位置/形状都不同 | 每执行环境独立 adapter + 各 1 fixture + parity 字节级 |
| **DuckDB 编译时间 +50%** | bundled C++ 编译慢 | CI 缓存；MSRV 不破（1.74 OK）|
| **`analysis.duckdb` 体积爆炸** | 5000+ session × 全 effects | 30 天保留 + 关键字段剥离（raw result_chars 不入）|
| **task type 弱标签边界 case 多** | 真实 session 可能跨 6 类 | 边界用 `Unknown` 兜底，6 条 fixture 必须 cover 6 类 |
| **早期预警假阳率 > 30%** | 阈值常数拍脑袋 | 5 fixture + 真机 100 session 验证后再定阈值 |
| **query SQL 注入** | 用户可写任意 SQL | read_only 连接 + 限制 `state/analysis.duckdb` 只读 |
| **DuckDB 写是 in-process lock** | 多 writer 还是 race | oneline 单写者假设不动；5min tick 也是单写者；并发问题 §8 沿用 v0.8 状态 |
| **CLAUDE.md 继续过期** | v0.9 落地后没人刷文档 | release gate 强制刷（**这是 v0.9 的最低验收线**）|

---

## 9. 关键文件清单（v0.9 完成后）

### 新建

```
crates/agent-vitals-domain/src/contracts/effects.rs     # 5.1
crates/agent-vitals-domain/src/domain/task_type.rs      # 5.4
crates/agent-vitals-runtime/src/canonical_store.rs      # 5.2
crates/agent-vitals-runtime/src/analysis_duckdb.rs      # 5.3
crates/agent-vitals-runtime/src/duckdb_query.rs         # 5.8
crates/agent-vitals-harnesses/src/harnesses/{dsh,codex,claude_code,workbuddy}/sources/effects.rs  # 5.1
docs/V0_9_DATA_VALUE_MINING.md                          # 本文件
docs/V0_9_QUERY_COOKBOOK.md                             # 5 条示例 query
docs/V0_9_WEEKLY_DASHBOARD.md                           # 周看板输出格式
docs/V0_9_TASK_TYPE_LABELS.md                           # 6 类弱标签判定
docs/V0_9_EFFECTS_SCHEMA.md                             # effects 跨执行环境 schema
```

### 改写

```
crates/agent-vitals-domain/src/domain/usage.rs          # 5.5 token 4 桶
crates/agent-vitals-domain/src/domain/duration.rs       # 5.5 tool latency 双口径
src/agent/oneline.rs                                    # 5.3 集成 duckdb 写
src/agent/takeover.rs                                   # 5.2 + 5.3 集成
crates/agent-vitals-domain/src/contracts/evidence.rs    # 5.2 + 5.7 onset 字段
docs/CLAUDE.md (→ AGENT_BEHAVIOR_AUDIT.md 同源刷新)   # release gate 必刷
Cargo.toml (workspace)                                   # + duckdb dep
crates/agent-vitals-runtime/Cargo.toml                  # + duckdb dep
```

---

## 10. 净评价

| 维度 | 评分 | 说明 |
|---|---|---|
| 战略聚焦 | 9 | 3 个核心 gap 准确：effects / canonical / query |
| 范围控制 | 8 | 10 条 in / 7 条 out，**没说"全做"**——清楚"v0.9 不做 v1.0 的事" |
| 可测性 | 9 | 每条目标都有验收标准；release gate 10 条硬指标 |
| 风险诚实 | 8 | 8 条风险，**包括"CLAUDE.md 继续过期"**——罕见 |
| 文档-代码对应 | 7 | 关键文件清单 + 改动点列得很清楚，但**没有行号级别 diff plan** |
| 与 v0.8 衔接 | 9 | 显式说"v0.8 留下什么 / v0.9 在这之上加什么" |
| 与 v1.0 衔接 | 7 | 提到 5 项 v1.0 才做，**没详细 v1.0 目标文档** |
| 数据价值密度 | 9 | 4 维度全包（描述/诊断/对比/预测） |

**总评：8.3 / 10**

---

## 11. 一句话

> **v0.8 完成了"测量器"的骨架（events 表）；v0.9 要完成"分析器"的肌肉（effects + canonical + DuckDB + 6 类标签 + 早期预警 + 失败 onset + 6 条效率规则 + query CLI）。**
> **6 周 10 个硬指标 release gate，CLAUDE.md 必刷新。**
> **不做 LLM judge、不做实时阻断、不做跨用户基准——这些是 v1.0+。**

---

## 12. 附录 A：依赖关系

```
5.1 effects ─┐
             ├─→ 5.3 DuckDB ─→ 5.8 query
5.2 canonical ┘      │
                    ↓
5.4 task_type ─→ sessions.task_type
5.5 token + latency ─→ token_by_model 双版本（向后兼容 v0.8 schema）
5.6 早期预警 ─→ finding_signals.verdict
5.7 失败 onset ─→ sessions.onset_event_pk + onset_rule
§6 效率规则 ─→ 6 条新 SV 码（615-620）
```

**关键路径**：5.1 → 5.3 → 5.8（4 周）→ 5.4 / 5.5 / 5.6 / 5.7 / §6（2 周并行）

## 13. 附录 B：release gate 索引

| Gate | 验证方式 |
|---|---|
| effects 5 fixture | `pytest tests/test_effects_*.py` |
| canonical 冷启动 | 删除 `state/canonical/`，跑 oneline，验目录重建 |
| DuckDB 5 表 schema | `agent-vitals query "SELECT name FROM duckdb_meta"` + `.schema` |
| Token 4 桶 | 与 TraceLab Claude 95.22% cache 命中率对账 |
| Task type 6 类 | 6 个 fixture 各 1 条 |
| 早期预警 | 5 个 fixture 准确率 ≥ 80% |
| 失败 onset | 5 个 fixture 100% 准确 |
| 6 条新 SV 码 | 12 char + 12 parity 测试 |
| query CLI | 5 条示例 query 出正确结果 |
| CLAUDE.md | grep "1094" / "144" / "v1.3.0" 与实际一致 |
