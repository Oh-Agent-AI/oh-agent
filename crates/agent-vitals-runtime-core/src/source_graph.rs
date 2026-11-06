//! SourceGraph：增量摄取的检查点注册表（AGENT_VITALS_SOURCE_GRAPH_
//! INFRASTRUCTURE_SPEC §4-§6）——runtime 侧。
//!
//! 职责（Vite ModuleGraph 的映射）：
//! 1. **检查点管理**：`source_files` 行的 `byte_offset` / `parser_id` / `dirty`
//!    三列的读写封装——谁在什么位置处理到了哪里；
//! 2. **脏集管理**：tick 或（P2 后）watch 事件把文件标脏；调度器查询脏集并清零。
//!
//! 纯策略面（checkpoint 投影、classify 软硬判定、`SourceParser` 插件位、
//! `PARSER_VERSION`）P3 起下沉在 `agent_vitals_domain::source_graph`——执行环境
//! crate 要实现 trait，而依赖方向是 runtime → harnesses，trait 必须住在共同下游。
//! 本模块 re-export 保持 `crate::source_graph::X` 调用点不变。执行环境 wire 解释
//! 在 `agent-vitals-harnesses::parsers` 注册表（spec §11：不在 infra 里做执行环境
//! wire 解释）。
//!
//! 语义纪律（spec §1.3）：offset 只由解析成功的事务推进——半途崩溃 offset 不动，
//! 下轮重读同一段，fact_id 幂等吸收。与 outbox §1.2 同一条教训。

use rusqlite::{Connection, params};

pub use agent_vitals_domain::source_graph::{
    classify, path_hash, FileCheckpoint, Invalidation, ParseContext, ParseOutput,
    ParserDescriptor, SourceCheckpointOverride, SourceParser, FULL_PARSE_V0, PARSER_VERSION,
};

/// 读一个文件的检查点（按 harness + path_hash 查 source_files）。无行 = 首见。
pub fn read_checkpoint(
    conn: &Connection,
    harness: &str,
    hash: &str,
) -> Result<Option<FileCheckpoint>, rusqlite::Error> {
    conn.query_row(
        "SELECT source_id, harness, path_hash, size_bytes, mtime_ns,
                byte_offset, parser_id, parser_version, dirty
         FROM source_files WHERE harness = ?1 AND path_hash = ?2",
        params![harness, hash],
        |row| {
            Ok(FileCheckpoint {
                source_id: row.get(0)?,
                harness: row.get(1)?,
                path_hash: row.get(2)?,
                size_bytes: row.get::<_, i64>(3)? as u64,
                mtime_ns: row.get::<_, i64>(4)? as u64,
                byte_offset: row.get::<_, Option<i64>>(5)?.map(|v| v as u64),
                parser_id: row.get(6)?,
                parser_version: row.get(7)?,
                dirty: row.get::<_, i64>(8)? != 0,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// 推进检查点（spec §1.3 / §12：offset 只由解析成功的事务推进——调用方
/// 必须在持有与事实写入相同的 `with_immediate_txn` 里调本函数）。
pub fn advance_checkpoint(
    conn: &Connection,
    harness: &str,
    hash: &str,
    new_offset: Option<u64>,
    parser_id: &str,
    size: u64,
    mtime_ns: u64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE source_files
         SET byte_offset = ?3, parser_id = ?4, size_bytes = ?5, mtime_ns = ?6,
             dirty = 0
         WHERE harness = ?1 AND path_hash = ?2",
        params![harness, hash, new_offset.map(|v| v as i64), parser_id,
                size as i64, mtime_ns as i64],
    )?;
    Ok(())
}

/// 标脏（watch 事件或 tick 发现差异时）。幂等。
pub fn mark_dirty(
    conn: &Connection,
    harness: &str,
    hash: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE source_files SET dirty = 1 WHERE harness = ?1 AND path_hash = ?2",
        params![harness, hash],
    )?;
    Ok(())
}

/// 查询脏集（调度器用）。返回 (harness, path_hash) 列表。
pub fn dirty_set(conn: &Connection) -> Result<Vec<(String, String)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT harness, path_hash FROM source_files WHERE dirty = 1
         ORDER BY harness, path_hash",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;

    fn tmp_db(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "avd-sg-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn seed_source_file(db: &AuthorityDb, harness: &str, hash: &str) -> String {
        let source_id = format!("src-{hash}");
        db.with_immediate_txn(|conn| {
            conn.execute(
                "INSERT INTO source_files(source_id, harness, path_hash, size_bytes,
                     mtime_ns, parser_version, first_seen_at_ms, last_seen_at_ms)
                 VALUES (?1, ?2, ?3, 100, 1000, 5, 1, 1)",
                params![source_id, harness, hash],
            ).map(|_| ())
            .map_err(agent_vitals_data::authority::AuthorityError::Sqlite)
        }).unwrap();
        source_id
    }

    /// 检查点往返：写入 → 读回 → 推进 → 脏集查询 → 清零。
    #[test]
    fn checkpoint_roundtrip_and_dirty_set() {
        let path = tmp_db("roundtrip");
        let db = AuthorityDb::open(&path, 1).unwrap();
        let harness = "claude-code";
        let hash = "abc123";

        // 首见：无行
        assert!(read_checkpoint(db.conn(), harness, hash).unwrap().is_none());

        // seed + 读回
        seed_source_file(&db, harness, hash);
        let cp = read_checkpoint(db.conn(), harness, hash).unwrap().unwrap();
        assert_eq!(cp.size_bytes, 100);
        assert!(cp.byte_offset.is_none(), "首见 byte_offset 为 NULL");
        assert!(!cp.dirty);

        // 标脏 → 脏集可见
        mark_dirty(db.conn(), harness, hash).unwrap();
        let dirty = dirty_set(db.conn()).unwrap();
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].1, hash);

        // 推进检查点（模拟解析成功）→ dirty 清零、offset 写入
        advance_checkpoint(db.conn(), harness, hash, Some(200), "claude-jsonl", 200, 2000).unwrap();
        let cp2 = read_checkpoint(db.conn(), harness, hash).unwrap().unwrap();
        assert_eq!(cp2.byte_offset, Some(200));
        assert_eq!(cp2.parser_id.as_deref(), Some("claude-jsonl"));
        assert_eq!(cp2.size_bytes, 200);
        assert!(!cp2.dirty, "advance 必须清 dirty");

        // 脏集空
        assert!(dirty_set(db.conn()).unwrap().is_empty());

        drop(db);
        let _ = std::fs::remove_file(&path);
    }
}
