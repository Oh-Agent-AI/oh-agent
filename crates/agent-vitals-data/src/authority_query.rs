//! v0.9.1 Phase 3.1：`usage_facts` → 各执行环境计价函数期望的日/月/小时桶
//! `Value` 形状——SQL 权威库版的 `store::dsh_days_map`（那份是旧
//! `index.sqlite3`/`facts` 表的实现，本模块是同一形状对着新
//! `agent-vitals.sqlite3`/`usage_facts` 表重做，字段名与时间列类型都变了，
//! 不能共用查询字符串，但输出形状刻意保持一致——下游 `domain::cost::
//! {month_cost,priced_day,bucket_cost}`/`harnesses::codex_usage::{codex_by_model_
//! from_hours,codex_aggregate_hours}`/`sessions::codex_cost::codex_cost_report`/
//! `domain::cost::claude_day_cost` 全部不知道数字是从 JSONL 折叠出来的还是从
//! SQL 聚合出来的，这正是"只有一套计价规则"纪律的落地方式（CLAUDE.md
//! 「不长第四份拷贝」）。
//!
//! **系统统计时区的日/小时桶**：`usage_facts.event_ts_ms` 是 UTC 毫秒整数。
//! SQLite 的 `localtime` 按 OS 当前时区投影事件，再以 civil date 计算 epoch 日序号；
//! 这样夏令时和非整点/历史偏移不会被固定 `UTC+8` 近似吞掉。窗口边界由 Jiff
//! 按同一系统 IANA 时区生成。供应商价格规则不读取这些统计边界。
//!
//! **行轴/聚合轴分离纪律**（spec §4，`AGENT_VITALS_V0_9_1_SQL_AUTHORITY_
//! MIGRATION_SPEC.md`）：本模块所有"实时行级事实"查询都显式
//! `observation_kind != 'legacy_aggregate'`；claude 深历史的 legacy_aggregate
//! 行只经 [`claude_legacy_days`] 这一条专用路径，从不与实时行同查询相加。

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use agent_vitals_domain::usage::civil_date_from_days;
use jiff::{civil::Date, tz::TimeZone, ToSpan};

use crate::authority::AuthorityError;

// Retained only as a neutral SQL parameter and for legacy test fixtures. It is
// never used to determine a production statistics boundary anymore.
const BEIJING_OFFSET_MS: i64 = 8 * 3_600_000;
const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;

// Keep ?1 and ?2 as neutral parameters for the existing EXPLAIN/query-shape
// contract. Their values are no longer used as a timezone offset or unit.
macro_rules! local_day_idx { () => { "(CAST(julianday(date(event_ts_ms / 1000, 'unixepoch', 'localtime')) - 2440587.5 AS INTEGER))" }; }
/// 金额侧的「未被当前 saved 订阅声明覆盖」谓词（`usage_facts` 别名不带前缀）。
/// 曾是 7 份手抄字面量——`codex_by_hour_provider_model` 漏抄了这一份，结果 codex
/// 订阅声明覆盖了 26,715 条事实，`codex/openai` 却照样报 $376 按量估算
/// （2026-09-16 真机）。现在只有这一处定义。
macro_rules! not_subscription_covered { () => { "AND NOT EXISTS (SELECT 1 FROM billing_fact_attributions ba
               JOIN billing_declaration_revisions br ON br.revision_id = ba.revision_id
               JOIN billing_recalculation_jobs bj ON bj.job_id = ba.job_id AND bj.status = 'succeeded'
               WHERE ba.fact_id = usage_facts.fact_id AND ba.attribution_kind = 'subscription_covered'
                 AND br.revision_number = (SELECT MAX(br2.revision_number)
                   FROM billing_declaration_revisions br2
                   LEFT JOIN billing_recalculation_jobs bj2 ON bj2.revision_id = br2.revision_id AND bj2.status = 'succeeded'
                   WHERE br2.declaration_id = br.declaration_id AND (br2.change_kind = 'revoked' OR bj2.job_id IS NOT NULL))
                 AND br.change_kind = 'saved')" }; }
/// 「当前 saved 的 user_declared 归因 → 用户声明的计费方」子查询，别名 `decl`
/// （`decl.fact_id` / `decl.declared_provider`）。一条事实理论上只被一条有效声明
/// 答过；两条都答了取 MIN，避免 JOIN 放大行数。金额面据此把已归因事实从
/// `MeteredEstimate` 改归到声明的 provider（`MeteredDeclared`）——2026-09-16
/// 「归因以后按照归因的来计算」。
macro_rules! user_declared_join { () => { "LEFT JOIN (
               SELECT ba.fact_id, MIN(bd.provider_id) AS declared_provider
               FROM billing_fact_attributions ba
               JOIN billing_declaration_revisions br ON br.revision_id = ba.revision_id
               JOIN billing_recalculation_jobs bj ON bj.job_id = ba.job_id AND bj.status = 'succeeded'
               JOIN billing_declarations bd ON bd.declaration_id = br.declaration_id
               WHERE ba.attribution_kind = 'user_declared' AND br.change_kind = 'saved'
                 AND bd.deleted_at_ms IS NULL
                 AND br.revision_number = (SELECT MAX(br2.revision_number)
                   FROM billing_declaration_revisions br2
                   LEFT JOIN billing_recalculation_jobs bj2 ON bj2.revision_id = br2.revision_id AND bj2.status = 'succeeded'
                   WHERE br2.declaration_id = br.declaration_id AND (br2.change_kind = 'revoked' OR bj2.job_id IS NOT NULL))
               GROUP BY ba.fact_id) decl ON decl.fact_id = usage_facts.fact_id" }; }
macro_rules! local_hour_idx { () => { "((CAST(julianday(date(event_ts_ms / 1000, 'unixepoch', 'localtime')) - 2440587.5 AS INTEGER) * 24) + CAST(strftime('%H', event_ts_ms / 1000, 'unixepoch', 'localtime') AS INTEGER))" }; }

// v0.9.1 测试矩阵 §8 行 8「performance（不枚举原始日志/索引命中）」：所有
// 窗口化聚合查询的 SQL 抽成 `const`，`prepare()` 与 `tests/query_plan.rs` 的
// `EXPLAIN QUERY PLAN` 断言共用同一字符串——两处零漂移。断言内容：`harness` +
// `event_ts_ms` 范围必须命中部分索引 `usage_facts_harness_time`（`WHERE
// deleted_at_ms IS NULL` 与查询谓词一致），绝不 `SCAN usage_facts`（全表）。

/// [`peaked_days_map`]：DSH 峰谷分桶（`(day, model, event_peak)` 三维聚合）。
pub(crate) const SQL_PEAKED_DAYS_MAP: &str = concat!("SELECT (", local_day_idx!(), " + (?1 - ?1) + (?2 - ?2)) AS day_idx,
                model_id, event_peak,
                SUM(uncached_input_tokens), SUM(cache_read_tokens),
                SUM(cache_write_tokens), SUM(output_tokens)
         FROM usage_facts
         WHERE harness = ?3 AND observation_kind != 'legacy_aggregate'
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?4 AND event_ts_ms < ?5
           ", not_subscription_covered!(), "
         GROUP BY day_idx, model_id, event_peak");

/// 计费窗口聚合的粒度：逐日或逐北京小时。与 [`BillingSource`] 正交。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BillingGrain {
    Day,
    Hour,
}

/// 计费窗口的事实来源选择：
/// - `Realtime`：行级实时事实（`observation_kind != 'legacy_aggregate'`）
///   加排除当前 saved 订阅覆盖（`not_subscription_covered`——钱归订阅的事实
///   不得再进按量口径）；
/// - `LegacyAggregate`：深历史聚合行（`kind = 'legacy_aggregate' 加
///   `event_peak = 0`，峰行已在实时侧计过）——不带订阅过滤（legacy 深历史
///   早于任何订阅声明）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BillingSource {
    Realtime,
    LegacyAggregate,
}

/// 一次计费窗口查询（AGENTS.md 数据完整性看守的计费面对偶：token 视图有
/// harness-agnostic 的 [`hourly_by_harness_model`]，计费视图此前每个执行环境各抄一份
/// SQL——`codex_by_hour_model` / `claude_days` / `claude_legacy_days` 三份的
/// WHERE 仅差 harness 字面量与粒度。本查询把它收敛为参数；**新增执行环境的计费
/// 日/时视图 = 调这里，不再新写 SQL**）。
#[derive(Clone, Copy, Debug)]
pub struct BillingWindowQuery<'a> {
    pub harness: &'a str,
    pub grain: BillingGrain,
    pub source: BillingSource,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// 计费窗口聚合的一行：`(day|hour 索引, 模型, 四桶 SUM)`。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BillingWindowRow {
    /// Day 粒度 = 自 civil 纪元的天序号；Hour 粒度 = 天序号 × 24 + 北京小时。
    pub idx: i64,
    pub model: Option<String>,
    pub uncached_input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
}

/// 构建 [`BillingWindowQuery`] 的 SQL（`pub(crate)` 供 EXPLAIN QUERY PLAN
/// 断言共用同一字符串——零漂移纪律沿袭 `SQL_*` const 时代的注释）。
pub(crate) fn billing_window_sql(q: &BillingWindowQuery<'_>) -> String {
    let idx_expr = match q.grain {
        BillingGrain::Day => local_day_idx!(),
        BillingGrain::Hour => local_hour_idx!(),
    };
    let (source_filter, sub_filter) = match q.source {
        BillingSource::Realtime => (
            "observation_kind != 'legacy_aggregate'",
            not_subscription_covered!(),
        ),
        BillingSource::LegacyAggregate => (
            "observation_kind = 'legacy_aggregate' AND event_peak = 0",
            "",
        ),
    };
    format!(
        "SELECT ({idx_expr} + (?1 - ?1) + (?2 - ?2)) AS idx,
                model_id,
                SUM(uncached_input_tokens), SUM(cache_read_tokens),
                SUM(cache_write_tokens), SUM(output_tokens)
         FROM usage_facts
         WHERE harness = ?5 AND {source_filter}
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?3 AND event_ts_ms < ?4
           {sub_filter}
         GROUP BY idx, model_id",
        idx_expr = idx_expr,
        source_filter = source_filter,
        sub_filter = sub_filter,
    )
}

/// 通用计费窗口聚合（四桶 SUM，按粒度 × 模型分组）。参数布局
/// `?1=北京偏移 ?2=粒度毫秒 ?3/?4=窗口 ?5=harness`——harness 走参数绑定，
/// 与 [`hourly_by_harness_model`] 同款（单执行环境 `harness = ?` 命中
/// `usage_facts_harness_time` 部分索引）。
pub fn billing_window_tokens(
    conn: &Connection,
    q: &BillingWindowQuery<'_>,
) -> Result<Vec<BillingWindowRow>, AuthorityError> {
    let sql = billing_window_sql(q);
    let grain_ms = match q.grain {
        BillingGrain::Day => DAY_MS,
        BillingGrain::Hour => HOUR_MS,
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(
            rusqlite::params![BEIJING_OFFSET_MS, grain_ms, q.start_ms, q.end_ms, q.harness],
            |r| {
                Ok(BillingWindowRow {
                    idx: r.get(0)?,
                    model: r.get(1)?,
                    uncached_input_tokens: r.get(2)?,
                    cache_read_tokens: r.get(3)?,
                    cache_write_tokens: r.get(4)?,
                    output_tokens: r.get(5)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// [`claude_declared_days`]：已被用户归因的 claude 事实，按声明的计费方分组，
/// 每组形状同 `claude_days`。
pub(crate) const SQL_CLAUDE_DECLARED_DAYS: &str = concat!("SELECT (", local_day_idx!(), " + (?1 - ?1) + (?2 - ?2)) AS day_idx,
                decl.declared_provider, model_id,
                SUM(uncached_input_tokens), SUM(cache_read_tokens),
                SUM(cache_write_tokens), SUM(output_tokens)
         FROM usage_facts
         ", user_declared_join!(), "
         WHERE harness = 'claude-code' AND observation_kind != 'legacy_aggregate'
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?3 AND event_ts_ms < ?4
           AND decl.fact_id IS NOT NULL
           ", not_subscription_covered!(), "
         GROUP BY day_idx, decl.declared_provider, model_id");

/// [`hourly_by_harness_model`] 三执行环境 × 模型 × 小时聚合（增量 2 `usage_hourly`
/// 工具的 SQL 数据源）。从函数体抽出来便于 EXPLAIN QUERY PLAN 测试断言。
///
/// **不排除订阅覆盖的事实**：这是 token 视图（`usage_hourly` 只报 token，cost 在
/// `cost_breakdown`），处理量与「钱归谁」无关——与 `tokens_by_harness`/`harness_tokens_all`
/// 同一条纪律；曾带 `not_subscription_covered!` 导致 MCP 小时曲线之和 ≠ `data daily`
/// 的 tokens_by_harness（mcp_smoke Q01-Q03 MISMATCH，2026-09-17）。
///
/// **单执行环境** SQL：`harness = ?5` 走 `usage_facts_harness_time` 索引（与
/// `codex_by_hour_model` / `claude_days` 同款）。三执行环境聚合由 fn 把三个
/// 单执行环境查询的结果 in-memory 合并——OR + IN + positional params 三种
/// 写法 SQLite planner 都会退化成 SCAN + temp B-tree（实测，2026-09-05
/// tab 卡顿事故形状）。wired 执行环境就 3 个（claude-code / codex / dsh），
/// in-memory 合并成本可忽略；多于 3 个需要重新评估。
pub(crate) const SQL_HOURLY_BY_HARNESS_MODEL: &str = concat!("SELECT harness, COALESCE(model_id, '<unknown>'),
                CAST((", local_hour_idx!(), " + (?1 - ?1) + (?2 - ?2)) % 24 AS TEXT) AS local_hour,
                SUM(uncached_input_tokens),
                SUM(cache_read_tokens),
                SUM(cache_write_tokens),
                SUM(output_tokens)
         FROM usage_facts
         WHERE observation_kind != 'legacy_aggregate'
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?3 AND event_ts_ms < ?4
           AND harness = ?5
         GROUP BY harness, model_id, local_hour");

pub(crate) const SQL_HOURLY_BY_HARNESS_PROVIDER: &str = concat!("SELECT harness, COALESCE(provider_id, '<unknown>'),
                CAST((", local_hour_idx!(), " + (?1 - ?1) + (?2 - ?2)) % 24 AS TEXT) AS local_hour,
                SUM(uncached_input_tokens), SUM(cache_read_tokens),
                SUM(cache_write_tokens), SUM(output_tokens)
         FROM usage_facts
         WHERE observation_kind != 'legacy_aggregate' AND deleted_at_ms IS NULL
           AND event_ts_ms IS NOT NULL AND event_ts_ms >= ?3 AND event_ts_ms < ?4
           AND harness = ?5
         GROUP BY harness, provider_id, local_hour");

/// 「确认计费方式」的待确认组（REQ-023：执行环境 × provider × 模型 × 路由证据 ×
/// 计价依据）。谓词：仍按量估算或路由证据不是明确官方路由、且未被当前 saved
/// 声明覆盖、且不是执行环境自报 subscription 的事实。运行时的组面板
/// （`runtime::billing_preview::confirmation_groups`）、总览摘要与待处理投影
/// （`issues.rs`）三处共用这一条 SQL——组的定义只有一份。
/// 「覆盖」认**任意归因种类**（subscription_covered / user_declared）：确认过
/// 中转/按量/组织的关系也算"已回答"，组要关掉——否则确认经中转后行永远留在
/// 待确认里（2026-09-16 真机）。撤销后 MAX 修订变 revoked → 组重新打开。
/// 注意：**金额**侧的排除谓词（7 处共用那份字面量）仍只认 subscription_covered
/// ——user_declared 不改金额（D02），两份谓词的差异是故意的。
/// 待确认组的事实谓词（别名 `f`，`?1`/`?2` = 窗口毫秒）。运行时计价用它喂
/// `price_fact_selection`，保证组金额与组 token 是同一批事实。
pub const SQL_UNRESOLVED_BILLING_FACT_WHERE: &str =
    "f.deleted_at_ms IS NULL AND f.observation_kind != 'legacy_aggregate'
       AND f.event_ts_ms >= ?1 AND f.event_ts_ms < ?2
       AND COALESCE(f.billing_mode, 'unknown') != 'subscription'
       AND NOT EXISTS (SELECT 1 FROM billing_fact_attributions ba
           JOIN billing_declaration_revisions br ON br.revision_id = ba.revision_id
           JOIN billing_recalculation_jobs bj ON bj.job_id = ba.job_id AND bj.status = 'succeeded'
           WHERE ba.fact_id = f.fact_id
             AND br.revision_number = (SELECT MAX(br2.revision_number)
               FROM billing_declaration_revisions br2
               LEFT JOIN billing_recalculation_jobs bj2 ON bj2.revision_id = br2.revision_id AND bj2.status = 'succeeded'
               WHERE br2.declaration_id = br.declaration_id AND (br2.change_kind = 'revoked' OR bj2.job_id IS NOT NULL))
             AND br.change_kind = 'saved')
       AND (COALESCE(f.pricing_basis, 'unavailable') = 'metered_estimate'
            OR COALESCE(f.evidence_basis, 'missing') != 'explicit-official-route')";

pub const SQL_UNRESOLVED_BILLING_GROUPS: &str = concat!(
    "SELECT f.harness, COALESCE(f.provider_id, '<unknown>'), COALESCE(f.model_id, '<unknown>'),
            COALESCE(f.evidence_basis, 'missing'), COALESCE(f.pricing_basis, 'unavailable'),
            SUM(f.uncached_input_tokens + f.cache_read_tokens + f.cache_write_tokens + f.output_tokens),
            MIN(f.event_ts_ms), MAX(f.event_ts_ms),
            COUNT(DISTINCT COALESCE(f.session_key, f.harness || ':' || f.machine_namespace || ':' || f.native_session_id))
     FROM usage_facts f
     WHERE ",
    "f.deleted_at_ms IS NULL AND f.observation_kind != 'legacy_aggregate'
       AND f.event_ts_ms >= ?1 AND f.event_ts_ms < ?2
       AND COALESCE(f.billing_mode, 'unknown') != 'subscription'
       AND NOT EXISTS (SELECT 1 FROM billing_fact_attributions ba
           JOIN billing_declaration_revisions br ON br.revision_id = ba.revision_id
           JOIN billing_recalculation_jobs bj ON bj.job_id = ba.job_id AND bj.status = 'succeeded'
           WHERE ba.fact_id = f.fact_id
             AND br.revision_number = (SELECT MAX(br2.revision_number)
               FROM billing_declaration_revisions br2
               LEFT JOIN billing_recalculation_jobs bj2 ON bj2.revision_id = br2.revision_id AND bj2.status = 'succeeded'
               WHERE br2.declaration_id = br.declaration_id AND (br2.change_kind = 'revoked' OR bj2.job_id IS NOT NULL))
             AND br.change_kind = 'saved')
       AND (COALESCE(f.pricing_basis, 'unavailable') = 'metered_estimate'
            OR COALESCE(f.evidence_basis, 'missing') != 'explicit-official-route')",
    "
     GROUP BY f.harness, f.provider_id, f.model_id, f.evidence_basis, f.pricing_basis
     ORDER BY SUM(f.uncached_input_tokens + f.cache_read_tokens + f.cache_write_tokens + f.output_tokens) DESC"
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnresolvedBillingGroupRow {
    pub harness: String,
    pub provider_id: String,
    pub model_id: String,
    pub evidence_basis: String,
    pub pricing_basis: String,
    pub tokens: i64,
    pub first_event_at_ms: i64,
    pub last_event_at_ms: i64,
    pub session_count: i64,
}

pub fn unresolved_billing_group_rows(
    conn: &rusqlite::Connection, start_ms: i64, end_ms: i64,
) -> rusqlite::Result<Vec<UnresolvedBillingGroupRow>> {
    let mut stmt = conn.prepare(SQL_UNRESOLVED_BILLING_GROUPS)?;
    let rows = stmt.query_map(rusqlite::params![start_ms, end_ms], |r| Ok(UnresolvedBillingGroupRow {
        harness: r.get(0)?, provider_id: r.get(1)?, model_id: r.get(2)?,
        evidence_basis: r.get(3)?, pricing_basis: r.get(4)?, tokens: r.get(5)?,
        first_event_at_ms: r.get(6)?, last_event_at_ms: r.get(7)?, session_count: r.get(8)?,
    }))?;
    rows.collect()
}

/// [`facts_page_window`]：键集分页（`(event_ts_ms, fact_id)` 游标，无 OFFSET）。
pub(crate) const SQL_FACTS_PAGE_WINDOW: &str =
    "SELECT fact_id, native_session_id, model_id, event_ts_ms,
                uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens
         FROM usage_facts
         WHERE harness = ?1 AND observation_kind != 'legacy_aggregate'
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?2 AND event_ts_ms < ?3
           AND (event_ts_ms, fact_id) > (?4, ?5)
         ORDER BY event_ts_ms, fact_id
         LIMIT ?6";

/// 系统统计时区民历日 `(y, m, d)` 的零点 → UTC 毫秒。Jiff 负责校验日期、
/// IANA 偏移和 DST；不存在的日期（如 02-30）返回 `None`。
pub(crate) fn statistics_timezone() -> TimeZone {
    let configured = std::env::var("TZ").ok().map(|value| value.trim_start_matches(':').to_string());
    configured
        .as_deref()
        .and_then(|name| TimeZone::get(name).ok())
        .unwrap_or_else(TimeZone::system)
}

fn system_midnight_ms(y: i64, m: u32, d: u32) -> Option<i64> {
    midnight_ms_in_timezone(y, m, d, statistics_timezone())
}

fn midnight_ms_in_timezone(y: i64, m: u32, d: u32, timezone: TimeZone) -> Option<i64> {
    let date = Date::new(y.try_into().ok()?, m.try_into().ok()?, d.try_into().ok()?).ok()?;
    date.to_zoned(timezone).ok().map(|zdt| zdt.timestamp().as_millisecond())
}

fn parse_ymd(date: &str) -> Option<(i64, u32, u32)> {
    if date.len() != 10
        || date.as_bytes().get(4) != Some(&b'-')
        || date.as_bytes().get(7) != Some(&b'-')
    {
        return None;
    }
    let y: i64 = date.get(0..4)?.parse().ok()?;
    let m: u32 = date.get(5..7)?.parse().ok()?;
    let d: u32 = date.get(8..10)?.parse().ok()?;
    Some((y, m, d))
}

/// `"YYYY-MM-DD"` → 该系统统计日的 `[start, end)` UTC 毫秒窗口。格式或日期
/// 非法（如 02-30）→ `None`，调用方按"这个日期没有意义"处理，不是报 0。
pub fn beijing_day_bounds_ms(date: &str) -> Option<(i64, i64)> {
    let (y, m, d) = parse_ymd(date)?;
    let start = system_midnight_ms(y, m, d)?;
    let next = Date::new(y.try_into().ok()?, m.try_into().ok()?, d.try_into().ok()?).ok()?
        .checked_add(1.days()).ok()?;
    let end = next.to_zoned(statistics_timezone()).ok()?.timestamp().as_millisecond();
    Some((start, end))
}

/// `"YYYY-MM"` → 该系统统计月的 `[start, end)` UTC 毫秒窗口。
pub fn beijing_month_bounds_ms(month: &str) -> Option<(i64, i64)> {
    if month.len() != 7 || month.as_bytes().get(4) != Some(&b'-') {
        return None;
    }
    let y: i64 = month.get(0..4)?.parse().ok()?;
    let m: u32 = month.get(5..7)?.parse().ok()?;
    if !(1..=12).contains(&m) {
        return None;
    }
    let start = system_midnight_ms(y, m, 1)?;
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    let end = system_midnight_ms(ny, nm, 1)?;
    Some((start, end))
}

const BASE_KEYS: [&str; 4] = [
    "uncached_input_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "output_tokens",
];
const PEAK_KEYS: [&str; 4] = [
    "peak_uncached_input_tokens",
    "peak_cache_read_tokens",
    "peak_cache_write_tokens",
    "peak_output_tokens",
];

#[derive(Default, Clone, Copy)]
struct Bucket4 {
    u: i64,
    cr: i64,
    cw: i64,
    o: i64,
}

impl Bucket4 {
    fn add(&mut self, u: i64, cr: i64, cw: i64, o: i64) {
        self.u += u;
        self.cr += cr;
        self.cw += cw;
        self.o += o;
    }

    fn merge_into(self, keys: &[&str; 4], obj: &mut Map<String, Value>) {
        for (k, v) in keys.iter().zip([self.u, self.cr, self.cw, self.o]) {
            obj.insert(k.to_string(), json!(v));
        }
    }
}

/// `usage_facts` 里一个执行环境在 `[start_ms, end_ms)` 窗口内的日桶 map——与旧
/// `store::dsh_days_map`/`month.json` 的 `days` 同形（顶层 4 基础 + 4 `peak_`
/// 前缀桶 + `by_model`：每个模型同样 8 键）。目前只有 DSH 走这条形状（唯一
/// 按时段峰谷计价的执行环境）；`model_id` 为 `NULL`（未归属）的事实只计入顶层
/// 总量、不进 `by_model`——`domain::cost::priced_day` 靠这个缺口识别"这天
/// 有一部分 token 没有模型归属"，回落 `fallback_price` 补齐，不是本函数的
/// 职责。**实时行级事实专用**：显式排除 `observation_kind='legacy_aggregate'`
/// （spec §4 分离纪律，DSH 目前没有 legacy_aggregate 行，排除是防御性的，
/// 与 claude 那条路径写法一致，防止未来给 DSH 补历史聚合时悄悄踩坑）。
pub fn peaked_days_map(
    conn: &Connection,
    harness: &str,
    start_ms: i64,
    end_ms: i64,
) -> Result<Value, AuthorityError> {
    let mut stmt = conn.prepare(SQL_PEAKED_DAYS_MAP)?;
    let rows = stmt.query_map(
        rusqlite::params![BEIJING_OFFSET_MS, DAY_MS, harness, start_ms, end_ms],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        },
    )?;

    struct DayAcc {
        total: Bucket4,
        peak: Bucket4,
        by_model_total: BTreeMap<String, Bucket4>,
        by_model_peak: BTreeMap<String, Bucket4>,
    }
    let mut days: BTreeMap<String, DayAcc> = BTreeMap::new();
    for row in rows {
        let (day_idx, model, peak, u, cr, cw, o) = row?;
        let date = civil_date_from_days(day_idx);
        let acc = days.entry(date).or_insert_with(|| DayAcc {
            total: Bucket4::default(),
            peak: Bucket4::default(),
            by_model_total: BTreeMap::new(),
            by_model_peak: BTreeMap::new(),
        });
        acc.total.add(u, cr, cw, o);
        if peak == 1 {
            acc.peak.add(u, cr, cw, o);
        }
        if let Some(model) = model {
            acc.by_model_total
                .entry(model.clone())
                .or_default()
                .add(u, cr, cw, o);
            if peak == 1 {
                acc.by_model_peak
                    .entry(model)
                    .or_default()
                    .add(u, cr, cw, o);
            }
        }
    }

    let mut out = Map::new();
    for (date, acc) in days {
        let mut day_obj = Map::new();
        acc.total.merge_into(&BASE_KEYS, &mut day_obj);
        acc.peak.merge_into(&PEAK_KEYS, &mut day_obj);
        let mut by_model = Map::new();
        for (model, total) in &acc.by_model_total {
            let mut m = Map::new();
            total.merge_into(&BASE_KEYS, &mut m);
            acc.by_model_peak
                .get(model)
                .copied()
                .unwrap_or_default()
                .merge_into(&PEAK_KEYS, &mut m);
            by_model.insert(model.clone(), Value::Object(m));
        }
        day_obj.insert("by_model".to_string(), Value::Object(by_model));
        out.insert(date, Value::Object(day_obj));
    }
    Ok(Value::Object(out))
}

/// claude 的实时行级事实：`[start_ms, end_ms)` 窗口内逐 Beijing 日、逐模型
/// 4 桶求和（无峰谷维度——claude 计价不按时段拆分）。**只读实时行**
/// （`observation_kind != 'legacy_aggregate'`）；深历史走 [`claude_legacy_days`]。
pub fn claude_days(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
) -> Result<BTreeMap<String, Value>, AuthorityError> {
    // 通用计费窗口（harness=claude-code × Day × Realtime）——SQL 不再各执行环境
    // 手抄；输出折叠形状与历史逐字节一致（parity 测试钉住）。
    let rows = billing_window_tokens(conn, &BillingWindowQuery {
        harness: "claude-code",
        grain: BillingGrain::Day,
        source: BillingSource::Realtime,
        start_ms,
        end_ms,
    })?;
    Ok(fold_billing_days(rows))
}

/// 已被用户归因（user_declared）的 claude 事实，按声明的计费方分组：
/// `{provider: {day: {model: 4 桶}}}`。它是 [`claude_days`] 的子集（同样排除
/// legacy_aggregate 与订阅覆盖）——by_provider 用「claude_days − 本函数」得到
/// 默认估算的那部分，用本函数按声明的计费方计 `MeteredDeclared`。
pub fn claude_declared_days(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
) -> Result<BTreeMap<String, BTreeMap<String, Value>>, AuthorityError> {
    let mut stmt = conn.prepare(SQL_CLAUDE_DECLARED_DAYS)?;
    let rows = stmt.query_map(
        rusqlite::params![BEIJING_OFFSET_MS, DAY_MS, start_ms, end_ms],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        },
    )?;
    let mut out: BTreeMap<String, BTreeMap<String, Map<String, Value>>> = BTreeMap::new();
    for row in rows {
        let (day_idx, provider, model, u, cr, cw, o) = row?;
        let Some(model) = model else { continue };
        let bucket = out.entry(provider).or_default()
            .entry(civil_date_from_days(day_idx)).or_default()
            .entry(model).or_insert_with(claude_zero_bucket);
        claude_bucket_add(bucket, u, cr, cw, o);
    }
    Ok(out.into_iter().map(|(p, days)| (p, days.into_iter()
        .map(|(d, m)| (d, Value::Object(m))).collect())).collect())
}

fn claude_zero_bucket() -> Value {
    json!({"input_tokens": 0, "cache_read_input_tokens": 0,
           "cache_creation_input_tokens": 0, "output_tokens": 0})
}

fn claude_bucket_add(bucket: &mut Value, u: i64, cr: i64, cw: i64, o: i64) {
    for (key, v) in [
        ("input_tokens", u),
        ("cache_read_input_tokens", cr),
        ("cache_creation_input_tokens", cw),
        ("output_tokens", o),
    ] {
        let cur = bucket.get(key).and_then(Value::as_i64).unwrap_or(0);
        bucket[key] = json!(cur + v);
    }
}

/// [`BillingWindowRow`]（Day 粒度）→ claude-ledger 形状的逐日 map。GROUP BY
/// 后 (日, 模型) 键唯一——insert 与累加等价；无模型行诚实略过（与历史两版
/// 折叠的联合语义一致）。
fn fold_billing_days(rows: Vec<BillingWindowRow>) -> BTreeMap<String, Value> {
    let mut days: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    for row in rows {
        let BillingWindowRow { idx, model, uncached_input_tokens: u, cache_read_tokens: cr, cache_write_tokens: cw, output_tokens: o } = row;
        let Some(model) = model else { continue };
        let date = civil_date_from_days(idx);
        days.entry(date).or_default().insert(
            model,
            json!({"input_tokens": u, "cache_read_input_tokens": cr,
                   "cache_creation_input_tokens": cw, "output_tokens": o}),
        );
    }
    days.into_iter().map(|(d, m)| (d, Value::Object(m))).collect()
}


/// claude 深历史聚合（`observation_kind='legacy_aggregate'`，spec §6.2.3）：
/// 只读 `event_peak=0` 行（`legacy_import::build_legacy_fact` 的"全量"行；
/// `event_peak=1` 是同一 (day,model) 的峰值子集重复编码，加进来就是双计——
/// 见本模块与 legacy_import 模块头共同强调的分离纪律）。形状与
/// [`claude_days`] 相同，供调用方在真实事实缺席的日期上兜底。
pub fn claude_legacy_days(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
) -> Result<BTreeMap<String, Value>, AuthorityError> {
    // 通用计费窗口（harness=claude-code × Day × LegacyAggregate）。
    let rows = billing_window_tokens(conn, &BillingWindowQuery {
        harness: "claude-code",
        grain: BillingGrain::Day,
        source: BillingSource::LegacyAggregate,
        start_ms,
        end_ms,
    })?;
    Ok(fold_billing_days(rows))
}

/// codex 的实时行级事实 → `by_hour_model` 形状（`{"YYYY-MM-DDTHH":
/// {model: {"standard": {5 桶}}}}`）——`harnesses::codex_usage::{codex_by_model_
/// from_hours, codex_aggregate_hours}` 与 `sessions::codex_cost::
/// codex_cost_report` 的输入形状。**speed 恒 "standard"**：codex 的
/// UsageFact emitter 从不记录 `service_tier`/speed（`harnesses/codex/sources/
/// usage_fact.rs` 只填 `model_raw`），但 `assets/codex_pricing.json` 的
/// `_note` 明写"真实数据 service_tier 恒为 null → standard"——真机从未观测
/// 到非 standard 速度，这不是精度损失，是如实反映数据。`reasoning_output_
/// tokens` 恒填 0：emitter 在写 `usage_facts.output_tokens` 时已经把
/// reasoning 并入 output（"决策 A"，模块头 `consumed_to_usage_fact` 的
/// 注释），这里不重复计入，避免双计。无时间戳的事实（`event_ts_ms IS
/// NULL`）被本查询天然排除——与旧 fold 路径「untimed 样本不进时间轴」的
/// 已知简化一致，不是本函数引入的新缺口。
pub fn codex_by_hour_model(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
) -> Result<Value, AuthorityError> {
    // 通用计费窗口（harness=codex × Hour × Realtime）——SQL 收敛；speeds 折叠
    // 形状（codex 折叠器的 wire 形状）留在本函数，属合法执行环境差异。
    let rows = billing_window_tokens(conn, &BillingWindowQuery {
        harness: "codex",
        grain: BillingGrain::Hour,
        source: BillingSource::Realtime,
        start_ms,
        end_ms,
    })?;
    let mut hours: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    for row in rows {
        let (hour_idx, model, u, cr, cw, o) =
            (row.idx, row.model, row.uncached_input_tokens, row.cache_read_tokens, row.cache_write_tokens, row.output_tokens);
        let Some(model) = model else { continue };
        let day_idx = hour_idx.div_euclid(24);
        let hour_of_day = hour_idx.rem_euclid(24);
        let key = format!("{}T{:02}", civil_date_from_days(day_idx), hour_of_day);
        let per_model = hours.entry(key).or_default();
        let entry = per_model.entry(model).or_insert_with(|| json!({}));
        let mut speeds = Map::new();
        speeds.insert(
            "standard".to_string(),
            json!({
                "uncached_input_tokens": u,
                "cached_input_tokens": cr,
                "cache_write_input_tokens": cw,
                "output_tokens": o,
                "reasoning_output_tokens": 0,
            }),
        );
        *entry = Value::Object(speeds);
    }
    Ok(Value::Object(
        hours
            .into_iter()
            .map(|(k, v)| (k, Value::Object(v)))
            .collect(),
    ))
}

/// Codex facts grouped by provider first, then in the legacy by-hour/model
/// shape. This keeps provider attribution from being folded into OpenAI costs.
/// 键 = `(provider, declared)`：`declared = true` 的组是用户归因到该计费方的事实
/// （`user_declared`，金额面进 `MeteredDeclared`），`false` 是事实自带/目录判定
/// 的 provider（默认估算）。同一 provider 两种来源分开返回，调用方决定 basis。
pub fn codex_by_hour_provider_model(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
) -> Result<BTreeMap<(String, bool), Value>, AuthorityError> {
    let mut stmt = conn.prepare(
        concat!("SELECT CAST((", local_hour_idx!(), " + (?1 - ?1) + (?2 - ?2)) AS INTEGER),
                COALESCE(decl.declared_provider, provider_id), decl.fact_id IS NOT NULL, model_id,
                SUM(uncached_input_tokens), SUM(cache_read_tokens),
                SUM(cache_write_tokens), SUM(output_tokens)
         FROM usage_facts
         ", user_declared_join!(), "
         WHERE harness = 'codex' AND observation_kind != 'legacy_aggregate'
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?3 AND event_ts_ms < ?4
           ", not_subscription_covered!(), "
         GROUP BY (", local_hour_idx!(), " + (?1 - ?1) + (?2 - ?2)), COALESCE(decl.declared_provider, provider_id),
                  decl.fact_id IS NOT NULL, model_id")
    )?;
    let rows = stmt.query_map(rusqlite::params![BEIJING_OFFSET_MS, HOUR_MS, start_ms, end_ms], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, bool>(2)?, r.get::<_, Option<String>>(3)?,
            r.get::<_, i64>(4)?, r.get::<_, i64>(5)?, r.get::<_, i64>(6)?, r.get::<_, i64>(7)?))
    })?;
    let mut out: BTreeMap<(String, bool), BTreeMap<String, Map<String, Value>>> = BTreeMap::new();
    for row in rows {
        let (hour_idx, provider, declared, model, u, cr, cw, o) = row?;
        let provider = (provider.unwrap_or_else(|| "<unknown>".to_string()), declared);
        let Some(model) = model else { continue };
        let key = format!("{}T{:02}", civil_date_from_days(hour_idx.div_euclid(24)), hour_idx.rem_euclid(24));
        let entry = out.entry(provider).or_default().entry(key).or_default();
        entry.insert(model, json!({"standard": {
            "uncached_input_tokens": u, "cached_input_tokens": cr,
            "cache_write_input_tokens": cw, "output_tokens": o,
            "reasoning_output_tokens": 0
        }}));
    }
    Ok(out.into_iter().map(|(p, h)| (p, Value::Object(h.into_iter().map(|(k,v)| (k, Value::Object(v))).collect()))).collect())
}

/// 一个执行环境在窗口内的**全量** 4 桶 token（不排除订阅覆盖的事实）。`tokens_by_harness`
/// 是 L0 感知层分母——「处理了多少 token」与「这些 token 归谁付钱」是两个问题：
/// 订阅覆盖只把事实移出**金额**面，token 本身照样发生过。此前 tokens_by_harness 是从
/// 金额面同一份聚合（`claude_days` / `codex_by_hour_model` / `peaked_days_map`，
/// 全部带 `not_subscription_covered!`）顺手取的，codex 订阅声明一生效，本月用量
/// 就从 2.8B 缩成 569M（2026-09-16 真机）。
///
/// 实时 vs `legacy_aggregate` 沿用 `summary::merged_claude_days` 的 **(日, 模型) 级
/// 选源**：同键实时优先、异键互补（legacy 只取 `event_peak = 0` 的 base 行），
/// 与账单轴同一条分离纪律（`q_acceptance::separation_discipline_*`）。零事实 →
/// None（不冒充 0）。
pub fn harness_tokens_all(
    conn: &Connection,
    harness: &str,
    start_ms: i64,
    end_ms: i64,
) -> Result<Option<(i64, i64, i64, i64)>, AuthorityError> {
    let by_day = harness_tokens_by_day_all(conn, harness, start_ms, end_ms)?;
    if by_day.is_empty() {
        return Ok(None);
    }
    let mut t = [0i64; 4];
    for b in by_day.values() {
        for i in 0..4 { t[i] += b[i]; }
    }
    Ok(Some((t[0], t[1], t[2], t[3])))
}

/// [`harness_tokens_all`] 的逐日版：`{YYYY-MM-DD: [u, cr, cw, o]}`，同一条「实时覆盖
/// legacy、不排除订阅覆盖」的纪律——日历格子的 token 数读它（此前日历读金额面的
/// `claude_days` / `codex_by_hour_model`，订阅声明一生效格子里的 token 跟着缩水，
/// 与月总量、小时图对不上）。
pub fn harness_tokens_by_day_all(
    conn: &Connection,
    harness: &str,
    start_ms: i64,
    end_ms: i64,
) -> Result<BTreeMap<String, [i64; 4]>, AuthorityError> {
    let mut stmt = conn.prepare(concat!(
        "SELECT (", local_day_idx!(), " + (?1 - ?1) + (?2 - ?2)) AS day_idx,
                COALESCE(model_id, ''), observation_kind = 'legacy_aggregate',
                SUM(uncached_input_tokens), SUM(cache_read_tokens),
                SUM(cache_write_tokens), SUM(output_tokens)
         FROM usage_facts
         WHERE harness = ?3 AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?4 AND event_ts_ms < ?5
           AND (observation_kind != 'legacy_aggregate' OR event_peak = 0)
         GROUP BY day_idx, model_id, observation_kind = 'legacy_aggregate'"
    ))?;
    let rows = stmt.query_map(rusqlite::params![BEIJING_OFFSET_MS, DAY_MS, harness, start_ms, end_ms], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?,
            r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?, r.get::<_, i64>(6)?))
    })?;
    // (day, model) → (is_legacy, 4 桶)：实时覆盖 legacy。
    let mut chosen: BTreeMap<(i64, String), (bool, [i64; 4])> = BTreeMap::new();
    for row in rows {
        let (day, model, legacy, u, cr, cw, o) = row?;
        let slot = chosen.entry((day, model)).or_insert((legacy, [u, cr, cw, o]));
        if slot.0 && !legacy {
            *slot = (false, [u, cr, cw, o]);
        }
    }
    let mut out: BTreeMap<String, [i64; 4]> = BTreeMap::new();
    for ((day, _model), (_, b)) in chosen {
        let slot = out.entry(civil_date_from_days(day)).or_insert([0; 4]);
        for i in 0..4 { slot[i] += b[i]; }
    }
    Ok(out)
}

/// coverage 分母版本（Phase 3.3 设计定稿）：三维定义（usage / price / sync）
/// 的演进刻度。定义变更必须递增——旧快照的覆盖率与新快照不可无声互比
/// （data_contract::CoverageStatus 的同一条纪律）。
pub const COVERAGE_DENOMINATOR_VERSION: u32 = 1;

/// 一个执行环境在 `[start_ms, end_ms)` 窗口内的三维 coverage（measured, total）。
/// `total` 恒 3，`measured` ∈ 0..=3；窗口零事实 → (0, 0, 0)——「从没观测到」
/// 是三维全空，不是三维全满。分母定义见 [`COVERAGE_DENOMINATOR_VERSION`]：
///
/// - **usage 维**：窗口内有可解析时间戳的事实（`event_ts_ms IS NOT NULL`、
///   未软删除）。「接线了」是能力不是观测，永不计入。
/// - **price 维**：窗口内 token 非零的每个 distinct 模型都能经
///   `billing_route_of` 归属到已知 provider。认不出的模型（glm-* 无价卡、
///   moonshot 无声明）让本维不算 measured——与 `has_unresolved` 同源，
///   「看见了 token、钱不可归」就是覆盖缺口。
/// - **sync 维**（refinement，2026-09-07）：`source_files` 该执行环境的
///   `MAX(last_seen_at_ms) >= MAX(窗口内 event_ts_ms)`——窗口内最后一次
///   事件已被某次同步观测到。历史月份自然成立；托盘停摆时当前窗口归 0。
///   不读时钟（data crate 纪律），比较双方都来自库内。
///
/// 返回 `(measured, total)`；`denominator_version` 由调用方配
/// [`COVERAGE_DENOMINATOR_VERSION`]。
pub fn coverage_status(
    conn: &Connection,
    harness: &str,
    start_ms: i64,
    end_ms: i64,
) -> Result<(u64, u64), AuthorityError> {
    const TOTAL: u64 = 3;
    // usage 维 + price 维的模型清单一次查询拿齐。
    let usage_measured: i64 = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM usage_facts
             WHERE harness = ?1 AND deleted_at_ms IS NULL
               AND event_ts_ms IS NOT NULL AND event_ts_ms >= ?2 AND event_ts_ms < ?3)",
        rusqlite::params![harness, start_ms, end_ms],
        |r| r.get(0),
    )?;
    if usage_measured == 0 {
        return Ok((0, TOTAL));
    }
    // price 维：窗口内 token 非零的 distinct model_id 逐个过声明表。
    // model_id 为 NULL 的行不参与（未归属 → 与 peaked_days_map 的 fallback
    // 缺口同语义；当前 emitter 恒填 model_raw 所以库内为空）。
    let mut stmt = conn.prepare(
        "SELECT DISTINCT model_id FROM usage_facts
         WHERE harness = ?1 AND deleted_at_ms IS NULL AND model_id IS NOT NULL
           AND event_ts_ms >= ?2 AND event_ts_ms < ?3
           AND (uncached_input_tokens + cache_read_tokens
                + cache_write_tokens + output_tokens) > 0",
    )?;
    let models: Vec<String> = stmt
        .query_map(rusqlite::params![harness, start_ms, end_ms], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut measured: u64 = 1; // usage 维已确认
    if !models.is_empty() {
        let pricing = agent_vitals_domain::cost::load_pricing();
        let all_routed = models
            .iter()
            .all(|m| agent_vitals_domain::cost::billing_route_of(m, &pricing).is_some());
        if all_routed {
            measured += 1;
        }
    }
    // sync 维：该执行环境最近一次同步观测 ≥ 窗口内最后一次事件。
    let max_event: Option<i64> = conn
        .query_row(
            "SELECT MAX(event_ts_ms) FROM usage_facts
             WHERE harness = ?1 AND deleted_at_ms IS NULL
               AND event_ts_ms IS NOT NULL AND event_ts_ms >= ?2 AND event_ts_ms < ?3",
            rusqlite::params![harness, start_ms, end_ms],
            |r| r.get(0),
        )
        .unwrap_or(None);
    let max_seen: Option<i64> = conn
        .query_row(
            "SELECT MAX(last_seen_at_ms) FROM source_files WHERE harness = ?1",
            rusqlite::params![harness],
            |r| r.get(0),
        )
        .unwrap_or(None);
    if let (Some(ev), Some(seen)) = (max_event, max_seen) {
        if seen >= ev {
            measured += 1;
        }
    }
    Ok((measured, TOTAL))
}

/// Q04 下钻的最小事实分页（3.7a，spec §4 `facts_page(filters, cursor)` 的
/// 窗口切片版）：`[start_ms, end_ms)` × harness × 可选小时过滤，按
/// `(event_ts_ms, fact_id)` 稳定排序，cursor 分页（`limit` 行 + 下一页
/// 起点键）。**排除 legacy_aggregate**——下钻消费的是行级事实，聚合行是
/// 日轴账单不是会话证据（§4 分离纪律）。行形状 = Q04 需要的最小集：
/// fact_id/native_session_id（会话聚合键）/model_id/事件时间/四桶——
/// 「会话 token 合计严格等于峰值」的下钻靠 native_session_id 分组。
#[derive(Debug, Clone)]
pub struct FactPageRow {
    pub fact_id: String,
    pub native_session_id: String,
    pub model_id: Option<String>,
    pub event_ts_ms: i64,
    pub uncached_input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
}

/// cursor = 上一页最后一行的 `(event_ts_ms, fact_id)`（键集分页，无 OFFSET
/// 漂移）；`None` = 首页。返回 (rows, has_more)。
pub fn facts_page_window(
    conn: &Connection,
    harness: &str,
    start_ms: i64,
    end_ms: i64,
    after_ts: Option<i64>,
    after_fact_id: Option<&str>,
    limit: usize,
) -> Result<(Vec<FactPageRow>, bool), AuthorityError> {
    let mut stmt = conn.prepare(SQL_FACTS_PAGE_WINDOW)?;
    let rows = stmt.query_map(
        rusqlite::params![
            harness,
            start_ms,
            end_ms,
            after_ts.unwrap_or(i64::MIN),
            after_fact_id.unwrap_or(""),
            limit as i64 + 1, // 多取一行判 has_more
        ],
        |r| {
            Ok(FactPageRow {
                fact_id: r.get(0)?,
                native_session_id: r.get(1)?,
                model_id: r.get(2)?,
                event_ts_ms: r.get(3)?,
                uncached_input_tokens: r.get(4)?,
                cache_read_tokens: r.get(5)?,
                cache_write_tokens: r.get(6)?,
                output_tokens: r.get(7)?,
            })
        },
    )?;
    let mut rows: Vec<FactPageRow> = rows.collect::<Result<_, _>>()?;
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    Ok((rows, has_more))
}

/// 三执行环境统一的北京小时轴（3.5 Tier B：`hourly_distribution` 的 SQL 数据源
/// ——取代旧 facts-index 投影，行级事实本就都在 `usage_facts`，旧索引是
/// 可丢弃投影、权威读面没有理由绕它）。返回 `{harness: {"HH": tokens}}`，
/// tokens = 四桶之和，只装非零小时（与旧 `hours_by_harness` 同形）。DSH 的
/// 峰谷维度在小时轴上不保留（小时分布是「活跃度」视图；峰谷计价走
/// [`peaked_days_map`]）。
pub fn hourly_by_harness(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
) -> Result<BTreeMap<String, BTreeMap<String, i64>>, AuthorityError> {
    let mut stmt = conn.prepare(
        concat!("SELECT harness,
                CAST((", local_hour_idx!(), " + (?1 - ?1) + (?2 - ?2)) % 24 AS TEXT) AS local_hour,
                SUM(uncached_input_tokens + cache_read_tokens
                    + cache_write_tokens + output_tokens)
         FROM usage_facts
         WHERE observation_kind != 'legacy_aggregate'
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?3 AND event_ts_ms < ?4
         GROUP BY harness, local_hour"),
    )?;
    let rows = stmt.query_map(
        rusqlite::params![BEIJING_OFFSET_MS, HOUR_MS, start_ms, end_ms],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        },
    )?;
    let mut out: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for row in rows {
        let (harness, hour, total) = row?;
        if total > 0 {
            out.entry(harness)
                .or_default()
                .insert(format!("{:0>2}", hour), total);
        }
    }
    Ok(out)
}

/// [`harness_window_tokens`]：单执行环境窗口四桶之和 + 最新北京日索引。
pub(crate) const SQL_HARNESS_WINDOW_TOKENS: &str = concat!("SELECT COUNT(*),
                COALESCE(SUM(uncached_input_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_write_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                MAX(", local_day_idx!(), " + (?1 - ?1) + (?2 - ?2))
         FROM usage_facts
         WHERE harness = ?3
           AND observation_kind != 'legacy_aggregate'
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?4 AND event_ts_ms < ?5");

/// 一个执行环境在窗口内的四桶之和（执行环境无关的 L0 计量——`tokens_by_harness` 的通用
/// 数据源；有自己价卡管线的执行环境仍走各自的 days/hours 查询，这个给**只有 token、
/// 没有金额**的执行环境用，E4b 的 workbuddy 是首个消费方）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessWindowTokens {
    pub facts: i64,
    pub uncached_input: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub output: i64,
    /// 窗口内最新事实的北京日 `YYYY-MM-DD`（freshness 的观测点）。
    pub latest_day: String,
}

/// `None` = 该执行环境窗口内没有任何事实行（消费方必须渲染 unavailable，不能编 0）；
/// `Some` 且四桶全 0 = 同步过、真零。
pub fn harness_window_tokens(
    conn: &Connection,
    harness: &str,
    start_ms: i64,
    end_ms: i64,
) -> Result<Option<HarnessWindowTokens>, AuthorityError> {
    let row = conn.query_row(
        SQL_HARNESS_WINDOW_TOKENS,
        rusqlite::params![BEIJING_OFFSET_MS, DAY_MS, harness, start_ms, end_ms],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<i64>>(5)?,
            ))
        },
    )?;
    let (facts, u, cr, cw, o, day_idx) = row;
    let Some(day_idx) = day_idx else {
        return Ok(None);
    };
    if facts == 0 {
        return Ok(None);
    }
    Ok(Some(HarnessWindowTokens {
        facts,
        uncached_input: u,
        cache_read: cr,
        cache_write: cw,
        output: o,
        latest_day: civil_date_from_days(day_idx),
    }))
}

/// 一个北京日窗口内各执行环境的 token 总量。与 [`hourly_by_harness`] 不同，这里保留
/// token 恰为零的事实行：调用方因此可以区分“已同步且真零”（map 中为 0）和
/// “该执行环境在窗口内没有任何 SQL 事实”（缺键，必须渲染为 unavailable/unknown，
/// 不能编成 0）。
pub fn token_totals_by_harness(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
) -> Result<BTreeMap<String, i64>, AuthorityError> {
    let mut stmt = conn.prepare(
        "SELECT harness,
                SUM(uncached_input_tokens + cache_read_tokens
                    + cache_write_tokens + output_tokens)
         FROM usage_facts
         WHERE observation_kind != 'legacy_aggregate'
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?1 AND event_ts_ms < ?2
         GROUP BY harness",
    )?;
    let rows = stmt.query_map(rusqlite::params![start_ms, end_ms], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    rows.collect::<Result<_, _>>().map_err(AuthorityError::from)
}

/// PR #2.3：`sessions navigation` 今日 token 的只读快照——按 harness 聚合
/// `usage_facts` 在指定北京日内的 4 桶之和。返回 `None` = 库不可读（与
/// r2a_store `authority_day_token_totals` 同语义）。
///
/// 与 `token_totals_by_harness` 同款 SQL，只是把 [start,end) ms 解析收敛到
/// 这里，避免每个调用方各自做 `beijing_day_bounds_ms` 的 null 检查再 +1 行。
pub fn day_token_totals_by_harness(
    data_home: &std::path::Path,
    date: &str,
) -> Option<BTreeMap<String, i64>> {
    let (start_ms, end_ms) = beijing_day_bounds_ms(date)?;
    let path = crate::authority::default_authority_path(data_home);
    let db = crate::authority::AuthorityDb::open_readonly(&path).ok()?;
    token_totals_by_harness(db.conn(), start_ms, end_ms).ok()
}

/// PR #2.3：`sessions navigation` 今日 session 数（distinct `session_key`），
/// 按 harness 分组。SQL 权威库不可读 → 返回 `None`（CLI 降级到 0 而不是冒充）。
pub fn day_session_count(data_home: &std::path::Path, date: &str, harness: &str) -> Option<i64> {
    let (start_ms, end_ms) = beijing_day_bounds_ms(date)?;
    let path = crate::authority::default_authority_path(data_home);
    let db = crate::authority::AuthorityDb::open_readonly(&path).ok()?;
    let n: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(DISTINCT session_key) FROM usage_facts
             WHERE observation_kind != 'legacy_aggregate'
               AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
               AND harness = ?1 AND event_ts_ms >= ?2 AND event_ts_ms < ?3",
            rusqlite::params![harness, start_ms, end_ms],
            |r| r.get(0),
        )
        .ok()?;
    Some(n)
}

/// `(harness, model)` 序列在 24 个北京小时桶上的 token 分计。
pub type HarnessModelHourBuckets = BTreeMap<String, HourlyCell>;

/// `hourly_by_harness_model` 返回值类型——`(harness, model)` → 24 桶 map。
pub type HarnessModelHourly = BTreeMap<(String, String), HarnessModelHourBuckets>;

/// `usage_hourly` 工具（spec §7.2）的 SQL 数据源：`(harness, model, hour)` 三维
/// 聚合 + 四桶分计。`legacy_aggregate` 始终排除（聚合兜底行不可作小时轴可信值，
/// 与 `hourly_by_harness` 同一条窗口过滤纪律）。
///
/// 返回 `HarnessModelHourly`——`hourly_by_harness` 同款 (key, value) 形状 + `model`
/// 第二维。`model_id` 是执行环境 raw 值（spec §5.1 规则 4 + D3，`usage_facts.model_id`
/// 暂未归一为 canonical）。
pub fn hourly_by_harness_model(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
    harnesses: &[String],
) -> Result<HarnessModelHourly, AuthorityError> {
    // 单执行环境查询（`harness = ?` 命中 `usage_facts_harness_time` 索引）——三执行环境
    // 聚合用 in-memory 合并。详见 `SQL_HOURLY_BY_HARNESS_MODEL` 的注释。
    let selected: Vec<String> = if harnesses.is_empty() {
        conn.prepare("SELECT DISTINCT harness FROM usage_facts WHERE deleted_at_ms IS NULL ORDER BY harness")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?
    } else {
        harnesses.to_vec()
    };
    if selected.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut out: HarnessModelHourly = BTreeMap::new();
    for harness in selected {
        let mut stmt = conn.prepare(SQL_HOURLY_BY_HARNESS_MODEL)?;
        let rows = stmt.query_map(
            rusqlite::params![BEIJING_OFFSET_MS, HOUR_MS, start_ms, end_ms, harness],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            },
        )?;
        for row in rows {
            let (harness, model, hour, uncached, cache_read, cache_write, output) = row?;
            let cell = HourlyCell { uncached_input_tokens: uncached, cache_read_tokens: cache_read, cache_write_tokens: cache_write, output_tokens: output };
            out.entry((harness, model)).or_default().insert(format!("{:0>2}", hour), cell);
        }
    }
    Ok(out)
}

pub fn hourly_by_harness_provider(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
    harnesses: &[String],
) -> Result<HarnessModelHourly, AuthorityError> {
    let selected: Vec<String> = if harnesses.is_empty() {
        conn.prepare("SELECT DISTINCT harness FROM usage_facts WHERE deleted_at_ms IS NULL ORDER BY harness")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?
    } else { harnesses.to_vec() };
    let mut out: HarnessModelHourly = BTreeMap::new();
    for harness in selected {
        let mut stmt = conn.prepare(SQL_HOURLY_BY_HARNESS_PROVIDER)?;
        let rows = stmt.query_map(
            rusqlite::params![BEIJING_OFFSET_MS, HOUR_MS, start_ms, end_ms, harness],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?, r.get::<_, i64>(6)?)),
        )?;
        for row in rows {
            let (harness, provider, hour, uncached, cache_read, cache_write, output) = row?;
            out.entry((harness, provider)).or_default().insert(format!("{:0>2}", hour), HourlyCell {
                uncached_input_tokens: uncached, cache_read_tokens: cache_read,
                cache_write_tokens: cache_write, output_tokens: output,
            });
        }
    }
    Ok(out)
}

/// `(harness, hour)` 单元——四桶原始计数 + 派生 `total`。`cache_hit_ratio` 与
/// `HourlyCell` 的 `HourlyCell::to_json()` 在响应层算（spec §6.2 诚实
/// 返回原则：输入侧全零 → `null`，不外推 0）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HourlyCell {
    pub uncached_input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
}

impl HourlyCell {
    /// 四桶之和 = 总 token（M0 §5.1.1 守恒由构造）。
    pub fn total(&self) -> i64 {
        self.uncached_input_tokens + self.cache_read_tokens + self.cache_write_tokens + self.output_tokens
    }

    /// cache_hit_ratio = cache_read / (uncached + cache_read + cache_write)；
    /// 输入侧全零 → `None`（不是 0）。
    pub fn cache_hit_ratio(&self) -> Option<f64> {
        let input = self.uncached_input_tokens + self.cache_read_tokens + self.cache_write_tokens;
        if input == 0 {
            None
        } else {
            Some(self.cache_read_tokens as f64 / input as f64)
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "uncached_input_tokens": self.uncached_input_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "output_tokens": self.output_tokens,
            "total": self.total(),
            "cache_hit_ratio": self.cache_hit_ratio(),
        })
    }
}

// ─────────────────────── Q04 会话下钻 ───────────────────────

/// 一个会话在查询窗口（可再按北京小时过滤）内的聚合。`session_key` 内嵌执行环境
/// 原生 id——**调用方（MCP 工具）必须 HMAC 成 `session_ref`，绝不原样返回**。
#[derive(Debug, Clone)]
pub struct SessionAgg {
    pub session_key: String,
    pub harness: String,
    pub first_event_ms: i64,
    pub last_event_ms: i64,
    pub event_count: i64,
    pub uncached_input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
    /// 其中落在 DSH 高峰时段的 token（`event_peak != 0`）。
    pub peak_tokens: i64,
    pub model_ids: Vec<String>,
}

impl SessionAgg {
    pub fn total(&self) -> i64 {
        self.uncached_input_tokens
            + self.cache_read_tokens
            + self.cache_write_tokens
            + self.output_tokens
    }
}

/// 单执行环境 SQL（`harness = ?1` 命中 `usage_facts_harness_time`）。`?4 < 0` = 不按小时
/// 过滤；否则只算 `bj_hour == ?4` 的事实——**Q04 峰值下钻**要的正是「该小时
/// 的会话构成」，SUM 因此自动被 WHERE 收窄到那一小时。
/// 会话是 token/时间视图，**不排除订阅覆盖的事实**——订阅内的会话也发生过；曾排除
/// 导致订阅声明一生效，会话列表与峰值小时下钻整段空掉（mcp_smoke Q04：峰值小时
/// 13.8M tokens、构成会话 0 个，2026-09-17）。钱归谁由 `session_billing_buckets`
/// 的 billing_mode 表达，不靠隐藏会话。
const SQL_SESSIONS_IN_WINDOW: &str = "SELECT session_key, harness,
            MIN(event_ts_ms), MAX(event_ts_ms), COUNT(*),
            SUM(uncached_input_tokens), SUM(cache_read_tokens),
            SUM(cache_write_tokens), SUM(output_tokens),
            SUM(CASE WHEN event_peak != 0 THEN
                (uncached_input_tokens + cache_read_tokens
                 + cache_write_tokens + output_tokens) ELSE 0 END),
            GROUP_CONCAT(DISTINCT COALESCE(model_id, '<unknown>'))
     FROM usage_facts
     WHERE harness = ?1
       AND observation_kind != 'legacy_aggregate'
       AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
       AND session_key IS NOT NULL
       AND event_ts_ms >= ?2 AND event_ts_ms < ?3
       AND (?4 < 0 OR (CAST(strftime('%H', event_ts_ms / 1000, 'unixepoch', printf('%+d hours', (?5 / ?6))) AS INTEGER) = ?4))
       AND (?7 IS NULL OR COALESCE(model_id, '<unknown>') = ?7)
       AND (?8 IS NULL OR COALESCE(provider_id, '<unknown>') = ?8)
       GROUP BY session_key";

/// 窗口内的会话聚合，跨 wired 执行环境合并。`hour` = 北京小时过滤（`None` = 不过滤）；
/// `min_tokens` = HAVING 门槛；按 `total` 降序 + `session_key` 升序稳定排序，
/// keyset 分页（cursor = 上一页尾行的 `(total, session_key)`）。返回 (rows,
/// has_more, window_total_tokens, window_session_count)——`window_total_tokens` 让调用方核对
/// 「所有会话之和 == 窗口/峰值总量」（Q04 不变式）。
#[allow(clippy::too_many_arguments)]
pub fn sessions_in_window(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
    harnesses: &[String],
    model: Option<&str>,
    provider: Option<&str>,
    hour: Option<u32>,
    min_tokens: i64,
    after_total: Option<i64>,
    after_key: Option<&str>,
    limit: usize,
) -> Result<(Vec<SessionAgg>, bool, i64, usize), AuthorityError> {
    sessions_in_window_ordered(
        conn, start_ms, end_ms, harnesses, model, provider, hour, min_tokens,
        after_total, after_key, limit, false,
    )
}

/// `sessions_in_window` 的全参版。`oldest_first=true` 时排序与 keyset 游标改为
/// `(first_event_ms, session_key)` 升序——供桌面 City 装载器从最老数据开始分页
/// （默认的 token 降序在装载上限内只会到达「token 最大」的会话，一年窗口下
/// 最老的城市地基永远到不了）。游标编码仍是 (i64, String) 对，语义随排序变。
#[allow(clippy::too_many_arguments)] // 查询面就是这十来个过滤器；包结构体反而破坏调用点可读性
pub fn sessions_in_window_ordered(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
    harnesses: &[String],
    model: Option<&str>,
    provider: Option<&str>,
    hour: Option<u32>,
    min_tokens: i64,
    after_total: Option<i64>,
    after_key: Option<&str>,
    limit: usize,
    oldest_first: bool,
) -> Result<(Vec<SessionAgg>, bool, i64, usize), AuthorityError> {
    let selected: Vec<String> = if harnesses.is_empty() {
        conn.prepare("SELECT DISTINCT harness FROM usage_facts WHERE deleted_at_ms IS NULL ORDER BY harness")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?
    } else {
        harnesses.to_vec()
    };
    let hour_param: i64 = hour.map(|h| h as i64).unwrap_or(-1);

    let mut all: Vec<SessionAgg> = Vec::new();
    for harness in selected {
        let mut stmt = conn.prepare(SQL_SESSIONS_IN_WINDOW)?;
        let rows = stmt.query_map(
            rusqlite::params![harness, start_ms, end_ms, hour_param, BEIJING_OFFSET_MS, HOUR_MS, model, provider],
            |r| {
                let models: Option<String> = r.get(10)?;
                Ok(SessionAgg {
                    session_key: r.get(0)?,
                    harness: r.get(1)?,
                    first_event_ms: r.get(2)?,
                    last_event_ms: r.get(3)?,
                    event_count: r.get(4)?,
                    uncached_input_tokens: r.get(5)?,
                    cache_read_tokens: r.get(6)?,
                    cache_write_tokens: r.get(7)?,
                    output_tokens: r.get(8)?,
                    peak_tokens: r.get(9)?,
                    model_ids: models
                        .map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
                        .unwrap_or_default(),
                })
            },
        )?;
        for row in rows {
            all.push(row?);
        }
    }

    let window_total: i64 = all.iter().map(SessionAgg::total).sum();
    let window_session_count = all.len();

    all.retain(|s| s.total() >= min_tokens);
    if oldest_first {
        // first_event 升序、session_key 升序——「从最老的数据开始」的分页序。
        all.sort_by(|x, y| x.first_event_ms.cmp(&y.first_event_ms).then_with(|| x.session_key.cmp(&y.session_key)));
        if let (Some(at), Some(ak)) = (after_total, after_key) {
            all.retain(|s| s.first_event_ms > at || (s.first_event_ms == at && s.session_key.as_str() > ak));
        }
    } else {
        // total 降序、session_key 升序——稳定、可 keyset 分页。
        all.sort_by(|x, y| y.total().cmp(&x.total()).then_with(|| x.session_key.cmp(&y.session_key)));
        if let (Some(at), Some(ak)) = (after_total, after_key) {
            all.retain(|s| s.total() < at || (s.total() == at && s.session_key.as_str() > ak));
        }
    }
    let has_more = all.len() > limit;
    all.truncate(limit);
    Ok((all, has_more, window_total, window_session_count))
}

/// 一个会话的行级事实时间线（`session_detail`）。按 `(event_ts_ms, fact_id)`
/// keyset 分页。排除 `legacy_aggregate`（聚合行不是会话证据，§4 分离纪律）。
#[derive(Debug, Clone)]
pub struct TimelineFact {
    pub fact_id: String,
    pub model_id: Option<String>,
    pub event_ts_ms: i64,
    pub event_peak: bool,
    pub uncached_input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
    pub observation_kind: String,
}

const SQL_SESSION_TIMELINE: &str = "SELECT fact_id, model_id, event_ts_ms, event_peak,
            uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
            observation_kind
     FROM usage_facts
     WHERE session_key = ?1
       AND observation_kind != 'legacy_aggregate'
       AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
       AND (event_ts_ms, fact_id) > (?2, ?3)
     ORDER BY event_ts_ms, fact_id
     LIMIT ?4";

/// 返回 (facts, has_more)。`session_key` 由调用方从 `session_ref` 反解得到。
pub fn session_facts_timeline(
    conn: &Connection,
    session_key: &str,
    after_ts: Option<i64>,
    after_fact_id: Option<&str>,
    limit: usize,
) -> Result<(Vec<TimelineFact>, bool), AuthorityError> {
    let mut stmt = conn.prepare(SQL_SESSION_TIMELINE)?;
    let rows = stmt.query_map(
        rusqlite::params![
            session_key,
            after_ts.unwrap_or(i64::MIN),
            after_fact_id.unwrap_or(""),
            limit as i64 + 1,
        ],
        |r| {
            Ok(TimelineFact {
                fact_id: r.get(0)?,
                model_id: r.get(1)?,
                event_ts_ms: r.get(2)?,
                event_peak: r.get::<_, i64>(3)? != 0,
                uncached_input_tokens: r.get(4)?,
                cache_read_tokens: r.get(5)?,
                cache_write_tokens: r.get(6)?,
                output_tokens: r.get(7)?,
                observation_kind: r.get(8)?,
            })
        },
    )?;
    let mut rows: Vec<TimelineFact> = rows.collect::<Result<_, _>>()?;
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    Ok((rows, has_more))
}

/// 会话行的执行环境 + 元数据（`session_detail` 组 envelope 用）。`None` = 会话不存在
/// 或已 soft-delete。
pub fn session_row(
    conn: &Connection,
    session_key: &str,
) -> Result<Option<(String, Option<String>)>, AuthorityError> {
    conn.query_row(
        "SELECT harness, source_profile FROM sessions
         WHERE session_key = ?1 AND deleted_at_ms IS NULL",
        rusqlite::params![session_key],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
    )
    .optional()
    .map_err(AuthorityError::from)
}

/// `session_detail` 反解 `session_ref` 用的候选 `session_key` 全集。本机量级
/// （真机 ~300），逐个算 HMAC 找匹配是微秒级。
pub fn all_session_keys(conn: &Connection) -> Result<Vec<String>, AuthorityError> {
    let mut stmt = conn.prepare("SELECT session_key FROM sessions WHERE deleted_at_ms IS NULL")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect::<Result<_, _>>().map_err(AuthorityError::from)
}

/// 一个计费桶（同执行环境、模型、provider、峰谷档）喂给
/// `agent_vitals_domain::cost::metered_estimate_minor` 的用量形状。会话成本分桶
/// 与会话消耗诊断的回合名义成本（`query::session_insights`）共用这一份——
/// 两处的桶形状一旦分叉，同一会话的两个金额就会对不上。
/// `tokens` = `[uncached_input, cache_read, cache_write, output]`。
pub fn billing_bucket_usage_json(
    harness: &str,
    model_id: &str,
    provider_id: Option<&str>,
    peak: bool,
    tokens: [i64; 4],
) -> Value {
    let [uncached, cache_read, cache_write, output] = tokens;
    let at_peak = |value: i64| if peak { value } else { 0 };
    if harness == "claude-code" {
        json!({"by_model": { model_id: {
            "input_tokens": uncached, "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_write, "output_tokens": output,
            "peak_input_tokens": at_peak(uncached),
            "peak_cache_read_input_tokens": at_peak(cache_read),
            "peak_cache_creation_input_tokens": at_peak(cache_write),
            "peak_output_tokens": at_peak(output),
        }}})
    } else if harness == "codex" {
        json!({"by_model": { model_id: {
            "uncached_input_tokens": uncached, "cached_input_tokens": cache_read,
            "cache_write_input_tokens": cache_write, "output_tokens": output,
            "reasoning_output_tokens": 0,
        }}})
    } else {
        json!({"by_model": { model_id: {
            "uncached_input_tokens": uncached, "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write, "output_tokens": output,
            "peak_uncached_input_tokens": at_peak(uncached),
            "peak_cache_read_tokens": at_peak(cache_read),
            "peak_cache_write_tokens": at_peak(cache_write),
            "peak_output_tokens": at_peak(output),
        }}, "providers": { model_id: provider_id }})
    }
}

/// 按历史快照计价；快照里当时没有这个模型的卡、而每日同步叠加层后来补上了
/// 时，用补过缺卡的快照再算一次（`fill_missing_in_snapshot` 只补缺卡、不改已有
/// 价，厂商调价不会改写历史）。返回 `(金额, 是否靠回补才算出来)`。
pub fn price_with_sync_backfill(
    harness: &str,
    usage: &Value,
    snapshot_payload: Option<&str>,
    sync_overlay: Option<&Value>,
) -> (Option<agent_vitals_domain::data_contract::MoneyMinor>, bool) {
    let Some(mut snapshot) = snapshot_payload.and_then(|p| serde_json::from_str::<Value>(p).ok()) else {
        return (None, false);
    };
    if let Some(cost) = agent_vitals_domain::cost::metered_estimate_minor(harness, usage, &snapshot) {
        return (Some(cost), false);
    }
    let Some(overlay) = sync_overlay else { return (None, false) };
    agent_vitals_domain::cost::sync_overlay::fill_missing_in_snapshot(&mut snapshot, overlay);
    let cost = agent_vitals_domain::cost::metered_estimate_minor(harness, usage, &snapshot);
    let backfilled = cost.is_some();
    (cost, backfilled)
}

/// v0.12 会话成本的可追溯分桶。这里仅聚合权威事实及其计费归属，不在 data
/// 层复制价格规则；调用方可将每个独立桶交给 domain 成本引擎。分组中保留
/// `provider_raw`，因为无法安全归一化的 custom 路由仍必须可见，不能并入
/// `<unknown>` 或 OpenAI。
pub fn session_billing_buckets(
    conn: &Connection,
    session_key: &str,
) -> Result<Vec<Value>, AuthorityError> {
    session_billing_buckets_in_window(conn, session_key, None)
}

/// Same billing buckets restricted to an inclusive event-time window. City
/// uses this so the building's estimate matches the tokens shown for its view.
pub fn session_billing_buckets_in_window(
    conn: &Connection,
    session_key: &str,
    window: Option<(i64, i64)>,
) -> Result<Vec<Value>, AuthorityError> {
    let mut grouped = sessions_billing_buckets_in_window(conn, &[session_key.to_string()], window)?;
    Ok(grouped.remove(session_key).unwrap_or_default())
}

/// Shared batch read: schema and sync overlay are read once per request, not once per building.
/// The session keys are internal query inputs and never belong to a serving DTO.
pub fn sessions_billing_buckets_in_window(
    conn: &Connection,
    session_keys: &[String],
    window: Option<(i64, i64)>,
) -> Result<std::collections::BTreeMap<String, Vec<Value>>, AuthorityError> {
    sessions_billing_buckets_impl(conn, session_keys, window, false)
}

/// Local presentation only: when no historical snapshot exists, offer an explicitly
/// dated reference estimate from the latest local snapshot. Never changes historical
/// billing, MCP/export defaults, persisted facts, or subscription attribution.
pub fn sessions_billing_buckets_with_reference_in_window(
    conn: &Connection,
    session_keys: &[String],
    window: Option<(i64, i64)>,
) -> Result<std::collections::BTreeMap<String, Vec<Value>>, AuthorityError> {
    sessions_billing_buckets_impl(conn, session_keys, window, true)
}

fn sessions_billing_buckets_impl(
    conn: &Connection,
    session_keys: &[String],
    window: Option<(i64, i64)>,
    allow_reference: bool,
) -> Result<std::collections::BTreeMap<String, Vec<Value>>, AuthorityError> {
    let reference_snapshot = if allow_reference {
        conn.query_row(
            "SELECT pricing_version, payload_json, captured_at_ms FROM pricing_snapshots
             ORDER BY captured_at_ms DESC, pricing_version DESC LIMIT 1",
            [], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
        ).optional()?
    } else { None };
    // Trace fixtures from before v1.0 intentionally omit the derived attribution
    // tables. Keep their scalar billing_mode path, while production databases use
    // the latest saved subscription attribution as the authoritative session view.
    let has_fact_attributions: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'billing_fact_attributions')
         AND EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'billing_declaration_revisions')
         AND EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'billing_recalculation_jobs')",
        [],
        |row| row.get(0),
    )?;
    let billing_mode_expr = if has_fact_attributions {
        "CASE WHEN EXISTS (SELECT 1 FROM billing_fact_attributions ba
                    JOIN billing_declaration_revisions br ON br.revision_id = ba.revision_id
                    JOIN billing_recalculation_jobs bj ON bj.job_id = ba.job_id AND bj.status = 'succeeded'
                    WHERE ba.fact_id = f.fact_id AND ba.attribution_kind = 'subscription_covered'
                      AND br.revision_number = (SELECT MAX(br2.revision_number)
                        FROM billing_declaration_revisions br2
                        LEFT JOIN billing_recalculation_jobs bj2 ON bj2.revision_id = br2.revision_id AND bj2.status = 'succeeded'
                        WHERE br2.declaration_id = br.declaration_id AND (br2.change_kind = 'revoked' OR bj2.job_id IS NOT NULL))
                      AND br.change_kind = 'saved')
             THEN 'subscription' ELSE COALESCE(f.billing_mode, 'unknown') END"
    } else {
        "COALESCE(f.billing_mode, 'unknown')"
    };
    let time_filter = if window.is_some() {
        " AND f.event_ts_ms >= ?2 AND f.event_ts_ms <= ?3"
    } else { "" };
    let query = format!(
        "SELECT f.harness, f.provider_id, f.provider_raw, COALESCE(f.model_id, '<unknown>'),
                f.billing_template_id, {billing_mode_expr},
                COALESCE(f.pricing_basis, 'unavailable'), COALESCE(f.evidence_basis, 'missing'),
                f.event_peak, ps.pricing_version, ps.payload_json,
                SUM(uncached_input_tokens), SUM(cache_read_tokens),
                SUM(cache_write_tokens), SUM(output_tokens), MAX(f.event_ts_ms), f.session_key
         FROM usage_facts AS f
         LEFT JOIN pricing_snapshots AS ps ON ps.pricing_version = (
             SELECT pricing_version FROM pricing_snapshots
             WHERE captured_at_ms <= f.event_ts_ms
             ORDER BY captured_at_ms DESC, pricing_version DESC LIMIT 1
         )
         WHERE f.session_key IN (SELECT value FROM json_each(?1)) AND f.observation_kind != 'legacy_aggregate'
           AND f.deleted_at_ms IS NULL AND f.event_ts_ms IS NOT NULL {time_filter}
         GROUP BY f.session_key, f.harness, f.provider_id, f.provider_raw, f.model_id, f.billing_template_id,
                  {billing_mode_expr}, f.pricing_basis, f.evidence_basis, f.event_peak,
                  ps.pricing_version, ps.payload_json
         ORDER BY f.provider_id, f.provider_raw, f.model_id, f.billing_template_id, event_peak, ps.pricing_version",
        billing_mode_expr = billing_mode_expr,
        time_filter = time_filter,
    );
    let mut stmt = conn.prepare_cached(&query)?;
    let mut query_params = vec![rusqlite::types::Value::Text(serde_json::to_string(session_keys).map_err(|_| rusqlite::Error::InvalidQuery)?)];
    if let Some((from, to)) = window {
        query_params.push(rusqlite::types::Value::Integer(from));
        query_params.push(rusqlite::types::Value::Integer(to));
    }
    let rows = stmt.query_map(rusqlite::params_from_iter(query_params.iter()), |r| {
        Ok((
            r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?,
            r.get::<_, Option<String>>(4)?, r.get::<_, String>(5)?,
            r.get::<_, String>(6)?, r.get::<_, String>(7)?, r.get::<_, i64>(8)?,
            r.get::<_, Option<String>>(9)?, r.get::<_, Option<String>>(10)?,
            r.get::<_, i64>(11)?, r.get::<_, i64>(12)?, r.get::<_, i64>(13)?,
            r.get::<_, i64>(14)?, r.get::<_, i64>(15)?, r.get::<_, String>(16)?,
        ))
    })?;
    // 每日同步叠加层：历史快照里当时没有的卡用它补（只补缺卡，已有价不动）。
    let sync_overlay: Option<Value> = crate::authority::latest_pricing_sync_overlay(conn)?
        .and_then(|raw| serde_json::from_str(&raw).ok());
    let mut buckets: std::collections::BTreeMap<String, Vec<Value>> = std::collections::BTreeMap::new();
    for row in rows {
        let (harness, provider_id, provider_raw, model_id, template_id, billing_mode, pricing_basis,
            evidence_basis, peak, pricing_version, pricing_payload, uncached, cache_read,
            cache_write, output, last_event_ms, key) = row?;
        let usage = billing_bucket_usage_json(
            &harness, &model_id, provider_id.as_deref(), peak != 0,
            [uncached, cache_read, cache_write, output],
        );
        let reference = if pricing_payload.is_none() && billing_mode != "subscription" {
            reference_snapshot.as_ref()
        } else { None };
        let selected_payload = pricing_payload.as_deref().or_else(|| reference.map(|r| r.1.as_str()));
        let (cost_minor, backfilled) = if billing_mode == "subscription" {
            (None, false)
        } else {
            price_with_sync_backfill(&harness, &usage, selected_payload, sync_overlay.as_ref())
        };
        let cost_minor = cost_minor.map(|cost| cost.to_json());
        // 补录的金额单独标出：它用的是事后才到的价卡，不是事件发生时就有的价格。
        let pricing_source = if cost_minor.is_none() {
            None
        } else if reference.is_some() {
            Some("current_card_reference")
        } else if backfilled {
            Some("backfilled")
        } else if evidence_basis == "explicit-official-route" {
            Some("official")
        } else {
            Some("fallback_official")
        };
        let unresolved_reason = if billing_mode == "subscription" {
            Some("subscription token usage is not a per-token bill".to_string())
        } else if selected_payload.is_none() {
            Some("no pricing snapshot covers this event time".to_string())
        } else if cost_minor.is_none() {
            Some("no compatible price card for this provider/model bucket".to_string())
        } else if reference.is_some() {
            Some("no historical pricing snapshot; latest local price card reference estimate, not a historical bill; route/provider evidence unchanged".to_string())
        } else if pricing_basis == "metered_estimate" || evidence_basis != "explicit-official-route" {
            Some("provider-specific price card unavailable; official-card fallback estimate required".to_string())
        } else {
            None
        };
        let total = uncached.checked_add(cache_read).and_then(|n| n.checked_add(cache_write))
            .and_then(|n| n.checked_add(output)).ok_or(rusqlite::Error::InvalidQuery)?;
        let mut bucket = json!({
            "provider_id": provider_id,
            "provider_raw": provider_raw,
            "model_id": model_id,
            "billing_template_id": template_id,
            "billing_mode": billing_mode,
            "pricing_basis": pricing_basis,
            "evidence_basis": evidence_basis,
            "pricing_version": pricing_version.or_else(|| reference.map(|r| r.0.clone())),
            "pricing_source": pricing_source,
            "cost_minor": cost_minor,
            "peak": peak != 0,
            "last_event_at_ms": last_event_ms,
            "tokens": {
                "uncached_input_tokens": uncached,
                "cache_read_tokens": cache_read,
                "cache_write_tokens": cache_write,
                "output_tokens": output,
                "total": total,
            },
            // Subscription usage is explicitly classified and therefore is not
            // an unresolved attribution. Keep the explanatory reason, but do
            // not let it masquerade as route/price uncertainty.
            "has_unresolved": billing_mode != "subscription" && unresolved_reason.is_some(),
            "unresolved_reason": unresolved_reason,
        });
        if let Some((_, _, captured_at_ms)) = reference.filter(|_| cost_minor.is_some()) {
            bucket["reference_captured_at_ms"] = json!(captured_at_ms);
        }
        buckets.entry(key).or_default().push(bucket);
    }
    Ok(buckets)
}

/// 会话成本的统一解释投影，供公开 MCP 会话 DTO 使用。
///
/// `cost_minor` 保留旧字段名以兼容现有客户端；`status` / `reason` 解决
/// `cost_minor = null` 的歧义；有金额时把历史价格版本、来源和证据状态附在
/// 同一个金额对象上。这样订阅 token、混合 provider、缺价卡都不会被 UI 当成
/// 免费或查询失败。
pub fn session_cost_view(
    conn: &Connection,
    session_key: &str,
) -> Result<Value, AuthorityError> {
    let buckets = session_billing_buckets(conn, session_key)?;
    Ok(session_cost_view_from_buckets(&buckets))
}

/// Cost status derived from already-loaded, window-scoped billing buckets.
/// This lets local projections price exactly the same facts as their token totals.
pub fn session_cost_view_from_buckets(buckets: &[Value]) -> Value {
    let token_total: i64 = buckets
        .iter()
        .filter_map(|bucket| bucket.get("tokens").and_then(|tokens| tokens.get("total")))
        .filter_map(Value::as_i64)
        .sum();
    let has_unresolved = buckets
        .iter()
        .filter(|bucket| bucket["billing_mode"] != "subscription")
        .any(|bucket| bucket["has_unresolved"].as_bool().unwrap_or(false));
    let all_subscription = !buckets.is_empty()
        && buckets
            .iter()
            .all(|bucket| bucket["billing_mode"] == "subscription");
    let non_subscription_providers: std::collections::BTreeSet<String> = buckets
        .iter()
        .filter(|bucket| bucket["billing_mode"] != "subscription")
        .map(|bucket| {
            bucket["provider_id"]
                .as_str()
                .or_else(|| bucket["provider_raw"].as_str())
                .unwrap_or("<unknown>")
                .to_string()
        })
        .collect();

    let mut cost_minor = session_cost_minor_from_buckets(buckets).map(|money| money.to_json());
    let pricing_versions: std::collections::BTreeSet<String> = buckets
        .iter()
        .filter_map(|bucket| bucket["pricing_version"].as_str())
        .map(str::to_string)
        .collect();
    let reference_prices: std::collections::BTreeSet<(String, i64)> = buckets.iter()
        .filter_map(|bucket| Some((bucket["pricing_version"].as_str()?.to_string(), bucket["reference_captured_at_ms"].as_i64()?)))
        .collect();
    if let Some(cost) = cost_minor.as_mut() {
        cost["pricing_versions"] = json!(pricing_versions.iter().collect::<Vec<_>>());
        cost["pricing_source"] = json!(if !reference_prices.is_empty() {
            "current_card_reference"
        } else if has_unresolved {
            "fallback_official"
        } else {
            "official"
        });
        cost["evidence_basis"] = json!(if !reference_prices.is_empty() && buckets.iter()
            .filter(|bucket| bucket["billing_mode"] != "subscription")
            .all(|bucket| bucket["evidence_basis"] == "explicit-official-route") {
            "explicit-official-route"
        } else if has_unresolved {
            "route-or-provider-unresolved"
        } else {
            "explicit-official-route"
        });
        cost["has_unresolved"] = json!(has_unresolved);
    }

    let (state, reason) = if buckets.is_empty() || token_total == 0 {
        ("unavailable", "no-usage-facts")
    } else if all_subscription {
        ("subscription", "subscription-token-usage-is-not-a-per-token-bill")
    } else if cost_minor.is_some() {
        ("estimated", if !reference_prices.is_empty() {
            "current-card-reference-estimate"
        } else if has_unresolved {
            "official-card-fallback-estimate"
        } else {
            "metered-estimate"
        })
    } else if non_subscription_providers.len() > 1 {
        ("unavailable", "multiple-provider-costs-require-breakdown")
    } else if buckets.iter().any(|bucket| {
        bucket["unresolved_reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("pricing snapshot"))
    }) {
        ("unavailable", "no-pricing-snapshot")
    } else if buckets.iter().any(|bucket| {
        bucket["unresolved_reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("price card"))
    }) {
        ("unpriced", "no-price-card")
    } else {
        ("unavailable", "cost-unavailable")
    };

    let status_has_unresolved = has_unresolved
        || state == "unpriced"
        || (state == "unavailable" && token_total > 0);
    let mut view = json!({
        "cost_minor": cost_minor,
        "status": state,
        "reason": reason,
        "has_unresolved": status_has_unresolved,
        "pricing_versions": pricing_versions.iter().collect::<Vec<_>>(),
    });
    if !reference_prices.is_empty() {
        view["reference_prices"] = json!(reference_prices.into_iter().map(|(pricing_version,captured_at_ms)|
            json!({"pricing_version":pricing_version,"captured_at_ms":captured_at_ms})).collect::<Vec<_>>());
    }
    view
}

// ─────── v0.9.1 最后一公里（PR #2）：sessions_search / session_detail envelope
// 加 `cost_minor` 字段──走 `usage_facts × pricing_snapshots` JOIN，按事件时间
// 选历史价卡（Q13），按模型 8 桶折成 `cost_report` 期望的 `by_model` 形状
// 再过 `agent_vitals_domain::cost::cost_report` 派生成本。
//
// **不在这里长第二份计价规则**：8 桶折算、peak/off-peak 拆分、未知模型归
// `unpriced_tokens`、baseline/fallback 标记——全是 `cost_report` 已经做对
// 的事；本函数只负责"从 SQL 拉数据喂给它"。`CostReport` 跑空 → `None`
// （与 `cost_report` 同语义，spec §0.1 不得伪造零成本）。

/// `session_cost_minor`：把一个会话的 8 桶 token 数 + 事件时间喂给
/// `cost_report` 用的中间聚合。**仅含实时行级事实**（与本模块其他查询同款：
/// `observation_kind != 'legacy_aggregate'`）——claude 深历史的 legacy_aggregate
/// 行不在这里加和，那是 `claude_day_cost` 的事（口径不同、价卡路径不同）。
///
/// `MAX(event_ts_ms)` 一并带出——用它去 `pricing_snapshot_asof` 选历史价卡
/// 版本（Q13：调价日前后分别用正确的价表）。
pub(crate) const SQL_SESSION_COST_BUCKETS: &str = "SELECT harness, provider_id, COALESCE(model_id, '<unknown>') AS model,
                event_peak,
                SUM(uncached_input_tokens), SUM(cache_read_tokens),
                SUM(cache_write_tokens), SUM(output_tokens),
                MAX(event_ts_ms)
         FROM usage_facts
         WHERE session_key = ?1
           AND observation_kind != 'legacy_aggregate'
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
         GROUP BY provider_id, model_id, event_peak";

/// 一个单 provider 会话的 cost_minor（按价表的 metered estimate）。
///
/// 路径：`usage_facts` 折成 8 桶 → 选 `pricing_snapshot.asof(MAX(event_ts_ms))`
/// → `cost_report(usage, snapshot)` → 把 `total: f64` 一次 pyround 转最小货币
/// 单位整数（与 `agent_vitals_runtime::money::from_f64` 同样的舍入规则——
/// 这里内联一份以避免 `agent-vitals-data` 反向依赖 `agent-vitals-runtime`，
/// 依赖方向还是 `runtime → data → domain`）。
///
/// 返回 `None` 的语义（spec §0.1 不冒充）：
/// - 该会话无 `usage_facts` 行（无事实即无成本，与 `cost_report` 同语义）
/// - 没有任何 `pricing_snapshot` 能覆盖到 `MAX(event_ts_ms)`
/// - 价格表里没有任何模型可计价（`cost_report` 自身返 None）
/// - `total` 不是有限非负数（NaN/Inf/负→不冒充）
///
/// `BillingBasis::MeteredEstimate`：与 `harness_bills` 的 `MeteredActual` 不同
/// 档位（spec §4 不冒充）。调用方拿到 basis 必须如实透出到 DTO，
/// 不与 `harness_bills` 加和进 `summable_total`。
pub fn session_cost_minor(
    conn: &Connection,
    session_key: &str,
) -> Result<Option<agent_vitals_domain::data_contract::MoneyMinor>, AuthorityError> {
    let buckets = match session_billing_buckets(conn, session_key) {
        Ok(buckets) => buckets,
        // A few read-only trace fixtures intentionally model the pre-v3 authority
        // shape. Keep the compatibility scalar available there; production opens
        // migrate before querying and therefore always takes the fact-snapshot path.
        Err(error) if error.to_string().contains("no such column") => return session_cost_minor_legacy(conn, session_key),
        Err(error) => return Err(error),
    };
    Ok(session_cost_minor_from_buckets(&buckets))
}

fn session_cost_minor_from_buckets(
    buckets: &[Value],
) -> Option<agent_vitals_domain::data_contract::MoneyMinor> {
    use std::collections::BTreeSet;

    let providers: BTreeSet<String> = buckets.iter()
        .filter(|bucket| bucket["billing_mode"] != "subscription")
        .map(|bucket| bucket["provider_id"].as_str()
            .or_else(|| bucket["provider_raw"].as_str())
            .unwrap_or("<unknown>").to_string())
        .collect();
    if providers.len() != 1 {
        return None;
    }
    let mut total: Option<agent_vitals_domain::data_contract::MoneyMinor> = None;
    for bucket in buckets {
        let Some(cost) = bucket.get("cost_minor")
            .and_then(agent_vitals_domain::data_contract::MoneyMinor::from_json) else { continue };
        match &mut total {
            None => total = Some(cost),
            Some(sum) if sum.currency == cost.currency && sum.basis == cost.basis => {
                sum.amount_minor = sum.amount_minor.checked_add(cost.amount_minor)?;
            }
            Some(_) => return None,
        }
    }
    total
}

#[allow(dead_code)]
fn session_cost_minor_legacy(
    conn: &Connection,
    session_key: &str,
) -> Result<Option<agent_vitals_domain::data_contract::MoneyMinor>, AuthorityError> {
    use std::collections::{BTreeMap, BTreeSet};

    // 1. 聚合 8 桶 + peak 拆分 + max ts。`(model, event_peak)` 两轴 group by，
    //    Rust 端再按 model 合并 peak / off_peak 拆分。
    let mut stmt = conn.prepare(SQL_SESSION_COST_BUCKETS)?;
    let rows = stmt.query_map(
        rusqlite::params![session_key],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
            ))
        },
    )?;
    // model → {off_peak 4 桶, peak 4 桶}
    #[derive(Default)]
    struct Split {
        u_off: i64, cr_off: i64, cw_off: i64, o_off: i64,
        u_peak: i64, cr_peak: i64, cw_peak: i64, o_peak: i64,
    }
    let mut by_model: BTreeMap<String, Split> = BTreeMap::new();
    let mut codex_unknown: BTreeMap<String, Split> = BTreeMap::new();
    let mut providers: BTreeSet<String> = BTreeSet::new();
    let mut harness: Option<String> = None;
    let mut max_ts: i64 = 0;
    for row in rows {
        let (row_harness, provider, model, peak, u, cr, cw, o, ts) = row?;
        harness = Some(row_harness.clone());
        providers.insert(provider.as_deref().unwrap_or("<unknown>").to_string());
        let model_key = model.clone();
        let entry = by_model.entry(model).or_default();
        if peak != 0 {
            entry.u_peak += u;
            entry.cr_peak += cr;
            entry.cw_peak += cw;
            entry.o_peak += o;
        } else {
            entry.u_off += u;
            entry.cr_off += cr;
            entry.cw_off += cw;
            entry.o_off += o;
        }
        if ts > max_ts {
            max_ts = ts;
        }
        if row_harness == "codex" && provider.as_deref() != Some("openai") {
            let entry = codex_unknown.entry(model_key).or_default();
            if peak != 0 {
                entry.u_peak += u;
                entry.cr_peak += cr;
                entry.cw_peak += cw;
                entry.o_peak += o;
            } else {
                entry.u_off += u;
                entry.cr_off += cr;
                entry.cw_off += cw;
                entry.o_off += o;
            }
        }
    }
    if by_model.is_empty() || max_ts == 0 {
        return Ok(None);
    }
    // 旧 `MoneyMinor` 只承载一个币种/计费依据。跨 provider 会话必须由 v0.12
    // 的 provider 分桶 DTO 表达；在它接线前宁可 unavailable，也绝不把同名
    // 模型按某一方价卡相加后伪装成单一成本。
    if providers.len() != 1 {
        return Ok(None);
    }

    // 2. 选历史价卡：调价日前后用正确版本（Q13）。
    let snap_payload: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM pricing_snapshots
             WHERE captured_at_ms <= ?1
             ORDER BY captured_at_ms DESC, pricing_version DESC LIMIT 1",
            rusqlite::params![max_ts],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    let Some(snap_payload) = snap_payload else {
        return Ok(None);
    };
    let snap_pricing: serde_json::Value = match serde_json::from_str(&snap_payload) {
        Ok(v) => v,
        Err(_) => return Ok(None), // 脏价卡不致命：会话本身有数据，cost 字段为 None
    };

    // Codex unknown/custom routes use the official USD card from the same
    // immutable snapshot. Explicit OpenAI subscription facts are excluded.
    if harness.as_deref() == Some("codex") && !codex_unknown.is_empty() {
        let mut codex_models = serde_json::Map::new();
        for (model, s) in &codex_unknown {
            codex_models.insert(
                model.clone(),
                json!({
                    "uncached_input_tokens": s.u_off + s.u_peak,
                    "cached_input_tokens": s.cr_off + s.cr_peak,
                    "cache_write_input_tokens": s.cw_off + s.cw_peak,
                    "output_tokens": s.o_off + s.o_peak,
                    "reasoning_output_tokens": 0,
                }),
            );
        }
        if let Some(cost) = agent_vitals_domain::cost::metered_estimate_minor(
            "codex",
            &json!({ "by_model": codex_models }),
            &snap_pricing,
        ) {
            return Ok(Some(cost));
        }
    }

    // 3. 按执行环境折成统一成本引擎需要的 by_model 形状。DSH 使用四个
    //    uncached/cache_read/cache_write/output 字段；Claude 使用其原生的
    //    input/cache_read_input/cache_creation_input/output 字段。
    let mut by_model_json = serde_json::Map::new();
    for (model, s) in &by_model {
        let value = if harness.as_deref() == Some("claude-code") {
            json!({
                "input_tokens": s.u_off + s.u_peak,
                "cache_read_input_tokens": s.cr_off + s.cr_peak,
                "cache_creation_input_tokens": s.cw_off + s.cw_peak,
                "output_tokens": s.o_off + s.o_peak,
                "peak_input_tokens": s.u_peak,
                "peak_cache_read_input_tokens": s.cr_peak,
                "peak_cache_creation_input_tokens": s.cw_peak,
                "peak_output_tokens": s.o_peak,
            })
        } else {
            json!({
                "uncached_input_tokens": s.u_off + s.u_peak,
                "cache_read_tokens": s.cr_off + s.cr_peak,
                "cache_write_tokens": s.cw_off + s.cw_peak,
                "output_tokens": s.o_off + s.o_peak,
                "peak_uncached_input_tokens": s.u_peak,
                "peak_cache_read_tokens": s.cr_peak,
                "peak_cache_write_tokens": s.cw_peak,
                "peak_output_tokens": s.o_peak,
            })
        };
        by_model_json.insert(model.clone(), value);
    }
    let usage = json!({ "by_model": by_model_json });

    // 4. 统一成本引擎：data 层只负责 SQL 聚合，不重复金额转换规则。
    Ok(agent_vitals_domain::cost::metered_estimate_minor(
        harness.as_deref().unwrap_or("dsh"),
        &usage,
        &snap_pricing,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::AuthorityDb;
    use jiff::Timestamp;
    use std::path::PathBuf;

    /// `concat!` 只收字面量，所以组 SQL 里的 WHERE 与运行时计价用的
    /// `SQL_UNRESOLVED_BILLING_FACT_WHERE` 是两份字面量——这里钉住它们逐字相等，
    /// 否则「组 token」和「组金额」会来自两批不同的事实。
    #[test]
    fn unresolved_billing_group_sql_embeds_the_shared_fact_predicate() {
        assert!(SQL_UNRESOLVED_BILLING_GROUPS.contains(SQL_UNRESOLVED_BILLING_FACT_WHERE));
    }

    fn ms_to_statistics_date(ms: i64) -> String {
        let date = Timestamp::from_millisecond(ms)
            .unwrap()
            .to_zoned(statistics_timezone())
            .date();
        format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
    }

    fn tmp_db(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "avd-query-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// 与 fact_writer_sql 的测试助手同构：直接 INSERT 一行 usage_facts，
    /// 不经过完整的 UsageFact 校验管线（本模块只测查询/reshape，不是
    /// writer 的校验规则）。
    #[allow(clippy::too_many_arguments)]
    fn insert_fact(
        db: &AuthorityDb,
        fact_id: &str,
        harness: &str,
        model_id: Option<&str>,
        observation_kind: &str,
        event_ts_ms: i64,
        event_peak: i64,
        u: i64,
        cr: i64,
        cw: i64,
        o: i64,
    ) {
        db.conn()
            .execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('run', 1, 'cli', 'succeeded', 1) ON CONFLICT(run_id) DO NOTHING",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                     event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                     output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'm', 'sess', ?1, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'run', 1, 1)",
                rusqlite::params![
                    fact_id, harness, observation_kind, model_id, event_ts_ms, event_peak, u, cr, cw, o
                ],
            )
            .unwrap();
    }

    #[test]
    fn beijing_day_bounds_match_month_boundary_at_utc_16() {
        // 北京 2026-09-01 00:00 = UTC 2026-08-31 16:00——与旧 `dsh_days_map`
        // 的字符串判断（"UTC 小时 >=16 → 次日"）钉的是同一条边界。
        let (start, end) = beijing_day_bounds_ms("2026-09-01").unwrap();
        assert_eq!(end - start, DAY_MS);
        // 边界前一毫秒仍是 08-31 的 UTC 时刻。
        let just_before = start - 1;
        assert_eq!(ms_to_statistics_date(just_before), "2026-08-31");
        assert_eq!(ms_to_statistics_date(start), "2026-09-01");
    }

    #[test]
    fn month_bounds_span_exactly_the_civil_month() {
        let (start, end) = beijing_month_bounds_ms("2026-09").unwrap();
        assert_eq!(ms_to_statistics_date(start), "2026-09-01");
        assert_eq!(ms_to_statistics_date(end - 1), "2026-09-30");
        assert_eq!(ms_to_statistics_date(end), "2026-10-01");
    }

    #[test]
    fn invalid_month_or_day_is_none_not_a_guess() {
        assert_eq!(beijing_month_bounds_ms("2026-13"), None);
        assert_eq!(beijing_month_bounds_ms("2026-9"), None);
        assert_eq!(beijing_day_bounds_ms("2026-02-30"), None);
    }

    #[test]
    fn named_timezone_midnight_uses_dst_aware_boundaries() {
        let zone = TimeZone::get("America/Los_Angeles").unwrap();
        let before = midnight_ms_in_timezone(2026, 3, 8, zone.clone()).unwrap();
        let after = midnight_ms_in_timezone(2026, 3, 9, zone).unwrap();
        // The civil dates are consecutive, but the spring-forward day is 23h.
        assert_eq!(after - before, 23 * 3_600_000);
    }

    #[test]
    fn peaked_days_map_splits_peak_and_attributes_by_model() {
        let path = tmp_db("dsh");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (start, end) = beijing_day_bounds_ms("2026-09-05").unwrap();
        // event_peak 直接注入（本模块只测查询/reshape，不重算
        // `is_peak_slot`——那是 emitter 的职责）：两条 peak=0、一条 peak=1。
        insert_fact(
            &db,
            "f1",
            "dsh",
            Some("deepseek-v4-pro"),
            "turn",
            start + 3_600_000,
            0,
            100,
            10,
            5,
            20,
        );
        insert_fact(
            &db,
            "f2",
            "dsh",
            Some("deepseek-v4-pro"),
            "turn",
            start + 4_000_000,
            1,
            50,
            0,
            0,
            10,
        );
        insert_fact(
            &db,
            "f3",
            "dsh",
            None,
            "turn",
            start + 5_000_000,
            0,
            7,
            0,
            0,
            1,
        ); // 无模型归属
        let days = peaked_days_map(db.conn(), "dsh", start, end).unwrap();
        let day = &days["2026-09-05"];
        // 顶层总量 = 全部三条之和（含无归属行）。
        assert_eq!(day["uncached_input_tokens"], json!(157));
        assert_eq!(day["peak_uncached_input_tokens"], json!(50));
        // by_model 只含有归属的两条，且总/峰值分桶正确。
        let model = &day["by_model"]["deepseek-v4-pro"];
        assert_eq!(model["uncached_input_tokens"], json!(150));
        assert_eq!(model["peak_uncached_input_tokens"], json!(50));
        assert!(days["2026-09-05"]["by_model"].get("unknown").is_none());

        // 窗口外的事实不应该出现。
        insert_fact(
            &db,
            "f4",
            "dsh",
            Some("x"),
            "turn",
            end + 1,
            0,
            999,
            0,
            0,
            0,
        );
        let days2 = peaked_days_map(db.conn(), "dsh", start, end).unwrap();
        assert_eq!(days2["2026-09-05"]["uncached_input_tokens"], json!(157));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn peaked_days_map_excludes_legacy_aggregate_rows() {
        // 行轴/聚合轴分离纪律：legacy_aggregate 行绝不能被实时聚合查询计入，
        // 否则同一天的账会被算两遍（spec §4）。
        let path = tmp_db("dsh-legacy");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (start, end) = beijing_day_bounds_ms("2026-09-05").unwrap();
        insert_fact(
            &db,
            "f1",
            "dsh",
            Some("m"),
            "turn",
            start + 1000,
            0,
            10,
            0,
            0,
            0,
        );
        insert_fact(
            &db,
            "f2",
            "dsh",
            Some("m"),
            "legacy_aggregate",
            start + 1000,
            0,
            999,
            0,
            0,
            0,
        );
        let days = peaked_days_map(db.conn(), "dsh", start, end).unwrap();
        assert_eq!(days["2026-09-05"]["uncached_input_tokens"], json!(10));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn claude_days_sums_across_peak_states_without_a_peak_axis() {
        let path = tmp_db("claude");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (start, end) = beijing_day_bounds_ms("2026-09-05").unwrap();
        // 一条 peak=0、一条 peak=1——claude 计价不分峰谷，两条都要计入同一
        // 模型总量（与 DSH 的 `peaked_days_map` 行为对照，防止误把 claude
        // 的 event_peak 当"只算 0"处理——那是 legacy_aggregate 专属编码）。
        insert_fact(
            &db,
            "f1",
            "claude-code",
            Some("claude-opus-4"),
            "message",
            start + 1000,
            0,
            100,
            20,
            5,
            30,
        );
        insert_fact(
            &db,
            "f2",
            "claude-code",
            Some("claude-opus-4"),
            "message",
            start + 2000,
            1,
            50,
            0,
            0,
            10,
        );
        let days = claude_days(db.conn(), start, end).unwrap();
        let bucket = &days["2026-09-05"]["claude-opus-4"];
        assert_eq!(bucket["input_tokens"], json!(150));
        assert_eq!(bucket["output_tokens"], json!(40));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn claude_legacy_days_reads_only_the_base_peak_zero_row() {
        // `event_peak=1` 行是 base 行的峰值子集重复编码（legacy_import 的
        // 两行设计）——读它会把峰值部分的 token 算两遍。
        let path = tmp_db("claude-legacy");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (start, end) = beijing_day_bounds_ms("2026-01-05").unwrap();
        insert_fact(
            &db,
            "f1",
            "claude-code",
            Some("claude-opus-4"),
            "legacy_aggregate",
            start,
            0,
            1000,
            100,
            50,
            200,
        );
        insert_fact(
            &db,
            "f2",
            "claude-code",
            Some("claude-opus-4"),
            "legacy_aggregate",
            start,
            1,
            300,
            0,
            0,
            60,
        );
        let days = claude_legacy_days(db.conn(), start, end).unwrap();
        let bucket = &days["2026-01-05"]["claude-opus-4"];
        assert_eq!(
            bucket["input_tokens"],
            json!(1000),
            "只读 base 行，不叠加峰值子集"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_by_hour_model_buckets_speed_as_standard() {
        let path = tmp_db("codex");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (start, _) = beijing_day_bounds_ms("2026-09-05").unwrap();
        insert_fact(
            &db,
            "f1",
            "codex",
            Some("gpt-5.6-sol"),
            "token_count",
            start + 3_600_000,
            0,
            800,
            200,
            50,
            80,
        );
        let by_hour = codex_by_hour_model(db.conn(), start, start + DAY_MS).unwrap();
        // 北京 01:00 的小时键。
        let bucket = &by_hour["2026-09-05T01"]["gpt-5.6-sol"]["standard"];
        assert_eq!(bucket["uncached_input_tokens"], json!(800));
        assert_eq!(bucket["cached_input_tokens"], json!(200));
        assert_eq!(bucket["reasoning_output_tokens"], json!(0));
        let _ = std::fs::remove_file(&path);
    }

    /// 2026-09-16 真机：codex openai 订阅声明覆盖了 26,715 条事实，`codex/openai` 却仍报
    /// $376 按量估算——`codex_by_hour_provider_model` 是唯一漏抄「未被订阅覆盖」谓词的
    /// 金额侧查询。现在谓词单一来源（`not_subscription_covered!`），这里钉住 provider 轴。
    #[test]
    fn codex_by_hour_provider_model_excludes_subscription_covered_facts() {
        let path = tmp_db("codex-provider-covered");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (start, _) = beijing_day_bounds_ms("2026-09-05").unwrap();
        insert_fact(&db, "f-covered", "codex", Some("gpt-5.6-sol"), "token_count", start + 3_600_000, 0, 800, 0, 0, 0);
        insert_fact(&db, "f-open", "codex", Some("gpt-5.6-sol"), "token_count", start + 7_200_000, 0, 300, 0, 0, 0);
        // f-open 走中转（provider 未知，NULL）——真机形状；f-covered 是官方 openai。
        db.conn().execute("UPDATE usage_facts SET provider_id = 'openai' WHERE fact_id = 'f-covered'", []).unwrap();
        db.billing_declaration_revision_save(
            "rev-cx", "decl-cx", None,"openai", "official_subscription", Some("Plus"),
            Some(2_000), Some("USD"), "2026-09-01", None, None, None, &[], 2,
        ).unwrap();
        db.billing_recalculation_enqueue("job-cx", "decl-cx", "rev-cx", 3).unwrap();
        // 只把 f-covered 标成订阅覆盖：直接写归因行，模拟作用域只命中一条。
        db.conn().execute(
            "UPDATE billing_recalculation_jobs SET status = 'succeeded' WHERE job_id = 'job-cx'", [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO billing_fact_attributions(fact_id, revision_id, job_id, attribution_kind, created_at_ms)
             VALUES ('f-covered', 'rev-cx', 'job-cx', 'subscription_covered', 4)", [],
        ).unwrap();
        let grouped = codex_by_hour_provider_model(db.conn(), start, start + DAY_MS).unwrap();
        assert!(!grouped.contains_key(&("openai".to_string(), false)),
            "订阅覆盖的小时桶不得进入金额面：{grouped:?}");
        assert_eq!(grouped[&("<unknown>".to_string(), false)]["2026-09-05T02"]["gpt-5.6-sol"]["standard"]["uncached_input_tokens"], json!(300));
        // 撤销声明 → 覆盖失效 → 事实回到按量估算。
        db.billing_declaration_revision_revoke("rev-cx-revoke", "decl-cx", "rev-cx", 5).unwrap();
        let grouped = codex_by_hour_provider_model(db.conn(), start, start + DAY_MS).unwrap();
        assert_eq!(grouped[&("openai".to_string(), false)]["2026-09-05T01"]["gpt-5.6-sol"]["standard"]["uncached_input_tokens"], json!(800));
        // 用户把 f-open 归因到中转（user_declared）→ 它离开 openai 默认组、进入
        // (shengsuanyun, declared=true) 组；金额面据此改计 MeteredDeclared。
        db.billing_declaration_revision_save(
            "rev-relay", "decl-relay", None,"shengsuanyun", "third_party", None, None, None,
            "2026-09-01", None, None, None, &[("provider", "unresolved"), ("model", "gpt-5.6-sol")], 6,
        ).unwrap();
        db.billing_recalculation_enqueue("job-relay", "decl-relay", "rev-relay", 7).unwrap();
        assert!(db.billing_recalculation_run("job-relay", 8).unwrap());
        let grouped = codex_by_hour_provider_model(db.conn(), start, start + DAY_MS).unwrap();
        let relay = &grouped[&("shengsuanyun".to_string(), true)];
        assert_eq!(relay["2026-09-05T02"]["gpt-5.6-sol"]["standard"]["uncached_input_tokens"], json!(300));
        assert!(!grouped.contains_key(&("<unknown>".to_string(), false)),
            "归因走的事实不得同时留在默认组（双计）");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn untimed_facts_are_excluded_from_all_windowed_queries() {
        // event_ts_ms IS NULL 的事实不进任何时间轴——与旧 fold 的
        // untimed 纪律一致，不是新缺口。
        let path = tmp_db("untimed");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.conn()
            .execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('run', 1, 'cli', 'succeeded', 1)",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     source_event_id, observation_kind, model_id, event_ts_ms, event_peak,
                     uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES ('u1', 'codex', 'm', 's', 'u1', 'token_count', 'gpt-5.6', NULL, 0,
                         500, 0, 0, 0, 'run', 1, 1)",
                [],
            )
            .unwrap();
        let (start, end) = beijing_month_bounds_ms("2026-09").unwrap();
        let by_hour = codex_by_hour_model(db.conn(), start, end).unwrap();
        assert!(by_hour.as_object().unwrap().is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn hourly_by_harness_buckets_all_harnesses_into_beijing_hours() {
        let path = tmp_db("hourly");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (start, end) = beijing_day_bounds_ms("2026-09-05").unwrap();
        // 三执行环境各自一条：北京 01:00（UTC 17:00 前一日——用 day_start 直接
        // 加小时即北京语义）、北京 08:00、北京 23:00。legacy 行必须排除。
        insert_fact(
            &db,
            "h1",
            "claude-code",
            Some("m"),
            "turn",
            start + 3_600_000,
            0,
            10,
            0,
            0,
            5,
        );
        insert_fact(
            &db,
            "h2",
            "codex",
            Some("m"),
            "token_count",
            start + 8 * 3_600_000,
            0,
            20,
            0,
            0,
            2,
        );
        insert_fact(
            &db,
            "h3",
            "dsh",
            Some("m"),
            "turn",
            start + 23 * 3_600_000,
            0,
            30,
            0,
            0,
            3,
        );
        insert_fact(
            &db,
            "h4",
            "dsh",
            Some("m"),
            "legacy_aggregate",
            start + 3_600_000,
            0,
            999,
            0,
            0,
            0,
        );
        let out = hourly_by_harness(db.conn(), start, end).unwrap();
        assert_eq!(out["claude-code"]["01"], 15, "四桶之和");
        assert_eq!(out["codex"]["08"], 22);
        assert_eq!(out["dsh"]["23"], 33);
        assert!(!out["dsh"].contains_key("01"), "legacy 行不进小时轴");
        // 零填充键形态（"01" 非 "1"）。
        assert!(out["claude-code"].contains_key("01") && !out["claude-code"].contains_key("1"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn token_totals_by_harness_keeps_zero_rows_and_excludes_legacy_aggregates() {
        let path = tmp_db("token-totals");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (start, end) = beijing_day_bounds_ms("2026-09-05").unwrap();
        insert_fact(
            &db,
            "live",
            "dsh",
            Some("m"),
            "turn",
            start + 1,
            0,
            10,
            20,
            0,
            3,
        );
        insert_fact(
            &db,
            "zero",
            "codex",
            Some("m"),
            "turn",
            start + 2,
            0,
            0,
            0,
            0,
            0,
        );
        insert_fact(
            &db,
            "legacy",
            "claude-code",
            Some("m"),
            "legacy_aggregate",
            start + 3,
            0,
            999,
            0,
            0,
            0,
        );
        let totals = token_totals_by_harness(db.conn(), start, end).unwrap();
        assert_eq!(totals.get("dsh"), Some(&33));
        assert_eq!(totals.get("codex"), Some(&0), "真零必须保留为一行");
        assert!(
            !totals.contains_key("claude-code"),
            "深历史聚合不是当日实时 token"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn facts_page_window_is_stable_and_cursor_paginates_without_drift() {
        let path = tmp_db("facts-page");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (start, end) = beijing_day_bounds_ms("2026-09-05").unwrap();
        // 同一毫秒两条事实（键集分页的并列场景）+ 一条 legacy（必须排除）。
        insert_fact(
            &db,
            "b",
            "dsh",
            Some("m"),
            "turn",
            start + 1_000,
            0,
            1,
            0,
            0,
            1,
        );
        insert_fact(
            &db,
            "a",
            "dsh",
            Some("m"),
            "turn",
            start + 1_000,
            0,
            2,
            0,
            0,
            2,
        );
        insert_fact(
            &db,
            "c",
            "dsh",
            Some("m"),
            "turn",
            start + 2_000,
            0,
            3,
            0,
            0,
            3,
        );
        insert_fact(
            &db,
            "lg",
            "dsh",
            Some("m"),
            "legacy_aggregate",
            start + 1_500,
            0,
            999,
            0,
            0,
            0,
        );
        // 首页 limit=2：按 (ts, fact_id) 升序 → a, b；has_more。
        let (p1, more1) = facts_page_window(db.conn(), "dsh", start, end, None, None, 2).unwrap();
        assert!(more1);
        let ids1: Vec<&str> = p1.iter().map(|r| r.fact_id.as_str()).collect();
        assert_eq!(ids1, vec!["a", "b"], "同毫秒按 fact_id 决胜；legacy 排除");
        // 用首页尾行做 cursor → c；无更多。
        let last = p1.last().unwrap();
        let (p2, more2) = facts_page_window(
            db.conn(),
            "dsh",
            start,
            end,
            Some(last.event_ts_ms),
            Some(&last.fact_id),
            2,
        )
        .unwrap();
        assert!(!more2);
        let ids2: Vec<&str> = p2.iter().map(|r| r.fact_id.as_str()).collect();
        assert_eq!(ids2, vec!["c"], "cursor 后无漂移无重复");
        // 窗口外事实不可见（开区间上界）。
        insert_fact(&db, "d", "dsh", Some("m"), "turn", end, 0, 4, 0, 0, 4);
        let (p3, _) = facts_page_window(db.conn(), "dsh", start, end, None, None, 10).unwrap();
        assert_eq!(p3.len(), 3, "event_ts_ms == end 落在窗外");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn coverage_status_empty_window_is_zero_not_full() {
        // 「从没观测到」是三维全空——不是三维全满（接线了 ≠ 观测到）。
        let path = tmp_db("cov0");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (start, end) = beijing_month_bounds_ms("2020-01").unwrap();
        assert_eq!(
            coverage_status(db.conn(), "dsh", start, end).unwrap(),
            (0, 3)
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn coverage_status_usage_sync_dimensions_and_unpriced_model() {
        let path = tmp_db("cov3");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (start, end) = beijing_month_bounds_ms("2026-09").unwrap();
        // 已知模型（deepseek 官方卡）→ usage+price 双维命中；token 全零的
        // 模型不参与 price 维（无消耗无价可评）。
        insert_fact(
            &db,
            "f1",
            "dsh",
            Some("deepseek-v4-flash"),
            "turn",
            start + 1_000,
            0,
            100,
            0,
            0,
            10,
        );
        insert_fact(
            &db,
            "f2",
            "dsh",
            Some("zero-model"),
            "turn",
            start + 2_000,
            0,
            0,
            0,
            0,
            0,
        );
        // sync 维：source_files.last_seen_at_ms ≥ 窗口内最后事件。
        db.conn()
            .execute(
                "INSERT INTO source_files(source_id, harness, path_hash, size_bytes, mtime_ns,
                     parser_version, first_seen_at_ms, last_seen_at_ms)
                 VALUES ('src1', 'dsh', 'h1', 1, 1, 1, 1, ?1)",
                rusqlite::params![start + 2_000],
            )
            .unwrap();
        let (m, t) = coverage_status(db.conn(), "dsh", start, end).unwrap();
        assert_eq!((m, t), (3, 3), "usage+price+sync 三维全命中");
        // sync 维缺口：last_seen 落后于窗口内最后事件（此时 max_event 仍是
        // f2 的 start+2000）→ 降 1。
        db.conn()
            .execute(
                "UPDATE source_files SET last_seen_at_ms = ?1 WHERE source_id='src1'",
                rusqlite::params![start],
            )
            .unwrap();
        let (m2, _) = coverage_status(db.conn(), "dsh", start, end).unwrap();
        assert_eq!(m2, 2, "usage+price 命中但 sync 落后 → 2/3");
        // price 维缺口：出现声明表认不出的**有量**模型（顺带推进了 max_event
        // ——此时 sync 维本来就落空，price 缺口让 2 → 1）。
        insert_fact(
            &db,
            "f3",
            "dsh",
            Some("moonshot-kimi-x"),
            "turn",
            start + 3_000,
            0,
            50,
            0,
            0,
            5,
        );
        let (m3, _) = coverage_status(db.conn(), "dsh", start, end).unwrap();
        assert_eq!(m3, 1, "无路由模型让 price 维也落空");
        let _ = std::fs::remove_file(&path);
    }

    /// 通用计费窗口收敛的 parity 钉子：下方三段 SQL 是**冻结的历史原文**
    /// （收敛前 `SQL_CLAUDE_DAYS` / `SQL_CLAUDE_LEGACY_DAYS` /
    /// `SQL_CODEX_BY_HOUR_MODEL` 的逐字节拷贝）。富 fixture（实时/legacy/
    /// 峰行 legacy/订阅覆盖/已删除/无模型/窗外）上，新路径（通用
    /// `billing_window_tokens` + 折叠）与冻结原文的输出必须**逐字节相等**
    /// ——任何人改坏构建器的 WHERE/GROUP BY 语义，这里立刻红。
    #[test]
    fn billing_window_unification_is_byte_identical_to_frozen_sql() {
        let path = tmp_db("billing-parity");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (s, e) = beijing_day_bounds_ms("2026-09-05").unwrap();
        let mid = s + 3_600_000;

        // 实时（两行同 (日,模型) → SUM 合并；一行无模型 → 折叠略过）
        insert_fact(&db, "r1", "claude-code", Some("m1"), "turn", s + 1_000, 0, 10, 20, 5, 3);
        insert_fact(&db, "r2", "claude-code", Some("m1"), "turn", s + 2_000, 0, 1, 2, 0, 0);
        insert_fact(&db, "r3", "claude-code", None, "turn", s + 2_500, 0, 7, 0, 0, 0);
        // legacy 全量行（进 legacy 视图）+ legacy 峰行（两边都不进）
        insert_fact(&db, "l1", "claude-code", Some("m2"), "legacy_aggregate", s + 3_000, 0, 100, 0, 0, 40);
        insert_fact(&db, "l2", "claude-code", Some("m2"), "legacy_aggregate", s + 3_100, 1, 999, 999, 999, 999);
        // 已删除（两边都不进）
        insert_fact(&db, "d1", "claude-code", Some("m1"), "turn", s + 4_000, 0, 50, 0, 0, 0);
        db.conn()
            .execute("UPDATE usage_facts SET deleted_at_ms = 1 WHERE fact_id = 'd1'", [])
            .unwrap();
        // 窗外
        insert_fact(&db, "w1", "claude-code", Some("m1"), "turn", e + 1_000, 0, 9, 9, 9, 9);
        // codex 同款实时/legacy 各一
        insert_fact(&db, "c1", "codex", Some("gpt-x"), "turn", mid, 0, 4, 5, 6, 7);
        insert_fact(&db, "c2", "codex", Some("gpt-x"), "legacy_aggregate", mid, 0, 1, 1, 1, 1);

        // 订阅覆盖一条 claude 实时事实（r2 之外再插一条并被 saved 声明覆盖）
        insert_fact(&db, "sc1", "claude-code", Some("m1"), "turn", s + 5_000, 0, 500, 0, 0, 0);
        db.billing_declaration_revision_save(
            "rev-par", "decl-par", None,"anthropic", "official_subscription",
            Some("Max"), None, None, "2026-09-01", None, None, None, &[], 2,
        ).unwrap();
        db.billing_recalculation_enqueue("job-par", "decl-par", "rev-par", 3).unwrap();
        db.conn().execute(
            "UPDATE billing_recalculation_jobs SET status = 'succeeded' WHERE job_id = 'job-par'", [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO billing_fact_attributions(fact_id, revision_id, job_id, attribution_kind, created_at_ms)
             VALUES ('sc1', 'rev-par', 'job-par', 'subscription_covered', 4)", [],
        ).unwrap();
        // 验收补边（b161c4c 复核）：被 saved 声明覆盖的 **legacy** 事实——
        // 生产可达（声明事实选择不过滤 observation_kind），且它是
        // 「LegacyAggregate 分支必须**不带**订阅谓词」这一语义的钉子：
        // 谁给 legacy 分支误加 not_subscription_covered，本事实会从新路径
        // 消失而冻结原文保留——parity 立刻红。
        insert_fact(&db, "scl1", "claude-code", Some("m3"), "legacy_aggregate", s + 6_000, 0, 77, 1, 2, 3);
        db.conn().execute(
            "INSERT INTO billing_fact_attributions(fact_id, revision_id, job_id, attribution_kind, created_at_ms)
             VALUES ('scl1', 'rev-par', 'job-par', 'subscription_covered', 5)", [],
        ).unwrap();

        // ── 冻结原文（收敛前的逐字节拷贝；只许随本测试退役，不许改）──
        const FROZEN_CLAUDE_DAYS: &str = concat!("SELECT (", local_day_idx!(), " + (?1 - ?1) + (?2 - ?2)) AS day_idx,
                model_id,
                SUM(uncached_input_tokens), SUM(cache_read_tokens),
                SUM(cache_write_tokens), SUM(output_tokens)
         FROM usage_facts
         WHERE harness = 'claude-code' AND observation_kind != 'legacy_aggregate'
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?3 AND event_ts_ms < ?4
           ", not_subscription_covered!(), "
         GROUP BY day_idx, model_id");
        const FROZEN_CLAUDE_LEGACY_DAYS: &str = concat!("SELECT (", local_day_idx!(), " + (?1 - ?1) + (?2 - ?2)) AS day_idx,
                model_id,
                SUM(uncached_input_tokens), SUM(cache_read_tokens),
                SUM(cache_write_tokens), SUM(output_tokens)
         FROM usage_facts
         WHERE harness = 'claude-code' AND observation_kind = 'legacy_aggregate'
           AND event_peak = 0 AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?3 AND event_ts_ms < ?4
         GROUP BY day_idx, model_id");
        const FROZEN_CODEX_BY_HOUR_MODEL: &str = concat!("SELECT (", local_hour_idx!(), " + (?1 - ?1) + (?2 - ?2)) AS hour_idx,
                model_id,
                SUM(uncached_input_tokens), SUM(cache_read_tokens),
                SUM(cache_write_tokens), SUM(output_tokens)
         FROM usage_facts
         WHERE harness = 'codex' AND observation_kind != 'legacy_aggregate'
           AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND event_ts_ms >= ?3 AND event_ts_ms < ?4
           ", not_subscription_covered!(), "
         GROUP BY hour_idx, model_id");

        let fold_sql = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> serde_json::Value {
            let mut stmt = db.conn().prepare(sql).unwrap();
            let rows = stmt.query_map(params, |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            }).unwrap();
            let mut out: BTreeMap<String, serde_json::Map<String, Value>> = BTreeMap::new();
            for row in rows {
                let (idx, model, u, cr, cw, o) = row.unwrap();
                let Some(model) = model else { continue };
                out.entry(format!("{idx}")).or_default().insert(
                    model,
                    json!({"input_tokens": u, "cache_read_input_tokens": cr,
                           "cache_creation_input_tokens": cw, "output_tokens": o}),
                );
            }
            serde_json::to_value(&out).unwrap()
        };

        let day_p: [&dyn rusqlite::ToSql; 4] = [&BEIJING_OFFSET_MS, &DAY_MS, &s, &e];
        let hour_p: [&dyn rusqlite::ToSql; 4] = [&BEIJING_OFFSET_MS, &HOUR_MS, &s, &e];

        // 行级对拍（聚合行本身）+ 折叠后对拍（公共函数输出 vs 冻结 SQL 手折）
        let new_days = claude_days(db.conn(), s, e).unwrap();
        let frozen_days = fold_sql(FROZEN_CLAUDE_DAYS, &day_p);
        // 冻结版按 idx 键；新版按 civil 日期键——把冻结版也换算成日期键对拍。
        let frozen_days_dated: serde_json::Map<String, Value> = frozen_days
            .as_object().unwrap().iter()
            .map(|(idx, v)| {
                let days = idx.parse::<i64>().unwrap();
                (civil_date_from_days(days), v.clone())
            })
            .collect();
        assert_eq!(
            serde_json::to_value(&new_days).unwrap(),
            serde_json::Value::Object(frozen_days_dated),
            "claude_days 新旧必须逐字节一致"
        );

        let new_legacy = claude_legacy_days(db.conn(), s, e).unwrap();
        let frozen_legacy = fold_sql(FROZEN_CLAUDE_LEGACY_DAYS, &day_p);
        let frozen_legacy_dated: serde_json::Map<String, Value> = frozen_legacy
            .as_object().unwrap().iter()
            .map(|(idx, v)| {
                let days = idx.parse::<i64>().unwrap();
                (civil_date_from_days(days), v.clone())
            })
            .collect();
        assert_eq!(
            serde_json::to_value(&new_legacy).unwrap(),
            serde_json::Value::Object(frozen_legacy_dated),
            "claude_legacy_days 新旧必须逐字节一致"
        );

        // codex：新旧各自按 hour_idx 折成 (idx, model, 四桶) 集合对拍（折叠
        // 形状是执行环境 wire 面，聚合语义对拍在行级）。
        let new_rows = billing_window_tokens(db.conn(), &BillingWindowQuery {
            harness: "codex", grain: BillingGrain::Hour,
            source: BillingSource::Realtime, start_ms: s, end_ms: e,
        }).unwrap();
        let new_set: Vec<(i64, Option<String>, i64, i64, i64, i64)> = new_rows
            .into_iter()
            .map(|r| (r.idx, r.model, r.uncached_input_tokens, r.cache_read_tokens, r.cache_write_tokens, r.output_tokens))
            .collect();
        let mut stmt = db.conn().prepare(FROZEN_CODEX_BY_HOUR_MODEL).unwrap();
        let frozen_set: Vec<(i64, Option<String>, i64, i64, i64, i64)> = stmt
            .query_map(hour_p, |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            }).unwrap().map(Result::unwrap).collect();
        assert_eq!(new_set, frozen_set, "codex 计费小时聚合新旧必须行级一致");
        // 关键语义抽查：订阅覆盖与峰行确实被各自的过滤器排除。
        assert!(new_set.iter().all(|(_, _, u, _, _, _)| *u != 999),
            "峰行/订阅覆盖行不得混入");

        let _ = std::fs::remove_file(&path);
    }

    /// v0.9.1 测试矩阵 §8 行 8「performance（不枚举原始日志/索引命中）」。
    ///
    /// SQL 权威库的整个存在理由是「查询不枚举原始日志」——每个窗口化聚合
    /// 必须命中 `usage_facts_harness_time`（`(harness, event_ts_ms)` 部分索引），
    /// 绝不 `SCAN usage_facts`（全表）。一个错的查询会**静默**退化成全表扫
    /// （功能对、性能崩），没有异常没有红测——只有真机 5 万行时的卡顿，正是
    /// 2026-09-05 tab 卡顿事故的形状。这条断言把「退化」变成编译期就该发现
    /// 的红。SQL 与 `prepare()` 共用 `SQL_*` const，零漂移。
    #[test]
    fn windowed_queries_hit_the_harness_time_index_never_full_scan() {
        let path = tmp_db("qplan");
        let db = AuthorityDb::open(&path, 1).unwrap();
        // 三执行环境各塞几行——EXPLAIN QUERY PLAN 不依赖行数，但有数据时 SQLite
        // 更可能选真实计划而非退化到 "SCAN"（空表任何查询都 SCAN）。
        let (s, _e) = beijing_day_bounds_ms("2026-09-05").unwrap();
        for (i, harness) in ["dsh", "claude-code", "codex"].iter().enumerate() {
            insert_fact(
                &db,
                &format!("f{i}a"),
                harness,
                Some("m"),
                "turn",
                s + 3_600_000,
                0,
                100,
                0,
                0,
                10,
            );
            insert_fact(
                &db,
                &format!("f{i}b"),
                harness,
                Some("m"),
                "turn",
                s + 7_200_000,
                1,
                50,
                0,
                0,
                5,
            );
        }
        insert_fact(
            &db,
            "lg",
            "claude-code",
            Some("m"),
            "legacy_aggregate",
            s + 1_000,
            0,
            9,
            0,
            0,
            0,
        );
        db.conn().execute("ANALYZE", []).unwrap();

        let end = s + DAY_MS;
        let plan = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> String {
            let mut stmt = db
                .conn()
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap();
            let rows: Vec<String> = stmt
                .query_map(params, |r| r.get::<_, String>(3))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            rows.join(" | ")
        };
        let peak_params: [&dyn rusqlite::ToSql; 5] =
            [&BEIJING_OFFSET_MS, &DAY_MS, &"dsh", &s, &end];
        let page_after_ts = i64::MIN;
        let page_after_id = "";
        let page_limit = 50_i64;
        let page_params: [&dyn rusqlite::ToSql; 6] =
            [&"dsh", &s, &end, &page_after_ts, &page_after_id, &page_limit];
        // `hourly_by_harness_model` = 单执行环境 SQL + 在 fn 内 in-memory 合并 3 执行环境。
        // EXPLAIN 只测一条 harness 字面量是否命中索引——三执行环境合并是 fn 行为，
        // 不在 SQL planner 视野内。
        let hourly_h_params: [&dyn rusqlite::ToSql; 5] =
            [&BEIJING_OFFSET_MS, &HOUR_MS, &s, &end, &"claude-code"];
        let no_hour: i64 = -1;
        let no_model: Option<&str> = None;
        let no_provider: Option<&str> = None;
        let sessions_params: [&dyn rusqlite::ToSql; 8] =
            [&"dsh", &s, &end, &no_hour, &BEIJING_OFFSET_MS, &HOUR_MS, &no_model, &no_provider];
        let harness_window_params: [&dyn rusqlite::ToSql; 5] =
            [&BEIJING_OFFSET_MS, &DAY_MS, &"workbuddy", &s, &end];

        // 通用计费窗口（取代三份执行环境手抄 SQL）：直接 EXPLAIN 构建器产物——
        // 零漂移性质从「共享 const」升级为「测的就是运行时用的那条 SQL」。
        let billing_day_params: [&dyn rusqlite::ToSql; 5] =
            [&BEIJING_OFFSET_MS, &DAY_MS, &s, &end, &"claude-code"];
        let billing_hour_params: [&dyn rusqlite::ToSql; 5] =
            [&BEIJING_OFFSET_MS, &HOUR_MS, &s, &end, &"codex"];
        for (name, sql, params) in [
            ("peaked_days_map", SQL_PEAKED_DAYS_MAP, &peak_params[..]),
            ("billing_day(claude)", &billing_window_sql(&BillingWindowQuery {
                harness: "claude-code", grain: BillingGrain::Day,
                source: BillingSource::Realtime, start_ms: s, end_ms: end,
            }), &billing_day_params[..]),
            ("billing_day(claude,legacy)", &billing_window_sql(&BillingWindowQuery {
                harness: "claude-code", grain: BillingGrain::Day,
                source: BillingSource::LegacyAggregate, start_ms: s, end_ms: end,
            }), &billing_day_params[..]),
            ("billing_hour(codex)", &billing_window_sql(&BillingWindowQuery {
                harness: "codex", grain: BillingGrain::Hour,
                source: BillingSource::Realtime, start_ms: s, end_ms: end,
            }), &billing_hour_params[..]),
            ("hourly_by_harness_model", SQL_HOURLY_BY_HARNESS_MODEL, &hourly_h_params[..]),
            ("facts_page_window", SQL_FACTS_PAGE_WINDOW, &page_params[..]),
            ("sessions_in_window", SQL_SESSIONS_IN_WINDOW, &sessions_params[..]),
            ("harness_window_tokens", SQL_HARNESS_WINDOW_TOKENS, &harness_window_params[..]),
        ] {
            let p = plan(sql, params);
            assert!(
                p.contains("USING INDEX usage_facts_harness_time"),
                "{name} 必须命中 usage_facts_harness_time——计划：{p}"
            );
            assert!(
                !p.contains("SCAN usage_facts"),
                "{name} 不得全表扫 usage_facts——计划：{p}"
            );
        }

        // session_detail 时间线走 session_key 索引（不是 harness_time）。
        let tl_ts = i64::MIN;
        let tl_id = "";
        let tl_limit = 50_i64;
        let tl_params: [&dyn rusqlite::ToSql; 4] = [&"3:dsh|1:s|1:n", &tl_ts, &tl_id, &tl_limit];
        let p = plan(SQL_SESSION_TIMELINE, &tl_params[..]);
        assert!(
            p.contains("USING INDEX usage_facts_session_time"),
            "session_facts_timeline 必须命中 usage_facts_session_time——计划：{p}"
        );
        assert!(!p.contains("SCAN usage_facts"), "计划：{p}");

        let _ = std::fs::remove_file(&path);
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_session_fact(
        db: &AuthorityDb,
        fact_id: &str,
        harness: &str,
        session_key: &str,
        model_id: &str,
        event_ts_ms: i64,
        event_peak: i64,
        tokens: i64,
    ) {
        db.conn()
            .execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('run', 1, 'cli', 'succeeded', 2) ON CONFLICT(run_id) DO NOTHING",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace,
                     source_profile, last_observed_at_ms)
                 VALUES (?1, ?2, ?3, 'm', 'default', 1) ON CONFLICT(session_key) DO NOTHING",
                rusqlite::params![session_key, harness, format!("native-{session_key}")],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     session_key, source_event_id, observation_kind, model_id, event_ts_ms,
                     event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                     output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'm', ?3, ?4, ?1, 'assistant-usage', ?5, ?6, ?7, ?8, 0, 0, 0,
                         'run', 1, 1)",
                rusqlite::params![
                    fact_id, harness, format!("native-{session_key}"), session_key, model_id,
                    event_ts_ms, event_peak, tokens
                ],
            )
            .unwrap();
    }

    #[test]
    fn sessions_in_window_aggregates_and_hour_filter_sums_to_the_hour() {
        let path = tmp_db("sess-agg");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (start, end) = beijing_day_bounds_ms("2026-09-07").unwrap();
        let h9 = start + 9 * HOUR_MS;
        let h22 = start + 22 * HOUR_MS;
        // sA: 09点 100 + 22点 300；sB: 22点 500；sC(codex): 09点 40。
        insert_session_fact(&db, "f1", "claude-code", "kA", "m-a", h9, 0, 100);
        insert_session_fact(&db, "f2", "claude-code", "kA", "m-a", h22, 0, 300);
        insert_session_fact(&db, "f3", "claude-code", "kB", "m-b", h22 + 60_000, 0, 500);
        insert_session_fact(&db, "f4", "codex", "kC", "m-c", h9 + 60_000, 0, 40);
        db.conn()
            .execute("UPDATE usage_facts SET provider_id = 'provider-b' WHERE fact_id = 'f3'", [])
            .unwrap();

        // 无小时过滤：3 会话，window_total = 940。
        let (rows, more, wt, count) =
            sessions_in_window(db.conn(), start, end, &[], None, None, None, 0, None, None, 50).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(!more);
        assert_eq!(wt, 940);
        assert_eq!(count, 3);
        // total 降序：kA(400) > kB(500)? no — kB=500 > kA=400. 顺序 kB, kA, kC。
        assert_eq!(rows[0].session_key, "kB");
        assert_eq!(rows[0].total(), 500);
        assert_eq!(rows[1].session_key, "kA");
        assert_eq!(rows[1].total(), 400);
        assert_eq!(rows[1].event_count, 2);
        assert_eq!(rows[1].first_event_ms, h9);
        assert_eq!(rows[1].last_event_ms, h22);

        // 22 点过滤：kA 贡献 300、kB 贡献 500 → sum == 800（== usage_hourly 22点 total）。
        let (rows, _, wt22, count22) =
            sessions_in_window(db.conn(), start, end, &[], None, None, Some(22), 0, None, None, 50).unwrap();
        assert_eq!(wt22, 800, "Q04 不变式：会话之和 == 峰值小时总量");
        assert_eq!(count22, 2);
        assert_eq!(rows.iter().map(|s| s.total()).sum::<i64>(), 800);
        assert!(rows.iter().all(|s| s.harness == "claude-code"));

        // harness 过滤 + min_tokens。
        let (rows, _, _, _) =
            sessions_in_window(db.conn(), start, end, &["codex".into()], None, None, None, 0, None, None, 50)
                .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_key, "kC");

        // model 过滤只保留包含该 model 的会话，并保持窗口总量与结果一致。
        let (rows, _, model_total, model_count) =
            sessions_in_window(db.conn(), start, end, &[], Some("m-b"), None, None, 0, None, None, 50)
                .unwrap();
        assert_eq!(model_count, 1);
        assert_eq!(model_total, 500);
        assert_eq!(rows[0].session_key, "kB");

        // provider 过滤与模型过滤同样作用于权威窗口聚合。
        let (rows, _, provider_total, provider_count) = sessions_in_window(
            db.conn(), start, end, &[], None, Some("provider-b"), None, 0, None, None, 50,
        )
        .unwrap();
        assert_eq!(provider_count, 1);
        assert_eq!(provider_total, 500);
        assert_eq!(rows[0].session_key, "kB");

        // oldest_first：first_event 升序 + (first_event, session_key) keyset 续页。
        // City 一年窗口从最老数据开始装载——token 序下被上限裁掉的永远是最老的
        // 会话，这里钉住装载序与游标语义。
        let (page1, more1, _, _) = sessions_in_window_ordered(
            db.conn(), start, end, &[], None, None, None, 0, None, None, 2, true,
        )
        .unwrap();
        assert_eq!(
            page1.iter().map(|s| s.session_key.as_str()).collect::<Vec<_>>(),
            vec!["kA", "kC"],
            "oldest_first 按 first_event 升序（kA@9:00, kC@9:01），token 序完全相反"
        );
        assert!(more1);
        let cursor_at = page1.last().unwrap().first_event_ms; // h9+60s (kC)
        let (page2, more2, _, _) = sessions_in_window_ordered(
            db.conn(), start, end, &[], None, None, None, 0, Some(cursor_at), Some("kC"), 2, true,
        )
        .unwrap();
        assert_eq!(
            page2.iter().map(|s| s.session_key.as_str()).collect::<Vec<_>>(),
            vec!["kB"],
            "游标之后只剩 first_event 更晚（或同刻更大 key）的会话"
        );
        assert!(!more2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn session_timeline_is_time_ordered_and_paginates() {
        let path = tmp_db("sess-tl");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        for (i, id) in ["a", "b", "c", "d"].iter().enumerate() {
            insert_session_fact(
                &db, id, "dsh", "kX", "m", start + (i as i64) * HOUR_MS,
                if i == 2 { 1 } else { 0 }, 10,
            );
        }
        // 别的会话的行不能混进来。
        insert_session_fact(&db, "z", "dsh", "kOther", "m", start, 0, 999);

        let (p1, more) = session_facts_timeline(db.conn(), "kX", None, None, 2).unwrap();
        assert_eq!(p1.iter().map(|f| f.fact_id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert!(more);
        let last = &p1[1];
        let (p2, more) = session_facts_timeline(
            db.conn(), "kX", Some(last.event_ts_ms), Some(&last.fact_id), 10,
        )
        .unwrap();
        assert_eq!(p2.iter().map(|f| f.fact_id.as_str()).collect::<Vec<_>>(), ["c", "d"]);
        assert!(!more);
        assert!(p2[0].event_peak, "c 在高峰时段");

        assert!(session_row(db.conn(), "kX").unwrap().is_some());
        assert!(session_row(db.conn(), "kNope").unwrap().is_none());
        let _ = std::fs::remove_file(&path);
    }

    // ─────── PR #2.1：session_cost_minor ───────
    //
    // 关键不变量（spec §0.1 不冒充）：
    // (1) JOIN 路径——usage_facts.peak=true/false 各聚合 → cost_report 期望的 8 桶
    //     形状 → pricing_snapshot.asof(MAX(event_ts_ms)) 选历史价卡（Q13）。
    // (2) 任意一环失败（无事实 / 无价卡 / 价卡脏 / 无可计模型）→ 返 None，
    //     不冒充零成本。
    // (3) BillingBasis::MeteredEstimate——与 harness_bills 的 MeteredActual 不同
    //     档位，DTO 上层不得求和进 summable_total。

    /// 一份精简 `assets/pricing.json` 片段，模型名直接对得上 fallback_provider
    /// 的 `deepseek-v4-pro` 表项——`norm_model_in` 会把 `dsh/deepseek-v4-pro-0813`
    /// 之类的真实模型名归一化到这里。`input_uncached.off_peak = 4.5` 元/M token
    /// 是 OFF 价的客观基准，断言用它倒推 cost_minor 的精度与单位。
    const TEST_PRICING_FRAGMENT: &str = r#"{
        "fallback_provider": "deepseek-official",
        "providers": {
            "deepseek-official": {
                "models": {
                    "deepseek-v4-pro": {
                        "input_uncached": { "off_peak": 4.5, "peak": 9.0 },
                        "input_cached":  { "off_peak": 0.15, "peak": 0.30 },
                        "output":        { "off_peak": 13.5, "peak": 27.0 }
                    }
                }
            }
        }
    }"#;

    #[test]
    fn session_cost_minor_joins_pricing_snapshot_at_event_ts() {
        // 用例：会话事件峰期分布 + 历史价卡覆盖到 MAX(event_ts_ms)，
        // 期望 cost_minor = (u_off*4.5 + u_peak*9.0 + o_off*13.5) / 1e6，
        // 单位 CNY，basis = MeteredEstimate。
        let path = tmp_db("cm-join");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (day_start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        // model 用 `dsh/deepseek-v4-pro-0813`，norm_model_in 会归一化到
        // `deepseek-v4-pro` 卡键。
        let skey = "skey-cm-1";
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, 'dsh', 'native-cm-1', 'm', 'default', 1)",
            rusqlite::params![skey],
        ).unwrap();
        // `insert_fact` 测试助手不写 session_key（其他测试只关心 hourly/聚合，
        // 不需要 join 到 sessions）。本测试要 join 到 sessions 用 skey 过滤，
        // 所以直接走完整 INSERT——把 session_key 写对。
        let mut ins = db.conn().prepare(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 session_key, source_event_id, observation_kind, provider_id, model_id,
                 event_ts_ms, event_peak, uncached_input_tokens, cache_read_tokens,
                 cache_write_tokens, output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES (?1, 'dsh', 'm', 'native-cm-1', ?2, ?1, ?3, NULL, ?4, ?5, ?6, ?7, 0, 0, ?8, 'run', 1, 1)"
        ).unwrap();
        ins.execute(rusqlite::params![
            "f1", skey, "assistant-usage", "dsh/deepseek-v4-pro-0813",
            day_start + 3_600_000, 0_i64, 1000000_i64, 0_i64
        ]).unwrap();
        ins.execute(rusqlite::params![
            "f2", skey, "assistant-usage", "dsh/deepseek-v4-pro-0813",
            day_start + 5 * 3_600_000, 1_i64, 500000_i64, 0_i64
        ]).unwrap();
        ins.execute(rusqlite::params![
            "f3", skey, "assistant-usage", "dsh/deepseek-v4-pro-0813",
            day_start + 9 * 3_600_000, 0_i64, 0_i64, 200000_i64
        ]).unwrap();
        // legacy_aggregate 行：必须被排除。
        ins.execute(rusqlite::params![
            "f_legacy", skey, "legacy_aggregate", "dsh/deepseek-v4-pro-0813",
            day_start + 4 * 3_600_000, 0_i64, 9999999_i64, 0_i64
        ]).unwrap();
        drop(ins);
        // 价卡：captured_at_ms < max(event_ts) 才能被 SELECT ... WHERE
        // captured_at_ms <= max_ts 命中。
        db.pricing_snapshot_put(
            "v1", "cli_seed",
            TEST_PRICING_FRAGMENT,
            day_start - 7 * DAY_MS,
        ).unwrap();

        let mm = session_cost_minor(db.conn(), skey)
            .unwrap()
            .expect("有事实 + 有价卡 + 有可计模型 → 应有 MoneyMinor");
        assert_eq!(mm.currency, "CNY");
        assert_eq!(mm.basis, agent_vitals_domain::data_contract::BillingBasis::MeteredEstimate);
        // 手算：bucket_price 一次性合并 (model, peak) 两轴。
        //   总 uncached_input = 1_000_000 (f1 off) + 500_000 (f2 peak) = 1_500_000
        //   总 peak_uncached_input = 500_000 (f2)
        //   u_off = 1_500_000 - 500_000 = 1_000_000  ← 这里 4.5/1e6
        //   u_peak = 500_000                          ← 这里 9.0/1e6
        //   总 output = 200_000, peak_output = 0 → o_off = 200_000  ← 13.5/1e6
        //   total = 1_000_000*4.5/1e6 + 500_000*9.0/1e6 + 200_000*13.5/1e6
        //         = 4.5 + 4.5 + 2.7 = 11.70 元 → 1170 分（CNY=2）
        assert_eq!(mm.amount_minor, 1170, "8 桶折算 + peak 拆分 + 舍入到分");

        // 任何不含 native id 的字符串——DTO 不泄执行环境词表。
        let j = mm.to_json().to_string();
        assert!(!j.contains("native-cm-1"));
        assert!(!j.contains("dsh/deepseek-v4-pro-0813"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn session_cost_minor_keeps_facts_on_their_historical_price_versions() {
        let path = tmp_db("cm-cross-snapshot");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        let key = "skey-cross-snapshot";
        db.conn().execute("INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms) VALUES (?1, 'dsh', 'native', 'm', 'default', 1)", [key]).unwrap();
        for (id, at) in [("before", start + 1_000), ("after", start + 3_000)] {
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, session_key, source_event_id, observation_kind, model_id, event_ts_ms, event_peak, uncached_input_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, 'dsh', 'm', 'native', ?2, ?1, 'assistant-usage', 'dsh/deepseek-v4-pro-0813', ?3, 0, 1000000, 'run', 1, 1)",
                rusqlite::params![id, key, at],
            ).unwrap();
        }
        db.pricing_snapshot_put("old", "test", TEST_PRICING_FRAGMENT, start).unwrap();
        let new_card = TEST_PRICING_FRAGMENT.replace("\"off_peak\": 4.5", "\"off_peak\": 9.0");
        db.pricing_snapshot_put("new", "test", &new_card, start + 2_000).unwrap();
        let buckets = session_billing_buckets(db.conn(), key).unwrap();
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0]["pricing_version"], "new");
        assert_eq!(buckets[1]["pricing_version"], "old");
        assert_eq!(session_cost_minor(db.conn(), key).unwrap().unwrap().amount_minor, 1350,
            "¥4.50 old card + ¥9.00 new card, never reprice both at the latest card");
        let window_buckets = session_billing_buckets_in_window(db.conn(), key, Some((start, start + 2_000))).unwrap();
        assert_eq!(window_buckets.len(), 1, "window excludes the later usage event");
        assert_eq!(session_cost_view_from_buckets(&window_buckets)["cost_minor"]["amount_minor"], 450,
            "window cost is computed from the same subset as window tokens");
        let _ = std::fs::remove_file(&path);
    }

    /// 2026-09-29 用户定的回补口径：每日同步到的价卡只补历史快照里**当时没有**的
    /// 模型（gpt-6 发布当天到价卡上线之间的用量），已有价的**不改**——叠加层里
    /// gpt-5.6-luna 改成了两倍价，历史金额仍按当时快照。补出来的金额标 `backfilled`。
    #[test]
    fn sync_overlay_backfills_missing_cards_but_never_reprices_history() {
        let path = tmp_db("sync-backfill");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (day_start, _) = beijing_day_bounds_ms("2026-09-23").unwrap();
        let skey = "skey-sync-backfill";
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, 'codex', 'native-backfill', 'm', 'default', 1)",
            rusqlite::params![skey],
        ).unwrap();
        for (id, model) in [("f-old", "gpt-5.6-luna"), ("f-new", "gpt-6-luna")] {
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     session_key, source_event_id, observation_kind, provider_id, model_id,
                     event_ts_ms, event_peak, uncached_input_tokens, output_tokens,
                     ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, 'codex', 'm', 'native-backfill', ?2, ?1, 'token_count', 'openai', ?3,
                         ?4, 0, 1000000, 1000000, 'run', 1, 1)",
                rusqlite::params![id, skey, model, day_start + 3_600_000],
            ).unwrap();
        }
        let historical = r#"{"pricing": {}, "codex_pricing": {"entries": [{
            "modelPrefix": "gpt-5.6-luna", "speed": "standard",
            "uncachedInputUsdPerMTok": "0.2", "outputUsdPerMTok": "1.2"}]}}"#;
        db.pricing_snapshot_put("v-hist", "embedded-assets", historical, day_start - DAY_MS).unwrap();

        // 用量发生一天后，每日同步到来：新增 gpt-6-luna，并把 gpt-5.6-luna 改成两倍价
        let overlay = r#"{"schema":"agent-vitals-pricing-sync/v1","codex_entries":[
            {"modelPrefix":"gpt-5.6-luna","speed":"standard","uncachedInputUsdPerMTok":"0.4","outputUsdPerMTok":"2.4"},
            {"modelPrefix":"gpt-6-luna","speed":"standard","uncachedInputUsdPerMTok":"0.1","outputUsdPerMTok":"0.5"}]}"#;
        db.pricing_sync_overlay_put("sync-1", overlay, "v-merged", r#"{"pricing":{},"codex_pricing":{"entries":[]}}"#,
            day_start + DAY_MS).unwrap();

        let buckets = session_billing_buckets(db.conn(), skey).unwrap();
        let by_model = |m: &str| buckets.iter().find(|b| b["model_id"] == m).unwrap().clone();
        let old = by_model("gpt-5.6-luna");
        assert_eq!(old["cost_minor"]["amount_minor"], 140, "$0.2 + $1.2：按当时快照，叠加层的改价不改写历史");
        assert_ne!(old["pricing_source"], "backfilled");
        let new = by_model("gpt-6-luna");
        assert_eq!(new["cost_minor"]["amount_minor"], 60, "$0.1 + $0.5：当时缺卡，用事后同步到的价卡补上");
        assert_eq!(new["pricing_source"], "backfilled");
        assert_eq!(new["pricing_version"], "v-hist", "补录不改变事件所属的价格版本");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn session_cost_minor_prices_unknown_codex_with_official_snapshot_card() {
        let path = tmp_db("cm-codex-unknown");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (day_start, _) = beijing_day_bounds_ms("2026-09-09").unwrap();
        let skey = "skey-codex-unknown";
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, 'codex', 'native-codex-unknown', 'm', 'default', 1)",
            rusqlite::params![skey],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 session_key, source_event_id, observation_kind, provider_id, model_id,
                 event_ts_ms, event_peak, uncached_input_tokens, cache_read_tokens,
                 cache_write_tokens, output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f1', 'codex', 'm', 'native-codex-unknown', ?1, 'f1', 'token_count', NULL,
                     'openai/gpt-5.6-luna', ?2, 0, 1000000, 1000000, 1000000, 1000000, 'run', 1, 1)",
            rusqlite::params![skey, day_start + 3_600_000],
        ).unwrap();
        let pricing = r#"{
          "codex_pricing": {"entries": [{
            "modelPrefix": "gpt-5.6-luna", "speed": "standard",
            "uncachedInputUsdPerMTok": "0.2", "cacheReadUsdPerMTok": "0.02",
            "cacheWrite5mUsdPerMTok": "0.25", "outputUsdPerMTok": "1.2"
          }]}
        }"#;
        db.pricing_snapshot_put("v-codex", "cli_seed", pricing, day_start - DAY_MS).unwrap();

        let mm = session_cost_minor(db.conn(), skey).unwrap().expect("unknown Codex must be estimated");
        assert_eq!(mm.currency, "USD");
        assert_eq!(mm.basis, agent_vitals_domain::data_contract::BillingBasis::MeteredEstimate);
        assert_eq!(mm.amount_minor, 167, "0.2 + 0.02 + 0.25 + 1.2 USD = $1.67");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn billing_buckets_keep_custom_provider_cache_reads_and_fallback_estimate_separate() {
        let path = tmp_db("billing-buckets-custom");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (day_start, _) = beijing_day_bounds_ms("2026-09-09").unwrap();
        let skey = "skey-billing-buckets";
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, 'codex', 'native-bucket', 'm', 'default', 1)",
            rusqlite::params![skey],
        ).unwrap();
        for (fact_id, provider_id, uncached, cache_read) in [
            ("f-custom", None::<&str>, 1_000_000, 1_000_000),
            ("f-openai", Some("openai"), 1_000_000, 0),
        ] {
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     session_key, source_event_id, observation_kind, provider_id, provider_raw,
                     billing_mode, pricing_basis, model_id, event_ts_ms, event_peak,
                     uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, 'codex', 'm', 'native-bucket', ?2, ?1, 'token_count', ?3, 'custom',
                         'metered', 'metered_estimate', 'openai/gpt-5.6-luna', ?4, 0, ?5, ?6, 0, 0,
                         'run', 1, 1)",
                rusqlite::params![fact_id, skey, provider_id, day_start + 3_600_000, uncached, cache_read],
            ).unwrap();
        }
        let pricing = r#"{"codex_pricing":{"entries":[{
          "modelPrefix":"gpt-5.6-luna","speed":"standard","uncachedInputUsdPerMTok":"0.2",
          "cacheReadUsdPerMTok":"0.02","cacheWrite5mUsdPerMTok":"0.25","outputUsdPerMTok":"1.2"}]}}"#;
        db.pricing_snapshot_put("v-bucket", "test", pricing, day_start).unwrap();
        let buckets = session_billing_buckets(db.conn(), skey).unwrap();
        assert_eq!(buckets.len(), 2, "different providers must not merge");
        let custom = buckets.iter().find(|b| b["provider_id"].is_null()).unwrap();
        assert_eq!(custom["tokens"]["cache_read_tokens"], 1_000_000);
        assert_eq!(custom["pricing_source"], "fallback_official");
        assert_eq!(custom["cost_minor"]["amount_minor"], 22, "$0.20 + $0.02");
        assert_eq!(custom["has_unresolved"], true);
        let official = buckets.iter().find(|b| b["provider_id"] == "openai").unwrap();
        assert_eq!(official["pricing_source"], "fallback_official",
            "provider_id alone is not official-route evidence");
        assert_eq!(official["has_unresolved"], true);
        assert_eq!(official["cost_minor"]["amount_minor"], 20);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn session_cost_minor_does_not_merge_same_model_across_providers() {
        let path = tmp_db("cm-cross-provider");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (day_start, _) = beijing_day_bounds_ms("2026-09-09").unwrap();
        let skey = "skey-cross-provider";
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, 'codex', 'native-cross-provider', 'm', 'default', 1)",
            rusqlite::params![skey],
        ).unwrap();
        for (fact_id, provider) in [("f-openai", "openai"), ("f-cogfoundry", "cogfoundry.ai")] {
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     session_key, source_event_id, observation_kind, provider_id, model_id,
                     event_ts_ms, event_peak, uncached_input_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, 'codex', 'm', 'native-cross-provider', ?2, ?1, 'token_count', ?3,
                         'openai/gpt-5.6-luna', ?4, 0, 1, 'run', 1, 1)",
                rusqlite::params![fact_id, skey, provider, day_start + 3_600_000],
            ).unwrap();
        }
        assert_eq!(session_cost_minor(db.conn(), skey).unwrap(), None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn session_cost_minor_never_prices_subscription_facts() {
        let path = tmp_db("cm-subscription");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (day_start, _) = beijing_day_bounds_ms("2026-09-09").unwrap();
        let skey = "skey-subscription";
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, 'codex', 'native-subscription', 'm', 'default', 1)",
            rusqlite::params![skey],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 session_key, source_event_id, observation_kind, provider_id, billing_mode, model_id,
                 event_ts_ms, event_peak, uncached_input_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f-sub', 'codex', 'm', 'native-subscription', ?1, 'f-sub', 'token_count',
                     'openai', 'subscription', 'gpt-5.6-luna', ?2, 0, 1000000, 'run', 1, 1)",
            rusqlite::params![skey, day_start + 3_600_000],
        ).unwrap();
        let pricing = r#"{"codex_pricing":{"entries":[{"modelPrefix":"gpt-5.6-luna","speed":"standard","uncachedInputUsdPerMTok":"0.2","cacheReadUsdPerMTok":"0.02","cacheWrite5mUsdPerMTok":"0.25","outputUsdPerMTok":"1.2"}]}}"#;
        db.pricing_snapshot_put("v-sub", "test", pricing, day_start).unwrap();
        assert_eq!(session_cost_minor(db.conn(), skey).unwrap(), None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn session_billing_buckets_apply_current_subscription_attribution() {
        let path = tmp_db("session-derived-subscription");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (day_start, _) = beijing_day_bounds_ms("2026-09-09").unwrap();
        let skey = "skey-derived-subscription";
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, 'codex', 'native-derived', 'm', 'default', 1)", [skey],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 session_key, source_event_id, observation_kind, provider_id, model_id,
                 event_ts_ms, event_peak, uncached_input_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f-derived', 'codex', 'm', 'native-derived', ?1, 'f-derived', 'token_count',
                     'openai', 'gpt-5.6-luna', ?2, 0, 1000000, 'run', 1, 1)",
            rusqlite::params![skey, day_start + 3_600_000],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO billing_declarations(
                declaration_id, harness, provider_id, relationship_kind, effective_start,
                created_at_ms, updated_at_ms)
             VALUES ('decl-derived', 'codex', 'openai', 'official_subscription', '2026-09', 1, 1)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO billing_declaration_revisions(
                revision_id, declaration_id, revision_number, change_kind, harness, provider_id,
                relationship_kind, effective_start, created_at_ms)
             VALUES ('rev-derived', 'decl-derived', 1, 'saved', 'codex', 'openai',
                     'official_subscription', '2026-09', 1)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO billing_recalculation_jobs(
                job_id, declaration_id, revision_id, status, requested_at_ms)
             VALUES ('job-derived', 'decl-derived', 'rev-derived', 'succeeded', 1)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO billing_fact_attributions(
                fact_id, revision_id, job_id, attribution_kind, created_at_ms)
             VALUES ('f-derived', 'rev-derived', 'job-derived', 'subscription_covered', 1)",
            [],
        ).unwrap();

        let buckets = session_billing_buckets(db.conn(), skey).unwrap();
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0]["billing_mode"], "subscription");
        assert_eq!(session_cost_minor(db.conn(), skey).unwrap(), None);
        db.conn().execute(
            "INSERT INTO billing_declaration_revisions(
                revision_id, declaration_id, revision_number, change_kind, harness, provider_id,
                relationship_kind, effective_start, created_at_ms)
             VALUES ('rev-derived-pending', 'decl-derived', 2, 'saved', 'codex', 'openai',
                     'official_subscription', '2026-09', 2)", [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO billing_recalculation_jobs(job_id, declaration_id, revision_id, status, requested_at_ms)
             VALUES ('job-derived-pending', 'decl-derived', 'rev-derived-pending', 'queued', 2)", [],
        ).unwrap();
        assert_eq!(session_billing_buckets(db.conn(), skey).unwrap()[0]["billing_mode"], "subscription");
        db.conn().execute("UPDATE billing_recalculation_jobs SET status = 'failed' WHERE job_id = 'job-derived-pending'", []).unwrap();
        assert_eq!(session_cost_minor(db.conn(), skey).unwrap(), None);
        db.conn().execute(
            "INSERT INTO billing_declaration_revisions(
                revision_id, declaration_id, revision_number, change_kind, harness, provider_id,
                relationship_kind, effective_start, created_at_ms)
             VALUES ('rev-derived-revoked', 'decl-derived', 3, 'revoked', 'codex', 'openai',
                     'official_subscription', '2026-09', 3)", [],
        ).unwrap();
        assert_ne!(session_billing_buckets(db.conn(), skey).unwrap()[0]["billing_mode"], "subscription");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn session_cost_minor_returns_none_when_no_pricing_snapshot() {
        let path = tmp_db("cm-no-snap");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (day_start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        let skey = "skey-cm-2";
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, 'dsh', 'native-cm-2', 'm', 'default', 1)",
            rusqlite::params![skey],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 session_key, source_event_id, observation_kind, provider_id, model_id,
                 event_ts_ms, event_peak, uncached_input_tokens, cache_read_tokens,
                 cache_write_tokens, output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f1', 'dsh', 'm', 'native-cm-2', ?1, 'f1', 'assistant-usage', NULL, 'm', ?2, 0, 1000000, 0, 0, 0, 'run', 1, 1)",
            rusqlite::params![skey, day_start + 3_600_000],
        ).unwrap();
        // 故意不插 pricing_snapshot——模拟「事实已 ingest 但价卡还没采集」的
        // 真实过渡态。JOIN 应返 None，不冒充零成本。
        let r = session_cost_minor(db.conn(), skey).unwrap();
        assert!(r.is_none(), "无价卡覆盖 → None（不冒充 0）");

        let keys = vec![skey.to_string()];
        let reference = |db: &AuthorityDb| {
            let buckets = sessions_billing_buckets_with_reference_in_window(db.conn(), &keys, None).unwrap();
            session_cost_view_from_buckets(&buckets[skey])
        };
        assert_eq!(reference(&db)["reason"], "no-pricing-snapshot");
        db.conn().execute("UPDATE usage_facts SET model_id='dsh/deepseek-v4-pro-0813'", []).unwrap();
        db.pricing_snapshot_put("future", "fixture", TEST_PRICING_FRAGMENT, day_start + DAY_MS).unwrap();
        let view = reference(&db);
        assert_eq!(view["status"], "estimated");
        assert_eq!(view["reason"], "current-card-reference-estimate");
        assert_eq!(view["has_unresolved"], true);
        assert_eq!(view["cost_minor"]["basis"], "metered_estimate");
        assert_eq!(view["cost_minor"]["evidence_basis"], "route-or-provider-unresolved");
        db.conn().execute("UPDATE usage_facts SET evidence_basis='explicit-official-route'", []).unwrap();
        assert_eq!(reference(&db)["cost_minor"]["evidence_basis"], "explicit-official-route");
        assert_eq!(reference(&db)["has_unresolved"], true, "reference pricing remains uncertain even with a known route");
        assert_eq!(view["reference_prices"][0]["captured_at_ms"], day_start + DAY_MS);
        assert_eq!(view["reference_prices"][0]["pricing_version"], "future");
        assert!(session_cost_minor(db.conn(), skey).unwrap().is_none(), "default historical query stays strict");
        assert_eq!(session_cost_view(db.conn(), skey).unwrap()["reason"], "no-pricing-snapshot");
        db.conn().execute("UPDATE usage_facts SET billing_mode='subscription'", []).unwrap();
        assert_eq!(reference(&db)["status"], "subscription");
        assert!(reference(&db).get("reference_prices").is_none());
        db.conn().execute("UPDATE usage_facts SET billing_mode='metered'", []).unwrap();
        db.pricing_snapshot_put("historical", "fixture", TEST_PRICING_FRAGMENT, day_start - DAY_MS).unwrap();
        let historical = reference(&db);
        assert!(historical.get("reference_prices").is_none());
        assert_eq!(historical["pricing_versions"], json!(["historical"]));
        assert_eq!(historical["cost_minor"], session_cost_view(db.conn(), skey).unwrap()["cost_minor"]);
        db.conn().execute("DELETE FROM pricing_snapshots WHERE pricing_version='historical'", []).unwrap();
        db.conn().execute("UPDATE pricing_snapshots SET payload_json='{}'", []).unwrap();
        assert_eq!(reference(&db)["cost_minor"], Value::Null, "unknown card never produces a fake zero");
        db.conn().execute("UPDATE pricing_snapshots SET payload_json='invalid-json'", []).unwrap();
        assert_eq!(reference(&db)["cost_minor"], Value::Null, "malformed reference stays unavailable");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn session_cost_minor_returns_none_when_cost_report_unpriced() {
        // `cost_report` 在**未知模型**时不会返 None——所有 token 进 unpriced 桶，
        // 但 `per_model.is_empty() && unpriced != 0` 仍让 cost_report 返
        // Some(report_total=0, unpriced_tokens=N)。我们透出 `Some(
        // MoneyMinor{amount_minor=0, currency, basis})` 而不是 None——
        // 与 cost_report 同语义（无 priced cost，但 unpriced 不冒充零）。
        //
        // 同样覆盖：脏价卡（JSON parse 失败）→ None，不冒充。
        let path = tmp_db("cm-unpriced");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        let (day_start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        let skey = "skey-cm-3";
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, 'dsh', 'native-cm-3', 'm', 'default', 1)",
            rusqlite::params![skey],
        ).unwrap();
        // 模型名落进所有 provider 的卡都查不到的位置。
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 session_key, source_event_id, observation_kind, provider_id, model_id,
                 event_ts_ms, event_peak, uncached_input_tokens, cache_read_tokens,
                 cache_write_tokens, output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f1', 'dsh', 'm', 'native-cm-3', ?1, 'f1', 'assistant-usage', NULL, 'totally/unknown-model-xyz', ?2, 0, 1000, 0, 0, 0, 'run', 1, 1)",
            rusqlite::params![skey, day_start + 3_600_000],
        ).unwrap();
        // 价卡覆盖到 max_ts：合法 JSON，但任何模型都查不到。
        db.pricing_snapshot_put(
            "v_unpriced", "cli_seed",
            TEST_PRICING_FRAGMENT,
            day_start - DAY_MS,
        ).unwrap();
        let r = session_cost_minor(db.conn(), skey).unwrap();
        assert!(r.is_none(), "未计价 token → None（不冒充 0 或 partial cost）");

        // 第二档：JSON 脏价卡。payload_json 存进去是合法字符串但不能 JSON parse，
        // 我们的内联 `serde_json::from_str(&snap_payload)` 失败 → None。
        // 这里直接走已插入路径，模拟「写入端已 commit 但内容坏」的情况。
        db.conn().execute(
            "DELETE FROM pricing_snapshots WHERE pricing_version = 'v_unpriced'",
            [],
        ).unwrap();
        db.pricing_snapshot_put(
            "v_corrupt", "cli_seed",
            "{this is not valid json",
            day_start - DAY_MS,
        ).unwrap();
        let r2 = session_cost_minor(db.conn(), skey).unwrap();
        assert!(r2.is_none(), "脏价卡 → None（不冒充 0，不向上抛）");

        let _ = std::fs::remove_file(&path);
    }

    // ── PR #2.3：CLI `sessions navigation` 的 SQL 只读快照 ─────────────

    #[test]
    fn day_token_totals_by_harness_groups_and_sums_within_beijing_day() {
        // 2026-09-08 北京 10:00 / 14:00 各一条 fact（同 harness 累加）；
        // 跨日那条（次日 01:00）不进 09-08 的桶。
        let dir = tmp_db("navig_total");
        std::fs::create_dir_all(&dir).unwrap();
        let path = crate::authority::default_authority_path(&dir);
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (start, _) = beijing_day_bounds_ms("2026-09-08").unwrap();
        insert_fact(&db, "f1", "dsh", Some("m"), "assistant-usage", start + 10 * 3_600_000, 0, 100, 0, 0, 0);
        insert_fact(&db, "f2", "dsh", Some("m"), "assistant-usage", start + 14 * 3_600_000, 0, 200, 0, 0, 0);
        insert_fact(&db, "f3", "claude-code", Some("m"), "assistant-usage", start + 3_600_000, 0, 50, 0, 0, 0);
        // 跨日 fact：2026-09-09 北京 01:00 → 不计入 09-08 桶
        insert_fact(&db, "f4", "dsh", Some("m"), "assistant-usage", start + DAY_MS + 3_600_000, 0, 999, 0, 0, 0);
        drop(db);
        let totals = day_token_totals_by_harness(&dir, "2026-09-08").expect("库可读");
        assert_eq!(totals.get("dsh").copied(), Some(300), "10:00 + 14:00 = 300");
        assert_eq!(totals.get("claude-code").copied(), Some(50));
        // 跨日 fact 不计入（2026-09-08 的 end 是次日 00:00，[start,end) 半开）。
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn day_token_totals_by_harness_returns_none_when_authority_db_missing() {
        // 库文件不存在 → None（CLI 降级到 `{value:null, basis:null}`，不冒充 0）。
        let dir = tmp_db("navig_missing");
        std::fs::create_dir_all(&dir).unwrap();
        // 不开库，路径存在但库文件不存在
        let result = day_token_totals_by_harness(&dir, "2026-09-08");
        assert!(result.is_none(), "无库 → None（不向上抛）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn day_session_count_distinguishes_sessions_within_one_harness() {
        // 同一 harness 三条 fact 两条不同 session_key；其它 harness 不计入。
        let dir = tmp_db("navig_count");
        std::fs::create_dir_all(&dir).unwrap();
        let path = crate::authority::default_authority_path(&dir);
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run', 1, 'cli', 'succeeded', 1) ON CONFLICT(run_id) DO NOTHING",
            [],
        ).unwrap();
        // 先建 sessions 行（usage_facts.session_key FK → sessions.session_key，
        // 且 (harness, machine_namespace, native_session_id) 唯一）
        for (skey, harness, nat) in [
            ("3:dsh|10:s1|2:n", "dsh", "nat-s1"),
            ("3:dsh|10:s2|2:n", "dsh", "nat-s2"),
            ("3:codex|10:s3|2:n", "codex", "nat-s3"),
        ] {
            db.conn().execute(
                "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace,
                     source_profile, last_observed_at_ms)
                 VALUES (?1, ?2, ?3, 'm', 'default', 1)
                 ON CONFLICT(session_key) DO NOTHING",
                rusqlite::params![skey, harness, nat],
            ).unwrap();
        }
        let (start, _) = beijing_day_bounds_ms("2026-09-08").unwrap();
        for (fact_id, harness, skey) in [
            ("f1", "dsh", "3:dsh|10:s1|2:n"),
            ("f2", "dsh", "3:dsh|10:s1|2:n"),
            ("f3", "dsh", "3:dsh|10:s2|2:n"),
            ("f4", "codex", "3:codex|10:s3|2:n"),
        ] {
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     session_key, source_event_id, observation_kind, provider_id, model_id,
                     event_ts_ms, event_peak, uncached_input_tokens, cache_read_tokens,
                     cache_write_tokens, output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'm', ?4, ?3, ?1, 'assistant-usage', NULL, 'm', ?5, 0,
                         100, 0, 0, 0, 'run', 1, 1)",
                rusqlite::params![fact_id, harness, skey, &skey[5..skey.len()-4], start + 60_000],
            ).unwrap();
        }
        drop(db);
        let dsh_n = day_session_count(&dir, "2026-09-08", "dsh").unwrap();
        let codex_n = day_session_count(&dir, "2026-09-08", "codex").unwrap();
        let claude_n = day_session_count(&dir, "2026-09-08", "claude-code").unwrap();
        assert_eq!(dsh_n, 2, "dsh 两条不同 session_key → 2 sessions");
        assert_eq!(codex_n, 1, "codex 一条 session → 1");
        assert_eq!(claude_n, 0, "claude-code 无事实 → 0");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
