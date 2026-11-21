//! Story Project Registry（RFC V3 §12/§12.1/§12.2/§12.3，S-2+S-3）：宿主权威的
//! Story 创作项目、安装、Run 生命周期与 NPC 公共活动租约。事务形态平移
//! `city_game_install.rs`（preview/commit/receipts、CAS expectedCityRevision、
//! operationId 幂等、preview TTL、digest 绑定）；事实（状态/事件/Outbox）仍由
//! `story_store` 以显式 StoryStateScopeV1 持有——本模块只管元数据与生命周期，
//! 不建第二套事件库。ViewSession 是短命对象不落库，只在 story_runs 上记
//! last_viewed_at_ms；关闭视图从不改变 Run 状态（V3-18）。
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;
use crate::creator_store::{canonical_json, database, digest, new_id, now_ms, valid_id};

/// 结构化 JSON 预算（graph/canon 是结构化对象，不是自由文本；常量风格对齐 city_game_install）。
pub(crate) const GRAPH_BUDGET_BYTES: usize = 256 * 1024;
pub(crate) const CANON_BUDGET_BYTES: usize = 64 * 1024;
const PREVIEW_TTL_MS: u64 = 10 * 60 * 1_000;
/// 租约有界时长（RFC §12.2 r3）：续期 = 显式重取（新 traceId），不隐式顺延。
pub(crate) const LEASE_DEFAULT_TTL_MS: u64 = 60_000;
pub(crate) const LEASE_MAX_TTL_MS: u64 = 300_000;
/// run.start 返回的运行身份直接喂给 story_store 的显式 StoryStateScopeV1。
pub(crate) fn migrate(db: &Connection) -> Result<(), &'static str> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS story_projects (
        story_id TEXT PRIMARY KEY, title TEXT NOT NULL, schema_version INTEGER NOT NULL,
        story_version TEXT NOT NULL, graph_json TEXT NOT NULL, canon_json TEXT NOT NULL,
        content_digest TEXT NOT NULL, revision INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS story_installations (
        installation_id TEXT PRIMARY KEY, city_id TEXT NOT NULL, story_id TEXT NOT NULL,
        story_version TEXT NOT NULL, content_digest TEXT NOT NULL, city_revision INTEGER NOT NULL,
        status TEXT NOT NULL, installed_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        UNIQUE(city_id,story_id)
    );
    CREATE TABLE IF NOT EXISTS story_install_previews (
        preview_id TEXT PRIMARY KEY, story_id TEXT NOT NULL, story_version TEXT NOT NULL,
        target_city_id TEXT NOT NULL, expected_city_revision INTEGER NOT NULL, request_json TEXT NOT NULL,
        target_package_digest TEXT NOT NULL, can_install INTEGER NOT NULL, diagnostics_json TEXT NOT NULL,
        status TEXT NOT NULL, current_story_version TEXT, current_package_digest TEXT,
        created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS story_install_receipts (
        operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS story_runs (
        story_run_id TEXT PRIMARY KEY, player_id TEXT NOT NULL, city_id TEXT NOT NULL, story_id TEXT NOT NULL,
        status TEXT NOT NULL, last_viewed_at_ms INTEGER NOT NULL, resumed_from TEXT,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resident_activity_leases (
        city_id TEXT NOT NULL, resident_id TEXT NOT NULL, lease_id TEXT NOT NULL,
        holder_scope_json TEXT NOT NULL, holder_intent_id TEXT NOT NULL, trace_id TEXT NOT NULL,
        status TEXT NOT NULL, acquired_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY(city_id,resident_id)
    );
    CREATE TABLE IF NOT EXISTS resident_activity_lease_events (
        event_id TEXT PRIMARY KEY, city_id TEXT NOT NULL, resident_id TEXT NOT NULL, lease_id TEXT NOT NULL,
        holder_scope_json TEXT NOT NULL, holder_intent_id TEXT NOT NULL, trace_id TEXT NOT NULL,
        kind TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    );").map_err(|_| "creator_store_unavailable")
}

fn story_text<'a>(value: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    value.get(key).and_then(Value::as_str).filter(|value| valid_id(value)).ok_or("story_argument_invalid")
}
/// 标题等展示文本：非 id 字段，允许空格但拒绝控制字符并有界。
fn bounded_title(value: &Value) -> Result<&str, &'static str> {
    value.get("title").and_then(Value::as_str).filter(|title| {
        !title.trim().is_empty() && title.trim() == *title && title.chars().count() <= 200 && !title.chars().any(char::is_control)
    }).ok_or("story_argument_invalid")
}
fn bounded_version<'a>(value: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    value.get(key).and_then(Value::as_str).filter(|version| {
        !version.is_empty() && version.chars().count() <= 64 && version.starts_with(|c: char| c.is_ascii_alphanumeric())
            && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
    }).ok_or("story_argument_invalid")
}
/// graph/canon 是结构化 JSON 对象（非自由文本）：预算按 canonical 字节执行，
/// 原型污染键与 city_game_install/story_store 同样 fail-closed。
fn bounded_object<'a>(payload: &'a Value, key: &str, budget: usize) -> Result<&'a Value, &'static str> {
    let value = payload.get(key).ok_or("story_argument_invalid")?;
    if !value.is_object()
        || value.get("__proto__").is_some() || value.get("constructor").is_some() || value.get("prototype").is_some() {
        return Err("story_argument_invalid");
    }
    if canonical_json(value).map_err(|_| "story_argument_invalid")?.len() > budget { return Err("story_project_budget_exceeded"); }
    Ok(value)
}

/// 内容摘要（§12.3 r3）：canonical_json(graph+canon+meta) 的 sha256——版本供展示、
/// 摘要防「同版本换内容」与「确认后目标被替换」。
fn package_digest(story_id: &str, story_version: &str, title: &str, graph: &Value, canon: &Value) -> Result<String, &'static str> {
    let identity = json!({"kind":"story-package-v1","storyId":story_id,"storyVersion":story_version,
        "title":title,"graph":graph,"canon":canon});
    Ok(digest(&canonical_json(&identity).map_err(|_| "story_argument_invalid")?))
}

fn receipt(db: &Connection, operation: &str, hash: &str) -> Result<Option<Value>, &'static str> {
    let row = db.query_row("SELECT request_hash,result_json FROM story_install_receipts WHERE operation_id=?1", [operation],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional().map_err(|_| "creator_store_unavailable")?;
    match row {
        Some((existing, result)) if existing == hash => Ok(Some(serde_json::from_str(&result).map_err(|_| "creator_store_unavailable")?)),
        Some(_) => Err("operation_id_conflict"),
        None => Ok(None),
    }
}
fn save_receipt(tx: &rusqlite::Transaction<'_>, operation: &str, hash: &str, result: &Value, now: u64) -> Result<(), &'static str> {
    tx.execute("INSERT INTO story_install_receipts(operation_id,request_hash,result_json,created_at_ms) VALUES (?1,?2,?3,?4)",
        params![operation,hash,canonical_json(result).map_err(|_| "story_argument_invalid")?,now]).map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

/// City revision CAS 读取（与 city_game_install::current_city_revision 同语义：
/// 文档内 cityId/revision 必须与列自洽，否则按存储损坏处理）。
fn current_city_revision(db: &Connection, city_id: &str) -> Result<u64, &'static str> {
    let (revision, raw) = db.query_row("SELECT revision,document_json FROM creator_cities WHERE city_id=?1", [city_id],
        |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?))).optional().map_err(|_| "creator_store_unavailable")?
        .ok_or("creator_city_not_found")?;
    let document: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    if document.get("cityId").and_then(Value::as_str) != Some(city_id) || document.get("revision").and_then(Value::as_u64) != Some(revision) {
        return Err("creator_store_corrupt");
    }
    Ok(revision)
}

/// 项目行投影：(title, schema_version, story_version, graph_json, canon_json,
/// content_digest, revision, created_at_ms, updated_at_ms)。
type ProjectRow = (String, i64, String, String, String, String, i64, i64, i64);

fn read_project(db: &Connection, story_id: &str) -> Result<Option<ProjectRow>, &'static str> {
    db.query_row("SELECT title,schema_version,story_version,graph_json,canon_json,content_digest,revision,created_at_ms,updated_at_ms FROM story_projects WHERE story_id=?1", [story_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?,
            row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, i64>(6)?, row.get::<_, i64>(7)?, row.get::<_, i64>(8)?))
    ).optional().map_err(|_| "creator_store_unavailable")
}

/// 存储自检：从落库的 graph/canon 重算摘要，行内 digest 不符即按损坏拒绝
/// （不做静默修复——对齐 city_game_install 的文档自洽校验精神）。
fn verified_digest(story_id: &str, row: &ProjectRow) -> Result<String, &'static str> {
    let graph: Value = serde_json::from_str(&row.3).map_err(|_| "creator_store_corrupt")?;
    let canon: Value = serde_json::from_str(&row.4).map_err(|_| "creator_store_corrupt")?;
    package_digest(story_id, &row.2, &row.0, &graph, &canon)
}

pub(crate) fn project_create(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let story_id = story_text(payload, "storyId")?;
    let title = bounded_title(payload)?.to_string();
    let schema_version = payload.get("schemaVersion").and_then(Value::as_u64).filter(|version| *version == 1)
        .ok_or("story_argument_invalid")?;
    let story_version = bounded_version(payload, "storyVersion")?.to_string();
    let graph = bounded_object(payload, "graph", GRAPH_BUDGET_BYTES)?.clone();
    let canon = bounded_object(payload, "canon", CANON_BUDGET_BYTES)?.clone();
    let expected_revision = payload.get("expectedStoryRevision").and_then(Value::as_u64);
    let content_digest = package_digest(story_id, &story_version, &title, &graph, &canon)?;
    let graph_json = canonical_json(&graph).map_err(|_| "story_argument_invalid")?;
    let canon_json = canonical_json(&canon).map_err(|_| "story_argument_invalid")?;
    let now = now_ms();
    let mut db = database(home)?;
    migrate(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    // 无 receipts：CAS revision + 同内容幂等返回覆盖重试语义（创建不是安装事务，
    // 内容一致的重放不应制造冲突码）。
    let existing = read_project(&tx, story_id)?;
    let result = match existing {
        Some(row) => {
            let revision = row.6 as u64;
            if row.5 == content_digest {
                json!({"storyId":story_id,"revision":revision,"contentDigest":content_digest,"created":false,"changed":false,
                    "title":row.0,"schemaVersion":row.1,"storyVersion":row.2,
                    "createdAtMs":row.7 as u64,"updatedAtMs":row.8 as u64})
            } else {
                if expected_revision != Some(revision) { return Err("story_project_revision_conflict"); }
                let next = revision + 1;
                let changed = tx.execute("UPDATE story_projects SET title=?2,schema_version=?3,story_version=?4,graph_json=?5,canon_json=?6,content_digest=?7,revision=?8,updated_at_ms=?9 WHERE story_id=?1 AND revision=?10",
                    params![story_id,title,schema_version,story_version,graph_json,canon_json,content_digest,next,now,revision])
                    .map_err(|_| "creator_store_unavailable")?;
                if changed != 1 { return Err("story_project_revision_conflict"); }
                json!({"storyId":story_id,"revision":next,"contentDigest":content_digest,"created":false,"changed":true,
                    "title":title,"schemaVersion":schema_version,"storyVersion":story_version,
                    "createdAtMs":row.7 as u64,"updatedAtMs":now})
            }
        }
        None => {
            if expected_revision.is_some() { return Err("story_project_not_found"); }
            tx.execute("INSERT INTO story_projects(story_id,title,schema_version,story_version,graph_json,canon_json,content_digest,revision,created_at_ms,updated_at_ms)
                VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,?8)",
                params![story_id,title,schema_version,story_version,graph_json,canon_json,content_digest,now])
                .map_err(|_| "creator_store_unavailable")?;
            json!({"storyId":story_id,"revision":1,"contentDigest":content_digest,"created":true,"changed":false,
                "title":title,"schemaVersion":schema_version,"storyVersion":story_version,
                "createdAtMs":now,"updatedAtMs":now})
        }
    };
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

/// 整读有界（chunk 语义后置）：写入侧已按预算封顶，读侧整读即是安全上界。
pub(crate) fn project_read(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let story_id = story_text(payload, "storyId")?;
    let db = database(home)?;
    migrate(&db)?;
    let row = read_project(&db, story_id)?.ok_or("story_project_not_found")?;
    let graph: Value = serde_json::from_str(&row.3).map_err(|_| "creator_store_unavailable")?;
    let canon: Value = serde_json::from_str(&row.4).map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"storyId":story_id,"title":row.0,"schemaVersion":row.1,
        "storyVersion":row.2,"graph":graph,"canon":canon,"contentDigest":row.5,"revision":row.6 as u64,
        "createdAtMs":row.7 as u64,"updatedAtMs":row.8 as u64}))
}

pub(crate) fn projects_list(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let limit = payload.get("limit").and_then(Value::as_u64).filter(|limit| (1..=100).contains(limit))
        .ok_or("story_argument_invalid")?;
    let db = database(home)?;
    migrate(&db)?;
    let mut statement = db.prepare("SELECT story_id,title,schema_version,story_version,content_digest,revision,created_at_ms,updated_at_ms,LENGTH(graph_json),LENGTH(canon_json) FROM story_projects
        ORDER BY updated_at_ms DESC,story_id LIMIT ?1").map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![limit], |row| Ok(json!({"storyId":row.get::<_,String>(0)?,"title":row.get::<_,String>(1)?,
        "schemaVersion":row.get::<_,i64>(2)?,"storyVersion":row.get::<_,String>(3)?,"contentDigest":row.get::<_,String>(4)?,
        "revision":row.get::<_,i64>(5)?,"createdAtMs":row.get::<_,i64>(6)?,"updatedAtMs":row.get::<_,i64>(7)?,
        "graphBytes":row.get::<_,i64>(8)?,"canonBytes":row.get::<_,i64>(9)?})))
        .map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"projects":rows}))
}

fn active_run_count(tx: &Connection, city_id: &str, story_id: &str) -> Result<u64, &'static str> {
    tx.query_row("SELECT COUNT(*) FROM story_runs WHERE city_id=?1 AND story_id=?2 AND status IN ('active','paused')", [city_id,story_id],
        |row| row.get::<_, i64>(0)).map(|count| count.max(0) as u64).map_err(|_| "creator_store_unavailable")
}

pub(crate) fn install_preview(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let story_id = story_text(payload, "storyId")?;
    let city_id = story_text(payload, "targetCityId")?;
    let revision = payload.get("expectedCityRevision").and_then(Value::as_u64).ok_or("story_argument_invalid")?;
    let operation = story_text(payload, "operationId")?;
    let hash = digest(&canonical_json(payload).map_err(|_| "story_argument_invalid")?);
    let now = now_ms();
    let mut db = database(home)?;
    migrate(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some(result) = receipt(&tx, operation, &hash)? { return Ok(result); }
    let project = read_project(&tx, story_id)?.ok_or("story_project_not_found")?;
    let target_digest = verified_digest(story_id, &project)?;
    let story_version = project.2.clone();
    if current_city_revision(&tx, city_id)? != revision { return Err("story_install_revision_conflict"); }
    let existing = tx.query_row("SELECT story_version,content_digest FROM story_installations WHERE city_id=?1 AND story_id=?2", [city_id,story_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional().map_err(|_| "creator_store_unavailable")?;
    // V3-22：更新对旧 StoryRun 显式迁移或拒绝——存在活跃/暂停 Run 时预检即判负，
    // 带可解释诊断（先 stop/reset 再更新，绝不静默重绑定）。
    let mut diagnostics: Vec<Value> = Vec::new();
    let mut can_install = true;
    if existing.is_some() {
        let runs = active_run_count(&tx, city_id, story_id)?;
        if runs > 0 {
            can_install = false;
            diagnostics.push(json!({"code":"story_update_runs_require_reset","severity":"error",
                "message":"该 City 的此 Story 仍有活跃或暂停的 StoryRun；先显式停止或重置（新周目）再更新安装。","path":"storyRuns"}));
        }
    }
    let preview_id = new_id("story-preview-")?;
    let result = json!({"previewId":preview_id,"storyId":story_id,"storyVersion":story_version,"targetCityId":city_id,
        "expectedCityRevision":revision,"canInstall":can_install,"diagnostics":diagnostics,
        "requiresUpdateConfirmation":existing.is_some(),
        "currentStoryVersion":existing.as_ref().map(|(version,_)| version.clone()),
        "currentPackageDigest":existing.as_ref().map(|(_,digest)| digest.clone()),
        "targetPackageDigest":target_digest,"expiresAtMs":now + PREVIEW_TTL_MS});
    tx.execute("INSERT INTO story_install_previews(preview_id,story_id,story_version,target_city_id,expected_city_revision,request_json,target_package_digest,can_install,diagnostics_json,status,current_story_version,current_package_digest,created_at_ms,expires_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending',?10,?11,?12,?13)",
        params![preview_id,story_id,story_version,city_id,revision,canonical_json(payload).map_err(|_| "story_argument_invalid")?,
            target_digest,can_install,canonical_json(&json!(diagnostics)).map_err(|_| "story_argument_invalid")?,
            existing.as_ref().map(|(version,_)| version.as_str()),existing.as_ref().map(|(_,digest)| digest.as_str()),now,now + PREVIEW_TTL_MS])
        .map_err(|_| "creator_store_unavailable")?;
    save_receipt(&tx, operation, &hash, &result, now)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

fn require_update_confirmation(payload: &Value, current_version: &str, current_digest: &str,
    target_version: &str, target_digest: &str) -> Result<(), &'static str> {
    // §12.3 r3：版本供展示、摘要绑定——commit 复验四个字段全部逐字符一致。
    let confirmation = payload.get("updateConfirmation").and_then(Value::as_object).ok_or("story_install_existing")?;
    if confirmation.len() != 4
        || confirmation.get("currentStoryVersion").and_then(Value::as_str) != Some(current_version)
        || confirmation.get("currentPackageDigest").and_then(Value::as_str) != Some(current_digest)
        || confirmation.get("targetStoryVersion").and_then(Value::as_str) != Some(target_version)
        || confirmation.get("targetPackageDigest").and_then(Value::as_str) != Some(target_digest) {
        return Err("story_install_existing");
    }
    Ok(())
}

pub(crate) fn install_commit(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let preview_id = story_text(payload, "previewId")?;
    let operation = story_text(payload, "operationId")?;
    let hash = digest(&canonical_json(payload).map_err(|_| "story_argument_invalid")?);
    let now = now_ms();
    let mut db = database(home)?;
    migrate(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some(result) = receipt(&tx, operation, &hash)? { return Ok(result); }
    let preview = tx.query_row("SELECT story_id,story_version,target_city_id,expected_city_revision,request_json,target_package_digest,can_install,expires_at_ms,status,current_story_version,current_package_digest FROM story_install_previews WHERE preview_id=?1",
        [preview_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,u64>(3)?,
            row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,bool>(6)?,row.get::<_,u64>(7)?,
            row.get::<_,String>(8)?,row.get::<_,Option<String>>(9)?,row.get::<_,Option<String>>(10)?)))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_preview_not_found")?;
    let (story_id, story_version, city_id, expected_revision, _request_json, target_digest, can_install, expires_at, status, preview_current_version, preview_current_digest) = preview;
    if expires_at <= now || status != "pending" { return Err("preview_expired"); }
    if !can_install { return Err("story_install_incompatible"); }
    // 确认后目标被替换：重算当前注册表内容摘要并与预检钉住的 target 比对。
    let project = read_project(&tx, &story_id)?.ok_or("story_project_not_found")?;
    let recomputed = verified_digest(&story_id, &project)?;
    if recomputed != target_digest { return Err("story_install_digest_conflict"); }
    if current_city_revision(&tx, &city_id)? != expected_revision { return Err("story_install_revision_conflict"); }
    let existing = tx.query_row("SELECT installation_id,story_version,content_digest,status FROM story_installations WHERE city_id=?1 AND story_id=?2", [&city_id,&story_id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    // 预检与提交之间现有安装漂移（被他人更新/删除）→ 与预检快照不一致即拒绝。
    if existing.as_ref().map(|(_, version, digest, _)| (version.as_str(), digest.as_str())) != preview_current_version.as_deref().zip(preview_current_digest.as_deref()) {
        return Err(if existing.is_some() { "story_install_existing" } else { "story_installation_not_found" });
    }
    let installation_id = match existing {
        Some((installation_id, current_version, current_digest, _status)) => {
            require_update_confirmation(payload, &current_version, &current_digest, &story_version, &target_digest)?;
            // V3-22 语义复核（预检已有诊断，此处为事务内的第二道闸）：活跃 Run 存在即拒绝。
            if active_run_count(&tx, &city_id, &story_id)? > 0 { return Err("story_update_run_migration_required"); }
            let changed = tx.execute("UPDATE story_installations SET story_version=?2,content_digest=?3,city_revision=?4,status='installed',updated_at_ms=?5
                WHERE installation_id=?1 AND story_version=?6 AND content_digest=?7",
                params![installation_id,story_version,target_digest,expected_revision,now,current_version,current_digest])
                .map_err(|_| "creator_store_unavailable")?;
            if changed != 1 { return Err("story_install_existing"); }
            installation_id
        }
        None => {
            if payload.get("updateConfirmation").is_some() { return Err("story_argument_invalid"); }
            let installation_id = new_id("story-installation-")?;
            tx.execute("INSERT INTO story_installations(installation_id,city_id,story_id,story_version,content_digest,city_revision,status,installed_at_ms,updated_at_ms)
                VALUES (?1,?2,?3,?4,?5,?6,'installed',?7,?7)",
                params![installation_id,city_id,story_id,story_version,target_digest,expected_revision,now])
                .map_err(|_| "creator_store_unavailable")?;
            installation_id
        }
    };
    let changed = tx.execute("UPDATE story_install_previews SET status='committed' WHERE preview_id=?1 AND status='pending'", [preview_id])
        .map_err(|_| "creator_store_unavailable")?;
    if changed != 1 { return Err("preview_expired"); }
    let result = json!({"installationId":installation_id,"cityId":city_id,"cityRevision":expected_revision,
        "storyId":story_id,"storyVersion":story_version,"targetPackageDigest":target_digest,"status":"installed"});
    save_receipt(&tx, operation, &hash, &result, now)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

pub(crate) fn install_list(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let limit = payload.get("limit").and_then(Value::as_u64).unwrap_or(50).min(100);
    let city = payload.get("cityId").and_then(Value::as_str);
    let story = payload.get("storyId").and_then(Value::as_str);
    if city.is_some_and(|value| !valid_id(value)) || story.is_some_and(|value| !valid_id(value)) { return Err("story_argument_invalid"); }
    let db = database(home)?;
    migrate(&db)?;
    let sql = "SELECT installation_id,city_id,story_id,story_version,content_digest,city_revision,status,installed_at_ms,updated_at_ms FROM story_installations
        WHERE (?1 IS NULL OR city_id=?1) AND (?2 IS NULL OR story_id=?2) ORDER BY updated_at_ms DESC,installation_id LIMIT ?3";
    let mut statement = db.prepare(sql).map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![city,story,limit], |row| Ok(json!({"installationId":row.get::<_,String>(0)?,
        "cityId":row.get::<_,String>(1)?,"storyId":row.get::<_,String>(2)?,"storyVersion":row.get::<_,String>(3)?,
        "contentDigest":row.get::<_,String>(4)?,"cityRevision":row.get::<_,u64>(5)?,"status":row.get::<_,String>(6)?,
        "createdAtMs":row.get::<_,u64>(7)?,"installedAtMs":row.get::<_,u64>(7)?,"updatedAtMs":row.get::<_,u64>(8)?})))
        .map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"installations":rows}))
}

/// Run 生命周期（§12.1）：StoryRun 由显式 start/stop/reset 改变；ViewSession 短命
/// 不落库，start 顺带记 last_viewed_at_ms。重开默认恢复最近（active/paused），
/// 只有显式 reset（新周目）才新建并让旧 Run 停止；旧 Run 的事实留在 story_store，
/// 新 RunId 寻址不可见——本模块从不触碰 story_store 行。
fn require_installed(tx: &Connection, city_id: &str, story_id: &str) -> Result<(), &'static str> {
    let status: String = tx.query_row("SELECT status FROM story_installations WHERE city_id=?1 AND story_id=?2", [city_id,story_id],
        |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?.ok_or("story_not_installed")?;
    if status != "installed" { return Err("story_not_installed"); }
    Ok(())
}

fn latest_run_id(tx: &Connection, player_id: &str, city_id: &str, story_id: &str, include_stopped: bool) -> Result<Option<String>, &'static str> {
    let sql = if include_stopped {
        "SELECT story_run_id FROM story_runs WHERE player_id=?1 AND city_id=?2 AND story_id=?3 ORDER BY updated_at_ms DESC,created_at_ms DESC,story_run_id DESC LIMIT 1"
    } else {
        "SELECT story_run_id FROM story_runs WHERE player_id=?1 AND city_id=?2 AND story_id=?3 AND status IN ('active','paused') ORDER BY updated_at_ms DESC,created_at_ms DESC,story_run_id DESC LIMIT 1"
    };
    tx.query_row(sql, params![player_id,city_id,story_id], |row| row.get::<_, String>(0))
        .optional().map_err(|_| "creator_store_unavailable")
}

pub(crate) fn run_start(home: &Path, player_id: &str, payload: &Value) -> Result<Value, &'static str> {
    if !valid_id(player_id) { return Err("story_argument_invalid"); }
    let city_id = story_text(payload, "cityId")?;
    let story_id = story_text(payload, "storyId")?;
    let now = now_ms();
    let mut db = database(home)?;
    migrate(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    require_installed(&tx, city_id, story_id)?;
    let restored = latest_run_id(&tx, player_id, city_id, story_id, false)?;
    let (story_run_id, resumed_from, was_restored) = match restored {
        Some(story_run_id) => {
            // 恢复不重放、不重置：paused→active，active 仅刷新视图时间戳。
            let changed = tx.execute("UPDATE story_runs SET status='active',last_viewed_at_ms=?2,updated_at_ms=?2 WHERE story_run_id=?1 AND status IN ('active','paused')",
                params![story_run_id,now]).map_err(|_| "creator_store_unavailable")?;
            if changed != 1 { return Err("creator_store_unavailable"); }
            (story_run_id, None, true)
        }
        None => {
            let resumed_from = latest_run_id(&tx, player_id, city_id, story_id, true)?;
            let story_run_id = new_id("story-run-")?;
            tx.execute("INSERT INTO story_runs(story_run_id,player_id,city_id,story_id,status,last_viewed_at_ms,resumed_from,created_at_ms,updated_at_ms)
                VALUES (?1,?2,?3,?4,'active',?5,?6,?5,?5)", params![story_run_id,player_id,city_id,story_id,now,resumed_from])
                .map_err(|_| "creator_store_unavailable")?;
            (story_run_id, resumed_from, false)
        }
    };
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"storyRunId":story_run_id,"playerId":player_id,"cityId":city_id,"storyId":story_id,
        "status":"active","restored":was_restored,"resumedFrom":resumed_from,"lastViewedAtMs":now}))
}

pub(crate) fn run_stop(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let story_run_id = story_text(payload, "storyRunId")?;
    let now = now_ms();
    let mut db = database(home)?;
    migrate(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let changed = tx.execute("UPDATE story_runs SET status='stopped',updated_at_ms=?2 WHERE story_run_id=?1 AND status IN ('active','paused')",
        params![story_run_id,now]).map_err(|_| "creator_store_unavailable")?;
    let status: String = tx.query_row("SELECT status FROM story_runs WHERE story_run_id=?1", [story_run_id],
        |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?.ok_or("story_run_not_found")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"storyRunId":story_run_id,"status":"stopped","alreadyStopped":changed == 0 && status == "stopped"}))
}

pub(crate) fn run_reset(home: &Path, player_id: &str, payload: &Value) -> Result<Value, &'static str> {
    if !valid_id(player_id) { return Err("story_argument_invalid"); }
    let city_id = story_text(payload, "cityId")?;
    let story_id = story_text(payload, "storyId")?;
    let now = now_ms();
    let mut db = database(home)?;
    migrate(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    require_installed(&tx, city_id, story_id)?;
    let previous = latest_run_id(&tx, player_id, city_id, story_id, true)?;
    if let Some(previous_id) = previous.as_deref() {
        // 旧 Run 显式停止（reset 即显式生命周期变更）；其事件/记忆原样保留在
        // story_store，仅因新 storyRunId 寻址而对新周目不可见。
        tx.execute("UPDATE story_runs SET status='stopped',updated_at_ms=?2 WHERE story_run_id=?1 AND status IN ('active','paused')",
            params![previous_id,now]).map_err(|_| "creator_store_unavailable")?;
    }
    let story_run_id = new_id("story-run-")?;
    tx.execute("INSERT INTO story_runs(story_run_id,player_id,city_id,story_id,status,last_viewed_at_ms,resumed_from,created_at_ms,updated_at_ms)
        VALUES (?1,?2,?3,?4,'active',?5,?6,?5,?5)", params![story_run_id,player_id,city_id,story_id,now,previous])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"storyRunId":story_run_id,"playerId":player_id,"cityId":city_id,"storyId":story_id,
        "status":"active","restored":false,"resumedFrom":previous,"lastViewedAtMs":now}))
}

/// 租约审计事件的持有方快照（写审计行用，避免超参函数）。
struct LeaseHolder<'a> {
    city_id: &'a str,
    resident_id: &'a str,
    lease_id: &'a str,
    scope_json: &'a str,
    intent_id: &'a str,
    trace_id: &'a str,
}

/// 惰性过期回收（RFC §12.2 r3，照 city_runtime::expire_runs 模式）：读到
/// expiresAtMs 已过的活跃租约就地回收并写审计事件行，不静默顶替。
fn expire_leases(tx: &Connection, now: u64) -> Result<(), &'static str> {
    let rows = {
        let mut statement = tx.prepare("SELECT city_id,resident_id,lease_id,holder_scope_json,holder_intent_id,trace_id FROM resident_activity_leases
            WHERE status='active' AND expires_at_ms<=?1").map_err(|_| "creator_store_unavailable")?;
        let rows = statement.query_map(params![now], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
            row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?)))
            .map_err(|_| "creator_store_unavailable")?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")?
    };
    for (city_id, resident_id, lease_id, scope_json, intent_id, trace_id) in rows {
        tx.execute("UPDATE resident_activity_leases SET status='expired' WHERE city_id=?1 AND resident_id=?2 AND status='active'", params![city_id,resident_id])
            .map_err(|_| "creator_store_unavailable")?;
        let holder = LeaseHolder { city_id: &city_id, resident_id: &resident_id, lease_id: &lease_id,
            scope_json: &scope_json, intent_id: &intent_id, trace_id: &trace_id };
        record_lease_event(tx, &holder, "expired", now)?;
    }
    Ok(())
}

fn record_lease_event(tx: &Connection, holder: &LeaseHolder<'_>, kind: &str, now: u64) -> Result<(), &'static str> {
    let event_id = new_id("lease-event-")?;
    tx.execute("INSERT INTO resident_activity_lease_events(event_id,city_id,resident_id,lease_id,holder_scope_json,holder_intent_id,trace_id,kind,created_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![event_id,holder.city_id,holder.resident_id,holder.lease_id,holder.scope_json,holder.intent_id,holder.trace_id,kind,now])
        .map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

/// holder_scope 必须是 StateScopeV1 的私有子集（story/game）：公共子集
/// city-resident-public 不可持有租约（§12.2 r3），未知 kind fail-closed。
fn validated_holder_scope<'a>(payload: &'a Value, city_id: &str) -> Result<(&'a str, String), &'static str> {
    let scope = payload.get("holderScope").and_then(Value::as_object).ok_or("story_argument_invalid")?;
    let kind = scope.get("kind").and_then(Value::as_str).ok_or("story_argument_invalid")?;
    match kind {
        "story" => {
            for key in ["playerId", "storyId", "storyRunId", "cityId"] {
                scope.get(key).and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
            }
            let scope_city = scope.get("cityId").and_then(Value::as_str).ok_or("story_argument_invalid")?;
            if scope_city != city_id { return Err("story_argument_invalid"); }
        }
        "game" => {
            for key in ["playerId", "gameId", "cityId"] {
                scope.get(key).and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
            }
            let scope_city = scope.get("cityId").and_then(Value::as_str).ok_or("story_argument_invalid")?;
            if scope_city != city_id { return Err("story_argument_invalid"); }
        }
        _ => return Err("story_argument_invalid"),
    }
    if let Some(resident) = scope.get("residentId").filter(|value| !value.is_null()) {
        resident.as_str().filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
    }
    let canonical = canonical_json(&Value::Object(scope.clone())).map_err(|_| "story_argument_invalid")?;
    Ok((kind, canonical))
}

/// Intent 管线（actor_intent）的活跃 Run 校验（§12.2 单一 Intent 队列的前置闸）：
/// scope 四元组必须精确命中一行 status ∈ ('active','paused') 的 Run——paused 仍算
/// 活跃（§12.1：暂停只冻结 Scheduler，不冻结 Run 的剧情推进身份），与
/// active_run_count 的「活跃」口径一致。错误码区分三种可解释拒绝。
pub(crate) fn require_active_run(player_id: &str, city_id: &str, story_id: &str, story_run_id: &str, tx: &Connection) -> Result<(), &'static str> {
    let row = tx.query_row("SELECT player_id,city_id,story_id,status FROM story_runs WHERE story_run_id=?1", [story_run_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let Some((row_player, row_city, row_story, status)) = row else { return Err("story_run_not_found"); };
    if row_player != player_id || row_city != city_id || row_story != story_id { return Err("story_run_mismatch"); }
    if status != "active" && status != "paused" { return Err("story_run_not_active"); }
    Ok(())
}

/// Intent 管线读取当前 Story 内容摘要作为规则关联摘要（ruleSetDigest，RFC §3.2）：
/// Story Graph/Canon 是该 Story 的规则集，content_digest 即「当前规则摘要」；
/// 无项目行 → None（管线落 "none"，先于规则关联的事实）。
pub(crate) fn project_content_digest(home: &Path, story_id: &str) -> Result<Option<String>, &'static str> {
    if !valid_id(story_id) { return Err("story_argument_invalid"); }
    let db = database(home)?;
    migrate(&db)?;
    db.query_row("SELECT content_digest FROM story_projects WHERE story_id=?1", [story_id],
        |row| row.get::<_, String>(0)).optional().map_err(|_| "creator_store_unavailable")
}

pub(crate) fn lease_acquire(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let city_id = story_text(payload, "cityId")?;
    let resident_id = story_text(payload, "residentId")?;
    let holder_intent_id = story_text(payload, "holderIntentId")?;
    let trace_id = story_text(payload, "traceId")?;
    let (_kind, holder_scope_json) = validated_holder_scope(payload, city_id)?;
    let duration = payload.get("durationMs").and_then(Value::as_u64).unwrap_or(LEASE_DEFAULT_TTL_MS);
    if !(1..=LEASE_MAX_TTL_MS).contains(&duration) { return Err("story_argument_invalid"); }
    let now = now_ms();
    let mut db = database(home)?;
    migrate(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    expire_leases(&tx, now)?;
    let row = tx.query_row("SELECT lease_id,holder_scope_json,holder_intent_id,trace_id,expires_at_ms FROM resident_activity_leases
        WHERE city_id=?1 AND resident_id=?2 AND status='active'", [city_id,resident_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, String>(3)?, row.get::<_, u64>(4)?))).optional().map_err(|_| "creator_store_unavailable")?;
    if let Some((lease_id, active_scope, active_intent, active_trace, expires_at)) = row {
        // 同一持有方显式重取 = 续期（新 traceId、不隐式顺延）；不同持有方 busy，
        // 返回持有方 traceId 供退避重试（V3-19：非"后到覆盖"）。
        if active_scope == holder_scope_json {
            let renewed = new_id("lease-")?;
            let expires_at = now.saturating_add(duration);
            tx.execute("UPDATE resident_activity_leases SET lease_id=?2,holder_intent_id=?3,trace_id=?4,acquired_at_ms=?5,expires_at_ms=?6 WHERE city_id=?7 AND resident_id=?8 AND status='active'",
                params![lease_id,renewed,holder_intent_id,trace_id,now,expires_at,city_id,resident_id])
                .map_err(|_| "creator_store_unavailable")?;
            let holder = LeaseHolder { city_id, resident_id, lease_id: &renewed, scope_json: &holder_scope_json,
                intent_id: holder_intent_id, trace_id };
            record_lease_event(&tx, &holder, "renewed", now)?;
            tx.commit().map_err(|_| "creator_store_unavailable")?;
            return Ok(json!({"acquired":true,"renewed":true,"leaseId":renewed,"cityId":city_id,"residentId":resident_id,
                "holderIntentId":holder_intent_id,"traceId":trace_id,"acquiredAtMs":now,"expiresAtMs":expires_at}));
        }
        return Ok(json!({"acquired":false,"busy":true,"reason":"resident_activity_busy","leaseId":lease_id,
            "holderTraceId":active_trace,"holderIntentId":active_intent,"expiresAtMs":expires_at}));
    }
    let lease_id = new_id("lease-")?;
    let expires_at = now.saturating_add(duration);
    tx.execute("INSERT INTO resident_activity_leases(city_id,resident_id,lease_id,holder_scope_json,holder_intent_id,trace_id,status,acquired_at_ms,expires_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,'active',?7,?8) ON CONFLICT(city_id,resident_id) DO UPDATE SET
        lease_id=excluded.lease_id,holder_scope_json=excluded.holder_scope_json,holder_intent_id=excluded.holder_intent_id,
        trace_id=excluded.trace_id,status='active',acquired_at_ms=excluded.acquired_at_ms,expires_at_ms=excluded.expires_at_ms",
        params![city_id,resident_id,lease_id,holder_scope_json,holder_intent_id,trace_id,now,expires_at])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"acquired":true,"renewed":false,"leaseId":lease_id,"cityId":city_id,"residentId":resident_id,
        "holderIntentId":holder_intent_id,"traceId":trace_id,"acquiredAtMs":now,"expiresAtMs":expires_at}))
}

pub(crate) fn lease_release(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let city_id = story_text(payload, "cityId")?;
    let resident_id = story_text(payload, "residentId")?;
    let trace_id = story_text(payload, "traceId")?;
    let now = now_ms();
    let mut db = database(home)?;
    migrate(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    expire_leases(&tx, now)?;
    let row = tx.query_row("SELECT lease_id,holder_scope_json,holder_intent_id,trace_id FROM resident_activity_leases
        WHERE city_id=?1 AND resident_id=?2 AND status='active'", [city_id,resident_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let Some((lease_id, scope_json, intent_id, active_trace)) = row else {
        // 幂等释放：无活跃租约不是错误（四条释放路径各自可重放）。
        return Ok(json!({"released":false,"reason":"no_active_lease"}));
    };
    if active_trace != trace_id {
        return Ok(json!({"released":false,"reason":"resident_activity_not_holder","holderTraceId":active_trace}));
    }
    tx.execute("UPDATE resident_activity_leases SET status='released' WHERE city_id=?1 AND resident_id=?2 AND status='active'", params![city_id,resident_id])
        .map_err(|_| "creator_store_unavailable")?;
    let holder = LeaseHolder { city_id, resident_id, lease_id: &lease_id, scope_json: &scope_json,
        intent_id: &intent_id, trace_id: &active_trace };
    record_lease_event(&tx, &holder, "released", now)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"released":true,"leaseId":lease_id,"traceId":active_trace}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::creator_cities;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn home() -> std::path::PathBuf {
        static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
        let suffix = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("story-registry-{}-{}", std::process::id(), suffix))
    }

    fn story_payload(story_id: &str, version: &str, graph_seed: &str) -> Value {
        json!({"storyId":story_id,"title":"侦探线","schemaVersion":1,"storyVersion":version,
            "graph":{"nodes":[{"id":"start","kind":"beat"},{"id":"clue","kind":"beat"}],"edges":[{"from":"start","to":"clue"}],"seed":graph_seed},
            "canon":{"characters":[{"id":"resident:linxia","name":"小夏"}],"facts":["clue.found"]}})
    }

    fn create_city(home: &Path, operation: &str) -> Value {
        let profile = json!({"schemaVersion":1,"id":"desert","version":1,"biome":"arid",
            "geography":{"generator":"arid-dunes-v1","parameters":{"dunes":{"duneScale":190,"duneAmplitude":11,"orientationDeg":18}}},
            "visuals":{"themeId":"desert"}});
        creator_cities::create_city(home, "local", operation, "Story City", 42, &profile).unwrap()
    }

    fn install(home: &Path, city: &Value, story_id: &str, story_version: &str, operation: &str) -> Value {
        project_create(home, &json!({"storyId":story_id,"title":"侦探线","schemaVersion":1,"storyVersion":story_version,
            "graph":{"nodes":[],"seed":story_id},"canon":{"characters":[]}})).unwrap();
        let checked = install_preview(home, &json!({"storyId":story_id,"targetCityId":city["cityId"],
            "expectedCityRevision":city["revision"],"operationId":format!("{operation}-preview")})).unwrap();
        assert_eq!(checked["canInstall"], true, "preview should allow install: {checked}");
        install_commit(home, &json!({"previewId":checked["previewId"],"operationId":format!("{operation}-commit")})).unwrap()
    }

    fn table_count(home: &Path, table: &str) -> u64 {
        let db = database(home).unwrap();
        migrate(&db).unwrap();
        db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap()
    }

    fn story_scope(city_id: &str, story_id: &str, story_run_id: &str) -> Value {
        json!({"kind":"story","playerId":"local-profile-v1","cityId":city_id,"storyId":story_id,"storyRunId":story_run_id})
    }

    fn lease_request(city: &Value, story_id: &str, story_run_id: &str, trace: &str, intent: &str) -> Value {
        json!({"cityId":city["cityId"],"residentId":"resident:linxia","holderScope":story_scope(city["cityId"].as_str().unwrap(), story_id, story_run_id),
            "holderIntentId":intent,"traceId":trace})
    }

    #[test]
    fn story_project_create_reads_and_cas_updates() {
        let home = home();
        let first = project_create(&home, &story_payload("story.detective", "1.0.0", "seed-a")).unwrap();
        assert_eq!(first["created"], true);
        assert_eq!(first["revision"], 1);
        // 同内容重放幂等返回，不制造冲突。
        let replay = project_create(&home, &story_payload("story.detective", "1.0.0", "seed-a")).unwrap();
        assert_eq!(replay["created"], false);
        assert_eq!(replay["changed"], false);
        assert_eq!(replay["contentDigest"], first["contentDigest"]);
        assert_eq!(replay["revision"], 1);
        // 同版本不同内容必须带 CAS revision（V3-22 第一条款的注册表层防线）。
        let same_version_new_content = project_create(&home, &story_payload("story.detective", "1.0.0", "seed-b")).unwrap_err();
        assert_eq!(same_version_new_content, "story_project_revision_conflict");
        // 内容变化走 CAS 更新，revision 前进、digest 变化。
        let updated = project_create(&home, &json!({"storyId":"story.detective","title":"侦探线","schemaVersion":1,"storyVersion":"1.0.0",
            "graph":{"nodes":[{"id":"start"}],"seed":"seed-b"},"canon":{"characters":[]},"expectedStoryRevision":1})).unwrap();
        assert_eq!(updated["changed"], true);
        assert_eq!(updated["revision"], 2);
        assert_ne!(updated["contentDigest"], first["contentDigest"]);
        // stale CAS 拒绝。
        let stale = project_create(&home, &json!({"storyId":"story.detective","title":"侦探线","schemaVersion":1,"storyVersion":"1.0.0",
            "graph":{"nodes":[],"seed":"seed-c"},"canon":{},"expectedStoryRevision":1})).unwrap_err();
        assert_eq!(stale, "story_project_revision_conflict");
        let read = project_read(&home, &json!({"storyId":"story.detective"})).unwrap();
        assert_eq!(read["graph"]["nodes"][0]["id"], "start");
        assert_eq!(read["contentDigest"], updated["contentDigest"]);
        assert_eq!(project_read(&home, &json!({"storyId":"story.missing"})).unwrap_err(), "story_project_not_found");
        let listed = projects_list(&home, &json!({"limit":10})).unwrap();
        assert_eq!(listed["projects"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn story_project_budgets_are_enforced_on_structured_json() {
        let home = home();
        let big_graph = json!({"nodes":[{"id":"n","pad":"x".repeat(GRAPH_BUDGET_BYTES)}]});
        let oversized = json!({"storyId":"story.big","title":"侦探线","schemaVersion":1,"storyVersion":"1.0.0",
            "graph":big_graph,"canon":{}});
        assert_eq!(project_create(&home, &oversized).unwrap_err(), "story_project_budget_exceeded");
        let big_canon = json!({"facts":["y".repeat(CANON_BUDGET_BYTES)]});
        let oversized_canon = json!({"storyId":"story.big","title":"侦探线","schemaVersion":1,"storyVersion":"1.0.0",
            "graph":{},"canon":big_canon});
        assert_eq!(project_create(&home, &oversized_canon).unwrap_err(), "story_project_budget_exceeded");
        // graph/canon 必须是结构化对象，不能是自由文本。
        let free_text = json!({"storyId":"story.text","title":"侦探线","schemaVersion":1,"storyVersion":"1.0.0",
            "graph":"once upon a time","canon":{}});
        assert_eq!(project_create(&home, &free_text).unwrap_err(), "story_argument_invalid");
        let polluted = json!({"storyId":"story.proto","title":"侦探线","schemaVersion":1,"storyVersion":"1.0.0",
            "graph":{"__proto__":{}},"canon":{}});
        assert_eq!(project_create(&home, &polluted).unwrap_err(), "story_argument_invalid");
        assert_eq!(table_count(&home, "story_projects"), 0);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn install_preview_commit_receipts_are_idempotent_and_cas_bound() {
        let home = home();
        let city = create_city(&home, "city-create");
        project_create(&home, &json!({"storyId":"story.detective","title":"侦探线","schemaVersion":1,"storyVersion":"1.0.0",
            "graph":{"nodes":[],"seed":"a"},"canon":{}})).unwrap();
        let request = json!({"storyId":"story.detective","targetCityId":city["cityId"],
            "expectedCityRevision":city["revision"],"operationId":"story-install-preview-1"});
        let checked = crate::creator_projects::dispatch_as(&home, "local-profile-v1", "studio-test", "creator.story.install.preview", &request).unwrap();
        assert_eq!(checked["canInstall"], true);
        assert_eq!(checked["requiresUpdateConfirmation"], false);
        assert!(checked.get("ok").is_none());
        // 预检重放（同 operationId 同载荷）返回同一结果。
        assert_eq!(install_preview(&home, &request).unwrap(), checked);
        let commit_request = json!({"previewId":checked["previewId"],"operationId":"story-install-commit-1"});
        let committed = crate::creator_projects::dispatch_as(&home, "local-profile-v1", "studio-test", "creator.story.install.commit", &commit_request).unwrap();
        assert_eq!(committed["status"], "installed");
        assert_eq!(committed["cityRevision"], city["revision"]);
        // 回执重放返回同一提交结果；换 previewId 的同 operationId 冲突。
        assert_eq!(install_commit(&home, &commit_request).unwrap(), committed);
        assert_eq!(install_commit(&home, &json!({"previewId":"story-preview-other","operationId":"story-install-commit-1"})).unwrap_err(), "operation_id_conflict");
        let rows = install_list(&home, &json!({"cityId":city["cityId"]})).unwrap();
        assert_eq!(rows["installations"].as_array().unwrap().len(), 1);
        assert_eq!(rows["installations"][0]["status"], "installed");
        assert_eq!(rows["installations"][0]["contentDigest"], checked["targetPackageDigest"]);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn update_confirmation_binds_package_digests_and_rejects_mismatch() {
        let home = home();
        let city = create_city(&home, "city-create");
        install(&home, &city, "story.detective", "1.0.0", "initial");
        // v2：同版本不同内容也换摘要——digest 绑定对版本号不盲信（§12.3 r3）。
        let updated_project = project_create(&home, &json!({"storyId":"story.detective","title":"侦探线","schemaVersion":1,"storyVersion":"2.0.0",
            "graph":{"nodes":[{"id":"finale"}],"seed":"b"},"canon":{"facts":["finale"]},"expectedStoryRevision":1})).unwrap();
        let checked = install_preview(&home, &json!({"storyId":"story.detective","targetCityId":city["cityId"],
            "expectedCityRevision":city["revision"],"operationId":"update-preview"})).unwrap();
        assert_eq!(checked["requiresUpdateConfirmation"], true);
        assert_eq!(checked["currentStoryVersion"], "1.0.0");
        assert_eq!(checked["targetPackageDigest"], updated_project["contentDigest"]);
        assert!(checked["currentPackageDigest"].as_str().is_some());
        let current_digest = checked["currentPackageDigest"].as_str().unwrap().to_string();
        let target_digest = checked["targetPackageDigest"].as_str().unwrap().to_string();
        // 缺确认拒绝。
        assert_eq!(install_commit(&home, &json!({"previewId":checked["previewId"],"operationId":"update-missing"})).unwrap_err(), "story_install_existing");
        // 版本对但摘要错（同版本换内容 / 确认后目标被替换）拒绝。
        let wrong_digest = json!({"previewId":checked["previewId"],"operationId":"update-wrong-digest",
            "updateConfirmation":{"currentStoryVersion":"1.0.0","currentPackageDigest":"sha256:deadbeef",
                "targetStoryVersion":"2.0.0","targetPackageDigest":target_digest}});
        assert_eq!(install_commit(&home, &wrong_digest).unwrap_err(), "story_install_existing");
        // 字段数不符（旧的两字段确认形态）拒绝。
        assert_eq!(install_commit(&home, &json!({"previewId":checked["previewId"],"operationId":"update-short",
            "updateConfirmation":{"currentStoryVersion":"1.0.0","targetStoryVersion":"2.0.0"}})).unwrap_err(), "story_install_existing");
        // 正确绑定（currentPackageDigest→targetPackageDigest）才放行。
        let confirmed = json!({"previewId":checked["previewId"],"operationId":"update-commit",
            "updateConfirmation":{"currentStoryVersion":"1.0.0","currentPackageDigest":current_digest,
                "targetStoryVersion":"2.0.0","targetPackageDigest":target_digest}});
        let updated = install_commit(&home, &confirmed).unwrap();
        assert_eq!(updated["storyVersion"], "2.0.0");
        assert_eq!(updated["targetPackageDigest"], target_digest);
        assert_eq!(install_commit(&home, &confirmed).unwrap(), updated);
        // 已提交的 preview 重放 → 过期。
        assert_eq!(install_commit(&home, &json!({"previewId":checked["previewId"],"operationId":"update-replay",
            "updateConfirmation":{"currentStoryVersion":"1.0.0","currentPackageDigest":current_digest,
                "targetStoryVersion":"2.0.0","targetPackageDigest":target_digest}})).unwrap_err(), "preview_expired");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn update_refuses_while_story_runs_are_active_and_after_content_swap() {
        let home = home();
        let city = create_city(&home, "city-create");
        install(&home, &city, "story.detective", "1.0.0", "initial");
        run_start(&home, "local-profile-v1", &json!({"cityId":city["cityId"],"storyId":"story.detective"})).unwrap();
        project_create(&home, &json!({"storyId":"story.detective","title":"侦探线","schemaVersion":1,"storyVersion":"2.0.0",
            "graph":{"nodes":[],"seed":"b"},"canon":{},"expectedStoryRevision":1})).unwrap();
        let checked = install_preview(&home, &json!({"storyId":"story.detective","targetCityId":city["cityId"],
            "expectedCityRevision":city["revision"],"operationId":"update-preview"})).unwrap();
        assert_eq!(checked["canInstall"], false);
        assert_eq!(checked["diagnostics"][0]["code"], "story_update_runs_require_reset");
        let blocked = json!({"previewId":checked["previewId"],"operationId":"update-commit",
            "updateConfirmation":{"currentStoryVersion":"1.0.0","currentPackageDigest":checked["currentPackageDigest"],
                "targetStoryVersion":"2.0.0","targetPackageDigest":checked["targetPackageDigest"]}});
        assert_eq!(install_commit(&home, &blocked).unwrap_err(), "story_install_incompatible");
        // 显式停止 Run 后需要重新预检（预检结论是提交闸的权威）：新预检可安装并可提交
        //（V3-22：显式迁移或拒绝，此处为拒绝路径的解除）。
        let runs = database(&home).unwrap().query_row("SELECT story_run_id FROM story_runs WHERE status='active'", [], |row| row.get::<_, String>(0)).unwrap();
        run_stop(&home, &json!({"storyRunId":runs})).unwrap();
        let rechecked = install_preview(&home, &json!({"storyId":"story.detective","targetCityId":city["cityId"],
            "expectedCityRevision":city["revision"],"operationId":"update-preview-2"})).unwrap();
        assert_eq!(rechecked["canInstall"], true);
        let confirmed = json!({"previewId":rechecked["previewId"],"operationId":"update-commit-2",
            "updateConfirmation":{"currentStoryVersion":"1.0.0","currentPackageDigest":rechecked["currentPackageDigest"],
                "targetStoryVersion":"2.0.0","targetPackageDigest":rechecked["targetPackageDigest"]}});
        assert_eq!(install_commit(&home, &confirmed).unwrap()["status"], "installed");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn commit_rejects_when_target_content_changes_after_confirmation() {
        let home = home();
        let city = create_city(&home, "city-create");
        install(&home, &city, "story.detective", "1.0.0", "initial");
        project_create(&home, &json!({"storyId":"story.detective","title":"侦探线","schemaVersion":1,"storyVersion":"2.0.0",
            "graph":{"nodes":[],"seed":"b"},"canon":{},"expectedStoryRevision":1})).unwrap();
        let checked = install_preview(&home, &json!({"storyId":"story.detective","targetCityId":city["cityId"],
            "expectedCityRevision":city["revision"],"operationId":"update-preview"})).unwrap();
        // 预检之后、确认提交之前：项目内容被替换（同版本新内容，CAS 前进）。
        project_create(&home, &json!({"storyId":"story.detective","title":"侦探线","schemaVersion":1,"storyVersion":"2.0.0",
            "graph":{"nodes":[{"id":"rewritten"}],"seed":"c"},"canon":{},"expectedStoryRevision":2})).unwrap();
        let confirmed = json!({"previewId":checked["previewId"],"operationId":"update-commit",
            "updateConfirmation":{"currentStoryVersion":"1.0.0","currentPackageDigest":checked["currentPackageDigest"],
                "targetStoryVersion":"2.0.0","targetPackageDigest":checked["targetPackageDigest"]}});
        assert_eq!(install_commit(&home, &confirmed).unwrap_err(), "story_install_digest_conflict");
        assert_eq!(table_count(&home, "story_installations"), 1);
        let db = database(&home).unwrap();
        let version: String = db.query_row("SELECT story_version FROM story_installations", [], |row| row.get(0)).unwrap();
        assert_eq!(version, "1.0.0");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn expired_preview_and_revision_conflict_leave_no_partial_install() {
        let home = home();
        let city = create_city(&home, "city-create");
        project_create(&home, &json!({"storyId":"story.detective","title":"侦探线","schemaVersion":1,"storyVersion":"1.0.0",
            "graph":{"nodes":[],"seed":"a"},"canon":{}})).unwrap();
        let checked = install_preview(&home, &json!({"storyId":"story.detective","targetCityId":city["cityId"],
            "expectedCityRevision":city["revision"],"operationId":"expired-preview"})).unwrap();
        database(&home).unwrap().execute("UPDATE story_install_previews SET expires_at_ms=0 WHERE preview_id=?1", [checked["previewId"].as_str().unwrap()]).unwrap();
        assert_eq!(install_commit(&home, &json!({"previewId":checked["previewId"],"operationId":"expired-commit"})).unwrap_err(), "preview_expired");
        assert_eq!(table_count(&home, "story_installations"), 0);
        let db = database(&home).unwrap();
        let commit_receipts: u64 = db.query_row("SELECT COUNT(*) FROM story_install_receipts WHERE operation_id='expired-commit'", [], |row| row.get(0)).unwrap();
        assert_eq!(commit_receipts, 0);
        drop(db);
        // City revision CAS 冲突：预检后 City 前进，commit 拒绝且零部分安装。
        let checked = install_preview(&home, &json!({"storyId":"story.detective","targetCityId":city["cityId"],
            "expectedCityRevision":city["revision"],"operationId":"revision-preview"})).unwrap();
        let city_id = city["cityId"].as_str().unwrap();
        let next_revision = city["revision"].as_u64().unwrap() + 1;
        let mut document = creator_cities::read_city(&home, city_id).unwrap();
        document["revision"] = json!(next_revision);
        let db = database(&home).unwrap();
        db.execute("UPDATE creator_cities SET revision=?2,document_json=?3 WHERE city_id=?1",
            params![city_id,next_revision,canonical_json(&document).unwrap()]).unwrap();
        drop(db);
        assert_eq!(install_commit(&home, &json!({"previewId":checked["previewId"],"operationId":"revision-commit"})).unwrap_err(), "story_install_revision_conflict");
        assert_eq!(table_count(&home, "story_installations"), 0);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn installations_are_isolated_per_city_and_list_filters_apply() {
        let home = home();
        let first_city = create_city(&home, "city-first");
        let second_city = create_city(&home, "city-second");
        let first = install(&home, &first_city, "story.detective", "1.0.0", "first");
        let second = install(&home, &second_city, "story.detective", "1.0.0", "second");
        assert_ne!(first["installationId"], second["installationId"]);
        let only_first = install_list(&home, &json!({"cityId":first_city["cityId"]})).unwrap();
        assert_eq!(only_first["installations"].as_array().unwrap().len(), 1);
        assert_eq!(only_first["installations"][0]["cityId"], first_city["cityId"]);
        let by_story = install_list(&home, &json!({"storyId":"story.detective"})).unwrap();
        assert_eq!(by_story["installations"].as_array().unwrap().len(), 2);
        let limited = install_list(&home, &json!({"limit":1})).unwrap();
        assert_eq!(limited["installations"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn run_start_restores_latest_and_explicit_stop_resets_open_a_new_run() {
        let home = home();
        let city = create_city(&home, "city-create");
        install(&home, &city, "story.detective", "1.0.0", "initial");
        let player = "local-profile-v1";
        let first = run_start(&home, player, &json!({"cityId":city["cityId"],"storyId":"story.detective"})).unwrap();
        assert_eq!(first["restored"], false);
        assert!(first["resumedFrom"].is_null());
        let first_run = first["storyRunId"].as_str().unwrap().to_string();
        // 重开恢复原 Run（V3-18）：不新建。
        let second = run_start(&home, player, &json!({"cityId":city["cityId"],"storyId":"story.detective"})).unwrap();
        assert_eq!(second["restored"], true);
        assert_eq!(second["storyRunId"], first["storyRunId"]);
        // 显式 stop 后 start 新建（旧 Run 保留）。
        assert_eq!(run_stop(&home, &json!({"storyRunId":first_run})).unwrap()["alreadyStopped"], false);
        let stopped_replay = run_stop(&home, &json!({"storyRunId":first_run})).unwrap();
        assert_eq!(stopped_replay["alreadyStopped"], true);
        let after_stop = run_start(&home, player, &json!({"cityId":city["cityId"],"storyId":"story.detective"})).unwrap();
        assert_eq!(after_stop["restored"], false);
        assert_eq!(after_stop["resumedFrom"], first_run);
        let fresh_run = after_stop["storyRunId"].as_str().unwrap().to_string();
        // reset（新周目）：旧 Run 停止、resumed_from 链指向旧 Run，新 storyRunId。
        let reset = run_reset(&home, player, &json!({"cityId":city["cityId"],"storyId":"story.detective"})).unwrap();
        assert_eq!(reset["restored"], false);
        assert_eq!(reset["resumedFrom"], fresh_run);
        assert_ne!(reset["storyRunId"], fresh_run);
        let db = database(&home).unwrap();
        let old_status: String = db.query_row("SELECT status FROM story_runs WHERE story_run_id=?1", [fresh_run], |row| row.get(0)).unwrap();
        assert_eq!(old_status, "stopped");
        let statuses: Vec<String> = db.prepare("SELECT status FROM story_runs ORDER BY created_at_ms").unwrap()
            .query_map([], |row| row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(statuses, vec!["stopped".to_string(), "stopped".to_string(), "active".to_string()]);
        // 未安装的 Story 不能开 Run。
        assert_eq!(run_start(&home, player, &json!({"cityId":city["cityId"],"storyId":"story.missing"})).unwrap_err(), "story_not_installed");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn run_start_is_isolated_per_player() {
        let home = home();
        let city = create_city(&home, "city-create");
        install(&home, &city, "story.detective", "1.0.0", "initial");
        let mine = run_start(&home, "local-profile-v1", &json!({"cityId":city["cityId"],"storyId":"story.detective"})).unwrap();
        let other = run_start(&home, "local-profile-v2", &json!({"cityId":city["cityId"],"storyId":"story.detective"})).unwrap();
        assert_ne!(mine["storyRunId"], other["storyRunId"]);
        assert_eq!(other["restored"], false, "另一个玩家的 Run 不可恢复（V3-20 scope 隔离）");
        let paused = database(&home).unwrap();
        paused.execute("UPDATE story_runs SET status='paused' WHERE story_run_id=?1",
            [mine["storyRunId"].as_str().unwrap()]).unwrap();
        drop(paused);
        let resumed = run_start(&home, "local-profile-v1", &json!({"cityId":city["cityId"],"storyId":"story.detective"})).unwrap();
        assert_eq!(resumed["storyRunId"], mine["storyRunId"], "paused 的最近 Run 恢复为 active");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn lease_first_acquirer_wins_and_second_is_busy_with_holder_trace() {
        let home = home();
        let city = create_city(&home, "city-create");
        install(&home, &city, "story.detective", "1.0.0", "detective");
        install(&home, &city, "story.romance", "1.0.0", "romance");
        let city_id = city["cityId"].as_str().unwrap();
        // V3-19 单测级：两条 acquire 顺序决定归属，后者 busy 且带持有方 traceId。
        let first = lease_acquire(&home, &lease_request(&city, "story.detective", "run-detective", "trace-a", "intent-a")).unwrap();
        assert_eq!(first["acquired"], true);
        assert_eq!(first["renewed"], false);
        let second = lease_acquire(&home, &json!({"cityId":city_id,"residentId":"resident:linxia",
            "holderScope":story_scope(city_id, "story.romance", "run-romance"),
            "holderIntentId":"intent-b","traceId":"trace-b"})).unwrap();
        assert_eq!(second["acquired"], false);
        assert_eq!(second["busy"], true);
        assert_eq!(second["reason"], "resident_activity_busy");
        assert_eq!(second["holderTraceId"], "trace-a");
        assert_eq!(second["holderIntentId"], "intent-a");
        // 不同 Resident 互不影响。
        let other_resident = lease_acquire(&home, &json!({"cityId":city_id,"residentId":"resident:chen",
            "holderScope":story_scope(city_id, "story.romance", "run-romance"),
            "holderIntentId":"intent-c","traceId":"trace-c"})).unwrap();
        assert_eq!(other_resident["acquired"], true);
        // 公共子集不可持有（§12.2 r3）；未知 kind fail-closed；scope 的 cityId 不匹配拒绝。
        let public_holder = json!({"cityId":city_id,"residentId":"resident:chen","holderScope":
            json!({"kind":"city-resident-public","cityId":city_id,"residentId":"resident:chen"}),
            "holderIntentId":"intent-d","traceId":"trace-d"});
        assert_eq!(lease_acquire(&home, &public_holder).unwrap_err(), "story_argument_invalid");
        let unknown_kind = json!({"cityId":city_id,"residentId":"resident:chen",
            "holderScope":json!({"kind":"unknown","cityId":city_id}),"holderIntentId":"intent-e","traceId":"trace-e"});
        assert_eq!(lease_acquire(&home, &unknown_kind).unwrap_err(), "story_argument_invalid");
        let wrong_city = json!({"cityId":city_id,"residentId":"resident:chen",
            "holderScope":story_scope("city-other", "story.romance", "run-romance"),
            "holderIntentId":"intent-f","traceId":"trace-f"});
        assert_eq!(lease_acquire(&home, &wrong_city).unwrap_err(), "story_argument_invalid");
        // 超时长预算拒绝。
        let long = json!({"cityId":city_id,"residentId":"resident:chen","holderScope":story_scope(city_id, "story.romance", "run-romance"),
            "holderIntentId":"intent-g","traceId":"trace-g","durationMs":LEASE_MAX_TTL_MS + 1});
        assert_eq!(lease_acquire(&home, &long).unwrap_err(), "story_argument_invalid");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn lease_release_is_idempotent_and_holders_only() {
        let home = home();
        let city = create_city(&home, "city-create");
        install(&home, &city, "story.detective", "1.0.0", "detective");
        let city_id = city["cityId"].as_str().unwrap();
        lease_acquire(&home, &lease_request(&city, "story.detective", "run-a", "trace-a", "intent-a")).unwrap();
        // 非持有方释放不动别人的租约。
        let foreign = lease_release(&home, &json!({"cityId":city_id,"residentId":"resident:linxia","traceId":"trace-b"})).unwrap();
        assert_eq!(foreign["released"], false);
        assert_eq!(foreign["reason"], "resident_activity_not_holder");
        assert_eq!(foreign["holderTraceId"], "trace-a");
        assert_eq!(table_count(&home, "resident_activity_lease_events"), 0);
        // 持有方释放（取消/正常完成走同一条显式路径）。
        let released = lease_release(&home, &json!({"cityId":city_id,"residentId":"resident:linxia","traceId":"trace-a"})).unwrap();
        assert_eq!(released["released"], true);
        assert_eq!(released["traceId"], "trace-a");
        // 重放幂等：无活跃租约不是错误。
        let replay = lease_release(&home, &json!({"cityId":city_id,"residentId":"resident:linxia","traceId":"trace-a"})).unwrap();
        assert_eq!(replay["released"], false);
        assert_eq!(replay["reason"], "no_active_lease");
        // 释放后其他人可立即获得。
        let next = lease_acquire(&home, &json!({"cityId":city_id,"residentId":"resident:linxia",
            "holderScope":story_scope(city_id, "story.detective", "run-b"),
            "holderIntentId":"intent-c","traceId":"trace-c"})).unwrap();
        assert_eq!(next["acquired"], true);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn lease_expires_lazily_with_audit_rows_and_holder_may_renew_before_expiry() {
        let home = home();
        let city = create_city(&home, "city-create");
        install(&home, &city, "story.detective", "1.0.0", "detective");
        let city_id = city["cityId"].as_str().unwrap();
        lease_acquire(&home, &lease_request(&city, "story.detective", "run-a", "trace-a", "intent-a")).unwrap();
        // 持有方过期前显式重取 = 续期（新 traceId，不隐式顺延——同 holder scope）。
        let renewed = lease_acquire(&home, &json!({"cityId":city_id,"residentId":"resident:linxia","holderScope":story_scope(city_id, "story.detective", "run-a"),
            "holderIntentId":"intent-b","traceId":"trace-b"})).unwrap();
        assert_eq!(renewed["acquired"], true);
        assert_eq!(renewed["renewed"], true);
        assert_eq!(renewed["traceId"], "trace-b");
        // 租约过期（回拨 expires_at 模拟时钟推进）：下一个仲裁路径惰性回收 + 审计事件行。
        let db = database(&home).unwrap();
        db.execute("UPDATE resident_activity_leases SET expires_at_ms=0 WHERE city_id=?1 AND resident_id=?2", [city_id,"resident:linxia"]).unwrap();
        drop(db);
        let after = lease_acquire(&home, &json!({"cityId":city_id,"residentId":"resident:linxia",
            "holderScope":story_scope(city_id, "story.detective", "run-a"),
            "holderIntentId":"intent-c","traceId":"trace-c"})).unwrap();
        assert_eq!(after["acquired"], true, "过期租约被惰性回收，不产生永久 resident_activity_busy（V3-19 r3）");
        let db = database(&home).unwrap();
        let statuses: Vec<String> = db.prepare("SELECT kind FROM resident_activity_lease_events ORDER BY created_at_ms").unwrap()
            .query_map([], |row| row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
        assert!(statuses.contains(&"renewed".to_string()));
        assert!(statuses.contains(&"expired".to_string()));
        let lease_status: String = db.query_row("SELECT status FROM resident_activity_leases WHERE city_id=?1 AND resident_id=?2", [city_id,"resident:linxia"], |row| row.get(0)).unwrap();
        assert_eq!(lease_status, "active");
        drop(db);
        // 过期持有方的旧 traceId 释放返回非持有方（幂等，不动新持有方）。
        let stale_release = lease_release(&home, &json!({"cityId":city_id,"residentId":"resident:linxia","traceId":"trace-b"})).unwrap();
        assert_eq!(stale_release["released"], false);
        assert_eq!(stale_release["reason"], "resident_activity_not_holder");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn schema_pins_installation_uniqueness_and_run_columns() {
        let home = home();
        let db = database(&home).unwrap();
        migrate(&db).unwrap();
        let columns: Vec<String> = db.prepare("PRAGMA table_info(story_installations)").unwrap()
            .query_map([], |row| row.get(1)).unwrap().collect::<Result<_,_>>().unwrap();
        for column in ["installation_id", "city_id", "story_id", "story_version", "content_digest", "city_revision", "status"] {
            assert!(columns.contains(&column.to_string()), "story_installations must pin {column}");
        }
        let table_sql: String = db.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name='story_installations'", [], |row| row.get(0)).unwrap();
        assert!(table_sql.contains("UNIQUE(city_id,story_id)"), "installation must be unique per city and story");
        let run_columns: Vec<String> = db.prepare("PRAGMA table_info(story_runs)").unwrap()
            .query_map([], |row| row.get(1)).unwrap().collect::<Result<_,_>>().unwrap();
        for column in ["story_run_id", "player_id", "city_id", "story_id", "status", "last_viewed_at_ms", "resumed_from"] {
            assert!(run_columns.contains(&column.to_string()), "story_runs must pin {column}");
        }
        let lease_columns: Vec<String> = db.prepare("PRAGMA table_info(resident_activity_leases)").unwrap()
            .query_map([], |row| row.get(1)).unwrap().collect::<Result<_,_>>().unwrap();
        for column in ["holder_scope_json", "holder_intent_id", "trace_id", "acquired_at_ms", "expires_at_ms", "status"] {
            assert!(lease_columns.contains(&column.to_string()), "leases must pin {column}");
        }
        std::fs::remove_dir_all(home).ok();
    }
}
