# Vitals Core v0.7 —— Stage 2：Codex static fold → UsageFact（映射小规格）

> 状态：**已落地（2026-09-03）**。本文定义 Codex `token_count` 事件 →
> `UsageFact` 的最小映射：事件 ID、reasoning 合并、去重、Legacy/Paginated 双输入。
> 拍板内容：决策 A/B/C/D + §7 决策汇总；2026-09-03 拍板同时修订了决策 D 的 codex
> 项（wire 实证取代，见 §3.3 与 `VITALS_CORE_V0_7_ADAPTER_DECISIONS.md` §4.2）。
> 实施：`5449d0a`（共享 `CodexFoldState` 观察者 byte-neutral refactor + 零漂移门）+
> `faa5caf`（emitter + `codex-usage-facts` 多 rollout CLI + `usage-fact/` fixture +
> 11 验收 + 5 语料 byte-parity）。v0.7 完成记录见
> `VITALS_CORE_V0_7_DATA_PLANE_SPEC.md` §7。
>
> 关联：`VITALS_CORE_V0_7_ADAPTER_DECISIONS.md`（决策 A/B/C/D + §4.2 修订）、
> `VITALS_CORE_V0_7_DATA_PLANE_SPEC.md`、`VITALS_CORE_V0_7_STAGE_1_CLAUDE_ADAPTER.md`、
> `crates/agent-vitals-core/src/adapters/harnesses/codex/sessions/usage.rs`（+ Python 镜像 `codex_usage.py`）、
> `crates/agent-vitals-core/src/contracts/usage_fact.rs`（+ `usage_fact.py`）。

## 0. 当前结论

现有代码已具备：UsageFact 跨语言契约 + 稳定 `fact_id` builder（Stage 1 验证过）、
Codex 成本 fold（core `codex_usage.rs` ↔ Python 镜像，byte-parity 差分守卫）、真实
rollout 语料调查（51 份，见 `codex-corpus-facts` 记忆）。但 **codex → UsageFact
adapter 尚未实现**：没有 codex observation extractor、UsageFact emitter 或对应诊断
CLI。Stage 2 与 Stage 1 同构，差异只在 codex 线格式的四个映射点（本文 §3 逐条定义）。

## 1. 目标与不动边界

### 1.1 Stage 2 目标

1. 每个「codex fold 会折进 `by_model`」的 `token_count` 事件发射一个不可变
   `UsageFact`（发射集 == fold 的 by_model 消费集，见 §2.3）；
2. Python/Rust 对同一事件生成相同规范字段与 `fact_id`；
3. 返回 attempts 与 coverage，坏数据不能静默消失；
4. 既有 `codex_fold_file` / `codex_merge_folds` / `codex_cost_report` / 折叠缓存
   行为与输出逐字节不变；
5. 提供只读诊断入口 `codex-usage-facts <rollout.jsonl> [<rollout.jsonl> …] --json`，
   接受多个 rollout 路径（§6.11），以真实 rollout 验证双实现一致性（镜像 Stage 1
   的 `claude-usage-facts`）。

### 1.2 本阶段不做

- 不持久化 UsageFact，不升级任何 Store/折叠缓存 schema；
- 不把 codex 私有字段（`total_token_usage`、`model_context_window`、`rate_limits`…）
  引入 `agent-vitals-core` 的 fact 层（它们是 fold/report 的事，fact 只取 4 桶）；
- 不改 `CODEX_TOKEN_FIELDS` 5 桶键序、不改 fold 的 5 桶输出形状（键序是字节一致
  的一部分，不能重排）；reasoning 子桶继续留在 fold 形状里做展示归因；
- 不改 codex-cost / codex session navigation / 日历视图；
- 不接入新执行环境（dsh 是 Stage 3）；**不碰 workbuddy 流**。

## 2. 数据源与处理架构

### 2.1 现有 codex-cost 数据流

```text
codex_rollout_files()                          # live + archived 两会话根全 rollout-*.jsonl，全局按路径排序
  → read_codex_session_log(path) → items       # 原始行数组（含 session_meta/turn_context/event_msg/response_item…）
  → codex_fold_file(items) → fold              # core 纯函数（core codex_usage.rs ↔ codex_usage.py 镜像）
  → codex_merge_folds(folds) → report          # 逐文件折叠后全局合并
```

`items` 是**无字节偏移**的已解析行。Stage 1 的 R1 教训在这里原样适用：fold 与
emitter 若各自解释 codex wire-shape，会出现两套语义静默错位——emitter 需要一个
**与 fold 同源的 per-`token_count` 观察者**，而不是在 adapter 里重抄一遍 cursor/
去重/校验逻辑。

### 2.2 token_count 是唯一 token 载体（token 层无 exec 影子）

成本侧用量**只**由 `event_msg.payload.type == "token_count"` 携带，字段在
`payload.info.{total_token_usage, last_token_usage, model_context_window}` +
`payload.rate_limits`（真实语料与全部 codex fixture 都只有这一个载体）。由此：

- `response_item.custom_tool_call` / `custom_tool_call_output`、
  `item_completed.{CommandExecution, …}` **都不携带** `last_token_usage`；
- 行为层「`custom_tool_call{exec}` 与 `CommandExecution` 是同一逻辑 exec 的两份影子、
  以 CommandExecution 为主源跳过影子」——那是 **SV611 工具调用计数**的规则；
  token 层没有这个双源（一次模型请求只产一个 `token_count`）。**规则**：emitter
  绝不以 response_item / item_completed 为事实源（§3.5 影子去重，回归钉测）。

### 2.3 推荐接口与发射集定义

发射集与 fold 对齐到 **`by_model` 消费集**（不是 `by_hour_model`）：codex fold 对
无时间样本仍折进 `by_model`、只缺小时桶，所以「可归模型的有效 delta」= 该 emit。
四类 fold 判别原样继承：缺 info / `last_token_usage` 无效 → 不 emit（残差哨兵）；
model 游标为空 → 不 emit（`token_count_before_turn_context`）；连续 total 签名复读
→ 不 emit（同一计量复读）；其余 → emit。

```python
# scripts/agent_vitals/agent/codex_usage_fact.py（harness adapter，不进 Core）
def codex_rollouts_to_usage_facts(
    paths, *, machine_namespace, source_profile,
) -> UsageFactEmitResult: ...      # paths：一个或多个 rollout 文件（§6.11 多路径）
```

```rust
// src/agent/codex_usage_fact.rs（harness adapter，与 Python 逐字节对齐）
pub fn codex_rollouts_to_usage_facts(
    paths: &[PathBuf], machine_namespace: &str, source_profile: &str, ...
) -> UsageFactEmitResult
```

发射**域** = 本次传入的 rollout 路径集（通常即 `codex_rollout_files()` 全量，与
codex-cost 同根）。同次发射内按 `source_event_id`（§3.3，rollout-stem 命名空间）
去重：同一物理 rollout（同 stem）经 live/archive 双路进入时保留一条 + duplicate
attempt（§3.5.3）；不同 stem（即便同一逻辑 session）**永不**共享 offset 命名空间、
绝不误合并。Core 继续只负责执行环境无关的 schema / builder / `fact_id`。

共享观察者的归属（关键实现决策）：codex fold 的 token_count 分支在 **core**
`codex_usage.rs` 是单一真相。Stage 2 建议先把该分支抽成一个共享 per-event 步骤
（byte-neutral refactor——fold 输出逐字节不变，由 golden + `test_cli_matrix` 差分
证零漂移），fold 与 emitter 都消费它；derived id 需要的 `byte_offset` 由 emitter
的 I/O 层供应、fold 不读。这是 Stage 1 commit 1（extractor 重构 + 零漂移）的
codex 对应物。若抽 refactor 被视为超出「~80 行」预算，**退路是 emitter 独立但只
调 fold 已导出的纯叶函数**——但那样 cursor/去重/校验必须重抄，等于 Stage 1 R1
明令禁止的「第二套 wire-shape 解释」，规格不推荐。

## 3. 字段映射与身份契约

### 3.1 字段映射（5 → 4 桶）

`payload.info.last_token_usage` → 4 个 canonical bucket：

| UsageFact 字段 | codex 来源 / 规则 |
|---|---|
| `uncached_input_tokens` | `input_tokens − cached_input_tokens − cache_write_input_tokens`（**派生**，fold 同款；`uncached < 0` → 无效不 emit） |
| `cache_read_tokens` | `cached_input_tokens` |
| `cache_write_tokens` | `cache_write_input_tokens` |
| `output_tokens` | `output_tokens`（reasoning 已含，§3.2，**绝不叠加**） |

必填缺场（`input_tokens` / `output_tokens` 非整数或缺失）→ 不 emit，与
`codex_token_facts` 判 `None` 同一谓词。

### 3.2 reasoning_output → output_tokens 合并（决策 A 落地）

- 线格式里 `reasoning_output_tokens ⊆ output_tokens`——fold 的 `output >= reasoning`
  校验就是这条守护；repo 计价侧铁律明写「reasoning 桶存在但不参与计价——它已含在
  output 里，再乘一次就是双计」，人读总量只加 4 个独立桶。
- `fact.output_tokens := codex output_tokens`。**没有 reasoning 桶**，也**不把
  reasoning 加在 output 之上**。
- `reasoning > output` → 该事件无效（与 fold 同判），进残差哨兵、不 emit，绝不
  编造一个 output 值去兜住 reasoning。
- fold 输出形状里的 5 桶（含 reasoning 子桶）**不变**——那是 fold 的展示归因维，
  事实层 4 桶是另一层投影。两处各自 byte-parity。

### 3.3 token_count 的 event ID：无原生 id → rollout-stem 命名空间的 derived（决策 D 对账 + 2026-09-03 修订）

wire 实证：token_count envelope 是 `{timestamp, type, payload}`，`payload` 只有
`type / info / rate_limits`——**没有 `id`、没有 `turn_id`、没有 item.id**。
已拍板决策 D「codex: rollout item `id`」描述的是带 `item.id` 的 TurnItem
（CommandExecution 等）；**token_count 是 `event_msg`、不是 TurnItem，没有可取的
原生 id**。决策 D 的 codex 项因此**被 wire 实证取代**（同步标注于 Adapter
Decisions §4.2）。

**2026-09-03 修订核心**：`byte_offset` 只在**单个物理 rollout 文件内**唯一。若把
`source_event_id` 放进逻辑 session 命名空间（`session_id:offset:row_hash`），同一
逻辑 session 的两份续接 rollout 文件可能都有 offset 0 且出现相同 JSON 行（续接
边界重放），会把两次合法请求误判为跨文件重复、**少算一笔**。因此 `source_event_id`
必须按**物理文件**命名：

```text
native_session_id    = 逻辑 session_id（§3.4；同一逻辑 session 跨 rollout 共享）
rollout_source_id    = 物理 rollout 文件稳定身份 = path.stem（rollout UUID）
source_event_id      = rollout_source_id + byte_offset + fnv1a64(canonical_row)
identity_basis       = derived-hash
```

`byte_offset` = 行首在**文件内**的字节位置（不以行号替代）；row hash = 两端一致
的 canonical JSON 的 FNV-1a 64；连接符与 Stage 1 §3.2 derived 同款，保证字节跨
语言一致。效果：

- 同一物理 rollout 无论从 live 根还是 archived 根读（byte-identical 副本），同
  stem、同 offset、同行 → 同 `source_event_id` → 可安全去重（§3.5.3）；
- 同一逻辑 session 的不同 rollout（不同 stem）**永不**共享 offset 命名空间 → 同
  offset 同内容的合法行各发一条 fact，不误合并；
- 没有原生 token event id 时，**不宣称**能对任意跨-rollout 重放可靠去重——那需
  要原生 id，不是 derived 能兜的（§3.5.4 明说）。

`identity_basis` 恒 `"derived-hash"`——codex token_count 没有可达的原生 event id
路径，不存在「native 路径」这一态。向后兼容条款不变：若未来某 cli 给 token_count
带上原生 id（如 `payload.id`），优先级链「原生 id → derived」照 Claude Stage 1c 的
message.id → uuid 模式补 native 态，schema 按「先 derived、后按需抬 native」演进。

### 3.4 native_session_id：逻辑 session_id，path.stem 只兜底

```text
native_session_id = session_meta.payload.session_id        # 主路：逻辑 session_id
                  → payload.id                            # 键整个缺席时（≠ null 值）
                  → path.stem                             # 最后兜底：物理文件 stem
```

- 主路依据：真实语料 **51% 的 rollout 文件名 UUID ≠ 逻辑 session_id**——Codex 续接
  会话写新文件但保留原 `payload.session_id`。按文件名主定位会把续接会话数成两笔
  成本（记忆 `codex-corpus-facts`「去重必须以逻辑 session_id、绝不能按文件名」）
  ——这正是 native_session_id 用逻辑 id 的原因。
- `rollout_source_id`（= path.stem）只作**最后兜底**：文件没有 session_meta 且读
  不到 session_id 时（如纯 fold fixture），native_session_id 退化为该物理文件
  stem——诚实语义是「该文件自成一个会话」，**不**假装知道其逻辑归属。此时
  native_session_id == rollout_source_id，但两者仍是不同概念（逻辑 vs 物理）：带
  session_meta 的文件两者不同。效果：cost fixture `fixtures/codex/cost/*.jsonl`
  （无 session_meta）也能 emit（stem 兜底），无需强迫 fixture 加 session_meta。
- 同一逻辑 session 的多个 rollout **共享** native_session_id，但 source_event_id
  按 rollout stem 命名空间区分（§3.3）——「续接不拆会话」与「同形行不误合并」由
  两个独立身份轴分别承载，互不混淆。

### 3.5 去重三源（DATA_PLANE §2.1 落地为 codex 三条）

DATA_PLANE §2.1：「影子记录、累计快照和重复日志在写事实前消解，并保留
provenance」。逐条落到 codex：

1. **影子记录 → token 层不存在，靠「单载体 + 源限定」消解**：唯一 token 载体是
   `event_msg/token_count`（§2.2）。规则不是「跳过 custom_tool_call 那份」而是
   「**custom_tool_call / item_completed 从来不是事实源**」——行为层要跳过的
   exec 影子，token 层根本不读。回归 fixture 含双影子 exec 记录 + token_count，
   断言 fact 集只由 token_count 驱动（影子去重测试，§6.5）。
2. **累计快照（复读）→ fold 谓词跳过，不 emit 也不计 duplicate**：同一计量复读
   = 连续 `total_token_usage` 签名不变 → fold `continue`。emitter 与 fold 同判：
   这不是残差、也不是「重复事实」，是**同一计量的复读**（累计单调不减 → 连续
   去重 = 完全去重）。这条是「不把复读的 last 全 0 快照（带假 total_tokens）发成
   一条零 delta fact」的守卫。
3. **重复日志（同一物理 rollout 重收录）→ source_event_id duplicate**：同次发射域
   内同一 `rollout_source_id`（同 stem）出现两次——live 根与 archived 根各收录一
   份同一物理文件、或同文件被重扫——两读 byte-identical → 同 `source_event_id`
   → duplicate attempt、保留一份 fact（Stage 1 §3.4 语义继承）。**不得加 ordinal
   掩盖重复。**
4. **不做的事（明说）**：无原生 id 的 derived `source_event_id` **不宣称**能对任意
   跨-rollout 续接重放可靠去重——不同 rollout stem（即便同一逻辑 session）的命名
   空间不同，同 offset 同内容只会各发一条。这是本修订的核心取舍：**宁可两条，绝
   不误合并**；续接重放是否真有重复由未来的原生 id / writer 侧账本判定，不由
   derived 猜。跨次调用（重扫同一物理文件）靠**稳定 fact_id**（source_event_id
   确定性派生）保证 writer 侧精确去重——emitter 只保证同一物理文件重读时产出
   相同 fact_id。

### 3.6 harness / observation_kind / time / source_profile

| 字段 | 值 |
|---|---|
| `harness` | `"codex"` |
| `machine_namespace` | 调用方**必传且非空**，缺失或空串即调用级失败（exit 2），Stage 1c §9 同纪律 |
| `source_profile` | 必填；locate/R2a 前的处理沿用 Stage 1 现状（Stage 1 遗留的
  `source_profile="default"` 属后续清理，不夹带进 Stage 2） |
| `observation_kind` | **`"assistant-usage"`**（已拍板）——per-request delta model usage
  与 Claude 同构；执行环境差异由 `harness` / `provider` / `model_raw` 表达，不另开
  `"codex-usage"` |
| `event_ts_utc` | 顶层 `timestamp`（回退 `payload.timestamp`）**原样串**；事件真无
  时间戳 → `None`，绝不编造。无时间仍可 emit（fold 无时间也进 by_model，§2.3） |
| `time_basis` | 与 identity_basis **解耦**（Stage 1c 原则）：事件带原生时间戳 →
  `"native"`；真无时间戳 → `None`（诚实「无观测时间」，不冒充 estimated） |
| `source_usage_semantics` | 恒 `"delta"`——`last_token_usage` 是 per-request 增量
  （`total[i] − total[i−1]`）；复读快照在写事实前已被 §3.5.2 消解，绝不把累计
  `total_token_usage` 当 delta 发 |

provider/model：事实层只保留原始证据 `model_raw` = 该 token_count 归到的
`turn_context.payload.model` 游标值（token_count 自身不带 model）。`model_id`/
`provider_id`/`normalization_version` 一律不填（`None`），Stage 1 同款——没有
resolver 就不硬编码真值。

## 4. 错误、attempts 与 coverage

attempts 与 fold 的判别一一对应（emitter 不另起一套「不可用」分类）：

| fold 判别 | emitter 行为 |
|---|---|
| `info` 非 dict / null | skip（不是残差，也不发 fact） |
| `last_token_usage` 无效（`codex_token_facts` None，含 reasoning>output） | `unreadable` attempt，不发 fact |
| model 游标为空（首个 turn_context 之前） | `unattributed` attempt，不发 fact |
| 连续 total 签名复读 | 不 emit、不计 attempt（同一计量复读，§3.5.2） |
| 可折叠 | emit；`build_usage_fact` 拒绝（防御）→ `bad_id` attempt |
| 同物理 rollout（同 stem）重复来源 | `duplicate` attempt，保留一份 |

coverage：`{total_token_count_events, fact_rows, skip_rows}`。

## 5. Legacy / Paginated 两种输入

- 实测：token_count 在 **Legacy 与 Paginated 两种词表下都持久化**，不受 mode 分裂
  影响（记忆 `codex-corpus-facts`）；P4 读取器**不按 mode 分支**（真实 Paginated
  会话混着 `task_started`/`task_complete`，混合流免费兼容）。
- Stage 2 继承同一纪律：emitter 只认 `event_msg/token_count`，从不读
  `session_meta.payload.history_mode` 决定分支；`history_mode` 至多做 provenance。
- 「Legacy/Paginated 两态都 emit」的验收 = 两个 `history_mode` 的 fixture 都产出
  逐字节一致的 Python/Rust fact 集（§6.3/6.4），各自含 session_meta + turn_context
  + 有效 token_count + 一个残差样本。

## 6. 验收测试（决定文档「8 测」+ 2026-09-03 跨文件修订补 3 测 = 11）

1. **5→4 映射正确**：单事件 4 桶映射（uncached = input−cached−cache_write；cached
   → cache_read；cache_write → cache_write；output → output）。
2. **reasoning 合并**：`output` 载 reasoning（reasoning ≤ output 时 fact.output =
   output、无 reasoning 桶、不叠加）；`reasoning > output` 事件 → unreadable，不
   emit。
3. **Legacy 输入 emit**。
4. **Paginated 输入 emit**。
5. **影子 custom_tool_call 去重**：含 `custom_tool_call`+`CommandExecution` 双影子
   记录 + token_count 的 fixture → fact 集只由 token_count 驱动，双影子 exec 产 0
   fact（与行为层 SV611 影子跳过是同一教训的 token 层镜像）。
6. **fact_id 一致性（同一次发射内 / 同物理文件重收录）**：同一文件、或同 stem 两源
   （live + archived）进入同一次发射 → 同 `source_event_id` → duplicate attempt、
   保留一条 fact、fact_id 一致。
7. **fact_id 跨次稳定**：同一物理 rollout 文件重扫两遍 → 同一批 fact_id
   （source_event_id 确定性派生，writer 侧据此精确去重）。
8. **同逻辑 session、异 rollout stem、同 offset、同 JSON → 两条 fact**：两份不同
   stem 的文件（session_meta 同 session_id；token_count 均位 offset 0、整行逐字节
   全等）→ source_event_id 不同 → 各 emit 一条，**不**误判跨文件重复（用户
   2026-09-03 验收 #1）。
9. **同 rollout stem 的重复来源 → 一条 + duplicate attempt**：同一物理文件以 live
   与 archived 两路收录进入同一次发射（byte-identical 副本）→ 同 source_event_id
   → 一条 fact + duplicate attempt（用户 2026-09-03 验收 #2）。
10. **Python/Rust byte-parity**：同一真实 rollout fixture，`codex-usage-facts --json`
    两侧 stdout 逐字节一致（含 fact_id / identity_basis=derived-hash / attempts /
    coverage）。
11. **CLI 多 rollout 接受**：`codex-usage-facts <fileA> <fileB> …` 接受多个 rollout
    路径——跨文件/跨 stem 语义（§6.8/6.9）只有多路径调用能覆盖，单文件入口无法
    验证（用户 2026-09-03 验收 #3）。

另：byte-neutral fold refactor（§2.3）必须过 golden 15/15 + `test_cli_matrix`
`both("codex-cost")` 零漂移门，才允许动 core fold 代码。

## 7. 决策汇总（已拍板）

| 决策 | 拍板值 |
|---|---|
| token 载体 / 影子 | 单载体 `event_msg/token_count`；custom_tool_call / item_completed 不是事实源；token 层无 exec 影子 |
| event id | token_count 无原生 id → **一律** derived `rollout_source_id:byte_offset:canonical-row-hash`（rollout_source_id = path.stem 物理文件命名空间；identity_basis 恒 derived-hash）；未来带原生 id 再抬 native（决策 D 被 wire 实证取代，见决策文档 §4.2） |
| native_session_id | **逻辑 session_id**（`session_meta.payload.session_id` ← `.id`）；`path.stem` 仅最后兜底（无 session_meta 文件自成一会话）；续接会话跨文件共享 |
| reasoning → output | `fact.output = codex output_tokens`；reasoning ⊆ output **不叠加**；5 桶键序不动 |
| 去重三源 | 影子=源限定（单载体）；累计复读=fold 谓词不 emit 不计 duplicate；同物理 rollout（同 stem）重收录=source_event_id duplicate 保留一份；**不宣称**跨-rollout 重放可靠去重 |
| harness / kind | harness=`codex`；observation_kind=`assistant-usage`（执行环境差异由 harness/provider/model_raw 表达） |
| 架构 | 共享 per-token_count 观察者（byte-neutral core fold refactor）+ emitter harness adapter；不另起第四份 wire-shape |
| 发射集 | == fold 的 by_model 消费集（含无时间样本） |
| 发射域 | 本次传入的 rollout 路径集；同次发射内按 source_event_id（stem 命名空间）去重，异 stem 永不误合并 |
| machine ns / source profile | machine ns 必传且非空，缺失或空串失败；source_profile 沿用 Stage 1 现状（locate/R2a 遗留） |
| 诊断入口 | `codex-usage-facts <rollout.jsonl> [<rollout.jsonl> …] [--json] [--machine-namespace X]`（只读，不写 state） |

## 8. 需要拍板 / 已知遗留

（2026-09-03 拍板已消项：`observation_kind` → `assistant-usage`；event id 改
rollout-stem 命名空间；决策 D 修订标注。以下为遗留项。）

- **fixture 落点**：usage-fact fixture 需覆盖（a）带 session_meta 的 Legacy /
  Paginated 双态（逻辑 session_id 生效），以及（b）**跨 stem 同形**（§6.8）与
  **同 stem live/archive 双收**（§6.9）两组跨文件用例——前者需两份 stem 不同、
  但 token_count 同 offset 同 JSON 的文件；后者需一份 stem 相同、内容 byte-identical
  的双路径文件。建议并入 `fixtures/codex/build_codex_fixture.py` 同一 builder。纯
  fold cost fixture（无 session_meta）无需加字段：stem 兜底已使它们可 emit（§3.4）。
- **source_profile 默认 `"default"`**（Stage 1 遗留、非阻塞）：正式接入 locate/R2a
  时改为从 Codex source identity 稳定派生（与 R2a 共用规范化函数）。
- **fold 的跨文件复读**：codex-cost 的 merge 逐文件 fold、`last_total_sig` 每文件
  重置——续接会话若真在文件边界重报同一累计量，fold 会双折。这是 fold 现状、
  超出 Stage 2 发射范围；事实层因 source_event_id 按 stem 命名且 fact_id 稳定不受
  影响，writer 去重后不双计。是否在 Stage 3/dsh 之后再处理，留独立项。

## 9. 工作量（粗估，供拍板参照）

- codex per-token_count 共享观察者 refactor（byte-neutral）+ Python/Rust emitter：
  150—220 行；
- 诊断 CLI（两端）：40—80 行；
- usage-fact fixture（Legacy/Paginated + 跨 stem + live/archive）+ 11 验收测试 +
  byte-parity：250—350 行；
- 本文档 + Adapter Decisions 状态同步：30—50 行。

风险集中在 core fold refactor 的零漂移门与 derived-id canonical 字节跨语言一致
（FNV-1a + canonical JSON 已在 Stage 1c 验证过，复用同一实现即可降低风险）。
