# v0.9 Stage 0（Data Access Foundation）执行研究

> 前置：`docs/AGENT_VITALS_V0_9_DATA_VALUE_ARCHITECTURE_SPEC.md`（R3，2026-09-05）
> 触发：用户在 v0.8 收口后追加决定——WorkBuddy 的 `SessionStore::workbuddy()`
> 缺口"不做，留待 v0.9"；随后要求"先搭建好数据写入和获取的架构，解决本质
> 问题（workbuddy 的问题先不处理）"，即把 `r2a_store.rs`（用户此前点名的
> "v0.9 数据底座核心迁移对象"）纳入 v0.9 Stage 0 范围，但明确不在这一步
> 给 WorkBuddy 接真实数据源。

## 1. 对 spec R3 的分析结论

通读 spec 全文，对照现有 v0.8 终态架构（`docs/AGENT_VITALS_V0_8_ARCHITECTURE_SPEC.md`
+ 本仓库 `crates/*/tests/dependency_budget.rs` 的纯度墙），**没有发现阻塞性问题**：

- 新 crate `agent-vitals-data`（spec §3.1）插在 `agent-vitals-harnesses` 与
  `agent-vitals-runtime` 之间，依赖方向 `domain ← harnesses ← data ← runtime`
  与现有单向 DAG 不冲突，不产生环。
- `rusqlite` 已经是 `agent-vitals-harnesses` 的 `sources` feature 下的可选依赖
  （WorkBuddy `~/.workbuddy/workbuddy.db` 只读用）；spec §5.1 把"共享数据
  写入"的 SQLite 使用放进新 `agent-vitals-data`，不是引入新技术栈，只是
  挪动职责边界。
- spec §3.2"DSH 是参考实现，不是数据模型"与本仓库既有纪律一致（`evidence.rs`
  "adapter 不得用读不到的东西刷覆盖"、`harness_capability.rs` 的
  `unmeasured_signals`/`degraded_rules`——都是"能力声明与实现分居"的同一
  思路，spec 只是把这条思路从 behavior 规则扩到成本/账单)。
- **WorkBuddy 排除已经是现状，不是要新发明的概念**：
  `apps/cli/src/agent/harness_runtime_registration.rs` 的
  `workbuddy_has_neither_session_store_nor_fold_registration` 测试已经钉死
  "WorkBuddy 无 SessionStore/无 fold，留给 M4"这一事实。spec §3.1 的
  `excluded_harnesses` 字段与这个既有事实天然对应——Stage 0 只需要把这同一个
  事实，从"CLI 二进制内部的注册表"抬到"跨执行环境查询层的显式字段"，用户
  "workbuddy 的问题先不处理"的决定与现状完全一致，不需要额外设计。

**唯一要指出的问题不是 spec 本身的缺陷，而是粒度**：spec §7 把 Stage 0 写成
一条扁平清单，但清单里其实是 7 条相对独立、体量总和堪比整个 v0.8 D+E7
阶段的工作流。按本仓库一贯纪律（每步独立提交、测试全绿、golden 兜底），
需要像 v0.8 A→F 一样再拆一层，否则任何一步出错都难以定位到具体提交。

## 2. Stage 0 的内部拆分（0.1 – 0.7）

| 步骤 | 内容 | 依赖 | 产出位置 |
|---|---|---|---|
| 0.1 | 冻结 Data Query API 的纯 DTO 契约（`MonthlySummary`/`DailySummary`/`BillingBasis`/`CostBasis`/`Freshness`/`CoverageStatus`）+ 三条不变式的可执行校验 | 无 | `agent-vitals-domain::domain::data_contract`（本次落地） |
| 0.2 | 建 `agent-vitals-data` 空 crate（workspace member），加入 default-members，`repository`/`store`/`projection` 模块骨架，只依赖 domain（还不连 harnesses/SQLite） | 0.1 | `crates/agent-vitals-data/` |
| 0.3 | Stage 0 的"只读 JSON adapter"：复用现有 `r2a_store.rs::harness_snapshot`/DSH `today/month`/Claude ledger 的输出，在 `agent-vitals-data::projection` 里组装成 0.1 的 DTO；WorkBuddy 显式进 `excluded_harnesses`，不读它的任何真实数据源 | 0.1, 0.2 | `agent-vitals-data/src/projection/` |
| 0.4 | CLI application-layer extraction（spec §5.2）：把 `apps/cli/src/agent/r2a_store.rs` 的 `SessionStore` 缓存/checkpoint/分页所有权迁进 `agent-vitals-runtime`；三执行环境 `*_usage_fact.rs` 的 wire 解释迁进 `harnesses/<harness>/sessions/` | 0.2 | `agent-vitals-runtime/`, `agent-vitals-harnesses/harnesses/<h>/sessions/` |
| 0.5 | Tauri/CLI 改接：新增 `agent-vitals data coverage`/`monthly-summary` 只读诊断命令，调用 0.3 的 projection；旧命令保留一个版本周期，内部改走同一路径 | 0.3, 0.4 | `apps/cli/`, `apps/desktop/src-tauri/` |
| 0.6 | 控制台诚实展示：Tauri 面板/CLI JSON 输出 `freshness`/`coverage`/`excluded_harnesses`，stale/partial 不得渲染成 0 或"正常" | 0.5 | `apps/desktop/src-tauri/` |
| 0.7 | 四执行环境（DSH/Claude Code/Codex/WorkBuddy）的 v0.9 最小接入契约 fixture（spec §3.3 表）；WorkBuddy 的 fixture 断言"声明但排除"，不要求真实数据 | 0.1–0.6 | `fixtures/`, `tests/` |

0.4 直接对应用户点名的 "SessionStore 问题"；0.7 是 WorkBuddy 唯一会被触及的
一步，且只到"显式声明排除"为止，不实现 `SessionStore::workbuddy()` 或任何
WorkBuddy 数据读取——与"workbuddy 的问题先不处理"的决定一致。

## 3. 0.1 完成记录

**落地**：`crates/agent-vitals-domain/src/domain/data_contract.rs`（新文件）+
`domain/mod.rs`/`lib.rs` 的模块登记。

- 类型：`BillingBasis`（spec §4 表五档，`summable_into_total()` 把"能否冒充
  真实账单"列翻成可执行谓词）、`CostBasis`（spec §0.1 的 measured/derived/
  estimated/unresolved 四档）、`FreshnessState`/`Freshness`、`CoverageStatus`
  （`denominator_version` 显式版本化分母）、`HarnessAmount`、`MonthlySummary`、
  `DailySummary`。
- 序列化**不用 `serde` derive**——核实过 `agent-vitals-domain` 现有类型
  （如 `contracts::harness_capability::HarnessProfile`）全部手写
  `as_str()`/`json!()`，`serde` 派生宏从来不是这个 crate 的依赖；本次最初
  按 spec 的"typed DTO"字面意思写了 `#[derive(Serialize, Deserialize)]`，
  编译期 `E0432 unresolved import serde` 当场报错，改为跟随既有习惯手写
  `to_json()`，不新增依赖。
- 三条不变式钉死为 `contract_violations()`（报告而非 panic，呼应
  `usage.rs::unaccounted_usage` 哨兵一贯做法）：
  1. `excluded_harnesses` 与 `by_harness` 不能同时持有同一执行环境；
  2. `FreshnessState::Unavailable` 不能带 `last_observed_at`；
  3. `CoverageStatus.measured_fields` 不能超过 `total_fields`。
- `HarnessAmount::summable_total()`/`MonthlySummary::total_summable()` **不存
  字段、每次算**——直接吸取 `month.json` 三倍计数事故（见记忆
  `month-json-triple-count-incident`）的教训：同一个数字只要出现两个来源
  迟早对不上。
- 单测覆盖 WorkBuddy 的 `HarnessBilled`（而非 `MeteredActual`）分档、
  三条不变式各自的违规样例、`to_json()` 输出形状（金额不是裸 scalar，
  带着 freshness/coverage）。

**验收**：`cargo test -p agent-vitals-domain --lib data_contract`
10/10 通过；`cargo test -p agent-vitals-domain --test dependency_budget`
10/10 通过（含 `production_source_does_not_touch_files_env_or_clock`——
新文件零 I/O 已过纯度墙）；`cargo build/clippy --release`（workspace）、
`cargo check -p agent-vitals-wasm`、`apps/desktop/src-tauri cargo check`
全绿；`cargo test --release`（workspace）无新增失败。

0.2 起的每一步单独提交、单独验收，遵循同一纪律。

## 4. 0.2 完成记录

**落地**：新 workspace member `crates/agent-vitals-data/`（六个模块骨架：
`evidence`/`store`/`billing`/`coverage`/`repository`/`projection`，只有
`projection` 重新导出 0.1 的契约类型，其余五个目前只是说明未来职责的文档
注释）。`Cargo.toml` 只依赖 `agent-vitals-domain`，不接 `agent-vitals-harnesses`/
`rusqlite`——`tests/dependency_budget.rs` 把这个"现状"钉成可执行断言，并在
注释里明写这是 Stage 0.3/Stage B 会按计划放开的收紧，不是永久上限。

**验收**：`cargo test -p agent-vitals-data` 2/2；`cargo build/clippy
--release`（workspace）全绿；`cargo check -p agent-vitals-wasm`、
`apps/desktop/src-tauri cargo check` 全绿；`cargo test --release`
（workspace，33 个 test binary）全部 0 failed。`.github/workflows/*.yml`
核实过不需要改——三个 workflow 都是 `cargo test/clippy/build --release`
workspace-root 命令，不硬编码 crate 列表，新 member 靠 `default-members`
自动纳入。

0.3（只读 JSON adapter，把 `r2a_store.rs::harness_snapshot` 现有输出组装成
`MonthlySummary`/`DailySummary`）是下一步。

## 5. 顺序更正：0.3 与 0.4 对调（同 v0.8 E7.5/E7.6 的教训）

动手设计 0.3 时核实依赖方向，发现计划顺序又一次是反的——跟 v0.8 E7.5/E7.6
撞见的问题同一类，本节按同一纪律记录更正，而不是悄悄改顺序。

`harness_snapshot`/`SessionStore`（"今日/本月折叠"的现有实现）目前整个住在
`apps/cli/src/agent/r2a_store.rs`——DAG 最顶层。`agent-vitals-data`（依赖
`domain`，未来加 `harnesses`）与 `agent-vitals-runtime`（依赖 `harnesses + data`）
都在 `apps/cli` **之下**，谁都不能反过来依赖二进制里的这份逻辑。如果先做
"0.3 读 adapter"，能拿到这份数据的唯一办法是把组装代码也写进 `apps/cli`
本身——但那正是 spec §0.1 门槛"CLI 不再拥有执行环境 wire 解释或事实写入"要
消灭的形态，而且 0.4（CLI application-layer extraction）一旦把
`SessionStore` 搬进 runtime，这段刚写的组装代码又要跟着搬一次，等于重复
劳动。

更正后的执行序：**0.3 = CLI application-layer extraction（原 0.4）→
0.4 = 只读 JSON adapter（原 0.3，现在天然长在 runtime 里，可以直接调用
刚迁移过去的 SessionStore）**。0.5-0.7 的编号与内容不变，只是现在依赖
0.3/0.4 的顺序而非原表格的 0.3/0.4。

架构判断：`agent-vitals-data::repository` 定义**接口**（trait +
`agent_vitals_domain::data_contract` 的 DTO），Stage 0 的**实现**
（读现有 `state.json`/ledger/`SessionStore` 缓存拼出 DTO）放在
`agent-vitals-runtime`——这是仓库里已经有先例的"契约低、I/O 高"分层
（`harness_capability::HarnessProfile` 声明能力 vs. 二进制侧
`HarnessRuntimeRegistration` 声明实现存在性），不是新发明一层抽象。

## 6. 0.3 依赖闭包核实：6 文件确认 + 1 处必要例外（claude_cost.rs 不整体搬）

用户在上一轮已经拍板"整体搬（推荐）——6 文件当作一个整体迁进 runtime，不做
render/compute 拆分，每个文件单独 commit + 全量测试"。动手前逐文件 grep
`crate::`/`use crate::` 核实了每个文件的真实闭包，六个文件确认为：
`r2a_store.rs`、`codex_session_audit.rs`、`codex_cost.rs`、`discovery.rs`
（DSH 专用，非已迁移的 `skills::discovery`）、`behavior.rs`、
`claude_cost.rs`（只要其中一个函数）。前五个逐一核实是**干净的整体搬迁
候选**：

- `codex_cost.rs`：零 `crate::` 依赖（只有一行注释提到旧路径），纯叶子。
- `behavior.rs`（248 行，`audit_session_log` + `audit_payload` 两个 I/O
  入口）：唯一的 `crate::` 依赖是 `crate::agent::cost::{load_pricing,
  cost_report, cost_series}`——核实 `apps/cli/src/agent/cost.rs` 本身只是
  `pub use agent_vitals_domain::cost::{...}` 的薄封装（2026-08 cost 迁 core
  时留下的兼容层），搬移时直接改成 `agent_vitals_domain::cost::*`，等于
  绕过一层二进制侧转发，不新增依赖。
- `discovery.rs`（DSH 专用，726 行）：只依赖 `agent_vitals_runtime::{home,
  takeover}` + `agent_vitals_domain::takeover`（均已就位）；测试用的
  `crate::util::ENV_LOCK` 需要换成 runtime 自己 `lib.rs` 已存在的
  `crate::ENV_LOCK`（这颗锁本来就是 v0.8 D6 迁移时特意留的双份之一，
  注释原文写"二进制侧 `src/util.rs` 有一份同款给留在 binary 的
  `discovery`/`r2a_store` 测试用"——现在这两个文件都要搬走，binary 侧那份
  锁在这两个文件搬完后成为死代码，见下方处理）。
- `codex_session_audit.rs`（501 行）：只依赖 `codex_cost`（本轮同批搬）+
  已迁移的 `agent_vitals_harnesses::{codex_session, codex_evidence,
  codex_usage}`。
- `r2a_store.rs`（2708 行）：`crate::` 依赖精确为
  `codex_session_audit`/`discovery`/`codex_cost`/`behavior::audit_payload`/
  `claude_cost::claude_ledger_day_tokens` 五项，与此前核实一致，没有第六个
  隐藏依赖。

**`claude_cost.rs`（1342 行）是唯一不能整体搬的**——不是风格选择，是真实的
双向耦合会破坏编译：`claude_cost.rs` 从
`crate::agent::claude_usage_fact::{parse_claude_usage_row, UNATTRIBUTED,
UNREADABLE}` 取值，而 `claude_usage_fact.rs`（CLAUDE.md 钉死的 v0.7
UsageFact 发射器之一，Python↔Rust byte-parity lockstep + 两份打包白名单
+ `test_classification.py` 逐字段钉住的模块清单，明确不在这次搬移范围内）
反过来又从 `claude_cost.rs` 取 `day_from_iso_ts`/`ms_from_iso_ts`/
`row_tokens`。若整体搬 `claude_cost.rs` 进 runtime，要么把
`claude_usage_fact.rs` 也拖进去（把 pinned lockstep 模块的搬迁纳入这次
无关的范围，代价远超收益），要么产生 runtime 反向依赖 apps/cli 的真实
编译错误——两条路都不对。

核实 `r2a_store.rs` 实际只用到 `claude_cost::claude_ledger_day_tokens`
一个函数，而这个函数是**完全自包含的纯读取路径**：`claude_ledger_day_tokens`
→`ledger_day_total_tokens`（委托 `agent_vitals_domain::cost::
claude_day_total_tokens`）→`ledger_path()`（`agent_vitals_runtime::state::
state_dir()`），零接触 `claude_usage_fact` 耦合的 fold/rebuild 引擎部分。
**处理方式**：只把这三个函数（连同必要的 `ledger_path`）抽成 runtime 里
一个新的小文件 `sessions/claude_ledger.rs`，`claude_cost.rs` 本体（fold
引擎、`claude_sync`、与 `claude_usage_fact` 耦合的部分）原地留在
`apps/cli`。这不是"render/compute 拆分"——是沿着一条真实存在、已经因为
`claude_usage_fact.rs` 被排除在范围外而必然存在的耦合边界切，用户"不做
拆分"的指示针对的是"同一职责内人为切割渲染与计算"，不适用于"两个本来
就分属不同生命周期的子系统凑巧共享过一个小读取函数"这种情况。

另有两处连带的可见性/清理事项：
1. `dsh_usage_fact.rs`（留在 apps/cli）从 `crate::agent::r2a_store::
   {dsh_header, dsh_source_profile}` 取值——这两个函数目前是
   `pub(crate)`，`r2a_store.rs` 搬进 runtime 后必须升级成 `pub`，
   `dsh_usage_fact.rs` 的 import 改成
   `agent_vitals_runtime::sessions::r2a_store::{dsh_header,
   dsh_source_profile}`。
2. `discovery.rs`/`r2a_store.rs` 搬走后，`apps/cli/src/util.rs` 的
   `ENV_LOCK` 若再无其他调用点会成为死代码——搬完最后一个文件后核实并
   视情况删除，而不是留一个没人用的 `pub(crate) static`。

**最终搬迁顺序**（叶子先行，`sessions/mod.rs` 逐步登记）：
`codex_cost.rs` → `behavior.rs` → `discovery.rs` →
`claude_ledger.rs`（从 `claude_cost.rs` 抽取的 3 个函数）→
`codex_session_audit.rs` → `r2a_store.rs`。每步单独 commit + 全量测试
（`cargo build/clippy/test --release` workspace + `cargo check -p
agent-vitals-wasm` + `apps/desktop/src-tauri cargo check`），完全遵循
v0.8 E7.6 建立的"整体搬迁、逐文件提交"纪律。

## 7. Stage 0.3 完成记录

六个提交全部落地（`5584e20`/`fdfa779`/`21f31ed`/`1b232b9`/`5a088e9`/
`3ccafa4`，分支 `v0.9/stage0-data-access-foundation`），每步都是"改路径
→ 全量测试绿 → 提交"，没有一步需要回退重来。几个执行期才浮现、值得记录
的细节：

- **crate 自引用陷阱**：文件搬进 `agent-vitals-runtime` 后，文件内部原本
  写的 `agent_vitals_runtime::foo::bar`（外部路径写法，搬移前从 apps/cli
  这个不同 crate 看它是合理的）必须改成 `crate::foo::bar`——否则
  `E0433 unresolved module`（Rust 不认"用完整包名引用自己"，除非显式
  `extern crate self as`，本仓库没有这么做）。六个文件里 `codex_cost.rs`
  最先撞见这条（`pub use agent_vitals_runtime::clock::{...}` 必须改成
  `pub use crate::clock::{...}`），后续每个文件都要过一遍这项检查——最后
  `r2a_store.rs` 一次性有 9 处 `agent_vitals_runtime::` 自引用要改。
- **`pub(crate)` 在跨 crate 搬移时会变成真实的可见性收紧**：`r2a_store.rs`
  的 `dsh_header`/`dsh_source_profile`、`codex_session_audit.rs` 的
  `codex_session_id_of` 原来是 `pub(crate)`——在旧的单一二进制 crate 里，
  同 crate 的兄弟模块（`dsh_usage_fact.rs`、`r2a_store.rs` 自己）能看到；
  搬进 `agent-vitals-runtime` 后，`pub(crate)` 的"crate"变成了新 crate，
  留在 apps/cli 的调用点立刻编译错误（`E0603 private`）。三处都按需升级
  成 `pub`——`cargo build` 会在第一次尝试时就把这类遗漏精确报出来，不需要
  提前枚举，但要记得升级完之后回头看有没有过度放开（这三个都是"确实有
  跨 crate 消费者"，不是保守放宽）。
- **死代码是搬移完整性的免费验证器**：`apps/cli/src/util.rs` 的
  `ENV_LOCK`（v0.8 D6 就为"discovery/r2a_store 的测试要用它"专门保留的
  二进制侧那份）在最后一个文件（`r2a_store.rs`）搬完后彻底失去消费者，
  `cargo clippy -D warnings` 当场报 `dead_code` 拒绝编译——不是需要人工
  巡查才能发现的遗留物，是构建自己在替这次迁移的完整性把关。删掉即可，
  不必留 `#[allow(dead_code)]`。
- **claude_cost.rs 的真实耦合边界只在实现时才现形**：调研阶段（§6）已经
  推断出双向耦合会挡住整体搬移，但直到读函数体才确认
  `claude_ledger_day_tokens` 恰好是耦合边界之外唯一自包含的读取路径——
  `ledger_path()` 本身仍被 fold 引擎用、不能整体挪走，只挪三个纯函数 +
  它们各自的单测。这印证了 §6 的判断："不做拆分"这条用户指示的适用范围
  是"同一职责内人为切割渲染与计算"，不适用于"两个不同生命周期的子系统
  恰好共享一个小读取函数"——按真实耦合边界走，而不是教条式坚持"六个文件
  必须都是整文件 mv"。
- **测试数字的移动即验证**：每步之后 apps/cli 二进制的测试计数下降、
  `agent-vitals-runtime` 的测试计数按同一数量上升（如 file 6/6：apps/cli
  119→95，runtime 79→103，净移动 24 个，与 r2a_store.rs 原有的 24 个
  `#[test]` 精确对应）——测试总数在整个 Stage 0.3 期间没有变化，只是
  住的 crate 变了，这是"纯代码搬移、零行为改变"的一个可核对信号。

Stage 0.3 到此完成。CLAUDE.md 中"r2a_store/discovery 留 apps/cli/src/
agent/……是合法终态"的旧结论已随本次搬移改写，不再准确，已同步更新。

## 8. Stage 0.4 设计：只读 JSON adapter

### 8.1 依赖图更正：菱形，不是链

动手设计 0.4 之前重读 spec §3.1 的依赖表，发现此前（本文档 §1 与更早的
对话总结）默认的"`domain ← harnesses ← data ← runtime` 线性链"是错的。spec
原文表格逐行写的是：

| crate | 允许依赖 |
|---|---|
| `agent-vitals-domain` | （无） |
| `agent-vitals-harnesses` | Domain |
| `agent-vitals-data` | **Domain**（+ SQLite 驱动）——不包括 harnesses |
| `agent-vitals-runtime` | **Harnesses + Data**（两者并列，不是 data 依赖 harnesses） |

真实形状是菱形：`harnesses` 与 `data`是 `domain` 之下的两个平行兄弟，谁都不
认识对方；只有 `runtime`（唯一知道"这台机器上到底接了哪些执行环境"的层）
同时依赖两者，把两边接起来。这个更正的直接后果：**`agent-vitals-data`
结构上不可能自己完成"读 SessionStore/state.json 拼 DTO"这件事**——它连
`agent-vitals-harnesses` 都够不到，更别说 `agent-vitals-runtime` 里的
`SessionStore`。§5 那条"contract 低、I/O 高"的判断（接口在 data，Stage 0
实现在 runtime）不是风格偏好，是这张依赖表唯一能编译通过的形状。

### 8.2 推迟项：`{claude,codex,dsh}_usage_fact.rs` 的执行环境归位

spec §5.2 的目标表第一行写"Claude/Codex/DSH 的 wire → UsageFact emitter"
目标位置是 `harnesses/<harness>/sessions/`——而这三个文件目前仍在 `apps/cli/
src/agent/`。本文档 §2 的原表格（0.3 那一行）也把这条纳入过范围，但
实际执行只做了 SessionStore 机器的搬迁（六文件闭包），没有动这三个
emitter——这是一处已发生的范围偏差，在此明确记录，而不是留着不提。

**为什么现在不补**：这三个文件是 CLAUDE.md 钉死的 v0.7 UsageFact 发射器
——Python↔Rust byte-parity lockstep（`tests/test_{claude,codex,dsh}_
usage_fact.py` 的 `AGENT_VITALS_BIN` 差分）、两份打包白名单
（`.github/workflows/package-clawhub.yml` + `tests/
test_clawhub_packaging.py`）共同钉住的模块清单。搬家本身大概率不会破坏
差分测试（它们经 CLI 子进程调用，不直接 import crate），但会触及这些
pinned surface，值得单独一轮改动 + 验证，不该顺路塞进这次的读取面工作。
更关键的是：**Stage 0.4（只读汇总）根本不需要它们**——emitter 写的是
`UsageFact` JSONL，那是 spec §7 "Stage A：事实写入与恢复"的产出物，
Stage 0 的 `MonthlySummary`/`DailySummary` 读的是现有的 `month.json`/
ledger/cost report，两条线此刻不相交。推迟到 Stage A 准备工作时再处理，
不阻塞 0.4。

### 8.3 `agent-vitals-data::repository` 接口

```rust
// agent-vitals-data/src/repository.rs
pub struct MonthlySummaryQuery { pub month: String }
pub struct DailySummaryQuery { pub date: String }

pub trait SummaryRepository {
    fn monthly_summary(&self, query: &MonthlySummaryQuery) -> MonthlySummary;
    fn daily_summary(&self, query: &DailySummaryQuery) -> DailySummary;
}
```

Stage 0 只需要 `month`/`date` 两个查询维度；spec 示例里的 `harness_scope`/
`billing_scope` 过滤留给 Stage B（那时才有 SQLite 索引可供按条件查询，
Stage 0 的实现天生返回"所有已知执行环境"，加过滤参数只是摆设）。

### 8.4 Stage 0 的具体实现落在 runtime，一个执行环境一个提交

`agent-vitals-runtime` 新增对 `agent-vitals-data` 的依赖，实现
`SummaryRepository`（具体类型待实现时定，暂定 `JsonSummaryRepository`）。
按 §6 同样的"整体搬迁、逐步提交"节奏，这次是"逐执行环境接线、逐步提交"：

1. **DSH（本轮实现）**：复用 `budget.rs` 已有的 `compute_month`/
   `read_month`（升级成 `pub(crate)`，供新模块调用，不新写第二份读取
   逻辑）→ `agent_vitals_domain::cost::month_cost` 已经给出
   `{total, peak_total}`。记账口径定为 **`BillingBasis::MeteredActual`**
   ——不是 `MeteredEstimate`：DeepSeek 官方逐 token 价表是 DSH 的真实计费
   费率（不是第三方猜测价），`priced_day`/`month_cost` 只是把"用了多少
   token"按"官方多少钱一个 token"相乘，这本身就是可观测的真实费用，不是
   估算。
2. **Codex（Stage 0.4b，已接线）**：接 `sessions::codex_cost::
   codex_cost_report`。取数管线与 CLI `codex-cost` handler 完全同一条：
   `codex_rollout_files(HOME)`（live+archived 全局路径排序）→
   `read_codex_session_log` → `codex_fold_file` → `codex_merge_folds` →
   按 `filter_key` 前缀过滤 `by_hour_model` → **重算 by_model**
   （`codex_by_model_from_hours`——merge 的 by_model 不读小时轴，拿它折
   回去是空模型轴，真实 defect，见 `main.rs::codex_report_from_merged`
   注释）→ 计价。三个决定：
   - **记账口径 = `ApiEquivalent`**（不是 MeteredActual/Estimate）：Codex
     消耗的是订阅套餐配额，按官方 API 价目折出的 USD 是"套餐消耗的等价
     API 标价"——spec §4 原话"只作诊断"，`summable_into_total()` 对它是
     false，不会混进月度总额冒充真实账单。订阅费本身（FixedSubscription）
     Stage 0 没有声明来源（用户的 ChatGPT 账单不在本机证据里），不编。
     USD 与 DSH 的 ¥ 的区别就由口径本身承载：两者永远不会被加到一起，
     因为可汇总总额只收 summable 三档。
   - **`has_unresolved = unpriced_tokens > 0`**：报告里有 token、价目表
     认不出模型（prefix + speed 双键都没命中）→ "看见了、没价目"，金额
     0 + `has_unresolved`，不当"没测到"也不编价。
   - **日切片金额取 `days[]` 里 `date == 查询日` 那一行**，不取
     `total_cost_usd`：untimed 样本没有日期归属（`codex_aggregate_hours`
     丢它们是设计），月视图取 total（含 untimed 剩余、per_model 已并），
     日视图取日行——untimed 不能混进某一天。过滤窗内没有任何小时桶（
     `days` 空）→ Unavailable 不是 $0；`unaccounted` 无时间归属、跨月份
     保留（数据质量哨兵），不能归进任何月份窗，不参与判断。
3. **Claude Code（Stage 0.4c，已接线）**：读 `sessions::claude_ledger`
   同一份 `state_dir()/claude-ledger.json`（`days: {日期: {模型: 4 型
   snake}}` flat 直图），计价走 core 单一决策点
   `agent_vitals_domain::cost::claude_day_cost`（托盘 overview 的
   claude 今日/当月估、CLI 会话账同一份读法分界）。窗口内逐日折算后按
   `currency_totals` 同币合并（claude 无时段价、同币相加安全——托盘
   `claude_estimates` 原注释），**跨币永不相加**。决定：
   - **两个 basis 的分栏是托盘既有口径的 DTO 化**（`metered_amount` 注释
     原文）：CNY 流（deepseek 顶层官方卡按量折算，但 ledger 折叠看不到
     真实逐请求拆分、relay 恒定低命中使估算是保守上界，托盘合并行因此标
     `≈`）→ **`MeteredEstimate`**；USD 流（anthropic 目录卡视作套餐覆盖，
     spec §3.1 原话"混币不能相加"）→ **`ApiEquivalent`**。两个 basis 都
     不 summable，总额仍只收 DSH 的 MeteredActual。
   - **`has_unresolved = unpriced_tokens > 0 或任一日 pricing_basis ==
     "partial"`**（时变卡没有峰谷分辨率）。
   - **全 unknown 日（有 token、无钱）→ 金额表留空 + `has_unresolved`
     + freshness 照报**：`CostBasis::Unresolved`"不得归零"的纪律——观测
     到了但价不可确认，既不当 0 也不当没测。
   - **已知局限**：ledger 只装当月（`claude_sync` 全量重建时滚动），历史
     月份诚实报 Unavailable——与 DSH 有 month-archive.json 归档不同，
     claude 侧确实没有可读的历史数据，不是"有而不读"。
   - `claude_ledger.rs::ledger_path` 升 `pub(crate)`——路径字面量单点。
4. **WorkBuddy**：永久留在 `excluded_harnesses`（用户决定"不做，留待
   v0.9"——见本文档头部）。

前三步落地前，尚未接线的执行环境（Codex/Claude Code）**临时**放进
`excluded_harnesses`——`data_contract.rs` 的文档注释原文就是"已知存在但本
版本不产出数据的执行环境，例如 WorkBuddy 在 v0.9 Stage 0 之前"，本轮的
Codex/Claude Code 完全符合这个定义，接完各自的提交后就从
`excluded_harnesses` 移进 `by_harness`。**这与 WorkBuddy 的排除性质不同**：
WorkBuddy 是用户决定的永久范围外，Codex/Claude Code 是"这个提交还没写
到"的临时状态，两者共享同一个字段是因为对 UI 而言效果一样诚实（都不能
假装有数据），但研究文档要把"为什么排除"的区别记清楚，不能让读者以为
WorkBuddy 和 Codex 是同一类问题。

### 8.5 Freshness 的 Stage 0 近似

spec 没有给"新鲜窗口"的具体阈值，Stage 0 用一个明说的粗近似：月度数据
里最晚的日期键若是北京"今天"或"昨天"（覆盖 `rotate_today` 还没跑的
边界）→ `Fresh`；有数据但最晚日期更早 → `Stale`；`compute_month` 返回
`None`（本月完全没有记录）→ `Unavailable`（不是"这个月花了 ¥0"）。
`Partial` 这一档 Stage 0 不产出——它需要"预期应该有但缺了一部分"的判断
依据（比如执行环境本该在线却漏传），Stage 0 没有这个信号来源，留给 Stage B
接入 source status 之后再区分。

汇总层（`MonthlySummary.freshness`/`DailySummary.freshness`）的口径
（0.4b 起，多执行环境后不再硬编码取 DSH）：**最新被观测到的执行环境**的新鲜度
——按 `last_observed_at` 取最大（各执行环境统一 `{day}T00:00:00Z` 格式，
字典序=时间序），全部执行环境 Unavailable → 汇总 Unavailable。单看某一个
执行环境会在另一个执行环境更新得更晚时谎报过期或谎报新鲜；汇总回答的是"这份
数据最近还有没有在更新"。`Unavailable` 执行环境必带 `last_observed_at=None`
（domain 不变式 3），天然不参与 max。

## 9. Stage 0.4 完成记录

三个执行环境全部接线（逐执行环境一提交：0.4a DSH `c3a2fba`、0.4b Codex
`4ca0cfe`、0.4c Claude Code `3cb2781`），Stage 0.4 关闭。

**接线总表**（§8.4 设计 → 落地的差异见各条）：

| 执行环境 | 数据源 | 计价决策点 | basis | has_unresolved |
|---|---|---|---|---|
| `dsh` | `budget.rs` 的 month.json / month-archive.json | `domain::cost::month_cost` / `priced_day` | `MeteredActual`（官方逐 token 真实费率） | 恒 false（priced_day 失败走 bucket_cost 兜底，不是 unpriced 语义） |
| `codex` | `~/.codex/{sessions,archived_sessions}` rollout 折叠 | `sessions::codex_cost::codex_cost_report` | `ApiEquivalent`（订阅套餐的等价 API 标价，只作诊断） | `unpriced_tokens > 0` |
| `claude-code` | `state_dir()/claude-ledger.json` 逐日账 | `domain::cost::claude_day_cost` | CNY 流 `MeteredEstimate` / USD 流 `ApiEquivalent`（分栏即托盘 `metered_amount` 口径的 DTO 化，跨币永不相加） | `unpriced_tokens > 0` 或任一日 `pricing_basis=partial` |
| `workbuddy` | — | — | — | —（永久 `excluded_harnesses`，用户决定） |

**落地时比 §8 设计多出的三个决定**（原设计未预见的）：

1. **汇总层 freshness 聚合**（0.4b 引入）：多执行环境后不能硬编码取 DSH——
   `aggregate_freshness` 取 `last_observed_at` 最大的执行环境（全部 Unavailable
   → 汇总 Unavailable），详见 §8.5 追加段。
2. **codex 月过滤后重算 by_model**：与 CLI `codex_report_from_merged` 同一条
   管线的同一处坑（merge 的 by_model 不读小时轴），注释互指。
3. **claude 全 unknown 日**（有 token、无钱）：金额表留空 + `has_unresolved`
   + freshness 照报——`CostBasis::Unresolved`"不得归零"，也不当没测。

**测得的状态**：runtime 115 测试（summary.rs 11 个：DSH 2 + codex 5 +
claude 4，其中接线结构测试钉"excluded_harnesses 只剩 workbuddy、coverage
3/3、总额只收 summable 档"）；全仓 gate 全绿（clippy -D warnings、
workspace 1009、wasm + src-tauri check、Python 1155、golden 15/15）。

**诚实性自查**（对照 spec §0.1 的三条数据源状态可见要求）：
- 无数据 → Unavailable（不是 0）：三执行环境各有测试钉住（`*_miss_is_
  unavailable_not_zero` / `no_month_json_*` / `codex_other_month_*`）。
- 估算不冒充账单：DSH 之外所有金额都在非 summable 档；`total_summable()`
  只收 MeteredActual/FixedSubscription/HarnessBilled——接线结构测试逐字节断言
  总额 == 各执行环境 summable 档之和。
- 未接线/范围外执行环境可见：`excluded_harnesses` 恒含 workbuddy，coverage 分母
  3/3 由 `denominator_version=1` 钉住（Stage B 加执行环境时 bump）。

**下一步**：Stage 0.5——`agent-vitals` CLI 增只读 subcommand（经
`SummaryRepository` trait 调 `JsonSummaryRepository`，CLI 不直接 new 具体
类型——依赖方向 apps→data→domain 才有意义），把这份 DTO 端给控制台/
Tauri；0.5 落地后控制台"总览/日历"两页的数据接入才具备并行条件
（同一份冻结契约，两页互不阻塞）。

## 10. Stage 0.5 完成记录

**落地**：`agent-vitals data coverage [--month YYYY-MM] [--json]` 与
`agent-vitals data daily --date YYYY-MM-DD [--json]`（`apps/cli/src/main.rs`
的 `Data`/`DataAction` + `apps/cli/Cargo.toml` 新增 `agent-vitals-data` 依赖）。

- **命名决定**：spec §3.1 的 API 列了 `coverage_status(CoverageQuery)`，§7
  建议命令只写了 `data coverage`——Stage 0 的 repository 没有独立
  coverage 查询，MonthlySummary DTO 本身承载 coverage/excluded_harnesses，
  所以月视图沿用 spec 建议名 `coverage`，不设第二个命令打印同一份 DTO
  的另一种排版（原 §2 表里写的"monthly-summary"并入 coverage，Daily 走
  `data daily`）。
- **trait 边界**：CLI 拿 `Box<dyn SummaryRepository>`，不 new 具体类型、
  不读任何 state 文件（spec §3.1 依赖表"apps 只消费 Runtime 的版本化
  DTO"从这一步起对 Data 面成立）。`--json` 就是 `to_json()` 原样——CLI
  不造第二种 JSON 形状。
- **文本视图是 CLI 的呈现职责**（spec §3.1：data 层不做 UI 呈现），诚实
  规则与 DTO 同源：Unavailable → `no data (unavailable)` 绝不渲染 0；
  金额一律带 basis 标签（estimate/api_equivalent 不冒充账单）；不标货币
  符号——Stage 0 DTO 刻意不带 currency（0.4c 的决定），文本视图不重新
  发明。
- **顺带修掉的 domain 缺陷（负零）**：`data coverage --json` 首次把空
  执行环境的 `summable_total` 序列化出来，实测 Rust 对空迭代器 `Sum<&f64>`
  产出 **-0.0**、serde_json 原样序列化成 `"-0.0"`——无数据执行环境在冻结
  DTO 里显示负零，读起来像"欠 0 元"。三处 `total_summable`/`summable_
  total` 改显式 `fold(0.0, …)`，回归测试
  `empty_summable_is_positive_zero_never_negative_zero` 钉住算术与序列化
  两面。
- **验收**：新 `tests/test_data_summary_cli.py`（Rust-only，同 test_r2a
  二进制用例约定，未设 `AGENT_VITALS_BIN` 整体 skip）4 用例：空环境
  unavailable/正零/排除表、文本视图不渲染 0、**三执行环境全数据端到端**
  （DSH month.json 8 桶词表 → metered_actual 计入总额；claude ledger →
  metered_estimate 不计入；codex 真格式 rollout fixture → api_equivalent
  不计入——0.4a/b/c 三次接线决策经 CLI 的最终对账）、缺席日 unavailable。
- **过程中踩到的一条既有纪律**：CLI 帮助文本必须纯英文
  （`test_regressions::test_help_defaults_to_english` 钉 `--help` 无
  CJK——"help is scanner-owned text"），`data` 命令首版中文 doc comment
  被它当场拦下；设计注记移入普通 `//` 注释（不进 help）。
- **gate**：clippy -D warnings、workspace 1010、wasm + src-tauri check、
  Python 1159（无二进制 232 skip / 有二进制 4 skip 全绿）、golden 15/15。

**下一步**：Stage 0.6——Tauri 面板接 `SummaryRepository`（控制台诚实
展示：freshness/coverage/excluded_harnesses 必须渲染，stale/partial 不得渲染
成 0 或"正常"）。0.5 落地后，控制台"总览/日历"两页的数据接入已具备
并行条件（同一份冻结契约）。

## 11. Stage 0.6 / 0.7 完成记录

**0.6 工作台 Data Query API 接入**：

| 提交 | 内容 |
 | | |
 | `267199c` 0.6a | `data_monthly_summary`/`data_daily_summary` Tauri 命令层 —— 薄转发 trait → runtime → `JsonSummaryRepository`，src-tauri 91 测试全绿 |
 | `a73d625` 0.6b | 总览/Token 日历两页接 `data_monthly_summary` —— 「数据源」panel（执行环境行 + basis chip + freshness + coverage + excluded + summable）；7 用例 jsdom 验证 ALL PASSED |

0.6b 的纪律（spec §0.1）：
- unavailable 执行环境固定「无数据」，绝不渲染 0.00；DTO 端 `fold(0.0, ...)` 与渲染端双层保险
- 金额一律带口径标签、不带货币符号（DTO 不带 currency：claude CNY 估 + USD 诊断混在同一 map，跨币永不相加；写 "¥549" 就是编造币种）
- staleness 必挂金额旁边：2026-09-01 alert stale 事故里 month.json 与 alert.json 自相矛盾、用户从卡片本身没法判断"是不是真的"的同款教训
- invoke 失败 → panel 单独显示「跨执行环境源状态读取失败：...」，不静默、不拖垮其他卡片

并行执行的小事故：原计划用 subagent 并行做总览/日历两页（0.5/0.6a 落地后用户问"两页并行"），`agent-aa35f5b2`（总览）与 `agent-a4f0e21`（日历）双双在 sandbox 5 小时 API 配额上限处退出（429），worktree 仅有未暂存的初始检查，没有 commit。两个 worktree 已清理（`git worktree remove --force`）。工作收回主树串行做，结果与并行一致——同一份冻结 DTO，两页本身就是同构的，并行的边际收益有限。

**0.7 四执行环境最小接入契约**（`f189969`）：

`fixtures/v09/` 三份语料 + `tests/test_v09_onboarding_fixtures.py` 两层守卫：
- **语料词表层**（无二进制）：DSH 是 8 桶（4 桶 + peak_*）、Claude Code 是 4 型 snake、Codex 是 `last_token_usage` 6 字段——词表漂移（DSH 误用 Claude 字段名导致 priced_day 静默算 0 的真实事故）在这层直接红
- **二进制对账层**（`AGENT_VITALS_BIN` 约定）：语料装进隔离环境 → `data coverage` 逐执行环境断言 basis（dsh=`metered_actual` 计入总额 / claude=`metered_estimate`、codex=`api_equivalent` 不计入）、coverage 3/3；`harnesses --json -` 断言 WorkBuddy「声明但排除」两半同时成立（注册表有行 `session_store=false` + `excluded_harnesses` 在册）

`fixtures/v09/README.md` 的 §3.3 七行交付物 × 四执行环境现状表把 WorkBuddy「声明但排除」显式分开：
- **声明面**：capability 注册表认识它（`unmeasured_signals`/`degraded_rules` 齐全）
- **数据面**：`SummaryRepository` 永远把它放进 `excluded_harnesses`，`by_harness` 里没有它

两侧必须同时断言。注册表删了它的行（"忘记接线"）和 excluded 漏了它（"决定不接"）都会让守卫红掉——回归 vs 清理从来是两回事。

## 12. Stage 0 全段完成状态

**Stage 0（Data Access Foundation）七步全部完成**，分支
`v0.9/stage0-data-access-foundation` 当前 17 个 commit ahead of main，未 push：

```
f189969 Stage 0.7 — four-harness minimal onboarding contract fixtures
a73d625 Stage 0.6b — workbench overview/calendar data-source panel
7a59389 docs Stage 0.4 completion record
267199c Stage 0.6a — data_monthly_summary/data_daily_summary Tauri commands
3cb2781 Stage 0.4c — wire Claude Code into JsonSummaryRepository
4ca0cfe Stage 0.4b — wire Codex into JsonSummaryRepository
da2cbe8 Stage 0.5 — read-only data coverage/daily CLI over SummaryRepository
c3a2fba Stage 0.4a — SummaryRepository trait + DSH-wired implementation
+ Stage 0.1-0.3 来自前轮
```

**依赖方向最终形态**（spec §3.1 表，与 0.4a 的 §8.1 修正一致）：
```
        domain ← harnesses ← data ← runtime ← apps/desktop, apps/cli
```
`domain` 不依赖任何东西；`data` 只依赖 `domain`（不依赖 harnesses/runtime/spec §3.1 钉死）；
`runtime` 同时依赖 harnesses 与 data（唯一能实现 SummaryRepository 的层）；
`apps` 只依赖 runtime（拿 `Box<dyn SummaryRepository>`，不 new 具体类型，
不读 state JSON）。

**诚实性自查（最终）**：
- 无数据 → Unavailable（不是 0）：三执行环境都有测试钉（`*_miss_is_unavailable_not_zero` / `no_month_json_*`）
- 估算/诊断不冒充账单：`summable_into_total` 三档 + 测试逐字节断言总额等于各执行环境 summable 档之和
- 未接线/范围外执行环境可见：`excluded_harnesses` 恒含 workbuddy；coverage 3/3 由 denominator_version=1 钉住
- 负零修复：`fold(0.0, …)` + 序列化断言（`empty_summable_is_positive_zero_never_negative_zero`）
- CLI / Tauri / 工作台共用一份冻结 DTO：不许在某一层造第二种 JSON 形状
- WorkBuddy「声明但排除」两半各自成立

**v0.9 下一阶段（Stage A+）** —— 见 `docs/AGENT_VITALS_V0_10_VALUE_LOOP_ARCHITECTURE_SPEC.md`。
Stage 0 给的是"读得到"：Data Query API + 冻结 DTO + 三执行环境接线 + 控制台诚实展示。
Stage A 起把 usage_fact 系列搬进 harnesses（spec §5.2 这块在 0.3 阶段延后过、本表留有
scope gap）、SQLite 写盘、HarnessBillRecord、跨执行环境 reconciliation。Stage 0 的 commit
全部干净、独立可回滚。
