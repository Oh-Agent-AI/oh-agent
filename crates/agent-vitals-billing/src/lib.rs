//! Agent Vitals 计费层（W3 第 4 步从 `agent-vitals-runtime` 拆出）：层 L4。
//!
//! 预算（`budget` / `budget_notifications`）、计费预览与归因（`billing_preview`）、价格发现
//! （`price_discovery`）、额度提醒（`quota_reminder`）。读 query 层的 summary 与计价选择，
//! 在 ingest / trust / mcp 之下。价卡本体（money / price_overrides / pricing_catalog）在
//! runtime-core 的 `pricing`，这里的 `billing::{money,…}` 是兼容路径。

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
pub mod billing;
pub use billing::budget;
pub use billing::billing_preview;
pub use billing::budget_notifications;
pub use billing::price_discovery;
pub use billing::quota_reminder;
