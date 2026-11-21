//! Player-scoped Story persistence: CAS state, event facts, idempotent receipts
//! and post-commit Outbox share one immediate SQLite transaction. Actor/model
//! work belongs outside this module; no LLM turn is ever held inside a transaction.
#![allow(dead_code)]
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use crate::creator_store::{canonical_json, database, digest, now_ms, valid_id};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoryClockAuthorityV1 {
    pub revision: String,
    pub tick: u64,
    pub simulation_utc_ms: u64,
}

pub(crate) struct StoryCommitCommandV1 {
    pub operation_id: String,
    pub event_id: String,
    pub player_id: String,
    pub city_id: String,
    pub game_id: String,
    /// 显式 Story 身份（RFC §3.5 四元组中 player×city×resident 之外的增量）；
    /// None 走 legacy 合成映射（每 gameId 一个合成 storyId）。
    pub story_scope: Option<StoryStateScopeV1>,
    pub resident_id: Option<String>,
    pub expected_story_revision: String,
    pub expected_clock_revision: String,
    pub intent: Value,
    pub run_id: String,
    /// WorldEventEnvelopeV1 信封字段（RFC §3.2，PR-4 信封化）：全部可缺省，
    /// None 落库 NULL——旧行与既有调用点的语义零变化；缺省不进请求哈希。
    pub rule_set_digest: Option<String>,
    pub causation_id: Option<String>,
    pub correlation_id: Option<String>,
}

/// Story 状态作用域的存储增量（RFC §3.5）：storyId = 内容身份，storyRunId = 玩家长期进度身份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoryStateScopeV1 {
    pub story_id: String,
    pub story_run_id: String,
}

/// Legacy 合成映射（RFC §3.5）：旧行/旧调用方的 player×city×game 键映射到
/// 每 gameId 一个合成 story —— story_id = game_id、story_run_id = 'legacy-' || game_id，
/// 旧行为经同一映射保持不变，合成身份在行内自描述、非静默改写。
pub(crate) fn legacy_story_scope(game_id: &str) -> (String, String) {
    (game_id.to_string(), format!("legacy-{game_id}"))
}

fn story_table_exists(db: &Connection, table: &str) -> Result<bool, &'static str> {
    db.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1", params![table], |_| Ok(()))
        .optional().map_err(|_| "creator_store_unavailable").map(|found| found.is_some())
}

fn story_table_has_column(db: &Connection, table: &str, column: &str) -> Result<bool, &'static str> {
    db.query_row(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1"), params![column], |_| Ok(()))
        .optional().map_err(|_| "creator_store_unavailable").map(|found| found.is_some())
}

fn legacy_story_schema(db: &Connection) -> Result<bool, &'static str> {
    for table in ["story_states", "story_events", "story_outbox", "story_operations"] {
        if story_table_exists(db, table)? && !story_table_has_column(db, table, "story_id")? { return Ok(true); }
    }
    Ok(false)
}

/// 一次性键迁移（RFC §3.5）：旧 (player,city,game) 主键重建为含 story 维度的主键，
/// 旧行按 legacy_story_scope 合成映射搬运，不静默改写；已含 story_id 的表跳过。
fn rebuild_legacy_story_tables(db: &Connection) -> Result<(), &'static str> {
    db.execute_batch("BEGIN IMMEDIATE").map_err(|_| "creator_store_unavailable")?;
    let rebuild = |table: &str, create: &str, copy: &str| -> Result<(), &'static str> {
        if !story_table_exists(db, table)? || story_table_has_column(db, table, "story_id")? { return Ok(()); }
        db.execute_batch(&format!("{create};{copy};DROP TABLE {table};ALTER TABLE {table}_v2 RENAME TO {table};"))
            .map_err(|_| "creator_store_unavailable")
    };
    let result = rebuild("story_states",
        "CREATE TABLE story_states_v2 (player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL, story_id TEXT NOT NULL, story_run_id TEXT NOT NULL, revision TEXT NOT NULL, document_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(player_id,city_id,story_id,story_run_id))",
        "INSERT INTO story_states_v2(player_id,city_id,game_id,story_id,story_run_id,revision,document_json,updated_at_ms) SELECT player_id,city_id,game_id,game_id,'legacy-'||game_id,revision,document_json,updated_at_ms FROM story_states")
        .and_then(|_| rebuild("story_events",
            "CREATE TABLE story_events_v2 (event_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL, story_id TEXT NOT NULL, story_run_id TEXT NOT NULL, rule_id TEXT NOT NULL, status TEXT NOT NULL, due_at_utc_ms INTEGER NOT NULL, last_processed_tick INTEGER NOT NULL, idempotency_key TEXT NOT NULL, story_revision TEXT NOT NULL, clock_revision TEXT NOT NULL, intent_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, rule_set_digest TEXT, causation_id TEXT, correlation_id TEXT, PRIMARY KEY(player_id,city_id,story_id,story_run_id,event_id))",
            "INSERT INTO story_events_v2(event_id,occurrence_id,player_id,city_id,game_id,story_id,story_run_id,rule_id,status,due_at_utc_ms,last_processed_tick,idempotency_key,story_revision,clock_revision,intent_json,created_at_ms) SELECT event_id,occurrence_id,player_id,city_id,game_id,game_id,'legacy-'||game_id,rule_id,status,due_at_utc_ms,last_processed_tick,idempotency_key,story_revision,clock_revision,intent_json,created_at_ms FROM story_events"))
        .and_then(|_| rebuild("story_outbox",
            "CREATE TABLE story_outbox_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, operation_id TEXT NOT NULL, player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL, story_id TEXT NOT NULL, story_run_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, acknowledged_at_ms INTEGER, UNIQUE(event_id,operation_id,story_id,story_run_id))",
            "INSERT INTO story_outbox_v2(id,event_id,operation_id,player_id,city_id,game_id,story_id,story_run_id,payload_json,status,created_at_ms,acknowledged_at_ms) SELECT id,event_id,operation_id,player_id,city_id,game_id,game_id,'legacy-'||game_id,payload_json,status,created_at_ms,acknowledged_at_ms FROM story_outbox"))
        .and_then(|_| rebuild("story_operations",
            "CREATE TABLE story_operations_v2 (player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL, story_id TEXT NOT NULL, story_run_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY(player_id,city_id,story_id,story_run_id,operation_id))",
            "INSERT INTO story_operations_v2(player_id,city_id,game_id,story_id,story_run_id,operation_id,request_hash,result_json,created_at_ms) SELECT player_id,city_id,game_id,game_id,'legacy-'||game_id,operation_id,request_hash,result_json,created_at_ms FROM story_operations"))
        .and_then(|_| db.execute_batch("COMMIT").map_err(|_| "creator_store_unavailable"));
    if result.is_err() { let _ = db.execute_batch("ROLLBACK"); }
    result
}

pub(crate) fn migrate_story(db: &Connection) -> Result<(), &'static str> {
    if legacy_story_schema(db)? { rebuild_legacy_story_tables(db)?; }
    db.execute_batch("CREATE TABLE IF NOT EXISTS story_states (
        player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL,
        story_id TEXT NOT NULL, story_run_id TEXT NOT NULL,
        revision TEXT NOT NULL, document_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(player_id,city_id,story_id,story_run_id)
    );
    CREATE TABLE IF NOT EXISTS story_events (
        event_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, player_id TEXT NOT NULL,
        city_id TEXT NOT NULL, game_id TEXT NOT NULL, story_id TEXT NOT NULL, story_run_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        status TEXT NOT NULL, due_at_utc_ms INTEGER NOT NULL, last_processed_tick INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL, story_revision TEXT NOT NULL, clock_revision TEXT NOT NULL,
        intent_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
        rule_set_digest TEXT, causation_id TEXT, correlation_id TEXT,
        PRIMARY KEY(player_id,city_id,story_id,story_run_id,event_id)
    );
    CREATE TABLE IF NOT EXISTS story_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL,
        story_id TEXT NOT NULL, story_run_id TEXT NOT NULL,
        payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
        acknowledged_at_ms INTEGER, UNIQUE(event_id,operation_id,story_id,story_run_id)
    );
    CREATE TABLE IF NOT EXISTS story_operations (
        player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL,
        story_id TEXT NOT NULL, story_run_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, PRIMARY KEY(player_id,city_id,story_id,story_run_id,operation_id)
    );").map_err(|_| "creator_store_unavailable")?;
    // 信封列迁移（RFC §3.2，PR-4）：信封化之前已建库的 story_events 缺列时
    // ALTER 补齐；列为可空 TEXT，旧行一律 NULL，不做破坏性迁移。
    if story_table_exists(db, "story_events")? {
        for column in ["rule_set_digest", "causation_id", "correlation_id"] {
            if !story_table_has_column(db, "story_events", column)? {
                db.execute_batch(&format!("ALTER TABLE story_events ADD COLUMN {column} TEXT;"))
                    .map_err(|_| "creator_store_unavailable")?;
            }
        }
    }
    Ok(())
}


fn validate_story_command(command: &StoryCommitCommandV1) -> Result<(), &'static str> {
    let kind = command.intent.get("kind").and_then(Value::as_str).ok_or("game_argument_invalid")?;
    match kind {
        "invite" => {
            if command.resident_id.as_deref().unwrap_or("").is_empty() || command.intent.get("targetId").and_then(Value::as_str).unwrap_or("").is_empty() {
                return Err("game_argument_invalid");
            }
        }
        "speak" => {
            let text = command.intent.get("text").and_then(Value::as_str).ok_or("game_argument_invalid")?;
            if text.is_empty() || text.chars().count() > 2_000 { return Err("game_argument_invalid"); }
        }
        _ => return Err("game_actor_intent_denied"),
    }
    if command.intent.get("__proto__").is_some() || command.intent.get("constructor").is_some() || command.intent.get("prototype").is_some() {
        return Err("game_argument_invalid");
    }
    Ok(())
}

fn evaluate_story_state(command: &StoryCommitCommandV1, current: &Value) -> Result<Value, &'static str> {
    let mut state = current.as_object().cloned().ok_or("creator_store_unavailable")?;
    match command.intent.get("kind").and_then(Value::as_str) {
        Some("speak") => {}
        Some("invite") => {
            let affection = state.get("affection").map(|value| value.as_i64().ok_or("game_story_state_invalid")).transpose()?.unwrap_or(0);
            if !(0..100).contains(&affection) { return Err("game_story_rule_denied"); }
            state.insert("affection".to_string(), json!(affection + 1));
        }
        _ => return Err("game_actor_intent_denied"),
    }
    let state = Value::Object(state);
    if canonical_json(&state).map_err(|_| "game_argument_invalid")?.len() > 16_384 { return Err("game_argument_invalid"); }
    Ok(state)
}

pub(crate) fn commit_story(home: &Path, command: StoryCommitCommandV1, clock: StoryClockAuthorityV1) -> Result<Value, &'static str> {
    if clock.revision != command.expected_clock_revision { return Err("city_time_revision_conflict"); }
    if clock.tick == 0 { return Err("game_time_domain_invalid"); }
    validate_story_command(&command)?;
    if command.operation_id.is_empty() || command.event_id.is_empty() || command.player_id.is_empty()
        || command.city_id.is_empty() || command.game_id.is_empty() || command.run_id.is_empty() || !command.intent.is_object() {
        return Err("game_argument_invalid");
    }
    if command.story_scope.as_ref().is_some_and(|scope| scope.story_id.is_empty() || scope.story_run_id.is_empty()) {
        return Err("game_argument_invalid");
    }
    if [&command.rule_set_digest, &command.causation_id, &command.correlation_id]
        .into_iter().any(|field| field.as_deref().is_some_and(str::is_empty)) {
        return Err("game_argument_invalid");
    }
    // 请求哈希只含逻辑载荷；story_scope 是寻址而非载荷（RFC §3.5），显式与合成
    // 同址的哈希保持一致，legacy 回执哈希经迁移后仍可命中。信封字段（RFC §3.2）
    // 是事件事实的载荷增量：缺省（None）不进哈希——既有请求哈希逐字节不变；
    // 携带信封的提交把三个字段纳入哈希，同 operationId 换信封载荷仍被冲突检测拦截。
    let (story_id, story_run_id) = match command.story_scope.as_ref() {
        Some(scope) => (scope.story_id.clone(), scope.story_run_id.clone()),
        None => legacy_story_scope(&command.game_id),
    };
    let mut request_payload = json!({
        "operationId":command.operation_id,"eventId":command.event_id,"playerId":command.player_id,
        "cityId":command.city_id,"gameId":command.game_id,"residentId":command.resident_id,
        "expectedStoryRevision":command.expected_story_revision,"expectedClockRevision":command.expected_clock_revision,
        "intent":command.intent,"runId":command.run_id,
    });
    if command.rule_set_digest.is_some() { request_payload["ruleSetDigest"] = json!(command.rule_set_digest); }
    if command.causation_id.is_some() { request_payload["causationId"] = json!(command.causation_id); }
    if command.correlation_id.is_some() { request_payload["correlationId"] = json!(command.correlation_id); }
    let request_hash = digest(&canonical_json(&request_payload).map_err(|_| "game_argument_invalid")?);
    let mut db = database(home)?;
    migrate_story(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some((hash, result)) = tx.query_row(
        "SELECT request_hash,result_json FROM story_operations WHERE player_id=?1 AND city_id=?2 AND story_id=?3 AND story_run_id=?4 AND operation_id=?5",
        params![command.player_id,command.city_id,story_id,story_run_id,command.operation_id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)),
    ).optional().map_err(|_| "creator_store_unavailable")? {
        if hash != request_hash { return Err("operation_id_conflict"); }
        return serde_json::from_str(&result).map_err(|_| "creator_store_unavailable");
    }
    let current = tx.query_row(
        "SELECT revision,document_json FROM story_states WHERE player_id=?1 AND city_id=?2 AND story_id=?3 AND story_run_id=?4",
        params![command.player_id,command.city_id,story_id,story_run_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    ).optional().map_err(|_| "creator_store_unavailable")?
        .map(|(revision, document)| serde_json::from_str::<Value>(&document).map(|state| (revision, state)).map_err(|_| "creator_store_unavailable"))
        .transpose()?.unwrap_or_else(|| ("0".to_string(), json!({})));
    if current.0 != command.expected_story_revision { return Err("game_storage_revision_conflict"); }
    let state = evaluate_story_state(&command, &current.1)?;
    let current = current.0;
    let now = now_ms();
    let result = json!({
        "eventId":command.event_id,"operationId":command.operation_id,
        "storyRevision":digest(&format!("{current}:{request_hash}")),
        "clockRevision":command.expected_clock_revision,"status":"committed",
    });
    tx.execute("INSERT INTO story_events(event_id,occurrence_id,player_id,city_id,game_id,story_id,story_run_id,rule_id,status,due_at_utc_ms,last_processed_tick,idempotency_key,story_revision,clock_revision,intent_json,rule_set_digest,causation_id,correlation_id,created_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'committed',?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
        params![command.event_id,command.event_id,command.player_id,command.city_id,command.game_id,story_id,story_run_id,command.event_id,
            clock.simulation_utc_ms,clock.tick,command.operation_id,result["storyRevision"].as_str().unwrap_or(""),command.expected_clock_revision,
            canonical_json(&command.intent).map_err(|_| "game_argument_invalid")?,command.rule_set_digest,command.causation_id,command.correlation_id,now])
        .map_err(|_| "creator_store_unavailable")?;
    let document = canonical_json(&state).map_err(|_| "game_argument_invalid")?;
    tx.execute("INSERT INTO story_states(player_id,city_id,game_id,story_id,story_run_id,revision,document_json,updated_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
        ON CONFLICT(player_id,city_id,story_id,story_run_id) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json,updated_at_ms=excluded.updated_at_ms",
        params![command.player_id,command.city_id,command.game_id,story_id,story_run_id,result["storyRevision"].as_str().unwrap_or(""),document,now])
        .map_err(|_| "creator_store_unavailable")?;
    tx.execute("INSERT INTO story_outbox(event_id,operation_id,player_id,city_id,game_id,story_id,story_run_id,payload_json,status,created_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pending',?9)",
        params![command.event_id,command.operation_id,command.player_id,command.city_id,command.game_id,story_id,story_run_id,
            canonical_json(&result).map_err(|_| "game_argument_invalid")?,now])
        .map_err(|_| "creator_store_unavailable")?;
    let outbox_id = tx.last_insert_rowid();
    tx.execute("INSERT INTO story_operations(player_id,city_id,game_id,story_id,story_run_id,operation_id,request_hash,result_json,created_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![command.player_id,command.city_id,command.game_id,story_id,story_run_id,command.operation_id,request_hash,
            canonical_json(&result).map_err(|_| "game_argument_invalid")?,now])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"eventId":command.event_id,"operationId":command.operation_id,
        "storyRevision":result["storyRevision"].as_str().unwrap_or(""),"clockRevision":command.expected_clock_revision,
        "status":"committed","outboxId":outbox_id,"alreadyCommitted":false}))
}

pub(crate) fn story_state(home: &Path, player_id: &str, city_id: &str, game_id: &str) -> Result<Value, &'static str> {
    let (story_id, story_run_id) = legacy_story_scope(game_id);
    story_state_scoped(home, player_id, city_id, &story_id, &story_run_id)
}

/// 显式 scope 读取（RFC §3.5 四元组寻址）；与 legacy 合成映射地址互不可见。
pub(crate) fn story_state_scoped(home: &Path, player_id: &str, city_id: &str, story_id: &str, story_run_id: &str) -> Result<Value, &'static str> {
    let db = database(home)?;
    migrate_story(&db)?;
    let current = db.query_row("SELECT revision,document_json FROM story_states WHERE player_id=?1 AND city_id=?2 AND story_id=?3 AND story_run_id=?4",
        params![player_id,city_id,story_id,story_run_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let Some((revision, document)) = current else { return Ok(json!({"storyRevision":"0","state":{}})); };
    let state = serde_json::from_str::<Value>(&document).map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"storyRevision":revision,"state":state}))
}

pub(crate) fn story_dialogue(home: &Path, player_id: &str, city_id: &str, game_id: &str, limit: u32) -> Result<Vec<Value>, &'static str> {
    let (story_id, story_run_id) = legacy_story_scope(game_id);
    story_dialogue_scoped(home, player_id, city_id, &story_id, &story_run_id, limit)
}

pub(crate) fn story_dialogue_scoped(home: &Path, player_id: &str, city_id: &str, story_id: &str, story_run_id: &str, limit: u32) -> Result<Vec<Value>, &'static str> {
    let db = database(home)?;
    migrate_story(&db)?;
    let mut statement = db.prepare("SELECT event_id,intent_json,story_revision,created_at_ms FROM story_events WHERE player_id=?1 AND city_id=?2 AND story_id=?3 AND story_run_id=?4 AND json_extract(intent_json,'$.kind')='speak' ORDER BY created_at_ms DESC,event_id DESC LIMIT ?5")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![player_id,city_id,story_id,story_run_id,limit.min(100)], |row| {
        Ok(json!({"eventId":row.get::<_,String>(0)?,"intent":serde_json::from_str::<Value>(&row.get::<_,String>(1)?).unwrap_or(Value::Null),
            "storyRevision":row.get::<_,String>(2)?,"createdAtMs":row.get::<_,u64>(3)?}))
    }).map_err(|_| "creator_store_unavailable")?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")
}

pub(crate) fn story_outbox(home: &Path, player_id: &str, city_id: &str, game_id: &str, limit: u32) -> Result<Vec<Value>, &'static str> {
    let (story_id, story_run_id) = legacy_story_scope(game_id);
    story_outbox_scoped(home, player_id, city_id, &story_id, &story_run_id, limit)
}

pub(crate) fn story_outbox_scoped(home: &Path, player_id: &str, city_id: &str, story_id: &str, story_run_id: &str, limit: u32) -> Result<Vec<Value>, &'static str> {
    let db = database(home)?;
    migrate_story(&db)?;
    let mut statement = db.prepare("SELECT id,event_id,operation_id,payload_json,status,created_at_ms FROM story_outbox WHERE player_id=?1 AND city_id=?2 AND story_id=?3 AND story_run_id=?4 AND status='pending' ORDER BY id LIMIT ?5")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![player_id,city_id,story_id,story_run_id,limit.min(100)], |row| {
        Ok(json!({"outboxId":row.get::<_,i64>(0)?,"eventId":row.get::<_,String>(1)?,
            "operationId":row.get::<_,String>(2)?,"payload":serde_json::from_str::<Value>(&row.get::<_,String>(3)?).unwrap_or(Value::Null),
            "status":row.get::<_,String>(4)?,"createdAtMs":row.get::<_,u64>(5)?}))
    }).map_err(|_| "creator_store_unavailable")?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")
}

pub(crate) fn acknowledge_story_outbox(home: &Path, outbox_id: i64) -> Result<bool, &'static str> {
    let db = database(home)?;
    migrate_story(&db)?;
    let changed = db.execute("UPDATE story_outbox SET status='acknowledged',acknowledged_at_ms=?2 WHERE id=?1 AND status='pending'",
        params![outbox_id,now_ms()]).map_err(|_| "creator_store_unavailable")?;
    Ok(changed == 1)
}

// ---------------------------------------------------------------------------
// 读投影（RFC §3.2）：事件行 → WorldEventEnvelopeV1 形状的有界读面。行内可得
// 字段逐一映射：type 取 intent.kind（提交校验仅放行 speak/invite）；actorId 取
// 提交玩家；simulationUtcMs 取落库的时钟模拟时间；expectedRevision 取行内权威
// story_revision（读侧下一次 CAS 的期望基线；提交前 revision 的持久化随 PR-5
// 仲裁链路落库）；scope 按 legacy 合成映射的行内自描述性判别子集（§3.5.1）；
// NULL 信封字段按可选语义省略（旧行 = 先于规则摘要关联的事实）。

pub(crate) fn story_event_envelopes(home: &Path, player_id: &str, city_id: &str, game_id: &str, limit: u32) -> Result<Vec<Value>, &'static str> {
    let (story_id, story_run_id) = legacy_story_scope(game_id);
    story_event_envelopes_scoped(home, player_id, city_id, &story_id, &story_run_id, limit)
}

pub(crate) fn story_event_envelopes_scoped(home: &Path, player_id: &str, city_id: &str, story_id: &str, story_run_id: &str, limit: u32) -> Result<Vec<Value>, &'static str> {
    let db = database(home)?;
    migrate_story(&db)?;
    let mut statement = db.prepare("SELECT event_id,game_id,story_run_id,story_revision,due_at_utc_ms,intent_json,rule_set_digest,causation_id,correlation_id FROM story_events WHERE player_id=?1 AND city_id=?2 AND story_id=?3 AND story_run_id=?4 ORDER BY created_at_ms DESC,event_id DESC LIMIT ?5")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![player_id,city_id,story_id,story_run_id,limit.min(100)], |row| {
        let event_id: String = row.get(0)?;
        let row_game_id: String = row.get(1)?;
        let row_story_run_id: String = row.get(2)?;
        let story_revision: String = row.get(3)?;
        let simulation_utc_ms: u64 = row.get(4)?;
        let intent: Value = serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or(Value::Null);
        let rule_set_digest: Option<String> = row.get(6)?;
        let causation_id: Option<String> = row.get(7)?;
        let correlation_id: Option<String> = row.get(8)?;
        let scope = if row_story_run_id == legacy_story_scope(&row_game_id).1 {
            json!({"kind":"game","playerId":player_id,"cityId":city_id,"gameId":row_game_id})
        } else {
            json!({"kind":"story","playerId":player_id,"cityId":city_id,"storyId":story_id,"storyRunId":row_story_run_id})
        };
        let mut envelope = json!({
            "eventId":event_id,"type":intent.get("kind").and_then(Value::as_str).unwrap_or(""),
            "scope":scope,"actorId":player_id,"simulationUtcMs":simulation_utc_ms,
            "expectedRevision":story_revision,"payload":intent,
        });
        if let Some(digest) = rule_set_digest { envelope["ruleSetDigest"] = json!(digest); }
        if let Some(id) = causation_id { envelope["causationId"] = json!(id); }
        if let Some(id) = correlation_id { envelope["correlationId"] = json!(id); }
        Ok(envelope)
    }).map_err(|_| "creator_store_unavailable")?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")
}

// ---------------------------------------------------------------------------
// 公共 City scope 存储（RFC §3.5.1 / §12.2）：city_resident_state 是
// CityResidentPublicScopeV1（cityId × residentId）的权威行——location_ref、
// revision CAS、updated_at_ms。本期只做存储与校验：写必须携带公共 scope，
// 私有子集与未知 kind 一律失败关闭；租约仲裁排队（§12.2）在 PR-5 接入。

/// StateScopeV1（RFC §3.5.1 Shared Contracts 判别联合）的宿主侧解析形态；
/// kind 判别逐一匹配子集，未知 kind 在解析处失败关闭。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StateScopeV1 {
    Game { player_id: String, city_id: String, game_id: String, game_run_id: Option<String> },
    Story { player_id: String, city_id: String, story_id: String, story_run_id: String, resident_id: Option<String> },
    CityResidentPublic { city_id: String, resident_id: String },
}

fn scope_text(value: &Value, key: &str) -> Result<String, &'static str> {
    value.get(key).and_then(Value::as_str).filter(|id| valid_id(id)).map(str::to_string).ok_or("game_argument_invalid")
}

fn scope_optional_text(value: &Value, key: &str) -> Result<Option<String>, &'static str> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(id) => Ok(Some(id.as_str().filter(|id| valid_id(id)).map(str::to_string).ok_or("game_argument_invalid")?)),
    }
}

pub(crate) fn parse_state_scope(value: &Value) -> Result<StateScopeV1, &'static str> {
    match value.get("kind").and_then(Value::as_str) {
        Some("game") => Ok(StateScopeV1::Game {
            player_id: scope_text(value, "playerId")?, city_id: scope_text(value, "cityId")?,
            game_id: scope_text(value, "gameId")?, game_run_id: scope_optional_text(value, "gameRunId")? }),
        Some("story") => Ok(StateScopeV1::Story {
            player_id: scope_text(value, "playerId")?, city_id: scope_text(value, "cityId")?,
            story_id: scope_text(value, "storyId")?, story_run_id: scope_text(value, "storyRunId")?,
            resident_id: scope_optional_text(value, "residentId")? }),
        Some("city-resident-public") => Ok(StateScopeV1::CityResidentPublic {
            city_id: scope_text(value, "cityId")?, resident_id: scope_text(value, "residentId")? }),
        _ => Err("game_argument_invalid"),
    }
}

pub(crate) fn migrate_city_resident_state(db: &Connection) -> Result<(), &'static str> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS city_resident_state (
        city_id TEXT NOT NULL, resident_id TEXT NOT NULL,
        location_ref TEXT NOT NULL, revision TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL, PRIMARY KEY(city_id,resident_id)
    );").map_err(|_| "creator_store_unavailable")
}

pub(crate) fn read_resident_state(home: &Path, city_id: &str, resident_id: &str) -> Result<Value, &'static str> {
    if !valid_id(city_id) || !valid_id(resident_id) { return Err("game_argument_invalid"); }
    let db = database(home)?;
    migrate_city_resident_state(&db)?;
    let row = db.query_row("SELECT location_ref,revision,updated_at_ms FROM city_resident_state WHERE city_id=?1 AND resident_id=?2",
        params![city_id,resident_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, u64>(2)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    Ok(match row {
        Some((location_ref, revision, updated_at_ms)) => json!({"cityId":city_id,"residentId":resident_id,
            "locationRef":location_ref,"revision":revision,"updatedAtMs":updated_at_ms}),
        None => json!({"cityId":city_id,"residentId":resident_id,"revision":"0"}),
    })
}

pub(crate) fn write_resident_state(home: &Path, scope: &Value, location_ref: &str, expected_revision: &str) -> Result<Value, &'static str> {
    // 解析失败关闭（未知 kind、缺字段、非法字符）；随后只放行公共子集——私有
    // 子集（game/story）不得写公共 NPC 存储（§3.5.1：公共子集仅 City Runtime
    // 仲裁可写，本表是它的存储面）。
    let parsed = parse_state_scope(scope)?;
    let StateScopeV1::CityResidentPublic { city_id, resident_id } = parsed else { return Err("game_actor_intent_denied"); };
    if !valid_id(location_ref) || expected_revision.is_empty() { return Err("game_argument_invalid"); }
    let mut db = database(home)?;
    migrate_city_resident_state(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let current = tx.query_row("SELECT revision FROM city_resident_state WHERE city_id=?1 AND resident_id=?2", params![city_id,resident_id],
        |row| row.get::<_, String>(0)).optional().map_err(|_| "creator_store_unavailable")?
        .unwrap_or_else(|| "0".to_string());
    if current != expected_revision { return Err("game_storage_revision_conflict"); }
    let now = now_ms();
    let revision = digest(&format!("{city_id}:{resident_id}:{current}:{location_ref}:{now}"));
    tx.execute("INSERT INTO city_resident_state(city_id,resident_id,location_ref,revision,updated_at_ms) VALUES (?1,?2,?3,?4,?5)
        ON CONFLICT(city_id,resident_id) DO UPDATE SET location_ref=excluded.location_ref,revision=excluded.revision,updated_at_ms=excluded.updated_at_ms",
        params![city_id,resident_id,location_ref,revision,now]).map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"cityId":city_id,"residentId":resident_id,"locationRef":location_ref,"revision":revision,"updatedAtMs":now}))
}

// ---------------------------------------------------------------------------
// Story Preview Fork（RFC §13.1 / Isolation Spec §7.3）fork 命名空间。
// 一行 = 一个 Preview 窗口的私有 Story 快照（forkId = previewId）。copy-on-read：
// 首次读从正式 story_states 派生基线快照入 fork_json，此后只读 Fork 行；正式行
// 永不被 Fork 读写路径推进或修改。本期 Preview 内的 story 提交保持失败关闭
// （RFC §13 第 3 条：PR-4 前不开放），fork_json 只承载快照级状态。

/// Fork 的完整 §3.5 scope：基线派生地址与 Fork 行的 player/city/story/storyRun
/// 四个维度（forkId = previewId 由表主键承担）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoryForkScopeV1 {
    pub player_id: String,
    pub city_id: String,
    pub story_id: String,
    pub story_run_id: String,
}

pub(crate) fn migrate_story_forks(db: &Connection) -> Result<(), &'static str> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS story_preview_forks (
        preview_id TEXT PRIMARY KEY, story_id TEXT NOT NULL, story_run_id TEXT NOT NULL,
        base_story_revision TEXT NOT NULL, city_id TEXT NOT NULL, player_id TEXT NOT NULL,
        fork_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    );").map_err(|_| "creator_store_unavailable")
}

/// Fork 行的 (player_id, city_id, story_id, story_run_id, fork_json) 投影。
pub(crate) type StoryForkRowV1 = (String, String, String, String, Value);

/// 读取 Fork 行的 scope 绑定与快照；None = 该 Preview 尚未派生 Fork。
pub(crate) fn story_fork(home: &Path, preview_id: &str) -> Result<Option<StoryForkRowV1>, &'static str> {
    let db = database(home)?;
    migrate_story_forks(&db)?;
    let row = db.query_row("SELECT player_id,city_id,story_id,story_run_id,fork_json FROM story_preview_forks WHERE preview_id=?1", [preview_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    row.map(|(player_id, city_id, story_id, story_run_id, json)|
        serde_json::from_str::<Value>(&json).map(|snapshot| (player_id, city_id, story_id, story_run_id, snapshot))
            .map_err(|_| "creator_store_unavailable"))
        .transpose()
}

/// copy-on-read 首读：以正式 scope 的当前行派生基线快照并落 Fork 行。
/// base_story_revision 记录派生时观察到的正式 revision；正式行缺席 = "0"
/// （空基线）——即预览请求 source 无 Story 上下文时的当前形态，Story 上下文
/// 注入是 PR 后续。并发首读的另一写方已落同一行时以已存在行为准（两方从同一
/// 正式行派生，快照等价）。
pub(crate) fn seed_story_fork(home: &Path, preview_id: &str, scope: &StoryForkScopeV1) -> Result<Value, &'static str> {
    let derived = story_state_scoped(home, &scope.player_id, &scope.city_id, &scope.story_id, &scope.story_run_id)?;
    let base_revision = derived["storyRevision"].as_str().ok_or("creator_store_unavailable")?.to_string();
    let fork_json = canonical_json(&json!({"storyRevision":base_revision,"state":derived["state"]})).map_err(|_| "game_argument_invalid")?;
    let db = database(home)?;
    migrate_story_forks(&db)?;
    match db.execute("INSERT INTO story_preview_forks(preview_id,story_id,story_run_id,base_story_revision,city_id,player_id,fork_json,created_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![preview_id,scope.story_id,scope.story_run_id,base_revision,scope.city_id,scope.player_id,fork_json,now_ms()]) {
        Ok(_) | Err(rusqlite::Error::SqliteFailure(_, _)) => {}
        Err(_) => return Err("creator_store_unavailable"),
    }
    story_fork(home, preview_id)?.map(|row| row.4).ok_or("creator_store_unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn home() -> std::path::PathBuf {
        static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
        let suffix = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("story-store-{}-{}", std::process::id(), suffix))
    }

    fn clock() -> StoryClockAuthorityV1 {
        StoryClockAuthorityV1 { revision: "clock-1".to_string(), tick: 1, simulation_utc_ms: 1_000 }
    }

    fn command(operation: &str, event: &str, revision: &str) -> StoryCommitCommandV1 {
        StoryCommitCommandV1 {
            operation_id: operation.to_string(), event_id: event.to_string(), player_id: "player-1".to_string(),
            city_id: "city-1".to_string(), game_id: "game-1".to_string(),
            story_scope: None, resident_id: Some("resident:linxia".to_string()),
            expected_story_revision: revision.to_string(), expected_clock_revision: "clock-1".to_string(),
            intent: json!({"kind":"invite","targetId":"place:beach"}), run_id: "run-1".to_string(),
            rule_set_digest: None, causation_id: None, correlation_id: None,
        }
    }

    fn scoped_command(operation: &str, event: &str, revision: &str, story_id: &str, story_run_id: &str) -> StoryCommitCommandV1 {
        let mut scoped = command(operation, event, revision);
        scoped.story_scope = Some(StoryStateScopeV1 { story_id: story_id.to_string(), story_run_id: story_run_id.to_string() });
        scoped
    }

    #[test]
    fn story_commit_is_cas_idempotent_and_outbox_is_post_commit() {
        let home = home();
        let first = commit_story(&home, command("op-1", "event-1", "0"), clock()).unwrap();
        assert_eq!(first["alreadyCommitted"], false);
        let retry = commit_story(&home, command("op-1", "event-1", "0"), clock()).unwrap();
        assert_eq!(retry["storyRevision"], first["storyRevision"]);
        let conflict = commit_story(&home, command("op-2", "event-1", "0"), clock()).unwrap_err();
        assert_eq!(conflict, "game_storage_revision_conflict");
        let outbox = story_outbox(&home, "player-1", "city-1", "game-1", 10).unwrap();
        assert_eq!(outbox.len(), 1);
        assert_eq!(outbox[0]["status"], "pending");
        assert!(acknowledge_story_outbox(&home, outbox[0]["outboxId"].as_i64().unwrap()).unwrap());
        assert!(story_outbox(&home, "player-1", "city-1", "game-1", 10).unwrap().is_empty());
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn story_commit_rejects_operation_reuse_and_computes_rule_state() {
        let home = home();
        commit_story(&home, command("op-1", "event-1", "0"), clock()).unwrap();
        assert_eq!(story_state(&home, "player-1", "city-1", "game-1").unwrap()["state"]["affection"], 1);
        let mut changed = command("op-1", "event-1", "0");
        changed.intent = json!({"kind":"invite","targetId":"place:cafe"});
        assert_eq!(commit_story(&home, changed, clock()).unwrap_err(), "operation_id_conflict");
        let second = command("op-2", "event-2", "0");
        let revision = second.expected_story_revision.clone();
        let current = commit_story(&home, command("op-2", "event-2", &revision), clock());
        assert_eq!(current.unwrap_err(), "game_storage_revision_conflict");
        let first_revision = story_outbox(&home, "player-1", "city-1", "game-1", 10).unwrap()[0]["payload"]["storyRevision"].as_str().unwrap().to_string();
        let mut next = command("op-2", "event-2", &first_revision);
        next.intent = json!({"kind":"speak","text":"See you Saturday."});
        assert_eq!(commit_story(&home, next, clock()).unwrap()["status"], "committed");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn story_scopes_are_isolated_by_player_and_game() {
        let home = home();
        commit_story(&home, command("op-1", "event-1", "0"), clock()).unwrap();
        let mut other = command("op-2", "event-2", "0");
        other.game_id = "game-2".to_string();
        commit_story(&home, other, clock()).unwrap();
        assert_eq!(story_outbox(&home, "player-1", "city-1", "game-1", 10).unwrap().len(), 1);
        assert_eq!(story_outbox(&home, "player-1", "city-1", "game-2", 10).unwrap().len(), 1);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn story_clock_revision_and_intent_are_validated() {
        let home = home();
        let mismatch = commit_story(&home, command("op-1", "event-1", "0"), StoryClockAuthorityV1 { revision: "clock-2".to_string(), tick: 2, simulation_utc_ms: 2_000 }).unwrap_err();
        assert_eq!(mismatch, "city_time_revision_conflict");
        assert!(story_outbox(&home, "player-1", "city-1", "game-1", 10).unwrap().is_empty());
        let mut invalid = command("op-2", "event-2", "0");
        invalid.intent = json!({"kind":"delete-city"});
        assert_eq!(commit_story(&home, invalid, clock()).unwrap_err(), "game_actor_intent_denied");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn explicit_story_scope_commits_land_on_story_keyed_rows() {
        let home = home();
        let first = commit_story(&home, scoped_command("op-1", "event-1", "0", "story-alpha", "run-alpha"), clock()).unwrap();
        assert_eq!(first["alreadyCommitted"], false);
        let retry = commit_story(&home, scoped_command("op-1", "event-1", "0", "story-alpha", "run-alpha"), clock()).unwrap();
        assert_eq!(retry["storyRevision"], first["storyRevision"]);
        // legacy 合成映射视图读不到显式 scope 的行。
        assert_eq!(story_state(&home, "player-1", "city-1", "game-1").unwrap()["storyRevision"], "0");
        assert!(story_outbox(&home, "player-1", "city-1", "game-1", 10).unwrap().is_empty());
        // 显式 scope 视图读到自己的状态、回执幂等与 outbox。
        let scoped = story_state_scoped(&home, "player-1", "city-1", "story-alpha", "run-alpha").unwrap();
        assert_eq!(scoped["state"]["affection"], 1);
        assert_eq!(story_outbox_scoped(&home, "player-1", "city-1", "story-alpha", "run-alpha", 10).unwrap().len(), 1);
        let db = database(&home).unwrap();
        let row = db.query_row("SELECT story_id,story_run_id FROM story_states WHERE player_id='player-1' AND city_id='city-1'", [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).unwrap();
        assert_eq!(row, ("story-alpha".to_string(), "run-alpha".to_string()));
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn legacy_game_keyed_rows_migrate_to_the_synthetic_story_scope() {
        let home = home();
        {
            // 绕开 database()（它一打开就会建新 schema）：手工在同一存储路径上
            // 造一个迁移前的旧库（player×city×game 主键）与旧行；
            // events/outbox 缺席以覆盖混合建库路径。
            let directory = home.join("state/creator");
            std::fs::create_dir_all(&directory).unwrap();
            let db = Connection::open(directory.join("projects.sqlite")).unwrap();
            db.execute_batch("CREATE TABLE story_states (
                player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL,
                revision TEXT NOT NULL, document_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(player_id,city_id,game_id)
            );
            CREATE TABLE story_operations (
                player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL,
                operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL, PRIMARY KEY(player_id,city_id,game_id,operation_id)
            );
            INSERT INTO story_states VALUES ('player-1','city-1','game-1','legacy-rev','{\"affection\":7}',1);
            INSERT INTO story_operations VALUES ('player-1','city-1','game-1','op-old','hash-old','{}',1);").unwrap();
        }
        // 普通读路径触发迁移：旧行按合成映射（story_id=game_id、story_run_id='legacy-'||game_id）搬运后仍命中。
        let state = story_state(&home, "player-1", "city-1", "game-1").unwrap();
        assert_eq!(state["storyRevision"], "legacy-rev");
        assert_eq!(state["state"]["affection"], 7);
        let db = database(&home).unwrap();
        let row = db.query_row("SELECT story_id,story_run_id,revision FROM story_states WHERE player_id='player-1' AND city_id='city-1'", [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).unwrap();
        assert_eq!(row, ("game-1".to_string(), "legacy-game-1".to_string(), "legacy-rev".to_string()));
        let receipt = db.query_row("SELECT story_id,story_run_id FROM story_operations WHERE operation_id='op-old'", [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).unwrap();
        assert_eq!(receipt, ("game-1".to_string(), "legacy-game-1".to_string()));
        // 迁移后续写落在同一合成地址上（CAS 从迁移后的 revision 继续）。
        let next = command("op-2", "event-2", "legacy-rev");
        assert_eq!(commit_story(&home, next, clock()).unwrap()["status"], "committed");
        assert_eq!(story_outbox(&home, "player-1", "city-1", "game-1", 10).unwrap().len(), 1);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn story_scopes_are_isolated_across_story_runs() {
        let home = home();
        commit_story(&home, scoped_command("op-a", "event-a", "0", "story-alpha", "run-a"), clock()).unwrap();
        commit_story(&home, scoped_command("op-b", "event-b", "0", "story-alpha", "run-b"), clock()).unwrap();
        let run_a = story_state_scoped(&home, "player-1", "city-1", "story-alpha", "run-a").unwrap();
        let run_b = story_state_scoped(&home, "player-1", "city-1", "story-alpha", "run-b").unwrap();
        assert_eq!(run_a["state"]["affection"], 1);
        assert_eq!(run_b["state"]["affection"], 1);
        assert_ne!(run_a["storyRevision"], run_b["storyRevision"]);
        assert_eq!(story_outbox_scoped(&home, "player-1", "city-1", "story-alpha", "run-a", 10).unwrap().len(), 1);
        assert_eq!(story_outbox_scoped(&home, "player-1", "city-1", "story-alpha", "run-b", 10).unwrap().len(), 1);
        assert!(story_dialogue_scoped(&home, "player-1", "city-1", "story-alpha", "run-a", 10).unwrap().is_empty());
        assert!(story_outbox(&home, "player-1", "city-1", "game-1", 10).unwrap().is_empty());
        // 未知 storyRunId 返回空状态，不跨 run 泄漏。
        assert_eq!(story_state_scoped(&home, "player-1", "city-1", "story-alpha", "run-missing").unwrap()["storyRevision"], "0");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn commit_story_envelope_fields_persist_and_project_as_world_event_envelopes() {
        let home = home();
        let envelope_command = |operation: &str, event: &str| {
            let mut command = command(operation, event, "0");
            command.rule_set_digest = Some("ruleset:digest-1".to_string());
            command.causation_id = Some("event-cause-0".to_string());
            command.correlation_id = Some("trace-corr-1".to_string());
            command
        };
        let first = commit_story(&home, envelope_command("op-1", "event-1"), clock()).unwrap();
        // 同 operationId + 同信封载荷的重试命中回执（信封字段已纳入请求哈希）。
        let retry = commit_story(&home, envelope_command("op-1", "event-1"), clock()).unwrap();
        assert_eq!(retry["storyRevision"], first["storyRevision"]);
        // 读投影：信封字段逐一落库读回（legacy 行投影为 game 子集 scope）。
        let envelopes = story_event_envelopes(&home, "player-1", "city-1", "game-1", 10).unwrap();
        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0]["eventId"], "event-1");
        assert_eq!(envelopes[0]["type"], "invite");
        assert_eq!(envelopes[0]["scope"]["kind"], "game");
        assert_eq!(envelopes[0]["scope"]["gameId"], "game-1");
        assert_eq!(envelopes[0]["actorId"], "player-1");
        assert_eq!(envelopes[0]["simulationUtcMs"], 1_000);
        assert_eq!(envelopes[0]["ruleSetDigest"], "ruleset:digest-1");
        assert_eq!(envelopes[0]["causationId"], "event-cause-0");
        assert_eq!(envelopes[0]["correlationId"], "trace-corr-1");
        assert_eq!(envelopes[0]["payload"]["kind"], "invite");
        assert!(!envelopes[0]["expectedRevision"].as_str().unwrap().is_empty());
        // 未携带信封的提交（缺省 NULL）：投影按可选语义省略信封字段。
        let revision = first["storyRevision"].as_str().unwrap().to_string();
        commit_story(&home, command("op-2", "event-2", &revision), clock()).unwrap();
        let envelopes = story_event_envelopes(&home, "player-1", "city-1", "game-1", 10).unwrap();
        let plain = envelopes.iter().find(|envelope| envelope["eventId"] == "event-2").unwrap();
        assert!(plain.get("ruleSetDigest").is_none());
        assert!(plain.get("causationId").is_none());
        assert!(plain.get("correlationId").is_none());
        // 同 operationId 换信封载荷的变体重试被冲突检测拦截。
        let mut changed = envelope_command("op-1", "event-1");
        changed.rule_set_digest = Some("ruleset:digest-2".to_string());
        assert_eq!(commit_story(&home, changed, clock()).unwrap_err(), "operation_id_conflict");
        // 显式 Story scope 行投影为 story 子集 scope。
        let mut scoped = scoped_command("op-s", "event-s", "0", "story-alpha", "run-alpha");
        scoped.rule_set_digest = Some("ruleset:digest-s".to_string());
        commit_story(&home, scoped, clock()).unwrap();
        let scoped_envelopes = story_event_envelopes_scoped(&home, "player-1", "city-1", "story-alpha", "run-alpha", 10).unwrap();
        assert_eq!(scoped_envelopes[0]["scope"]["kind"], "story");
        assert_eq!(scoped_envelopes[0]["scope"]["storyId"], "story-alpha");
        assert_eq!(scoped_envelopes[0]["scope"]["storyRunId"], "run-alpha");
        assert_eq!(scoped_envelopes[0]["ruleSetDigest"], "ruleset:digest-s");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn story_event_envelope_columns_migrate_existing_rows_to_null() {
        let home = home();
        {
            // 绕开 database()（它一打开就会建新 schema）：手工造一个"信封化之前"
            // 的已迁移库——story 主键已就位但 story_events 缺信封列；迁移路径 =
            // ALTER TABLE ADD COLUMN，旧行信封字段落 NULL，不做破坏性迁移。
            let directory = home.join("state/creator");
            std::fs::create_dir_all(&directory).unwrap();
            let db = Connection::open(directory.join("projects.sqlite")).unwrap();
            db.execute_batch("CREATE TABLE story_events (
                event_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, player_id TEXT NOT NULL,
                city_id TEXT NOT NULL, game_id TEXT NOT NULL, story_id TEXT NOT NULL, story_run_id TEXT NOT NULL,
                rule_id TEXT NOT NULL, status TEXT NOT NULL, due_at_utc_ms INTEGER NOT NULL,
                last_processed_tick INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
                story_revision TEXT NOT NULL, clock_revision TEXT NOT NULL, intent_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL, PRIMARY KEY(player_id,city_id,story_id,story_run_id,event_id)
            );
            INSERT INTO story_events VALUES ('event-old','event-old','player-1','city-1','game-1','game-1','legacy-game-1',
                'event-old','committed',1000,4,'op-old','rev-old','clock-1','{\"kind\":\"speak\",\"text\":\"legacy\"}',1);").unwrap();
        }
        // 读路径触发迁移：旧行读回为 NULL 信封字段 → 投影省略可选信封字段。
        let envelopes = story_event_envelopes(&home, "player-1", "city-1", "game-1", 10).unwrap();
        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0]["eventId"], "event-old");
        assert_eq!(envelopes[0]["type"], "speak");
        assert!(envelopes[0].get("ruleSetDigest").is_none());
        assert!(envelopes[0].get("causationId").is_none());
        assert!(envelopes[0].get("correlationId").is_none());
        // 迁移后三列存在且旧行均为 NULL；续写不冲突。
        let db = database(&home).unwrap();
        for column in ["rule_set_digest", "causation_id", "correlation_id"] {
            let value: Option<String> = db.query_row(&format!("SELECT {column} FROM story_events WHERE event_id='event-old'"), [],
                |row| row.get(0)).unwrap();
            assert_eq!(value, None);
        }
        assert_eq!(commit_story(&home, command("op-2", "event-2", "0"), clock()).unwrap()["status"], "committed");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn resident_state_writes_require_public_scope_and_cas_revision() {
        let home = home();
        let public_scope = json!({"kind":"city-resident-public","cityId":"city:one","residentId":"resident:xia"});
        // 首写（revision "0" = create）落权威行并读回。
        let first = write_resident_state(&home, &public_scope, "place:beach", "0").unwrap();
        assert!(!first["revision"].as_str().unwrap().is_empty());
        let read = read_resident_state(&home, "city:one", "resident:xia").unwrap();
        assert_eq!(read["locationRef"], "place:beach");
        assert_eq!(read["revision"], first["revision"]);
        assert!(read["updatedAtMs"].as_u64().is_some());
        // CAS 冲突：携带过期 revision 拒绝；携带当前 revision 推进且 revision 变化。
        assert_eq!(write_resident_state(&home, &public_scope, "place:cafe", "0").unwrap_err(), "game_storage_revision_conflict");
        let second = write_resident_state(&home, &public_scope, "place:cafe", first["revision"].as_str().unwrap()).unwrap();
        assert_ne!(second["revision"], first["revision"]);
        assert_eq!(read_resident_state(&home, "city:one", "resident:xia").unwrap()["locationRef"], "place:cafe");
        // 私有子集 fail-closed：game/story scope 不得写公共 NPC 存储。
        for private_scope in [
            json!({"kind":"game","playerId":"player-1","cityId":"city:one","gameId":"game-1"}),
            json!({"kind":"story","playerId":"player-1","cityId":"city:one","storyId":"story-alpha","storyRunId":"run-alpha"}),
        ] {
            assert_eq!(write_resident_state(&home, &private_scope, "place:beach", "0").unwrap_err(), "game_actor_intent_denied");
        }
        assert_eq!(read_resident_state(&home, "city:one", "resident:xia").unwrap()["locationRef"], "place:cafe");
        // 未知 kind、缺 kind、非法 scope 字段解析失败关闭；非法 locationRef / 空 revision 拒绝。
        assert_eq!(write_resident_state(&home, &json!({"kind":"city-resident-v2","cityId":"city:one","residentId":"resident:xia"}), "place:beach", "0").unwrap_err(), "game_argument_invalid");
        assert_eq!(write_resident_state(&home, &json!({"cityId":"city:one","residentId":"resident:xia"}), "place:beach", "0").unwrap_err(), "game_argument_invalid");
        assert_eq!(write_resident_state(&home, &json!({"kind":"city-resident-public","cityId":"city:one","residentId":"bad id!"}), "place:beach", "0").unwrap_err(), "game_argument_invalid");
        assert_eq!(write_resident_state(&home, &public_scope, "../escape", "0").unwrap_err(), "game_argument_invalid");
        assert_eq!(write_resident_state(&home, &public_scope, "place:beach", "").unwrap_err(), "game_argument_invalid");
        // 未知 resident / 跨 city 读回空基线（revision "0"），互不泄漏。
        assert_eq!(read_resident_state(&home, "city:one", "resident:missing").unwrap()["revision"], "0");
        assert_eq!(read_resident_state(&home, "city:two", "resident:xia").unwrap()["revision"], "0");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn story_fork_namespace_derives_from_formal_row_and_never_rewrites_it() {
        let home = home();
        commit_story(&home, command("op-1", "event-1", "0"), clock()).unwrap();
        let scope = StoryForkScopeV1 { player_id: "player-1".to_string(), city_id: "city-1".to_string(),
            story_id: "game-1".to_string(), story_run_id: "legacy-game-1".to_string() };
        // 首读派生：快照与正式行一致，base 记录派生时的正式 revision。
        let first = seed_story_fork(&home, "preview-x", &scope).unwrap();
        assert_eq!(first["storyRevision"], story_state(&home, "player-1", "city-1", "game-1").unwrap()["storyRevision"]);
        assert_eq!(first["state"]["affection"], 1);
        // 并发首读的重复派生以已存在的 Fork 行为准（主键冲突回退读）。
        let raced = seed_story_fork(&home, "preview-x", &scope).unwrap();
        assert_eq!(raced, first);
        // Fork 只读：正式侧推进后 Fork 行仍持 base 快照，且未回写正式行。
        let revision = first["storyRevision"].as_str().unwrap().to_string();
        commit_story(&home, command("op-2", "event-2", &revision), clock()).unwrap();
        assert_eq!(story_fork(&home, "preview-x").unwrap().unwrap().4, first);
        assert_eq!(story_state(&home, "player-1", "city-1", "game-1").unwrap()["state"]["affection"], 2);
        // 未派生的 Preview 返回 None；另一 Preview 的 Fork 行互不可见。
        assert!(story_fork(&home, "preview-y").unwrap().is_none());
        std::fs::remove_dir_all(home).ok();
    }
}
