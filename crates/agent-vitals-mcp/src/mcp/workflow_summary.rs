//! Read-only MCP projections over the redacted `workflow_events` authority
//! table.  The query layer never reads prompt/argument/error text; fingerprints
//! and capability names are the only identifiers exposed.

use std::path::Path;

use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use serde_json::{Value, json};

use super::{AuthorityHandle, ToolError, ToolSpec, build_envelope, check_as_of_run_id};

pub fn issues_spec() -> ToolSpec {
    ToolSpec {
        name: "issues_summary",
        description: "Summarize repeated workflow errors, tool retries, denied approvals, and incomplete workflow evidence without exposing raw errors or invocation arguments.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "from": { "type": "string", "description": "Inclusive statistics date YYYY-MM-DD." },
                "to": { "type": "string", "description": "Inclusive statistics date YYYY-MM-DD." },
                "harnesses": { "type": "array", "items": { "type": "string" } },
                "skills": { "type": "array", "items": { "type": "string" } },
                "group_by": { "type": "string", "enum": ["category", "fingerprint", "capability"] },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                "as_of_run_id": { "type": "string" }
            },
            "required": ["from", "to"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "Standard envelope; data.issues contains safe grouped issue rows and explicit token/cost linkage status."
        }),
    }
}

pub fn skills_spec() -> ToolSpec {
    ToolSpec {
        name: "skills_summary",
        description: "Summarize observed Skill invocations with explicit success, failure, unknown, retry, duration, version comparison, and coverage states; never infer value from low usage.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "from": { "type": "string", "description": "Inclusive statistics date YYYY-MM-DD." },
                "to": { "type": "string", "description": "Inclusive statistics date YYYY-MM-DD." },
                "skills": { "type": "array", "items": { "type": "string" } },
                "sort": { "type": "string", "enum": ["calls", "failures", "duration"] },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                "as_of_run_id": { "type": "string" }
            },
            "required": ["from", "to"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "Standard envelope; data.skills contains safe Skill rows and every ratio carries numerator, denominator, and coverage."
        }),
    }
}

const MIN_VERSION_COMPARISON_CALLS: i64 = 3;

#[derive(Clone)]
struct SkillVersionSnapshot {
    version: String,
    calls: i64,
    sessions: i64,
    succeeded: i64,
    failed: i64,
    unknown: i64,
    average_duration_ms: Option<f64>,
    finished_events: i64,
    duration_events: i64,
    first_ms: i64,
    last_ms: i64,
}

fn skill_version_snapshots(
    conn: &Connection,
    window: &Window,
    skill: &str,
) -> Result<Vec<SkillVersionSnapshot>, ToolError> {
    let sql = "SELECT COALESCE(capability_version, '<unknown>'),
                      SUM(CASE WHEN event_type='skill_invoked' THEN 1 ELSE 0 END),
                      COUNT(DISTINCT CASE WHEN event_type='skill_invoked' THEN session_key END),
                      SUM(CASE WHEN event_type='skill_finished' AND outcome='succeeded' THEN 1 ELSE 0 END),
                      SUM(CASE WHEN event_type='skill_finished' AND outcome='failed' THEN 1 ELSE 0 END),
                      AVG(CASE WHEN event_type='skill_finished' THEN duration_ms END),
                      SUM(CASE WHEN event_type='skill_finished' THEN 1 ELSE 0 END),
                      SUM(CASE WHEN event_type='skill_finished' AND duration_ms IS NOT NULL THEN 1 ELSE 0 END),
                      MIN(event_ts_ms), MAX(event_ts_ms)
               FROM workflow_events
               WHERE event_type IN ('skill_invoked', 'skill_finished')
                 AND event_ts_ms >= ?1 AND event_ts_ms < ?2
                 AND capability_id = ?3
               GROUP BY COALESCE(capability_version, '<unknown>')
               HAVING SUM(CASE WHEN event_type='skill_invoked' THEN 1 ELSE 0 END) > 0
               ORDER BY MIN(event_ts_ms), COALESCE(capability_version, '<unknown>')";
    let mut statement = conn
        .prepare(sql)
        .map_err(|e| ToolError::new("internal_error", format!("skill version query failed: {e}")))?;
    let mut rows = statement
        .query((window.start_ms, window.end_ms, skill))
        .map_err(|e| ToolError::new("internal_error", format!("skill version query failed: {e}")))?;
    let mut snapshots = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| ToolError::new("internal_error", format!("skill version row failed: {e}")))?
    {
        let calls: i64 = row.get(1).unwrap_or(0);
        let succeeded_raw: i64 = row.get(3).unwrap_or(0);
        let failed_raw: i64 = row.get(4).unwrap_or(0);
        let succeeded = succeeded_raw.clamp(0, calls);
        let failed = failed_raw.clamp(0, calls.saturating_sub(succeeded));
        snapshots.push(SkillVersionSnapshot {
            version: row.get(0).unwrap_or_else(|_| "<unknown>".to_string()),
            calls,
            sessions: row.get(2).unwrap_or(0),
            succeeded,
            failed,
            unknown: calls.saturating_sub(succeeded).saturating_sub(failed),
            average_duration_ms: row.get(5).unwrap_or(None),
            finished_events: row.get(6).unwrap_or(0),
            duration_events: row.get(7).unwrap_or(0),
            first_ms: row.get(8).unwrap_or(0),
            last_ms: row.get(9).unwrap_or(0),
        });
    }
    Ok(snapshots)
}

fn skill_version_row(snapshot: &SkillVersionSnapshot) -> Value {
    let success_complete = snapshot.unknown == 0;
    let duration_complete = snapshot.duration_events >= snapshot.calls && snapshot.calls > 0;
    json!({
        "version": snapshot.version,
        "calls": snapshot.calls,
        "sessions": snapshot.sessions,
        "outcomes": {
            "succeeded": snapshot.succeeded,
            "failed": snapshot.failed,
            "unknown": snapshot.unknown
        },
        "success_rate": {
            "numerator": snapshot.succeeded,
            "denominator": snapshot.calls,
            "coverage": if success_complete { "complete" } else { "partial" },
            "value": if success_complete { json!(snapshot.succeeded as f64 / snapshot.calls.max(1) as f64) } else { Value::Null }
        },
        "duration_ms": {
            "average": snapshot.average_duration_ms,
            "coverage": if duration_complete { "complete" } else if snapshot.average_duration_ms.is_some() { "partial" } else { "unknown" }
        },
        "finished_events": snapshot.finished_events,
        "first_seen": super::ms_to_rfc3339_beijing(snapshot.first_ms),
        "last_seen": super::ms_to_rfc3339_beijing(snapshot.last_ms)
    })
}

fn skill_version_regression(snapshots: &[SkillVersionSnapshot]) -> Value {
    let known_versions = snapshots
        .iter()
        .filter(|snapshot| snapshot.version != "<unknown>")
        .collect::<Vec<_>>();
    if known_versions.len() < 2 {
        return json!({
            "status": "unavailable",
            "reason": if snapshots.len() < 2 { "fewer_than_two_versions" } else { "fewer_than_two_known_versions" },
            "version_count": snapshots.len(),
            "known_version_count": known_versions.len(),
            "minimum_calls": MIN_VERSION_COMPARISON_CALLS
        });
    }
    if known_versions.iter().any(|snapshot| snapshot.calls < MIN_VERSION_COMPARISON_CALLS) {
        return json!({
            "status": "unavailable",
            "reason": "sample_below_minimum",
            "minimum_calls": MIN_VERSION_COMPARISON_CALLS,
            "version_count": snapshots.len(),
            "known_version_count": known_versions.len()
        });
    }
    if known_versions.iter().any(|snapshot| snapshot.unknown > 0 || snapshot.finished_events < snapshot.calls) {
        return json!({
            "status": "unavailable",
            "reason": "incomplete_skill_lifecycle",
            "version_count": snapshots.len(),
            "known_version_count": known_versions.len()
        });
    }
    if known_versions.iter().any(|snapshot| snapshot.duration_events < snapshot.calls || snapshot.average_duration_ms.is_none()) {
        return json!({
            "status": "unavailable",
            "reason": "incomplete_duration_evidence",
            "version_count": snapshots.len(),
            "known_version_count": known_versions.len()
        });
    }
    let baseline = known_versions[0];
    let candidate = known_versions[known_versions.len() - 1];
    let baseline_success = baseline.succeeded as f64 / baseline.calls as f64;
    let candidate_success = candidate.succeeded as f64 / candidate.calls as f64;
    let success_rate_delta = candidate_success - baseline_success;
    let duration_delta = candidate.average_duration_ms.unwrap_or(0.0)
        - baseline.average_duration_ms.unwrap_or(0.0);
    json!({
        "status": "complete",
        "baseline_version": baseline.version,
        "candidate_version": candidate.version,
        "baseline_calls": baseline.calls,
        "candidate_calls": candidate.calls,
        "success_rate_delta": success_rate_delta,
        "duration_ms_delta": duration_delta,
        "regression": success_rate_delta < 0.0 || duration_delta > 0.0
    })
}

struct Window {
    from: String,
    to: String,
    start_ms: i64,
    end_ms: i64,
}

struct RetryEvent {
    session_key: String,
    capability_id: String,
    invocation_fingerprint: String,
    event_type: String,
    outcome: String,
    event_ts_ms: i64,
}

fn retry_chain_rows(events: &[RetryEvent]) -> (Vec<Value>, bool) {
    let mut grouped = std::collections::BTreeMap::<(String, String, String), Vec<&RetryEvent>>::new();
    for event in events {
        grouped
            .entry((
                event.session_key.clone(),
                event.capability_id.clone(),
                event.invocation_fingerprint.clone(),
            ))
            .or_default()
            .push(event);
    }
    let mut chains = Vec::new();
    let mut complete = !events.is_empty();
    for ((_, capability_id, _invocation_fingerprint), mut group) in grouped {
        group.sort_by_key(|event| event.event_ts_ms);
        let invocations = group.iter().filter(|event| event.event_type == "tool_invoked").count() as i64;
        let finished = group.iter().filter(|event| event.event_type == "tool_finished").count() as i64;
        if invocations == 0 || finished < invocations {
            complete = false;
        }
        let mut attempts = 0_i64;
        let mut failures = 0_i64;
        let mut failed_before_retry = false;
        let mut recovered = false;
        let mut first_ms = 0_i64;
        let mut last_ms = 0_i64;
        for event in group {
            if first_ms == 0 {
                first_ms = event.event_ts_ms;
            }
            last_ms = event.event_ts_ms;
            if event.event_type == "tool_invoked" {
                attempts += 1;
            } else if event.outcome == "failed" && attempts > 0 {
                failures += 1;
                failed_before_retry = true;
            } else if event.outcome == "succeeded" && failed_before_retry && attempts > failures {
                recovered = true;
            }
        }
        if attempts >= 2 && failures > 0 {
            chains.push(json!({
                "capability": capability_id,
                "attempts": attempts,
                "failed_attempts": failures,
                "recovered": recovered,
                "status": if recovered { "recovered" } else { "unrecovered" },
                "first_seen": super::ms_to_rfc3339_beijing(first_ms),
                "last_seen": super::ms_to_rfc3339_beijing(last_ms)
            }));
        }
    }
    (chains, complete)
}

fn load_retry_events(
    conn: &Connection,
    window: &Window,
    harnesses: &[String],
    skills: &[String],
) -> Result<Vec<RetryEvent>, ToolError> {
    let mut sql = String::from(
        "SELECT e.session_key, e.capability_id, e.invocation_fingerprint,
                e.event_type, e.outcome, e.event_ts_ms
         FROM workflow_events e
         LEFT JOIN sessions s ON s.session_key = e.session_key
         WHERE e.event_type IN ('tool_invoked', 'tool_finished')
           AND e.event_ts_ms >= ?1 AND e.event_ts_ms < ?2
           AND e.session_key IS NOT NULL
           AND e.capability_id IS NOT NULL
           AND e.invocation_fingerprint IS NOT NULL",
    );
    let mut values = vec![
        SqlValue::Integer(window.start_ms),
        SqlValue::Integer(window.end_ms),
    ];
    let mut next_param = 3;
    append_scope_filter(&mut sql, &mut values, &mut next_param, harnesses, skills);
    sql.push_str(" ORDER BY e.session_key, e.capability_id, e.invocation_fingerprint, e.event_ts_ms, e.event_id");
    let mut statement = conn
        .prepare(&sql)
        .map_err(|e| ToolError::new("internal_error", format!("retry evidence query failed: {e}")))?;
    let mut rows = statement
        .query(params_from_iter(values.iter()))
        .map_err(|e| ToolError::new("internal_error", format!("retry evidence query failed: {e}")))?;
    let mut events = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| ToolError::new("internal_error", format!("retry evidence row failed: {e}")))?
    {
        events.push(RetryEvent {
            session_key: row.get(0).unwrap_or_default(),
            capability_id: row.get(1).unwrap_or_default(),
            invocation_fingerprint: row.get(2).unwrap_or_default(),
            event_type: row.get(3).unwrap_or_default(),
            outcome: row.get(4).unwrap_or_default(),
            event_ts_ms: row.get(5).unwrap_or(0),
        });
    }
    Ok(events)
}

fn parse_window(args: &Value) -> Result<Window, ToolError> {
    let from = args.get("from").and_then(Value::as_str).ok_or_else(|| {
        ToolError::new("invalid_argument", "`from` (YYYY-MM-DD) is required")
    })?;
    let to = args.get("to").and_then(Value::as_str).ok_or_else(|| {
        ToolError::new("invalid_argument", "`to` (YYYY-MM-DD) is required")
    })?;
    let (start_ms, _) = agent_vitals_data::authority_query::beijing_day_bounds_ms(from)
        .ok_or_else(|| ToolError::new("invalid_argument", format!("invalid `from`: {from}")))?;
    let (_, end_ms) = agent_vitals_data::authority_query::beijing_day_bounds_ms(to)
        .ok_or_else(|| ToolError::new("invalid_argument", format!("invalid `to`: {to}")))?;
    if start_ms >= end_ms {
        return Err(ToolError::new("invalid_argument", "`to` must be after `from`"));
    }
    Ok(Window { from: from.to_string(), to: to.to_string(), start_ms, end_ms })
}

fn list_arg(args: &Value, key: &str) -> Result<Vec<String>, ToolError> {
    match args.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value.as_str().filter(|v| !v.is_empty()).map(str::to_string).ok_or_else(|| {
                    ToolError::new("invalid_argument", format!("`{key}` must contain non-empty strings"))
                })
            })
            .collect(),
        Some(_) => Err(ToolError::new("invalid_argument", format!("`{key}` must be an array"))),
    }
}

fn limit_arg(args: &Value) -> Result<i64, ToolError> {
    match args.get("limit") {
        None => Ok(50),
        Some(value) => {
            let limit = value.as_i64().ok_or_else(|| ToolError::new("invalid_argument", "`limit` must be an integer"))?;
            if !(1..=200).contains(&limit) {
                return Err(ToolError::new("invalid_argument", "`limit` must be between 1 and 200"));
            }
            Ok(limit)
        }
    }
}

fn append_scope_filter(
    sql: &mut String,
    values: &mut Vec<SqlValue>,
    next_param: &mut usize,
    harnesses: &[String],
    capabilities: &[String],
) {
    if !harnesses.is_empty() {
        let placeholders = (0..harnesses.len())
            .map(|_| {
                let value = format!("?{next_param}");
                *next_param += 1;
                value
            })
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(" AND s.harness IN ({placeholders})"));
        values.extend(harnesses.iter().cloned().map(SqlValue::Text));
    }
    if !capabilities.is_empty() {
        let placeholders = (0..capabilities.len())
            .map(|_| {
                let value = format!("?{next_param}");
                *next_param += 1;
                value
            })
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(" AND e.capability_id IN ({placeholders})"));
        values.extend(capabilities.iter().cloned().map(SqlValue::Text));
    }
}

fn append_event_type_filter(
    sql: &mut String,
    values: &mut Vec<SqlValue>,
    next_param: &mut usize,
    event_types: &[&str],
) {
    if event_types.is_empty() {
        return;
    }
    let placeholders = (0..event_types.len())
        .map(|_| {
            let value = format!("?{next_param}");
            *next_param += 1;
            value
        })
        .collect::<Vec<_>>()
        .join(",");
    sql.push_str(&format!(" AND e.event_type IN ({placeholders})"));
    values.extend(
        event_types
            .iter()
            .map(|event_type| SqlValue::Text((*event_type).to_string())),
    );
}

fn workflow_count(
    conn: &Connection,
    window: &Window,
    harnesses: &[String],
    capabilities: &[String],
    event_types: &[&str],
) -> Result<i64, ToolError> {
    let mut sql = String::from(
        "SELECT COUNT(*) FROM workflow_events e
         LEFT JOIN sessions s ON s.session_key = e.session_key
         WHERE e.event_ts_ms >= ?1 AND e.event_ts_ms < ?2",
    );
    let mut values = vec![
        SqlValue::Integer(window.start_ms),
        SqlValue::Integer(window.end_ms),
    ];
    let mut next_param = 3;
    append_scope_filter(&mut sql, &mut values, &mut next_param, harnesses, capabilities);
    append_event_type_filter(&mut sql, &mut values, &mut next_param, event_types);
    conn.query_row(&sql, params_from_iter(values.iter()), |row| row.get(0))
        .map_err(|e| ToolError::new("internal_error", format!("workflow event count failed: {e}")))
}

fn workflow_harnesses(
    conn: &Connection,
    window: &Window,
    harnesses: &[String],
    capabilities: &[String],
    event_types: &[&str],
) -> Result<Vec<String>, ToolError> {
    let mut sql = String::from(
        "SELECT DISTINCT s.harness FROM workflow_events e
         JOIN sessions s ON s.session_key = e.session_key
         WHERE e.event_ts_ms >= ?1 AND e.event_ts_ms < ?2
           AND s.harness IS NOT NULL",
    );
    let mut values = vec![
        SqlValue::Integer(window.start_ms),
        SqlValue::Integer(window.end_ms),
    ];
    let mut next_param = 3;
    append_scope_filter(&mut sql, &mut values, &mut next_param, harnesses, capabilities);
    append_event_type_filter(&mut sql, &mut values, &mut next_param, event_types);
    sql.push_str(" ORDER BY s.harness");
    let mut statement = conn
        .prepare(&sql)
        .map_err(|e| ToolError::new("internal_error", format!("workflow harness coverage query failed: {e}")))?;
    let mut rows = statement
        .query(params_from_iter(values.iter()))
        .map_err(|e| ToolError::new("internal_error", format!("workflow harness coverage query failed: {e}")))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| ToolError::new("internal_error", format!("workflow harness coverage row failed: {e}")))?
    {
        out.push(
            row.get(0)
                .map_err(|e| ToolError::new("internal_error", format!("workflow harness coverage row failed: {e}")))?,
        );
    }
    Ok(out)
}

fn coverage(
    conn: &Connection,
    window: &Window,
    observed: i64,
    harnesses: &[String],
    capabilities: &[String],
    event_types: &[&str],
    missing: &[String],
) -> Result<Value, ToolError> {
    let observed_harnesses = workflow_harnesses(conn, window, harnesses, capabilities, event_types)?;
    // M4-1：`missing.is_empty()` 是本层**唯一**能报 complete 的判据。此前这里
    // 只有 unavailable / partial 两个分支，等于把「证据齐全」与「证据不全」都压成
    // partial——工具在结构上永远无法毕业，与真实数据质量无关。
    //
    // 反转后的代价：判「还缺什么」的责任完全落在调用方算出的 `missing` 上。调用方
    // **少报**一项，这里就会错报 complete（正是本仓库反复栽的「缺失被渲染成完成」）。
    // 因此每个 `missing` 项都必须是可复算的 SQL 条件，不得是固定字面量。
    let status = if observed == 0 {
        "unavailable"
    } else if missing.is_empty() {
        "complete"
    } else {
        "partial"
    };
    Ok(json!({
        "status": status,
        "source": "workflow_events",
        "observed_events": observed,
        "observed_harnesses": observed_harnesses,
        "harness_scope": if harnesses.is_empty() { Value::String("observed_harnesses".to_string()) } else { json!(harnesses) },
        "requested_from": super::ms_to_rfc3339_beijing(window.start_ms),
        "requested_to": super::ms_to_rfc3339_beijing(window.end_ms),
        "missing": missing,
        "reason": if observed == 0 {
            "no accepted workflow events match the requested window and filters"
        } else if missing.is_empty() {
            "all required workflow evidence is present for the requested window and filters"
        } else {
            "workflow lifecycle and token/cost attribution evidence is still incomplete"
        },
        "harness_absence_is_not_missing": true
    }))
}

pub fn run_issues(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let window = parse_window(args)?;
    let harnesses = list_arg(args, "harnesses")?;
    let skills = list_arg(args, "skills")?;
    let group_by = args.get("group_by").and_then(Value::as_str).unwrap_or("category");
    if !matches!(group_by, "category" | "fingerprint" | "capability") {
        return Err(ToolError::new("invalid_argument", "`group_by` must be category, fingerprint, or capability"));
    }
    let limit = limit_arg(args)?;
    let mut warnings = Vec::new();
    let handle = AuthorityHandle::open(data_home)?;
    let salt = super::session_ref::load_or_create_salt(data_home)?;
    check_as_of_run_id(handle.conn(), args, &mut warnings)?;

    let mut filter_sql = String::new();
    let mut values = vec![
        SqlValue::Integer(window.start_ms),
        SqlValue::Integer(window.end_ms),
    ];
    let mut next_param = 3;
    if !harnesses.is_empty() {
        let placeholders = (0..harnesses.len())
            .map(|_| {
                let value = format!("?{next_param}");
                next_param += 1;
                value
            })
            .collect::<Vec<_>>()
            .join(",");
        filter_sql.push_str(&format!(" AND s.harness IN ({placeholders})"));
        values.extend(harnesses.iter().cloned().map(SqlValue::Text));
    }
    if !skills.is_empty() {
        let placeholders = (0..skills.len())
            .map(|_| {
                let value = format!("?{next_param}");
                next_param += 1;
                value
            })
            .collect::<Vec<_>>()
            .join(",");
        filter_sql.push_str(&format!(" AND e.capability_id IN ({placeholders})"));
        values.extend(skills.iter().cloned().map(SqlValue::Text));
    }
    let limit_param = next_param;
    values.push(SqlValue::Integer(limit));
    let sql = format!(
        "WITH scoped AS (
           SELECT e.event_type, e.capability_id, e.error_fingerprint,
                  e.invocation_fingerprint, e.outcome, e.event_ts_ms,
                  e.session_key
           FROM workflow_events e
           LEFT JOIN sessions s ON s.session_key = e.session_key
           WHERE e.event_ts_ms >= ?1 AND e.event_ts_ms < ?2
             AND (e.error_fingerprint IS NOT NULL OR e.outcome = 'failed'
                  OR e.event_type = 'approval_denied'
                  OR e.event_type = 'tool_invoked'){filter_sql}
        ), grouped AS (
           SELECT CASE
                    WHEN error_fingerprint IS NOT NULL THEN 'error_fingerprint'
                    WHEN event_type = 'approval_denied' THEN 'approval_denied'
                    WHEN event_type = 'tool_invoked' THEN 'repeated_tool_call'
                    ELSE 'failed_workflow'
                  END AS category,
                  COALESCE(error_fingerprint, invocation_fingerprint,
                           capability_id, event_type) AS safe_key,
                  COUNT(*) AS occurrences,
                  COUNT(DISTINCT session_key) AS sessions,
                  MIN(event_ts_ms) AS first_ms,
                  MAX(event_ts_ms) AS last_ms
           FROM scoped
           GROUP BY category, safe_key
        )
        SELECT category, safe_key, occurrences, sessions, first_ms, last_ms
        FROM grouped
        WHERE category != 'repeated_tool_call' OR occurrences > 1
        ORDER BY occurrences DESC, category, safe_key
        LIMIT ?{limit_param}"
    );
    let mut statement = handle.conn().prepare(&sql)
        .map_err(|e| ToolError::new("internal_error", format!("issues summary query failed: {e}")))?;
    let mut rows = statement.query(params_from_iter(values.iter()))
        .map_err(|e| ToolError::new("internal_error", format!("issues summary query failed: {e}")))?;
    let mut issues = Vec::new();
    while let Some(row) = rows.next().map_err(|e| ToolError::new("internal_error", format!("issues summary row failed: {e}")))? {
        let category: String = row.get(0).map_err(|e| ToolError::new("internal_error", format!("issues summary row failed: {e}")))?;
        let safe_key: String = row.get(1).map_err(|e| ToolError::new("internal_error", format!("issues summary row failed: {e}")))?;
        // 非 error_fingerprint 类别的键可能是参数级调用指纹（可被离线穷举验证）：
        // 出 MCP 前换成安装级加盐伪名。能力名 / 事件类型原样保留。
        let safe_key = if category != "error_fingerprint" && safe_key.starts_with("fnv1a64:") {
            super::session_ref::pseudonym(&salt, &safe_key)
        } else {
            safe_key
        };
        let occurrences: i64 = row.get(2).unwrap_or(0);
        let sessions: i64 = row.get(3).unwrap_or(0);
        let first_ms: i64 = row.get(4).unwrap_or(0);
        let last_ms: i64 = row.get(5).unwrap_or(0);
        issues.push(json!({
        "category": category,
        "fingerprint": safe_key,
        "occurrences": occurrences,
            "is_repeated": occurrences > 1,
            "affected_sessions": sessions,
            "tokens": { "value": Value::Null, "status": "unknown", "reason": "workflow-to-usage attribution is not unique" },
            "cost": { "value": Value::Null, "status": "unknown", "reason": "workflow-to-cost attribution is not unique" },
            "first_seen": super::ms_to_rfc3339_beijing(first_ms),
            "last_seen": super::ms_to_rfc3339_beijing(last_ms),
            "trend": { "status": "unknown", "reason": "workflow baseline is not complete" }
        }));
    }
    let retry_event_types = ["tool_invoked", "tool_finished"];
    let retry_observed = workflow_count(
        handle.conn(),
        &window,
        &harnesses,
        &skills,
        &retry_event_types,
    )?;
    let retry_events = load_retry_events(handle.conn(), &window, &harnesses, &skills)?;
    let (retry_chains, retry_events_complete) = retry_chain_rows(&retry_events);
    let retry_evidence_status = if retry_observed == 0 {
        "unavailable"
    } else if retry_events_complete && retry_events.len() as i64 == retry_observed {
        "complete"
    } else {
        "partial"
    };
    let observed = workflow_count(handle.conn(), &window, &harnesses, &skills, &[])?;
    if observed == 0 {
        warnings.push(json!({ "code": "workflow_coverage_insufficient", "message": "No accepted workflow events fall in the requested window; an empty issue list is not a proof of no issues." }));
    }
    // M4-1：本项**仍是固定字面量，因为它描述的是真实的缺口**——「workflow 事件 →
    // usage/cost 的唯一链接」目前不存在（M4-6 未实现，见
    // `docs/v1.0.0/M4_MCP_CLOSURE_CHECKLIST.md`）。它不是结构遗留：M4-6 落地后
    // 这里应改为可复算的判据（能证明唯一性才不报），届时 `missing` 清空，
    // coverage 会自动从 partial 升为 complete，无需再动 `coverage()` 本身。
    let mut issue_missing = vec!["unique token/cost linkage".to_string()];
    if retry_evidence_status != "complete" {
        issue_missing.push("complete retry baseline".to_string());
    }
    let recovered_chains = retry_chains
        .iter()
        .filter(|row| row["status"] == "recovered")
        .count();
    let cov = coverage(
        handle.conn(),
        &window,
        observed,
        &harnesses,
        &skills,
        &[],
        &issue_missing,
    )?;
    Ok(build_envelope(handle.conn(), handle.authority_state(), (observed > 0).then_some(window.end_ms), cov, warnings, json!({
        "from": window.from,
        "to": window.to,
        "issues": issues,
        "retry_chains": retry_chains,
        "retry_evidence": {
            "status": retry_evidence_status,
            "observed_events": retry_observed,
            "fingerprinted_events": retry_events.len(),
            "recovered_chains": recovered_chains
        },
        "has_more": false,
        "next_cursor": Value::Null
    })))
}

fn skill_coverage_missing(
    conn: &Connection,
    window: &Window,
    skills: &[String],
) -> Result<Vec<String>, ToolError> {
    let mut sql = String::from(
        "SELECT
             SUM(CASE WHEN e.event_type='skill_invoked' THEN 1 ELSE 0 END),
             SUM(CASE WHEN e.event_type='skill_finished' THEN 1 ELSE 0 END),
             SUM(CASE WHEN e.event_type='skill_finished' AND e.duration_ms IS NOT NULL THEN 1 ELSE 0 END)
         FROM workflow_events e
         WHERE e.event_type IN ('skill_invoked', 'skill_finished')
           AND e.event_ts_ms >= ?1 AND e.event_ts_ms < ?2
           AND e.capability_id IS NOT NULL",
    );
    let mut values = vec![
        SqlValue::Integer(window.start_ms),
        SqlValue::Integer(window.end_ms),
    ];
    let mut next_param = 3;
    append_scope_filter(&mut sql, &mut values, &mut next_param, &[], skills);
    let (calls, finished, durations): (i64, i64, i64) = conn
        .query_row(&sql, params_from_iter(values.iter()), |row| {
            Ok((
                row.get(0).unwrap_or(0),
                row.get(1).unwrap_or(0),
                row.get(2).unwrap_or(0),
            ))
        })
        .map_err(|e| ToolError::new("internal_error", format!("skill coverage query failed: {e}")))?;
    let mut missing = Vec::new();
    if finished < calls {
        missing.push("skill_finished".to_string());
    }
    if durations < calls {
        missing.push("complete duration".to_string());
    }
    missing.push("unique token/cost linkage".to_string());
    Ok(missing)
}

pub fn run_skills(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let window = parse_window(args)?;
    let skills = list_arg(args, "skills")?;
    let limit = limit_arg(args)?;
    let sort = args.get("sort").and_then(Value::as_str).unwrap_or("calls");
    if !matches!(sort, "calls" | "failures" | "duration") {
        return Err(ToolError::new("invalid_argument", "`sort` must be calls, failures, or duration"));
    }
    let mut warnings = Vec::new();
    let handle = AuthorityHandle::open(data_home)?;
    check_as_of_run_id(handle.conn(), args, &mut warnings)?;
    let mut filter_sql = String::new();
    let mut values = vec![
        SqlValue::Integer(window.start_ms),
        SqlValue::Integer(window.end_ms),
    ];
    let mut next_param = 3;
    if !skills.is_empty() {
        let placeholders = (0..skills.len())
            .map(|_| {
                let value = format!("?{next_param}");
                next_param += 1;
                value
            })
            .collect::<Vec<_>>()
            .join(",");
        filter_sql.push_str(&format!(" AND capability_id IN ({placeholders})"));
        values.extend(skills.iter().cloned().map(SqlValue::Text));
    }
    let limit_param = next_param;
    values.push(SqlValue::Integer(limit));
    let sql = format!(
        "SELECT capability_id,
                SUM(CASE WHEN event_type='skill_invoked' THEN 1 ELSE 0 END) AS calls,
                COUNT(DISTINCT CASE WHEN event_type='skill_invoked' THEN session_key END) AS sessions,
                SUM(CASE WHEN event_type='skill_finished' AND outcome='succeeded' THEN 1 ELSE 0 END),
                SUM(CASE WHEN event_type='skill_finished' AND outcome='failed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN event_type='skill_finished' AND outcome NOT IN ('succeeded', 'failed') THEN 1 ELSE 0 END),
                AVG(CASE WHEN event_type='skill_finished' THEN duration_ms END),
                SUM(CASE WHEN event_type='skill_finished' THEN 1 ELSE 0 END),
                SUM(CASE WHEN event_type='skill_finished' AND duration_ms IS NOT NULL THEN 1 ELSE 0 END),
                MAX(event_ts_ms)
         FROM workflow_events
         WHERE event_type IN ('skill_invoked', 'skill_finished')
           AND event_ts_ms >= ?1 AND event_ts_ms < ?2
           AND capability_id IS NOT NULL{filter_sql}
         GROUP BY capability_id
         HAVING SUM(CASE WHEN event_type='skill_invoked' THEN 1 ELSE 0 END) > 0
         ORDER BY {} DESC, capability_id
         LIMIT ?{limit_param}",
        match sort {
            "failures" => "SUM(CASE WHEN event_type='skill_finished' AND outcome='failed' THEN 1 ELSE 0 END)",
            "duration" => "COALESCE(AVG(CASE WHEN event_type='skill_finished' THEN duration_ms END),0)",
            _ => "SUM(CASE WHEN event_type='skill_invoked' THEN 1 ELSE 0 END)",
        }
    );
    let mut stmt = handle.conn().prepare(&sql)
        .map_err(|e| ToolError::new("internal_error", format!("skills summary query failed: {e}")))?;
    let mut rows = stmt.query(params_from_iter(values.iter()))
        .map_err(|e| ToolError::new("internal_error", format!("skills summary query failed: {e}")))?;
    let mut out = Vec::new();
    let mut has_comparable_version_baseline = false;
    while let Some(row) = rows.next().map_err(|e| ToolError::new("internal_error", format!("skills summary row failed: {e}")))? {
        let skill: String = row.get(0).map_err(|e| ToolError::new("internal_error", format!("skills summary row failed: {e}")))?;
        let calls: i64 = row.get(1).unwrap_or(0);
        let sessions: i64 = row.get(2).unwrap_or(0);
        let finished_succeeded: i64 = row.get(3).unwrap_or(0);
        let finished_failed: i64 = row.get(4).unwrap_or(0);
        let succeeded = finished_succeeded.clamp(0, calls);
        let failed = finished_failed.clamp(0, calls.saturating_sub(succeeded));
        let unknown = calls.saturating_sub(succeeded).saturating_sub(failed);
        let avg_duration: Option<f64> = row.get(6).unwrap_or(None);
        let finished: i64 = row.get(7).unwrap_or(0);
        let duration_count: i64 = row.get(8).unwrap_or(0);
        let last_ms: i64 = row.get(9).unwrap_or(0);
        let version_snapshots = skill_version_snapshots(handle.conn(), &window, &skill)?;
        let version_regression = skill_version_regression(&version_snapshots);
        if version_regression.get("status").and_then(Value::as_str) == Some("complete") {
            has_comparable_version_baseline = true;
        }
        out.push(json!({
            "skill": skill,
            "calls": calls,
            "sessions": sessions,
            "outcomes": { "succeeded": succeeded, "failed": failed, "unknown": unknown },
            "success_rate": { "numerator": succeeded, "denominator": calls, "coverage": if unknown > 0 { "partial" } else { "complete" }, "value": if unknown > 0 { Value::Null } else { json!(succeeded as f64 / calls.max(1) as f64) } },
            "retry_rate": { "numerator": Value::Null, "denominator": calls, "coverage": "unknown", "value": Value::Null, "reason": "skill invocation fingerprints are not yet paired with a retry lifecycle" },
            "duration_ms": { "average": avg_duration, "coverage": if duration_count >= calls && calls > 0 { "complete" } else if avg_duration.is_some() { "partial" } else { "unknown" } },
            "finished_events": finished,
            "tokens": { "value": Value::Null, "coverage": "unknown", "reason": "workflow-to-usage attribution is not unique" },
            "cost": { "value": Value::Null, "coverage": "unknown", "reason": "workflow-to-cost attribution is not unique" },
            "versions": version_snapshots.iter().map(skill_version_row).collect::<Vec<_>>(),
            "version_regression": version_regression,
            "last_seen": super::ms_to_rfc3339_beijing(last_ms)
        }));
    }
    let skill_event_types = ["skill_invoked", "skill_finished"];
    let observed = workflow_count(handle.conn(), &window, &[], &skills, &skill_event_types)?;
    if observed == 0 {
        warnings.push(json!({ "code": "workflow_coverage_insufficient", "message": "No accepted workflow events fall in the requested window; an empty Skill list is not a proof that no Skill was used." }));
    }
    let skill_missing = skill_coverage_missing(handle.conn(), &window, &skills)?;
    let mut skill_missing = skill_missing;
    if !has_comparable_version_baseline {
        skill_missing.push("comparable Skill version baseline".to_string());
    }
    let cov = coverage(
        handle.conn(),
        &window,
        observed,
        &[],
        &skills,
        &skill_event_types,
        &skill_missing,
    )?;
    Ok(build_envelope(handle.conn(), handle.authority_state(), (observed > 0).then_some(window.end_ms), cov, warnings, json!({
        "from": window.from, "to": window.to, "skills": out, "has_more": false, "next_cursor": Value::Null
    })))
}

#[cfg(test)]
mod tests {
    use super::{RetryEvent, SkillVersionSnapshot, Window, coverage, retry_chain_rows, run_issues, run_skills, skill_version_regression};
    use agent_vitals_data::authority::{AuthorityDb, default_authority_path};
    use agent_vitals_data::fact_writer_sql::SqlFactWriter;
    use agent_vitals_data::workflow::insert_events;
    use agent_vitals_domain::contracts::session_key::SessionKey;
    use agent_vitals_domain::workflow::WorkflowEvent;
    use serde_json::json;

    fn seeded_home() -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!(
            "agent-vitals-workflow-summary-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).expect("home");
        let db = AuthorityDb::open(&default_authority_path(&home), 1).expect("db");
        db.begin_run("workflow-summary-test", "cli", 1)
            .expect("run");
        let source_id = db
            .with_immediate_txn(|conn| {
                SqlFactWriter::new(conn, "workflow-summary-test", 1)?.upsert_batch_source("dsh")
            })
            .expect("source");
        let session_key = SessionKey::new("dsh", "summary-s1", "default", "ns").ledger_key();
        let events = vec![
            WorkflowEvent {
                event_id: "workflow:issue-1".to_string(),
                session_key: Some(session_key.clone()),
                event_ts_ms: 1_700_000_000_000,
                event_type: "tool_finished".to_string(),
                capability_kind: Some("tool".to_string()),
                capability_id: Some("bash".to_string()),
                capability_version: None,
                outcome: "failed".to_string(),
                duration_ms: Some(12),
                error_fingerprint: Some("fnv1a64:error-1".to_string()),
                invocation_fingerprint: Some("fnv1a64:call-1".to_string()),
                error_code: None,
                error_class: None,
                error_excerpt: None,
                args_excerpt: None,
                request_bytes: None,
                result_bytes: None,
                native_event_id: None,
                source_line: None,
                source_byte_offset: None,
            },
            WorkflowEvent {
                event_id: "workflow:skill-alpha".to_string(),
                session_key: Some(session_key.clone()),
                event_ts_ms: 1_700_000_000_100,
                event_type: "skill_invoked".to_string(),
                capability_kind: Some("skill".to_string()),
                capability_id: Some("alpha".to_string()),
                capability_version: Some("1".to_string()),
                outcome: "succeeded".to_string(),
                duration_ms: None,
                error_fingerprint: None,
                invocation_fingerprint: None,
                error_code: None,
                error_class: None,
                error_excerpt: None,
                args_excerpt: None,
                request_bytes: None,
                result_bytes: None,
                native_event_id: None,
                source_line: None,
                source_byte_offset: None,
            },
            WorkflowEvent {
                event_id: "workflow:skill-beta".to_string(),
                session_key: Some(session_key.clone()),
                event_ts_ms: 1_700_000_000_200,
                event_type: "skill_invoked".to_string(),
                capability_kind: Some("skill".to_string()),
                capability_id: Some("beta".to_string()),
                capability_version: Some("2".to_string()),
                outcome: "failed".to_string(),
                duration_ms: None,
                error_fingerprint: None,
                invocation_fingerprint: None,
                error_code: None,
                error_class: None,
                error_excerpt: None,
                args_excerpt: None,
                request_bytes: None,
                result_bytes: None,
                native_event_id: None,
                source_line: None,
                source_byte_offset: None,
            },
            WorkflowEvent {
                event_id: "workflow:skill-beta-finished".to_string(),
                session_key: Some(session_key),
                event_ts_ms: 1_700_000_000_300,
                event_type: "skill_finished".to_string(),
                capability_kind: Some("skill".to_string()),
                capability_id: Some("beta".to_string()),
                capability_version: Some("2".to_string()),
                outcome: "failed".to_string(),
                duration_ms: Some(9),
                error_fingerprint: Some("fnv1a64:skill-error".to_string()),
                invocation_fingerprint: Some("fnv1a64:skill-beta-call".to_string()),
                error_code: None,
                error_class: None,
                error_excerpt: None,
                args_excerpt: None,
                request_bytes: None,
                result_bytes: None,
                native_event_id: None,
                source_line: None,
                source_byte_offset: None,
            },
        ];
        db.with_immediate_txn(|conn| {
            insert_events(conn, &events, &source_id, "workflow-summary-test", 2)
        })
        .expect("events");
        db.finish_run("workflow-summary-test", "succeeded", None, None, 3)
            .expect("finish");
        drop(db);
        home
    }

    #[test]
    fn workflow_mcp_projections_read_redacted_rows_and_apply_skill_filter_before_limit() {
        let home = seeded_home();
        let args = json!({"from": "2023-11-15", "to": "2023-11-15", "limit": 10});
        let issues = run_issues(&args, &home).expect("issues");
        assert_eq!(issues["coverage"]["status"], "partial");
        assert_eq!(issues["coverage"]["observed_events"], 4);
        assert_eq!(issues["coverage"]["observed_harnesses"], json!(["dsh"]));
        assert_eq!(issues["coverage"]["harness_absence_is_not_missing"], true);
        assert!(!issues["coverage"]["missing"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "all harness workflow adapters"));
        assert_eq!(issues["data"]["issues"][0]["tokens"]["value"], serde_json::Value::Null);
        assert!(!issues.to_string().contains("call-1"));

        let filtered = run_issues(
            &json!({"from": "2023-11-15", "to": "2023-11-15", "harnesses": ["codex"]}),
            &home,
        )
        .expect("filtered issues");
        assert_eq!(filtered["coverage"]["status"], "unavailable");
        assert_eq!(filtered["coverage"]["observed_events"], 0);
        assert_eq!(filtered["coverage"]["observed_harnesses"], json!([]));

        let skills = run_skills(
            &json!({"from": "2023-11-15", "to": "2023-11-15", "skills": ["beta"], "limit": 1}),
            &home,
        )
        .expect("skills");
        assert_eq!(skills["data"]["skills"].as_array().unwrap().len(), 1);
        assert_eq!(skills["data"]["skills"][0]["skill"], "beta");
        assert_eq!(skills["coverage"]["observed_events"], 2);
        assert_eq!(skills["coverage"]["observed_harnesses"], json!(["dsh"]));
        assert_eq!(skills["data"]["skills"][0]["outcomes"], json!({"succeeded": 0, "failed": 1, "unknown": 0}));
        assert_eq!(skills["data"]["skills"][0]["finished_events"], 1);
        assert_eq!(skills["data"]["skills"][0]["duration_ms"]["average"], 9.0);
        assert_eq!(skills["coverage"]["missing"], json!([
            "unique token/cost linkage",
            "comparable Skill version baseline"
        ]));
        assert_eq!(skills["data"]["skills"][0]["versions"][0]["version"], "2");
        assert_eq!(skills["data"]["skills"][0]["version_regression"]["status"], "unavailable");
        assert_eq!(skills["data"]["skills"][0]["version_regression"]["reason"], "fewer_than_two_versions");
        std::fs::remove_dir_all(home).ok();
    }

    /// M4-1：`coverage()` 必须有 `complete` 分支，判据是「本次请求范围内 `missing`
    /// 为空且 `observed > 0`」。修复前这里只有 unavailable / partial 两个分支，
    /// 工具在**结构上**永远无法毕业——与真实数据质量无关。
    ///
    /// 这个测试同时钉住反转后的代价：判「还缺什么」的责任落在调用方的 `missing`
    /// 上，少报一项就会错报 complete。
    #[test]
    fn coverage_reports_complete_only_when_no_evidence_is_missing() {
        let home = seeded_home();
        let db = AuthorityDb::open(&default_authority_path(&home), 1).expect("db");
        let window = Window {
            from: "2023-11-15".to_string(),
            to: "2023-11-15".to_string(),
            start_ms: 1_700_000_000_000,
            end_ms: 1_700_000_100_000,
        };
        let harnesses = vec!["dsh".to_string()];
        let call = |observed: i64, missing: &[String]| {
            coverage(db.conn(), &window, observed, &harnesses, &[], &[], missing).expect("coverage")
        };

        // 证据齐全（missing 为空）→ complete（修复前恒为 partial）
        let complete = call(4, &[]);
        assert_eq!(complete["status"], "complete");
        assert_eq!(complete["missing"], json!([]));
        assert_eq!(
            complete["reason"],
            "all required workflow evidence is present for the requested window and filters"
        );

        // 缺一项 → partial，且点名缺项（不得吞掉）
        let partial = call(4, &["unique token/cost linkage".to_string()]);
        assert_eq!(partial["status"], "partial");
        assert_eq!(partial["missing"], json!(["unique token/cost linkage"]));

        // 窗口内无事件 → unavailable 优先于 complete（空结果不是「没问题」）
        let none = call(0, &[]);
        assert_eq!(none["status"], "unavailable");
        assert_eq!(none["observed_events"], 0);

        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn skill_version_regression_requires_evidence_and_compares_time_ordered_versions() {
        let snapshots = vec![
            SkillVersionSnapshot {
                version: "1.0".to_string(),
                calls: 3,
                sessions: 1,
                succeeded: 3,
                failed: 0,
                unknown: 0,
                average_duration_ms: Some(10.0),
                finished_events: 3,
                duration_events: 3,
                first_ms: 100,
                last_ms: 130,
            },
            SkillVersionSnapshot {
                version: "2.0".to_string(),
                calls: 3,
                sessions: 1,
                succeeded: 2,
                failed: 1,
                unknown: 0,
                average_duration_ms: Some(20.0),
                finished_events: 3,
                duration_events: 3,
                first_ms: 200,
                last_ms: 230,
            },
        ];
        let regression = skill_version_regression(&snapshots);
        assert_eq!(regression["status"], "complete");
        assert_eq!(regression["baseline_version"], "1.0");
        assert_eq!(regression["candidate_version"], "2.0");
        assert_eq!(regression["regression"], true);
        assert!((regression["success_rate_delta"].as_f64().unwrap() + 1.0 / 3.0).abs() < f64::EPSILON);
        assert!((regression["duration_ms_delta"].as_f64().unwrap() - 10.0).abs() < f64::EPSILON);

        let insufficient = skill_version_regression(&[
            SkillVersionSnapshot { calls: 2, ..snapshots[0].clone() },
            snapshots[1].clone(),
        ]);
        assert_eq!(insufficient["status"], "unavailable");
        assert_eq!(insufficient["reason"], "sample_below_minimum");
    }

    #[test]
    fn retry_chain_requires_same_redacted_call_shape_and_recovers_after_failure() {
        let events = vec![
            RetryEvent {
                session_key: "session-a".to_string(),
                capability_id: "bash".to_string(),
                invocation_fingerprint: "fnv1a64:shape".to_string(),
                event_type: "tool_invoked".to_string(),
                outcome: "unknown".to_string(),
                event_ts_ms: 100,
            },
            RetryEvent {
                session_key: "session-a".to_string(),
                capability_id: "bash".to_string(),
                invocation_fingerprint: "fnv1a64:shape".to_string(),
                event_type: "tool_finished".to_string(),
                outcome: "failed".to_string(),
                event_ts_ms: 110,
            },
            RetryEvent {
                session_key: "session-a".to_string(),
                capability_id: "bash".to_string(),
                invocation_fingerprint: "fnv1a64:shape".to_string(),
                event_type: "tool_invoked".to_string(),
                outcome: "unknown".to_string(),
                event_ts_ms: 120,
            },
            RetryEvent {
                session_key: "session-a".to_string(),
                capability_id: "bash".to_string(),
                invocation_fingerprint: "fnv1a64:shape".to_string(),
                event_type: "tool_finished".to_string(),
                outcome: "succeeded".to_string(),
                event_ts_ms: 130,
            },
        ];
        let (chains, complete) = retry_chain_rows(&events);
        assert!(complete);
        assert_eq!(chains.len(), 1);
        assert_eq!(chains[0]["attempts"], 2);
        assert_eq!(chains[0]["failed_attempts"], 1);
        assert_eq!(chains[0]["status"], "recovered");
        assert!(!chains[0].to_string().contains("shape"));
    }
}
