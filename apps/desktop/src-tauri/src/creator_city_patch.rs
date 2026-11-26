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
    validate_snapshot_geometry_with(geometry, anchors, false).map(|_ignored| ())
}

/// `allow_extras`：渲染器捕获的是**整张**几何表（它不知道该 revision 的快照里有哪些锚点），
/// 合并时未引用的条目只是多余信息，丢弃即可；但要报告数量，别静默。
fn validate_snapshot_geometry_with(geometry: &Value, anchors: &[Value], allow_extras: bool) -> Result<usize, &'static str> {
    let entries = geometry.as_array().filter(|items| items.len() <= 512).ok_or("creator_layout_snapshot_invalid")?;
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
        if !referenced.contains(reference) {
            if allow_extras { continue; }
            return Err("creator_layout_snapshot_invalid");
        }
        if !seen.insert(reference.to_owned()) { return Err("creator_layout_snapshot_invalid"); }
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
    Ok(entries.len() - seen.len())
}

/// 作用域布局快照的**唯一解析入口**（v2/v3 → 一个内部形状）。
///
/// 规则（2026-11-15 定）：
/// - v3：结构 + 几何覆盖都严格校验（`geometry` 里出现的必须是快照锚点引用的 ref，且必须
///   全覆盖）——这是发布物能离开运行时被复现的前提；
/// - v2：结构校验后**归一化**（`geometry: None`），绝不凭空造几何；
/// - 其它版本：明确拒绝（`creator_layout_snapshot_version_unsupported`），不做猜测。
///
/// 消费方只应通过这里拿 `layout`/`seed`/`geometry`，不要再各自比 `schemaVersion`。
#[derive(Debug)]
pub(crate) struct ScopedLayout {
    pub city_id: String,
    pub city_revision: u64,
    pub world_revision: String,
    pub layout_id: String,
    pub seed: u64,
    pub layout: Value,
    /// `Some` = 该快照自带完整几何（v3）；`None` = 历史 v2，没有几何。
    pub geometry: Option<Value>,
    pub version: u64,
}

pub(crate) fn resolve_scoped_layout(snapshot: &Value) -> Result<ScopedLayout, &'static str> {
    let version = snapshot["schemaVersion"].as_u64().ok_or("creator_layout_snapshot_invalid")?;
    let object = snapshot.as_object().ok_or("creator_layout_snapshot_invalid")?;
    match version {
        2 | 3 => {}
        _ => return Err("creator_layout_snapshot_version_unsupported"),
    }
    let expected = if version == 3 { 7 } else { 6 };
    if object.len() != expected
        || !only_keys(object, &["schemaVersion", "cityId", "cityRevision", "worldRevision", "seed", "layout", "geometry"]) {
        return Err("creator_layout_snapshot_invalid");
    }
    if version == 2 && object.contains_key("geometry") { return Err("creator_layout_snapshot_invalid"); }
    let city_id = object.get("cityId").and_then(Value::as_str).filter(|value| valid_id(value)).ok_or("creator_layout_snapshot_invalid")?;
    let city_revision = object.get("cityRevision").and_then(Value::as_u64).filter(|value| *value <= i64::MAX as u64).ok_or("creator_layout_snapshot_invalid")?;
    let world_revision = object.get("worldRevision").and_then(Value::as_str).ok_or("creator_layout_snapshot_invalid")?.to_owned();
    let seed = object.get("seed").and_then(Value::as_u64).filter(|value| *value <= u32::MAX as u64).ok_or("creator_layout_snapshot_invalid")?;
    let layout = object.get("layout").and_then(Value::as_object).ok_or("creator_layout_snapshot_invalid")?;
    let layout_id = layout.get("id").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_layout_snapshot_invalid")?.to_owned();
    let layout_anchors = layout.get("anchors").and_then(Value::as_array).ok_or("creator_layout_snapshot_invalid")?.clone();
    validate_layout_snapshot(&json!({"schemaVersion":1,"worldRevision":world_revision,"seed":seed,"layout":layout}))
        .map_err(|_| "creator_layout_snapshot_invalid")?;
    let geometry = if version == 3 {
        let entries = object.get("geometry").ok_or("creator_layout_snapshot_invalid")?;
        validate_snapshot_geometry(entries, &layout_anchors)?;
        Some(entries.clone())
    } else {
        None
    };
    Ok(ScopedLayout { city_id: city_id.to_owned(), city_revision, world_revision, layout_id, seed,
        layout: Value::Object(layout.clone()), geometry, version })
}

/// 迁移：把渲染器捕获到的锚点几何**并入一个新的 City revision**（v2/v3 → v3）。
///
/// 为什么不是原地改：同一 (city, revision, worldRevision) 的快照是历史事实，release 引用它，
/// 改 digest 等于改写历史；而且 v2 从不序列化几何，原地补等于凭空造位置。所以迁移产出
/// **新 revision**：锚点/连线逐字不动，只把几何补齐成 v3，旧行保持不可变。调用方拿新的
/// revision 去建项目/绑定/发布。
pub(crate) fn migrate_city_layout_geometry(home: &Path, city_id: &str, base_revision: u64, geometry: &Value) -> Result<Value, &'static str> {
    if !valid_id(city_id) { return Err("creator_request_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let (current, document_raw): (u64, String) = tx.query_row("SELECT revision,document_json FROM creator_cities WHERE city_id=?1", [city_id],
        |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_city_not_found")?;
    if current != base_revision { return Err("revision_conflict"); }
    let (world_revision, layout_id, previous_raw): (String, String, String) = tx.query_row(
        "SELECT world_revision,layout_id,snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=?2 ORDER BY created_at_ms DESC LIMIT 1",
        params![city_id, base_revision], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(|_| "creator_store_unavailable")?
        .ok_or("creator_layout_not_found")?;
    let previous: Value = serde_json::from_str(&previous_raw).map_err(|_| "creator_store_unavailable")?;
    let resolved = resolve_scoped_layout(&previous)?;
    let anchors = resolved.layout["anchors"].as_array().ok_or("creator_layout_snapshot_invalid")?.clone();
    let ignored = validate_snapshot_geometry_with(geometry, &anchors, true)?;
    let referenced: std::collections::HashSet<&str> = anchors.iter().filter_map(|anchor| anchor["geometryRef"].as_str()).collect();
    // 既有几何（v3 才有）∪ 新捕获的，再按锚点引用过滤 → 新快照必须全覆盖。
    let mut entries: Vec<Value> = resolved.geometry.as_ref().and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(items) = geometry.as_array() {
        for entry in items {
            let Some(reference) = entry["geometryRef"].as_str() else { continue };
            if !referenced.contains(reference) { continue; }
            entries.retain(|existing| existing["geometryRef"].as_str() != Some(reference));
            entries.push(entry.clone());
        }
    }
    entries.retain(|entry| entry["geometryRef"].as_str().is_some_and(|reference| referenced.contains(reference)));
    let final_geometry = json!(entries);
    validate_snapshot_geometry(&final_geometry, &anchors)?;
    let next = current.checked_add(1).filter(|revision| *revision <= i64::MAX as u64).ok_or("creator_city_invalid")?;
    let mut document: Value = serde_json::from_str(&document_raw).map_err(|_| "creator_store_unavailable")?;
    document["revision"] = json!(next);
    let serialized = canonical_json(&document).map_err(|_| "creator_city_invalid")?;
    let snapshot = json!({"schemaVersion":3,"cityId":city_id,"cityRevision":next,"worldRevision":world_revision,
        "seed":resolved.seed,"layout":resolved.layout,"geometry":final_geometry});
    let snapshot_raw = canonical_json(&snapshot).map_err(|_| "creator_layout_snapshot_invalid")?;
    if snapshot_raw.len() > 64 * 1024 { return Err("creator_layout_snapshot_too_large"); }
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
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"cityId":city_id,"previousRevision":base_revision,"cityRevision":next,"worldRevision":world_revision,
        "layoutId":layout_id,"snapshotDigest":snapshot_digest,"schemaVersion":3,
        "geometryCount":snapshot["geometry"].as_array().map_or(0, Vec::len),
        "ignoredGeometryCount":ignored,
        "anchorCount":snapshot["layout"]["anchors"].as_array().map_or(0, Vec::len)}))
}

/// Trusted Studio captures the snapshot from its live renderer and validates V2/V3
/// semantics. The host checks structure, identity, bounds and transactional scope.
pub(crate) fn store_scoped_city_layout(home: &Path, snapshot: &Value) -> Result<Value, &'static str> {
    let resolved = resolve_scoped_layout(snapshot)?;
    let raw = canonical_json(snapshot).map_err(|_| "creator_layout_snapshot_invalid")?;
    // v3 多了几何（≤64 条），预算相应放宽；v2 保持不变。
    if raw.len() > (if resolved.version == 3 { 64 * 1024 } else { 32 * 1024 }) { return Err("creator_layout_snapshot_too_large"); }
    let hash = digest(&raw);
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let city: Option<(u64, String)> = tx.query_row("SELECT revision,document_json FROM creator_cities WHERE city_id=?1", [&resolved.city_id], |row| Ok((row.get(0)?,row.get(1)?)))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let (current_revision, document) = city.ok_or("creator_city_not_found")?;
    if current_revision != resolved.city_revision { return Err("revision_conflict"); }
    let document: Value = serde_json::from_str(&document).map_err(|_| "creator_store_unavailable")?;
    if document["seed"].as_u64() != Some(resolved.seed) { return Err("creator_layout_scope_invalid"); }
    let existing: Option<String> = tx.query_row("SELECT snapshot_digest FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=?2 AND world_revision=?3",
        params![resolved.city_id,resolved.city_revision,resolved.world_revision], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?;
    // 同一 (city, revision, worldRevision) 的快照是**不可变**的：digest 变了就是冲突。
    // 需要带几何的新版本请走 `migrate_city_layout_geometry`（产新 revision，旧行不动）。
    if existing.as_ref().is_some_and(|previous| previous != &hash) { return Err("creator_layout_revision_conflict"); }
    if existing.is_none() {
        tx.execute("INSERT INTO creator_city_layouts_v2(city_id,city_revision,world_revision,layout_id,snapshot_json,snapshot_digest,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![resolved.city_id,resolved.city_revision,resolved.world_revision,resolved.layout_id,raw,hash,now_ms()]).map_err(|_| "creator_store_unavailable")?;
    }
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"cityId":resolved.city_id,"cityRevision":resolved.city_revision,"worldRevision":resolved.world_revision,
        "layoutId":resolved.layout_id,"snapshotDigest":hash,"schemaVersion":resolved.version,
        "geometryCount":resolved.geometry.as_ref().and_then(Value::as_array).map_or(0, Vec::len)}))
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
            "layoutId":layout_id,"seed":snapshot["seed"],"schemaVersion":snapshot["schemaVersion"],
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
    // 统一读取入口：v3 严格校验；v2 归一化（无几何）；其它版本明确拒绝。
    let resolved = match resolve_scoped_layout(&snapshot) {
        Ok(resolved) => resolved,
        Err("creator_layout_snapshot_version_unsupported") => return Err("creator_layout_snapshot_version_unsupported"),
        Err(_) => return Err("creator_layout_scope_mismatch"),
    };
    if resolved.city_id != city_id || resolved.city_revision != city_revision || resolved.world_revision != world_revision
        || resolved.layout_id != layout_id {
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
    // 统一读取入口（v2 归一化、v3 严格校验、其它版本拒绝）。缺 schemaVersion 的快照是损坏
    // 数据，不再静默按 v2 处理——写回会把它降级。
    let resolved = resolve_scoped_layout(&layout)?;
    let world_revision = resolved.world_revision.clone();
    let layout_id = resolved.layout_id.clone();
    let mut merged: Vec<Value> = resolved.layout["anchors"].as_array().ok_or("creator_layout_snapshot_invalid")?.clone();
    let allowed_geometry: std::collections::HashSet<String> = merged.iter().filter_map(|anchor| anchor["geometryRef"].as_str().map(str::to_owned)).collect();
    // v3 快照才带几何；「自带几何的空域锚点」需要把几何写进快照，所以要求已升级。
    let snapshot_version = resolved.version;
    let mut extra_geometry: Vec<Value> = Vec::new();
    for addition in additions {
        let object = addition.as_object().ok_or("creator_city_anchor_invalid")?;
        let id = object.get("id").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_city_anchor_invalid")?;
        let capabilities = object.get("capabilities").and_then(Value::as_array).ok_or("creator_city_anchor_invalid")?;
        if capabilities.is_empty() || capabilities.len() > 3
            || capabilities.iter().any(|item| !matches!(item.as_str(), Some("drive" | "walk" | "fly")))
            || capabilities.iter().enumerate().any(|(index, item)| capabilities[..index].contains(item))
            || !capabilities.iter().any(|item| item.as_str() == Some("fly")) { return Err("creator_city_anchor_invalid"); }
        let kind = object.get("kind").and_then(Value::as_str).unwrap_or("");
        // 两种锚点：复用 City 已有几何（4 键），或自带空域几何（position[/radiusMeters]）。
        let geometry = if object.len() == 4 && only_keys(object, &["id", "kind", "capabilities", "geometryRef"]) {
            object.get("geometryRef").and_then(Value::as_str).filter(|value| allowed_geometry.contains(*value))
                .ok_or("creator_city_anchor_geometry_unknown")?.to_owned()
        } else if (object.len() == 4 || object.len() == 5)
            && only_keys(object, &["id", "kind", "capabilities", "position", "radiusMeters"]) {
            if snapshot_version != 3 { return Err("creator_city_layout_geometry_required"); }
            let position = object.get("position").and_then(Value::as_object)
                .filter(|position| position.len() == 3 && only_keys(position, &["x", "y", "z"]))
                .ok_or("creator_city_anchor_invalid")?;
            if !["x", "y", "z"].iter().all(|axis| position.get(*axis).and_then(Value::as_f64).is_some_and(f64::is_finite)) {
                return Err("creator_city_anchor_invalid");
            }
            // zone/route 是触发区，必须有半径；spawn/object 不需要。
            let radius = object.get("radiusMeters").and_then(Value::as_f64);
            if matches!(kind, "zone" | "route") && !radius.is_some_and(|value| value.is_finite() && value > 0.0 && value <= 2_000.0) {
                return Err("creator_city_anchor_radius_required");
            }
            if let Some(radius) = radius {
                if !(radius.is_finite() && radius > 0.0 && radius <= 2_000.0) { return Err("creator_city_anchor_invalid"); }
            }
            let reference = format!("creator-air:{id}");
            if !valid_id(&reference) { return Err("creator_city_anchor_invalid"); }
            let mut entry = json!({"geometryRef":reference,
                "positionMeters":{"x":position["x"],"y":position["y"],"z":position["z"]}});
            if let Some(radius) = radius { entry["activationRadiusMeters"] = json!(radius); }
            extra_geometry.push(entry);
            reference
        } else {
            return Err("creator_city_anchor_invalid");
        };
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
    // 64 是布局快照的锚点硬上限：一张满员的道路 City 再加空域门会超限。
    // 必须在合并后显式判定，否则会被下面的布局校验笼统报成 snapshot_invalid，
    // 调用方看不出是预算问题（W2 首次 headless 飞行课程就撞在这）。
    if merged.len() > 64 { return Err("creator_city_anchor_budget_exceeded"); }
    let merged_layout = json!({"schemaVersion":1,"id":layout_id,"coordinateSystem":"city-local-m-v1","anchors":merged,
        "links":links});
    validate_layout_snapshot(&json!({"schemaVersion":1,"worldRevision":world_revision,"seed":layout["seed"],"layout":merged_layout}))?;
    let next = current.checked_add(1).filter(|revision| *revision <= i64::MAX as u64).ok_or("creator_city_invalid")?;
    let mut document: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    document["revision"] = json!(next);
    let serialized = canonical_json(&document).map_err(|_| "creator_city_invalid")?;
    // v3 快照的几何必须原样带走：锚点增删不改几何，丢了它发布物就再也定位不到门。
    let version = resolved.version;
    let mut snapshot = json!({"schemaVersion":version,"cityId":city_id,"cityRevision":next,"worldRevision":world_revision,
        "seed":layout["seed"],"layout":merged_layout});
    if version == 3 {
        // 既有几何 ∪ 新增空域几何，再按锚点实际引用的 ref 过滤（删掉被移除锚点的几何、
        // 也丢掉新锚点带来的重复项），最后要求全覆盖——v3 的"可复现"契约就靠这一步。
        let mut entries: Vec<Value> = layout.get("geometry").and_then(Value::as_array).cloned().unwrap_or_default();
        for entry in extra_geometry {
            let reference = entry["geometryRef"].as_str().map(str::to_owned);
            if let Some(reference) = reference { entries.retain(|existing| existing["geometryRef"].as_str() != Some(reference.as_str())); }
            entries.push(entry);
        }
        let referenced: std::collections::HashSet<&str> = snapshot["layout"]["anchors"].as_array()
            .map(|anchors| anchors.iter().filter_map(|anchor| anchor["geometryRef"].as_str()).collect()).unwrap_or_default();
        entries.retain(|entry| entry["geometryRef"].as_str().is_some_and(|reference| referenced.contains(reference)));
        let geometry = json!(entries);
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

    /// 空域锚点自带几何：position(+radiusMeters) → `creator-air:<id>` 的几何条目写进 v3 快照。
    /// 这是"用 MCP 布一条可飞的门道"的前提——复用路网节点只能拿到地面上的同一个点。
    #[test]
    fn airspace_anchors_can_carry_their_own_geometry() {
        let home = home();
        let created = crate::creator_cities::create_city(&home, "local-profile", "create-air-anchor", "Air", 12, &json!({"schemaVersion":1})).unwrap();
        let city_id = created["cityId"].as_str().unwrap();
        let base = json!({"schemaVersion":3,"cityId":city_id,"cityRevision":0,"worldRevision":"world-air","seed":12,
            "layout":{"schemaVersion":1,"id":"layout-air","coordinateSystem":"city-local-m-v1",
                "anchors":[{"id":"road-spawn:a","kind":"spawn","capabilities":["drive"],"geometryRef":"city-road-node:a"}],"links":[]},
            "geometry":[{"geometryRef":"city-road-node:a","positionMeters":{"x":0,"y":0,"z":0}}]});
        store_scoped_city_layout(&home, &base).unwrap();
        let added = json!([
            {"id":"spawn-air","kind":"spawn","capabilities":["fly"],"position":{"x":0,"y":60,"z":0}},
            {"id":"gate-north","kind":"zone","capabilities":["fly"],"position":{"x":0,"y":70,"z":120},"radiusMeters":18},
            {"id":"gate-east","kind":"zone","capabilities":["fly"],"position":{"x":120,"y":80,"z":120},"radiusMeters":24}]);
        let result = mutate_city_anchors(&home, "local-profile", city_id, 0, &added, &[], "add-air-course").unwrap();
        assert_eq!(result["revision"], 1);
        let snapshot: Value = {
            let db = database(&home).unwrap();
            serde_json::from_str(&db.query_row("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=1", params![city_id], |row| row.get::<_, String>(0)).unwrap()).unwrap()
        };
        let geometry = snapshot["geometry"].as_array().unwrap();
        let north = geometry.iter().find(|entry| entry["geometryRef"] == "creator-air:gate-north").expect("air gate geometry");
        assert_eq!(north["positionMeters"], json!({"x":0,"y":70,"z":120}));
        assert_eq!(north["activationRadiusMeters"], json!(18.0));
        // 路网锚点的几何原样保留（星形 link 仍然成立）。
        assert!(geometry.iter().any(|entry| entry["geometryRef"] == "city-road-node:a"));
        // zone 必须有半径；v2 快照不能带几何（先升级）。
        let no_radius = json!([{"id":"gate-x","kind":"zone","capabilities":["fly"],"position":{"x":0,"y":1,"z":0}}]);
        assert_eq!(mutate_city_anchors(&home, "local-profile", city_id, 1, &no_radius, &[], "no-radius").unwrap_err(),
            "creator_city_anchor_radius_required");
        let _ = std::fs::remove_dir_all(home);
    }

    /// 同一 (city, revision, worldRevision) 的快照不可变：digest 变了就是冲突。
    /// 带几何的新版本必须走迁移（新 revision），不能原地改写历史。
    #[test]
    fn resaving_a_layout_cannot_mutate_a_historical_snapshot() {
        let home = home();
        let created = crate::creator_cities::create_city(&home, "local-profile", "create-airspace-immutable", "Airspace", 10, &json!({"schemaVersion":1})).unwrap();
        let city_id = created["cityId"].as_str().unwrap();
        let layout = json!({"schemaVersion":1,"id":"layout-immutable","coordinateSystem":"city-local-m-v1",
            "anchors":[{"id":"spawn-air","kind":"spawn","capabilities":["fly"],"geometryRef":"city-road-node:a"}],"links":[]});
        let v2 = json!({"schemaVersion":2,"cityId":city_id,"cityRevision":0,"worldRevision":"world-immutable","seed":10,"layout":layout});
        store_scoped_city_layout(&home, &v2).unwrap();
        let v3_same_layout = json!({"schemaVersion":3,"cityId":city_id,"cityRevision":0,"worldRevision":"world-immutable","seed":10,"layout":layout,
            "geometry":[{"geometryRef":"city-road-node:a","positionMeters":{"x":0,"y":0,"z":0}}]});
        // 原地升级被拒绝：历史快照的 digest 不能变。
        assert_eq!(store_scoped_city_layout(&home, &v3_same_layout).unwrap_err(), "creator_layout_revision_conflict");
        // 迁移才会产生新版本，旧行原样不动。
        let migrated = migrate_city_layout_geometry(&home, city_id, 0, &json!([{"geometryRef":"city-road-node:a","positionMeters":{"x":0,"y":0,"z":0}}])).unwrap();
        assert_eq!(migrated["cityRevision"], 1);
        assert_eq!(migrated["previousRevision"], 0);
        let rows: Vec<(u64, String)> = {
            let db = database(&home).unwrap();
            let mut statement = db.prepare("SELECT city_revision,snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 ORDER BY city_revision").unwrap();
            statement.query_map(params![city_id], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().map(|row| row.unwrap()).collect()
        };
        assert_eq!(rows.len(), 2, "migration must add a version, not overwrite");
        let old: Value = serde_json::from_str(&rows[0].1).unwrap();
        let new: Value = serde_json::from_str(&rows[1].1).unwrap();
        assert_eq!(old["schemaVersion"], 2, "the historical snapshot stays v2");
        assert_eq!(new["schemaVersion"], 3);
        assert_eq!(new["cityRevision"], 1);
    }

    /// 迁移：保留锚点/连线，只补几何，产新 revision；覆盖不全就拒绝。
    #[test]
    fn migration_adds_geometry_in_a_new_revision_and_keeps_creator_anchors() {
        let home = home();
        let created = crate::creator_cities::create_city(&home, "local-profile", "create-geometry-migrate", "Geo", 11, &json!({"schemaVersion":1})).unwrap();
        let city_id = created["cityId"].as_str().unwrap();
        let v2 = json!({"schemaVersion":2,"cityId":city_id,"cityRevision":0,"worldRevision":"world-geo","seed":11,
            "layout":{"schemaVersion":1,"id":"layout-geo","coordinateSystem":"city-local-m-v1",
                "anchors":[{"id":"spawn-air","kind":"spawn","capabilities":["fly"],"geometryRef":"city-road-node:a"},
                    {"id":"air-gate:a","kind":"zone","capabilities":["fly"],"geometryRef":"city-road-node:b"}],
                "links":[{"id":"air-link:a-b","fromAnchorId":"spawn-air","toAnchorId":"air-gate:a","capabilities":["fly"]}]}});
        store_scoped_city_layout(&home, &v2).unwrap();
        let geometry = json!([{"geometryRef":"city-road-node:a","positionMeters":{"x":0,"y":40,"z":0}},
            {"geometryRef":"city-road-node:b","positionMeters":{"x":60,"y":40,"z":0},"activationRadiusMeters":12},
            {"geometryRef":"city-road-node:unused","positionMeters":{"x":1,"y":1,"z":1}}]);
        let migrated = migrate_city_layout_geometry(&home, city_id, 0, &geometry).unwrap();
        assert_eq!(migrated["ignoredGeometryCount"], 1, "extra captures are dropped, not stored");
        assert_eq!(migrated["geometryCount"], 2);
        assert_eq!(migrated["anchorCount"], 2, "creator anchors must survive the migration");
        let stored: Value = {
            let db = database(&home).unwrap();
            serde_json::from_str(&db.query_row("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=1", params![city_id], |row| row.get::<_, String>(0)).unwrap()).unwrap()
        };
        assert_eq!(stored["layout"]["anchors"][1]["id"], "air-gate:a");
        assert_eq!(stored["geometry"].as_array().unwrap().len(), 2);
        // 覆盖不全 → 拒绝（不凭空补造；此时城市已在 revision 1）。
        assert_eq!(migrate_city_layout_geometry(&home, city_id, 1, &json!([{"geometryRef":"city-road-node:a","positionMeters":{"x":0,"y":0,"z":0}}])).unwrap_err(),
            "creator_layout_snapshot_invalid");
        // revision CAS。
        assert_eq!(migrate_city_layout_geometry(&home, city_id, 9, &geometry).unwrap_err(), "revision_conflict");
        let _ = std::fs::remove_dir_all(home);
    }

    /// 锚点编辑也必须经过统一入口：缺 schemaVersion 的快照是坏数据，不能静默按 v2 写回
    /// （那会把一份损坏的 v3 降级成 v2，几何随之丢失）。
    #[test]
    fn anchor_edits_refuse_a_snapshot_without_a_schema_version() {
        let home = home();
        let created = crate::creator_cities::create_city(&home, "local-profile", "create-corrupt-snapshot", "Corrupt", 13, &json!({"schemaVersion":1})).unwrap();
        let city_id = created["cityId"].as_str().unwrap();
        let base = json!({"schemaVersion":2,"cityId":city_id,"cityRevision":0,"worldRevision":"world-corrupt","seed":13,
            "layout":{"schemaVersion":1,"id":"layout-corrupt","coordinateSystem":"city-local-m-v1",
                "anchors":[{"id":"road-spawn:a","kind":"spawn","capabilities":["drive"],"geometryRef":"city-road-node:a"}],"links":[]}});
        store_scoped_city_layout(&home, &base).unwrap();
        // 抹掉 schemaVersion（模拟损坏/旧写入）。
        {
            let db = database(&home).unwrap();
            let mut corrupted = base.clone();
            corrupted.as_object_mut().unwrap().remove("schemaVersion");
            db.execute("UPDATE creator_city_layouts_v2 SET snapshot_json=?1 WHERE city_id=?2", params![corrupted.to_string(), city_id]).unwrap();
        }
        let addition = json!([{"id":"air-gate:z","kind":"zone","capabilities":["fly"],"geometryRef":"city-road-node:a"}]);
        assert_eq!(mutate_city_anchors(&home, "local-profile", city_id, 0, &addition, &[], "corrupt-edit").unwrap_err(),
            "creator_layout_snapshot_invalid");
        let _ = std::fs::remove_dir_all(home);
    }

    /// 统一读取入口：v2 归一化（无几何）、v3 严格校验、别的版本明确拒绝。
    #[test]
    fn resolve_scoped_layout_is_the_single_read_entry() {
        let layout = json!({"schemaVersion":1,"id":"layout-r","coordinateSystem":"city-local-m-v1",
            "anchors":[{"id":"a","kind":"spawn","capabilities":["fly"],"geometryRef":"g:1"}],"links":[]});
        let v2 = json!({"schemaVersion":2,"cityId":"city-r","cityRevision":1,"worldRevision":"w","seed":7,"layout":layout});
        let resolved = resolve_scoped_layout(&v2).unwrap();
        assert_eq!(resolved.version, 2);
        assert!(resolved.geometry.is_none(), "v2 has no geometry and none may be invented");
        assert_eq!(resolved.layout_id, "layout-r");
        let v3 = json!({"schemaVersion":3,"cityId":"city-r","cityRevision":1,"worldRevision":"w","seed":7,"layout":layout,
            "geometry":[{"geometryRef":"g:1","positionMeters":{"x":0,"y":5,"z":0}}]});
        let resolved = resolve_scoped_layout(&v3).unwrap();
        assert_eq!(resolved.version, 3);
        assert_eq!(resolved.geometry.as_ref().unwrap().as_array().unwrap().len(), 1);
        // v3 少了锚点引用的几何 → 拒绝（不能声称可复现）。
        let incomplete = json!({"schemaVersion":3,"cityId":"city-r","cityRevision":1,"worldRevision":"w","seed":7,"layout":layout,"geometry":[]});
        assert_eq!(resolve_scoped_layout(&incomplete).unwrap_err(), "creator_layout_snapshot_invalid");
        // 未知版本明确拒绝。
        let v9 = json!({"schemaVersion":9,"cityId":"city-r","cityRevision":1,"worldRevision":"w","seed":7,"layout":layout});
        assert_eq!(resolve_scoped_layout(&v9).unwrap_err(), "creator_layout_snapshot_version_unsupported");
        // v2 带 geometry 字段是坏数据。
        let mut tainted = v2.clone();
        tainted["geometry"] = json!([]);
        assert_eq!(resolve_scoped_layout(&tainted).unwrap_err(), "creator_layout_snapshot_invalid");
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
