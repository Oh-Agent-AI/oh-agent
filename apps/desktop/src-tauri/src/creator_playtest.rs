//! Playtest lifecycle: release-pinned runs with a single active lease,
//! expiry, client-reported evidence validation and consume-once return
//! context. Studio starts and cancels through the creator dispatch face; the
//! City runtime claims and finishes through the separate runtime face.
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;

use crate::creator_store::{database, digest, new_id, now_ms, only_keys, valid_id};
use crate::creator_projects::valid_skin_id;
use crate::creator_projects::{MAX_RELEASE_BYTES, MAX_RELEASE_MOUNTS, PLAYTEST_TTL_MS};

const MAX_PLAYTEST_HISTORY: i64 = 64;
const MAX_PLAYTEST_EVIDENCE_BYTES: usize = 8 * 1024;
const MAX_PLAYTEST_COUNTERS: usize = 32;
const MAX_PLAYTEST_TICKS: u64 = 2_000_000;

/// playtest 行查询的投影元组（clippy type_complexity 别名；字段次序跟随各 SELECT）。
type PlaytestClaimRow = (String, String, String, u64, String, Option<String>, String);
type PlaytestResultRow = (String, Option<String>, String, String, u64, Option<u64>, u64, String, Option<String>, Option<String>);
type PlaytestReturnRow = (String, String, u64, String, Option<String>, Option<String>);
type PlaytestReadRow = (String, String, String, u64, String, u64, Option<u64>, Option<String>, Option<String>);

/// Resolves the immutable city revision + scoped layout frozen into a release.
/// A city-scoped release must never fall back to the active legacy City or to a
/// layout from another City/revision.
fn release_city_scope(home: &Path, snapshot: &Value) -> Result<(Value, Value), &'static str> {
    let city_id = snapshot.get("cityId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_release_invalid")?;
    let city_revision = snapshot.get("cityRevision").and_then(Value::as_u64).filter(|revision| *revision <= i64::MAX as u64).ok_or("creator_release_invalid")?;
    let world_revision = snapshot.get("worldRevision").and_then(Value::as_str).filter(|revision| !revision.is_empty() && revision.len() <= 256).ok_or("creator_release_invalid")?;
    let layout_id = snapshot.get("cityLayoutId").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 256).ok_or("creator_release_invalid")?;
    if snapshot.get("layoutId").and_then(Value::as_str) != Some(layout_id) { return Err("creator_release_invalid"); }
    let city = crate::creator_cities::read_city_revision(home, city_id, city_revision)?;
    let layout = crate::creator_city_patch::read_scoped_city_layout(home, city_id, city_revision, world_revision, layout_id)?;
    if city["cityId"].as_str() != Some(city_id) || city["revision"].as_u64() != Some(city_revision) { return Err("creator_release_invalid"); }
    if city["seed"] != layout["seed"] { return Err("creator_release_invalid"); }
    if layout["worldRevision"].as_str() != Some(world_revision) || layout["layout"]["id"].as_str() != Some(layout_id) { return Err("creator_release_invalid"); }
    Ok((city, layout))
}

fn has_city_scope(snapshot: &Value) -> bool { snapshot.get("cityId").is_some_and(|value| !value.is_null()) }

fn expire_playtests(tx: &rusqlite::Transaction<'_>, now: u64) -> Result<(), &'static str> {
    tx.execute("UPDATE creator_playtest_runs SET status='expired',active_slot=NULL,finished_at_ms=?1 WHERE active_slot=1 AND expires_at_ms<=?1", [now])
        .map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

pub(crate) fn start_playtest(home: &Path, studio_instance: &str, release_id: &str, expected_project: Option<&str>, expected_revision: Option<u64>) -> Result<Value, &'static str> {
    if !valid_id(studio_instance) || !valid_id(release_id) { return Err("creator_request_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let now = now_ms();
    expire_playtests(&tx, now)?;
    let active: Option<(String, String, String, u64, String)> = tx.query_row("SELECT run_id,release_id,studio_instance_id,revision,project_id FROM creator_playtest_runs WHERE active_slot=1", [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).optional().map_err(|_| "creator_store_unavailable")?;
    if let Some((run_id, active_release, active_studio, active_revision, active_project)) = active {
        if active_release == release_id && active_studio == studio_instance {
            if expected_project.is_some_and(|expected| expected != active_project) { return Err("creator_release_project_mismatch"); }
            if expected_revision.is_some_and(|expected| expected != active_revision) { return Err("creator_release_revision_mismatch"); }
            tx.commit().map_err(|_| "creator_store_unavailable")?;
            return Ok(json!({"runId":run_id,"releaseId":release_id,"projectId":active_project,"revision":active_revision,"status":"pending"}));
        }
        return Err("creator_playtest_active");
    }
    let (project_id, revision, raw): (String, u64, String) = tx.query_row("SELECT project_id,revision,snapshot_json FROM creator_releases WHERE release_id=?1", [release_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_release_not_found")?;
    // MCP 契约（设计 §6.3）：调用方显式声明意图范围，归属不符直接拒绝——
    // 防止 releaseId 串项目，或对旧 revision 的 release 误启动试玩。
    if let Some(expected) = expected_project {
        if project_id != expected { return Err("creator_release_project_mismatch"); }
    }
    if let Some(expected) = expected_revision {
        if revision != expected { return Err("creator_release_revision_mismatch"); }
    }
    if raw.len() > MAX_RELEASE_BYTES { return Err("creator_release_invalid"); }
    let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    if snapshot.get("projectId").and_then(Value::as_str) != Some(&project_id)
        || snapshot.get("revision").and_then(Value::as_u64) != Some(revision)
        || !snapshot.get("game").is_some_and(Value::is_object)
        || !snapshot.get("mounts").is_some_and(Value::is_array) { return Err("creator_release_invalid"); }
    if has_city_scope(&snapshot) { release_city_scope(home, &snapshot)?; }
    let run_id = new_id("playtest-")?;
    tx.execute("INSERT INTO creator_playtest_runs(run_id,release_id,project_id,revision,studio_instance_id,status,active_slot,created_at_ms,expires_at_ms)
        VALUES(?1,?2,?3,?4,?5,'pending',1,?6,?7)", params![run_id,release_id,project_id,revision,studio_instance,now,now.saturating_add(PLAYTEST_TTL_MS)])
        .map_err(|_| "creator_store_unavailable")?;
    tx.execute("DELETE FROM creator_playtest_runs WHERE active_slot IS NULL AND run_id NOT IN (SELECT run_id FROM creator_playtest_runs ORDER BY created_at_ms DESC LIMIT ?1)", [MAX_PLAYTEST_HISTORY])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"runId":run_id,"releaseId":release_id,"projectId":project_id,"revision":revision,"status":"pending"}))
}

pub(crate) fn claim_playtest(home: &Path, city_instance: &str) -> Result<Value, &'static str> {
    if !valid_id(city_instance) { return Err("creator_request_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let now = now_ms();
    expire_playtests(&tx, now)?;
    let row: Option<PlaytestClaimRow> = tx.query_row(
        "SELECT run_id,release_id,project_id,revision,studio_instance_id,city_instance_id,status FROM creator_playtest_runs WHERE active_slot=1", [],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let (run_id, release_id, project_id, revision, _studio_instance, claimed_city, status) = row.ok_or("creator_playtest_not_found")?;
    if status == "claimed" && claimed_city.as_deref() != Some(city_instance) { return Err("creator_playtest_claimed"); }
    if status != "pending" && status != "claimed" { return Err("creator_playtest_not_found"); }
    if status == "pending" {
        tx.execute("UPDATE creator_playtest_runs SET status='claimed',city_instance_id=?1 WHERE run_id=?2 AND status='pending'", params![city_instance,run_id])
            .map_err(|_| "creator_store_unavailable")?;
    }
    let (raw, snapshot_digest): (String, String) = tx.query_row("SELECT snapshot_json,snapshot_digest FROM creator_releases WHERE release_id=?1", [&release_id], |row| Ok((row.get(0)?,row.get(1)?)))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_release_not_found")?;
    if raw.len() > MAX_RELEASE_BYTES { return Err("creator_release_invalid"); }
    if digest(&raw) != snapshot_digest { return Err("creator_release_digest_mismatch"); }
    let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    if snapshot.get("projectId").and_then(Value::as_str) != Some(&project_id)
        || snapshot.get("revision").and_then(Value::as_u64) != Some(revision)
        || !snapshot.get("game").is_some_and(Value::is_object)
        || !snapshot.get("mounts").and_then(Value::as_array).is_some_and(|mounts| !mounts.is_empty() && mounts.len() <= MAX_RELEASE_MOUNTS) {
        return Err("creator_release_invalid");
    }
    let skin_id = snapshot.get("skinId").cloned().unwrap_or(Value::Null);
    if !skin_id.is_null() && !skin_id.as_str().is_some_and(valid_skin_id) { return Err("creator_release_invalid"); }
    let city_scope = if has_city_scope(&snapshot) { Some(release_city_scope(home, &snapshot)?) } else { None };
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    let mut response = json!({"runId":run_id,"releaseId":release_id,"projectId":project_id,"revision":revision,"snapshotDigest":snapshot_digest,"skinId":skin_id,
        "game":snapshot["game"],"mounts":snapshot["mounts"],
        "scene":snapshot.get("scene").cloned().unwrap_or_else(|| json!({"schemaVersion":1,"objects":[]})),
        "assets":snapshot.get("assets").cloned().unwrap_or_else(|| json!({"schemaVersion":1,"entries":[]})),
        "assetRefs":snapshot.get("assetRefs").cloned().unwrap_or_else(|| json!([])),
        "returnContext":{"projectId":project_id,"revision":revision}});
    if let Some((city, layout)) = city_scope {
        response["city"] = city;
        response["layout"] = layout;
        response["worldRevision"] = snapshot["worldRevision"].clone();
    }
    Ok(response)
}

/// Pre-claim descriptor for the City runtime: read the active run and, when it
/// is city-scoped, return the frozen city revision + layout without claiming or
/// mutating the run. The City plugin loads this transient city, then claims and
/// validates the release against the resulting layout view.
pub(crate) fn pending_playtest(home: &Path) -> Result<Value, &'static str> {
    let db = database(home)?;
    let active: Option<(String, String, String, u64, String)> = db.query_row(
        "SELECT run_id,release_id,project_id,revision,status FROM creator_playtest_runs WHERE active_slot=1", [],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional().map_err(|_| "creator_store_unavailable")?;
    let Some((run_id, release_id, project_id, revision, _status)) = active else { return Ok(json!({"pending":false})) };
    let (raw, snapshot_digest): (String, String) = db.query_row("SELECT snapshot_json,snapshot_digest FROM creator_releases WHERE release_id=?1", [&release_id],
        |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_release_not_found")?;
    if raw.len() > MAX_RELEASE_BYTES || digest(&raw) != snapshot_digest { return Err("creator_release_digest_mismatch"); }
    let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    if snapshot.get("projectId").and_then(Value::as_str) != Some(&project_id) || snapshot.get("revision").and_then(Value::as_u64) != Some(revision) {
        return Err("creator_release_invalid");
    }
    if !has_city_scope(&snapshot) { return Ok(json!({"pending":false})); }
    let (city, layout) = release_city_scope(home, &snapshot)?;
    Ok(json!({"pending":true,"runId":run_id,"releaseId":release_id,"projectId":project_id,"revision":revision,
        "worldRevision":snapshot["worldRevision"],"city":city,"layout":layout}))
}

fn validate_playtest_evidence(value: &Value, status: &str, release_id: &str, revision: u64, snapshot_digest: &str, snapshot: &Value) -> Result<String, &'static str> {
    let snapshot_json = serde_json::to_string(snapshot).map_err(|_| "creator_release_invalid")?;
    if digest(&snapshot_json) != snapshot_digest { return Err("creator_release_digest_mismatch"); }
    let evidence = value.as_object().filter(|object| object.len() == 12 && only_keys(object, &[
        "schemaVersion","runtimeVersion","releaseId","projectRevision","snapshotDigest","worldRevision","seed","game","tick","counters","outcome","reasonCode",
    ])).ok_or("creator_playtest_evidence_invalid")?;
    if evidence.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || evidence.get("runtimeVersion").and_then(Value::as_str) != Some("city-mini-game-runtime-v1")
        || evidence.get("releaseId").and_then(Value::as_str) != Some(release_id)
        || evidence.get("projectRevision").and_then(Value::as_u64) != Some(revision)
        || evidence.get("snapshotDigest").and_then(Value::as_str) != Some(snapshot_digest)
        || evidence.get("worldRevision").and_then(Value::as_str) != snapshot.get("worldRevision").and_then(Value::as_str)
        || evidence.get("seed").and_then(Value::as_u64).is_none_or(|seed| seed > u32::MAX as u64)
        || evidence.get("tick").and_then(Value::as_u64).is_none_or(|tick| tick > MAX_PLAYTEST_TICKS) {
        return Err("creator_playtest_evidence_invalid");
    }
    let game = evidence.get("game").and_then(Value::as_object)
        .filter(|game| game.len() == 3 && only_keys(game, &["id","version","digest"]))
        .ok_or("creator_playtest_evidence_invalid")?;
    let game_id = game.get("id").and_then(Value::as_str).filter(|value| valid_id(value)).ok_or("creator_playtest_evidence_invalid")?;
    let game_version = game.get("version").and_then(Value::as_str).filter(|value| valid_id(value)).ok_or("creator_playtest_evidence_invalid")?;
    let game_digest = game.get("digest").and_then(Value::as_str).filter(|value| value.len() <= 256).ok_or("creator_playtest_evidence_invalid")?;
    let release_game_id = snapshot.get("game").and_then(|game| game.get("id")).and_then(Value::as_str);
    let game_ref_matches = snapshot.get("mounts").and_then(Value::as_array).is_some_and(|mounts| mounts.iter().any(|mount|
        mount.get("game").is_some_and(|reference| reference.get("id").and_then(Value::as_str) == Some(game_id)
            && reference.get("version").and_then(Value::as_str) == Some(game_version)
            && reference.get("digest").and_then(Value::as_str) == Some(game_digest))));
    if release_game_id != Some(game_id) || !game_ref_matches { return Err("creator_playtest_evidence_mismatch"); }
    let counters = evidence.get("counters").and_then(Value::as_object).filter(|counters| counters.len() <= MAX_PLAYTEST_COUNTERS)
        .ok_or("creator_playtest_evidence_invalid")?;
    if counters.iter().any(|(key, value)| !valid_id(key) || value.as_u64().is_none_or(|count| count > u32::MAX as u64)) {
        return Err("creator_playtest_evidence_invalid");
    }
    if !matches!(evidence.get("outcome"), Some(Value::Null))
        && !matches!(evidence.get("outcome").and_then(Value::as_str), Some("success" | "failure")) {
        return Err("creator_playtest_evidence_invalid");
    }
    let outcome = evidence.get("outcome").and_then(Value::as_str);
    if (status == "completed" && outcome != Some("success"))
        || (status == "failed" && outcome == Some("success")) {
        return Err("creator_playtest_evidence_mismatch");
    }
    if !matches!(evidence.get("reasonCode"), Some(Value::Null))
        && !evidence.get("reasonCode").and_then(Value::as_str).is_some_and(valid_id) {
        return Err("creator_playtest_evidence_invalid");
    }
    let serialized = serde_json::to_string(value).map_err(|_| "creator_playtest_evidence_invalid")?;
    if serialized.len() > MAX_PLAYTEST_EVIDENCE_BYTES { return Err("creator_playtest_evidence_too_large"); }
    Ok(serialized)
}

pub(crate) fn finish_playtest(home: &Path, city_instance: &str, run_id: &str, status: &str, evidence: Option<&Value>, failure_code: Option<&str>) -> Result<Value, &'static str> {
    if !valid_id(city_instance) || !valid_id(run_id) || !matches!(status,"completed"|"cancelled"|"failed") { return Err("creator_request_invalid"); }
    if failure_code.is_some_and(|code| !valid_id(code)) || (status != "failed" && failure_code.is_some()) { return Err("creator_request_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let row: Option<PlaytestResultRow> = tx.query_row(
        "SELECT status,city_instance_id,run_id,project_id,revision,finished_at_ms,expires_at_ms,release_id,evidence_json,failure_code FROM creator_playtest_runs WHERE run_id=?1", [run_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let (current, city, run_id, project_id, revision, finished_at, expires_at, release_id, existing_evidence, existing_failure_code) = row.ok_or("creator_playtest_not_found")?;
    if city.as_deref() != Some(city_instance) { return Err("creator_playtest_instance_mismatch"); }
    if matches!(current.as_str(),"completed"|"cancelled"|"failed") {
        if current != status { return Err("creator_playtest_terminal"); }
        if failure_code.is_some() && failure_code != existing_failure_code.as_deref() { return Err("creator_playtest_terminal"); }
        if let Some(value) = evidence {
            let (raw, snapshot_digest): (String,String) = tx.query_row("SELECT snapshot_json,snapshot_digest FROM creator_releases WHERE release_id=?1", [&release_id], |row| Ok((row.get(0)?,row.get(1)?)))
                .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_release_not_found")?;
            let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
            if Some(validate_playtest_evidence(value, status, &release_id, revision, &snapshot_digest, &snapshot)?.as_str()) != existing_evidence.as_deref() {
                return Err("creator_playtest_terminal");
            }
        }
        tx.commit().map_err(|_| "creator_store_unavailable")?;
        return Ok(json!({"runId":run_id,"projectId":project_id,"revision":revision,"status":current,"finishedAtMs":finished_at,"failureCode":existing_failure_code}));
    }
    if current != "claimed" { return Err("creator_playtest_not_claimed"); }
    let finished_at = now_ms();
    if expires_at <= finished_at {
        tx.execute("UPDATE creator_playtest_runs SET status='expired',active_slot=NULL,finished_at_ms=?1 WHERE run_id=?2", params![finished_at,run_id])
            .map_err(|_| "creator_store_unavailable")?;
        tx.commit().map_err(|_| "creator_store_unavailable")?;
        return Err("creator_playtest_expired");
    }
    let evidence_json = if let Some(value) = evidence {
        let (raw, snapshot_digest): (String,String) = tx.query_row("SELECT snapshot_json,snapshot_digest FROM creator_releases WHERE release_id=?1", [&release_id], |row| Ok((row.get(0)?,row.get(1)?)))
            .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_release_not_found")?;
        let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
        Some(validate_playtest_evidence(value, status, &release_id, revision, &snapshot_digest, &snapshot)?)
    } else { None };
    if status == "completed" && evidence_json.is_none() { return Err("creator_playtest_evidence_required"); }
    tx.execute("UPDATE creator_playtest_runs SET status=?1,active_slot=NULL,finished_at_ms=?2,evidence_json=?3,failure_code=?4 WHERE run_id=?5", params![status,finished_at,evidence_json,failure_code,run_id])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"runId":run_id,"projectId":project_id,"revision":revision,"status":status,"finishedAtMs":finished_at,"failureCode":failure_code}))
}

pub(crate) fn take_playtest_return(home: &Path) -> Result<Value, &'static str> {
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let row: Option<PlaytestReturnRow> = tx.query_row("SELECT run_id,project_id,revision,status,evidence_json,failure_code FROM creator_playtest_runs
        WHERE active_slot IS NULL AND return_consumed=0 AND status IN ('completed','cancelled','failed') ORDER BY finished_at_ms DESC LIMIT 1", [],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional().map_err(|_| "creator_store_unavailable")?;
    if let Some((run_id,project_id,revision,status,evidence_json,failure_code)) = row {
        tx.execute("UPDATE creator_playtest_runs SET return_consumed=1 WHERE return_consumed=0 AND status IN ('completed','cancelled','failed')", [])
            .map_err(|_| "creator_store_unavailable")?;
        tx.commit().map_err(|_| "creator_store_unavailable")?;
        let evidence = evidence_json.map(|raw| serde_json::from_str::<Value>(&raw).map_err(|_| "creator_store_unavailable")).transpose()?.unwrap_or(Value::Null);
        return Ok(json!({"runId":run_id,"projectId":project_id,"revision":revision,"status":status,"evidence":evidence,"failureCode":failure_code}));
    }
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(Value::Null)
}

pub(crate) fn list_playtest_history(home: &Path, project_id: &str, limit: u64) -> Result<Value, &'static str> {
    if !valid_id(project_id) || !(1..=32).contains(&limit) { return Err("creator_request_invalid"); }
    let db = database(home)?;
    let mut statement = db.prepare("SELECT run_id,release_id,revision,status,created_at_ms,finished_at_ms,evidence_json,failure_code
        FROM creator_playtest_runs WHERE project_id=?1 ORDER BY created_at_ms DESC,run_id ASC LIMIT ?2")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![project_id,limit], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,u64>(2)?,
        row.get::<_,String>(3)?,row.get::<_,u64>(4)?,row.get::<_,Option<u64>>(5)?,row.get::<_,Option<String>>(6)?,row.get::<_,Option<String>>(7)?)))
        .map_err(|_| "creator_store_unavailable")?;
    let mut runs = Vec::new();
    for row in rows {
        let (run_id,release_id,revision,status,created_at_ms,finished_at_ms,evidence_json,failure_code) = row.map_err(|_| "creator_store_unavailable")?;
        let evidence = evidence_json.map(|raw| serde_json::from_str::<Value>(&raw).map_err(|_| "creator_store_unavailable")).transpose()?.unwrap_or(Value::Null);
        runs.push(json!({"runId":run_id,"releaseId":release_id,"revision":revision,"status":status,"createdAtMs":created_at_ms,
            "finishedAtMs":finished_at_ms,"evidenceSource":if evidence.is_null() { Value::Null } else { json!("city-client-reported") },"evidence":evidence,"failureCode":failure_code}));
    }
    Ok(json!({"projectId":project_id,"runs":runs}))
}

/// MCP 试玩闭环（设计 §6.3）：按 runId 读取单次结果的有界摘要。
pub(crate) fn read_playtest_result(home: &Path, run_id: &str) -> Result<Value, &'static str> {
    if !valid_id(run_id) { return Err("creator_request_invalid"); }
    let db = database(home)?;
    let row: Option<PlaytestReadRow> = db.query_row(
        "SELECT run_id,release_id,project_id,revision,status,created_at_ms,finished_at_ms,evidence_json,failure_code FROM creator_playtest_runs WHERE run_id=?1", [run_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let Some((run_id,release_id,project_id,revision,status,created_at_ms,finished_at_ms,evidence_json,failure_code)) = row else {
        return Err("creator_playtest_not_found");
    };
    let evidence = evidence_json.map(|raw| serde_json::from_str::<Value>(&raw).map_err(|_| "creator_store_unavailable")).transpose()?.unwrap_or(Value::Null);
    Ok(json!({"runId":run_id,"releaseId":release_id,"projectId":project_id,"revision":revision,"status":status,
        "createdAtMs":created_at_ms,"finishedAtMs":finished_at_ms,
        "evidenceSource":if evidence.is_null() { Value::Null } else { json!("city-client-reported") },"evidence":evidence,"failureCode":failure_code}))
}

/// 取消一次试玩：pending/claimed 都可以取消并释放活动槽位（claimed 时 City 的
/// 下一次 finish 会得到干净的终态拒绝）；已终态的 run 幂等返回原状态，不重复取消。
pub(crate) fn cancel_playtest(home: &Path, studio_instance: &str, run_id: &str) -> Result<Value, &'static str> {
    if !valid_id(studio_instance) || !valid_id(run_id) { return Err("creator_request_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let now = now_ms();
    expire_playtests(&tx, now)?;
    let row: Option<(String,String,u64,String)> = tx.query_row(
        "SELECT status,studio_instance_id,revision,project_id FROM creator_playtest_runs WHERE run_id=?1", [run_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let Some((status,owner,revision,project_id)) = row else { return Err("creator_playtest_not_found"); };
    if owner != studio_instance { return Err("creator_playtest_instance_mismatch"); }
    if matches!(status.as_str(), "completed" | "cancelled" | "failed" | "expired") {
        return Ok(json!({"runId":run_id,"projectId":project_id,"revision":revision,"status":status,"cancelled":false}));
    }
    tx.execute("UPDATE creator_playtest_runs SET status='cancelled',active_slot=NULL,finished_at_ms=?1 WHERE run_id=?2", params![now,run_id])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"runId":run_id,"projectId":project_id,"revision":revision,"status":"cancelled","cancelled":true}))
}
