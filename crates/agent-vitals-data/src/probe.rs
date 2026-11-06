//! V17 探针面的 authority 存储（路线档案 / job 行 / 逐次结果 / 判定）。
//!
//! 纪律（WORKBENCH_TEST_TAB_SPEC §6-7）：凭据永不入库——`credential_ref` 是
//! 位置引用（`ccswitch:<row>` / `env:VAR`），consent 为 NULL 时 runner 拒绝发起；
//! 判定每 run 唯一（INSERT OR IGNORE 之上再显式拒重）；状态机单向
//! （queued→running→completed/failed/budget_stopped，不允许复活）。

use rusqlite::{Connection, OptionalExtension, params};

use crate::authority::AuthorityError;

/// 路线档案（`probe_routes` 行的可编程形状）。`credential_ref` 永远是引用。
#[derive(Clone, Debug, PartialEq)]
pub struct ProbeRoute {
    pub route_id: String,
    pub label: String,
    pub harness_kind: String,
    pub endpoint_base_url: Option<String>,
    pub credential_ref: Option<String>,
    pub model_requested: String,
    pub consent_granted_at_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProbeRun {
    pub run_id: String,
    pub mode: String,
    pub route_a_id: String,
    pub route_b_id: Option<String>,
    pub suite_id: String,
    pub n_repeats: i64,
    pub status: String,
    pub currency: Option<String>,
    pub cost_budget_minor: Option<i64>,
    pub cost_estimated_minor: Option<i64>,
    pub started_at_ms: Option<i64>,
    pub finished_at_ms: Option<i64>,
}

pub fn put_route(
    conn: &Connection,
    route: &ProbeRoute,
    now_ms: i64,
) -> Result<(), AuthorityError> {
    conn.execute(
        "INSERT INTO probe_routes(route_id, label, harness_kind, endpoint_base_url,
             credential_ref, model_requested, consent_granted_at_ms, created_at_ms, updated_at_ms)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)
         ON CONFLICT(route_id) DO UPDATE SET
             label = excluded.label,
             harness_kind = excluded.harness_kind,
             endpoint_base_url = excluded.endpoint_base_url,
             credential_ref = excluded.credential_ref,
             model_requested = excluded.model_requested,
             updated_at_ms = excluded.updated_at_ms
         -- consent_granted_at_ms 刻意不在 SET 清单：授权时刻只经 grant_consent
         -- 写入，档案更新永不覆盖（首见保留）。",
        params![
            route.route_id,
            route.label,
            route.harness_kind,
            route.endpoint_base_url,
            route.credential_ref,
            route.model_requested,
            route.consent_granted_at_ms,
            now_ms,
        ],
    )?;
    Ok(())
}

/// 显式授权（一次性；工作台「测试」tab 的 consent 流落库点）。
pub fn grant_consent(
    conn: &Connection,
    route_id: &str,
    granted_at_ms: i64,
) -> Result<(), AuthorityError> {
    let changed = conn.execute(
        "UPDATE probe_routes SET consent_granted_at_ms = ?2, updated_at_ms = ?2
         WHERE route_id = ?1 AND consent_granted_at_ms IS NULL",
        params![route_id, granted_at_ms],
    )?;
    if changed == 0 {
        // 已授权过的重复授权按幂等成功处理（首见时刻保留），不存在的路线才报错。
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM probe_routes WHERE route_id = ?1",
            params![route_id],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "__probe_route_not_found__".to_string(),
            )));
        }
    }
    Ok(())
}

pub fn get_route(conn: &Connection, route_id: &str) -> Result<Option<ProbeRoute>, AuthorityError> {
    conn.query_row(
        "SELECT route_id, label, harness_kind, endpoint_base_url, credential_ref,
                model_requested, consent_granted_at_ms
         FROM probe_routes WHERE route_id = ?1",
        params![route_id],
        |row| {
            Ok(ProbeRoute {
                route_id: row.get(0)?,
                label: row.get(1)?,
                harness_kind: row.get(2)?,
                endpoint_base_url: row.get(3)?,
                credential_ref: row.get(4)?,
                model_requested: row.get(5)?,
                consent_granted_at_ms: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(AuthorityError::from)
}

pub fn create_run(conn: &Connection, run: &ProbeRun, now_ms: i64) -> Result<(), AuthorityError> {
    conn.execute(
        "INSERT INTO probe_runs(run_id, mode, route_a_id, route_b_id, suite_id,
             n_repeats, status, currency, cost_budget_minor, cost_estimated_minor,
             started_at_ms, finished_at_ms, lease_owner, created_at_ms)
         VALUES (?1,?2,?3,?4,?5,?6,'queued',?7,?8,?9,NULL,NULL,?10,?11)",
        params![
            run.run_id,
            run.mode,
            run.route_a_id,
            run.route_b_id,
            run.suite_id,
            run.n_repeats,
            run.currency,
            run.cost_budget_minor,
            run.cost_estimated_minor,
            format!("pid:{}", std::process::id()),
            now_ms,
        ],
    )?;
    Ok(())
}

/// 状态机单向迁移：只允许从 `from` 迁到 `to`（防 completed 复活）。
pub fn transition_run(
    conn: &Connection,
    run_id: &str,
    from: &str,
    to: &str,
    now_ms: i64,
) -> Result<bool, AuthorityError> {
    let changed = conn.execute(
        "UPDATE probe_runs SET status = ?3,
             started_at_ms = CASE WHEN ?3 = 'running' AND started_at_ms IS NULL THEN ?4 ELSE started_at_ms END,
             finished_at_ms = CASE WHEN ?3 IN ('completed','failed','budget_stopped') THEN ?4 ELSE finished_at_ms END
         WHERE run_id = ?1 AND status = ?2
           AND ?2 IN ('queued','running')
           AND ?3 IN ('running','completed','failed','budget_stopped')",
        params![run_id, from, to, now_ms],
    )?;
    Ok(changed == 1)
}

pub fn get_run(conn: &Connection, run_id: &str) -> Result<Option<ProbeRun>, AuthorityError> {
    conn.query_row(
        "SELECT run_id, mode, route_a_id, route_b_id, suite_id, n_repeats, status,
                currency, cost_budget_minor, cost_estimated_minor, started_at_ms, finished_at_ms
         FROM probe_runs WHERE run_id = ?1",
        params![run_id],
        |row| {
            Ok(ProbeRun {
                run_id: row.get(0)?,
                mode: row.get(1)?,
                route_a_id: row.get(2)?,
                route_b_id: row.get(3)?,
                suite_id: row.get(4)?,
                n_repeats: row.get(5)?,
                status: row.get(6)?,
                currency: row.get(7)?,
                cost_budget_minor: row.get(8)?,
                cost_estimated_minor: row.get(9)?,
                started_at_ms: row.get(10)?,
                finished_at_ms: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(AuthorityError::from)
}

#[allow(clippy::too_many_arguments)]
pub fn insert_result(
    conn: &Connection,
    result_id: &str,
    run_id: &str,
    route_id: &str,
    task_id: &str,
    repeat_idx: i64,
    outcome: &str,
    requested_model: &str,
    resolved_model: Option<&str>,
    usage: Option<(i64, i64, i64, i64)>,
    evidence_json: &str,
    session_key: Option<&str>,
) -> Result<(), AuthorityError> {
    conn.execute(
        "INSERT INTO probe_results(result_id, run_id, route_id, task_id, repeat_idx, outcome,
             uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
             requested_model, resolved_model, evidence_json, session_key)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            result_id,
            run_id,
            route_id,
            task_id,
            repeat_idx,
            outcome,
            usage.map(|u| u.0),
            usage.map(|u| u.1),
            usage.map(|u| u.2),
            usage.map(|u| u.3),
            requested_model,
            resolved_model,
            evidence_json,
            session_key,
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn put_verdict(
    conn: &Connection,
    verdict_id: &str,
    run_id: &str,
    verdict: &str,
    statistic_json: &str,
    evidence_chain_json: &str,
    confounders_json: &str,
    rule_version: &str,
    decided_at_ms: i64,
) -> Result<(), AuthorityError> {
    conn.execute(
        "INSERT INTO probe_verdicts(verdict_id, run_id, verdict, statistic_json,
             evidence_chain_json, confounders_json, rule_version, decided_at_ms)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            verdict_id,
            run_id,
            verdict,
            statistic_json,
            evidence_chain_json,
            confounders_json,
            rule_version,
            decided_at_ms,
        ],
    )?;
    Ok(())
}

/// run 的判定 + 全部结果（`probe report` 的数据面）。
pub fn run_report(conn: &Connection, run_id: &str) -> Result<Option<serde_json::Value>, AuthorityError> {
    let Some(run) = get_run(conn, run_id)? else {
        return Ok(None);
    };
    let mut results = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT result_id, route_id, task_id, repeat_idx, outcome,
                    uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                    requested_model, resolved_model, session_key
             FROM probe_results WHERE run_id = ?1 ORDER BY route_id, task_id, repeat_idx",
        )?;
        let rows = stmt.query_map(params![run_id], |row| {
            let result_id: String = row.get(0)?;
            let route_id: String = row.get(1)?;
            let task_id: String = row.get(2)?;
            let repeat_idx: i64 = row.get(3)?;
            let outcome: String = row.get(4)?;
            let input: Option<i64> = row.get(5)?;
            let cache_read: Option<i64> = row.get(6)?;
            let cache_write: Option<i64> = row.get(7)?;
            let output: Option<i64> = row.get(8)?;
            let requested: String = row.get(9)?;
            let resolved: Option<String> = row.get(10)?;
            let session_key: Option<String> = row.get(11)?;
            Ok(serde_json::json!({
                "result_id": result_id, "route_id": route_id, "task_id": task_id,
                "repeat_idx": repeat_idx, "outcome": outcome,
                "uncached_input_tokens": input, "cache_read_tokens": cache_read,
                "cache_write_tokens": cache_write, "output_tokens": output,
                "requested_model": requested, "resolved_model": resolved,
                "session_key": session_key,
            }))
        })?;
        for row in rows {
            results.push(row?);
        }
    }
    let verdict = conn
        .query_row(
            "SELECT verdict, statistic_json, evidence_chain_json, confounders_json, rule_version, decided_at_ms
             FROM probe_verdicts WHERE run_id = ?1",
            params![run_id],
            |row| {
                Ok(serde_json::json!({
                    "verdict": row.get::<_, String>(0)?,
                    "statistic_json": row.get::<_, String>(1)?,
                    "evidence_chain_json": row.get::<_, String>(2)?,
                    "confounders_json": row.get::<_, String>(3)?,
                    "rule_version": row.get::<_, String>(4)?,
                    "decided_at_ms": row.get::<_, i64>(5)?,
                }))
            },
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(Some(serde_json::json!({
        "run": {
            "run_id": run.run_id, "mode": run.mode,
            "route_a_id": run.route_a_id, "route_b_id": run.route_b_id,
            "suite_id": run.suite_id, "n_repeats": run.n_repeats,
            "status": run.status,
            "cost_budget_minor": run.cost_budget_minor,
            "started_at_ms": run.started_at_ms, "finished_at_ms": run.finished_at_ms,
        },
        "results": results,
        "verdict": verdict,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::AuthorityDb;
    use std::sync::atomic::{AtomicU64, Ordering};

    static DB_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn db() -> (AuthorityDb, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "av-probe-store-{}-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            DB_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let authority = AuthorityDb::open(&path, 1).unwrap();
        (authority, path)
    }

    fn cleanup(path: &std::path::PathBuf) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    }

    #[test]
    fn route_upsert_preserves_first_seen_consent() {
        let (authority, path) = db();
        let route = ProbeRoute {
            route_id: "rt1".into(),
            label: "官方直连".into(),
            harness_kind: "claude-code".into(),
            endpoint_base_url: None,
            credential_ref: Some("env:ANTHROPIC_AUTH_TOKEN".into()),
            model_requested: "claude-sonnet-5".into(),
            consent_granted_at_ms: None,
        };
        put_route(authority.conn(), &route, 1).unwrap();
        grant_consent(authority.conn(), "rt1", 100).unwrap();
        // 改名重放：consent 首见时刻不得被覆盖。
        let mut renamed = route.clone();
        renamed.label = "官方直连（改名）".into();
        renamed.consent_granted_at_ms = Some(999);
        put_route(authority.conn(), &renamed, 2).unwrap();
        let stored = get_route(authority.conn(), "rt1").unwrap().unwrap();
        assert_eq!(stored.label, "官方直连（改名）");
        assert_eq!(stored.consent_granted_at_ms, Some(100), "consent 首见保留");
        // 不存在的路线授权 → 报错。
        assert!(grant_consent(authority.conn(), "nope", 1).is_err());
        drop(authority);
        cleanup(&path);
    }

    #[test]
    fn run_lifecycle_is_one_way_and_verdict_is_unique() {
        let (authority, path) = db();
        let conn = authority.conn();
        put_route(conn, &ProbeRoute {
            route_id: "rt1".into(), label: "r".into(), harness_kind: "claude-code".into(),
            endpoint_base_url: None, credential_ref: None,
            model_requested: "m".into(), consent_granted_at_ms: Some(1),
        }, 1).unwrap();
        conn.execute(
            "INSERT INTO probe_suites(suite_id, version, kind, manifest_ref, manifest_sha256, rule_version, created_at_ms)
             VALUES('l0','1','l0_identity','probe/suites/l0/1/x','h','stat-v1',1)", [],
        ).unwrap();
        let run = ProbeRun {
            run_id: "run1".into(), mode: "single".into(), route_a_id: "rt1".into(),
            route_b_id: None, suite_id: "l0".into(), n_repeats: 1, status: "queued".into(),
            currency: None, cost_budget_minor: None, cost_estimated_minor: None,
            started_at_ms: None, finished_at_ms: None,
        };
        create_run(conn, &run, 1).unwrap();
        assert!(transition_run(conn, "run1", "queued", "running", 10).unwrap());
        assert!(transition_run(conn, "run1", "running", "completed", 20).unwrap());
        // completed 不得复活回 running。
        assert!(!transition_run(conn, "run1", "completed", "running", 30).unwrap());
        let stored = get_run(conn, "run1").unwrap().unwrap();
        assert_eq!(stored.status, "completed");
        assert_eq!(stored.started_at_ms, Some(10));
        assert_eq!(stored.finished_at_ms, Some(20));
        insert_result(conn, "res1", "run1", "rt1", "identity-echo", 0, "pass",
            "m", Some("m"), Some((1, 2, 3, 4)), "{}", None).unwrap();
        put_verdict(conn, "v1", "run1", "no_signal", "{}", "[]", "[]", "stat-v1", 30).unwrap();
        assert!(put_verdict(conn, "v2", "run1", "confirmed_mismatch", "{}", "[]", "[]", "stat-v1", 31).is_err(),
            "每 run 只允许一条判定");
        let report = run_report(conn, "run1").unwrap().unwrap();
        assert_eq!(report["run"]["status"], serde_json::json!("completed"));
        assert_eq!(report["results"].as_array().unwrap().len(), 1);
        assert_eq!(report["verdict"]["verdict"], serde_json::json!("no_signal"));
        assert!(run_report(conn, "no-such-run").unwrap().is_none());
        drop(authority);
        cleanup(&path);
    }
}
