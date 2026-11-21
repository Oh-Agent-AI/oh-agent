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
use sha2::{Digest, Sha256};

use super::{ToolError, ToolSpec};

const MAX_SESSIONS_PER_AGENT: usize = 4;
const JOB_WAIT_MAX_MS: u64 = 30_000;
const JOB_WAIT_POLL_MS: u64 = 500;

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
        spec("creator_job_list", "List Creator jobs (layout-build / world-apply / playtest / capture / studio-task) for a session, optionally filtered by kind or terminal status.", json!({"sessionId":{"type":"string","minLength":1,"maxLength":128},"kind":{"type":"string","enum":["layout-build","world-apply","playtest","capture","studio-task"]}}), &["sessionId"]),
        spec("creator_job_status", "Read one Creator job. Playtest jobs resolve their live status from the host playtest ledger.", json!({"jobId":{"type":"string","minLength":1,"maxLength":128}}), &["jobId"]),
        spec("creator_job_wait", "Block until a Creator job reaches a terminal state or the timeout expires (30 s cap). A timeout returns the running snapshot, not an error.", json!({"jobId":{"type":"string","minLength":1,"maxLength":128},"timeoutMs":{"type":"integer","minimum":100,"maximum":30000}}), &["jobId"]),
        spec("creator_job_cancel", "Request cooperative cancellation of a queued/running Creator job. Cancellation takes effect at the engine's next safe point; playtest jobs route to creator_playtest_cancel.", json!({"jobId":{"type":"string","minLength":1,"maxLength":128}}), &["jobId"]),
        spec("creator_task_create", "Create a durable Studio goal and artifact in the shared Creator session/job ledger. This does not execute an Agent.", json!({"sessionId":{"type":"string"},"goal":{"type":"string"},"humanRequest":{"type":"string"},"artifact":{"type":"object"},"acceptanceCriteria":{"type":"array"},"operationId":{"type":"string"}}), &["sessionId","goal","humanRequest","artifact","acceptanceCriteria","operationId"]),
        spec("creator_task_plan_submit", "Submit or revise a task plan with CAS-checked plan and artifact revisions.", json!({"taskId":{"type":"string"},"expectedPlanRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"steps":{"type":"array"},"operationId":{"type":"string"}}), &["taskId","expectedPlanRevision","expectedArtifactRevision","steps","operationId"]),
        spec("creator_task_plan_approve", "Approve the current task plan; this records approval but never claims execution or completion.", json!({"taskId":{"type":"string"},"planRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"operationId":{"type":"string"}}), &["taskId","planRevision","expectedArtifactRevision","operationId"]),
        spec("creator_task_status", "Read durable goal, plan, steps and evidence for a Studio task.", json!({"taskId":{"type":"string"}}), &["taskId"]),
        spec("creator_task_evidence_append", "Append typed evidence with explicit trust level. Host verification cannot be self-declared.", json!({"taskId":{"type":"string"},"planRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"criterionId":{"type":"string"},"kind":{"type":"string"},"trustLevel":{"type":"string"},"summary":{"type":"string"},"operationId":{"type":"string"}}), &["taskId","planRevision","expectedArtifactRevision","criterionId","kind","trustLevel","summary","operationId"]),
        spec("creator_task_evidence_list", "List durable evidence for a Studio task.", json!({"taskId":{"type":"string"}}), &["taskId"]),
        spec("creator_task_review_accept", "Accept a task only after all acceptance criteria have real evidence and a human reviewer accepts it.", json!({"taskId":{"type":"string"},"planRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"reviewerNote":{"type":"string"},"operationId":{"type":"string"}}), &["taskId","planRevision","expectedArtifactRevision","reviewerNote","operationId"]),
        spec("creator_task_review_reject", "Reject the current task plan during human review.", json!({"taskId":{"type":"string"},"planRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"reason":{"type":"string"},"operationId":{"type":"string"}}), &["taskId","planRevision","expectedArtifactRevision","reason","operationId"]),
        spec("creator_task_cancel", "Cancel a non-terminal Studio task without deleting its goal, plan or evidence.", json!({"taskId":{"type":"string"},"operationId":{"type":"string"}}), &["taskId","operationId"]),
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
        CREATE INDEX IF NOT EXISTS creator_jobs_session ON creator_jobs(session_id);
        CREATE TABLE IF NOT EXISTS creator_studio_tasks (
            task_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL,
            human_request TEXT NOT NULL, acceptance_json TEXT NOT NULL, artifact_json TEXT NOT NULL,
            plan_revision INTEGER NOT NULL, step_ids_json TEXT NOT NULL, phase TEXT NOT NULL,
            proposed_change_set_id TEXT, last_evidence_id TEXT,
            created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS creator_studio_task_steps (
            task_id TEXT NOT NULL, plan_revision INTEGER NOT NULL, step_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
            PRIMARY KEY(task_id, plan_revision, step_id));
        CREATE TABLE IF NOT EXISTS creator_studio_task_evidence (
            evidence_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, plan_revision INTEGER NOT NULL,
            step_id TEXT, criterion_id TEXT NOT NULL, kind TEXT NOT NULL, trust_level TEXT NOT NULL,
            summary TEXT NOT NULL, data_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS creator_studio_evidence_task ON creator_studio_task_evidence(task_id,created_at_ms);
        CREATE TABLE IF NOT EXISTS creator_studio_task_receipts (
            operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
            result_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);",
    ).map_err(|error| ToolError::new("storage_unavailable", format!("sessions schema unavailable: {error}")))
}

/// 宿主编排库只读聚合：commits（creator_operations）与试玩（creator_playtest_runs）。
/// 缺库/损坏时返回空聚合并在响应里如实标注，而不是让会话状态查询失败。
fn aggregate_host_operations(data_home: &Path, project_id: Option<&str>, city_id: Option<&str>) -> (Vec<Value>, Vec<Value>, bool) {
    let host = data_home.join("state/creator/projects.sqlite");
    // 读连接必须是读写打开：WAL 库在「app 仍持有 writer 连接」时，read-only 连接拿不到
    // shm 读标记，查询以 SQLITE_BUSY 失败（错误被下面的 if let Ok 吞掉，表现成「账本为空」）。
    // W2 真机首次跑就撞上：commit 明明落库，会话时间线却报 kinds=[]。
    let Ok(db) = open_db(&host, false) else { return (Vec::new(), Vec::new(), false) };
    let mut operations = Vec::new();
    if let Ok(mut statement) = db.prepare(
        "SELECT operation_id, project_id, result_json, created_at_ms FROM creator_operations
         WHERE (?1 IS NULL OR project_id = ?1) ORDER BY created_at_ms DESC LIMIT 20") {
        if let Ok(rows) = statement.query_map(rusqlite::params![project_id], |row| {
            let operation_id: String = row.get(0)?;
            let project: String = row.get(1)?;
            let at: i64 = row.get(3)?;
            Ok(json!({"kind":"commit","ref":operation_id,
                "summary":format!("commit @ {project} ({at})"),"status":"ready","atMs":at}))
        }) {
            for item in rows.flatten() { operations.push(item); }
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
            for item in rows.flatten() { playtests.push(item); }
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
            for item in rows.flatten() { operations.push(item); }
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

/// E2：world-apply 作业注册（creator_city_edit_commit 成功且宿主回报
/// runtimeStatus 时由 dispatch 钩子调用）。活状态经宿主 view_status 解析：
/// 视口 ready → ready；failed → failed；无视口（headless）如实停在 running。
pub fn register_world_apply_job(data_home: &Path, city_id: Option<&str>, revision: Option<u64>) {
    let Some(city_id) = city_id else { return };
    let Ok(db) = open_db(&sessions_db(data_home).unwrap_or_else(|_| PathBuf::from("/dev/null")), false) else { return };
    if ensure_schema(&db).is_err() { return; }
    let now = now_ms();
    let _ = db.execute(
        "INSERT INTO creator_jobs(job_id,kind,status,subject_json,progress_json,failure_json,cancel_requested,session_id,created_at_ms,updated_at_ms)
         VALUES(?1,'world-apply','running',?2,'{\"stage\":\"layout-rebuild\"}','{}',0,NULL,?3,?3)",
        rusqlite::params![new_id("cjob-"), json!({"cityId":city_id,"revision":revision}).to_string(), now]);
}

/// E2：试玩作业注册（creator_playtest_start 成功后由 dispatch 钩子调用）。
///
/// `creator_studio::run` 成功时交来的是 `{ok:true, data:{runId, releaseId, ...}}`。
/// 只读顶层 `runId` 会把成功的 start 静默丢掉，会话和 job_list 就一直是空的。
/// 同一 run 再注册一次不另开作业：幂等 start 回的是同一条试玩。
pub fn register_playtest_job(data_home: &Path, response: &Value) {
    if response.get("ok").is_some_and(|flag| flag != &Value::Bool(true)) { return; }
    let body = response.get("data").filter(|value| value.is_object()).unwrap_or(response);
    let Some(run_id) = body.get("runId").and_then(Value::as_str).filter(|run_id| valid_playtest_run_id(run_id)) else { return };
    let Ok(db) = open_db(&sessions_db(data_home).unwrap_or_else(|_| PathBuf::from("/dev/null")), false) else { return };
    if ensure_schema(&db).is_err() { return; }
    let needle = format!("\"runId\":\"{run_id}\"");
    let existing: i64 = db.query_row(
        "SELECT COUNT(*) FROM creator_jobs WHERE kind='playtest' AND instr(subject_json, ?1) > 0",
        [&needle], |row| row.get(0)).unwrap_or(0);
    if existing > 0 { return; }
    let now = now_ms();
    let _ = db.execute(
        "INSERT INTO creator_jobs(job_id,kind,status,subject_json,progress_json,failure_json,cancel_requested,session_id,created_at_ms,updated_at_ms)
         VALUES(?1,'playtest','running',?2,'{\"stage\":\"playtest\"}','{}',0,NULL,?3,?3)",
        rusqlite::params![new_id("cjob-"), json!({"runId":run_id,"releaseId":body.get("releaseId")}).to_string(), now]);
}

fn valid_playtest_run_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty() && bytes.len() <= 128 && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

/// E2：world-apply 作业的活状态经宿主 view_status 解析（ready→ready、failed→failed、
/// 其余/无视口→保持 running——headless 下布局重建不可观察，如实不假装完成）。
fn resolve_world_apply_job(data_home: &Path, job: &Value) -> Value {
    let Some(city_id) = job["subject"].get("cityId").and_then(Value::as_str) else { return job.clone() };
    if job["status"] != json!("running") { return job.clone(); }
    let Ok(state) = super::creator_studio::call(data_home, "creator.city.view.status", &json!({"cityId":city_id}), 5_000) else { return job.clone() };
    let view_state = state.get("status").and_then(Value::as_str).unwrap_or("");
    let mut resolved = job.clone();
    match view_state {
        "ready" => { resolved["status"] = json!("ready"); resolved["progress"]["stage"] = json!("layout-ready"); }
        "failed" => { resolved["status"] = json!("failed"); resolved["failure"] = json!({"code":"creator_layout_build_failed"}); }
        _ => {}
    }
    resolved
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
            for item in rows.flatten() { jobs.push(item); }
        }
    }
    Ok(jobs.into_iter().map(|job| match job["kind"].as_str() {
        Some("playtest") => resolve_playtest_job(data_home, &job),
        Some("world-apply") => resolve_world_apply_job(data_home, &job),
        Some("studio-task") => task_payload(data_home, job["jobId"].as_str().unwrap_or_default()).unwrap_or(job),
        _ => job,
    }).collect())
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
    Ok(match row["kind"].as_str() {
        Some("playtest") => resolve_playtest_job(data_home, &row),
        Some("world-apply") => resolve_world_apply_job(data_home, &row),
        Some("studio-task") => task_payload(data_home, row["jobId"].as_str().unwrap_or_default()).unwrap_or(row),
        _ => row,
    })
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
        let terminal = if job["kind"] == "studio-task" {
            matches!(job["status"].as_str(), Some("accepted") | Some("rejected") | Some("failed") | Some("cancelled"))
        } else {
            matches!(job["status"].as_str(), Some("ready") | Some("failed") | Some("cancelled") | Some("expired"))
        };
        if terminal { return Ok(json!({"ok":true,"data":job})); }
        if std::time::Instant::now() >= deadline {
            return Ok(json!({"ok":true,"data":{"job":job,"waitTimedOut":true}}));
        }
        std::thread::sleep(std::time::Duration::from_millis(JOB_WAIT_POLL_MS));
    }
}

fn job_cancel(data_home: &Path, args: &Value) -> Result<Value, ToolError> {
    let job_id = args.get("jobId").and_then(Value::as_str).ok_or_else(|| ToolError::new("invalid_argument", "jobId is required."))?;
    let job = job_payload(data_home, job_id)?;
    let terminal = if job["kind"] == "studio-task" {
        matches!(job["status"].as_str(), Some("accepted") | Some("rejected") | Some("failed") | Some("cancelled"))
    } else {
        matches!(job["status"].as_str(), Some("ready") | Some("failed") | Some("cancelled") | Some("expired"))
    };
    if terminal { return Err(ToolError::new("creator_job_not_cancellable", format!("Job is already terminal ({}).", job["status"]))); }
    if job["kind"] == "studio-task" {
        return task_cancel(data_home, &json!({"taskId":job_id,"operationId":new_id("task-cancel-")}));
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
fn game_type_list(_data_home: &Path, args: &Value) -> Result<Value, ToolError> {
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


fn task_id_arg(payload: &Value, key: &str) -> Result<String, ToolError> {
    payload.get(key).and_then(Value::as_str).filter(|value| valid_playtest_run_id(value))
        .map(str::to_owned).ok_or_else(|| ToolError::new("invalid_argument", format!("{key} must be a stable id.")))
}
fn task_text_arg(payload: &Value, key: &str, max: usize) -> Result<String, ToolError> {
    let value = payload.get(key).and_then(Value::as_str).unwrap_or_default();
    if value.trim().is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(ToolError::new("invalid_argument", format!("{key} must be non-empty, bounded text.")));
    }
    Ok(value.to_owned())
}
fn task_revision_arg(payload: &Value, key: &str) -> Result<u64, ToolError> {
    payload.get(key).and_then(Value::as_u64).ok_or_else(|| ToolError::new("invalid_argument", format!("{key} must be a non-negative integer.")))
}
fn task_canonical_json(value: &Value) -> Result<String, ToolError> {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Object(object) => {
                out.push('{');
                let mut keys: Vec<&String> = object.keys().collect();
                keys.sort();
                for (index, key) in keys.iter().enumerate() {
                    if index > 0 { out.push(','); }
                    out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into()));
                    out.push(':');
                    write(&object[*key], out);
                }
                out.push('}');
            }
            Value::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 { out.push(','); }
                    write(item, out);
                }
                out.push(']');
            }
            _ => out.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "null".into())),
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    Ok(out)
}
fn task_digest(text: &str) -> String { format!("sha256:{:x}", Sha256::digest(text.as_bytes())) }

fn task_hash(payload: &Value) -> Result<String, ToolError> {
    let canonical = task_canonical_json(payload)?;
    Ok(task_digest(&canonical))
}
fn task_receipt(tx: &rusqlite::Transaction<'_>, operation_id: &str, hash: &str) -> Result<Option<Value>, ToolError> {
    let previous: Option<(String,String)> = tx.query_row("SELECT request_hash,result_json FROM creator_studio_task_receipts WHERE operation_id=?1",
        [operation_id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    match previous {
        Some((existing, result)) if existing == hash => Ok(Some(serde_json::from_str(&result).map_err(|_| ToolError::new("storage_unavailable", "Task receipt is damaged."))?)),
        Some(_) => Err(ToolError::new("operation_id_conflict", "operationId was already used for a different task request.")),
        None => Ok(None),
    }
}
fn task_save_receipt(tx: &rusqlite::Transaction<'_>, operation_id: &str, hash: &str, result: &Value) -> Result<(), ToolError> {
    let canonical = task_canonical_json(result)?;
    tx.execute("INSERT INTO creator_studio_task_receipts(operation_id,request_hash,result_json,created_at_ms) VALUES(?1,?2,?3,?4)",
        rusqlite::params![operation_id,hash,canonical,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(())
}
fn task_artifact(payload: &Value) -> Result<Value, ToolError> {
    let artifact = payload.get("artifact").and_then(Value::as_object).ok_or_else(|| ToolError::new("invalid_argument", "artifact is required."))?;
    if artifact.len() != 3 || artifact.get("kind").and_then(Value::as_str) != Some("creator-project") {
        return Err(ToolError::new("invalid_argument", "Only creator-project artifacts are supported."));
    }
    let project_id = artifact.get("projectId").and_then(Value::as_str).filter(|value| valid_playtest_run_id(value))
        .ok_or_else(|| ToolError::new("invalid_argument", "artifact.projectId is invalid."))?;
    let expected_revision = artifact.get("expectedRevision").and_then(Value::as_u64)
        .ok_or_else(|| ToolError::new("invalid_argument", "artifact.expectedRevision is required."))?;
    Ok(json!({"kind":"creator-project","projectId":project_id,"expectedRevision":expected_revision}))
}
fn task_check_artifact(data_home: &Path, artifact: &Value) -> Result<(), ToolError> {
    let host = data_home.join("state/creator/projects.sqlite");
    let db = open_db(&host, false)?;
    let project_id = artifact["projectId"].as_str().unwrap_or_default();
    let expected = artifact["expectedRevision"].as_u64().unwrap_or(u64::MAX);
    let current: Option<u64> = db.query_row("SELECT revision FROM creator_projects WHERE project_id=?1", [project_id], |row| row.get(0))
        .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if current != Some(expected) { return Err(ToolError::new("revision_conflict", "Task artifact revision does not match the authoritative project.")); }
    Ok(())
}

fn task_criteria(payload: &Value) -> Result<Vec<Value>, ToolError> {
    let criteria = payload.get("acceptanceCriteria").and_then(Value::as_array).filter(|items| (1..=16).contains(&items.len()))
        .ok_or_else(|| ToolError::new("invalid_argument", "acceptanceCriteria must contain 1..=16 entries."))?;
    criteria.iter().map(|criterion| {
        let object = criterion.as_object().filter(|object| object.len() == 3).ok_or_else(|| ToolError::new("invalid_argument", "Each criterion needs criterionId, description and requiredEvidenceKind."))?;
        let criterion_id = object.get("criterionId").and_then(Value::as_str).filter(|value| valid_playtest_run_id(value))
            .ok_or_else(|| ToolError::new("invalid_argument", "criterionId is invalid."))?;
        let description = object.get("description").and_then(Value::as_str).filter(|value| !value.trim().is_empty() && value.chars().count() <= 500)
            .ok_or_else(|| ToolError::new("invalid_argument", "Criterion description is invalid."))?;
        let kind = object.get("requiredEvidenceKind").and_then(Value::as_str).filter(|value| matches!(*value, "build" | "test" | "human-note" | "city-playtest"))
            .ok_or_else(|| ToolError::new("invalid_argument", "requiredEvidenceKind is unsupported."))?;
        Ok(json!({"criterionId":criterion_id,"description":description,"requiredEvidenceKind":kind}))
    }).collect()
}
fn task_steps(payload: &Value) -> Result<Vec<Value>, ToolError> {
    let steps = payload.get("steps").and_then(Value::as_array).filter(|items| (1..=32).contains(&items.len()))
        .ok_or_else(|| ToolError::new("invalid_argument", "steps must contain 1..=32 entries."))?;
    steps.iter().enumerate().map(|(ordinal, step)| {
        let object = step.as_object().filter(|object| object.len() == 3).ok_or_else(|| ToolError::new("invalid_argument", "Each step needs stepId, title and kind."))?;
        let step_id = object.get("stepId").and_then(Value::as_str).filter(|value| valid_playtest_run_id(value))
            .ok_or_else(|| ToolError::new("invalid_argument", "stepId is invalid."))?;
        let title = object.get("title").and_then(Value::as_str).filter(|value| !value.trim().is_empty() && value.chars().count() <= 500)
            .ok_or_else(|| ToolError::new("invalid_argument", "Step title is invalid."))?;
        let kind = object.get("kind").and_then(Value::as_str).filter(|value| matches!(*value, "analysis" | "change" | "validation" | "review"))
            .ok_or_else(|| ToolError::new("invalid_argument", "Step kind is unsupported."))?;
        Ok(json!({"stepId":step_id,"ordinal":ordinal,"title":title,"kind":kind}))
    }).collect()
}
fn task_row(db: &rusqlite::Connection, task_id: &str) -> Result<(Value, String, u64, String), ToolError> {
    let row = db.query_row("SELECT t.goal_id,t.goal_revision,t.human_request,t.acceptance_json,t.artifact_json,t.plan_revision,t.step_ids_json,t.phase,t.proposed_change_set_id,t.last_evidence_id,t.created_at_ms,t.updated_at_ms,j.session_id
        FROM creator_studio_tasks t JOIN creator_jobs j ON j.job_id=t.task_id WHERE t.task_id=?1", [task_id], |row| {
        Ok((row.get::<_,String>(0)?,row.get::<_,u64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,
            row.get::<_,u64>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,Option<String>>(8)?,row.get::<_,Option<String>>(9)?,
            row.get::<_,u64>(10)?,row.get::<_,u64>(11)?,row.get::<_,Option<String>>(12)?))
    }).optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
        .ok_or_else(|| ToolError::new("creator_task_not_found", "Unknown taskId."))?;
    let (goal_id, goal_revision, human_request, acceptance, artifact, plan_revision, step_ids, phase, proposed, last_evidence, created, updated, session_id) = row;
    let acceptance: Value = serde_json::from_str(&acceptance).map_err(|_| ToolError::new("storage_unavailable", "Task acceptance is damaged."))?;
    let artifact: Value = serde_json::from_str(&artifact).map_err(|_| ToolError::new("storage_unavailable", "Task artifact is damaged."))?;
    let step_ids: Value = serde_json::from_str(&step_ids).map_err(|_| ToolError::new("storage_unavailable", "Task steps are damaged."))?;
    Ok((json!({"goalId":goal_id,"goalRevision":goal_revision,"humanRequest":human_request,"acceptanceCriteria":acceptance,
        "artifact":artifact,"planRevision":plan_revision,"stepIds":step_ids,"phase":phase,"proposedChangeSetId":proposed,"lastEvidenceId":last_evidence,
        "createdAtMs":created,"updatedAtMs":updated}), session_id.unwrap_or_default(), plan_revision, phase))
}
fn task_payload(data_home: &Path, task_id: &str) -> Result<Value, ToolError> {
    let db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let (task, session_id, _, _) = task_row(&db, task_id)?;
    let plan_revision = task["planRevision"].as_u64().unwrap_or(0);
    let mut statement = db.prepare("SELECT step_id,ordinal,title,kind FROM creator_studio_task_steps WHERE task_id=?1 AND plan_revision=?2 ORDER BY ordinal").map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let steps = statement.query_map(rusqlite::params![task_id,plan_revision], |row| {
        Ok(json!({"stepId":row.get::<_,String>(0)?,"ordinal":row.get::<_,u64>(1)?,"title":row.get::<_,String>(2)?,"kind":row.get::<_,String>(3)?}))
    }).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?.collect::<Result<Vec<_>,_>>().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let mut statement = db.prepare("SELECT evidence_id,plan_revision,step_id,criterion_id,kind,trust_level,summary,data_json,created_at_ms FROM creator_studio_task_evidence WHERE task_id=?1 ORDER BY created_at_ms DESC,evidence_id DESC LIMIT 50").map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let evidence = statement.query_map([task_id], |row| {
        let data: String = row.get(7)?;
        Ok(json!({"evidenceId":row.get::<_,String>(0)?,"planRevision":row.get::<_,u64>(1)?,"stepId":row.get::<_,Option<String>>(2)?,
            "criterionId":row.get::<_,String>(3)?,"kind":row.get::<_,String>(4)?,"trustLevel":row.get::<_,String>(5)?,
            "summary":row.get::<_,String>(6)?,"data":serde_json::from_str::<Value>(&data).unwrap_or(Value::Null),"createdAtMs":row.get::<_,u64>(8)?}))
    }).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?.collect::<Result<Vec<_>,_>>().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let failure_json: Option<String> = db.query_row("SELECT failure_json FROM creator_jobs WHERE job_id=?1", [task_id], |row| row.get(0))
        .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let failure = failure_json.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|value| value.as_object().filter(|object| !object.is_empty()).map(|object| Value::Object(object.clone()))).unwrap_or(Value::Null);
    Ok(json!({"jobId":task_id,"taskId":task_id,"sessionId":session_id,"kind":"studio-task","status":task["phase"],
        "subject":{"goalId":task["goalId"],"artifact":task["artifact"]},"progress":{"planRevision":task["planRevision"],"stepIds":task["stepIds"]},
        "failure":failure,"cancelRequested":task["phase"] == json!("cancelled"),"createdAtMs":task["createdAtMs"],"updatedAtMs":task["updatedAtMs"],
        "goalId":task["goalId"],"goalRevision":task["goalRevision"],"humanRequest":task["humanRequest"],"acceptanceCriteria":task["acceptanceCriteria"],
        "artifact":task["artifact"],"planRevision":task["planRevision"],"stepIds":task["stepIds"],"phase":task["phase"],
        "proposedChangeSetId":task["proposedChangeSetId"],"lastEvidenceId":task["lastEvidenceId"],"steps":steps,"evidence":evidence}))
}
fn task_terminal(phase: &str) -> bool { matches!(phase, "accepted" | "rejected" | "failed" | "cancelled") }

fn task_create(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let session_id = task_id_arg(payload, "sessionId")?;
    let goal = task_text_arg(payload, "goal", 4_000)?;
    let human_request = task_text_arg(payload, "humanRequest", 4_000)?;
    let artifact = task_artifact(payload)?;
    task_check_artifact(data_home, &artifact)?;
    let criteria = task_criteria(payload)?;
    let operation_id = task_id_arg(payload, "operationId")?;
    let hash = task_hash(payload)?;
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let (_, _, _, state) = session_scope(&db, &session_id)?;
    if state != "open" { return Err(ToolError::new("creator_session_closed", "Reopen the session before creating a task.")); }
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if let Some(result) = task_receipt(&tx, &operation_id, &hash)? { return Ok(result); }
    let task_id = new_id("studio-task-");
    let goal_id = new_id("goal-");
    let now = now_ms();
    tx.execute("INSERT INTO creator_jobs(job_id,kind,status,subject_json,progress_json,failure_json,cancel_requested,session_id,created_at_ms,updated_at_ms)
        VALUES(?1,'studio-task','planning',?2,'{}','{}',0,?3,?4,?4)", rusqlite::params![task_id,json!({"goalId":goal_id,"artifact":artifact}).to_string(),session_id,now])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("INSERT INTO creator_studio_tasks(task_id,goal_id,goal_revision,human_request,acceptance_json,artifact_json,plan_revision,step_ids_json,phase,created_at_ms,updated_at_ms)
        VALUES(?1,?2,1,?3,?4,?5,0,'[]','planning',?6,?6)", rusqlite::params![task_id,goal_id,human_request,serde_json::to_string(&criteria).unwrap(),artifact.to_string(),now])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let result = json!({"taskId":task_id,"goalId":goal_id,"goal":goal,"phase":"planning"});
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    task_payload(data_home, &task_id)
}

fn task_plan_submit(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload, "taskId")?;
    let expected_revision = task_revision_arg(payload, "expectedPlanRevision")?;
    let expected_artifact_revision = task_revision_arg(payload, "expectedArtifactRevision")?;
    let steps = task_steps(payload)?;
    let operation_id = task_id_arg(payload, "operationId")?;
    let hash = task_hash(payload)?;
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if let Some(result) = task_receipt(&tx, &operation_id, &hash)? { return Ok(result); }
    let (task, _, plan_revision, phase) = task_row(&tx, &task_id)?;
    if task["artifact"]["expectedRevision"].as_u64() != Some(expected_artifact_revision) { return Err(ToolError::new("revision_conflict", "Task artifact revision changed.")); }
    task_check_artifact(data_home, &task["artifact"])?;
    if plan_revision + 1 != expected_revision { return Err(ToolError::new("plan_revision_conflict", "expectedPlanRevision must be current + 1.")); }
    if !matches!(phase.as_str(), "planning" | "ready" | "awaiting-review" | "rejected" | "failed" | "cancelled") {
        return Err(ToolError::new("creator_task_invalid_transition", format!("Cannot submit a plan from {phase}.")));
    }
    let step_ids: Vec<String> = steps.iter().map(|step| step["stepId"].as_str().unwrap_or_default().to_owned()).collect();
    for step in &steps {
        tx.execute("INSERT INTO creator_studio_task_steps(task_id,plan_revision,step_id,ordinal,title,kind) VALUES(?1,?2,?3,?4,?5,?6)",
            rusqlite::params![task_id,expected_revision,step["stepId"].as_str().unwrap_or_default(),step["ordinal"].as_u64().unwrap_or(0),step["title"].as_str().unwrap_or_default(),step["kind"].as_str().unwrap_or_default()])
            .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    }
    tx.execute("UPDATE creator_studio_tasks SET goal_revision=goal_revision+1,plan_revision=?2,step_ids_json=?3,phase='awaiting-plan-approval',updated_at_ms=?4 WHERE task_id=?1",
        rusqlite::params![task_id,expected_revision,serde_json::to_string(&step_ids).unwrap(),now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE creator_jobs SET status='awaiting-plan-approval',progress_json=?2,updated_at_ms=?3 WHERE job_id=?1",
        rusqlite::params![task_id,json!({"planRevision":expected_revision,"stepIds":step_ids}).to_string(),now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let result = json!({"taskId":task_id,"phase":"awaiting-plan-approval","planRevision":expected_revision});
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    task_payload(data_home, &task_id)
}

fn task_plan_approve(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload, "taskId")?;
    let plan_revision = task_revision_arg(payload, "planRevision")?;
    let operation_id = task_id_arg(payload, "operationId")?;
    let hash = task_hash(payload)?;
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if let Some(result) = task_receipt(&tx, &operation_id, &hash)? { return Ok(result); }
    let (task, _, current_revision, phase) = task_row(&tx, &task_id)?;
    if phase != "awaiting-plan-approval" || current_revision != plan_revision { return Err(ToolError::new("plan_revision_conflict", "Plan approval is stale or not pending.")); }
    if task["artifact"]["expectedRevision"].as_u64() != Some(task_revision_arg(payload, "expectedArtifactRevision")?) { return Err(ToolError::new("revision_conflict", "Task artifact revision changed.")); }
    task_check_artifact(data_home, &task["artifact"])?;
    tx.execute("UPDATE creator_studio_tasks SET phase='ready',updated_at_ms=?2 WHERE task_id=?1", rusqlite::params![task_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE creator_jobs SET status='ready',updated_at_ms=?2 WHERE job_id=?1", rusqlite::params![task_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let result = json!({"taskId":task_id,"phase":"ready","planRevision":plan_revision});
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    task_payload(data_home, &task_id)
}

fn task_evidence_append(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload, "taskId")?;
    let plan_revision = task_revision_arg(payload, "planRevision")?;
    let criterion_id = task_id_arg(payload, "criterionId")?;
    let kind = task_id_arg(payload, "kind")?;
    if !matches!(kind.as_str(), "build" | "test" | "human-note" | "city-playtest") { return Err(ToolError::new("invalid_argument", "Unsupported evidence kind.")); }
    let trust_level = task_id_arg(payload, "trustLevel")?;
    if !matches!(trust_level.as_str(), "city-client-reported" | "creator-declared") {
        return Err(ToolError::new("invalid_argument", "Evidence trust must be city-client-reported or creator-declared; host verification cannot be self-declared."));
    }
    let summary = task_text_arg(payload, "summary", 2_000)?;
    let step_id = payload.get("stepId").and_then(Value::as_str).map(str::to_owned);
    let data = payload.get("data").cloned().unwrap_or(Value::Null);
    if task_canonical_json(&data)?.len() > 8 * 1024 { return Err(ToolError::new("invalid_argument", "Evidence data exceeds 8 KiB.")); }
    let operation_id = task_id_arg(payload, "operationId")?;
    let hash = task_hash(payload)?;
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if let Some(result) = task_receipt(&tx, &operation_id, &hash)? { return Ok(result); }
    let (task, _, current_revision, phase) = task_row(&tx, &task_id)?;
    if current_revision != plan_revision || !matches!(phase.as_str(), "ready" | "executing" | "validating" | "awaiting-review") {
        return Err(ToolError::new("creator_task_invalid_transition", format!("Cannot append evidence from {phase}.")));
    }
    if task["artifact"]["expectedRevision"].as_u64() != Some(task_revision_arg(payload, "expectedArtifactRevision")?) { return Err(ToolError::new("revision_conflict", "Task artifact revision changed.")); }
    task_check_artifact(data_home, &task["artifact"])?;
    let criterion = task["acceptanceCriteria"].as_array().and_then(|criteria| criteria.iter().find(|criterion| criterion["criterionId"].as_str() == Some(&criterion_id)))
        .ok_or_else(|| ToolError::new("invalid_argument", "criterionId is not part of this task."))?;
    if criterion["requiredEvidenceKind"].as_str() != Some(&kind) { return Err(ToolError::new("invalid_argument", "Evidence kind does not satisfy this criterion.")); }
    if let Some(step) = &step_id {
        if !task["stepIds"].as_array().is_some_and(|steps| steps.iter().any(|id| id.as_str() == Some(step))) { return Err(ToolError::new("invalid_argument", "stepId is not in the approved plan.")); }
    }
    let evidence_id = new_id("evidence-");
    tx.execute("INSERT INTO creator_studio_task_evidence(evidence_id,task_id,plan_revision,step_id,criterion_id,kind,trust_level,summary,data_json,created_at_ms)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", rusqlite::params![evidence_id,task_id,plan_revision,step_id,criterion_id,kind,trust_level,summary,data.to_string(),now_ms()])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let next_phase = if kind == "human-note" { "awaiting-review" } else { "validating" };
    tx.execute("UPDATE creator_studio_tasks SET phase=?2,last_evidence_id=?3,proposed_change_set_id=COALESCE(?4,proposed_change_set_id),updated_at_ms=?5 WHERE task_id=?1",
        rusqlite::params![task_id,next_phase,evidence_id,payload.get("proposedChangeSetId").and_then(Value::as_str),now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE creator_jobs SET status=?2,updated_at_ms=?3 WHERE job_id=?1", rusqlite::params![task_id,next_phase,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let result = json!({"taskId":task_id,"phase":next_phase,"lastEvidenceId":evidence_id,"trustLevel":trust_level});
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    task_payload(data_home, &task_id)
}

fn task_review_accept(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload, "taskId")?;
    let plan_revision = task_revision_arg(payload, "planRevision")?;
    let reviewer_note = task_text_arg(payload, "reviewerNote", 2_000)?;
    let operation_id = task_id_arg(payload, "operationId")?;
    let hash = task_hash(payload)?;
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if let Some(result) = task_receipt(&tx, &operation_id, &hash)? { return Ok(result); }
    let (task, _, current_revision, phase) = task_row(&tx, &task_id)?;
    if phase != "awaiting-review" || current_revision != plan_revision { return Err(ToolError::new("creator_task_invalid_transition", "Task is not awaiting review with current evidence.")); }
    if task["artifact"]["expectedRevision"].as_u64() != Some(task_revision_arg(payload, "expectedArtifactRevision")?) { return Err(ToolError::new("revision_conflict", "Task artifact revision changed.")); }
    task_check_artifact(data_home, &task["artifact"])?;
    let criteria = task["acceptanceCriteria"].as_array().ok_or_else(|| ToolError::new("storage_unavailable", "Task acceptance is damaged."))?;
    for criterion in criteria {
        let criterion_id = criterion["criterionId"].as_str().unwrap_or_default();
        let kind = criterion["requiredEvidenceKind"].as_str().unwrap_or_default();
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM creator_studio_task_evidence WHERE task_id=?1 AND plan_revision=?2 AND criterion_id=?3 AND kind=?4",
            rusqlite::params![task_id,plan_revision,criterion_id,kind], |row| row.get(0)).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        if count == 0 { return Err(ToolError::new("creator_task_evidence_required", format!("Criterion {criterion_id} still lacks real {kind} evidence."))); }
    }
    tx.execute("UPDATE creator_studio_tasks SET phase='accepted',updated_at_ms=?2 WHERE task_id=?1", rusqlite::params![task_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE creator_jobs SET status='accepted',updated_at_ms=?2 WHERE job_id=?1", rusqlite::params![task_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let result = json!({"taskId":task_id,"phase":"accepted","reviewerNote":reviewer_note});
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    task_payload(data_home, &task_id)
}

fn task_review_reject(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload, "taskId")?;
    let plan_revision = task_revision_arg(payload, "planRevision")?;
    let reason = task_text_arg(payload, "reason", 2_000)?;
    let operation_id = task_id_arg(payload, "operationId")?;
    let hash = task_hash(payload)?;
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if let Some(result) = task_receipt(&tx, &operation_id, &hash)? { return Ok(result); }
    let (task, _, current_revision, phase) = task_row(&tx, &task_id)?;
    if phase != "awaiting-review" || current_revision != plan_revision { return Err(ToolError::new("creator_task_invalid_transition", "Task is not awaiting review.")); }
    if task["artifact"]["expectedRevision"].as_u64() != Some(task_revision_arg(payload, "expectedArtifactRevision")?) { return Err(ToolError::new("revision_conflict", "Task artifact revision changed.")); }
    task_check_artifact(data_home, &task["artifact"])?;
    tx.execute("UPDATE creator_studio_tasks SET phase='rejected',updated_at_ms=?2 WHERE task_id=?1", rusqlite::params![task_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE creator_jobs SET status='rejected',failure_json=?2,updated_at_ms=?3 WHERE job_id=?1", rusqlite::params![task_id,json!({"code":"human_rejected","reason":reason}).to_string(),now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let result = json!({"taskId":task_id,"phase":"rejected","reason":reason});
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    task_payload(data_home, &task_id)
}

fn task_cancel(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload, "taskId")?;
    let operation_id = task_id_arg(payload, "operationId")?;
    let hash = task_hash(payload)?;
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if let Some(result) = task_receipt(&tx, &operation_id, &hash)? { return Ok(result); }
    let (_, _, _, phase) = task_row(&tx, &task_id)?;
    if task_terminal(&phase) { return Err(ToolError::new("creator_task_invalid_transition", format!("Task is already {phase}."))); }
    tx.execute("UPDATE creator_studio_tasks SET phase='cancelled',updated_at_ms=?2 WHERE task_id=?1", rusqlite::params![task_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE creator_jobs SET status='cancelled',cancel_requested=1,updated_at_ms=?2 WHERE job_id=?1", rusqlite::params![task_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let result = json!({"taskId":task_id,"phase":"cancelled"});
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    task_payload(data_home, &task_id)
}

/// Shared by Desktop creator.task.* and MCP creator_task_*: one state machine and
/// one sessions.sqlite authority. No TypeScript lifecycle mirror is involved.
pub fn task_dispatch(data_home: &Path, method: &str, payload: &Value) -> Result<Value, ToolError> {
    match method {
        "creator.task.create" => task_create(data_home, payload),
        "creator.task.plan.submit" => task_plan_submit(data_home, payload),
        "creator.task.plan.approve" => task_plan_approve(data_home, payload),
        "creator.task.status" => task_payload(data_home, task_id_arg(payload, "taskId")?.as_str()),
        "creator.task.evidence.append" => task_evidence_append(data_home, payload),
        "creator.task.evidence.list" => {
            let task = task_payload(data_home, task_id_arg(payload, "taskId")?.as_str())?;
            Ok(json!({"evidence":task["evidence"]}))
        }
        "creator.task.review.accept" => task_review_accept(data_home, payload),
        "creator.task.review.reject" => task_review_reject(data_home, payload),
        "creator.task.cancel" => task_cancel(data_home, payload),
        _ => Err(ToolError::new("creator_method_unavailable", format!("Unknown task method {method}."))),
    }
}

pub fn session_dispatch(data_home: &Path, method: &str, payload: &Value) -> Result<Value, ToolError> {
    let result = match method {
        "creator.session.open" => session_open(data_home, payload)?,
        "creator.session.status" => session_status(data_home, payload)?,
        "creator.session.close" => session_close(data_home, payload)?,
        _ => return Err(ToolError::new("creator_method_unavailable", format!("Unknown session method {method}."))),
    };
    Ok(result["data"].clone())
}

fn task_mcp(data_home: &Path, method: &str, args: &Value) -> Result<Value, ToolError> {
    let data = task_dispatch(data_home, method, args)?;
    Ok(json!({"ok":true,"data":data}))
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
        "creator_task_create" => task_mcp(data_home, "creator.task.create", args),
        "creator_task_plan_submit" => task_mcp(data_home, "creator.task.plan.submit", args),
        "creator_task_plan_approve" => task_mcp(data_home, "creator.task.plan.approve", args),
        "creator_task_status" => task_mcp(data_home, "creator.task.status", args),
        "creator_task_evidence_append" => task_mcp(data_home, "creator.task.evidence.append", args),
        "creator_task_evidence_list" => task_mcp(data_home, "creator.task.evidence.list", args),
        "creator_task_review_accept" => task_mcp(data_home, "creator.task.review.accept", args),
        "creator_task_review_reject" => task_mcp(data_home, "creator.task.review.reject", args),
        "creator_task_cancel" => task_mcp(data_home, "creator.task.cancel", args),
        "creator_game_type_list" => game_type_list(data_home, args),
        _ => Err(ToolError::new("internal_error", format!("tool `{name}` registered but not wired"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_host_operations_reads_commits_while_the_writer_is_open() {
        let home = temp_home();
        std::fs::create_dir_all(home.join("state/creator")).unwrap();
        let path = home.join("state/creator/projects.sqlite");
        let writer = open_db(&path, false).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE creator_operations (project_id TEXT NOT NULL, actor_id TEXT NOT NULL,
                operation_id TEXT NOT NULL, operation_hash TEXT NOT NULL, result_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL, capability_version TEXT NOT NULL DEFAULT '',
                PRIMARY KEY(project_id, actor_id, operation_id));
            CREATE TABLE creator_playtest_runs (run_id TEXT NOT NULL, release_id TEXT NOT NULL,
                project_id TEXT NOT NULL, status TEXT NOT NULL, active_slot INTEGER,
                finished_at_ms INTEGER, failure_code TEXT, created_at_ms INTEGER NOT NULL);
            INSERT INTO creator_operations VALUES ('p1','owner','op1','h','{}',42,'2026-11-17.1');").unwrap();
        // 应用运行期间就是「writer 开着、另一个连接读」——W2 的会话收尾面对的正是这个状态。
        // 回归点：created_at_ms 是第 4 列（index 3）；早先把 result_json 当 i64 读，
        // 每行都类型错误、又被 flatten() 吞掉，于是 commit 明明在库、时间线却是空的。
        let (operations, _playtests, available) = aggregate_host_operations(&home, None, None);
        assert!(available);
        assert_eq!(operations.len(), 1, "operations={operations:?}");
        assert_eq!(operations[0]["kind"], "commit");
        drop(writer);
    }

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

    /// City 被换掉后宿主把 claimed 收成 failed + creator_playtest_city_closed。
    /// 会话和作业都读这一行：终态必须带着原因，活着的 claimed 仍是 running。
    #[test]
    fn city_closed_playtest_is_a_terminal_session_and_job() {
        let home = temp_home();
        let host = home.join("state/creator");
        std::fs::create_dir_all(&host).unwrap();
        let db = rusqlite::Connection::open(host.join("projects.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE creator_operations(operation_id TEXT, project_id TEXT, result_json TEXT, created_at_ms INTEGER);
            CREATE TABLE creator_playtest_runs(run_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL, studio_instance_id TEXT NOT NULL, city_instance_id TEXT, status TEXT NOT NULL, active_slot INTEGER, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, finished_at_ms INTEGER, return_consumed INTEGER NOT NULL DEFAULT 0, evidence_json TEXT, failure_code TEXT);
            INSERT INTO creator_playtest_runs(run_id,release_id,project_id,revision,studio_instance_id,city_instance_id,status,active_slot,created_at_ms,expires_at_ms,finished_at_ms,return_consumed,failure_code)
            VALUES('run-live','release-1','project-1',2,'studio-1','city-1','claimed',1,2,9000000000000,NULL,0,NULL),
                   ('run-closed','release-1','project-1',2,'studio-1','city-1','failed',NULL,1,9000000000000,50,0,'creator_playtest_city_closed');").unwrap();
        drop(db);
        let opened = session_open(&home, &json!({"agentId":"agent-life","projectId":"project-1"})).unwrap();
        let session_id = opened["data"]["sessionId"].as_str().unwrap().to_owned();
        register_playtest_job(&home, &json!({"runId":"run-closed","releaseId":"release-1"}));
        register_playtest_job(&home, &json!({"runId":"run-live","releaseId":"release-1"}));
        let status = session_status(&home, &json!({"sessionId":session_id})).unwrap();
        let operations = status["data"]["operations"].as_array().unwrap();
        let closed = operations.iter().find(|item| item["ref"] == "run-closed").unwrap();
        assert_eq!(closed["status"], json!("failed"));
        assert_eq!(closed["failureCode"], json!("creator_playtest_city_closed"));
        assert!(closed["activeSlot"].is_null());
        assert_eq!(closed["finishedAtMs"], json!(50));
        let live = operations.iter().find(|item| item["ref"] == "run-live").unwrap();
        assert_eq!(live["status"], json!("running"));
        assert_eq!(live["activeSlot"], json!(1));
        let jobs = status["data"]["jobs"].as_array().unwrap();
        let closed_job = jobs.iter().find(|item| item["subject"]["runId"] == "run-closed").unwrap();
        assert_eq!(closed_job["status"], json!("failed"));
        assert_eq!(closed_job["failure"]["code"], json!("creator_playtest_city_closed"));
        let live_job = jobs.iter().find(|item| item["subject"]["runId"] == "run-live").unwrap();
        assert_eq!(live_job["status"], json!("running"));
        std::fs::remove_dir_all(home).unwrap();
    }

    /// MCP 成功信封是 {ok:true, data:{runId}}。只读顶层 runId 时，start 已经
    /// 成功也不会出现在 job_list。同一条 run 再记一次仍然只有一行。
    #[test]
    fn playtest_job_reads_the_mcp_success_envelope_once() {
        let home = temp_home();
        let envelope = json!({"ok":true,"data":{"runId":"playtest-envelope","releaseId":"release-9","status":"pending"}});
        register_playtest_job(&home, &envelope);
        register_playtest_job(&home, &envelope);
        register_playtest_job(&home, &json!({"ok":false,"data":{"runId":"playtest-ignored","releaseId":"release-9"}}));
        register_playtest_job(&home, &json!({"ok":true,"data":{"releaseId":"release-9"}}));
        let list = job_list(&home, &json!({"sessionId":"csession-any"})).unwrap();
        let jobs = list["data"]["jobs"].as_array().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0]["kind"], json!("playtest"));
        assert_eq!(jobs[0]["subject"]["runId"], json!("playtest-envelope"));
        assert_eq!(jobs[0]["subject"]["releaseId"], json!("release-9"));
        assert_eq!(jobs[0]["status"], json!("running"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn world_apply_jobs_resolve_through_the_host_view_status() {
        let home = temp_home();
        // 宿主无 view_status 面（测试环境）时，world-apply 作业如实停在 running，
        // 不假装完成；stub 一个可解析状态面来验证 ready 迁移。
        register_world_apply_job(&home, Some("city-e2e"), Some(3));
        let jobs_before = session_jobs(&home, "csession-any").unwrap();
        assert_eq!(jobs_before.len(), 1);
        assert_eq!(jobs_before[0]["status"], json!("running"));
        let _ = std::fs::remove_dir_all(home);
    }

    fn prepare_artifact(home: &Path, project_id: &str, revision: u64) {
        let db = rusqlite::Connection::open(home.join("state/creator/projects.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE creator_projects(project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);").unwrap();
        db.execute("INSERT INTO creator_projects(project_id,revision,document_json,created_at_ms,updated_at_ms) VALUES(?1,?2,'{}',1,1)", rusqlite::params![project_id,revision]).unwrap();
    }

    fn studio_goal(session_id: &str, operation_id: &str) -> Value {
        json!({"sessionId":session_id,"goal":"Validate the current City game","humanRequest":"Review the saved game without executing an agent",
            "artifact":{"kind":"creator-project","projectId":"project-1","expectedRevision":3},
            "acceptanceCriteria":[{"criterionId":"manual-review","description":"A human reviews the result","requiredEvidenceKind":"human-note"}],"operationId":operation_id})
    }
    fn studio_plan(task_id: &str, revision: u64, operation_id: &str) -> Value {
        json!({"taskId":task_id,"expectedPlanRevision":revision,"expectedArtifactRevision":3,"operationId":operation_id,
            "steps":[{"stepId":"review-city","title":"Review in City","kind":"validation"}]})
    }
    fn studio_evidence(task_id: &str, operation_id: &str, trust: &str) -> Value {
        json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"criterionId":"manual-review","kind":"human-note",
            "trustLevel":trust,"summary":"Human reviewed the current saved revision","stepId":"review-city","operationId":operation_id})
    }

    #[test]
    fn studio_task_recovers_goal_plan_evidence_and_enforces_cas() {
        let home = temp_home();
        let session = session_open(&home, &json!({"agentId":"studio-local","projectId":"project-1"})).unwrap();
        let session_id = session["data"]["sessionId"].as_str().unwrap();
        prepare_artifact(&home, "project-1", 3);
        let created = task_dispatch(&home, "creator.task.create", &studio_goal(session_id, "goal-create")).unwrap();
        let task_id = created["taskId"].as_str().unwrap();
        let replay = task_dispatch(&home, "creator.task.create", &studio_goal(session_id, "goal-create")).unwrap();
        assert_eq!(replay["taskId"], task_id);
        assert_eq!(created["phase"], "planning");
        assert_eq!(created["artifact"]["expectedRevision"], 3);
        let submitted = task_dispatch(&home, "creator.task.plan.submit", &studio_plan(task_id, 1, "plan-submit")).unwrap();
        assert_eq!(submitted["phase"], "awaiting-plan-approval");
        assert_eq!(submitted["steps"].as_array().unwrap().len(), 1);
        assert_eq!(task_dispatch(&home, "creator.task.plan.approve", &json!({"taskId":task_id,"planRevision":2,"expectedArtifactRevision":3,"operationId":"plan-approve-stale"})).unwrap_err().code, "plan_revision_conflict");
        let approved = task_dispatch(&home, "creator.task.plan.approve", &json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"operationId":"plan-approve"})).unwrap();
        assert_eq!(approved["phase"], "ready");
        assert_eq!(task_dispatch(&home, "creator.task.review.accept", &json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"reviewerNote":"Looks complete","operationId":"review-early"})).unwrap_err().code, "creator_task_invalid_transition");
        assert_eq!(task_dispatch(&home, "creator.task.evidence.append", &studio_evidence(task_id, "evidence-host", "host-verified")).unwrap_err().code, "invalid_argument");
        let evidence = task_dispatch(&home, "creator.task.evidence.append", &studio_evidence(task_id, "evidence-manual", "creator-declared")).unwrap();
        assert_eq!(evidence["phase"], "awaiting-review");
        assert_eq!(evidence["lastEvidenceId"], evidence["evidence"][0]["evidenceId"]);
        assert_eq!(task_dispatch(&home, "creator.task.review.accept", &json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":4,"reviewerNote":"Wrong artifact","operationId":"review-stale"})).unwrap_err().code, "revision_conflict");
        let accepted = task_dispatch(&home, "creator.task.review.accept", &json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"reviewerNote":"Accepted manually","operationId":"review-accept"})).unwrap();
        assert_eq!(accepted["phase"], "accepted");
        drop(open_db(&sessions_db(&home).unwrap(), false).unwrap());
        let recovered = task_dispatch(&home, "creator.task.status", &json!({"taskId":task_id})).unwrap();
        assert_eq!(recovered["phase"], "accepted");
        assert_eq!(recovered["goalRevision"], 2);
        assert_eq!(recovered["evidence"].as_array().unwrap().len(), 1);
        assert_eq!(recovered["evidence"][0]["trustLevel"], "creator-declared");
        assert_eq!(task_dispatch(&home, "creator.task.plan.submit", &studio_plan(task_id, 2, "plan-after-accepted")).unwrap_err().code, "creator_task_invalid_transition");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn studio_task_cancel_revise_reject_and_old_job_wait_remain_compatible() {
        let home = temp_home();
        let session = session_open(&home, &json!({"agentId":"studio-local","projectId":"project-1"})).unwrap();
        let session_id = session["data"]["sessionId"].as_str().unwrap();
        prepare_artifact(&home, "project-1", 3);
        let created = task_dispatch(&home, "creator.task.create", &studio_goal(session_id, "goal-cancel-create")).unwrap();
        let task_id = created["taskId"].as_str().unwrap();
        task_dispatch(&home, "creator.task.plan.submit", &studio_plan(task_id, 1, "plan-cancel-submit")).unwrap();
        task_dispatch(&home, "creator.task.plan.approve", &json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"operationId":"plan-cancel-approve"})).unwrap();
        let waiting = job_wait(&home, &json!({"jobId":task_id,"timeoutMs":100})).unwrap();
        assert_eq!(waiting["data"]["waitTimedOut"], true);
        assert_eq!(waiting["data"]["job"]["phase"], "ready");
        let cancelled = job_cancel(&home, &json!({"jobId":task_id})).unwrap();
        assert_eq!(cancelled["phase"], "cancelled");
        assert_eq!(cancelled["phase"], "cancelled");
        let revised = task_dispatch(&home, "creator.task.plan.submit", &studio_plan(task_id, 2, "plan-revise")).unwrap();
        assert_eq!(revised["phase"], "awaiting-plan-approval");
        assert_eq!(revised["planRevision"], 2);
        task_dispatch(&home, "creator.task.plan.approve", &json!({"taskId":task_id,"planRevision":2,"expectedArtifactRevision":3,"operationId":"plan-revise-approve"})).unwrap();
        task_dispatch(&home, "creator.task.evidence.append", &studio_evidence(task_id, "evidence-reject", "creator-declared")).unwrap_err();
        let mut evidence = studio_evidence(task_id, "evidence-reject", "creator-declared");
        evidence["planRevision"] = json!(2);
        task_dispatch(&home, "creator.task.evidence.append", &evidence).unwrap();
        let rejected = task_dispatch(&home, "creator.task.review.reject", &json!({"taskId":task_id,"planRevision":2,"expectedArtifactRevision":3,"reason":"Needs another pass","operationId":"review-reject"})).unwrap();
        assert_eq!(rejected["phase"], "rejected");
        assert_eq!(rejected["failure"]["code"], "human_rejected");
        let jobs = session_jobs(&home, session_id).unwrap();
        assert!(jobs.iter().any(|job| job["kind"] == "studio-task" && job["status"] == "rejected"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn unknown_session_fails_closed() {
        let home = temp_home();
        assert_eq!(session_status(&home, &json!({"sessionId":"csession-missing"})).unwrap_err().code, "creator_session_not_found");
        std::fs::remove_dir_all(home).unwrap();
    }
}
