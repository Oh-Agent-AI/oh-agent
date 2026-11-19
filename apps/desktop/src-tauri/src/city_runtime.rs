use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use crate::creator_store::{database, digest, new_id, now_ms};
use crate::story_store::{commit_story, story_state, StoryClockAuthorityV1, StoryCommitCommandV1};

const RUN_TTL_MS: u64 = 30 * 60 * 1_000;

pub(crate) fn migrate(db: &Connection) -> Result<(), &'static str> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS city_clocks (
        city_id TEXT PRIMARY KEY, clock_id TEXT NOT NULL UNIQUE,
        simulation_utc_ms INTEGER NOT NULL, observed_utc_ms INTEGER NOT NULL,
        tick INTEGER NOT NULL, clock_revision TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS city_players (
        profile_key TEXT PRIMARY KEY, player_id TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS city_game_runs (
        run_id TEXT PRIMARY KEY, city_instance_id TEXT NOT NULL, city_id TEXT NOT NULL,
        game_id TEXT NOT NULL, player_id TEXT NOT NULL, build_id TEXT,
        status TEXT NOT NULL, active_slot TEXT UNIQUE, created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL, finished_at_ms INTEGER
    );").map_err(|_| "creator_store_unavailable")
}

pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.starts_with(|c: char| c.is_ascii_alphanumeric())
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-'))
}

fn required<'a>(payload: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    payload.get(key).and_then(Value::as_str).filter(|value| valid_id(value)).ok_or("game_argument_invalid")
}

fn expire_runs(db: &Connection, now: u64) -> Result<(), &'static str> {
    db.execute("UPDATE city_game_runs SET status='expired',active_slot=NULL,finished_at_ms=?1 WHERE active_slot IS NOT NULL AND expires_at_ms<=?1", [now])
        .map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

pub(crate) fn read_clock_at(home: &Path, city_id: &str, now: u64) -> Result<Value, &'static str> {
    if !valid_id(city_id) { return Err("game_argument_invalid"); }
    let db = database(home)?;
    migrate(&db)?;
    let row = db.query_row("SELECT clock_id,simulation_utc_ms,observed_utc_ms,tick,clock_revision FROM city_clocks WHERE city_id=?1", [city_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?, row.get::<_, u64>(2)?, row.get::<_, u64>(3)?, row.get::<_, String>(4)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let (clock_id, mut simulation, observed, mut tick, revision) = match row {
        Some(row) => row,
        None => {
            let clock_id = new_id("city-clock")?;
            let revision = digest(&format!("{clock_id}:realtime:1"));
            let tick = 1 + now / 250;
            db.execute("INSERT INTO city_clocks(city_id,clock_id,simulation_utc_ms,observed_utc_ms,tick,clock_revision) VALUES (?1,?2,?3,?3,?4,?5)",
                params![city_id,clock_id,now,tick,revision]).map_err(|_| "creator_store_unavailable")?;
            (clock_id, now, now, tick, revision)
        }
    };
    let uncertain = now < observed;
    if !uncertain {
        simulation = simulation.saturating_add(now - observed);
        tick = tick.max(1 + simulation / 250);
        db.execute("UPDATE city_clocks SET simulation_utc_ms=?2,observed_utc_ms=?3,tick=?4 WHERE city_id=?1",
            params![city_id,simulation,now,tick]).map_err(|_| "creator_store_unavailable")?;
    }
    let mut snapshot = json!({"schemaVersion":1,"cityId":city_id,"clockId":clock_id,"simulationUtcMs":simulation,
        "timeZoneId":"UTC","mode":"realtime","timeScale":1,"tick":tick,"clockRevision":revision});
    if uncertain { snapshot["uncertainty"] = json!("clock_uncertain"); }
    Ok(snapshot)
}

pub(crate) fn read_clock(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    read_clock_at(home, required(payload, "cityId")?, now_ms())
}

fn local_player(db: &Connection, now: u64) -> Result<String, &'static str> {
    if let Some(player_id) = db.query_row("SELECT player_id FROM city_players WHERE profile_key='local'", [], |row| row.get::<_, String>(0))
        .optional().map_err(|_| "creator_store_unavailable")? {
        return Ok(player_id);
    }
    let player_id = new_id("player")?;
    db.execute("INSERT INTO city_players(profile_key,player_id,created_at_ms) VALUES ('local',?1,?2)", params![player_id,now])
        .map_err(|_| "creator_store_unavailable")?;
    Ok(player_id)
}

pub(crate) fn start_run(home: &Path, city_instance: &str, payload: &Value) -> Result<Value, &'static str> {
    start_run_at(home, city_instance, payload, now_ms())
}

fn start_run_at(home: &Path, city_instance: &str, payload: &Value, now: u64) -> Result<Value, &'static str> {
    let city_id = required(payload, "cityId")?;
    let game_id = required(payload, "gameId")?;
    let build_id = payload.get("buildId").and_then(Value::as_str).filter(|value| valid_id(value));
    if payload.get("buildId").is_some_and(|value| value.as_str().is_none_or(|id| !valid_id(id))) { return Err("game_argument_invalid"); }
    let db = database(home)?;
    migrate(&db)?;
    expire_runs(&db, now)?;
    let player_id = local_player(&db, now)?;
    let run_id = new_id("game-run")?;
    db.execute("INSERT INTO city_game_runs(run_id,city_instance_id,city_id,game_id,player_id,build_id,status,active_slot,created_at_ms,expires_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,'active',?2,?7,?8)",
        params![run_id,city_instance,city_id,game_id,player_id,build_id,now,now + RUN_TTL_MS])
        .map_err(|error| if matches!(error, rusqlite::Error::SqliteFailure(_, _)) { "game_activity_busy" } else { "creator_store_unavailable" })?;
    read_clock_at(home, city_id, now)?;
    Ok(json!({"runId":run_id,"cityId":city_id,"gameId":game_id,"playerScope":{"playerId":player_id,"kind":"local-profile"},
        "status":"active","expiresAtMs":now + RUN_TTL_MS}))
}

pub(crate) fn stop_run(home: &Path, city_instance: &str, payload: &Value) -> Result<Value, &'static str> {
    let run_id = required(payload, "runId")?;
    let db = database(home)?;
    migrate(&db)?;
    let now = now_ms();
    expire_runs(&db, now)?;
    let row = db.query_row("SELECT city_instance_id,status FROM city_game_runs WHERE run_id=?1", [run_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional().map_err(|_| "creator_store_unavailable")?
        .ok_or("game_run_not_found")?;
    if row.0 != city_instance { return Err("game_run_mismatch"); }
    if row.1 != "active" { return Ok(json!({"runId":run_id,"status":row.1})); }
    db.execute("UPDATE city_game_runs SET status='stopped',active_slot=NULL,finished_at_ms=?2 WHERE run_id=?1 AND status='active'",
        params![run_id,now]).map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"runId":run_id,"status":"stopped"}))
}

pub(crate) fn active_run(db: &Connection, city_instance: &str, run_id: &str, now: u64) -> Result<(String, String, String), &'static str> {
    expire_runs(db, now)?;
    let row = db.query_row("SELECT city_instance_id,city_id,game_id,player_id,status FROM city_game_runs WHERE run_id=?1", [run_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("game_run_not_found")?;
    if row.0 != city_instance { return Err("game_run_mismatch"); }
    if row.4 != "active" { return Err("game_run_cancelled"); }
    Ok((row.1, row.2, row.3))
}

pub(crate) fn read_story(home: &Path, city_instance: &str, payload: &Value) -> Result<Value, &'static str> {
    let run_id = required(payload, "runId")?;
    let db = database(home)?;
    migrate(&db)?;
    let (city_id, game_id, player_id) = active_run(&db, city_instance, run_id, now_ms())?;
    story_state(home, &player_id, &city_id, &game_id)
}

pub(crate) fn commit(home: &Path, city_instance: &str, payload: &Value) -> Result<Value, &'static str> {
    commit_at(home, city_instance, payload, now_ms())
}

fn commit_at(home: &Path, city_instance: &str, payload: &Value, now: u64) -> Result<Value, &'static str> {
    let run_id = required(payload, "runId")?;
    let db = database(home)?;
    migrate(&db)?;
    let (city_id, game_id, player_id) = active_run(&db, city_instance, run_id, now)?;
    let clock = read_clock_at(home, &city_id, now)?;
    if clock.get("uncertainty").is_some() { return Err("city_time_uncertain"); }
    let command = StoryCommitCommandV1 {
        operation_id: required(payload, "operationId")?.to_string(), event_id: required(payload, "eventId")?.to_string(),
        player_id, city_id, game_id,
        resident_id: payload.get("residentId").and_then(Value::as_str).filter(|value| valid_id(value)).map(str::to_string),
        expected_story_revision: required(payload, "expectedStoryRevision")?.to_string(),
        expected_clock_revision: required(payload, "expectedClockRevision")?.to_string(),
        intent: payload.get("intent").filter(|value| value.is_object()).cloned().ok_or("game_argument_invalid")?,
        run_id: run_id.to_string(),
    };
    if payload.get("residentId").is_some() && command.resident_id.is_none() { return Err("game_argument_invalid"); }
    commit_story(home, command, StoryClockAuthorityV1 {
        revision: clock["clockRevision"].as_str().ok_or("creator_store_unavailable")?.to_string(),
        tick: clock["tick"].as_u64().ok_or("creator_store_unavailable")?,
        simulation_utc_ms: clock["simulationUtcMs"].as_u64().ok_or("creator_store_unavailable")?,
    })
}

pub(crate) fn story_evidence(home: &Path, run_id: &str) -> Result<Value, &'static str> {
    if !valid_id(run_id) { return Err("game_argument_invalid"); }
    let db = database(home)?;
    migrate(&db)?;
    let row = db.query_row("SELECT city_id,game_id,player_id FROM city_game_runs WHERE run_id=?1", [run_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("game_run_not_found")?;
    let state = story_state(home, &row.2, &row.0, &row.1)?;
    let rules = crate::city_scheduler::list_scope(home, &row.2, &row.0, &row.1)?;
    let dialogue = crate::story_store::story_dialogue(home, &row.2, &row.0, &row.1, 20)?.into_iter().filter_map(|entry| {
        let intent = entry["intent"].clone();
        let text = intent.get("text").and_then(Value::as_str)?;
        Some(json!({"eventId":entry["eventId"],"text":text,"createdAtMs":entry["createdAtMs"],"storyRevision":entry["storyRevision"]}))
    }).collect::<Vec<_>>();
    Ok(json!({"available":true,"runId":run_id,"storyRevision":state["storyRevision"],"state":state["state"],"rules":rules,"dialogue":dialogue}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn home() -> std::path::PathBuf {
        static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!("city-runtime-{}-{}", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed)))
    }
    fn start(home: &Path, now: u64) -> Value {
        start_run_at(home, "city-instance", &json!({"cityId":"city:one","gameId":"game.romance"}), now).unwrap()
    }
    fn commit_payload(run: &Value, clock: &Value, story_revision: &str) -> Value {
        json!({"runId":run["runId"],"operationId":"operation-1","eventId":"event-1","residentId":"resident:xia",
            "expectedStoryRevision":story_revision,"expectedClockRevision":clock["clockRevision"],
            "intent":{"kind":"invite","targetId":"place:cafe"}})
    }

    #[test]
    fn city_run_clock_and_rule_commit_form_one_local_host_path() {
        let home = home();
        let run = start(&home, 1_000);
        assert!(run["playerScope"]["playerId"].as_str().unwrap().starts_with("player"));
        let clock = read_clock_at(&home, "city:one", 1_000).unwrap();
        let first = commit_at(&home, "city-instance", &commit_payload(&run, &clock, "0"), 1_000).unwrap();
        assert_eq!(first["status"], "committed");
        let state = story_state(&home, run["playerScope"]["playerId"].as_str().unwrap(), "city:one", "game.romance").unwrap();
        assert_eq!(state["state"]["affection"], 1);
        let mut speak = commit_payload(&run, &clock, first["storyRevision"].as_str().unwrap());
        speak["operationId"] = json!("operation-speak");
        speak["eventId"] = json!("event-speak");
        speak["intent"] = json!({"kind":"speak","text":"See you Saturday."});
        commit_at(&home, "city-instance", &speak, 1_000).unwrap();
        let evidence = story_evidence(&home, run["runId"].as_str().unwrap()).unwrap();
        assert_eq!(evidence["state"]["affection"], 1);
        assert_eq!(evidence["dialogue"][0]["text"], "See you Saturday.");
        assert_eq!(read_clock_at(&home, "city:one", 2_000).unwrap()["simulationUtcMs"], 2_000);
        assert_eq!(commit_at(&home, "another-city", &commit_payload(&run, &clock, "0"), 2_000).unwrap_err(), "game_run_mismatch");
        stop_run(&home, "city-instance", &json!({"runId":run["runId"]})).unwrap();
        assert_eq!(commit_at(&home, "city-instance", &commit_payload(&run, &clock, "0"), 2_000).unwrap_err(), "game_run_cancelled");
        let restarted = start(&home, 3_000);
        assert_eq!(restarted["playerScope"]["playerId"], run["playerScope"]["playerId"]);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn city_dispatch_exposes_only_host_scoped_story_commands() {
        let home = home();
        assert_eq!(crate::creator_projects::dispatch_city_runtime(&home, "city-instance", "city.game.run.start",
            &json!({"cityId":"city:one","gameId":"game.romance","playerId":"forged-player"})).unwrap_err(), "creator_method_unavailable");
        let run = crate::creator_projects::dispatch_city_runtime(&home, "city-instance", "city.game.run.start",
            &json!({"cityId":"city:one","gameId":"game.romance"})).unwrap();
        let clock = crate::creator_projects::dispatch_city_runtime(&home, "city-instance", "city.time.read", &json!({"cityId":"city:one"})).unwrap();
        let payload = commit_payload(&run, &clock, "0");
        let mut forged = payload.clone();
        forged["state"] = json!({"affection":99});
        assert_eq!(crate::creator_projects::dispatch_city_runtime(&home, "city-instance", "city.story.commit", &forged).unwrap_err(), "creator_method_unavailable");
        let first = crate::creator_projects::dispatch_city_runtime(&home, "city-instance", "city.story.commit", &payload).unwrap();
        let retry = crate::creator_projects::dispatch_city_runtime(&home, "city-instance", "city.story.commit", &payload).unwrap();
        assert_eq!(retry["storyRevision"], first["storyRevision"]);
        let state = crate::creator_projects::dispatch_city_runtime(&home, "city-instance", "city.story.read", &json!({"runId":run["runId"]})).unwrap();
        assert_eq!(state["state"]["affection"], 1);
        assert_eq!(crate::creator_projects::dispatch_city_runtime(&home, "city-instance", "city.story.delete", &json!({"runId":run["runId"]})).unwrap_err(), "creator_method_unavailable");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn clock_rollback_is_uncertain_and_does_not_repeat_ticks() {
        let home = home();
        let first = read_clock_at(&home, "city:one", 2_000).unwrap();
        let rolled_back = read_clock_at(&home, "city:one", 1_000).unwrap();
        assert_eq!(rolled_back["uncertainty"], "clock_uncertain");
        assert_eq!(rolled_back["tick"], first["tick"]);
        assert_eq!(rolled_back["simulationUtcMs"], first["simulationUtcMs"]);
        std::fs::remove_dir_all(home).ok();
    }
}
