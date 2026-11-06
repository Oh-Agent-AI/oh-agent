//! Cost breakdown over the SQL authority facts.
//!
//! The SQL layer selects the price snapshot that was captured before each
//! fact's event time.  The domain cost engine prices one harness/model/snapshot
//! bucket, so rounding happens once at the finest exposed bucket and parents
//! are formed by summing integer minor units.  Subscription facts and missing
//! price evidence remain visible as tokens with a null amount.

use std::collections::BTreeMap;
use std::path::Path;

use agent_vitals_domain::data_contract::MoneyMinor;
use serde_json::{json, Value};

use crate::envelope::{build_envelope, AuthorityHandle, ToolError, ToolSpec};

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "cost_breakdown",
        description: "Break down metered estimates and subscription-covered usage by harness, provider, model, and historical price version. Prices are selected at fact time; currencies and billing bases are never combined, and unresolved tokens remain visible.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "from": { "type": "string", "description": "Inclusive statistics date YYYY-MM-DD." },
                "to": { "type": "string", "description": "Inclusive statistics date YYYY-MM-DD; the full day through `to` is included." },
                "compare_to_previous": { "type": "boolean", "default": false },
                "group_by": {
                    "type": "array",
                    "items": { "type": "string", "enum": ["harness", "provider", "model", "basis"] },
                    "description": "Requested display dimensions. Fact-time price-version rows remain separate for auditability."
                },
                "harnesses": { "type": "array", "items": { "type": "string" }, "description": "Optional harness filter." }
            },
            "required": ["from", "to"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "Standard envelope; data.breakdown contains token/cost rows and data.amounts never combines currencies or billing bases."
        }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct BucketKey {
    harness: String,
    provider_id: Option<String>,
    provider_raw: Option<String>,
    model: String,
    billing_mode: String,
    pricing_basis: String,
    evidence_basis: String,
    billing_template_id: Option<String>,
    pricing_version: Option<String>,
    pricing_source: Option<String>,
    captured_at_ms: Option<i64>,
}

#[derive(Debug, Default, Clone)]
struct Tokens {
    uncached_input: i64,
    cache_read: i64,
    cache_write: i64,
    output: i64,
    peak_uncached_input: i64,
    peak_cache_read: i64,
    peak_cache_write: i64,
    peak_output: i64,
    max_event_ms: i64,
}

impl Tokens {
    fn add(&mut self, peak: i64, row: (i64, i64, i64, i64, i64)) {
        self.uncached_input += row.0;
        self.cache_read += row.1;
        self.cache_write += row.2;
        self.output += row.3;
        if peak != 0 {
            self.peak_uncached_input += row.0;
            self.peak_cache_read += row.1;
            self.peak_cache_write += row.2;
            self.peak_output += row.3;
        }
        self.max_event_ms = self.max_event_ms.max(row.4);
    }

    fn total(&self) -> i64 {
        self.uncached_input + self.cache_read + self.cache_write + self.output
    }

    fn peak_total(&self) -> i64 {
        self.peak_uncached_input + self.peak_cache_read + self.peak_cache_write + self.peak_output
    }
}

pub struct WindowResult {
    pub rows: Vec<Value>,
    pub total_tokens: i64,
    pub priced_tokens: i64,
    pub unresolved_tokens: i64,
    pub subscription_tokens: i64,
    /// `{amount_minor, currency, basis}` rows — never combined across currency or basis.
    pub amounts: Vec<Value>,
    pub(crate) max_event_ms: Option<i64>,
    pub(crate) has_unresolved: bool,
}

pub fn run(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let from = args.get("from").and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("invalid_argument", "`from` (YYYY-MM-DD) is required"))?;
    let to = args.get("to").and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("invalid_argument", "`to` (YYYY-MM-DD) is required"))?;
    let (start_ms, _) = agent_vitals_data::authority_query::beijing_day_bounds_ms(from)
        .ok_or_else(|| ToolError::new("invalid_argument", format!("invalid `from`: {from}")))?;
    let (_, end_ms) = agent_vitals_data::authority_query::beijing_day_bounds_ms(to)
        .ok_or_else(|| ToolError::new("invalid_argument", format!("invalid `to`: {to}")))?;
    if start_ms >= end_ms {
        return Err(ToolError::new("invalid_argument", "`to` must be after `from`"));
    }
    let compare = match args.get("compare_to_previous") {
        None => false,
        Some(value) => value.as_bool().ok_or_else(|| ToolError::new("invalid_argument", "`compare_to_previous` must be boolean"))?,
    };
    let group_by = parse_group_by(args)?;
    let harnesses = parse_harnesses(args)?;
    let handle = AuthorityHandle::open(data_home)?;
    let current = collect_window(handle.conn(), start_ms, end_ms, &harnesses, &group_by)?;
    let previous = if compare {
        let width = end_ms.checked_sub(start_ms)
            .ok_or_else(|| ToolError::new("invalid_argument", "date range is too wide"))?;
        let previous_start = start_ms.checked_sub(width)
            .ok_or_else(|| ToolError::new("invalid_argument", "previous comparison range is out of bounds"))?;
        Some(collect_window(handle.conn(), previous_start, start_ms, &harnesses, &group_by)?)
    } else {
        None
    };
    let mut data = json!({
        "from": from,
        "to": to,
        "group_by": group_by,
        "harnesses": harnesses,
        "total_tokens": current.total_tokens,
        "priced_tokens": current.priced_tokens,
        "unresolved_tokens": current.unresolved_tokens,
        "subscription_tokens": current.subscription_tokens,
        "has_unresolved": current.has_unresolved,
        "breakdown": current.rows,
        "amounts": current.amounts,
    });
    if let Some(previous) = previous {
        data["comparison"] = json!({
            "window": "previous_equal_duration",
            "total_tokens": previous.total_tokens,
            "priced_tokens": previous.priced_tokens,
            "unresolved_tokens": previous.unresolved_tokens,
            "subscription_tokens": previous.subscription_tokens,
            "has_unresolved": previous.has_unresolved,
            "amounts": previous.amounts,
        });
    }
    let status = if current.has_unresolved { "partial" } else { "complete" };
    let coverage = json!({
        "status": status,
        "requested_from": crate::envelope::ms_to_rfc3339_beijing(start_ms),
        "requested_to": crate::envelope::ms_to_rfc3339_beijing(end_ms),
        "covered_from": crate::envelope::ms_to_rfc3339_beijing(start_ms),
        "covered_to": crate::envelope::ms_to_rfc3339_beijing(end_ms),
        "missing_harnesses": [],
        "priced_tokens": current.priced_tokens,
        "unresolved_tokens": current.unresolved_tokens,
    });
    Ok(build_envelope(
        handle.conn(), handle.authority_state(), current.max_event_ms, coverage,
        Vec::new(), data,
    ))
}

fn parse_group_by(args: &Value) -> Result<Vec<String>, ToolError> {
    let Some(value) = args.get("group_by") else {
        return Ok(vec!["harness".into(), "provider".into(), "model".into(), "basis".into()]);
    };
    let values = value.as_array().ok_or_else(|| ToolError::new("invalid_argument", "`group_by` must be an array"))?;
    let mut out = Vec::new();
    for value in values {
        let item = value.as_str().ok_or_else(|| ToolError::new("invalid_argument", "`group_by` items must be strings"))?;
        if !matches!(item, "harness" | "provider" | "model" | "basis") {
            return Err(ToolError::new("invalid_argument", format!("unsupported group_by dimension `{item}`")));
        }
        if !out.iter().any(|seen| seen == item) {
            out.push(item.to_owned());
        }
    }
    if out.is_empty() {
        return Err(ToolError::new("invalid_argument", "`group_by` must not be empty"));
    }
    Ok(out)
}

fn parse_harnesses(args: &Value) -> Result<Vec<String>, ToolError> {
    let Some(value) = args.get("harnesses") else { return Ok(Vec::new()); };
    let values = value.as_array().ok_or_else(|| ToolError::new("invalid_argument", "`harnesses` must be an array"))?;
    let mut out = Vec::new();
    for value in values {
        let harness = value.as_str().ok_or_else(|| ToolError::new("invalid_argument", "`harnesses` items must be strings"))?;
        if harness.is_empty() { return Err(ToolError::new("invalid_argument", "`harnesses` items must not be empty")); }
        if !out.iter().any(|seen| seen == harness) { out.push(harness.to_owned()); }
    }
    Ok(out)
}

fn collect_window(
    conn: &rusqlite::Connection,
    start_ms: i64,
    end_ms: i64,
    harnesses: &[String],
    group_by: &[String],
) -> Result<WindowResult, ToolError> {
    let mut where_sql = "f.deleted_at_ms IS NULL AND f.observation_kind != 'legacy_aggregate' AND f.event_ts_ms IS NOT NULL AND f.event_ts_ms >= ?1 AND f.event_ts_ms < ?2".to_owned();
    let mut params = vec![
        rusqlite::types::Value::Integer(start_ms),
        rusqlite::types::Value::Integer(end_ms),
    ];
    if !harnesses.is_empty() {
        let placeholders = (0..harnesses.len()).map(|idx| format!("?{}", idx + 3)).collect::<Vec<_>>().join(", ");
        where_sql.push_str(&format!(" AND f.harness IN ({placeholders})"));
        params.extend(harnesses.iter().cloned().map(rusqlite::types::Value::Text));
    }
    price_fact_selection(conn, &where_sql, &params, group_by)
}

/// 对任意 `usage_facts f` 选择谓词做事实时价卡计价。`cost_breakdown` 的时间窗与
/// 计费声明预览（`runtime::billing_preview`，谓词来自
/// `authority::billing_declaration_fact_selection`）共用这一条计价路径——预览
/// 「移出估算 ¥X」与 MCP `cost_breakdown` 的桶金额必须逐位相等（规格 R5），
/// 所以不许第二套价格查询。`where_sql` 可引用 `f`（usage_facts）与 `r`
/// （route_evidence，按 `evidence_id` 主键左连，无扇出）。
pub fn price_fact_selection(
    conn: &rusqlite::Connection,
    where_sql: &str,
    params: &[rusqlite::types::Value],
    group_by: &[String],
) -> Result<WindowResult, ToolError> {
    let has_attributions: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_fact_attributions')
         AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_declaration_revisions')
         AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_recalculation_jobs')",
        [], |row| row.get(0),
    ).map_err(|e| ToolError::new("internal_error", format!("cost attribution capability check failed: {e}")))?;
    let billing_mode_expr = if has_attributions {
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
    let sql = format!(
        "SELECT f.harness, f.provider_id, f.provider_raw, COALESCE(f.model_id, '<unknown>'),
                {billing_mode_expr}, COALESCE(f.pricing_basis, 'unavailable'),
                COALESCE(f.evidence_basis, 'missing'), f.billing_template_id, f.event_peak,
                ps.pricing_version, ps.source_kind, ps.captured_at_ms, ps.payload_json,
                SUM(f.uncached_input_tokens), SUM(f.cache_read_tokens),
                SUM(f.cache_write_tokens), SUM(f.output_tokens), MAX(f.event_ts_ms)
         FROM usage_facts f
         LEFT JOIN route_evidence r ON r.evidence_id = f.route_evidence_id
         LEFT JOIN pricing_snapshots ps ON ps.pricing_version = (
             SELECT pricing_version FROM pricing_snapshots
             WHERE captured_at_ms <= f.event_ts_ms
             ORDER BY captured_at_ms DESC, pricing_version DESC LIMIT 1)
         WHERE {where_sql}
         GROUP BY f.harness, f.provider_id, f.provider_raw, f.model_id, {billing_mode_expr},
                  f.billing_template_id, f.pricing_basis, f.evidence_basis, f.event_peak,
                  ps.pricing_version, ps.source_kind, ps.captured_at_ms, ps.payload_json
         HAVING SUM(f.uncached_input_tokens + f.cache_read_tokens + f.cache_write_tokens + f.output_tokens) > 0
         ORDER BY f.harness, f.provider_id, f.provider_raw, f.model_id, ps.pricing_version, f.event_peak",
        billing_mode_expr = billing_mode_expr,
        where_sql = where_sql,
    );
    let mut stmt = conn.prepare(&sql)
        .map_err(|e| ToolError::new("internal_error", format!("cost breakdown query failed: {e}")))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        Ok((
            row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
            row.get::<_, String>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, i64>(8)?,
            row.get::<_, Option<String>>(9)?, row.get::<_, Option<String>>(10)?, row.get::<_, Option<i64>>(11)?,
            row.get::<_, Option<String>>(12)?, row.get::<_, i64>(13)?, row.get::<_, i64>(14)?,
            row.get::<_, i64>(15)?, row.get::<_, i64>(16)?, row.get::<_, i64>(17)?,
        ))
    }).map_err(|e| ToolError::new("internal_error", format!("cost breakdown query failed: {e}")))?;

    let mut buckets: BTreeMap<BucketKey, Tokens> = BTreeMap::new();
    for row in rows {
        let (harness, provider_id, provider_raw, model, billing_mode, pricing_basis, evidence_basis,
            billing_template_id, peak, pricing_version, pricing_source, captured_at_ms, _payload,
            uncached, cache_read, cache_write, output, max_event_ms) = row.map_err(|e| ToolError::new("internal_error", format!("cost breakdown row failed: {e}")))?;
        let key = BucketKey { harness, provider_id, provider_raw, model, billing_mode, pricing_basis,
            evidence_basis, billing_template_id, pricing_version, pricing_source, captured_at_ms };
        buckets.entry(key).or_default().add(peak, (uncached, cache_read, cache_write, output, max_event_ms));
    }

    let mut rows_out = Vec::new();
    let mut amount_totals: BTreeMap<(String, String), i64> = BTreeMap::new();
    let mut total_tokens = 0i64;
    let mut priced_tokens = 0i64;
    let mut unresolved_tokens = 0i64;
    let mut subscription_tokens = 0i64;
    let mut max_event_ms = None;
    let mut has_unresolved = false;
    let sync_overlay: Option<Value> = agent_vitals_data::authority::latest_pricing_sync_overlay(conn)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    for (key, tokens) in buckets {
        let total = tokens.total();
        total_tokens += total;
        max_event_ms = Some(max_event_ms.unwrap_or(0).max(tokens.max_event_ms));
        let mut amount: Option<MoneyMinor> = None;
        let mut unresolved_reason: Option<&str> = None;
        if key.billing_mode == "subscription" {
            unresolved_reason = Some("subscription token usage is not a per-token bill");
        } else if key.pricing_version.is_none() {
            unresolved_reason = Some("no pricing snapshot covers this event time");
        } else {
            let payload = query_payload_for_bucket(conn, &key)?;
            if let Some(payload) = payload {
                let usage = usage_json(&key.harness, &key.model, &tokens);
                // 当时快照没有这个模型的卡、每日同步后来补上了 → 用补过缺卡的快照计价
                // （只补缺卡，已有价不动）。
                amount = agent_vitals_data::authority_query::price_with_sync_backfill(
                    &key.harness, &usage, Some(&payload), sync_overlay.as_ref(),
                ).0;
                if amount.is_none() {
                    unresolved_reason = Some("no compatible price card for this provider/model bucket");
                } else if key.evidence_basis != "explicit-official-route" {
                    unresolved_reason = Some("route/provider evidence is unresolved; official-card fallback estimate");
                }
            } else {
                unresolved_reason = Some("no pricing snapshot payload");
            }
        }
        let is_unresolved = unresolved_reason.is_some() && key.billing_mode != "subscription";
        if let Some(money) = &amount {
            priced_tokens += total;
            let slot = amount_totals.entry((money.currency.clone(), money.basis.as_str().to_owned())).or_insert(0);
            *slot = slot.checked_add(money.amount_minor).ok_or_else(|| ToolError::new("internal_error", "cost total overflow"))?;
        } else if is_unresolved {
            unresolved_tokens += total;
            has_unresolved = true;
        } else if key.billing_mode == "subscription" {
            subscription_tokens += total;
        }
        let mut row = json!({
            "key": {
                "harness": key.harness,
                "provider": key.provider_id,
                "provider_raw": key.provider_raw,
                "model": key.model,
                "billing_mode": key.billing_mode,
                "pricing_basis": key.pricing_basis,
                "evidence_basis": key.evidence_basis,
                "billing_template_id": key.billing_template_id,
            },
            "tokens": {
                "uncached_input_tokens": tokens.uncached_input,
                "cache_read_tokens": tokens.cache_read,
                "cache_write_tokens": tokens.cache_write,
                "output_tokens": tokens.output,
                "total": total,
                "peak_total": tokens.peak_total(),
            },
            "amount": amount.as_ref().map(MoneyMinor::to_json),
            "status": if key.billing_mode == "subscription" { "subscription" } else if amount.is_some() { "priced" } else { "unpriced" },
            "has_unresolved": is_unresolved,
            "unresolved_reason": unresolved_reason,
            "pricing": {
                "version": key.pricing_version,
                "source_kind": key.pricing_source,
                "captured_at_ms": key.captured_at_ms,
            },
        });
        row["group_by"] = json!(group_by);
        rows_out.push(row);
    }
    rows_out.sort_by(|a, b| a["key"].to_string().cmp(&b["key"].to_string()));
    let amounts = amount_totals.into_iter().map(|((currency, basis), amount_minor)| json!({
        "amount_minor": amount_minor, "currency": currency, "basis": basis,
    })).collect();
    Ok(WindowResult { rows: rows_out, total_tokens, priced_tokens, unresolved_tokens, subscription_tokens, amounts,
        max_event_ms, has_unresolved })
}

fn query_payload_for_bucket(
    conn: &rusqlite::Connection,
    key: &BucketKey,
) -> Result<Option<String>, ToolError> {
    // The bucket key already carries the immutable price version.  Fetching its
    // payload separately keeps the aggregate row free of a large JSON blob and
    // makes the public response expose only version/source metadata.
    let payload = match key.pricing_version.as_deref() {
        None => None,
        Some(version) => conn.query_row(
            "SELECT payload_json FROM pricing_snapshots WHERE pricing_version = ?1",
            rusqlite::params![version], |row| row.get(0),
        ).ok(),
    };
    Ok(payload)
}

fn usage_json(harness: &str, model: &str, tokens: &Tokens) -> Value {
    if harness == "claude-code" {
        json!({ "by_model": { model: {
            "input_tokens": tokens.uncached_input,
            "cache_read_input_tokens": tokens.cache_read,
            "cache_creation_input_tokens": tokens.cache_write,
            "output_tokens": tokens.output,
            "peak_input_tokens": tokens.peak_uncached_input,
            "peak_cache_read_input_tokens": tokens.peak_cache_read,
            "peak_cache_creation_input_tokens": tokens.peak_cache_write,
            "peak_output_tokens": tokens.peak_output,
        }}})
    } else if harness == "codex" {
        json!({ "by_model": { model: {
            "uncached_input_tokens": tokens.uncached_input,
            "cached_input_tokens": tokens.cache_read,
            "cache_write_input_tokens": tokens.cache_write,
            "output_tokens": tokens.output,
            "reasoning_output_tokens": 0,
        }}})
    } else {
        json!({ "by_model": { model: {
            "uncached_input_tokens": tokens.uncached_input,
            "cache_read_tokens": tokens.cache_read,
            "cache_write_tokens": tokens.cache_write,
            "output_tokens": tokens.output,
            "peak_uncached_input_tokens": tokens.peak_uncached_input,
            "peak_cache_read_tokens": tokens.peak_cache_read,
            "peak_cache_write_tokens": tokens.peak_cache_write,
            "peak_output_tokens": tokens.peak_output,
        }}})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_closed_and_group_dimensions_are_bounded() {
        assert_eq!(spec().input_schema["additionalProperties"], json!(false));
        let args = json!({"group_by": ["harness", "model", "harness"]});
        assert_eq!(parse_group_by(&args).unwrap(), vec!["harness", "model"]);
        assert!(parse_group_by(&json!({"group_by": []})).is_err());
        assert!(parse_group_by(&json!({"group_by": ["cost"]})).is_err());
    }

    #[test]
    fn tokens_keep_peak_and_total_axes_separate() {
        let mut tokens = Tokens::default();
        tokens.add(1, (2, 3, 4, 5, 9));
        tokens.add(0, (1, 1, 1, 1, 10));
        assert_eq!(tokens.total(), 18);
        assert_eq!(tokens.peak_total(), 14);
        assert_eq!(tokens.max_event_ms, 10);
    }
}
