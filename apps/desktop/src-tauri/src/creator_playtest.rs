//! Playtest lifecycle: release-pinned runs with a single active lease,
//! expiry, client-reported evidence validation and consume-once return
//! context. Studio starts and cancels through the creator dispatch face; the
//! City runtime claims and finishes through the separate runtime face.
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::creator_store::{database, digest, new_id, now_ms, only_keys, valid_id};
use crate::creator_projects::valid_skin_id;
use crate::creator_projects::{MAX_RELEASE_BYTES, MAX_RELEASE_MOUNTS, PLAYTEST_TTL_MS};

const MAX_PLAYTEST_HISTORY: i64 = 64;
const MAX_PLAYTEST_EVIDENCE_BYTES: usize = 8 * 1024;
const MAX_PLAYTEST_COUNTERS: usize = 32;
const MAX_PLAYTEST_TICKS: u64 = 2_000_000;

/// 试玩 gameType 白名单（2026-11-15 飞行泛化切片）：driving 是既有行为，flight 由
/// creator.flight-checkpoint-v1 / city-flight-generic 承接（运行时适配器属下一切片）。
fn valid_playtest_game_type(value: &str) -> bool { matches!(value, "driving" | "flight") }

/// 解析一次试玩的游戏类型（单一来源，start/claim/pending 共用）：
/// - 省略（None）：容忍读 release 冻结的 `gameType`；release 快照现无该字段（或值不在
///   白名单）则视为 `driving` = 既有行为。release 快照 schema 不变。
/// - 显式传参只允许校验：值必须在白名单内；release 冻结值存在且与显式值不一致时
///   fail closed（`creator_playtest_game_type_mismatch`）。显式值永不改写路由结果——
///   路由权威始终是 release 冻结值（不可变的 release 是唯一事实来源）。
fn resolve_playtest_game_type(explicit: Option<&str>, snapshot: &Value) -> Result<&'static str, &'static str> {
    if let Some(game_type) = explicit {
        if !valid_playtest_game_type(game_type) { return Err("creator_request_invalid"); }
    }
    let frozen = snapshot.get("gameType").and_then(Value::as_str).filter(|value| valid_playtest_game_type(value));
    if let (Some(game_type), Some(frozen)) = (explicit, frozen) {
        if game_type != frozen { return Err("creator_playtest_game_type_mismatch"); }
    }
    Ok(match frozen { Some("flight") => "flight", _ => "driving" })
}

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

#[cfg(test)]
pub(crate) fn start_playtest(home: &Path, studio_instance: &str, release_id: &str, expected_project: Option<&str>, expected_revision: Option<u64>) -> Result<Value, &'static str> {
    start_playtest_with_game_type(home, studio_instance, release_id, expected_project, expected_revision, None)
}

/// 可选 `gameType` 的启动入口（2026-11-15）：省略 = 既有行为；显式传参只允许校验
/// （白名单 + 与 release 冻结值一致性），不改写路由结果。桌面 dispatch 面
/// （creator_projects.rs，并行切片领地）接线后，MCP 的 creator_playtest_start
/// 即可透传该参数；当前直接调用方（本 crate 测试/后续 MCP 接线）使用本入口。
pub(crate) fn start_playtest_with_game_type(home: &Path, studio_instance: &str, release_id: &str, expected_project: Option<&str>, expected_revision: Option<u64>, game_type: Option<&str>) -> Result<Value, &'static str> {
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
    // 显式 gameType 只在这里做校验（白名单 + 冻结值一致性）；start 响应保持既有
    // 形状（不新增字段，桌面 handoff 锁步测试逐字节断言），路由值由 claim/pending
    // 响应携带——权威始终是 release 冻结值。
    let resolved_game_type = resolve_playtest_game_type(game_type, &snapshot)?;
    let run_id = new_id("playtest-")?;
    agent_vitals_runtime::logging::log_info("creator_playtest", &format!("start run={run_id} release={release_id} project={project_id} gameType={resolved_game_type} city={:?}", snapshot.get("cityId")));
    tx.execute("INSERT INTO creator_playtest_runs(run_id,release_id,project_id,revision,studio_instance_id,status,active_slot,created_at_ms,expires_at_ms)
        VALUES(?1,?2,?3,?4,?5,'pending',1,?6,?7)", params![run_id,release_id,project_id,revision,studio_instance,now,now.saturating_add(PLAYTEST_TTL_MS)])
        .map_err(|_| "creator_store_unavailable")?;
    tx.execute("DELETE FROM creator_playtest_runs WHERE active_slot IS NULL AND run_id NOT IN (SELECT run_id FROM creator_playtest_runs ORDER BY created_at_ms DESC LIMIT ?1)", [MAX_PLAYTEST_HISTORY])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"runId":run_id,"releaseId":release_id,"projectId":project_id,"revision":revision,"status":"pending"}))
}

pub(crate) fn claim_playtest(home: &Path, city_instance: &str, expected_run: Option<&str>) -> Result<Value, &'static str> {
    if expected_run.is_some_and(|id| !valid_id(id)) { return Err("creator_request_invalid"); }
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
    if expected_run.is_some_and(|expected| expected != run_id) { return Err("creator_playtest_run_mismatch"); }
    agent_vitals_runtime::logging::log_info("creator_playtest", &format!("claim run={run_id} release={release_id} city_instance={city_instance} status={status}"));
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
    if has_city_scope(&snapshot) && expected_run.is_none() { return Err("creator_playtest_run_required"); }
    let city_scope = if has_city_scope(&snapshot) { Some(release_city_scope(home, &snapshot)?) } else { None };
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    // City 侧 handoff 按 gameType 路由 flight/driver（飞行泛化切片）：容忍读 release
    // 冻结值，缺省 driving = 既有行为；driving 路径逐位不变。
    let game_type = resolve_playtest_game_type(None, &snapshot)?;
    // 载具随 release 一起冻结（发布冻结阶段写入）：飞行试玩必须飞这一台 profile，而
    // 不是默认飞机，否则「试玩」验证不到用户发布的那台飞行器。driving 的 release
    // 没有该字段 → null，driving 路径逐位不变；飞行 release 缺载具（phase 4 之前
    // 冻结的旧 release）容忍为空，City 侧退回默认飞机而不是让旧 release 无法试玩。
    let vehicle = match snapshot.get("vehicle").filter(|value| !value.is_null()) {
        None => Value::Null,
        Some(vehicle) => {
            let vehicle_id = vehicle.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())
                .ok_or("creator_release_vehicle_invalid")?;
            if snapshot.get("vehicleId").and_then(Value::as_str) != Some(vehicle_id) {
                return Err("creator_release_vehicle_invalid");
            }
            vehicle.clone()
        }
    };
    let mut response = json!({"runId":run_id,"releaseId":release_id,"projectId":project_id,"revision":revision,"snapshotDigest":snapshot_digest,"skinId":skin_id,
        "gameType":game_type,"vehicle":vehicle,"vehicleId":snapshot.get("vehicleId").cloned().unwrap_or(Value::Null),
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
    agent_vitals_runtime::logging::log_info("creator_playtest", &format!("pending run={run_id} release={release_id} city={:?}", snapshot.get("cityId")));
    let (city, layout) = release_city_scope(home, &snapshot)?;
    let world_package = crate::creator_cities::read_world_package_ref(home, city["cityId"].as_str().ok_or("creator_release_invalid")?)?["worldPackage"].clone();
    Ok(json!({"pending":true,"runId":run_id,"releaseId":release_id,"projectId":project_id,"revision":revision,
        "gameType":resolve_playtest_game_type(None, &snapshot)?,
        "worldRevision":snapshot["worldRevision"],"city":city,"layout":layout,"worldPackage":world_package}))
}

struct PlaytestWorldSnapshot { run_id: String, content_digest: String }
fn playtest_world_snapshots() -> &'static Mutex<HashMap<String, PlaytestWorldSnapshot>> {
    static SNAPSHOTS: OnceLock<Mutex<HashMap<String, PlaytestWorldSnapshot>>> = OnceLock::new();
    SNAPSHOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_playtest_city(home: &Path, run_id: &str) -> Result<(String, Value), &'static str> {
    if !valid_id(run_id) { return Err("creator_request_invalid"); }
    let db = database(home)?;
    let row: Option<(String, String, String, u64, String, String)> = db.query_row(
        "SELECT r.release_id,r.status,r.project_id,r.revision,c.snapshot_json,c.snapshot_digest FROM creator_playtest_runs r JOIN creator_releases c ON c.release_id=r.release_id WHERE r.active_slot=1 AND r.run_id=?1", [run_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))).optional().map_err(|_| "creator_store_unavailable")?;
    let (_release_id, status, project_id, revision, raw, snapshot_digest) = row.ok_or("creator_playtest_not_found")?;
    if status != "pending" { return Err("creator_playtest_not_pending"); }
    if raw.len() > MAX_RELEASE_BYTES || digest(&raw) != snapshot_digest { return Err("creator_release_digest_mismatch"); }
    let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    if snapshot.get("projectId").and_then(Value::as_str) != Some(&project_id)
        || snapshot.get("revision").and_then(Value::as_u64) != Some(revision) { return Err("creator_release_invalid"); }
    let (city, _) = release_city_scope(home, &snapshot)?;
    Ok((city["cityId"].as_str().ok_or("creator_release_invalid")?.to_owned(), city))
}

/// Open the frozen city's installed world package for this pending run only.
/// The package bytes remain inside the host snapshot service and are streamed
/// by declared relative path; no filesystem path is returned to City.
pub(crate) fn open_playtest_world_snapshot(home: &Path, instance: &str, run_id: &str) -> Result<Value, &'static str> {
    let (city_id, _) = active_playtest_city(home, run_id)?;
    let reference = crate::creator_cities::read_world_package_ref(home, &city_id)?["worldPackage"].clone();
    if reference.is_null() { return Err("content_package_not_found"); }
    let package_id = reference["packageId"].as_str().ok_or("content_store_corrupt")?;
    let version = reference["version"].as_str().ok_or("content_store_corrupt")?;
    let expected_digest = reference["contentDigest"].as_str().ok_or("content_store_corrupt")?;
    let opened = crate::creator_content_install::open_content_snapshot(home, instance, package_id, version)?;
    let snapshot_id = opened["snapshotId"].as_str().ok_or("content_snapshot_invalid")?;
    if opened["manifest"]["contentDigest"].as_str() != Some(expected_digest) {
        let _ = crate::creator_content_install::close_content_snapshot(home, instance, snapshot_id);
        return Err("content_store_corrupt");
    }
    let mut snapshots = playtest_world_snapshots().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    snapshots.retain(|_, snapshot| snapshot.run_id == run_id);
    snapshots.insert(snapshot_id.to_owned(), PlaytestWorldSnapshot { run_id: run_id.to_owned(), content_digest: expected_digest.to_owned() });
    Ok(json!({"snapshotId":snapshot_id,"manifest":opened["manifest"],"worldPackage":reference}))
}

pub(crate) fn read_playtest_world_snapshot(home: &Path, instance: &str, run_id: &str, snapshot_id: &str, path: &str, offset: u64) -> Result<Value, &'static str> {
    let (_, _) = active_playtest_city(home, run_id)?;
    let expected_digest = {
        let snapshots = playtest_world_snapshots().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot = snapshots.get(snapshot_id).filter(|snapshot| snapshot.run_id == run_id).ok_or("content_snapshot_expired")?;
        snapshot.content_digest.clone()
    };
    let result = crate::creator_content_install::read_content_snapshot(home, instance, snapshot_id, path, offset)?;
    if result["contentDigest"].as_str() != Some(expected_digest.as_str()) { return Err("content_store_corrupt"); }
    Ok(result)
}

pub(crate) fn close_playtest_world_snapshot(home: &Path, instance: &str, run_id: &str, snapshot_id: &str) -> Result<Value, &'static str> {
    let mut snapshots = playtest_world_snapshots().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !snapshots.get(snapshot_id).is_some_and(|snapshot| snapshot.run_id == run_id) { return Err("content_snapshot_expired"); }
    snapshots.remove(snapshot_id);
    crate::creator_content_install::close_content_snapshot(home, instance, snapshot_id)
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
    agent_vitals_runtime::logging::log_info("creator_playtest", &format!("cancel run={run_id} studio={studio_instance} status={status}"));
    if owner != studio_instance { return Err("creator_playtest_instance_mismatch"); }
    if matches!(status.as_str(), "completed" | "cancelled" | "failed" | "expired") {
        return Ok(json!({"runId":run_id,"projectId":project_id,"revision":revision,"status":status,"cancelled":false}));
    }
    tx.execute("UPDATE creator_playtest_runs SET status='cancelled',active_slot=NULL,finished_at_ms=?1 WHERE run_id=?2", params![now,run_id])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"runId":run_id,"projectId":project_id,"revision":revision,"status":"cancelled","cancelled":true}))
}

#[cfg(test)]
mod flight_handoff_tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn home() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let home = std::env::temp_dir().join(format!("creator-playtest-flight-{}-{}",
            std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    /// 直接写入一条满足 start_playtest 校验的 release 行（走完整项目链路属于
    /// creator_projects.rs 领地；这里只覆盖 playtest 层的 gameType 语义）。
    fn store_release(home: &Path, release_id: &str, revision: u64, snapshot: &Value) {
        let raw = serde_json::to_string(snapshot).unwrap();
        let db = database(home).unwrap();
        db.execute("INSERT INTO creator_releases(release_id,project_id,revision,layout_id,world_revision,snapshot_json,snapshot_digest,created_at_ms)
            VALUES(?1,?2,?3,'layout-1','world-r1',?4,?5,1)", rusqlite::params![release_id, format!("project-{revision}"), revision, raw, digest(&raw)]).unwrap();
    }

    fn release_snapshot(revision: u64, game_type: Option<&str>) -> Value {
        let mut snapshot = json!({"projectId":format!("project-{revision}"),"revision":revision,"game":{"id":"creator.checkpoint-race","version":"1","digest":"sha256:abc"},
            "mounts":[{"mountId":"mount-1"}]});
        if let Some(game_type) = game_type { snapshot["gameType"] = json!(game_type); }
        snapshot
    }

    fn release_snapshot_with_vehicle(revision: u64, vehicle_id: &str) -> Value {
        let mut snapshot = release_snapshot(revision, Some("flight"));
        snapshot["vehicleId"] = json!(vehicle_id);
        snapshot["vehicle"] = json!({"schemaVersion":1,"id":vehicle_id,"label":"Released flier","modelAssetId":null,"flightModel":"fixed-wing",
            "physics":{"massKg":600,"wingAreaM2":12,"thrustN":9000,"maxSpeedMps":110,"dragCoefficient":0.3,"turnRateRps":1.1,"climbRateMps":20,"sinkRateMps":12},
            "bounds":{"halfLengthM":4,"halfWidthM":5,"halfHeightM":1.5},"camera":{"followDistanceM":30,"heightOffsetM":13,"fovDeg":55}});
        snapshot
    }

    #[test]
    fn game_type_resolution_matches_release_freeze_and_validates_explicit_only() {
        // 纯函数语义：容忍读 + 显式仅校验。
        assert_eq!(resolve_playtest_game_type(None, &release_snapshot(0, None)).unwrap(), "driving");
        assert_eq!(resolve_playtest_game_type(None, &release_snapshot(0, Some("flight"))).unwrap(), "flight");
        assert_eq!(resolve_playtest_game_type(None, &release_snapshot(0, Some("bogus"))).unwrap(), "driving");
        assert_eq!(resolve_playtest_game_type(Some("flight"), &release_snapshot(0, None)).unwrap(), "driving");
        assert_eq!(resolve_playtest_game_type(Some("driving"), &release_snapshot(0, Some("driving"))).unwrap(), "driving");
        assert_eq!(resolve_playtest_game_type(Some("flight"), &release_snapshot(0, Some("flight"))).unwrap(), "flight");
        assert_eq!(resolve_playtest_game_type(Some("driving"), &release_snapshot(0, Some("flight"))).unwrap_err(), "creator_playtest_game_type_mismatch");
        assert_eq!(resolve_playtest_game_type(Some("flight"), &release_snapshot(0, Some("driving"))).unwrap_err(), "creator_playtest_game_type_mismatch");
        assert_eq!(resolve_playtest_game_type(Some("bogus"), &release_snapshot(0, None)).unwrap_err(), "creator_request_invalid");
    }

    #[test]
    fn start_accepts_validated_game_type_and_keeps_response_shape() {
        let home = home();
        store_release(&home, "release-flight", 1, &release_snapshot(1, None));
        store_release(&home, "release-other", 6, &release_snapshot(6, None));
        // 显式 gameType 通过校验，但 start 响应保持既有形状（路由值在 claim 响应上）。
        let started = start_playtest_with_game_type(&home, "studio-instance", "release-flight", Some("project-1"), Some(1), Some("flight")).unwrap();
        assert_eq!(started["gameType"], Value::Null);
        // 幂等重入返回同一 run；槽位被占时同一 studio 换 release 必须拒绝（既有语义）。
        let restarted = start_playtest(&home, "studio-instance", "release-flight", Some("project-1"), Some(1)).unwrap();
        assert_eq!(restarted["runId"], started["runId"]);
        assert_eq!(start_playtest(&home, "studio-instance", "release-other", None, None).unwrap_err(), "creator_playtest_active");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn start_rejects_unknown_game_type_before_touching_state() {
        let home = home();
        store_release(&home, "release-bogus", 2, &release_snapshot(2, None));
        assert_eq!(start_playtest_with_game_type(&home, "studio-instance", "release-bogus", None, None, Some("bogus")).unwrap_err(), "creator_request_invalid");
        let db = database(&home).unwrap();
        let runs: i64 = db.query_row("SELECT COUNT(*) FROM creator_playtest_runs", [], |row| row.get(0)).unwrap();
        assert_eq!(runs, 0);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn start_fails_closed_on_frozen_value_mismatch() {
        let home = home();
        store_release(&home, "release-frozen", 3, &release_snapshot(3, Some("flight")));
        assert_eq!(start_playtest_with_game_type(&home, "studio-instance", "release-frozen", None, None, Some("driving")).unwrap_err(), "creator_playtest_game_type_mismatch");
        // 校验通过后路由结果在 claim 响应上：release 冻结 flight → claim gameType flight。
        let started = start_playtest_with_game_type(&home, "studio-instance", "release-frozen", None, None, Some("flight")).unwrap();
        let claimed = claim_playtest(&home, "city-instance", Some(started["runId"].as_str().unwrap())).unwrap();
        assert_eq!(claimed["gameType"], "flight");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn claim_surfaces_release_frozen_game_type() {
        let home = home();
        store_release(&home, "release-claim", 4, &release_snapshot(4, Some("flight")));
        let started = start_playtest(&home, "studio-instance", "release-claim", None, None).unwrap();
        // 非 city-scoped release 的 pending 载荷返回 pending:false（既有行为，城域载荷才
        // 携带 pending 详情）；gameType 路由在 claim 响应上消费。
        let pending = pending_playtest(&home).unwrap();
        assert_eq!(pending["pending"], false);
        // 非 city-scoped release 允许无 runId 认领（既有行为）。
        let claimed = claim_playtest(&home, "city-instance", Some(started["runId"].as_str().unwrap())).unwrap();
        assert_eq!(claimed["gameType"], "flight");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn claim_defaults_to_driving_when_release_has_no_frozen_game_type() {
        let home = home();
        store_release(&home, "release-driving", 5, &release_snapshot(5, None));
        let started = start_playtest(&home, "studio-instance", "release-driving", None, None).unwrap();
        let claimed = claim_playtest(&home, "city-instance", Some(started["runId"].as_str().unwrap())).unwrap();
        assert_eq!(claimed["gameType"], "driving");
        let _ = std::fs::remove_dir_all(home);
    }
    /// 飞行试玩必须把发布的载具 profile 交给 City：试玩验证的是用户发布的那台
    /// 飞行器（物理参数/相机/包围盒），不是默认飞机。载具与 vehicleId 不一致的
    /// 冻结快照按损坏拒绝，而不是悄悄退回默认飞机。
    #[test]
    fn claim_hands_the_frozen_vehicle_to_the_city_runtime() {
        let home = home();
        store_release(&home, "release-vehicle", 7, &release_snapshot_with_vehicle(7, "vehicle-release"));
        let started = start_playtest(&home, "studio-instance", "release-vehicle", None, None).unwrap();
        let claimed = claim_playtest(&home, "city-instance", Some(started["runId"].as_str().unwrap())).unwrap();
        assert_eq!(claimed["gameType"], "flight");
        assert_eq!(claimed["vehicle"]["id"], "vehicle-release");
        assert_eq!(claimed["vehicle"]["physics"]["maxSpeedMps"], 110);
        assert_eq!(claimed["vehicleId"], "vehicle-release");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn claim_rejects_a_vehicle_that_does_not_match_the_frozen_vehicle_id() {
        let home = home();
        let mut snapshot = release_snapshot_with_vehicle(8, "vehicle-a");
        snapshot["vehicleId"] = json!("vehicle-b");
        store_release(&home, "release-mismatch", 8, &snapshot);
        let started = start_playtest(&home, "studio-instance", "release-mismatch", None, None).unwrap();
        assert_eq!(claim_playtest(&home, "city-instance", Some(started["runId"].as_str().unwrap())).unwrap_err(),
            "creator_release_vehicle_invalid");
        let _ = std::fs::remove_dir_all(home);
    }

    /// 旧 release（发布冻结之前）没有载具字段：容忍为空，City 侧退回默认飞机，
    /// 而不是让它们无法试玩；driving release 同样恒为 null。
    #[test]
    fn claim_tolerates_releases_frozen_before_vehicles_and_keeps_driving_vehicle_free() {
        let legacy_home = home();
        let driving_home = home();
        store_release(&legacy_home, "release-legacy", 9, &release_snapshot(9, Some("flight")));
        let started = start_playtest(&legacy_home, "studio-instance", "release-legacy", None, None).unwrap();
        let claimed = claim_playtest(&legacy_home, "city-instance", Some(started["runId"].as_str().unwrap())).unwrap();
        assert_eq!(claimed["gameType"], "flight");
        assert_eq!(claimed["vehicle"], Value::Null);
        store_release(&driving_home, "release-driving", 10, &release_snapshot(10, Some("driving")));
        let started = start_playtest(&driving_home, "studio-instance", "release-driving", None, None).unwrap();
        let claimed = claim_playtest(&driving_home, "city-instance", Some(started["runId"].as_str().unwrap())).unwrap();
        assert_eq!(claimed["gameType"], "driving");
        assert_eq!(claimed["vehicle"], Value::Null);
        let _ = std::fs::remove_dir_all(legacy_home);
        let _ = std::fs::remove_dir_all(driving_home);
    }

}
