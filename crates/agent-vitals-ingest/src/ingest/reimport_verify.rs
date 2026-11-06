//! `agent-vitals data-reimport-verify`（spec §8.1.2 / M0 D6 / Q12）——**MCP 外**
//! 的隔离命令：把权威 `facts/*.jsonl` 在两个临时库里各重放一遍（其中一遍模拟
//! 中途崩溃 + 幂等重跑），逐执行环境 × 北京月比对聚合，证明「重跑任意月/日查询与
//! 首次成功导入完全一致，无半提交」。
//!
//! **绝不碰生产库**：facts JSONL 先复制进临时目录，临时库全部落 `tempdir`，
//! 结束即清理。只读生产的 `facts/`——JSONL 是 append-only 迁移输入，读它是安全
//! 的；复制只是把「零交互」做到零。
//!
//! 为什么是 MCP 外命令：只读 MCP 工具不做重导入（spec 决策 12）——重导入需要
//! 建库/写库，与 §9.3「MCP 进程只读」冲突。

use std::collections::BTreeMap;
use std::path::Path;

use agent_vitals_data::authority::{AuthorityDb, AuthorityError};
use serde_json::{json, Value};

/// `(harness, 北京月)` → 聚合。
type Snapshot = BTreeMap<(String, String), Bucket>;

/// 与 `ingest_service::FACT_HARNESSES` 同表（facts JSONL 按执行环境一文件，重导入按表枚举）。
const HARNESSES: [&str; 4] = crate::ingest_service::FACT_HARNESSES;
/// 北京日 = UTC + 8h。
const BJ_OFFSET_MS: i64 = 8 * 3_600 * 1_000;

/// 一个 (harness, 北京月) 的聚合指纹——`event_ts_ms` 解析不出月的归 `"undated"`。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Bucket {
    n: i64,
    uncached: i64,
    cache_read: i64,
    cache_write: i64,
    output: i64,
}

fn snapshot(db: &AuthorityDb) -> Result<Snapshot, AuthorityError> {
    let mut stmt = db.conn().prepare(
        "SELECT harness,
                COALESCE(strftime('%Y-%m',
                    datetime((event_ts_ms + ?1) / 1000, 'unixepoch')), 'undated') AS bj_month,
                COUNT(*),
                COALESCE(SUM(uncached_input_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_write_tokens), 0),
                COALESCE(SUM(output_tokens), 0)
         FROM usage_facts
         WHERE deleted_at_ms IS NULL
         GROUP BY harness, bj_month
         ORDER BY harness, bj_month",
    )?;
    let rows = stmt.query_map([BJ_OFFSET_MS], |r| {
        Ok((
            (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
            Bucket {
                n: r.get(2)?,
                uncached: r.get(3)?,
                cache_read: r.get(4)?,
                cache_write: r.get(5)?,
                output: r.get(6)?,
            },
        ))
    })?;
    rows.collect::<Result<_, _>>().map_err(AuthorityError::from)
}

/// 把 facts JSONL 迁进 `db`。`stop_after` 非空时在迁完该执行环境后**直接返回**
/// （不 `finish_run`）——模拟崩溃，让下一次 `open` 走中断清扫路径。
fn migrate(
    db: &AuthorityDb,
    facts_dir: &Path,
    now_ms: i64,
    stop_after: Option<&str>,
) -> Result<(), AuthorityError> {
    let run_id = crate::sql_sync::new_run_id("migration");
    db.begin_run(&run_id, "migration", now_ms)?;
    for harness in HARNESSES {
        let path = facts_dir.join(format!("{harness}.jsonl"));
        if !path.exists() {
            continue;
        }
        db.with_immediate_txn(|conn| {
            let w = agent_vitals_data::fact_writer_sql::SqlFactWriter::new(conn, &run_id, now_ms)?;
            w.import_facts_jsonl(harness, &path)?;
            Ok(())
        })?;
        if stop_after == Some(harness) {
            // 崩溃点：run 仍是 'running'，不 finish。
            return Ok(());
        }
    }
    db.finish_run(&run_id, "succeeded", None, None, now_ms)?;
    Ok(())
}

/// facts JSONL 拷进 `<tmp>/facts/`。缺目录不是错误（空安装）——返回是否有任何 JSONL。
fn copy_facts(data_home: &Path, tmp: &Path) -> Result<bool, AuthorityError> {
    let src = data_home.join("facts");
    let dst = tmp.join("facts");
    std::fs::create_dir_all(&dst).map_err(AuthorityError::Io)?;
    let mut any = false;
    for harness in HARNESSES {
        let s = src.join(format!("{harness}.jsonl"));
        if s.exists() {
            std::fs::copy(&s, dst.join(format!("{harness}.jsonl"))).map_err(AuthorityError::Io)?;
            any = true;
        }
    }
    Ok(any)
}

fn tmp_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "av-reimport-verify-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

/// spec §8.1.2 / Q12。返回一份机器可读报告（`verified` + 差异分类）。
pub fn run(data_home: &Path) -> Result<Value, String> {
    let now_ms = crate::clock::now_ms();
    let tmp = tmp_dir();
    let out = run_inner(data_home, &tmp, now_ms);
    let _ = std::fs::remove_dir_all(&tmp); // 无论成败都清理
    out.map_err(|e| e.to_string())
}

fn run_inner(data_home: &Path, tmp: &Path, now_ms: i64) -> Result<Value, AuthorityError> {
    std::fs::create_dir_all(tmp).map_err(AuthorityError::Io)?;
    let has_facts = copy_facts(data_home, tmp)?;
    if !has_facts {
        return Ok(json!({
            "verified": true,
            "note": "no facts/*.jsonl to re-import — nothing to verify",
            "rounds": 0,
        }));
    }
    let facts_dir = tmp.join("facts");

    // Round A：一次干净的完整迁移。
    let path_a = tmp.join("a.sqlite3");
    {
        let db = AuthorityDb::open(&path_a, now_ms)?;
        migrate(&db, &facts_dir, now_ms, None)?;
    }
    let snap_a = {
        let db = AuthorityDb::open(&path_a, now_ms)?;
        snapshot(&db)?
    };

    // Round B：迁到第一个执行环境后"崩溃"（run 停在 running）→ 重新 open（中断清扫）
    // → 完整迁移 → 再迁一遍（幂等重跑）。
    let path_b = tmp.join("b.sqlite3");
    {
        let db = AuthorityDb::open(&path_b, now_ms)?;
        migrate(&db, &facts_dir, now_ms, Some(HARNESSES[0]))?;
    }
    let swept: i64 = {
        // open 会把 running → cancelled(interrupted)；数一下证明清扫发生了。
        let db = AuthorityDb::open(&path_b, now_ms)?;
        let n = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sync_runs WHERE status = 'cancelled' AND error_code = 'interrupted'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        migrate(&db, &facts_dir, now_ms, None)?;
        migrate(&db, &facts_dir, now_ms, None)?; // 幂等重跑
        n
    };
    let snap_b = {
        let db = AuthorityDb::open(&path_b, now_ms)?;
        snapshot(&db)?
    };

    // 比对。
    let (a, b) = (&snap_a, &snap_b);
    let mut diffs: Vec<Value> = Vec::new();
    for key in a.keys().chain(b.keys()).collect::<std::collections::BTreeSet<_>>() {
        match (a.get(key), b.get(key)) {
            (Some(x), Some(y)) if x == y => {}
            (x, y) => diffs.push(json!({
                "harness": key.0,
                "bj_month": key.1,
                "round_a": x.map(bucket_json),
                "round_b": y.map(bucket_json),
            })),
        }
    }

    let facts_a: i64 = a.values().map(|x| x.n).sum();
    let facts_b: i64 = b.values().map(|x| x.n).sum();
    Ok(json!({
        "verified": diffs.is_empty(),
        "rounds": 2,
        "buckets_compared": a.len().max(b.len()),
        "facts_round_a": facts_a,
        "facts_round_b": facts_b,
        "interrupted_runs_swept": swept,
        "idempotent_reruns": 1,
        "diffs": diffs,
        "note": "round B: migrate → crash after first harness → reopen (sweep) → full migrate → migrate again (idempotent)",
    }))
}

fn bucket_json(b: &Bucket) -> Value {
    json!({
        "facts": b.n,
        "uncached_input_tokens": b.uncached,
        "cache_read_tokens": b.cache_read,
        "cache_write_tokens": b.cache_write,
        "output_tokens": b.output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(sid: &str, eid: &str, ts: &str, u: i64, o: i64) -> String {
        // 形状与真机 emitter 输出一致（无 fact_id：契约层派生）——同
        // `agent-vitals-data/tests/legacy_import_wiring.rs::live_fact`。
        json!({
            "harness": "claude-code", "machine_namespace": "default", "source_profile": "default",
            "native_session_id": sid, "source_event_id": eid,
            "observation_kind": "token_count", "event_ts_utc": ts,
            "model_id": "claude-opus-4",
            "uncached_input_tokens": u, "cache_read_tokens": 0,
            "cache_write_tokens": 0, "output_tokens": o,
        })
        .to_string()
    }

    fn seed_home() -> std::path::PathBuf {
        let home = tmp_dir().join("src");
        std::fs::create_dir_all(home.join("facts")).unwrap();
        // 两会话、跨两个北京月（08-15 03:00Z = 8月11点北京；09-01 00:30Z = 9月8:30北京）。
        std::fs::write(
            home.join("facts/claude-code.jsonl"),
            format!(
                "{}\n{}\n",
                fact("s1", "e1", "2026-08-15T03:00:00.000Z", 100, 10),
                fact("s1", "e2", "2026-09-01T00:30:00.000Z", 5, 1),
            ),
        )
        .unwrap();
        std::fs::write(
            home.join("facts/codex.jsonl"),
            format!("{}\n", {
                let mut f: Value = serde_json::from_str(&fact("s2", "e3", "2026-09-05T10:00:00.000Z", 300, 30)).unwrap();
                f["harness"] = json!("codex");
                f.to_string()
            }),
        )
        .unwrap();
        home
    }

    #[test]
    fn two_rounds_with_interrupt_and_idempotent_rerun_are_byte_equal() {
        let home = seed_home();
        let rep = run(&home).unwrap();
        assert_eq!(rep["verified"], true, "diffs: {}", rep["diffs"]);
        assert_eq!(rep["facts_round_a"], rep["facts_round_b"]);
        assert_eq!(rep["facts_round_a"], 3);
        assert!(rep["interrupted_runs_swept"].as_i64().unwrap() >= 1, "崩溃 run 必须被清扫");
        // claude 跨 8 月/9 月 → 2 桶；codex 9 月 → 1 桶。
        assert_eq!(rep["buckets_compared"], 3);
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn empty_home_verifies_vacuously() {
        let home = tmp_dir().join("empty");
        std::fs::create_dir_all(&home).unwrap();
        let rep = run(&home).unwrap();
        assert_eq!(rep["verified"], true);
        assert_eq!(rep["rounds"], 0);
        let _ = std::fs::remove_dir_all(&home);
    }
}
