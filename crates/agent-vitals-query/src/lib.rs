//! Agent Vitals 读取侧（W3 第 4 步从 `agent-vitals-runtime` 拆出）：层 L2–L3。
//!
//! - L2 `sources`（数据源配置：自定义源、源开关、插件执行环境注册、监听拓扑）、
//!   `sessions`（执行环境适配的 runtime 薄封装：时钟 / 价卡供给）；
//! - L3 `query`（summary 仓储、trace、导出、决策矩阵、读缓存）。
//!
//! 只依赖地基层 `agent-vitals-runtime-core` 与 data / domain / harnesses；billing / ingest /
//! trust / mcp 都在它之上。`agent-vitals-runtime` 原样 re-export，外部路径不变。

// ── 下层 re-export（L0–L1，来自 agent-vitals-runtime-core）──
// 搬来的代码大量写 `crate::clock::now_ms` / `crate::home::data_home` 这类路径；在本 crate
// 根上原样 re-export，路径一行不用改。分层方向由 `agent-vitals-runtime/tests/module_layering.rs`
// 统一钉住。
pub use agent_vitals_runtime_core::core;
pub use agent_vitals_runtime_core::envelope;
pub use agent_vitals_runtime_core::events;
pub use agent_vitals_runtime_core::pricing;
pub use agent_vitals_runtime_core::skills;
pub use agent_vitals_runtime_core::source_graph;
#[doc(hidden)]
pub use agent_vitals_runtime_core::ENV_LOCK;
pub use core::clock;
pub use core::fact_harnesses;
pub use core::home;
pub use core::lease;
pub use core::logging;
pub use core::retention;
pub use core::sql_authority;
pub use core::state;
pub use core::statistics_timezone;
pub use core::takeover;
pub use pricing::money;
pub use pricing::price_overrides;
pub use pricing::pricing_catalog;

// ── L2 ──
pub mod sources;
pub use sources::custom_sources;
pub use sources::harness_registry;
pub use sources::session_sources;
pub use sources::source_controls;
pub mod sessions;

// ── L3 ──
pub mod query;
pub use query::decision_matrix;
pub use query::export;
pub use query::summary;
pub use query::trace_service;
