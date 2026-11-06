//! Agent Vitals 写入侧（W3 第 4 步从 `agent-vitals-runtime` 拆出）：层 L5。
//!
//! 例行同步（`sync_service`：发现 → SourceGraph 差量 → emit → 权威库写入 → findings 评估）、
//! 进程内同步引擎（`engine`）与 tick 调度状态机（`scheduler`）、文件监听（`watch`，
//! `watcher` feature）、插件执行环境再摄取、保留滚动、暂停开关。同步收尾触发价格对账，所以在
//! billing 之上；trust / mcp 不依赖它的写路径以外的东西。

// ── 下层 re-export（来自 `agent-vitals-billing` 的全部根名字）──
// 搬来的代码写 `crate::clock::now_ms` / `crate::summary::…` 这类路径；在本 crate 根上
// 原样 re-export，路径一行不用改。
pub use agent_vitals_billing::core;
pub use agent_vitals_billing::envelope;
pub use agent_vitals_billing::events;
pub use agent_vitals_billing::pricing;
pub use agent_vitals_billing::skills;
pub use agent_vitals_billing::source_graph;
#[doc(hidden)]
pub use agent_vitals_billing::ENV_LOCK;
pub use agent_vitals_billing::clock;
pub use agent_vitals_billing::fact_harnesses;
pub use agent_vitals_billing::home;
pub use agent_vitals_billing::lease;
pub use agent_vitals_billing::logging;
pub use agent_vitals_billing::retention;
pub use agent_vitals_billing::sql_authority;
pub use agent_vitals_billing::state;
pub use agent_vitals_billing::statistics_timezone;
pub use agent_vitals_billing::takeover;
pub use agent_vitals_billing::money;
pub use agent_vitals_billing::price_overrides;
pub use agent_vitals_billing::pricing_catalog;
pub use agent_vitals_billing::sources;
pub use agent_vitals_billing::custom_sources;
pub use agent_vitals_billing::harness_registry;
pub use agent_vitals_billing::session_sources;
pub use agent_vitals_billing::source_controls;
pub use agent_vitals_billing::sessions;
pub use agent_vitals_billing::query;
pub use agent_vitals_billing::decision_matrix;
pub use agent_vitals_billing::export;
pub use agent_vitals_billing::summary;
pub use agent_vitals_billing::trace_service;
pub use agent_vitals_billing::billing;
pub use agent_vitals_billing::budget;
pub use agent_vitals_billing::billing_preview;
pub use agent_vitals_billing::budget_notifications;
pub use agent_vitals_billing::price_discovery;
pub use agent_vitals_billing::quota_reminder;

// ── 本层 ──
pub mod ingest;
pub use ingest::sql_sync;
pub use ingest::sync_service;
pub use ingest::sync_control;
pub use ingest::ingest_service;
pub use ingest::plugin_ingest;
pub use ingest::reimport_verify;
