use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;
use crate::city_runtime::{active_run, read_clock_at, valid_id};
use crate::creator_store::{canonical_json, database, digest, now_ms};
use crate::story_store::story_state;

const DAY_MS: u64 = 86_400_000;
const MAX_UTC_MS: u64 = 253_402_300_799_000;

pub(crate) fn migrate(db: &Connection) -> Result<(), &'static str> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS city_story_rules (
        player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL, rule_id TEXT NOT NULL,
        version INTEGER NOT NULL, rule_json TEXT NOT NULL, next_due_utc_ms INTEGER,
        occurrence_id TEXT, status TEXT NOT NULL, last_processed_tick INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL, story_revision TEXT NOT NULL, clock_revision TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, PRIMARY KEY(player_id,city_id,game_id,rule_id)
    );").map_err(|_| "creator_store_unavailable")
}

fn only_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| object.keys().all(|key| keys.contains(&key.as_str())))
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    value.get(key).and_then(Value::as_str).filter(|value| valid_id(value)).ok_or("game_argument_invalid")
}
fn required_id(payload: &Value, key: &str) -> Result<String, &'static str> { Ok(text(payload, key)?.to_string()) }
fn operation_id(options: &Value) -> Result<String, &'static str> { required_id(options, "operationId") }

fn next_weekly(simulation: u64, day_of_week: u64, local_time: &str) -> Result<u64, &'static str> {
    if day_of_week > 6 || local_time.len() != 5 || local_time.as_bytes()[2] != b':' { return Err("game_argument_invalid"); }
    let hour = local_time[..2].parse::<u64>().map_err(|_| "game_argument_invalid")?;
    let minute = local_time[3..].parse::<u64>().map_err(|_| "game_argument_invalid")?;
    if hour > 23 || minute > 59 { return Err("game_argument_invalid"); }
    let day = simulation / DAY_MS;
    let current_day_of_week = (day + 4) % 7;
    let mut candidate = (day + (day_of_week + 7 - current_day_of_week) % 7).saturating_mul(DAY_MS)
        .saturating_add((hour * 60 + minute) * 60_000);
    if candidate <= simulation { candidate = candidate.saturating_add(7 * DAY_MS); }
    if candidate > MAX_UTC_MS { return Err("game_argument_invalid"); }
    Ok(candidate)
}

fn validate_rule(rule: &Value, simulation: u64) -> Result<Option<u64>, &'static str> {
    if !only_keys(rule, &["ruleId","version","trigger","target","requirePlayerAtTarget","conditions","action","cooldownMs","missedPolicy","rescheduleDelayMs","maxRescheduleCount"]) {
        return Err("game_argument_invalid");
    }
    text(rule, "ruleId")?;
    if rule.get("version").and_then(Value::as_u64).filter(|version| *version > 0).is_none() { return Err("game_argument_invalid"); }
    if rule.get("requirePlayerAtTarget").and_then(Value::as_bool).unwrap_or(false) { return Err("game_story_location_unavailable"); }
    if let Some(target) = rule.get("target") {
        if !only_keys(target, &["kind","id"]) || !matches!(target.get("kind").and_then(Value::as_str), Some("world-object" | "resident" | "place")) {
            return Err("game_argument_invalid");
        }
        text(target, "id")?;
    }
    if !rule.get("conditions").and_then(Value::as_array).is_some_and(|conditions| conditions.is_empty()) {
        return Err("game_story_conditions_unsupported");
    }
    let trigger = rule.get("trigger").filter(|value| value.is_object()).ok_or("game_argument_invalid")?;
    if trigger.get("kind").and_then(Value::as_str) != Some("calendar") { return Err("game_story_trigger_unsupported"); }
    let next = match trigger.get("recurrence").and_then(Value::as_str) {
        Some("once") if only_keys(trigger, &["kind","recurrence","atUtcMs"]) => {
            let at = trigger.get("atUtcMs").and_then(Value::as_u64).filter(|at| *at <= MAX_UTC_MS).ok_or("game_argument_invalid")?;
            Some(at)
        }
        Some("weekly") if only_keys(trigger, &["kind","recurrence","timeZone","dayOfWeek","localTime"])
            && trigger.get("timeZone").and_then(Value::as_str) == Some("city") => {
            let day = trigger.get("dayOfWeek").and_then(Value::as_u64).ok_or("game_argument_invalid")?;
            let local = trigger.get("localTime").and_then(Value::as_str).ok_or("game_argument_invalid")?;
            Some(next_weekly(simulation, day, local)?)
        }
        _ => return Err("game_story_trigger_unsupported"),
    };
    let action = rule.get("action").filter(|value| value.is_object()).ok_or("game_argument_invalid")?;
    if !only_keys(action, &["kind","eventId"]) || !matches!(action.get("kind").and_then(Value::as_str),
        Some("offer-dialogue" | "update-quest" | "emit-game-event")) {
        return Err("game_argument_invalid");
    }
    text(action, "eventId")?;
    let missed = rule.get("missedPolicy").and_then(Value::as_str).ok_or("game_argument_invalid")?;
    if !matches!(missed, "skip" | "reschedule" | "expire" | "persist") { return Err("game_argument_invalid"); }
    let delay = rule.get("rescheduleDelayMs").and_then(Value::as_u64);
    let count = rule.get("maxRescheduleCount").and_then(Value::as_u64);
    if missed == "reschedule" && !matches!((delay, count), (Some(1..=86_400_000), Some(0..=16))) {
        return Err("game_argument_invalid");
    }
    if rule.get("cooldownMs").is_some_and(|value| value.as_u64().is_none_or(|cooldown| cooldown > 86_400_000)) {
        return Err("game_argument_invalid");
    }
    Ok(next)
}

fn receipt(db: &Connection, scope: &(String, String, String), operation: &str, hash: &str) -> Result<Option<Value>, &'static str> {
    let existing = db.query_row("SELECT request_hash,result_json FROM story_operations WHERE player_id=?1 AND city_id=?2 AND game_id=?3 AND operation_id=?4",
        params![scope.2,scope.0,scope.1,operation], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    match existing {
        Some((existing_hash, result)) if existing_hash == hash => Ok(Some(serde_json::from_str(&result).map_err(|_| "creator_store_unavailable")?)),
        Some(_) => Err("operation_id_conflict"),
        None => Ok(None),
    }
}

fn save_receipt(tx: &rusqlite::Transaction<'_>, scope: &(String, String, String), operation: &str, hash: &str, result: &Value, now: u64) -> Result<(), &'static str> {
    tx.execute("INSERT INTO story_operations(player_id,city_id,game_id,operation_id,request_hash,result_json,created_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![scope.2,scope.0,scope.1,operation,hash,canonical_json(result).map_err(|_| "game_argument_invalid")?,now])
        .map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

fn request_hash(payload: &Value) -> Result<String, &'static str> {
    Ok(digest(&canonical_json(payload).map_err(|_| "game_argument_invalid")?))
}

fn expected(payload: &Value, clock: &Value, state: &Value) -> Result<(String, String), &'static str> {
    let options = payload.get("options").filter(|value| value.is_object()).ok_or("game_argument_invalid")?;
    if !only_keys(options, &["expectedStoryRevision","expectedClockRevision","operationId"]) { return Err("game_argument_invalid"); }
    let story_revision = text(options, "expectedStoryRevision")?.to_string();
    let clock_revision = text(options, "expectedClockRevision")?.to_string();
    if story_revision != state["storyRevision"].as_str().ok_or("creator_store_unavailable")? { return Err("game_storage_revision_conflict"); }
    if clock_revision != clock["clockRevision"].as_str().ok_or("creator_store_unavailable")? { return Err("city_time_revision_conflict"); }
    if clock.get("uncertainty").is_some() { return Err("city_time_uncertain"); }
    Ok((story_revision, clock_revision))
}

pub(crate) fn schedule(home: &Path, city_instance: &str, payload: &Value) -> Result<Value, &'static str> {
    schedule_at(home, city_instance, payload, now_ms())
}

fn schedule_at(home: &Path, city_instance: &str, payload: &Value, now: u64) -> Result<Value, &'static str> {
    let run_id = required_id(payload, "runId")?;
    let mut db = database(home)?;
    migrate(&db)?;
    let scope = active_run(&db, city_instance, &run_id, now)?;
    let clock = read_clock_at(home, &scope.0, now)?;
    let state = story_state(home, &scope.2, &scope.0, &scope.1)?;
    let (story_revision, clock_revision) = expected(payload, &clock, &state)?;
    let rule = payload.get("rule").filter(|value| value.is_object()).ok_or("game_argument_invalid")?;
    let next = validate_rule(rule, clock["simulationUtcMs"].as_u64().ok_or("creator_store_unavailable")?)?;
    let operation = operation_id(payload.get("options").unwrap())?;
    let hash = request_hash(payload)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some(result) = receipt(&tx, &scope, &operation, &hash)? { return Ok(result); }
    let rule_id = text(rule, "ruleId")?;
    let result = json!({"ruleId":rule_id,"storyRevision":story_revision,"clockRevision":clock_revision,"nextDueUtcMs":next});
    tx.execute("INSERT INTO city_story_rules(player_id,city_id,game_id,rule_id,version,rule_json,next_due_utc_ms,occurrence_id,status,last_processed_tick,idempotency_key,story_revision,clock_revision,created_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,'scheduled',?8,?9,?10,?11,?12)
        ON CONFLICT(player_id,city_id,game_id,rule_id) DO UPDATE SET version=excluded.version,rule_json=excluded.rule_json,
        next_due_utc_ms=excluded.next_due_utc_ms,occurrence_id=NULL,status='scheduled',last_processed_tick=excluded.last_processed_tick,
        idempotency_key=excluded.idempotency_key,story_revision=excluded.story_revision,clock_revision=excluded.clock_revision",
        params![scope.2,scope.0,scope.1,rule_id,rule["version"].as_u64().unwrap(),canonical_json(rule).map_err(|_| "game_argument_invalid")?,
            next,clock["tick"].as_u64().unwrap(),operation,story_revision,clock_revision,now])
        .map_err(|_| "creator_store_unavailable")?;
    save_receipt(&tx, &scope, &operation, &hash, &result, now)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

pub(crate) fn cancel(home: &Path, city_instance: &str, payload: &Value) -> Result<Value, &'static str> {
    let run_id = required_id(payload, "runId")?;
    let rule_id = required_id(payload, "ruleId")?;
    let now = now_ms();
    let mut db = database(home)?;
    migrate(&db)?;
    let scope = active_run(&db, city_instance, &run_id, now)?;
    let state = story_state(home, &scope.2, &scope.0, &scope.1)?;
    let options = payload.get("options").filter(|value| value.is_object()).ok_or("game_argument_invalid")?;
    if !only_keys(options, &["expectedStoryRevision","operationId"]) { return Err("game_argument_invalid"); }
    let expected_story = text(options, "expectedStoryRevision")?;
    if expected_story != state["storyRevision"].as_str().ok_or("creator_store_unavailable")? { return Err("game_storage_revision_conflict"); }
    let operation = operation_id(options)?;
    let hash = request_hash(payload)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some(result) = receipt(&tx, &scope, &operation, &hash)? { return Ok(result); }
    tx.execute("DELETE FROM city_story_rules WHERE player_id=?1 AND city_id=?2 AND game_id=?3 AND rule_id=?4",
        params![scope.2,scope.0,scope.1,rule_id]).map_err(|_| "creator_store_unavailable")?;
    let result = json!({"ruleId":rule_id,"status":"cancelled","storyRevision":expected_story});
    save_receipt(&tx, &scope, &operation, &hash, &result, now)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

pub(crate) fn list(home: &Path, city_instance: &str, payload: &Value) -> Result<Value, &'static str> {
    let run_id = required_id(payload, "runId")?;
    let now = now_ms();
    let db = database(home)?;
    migrate(&db)?;
    let scope = active_run(&db, city_instance, &run_id, now)?;
    let clock = read_clock_at(home, &scope.0, now)?;
    let simulation = clock["simulationUtcMs"].as_u64().ok_or("creator_store_unavailable")?;
    db.execute("UPDATE city_story_rules SET status='due' WHERE player_id=?1 AND city_id=?2 AND game_id=?3 AND status='scheduled' AND next_due_utc_ms<=?4",
        params![scope.2,scope.0,scope.1,simulation]).map_err(|_| "creator_store_unavailable")?;
    let mut statement = db.prepare("SELECT rule_id,next_due_utc_ms,status FROM city_story_rules WHERE player_id=?1 AND city_id=?2 AND game_id=?3 ORDER BY rule_id LIMIT 100")
        .map_err(|_| "creator_store_unavailable")?;
    let rules = statement.query_map(params![scope.2,scope.0,scope.1], |row| {
        let due = row.get::<_, Option<u64>>(1)?;
        Ok(json!({"ruleId":row.get::<_, String>(0)?,"nextDueUtcMs":due,"status":row.get::<_, String>(2)?}))
    }).map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>, _>>().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"rules":rules,"clockRevision":clock["clockRevision"]}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::city_runtime::{start_run, stop_run};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn home() -> std::path::PathBuf {
        static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!("city-scheduler-{}-{}", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed)))
    }
    fn setup(home: &Path) -> (Value, Value) {
        let run = start_run(home, "city-instance", &json!({"cityId":"city:one","gameId":"game.romance"})).unwrap();
        let clock = read_clock_at(home, "city:one", now_ms()).unwrap();
        (run, clock)
    }
    fn payload(run: &Value, clock: &Value, at: u64) -> Value {
        json!({"runId":run["runId"],"rule":{"ruleId":"date-saturday","version":1,
            "trigger":{"kind":"calendar","recurrence":"once","atUtcMs":at},"conditions":[],
            "action":{"kind":"offer-dialogue","eventId":"date-reminder"},"missedPolicy":"persist"},
            "options":{"expectedStoryRevision":"0","expectedClockRevision":clock["clockRevision"],"operationId":"schedule-1"}})
    }

    #[test]
    fn schedules_persists_lists_replays_and_cancels_rules() {
        let home = home();
        let (run, clock) = setup(&home);
        let due = now_ms() + 60_000;
        let request = payload(&run, &clock, due);
        let scheduled = crate::creator_projects::dispatch_city_runtime(&home, "city-instance", "city.story.schedule", &request).unwrap();
        assert_eq!(scheduled["nextDueUtcMs"], due);
        assert_eq!(schedule_at(&home, "city-instance", &request, now_ms()).unwrap()["ruleId"], "date-saturday");
        let listed = list(&home, "city-instance", &json!({"runId":run["runId"]})).unwrap();
        assert_eq!(listed["rules"].as_array().unwrap().len(), 1);
        stop_run(&home, "city-instance", &json!({"runId":run["runId"]})).unwrap();
        assert_eq!(list(&home, "city-instance", &json!({"runId":run["runId"]})).unwrap_err(), "game_run_cancelled");
        let (resumed, resumed_clock) = setup(&home);
        assert_eq!(list(&home, "city-instance", &json!({"runId":resumed["runId"]})).unwrap()["rules"].as_array().unwrap().len(), 1);
        let cancel_request = json!({"runId":resumed["runId"],"ruleId":"date-saturday","options":{"expectedStoryRevision":"0","operationId":"cancel-1"}});
        assert_eq!(cancel(&home, "city-instance", &cancel_request).unwrap()["status"], "cancelled");
        assert_eq!(cancel(&home, "city-instance", &cancel_request).unwrap()["status"], "cancelled");
        assert!(list(&home, "city-instance", &json!({"runId":resumed["runId"]})).unwrap()["rules"].as_array().unwrap().is_empty());
        assert_eq!(resumed_clock["clockRevision"], clock["clockRevision"]);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn unsupported_triggers_and_location_claims_fail_closed() {
        let home = home();
        let (run, clock) = setup(&home);
        let mut request = payload(&run, &clock, now_ms());
        request["rule"]["trigger"] = json!({"kind":"relationship","residentId":"resident:xia","threshold":3});
        assert_eq!(schedule_at(&home, "city-instance", &request, now_ms()).unwrap_err(), "game_story_trigger_unsupported");
        let mut location = payload(&run, &clock, now_ms());
        location["rule"]["requirePlayerAtTarget"] = json!(true);
        location["options"]["operationId"] = json!("schedule-2");
        assert_eq!(schedule_at(&home, "city-instance", &location, now_ms()).unwrap_err(), "game_story_location_unavailable");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn weekly_rules_use_the_next_city_utc_occurrence() {
        assert_eq!(next_weekly(86_400_000, 6, "18:00").unwrap(), 2 * DAY_MS + 18 * 3_600_000);
        assert_eq!(next_weekly(5 * DAY_MS + 18 * 3_600_000, 2, "18:00").unwrap(), 12 * DAY_MS + 18 * 3_600_000);
    }
}
