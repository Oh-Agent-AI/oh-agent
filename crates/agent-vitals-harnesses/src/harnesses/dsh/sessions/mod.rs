//! DSH session wire 解析 —— **纯**（wasm 可链）。
//!
//! `evidence`（raw DSH 事件 → `CanonicalSession`）、`audit`（raw → findings shim）、
//! `compaction` / `waste`（raw DSH 事件 → findings）都在解析 DSH 的
//! `"tool/call"`/`"turn/start"` 事件形状。v0.8 Phase D1 从 `agent-vitals-domain`
//! 的 `domain/dsh/`（Phase C 登记的 layer-2 债）迁到这里——`domain/` 现在对 DSH
//! 的 wire 形状彻底不知情，执行环境 wire 解释只住 `harnesses/<h>/sessions/`。
//!
//! `Coords`（事件坐标顺延状态机）留在 `agent-vitals-domain::coords`：它只认
//! `turn`/`step`/`call_id` 抽象字段名（§11.5），`trajectory::coord_map` /
//! `duration` / `skill` 也用它——算 harness-agnostic，经 `harnesses → domain` 正向依赖取。

pub mod audit;
pub mod compaction;
pub mod evidence;
pub mod header;
pub mod waste;
pub mod workflow;
