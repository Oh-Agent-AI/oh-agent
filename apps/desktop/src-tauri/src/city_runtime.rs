use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use crate::creator_store::{database, digest, new_id, now_ms};
use crate::story_store::{commit_story, legacy_story_scope, story_state, StoryClockAuthorityV1, StoryCommitCommandV1, StoryForkScopeV1};

const RUN_TTL_MS: u64 = 30 * 60 * 1_000;

pub(crate) fn migrate(db: &Connection) -> Result<(), &'static str> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS city_clocks (
        city_id TEXT PRIMARY KEY, clock_id TEXT NOT NULL UNIQUE,
        simulation_utc_ms INTEGER NOT NULL, observed_utc_ms INTEGER NOT NULL,
        tick INTEGER NOT NULL, clock_revision TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS city_preview_clocks (
        preview_id TEXT PRIMARY KEY, city_id TEXT NOT NULL, clock_id TEXT NOT NULL UNIQUE,
        simulation_utc_ms INTEGER NOT NULL, observed_utc_ms INTEGER NOT NULL,
        tick INTEGER NOT NULL, clock_revision TEXT NOT NULL, base_clock_revision TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS city_players (
        profile_key TEXT PRIMARY KEY, player_id TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS city_game_runs (
        run_id TEXT PRIMARY KEY, city_instance_id TEXT NOT NULL, city_id TEXT NOT NULL,
        game_id TEXT NOT NULL, player_id TEXT NOT NULL, build_id TEXT,
        status TEXT NOT NULL, active_slot TEXT UNIQUE, created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL, finished_at_ms INTEGER
    );").map_err(|_| "creator_store_unavailable")?;
    // Story Fork 表（RFC §13.1）：与 city_preview_clocks 对称的 Story 侧私有命名空间。
    crate::story_store::migrate_story_forks(db)
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

fn clock_snapshot(city_id: &str, clock_id: &str, simulation: u64, tick: u64, revision: &str, uncertain: bool) -> Value {
    let mut snapshot = json!({"schemaVersion":1,"cityId":city_id,"clockId":clock_id,"simulationUtcMs":simulation,
        "timeZoneId":"UTC","mode":"realtime","timeScale":1,"tick":tick,"clockRevision":revision});
    if uncertain { snapshot["uncertainty"] = json!("clock_uncertain"); }
    snapshot
}

/// Preview Clock Fork（隔离 Spec §7.3）：每个 Preview 从源 Clock 派生一份私有时间。
/// 派生只读取正式 Clock 的当前值，不推进它；之后的每次推进只写
/// `city_preview_clocks`，正式 `city_clocks` 不被任何 Preview 读路径触碰。
pub(crate) fn read_preview_clock_at(home: &Path, preview_id: &str, city_id: &str, now: u64) -> Result<Value, &'static str> {
    if !crate::creator_code_game::valid_preview_id(preview_id) || !valid_id(city_id) { return Err("game_argument_invalid"); }
    let db = database(home)?;
    migrate(&db)?;
    let row = db.query_row("SELECT clock_id,simulation_utc_ms,observed_utc_ms,tick,clock_revision FROM city_preview_clocks WHERE preview_id=?1", [preview_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?, row.get::<_, u64>(2)?, row.get::<_, u64>(3)?, row.get::<_, String>(4)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let (clock_id, simulation, tick, revision) = match row {
        Some(row) => {
            if now < row.2 { return Ok(clock_snapshot(city_id, &row.0, row.1, row.3, &row.4, true)); }
            let simulation = row.1.saturating_add(now - row.2);
            let tick = row.3.max(1 + simulation / 250);
            db.execute("UPDATE city_preview_clocks SET simulation_utc_ms=?2,observed_utc_ms=?3,tick=?4 WHERE preview_id=?1",
                params![preview_id,simulation,now,tick]).map_err(|_| "creator_store_unavailable")?;
            (row.0, simulation, tick, row.4)
        }
        None => {
            let formal = db.query_row("SELECT simulation_utc_ms,tick,clock_revision FROM city_clocks WHERE city_id=?1", [city_id],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?, row.get::<_, String>(2)?))).optional().map_err(|_| "creator_store_unavailable")?;
            let clock_id = new_id("preview-clock")?;
            let (simulation, tick) = match formal { Some((base, base_tick, _)) => (base, base_tick), None => (now, 1 + now / 250) };
            let revision = digest(&format!("{clock_id}:preview:1"));
            db.execute("INSERT INTO city_preview_clocks(preview_id,city_id,clock_id,simulation_utc_ms,observed_utc_ms,tick,clock_revision,base_clock_revision)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![preview_id,city_id,clock_id,simulation,now,tick,revision,
                    formal.as_ref().map(|(_,_,revision)| revision.as_str()).unwrap_or("none")])
                .map_err(|error| if matches!(error, rusqlite::Error::SqliteFailure(_, _)) { "game_activity_busy" } else { "creator_store_unavailable" })?;
            (clock_id, simulation, tick, revision)
        }
    };
    Ok(clock_snapshot(city_id, &clock_id, simulation, tick, &revision, false))
}

pub(crate) fn read_preview_clock(home: &Path, preview_id: &str, payload: &Value) -> Result<Value, &'static str> {
    read_preview_clock_at(home, preview_id, required(payload, "cityId")?, now_ms())
}

/// Preview 终态（finished/error）与目录回收时调用；失败静默——幂等清理，
/// 残留行只占主键空间，不影响正式 Clock。
pub(crate) fn forget_preview_clock(home: &Path, preview_id: &str) {
    if !crate::creator_code_game::valid_preview_id(preview_id) { return; }
    if let Ok(db) = database(home) {
        let _ = db.execute("DELETE FROM city_preview_clocks WHERE preview_id=?1", [preview_id]);
    }
}

/// Story Preview Fork（RFC §13.1 / 隔离 Spec §7.3）：与 Clock Fork 对称的 Story
/// 侧私有命名空间，forkId = previewId。首次读以 scope 的正式 story_states 行派生
/// 基线快照（copy-on-read），之后只读 Fork 行——正式侧推进不进入 Fork，Fork 也
/// 永不回写正式行。预览请求的 source 现阶段不带 Story 上下文，scope 由 Run 自身
/// 的 preview 玩家 + 合成 Story 身份构成，基线因此恒为 "0" 空基线；Story 上下文
/// 注入是 PR 后续（RFC §13 第 3 条：PR-4 前保持失败关闭）。
pub(crate) fn read_story_fork(home: &Path, preview_id: &str, scope: &StoryForkScopeV1) -> Result<Value, &'static str> {
    if !crate::creator_code_game::valid_preview_id(preview_id) { return Err("game_argument_invalid"); }
    for id in [&scope.player_id, &scope.city_id, &scope.story_id, &scope.story_run_id] {
        if !valid_id(id) { return Err("game_argument_invalid"); }
    }
    match crate::story_store::story_fork(home, preview_id)? {
        // 已有 Fork 行：绑定 scope 一致才可读；崩溃残留的旧 Run Fork 失败关闭，
        // 不把旧快照泄漏给新 Run，也不静默替换重派生。
        Some(row) if row.0 == scope.player_id && row.1 == scope.city_id
            && row.2 == scope.story_id && row.3 == scope.story_run_id => Ok(row.4),
        Some(_) => Err("game_run_mismatch"),
        None => crate::story_store::seed_story_fork(home, preview_id, scope),
    }
}

/// Preview 域 `city.story.read` 的入口：payload.runId 必须绑定本 Preview 窗口的
/// 活跃 Run（防串窗），且必须是 Preview Run——正式 Run 的玩家 scope 不进入 Fork。
pub(crate) fn read_preview_story(home: &Path, preview_id: &str, payload: &Value) -> Result<Value, &'static str> {
    if !crate::creator_code_game::valid_preview_id(preview_id) { return Err("game_argument_invalid"); }
    let run_id = required(payload, "runId")?;
    let db = database(home)?;
    migrate(&db)?;
    let (city_id, game_id, player_id) = active_run(&db, preview_id, run_id, now_ms())?;
    // 只有 start_preview_run 生成 preview-player- 前缀；正式 Run 绑到 preview
    // 实例名属异常路径，失败关闭（基线不得来自正式玩家 scope）。
    if !player_id.starts_with("preview-player-") { return Err("game_run_mismatch"); }
    let (story_id, story_run_id) = legacy_story_scope(&game_id);
    read_story_fork(home, preview_id, &StoryForkScopeV1 { player_id, city_id, story_id, story_run_id })
}

/// Preview 终态（finished/error）、Run 停止与目录回收时调用；失败静默——幂等
/// 清理，残留行只占主键空间，不参与任何正式读路径（与 forget_preview_clock 同型）。
pub(crate) fn forget_story_fork(home: &Path, preview_id: &str) {
    if !crate::creator_code_game::valid_preview_id(preview_id) { return; }
    if let Ok(db) = database(home) {
        let _ = db.execute("DELETE FROM story_preview_forks WHERE preview_id=?1", [preview_id]);
    }
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
    start_scoped_run_at(home, city_instance, payload, now, None)
}

pub(crate) fn start_preview_run(home: &Path, preview_id: &str, payload: &Value) -> Result<Value, &'static str> {
    let player_id = new_id("preview-player-")?;
    start_scoped_run_at(home, preview_id, payload, now_ms(), Some(player_id))
}

fn start_scoped_run_at(home: &Path, city_instance: &str, payload: &Value, now: u64, preview_player: Option<String>) -> Result<Value, &'static str> {
    let city_id = required(payload, "cityId")?;
    let game_id = required(payload, "gameId")?;
    let build_id = payload.get("buildId").and_then(Value::as_str).filter(|value| valid_id(value));
    if payload.get("buildId").is_some_and(|value| value.as_str().is_none_or(|id| !valid_id(id))) { return Err("game_argument_invalid"); }
    let db = database(home)?;
    migrate(&db)?;
    expire_runs(&db, now)?;
    let is_preview = preview_player.is_some();
    let player_id = match preview_player { Some(player) => player, None => local_player(&db, now)? };
    let player_kind = if is_preview { "preview" } else { "local-profile" };
    let run_id = new_id("game-run")?;
    db.execute("INSERT INTO city_game_runs(run_id,city_instance_id,city_id,game_id,player_id,build_id,status,active_slot,created_at_ms,expires_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,'active',?2,?7,?8)",
        params![run_id,city_instance,city_id,game_id,player_id,build_id,now,now + RUN_TTL_MS])
        .map_err(|error| if matches!(error, rusqlite::Error::SqliteFailure(_, _)) { "game_activity_busy" } else { "creator_store_unavailable" })?;
    // Preview 的 Run 起始时钟走 Preview Fork，正式 Clock 不被 Preview 启停推进。
    if is_preview { read_preview_clock_at(home, city_instance, city_id, now)?; } else { read_clock_at(home, city_id, now)?; }
    Ok(json!({"runId":run_id,"cityId":city_id,"gameId":game_id,"playerScope":{"playerId":player_id,"kind":player_kind},
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

pub(crate) fn stop_preview_runs(home: &Path, preview_id: &str) -> Result<u64, &'static str> {
    if !crate::creator_code_game::valid_preview_id(preview_id) { return Err("game_argument_invalid"); }
    let db = database(home)?;
    migrate(&db)?;
    let now = now_ms();
    expire_runs(&db, now)?;
    let stopped = db.execute("UPDATE city_game_runs SET status='stopped',active_slot=NULL,finished_at_ms=?2
        WHERE city_instance_id=?1 AND status='active'", params![preview_id,now]).map_err(|_| "creator_store_unavailable")?;
    forget_preview_clock(home, preview_id);
    forget_story_fork(home, preview_id);
    Ok(stopped as u64)
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
    // D-2 投递上下文在 command 被移动前捕获（投递发生在 commit 成功之后）。
    let turn_player = player_id.clone(); let turn_city = city_id.clone(); let turn_game = game_id.clone();
    let turn_resident = payload.get("residentId").and_then(Value::as_str).map(str::to_string);
    let turn_event = payload.get("eventId").and_then(Value::as_str).map(str::to_string).unwrap_or_default();
    let turn_operation = payload.get("operationId").and_then(Value::as_str).map(str::to_string).unwrap_or_default();
    let command = StoryCommitCommandV1 {
        operation_id: required(payload, "operationId")?.to_string(), event_id: required(payload, "eventId")?.to_string(),
        player_id, city_id, game_id,
        // Runtime 的 commit/read 仍走 legacy 合成映射（每 gameId 一个合成 storyId），
        // S-1 只改存储键，不改变既有 Runtime 语义。
        story_scope: None,
        resident_id: payload.get("residentId").and_then(Value::as_str).filter(|value| valid_id(value)).map(str::to_string),
        expected_story_revision: required(payload, "expectedStoryRevision")?.to_string(),
        expected_clock_revision: required(payload, "expectedClockRevision")?.to_string(),
        intent: payload.get("intent").filter(|value| value.is_object()).cloned().ok_or("game_argument_invalid")?,
        run_id: run_id.to_string(),
        // WorldEventEnvelopeV1 信封字段（RFC §3.2）：可选透传，缺省 None 落库 NULL。
        rule_set_digest: payload.get("ruleSetDigest").and_then(Value::as_str).filter(|value| valid_id(value)).map(str::to_string),
        causation_id: payload.get("causationId").and_then(Value::as_str).filter(|value| valid_id(value)).map(str::to_string),
        correlation_id: payload.get("correlationId").and_then(Value::as_str).filter(|value| valid_id(value)).map(str::to_string),
    };
    if payload.get("residentId").is_some() && command.resident_id.is_none() { return Err("game_argument_invalid"); }
    for key in ["ruleSetDigest", "causationId", "correlationId"] {
        if payload.get(key).is_some_and(|value| value.as_str().filter(|id| valid_id(id)).is_none()) { return Err("game_argument_invalid"); }
    }
    let result = commit_story(home, command, StoryClockAuthorityV1 {
        revision: clock["clockRevision"].as_str().ok_or("creator_store_unavailable")?.to_string(),
        tick: clock["tick"].as_u64().ok_or("creator_store_unavailable")?,
        simulation_utc_ms: clock["simulationUtcMs"].as_u64().ok_or("creator_store_unavailable")?,
    })?;
    // D-2（Delivery Bus）：玩家事实落到绑定 resident 时投递 actor.turn。事实已
    // 提交，投递失败只记日志不改 commit 语义——Actor 可从 timeline 拉取（推-拉互补）；
    // dedupe_key=event_id 保证重试幂等（spec HB-06）。
    if let Some(resident_id) = turn_resident.as_deref() {
        let turn = agent_vitals_mcp::mcp::host_delivery::ActorTurnContext {
            player_id: &turn_player, city_id: &turn_city, game_id: &turn_game,
            run_id, resident_id, event_id: &turn_event, operation_id: &turn_operation };
        match agent_vitals_mcp::mcp::host_delivery::post_actor_turn_for_commit(home, &turn) {
            Ok(delivery) => { if delivery["droppedOldest"].as_i64().unwrap_or(0) > 0 {
                agent_vitals_runtime::logging::log_warn("host_delivery", &format!(
                    "actor.turn delivered with droppedOldest={} (resident={resident_id}, event={})", delivery["droppedOldest"], turn_event)); }
            }
            Err(error) => agent_vitals_runtime::logging::log_warn("host_delivery", &format!(
                "actor.turn post failed after committed fact (resident={resident_id}, event={}): {} — actor catches up via timeline", turn_event, error.message)),
        }
    }
    Ok(result)
}

/// Actor Intent 的 City Runtime 面（RFC §12.2：任何影响公共 NPC 状态的 Intent
/// 进入 City Runtime 的单一 Intent 队列入口）：管线本体在 actor_intent，此处仅
/// 面向 dispatch 的薄委托（`city.story.intent.submit`，payload 即 AgentIntentV1）。
pub(crate) fn submit_intent(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    crate::actor_intent::submit_intent(home, payload)
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
    // 读投影（RFC §3.2）：事件行以 WorldEventEnvelopeV1 形状（有界字段）随证据面输出。
    let events = crate::story_store::story_event_envelopes(home, &row.2, &row.0, &row.1, 20)?;
    Ok(json!({"available":true,"runId":run_id,"storyRevision":state["storyRevision"],"state":state["state"],"rules":rules,"dialogue":dialogue,"events":events}))
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
    fn story_evidence_projects_committed_events_as_world_event_envelopes() {
        let home = home();
        let run = start(&home, 1_000);
        let clock = read_clock_at(&home, "city:one", 1_000).unwrap();
        // 非法信封字段（含空格）在 Runtime 入口即拒绝，不产生事件行。
        let mut invalid = commit_payload(&run, &clock, "0");
        invalid["ruleSetDigest"] = json!("bad id!");
        assert_eq!(commit_at(&home, "city-instance", &invalid, 1_000).unwrap_err(), "game_argument_invalid");
        // 携带信封字段的提交经读投影读回（legacy 行投影为 game 子集 scope）。
        let mut payload = commit_payload(&run, &clock, "0");
        payload["ruleSetDigest"] = json!("ruleset:digest-1");
        payload["causationId"] = json!("event-cause-0");
        payload["correlationId"] = json!("trace-corr-1");
        commit_at(&home, "city-instance", &payload, 1_000).unwrap();
        let evidence = story_evidence(&home, run["runId"].as_str().unwrap()).unwrap();
        let events = evidence["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["eventId"], "event-1");
        assert_eq!(events[0]["type"], "invite");
        assert_eq!(events[0]["scope"]["kind"], "game");
        assert_eq!(events[0]["scope"]["gameId"], "game.romance");
        assert_eq!(events[0]["actorId"], run["playerScope"]["playerId"]);
        assert_eq!(events[0]["simulationUtcMs"], 1_000);
        assert_eq!(events[0]["ruleSetDigest"], "ruleset:digest-1");
        assert_eq!(events[0]["causationId"], "event-cause-0");
        assert_eq!(events[0]["correlationId"], "trace-corr-1");
        assert_eq!(events[0]["payload"]["kind"], "invite");
        // 信封的 expectedRevision 是行内权威 revision：作为下一次 CAS 的期望基线。
        let mut plain = commit_payload(&run, &clock, events[0]["expectedRevision"].as_str().unwrap());
        plain["operationId"] = json!("operation-plain");
        plain["eventId"] = json!("event-plain");
        commit_at(&home, "city-instance", &plain, 1_000).unwrap();
        let evidence = story_evidence(&home, run["runId"].as_str().unwrap()).unwrap();
        let plain_event = evidence["events"].as_array().unwrap().iter().find(|envelope| envelope["eventId"] == "event-plain").unwrap();
        assert!(plain_event.get("ruleSetDigest").is_none());
        assert!(plain_event.get("causationId").is_none());
        assert!(plain_event.get("correlationId").is_none());
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

    fn formal_clock_row(home: &Path, city_id: &str) -> Option<(String, u64, u64, u64, String)> {
        database(home).unwrap().query_row(
            "SELECT clock_id,simulation_utc_ms,observed_utc_ms,tick,clock_revision FROM city_clocks WHERE city_id=?1", [city_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).optional().unwrap()
    }

    fn preview_clock_row(home: &Path, preview_id: &str) -> Option<(String, u64, u64, u64, String)> {
        database(home).unwrap().query_row(
            "SELECT clock_id,simulation_utc_ms,observed_utc_ms,tick,clock_revision FROM city_preview_clocks WHERE preview_id=?1", [preview_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).optional().unwrap()
    }

    #[test]
    fn preview_clock_forks_from_source_and_never_advances_formal_city_clock() {
        let home = home();
        read_clock_at(&home, "city:one", 4_000).unwrap();
        let formal_before = formal_clock_row(&home, "city:one").unwrap();
        // 派生只读正式 Clock，不推进它。
        let fork = read_preview_clock_at(&home, "preview-clock-a", "city:one", 4_000).unwrap();
        assert!(fork["clockId"].as_str().unwrap().starts_with("preview-clock"));
        assert_eq!(fork["cityId"], "city:one");
        assert_eq!(formal_clock_row(&home, "city:one").unwrap(), formal_before);
        // 推进只写 Preview 自己的行，正式行保持原值。
        let advanced = read_preview_clock_at(&home, "preview-clock-a", "city:one", 6_000).unwrap();
        assert_eq!(advanced["simulationUtcMs"], 6_000);
        let forked_row = preview_clock_row(&home, "preview-clock-a").unwrap();
        assert_eq!(forked_row.1, 6_000);
        assert_eq!(forked_row.2, 6_000);
        assert_eq!(formal_clock_row(&home, "city:one").unwrap(), formal_before);
        // Run 起始走 Preview Fork：playerScope 是 preview 身份，正式行仍不变。
        let run = start_preview_run(&home, "preview-clock-a", &json!({"cityId":"city:one","gameId":"game.romance"})).unwrap();
        assert_eq!(run["playerScope"]["kind"], "preview");
        assert!(run["playerScope"]["playerId"].as_str().unwrap().starts_with("preview-player-"));
        assert_eq!(formal_clock_row(&home, "city:one").unwrap(), formal_before);
        // 第二个 Preview 拥有独立 Fork；终态清理删除自己的 Fork，不影响另一个。
        let _ = start_preview_run(&home, "preview-clock-b", &json!({"cityId":"city:one","gameId":"game.romance"})).unwrap();
        let second = preview_clock_row(&home, "preview-clock-b");
        assert!(second.is_some());
        assert_ne!(fork["clockId"], second.unwrap().0);
        crate::creator_code_game::record_preview_state(&home, &json!({"status":"finished","previewId":"preview-clock-a","gameId":"game.romance"})).unwrap();
        assert!(preview_clock_row(&home, "preview-clock-a").is_none());
        assert!(preview_clock_row(&home, "preview-clock-b").is_some());
        // 正式面自始至终没有被 Preview 启停推进。
        assert_eq!(formal_clock_row(&home, "city:one").unwrap(), formal_before);
        assert_eq!(read_preview_clock_at(&home, "bad id!", "city:one", 1_000).unwrap_err(), "game_argument_invalid");
        std::fs::remove_dir_all(home).ok();
    }

    fn fork_clock() -> StoryClockAuthorityV1 {
        StoryClockAuthorityV1 { revision: "fork-clock-1".to_string(), tick: 1, simulation_utc_ms: 1_000 }
    }

    fn fork_commit(player: &str, operation: &str, event: &str, revision: &str) -> StoryCommitCommandV1 {
        StoryCommitCommandV1 {
            operation_id: operation.to_string(), event_id: event.to_string(),
            player_id: player.to_string(), city_id: "city:one".to_string(), game_id: "game.romance".to_string(),
            story_scope: None, resident_id: Some("resident:xia".to_string()),
            expected_story_revision: revision.to_string(), expected_clock_revision: "fork-clock-1".to_string(),
            intent: json!({"kind":"invite","targetId":"place:cafe"}), run_id: "fork-run".to_string(),
            rule_set_digest: None, causation_id: None, correlation_id: None,
        }
    }

    /// 正式面的完整指纹：story_states / story_events / story_outbox 全部行 +
    /// 正式 Clock 行。Fork 读写路径对它的任何改写都构成 V3-21 违例。
    fn formal_story_snapshot(home: &Path) -> Value {
        let db = database(home).unwrap();
        let mut statement = db.prepare("SELECT player_id,city_id,story_id,story_run_id,revision,document_json FROM story_states ORDER BY player_id,city_id,story_id,story_run_id").unwrap();
        let states: Vec<Value> = statement.query_map([], |row| Ok(json!({
            "playerId":row.get::<_,String>(0)?,"cityId":row.get::<_,String>(1)?,"storyId":row.get::<_,String>(2)?,
            "storyRunId":row.get::<_,String>(3)?,"revision":row.get::<_,String>(4)?,"document":row.get::<_,String>(5)?})))
            .unwrap().map(|row| row.unwrap()).collect();
        let mut statement = db.prepare("SELECT event_id,rule_id,status FROM story_events ORDER BY event_id").unwrap();
        let events: Vec<Value> = statement.query_map([], |row| Ok(json!({
            "eventId":row.get::<_,String>(0)?,"ruleId":row.get::<_,String>(1)?,"status":row.get::<_,String>(2)?})))
            .unwrap().map(|row| row.unwrap()).collect();
        let mut statement = db.prepare("SELECT event_id,operation_id,status FROM story_outbox ORDER BY id").unwrap();
        let outbox: Vec<Value> = statement.query_map([], |row| Ok(json!({
            "eventId":row.get::<_,String>(0)?,"operationId":row.get::<_,String>(1)?,"status":row.get::<_,String>(2)?})))
            .unwrap().map(|row| row.unwrap()).collect();
        json!({"states":states,"events":events,"outbox":outbox,"clock":formal_clock_row(home, "city:one")})
    }

    fn story_fork_row(home: &Path, preview_id: &str) -> Option<(String, String, String, String, String, String)> {
        database(home).unwrap().query_row(
            "SELECT story_id,story_run_id,base_story_revision,city_id,player_id,fork_json FROM story_preview_forks WHERE preview_id=?1", [preview_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))).optional().unwrap()
    }

    #[test]
    fn story_fork_copies_on_read_holds_base_and_never_touches_formal_state() {
        let home = home();
        // 正式面基线：正式 Clock 行 + 本地玩家 Story 行 + 事件/Outbox。
        read_clock_at(&home, "city:one", 1_000).unwrap();
        commit_story(&home, fork_commit("player-local", "op-f1", "event-f1", "0"), fork_clock()).unwrap();
        // Preview Run 与 Fork scope：preview 玩家的合成 Story 地址。
        let run = start_preview_run(&home, "preview-fork-a", &json!({"cityId":"city:one","gameId":"game.romance"})).unwrap();
        let player = run["playerScope"]["playerId"].as_str().unwrap().to_string();
        // 正式侧在 Fork scope 已有状态（Story 上下文注入后正式行的形态）。
        commit_story(&home, fork_commit(&player, "op-s1", "event-s1", "0"), fork_clock()).unwrap();
        let formal = crate::story_store::story_state_scoped(&home, &player, "city:one", "game.romance", "legacy-game.romance").unwrap();
        let formal_before = formal_story_snapshot(&home);
        // 首读：copy-on-read 派生快照与正式一致，派生路径零写入正式面。
        let first = read_preview_story(&home, "preview-fork-a", &json!({"runId":run["runId"]})).unwrap();
        assert_eq!(first["storyRevision"], formal["storyRevision"]);
        assert_eq!(first["state"]["affection"], 1);
        assert_eq!(formal_story_snapshot(&home), formal_before);
        let fork = story_fork_row(&home, "preview-fork-a").unwrap();
        assert_eq!(fork.0, "game.romance");
        assert_eq!(fork.1, "legacy-game.romance");
        assert_eq!(fork.2, formal["storyRevision"].as_str().unwrap());
        assert_eq!(fork.3, "city:one");
        assert_eq!(fork.4, player);
        assert_eq!(serde_json::from_str::<Value>(&fork.5).unwrap(), first);
        // 二读：仍读 Fork 行，正式不动。
        let second = read_preview_story(&home, "preview-fork-a", &json!({"runId":run["runId"]})).unwrap();
        assert_eq!(second, first);
        assert_eq!(formal_story_snapshot(&home), formal_before);
        // 正式侧推进（同一 scope 的正式提交）：Fork 仍持 base 快照，不吸收正式推进。
        let base_revision = formal["storyRevision"].as_str().unwrap().to_string();
        commit_story(&home, fork_commit(&player, "op-s2", "event-s2", &base_revision), fork_clock()).unwrap();
        assert_eq!(crate::story_store::story_state_scoped(&home, &player, "city:one", "game.romance", "legacy-game.romance").unwrap()["state"]["affection"], 2);
        let formal_after_commits = formal_story_snapshot(&home);
        let third = read_preview_story(&home, "preview-fork-a", &json!({"runId":run["runId"]})).unwrap();
        assert_eq!(third["storyRevision"], first["storyRevision"]);
        assert_eq!(third["state"]["affection"], 1);
        assert_eq!(formal_story_snapshot(&home), formal_after_commits);
        // 终态清理幂等：finished 上报删除 Fork 行，重复清理无副作用；
        // 整个 Fork 生命周期前后正式 Story/Clock/Outbox 仅由显式正式提交改变。
        crate::creator_code_game::record_preview_state(&home, &json!({"status":"finished","previewId":"preview-fork-a","gameId":"game.romance"})).unwrap();
        assert!(story_fork_row(&home, "preview-fork-a").is_none());
        forget_story_fork(&home, "preview-fork-a");
        assert!(story_fork_row(&home, "preview-fork-a").is_none());
        assert_eq!(formal_story_snapshot(&home), formal_after_commits);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn story_fork_binding_is_per_preview_and_rejects_foreign_or_formal_runs() {
        let home = home();
        let run_a = start_preview_run(&home, "preview-fork-a", &json!({"cityId":"city:one","gameId":"game.romance"})).unwrap();
        let run_b = start_preview_run(&home, "preview-fork-b", &json!({"cityId":"city:one","gameId":"game.romance"})).unwrap();
        // 防串窗：runId 必须绑定本 Preview 的活跃 Run。
        assert_eq!(read_preview_story(&home, "preview-fork-a", &json!({"runId":run_b["runId"]})).unwrap_err(), "game_run_mismatch");
        assert_eq!(read_preview_story(&home, "preview-fork-a", &json!({"runId":"game-run-missing"})).unwrap_err(), "game_run_not_found");
        assert_eq!(read_preview_story(&home, "preview-fork-a", &json!({})).unwrap_err(), "game_argument_invalid");
        assert_eq!(read_preview_story(&home, "bad id!", &json!({"runId":run_a["runId"]})).unwrap_err(), "game_argument_invalid");
        // 空基线：preview-b 的 scope 无正式行，基线为 "0"。
        let empty = read_preview_story(&home, "preview-fork-b", &json!({"runId":run_b["runId"]})).unwrap();
        assert_eq!(empty["storyRevision"], "0");
        assert_eq!(empty["state"], json!({}));
        assert_eq!(story_fork_row(&home, "preview-fork-b").unwrap().2, "0");
        // 两个 Preview 各持独立 Fork 行，玩家 scope 互不重叠。
        let own = read_preview_story(&home, "preview-fork-a", &json!({"runId":run_a["runId"]})).unwrap();
        assert_eq!(own["storyRevision"], "0");
        assert_ne!(story_fork_row(&home, "preview-fork-a").unwrap().4, story_fork_row(&home, "preview-fork-b").unwrap().4);
        // 绑定校验（§13.1 三元）：残留 Fork 行与请求 scope 不一致时失败关闭。
        let stale = StoryForkScopeV1 { player_id: "player-other".to_string(), city_id: "city:one".to_string(),
            story_id: "game.romance".to_string(), story_run_id: "legacy-game.romance".to_string() };
        assert_eq!(read_story_fork(&home, "preview-fork-b", &stale).unwrap_err(), "game_run_mismatch");
        // 正式 Run 绑到 preview 实例名属异常路径：玩家 scope 非 preview 玩家即失败关闭。
        stop_preview_runs(&home, "preview-fork-a").unwrap();
        assert!(story_fork_row(&home, "preview-fork-a").is_none());
        assert!(story_fork_row(&home, "preview-fork-b").is_some());
        assert_eq!(read_preview_story(&home, "preview-fork-a", &json!({"runId":run_a["runId"]})).unwrap_err(), "game_run_cancelled");
        let formal_run = start_run(&home, "preview-fork-a", &json!({"cityId":"city:one","gameId":"game.romance"})).unwrap();
        assert_eq!(read_preview_story(&home, "preview-fork-a", &json!({"runId":formal_run["runId"]})).unwrap_err(), "game_run_mismatch");
        assert!(story_fork_row(&home, "preview-fork-a").is_none());
        std::fs::remove_dir_all(home).ok();
    }
}
