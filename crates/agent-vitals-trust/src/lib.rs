//! Agent Vitals 信任与外传审计（W3 第 4 步从 `agent-vitals-runtime` 拆出）：层 L5。
//!
//! Trust / Egress 历史扫描（`trust_audit`）、主体身份（`trust_identity`）、运行期监测
//! （`trust_runtime_monitor`）。只依赖 query crate 的 sources（插件执行环境注册）与地基层的
//! events，与 ingest 同层互不依赖；mcp 在它之上。

// ── 下层 re-export（来自 `agent-vitals-query` 的全部根名字）──
// 搬来的代码写 `crate::clock::now_ms` / `crate::summary::…` 这类路径；在本 crate 根上
// 原样 re-export，路径一行不用改。
pub use agent_vitals_query::core;
pub use agent_vitals_query::envelope;
pub use agent_vitals_query::events;
pub use agent_vitals_query::pricing;
pub use agent_vitals_query::skills;
pub use agent_vitals_query::source_graph;
#[doc(hidden)]
pub use agent_vitals_query::ENV_LOCK;
pub use agent_vitals_query::clock;
pub use agent_vitals_query::fact_harnesses;
pub use agent_vitals_query::home;
pub use agent_vitals_query::lease;
pub use agent_vitals_query::logging;
pub use agent_vitals_query::retention;
pub use agent_vitals_query::sql_authority;
pub use agent_vitals_query::state;
pub use agent_vitals_query::statistics_timezone;
pub use agent_vitals_query::takeover;
pub use agent_vitals_query::money;
pub use agent_vitals_query::price_overrides;
pub use agent_vitals_query::pricing_catalog;
pub use agent_vitals_query::sources;
pub use agent_vitals_query::custom_sources;
pub use agent_vitals_query::harness_registry;
pub use agent_vitals_query::session_sources;
pub use agent_vitals_query::source_controls;
pub use agent_vitals_query::sessions;
pub use agent_vitals_query::query;
pub use agent_vitals_query::decision_matrix;
pub use agent_vitals_query::export;
pub use agent_vitals_query::summary;
pub use agent_vitals_query::trace_service;

// ── 本层 ──
pub mod trust;
pub use trust::trust_audit;
pub use trust::trust_identity;
pub use trust::trust_runtime_monitor;
