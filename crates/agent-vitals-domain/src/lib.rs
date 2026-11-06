//! Agent Vitals 的跨执行环境领域 crate——**纯计算 + 词表契约的单一真相源**，由原生
//! CLI、wasm 构建和 Tauri 菜单栏共用。
//!
//! - `contracts/` — 执行环境无关词表（`evidence`/`harness_capability`/`source_identity`/
//!   `usage_fact`/`session_key`）：身份与序列化事实形状，只依赖 `serde_json`、不解释任何
//!   执行环境 wire、不碰 I/O。纯净度由 `tests/dependency_budget.rs` 的
//!   `contracts_module_stays_vocabulary_only` 钉住。
//! - `domain/` — 跨执行环境业务计算（behavior/trajectory/cost/usage/detectors/plan/…）。
//!   **对任何执行环境的 wire 事件形状不知情**：DSH wire 解析在 v0.8 Phase D1 迁进
//!   `agent-vitals-harnesses/harnesses/dsh/sessions/`。`coords`（`Coords` 坐标顺延）留
//!   这里——只认 `turn`/`step`/`call_id` 抽象字段名，harness-agnostic。
//! - `compatibility/` — 通往 `vitals-core` 引擎的兼容桥。
//!
//! v0.8 Phase C：Phase A 在 core 内建 `contracts/domain/compatibility` 逻辑目录；
//! Step 3 把 Codex fold + canonical 归一层迁进 `agent-vitals-harnesses`；Step 4 把
//! `domain/` + `compatibility/` + `contracts/` 整体抽成本 crate，`agent-vitals-core`
//! 曾作一个版本周期的薄 facade、随即撤销——调用方直接 `use agent_vitals_domain::*`。
//! Phase D1 把 DSH wire（`evidence`/`audit`/`compaction`/`waste`）迁出 domain。
//! `lib.rs` 同时暴露嵌套（`agent_vitals_domain::{contracts,domain}::X`）与扁平
//! （`agent_vitals_domain::{evidence,behavior,cost,…}::X`）两套路径。

pub mod compatibility;
pub mod contracts;
pub mod domain;

// 词表扁平别名——`domain/*.rs` 与 `compatibility/*.rs` 用 `crate::evidence` /
// `crate::harness_capability` 等引契约。
pub use contracts::{billing, evidence, harness_capability, session_key, source_identity, trace_graph, usage_fact, workflow};

// domain 计算模块的扁平别名——Phase C 迁出前 `agent_vitals_domain::behavior::*` 等。
pub use domain::{
    attribution, behavior, budget, canonical_audit, coords, cost, data_contract, detectors, duration,
    enrichment, findings, fx, mcp, plan, probe, route_quality, session_insights, session_semantics, skill, skills, source_graph, state, subagent, takeover, trace, trajectory, trust,
    usage, util,
};
