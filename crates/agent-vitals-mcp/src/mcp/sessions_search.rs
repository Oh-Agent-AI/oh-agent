//! `sessions_search` 工具（spec §7.6 / Q04 / U05）——列出一个时间窗（可再按
//! 统计时区小时过滤）内的会话，逐会话聚合 token / 时间跨度 / 模型集，按 total 降序、
//! keyset 分页。**只出 `session_ref`（HMAC），绝不出执行环境原生 id / 路径 / 正文。**
//!
//! Q04 峰值下钻：`usage_hourly(date)` 给 `peak_hour` → `sessions_search(date,
//! hour=peak_hour)` 给该小时的会话构成，`data.window_total_tokens` 让调用方核对
//! 「所有会话 token 之和 == 峰值小时总量」。分页截断时 `has_more=true` +
//! `truncated` warning——**不**默默让展示的会话不足以求和。

use std::path::Path;

use serde_json::{json, Value};

use super::{authority_state_for, build_envelope, ms_to_rfc3339_beijing, AuthorityHandle, ToolError, ToolSpec};
use agent_vitals_data::authority_query::{self, beijing_day_bounds_ms, beijing_month_bounds_ms};

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 500;

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "sessions_search",
        description: "List sessions active in a day or month in the configured statistics timezone (optionally narrowed to one local hour), each aggregated: token buckets, first/last event, distinct raw model ids, event count, peak-slot token share. Sorted by total tokens descending, keyset-paginated (order=oldest: first event ascending). Sessions are identified only by an opaque per-install session_ref (HMAC) — never a native id. data.window_total_tokens lets a caller check that the returned sessions sum to the window/peak total; if has_more is true the page was truncated and the sum is partial.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "date": { "type": "string", "description": "Date YYYY-MM-DD in the configured statistics timezone. Exactly one of date / month / date_from+date_to." },
                "month": { "type": "string", "description": "Month YYYY-MM in the configured statistics timezone. Exactly one of date / month / date_from+date_to." },
                "date_from": { "type": "string", "description": "Inclusive start date YYYY-MM-DD in the configured statistics timezone; must be paired with date_to." },
                "date_to": { "type": "string", "description": "Inclusive end date YYYY-MM-DD in the configured statistics timezone; must be paired with date_from." },
                "hour": { "type": "integer", "minimum": 0, "maximum": 23,
                          "description": "Optional: only count each session's facts in this local statistics hour (for peak-hour drill-down). Requires date." },
                "harnesses": { "type": "array", "items": { "type": "string" },
                           "description": "Optional harness filter (claude-code / codex / dsh). Empty/missing = all known harnesses." },
                "model": { "type": "string", "description": "Optional exact model id filter; missing model facts use <unknown>." },
                "provider": { "type": "string", "description": "Optional exact provider id filter; missing provider evidence uses <unknown>." },
                "min_tokens": { "type": "integer", "minimum": 0,
                                "description": "Optional: drop sessions whose window total is below this." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500,
                           "description": "Page size (default 50, max 500)." },
                "cursor": { "type": "string", "description": "Opaque cursor from a previous page's data.next_cursor. Continue a page with the same order the page was produced with." },
                "order": { "type": "string", "enum": ["tokens", "oldest"],
                           "description": "Result ordering: 'tokens' (window total desc, default) or 'oldest' (first event asc). Cursors are order-specific." },
                "as_of_run_id": { "type": "string", "description": "spec §6.4.1 snapshot token; drift → warning." }
            },
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "spec §6 envelope; data = { window, sessions[], window_total_tokens, window_session_count, has_more, next_cursor }. Per-session tokens/peak_tokens are aggregated; cost_minor is the price-table-derived metered_estimate with pricing provenance, while cost_status explains subscription, unpriced, mixed-provider, or unavailable nulls."
        }),
    }
}

fn parse_cursor(c: &str) -> Option<(i64, String)> {
    // "<total>:<session_key_len>:<session_key>" —— session_key 自身含 ':'，故带长度前缀。
    let (total_s, rest) = c.split_once(':')?;
    let total: i64 = total_s.parse().ok()?;
    let (len_s, key) = rest.split_once(':')?;
    let len: usize = len_s.parse().ok()?;
    if key.len() != len {
        return None;
    }
    Some((total, key.to_string()))
}

fn make_cursor(total: i64, session_key: &str) -> String {
    format!("{total}:{}:{session_key}", session_key.len())
}

/// `parse_cursor` 的 `pub` 包装——CLI 二进制侧把 `sessions_search` 返回的
/// `next_cursor` 直接透传给同工具的下一调用时复用同一段解析逻辑。内部工具仍走
/// private 版以保留 module 边界。返回 `Result` 而非 `Option`，调用方拿到的
/// 错误形态与 MCP envelope 一致（spec §11 `invalid_argument`）。
pub fn parse_search_cursor(c: &str) -> Result<(i64, String), ToolError> {
    parse_cursor(c).ok_or_else(|| ToolError::new("invalid_argument", "malformed `cursor`"))
}

/// `make_cursor` 的 `pub` 包装——CLI 侧若需要从已知的 `(total, session_key)`
/// 复刻一个 cursor（例如不重新跑整次 `sessions_search`、只续页）时复用。
/// 一般 CLI 用不到（cursor 都是 MCP envelope 直接给），保留给将来需要时。
pub fn make_search_cursor(total: i64, session_key: &str) -> String {
    make_cursor(total, session_key)
}

pub fn run(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let date = args.get("date").and_then(Value::as_str);
    let month = args.get("month").and_then(Value::as_str);
    let date_from = args.get("date_from").and_then(Value::as_str);
    let date_to = args.get("date_to").and_then(Value::as_str);
    let (start_ms, end_ms, window_label, has_date) = match (date, month, date_from, date_to) {
        (Some(d), None, None, None) => {
            let (s, e) = beijing_day_bounds_ms(d)
                .ok_or_else(|| ToolError::new("invalid_argument", format!("invalid `date`: {d}")))?;
            (s, e, d.to_string(), true)
        }
        (None, Some(m), None, None) => {
            let (s, e) = beijing_month_bounds_ms(m)
                .ok_or_else(|| ToolError::new("invalid_argument", format!("invalid `month`: {m}")))?;
            (s, e, m.to_string(), false)
        }
        (None, None, Some(from), Some(to)) => {
            let (s, _) = beijing_day_bounds_ms(from)
                .ok_or_else(|| ToolError::new("invalid_argument", format!("invalid `date_from`: {from}")))?;
            let (_, e) = beijing_day_bounds_ms(to)
                .ok_or_else(|| ToolError::new("invalid_argument", format!("invalid `date_to`: {to}")))?;
            if s > e {
                return Err(ToolError::new("invalid_argument", "`date_from` must not be after `date_to`"));
            }
            // `e` is the beginning of the inclusive end date's following day.
            // Use that boundary directly: adding 24h is wrong on DST transition
            // days (and silently drops or includes an hour).
            (s, e, format!("{from}..{to}"), false)
        }
        _ => {
            return Err(ToolError::new(
                "invalid_argument",
                "use exactly one of `date`, `month`, or the paired `date_from` / `date_to`",
            ))
        }
    };

    let hour = match args.get("hour") {
        None => None,
        Some(v) => {
            let h = v
                .as_u64()
                .filter(|h| *h <= 23)
                .ok_or_else(|| ToolError::new("invalid_argument", "`hour` must be 0..=23"))?;
            if !has_date {
                return Err(ToolError::new("invalid_argument", "`hour` requires `date` (not `month`)"));
            }
            Some(h as u32)
        }
    };

    let harnesses: Vec<String> = args
        .get("harnesses")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let model = args.get("model").and_then(Value::as_str);
    let provider = args.get("provider").and_then(Value::as_str);
    let min_tokens = args.get("min_tokens").and_then(Value::as_i64).unwrap_or(0);
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
    // 排序：`tokens`（默认，窗口 token 降序）或 `oldest`（first_event 升序）。
    // 游标是 (i64, String) 对，语义随排序变——续页必须用同一种排序。
    let oldest_first = match args.get("order").and_then(Value::as_str) {
        None | Some("tokens") => false,
        Some("oldest") => true,
        Some(other) => {
            return Err(ToolError::new(
                "invalid_argument",
                format!("`order` must be \"tokens\" or \"oldest\", got {other:?}"),
            ))
        }
    };

    let handle = AuthorityHandle::open(data_home)?;
    let conn = handle.conn();
    let mut warnings = Vec::new();
    super::check_as_of_run_id(conn, args, &mut warnings)?;

    let salt = super::session_ref::load_or_create_salt(data_home)?;

    let (after_total, after_key) = match &cursor {
        Some((t, k)) => (Some(*t), Some(k.as_str())),
        None => (None, None),
    };
    let (rows, has_more, window_total, window_session_count) = authority_query::sessions_in_window_ordered(
        conn, start_ms, end_ms, &harnesses, model, provider, hour, min_tokens, after_total, after_key, limit, oldest_first,
    )
    .map_err(|e| ToolError::new("internal_error", format!("authority query: {e}")))?;

    if has_more {
        warnings.push(json!({
            "code": "truncated",
            "message": "more sessions match than fit in one page — data.sessions does NOT sum to window_total_tokens; page with next_cursor",
        }));
    }

    let max_ts = rows.iter().map(|s| s.last_event_ms).max();
    let next_cursor = rows
        .last()
        .filter(|_| has_more)
        .map(|s| make_cursor(if oldest_first { s.first_event_ms } else { s.total() }, &s.session_key));

    let sessions: Vec<Value> = rows
        .iter()
        .map(|s| {
            // 会话成本统一投影：保留 cost_minor 兼容字段，同时把 null 的原因
            // 和金额的价格版本/来源/证据状态放在同级 cost_status 里。
            // 单会话 ~100 行 → 微秒级；50 个会话/页 ≈ 5ms 内（真机量级）。
            let cost_view = authority_query::session_cost_view(conn, &s.session_key)
                .ok()
                .unwrap_or_else(|| json!({
                    "cost_minor": null,
                    "status": "unavailable",
                    "reason": "cost-query-failed",
                    "has_unresolved": true,
                    "pricing_versions": [],
                }));
            json!({
                "session_ref": super::session_ref::session_ref(&salt, &s.session_key),
                "harness": s.harness,
                "first_event_at": ms_to_rfc3339_beijing(s.first_event_ms),
                "last_event_at": ms_to_rfc3339_beijing(s.last_event_ms),
                "event_count": s.event_count,
                "model_ids": s.model_ids,
                "identity_kind": "harness_raw",
                "tokens": {
                    "uncached_input_tokens": s.uncached_input_tokens,
                    "cache_read_tokens": s.cache_read_tokens,
                    "cache_write_tokens": s.cache_write_tokens,
                    "output_tokens": s.output_tokens,
                    "total": s.total(),
                },
                "peak_tokens": s.peak_tokens,
                "cost_minor": cost_view["cost_minor"],
                "cost_status": {
                    "state": cost_view["status"],
                    "reason": cost_view["reason"],
                    "has_unresolved": cost_view["has_unresolved"],
                    "pricing_versions": cost_view["pricing_versions"],
                },
            })
        })
        .collect();

    let data = json!({
        "window": {
            "label": window_label,
            "hour": hour,
            "from": ms_to_rfc3339_beijing(start_ms),
            "to": ms_to_rfc3339_beijing(end_ms),
        },
        "sessions": sessions,
        "window_total_tokens": window_total,
        "window_session_count": window_session_count,
        "has_more": has_more,
        "next_cursor": next_cursor,
    });

    let coverage = json!({
        "status": "complete",
        "requested_from": ms_to_rfc3339_beijing(start_ms),
        "requested_to": ms_to_rfc3339_beijing(end_ms),
        "missing_harnesses": [],
    });

    Ok(build_envelope(
        conn,
        authority_state_for(data_home),
        max_ts.or(Some(end_ms)),
        coverage,
        warnings,
        data,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;

    fn tmp_home(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "avmcp-ss-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    fn seed(home: &std::path::Path) -> AuthorityDb {
        std::fs::create_dir_all(home).unwrap();
        AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(home), 1).unwrap()
    }

    fn fact(db: &AuthorityDb, id: &str, harness: &str, skey: &str, ts: i64, tokens: i64) {
        db.conn()
            .execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('run', 1, 'cli', 'succeeded', 2) ON CONFLICT(run_id) DO NOTHING",
                [],
            )
            .unwrap();
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, source_profile, last_observed_at_ms)
             VALUES (?1, ?2, ?3, 'm', 'default', 1) ON CONFLICT(session_key) DO NOTHING",
            rusqlite::params![skey, harness, format!("nat-{skey}")],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, session_key,
                 source_event_id, observation_kind, model_id, event_ts_ms, event_peak,
                 uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 'm', ?3, ?4, ?1, 'assistant-usage', 'm-x', ?5, 0, ?6, 0, 0, 0, 'run', 1, 1)",
            rusqlite::params![id, harness, format!("nat-{skey}"), skey, ts, tokens],
        ).unwrap();
    }

    #[test]
    fn peak_hour_sessions_sum_to_window_total_and_ref_hides_native() {
        let home = tmp_home("peak");
        let db = seed(&home);
        let (start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        let h22 = start + 22 * 3_600_000;
        fact(&db, "f1", "claude-code", "3:cc|10:secret1234|2:ns", h22, 300);
        fact(&db, "f2", "claude-code", "3:cc|10:secret5678|2:ns", h22 + 1000, 500);
        fact(&db, "f3", "claude-code", "3:cc|10:secret1234|2:ns", start + 60_000, 99); // 别的小时
        drop(db);

        let env = run(&json!({ "date": "2026-09-07", "hour": 22 }), &home).unwrap();
        let d = &env["data"];
        assert_eq!(d["window_total_tokens"], 800);
        let sum: i64 = d["sessions"].as_array().unwrap().iter().map(|s| s["tokens"]["total"].as_i64().unwrap()).sum();
        assert_eq!(sum, 800, "Q04 不变式");
        let txt = env.to_string();
        assert!(!txt.contains("secret1234") && !txt.contains("nat-"), "原生 id 不得泄漏: {txt}");
        assert!(d["sessions"][0]["session_ref"].as_str().unwrap().starts_with("sr_"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn pagination_flags_truncation_with_warning() {
        let home = tmp_home("page");
        let db = seed(&home);
        let (start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        for i in 0..5 {
            fact(&db, &format!("f{i}"), "dsh", &format!("3:dsh|1:{i}|1:n"), start + i * 1000, 100 - i);
        }
        drop(db);
        let env = run(&json!({ "date": "2026-09-07", "limit": 2 }), &home).unwrap();
        assert_eq!(env["data"]["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(env["data"]["has_more"], true);
        assert!(env["warnings"].as_array().unwrap().iter().any(|w| w["code"] == "truncated"));
        let cur = env["data"]["next_cursor"].as_str().unwrap().to_string();
        let env2 = run(&json!({ "date": "2026-09-07", "limit": 2, "cursor": cur }), &home).unwrap();
        let p2: Vec<&str> = env2["data"]["sessions"].as_array().unwrap().iter()
            .map(|s| s["session_ref"].as_str().unwrap()).collect();
        assert_eq!(p2.len(), 2);
        // 无重复：第一页和第二页的 session_ref 不相交。
        let p1: Vec<&str> = env["data"]["sessions"].as_array().unwrap().iter()
            .map(|s| s["session_ref"].as_str().unwrap()).collect();
        assert!(p1.iter().all(|r| !p2.contains(r)));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn needs_exactly_one_of_date_month() {
        let home = tmp_home("args");
        seed(&home);
        assert_eq!(run(&json!({}), &home).unwrap_err().code, "invalid_argument");
        assert_eq!(
            run(&json!({ "date": "2026-09-07", "month": "2026-09" }), &home).unwrap_err().code,
            "invalid_argument"
        );
        assert_eq!(
            run(&json!({ "month": "2026-09", "hour": 5 }), &home).unwrap_err().code,
            "invalid_argument"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // PR #2.2：sessions_search envelope 加 `cost_minor`——无定价快照时
    // 字段为 null（spec §0.1 不冒充零成本）；有快照时是按价表估算的
    // {amount_minor, currency, basis}。
    #[test]
    fn envelope_exposes_cost_minor_field_per_session() {
        let home = tmp_home("cost");
        let db = seed(&home);
        let (start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        fact(&db, "fc1", "dsh", "3:dsh|10:abc-1234567|2:n", start + 3_600_000, 500);
        // 价卡覆盖到 event_ts；fallback_provider 的 deepseek-v4-pro 模型。
        let payload = r#"{"fallback_provider":"deepseek-official","providers":{"deepseek-official":{"models":{"m-x":{"input_uncached":{"off_peak":4.5,"peak":9.0}}}}}}"#;
        db.pricing_snapshot_put(
            "v1", "cli_seed", payload, start - 86_400_000,
        ).unwrap();
        drop(db);

        let env = run(&json!({ "date": "2026-09-07" }), &home).unwrap();
        let s0 = &env["data"]["sessions"][0];
        assert!(s0["cost_minor"].is_object(), "有价卡覆盖 → 字段为对象");
        assert_eq!(s0["cost_minor"]["currency"], "CNY");
        assert_eq!(s0["cost_minor"]["basis"], "metered_estimate");
        assert!(s0["cost_minor"]["amount_minor"].is_i64());
        assert_eq!(s0["cost_minor"]["pricing_versions"], json!(["v1"]));
        assert_eq!(s0["cost_minor"]["pricing_source"], "fallback_official");
        assert_eq!(s0["cost_status"]["state"], "estimated");

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn cost_minor_is_null_when_no_pricing_snapshot_covers_window() {
        let home = tmp_home("cost-null");
        let db = seed(&home);
        let (start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        fact(&db, "fn1", "dsh", "3:dsh|10:abc-7890123|2:n", start + 3_600_000, 500);
        // 故意不插 pricing_snapshot。
        drop(db);

        let env = run(&json!({ "date": "2026-09-07" }), &home).unwrap();
        assert!(env["data"]["sessions"][0]["cost_minor"].is_null(),
            "无价卡覆盖 → null（spec §0.1 不冒充零）");
        assert_eq!(env["data"]["sessions"][0]["cost_status"]["state"], "unavailable");
        assert_eq!(env["data"]["sessions"][0]["cost_status"]["reason"], "no-pricing-snapshot");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn cost_status_explains_subscription_null() {
        let home = tmp_home("cost-status");
        let db = seed(&home);
        let (start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        fact(&db, "sub", "codex", "3:codex|3:sub|1:n", start + 3_600_000, 500);
        db.conn().execute(
            "UPDATE usage_facts SET provider_id='openai', billing_mode='subscription',
                    pricing_basis='subscription', evidence_basis='explicit-official-route'
             WHERE fact_id='sub'",
            [],
        ).unwrap();
        drop(db);

        let env = run(&json!({ "date": "2026-09-07" }), &home).unwrap();
        let session = &env["data"]["sessions"][0];
        assert!(session["cost_minor"].is_null());
        assert_eq!(session["cost_status"]["state"], "subscription");
        assert_eq!(session["cost_status"]["reason"], "subscription-token-usage-is-not-a-per-token-bill");
        assert_eq!(session["cost_status"]["has_unresolved"], false);
        let _ = std::fs::remove_dir_all(&home);
    }

    // PR #1 (mcp 0.9.1 SQL authority 收口)：CLI 二进制侧会直接调
    // `parse_search_cursor` / `make_search_cursor` 来透传 cursor；这里钉住
    // round-trip + 错误形态，避免重写时漂移。
    #[test]
    fn parse_search_cursor_roundtrip_and_errors() {
        // 含冒号的 session_key（典型 `5:codex|2:s1|5:/repo|6:ns-abc`）——长度前缀
        // 是为了不让内嵌冒号误分隔；round-trip 必须稳定。
        let key = "5:codex|2:s1|5:/repo|6:ns-abc";
        let total = 1234_i64;
        let cursor = make_search_cursor(total, key);
        let (got_total, got_key) = parse_search_cursor(&cursor).expect("roundtrip ok");
        assert_eq!(got_total, total);
        assert_eq!(got_key, key);

        // 长度前缀与实际 key 长度不一致 → `invalid_argument`。
        let bad_len = format!("{total}:{}:{key}", key.len() + 1);
        let err = parse_search_cursor(&bad_len).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert_eq!(err.message, "malformed `cursor`");

        // 缺段、非数字、纯空——三种形态都应是同一 invalid_argument 错误。
        for bad in ["", "100", "100:5", "abc:5:xyz", "100:abc:xyz"] {
            let err = parse_search_cursor(bad).unwrap_err();
            assert_eq!(err.code, "invalid_argument", "input={bad:?}");
        }
    }
}
