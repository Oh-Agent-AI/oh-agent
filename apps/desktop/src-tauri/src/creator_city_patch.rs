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

// City geometry IDs include signed coordinates and slash-separated endpoints;
// this is not a filesystem path or a general Creator object identifier.
fn valid_patch_ref(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && (value.as_bytes()[0].is_ascii_alphanumeric() || value.as_bytes()[0] == b'-')
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-' | b'/'))
}

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
        let capabilities = anchor.get("capabilities").and_then(Value::as_array).filter(|items| items.len() <= 3).ok_or("creator_layout_snapshot_invalid")?;
        if capabilities.iter().any(|item| !matches!(item.as_str(), Some("drive" | "walk" | "fly")))
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
            let capabilities = link.get("capabilities").and_then(Value::as_array).filter(|items| !items.is_empty() && items.len() <= 3).ok_or("creator_layout_snapshot_invalid")?;
            if capabilities.iter().any(|item| !matches!(item.as_str(), Some("drive" | "walk" | "fly")))
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

/// v3 的几何表结构校验：锚点引用的 geometryRef 必须逐条在场、只出现一次、数值有限。
/// 语义（几何从哪来、是否可信）属于 City 适配器；宿主只核对"能复现"这件事的结构前提。
fn validate_snapshot_geometry(geometry: &Value, anchors: &[Value]) -> Result<(), &'static str> {
    let entries = geometry.as_array().filter(|items| items.len() <= 64).ok_or("creator_layout_snapshot_invalid")?;
    let mut referenced = std::collections::HashSet::new();
    for anchor in anchors {
        if let Some(reference) = anchor["geometryRef"].as_str() { referenced.insert(reference); }
    }
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        let object = entry.as_object()
            .filter(|object| (object.len() == 2 || object.len() == 3 || object.len() == 4)
                && only_keys(object, &["geometryRef", "positionMeters", "activationRadiusMeters", "facingRadians"]))
            .ok_or("creator_layout_snapshot_invalid")?;
        let reference = object.get("geometryRef").and_then(Value::as_str).filter(|value| valid_id(value)).ok_or("creator_layout_snapshot_invalid")?;
        if !referenced.contains(reference) || !seen.insert(reference.to_owned()) { return Err("creator_layout_snapshot_invalid"); }
        let position = object.get("positionMeters").and_then(Value::as_object)
            .filter(|position| position.len() == 3 && only_keys(position, &["x", "y", "z"]))
            .ok_or("creator_layout_snapshot_invalid")?;
        if !["x", "y", "z"].iter().all(|axis| position.get(*axis).and_then(Value::as_f64).is_some_and(f64::is_finite)) {
            return Err("creator_layout_snapshot_invalid");
        }
        if let Some(radius) = object.get("activationRadiusMeters") {
            if !radius.as_f64().is_some_and(|value| value.is_finite() && value > 0.0) { return Err("creator_layout_snapshot_invalid"); }
        }
        if let Some(facing) = object.get("facingRadians") {
            if !facing.as_f64().is_some_and(f64::is_finite) { return Err("creator_layout_snapshot_invalid"); }
        }
    }
    if seen.len() != referenced.len() { return Err("creator_layout_snapshot_invalid"); }
    Ok(())
}

/// Trusted Studio captures the snapshot from its live renderer and validates V2/V3
/// semantics. The host checks structure, identity, bounds and transactional scope.
pub(crate) fn store_scoped_city_layout(home: &Path, snapshot: &Value) -> Result<Value, &'static str> {
    let object = snapshot.as_object().filter(|o| (o.len() == 6 || o.len() == 7)
        && only_keys(o, &["schemaVersion", "cityId", "cityRevision", "worldRevision", "seed", "layout", "geometry"]))
        .ok_or("creator_layout_snapshot_invalid")?;
    let city_id = object.get("cityId").and_then(Value::as_str).filter(|v| valid_id(v)).ok_or("creator_layout_snapshot_invalid")?;
    let city_revision = object.get("cityRevision").and_then(Value::as_u64).filter(|v| *v <= i64::MAX as u64).ok_or("creator_layout_snapshot_invalid")?;
    let version = object.get("schemaVersion").and_then(Value::as_u64).ok_or("creator_layout_snapshot_invalid")?;
    if version != 2 && version != 3 { return Err("creator_layout_snapshot_invalid"); }
    if version == 3 {
        let anchors = object.get("layout").and_then(|layout| layout.get("anchors")).and_then(Value::as_array).ok_or("creator_layout_snapshot_invalid")?;
        validate_snapshot_geometry(object.get("geometry").ok_or("creator_layout_snapshot_invalid")?, anchors)?;
    } else if object.contains_key("geometry") { return Err("creator_layout_snapshot_invalid"); }
    let legacy = json!({"schemaVersion":1,"worldRevision":snapshot["worldRevision"],"seed":snapshot["seed"],"layout":snapshot["layout"]});
    let (world_revision, layout_id) = validate_layout_snapshot(&legacy)?;
    let raw = canonical_json(snapshot).map_err(|_| "creator_layout_snapshot_invalid")?;
    // v3 多了几何（≤64 条），预算相应放宽；v2 保持不变。
    if raw.len() > (if version == 3 { 64 * 1024 } else { 32 * 1024 }) { return Err("creator_layout_snapshot_too_large"); }
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
    // v2 → v3 原地升级：同一 (city, revision, worldRevision) 下布局本身逐字未变，只是把
    // 锚点几何补进快照（v2 从不序列化几何）。发布物引用的是这个 key，升级后既有 release
    // 立刻拿到几何——不需要重新发布，也不需要 bump City revision。反过来（v3→v2）与
    // 「布局内容变了」仍然按冲突拒绝。
    let upgrade_in_place = existing.as_ref().is_some_and(|previous| previous != &hash) && {
        let previous_raw: String = tx.query_row("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=?2 AND world_revision=?3",
            params![city_id,city_revision,world_revision], |row| row.get(0)).map_err(|_| "creator_store_unavailable")?;
        let previous: Value = serde_json::from_str(&previous_raw).map_err(|_| "creator_store_unavailable")?;
        previous["schemaVersion"].as_u64() == Some(2)
            && snapshot["schemaVersion"].as_u64() == Some(3)
            && previous["cityId"] == snapshot["cityId"]
            && previous["cityRevision"] == snapshot["cityRevision"]
            && previous["worldRevision"] == snapshot["worldRevision"]
            && previous["seed"] == snapshot["seed"]
            && previous["layout"] == snapshot["layout"]
    };
    if existing.as_ref().is_some_and(|previous| previous != &hash) && !upgrade_in_place { return Err("creator_layout_revision_conflict"); }
    if existing.is_some() {
        if upgrade_in_place {
            tx.execute("UPDATE creator_city_layouts_v2 SET snapshot_json=?4,snapshot_digest=?5,created_at_ms=?6 WHERE city_id=?1 AND city_revision=?2 AND world_revision=?3",
                params![city_id,city_revision,world_revision,raw,hash,now_ms()]).map_err(|_| "creator_store_unavailable")?;
        }
    } else {
        tx.execute("INSERT INTO creator_city_layouts_v2(city_id,city_revision,world_revision,layout_id,snapshot_json,snapshot_digest,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![city_id,city_revision,world_revision,layout_id,raw,hash,now_ms()]).map_err(|_| "creator_store_unavailable")?;
    }
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"cityId":city_id,"cityRevision":city_revision,"worldRevision":world_revision,"layoutId":layout_id,
        "snapshotDigest":hash,"upgradedFromV2":upgrade_in_place}))
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

/// 读取按 cityId + cityRevision + worldRevision + layoutId 精确绑定的 v2 布局。
/// 独立 City 试玩必须按这四元组取布局，不能按裸 worldRevision 回退到别的城的快照。
pub(crate) fn read_scoped_city_layout(home: &Path, city_id: &str, city_revision: u64, world_revision: &str, layout_id: &str) -> Result<Value, &'static str> {
    if !valid_id(city_id) || city_revision > i64::MAX as u64 || world_revision.is_empty() || world_revision.len() > 256
        || layout_id.is_empty() || layout_id.len() > 256 { return Err("creator_request_invalid"); }
    let db = database(home)?;
    let raw: String = db.query_row("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=?2 AND world_revision=?3 AND layout_id=?4",
        params![city_id,city_revision,world_revision,layout_id], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_layout_not_found")?;
    let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    if snapshot["schemaVersion"].as_u64() != Some(2) || snapshot["cityId"].as_str() != Some(city_id)
        || snapshot["cityRevision"].as_u64() != Some(city_revision) || snapshot["worldRevision"].as_str() != Some(world_revision)
        || snapshot["layout"]["id"].as_str() != Some(layout_id) || !snapshot["layout"].is_object() {
        return Err("creator_layout_scope_mismatch");
    }
    Ok(snapshot)
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
            if !operation.get("edge").and_then(Value::as_str).is_some_and(valid_patch_ref) { return Err("creator_city_patch_invalid"); }
            patch_optional_point(operation, "anchor")
        }
        Some("move") if only_keys(operation, &["t", "node", "to", "anchor"]) && operation.len() >= 3 => {
            if !operation.get("node").and_then(Value::as_str).is_some_and(valid_patch_ref) { return Err("creator_city_patch_invalid"); }
            patch_point(operation.get("to").ok_or("creator_city_patch_invalid")?)?;
            patch_optional_point(operation, "anchor")
        }
        Some("restyle") if only_keys(operation, &["t", "edge", "width", "purpose", "anchor"]) && operation.len() >= 3 => {
            if !operation.get("edge").and_then(Value::as_str).is_some_and(valid_patch_ref) { return Err("creator_city_patch_invalid"); }
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
            if !operation.get("id").and_then(Value::as_str).is_some_and(valid_patch_ref) { return Err("creator_city_patch_invalid"); }
            patch_optional_point(operation, "at")?;
            if !class_ok(operation.get("cls")) { return Err("creator_city_patch_invalid"); }
            Ok(())
        }
        Some("move") if only_keys(operation, &["t", "id", "at", "to", "toAnchor", "cls"]) && operation.len() >= 3 => {
            if !operation.get("id").and_then(Value::as_str).is_some_and(valid_patch_ref) { return Err("creator_city_patch_invalid"); }
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
        if !valid_id(building) || !target.as_str().is_some_and(valid_patch_ref) { return Err("creator_city_patch_invalid"); }
    }
    if let Some(anchors) = patch.get("moveAnchors") {
        let anchors = anchors.as_object().filter(|anchors| anchors.len() <= MAX_CITY_PATCH_OPS).ok_or("creator_city_patch_invalid")?;
        for anchor in anchors.values() { patch_point(anchor)?; }
    }
    let suppressed = patch.get("suppressedContext").and_then(Value::as_array).filter(|items| items.len() <= MAX_CITY_PATCH_OPS).ok_or("creator_city_patch_invalid")?;
    for id in suppressed {
        if !id.as_str().is_some_and(valid_patch_ref) { return Err("creator_city_patch_invalid"); }
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

// ── Fly airspace anchors (flight pipeline phase 2) ──
// Anchors are added by creating a new immutable City revision and a scoped
// layout snapshot for that revision. Existing geometry is reused by reference;
// callers cannot introduce arbitrary coordinates. Old revisions stay readable.

fn city_document_and_layout(home: &Path, city_id: &str, revision: Option<u64>) -> Result<(u64, Value, Value), &'static str> {
    if !valid_id(city_id) { return Err("creator_city_invalid"); }
    let db = database(home)?;
    let (current, raw): (u64, String) = db.query_row("SELECT revision,document_json FROM creator_cities WHERE city_id=?1", [city_id],
        |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_city_not_found")?;
    let revision = revision.unwrap_or(current);
    if revision > current { return Err("revision_conflict"); }
    let page: Option<String> = db.query_row("SELECT document_json FROM creator_city_revisions WHERE city_id=?1 AND revision=?2", params![city_id,revision], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let document: Value = serde_json::from_str(&page.unwrap_or(raw)).map_err(|_| "creator_store_unavailable")?;
    let layout_raw: String = db.query_row("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=?2 ORDER BY created_at_ms DESC LIMIT 1",
        params![city_id,revision], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_layout_not_found")?;
    let layout: Value = serde_json::from_str(&layout_raw).map_err(|_| "creator_store_unavailable")?;
    Ok((revision, document, layout))
}

pub(crate) fn list_city_anchors(home: &Path, city_id: &str, revision: Option<u64>, capability: Option<&str>, kind: Option<&str>, limit: u64) -> Result<Value, &'static str> {
    if capability.is_some_and(|value| !matches!(value, "drive" | "walk" | "fly")) || kind.is_some_and(|value| !matches!(value, "spawn" | "route" | "zone" | "object")) {
        return Err("creator_request_invalid");
    }
    let (revision, _document, layout) = city_document_and_layout(home, city_id, revision)?;
    let anchors = layout["layout"]["anchors"].as_array().ok_or("creator_layout_snapshot_invalid")?;
    let anchors: Vec<Value> = anchors.iter().filter(|anchor| {
        capability.is_none_or(|capability| anchor["capabilities"].as_array().is_some_and(|items| items.iter().any(|item| item.as_str() == Some(capability))))
            && kind.is_none_or(|kind| anchor["kind"].as_str() == Some(kind))
    }).take(limit.clamp(1, 256) as usize).cloned().collect();
    Ok(json!({"cityId":city_id,"revision":revision,"worldRevision":layout["worldRevision"],"layoutId":layout["layout"]["id"],
        "anchors":anchors,"total":anchors.len()}))
}

pub(crate) fn mutate_city_anchors(home: &Path, actor: &str, city_id: &str, base_revision: u64, anchors: &Value, remove_ids: &[String], operation_id: &str) -> Result<Value, &'static str> {
    if !valid_id(actor) || !valid_id(operation_id) { return Err("creator_request_invalid"); }
    let additions = anchors.as_array().filter(|items| items.len() <= 64).ok_or("creator_city_anchor_invalid")?;
    if remove_ids.len() > 64 { return Err("creator_city_anchor_invalid"); }
    let request_hash = digest(&canonical_json(&json!({"cityId":city_id,"baseRevision":base_revision,"anchors":additions,"remove":remove_ids}))
        .map_err(|_| "creator_city_anchor_invalid")?);
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some((previous_hash, result)) = tx.query_row("SELECT operation_hash,result_json FROM creator_city_operations WHERE actor_id=?1 AND operation_id=?2",
        params![actor,operation_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional().map_err(|_| "creator_store_unavailable")? {
        if previous_hash != request_hash { return Err("operation_id_conflict"); }
        return serde_json::from_str(&result).map_err(|_| "creator_store_unavailable");
    }
    let (current, raw): (u64, String) = tx.query_row("SELECT revision,document_json FROM creator_cities WHERE city_id=?1", [city_id],
        |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_city_not_found")?;
    if current != base_revision { return Err("revision_conflict"); }
    let layout_raw: String = tx.query_row("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=?2 ORDER BY created_at_ms DESC LIMIT 1",
        params![city_id,current], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_layout_not_found")?;
    let layout: Value = serde_json::from_str(&layout_raw).map_err(|_| "creator_store_unavailable")?;
    let world_revision = layout["worldRevision"].as_str().ok_or("creator_layout_snapshot_invalid")?.to_owned();
    let layout_id = layout["layout"]["id"].as_str().ok_or("creator_layout_snapshot_invalid")?.to_owned();
    let mut merged: Vec<Value> = layout["layout"]["anchors"].as_array().ok_or("creator_layout_snapshot_invalid")?.clone();
    let allowed_geometry: std::collections::HashSet<String> = merged.iter().filter_map(|anchor| anchor["geometryRef"].as_str().map(str::to_owned)).collect();
    for addition in additions {
        let object = addition.as_object().filter(|object| object.len() == 4 && only_keys(object, &["id", "kind", "capabilities", "geometryRef"]))
            .ok_or("creator_city_anchor_invalid")?;
        let id = object.get("id").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_city_anchor_invalid")?;
        let geometry = object.get("geometryRef").and_then(Value::as_str).filter(|value| allowed_geometry.contains(*value)).ok_or("creator_city_anchor_geometry_unknown")?;
        let capabilities = object.get("capabilities").and_then(Value::as_array).ok_or("creator_city_anchor_invalid")?;
        if capabilities.is_empty() || capabilities.len() > 3
            || capabilities.iter().any(|item| !matches!(item.as_str(), Some("drive" | "walk" | "fly")))
            || capabilities.iter().enumerate().any(|(index, item)| capabilities[..index].contains(item))
            || !capabilities.iter().any(|item| item.as_str() == Some("fly")) { return Err("creator_city_anchor_invalid"); }
        let anchor = json!({"id":id,"kind":object["kind"],"capabilities":capabilities,"geometryRef":geometry});
        merged.retain(|existing| existing["id"].as_str() != Some(id));
        merged.push(anchor);
    }
    let removed: std::collections::HashSet<&str> = remove_ids.iter().map(String::as_str).collect();
    for id in remove_ids {
        let before = merged.len();
        merged.retain(|anchor| anchor["id"].as_str() != Some(id));
        if merged.len() == before { return Err("creator_city_anchor_not_found"); }
    }
    let mut links: Vec<Value> = layout["layout"].get("links").and_then(Value::as_array).map(|links| links.iter()
        .filter(|link| !link["fromAnchorId"].as_str().is_some_and(|id| removed.contains(id))
            && !link["toAnchorId"].as_str().is_some_and(|id| removed.contains(id))).cloned().collect()).unwrap_or_default();
    // 空域锚点必须可被 mount 到达：validateMount 要求每个绑定槽从入口沿 link 可达，缺 link
    // 的发布物会在试玩 claim 阶段以 anchor_unreachable 被整份拒绝（实测 2026-11-15 的
    // 三个 air-gate 全无 link）。这里以**同一 City 的 fly spawn**为枢纽补星形 link，
    // 并且拒绝「没有 fly spawn 就加 fly zone」——否则发布出来永远绑不上入口。
    let added_fly_zones: Vec<String> = additions.iter().filter_map(|addition| {
        let object = addition.as_object()?;
        let is_fly = object.get("capabilities").and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| item.as_str() == Some("fly")));
        (is_fly && object.get("kind").and_then(Value::as_str) == Some("zone")).then(|| object.get("id").and_then(Value::as_str).map(str::to_owned))?
    }).collect();
    if !added_fly_zones.is_empty() {
        let fly_spawn = merged.iter().find(|anchor| anchor["kind"].as_str() == Some("spawn")
            && anchor["capabilities"].as_array().is_some_and(|items| items.iter().any(|item| item.as_str() == Some("fly"))))
            .and_then(|anchor| anchor["id"].as_str().map(str::to_owned))
            .ok_or("creator_city_anchor_fly_spawn_required")?;
        for anchor_id in added_fly_zones {
            let existing = links.iter().any(|link| link["fromAnchorId"].as_str() == Some(fly_spawn.as_str())
                && link["toAnchorId"].as_str() == Some(anchor_id.as_str()));
            if existing { continue; }
            links.push(json!({"id": format!("air-link:{fly_spawn}:{anchor_id}"), "fromAnchorId": fly_spawn,
                "toAnchorId": anchor_id, "capabilities": ["fly"]}));
        }
    }
    let merged_layout = json!({"schemaVersion":1,"id":layout_id,"coordinateSystem":"city-local-m-v1","anchors":merged,
        "links":links});
    validate_layout_snapshot(&json!({"schemaVersion":1,"worldRevision":world_revision,"seed":layout["seed"],"layout":merged_layout}))?;
    let next = current.checked_add(1).filter(|revision| *revision <= i64::MAX as u64).ok_or("creator_city_invalid")?;
    let mut document: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    document["revision"] = json!(next);
    let serialized = canonical_json(&document).map_err(|_| "creator_city_invalid")?;
    // v3 快照的几何必须原样带走：锚点增删不改几何，丢了它发布物就再也定位不到门。
    let version = layout["schemaVersion"].as_u64().unwrap_or(2);
    let mut snapshot = json!({"schemaVersion":version,"cityId":city_id,"cityRevision":next,"worldRevision":world_revision,
        "seed":layout["seed"],"layout":merged_layout});
    if version == 3 {
        let geometry = layout.get("geometry").cloned().ok_or("creator_layout_snapshot_invalid")?;
        if let Some(anchors) = snapshot["layout"]["anchors"].as_array() {
            validate_snapshot_geometry(&geometry, anchors)?;
        }
        snapshot["geometry"] = geometry;
    }
    let snapshot_raw = canonical_json(&snapshot).map_err(|_| "creator_city_anchor_invalid")?;
    if snapshot_raw.len() > (if version == 3 { 64 * 1024 } else { 32 * 1024 }) { return Err("creator_city_anchor_budget_exceeded"); }
    let snapshot_digest = digest(&snapshot_raw);
    let now = now_ms();
    tx.execute("INSERT OR IGNORE INTO creator_city_revisions(city_id,revision,document_json,created_at_ms) SELECT city_id,revision,document_json,updated_at_ms FROM creator_cities WHERE city_id=?1 AND revision=?2",
        params![city_id,current]).map_err(|_| "creator_store_unavailable")?;
    let updated = tx.execute("UPDATE creator_cities SET revision=?2,document_json=?3,updated_at_ms=?4 WHERE city_id=?1 AND revision=?5",
        params![city_id,next,serialized,now,current]).map_err(|_| "creator_store_unavailable")?;
    if updated != 1 { return Err("revision_conflict"); }
    tx.execute("INSERT INTO creator_city_revisions(city_id,revision,document_json,created_at_ms) VALUES(?1,?2,?3,?4)",
        params![city_id,next,serialized,now]).map_err(|_| "creator_store_unavailable")?;
    tx.execute("INSERT INTO creator_city_layouts_v2(city_id,city_revision,world_revision,layout_id,snapshot_json,snapshot_digest,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![city_id,next,world_revision,layout_id,snapshot_raw,snapshot_digest,now]).map_err(|_| "creator_store_unavailable")?;
    let result = json!({"cityId":city_id,"revision":next,"worldRevision":world_revision,"layoutId":layout_id,
        "anchorCount":snapshot["layout"]["anchors"].as_array().map_or(0,Vec::len),"snapshotDigest":snapshot_digest});
    tx.execute("INSERT INTO creator_city_operations(actor_id,operation_id,operation_hash,city_id,result_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",
        params![actor,operation_id,request_hash,city_id,result.to_string(),now]).map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

#[cfg(test)]
mod airspace_tests {
    use super::*;

    fn home() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!("creator-airspace-test-{}-{}-{}", now_ms(), std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fly_anchor_upsert_creates_a_new_city_revision_and_preserves_geometry() {
        let home = home();
        let created = crate::creator_cities::create_city(&home, "local-profile", "create-airspace-city", "Airspace", 7, &json!({"schemaVersion":1})).unwrap();
        let city_id = created["cityId"].as_str().unwrap();
        let base = json!({"schemaVersion":2,"cityId":city_id,"cityRevision":0,"worldRevision":"world-airspace","seed":7,
            "layout":{"schemaVersion":1,"id":"layout-airspace","coordinateSystem":"city-local-m-v1",
                "anchors":[{"id":"road-spawn:a","kind":"spawn","capabilities":["drive"],"geometryRef":"city-road-node:a"}],"links":[]}});
        store_scoped_city_layout(&home, &base).unwrap();
        // 没有 fly spawn 就先加 zone：必须被拒绝（否则发布物永远绑不上可到达的入口）。
        let zones_only = json!([{"id":"air-gate:a","kind":"zone","capabilities":["fly"],"geometryRef":"city-road-node:a"}]);
        assert_eq!(mutate_city_anchors(&home, "local-profile", city_id, 0, &zones_only, &[], "gates-without-spawn").unwrap_err(),
            "creator_city_anchor_fly_spawn_required");
        let added = json!([{"id":"spawn-air","kind":"spawn","capabilities":["fly"],"geometryRef":"city-road-node:a"},
            {"id":"air-gate:a","kind":"zone","capabilities":["fly"],"geometryRef":"city-road-node:a"},
            {"id":"air-gate:b","kind":"zone","capabilities":["fly"],"geometryRef":"city-road-node:a"}]);
        let result = mutate_city_anchors(&home, "local-profile", city_id, 0, &added, &[], "add-fly-gates").unwrap();
        assert_eq!(result["revision"], 1);
        assert_eq!(result["anchorCount"], 4);
        // 星形 link：入口 → 每道门；门必须可从入口到达，否则 mount 校验 anchor_unreachable。
        let layout: Value = serde_json::from_str(&{
            let db = database(&home).unwrap();
            db.query_row("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=1", params![city_id], |row| row.get::<_, String>(0)).unwrap()
        }).unwrap();
        let links = layout["layout"]["links"].as_array().unwrap();
        for gate in ["air-gate:a", "air-gate:b"] {
            assert!(links.iter().any(|link| link["fromAnchorId"] == "spawn-air" && link["toAnchorId"] == gate
                && link["capabilities"] == json!(["fly"])), "missing air link to {gate}");
        }
        let listed = list_city_anchors(&home, city_id, Some(1), Some("fly"), Some("zone"), 64).unwrap();
        assert_eq!(listed["anchors"].as_array().unwrap().len(), 2);
        assert_eq!(listed["revision"], 1);
        let removed = mutate_city_anchors(&home, "local-profile", city_id, 1, &json!([]), &["air-gate:a".to_owned()], "remove-one-gate").unwrap();
        assert_eq!(removed["revision"], 2);
        assert_eq!(removed["anchorCount"], 3);
        let old = list_city_anchors(&home, city_id, Some(0), None, None, 64).unwrap();
        assert_eq!(old["anchors"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(home);
    }

    /// 重存一次布局应当**原地**把 v2 升级成 v3（补上锚点几何），而不是报 revision 冲突：
    /// 发布物引用的是 (city, revision, worldRevision) 这个 key，升级后既有 release 立刻
    /// 拿到几何，不需要重新发布。布局内容真的变了、或想降级回 v2，仍然拒绝。
    #[test]
    fn resaving_a_layout_upgrades_a_v2_snapshot_in_place_and_keeps_conflicts() {
        let home = home();
        let created = crate::creator_cities::create_city(&home, "local-profile", "create-airspace-upgrade", "Airspace", 10, &json!({"schemaVersion":1})).unwrap();
        let city_id = created["cityId"].as_str().unwrap();
        let layout = json!({"schemaVersion":1,"id":"layout-upgrade","coordinateSystem":"city-local-m-v1",
            "anchors":[{"id":"spawn-air","kind":"spawn","capabilities":["fly"],"geometryRef":"city-road-node:a"},
                {"id":"air-gate:a","kind":"zone","capabilities":["fly"],"geometryRef":"city-road-node:b"}],
            "links":[{"id":"air-link:a-b","fromAnchorId":"spawn-air","toAnchorId":"air-gate:a","capabilities":["fly"]}]});
        let v2 = json!({"schemaVersion":2,"cityId":city_id,"cityRevision":0,"worldRevision":"world-upgrade","seed":10,"layout":layout});
        store_scoped_city_layout(&home, &v2).unwrap();
        let v3 = json!({"schemaVersion":3,"cityId":city_id,"cityRevision":0,"worldRevision":"world-upgrade","seed":10,"layout":layout,
            "geometry":[{"geometryRef":"city-road-node:a","positionMeters":{"x":0,"y":40,"z":0}},
                {"geometryRef":"city-road-node:b","positionMeters":{"x":60,"y":40,"z":0},"activationRadiusMeters":12}]});
        let upgraded = store_scoped_city_layout(&home, &v3).unwrap();
        assert_eq!(upgraded["upgradedFromV2"], true);
        let stored: String = {
            let db = database(&home).unwrap();
            db.query_row("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=0", params![city_id], |row| row.get::<_, String>(0)).unwrap()
        };
        let stored: Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(stored["schemaVersion"], 3);
        assert_eq!(stored["geometry"].as_array().unwrap().len(), 2);
        // 布局内容变了 → 冲突（不是升级）。
        let mut moved = v3.clone();
        // 只改 link id：布局依然结构合法，但内容确实变了 → 必须冲突而不是升级。
        moved["layout"]["links"][0]["id"] = json!("air-link:a-b-renamed");
        assert_eq!(store_scoped_city_layout(&home, &moved).unwrap_err(), "creator_layout_revision_conflict");
        // 降级回 v2 → 冲突。
        assert_eq!(store_scoped_city_layout(&home, &v2).unwrap_err(), "creator_layout_revision_conflict");
        let _ = std::fs::remove_dir_all(home);
    }

    /// v3 快照的几何必须原样跨越锚点编辑：加/删门只改 anchors/links，geometry 不能丢，
    /// 否则发布物刚存下来就又变回"定位不到门"。
    #[test]
    fn v3_snapshot_geometry_survives_anchor_edits_and_is_strictly_validated() {
        let home = home();
        let created = crate::creator_cities::create_city(&home, "local-profile", "create-airspace-v3", "Airspace", 9, &json!({"schemaVersion":1})).unwrap();
        let city_id = created["cityId"].as_str().unwrap();
        let base = json!({"schemaVersion":3,"cityId":city_id,"cityRevision":0,"worldRevision":"world-airspace-v3","seed":9,
            "layout":{"schemaVersion":1,"id":"layout-airspace-v3","coordinateSystem":"city-local-m-v1",
                "anchors":[{"id":"road-spawn:a","kind":"spawn","capabilities":["drive"],"geometryRef":"city-road-node:a"}],"links":[]},
            "geometry":[{"geometryRef":"city-road-node:a","positionMeters":{"x":1.5,"y":2.5,"z":3.5}}]});
        store_scoped_city_layout(&home, &base).unwrap();
        let added = json!([{"id":"spawn-air","kind":"spawn","capabilities":["fly"],"geometryRef":"city-road-node:a"},
            {"id":"air-gate:a","kind":"zone","capabilities":["fly"],"geometryRef":"city-road-node:a"}]);
        let mutated = mutate_city_anchors(&home, "local-profile", city_id, 0, &added, &[], "add-fly-v3").unwrap();
        assert_eq!(mutated["revision"], 1);
        let raw: String = {
            let db = database(&home).unwrap();
            db.query_row("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=1", params![city_id], |row| row.get::<_, String>(0)).unwrap()
        };
        let snapshot: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(snapshot["schemaVersion"], 3, "anchor edits must not downgrade the snapshot version");
        assert_eq!(snapshot["geometry"], json!([{"geometryRef":"city-road-node:a","positionMeters":{"x":1.5,"y":2.5,"z":3.5}}]));
        // 少一条几何的 v3 直接拒绝（发布物无法复现）。
        let mut broken = base.clone();
        broken["geometry"] = json!([]);
        assert_eq!(store_scoped_city_layout(&home, &broken).unwrap_err(), "creator_layout_snapshot_invalid");
        // 引用不到的几何同样拒绝。
        let mut extra = base.clone();
        extra["geometry"] = json!([{"geometryRef":"city-road-node:a","positionMeters":{"x":0,"y":0,"z":0}},
            {"geometryRef":"city-road-node:ghost","positionMeters":{"x":0,"y":0,"z":0}}]);
        assert_eq!(store_scoped_city_layout(&home, &extra).unwrap_err(), "creator_layout_snapshot_invalid");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn unknown_geometry_and_duplicate_operation_are_rejected() {
        let home = home();
        let created = crate::creator_cities::create_city(&home, "local-profile", "create-airspace-city-2", "Airspace", 8, &json!({"schemaVersion":1})).unwrap();
        let city_id = created["cityId"].as_str().unwrap();
        store_scoped_city_layout(&home, &json!({"schemaVersion":2,"cityId":city_id,"cityRevision":0,"worldRevision":"world-airspace-2","seed":8,
            "layout":{"schemaVersion":1,"id":"layout-airspace-2","coordinateSystem":"city-local-m-v1",
                "anchors":[{"id":"road-spawn:a","kind":"spawn","capabilities":["drive"],"geometryRef":"city-road-node:a"}],"links":[]}})).unwrap();
        let bad = json!([{"id":"air-gate:x","kind":"zone","capabilities":["fly"],"geometryRef":"made-up-geometry"}]);
        assert_eq!(mutate_city_anchors(&home, "local-profile", city_id, 0, &bad, &[], "bad-geometry").unwrap_err(), "creator_city_anchor_geometry_unknown");
        let good = json!([{"id":"spawn-air","kind":"spawn","capabilities":["fly"],"geometryRef":"city-road-node:a"},
            {"id":"air-gate:y","kind":"zone","capabilities":["fly"],"geometryRef":"city-road-node:a"}]);
        mutate_city_anchors(&home, "local-profile", city_id, 0, &good, &[], "add-idempotent").unwrap();
        assert_eq!(mutate_city_anchors(&home, "local-profile", city_id, 0, &good, &[], "add-idempotent").unwrap()["revision"], 1);
        assert_eq!(mutate_city_anchors(&home, "local-profile", city_id, 0, &good, &[], "add-idempotent-other").unwrap_err(), "revision_conflict");
        let _ = std::fs::remove_dir_all(home);
    }
}
