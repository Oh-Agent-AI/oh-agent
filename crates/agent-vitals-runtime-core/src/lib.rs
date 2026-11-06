//! Agent Vitals runtime 地基层（W3 从 `agent-vitals-runtime` 拆出）。
//!
//! 模块层级（`agent-vitals-runtime/tests/module_layering.rs` 统一钉住）：
//! - L0：`core`（时钟 / home / lease / state / SQL 权威标记 / 执行环境词表）、
//!   `pricing`（价卡）、`source_graph`
//! - L1：`envelope`（MCP 与查询共用的工具协议）、`events`（outbox）、`skills`
//!
//! 为什么单独成 crate：拆之前这些基础件散在 ingest / billing / mcp 里，上层
//! 模块为读个时钟、拿把锁就互相依赖成环（见 83f98bf）。独立 crate 之后，
//! 「地基不许依赖上层」由 Cargo 强制，不再只靠守卫测试。
//!
//! `agent-vitals-runtime` 原样 re-export 本 crate 的全部模块与扁平路径，
//! 外部调用方（CLI / 桌面）路径不变。

// ── L0 ──
pub mod core;
pub use core::clock;
pub use core::fact_harnesses;
pub use core::home;
pub use core::lease;
pub use core::logging;
pub use core::retention;
pub use core::sql_authority;
pub use core::state;
pub use core::fx_settings;
pub use core::statistics_timezone;
pub use core::takeover;
pub mod pricing;
pub use pricing::money;
pub use pricing::price_overrides;
pub use pricing::pricing_catalog;
pub mod source_graph;

// ── L1 ──
pub mod envelope;
pub mod events;
pub mod skills;

/// 进程级环境变量锁 —— `state` / `budget` / `takeover` / `summary` 的
/// `#[cfg(test)]` 改 `AGENT_VITALS_HOME` 等进程 env，必须串行（模块各自造
/// 局部锁只能串行本模块，跨模块并行还是踩）。W3 下沉到地基 crate：
/// `agent-vitals-runtime` re-export 同一个 static，同一测试进程里两个
/// crate 的测试拿的是同一把锁。
#[doc(hidden)]
pub static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
