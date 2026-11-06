//! Typed MCP control-plane operations shared with the desktop workbench.
//!
//! Read actions are safe projections of the same runtime/data APIs used by the
//! UI. Mutating actions are intentionally local-only and require the explicit
//! `--allow-local-writes` server flag. There is no generic SQL, URL, or file
//! write escape hatch here.

use std::path::{Path, PathBuf};

use agent_vitals_data::authority::AuthorityDb;
use serde_json::{json, Value};

use super::{build_envelope, coverage_not_applicable, AuthorityHandle, ToolError, ToolSpec};

const ACTIONS: &[&str] = &[
    "dashboard_snapshot", "source_status", "custom_sources", "source_controls",
    "retention_get", "statistics_timezone_get", "sync_state", "daily_summary",
    "monthly_summary", "calendar_month", "hourly_distribution", "codex_quota",
    "pricing_catalog_status", "issues_list", "custom_source_add", "custom_source_remove", "source_exclusion_set",
    "source_data_delete", "retention_set", "statistics_timezone_set", "sync_pause_set",
    "sync_facts", "issue_transition", "pricing_catalog_policy_set", "manifest_catalog_status", "manifest_catalog_policy_set",
];

const MUTATIONS: &[&str] = &[
    "custom_source_add", "custom_source_remove", "source_exclusion_set",
    "source_data_delete", "retention_set", "statistics_timezone_set", "sync_pause_set",
    "sync_facts", "issue_transition", "pricing_catalog_policy_set", "manifest_catalog_policy_set",
];

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "control_plane",
        description: "Typed local control-plane API shared with the Agent Vitals workbench. Reads expose safe source, sync, configuration, summary, quota, and issue projections. Mutations never accept SQL or arbitrary URLs and require the explicit --allow-local-writes server flag.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ACTIONS },
                "harness": { "type": "string" },
                "root": { "type": "string" },
                "excluded": { "type": "boolean" },
                "confirmation": { "type": "string" },
                "months": { "type": "integer" },
                "timezone": { "type": "string" },
                "network_enabled": { "type": "boolean" },
                "paused": { "type": "boolean" },
                "date": { "type": "string" },
                "month": { "type": "string" },
                "from_ms": { "type": "integer" },
                "to_ms": { "type": "integer" },
                "page_size": { "type": "integer" },
                "cursor": { "type": "string" },
                "issue_id": { "type": "string" },
                "to_status": { "type": "string" },
                "reason": { "type": ["string", "null"] }
            },
            "required": ["action"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "Standard MCP envelope. The data member contains a typed control-plane result; absolute local paths are not returned."
        }),
    }
}

pub fn run(args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    let action = required_string(args, "action")?;
    if !ACTIONS.contains(&action) {
        return Err(ToolError::new("invalid_argument", format!("unsupported control-plane action `{action}`")));
    }
    if MUTATIONS.contains(&action) && !allow_local_writes {
        return Err(ToolError::new(
            "permission_denied",
            "control-plane mutation requires the explicit `--allow-local-writes` server flag; default MCP remains read-only",
        ));
    }
    if MUTATIONS.contains(&action) {
        write_run(action, args, data_home)
    } else {
        read_run(action, args, data_home)
    }
}

fn read_run(action: &str, args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let handle = AuthorityHandle::open(data_home)?;
    let data = match action {
        "dashboard_snapshot" => {
            let mut sources = source_status(data_home, handle.conn())?;
            let sync = sync_state(data_home)?;
            if sync["paused"] == Value::Bool(true) {
                mark_paused(&mut sources);
            }
            json!({
                "action": action,
                "data_status": super::dispatch("data_status", &json!({}), data_home)
                    .map_err(|error| ToolError::new(error.code, error.message))?,
                "source_status": sources,
                "custom_sources": custom_sources(data_home)?,
                "retention_months": crate::retention::retention_months(data_home)
                    .map_err(local_error)?,
                "statistics_timezone": crate::statistics_timezone::timezone_name(data_home)
                    .map_err(local_error)?,
                "sync": sync,
            })
        }
        "source_status" => json!({ "action": action, "source_status": source_status(data_home, handle.conn())? }),
        "custom_sources" => json!({ "action": action, "sources": custom_sources(data_home)? }),
        "source_controls" => json!({
            "action": action,
            "excluded_harnesses": crate::source_controls::excluded_harnesses(data_home).map_err(local_error)?,
            "supported_harnesses": crate::source_controls::supported_harnesses_for(data_home)
        }),
        "retention_get" => json!({
            "action": action,
            "months": crate::retention::retention_months(data_home).map_err(local_error)?
        }),
        "statistics_timezone_get" => json!({
            "action": action,
            "timezone": crate::statistics_timezone::timezone_name(data_home).map_err(local_error)?
        }),
        "sync_state" => json!({ "action": action, "sync": sync_state(data_home)? }),
        "daily_summary" => {
            // 经 memo（RUNTIME_INVALIDATION spec §5.1）——一次 `data-mcp serve`
            // 进程可能在同一次对话里被同一个 agent 反复问同一天的账，serve 是
            // 单连接串行（无并发可言，`ReadGate` 在这个进程里无事可做——
            // spec §5.3 已记这条勘正），但重复查询本身值得省：同 revision 下
            // 第二次问直接返回缓存值。
            let date = required_string(args, "date")?;
            let summary = crate::summary::SqlSummaryRepository::at(data_home)
                .daily_summary_json_memoized(
                    &agent_vitals_data::repository::DailySummaryQuery { date: date.to_owned() },
                    crate::query::read_memo::ReadMemo::global(),
                );
            json!({ "action": action, "date": date, "summary": Value::clone(&summary) })
        }
        "monthly_summary" => {
            let month = required_string(args, "month")?;
            let summary = crate::summary::SqlSummaryRepository::at(data_home)
                .monthly_summary_json_memoized(
                    &agent_vitals_data::repository::MonthlySummaryQuery { month: month.to_owned() },
                    crate::query::read_memo::ReadMemo::global(),
                );
            json!({ "action": action, "month": month, "summary": Value::clone(&summary) })
        }
        "calendar_month" => {
            let month = required_string(args, "month")?;
            json!({ "action": action, "month": month,
                "calendar": crate::summary::calendar_month(month) })
        }
        "hourly_distribution" => {
            let date = required_string(args, "date")?;
            json!({ "action": action, "date": date,
                "distribution": crate::summary::hourly_distribution(date) })
        }
        "codex_quota" => json!({
            "action": action,
            "quota": crate::summary::codex_quota_snapshot(&crate::home::codex_home())
        }),
        "pricing_catalog_status" => json!({
            "action": action,
            "pricing": pricing_catalog_status(data_home)?,
        }),
        "manifest_catalog_status" => json!({
            "action": action,
            "manifest_catalog": manifest_catalog_status(data_home)?,
        }),
        "issues_list" => {
            let (from_ms, to_ms) = issue_window(args);
            let page_size = args.get("page_size").and_then(Value::as_u64).unwrap_or(50).min(500) as usize;
            let cursor = args.get("cursor").and_then(Value::as_str);
            let groups = agent_vitals_data::issues::issue_groups_with_sources(
                handle.conn(), from_ms, to_ms, page_size, cursor,
            ).map_err(|error| ToolError::new("authority_query", error.to_string()))?;
            json!({ "action": action, "issues": groups })
        }
        _ => return Err(ToolError::new("invalid_argument", format!("action `{action}` is not a read action"))),
    };
    Ok(build_envelope(
        handle.conn(), handle.authority_state(), None,
        coverage_not_applicable(), Vec::new(), data,
    ))
}

fn write_run(action: &str, args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let data = match action {
        "custom_source_add" => {
            let harness = required_string(args, "harness")?;
            let root = PathBuf::from(required_string(args, "root")?);
            let changed = crate::custom_sources::add_custom_source_root(data_home, harness, &root)
                .map_err(local_error)?;
            json!({ "action": action, "harness": harness, "changed": changed })
        }
        "custom_source_remove" => {
            let harness = required_string(args, "harness")?;
            let root = PathBuf::from(required_string(args, "root")?);
            let changed = crate::custom_sources::remove_custom_source_root(data_home, harness, &root)
                .map_err(local_error)?;
            json!({ "action": action, "harness": harness, "changed": changed })
        }
        "source_exclusion_set" => {
            let harness = required_string(args, "harness")?;
            let excluded = args.get("excluded").and_then(Value::as_bool)
                .ok_or_else(|| ToolError::new("invalid_argument", "`excluded` is required"))?;
            let changed = crate::source_controls::set_harness_excluded(data_home, harness, excluded)
                .map_err(local_error)?;
            json!({ "action": action, "harness": harness, "excluded": excluded, "changed": changed })
        }
        "source_data_delete" => {
            require_confirmation(args, "DELETE_IMPORTED_SOURCE_DATA")?;
            let harness = required_string(args, "harness")?;
            let deleted = crate::source_controls::delete_imported_source_data(data_home, harness)
                .map_err(local_error)?;
            json!({ "action": action, "harness": harness, "excluded": true,
                "deleted": { "facts": deleted.facts, "sessions": deleted.sessions,
                    "source_files": deleted.source_files,
                    "trust_observations": deleted.trust_observations,
                    "route_evidence": deleted.route_evidence,
                    "session_excerpts": deleted.session_excerpts } })
        }
        "retention_set" => {
            let months = args.get("months").and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| ToolError::new("invalid_argument", "`months` is required"))?;
            crate::retention::save_retention_months(data_home, months).map_err(local_error)?;
            json!({ "action": action, "months": months, "changed": true })
        }
        "statistics_timezone_set" => {
            let timezone = required_string(args, "timezone")?;
            let saved = crate::statistics_timezone::save_timezone(data_home, timezone)
                .map_err(local_error)?;
            let applied = crate::statistics_timezone::apply(data_home).map_err(local_error)?;
            json!({ "action": action, "timezone": saved, "applied_timezone": applied, "changed": true })
        }
        "sync_pause_set" => {
            let paused = args.get("paused").and_then(Value::as_bool)
                .ok_or_else(|| ToolError::new("invalid_argument", "`paused` is required"))?;
            crate::sync_control::set_paused(data_home, paused).map_err(local_error)?;
            json!({ "action": action, "paused": paused, "changed": true })
        }
        "pricing_catalog_policy_set" => {
            let network_enabled = args.get("network_enabled").and_then(Value::as_bool)
                .ok_or_else(|| ToolError::new("invalid_argument", "`network_enabled` is required"))?;
            save_pricing_catalog_policy(data_home, network_enabled)?;
            json!({ "action": action, "network_enabled": network_enabled, "changed": true })
        }
        "manifest_catalog_policy_set" => {
            let network_enabled = args.get("network_enabled").and_then(Value::as_bool)
                .ok_or_else(|| ToolError::new("invalid_argument", "`network_enabled` is required"))?;
            save_manifest_catalog_policy(data_home, network_enabled)?;
            json!({ "action": action, "network_enabled": network_enabled, "changed": true })
        }
        "sync_facts" => {
            if crate::sync_control::is_paused(data_home).map_err(local_error)? {
                json!({ "action": action, "status": "paused", "report": Value::Null })
            } else {
                let report = crate::sync_service::sync_facts(data_home).map_err(local_error)?;
                json!({ "action": action, "status": "completed", "report": serde_json::to_value(report)
                    .map_err(|error| ToolError::new("internal_error", error.to_string()))? })
            }
        }
        "issue_transition" => {
            let issue_id = required_string(args, "issue_id")?;
            let to_status = required_string(args, "to_status")?;
            if !matches!(to_status, "open" | "later" | "acknowledged" | "resolved" |
                "not_applicable" | "closed" | "wontfix") {
                return Err(ToolError::new("invalid_argument", "unsupported issue target status"));
            }
            let reason = args.get("reason").and_then(Value::as_str).unwrap_or("user action");
            if reason.chars().count() > 512 {
                return Err(ToolError::new("invalid_argument", "reason is too long"));
            }
            let path = agent_vitals_data::authority::default_authority_path(data_home);
            let db = AuthorityDb::open(&path, crate::clock::now_ms()).map_err(authority_error)?;
            let now = crate::clock::now_ms();
            let evidence = format!("mcp-user-action:{to_status}");
            let fingerprint = format!("mcp-transition:{issue_id}:{to_status}:{reason}");
            let transition_id = db.with_immediate_txn(|conn| {
                agent_vitals_data::issues::transition_issue(
                    conn, issue_id, to_status, now, reason, "user", &evidence,
                    "user", "v1.0.0", &fingerprint,
                ).map_err(agent_vitals_data::authority::AuthorityError::Sqlite)
            }).map_err(authority_error)?;
            json!({ "action": action, "issue_id": issue_id, "to_status": to_status,
                "transition_id": transition_id })
        }
        _ => return Err(ToolError::new("invalid_argument", format!("action `{action}` is not a write action"))),
    };
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    let db = AuthorityDb::open_readonly(&path).map_err(authority_error)?;
    Ok(build_envelope(
        db.conn(), super::authority_state_for(data_home), None,
        coverage_not_applicable(), Vec::new(), data,
    ))
}

fn source_status(data_home: &Path, conn: &rusqlite::Connection) -> Result<Value, ToolError> {
    let mut report = super::source_status_report(conn).map_err(local_error)?;
    let excluded = crate::source_controls::excluded_harnesses(data_home).map_err(local_error)?;
    if let Some(sources) = report.get_mut("sources").and_then(Value::as_array_mut) {
        for source in sources {
            let harness = source.get("harness").and_then(Value::as_str).unwrap_or("");
            if excluded.contains(harness) {
                source["connection_state"] = Value::String("excluded".to_string());
                source["recovery_action"] = json!({ "kind": "include_source", "label": "恢复读取" });
            }
        }
    }
    Ok(report)
}

fn mark_paused(report: &mut Value) {
    if let Some(sources) = report.get_mut("sources").and_then(Value::as_array_mut) {
        for source in sources {
            if source.get("connection_state").and_then(Value::as_str) == Some("excluded") {
                continue;
            }
            source["connection_state"] = Value::String("paused".to_string());
            source["recovery_action"] = json!({ "kind": "resume_sync", "label": "恢复同步" });
        }
    }
}

fn custom_sources(data_home: &Path) -> Result<Value, ToolError> {
    let sources = crate::custom_sources::custom_source_roots(data_home).map_err(local_error)?;
    // The UI can display the local root, but MCP responses must not export
    // absolute paths. Callers that manage a root already know the path they
    // supplied to the typed add/remove action.
    Ok(json!({
        "configured_count": sources.len(),
        "harnesses": sources.iter().map(|source| source.harness.as_str()).collect::<Vec<_>>(),
    }))
}

fn sync_state(data_home: &Path) -> Result<Value, ToolError> {
    Ok(json!({ "status": "ok", "paused": crate::sync_control::is_paused(data_home).map_err(local_error)? }))
}

const PUBLIC_PRICING_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/Oh-Agent-AI/oh-agent/main/assets/pricing.json";
const PRICING_UPDATE_STATUS_FILE: &str = "pricing-catalog-update.json";
const PRICING_UPDATE_POLICY_FILE: &str = "pricing-catalog-policy.json";

fn pricing_catalog_status(data_home: &Path) -> Result<Value, ToolError> {
    let status = data_home.join(PRICING_UPDATE_STATUS_FILE);
    let mut value = std::fs::read(&status)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({
            "state": "never_checked",
            "source_url": PUBLIC_PRICING_CATALOG_URL,
            "last_checked_at_ms": null,
            "last_success_at_ms": null,
            "source_version": null,
            "model_count": null,
            "failure_reason": null,
            "failure_count": 0,
            "next_check_at_ms": null,
        }));
    let network_enabled = std::fs::read(data_home.join(PRICING_UPDATE_POLICY_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|policy| policy.get("network_enabled").and_then(Value::as_bool))
        .unwrap_or(false);
    let object = value.as_object_mut().expect("status is normalized to an object");
    object.insert("source_url".into(), Value::String(PUBLIC_PRICING_CATALOG_URL.into()));
    object.insert("network_enabled".into(), Value::Bool(network_enabled));
    Ok(value)
}

fn save_pricing_catalog_policy(data_home: &Path, network_enabled: bool) -> Result<(), ToolError> {
    std::fs::create_dir_all(data_home).map_err(|error| local_error(format!("create data home failed: {error}")))?;
    let path = data_home.join(PRICING_UPDATE_POLICY_FILE);
    let temp = data_home.join("pricing-catalog-policy.json.tmp");
    let bytes = serde_json::to_vec_pretty(&json!({ "network_enabled": network_enabled }))
        .map_err(|error| ToolError::new("internal_error", format!("serialize pricing policy failed: {error}")))?;
    std::fs::write(&temp, bytes)
        .map_err(|error| local_error(format!("write pricing policy failed: {error}")))?;
    std::fs::rename(&temp, path)
        .map_err(|error| local_error(format!("commit pricing policy failed: {error}")))
}

const MANIFEST_CATALOG_INDEX_URL: &str =
    "https://raw.githubusercontent.com/Oh-Agent-AI/oh-agent/main/catalog/index.json";
const MANIFEST_CATALOG_STATUS_FILE: &str = "manifest-catalog-update.json";
const MANIFEST_CATALOG_POLICY_FILE: &str = "manifest-catalog-policy.json";

/// 只读镜像桌面目录检查状态（E06）。MCP 无网络：拉取由桌面层执行；
/// 状态与策略文件是共享事实，origin/激活权威在 authority 台账。
fn manifest_catalog_status(data_home: &Path) -> Result<Value, ToolError> {
    let mut status = std::fs::read(data_home.join(MANIFEST_CATALOG_STATUS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({
            "state": "never_checked",
            "source_url": MANIFEST_CATALOG_INDEX_URL,
            "last_checked_at_ms": null,
            "last_success_at_ms": null,
            "catalog_sequence": null,
            "index_sha256": null,
            "entry_count": null,
            "supported_entries": null,
            "failure_reason": null,
            "failure_count": 0,
            "next_check_at_ms": null,
        }));
    let network_enabled = std::fs::read(data_home.join(MANIFEST_CATALOG_POLICY_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|policy| policy.get("network_enabled").and_then(Value::as_bool))
        .unwrap_or(false);
    let object = status.as_object_mut().expect("status is normalized to an object");
    object.insert("source_url".into(), Value::String(MANIFEST_CATALOG_INDEX_URL.into()));
    object.insert("network_enabled".into(), Value::Bool(network_enabled));
    Ok(Value::Object(object.clone()))
}

fn save_manifest_catalog_policy(data_home: &Path, network_enabled: bool) -> Result<(), ToolError> {
    std::fs::create_dir_all(data_home).map_err(|error| local_error(format!("create data home failed: {error}")))?;
    let path = data_home.join(MANIFEST_CATALOG_POLICY_FILE);
    let temp = data_home.join("manifest-catalog-policy.json.tmp");
    let bytes = serde_json::to_vec_pretty(&json!({ "network_enabled": network_enabled }))
        .map_err(|error| ToolError::new("internal_error", format!("serialize manifest catalog policy failed: {error}")))?;
    std::fs::write(&temp, bytes)
        .map_err(|error| local_error(format!("write manifest catalog policy failed: {error}")))?;
    std::fs::rename(&temp, path)
        .map_err(|error| local_error(format!("commit manifest catalog policy failed: {error}")))
}

fn issue_window(args: &Value) -> (Option<i64>, Option<i64>) {
    let now = crate::clock::now_ms();
    (
        args.get("from_ms").and_then(Value::as_i64).or_else(|| Some(now.saturating_sub(30 * 24 * 60 * 60 * 1000))),
        args.get("to_ms").and_then(Value::as_i64).or_else(|| Some(now.saturating_add(1))),
    )
}

fn require_confirmation(args: &Value, expected: &str) -> Result<(), ToolError> {
    if args.get("confirmation").and_then(Value::as_str) == Some(expected) {
        Ok(())
    } else {
        Err(ToolError::new("confirmation_required", format!("this action requires confirmation `{expected}`")))
    }
}

fn required_string<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key).and_then(Value::as_str).filter(|value| !value.is_empty())
        .ok_or_else(|| ToolError::new("invalid_argument", format!("`{key}` is required")))
}

fn local_error(error: String) -> ToolError {
    ToolError::new("invalid_argument", error)
}

fn authority_error(error: agent_vitals_data::authority::AuthorityError) -> ToolError {
    match error {
        agent_vitals_data::authority::AuthorityError::MissingFile => ToolError::new("database_missing", "authority DB does not exist"),
        agent_vitals_data::authority::AuthorityError::Corrupt => ToolError::new("database_unreadable", "authority DB is corrupt or unreadable"),
        agent_vitals_data::authority::AuthorityError::NewerSchema { found, supported } => ToolError::new("schema_too_new", format!("authority schema v{found} is newer than supported v{supported}")),
        agent_vitals_data::authority::AuthorityError::OlderSchema { found } => ToolError::new("schema_migration_required", format!("authority schema v{found} is older than supported")),
        other => ToolError::new("internal_error", other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;

    fn tmp_home(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "avmcp-cp-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(p.join("state")).unwrap();
        p
    }

    fn seed_fact(db: &AuthorityDb, fact_id: &str, event_ts_ms: i64) {
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run', 1, 'cli', 'succeeded', 1) ON CONFLICT(run_id) DO NOTHING",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                 event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                 output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES (?1, 'dsh', 'm', 'sess', ?1, 'assistant-usage', NULL, 'deepseek-chat',
                 ?2, 1, 10, 0, 0, 5, 'run', 1, 1)",
            rusqlite::params![fact_id, event_ts_ms],
        ).unwrap();
    }

    /// `daily_summary`/`monthly_summary` control-plane actions must route through
    /// the memoized `SqlSummaryRepository` methods (RUNTIME_INVALIDATION spec
    /// §5.1) rather than the raw trait methods — this pins the wiring itself
    /// (shape unchanged, repeat calls agree byte-for-byte) since nothing else in
    /// the MCP test surface exercised these two actions before.
    #[test]
    fn daily_and_monthly_summary_actions_are_memo_wired_and_shape_stable() {
        let home = tmp_home("summary");
        let path = agent_vitals_data::authority::default_authority_path(&home);
        let db = AuthorityDb::open(&path, 1).unwrap();
        let month = "2026-09";
        let date = "2026-09-10";
        let (start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms(month).unwrap();
        seed_fact(&db, "f1", start + 3_600_000);
        drop(db);

        // envelope 的 `generated_at` 每次都新——比较范围收在 `data`（真正
        // 经 memo 的那部分）：memo 命中时两次调用的 summary 必须逐字节相等。
        let daily1 = run(&json!({ "action": "daily_summary", "date": date }), &home, false).unwrap();
        let daily2 = run(&json!({ "action": "daily_summary", "date": date }), &home, false).unwrap();
        assert_eq!(daily1["data"], daily2["data"], "repeat calls must agree byte-for-byte");
        assert!(daily1["data"]["summary"]["tokens_by_harness"].is_object(), "must be the full DTO shape, not a stub");
        assert_eq!(daily1["data"]["date"], date);

        let monthly1 = run(&json!({ "action": "monthly_summary", "month": month }), &home, false).unwrap();
        let monthly2 = run(&json!({ "action": "monthly_summary", "month": month }), &home, false).unwrap();
        assert_eq!(monthly1["data"], monthly2["data"], "repeat calls must agree byte-for-byte");
        assert!(monthly1["data"]["summary"]["by_harness"].is_object(), "must be the full DTO shape, not a stub");
        assert_eq!(monthly1["data"]["month"], month);

        let _ = std::fs::remove_dir_all(&home);
    }
}
