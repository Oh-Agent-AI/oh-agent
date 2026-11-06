//! Stage B：source/denominator coverage 的跨执行环境汇总——
//! `agent_vitals_domain::data_contract::CoverageStatus` 是它产出的契约形状
//! （`measured_fields`/`total_fields`/`denominator_version`），本模块负责
//! "怎么算出这三个数"，不是重新定义它们的含义。
//!
//! Stage B：source/denominator coverage 的跨执行环境汇总 facade。
//!
//! SQL 细节仍由 [`crate::authority_query`] 持有；本模块是 data 层对上提供的
//! 唯一 coverage 入口，负责把查询结果装配为 domain DTO，避免 runtime 直接
//! 依赖 SQL 查询实现。

use crate::authority::AuthorityDb;
use crate::projection::CoverageStatus;

pub const DENOMINATOR_VERSION: u32 = crate::authority_query::COVERAGE_DENOMINATOR_VERSION;

/// Query a harness's three-dimensional coverage for an inclusive millisecond window.
/// Invalid windows or SQL failures are intentionally returned to the caller so
/// the read model can distinguish unavailable data from measured zero.
pub fn status(
    db: &AuthorityDb,
    harness: &str,
    start_ms: i64,
    end_ms: i64,
) -> Result<CoverageStatus, String> {
    let (measured_fields, total_fields) = crate::authority_query::coverage_status(
        db.conn(),
        harness,
        start_ms,
        end_ms,
    )
    .map_err(|e| e.to_string())?;
    Ok(CoverageStatus {
        measured_fields,
        total_fields,
        denominator_version: DENOMINATOR_VERSION,
    })
}
