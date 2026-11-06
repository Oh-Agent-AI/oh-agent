//! `agent-vitals-runtime` —— Agent Vitals 本机运行时的**门面**（W3，2026-09-24）。
//!
//! 本 crate 不再有自己的实现：runtime 按层拆成 6 个 crate，这里原样 re-export 全部模块与
//! 扁平别名，CLI / 桌面 / 测试的 `agent_vitals_runtime::X` 路径一个不变。新代码可以直接
//! 依赖需要的那一层，编译面更小。
//!
//! | 层 | crate | 模块 |
//! |---|---|---|
//! | L0–L1 | `agent-vitals-runtime-core` | core（home/clock/lease/state/…）、pricing、source_graph、envelope、events、skills |
//! | L2–L3 | `agent-vitals-query` | sources、sessions（执行环境适配薄封装）、query（summary/trace/export/…） |
//! | L4 | `agent-vitals-billing` | billing（预算、计费预览、价格发现、额度提醒） |
//! | L5 | `agent-vitals-ingest` | ingest（同步、进程内引擎、tick 调度、watcher、findings 评估） |
//! | L5 | `agent-vitals-trust` | trust（Trust / Egress 审计） |
//! | L6 | `agent-vitals-mcp` | mcp（Data MCP 工具，出口面） |
//!
//! 只能依赖严格更低层：crate 之间由 Cargo 保证，crate 内部由
//! `tests/module_layering.rs` 钉住。执行环境 wire 解释在 `agent-vitals-harnesses`（含会话执行环境
//! 注册表 `sources::session_harnesses`），纯规则在 `agent-vitals-domain`。
//! 历史（v0.8 D6/D7、v0.9 Stage 0.3/0.4、W8 删除 r2a）见 git log 与
//! docs/ARCHITECTURE_OPTIMIZATION_GUIDE.md。

// ── 地基层 L0–L1（W3 拆到 `agent-vitals-runtime-core`，这里原样 re-export，
//    外部 `agent_vitals_runtime::{core, clock, lease, envelope, …}` 路径不变）──
pub use agent_vitals_runtime_core::core;
pub use agent_vitals_runtime_core::envelope;
pub use agent_vitals_runtime_core::events;
pub use agent_vitals_runtime_core::pricing;
pub use agent_vitals_runtime_core::skills;
pub use agent_vitals_runtime_core::source_graph;
#[doc(hidden)]
pub use agent_vitals_runtime_core::ENV_LOCK;
pub use core::clock;
pub use core::home;
pub use core::logging;
pub use core::state;
pub use core::takeover;
pub use core::fx_settings;
pub use core::statistics_timezone;
pub use core::retention;

// ── billing/ 计费与价格域（旧路径 re-export 垫片保持外部兼容）──
pub use agent_vitals_billing::billing;
pub use billing::budget;
pub use pricing::money;
pub use billing::billing_preview;
pub use billing::budget_notifications;
pub use billing::price_discovery;
pub use pricing::price_overrides;
pub use pricing::pricing_catalog;
pub use billing::quota_reminder;

// ── ingest/ 同步与入库域 ──
pub use agent_vitals_ingest::ingest;
pub use ingest::sql_sync;
pub use core::sql_authority;
pub use ingest::sync_service;
pub use ingest::sync_control;
pub use ingest::ingest_service;
pub use ingest::plugin_ingest;
pub use ingest::reimport_verify;
pub use core::lease;

// ── query/ 读侧与服务面域 ──
pub use agent_vitals_query::query;
pub use query::summary;
pub use query::decision_matrix;
pub use query::trace_service;
pub use query::export;

// ── trust/ 信任与外传域 ──
pub use agent_vitals_trust::trust;
pub use trust::trust_audit;
pub use trust::trust_identity;
pub use trust::trust_runtime_monitor;

// ── sources/ 数据源接入编排域 ──
pub use agent_vitals_query::sources;
pub use sources::session_sources;
pub use sources::custom_sources;
pub use sources::source_controls;
pub use sources::harness_registry;

// ── 既有子目录 ──
pub use agent_vitals_mcp::mcp;
pub use agent_vitals_query::sessions;
