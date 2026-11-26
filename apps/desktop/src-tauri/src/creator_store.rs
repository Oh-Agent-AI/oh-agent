//! Shared Creator storage and serialization utilities: the SQLite schema for
//! creator projects/changes/operations/layouts/patches/releases/playtest runs,
//! canonical JSON, digests and identifier helpers. Domain policy lives in the
//! sibling creator_* modules; nothing here decides business behavior.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
pub(crate) fn digest(text: &str) -> String { format!("sha256:{:x}", Sha256::digest(text.as_bytes())) }
pub(crate) fn bytes_digest(bytes: &[u8]) -> String { format!("sha256:{:x}", Sha256::digest(bytes)) }

pub(crate) fn canonical_json(value: &Value) -> Result<String, serde_json::Error> {
    fn write(value: &Value, output: &mut String) -> Result<(), serde_json::Error> {
        match value {
            Value::Object(object) => {
                output.push('{');
                let mut keys: Vec<&String> = object.keys().collect();
                keys.sort();
                for (index, key) in keys.iter().enumerate() {
                    if index > 0 { output.push(','); }
                    output.push_str(&serde_json::to_string(key)?);
                    output.push(':');
                    write(&object[*key], output)?;
                }
                output.push('}');
            }
            Value::Array(items) => {
                output.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 { output.push(','); }
                    write(item, output)?;
                }
                output.push(']');
            }
            _ => output.push_str(&serde_json::to_string(value)?),
        }
        Ok(())
    }
    let mut output = String::new();
    write(value, &mut output)?;
    Ok(output)
}
pub(crate) fn valid_id(value: &str) -> bool { !value.is_empty() && value.len() <= 128 && value.as_bytes()[0].is_ascii_alphanumeric() && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-')) }
pub(crate) fn only_keys(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool { object.keys().all(|key| allowed.contains(&key.as_str())) }

/// 本地日志只记阶段 + 稳定码，不写原始 SQLite 消息（可能带路径）。
fn log_store_failure(stage: &'static str, code: &'static str) {
    agent_vitals_runtime::logging::log_warn("creator_store", &format!("{stage}: {code}"));
}

/// SQLite 失败分类：让调用方区分“目录不可写 / 被锁 / 库损坏 / 迁移失败”，
/// 而不是一律 `creator_store_unavailable`。错误码稳定，详情只进本地日志。
fn map_sqlite_failure(stage: &'static str, error: &rusqlite::Error) -> &'static str {
    use rusqlite::ErrorCode;
    let code = match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => "creator_store_locked",
        Some(ErrorCode::ReadOnly | ErrorCode::PermissionDenied | ErrorCode::CannotOpen) => "creator_store_unwritable",
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => "creator_store_corrupt",
        _ if stage == "migrate" => "creator_store_migration_failed",
        _ => "creator_store_unavailable",
    };
    log_store_failure(stage, code);
    code
}

fn map_io_failure(stage: &'static str, error: &std::io::Error) -> &'static str {
    let code = match error.kind() {
        std::io::ErrorKind::PermissionDenied => "creator_store_unwritable",
        _ => "creator_store_unavailable",
    };
    log_store_failure(stage, code);
    code
}

pub(crate) fn database(home: &Path) -> Result<Connection, &'static str> {
    let directory = home.join("state/creator");
    std::fs::create_dir_all(&directory).map_err(|error| map_io_failure("create_dir", &error))?;
    let db = Connection::open(directory.join("projects.sqlite")).map_err(|error| map_sqlite_failure("open", &error))?;
    db.busy_timeout(Duration::from_secs(3)).map_err(|error| map_sqlite_failure("busy_timeout", &error))?;
    db.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS creator_projects (
            project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS creator_cities (
            city_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS creator_city_revisions (
            city_id TEXT NOT NULL, revision INTEGER NOT NULL, document_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL, PRIMARY KEY(city_id, revision)
        );
        CREATE TABLE IF NOT EXISTS creator_city_operations (
            actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, operation_hash TEXT NOT NULL,
            city_id TEXT NOT NULL, result_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(actor_id, operation_id)
        );
        CREATE TABLE IF NOT EXISTS creator_city_diagnostics (
            id INTEGER PRIMARY KEY AUTOINCREMENT, city_id TEXT NOT NULL, city_revision INTEGER NOT NULL,
            correlation_id TEXT NOT NULL, event TEXT NOT NULL, code TEXT, elapsed_ms INTEGER,
            created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS creator_city_diagnostics_city_id ON creator_city_diagnostics(city_id,id DESC);
        CREATE TABLE IF NOT EXISTS creator_changes (
            project_id TEXT NOT NULL, revision INTEGER NOT NULL, actor_id TEXT NOT NULL,
            operation_id TEXT NOT NULL, operation_hash TEXT NOT NULL, document_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL, PRIMARY KEY(project_id, revision)
        );
        CREATE TABLE IF NOT EXISTS creator_operations (
            project_id TEXT NOT NULL, actor_id TEXT NOT NULL, operation_id TEXT NOT NULL,
            operation_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(project_id, actor_id, operation_id)
        );
        CREATE TABLE IF NOT EXISTS creator_city_layouts (
            world_revision TEXT PRIMARY KEY, layout_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
            snapshot_digest TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS creator_city_layouts_v2 (
            city_id TEXT NOT NULL, city_revision INTEGER NOT NULL, world_revision TEXT NOT NULL,
            layout_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_digest TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL, PRIMARY KEY(city_id,city_revision,world_revision)
        );
        CREATE TABLE IF NOT EXISTS creator_city_patches (
            seed INTEGER PRIMARY KEY, patch_json TEXT NOT NULL, patch_digest TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS creator_releases (
            release_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
            layout_id TEXT NOT NULL, world_revision TEXT NOT NULL, snapshot_json TEXT NOT NULL,
            snapshot_digest TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, revision)
        );
        CREATE TABLE IF NOT EXISTS creator_candidates (
            candidate_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
            layout_id TEXT NOT NULL, world_revision TEXT NOT NULL, snapshot_json TEXT NOT NULL,
            snapshot_digest TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
            accepted_release_id TEXT, accepted_at_ms INTEGER,
            UNIQUE(project_id, revision)
        );
        CREATE TABLE IF NOT EXISTS creator_city_drafts (
            draft_id TEXT PRIMARY KEY, name TEXT NOT NULL, seed INTEGER NOT NULL,
            profile_json TEXT NOT NULL, content_digest TEXT NOT NULL, status TEXT NOT NULL,
            city_id TEXT, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS creator_city_archives (
            city_id TEXT PRIMARY KEY, archived_at_ms INTEGER NOT NULL,
            dependencies_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS creator_city_archive_previews (
            preview_id TEXT PRIMARY KEY, city_id TEXT NOT NULL, expected_revision INTEGER NOT NULL,
            dependencies_json TEXT NOT NULL, operation_id TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS creator_playtest_runs (
            run_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, project_id TEXT NOT NULL,
            revision INTEGER NOT NULL, studio_instance_id TEXT NOT NULL, city_instance_id TEXT,
            status TEXT NOT NULL, active_slot INTEGER UNIQUE, created_at_ms INTEGER NOT NULL,
            expires_at_ms INTEGER NOT NULL, finished_at_ms INTEGER, return_consumed INTEGER NOT NULL DEFAULT 0,
            evidence_json TEXT, failure_code TEXT,
            studio_owner_retired INTEGER NOT NULL DEFAULT 0, studio_successor_id TEXT
        );
        CREATE TABLE IF NOT EXISTS creator_content_packages (
            package_id TEXT NOT NULL, version TEXT NOT NULL, kind TEXT NOT NULL,
            content_digest TEXT NOT NULL, manifest_json TEXT NOT NULL, package_path TEXT NOT NULL,
            file_count INTEGER NOT NULL, byte_length INTEGER NOT NULL, installed_at_ms INTEGER NOT NULL,
            PRIMARY KEY(package_id, version)
        );
        CREATE TABLE IF NOT EXISTS creator_city_world_packages (
            city_id TEXT PRIMARY KEY, package_id TEXT NOT NULL, version TEXT NOT NULL,
            content_digest TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
            FOREIGN KEY(city_id) REFERENCES creator_cities(city_id),
            FOREIGN KEY(package_id, version) REFERENCES creator_content_packages(package_id, version)
        );") .map_err(|error| map_sqlite_failure("migrate", &error))?;
    let columns = {
        let mut statement = db.prepare("PRAGMA table_info(creator_playtest_runs)").map_err(|error| map_sqlite_failure("migrate", &error))?;
        let rows = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| map_sqlite_failure("migrate", &error))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| map_sqlite_failure("migrate", &error))?
    };
    if !columns.iter().any(|column| column == "evidence_json") {
        db.execute("ALTER TABLE creator_playtest_runs ADD COLUMN evidence_json TEXT", []).map_err(|error| map_sqlite_failure("migrate", &error))?;
    }
    if !columns.iter().any(|column| column == "failure_code") {
        db.execute("ALTER TABLE creator_playtest_runs ADD COLUMN failure_code TEXT", []).map_err(|error| map_sqlite_failure("migrate", &error))?;
    }
    // Studio 实例被换掉之后，取消权只交给宿主记下的继任实例，不交给任意后来者。
    // 旧库没有这两列；缺了的话新实例的 cancel 会在读列时失败，槽位继续占着。
    if !columns.iter().any(|column| column == "studio_owner_retired") {
        db.execute("ALTER TABLE creator_playtest_runs ADD COLUMN studio_owner_retired INTEGER NOT NULL DEFAULT 0", []).map_err(|error| map_sqlite_failure("migrate", &error))?;
    }
    if !columns.iter().any(|column| column == "studio_successor_id") {
        db.execute("ALTER TABLE creator_playtest_runs ADD COLUMN studio_successor_id TEXT", []).map_err(|error| map_sqlite_failure("migrate", &error))?;
    }
    // 版本偏斜审计（设计 §5.6）：operation 记录携带签发 preview 时的能力版本。
    let operation_columns = {
        let mut statement = db.prepare("PRAGMA table_info(creator_operations)").map_err(|error| map_sqlite_failure("migrate", &error))?;
        let rows = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| map_sqlite_failure("migrate", &error))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| map_sqlite_failure("migrate", &error))?
    };
    if !operation_columns.iter().any(|column| column == "capability_version") {
        db.execute("ALTER TABLE creator_operations ADD COLUMN capability_version TEXT NOT NULL DEFAULT ''", []).map_err(|error| map_sqlite_failure("migrate", &error))?;
    }
    crate::story_store::migrate_story(&db)?;
    crate::city_runtime::migrate(&db)?;
    crate::city_scheduler::migrate(&db)?;
    crate::city_game_install::migrate(&db)?;
    Ok(db)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CreatorArtifactKind { Release, Candidate }

impl CreatorArtifactKind {
    pub(crate) fn as_str(self) -> &'static str { match self { Self::Release => "release", Self::Candidate => "candidate" } }
}

pub(crate) struct CreatorArtifact {
    pub(crate) project_id: String,
    pub(crate) revision: u64,
    pub(crate) snapshot_json: String,
    pub(crate) snapshot_digest: String,
    pub(crate) kind: CreatorArtifactKind,
}

/// Playtest and asset reads share the same immutable snapshot face. Candidate and
/// Release storage remain distinct; the opaque artifact id never decides the kind.
pub(crate) fn read_creator_artifact(db: &Connection, artifact_id: &str) -> Result<CreatorArtifact, &'static str> {
    let release = db.query_row("SELECT project_id,revision,snapshot_json,snapshot_digest FROM creator_releases WHERE release_id=?1", [artifact_id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,u64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    if let Some((project_id, revision, snapshot_json, snapshot_digest)) = release {
        return Ok(CreatorArtifact { project_id, revision, snapshot_json, snapshot_digest, kind: CreatorArtifactKind::Release });
    }
    let candidate = db.query_row("SELECT project_id,revision,snapshot_json,snapshot_digest FROM creator_candidates WHERE candidate_id=?1", [artifact_id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,u64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    if let Some((project_id, revision, snapshot_json, snapshot_digest)) = candidate {
        return Ok(CreatorArtifact { project_id, revision, snapshot_json, snapshot_digest, kind: CreatorArtifactKind::Candidate });
    }
    Err("creator_release_not_found")
}

/// 启动/诊断用健康检查：只返回稳定状态，不把路径或 SQLite 原文带给调用方。
pub(crate) fn health(home: &Path) -> Value {
    match database(home) {
        Ok(db) => match db.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0)) {
            Ok(result) if result == "ok" => serde_json::json!({"status":"ok"}),
            Ok(_) => {
                agent_vitals_runtime::logging::log_warn("creator_store", "health: creator_store_corrupt");
                serde_json::json!({"status":"corrupt","code":"creator_store_corrupt"})
            }
            Err(error) => {
                let code = map_sqlite_failure("health", &error);
                serde_json::json!({"status":"failed","code":code})
            }
        },
        Err(code) => serde_json::json!({"status":"failed","code":code}),
    }
}

pub(crate) fn new_id(prefix: &str) -> Result<String, &'static str> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "creator_id_unavailable")?;
    Ok(format!("{prefix}{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
}

// 历史保留治理（T3 对照 §6.2-O1：storageCleanup/IdleCompaction 的领域适配）。
// creator_changes 的 document_json 只在提交时写入，无查询读方——当前文档在
// creator_projects、已发布版本在 creator_releases，旧 revision 的全量文档属于
// 可再生负担：审计链（revision/actor/operation_id/hash/时间）保留，内容摘要化。
// creator_operations.result_json 是幂等重试的权威回执（重试必须命中同一结果），
// 不能摘要化——只按窗口删最旧的行；64 条窗口远超现实重试场景（预览 TTL 仅 10 分钟）。
pub(crate) const CHANGE_FULL_DOCUMENTS_PER_PROJECT: usize = 8;
pub(crate) const OPERATION_RECEIPTS_PER_PROJECT_ACTOR: i64 = 64;
/// 摘要化行的占位内容：仍满足 NOT NULL 与"结构可诊断"（§9：不自动修复脏数据，
/// 这里是容量治理而非修复——digest 与幂等回执都在 creator_operations）。
pub(crate) const CHANGE_PRUNED_DOCUMENT_JSON: &str = "{}";

/// 在提交事务内顺带执行（零调度器）：commit 路径每次写历史后调用。
/// 只做容量有界化；治理失败不阻断提交主语义——下轮 commit 再试。
pub(crate) fn prune_creator_history(
    tx: &rusqlite::Transaction<'_>,
    project_id: &str,
    actor_id: &str,
) -> Result<(), &'static str> {
    // creator_changes：同项目 revision 单调递增，保留最近 N 条全量，其余摘要化。
    tx.execute(
        "UPDATE creator_changes SET document_json=?3 WHERE project_id=?1 AND revision <= (
            SELECT revision FROM creator_changes WHERE project_id=?1
            ORDER BY revision DESC LIMIT 1 OFFSET ?2)",
        params![project_id, CHANGE_FULL_DOCUMENTS_PER_PROJECT as i64, CHANGE_PRUNED_DOCUMENT_JSON],
    ).map_err(|_| "creator_store_unavailable")?;
    // creator_operations：按 (project_id, actor_id) 窗口删最旧的幂等回执。
    tx.execute(
        "DELETE FROM creator_operations WHERE project_id=?1 AND actor_id=?2 AND created_at_ms <= (
            SELECT created_at_ms FROM creator_operations WHERE project_id=?1 AND actor_id=?2
            ORDER BY created_at_ms DESC, operation_id DESC LIMIT 1 OFFSET ?3)",
        params![project_id, actor_id, OPERATION_RECEIPTS_PER_PROJECT_ACTOR],
    ).map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

#[cfg(test)]
mod content_digest_tests {
    use super::*;

    #[test]
    fn v2_manifest_canonical_digest_matches_sdk_vector() {
        let sha = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
        let manifest = serde_json::json!({"formatVersion":2,"kind":"city-world","packageId":"example.desert","version":"1.0.0",
            "sdkContractVersion":"1","minCityRuntimeVersion":"1.0.0",
            "entry":{"profile":"world/profile.json","scene":"scene/objects.json","assets":"assets/catalog.json","generatorVersion":1,"defaultSeed":42},
            "files":[
                {"path":"assets/catalog.json","mediaType":"application/json","byteLength":2,"sha256":sha},
                {"path":"scene/objects.json","mediaType":"application/json","byteLength":2,"sha256":sha},
                {"path":"world/profile.json","mediaType":"application/json","byteLength":2,"sha256":sha}
            ]});
        assert_eq!(digest(&canonical_json(&manifest).unwrap()), "sha256:432a5a6173179521080db1ae9aa71a0d49e41d27681ed2b5ce0b62ba87383682");
    }
}
