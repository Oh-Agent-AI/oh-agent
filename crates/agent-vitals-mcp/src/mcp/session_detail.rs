//! `session_detail` 工具（spec §7.7 / Q04 / Q10 / U05）——一个会话的行级时间线
//! （用量事实按时间排序）。入参是 `sessions_search` 返回的 `session_ref`；服务端
//! 对 `sessions` 表逐行算 HMAC 找出对应 `session_key`（本机量级，微秒级）。
//!
//! 时间线 = `usage_facts` 行：模型切换、逐事件 token、高峰时段标记。**不含**
//! 对话正文 / prompt / 工具原始参数 / 原生 session id / 路径。
//!
//! Q10 的失败/错误事件富化通过 `workflow_events` 并列返回；两条时间线
//! 保持独立，避免把无法一一归因的 workflow 事件硬分摊到 token/cost。

use std::path::Path;

use serde_json::{json, Value};

use super::{authority_state_for, build_envelope, ms_to_rfc3339_beijing, AuthorityHandle, ToolError, ToolSpec};
use agent_vitals_data::authority_query;

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "session_detail",
        description: "Given an opaque session_ref (from sessions_search), return that session's usage timeline and a separate redacted workflow timeline for task, Skill, tool, model, and failure events. Never returns conversation text, prompts, raw tool args, native session ids or file paths.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "session_ref": { "type": "string", "description": "Opaque per-install session id from sessions_search.session_ref." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "Timeline page size (default 200, max 1000)." },
                "cursor": { "type": "string", "description": "Opaque cursor from a previous page's data.next_cursor." }
            },
            "required": ["session_ref"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "spec §6 envelope; data includes usage timeline[] and a separate redacted workflow_timeline[]. cost_status explains any null amount; billing_breakdown is independently grouped by provider, model, peak slot, template and pricing snapshot; it preserves unresolved custom routes rather than merging their costs."
        }),
    }
}

fn parse_cursor(c: &str) -> Option<(i64, String)> {
    let (ts_s, rest) = c.split_once(':')?;
    let ts: i64 = ts_s.parse().ok()?;
    let (len_s, id) = rest.split_once(':')?;
    let len: usize = len_s.parse().ok()?;
    if id.len() != len {
        return None;
    }
    Some((ts, id.to_string()))
}

fn make_cursor(ts: i64, fact_id: &str) -> String {
    format!("{ts}:{}:{fact_id}", fact_id.len())
}

/// `parse_cursor` 的 `pub` 包装——CLI 二进制侧把 `session_detail` 返回的
/// `next_cursor` 直接透传给同工具的下一调用时复用同一段解析逻辑。**注意**：
/// `session_detail` 的 cursor 形状（`<ts>:<fact_id_len>:<fact_id>`）与
/// `sessions_search` 的 cursor（`<total>:<session_key_len>:<session_key>`）
/// **不通用**——CLI 不能在两个工具之间互换 cursor。错误形态与 MCP envelope
/// 一致（spec §11 `invalid_argument`）。
pub fn parse_detail_cursor(c: &str) -> Result<(i64, String), ToolError> {
    parse_cursor(c).ok_or_else(|| ToolError::new("invalid_argument", "malformed `cursor`"))
}

/// `make_cursor` 的 `pub` 包装——CLI 侧若需要从已知的 `(ts, fact_id)` 复刻
/// 一个 cursor 时复用。一般 CLI 用不到，保留给将来需要时。
pub fn make_detail_cursor(ts: i64, fact_id: &str) -> String {
    make_cursor(ts, fact_id)
}

pub fn run(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let session_ref = args
        .get("session_ref")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError::new("invalid_argument", "`session_ref` is required"))?;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, MAX_LIMIT))
        .unwrap_or(DEFAULT_LIMIT);
    let cursor = match args.get("cursor").and_then(Value::as_str) {
        None => None,
        Some(c) => Some(
            parse_cursor(c).ok_or_else(|| ToolError::new("invalid_argument", "malformed `cursor`"))?,
        ),
    };

    let handle = AuthorityHandle::open(data_home)?;
    let conn = handle.conn();
    let mut warnings = Vec::new();
    super::check_as_of_run_id(conn, args, &mut warnings)?;

    let salt = super::session_ref::load_or_create_salt(data_home)?;
    let keys = authority_query::all_session_keys(conn)
        .map_err(|e| ToolError::new("internal_error", format!("authority query: {e}")))?;
    let session_key = super::session_ref::resolve(&salt, session_ref, keys).ok_or_else(|| {
        ToolError::new(
            "invalid_argument",
            "unknown session_ref — it may be from a different machine, or the session was deleted, or the salt was rotated",
        )
    })?;

    let (harness, _profile) = authority_query::session_row(conn, &session_key)
        .map_err(|e| ToolError::new("internal_error", format!("authority query: {e}")))?
        .ok_or_else(|| ToolError::new("invalid_argument", "session_ref resolved but the session row is gone"))?;

    let (after_ts, after_id) = match &cursor {
        Some((t, i)) => (Some(*t), Some(i.as_str())),
        None => (None, None),
    };
    let (facts, has_more) =
        authority_query::session_facts_timeline(conn, &session_key, after_ts, after_id, limit)
            .map_err(|e| ToolError::new("internal_error", format!("authority query: {e}")))?;

    // 会话总计（全量，不受分页影响）——从一份大 limit 的重查里折，或直接 SQL
    // 聚合。这里走聚合 SQL（`sessions_in_window` 的单会话情形太重），直接 query。
    let (mut u, mut cr, mut cw, mut o, mut n, mut first, mut last): (i64, i64, i64, i64, i64, Option<i64>, Option<i64>) =
        (0, 0, 0, 0, 0, None, None);
    let mut models: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(model_id,'<unknown>'), event_ts_ms,
                        uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens
                 FROM usage_facts
                 WHERE session_key = ?1 AND observation_kind != 'legacy_aggregate'
                   AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL",
            )
            .map_err(|e| ToolError::new("internal_error", e.to_string()))?;
        let rows = stmt
            .query_map(rusqlite::params![session_key], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            })
            .map_err(|e| ToolError::new("internal_error", e.to_string()))?;
        for row in rows {
            let (m, ts, a, b, c, d) = row.map_err(|e| ToolError::new("internal_error", e.to_string()))?;
            models.insert(m);
            n += 1;
            u += a;
            cr += b;
            cw += c;
            o += d;
            first = Some(first.map_or(ts, |x: i64| x.min(ts)));
            last = Some(last.map_or(ts, |x: i64| x.max(ts)));
        }
    }

    let timeline: Vec<Value> = facts
        .iter()
        .map(|f| {
            json!({
                "event_at": ms_to_rfc3339_beijing(f.event_ts_ms),
                "model_id": f.model_id,
                "identity_kind": "harness_raw",
                "observation_kind": f.observation_kind,
                "peak": f.event_peak,
                "fact_id": f.fact_id,
                "tokens": {
                    "uncached_input_tokens": f.uncached_input_tokens,
                    "cache_read_tokens": f.cache_read_tokens,
                    "cache_write_tokens": f.cache_write_tokens,
                    "output_tokens": f.output_tokens,
                    "total": f.uncached_input_tokens + f.cache_read_tokens + f.cache_write_tokens + f.output_tokens,
                },
            })
        })
        .collect();

    // Workflow 事件与 usage facts 没有可靠的一对一归因关系，因此作为独立轴
    // 返回。只读已由 adapter 脱敏的字段；不把 session_key/event_id/native id
    // 暴露给调用方。limit 共用本页大小，超出部分显式报告而不是静默截断。
    let mut workflow_timeline = Vec::new();
    let workflow_limit = limit.saturating_add(1);
    {
        let mut statement = conn
            .prepare(
                "SELECT event_ts_ms, event_type, capability_kind, capability_id,
                        capability_version, outcome, duration_ms, error_fingerprint,
                        invocation_fingerprint
                 FROM workflow_events
                 WHERE session_key = ?1
                 ORDER BY event_ts_ms ASC, event_id ASC
                 LIMIT ?2",
            )
            .map_err(|e| ToolError::new("internal_error", e.to_string()))?;
        let rows = statement
            .query_map(rusqlite::params![session_key, workflow_limit as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })
            .map_err(|e| ToolError::new("internal_error", e.to_string()))?;
        for row in rows {
            let (event_ts_ms, event_type, capability_kind, capability_id,
                capability_version, outcome, duration_ms, error_fingerprint,
                invocation_fingerprint) =
                row.map_err(|e| ToolError::new("internal_error", e.to_string()))?;
            workflow_timeline.push(json!({
                "event_at": ms_to_rfc3339_beijing(event_ts_ms),
                "event_type": event_type,
                "capability_kind": capability_kind,
                "capability_id": capability_id,
                "capability_version": capability_version,
                "outcome": outcome,
                "duration_ms": duration_ms,
                "error_fingerprint": error_fingerprint,
                // 参数级指纹可被离线穷举验证：只给安装级加盐伪名（分组用途不变）。
                "invocation_fingerprint": invocation_fingerprint.map(|fp| super::session_ref::pseudonym(&salt, &fp)),
            }));
        }
    }
    let workflow_has_more = workflow_timeline.len() > limit;
    if workflow_has_more {
        workflow_timeline.truncate(limit);
    }

    let next_cursor = facts
        .last()
        .filter(|_| has_more)
        .map(|f| make_cursor(f.event_ts_ms, &f.fact_id));

    // 会话成本统一投影：金额兼容字段与 null 原因、价格版本、来源、证据状态
    // 同时返回，避免客户端把订阅/缺价误读成零成本。
    let cost_view = authority_query::session_cost_view(conn, &session_key)
        .map_err(|e| ToolError::new("internal_error", format!("authority query: {e}")))?;
    let billing_breakdown = authority_query::session_billing_buckets(conn, &session_key)
        .map_err(|e| ToolError::new("internal_error", format!("authority query: {e}")))?;

    let data = json!({
        "session_ref": session_ref,
        "harness": harness,
        "first_event_at": first.map(ms_to_rfc3339_beijing),
        "last_event_at": last.map(ms_to_rfc3339_beijing),
        "event_count": n,
        "model_ids": models.into_iter().collect::<Vec<_>>(),
        "identity_kind": "harness_raw",
        "tokens": {
            "uncached_input_tokens": u,
            "cache_read_tokens": cr,
            "cache_write_tokens": cw,
            "output_tokens": o,
            "total": u + cr + cw + o,
        },
        "cost_minor": cost_view["cost_minor"],
        "cost_status": {
            "state": cost_view["status"],
            "reason": cost_view["reason"],
            "has_unresolved": cost_view["has_unresolved"],
            "pricing_versions": cost_view["pricing_versions"],
        },
        "billing_breakdown": billing_breakdown,
        "timeline": timeline,
        "workflow_timeline": workflow_timeline,
        "workflow_has_more": workflow_has_more,
        "has_more": has_more,
        "next_cursor": next_cursor,
        "note": "usage and workflow timelines are separate; workflow events are redacted and are not token/cost allocations",
    });

    Ok(build_envelope(
        conn,
        authority_state_for(data_home),
        last,
        super::coverage_not_applicable(),
        warnings,
        data,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;
    use agent_vitals_data::authority_query::beijing_day_bounds_ms;

    fn tmp_home(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "avmcp-sd-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    fn seed_session(home: &std::path::Path) -> (String, String) {
        std::fs::create_dir_all(home).unwrap();
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(home), 1).unwrap();
        let skey = "3:dsh|10:priv-abc-99|2:ns";
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version) VALUES ('run',1,'cli','succeeded',2)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, 'dsh', 'priv-abc-99', 'ns', 'default', 1)",
            rusqlite::params![skey],
        ).unwrap();
        let (start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        for (i, (m, peak, tok)) in [("m-a", 0, 100), ("m-a", 0, 50), ("m-b", 1, 200)].iter().enumerate() {
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, session_key,
                     source_event_id, observation_kind, model_id, event_ts_ms, event_peak,
                     uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, 'dsh', 'ns', 'priv-abc-99', ?2, ?1, 'assistant-usage', ?3, ?4, ?5, ?6, 0, 0, 0, 'run', 1, 1)",
                rusqlite::params![format!("d{i}"), skey, m, start + (i as i64) * 3_600_000, peak, tok],
            ).unwrap();
        }
        db.conn().execute(
            "INSERT INTO workflow_events(
                 event_id, session_key, event_ts_ms, event_type, capability_kind,
                 capability_id, outcome, duration_ms, error_fingerprint,
                 invocation_fingerprint, ingested_run_id, created_at_ms)
             VALUES ('wf-start', ?1, ?2, 'task_started', NULL, NULL, 'succeeded', NULL, NULL, NULL, 'run', 1)",
            rusqlite::params![skey, start + 100],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO workflow_events(
                 event_id, session_key, event_ts_ms, event_type, capability_kind,
                 capability_id, outcome, duration_ms, error_fingerprint,
                 invocation_fingerprint, ingested_run_id, created_at_ms)
             VALUES ('wf-tool', ?1, ?2, 'tool_finished', 'tool', 'bash', 'failed', 12, 'fnv1a64:deadbeef', 'fnv1a64:cafebabe', 'run', 1)",
            rusqlite::params![skey, start + 200],
        ).unwrap();
        drop(db);
        // 拿一个真 session_ref
        let salt = super::super::session_ref::load_or_create_salt(home).unwrap();
        (skey.to_string(), super::super::session_ref::session_ref(&salt, skey))
    }

    #[test]
    fn resolves_ref_builds_timeline_and_never_leaks_native() {
        let home = tmp_home("ok");
        let (_skey, sref) = seed_session(&home);
        let env = run(&json!({ "session_ref": sref }), &home).unwrap();
        let d = &env["data"];
        assert_eq!(d["harness"], "dsh");
        assert_eq!(d["event_count"], 3);
        assert_eq!(d["tokens"]["total"], 350);
        assert_eq!(d["model_ids"], json!(["m-a", "m-b"]));
        let buckets = d["billing_breakdown"].as_array().unwrap();
        assert_eq!(buckets.len(), 2, "model + peak axes stay independently visible");
        assert_eq!(buckets[0]["tokens"]["total"], 150);
        assert_eq!(buckets[1]["tokens"]["total"], 200);
        let tl = d["timeline"].as_array().unwrap();
        assert_eq!(tl.len(), 3);
        assert_eq!(tl[2]["peak"], true);
        assert_eq!(tl[0]["model_id"], "m-a");
        assert_eq!(tl[2]["model_id"], "m-b");
        // 时间线时间序。
        assert!(tl[0]["event_at"].as_str().unwrap() < tl[1]["event_at"].as_str().unwrap());
        let workflow = d["workflow_timeline"].as_array().unwrap();
        assert_eq!(workflow.len(), 2);
        assert_eq!(workflow[1]["event_type"], "tool_finished");
        assert_eq!(workflow[1]["outcome"], "failed");
        // 参数级调用指纹可被离线穷举验证：只出安装级加盐伪名。
        let ik = workflow[1]["invocation_fingerprint"].as_str().unwrap();
        assert!(ik.starts_with("ik_") && !ik.contains("cafebabe"), "{ik}");
        assert_eq!(d["workflow_has_more"], false);
        let txt = env.to_string();
        assert!(!txt.contains("priv-abc-99"), "原生 id 泄漏: {txt}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn unknown_ref_is_invalid_argument() {
        let home = tmp_home("bad");
        seed_session(&home);
        let err = run(&json!({ "session_ref": "sr_00000000000000000000000000000000" }), &home).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert_eq!(run(&json!({}), &home).unwrap_err().code, "invalid_argument");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn timeline_paginates() {
        let home = tmp_home("pg");
        let (_k, sref) = seed_session(&home);
        let env = run(&json!({ "session_ref": sref.clone(), "limit": 2 }), &home).unwrap();
        assert_eq!(env["data"]["timeline"].as_array().unwrap().len(), 2);
        assert_eq!(env["data"]["has_more"], true);
        // 总计不受分页影响。
        assert_eq!(env["data"]["tokens"]["total"], 350);
        assert_eq!(env["data"]["event_count"], 3);
        let cur = env["data"]["next_cursor"].as_str().unwrap().to_string();
        let env2 = run(&json!({ "session_ref": sref, "limit": 2, "cursor": cur }), &home).unwrap();
        assert_eq!(env2["data"]["timeline"].as_array().unwrap().len(), 1);
        assert_eq!(env2["data"]["has_more"], false);
        let _ = std::fs::remove_dir_all(&home);
    }

    // PR #2.2：session_detail envelope 加 `cost_minor`——无定价快照时为 null，
    // 有快照时是按价表估算的 {amount_minor, currency, basis=MeteredEstimate}。
    #[test]
    fn detail_envelope_exposes_cost_minor_field() {
        let home = tmp_home("cost");
        let (_skey, sref) = seed_session(&home);
        let payload = r#"{"fallback_provider":"deepseek-official","providers":{"deepseek-official":{"models":{"m-a":{"input_uncached":{"off_peak":4.5,"peak":9.0}},"m-b":{"input_uncached":{"off_peak":4.5,"peak":9.0}}}}}}"#;
        // pricing_snapshot 必须先于 event_ts 落，asof 才命中。
        AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(&home), 1)
            .unwrap()
            .pricing_snapshot_put("v1", "cli_seed", payload, 1)
            .unwrap();
        let env = run(&json!({ "session_ref": sref }), &home).unwrap();
        let cm = &env["data"]["cost_minor"];
        assert!(cm.is_object(), "有价卡覆盖 → 字段为对象");
        assert_eq!(cm["currency"], "CNY");
        assert_eq!(cm["basis"], "metered_estimate");
        assert!(cm["amount_minor"].is_i64());
        assert_eq!(cm["pricing_versions"], json!(["v1"]));
        assert_eq!(cm["pricing_source"], "fallback_official");
        assert_eq!(env["data"]["cost_status"]["state"], "estimated");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn detail_cost_minor_is_null_when_no_pricing_snapshot() {
        let home = tmp_home("cost-null");
        let (_skey, sref) = seed_session(&home);
        // 不插价卡。
        let env = run(&json!({ "session_ref": sref }), &home).unwrap();
        assert!(env["data"]["cost_minor"].is_null(),
            "无价卡覆盖 → null（不冒充零成本）");
        assert_eq!(env["data"]["cost_status"]["state"], "unavailable");
        assert_eq!(env["data"]["cost_status"]["reason"], "no-pricing-snapshot");
        let _ = std::fs::remove_dir_all(&home);
    }

    // PR #1 (mcp 0.9.1 SQL authority 收口)：CLI 二进制侧会直接调
    // `parse_detail_cursor` / `make_detail_cursor` 透传 cursor；钉住
    // round-trip + 错误形态 + 与 sessions_search cursor 不通用。
    #[test]
    fn parse_detail_cursor_roundtrip_and_errors() {
        // fact_id 可能含连字符/下划线（hex64）。
        let fid = "f_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let ts = 1_757_000_000_123_i64;
        let cursor = make_detail_cursor(ts, fid);
        let (got_ts, got_id) = parse_detail_cursor(&cursor).expect("roundtrip ok");
        assert_eq!(got_ts, ts);
        assert_eq!(got_id, fid);

        // 长度前缀与实际 fact_id 长度不一致 → invalid_argument。
        let bad_len = format!("{ts}:{}:{fid}", fid.len() + 1);
        let err = parse_detail_cursor(&bad_len).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert_eq!(err.message, "malformed `cursor`");

        // 形态错位 / 缺段 / 非数字——都应是同一 invalid_argument。
        for bad in ["", "100", "100:5", "abc:5:xyz", "100:abc:xyz"] {
            let err = parse_detail_cursor(bad).unwrap_err();
            assert_eq!(err.code, "invalid_argument", "input={bad:?}");
        }
    }

    #[test]
    fn detail_and_search_cursors_are_not_interchangeable() {
        // 关键不变量：CLI 不能把 sessions_search 的 cursor 喂给 session_detail
        // （反之亦然）。格式看起来都是 `<n>:<len>:<body>`，但语义不同；
        // 透传会被对端工具的解析误读为合法 cursor，导致下游 SQL 默默接受
        // 错误的 `(after_total, after_key)` / `(after_ts, after_id)`。
        use super::super::{make_search_cursor, parse_detail_cursor};
        let search_cursor = make_search_cursor(999, "5:codex|2:s1|5:/repo|6:ns-abc");
        // 给 detail 解析：它的语义是 (ts, fact_id) —— 把 `999` 当 `ts`、把
        // `5:codex|2:s1|5:/repo|6:ns-abc` 当 fact_id；解析不会出错（长度前缀对
        // 得上），但**语义错位**。这条断言钉住「解析通过 ≠ 语义通过」——
        // CLI 调用方必须按工具选用 cursor。
        let (parsed_ts, parsed_fid) = parse_detail_cursor(&search_cursor).expect("格式上能解析");
        assert_eq!(parsed_ts, 999);
        assert_eq!(parsed_fid, "5:codex|2:s1|5:/repo|6:ns-abc");
        // 这条单测不直接禁止，但会与 review checklist 协同：CLI 侧 PR #2
        // 应禁止把任一 cursor 透传给另一工具。
    }
}
