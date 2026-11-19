//! Player-scoped Story persistence: CAS state, event facts, idempotent receipts
//! and post-commit Outbox share one immediate SQLite transaction. Actor/model
//! work belongs outside this module; no LLM turn is ever held inside a transaction.
#![allow(dead_code)]
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use crate::creator_store::{canonical_json, database, digest, now_ms};

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
    pub resident_id: Option<String>,
    pub expected_story_revision: String,
    pub expected_clock_revision: String,
    pub intent: Value,
    pub run_id: String,
}

pub(crate) fn migrate_story(db: &Connection) -> Result<(), &'static str> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS story_states (
        player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL,
        revision TEXT NOT NULL, document_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(player_id,city_id,game_id)
    );
    CREATE TABLE IF NOT EXISTS story_events (
        event_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, player_id TEXT NOT NULL,
        city_id TEXT NOT NULL, game_id TEXT NOT NULL, rule_id TEXT NOT NULL,
        status TEXT NOT NULL, due_at_utc_ms INTEGER NOT NULL, last_processed_tick INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL, story_revision TEXT NOT NULL, clock_revision TEXT NOT NULL,
        intent_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(player_id,city_id,game_id,event_id)
    );
    CREATE TABLE IF NOT EXISTS story_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL,
        payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
        acknowledged_at_ms INTEGER, UNIQUE(event_id,operation_id)
    );
    CREATE TABLE IF NOT EXISTS story_operations (
        player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, PRIMARY KEY(player_id,city_id,game_id,operation_id)
    );").map_err(|_| "creator_store_unavailable")
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
    let request_hash = digest(&canonical_json(&json!({
        "operationId":command.operation_id,"eventId":command.event_id,"playerId":command.player_id,
        "cityId":command.city_id,"gameId":command.game_id,"residentId":command.resident_id,
        "expectedStoryRevision":command.expected_story_revision,"expectedClockRevision":command.expected_clock_revision,
        "intent":command.intent,"runId":command.run_id,
    })).map_err(|_| "game_argument_invalid")?);
    let mut db = database(home)?;
    migrate_story(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some((hash, result)) = tx.query_row(
        "SELECT request_hash,result_json FROM story_operations WHERE player_id=?1 AND city_id=?2 AND game_id=?3 AND operation_id=?4",
        params![command.player_id,command.city_id,command.game_id,command.operation_id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)),
    ).optional().map_err(|_| "creator_store_unavailable")? {
        if hash != request_hash { return Err("operation_id_conflict"); }
        return serde_json::from_str(&result).map_err(|_| "creator_store_unavailable");
    }
    let current = tx.query_row(
        "SELECT revision,document_json FROM story_states WHERE player_id=?1 AND city_id=?2 AND game_id=?3",
        params![command.player_id,command.city_id,command.game_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
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
    tx.execute("INSERT INTO story_events(event_id,occurrence_id,player_id,city_id,game_id,rule_id,status,due_at_utc_ms,last_processed_tick,idempotency_key,story_revision,clock_revision,intent_json,created_at_ms) VALUES (?1,?2,?3,?4,?5,?6,'committed',?7,?8,?9,?10,?11,?12,?13)",
        params![command.event_id,command.event_id,command.player_id,command.city_id,command.game_id,command.event_id,
            clock.simulation_utc_ms,clock.tick,command.operation_id,result["storyRevision"].as_str().unwrap_or(""),command.expected_clock_revision,
            canonical_json(&command.intent).map_err(|_| "game_argument_invalid")?,now])
        .map_err(|_| "creator_store_unavailable")?;
    let document = canonical_json(&state).map_err(|_| "game_argument_invalid")?;
    tx.execute("INSERT INTO story_states(player_id,city_id,game_id,revision,document_json,updated_at_ms) VALUES (?1,?2,?3,?4,?5,?6)
        ON CONFLICT(player_id,city_id,game_id) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json,updated_at_ms=excluded.updated_at_ms",
        params![command.player_id,command.city_id,command.game_id,result["storyRevision"].as_str().unwrap_or(""),document,now])
        .map_err(|_| "creator_store_unavailable")?;
    tx.execute("INSERT INTO story_outbox(event_id,operation_id,player_id,city_id,game_id,payload_json,status,created_at_ms) VALUES (?1,?2,?3,?4,?5,?6,'pending',?7)",
        params![command.event_id,command.operation_id,command.player_id,command.city_id,command.game_id,
            canonical_json(&result).map_err(|_| "game_argument_invalid")?,now])
        .map_err(|_| "creator_store_unavailable")?;
    let outbox_id = tx.last_insert_rowid();
    tx.execute("INSERT INTO story_operations(player_id,city_id,game_id,operation_id,request_hash,result_json,created_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![command.player_id,command.city_id,command.game_id,command.operation_id,request_hash,
            canonical_json(&result).map_err(|_| "game_argument_invalid")?,now])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"eventId":command.event_id,"operationId":command.operation_id,
        "storyRevision":result["storyRevision"].as_str().unwrap_or(""),"clockRevision":command.expected_clock_revision,
        "status":"committed","outboxId":outbox_id,"alreadyCommitted":false}))
}

pub(crate) fn story_state(home: &Path, player_id: &str, city_id: &str, game_id: &str) -> Result<Value, &'static str> {
    let db = database(home)?;
    migrate_story(&db)?;
    let current = db.query_row("SELECT revision,document_json FROM story_states WHERE player_id=?1 AND city_id=?2 AND game_id=?3",
        params![player_id,city_id,game_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let Some((revision, document)) = current else { return Ok(json!({"storyRevision":"0","state":{}})); };
    let state = serde_json::from_str::<Value>(&document).map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"storyRevision":revision,"state":state}))
}

pub(crate) fn story_dialogue(home: &Path, player_id: &str, city_id: &str, game_id: &str, limit: u32) -> Result<Vec<Value>, &'static str> {
    let db = database(home)?;
    migrate_story(&db)?;
    let mut statement = db.prepare("SELECT event_id,intent_json,story_revision,created_at_ms FROM story_events WHERE player_id=?1 AND city_id=?2 AND game_id=?3 AND json_extract(intent_json,'$.kind')='speak' ORDER BY created_at_ms DESC,event_id DESC LIMIT ?4")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![player_id,city_id,game_id,limit.min(100)], |row| {
        Ok(json!({"eventId":row.get::<_,String>(0)?,"intent":serde_json::from_str::<Value>(&row.get::<_,String>(1)?).unwrap_or(Value::Null),
            "storyRevision":row.get::<_,String>(2)?,"createdAtMs":row.get::<_,u64>(3)?}))
    }).map_err(|_| "creator_store_unavailable")?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")
}

pub(crate) fn story_outbox(home: &Path, player_id: &str, city_id: &str, game_id: &str, limit: u32) -> Result<Vec<Value>, &'static str> {
    let db = database(home)?;
    migrate_story(&db)?;
    let mut statement = db.prepare("SELECT id,event_id,operation_id,payload_json,status,created_at_ms FROM story_outbox WHERE player_id=?1 AND city_id=?2 AND game_id=?3 AND status='pending' ORDER BY id LIMIT ?4")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![player_id,city_id,game_id,limit.min(100)], |row| {
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
            city_id: "city-1".to_string(), game_id: "game-1".to_string(), resident_id: Some("resident:linxia".to_string()),
            expected_story_revision: revision.to_string(), expected_clock_revision: "clock-1".to_string(),
            intent: json!({"kind":"invite","targetId":"place:beach"}), run_id: "run-1".to_string(),
        }
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
}
