# v0.8 Phase D 代码调研 —— 结构重构（不含 v0.7 写盘）

> 用户 2026-09-04：Phase D **只做结构重构 (a)**（`agent-vitals-runtime` crate +
> `HomeResolver` + `harnesses/<h>/sources/` 迁 I/O + `adapters`→`harnesses` 改名 + wire/fold
> 分离 + `cost.rs` 拆）。**不做** (b) v0.7 延期写盘（`UsageFact` writer / materialized
> view / R2a 增量失效）与 (c) migration 框架 —— 那两项另立 goal。E 在 D 完全稳定后做。
>
> 与 Phase C 同纪律：每 sub-step 独立小提交，全量门禁（`cargo test/clippy`、
> `cargo check -p agent-vitals-wasm`、`src-tauri cargo check`、`python -m unittest
> discover tests`、golden 15+15）逐字节零漂移，红即停。

## 0. 现状盘点（2026-09-04）

| 面 | 现状 | 目标 |
|---|---|---|
| **纯计算 + 词表** | `agent-vitals-domain`（`contracts/` + `domain/` + `compatibility/`）| 不变 |
| **DSH wire 解析** | `domain/dsh/{evidence,audit,compaction,waste}` + `domain/coords.rs`（登记债）| → `agent-vitals-harnesses/harnesses/dsh/sessions/` |
| **harness wire 适配** | `agent-vitals-adapters/harnesses/<h>/sessions/`（Claude/Codex/WorkBuddy evidence）+ `canonical_usage.rs` | → `agent-vitals-harnesses`（改名）+ `harnesses/<h>/{skills,capability}` 补齐 |
| **harness I/O** | 二进制 `src/`：`dsh.rs`(zstd 938 行)、`agent/discovery.rs`(733)、`agent/{claude,codex,workbuddy}_session*.rs`、`agent/{claude,codex,dsh}_usage_fact.rs` | → `agent-vitals-harnesses/harnesses/<h>/sources/`（`#[cfg(feature="sources")]`，`ruzstd`/`rusqlite`/`walkdir` optional）|
| **非执行环境 runtime** | 二进制 `src/agent/`：`state.rs`(827)、`r2a_store.rs`(2708)、`takeover.rs`(571)、`budget.rs` state 部分、`session_sources.rs` | → 新 `agent-vitals-runtime` crate |
| **HomeResolver** | 散在 `src/util.rs::data_home`、`agent/discovery.rs::dsh_home`、`src/main.rs` 里 8+ 处 `std::env::var("HOME")`、`src-tauri/overview.rs`、`scripts/agent_vitals/paths.py` | → `agent-vitals-runtime/user/home.rs` 单点 + 跨实现契约测试 |
| **cost.rs** | `domain/cost.rs` 单文件 1842 行（`load_pricing`/`cost_report`/`cost_series`/`priced_day`/`bucket_cost`/`month_cost`/`today_cost`/`cost_block`/`claude_*_cost`/订阅估算）| 拆 `domain/cost/{pricing,report,series,day,claude}.rs`，扁平 re-export 不变 |

**I/O 足迹**：`src/` 23 个 `.rs` 文件、587 处 `std::fs`/`process`/`env`/`File`/
`read_dir`/`walkdir`/`ruzstd`/`rusqlite` 命中。

**wire/fold 分离的拦路石**（同 Phase C §6ter）：`domain/behavior.rs` 的 inline
`#[cfg(test)] mod tests` 用 `build_dsh_evidence` 造 `CanonicalSession` fixture
（`canonical_from` / `canonical_with_coverage` + ~15–20 个测试）。`build_dsh_evidence`
迁进 `agent-vitals-harnesses` 后，inline test 跨 crate 传 `CanonicalSession` +
`[dev-dependencies]` 成环 → `multiple versions of crate`。**解法**：那批测试 + helper
搬去 `crates/agent-vitals-domain/tests/behavior_canonical.rs`（integration test —
`agent-vitals-domain` 只编一遍，`agent_vitals_adapters` 作 dev-dep 无碍，见 Phase C
Step 3 已验证 `sv6*_parity.rs` 的同款用法）。

## 1. Sub-step 分解（每步独立提交）

### D1 —— wire/fold 分离（Phase D 首项，清 Phase C 债）
`domain/dsh/{evidence,audit,compaction,waste,mod}.rs` + `domain/coords.rs`
→ `agent-vitals-adapters/src/harnesses/dsh/sessions/{evidence,audit,compaction,waste,coords}.rs`。
- `harnesses/dsh/sessions/mod.rs`：从 `pub use agent_vitals_domain::dsh_evidence` 改真 `pub mod`。
- adapters `lib.rs`：加 `pub use harnesses::dsh::sessions::{audit,compaction,waste}` 扁平别名。
- `domain/lib.rs`：删 `pub mod domain::dsh`、删 `pub use domain::dsh::{...}`、删
  `pub use domain::{coords}`；`trajectory::coord_map` 与 `duration.rs` 改
  `use agent_vitals_adapters::…::coords`? **不行**（domain 不许依赖 adapters）——
  `coord_map` 本身是 trajectory 的 `pub(crate)`，`Coords` 状态机是 DSH wire。
  两条路：(i) `coord_map` 一起迁进 `harnesses/dsh/sessions/`，`duration.rs`/`skill.rs`
  改调 adapters；(ii) `Coords` 留 domain（它只认 `turn/step/call_id` 抽象字段名，
  见 §11.5，勉强算 harness-agnostic）。**倾向 (ii)**：`Coords` 留 `domain/coords.rs`，
  只迁 `evidence/audit/compaction/waste`（它们才真的 match `"tool/call"` 字符串）。
- 二进制 `src/agent/behavior.rs:152-153`：`agent_vitals_domain::{compaction,waste}`
  → `agent_vitals_adapters::{compaction,waste}`。
- wasm `lib.rs` 4 处 + `Cargo.toml`：加 `agent-vitals-adapters` dep，
  `agent_vitals_domain::{audit,compaction,waste}` → `agent_vitals_adapters::…`；
  **wasm-pack 重建 + 重拷 `dsh-client/agent_vitals_wasm_bg.wasm`**。
- `domain/behavior.rs::tests` 里 `build_dsh_evidence` 那批 → `tests/behavior_canonical.rs`。
- 守卫：删 `domain/tests/dependency_budget.rs::domain_dsh_is_the_only_registered_layer2_wire_module`
  + `source_root` 断言去 `"dsh"`（其实是 `domain/` 子目录，`source_root` 只看 src 根，
  实际改的是新增 `domain_has_no_dsh_wire_module` 反向断言）。
- **净效果**：`domain/` 生产代码对 DSH raw 事件形状彻底不知情。

### D2 —— `cost.rs` 拆分（纯 domain 内部，零 harness 耦合）—— ✅ 完成（2026-09-04）

`domain/cost.rs`（1842 行）→ `domain/cost/mod.rs`（1442）+ `domain/cost/claude.rs`（409）。
切最清晰的一条缝：**Claude Code 语料计价（`catalog_2026_09` 第二面）**——`resolve_card_catalog`
/ `catalog_card` / `flat_rate` / `priced_field` / `card_is_time_varying` / `cache_write_rate`
/ `first_tier` / `price_claude_model` / `price_claude_map` / `claude_session_cost` /
`claude_day_cost` / `claude_subscription_uncovered_estimate` / `claude_day_total_tokens`。

- 与 DSH 计价面字节隔离，只用 `super::{get_i64, model_short, norm_model_in}`（子模块可见
  父模块私有项，无需改可见性）。`resolve_card_catalog` 提 `pub(crate)`（`mod.rs::tests`
  用）；4 个 `claude_*` pub fn 经 `mod.rs` `pub use claude::{…}` 保 `cost::claude_*` 扁平路径。
- `include_str!("../../../../scripts/…")` → `../../../../../scripts/…`（深一层）。
- 语义零改：spec §9 的 `models/`+`billing/`+`projection/` 语义解耦另算（并入 Model
  Catalog 需求驱动时）。
- 守卫：`harness_contract.rs::g10_price_claude_map_has_exactly_the_three_registered_callers`
  的源码扫描路径 → `cost/claude.rs`。Python `cost.py` 不切，docstring 里
  `crates/agent-vitals-domain/src/domain/cost.rs` → `cost/mod.rs`。
- **门禁全绿**：cargo test 29 binary、clippy -D warnings、`test_cli_matrix` `both()` 差分、
  `test_cost_*`/`test_catalog_pricing`/`test_canonical_cost`、golden 15+15。wasm 不受影响
  （`wasm/lib.rs` 不引 `cost`）。

### D3 —— `agent-vitals-adapters` → `agent-vitals-harnesses`
- crate 改名，lib name `agent_vitals_harnesses`。`agent_vitals_adapters::` → `agent_vitals_harnesses::`
  全量 rename（binary / wasm / src-tauri / 各 tests）。
- `Cargo.toml`：`ruzstd`/`rusqlite`/`walkdir` 加 `optional = true`，新 `[features] sources = [...]`
  （**先空**，D4/D5 往里填）；wasm 侧 `default-features = false`。
- 目录补 `harnesses/<h>/{skills/,capability.rs}` + `harnesses/<h>/sources/`（空 `mod.rs`，
  `#[cfg(feature="sources")]`）+ `shared/{canonical_json,timestamp,identity}.rs` +
  `registry.rs`。Skill surface 现在住二进制 `src/skills/`——**不迁**（那是 Phase D5/E 的事，
  D3 只建骨架）。
- 新 `tests/harness_boundary.rs`：源码扫描守卫（`std::fs`/`Connection::open`/`ruzstd`/
  `rusqlite` 只许在 `/sources/` 或 `mcp/probe.rs`）。

### D4 —— DSH I/O → `harnesses/dsh/sources/` —— ✅ 完成（2026-09-04）

`src/dsh.rs`（938 行：DSH 会话 JSONL 读取器 + 多帧 zstd 解码 + snapshot 解析）
**整体** `git mv` → `agent-vitals-harnesses/src/harnesses/dsh/sources.rs`，`#[cfg(feature = "sources")]`
在 `harnesses/dsh/mod.rs` 门控整个模块。

- `ruzstd` 从二进制 `Cargo.toml` → `agent-vitals-harnesses` 的 `[dependencies] ruzstd = { optional = true }`
  + `[features] sources = ["dep:ruzstd"]`。二进制 `agent-vitals-harnesses = { features = ["sources"] }`；
  wasm `default-features = false`（§4.0）。
- `split_lines` 提前迁进 `agent-vitals-domain::util`（DSH wire 解析要用；二进制
  `src/util.rs` 改 `pub use`）。
- 二进制 6 处 `crate::dsh::X` → `agent_vitals_harnesses::dsh_sources::X`（`lib.rs` 扁平别名，
  `#[cfg(feature = "sources")]`）；`src/main.rs` 删 `mod dsh;`。
- **pure/impure 未细分**（`sessions/wire.rs` vs `sources/reader.rs`）——D4 的关键是「I/O
  出二进制、进 harnesses、feature-gated」，wasm 本就不碰 dsh.rs 任何函数，整块 gate 可行。
  wire/fold 细分排后续（低价值）。
- 守卫：`harnesses/tests/dependency_budget.rs` 重写成 harness_boundary——`io_tokens_only_appear_under_sources`
  （`std::fs`/`ruzstd`/… 只许路径含 `/sources`）+ 依赖白名单放行 `optional` I/O crate。
  移进 lib crate 后 3 个读 checked-in fixture 的测试改用 `CARGO_MANIFEST_DIR/../..` 绝对路径；
  `parse_snapshot` doc 里的 JSON 例子加 ```` ```text ```` 围栏（lib crate 跑 doctest）。
- **门禁全绿**：cargo test 29 binary、clippy -D warnings、wasm-pack 重建 + verify-*.mjs、
  src-tauri check、python 1145/226 skip、golden 15+15。

**未迁**：`src/agent/discovery.rs`（DSH session 发现）—— 它 `use crate::agent::takeover`
+ 读 ledger 状态，是 runtime 编排，随 D6 进 `agent-vitals-runtime`（不是 `harnesses/dsh/sources/`）。

### D5 —— Codex / Claude / WorkBuddy session readers → `harnesses/<h>/sources/` —— ✅ 完成（2026-09-04）

`src/agent/{claude_session,codex_session,workbuddy_session}.rs`（689 + 542 + 486 行）
**整体** `git mv` → `agent-vitals-harnesses/src/harnesses/<h>/sources.rs`，`#[cfg(feature = "sources")]`
在各 `harnesses/<h>/mod.rs` 门控。

- `walkdir`（Claude/Codex 会话文件递归枚举）+ `rusqlite`（WorkBuddy sqlite 只读，
  `bundled`）从二进制 `Cargo.toml` → `agent-vitals-harnesses` 的 `optional` +
  `[features] sources = [..., "dep:walkdir", "dep:rusqlite"]`。
- 移入文件 import 修正：`agent_vitals_harnesses::{claude_code,workbuddy}_evidence` →
  `crate::…_evidence`；`crate::util::split_lines`（codex）→ `agent_vitals_domain::util::split_lines`。
- harnesses `lib.rs` 扁平别名 `claude_session` / `codex_session` / `workbuddy_session`
  （`#[cfg(feature = "sources")]`）。二进制 ~20 处 `agent::<h>_session::X` /
  `crate::agent::<h>_session::X` → `agent_vitals_harnesses::<h>_session::X`；`src/agent/mod.rs`
  删 3 条 `pub mod`。
- Python：`test_classification.py::RS_AGENT_FAMILY` 去 `claude_session`/`codex_session`/
  `workbuddy_session`（迁出 `src/agent/`）。
- **门禁全绿**：cargo test 29 binary、clippy -D warnings、wasm check、src-tauri check、
  python 1145/226 skip、golden 15+15。

**仍在二进制**：`{claude,codex,dsh}_usage_fact.rs`（emit 入口，读 session text 后
调 domain 的 UsageFact emitter）、`codex_session_audit.rs`、`claude_cost.rs`/`codex_cost.rs`
（调 session reader + cost）—— 这些是「读证据 → 调纯计算 → 出报告」的 CLI 接线，
随 D6 进 `agent-vitals-runtime` 的 service 层，不是 `harnesses/<h>/sources/`。

### D6 —— `agent-vitals-runtime` crate 装 state 层 —— ✅ 完成（2026-09-04）

`src/agent/{state,budget,takeover,session_sources}.rs` `git mv` → `agent-vitals-runtime/src/`。
runtime deps：`agent-vitals-domain` + `agent-vitals-harnesses { features=["sources"] }` +
`serde` + `serde_json`。

- 日期 helper：`civil_from_unix_secs`（纯）→ `agent-vitals-domain::util`；读时钟的
  `current_month_beijing` / `today_beijing` → 新 `agent-vitals-runtime::clock`。
  `src/agent/codex_cost.rs` re-export 保 `crate::agent::codex_cost::{...}` 旧路径。
- 移入文件 import：`crate::skills::snapshot::data_home` → `crate::home::data_home`；
  `crate::agent::cost::load_pricing()` → `agent_vitals_domain::cost::load_pricing()`；
  `crate::util::{ENV_LOCK,split_lines}` → `crate::ENV_LOCK`（runtime lib.rs 新增一份
  test 用的进程 env 锁）/ `agent_vitals_domain::util::split_lines`。
- 移入文件的 `pub(crate) fn` → `pub fn`（`state_dir`/`read_json`/`now_iso_utc`/
  `atomic_write_json`/`require_rust_owner`/`folded_in_ledger`/`evaluate_alert_*` 等，
  现在跨 crate 被 `main.rs`/`claude_cost.rs`/`oneline.rs`/`discovery.rs`/`r2a_store.rs` 调）。
- 二进制 ~40 处 `agent::{state,budget,takeover,session_sources}::X` /
  `crate::agent::…` → `agent_vitals_runtime::…::X`；`src/agent/mod.rs` 删 4 条 pub mod。
- Python：`test_classification.py::RS_AGENT_FAMILY` 去 4 个迁出模块；
  `test_takeover_lockstep.py` / `test_state_write_chain.py` docstring 路径。
- **门禁全绿**：cargo test 32 binary、clippy -D warnings、wasm/src-tauri check、
  python 1145/226 skip、golden 15+15。

**未迁（转 Phase E 的 apps/cli 抽出）**：`src/agent/r2a_store.rs`（2708 行）+
`src/agent/discovery.rs`（733 行）。spec §11 说它们进 `agent-vitals-runtime/state/`，
但两者与 CLI 成本/审计 handler（`codex_session_audit` / `*_cost` / `*_usage_fact`）
深度交织——`r2a_store` 调 `csa::codex_session_audit_json` / `csa::render_codex_session`，
`csa` 又调 `codex_cost::codex_cost_report`。Phase E 把这批 CLI handler 抽进 `apps/cli`
时一起归位更干净，避免 D6 里为切一条缝再造 3 层 re-export。runtime 现在装的是
**纯 state/ledger 层**（无 CLI handler 依赖），边界清爽。

### D7 —— `HomeResolver` 单点
`agent-vitals-runtime/src/user/home.rs`：合并 `data_home()`（`AGENT_VITALS_HOME` →
`SKILL_VITALS_HOME` → 默认）、`DSH_HOME`（env → `~/.dsh`）、`~/.claude`、`~/.workbuddy`、
`~/.codex` 的解析。二进制 `src/main.rs` 8+ 处 `std::env::var("HOME")` 收敛到它。
`scripts/agent_vitals/paths.py` 与 `src-tauri/overview.rs` 保持跨实现契约测试
（`tests/test_*` 里已有 isolated-home 夹具模式）。

## 2. 建议执行顺序 / 进度

```
D1  wire/fold 分离          [中 + wasm 重建]   ✅ 完成（commit 6f9af88）
D2  cost.rs 文件切分        [低，纯 domain]    ✅ 完成（commit 1bb232e：切出 cost/claude.rs）
D3  adapters → harnesses 改名   [中，机械面大]    ✅ 完成（commit c07da01，纯 rename）
D4  DSH I/O → sources/      [高，feature-gate 首用]  ✅ 完成（commit 6e1e130）
D5  其他 harness readers       [高，rusqlite 迁移]  ✅ 完成（commit 6f48e2e）
D7  HomeResolver 单点       [中]  ✅ 完成（commit 259a821——**先于 D6**）
D6  agent-vitals-runtime    [高，state 层迁移]  ✅ 完成（本提交；state/budget/takeover/session_sources
                            + clock。r2a_store/discovery 因与 CLI handler 交织，转 Phase E 的 apps/cli 抽出）
```

**Phase D（结构重构）实质完成**。剩 `r2a_store` / `discovery` 两个 CLI-orchestrator
的物理迁移，随 Phase E 把 `src/agent/{codex_cost,claude_cost,codex_session_audit,
*_usage_fact,oneline,behavior,cost,plan}.rs` 抽进 `apps/cli` 时一起归位。Phase D 的
crate 骨架（domain / harnesses / runtime / wasm 四 crate + feature-gated sources）已到位。

### D7 完成记录（2026-09-04）

新建 **`agent-vitals-runtime`** crate（`src/lib.rs` + `src/home.rs`，std-only）。

- `configured_path` / `data_home_from` / `data_home` / `snapshot_dir_from` /
  `snapshot_dir` 从 `src/skills/snapshot.rs` 迁进 `agent_vitals_runtime::home`；
  `dsh_home` 从 `src/agent/discovery.rs` 迁进来。5 个 `data_home_from` 单测跟随。
- `src/skills/snapshot.rs`：`pub(crate) use agent_vitals_runtime::home::data_home;`
  + `pub use …::snapshot_dir;`（旧路径 `crate::skills::snapshot::data_home` 不变）。
  `discovery.rs` 改 `use agent_vitals_runtime::home::dsh_home;`。
- workspace `members`/`default-members` + 二进制 `Cargo.toml` 加 `agent-vitals-runtime`。
- 守卫 `agent-vitals-runtime/tests/dependency_budget.rs`：方向单向（禁反依赖 binary/
  wasm/tauri）+ 日期禁 chrono/time + `home_resolver_is_the_single_source`。
- Python：`test_paths.py` docstring 指向 → `agent-vitals-runtime` 的 `home::data_home_from`。
- **门禁全绿**：cargo test 31 binary、clippy -D warnings、wasm/src-tauri check、
  python 1145/226 skip、golden 15+15。

### D3 完成记录（2026-09-04）

`agent-vitals-adapters` → **`agent-vitals-harnesses`**：`git mv` crate 目录、`name`/`lib.name`
改 `agent_vitals_harnesses`、`agent_vitals_adapters` → `agent_vitals_harnesses` 全量 rename
（52 处：binary/wasm/domain dev-dep/src-tauri/tests/Python docstring）、workspace
`members`/`default-members` + 各 `Cargo.toml` dep 名。**纯改名**——`[features] sources`
空壳与 `tests/harness_boundary.rs` 守卫留给 D4（首个真实 I/O 迁移时一起加，不提前挂空）。

门禁全绿：cargo test（29 binary）、clippy -D warnings、wasm-pack 重建 + verify-*.mjs、
src-tauri check、python 1145/226 skip、golden 15+15。

### D1 完成记录（2026-09-04，本会话）

`domain/dsh/{evidence,audit,compaction,waste,mod}.rs` → `agent-vitals-adapters/src/harnesses/dsh/sessions/`。
`Coords` 留 `domain/coords.rs`（决策 (ii)：`turn`/`step`/`call_id` 抽象字段名，
harness-agnostic；`trajectory::coord_map` / `duration` / `skill` 继续用）。

- adapters `lib.rs`：加 `pub use harnesses::dsh::sessions::{audit, compaction, waste}` 扁平别名。
- domain `lib.rs` / `domain/mod.rs`：删 `dsh` 模块与全部 `dsh::*` 别名。
- 二进制 `src/agent/behavior.rs`：`agent_vitals_domain::{compaction,waste}` → `agent_vitals_adapters::…`。
- wasm `lib.rs` + `Cargo.toml`：加 `agent-vitals-adapters` dep，`audit`/`compaction`/`waste`
  4 处改道；**wasm-pack 重建 + 重拷 `dsh-client/agent_vitals_wasm{.js,_bg.wasm,.d.ts}`**。
- `domain/behavior.rs::tests` 里 14 个 `build_dsh_evidence`-fixture 测试 + 5 个 helper
  → `agent-vitals-domain/tests/behavior_rules.rs`（integration test，无成环）。用私有
  项（`FAMILY1_RULES`/`rule_specs`）或纯 `match_behavior(&[Value])` 的测试留 inline
  （import 改 `agent_vitals_adapters::audit::match_behavior`）。moved `evidence/audit/
  compaction/waste` 的 inline 测试（+29）跟文件迁去 adapters。
- 守卫：删 `domain_dsh_is_the_only_registered_layer2_wire_module`，新
  `domain_holds_no_dsh_wire_module`（`src/domain/dsh` 不存在）；
  `domain_production_code_outside_dsh_…` → `domain_production_code_has_no_harness_adapter_dependency`
  （去掉 dsh 例外，扫全 `src/domain/`）。
- Python：`test_harness_contract.py` 的 G3 matrix + G8 dsh 路径 →
  `crates/agent-vitals-adapters/src/harnesses/dsh/sessions/evidence.rs`；`util.py`/`behavior.py`/
  `dsh_evidence.py` docstring 同步。

**门禁全绿**：cargo test（binary 313 + domain 388 lib + behavior_rules 14 + adapters 85
+ parity/harness_contract/dependency_budget）、clippy -D warnings、wasm-pack 重建 +
`dsh-client/scripts/verify-*.mjs` 7 个全过、src-tauri check、python 1145/226 skip、
golden 15+15 逐字节。

**净效果**：`domain/` 生产代码对 DSH raw 事件形状彻底不知情。arch spec「Phase D 首项」
兑现。

D1/D2 相互独立，可任意先后。D3 是 D4–D7 的前置。D4/D5 平行。D6 依赖 D3。D7 收尾。

## 3. Phase D 明确不做（转独立 goal / Phase E-F）

- v0.7 延期写盘（`UsageFact` writer 落盘、materialized view、R2a `SourceFingerprint`
  增量失效、WorkBuddy `UsageFact` 接入）—— 是新行为，需新 fixture + 持久化测试。
- migration 框架（原子写 / fsync / 故障注入）—— spec 说「出现第二个持久 schema 时」才做。
- watcher / `notify` / Tauri 自动刷新 —— runtime feature，不是结构。
- 目录大搬迁（`apps/` `packages/` `integrations/` `assets/`）—— Phase E。
- `dsh/` + `dsh-client/` → `integrations/`（spec §11 漏登记 `dsh/`，E 时补）。
- MCP surface —— Phase F。
