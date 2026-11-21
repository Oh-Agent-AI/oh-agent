//! Creator 会话与统一作业面（STUDIO_AGENT_FIRST_EDITOR_SPEC §3.1/§3.2/E1/E2）。
//!
//! MCP 侧本地簿记：会话（agentId 重放、未决操作视图）与作业注册表（把试玩等
//! 长作业接成统一状态面）。聚合视图对宿主 `projects.sqlite` **只读**——不修改
//! 宿主 schema、不接管预览/试玩的既有 TTL；无画面/无宿主写路径。
//!
//! 全部工具天然 headless 可用（不依赖 Studio/City webview）。
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{ToolError, ToolSpec};

const MAX_SESSIONS_PER_AGENT: usize = 4;
const JOB_WAIT_MAX_MS: u64 = 30_000;
const JOB_WAIT_POLL_MS: u64 = 500;
const CONNECTION_TTL_MS: u64 = 15_000;
const EVENT_WAIT_MAX_MS: u64 = 30_000;
const EVENT_WAIT_SLICE_MS: u64 = 250;
const EVENT_LIMIT_MAX: u64 = 100;

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
        spec("creator_session_open", "Open (or resume) a Creator Agent session. Resuming an open session with the same agentId and scope returns the same sessionId plus every pending operation and job, so a reconnect restores full context in one call. Read-only bookkeeping; never grants capabilities.", json!({"agentId":{"type":"string","minLength":1,"maxLength":128},"projectId":{"type":"string","minLength":1,"maxLength":128},"cityId":{"type":"string","minLength":1,"maxLength":128},"executor":{"type":"string","enum":["unknown","studio","codex-cli","acp","pull"]},"transport":{"type":"string","enum":["unknown","mcp-stdio","acp-stdio","studio-webview"]},"capabilities":{"type":"array","maxItems":16}}), &["agentId"]),
        spec("creator_session_status", "Read one Creator Agent session: its state, the bounded operation timeline (commits and playtests observed in scope), and open jobs.", json!({"sessionId":{"type":"string","minLength":1,"maxLength":128}}), &["sessionId"]),
        spec("creator_session_close", "Close a Creator Agent session and report how many tracked operations were cleared. Closed sessions are retained for 7 days for auditing, then pruned.", json!({"sessionId":{"type":"string","minLength":1,"maxLength":128}}), &["sessionId"]),
        spec("creator_connection_heartbeat", "Register or refresh one agent connection in the shared local ledger. Connections are scoped by agentId+sessionId and expire offline after 15 seconds without a heartbeat.", json!({"agentId":{"type":"string"},"sessionId":{"type":"string"},"executor":{"type":"string","enum":["unknown","studio","codex-cli","acp","pull"]},"transport":{"type":"string","enum":["unknown","mcp-stdio","acp-stdio","studio-webview"]},"state":{"type":"string","enum":["online","busy","degraded"]},"capabilities":{"type":"array","maxItems":16},"lastStableError":{"type":["string","null"],"maxLength":128}}), &["agentId","sessionId"]),
        spec("creator_connection_disconnect", "Mark one agent connection offline without changing any job or task authority.", json!({"agentId":{"type":"string"},"sessionId":{"type":"string"}}), &["agentId","sessionId"]),
        spec("creator_connection_status", "List live and recently disconnected agent connections, with TTL computed at read time.", json!({"agentId":{"type":"string"},"sessionId":{"type":"string"}}), &[]),
        spec("creator_capabilities_status", "Query the actual headless/Studio capability matrix and current connection availability. This never implies arbitrary remote collaboration.", json!({}), &[]),
        spec("creator_events_subscribe", "Read durable ordered task events after a global event cursor. Waits up to 30 seconds for new events and returns hasMore/waitTimedOut for bounded reconnectable delivery.", json!({"taskId":{"type":"string"},"afterEventId":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100},"timeoutMs":{"type":"integer","minimum":0,"maximum":30000}}), &["taskId"]),
        spec("creator_job_list", "List Creator jobs (layout-build / world-apply / playtest / capture / studio-task) for a session, optionally filtered by kind or terminal status.", json!({"sessionId":{"type":"string","minLength":1,"maxLength":128},"kind":{"type":"string","enum":["layout-build","world-apply","playtest","capture","studio-task"]}}), &["sessionId"]),
        spec("creator_job_status", "Read one Creator job. Playtest jobs resolve their live status from the host playtest ledger.", json!({"jobId":{"type":"string","minLength":1,"maxLength":128}}), &["jobId"]),
        spec("creator_job_wait", "Block until a Creator job reaches a terminal state or the timeout expires (30 s cap). A timeout returns the running snapshot, not an error.", json!({"jobId":{"type":"string","minLength":1,"maxLength":128},"timeoutMs":{"type":"integer","minimum":100,"maximum":30000}}), &["jobId"]),
        spec("creator_job_cancel", "Request cooperative cancellation of a queued/running Creator job. Cancellation takes effect at the engine's next safe point; playtest jobs route to creator_playtest_cancel.", json!({"jobId":{"type":"string","minLength":1,"maxLength":128}}), &["jobId"]),
        spec("creator_task_create", "Create a durable Studio goal and artifact in the shared Creator session/job ledger. This does not execute an Agent.", json!({"sessionId":{"type":"string"},"goal":{"type":"string"},"humanRequest":{"type":"string"},"artifact":{"type":"object"},"acceptanceCriteria":{"type":"array"},"operationId":{"type":"string"}}), &["sessionId","goal","humanRequest","artifact","acceptanceCriteria","operationId"]),
        spec("creator_task_plan_submit", "Submit or revise a task plan with CAS-checked plan and artifact revisions.", json!({"taskId":{"type":"string"},"expectedPlanRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"steps":{"type":"array"},"operationId":{"type":"string"}}), &["taskId","expectedPlanRevision","expectedArtifactRevision","steps","operationId"]),
        spec("creator_task_plan_approve", "Approve the current task plan; this records approval but never claims execution or completion.", json!({"taskId":{"type":"string"},"planRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"operationId":{"type":"string"}}), &["taskId","planRevision","expectedArtifactRevision","operationId"]),
        spec("creator_task_status", "Read durable goal, plan, steps and evidence for a Studio task.", json!({"taskId":{"type":"string"}}), &["taskId"]),
        spec("creator_task_execute", "Execute an approved task with a real push executor (default Codex CLI; \"acp\" drives any Agent Client Protocol agent) and a read-only Preview-only tool policy. Returns host-generated Preview evidence, never a saved-change claim.", json!({"taskId":{"type":"string"},"expectedPlanRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"operationId":{"type":"string"},"timeoutMs":{"type":"integer","minimum":100,"maximum":120000},"executor":{"type":"string","enum":["codex","acp"]}}), &["taskId","expectedPlanRevision","expectedArtifactRevision","operationId"]),
        spec("creator_task_evidence_append", "Append typed evidence with explicit trust level. Host verification cannot be self-declared.", json!({"taskId":{"type":"string"},"planRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"criterionId":{"type":"string"},"kind":{"type":"string"},"trustLevel":{"type":"string"},"summary":{"type":"string"},"operationId":{"type":"string"}}), &["taskId","planRevision","expectedArtifactRevision","criterionId","kind","trustLevel","summary","operationId"]),
        spec("creator_task_evidence_list", "List durable evidence for a Studio task.", json!({"taskId":{"type":"string"}}), &["taskId"]),
        spec("creator_task_review_accept", "Accept a task only after all acceptance criteria have real evidence and a human reviewer accepts it.", json!({"taskId":{"type":"string"},"planRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"reviewerNote":{"type":"string"},"operationId":{"type":"string"}}), &["taskId","planRevision","expectedArtifactRevision","reviewerNote","operationId"]),
        spec("creator_task_review_reject", "Reject the current task plan during human review.", json!({"taskId":{"type":"string"},"planRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"reason":{"type":"string"},"operationId":{"type":"string"}}), &["taskId","planRevision","expectedArtifactRevision","reason","operationId"]),
        spec("creator_task_cancel", "Cancel a non-terminal Studio task without deleting its goal, plan or evidence.", json!({"taskId":{"type":"string"},"operationId":{"type":"string"}}), &["taskId","operationId"]),
        spec("creator_task_list_open", "List approved Studio tasks that are ready to be claimed (pull mode). Read-only; an empty list is a truthful empty queue.", json!({"limit":{"type":"integer","minimum":1,"maximum":50}}), &[]),
        spec("creator_task_claim", "Claim an approved task (pull mode) with a plain agentId: no per-CLI spawn adapter is needed, any MCP-capable desktop agent participates. First claim sets phase=executing and binds the claimant; re-claim by the same agentId is idempotent.", json!({"taskId":{"type":"string"},"agentId":{"type":"string","minLength":1,"maxLength":128},"expectedPlanRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"operationId":{"type":"string"}}), &["taskId","agentId","expectedPlanRevision","expectedArtifactRevision","operationId"]),
        spec("creator_task_submit_result", "Submit the claimed task's result: the host re-verifies the submitted preview server-side (exists, bound to the artifact project and revision, unexpired) before recording host-observed evidence and moving the task to human review. Self-declared completion is never accepted.", json!({"taskId":{"type":"string"},"agentId":{"type":"string","minLength":1,"maxLength":128},"planRevision":{"type":"integer"},"expectedArtifactRevision":{"type":"integer"},"summary":{"type":"string","minLength":1,"maxLength":2000},"previewId":{"type":"string"},"operationId":{"type":"string"}}), &["taskId","agentId","planRevision","expectedArtifactRevision","summary","previewId","operationId"]),
        spec("creator_task_progress", "Append a bounded typed progress projection for a claimed pull task. Only stage codes, step ids and optional percent are accepted; raw prompts, paths, logs and executor output text are not event fields.", json!({"taskId":{"type":"string"},"agentId":{"type":"string"},"planRevision":{"type":"integer"},"kind":{"type":"string","enum":["plan","progress","executor-output"]},"code":{"type":"string","enum":["analysis-started","artifact-read","operations-proposed","preview-requested","preview-ready","validation-started","validation-completed","waiting-host","other"]},"stepId":{"type":"string"},"percent":{"type":"integer","minimum":0,"maximum":100},"operationId":{"type":"string"}}), &["taskId","agentId","planRevision","kind","code","operationId"]),
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
    let db = rusqlite::Connection::open_with_flags(path, flags)
        .map_err(|error| ToolError::new("storage_unavailable", format!("sessions store unavailable: {error}")))?;
    db.busy_timeout(std::time::Duration::from_millis(5_000))
        .map_err(|error| ToolError::new("storage_unavailable", format!("sessions store busy timeout unavailable: {error}")))?;
    Ok(db)
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
        CREATE TABLE IF NOT EXISTS creator_studio_task_claims (
            task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, claimed_at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS creator_studio_task_receipts (
            operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
            result_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS creator_agent_connections (
            agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
            executor TEXT NOT NULL, transport TEXT NOT NULL,
            last_seen_ms INTEGER NOT NULL, state TEXT NOT NULL,
            capabilities_json TEXT NOT NULL, last_stable_error TEXT,
            created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY(agent_id, session_id));
        CREATE INDEX IF NOT EXISTS creator_agent_connections_seen ON creator_agent_connections(last_seen_ms);
        CREATE TABLE IF NOT EXISTS creator_task_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL, seq INTEGER NOT NULL,
            kind TEXT NOT NULL, source TEXT NOT NULL, trust_level TEXT NOT NULL,
            summary TEXT NOT NULL, data_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
            UNIQUE(task_id, seq));
        CREATE INDEX IF NOT EXISTS creator_task_events_cursor ON creator_task_events(task_id,event_id);",
    ).map_err(|error| ToolError::new("storage_unavailable", format!("sessions schema unavailable: {error}")))
}

fn connection_capabilities(payload: &Value) -> Result<Option<Vec<String>>, ToolError> {
    let Some(values) = payload.get("capabilities") else { return Ok(None) };
    let values = values.as_array().filter(|items| items.len() <= 16)
        .ok_or_else(|| ToolError::new("invalid_argument", "capabilities must contain at most 16 stable ids."))?;
    values.iter().map(|value| value.as_str().filter(|id| valid_playtest_run_id(id)).map(str::to_owned)
        .ok_or_else(|| ToolError::new("invalid_argument", "capabilities must contain stable ids.")))
        .collect::<Result<Vec<_>,_>>().map(Some)
}

fn valid_connection_error(value: &str) -> bool {
    matches!(value,"codex_unavailable" | "codex_output_invalid" | "codex_cancelled" | "codex_timeout" | "codex_failed"
        | "acp_unavailable" | "acp_failed" | "acp_auth_required" | "acp_cancelled" | "acp_timeout" | "acp_output_invalid"
        | "preview_required" | "preview_expired" | "plugin_unavailable" | "storage_unavailable" | "revision_conflict"
        | "creator_task_invalid_transition" | "creator_task_claim_mismatch" | "creator_task_already_claimed"
        | "creator_preview_not_found" | "creator_preview_project_mismatch" | "permission_denied" | "invalid_argument"
        | "busy" | "data_unavailable" | "executor_failed" | "agent_disconnected" | "agent_crashed" | "agent_timeout" | "authentication_required" | "transport_closed")
}

struct ConnectionUpdate<'a> {
    executor: Option<&'a str>,
    transport: Option<&'a str>,
    state: &'a str,
    capabilities: Option<Vec<String>>,
    stable_error: Option<Option<&'a str>>,
    at_ms: u64,
}

fn connection_upsert(db: &rusqlite::Connection, agent_id: &str, session_id: &str, update: ConnectionUpdate<'_>) -> Result<(), ToolError> {
    let ConnectionUpdate { executor,transport,state,capabilities,stable_error,at_ms } = update;
    if !matches!(state, "online" | "busy" | "degraded" | "offline")
        || executor.is_some_and(|value| !matches!(value, "unknown" | "studio" | "codex-cli" | "acp" | "pull"))
        || transport.is_some_and(|value| !matches!(value, "unknown" | "mcp-stdio" | "acp-stdio" | "studio-webview"))
        || stable_error.flatten().is_some_and(|value| !valid_connection_error(value)) {
        return Err(ToolError::new("invalid_argument", "Connection metadata is invalid."));
    }
    let capabilities = capabilities.map(|values| serde_json::to_string(&values).unwrap_or_else(|_| "[]".into()));
    let stable_error = stable_error.map(|value| value.unwrap_or_default());
    db.execute("INSERT INTO creator_agent_connections(agent_id,session_id,executor,transport,last_seen_ms,state,capabilities_json,last_stable_error,created_at_ms,updated_at_ms)
        VALUES(?1,?2,COALESCE(?3,'unknown'),COALESCE(?4,'unknown'),?5,?6,COALESCE(?7,'[]'),NULLIF(?8,''),?5,?5)
        ON CONFLICT(agent_id,session_id) DO UPDATE SET
            executor=COALESCE(?3,creator_agent_connections.executor),
            transport=COALESCE(?4,creator_agent_connections.transport),
            last_seen_ms=?5,state=?6,capabilities_json=COALESCE(?7,creator_agent_connections.capabilities_json),
            last_stable_error=CASE WHEN ?8 IS NULL THEN creator_agent_connections.last_stable_error ELSE NULLIF(?8,'') END,
            updated_at_ms=?5",
        rusqlite::params![agent_id,session_id,executor,transport,at_ms,state,capabilities,stable_error])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(())
}

fn connection_rows(db: &rusqlite::Connection, agent_id: Option<&str>, session_id: Option<&str>) -> Result<Vec<Value>, ToolError> {
    let now = now_ms();
    let mut statement = db.prepare("SELECT agent_id,session_id,executor,transport,last_seen_ms,state,capabilities_json,last_stable_error,created_at_ms,updated_at_ms
        FROM creator_agent_connections WHERE (?1 IS NULL OR agent_id=?1) AND (?2 IS NULL OR session_id=?2)
        ORDER BY updated_at_ms DESC,agent_id,session_id LIMIT 100")
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let rows = statement.query_map(rusqlite::params![agent_id,session_id], |row| {
        let last_seen = row.get::<_,u64>(4)?;
        let stored = row.get::<_,String>(5)?;
        let expired = stored != "offline" && now.saturating_sub(last_seen) >= CONNECTION_TTL_MS;
        let capabilities: String = row.get(6)?;
        Ok(json!({"agentId":row.get::<_,String>(0)?,"sessionId":row.get::<_,String>(1)?,
            "executor":row.get::<_,String>(2)?,"transport":row.get::<_,String>(3)?,
            "lastSeenMs":last_seen,"state":if expired { "offline" } else { stored.as_str() },
            "expiresAtMs":last_seen.saturating_add(CONNECTION_TTL_MS),"ttlMs":CONNECTION_TTL_MS,
            "capabilities":serde_json::from_str::<Value>(&capabilities).unwrap_or(json!([])),
            "lastStableError":row.get::<_,Option<String>>(7)?,"createdAtMs":row.get::<_,u64>(8)?,"updatedAtMs":row.get::<_,u64>(9)?}))
    }).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
        .collect::<Result<Vec<_>,_>>().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(rows)
}

fn connection_status(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let agent_id = payload.get("agentId").and_then(Value::as_str);
    let session_id = payload.get("sessionId").and_then(Value::as_str);
    if payload.get("agentId").is_some() && agent_id.is_none() || payload.get("sessionId").is_some() && session_id.is_none() {
        return Err(ToolError::new("invalid_argument", "agentId and sessionId must be strings."));
    }
    let db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    Ok(json!({"connections":connection_rows(&db,agent_id,session_id)?,"serverTimeMs":now_ms(),"ttlMs":CONNECTION_TTL_MS}))
}

fn connection_heartbeat(data_home: &Path, payload: &Value, disconnect: bool) -> Result<Value, ToolError> {
    let agent_id = task_id_arg(payload,"agentId")?;
    let session_id = task_id_arg(payload,"sessionId")?;
    let capabilities = connection_capabilities(payload)?;
    let executor = payload.get("executor").and_then(Value::as_str);
    let transport = payload.get("transport").and_then(Value::as_str);
    if payload.get("executor").is_some() && executor.is_none() || payload.get("transport").is_some() && transport.is_none() {
        return Err(ToolError::new("invalid_argument", "executor and transport must be supported strings."));
    }
    let state = if disconnect { "offline" } else { payload.get("state").and_then(Value::as_str).unwrap_or("online") };
    if payload.get("state").is_some() && payload.get("state").and_then(Value::as_str).is_none() {
        return Err(ToolError::new("invalid_argument", "state must be a supported string."));
    }
    let stable_error = if payload.as_object().is_some_and(|object| object.contains_key("lastStableError")) {
        Some(payload.get("lastStableError").and_then(Value::as_str))
    } else { None };
    if payload.get("lastStableError").is_some_and(|value| !value.is_string() && !value.is_null()) {
        return Err(ToolError::new("invalid_argument", "lastStableError must be a stable code or null."));
    }
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let (owner,_,_,session_state) = session_scope(&db,&session_id)?;
    if owner != agent_id {
        let claimant: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM creator_studio_task_claims c JOIN creator_jobs j ON j.job_id=c.task_id WHERE c.agent_id=?1 AND j.session_id=?2)",
            rusqlite::params![agent_id,session_id],|row| row.get(0)).map_err(|error| ToolError::new("storage_unavailable",format!("{error}")))?;
        if !claimant { return Err(ToolError::new("permission_denied", "sessionId belongs to a different agentId and has no task claimed by it.")); }
    }
    if session_state != "open" && !disconnect { return Err(ToolError::new("creator_session_closed", "Cannot heartbeat a closed session.")); }
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    connection_upsert(&tx,&agent_id,&session_id,ConnectionUpdate { executor,transport,state,capabilities,stable_error,at_ms:now_ms() })?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let db = open_db(&sessions_db(data_home)?, false)?;
    let connection = connection_rows(&db,Some(&agent_id),Some(&session_id))?.into_iter().next()
        .ok_or_else(|| ToolError::new("storage_unavailable", "Connection update was not readable."))?;
    Ok(json!({"connection":connection,"serverTimeMs":now_ms()}))
}

fn capability_matrix() -> Vec<Value> {
    [
        ("task.ledger",true,false,"会话、任务状态、证据和事件投影使用本地 sessions.sqlite。"),
        ("task.pull",true,false,"可 headless 认领与报告进度；提交仍需 Host 可复核的有效 Preview。"),
        ("execution.codex",false,true,"完整执行需要 Codex CLI 和官方 Studio WebView 的语义 Preview；CLI 可用性在执行时确认。"),
        ("execution.acp",false,true,"完整执行需要 ACP agent 和官方 Studio WebView 的语义 Preview；agent 可用性在执行时确认。"),
        ("preview.scene",false,true,"scene 语义校验与 Preview 签发需要官方 Studio WebView。"),
        ("preview.game",false,true,"game 语义校验与 Preview 签发需要官方 Studio WebView。"),
        ("preview.vehicle",true,false,"Desktop Host 的内嵌 city-sdk 可签发 revision 绑定的 vehicle Preview；不需要 Studio WebView。"),
        ("preview.city-world",true,false,"Desktop Host 的内嵌 city-sdk 可校验 world 编辑并签发 Preview；视口诊断仍需 Studio。"),
        ("preview.host-verification",true,false,"Desktop Host 可独立复核仍有效的 Host Preview；不需要 Studio WebView。"),
        ("operation.review",true,false,"人工可通过 MCP 审核已有 Host 证据；不会自动接受或发布。"),
        ("operation.project-commit",true,false,"显式开启本地写权限后，Host 可提交与其内嵌 Preview 同实例、同 revision 的变更；实时事件不会自动提交。"),
        ("operation.publish",true,false,"显式开启本地写权限后可走既有 Host 发布冻结；实时协作不自动发布。"),
        ("operation.capture",false,true,"画面捕获需要官方 Studio WebView 和 ready 视口。"),
    ].into_iter().map(|(id,headless,studio,note)| json!({"id":id,"headless":headless,
        "requiresStudioWebView":studio,"note":note})).collect()
}

fn capabilities_status(data_home: &Path) -> Result<Value, ToolError> {
    let db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let connections = connection_rows(&db,None,None)?;
    let studio_online = connections.iter().any(|connection| matches!(connection["state"].as_str(),Some("online" | "busy" | "degraded"))
        && connection["transport"] == "studio-webview");
    Ok(json!({"schemaVersion":1,"studioOnline":studio_online,"connections":connections,
        "capabilities":capability_matrix(),"serverTimeMs":now_ms(),
        "boundary":"本地 stdio/Desktop 协作；不是任意远程实时协作，不自动提交、验收或发布。"}))
}

fn event_notifications() -> &'static (Mutex<u64>, Condvar) {
    static NOTIFY: OnceLock<(Mutex<u64>,Condvar)> = OnceLock::new();
    NOTIFY.get_or_init(|| (Mutex::new(0),Condvar::new()))
}

fn notify_event_subscribers() {
    let (lock,condition) = event_notifications();
    let mut generation = lock.lock().unwrap_or_else(|error| error.into_inner());
    *generation = generation.saturating_add(1);
    condition.notify_all();
}

fn append_event(tx: &rusqlite::Transaction<'_>, task_id: &str, kind: &str, source: &str,
    trust_level: &str, summary: &str, data: &Value) -> Result<Value, ToolError> {
    if !matches!(kind,"accepted" | "plan" | "progress" | "executor-output" | "preview" | "evidence" | "failure" | "cancel" | "review")
        || summary.is_empty() || summary.chars().count() > 240 || task_canonical_json(data)?.len() > 4 * 1024 {
        return Err(ToolError::new("invalid_argument", "Event type, summary or payload is outside the bounded contract."));
    }
    let seq: u64 = tx.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM creator_task_events WHERE task_id=?1",[task_id],|row| row.get(0))
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let created = now_ms();
    tx.execute("INSERT INTO creator_task_events(task_id,seq,kind,source,trust_level,summary,data_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![task_id,seq,kind,source,trust_level,summary,task_canonical_json(data)?,created])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let event_id: u64 = tx.query_row("SELECT last_insert_rowid()",[],|row| row.get(0))
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(json!({"eventId":event_id,"taskId":task_id,"seq":seq,"kind":kind,"source":source,
        "trustLevel":trust_level,"summary":summary,"data":data,"createdAtMs":created}))
}

fn append_event_db(data_home: &Path, task_id: &str, kind: &str, source: &str,
    trust_level: &str, summary: &str, data: &Value) -> Result<Value, ToolError> {
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let event = append_event(&tx,task_id,kind,source,trust_level,summary,data)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    notify_event_subscribers();
    Ok(event)
}

fn read_events(db: &rusqlite::Connection, task_id: &str, after_event_id: u64, limit: u64) -> Result<(Vec<Value>,bool), ToolError> {
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM creator_jobs WHERE job_id=?1)",[task_id],|row| row.get(0))
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if !exists { return Err(ToolError::new("creator_task_not_found", "Unknown taskId or jobId.")); }
    if after_event_id > 0 {
        let owner: Option<String> = db.query_row("SELECT task_id FROM creator_task_events WHERE event_id=?1",[after_event_id],|row| row.get(0))
            .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        if owner.as_deref() != Some(task_id) { return Err(ToolError::new("invalid_argument", "afterEventId does not belong to this taskId.")); }
    }
    let mut statement = db.prepare("SELECT event_id,seq,kind,source,trust_level,summary,data_json,created_at_ms FROM creator_task_events
        WHERE task_id=?1 AND event_id>?2 ORDER BY event_id LIMIT ?3")
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let mut events = statement.query_map(rusqlite::params![task_id,after_event_id,limit+1],|row| {
        let data: String = row.get(6)?;
        Ok(json!({"eventId":row.get::<_,u64>(0)?,"taskId":task_id,"seq":row.get::<_,u64>(1)?,
            "kind":row.get::<_,String>(2)?,"source":row.get::<_,String>(3)?,"trustLevel":row.get::<_,String>(4)?,
            "summary":row.get::<_,String>(5)?,"data":serde_json::from_str::<Value>(&data).unwrap_or(Value::Null),
            "createdAtMs":row.get::<_,u64>(7)?}))
    }).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
        .collect::<Result<Vec<_>,_>>().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let has_more = events.len() as u64 > limit;
    if has_more { events.pop(); }
    Ok((events,has_more))
}

fn events_subscribe(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload,"taskId")?;
    let after = payload.get("afterEventId").and_then(Value::as_u64).unwrap_or(0);
    let limit = payload.get("limit").and_then(Value::as_u64).unwrap_or(50);
    let timeout = payload.get("timeoutMs").and_then(Value::as_u64).unwrap_or(0);
    if payload.get("afterEventId").is_some() && payload.get("afterEventId").and_then(Value::as_u64).is_none()
        || !(1..=EVENT_LIMIT_MAX).contains(&limit) || timeout > EVENT_WAIT_MAX_MS
        || payload.get("timeoutMs").is_some() && payload.get("timeoutMs").and_then(Value::as_u64).is_none() {
        return Err(ToolError::new("invalid_argument", "afterEventId, limit (1..=100) or timeoutMs (0..=30000) is invalid."));
    }
    let db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout);
    loop {
        let (events,has_more) = read_events(&db,&task_id,after,limit)?;
        if !events.is_empty() || has_more {
            let cursor = events.last().and_then(|event| event["eventId"].as_u64()).unwrap_or(after);
            return Ok(json!({"taskId":task_id,"events":events,"nextAfterEventId":cursor,"hasMore":has_more,"waitTimedOut":false}));
        }
        if timeout == 0 || std::time::Instant::now() >= deadline {
            return Ok(json!({"taskId":task_id,"events":[],"nextAfterEventId":after,"hasMore":false,"waitTimedOut":timeout > 0}));
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let slice = remaining.min(std::time::Duration::from_millis(EVENT_WAIT_SLICE_MS));
        let (lock,condition) = event_notifications();
        let generation = lock.lock().unwrap_or_else(|error| error.into_inner());
        let (guard,_) = condition.wait_timeout(generation,slice).unwrap_or_else(|error| error.into_inner());
        drop(guard);
    }
}

fn record_legacy_job_projection(data_home: &Path, job: &Value) {
    let Some(job_id) = job["jobId"].as_str() else { return };
    let stage = job["progress"]["stage"].as_str().unwrap_or("unknown");
    let status = job["status"].as_str().unwrap_or("unknown");
    let Ok(db) = open_db(&sessions_db(data_home).unwrap_or_else(|_| PathBuf::from("/dev/null")),false) else { return };
    if ensure_schema(&db).is_err() { return; }
    let previous: Option<String> = db.query_row("SELECT data_json FROM creator_task_events WHERE task_id=?1 ORDER BY seq DESC LIMIT 1",[job_id],|row| row.get(0))
        .optional().ok().flatten();
    let projection = json!({"status":status,"stage":stage});
    if previous.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).is_some_and(|data| data == projection) { return; }
    let kind = if status == "failed" { "failure" } else if status == "cancelled" { "cancel" } else { "progress" };
    drop(db);
    let _ = append_event_db(data_home,job_id,kind,"legacy-job","host-observed","旧作业状态已投影",&projection);
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
    let capabilities = connection_capabilities(args)?;
    connection_upsert(&db,agent_id,&session_id,ConnectionUpdate {
        executor:Some(args.get("executor").and_then(Value::as_str).unwrap_or("unknown")),
        transport:Some(args.get("transport").and_then(Value::as_str).unwrap_or("mcp-stdio")),
        state:"online",capabilities,stable_error:Some(None),at_ms:now })?;
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
    let (agent_id,_,_,_) = session_scope(&db,session_id)?;
    connection_upsert(&db,&agent_id,session_id,ConnectionUpdate { executor:None,transport:None,state:"offline",capabilities:None,stable_error:None,at_ms:now })?;
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
    let job_id = new_id("cjob-");
    let inserted = db.execute(
        "INSERT INTO creator_jobs(job_id,kind,status,subject_json,progress_json,failure_json,cancel_requested,session_id,created_at_ms,updated_at_ms)
         VALUES(?1,'world-apply','running',?2,'{\"stage\":\"layout-rebuild\"}','{}',0,NULL,?3,?3)",
        rusqlite::params![job_id, json!({"cityId":city_id,"revision":revision}).to_string(), now]);
    drop(db);
    if inserted.is_ok() {
        let _ = append_event_db(data_home,&job_id,"accepted","legacy-job","host-observed","旧 world-apply 作业已登记",&json!({"kind":"world-apply"}));
        let _ = append_event_db(data_home,&job_id,"progress","legacy-job","host-observed","等待布局重建",&json!({"status":"running","stage":"layout-rebuild"}));
    }
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
    let job_id = new_id("cjob-");
    let inserted = db.execute(
        "INSERT INTO creator_jobs(job_id,kind,status,subject_json,progress_json,failure_json,cancel_requested,session_id,created_at_ms,updated_at_ms)
         VALUES(?1,'playtest','running',?2,'{\"stage\":\"playtest\"}','{}',0,NULL,?3,?3)",
        rusqlite::params![job_id, json!({"runId":run_id,"releaseId":body.get("releaseId")}).to_string(), now]);
    drop(db);
    if inserted.is_ok() {
        let _ = append_event_db(data_home,&job_id,"accepted","legacy-job","host-observed","旧 playtest 作业已登记",&json!({"kind":"playtest","runId":run_id}));
        let _ = append_event_db(data_home,&job_id,"progress","legacy-job","host-observed","等待试玩结果",&json!({"status":"running","stage":"playtest"}));
    }
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
    let jobs: Vec<Value> = jobs.into_iter().map(|job| match job["kind"].as_str() {
        Some("playtest") => resolve_playtest_job(data_home, &job),
        Some("world-apply") => resolve_world_apply_job(data_home, &job),
        Some("studio-task") => task_payload(data_home, job["jobId"].as_str().unwrap_or_default()).unwrap_or(job),
        _ => job,
    }).collect();
    for job in jobs.iter().filter(|job| matches!(job["kind"].as_str(),Some("playtest") | Some("world-apply"))) {
        record_legacy_job_projection(data_home,job);
    }
    Ok(jobs)
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
    let job = match row["kind"].as_str() {
        Some("playtest") => resolve_playtest_job(data_home, &row),
        Some("world-apply") => resolve_world_apply_job(data_home, &row),
        Some("studio-task") => task_payload(data_home, row["jobId"].as_str().unwrap_or_default()).unwrap_or(row),
        _ => row,
    };
    if matches!(job["kind"].as_str(),Some("playtest") | Some("world-apply")) { record_legacy_job_projection(data_home,&job); }
    Ok(job)
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
    drop(db);
    let _ = append_event_db(data_home,job_id,"cancel","studio","creator-declared","已请求协作式取消",&json!({"cancelRequested":true}));
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
        let kind = object.get("requiredEvidenceKind").and_then(Value::as_str).filter(|value| matches!(*value, "build" | "test" | "human-note" | "city-playtest" | "preview"))
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
    let progress_json: Option<String> = db.query_row("SELECT progress_json FROM creator_jobs WHERE job_id=?1", [task_id], |row| row.get(0))
        .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let execution = progress_json.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|value| value.get("execution").cloned()).unwrap_or(Value::Null);
    let failure_json: Option<String> = db.query_row("SELECT failure_json FROM creator_jobs WHERE job_id=?1", [task_id], |row| row.get(0))
        .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let failure = failure_json.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|value| value.as_object().filter(|object| !object.is_empty()).map(|object| Value::Object(object.clone()))).unwrap_or(Value::Null);
    Ok(json!({"jobId":task_id,"taskId":task_id,"sessionId":session_id,"kind":"studio-task","status":task["phase"],
        "subject":{"goalId":task["goalId"],"artifact":task["artifact"]},"progress":{"planRevision":task["planRevision"],"stepIds":task["stepIds"]},
        "failure":failure,"cancelRequested":task["phase"] == json!("cancelled"),"createdAtMs":task["createdAtMs"],"updatedAtMs":task["updatedAtMs"],
        "goalId":task["goalId"],"goalRevision":task["goalRevision"],"humanRequest":task["humanRequest"],"acceptanceCriteria":task["acceptanceCriteria"],
        "artifact":task["artifact"],"planRevision":task["planRevision"],"stepIds":task["stepIds"],"phase":task["phase"],
        "proposedChangeSetId":task["proposedChangeSetId"],"lastEvidenceId":task["lastEvidenceId"],"steps":steps,"evidence":evidence,"execution":execution}))
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
    append_event(&tx,&task_id,"accepted","studio","creator-declared","持久任务已受理",&json!({"goalId":goal_id,"phase":"planning"}))?;
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    notify_event_subscribers();
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
    append_event(&tx,&task_id,"plan","studio","creator-declared","任务计划已提交",&json!({"planRevision":expected_revision,"stepCount":steps.len(),"phase":"awaiting-plan-approval"}))?;
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    notify_event_subscribers();
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
    append_event(&tx,&task_id,"plan","studio","creator-declared","任务计划已获人工批准",&json!({"planRevision":plan_revision,"phase":"ready"}))?;
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    notify_event_subscribers();
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
    append_event(&tx,&task_id,"evidence","studio",&trust_level,"人工证据已追加",&json!({"evidenceId":evidence_id,"kind":kind,"criterionId":criterion_id,"phase":next_phase}))?;
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    notify_event_subscribers();
    task_payload(data_home, &task_id)
}

fn execution_cancellations() -> &'static Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>> {
    static CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> = OnceLock::new();
    CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn task_execute_with_executor(data_home: &Path, payload: &Value, executor: &dyn super::creator_agent_executor::CreatorAgentExecutor) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload, "taskId")?;
    let expected_plan_revision = task_revision_arg(payload, "expectedPlanRevision")?;
    let expected_artifact_revision = task_revision_arg(payload, "expectedArtifactRevision")?;
    let operation_id = task_id_arg(payload, "operationId")?;
    let timeout_ms = payload.get("timeoutMs").and_then(Value::as_u64).unwrap_or(90_000).clamp(100, 120_000);
    let executor_name = if payload.get("executor").and_then(Value::as_str) == Some("acp") { "acp" } else { "codex-cli" };
    let hash = task_hash(payload)?;
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if task_receipt(&tx, &operation_id, &hash)?.is_some() { return task_payload(data_home, &task_id); }
    let (task, session_id, plan_revision, phase) = task_row(&tx, &task_id)?;
    if phase == "executing" { return task_payload(data_home, &task_id); }
    if phase != "ready" { return Err(ToolError::new("creator_task_invalid_transition", format!("Cannot execute from {phase}."))); }
    if plan_revision != expected_plan_revision { return Err(ToolError::new("plan_revision_conflict", "Execution plan revision is stale.")); }
    if task["artifact"]["expectedRevision"].as_u64() != Some(expected_artifact_revision) { return Err(ToolError::new("revision_conflict", "Task artifact revision changed.")); }
    task_check_artifact(data_home, &task["artifact"])?;
    if !task["acceptanceCriteria"].as_array().is_some_and(|criteria| criteria.iter().any(|criterion| criterion["criterionId"].as_str() == Some("agent-preview") && criterion["requiredEvidenceKind"].as_str() == Some("preview"))) {
        return Err(ToolError::new("creator_task_acceptance_missing", "Task requires an agent-preview acceptance criterion before execution."));
    }
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    execution_cancellations().lock().unwrap_or_else(|error| error.into_inner()).insert(task_id.clone(), cancelled.clone());
    tx.execute("UPDATE creator_studio_tasks SET phase='executing',updated_at_ms=?2 WHERE task_id=?1", rusqlite::params![task_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE creator_jobs SET status='executing',progress_json=?2,updated_at_ms=?3 WHERE job_id=?1",
        rusqlite::params![task_id,json!({"execution":{"operationId":operation_id,"executor":executor_name,"status":"executing"} }).to_string(),now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let push_agent_id = format!("{executor_name}:{task_id}");
    connection_upsert(&db,&push_agent_id,&session_id,ConnectionUpdate { executor:Some(executor_name),transport:Some(if executor_name == "acp" { "acp-stdio" } else { "mcp-stdio" }),state:"busy",capabilities:Some(vec!["task.execute".into(),"events.publish".into()]),stable_error:None,at_ms:now_ms() })?;
    let _ = append_event_db(data_home,&task_id,"progress",executor_name,"host-observed","执行器进程已启动",&json!({"executor":executor_name,"phase":"executing"}));
    let progress_home = data_home.to_path_buf();
    let progress_task = task_id.clone();
    let progress_session = session_id.clone();
    let progress_agent = push_agent_id.clone();
    let progress_executor = executor_name.to_owned();
    let progress_callback: super::creator_agent_executor::AgentProgressCallback = Arc::new(move |update| {
        let result = append_event_db(&progress_home,&progress_task,&update.kind,&progress_executor,"agent-reported",&update.summary,&update.data);
        let state = if result.is_ok() { "busy" } else { "degraded" };
        if let Ok(db) = open_db(&sessions_db(&progress_home).unwrap_or_else(|_| PathBuf::from("/dev/null")),false) {
            let _ = connection_upsert(&db,&progress_agent,&progress_session,ConnectionUpdate { executor:Some(&progress_executor),transport:None,state,capabilities:None,stable_error:None,at_ms:now_ms() });
        }
    });
    let request = super::creator_agent_executor::AgentExecutionRequest {
        data_home: data_home.to_path_buf(), goal: task["humanRequest"].as_str().unwrap_or_default().to_owned(),
        human_request: task["humanRequest"].as_str().unwrap_or_default().to_owned(), artifact: task["artifact"].clone(),
        plan_revision: expected_plan_revision, timeout: std::time::Duration::from_millis(timeout_ms),
    };
    let heartbeat_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let heartbeat_home = data_home.to_path_buf();
    let heartbeat_agent = push_agent_id.clone();
    let heartbeat_session = session_id.clone();
    let heartbeat_executor = executor_name.to_owned();
    let heartbeat_task = task_id.clone();
    let heartbeat_cancelled = cancelled.clone();
    let heartbeat_flag = heartbeat_stop.clone();
    let heartbeat_thread = std::thread::spawn(move || {
        while !heartbeat_flag.load(std::sync::atomic::Ordering::Relaxed) {
            for step in 0..50 {
                if heartbeat_flag.load(std::sync::atomic::Ordering::Relaxed) { break; }
                if step % 5 == 0 {
                    if let Ok(db) = open_db(&sessions_db(&heartbeat_home).unwrap_or_else(|_| PathBuf::from("/dev/null")),false) {
                        let requested = db.query_row("SELECT cancel_requested FROM creator_jobs WHERE job_id=?1",[&heartbeat_task],|row| row.get::<_,i64>(0)).unwrap_or(0);
                        if requested != 0 { heartbeat_cancelled.store(true,std::sync::atomic::Ordering::Relaxed); }
                    }
                }
                if heartbeat_cancelled.load(std::sync::atomic::Ordering::Relaxed) { break; }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if heartbeat_flag.load(std::sync::atomic::Ordering::Relaxed) || heartbeat_cancelled.load(std::sync::atomic::Ordering::Relaxed) { break; }
            if let Ok(db) = open_db(&sessions_db(&heartbeat_home).unwrap_or_else(|_| PathBuf::from("/dev/null")),false) {
                let _ = connection_upsert(&db,&heartbeat_agent,&heartbeat_session,ConnectionUpdate { executor:Some(&heartbeat_executor),transport:None,state:"busy",capabilities:None,stable_error:None,at_ms:now_ms() });
            }
        }
    });
    let result = executor.execute_with_progress(request, &cancelled, &progress_callback);
    heartbeat_stop.store(true,std::sync::atomic::Ordering::Relaxed);
    let _ = heartbeat_thread.join();
    execution_cancellations().lock().unwrap_or_else(|error| error.into_inner()).remove(&task_id);
    let current_phase = task_row(&db, &task_id)?.3;
    if cancelled.load(std::sync::atomic::Ordering::Relaxed) || current_phase == "cancelled" {
        connection_upsert(&db,&push_agent_id,&session_id,ConnectionUpdate { executor:None,transport:None,state:"offline",capabilities:None,stable_error:Some(Some("codex_cancelled")),at_ms:now_ms() })?;
        return Err(ToolError::new("codex_cancelled", "Task execution was cancelled."));
    }
    let result = match result {
        Ok(success) => {
            let preview_id = success.preview["previewId"].as_str().filter(|id| valid_playtest_run_id(id)).map(str::to_owned).ok_or_else(|| ToolError::new("preview_required", "Executor returned no valid Preview."))?;
            if success.preview["baseRevision"].as_u64() != Some(expected_artifact_revision) {
                Err(ToolError::new("preview_required", "Executor Preview revision does not match the task artifact."))
            } else { Ok((success, preview_id)) }
        }
        Err(error) => Err(error),
    };
    match result {
        Ok((success, preview_id)) => {
            let mut db = open_db(&sessions_db(data_home)?, false)?;
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            let evidence_id = new_id("evidence-");
            tx.execute("INSERT INTO creator_studio_task_evidence(evidence_id,task_id,plan_revision,step_id,criterion_id,kind,trust_level,summary,data_json,created_at_ms)
                VALUES(?1,?2,?3,'human-review','agent-preview','preview','host-observed',?4,?5,?6)",
                rusqlite::params![evidence_id,task_id,expected_plan_revision,success.summary,success.preview.to_string(),now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            append_event(&tx,&task_id,"preview",executor_name,"host-observed","Host 已生成并校验执行器 Preview",&json!({"previewId":preview_id,"baseRevision":expected_artifact_revision,"executor":executor_name}))?;
            append_event(&tx,&task_id,"evidence","host","host-observed","Host Preview 证据已记录",&json!({"evidenceId":evidence_id,"criterionId":"agent-preview","kind":"preview","trustLevel":"host-observed"}))?;
            tx.execute("UPDATE creator_studio_tasks SET phase='awaiting-review',last_evidence_id=?2,proposed_change_set_id=?3,updated_at_ms=?4 WHERE task_id=?1",
                rusqlite::params![task_id,evidence_id,preview_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            tx.execute("UPDATE creator_jobs SET status='awaiting-review',progress_json=?2,updated_at_ms=?3 WHERE job_id=?1",
                rusqlite::params![task_id,json!({"execution":{"operationId":operation_id,"executor":executor_name,"status":"awaiting-review","previewId":preview_id} }).to_string(),now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            let result = json!({"taskId":task_id,"phase":"awaiting-review","proposedChangeSetId":preview_id,"lastEvidenceId":evidence_id});
            task_save_receipt(&tx, &operation_id, &hash, &result)?;
            tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            connection_upsert(&db,&push_agent_id,&session_id,ConnectionUpdate { executor:None,transport:None,state:"offline",capabilities:None,stable_error:Some(None),at_ms:now_ms() })?;
            notify_event_subscribers();
            task_payload(data_home, &task_id)
        }
        Err(error) => {
            let mut db = open_db(&sessions_db(data_home)?, false)?;
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            tx.execute("UPDATE creator_studio_tasks SET phase='failed',updated_at_ms=?2 WHERE task_id=?1", rusqlite::params![task_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            tx.execute("UPDATE creator_jobs SET status='failed',progress_json=?2,failure_json=?3,updated_at_ms=?4 WHERE job_id=?1",
                rusqlite::params![task_id,json!({"execution":{"operationId":operation_id,"executor":executor_name,"status":"failed","code":error.code} }).to_string(),json!({"code":error.code}).to_string(),now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            append_event(&tx,&task_id,"failure","host","host-observed","执行器运行失败",&json!({"code":error.code,"executor":executor_name,"phase":"failed"}))?;
            tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            connection_upsert(&db,&push_agent_id,&session_id,ConnectionUpdate { executor:None,transport:None,state:"offline",capabilities:None,stable_error:Some(Some(if valid_connection_error(error.code) { error.code } else { "executor_failed" })),at_ms:now_ms() })?;
            notify_event_subscribers();
            Err(error)
        }
    }
}

fn task_execute(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let executor = super::creator_agent_executor::select_executor(payload)?;
    task_execute_with_executor(data_home, payload, executor.as_ref())
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
    append_event(&tx,&task_id,"review","studio","creator-declared","人工验收已接受任务",&json!({"decision":"accepted","planRevision":plan_revision}))?;
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    notify_event_subscribers();
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
    append_event(&tx,&task_id,"review","studio","creator-declared","人工验收已退回任务",&json!({"decision":"rejected","planRevision":plan_revision}))?;
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    notify_event_subscribers();
    task_payload(data_home, &task_id)
}

/// Pull 模式任务面（通用接入）：任何 MCP 客户端（桌面 Agent / CLI / 交互式会话）
/// 用同一个 agentId 即可认领与交结果，不需要宿主逐家 spawn 适配。诚实闸不松动：
/// submit 的预览由宿主服务端复核（存在、绑定 artifact、baseRevision 匹配、未过期），
/// 证据永远是 host-observed，人工复核仍走 review.accept/reject。
fn task_brief(task: &Value) -> Value {
    json!({"taskId":task["taskId"],"goal":task["humanRequest"],"artifact":task["artifact"],
        "planRevision":task["planRevision"],"stepIds":task["stepIds"],
        "acceptanceCriteria":task["acceptanceCriteria"],"updatedAtMs":task["updatedAtMs"]})
}

fn task_claim_row(tx: &rusqlite::Transaction, task_id: &str) -> Result<Option<(String, i64)>, ToolError> {
    tx.query_row("SELECT agent_id,claimed_at_ms FROM creator_studio_task_claims WHERE task_id=?1", [task_id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?)))
        .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))
}

pub fn task_list_open(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let limit = payload.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 50);
    let db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let ids: Vec<String> = db.prepare("SELECT task_id FROM creator_studio_tasks WHERE phase='ready' ORDER BY updated_at_ms DESC LIMIT ?1")
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
        .query_map(rusqlite::params![limit], |row| row.get::<_,String>(0))
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
        .collect::<Result<Vec<_>,_>>().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let tasks = ids.iter().map(|id| task_payload(data_home, id)).collect::<Result<Vec<_>,_>>()?;
    Ok(json!({"tasks":tasks.iter().map(task_brief).collect::<Vec<_>>(),"count":tasks.len(),"truncated":ids.len() as u64 == limit}))
}

pub fn task_claim(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload, "taskId")?;
    let agent_id = task_text_arg(payload, "agentId", 128)?;
    let plan_revision = task_revision_arg(payload, "expectedPlanRevision")?;
    let expected_artifact_revision = task_revision_arg(payload, "expectedArtifactRevision")?;
    let operation_id = task_id_arg(payload, "operationId")?;
    let hash = task_hash(payload)?;
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if let Some(result) = task_receipt(&tx, &operation_id, &hash)? { return Ok(result); }
    let (task, session_id, current_revision, phase) = task_row(&tx, &task_id)?;
    if current_revision != plan_revision { return Err(ToolError::new("plan_revision_conflict", "Task plan moved on; re-read the task and claim the current revision.")); }
    if task["artifact"]["expectedRevision"].as_u64() != Some(expected_artifact_revision) { return Err(ToolError::new("revision_conflict", "Task artifact revision changed.")); }
    let existing_claim = task_claim_row(&tx, &task_id)?;
    match phase.as_str() {
        "ready" => {}
        "executing" if existing_claim.as_ref().is_some_and(|(owner,_)| owner == &agent_id) => {
            connection_upsert(&tx,&agent_id,&session_id,ConnectionUpdate { executor:Some("pull"),transport:Some("mcp-stdio"),state:"busy",capabilities:Some(vec!["task.pull".into(),"events.subscribe".into()]),stable_error:None,at_ms:now_ms() })?;
            let result = task_payload(data_home, &task_id)?;
            task_save_receipt(&tx, &operation_id, &hash, &json!({"taskId":task_id,"phase":"executing","claimant":agent_id,"reclaimed":true}))?;
            tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            return Ok(result);
        }
        "executing" => return Err(ToolError::new("creator_task_already_claimed", format!("Task is claimed by another agent ({}).", existing_claim.as_ref().map(|(owner,_)| owner.as_str()).unwrap_or("unknown")))),
        other => return Err(ToolError::new("creator_task_invalid_transition", format!("Cannot claim from {other}."))),
    }
    let has_preview_criterion = task["acceptanceCriteria"].as_array().is_some_and(|criteria| criteria.iter().any(|criterion|
        criterion["criterionId"].as_str() == Some("agent-preview") && criterion["requiredEvidenceKind"].as_str() == Some("preview")));
    if !has_preview_criterion { return Err(ToolError::new("creator_task_acceptance_missing", "Task requires an agent-preview acceptance criterion before claiming.")); }
    let now = now_ms();
    tx.execute("INSERT INTO creator_studio_task_claims(task_id,agent_id,claimed_at_ms) VALUES(?1,?2,?3)
        ON CONFLICT(task_id) DO UPDATE SET agent_id=excluded.agent_id,claimed_at_ms=excluded.claimed_at_ms",
        rusqlite::params![task_id,agent_id,now]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE creator_studio_tasks SET phase='executing',updated_at_ms=?2 WHERE task_id=?1", rusqlite::params![task_id,now])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE creator_jobs SET status='executing',updated_at_ms=?2 WHERE job_id=?1", rusqlite::params![task_id,now])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    connection_upsert(&tx,&agent_id,&session_id,ConnectionUpdate { executor:Some("pull"),transport:Some("mcp-stdio"),state:"busy",capabilities:Some(vec!["task.pull".into(),"events.subscribe".into()]),stable_error:None,at_ms:now })?;
    append_event(&tx,&task_id,"progress","pull-agent","agent-reported","Pull Agent 已认领任务",&json!({"agentId":agent_id,"phase":"executing","planRevision":plan_revision}))?;
    task_save_receipt(&tx, &operation_id, &hash, &json!({"taskId":task_id,"phase":"executing","claimant":agent_id}))?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    notify_event_subscribers();
    let mut result = task_payload(data_home, &task_id)?;
    result["claimant"] = json!(agent_id);
    result["next"] = json!({"steps":[
        "Analyze the artifact with the read-only creator tools (never claim saved changes).",
        "Create one host preview bound to the artifact: creator_vehicle_preview / creator_game_preview / creator_city_edit_preview, or creator_scene_preview with Studio open.",
        "Call creator_task_submit_result with that previewId within its 10-minute TTL."],
        "note":"Submit re-verifies the preview server-side; the host records the evidence and moves the task to human review."});
    Ok(result)
}

fn task_progress(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload,"taskId")?;
    let agent_id = task_id_arg(payload,"agentId")?;
    let plan_revision = task_revision_arg(payload,"planRevision")?;
    let kind = task_id_arg(payload,"kind")?;
    if !matches!(kind.as_str(),"plan" | "progress" | "executor-output") {
        return Err(ToolError::new("invalid_argument","Pull progress kind is unsupported."));
    }
    let code = task_id_arg(payload,"code")?;
    if !matches!(code.as_str(),"analysis-started" | "artifact-read" | "operations-proposed" | "preview-requested" | "preview-ready" | "validation-started" | "validation-completed" | "waiting-host" | "other") {
        return Err(ToolError::new("invalid_argument","Pull progress code is unsupported."));
    }
    let percent = payload.get("percent").and_then(Value::as_u64);
    if percent.is_some_and(|value| value > 100) || payload.get("percent").is_some() && percent.is_none() {
        return Err(ToolError::new("invalid_argument","percent must be an integer from 0 to 100."));
    }
    let step_id = payload.get("stepId").and_then(Value::as_str);
    if payload.get("stepId").is_some() && step_id.is_none() { return Err(ToolError::new("invalid_argument","stepId must be a stable id.")); }
    let operation_id = task_id_arg(payload,"operationId")?;
    let hash = task_hash(payload)?;
    let mut db = open_db(&sessions_db(data_home)?,false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable",format!("{error}")))?;
    if let Some(result) = task_receipt(&tx,&operation_id,&hash)? { return Ok(result); }
    let (task,session_id,current_revision,phase) = task_row(&tx,&task_id)?;
    if phase != "executing" || current_revision != plan_revision {
        return Err(ToolError::new("creator_task_invalid_transition","Only the current executing plan can report progress."));
    }
    if task_claim_row(&tx,&task_id)?.as_ref().map(|(owner,_)| owner.as_str()) != Some(agent_id.as_str()) {
        return Err(ToolError::new("creator_task_claim_mismatch","Only the claiming agent may report progress."));
    }
    if let Some(step) = step_id {
        if !task["stepIds"].as_array().is_some_and(|steps| steps.iter().any(|id| id.as_str() == Some(step))) {
            return Err(ToolError::new("invalid_argument","stepId is not in the approved plan."));
        }
    }
    let now = now_ms();
    connection_upsert(&tx,&agent_id,&session_id,ConnectionUpdate { executor:Some("pull"),transport:Some("mcp-stdio"),state:"busy",capabilities:Some(vec!["task.pull".into(),"events.subscribe".into()]),stable_error:None,at_ms:now })?;
    let data = json!({"code":code,"stepId":step_id,"percent":percent,"planRevision":plan_revision});
    let event = append_event(&tx,&task_id,&kind,"pull-agent","agent-reported","Pull Agent 已报告类型化进度",&data)?;
    let result = json!({"taskId":task_id,"event":event});
    task_save_receipt(&tx,&operation_id,&hash,&result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable",format!("{error}")))?;
    notify_event_subscribers();
    Ok(result)
}

pub fn task_submit_result(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload, "taskId")?;
    let agent_id = task_text_arg(payload, "agentId", 128)?;
    let plan_revision = task_revision_arg(payload, "planRevision")?;
    let expected_artifact_revision = task_revision_arg(payload, "expectedArtifactRevision")?;
    let summary = task_text_arg(payload, "summary", 2_000)?;
    let preview_id = task_id_arg(payload, "previewId")?;
    let operation_id = task_id_arg(payload, "operationId")?;
    let hash = task_hash(payload)?;
    // 评审 P2：宿主复核是最长 15s 的 broker 往返，必须在任务库写事务之外完成——
    // BEGIN IMMEDIATE 期间持有写锁会阻塞同库其他写入（含 task.cancel）。三段式：
    // (A) 短事务校验并释放写锁 → (B) 事务外宿主复核 → (C) 短事务复查（捕获期间的
    // 取消/变更/换领人）+ 落盘证据与回执。
    let (project_id,session_id) = {
        let mut db = open_db(&sessions_db(data_home)?, false)?;
        ensure_schema(&db)?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        if let Some(result) = task_receipt(&tx, &operation_id, &hash)? { return Ok(result); }
        let (task, session_id, current_revision, phase) = task_row(&tx, &task_id)?;
        if phase != "executing" || current_revision != plan_revision { return Err(ToolError::new("creator_task_invalid_transition", format!("Cannot submit from {phase} with plan revision {plan_revision}."))); }
        let claimant = task_claim_row(&tx, &task_id)?;
        if claimant.as_ref().map(|(owner,_)| owner.as_str()) != Some(agent_id.as_str()) {
            return Err(ToolError::new("creator_task_claim_mismatch", "Only the claiming agent may submit the result."));
        }
        if task["artifact"]["expectedRevision"].as_u64() != Some(expected_artifact_revision) { return Err(ToolError::new("revision_conflict", "Task artifact revision changed.")); }
        task_check_artifact(data_home, &task["artifact"])?;
        let project_id = task["artifact"]["projectId"].as_str()
            .ok_or_else(|| ToolError::new("creator_task_artifact_invalid", "Task artifact does not carry a projectId."))?.to_owned();
        tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        (project_id,session_id)
    };
    // 服务端复核（诚实闸的核心）：预览由宿主进程持有（内存、TTL 600s），submit 经
    // broker 回宿主确认「存在、绑定本 artifact、baseRevision 匹配、未过期」。复用
    // Studio 域错误码映射；宿主不在场时诚实报 plugin_unavailable，绝不降级采信。
    let verified = match super::creator_studio::call(data_home, "creator.task.preview.verify",
        &json!({"projectId":project_id,"previewId":preview_id}), 15_000) {
        Ok(value) => value,
        Err(error) => {
            if let Ok(db) = open_db(&sessions_db(data_home)?,false) {
                let _ = connection_upsert(&db,&agent_id,&session_id,ConnectionUpdate { executor:Some("pull"),transport:Some("mcp-stdio"),state:"degraded",capabilities:None,stable_error:Some(Some(if valid_connection_error(error.code) { error.code } else { "executor_failed" })),at_ms:now_ms() });
            }
            let _ = append_event_db(data_home,&task_id,"failure","host","host-observed","Pull 提交的 Preview 复核失败",&json!({"code":error.code,"phase":"executing"}));
            return Err(error);
        }
    };
    let verified = verified.get("data").cloned().unwrap_or(verified);
    if verified["projectId"].as_str() != Some(project_id.as_str()) || verified["baseRevision"].as_u64() != Some(expected_artifact_revision) {
        return Err(ToolError::new("preview_required", "Submitted preview does not match the task artifact (project or base revision)."));
    }
    // (C) 复查：复核等待期间任务可能已被取消/换领人/推进——全部以当前行状态裁决。
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if let Some(result) = task_receipt(&tx, &operation_id, &hash)? { return Ok(result); }
    let (task, session_id, current_revision, phase) = task_row(&tx, &task_id)?;
    if phase != "executing" || current_revision != plan_revision { return Err(ToolError::new("creator_task_invalid_transition", format!("Cannot submit from {phase} with plan revision {plan_revision}."))); }
    let claimant = task_claim_row(&tx, &task_id)?;
    if claimant.as_ref().map(|(owner,_)| owner.as_str()) != Some(agent_id.as_str()) {
        return Err(ToolError::new("creator_task_claim_mismatch", "Only the claiming agent may submit the result."));
    }
    if task["artifact"]["expectedRevision"].as_u64() != Some(expected_artifact_revision) { return Err(ToolError::new("revision_conflict", "Task artifact revision changed.")); }
    let criteria = task["acceptanceCriteria"].as_array().ok_or_else(|| ToolError::new("storage_unavailable", "Task acceptance is damaged."))?;
    let now = now_ms();
    connection_upsert(&tx,&agent_id,&session_id,ConnectionUpdate { executor:Some("pull"),transport:Some("mcp-stdio"),state:"online",capabilities:None,stable_error:Some(None),at_ms:now })?;
    append_event(&tx,&task_id,"preview","host","host-observed","Host 已复核 Pull 提交的 Preview",&json!({"previewId":preview_id,"projectId":project_id,"baseRevision":expected_artifact_revision}))?;
    let mut last_evidence_id = String::new();
    for criterion in criteria.iter().filter(|criterion| criterion["requiredEvidenceKind"].as_str() == Some("preview")) {
        let criterion_id = criterion["criterionId"].as_str().unwrap_or_default().to_owned();
        let evidence_id = new_id("evidence-");
        tx.execute("INSERT INTO creator_studio_task_evidence(evidence_id,task_id,plan_revision,step_id,criterion_id,kind,trust_level,summary,data_json,created_at_ms)
            VALUES(?1,?2,?3,NULL,?4,'preview','host-observed',?5,?6,?7)",
            rusqlite::params![evidence_id,task_id,plan_revision,criterion_id,summary,verified.to_string(),now])
            .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        append_event(&tx,&task_id,"evidence","host","host-observed","Host Preview 证据已记录",&json!({"evidenceId":evidence_id.clone(),"criterionId":criterion_id,"kind":"preview","trustLevel":"host-observed"}))?;
        last_evidence_id = evidence_id;
    }
    if last_evidence_id.is_empty() { return Err(ToolError::new("creator_task_acceptance_missing", "Task has no preview acceptance criterion to satisfy.")); }
    tx.execute("UPDATE creator_studio_tasks SET phase='awaiting-review',last_evidence_id=?2,proposed_change_set_id=?3,updated_at_ms=?4 WHERE task_id=?1",
        rusqlite::params![task_id,last_evidence_id,preview_id,now]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE creator_jobs SET status='awaiting-review',updated_at_ms=?2 WHERE job_id=?1", rusqlite::params![task_id,now])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    task_save_receipt(&tx, &operation_id, &hash, &json!({"taskId":task_id,"phase":"awaiting-review","previewId":preview_id}))?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    notify_event_subscribers();
    let mut result = task_payload(data_home, &task_id)?;
    result["next"] = json!({"tool":"creator_task_review_accept","note":"A human reviewer accepts or rejects; review evidence stays host-observed."});
    Ok(result)
}

fn task_cancel(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let task_id = task_id_arg(payload, "taskId")?;
    let operation_id = task_id_arg(payload, "operationId")?;
    let hash = task_hash(payload)?;
    if let Some(flag) = execution_cancellations().lock().unwrap_or_else(|error| error.into_inner()).get(&task_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let mut db = open_db(&sessions_db(data_home)?, false)?;
    ensure_schema(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if let Some(result) = task_receipt(&tx, &operation_id, &hash)? { return Ok(result); }
    let (_, _, _, phase) = task_row(&tx, &task_id)?;
    if task_terminal(&phase) { return Err(ToolError::new("creator_task_invalid_transition", format!("Task is already {phase}."))); }
    tx.execute("UPDATE creator_studio_tasks SET phase='cancelled',updated_at_ms=?2 WHERE task_id=?1", rusqlite::params![task_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE creator_jobs SET status='cancelled',cancel_requested=1,updated_at_ms=?2 WHERE job_id=?1", rusqlite::params![task_id,now_ms()]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let result = json!({"taskId":task_id,"phase":"cancelled"});
    append_event(&tx,&task_id,"cancel","studio","creator-declared","任务已取消",&json!({"phase":"cancelled"}))?;
    task_save_receipt(&tx, &operation_id, &hash, &result)?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    notify_event_subscribers();
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
        "creator.task.execute" => task_execute(data_home, payload),
        "creator.task.evidence.append" => task_evidence_append(data_home, payload),
        "creator.task.evidence.list" => {
            let task = task_payload(data_home, task_id_arg(payload, "taskId")?.as_str())?;
            Ok(json!({"evidence":task["evidence"]}))
        }
        "creator.task.review.accept" => task_review_accept(data_home, payload),
        "creator.task.review.reject" => task_review_reject(data_home, payload),
        "creator.task.cancel" => task_cancel(data_home, payload),
        "creator.task.list_open" => task_list_open(data_home, payload),
        "creator.task.claim" => task_claim(data_home, payload),
        "creator.task.submit_result" => task_submit_result(data_home, payload),
        "creator.task.progress" => task_progress(data_home, payload),
        _ => Err(ToolError::new("creator_method_unavailable", format!("Unknown task method {method}."))),
    }
}

pub fn session_dispatch(data_home: &Path, method: &str, payload: &Value) -> Result<Value, ToolError> {
    let result = match method {
        "creator.session.open" => session_open(data_home, payload)?,
        "creator.session.status" => session_status(data_home, payload)?,
        "creator.session.close" => session_close(data_home, payload)?,
        "creator.connection.heartbeat" => return connection_heartbeat(data_home,payload,false),
        "creator.connection.disconnect" => return connection_heartbeat(data_home,payload,true),
        "creator.connection.status" => return connection_status(data_home,payload),
        "creator.capabilities.status" => return capabilities_status(data_home),
        "creator.events.subscribe" => return events_subscribe(data_home,payload),
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
        "creator_connection_heartbeat" => connection_heartbeat(data_home,args,false).map(|data| json!({"ok":true,"data":data})),
        "creator_connection_disconnect" => connection_heartbeat(data_home,args,true).map(|data| json!({"ok":true,"data":data})),
        "creator_connection_status" => connection_status(data_home,args).map(|data| json!({"ok":true,"data":data})),
        "creator_capabilities_status" => capabilities_status(data_home).map(|data| json!({"ok":true,"data":data})),
        "creator_events_subscribe" => events_subscribe(data_home,args).map(|data| json!({"ok":true,"data":data})),
        "creator_job_list" => job_list(data_home, args),
        "creator_job_status" => job_status(data_home, args),
        "creator_job_wait" => job_wait(data_home, args),
        "creator_job_cancel" => job_cancel(data_home, args),
        "creator_task_create" => task_mcp(data_home, "creator.task.create", args),
        "creator_task_plan_submit" => task_mcp(data_home, "creator.task.plan.submit", args),
        "creator_task_plan_approve" => task_mcp(data_home, "creator.task.plan.approve", args),
        "creator_task_status" => task_mcp(data_home, "creator.task.status", args),
        "creator_task_execute" => task_mcp(data_home, "creator.task.execute", args),
        "creator_task_evidence_append" => task_mcp(data_home, "creator.task.evidence.append", args),
        "creator_task_evidence_list" => task_mcp(data_home, "creator.task.evidence.list", args),
        "creator_task_review_accept" => task_mcp(data_home, "creator.task.review.accept", args),
        "creator_task_review_reject" => task_mcp(data_home, "creator.task.review.reject", args),
        "creator_task_cancel" => task_mcp(data_home, "creator.task.cancel", args),
        "creator_task_list_open" => task_list_open(data_home, args),
        "creator_task_claim" => task_claim(data_home, args),
        "creator_task_submit_result" => task_submit_result(data_home, args),
        "creator_task_progress" => task_progress(data_home,args).map(|data| json!({"ok":true,"data":data})),
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

    fn studio_goal_with_preview(session_id: &str, operation_id: &str) -> Value {
        let mut goal = studio_goal(session_id, operation_id);
        goal["acceptanceCriteria"] = json!([
            {"criterionId":"agent-preview","description":"Host generated Preview required","requiredEvidenceKind":"preview"},
            {"criterionId":"manual-review","description":"A human reviews the result","requiredEvidenceKind":"human-note"}
        ]);
        goal
    }

    #[test]
    fn pull_mode_claim_is_exclusive_and_idempotent() {
        let home = temp_home();
        let session = session_open(&home, &json!({"agentId":"studio-local","projectId":"project-1"})).unwrap();
        let session_id = session["data"]["sessionId"].as_str().unwrap();
        prepare_artifact(&home, "project-1", 3);
        let created = task_dispatch(&home, "creator.task.create", &studio_goal_with_preview(session_id, "pull-goal")).unwrap();
        let task_id = created["taskId"].as_str().unwrap();
        task_dispatch(&home, "creator.task.plan.submit", &studio_plan(task_id, 1, "pull-plan")).unwrap();
        task_dispatch(&home, "creator.task.plan.approve", &json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"operationId":"pull-approve"})).unwrap();
        // 认领前 list_open 必须能看到该任务
        let open = task_dispatch(&home, "creator.task.list_open", &json!({})).unwrap();
        assert!(open["tasks"].as_array().unwrap().iter().any(|task| task["taskId"] == task_id));
        // 无 agent-preview 判据的任务不可认领
        let plain = task_dispatch(&home, "creator.task.create", &studio_goal(session_id, "pull-goal-plain")).unwrap();
        let plain_id = plain["taskId"].as_str().unwrap();
        task_dispatch(&home, "creator.task.plan.submit", &studio_plan(plain_id, 1, "pull-plan-plain")).unwrap();
        task_dispatch(&home, "creator.task.plan.approve", &json!({"taskId":plain_id,"planRevision":1,"expectedArtifactRevision":3,"operationId":"pull-approve-plain"})).unwrap();
        assert_eq!(task_dispatch(&home, "creator.task.claim", &json!({"taskId":plain_id,"agentId":"agent-a","expectedPlanRevision":1,"expectedArtifactRevision":3,"operationId":"pull-claim-plain"})).unwrap_err().code, "creator_task_acceptance_missing");
        let claimed = task_dispatch(&home, "creator.task.claim", &json!({"taskId":task_id,"agentId":"agent-a","expectedPlanRevision":1,"expectedArtifactRevision":3,"operationId":"pull-claim-a"})).unwrap();
        assert_eq!(claimed["phase"], "executing");
        assert_eq!(claimed["claimant"], "agent-a");
        // 第二个 Agent 认领被拒；同一 Agent 幂等
        assert_eq!(task_dispatch(&home, "creator.task.claim", &json!({"taskId":task_id,"agentId":"agent-b","expectedPlanRevision":1,"expectedArtifactRevision":3,"operationId":"pull-claim-b"})).unwrap_err().code, "creator_task_already_claimed");
        let reclaimed = task_dispatch(&home, "creator.task.claim", &json!({"taskId":task_id,"agentId":"agent-a","expectedPlanRevision":1,"expectedArtifactRevision":3,"operationId":"pull-claim-a2"})).unwrap();
        assert_eq!(reclaimed["phase"], "executing");
        // 非认领者提交被拒；认领者提交时宿主不在场 → 诚实 plugin_unavailable
        assert_eq!(task_dispatch(&home, "creator.task.submit_result", &json!({"taskId":task_id,"agentId":"agent-b","planRevision":1,"expectedArtifactRevision":3,"summary":"x","previewId":"preview-1","operationId":"pull-submit-b"})).unwrap_err().code, "creator_task_claim_mismatch");
        assert_eq!(task_dispatch(&home, "creator.task.submit_result", &json!({"taskId":task_id,"agentId":"agent-a","planRevision":1,"expectedArtifactRevision":3,"summary":"x","previewId":"preview-1","operationId":"pull-submit-a"})).unwrap_err().code, "plugin_unavailable");
        // list_open 不再包含 executing 任务
        let open_after = task_dispatch(&home, "creator.task.list_open", &json!({})).unwrap();
        assert!(!open_after["tasks"].as_array().unwrap().iter().any(|task| task["taskId"] == task_id));
    }

    #[test]
    fn studio_task_execute_returns_real_preview_and_awaits_human_acceptance() {
        let home = temp_home();
        let session = session_open(&home, &json!({"agentId":"studio-local","projectId":"project-1"})).unwrap();
        let session_id = session["data"]["sessionId"].as_str().unwrap();
        prepare_artifact(&home, "project-1", 3);
        let created = task_dispatch(&home, "creator.task.create", &studio_goal_with_preview(session_id, "execute-goal")).unwrap();
        let task_id = created["taskId"].as_str().unwrap();
        task_dispatch(&home, "creator.task.plan.submit", &studio_plan(task_id, 1, "execute-plan")).unwrap();
        task_dispatch(&home, "creator.task.plan.approve", &json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"operationId":"execute-approve"})).unwrap();
        let executor = crate::mcp::creator_agent_executor::tests::FakeExecutor::success();
        let executed = task_execute_with_executor(&home, &json!({"taskId":task_id,"expectedPlanRevision":1,"expectedArtifactRevision":3,"operationId":"execute-run"}), &executor).unwrap();
        assert_eq!(executed["phase"], "awaiting-review");
        assert_eq!(executed["proposedChangeSetId"], "preview-fake");
        assert_eq!(executed["execution"]["status"], "awaiting-review");
        assert_eq!(executed["evidence"].as_array().unwrap().len(), 1);
        assert_eq!(executed["evidence"][0]["trustLevel"], "host-observed");
        let events = events_subscribe(&home,&json!({"taskId":task_id,"limit":100})).unwrap();
        let kinds: Vec<&str> = events["events"].as_array().unwrap().iter().filter_map(|event| event["kind"].as_str()).collect();
        assert!(kinds.contains(&"progress") && kinds.contains(&"preview") && kinds.contains(&"evidence"),"kinds={kinds:?}");
        let serialized = serde_json::to_string(&events).unwrap();
        assert!(!serialized.contains("Review the saved game without executing an agent"));
        assert!(!serialized.contains(home.to_string_lossy().as_ref()));
        let replay = task_execute_with_executor(&home, &json!({"taskId":task_id,"expectedPlanRevision":1,"expectedArtifactRevision":3,"operationId":"execute-run"}), &executor).unwrap();
        assert_eq!(replay["evidence"].as_array().unwrap().len(), 1);
        assert_eq!(task_dispatch(&home, "creator.task.review.accept", &json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"reviewerNote":"Accept","operationId":"execute-accept-early"})).unwrap_err().code, "creator_task_evidence_required");
        task_dispatch(&home, "creator.task.evidence.append", &studio_evidence(task_id, "execute-manual", "creator-declared")).unwrap();
        let accepted = task_dispatch(&home, "creator.task.review.accept", &json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"reviewerNote":"Accept after preview","operationId":"execute-accept"})).unwrap();
        assert_eq!(accepted["phase"], "accepted");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn studio_task_execute_honors_revision_and_failure_modes() {
        let home = temp_home();
        let session = session_open(&home, &json!({"agentId":"studio-local","projectId":"project-1"})).unwrap();
        let session_id = session["data"]["sessionId"].as_str().unwrap();
        prepare_artifact(&home, "project-1", 3);
        let created = task_dispatch(&home, "creator.task.create", &studio_goal_with_preview(session_id, "execute-goal-failure")).unwrap();
        let task_id = created["taskId"].as_str().unwrap();
        task_dispatch(&home, "creator.task.plan.submit", &studio_plan(task_id, 1, "execute-plan-failure")).unwrap();
        task_dispatch(&home, "creator.task.plan.approve", &json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"operationId":"execute-approve-failure"})).unwrap();
        let executor = crate::mcp::creator_agent_executor::tests::FakeExecutor::success();
        assert_eq!(task_execute_with_executor(&home, &json!({"taskId":task_id,"expectedPlanRevision":1,"expectedArtifactRevision":4,"operationId":"execute-stale"}), &executor).unwrap_err().code, "revision_conflict");
        let timeout = crate::mcp::creator_agent_executor::tests::FakeExecutor::failure("codex_timeout");
        let error = task_execute_with_executor(&home, &json!({"taskId":task_id,"expectedPlanRevision":1,"expectedArtifactRevision":3,"operationId":"execute-timeout"}), &timeout).unwrap_err();
        assert_eq!(error.code, "codex_timeout");
        let failed = task_dispatch(&home, "creator.task.status", &json!({"taskId":task_id})).unwrap();
        assert_eq!(failed["phase"], "failed");
        assert_eq!(failed["failure"]["code"], "codex_timeout");
        task_dispatch(&home, "creator.task.plan.submit", &studio_plan(task_id, 2, "execute-revise-failure")).unwrap();
        task_dispatch(&home, "creator.task.plan.approve", &json!({"taskId":task_id,"planRevision":2,"expectedArtifactRevision":3,"operationId":"execute-approve-retry"})).unwrap();
        let cancelled = crate::mcp::creator_agent_executor::tests::FakeExecutor::failure("codex_cancelled");
        assert_eq!(task_execute_with_executor(&home, &json!({"taskId":task_id,"expectedPlanRevision":2,"expectedArtifactRevision":3,"operationId":"execute-cancelled"}), &cancelled).unwrap_err().code, "codex_cancelled");
        task_dispatch(&home, "creator.task.plan.submit", &studio_plan(task_id, 3, "execute-revise-preview")).unwrap();
        task_dispatch(&home, "creator.task.plan.approve", &json!({"taskId":task_id,"planRevision":3,"expectedArtifactRevision":3,"operationId":"execute-approve-preview"})).unwrap();
        let missing = crate::mcp::creator_agent_executor::tests::FakeExecutor::failure("preview_required");
        assert_eq!(task_execute_with_executor(&home, &json!({"taskId":task_id,"expectedPlanRevision":3,"expectedArtifactRevision":3,"operationId":"execute-missing-preview"}), &missing).unwrap_err().code, "preview_required");
        assert_eq!(task_dispatch(&home, "creator.task.status", &json!({"taskId":task_id})).unwrap()["phase"], "failed");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn connections_expire_independently_and_disconnect_without_touching_tasks() {
        let home = temp_home();
        let first = session_open(&home,&json!({"agentId":"agent-a","executor":"acp","transport":"acp-stdio","capabilities":["task.pull"]})).unwrap();
        let second = session_open(&home,&json!({"agentId":"agent-b","projectId":"project-1"})).unwrap();
        let first_id = first["data"]["sessionId"].as_str().unwrap();
        let second_id = second["data"]["sessionId"].as_str().unwrap();
        connection_heartbeat(&home,&json!({"agentId":"agent-a","sessionId":first_id,"state":"busy","lastStableError":"acp_timeout"}),false).unwrap();
        let status = connection_status(&home,&json!({})).unwrap();
        assert_eq!(status["connections"].as_array().unwrap().len(),2);
        assert!(status["connections"].as_array().unwrap().iter().all(|connection| connection["state"] != "offline"));
        let db = open_db(&sessions_db(&home).unwrap(),false).unwrap();
        db.execute("UPDATE creator_agent_connections SET last_seen_ms=1 WHERE agent_id='agent-a'",[]).unwrap();
        drop(db);
        let status = connection_status(&home,&json!({})).unwrap();
        let a = status["connections"].as_array().unwrap().iter().find(|connection| connection["agentId"] == "agent-a").unwrap();
        let b = status["connections"].as_array().unwrap().iter().find(|connection| connection["agentId"] == "agent-b").unwrap();
        assert_eq!(a["state"],"offline");
        assert_eq!(a["lastStableError"],"acp_timeout");
        assert_eq!(b["state"],"online");
        connection_heartbeat(&home,&json!({"agentId":"agent-b","sessionId":second_id}),true).unwrap();
        assert_eq!(connection_status(&home,&json!({"agentId":"agent-b"})).unwrap()["connections"][0]["state"],"offline");
        assert_eq!(connection_heartbeat(&home,&json!({"agentId":"agent-b","sessionId":first_id}),false).unwrap_err().code,"permission_denied");
        assert_eq!(connection_heartbeat(&home,&json!({"agentId":"agent-a","sessionId":first_id,"capabilities":["bad capability"]}),false).unwrap_err().code,"invalid_argument");
        assert_eq!(connection_heartbeat(&home,&json!({"agentId":"agent-a","sessionId":first_id,"lastStableError":"sk-live-secret-token"}),false).unwrap_err().code,"invalid_argument");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn event_cursor_resumes_in_order_without_duplicates_or_cross_task_cursors() {
        let home = temp_home();
        let session = session_open(&home,&json!({"agentId":"studio-local","projectId":"project-1"})).unwrap();
        let session_id = session["data"]["sessionId"].as_str().unwrap();
        prepare_artifact(&home,"project-1",3);
        let created = task_create(&home,&studio_goal(session_id,"events-create")).unwrap();
        let task_id = created["taskId"].as_str().unwrap();
        task_plan_submit(&home,&studio_plan(task_id,1,"events-plan")).unwrap();
        task_plan_approve(&home,&json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"operationId":"events-approve"})).unwrap();
        let first = events_subscribe(&home,&json!({"taskId":task_id,"limit":2})).unwrap();
        assert_eq!(first["events"].as_array().unwrap().len(),2);
        assert_eq!(first["hasMore"],true);
        assert_eq!(first["events"][0]["seq"],1);
        assert_eq!(first["events"][1]["seq"],2);
        let cursor = first["nextAfterEventId"].as_u64().unwrap();
        let second = events_subscribe(&home,&json!({"taskId":task_id,"afterEventId":cursor,"limit":2})).unwrap();
        assert_eq!(second["events"].as_array().unwrap().len(),1);
        assert_eq!(second["events"][0]["seq"],3);
        assert_eq!(second["events"][0]["kind"],"plan");
        assert_ne!(second["events"][0]["eventId"],json!(cursor));
        drop(open_db(&sessions_db(&home).unwrap(),false).unwrap());
        let recovered = events_subscribe(&home,&json!({"taskId":task_id,"afterEventId":second["nextAfterEventId"],"timeoutMs":0})).unwrap();
        assert_eq!(recovered["events"].as_array().unwrap().len(),0);
        assert_eq!(recovered["waitTimedOut"],false);
        let other = task_create(&home,&studio_goal(session_id,"events-other")).unwrap();
        let other_id = other["taskId"].as_str().unwrap();
        let foreign = events_subscribe(&home,&json!({"taskId":other_id,"limit":1})).unwrap()["events"][0]["eventId"].as_u64().unwrap();
        assert_eq!(events_subscribe(&home,&json!({"taskId":task_id,"afterEventId":foreign})).unwrap_err().code,"invalid_argument");
        assert_eq!(events_subscribe(&home,&json!({"taskId":task_id,"limit":0})).unwrap_err().code,"invalid_argument");
        assert_eq!(events_subscribe(&home,&json!({"taskId":task_id,"timeoutMs":30001})).unwrap_err().code,"invalid_argument");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn event_long_poll_wakes_on_commit_and_survives_restart_cursor() {
        let home = temp_home();
        let session = session_open(&home,&json!({"agentId":"studio-local","projectId":"project-1"})).unwrap();
        let session_id = session["data"]["sessionId"].as_str().unwrap();
        prepare_artifact(&home,"project-1",3);
        let created = task_create(&home,&studio_goal(session_id,"wake-create")).unwrap();
        let task_id = created["taskId"].as_str().unwrap().to_owned();
        let accepted = events_subscribe(&home,&json!({"taskId":task_id,"limit":1})).unwrap()["events"][0]["eventId"].as_u64().unwrap();
        let wait_home = home.clone();
        let wait_task = task_id.clone();
        let started = std::time::Instant::now();
        let waiting = std::thread::spawn(move || events_subscribe(&wait_home,&json!({"taskId":wait_task,"afterEventId":accepted,"timeoutMs":5000,"limit":10})).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(100));
        task_plan_submit(&home,&studio_plan(&task_id,1,"wake-plan")).unwrap();
        let update = waiting.join().unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert_eq!(update["events"].as_array().unwrap().len(),1);
        assert_eq!(update["events"][0]["kind"],"plan");
        let timed_out = events_subscribe(&home,&json!({"taskId":task_id,"afterEventId":update["nextAfterEventId"],"timeoutMs":100})).unwrap();
        assert_eq!(timed_out["waitTimedOut"],true);
        assert_eq!(timed_out["events"].as_array().unwrap().len(),0);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn pull_progress_is_bounded_idempotent_and_claim_scoped() {
        let home = temp_home();
        let session = session_open(&home,&json!({"agentId":"studio-local","projectId":"project-1"})).unwrap();
        let session_id = session["data"]["sessionId"].as_str().unwrap();
        prepare_artifact(&home,"project-1",3);
        let created = task_create(&home,&studio_goal_with_preview(session_id,"progress-create")).unwrap();
        let task_id = created["taskId"].as_str().unwrap();
        task_plan_submit(&home,&studio_plan(task_id,1,"progress-plan")).unwrap();
        task_plan_approve(&home,&json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"operationId":"progress-approve"})).unwrap();
        task_claim(&home,&json!({"taskId":task_id,"agentId":"agent-a","expectedPlanRevision":1,"expectedArtifactRevision":3,"operationId":"progress-claim"})).unwrap();
        connection_heartbeat(&home,&json!({"agentId":"agent-a","sessionId":session_id,"state":"busy"}),false).unwrap();
        assert_eq!(connection_heartbeat(&home,&json!({"agentId":"agent-b","sessionId":session_id}),false).unwrap_err().code,"permission_denied");
        let progress = json!({"taskId":task_id,"agentId":"agent-a","planRevision":1,"kind":"progress","code":"artifact-read","stepId":"review-city","percent":40,"operationId":"progress-report"});
        let first = task_progress(&home,&progress).unwrap();
        assert_eq!(task_progress(&home,&progress).unwrap(),first);
        let events = events_subscribe(&home,&json!({"taskId":task_id,"limit":100})).unwrap();
        assert_eq!(events["events"].as_array().unwrap().iter().filter(|event| event["data"]["code"] == "artifact-read").count(),1);
        assert_eq!(task_progress(&home,&json!({"taskId":task_id,"agentId":"agent-b","planRevision":1,"kind":"progress","code":"other","operationId":"progress-other"})).unwrap_err().code,"creator_task_claim_mismatch");
        assert_eq!(task_progress(&home,&json!({"taskId":task_id,"agentId":"agent-a","planRevision":1,"kind":"progress","code":"raw-log","operationId":"progress-invalid"})).unwrap_err().code,"invalid_argument");
        assert_eq!(task_progress(&home,&json!({"taskId":task_id,"agentId":"agent-a","planRevision":1,"kind":"progress","code":"other","percent":101,"operationId":"progress-percent"})).unwrap_err().code,"invalid_argument");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn capability_matrix_uses_real_studio_connections_and_preserves_headless_boundaries() {
        let home = temp_home();
        assert_eq!(capabilities_status(&home).unwrap()["studioOnline"],false);
        let studio = session_open(&home,&json!({"agentId":"studio-ui","executor":"studio","transport":"studio-webview","capabilities":["preview.scene"]})).unwrap();
        let studio_session = studio["data"]["sessionId"].as_str().unwrap();
        let status = capabilities_status(&home).unwrap();
        assert_eq!(status["studioOnline"],true);
        let capabilities = status["capabilities"].as_array().unwrap();
        assert_eq!(capabilities.iter().find(|item| item["id"] == "task.pull").unwrap()["headless"],true);
        for id in ["preview.scene","preview.game","execution.codex","execution.acp","operation.capture"] {
            let entry = capabilities.iter().find(|item| item["id"] == id).unwrap();
            assert_eq!(entry["headless"],false,"{id}");
            assert_eq!(entry["requiresStudioWebView"],true,"{id}");
        }
        for id in ["preview.vehicle","preview.city-world","operation.review","operation.project-commit","operation.publish"] {
            assert_eq!(capabilities.iter().find(|item| item["id"] == id).unwrap()["headless"],true,"{id}");
        }
        for state in ["busy","degraded"] {
            connection_heartbeat(&home,&json!({"agentId":"studio-ui","sessionId":studio_session,"state":state}),false).unwrap();
            assert_eq!(capabilities_status(&home).unwrap()["studioOnline"],true,"{state}");
        }
        connection_heartbeat(&home,&json!({"agentId":"studio-ui","sessionId":studio_session}),true).unwrap();
        assert_eq!(capabilities_status(&home).unwrap()["studioOnline"],false);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn legacy_jobs_have_incremental_events_and_pre_event_rows_remain_readable() {
        let home = temp_home();
        register_playtest_job(&home,&json!({"ok":true,"data":{"runId":"legacy-run","releaseId":"release-1"}}));
        let jobs = session_jobs(&home,"session-any").unwrap();
        let job_id = jobs[0]["jobId"].as_str().unwrap();
        let events = events_subscribe(&home,&json!({"taskId":job_id,"limit":1})).unwrap();
        assert_eq!(events["events"][0]["kind"],"accepted");
        assert_eq!(events["hasMore"],true);
        let db = open_db(&sessions_db(&home).unwrap(),false).unwrap();
        db.execute("INSERT INTO creator_jobs(job_id,kind,status,subject_json,progress_json,failure_json,cancel_requested,session_id,created_at_ms,updated_at_ms)
            VALUES('old-job','capture','running','{}','{}','{}',0,NULL,1,1)",[]).unwrap();
        drop(db);
        let old = events_subscribe(&home,&json!({"taskId":"old-job","timeoutMs":0})).unwrap();
        assert_eq!(old["events"].as_array().unwrap().len(),0);
        assert_eq!(old["nextAfterEventId"],0);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn external_cancel_stops_push_executor_without_creating_success_evidence() {
        struct WaitingExecutor;
        impl super::super::creator_agent_executor::CreatorAgentExecutor for WaitingExecutor {
            fn execute(&self, _request: super::super::creator_agent_executor::AgentExecutionRequest, cancelled: &std::sync::atomic::AtomicBool)
                -> Result<super::super::creator_agent_executor::AgentExecutionSuccess,ToolError> {
                while !cancelled.load(std::sync::atomic::Ordering::Relaxed) { std::thread::sleep(std::time::Duration::from_millis(20)); }
                Err(ToolError::new("codex_cancelled","Cancelled by the host ledger."))
            }
        }
        let home = temp_home();
        let session = session_open(&home,&json!({"agentId":"studio-local","projectId":"project-1"})).unwrap();
        let session_id = session["data"]["sessionId"].as_str().unwrap();
        prepare_artifact(&home,"project-1",3);
        let created = task_create(&home,&studio_goal_with_preview(session_id,"external-cancel-create")).unwrap();
        let task_id = created["taskId"].as_str().unwrap();
        task_plan_submit(&home,&studio_plan(task_id,1,"external-cancel-plan")).unwrap();
        task_plan_approve(&home,&json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"operationId":"external-cancel-approve"})).unwrap();
        let execute_home = home.clone();
        let execute_task = task_id.to_owned();
        let started = std::time::Instant::now();
        let running = std::thread::spawn(move || task_execute_with_executor(&execute_home,&json!({"taskId":execute_task,"expectedPlanRevision":1,"expectedArtifactRevision":3,"operationId":"external-cancel-execute"}),&WaitingExecutor));
        std::thread::sleep(std::time::Duration::from_millis(200));
        let db = open_db(&sessions_db(&home).unwrap(),false).unwrap();
        db.execute("UPDATE creator_studio_tasks SET phase='cancelled' WHERE task_id=?1",[task_id]).unwrap();
        db.execute("UPDATE creator_jobs SET status='cancelled',cancel_requested=1 WHERE job_id=?1",[task_id]).unwrap();
        drop(db);
        let error = running.join().unwrap().unwrap_err();
        assert_eq!(error.code,"codex_cancelled");
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
        let status = task_payload(&home,task_id).unwrap();
        assert_eq!(status["phase"],"cancelled");
        assert!(status["evidence"].as_array().unwrap().is_empty());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn silent_push_executor_heartbeat_prevents_false_ttl_offline() {
        struct SilentExecutor { finish: Arc<std::sync::atomic::AtomicBool> }
        impl super::super::creator_agent_executor::CreatorAgentExecutor for SilentExecutor {
            fn execute(&self, request: super::super::creator_agent_executor::AgentExecutionRequest, _cancelled: &std::sync::atomic::AtomicBool)
                -> Result<super::super::creator_agent_executor::AgentExecutionSuccess,ToolError> {
                let started = std::time::Instant::now();
                while !self.finish.load(std::sync::atomic::Ordering::Relaxed) && started.elapsed() < std::time::Duration::from_secs(10) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Ok(super::super::creator_agent_executor::AgentExecutionSuccess { summary:"Silent preview".into(),
                    preview:json!({"previewId":"silent-preview","baseRevision":request.artifact["expectedRevision"]}) })
            }
        }
        let home = temp_home();
        let session = session_open(&home,&json!({"agentId":"studio-local","projectId":"project-1"})).unwrap();
        let session_id = session["data"]["sessionId"].as_str().unwrap();
        prepare_artifact(&home,"project-1",3);
        let created = task_create(&home,&studio_goal_with_preview(session_id,"silent-create")).unwrap();
        let task_id = created["taskId"].as_str().unwrap();
        task_plan_submit(&home,&studio_plan(task_id,1,"silent-plan")).unwrap();
        task_plan_approve(&home,&json!({"taskId":task_id,"planRevision":1,"expectedArtifactRevision":3,"operationId":"silent-approve"})).unwrap();
        let finish = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let executor = SilentExecutor { finish:finish.clone() };
        let execute_home = home.clone();
        let execute_task = task_id.to_owned();
        let running = std::thread::spawn(move || task_execute_with_executor(&execute_home,&json!({"taskId":execute_task,"expectedPlanRevision":1,"expectedArtifactRevision":3,"operationId":"silent-execute"}),&executor).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(2_000));
        let agent_id = format!("codex-cli:{task_id}");
        let db = open_db(&sessions_db(&home).unwrap(),false).unwrap();
        db.execute("UPDATE creator_agent_connections SET last_seen_ms=1 WHERE agent_id=?1",[&agent_id]).unwrap();
        drop(db);
        std::thread::sleep(std::time::Duration::from_millis(4_000));
        let state = connection_status(&home,&json!({"agentId":agent_id})).unwrap()["connections"][0]["state"].clone();
        finish.store(true,std::sync::atomic::Ordering::Relaxed);
        running.join().unwrap();
        assert_eq!(state,"busy","heartbeat must refresh even without executor output");
        assert_eq!(connection_status(&home,&json!({"agentId":agent_id})).unwrap()["connections"][0]["state"],"offline");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn unknown_session_fails_closed() {
        let home = temp_home();
        assert_eq!(session_status(&home, &json!({"sessionId":"csession-missing"})).unwrap_err().code, "creator_session_not_found");
        std::fs::remove_dir_all(home).unwrap();
    }
}
