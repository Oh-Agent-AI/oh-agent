//! Authority storage for the harness-neutral workflow event contract.
//!
//! This module intentionally contains no harness parsing and no product scoring.
//! Adapters produce [`agent_vitals_domain::workflow::WorkflowEvent`]; the
//! runtime supplies the source/run provenance; this module only validates and
//! persists the redacted event rows with replay-safe identity semantics.

use agent_vitals_domain::contracts::workflow::SessionExcerpt;
use agent_vitals_domain::workflow::WorkflowEvent;
use agent_vitals_domain::contracts::session_key::SessionKey;
use rusqlite::{Connection, params};

use crate::authority::AuthorityError;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkflowInsertReport {
    pub inserted: usize,
    pub duplicate: usize,
    /// 重放时**派生列与已存值不同**而被纠正的行数（emitter 升级后由
    /// `PARSER_VERSION` 重放触达；见 sql_sync 的版本演进注释）。
    pub corrected: usize,
}

/// Insert a batch of already-redacted workflow events.
///
/// All events are validated before the first SQL write.  Replay semantics are
/// three-tier since V16 + the outcome-correction fix:
/// 1. base columns stay `INSERT OR IGNORE`（同 event_id 重放不重复计、原始
///    provenance 不被改写）；
/// 2. V16 enrichment columns back-fill on conflict **only when the stored copy
///    is still NULL and the replay carries a value**（COALESCE 守卫，幂等）；
/// 3. the **derived** columns (`outcome` / `capability_version` / `duration_ms`
///    / `error_fingerprint`) are corrected whenever the replayed derivation
///    differs — the row is a derivation of the source log, so an improved
///    emitter (see `PARSER_VERSION` replay discipline in sql_sync) must reach
///    historical rows instead of leaving them at the old derivation forever.
///
/// Identity and provenance (`source_id` / `ingested_run_id` / `created_at_ms`)
/// are never rewritten by replay.
pub fn insert_events(
    conn: &Connection,
    events: &[WorkflowEvent],
    source_id: &str,
    run_id: &str,
    now_ms: i64,
) -> Result<WorkflowInsertReport, AuthorityError> {
    for event in events {
        event.validate().map_err(|reason| {
            AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                format!("__invalid_workflow_event__:{reason}"),
            ))
        })?;
    }

    let writer = crate::fact_writer_sql::SqlFactWriter::new(conn, run_id, now_ms)?;
    for event in events {
        let Some(raw_key) = event.session_key.as_deref() else {
            continue;
        };
        let key = SessionKey::from_ledger_key(raw_key).ok_or_else(|| {
            AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "__invalid_workflow_session_key__".to_string(),
            ))
        })?;
        writer.upsert_session(
            &key.harness_kind,
            &key.machine_namespace,
            &key.native_id,
            Some(&key.source_profile),
            now_ms,
        )?;
    }

    let mut report = WorkflowInsertReport::default();
    for event in events {
        // 先查存在性再分流：`ON CONFLICT DO UPDATE` 的 changes() 分不清「新插入」
        // 与「回填/纠正更新」，报表语义（inserted=新行 / corrected=派生列纠正 /
        // duplicate=重放无变化）会漂。
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM workflow_events WHERE event_id = ?1",
                params![event.event_id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if exists {
            // 回填（V16）：只补仍为 NULL 的富化列（COALESCE 保首见值），基础列与
            // provenance 一概不动；全部列已有值时 WHERE 不命中（幂等）。
            conn.execute(
                "UPDATE workflow_events SET
                     error_code = COALESCE(error_code, ?2),
                     error_class = COALESCE(error_class, ?3),
                     error_excerpt = COALESCE(error_excerpt, ?4),
                     args_excerpt = COALESCE(args_excerpt, ?5),
                     request_bytes = COALESCE(request_bytes, ?6),
                     result_bytes = COALESCE(result_bytes, ?7),
                     native_event_id = COALESCE(native_event_id, ?8),
                     source_line = COALESCE(source_line, ?9),
                     source_byte_offset = COALESCE(source_byte_offset, ?10)
                 WHERE event_id = ?1
                   AND ((error_code IS NULL AND ?2 IS NOT NULL)
                     OR (error_class IS NULL AND ?3 IS NOT NULL)
                     OR (error_excerpt IS NULL AND ?4 IS NOT NULL)
                     OR (args_excerpt IS NULL AND ?5 IS NOT NULL)
                     OR (request_bytes IS NULL AND ?6 IS NOT NULL)
                     OR (result_bytes IS NULL AND ?7 IS NOT NULL)
                     OR (native_event_id IS NULL AND ?8 IS NOT NULL)
                     OR (source_line IS NULL AND ?9 IS NOT NULL)
                     OR (source_byte_offset IS NULL AND ?10 IS NOT NULL))",
                params![
                    event.event_id,
                    event.error_code,
                    event.error_class,
                    event.error_excerpt,
                    event.args_excerpt,
                    event.request_bytes,
                    event.result_bytes,
                    event.native_event_id,
                    event.source_line,
                    event.source_byte_offset,
                ],
            )?;
            // 纠正（outcome 修复，spec §9.4-①）：派生列与重放推导不同时改写，
            // NULL 安全比较（IS NOT），值一致时是纯 no-op，不碰 provenance。
            // invocation_fingerprint 也是派生列（PARSER_VERSION 6）：它曾只编码
            // 工具名，「同一调用重复失败」于是退化成「同一工具失败过两次」；改成
            // 工具 + 参数后，存量行靠这里在重放时纠正——不进这个集合，旧行永远
            // 停在工具名级指纹，和新行混着分组。
            //
            // event_ts_ms / capability_id / 锚点同理（验收）：claude 增量轮整文件重扫后，
            // 会话末尾的 `task_finished` 每轮以同一 id、新时间重发——不纠正就永远停在首次
            // 入库的时间（真机 15/214 行落后最后一次调用超过 1 小时）；codex 的能力名曾是
            // `/bin/zsh` 这类路径，改成末段后存量行也要跟上。锚点只在新值非空时改写
            // （COALESCE），不让不产锚点的 emitter 抹掉已有坐标。
            let corrected = conn.execute(
                "UPDATE workflow_events
                 SET outcome = ?2, capability_version = ?3,
                     duration_ms = ?4, error_fingerprint = ?5,
                     invocation_fingerprint = ?6, event_ts_ms = ?7, capability_id = ?8,
                     native_event_id = COALESCE(?9, native_event_id),
                     source_line = COALESCE(?10, source_line),
                     source_byte_offset = COALESCE(?11, source_byte_offset)
                 WHERE event_id = ?1
                   AND (outcome IS NOT ?2 OR capability_version IS NOT ?3
                        OR duration_ms IS NOT ?4 OR error_fingerprint IS NOT ?5
                        OR invocation_fingerprint IS NOT ?6 OR event_ts_ms IS NOT ?7
                        OR capability_id IS NOT ?8
                        OR COALESCE(?9, native_event_id) IS NOT native_event_id
                        OR COALESCE(?10, source_line) IS NOT source_line
                        OR COALESCE(?11, source_byte_offset) IS NOT source_byte_offset)",
                params![
                    event.event_id,
                    event.outcome,
                    event.capability_version,
                    event.duration_ms,
                    event.error_fingerprint,
                    event.invocation_fingerprint,
                    event.event_ts_ms,
                    event.capability_id,
                    event.native_event_id,
                    event.source_line,
                    event.source_byte_offset,
                ],
            )?;
            if corrected == 1 {
                report.corrected += 1;
            } else {
                report.duplicate += 1;
            }
            continue;
        }
        let changed = conn.execute(
            "INSERT OR IGNORE INTO workflow_events(
                 event_id, session_key, event_ts_ms, event_type,
                 capability_kind, capability_id, capability_version, outcome,
                 duration_ms, error_fingerprint, invocation_fingerprint,
                 error_code, error_class, error_excerpt, args_excerpt,
                 request_bytes, result_bytes, native_event_id, source_line, source_byte_offset,
                 source_id, ingested_run_id, created_at_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)",
            params![
                event.event_id,
                event.session_key,
                event.event_ts_ms,
                event.event_type,
                event.capability_kind,
                event.capability_id,
                event.capability_version,
                event.outcome,
                event.duration_ms,
                event.error_fingerprint,
                event.invocation_fingerprint,
                event.error_code,
                event.error_class,
                event.error_excerpt,
                event.args_excerpt,
                event.request_bytes,
                event.result_bytes,
                event.native_event_id,
                event.source_line,
                event.source_byte_offset,
                source_id,
                run_id,
                now_ms,
            ],
        )?;
        if changed == 1 {
            report.inserted += 1;
        } else {
            report.duplicate += 1;
        }
    }
    Ok(report)
}

/// Insert task-intent excerpts (V16 `session_excerpts`).  `INSERT OR IGNORE` on
/// the `(session_key, ordinal, role)` primary key：同源重放幂等；序号/角色相同
/// 而文本不同（emitter 改版）时**保留首见**——摘录是首见证据，不追新。
pub fn insert_session_excerpts(
    conn: &Connection,
    excerpts: &[SessionExcerpt],
    source_id: &str,
    run_id: &str,
    now_ms: i64,
) -> Result<usize, AuthorityError> {
    for excerpt in excerpts {
        excerpt.validate().map_err(|reason| {
            AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                format!("__invalid_session_excerpt__:{reason}"),
            ))
        })?;
    }
    let writer = crate::fact_writer_sql::SqlFactWriter::new(conn, run_id, now_ms)?;
    let mut inserted = 0usize;
    for excerpt in excerpts {
        let key = SessionKey::from_ledger_key(&excerpt.session_key).ok_or_else(|| {
            AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "__invalid_excerpt_session_key__".to_string(),
            ))
        })?;
        writer.upsert_session(
            &key.harness_kind,
            &key.machine_namespace,
            &key.native_id,
            Some(&key.source_profile),
            now_ms,
        )?;
        let changed = conn.execute(
            "INSERT OR IGNORE INTO session_excerpts(
                 session_key, ordinal, role, excerpt, provenance,
                 native_event_id, source_id, ingested_run_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                excerpt.session_key,
                excerpt.ordinal,
                excerpt.role,
                excerpt.excerpt,
                excerpt.provenance,
                excerpt.native_event_id,
                source_id,
                run_id,
            ],
        )?;
        inserted += changed;
    }
    Ok(inserted)
}


/// Return whether the authority contains at least one workflow row for a
/// source.  This is used by coverage reporting; absence is `unavailable`, not
/// an empty successful result.
pub fn has_events(conn: &Connection) -> Result<bool, AuthorityError> {
    let present = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_events)",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(present != 0)
}

#[cfg(test)]
mod tests {
    use super::insert_events;
    use agent_vitals_domain::contracts::session_key::SessionKey;
    use agent_vitals_domain::workflow::WorkflowEvent;
    use crate::authority::AuthorityDb;
    use crate::fact_writer_sql::SqlFactWriter;

    #[test]
    fn session_excerpts_insert_is_idempotent_and_keeps_first_seen() {
        use super::insert_session_excerpts;
        use agent_vitals_domain::contracts::workflow::SessionExcerpt;
        let path = std::env::temp_dir().join(format!(
            "agent-vitals-excerpts-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let db = AuthorityDb::open(&path, 1).expect("open");
        db.begin_run("excerpt-test", "cli", 1).expect("begin");
        let source_id = db
            .with_immediate_txn(|conn| {
                crate::fact_writer_sql::SqlFactWriter::new(conn, "excerpt-test", 1)?
                    .upsert_batch_source("claude-code")
            })
            .expect("seed source");
        let session_key = SessionKey::new("claude-code", "s1", "default", "ns").ledger_key();
        let excerpt = SessionExcerpt {
            session_key: session_key.clone(),
            ordinal: 0,
            role: "user_first".to_string(),
            excerpt: "帮我修登录页".to_string(),
            provenance: "verbatim".to_string(),
            native_event_id: "uuid-1".to_string(),
        };
        let first = db.with_immediate_txn(|conn| {
            insert_session_excerpts(conn, std::slice::from_ref(&excerpt), &source_id, "excerpt-test", 2)
        }).unwrap();
        // 首见保留：同 PK 重放（即使文本变了）不覆盖、不重复。
        let mut revised = excerpt.clone();
        revised.excerpt = "改版后的文本".to_string();
        let second = db.with_immediate_txn(|conn| {
            insert_session_excerpts(conn, std::slice::from_ref(&revised), &source_id, "excerpt-test", 3)
        }).unwrap();
        assert_eq!(first, 1);
        assert_eq!(second, 0);
        let stored: String = db.conn().query_row(
            "SELECT excerpt FROM session_excerpts WHERE session_key = ?1",
            [&session_key], |row| row.get(0),
        ).unwrap();
        assert_eq!(stored, "帮我修登录页", "摘录是首见证据，不追新");
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    }

    #[test]
    fn workflow_rows_are_idempotent_and_keep_sensitive_values_out() {
        let path = std::env::temp_dir().join(format!(
            "agent-vitals-workflow-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let db = AuthorityDb::open(&path, 1).expect("open authority");
        db.begin_run("workflow-test", "cli", 1).expect("begin run");
        let source_id = db
            .with_immediate_txn(|conn| {
                let writer = SqlFactWriter::new(conn, "workflow-test", 1)?;
                let source = writer.upsert_batch_source("dsh")?;
                Ok::<_, crate::authority::AuthorityError>(source)
            })
            .expect("seed source");
        let session_key = SessionKey::new("dsh", "s1", "default", "ns").ledger_key();
        let event = WorkflowEvent {
            event_id: "workflow:test:1".to_string(),
            session_key: Some(session_key.clone()),
            event_ts_ms: 100,
            event_type: "tool_finished".to_string(),
            capability_kind: Some("tool".to_string()),
            capability_id: Some("bash".to_string()),
            capability_version: None,
            outcome: "failed".to_string(),
            duration_ms: Some(10),
            error_fingerprint: Some("fnv1a64:deadbeef".to_string()),
            invocation_fingerprint: Some("fnv1a64:cafebabe".to_string()),
            error_code: None,
            error_class: None,
            error_excerpt: None,
            args_excerpt: None,
            request_bytes: None,
            result_bytes: None,
            native_event_id: None,
            source_line: None,
            source_byte_offset: None,
        };
        let first = db
            .with_immediate_txn(|conn| {
                insert_events(conn, std::slice::from_ref(&event), &source_id, "workflow-test", 2)
            })
            .expect("insert event");
        // V16 回填路径：同 event_id 重放、携带富化值——旧行的 NULL 列被补写，
        // 原始 created_at 不动；第三次重放（值相同）不再命中 WHERE。
        let mut enriched = event.clone();
        enriched.error_excerpt = Some("Error: boom".to_string());
        enriched.native_event_id = Some("call_1".to_string());
        enriched.source_line = Some(3);
        let second = db
            .with_immediate_txn(|conn| {
                insert_events(conn, std::slice::from_ref(&enriched), &source_id, "workflow-test", 3)
            })
            .expect("backfill replay");
        let third = db
            .with_immediate_txn(|conn| {
                insert_events(conn, std::slice::from_ref(&enriched), &source_id, "workflow-test", 4)
            })
            .expect("idempotent replay");
        assert_eq!(first.inserted, 1);
        assert_eq!(second.duplicate, 1, "回填不算新插入");
        assert_eq!(third.duplicate, 1);
        let (excerpt, native, line, created): (String, String, i64, i64) = db
            .conn()
            .query_row(
                "SELECT error_excerpt, native_event_id, source_line, created_at_ms
                 FROM workflow_events WHERE event_id = 'workflow:test:1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("row");
        assert_eq!(excerpt, "Error: boom");
        assert_eq!(native, "call_1");
        assert_eq!(line, 3);
        assert_eq!(created, 2, "原始 created_at_ms 不得被回填改写");
        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM workflow_events", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 1);

        // 重放**派生列不同**的同 id 事件：纠正 outcome，provenance 保持原样
        // （emitter 升级经 PARSER_VERSION 重放触达历史行的机制，spec §9.4-①）。
        let corrected_event = WorkflowEvent { outcome: "succeeded".to_string(), ..event.clone() };
        let third = db
            .with_immediate_txn(|conn| {
                insert_events(conn, std::slice::from_ref(&corrected_event), &source_id, "workflow-test", 4)
            })
            .expect("correcting replay");
        assert_eq!(third.corrected, 1);
        assert_eq!(third.inserted, 0);
        let (outcome, source, run): (String, String, String) = db
            .conn()
            .query_row(
                "SELECT outcome, source_id, ingested_run_id FROM workflow_events WHERE event_id = ?1",
                [&event.event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("row after correction");
        assert_eq!(outcome, "succeeded", "派生列被重放纠正");
        assert_eq!(source, source_id, "provenance 不随纠正变化");
        assert_eq!(run, "workflow-test", "首次接纳的 run_id 保留");

        // 再次原样重放：无变化 → duplicate，不再计 corrected。
        let fourth = db
            .with_immediate_txn(|conn| {
                insert_events(conn, std::slice::from_ref(&corrected_event), &source_id, "workflow-test", 5)
            })
            .expect("idempotent replay");
        assert_eq!(fourth.corrected, 0);
        assert_eq!(fourth.duplicate, 1);

        // PARSER_VERSION 6：调用指纹从「工具名」改为「工具名 + 参数」，存量行
        // 靠重放纠正——不进纠正集合的话旧行永远停在工具名级指纹。
        let refingerprinted = WorkflowEvent {
            invocation_fingerprint: Some("fnv1a64:args-level".to_string()),
            ..corrected_event.clone()
        };
        let fifth = db
            .with_immediate_txn(|conn| {
                insert_events(conn, std::slice::from_ref(&refingerprinted), &source_id, "workflow-test", 6)
            })
            .expect("fingerprint correction");
        assert_eq!(fifth.corrected, 1);
        let fingerprint: Option<String> = db
            .conn()
            .query_row(
                "SELECT invocation_fingerprint FROM workflow_events WHERE event_id = ?1",
                [&event.event_id],
                |row| row.get(0),
            )
            .expect("fingerprint after correction");
        assert_eq!(fingerprint.as_deref(), Some("fnv1a64:args-level"));

        // 会话末尾的 task_finished 每轮以同一 id、新时间重发（claude 增量轮整文件重扫）：
        // 时间也是派生列，必须跟着纠正，不能停在首次入库的时刻。
        let later = WorkflowEvent { event_ts_ms: refingerprinted.event_ts_ms + 3_600_000, ..refingerprinted.clone() };
        let sixth = db
            .with_immediate_txn(|conn| insert_events(conn, std::slice::from_ref(&later), &source_id, "workflow-test", 7))
            .expect("timestamp correction");
        assert_eq!(sixth.corrected, 1);
        let ts: i64 = db
            .conn()
            .query_row("SELECT event_ts_ms FROM workflow_events WHERE event_id = ?1", [&event.event_id], |row| row.get(0))
            .expect("ts after correction");
        assert_eq!(ts, later.event_ts_ms);
        let session_count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE session_key = ?1",
                [&session_key],
                |row| row.get(0),
            )
            .expect("session count");
        assert_eq!(session_count, 1);
        db.finish_run("workflow-test", "succeeded", None, None, 4)
            .expect("finish run");
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    }
}
