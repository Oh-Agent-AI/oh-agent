//! 行为 finding 的最小投影 [`FindingRef`]——同步后的 findings 评估器
//! （`agent-vitals-runtime::ingest::findings_eval`）把会话审计载荷里的 findings
//! 抽成它，再落 `issue_instances`。
//!
//! W8（2026-09-24）：本模块原先还承载跨会话 rollup（`rollup_findings` /
//! `FindingSession` / `FindingsRollup`），唯一调用方是 r2a `sessions findings`。
//! r2a 删除后 findings 的汇总由权威库的 issue 分组承担
//! （`agent_vitals_data::issues::issue_groups_with_sources`，与桌面 Findings 页
//! 同一数据源），rollup 随之删除，只留这个词表类型。

/// 单条 finding 的最小投影（落 issue 需要的字段子集）。`tool_name`/`evidence`/
/// `time`/`seq` 都可能诚实缺失（Codex 线格式 time/turn 多为 null）→ Option。
#[derive(Debug, Clone)]
pub struct FindingRef {
    pub rule: String,
    pub severity: String,
    pub category: String,
    pub tool_name: Option<String>,
    pub evidence: Option<String>,
    pub time: Option<i64>,
    pub seq: Option<u64>,
}
