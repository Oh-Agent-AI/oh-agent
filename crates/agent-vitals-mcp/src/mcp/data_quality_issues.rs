//! Typed, redacted reader for `data_quality_issues`.
//!
//! The authority table deliberately keeps the original diagnostic payload for
//! local repair.  This reader never returns that payload wholesale: only the
//! fields in the code-aware allowlist below cross the MCP boundary.

use std::path::Path;

use rusqlite::{params_from_iter, types::Value as SqlValue};
use serde_json::{Map, Value, json};

use super::{AuthorityHandle, ToolError, ToolSpec, build_envelope};

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "data_quality_issues",
        description: "List local data-quality issues with code-aware redaction, stable safe references, scope, severity, and recovery guidance; never expose raw diagnostic payloads.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "status": { "type": "string", "enum": ["open", "resolved", "all"] },
                "severity": { "type": "array", "items": { "type": "string" } },
                "codes": { "type": "array", "items": { "type": "string" } },
                "harnesses": { "type": "array", "items": { "type": "string" } },
                "from": { "type": "string", "description": "Inclusive statistics date YYYY-MM-DD." },
                "to": { "type": "string", "description": "Inclusive statistics date YYYY-MM-DD." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                "cursor": { "type": "string" }
            },
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "Standard envelope; data.issues contains safe issue references and allowlisted detail only."
        }),
    }
}

fn list_arg(args: &Value, key: &str) -> Result<Vec<String>, ToolError> {
    match args.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value.as_str().filter(|value| !value.is_empty()).map(str::to_string).ok_or_else(|| {
                    ToolError::new("invalid_argument", format!("`{key}` must contain non-empty strings"))
                })
            })
            .collect(),
        Some(_) => Err(ToolError::new("invalid_argument", format!("`{key}` must be an array"))),
    }
}

fn limit_arg(args: &Value) -> Result<usize, ToolError> {
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(50);
    if !(1..=200).contains(&limit) {
        return Err(ToolError::new("invalid_argument", "`limit` must be between 1 and 200"));
    }
    Ok(limit as usize)
}

fn date_bound(args: &Value, key: &str, end: bool) -> Result<Option<i64>, ToolError> {
    let Some(date) = args.get(key).and_then(Value::as_str) else {
        return Ok(None);
    };
    let (start_ms, end_ms) = agent_vitals_data::authority_query::beijing_day_bounds_ms(date)
        .ok_or_else(|| ToolError::new("invalid_argument", format!("invalid `{key}`: {date}")))?;
    Ok(Some(if end { end_ms } else { start_ms }))
}

fn allowed_harness(value: &str) -> bool {
    matches!(value, "claude-code" | "codex" | "dsh" | "workbuddy")
}

fn safe_month(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    (value.is_ascii()
        && value.len() == 7
        && value.as_bytes().get(4) == Some(&b'-')
        && value[..4].chars().all(|c| c.is_ascii_digit())
        && value[5..].chars().all(|c| c.is_ascii_digit()))
        .then(|| value.to_string())
}

fn safe_currency(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    (value.len() == 3 && value.chars().all(|c| c.is_ascii_uppercase()))
        .then(|| value.to_string())
}

fn safe_detail(code: &str, raw: &str) -> Value {
    let Ok(detail) = serde_json::from_str::<Value>(raw) else {
        return json!({ "status": "redacted", "available_fields": [] });
    };
    let Some(object) = detail.as_object() else {
        return json!({ "status": "redacted", "available_fields": [] });
    };
    let mut safe = Map::new();
    safe.insert("status".to_string(), json!("redacted"));
    if code == "undated_residual" {
        if let Some(value) = object.get("total_tokens").and_then(Value::as_i64) {
            safe.insert("total_tokens".to_string(), json!(value.max(0)));
        }
        if let Some(models) = object.get("by_model_tokens").and_then(Value::as_object) {
            let by_model = models
                .iter()
                .filter_map(|(model_raw, tokens)| {
                    tokens.as_i64().map(|tokens| json!({ "model_raw": model_raw, "tokens": tokens.max(0) }))
                })
                .collect::<Vec<_>>();
            safe.insert("by_model".to_string(), json!(by_model));
        }
    } else if code == "missing_sid" {
        if let Some(harness) = object.get("source_harness").and_then(Value::as_str).filter(|harness| allowed_harness(harness)) {
            safe.insert("source_harness".to_string(), json!(harness));
        }
        if let Some(reason) = object.get("reason").and_then(Value::as_str).filter(|reason| {
            matches!(*reason, "missing_native_session_id" | "source_missing" | "unattached_event")
        }) {
            safe.insert("reason".to_string(), json!(reason));
        }
    } else if code.starts_with("legacy_aggregate") {
        for key in ["month", "harness", "coverage_kind"] {
            let Some(value) = object.get(key) else { continue };
            let allowed = match key {
                "month" => safe_month(value),
                "harness" => value.as_str().filter(|harness| allowed_harness(harness)).map(str::to_string),
                _ => value.as_str().filter(|kind| matches!(*kind, "base" | "peak" | "coverage" | "explained")).map(str::to_string),
            };
            if let Some(value) = allowed {
                safe.insert(key.to_string(), json!(value));
            }
        }
    } else if code == "reconcile_exception" {
        for key in ["month", "harness", "basis", "currency", "amount_minor", "kind"] {
            let Some(value) = object.get(key) else { continue };
            if key == "amount_minor" {
                if let Some(amount) = value.as_i64() {
                    safe.insert(key.to_string(), json!(amount.max(0)));
                }
                continue;
            }
            let allowed = match key {
                "month" => safe_month(value),
                "harness" => value.as_str().filter(|harness| allowed_harness(harness)).map(str::to_string),
                "currency" => safe_currency(value),
                "kind" => value.as_str().filter(|kind| matches!(*kind, "exact" | "explained")).map(str::to_string),
                _ => value.as_str().filter(|value| value.len() <= 64 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')).map(str::to_string),
            };
            if let Some(value) = allowed {
                safe.insert(key.to_string(), json!(value));
            }
        }
    } else if code == "snapshot_drift" {
        for key in ["requested", "current"] {
            if let Some(value) = object.get(key).and_then(Value::as_str).filter(|value| value.len() <= 128 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
                safe.insert(key.to_string(), json!(value));
            }
        }
    } else {
        safe.insert("code".to_string(), json!(code));
        safe.insert("count".to_string(), json!(1));
    }
    safe.insert("available_fields".to_string(), json!(safe.keys().filter(|key| *key != "status" && *key != "available_fields").cloned().collect::<Vec<_>>()));
    Value::Object(safe)
}

fn category(code: &str) -> &'static str {
    if code.contains("price") || code.contains("route") || code.contains("billing") {
        "billing"
    } else if code.contains("source") || code.contains("permission") || code.contains("parse") || code.contains("read") || code.contains("session") {
        "source"
    } else {
        "data_quality"
    }
}

fn remedy(code: &str) -> &'static str {
    if code.contains("source") || code.contains("permission") || code.contains("read") {
        "retry_sync"
    } else if code.contains("price") || code.contains("route") {
        "review_pricing_or_billing"
    } else if code.starts_with("legacy_aggregate") || code == "undated_residual" {
        "review_legacy_coverage"
    } else {
        "review_data_quality"
    }
}

fn safe_issue_id(issue_id: &str) -> String {
    format!("qi_{}", agent_vitals_domain::source_identity::fnv1a64_hex(issue_id.as_bytes()))
}

pub fn run(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let status = args.get("status").and_then(Value::as_str).unwrap_or("open");
    if !matches!(status, "open" | "resolved" | "all") {
        return Err(ToolError::new("invalid_argument", "`status` must be open, resolved, or all"));
    }
    let severities = list_arg(args, "severity")?;
    let codes = list_arg(args, "codes")?;
    let harnesses = list_arg(args, "harnesses")?;
    let from_ms = date_bound(args, "from", false)?;
    let to_ms = date_bound(args, "to", true)?;
    if from_ms.zip(to_ms).is_some_and(|(from, to)| from >= to) {
        return Err(ToolError::new("invalid_argument", "`to` must be after `from`"));
    }
    let limit = limit_arg(args)?;
    let cursor = args.get("cursor").and_then(Value::as_str);
    let handle = AuthorityHandle::open(data_home)?;
    let mut warnings = Vec::new();
    super::check_as_of_run_id(handle.conn(), args, &mut warnings)?;

    let mut sql = String::from(
        "SELECT issue_id, scope_type, code, severity,
                first_seen_at_ms, last_seen_at_ms, resolved_at_ms, detail_json
         FROM data_quality_issues WHERE 1=1",
    );
    let mut values = Vec::<SqlValue>::new();
    let mut next = 1;
    if status == "open" {
        sql.push_str(" AND resolved_at_ms IS NULL");
    } else if status == "resolved" {
        sql.push_str(" AND resolved_at_ms IS NOT NULL");
    }
    if !severities.is_empty() {
        let placeholders = (0..severities.len()).map(|_| { let value = format!("?{next}"); next += 1; value }).collect::<Vec<_>>().join(",");
        sql.push_str(&format!(" AND severity IN ({placeholders})"));
        values.extend(severities.iter().cloned().map(SqlValue::Text));
    }
    if !codes.is_empty() {
        let placeholders = (0..codes.len()).map(|_| { let value = format!("?{next}"); next += 1; value }).collect::<Vec<_>>().join(",");
        sql.push_str(&format!(" AND code IN ({placeholders})"));
        values.extend(codes.iter().cloned().map(SqlValue::Text));
    }
    if let Some(from) = from_ms {
        sql.push_str(&format!(" AND last_seen_at_ms >= ?{next}"));
        next += 1;
        values.push(SqlValue::Integer(from));
    }
    if let Some(to) = to_ms {
        sql.push_str(&format!(" AND first_seen_at_ms < ?{next}"));
        values.push(SqlValue::Integer(to));
    }
    sql.push_str(" ORDER BY issue_id");
    let mut statement = handle.conn().prepare(&sql)
        .map_err(|e| ToolError::new("internal_error", format!("data quality query failed: {e}")))?;
    let rows = statement.query_map(params_from_iter(values.iter()), |row| {
        Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?,
            row.get::<_, Option<i64>>(6)?, row.get::<_, String>(7)?,
        ))
    }).map_err(|e| ToolError::new("internal_error", format!("data quality query failed: {e}")))?;
    let mut all = Vec::new();
    for row in rows {
        let (issue_id, scope_type, code, severity, first, last, resolved, detail_raw) = row
            .map_err(|e| ToolError::new("internal_error", format!("data quality row failed: {e}")))?;
        let detail = safe_detail(&code, &detail_raw);
        let harness = detail.get("harness").and_then(Value::as_str)
            .or_else(|| detail.get("source_harness").and_then(Value::as_str));
        if !harnesses.is_empty() && !harness.is_some_and(|harness| harnesses.iter().any(|wanted| wanted == harness)) {
            continue;
        }
        let safe_id = safe_issue_id(&issue_id);
        all.push((safe_id.clone(), json!({
            "issue_id": safe_id,
            "category": category(&code),
            "scope": scope_type,
            "harness": harness,
            "code": code,
            "severity": severity,
            "first_seen": super::ms_to_rfc3339_beijing(first),
            "last_seen": super::ms_to_rfc3339_beijing(last),
            "status": if resolved.is_some() { "resolved" } else { "open" },
            "occurrences": 1,
            "occurrence_basis": "one_authority_issue_row",
            "detail": detail,
            "recovery_action": remedy(&code)
        })));
    }
    let start = cursor.map(|cursor| all.iter().position(|(safe_id, _)| safe_id == cursor).map(|index| index + 1).ok_or_else(|| ToolError::new("invalid_argument", "unknown data quality cursor"))).transpose()?.unwrap_or(0);
    let end = (start + limit).min(all.len());
    let page = all[start..end].iter().map(|(_, row)| row.clone()).collect::<Vec<_>>();
    let has_more = end < all.len();
    let next_cursor = if has_more { all.get(end - 1).map(|(safe_id, _)| json!(safe_id)) } else { None };
    Ok(build_envelope(handle.conn(), handle.authority_state(), None,
        json!({ "status": "complete", "source": "data_quality_issues", "observed_events": all.len(), "missing": [] }),
        warnings, json!({
            "issues": page,
            "has_more": has_more,
            "next_cursor": next_cursor.unwrap_or(Value::Null)
        })))
}

#[cfg(test)]
mod tests {
    use super::safe_detail;
    use serde_json::json;

    #[test]
    fn detail_allowlist_drops_raw_fields_and_keeps_only_known_values() {
        let raw = json!({
            "total_tokens": 12,
            "by_model_tokens": {"model-a": 12},
            "native_session_id": "secret",
            "path": "/Users/secret"
        }).to_string();
        let detail = safe_detail("undated_residual", &raw);
        assert_eq!(detail["total_tokens"], 12);
        assert!(detail["native_session_id"].is_null());
        assert!(!detail.to_string().contains("secret"));
        assert_eq!(safe_detail("unknown_code", &json!({"path": "/Users/secret"}).to_string())["code"], "unknown_code");
    }
}
