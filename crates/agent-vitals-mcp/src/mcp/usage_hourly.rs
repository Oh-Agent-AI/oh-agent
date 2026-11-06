//! `usage_hourly` 工具（spec §7.2）——回答模型 / 执行环境 / provider 的小时分布。
//!
//! 实现注记（增量 2；`group_by` 路径在真机验证后统一，2026-09-08）：
//! - 三个 `group_by` 都走 `authority_query::hourly_by_harness_model`（真四桶 +
//!   `(harness, model, hour)` 三维聚合 + 24 桶）。`group_by=harness` 把 model 维折叠掉。
//!   曾经 harness 轴走 `hourly_by_harness`（Stage 5b 导航查询，只回单个 i64 总量），
//!   总量被塞进 `output_tokens` 槽 → `total_output_tokens == total_tokens`，逐桶
//!   同样失真——已改。`hourly_by_harness_model` 空 harness 列表即全 wired 执行环境，所以
//!   `group_by=model` 不带 `harnesses` 参数也不再静默返回空 series。
//! - **`metrics="cost"` 推迟到 `cost_breakdown`（M3）**：spec §7.2 已校正
//!   ——逐小时计价要求事实时点选价版（`PricingCards::asof` 当前仅窗口级），
//!   强行 round 到小时会破坏 M01 守恒测试夹具的 fixture。
//! - **`as_of_run_id`（spec §6.4.1）**：drift → `warnings:[{code:"snapshot_drift",...}]`
//!   + 返回当前最新数据；不存在 → `invalid_argument`。

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};

use super::{
    authority_state_for, build_envelope, ms_to_rfc3339_beijing, AuthorityHandle, ToolError, ToolSpec,
};
use agent_vitals_data::authority_query;
use agent_vitals_data::authority_query::{beijing_day_bounds_ms, HourlyCell};

const HOURS: [&str; 24] = [
    "00","01","02","03","04","05","06","07","08","09","10","11",
    "12","13","14","15","16","17","18","19","20","21","22","23",
];

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "usage_hourly",
        description: "Report hourly usage curves (24 buckets in the configured statistics timezone, including zero buckets) for one day, optionally broken down by harness / model / provider. Tokens are summed across usage_facts (excluding legacy_aggregate rows). 'cost' metric is not yet exposed per-hour — it lives in cost_breakdown (M3) because per-hour pricing needs fact-time price-version replay, not window-level.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": "Date YYYY-MM-DD in the configured statistics timezone (inclusive). The natural-day window covers [00:00, 24:00)."
                },
                "group_by": {
                    "type": "string",
                    "enum": ["harness", "model", "provider"],
                    "description": "Dimension to aggregate by. `provider` uses provider_id; missing evidence is grouped under <unknown>."
                },
                "harnesses": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional harness filter (claude-code / codex / dsh). Empty/missing = all known harnesses."
                },
                "models": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "enum": ["harness_raw"] },
                            "harness": { "type": "string" },
                            "value": { "type": "string" }
                        },
                        "required": ["kind", "harness", "value"],
                        "additionalProperties": false
                    },
                    "description": "Optional model filter — v1 only `kind: harness_raw` (matches usage_facts.model_id, the harness-scoped raw value). Empty/missing = all models."
                },
                "metrics": {
                    "type": "array",
                    "items": { "type": "string", "enum": ["total_tokens", "output_tokens"] },
                    "description": "Token metrics to include per bucket. 'cost' deferred to cost_breakdown (M3)."
                },
                "as_of_run_id": {
                    "type": "string",
                    "description": "Optional snapshot token (spec §6.4.1). If supplied but != current latest run_id, the response still returns current data but warns snapshot_drift. Unknown run_id = invalid_argument."
                }
            },
            "required": ["date", "group_by"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "spec §6 envelope; data.series is an array of sequences keyed by dimension, each with 24 hour buckets."
        }),
    }
}

pub fn run(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let date = args.get("date").and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("invalid_argument", "`date` (YYYY-MM-DD) is required"))?;
    let group_by = args.get("group_by").and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("invalid_argument", "`group_by` is required"))?;

    let (start_ms, end_ms) = beijing_day_bounds_ms(date)
        .ok_or_else(|| ToolError::new("invalid_argument", format!("invalid `date`: {date} (expect YYYY-MM-DD)")))?;

    let handle = AuthorityHandle::open(data_home)?;
    let conn = handle.conn();

    let mut warnings = Vec::new();
    // spec §6.4.1 `as_of_run_id` 三态——共享助手（`mcp::check_as_of_run_id`）。
    super::check_as_of_run_id(conn, args, &mut warnings)?;

    // 模型 / 执行环境 / provider 过滤转 SQL WHERE 子句。
    let harness_filter: Vec<String> = args
        .get("harnesses")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let model_filter: Vec<(String, String)> = args
        .get("models")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    let obj = v.as_object()?;
                    let kind = obj.get("kind").and_then(Value::as_str)?;
                    if kind != "harness_raw" {
                        return None; // spec D3：v1 只 harness_raw，其它非法
                    }
                    let harness = obj.get("harness").and_then(Value::as_str)?;
                    let value = obj.get("value").and_then(Value::as_str)?;
                    Some((harness.to_string(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    let series = match group_by {
        "harness" => series_by_harness(conn, start_ms, end_ms, &harness_filter)?,
        "model" => series_by_model(conn, start_ms, end_ms, &harness_filter, &model_filter)?,
        "provider" => series_by_provider(conn, start_ms, end_ms, &harness_filter)?,
        other => {
            return Err(ToolError::new(
                "invalid_argument",
                format!("unknown `group_by`: {other} (expected harness | model | provider)"),
            ));
        }
    };

    // metrics：当前固定两种（spec §7.2 增量 2 校正——cost 推迟到 cost_breakdown）。
    let metrics: Vec<&str> = args
        .get("metrics")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .filter(|m| matches!(*m, "total_tokens" | "output_tokens"))
                .collect()
        })
        .unwrap_or_else(|| vec!["total_tokens", "output_tokens"]);

    let totals_by_harness = compute_totals_by_harness(&series);
    let peak_hour_by_harness = compute_peak_hour_by_harness(&series);

    let mut sequences: Vec<Value> = series
    .iter()
    .map(|((harness, model), buckets)| {
        let total: i64 = buckets.values().map(HourlyCell::total).sum();
        let total_output: i64 = buckets.values().map(|c| c.output_tokens).sum();
        let hours: Vec<Value> = HOURS
        .iter()
        .map(|h| {
            let cell = buckets.get(*h).cloned().unwrap_or(HourlyCell {
                uncached_input_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                output_tokens: 0,
            });
            let mut obj = serde_json::Map::new();
            obj.insert("hour".into(), json!(h));
            for m in &metrics {
                match *m {
                    "total_tokens" => { obj.insert("total_tokens".into(), json!(cell.total())); }
                    "output_tokens" => { obj.insert("output_tokens".into(), json!(cell.output_tokens)); }
                    _ => {}
                }
            }
            Value::Object(obj)
        })
        .collect();
        json!({
            "key": match group_by {
                "harness" => json!({ "harness": harness }),
                "model" => json!({
                    "harness": harness,
                    "model": model,
                    "identity_kind": "harness_raw",
                }),
                "provider" => json!({ "harness": harness, "provider": model }),
                _ => unreachable!(),
            },
            "hours": hours,
            "total_tokens": total,
            "total_output_tokens": total_output,
            "peak_hour": peak_hour_by_harness.get(harness).cloned().unwrap_or(Value::Null),
        })
    })
    .collect();

    // 排序：先 total 降序，再 key 升序（稳定排序让守恒测试可重现）。
    sequences.sort_by(|a, b| {
        let ta = a["total_tokens"].as_i64().unwrap_or(0);
        let tb = b["total_tokens"].as_i64().unwrap_or(0);
        tb.cmp(&ta).then_with(|| {
            let ka = a["key"].to_string();
            let kb = b["key"].to_string();
            ka.cmp(&kb)
        })
    });

    let data = json!({
        "date": date,
        "group_by": group_by,
        "series": sequences,
        "totals_by_harness": totals_by_harness,
    });

    let coverage = json!({
        "status": "complete",
        "requested_from": ms_to_rfc3339_beijing(start_ms),
        "requested_to": ms_to_rfc3339_beijing(end_ms),
        "covered_from": ms_to_rfc3339_beijing(start_ms),
        "covered_to": ms_to_rfc3339_beijing(end_ms),
        "missing_harnesses": compute_missing_harnesses(&series, &harness_filter),
    });

    Ok(build_envelope(
        conn,
        authority_state_for(data_home),
        Some(end_ms),
        coverage,
        warnings,
        data,
    ))
}

/// 内部序列形状：(harness, model_or_wildcard) → 24 桶 cell。
type SeriesEntry = ((String, String), BTreeMap<String, HourlyCell>);

fn series_by_harness(
    conn: &rusqlite::Connection,
    start_ms: i64,
    end_ms: i64,
    harness_filter: &[String],
) -> Result<Vec<SeriesEntry>, ToolError> {
    // harness 轴 = model 轴按 harness 折叠。用 `hourly_by_harness_model`（真四桶）而非
    // `hourly_by_harness`（Stage 5b 导航查询只回单个 i64 总量——塞进 output_tokens
    // 会让 `total_output_tokens` 变成 `total_tokens` 的复制品，逐桶同样失真）。
    // `hourly_by_harness_model` 空 harness_filter 即全 wired，无需在这里补默认。
    let map =
        authority_query::hourly_by_harness_model(conn, start_ms, end_ms, harness_filter).map_err(too)?;
    let mut by_harness: BTreeMap<String, BTreeMap<String, HourlyCell>> = BTreeMap::new();
    for ((harness, _model), buckets) in map {
        let cells = by_harness.entry(harness).or_default();
        for (hour, cell) in buckets {
            let acc = cells.entry(hour).or_insert(HourlyCell {
                uncached_input_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                output_tokens: 0,
            });
            acc.uncached_input_tokens += cell.uncached_input_tokens;
            acc.cache_read_tokens += cell.cache_read_tokens;
            acc.cache_write_tokens += cell.cache_write_tokens;
            acc.output_tokens += cell.output_tokens;
        }
    }
    Ok(by_harness
        .into_iter()
        .map(|(harness, cells)| ((harness, "*".to_string()), cells))
        .collect())
}

fn series_by_model(
    conn: &rusqlite::Connection,
    start_ms: i64,
    end_ms: i64,
    harness_filter: &[String],
    model_filter: &[(String, String)],
) -> Result<Vec<SeriesEntry>, ToolError> {
    // `hourly_by_harness_model` 本身对空 harness_filter 就展开成全 wired 执行环境（单执行环境
    // SQL + 内存合并）——曾经这里有一个 `if harness_filter.is_empty() { return
    // Ok(vec![]) }` 的守卫，让 `group_by=model` 不带 `harnesses` 参数时**静默返回
    // 空 series**，违反 schema 里「empty/missing = all known harnesses」的承诺，也
    // 违反「缺证据不能伪装成零」。删掉。
    let map =
        authority_query::hourly_by_harness_model(conn, start_ms, end_ms, harness_filter).map_err(too)?;
    let mut out: Vec<SeriesEntry> = map
        .into_iter()
        .filter(|((harness, model), _)| {
            // harness 过滤：空 = 不过滤。
            if !harness_filter.is_empty() && !harness_filter.iter().any(|h| h == harness) {
                return false;
            }
            // model 过滤：空 = 不过滤。`models[]` 的 `kind="harness_raw"` + harness + value
            // 共同决定一格匹配——`(harness, value)` 必须在 `model_filter` 命中。
            // 其它 `kind` 在调用层已经过滤掉（仅 harness_raw 进入这里）。
            if model_filter.is_empty() {
                true
            } else {
                model_filter
                    .iter()
                    .any(|(mh, mv)| mh == harness && mv == model)
            }
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

fn series_by_provider(
    conn: &rusqlite::Connection,
    start_ms: i64,
    end_ms: i64,
    harness_filter: &[String],
) -> Result<Vec<SeriesEntry>, ToolError> {
    let map = authority_query::hourly_by_harness_provider(conn, start_ms, end_ms, harness_filter).map_err(too)?;
    Ok(map.into_iter().collect())
}

fn compute_totals_by_harness(series: &[SeriesEntry]) -> BTreeMap<String, i64> {
    let mut out: BTreeMap<String, i64> = BTreeMap::new();
    for ((harness, _), buckets) in series {
        *out.entry(harness.clone()).or_default() += buckets.values().map(HourlyCell::total).sum::<i64>();
    }
    out
}

fn compute_peak_hour_by_harness(series: &[SeriesEntry]) -> BTreeMap<String, Value> {
    let mut best: BTreeMap<String, (i64, &str)> = BTreeMap::new();
    for ((harness, _), buckets) in series {
        for (h, cell) in buckets {
            let t = cell.total();
            let cur = best.entry(harness.clone()).or_insert((0, "00"));
            if t > cur.0 {
                *cur = (t, h);
            }
        }
    }
    best.into_iter().map(|(h, (_, hh))| (h, json!(hh))).collect()
}

fn compute_missing_harnesses(series: &[SeriesEntry], harness_filter: &[String]) -> Vec<String> {
    let present: std::collections::BTreeSet<&str> =
        series.iter().map(|((h, _), _)| h.as_str()).collect();
    harness_filter
        .iter()
        .filter(|h| !present.contains(h.as_str()))
        .cloned()
        .collect()
}

fn too(e: agent_vitals_data::authority::AuthorityError) -> ToolError {
    ToolError::new("internal_error", format!("authority query: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;

    fn tmp_home(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "avmcp-uh-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn seed_db(home: &std::path::Path) {
        std::fs::create_dir_all(home).unwrap();
        let path = agent_vitals_data::authority::default_authority_path(home);
        AuthorityDb::open(&path, 1_700_000_000_000).unwrap();
    }

    #[test]
    fn schema_is_closed_and_required_fields_are_present() {
        let s = spec();
        assert_eq!(s.name, "usage_hourly");
        assert_eq!(s.input_schema["type"], "object");
        assert_eq!(s.input_schema["additionalProperties"], json!(false));
        assert_eq!(s.input_schema["required"], json!(["date", "group_by"]));
    }

    #[test]
    fn missing_db_is_hard_error_not_unavailable_envelope() {
        let home = tmp_home("missing");
        let err = run(
            &json!({ "date": "2026-09-07", "group_by": "model" }),
            &home,
        )
        .unwrap_err();
        assert_eq!(err.code, "database_missing");
    }

    #[test]
    fn empty_db_returns_complete_coverage_with_zero_series() {
        let home = tmp_home("empty");
        seed_db(&home);
        let env = run(
            &json!({ "date": "2026-09-07", "group_by": "harness" }),
            &home,
        )
        .unwrap();
        assert_eq!(env["data"]["series"].as_array().unwrap().len(), 0);
        // spec §6.2：诚实返回原则——零事实报 `coverage=complete`（区间完整覆盖 +
        // 没有事实，而不是 `partial`——`partial` 是覆盖不全）。
        assert_eq!(env["coverage"]["status"], "complete");
        // covered_from / covered_to 是 RFC 3339 北京时区。
        assert!(env["coverage"]["covered_from"].as_str().unwrap().ends_with("+08:00"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn invalid_date_is_invalid_argument() {
        let home = tmp_home("bad-date");
        seed_db(&home);
        let err = run(
            &json!({ "date": "not-a-date", "group_by": "harness" }),
            &home,
        )
        .unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn unknown_group_by_is_invalid_argument() {
        let home = tmp_home("bad-gb");
        seed_db(&home);
        let err = run(
            &json!({ "date": "2026-09-07", "group_by": "region" }),
            &home,
        )
        .unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn unknown_model_kind_is_silently_ignored_not_hard_error() {
        // spec §7.2 D3：v1 只支持 kind=harness_raw，其它值（含 "canonical"）
        // 合法但不识别。spec 没有规定硬错误——选择静默过滤，不污染响应。
        let home = tmp_home("bad-kind");
        seed_db(&home);
        let env = run(
            &json!({
                "date": "2026-09-07",
                "group_by": "model",
                "models": [
                    { "kind": "canonical", "harness": "x", "value": "y" }
                ]
            }),
            &home,
        )
        .unwrap();
        assert!(env["data"]["series"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn as_of_run_id_unknown_run_returns_invalid_argument() {
        let home = tmp_home("asof-unknown");
        seed_db(&home);
        // Seed a current run so the drift branch is exercised, not the
        // "no successful sync yet" branch.
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&home),
            1_700_000_000_000,
        )
        .unwrap();
        db.begin_run("run_current", "cli", 1_700_000_000_000).unwrap();
        db.finish_run("run_current", "succeeded", None, None, 1_700_000_001_000).unwrap();
        drop(db);

        let err = run(
            &json!({
                "date": "2026-09-07",
                "group_by": "harness",
                "as_of_run_id": "never-happened"
            }),
            &home,
        )
        .unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn as_of_run_id_drift_existing_run_warns_not_errors() {
        // Spec §6.4.1 (c)：请求的是过去某次 run（存在）但 != 当前 → 返回当前 +
        // warnings=[snapshot_drift]，**不** invalid_argument。
        let home = tmp_home("asof-drift");
        seed_db(&home);
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&home),
            1_700_000_000_000,
        )
        .unwrap();
        // 两条 succeeded run —— current 是 "run_current"，请求 "run_old"。
        db.begin_run("run_old", "cli", 1_700_000_000_000).unwrap();
        db.finish_run("run_old", "succeeded", None, None, 1_700_000_001_000).unwrap();
        db.begin_run("run_current", "cli", 1_700_000_002_000).unwrap();
        db.finish_run("run_current", "succeeded", None, None, 1_700_000_003_000).unwrap();
        drop(db);

        let env = run(
            &json!({
                "date": "2026-09-07",
                "group_by": "harness",
                "as_of_run_id": "run_old"
            }),
            &home,
        )
        .unwrap();
        assert!(
            env["warnings"].as_array().unwrap().iter().any(|w| w["code"] == "snapshot_drift"),
            "drift → warning (not error): {}",
            env["warnings"],
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[allow(clippy::too_many_arguments)]
    fn seed_fact(
        db: &AuthorityDb,
        fid: &str,
        harness: &str,
        model: &str,
        ts_ms: i64,
        u: i64,
        cr: i64,
        cw: i64,
        o: i64,
    ) {
        db.conn()
            .execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('run', 1, 'cli', 'succeeded', 2) ON CONFLICT(run_id) DO NOTHING",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                     event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                     output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'm', 'sess', ?1, 'assistant-usage', NULL, ?3, ?4, 0,
                     ?5, ?6, ?7, ?8, 'run', 1, 1)",
                rusqlite::params![fid, harness, model, ts_ms, u, cr, cw, o],
            )
            .unwrap();
    }

    /// 真机验证抓出的两个缺陷（2026-09-08）：
    /// (A) `group_by=harness` 曾把每小时单个 i64 总量塞进 `output_tokens` 槽 →
    ///     `total_output_tokens == total_tokens`、逐桶亦然；
    /// (B) `group_by=model` 不带 `harnesses` 参数曾静默返回空 series。
    #[test]
    fn harness_axis_reports_real_output_split_and_model_axis_needs_no_harnesses_arg() {
        let home = tmp_home("axis-fix");
        seed_db(&home);
        let db = AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&home),
            1_700_000_000_000,
        )
        .unwrap();
        // 2026-09-07 09:00 北京 —— 大量 cache_read（claude 典型），小 output。
        let (start, _end) = beijing_day_bounds_ms("2026-09-07").unwrap();
        let nine = start + 9 * 3_600_000;
        seed_fact(&db, "f1", "claude-code", "claude-sonnet-5", nine, 1_000, 900_000, 100, 5_000);
        seed_fact(&db, "f2", "codex", "gpt-5-codex", nine + 60_000, 2_000, 10_000, 0, 3_000);
        drop(db);

        // (A) harness 轴：output 是总量的一小部分，不是复制品。
        let env = run(&json!({ "date": "2026-09-07", "group_by": "harness" }), &home).unwrap();
        let series = env["data"]["series"].as_array().unwrap();
        assert_eq!(series.len(), 2, "claude-code + codex");
        let cc = series
            .iter()
            .find(|s| s["key"]["harness"] == "claude-code")
            .unwrap();
        let total = cc["total_tokens"].as_i64().unwrap();
        let out = cc["total_output_tokens"].as_i64().unwrap();
        assert_eq!(total, 1_000 + 900_000 + 100 + 5_000);
        assert_eq!(out, 5_000, "output 槽必须是真 output，不是四桶之和");
        assert!(out < total);
        // 逐桶也不失真：09 点桶的 output_tokens == 5000，不是桶总量。
        let h09 = cc["hours"]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["hour"] == "09")
            .unwrap();
        assert_eq!(h09["output_tokens"].as_i64().unwrap(), 5_000);
        assert_eq!(h09["total_tokens"].as_i64().unwrap(), 906_100);

        // (B) model 轴，无 `harnesses` 参数 → 仍返回所有 wired 执行环境的 model 序列。
        let env = run(&json!({ "date": "2026-09-07", "group_by": "model" }), &home).unwrap();
        let series = env["data"]["series"].as_array().unwrap();
        assert_eq!(series.len(), 2, "两个执行环境各一个 model，不带 harnesses 参数不该是空");
        assert!(series.iter().any(|s| s["key"]["model"] == "claude-sonnet-5"));
        assert!(series.iter().any(|s| s["key"]["model"] == "gpt-5-codex"));

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn provider_axis_keeps_cogfoundry_separate_from_openai() {
        let home = tmp_home("provider-axis");
        seed_db(&home);
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(&home), 1_700_000_000_000).unwrap();
        let (start, _) = beijing_day_bounds_ms("2026-09-07").unwrap();
        seed_fact(&db, "openai-f", "codex", "gpt-5.6-sol", start + 3_600_000, 10, 0, 0, 1);
        seed_fact(&db, "cog-f", "codex", "gpt-5.6-sol", start + 3_600_000, 20, 0, 0, 2);
        db.conn().execute("UPDATE usage_facts SET provider_id = CASE fact_id WHEN 'openai-f' THEN 'openai' ELSE 'cogfoundry.ai' END", []).unwrap();
        drop(db);
        let env = run(&json!({"date":"2026-09-07","group_by":"provider"}), &home).unwrap();
        let series = env["data"]["series"].as_array().unwrap();
        assert_eq!(series.len(), 2);
        assert!(series.iter().any(|s| s["key"]["provider"] == "openai" && s["total_tokens"] == 11));
        assert!(series.iter().any(|s| s["key"]["provider"] == "cogfoundry.ai" && s["total_tokens"] == 22));
        let _ = std::fs::remove_dir_all(&home);
    }
}
