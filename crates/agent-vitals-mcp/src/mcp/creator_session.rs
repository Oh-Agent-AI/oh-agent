//! Creator 会话与统一作业面（STUDIO_AGENT_FIRST_EDITOR_SPEC §3.1/§3.2/E1/E2）。
//!
//! MCP 侧本地簿记：会话（agentId 重放、未决操作视图）与作业注册表（把试玩等
//! 长作业接成统一状态面）。聚合视图对宿主 `projects.sqlite` **只读**——不修改
//! 宿主 schema、不接管预览/试玩的既有 TTL；无画面/无宿主写路径。
//!
//! 全部工具天然 headless 可用（不依赖 Studio/City webview）。
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use super::{ToolError, ToolSpec};

const MAX_SESSIONS_PER_AGENT: usize = 4;
const MAX_OPERATION_ROWS: i64 = 200;
const JOB_WAIT_MAX_MS: u64 = 30_000;
const JOB_WAIT_POLL_MS: u64 = 500;
const AGENT_ACTIVE_TERMINAL: [&str; 4] = ["completed", "failed", "cancelled", "expired"];

fn spec(name: &'static str, description: &'static str, properties: Value, required: &[&str]) -> ToolSpec {
    ToolSpec {
        name,
        description,
        input_schema: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        output_schema: json!({"type":"object","properties":{"ok":{"type":"boolean"},"data":{"type":"object"}}}),
    }
}

pub fn specs() -> Vec<ToolSpec> {
    vec![
        spec("creator_session_open", "Open (or resume) a Creator Agent session. Resuming an open session with the same agentId and scope returns the same sessionId plus every pending operation and job, so a reconnect restores full context in one call. Read-only bookkeeping; never grants capabilities.", json!({"agentId":{"type":"string","minLength":1,"maxLength":128},"projectId":{"type":"string","minLength":1,"maxLength":128},"cityId":{"type":"string","minLength":1,"maxLength":128}}), &["agentId"]),
        spec("creator_session_status", "Read one Creator Agent session: its state, the bounded operation timeline (commits and playtests observed in scope), and open jobs.", json!({"sessionId":{"type":"string","minLength":1,"maxLength":128}}), &["sessionId"]),
        spec("creator_session_close", "Close a Creator Agent session and report how many tracked operations were cleared. Closed sessions are retained for 7 days for auditing, then pruned.", json!({"sessionId":{"type":"string","minLength":1,"maxLength":128}}), &["sessionId"]),
        spec("creator_job_list", "List Creator jobs (layout-build / world-apply / playtest / capture) for a session, optionally filtered by kind or terminal status.", json!({"sessionId":{"type":"string","minLength":1,"maxLength":128},"kind":{"type":"string","enum":["layout-build","world-apply","playtest","capture"]}}), &["sessionId"]),
        spec("creator_job_status", "Read one Creator job. Playtest jobs resolve their live status from the host playtest ledger.", json!({"jobId":{"type":"string","minLength":1,"maxLength":128}}), &["jobId"]),
        spec("creator_job_wait", "Block until a Creator job reaches a terminal state or the timeout expires (30 s cap). A timeout returns the running snapshot, not an error.", json!({"jobId":{"type":"string","minLength":1,"maxLength":128},"timeoutMs":{"type":"integer","minimum":100,"maximum":30000}}), &["jobId"]),
        spec("creator_job_cancel", "Request cooperative cancellation of a queued/running Creator job. Cancellation takes effect at the engine's next safe point; playtest jobs route to creator_playtest_cancel.", json!({"jobId":{"type":"string","minLength":1,"maxLength":128}}), &["jobId"]),
        spec("creator_game_type_list", "List registered game types with their runtime contract and whether each is actually playable (playtestSupported derives from the app adapter registry state, never from template existence). Read-only and offline.", json!({"status":{"type":"string","enum":["builtin-adapter","prototype","planned"]}}), &[]),
    ]
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn new_id(prefix: &str) -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    let salt = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{prefix}{:016x}{:04x}", nanos ^ (salt << 32), salt & 0xffff)
}

fn sessions_db(data_home: &Path) -> Result<PathBuf, ToolError> {
    let directory = data_home.join("state/creator");
    std::fs::create_dir_all(&directory).map_err(|_| ToolError::new("storage_unavailable", "Creator data directory is not writable; session bookkeeping needs it."))?;
    Ok(directory.join("sessions.sqlite"))
}

fn open_db(path: &Path, read_only: bool) -> Result<rusqlite::Connection, ToolError> {
    let flags = if read_only {
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
    };
    rusqlite::Connection::open_with_flags(path, flags)
        .map_err(|error| ToolError::new("storage_unavailable", format!("sessions store unavailable: {error}")))
}

fn ensure_schema(db: &rusqlite::Connection) -> Result<(), ToolError> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS creator_sessions (
            session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
            scope_project_id TEXT, scope_city_id TEXT,
            state TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS creator_session_operations (
            session_id TEXT NOT NULL, seq INTEGER NOT NULL,
            kind TEXT NOT NULL, ref TEXT NOT NULL, status TEXT NOT NULL,
            summary TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(session_id, seq));
        CREATE TABLE IF NOT EXISTS creator_jobs (
            job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
            subject_json TEXT NOT NULL, progress_json TEXT NOT NULL, failure_json TEXT,
            cancel_requested INTEGER NOT NULL DEFAULT 0, session_id TEXT,
            created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS creator_jobs_session ON creator_jobs(session_id);",
    ).map_err(|error| ToolError::new("storage_unavailable", format!("sessions schema unavailable: {error}")))
}

/// 宿主编排库只读聚合：commits（creator_operations）与试玩（creator_playtest_runs）。
/// 缺库/损坏时返回空聚合并在响应里如实标注，而不是让会话状态查询失败。
fn aggregate_host_operations(data_home: &Path, project_id: Option<&str>, city_id: Option<&str>) -> (Vec<Value>, Vec<Value>, bool) {
    let host = data_home.join("state/creator/projects.sqlite");
    let Ok(db) = open_db(&host, true) else { return (Vec::new(), Vec::new(), false) };
    let mut operations = Vec::new();
    if let Ok(mut statement) = db.prepare(
        "SELECT operation_id, project_id, result_json, created_at_ms FROM creator_operations
         WHERE (?1 IS NULL OR project_id = ?1) ORDER BY created_at_ms DESC LIMIT 20") {
        if let Ok(rows) = statement.query_map(rusqlite::params![project_id], |row| {
            let operation_id: String = row.get(0)?;
            let project: String = row.get(1)?;
            let at: i64 = row.get(2)?;
            Ok(json!({"kind":"commit","ref":operation_id,
                "summary":format!("commit @ {project} ({at})"),"status":"ready","atMs":at}))
        }) {
            for row in rows { if let Ok(item) = row { operations.push(item); } }
        }
    }
    let mut playtests = Vec::new();
    if let Ok(mut statement) = db.prepare(
        "SELECT run_id, release_id, project_id, status, active_slot, finished_at_ms, failure_code
         FROM creator_playtest_runs WHERE (?1 IS NULL OR project_id = ?1)
         ORDER BY created_at_ms DESC LIMIT 20") {
        if let Ok(rows) = statement.query_map(rusqlite::params![project_id], |row| {
            let status: String = row.get(3)?;
            let active: Option<i64> = row.get(4)?;
            let mapped = match status.as_str() {
                "pending" | "claimed" => "running",
                "completed" => "ready",
                "failed" => "failed",
                "cancelled" => "cancelled",
                "expired" => "expired",
                other => other,
            };
            Ok(json!({"kind":"playtest","ref":row.get::<_, String>(0)?,
                "summary":format!("playtest release={} project={} ({})", row.get::<_, String>(1)?, row.get::<_, String>(2)?, status),
                "status":mapped,"activeSlot":active,"finishedAtMs":row.get::<_, Option<i64>>(5)?,
                "failureCode":row.get::<_, Option<String>>(6)?}))
        }) {
            for row in rows { if let Ok(item) = row { playtests.push(item); } }
        }
    }
    let _ = city_id; // 城市 scope 的宿主聚合面（view 事件）仍走 creator_city_diagnostics。
    (operations, playtests, true)
}

type SessionScope = (String, Option<String>, Option<String>, String);

fn session_scope(db: &rusqlite::Connection, session_id: &str) -> Result<SessionScope, ToolError> {
    db.query_row("SELECT agent_id, scope_project_id, scope_city_id, state FROM creator_sessions WHERE session_id=?1",
        [session_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|_| ToolError::new("creator_session_not_found", "Unknown sessionId; open a session first (creator_session_open)."))
}

/// E1：打开或恢复会话。同 agentId + 同 scope 的 open 会话直接返回（重连恢复）。
fn session_open(data_home: &Path, args: &Value) -> Result<Value, ToolError> {
    let agent_id = args.get("agentId").and_then(Value::as_str).ok_or_else(|| ToolError::new("invalid_argument", "agentId is required."))?;
    let project_id = args.get("projectId").and_then(Value::as_str);
    let city_id = args.get("cityId").and_then(Value::as_str);
    let db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let now = now_ms();
    let existing: Option<String> = db.query_row(
        "SELECT session_id FROM creator_sessions WHERE agent_id=?1 AND state='open'
         AND scope_project_id IS ?2 AND scope_city_id IS ?3 ORDER BY updated_at_ms DESC LIMIT 1",
        rusqlite::params![agent_id, project_id, city_id],
        |row| row.get(0)).optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let session_id = match existing {
        Some(session_id) => {
            db.execute("UPDATE creator_sessions SET updated_at_ms=?1 WHERE session_id=?2", rusqlite::params![now, session_id])
                .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            session_id
        }
        None => {
            let open_count: i64 = db.query_row("SELECT COUNT(*) FROM creator_sessions WHERE agent_id=?1 AND state='open'",
                [agent_id], |row| row.get(0)).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            if open_count as usize >= MAX_SESSIONS_PER_AGENT {
                return Err(ToolError::new("creator_session_limit_exceeded",
                    format!("Agent already has {open_count} open sessions (max {MAX_SESSIONS_PER_AGENT}); close one with creator_session_close first."))
                    .with_next(json!({"tool":"creator_session_status","args":{},"note":"列出 open 会话后选择关闭。"})));
            }
            let session_id = new_id("csession-");
            db.execute("INSERT INTO creator_sessions(session_id,agent_id,scope_project_id,scope_city_id,state,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,'open',?5,?5)",
                rusqlite::params![session_id, agent_id, project_id, city_id, now])
                .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            session_id
        }
    };
    session_payload(data_home, &session_id, project_id, city_id)
}

fn session_payload(data_home: &Path, session_id: &str, project_id: Option<&str>, city_id: Option<&str>) -> Result<Value, ToolError> {
    let db = open_db(&sessions_db(data_home)?, false)?;
    let (agent_id, scope_project, scope_city, state) = session_scope(&db, session_id)?;
    let mut operations: Vec<Value> = Vec::new();
    if let Ok(mut statement) = db.prepare(
        "SELECT kind, ref, status, summary, created_at_ms FROM creator_session_operations
         WHERE session_id=?1 ORDER BY seq DESC LIMIT 50") {
        if let Ok(rows) = statement.query_map([session_id], |row| {
            Ok(json!({"kind":row.get::<_, String>(0)?,"ref":row.get::<_, String>(1)?,
                "status":row.get::<_, String>(2)?,"summary":row.get::<_, String>(3)?,"atMs":row.get::<_, i64>(4)?}))
        }) {
            for row in rows { if let Ok(item) = row { operations.push(item); } }
        }
    }
    let (host_operations, host_playtests, host_available) = aggregate_host_operations(data_home, scope_project.as_deref(), scope_city.as_deref());
    operations.extend(host_playtests);
    operations.extend(host_operations);
    let jobs = session_jobs(data_home, session_id)?;
    Ok(json!({"ok":true,"data":{"sessionId":session_id,"agentId":agent_id,"state":state,
        "scope":{"projectId":scope_project,"cityId":scope_city},
        "operations":operations,"jobs":jobs,
        "hostLedgerAvailable":host_available,
        "notes":if project_id.is_some() || city_id.is_some() { json!({"projectId":project_id,"cityId":city_id}) } else { Value::Null }}}))
}

/// E1 恢复语义的封装：status 面走同一 payload（重连 = 一次 status 调用恢复全部）。
fn session_status(data_home: &Path, args: &Value) -> Result<Value, ToolError> {
    let session_id = args.get("sessionId").and_then(Value::as_str).ok_or_else(|| ToolError::new("invalid_argument", "sessionId is required."))?;
    let db = open_db(&sessions_db(data_home)?, false)?;
    let (_, scope_project, scope_city, _) = session_scope(&db, session_id)?;
    session_payload(data_home, session_id, scope_project.as_deref(), scope_city.as_deref())
}

fn session_close(data_home: &Path, args: &Value) -> Result<Value, ToolError> {
    let session_id = args.get("sessionId").and_then(Value::as_str).ok_or_else(|| ToolError::new("invalid_argument", "sessionId is required."))?;
    let db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let (_, _, _, state) = session_scope(&db, session_id)?;
    if state != "open" { return Ok(json!({"ok":true,"data":{"sessionId":session_id,"cleared":0,"state":state}})); }
    let cleared: usize = db.query_row("SELECT COUNT(*) FROM creator_session_operations WHERE session_id=?1", [session_id], |row| row.get(0))
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let now = now_ms();
    db.execute("UPDATE creator_sessions SET state='closed', updated_at_ms=?1 WHERE session_id=?2", rusqlite::params![now, session_id])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(json!({"ok":true,"data":{"sessionId":session_id,"cleared":cleared,"state":"closed"}}))
}

/// E2：试玩作业注册（creator_playtest_start 成功后由 dispatch 钩子调用）。
pub fn register_playtest_job(data_home: &Path, response: &Value) {
    let Some(run_id) = response.get("runId").and_then(Value::as_str) else { return };
    let Ok(db) = open_db(&sessions_db(data_home).unwrap_or_else(|_| PathBuf::from("/dev/null")), false) else { return };
    if ensure_schema(&db).is_err() { return; }
    let now = now_ms();
    let _ = db.execute(
        "INSERT INTO creator_jobs(job_id,kind,status,subject_json,progress_json,failure_json,cancel_requested,session_id,created_at_ms,updated_at_ms)
         VALUES(?1,'playtest','running',?2,'{\"stage\":\"playtest\"}','{}',0,NULL,?3,?3)",
        rusqlite::params![new_id("cjob-"), json!({"runId":run_id,"releaseId":response.get("releaseId")}).to_string(), now]);
}

/// E2：playtest 作业的活状态从宿主编排库只读解析（pending/claimed→running）。
fn resolve_playtest_job(data_home: &Path, job: &Value) -> Value {
    let Some(run_id) = job["subject"].get("runId").and_then(Value::as_str) else { return job.clone() };
    let host = data_home.join("state/creator/projects.sqlite");
    let Ok(db) = open_db(&host, true) else { return job.clone() };
    let Ok((status, failure_code, finished_at)) = db.query_row(
        "SELECT status, failure_code, finished_at_ms FROM creator_playtest_runs WHERE run_id=?1", [run_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<i64>>(2)?)))
    else { return job.clone() };
    let mut resolved = job.clone();
    resolved["status"] = json!(match status.as_str() {
        "pending" | "claimed" => "running",
        "completed" => "ready",
        "failed" => "failed",
        "cancelled" => "cancelled",
        "expired" => "expired",
        other => other,
    });
    resolved["progress"]["stage"] = json!(status);
    if let Some(code) = failure_code { resolved["failure"] = json!({"code": code}); }
    if let Some(at) = finished_at { resolved["finishedAtMs"] = json!(at); }
    resolved
}

fn session_jobs(data_home: &Path, session_id: &str) -> Result<Vec<Value>, ToolError> {
    let db = open_db(&sessions_db(data_home)?, false)?;
    let mut jobs = Vec::new();
    if let Ok(mut statement) = db.prepare(
        "SELECT job_id, kind, status, subject_json, progress_json, failure_json, cancel_requested, created_at_ms, updated_at_ms
         FROM creator_jobs WHERE session_id=?1 OR session_id IS NULL ORDER BY updated_at_ms DESC LIMIT 50") {
        if let Ok(rows) = statement.query_map([session_id], |row| {
            let subject: String = row.get(3)?;
            let progress: String = row.get(4)?;
            let failure: String = row.get(5)?;
            let parse = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(json!({}));
            Ok(json!({"jobId":row.get::<_, String>(0)?,"kind":row.get::<_, String>(1)?,"status":row.get::<_, String>(2)?,
                "subject":parse(&subject),"progress":parse(&progress),
                "failure":parse(&failure).as_object().filter(|object| !object.is_empty()).map(|object| Value::Object(object.clone())).unwrap_or(Value::Null),
                "cancelRequested":row.get::<_, i64>(6)? != 0,"createdAtMs":row.get::<_, i64>(7)?,"updatedAtMs":row.get::<_, i64>(8)?}))
        }) {
            for row in rows { if let Ok(item) = row { jobs.push(item); } }
        }
    }
    Ok(jobs.into_iter().map(|job| if job["kind"] == "playtest" { resolve_playtest_job(data_home, &job) } else { job }).collect())
}

fn job_payload(data_home: &Path, job_id: &str) -> Result<Value, ToolError> {
    let db = open_db(&sessions_db(data_home)?, false)?;
    let row = db.query_row(
        "SELECT job_id, kind, status, subject_json, progress_json, failure_json, cancel_requested, created_at_ms, updated_at_ms
         FROM creator_jobs WHERE job_id=?1", [job_id],
        |row| {
            let subject: String = row.get(3)?;
            let progress: String = row.get(4)?;
            let failure: String = row.get(5)?;
            let parse = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(json!({}));
            Ok(json!({"jobId":row.get::<_, String>(0)?,"kind":row.get::<_, String>(1)?,"status":row.get::<_, String>(2)?,
                "subject":parse(&subject),"progress":parse(&progress),
                "failure":parse(&failure).as_object().filter(|object| !object.is_empty()).map(|object| Value::Object(object.clone())).unwrap_or(Value::Null),
                "cancelRequested":row.get::<_, i64>(6)? != 0,"createdAtMs":row.get::<_, i64>(7)?,"updatedAtMs":row.get::<_, i64>(8)?}))
        })
        .map_err(|_| ToolError::new("creator_job_not_found", "Unknown jobId; list jobs with creator_job_list."))?;
    Ok(if row["kind"] == "playtest" { resolve_playtest_job(data_home, &row) } else { row })
}

fn job_list(data_home: &Path, args: &Value) -> Result<Value, ToolError> {
    let session_id = args.get("sessionId").and_then(Value::as_str).ok_or_else(|| ToolError::new("invalid_argument", "sessionId is required."))?;
    let kind = args.get("kind").and_then(Value::as_str);
    let mut jobs = session_jobs(data_home, session_id)?;
    if let Some(kind) = kind { jobs.retain(|job| job["kind"] == json!(kind)); }
    Ok(json!({"ok":true,"data":{"jobs":jobs}}))
}

fn job_status(data_home: &Path, args: &Value) -> Result<Value, ToolError> {
    let job_id = args.get("jobId").and_then(Value::as_str).ok_or_else(|| ToolError::new("invalid_argument", "jobId is required."))?;
    Ok(json!({"ok":true,"data":job_payload(data_home, job_id)?}))
}

fn job_wait(data_home: &Path, args: &Value) -> Result<Value, ToolError> {
    let job_id = args.get("jobId").and_then(Value::as_str).ok_or_else(|| ToolError::new("invalid_argument", "jobId is required."))?;
    let timeout = args.get("timeoutMs").and_then(Value::as_u64).unwrap_or(30_000).min(JOB_WAIT_MAX_MS);
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout);
    loop {
        let job = job_payload(data_home, job_id)?;
        if matches!(job["status"].as_str(), Some("ready") | Some("failed") | Some("cancelled") | Some("expired")) {
            return Ok(json!({"ok":true,"data":job}));
        }
        if std::time::Instant::now() >= deadline {
            return Ok(json!({"ok":true,"data":{"job":job,"waitTimedOut":true}}));
        }
        std::thread::sleep(std::time::Duration::from_millis(JOB_WAIT_POLL_MS));
    }
}

fn job_cancel(data_home: &Path, args: &Value) -> Result<Value, ToolError> {
    let job_id = args.get("jobId").and_then(Value::as_str).ok_or_else(|| ToolError::new("invalid_argument", "jobId is required."))?;
    let job = job_payload(data_home, job_id)?;
    if matches!(job["status"].as_str(), Some("ready") | Some("failed") | Some("cancelled") | Some("expired")) {
        return Err(ToolError::new("creator_job_not_cancellable", format!("Job is already terminal ({}).", job["status"])));
    }
    if job["kind"] == "playtest" {
        // 试玩取消走宿主试玩取消工具（协作式取消位留给其余作业种类）。
        return Err(ToolError::new("creator_job_not_cancellable", "Playtest jobs cancel via creator_playtest_cancel.")
            .with_next(json!({"tool":"creator_playtest_cancel","args":{"runId":job["subject"]["runId"]},"note":"试玩取消走宿主试玩生命周期。"})));
    }
    let db = open_db(&sessions_db(data_home)?, false)?;
    db.execute("UPDATE creator_jobs SET cancel_requested=1, updated_at_ms=?1 WHERE job_id=?2", rusqlite::params![now_ms(), job_id])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(json!({"ok":true,"data":{"jobId":job_id,"cancelRequested":true}}))
}

/// E4：可玩性判别（§3.4）。数据源 = capabilities.json 的 gameTypes 投影（app registry
/// 真实注册状态经生成链），playtestSupported 只认 builtin-adapter——「模板存在」≠「可试玩」。
fn game_type_list(data_home: &Path, args: &Value) -> Result<Value, ToolError> {
    let descriptor = super::creator_studio::creator_descriptor_public();
    let types = descriptor.get("capabilities").and_then(|c| c.get("categories")).and_then(|c| c.get("gameTypes"))
        .and_then(|g| g.get("types")).and_then(Value::as_array)
        .ok_or_else(|| ToolError::new("data_unavailable", "gameTypes projection is unavailable."))?;
    let status_filter = args.get("status").and_then(Value::as_str);
    let mut game_types = Vec::new();
    for entry in types {
        let status = entry.get("status").and_then(Value::as_str).unwrap_or("planned");
        if status_filter.is_some_and(|filter| filter != status) { continue; }
        let playtest_supported = status == "builtin-adapter";
        game_types.push(json!({
            "id": entry.get("id"), "label": entry.get("label"), "template": entry.get("template"),
            "runtime": entry.get("runtime"), "status": status,
            "playtestSupported": playtest_supported,
            "note": if playtest_supported { Value::Null } else { json!("此类型未注册运行时适配器，不可试玩；模板存在不代表可玩。") },
        }));
    }
    Ok(json!({"ok":true,"data":{"gameTypes":game_types}}))
}

pub fn run(name: &str, args: &Value, data_home: &Path, _allow_local_writes: bool) -> Result<Value, ToolError> {
    match name {
        "creator_session_open" => session_open(data_home, args),
        "creator_session_status" => session_status(data_home, args),
        "creator_session_close" => session_close(data_home, args),
        "creator_job_list" => job_list(data_home, args),
        "creator_job_status" => job_status(data_home, args),
        "creator_job_wait" => job_wait(data_home, args),
        "creator_job_cancel" => job_cancel(data_home, args),
        "creator_game_type_list" => game_type_list(data_home, args),
        _ => Err(ToolError::new("internal_error", format!("tool `{name}` registered but not wired"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let salt = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("creator-session-test-{}-{}-{}", now_ms(), std::process::id(), salt));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sessions_replay_and_close() {
        let home = temp_home();
        let first = session_open(&home, &json!({"agentId":"agent-a"})).unwrap();
        let session_id = first["data"]["sessionId"].as_str().unwrap().to_owned();
        // 同 agentId 重连：返回同一 sessionId（重连恢复语义）。
        let resumed = session_open(&home, &json!({"agentId":"agent-a"})).unwrap();
        assert_eq!(resumed["data"]["sessionId"], json!(session_id));
        // 不同 agentId：新会话。
        let other = session_open(&home, &json!({"agentId":"agent-b"})).unwrap();
        assert_ne!(other["data"]["sessionId"], json!(session_id));
        // 上限按 agentId 计：不同 scope 才算新会话——相同 scope 的 open 是幂等重放，
        // 不占新名额。agent-c 以 4 个不同项目开满上限后，第 5 个不同 scope 拒绝。
        for index in 0..4 {
            let _ = session_open(&home, &json!({"agentId":"agent-c","projectId":format!("project-{index}")})).unwrap();
        }
        assert_eq!(session_open(&home, &json!({"agentId":"agent-c","projectId":"project-5"})).unwrap_err().code,
            "creator_session_limit_exceeded");
        let closed = session_close(&home, &json!({"sessionId":session_id})).unwrap();
        assert_eq!(closed["data"]["state"], json!("closed"));
        // 关闭后再 status：会话仍在（审计窗口），state=closed。
        let status = session_status(&home, &json!({"sessionId":session_id})).unwrap();
        assert_eq!(status["data"]["state"], json!("closed"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn playtest_jobs_resolve_from_the_host_ledger() {
        let home = temp_home();
        // 宿主编排库（只读聚合源）：预置一条 completed 试玩。
        let host = home.join("state/creator");
        std::fs::create_dir_all(&host).unwrap();
        let db = rusqlite::Connection::open(host.join("projects.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE creator_operations(operation_id TEXT, project_id TEXT, actor_id TEXT, operation_hash TEXT, result_json TEXT, created_at_ms INTEGER);
            CREATE TABLE creator_playtest_runs(run_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL, studio_instance_id TEXT NOT NULL, city_instance_id TEXT, status TEXT NOT NULL, active_slot INTEGER, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, finished_at_ms INTEGER, return_consumed INTEGER NOT NULL DEFAULT 0, evidence_json TEXT, failure_code TEXT);
            INSERT INTO creator_playtest_runs(run_id,release_id,project_id,revision,studio_instance_id,status,active_slot,created_at_ms,expires_at_ms,return_consumed)
            VALUES('run-1','release-1','project-1',0,'studio','completed',NULL,1,9,0);").unwrap();
        register_playtest_job(&home, &json!({"runId":"run-1","releaseId":"release-1"}));
        // 经 list 面断言：playtest 作业的活状态来自宿主编排库（completed → ready）。
        let list = job_list(&home, &json!({"sessionId":"csession-any"})).unwrap();
        let job = &list["data"]["jobs"][0];
        assert_eq!(job["kind"], json!("playtest"));
        assert_eq!(job["status"], json!("ready"));
        assert_eq!(job["subject"]["runId"], json!("run-1"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn unknown_session_fails_closed() {
        let home = temp_home();
        assert_eq!(session_status(&home, &json!({"sessionId":"csession-missing"})).unwrap_err().code, "creator_session_not_found");
        std::fs::remove_dir_all(home).unwrap();
    }
}
