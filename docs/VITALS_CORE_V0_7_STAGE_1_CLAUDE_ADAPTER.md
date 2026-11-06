# Vitals Core v0.7 —— Stage 1：Claude Adapter Emit UsageFact

> 状态：**已落地（v0.0.2，2026-09-03）**——本文定义 Claude Code 原始 session
> JSONL 到 `UsageFact` 的最小闭环。实施：`6fb8c99`（共享 observation extractor +
> golden 零漂移）+ `1e616c9`（Python emitter + `claude-usage-facts` CLI + 真实
> fixture）+ `c11d4b7`（Rust mirror + Python↔Rust byte-parity）+ `41b5225`
> （Stage 1c：补全 6 项 R1 契约缺口）。v0.7 完成记录见
> `VITALS_CORE_V0_7_DATA_PLANE_SPEC.md` §7。
>
> 关联：`VITALS_CORE_V0_7_ADAPTER_DECISIONS.md`、`VITALS_CORE_V0_7_DATA_PLANE_SPEC.md`、
> `crates/agent-vitals-core/src/contracts/usage_fact.rs`、`scripts/agent_vitals/agent/usage_fact.py`、
> `scripts/agent_vitals/agent/claude_cost.py`。

## 0. 当前结论

现有代码已经具备 `UsageFact` 跨语言契约、稳定 `fact_id` builder、迁移 walker，
也具备 Claude v0.6.x 成本 fold、真实 fixture 与回归测试。但 **Claude → UsageFact
Adapter 尚未实现**：当前仓库没有 Claude observation extractor、UsageFact emitter 或
对应诊断 CLI。

- 前置契约健康；
- 既有 Claude fold 健康；
- Stage 1 可以开工，但不能标记完成。

## 1. 目标与不动边界

### 1.1 Stage 1 目标

1. 每个有效 Claude `assistant` usage row 发射一个不可变 `UsageFact`；
2. Python/Rust 对同一行生成相同规范字段和 `fact_id`；
3. 同时返回 attempts 与 coverage，坏数据不能静默消失；
4. 既有 cost fold、ledger、archive、checkpoint 行为不变；
5. 提供只读诊断入口，以真实 JSONL 验证双实现一致性。

### 1.2 本阶段不做

- 不持久化 UsageFact，不升级 ledger/archive/fold/Store schema；
- 不把 Claude 私有字段引入 `agent-vitals-core`；
- 不改 baseline、归日、残差哨兵或成本算法；
- 不接入 Claude 之外的新执行环境。

## 2. 数据源与处理架构

### 2.1 唯一正确粒度

`claude-fold.json::tail_days` 是持续变化的 per-(day, model) 物化汇总，不是不可变事实。
同一天同一模型的多条消息必须保留为多个 UsageFact。发射点必须位于 `_apply_record`
聚合之前，直接消费原始 JSONL row。

| 方案 | 结论 |
|---|---|
| 从 `tail_days` 发射 | 禁止：粒度错误、身份不稳定、无法审计重复事件 |
| 在 fold schema 保存 raw metadata | 不采用：无必要扩大持久化契约 |
| 独立重读 JSONL | 可作降级方案，但必须复用同一 extractor |
| **共享 extractor，fold/emitter 同源** | **推荐：避免双套 wire-shape 解释** |

### 2.2 推荐接口

```python
# scripts/agent_vitals/agent/claude_usage_fact.py
def iter_claude_usage_observations(
    path: Path, *, machine_namespace: str, source_profile: str,
) -> Iterator[ClaudeUsageObservation]: ...

def claude_jsonl_to_usage_facts(
    path: Path, *, machine_namespace: str, source_profile: str,
) -> UsageFactEmitResult:
    """返回 facts、attempts、coverage；不写盘。"""
```

```rust
// src/agent/claude_usage_fact.rs（harness adapter，不进 Core）
pub fn claude_jsonl_to_usage_facts(
    path: &Path,
    machine_namespace: &str,
    source_profile: &str,
) -> UsageFactEmitResult
```

Core 继续只负责执行环境无关的 schema、builder、`fact_id` 与迁移逻辑。

### 2.3 推荐数据流

```text
Claude session JSONL
  → shared Claude observation extractor
      ├─ existing fold accumulator → sessions/tail_days → ledger/archive/fold
      └─ UsageFact emitter → facts + attempts + coverage
```

如果一次遍历 tee 会显著增加风险，可以先二次读取；但 fold 与 emitter 必须调用同一个
row parser，不能形成两套 Claude wire-shape 语义。

## 3. 字段映射与身份契约

### 3.1 字段映射

| UsageFact 字段 | Claude 来源 / 规则 |
|---|---|
| `native_session_id` | locate 阶段确定的稳定 session id，受 `source_profile` 约束 |
| `source_event_id` | 优先 `message.id`，其次顶层 `uuid`，最后稳定 fallback |
| `observation_kind` | 固定为 `assistant-usage` |
| `event_ts_utc` | 顶层 `timestamp`，规范化为 UTC |
| `model_raw` | `message.model` |
| `model_normalized` | 经版本化 model resolver 规范化 |
| `source_usage_semantics` | 固定为 `delta` |
| `uncached_input_tokens` | `input_tokens` |
| `cache_read_tokens` | `cache_read_input_tokens` |
| `cache_write_tokens` | `cache_creation_input_tokens` |
| `output_tokens` | `output_tokens` |

`cost-state` 是累计 baseline 锚，不发射 UsageFact。无法归因的 residual 也不是事实，
继续由既有哨兵表达。

### 3.2 `source_event_id` fallback

当 `message.id` 与顶层 `uuid` 均缺失时，使用：

```text
stable_source_identity + byte_offset + normalized_row_hash
```

- `byte_offset` 来自原文件字节位置，不以行号替代；
- row hash 使用两端一致的 canonical JSON；
- 同一文件重复读取必须稳定；
- native id 标记 `identity_basis=native`，fallback 标记 `derived-hash`。

### 3.3 `source_profile` 与 machine namespace

两者都是已落地 builder 的必填身份字段，禁止 `None` 或空串。

- `machine_namespace` 由调用方明确提供且必须非空，缺失或空串时整次调用失败；
- `source_profile` 在 locate 阶段从 Claude source identity 稳定派生；
- 派生逻辑应与后续 R2a 共用纯规范化函数；
- Adapter 不反向依赖 SessionStore；
- 同机不同项目出现相同 session/message id 时不得碰撞。

### 3.4 `fact_id`

Adapter 不自行拼接或哈希，必须调用现有 Core/Python builder。`adapter_version`、
`normalization_version`、`source_revision` 属于 provenance，不加入事件身份，避免仅升级
实现就重写事实身份。

同一 session 中重复出现相同 native event id 时，只发射一个事实，并记录 duplicate
attempt；不得添加 ordinal 掩盖重复。

## 4. 错误、attempts 与 coverage

```text
UsageFactEmitResult
  facts: list[UsageFact]
  attempts: list[UsageFactAttempt]
  coverage: UsageFactCoverage
```

| 情况 | 行为 |
|---|---|
| 空文件 | 空 facts/attempts、零覆盖 |
| 缺 machine namespace/source profile | 调用级错误，不开始发射 |
| 完整行 JSON 损坏 | 本文件失败，checkpoint 不前移 |
| 尾部半行 | 按既有 checkpoint 规则等待补全 |
| 缺 model/timestamp | rejected attempt，不发 fact |
| token 非数值、负值或溢出 | rejected attempt，不发 fact |
| 非 assistant 或无 usage row | ignored/skipped coverage，不伪造 fact |
| 重复 source event id | duplicate attempt，只保留一个 fact |

token 必须先映射到四个 canonical bucket，再交给 builder 校验。禁止两端各自增加隐式
修正或默认值。

Stage 1 不写 state，但必须提供只读诊断入口：

```text
agent-vitals claude-usage-facts <session.jsonl> --json
```

它只用于 characterization、跨语言 parity 与人工检查，不改变同步状态。

## 5. 兼容性与代码边界

允许：

- `_read_suffix` 在保持 checkpoint 语义下暴露字节 offset；
- 从 `_apply_record` 抽取共享 usage row parser；
- `_fold_one` 消费 observation 后继续生成相同 accumulator；
- 新增 Python/Rust adapter 与诊断 CLI。

禁止：

- sessions/tail_days/ledger/archive 输出发生字段或数值漂移；
- baseline/cost-state 被转换成 delta fact；
- 为发射事实升级 fold schema；
- Core 出现 `message.usage` 等 Claude 专属结构；
- 静默跳过坏数据。

## 6. 验收测试

### 6.1 Adapter 契约

1. 一条有效 raw assistant row 产生一个 fact，四类 token 映射正确；
2. 同 day/model 两个不同 message id 产生两个 fact；
3. 重复 message id 只产生一个 fact，并有 duplicate attempt；
4. 缺 message id 使用 `uuid`，两者都缺时 fallback 稳定；
5. 不同 `source_profile` 下相同 native id 不碰撞；
6. 缺 model、坏 timestamp、非法 token 均产生明确 attempt；
7. cost-state 与 residual 不产生 UsageFact。

### 6.2 兼容与增量

8. 重构前后 fold/ledger/archive golden byte-equivalent；
9. full replay 与 checkpoint resume 的 fact-id 集合一致；
10. 尾部半行补全后只产生一次事实。

### 6.3 双实现 parity

11. Python/Rust CLI 对同一真实 fixture 输出相同 canonical JSON；
12. native/fallback 两条路径都做 byte-level `fact_id` 钉测；
13. malformed corpus 的 attempts 分类与 coverage 计数一致。

## 7. 当前代码审核记录

审核时未找到 `claude_jsonl_to_usage_facts`、`iter_claude_usage_observations`、
`claude_session_to_usage_facts` 或 Claude UsageFact 诊断 CLI。

已执行前置回归：

```text
python3 -m unittest tests.test_usage_fact tests.test_claude_cost tests.test_v07_views
结果：46 passed，6 skipped

cargo test -p agent-vitals-core usage_fact --quiet
结果：13 passed，0 failed
```

这证明 Core 契约和既有 Claude 成本路径可作为稳定基线，但不是 Stage 1 已完成的证据。
Stage 1 完成必须满足 §6 全部验收项。

## 8. 实施顺序

1. 钉住现有 Claude fold/ledger/archive golden；
2. 抽取单一 row parser并保留 byte offset；
3. 接回旧 fold，证明输出零漂移；
4. 实现 Python emitter、attempts、coverage；
5. 实现 Rust 镜像；
6. 增加只读诊断 CLI；
7. 跑真实 fixture、增量恢复与 Python/Rust parity；
8. 同步更新 Adapter Decisions 中 Stage 1 状态与工作量。

只有第 1—7 项全部通过，Stage 1 才能标记完成。UsageFact 持久化留到后续 Data Plane
阶段，不夹带进入本次提交。

## 9. 决策汇总（R1 推荐，已拍板 v0.0.2，2026-09-03）

| 决策 | 拍板值 |
|---|---|
| 发射粒度 | **每个原始 assistant usage row 一个 fact**（不是聚合层 emit） |
| 数据流 | **共享 extractor**（`iter_claude_usage_observations`）；优先单次 tee，二次读取仅作降级；fold 与 emitter 必须调用同一个 row parser |
| event id | `message.id` → `uuid` → source + byte offset + row hash（优先级降级，fallback 也要稳定） |
| observation kind | `assistant-usage` |
| identity basis | native/fallback **按实际来源动态标记**（message.id 取到 → native；fallback → derived-hash） |
| source profile | locate 阶段稳定派生，**必填**（与 R2a 共用规范化函数，不读取 Store） |
| machine namespace | 调用方**必传**，缺失即失败（与 build_usage_fact 校验一致） |
| 模块归属 | Claude harness adapter（新文件 `claude_usage_fact.py`/`.rs`）；**Core 执行环境无关** |
| 错误结果 | `facts + attempts + coverage`（坏数据不静默消失） |
| Stage 1 输出 | 内存结果 + 只读诊断 CLI，**不持久化**（`UsageFact` 持久化留到后续 Data Plane 阶段） |

**拍板来源**：R1 架构审核（用户在 `1c697db` 提交后外部修订本文档）+ 2026-09-03 用户拍板确认。

**Stage 1 验收**（spec §6）：extractor 重构后既有 fold/ledger/archive **golden 字节零漂移**、UsageFact emit per-message、Python/Rust 双实现 parity、只读诊断 CLI、真实 fixture 覆盖。

**Stage 1 完成 ≠ v0.7 完成**：本 Stage 仅占 v0.7 候选 #3 三家 adapter 的第一阶段；候选 #3 主体未完成前 v0.7 spec §3 仍处于「明确仍未开始」状态（harness adapter 改造 + 候选 #4 真实迁移 + atomic write/fsync）。

## 10. 工作量估计

- Python extractor/emitter：80—140 行；
- Rust adapter 镜像：100—180 行；
- 两端诊断 CLI：40—80 行；
- fixture、golden、增量与 parity 测试：180—300 行；
- 文档与决策状态同步：20—40 行。

风险主要在 checkpoint、尾部半行、fold 零漂移及双实现 canonicalization。原先按“从
`tail_days` 转换”得到的工作量估计偏低，应废弃。
