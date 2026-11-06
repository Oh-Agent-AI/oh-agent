//! 「发现」tab ②模型 × Harness 对比的决策面数据（WORKBENCH_FINDINGS_TAB_SPEC §3.2/§4/§5.2）。
//!
//! 一行 = `(harness, model_id, provider_id)` 组合；列 = 会话数、四桶 token、缓存命中、
//! 名义成本（按币种/口径分列，永不相加）、贡献 Top 会话（不透明 session_ref）、
//! 行为标记（**执行环境级**，spec §4.7——多模型会话使 per-model 归组成为编造）。
//!
//! 诚实性边界（§1.4/§4）：
//! - 输入侧全零 → `cache_hit_ratio: null`，不是 0；
//! - `waste_rate` 恒 `null`——waste 检测器仅 DSH 且尚未接入（notes 带说明）；
//! - 计价复用 `cost_breakdown`（单一价格事实源），按 `(harness, model)` 合并，
//!   cost 行 provider 为空（归因未定）时挂 `cost_provider_unresolved: true`，
//!   不冒充已归因；
//! - 订阅内组合 `has_subscription: true` 且 amounts 可为空（§4.6 订阅行不参与排序）。
//!
//! 全程只读 authority SQL（§1.6 性能预算：毫秒级，无会话日志扫描）。

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};

// 组合键：harness × model × provider（provider 缺失归 `<unknown>`，与
/// SQL_UNRESOLVED 的事实层语义一致，不编一个名字）。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Combo {
    harness: String,
    model: String,
    provider: String,
}

const TOP_SESSIONS_PER_COMBO: usize = 3;

// 决策面全量数据。`month` 形如 `2026-09`。
pub fn decision_matrix(data_home: &Path, month: &str) -> Result<Value, String> {
    let mut salt_note: Option<String> = None;
    let (start_ms, end_ms) = agent_vitals_data::authority_query::beijing_month_bounds_ms(month)
        .ok_or_else(|| format!("invalid month: {month}"))?;
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
        .map_err(|e| format!("authority_unavailable: {e}"))?;

    let mut rows = combo_rows(db.conn(), start_ms, end_ms)?;
    let marks = harness_behavior_marks(db.conn(), start_ms, end_ms);
    // salt 读取失败不拖垮整个矩阵：Top 会话置空 + note 说明（验收条件 4——
    // 只读命令对 data_home 只读的环境也要能出表）。
    if let Err(e) = attach_top_sessions(db.conn(), start_ms, end_ms, data_home, &mut rows) {
        rows.values_mut().for_each(|r| r["top_sessions"] = json!([]));
        salt_note = Some(format!("贡献会话列表不可用（session_ref salt：{e}）"));
    }
    // 撞限流频次列（§4.5）：SV607/608 执行环境级命中 ÷ 执行环境去重会话数 = 每会话均值。
    let harness_sessions = harness_session_counts(db.conn(), start_ms, end_ms);
    let failures = session_failure_counts(db.conn(), start_ms, end_ms);

    // 计价：复用 cost_breakdown（同一价格事实源），按 (harness, model) 合并。
    let (from_day, to_day) = month_day_span(month)?;
    let mut cost_note: Option<String> = None;
    let cost_args = json!({"from": from_day, "to": to_day});
    let mut cost_by_harness_model: BTreeMap<(String, String), Vec<Value>> = BTreeMap::new();
    // amount 为 null 的 cost 行多半是申报订阅覆盖（cost_breakdown 的归因口径）——
    // 记下 (harness, model)，让这些组合按「订阅覆盖」而非「未计价」呈现（验收条件 2：
    // has_subscription 的原始 billing_mode 与申报归因的口径缝隙）。
    let mut subscription_covered: std::collections::BTreeSet<(String, String)> = std::collections::BTreeSet::new();
    let cost_result = crate::query::cost_breakdown::run(&cost_args, data_home);
    if let Err(e) = &cost_result {
        cost_note = Some(format!("计价管线不可用（{e}）：金额列按未计价显示，与真无价不可区分，请重试"));
    }
    if let Ok(cost) = cost_result {
        if let Some(breakdown) = cost["data"]["breakdown"].as_array() {
            for row in breakdown {
                let key = &row["key"];
                let harness_m = key["harness"].as_str().unwrap_or("<unknown>").to_string();
                let model_m = key["model"].as_str().unwrap_or("<unknown>").to_string();
                let amount = row.get("amount").cloned().unwrap_or(Value::Null);
                if amount.is_null() {
                    subscription_covered.insert((harness_m, model_m));
                    continue;
                }
                let harness = key["harness"].as_str().unwrap_or("<unknown>").to_string();
                let model = key["model"].as_str().unwrap_or("<unknown>").to_string();
                cost_by_harness_model
                    .entry((harness, model))
                    .or_default()
                    .push(json!({
                        "amount_minor": amount["amount_minor"],
                        "currency": amount["currency"],
                        "basis": amount["basis"],
                        "cost_provider": key["provider"],
                        "cost_provider_raw": key["provider_raw"],
                    }));
            }
        }
    }
    for row in rows.values_mut() {
        let harness = row["harness"].as_str().unwrap_or("<unknown>").to_string();
        let model = row["model_id"].as_str().unwrap_or("<unknown>").to_string();
        let amounts = cost_by_harness_model.remove(&(harness.clone(), model.clone()));
        let unresolved = amounts.as_ref().map(|list| list.iter().any(|a| {
            a["cost_provider"].is_null() && a["cost_provider_raw"].as_str() != Some("official")
        }));
        row["amounts"] = json!(amounts.unwrap_or_default());
        row["cost_provider_unresolved"] = json!(unresolved.unwrap_or(false));
        if subscription_covered.contains(&(harness.clone(), model.clone())) {
            row["has_subscription"] = json!(true);
        }
        // 撞限流列（§4.5）：命中数 + 每会话均值（执行环境级；会话数为 0 → 只给命中数）。
        let hits = marks.get(&harness)
            .and_then(|m| m["SV607"].as_i64().unwrap_or(0).checked_add(m["SV608"].as_i64().unwrap_or(0)))
            .unwrap_or(0);
        let sessions = harness_sessions.get(&harness).copied().unwrap_or(0);
        row["limit_pressure"] = if hits > 0 {
            let per_session = if sessions > 0 {
                Some((hits as f64 / sessions as f64 * 100.0).round() / 100.0)
            } else {
                None
            };
            json!({"hits": hits, "per_session": per_session})
        } else {
            Value::Null
        };
        let harness = row["harness"].as_str().unwrap_or_default();
        row["harness_behavior"] = marks.get(harness).cloned().unwrap_or(json!({}));
        for sess in row["top_sessions"].as_array_mut().unwrap_or(&mut Vec::new()) {
            // session_key 只在进程内做 failures 对齐，随后剥离——原生会话 id
            // 不出 IPC（§3.3 隐私边界；前端只拿 sr_ 不透明引用）。
            let key = sess.get("session_key").and_then(|k| k.as_str()).map(str::to_string);
            if let Some(key) = key {
                sess["failures"] = json!(failures.get(&key).copied().unwrap_or(0));
            }
            if let Some(obj) = sess.as_object_mut() {
                obj.remove("session_key");
            }
        }
    }

    let mut notes = vec![
        "waste_rate 恒 null：waste 检测器仅 DSH 且尚未接入（spec §4.2，不用 0 冒充）".to_string(),
        "harness_behavior 为执行环境级聚合（spec §4.7）：多模型会话使 per-model 归组成为编造".to_string(),
        "amounts 按币种/口径分列，永不跨币种相加（spec §1.5）".to_string(),
        "指纹跨链（invocation_fingerprint × issues 重复组）推后至 P3：需要指纹→组合的执行环境级对齐".to_string(),
    ];
    if let Some(note) = salt_note { notes.push(note); }
    if let Some(note) = cost_note { notes.push(note); }
    let rows_vec: Vec<&Value> = rows.values().collect();
    let summary = dig_findings(&rows_vec.iter().map(|v| (*v).clone()).collect::<Vec<_>>());
    Ok(json!({
        "month": month,
        "rows": rows_vec,
        "findings_summary": summary,
        "notes": notes,
    }))
}

// (harness, model, provider) 分组聚合 + 每组合的 Top 会话挂载。
fn combo_rows(
    conn: &rusqlite::Connection,
    start_ms: i64,
    end_ms: i64,
) -> Result<BTreeMap<Combo, Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.harness, COALESCE(f.model_id, '<unknown>'), COALESCE(f.provider_id, '<unknown>'),
                    COUNT(DISTINCT f.session_key),
                    SUM(f.uncached_input_tokens), SUM(f.cache_read_tokens),
                    SUM(f.cache_write_tokens), SUM(f.output_tokens),
                    MAX(CASE WHEN f.billing_mode = 'subscription' THEN 1 ELSE 0 END)
             FROM usage_facts f
             WHERE f.event_ts_ms >= ?1 AND f.event_ts_ms < ?2
               AND f.observation_kind != 'legacy_aggregate'
               AND f.deleted_at_ms IS NULL
             GROUP BY 1, 2, 3",
        )
        .map_err(|e| format!("decision_matrix group: {e}"))?;
    let queried = stmt
        .query_map(rusqlite::params![start_ms, end_ms], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
            ))
        })
        .map_err(|e| format!("decision_matrix query: {e}"))?;
    let mut out: BTreeMap<Combo, Value> = BTreeMap::new();
    for row in queried.flatten() {
        let (harness, model, provider, sessions, uncached, read, write, output, sub) = row;
        let combo = Combo { harness: harness.clone(), model: model.clone(), provider: provider.clone() };
        let input_side = uncached + read + write;
        let ratio = if input_side == 0 {
            Value::Null
        } else {
            json!((read as f64 / input_side as f64 * 10_000.0).round() / 10_000.0)
        };
        out.insert(combo, json!({
            "harness": harness, "model_id": model, "provider_id": provider,
            "sessions": sessions,
            "tokens": {
                "uncached_input": uncached, "cache_read": read,
                "cache_write": write, "output": output,
                "total": uncached + read + write + output,
            },
            "cache_hit_ratio": ratio,
            "has_subscription": sub == 1,
            "waste_rate": Value::Null,
            "amounts": [], "top_sessions": [], "harness_behavior": {},
        }));
    }
    Ok(out)
}

// 每组合贡献 Top-N 会话（按 token 降序）：不透明 session_ref + 跨度 + 贡献量。
/// 跨度是「事件跨度近似」（spec §4.4），如实命名 span_*_ms。
fn attach_top_sessions(
    conn: &rusqlite::Connection,
    start_ms: i64,
    end_ms: i64,
    data_home: &Path,
    rows: &mut BTreeMap<Combo, Value>,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.harness, COALESCE(f.model_id, '<unknown>'), COALESCE(f.provider_id, '<unknown>'),
                    f.session_key, MIN(f.event_ts_ms), MAX(f.event_ts_ms),
                    SUM(f.uncached_input_tokens + f.cache_read_tokens + f.cache_write_tokens + f.output_tokens)
             FROM usage_facts f
             WHERE f.event_ts_ms >= ?1 AND f.event_ts_ms < ?2
               AND f.observation_kind != 'legacy_aggregate'
               AND f.deleted_at_ms IS NULL
               AND f.session_key IS NOT NULL AND f.session_key != ''
             GROUP BY 1, 2, 3, 4",
        )
        .map_err(|e| format!("decision_matrix sessions: {e}"))?;
    let queried = stmt
        .query_map(rusqlite::params![start_ms, end_ms], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })
        .map_err(|e| format!("decision_matrix sessions query: {e}"))?;
    let mut per_combo: BTreeMap<Combo, Vec<(i64, String, i64, i64)>> = BTreeMap::new();
    for row in queried.flatten() {
        let (harness, model, provider, session_key, first, last, tokens) = row;
        per_combo
            .entry(Combo { harness, model, provider })
            .or_default()
            .push((tokens, session_key, first, last));
    }
    let salt = crate::query::session_ref::load_or_create_salt(data_home)
        .map_err(|e| format!("session_ref salt: {e}"))?;
    for (combo, mut sessions) in per_combo {
        sessions.sort_by_key(|(tokens, _, _, _)| std::cmp::Reverse(*tokens));
        let top: Vec<Value> = sessions.iter().take(TOP_SESSIONS_PER_COMBO).map(|(tokens, key, first, last)| {
            json!({
                "session_ref": crate::query::session_ref::session_ref(&salt, key),
                // session_key 只在进程内做 failures 对齐，不进 UI（前端只拿 sr_ 引用）。
                "session_key": key,
                "span_first_ms": first, "span_last_ms": last,
                "tokens_total": tokens,
                "failures": 0,
            })
        }).collect();
        if let Some(row) = rows.get_mut(&combo) {
            row["top_sessions"] = json!(top);
        }
    }
    Ok(())
}

// SV607/608/610 的执行环境级聚合（spec §4.7）：按 (harness, rule) 计数，挂到该执行环境
/// 的每一行作为「执行环境级证据」，不做 per-model 归组。
fn harness_behavior_marks(conn: &rusqlite::Connection, start_ms: i64, end_ms: i64) -> BTreeMap<String, Value> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT harness, issue_type, COUNT(*) FROM issue_instances
         WHERE issue_type IN ('SV607', 'SV608', 'SV610')
           AND opened_at_ms >= ?1 AND opened_at_ms < ?2
         GROUP BY 1, 2",
    ) else {
        return BTreeMap::new();
    };
    let Ok(queried) = stmt.query_map(rusqlite::params![start_ms, end_ms], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
    }) else {
        return BTreeMap::new();
    };
    let mut out: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for row in queried.flatten() {
        let (harness, rule, count) = row;
        out.entry(harness).or_default().insert(rule, count);
    }
    out.into_iter().map(|(harness, rules)| (harness, json!(rules))).collect()
}

// 执行环境级去重会话数（§4.5 撞限流的分母）：一个会话可跨多模型组合，
/// 分母必须按执行环境去重，不能把各组合的会话数相加。
fn harness_session_counts(conn: &rusqlite::Connection, start_ms: i64, end_ms: i64) -> BTreeMap<String, i64> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT f.harness, COUNT(DISTINCT f.session_key) FROM usage_facts f
         WHERE f.event_ts_ms >= ?1 AND f.event_ts_ms < ?2
           AND f.observation_kind != 'legacy_aggregate' AND f.deleted_at_ms IS NULL
           AND f.session_key IS NOT NULL AND f.session_key != ''
         GROUP BY 1",
    ) else {
        return BTreeMap::new();
    };
    let Ok(queried) = stmt.query_map(rusqlite::params![start_ms, end_ms], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    }) else {
        return BTreeMap::new();
    };
    queried.flatten().collect()
}

// 每会话的工具失败数（workflow_events，code-aware 脱敏后的 outcome）——
/// Top 会话行的「失败 X」来自这里，不读原始日志。
fn session_failure_counts(conn: &rusqlite::Connection, start_ms: i64, end_ms: i64) -> BTreeMap<String, i64> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_key, COUNT(*) FROM workflow_events
         WHERE event_type = 'tool_finished' AND outcome = 'failed'
           AND event_ts_ms >= ?1 AND event_ts_ms < ?2 AND session_key IS NOT NULL
         GROUP BY 1",
    ) else {
        return BTreeMap::new();
    };
    let Ok(queried) = stmt.query_map(rusqlite::params![start_ms, end_ms], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    }) else {
        return BTreeMap::new();
    };
    queried.flatten().collect()
}

// ⓪「本月发现」的确定性结论规则（WORKBENCH_FINDINGS_TAB_SPEC §3.0，原型
/// FINDINGS_TAB_PROTOTYPE.html ⓪ 区）。**规则生成、非 LLM**——每条结论只是
/// 对 rows 的可复核算术：中位数偏离、跨度阈值、币种一致性。后端只出结构化
/// 字段（kind + 数字），中文句子由前端模板组装（与 remedy_for→labels 同一条
/// 「后端出数、前端出话」纪律）。每条规则至多产出一条、全量上限 4 条——
/// 摘要是抽样报告，不是把表搬进段落。
fn dig_findings(rows: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();

    // ── 规则 1（cost_outlier）：同币种内单会话成本 > 2× 中位 且缓存命中低。
    // 对照行 = 同币种里命中 ≥0.9 的最便宜组合（修复方案的同币种证据）。
    {
        let mut by_currency: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
        for row in rows {
            for a in row["amounts"].as_array().unwrap_or(&Vec::new()) {
                if let Some(cur) = a["currency"].as_str() {
                    by_currency.entry(cur.to_string()).or_default().push(row);
                    break; // 每行只按首个金额的币种归组（多币种行罕见，归首币种并如实可查）
                }
            }
        }
        for (cur, group) in by_currency {
            if group.len() < 2 {
                continue;
            }
            let sessions = |r: &Value| r["sessions"].as_i64().unwrap_or(0);
            let amount_minor = |r: &Value| r["amounts"].as_array().unwrap_or(&Vec::new())
                .iter().find(|a| a["currency"].as_str() == Some(cur.as_str()))
                .and_then(|a| a["amount_minor"].as_i64()).unwrap_or(0);
            let per_session = |r: &Value| {
                let s = sessions(r);
                if s <= 0 { None } else { Some(amount_minor(r) as f64 / s as f64) }
            };
            let mut vals: Vec<f64> = group.iter().filter_map(|r| per_session(r)).collect();
            if vals.len() < 2 {
                continue;
            }
            vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            // 偶数长度取上中位（vals[len/2]）：偏保守——更难触发 >2×，偏向诚实缺席。
            let median = vals[vals.len() / 2];
            if median <= 0.0 {
                continue;
            }
            let outlier = group.iter()
                .filter(|r| per_session(r).is_some_and(|v| v > 2.0 * median))
                .max_by(|a, b| per_session(b).partial_cmp(&per_session(a)).unwrap_or(std::cmp::Ordering::Equal));
            let Some(outlier) = outlier else { continue };
            let hit = outlier["cache_hit_ratio"].as_f64();
            // 低命中是「贵在缓存不在单价」断言的前提——命中正常却贵，那是任务重，不归这条管。
            if !hit.is_some_and(|h| h < 0.5) {
                continue;
            }
            let control = group.iter()
                .filter(|r| r["cache_hit_ratio"].as_f64().is_some_and(|h| h >= 0.9))
                .min_by(|a, b| per_session(a).partial_cmp(&per_session(b)).unwrap_or(std::cmp::Ordering::Equal));
            let Some(control) = control else { continue };
            let out_ps = per_session(outlier).unwrap_or(0.0);
            let ctl_ps = per_session(control).unwrap_or(0.0);
            if ctl_ps <= 0.0 || out_ps < ctl_ps {
                continue;
            }
            let ratio = (out_ps / ctl_ps * 10.0).round() / 10.0;
            let saving_minor = ((out_ps - ctl_ps) * sessions(outlier) as f64).round() as i64;
            out.push(json!({
                "kind": "cost_outlier",
                "currency": cur,
                "outlier": { "harness": outlier["harness"], "model_id": outlier["model_id"], "provider_id": outlier["provider_id"],
                    "per_session_minor": (out_ps * 100.0).round() as i64, "cache_hit_ratio": hit,
                    "uncached_tokens": outlier["tokens"]["uncached_input"] },
                "control": { "harness": control["harness"], "model_id": control["model_id"],
                    "per_session_minor": (ctl_ps * 100.0).round() as i64, "cache_hit_ratio": control["cache_hit_ratio"] },
                "ratio_vs_control": ratio,
                "saving_minor": saving_minor,
                "saving_pct": ((1.0 - ctl_ps / out_ps) * 100.0).round() as i64,
            }));
            break; // 全表只报最异常的一条
        }
    }

    // ── 规则 2（marathon）：Top 会话跨度 > 24h。
    let marathon_candidates: Vec<(&Value, &Value)> = rows.iter()
        .filter_map(|r| Some((r, r["top_sessions"].as_array()?)))
        .flat_map(|(r, list)| list.iter().map(move |s| (r, s)))
        .collect();
    if let Some((row, sess)) = marathon_candidates.iter().copied().filter(|(_, s)| {
        s["span_last_ms"].as_i64().unwrap_or(0) - s["span_first_ms"].as_i64().unwrap_or(0) > 24 * 3_600_000
    }).max_by_key(|(_, s)| s["span_last_ms"].as_i64().unwrap_or(0) - s["span_first_ms"].as_i64().unwrap_or(0)) {
        let span_ms = sess["span_last_ms"].as_i64().unwrap_or(0) - sess["span_first_ms"].as_i64().unwrap_or(0);
        out.push(json!({
            "kind": "marathon",
            "session_ref": sess["session_ref"],
            "span_hours": (span_ms as f64 / 3600000.0 * 10.0).round() / 10.0,
            "tokens_total": sess["tokens_total"],
            "failures": sess["failures"],
            "combo": { "harness": row["harness"], "model_id": row["model_id"] },
        }));
    }

    // ── 规则 3（currency_split）：可计价行币种不唯一 → 排序禁用的口径失真。
    {
        let mut currencies: BTreeMap<String, (i64, i64)> = BTreeMap::new(); // currency → (rows, tokens)
        for row in rows {
            for a in row["amounts"].as_array().unwrap_or(&Vec::new()) {
                if let Some(cur) = a["currency"].as_str() {
                    let e = currencies.entry(cur.to_string()).or_default();
                    e.0 += 1;
                    e.1 += row["tokens"]["total"].as_i64().unwrap_or(0);
                }
            }
        }
        if currencies.len() > 1 {
            // 中文词组归前端模板（「后端出数、前端出话」）：这里只给结构化的
            // by_currency 数字，detail 由 digCardText 组装。
            let by_currency: serde_json::Map<String, Value> = currencies.iter()
                .map(|(cur, (n, tokens))| (cur.clone(), json!({ "combos": n, "tokens": tokens })))
                .collect();
            out.push(json!({
                "kind": "currency_split",
                "currencies": currencies.keys().cloned().collect::<Vec<_>>(),
                "by_currency": by_currency,
            }));
        }
    }

    out.truncate(4);
    out
}

// `2026-09` → `("2026-09-01", "2026-09-30")`（cost_breakdown 吃日期串）。
fn month_day_span(month: &str) -> Result<(String, String), String> {
    let (y, m): (i64, u32) = {
        let mut parts = month.splitn(2, '-');
        let y = parts.next().and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("invalid month: {month}"))?;
        let m = parts.next().and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("invalid month: {month}"))?;
        (y, m)
    };
    if !(1..=12).contains(&m) {
        return Err(format!("invalid month: {month}"));
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        _ => 28,
    };
    Ok((format!("{month}-01"), format!("{month}-{days:02}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::{default_authority_path, AuthorityDb};

    fn temp_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("av-decmatrix-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_session(db: &AuthorityDb, harness: &str, session: &str) {
        db.conn()
            .execute(
                "INSERT OR IGNORE INTO sessions(session_key, harness, native_session_id, machine_namespace, last_observed_at_ms)
                 VALUES (?1, ?2, ?1, 'm', 1)",
                rusqlite::params![session, harness],
            )
            .unwrap();
    }

    fn seed_fact(
        db: &AuthorityDb,
        combo: (&str, &str, Option<&str>),
        session: &str,
        ts: i64,
        tokens: (i64, i64, i64, i64),
        billing_mode: &str,
    ) {
        let (harness, model, provider) = combo;
        seed_session(db, harness, session);
        db.conn()
            .execute(
                "INSERT OR IGNORE INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('run', 1, 'cli', 'succeeded', 13)",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                     observation_kind, provider_id, model_id, event_ts_ms, event_peak, pricing_basis, evidence_basis,
                     billing_mode, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     session_key, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'm', 's', ?1, 'token_count', ?3, ?4, ?5, 0, 'metered_estimate', 'missing',
                     ?6, ?7, ?8, ?9, ?10, ?11, 'run', 1, 1)",
                rusqlite::params![
                    format!("f-{harness}-{model}-{session}-{ts}"), harness, provider, model, ts,
                    billing_mode, tokens.0, tokens.1, tokens.2, tokens.3, session
                ],
            )
            .unwrap();
    }

    fn seed_issue(db: &AuthorityDb, harness: &str, rule: &str, at_ms: i64) {
        db.conn()
            .execute(
                "INSERT INTO issue_instances(issue_id, machine_namespace, harness, session_key, issue_type,
                     instance_fingerprint, status, severity, evaluator_id, evaluator_version,
                     evidence_fingerprint, opened_at_ms, metadata_json)
                 VALUES (?1, 'm', ?2, NULL, ?3, ?4, 'open', 'warning', 'ev', '1', 'fp', ?5, '{}')",
                rusqlite::params![format!("i-{harness}-{rule}-{at_ms}"), harness, rule, format!("fp-{at_ms}"), at_ms],
            )
            .unwrap();
    }

    // 分组/命中/订阅标记/执行环境级行为标记/Top 会话——空库之外的全部语义。
    // 计价合并只验证结构（amounts 数组存在；空 = 无价，不冒充）。
    #[test]
    fn groups_combos_with_honest_nulls_and_top_sessions() {
        let home = temp_home("rows");
        let db = AuthorityDb::open(&default_authority_path(&home), 1).unwrap();
        let (start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-09").unwrap();
        // 两个组合：codex/terra（两会话，其中 a 大）与 claude/opus（订阅）。
        seed_fact(&db, ("codex", "gpt-5.6-terra", Some("shengsuanyun")), "sess-a", start + 1000, (100, 900, 0, 50), "metered");
        seed_fact(&db, ("codex", "gpt-5.6-terra", Some("shengsuanyun")), "sess-a", start + 2000, (0, 0, 100, 10), "metered");
        seed_fact(&db, ("codex", "gpt-5.6-terra", Some("shengsuanyun")), "sess-b", start + 3000, (0, 50, 0, 0), "metered");
        seed_fact(&db, ("claude-code", "claude-opus-5", None), "sess-c", start + 4000, (0, 10_000, 0, 5), "subscription");
        seed_issue(&db, "codex", "SV610", start + 1500);
        seed_issue(&db, "codex", "SV610", start + 1600);

        let mut rows = combo_rows(db.conn(), start, start + 30 * 86_400_000).unwrap();
        attach_top_sessions(db.conn(), start, start + 30 * 86_400_000, &home, &mut rows).unwrap();
        let marks = harness_behavior_marks(db.conn(), start, start + 30 * 86_400_000);

        let terra = rows.get(&Combo {
            harness: "codex".into(), model: "gpt-5.6-terra".into(), provider: "shengsuanyun".into(),
        }).expect("terra combo").clone();
        assert_eq!(terra["sessions"], json!(2), "DISTINCT session_key 计会话：{terra}");
        assert_eq!(terra["tokens"]["total"], json!(1210));
        // 命中 = read / 输入侧 = 950 / (100+950+100) = 0.8261（四位小数舍入；
        // 输入侧含 cache_write——与 HourlyCell::cache_hit_ratio 同口径）。
        assert!((terra["cache_hit_ratio"].as_f64().unwrap() - 0.8261).abs() < 1e-9, "{terra}");
        assert_eq!(terra["has_subscription"], json!(false));
        let top = terra["top_sessions"].as_array().unwrap();
        assert_eq!(top.len(), 2, "两会话都进 Top（上限 3）：{top:?}");
        assert_eq!(top[0]["tokens_total"], json!(1160), "按贡献降序：sess-a 在前（1050+110 两笔之和）");
        assert!(top[0]["session_ref"].as_str().unwrap_or("").starts_with("sr_"), "不透明引用");
        assert_eq!(marks["codex"]["SV610"], json!(2), "执行环境级计数：{marks:?}");
        assert!(!marks.contains_key("claude-code"));

        let opus = rows.get(&Combo {
            harness: "claude-code".into(), model: "claude-opus-5".into(), provider: "<unknown>".into(),
        }).expect("opus combo").clone();
        assert_eq!(opus["has_subscription"], json!(true));
        assert_eq!(opus["cache_hit_ratio"], json!(1.0), "全缓存读");

        let _ = std::fs::remove_dir_all(&home);
    }

    // 输入侧全零 → null 不是 0（spec §1.4；HourlyCell::cache_hit_ratio 同纪律）。
    #[test]
    fn zero_input_side_is_null_not_zero() {
        let home = temp_home("null-ratio");
        let db = AuthorityDb::open(&default_authority_path(&home), 1).unwrap();
        let (start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-09").unwrap();
        seed_fact(&db, ("dsh", "x", None), "s", start, (0, 0, 0, 42), "metered");
        let rows = combo_rows(db.conn(), start, start + 86_400_000).unwrap();
        let row = rows.values().next().unwrap();
        assert_eq!(row["cache_hit_ratio"], Value::Null, "输入侧全零 → null：{row}");
        let _ = std::fs::remove_dir_all(&home);
    }

    fn seed_workflow(db: &AuthorityDb, session: &str, ts: i64, event_type: &str, outcome: &str) {
        db.conn()
            .execute(
                "INSERT INTO workflow_events(event_id, session_key, event_ts_ms, event_type,
                     capability_kind, capability_id, outcome, ingested_run_id, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, 'tool', 'Bash', ?5, 'run', 1)",
                rusqlite::params![format!("we-{session}-{ts}-{outcome}"), session, ts, event_type, outcome],
            )
            .unwrap();
    }

    // 时间窗是半开区间 [start, end)：恰在 start 计入、恰在 end 排除；
    // legacy_aggregate 与软删行不进组合（与 authority_query 既有窗口纪律一致）。
    #[test]
    fn window_boundaries_and_exclusion_predicates() {
        let home = temp_home("window");
        let db = AuthorityDb::open(&default_authority_path(&home), 1).unwrap();
        let (start, end) = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-09").unwrap();
        seed_fact(&db, ("codex", "m", None), "in-a", start, (10, 0, 0, 0), "metered");
        seed_fact(&db, ("codex", "m", None), "in-b", end - 1, (0, 10, 0, 0), "metered");
        seed_fact(&db, ("codex", "m", None), "out-c", end, (100, 0, 0, 0), "metered");
        // 第 1 行改 legacy_aggregate、第 2 行软删——都必须被排除。
        db.conn().execute(
            "UPDATE usage_facts SET observation_kind = 'legacy_aggregate' WHERE session_key = 'in-a'", []).unwrap();
        db.conn().execute(
            "UPDATE usage_facts SET deleted_at_ms = 1 WHERE session_key = 'in-b'", []).unwrap();
        let rows = combo_rows(db.conn(), start, end).unwrap();
        let total: i64 = rows.values().map(|r| r["tokens"]["total"].as_i64().unwrap_or(0)).sum();
        assert_eq!(total, 0, "恰在 end 的行、legacy、软删全部排除；恰在 start 的两行也被各自谓词排除后应为 0：{rows:?}");
        // 对照：不排除时的窗口语义（恰 start 计入、恰 end 排除）。
        let home2 = temp_home("window2");
        let db2 = AuthorityDb::open(&default_authority_path(&home2), 1).unwrap();
        seed_fact(&db2, ("codex", "m", None), "in-a", start, (10, 0, 0, 0), "metered");
        seed_fact(&db2, ("codex", "m", None), "out-c", end, (100, 0, 0, 0), "metered");
        let rows2 = combo_rows(db2.conn(), start, end).unwrap();
        let total2: i64 = rows2.values().map(|r| r["tokens"]["total"].as_i64().unwrap_or(0)).sum();
        assert_eq!(total2, 10, "恰在 start 计入、恰在 end 排除（半开区间）：{rows2:?}");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&home2);
    }

    // 端到端（decision_matrix 本体）：Top 会话带 failures、session_key 被剥离、
    // salt 自动创建、撞限流列挂执行环境级数据（验收盲区 4/5 的直测）。
    #[test]
    fn decision_matrix_end_to_end_top_sessions_and_pressure() {
        let home = temp_home("e2e");
        let db = AuthorityDb::open(&default_authority_path(&home), 1).unwrap();
        let (start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-09").unwrap();
        seed_fact(&db, ("codex", "gpt-5.6-terra", Some("shengsuanyun")), "sess-a", start + 1000, (100, 900, 0, 50), "metered");
        seed_workflow(&db, "sess-a", start + 1100, "tool_finished", "failed");
        seed_workflow(&db, "sess-a", start + 1200, "tool_finished", "failed");
        seed_workflow(&db, "sess-a", start + 1300, "tool_finished", "succeeded");
        seed_issue(&db, "codex", "SV607", start + 1500);

        let out = decision_matrix(&home, "2026-09").expect("matrix");
        let row = out["rows"].as_array().unwrap().iter()
            .find(|r| r["model_id"] == json!("gpt-5.6-terra")).expect("terra row").clone();
        let top = row["top_sessions"].as_array().unwrap();
        assert_eq!(top.len(), 1);
        assert_eq!(top[0]["failures"], json!(2), "workflow failed ×2 挂到 Top 会话：{top:?}");
        assert!(top[0].get("session_key").is_none(), "原生 session_key 必须剥离（§3.3 隐私边界）");
        assert!(top[0]["session_ref"].as_str().unwrap_or("").starts_with("sr_"));
        let pressure = &row["limit_pressure"];
        assert_eq!(pressure["hits"], json!(1), "SV607 ×1 计入撞限流：{pressure}");
        assert_eq!(pressure["per_session"], json!(1.0), "执行环境 1 个去重会话 → 均值 1.0");
        let _ = std::fs::remove_dir_all(&home);
    }

    fn dig_row(model: &str, sessions: i64, amount_minor: i64, hit: Option<f64>, top_sessions: Value) -> Value {
        json!({
            "harness": "claude-code", "model_id": model, "provider_id": "p", "sessions": sessions,
            "tokens": { "uncached_input": 100, "cache_read": 100, "cache_write": 0, "output": 1, "total": 201 },
            "cache_hit_ratio": hit, "has_subscription": false, "waste_rate": null,
            "amounts": [{ "amount_minor": amount_minor, "currency": "CNY", "basis": "metered_estimate" }],
            "top_sessions": top_sessions, "harness_behavior": {},
        })
    }

    // ⓪结论规则：成本异常（中位数偏离 + 低命中 + 同币种对照）的算术与诚实缺席。
    #[test]
    fn dig_cost_outlier_math_and_honest_absence() {
        // flash：¥5/会话、命中 0.22；两个正常行 ¥1/会话命中 0.95 → 中位 1.0，
        // outlier 5.0 > 2×中位 且命中 <0.5，control = 最便宜的高命中行。
        let rows = vec![
            dig_row("flash", 12, 6000, Some(0.22), json!([])),
            dig_row("normal-a", 10, 1000, Some(0.95), json!([])),
            dig_row("normal-b", 10, 1000, Some(0.96), json!([])),
        ];
        let out = dig_findings(&rows);
        let cost = out.iter().find(|c| c["kind"] == json!("cost_outlier")).expect("cost_outlier emitted");
        assert_eq!(cost["outlier"]["model_id"], json!("flash"));
        assert_eq!(cost["control"]["model_id"], json!("normal-a"));
        assert_eq!(cost["ratio_vs_control"], json!(5.0));
        // saving = 每会话差（6000/12 − 1000/10 = 400 minor）× outlier 会话数 12。
        assert_eq!(cost["saving_minor"], json!(4800));
        assert_eq!(cost["saving_pct"], json!(80));

        // 诚实缺席之一：贵但命中正常（任务重不归这条管）。
        let rows2 = vec![
            dig_row("heavy-task", 5, 5000, Some(0.9), json!([])),
            dig_row("normal-a", 10, 1000, Some(0.95), json!([])),
            dig_row("normal-b", 10, 1000, Some(0.96), json!([])),
        ];
        assert!(dig_findings(&rows2).iter().all(|c| c["kind"] != json!("cost_outlier")),
            "命中 ≥0.5 的贵行不报成本异常");
        // 诚实缺席之二：没有高命中的对照行（不能凭空宣称"该换谁"）。
        let rows3 = vec![
            dig_row("flash", 12, 6000, Some(0.22), json!([])),
            dig_row("normal-a", 10, 1000, Some(0.4), json!([])),
            dig_row("normal-b", 10, 1000, Some(0.5), json!([])),
        ];
        assert!(dig_findings(&rows3).iter().all(|c| c["kind"] != json!("cost_outlier")),
            "无 ≥0.9 命中的对照行 → 不报（修复建议没有证据）");
    }

    // ⓪结论规则：马拉松（>24h 取最长）与币种失真。
    #[test]
    fn dig_marathon_and_currency_split() {
        let rows = vec![
            dig_row("a", 2, 1000, Some(0.9), json!([
                { "session_ref": "sr_short", "span_first_ms": 0, "span_last_ms": 3600000, "tokens_total": 10, "failures": 0 },
                { "session_ref": "sr_long", "span_first_ms": 0, "span_last_ms": 179_280_000, "tokens_total": 473, "failures": 40 },
            ])),
            { let mut r = dig_row("b", 2, 1000, Some(0.9), json!([])); r["amounts"] = json!([{ "amount_minor": 1408, "currency": "USD", "basis": "metered_estimate" }]); r },
        ];
        let out = dig_findings(&rows);
        let marathon = out.iter().find(|c| c["kind"] == json!("marathon")).expect("marathon");
        assert_eq!(marathon["session_ref"], json!("sr_long"), "取最长跨度的会话");
        assert_eq!(marathon["span_hours"], json!(49.8), "179_280_000ms = 49.8h（>24h 阈值）");
        assert_eq!(marathon["failures"], json!(40));
        let split = out.iter().find(|c| c["kind"] == json!("currency_split")).expect("split");
        assert_eq!(split["currencies"], json!(["CNY", "USD"]));
        // 结构化字段（中文词组归前端模板）：by_currency 只出数字。
        assert_eq!(split["by_currency"]["CNY"]["combos"], json!(1));
        assert_eq!(split["by_currency"]["USD"]["combos"], json!(1));
        assert!(split.get("detail").is_none(), "后端不再拼中文词组");
        // 全 CNY 单币种 → currency_split 缺席；短会话 → marathon 缺席。
        let rows2 = vec![dig_row("a", 2, 1000, Some(0.9), json!([
            { "session_ref": "sr_short", "span_first_ms": 0, "span_last_ms": 3_600_000, "tokens_total": 5, "failures": 0 },
        ]))];
        let out2 = dig_findings(&rows2);
        assert!(out2.iter().all(|c| c["kind"] != json!("currency_split")));
        assert!(out2.iter().all(|c| c["kind"] != json!("marathon")), "≤24h 会话不报马拉松");
        // 偶数长度 median 取上中位：[1.0, 1.0, 1.0, 5.0] → 上中位 1.0（index 2）。
        let rows4 = vec![
            dig_row("flash", 12, 6000, Some(0.22), json!([])),
            dig_row("n1", 10, 1000, Some(0.95), json!([])),
            dig_row("n2", 10, 1000, Some(0.95), json!([])),
            dig_row("n3", 10, 1000, Some(0.95), json!([])),
        ];
        assert!(dig_findings(&rows4).iter().any(|c| c["kind"] == json!("cost_outlier")),
            "偶数长度下中位口径不改变本用例的判定");
    }

    #[test]
    fn month_day_span_covers_leap_february() {
        assert_eq!(month_day_span("2026-09").unwrap(), ("2026-09-01".into(), "2026-09-30".into()));
        assert_eq!(month_day_span("2028-02").unwrap(), ("2028-02-01".into(), "2028-02-29".into()));
        assert_eq!(month_day_span("2026-02").unwrap(), ("2026-02-01".into(), "2026-02-28".into()));
        assert!(month_day_span("2026-13").is_err());
        assert!(month_day_span("not-a-month").is_err());
    }
}
