//! v0.11 persistent Issue identity and status history.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use jiff::Timestamp;
use std::collections::BTreeMap;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const EPOCH_SECONDS_CUTOFF: i64 = 100_000_000_000;

const LOCAL_DAY_IDX_SQL: &str =
    "CAST(julianday(date(event_ts_ms / 1000, 'unixepoch', 'localtime')) - 2440587.5 AS INTEGER)";

/// Normalize an epoch timestamp to the authority contract (milliseconds).
/// This is the single boundary conversion used by both new Issue writes and
/// the idempotent repair of rows written by older harness adapters.
///
/// 实现已下沉到 `agent_vitals_domain::util::to_epoch_ms` —— trace 契约
/// （`domain/trace.rs` 的 `TraceNode.started_at_ms`）有**同一个**单位缺陷，
/// 两处必须调同一个具名函数，不能各留一份。这里 `pub use` 保留原路径，
/// 使既有调用点零改动。**不是第二份实现。**
pub use agent_vitals_domain::util::to_epoch_ms;

/// Repair legacy Issue rows whose `_ms` value was populated with epoch seconds.
/// The operation is idempotent and keeps `metadata.time` in the same unit as
/// `opened_at_ms`, so future projections cannot reintroduce the mismatch.
pub fn repair_issue_timestamp_units(conn: &Connection) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT issue_id, opened_at_ms, metadata_json FROM issue_instances
         WHERE opened_at_ms < ?1 ORDER BY issue_id",
    )?;
    let rows = stmt.query_map([EPOCH_SECONDS_CUTOFF], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?,
    )))?.collect::<Result<Vec<_>, _>>()?;
    if rows.is_empty() { return Ok(0); }
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        for (issue_id, opened, metadata_raw) in &rows {
            let normalized = to_epoch_ms(*opened);
            let mut metadata = serde_json::from_str::<Value>(metadata_raw).unwrap_or_else(|_| json!({}));
            if !metadata.is_object() { metadata = json!({}); }
            metadata["time"] = json!(normalized);
            conn.execute(
                "UPDATE issue_instances SET opened_at_ms = ?2, metadata_json = ?3 WHERE issue_id = ?1",
                rusqlite::params![issue_id, normalized, metadata.to_string()],
            )?;
        }
        conn.execute_batch("COMMIT")?;
        Ok(rows.len())
    })();
    if result.is_err() { let _ = conn.execute_batch("ROLLBACK"); }
    result
}

#[derive(Debug, Clone)]
pub struct IssueInput<'a> {
    pub machine_namespace: &'a str,
    pub harness: &'a str,
    pub session_key: Option<&'a str>,
    pub issue_type: &'a str,
    pub instance_fingerprint: &'a str,
    pub status: &'a str,
    pub severity: &'a str,
    pub evaluator_id: &'a str,
    pub evaluator_version: &'a str,
    pub evidence_fingerprint: &'a str,
    pub opened_at_ms: i64,
    pub metadata_json: &'a str,
}

/// v0.11 read-only remedy catalog; it never contains executable payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemedyCandidate {
    pub remedy_id: &'static str,
    pub diagnostic_only: bool,
}

impl Default for RemedyCandidate {
    fn default() -> Self { remedy_for("<unknown>") }
}

/// issues 投影的总行数（issue_instances 去重后的组数无关，只数实例行）。
/// 供桌面端判定「投影全空 = 首次引导」（store.rs `issues_projection_empty`）：
/// 有任何一行就说明跑过 findings，首屏不再触发 evaluator 刷新。
pub fn issues_projection_count(conn: &rusqlite::Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM issue_instances", [], |r| r.get(0))
}

/// 失败族查询（小时 / 日两种聚合共用，规则族白名单只在这里一处——
/// OVERVIEW_TREND_RANGE_SPEC §3「单一规则族常量」）。规则名是编译期常量内联，
/// 只有时间窗走绑定参数（?1 起点含、?2 终点不含）。
const FAILURE_FAMILY_RULES: &str = "'SV611','SV612','SV613','retry_loop','tool_failure'";

fn failure_family_sql() -> String {
    format!(
        "SELECT opened_at_ms FROM issue_instances
         WHERE issue_type IN ({FAILURE_FAMILY_RULES})
           AND opened_at_ms >= ?1 AND opened_at_ms < ?2"
    )
}

/// Overview 趋势面板的失败小时聚合（OVERVIEW_TREND_PANEL spec v1.1 §2）：给定
/// 统计日（`beijing_day_bounds_ms` 的系统统计时区日窗）内，失败族 issue 按小时
/// （0–23 本地小时）计数。返回 `{"date", "hours": {"3": 2}}`；日期非法或查询
/// 失败 → `None`（读不到 ≠ 零失败，前端据此走「失败标记不可用」降级，不画假零）。
///
/// 规则族是 trajectory 失败族（SV611 同调用连打 / SV612 turn 死循环 /
/// SV613 进度停滞）加 legacy 名 `retry_loop` / `tool_failure`——规则级白名单，
/// 不是执行环境特化查询。计数含任意 status：标记表达「这小时发生过反复失败」的
/// 历史事实，用户对单条 issue 的 wontfix/resolved 处置不抹掉历史。小时桶与
/// 用量小时分布（`read_hourly_distribution`）同一条统计时区日界。
pub fn failure_hours_day(conn: &rusqlite::Connection, date: &str) -> Option<Value> {
    let (start, end) = crate::authority_query::beijing_day_bounds_ms(date)?;
    // 规则族是编译期常量，直接内联；只有时间窗走绑定参数。
    let mut stmt = conn.prepare(
        &failure_family_sql(),
    ).ok()?;
    let mut rows = stmt.query(rusqlite::params![start, end]).ok()?;
    let mut hours: BTreeMap<String, u64> = BTreeMap::new();
    // 与 token 柱同口径：统计时区墙钟小时（SQLite strftime '%H' localtime）。
    // 不用 (ms-start)/3600000 的流逝小时——DST 换日日两者会差一列（评审 P3）。
    let timezone = crate::authority_query::statistics_timezone();
    while let Some(row) = rows.next().ok()? {
        let opened_at_ms: i64 = row.get(0).ok()?;
        let hour = Timestamp::from_millisecond(opened_at_ms).ok()?
            .to_zoned(timezone.clone())
            .hour();
        *hours.entry(hour.to_string()).or_insert(0) += 1;
    }
    Some(json!({ "date": date, "hours": hours }))
}

/// 趋势图「本周 / 本月」档的失败日聚合（OVERVIEW_TREND_RANGE_SPEC §2.2）：
/// `[from, to]`（含两端的统计日）内失败族 issue 按统计时区**墙钟日期**计数。
/// 返回 `{"from","to","days": {"2026-09-15": 3}}`；无数据日不出键。
///
/// `None` = 读不到（日期非法 / `from > to` / 跨度 > 62 天 / 查询失败），与
/// 「合法空窗 → 空 days（读到零失败）」严格区分——前端据此走「失败标记不可用」，
/// 不画假零。规则族与计数语义和 `failure_hours_day` 完全一致（共用
/// `failure_family_sql`）；日归属用墙钟日期而非 `(ms-start)/86400000`，DST 换日日
/// 两者会差一天。
pub fn failure_days_range(conn: &rusqlite::Connection, from: &str, to: &str) -> Option<Value> {
    let (start, _) = crate::authority_query::beijing_day_bounds_ms(from)?;
    let (_, end) = crate::authority_query::beijing_day_bounds_ms(to)?;
    let from_date: jiff::civil::Date = from.parse().ok()?;
    let to_date: jiff::civil::Date = to.parse().ok()?;
    if from_date > to_date { return None; }
    let span_days = (to_date - from_date).get_days();
    if span_days > 62 { return None; }
    let mut stmt = conn.prepare(&failure_family_sql()).ok()?;
    let mut rows = stmt.query(rusqlite::params![start, end]).ok()?;
    let mut days: BTreeMap<String, u64> = BTreeMap::new();
    let timezone = crate::authority_query::statistics_timezone();
    while let Some(row) = rows.next().ok()? {
        let opened_at_ms: i64 = row.get(0).ok()?;
        let day = Timestamp::from_millisecond(opened_at_ms).ok()?
            .to_zoned(timezone.clone())
            .date();
        *days.entry(day.to_string()).or_insert(0) += 1;
    }
    Some(json!({ "from": from, "to": to, "days": days }))
}

/// 以 `to` 为终点、向前回溯 `back_days` 天的失败日聚合（快照用：回溯 30 天一定覆盖
/// 「本月 1 日起」与「本周周一起」，调用方不必自己做日期运算、桌面 crate 也不必直接
/// 依赖 jiff）。`to` 非法 → `None`。
pub fn failure_days_trailing(conn: &rusqlite::Connection, to: &str, back_days: i64) -> Option<Value> {
    let to_date: jiff::civil::Date = to.parse().ok()?;
    let from = to_date.checked_sub(jiff::Span::new().days(back_days)).ok()?;
    failure_days_range(conn, &from.to_string(), to)
}

pub fn remedy_for(issue_type: &str) -> RemedyCandidate {
    match issue_type {
        "retry_loop" => RemedyCandidate { remedy_id: "inspect-retry-policy", diagnostic_only: false },
        "context_overflow" => RemedyCandidate { remedy_id: "reduce-context-window", diagnostic_only: false },
        "tool_failure" => RemedyCandidate { remedy_id: "inspect-tool-error", diagnostic_only: false },
        // family ① 行为规则（SV601–SV610）各配专属 remedy_id
        // （WORKBENCH_FINDINGS_TAB_SPEC §5.1）。专属 ID 给的是「下一步看哪里」的
        // 诚实短语，不是可一键完成的工单 —— 行为命中没有「解决」语义，只有
        // 「采纳与否」的决策语义（spec §8），因此这些组仍不进工作台待办区。
        "SV601" => RemedyCandidate { remedy_id: "review-destructive-shell", diagnostic_only: false },
        "SV602" => RemedyCandidate { remedy_id: "review-privilege-shell", diagnostic_only: false },
        "SV603" => RemedyCandidate { remedy_id: "review-remote-exec", diagnostic_only: false },
        "SV604" => RemedyCandidate { remedy_id: "review-sensitive-path", diagnostic_only: false },
        "SV605" => RemedyCandidate { remedy_id: "narrow-write-scope", diagnostic_only: false },
        "SV606" => RemedyCandidate { remedy_id: "review-external-fetch", diagnostic_only: false },
        "SV607" => RemedyCandidate { remedy_id: "reduce-limit-pressure", diagnostic_only: false },
        "SV608" => RemedyCandidate { remedy_id: "inspect-timeout-tool", diagnostic_only: false },
        "SV609" => RemedyCandidate { remedy_id: "review-approval-choice", diagnostic_only: false },
        "SV610" => RemedyCandidate { remedy_id: "tighten-sandbox-mode", diagnostic_only: false },
        // family ② Trust/Egress rules are review guidance, never automatic
        // remediation. Nothing in an Observation authorizes killing a process,
        // deleting a snapshot, changing a vendor setting, or blocking a harness.
        "SV701" => RemedyCandidate { remedy_id: "review-workspace-scope", diagnostic_only: false },
        "SV702" => RemedyCandidate { remedy_id: "review-repository-history-scope", diagnostic_only: false },
        "SV703" => RemedyCandidate { remedy_id: "review-secondary-session-reporting", diagnostic_only: false },
        "SV704" => RemedyCandidate { remedy_id: "review-tool-payload-egress", diagnostic_only: false },
        "SV705" => RemedyCandidate { remedy_id: "review-consent-control-mismatch", diagnostic_only: false },
        "SV706" => RemedyCandidate { remedy_id: "review-background-audit-surface", diagnostic_only: false },
        "SV707" => RemedyCandidate { remedy_id: "review-pending-retry-retention", diagnostic_only: false },
        "SV708" => RemedyCandidate { remedy_id: "review-remote-egress-control", diagnostic_only: false },
        "SV709" => RemedyCandidate { remedy_id: "review-object-storage-egress", diagnostic_only: false },
        "SV710" => RemedyCandidate { remedy_id: "review-declared-exclusions", diagnostic_only: false },
        // 会话消耗诊断（SESSION_TRACE_DIAGNOSTICS_SPEC §7.5）：诊断不落 issue 表，
        // 但 remedy_id 与 Findings 共用这一份目录（`query::session_insights` 的测试
        // 钉住 domain 产出的 remedy_id 与这里一致）。
        "high_uncached_input" => RemedyCandidate { remedy_id: "inspect-uncached-input", diagnostic_only: false },
        "input_growth" => RemedyCandidate { remedy_id: "review-context-growth", diagnostic_only: false },
        "repeated_failure" => RemedyCandidate { remedy_id: "inspect-repeated-failure", diagnostic_only: false },
        _ => RemedyCandidate { remedy_id: "diagnostic-only", diagnostic_only: true },
    }
}

pub fn stable_issue_id(input: &IssueInput<'_>) -> String {
    stable_hash(&format!(
        "{}\0{}\0{}",
        input.machine_namespace, input.issue_type, input.instance_fingerprint
    ))
}

/// Idempotently creates or refreshes a stable Issue row. Status transitions are
/// deliberately handled by `transition_issue`, never inferred from upsert time.
pub fn upsert_issue(conn: &Connection, input: &IssueInput<'_>) -> rusqlite::Result<String> {
    if input.status != "open" {
        return Err(rusqlite::Error::InvalidParameterName(
            "new_issue_must_start_open".to_string(),
        ));
    }
    let issue_id = stable_issue_id(input);
    conn.execute(
        "INSERT INTO issue_instances(
           issue_id, machine_namespace, harness, session_key, issue_type,
           instance_fingerprint, status, severity, evaluator_id, evaluator_version,
           evidence_fingerprint, opened_at_ms, metadata_json)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(machine_namespace, issue_type, instance_fingerprint) DO UPDATE SET
           harness=excluded.harness, session_key=excluded.session_key,
           severity=excluded.severity, evaluator_id=excluded.evaluator_id,
           evaluator_version=excluded.evaluator_version,
           evidence_fingerprint=excluded.evidence_fingerprint,
           metadata_json=excluded.metadata_json",
        rusqlite::params![
            issue_id,
            input.machine_namespace,
            input.harness,
            input.session_key,
            input.issue_type,
            input.instance_fingerprint,
            input.status,
            input.severity,
            input.evaluator_id,
            input.evaluator_version,
            input.evidence_fingerprint,
            input.opened_at_ms,
            input.metadata_json,
        ],
    )?;
    Ok(issue_id)
}

#[allow(clippy::too_many_arguments)]
pub fn transition_issue(
    conn: &Connection,
    issue_id: &str,
    to_status: &str,
    transitioned_at_ms: i64,
    reason: &str,
    actor: &str,
    evidence_fingerprint: &str,
    evaluator_id: &str,
    evaluator_version: &str,
    input_fingerprint: &str,
) -> rusqlite::Result<String> {
    // Callers must invoke this function inside AuthorityDb::with_immediate_txn;
    // the transition insert and current-row update are one atomic unit.
    let from_status: Option<String> = conn
        .query_row(
            "SELECT status FROM issue_instances WHERE issue_id = ?1",
            [issue_id],
            |row| row.get(0),
        )
        .optional()?;
    let from_status = from_status.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;
    let transition_id = stable_hash(&format!(
        "{}\0{}\0{}\0{}\0{}\0{}\0{}",
        issue_id,
        from_status,
        to_status,
        evidence_fingerprint,
        evaluator_id,
        evaluator_version,
        input_fingerprint
    ));
    let existing_transition: Option<String> = conn
        .query_row(
            "SELECT transition_id FROM issue_status_transitions
             WHERE issue_id = ?1 AND to_status = ?2 AND evidence_fingerprint = ?3
               AND evaluator_id = ?4 AND evaluator_version = ?5 AND input_fingerprint = ?6",
            rusqlite::params![
                issue_id,
                to_status,
                evidence_fingerprint,
                evaluator_id,
                evaluator_version,
                input_fingerprint
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(existing) = existing_transition {
        return Ok(existing);
    }
    if !valid_transition(&from_status, to_status) {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "invalid_issue_transition:{from_status}->{to_status}"
        )));
    }
    conn.execute(
        "INSERT OR IGNORE INTO issue_status_transitions(
           transition_id, issue_id, from_status, to_status, transitioned_at_ms,
           reason, actor, evidence_fingerprint, evaluator_id, evaluator_version, input_fingerprint)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        rusqlite::params![
            transition_id,
            issue_id,
            from_status,
            to_status,
            transitioned_at_ms,
            reason,
            actor,
            evidence_fingerprint,
            evaluator_id,
            evaluator_version,
            input_fingerprint,
        ],
    )?;
    conn.execute(
        "UPDATE issue_instances SET status = ?2, closed_at_ms =
           CASE WHEN ?2 IN ('closed','wontfix','resolved','not_applicable') THEN COALESCE(closed_at_ms, ?3) ELSE NULL END
         WHERE issue_id = ?1",
        rusqlite::params![issue_id, to_status, transitioned_at_ms],
    )?;
    Ok(transition_id)
}

fn valid_transition(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("open", "acknowledged")
            | ("open", "later")
            | ("open", "closed")
            | ("open", "wontfix")
            | ("open", "resolved")
            | ("open", "not_applicable")
            | ("later", "open")
            | ("later", "acknowledged")
            | ("later", "closed")
            | ("later", "wontfix")
            | ("later", "resolved")
            | ("later", "not_applicable")
            | ("acknowledged", "closed")
            | ("acknowledged", "later")
            | ("acknowledged", "wontfix")
            | ("acknowledged", "resolved")
            | ("acknowledged", "not_applicable")
            | ("acknowledged", "open")
            | ("closed", "open")
            | ("wontfix", "open")
            | ("resolved", "open")
            | ("not_applicable", "open")
    )
}

fn stable_hash(value: &str) -> String {
    format!(
        "fnv1a64:{}",
        agent_vitals_domain::source_identity::fnv1a64_hex(value.as_bytes())
    )
}

/// Normalize the object part of a finding without merging different issue
/// families. This is intentionally pure: it is also used by the group key and
/// therefore must not depend on database state or presentation labels.
pub fn normalize_issue_object(issue_type: &str, object: &str) -> String {
    let object = object.trim();
    match issue_type {
        "SV601" | "SV602" | "SV603" | "retry_loop" | "tool_failure" =>
            object.split_whitespace().next().unwrap_or(object).to_string(),
        "SV604" | "SV605" => {
            if object.starts_with("/ingest/export/") {
                "/ingest/export/*".to_string()
            } else if let Some((parent, _)) = object.rsplit_once('/') {
                format!("{parent}/*")
            } else {
                format!("{object}/*")
            }
        }
        "SV611" => normalize_repetition_description(object),
        "SV613" => normalize_failure_stall_description(object),
        "SV614" => normalize_permission_description(object),
        _ => object.to_string(),
    }
}

fn normalize_repetition_description(object: &str) -> String {
    if let Some((prefix, _)) = object.split_once("连续重复") {
        format!("{prefix}连续重复")
    } else {
        object.to_string()
    }
}

fn normalize_failure_stall_description(object: &str) -> String {
    if object.starts_with("进度停滞:") {
        "进度停滞: 连续工具失败".to_string()
    } else {
        object.to_string()
    }
}

fn normalize_permission_description(object: &str) -> String {
    if let Some((prefix, _)) = object.split_once("授予") {
        format!("{prefix}授予")
    } else {
        object.to_string()
    }
}

fn issue_object(issue_type: &str, fingerprint: &str, metadata: &Value) -> String {
    fingerprint
        .split('\0')
        .nth(3)
        .or_else(|| metadata.get("tool_name").and_then(Value::as_str))
        .or_else(|| metadata.get("evidence").and_then(Value::as_str))
        .unwrap_or("<unknown>")
        .pipe(|object| normalize_issue_object(issue_type, object))
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T { f(self) }
}
impl<T> Pipe for T {}

fn issue_day_bucket(opened_at_ms: i64) -> String {
    Timestamp::from_millisecond(opened_at_ms)
        .ok()
        .map(|timestamp| {
            let date = timestamp.to_zoned(crate::authority_query::statistics_timezone()).date();
            format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
        })
        .unwrap_or_else(|| {
            agent_vitals_domain::usage::civil_date_from_days(opened_at_ms.div_euclid(DAY_MS))
        })
}

fn issue_group_key(issue_type: &str, harness: &str, fingerprint: &str, opened_at_ms: i64, metadata: &Value) -> String {
    let object = issue_object(issue_type, fingerprint, metadata);
    let evidence_class = metadata.get("category").and_then(Value::as_str)
        .or_else(|| metadata.get("evidence").and_then(Value::as_str))
        .unwrap_or("<unknown>");
    format!("{issue_type}\0{harness}\0{object}\0{evidence_class}\0{}", issue_day_bucket(opened_at_ms))
}

fn issue_evidence_class(metadata: &Value) -> String {
    metadata.get("category").and_then(Value::as_str)
        .or_else(|| metadata.get("evidence").and_then(Value::as_str))
        .unwrap_or("<unknown>").to_string()
}

fn redact_issue_sample_metadata(metadata: &Value) -> Value {
    let mut sanitized = metadata.clone();
    if let Some(object) = sanitized.as_object_mut() {
        for key in ["evidence", "path", "file_path", "source_path"] {
            if let Some(value) = object.get_mut(key) {
                if let Some(text) = value.as_str() {
                    if text.starts_with('/') || text.contains('/') || text.contains('\\') {
                        *value = json!("<redacted-path>");
                    }
                }
            }
        }
    }
    sanitized
}

#[derive(Default)]
struct IssueGroupAccum {
    rule: String,
    harness: String,
    object: String,
    evidence_class: String,
    bucket: String,
    count: usize,
    first_seen_at_ms: i64,
    last_seen_at_ms: i64,
    severity: String,
    status_rollup: [usize; 5],
    sessions: std::collections::BTreeSet<String>,
    sample_evidence: Vec<Value>,
    remedy: RemedyCandidate,
}

fn severity_rank(value: &str) -> u8 {
    match value { "critical" => 3, "warning" => 2, "info" => 1, _ => 0 }
}

fn status_index(value: &str) -> usize {
    match value { "later" => 1, "acknowledged" => 2, "closed" | "resolved" => 3,
        "wontfix" | "not_applicable" => 4, _ => 0 }
}

#[allow(clippy::too_many_arguments)]
fn projection_group(
    source_kind: &str,
    rule: &str,
    harness: &str,
    object: &str,
    evidence_class: &str,
    opened_at_ms: i64,
    count: usize,
    severity: &str,
    status: &str,
    sample: Value,
    remedy_id: &'static str,
) -> Value {
    let group_key = format!("{source_kind}\0{rule}\0{harness}\0{object}\0{evidence_class}\0{}", issue_day_bucket(opened_at_ms));
    let mut rollup = json!({"open": 0, "later": 0, "acknowledged": 0, "resolved": 0, "not_applicable": 0});
    let status_key = match status {
        "pending" | "open" => "open",
        "closed" | "resolved" => "resolved",
        "wontfix" | "not_applicable" => "not_applicable",
        other => other,
    };
    if let Some(slot) = rollup.get_mut(status_key) { *slot = json!(count); }
    json!({
        "group_id": stable_hash(&group_key), "source_kind": source_kind, "rule": rule,
        "harness": harness, "object": object, "evidence_class": evidence_class,
        "bucket": issue_day_bucket(opened_at_ms), "count": count,
        "first_seen_at_ms": opened_at_ms, "last_seen_at_ms": opened_at_ms,
        "severity": severity, "status_rollup": rollup, "sessions_count": 0,
        "sample_evidence": [sample],
        "remedy": {"remedy_id": remedy_id, "diagnostic_only": true},
        "actionability": if severity == "critical" { 1.0 } else if severity == "warning" { 0.7 } else { 0.4 },
        "time": opened_at_ms, "evidence": evidence_class, "tool_name": object,
        "category": evidence_class, "hits": count, "sessions": 0,
    })
}

/// Merge rows from a read-only source projection using the same deterministic
/// `group_id` generated by `projection_group`.  Source tables keep their own
/// authority and identity; only the L0 presentation is collapsed here.
fn merge_projection_group(existing: &mut Value, incoming: Value) {
    let count = existing["count"].as_u64().unwrap_or(0)
        .saturating_add(incoming["count"].as_u64().unwrap_or(0));
    existing["count"] = json!(count);
    existing["hits"] = json!(count);
    let first = existing["first_seen_at_ms"].as_i64().unwrap_or(i64::MAX)
        .min(incoming["first_seen_at_ms"].as_i64().unwrap_or(i64::MAX));
    let last = existing["last_seen_at_ms"].as_i64().unwrap_or(i64::MIN)
        .max(incoming["last_seen_at_ms"].as_i64().unwrap_or(i64::MIN));
    existing["first_seen_at_ms"] = json!(first);
    existing["last_seen_at_ms"] = json!(last);
    if severity_rank(incoming["severity"].as_str().unwrap_or(""))
        > severity_rank(existing["severity"].as_str().unwrap_or(""))
    {
        let severity = incoming["severity"].clone();
        existing["severity"] = severity;
        existing["actionability"] = json!(if existing["severity"] == "critical" { 1.0 }
            else if existing["severity"] == "warning" { 0.7 } else { 0.4 });
    }
    for status in ["open", "later", "acknowledged", "resolved", "not_applicable"] {
        let total = existing["status_rollup"][status].as_u64().unwrap_or(0)
            .saturating_add(incoming["status_rollup"][status].as_u64().unwrap_or(0));
        existing["status_rollup"][status] = json!(total);
    }
    let sessions = existing["sessions"].as_u64().unwrap_or(0)
        .saturating_add(incoming["sessions"].as_u64().unwrap_or(0));
    existing["sessions"] = json!(sessions);
    existing["sessions_count"] = json!(sessions);
    if let (Some(target), Some(samples)) = (
        existing["sample_evidence"].as_array_mut(),
        incoming["sample_evidence"].as_array(),
    ) {
        for sample in samples {
            if target.len() >= 3 { break; }
            target.push(sample.clone());
        }
    }
}

fn merge_projection_groups(values: Vec<Value>) -> Vec<Value> {
    let mut grouped = std::collections::BTreeMap::<String, Value>::new();
    for value in values {
        let key = value["group_id"].as_str().unwrap_or("<unknown>").to_string();
        if let Some(existing) = grouped.get_mut(&key) {
            merge_projection_group(existing, value);
        } else {
            grouped.insert(key, value);
        }
    }
    grouped.into_values().collect()
}

/// 额度窗口耗尽 → 「待处理」里的一条任务；窗口重置或不再有耗尽证据 → 自动解决。
///
/// **这是一条会自己消失的任务**：同一次调用里，`exhausted = None` 就把
/// `resolved_at_ms` 写上（行保留，历史不丢），任务从待处理列表消失。
///
/// 措辞取中性 warning：被限流不是数据缺陷（REQ-062——只有数据丢失/解析失败/
/// 明确超预算才进 danger 语气）。
///
/// 幂等键是 `(scope_type='harness', scope_key=harness, code)`：同一执行环境同一时刻只可能
/// 有一条这样的任务，重复同步只刷新 `last_seen_at_ms`。
pub fn reconcile_quota_window_issue(
    conn: &Connection,
    harness: &str,
    exhausted: Option<(i64, &str, &str)>, // (resets_at 秒, window, window_label)
    now_ms: i64,
) -> rusqlite::Result<()> {
    const CODE: &str = "quota_window_exhausted";
    match exhausted {
        Some((resets_at, window, window_label)) => {
            let detail = json!({
                "harness": harness,
                "window": window,
                "window_label": window_label,
                "resets_at": resets_at,
            });
            conn.execute(
                "INSERT INTO data_quality_issues(
                     issue_id, scope_type, scope_key, code, severity,
                     first_seen_at_ms, last_seen_at_ms, resolved_at_ms, detail_json)
                 VALUES (?1, 'harness', ?2, ?3, 'warning', ?4, ?4, NULL, ?5)
                 ON CONFLICT(scope_type, scope_key, code) DO UPDATE SET
                     last_seen_at_ms = excluded.last_seen_at_ms,
                     resolved_at_ms = NULL,
                     detail_json = excluded.detail_json",
                rusqlite::params![
                    format!("quota-window:{harness}"),
                    harness,
                    CODE,
                    now_ms,
                    detail.to_string(),
                ],
            )?;
        }
        None => {
            conn.execute(
                "UPDATE data_quality_issues SET resolved_at_ms = ?3
                 WHERE scope_type = 'harness' AND scope_key = ?1 AND code = ?2
                   AND resolved_at_ms IS NULL",
                rusqlite::params![harness, CODE, now_ms],
            )?;
        }
    }
    Ok(())
}

/// 「待处理」的分组投影：读未解决的 `data_quality_issues`，按 (来源, 规则, 执行环境,
/// 对象) 归组。**公开**是因为断言它的接线契约（哪个 code 归到哪条规则、object
/// 取哪个字段）需要在跨 crate 的测试里直接验证——那是本模块对外的主要合同。
pub fn source_issue_groups(
    conn: &Connection,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
) -> rusqlite::Result<Vec<Value>> {
    let mut values = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT issue_id, scope_type, scope_key, code, severity,
                first_seen_at_ms, last_seen_at_ms, detail_json
         FROM data_quality_issues WHERE resolved_at_ms IS NULL
         ORDER BY issue_id",
    )?;
    let rows = stmt.query_map([], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
        r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, i64>(5)?,
        r.get::<_, i64>(6)?, r.get::<_, String>(7)?,
    )))?;
    for row in rows {
        let (issue_id, scope_type, _scope_key, code, severity, first, last, detail_raw) = row?;
        if to_ms.is_some_and(|to| first >= to) || from_ms.is_some_and(|from| last < from) { continue; }
        let detail = serde_json::from_str::<Value>(&detail_raw).unwrap_or_else(|_| json!({}));
        let harness = detail.get("harness").and_then(Value::as_str).unwrap_or("<unknown>");
        let rule = if code.contains("route") {
            // 「路由待确认」：本地用量归属没定下来（REQ-074 四类之一）。与缺价分开——
            // 一个要"确认计费方式"，一个要"补价卡"，合成一条用户不知道做什么。
            "ROUTE_UNCONFIRMED"
        } else if code.contains("quota") {
            // 额度窗口类（Claude Pro 的 5 小时/7 天窗耗尽）。它既不是缺价、也不是
            // 数据源故障——单独一类，前端标签「额度窗口」。
            "QUOTA_WINDOW"
        } else if code.contains("price") || code.contains("pricing") || code.contains("unpriced") {
            "PRICE_COVERAGE"
        } else if code.contains("source") || code.contains("permission") || code.contains("parse") || code.contains("read") {
            "DATA_SOURCE_FAILURE"
        } else { "DATA_QUALITY" };
        // scope_key may be `attribution_conflict:<fact_id>` or another
        // per-fact identity.  It is useful in the sample, but must not become
        // the L0 object key or one noisy quality code would create one group
        // per fact.  Prefer stable attribution dimensions and fall back to the
        // quality code itself when the source has no finer evidence.
        // `model_id` 排在最前：当一条问题的主体就是"某个模型"（无价卡）时，
        // 模型比服务商更identifying。只有本地价格发现会写这个字段。
        let object = detail.get("model_id").and_then(Value::as_str)
            .or_else(|| detail.get("provider_id").and_then(Value::as_str))
            .or_else(|| detail.get("billing_mode").and_then(Value::as_str))
            // 额度窗口自带人类标签（"5 小时窗口"）：卡面直接渲染 object，raw code
            // 绝不能端上去（总览规格 §4 第 84 行同一条纪律）。
            .or_else(|| detail.get("window_label").and_then(Value::as_str))
            .unwrap_or(&code);
        values.push(projection_group("data_quality", rule, harness, object, &code,
            first, 1, &severity, "open", json!({"issue_id": issue_id, "scope_type": scope_type, "code": code, "detail": detail}), "diagnostic-only"));
    }

    let mut stmt = conn.prepare(
        "SELECT candidate_id, harness, provider_id, currency, amount_minor,
                billing_period_start, status, created_at_ms
         FROM billing_import_candidates WHERE status = 'pending'
         ORDER BY candidate_id",
    )?;
    let rows = stmt.query_map([], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
        r.get::<_, String>(3)?, r.get::<_, i64>(4)?, r.get::<_, String>(5)?,
        r.get::<_, String>(6)?, r.get::<_, i64>(7)?,
    )))?;
    for row in rows {
        let (candidate_id, harness, provider, currency, amount, period, status, created) = row?;
        if to_ms.is_some_and(|to| created >= to) || from_ms.is_some_and(|from| created < from) { continue; }
        values.push(projection_group("billing_candidate", "BILLING_CONFIRMATION", &harness,
            &format!("{provider}:{period}"), &currency, created, 1, "warning", &status,
            json!({"candidate_id": candidate_id, "provider_id": provider, "currency": currency,
                "amount_minor": amount, "billing_period_start": period, "is_bill": false}), "diagnostic-only"));
    }

    // 「仍不确定 / 稍后」之后用户要能从待处理找回（AC28）：没有旧资产候选、只有
    // 按量估算的待确认组也必须投影出来。组的定义与总览面板同一条 SQL
    // （`authority_query::SQL_UNRESOLVED_BILLING_GROUPS`），对象键 = provider:model，
    // 同对象同原因在 `merge_projection_groups` 里去重。
    for row in crate::authority_query::unresolved_billing_group_rows(
        conn, from_ms.unwrap_or(i64::MIN), to_ms.unwrap_or(i64::MAX),
    )? {
        values.push(projection_group("billing_group", "BILLING_CONFIRMATION", &row.harness,
            &format!("{}:{}", row.provider_id, row.model_id), &row.evidence_basis,
            row.first_event_at_ms, 1, "warning", "open",
            json!({"provider_id": row.provider_id, "model_id": row.model_id,
                "evidence_basis": row.evidence_basis, "pricing_basis": row.pricing_basis,
                "tokens": row.tokens, "session_count": row.session_count,
                "first_event_at_ms": row.first_event_at_ms, "last_event_at_ms": row.last_event_at_ms,
                "is_bill": false}), "diagnostic-only"));
    }

    let mut stmt = conn.prepare(
        "SELECT source_id, harness, last_error_code, last_seen_at_ms
         FROM source_files WHERE last_error_code IS NOT NULL ORDER BY source_id",
    )?;
    let rows = stmt.query_map([], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?,
    )))?;
    for row in rows {
        let (source_id, harness, error, seen) = row?;
        if to_ms.is_some_and(|to| seen >= to) || from_ms.is_some_and(|from| seen < from) { continue; }
        values.push(projection_group("source_failure", "DATA_SOURCE_FAILURE", &harness, &error,
            "source_file", seen, 1, "warning", "open", json!({"source_id": source_id, "error_code": error}), "diagnostic-only"));
    }
    Ok(merge_projection_groups(values))
}

fn usage_growth_groups(conn: &Connection) -> rusqlite::Result<Vec<Value>> {
    type UsageGrowthScope = (String, String, String);
    type UsageGrowthDay = (i64, i64, i64);

    let query = format!(
        "SELECT harness, COALESCE(provider_id, '<unknown>'),
                COALESCE(billing_mode, '<unknown>'),
                {LOCAL_DAY_IDX_SQL} AS day_idx,
                SUM(uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens),
                MAX(event_ts_ms)
         FROM usage_facts
         WHERE deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
           AND observation_kind != 'legacy_aggregate'
         GROUP BY harness, provider_id, billing_mode, day_idx
         ORDER BY harness, provider_id, billing_mode, day_idx"
    );
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map([], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
        r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?,
    )))?;
    let mut by_scope: std::collections::BTreeMap<UsageGrowthScope, Vec<UsageGrowthDay>> = std::collections::BTreeMap::new();
    for row in rows {
        let (harness, provider, mode, day, tokens, last_event_ms) = row?;
        by_scope.entry((harness, provider, mode)).or_default().push((day, tokens, last_event_ms));
    }
    let mut values = Vec::new();
    for ((harness, provider, mode), days) in by_scope {
        if days.len() < 8 { continue; }
        let observed = days[days.len() - 1];
        let baseline: Vec<i64> = days[days.len() - 8..days.len() - 1].iter().map(|(_, n, _)| *n).collect();
        let mut ordered = baseline.clone();
        ordered.sort_unstable();
        let median = ordered[ordered.len() / 2];
        if median <= 0 || observed.1 < median.saturating_mul(2) { continue; }
        let bucket = agent_vitals_domain::usage::civil_date_from_days(observed.0);
        let key = format!("usage-growth\0{harness}\0{provider}\0{mode}\0{bucket}");
        values.push(json!({
            "group_id": stable_hash(&key), "source_kind": "usage_growth",
            "rule": "USAGE_GROWTH", "harness": harness, "object": provider,
            "evidence_class": mode, "bucket": bucket, "count": 1,
            "first_seen_at_ms": observed.2,
            "last_seen_at_ms": observed.2,
            "severity": "warning", "status_rollup": {"open": 1, "later": 0,
                "acknowledged": 0, "resolved": 0, "not_applicable": 0},
            "sessions_count": 0, "sample_evidence": [{"provider_id": provider,
                "billing_mode": mode, "observed_tokens": observed.1,
                "baseline_median_tokens": median, "baseline_days": 7,
                "comparison_range": "previous_7_valid_days", "coverage": "complete",
                "threshold_ratio_bp": 20000}],
            "remedy": {"remedy_id": "inspect-usage-change", "diagnostic_only": true},
            "actionability": 0.75, "time": observed.2,
            "evidence": mode, "tool_name": provider, "category": "usage-growth",
            "hits": 1, "sessions": 0, "read_only": true
        }));
    }
    Ok(values)
}

/// Unified read-only projection across behavior issues and authority-source
/// problems. Source families remain distinguishable via `source_kind`.
/// V17 探针判定的 findings 回流（WORKBENCH_TEST_TAB_SPEC §11-P2）：把
/// `confirmed_mismatch` / `suspected_degradation` 级判定投影成 source_kind=
/// `probe` 的组。`no_signal`/`underpowered`/`inconclusive_confounded` 是"干净
/// 结果"不是 finding——不进待处理面。投影只读不写 issue_instances（判定事实
/// 在 probe_verdicts；可关闭状态机是 P3 接线——本投影的组与 usage_growth
/// 同为"读面证据"性质）。
///
/// 复审修订：① 按 (verdict, harness, 路线对, 日桶) 聚合——同日同组合的多次判定
/// 并成一组（count 累计），否则同 group_id 重复组会撑爆待处理面；② 尊重
/// from_ms/to_ms 窗口（与 source_issue_groups 同纪律，旧判定会过期）；③ 成对
/// run 的 object 同时携带 A↔B 双方标签（mismatch 可能是 B 侧——只挂 A 是
/// 错误归因）；④ sample 从**嵌套**证据链取（runner 存的是 combine 产物：
/// 外层 chain 的每个条目是单报告，身份证据在其内层 evidence_chain_json[0]）。
pub fn probe_verdict_groups(
    conn: &Connection,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT v.verdict, v.decided_at_ms, v.rule_version, v.evidence_chain_json,
                r.run_id, r.mode, r.route_a_id, r.route_b_id
         FROM probe_verdicts v
         JOIN probe_runs r ON r.run_id = v.run_id
         WHERE v.verdict IN ('confirmed_mismatch','suspected_degradation')
         ORDER BY v.decided_at_ms DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?,
            row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
            row.get::<_, String>(6)?, row.get::<_, Option<String>>(7)?,
        ))
    })?;
    // 路线标签缓存（route_a/b 各查一次）。
    let label_of = |conn: &Connection, route_id: &str| -> String {
        conn.query_row(
            "SELECT label FROM probe_routes WHERE route_id = ?1",
            rusqlite::params![route_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| route_id.to_string())
    };
    let harness_of = |conn: &Connection, route_id: &str| -> String {
        conn.query_row(
            "SELECT harness_kind FROM probe_routes WHERE route_id = ?1",
            rusqlite::params![route_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "claude-code".to_string())
    };
    // (verdict, harness, object, bucket) → (首见, 末见, count, sample)。
    type ProbeAccum = std::collections::BTreeMap<
        (String, String, String, String),
        (i64, i64, usize, Value),
    >;
    let mut accum = ProbeAccum::new();
    for row in rows {
        let (verdict, decided_at, rule_version, evidence_raw, run_id, mode, route_a, route_b) = row?;
        if let Some(from) = from_ms {
            if decided_at < from {
                continue;
            }
        }
        if let Some(to) = to_ms {
            if decided_at >= to {
                continue;
            }
        }
        let label_a = label_of(conn, &route_a);
        let (harness, object) = match &route_b {
            Some(route_b_id) => {
                let label_b = label_of(conn, route_b_id);
                (harness_of(conn, &route_a), format!("{label_a}↔{label_b}"))
            }
            None => (harness_of(conn, &route_a), label_a),
        };
        let evidence: Value = serde_json::from_str(&evidence_raw).unwrap_or_else(|_| json!([]));
        // 嵌套链：外层条目是单报告，身份证据在内层 chain[0]（复审 F2——
        // 顶层没有 requested/resolved，扁平读取恒 null 是假绿测试的根源）。
        let identity = evidence
            .as_array()
            .and_then(|reports| reports.first())
            .and_then(|report| report.get("evidence_chain_json"))
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .cloned()
            .unwrap_or(json!({}));
        let sample = json!({
            "run_id": run_id, "verdict": verdict, "rule_version": rule_version,
            "route_a": object, "mode": mode,
            "requested": identity.get("requested").cloned().unwrap_or(Value::Null),
            "resolved": identity.get("resolved").cloned().unwrap_or(Value::Null),
        });
        let key = (
            verdict.clone(),
            harness.clone(),
            object.clone(),
            issue_day_bucket(decided_at),
        );
        let entry = accum.entry(key).or_insert((
            decided_at, decided_at, 0, sample,
        ));
        entry.0 = entry.0.min(decided_at);
        entry.1 = entry.1.max(decided_at);
        entry.2 += 1;
    }
    let mut groups = Vec::new();
    for ((verdict, harness, object, _bucket), (first, last, count, sample)) in accum {
        let severity = if verdict == "confirmed_mismatch" { "critical" } else { "warning" };
        groups.push(projection_group(
            "probe", &verdict, &harness, &object, "model_identity",
            last, count, severity, "pending", sample, "diagnostic-only",
        ));
        // 首见时刻单独放回（projection_group 只收一个时刻）。
        if let Some(group) = groups.last_mut() {
            group["first_seen_at_ms"] = json!(first);
        }
    }
    Ok(groups)
}

pub fn issue_groups_with_sources(
    conn: &Connection,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    page_size: usize,
    cursor: Option<&str>,
) -> rusqlite::Result<Value> {
    let behavior = issue_groups(conn, from_ms, to_ms, usize::MAX, None)?;
    let mut groups = behavior["groups"].as_array().cloned().unwrap_or_default();
    groups.extend(source_issue_groups(conn, from_ms, to_ms)?);
    groups.extend(usage_growth_groups(conn)?);
    groups.extend(probe_verdict_groups(conn, from_ms, to_ms)?);
    groups.sort_by(|a, b| b["actionability"].as_f64().partial_cmp(&a["actionability"].as_f64()).unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| a["group_id"].as_str().cmp(&b["group_id"].as_str())));
    let mut critical = 0u64;
    let mut warning = 0u64;
    let mut info = 0u64;
    let mut sessions = 0u64;
    let mut rules: BTreeMap<String, (String, String, u64, u64)> = BTreeMap::new();
    for group in &groups {
        match group["severity"].as_str().unwrap_or("unknown") {
            "critical" => critical = critical.saturating_add(1),
            "warning" => warning = warning.saturating_add(1),
            "info" => info = info.saturating_add(1),
            _ => {}
        }
        sessions = sessions.saturating_add(group["sessions_count"].as_u64().unwrap_or(0));
        let rule = group["rule"].as_str().unwrap_or("OTHER").to_string();
        let severity = group["severity"].as_str().unwrap_or("unknown").to_string();
        let source_kind = group["source_kind"].as_str().unwrap_or("behavior");
        let category = if rule.starts_with("SV") { "behavior" } else { match source_kind {
            "billing_candidate" | "billing_group" => "billing",
            "budget" => "budget", "source_failure" => "source", "usage_growth" => "usage",
            "probe" => "probe", _ => "other",
        }}.to_string();
        let entry = rules.entry(rule).or_insert((severity.clone(), category, 0, 0));
        entry.2 = entry.2.saturating_add(group["count"].as_u64().unwrap_or(0));
        entry.3 = entry.3.saturating_add(group["sessions_count"].as_u64().unwrap_or(0));
        if severity == "critical" { entry.0 = severity; }
    }
    let summary_rules: Vec<Value> = rules.into_iter().map(|(rule, (severity, category, hits, group_sessions))| json!({
        "rule": rule, "severity": severity, "category": category, "hits": hits, "sessions": group_sessions
    })).collect();
    let offset = cursor.and_then(|v| v.parse::<usize>().ok()).unwrap_or(0).min(groups.len());
    let limit = if page_size == usize::MAX { groups.len() } else { page_size.clamp(1, 500) };
    let end = offset.saturating_add(limit).min(groups.len());
    Ok(json!({"groups": groups[offset..end].to_vec(), "next_cursor": (end < groups.len()).then(|| end.to_string()),
        "total_groups": groups.len(), "source_issue_count": behavior["source_issue_count"].as_u64().unwrap_or(0),
        "source_projection_count": groups.len().saturating_sub(behavior["total_groups"].as_u64().unwrap_or(0) as usize),
        "summary_critical": critical, "summary_warning": warning, "summary_info": info,
        "summary_sessions": sessions, "summary_rules": summary_rules}))
}

/// Build a paginated L0 issue-group projection from the issue authority table.
/// Raw issue rows remain untouched and are only sampled here; L1/L2 can use the
/// returned `group_id` to fetch them later. `cursor` is a stable numeric offset
/// over the deterministic group ordering and is deliberately not a raw-row id.
pub fn issue_groups(
    conn: &Connection,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    page_size: usize,
    cursor: Option<&str>,
) -> rusqlite::Result<Value> {
    let mut sql = String::from(
        "SELECT issue_id, harness, session_key, issue_type, instance_fingerprint, status,
                severity, evidence_fingerprint, opened_at_ms, metadata_json
         FROM issue_instances WHERE 1=1",
    );
    if from_ms.is_some() { sql.push_str(" AND opened_at_ms >= ?1"); }
    if to_ms.is_some() { sql.push_str(if from_ms.is_some() { " AND opened_at_ms < ?2" } else { " AND opened_at_ms < ?1" }); }
    sql.push_str(" ORDER BY opened_at_ms, issue_id");
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<Option<i64>> = match (from_ms, to_ms) {
        (Some(from), Some(to)) => vec![Some(from), Some(to)],
        (Some(from), None) => vec![Some(from)],
        (None, Some(to)) => vec![Some(to)],
        (None, None) => vec![],
    };
    let mut groups: std::collections::BTreeMap<String, IssueGroupAccum> = std::collections::BTreeMap::new();
    let mut source_issue_count = 0usize;
    let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| {
        let metadata: String = r.get(9)?;
        Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?,
            r.get::<_, String>(6)?, r.get::<_, String>(7)?, r.get::<_, i64>(8)?, metadata,
        ))
    })?;
    for row in rows {
        source_issue_count += 1;
        let (issue_id, harness, session, rule, fingerprint, status, severity, evidence, opened, metadata_raw) = row?;
        let metadata = serde_json::from_str::<Value>(&metadata_raw).unwrap_or_else(|_| json!({}));
        let key = issue_group_key(&rule, &harness, &fingerprint, opened, &metadata);
        let object = issue_object(&rule, &fingerprint, &metadata);
        let evidence_class = issue_evidence_class(&metadata);
        let bucket = issue_day_bucket(opened);
        let entry = groups.entry(key).or_insert_with(|| IssueGroupAccum {
            rule: rule.clone(), harness: harness.clone(), object: object.clone(),
            evidence_class: evidence_class.clone(), bucket: bucket.clone(),
            first_seen_at_ms: opened, last_seen_at_ms: opened,
            severity: severity.clone(), remedy: remedy_for(&rule), ..Default::default()
        });
        entry.count += 1;
        entry.first_seen_at_ms = entry.first_seen_at_ms.min(opened);
        entry.last_seen_at_ms = entry.last_seen_at_ms.max(opened);
        if severity_rank(&severity) > severity_rank(&entry.severity) { entry.severity = severity; }
        entry.status_rollup[status_index(&status)] += 1;
        if let Some(session) = session { entry.sessions.insert(session); }
        if entry.sample_evidence.len() < 3 {
            entry.sample_evidence.push(json!({"issue_id": issue_id, "evidence": evidence,
                "metadata": redact_issue_sample_metadata(&metadata)}));
        }
    }
    let mut values: Vec<Value> = groups.into_iter().map(|(key, group)| {
        let actionability = match group.severity.as_str() { "critical" => 1.0, "warning" => 0.7, _ => 0.4 };
        json!({
            "group_id": stable_hash(&key), "rule": group.rule, "harness": group.harness,
            "object": group.object, "evidence_class": group.evidence_class, "bucket": group.bucket,
            "count": group.count, "first_seen_at_ms": group.first_seen_at_ms,
            "last_seen_at_ms": group.last_seen_at_ms, "severity": group.severity,
            "status_rollup": {"open": group.status_rollup[0], "later": group.status_rollup[1],
                "acknowledged": group.status_rollup[2], "resolved": group.status_rollup[3],
                "not_applicable": group.status_rollup[4]},
            "sessions_count": group.sessions.len(), "sample_evidence": group.sample_evidence,
            "remedy": {"remedy_id": group.remedy.remedy_id, "diagnostic_only": group.remedy.diagnostic_only},
            "actionability": actionability,
            "time": group.first_seen_at_ms, "evidence": group.evidence_class,
            "tool_name": group.object, "category": group.evidence_class,
            "hits": group.count, "sessions": group.sessions.len(),
        })
    }).collect();
    values.sort_by(|a, b| b["actionability"].as_f64().partial_cmp(&a["actionability"].as_f64()).unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| a["group_id"].as_str().cmp(&b["group_id"].as_str())));
    let offset = cursor.and_then(|v| v.parse::<usize>().ok()).unwrap_or(0).min(values.len());
    let limit = if page_size == usize::MAX { values.len() } else { page_size.clamp(1, 500) };
    let end = offset.saturating_add(limit).min(values.len());
    let next_cursor = (end < values.len()).then(|| end.to_string());
    Ok(json!({"groups": values[offset..end].to_vec(), "next_cursor": next_cursor,
        "total_groups": values.len(), "source_issue_count": source_issue_count}))
}

/// Read L1 raw instances for one L0 group. The group id is resolved against
/// the same deterministic key as `issue_groups`; no caller-provided raw key is
/// accepted. Results are paginated by a numeric offset over issue_id order.
pub fn issue_group_instances(
    conn: &Connection,
    group_id: &str,
    page_size: usize,
    cursor: Option<&str>,
) -> rusqlite::Result<Value> {
    let mut stmt = conn.prepare(
        "SELECT issue_id, harness, session_key, issue_type, instance_fingerprint,
                status, severity, evidence_fingerprint, opened_at_ms, closed_at_ms, metadata_json
         FROM issue_instances ORDER BY issue_id",
    )?;
    let mut matches = Vec::new();
    let rows = stmt.query_map([], |r| {
        let metadata: String = r.get(10)?;
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?,
            r.get::<_, String>(6)?, r.get::<_, String>(7)?, r.get::<_, i64>(8)?,
            r.get::<_, Option<i64>>(9)?, metadata))
    })?;
    for row in rows {
        let (issue_id, harness, session, rule, fingerprint, status, severity, evidence, opened, closed, metadata_raw) = row?;
        let metadata = serde_json::from_str::<Value>(&metadata_raw).unwrap_or_else(|_| json!({}));
        if stable_hash(&issue_group_key(&rule, &harness, &fingerprint, opened, &metadata)) != group_id { continue; }
        matches.push(json!({"issue_id": issue_id, "harness_kind": harness, "session_key": session,
            "rule": rule, "status": status, "severity": severity, "evidence": evidence,
            "opened_at_ms": opened, "closed_at_ms": closed, "metadata": metadata}));
    }
    let offset = cursor.and_then(|v| v.parse::<usize>().ok()).unwrap_or(0).min(matches.len());
    let end = (offset + page_size.clamp(1, 500)).min(matches.len());
    Ok(json!({"group_id": group_id, "instances": matches[offset..end].to_vec(),
        "next_cursor": (end < matches.len()).then(|| end.to_string()), "total_instances": matches.len()}))
}

/// Read one raw issue instance for L2 detail. Metadata is returned as parsed
/// JSON, while the authority row remains the source of truth for lifecycle.
pub fn issue_instance(conn: &Connection, issue_id: &str) -> rusqlite::Result<Option<Value>> {
    conn.query_row(
        "SELECT issue_id, harness, session_key, issue_type, status, severity,
                evidence_fingerprint, opened_at_ms, closed_at_ms, metadata_json
         FROM issue_instances WHERE issue_id = ?1",
        [issue_id],
        |r| {
            let metadata: String = r.get(9)?;
            let metadata = serde_json::from_str::<Value>(&metadata).unwrap_or_else(|_| json!({}));
            let issue_id: String = r.get(0)?;
            let issue_type: String = r.get(3)?;
            let mut output = json!({"issue_id": issue_id, "harness_kind": r.get::<_, String>(1)?,
                "session_key": r.get::<_, Option<String>>(2)?, "rule": issue_type,
                "status": r.get::<_, String>(4)?, "severity": r.get::<_, String>(5)?,
                "evidence": r.get::<_, String>(6)?, "opened_at_ms": r.get::<_, i64>(7)?,
                "closed_at_ms": r.get::<_, Option<i64>>(8)?, "metadata": metadata,
                "remedy": {"remedy_id": remedy_for(&issue_type).remedy_id}});
            // Trust details are a local redacted timeline. They contain only
            // stages/levels/classes; no path, actor, hostname, source anchor,
            // or native event id is exposed through the generic issue DTO.
            if issue_type.starts_with("SV7") {
                output["trust_timeline"] = serde_json::to_value(crate::trust::issue_timeline(conn, &issue_id)?).unwrap_or_else(|_| json!([]));
            }
            Ok(output)
        },
    ).optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::AuthorityDb;

    /// §1.6 P1.1：`issues_projection_count` 三态——空表 0（引导放行）、有行 ≥1
    /// （纯读）、表读不到（损坏库）按空处理（仍引导，不崩）。桌面端
    /// `issues_projection_empty` 以它为唯一事实源。
    #[test]
    fn issues_projection_count_three_states() {
        let dir = std::env::temp_dir().join(format!("av-issues-count-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = AuthorityDb::open(&dir.join("agent-vitals.sqlite3"), 1_700_000_000_000).unwrap();
        assert_eq!(issues_projection_count(db.conn()).unwrap(), 0, "空表 → 0（引导放行）");
        db.conn()
            .execute(
                "INSERT INTO issue_instances(issue_id, machine_namespace, harness, session_key, issue_type,
                     instance_fingerprint, status, severity, evaluator_id, evaluator_version,
                     evidence_fingerprint, opened_at_ms, metadata_json)
                 VALUES ('i1', 'm', 'codex', NULL, 'SV610', 'fp', 'open', 'warning', 'ev', '1', 'ef', 1, '{}')",
                [],
            )
            .unwrap();
        assert_eq!(issues_projection_count(db.conn()).unwrap(), 1, "有行 → 1（纯读）");
        let bare = rusqlite::Connection::open_in_memory().unwrap();
        assert!(issues_projection_count(&bare).is_err(), "无表的裸库 → 查询错误由调用方按空处理");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quota_window_issue_is_created_refreshed_and_self_resolves() {
        // 契约：窗口耗尽 → 建任务；同窗口重复同步 → 只刷新不重复；窗口重置 →
        // 同一次调用把它解决掉（任务从待处理消失，行保留）。
        use crate::authority::AuthorityDb;
        let dir = std::env::temp_dir().join(format!("av-issues-quota-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = AuthorityDb::open(&dir.join("agent-vitals.sqlite3"), 1_700_000_000_000).unwrap();

        reconcile_quota_window_issue(db.conn(), "claude-code", Some((2_000, "five_hour", "5 小时窗口")), 1_000).unwrap();
        let open = |conn: &rusqlite::Connection| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM data_quality_issues
                 WHERE scope_key = 'claude-code' AND code = 'quota_window_exhausted'
                   AND resolved_at_ms IS NULL",
                [], |r| r.get(0),
            ).unwrap()
        };
        assert_eq!(open(db.conn()), 1, "耗尽时应有且只有一条待处理任务");

        // 同一窗口再次同步：不重复建（幂等键是 harness+code），last_seen 前进。
        reconcile_quota_window_issue(db.conn(), "claude-code", Some((2_000, "five_hour", "5 小时窗口")), 1_500).unwrap();
        assert_eq!(open(db.conn()), 1, "同一执行环境同一时刻只应有一条");
        let last_seen: i64 = db.conn().query_row(
            "SELECT last_seen_at_ms FROM data_quality_issues WHERE scope_key = 'claude-code'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(last_seen, 1_500, "重复同步刷新 last_seen");

        // 窗口重置（状态机给出 Unknown）→ 自动解决。
        reconcile_quota_window_issue(db.conn(), "claude-code", None, 2_500).unwrap();
        assert_eq!(open(db.conn()), 0, "窗口重置后任务必须自己消失");
        let resolved: Option<i64> = db.conn().query_row(
            "SELECT resolved_at_ms FROM data_quality_issues WHERE scope_key = 'claude-code'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(resolved, Some(2_500), "解决时刻要落上（历史不丢）");

        // 再次耗尽 → 同一行被重新打开（不是新建第二行）。
        reconcile_quota_window_issue(db.conn(), "claude-code", Some((9_000, "seven_day", "7 天窗口")), 8_000).unwrap();
        let rows: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM data_quality_issues WHERE scope_key = 'claude-code'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "重新打开复用同一行");
        assert_eq!(open(db.conn()), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quota_codes_route_to_their_own_rule_and_never_leak_the_raw_code_as_object() {
        // 卡面直接渲染 object —— raw code 绝不能端上去（总览规格 §4 第 84 行）。
        let dir = std::env::temp_dir().join(format!("av-issues-rule-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = AuthorityDb::open(&dir.join("agent-vitals.sqlite3"), 1_700_000_000_000).unwrap();
        reconcile_quota_window_issue(db.conn(), "claude-code", Some((2_000, "five_hour", "5 小时窗口")), 1_000).unwrap();
        let groups = source_issue_groups(db.conn(), None, None).unwrap();
        let g = groups.iter().find(|g| g["rule"] == "QUOTA_WINDOW").expect("应归到独立规则 QUOTA_WINDOW");
        assert_eq!(g["object"], "5 小时窗口", "object 是人类标签，不是 raw code");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// failure_hours_day（OVERVIEW_TREND_PANEL spec v1.1 §3）：小时桶、日窗过滤、
    /// 规则族过滤、非法日期 → None。日界锚点取统计时区日窗（beijing_day_bounds_ms），
    /// 钉住「失败标记与用量小时分布同一小时列」。
    #[test]
    fn failure_hours_day_buckets_rules_and_windows() {
        let dir = std::env::temp_dir().join(format!("av-issues-fhours-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = AuthorityDb::open(&dir.join("agent-vitals.sqlite3"), 1).unwrap();
        let (day_start, day_end) = crate::authority_query::beijing_day_bounds_ms("2026-10-01").expect("10-01 日窗");
        let issue = |conn: &rusqlite::Connection, id: &str, rule: &str, at_ms: i64| {
            upsert_issue(conn, &IssueInput {
                machine_namespace: "machine", harness: "codex", session_key: Some("s"),
                issue_type: rule, instance_fingerprint: id, status: "open", severity: "warning",
                evaluator_id: "t", evaluator_version: "1", evidence_fingerprint: "ev",
                opened_at_ms: at_ms, metadata_json: "{}",
            })
        };
        // 02:30（SV613 × 2，其一转 wontfix——历史事实仍计）、09:59（legacy retry_loop，已 resolved）。
        let issue_b = issue(db.conn(), "b", "SV613", day_start + 2 * 3_600_000 + 1_800_000).unwrap();
        let issue_c = issue(db.conn(), "c", "retry_loop", day_start + 9 * 3_600_000 + 59 * 60_000).unwrap();
        transition_issue(db.conn(), &issue_b, "wontfix", 5, "t", "test", "ev", "t", "1", "in").unwrap();
        transition_issue(db.conn(), &issue_c, "resolved", 6, "t", "test", "ev", "t", "1", "in").unwrap();
        issue(db.conn(), "a", "SV613", day_start + 2 * 3_600_000 + 1_799_000).unwrap();
        // 日窗边界外：前一日 23:59 尾部与次日 00:01 都不进 10-01 面板。
        issue(db.conn(), "d", "SV611", day_start - 60_000).unwrap();
        issue(db.conn(), "d2", "SV611", day_end + 60_000).unwrap();
        // 非失败族（行为 shell 规则、数据质量）不计数。
        issue(db.conn(), "e", "SV601", day_start + 60_000).unwrap();
        issue(db.conn(), "f", "USAGE_GROWTH", day_start + 60_000).unwrap();
        let value = failure_hours_day(db.conn(), "2026-10-01").expect("合法日期应有聚合");
        assert_eq!(value["date"], "2026-10-01");
        let hours = value["hours"].as_object().expect("hours 是对象");
        assert_eq!(hours.len(), 2, "只有 02 与 09 两个小时列");
        assert_eq!(hours.get("2").and_then(Value::as_u64), Some(2));
        assert_eq!(hours.get("9").and_then(Value::as_u64), Some(1));
        assert!(failure_hours_day(db.conn(), "2026-02-30").is_none(), "非法日期 → None，不是假零");
        let empty = failure_hours_day(db.conn(), "2026-01-01").expect("合法空日是空对象");
        assert_eq!(empty["hours"].as_object().unwrap().len(), 0, "空日 = 读到零失败，不是 None");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// failure_days_range（OVERVIEW_TREND_RANGE_SPEC §2.2）：日桶、窗口两端含、
    /// 规则族与 failure_hours_day 一致、非法/倒置/超跨度 → None、合法空窗 → 空 days。
    #[test]
    fn failure_days_range_buckets_days_and_guards_window() {
        let dir = std::env::temp_dir().join(format!("av-issues-fdays-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = AuthorityDb::open(&dir.join("agent-vitals.sqlite3"), 1).unwrap();
        let (d30, _) = crate::authority_query::beijing_day_bounds_ms("2026-09-30").unwrap();
        let (d01, _) = crate::authority_query::beijing_day_bounds_ms("2026-10-01").unwrap();
        let issue = |id: &str, rule: &str, at_ms: i64| {
            upsert_issue(db.conn(), &IssueInput {
                machine_namespace: "machine", harness: "codex", session_key: Some("s"),
                issue_type: rule, instance_fingerprint: id, status: "open", severity: "warning",
                evaluator_id: "t", evaluator_version: "1", evidence_fingerprint: "ev",
                opened_at_ms: at_ms, metadata_json: "{}",
            }).unwrap()
        };
        issue("a", "SV613", d30 + 3_600_000);
        issue("b", "SV611", d30 + 20 * 3_600_000);
        issue("c", "retry_loop", d01 + 60_000);
        issue("d", "SV601", d01 + 60_000);          // 非失败族
        issue("e", "SV612", d30 - 60_000);          // 09-29 尾部：窗口外（from=09-30）
        let v = failure_days_range(db.conn(), "2026-09-30", "2026-10-01").expect("合法窗口");
        let days = v["days"].as_object().unwrap();
        assert_eq!(days.len(), 2);
        assert_eq!(days.get("2026-09-30").and_then(Value::as_u64), Some(2));
        assert_eq!(days.get("2026-10-01").and_then(Value::as_u64), Some(1));
        assert!(failure_days_range(db.conn(), "2026-10-01", "2026-09-30").is_none(), "倒置 → None");
        assert!(failure_days_range(db.conn(), "2026-02-30", "2026-10-01").is_none(), "非法日期 → None");
        assert!(failure_days_range(db.conn(), "2026-07-01", "2026-10-01").is_none(), "跨度 > 62 天 → None");
        let empty = failure_days_range(db.conn(), "2026-01-01", "2026-01-07").expect("合法空窗");
        assert_eq!(empty["days"].as_object().unwrap().len(), 0, "空窗 = 读到零失败，不是 None");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// failure_days_trailing(to, 30) 必须覆盖「本月 1 日起」：31 天月份、to=31 号时
    /// 窗口起点恰为 1 号（A1 验收建议的边界），1 号当天的失败不能被漏掉。
    #[test]
    fn failure_days_trailing_covers_first_of_a_31_day_month() {
        let dir = std::env::temp_dir().join(format!("av-issues-ftrail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = AuthorityDb::open(&dir.join("agent-vitals.sqlite3"), 1).unwrap();
        let (first, _) = crate::authority_query::beijing_day_bounds_ms("2026-10-01").unwrap();
        upsert_issue(db.conn(), &IssueInput {
            machine_namespace: "machine", harness: "codex", session_key: Some("s"),
            issue_type: "SV613", instance_fingerprint: "first", status: "open", severity: "warning",
            evaluator_id: "t", evaluator_version: "1", evidence_fingerprint: "ev",
            opened_at_ms: first + 60_000, metadata_json: "{}",
        }).unwrap();
        let v = failure_days_trailing(db.conn(), "2026-10-31", 30).expect("合法");
        assert_eq!(v["from"], "2026-10-01");
        assert_eq!(v["days"]["2026-10-01"].as_u64(), Some(1), "月初当天的失败在窗口内");
        assert!(failure_days_trailing(db.conn(), "not-a-date", 30).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn input<'a>(status: &'a str) -> IssueInput<'a> {
        IssueInput {
            machine_namespace: "machine",
            harness: "codex",
            session_key: Some("session"),
            issue_type: "retry_loop",
            instance_fingerprint: "fp-1",
            status,
            severity: "warning",
            evaluator_id: "rule.retry",
            evaluator_version: "1",
            evidence_fingerprint: "ev-1",
            opened_at_ms: 1,
            metadata_json: "{}",
        }
    }

    #[test]
    fn replay_is_idempotent_and_closed_issue_reopens() {
        let path = std::env::temp_dir().join(format!("av-issue-{}", std::process::id()));
        let db = AuthorityDb::open(&path, 1).unwrap();
        let id = upsert_issue(db.conn(), &input("open")).unwrap();
        let id2 = upsert_issue(db.conn(), &input("open")).unwrap();
        assert_eq!(id, id2);
        transition_issue(
            db.conn(),
            &id,
            "closed",
            2,
            "done",
            "rule",
            "ev-1",
            "rule.retry",
            "1",
            "fp-1",
        )
        .unwrap();
        let t = transition_issue(
            db.conn(),
            &id,
            "open",
            3,
            "reappeared",
            "rule",
            "ev-2",
            "rule.retry",
            "1",
            "fp-1",
        )
        .unwrap();
        let t2 = transition_issue(
            db.conn(),
            &id,
            "open",
            3,
            "reappeared",
            "rule",
            "ev-2",
            "rule.retry",
            "1",
            "fp-1",
        )
        .unwrap();
        assert_eq!(t, t2);
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM issue_status_transitions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn remedy_catalog_is_code_only_and_has_diagnostic_fallback() {
        assert!(!remedy_for("retry_loop").diagnostic_only);
        assert!(remedy_for("future_rule").diagnostic_only);
        assert_eq!(remedy_for("future_rule").remedy_id, "diagnostic-only");
    }

    /// WORKBENCH_FINDINGS_TAB_SPEC §6.2〔P1〕：SV601–SV610 每条都必须有**专属**、
    /// 非 diagnostic-only 的 remedy，前端 labels map 的文案等着这个 ID。ID 之间
    /// 不得撞号 —— 撞号会让两条规则的「下一步」在 UI 上无法区分。
    #[test]
    fn every_family1_behavior_rule_has_a_dedicated_remedy() {
        let codes = [
            "SV601", "SV602", "SV603", "SV604", "SV605",
            "SV606", "SV607", "SV608", "SV609", "SV610",
        ];
        let mut ids: Vec<&str> = Vec::new();
        for code in codes {
            let r = remedy_for(code);
            assert!(!r.diagnostic_only, "{code} 落到了 diagnostic-only");
            assert_ne!(r.remedy_id, "diagnostic-only", "{code} 的 remedy_id 是兜底值");
            assert!(!ids.contains(&r.remedy_id), "remedy_id 撞号：{}", r.remedy_id);
            ids.push(r.remedy_id);
        }
        assert_eq!(ids.len(), 10);
    }

    #[test]
    fn every_trust_rule_has_a_non_destructive_review_remedy() {
        let codes = [
            "SV701", "SV702", "SV703", "SV704", "SV705", "SV706", "SV707", "SV708", "SV709", "SV710",
        ];
        let mut ids = Vec::new();
        for code in codes {
            let remedy = remedy_for(code);
            assert!(!remedy.diagnostic_only, "{code} must name a review action");
            assert!(remedy.remedy_id.starts_with("review-"), "{code} must not propose an automatic fix");
            assert!(!ids.contains(&remedy.remedy_id), "remedy id collision: {}", remedy.remedy_id);
            ids.push(remedy.remedy_id);
        }
    }

    #[test]
    fn issue_timestamps_use_milliseconds_and_legacy_repair_is_idempotent() {
        assert_eq!(to_epoch_ms(1_788_651_641), 1_788_651_641_000);
        assert_eq!(to_epoch_ms(100_000_000_000), 100_000_000_000);
        assert_eq!(to_epoch_ms(100_000_000_001), 100_000_000_001);
        assert_ne!(issue_day_bucket(to_epoch_ms(1_788_651_641)), "1970-01-22");

        let path = std::env::temp_dir().join(format!("av-issue-time-{}", std::process::id()));
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.conn().execute(
            "INSERT INTO issue_instances(issue_id, machine_namespace, harness, session_key,
             issue_type, instance_fingerprint, status, severity, evaluator_id,
             evaluator_version, evidence_fingerprint, opened_at_ms, metadata_json)
             VALUES ('legacy-time', 'machine', 'claude-code', 's1', 'SV601', 'fp-time',
             'open', 'warning', 'legacy', 'v1', 'ev', ?1, ?2)",
            rusqlite::params![1_788_651_641_i64, r#"{"time":1788651641}"#],
        ).unwrap();
        assert_eq!(repair_issue_timestamp_units(db.conn()).unwrap(), 1);
        assert_eq!(repair_issue_timestamp_units(db.conn()).unwrap(), 0);
        let (opened, metadata): (i64, String) = db.conn().query_row(
            "SELECT opened_at_ms, metadata_json FROM issue_instances WHERE issue_id='legacy-time'", [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(opened, 1_788_651_641_000);
        assert_eq!(serde_json::from_str::<Value>(&metadata).unwrap()["time"], opened);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn later_is_a_real_state_and_confirmation_is_not_resolution() {
        let path = std::env::temp_dir().join(format!("av-issue-states-{}", std::process::id()));
        let db = AuthorityDb::open(&path, 1).unwrap();
        let id = upsert_issue(db.conn(), &input("open")).unwrap();
        transition_issue(db.conn(), &id, "later", 2, "remind later", "user",
            "user-action:later", "user", "v1", "later-input").unwrap();
        assert_eq!(db.conn().query_row("SELECT status FROM issue_instances WHERE issue_id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "later");
        transition_issue(db.conn(), &id, "acknowledged", 3, "understood", "user",
            "user-action:acknowledged", "user", "v1", "ack-input").unwrap();
        assert_eq!(db.conn().query_row("SELECT status FROM issue_instances WHERE issue_id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "acknowledged");
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM issue_status_transitions WHERE issue_id=?1", [&id], |r| r.get::<_, i64>(0)).unwrap(), 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn normalize_issue_objects_keeps_family_boundaries() {
        assert_eq!(normalize_issue_object("SV601", "rm -rf"), "rm");
        assert_eq!(normalize_issue_object("SV601", "rmdir -p"), "rmdir");
        assert_eq!(normalize_issue_object("SV604", "~/.ssh/authorized_keys"), "~/.ssh/*");
        assert_eq!(normalize_issue_object("SV605", "/ingest/export/summary/state"), "/ingest/export/*");
        assert_eq!(normalize_issue_object("SV611", "read 连续重复 3 次"), "read 连续重复");
        assert_eq!(normalize_issue_object("SV613", "进度停滞: 连续 4 个工具失败（首个 read）"), "进度停滞: 连续工具失败");
        assert_eq!(normalize_issue_object("SV613", "进度停滞: 连续 9 个工具失败（首个 write）"), "进度停滞: 连续工具失败");
        assert_eq!(normalize_issue_object("SV614", "权限异常: 危险模式 danger-full-access 授予 1 次"), "权限异常: 危险模式 danger-full-access 授予");
        assert_eq!(normalize_issue_object("SV610", "danger-full-access"), "danger-full-access");
    }

    #[test]
    fn issue_groups_reduce_hits_and_page_stably() {
        let path = std::env::temp_dir().join(format!("av-issue-groups-{}", std::process::id()));
        let db = AuthorityDb::open(&path, 1).unwrap();
        let rows = [
            ("i1", "SV601", "codex", "rm -rf", 1_i64),
            ("i2", "SV601", "codex", "rm -f", 2_i64),
            ("i3", "SV601", "codex", "rmdir", 3_i64),
            ("i4", "SV601", "dsh", "rm -rf", 4_i64),
        ];
        for (id, rule, harness, object, opened) in rows {
            let metadata = r#"{"category":"command","evidence":"command-pattern"}"#.to_string();
            let input = IssueInput {
                machine_namespace: "machine", harness, session_key: Some(id), issue_type: rule,
                instance_fingerprint: &format!("{id}\0{rule}\0seq\0{object}"), status: "open",
                severity: "warning", evaluator_id: "evaluator", evaluator_version: "1",
                evidence_fingerprint: id, opened_at_ms: opened, metadata_json: &metadata,
            };
            upsert_issue(db.conn(), &input).unwrap();
        }
        let grouped = issue_groups(db.conn(), None, None, 50, None).unwrap();
        assert_eq!(grouped["source_issue_count"], 4);
        assert_eq!(grouped["total_groups"], 3);
        let merged_group = grouped["groups"].as_array().unwrap().iter()
            .find(|g| g["count"] == 2).unwrap();
        let merged_id = merged_group["group_id"].as_str().unwrap();
        let instances = issue_group_instances(db.conn(), merged_id, 1, None).unwrap();
        assert_eq!(instances["total_instances"], 2);
        assert_eq!(instances["instances"].as_array().unwrap().len(), 1);
        let next = instances["next_cursor"].as_str().unwrap();
        let second = issue_group_instances(db.conn(), merged_id, 1, Some(next)).unwrap();
        assert_eq!(second["instances"].as_array().unwrap().len(), 1);
        let issue_id = instances["instances"][0]["issue_id"].as_str().unwrap();
        assert!(issue_instance(db.conn(), issue_id).unwrap().is_some());
        assert!(issue_instance(db.conn(), "missing").unwrap().is_none());
        let first = issue_groups(db.conn(), None, None, 1, None).unwrap();
        let next = first["next_cursor"].as_str().unwrap();
        let second = issue_groups(db.conn(), None, None, 1, Some(next)).unwrap();
        assert_eq!(first["groups"].as_array().unwrap().len(), 1);
        assert_eq!(second["groups"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn issue_groups_use_category_before_evidence_and_unlimited_is_explicit() {
        let path = std::env::temp_dir().join(format!("av-issue-group-contract-{}", std::process::id()));
        let db = AuthorityDb::open(&path, 1).unwrap();
        for index in 0..1_i64 {
            let metadata = if index == 0 {
                r#"{"category":"command","evidence":"/Users/alice/private.log","path":"/Users/alice/private.log"}"#
            } else {
                r#"{"category":"command","evidence":"command-pattern"}"#
            };
            let input = IssueInput {
                machine_namespace: "machine", harness: "codex", session_key: Some("session"),
                issue_type: "SV601", instance_fingerprint: "fp-shared", status: "open",
                severity: "warning", evaluator_id: "evaluator", evaluator_version: "1",
                evidence_fingerprint: &format!("ev-{index}"), opened_at_ms: index + 1,
                metadata_json: metadata,
            };
            upsert_issue(db.conn(), &input).unwrap();
        }
        let all = issue_groups(db.conn(), None, None, usize::MAX, None).unwrap();
        assert_eq!(all["total_groups"], 1);
        assert_eq!(all["groups"].as_array().unwrap().len(), 1);
        assert_eq!(all["groups"][0]["evidence_class"], "command");
        assert_eq!(all["groups"][0]["sample_evidence"][0]["metadata"]["evidence"], "<redacted-path>");
        assert_eq!(all["groups"][0]["sample_evidence"][0]["metadata"]["path"], "<redacted-path>");
        let first = issue_groups(db.conn(), None, None, 1, None).unwrap();
        assert!(first["next_cursor"].is_null());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unified_groups_include_source_failures_and_pending_candidates_without_merging() {
        let path = std::env::temp_dir().join(format!("av-unified-issues-{}", std::process::id()));
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.conn().execute(
            "INSERT INTO data_quality_issues(issue_id, scope_type, scope_key, code, severity,
             first_seen_at_ms, last_seen_at_ms, detail_json)
             VALUES ('dq1', 'source', 'src-1', 'price_missing', 'warning', 10, 10, ?1)",
            [r#"{"harness":"codex","provider_id":"openai"}"#],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO data_quality_issues(issue_id, scope_type, scope_key, code, severity,
             first_seen_at_ms, last_seen_at_ms, detail_json)
             VALUES ('dq2', 'fact', 'attribution_conflict:fact-2', 'price_missing', 'warning', 11, 12, ?1)",
            [r#"{"harness":"codex","provider_id":"openai"}"#],
        ).unwrap();
        db.billing_import_candidate_put("candidate-1", "claude-code", "minimax", "CNY", 11400,
            "2026-09", "pricing-v1", 10).unwrap();
        db.conn().execute(
            "INSERT INTO source_files(source_id, harness, path_hash, size_bytes, mtime_ns,
             parser_version, first_seen_at_ms, last_seen_at_ms, last_error_code)
             VALUES ('source-1', 'dsh', 'hash', 1, 1, 1, 10, 10, 'permission_denied')", [],
        ).unwrap();
        // 无候选、只有按量估算用量的组（AC28 找回路径）：来自 usage_facts，
        // 与候选是两个 source_kind，不互相合并。
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run', 1, 'cli', 'succeeded', 13)", [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                 observation_kind, provider_id, model_id, event_ts_ms, pricing_basis, evidence_basis,
                 uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f-group', 'codex', 'm', 'sess', 'e1', 'token_count', 'openai', 'gpt-mystery', 20,
                 'metered_estimate', 'missing', 100, 0, 0, 5, 'run', 1, 1)", [],
        ).unwrap();
        let result = issue_groups_with_sources(db.conn(), None, None, 50, None).unwrap();
        let groups = result["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 4);
        assert_eq!(result["total_groups"], 4);
        assert!(result["summary_rules"].as_array().unwrap().iter().any(|row| {
            row["rule"] == "PRICE_COVERAGE" && row["hits"] == 2
        }));
        let billing_group = groups.iter().find(|g| g["source_kind"] == "billing_group").unwrap();
        assert_eq!(billing_group["rule"], "BILLING_CONFIRMATION");
        assert_eq!(billing_group["object"], "openai:gpt-mystery");
        assert_eq!(billing_group["sample_evidence"][0]["tokens"], 105);
        assert_eq!(billing_group["sample_evidence"][0]["is_bill"], false);
        let price = groups.iter().find(|g| g["rule"] == "PRICE_COVERAGE").unwrap();
        assert_eq!(price["count"], 2);
        assert_eq!(price["sample_evidence"].as_array().unwrap().len(), 2);
        assert!(groups.iter().any(|g| g["source_kind"] == "billing_candidate"
            && g["rule"] == "BILLING_CONFIRMATION" && g["sample_evidence"][0]["is_bill"] == false
            && g["status_rollup"]["open"] == 1));
        assert!(groups.iter().any(|g| g["source_kind"] == "source_failure"));
        assert!(groups.iter().any(|g| g["source_kind"] == "data_quality"
            && g["rule"] == "PRICE_COVERAGE"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn source_projection_groups_merge_hits_and_keep_samples_bounded() {
        let values = (0..4).map(|index| projection_group(
            "data_quality", "PRICE_COVERAGE", "codex", "openai", "price_missing",
            1_000 + index, 1, "warning", "open",
            json!({"issue_id": format!("dq-{index}")}), "diagnostic-only",
        )).collect();
        let groups = merge_projection_groups(values);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["count"], 4);
        assert_eq!(groups[0]["hits"], 4);
        assert_eq!(groups[0]["status_rollup"]["open"], 4);
        assert_eq!(groups[0]["sample_evidence"].as_array().unwrap().len(), 3);
        assert_eq!(groups[0]["first_seen_at_ms"], 1_000);
        assert_eq!(groups[0]["last_seen_at_ms"], 1_003);
    }

    #[test]
    fn probe_verdict_groups_surface_only_actionable_verdicts() {
        // V17 回流（复审定稿版）：① 只有 actionable 判定回流；② sample 从
        // **嵌套**证据链取（runner 存 combine 产物：外层条目是单报告，身份
        // 证据在内层 chain[0]——扁平形状是假绿，不复用）；③ 同日同组合聚合
        // 成一组；④ 窗口过滤生效。
        let path = std::env::temp_dir().join(format!(
            "av-probe-findings-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let db = crate::authority::AuthorityDb::open(&path, 1).unwrap();
        let conn = db.conn();
        // runner 真实形状：evidence_chain_json = [ {verdict, evidence_chain_json:[{kind:"model_identity", requested, resolved}], route, repeat}, … ]
        let chain = r#"[{"verdict":"confirmed_mismatch","rule_version":"l0-identity-v1","statistic_json":{},"evidence_chain_json":[{"kind":"model_identity","requested":"m","resolved":"other","matched":false}],"route":"rt1","repeat":0}]"#;
        conn.execute_batch(&format!(
            "INSERT INTO probe_routes(route_id, label, harness_kind, model_requested, created_at_ms, updated_at_ms)
             VALUES('rt1','官方直连','claude-code','claude-sonnet-5',1,1);
             INSERT INTO probe_suites(suite_id, version, kind, manifest_ref, manifest_sha256, rule_version, created_at_ms)
             VALUES('l0','1','l0_identity','x','h','l0-identity-v1',1);
             INSERT INTO probe_runs(run_id, mode, route_a_id, suite_id, n_repeats, status, created_at_ms)
             VALUES('run1','single','rt1','l0',1,'completed',1);
             INSERT INTO probe_runs(run_id, mode, route_a_id, suite_id, n_repeats, status, created_at_ms)
             VALUES('run2','single','rt1','l0',1,'completed',1);
             INSERT INTO probe_runs(run_id, mode, route_a_id, suite_id, n_repeats, status, created_at_ms)
             VALUES('run3','single','rt1','l0',1,'completed',1);
             INSERT INTO probe_verdicts(verdict_id, run_id, verdict, statistic_json, evidence_chain_json, confounders_json, rule_version, decided_at_ms)
             VALUES('v1','run1','confirmed_mismatch','{{}}','{chain}','[]','l0-identity-v1',100);
             INSERT INTO probe_verdicts(verdict_id, run_id, verdict, statistic_json, evidence_chain_json, confounders_json, rule_version, decided_at_ms)
             VALUES('v2','run2','confirmed_mismatch','{{}}','{chain}','[]','l0-identity-v1',200);
             INSERT INTO probe_verdicts(verdict_id, run_id, verdict, statistic_json, evidence_chain_json, confounders_json, rule_version, decided_at_ms)
             VALUES('v3','run3','no_signal','{{}}','{chain}','[]','l0-identity-v1',300);",
        )).unwrap();
        let groups = probe_verdict_groups(conn, None, None).unwrap();
        assert_eq!(groups.len(), 1, "同日同组合聚成一组，no_signal 不回流：{groups:?}");
        assert_eq!(groups[0]["source_kind"], json!("probe"));
        assert_eq!(groups[0]["rule"], json!("confirmed_mismatch"));
        assert_eq!(groups[0]["severity"], json!("critical"));
        assert_eq!(groups[0]["count"], json!(2), "两次判定累计");
        assert_eq!(groups[0]["first_seen_at_ms"], json!(100));
        assert_eq!(groups[0]["last_seen_at_ms"], json!(200));
        // 嵌套链取值：顶层没有 requested——只有内层 chain[0] 有。
        assert_eq!(groups[0]["sample_evidence"][0]["requested"], json!("m"));
        assert_eq!(groups[0]["sample_evidence"][0]["resolved"], json!("other"));
        // 窗口：只看 [150, ∞) → 只剩 run2。
        let windowed = probe_verdict_groups(conn, Some(150), None).unwrap();
        assert_eq!(windowed.len(), 1);
        assert_eq!(windowed[0]["count"], json!(1));
        assert_eq!(windowed[0]["first_seen_at_ms"], json!(200));
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    }

    #[test]
    fn usage_growth_requires_seven_valid_baseline_days_and_same_scope() {
        let path = std::env::temp_dir().join(format!("av-usage-growth-{}", std::process::id()));
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run-growth', 1, 'test', 'succeeded', 13)", [],
        ).unwrap();
        let start = crate::authority_query::beijing_day_bounds_ms("2026-09-01").unwrap().0;
        for day in 0..8_i64 {
            let tokens = if day == 7 { 250 } else { 100 };
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 source_event_id, observation_kind, provider_id, billing_mode, event_ts_ms,
                 output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, 'codex', 'machine', 'session', ?2, 'request', 'openai',
                 'metered_estimate', ?3, ?4, 'run-growth', 1, 1)",
                rusqlite::params![format!("growth-{day}"), format!("event-{day}"), start + day * DAY_MS, tokens],
            ).unwrap();
        }
        let growth = usage_growth_groups(db.conn()).unwrap();
        assert_eq!(growth.len(), 1);
        assert_eq!(growth[0]["rule"], "USAGE_GROWTH");
        assert_eq!(growth[0]["sample_evidence"][0]["baseline_days"], 7);
        assert_eq!(growth[0]["sample_evidence"][0]["observed_tokens"], 250);
        assert_eq!(growth[0]["sample_evidence"][0]["coverage"], "complete");
        assert_eq!(growth[0]["first_seen_at_ms"], start + 7 * DAY_MS);
        assert_eq!(growth[0]["last_seen_at_ms"], start + 7 * DAY_MS);
        assert_eq!(growth[0]["time"], start + 7 * DAY_MS);
        let _ = std::fs::remove_file(path);
    }
}
