//! R1d-tick 的 oneline 生产者：把一份 DSH 会话日志折成「一行摘要」
//! （`oneline.json` 快照 + `sessions.jsonl` 导航历史），最后在 ledger 记 key、
//! manifest 代际 +1。
//!
//! v0.9.1 Phase 4.3 Stage 5b 起，日/月账与预算告警只从 SQL 权威库读取；tick
//! **绝不再写** `today.json` / `month.json` / `month-archive.json` / `alert.json`。
//! Python 的旧 `scan.py oneline` 仍可为旧分发运行，但不再是本应用的数据写入契约。
//!
//! Python 与 Rust 的差分由 `tests/test_oneline_lockstep.py` 钉住：同一份真实
//! 格式会话日志，两个实现各自折进**独立** HOME，state 文件逐字节相等（四个
//! 时间戳字段掩码），stdout 逐字节相等（state 路径按 HOME 掩码）。
//!
//! 折叠计算全部委托 core（`usage::hour_buckets` / `usage::token_by_date_model`
//! / `cost::cost_report` / `budget::evaluate_alert` / `state::merge_*`），本模块
//! 只做 I/O 接线与顺序 —— 这里不长任何第二份规则。

use std::path::Path;

use serde_json::{json, Map, Value};

use agent_vitals_domain::takeover as tk;
use agent_vitals_domain::usage;
use agent_vitals_runtime::sessions::behavior::audit_session_log;
use agent_vitals_runtime::state;
use agent_vitals_runtime::takeover as tk_io;

/// oneline 一次运行的结果。
#[derive(Debug, PartialEq, Eq)]
pub enum OnelineOutcome {
    /// 首次见这条会话，状态文件已折、ledger 已记。
    Folded,
    /// 这条会话已经折过 —— 整段跳过（exactly-once，§4.3），不写任何文件。
    DedupSkipped,
}

/// `agent-vitals oneline <session_log> [--no-merge] [--shadow]` 主入口。
///
/// 流程与 Python 逐段对齐（`cli.py` oneline handler）：
///   1. fencing —— owner 不是 rust 就快速失败（Python 同款「挡在最前面，
///      省得审计半天才拒」）；
///   2. `audit_session_log` 拿 findings + usage（token_by_model）；
///   3. `cost_report` 定价；
///   4. 读 events 算小时分布（只供导航摘要，不是业务账）；
///   5. tokens_total / tokens_peak（4 桶全量，与 hour_buckets 同源）；
///   6. session_id = 文件 stem，去重门（folded_in_ledger）—— 已折 → dedup；
///   7. 组 summary（**键序 = Python dict 字面量序**，sessions.jsonl 靠它）；
///   8. 组装只含导航快照的 fold-req，调 `fold_session`（fenced + exactly-once）落盘；
///   9. 人读报告。
///
/// calendar.html 刷新**不在** R1d 范围：那是展示层产物，Python 用
/// `_render_calendar_html` 刷、Rust 侧不产 —— 行为差量如实上报，不假装等价。
pub fn oneline(
    path: &Path,
    session_id_override: Option<&str>,
    _no_merge: bool,
    shadow: bool,
) -> Result<OnelineOutcome, String> {
    // 1. fencing
    tk_io::require_rust_owner(shadow)?;

    // 2. audit
    let Some(audit) = audit_session_log(path) else {
        return Err(
            "session log unavailable: unreadable, malformed, or schema mismatch".to_string(),
        );
    };

    // 3. cost
    let pricing = crate::agent::cost::load_pricing();
    let cost = crate::agent::cost::cost_report(&audit.usage, &pricing).unwrap_or_else(|| {
        agent_vitals_runtime::logging::log_warn(
            "oneline",
            "cost_report returned None (no usage samples to price)",
        );
        json!({"total": 0, "peak_total": 0, "unpriced_tokens": 0, "currency": "CNY"})
    });

    // 4. events 只用于导航摘要的小时分布；业务账由 sync 写入 SQL 权威库。
    let session = agent_vitals_harnesses::dsh_sources::read_session_log(path);
    let events: Vec<Value> = session
        .get("usage_events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let hb = usage::hour_buckets(&events);

    // 5. tokens —— 与 hour_buckets 的 4 桶之和逐字节相等（Python 侧有
    //    TestUsageHourBucketsReconcile 钉死），这里取 4 桶全量、同源。
    let mut tokens_total: i64 = 0;
    let mut tokens_peak: i64 = 0;
    let mut model = "unknown".to_string();
    if let Some(bm) = audit.usage.get("by_model").and_then(Value::as_object) {
        if let Some(first) = bm.keys().next() {
            model = first.clone();
        }
        for m in bm.values() {
            tokens_total += bucket_total(m, false);
            tokens_peak += bucket_total(m, true);
        }
    }

    // 6. session_id / 去重门 —— 「没数据」与「数据为 0」是两回事；已折 → 整段
    //    跳过（today/month/history 不重复累加）。日志增长也跳过 —— 宁可少计也
    //    不翻倍，增量重 fold 是 R3 watcher 的差事。
    //
    //    默认 session_id = 文件 stem（Python mirror 逐字节同源）；tick 发现器
    //    传 `--session-id <agentId>` 覆盖 —— DSH 落盘名恒为 `session.jsonl`，
    //    stem 恒 "session"，会把所有会话撞进同一个 dedup key（§4.3 的碰撞
    //    教训：native id 必须来自 source identity，不是文件名）。
    let session_id = session_id_override.map(str::to_owned).unwrap_or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string()
    });
    let ns = tk_io::machine_namespace();
    let key = tk::session_key("dsh", &session_id, &ns);
    if tk_io::folded_in_ledger(&key) {
        println!("dedup: session {session_id} already folded; skipping (exactly-once, §4.3)");
        return Ok(OnelineOutcome::DedupSkipped);
    }

    // 7. duration_ms / max_sev
    let duration_ms = duration_from_events(&events);
    let max_sev = max_severity(&audit.findings);

    // 8. summary —— 键序与 Python dict 字面量完全一致。
    let summary = json!({
        "session_id": session_id,
        "session_log": path.display().to_string(),
        "duration_ms": duration_ms,
        "model": model,
        "tokens_total": tokens_total,
        "tokens_peak": tokens_peak,
        "cost_cny": cost["total"],
        "cost_peak_cny": cost["peak_total"],
        "unpriced_tokens": cost["unpriced_tokens"],
        "findings_total": audit.findings.len(),
        "findings_max_severity": max_sev,
        "hour_buckets_summary": hour_buckets_summary(&hb),
    });

    // 9. fold-req → fold_session。它只允许导航字段；旧账本字段即使有外部调用者
    //    传入也由 fold_session 忽略，确保 SQL 是唯一业务数据源。
    let mut req = Map::new();
    req.insert("session_id".into(), json!(session_id));
    req.insert("session_log".into(), json!(path.display().to_string()));
    req.insert("harness_kind".into(), json!("dsh"));
    req.insert("machine_namespace".into(), json!(ns));
    req.insert("oneline".into(), summary);
    let req = Value::Object(req);

    let outcome = tk_io::fold_session(&req, shadow)?;
    let folded = match outcome {
        tk_io::FoldOutcome::Folded => true,
        tk_io::FoldOutcome::SkippedAlreadyFolded => {
            // 理论上到不了这（上面的去重门已经拦了）；race 时按 dedup 处理。
            return Ok(OnelineOutcome::DedupSkipped);
        }
    };
    debug_assert!(folded);

    // 12. 人读报告 —— 让没装 xbar 的用户在终端也能看一眼「这一会话花了多少」。
    print_report(&req, &state::state_dir().join("oneline.json"));
    Ok(OnelineOutcome::Folded)
}

/// 4 桶求和 —— 与 Python 的 sum 逐项一致。
fn bucket_total(m: &Value, peak: bool) -> i64 {
    let keys: [&str; 4] = if peak {
        [
            "peak_uncached_input_tokens",
            "peak_output_tokens",
            "peak_cache_read_tokens",
            "peak_cache_write_tokens",
        ]
    } else {
        [
            "uncached_input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
        ]
    };
    keys.iter()
        .map(|k| m.get(*k).and_then(Value::as_i64).unwrap_or(0))
        .sum()
}

/// `type == "session/end"` 且 `time` 是 int 的会话时长 —— 日志 schema 没有
/// 显式字段时兜底 None（DSH adapter 只产 `type: "session"`，所以实测恒 None）。
fn duration_from_events(events: &[Value]) -> Option<i64> {
    let mut duration_ms = None;
    for ev in events {
        if ev.get("type").and_then(Value::as_str) == Some("session/end") {
            if let Some(end) = ev.get("time").and_then(Value::as_i64) {
                duration_ms = Some(end);
                break;
            }
        }
    }
    duration_ms
}

/// findings 的最高 severity；severity 不在 known 表里按 0 算（Python 同款
/// `sev_rank.get(x, 0)`）。空 findings → "none"。
fn max_severity(findings: &[Value]) -> String {
    let rank = |s: &str| match s {
        "critical" => 4,
        "warning" => 3,
        "info" => 2,
        _ => 0,
    };
    let mut max_sev = "none".to_string();
    for f in findings {
        let sev = f.get("severity").and_then(Value::as_str).unwrap_or("");
        if rank(sev) > rank(&max_sev) {
            max_sev = sev.to_string();
        }
    }
    max_sev
}

fn hour_buckets_summary(hb: &Value) -> Value {
    let buckets = hb
        .get("buckets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    json!({
        "bucket_count": buckets.len(),
        "min_date": buckets.first().and_then(|b| b.get("date")).cloned(),
        "max_date": buckets.last().and_then(|b| b.get("date")).cloned(),
        "tz_name": hb.get("tz_name").cloned(),
    })
}

/// Python oneline 的人读报告 —— 逐字节同格式（`%s`/`%d`/`%.4f`、间距、条件行）。
fn print_report(req: &Value, state_path: &Path) {
    let s = |k: &str| {
        req.get("oneline")
            .and_then(|o| o.get(k))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let summary = req.get("oneline").cloned().unwrap_or_else(|| json!({}));

    println!("session:    {}", s("session_id"));
    // `%s` with `or "?"` —— 0 在 Python 里是 falsy，所以 0 也显示 "?"。
    let dur = summary.get("duration_ms").and_then(Value::as_i64);
    let dur_s = dur
        .filter(|v| *v != 0)
        .map(|v| v.to_string())
        .unwrap_or_else(|| "?".to_string());
    println!("duration:   {dur_s} ms");
    println!("model:      {}", s("model"));
    println!(
        "tokens:     {} (peak {})",
        summary["tokens_total"], summary["tokens_peak"]
    );
    println!(
        "cost:       ¥{:.4} (peak ¥{:.4})",
        summary["cost_cny"].as_f64().unwrap_or(0.0),
        summary["cost_peak_cny"].as_f64().unwrap_or(0.0)
    );
    let unpriced = summary["unpriced_tokens"].as_i64().unwrap_or(0);
    if unpriced != 0 {
        println!("unpriced:   {unpriced} tokens (model not in pricing.json)");
    }
    println!(
        "findings:   {} (max severity: {})",
        summary["findings_total"].as_i64().unwrap_or(0),
        s("findings_max_severity")
    );
    if req
        .get("alert")
        .and_then(|a| a.get("level"))
        .and_then(Value::as_str)
        != Some("disabled")
    {
        println!(
            "budget:     {}",
            req.get("alert")
                .and_then(|a| a.get("level"))
                .and_then(Value::as_str)
                .unwrap_or("")
        );
    }
    println!("state:      {}", state_path.display());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_total_sums_plain_and_peak() {
        let m = json!({
            "uncached_input_tokens": 1,
            "output_tokens": 2,
            "cache_read_tokens": 3,
            "cache_write_tokens": 4,
            "peak_uncached_input_tokens": 10,
            "peak_output_tokens": 20,
            "peak_cache_read_tokens": 30,
            "peak_cache_write_tokens": 40,
        });
        assert_eq!(bucket_total(&m, false), 10);
        assert_eq!(bucket_total(&m, true), 100);
    }

    #[test]
    fn duration_from_events_requires_int_time() {
        let events = json!([
            {"type": "session/end", "time": 123},
            {"type": "session", "time": 999},
        ]);
        assert_eq!(duration_from_events(events.as_array().unwrap()), Some(123));
        let no_int = json!([{"type": "session/end", "time": "123"}]);
        assert_eq!(duration_from_events(no_int.as_array().unwrap()), None);
        let none_type = json!([{"type": "session"}]);
        assert_eq!(duration_from_events(none_type.as_array().unwrap()), None);
    }

    #[test]
    fn max_severity_ranks_known_only() {
        let findings = json!([
            {"severity": "info"},
            {"severity": "critical"},
        ]);
        assert_eq!(max_severity(findings.as_array().unwrap()), "critical");
        let unknown = json!([{"severity": "high"}]);
        assert_eq!(max_severity(unknown.as_array().unwrap()), "none");
        assert_eq!(max_severity(&[]), "none");
    }

    #[test]
    fn hour_buckets_summary_mirrors_python() {
        let hb = json!({
            "buckets": [
                {"date": "2026-08-30", "hour": 9, "uncached_input_tokens": 1},
                {"date": "2026-08-30", "hour": 10, "uncached_input_tokens": 2},
            ],
            "tz_name": "Asia/Shanghai (UTC+8 fixed, no DST)",
        });
        let s = hour_buckets_summary(&hb);
        assert_eq!(s["bucket_count"], 2);
        assert_eq!(s["min_date"], "2026-08-30");
        assert_eq!(s["max_date"], "2026-08-30");
        assert_eq!(s["tz_name"], "Asia/Shanghai (UTC+8 fixed, no DST)");
        let empty = json!({"buckets": [], "tz_name": "t"});
        let s = hour_buckets_summary(&empty);
        assert_eq!(s["bucket_count"], 0);
        assert_eq!(s["min_date"], Value::Null);
        assert_eq!(s["max_date"], Value::Null);
    }
}
