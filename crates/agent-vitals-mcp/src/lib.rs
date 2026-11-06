//! Agent Vitals Data MCP 工具应用层（W3 第 4 步从 `agent-vitals-runtime` 拆出）：层 L6。
//!
//! MCP 工具（data_status / sessions_search / session_detail / usage_hourly / 预算与价卡工作流 …）
//! 与分发入口 `dispatch`。它是**出口面**：本地 agent 是有网消费者，这里供出的任何内容都可能随
//! agent 上下文离开本机（CLAUDE.md「数据留存与出口政策」）。单独成 crate 让脱敏红线的审查有
//! 一个明确边界。传输层（stdio / JSON-RPC）在 `apps/cli/src/mcp.rs`。

// ── 下层 re-export（来自 `agent-vitals-ingest` 的全部根名字）──
// 搬来的代码写 `crate::clock::now_ms` / `crate::summary::…` 这类路径；在本 crate 根上
// 原样 re-export，路径一行不用改。
pub use agent_vitals_ingest::core;
pub use agent_vitals_ingest::envelope;
pub use agent_vitals_ingest::events;
pub use agent_vitals_ingest::pricing;
pub use agent_vitals_ingest::skills;
pub use agent_vitals_ingest::source_graph;
#[doc(hidden)]
pub use agent_vitals_ingest::ENV_LOCK;
pub use agent_vitals_ingest::clock;
pub use agent_vitals_ingest::fact_harnesses;
pub use agent_vitals_ingest::home;
pub use agent_vitals_ingest::lease;
pub use agent_vitals_ingest::logging;
pub use agent_vitals_ingest::retention;
pub use agent_vitals_ingest::sql_authority;
pub use agent_vitals_ingest::state;
pub use agent_vitals_ingest::statistics_timezone;
pub use agent_vitals_ingest::takeover;
pub use agent_vitals_ingest::money;
pub use agent_vitals_ingest::price_overrides;
pub use agent_vitals_ingest::pricing_catalog;
pub use agent_vitals_ingest::sources;
pub use agent_vitals_ingest::custom_sources;
pub use agent_vitals_ingest::harness_registry;
pub use agent_vitals_ingest::session_sources;
pub use agent_vitals_ingest::source_controls;
pub use agent_vitals_ingest::sessions;
pub use agent_vitals_ingest::query;
pub use agent_vitals_ingest::decision_matrix;
pub use agent_vitals_ingest::export;
pub use agent_vitals_ingest::summary;
pub use agent_vitals_ingest::trace_service;
pub use agent_vitals_ingest::billing;
pub use agent_vitals_ingest::budget;
pub use agent_vitals_ingest::billing_preview;
pub use agent_vitals_ingest::budget_notifications;
pub use agent_vitals_ingest::price_discovery;
pub use agent_vitals_ingest::quota_reminder;
pub use agent_vitals_ingest::ingest;
pub use agent_vitals_ingest::sql_sync;
pub use agent_vitals_ingest::sync_service;
pub use agent_vitals_ingest::sync_control;
pub use agent_vitals_ingest::ingest_service;
pub use agent_vitals_ingest::plugin_ingest;
pub use agent_vitals_ingest::reimport_verify;

// ── 同层兄弟 trust（L5）──
pub use agent_vitals_trust::trust;
pub use agent_vitals_trust::trust_audit;
pub use agent_vitals_trust::trust_identity;
pub use agent_vitals_trust::trust_runtime_monitor;

// ── 本层 ──
pub mod mcp;
