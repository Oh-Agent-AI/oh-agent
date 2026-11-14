//! City layout snapshots and player patches (PlanPatchV1 mirror, slice 2):
//! structural, budget and seed-consistency validation plus publish/read
//! access. Geometry and gameplay semantics are enforced by the City engine
//! when the patch is applied (AGENTS.md plugin-face policy); this module only
//! gates what enters the authority store.
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

use crate::creator_store::{canonical_json, database, digest, now_ms, only_keys, valid_id};
use crate::creator_projects::MAX_CITY_PATCH_BYTES;

pub(crate) const MAX_CITY_PATCH_OPS: usize = 4_096;
const MAX_CITY_PATCH_HIGHWAY_OPS: usize = 1_024;
// 玩家土方尚未进入本切片的操作契约：作为有界透传收下，语义校验留给 City 引擎。
const MAX_CITY_PATCH_TERRAIN_OPS: usize = 256;
const MAX_PATCH_COORD: f64 = 1_000_000.0;
const MAX_PATCH_ROAD_WIDTH: f64 = 64.0;

pub(crate) fn validate_layout_snapshot(value: &Value) -> Result<(&str, &str), &'static str> {
    let snapshot = value.as_object().filter(|object| object.len() == 4 && only_keys(object, &["schemaVersion", "worldRevision", "seed", "layout"]))
        .ok_or("creator_layout_snapshot_invalid")?;
    if snapshot.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || !snapshot.get("worldRevision").and_then(Value::as_str).is_some_and(|revision| !revision.is_empty() && revision.len() <= 256)
        || snapshot.get("seed").and_then(Value::as_u64).is_none_or(|seed| seed > u32::MAX as u64) { return Err("creator_layout_snapshot_invalid"); }
    let layout = snapshot.get("layout").and_then(Value::as_object)
        .filter(|layout| (layout.len() == 4 || layout.len() == 5) && only_keys(layout, &["schemaVersion", "id", "coordinateSystem", "anchors", "links"]))
        .ok_or("creator_layout_snapshot_invalid")?;
    if layout.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || layout.get("coordinateSystem").and_then(Value::as_str) != Some("city-local-m-v1")
        || !layout.get("id").and_then(Value::as_str).is_some_and(valid_id) { return Err("creator_layout_snapshot_invalid"); }
    let anchors = layout.get("anchors").and_then(Value::as_array).filter(|anchors| (1..=64).contains(&anchors.len())).ok_or("creator_layout_snapshot_invalid")?;
    let mut seen = std::collections::HashSet::new();
    let mut anchor_capabilities = HashMap::<&str, std::collections::HashSet<&str>>::new();
    for anchor in anchors {
        let anchor = anchor.as_object().filter(|anchor| anchor.len() == 4 && only_keys(anchor, &["id", "kind", "capabilities", "geometryRef"]))
            .ok_or("creator_layout_snapshot_invalid")?;
        let id = anchor.get("id").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_layout_snapshot_invalid")?;
        if !seen.insert(id) { return Err("creator_layout_snapshot_invalid"); }
        if !matches!(anchor.get("kind").and_then(Value::as_str), Some("spawn" | "route" | "zone" | "object"))
            || !anchor.get("geometryRef").and_then(Value::as_str).is_some_and(valid_id) { return Err("creator_layout_snapshot_invalid"); }
        let capabilities = anchor.get("capabilities").and_then(Value::as_array).filter(|items| items.len() <= 2).ok_or("creator_layout_snapshot_invalid")?;
        if capabilities.iter().any(|item| !matches!(item.as_str(), Some("drive" | "walk")))
            || capabilities.iter().enumerate().any(|(index, item)| capabilities[..index].contains(item)) { return Err("creator_layout_snapshot_invalid"); }
        anchor_capabilities.insert(id, capabilities.iter().filter_map(Value::as_str).collect());
    }
    if let Some(links_value) = layout.get("links") {
        let links = links_value.as_array().filter(|links| links.len() <= 256).ok_or("creator_layout_snapshot_invalid")?;
        let mut link_ids = std::collections::HashSet::new();
        for link in links {
            let link = link.as_object().filter(|link| link.len() == 4 && only_keys(link, &["id", "fromAnchorId", "toAnchorId", "capabilities"]))
                .ok_or("creator_layout_snapshot_invalid")?;
            let id = link.get("id").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_layout_snapshot_invalid")?;
            let from = link.get("fromAnchorId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_layout_snapshot_invalid")?;
            let to = link.get("toAnchorId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_layout_snapshot_invalid")?;
            if !link_ids.insert(id) || from == to { return Err("creator_layout_snapshot_invalid"); }
            let from_capabilities = anchor_capabilities.get(from).ok_or("creator_layout_snapshot_invalid")?;
            let to_capabilities = anchor_capabilities.get(to).ok_or("creator_layout_snapshot_invalid")?;
            let capabilities = link.get("capabilities").and_then(Value::as_array).filter(|items| !items.is_empty() && items.len() <= 2).ok_or("creator_layout_snapshot_invalid")?;
            if capabilities.iter().any(|item| !matches!(item.as_str(), Some("drive" | "walk")))
                || capabilities.iter().enumerate().any(|(index, item)| capabilities[..index].contains(item)
                    || item.as_str().is_none_or(|capability| !from_capabilities.contains(capability) || !to_capabilities.contains(capability))) {
                return Err("creator_layout_snapshot_invalid");
            }
        }
    }
    Ok((snapshot["worldRevision"].as_str().unwrap_or_default(), layout["id"].as_str().unwrap_or_default()))
}

pub fn publish_city_layout_snapshot(home: &Path, snapshot: &Value) -> Result<Value, &'static str> {
    let (world_revision, layout_id) = validate_layout_snapshot(snapshot)?;
    let raw = serde_json::to_string(snapshot).map_err(|_| "creator_layout_snapshot_invalid")?;
    if raw.len() > 32 * 1024 { return Err("creator_layout_snapshot_too_large"); }
    let snapshot_digest = digest(&raw);
    let db = database(home)?;
    let existing: Option<String> = db.query_row("SELECT snapshot_digest FROM creator_city_layouts WHERE world_revision=?1", [world_revision], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?;
    if existing.as_ref().is_some_and(|digest| digest != &snapshot_digest) { return Err("creator_layout_revision_conflict"); }
    db.execute("INSERT INTO creator_city_layouts(world_revision,layout_id,snapshot_json,snapshot_digest,updated_at_ms)
        VALUES(?1,?2,?3,?4,?5) ON CONFLICT(world_revision) DO UPDATE SET updated_at_ms=excluded.updated_at_ms",
        params![world_revision,layout_id,raw,snapshot_digest,now_ms()]).map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"layoutId":layout_id,"worldRevision":world_revision,"anchorCount":snapshot["layout"]["anchors"].as_array().map_or(0, Vec::len)}))
}

/// Trusted Studio captures the snapshot from its live renderer and validates V2
/// semantics. The host checks structure, identity, bounds and transactional scope.
pub(crate) fn store_scoped_city_layout(home: &Path, snapshot: &Value) -> Result<Value, &'static str> {
    let object = snapshot.as_object().filter(|o| o.len() == 6 && only_keys(o, &["schemaVersion", "cityId", "cityRevision", "worldRevision", "seed", "layout"]))
        .ok_or("creator_layout_snapshot_invalid")?;
    let city_id = object.get("cityId").and_then(Value::as_str).filter(|v| valid_id(v)).ok_or("creator_layout_snapshot_invalid")?;
    let city_revision = object.get("cityRevision").and_then(Value::as_u64).filter(|v| *v <= i64::MAX as u64).ok_or("creator_layout_snapshot_invalid")?;
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(2) { return Err("creator_layout_snapshot_invalid"); }
    let legacy = json!({"schemaVersion":1,"worldRevision":snapshot["worldRevision"],"seed":snapshot["seed"],"layout":snapshot["layout"]});
    let (world_revision, layout_id) = validate_layout_snapshot(&legacy)?;
    let raw = canonical_json(snapshot).map_err(|_| "creator_layout_snapshot_invalid")?;
    if raw.len() > 32 * 1024 { return Err("creator_layout_snapshot_too_large"); }
    let hash = digest(&raw);
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let city: Option<(u64, String)> = tx.query_row("SELECT revision,document_json FROM creator_cities WHERE city_id=?1", [city_id], |row| Ok((row.get(0)?,row.get(1)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let (current_revision, document) = city.ok_or("creator_city_not_found")?;
    if current_revision != city_revision { return Err("revision_conflict"); }
    let document: Value = serde_json::from_str(&document).map_err(|_| "creator_store_unavailable")?;
    if document["seed"].as_u64() != snapshot["seed"].as_u64() { return Err("creator_layout_scope_invalid"); }
    let existing: Option<String> = tx.query_row("SELECT snapshot_digest FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=?2 AND world_revision=?3",
        params![city_id,city_revision,world_revision], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?;
    if existing.as_ref().is_some_and(|previous| previous != &hash) { return Err("creator_layout_revision_conflict"); }
    if existing.is_none() {
        tx.execute("INSERT INTO creator_city_layouts_v2(city_id,city_revision,world_revision,layout_id,snapshot_json,snapshot_digest,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![city_id,city_revision,world_revision,layout_id,raw,hash,now_ms()]).map_err(|_| "creator_store_unavailable")?;
    }
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"cityId":city_id,"cityRevision":city_revision,"worldRevision":world_revision,"layoutId":layout_id,"snapshotDigest":hash}))
}

pub fn list_city_layout_snapshots(home: &Path, limit: u64) -> Result<Value, &'static str> {
    let db = database(home)?;
    let mut statement = db.prepare("SELECT world_revision,layout_id,snapshot_json,updated_at_ms FROM creator_city_layouts ORDER BY updated_at_ms DESC,world_revision ASC LIMIT ?1")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map([limit.clamp(1, 16)], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,u64>(3)?)))
        .map_err(|_| "creator_store_unavailable")?;
    let catalogs = rows.map(|row| {
        let (world_revision, layout_id, raw, updated_at_ms) = row.map_err(|_| "creator_store_unavailable")?;
        let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
        Ok(json!({"worldRevision":world_revision,"layoutId":layout_id,"seed":snapshot["seed"],
            "anchorCount":snapshot["layout"]["anchors"].as_array().map_or(0, Vec::len),"updatedAtMs":updated_at_ms,
            "source":"legacy"}))
    }).collect::<Result<Vec<_>, &'static str>>()?;
    // 独立 City 草稿的布局（v2）单独列出：旧接口按裸 worldRevision 查找，不能把
    // 它们混进 legacy 数组，否则跨 City 绑定会绕过 cityId/revision 校验。
    let mut statement = db.prepare("SELECT city_id,city_revision,world_revision,layout_id,snapshot_json,created_at_ms FROM creator_city_layouts_v2 ORDER BY created_at_ms DESC LIMIT ?1")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map([limit.clamp(1, 16)], |row| Ok((row.get::<_,String>(0)?,row.get::<_,u64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,u64>(5)?)))
        .map_err(|_| "creator_store_unavailable")?;
    let city_layouts = rows.map(|row| {
        let (city_id, city_revision, world_revision, layout_id, raw, created_at_ms) = row.map_err(|_| "creator_store_unavailable")?;
        let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
        Ok(json!({"cityId":city_id,"cityRevision":city_revision,"worldRevision":world_revision,
            "layoutId":layout_id,"seed":snapshot["seed"],
            "anchorCount":snapshot["layout"]["anchors"].as_array().map_or(0, Vec::len),
            "updatedAtMs":created_at_ms,"source":"cityDraft"}))
    }).collect::<Result<Vec<_>, &'static str>>()?;
    Ok(json!({"layouts":catalogs,"cityLayouts":city_layouts}))
}

pub(crate) fn read_city_layout_snapshot(home: &Path, world_revision: &str) -> Result<Value, &'static str> {
    if world_revision.is_empty() || world_revision.len() > 256 { return Err("creator_layout_not_found"); }
    let db = database(home)?;
    let raw: String = db.query_row("SELECT snapshot_json FROM creator_city_layouts WHERE world_revision=?1", [world_revision], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_layout_not_found")?;
    serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")
}

// ── 城市补丁（PlanPatchV1 镜像，切片 2）──

fn patch_point(value: &Value) -> Result<(), &'static str> {
    let point = value.as_object().filter(|point| point.len() == 2 && only_keys(point, &["x", "z"])).ok_or("creator_city_patch_invalid")?;
    for key in ["x", "z"] {
        let coordinate = point.get(key).and_then(Value::as_f64).ok_or("creator_city_patch_invalid")?;
        if !coordinate.is_finite() || coordinate.abs() > MAX_PATCH_COORD { return Err("creator_city_patch_invalid"); }
    }
    Ok(())
}

fn patch_optional_point(object: &serde_json::Map<String, Value>, key: &str) -> Result<(), &'static str> {
    if let Some(anchor) = object.get(key) { patch_point(anchor)?; }
    Ok(())
}

fn patch_optional_purpose(object: &serde_json::Map<String, Value>) -> Result<(), &'static str> {
    if let Some(purpose) = object.get("purpose") {
        if purpose.as_str() != Some("waterfront") { return Err("creator_city_patch_invalid"); }
    }
    Ok(())
}

fn patch_road_width(value: &Value) -> Result<f64, &'static str> {
    let width = value.as_f64().ok_or("creator_city_patch_invalid")?;
    if !width.is_finite() || width <= 0.0 || width > MAX_PATCH_ROAD_WIDTH { return Err("creator_city_patch_invalid"); }
    Ok(width)
}

fn validate_road_op(operation: &Value) -> Result<(), &'static str> {
    let operation = operation.as_object().ok_or("creator_city_patch_invalid")?;
    match operation.get("t").and_then(Value::as_str) {
        Some("add") if only_keys(operation, &["t", "from", "to", "width", "purpose", "via"]) && operation.len() >= 4 => {
            patch_point(operation.get("from").ok_or("creator_city_patch_invalid")?)?;
            patch_point(operation.get("to").ok_or("creator_city_patch_invalid")?)?;
            patch_road_width(operation.get("width").ok_or("creator_city_patch_invalid")?)?;
            patch_optional_purpose(operation)?;
            patch_optional_point(operation, "via")
        }
        Some("drop") if only_keys(operation, &["t", "edge", "anchor"]) && operation.len() >= 2 => {
            if !operation.get("edge").and_then(Value::as_str).is_some_and(valid_id) { return Err("creator_city_patch_invalid"); }
            patch_optional_point(operation, "anchor")
        }
        Some("move") if only_keys(operation, &["t", "node", "to", "anchor"]) && operation.len() >= 3 => {
            if !operation.get("node").and_then(Value::as_str).is_some_and(valid_id) { return Err("creator_city_patch_invalid"); }
            patch_point(operation.get("to").ok_or("creator_city_patch_invalid")?)?;
            patch_optional_point(operation, "anchor")
        }
        Some("restyle") if only_keys(operation, &["t", "edge", "width", "purpose", "anchor"]) && operation.len() >= 3 => {
            if !operation.get("edge").and_then(Value::as_str).is_some_and(valid_id) { return Err("creator_city_patch_invalid"); }
            patch_road_width(operation.get("width").ok_or("creator_city_patch_invalid")?)?;
            patch_optional_purpose(operation)?;
            patch_optional_point(operation, "anchor")
        }
        _ => Err("creator_city_patch_invalid"),
    }
}

fn validate_site_op(operation: &Value) -> Result<(), &'static str> {
    let operation = operation.as_object().ok_or("creator_city_patch_invalid")?;
    // cls 是「种类/子类」签名字符串（siteClassOf），to 是地块 id 或自由级 "@x,z" 目标——
    // 都按长度受限的字符串收下，具体语义由 City 引擎套用时校验。
    let class_ok = |value: Option<&Value>| value.is_none_or(|cls| cls.as_str().is_some_and(|cls| !cls.is_empty() && cls.len() <= 128));
    let target_ok = |value: Option<&Value>| value.is_none_or(|to| to.as_str().is_some_and(|to| !to.is_empty() && to.len() <= 128));
    match operation.get("t").and_then(Value::as_str) {
        Some("remove") if only_keys(operation, &["t", "id", "at", "cls"]) && operation.len() >= 2 => {
            if !operation.get("id").and_then(Value::as_str).is_some_and(valid_id) { return Err("creator_city_patch_invalid"); }
            patch_optional_point(operation, "at")?;
            if !class_ok(operation.get("cls")) { return Err("creator_city_patch_invalid"); }
            Ok(())
        }
        Some("move") if only_keys(operation, &["t", "id", "at", "to", "toAnchor", "cls"]) && operation.len() >= 3 => {
            if !operation.get("id").and_then(Value::as_str).is_some_and(valid_id) { return Err("creator_city_patch_invalid"); }
            if !target_ok(operation.get("to")) { return Err("creator_city_patch_invalid"); }
            patch_optional_point(operation, "at")?;
            patch_optional_point(operation, "toAnchor")?;
            if !class_ok(operation.get("cls")) { return Err("creator_city_patch_invalid"); }
            Ok(())
        }
        _ => Err("creator_city_patch_invalid"),
    }
}

/// 结构 + 预算 + 种子一致性校验。与 PlanPatchV1（apps/agent-city …/engine/planPatch.ts）逐字段对应：
/// 已知字段严格校验；terrainOps 是尚未进入本切片契约的玩家土方日志，按有界透传收下。
pub(crate) fn validate_city_patch(patch: &Value, expected_seed: u64) -> Result<(), &'static str> {
    const KEYS: &[&str] = &["version", "seed", "scaleTier", "generatorVersion", "islandRadius", "updatedAt",
        "roadOps", "highwayOps", "siteOps", "buildingMoves", "moveAnchors", "suppressedContext", "terrainOps"];
    let patch = patch.as_object()
        .filter(|patch| !patch.is_empty() && patch.len() <= KEYS.len() && patch.keys().all(|key| KEYS.contains(&key.as_str())))
        .ok_or("creator_city_patch_invalid")?;
    if patch.get("version").and_then(Value::as_u64) != Some(1) { return Err("creator_city_patch_invalid"); }
    let seed = patch.get("seed").and_then(Value::as_u64).filter(|seed| *seed <= u32::MAX as u64).ok_or("creator_city_patch_invalid")?;
    if seed != expected_seed { return Err("creator_city_patch_seed_mismatch"); }
    patch.get("scaleTier").and_then(Value::as_u64).filter(|tier| *tier <= 1024).ok_or("creator_city_patch_invalid")?;
    if let Some(version) = patch.get("generatorVersion") {
        if !version.as_u64().is_some_and(|version| (1..=1024).contains(&version)) { return Err("creator_city_patch_invalid"); }
    }
    patch.get("updatedAt").and_then(Value::as_u64).ok_or("creator_city_patch_invalid")?;
    if let Some(radius) = patch.get("islandRadius") {
        if !radius.as_f64().is_some_and(|radius| radius.is_finite() && radius > 0.0 && radius <= 100_000.0) { return Err("creator_city_patch_invalid"); }
    }
    let moves = patch.get("buildingMoves").and_then(Value::as_object).filter(|moves| moves.len() <= MAX_CITY_PATCH_OPS).ok_or("creator_city_patch_invalid")?;
    for (building, target) in moves {
        if !valid_id(building) || !target.as_str().is_some_and(valid_id) { return Err("creator_city_patch_invalid"); }
    }
    if let Some(anchors) = patch.get("moveAnchors") {
        let anchors = anchors.as_object().filter(|anchors| anchors.len() <= MAX_CITY_PATCH_OPS).ok_or("creator_city_patch_invalid")?;
        for anchor in anchors.values() { patch_point(anchor)?; }
    }
    let suppressed = patch.get("suppressedContext").and_then(Value::as_array).filter(|items| items.len() <= MAX_CITY_PATCH_OPS).ok_or("creator_city_patch_invalid")?;
    for id in suppressed {
        if !id.as_str().is_some_and(valid_id) { return Err("creator_city_patch_invalid"); }
    }
    let road_ops = patch.get("roadOps").and_then(Value::as_array).filter(|ops| ops.len() <= MAX_CITY_PATCH_OPS).ok_or("creator_city_patch_invalid")?;
    for operation in road_ops { validate_road_op(operation)?; }
    let site_ops = patch.get("siteOps").and_then(Value::as_array).filter(|ops| ops.len() <= MAX_CITY_PATCH_OPS).ok_or("creator_city_patch_invalid")?;
    for operation in site_ops { validate_site_op(operation)?; }
    if let Some(highway_ops) = patch.get("highwayOps") {
        let highway_ops = highway_ops.as_array().filter(|ops| ops.len() <= MAX_CITY_PATCH_HIGHWAY_OPS).ok_or("creator_city_patch_invalid")?;
        for operation in highway_ops {
            let operation = operation.as_object().ok_or("creator_city_patch_invalid")?;
            match operation.get("t").and_then(Value::as_str) {
                Some("add") if only_keys(operation, &["t", "points"]) => {
                    let points = operation.get("points").and_then(Value::as_array).filter(|points| (2..=256).contains(&points.len())).ok_or("creator_city_patch_invalid")?;
                    for point in points { patch_point(point)?; }
                }
                Some("cut") if only_keys(operation, &["t", "at"]) => patch_point(operation.get("at").ok_or("creator_city_patch_invalid")?)?,
                _ => return Err("creator_city_patch_invalid"),
            }
        }
    }
    if let Some(terrain_ops) = patch.get("terrainOps") {
        let terrain_ops = terrain_ops.as_array().filter(|ops| ops.len() <= MAX_CITY_PATCH_TERRAIN_OPS).ok_or("creator_city_patch_invalid")?;
        for operation in terrain_ops {
            if !operation.is_object() { return Err("creator_city_patch_invalid"); }
        }
    }
    Ok(())
}

/// City 侧补丁发布（切片 2 的导入源）：同 seed 最新补丁胜出，摘要幂等——重试不会产生重复数据。
pub fn publish_city_patch(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let payload = payload.as_object().filter(|payload| payload.len() == 2 && only_keys(payload, &["seed", "patch"])).ok_or("creator_request_invalid")?;
    let seed = payload["seed"].as_u64().filter(|seed| *seed <= u32::MAX as u64).ok_or("creator_request_invalid")?;
    validate_city_patch(&payload["patch"], seed)?;
    let canonical = canonical_json(&payload["patch"]).map_err(|_| "creator_city_patch_invalid")?;
    if canonical.len() > MAX_CITY_PATCH_BYTES { return Err("creator_city_patch_too_large"); }
    let patch_digest = digest(&canonical);
    let db = database(home)?;
    db.execute("INSERT INTO creator_city_patches(seed,patch_json,patch_digest,updated_at_ms) VALUES(?1,?2,?3,?4)
        ON CONFLICT(seed) DO UPDATE SET patch_json=excluded.patch_json,patch_digest=excluded.patch_digest,updated_at_ms=excluded.updated_at_ms",
        params![seed, payload["patch"].to_string(), patch_digest, now_ms()]).map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"seed":seed,"digest":patch_digest}))
}

pub(crate) fn latest_city_patch(home: &Path, seed: u64) -> Result<Option<(Value, String)>, &'static str> {
    let db = database(home)?;
    let raw: Option<String> = db.query_row("SELECT patch_json FROM creator_city_patches WHERE seed=?1", [seed], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let Some(raw) = raw else { return Ok(None) };
    let patch: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    let patch_digest = digest(&canonical_json(&patch).map_err(|_| "creator_store_unavailable")?);
    Ok(Some((patch, patch_digest)))
}

/// City 运行时读取绑定到该种子的最新项目的补丁与 revision（不返回未发布内容之外的项目文档）。
pub fn read_city_patch_for_seed(home: &Path, seed: u64) -> Result<Value, &'static str> {
    let db = database(home)?;
    let mut statement = db.prepare("SELECT document_json,revision FROM creator_projects ORDER BY updated_at_ms DESC, project_id ASC LIMIT 64").map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))).map_err(|_| "creator_store_unavailable")?;
    for row in rows {
        let (raw, revision) = row.map_err(|_| "creator_store_unavailable")?;
        let Ok(document) = serde_json::from_str::<Value>(&raw) else { continue };
        if document.get("cityLayout").and_then(|layout| layout.get("seed")).and_then(Value::as_u64) != Some(seed) { continue; }
        return Ok(json!({"projectId":document.get("projectId"),"revision":revision,"patch":document.get("cityPatch")}));
    }
    Ok(json!({"projectId":null,"revision":null,"patch":null}))
}
