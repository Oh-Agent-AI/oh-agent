//! [`agent_vitals_domain::data_contract`] 的版本化 DTO 类型的重新导出——
//! `repository.rs` 的 trait 签名与调用方（`apps/cli`/`apps/desktop`）都从
//! 这里取类型，不直接碰 `agent_vitals_domain`。
//!
//! **组装逻辑不在这里**：本 crate 结构上够不到 `agent-vitals-harnesses`/
//! `agent-vitals-runtime`（spec §3.1 依赖表），把执行环境只读来源（DSH
//! `today`/`month`、Claude ledger、Codex 折叠）拼成这些 DTO 的实现代码住在
//! `agent-vitals-runtime`（`docs/AGENT_VITALS_V0_9_STAGE0_RESEARCH.md`
//! §8.1/§8.4）；WorkBuddy 在那边的实现里显式落进 `excluded_harnesses`，不读
//! 它的任何真实数据源（用户 2026-09-05 决定："workbuddy 的问题先不处理"，
//! 见本文档触发记录）。

pub use agent_vitals_domain::data_contract::{
    BillingBasis, CostBasis, CoverageStatus, DailySummary, Freshness, FreshnessState, HarnessAmount,
    MeteredLabel, MeteredView, MonthlySummary,
};
