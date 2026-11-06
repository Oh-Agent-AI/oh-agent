//! Stage 0.3 起：typed query/mutation 边界——`daily_summary`/`monthly_summary`/
//! `coverage_status`（spec §3.1 代码示例）的唯一实现入口。上层
//! （`apps/cli`、`apps/desktop`）只应该认识这一个模块暴露的公开类型，不直接
//! 碰 `projection`/`store`/`evidence` 的内部结构——这条边界就是"repository
//! 是唯一取数接口"的落地方式（spec §5.1）。
//!
//! **这个 trait 只定义签名，不提供实现**——`agent-vitals-data` 结构上够不
//! 到 `agent-vitals-harnesses`/`agent-vitals-runtime`（spec §3.1 依赖表：本 crate
//! 只允许依赖 Domain + SQLite 驱动），Stage 0 唯一能读到 `SessionStore`/
//! `budget` 状态的地方是 `agent-vitals-runtime`，所以实现放在那边（`docs/
//! AGENT_VITALS_V0_9_STAGE0_RESEARCH.md` §8.1/§8.3）。Stage B 换成 SQLite
//! repository 时，这个 trait 的签名不变——调用方（`apps/cli`/`apps/desktop`）
//! 不需要知道背后是哪种实现。
//!
//! Stage 0 只支持 `month`/`date` 两个查询维度；spec §3.1 示例里的
//! `harness_scope`/`billing_scope` 过滤留给 Stage B——那时才有 SQLite 索引可供
//! 按条件查询，Stage 0 的实现天生返回"所有已知执行环境"，现在加过滤参数只是
//! 摆设，不是提前设计。

use crate::projection::{CoverageStatus, DailySummary, MonthlySummary};

/// "YYYY-MM"。
pub struct MonthlySummaryQuery {
    pub month: String,
}

/// "YYYY-MM-DD"。
pub struct DailySummaryQuery {
    pub date: String,
}

pub trait SummaryRepository {
    fn monthly_summary(&self, query: &MonthlySummaryQuery) -> MonthlySummary;
    fn daily_summary(&self, query: &DailySummaryQuery) -> DailySummary;

    /// 逐执行环境三维 coverage（spec §4 的 `coverage_status(month, harness_scope)`
    /// 查询）。键 = wired 执行环境 id。`denominator_version` 因实现而异（SQL
    /// 侧 = 1 三维分母；JSON 侧 = 0 近似口径），两把尺不可无声互比。
    fn coverage_status(&self, month: &str) -> std::collections::BTreeMap<String, CoverageStatus>;
}
