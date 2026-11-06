//! 「测试」tab v2 的被动路线质量聚合：`usage_facts` 按 (harness × 模型族 × 模型)
//! 分组，家族/官方性判定走 `domain::route_quality` 的封闭词表（不在这层写
//! SQL CASE——词表只活在一处，Rust/Python 对拍钉住）。
//!
//! 诚实性：这是**读侧聚合**，不产生新事实。`model_id` 来自协议响应（执行环境
//! emitter 已入库），「非官方模型」的判定强度就是模型串本身——不叠加推断；
//! `synthetic` 族（claude CLI 请求失败时的本地占位）单列为 `api_error`，不
//! 计入任何模型家族的用量。执行环境没有登记基准（`harness_native_families` 返回
//! None）时 `has_baseline=false`，UI 只展示家族分布、不做「非原生」结论。

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde_json::{json, Value};

use agent_vitals_domain::route_quality::{
    family_flag, harness_native_families, model_family, MODEL_FAMILIES,
};

use crate::authority::AuthorityError;

/// 按 (harness, model_id, provider_raw, provider_id) 聚合的原料行。
struct ModelRow {
    requests: i64,
    tokens_total: i64,
    last_event_ms: i64,
}

/// 家族级聚合（模型明细挂在里面；BTreeMap 键序保证 JSON 输出确定）。
#[derive(Default)]
struct FamilyAgg {
    requests: i64,
    tokens_total: i64,
    last_event_ms: i64,
    sessions: std::collections::BTreeSet<String>,
    models: BTreeMap<String, Value>, // key: model|provider_raw|provider_id
}

fn to_authority_error(error: rusqlite::Error) -> AuthorityError {
    AuthorityError::Sqlite(error)
}

/// 生成整个报告。`since_ms`/`now_ms` 由调用方定窗口（CLI `--days` 折算）。
pub fn route_quality_summary(
    conn: &Connection,
    since_ms: i64,
    now_ms: i64,
) -> Result<Value, AuthorityError> {
    // (a) 请求/token 聚合——usage_facts 直读（billing/行为事实表不碰）。
    let mut stmt = conn
        .prepare(
            "SELECT harness, model_id, COALESCE(provider_raw,''), COALESCE(provider_id,''),
                    COUNT(*),
                    SUM(uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens),
                    MAX(event_ts_ms)
             FROM usage_facts
             WHERE event_ts_ms >= ?1 AND event_ts_ms <= ?2 AND deleted_at_ms IS NULL
             GROUP BY 1,2,3,4",
        )
        .map_err(to_authority_error)?;
    let rows = stmt
        .query_map([since_ms, now_ms], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                ModelRow {
                    requests: row.get(4)?,
                    tokens_total: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    last_event_ms: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                },
            ))
        })
        .map_err(to_authority_error)?;

    // harness → family → FamilyAgg；harness 顺序、族顺序均 BTreeMap 确定化。
    let mut harnesses: BTreeMap<String, BTreeMap<String, FamilyAgg>> = BTreeMap::new();
    for row in rows.flatten() {
        let (harness, model, provider_raw, provider_id, agg_row) = row;
        let family = model_family(&model);
        let entry = harnesses
            .entry(harness.clone())
            .or_default()
            .entry(family.to_string())
            .or_default();
        entry.requests += agg_row.requests;
        entry.tokens_total += agg_row.tokens_total;
        entry.last_event_ms = entry.last_event_ms.max(agg_row.last_event_ms);
        let model_key = format!("{model}|{provider_raw}|{provider_id}");
        let slot = entry
            .models
            .entry(model_key)
            .or_insert_with(|| json!({
                "model": model,
                "provider_raw": provider_raw,
                "provider_id": provider_id,
                "requests": 0,
                "tokens_total": 0,
                "last_event_ms": 0,
            }));
        slot["requests"] = json!(slot["requests"].as_i64().unwrap_or(0) + agg_row.requests);
        slot["tokens_total"] =
            json!(slot["tokens_total"].as_i64().unwrap_or(0) + agg_row.tokens_total);
        slot["last_event_ms"] = json!(agg_row.last_event_ms.max(
            slot["last_event_ms"].as_i64().unwrap_or(0)
        ));
    }

    // (b) 会话数：同一会话可能用到多个模型——按 (harness, model) 拉 DISTINCT
    // 会话键，在 Rust 侧按族去重（SQL 里做族级 DISTINCT 会把词表复制进 SQL）。
    let mut session_stmt = conn
        .prepare(
            "SELECT DISTINCT harness, session_key, model_id FROM usage_facts
             WHERE event_ts_ms >= ?1 AND event_ts_ms <= ?2 AND deleted_at_ms IS NULL",
        )
        .map_err(to_authority_error)?;
    let session_rows = session_stmt
        .query_map([since_ms, now_ms], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(to_authority_error)?;
    for (harness, session_key, model) in session_rows.flatten() {
        if session_key.is_empty() {
            continue;
        }
        if let Some(families) = harnesses.get_mut(&harness) {
            if let Some(entry) = families.get_mut(model_family(&model)) {
                entry.sessions.insert(session_key);
            }
        }
    }

    let harness_reports: Vec<Value> = harnesses
        .into_iter()
        .map(|(harness, families)| {
            let native = harness_native_families(&harness);
            let total_requests: i64 = families.values().map(|f| f.requests).sum();
            let mut total_sessions = std::collections::BTreeSet::new();
            for family in families.values() {
                total_sessions.extend(family.sessions.iter().cloned());
            }
            let family_list: Vec<Value> = families
                .into_iter()
                .map(|(family, agg)| {
                    // 家族级 flag 用 domain 的 family_flag（族名不是模型串，
                    // 不能拿 model_family 回转）——单一定义点在对拍模块里。
                    let flag = family_flag(&harness, &family);
                    json!({
                        "family": family,
                        "flag": flag,
                        "requests": agg.requests,
                        "sessions": agg.sessions.len(),
                        "tokens_total": agg.tokens_total,
                        "last_event_ms": agg.last_event_ms,
                        "request_share": if total_requests > 0 {
                            (agg.requests as f64 / total_requests as f64 * 1000.0).round() / 10.0
                        } else { 0.0 },
                        "models": agg.models.into_values()
                            .collect::<Vec<Value>>(),
                    })
                })
                .collect();
            json!({
                "harness": harness,
                "has_baseline": native.is_some(),
                "native_families": native.unwrap_or(&[]),
                "totals": {
                    "requests": total_requests,
                    "sessions": total_sessions.len(),
                },
                "families": family_list,
            })
        })
        .collect();

    Ok(json!({
        "since_ms": since_ms,
        "now_ms": now_ms,
        "families_vocabulary": MODEL_FAMILIES,
        "harnesses": harness_reports,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::AuthorityDb;

    #[allow(clippy::too_many_arguments)] // 测试造行器：列即事实表的列，拆 struct 只会更啰嗦
    fn fact(
        conn: &Connection,
        id: &str,
        harness: &str,
        session: &str,
        model: &str,
        provider_raw: Option<&str>,
        provider_id: Option<&str>,
        ts: i64,
        tokens: i64,
    ) {
        conn.execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                 observation_kind, session_key, provider_id, model_id, provider_raw, event_ts_ms,
                 pricing_basis, evidence_basis,
                 uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 'm', ?3, ?4, 'token_count', ?3, ?5, ?6, ?7, ?8,
                 'metered_estimate', 'missing', ?9, 0, 0, 0, 'run', 1, 1)",
            rusqlite::params![
                id, harness, session, format!("e-{id}"),
                provider_id, model, provider_raw, ts, tokens
            ],
        )
        .unwrap();
    }

    #[test]
    fn families_flags_sessions_and_synthetic_errors() {
        let dir = std::env::temp_dir().join(format!("av-route-quality-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = AuthorityDb::open(&dir.join("a.sqlite3"), 1_000).unwrap();
        let conn = db.conn();
        // FK 依赖先落：ingested_run_id → sync_runs；session_key → sessions
        // （s9 也插：窗口外的 fact 照样过 FK，只是聚合时被 since 过滤）。
        conn.execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run', 1, 'cli', 'succeeded', 13)", [],
        )
        .unwrap();
        for (session, harness) in [("s1", "claude-code"), ("s2", "claude-code"), ("s3", "claude-code"), ("s9", "claude-code"), ("w1", "workbuddy")] {
            conn.execute(
                "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, last_observed_at_ms)
                 VALUES (?1, ?2, ?1, 'm', 1000)",
                rusqlite::params![session, harness],
            )
            .unwrap();
        }
        // 窗口内：官方 claude ×2（两会话）+ 中转 deepseek ×3（一个会话还同时用过
        // claude——会话去重要按族算，不能把 3+2 直接相加）；synthetic ×1（错误）。
        fact(conn, "f1", "claude-code", "s1", "claude-sonnet-5", Some("anthropic"), Some("anthropic"), 100, 10);
        fact(conn, "f2", "claude-code", "s2", "anthropic/claude-opus-5", Some("anthropic"), Some("anthropic"), 110, 20);
        fact(conn, "f3", "claude-code", "s2", "deepseek-v4-flash", None, None, 120, 30);
        fact(conn, "f4", "claude-code", "s3", "deepseek/deepseek-v4-pro-0813", None, None, 130, 40);
        fact(conn, "f5", "claude-code", "s3", "glm-5.3-flash[1M]", None, None, 140, 50);
        fact(conn, "f6", "claude-code", "s3", "<synthetic>", None, None, 150, 0);
        // 窗口外（早于 since）：不计入。
        fact(conn, "f7", "claude-code", "s9", "deepseek-v4-flash", None, None, 1, 999);
        // 无基准执行环境：只展示、不判非原生。
        fact(conn, "f8", "workbuddy", "w1", "claude-sonnet-5", None, None, 120, 5);

        let report = route_quality_summary(conn, 100, 200).unwrap();
        let harnesses = report["harnesses"].as_array().unwrap();
        let claude = harnesses.iter().find(|h| h["harness"] == "claude-code").unwrap();
        assert_eq!(claude["has_baseline"], true);
        assert_eq!(claude["totals"]["requests"], 6);
        assert_eq!(claude["totals"]["sessions"], 3);
        let families = claude["families"].as_array().unwrap();
        let by_family = |name: &str| families.iter().find(|f| f["family"] == name).unwrap();
        let anthropic = by_family("anthropic");
        assert_eq!(anthropic["flag"], "native");
        assert_eq!(anthropic["requests"], 2);
        assert_eq!(anthropic["sessions"], 2, "s1/s2 用过 claude 系");
        assert_eq!(anthropic["models"].as_array().unwrap().len(), 2);
        let deepseek = by_family("deepseek");
        assert_eq!(deepseek["flag"], "non_native");
        assert_eq!(deepseek["requests"], 2);
        assert_eq!(deepseek["sessions"], 2, "s2/s3 用过 deepseek 系（跨族会话各归各族）");
        let glm = by_family("glm");
        assert_eq!(glm["flag"], "non_native");
        assert_eq!(glm["sessions"], 1);
        let synthetic = by_family("synthetic");
        assert_eq!(synthetic["flag"], "api_error");
        assert_eq!(synthetic["requests"], 1);
        assert_eq!(synthetic["tokens_total"], 0);
        assert_eq!(by_family("deepseek")["request_share"], 33.3);
        let workbuddy = harnesses.iter().find(|h| h["harness"] == "workbuddy").unwrap();
        assert_eq!(workbuddy["has_baseline"], false);
        assert_eq!(workbuddy["families"][0]["flag"], "no_baseline");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
