//! `agent-vitals-data` —— v0.9 Data Foundation 的事实写入 + 可重建查询投影层
//! （`docs/AGENT_VITALS_V0_9_DATA_VALUE_ARCHITECTURE_SPEC.md` §3.1/§5，拆分
//! 计划见 `docs/AGENT_VITALS_V0_9_STAGE0_RESEARCH.md`）。
//!
//! 这是一个**嵌入式本地数据层**，不是独立服务：不开网络端口、不起 daemon，
//! 也不让 Tauri/CLI 绕过它直读 SQLite（spec §3.1 表："不允许承担的职责"一列
//! 明写 UI 呈现/同步调度不归这里管）。六个子模块对应 spec §5 的目录树：
//!
//! - [`evidence`]   —— append / replay / reconciliation（Stage A）
//! - [`authority`]  —— v0.9.1 SQL 权威库 `agent-vitals.sqlite3`（schema /
//!   迁移 / 事务 / 保留；**不自愈**——损坏需 `rm + data-migrate` 重建）
//! - [`authority_query`] —— `usage_facts` → 各执行环境计价桶形状的反查
//! - [`fact_writer_sql`] —— `usage_facts` 的唯一 SQL 写入口
//! - [`repository`] —— typed query/mutation 边界，上层唯一入口
//! - [`billing`]    —— `BillingContext` / cost basis（Stage B）
//! - [`coverage`]   —— source/denominator coverage 的跨执行环境汇总
//! - [`projection`] —— 组装 `agent_vitals_domain::data_contract` 的
//!   `MonthlySummary`/`DailySummary` 等版本化 DTO
//!
//! **v0.9.1 Phase 4.3**：Stage A/B 的旧 `store`（`index.sqlite3` 可丢弃投影）
//! 已退役——`authority` 是唯一 SQLite 层。
//!
//! **`SummaryRepository` 的实现不在这个 crate 里**：spec §3.1 的依赖表把
//! 本 crate 的允许依赖限定在 Domain（+ 未来的 SQLite 驱动），不包括
//! `agent-vitals-harnesses`——Stage 0 唯一能读到执行环境数据（`SessionStore`/
//! `budget` 状态）的地方是 `agent-vitals-runtime`，所以 trait 的具体实现
//! 住在那边（`docs/AGENT_VITALS_V0_9_STAGE0_RESEARCH.md` §8.1/§8.4）。

pub mod authority;
pub mod extension_authority;
pub mod authority_query;
pub mod fact_writer_sql;
pub mod safe_query;
pub mod legacy_import;
pub mod billing;
pub mod coverage;
pub mod evidence;
pub mod projection;
pub mod repository;
pub mod route_quality;
pub mod issues;
pub mod probe;
pub mod workflow;
pub mod trust;
pub mod trust_correlator;

pub mod session_statistics;
