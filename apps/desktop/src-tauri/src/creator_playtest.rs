//! Playtest lifecycle: release-pinned runs with a single active lease,
//! expiry, client-reported evidence validation and consume-once return
//! context. Studio starts and cancels through the creator dispatch face; the
//! City runtime claims and finishes through the separate runtime face.
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::creator_store::{database, digest, new_id, now_ms, only_keys, read_creator_artifact, valid_id, CreatorArtifactKind};
use crate::rule_replay;
use crate::creator_projects::valid_skin_id;
use crate::creator_projects::{MAX_RELEASE_BYTES, MAX_RELEASE_MOUNTS, PLAYTEST_TTL_MS};

const MAX_PLAYTEST_HISTORY: i64 = 64;
const MAX_PLAYTEST_EVIDENCE_BYTES: usize = 8 * 1024;
const MAX_PLAYTEST_COUNTERS: usize = 32;
const MAX_PLAYTEST_TICKS: u64 = 2_000_000;

/// 试玩 gameType 白名单（2026-11-15 飞行泛化切片）：driving 是既有行为，flight 由
/// creator.flight-checkpoint-v1 / city-flight-generic 承接（运行时适配器属下一切片）。
fn valid_playtest_game_type(value: &str) -> bool { matches!(value, "driving" | "flight") }

fn add_artifact_identity(response: &mut Value, artifact_id: &str, kind: CreatorArtifactKind) {
    if kind == CreatorArtifactKind::Candidate {
        response["artifactKind"] = json!(kind.as_str());
        response["candidateId"] = json!(artifact_id);
    }
}

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
            let artifact = read_creator_artifact(&tx, release_id)?;
            let mut response = json!({"runId":run_id,"releaseId":release_id,"projectId":active_project,"revision":active_revision,"status":"pending"});
            add_artifact_identity(&mut response, release_id, artifact.kind);
            tx.commit().map_err(|_| "creator_store_unavailable")?;
            return Ok(response);
        }
        return Err("creator_playtest_active");
    }
    let artifact = read_creator_artifact(&tx, release_id)?;
    if artifact.kind == CreatorArtifactKind::Candidate {
        let accepted: Option<String> = tx.query_row("SELECT accepted_release_id FROM creator_candidates WHERE candidate_id=?1", [release_id], |row| row.get::<_,Option<String>>(0))
            .optional().map_err(|_| "creator_store_unavailable")?.flatten();
        if accepted.is_some() { return Err("creator_candidate_already_accepted"); }
    }
    let (project_id, revision, raw) = (artifact.project_id, artifact.revision, artifact.snapshot_json);
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
    let mut response = json!({"runId":run_id,"releaseId":release_id,"projectId":project_id,"revision":revision,"status":"pending"});
    add_artifact_identity(&mut response, release_id, artifact.kind);
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(response)
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
    let artifact = read_creator_artifact(&tx, &release_id)?;
    let (raw, snapshot_digest) = (artifact.snapshot_json, artifact.snapshot_digest);
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
    add_artifact_identity(&mut response, &release_id, artifact.kind);
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
    let artifact = read_creator_artifact(&db, &release_id)?;
    let (raw, snapshot_digest) = (artifact.snapshot_json, artifact.snapshot_digest);
    if raw.len() > MAX_RELEASE_BYTES || digest(&raw) != snapshot_digest { return Err("creator_release_digest_mismatch"); }
    let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    if snapshot.get("projectId").and_then(Value::as_str) != Some(&project_id) || snapshot.get("revision").and_then(Value::as_u64) != Some(revision) {
        return Err("creator_release_invalid");
    }
    if !has_city_scope(&snapshot) { return Ok(json!({"pending":false})); }
    agent_vitals_runtime::logging::log_info("creator_playtest", &format!("pending run={run_id} release={release_id} city={:?}", snapshot.get("cityId")));
    let (city, layout) = release_city_scope(home, &snapshot)?;
    let world_package = crate::creator_cities::read_world_package_ref(home, city["cityId"].as_str().ok_or("creator_release_invalid")?)?["worldPackage"].clone();
    let mut response = json!({"pending":true,"runId":run_id,"releaseId":release_id,"projectId":project_id,"revision":revision,
        "gameType":resolve_playtest_game_type(None, &snapshot)?,
        "worldRevision":snapshot["worldRevision"],"city":city,"layout":layout,"worldPackage":world_package});
    add_artifact_identity(&mut response, &release_id, artifact.kind);
    Ok(response)
}

struct PlaytestWorldSnapshot { run_id: String, content_digest: String }
fn playtest_world_snapshots() -> &'static Mutex<HashMap<String, PlaytestWorldSnapshot>> {
    static SNAPSHOTS: OnceLock<Mutex<HashMap<String, PlaytestWorldSnapshot>>> = OnceLock::new();
    SNAPSHOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_playtest_city(home: &Path, run_id: &str) -> Result<(String, Value), &'static str> {
    if !valid_id(run_id) { return Err("creator_request_invalid"); }
    let db = database(home)?;
    let row: Option<(String, String, String, u64)> = db.query_row(
        "SELECT release_id,status,project_id,revision FROM creator_playtest_runs WHERE active_slot=1 AND run_id=?1", [run_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional().map_err(|_| "creator_store_unavailable")?;
    let (release_id, status, project_id, revision) = row.ok_or("creator_playtest_not_found")?;
    let artifact = read_creator_artifact(&db, &release_id)?;
    let (raw, snapshot_digest) = (artifact.snapshot_json, artifact.snapshot_digest);
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
    // V3 S-6b：evidence 允许可选 `trace` 字段（宿主复算的输入轨迹）。可选 = 12 键
    // （现状不变）或 13 键（含 trace）；trace 形状/预算由 rule_replay 的限制统一校验。
    let evidence = value.as_object().filter(|object| (object.len() == 12 && !object.contains_key("trace")
        || object.len() == 13 && object.contains_key("trace")) && only_keys(object, &[
        "schemaVersion","runtimeVersion","releaseId","projectRevision","snapshotDigest","worldRevision","seed","game","tick","counters","outcome","reasonCode","trace",
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
    if let Some(trace) = evidence.get("trace") {
        rule_replay::parse_trace(trace).map_err(|_| "creator_playtest_evidence_invalid")?;
    }
    let serialized = serde_json::to_string(value).map_err(|_| "creator_playtest_evidence_invalid")?;
    if serialized.len() > MAX_PLAYTEST_EVIDENCE_BYTES { return Err("creator_playtest_evidence_too_large"); }
    Ok(serialized)
}

/// S-6b 宿主复算注记（V3-16 最小路径，RFC §8 S-6 / §9 V3-16）。evidence 带 trace 且
/// 规则可解析时，用 release 冻结的 game.rules 在宿主独立复算 outcome/counters：
/// - 与客户端自报逐项一致 → 注记 evidenceSource=host-verified（读取面据此标记宿主裁决）；
/// - 不一致 → 保留客户端证据原样，另注记 hostDisagreement 供审计（不采信任何一方）；
/// - 复算器 Err（轨迹/规则越出镜像子集）→ 不注记，维持 client-reported 现状。
///   任何分支都不改写客户端证据内容本身，只在落盘副本上追加宿主字段。
fn host_annotate_evidence(value: &Value, snapshot: &Value, client_serialized: String) -> String {
    let Some(trace_value) = value.get("trace") else { return client_serialized; };
    let Ok(trace) = rule_replay::parse_trace(trace_value) else { return client_serialized; };
    let Some(pack) = snapshot.get("game").filter(|game| game.get("rules").is_some_and(Value::is_object)) else { return client_serialized; };
    // mount 选择：game 引用与 evidence 一致、且 bindings 容得下轨迹每个事件序号的
    // 唯一候选才采信其 parameterOverrides；零或多个候选一律退回 pack 默认值（不猜）。
    let game_reference = value.get("game");
    let candidates: Vec<&Value> = snapshot.get("mounts").and_then(Value::as_array).map(|mounts| mounts.iter().filter(|mount| {
        mount.get("game").is_some_and(|reference| ["id", "version", "digest"].iter().all(|field| {
            reference.get(*field).and_then(Value::as_str) == game_reference.and_then(|game| game.get(*field)).and_then(Value::as_str)
        })) && trace_fits_bindings(mount, &trace)
    }).collect()).unwrap_or_default();
    let mut effective = pack.clone();
    if let [mount] = candidates.as_slice() {
        // 把选中 mount 的 overrides 合并进 integerParameters.default：等价 TS runtime 的
        // overrides ?? default 解析次序，让复算器看到「mount 实例化后的规则包」。
        if let (Some(overrides), Some(parameters)) = (mount.get("parameterOverrides").and_then(Value::as_object),
            effective.get_mut("integerParameters").and_then(Value::as_object_mut)) {
            for (name, override_value) in overrides {
                if let Some(spec) = parameters.get_mut(name).and_then(Value::as_object_mut) {
                    if let Some(resolved) = override_value.as_i64().filter(|value| *value >= 0) {
                        spec.insert("default".to_owned(), json!(resolved));
                    }
                }
            }
        }
    }
    let time_limit_ticks = effective.get("integerParameters").and_then(|parameters| parameters.get("timeLimitTicks"))
        .and_then(|spec| spec.get("default")).and_then(Value::as_i64).filter(|value| *value >= 0).unwrap_or(0) as u64;
    let Ok(verdict) = rule_replay::replay_rules(&effective, &trace, time_limit_ticks) else { return client_serialized; };
    let mut annotated = value.clone();
    if rule_replay::verdict_matches_evidence(&verdict, value) {
        annotated["evidenceSource"] = json!("host-verified");
        agent_vitals_runtime::logging::log_info("creator_playtest", "host replay verified settlement evidence");
    } else {
        let host_outcome = verdict.outcome.map(|result| json!(result));  // None → null（与 evidence.outcome 同形）
        let host_counters = serde_json::to_value(&verdict.counters).unwrap_or(Value::Null);
        annotated["hostDisagreement"] = json!({"hostOutcome": host_outcome, "hostCounters": host_counters});
        agent_vitals_runtime::logging::log_info("creator_playtest", "host replay disagreed with client-reported evidence");
    }
    // 注记只增不删；超出证据字节预算时放弃注记，保留客户端原样字节。
    match serde_json::to_string(&annotated) {
        Ok(serialized) if serialized.len() <= MAX_PLAYTEST_EVIDENCE_BYTES => serialized,
        _ => client_serialized,
    }
}

/// 轨迹兼容性：每个事件的 slot 必须落在该 mount 的 bindings 里且序号不越界
/// （TS 输入校验会拒绝越界 index，越界轨迹不可能来自该 mount 的合法运行）。
fn trace_fits_bindings(mount: &Value, trace: &[rule_replay::ReplayEventV1]) -> bool {
    let Some(bindings) = mount.get("bindings").and_then(Value::as_object) else { return trace.is_empty(); };
    trace.iter().all(|event| {
        bindings.get(&event.slot).and_then(Value::as_array).is_some_and(|anchors| (event.event_index as usize) < anchors.len())
    })
}

/// 终态幂等比对用的「客户端视图」：剥掉宿主注记字段（evidenceSource/hostDisagreement
/// 只在首次 finish 落盘时追加），其余字节与客户端重发的 evidence 序列化完全一致。
fn evidence_client_view(stored: &str) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(stored) else { return stored.to_owned(); };
    let Some(object) = parsed.as_object_mut() else { return stored.to_owned(); };
    let annotated = object.remove("evidenceSource").is_some() || object.remove("hostDisagreement").is_some();
    if !annotated { return stored.to_owned(); }
    serde_json::to_string(&parsed).unwrap_or_else(|_| stored.to_owned())
}

/// 读取面的 evidenceSource 分支（V3-16）：落盘 evidence 带 host-verified 注记 → 宿主
/// 裁决；其余非空证据维持 client-reported 自报语义；无证据 → null（现状不变）。
fn evidence_source(evidence: &Value) -> Value {
    if evidence.is_null() { return Value::Null; }
    if evidence.get("evidenceSource").and_then(Value::as_str) == Some("host-verified") { json!("host-verified") } else { json!("city-client-reported") }
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
            let artifact = read_creator_artifact(&tx, &release_id)?;
            let (raw, snapshot_digest) = (artifact.snapshot_json, artifact.snapshot_digest);
            let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
            let fresh = validate_playtest_evidence(value, status, &release_id, revision, &snapshot_digest, &snapshot)?;
            // 幂等比对取「客户端视图」：宿主注记字段不参与比对（见 evidence_client_view）。
            let stored_client_view = existing_evidence.as_deref().map(evidence_client_view);
            if Some(fresh.as_str()) != stored_client_view.as_deref() {
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
        let artifact = read_creator_artifact(&tx, &release_id)?;
        let (raw, snapshot_digest) = (artifact.snapshot_json, artifact.snapshot_digest);
        let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
        let serialized = validate_playtest_evidence(value, status, &release_id, revision, &snapshot_digest, &snapshot)?;
        // S-6b：校验通过后做宿主复算注记（无 trace / 复算不可用时原样落盘）。
        Some(host_annotate_evidence(value, &snapshot, serialized))
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
            "finishedAtMs":finished_at_ms,"evidenceSource":evidence_source(&evidence),"evidence":evidence,"failureCode":failure_code}));
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
        "evidenceSource":evidence_source(&evidence),"evidence":evidence,"failureCode":failure_code}))
}

/// City webview 被销毁（切走、关闭，不是 suspend）后，它认领过的槽位不会再收到
/// finish。pending（还没被这座城认领）留给下一座 City 认领，不在这里收口。
pub(crate) const PLAYTEST_CITY_CLOSED: &str = "creator_playtest_city_closed";

fn close_claimed_playtests(home: &Path, predicate: &str, instance_id: &str) -> Result<bool, &'static str> {
    if !valid_id(instance_id) { return Err("creator_request_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let now = now_ms();
    // predicate 只来自本文件的两个调用点，拼进固定的 claimed 谓词，不接受外部 SQL。
    let sql = format!("UPDATE creator_playtest_runs SET status='failed',active_slot=NULL,finished_at_ms=?1,failure_code=?2 WHERE active_slot=1 AND status='claimed' AND {predicate}");
    let changed = tx.execute(&sql, params![now, PLAYTEST_CITY_CLOSED, instance_id]).map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    if changed > 0 {
        agent_vitals_runtime::logging::log_info("creator_playtest", &format!("city claim closed instance={instance_id} rows={changed} failure={PLAYTEST_CITY_CLOSED}"));
    }
    Ok(changed > 0)
}

pub(crate) fn finalize_retired_city_claim(home: &Path, retired_city_instance: &str) -> Result<bool, &'static str> {
    close_claimed_playtests(home, "city_instance_id=?3", retired_city_instance)
}

/// 新 City 实例创建时，上一进程留下的 claimed 槽位已经没有活着的认领者。
/// 不碰 pending：下一座城还可以认领尚未开跑的试玩。
pub(crate) fn finalize_playtests_claimed_by_other_cities(home: &Path, live_city_instance: &str) -> Result<bool, &'static str> {
    close_claimed_playtests(home, "city_instance_id IS NOT NULL AND city_instance_id<>?3", live_city_instance)
}

/// 新的官方 Studio webview 成为既有 run 的唯一继任者。主人 id 保持不变，
/// 所以原实例仍能取消；第三套实例对不上继任者，取消继续被拒绝。
pub(crate) fn note_current_studio_instance(home: &Path, studio_instance: &str) -> Result<(), &'static str> {
    if !valid_id(studio_instance) { return Err("creator_request_invalid"); }
    let db = database(home)?;
    db.execute("UPDATE creator_playtest_runs SET studio_owner_retired=1, studio_successor_id=?1 WHERE studio_instance_id<>?1", [studio_instance])
        .map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

/// 取消一次试玩：pending/claimed 都可以取消并释放活动槽位（claimed 时 City 的
/// 下一次 finish 会得到干净的终态拒绝）；已终态的 run 对主人或继任者幂等返回，
/// 不重复取消。主人 webview 被换掉之后，只有宿主记下的继任实例可以取消。
pub(crate) fn cancel_playtest(home: &Path, studio_instance: &str, run_id: &str) -> Result<Value, &'static str> {
    if !valid_id(studio_instance) || !valid_id(run_id) { return Err("creator_request_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let now = now_ms();
    expire_playtests(&tx, now)?;
    let row: Option<(String,String,u64,String,i64,Option<String>)> = tx.query_row(
        "SELECT status,studio_instance_id,revision,project_id,studio_owner_retired,studio_successor_id FROM creator_playtest_runs WHERE run_id=?1", [run_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let Some((status,owner,revision,project_id,retired,successor)) = row else { return Err("creator_playtest_not_found"); };
    agent_vitals_runtime::logging::log_info("creator_playtest", &format!("cancel run={run_id} studio={studio_instance} status={status}"));
    let successor_match = retired != 0 && successor.as_deref() == Some(studio_instance);
    if owner != studio_instance && !successor_match { return Err("creator_playtest_instance_mismatch"); }
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

    /// 切走 City 不能把 claimed 槽位留成永远占着的活动行。另一座还活着的 City
    /// 仍然抢不走认领、也 finish 不了；销毁的是认领者自己时，行变成带原因的
    /// failed，槽位放开。尚未认领的 pending 留给下一座城。Studio 换实例后只有
    /// 记下的继任者能取消，第三套实例不行。
    #[test]
    fn replaced_city_claim_becomes_terminal_and_only_the_successor_studio_can_cancel() {
        let home = home();
        store_release(&home, "release-life", 3, &release_snapshot(3, Some("flight")));
        let started = start_playtest(&home, "studio-a", "release-life", None, None).unwrap();
        let run_id = started["runId"].as_str().unwrap().to_owned();
        claim_playtest(&home, "city-a", Some(&run_id)).unwrap();
        assert_eq!(claim_playtest(&home, "city-b", Some(&run_id)).unwrap_err(), "creator_playtest_claimed");
        assert_eq!(finish_playtest(&home, "city-b", &run_id, "failed", None, Some(PLAYTEST_CITY_CLOSED)).unwrap_err(), "creator_playtest_instance_mismatch");
        assert!(!finalize_retired_city_claim(&home, "city-b").unwrap());
        assert_eq!(claim_playtest(&home, "city-b", Some(&run_id)).unwrap_err(), "creator_playtest_claimed");
        assert!(finalize_retired_city_claim(&home, "city-a").unwrap());
        let result = read_playtest_result(&home, &run_id).unwrap();
        assert_eq!(result["status"], "failed");
        assert_eq!(result["failureCode"], PLAYTEST_CITY_CLOSED);
        assert!(result["finishedAtMs"].as_u64().is_some());
        assert_eq!(finish_playtest(&home, "city-b", &run_id, "failed", None, Some(PLAYTEST_CITY_CLOSED)).unwrap_err(), "creator_playtest_instance_mismatch");
        let idempotent = finish_playtest(&home, "city-a", &run_id, "failed", None, Some(PLAYTEST_CITY_CLOSED)).unwrap();
        assert_eq!(idempotent["status"], "failed");
        let again = start_playtest(&home, "studio-a", "release-life", None, None).unwrap();
        let pending_id = again["runId"].as_str().unwrap().to_owned();
        assert_ne!(pending_id, run_id);
        assert!(!finalize_retired_city_claim(&home, "city-a").unwrap());
        assert_eq!(read_playtest_result(&home, &pending_id).unwrap()["status"], "pending");
        assert_eq!(cancel_playtest(&home, "studio-b", &pending_id).unwrap_err(), "creator_playtest_instance_mismatch");
        note_current_studio_instance(&home, "studio-b").unwrap();
        let cancelled = cancel_playtest(&home, "studio-b", &pending_id).unwrap();
        assert_eq!(cancelled["status"], "cancelled");
        assert_eq!(cancelled["cancelled"], true);
        let repeated = cancel_playtest(&home, "studio-b", &pending_id).unwrap();
        assert_eq!(repeated["cancelled"], false);
        assert_eq!(cancel_playtest(&home, "studio-c", &pending_id).unwrap_err(), "creator_playtest_instance_mismatch");
        let third = start_playtest(&home, "studio-a", "release-life", None, None).unwrap();
        let third_id = third["runId"].as_str().unwrap().to_owned();
        note_current_studio_instance(&home, "studio-b").unwrap();
        assert_eq!(cancel_playtest(&home, "studio-c", &third_id).unwrap_err(), "creator_playtest_instance_mismatch");
        claim_playtest(&home, "city-old", Some(&third_id)).unwrap();
        assert!(finalize_playtests_claimed_by_other_cities(&home, "city-new").unwrap());
        assert_eq!(read_playtest_result(&home, &third_id).unwrap()["failureCode"], PLAYTEST_CITY_CLOSED);
        assert_eq!(claim_playtest(&home, "city-new", Some(&third_id)).unwrap_err(), "creator_playtest_not_found");
        assert_eq!(finish_playtest(&home, "city-new", &third_id, "failed", None, Some(PLAYTEST_CITY_CLOSED)).unwrap_err(), "creator_playtest_instance_mismatch");
        let _ = std::fs::remove_dir_all(home);
    }

}

/// S-6b 宿主复算注记的收口测试（V3-16）：checkpoint-race 形状规则 + 构造轨迹。
/// 规则字面量与 rule_replay.rs 测试里的 race_pack 同源，这里专管 finish 路径分支：
/// host-verified / hostDisagreement / Err 不落注记 / 无 trace 原路径。
#[cfg(test)]
mod host_replay_tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn home() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let home = std::env::temp_dir().join(format!("creator-playtest-replay-{}-{}",
            std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    fn store_release(home: &Path, release_id: &str, revision: u64, snapshot: &Value) {
        let raw = serde_json::to_string(snapshot).unwrap();
        let db = database(home).unwrap();
        db.execute("INSERT INTO creator_releases(release_id,project_id,revision,layout_id,world_revision,snapshot_json,snapshot_digest,created_at_ms)
            VALUES(?1,?2,?3,'layout-1','world-r1',?4,?5,1)", rusqlite::params![release_id, format!("project-{revision}"), revision, raw, digest(&raw)]).unwrap();
    }

    fn release_digest(home: &Path, release_id: &str) -> String {
        let db = database(home).unwrap();
        db.query_row("SELECT snapshot_digest FROM creator_releases WHERE release_id=?1", [release_id],
            |row| row.get::<_, String>(0)).unwrap()
    }

    /// checkpoint-race 形状的冻结游戏包（节点序与 runtime.ts 模板一致：先推进后完成）。
    fn race_game() -> Value {
        json!({
            "schemaVersion": 1, "id": "creator.checkpoint-race", "rulesVersion": 1,
            "slots": {"points": {"kind": "zone", "min": 3, "max": 8}},
            "integerParameters": {
                "timeLimitTicks": {"min": 60, "max": 36000, "default": 2700},
                "gateTarget": {"min": 3, "max": 8, "default": 3}
            },
            "rules": {
                "counters": {"next": {"initial": 0, "max": {"parameter": "gateTarget"}}},
                "nodes": [
                    {"id": "start-timer", "on": {"type": "run.started"},
                        "actions": [{"op": "timer.start", "timerId": "timeout", "durationTicks": {"parameter": "timeLimitTicks"}}]},
                    {"id": "advance", "on": {"type": "zone.entered", "slot": "points"},
                        "when": [{"op": "counter.eqEventIndex", "counter": "next"}],
                        "actions": [{"op": "counter.add", "counter": "next", "amount": 1}]},
                    {"id": "finish", "on": {"type": "zone.entered", "slot": "points"},
                        "when": [{"op": "counter.eq", "counter": "next", "value": {"parameter": "gateTarget"}}],
                        "actions": [{"op": "run.finish", "outcome": "success"}]},
                    {"id": "timeout", "on": {"type": "timer.expired", "timerId": "timeout"},
                        "actions": [{"op": "run.finish", "outcome": "failure"}]}
                ]
            }
        })
    }

    fn race_mount(gates: usize, overrides: Value) -> Value {
        let anchors: Vec<String> = (0..gates).map(|index| format!("cp-{index}")).collect();
        json!({"schemaVersion": 1, "mountId": "mount-1", "entryAnchorId": "road-spawn:a",
            "layout": {"kind": "city-layout", "id": "layout-1", "version": "1", "digest": "sha256:layout"},
            "game": {"kind": "city-minigame", "id": "creator.checkpoint-race", "version": "1", "digest": "sha256:abc"},
            "bindings": {"points": anchors}, "parameterOverrides": overrides})
    }

    fn race_release(revision: u64, mounts: Value) -> Value {
        json!({"projectId": format!("project-{revision}"), "revision": revision, "game": race_game(), "mounts": mounts})
    }

    fn gate_trace(events: &[(u64, u64)]) -> Value {
        Value::Array(events.iter().map(|(event_index, at_tick)|
            json!({"kind": "zone.entered", "slot": "points", "eventIndex": event_index, "atTick": at_tick})).collect())
    }

    fn race_evidence(release_id: &str, snapshot_digest: &str, revision: u64, outcome: Value, counters: Value, tick: u64, trace: Option<Value>) -> Value {
        let mut evidence = json!({"schemaVersion": 1, "runtimeVersion": "city-mini-game-runtime-v1", "releaseId": release_id,
            "projectRevision": revision, "snapshotDigest": snapshot_digest, "worldRevision": null, "seed": 7,
            "game": {"id": "creator.checkpoint-race", "version": "1", "digest": "sha256:abc"},
            "tick": tick, "counters": counters, "outcome": outcome, "reasonCode": null});
        if let Some(trace) = trace { evidence["trace"] = trace; }
        evidence
    }

    fn claimed_run(home: &Path, release_id: &str, revision: u64) -> String {
        let started = start_playtest(home, "studio-instance", release_id, Some(&format!("project-{revision}")), Some(revision)).unwrap();
        let run_id = started["runId"].as_str().unwrap().to_owned();
        claim_playtest(home, "city-instance", Some(&run_id)).unwrap();
        run_id
    }

    /// (a) 3 门顺序通过 → 宿主复算与客户端自报一致 → evidenceSource=host-verified。
    #[test]
    fn verified_when_three_gates_trace_matches_client_report() {
        let home = home();
        store_release(&home, "release-race", 1, &race_release(1, json!([race_mount(3, json!({"timeLimitTicks": 2400, "gateTarget": 3}))])));
        let snapshot_digest = release_digest(&home, "release-race");
        let run_id = claimed_run(&home, "release-race", 1);
        let evidence = race_evidence("release-race", &snapshot_digest, 1, json!("success"), json!({"next": 3}), 300,
            Some(gate_trace(&[(0, 100), (1, 200), (2, 300)])));
        finish_playtest(&home, "city-instance", &run_id, "completed", Some(&evidence), None).unwrap();
        let result = read_playtest_result(&home, &run_id).unwrap();
        assert_eq!(result["evidenceSource"], "host-verified");
        assert_eq!(result["evidence"]["outcome"], "success");
        assert_eq!(result["evidence"]["counters"]["next"], 3);
        assert!(result["evidence"].get("hostDisagreement").is_none());
        // 幂等重入：客户端原样重发 evidence（不含宿主注记字段）必须仍然成功。
        let replay = finish_playtest(&home, "city-instance", &run_id, "completed", Some(&evidence), None).unwrap();
        assert_eq!(replay["status"], "completed");
        // 换一份内容不同但状态一致的 evidence 则维持终态拒绝。
        let tampered = race_evidence("release-race", &snapshot_digest, 1, json!("success"), json!({"next": 3}), 301, None);
        assert_eq!(finish_playtest(&home, "city-instance", &run_id, "completed", Some(&tampered), None).unwrap_err(), "creator_playtest_terminal");
        let _ = std::fs::remove_dir_all(home);
    }

    /// (b) 少一门 + 超时 → 轨迹耗尽后剩余计时器触发 failure，与客户端自报一致。
    #[test]
    fn verified_when_timeout_failure_matches_partial_trace() {
        let home = home();
        store_release(&home, "release-race", 2, &race_release(2, json!([race_mount(3, json!({"timeLimitTicks": 2400, "gateTarget": 3}))])));
        let snapshot_digest = release_digest(&home, "release-race");
        let run_id = claimed_run(&home, "release-race", 2);
        let evidence = race_evidence("release-race", &snapshot_digest, 2, json!("failure"), json!({"next": 2}), 2400,
            Some(gate_trace(&[(0, 100), (1, 200)])));
        finish_playtest(&home, "city-instance", &run_id, "failed", Some(&evidence), None).unwrap();
        let result = read_playtest_result(&home, &run_id).unwrap();
        assert_eq!(result["evidenceSource"], "host-verified");
        assert_eq!(result["evidence"]["outcome"], "failure");
        assert_eq!(result["evidence"]["counters"]["next"], 2);
        let _ = std::fs::remove_dir_all(home);
    }

    /// (c) 篡改 client outcome（自称 success 但轨迹只过 1 门）→ hostDisagreement 记录
    /// 宿主结论，evidenceSource 保持 client-reported，客户端证据原样保留。
    #[test]
    fn tampered_outcome_records_disagreement_without_dropping_client_evidence() {
        let home = home();
        store_release(&home, "release-race", 3, &race_release(3, json!([race_mount(3, json!({"timeLimitTicks": 2400, "gateTarget": 3}))])));
        let snapshot_digest = release_digest(&home, "release-race");
        let run_id = claimed_run(&home, "release-race", 3);
        let evidence = race_evidence("release-race", &snapshot_digest, 3, json!("success"), json!({"next": 3}), 300,
            Some(gate_trace(&[(0, 100)])));
        finish_playtest(&home, "city-instance", &run_id, "completed", Some(&evidence), None).unwrap();
        let result = read_playtest_result(&home, &run_id).unwrap();
        assert_eq!(result["evidenceSource"], "city-client-reported");
        let disagreement = &result["evidence"]["hostDisagreement"];
        assert_eq!(disagreement["hostOutcome"], "failure");
        assert_eq!(disagreement["hostCounters"]["next"], 1);
        // 客户端自报内容不被丢弃：outcome/counters 原样落盘供审计比对。
        assert_eq!(result["evidence"]["outcome"], "success");
        assert_eq!(result["evidence"]["counters"]["next"], 3);
        let _ = std::fs::remove_dir_all(home);
    }

    /// (d) 轨迹超界 → 证据在入口被拒；规则含不支持 op → 复算 Err，不落任何宿主注记。
    #[test]
    fn out_of_bounds_trace_is_rejected_and_unsupported_ops_stay_client_reported() {
        let home = home();
        store_release(&home, "release-race", 4, &race_release(4, json!([race_mount(3, json!({"timeLimitTicks": 2400, "gateTarget": 3}))])));
        let snapshot_digest = release_digest(&home, "release-race");
        let run_id = claimed_run(&home, "release-race", 4);
        let overflow: Vec<Value> = (0..65u64).map(|index|
            json!({"kind": "zone.entered", "slot": "points", "eventIndex": index, "atTick": index + 1})).collect();
        let evidence = race_evidence("release-race", &snapshot_digest, 4, json!("success"), json!({"next": 3}), 300, Some(Value::Array(overflow)));
        assert_eq!(finish_playtest(&home, "city-instance", &run_id, "completed", Some(&evidence), None).unwrap_err(),
            "creator_playtest_evidence_invalid");
        // 证据被拒时 run 仍占活动槽位（校验失败不落状态），先取消释放再走下一段。
        cancel_playtest(&home, "studio-instance", &run_id).unwrap();
        // 不支持的 action op：证据合法收下，但复算器 Err → 维持 client-reported 且无分歧注记。
        let mut broken_release = race_release(5, json!([race_mount(3, json!({"timeLimitTicks": 2400, "gateTarget": 3}))]));
        broken_release["game"]["rules"]["nodes"][1]["actions"][0]["op"] = json!("score.add");
        store_release(&home, "release-broken", 5, &broken_release);
        let snapshot_digest = release_digest(&home, "release-broken");
        let run_id = claimed_run(&home, "release-broken", 5);
        let evidence = race_evidence("release-broken", &snapshot_digest, 5, json!("success"), json!({"next": 3}), 300,
            Some(gate_trace(&[(0, 100), (1, 200), (2, 300)])));
        finish_playtest(&home, "city-instance", &run_id, "completed", Some(&evidence), None).unwrap();
        let result = read_playtest_result(&home, &run_id).unwrap();
        assert_eq!(result["evidenceSource"], "city-client-reported");
        assert!(result["evidence"].get("hostDisagreement").is_none());
        assert_eq!(result["evidence"]["trace"].as_array().map(Vec::len), Some(3));
        let _ = std::fs::remove_dir_all(home);
    }

    /// (e) 无 trace 的旧 evidence → 走原路径，client-reported（现状不变）。
    #[test]
    fn legacy_evidence_without_trace_keeps_current_behavior() {
        let home = home();
        store_release(&home, "release-race", 6, &race_release(6, json!([race_mount(3, json!({"timeLimitTicks": 2400, "gateTarget": 3}))])));
        let snapshot_digest = release_digest(&home, "release-race");
        let run_id = claimed_run(&home, "release-race", 6);
        let evidence = race_evidence("release-race", &snapshot_digest, 6, json!("success"), json!({"next": 3}), 300, None);
        finish_playtest(&home, "city-instance", &run_id, "completed", Some(&evidence), None).unwrap();
        let result = read_playtest_result(&home, &run_id).unwrap();
        assert_eq!(result["evidenceSource"], "city-client-reported");
        assert!(result["evidence"].get("hostDisagreement").is_none());
        assert!(result["evidence"].get("evidenceSource").is_none());
        let history = list_playtest_history(&home, "project-6", 8).unwrap();
        assert_eq!(history["runs"][0]["evidenceSource"], "city-client-reported");
        let _ = std::fs::remove_dir_all(home);
    }

    /// mount 的 parameterOverrides 参与复算（合并进 integerParameters.default）：
    /// timeLimitTicks=100 时时限 tick 先触发超时，宿主 verdict 与自称 success 的客户端分歧。
    #[test]
    fn mount_overrides_shape_the_host_verdict() {
        let home = home();
        store_release(&home, "release-race", 7, &race_release(7, json!([race_mount(3, json!({"timeLimitTicks": 100, "gateTarget": 3}))])));
        let snapshot_digest = release_digest(&home, "release-race");
        let run_id = claimed_run(&home, "release-race", 7);
        let evidence = race_evidence("release-race", &snapshot_digest, 7, json!("success"), json!({"next": 3}), 200,
            Some(gate_trace(&[(0, 100), (1, 150), (2, 200)])));
        finish_playtest(&home, "city-instance", &run_id, "completed", Some(&evidence), None).unwrap();
        let result = read_playtest_result(&home, &run_id).unwrap();
        assert_eq!(result["evidenceSource"], "city-client-reported");
        let disagreement = &result["evidence"]["hostDisagreement"];
        assert_eq!(disagreement["hostOutcome"], "failure");
        assert_eq!(disagreement["hostCounters"]["next"], 0);
        let _ = std::fs::remove_dir_all(home);
    }

    /// gateTarget 随绑定数被 Studio 显式 override（5 门）时，宿主用同一有效阈值复算成功。
    #[test]
    fn gate_target_override_verifies_with_bound_threshold() {
        let home = home();
        let mut pack = race_game();
        pack["integerParameters"]["gateTarget"]["default"] = json!(5);
        let overrides = json!({"timeLimitTicks": 2400, "gateTarget": 5});
        let release = json!({"projectId": "project-8", "revision": 8, "game": pack, "mounts": json!([race_mount(5, overrides)])});
        store_release(&home, "release-race", 8, &release);
        let snapshot_digest = release_digest(&home, "release-race");
        let run_id = claimed_run(&home, "release-race", 8);
        let evidence = race_evidence("release-race", &snapshot_digest, 8, json!("success"), json!({"next": 5}), 500,
            Some(gate_trace(&[(0, 100), (1, 200), (2, 300), (3, 400), (4, 500)])));
        finish_playtest(&home, "city-instance", &run_id, "completed", Some(&evidence), None).unwrap();
        assert_eq!(read_playtest_result(&home, &run_id).unwrap()["evidenceSource"], "host-verified");
        let _ = std::fs::remove_dir_all(home);
    }

    /// 歧义路径：两个 mount 同 game 引用且都兼容轨迹时无法定位 played mount → 不猜，
    /// 退回 pack 默认值复算，结果仍然确定（若默认值与自报不一致则按分歧记录——
    /// 分支确定性由 rule_replay 单测覆盖，绝不静默采信任何一方）。
    #[test]
    fn ambiguous_mount_candidates_fall_back_to_pack_defaults() {
        let home = home();
        let mut pack = race_game();
        pack["integerParameters"]["gateTarget"]["default"] = json!(5);
        let mut second_mount = race_mount(5, json!({"timeLimitTicks": 2401, "gateTarget": 5}));
        second_mount["mountId"] = json!("mount-2");
        let release = json!({"projectId": "project-9", "revision": 9, "game": pack,
            "mounts": [race_mount(5, json!({"timeLimitTicks": 2400, "gateTarget": 5})), second_mount]});
        store_release(&home, "release-race", 9, &release);
        let snapshot_digest = release_digest(&home, "release-race");
        let run_id = claimed_run(&home, "release-race", 9);
        let evidence = race_evidence("release-race", &snapshot_digest, 9, json!("success"), json!({"next": 5}), 500,
            Some(gate_trace(&[(0, 100), (1, 200), (2, 300), (3, 400), (4, 500)])));
        finish_playtest(&home, "city-instance", &run_id, "completed", Some(&evidence), None).unwrap();
        // 默认值 timeLimitTicks=2700/gateTarget=5 下同样的轨迹仍然 success → host-verified。
        assert_eq!(read_playtest_result(&home, &run_id).unwrap()["evidenceSource"], "host-verified");
        let _ = std::fs::remove_dir_all(home);
    }
}
