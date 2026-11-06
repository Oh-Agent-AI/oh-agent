# Vitals Core v0.7 —— Harness Adapter 改造立项决策（候选 #3）

> 状态：**已拍板 v1.0（2026-09-03 拍板）**——本文件是 spec §3 主体候选
> #3 启动前的立项决策清单。每条决策已拍板（见 §5 决策汇总）；后续
> commit 按本文件决策执行，每 Stage 独立 commit、独立评审。workbuddy
> 流已明确排除（用户 2026-09-03 决定），本文件只覆盖 claude / codex /
> dsh 三家。
>
> 关联：
> - 数据面契约见 `docs/VITALS_CORE_V0_7_DATA_PLANE_SPEC.md` §2、§3、§4
>   候选 #3 行的"明确仍未开始"清单
> - 契约骨架已落地：`crates/agent-vitals-core/src/contracts/usage_fact.rs` +
>   `scripts/agent_vitals/agent/usage_fact.py`（commit b806762），含
>   `fact_id` / `USAGE_FACT_FIELDS` / `build_usage_fact` 纯函数
> - CLI/menubar 全链路已闭环（commit a577497 + 7bd1349）：剩下的是把
>   adapter 接上让事实行真的被产出
> - Stage 1 规格细化（R1 修订）：`docs/VITALS_CORE_V0_7_STAGE_1_CLAUDE_ADAPTER.md`
>   （commit 1c697db，v0.0.2 已拍板）——Claude adapter 的具体设计：
>   per-message 粒度、共享 extractor、message.id → uuid → offset+hash
>   fallback、`assistant-usage` observation_kind、facts + attempts +
>   coverage 错误结果、内存 emit + 只读诊断 CLI
> - P1 契约缺口修复：commit c965926（identity 元组入表 / u32 截断防御
>   / 迁移步版本校验）——adapter 改造前的契约基础
> - 拍板前版本：commit e88d68a（doc-only，提案 v0.0.1）

## 0. 范围与前置

1. **本文件 = 启动闸**：spec §5「迁移与并发」「逐项评审 `--update`」「
   双语言 parity 与不变式全绿」三条验收纪律意味着——每条 schema/输出
   变化必须先产生独立、可解释的 diff；本文件就是把"为什么这么改"从
   代码 commit 提到 spec 层，commit 时把"决策"和"代码"分两次（先
   本文件独立 commit、评审拍板；拍板后才动代码）。
2. **前置已满足**：v0.6.x 热修（commit 1ec98af）+ v0.6 M0–M3 + 候选 #3/4
   契约骨架（b806762）已落地提交；golden 字节零漂移。spec §0.3 原文
   写"两条流挡着"只剩 workbuddy 流仍未合入——但 spec §0.3 末段已确认
   claude ledger / codex fold / dsh state chain 文件面与 workbuddy
   流不相交，候选 #3 改造**不依赖** workbuddy 合入。
3. **workbuddy 出本版**：用户 2026-09-03 决定（"workbuddy 先不用管，
   我们后续最终验收的接入"），其 evidence 适配器与 credit_json 继续
   原始形状运行，本文件**不覆盖**。

## 1. 决策 A：codex `reasoning_output_tokens` 映射

### A.0 现状

`crates/agent-vitals-core/src/adapters/harnesses/codex/sessions/usage.rs:66-71` 的 5 桶
`CODEX_TOKEN_FIELDS`：
- `uncached_input_tokens`
- `output_tokens`
- `cached_input_tokens`
- `cache_write_input_tokens`
- **`reasoning_output_tokens`**（5 桶独有，UsageFact 无对应字段）

`USAGE_FACT_FIELDS`（`crates/agent-vitals-core/src/contracts/usage_fact.rs`）
按 Claude 4 型 snake 词表约定，output 单桶、不切分 reasoning。

### A.1 三选项

| 选项 | 描述 | 影响面 |
|---|---|---|
| **(a) 合并到 `output_tokens` [推荐]** | 把 `reasoning_output_tokens` 累加进 `output_tokens`，单字段出账 | DSH 计价面没有 reasoning 切分（`cost_report` / `priced_day` 都不读）；Claude Code 也不切分（`claude_session_cost` 同理）；合并是最小代价路径。`fact_id` 不变——同一 (harness, session, event) 出同一个 hash。 |
| (b) 保留单独字段 | UsageFact 加 `reasoning_output_tokens`（schema_version=2 触发） | 需要先有真实持久化调用点才能产出 v2；与"未持久化 = 不增 schema_version"纪律相悖。属于提前埋字段。 |
| (c) 丢弃 | 不进 UsageFact，token 数不进账 | 违反 spec §2「事实 Token 永远是 delta」纪律——`reasoning_output_tokens` 是真实 token 消费，丢即漏账。 |

### A.2 推荐 (a) 的具体规则

```text
codex_fold 的 5 桶 → UsageFact 4 型 snake：
  uncached_input_tokens       → input_tokens
  cached_input_tokens         → cache_read_input_tokens
  cache_write_input_tokens    → cache_creation_input_tokens
  output_tokens + reasoning_output_tokens → output_tokens  [合并]
```

### A.3 影响面

- 计费：`cost_report` 不读 reasoning 切分——价格不变
- R2a：SessionKey 仍按 `harness_kind=native_id` 唯一定位，不漏事件
- `fact_id`：同一事件 hash 不变（输入决定 hash）
- 测试：需要新增 1 条 codex fold fixture + UsageFact emit 测试

## 2. 决策 B：DSH emit 时机

### B.0 现状

DSH 用 `usage_events` 流（zstd 增量多帧 zstd 压缩）作为事实输入；
现有路径走 `token_by_model` 折叠成 `usage.by_model` 后喂 `cost_report`，
**事实折叠层与定价层之间缺一道 UsageFact 投影**——这就是候选 #3
要补的"事实层"。

### B.1 二选项

| 选项 | 描述 | 影响面 |
|---|---|---|
| **(a) 从 `usage_events` 原始流 replay 产出 UsageFact [推荐]** | adapter 在事件层投影，一条 event → 一个 UsageFact | 与 spec §2「事实 cache 可重建」一致（replay from raw events）；粒度最细；R2a SessionKey 在事件层已有 identity；与现有 `usage_fold_state` 同源 |
| (b) 从 `token_by_model` 折叠后投影 | adapter 在 by_model 折叠层投影 | 折叠是不可逆聚合——一旦折叠就回不到原始事件；如果 fold 函数改了就丢追溯；违反 §2「事实 cache 可重建」纪律 |

### B.2 推荐 (a) 的具体路径

```text
adapters/dsh.py::usage_fold_state(events)
  → 事件级折叠（与现有同源，零新写）
  → 逐 event 投影 UsageFact（新增）：
      fact_id = hash(machine_namespace, harness=dsh, source_profile,
                     native_session_id, source_event_id=event_id,
                     observation_kind=message)
      schema_version = 1
      token 字段从 event.payload.usage 填
      providers 由 event.payload.provider（或 resolve_card fallback）填
```

### B.3 zstd 多帧的"重写历史"语义

DSH 日志是**zstd 增量多帧追加**（`docs/DSH_INTEGRATION.md`、`memory/
dsh-storage-facts.md`）——同一文件每次会话可被增量压缩多次，新帧含
新事件、不重写历史帧。

**这意味着 UsageFact 不需要重写历史**：每帧新增事件就是新 UsageFact；
历史帧的 UsageFact 在第一次 replay 时已生成。**不存在"重写历史"
的语义**——这是决策 B(a) 推荐的关键依据，与我先前在分析中提到的
"DSH 高风险 / zstd 多帧重写历史"判断相反，更准确的描述是"zstd 多帧
**不重写历史**"，与增量 fold 同构。

### B.4 影响面

- adapter：`adapters/dsh.rs::usage_fold_state` 加 emit 步
- 测试：需要新增 1 条 zstd 多帧 fixture（≥2 帧）+ replay 测试
- 持久化：决策 B 决定**不**触发 v0.7 真实持久化（emit 只在内存），
  候选 #4 真实迁移等真实持久化调用点出现再做

## 3. 决策 C：改造顺序

### C.0 三选项

| 选项 | 描述 | 影响面 |
|---|---|---|
| **(a) claude → codex → dsh（按风险从低到高）[推荐]** | claude 零距离先跑通模板 → codex 验证 5→4 决策 → dsh 验证 zstd replay | 每家独立 commit、独立测试、独立 byte-parity 钉测；任一阶段卡住可暂停不影响后续 |
| (b) claude → dsh → codex | 先闭两条原生 delta 路径 | 风险分散但 codex 5→4 决策放最后（如果决策错要回滚 codex commit） |
| (c) codex → claude → dsh | 先处理最棘手 | 反向风险——先把 5→4 决策做错的话影响后续所有 commit |

### C.1 推荐 (a) 的执行细节

**Stage 1：claude ledger**（预计 ~50 行 + 5 测试）
- 入口：`claude_cost.py::rebuild_days`（已是 UsageFact 兼容形状）
- 改动：每个 assistant row → emit 一个 UsageFact（`build_usage_fact`）
- 不动：cost-state 累计口径、baseline 对账锚、残差哨兵（已 v0.6.x 落地）
- 测试：5 测 = claude 4 型 snake 输入 / 缺字段拒绝 / 负数拒绝 / fact_id
  一致性 / byte-parity Python↔Rust

**Stage 2：codex static fold**（预计 ~80 行 + 8 测试）
- 入口：`codex_usage.py::codex_fold_file`
- 改动：每 token_count 事件 → emit 一个 UsageFact（决策 A 映射）
- 不动：5 桶折叠键序（spec §0 末段"`CODEX_TOKEN_FIELDS` 的桶序新建
  （键序是字节一致的一部分，不能重排）"）
- 测试：8 测 = 5→4 映射正确 / fact_id 一致性 / reasoning_output 合
  并 / Legacy/Paginated 两态都 emit / 影子 custom_tool_call 去重
  / byte-parity Python↔Rust。2026-09-03 拍板修订：event id 改物理
  rollout stem 命名空间（决策 D′，§4.2），验收补 3 测（异 stem 同形
  各发一条 / 同 stem 双收保留一条 + duplicate / CLI 多 rollout 路径）
  ——完整 11 测见 Stage 2 规格 §6

**Stage 3：dsh state chain**（预计 ~100 行 + 6 测试）
- 入口：`adapters/dsh.py::usage_fold_state`（事件级）
- 改动：每 usage 事件 → emit 一个 UsageFact（决策 B(a) replay）
- 不动：zstd 多帧解压、increment replay、checkpoint/resume
- 测试：6 测 = 单帧事件 emit / 多帧增量 emit / compaction 事件 emit
  （`compaction_identity()` 现有）/ fact_id 一致性 / byte-parity
  Python↔Rust / R2a SessionKey 对得上

### C.2 推荐 (a) 的闸门纪律

每 Stage 独立 commit + 独立 byte-parity 钉测；任一 Stage 拍板后可
暂停不影响后续 Stage；spec §5「逐项评审」对每 Stage 都成立。

## 4. 决策 D：fact_id 唯一性边界

### D.0 一个待澄清的子决策

候选 #3 把每个事件 emit 一个 UsageFact——但 `fact_id` 公式（§2.1）
是 `hash(machine_namespace, harness, source_profile, native_session_id,
source_event_id, observation_kind)`。三个待定项：

1. **DSH 的 source_event_id 取什么**：事件 payload 自带 `id` 字段？
   `usage_event_id` 派生？现有 adapter 怎么定义？
2. **codex 的 source_event_id 取什么**：rollout item id？token_count
   的 request_seq？
3. **claude 的 source_event_id 取什么**：`message.id`？

### D.1 推荐

- **claude**：直接用 `message.id`（Anthropic 原生稳定 id，v0.6.x 已
  在残差哨兵里讨论过"按 message.id 去重"——本决策正式采纳）
- **codex**：用 rollout item `id`（codex 原生稳定 id）——**已被 wire 实证
  取代（2026-09-03，见 §4.2）**
- **DSH**：用 `usage_event_id`（adapter 在事件投影时派生，保证同一
  帧同一事件 → 同一 id）

### 4.2 2026-09-03 修订：codex source_event_id 被 wire 实证取代（旧决策）

**状态标记：决策 D 的「codex: rollout item id」是 [被 wire 实证取代的旧决策]。**
Stage 2 规格细化（`VITALS_CORE_V0_7_STAGE_2_CODEX_ADAPTER.md` §3.3）核对真实
rollout 语料时发现：

1. `event_msg/token_count` envelope 只有 `{timestamp, type, payload}`，`payload`
   只有 `type / info / rate_limits`——**没有 `id`、没有 `turn_id`、没有
   item.id**。决策 D 假设的「rollout item id」属于带 `item.id` 的 TurnItem
   （CommandExecution 等）；token_count 是 event_msg，**不是 TurnItem，无可取
   原生 id**。
2. 因此 codex 的 token_count source_event_id **一律 derived-hash**，并按
   **物理 rollout 文件（path.stem）命名空间**构造，不能用逻辑 session_id：
   `byte_offset` 只在单个文件内唯一，混进跨文件的逻辑 session 命名空间会把同
   一逻辑 session 两份续接 rollout 里同 offset 同 JSON 的合法行误判为跨文件
   重复。修订后公式：
   `source_event_id = rollout_source_id(:path.stem) + byte_offset + fnv1a64(canonical_row)`，
   `native_session_id = 逻辑 session_id`（session_meta.payload.session_id ←
   payload.id ← path.stem 兜底，两个身份轴独立）。
3. 语义边界：derived id **不宣称**能对任意跨-rollout 重放可靠去重（宁可两条，
   绝不误合并）；同物理 rollout 被 live/archive 重复收录时仍可安全去重。
   未来若某 cli 给 token_count 带原生 id，再按 Claude 的 message.id → uuid 模式
   补 native 态（向后兼容，schema 先 derived、后按需抬 native）。

claude / DSH 两项不受影响，仍按 §D.1 执行。

### D.2 影响面

- 三家 adapter 各加 ~3 行代码（取 id 喂 `fact_id`）
- 测试：每个 adapter 加 1 测（同一事件两次 emit → 同一 fact_id）

## 5. 决策汇总（已拍板）

| 决策 | 拍板值 | 影响面 | 阻塞点 |
|---|---|---|---|
| A. codex reasoning_output → output 合并 | **(a) 合并到 output_tokens** | DSH/Claude 计价面无切分，最小代价 | — |
| B. DSH 从原始事件 replay 投影 | **(a) 从 usage_events 原始流 replay** | 与 spec §2「事实 cache 可重建」一致；zstd 多帧不重写历史 | — |
| C. 改造顺序 claude → codex → dsh | **(a) 按风险从低到高** | 每阶段独立 commit、可暂停 | — |
| D. fact_id source_event_id 来源 | **claude: message.id / codex: rollout item id / DSH: usage_event_id 派生** | 三家 adapter 各加 3 行 | — |
| D′. codex token_count 无原生 id（2026-09-03 wire 实证修订） | codex 一律 derived-hash，按物理 rollout 文件 stem 命名空间（`stem:offset:fnv1a(canonical_row)`）；native_session_id = 逻辑 session_id 独立承载续接不拆会话 | 覆盖决策 D 的 codex 项（**被 wire 实证取代的旧决策**，见 §4.2） | claude / DSH 不受影响 |

**拍板日期**：2026-09-03。后续 commit 按本文件决策执行：

1. ✅ 决策 A/B/C/D 拍板（commit b1220b3）
2. ✅ Stage 1 规格细化（commit 1c697db，v0.0.2 已拍板 R1 修订）
3. ✅ P1 契约缺口修复（commit c965926，adapter 改造前的契约基础）
4. ✅ Spec §3 状态同步（commit 4a38986，CLI/menubar 闭环登记）
5. ✅ Stage 1 规格拍板 commit（doc-only，把 R1 决策升为 v0.0.2 已拍板）
6. ✅ Stage 1 代码实施（按 R1 设计：共享 extractor + per-message emit）
   - extractor 重构 + golden 零漂移（commit 6fb8c99）
   - UsageFact emitter + 诊断 CLI + 真实 fixture（Python commit 1e616c9、
     Rust mirror commit c11d4b7）
   - Stage 1c：补全 6 项 R1 契约缺口（commit 41b5225）
7. ✅ Stage 2：codex static fold emit UsageFact（决策 A 映射 + 决策 D′ 修订）
   - 拍板 + decision-D 修订同步：本文 §4.2 + `STAGE_2_CODEX_ADAPTER.md`（doc
     commit `6b5a33a`，2026-09-03）
   - 代码实施按该 spec §2.3 两步：共享 `CodexFoldState` 观察者 byte-neutral
     refactor（commit `5449d0a`，零漂移门）+ emitter + `codex-usage-facts` 多
     rollout CLI + `usage-fact/` fixture + 11 验收 + 5 语料 byte-parity
     （commit `faa5caf`）。`reasoning_output_tokens ⊆ output_tokens`（合并不叠加）；
     `source_event_id` 按物理 rollout stem 命名空间（`stem:offset:fnv1a64`）
8. ✅ Stage 3：dsh state chain emit UsageFact（决策 B replay，spec v4）
   - 规格 v4 拍板（commit `6fe7e53`）：observer 开槽即固化身份、
     `duplicate-source-event-id` 硬错误守卫、归属失败 strict exit 2
   - 代码实施两步：`canonical/FNV` 原语下沉进 core `source_identity` +
     `DshUsageObservation` 携固化身份（commit `ba01147`，四执行环境共用 helper、
     `request_metrics` 输出字节冻结）+ `dsh_usage_fact.{py,rs}` emitter +
     `dsh-usage-facts` CLI + 23 验收（18 direct-call + 5 语料 byte-parity）
     （commit `753cbdc`）
9. ✅ Stage 3 commit → v0.7 完成记录写进 `VITALS_CORE_V0_7_DATA_PLANE_SPEC.md`
   §7（本 doc commit，2026-09-03）；§3「明确仍未开始」清单与 §4 候选表候选 #3
   行同步——三家 adapter emit 段收尾，落盘/物化视图/候选 #4 真实迁移仍未开始
   （§0「提案，未立项」不变），workbuddy 流继续排除

## 6. 与既有纪律的对照

- ✅ **零新数据、零新持久化**：UsageFact 在 adapter 内存 emit，**不**
  写盘（候选 #4 真实持久化等真实调用点出现再做）
- ✅ **Python↔Rust 双语言 lockstep**：每个 Stage commit 都含 byte-parity
  钉测（与既有 `test_cli_matrix.py` 同款）
- ✅ **Golden runner 零漂移**：不动 schema、不动 golden 快照
- ✅ **workbuddy 流不动**：用户已明确排除；本文件**不覆盖** workbuddy
- ✅ **不动 v0.7 §3 已落地的视图**：CLI/menubar 接线（a577497 + 7bd1349）
  的输出面与本文件决策互不干扰——UsageFact 是**输入面**投影，
  §3 视图是**输出面**消费
- ✅ **spec §5 逐项评审**：本文件本身是一次"决策评审"，4 项决策
  拍板后写进 spec §7 记录
- ✅ **R1 架构审核**：用户在 1c697db 提交后外部修订 Stage 1 规格
  （R1 v0.0.2：共享 extractor + per-message emit，区别于原 v0.0.1
  聚合层 emit）。修订本身是更深入的分析——R1 把粒度从聚合层升
  到原始 row、身份从 derived-hash 升到 native、observation_kind
  从 ledger-rollup 升到 assistant-usage。本 Stage 1 必须按 R1
  实施，按聚合层实施属于违规。
