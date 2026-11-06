//! `session_trace` 工具（v0.10.0，spec §7 门槛 3 的 MCP 消费面）——
//! 对一个 `sessions_search` 返回的会话引用产出确定性 TraceGraph / timeline_series。
//!
//! **信任域说明（读代码前必读）**：本工具不接受路径。它解析安装级 HMAC
//! `session_ref` 后，只在当前用户三执行环境的固定目录反查 matching source，路径
//! 始终留在进程内部。这既让 Sessions → Trace 可用，也不会把 MCP 变成任意本机
//! 文件读取接口。
//!
//! **memo**：MCP server 是常驻消费面——Phase 3 memo（60s TTL +
//! `(COUNT, MAX(rowid))` 失效）在这里首次有真实收益；同一会话被反复下钻时
//! 命中同一份 `Arc<TraceGraph>`，不重算。CLI（一次性进程）不走 memo。
//!
//! **parity（spec §7 门槛 3）**：`output=graph` 的 `data` 与同一受控源文件
//! 建出的 CLI TraceGraph 必须相等；MCP 多出的只是 session_ref 安全解析，不得
//! 改变图的节点、证据或计量语义。

use std::path::Path;

use serde_json::{json, Value};

use super::{authority_state_for, build_envelope, AuthorityHandle, ToolError, ToolSpec};
use agent_vitals_data::authority_query;
use agent_vitals_domain::domain::trace::project_timeline_series;
use agent_vitals_domain::evidence::Linearization;

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "session_trace",
        description: "Build the deterministic TraceGraph (or its timeline_series projection) \
for ONE opaque session_ref returned by sessions_search. The server resolves that reference only \
against this installation's authority sessions and reads only a matching source under the fixed \
Claude Code/Codex/DSH roots; it never accepts caller-controlled file paths. Nodes are ordered by \
(scope, ordinal), never by timestamp; missing parent/time/status are counted in coverage, never \
fabricated. Three-harness closed vocabulary: claude-code / codex / dsh.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "session_ref": {
                    "type": "string",
                    "description": "Opaque per-install session id returned by sessions_search."
                },
                "output": {
                    "type": "string",
                    "enum": ["graph", "timeline_series", "insights"],
                    "description": "'graph' = full TraceGraph (byte-identical to the CLI's trace --json). 'timeline_series' = the projection consumed by the shared timeline geometry (buildGeometry), with an unplaced_events counter. 'insights' = consumption diagnostics from the authority DB only (turn axis with per-turn input/output tokens, hit rate, tool outcome counts and nominal cost; diagnostics as fact + cause certainty + remedy_id; safety rule counts). Never includes error/argument excerpts, fingerprints, paths or finding evidence text."
                }
            },
            "required": ["session_ref"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "envelope; data = TraceGraph JSON (output=graph) or timeline_series spec (output=timeline_series)",
            "additionalProperties": true
        }),
    }
}

pub fn run(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let session_ref = args
        .get("session_ref")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError::new("invalid_argument", "`session_ref` is required"))?;
    let output = args
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or("graph");
    if !matches!(output, "graph" | "timeline_series" | "insights") {
        return Err(ToolError::new(
            "invalid_argument",
            format!("unknown `output`: {output}"),
        ));
    }

    // 打不开权威库时连 session_ref 都不能安全反解，故不可降级成裸路径读取。
    let handle = AuthorityHandle::open(data_home)?;
    let conn = handle.conn();

    let salt = super::session_ref::load_or_create_salt(data_home)?;
    let keys = authority_query::all_session_keys(conn)
        .map_err(|e| ToolError::new("internal_error", format!("authority query: {e}")))?;
    let session_key = super::session_ref::resolve(&salt, session_ref, keys).ok_or_else(|| {
        ToolError::new("invalid_argument", "unknown session_ref — it may be from a different machine, or the session was deleted, or the salt was rotated")
    })?;
    if output == "insights" {
        // 只读权威库（不找源文件）：源日志轮换后诊断照样可用。
        let harness = authority_query::session_row(conn, &session_key)
            .map_err(|e| ToolError::new("internal_error", format!("authority query: {e}")))?
            .map(|(harness, _)| harness)
            .ok_or_else(|| ToolError::new("invalid_argument", "session not found"))?;
        let data = crate::query::session_insights::session_insights(conn, &session_key, &harness)
            .map_err(|e| ToolError::new("internal_error", format!("insights query: {e}")))?;
        return Ok(build_envelope(
            conn,
            authority_state_for(data_home),
            None,
            json!({
                "mode": "diagnostic",
                "harness": harness,
                "session_ref": session_ref,
                "output": output,
            }),
            Vec::new(),
            data,
        ));
    }
    let key = crate::trace_service::session_key_for(conn, &session_key)
        .map_err(|e| ToolError::new("invalid_argument", e.to_string()))?;
    let canonical = crate::trace_service::canonical_for_local_session(&key)
        .map_err(|e| ToolError::new("source_unavailable", e.to_string()))?;

    // memo 命中/回填（常驻消费面的收益点）；失败计数器查询视为内部错误。
    let graph = crate::trace_service::trace_graph_for_canonical(data_home, &key, &canonical, conn)
        .map_err(|e| ToolError::new("internal_error", e.to_string()))?;

    let (data, extra_coverage) = match output {
        "graph" => (graph.to_json(), json!({})),
        "timeline_series" => {
            // AllRecorded 不暴露成参数——v0.10.0 的图只有 adapter 选定的一条
            // 路径，域层会诚实拒绝；LeafPath 按契约不可能失败。
            let series = project_timeline_series(&graph, Linearization::LeafPath)
                .map_err(|e| ToolError::new("internal_error", e.to_string()))?;
            let unplaced = series
                .get("unplaced_events")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            (series, json!({ "unplaced_events": unplaced }))
        }
        _ => unreachable!(),
    };

    Ok(build_envelope(
        conn,
        authority_state_for(data_home),
        None,
        json!({
            "mode": "diagnostic",
            "harness": key.harness_kind,
            "session_ref": session_ref,
            "output": output,
            // coverage 语义：envelope 的 coverage 描述**这次查询**的完整度，
            // 与 TraceCoverage（图本身的诚实计数）分开——后者在 data.coverage。
            "trace": extra_coverage,
        }),
        Vec::new(),
        data,
    ))
}

#[cfg(test)]
mod insights_tests {
    use super::run;
    use agent_vitals_data::authority::AuthorityDb;
    use serde_json::{json, Value};

    const T0: i64 = 1_790_000_000_000;
    const MIN: i64 = 60_000;
    const SKEY: &str = "11:claude-code|10:priv-ins-01|2:ns";

    fn tmp_home(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "avmcp-ins-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    /// 12 个回合、每回合 3 次调用；回合 5 有同一调用的 2 次失败（带错误摘录）；
    /// 回合 3 有一条 SV601（metadata 带命令摘要）。
    fn seed(home: &std::path::Path) -> String {
        std::fs::create_dir_all(home).unwrap();
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(home), 1).unwrap();
        let c = db.conn();
        c.execute("INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version) VALUES ('run',1,'cli','succeeded',2)", []).unwrap();
        c.execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, 'claude-code', 'priv-ins-01', 'ns', 'default', 1)",
            rusqlite::params![SKEY],
        ).unwrap();
        let mut n = 0;
        for turn in 0..12i64 {
            let ts = T0 + turn * 2 * MIN;
            c.execute(
                "INSERT INTO workflow_events(event_id, session_key, event_ts_ms, event_type, outcome, ingested_run_id, created_at_ms)
                 VALUES (?1, ?2, ?3, 'task_started', 'unknown', 'run', 1)",
                rusqlite::params![format!("ts{turn}"), SKEY, ts],
            ).unwrap();
            for k in 0..3i64 {
                n += 1;
                c.execute(
                    "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, session_key,
                         source_event_id, observation_kind, model_id, event_ts_ms, event_peak,
                         uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                         ingested_run_id, created_at_ms, updated_at_ms)
                     VALUES (?1, 'claude-code', 'ns', 'priv-ins-01', ?2, ?1, 'assistant-usage', 'claude-sonnet-5', ?3, 0,
                             500, 49000, 500, 800, 'run', 1, 1)",
                    rusqlite::params![format!("f{n}"), SKEY, ts + 1_000 + k * 1_000],
                ).unwrap();
            }
        }
        for (i, dt) in [500i64, 1_500].iter().enumerate() {
            c.execute(
                "INSERT INTO workflow_events(event_id, session_key, event_ts_ms, event_type, capability_kind, capability_id,
                     outcome, invocation_fingerprint, error_excerpt, args_excerpt, ingested_run_id, created_at_ms)
                 VALUES (?1, ?2, ?3, 'tool_finished', 'tool', 'Bash', 'failed', 'fnv1a64:same-call',
                         'Error: Cannot find module vitest/config', '{\"command\":\"npx vitest run\"}', 'run', 1)",
                rusqlite::params![format!("fail{i}"), SKEY, T0 + 4 * 2 * MIN + dt],
            ).unwrap();
        }
        c.execute(
            "INSERT INTO issue_instances(issue_id, machine_namespace, harness, session_key, issue_type,
                 instance_fingerprint, status, severity, evaluator_id, evaluator_version,
                 evidence_fingerprint, opened_at_ms, metadata_json)
             VALUES ('iss1', 'ns', 'claude-code', ?1, 'SV601', 'fp1', 'open', 'critical', 'ev', '1', 'ef', ?3, ?2)",
            // 与生产一致：findings_eval 写的是**原生会话 id**，不是 ledger key。
            // opened_at_ms 必须是毫秒量级：秒量级会在重开库时被单位修复迁移改写。
            rusqlite::params!["priv-ins-01", json!({"tool_name": "bash", "evidence": "rm -rf ./secret-dir", "time": T0 + 2 * 2 * MIN + 10}).to_string(), T0],
        ).unwrap();
        drop(db);
        let salt = crate::mcp::session_ref::load_or_create_salt(home).unwrap();
        crate::mcp::session_ref::session_ref(&salt, SKEY)
    }

    fn insights(home: &std::path::Path, sref: &str) -> Value {
        run(&json!({ "session_ref": sref, "output": "insights" }), home).unwrap()
    }

    #[test]
    fn insights_builds_the_turn_axis_and_diagnostics_from_the_authority_db_only() {
        let home = tmp_home("axis");
        let sref = seed(&home);
        // 不存在任何执行环境源文件：insights 只读权威库。
        let env = insights(&home, &sref);
        let d = &env["data"];
        assert_eq!(d["axis"]["unit"], "turn");
        assert_eq!(d["axis"]["steps"].as_array().unwrap().len(), 12);
        assert_eq!(d["axis"]["steps"][4]["tools"]["failed"], 2);
        assert_eq!(d["lanes"]["consumption"]["state"], "available");
        assert_eq!(d["lanes"]["tools"]["state"], "available");
        let diag = &d["diagnostics"][0];
        assert_eq!(diag["kind"], "repeated_failure");
        assert_eq!(diag["steps"], json!({"from": 5, "to": 5}));
        assert_eq!(diag["cause"], "evidence");
        assert_eq!(diag["evidence"], json!(["error_excerpt"]));
        assert_eq!(d["safety"]["rules"][0], json!({"rule": "SV601", "severity": "critical", "count": 1, "steps": [3]}));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 出口红线（spec §10）：insights 经 MCP 供出，摘录、指纹原值、findings 的
    /// evidence 文本、原生会话 id 一律不得出现。
    #[test]
    fn insights_never_carry_excerpts_fingerprints_or_finding_evidence() {
        let home = tmp_home("egress");
        let sref = seed(&home);
        let text = insights(&home, &sref).to_string();
        for forbidden in ["Cannot find module", "npx vitest", "same-call", "rm -rf", "secret-dir", "priv-ins-01"] {
            assert!(!text.contains(forbidden), "insights 泄漏 {forbidden:?}: {text}");
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 本地证据面带摘录（检查器的「错误摘要」），且按回合范围过滤。
    #[test]
    fn local_evidence_carries_excerpts_for_the_requested_range_only() {
        let home = tmp_home("evidence");
        let _sref = seed(&home);
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(&home), 1).unwrap();
        let ev = crate::query::session_insights::session_trace_evidence(db.conn(), SKEY, 5, 5).unwrap();
        assert_eq!(ev["failures"].as_array().unwrap().len(), 2);
        assert_eq!(ev["failures"][0]["error_excerpt"], "Error: Cannot find module vitest/config");
        assert_eq!(ev["failures"][0]["step"], 5);
        assert_eq!(ev["calls"].as_array().unwrap().len(), 3, "只含回合 5 的调用");
        assert_eq!(ev["safety"][0]["summary"], "rm -rf ./secret-dir");
        assert_eq!(ev["safety"][0]["step"], 3);
        let none = crate::query::session_insights::session_trace_evidence(db.conn(), SKEY, 1, 2).unwrap();
        assert!(none["failures"].as_array().unwrap().is_empty());
        drop(db);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn insights_without_turn_events_fall_back_to_assistant_calls() {
        let home = tmp_home("nocalls");
        let sref = seed(&home);
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(&home), 1).unwrap();
        db.conn().execute("DELETE FROM workflow_events", []).unwrap();
        drop(db);
        let d = insights(&home, &sref)["data"].clone();
        assert_eq!(d["axis"]["unit"], "assistant_call");
        assert_eq!(d["axis"]["steps"].as_array().unwrap().len(), 36);
        assert_eq!(d["lanes"]["tools"], json!({"state": "unavailable", "reason": "no_data_in_session"}));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 旧的工具名级指纹（源日志已清理、无法重放纠正）不能当成「同一调用」；
    /// 路径形状的能力名只留末段（§10）。
    #[test]
    fn legacy_fingerprints_are_not_same_call_and_paths_are_trimmed() {
        let home = tmp_home("legacy");
        let sref = seed(&home);
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(&home), 1).unwrap();
        let legacy = agent_vitals_domain::session_semantics::fingerprint("claude-tool:Bash");
        for (i, turn) in [7i64, 8].iter().enumerate() {
            db.conn().execute(
                "INSERT INTO workflow_events(event_id, session_key, event_ts_ms, event_type, capability_kind, capability_id,
                     outcome, invocation_fingerprint, ingested_run_id, created_at_ms)
                 VALUES (?1, ?2, ?3, 'tool_finished', 'tool', 'Bash', 'failed', ?4, 'run', 1)",
                rusqlite::params![format!("legacy{i}"), SKEY, T0 + turn * 2 * MIN + 700, legacy],
            ).unwrap();
        }
        for (i, turn) in [9i64, 9, 10].iter().enumerate() {
            db.conn().execute(
                "INSERT INTO workflow_events(event_id, session_key, event_ts_ms, event_type, capability_kind, capability_id,
                     outcome, invocation_fingerprint, ingested_run_id, created_at_ms)
                 VALUES (?1, ?2, ?3, 'tool_finished', 'tool', '/bin/zsh', 'failed', ?4, 'run', 1)",
                rusqlite::params![format!("zsh{i}"), SKEY, T0 + turn * 2 * MIN + 800 + i as i64, format!("fnv1a64:zsh{i}")],
            ).unwrap();
        }
        drop(db);
        let env = insights(&home, &sref);
        let d = &env["data"];
        assert_eq!(d["quality"]["legacy_fingerprints"], 2);
        let kinds: Vec<(&str, i64)> = d["diagnostics"].as_array().unwrap().iter()
            .map(|x| (x["fact"]["capability_id"].as_str().unwrap_or(""), x["steps"]["from"].as_i64().unwrap())).collect();
        assert!(!kinds.iter().any(|(_, from)| *from == 8), "两次旧指纹失败不得报成同一调用：{kinds:?}");
        assert!(kinds.iter().any(|(cap, _)| *cap == "zsh"), "{kinds:?}");
        let text = env.to_string();
        assert!(!text.contains("/bin/"), "路径出现在 insights：{text}");
        assert!(!text.contains("/Users/"), "路径出现在 insights");
        let _ = std::fs::remove_dir_all(&home);
    }

    fn write_or_check(name: &str, golden: &Value) {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/session_insights").join(name);
        let rendered = serde_json::to_string_pretty(golden).unwrap() + "\n";
        if std::env::var("UPDATE_INSIGHTS_FIXTURE").is_ok() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &rendered).unwrap();
        }
        let expected = std::fs::read_to_string(&path).expect("golden fixture missing — run with UPDATE_INSIGHTS_FIXTURE=1");
        assert_eq!(rendered, expected, "insights 形状变了：确认是有意的，再更新金样并同改 lib/sessionInsights.ts");
    }

    fn fact(db: &AuthorityDb, id: &str, ts: i64, model: &str, read: i64, write: i64, unc: i64) {
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, session_key,
                 source_event_id, observation_kind, model_id, event_ts_ms, event_peak,
                 uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES (?1, 'claude-code', 'ns', 'priv-ins-01', ?2, ?1, 'assistant-usage', ?3, ?4, 0, ?5, ?6, ?7, 400, 'run', 1, 1)",
            rusqlite::params![id, SKEY, model, ts, unc, read, write],
        ).unwrap();
    }

    fn turn(db: &AuthorityDb, id: &str, ts: i64) {
        db.conn().execute(
            "INSERT INTO workflow_events(event_id, session_key, event_ts_ms, event_type, outcome, ingested_run_id, created_at_ms)
             VALUES (?1, ?2, ?3, 'task_started', 'unknown', 'run', 1)",
            rusqlite::params![id, SKEY, ts],
        ).unwrap();
    }

    /// 跨语言形状金样：真实 MCP 输出（合成种子，不含本机数据）落在
    /// `fixtures/session_insights/`，TS 契约脚本（scripts/verify-react-session-insights-contract.mjs）
    /// 用同一份文件喂桥的解析器。此前前端只拿手写 mock 测，mock 总带 `ended_at_ms`，
    /// 真实输出省略它时一半会话被解析器拒绝（验收 blocker）；确认轮又指出金样只覆盖了
    /// 一小部分形状——这里的种子要让三类诊断、名义成本、回合结果、说明、前导步、空回合
    /// 都出现。更新：`UPDATE_INSIGHTS_FIXTURE=1 cargo test -p agent-vitals-mcp golden`。
    #[test]
    fn insights_golden_fixture_matches_the_rust_output() {
        let home = tmp_home("golden");
        let sref = seed(&home);
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(&home), 1).unwrap();
        // 价格快照（早于所有调用）→ 回合与会话的名义成本。
        let payload = json!({ "pricing": agent_vitals_domain::cost::load_pricing() }).to_string();
        db.conn().execute(
            "INSERT INTO pricing_snapshots(pricing_version, captured_at_ms, source_kind, payload_json) VALUES ('golden-v1', ?1, 'test', ?2)",
            rusqlite::params![T0 - 86_400_000, payload],
        ).unwrap();
        // 首回合前的调用 → 前导步。
        fact(&db, "early", T0 - 5 * MIN, "claude-sonnet-5", 0, 30_000, 900);
        // 一个没有任何测量的空回合（缺 ended_at_ms / hit_rate / idle_before_ms）。
        turn(&db, "empty-turn", T0 + 12 * 2 * MIN + 30 * MIN);
        // 回合 8–9 基线不稳后的高未命中（unexplained）：把这两个回合的调用改成低命中。
        db.conn().execute(
            "UPDATE usage_facts SET cache_read_tokens = 5000, cache_write_tokens = 40000, uncached_input_tokens = 5000
             WHERE event_ts_ms >= ?1 AND event_ts_ms < ?2",
            rusqlite::params![T0 + 7 * 2 * MIN, T0 + 9 * 2 * MIN],
        ).unwrap();
        db.conn().execute(
            "UPDATE usage_facts SET cache_read_tokens = 30000, cache_write_tokens = 10000, uncached_input_tokens = 10000
             WHERE event_ts_ms >= ?1 AND event_ts_ms < ?2",
            rusqlite::params![T0 + 6 * 2 * MIN + 2_500, T0 + 7 * 2 * MIN],
        ).unwrap();
        // 长空闲后的低命中（说明，不进清单）+ 其后 12 个回合的单次输入持续增长。
        let base = T0 + 90 * MIN;
        for k in 0..12i64 {
            let ts = base + k * 2 * MIN;
            turn(&db, &format!("g{k}"), ts);
            let size = 40_000 + k * 12_000;
            if k == 0 {
                fact(&db, &format!("g{k}a"), ts + 1_000, "claude-sonnet-5", 0, size - 500, 500);
            } else {
                fact(&db, &format!("g{k}a"), ts + 1_000, "claude-sonnet-5", size - 1_000, 500, 500);
            }
        }
        // 命中率下降（有基线）+ 区间内一次长空闲后的低命中 → `hit_rate_drop` 诊断带
        // `hit_before/hit_after` 与非空 `context_notes`（确认轮：金样此前缺这两种形状）。
        let drop_at = T0 + 200 * MIN;
        for k in 0..6i64 {
            let ts = drop_at + k * 2 * MIN;
            turn(&db, &format!("d{k}"), ts);
            fact(&db, &format!("d{k}a"), ts + 1_000, "claude-sonnet-5", 58_000, 1_000, 1_000);
        }
        let low = drop_at + 6 * 2 * MIN;
        turn(&db, "dlow", low);
        fact(&db, "dlow1", low + 1_000, "claude-sonnet-5", 10_000, 45_000, 5_000);
        fact(&db, "dlow2", low + 2_000, "claude-sonnet-5", 10_000, 45_000, 5_000);
        turn(&db, "dlow-idle", low + 8 * MIN);
        fact(&db, "dlow3", low + 8 * MIN + 1_000, "claude-sonnet-5", 10_000, 45_000, 5_000);
        // 一个被中断的回合（回合结果 cancelled）。
        db.conn().execute(
            "INSERT INTO workflow_events(event_id, session_key, event_ts_ms, event_type, outcome, ingested_run_id, created_at_ms)
             VALUES ('cancel', ?1, ?2, 'task_finished', 'cancelled', 'run', 1)",
            rusqlite::params![SKEY, T0 + 2 * 2 * MIN + 30_000],
        ).unwrap();
        drop(db);
        let mut env = insights(&home, &sref);
        // envelope 里与环境相关的字段（生成时间、权威库状态）不进金样。
        let golden = json!({ "data": env["data"].take() });
        write_or_check("insights_envelope.json", &golden);
        let d = &golden["data"];
        let kinds: std::collections::BTreeSet<&str> = d["diagnostics"].as_array().unwrap().iter().map(|x| x["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds.len(), 3, "金样必须覆盖三类诊断：{kinds:?}");
        assert_eq!(d["axis"]["leading_step"], true);
        let steps = d["axis"]["steps"].as_array().unwrap();
        assert!(steps.iter().any(|s| s.get("ended_at_ms").is_none()), "金样必须包含可选键缺席的步");
        assert!(steps.iter().any(|s| s["outcome"] == "cancelled"));
        assert!(steps.iter().any(|s| !s["notes"].as_array().unwrap().is_empty()));
        assert!(steps.iter().any(|s| s.get("nominal_cost").is_some()));
        assert!(d["session"].get("nominal_cost").is_some());
        let drop_diag = d["diagnostics"].as_array().unwrap().iter()
            .find(|x| x["explanation"] == "hit_rate_drop").expect("金样必须有 hit_rate_drop 诊断");
        assert!(drop_diag["fact"].get("hit_before").is_some() && drop_diag["fact"].get("hit_after").is_some());
        assert!(!drop_diag["context_notes"].as_array().unwrap().is_empty(), "金样必须有非空 context_notes");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 第二份金样：没有回合事件、没有工具结果的会话——按调用铺开（`fallback` 为字符串）、
    /// 工具泳道不可用并带原因、无价格快照时的 `nominal_cost_reason`。
    #[test]
    fn insights_golden_fixture_per_call_axis() {
        let home = tmp_home("golden-percall");
        let sref = seed(&home);
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(&home), 1).unwrap();
        db.conn().execute("DELETE FROM workflow_events", []).unwrap();
        db.conn().execute("DELETE FROM issue_instances", []).unwrap();
        db.conn().execute("DELETE FROM usage_facts WHERE fact_id NOT IN ('f1','f2','f3','f4','f5')", []).unwrap();
        drop(db);
        let mut env = insights(&home, &sref);
        let golden = json!({ "data": env["data"].take() });
        write_or_check("insights_envelope_per_call.json", &golden);
        let d = &golden["data"];
        assert_eq!(d["axis"]["fallback"], "few_turn_starts");
        assert_eq!(d["lanes"]["tools"]["state"], "unavailable");
        assert_eq!(d["session"]["nominal_cost_reason"], "no_pricing_snapshot");
        let _ = std::fs::remove_dir_all(&home);
    }
}
