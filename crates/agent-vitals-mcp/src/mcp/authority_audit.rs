//! Read-only self-consistency audit for the SQL Authority DB.
//!
//! The audit intentionally returns aggregate evidence only.  It never exposes
//! identity columns or issue payloads and never repairs the database.

use std::path::Path;

use serde_json::{json, Value};

use super::{build_envelope, coverage_not_applicable, AuthorityHandle, ToolError, ToolSpec};

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "authority_audit",
        description: "Internal read-only audit of SQL Authority consistency: token conservation, duplicate and orphan evidence, legacy/realtime separation, authority revision, and registered quality exceptions. Returns exact, explained, or mismatch without repairing the database.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "month": { "type": "string", "description": "Optional statistics month YYYY-MM." },
                "date": { "type": "string", "description": "Optional statistics date YYYY-MM-DD." },
                "harness": { "type": "string", "description": "Optional harness filter." },
                "tolerance_tokens": { "type": "integer", "minimum": 0, "default": 0 }
            },
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "Standard envelope; data.verdict is exact, explained, or mismatch and data.checks contains aggregate evidence only."
        }),
    }
}

pub fn run(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let month = args.get("month").and_then(Value::as_str);
    let date = args.get("date").and_then(Value::as_str);
    if month.is_some() && date.is_some() {
        return Err(ToolError::new("invalid_argument", "provide only one of `month` or `date`"));
    }
    if let Some(value) = month {
        if !valid_month(value) || agent_vitals_data::authority_query::beijing_month_bounds_ms(value).is_none() {
            return Err(ToolError::new("invalid_argument", "`month` must be a valid YYYY-MM"));
        }
    }
    if let Some(value) = date {
        if !valid_date(value) || agent_vitals_data::authority_query::beijing_day_bounds_ms(value).is_none() {
            return Err(ToolError::new("invalid_argument", "`date` must be a valid YYYY-MM-DD"));
        }
    }
    let tolerance = tolerance_from_args(args)?;
    let handle = AuthorityHandle::open(data_home)?;
    let conn = handle.conn();
    let harness = args.get("harness").and_then(Value::as_str);
    let scope = scope_clause(month, date, harness)?;

    let (facts, tokens, legacy_facts, realtime_facts, realtime_tokens) = conn.query_row(
        &format!("SELECT COUNT(*), COALESCE(SUM(uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens), 0), COALESCE(SUM(CASE WHEN observation_kind = 'legacy_aggregate' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN observation_kind != 'legacy_aggregate' THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN observation_kind != 'legacy_aggregate' THEN uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens ELSE 0 END), 0) FROM usage_facts WHERE deleted_at_ms IS NULL AND {}", scope.clause),
        rusqlite::params_from_iter(scope.params.iter()),
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?)),
    ).map_err(|e| ToolError::new("internal_error", format!("authority fact audit failed: {e}")))?;

    let duplicate_groups = scalar(conn, &format!(
        "SELECT COUNT(*) FROM (SELECT harness, machine_namespace, native_session_id, source_event_id, observation_kind, COUNT(*) n FROM usage_facts WHERE deleted_at_ms IS NULL AND {} GROUP BY harness, machine_namespace, native_session_id, source_event_id, observation_kind HAVING n > 1)", scope.clause), &scope.params)?;
    let orphan_sessions = scalar(conn, &format!(
        "SELECT COUNT(*) FROM usage_facts f LEFT JOIN sessions s ON s.session_key = f.session_key WHERE f.deleted_at_ms IS NULL AND f.session_key IS NOT NULL AND s.session_key IS NULL AND {}", scope.clause), &scope.params)?;
    let negative_buckets = scalar(conn, &format!(
        "SELECT COUNT(*) FROM usage_facts WHERE deleted_at_ms IS NULL AND (uncached_input_tokens < 0 OR cache_read_tokens < 0 OR cache_write_tokens < 0 OR output_tokens < 0) AND {}", scope.clause), &scope.params)?;
    let harness_axis_tokens = scalar(conn, &format!(
        "SELECT COALESCE(SUM(t), 0) FROM (SELECT SUM(uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens) t FROM usage_facts WHERE deleted_at_ms IS NULL AND observation_kind != 'legacy_aggregate' AND {} GROUP BY harness)", scope.clause), &scope.params)?;
    let model_axis_tokens = scalar(conn, &format!(
        "SELECT COALESCE(SUM(t), 0) FROM (SELECT SUM(uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens) t FROM usage_facts WHERE deleted_at_ms IS NULL AND observation_kind != 'legacy_aggregate' AND {} GROUP BY harness, provider_id, model_id)", scope.clause), &scope.params)?;
    let harness_conservation_delta = realtime_tokens.saturating_sub(harness_axis_tokens).max(harness_axis_tokens.saturating_sub(realtime_tokens));
    let model_conservation_delta = realtime_tokens.saturating_sub(model_axis_tokens).max(model_axis_tokens.saturating_sub(realtime_tokens));
    let open_quality = scalar(conn, "SELECT COUNT(*) FROM data_quality_issues WHERE resolved_at_ms IS NULL", &[])?;
    let future_revisions = scalar(conn, &format!(
        "SELECT COUNT(*) FROM sync_runs WHERE status = 'succeeded' AND COALESCE(completed_at_ms, started_at_ms) > {}", crate::clock::now_ms()), &[])?;
    let mixed_legacy_groups = scalar(conn, &format!(
        "SELECT COUNT(*) FROM (SELECT harness, COALESCE(source_profile, '') p, date(event_ts_ms / 1000, 'unixepoch') d, MAX(CASE WHEN observation_kind = 'legacy_aggregate' THEN 1 ELSE 0 END) legacy, MAX(CASE WHEN observation_kind != 'legacy_aggregate' THEN 1 ELSE 0 END) realtime FROM usage_facts WHERE deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL AND {} GROUP BY harness, p, d HAVING legacy = 1 AND realtime = 1)", scope.clause), &scope.params)?;

    let structural_mismatch = harness_conservation_delta > tolerance || model_conservation_delta > tolerance
        || duplicate_groups > 0 || orphan_sessions > 0 || negative_buckets > 0
        || future_revisions > 0 || mixed_legacy_groups > 0;
    let verdict = if structural_mismatch { "mismatch" } else if open_quality > 0 { "explained" } else { "exact" };
    let checks = vec![
        check("token_conservation_harness_axis", harness_conservation_delta <= tolerance, harness_conservation_delta, "harness-axis realtime token delta <= tolerance"),
        check("token_conservation_model_axis", model_conservation_delta <= tolerance, model_conservation_delta, "model-axis realtime token delta <= tolerance"),
        check("fact_token_totals_non_negative", negative_buckets == 0, negative_buckets, "zero negative token rows"),
        check("identity_duplicate_groups", duplicate_groups == 0, duplicate_groups, "zero duplicate identity groups"),
        check("session_foreign_keys_resolve", orphan_sessions == 0, orphan_sessions, "zero orphan session references"),
        check("legacy_realtime_axes_separate", mixed_legacy_groups == 0, mixed_legacy_groups, "no harness/profile/day mixes legacy and realtime rows"),
        check("authority_revision_not_in_future", future_revisions == 0, future_revisions, "zero future successful revisions"),
        check("registered_quality_exceptions", open_quality == 0, open_quality, "zero unresolved registered quality issues"),
    ];
    let data = json!({
        "verdict": verdict,
        "scope": { "month": month, "date": date, "harness": harness, "tolerance_tokens": tolerance },
        "facts": facts,
        "total_tokens": tokens,
        "realtime_tokens": realtime_tokens,
        "legacy_facts": legacy_facts,
        "realtime_facts": realtime_facts,
        "checks": checks,
        "quality_exception_count": open_quality,
        "notes": if verdict == "explained" { json!(["open quality issues are registered and remain visible"]) } else { json!([]) },
    });
    Ok(build_envelope(conn, handle.authority_state(), None, coverage_not_applicable(), Vec::new(), data))
}

fn check(name: &str, passed: bool, observed: i64, expected: &str) -> Value {
    json!({ "name": name, "status": if passed { "pass" } else { "fail" }, "observed": observed, "expected": expected })
}

fn scalar(conn: &rusqlite::Connection, sql: &str, params: &[rusqlite::types::Value]) -> Result<i64, ToolError> {
    conn.query_row(sql, rusqlite::params_from_iter(params.iter()), |r| r.get::<_, i64>(0))
        .map_err(|e| ToolError::new("internal_error", format!("authority audit query failed: {e}")))
}

struct Scope {
    clause: String,
    params: Vec<rusqlite::types::Value>,
}

fn scope_clause(month: Option<&str>, date: Option<&str>, harness: Option<&str>) -> Result<Scope, ToolError> {
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    if let Some(value) = month {
        let (start, end) = agent_vitals_data::authority_query::beijing_month_bounds_ms(value)
            .ok_or_else(|| ToolError::new("invalid_argument", "`month` must be a valid YYYY-MM"))?;
        clauses.push("event_ts_ms >= ? AND event_ts_ms < ?".to_string());
        params.push(rusqlite::types::Value::Integer(start));
        params.push(rusqlite::types::Value::Integer(end));
    }
    if let Some(value) = date {
        let (start, end) = agent_vitals_data::authority_query::beijing_day_bounds_ms(value)
            .ok_or_else(|| ToolError::new("invalid_argument", "`date` must be a valid YYYY-MM-DD"))?;
        clauses.push("event_ts_ms >= ? AND event_ts_ms < ?".to_string());
        params.push(rusqlite::types::Value::Integer(start));
        params.push(rusqlite::types::Value::Integer(end));
    }
    if let Some(value) = harness {
        clauses.push("harness = ?".to_string());
        params.push(rusqlite::types::Value::Text(value.to_owned()));
    }
    Ok(Scope { clause: if clauses.is_empty() { "1 = 1".to_string() } else { clauses.join(" AND ") }, params })
}

fn valid_month(value: &str) -> bool {
    value.len() == 7 && value.as_bytes().get(4) == Some(&b'-') && value[..4].bytes().all(|b| b.is_ascii_digit())
        && value[5..].parse::<u8>().is_ok_and(|m| (1..=12).contains(&m))
}

fn valid_date(value: &str) -> bool {
    value.len() == 10 && value.as_bytes().get(4) == Some(&b'-') && value.as_bytes().get(7) == Some(&b'-')
        && value[..4].bytes().all(|b| b.is_ascii_digit()) && value[5..7].parse::<u8>().is_ok_and(|m| (1..=12).contains(&m))
        && value[8..].parse::<u8>().is_ok_and(|d| (1..=31).contains(&d))
}

fn tolerance_from_args(args: &Value) -> Result<i64, ToolError> {
    let tolerance = match args.get("tolerance_tokens") {
        None => 0,
        Some(value) => value.as_i64().ok_or_else(|| {
            ToolError::new("invalid_argument", "`tolerance_tokens` must be a non-negative integer")
        })?,
    };
    if tolerance < 0 {
        return Err(ToolError::new("invalid_argument", "`tolerance_tokens` must be a non-negative integer"));
    }
    Ok(tolerance)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_closed_and_scope_dates_are_validated() {
        assert_eq!(spec().input_schema["additionalProperties"], json!(false));
        assert!(valid_month("2026-09"));
        assert!(!valid_month("2026-13"));
        assert!(valid_date("2026-09-13"));
        assert!(!valid_date("2026-02-99"));
    }

    #[test]
    fn negative_or_non_integer_tolerance_is_rejected_by_the_input_contract() {
        assert_eq!(scope_clause(None, None, None).unwrap().params.len(), 0);
        let negative = serde_json::from_str::<Value>(r#"{"tolerance_tokens":-1}"#).unwrap();
        assert!(tolerance_from_args(&negative).is_err());
        let text = serde_json::from_str::<Value>(r#"{"tolerance_tokens":"1"}"#).unwrap();
        assert!(tolerance_from_args(&text).is_err());
    }
}
