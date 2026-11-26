//! Terminal transitions for an explicitly bound local City Story playtest.
use std::path::Path;

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

use crate::creator_store::{database, new_id, now_ms};

pub(crate) fn complete(home: &Path, city_instance: &str, payload: &Value) -> Result<Value, &'static str> {
    let run_id = payload["runId"].as_str().filter(|id| crate::city_runtime::valid_id(id)).ok_or("game_argument_invalid")?;
    let action = payload["action"].as_str().filter(|action| matches!(*action, "finish" | "restart")).ok_or("game_argument_invalid")?;
    let now = now_ms();
    let mut db = database(home)?;
    crate::city_runtime::migrate(&db)?;
    crate::story_registry::migrate(&db)?;
    crate::story_store::migrate_story(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;

    let row = tx.query_row(
        "SELECT g.city_id,g.player_id,g.status,g.expires_at_ms,b.story_id,b.story_run_id
         FROM city_game_runs g JOIN city_game_story_bindings b ON b.run_id=g.run_id
         WHERE g.run_id=?1 AND g.city_instance_id=?2",
        params![run_id,city_instance],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,
            row.get::<_,u64>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?)),
    ).optional().map_err(|_| "creator_store_unavailable")?;
    let (city_id, player_id, status, expires_at, story_id, story_run_id) = row.ok_or("story_playtest_run_mismatch")?;
    if player_id != crate::creator_projects::LOCAL_CREATOR_OWNER { return Err("story_playtest_run_mismatch"); }

    let prior = tx.query_row("SELECT action,result_json FROM city_story_playtest_completions WHERE run_id=?1",
        [run_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    if let Some((prior_action, result)) = prior {
        if prior_action != action { return Err("story_playtest_already_completed"); }
        return serde_json::from_str(&result).map_err(|_| "creator_store_corrupt");
    }
    if status != "active" || expires_at <= now { return Err("game_run_cancelled"); }
    let digest = crate::story_registry::pinned_run_digest(&tx, &player_id, &city_id, &story_id, &story_run_id)?;
    let cursor: Option<String> = tx.query_row(
        "SELECT json_extract(document_json,'$.cursor') FROM story_states WHERE player_id=?1 AND city_id=?2 AND story_id=?3 AND story_run_id=?4",
        params![player_id,city_id,story_id,story_run_id], |row| row.get::<_,Option<String>>(0),
    ).optional().map_err(|_| "creator_store_unavailable")?.flatten();
    let view = crate::story_registry::player_story_presentation(&tx, &city_id, &story_id, &story_run_id, cursor.as_deref())?;
    if view["beat"]["kind"] != "ending" { return Err("story_ending_required"); }

    tx.execute("UPDATE story_runs SET status='stopped',updated_at_ms=?2 WHERE story_run_id=?1",
        params![story_run_id,now]).map_err(|_| "creator_store_unavailable")?;
    tx.execute("UPDATE city_game_runs SET status='stopped',active_slot=NULL,finished_at_ms=?2 WHERE run_id=?1",
        params![run_id,now]).map_err(|_| "creator_store_unavailable")?;

    let result = if action == "restart" {
        let next_story_run = crate::story_registry::insert_story_run(&tx, &player_id, &city_id, &story_id,
            Some(&story_run_id), &digest, now)?;
        let next_game_run = new_id("game-run")?;
        tx.execute("INSERT INTO city_game_runs(run_id,city_instance_id,city_id,game_id,player_id,build_id,status,active_slot,created_at_ms,expires_at_ms)
            SELECT ?1,city_instance_id,city_id,game_id,player_id,build_id,'active',city_instance_id,?2,?3 FROM city_game_runs WHERE run_id=?4",
            params![next_game_run,now,now + crate::city_runtime::RUN_TTL_MS,run_id])
            .map_err(|_| "creator_store_unavailable")?;
        tx.execute("INSERT INTO city_game_story_bindings(run_id,story_id,story_run_id) VALUES (?1,?2,?3)",
            params![next_game_run,story_id,next_story_run]).map_err(|_| "creator_store_unavailable")?;
        json!({"action":action,"runId":next_game_run,"storyRunId":next_story_run})
    } else {
        json!({"action":action,"runId":run_id,"storyRunId":story_run_id})
    };
    tx.execute("INSERT INTO city_story_playtest_completions(run_id,action,result_json) VALUES (?1,?2,?3)",
        params![run_id,action,result.to_string()]).map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    crate::story_actor_worker::cancel(home, &story_run_id);
    Ok(result)
}
