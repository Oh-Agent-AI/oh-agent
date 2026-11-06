# v0.8 Phase C —— 代码调研（搬迁前置）

> 状态：调研 v1（2026-09-04）
> 目的：Phase C = 抽出 `agent-vitals-domain` crate。搬迁前先把 `domain → harness`
> 依赖债务的**真实形状**摸清——arch spec §11「拆 `usage.rs` 188KB / `cost.rs`
> 99KB」把两件事混为一谈，本调研拆开。
> 基准：`docs/cost-attribution-and-hour-axis-spec` @ `a034394`（Phase A+B1 已合并）
>
> **arch v3.1（2026-09-04）**：执行环境结构从「`agent-vitals-adapters/harnesses/`（纯）+
> `agent-vitals-runtime/sources/`（I/O）双 crate」改为 `agent-vitals-harnesses` **单
> crate + feature-gated `sources/`**（arch §4）。C1–C3 **不受影响**（它们是「domain
> 不 import 执行环境代码」，与执行环境代码怎么组织无关）；下文的「迁 `agent-vitals-adapters`」
> 读作「迁 `agent-vitals-harnesses`（现名 `-adapters`，可择时改名）」。

---

## 0. 结论（TL;DR，2026-09-04 二轮修正）

**耦合分两层，只有第一层阻塞 crate 抽出：**

### 层 1 —— import 耦合（阻塞，6 个点）

`domain/*.rs` 里 `crate::{dsh_evidence, codex_usage}` 的**符号 import**——crate 拆分后
`agent-vitals-domain` 依赖不到执行环境 crate，这 6 处编译失败。

| 点 | 用的东西 | 本质 |
|---|---|---|
| `compaction.rs:22,60` | `Coords` | **DSH 原始事件**坐标状态机（`observe` match `"turn/start"`…）|
| `trajectory.rs:126` | `Coords` | 同上（在 `match_trajectory` raw shim 里）|
| `trajectory.rs:148` | `build_dsh_evidence` | raw shim（唯一调用方 wasm）|
| `behavior.rs:725` | `build_dsh_evidence` | raw shim（唯一调用方 wasm）|
| `waste.rs:25,78` | `tool_invocation` | **DSH 原始事件** → `(name, args)`（match `TOOL_CALL_TYPES` = `"tool/call"`…）|
| `usage.rs:1678,1734,1739` | `codex_fold_file` / `total_signature` | canonical 归一层（**生产零调用点**，只测试用）|

**二轮修正**：一轮误判 `Coords`/`tool_invocation` 是「共享时间线原语、非 DSH wire」——
错。它们 match DSH 原始事件类型字符串（`"turn/start"`/`"tool/call"`），是 **DSH wire
helper**，**不能进 `contracts/`**。用它们的 `domain/{compaction,trajectory,waste}`
函数本身也在解析 DSH raw 事件（见层 2）。

### 层 2 —— wire-shape 耦合（不阻塞，但是真正的架构债）

`domain/{usage,duration,compaction,subagent,skill,waste}.rs` + `behavior/trajectory`
的 raw 入口**直接 match DSH 原始事件类型**（`grep` 实证）：

```
usage.rs      "assistant/chunk" "assistant/message" "request/context" "request/header" "turn/start"
duration.rs   "approval/asked" "approval/decided" "step/start" "step/end" "tool/call" "tool/result" "turn/start" "turn/end"
compaction.rs "tool/call" "turn/start" "turn/end"
subagent.rs   "session" "tool/call" "tool/result"
skill.rs      "session" "tool/call" "tool/result" "turn/start" "turn/end"
```

wasm `lib.rs` 调的 **15 个** domain 函数几乎全在这一层（`token_by_model` /
`hour_buckets` / `request_metrics` / `tool_call_durations` / `compaction_events` /
`subagent_spawns` / `skill_invocations` / `detect_structural_waste` / …）。

**这些函数没有 `crate::dsh_evidence` import**（inline 解析），所以**编译进
`agent-vitals-domain` 不报错**，只是「名义 domain、实为 DSH session adapter」。

### 两个执行选项

| | **C-minimal（推荐）** | **C-full** |
|---|---|---|
| 范围 | 只解层 1 的 6 个点 + 抽 crate | 层 1 + 把层 2 的 DSH-wire 函数全迁进 `agent-vitals-harnesses/dsh/sessions/` |
| `Coords`/`tool_invocation` | 跟着用它们的 raw 函数（`compaction_events`/`detect_structural_waste`/`match_*` shim）一起迁进 dsh adapter；domain 只留 canonical 入口 | 同左，但 usage/duration/subagent/skill 也一起迁 |
| wasm 改动 | 4~5 个函数改 import 到 `agent_vitals_harnesses::dsh::…` | 15 个函数全改 |
| 行数 | ~500（含 waste/compaction 的 helper）| ~2500 |
| golden/parity | 零漂移（CLI `behavior` 走 canonical 不变；wasm 重建重拷）| 零漂移，但面大、验收轮次多 |
| 结果 | `agent-vitals-domain` 抽出，`usage/duration/subagent/skill` 的 DSH-wire 解析**仍在 domain**（记为债，wire/fold 分离另开）| domain 真纯净——`agent-vitals-domain` 只吃 `CanonicalSession`/`CanonicalEvent`/`{by_model,sequence}` |

**推荐 C-minimal**：与「每个 Phase 做一件事」纪律一致。层 2 的完整 wire/fold 分离
是独立迭代（arch §Phase C「不在 Phase C」条 + arch §11「`usage.rs` 拆」），建议排在
Phase D（Runtime + harness `sources/`）**之后**——那时 `harnesses/dsh/sources/` 已落地，
`sessions/` 收 wire 解析顺理成章。

### C-minimal 做完后

- **B2**：`dsh_evidence` + `codex_usage` residual 物理迁进 `agent-vitals-harnesses`，撤 core
  lib.rs 两条 re-export。
- **抽 `agent-vitals-domain` crate**：`domain/` 整体成 crate（含层 2 债），
  `agent-vitals-core` 退成 `contracts/` + `compatibility/` 薄 crate。
- `cost.rs` 99KB 拆分（零 harness import）→ 并入 Phase D。

---

## 1. 完整耦合清单（穷举，`#[cfg(test)]` 已标注）

`grep` 全 `domain/*.rs` 的 `crate::{dsh_evidence,codex_usage,adapters::harnesses}`：

```
domain/behavior.rs:725   [PROD]  build_dsh_evidence(...)          ← match_behavior shim
domain/behavior.rs:1131  [TEST]  build_dsh_evidence(...).canonical
domain/behavior.rs:1151  [TEST]  build_dsh_evidence(...).canonical
domain/behavior.rs:1370  [TEST]  build_dsh_evidence(...)
domain/compaction.rs:22  [PROD]  use crate::dsh_evidence::Coords
domain/trajectory.rs:126 [PROD]  Coords::default()
domain/trajectory.rs:148 [PROD]  build_dsh_evidence(...)          ← match_trajectory shim
domain/usage.rs:1678     [PROD]  codex_fold_file(events)          ← canonical 归一层
domain/usage.rs:1734     [PROD]  total_signature(cur)             ← canonical 归一层
domain/usage.rs:1739     [PROD]  total_signature(prev)            ← canonical 归一层
domain/waste.rs:25       [PROD]  use crate::dsh_evidence::tool_invocation
```

`contracts/` 干净（只有 doc-comment 里提到 `dsh_evidence.rs`）。
`domain/{budget,state,duration,plan,skill,findings,subagent,takeover,canonical_audit}.rs`
—— **零 harness 耦合**。`cost.rs` —— 零 harness import。

### 1.1 `canonical_audit.rs → harness_capability`（非违规，说明）

`domain_to_harness_compatibility_debt_cannot_grow` 把它列进 allowance，但
`harness_capability` 在 `contracts/`（不是 harness adapter），`degrade_rule_outcomes` 是
契约函数。这是 `domain → contract`，**允许方向**，Phase C 不用动。

---

## 2. C-minimal 执行（推荐）

**一句话**：把 `domain/` 里 `use crate::{dsh_evidence,codex_usage}` 的那几个函数
——它们本来就在解析 DSH 原始事件——迁进 `agent-vitals-harnesses/dsh/sessions/`，
`domain/` 只留吃 `CanonicalSession`/`CanonicalEvent` 的纯入口。`Coords` /
`tool_invocation` 跟着一起走（它们是 DSH wire helper，不进 `contracts/`）。

### 2.1 Step 1 —— DSH raw-events 审计函数 → `harnesses/dsh/sessions/audit.rs`

迁移这几个（都在解析 DSH wire、都被 wasm 调、`domain` 里 import 了 dsh_evidence）：

| 函数 | 现位置 | wasm 调 | 二进制调 |
|---|---|---|---|
| `match_behavior(events, ws)` | `domain/behavior.rs:720` | ✅ | ❌（走 canonical）|
| `match_trajectory(events)` | `domain/trajectory.rs:144` | ✅ | ❌ |
| `compaction_events(events)` | `domain/compaction.rs:51` | ✅ | ✅ `src/agent/behavior.rs` |
| `detect_structural_waste(events, reqs)` + `detect_duplicate_tool_results` + `detect_failure_run_waste` + `extract_target` | `domain/waste.rs` | ✅ | ✅ |

`Coords`（struct+impl，dsh evidence :121–205）、`tool_invocation`（:82–98）、
`TOOL_CALL_TYPES`、`args_text` —— **留在 `harnesses/dsh/sessions/`**（本就在那），
迁进来的 4 个函数直接 `use super::evidence::{Coords, tool_invocation}` 或同 crate 路径。

`domain/` 保留：`match_behavior_canonical` / `match_trajectory_canonical`（吃
`&CanonicalSession`，二进制走这条）、`detectors/sv6*`（吃 `CanonicalEvent`）、
`behavior.rs` 的 `flatten`/`rule_outcomes_json`/`behavior_gate`/`waste_coverage` 等
纯投影。

**wasm `lib.rs`**：`agent_vitals_core::{behavior::match_behavior, trajectory::
match_trajectory, compaction::compaction_events, waste::detect_structural_waste}`
→ `agent_vitals_harnesses::dsh::sessions::audit::*`（4 处）。wasm 加
`agent-vitals-harnesses` 依赖（arch §3.1 的 `wasm ─► harnesses` 未来边，带真实调用点落地；
`default-features = false` 只拿纯子树）。

**测试**：`domain/{behavior,waste,compaction}.rs` 里用 `build_dsh_evidence` /
raw events 的 `#[cfg(test)]` 跟着函数搬去 `agent-vitals-harnesses/tests/`（§4 决策点）。

**验收**：`cargo test`/`clippy` 全绿；wasm-pack 重建 + 重拷 `dsh-client/` +
`scripts/verify-timeline.mjs` / dsh-client 差分；golden 15+15 零漂移（CLI `behavior`
走 canonical，不受影响）；Python parity（Python 侧只改 `test_classification.py`
family 归类，函数不搬——§3）。**风险：低**，主要是别忘重建 wasm。

### 2.2 Step 2 —— canonical 归一层 → `agent-vitals-harnesses/canonical_usage.rs`

`domain/usage.rs:1523–1795` 的 `canonical_tokens`/`canonical_total_delta`/
`CANONICAL_DIMS`/`SHAPE_*` —— **生产零调用点**（代码自注 :1529 + 穷举 grep，
Rust/Python 都只测试用，为未做的「#6 事件桥」预留）。搬去 `agent-vitals-harnesses`
crate 根级（跨执行环境 wire 归一，不属单个 `harnesses/<h>/`）：

1. 搬 `canonical_tokens`/`canonical_total_delta`/`CANONICAL_DIMS`/`SHAPE_*` +
   `#[cfg(test)]`。Codex 分支 `use agent_vitals_core::codex_usage`（B2 前）/
   本 crate `harnesses::codex::sessions::usage`（B2 后）；DSH 分支调
   `agent_vitals_core::domain::usage::token_by_model`（harnesses → domain 正向 OK）。
2. `SOURCE_*` 常量：`token_by_date_model(events, source)` 的 `source` 参数用
   `SOURCE_DSH_LIVE`/`SOURCE_CODEX`/`SOURCE_CLI`——查一下归属，留 `contracts/` 或
   `domain/usage.rs`（它们只是标签字符串，非 wire）。
3. `test_canonical_cost.py` + Rust `canonical_tokens_python_rust_byte_for_byte_parity`
   跟着搬。`test_classification.py` / clawhub allow-list 登记 `canonical_usage`。

**验收**：`cargo test`/`clippy`/Python `unittest` 全绿；golden 零漂移（无生产消费方）；
`test_canonical_cost.py` parity 在新位置继续绿。**风险：低**。

### 2.3 至此

`domain/*.rs` 生产代码对 `crate::{dsh_evidence, codex_usage}` **引用归零**（层 1 清）。
`domain/{usage,duration,subagent,skill}.rs` 里的 DSH-wire **inline 解析**仍在
（层 2，不阻塞——见 §0），记为债，wire/fold 分离排 Phase D 之后。

### 2.4 Step 3 —— B2：residual 物理迁移

`agent-vitals-core` 的两条 residual（`adapters/harnesses/codex/sessions/usage.rs` 1547 行、
`adapters/harnesses/dsh/sessions/evidence.rs` 684 行）迁进 `agent-vitals-harnesses`：

1. core `lib.rs` 撤 `pub use adapters::harnesses::codex::sessions::usage as codex_usage;`
   与 `... dsh::sessions::evidence as dsh_evidence;`；core `adapters/` 模块清空/删。
2. `agent-vitals-harnesses/src/harnesses/{codex,dsh}/sessions/` 收下真文件（现在是 re-export）。
3. `residual_harness_adapter_directories_are_explicit_phase_c_debt` → `assert_eq!(actual,
   Vec::<String>::new())` 或删测（core 不再有 `adapters/harnesses/`）。
4. 二进制 `src/agent/*.rs` 的 `agent_vitals_core::{codex_usage,dsh_evidence}` →
   `agent_vitals_harnesses::…`（Phase B1 起二进制已 import `agent_vitals_adapters`，改名即可）。
5. `test_classification.py` / clawhub / harness_contract 路径登记同步。

**验收**：全量门禁 + Python/Rust parity 零漂移。**风险：中**（文件大、面广，但机械）。

### 2.5 Step 4 —— 抽 `agent-vitals-domain` crate

1. `agent-vitals-core/src/domain/` 整体成 `crates/agent-vitals-domain/src/`。
2. `agent-vitals-core` 退成 `contracts/` + `compatibility/` 薄 crate（arch §0）。
3. `agent-vitals-harnesses` / `agent-vitals-wasm` / 二进制的
   `agent_vitals_core::domain::X` → `agent_vitals_domain::X`（或 core 顶层留一个
   版本周期的 `pub use` facade 过渡）。
4. `dependency_budget.rs` 拆 domain 版（禁 harness/runtime/IO 依赖、禁反依赖 harnesses）+
   更新 harnesses 版。
5. `contracts` 依赖方向：`domain → contracts`、`harnesses → {domain, contracts}`、
   `wasm → {domain, harnesses(default-features=false)}`。

**验收**：全量 golden/parity/clippy 零漂移。**风险：中**（机械但面大，import 路径海量）。

---

## 3. 附：Step 1 实现细节（执行时照搬）

`domain/behavior.rs::match_behavior(events, workspace_root)` 与
`domain/trajectory.rs::match_trajectory(events)` 是「raw DSH events → findings」的
便捷 shim：

```rust
pub fn match_behavior(events: &[Value], workspace_root: Option<&str>) -> Vec<Value> {
    let events = &crate::util::post_fork(events)[..];
    let evidence = crate::dsh_evidence::build_dsh_evidence(events.to_vec(), Vec::new(),
                       workspace_root.map(str::to_owned), String::new());
    // → match_behavior_canonical(&evidence.canonical)
}
```

**唯一生产调用方是 wasm**（`crates/agent-vitals-wasm/src/lib.rs:26–27`）。
二进制侧 `src/agent/behavior.rs:135–137` 已经走
`agent_vitals_adapters::dsh_evidence::build_dsh_evidence(...)` + `match_*_canonical`
——Phase B1 起就解耦了。

纯入口 `match_behavior_canonical` / `match_trajectory_canonical`（吃
`&CanonicalSession`）**留 domain 不动**——它们零 harness 依赖，是 canonical 检测器本体。

### 3.2 迁移

1. `agent-vitals-adapters/src/harnesses/dsh/sessions/audit.rs`（新）：
   ```rust
   pub fn dsh_behavior_findings(events: &[Value], workspace_root: Option<&str>) -> Vec<Value>
   pub fn dsh_trajectory_findings(events: &[Value]) -> Vec<Value>
   ```
   实现 = 当前 shim 体（`post_fork` + `build_dsh_evidence` + `match_*_canonical`）。
   `build_dsh_evidence` 此时若还在 core（B2 未做）→ 经 adapters facade 的 re-export 调；
   B2 后 → 直接本 crate。
2. 删 `domain/{behavior,trajectory}.rs` 的 `match_behavior` / `match_trajectory`
   （raw 版）。`#[cfg(test)]` 里 3 处 `build_dsh_evidence` 调用见 §3.3。
3. wasm `lib.rs`：
   ```rust
   let mut findings = agent_vitals_adapters::harnesses::dsh::sessions::audit::dsh_behavior_findings(&events, ws);
   findings.extend(agent_vitals_adapters::harnesses::dsh::sessions::audit::dsh_trajectory_findings(&events));
   ```
   → wasm 加 `agent-vitals-adapters` 依赖（arch §3.1 的 `wasm ─► adapters` 未来边，
   **带真实调用点一起加**，兑现 B1 note 的承诺）。
4. `agent-vitals-wasm/Cargo.toml` 加 `agent-vitals-adapters = { path = "../agent-vitals-adapters" }`。

### 3.3 `agent-vitals-core` 测试对 `build_dsh_evidence` 的依赖（决策点）

`domain/behavior.rs` 的 3 处 `#[cfg(test)]` 用 `build_dsh_evidence` 造 fixture。
crate 拆分后 `agent-vitals-domain` 的单测**不能**调 `agent_vitals_adapters`（lib 依赖
方向是 adapters → domain）。三个选项：

| 选项 | 说明 | 取舍 |
|---|---|---|
| **(a) `[dev-dependencies]`** | `agent-vitals-domain` 的 `Cargo.toml` 加 `agent-vitals-adapters` 为 **dev-dep**。Cargo 允许 dev-dep 成环（不影响 lib 构建图） | 最省事，行为零改；但「domain 测试 import adapter」读着别扭 |
| **(b) 手搓 `CanonicalSession` fixture** | 测试改用 `contracts::evidence` 手拼 canonical，不经 `build_dsh_evidence` | 最干净，但要重写 ~3 个测试的 fixture，且失去「测的就是 adapter 产的形状」 |
| **(c) 测试移到 adapters crate** | 这些行为测试搬去 `agent-vitals-adapters/tests/`（它能同时 import domain + 自己的 evidence） | 测试归属跟着「被测行为的入口」走，最符合分层；工作量中等 |

**推荐 (c)**——`match_behavior` 整个入口都搬去 adapters 了，它的行为测试跟着搬是
一致的。domain 只留 `match_behavior_canonical` 的纯 canonical 测试（手搓 fixture）。

### 3.4 验收

- `cargo test` / `clippy` 全绿。
- **wasm 重建 + 重拷**：`(cd crates/agent-vitals-wasm && wasm-pack build --target web)`
  → `pkg/agent_vitals_wasm{.js,_bg.wasm}` 拷进 `dsh-client/`（CLAUDE.md：wasm↔CLI
  drift 只能靠重跑 wasm 构建抓）。
- wasm 输出对同一批 fixture 逐字节不变（shim 只换了住址，`post_fork` + evidence +
  canonical 三步一模一样）——`scripts/verify-timeline.mjs` / dsh-client 差分脚本。
- golden 15+15 零漂移（wasm 不进 golden，但 CLI `behavior` 走 canonical 路径不变）。
- **风险：低**，主要是别忘了重建 wasm。

---

## 4. 附：Step 2 实现细节（canonical 归一层）

### 4.1 现状

`domain/usage.rs:1523–1795`（~272 行生产代码 + `:1796` 起的 `#[cfg(test)]`）：
`CANONICAL_DIMS` / `SHAPE_{DSH,CODEX,CODEX_TOTAL,UNKNOWN}` / `canonical_total_delta` /
`canonical_tokens`。按 `source` 分派：DSH 形状走 `token_by_model` 的 4 桶，Codex 形状
调 `crate::codex_usage::{codex_fold_file, total_signature}`。

**代码自己的注释（:1529）**：「`SOURCE_CODEX` 在生产代码里没有一个调用点」。
穷举 `grep`：`canonical_tokens` / `canonical_total_delta` 的调用方**全是测试**——
`tests/test_canonical_cost.py` + `usage.rs` 的 `#[cfg(test)]`。Python 侧 `usage.py`
也只**定义**、无生产调用。这一层是给未来「#6 事件桥」（把 DSH+Codex 用量并进
同一行）预留的，那个消费方不存在。

### 4.2 迁移

canonical 归一层是「多执行环境 wire 归一」——每条来源显式注册 `(source, field) →
canonical 桶` 白名单，然后求和 + 守卫。这是 **adapter 的活**，不是 domain。

1. `agent-vitals-adapters/src/canonical_usage.rs`（新，crate 根级——它跨执行环境，
   不属单个 `harnesses/<h>/`）：搬 `CANONICAL_DIMS` / `SHAPE_*` / `canonical_total_delta`
   / `canonical_tokens`。
2. Codex 分支直接 `use agent_vitals_core::codex_usage`（B2 前）或本 crate 的
   `harnesses::codex::sessions::usage`（B2 后）；DSH 分支调 `agent_vitals_core::domain::
   usage::token_by_model`（domain → adapters 反向 OK：adapters 依赖 domain）。
3. `domain/usage.rs`：删 :1523–1795 + 对应 `#[cfg(test)]`。`SOURCE_*` 常量若别处
   还用则留（`token_by_date_model` 的 `source` 参数用 `SOURCE_DSH_LIVE` 等——查一下
   归属，大概率留 `contracts/` 或 domain）。
4. `test_canonical_cost.py` + Rust parity 测试 → 跟着搬去 adapters 的测试。
5. `test_classification.py` / clawhub allow-list：`canonical_usage` 模块登记进
   adapters family（Python 侧同步——见 §5）。

### 4.3 验收

- `cargo test` / `clippy` / Python `unittest` 全绿。
- **golden 零漂移**（canonical 层无生产消费方，golden 本就不碰它）。
- `test_canonical_cost.py` 的 Python↔Rust byte-parity 在新位置继续绿
  （`usage.rs::canonical_tokens_python_rust_byte_for_byte_parity` 硬编码串跟着搬）。
- **风险：低**——无生产消费方，纯搬 + parity 测试跟随。

---

## 5. Python 镜像（同步，不可漏）

Rust 侧每动一处，Python 侧对应动，`AGENT_VITALS_BIN` 差分 + `test_cli_matrix.py`
`both()` 看守：

**关键**：Python 包 **不跟着拆 crate**（feasibility review §3.3 已拍，Phase A–D 不改
Python 分层）。Rust 侧每个 Step 动一处，Python 侧对应：

| Rust Step | Python 对应 | Python 动作 |
|---|---|---|
| Step 1：raw 审计函数 + `Coords`/`tool_invocation` 归 `harnesses/dsh/sessions/` | `agent/{behavior,trajectory,waste,compaction}.py` 的 raw 入口 + `dsh_evidence.py` 的 Coords 等价物 | **文件不动**，只改 `test_classification.py` 的 family 归类（这些模块从 domain-family 归到 dsh-adapter-family）+ clawhub allow-list |
| Step 2：canonical 归一层 | `agent/usage.py` 的 `canonical_tokens`/`canonical_total_delta`/`canonical_from_*` | 同上，只登记归类 |
| Step 3：B2 residual | `agent/codex_usage.py`、`agent/dsh_evidence.py` | 已在对应 family，无动作（或路径注释同步）|
| Step 4：抽 domain crate | — | Python 无 crate 边界，无动作 |

差分守卫：`AGENT_VITALS_BIN` + `test_cli_matrix.py::both()` 每 Step 逐字节比较；
`test_classification.py` 的 family set 改动本身是受测的（改错即红）。

---

## 6bis. 执行进度（2026-09-04，本会话逐步做）

| commit | 内容 | 门禁 |
|---|---|---|
| `e82f168` | 预备：`find_request`/`find_next_request` → `util`（waste↔skill 共用）| 全绿 |
| `4b44b8c` | Step 1a：`compaction` + `waste` 迁出 `domain/` 进 `adapters/harnesses/dsh/sessions/` | 全绿 |
| `cd4f89a` | Step 1b：`match_behavior`/`match_trajectory` raw shim → `adapters/…/audit.rs` | 全绿 + wasm-pack |
| `69888c6` | Step 2a：`Coords` → `domain/coords.rs`（`trajectory::coord_map` 不再横跨取）| 全绿 |
| `6ce4d13` | Step 2b：canonical 归一层 → `adapters/canonical_usage.rs`（生产零调用）| 全绿 |
| `ecdda70` | Step 3（B2）：`codex_usage` + `canonical_usage` → adapters crate；DSH wire → `domain/dsh/`；`core/src/adapters/` 删除；守卫改写 | 全绿（见 §6quater）|
| `f4180ca` | Step 4：抽 `agent-vitals-contracts` + `agent-vitals-domain`，`agent-vitals-core` 退成薄 facade（3 crate + 垫片，见 §6quinquies）| 全绿 |
| 本提交 | Step 4 收尾：`agent-vitals-contracts` 折回 `agent-vitals-domain/src/contracts/`，删 `agent-vitals-core` 垫片，全量 rename `agent_vitals_core::`→`agent_vitals_domain::`（见 §6sexies）| 全绿 |

**至此 `domain/*.rs` 生产代码对 `crate::{dsh_evidence, codex_usage, adapters::harnesses}`
引用归零**——层 1 全清。剩下的命中全在 `#[cfg(test)]`（造 fixture / 调迁走的
shim），crate 拆分后经 `[dev-dependencies]` 解析。

**实际做法与原 §2 计划的偏差**（都是 crate 内移动 + `lib.rs` re-export 保旧路径，
比原计划「移到 agent-vitals-adapters crate + wasm 全改」小）：
- 移动全在 `agent-vitals-core` 内（`domain/` ↔ `adapters/`），`lib.rs` re-export 保
  `agent_vitals_core::{compaction,waste,audit,canonical_usage,coords}` 旧路径
- wasm 只改 2 处（`match_{behavior,trajectory}` → `agent_vitals_core::audit::*`）
- `Coords` 落 `domain/coords.rs` 而非 `contracts/`（模块注释写清是过渡；`contracts`
  保持 harness-agnostic）

**剩余**：无——Phase C（C-minimal）Step 1-4 + 收尾全部完成。Step 3/4 实际做法与
§6ter 计划有偏差（更小），见 §6quater / §6quinquies / §6sexies（收尾把中途的
`agent-vitals-contracts` + `agent-vitals-core` 两层合并成单个 `agent-vitals-domain`）。
**wire/fold 分离**（`domain/dsh/` → `harnesses/dsh/sessions/`）是 **Phase D 首项**，不是
Phase C 的一部分——Phase C 后 domain 仍不是完全 wire-pure。`cost.rs` 拆分同 Phase D。

## 6ter. Step 3/4 的已知拦路石（2026-09-04 试做发现）

试做 Step 3（把 `dsh_evidence`/`codex_usage`/`audit`/`compaction`/`waste`/
`canonical_usage` 从 `agent-vitals-core` 迁进 `agent-vitals-adapters` crate）时撞到：

**`domain/behavior.rs` 的 inline `#[cfg(test)] mod tests` 用 `build_dsh_evidence`
造 `CanonicalSession` fixture**（`canonical_from` / `canonical_with_coverage` 两个
helper + ~15–20 个依赖它们的测试，测的是 `match_behavior_canonical`）。

- **`[dev-dependencies]` 成环不行**：`agent-vitals-core` dev-dep `agent-vitals-adapters`
  → Cargo 把 `agent-vitals-core` 编**两遍**（一遍给 adapters 依赖、一遍作 test
  target）→ inline lib test 里 `agent_vitals_adapters::dsh_evidence::build_dsh_evidence(..)
  .canonical` 返回的 `CanonicalSession` 与 test 侧期望的是「不同版本的同名类型」
  （`error[E0308]: there are multiple different versions of crate agent_vitals_core`）。
  只影响**跨 crate 边界传 core 类型**的 inline test；传 `serde_json::Value` 的
  （~40 个 `match_behavior(&[raw])` 测试）不受影响。
- **integration test（`crates/agent-vitals-core/tests/*.rs`）没这问题**——它们是
  独立 crate、`agent-vitals-core` 只编一遍。`sv6*_parity.rs` / `harness_contract.rs`
  改成 `agent_vitals_adapters::dsh_evidence` 后照常编过。

**解法**：把 `behavior.rs::tests` 里用 `build_dsh_evidence` 的 ~15–20 个测试 +
`canonical_from`/`canonical_with_coverage`/`family1_outcomes`/`trajectory_outcomes`
helper（~350 行）搬去 `crates/agent-vitals-core/tests/behavior_canonical.rs`
（integration test）。`match_behavior(&[raw])` 那批（只换 `Value`）留 inline。
`trajectory.rs::tests` 同类检查。

**Step 3/4 完整清单**（都在 `agent-vitals-core` 内已验证可编译的前提下）：
1. `behavior.rs`/`trajectory.rs` 的 `build_dsh_evidence` inline test → integration test
2. `git mv` 6 个 residual 文件 core → adapters crate；`harnesses/{dsh,codex}/sessions/mod.rs`
   改真 `pub mod`；adapters `lib.rs` facade 加 `canonical_usage`/`audit`/`compaction`/`waste`
3. moved 文件 import：`crate::{domain,contracts,util,...}` → `agent_vitals_core::*`；
   `crate::codex_usage`（canonical_usage 里）→ `crate::harnesses::codex::sessions::usage`；
   `crate::dsh_evidence::tool_invocation`（waste 里）→ `super::evidence::tool_invocation`
4. `domain/usage.rs`：`civil_date_from_days` / `days_from_civil` 提 `pub`（codex usage 用）
5. core `lib.rs`：删 `pub mod adapters` + 全部 adapter re-export；core `Cargo.toml` 加
   `[dev-dependencies] agent-vitals-adapters`（integration test 用，无环）
6. `src/agent/behavior.rs`：`agent_vitals_core::{compaction,waste}` → `agent_vitals_adapters::*`
   （其余 `agent_vitals_adapters::codex_usage`/`dsh_evidence` Phase B1 起就对了，不动）
7. wasm `lib.rs` + `Cargo.toml`：加 `agent-vitals-adapters` dep；
   `agent_vitals_core::{audit,compaction,waste}` → `agent_vitals_adapters::*`；wasm-pack 重建
8. `crates/agent-vitals-core/tests/dependency_budget.rs`：
   `source_root` 断言去 `"adapters"`；删 `residual_harness_adapter_directories`（core 无
   `src/adapters/` 了）；`nested_paths_…` 去死引用；`domain_to_harness_compatibility_debt`
   改扫「`src/domain/` 生产代码零 `agent_vitals_adapters::`/`crate::adapters`」
9. `harness_contract.rs` g3/g8 + `test_harness_contract.py`：dsh evidence 路径
   `crates/agent-vitals-core/src/adapters/…` → `crates/agent-vitals-adapters/src/harnesses/dsh/…`
10. Step 4：`domain/` 整体 → `crates/agent-vitals-domain/`；core 退成
    `contracts` + `compatibility`；binary/wasm/adapters 的 `agent_vitals_core::<domain模块>::X`
    → `agent_vitals_domain::X`（海量，或 core 留一版本周期 `pub use` facade）；
    `test_classification.py` family set；clawhub 打包清单

这是**机械 + 一个判断点（第 1 步测试搬法）**——Codex-appropriate。

## 6quater. Step 3（B2）实际执行（2026-09-04，本会话）

§6ter 的方案假设「6 个 residual 全迁进 adapters crate + `build_dsh_evidence` inline
test 搬去 integration test」。实做时选了**更小的解法**——把成环风险源留在 core：

| 模块 | 去向 | 理由 |
|---|---|---|
| `codex/sessions/usage.rs`（Codex fold）| → `agent-vitals-adapters/src/harnesses/codex/sessions/usage.rs` | 其 inline test 只传 `serde_json::Value`，dev-dep 成环安全 |
| `canonical_usage.rs`（跨执行环境归一层）| → `agent-vitals-adapters/src/canonical_usage.rs` | 同上；`domain/usage.rs::tests` 经 `[dev-dependencies]` 调 `canonical_tokens` |
| `dsh/sessions/{evidence,audit,compaction,waste}.rs` | → `agent-vitals-core/src/domain/dsh/`（**留 core**）| `domain/{behavior,trajectory}.rs::tests` 的 `build_dsh_evidence` fixture 跨 crate 传 `CanonicalSession` → `multiple versions of crate` |

**净效果**：`core/src/adapters/` 整个删除；`domain/dsh/` 成为唯一登记的 layer-2
DSH-wire 债（与 `coords` 同性质）。`lib.rs` re-export（`pub use domain::dsh::{audit,
compaction, evidence as dsh_evidence, waste}`）保住二进制 / wasm / 测试的旧扁平路径
——**二进制 0 改动、wasm 0 改动、无 inline-test 搬迁**。core `Cargo.toml` 加
`[dev-dependencies] agent-vitals-adapters`（只 integration + `domain/usage.rs::tests`
用，`[dependencies]` 无环）。

守卫改写（`crates/agent-vitals-core/tests/dependency_budget.rs`）：
- `source_root_is_an_explicit_facade`：断言 `["compatibility","contracts","domain","lib.rs"]`（去 `"adapters"`）
- 新 `core_has_no_harness_adapter_directory`：`src/adapters/` 不存在
- 新 `domain_dsh_is_the_only_registered_layer2_wire_module`：`domain/dsh/` 只含 4 wire 模块 + `mod.rs`
- `domain_production_code_outside_dsh_has_no_harness_adapter_dependency`（原 `domain_to_harness_compatibility_debt_cannot_grow`）：扫 `src/domain/`（排除 `src/domain/dsh/`）生产代码零 `agent_vitals_adapters::` / `crate::adapters` / `crate::*_evidence`
- `residual_harness_adapter_directories_are_explicit_phase_c_debt`：删（core 无 `src/adapters/`）
- `nested_paths_…`：去死引用，加 `domain::dsh::audit::match_behavior` == `audit::match_behavior` facade 等价检查

路径同步：`harness_contract.rs` g3/g8 + `test_harness_contract.py`（dsh evidence →
`crates/agent-vitals-core/src/domain/dsh/evidence.rs`）；Python 侧 docstring 里指向
Rust 源的路径注释（`util.py` / `behavior.py` / `dsh_evidence.py` / `codex_usage.py` /
`test_characterization.py`）。

**门禁全绿**：`cargo test --release`（binary 313 + core 431 + adapters 56 + 各 parity）、
`cargo clippy --release --all-targets -D warnings`、`cargo check -p agent-vitals-wasm`、
`python3 -m unittest discover tests`（1145，226 skip）、golden 15+15 逐字节（Python & Rust bin）。

**剩余**：Step 4（抽 `agent-vitals-domain` crate）——见 §6quinquies。

## 6quinquies. Step 4 实际执行（2026-09-04，本会话）

§6ter step 10 假设「`domain/` 整体成 crate、`agent-vitals-core` 退成
`contracts + compatibility`、123 处 `agent_vitals_core::<domain模块>` 调用点全改
`agent_vitals_domain::`」。实做发现 **`agent-vitals-core` 不能既留 `contracts` 又
让别人 facade 到 `domain`**——`domain/*.rs` + 全部 `detectors/svXXX.rs` 大量
`use crate::compatibility::...`、`compatibility/` 又 `use crate::evidence::`，
`domain` 必须能引到 `contracts`；若 `contracts` 留 core、`domain` 独立，则
`domain → core`，core 就不能再 `pub use domain::*`（成环）。

**选了三 crate 干净拆 + core 当纯 facade**（123 调用点 + 二进制 + wasm + adapters
+ 全部测试**零改动**）：

| crate | 内容 | 依赖 |
|---|---|---|
| `agent-vitals-contracts` | `contracts/{evidence,harness_capability,r2a,source_identity,usage_fact}` | `serde_json` only |
| `agent-vitals-domain` | `domain/*` + `domain/dsh/*` + `compatibility/*` | `agent-vitals-contracts` + `vitals-core` + `regex` + `serde_json`；`[dev] agent-vitals-adapters` |
| `agent-vitals-core` | **薄 facade**，`src/` 只有 `lib.rs`：`pub use agent_vitals_{contracts,domain}::*` | 上两者 |

- `domain`/`contracts` 的 lib.rs 都 re-export 扁平路径，模块内 `use crate::evidence` /
  `use crate::behavior` / `use crate::compatibility` **零改动**（`domain` 的 lib.rs
  `pub use agent_vitals_contracts::{evidence,...}` 补齐契约扁平别名）。
- **孤儿规则**：`compatibility/canonical_session.rs` 的
  `impl From<evidence::Provenance> for vitals_core::provenance::Provenance` 两个类型都
  外来 → 落成自由函数 `provenance_to_vitals()`（唯一 1 处调用点 `.into()` 改函数调用）。
- workspace `members` + `default-members` 都加 `agent-vitals-contracts` /
  `agent-vitals-domain`（漏 `default-members` 会让 `cargo test` 编译但不跑 domain 的
  365 lib test）。
- 测试搬迁：`crates/agent-vitals-core/tests/{dependency_budget,harness_contract,
  sv6*_parity}.rs` → `crates/agent-vitals-domain/tests/`，`s/agent_vitals_core/
  agent_vitals_domain/`。新 `agent-vitals-contracts/tests/dependency_budget.rs`
  （契约只依赖 serde_json）、`agent-vitals-core/tests/facade.rs`（re-export 仍解析）。
- 守卫：domain `dependency_budget.rs` 的 `source_root` 断言改
  `["compatibility","domain","lib.rs"]`；`FORBIDDEN_DEP_KEYS` 加 `agent-vitals-core`
  （domain 不许回依赖 facade）；新 `domain_crate_holds_neither_contracts_nor_harness_adapters`。
- Python：`test_classification.py`（`skill.rs` 路径）、`test_canonical_schema.py`
  （`evidence.rs` → contracts）、`test_harness_contract.py`（dsh evidence + G8 路径 →
  domain）；`CLAUDE.md` repo layout + lockstep 段。

**门禁全绿**：`cargo test --release`（binary 313 + contracts 66 + domain 365 +
adapters 56 + facade 2 + 各 parity/harness_contract/dependency_budget；facade crate 0）、
`cargo clippy --release --all-targets -D warnings`、`cargo check -p agent-vitals-wasm`、
`python3 -m unittest discover tests`（1145，226 skip）、golden 15+15 逐字节（Python & Rust bin）。

wasm `.wasm` 无需重建——规则逻辑一行没改，wasm 经 facade 引，
`cargo check -p agent-vitals-wasm` 过。

## 6sexies. Step 4 收尾——合并成单个 `agent-vitals-domain`（2026-09-04，本会话）

用户反馈「3 crate + 垫片太零碎，`agent-vitals-core` 只剩一个 `lib.rs`、是不是要
移除」。对照 arch spec §3.1 依赖图（`adapters → agent-vitals-domain → vitals-core`，
无 `agent-vitals-core`、无独立 `agent-vitals-contracts`）与 §9 映射表（`contracts/`
是 `agent-vitals-domain` 的**子目录**）——§6quinquies 的三层确实超出 spec。独立
`contracts` crate 当初是为解「core 保留 contracts 则 `domain→core→domain` 成环」，
既然 core 要退成垫片，contracts 直接进 domain 就没有环。

- `agent-vitals-contracts/src/contracts/` → `agent-vitals-domain/src/contracts/`；
  删 `agent-vitals-contracts` crate。`domain/lib.rs` 改 `pub mod contracts;` +
  `pub use contracts::{...}`（扁平别名不变，`crate::evidence` 等零改动）。
- 删 `crates/agent-vitals-core/`。`agent_vitals_core::` → `agent_vitals_domain::`
  全量 rename（~33 文件 / ~180 处，纯机械）；root/adapters/wasm/src-tauri 的
  `Cargo.toml` dep `agent-vitals-core` → `agent-vitals-domain`；workspace
  `members`/`default-members` 摘掉 core + contracts。
- 孤儿规则：`compatibility/canonical_session.rs` 的
  `impl From<evidence::Provenance> for vitals_core::…::Provenance`（两类型都外来）
  → 自由函数 `provenance_to_vitals()`。
- 守卫：`vitals-core/tests/dependency_boundary.rs` FORBIDDEN 改 `agent-vitals-domain`；
  `adapters/tests/dependency_budget.rs` 断言 dep set = `["agent-vitals-domain",…]`；
  domain `dependency_budget.rs` `source_root` 断言 `["compatibility","contracts",
  "domain","lib.rs"]`，新 `contracts_module_stays_vocabulary_only`（扫 `src/contracts/**`
  零 `regex`/`vitals_core`/`crate::domain`/`crate::compatibility`/adapter）。
- Python：`test_canonical_schema.py` 等 3 个 FS 断言路径 + 一批 docstring 里的
  `crates/agent-vitals-core/…` / `agent-vitals-contracts` → `agent-vitals-domain`。
- **终态** = spec §3.1 图：`vitals-core ← agent-vitals-domain ← agent-vitals-adapters
  ← binary/wasm/src-tauri`。3 个 agent-vitals crate，无垫片。

**遗留债（转 Phase D 首项）**：`domain/dsh/` 4 个模块仍直接解析 DSH wire——
domain **不是**完全 wire-pure。见 `domain/dsh/mod.rs` + arch spec Phase C/D 段。

**门禁全绿**：`cargo test --release`（binary 313 + domain 431 lib + adapters 56 +
各 parity/harness_contract/dependency_budget）、`clippy -D warnings`、
`cargo check -p agent-vitals-wasm`、`src-tauri cargo check`、
`python3 -m unittest discover tests`（1145，226 skip）、golden 15+15 逐字节。

## 6. 建议执行顺序（C-minimal，每步独立提交、golden 绿）

```
Step 1  DSH raw-events 审计函数 → harnesses/dsh/sessions/audit.rs               [低 + wasm 重建]
        match_behavior · match_trajectory · compaction_events ·
        detect_structural_waste(+helpers) 迁出 domain；Coords/tool_invocation 留 dsh
        ├─ 对应 #[cfg(test)] 跟着搬 harnesses/tests
        ├─ wasm lib.rs 4 处改道 agent_vitals_harnesses::dsh::sessions::audit::*
        │  + wasm Cargo.toml 加 agent-vitals-harnesses { default-features=false }
        └─ gate: cargo test/clippy + wasm-pack build + 重拷 dsh-client/ + 差分 + golden 15+15

Step 2  canonical 归一层 → harnesses/canonical_usage.rs                          [低，无生产消费方]
        canonical_tokens · canonical_total_delta · CANONICAL_DIMS · SHAPE_*
        ├─ test_canonical_cost.py + Rust parity 测试跟随
        └─ gate: cargo test + Python unittest + parity

── 至此 domain/*.rs 生产代码对 crate::{dsh_evidence,codex_usage} 引用归零 ──

Step 3  B2：residual 物理迁移                                                [中，文件大]
        codex/sessions/usage.rs (1547) + dsh/sessions/evidence.rs (684) 迁进 harnesses
        ├─ core lib.rs 撤 2 条 re-export；core adapters/ 清空
        ├─ residual_harness_adapter_directories_… → assert_eq!([]) 或删测
        ├─ 二进制 agent_vitals_core::{codex_usage,dsh_evidence} → agent_vitals_harnesses::…
        └─ gate: 全量 + Python/Rust parity 零漂移

Step 4  抽 agent-vitals-domain crate                                        [中，机械但面大]
        domain/ 整体成 crate；agent-vitals-core 退成 contracts + compatibility 薄 crate
        ├─ agent_vitals_core::domain::X → agent_vitals_domain::X（或 core 留过渡 facade）
        ├─ dependency_budget.rs 拆 domain 版 + 更新 harnesses 版
        └─ gate: 全量 golden/parity/clippy 零漂移
```

**不在 C-minimal（各自独立迭代）**：
- **层 2 wire/fold 分离**（`usage/duration/subagent/skill` 的 DSH-wire inline 解析
  迁进 `harnesses/dsh/sessions/`）——建议排 Phase D 之后（`harnesses/dsh/sources/` 已落地时）。
- **`cost.rs` 99KB 拆** Model Resolver/Rate Card/BillingContext/Cost Projection——
  零 harness import，并入 Phase D（有 Model Catalog/User Profile 需求驱动时）。

---

## 7. Phase C（C-minimal）明确不做

- 不拆 `cost.rs`（零 harness import，domain 内部重构，并入 Phase D）。
- 不迁 `usage/duration/subagent/skill` 的 DSH-wire inline 解析（层 2，不阻塞 crate
  抽出；wire/fold 分离排 Phase D 之后）。
- `Coords`/`tool_invocation` **不进 `contracts/`**（它们 match DSH 原始事件类型，
  是 DSH wire helper）——留 `harnesses/dsh/sessions/`，跟迁进来的 raw 函数同 crate。
- 不接 Runtime（Phase D）、不动 Python crate 分层、不碰 MCP。
- 不改任何折叠语义 / `fact_id` / resume 契约 / 计价数学——是**搬家**，一行行为
  逻辑都不改；任一 golden/parity/reconcile 变红即停。

---

## 8. 待确认（执行前）

1. **C-minimal vs C-full**（§0）：推荐 C-minimal（只解 6 个 import + 抽 crate，层 2
   DSH-wire 债留 domain），确认？
2. Step 1 的 `#[cfg(test)]`（`domain/{behavior,waste,compaction}.rs` 里用
   `build_dsh_evidence`/raw events 的）跟函数搬去 `agent-vitals-harnesses/tests/`，
   domain 只留 canonical 测试——确认？
3. 抽 `agent-vitals-domain` 时 `agent-vitals-core` 最终形态：
   (a) 退成 `contracts` + `compatibility` 薄 crate（推荐，arch §0）；
   (b) core 留一个版本周期的 `pub use` facade 过渡。
4. 执行方式：独立分支 `codex/v0.8-phase-c`（同 A/B 惯例，Codex 执行、本会话审阅/
   验收/合并），还是本会话直接在 `docs/…` 分支逐 Step 做？
5. crate 名：`agent-vitals-adapters` → `agent-vitals-harnesses`（arch v3.1）在 Step 3
   一起改，还是留旧名到 Phase D？（倾向 Step 3 一起改，一次到位）
