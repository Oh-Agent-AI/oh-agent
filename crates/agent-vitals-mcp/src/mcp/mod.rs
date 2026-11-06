//! Data MCP 工具应用层（`docs/AGENT_VITALS_DATA_MCP_SPEC.md` §5.2：工具应用层
//! 住 `agent-vitals-runtime`；stdio 传输 / JSON-RPC 编解码 / 进程生命周期住
//! `apps/cli/src/mcp.rs`）。
//!
//! 本模块暴露：
//! - [`build_envelope`]：spec §6 顶层响应契约（所有工具结果都包一层）。
//! - [`AuthorityHandle`]：**只读**打开权威库（spec §9.3——不建库、不迁移）+
//!   `authority_state`（spec §6.1）。
//! - [`ToolError`]：spec §11 稳定错误码 + 安全描述。传输层把它映射成
//!   `tools/call` 结果的 `isError: true` + envelope 内 `error`，**不塞 JSON-RPC
//!   error**（否则客户端拿不到 warnings/coverage，spec §6.4）。
//! - [`tool_specs`]：`tools/list` 的工具定义（含 JSON Schema，spec §6.4 / D10）。
//! - [`dispatch`]：`tools/call` 的分发入口。
//!
//! **增量 1**（`docs/AGENT_VITALS_DATA_MCP_IMPLEMENTATION_PLAN.md`）：只有
//! `data_status` 一个工具；envelope / 错误映射 / authority 状态 / revision 的
//! 读取方式在这里为后续工具钉死。

mod data_status;
mod session_detail;
mod session_trace;
// `session_ref` 的 HMAC 机制不是工具面——pub 是给 CLI 本地 `trace-anchors`
// （V16 锚点报告，本地呈现层专属）复用 ref 解析用的；工具注册走下面的
// dispatch，模块可见性与工具面无关。
/// 兼容路径：W3 移到 `query::session_ref`（query::decision_matrix 也要用）。
pub use crate::query::session_ref;
mod sessions_search;
mod usage_hourly;
mod budget_profiles;
/// W3 移到 `query::cost_breakdown`（query / billing 复用其计价选择）。
pub(crate) use crate::query::cost_breakdown;
mod control_plane;
mod price_cards;
mod data_quality_issues;
mod workflow_summary;
pub mod trust_profiles;
mod city_building;
mod city_im;
#[cfg(feature = "mcp-internal")]
mod query_sql_readonly;
#[cfg(feature = "mcp-internal")]
mod billing_workflow;
#[cfg(feature = "mcp-internal")]
mod authority_audit;

// PR #1 (mcp 0.9.1 SQL authority 收口)：把 cursor 解析/生成的 `pub` 包装
// 在模块顶层再 re-export 一次，CLI 二进制侧可以 `use agent_vitals_runtime::
// mcp::{parse_search_cursor, make_search_cursor, parse_detail_cursor,
// make_detail_cursor}` 直接拿，无需穿透到子模块（子模块仍是 private）。
pub use session_detail::{make_detail_cursor, parse_detail_cursor};
pub use sessions_search::{make_search_cursor, parse_search_cursor};
pub use data_status::augment_sync_failure;

use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Value};

// W3：envelope / ToolError / AuthorityHandle / freshness / ToolSpec 这层「工具
// 协议」下沉到 `crate::envelope`——query::decision_matrix 与 billing::billing_preview
// 复用 cost_breakdown / session_ref 时经由它们依赖了整个 mcp，形成
// `query ↔ mcp`、`billing ↔ mcp` 两条环。glob re-export 保持 `mcp::X` 与子模块
// `super::X` 路径不变。
pub use crate::envelope::*;

// ─────────────────────────── 工具注册表 ───────────────────────────

/// 当前构建注册的工具。传输层据此渲染 `tools/list` 并校验 `tools/call` 的名字。
pub fn tool_specs() -> Vec<ToolSpec> {
    // `mut` 只在 `mcp-internal` 构建里用到（下方 push）；公开构建不加工具。
    #[cfg_attr(not(feature = "mcp-internal"), allow(unused_mut))]
    let mut out = vec![
        data_status::spec(),
        usage_hourly::spec(),
        budget_profiles::spec(),
        cost_breakdown::spec(),
        sessions_search::spec(),
        session_detail::spec(),
        session_trace::spec(),
        control_plane::spec(),
        price_cards::spec(),
        data_quality_issues::spec(),
        workflow_summary::issues_spec(),
        workflow_summary::skills_spec(),
        trust_profiles::schema_spec(),
        trust_profiles::list_spec(),
        trust_profiles::validate_spec(),
        trust_profiles::stage_spec(),
        trust_profiles::status_spec(),
        city_building::get_spec(),
        city_building::preview_spec(),
        city_building::set_spec(),
        city_building::reset_spec(),
        city_im::spec(),
    ];
    #[cfg(feature = "mcp-internal")]
    {
        out.push(query_sql_readonly::spec());
        out.push(billing_workflow::spec());
        out.push(authority_audit::spec());
    }
    out
}

/// CLI `data-status` 的数据面——与 MCP `data_status` 工具**同源**（spec §5
/// 「同一 repository / 同一 DTO」）。CLI 用 `AuthorityDb::open`（会建库）+ 自己
/// 判 `db_existed`；MCP 用只读路径。两边都调这个函数组装数据。
pub fn data_status_report(conn: &Connection, db_existed: bool, enabled: bool) -> Value {
    data_status::collect_report(conn, db_existed, enabled)
}

/// 桌面工作台热路径的同一份数据面，只把完整性检查降到 `quick_check`。
///
/// 工作台每次切到「总览」都会调 `data_status`，而全量 `integrity_check` 在
/// 163MB 库上要 522ms（并发读下 1.2s），是整次刷新里唯一的长杆。字段结构与
/// [`data_status_report`] 完全一致，只有 `integrity` 这一格的检查深度不同；
/// CLI 与 MCP 的 doctor 面继续用全量版本（`data-status` 的语义不变）。
pub fn data_status_report_quick(conn: &Connection, db_existed: bool, enabled: bool) -> Value {
    data_status::collect_report_quick(conn, db_existed, enabled)
}

/// 独立的数据源状态投影。它不依赖 sessions_search 的时间窗，也不暴露路径；
/// 桌面端和后续 MCP 工具可共享同一契约。
pub fn source_status_report(conn: &Connection) -> Result<Value, String> {
    let mut sources = Vec::new();
    for harness in crate::ingest_service::FACT_HARNESSES {
        let source_stats = conn.query_row(
            "SELECT COUNT(*), MAX(last_seen_at_ms),
                    COALESCE(SUM(CASE WHEN last_error_code IS NOT NULL THEN 1 ELSE 0 END), 0)
             FROM source_files WHERE harness = ?1",
            [harness],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, i64>(2)?)),
        ).map_err(|e| format!("source_files query failed for {harness}: {e}"))?;
        let import_stats = conn.query_row(
            "SELECT COUNT(*), COUNT(DISTINCT session_key), MIN(event_ts_ms), MAX(event_ts_ms)
             FROM usage_facts
             WHERE harness = ?1 AND deleted_at_ms IS NULL AND observation_kind != 'legacy_aggregate'",
            [harness],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?, r.get::<_, Option<i64>>(3)?)),
        ).map_err(|e| format!("usage_facts query failed for {harness}: {e}"))?;
        let error_codes: Vec<String> = conn.prepare(
            "SELECT DISTINCT last_error_code FROM source_files
             WHERE harness = ?1 AND last_error_code IS NOT NULL ORDER BY last_error_code",
        ).and_then(|mut stmt| {
            stmt.query_map([harness], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        }).map_err(|e| format!("source error query failed for {harness}: {e}"))?;

        let (source_count, scanned_at_ms, failed_count) = source_stats;
        let (fact_count, session_count, first_event_at_ms, last_event_at_ms) = import_stats;
        let state = if failed_count > 0 { "needs_attention" }
            else if source_count > 0 { "connected" } else { "not_detected" };
        let action = if failed_count > 0 {
            json!({ "kind": "retry_sync", "label": "重新同步" })
        } else if source_count == 0 {
            json!({ "kind": "scan_and_connect", "label": "扫描并接入" })
        } else {
            json!({ "kind": "sync", "label": "立即同步" })
        };
        sources.push(json!({
            "source_id": format!("harness:{harness}"),
            "harness": harness,
            "authorization": if failed_count > 0 { "unknown_or_failed" } else { "unknown" },
            "connection_state": state,
            "scan": { "last_scanned_at_ms": scanned_at_ms, "source_count": source_count },
            "log": { "last_event_at_ms": last_event_at_ms },
            "import_scope": {
                "facts": fact_count, "sessions": session_count,
                "first_event_at_ms": first_event_at_ms, "last_event_at_ms": last_event_at_ms
            },
            "failed_scope": { "sources": failed_count, "error_codes": error_codes },
            "recovery_action": action
        }));
    }
    Ok(json!({ "status": "ok", "sources": sources }))
}

/// `tools/call` 分发。`name` 已由传输层对 [`tool_specs`] 校验过。参数在这里
/// 过一遍极简 schema 校验（spec §6.4 / M08：未知字段 → `invalid_argument`）。
/// Remember `initialize.params.clientInfo.name` for this stdio connection.
/// Building fanout uses it as the squad actor. `None` clears back to City MCP.
pub fn note_mcp_client(name: Option<&str>) {
    crate::query::city_im::set_connection_client(name);
}

pub fn dispatch(name: &str, args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    dispatch_with_permissions(name, args, data_home, false)
}

/// `data-mcp serve --allow-local-writes` 的显式权限入口。默认 dispatch 永远
/// 是只读；即使编译了 `mcp-internal`，也不会因为客户端能看到工具就获得写权限。
pub fn dispatch_with_permissions(
    name: &str,
    args: &Value,
    data_home: &Path,
    allow_local_writes: bool,
) -> Result<Value, ToolError> {
    #[cfg(not(feature = "mcp-internal"))]
    let _ = allow_local_writes;
    let spec = tool_specs()
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| ToolError::new("internal_error", format!("tool `{name}` registered but not wired")))?;
    validate_args(&spec, args)?;
    match name {
        "data_status" => data_status::run(args, data_home),
        "usage_hourly" => usage_hourly::run(args, data_home),
        "budget_profiles" => budget_profiles::run(args, data_home),
        "cost_breakdown" => cost_breakdown::run(args, data_home),
        "sessions_search" => sessions_search::run(args, data_home),
        "session_detail" => session_detail::run(args, data_home),
        "session_trace" => session_trace::run(args, data_home),
        "control_plane" => control_plane::run(args, data_home, allow_local_writes),
        "price_cards" => price_cards::run(args, data_home, allow_local_writes),
        "data_quality_issues" => data_quality_issues::run(args, data_home),
        "issues_summary" => workflow_summary::run_issues(args, data_home),
        "skills_summary" => workflow_summary::run_skills(args, data_home),
        "trust_profile_schema" => trust_profiles::run_schema(data_home),
        "trust_profile_list" => trust_profiles::run_list(data_home),
        "trust_profile_validate" => trust_profiles::run_validate(args, data_home),
        "trust_profile_stage" => trust_profiles::run_stage(args, data_home, allow_local_writes),
        "trust_profile_proposal_status" => trust_profiles::run_status(data_home),
        "get_building" => city_building::run_get(args, data_home),
        "preview_building" => city_building::run_preview(args, data_home),
        "set_building_model" => city_building::run_set(args, data_home, allow_local_writes),
        "reset_building" => city_building::run_reset(args, data_home, allow_local_writes),
        "im_publish" => city_im::run(args, data_home, allow_local_writes),
        #[cfg(feature = "mcp-internal")]
        "query_sql_readonly" => query_sql_readonly::run(args, data_home),
        #[cfg(feature = "mcp-internal")]
        "billing_workflow" => billing_workflow::run(args, data_home, allow_local_writes),
        #[cfg(feature = "mcp-internal")]
        "authority_audit" => authority_audit::run(args, data_home),
        other => Err(ToolError::new("internal_error", format!("tool `{other}` registered but not wired"))),
    }
}

/// 极简参数校验（spec §6.4：`additionalProperties: false` + 未知字段 →
/// `invalid_argument`）。**不做**完整 JSON Schema——只挡「不是对象」和「多余
/// 字段」两类，够 M08 注入防护；参数一多再引 schema crate。
///
/// **S5 fix（增量 1 review）**：首行 `debug_assert!` 每个注册工具的 schema
/// 都把 `additionalProperties` 设为 `false`——**没设就是 fail-fast**，
/// 否则未来某个工具忘了标就会被静默放行多余字段，构成注入漏洞。
fn validate_args(spec: &ToolSpec, args: &Value) -> Result<(), ToolError> {
    // S5 fix (increment 1 review, increment 2 落地)：**runtime** check（不是
    // debug_assert!）——release 构建必须也强制 `additionalProperties:false`，
    // 否则未来某工具忘了标会被静默放行多余字段，构成注入漏洞。
    // `debug_assert!` 在 release 是 no-op，不能用。
    if spec.input_schema.get("additionalProperties") != Some(&Value::Bool(false)) {
        return Err(ToolError::new(
            "internal_error",
            format!(
                "tool `{}` inputSchema must set additionalProperties:false (spec §6.4 / M08) — fix the tool registration",
                spec.name
            ),
        ));
    }
    let obj = args
        .as_object()
        .ok_or_else(|| ToolError::new("invalid_argument", "`arguments` must be a JSON object"))?;
    let known: std::collections::BTreeSet<&str> = spec
        .input_schema
        .get("properties")
        .and_then(Value::as_object)
        .map(|p| p.keys().map(String::as_str).collect())
        .unwrap_or_default();
    if let Some(extra) = obj.keys().find(|k| !known.contains(k.as_str())) {
        return Err(ToolError::new(
            "invalid_argument",
            format!("unknown argument `{extra}` for tool `{}`", spec.name),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;

    #[test]
    fn authority_revision_max_observed_excludes_legacy_aggregate() {
        // S4 fix (increment 1 review, increment 2 落地)：legacy_aggregate 行
        // 的 `event_ts_ms` 是北京日 12:00 代表点——不能被 `max_observed_at`
        // 当作可信快照的"最新观察时间"。回归测试。
        let home = std::env::temp_dir().join(format!(
            "avmcp-revfix-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let path = agent_vitals_data::authority::default_authority_path(&home);
        let db = AuthorityDb::open(&path, 1_700_000_000_000).unwrap();

        // 两条事实：
        // - 实时行，event_ts_ms = 2026-09-07 03:00 北京（≈ Unix 1.757e12 ms）
        // - legacy_aggregate 行，event_ts_ms = 2026-09-08 12:00 北京（故意比实时晚 1 天）
        // 期望 max_observed_at = 实时行的 event_ts_ms，**不是** legacy 的。
        let real_ts: i64 = 1_757_000_000_000;
        let legacy_ts: i64 = 1_757_100_800_000; // +30h 后
        let conn = db.conn();
        // 直接 INSERT 走 SQL——绕过 writer 校验（这是测试，不是生产写入）。
        conn.execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, completed_at_ms, trigger, status, schema_version)
             VALUES ('run1', ?1, ?1, 'cli', 'succeeded', 1)",
            rusqlite::params![1_700_000_000_000_i64],
        ).unwrap();
        conn.execute(
            "INSERT INTO source_files(source_id, harness, path_hash, size_bytes, mtime_ns,
                                     parser_version, first_seen_at_ms, last_seen_at_ms,
                                     last_successful_run_id)
             VALUES ('src-real', 'claude-code', 'h-real', 0, 0, 1, ?1, ?1, 'run1'),
                    ('src-legacy', 'claude-code', 'h-legacy', 0, 0, 1, ?2, ?2, 'run1')",
            rusqlite::params![real_ts, legacy_ts],
        ).unwrap();
        conn.execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, last_observed_at_ms)
             VALUES ('sess-real', 'claude-code', 'real-1', 'test', ?1), ('sess-legacy', 'claude-code', 'legacy-1', 'test', ?2)",
            rusqlite::params![real_ts, legacy_ts],
        ).unwrap();
        conn.execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                                     observation_kind, event_ts_ms, output_tokens,
                                     source_id, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f-real', 'claude-code', 'test', 'real-1', 'e1', 'assistant-usage', ?1, 100,
                     'src-real', 'run1', ?1, ?1),
                    ('f-legacy', 'claude-code', 'test', 'legacy-1', 'e2', 'legacy_aggregate', ?2, 200,
                     'src-legacy', 'run1', ?2, ?2)",
            rusqlite::params![real_ts, legacy_ts],
        ).unwrap();

        let env = build_envelope(conn, "candidate", None, coverage_not_applicable(), vec![], json!({}));
        // committed_at = sync_run 的 started_at_ms = 2023-11-15 北京；不影响
        // S4 fix 的核心断言（`max_observed_at` 必须等于**实时行**的
        // event_ts_ms，不能被 legacy_aggregate 行拉到 30h 后）。
        let _committed_at = env["authority_revision"]["committed_at"].as_str().unwrap();
        let max_observed = env["authority_revision"]["max_observed_at"].as_str().unwrap();
        assert_eq!(max_observed, ms_to_rfc3339_beijing(real_ts),
            "max_observed_at must reflect real rows, not legacy_aggregate (legacy ts={legacy_ts}, max_observed={max_observed})");

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn rfc3339_beijing_formats_epoch_zero() {
        // epoch 0 = 1970-01-01T08:00:00 北京。
        assert_eq!(ms_to_rfc3339_beijing(0), "1970-01-01T08:00:00.000+08:00");
    }

    #[test]
    fn rfc3339_beijing_carries_millis_and_offset() {
        let s = ms_to_rfc3339_beijing(1_757_000_000_123);
        assert!(s.ends_with(".123+08:00"), "{s}");
        assert_eq!(s.len(), "2026-09-04T21:33:20.123+08:00".len());
    }

    #[test]
    fn envelope_timezone_matches_the_timezone_used_for_statistics() {
        assert_eq!(
            crate::clock::statistics_timezone_name(),
            crate::clock::statistics_timezone().iana_name().unwrap_or("Etc/Unknown"),
        );
    }

    #[test]
    fn tool_specs_and_dispatch_agree() {
        let names: Vec<_> = tool_specs().iter().map(|t| t.name).collect();
        assert!(names.contains(&"data_status"));
        for name in ["trust_profile_schema", "trust_profile_list", "trust_profile_validate", "trust_profile_stage", "trust_profile_proposal_status"] {
            assert!(names.contains(&name), "Trust profile control-plane tool missing: {name}");
        }
        for name in ["get_building", "preview_building", "set_building_model", "reset_building", "im_publish"] {
            assert!(names.contains(&name), "City building/IM MCP tool missing: {name}");
        }
        // 每个注册的工具都有可分发的实现（不是 internal_error）。
        for name in names {
            let err = dispatch(name, &json!({}), Path::new("/nonexistent-data-home"))
                .err()
                .map(|e| e.code);
            assert_ne!(err, Some("internal_error"), "tool {name} not wired");
        }
    }

    #[test]
    fn source_status_is_registry_driven_and_reports_failures_without_paths() {
        let home = std::env::temp_dir().join(format!(
            "av-source-status-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let path = agent_vitals_data::authority::default_authority_path(&home);
        let db = AuthorityDb::open(&path, 1_700_000_000_000).unwrap();
        db.conn().execute(
            "INSERT INTO source_files(source_id, harness, path_hash, size_bytes, mtime_ns,
                 parser_version, first_seen_at_ms, last_seen_at_ms, last_error_code)
             VALUES ('src-c', 'codex', 'private-hash', 10, 1, 1, 100, 200, NULL),
                    ('src-d', 'dsh', 'other-private-hash', 10, 1, 1, 100, 300, 'permission')",
            [],
        ).unwrap();

        let report = source_status_report(db.conn()).unwrap();
        let sources = report["sources"].as_array().unwrap();
        let harnesses: Vec<_> = sources.iter().map(|s| s["harness"].as_str().unwrap()).collect();
        assert_eq!(harnesses, crate::ingest_service::FACT_HARNESSES);
        assert_eq!(sources[0]["connection_state"], "not_detected");
        assert_eq!(sources[1]["connection_state"], "connected");
        assert_eq!(sources[2]["connection_state"], "needs_attention");
        assert_eq!(sources[2]["failed_scope"]["error_codes"], json!(["permission"]));
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("private-hash"));
        assert!(!serialized.contains("other-private-hash"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn source_status_never_turns_query_failure_into_empty_sources() {
        let conn = Connection::open_in_memory().unwrap();
        let err = source_status_report(&conn).unwrap_err();
        assert!(err.contains("source_files query failed"), "{err}");
    }

    #[test]
    fn tool_schemas_are_closed_objects() {
        for t in tool_specs() {
            assert_eq!(t.input_schema["type"], "object", "{}", t.name);
            assert_eq!(
                t.input_schema["additionalProperties"], json!(false),
                "{} input schema must forbid unknown fields (spec §6.4)", t.name
            );
        }
    }

    #[test]
    fn dispatch_rejects_unknown_arguments() {
        // M08：多余字段不能被静默吞掉。
        let err = dispatch("data_status", &json!({ "sneaky": 1 }), Path::new("/nope"))
            .unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn session_trace_rejects_the_retired_raw_path_interface_before_any_file_read() {
        let err = dispatch(
            "session_trace",
            &json!({
                "path": "/etc/passwd",
                "harness": "dsh",
                "machine_namespace": "not-used",
            }),
            Path::new("/nonexistent-data-home"),
        )
        .unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert!(err.message.contains("unknown argument `path`"));
    }

    #[test]
    fn dispatch_rejects_non_object_arguments() {
        let err = dispatch("data_status", &json!("a string"), Path::new("/nope")).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }


    // PR #1 (mcp 0.9.1 SQL authority 收口)：CLI 二进制侧复用 mcp 模块的
    // 内部 helper（`check_as_of_run_id` / cursor 解析），确认 wrapper 行为
    // 与内部版一致——这是 PR #2 「CLI 切 mcp::dispatch」的前置不变式。
    #[test]
    fn check_as_of_run_id_pub_wrapper_agrees_with_internal() {
        // 不传 `as_of_run_id` → 两版都 Ok(())，warnings 不变。
        let mut w_internal: Vec<Value> = Vec::new();
        let mut w_pub: Vec<Value> = Vec::new();
        // 无 conn 也能跑这条快路径——前两个分支只看 `args`，不查 conn。
        let no_conn = || {
            // 拿一个空打开的 db——不必真有数据。
            let home = std::env::temp_dir().join(format!(
                "avmcp-asof-empty-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&home).unwrap();
            let path = agent_vitals_data::authority::default_authority_path(&home);
            let db = AuthorityDb::open(&path, 1).unwrap();
            (db, home)
        };
        let (db, home) = no_conn();
        check_as_of_run_id(db.conn(), &json!({}), &mut w_internal).unwrap();
        check_as_of_run_id_pub(db.conn(), &json!({}), &mut w_pub).unwrap();
        assert_eq!(w_internal, w_pub);
        assert!(w_internal.is_empty());
        let _ = std::fs::remove_dir_all(&home);

        // 传了一个 run_id 但库里无任何 sync_runs → 两版都 invalid_argument + 同 message。
        let (db, home) = no_conn();
        let mut w_int = Vec::new();
        let mut w_pub = Vec::new();
        let err_int = check_as_of_run_id(db.conn(), &json!({"as_of_run_id": "run-x"}), &mut w_int).unwrap_err();
        let err_pub = check_as_of_run_id_pub(db.conn(), &json!({"as_of_run_id": "run-x"}), &mut w_pub).unwrap_err();
        assert_eq!(err_int.code, err_pub.code);
        assert_eq!(err_int.code, "invalid_argument");
        assert_eq!(err_int.message, err_pub.message);
        let _ = std::fs::remove_dir_all(&home);
    }
}
