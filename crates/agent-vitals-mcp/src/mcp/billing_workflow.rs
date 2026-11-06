//! Explicit, typed billing Authority management actions for v1.0.
//!
//! This module is compiled only for `mcp-internal`.  Reads are always allowed;
//! mutations additionally require the transport flag `--allow-local-writes`.
//! There is deliberately no SQL or generic write operation here: every action
//! maps to an existing AuthorityDb method with its validation and transaction
//! semantics.

use std::path::Path;

use agent_vitals_data::authority::{AuthorityDb, BillingRecalculationJobRow};
use serde_json::{json, Value};

use super::{build_envelope, coverage_not_applicable, AuthorityHandle, ToolError, ToolSpec};

const ACTIONS: &[&str] = &[
    "candidate_list", "candidate_put", "candidate_resolve", "candidate_reopen",
    "declaration_list", "declaration_preview", "declaration_save", "declaration_revoke",
    "declaration_revisions", "recalc_enqueue", "recalc_status", "recalc_run",
    "recalc_retry", "recalc_recover", "harness_bill_list", "harness_bill_put", "harness_bill_delete",
    "budget_get", "budget_profile_set", "budget_snooze_set", "budget_snooze_clear",
];

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "billing_workflow",
        description: "Internal typed v1.0 Authority workflow for billing candidates, declarations, recalculation jobs, harness bills, and budget controls. Reads are available in mcp-internal; mutations require the explicit --allow-local-writes server flag. No arbitrary SQL, source-log access, or generic writes.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ACTIONS },
                "candidate_id": { "type": "string" },
                "declaration_id": { "type": "string" },
                "revision_id": { "type": "string" },
                "supersedes_revision_id": { "type": ["string", "null"] },
                "job_id": { "type": "string" },
                "harness": { "type": "string" },
                "provider_id": { "type": "string" },
                "relationship_kind": { "type": "string", "enum": ["official_subscription", "official_api", "third_party", "organization", "unknown"] },
                "subscription_name": { "type": ["string", "null"] },
                "amount_minor": { "type": ["integer", "null"] },
                "currency": { "type": ["string", "null"] },
                "effective_start": { "type": "string" },
                "effective_end": { "type": ["string", "null"] },
                "billing_period_start": { "type": "string" },
                "source_pricing_version": { "type": "string" },
                "source_candidate_id": { "type": ["string", "null"] },
                "evidence_ref": { "type": ["string", "null"] },
                "scopes": { "type": "array", "items": { "type": "object", "properties": { "kind": { "type": "string" }, "value": { "type": "string" } }, "required": ["kind", "value"], "additionalProperties": false } },
                "status": { "type": "string", "enum": ["accepted", "dismissed"] },
                "window_start_ms": { "type": "integer" },
                "window_end_ms": { "type": "integer" },
                "basis": { "type": "string" },
                "bill_id": { "type": "string" },
                "profile_id": { "type": "string", "enum": ["estimate", "confirmed"] },
                "monthly_minor": { "type": "integer" },
                "daily_minor": { "type": ["integer", "null"] },
                "warning_ratio_bp": { "type": "integer" },
                "until_ms": { "type": "integer" }
            },
            "required": ["action"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "Standard envelope with a typed action result. Identifiers are locally supplied workflow identifiers; native session IDs, paths, prompts, and raw source payloads are never returned."
        }),
    }
}

pub fn run(args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    let action = required_string(args, "action")?;
    if !ACTIONS.contains(&action) {
        return Err(ToolError::new("invalid_argument", format!("unsupported billing workflow action `{action}`")));
    }
    if is_mutation(action) && !allow_local_writes {
        return Err(ToolError::new(
            "permission_denied",
            "billing workflow mutation requires the explicit `--allow-local-writes` server flag; default MCP remains read-only",
        ));
    }
    if is_mutation(action) {
        write_run(action, args, data_home)
    } else {
        read_run(action, args, data_home)
    }
}

fn is_mutation(action: &str) -> bool {
    matches!(action,
        "candidate_put" | "candidate_resolve" | "candidate_reopen" |
        "declaration_save" | "declaration_revoke" | "recalc_enqueue" |
        "recalc_run" | "recalc_retry" | "recalc_recover" | "harness_bill_put" |
        "harness_bill_delete" | "budget_profile_set" | "budget_snooze_set" |
        "budget_snooze_clear")
}

fn read_run(action: &str, args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let handle = AuthorityHandle::open(data_home)?;
    let data = match action {
        "candidate_list" => json!({ "action": action, "candidates": candidates(handle.db())? }),
        "declaration_list" => json!({ "action": action, "declarations": declarations(handle.db())? }),
        "declaration_revisions" => {
            let id = required_string(args, "declaration_id")?;
            json!({ "action": action, "declaration_id": id, "revisions": revisions(handle.db(), id)? })
        }
        "declaration_preview" => {
            let provider = required_string(args, "provider_id")?;
            let start = required_string(args, "effective_start")?;
            let scopes = parse_scopes(args)?;
            let scope_refs = scopes.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>();
            let window = match (
                args.get("window_start_ms").and_then(Value::as_i64),
                args.get("window_end_ms").and_then(Value::as_i64),
            ) {
                (Some(start), Some(end)) => Some((start, end)),
                _ => None,
            };
            // 可选 `relationship_kind`：给了就按默认覆盖规则预览（与重算同口径）；不给保持原始范围。
            let preview = match optional_string(args, "relationship_kind") {
                Some(kind) => handle.db().billing_declaration_impact_preview_for_kind(
                    provider, kind, start, optional_string(args, "effective_end"), &scope_refs, window,
                ),
                None => handle.db().billing_declaration_impact_preview_for(
                    provider, start, optional_string(args, "effective_end"), &scope_refs, window,
                ),
            }.map_err(authority_error)?;
            json!({ "action": action, "preview": preview_json(preview) })
        }
        "recalc_status" => {
            let id = required_string(args, "job_id")?;
            let job = handle.db().billing_recalculation_job(id).map_err(authority_error)?;
            let result = handle.db().billing_recalculation_result(id).map_err(authority_error)?;
            json!({ "action": action, "job_id": id, "job": job.map(job_json), "result": result.map(result_json) })
        }
        "harness_bill_list" => {
            let month = required_string(args, "billing_period_start")?;
            let bills = handle.db().harness_bill_details_for_period(month).map_err(authority_error)?;
            json!({ "action": action, "month": month, "bills": bills.into_iter().map(bill_json).collect::<Vec<_>>() })
        }
        "budget_get" => {
            let profiles = handle.db().budget_profiles_get().map_err(authority_error)?;
            let snooze = handle.db().budget_snooze_get().map_err(authority_error)?;
            json!({ "action": action, "profiles": profiles.into_iter().map(|p| json!({
                "profile_id": p.profile_id, "currency": p.currency, "monthly_minor": p.monthly_minor,
                "daily_minor": p.daily_minor, "warning_ratio_bp": p.warning_ratio_bp, "updated_at_ms": p.updated_at_ms
            })).collect::<Vec<_>>(), "snooze_until_ms": snooze })
        }
        _ => return Err(ToolError::new("invalid_argument", format!("action `{action}` is not a read action"))),
    };
    Ok(build_envelope(handle.conn(), handle.authority_state(), None,
        coverage_not_applicable(), Vec::new(), data))
}

fn write_run(action: &str, args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    if !path.exists() {
        return Err(ToolError::new("database_missing", "authority DB does not exist; mutation mode does not create a database"));
    }
    let db = AuthorityDb::open(&path, crate::clock::now_ms()).map_err(authority_error)?;
    let now = crate::clock::now_ms();
    let data = match action {
        "candidate_put" => {
            let id = required_string(args, "candidate_id")?;
            let harness = required_string(args, "harness")?;
            let provider = required_string(args, "provider_id")?;
            let currency = required_string(args, "currency")?;
            let amount = required_i64(args, "amount_minor")?;
            let period = required_string(args, "billing_period_start")?;
            let pricing = required_string(args, "source_pricing_version")?;
            let changed = db.with_immediate_txn(|_| db.billing_import_candidate_put(
                id, harness, provider, currency, amount, period, pricing, now,
            )).map_err(authority_error)?;
            json!({ "action": action, "candidate_id": id, "changed": changed })
        }
        "candidate_resolve" => {
            let id = required_string(args, "candidate_id")?;
            let status = required_string(args, "status")?;
            let changed = db.with_immediate_txn(|_| db.billing_import_candidate_resolve(
                id, status, now,
            )).map_err(authority_error)?;
            json!({ "action": action, "candidate_id": id, "changed": changed })
        }
        "candidate_reopen" => {
            let id = required_string(args, "candidate_id")?;
            let changed = db.with_immediate_txn(|_| db.billing_import_candidate_reopen(id, now))
                .map_err(authority_error)?;
            json!({ "action": action, "candidate_id": id, "changed": changed })
        }
        "declaration_save" => {
            let scopes = parse_scopes(args)?;
            let refs = scopes.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>();
            let revision_id = required_string(args, "revision_id")?;
            let declaration_id = required_string(args, "declaration_id")?;
            let provider = required_string(args, "provider_id")?;
            let kind = required_string(args, "relationship_kind")?;
            let start = required_string(args, "effective_start")?;
            let changed = db.billing_declaration_revision_save(
                revision_id, declaration_id, optional_string(args, "supersedes_revision_id"),
                provider, kind,
                optional_string(args, "subscription_name"), optional_i64(args, "amount_minor"),
                optional_string(args, "currency"), start,
                optional_string(args, "effective_end"), optional_string(args, "source_candidate_id"),
                optional_string(args, "evidence_ref"), &refs, now,
            ).map_err(authority_error)?;
            json!({ "action": action, "revision_id": revision_id, "changed": changed })
        }
        "declaration_revoke" => {
            let revision_id = required_string(args, "revision_id")?;
            let declaration_id = required_string(args, "declaration_id")?;
            let supersedes = required_string(args, "supersedes_revision_id")?;
            let changed = db.billing_declaration_revision_revoke(
                revision_id, declaration_id, supersedes, now,
            ).map_err(authority_error)?;
            json!({ "action": action, "revision_id": revision_id, "changed": changed })
        }
        "recalc_enqueue" => {
            let job_id = required_string(args, "job_id")?;
            let declaration_id = required_string(args, "declaration_id")?;
            let revision_id = required_string(args, "revision_id")?;
            let changed = db.with_immediate_txn(|_| db.billing_recalculation_enqueue(
                job_id, declaration_id, revision_id, now,
            )).map_err(authority_error)?;
            json!({ "action": action, "job_id": job_id, "changed": changed })
        }
        "recalc_run" => json!({ "action": action, "job_id": required_string(args, "job_id")?,
            "changed": db.billing_recalculation_run(required_string(args, "job_id")?, now).map_err(authority_error)? }),
        "recalc_retry" => json!({ "action": action, "job_id": required_string(args, "job_id")?,
            "changed": db.billing_recalculation_retry(required_string(args, "job_id")?, now).map_err(authority_error)? }),
        "recalc_recover" => json!({ "action": action,
            "queued_job_ids": db.billing_recalculation_recover(now).map_err(authority_error)? }),
        "harness_bill_put" => {
            let harness = required_string(args, "harness")?;
            let provider = required_string(args, "provider_id")?;
            let month = required_string(args, "billing_period_start")?;
            let basis = required_string(args, "basis")?;
            let evidence = optional_string(args, "evidence_ref").unwrap_or("");
            let id = optional_string(args, "bill_id").map(str::to_owned)
                .unwrap_or_else(|| format!("{harness}:{provider}:{month}:{basis}:{evidence}"));
            let amount = required_i64(args, "amount_minor")?;
            let currency = required_string(args, "currency")?;
            db.with_immediate_txn(|_| db.harness_bill_put(&id, harness, provider, month, basis,
                amount, currency, evidence, now))
                .map_err(authority_error)?;
            json!({ "action": action, "bill_id": id, "changed": true })
        }
        "harness_bill_delete" => {
            let bill_id = required_string(args, "bill_id")?;
            let changed = db.with_immediate_txn(|_| db.harness_bill_delete(bill_id, now)).map_err(authority_error)?;
            json!({ "action": action, "bill_id": bill_id, "changed": changed })
        }
        "budget_profile_set" => {
            let profile_id = required_string(args, "profile_id")?;
            let currency = required_string(args, "currency")?;
            let monthly = required_i64(args, "monthly_minor")?;
            let warning = required_i64(args, "warning_ratio_bp")?;
            db.with_immediate_txn(|_| db.budget_profile_set(
                profile_id, currency, monthly, optional_i64(args, "daily_minor"), warning, now,
            )).map_err(authority_error)?;
            json!({ "action": action, "profile_id": profile_id, "changed": true })
        }
        "budget_snooze_set" => {
            let until = required_i64(args, "until_ms")?;
            db.with_immediate_txn(|_| db.budget_snooze_set(until, now))
                .map_err(authority_error)?;
            json!({ "action": action, "until_ms": until, "changed": true })
        }
        "budget_snooze_clear" => {
            db.with_immediate_txn(|_| db.budget_snooze_clear()).map_err(authority_error)?;
            json!({ "action": action, "changed": true })
        }
        _ => return Err(ToolError::new("invalid_argument", format!("action `{action}` is not a write action"))),
    };
    Ok(build_envelope(db.conn(), super::authority_state_for(data_home), None,
        coverage_not_applicable(), Vec::new(), data))
}

fn candidates(db: &AuthorityDb) -> Result<Vec<Value>, ToolError> {
    let rows = db.billing_import_candidates().map_err(authority_error)?;
    Ok(rows.into_iter().map(|(id, harness, provider, currency, amount, period, status)| json!({
        "candidate_id": id, "harness": harness, "provider_id": provider, "currency": currency,
        "amount_minor": amount, "billing_period_start": period, "status": status
    })).collect())
}

fn declarations(db: &AuthorityDb) -> Result<Vec<Value>, ToolError> {
    let rows = db.billing_declarations().map_err(authority_error)?;
    Ok(rows.into_iter().map(|(id, provider, kind, name, amount, currency, start, end, candidate)| json!({
        "declaration_id": id, "provider_id": provider, "relationship_kind": kind,
        "subscription_name": name, "amount_minor": amount, "currency": currency,
        "effective_start": start, "effective_end": end, "source_candidate_id": candidate
    })).collect())
}

fn revisions(db: &AuthorityDb, id: &str) -> Result<Vec<Value>, ToolError> {
    let rows = db.billing_declaration_revisions(id).map_err(authority_error)?;
    Ok(rows.into_iter().map(|r| json!({
        "revision_id": r.0, "declaration_id": r.1, "revision_number": r.2, "change_kind": r.3,
        "supersedes_revision_id": r.4, "harness": r.5, "provider_id": r.6, "relationship_kind": r.7,
        "subscription_name": r.8, "amount_minor": r.9, "currency": r.10, "effective_start": r.11,
        "effective_end": r.12, "source_candidate_id": r.13, "evidence_ref": r.14, "created_at_ms": r.15
    })).collect())
}

fn bill_json(r: (String, String, String, String, i64, String, String)) -> Value {
    json!({ "bill_id": r.0, "harness": r.1, "provider_id": r.2, "basis": r.3,
        "amount_minor": r.4, "currency": r.5, "evidence_ref": r.6 })
}

fn job_json(r: BillingRecalculationJobRow) -> Value {
    json!({ "job_id": r.0, "declaration_id": r.1, "revision_id": r.2, "status": r.3,
        "requested_at_ms": r.4, "started_at_ms": r.5, "completed_at_ms": r.6,
        "error_code": r.7, "error_detail": r.8 })
}

fn result_json(r: (String, String, i64, i64, i64, Option<i64>, Option<i64>, i64)) -> Value {
    json!({ "job_id": r.0, "revision_id": r.1, "fact_count": r.2, "session_count": r.3,
        "total_tokens": r.4, "first_event_ts_ms": r.5, "last_event_ts_ms": r.6,
        "published_at_ms": r.7 })
}

fn preview_json(p: agent_vitals_data::authority::BillingDeclarationImpactPreview) -> Value {
    json!({ "fact_count": p.fact_count, "session_count": p.session_count,
        "total_tokens": p.total_tokens, "first_event_ts_ms": p.first_event_ts_ms,
        "last_event_ts_ms": p.last_event_ts_ms,
        "conflict_fact_count": p.conflict_fact_count, "conflict_tokens": p.conflict_tokens })
}

fn parse_scopes(args: &Value) -> Result<Vec<(String, String)>, ToolError> {
    args.get("scopes").and_then(Value::as_array).map_or([].as_slice(), |v| v.as_slice()).iter().map(|scope| {
        let obj = scope.as_object().ok_or_else(|| ToolError::new("invalid_argument", "each scope must be an object"))?;
        Ok((
            obj.get("kind").and_then(Value::as_str).ok_or_else(|| ToolError::new("invalid_argument", "scope.kind is required"))?.to_owned(),
            obj.get("value").and_then(Value::as_str).ok_or_else(|| ToolError::new("invalid_argument", "scope.value is required"))?.to_owned(),
        ))
    }).collect()
}

fn required_string<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key).and_then(Value::as_str).filter(|v| !v.is_empty())
        .ok_or_else(|| ToolError::new("invalid_argument", format!("`{key}` is required")))
}

fn optional_string<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn required_i64(args: &Value, key: &str) -> Result<i64, ToolError> {
    args.get(key).and_then(Value::as_i64)
        .ok_or_else(|| ToolError::new("invalid_argument", format!("`{key}` is required")))
}

fn optional_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
}

fn authority_error(error: agent_vitals_data::authority::AuthorityError) -> ToolError {
    match error {
        agent_vitals_data::authority::AuthorityError::MissingFile => ToolError::new("database_missing", "authority DB does not exist"),
        agent_vitals_data::authority::AuthorityError::Corrupt => ToolError::new("database_unreadable", "authority DB is corrupt or unreadable"),
        agent_vitals_data::authority::AuthorityError::NewerSchema { found, supported } => ToolError::new("schema_too_new", format!("authority schema v{found} is newer than supported v{supported}")),
        agent_vitals_data::authority::AuthorityError::OlderSchema { found } => ToolError::new("schema_migration_required", format!("authority schema v{found} requires migration")),
        other => ToolError::new("invalid_argument", other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_closed_and_action_is_required() {
        let schema = spec().input_schema;
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(schema["required"], json!(["action"]));
        assert!(ACTIONS.contains(&"declaration_save"));
    }

    #[test]
    fn mutation_requires_explicit_local_write_permission() {
        let error = run(
            &json!({"action": "candidate_reopen", "candidate_id": "candidate"}),
            Path::new("/definitely-not-an-agent-vitals-home"),
            false,
        ).unwrap_err();
        assert_eq!(error.code, "permission_denied");
    }
}
