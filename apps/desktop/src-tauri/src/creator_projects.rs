//! Local authority for Agent City creator projects.
//! Drafts and revisions are isolated from the analytical authority database.
//! WebView/MCP identity and foreground authorization are enforced by the caller.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, sync::{Mutex, OnceLock}, time::{Duration, SystemTime, UNIX_EPOCH}};

const MAX_GAME_BYTES: usize = 256 * 1024;
const MAX_PROJECT_BYTES: usize = 2 * 1024 * 1024;
const MAX_RELEASE_BYTES: usize = 512 * 1024;
const MAX_RELEASE_MOUNTS: usize = 32;
const MAX_SCENE_OBJECTS: usize = 10_000;
const MAX_SCENE_COLLIDERS: usize = 256;
const MAX_RELEASE_COLLIDERS: usize = 64;
const MAX_IMPORTED_MODEL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PROJECT_ASSETS: usize = 4_096;
const PREVIEW_TTL: Duration = Duration::from_secs(600);
const PLAYTEST_TTL_MS: u64 = 30 * 60 * 1000;
const MAX_PLAYTEST_HISTORY: i64 = 64;
const MAX_PLAYTEST_EVIDENCE_BYTES: usize = 8 * 1024;
const MAX_PLAYTEST_COUNTERS: usize = 32;
const MAX_PLAYTEST_TICKS: u64 = 2_000_000;
const MAX_ACTIVE_PREVIEWS: usize = 128;
// 城市补丁（切片 2：旧 patch 导入与共享 revision）。Rust 只做结构、预算与种子一致性
// 校验（AGENTS.md 插件面政策）；几何/语义校验由 City 引擎在套用时执行。
const MAX_CITY_PATCH_BYTES: usize = 256 * 1024;
/// creator.scene.validate 的单次资产字节核对预算（超出部分如实标注 skipped）。
const MAX_VALIDATE_ASSET_CHECKS: usize = 64;
const MAX_CITY_PATCH_OPS: usize = 4_096;
const MAX_CITY_PATCH_HIGHWAY_OPS: usize = 1_024;
// 玩家土方尚未进入本切片的操作契约：作为有界透传收下，语义校验留给 City 引擎。
const MAX_CITY_PATCH_TERRAIN_OPS: usize = 256;
const MAX_PATCH_COORD: f64 = 1_000_000.0;
const MAX_PATCH_ROAD_WIDTH: f64 = 64.0;
// This desktop app currently has one local profile per OS data_home. Keep the
// persistent operation principal separate from the ephemeral WebView instance:
// operation retries must remain queryable after Studio is closed and reopened.
// Preview capabilities below remain bound to the exact live instance.
pub(crate) const LOCAL_CREATOR_OWNER: &str = "local-profile-v1";

#[derive(Clone)]
struct Preview {
    actor: String,
    project_id: String,
    base_revision: u64,
    operation_hash: String,
    document: String,
    created: SystemTime,
}

fn previews() -> &'static Mutex<HashMap<String, Preview>> {
    static PREVIEWS: OnceLock<Mutex<HashMap<String, Preview>>> = OnceLock::new();
    PREVIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn digest(text: &str) -> String { format!("sha256:{:x}", Sha256::digest(text.as_bytes())) }
fn bytes_digest(bytes: &[u8]) -> String { format!("sha256:{:x}", Sha256::digest(bytes)) }
fn canonical_json(value: &Value) -> Result<String, serde_json::Error> {
    fn write(value: &Value, output: &mut String) -> Result<(), serde_json::Error> {
        match value {
            Value::Object(object) => {
                output.push('{');
                let mut keys: Vec<&String> = object.keys().collect();
                keys.sort();
                for (index, key) in keys.iter().enumerate() {
                    if index > 0 { output.push(','); }
                    output.push_str(&serde_json::to_string(key)?);
                    output.push(':');
                    write(&object[*key], output)?;
                }
                output.push('}');
            }
            Value::Array(items) => {
                output.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 { output.push(','); }
                    write(item, output)?;
                }
                output.push(']');
            }
            _ => output.push_str(&serde_json::to_string(value)?),
        }
        Ok(())
    }
    let mut output = String::new();
    write(value, &mut output)?;
    Ok(output)
}
fn valid_id(value: &str) -> bool { !value.is_empty() && value.len() <= 128 && value.as_bytes()[0].is_ascii_alphanumeric() && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-')) }
fn valid_skin_id(value: &str) -> bool { matches!(value, "miami-vice" | "desert-evening") }
fn only_keys(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool { object.keys().all(|key| allowed.contains(&key.as_str())) }

fn database(home: &Path) -> Result<Connection, &'static str> {
    let directory = home.join("state/creator");
    std::fs::create_dir_all(&directory).map_err(|_| "creator_store_unavailable")?;
    let db = Connection::open(directory.join("projects.sqlite")).map_err(|_| "creator_store_unavailable")?;
    db.busy_timeout(Duration::from_secs(3)).map_err(|_| "creator_store_unavailable")?;
    db.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS creator_projects (
            project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS creator_changes (
            project_id TEXT NOT NULL, revision INTEGER NOT NULL, actor_id TEXT NOT NULL,
            operation_id TEXT NOT NULL, operation_hash TEXT NOT NULL, document_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL, PRIMARY KEY(project_id, revision)
        );
        CREATE TABLE IF NOT EXISTS creator_operations (
            project_id TEXT NOT NULL, actor_id TEXT NOT NULL, operation_id TEXT NOT NULL,
            operation_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(project_id, actor_id, operation_id)
        );
        CREATE TABLE IF NOT EXISTS creator_city_layouts (
            world_revision TEXT PRIMARY KEY, layout_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
            snapshot_digest TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS creator_city_patches (
            seed INTEGER PRIMARY KEY, patch_json TEXT NOT NULL, patch_digest TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS creator_releases (
            release_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
            layout_id TEXT NOT NULL, world_revision TEXT NOT NULL, snapshot_json TEXT NOT NULL,
            snapshot_digest TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, revision)
        );
        CREATE TABLE IF NOT EXISTS creator_playtest_runs (
            run_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, project_id TEXT NOT NULL,
            revision INTEGER NOT NULL, studio_instance_id TEXT NOT NULL, city_instance_id TEXT,
            status TEXT NOT NULL, active_slot INTEGER UNIQUE, created_at_ms INTEGER NOT NULL,
            expires_at_ms INTEGER NOT NULL, finished_at_ms INTEGER, return_consumed INTEGER NOT NULL DEFAULT 0,
            evidence_json TEXT, failure_code TEXT
        );") .map_err(|_| "creator_store_unavailable")?;
    let columns = {
        let mut statement = db.prepare("PRAGMA table_info(creator_playtest_runs)").map_err(|_| "creator_store_unavailable")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|_| "creator_store_unavailable")?;
        let columns = rows.collect::<Result<Vec<_>, _>>().map_err(|_| "creator_store_unavailable")?;
        columns
    };
    if !columns.iter().any(|column| column == "evidence_json") {
        db.execute("ALTER TABLE creator_playtest_runs ADD COLUMN evidence_json TEXT", []).map_err(|_| "creator_store_unavailable")?;
    }
    if !columns.iter().any(|column| column == "failure_code") {
        db.execute("ALTER TABLE creator_playtest_runs ADD COLUMN failure_code TEXT", []).map_err(|_| "creator_store_unavailable")?;
    }
    Ok(db)
}

fn new_id(prefix: &str) -> Result<String, &'static str> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "creator_id_unavailable")?;
    Ok(format!("{prefix}{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
}

fn game_template(template: &str) -> Result<Value, &'static str> {
    let value = match template {
        "checkpoint-race" => json!({
            "schemaVersion":1,"id":"creator.checkpoint-race","rulesVersion":1,
            // points 下限必须与完成条件一致：计数器 next 的上限与 finish 的判定都是
            // 固定 3（counter.eq value:3）。曾允许 min:2——绑两个检查点的竞速永远
            // 无法完成（计数到 2 就封顶，finish 条件够不着）。
            "slots":{"points":{"kind":"zone","min":3,"max":8,"requires":["drive"]}},
            "integerParameters":{"timeLimitTicks":{"min":60,"max":36000,"default":2700}},
            "rules":{"counters":{"next":{"initial":0,"max":3}},"nodes":[
                {"id":"start-timer","on":{"type":"run.started"},"actions":[{"op":"timer.start","timerId":"timeout","durationTicks":{"parameter":"timeLimitTicks"}}]},
                {"id":"advance","on":{"type":"zone.entered","slot":"points"},"when":[{"op":"counter.eqEventIndex","counter":"next"}],"actions":[{"op":"counter.add","counter":"next","amount":1}]},
                {"id":"finish","on":{"type":"zone.entered","slot":"points"},"when":[{"op":"counter.eq","counter":"next","value":3}],"actions":[{"op":"run.finish","outcome":"success"}]},
                {"id":"timeout","on":{"type":"timer.expired","timerId":"timeout"},"actions":[{"op":"run.finish","outcome":"failure"}]}
            ]}
        }),
        "collect-one" => json!({
            "schemaVersion":1,"id":"creator.collect-one","rulesVersion":1,
            "slots":{"targets":{"kind":"zone","min":1,"max":1,"requires":["drive"]}},
            "rules":{"counters":{"found":{"initial":0,"max":1}},"nodes":[
                {"id":"collect","on":{"type":"zone.entered","slot":"targets"},"actions":[{"op":"counter.add","counter":"found","amount":1}]},
                {"id":"finish","on":{"type":"zone.entered","slot":"targets"},"when":[{"op":"counter.eq","counter":"found","value":1}],"actions":[{"op":"run.finish","outcome":"success"}]}
            ]}
        }),
        _ => return Err("creator_template_not_found"),
    };
    Ok(value)
}

fn validate_game(game: &Value) -> Result<String, &'static str> {
    let object = game.as_object().ok_or("creator_game_invalid")?;
    if object.len() > 6 || !only_keys(object, &["schemaVersion", "id", "rulesVersion", "slots", "integerParameters", "rules"])
        || object.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || object.get("rulesVersion").and_then(Value::as_u64) != Some(1)
        || !object.get("id").and_then(Value::as_str).is_some_and(valid_id) { return Err("creator_game_invalid"); }
    let slots = object.get("slots").and_then(Value::as_object).ok_or("creator_game_invalid")?;
    if slots.len() > 32 { return Err("creator_game_budget_exceeded"); }
    let mut slot_kinds = std::collections::HashMap::new();
    for (slot_id, slot) in slots {
        let slot = slot.as_object().ok_or("creator_game_invalid")?;
        if !valid_id(slot_id) || !only_keys(slot, &["kind", "min", "max", "requires"])
            || !matches!(slot.get("kind").and_then(Value::as_str), Some("spawn" | "route" | "zone" | "object"))
            || slot.get("min").and_then(Value::as_u64).is_none_or(|n| n > 64)
            || slot.get("max").and_then(Value::as_u64).is_none_or(|n| n > 64)
            || slot.get("min").and_then(Value::as_u64) > slot.get("max").and_then(Value::as_u64) { return Err("creator_game_invalid"); }
        slot_kinds.insert(slot_id.as_str(), slot["kind"].as_str().unwrap_or_default());
        if slot.get("requires").is_some_and(|value| !value.as_array().is_some_and(|items| items.len() <= 2 && items.iter().all(|item| matches!(item.as_str(), Some("drive" | "walk"))))) { return Err("creator_game_invalid"); }
    }
    let parameters = match object.get("integerParameters") { None => None, Some(value) => Some(value.as_object().ok_or("creator_game_invalid")?) };
    if parameters.is_some_and(|items| items.len() > 32) { return Err("creator_game_budget_exceeded"); }
    if let Some(parameters) = parameters {
        for (name, parameter) in parameters {
            let parameter = parameter.as_object().ok_or("creator_game_invalid")?;
            if !valid_id(name) || parameter.len() != 3 || !only_keys(parameter, &["min", "max", "default"])
                || ["min", "max", "default"].iter().any(|key| parameter.get(*key).and_then(Value::as_u64).is_none_or(|v| v > 1_000_000))
                || parameter["min"].as_u64() > parameter["max"].as_u64()
                || parameter["default"].as_u64() < parameter["min"].as_u64()
                || parameter["default"].as_u64() > parameter["max"].as_u64() { return Err("creator_game_invalid"); }
        }
    }
    let rules = object.get("rules").and_then(Value::as_object).ok_or("creator_game_invalid")?;
    if rules.len() != 2 || !rules.contains_key("counters") || !rules.contains_key("nodes") { return Err("creator_game_invalid"); }
    let counters = rules.get("counters").and_then(Value::as_object).ok_or("creator_game_invalid")?;
    let nodes = rules.get("nodes").and_then(Value::as_array).ok_or("creator_game_invalid")?;
    if counters.len() > 32 || nodes.len() > 128 { return Err("creator_game_budget_exceeded"); }
    let counter_ids: std::collections::HashSet<&str> = counters.keys().map(String::as_str).collect();
    for (name, counter) in counters {
        let counter = counter.as_object().ok_or("creator_game_invalid")?;
        if !valid_id(name) || counter.len() != 2 || !only_keys(counter, &["initial", "max"])
            || counter.get("initial").and_then(Value::as_u64).is_none_or(|v| v > 1_000_000_000)
            || counter.get("max").and_then(Value::as_u64).is_none_or(|v| v > 1_000_000_000)
            || counter["initial"].as_u64() > counter["max"].as_u64() { return Err("creator_game_invalid"); }
    }
    let mut node_ids = std::collections::HashSet::new();
    for node in nodes {
        let node = node.as_object().ok_or("creator_game_invalid")?;
        if node.len() < 3 || !only_keys(node, &["id", "on", "when", "actions"])
            || !node.get("id").and_then(Value::as_str).is_some_and(valid_id)
            || !node_ids.insert(node["id"].as_str().unwrap_or_default()) { return Err("creator_game_invalid"); }
        let event = node.get("on").and_then(Value::as_object).ok_or("creator_game_invalid")?;
        let event_type = event.get("type").and_then(Value::as_str).ok_or("creator_game_invalid")?;
        if !matches!(event_type, "run.started" | "zone.entered" | "item.collected" | "timer.expired") { return Err("creator_game_invalid"); }
        if event_type == "run.started" && (event.len() != 1 || !only_keys(event, &["type"])) { return Err("creator_game_invalid"); }
        if matches!(event_type, "zone.entered" | "item.collected") && (event.len() != 2 || !only_keys(event, &["type", "slot"]) || !event.get("slot").and_then(Value::as_str).is_some_and(|slot| slots.contains_key(slot))) { return Err("creator_game_invalid"); }
        if event_type == "zone.entered" && !event.get("slot").and_then(Value::as_str).is_some_and(|slot| slot_kinds.get(slot) == Some(&"zone")) { return Err("creator_game_invalid"); }
        if event_type == "timer.expired" && (event.len() != 2 || !only_keys(event, &["type", "timerId"]) || !event.get("timerId").and_then(Value::as_str).is_some_and(valid_id)) { return Err("creator_game_invalid"); }
        if let Some(guards) = node.get("when") {
            let guards = guards.as_array().filter(|guards| guards.len() <= 8).ok_or("creator_game_invalid")?;
            for guard in guards {
                let guard = guard.as_object().ok_or("creator_game_invalid")?;
                if !guard.get("counter").and_then(Value::as_str).is_some_and(|name| counter_ids.contains(name)) { return Err("creator_game_invalid"); }
                match guard.get("op").and_then(Value::as_str) {
                    Some("counter.eq") if guard.len() == 3 && only_keys(guard, &["op", "counter", "value"]) && guard.get("value").and_then(Value::as_u64).is_some_and(|v| v <= 1_000_000_000) => {},
                    Some("counter.eqEventIndex") if guard.len() == 2 && only_keys(guard, &["op", "counter"]) && matches!(event_type, "zone.entered" | "item.collected") => {},
                    _ => return Err("creator_game_invalid"),
                }
            }
        }
        let actions = node.get("actions").and_then(Value::as_array).filter(|actions| actions.len() <= 16).ok_or("creator_game_invalid")?;
        for action in actions {
            let action = action.as_object().ok_or("creator_game_invalid")?;
            match action.get("op").and_then(Value::as_str) {
                Some("counter.add") if action.len() == 3 && only_keys(action, &["op", "counter", "amount"]) && action.get("counter").and_then(Value::as_str).is_some_and(|id| counter_ids.contains(id))
                    && action.get("amount").and_then(Value::as_i64).is_some_and(|amount| (-1_000_000..=1_000_000).contains(&amount)) => {},
                Some("timer.start") if action.len() == 3 && only_keys(action, &["op", "timerId", "durationTicks"]) && action.get("timerId").and_then(Value::as_str).is_some_and(valid_id)
                    && action.get("durationTicks").is_some_and(|value| value.as_u64().is_some_and(|ticks| (1..=1_000_000).contains(&ticks))
                        || value.as_object().is_some_and(|parameter| parameter.len() == 1 && only_keys(parameter, &["parameter"]) && parameter.get("parameter").and_then(Value::as_str).is_some_and(|name| parameters.is_some_and(|all| all.contains_key(name))))) => {},
                Some("hud.hint") if action.len() == 2 && only_keys(action, &["op", "text"]) && action.get("text").and_then(Value::as_str).is_some_and(|text| text.len() <= 160) => {},
                Some("run.finish") if action.len() == 2 && only_keys(action, &["op", "outcome"]) && matches!(action.get("outcome").and_then(Value::as_str), Some("success" | "failure")) => {},
                _ => return Err("creator_game_operation_unsupported"),
            }
        }
    }
    let serialized = serde_json::to_string(game).map_err(|_| "creator_game_invalid")?;
    if serialized.len() > MAX_GAME_BYTES { return Err("creator_game_budget_exceeded"); }
    Ok(serialized)
}

fn validate_layout_snapshot(value: &Value) -> Result<(&str, &str), &'static str> {
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
            "anchorCount":snapshot["layout"]["anchors"].as_array().map_or(0, Vec::len),"updatedAtMs":updated_at_ms}))
    }).collect::<Result<Vec<_>, &'static str>>()?;
    Ok(json!({"layouts":catalogs}))
}

fn read_city_layout_snapshot(home: &Path, world_revision: &str) -> Result<Value, &'static str> {
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
    let class_ok = |value: Option<&Value>| value.map_or(true, |cls| cls.as_str().is_some_and(|cls| !cls.is_empty() && cls.len() <= 128));
    let target_ok = |value: Option<&Value>| value.map_or(true, |to| to.as_str().is_some_and(|to| !to.is_empty() && to.len() <= 128));
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
fn validate_city_patch(patch: &Value, expected_seed: u64) -> Result<(), &'static str> {
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

fn latest_city_patch(home: &Path, seed: u64) -> Result<Option<(Value, String)>, &'static str> {
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

#[cfg(test)]
fn create_project(home: &Path, actor: &str, template: &str, operation_id: &str) -> Result<Value, &'static str> {
    create_project_internal(home, actor, template, operation_id, None)
}

pub fn create_project_from_city_layout(home: &Path, actor: &str, template: &str, operation_id: &str, world_revision: &str) -> Result<Value, &'static str> {
    let snapshot = read_city_layout_snapshot(home, world_revision)?;
    create_project_internal(home, actor, template, operation_id, Some(snapshot))
}

fn create_project_internal(home: &Path, actor: &str, template: &str, operation_id: &str, city_layout: Option<Value>) -> Result<Value, &'static str> {
    if actor.is_empty() || actor.len() > 128 || !valid_id(operation_id) { return Err("creator_request_invalid"); }
    let game = game_template(template)?;
    let game_json = validate_game(&game)?;
    let project_id = new_id("project-")?;
    let title = if template == "checkpoint-race" { "驾驶检查点竞速" } else { "驾驶区域收集" };
    let layout_revision = city_layout.as_ref().and_then(|snapshot| snapshot.get("worldRevision")).and_then(Value::as_str).unwrap_or("unbound").to_owned();
    let mut document_value = json!({"schemaVersion":1,"projectId":project_id,"revision":0,"title":title,
        "kind":"city-minigame-project","cityLayout":city_layout,"game":serde_json::from_str::<Value>(&game_json).map_err(|_| "creator_game_invalid")?,"scene":{"schemaVersion":1,"objects":[]},"assets":{"schemaVersion":1,"entries":[]},"assetRefs":[],"mounts":[]});
    // 旧补丁导入（PRD §4 / 架构 §6）：项目创建时读取 City 已发布的同种子补丁。
    // 发布按摘要幂等、创建按 operationId 幂等，导入重试不会产生重复项目或重复补丁。
    if let Some(seed) = document_value.get("cityLayout").and_then(|layout| layout.get("seed")).and_then(Value::as_u64) {
        if let Some((patch, patch_digest)) = latest_city_patch(home, seed)? {
            document_value["cityPatch"] = patch;
            document_value["cityPatchImport"] = json!({"digest":patch_digest,"importedAtMs":now_ms(),"source":"city-publish"});
        }
    }
    let document = serde_json::to_string(&document_value).map_err(|_| "creator_store_unavailable")?;
    let db = database(home)?;
    let mut db = db;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let creation_hash = digest(&format!("{template}:{layout_revision}"));
    let existing: Option<(String, String)> = tx.query_row("SELECT operation_hash,result_json FROM creator_operations WHERE project_id='new' AND actor_id=?1 AND operation_id=?2", params![actor, operation_id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?;
    if let Some((previous_hash, result)) = existing {
        if previous_hash != creation_hash { return Err("operation_id_conflict"); }
        return serde_json::from_str(&result).map_err(|_| "creator_store_unavailable");
    }
    let now = now_ms();
    tx.execute("INSERT INTO creator_projects(project_id,revision,document_json,created_at_ms,updated_at_ms) VALUES(?1,0,?2,?3,?3)", params![project_id, document, now]).map_err(|_| "creator_store_unavailable")?;
    tx.execute("INSERT INTO creator_changes(project_id,revision,actor_id,operation_id,operation_hash,document_json,created_at_ms) VALUES(?1,0,?2,?3,?4,?5,?6)", params![project_id, actor, operation_id, digest(&game_json), document, now]).map_err(|_| "creator_store_unavailable")?;
    let result = json!({"projectId":project_id,"revision":0});
    tx.execute("INSERT INTO creator_operations(project_id,actor_id,operation_id,operation_hash,result_json,created_at_ms) VALUES('new',?1,?2,?3,?4,?5)", params![actor, operation_id, creation_hash, result.to_string(), now]).map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

pub fn read_project(home: &Path, project_id: &str) -> Result<Value, &'static str> {
    if !valid_id(project_id) { return Err("creator_project_not_found"); }
    let db = database(home)?;
    let raw: String = db.query_row("SELECT document_json FROM creator_projects WHERE project_id=?1", [project_id], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_project_not_found")?;
    serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")
}

fn inspect_glb(bytes: &[u8]) -> Result<Value, &'static str> {
    if bytes.len() < 20 || &bytes[..4] != b"glTF"
        || u32::from_le_bytes(bytes[4..8].try_into().map_err(|_| "creator_asset_invalid")?) != 2
        || u32::from_le_bytes(bytes[8..12].try_into().map_err(|_| "creator_asset_invalid")?) as usize != bytes.len() {
        return Err("creator_asset_glb_invalid");
    }
    let mut offset = 12usize;
    let mut json_chunk: Option<&[u8]> = None;
    let mut bin_length = 0usize;
    while offset < bytes.len() {
        if offset.saturating_add(8) > bytes.len() { return Err("creator_asset_glb_invalid"); }
        let length = u32::from_le_bytes(bytes[offset..offset + 4].try_into().map_err(|_| "creator_asset_glb_invalid")?) as usize;
        let kind = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().map_err(|_| "creator_asset_glb_invalid")?);
        offset += 8;
        let end = offset.checked_add(length).filter(|end| *end <= bytes.len()).ok_or("creator_asset_glb_invalid")?;
        match kind {
            0x4e4f534a if json_chunk.is_none() => json_chunk = Some(&bytes[offset..end]),
            0x004e4942 if bin_length == 0 => bin_length = length,
            _ => return Err("creator_asset_glb_invalid"),
        }
        offset = end;
    }
    let json_bytes = json_chunk.ok_or("creator_asset_glb_invalid")?;
    let document: Value = serde_json::from_slice(json_bytes).map_err(|_| "creator_asset_glb_invalid")?;
    if document.get("asset").and_then(|asset| asset.get("version")).and_then(Value::as_str) != Some("2.0") {
        return Err("creator_asset_glb_invalid");
    }
    if document.get("buffers").and_then(Value::as_array).is_some_and(|buffers| buffers.iter().any(|buffer| buffer.get("uri").is_some()))
        || document.get("images").and_then(Value::as_array).is_some_and(|images| images.iter().any(|image| image.get("uri").is_some())) {
        return Err("creator_asset_external_resource_denied");
    }
    if document.get("extensionsUsed").and_then(Value::as_array).is_some_and(|extensions| !extensions.is_empty())
        || document.get("extensionsRequired").and_then(Value::as_array).is_some_and(|extensions| !extensions.is_empty())
        || document.get("skins").and_then(Value::as_array).is_some_and(|skins| !skins.is_empty())
        || document.get("animations").and_then(Value::as_array).is_some_and(|animations| !animations.is_empty())
        || document.get("buffers").and_then(Value::as_array).is_none_or(|buffers| buffers.len() != 1)
        || document.get("bufferViews").and_then(Value::as_array).is_none_or(|views| views.is_empty() || views.len() > 16_384)
        || document.get("accessors").and_then(Value::as_array).is_none_or(|accessors| accessors.is_empty() || accessors.len() > 16_384)
        || document.get("meshes").and_then(Value::as_array).is_none_or(|meshes| meshes.is_empty() || meshes.len() > 512)
        || document.get("nodes").and_then(Value::as_array).is_some_and(|nodes| nodes.len() > 4_096) {
        return Err("creator_asset_budget_exceeded");
    }
    let declared_bin = document.get("buffers").and_then(Value::as_array).and_then(|buffers| buffers.first())
        .and_then(|buffer| buffer.get("byteLength")).and_then(Value::as_u64).unwrap_or(0) as usize;
    if declared_bin == 0 || bin_length == 0 || declared_bin > bin_length { return Err("creator_asset_glb_invalid"); }
    let views = document.get("bufferViews").and_then(Value::as_array).ok_or("creator_asset_glb_invalid")?;
    for view in views {
        if view.get("buffer").and_then(Value::as_u64) != Some(0) { return Err("creator_asset_glb_invalid"); }
        let start = view.get("byteOffset").and_then(Value::as_u64).unwrap_or(0);
        let length = view.get("byteLength").and_then(Value::as_u64).filter(|length| *length > 0).ok_or("creator_asset_glb_invalid")?;
        if start.saturating_add(length) > declared_bin as u64 || view.get("byteStride").and_then(Value::as_u64).is_some_and(|stride| !(4..=252).contains(&stride)) {
            return Err("creator_asset_glb_invalid");
        }
    }
    let accessors = document.get("accessors").and_then(Value::as_array).ok_or("creator_asset_glb_invalid")?;
    for accessor in accessors {
        if accessor.get("sparse").is_some() || accessor.get("count").and_then(Value::as_u64).is_none_or(|count| count == 0 || count > 1_000_000)
            || accessor.get("bufferView").and_then(Value::as_u64).is_none_or(|index| index as usize >= views.len()) {
            return Err("creator_asset_budget_exceeded");
        }
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let mut found_position = false;
    let mut primitive_count = 0usize;
    let mut total_position_vertices = 0u64;
    for mesh in document["meshes"].as_array().ok_or("creator_asset_glb_invalid")? {
        for primitive in mesh.get("primitives").and_then(Value::as_array).ok_or("creator_asset_glb_invalid")? {
            primitive_count = primitive_count.saturating_add(1);
            if primitive_count > 2_048 { return Err("creator_asset_budget_exceeded"); }
            let index = primitive.get("attributes").and_then(|attributes| attributes.get("POSITION")).and_then(Value::as_u64).ok_or("creator_asset_glb_invalid")? as usize;
            let accessor = accessors.get(index).ok_or("creator_asset_glb_invalid")?;
            if accessor.get("type").and_then(Value::as_str) != Some("VEC3") || accessor.get("componentType").and_then(Value::as_u64) != Some(5126) {
                return Err("creator_asset_geometry_unsupported");
            }
            total_position_vertices = total_position_vertices.saturating_add(accessor.get("count").and_then(Value::as_u64).unwrap_or(u64::MAX));
            if total_position_vertices > 1_000_000 { return Err("creator_asset_budget_exceeded"); }
            let low = accessor.get("min").and_then(Value::as_array).filter(|values| values.len() == 3).ok_or("creator_asset_bounds_invalid")?;
            let high = accessor.get("max").and_then(Value::as_array).filter(|values| values.len() == 3).ok_or("creator_asset_bounds_invalid")?;
            for axis in 0..3 {
                let lo = low[axis].as_f64().filter(|value| value.is_finite()).ok_or("creator_asset_bounds_invalid")?;
                let hi = high[axis].as_f64().filter(|value| value.is_finite() && *value >= lo).ok_or("creator_asset_bounds_invalid")?;
                min[axis] = min[axis].min(lo);
                max[axis] = max[axis].max(hi);
            }
            found_position = true;
        }
    }
    if !found_position { return Err("creator_asset_bounds_invalid"); }
    let dimensions = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    if dimensions.iter().any(|value| !value.is_finite() || *value <= 0.0 || *value > 10_000.0) { return Err("creator_asset_bounds_invalid"); }
    Ok(json!({"x":dimensions[0],"y":dimensions[1],"z":dimensions[2]}))
}

/// Import a GLB selected by the native desktop file picker. The source path is
/// never returned to the WebView or accepted from an MCP request.
pub fn import_model_asset(home: &Path, owner: &str, project_id: &str, expected_revision: u64, operation_id: &str, source: &Path) -> Result<Value, &'static str> {
    if owner.is_empty() || owner.len() > 128 || !valid_id(project_id) || !valid_id(operation_id) { return Err("creator_request_invalid"); }
    let metadata = std::fs::symlink_metadata(source).map_err(|_| "creator_asset_read_failed")?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || metadata.len() < 20 || metadata.len() > MAX_IMPORTED_MODEL_BYTES {
        return Err("creator_asset_size_invalid");
    }
    let bytes = std::fs::read(source).map_err(|_| "creator_asset_read_failed")?;
    if bytes.len() as u64 != metadata.len() { return Err("creator_asset_read_failed"); }
    let bounds = inspect_glb(&bytes)?;
    let asset_digest = bytes_digest(&bytes);
    let hash = asset_digest.strip_prefix("sha256:").ok_or("creator_asset_invalid")?;
    let asset_id = format!("model-{}", &hash[..32]);
    let relative_path = format!("assets/{hash}.glb");
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let (revision, raw): (u64, String) = tx.query_row("SELECT revision,document_json FROM creator_projects WHERE project_id=?1", [project_id],
        |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_project_not_found")?;
    let mut document: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    let (world_revision, layout_id) = {
        let layout = document.get("cityLayout").filter(|value| !value.is_null()).ok_or("creator_layout_not_bound")?;
        let (world_revision, layout_id) = validate_layout_snapshot(layout)?;
        (world_revision.to_owned(), layout_id.to_owned())
    };
    let package = json!({"kind":"city-layout","id":layout_id,"version":"1","digest":world_revision});
    let asset_ref = json!({"package":package,"assetId":asset_id,"digest":asset_digest});
    let request_hash = digest(&format!("{project_id}:{expected_revision}:{asset_digest}"));
    if let Some((previous_hash, result)) = tx.query_row("SELECT operation_hash,result_json FROM creator_operations WHERE project_id=?1 AND actor_id=?2 AND operation_id=?3",
        params![project_id, owner, operation_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional().map_err(|_| "creator_store_unavailable")? {
        if previous_hash != request_hash { return Err("operation_id_conflict"); }
        return serde_json::from_str(&result).map_err(|_| "creator_store_unavailable");
    }
    if revision != expected_revision { return Err("revision_conflict"); }
    if document.get("assets").is_none() { document["assets"] = json!({"schemaVersion":1,"entries":[]}); }
    if document.get("assetRefs").is_none() { document["assetRefs"] = json!([]); }
    let entries = document.get_mut("assets").and_then(|assets| assets.get_mut("entries")).and_then(Value::as_array_mut).ok_or("creator_project_invalid")?;
    if entries.len() >= MAX_PROJECT_ASSETS { return Err("creator_asset_budget_exceeded"); }
    if entries.iter().any(|entry| entry.get("sha256").and_then(Value::as_str) == Some(&asset_digest)) { return Err("creator_asset_already_imported"); }
    let total_asset_bytes = entries.iter().filter_map(|entry| entry.get("byteLength").and_then(Value::as_u64)).fold(0u64, u64::saturating_add);
    if total_asset_bytes.saturating_add(bytes.len() as u64) > 2 * 1024 * 1024 * 1024 { return Err("creator_asset_budget_exceeded"); }
    let asset_dir = home.join("state/creator/projects").join(project_id).join("assets");
    std::fs::create_dir_all(&asset_dir).map_err(|_| "creator_store_unavailable")?;
    let target = asset_dir.join(format!("{hash}.glb"));
    if target.exists() {
        let stored = std::fs::read(&target).map_err(|_| "creator_store_unavailable")?;
        if bytes_digest(&stored) != asset_digest { return Err("creator_asset_digest_mismatch"); }
    } else {
        let temporary = asset_dir.join(format!(".{hash}.{}.tmp", std::process::id()));
        std::fs::write(&temporary, &bytes).map_err(|_| "creator_store_unavailable")?;
        if let Err(error) = std::fs::rename(&temporary, &target) {
            let _ = std::fs::remove_file(&temporary);
            if !target.exists() { return Err(if error.kind() == std::io::ErrorKind::PermissionDenied { "creator_store_unavailable" } else { "creator_store_unavailable" }); }
        }
    }
    entries.push(json!({"assetId":asset_id,"relativePath":relative_path,"sha256":asset_digest,"byteLength":bytes.len(),"format":"glb-v2","boundsMeters":bounds}));
    document.get_mut("assetRefs").and_then(Value::as_array_mut).ok_or("creator_project_invalid")?.push(asset_ref.clone());
    let next = revision.checked_add(1).ok_or("revision_exhausted")?;
    document["revision"] = json!(next);
    let serialized = document.to_string();
    if serialized.len() > MAX_PROJECT_BYTES { return Err("creator_project_too_large"); }
    let now = now_ms();
    tx.execute("UPDATE creator_projects SET revision=?2,document_json=?3,updated_at_ms=?4 WHERE project_id=?1 AND revision=?5", params![project_id,next,serialized,now,revision]).map_err(|_| "creator_store_unavailable")?;
    tx.execute("INSERT INTO creator_changes(project_id,revision,actor_id,operation_id,operation_hash,document_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![project_id,next,owner,operation_id,request_hash,serialized,now]).map_err(|_| "creator_store_unavailable")?;
    let result = json!({"projectId":project_id,"revision":next,"operationId":operation_id,"assetId":asset_id,"digest":asset_digest,
        "byteLength":bytes.len(),"relativePath":relative_path,"boundsMeters":bounds,"assetRef":asset_ref,"documentDigest":bytes_digest(serialized.as_bytes())});
    tx.execute("INSERT INTO creator_operations(project_id,actor_id,operation_id,operation_hash,result_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6)", params![project_id,owner,operation_id,request_hash,result.to_string(),now]).map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

pub fn read_project_chunk(home: &Path, project_id: &str, offset: u64, max_bytes: u64) -> Result<Value, &'static str> {
    if !valid_id(project_id) || max_bytes == 0 || max_bytes > 32 * 1024 { return Err("creator_request_invalid"); }
    let db = database(home)?;
    let (revision, raw): (u64, String) = db.query_row("SELECT revision,document_json FROM creator_projects WHERE project_id=?1", [project_id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_project_not_found")?;
    let total = raw.len();
    let requested = usize::try_from(offset).unwrap_or(usize::MAX).min(total);
    let mut start = requested;
    while start < total && !raw.is_char_boundary(start) { start += 1; }
    let mut end = start.saturating_add(max_bytes as usize).min(total);
    while end > start && !raw.is_char_boundary(end) { end -= 1; }
    let chunk = &raw[start..end];
    Ok(json!({"projectId":project_id,"revision":revision,"offset":start,"nextOffset":end,
        "totalBytes":total,"complete":end == total,"documentChunk":chunk,"documentDigest":digest(&raw)}))
}

pub fn list_projects(home: &Path, limit: u64) -> Result<Value, &'static str> {
    let db = database(home)?;
    let mut statement = db.prepare("SELECT project_id,revision,document_json,updated_at_ms FROM creator_projects ORDER BY updated_at_ms DESC,project_id ASC LIMIT ?1").map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map([limit.clamp(1, 100)], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?, row.get::<_, String>(2)?, row.get::<_, u64>(3)?))).map_err(|_| "creator_store_unavailable")?;
    let projects = rows.map(|row| {
        let (project_id, revision, document, updated_at_ms) = row.map_err(|_| "creator_store_unavailable")?;
        let doc: Value = serde_json::from_str(&document).map_err(|_| "creator_store_unavailable")?;
        Ok(json!({"projectId":project_id,"revision":revision,"title":doc.get("title").and_then(Value::as_str).unwrap_or("City MiniGame"),"updatedAtMs":updated_at_ms}))
    }).collect::<Result<Vec<_>, &'static str>>()?;
    Ok(json!({"projects":projects}))
}

fn require_catalog_layout(home: &Path, layout_id: &str, world_revision: &str) -> Result<(), &'static str> {
    if !valid_id(layout_id) || !valid_id(world_revision) { return Err("creator_request_invalid"); }
    let db = database(home)?;
    let exists: Option<i64> = db.query_row("SELECT 1 FROM creator_city_layouts WHERE world_revision=?1 AND layout_id=?2",
        params![world_revision,layout_id], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?;
    if exists.is_none() { return Err("creator_layout_not_found"); }
    Ok(())
}

/// Freeze the current project revision as a local City release. The snapshot
/// contains the declarative game, validated mounts and registered visual skin;
/// project drafts, scene objects and analytical data never enter the runtime face.
pub fn publish_project_release(home: &Path, project_id: &str, expected_revision: u64) -> Result<Value, &'static str> {
    if !valid_id(project_id) { return Err("creator_request_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let (revision, raw): (u64, String) = tx.query_row("SELECT revision,document_json FROM creator_projects WHERE project_id=?1", [project_id],
        |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_project_not_found")?;
    if revision != expected_revision { return Err("revision_conflict"); }
    let document: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    let layout_snapshot = document.get("cityLayout").filter(|value| !value.is_null()).ok_or("creator_layout_not_bound")?;
    let (world_revision, layout_id) = validate_layout_snapshot(layout_snapshot)?;
    let layout_digest: Option<String> = tx.query_row("SELECT snapshot_digest FROM creator_city_layouts WHERE world_revision=?1 AND layout_id=?2",
        params![world_revision,layout_id], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?;
    if layout_digest.is_none() { return Err("creator_layout_not_found"); }
    let game = document.get("game").ok_or("creator_game_invalid")?;
    validate_game(game)?;
    let skin_id = document.get("skinId").and_then(Value::as_str).unwrap_or("miami-vice");
    if !valid_skin_id(skin_id) { return Err("creator_skin_not_found"); }
    let game_json = canonical_json(game).map_err(|_| "creator_game_invalid")?;
    let game_digest = digest(&game_json);
    let mounts = document.get("mounts").and_then(Value::as_array)
        .filter(|mounts| !mounts.is_empty() && mounts.len() <= MAX_RELEASE_MOUNTS).ok_or("creator_release_mounts_invalid")?;
    for mount in mounts {
        validate_mount(&document, mount)?;
        if mount["game"]["version"].as_str() != Some("1") || mount["game"]["digest"].as_str() != Some(&game_digest) {
            return Err("creator_release_game_reference_mismatch");
        }
    }
    let scene = document.get("scene").cloned().unwrap_or_else(|| json!({"schemaVersion":1,"objects":[]}));
    let scene_objects = scene.get("objects").and_then(Value::as_array).filter(|items| items.len() <= 128).ok_or("creator_release_scene_budget_exceeded")?;
    if scene_objects.iter().filter(|object| object.get("kind").and_then(Value::as_str) == Some("collider")).count() > MAX_RELEASE_COLLIDERS {
        return Err("creator_release_collider_budget_exceeded");
    }
    let used_asset_ids: std::collections::HashSet<&str> = scene_objects.iter()
        .filter(|object| object.get("kind").and_then(Value::as_str) == Some("model"))
        .filter_map(|object| object.get("asset").and_then(|asset| asset.get("assetId")).and_then(Value::as_str)).collect();
    let all_assets = document.get("assets").and_then(|assets| assets.get("entries")).and_then(Value::as_array).cloned().unwrap_or_default();
    let assets: Vec<Value> = all_assets.into_iter().filter(|asset| asset.get("assetId").and_then(Value::as_str).is_some_and(|id| used_asset_ids.contains(id))).collect();
    if assets.len() > 16 || assets.iter().filter_map(|asset| asset.get("byteLength").and_then(Value::as_u64)).fold(0u64, u64::saturating_add) > 128 * 1024 * 1024 {
        return Err("creator_release_asset_budget_exceeded");
    }
    let all_refs = document.get("assetRefs").and_then(Value::as_array).cloned().unwrap_or_default();
    let asset_refs: Vec<Value> = all_refs.into_iter().filter(|asset_ref| asset_ref.get("assetId").and_then(Value::as_str).is_some_and(|id| used_asset_ids.contains(id))).collect();
    if assets.len() != asset_refs.len() { return Err("creator_release_asset_invalid"); }
    let mut release_document = document.clone();
    release_document["scene"] = scene.clone();
    release_document["assets"] = json!({"schemaVersion":1,"entries":assets});
    release_document["assetRefs"] = json!(asset_refs);
    verify_scene_asset_bytes(home, project_id, &release_document, None)?;
    let snapshot = json!({"projectId":project_id,"revision":revision,"title":document.get("title").and_then(Value::as_str).unwrap_or("City Game"),
        "layoutId":layout_id,"worldRevision":world_revision,"skinId":skin_id,"game":game,"mounts":mounts,
        "scene":scene,"assets":release_document["assets"],"assetRefs":release_document["assetRefs"]});
    let snapshot_json = serde_json::to_string(&snapshot).map_err(|_| "creator_release_invalid")?;
    if snapshot_json.len() > MAX_RELEASE_BYTES { return Err("creator_release_too_large"); }
    let snapshot_digest = digest(&snapshot_json);
    let existing: Option<(String,String)> = tx.query_row("SELECT release_id,snapshot_digest FROM creator_releases WHERE project_id=?1 AND revision=?2",
        params![project_id,revision], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?;
    if let Some((release_id, existing_digest)) = existing {
        if existing_digest != snapshot_digest { return Err("creator_release_conflict"); }
        tx.commit().map_err(|_| "creator_store_unavailable")?;
        return Ok(json!({"releaseId":release_id,"projectId":project_id,"revision":revision,"status":"published"}));
    }
    let release_id = new_id("release-")?;
    let created_at_ms = now_ms();
    tx.execute("INSERT INTO creator_releases(release_id,project_id,revision,layout_id,world_revision,snapshot_json,snapshot_digest,created_at_ms)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![release_id,project_id,revision,layout_id,world_revision,snapshot_json,snapshot_digest,created_at_ms])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"releaseId":release_id,"projectId":project_id,"revision":revision,"status":"published"}))
}

/// List only immutable releases compatible with the caller's current City layout.
pub fn list_city_releases(home: &Path, layout_id: &str, world_revision: &str, limit: u64) -> Result<Value, &'static str> {
    require_catalog_layout(home, layout_id, world_revision)?;
    let db = database(home)?;
    let mut statement = db.prepare("SELECT release_id,project_id,revision,snapshot_json,created_at_ms FROM creator_releases
        WHERE layout_id=?1 AND world_revision=?2 ORDER BY created_at_ms DESC,release_id ASC LIMIT ?3").map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![layout_id,world_revision,limit.clamp(1, 32)], |row|
        Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,u64>(2)?,row.get::<_,String>(3)?,row.get::<_,u64>(4)?)))
        .map_err(|_| "creator_store_unavailable")?;
    let releases = rows.map(|row| {
        let (release_id,project_id,revision,raw,created_at_ms) = row.map_err(|_| "creator_store_unavailable")?;
        let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
        Ok(json!({"releaseId":release_id,"projectId":project_id,"revision":revision,
            "title":snapshot.get("title").and_then(Value::as_str).unwrap_or("City Game"),"skinId":snapshot.get("skinId").cloned().unwrap_or(Value::Null),"layoutId":layout_id,
            "worldRevision":world_revision,"mountCount":snapshot["mounts"].as_array().map_or(0,Vec::len),"createdAtMs":created_at_ms}))
    }).collect::<Result<Vec<_>, &'static str>>()?;
    Ok(json!({"releases":releases}))
}

/// Read one release only when its pinned City layout matches the active runtime.
pub fn read_city_release(home: &Path, release_id: &str, layout_id: &str, world_revision: &str) -> Result<Value, &'static str> {
    if !valid_id(release_id) { return Err("creator_request_invalid"); }
    require_catalog_layout(home, layout_id, world_revision)?;
    let db = database(home)?;
    let (revision,raw,snapshot_digest): (u64,String,String) = db.query_row("SELECT revision,snapshot_json,snapshot_digest FROM creator_releases
        WHERE release_id=?1 AND layout_id=?2 AND world_revision=?3", params![release_id,layout_id,world_revision],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_release_not_found")?;
    if raw.len() > MAX_RELEASE_BYTES { return Err("creator_release_invalid"); }
    if digest(&raw) != snapshot_digest { return Err("creator_release_digest_mismatch"); }
    let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    if snapshot.get("revision").and_then(Value::as_u64) != Some(revision)
        || snapshot.get("layoutId").and_then(Value::as_str) != Some(layout_id)
        || snapshot.get("worldRevision").and_then(Value::as_str) != Some(world_revision)
        || snapshot.get("skinId").is_some_and(|skin| !skin.is_null() && !skin.as_str().is_some_and(valid_skin_id)) { return Err("creator_release_invalid"); }
    Ok(json!({"releaseId":release_id,"revision":revision,"skinId":snapshot.get("skinId").cloned().unwrap_or(Value::Null),"game":snapshot["game"],"mounts":snapshot["mounts"],
        "scene":snapshot.get("scene").cloned().unwrap_or_else(|| json!({"schemaVersion":1,"objects":[]})),
        "assets":snapshot.get("assets").cloned().unwrap_or_else(|| json!({"schemaVersion":1,"entries":[]})),
        "assetRefs":snapshot.get("assetRefs").cloned().unwrap_or_else(|| json!([]))}))
}

/// Read one immutable release asset only after proving it is referenced by that
/// release. The caller separately binds access to the active official City WebView.
pub fn read_city_release_asset(home: &Path, release_id: &str, asset_digest: &str) -> Result<Vec<u8>, &'static str> {
    if !valid_id(release_id) || !asset_digest.strip_prefix("sha256:").is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())) {
        return Err("creator_asset_invalid");
    }
    let db = database(home)?;
    let (raw, snapshot_digest): (String, String) = db.query_row("SELECT snapshot_json,snapshot_digest FROM creator_releases WHERE release_id=?1", [release_id], |row| Ok((row.get(0)?,row.get(1)?)))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_release_not_found")?;
    if raw.len() > MAX_RELEASE_BYTES { return Err("creator_release_invalid"); }
    if digest(&raw) != snapshot_digest { return Err("creator_release_digest_mismatch"); }
    let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    let asset = snapshot.get("assets").and_then(|assets| assets.get("entries")).and_then(Value::as_array)
        .and_then(|entries| entries.iter().find(|entry| entry.get("sha256").and_then(Value::as_str) == Some(asset_digest)))
        .ok_or("creator_release_asset_not_found")?;
    let referenced = snapshot.get("assetRefs").and_then(Value::as_array).is_some_and(|refs|
        refs.iter().any(|reference| reference.get("digest").and_then(Value::as_str) == Some(asset_digest)))
        && snapshot.get("scene").and_then(|scene| scene.get("objects")).and_then(Value::as_array).is_some_and(|objects|
            objects.iter().any(|object| object.get("kind").and_then(Value::as_str) == Some("model")
                && object.get("asset").and_then(|asset| asset.get("digest")).and_then(Value::as_str) == Some(asset_digest)));
    if !referenced { return Err("creator_release_asset_not_found"); }
    let project_id = snapshot.get("projectId").and_then(Value::as_str).filter(|value| valid_id(value)).ok_or("creator_release_invalid")?;
    let byte_length = asset.get("byteLength").and_then(Value::as_u64).filter(|length| *length <= MAX_IMPORTED_MODEL_BYTES).ok_or("creator_release_asset_invalid")?;
    let path = home.join("state/creator/projects").join(project_id).join("assets").join(format!("{}.glb", &asset_digest[7..]));
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| "creator_release_asset_missing")?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || metadata.len() != byte_length { return Err("creator_release_asset_invalid"); }
    let bytes = std::fs::read(path).map_err(|_| "creator_release_asset_missing")?;
    if bytes_digest(&bytes) != asset_digest { return Err("creator_release_asset_digest_mismatch"); }
    inspect_glb(&bytes)?;
    Ok(bytes)
}

fn exact_payload(payload: &Value, keys: &[&str]) -> bool {
    payload.as_object().is_some_and(|object| object.len() == keys.len() && object.keys().all(|key| keys.contains(&key.as_str())))
}

fn finite_number(value: &Value, min: f64, max: f64) -> bool {
    value.as_f64().is_some_and(|number| number.is_finite() && number >= min && number <= max)
}

fn valid_transform(value: &Value) -> bool {
    let Some(transform) = value.as_object() else { return false; };
    if transform.len() != 3 || !only_keys(transform, &["positionMeters", "rotationRadians", "scale"]) { return false; }
    let vector = |value: Option<&Value>, bounds: [(f64, f64); 3]| -> bool {
        let Some(vector) = value.and_then(Value::as_object) else { return false; };
        vector.len() == 3 && only_keys(vector, &["x", "y", "z"])
            && ["x", "y", "z"].iter().zip(bounds).all(|(key, (min, max))| vector.get(*key).is_some_and(|value| finite_number(value, min, max)))
    };
    vector(transform.get("positionMeters"), [(-100_000.0, 100_000.0); 3])
        && vector(transform.get("rotationRadians"), [(-6_283.0, 6_283.0); 3])
        && vector(transform.get("scale"), [(0.001, 100.0); 3])
}

fn validate_scene_object(value: &Value) -> Result<&str, &'static str> {
    let object = value.as_object().ok_or("creator_scene_object_invalid")?;
    let id = object.get("id").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_scene_object_invalid")?;
    if !object.get("transform").is_some_and(valid_transform) { return Err("creator_scene_transform_invalid"); }
    match object.get("kind").and_then(Value::as_str) {
        Some("model") if object.len() == 4 && only_keys(object, &["id", "kind", "asset", "transform"]) => {
            let asset = object.get("asset").and_then(Value::as_object).ok_or("creator_scene_asset_invalid")?;
            if asset.len() != 3 || !only_keys(asset, &["package", "assetId", "digest"])
                || !asset.get("assetId").and_then(Value::as_str).is_some_and(valid_id)
                || !asset.get("digest").and_then(Value::as_str).is_some_and(|digest| digest.strip_prefix("sha256:").is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))) { return Err("creator_scene_asset_invalid"); }
            let package = asset.get("package").and_then(Value::as_object).ok_or("creator_scene_asset_invalid")?;
            if package.len() != 4 || !only_keys(package, &["kind", "id", "version", "digest"])
                || !matches!(package.get("kind").and_then(Value::as_str), Some("city-layout" | "city-skin" | "city-minigame"))
                || !package.get("id").and_then(Value::as_str).is_some_and(valid_id)
                || !package.get("version").and_then(Value::as_str).is_some_and(|version| !version.is_empty() && version.len() <= 64)
                || !package.get("digest").and_then(Value::as_str).is_some_and(|digest| !digest.is_empty() && digest.len() <= 256) { return Err("creator_scene_asset_invalid"); }
            Ok(id)
        }
        Some("collider") if object.len() == 5 && only_keys(object, &["id", "kind", "shape", "sizeMeters", "transform"]) => {
            let size = object.get("sizeMeters").and_then(Value::as_object).ok_or("creator_scene_collider_invalid")?;
            if object.get("shape").and_then(Value::as_str) != Some("box") || size.len() != 3 || !only_keys(size, &["x", "y", "z"])
                || ["x", "y", "z"].iter().any(|key| !size.get(*key).is_some_and(|value| finite_number(value, 0.1, 100.0))) {
                return Err("creator_scene_collider_invalid");
            }
            Ok(id)
        }
        Some("anchor") if object.len() == 4 && only_keys(object, &["id", "kind", "anchor", "transform"]) => {
            let anchor = object.get("anchor").and_then(Value::as_object).ok_or("creator_scene_anchor_invalid")?;
            if anchor.len() != 4 || !only_keys(anchor, &["id", "kind", "capabilities", "geometryRef"])
                || anchor.get("id").and_then(Value::as_str) != Some(id)
                || !matches!(anchor.get("kind").and_then(Value::as_str), Some("spawn" | "route" | "zone" | "object"))
                || !anchor.get("geometryRef").and_then(Value::as_str).is_some_and(valid_id) { return Err("creator_scene_anchor_invalid"); }
            let capabilities = anchor.get("capabilities").and_then(Value::as_array).filter(|items| items.len() <= 2).ok_or("creator_scene_anchor_invalid")?;
            if capabilities.iter().any(|item| !matches!(item.as_str(), Some("drive" | "walk")))
                || capabilities.iter().enumerate().any(|(index, item)| capabilities[..index].contains(item)) { return Err("creator_scene_anchor_invalid"); }
            Ok(id)
        }
        _ => Err("creator_scene_object_invalid"),
    }
}

fn validate_project_asset_ref(document: &Value, object: &Value) -> Result<(), &'static str> {
    if object.get("kind").and_then(Value::as_str) != Some("model") { return Ok(()); }
    let asset = object.get("asset").and_then(Value::as_object).ok_or("creator_scene_asset_invalid")?;
    let package = asset.get("package").and_then(Value::as_object).ok_or("creator_scene_asset_invalid")?;
    let city_layout = document.get("cityLayout").filter(|value| !value.is_null()).ok_or("creator_layout_not_bound")?;
    let (world_revision, layout_id) = validate_layout_snapshot(city_layout)?;
    if package.get("kind").and_then(Value::as_str) != Some("city-layout")
        || package.get("id").and_then(Value::as_str) != Some(layout_id)
        || package.get("version").and_then(Value::as_str) != Some("1")
        || package.get("digest").and_then(Value::as_str) != Some(world_revision) {
        return Err("creator_scene_asset_package_mismatch");
    }
    let asset_id = asset.get("assetId").and_then(Value::as_str).ok_or("creator_scene_asset_invalid")?;
    let asset_digest = asset.get("digest").and_then(Value::as_str).ok_or("creator_scene_asset_invalid")?;
    let asset_refs = document.get("assetRefs").and_then(Value::as_array).ok_or("creator_scene_asset_not_found")?;
    if !asset_refs.iter().any(|reference| reference == &Value::Object(asset.clone())) { return Err("creator_scene_asset_not_found"); }
    let entries = document.get("assets").and_then(|assets| assets.get("entries")).and_then(Value::as_array).ok_or("creator_scene_asset_not_found")?;
    let entry = entries.iter().find(|entry| entry.get("assetId").and_then(Value::as_str) == Some(asset_id)).ok_or("creator_scene_asset_not_found")?;
    if entry.get("sha256").and_then(Value::as_str) != Some(asset_digest) { return Err("creator_scene_asset_digest_mismatch"); }
    Ok(())
}

/// `budget`：None = 全量核对（发布/预览路径，字节核对是提交资格检查）；
/// Some(n) = 核对 n 个资产后返回 skip 代码（creator.scene.validate 的有界模式，
/// 由调用方如实标注「字节核对未运行」）。
fn verify_scene_asset_bytes(home: &Path, project_id: &str, document: &Value, budget: Option<usize>) -> Result<(), &'static str> {
    let objects = document.get("scene").and_then(|scene| scene.get("objects")).and_then(Value::as_array).ok_or("creator_project_invalid")?;
    let empty_entries = Vec::new();
    let entries = document.get("assets").and_then(|assets| assets.get("entries")).and_then(Value::as_array).unwrap_or(&empty_entries);
    let mut verified = std::collections::HashSet::new();
    let mut checked_assets = std::collections::HashSet::new();
    for object in objects.iter().filter(|object| object.get("kind").and_then(Value::as_str) == Some("model")) {
        validate_project_asset_ref(document, object)?;
        let asset = object.get("asset").and_then(Value::as_object).ok_or("creator_scene_asset_invalid")?;
        let asset_id = asset.get("assetId").and_then(Value::as_str).ok_or("creator_scene_asset_invalid")?;
        if !verified.insert(asset_id.to_owned()) { continue; }
        if let Some(budget) = budget {
            if checked_assets.len() >= budget { return Err("creator_asset_verify_skipped"); }
        }
        checked_assets.insert(asset_id.to_owned());
        let entry = entries.iter().find(|entry| entry.get("assetId").and_then(Value::as_str) == Some(asset_id)).ok_or("creator_scene_asset_not_found")?;
        let hash = entry.get("sha256").and_then(Value::as_str).and_then(|value| value.strip_prefix("sha256:")).filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())).ok_or("creator_scene_asset_invalid")?;
        let path = home.join("state/creator/projects").join(project_id).join("assets").join(format!("{hash}.glb"));
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| "creator_scene_asset_missing")?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_IMPORTED_MODEL_BYTES
            || entry.get("byteLength").and_then(Value::as_u64) != Some(metadata.len()) { return Err("creator_scene_asset_invalid"); }
        let bytes = std::fs::read(path).map_err(|_| "creator_scene_asset_missing")?;
        if bytes_digest(&bytes) != format!("sha256:{hash}") { return Err("creator_scene_asset_digest_mismatch"); }
        inspect_glb(&bytes)?;
    }
    Ok(())
}

fn validate_content_ref<'a>(value: &'a Value, expected_kind: &str) -> Result<&'a str, &'static str> {
    let reference = value.as_object().ok_or("creator_mount_invalid")?;
    if reference.len() != 4 || !only_keys(reference, &["kind", "id", "version", "digest"])
        || reference.get("kind").and_then(Value::as_str) != Some(expected_kind)
        || !reference.get("id").and_then(Value::as_str).is_some_and(valid_id)
        || !reference.get("version").and_then(Value::as_str).is_some_and(|value| !value.is_empty() && value.len() <= 64)
        || !reference.get("digest").and_then(Value::as_str).is_some_and(|value| !value.is_empty() && value.len() <= 256) {
        return Err("creator_mount_invalid");
    }
    Ok(reference["id"].as_str().unwrap_or_default())
}

fn validate_mount<'a>(document: &Value, value: &'a Value) -> Result<&'a str, &'static str> {
    let mount = value.as_object().ok_or("creator_mount_invalid")?;
    if mount.len() != 7 || !only_keys(mount, &["schemaVersion", "mountId", "layout", "game", "entryAnchorId", "bindings", "parameterOverrides"])
        || mount.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || !mount.get("mountId").and_then(Value::as_str).is_some_and(valid_id)
        || !mount.get("entryAnchorId").and_then(Value::as_str).is_some_and(valid_id) {
        return Err("creator_mount_invalid");
    }
    let layout_ref_id = validate_content_ref(&mount["layout"], "city-layout")?;
    let game_id = validate_content_ref(&mount["game"], "city-minigame")?;
    if document.get("game").and_then(|game| game.get("id")).and_then(Value::as_str) != Some(game_id) { return Err("creator_mount_game_mismatch"); }
    let city_layout = document.get("cityLayout").filter(|snapshot| !snapshot.is_null()).ok_or("creator_layout_not_bound")?;
    let (world_revision, city_layout_id) = validate_layout_snapshot(city_layout)?;
    if layout_ref_id != city_layout_id || mount["layout"]["digest"].as_str() != Some(world_revision) {
        return Err("creator_mount_layout_mismatch");
    }
    let scene_anchors = city_layout["layout"]["anchors"].as_array().ok_or("creator_layout_snapshot_invalid")?.iter()
        .filter_map(|anchor| anchor.as_object().map(|anchor| (anchor.get("id").and_then(Value::as_str).unwrap_or_default(), anchor)))
        .collect::<HashMap<_, _>>();
    let entry = scene_anchors.get(mount["entryAnchorId"].as_str().unwrap_or_default()).ok_or("creator_mount_entry_not_found")?;
    if entry.get("kind").and_then(Value::as_str) != Some("spawn") { return Err("creator_mount_entry_kind_mismatch"); }
    let slots = document.get("game").and_then(|game| game.get("slots")).and_then(Value::as_object).ok_or("creator_game_invalid")?;
    let bindings = mount.get("bindings").and_then(Value::as_object).filter(|items| items.len() <= 32).ok_or("creator_mount_invalid")?;
    let mut binding_count = 0usize;
    for (slot_id, anchors) in bindings {
        if !valid_id(slot_id) { return Err("creator_mount_invalid"); }
        let slot = slots.get(slot_id).and_then(Value::as_object).ok_or("creator_mount_slot_not_found")?;
        let anchors = anchors.as_array().ok_or("creator_mount_invalid")?;
        let min = slot.get("min").and_then(Value::as_u64).ok_or("creator_game_invalid")? as usize;
        let max = slot.get("max").and_then(Value::as_u64).ok_or("creator_game_invalid")? as usize;
        if anchors.len() < min || anchors.len() > max || anchors.iter().any(|anchor| !anchor.as_str().is_some_and(valid_id)) {
            return Err("creator_mount_binding_invalid");
        }
        let expected_kind = slot.get("kind").and_then(Value::as_str).ok_or("creator_game_invalid")?;
        let required_capabilities = slot.get("requires").and_then(Value::as_array).cloned().unwrap_or_default();
        for anchor_id in anchors.iter().filter_map(Value::as_str) {
            let anchor = scene_anchors.get(anchor_id).ok_or("creator_mount_anchor_not_found")?;
            if anchor.get("kind").and_then(Value::as_str) != Some(expected_kind) { return Err("creator_mount_anchor_kind_mismatch"); }
            let capabilities = anchor.get("capabilities").and_then(Value::as_array).ok_or("creator_scene_anchor_invalid")?;
            if required_capabilities.iter().any(|required| !capabilities.contains(required)) { return Err("creator_mount_anchor_capability_missing"); }
        }
        let mut seen = std::collections::HashSet::new();
        if anchors.iter().any(|anchor| !seen.insert(anchor.as_str().unwrap_or_default())) { return Err("creator_mount_binding_invalid"); }
        binding_count = binding_count.saturating_add(anchors.len());
    }
    if let Some(links) = city_layout["layout"].get("links").and_then(Value::as_array) {
        let entry_id = mount["entryAnchorId"].as_str().unwrap_or_default();
        for (slot_id, slot) in slots {
            let required = slot.get("requires").and_then(Value::as_array).cloned().unwrap_or_default();
            let bound = bindings.get(slot_id).and_then(Value::as_array).cloned().unwrap_or_default();
            for capability in required.iter().filter_map(Value::as_str) {
                let entry_capabilities = entry.get("capabilities").and_then(Value::as_array).ok_or("creator_scene_anchor_invalid")?;
                if !entry_capabilities.iter().any(|item| item.as_str() == Some(capability)) { return Err("creator_mount_entry_capability_missing"); }
                let mut reached = std::collections::HashSet::from([entry_id]);
                let mut queue = vec![entry_id];
                let mut head = 0usize;
                while head < queue.len() {
                    let current = queue[head];
                    head += 1;
                    for link in links {
                        if !link["capabilities"].as_array().is_some_and(|items| items.iter().any(|item| item.as_str() == Some(capability))) { continue; }
                        let from = link["fromAnchorId"].as_str().unwrap_or_default();
                        let to = link["toAnchorId"].as_str().unwrap_or_default();
                        let next = if from == current { Some(to) } else if to == current { Some(from) } else { None };
                        if let Some(next) = next { if reached.insert(next) { queue.push(next); } }
                    }
                }
                if bound.iter().filter_map(Value::as_str).any(|anchor_id| !reached.contains(anchor_id)) { return Err("creator_mount_anchor_unreachable"); }
            }
        }
    }
    if binding_count > 64 { return Err("creator_mount_budget_exceeded"); }
    for (slot_id, slot) in slots {
        if !bindings.contains_key(slot_id) && slot.get("min").and_then(Value::as_u64).unwrap_or(0) > 0 { return Err("creator_mount_binding_invalid"); }
    }
    let parameters = document.get("game").and_then(|game| game.get("integerParameters")).and_then(Value::as_object);
    let overrides = mount.get("parameterOverrides").and_then(Value::as_object).filter(|items| items.len() <= 32).ok_or("creator_mount_invalid")?;
    for (name, value) in overrides {
        let parameter = parameters.and_then(|items| items.get(name)).and_then(Value::as_object).ok_or("creator_mount_parameter_invalid")?;
        let value = value.as_i64().ok_or("creator_mount_parameter_invalid")?;
        if value < parameter.get("min").and_then(Value::as_i64).unwrap_or(i64::MAX)
            || value > parameter.get("max").and_then(Value::as_i64).unwrap_or(i64::MIN) { return Err("creator_mount_parameter_invalid"); }
    }
    Ok(mount["mountId"].as_str().unwrap_or_default())
}

fn apply_mount_skin_operation(document: &mut Value, operation: &Value) -> Result<Option<(String, &'static str)>, &'static str> {
    let operation = operation.as_object().ok_or("creator_scene_ops_invalid")?;
    match operation.get("op").and_then(Value::as_str) {
        Some("mount.bind") if operation.len() == 2 && only_keys(operation, &["op", "mount"]) => {
            let mount = operation.get("mount").ok_or("creator_mount_invalid")?;
            let mount_id = validate_mount(document, mount)?.to_owned();
            let project = document.as_object_mut().ok_or("creator_project_invalid")?;
            let mounts = project.entry("mounts").or_insert_with(|| json!([])).as_array_mut().ok_or("creator_project_invalid")?;
            let index = mounts.iter().position(|item| item.get("mountId").and_then(Value::as_str) == Some(&mount_id));
            let action = if index.is_some() { "updated" } else { "added" };
            if let Some(index) = index { mounts[index] = mount.clone(); }
            else {
                if mounts.len() >= 128 { return Err("creator_mount_budget_exceeded"); }
                mounts.push(mount.clone());
            }
            Ok(Some((format!("mounts.{mount_id}"), action)))
        }
        Some("mount.remove") if operation.len() == 2 && only_keys(operation, &["op", "mountId"]) => {
            let mount_id = operation.get("mountId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_mount_invalid")?;
            let project = document.as_object_mut().ok_or("creator_project_invalid")?;
            let mounts = project.entry("mounts").or_insert_with(|| json!([])).as_array_mut().ok_or("creator_project_invalid")?;
            let index = mounts.iter().position(|item| item.get("mountId").and_then(Value::as_str) == Some(mount_id)).ok_or("creator_mount_not_found")?;
            mounts.remove(index);
            Ok(Some((format!("mounts.{mount_id}"), "removed")))
        }
        Some("skin.select") if operation.len() == 2 && only_keys(operation, &["op", "skinId"]) => {
            let skin_id = operation.get("skinId").and_then(Value::as_str).filter(|id| matches!(*id, "miami-vice" | "desert-evening")).ok_or("creator_skin_not_found")?;
            document.as_object_mut().ok_or("creator_project_invalid")?.insert("skinId".into(), json!(skin_id));
            Ok(Some(("skinId".into(), "updated")))
        }
        _ => Ok(None),
    }
}

fn apply_scene_operations(document: &mut Value, operations: &Value) -> Result<Vec<(String, &'static str)>, &'static str> {
    let operations = operations.as_array().filter(|operations| !operations.is_empty() && operations.len() <= 128).ok_or("creator_scene_ops_invalid")?;
    let mut touched = Vec::with_capacity(operations.len());
    // 城市补丁操作作用于项目根（不走 scene.objects）：先于场景作用域处理。
    // 种子必须与绑定的 City 布局一致，移动到另一座城市的补丁会在提交时被拒绝。
    {
        let project = document.as_object_mut().ok_or("creator_project_invalid")?;
        for operation in operations {
            let Some(operation) = operation.as_object() else { continue };
            match operation.get("op").and_then(Value::as_str) {
                Some("city.patch.upsert") if only_keys(operation, &["op", "patch"]) && operation.len() == 2 => {
                    let layout_seed = project.get("cityLayout").and_then(|layout| layout.get("seed")).and_then(Value::as_u64).ok_or("creator_city_patch_requires_city_layout")?;
                    let patch = operation.get("patch").ok_or("creator_scene_ops_invalid")?;
                    validate_city_patch(patch, layout_seed)?;
                    let raw = serde_json::to_string(patch).map_err(|_| "creator_city_patch_invalid")?;
                    if raw.len() > MAX_CITY_PATCH_BYTES { return Err("creator_city_patch_too_large"); }
                    let action = if project.contains_key("cityPatch") { "updated" } else { "added" };
                    project.insert("cityPatch".to_owned(), patch.clone());
                    // 修订后导入记录不再代表当前补丁来源；来源历史留在 creator_changes。
                    project.remove("cityPatchImport");
                    touched.push(("cityPatch".to_owned(), action));
                }
                Some("city.patch.remove") if only_keys(operation, &["op"]) && operation.len() == 1 => {
                    project.remove("cityPatch");
                    touched.push(("cityPatch".to_owned(), "removed"));
                }
                _ => {}
            }
        }
    }
    {
        let project = document.as_object_mut().ok_or("creator_project_invalid")?;
        project.entry("scene").or_insert_with(|| json!({"schemaVersion":1,"objects":[]}));
        project.entry("mounts").or_insert_with(|| json!([]));
        let scene = project.get_mut("scene").and_then(Value::as_object_mut).ok_or("creator_project_invalid")?;
        if scene.get("schemaVersion") != Some(&json!(1)) { return Err("creator_project_invalid"); }
        let objects = scene.entry("objects").or_insert_with(|| json!([])).as_array_mut().ok_or("creator_project_invalid")?;
        if objects.len() > MAX_SCENE_OBJECTS { return Err("creator_scene_budget_exceeded"); }
        for operation in operations {
            let operation = operation.as_object().ok_or("creator_scene_ops_invalid")?;
            if matches!(operation.get("op").and_then(Value::as_str), Some("mount.bind" | "mount.remove" | "skin.select" | "city.patch.upsert" | "city.patch.remove")) { continue; }
            match operation.get("op").and_then(Value::as_str) {
                Some("scene.object.upsert") | Some("anchor.upsert") if operation.len() == 2 && only_keys(operation, &["op", "object"]) => {
                    let object = operation.get("object").ok_or("creator_scene_object_invalid")?;
                    let id = validate_scene_object(object)?;
                    if operation.get("op").and_then(Value::as_str) == Some("anchor.upsert") && object.get("kind").and_then(Value::as_str) != Some("anchor") { return Err("creator_scene_object_invalid"); }
                    let index = objects.iter().position(|existing| existing.get("id").and_then(Value::as_str) == Some(id));
                    let action = if index.is_some() { "updated" } else { "added" };
                    if let Some(index) = index { objects[index] = object.clone(); }
                    else {
                        if objects.len() >= MAX_SCENE_OBJECTS { return Err("creator_scene_budget_exceeded"); }
                        objects.push(object.clone());
                    }
                    touched.push((format!("scene.objects.{id}"), action));
                }
                Some("scene.object.remove") | Some("anchor.remove") if operation.len() == 2 && only_keys(operation, &["op", "objectId"]) => {
                    let id = operation.get("objectId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_scene_ops_invalid")?;
                    let index = objects.iter().position(|existing| existing.get("id").and_then(Value::as_str) == Some(id)).ok_or("creator_scene_object_not_found")?;
                    if operation.get("op").and_then(Value::as_str) == Some("anchor.remove") && objects[index].get("kind").and_then(Value::as_str) != Some("anchor") { return Err("creator_scene_object_kind_mismatch"); }
                    objects.remove(index);
                    touched.push((format!("scene.objects.{id}"), "removed"));
                }
                _ => return Err("creator_scene_operation_unsupported"),
            }
        }
        let mut seen = std::collections::HashSet::new();
        let mut collider_count = 0;
        for object in objects.iter() {
            let id = validate_scene_object(object)?;
            if !seen.insert(id) { return Err("creator_scene_duplicate_id"); }
            if object.get("kind").and_then(Value::as_str) == Some("collider") { collider_count += 1; }
        }
        if collider_count > MAX_SCENE_COLLIDERS { return Err("creator_scene_collider_budget_exceeded"); }
    }
    for object in document.get("scene").and_then(|scene| scene.get("objects")).and_then(Value::as_array).ok_or("creator_project_invalid")? {
        validate_project_asset_ref(document, object)?;
    }
    for operation in operations {
        if let Some((path, action)) = apply_mount_skin_operation(document, operation)? { touched.push((path, action)); }
    }
    let mounts = document.get("mounts").and_then(Value::as_array).ok_or("creator_project_invalid")?;
    for mount in mounts { validate_mount(document, mount)?; }
    Ok(touched)
}

pub fn operation_status(home: &Path, actor: &str, project_id: &str, operation_id: &str) -> Result<Value, &'static str> {
    if actor.is_empty() || actor.len() > 128 || !valid_id(project_id) || !valid_id(operation_id) { return Err("creator_request_invalid"); }
    let db = database(home)?;
    let result: Option<String> = db.query_row("SELECT result_json FROM creator_operations WHERE project_id=?1 AND actor_id=?2 AND operation_id=?3", params![project_id, actor, operation_id], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?;
    match result {
        Some(result) => Ok(json!({"status":"committed","result":serde_json::from_str::<Value>(&result).map_err(|_| "creator_store_unavailable")?})),
        None => Ok(json!({"status":"not_found"})),
    }
}

/// Dispatch using a stable local project principal and a short-lived UI actor.
/// The stable principal owns project operations/history; the instance actor is
/// used only for preview capabilities so they cannot cross a Studio handoff.
pub fn dispatch_as(home: &Path, owner: &str, instance: &str, method: &str, payload: &Value) -> Result<Value, &'static str> {
    match method {
        "creator.layout.list" if exact_payload(payload, &["limit"]) => list_city_layout_snapshots(home, payload["limit"].as_u64().ok_or("creator_request_invalid")?),
        "creator.project.create" if exact_payload(payload, &["template", "operationId", "worldRevision"]) => create_project_from_city_layout(home, owner,
            payload["template"].as_str().ok_or("creator_request_invalid")?, payload["operationId"].as_str().ok_or("creator_request_invalid")?,
            payload["worldRevision"].as_str().ok_or("creator_request_invalid")?),
        "creator.project.list" if exact_payload(payload, &["limit"]) => list_projects(home, payload["limit"].as_u64().ok_or("creator_request_invalid")?),
        "creator.project.read" if exact_payload(payload, &["projectId"]) => read_project(home, payload["projectId"].as_str().ok_or("creator_request_invalid")?),
        "creator.project.read_chunk" if exact_payload(payload, &["projectId", "offset", "maxBytes"]) => read_project_chunk(home,
            payload["projectId"].as_str().ok_or("creator_request_invalid")?, payload["offset"].as_u64().ok_or("creator_request_invalid")?,
            payload["maxBytes"].as_u64().ok_or("creator_request_invalid")?),
        "creator.operation.status" if exact_payload(payload, &["projectId", "operationId"]) => operation_status(home, owner,
            payload["projectId"].as_str().ok_or("creator_request_invalid")?, payload["operationId"].as_str().ok_or("creator_request_invalid")?),
        "creator.game.preview" if exact_payload(payload, &["projectId", "baseRevision", "game"]) => preview_replace_game(home, instance,
            payload["projectId"].as_str().ok_or("creator_request_invalid")?, payload["baseRevision"].as_u64().ok_or("creator_request_invalid")?, &payload["game"]),
        "creator.scene.preview" if exact_payload(payload, &["projectId", "baseRevision", "operations"]) => preview_scene_operations(home, instance,
            payload["projectId"].as_str().ok_or("creator_request_invalid")?, payload["baseRevision"].as_u64().ok_or("creator_request_invalid")?, &payload["operations"]),
        "creator.game.commit" if exact_payload(payload, &["projectId", "previewId", "expectedRevision", "operationId"]) => commit_preview_as(home, owner, instance,
            payload["projectId"].as_str().ok_or("creator_request_invalid")?, payload["previewId"].as_str().ok_or("creator_request_invalid")?,
            payload["expectedRevision"].as_u64().ok_or("creator_request_invalid")?, payload["operationId"].as_str().ok_or("creator_request_invalid")?),
        "creator.scene.commit" if exact_payload(payload, &["projectId", "previewId", "expectedRevision", "operationId"]) => commit_preview_as(home, owner, instance,
            payload["projectId"].as_str().ok_or("creator_request_invalid")?, payload["previewId"].as_str().ok_or("creator_request_invalid")?,
            payload["expectedRevision"].as_u64().ok_or("creator_request_invalid")?, payload["operationId"].as_str().ok_or("creator_request_invalid")?),
        "creator.project.commit" if exact_payload(payload, &["projectId", "previewId", "expectedRevision", "operationId"]) => commit_preview_as(home, owner, instance,
            payload["projectId"].as_str().ok_or("creator_request_invalid")?, payload["previewId"].as_str().ok_or("creator_request_invalid")?,
            payload["expectedRevision"].as_u64().ok_or("creator_request_invalid")?, payload["operationId"].as_str().ok_or("creator_request_invalid")?),
        "creator.project.publish" if exact_payload(payload, &["projectId", "expectedRevision"]) => publish_project_release(home,
            payload["projectId"].as_str().ok_or("creator_request_invalid")?, payload["expectedRevision"].as_u64().ok_or("creator_request_invalid")?),
        // 试玩启动：releaseId 必填；projectId/expectedRevision/requestId 可选（MCP 契约 §6.3，
        // 提供即校验归属）。UI 的 {releaseId} 形状继续有效。
        "creator.project.playtest.start" if payload.as_object().is_some_and(|object| {
            object.contains_key("releaseId")
                && object.keys().all(|key| matches!(key.as_str(), "releaseId" | "projectId" | "expectedRevision" | "requestId"))
        }) => {
            let release_id = payload["releaseId"].as_str().filter(|id| valid_id(id)).ok_or("creator_request_invalid")?;
            let expected_project = payload.get("projectId").and_then(Value::as_str).filter(|id| valid_id(id));
            let expected_revision = payload.get("expectedRevision").and_then(Value::as_u64);
            if payload.get("requestId").is_some_and(|value| !value.as_str().is_some_and(|id| !id.is_empty() && id.len() <= 128)) {
                return Err("creator_request_invalid");
            }
            let mut result = start_playtest(home, instance, release_id, expected_project, expected_revision)?;
            if let Some(request_id) = payload.get("requestId").and_then(Value::as_str) { result["requestId"] = json!(request_id); }
            Ok(result)
        }
        "creator.project.playtest.result" if exact_payload(payload, &["runId"]) => read_playtest_result(home,
            payload["runId"].as_str().filter(|id| valid_id(id)).ok_or("creator_request_invalid")?),
        "creator.project.playtest.cancel" if exact_payload(payload, &["runId"]) => cancel_playtest(home, instance,
            payload["runId"].as_str().filter(|id| valid_id(id)).ok_or("creator_request_invalid")?),
        "creator.project.playtest.return_context" if exact_payload(payload, &[]) => take_playtest_return(home),
        // MCP P0/P1（设计 §6.4）：场景摘要与能力发现；capture 由 Studio WebView 处理器本地生成，不经此分发。
        "creator.scene.describe" => {
            let object = payload.as_object().ok_or("creator_request_invalid")?;
            if !object.contains_key("projectId") || object.keys().any(|key| !matches!(key.as_str(), "projectId" | "revision" | "selectedObjectId")) {
                return Err("creator_request_invalid");
            }
            let project_id = payload["projectId"].as_str().filter(|id| valid_id(id)).ok_or("creator_request_invalid")?;
            let expected = payload.get("revision").and_then(Value::as_u64);
            let selected = payload.get("selectedObjectId").and_then(Value::as_str).filter(|id| valid_id(id));
            describe_scene(home, project_id, expected, selected)
        }
        "creator.capabilities.list" => {
            let object = payload.as_object().ok_or("creator_request_invalid")?;
            if object.keys().any(|key| !matches!(key.as_str(), "category" | "schemaVersion")) { return Err("creator_request_invalid"); }
            let category = payload.get("category").and_then(Value::as_str).filter(|value| valid_id(value));
            let version = payload.get("schemaVersion").and_then(Value::as_u64);
            match category {
                Some(category) => creator_capabilities_filtered(category, version.unwrap_or(1)),
                None => {
                    if let Some(version) = version {
                        if version != 1 { return Err("creator_capability_version_unsupported"); }
                    }
                    Ok(creator_capabilities())
                }
            }
        }
        "creator.scene.inspect" if exact_payload(payload, &["projectId", "revision", "objectId"]) => inspect_scene_object(home,
            payload["projectId"].as_str().filter(|id| valid_id(id)).ok_or("creator_request_invalid")?,
            payload["revision"].as_u64().ok_or("creator_request_invalid")?,
            payload["objectId"].as_str().filter(|id| valid_id(id)).ok_or("creator_request_invalid")?),
        "creator.scene.validate" => {
            let object = payload.as_object().ok_or("creator_request_invalid")?;
            if !object.contains_key("projectId") || object.keys().any(|key| !matches!(key.as_str(), "projectId" | "revision" | "validationProfile")) {
                return Err("creator_request_invalid");
            }
            let project_id = payload["projectId"].as_str().filter(|id| valid_id(id)).ok_or("creator_request_invalid")?;
            let expected = payload.get("revision").and_then(Value::as_u64);
            let profile = payload.get("validationProfile").and_then(Value::as_str);
            validate_scene(home, project_id, expected, profile)
        }
        "creator.project.playtest.history" if exact_payload(payload, &["projectId", "limit"]) => list_playtest_history(home,
            payload["projectId"].as_str().ok_or("creator_request_invalid")?, payload["limit"].as_u64().ok_or("creator_request_invalid")?),
        _ => Err("creator_method_unavailable"),
    }
}

/// Separate City runtime face. This does not share the Creator Studio draft
/// dispatch namespace and never returns unpublished project documents.
pub fn dispatch_city_runtime(home: &Path, city_instance: &str, method: &str, payload: &Value) -> Result<Value, &'static str> {
    match method {
        "city.creator.experiences.list" if exact_payload(payload, &["layoutId", "worldRevision", "limit"]) => list_city_releases(home,
            payload["layoutId"].as_str().ok_or("creator_request_invalid")?,
            payload["worldRevision"].as_str().ok_or("creator_request_invalid")?,
            payload["limit"].as_u64().filter(|limit| (1..=32).contains(limit)).ok_or("creator_request_invalid")?),
        "city.creator.experiences.read" if exact_payload(payload, &["releaseId", "layoutId", "worldRevision"]) => read_city_release(home,
            payload["releaseId"].as_str().ok_or("creator_request_invalid")?,
            payload["layoutId"].as_str().ok_or("creator_request_invalid")?,
            payload["worldRevision"].as_str().ok_or("creator_request_invalid")?),
        "city.creator.patch.publish" if exact_payload(payload, &["seed", "patch"]) => publish_city_patch(home, payload),
        "city.creator.patch.read" if exact_payload(payload, &["seed"]) => read_city_patch_for_seed(home,
            payload["seed"].as_u64().filter(|seed| *seed <= u32::MAX as u64).ok_or("creator_request_invalid")?),
        "city.creator.playtest.claim" if exact_payload(payload, &[]) => claim_playtest(home, city_instance),
        "city.creator.playtest.finish" if exact_payload(payload, &["runId", "status", "evidence"])
            || exact_payload(payload, &["runId", "status", "evidence", "failureCode"]) => finish_playtest(home, city_instance,
            payload["runId"].as_str().ok_or("creator_request_invalid")?,
            payload["status"].as_str().ok_or("creator_request_invalid")?, payload.get("evidence").filter(|value| !value.is_null()),
            payload.get("failureCode").and_then(Value::as_str)),
        _ => Err("creator_method_unavailable"),
    }
}

fn expire_playtests(tx: &rusqlite::Transaction<'_>, now: u64) -> Result<(), &'static str> {
    tx.execute("UPDATE creator_playtest_runs SET status='expired',active_slot=NULL,finished_at_ms=?1 WHERE active_slot=1 AND expires_at_ms<=?1", [now])
        .map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

fn start_playtest(home: &Path, studio_instance: &str, release_id: &str, expected_project: Option<&str>, expected_revision: Option<u64>) -> Result<Value, &'static str> {
    if !valid_id(studio_instance) || !valid_id(release_id) { return Err("creator_request_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let now = now_ms();
    expire_playtests(&tx, now)?;
    let active: Option<(String, String, String, u64, String)> = tx.query_row("SELECT run_id,release_id,studio_instance_id,revision,project_id FROM creator_playtest_runs WHERE active_slot=1", [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).optional().map_err(|_| "creator_store_unavailable")?;
    if let Some((run_id, active_release, active_studio, active_revision, active_project)) = active {
        if active_release == release_id && active_studio == studio_instance {
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
    let run_id = new_id("playtest-")?;
    tx.execute("INSERT INTO creator_playtest_runs(run_id,release_id,project_id,revision,studio_instance_id,status,active_slot,created_at_ms,expires_at_ms)
        VALUES(?1,?2,?3,?4,?5,'pending',1,?6,?7)", params![run_id,release_id,project_id,revision,studio_instance,now,now.saturating_add(PLAYTEST_TTL_MS)])
        .map_err(|_| "creator_store_unavailable")?;
    tx.execute("DELETE FROM creator_playtest_runs WHERE active_slot IS NULL AND run_id NOT IN (SELECT run_id FROM creator_playtest_runs ORDER BY created_at_ms DESC LIMIT ?1)", [MAX_PLAYTEST_HISTORY])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"runId":run_id,"releaseId":release_id,"projectId":project_id,"revision":revision,"status":"pending"}))
}

fn claim_playtest(home: &Path, city_instance: &str) -> Result<Value, &'static str> {
    if !valid_id(city_instance) { return Err("creator_request_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let now = now_ms();
    expire_playtests(&tx, now)?;
    let row: Option<(String,String,String,u64,String,Option<String>,String)> = tx.query_row(
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
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"runId":run_id,"releaseId":release_id,"projectId":project_id,"revision":revision,"snapshotDigest":snapshot_digest,"skinId":skin_id,
        "game":snapshot["game"],"mounts":snapshot["mounts"],
        "scene":snapshot.get("scene").cloned().unwrap_or_else(|| json!({"schemaVersion":1,"objects":[]})),
        "assets":snapshot.get("assets").cloned().unwrap_or_else(|| json!({"schemaVersion":1,"entries":[]})),
        "assetRefs":snapshot.get("assetRefs").cloned().unwrap_or_else(|| json!([])),
        "returnContext":{"projectId":project_id,"revision":revision}}))
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

fn finish_playtest(home: &Path, city_instance: &str, run_id: &str, status: &str, evidence: Option<&Value>, failure_code: Option<&str>) -> Result<Value, &'static str> {
    if !valid_id(city_instance) || !valid_id(run_id) || !matches!(status,"completed"|"cancelled"|"failed") { return Err("creator_request_invalid"); }
    if failure_code.is_some_and(|code| !valid_id(code)) || (status != "failed" && failure_code.is_some()) { return Err("creator_request_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let row: Option<(String,Option<String>,String,String,u64,Option<u64>,u64,String,Option<String>,Option<String>)> = tx.query_row(
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

fn take_playtest_return(home: &Path) -> Result<Value, &'static str> {
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let row: Option<(String,String,u64,String,Option<String>,Option<String>)> = tx.query_row("SELECT run_id,project_id,revision,status,evidence_json,failure_code FROM creator_playtest_runs
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

fn list_playtest_history(home: &Path, project_id: &str, limit: u64) -> Result<Value, &'static str> {
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
fn read_playtest_result(home: &Path, run_id: &str) -> Result<Value, &'static str> {
    if !valid_id(run_id) { return Err("creator_request_invalid"); }
    let db = database(home)?;
    let row: Option<(String,String,String,u64,String,u64,Option<u64>,Option<String>,Option<String>)> = db.query_row(
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
fn cancel_playtest(home: &Path, studio_instance: &str, run_id: &str) -> Result<Value, &'static str> {
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

/// MCP P0（设计 §6.4）：面向 Agent 的项目/场景紧凑摘要——有界、白名单字段、
/// 不含完整项目文档。提供 revision 时校验漂移，防止 Agent 基于旧摘要生成操作。
fn describe_scene(home: &Path, project_id: &str, expected_revision: Option<u64>, selected_object_id: Option<&str>) -> Result<Value, &'static str> {
    if !valid_id(project_id) { return Err("creator_request_invalid"); }
    let db = database(home)?;
    let raw: String = db.query_row("SELECT document_json FROM creator_projects WHERE project_id=?1", [project_id], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_project_not_found")?;
    let document: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    let revision = document.get("revision").and_then(Value::as_u64).ok_or("creator_project_invalid")?;
    if let Some(expected) = expected_revision {
        if expected != revision { return Err("revision_conflict"); }
    }
    // BTreeMap 而不是 serde_json::Map：后者存 Value，`+= 1` 不成立；顺带钉住稳定的键序。
    let mut object_counts: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
    for object in document.get("scene").and_then(|scene| scene.get("objects")).and_then(Value::as_array).unwrap_or(&Vec::new()) {
        let kind = object.get("kind").and_then(Value::as_str).unwrap_or("unknown").to_owned();
        *object_counts.entry(kind).or_insert(0) += 1;
    }
    let mounts: Vec<Value> = document.get("mounts").and_then(Value::as_array).map(|list|
        list.iter().map(|mount| json!({"mountId":mount.get("mountId"),"entryAnchorId":mount.get("entryAnchorId"),
            "slotCount":mount.get("bindings").and_then(Value::as_object).map_or(0, serde_json::Map::len)})).collect()).unwrap_or_default();
    let selected = selected_object_id.and_then(|id| document.get("scene").and_then(|scene| scene.get("objects")).and_then(Value::as_array)
        .and_then(|objects| objects.iter().find(|object| object.get("id").and_then(Value::as_str) == Some(id))))
        .map(|object| json!({"id":object.get("id"),"kind":object.get("kind"),"transform":object.get("transform").cloned().unwrap_or(Value::Null)}));
    Ok(json!({
        "projectId":project_id,
        "revision":revision,
        "title":document.get("title"),
        "cityLayout":{"worldRevision":document["cityLayout"]["worldRevision"],"seed":document["cityLayout"]["seed"],
            "anchorCount":document["cityLayout"]["layout"]["anchors"].as_array().map_or(0, Vec::len)},
        "objectCounts":object_counts,
        "mounts":mounts,
        "skinId":document.get("skinId").cloned().unwrap_or(Value::Null),
        "cityPatchBuildingMoves":document.get("cityPatch").and_then(|patch| patch.get("buildingMoves")).and_then(Value::as_object).map_or(0, serde_json::Map::len),
        "assetCount":document["assets"]["entries"].as_array().map_or(0, Vec::len),
        "selected":selected,
        "editableCategories":["game","scene","mount","skin","cityPatch"],
        "generatedAtMs":now_ms(),
    }))
}

/// MCP P1（设计 §6.4）：稳定的契约发现——登记过的操作类别、预算和能力版本。
/// 只描述能力，不返回可执行代码；生成的操作仍经 preview/commit 权威校验。
fn creator_capabilities() -> Value {
    json!({
        "schemaVersion":1,
        "categories":{
            "game":{"preview":"creator.game.preview","commit":"creator.project.commit","maxGameBytes":MAX_GAME_BYTES},
            "scene":{"preview":"creator.scene.preview","commit":"creator.scene.commit",
                "objectKinds":["model","anchor","collider"],"maxObjects":MAX_SCENE_OBJECTS,
                "maxColliders":MAX_SCENE_COLLIDERS,"maxOperationsPerPreview":128},
            "mount":{"bind":"mount.bind","remove":"mount.remove","maxReleaseMounts":MAX_RELEASE_MOUNTS},
            "skin":{"select":"skin.select","skins":["miami-vice","desert-evening"]},
            "cityPatch":{"upsert":"city.patch.upsert","remove":"city.patch.remove","maxBytes":MAX_CITY_PATCH_BYTES},
            "assets":{"import":"creator.asset.import（桌面原生选择器，MCP 不接收路径）","maxImportedModelBytes":MAX_IMPORTED_MODEL_BYTES,"maxAssets":MAX_PROJECT_ASSETS},
            "playtest":{"start":"creator.project.playtest.start","result":"creator.project.playtest.result","cancel":"creator.project.playtest.cancel","ttlMs":PLAYTEST_TTL_MS},
            "project":{"create":"creator.project.create","publish":"creator.project.publish","maxDocumentBytes":MAX_PROJECT_BYTES,"maxReleaseBytes":MAX_RELEASE_BYTES},
        },
        "preview":{"ttlMs":PREVIEW_TTL.as_millis(),"maxActive":MAX_ACTIVE_PREVIEWS,"singleUse":true,"instanceBound":true},
    })
}

/// MCP P1（设计 §6.4）：category 过滤——未知类别返回 creator_capability_unknown，
/// schemaVersion 仅支持 1；已知类别只返回该类别的登记能力。
fn creator_capabilities_filtered(category: &str, schema_version: u64) -> Result<Value, &'static str> {
    if schema_version != 1 { return Err("creator_capability_version_unsupported"); }
    let all = creator_capabilities();
    let entry = all["categories"].as_object().and_then(|known| known.get(category)).ok_or("creator_capability_unknown")?;
    let supported = all["categories"].as_object().map(|known| known.keys().collect::<Vec<_>>()).unwrap_or_default();
    Ok(json!({"schemaVersion":1,"category":category,"capabilities":entry,
        "preview":all["preview"],"supportedCategories":supported}))
}

/// MCP P1（设计 §6.4）：按稳定 objectId 检查单个对象/锚点/挂载，只返回白名单
/// 字段、引用关系和编辑限制。revision 必填并校验漂移；不返回源路径、GLB 字节
/// 或布局外的关联数据。
fn inspect_scene_object(home: &Path, project_id: &str, expected_revision: u64, object_id: &str) -> Result<Value, &'static str> {
    if !valid_id(project_id) || !valid_id(object_id) { return Err("creator_request_invalid"); }
    let db = database(home)?;
    let raw: String = db.query_row("SELECT document_json FROM creator_projects WHERE project_id=?1", [project_id], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_project_not_found")?;
    let document: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    let revision = document.get("revision").and_then(Value::as_u64).ok_or("creator_project_invalid")?;
    if expected_revision != revision { return Err("revision_conflict"); }
    // 场景对象（model/anchor/collider）：白名单字段 + 引用的资产标识
    if let Some(object) = document.get("scene").and_then(|scene| scene.get("objects")).and_then(Value::as_array)
        .and_then(|objects| objects.iter().find(|object| object.get("id").and_then(Value::as_str) == Some(object_id))) {
        let kind = object.get("kind").and_then(Value::as_str).unwrap_or("unknown");
        let mut entry = json!({"id":object.get("id"),"kind":kind,"transform":object.get("transform").cloned().unwrap_or(Value::Null),
            "editableVia":["scene.object.upsert","scene.object.remove"],"requiresPreview":true});
        if kind == "model" {
            entry["assetRef"] = object.get("asset").cloned().unwrap_or(Value::Null);
            entry["constraints"] = json!({"assetMustReferenceBoundLayout": true});
        }
        return Ok(json!({"projectId":project_id,"revision":revision,"object":entry,"source":"scene"}));
    }
    // 挂载：按 mountId 检查
    if let Some(mount) = document.get("mounts").and_then(Value::as_array)
        .and_then(|mounts| mounts.iter().find(|mount| mount.get("mountId").and_then(Value::as_str) == Some(object_id))) {
        return Ok(json!({"projectId":project_id,"revision":revision,"object":json!({
            "id":mount.get("mountId"),"kind":"mount","entryAnchorId":mount.get("entryAnchorId"),
            "bindings":mount.get("bindings"),"layout":mount.get("layout"),"game":mount.get("game"),
            "editableVia":["mount.bind","mount.remove"],"requiresPreview":true}),"source":"mount"}));
    }
    // 绑定布局里的锚点是来自 City 的只读引用：只能作为挂载目标，不能改布局
    if let Some(anchor) = document.get("cityLayout").and_then(|layout| layout.get("layout")).and_then(|layout| layout.get("anchors"))
        .and_then(Value::as_array).and_then(|anchors| anchors.iter().find(|anchor| anchor.get("id").and_then(Value::as_str) == Some(object_id))) {
        return Ok(json!({"projectId":project_id,"revision":revision,"object":json!({
            "id":anchor.get("id"),"kind":anchor.get("kind"),"capabilities":anchor.get("capabilities"),
            "geometryRef":anchor.get("geometryRef"),"editable":false,
            "constraint":"只读锚点：来自 City 布局快照，仅可作为挂载绑定或检查点引用"}),"source":"cityLayout"}));
    }
    Err("creator_object_not_found")
}

/// MCP P1（设计 §6.4）：结构化校验——静态 schema/资产存储检查逐项报告，
/// 需要 City 运行时的检查如实标记为未运行，不得显示通过。确定性：同一
/// 输入/revision 的结果稳定（不消耗 preview、不写库）。
fn validate_scene(home: &Path, project_id: &str, expected_revision: Option<u64>, profile: Option<&str>) -> Result<Value, &'static str> {
    if !valid_id(project_id) { return Err("creator_request_invalid"); }
    match profile {
        None | Some("static") => {}
        _ => return Err("creator_validation_profile_unsupported"),
    }
    const MAX_ITEMS: usize = 100;
    let db = database(home)?;
    let raw: String = db.query_row("SELECT document_json FROM creator_projects WHERE project_id=?1", [project_id], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_project_not_found")?;
    let document: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    let revision = document.get("revision").and_then(Value::as_u64).ok_or("creator_project_invalid")?;
    if let Some(expected) = expected_revision {
        if expected != revision { return Err("revision_conflict"); }
    }
    // 诊断条目有界（审查 #2）：万对象全坏时响应会超过插件 64 KiB 邮箱——
    // 超出 MAX_ITEMS 后停止收集并如实标注 truncated，而不是让调用方等超时。
    let mut items: Vec<Value> = Vec::new();
    let mut truncated = false;
    let push_item = |items: &mut Vec<Value>, truncated: &mut bool, entry: Value| {
        if items.len() < MAX_ITEMS { items.push(entry); } else { *truncated = true; }
    };
    let item = |code: &str, severity: &str, source: &str, object_id: Option<&str>, message: &str| {
        json!({"code":code,"severity":severity,"source":source,
            "objectId":object_id.map(Value::from).unwrap_or(Value::Null),"message":message})
    };
    let empty_objects = Vec::new();
    let objects = document.get("scene").and_then(|scene| scene.get("objects")).and_then(Value::as_array).unwrap_or(&empty_objects);
    let mut seen = std::collections::HashSet::new();
    let mut colliders = 0usize;
    for object in objects {
        let id = object.get("id").and_then(Value::as_str).unwrap_or("unknown");
        if let Err(code) = validate_scene_object(object) {
            push_item(&mut items, &mut truncated, item(code, "error", "static-schema", Some(id), "对象未通过 schema 校验"));
            continue;
        }
        if !seen.insert(id.to_owned()) {
            push_item(&mut items, &mut truncated, item("creator_scene_duplicate_id", "error", "static-schema", Some(id), "对象 ID 重复"));
            continue;
        }
        if object.get("kind").and_then(Value::as_str) == Some("collider") { colliders += 1; }
        // model 的资产引用逐项校验：包匹配布局版本 + 引用登记（静态）；文件字节在资产存储侧单独检查
        if object.get("kind").and_then(Value::as_str) == Some("model") {
            if let Err(code) = validate_project_asset_ref(&document, object) {
                push_item(&mut items, &mut truncated, item(code, "error", "static-schema", Some(id), "资产引用与绑定布局或登记不符"));
            }
        }
    }
    if colliders > MAX_SCENE_COLLIDERS {
        push_item(&mut items, &mut truncated, item("creator_scene_collider_budget_exceeded", "error", "static-schema", None, "碰撞代理数量超出预算"));
    }
    // 资产存储：真实读取本机项目目录里的字节并核对摘要（区别于静态 schema 检查）。
    // 大项目逐个读 64 MiB 资产可能远超 20s 工具预算——失败时如实标记跳过，
    // 不让调用方等待，也不显示「通过」。
    match verify_scene_asset_bytes(home, project_id, &document, Some(MAX_VALIDATE_ASSET_CHECKS)) {
        Ok(()) => {}
        Err("creator_asset_verify_skipped") => {
            push_item(&mut items, &mut truncated, item("creator_asset_verify_skipped", "warning", "asset-store", None, "资产数量或体积超出本次校验预算，字节核对未运行"));
        }
        Err(code) => {
            push_item(&mut items, &mut truncated, item(code, "error", "asset-store", None, "已登记资产的字节缺失或摘要不匹配"));
        }
    }
    for mount in document.get("mounts").and_then(Value::as_array).unwrap_or(&Vec::new()) {
        if let Err(code) = validate_mount(&document, mount) {
            push_item(&mut items, &mut truncated, item(code, "error", "static-schema", mount.get("mountId").and_then(Value::as_str), "挂载未通过校验"));
        }
    }
    if let Some(patch) = document.get("cityPatch") {
        if let Some(seed) = document.get("cityLayout").and_then(|layout| layout.get("seed")).and_then(Value::as_u64) {
            if let Err(code) = validate_city_patch(patch, seed) {
                push_item(&mut items, &mut truncated, item(code, "error", "static-schema", None, "城市补丁未通过校验"));
            }
        }
    }
    // 需要 City 运行时的检查如实列为未运行——绝不因此显示通过
    let unchecked = json!([
        {"check":"drive_reachability","reason":"requires_city_runtime"},
        {"check":"collision_overlap","reason":"requires_city_runtime"},
        {"check":"visual_review","reason":"requires_human_or_renderer"}
    ]);
    // ok 只看未截断的静态错误；截断本身不代表通过，调用方据 truncated 自行重试
    let ok = !truncated && !items.iter().any(|entry| entry["severity"] == "error");
    Ok(json!({"projectId":project_id,"revision":revision,"ok":ok,"truncated":truncated,"items":items,"unchecked":unchecked}))
}

pub fn preview_replace_game(home: &Path, actor: &str, project_id: &str, base_revision: u64, game: &Value) -> Result<Value, &'static str> {
    if actor.is_empty() || actor.len() > 128 || !valid_id(project_id) { return Err("creator_request_invalid"); }
    let game_json = validate_game(game)?;
    let db = database(home)?;
    let (revision, raw): (u64, String) = db.query_row("SELECT revision,document_json FROM creator_projects WHERE project_id=?1", [project_id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_project_not_found")?;
    if revision != base_revision { return Err("revision_conflict"); }
    let mut document: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    document["game"] = serde_json::from_str(&game_json).map_err(|_| "creator_game_invalid")?;
    let preview_id = new_id("preview-")?;
    let normalized = serde_json::to_string(&json!({"op":"game.replace","game":serde_json::from_str::<Value>(&game_json).map_err(|_| "creator_game_invalid")?})).map_err(|_| "creator_game_invalid")?;
    let mut active_previews = previews().lock().unwrap_or_else(|p| p.into_inner());
    active_previews.retain(|_, item| item.created.elapsed().is_ok_and(|age| age <= PREVIEW_TTL));
    if active_previews.len() >= MAX_ACTIVE_PREVIEWS { return Err("creator_preview_budget_exceeded"); }
    active_previews.insert(preview_id.clone(), Preview { actor: actor.into(), project_id: project_id.into(), base_revision, operation_hash: digest(&normalized), document: document.to_string(), created: SystemTime::now(),
        });
    let game_id = game.get("id").and_then(Value::as_str).filter(|id| valid_id(id)).unwrap_or("game").to_owned();
    Ok(json!({"previewId":preview_id,"projectId":project_id,"baseRevision":revision,"expiresInMs":PREVIEW_TTL.as_millis(),
        "diff":{"path":"game","beforeDigest":digest(&raw),"afterDigest":digest(&game_json)},
        "changedObjects":[{"id":game_id,"kind":"game","fields":["game"],"beforeDigest":digest(&raw),"afterDigest":digest(&game_json)}],
        "diagnostics":[]}))
}

pub fn preview_scene_operations(home: &Path, actor: &str, project_id: &str, base_revision: u64, operations: &Value) -> Result<Value, &'static str> {
    if actor.is_empty() || actor.len() > 128 || !valid_id(project_id) { return Err("creator_request_invalid"); }
    let normalized = serde_json::to_string(operations).map_err(|_| "creator_scene_ops_invalid")?;
    if normalized.len() > MAX_PROJECT_BYTES { return Err("creator_project_budget_exceeded"); }
    let db = database(home)?;
    let (revision, raw): (u64, String) = db.query_row("SELECT revision,document_json FROM creator_projects WHERE project_id=?1", [project_id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_project_not_found")?;
    if revision != base_revision { return Err("revision_conflict"); }
    let mut document: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    let touched = apply_scene_operations(&mut document, operations)?;
    verify_scene_asset_bytes(home, project_id, &document, None)?;
    let serialized = serde_json::to_string(&document).map_err(|_| "creator_project_invalid")?;
    if serialized.len() > MAX_PROJECT_BYTES { return Err("creator_project_budget_exceeded"); }
    let preview_id = new_id("preview-")?;
    let mut active_previews = previews().lock().unwrap_or_else(|p| p.into_inner());
    active_previews.retain(|_, item| item.created.elapsed().is_ok_and(|age| age <= PREVIEW_TTL));
    if active_previews.len() >= MAX_ACTIVE_PREVIEWS { return Err("creator_preview_budget_exceeded"); }
    active_previews.insert(preview_id.clone(), Preview { actor: actor.into(), project_id: project_id.into(), base_revision, operation_hash: digest(&normalized), document: serialized.clone(), created: SystemTime::now(),
        });
    let paths: Vec<&str> = touched.iter().map(|(path, _)| path.as_str()).collect();
    let changed_objects: Vec<Value> = touched.iter().map(|(path, action)| {
        // 稳定 id 可能含点（valid_id 允许 `.`）：只有 scene.objects. 前缀剥离，
        // 其余路径整段保留——rsplit 按点截断会把 villa.01 错报成 01。
        let id = path.strip_prefix("scene.objects.").unwrap_or(path);
        let kind = if path.starts_with("cityPatch") { "cityPatch" }
            else if path.starts_with("mounts") { "mount" }
            else if path.starts_with("skinId") { "skin" }
            else { "sceneObject" };
        json!({"id":id,"path":path,"kind":kind,"action":action})
    }).collect();
    Ok(json!({"previewId":preview_id,"projectId":project_id,"baseRevision":revision,"expiresInMs":PREVIEW_TTL.as_millis(),
        "diff":{"paths":paths,"beforeDigest":digest(&raw),"afterDigest":digest(&serialized)},
        "changedObjects":changed_objects,
        "diagnostics":[]}))
}

#[cfg(test)]
fn commit_preview(home: &Path, actor: &str, project_id: &str, preview_id: &str, expected_revision: u64, operation_id: &str) -> Result<Value, &'static str> {
    commit_preview_as(home, actor, actor, project_id, preview_id, expected_revision, operation_id)
}

pub fn commit_preview_as(home: &Path, owner: &str, instance: &str, project_id: &str, preview_id: &str, expected_revision: u64, operation_id: &str) -> Result<Value, &'static str> {
    if owner.is_empty() || owner.len() > 128 || instance.is_empty() || instance.len() > 128 || !valid_id(project_id) || !valid_id(preview_id) || !valid_id(operation_id) { return Err("creator_request_invalid"); }
    let request_hash = digest(&format!("{preview_id}:{expected_revision}"));
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some((previous_hash, result)) = tx.query_row("SELECT operation_hash,result_json FROM creator_operations WHERE project_id=?1 AND actor_id=?2 AND operation_id=?3", params![project_id, owner, operation_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional().map_err(|_| "creator_store_unavailable")? {
        if previous_hash != request_hash { return Err("operation_id_conflict"); }
        return serde_json::from_str(&result).map_err(|_| "creator_store_unavailable");
    }
    let preview = {
        // Peek, do not consume: the preview stays available until the transaction
        // commits, so a mid-way SQLite failure can be retried with the same
        // request instead of dead-ending on preview_expired. Concurrent reuse of
        // the same preview is still bounded by the revision CAS below and the
        // creator_changes primary key.
        let mut active_previews = previews().lock().unwrap_or_else(|p| p.into_inner());
        let preview = active_previews.get(preview_id).cloned().ok_or("preview_expired")?;
        if preview.created.elapsed().map_or(true, |age| age > PREVIEW_TTL) { active_previews.remove(preview_id); return Err("preview_expired"); }
        if preview.actor != instance || preview.project_id != project_id { return Err("permission_denied"); }
        if preview.base_revision != expected_revision { return Err("revision_conflict"); }
        preview
    };
    let current: u64 = tx.query_row("SELECT revision FROM creator_projects WHERE project_id=?1", [project_id], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_project_not_found")?;
    if current != expected_revision { return Err("revision_conflict"); }
    let next = current.checked_add(1).ok_or("revision_exhausted")?;
    let mut document: Value = serde_json::from_str(&preview.document).map_err(|_| "creator_store_unavailable")?;
    document["revision"] = json!(next);
    let serialized = document.to_string();
    let now = now_ms();
    let updated = tx.execute("UPDATE creator_projects SET revision=?2,document_json=?3,updated_at_ms=?4 WHERE project_id=?1 AND revision=?5", params![project_id, next, serialized, now, current]).map_err(|_| "creator_store_unavailable")?;
    if updated == 0 { return Err("revision_conflict"); }
    tx.execute("INSERT INTO creator_changes(project_id,revision,actor_id,operation_id,operation_hash,document_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![project_id, next, owner, operation_id, preview.operation_hash, serialized, now]).map_err(|_| "creator_store_unavailable")?;
    let result = json!({"projectId":project_id,"revision":next,"operationId":operation_id,"documentDigest":digest(&serialized)});
    tx.execute("INSERT INTO creator_operations(project_id,actor_id,operation_id,operation_hash,result_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6)", params![project_id, owner, operation_id, request_hash, result.to_string(), now]).map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    // Consumed only after a successful commit: the preview credential's
    // lifetime matches the transaction, not the attempt.
    previews().lock().unwrap_or_else(|p| p.into_inner()).remove(preview_id);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creator_content_digest_uses_sorted_canonical_json_keys() {
        let value = json!({"z":1,"a":{"b":2,"a":3}});
        assert_eq!(canonical_json(&value).unwrap(), r#"{"a":{"a":3,"b":2},"z":1}"#);
        assert_eq!(digest(&canonical_json(&value).unwrap()), "sha256:5e25419dddc4ffcc0c75b9b9eb2bccff8576756f0ab9a2913b52bb78ea2e3b6a");
    }
    fn layout_snapshot() -> Value {
        json!({"schemaVersion":1,"worldRevision":"world-rev-test","seed":7,"layout":{
            "schemaVersion":1,"id":"city-layout-v1-test","coordinateSystem":"city-local-m-v1","anchors":[
                {"id":"road-spawn:a","kind":"spawn","capabilities":["drive"],"geometryRef":"city-road-node:a"},
                {"id":"road-checkpoint:ab","kind":"zone","capabilities":["drive"],"geometryRef":"city-road-edge:ab:midpoint"},
                {"id":"road-checkpoint:bc","kind":"zone","capabilities":["drive"],"geometryRef":"city-road-edge:bc:midpoint"},
                {"id":"road-checkpoint:cd","kind":"zone","capabilities":["drive"],"geometryRef":"city-road-edge:cd:midpoint"}
            ],"links":[
                {"id":"link-a","fromAnchorId":"road-spawn:a","toAnchorId":"road-checkpoint:ab","capabilities":["drive"]},
                {"id":"link-b","fromAnchorId":"road-checkpoint:ab","toAnchorId":"road-checkpoint:bc","capabilities":["drive"]},
                {"id":"link-c","fromAnchorId":"road-checkpoint:bc","toAnchorId":"road-checkpoint:cd","capabilities":["drive"]}
            ]
        }})
    }
    fn publishable_project(home: &Path) -> (String, u64) {
        publish_city_layout_snapshot(home, &layout_snapshot()).unwrap();
        let created = create_project_from_city_layout(home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-publishable", "world-rev-test").unwrap();
        let project_id = created["projectId"].as_str().unwrap().to_owned();
        let project = read_project(home, &project_id).unwrap();
        let game_digest = digest(&canonical_json(&project["game"]).unwrap());
        let mount = json!({
            "schemaVersion":1,"mountId":"release-mount",
            "layout":{"kind":"city-layout","id":"city-layout-v1-test","version":"1","digest":"world-rev-test"},
            "game":{"kind":"city-minigame","id":project["game"]["id"],"version":"1","digest":game_digest},
            "entryAnchorId":"road-spawn:a","bindings":{"points":["road-checkpoint:ab","road-checkpoint:bc","road-checkpoint:cd"]},"parameterOverrides":{"timeLimitTicks":2400}
        });
        let preview = preview_scene_operations(home, "studio-instance", &project_id, 0, &json!([{"op":"mount.bind","mount":mount}])).unwrap();
        let saved = commit_preview_as(home, LOCAL_CREATOR_OWNER, "studio-instance", &project_id,
            preview["previewId"].as_str().unwrap(), 0, "save-release-mount").unwrap();
        (project_id, saved["revision"].as_u64().unwrap())
    }
    fn home() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!("creator-projects-test-{}-{}", now_ms(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_glb(external_uri: bool) -> Vec<u8> {
        let uri = if external_uri { ",\"uri\":\"model.bin\"" } else { "" };
        let json = format!("{{\"asset\":{{\"version\":\"2.0\"}},\"buffers\":[{{\"byteLength\":12{uri}}}],\"bufferViews\":[{{\"buffer\":0,\"byteLength\":12}}],\"accessors\":[{{\"bufferView\":0,\"componentType\":5126,\"count\":3,\"type\":\"VEC3\",\"min\":[-1,0,-1],\"max\":[1,2,1]}}],\"meshes\":[{{\"primitives\":[{{\"attributes\":{{\"POSITION\":0}}}}]}}]}}");
        let json_len = (json.len() + 3) & !3;
        let total = 12 + 8 + json_len + 8 + 12;
        let mut bytes = Vec::with_capacity(total);
        bytes.extend_from_slice(b"glTF");
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&(total as u32).to_le_bytes());
        bytes.extend_from_slice(&(json_len as u32).to_le_bytes());
        bytes.extend_from_slice(&0x4e4f534au32.to_le_bytes());
        bytes.extend_from_slice(json.as_bytes());
        bytes.resize(20 + json_len, b' ');
        bytes.extend_from_slice(&12u32.to_le_bytes());
        bytes.extend_from_slice(&0x004e4942u32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 12]);
        bytes
    }

    #[test]
    fn native_asset_import_pins_glb_to_project_and_scene_references() {
        let home = home();
        publish_city_layout_snapshot(&home, &layout_snapshot()).unwrap();
        let created = create_project_from_city_layout(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-asset-project", "world-rev-test").unwrap();
        let project_id = created["projectId"].as_str().unwrap();
        let source = home.join("model.glb");
        let bytes = test_glb(false);
        std::fs::write(&source, &bytes).unwrap();
        let imported = import_model_asset(&home, LOCAL_CREATOR_OWNER, project_id, 0, "import-asset", &source).unwrap();
        assert_eq!(import_model_asset(&home, LOCAL_CREATOR_OWNER, project_id, 0, "import-asset", &source).unwrap(), imported);
        assert_eq!(imported["revision"], 1);
        assert_eq!(imported["byteLength"], bytes.len());
        assert_eq!(imported["boundsMeters"], json!({"x":2.0,"y":2.0,"z":2.0}));
        assert_eq!(imported["assetRef"]["package"]["id"], "city-layout-v1-test");
        let project = read_project(&home, project_id).unwrap();
        assert_eq!(project["assets"]["entries"].as_array().unwrap().len(), 1);
        assert_eq!(project["assetRefs"].as_array().unwrap().len(), 1);
        let asset_hash = imported["digest"].as_str().unwrap().strip_prefix("sha256:").unwrap();
        let stored_asset = home.join("state/creator/projects").join(project_id).join("assets").join(format!("{asset_hash}.glb"));
        let mut tampered = bytes.clone();
        tampered[20] ^= 1;
        std::fs::write(&stored_asset, tampered).unwrap();
        let object = json!({"id":"model-instance-1","kind":"model","asset":imported["assetRef"],"transform":{
            "positionMeters":{"x":0,"y":0,"z":0},"rotationRadians":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}}});
        let operations = json!([{"op":"scene.object.upsert","object":object}]);
        assert_eq!(preview_scene_operations(&home, "studio-instance", project_id, 1, &operations).unwrap_err(), "creator_scene_asset_digest_mismatch");
        std::fs::write(&stored_asset, &bytes).unwrap();
        let preview = preview_scene_operations(&home, "studio-instance", project_id, 1, &operations).unwrap();
        let saved = commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", project_id, preview["previewId"].as_str().unwrap(), 1, "place-model").unwrap();
        assert_eq!(saved["revision"], 2);
        let project = read_project(&home, project_id).unwrap();
        let game_digest = digest(&canonical_json(&project["game"]).unwrap());
        let mount = json!({"schemaVersion":1,"mountId":"release-mount",
            "layout":{"kind":"city-layout","id":"city-layout-v1-test","version":"1","digest":"world-rev-test"},
            "game":{"kind":"city-minigame","id":project["game"]["id"],"version":"1","digest":game_digest},
            "entryAnchorId":"road-spawn:a","bindings":{"points":["road-checkpoint:ab","road-checkpoint:bc","road-checkpoint:cd"]},"parameterOverrides":{"timeLimitTicks":2400}});
        let mount_preview = preview_scene_operations(&home, "studio-instance", project_id, 2, &json!([{"op":"mount.bind","mount":mount}])).unwrap();
        commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", project_id, mount_preview["previewId"].as_str().unwrap(), 2, "bind-model-release").unwrap();
        let release = publish_project_release(&home, project_id, 3).unwrap();
        let release_read = read_city_release(&home, release["releaseId"].as_str().unwrap(), "city-layout-v1-test", "world-rev-test").unwrap();
        assert_eq!(release_read["scene"]["objects"].as_array().unwrap().len(), 1);
        assert_eq!(release_read["assets"]["entries"].as_array().unwrap().len(), 1);
        let release_id = release["releaseId"].as_str().unwrap();
        let asset_digest = imported["digest"].as_str().unwrap();
        assert_eq!(read_city_release_asset(&home, release_id, asset_digest).unwrap(), bytes);
        let mut tampered_release_asset = bytes.clone();
        tampered_release_asset[20] ^= 1;
        std::fs::write(&stored_asset, tampered_release_asset).unwrap();
        assert_eq!(read_city_release_asset(&home, release_id, asset_digest).unwrap_err(), "creator_release_asset_digest_mismatch");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn creator_scene_accepts_only_bounded_explicit_box_colliders() {
        let home = home();
        publish_city_layout_snapshot(&home, &layout_snapshot()).unwrap();
        let created = create_project_from_city_layout(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-collider-project", "world-rev-test").unwrap();
        let project_id = created["projectId"].as_str().unwrap();
        let collider = json!({"id":"wall-1","kind":"collider","shape":"box","sizeMeters":{"x":4,"y":2,"z":6},"transform":{
            "positionMeters":{"x":10,"y":1,"z":-2},"rotationRadians":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}}});
        let preview = preview_scene_operations(&home, "studio-instance", project_id, 0,
            &json!([{"op":"scene.object.upsert","object":collider}])).unwrap();
        assert_eq!(preview["diff"]["paths"][0], "scene.objects.wall-1");
        let invalid = json!({"id":"wall-2","kind":"collider","shape":"box","sizeMeters":{"x":0.01,"y":2,"z":6},"transform":{
            "positionMeters":{"x":10,"y":1,"z":-2},"rotationRadians":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}}});
        assert_eq!(preview_scene_operations(&home, "studio-instance", project_id, 0,
            &json!([{"op":"scene.object.upsert","object":invalid}])).unwrap_err(), "creator_scene_collider_invalid");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn glb_import_rejects_external_resources_and_invalid_geometry() {
        assert_eq!(inspect_glb(&test_glb(true)).unwrap_err(), "creator_asset_external_resource_denied");
        let mut corrupt = test_glb(false);
        corrupt[8] = 1;
        assert_eq!(inspect_glb(&corrupt).unwrap_err(), "creator_asset_glb_invalid");
    }

    #[test]
    fn existing_creator_store_adds_bounded_playtest_evidence_column() {
        let home = home();
        let directory = home.join("state/creator");
        std::fs::create_dir_all(&directory).unwrap();
        let db = Connection::open(directory.join("projects.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE creator_playtest_runs (
            run_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, project_id TEXT NOT NULL,
            revision INTEGER NOT NULL, studio_instance_id TEXT NOT NULL, city_instance_id TEXT,
            status TEXT NOT NULL, active_slot INTEGER UNIQUE, created_at_ms INTEGER NOT NULL,
            expires_at_ms INTEGER NOT NULL, finished_at_ms INTEGER, return_consumed INTEGER NOT NULL DEFAULT 0
        );").unwrap();
        drop(db);
        let migrated = database(&home).unwrap();
        let count: u64 = migrated.query_row("SELECT COUNT(*) FROM pragma_table_info('creator_playtest_runs') WHERE name='evidence_json'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn city_layout_catalog_is_revision_bound_and_projects_can_pin_it() {
        let home = home();
        let snapshot = layout_snapshot();
        assert_eq!(publish_city_layout_snapshot(&home, &snapshot).unwrap()["worldRevision"], "world-rev-test");
        assert_eq!(publish_city_layout_snapshot(&home, &snapshot).unwrap()["anchorCount"], 4);
        let mut changed = snapshot.clone(); changed["seed"] = json!(8);
        assert_eq!(publish_city_layout_snapshot(&home, &changed).unwrap_err(), "creator_layout_revision_conflict");
        let layouts = list_city_layout_snapshots(&home, 8).unwrap();
        assert_eq!(layouts["layouts"][0]["anchorCount"], 4);
        let project = create_project_from_city_layout(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-bound", "world-rev-test").unwrap();
        let saved = read_project(&home, project["projectId"].as_str().unwrap()).unwrap();
        assert_eq!(saved["cityLayout"]["worldRevision"], "world-rev-test");
        assert_eq!(saved["cityLayout"]["layout"]["id"], "city-layout-v1-test");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn creator_mount_rejects_anchors_disconnected_in_the_pinned_city_topology() {
        let home = home();
        let mut snapshot = layout_snapshot();
        snapshot["worldRevision"] = json!("world-rev-disconnected");
        snapshot["layout"]["links"].as_array_mut().unwrap().pop();
        publish_city_layout_snapshot(&home, &snapshot).unwrap();
        let created = create_project_from_city_layout(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-disconnected", "world-rev-disconnected").unwrap();
        let project_id = created["projectId"].as_str().unwrap();
        let project = read_project(&home, project_id).unwrap();
        let game_digest = digest(&canonical_json(&project["game"]).unwrap());
        let mount = json!({
            "schemaVersion":1,"mountId":"disconnected-mount",
            "layout":{"kind":"city-layout","id":"city-layout-v1-test","version":"1","digest":"world-rev-disconnected"},
            "game":{"kind":"city-minigame","id":project["game"]["id"],"version":"1","digest":game_digest},
            "entryAnchorId":"road-spawn:a","bindings":{"points":["road-checkpoint:ab","road-checkpoint:bc","road-checkpoint:cd"]},"parameterOverrides":{"timeLimitTicks":2400}
        });
        assert_eq!(preview_scene_operations(&home, "studio-instance", project_id, 0,
            &json!([{"op":"mount.bind","mount":mount}])).unwrap_err(), "creator_mount_anchor_unreachable");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn city_release_is_immutable_revision_bound_and_filtered_by_current_layout() {
        let home = home();
        let (project_id, revision) = publishable_project(&home);
        assert_eq!(revision, 1);
        assert!(list_city_releases(&home, "city-layout-v1-test", "world-rev-test", 8).unwrap()["releases"].as_array().unwrap().is_empty());
        assert_eq!(publish_project_release(&home, &project_id, 0).unwrap_err(), "revision_conflict");

        let first = publish_project_release(&home, &project_id, revision).unwrap();
        let first_id = first["releaseId"].as_str().unwrap().to_owned();
        assert_eq!(publish_project_release(&home, &project_id, revision).unwrap(), first);
        let first_read = dispatch_city_runtime(&home, "city-instance", "city.creator.experiences.read", &json!({
            "releaseId":first_id,"layoutId":"city-layout-v1-test","worldRevision":"world-rev-test"
        })).unwrap();
        assert_eq!(first_read["revision"], 1);
        assert_eq!(first_read["skinId"], "miami-vice");
        assert_eq!(first_read["mounts"][0]["mountId"], "release-mount");
        assert_eq!(first_read["scene"]["objects"], json!([]));
        assert_eq!(first_read["assets"]["entries"], json!([]));
        assert_eq!(first_read["assetRefs"], json!([]));

        let mut second_layout = layout_snapshot();
        second_layout["worldRevision"] = json!("world-rev-other");
        second_layout["layout"]["id"] = json!("city-layout-v1-other");
        publish_city_layout_snapshot(&home, &second_layout).unwrap();
        assert!(list_city_releases(&home, "city-layout-v1-other", "world-rev-other", 8).unwrap()["releases"].as_array().unwrap().is_empty());
        assert_eq!(read_city_release(&home, &first_id, "city-layout-v1-other", "world-rev-other").unwrap_err(), "creator_release_not_found");
        assert_eq!(dispatch_city_runtime(&home, "city-instance", "city.creator.experiences.list", &json!({
            "layoutId":"city-layout-v1-test","worldRevision":"world-rev-test","limit":8,"includeDrafts":true
        })).unwrap_err(), "creator_method_unavailable");

        let saved = read_project(&home, &project_id).unwrap();
        let skin_preview = preview_scene_operations(&home, "studio-instance-2", &project_id, revision,
            &json!([{"op":"skin.select","skinId":"desert-evening"}])).unwrap();
        commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance-2", &project_id,
            skin_preview["previewId"].as_str().unwrap(), revision, "revise-after-release").unwrap();
        let second = publish_project_release(&home, &project_id, revision + 1).unwrap();
        assert_ne!(second["releaseId"], first["releaseId"]);
        let second_read = read_city_release(&home, second["releaseId"].as_str().unwrap(), "city-layout-v1-test", "world-rev-test").unwrap();
        assert_eq!(second_read["skinId"], "desert-evening");
        assert_eq!(read_city_release(&home, &first_id, "city-layout-v1-test", "world-rev-test").unwrap(), first_read);
        assert_eq!(publish_project_release(&home, &project_id, revision).unwrap_err(), "revision_conflict");
        assert_eq!(saved["revision"], revision);
        let _ = std::fs::remove_dir_all(home);
    }

    // MCP 试玩闭环（设计 §6.3）：归属校验拒绝 → pending 取消 → result 终态 →
    // 重复取消幂等；claimed 取消同样收敛；未知 runId 明确 not_found。
    #[test]
    fn playtest_start_result_cancel_reach_unique_terminal_states() {
        let home = home();
        let (project_id, revision) = publishable_project(&home);
        let published = publish_project_release(&home, &project_id, revision).unwrap();
        let release_id = published["releaseId"].as_str().unwrap().to_owned();
        // 归属不符直接拒绝，且不产生 run
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.start",
            &json!({"releaseId":release_id,"projectId":"other-project","expectedRevision":revision})).unwrap_err(), "creator_release_project_mismatch");
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.start",
            &json!({"releaseId":release_id,"expectedRevision":revision + 1})).unwrap_err(), "creator_release_revision_mismatch");
        // 契约形状启动：requestId 透传，结果带 project/revision
        let start = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.start",
            &json!({"releaseId":release_id,"projectId":project_id,"expectedRevision":revision,"requestId":"mcp-req-1"})).unwrap();
        assert_eq!(start["projectId"], project_id);
        assert_eq!(start["revision"], revision);
        assert_eq!(start["requestId"], "mcp-req-1");
        let run_id = start["runId"].as_str().unwrap().to_owned();
        // pending → result
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.result", &json!({"runId":run_id})).unwrap()["status"], "pending");
        // claim 后取消：City 的 finish 收到干净终态拒绝
        assert_eq!(dispatch_city_runtime(&home, "city-instance", "city.creator.playtest.claim", &json!({})).unwrap()["runId"], run_id);
        let cancelled = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.cancel", &json!({"runId":run_id})).unwrap();
        assert_eq!(cancelled["status"], "cancelled");
        assert_eq!(cancelled["cancelled"], true);
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.result", &json!({"runId":run_id})).unwrap()["status"], "cancelled");
        // 重复取消幂等：返回原终态，不再变更
        let again = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.cancel", &json!({"runId":run_id})).unwrap();
        assert_eq!(again, json!({"runId":run_id,"projectId":project_id,"revision":revision,"status":"cancelled","cancelled":false}));
        // 取消后活动槽位释放：可以启动新 run
        let second = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.start", &json!({"releaseId":release_id})).unwrap();
        assert_ne!(second["runId"], run_id);
        // 未知 runId
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.result", &json!({"runId":"playtest-missing"})).unwrap_err(), "creator_playtest_not_found");
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.cancel", &json!({"runId":"playtest-missing"})).unwrap_err(), "creator_playtest_not_found");
        let _ = std::fs::remove_dir_all(home);
    }

    // MCP P0（设计 §6.4）：场景摘要 + 能力发现 + 预览结构化差异。
    #[test]
    fn scene_describe_capabilities_and_preview_diff_are_bounded() {
        let home = home();
        publish_city_layout_snapshot(&home, &layout_snapshot()).unwrap();
        let created = create_project_from_city_layout(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-describe", "world-rev-test").unwrap();
        let project_id = created["projectId"].as_str().unwrap().to_owned();
        // 一个锚点对象让类别计数非零；预览结果必须带结构化差异
        let preview = preview_scene_operations(&home, "studio-instance", &project_id, 0, &json!([
            {"op":"anchor.upsert","object":{"id":"zone:gazebo","kind":"anchor","anchor":{"id":"zone:gazebo","kind":"zone","capabilities":["drive"],"geometryRef":"preview-node:z"},"transform":{"positionMeters":{"x":1.0,"y":0.0,"z":2.0},"rotationRadians":{"x":0.0,"y":0.0,"z":0.0},"scale":{"x":1.0,"y":1.0,"z":1.0}}}}
        ])).unwrap();
        assert_eq!(preview["changedObjects"][0]["id"], "zone:gazebo");
        assert_eq!(preview["changedObjects"][0]["kind"], "sceneObject");
        assert_eq!(preview["changedObjects"][0]["action"], "added");
        assert_eq!(preview["diagnostics"], json!([]));
        commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", &project_id, preview["previewId"].as_str().unwrap(), 0, "describe-anchor").unwrap();
        let described = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.scene.describe", &json!({"projectId":project_id})).unwrap();
        assert_eq!(described["objectCounts"]["anchor"], 1);
        assert_eq!(described["revision"], 1);
        assert_eq!(described["editableCategories"][0], "game");
        assert_eq!(described["cityLayout"]["seed"], 7);
        // 紧凑摘要不含完整文档：场景对象数组与规则 JSON 不得出现
        assert!(described.get("scene").is_none());
        assert!(described.get("game").is_none());
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.scene.describe",
            &json!({"projectId":project_id,"revision":0})).unwrap_err(), "revision_conflict");
        let selected = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.scene.describe",
            &json!({"projectId":project_id,"selectedObjectId":"zone:gazebo"})).unwrap();
        assert_eq!(selected["selected"]["id"], "zone:gazebo");
        assert!(selected["selected"]["transform"].is_object());
        let capabilities = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.capabilities.list", &json!({})).unwrap();
        assert_eq!(capabilities["schemaVersion"], 1);
        assert_eq!(capabilities["categories"]["scene"]["objectKinds"][0], "model");
        assert_eq!(capabilities["preview"]["singleUse"], true);
        // validate：诊断项结构（code/severity/source/objectId）与未运行项如实标注
        let validated = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.scene.validate", &json!({"projectId":project_id})).unwrap();
        assert_eq!(validated["ok"], true);
        for entry in validated["items"].as_array().unwrap() {
            assert!(entry.get("code").is_some() && entry.get("severity").is_some() && entry.get("source").is_some(),
                "validation item must carry code/severity/source: {entry}");
        }
        for entry in validated["unchecked"].as_array().unwrap() {
            assert!(entry.get("check").is_some() && entry.get("reason").is_some(), "unchecked entry must name the check: {entry}");
        }
        let filtered = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.capabilities.list", &json!({"category":"scene"})).unwrap();
        assert_eq!(filtered["category"], "scene");
        assert!(filtered["capabilities"].get("preview").is_some());
        assert!(filtered["supportedCategories"].as_array().unwrap().iter().any(|value| value == "game"));
        // 游戏预览同样带结构化差异
        let project = read_project(&home, &project_id).unwrap();
        let game_preview = preview_replace_game(&home, "studio-instance", &project_id, 1, &project["game"]).unwrap();
        assert_eq!(game_preview["changedObjects"][0]["kind"], "game");
        assert_eq!(game_preview["diagnostics"], json!([]));
        let _ = std::fs::remove_dir_all(home);
    }

    // MCP P1（设计 §6.4）：inspect 白名单字段与三种来源（场景对象/挂载/只读布局锚点）、
    // validate 的静态检查与如实未运行项、capabilities 的类别过滤。
    #[test]
    fn scene_inspect_validate_and_capabilities_cover_whitelisted_views() {
        let home = home();
        publish_city_layout_snapshot(&home, &layout_snapshot()).unwrap();
        let created = create_project_from_city_layout(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-inspect", "world-rev-test").unwrap();
        let project_id = created["projectId"].as_str().unwrap().to_owned();
        let preview = preview_scene_operations(&home, "studio-instance", &project_id, 0, &json!([
            {"op":"anchor.upsert","object":{"id":"zone:gazebo","kind":"anchor","transform":{"positionMeters":{"x":1.0,"y":0.0,"z":2.0},"rotationRadians":{"x":0.0,"y":0.0,"z":0.0},"scale":{"x":1.0,"y":1.0,"z":1.0}},
                "anchor":{"id":"zone:gazebo","kind":"zone","capabilities":["walk"],"geometryRef":"layout-ground:gazebo"}}}
        ])).unwrap();
        commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", &project_id, preview["previewId"].as_str().unwrap(), 0, "inspect-anchor").unwrap();
        let revision = read_project(&home, &project_id).unwrap()["revision"].as_u64().unwrap();
        // 场景对象：白名单字段 + 编辑通道
        let inspected = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.scene.inspect",
            &json!({"projectId":project_id,"revision":revision,"objectId":"zone:gazebo"})).unwrap();
        assert_eq!(inspected["object"]["kind"], "anchor");
        assert_eq!(inspected["object"]["editableVia"][0], "scene.object.upsert");
        assert_eq!(inspected["source"], "scene");
        // 挂载：先绑一个再检查
        let game_digest = digest(&canonical_json(&read_project(&home, &project_id).unwrap()["game"]).unwrap());
        let mount = json!({"schemaVersion":1,"mountId":"inspect-mount",
            "layout":{"kind":"city-layout","id":"city-layout-v1-test","version":"1","digest":"world-rev-test"},
            "game":{"kind":"city-minigame","id":read_project(&home, &project_id).unwrap()["game"]["id"],"version":"1","digest":game_digest},
            "entryAnchorId":"road-spawn:a","bindings":{"points":["road-checkpoint:ab","road-checkpoint:bc","road-checkpoint:cd"]},"parameterOverrides":{"timeLimitTicks":2400}});
        let mount_preview = preview_scene_operations(&home, "studio-instance", &project_id, 1, &json!([{"op":"mount.bind","mount":mount}])).unwrap();
        commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", &project_id, mount_preview["previewId"].as_str().unwrap(), 1, "inspect-mount").unwrap();
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.scene.inspect",
            &json!({"projectId":project_id,"revision":2,"objectId":"inspect-mount"})).unwrap()["object"]["kind"], "mount");
        // 只读布局锚点：不可编辑
        let layout_anchor = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.scene.inspect",
            &json!({"projectId":project_id,"revision":2,"objectId":"road-spawn:a"})).unwrap();
        assert_eq!(layout_anchor["source"], "cityLayout");
        assert_eq!(layout_anchor["object"]["editable"], false);
        // 未知名与 revision 漂移
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.scene.inspect",
            &json!({"projectId":project_id,"revision":2,"objectId":"zone:missing"})).unwrap_err(), "creator_object_not_found");
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.scene.inspect",
            &json!({"projectId":project_id,"revision":99,"objectId":"zone:gazebo"})).unwrap_err(), "revision_conflict");
        // validate：干净项目 ok + 运行时检查如实未运行
        let validated = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.scene.validate", &json!({"projectId":project_id})).unwrap();
        assert_eq!(validated["ok"], true);
        assert!(validated["unchecked"].as_array().unwrap().iter().any(|entry| entry["check"] == "drive_reachability"));
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.scene.validate",
            &json!({"projectId":project_id,"validationProfile":"runtime"})).unwrap_err(), "creator_validation_profile_unsupported");
        // capabilities：类别过滤与未知类别
        let filtered = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.capabilities.list", &json!({"category":"scene"})).unwrap();
        assert_eq!(filtered["category"], "scene");
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.capabilities.list",
            &json!({"category":"physics-sim"})).unwrap_err(), "creator_capability_unknown");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn playtest_handoff_is_release_pinned_city_bound_and_returns_once() {
        let home = home();
        let (project_id, revision) = publishable_project(&home);
        let published = publish_project_release(&home, &project_id, revision).unwrap();
        let release_id = published["releaseId"].as_str().unwrap();
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.return_context", &json!({})).unwrap(), Value::Null);
        let start = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.start", &json!({"releaseId":release_id})).unwrap();
        assert_eq!(start["status"], "pending");
        let run_id = start["runId"].as_str().unwrap().to_owned();
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", "creator.project.playtest.start", &json!({"releaseId":release_id})).unwrap(), start);
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-instance-2", "creator.project.playtest.start", &json!({"releaseId":release_id})).unwrap_err(), "creator_playtest_active");

        let claimed = dispatch_city_runtime(&home, "city-instance", "city.creator.playtest.claim", &json!({})).unwrap();
        assert_eq!(claimed["runId"], run_id);
        assert_eq!(claimed["releaseId"], release_id);
        assert_eq!(claimed["projectId"], project_id);
        assert_eq!(claimed["revision"], revision);
        assert_eq!(claimed["skinId"], "miami-vice");
        assert_eq!(claimed["game"]["id"], "creator.checkpoint-race");
        assert_eq!(claimed["mounts"][0]["mountId"], "release-mount");
        let snapshot_digest = claimed["snapshotDigest"].as_str().unwrap().to_owned();
        assert_eq!(snapshot_digest.len(), 71);
        assert_eq!(claimed["returnContext"], json!({"projectId":project_id,"revision":revision}));
        let game_ref = claimed["mounts"][0]["game"].clone();
        let evidence = json!({"schemaVersion":1,"runtimeVersion":"city-mini-game-runtime-v1","releaseId":release_id,
            "projectRevision":revision,"snapshotDigest":snapshot_digest,"worldRevision":"world-rev-test","seed":7,"game":{"id":game_ref["id"],"version":game_ref["version"],"digest":game_ref["digest"]},
            "tick":812,"counters":{"next":3},"outcome":"success","reasonCode":null});
        assert_eq!(dispatch_city_runtime(&home, "another-city", "city.creator.playtest.claim", &json!({})).unwrap_err(), "creator_playtest_claimed");
        assert_eq!(dispatch_city_runtime(&home, "another-city", "city.creator.playtest.finish", &json!({"runId":run_id,"status":"completed","evidence":evidence})).unwrap_err(), "creator_playtest_instance_mismatch");

        let mut mismatched = evidence.clone(); mismatched["worldRevision"] = json!("world-rev-other");
        assert_eq!(dispatch_city_runtime(&home, "city-instance", "city.creator.playtest.finish", &json!({"runId":run_id,"status":"completed","evidence":mismatched})).unwrap_err(), "creator_playtest_evidence_invalid");
        let mut wrong_outcome = evidence.clone(); wrong_outcome["outcome"] = json!("failure");
        assert_eq!(dispatch_city_runtime(&home, "city-instance", "city.creator.playtest.finish", &json!({"runId":run_id,"status":"completed","evidence":wrong_outcome})).unwrap_err(), "creator_playtest_evidence_mismatch");
        assert_eq!(dispatch_city_runtime(&home, "city-instance", "city.creator.playtest.finish", &json!({"runId":run_id,"status":"completed","evidence":null})).unwrap_err(), "creator_playtest_evidence_required");
        let finished = dispatch_city_runtime(&home, "city-instance", "city.creator.playtest.finish", &json!({"runId":run_id,"status":"completed","evidence":evidence})).unwrap();
        assert_eq!(finished["status"], "completed");
        assert_eq!(dispatch_city_runtime(&home, "city-instance", "city.creator.playtest.finish", &json!({"runId":run_id,"status":"completed","evidence":evidence})).unwrap(), finished);
        assert_eq!(dispatch_city_runtime(&home, "city-instance", "city.creator.playtest.finish", &json!({"runId":run_id,"status":"failed","evidence":null})).unwrap_err(), "creator_playtest_terminal");
        let returned = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-resumed", "creator.project.playtest.return_context", &json!({})).unwrap();
        assert_eq!(returned, json!({"runId":run_id,"projectId":project_id,"revision":revision,"status":"completed","evidence":evidence,"failureCode":null}));
        assert_eq!(dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-resumed", "creator.project.playtest.return_context", &json!({})).unwrap(), Value::Null);
        let history = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-resumed", "creator.project.playtest.history", &json!({"projectId":project_id,"limit":8})).unwrap();
        assert_eq!(history["runs"].as_array().unwrap().len(), 1);
        assert_eq!(history["runs"][0]["evidenceSource"], "city-client-reported");
        assert_eq!(history["runs"][0]["evidence"], evidence);
        let retry = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-retry", "creator.project.playtest.start", &json!({"releaseId":release_id})).unwrap();
        let retry_id = retry["runId"].as_str().unwrap();
        dispatch_city_runtime(&home, "city-retry", "city.creator.playtest.claim", &json!({})).unwrap();
        assert_eq!(dispatch_city_runtime(&home, "city-retry", "city.creator.playtest.finish", &json!({
            "runId":retry_id,"status":"failed","evidence":null,"failureCode":"creator_entry_spawn_unavailable"
        })).unwrap()["failureCode"], "creator_entry_spawn_unavailable");
        let failed = dispatch_as(&home, LOCAL_CREATOR_OWNER, "studio-retry-resumed", "creator.project.playtest.return_context", &json!({})).unwrap();
        assert_eq!(failed["failureCode"], "creator_entry_spawn_unavailable");
        assert_eq!(dispatch_city_runtime(&home, "city-retry", "city.creator.playtest.finish", &json!({
            "runId":retry_id,"status":"failed","evidence":null,"failureCode":"has spaces"
        })).unwrap_err(), "creator_request_invalid");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn project_preview_commit_revision_and_idempotency() {
        let home = home();
        let created = create_project(&home, "instance-test", "checkpoint-race", "create-1").unwrap();
        assert_eq!(create_project(&home, "instance-test", "checkpoint-race", "create-1").unwrap(), created);
        assert_eq!(create_project(&home, "instance-test", "collect-one", "create-1").unwrap_err(), "operation_id_conflict");
        let project = created["projectId"].as_str().unwrap();
        assert_eq!(operation_status(&home, "instance-test", project, "missing").unwrap()["status"], "not_found");
        let mut game = read_project(&home, project).unwrap()["game"].clone();
        game["rules"]["counters"]["next"]["max"] = json!(4);
        let preview = preview_replace_game(&home, "instance-test", project, 0, &game).unwrap();
        let preview_id = preview["previewId"].as_str().unwrap();
        assert_eq!(commit_preview(&home, "other-instance", project, preview_id, 0, "edit-1").unwrap_err(), "permission_denied");
        let committed = commit_preview(&home, "instance-test", project, preview_id, 0, "edit-1").unwrap();
        assert_eq!(committed["revision"], 1);
        assert_eq!(read_project(&home, project).unwrap()["revision"], 1);
        assert_eq!(operation_status(&home, "instance-test", project, "edit-1").unwrap()["status"], "committed");
        assert_eq!(commit_preview(&home, "instance-test", project, preview_id, 0, "edit-1").unwrap(), committed);
        assert_eq!(commit_preview(&home, "instance-test", project, preview_id, 0, "edit-other").unwrap_err(), "preview_expired");
        let bad_game = json!({"schemaVersion":1,"id":"x","rulesVersion":1,"slots":{},"rules":{"counters":{},"nodes":[]},"script":"bad"});
        assert_eq!(validate_game(&bad_game).unwrap_err(), "creator_game_invalid");
        let unsupported_game = json!({"schemaVersion":1,"id":"x","rulesVersion":1,"slots":{},"rules":{"counters":{},"nodes":[{"id":"x","on":{"type":"run.started"},"actions":[{"op":"host.call","method":"readFile"}]}]}});
        assert_eq!(validate_game(&unsupported_game).unwrap_err(), "creator_game_operation_unsupported");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn creator_templates_only_require_city_runtime_supported_gameplay() {
        let collect = game_template("collect-one").unwrap();
        validate_game(&collect).unwrap();
        assert_eq!(collect["slots"]["targets"]["requires"], json!(["drive"]));
        assert_eq!(collect["rules"]["nodes"][0]["on"]["type"], "zone.entered");
        assert_eq!(collect["rules"]["nodes"][1]["actions"][0]["outcome"], "success");
        assert_eq!(game_template("unsupported-walk").unwrap_err(), "creator_template_not_found");
    }

    #[test]
    fn committed_operation_survives_studio_instance_replacement_but_preview_does_not() {
        let home = home();
        let created = create_project(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-stable").unwrap();
        let project = created["projectId"].as_str().unwrap();
        let mut game = read_project(&home, project).unwrap()["game"].clone();
        game["rules"]["counters"]["next"]["max"] = json!(4);
        let preview = preview_replace_game(&home, "studio-instance-1", project, 0, &game).unwrap();
        let preview_id = preview["previewId"].as_str().unwrap();

        assert_eq!(commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance-2", project, preview_id, 0, "edit-stable").unwrap_err(), "permission_denied");
        let committed = commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance-1", project, preview_id, 0, "edit-stable").unwrap();

        assert_eq!(operation_status(&home, LOCAL_CREATOR_OWNER, project, "edit-stable").unwrap()["result"], committed);
        assert_eq!(commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance-2", project, preview_id, 0, "edit-stable").unwrap(), committed);
        assert_eq!(read_project(&home, project).unwrap()["revision"], 1);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn mount_skin_operations_preview_commit_and_enforce_game_bindings() {
        let home = home();
        publish_city_layout_snapshot(&home, &layout_snapshot()).unwrap();
        let created = create_project_from_city_layout(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-mount", "world-rev-test").unwrap();
        let project = created["projectId"].as_str().unwrap();
        let game_id = read_project(&home, project).unwrap()["game"]["id"].as_str().unwrap().to_owned();
        let mount = json!({
            "schemaVersion":1,"mountId":"starter-mount",
            "layout":{"kind":"city-layout","id":"city-layout-v1-test","version":"1","digest":"world-rev-test"},
            "game":{"kind":"city-minigame","id":game_id,"version":"1","digest":"fixture"},
            "entryAnchorId":"road-spawn:a","bindings":{"points":["road-checkpoint:ab","road-checkpoint:bc","road-checkpoint:cd"]},"parameterOverrides":{"timeLimitTicks":2400}
        });
        let operations = json!([
            {"op":"mount.bind","mount":mount},
            {"op":"skin.select","skinId":"desert-evening"}
        ]);
        let preview = preview_scene_operations(&home, "studio-instance", project, 0, &operations).unwrap();
        let committed = commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", project,
            preview["previewId"].as_str().unwrap(), 0, "bind-and-skin").unwrap();
        let saved = read_project(&home, project).unwrap();
        assert_eq!(committed["revision"], 1);
        assert_eq!(saved["mounts"][0]["mountId"], "starter-mount");
        assert_eq!(saved["skinId"], "desert-evening");

        let remove = preview_scene_operations(&home, "studio-instance", project, 1,
            &json!([{"op":"mount.remove","mountId":"starter-mount"}])).unwrap();
        commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", project,
            remove["previewId"].as_str().unwrap(), 1, "remove-mount").unwrap();
        assert!(read_project(&home, project).unwrap()["mounts"].as_array().unwrap().is_empty());

        let invalid = json!([{"op":"mount.bind","mount":{
            "schemaVersion":1,"mountId":"bad-mount",
            "layout":{"kind":"city-layout","id":"city-layout-v1-test","version":"1","digest":"world-rev-test"},
            "game":{"kind":"city-minigame","id":game_id,"version":"1","digest":"fixture"},
            "entryAnchorId":"road-spawn:a","bindings":{"missing-slot":["road-checkpoint:ab"]},"parameterOverrides":{}
        }}]);
        assert_eq!(preview_scene_operations(&home, "studio-instance", project, 2, &invalid).unwrap_err(), "creator_mount_slot_not_found");
        assert_eq!(apply_scene_operations(&mut read_project(&home, project).unwrap(), &json!([{"op":"skin.select","skinId":"untrusted"}] )).unwrap_err(), "creator_skin_not_found");
        let _ = std::fs::remove_dir_all(home);
    }

    // ── 城市补丁（切片 2）──

    fn sample_patch(seed: u64) -> Value {
        json!({"version":1,"seed":seed,"scaleTier":1,"generatorVersion":6,"updatedAt":1000,
            "roadOps":[
                {"t":"add","from":{"x":1.5,"z":2.5},"to":{"x":3.5,"z":2.5},"width":8},
                {"t":"drop","edge":"road-edge:ab:0","anchor":{"x":2.0,"z":2.5}}
            ],
            "siteOps":[{"t":"move","id":"context:p1","to":"parcel-9","at":{"x":1.0,"z":1.0},"cls":"context/"}],
            "buildingMoves":{"session-1":"parcel-2"},
            "moveAnchors":{"session-1":{"x":5.0,"z":6.0}},
            "suppressedContext":["context:parcel-3"]})
    }

    #[test]
    fn city_patch_publish_is_idempotent_and_validates_structure() {
        let home = home();
        let patch = sample_patch(7);
        let first = publish_city_patch(&home, &json!({"seed":7,"patch":patch.clone()})).unwrap();
        let second = publish_city_patch(&home, &json!({"seed":7,"patch":patch})).unwrap();
        assert_eq!(first["digest"], second["digest"]);
        let mismatched = sample_patch(8);
        assert_eq!(publish_city_patch(&home, &json!({"seed":7,"patch":mismatched})).unwrap_err(), "creator_city_patch_seed_mismatch");
        assert_eq!(publish_city_patch(&home, &json!({"seed":7,"patch":json!({"version":1,"seed":7,"scaleTier":1,"updatedAt":1,
            "roadOps":[{"t":"teleport"}],"siteOps":[],"buildingMoves":{},"suppressedContext":[]})})).unwrap_err(), "creator_city_patch_invalid");
        assert_eq!(publish_city_patch(&home, &json!({"seed":7,"patch":json!({"version":1,"seed":7,"scaleTier":1,"updatedAt":1,
            "roadOps":[{"t":"add","from":{"x":0.0,"z":0.0},"to":{"x":1.0,"z":0.0},"width":80}],"siteOps":[],"buildingMoves":{},"suppressedContext":[]})})).unwrap_err(), "creator_city_patch_invalid");
        let mut moves = serde_json::Map::new();
        for index in 0..=MAX_CITY_PATCH_OPS { moves.insert(format!("session-{index}"), json!("parcel-1")); }
        let mut over_budget = sample_patch(7);
        over_budget["buildingMoves"] = Value::Object(moves);
        assert_eq!(publish_city_patch(&home, &json!({"seed":7,"patch":over_budget})).unwrap_err(), "creator_city_patch_invalid");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn project_creation_imports_published_patch_and_upsert_enforces_seed() {
        let home = home();
        publish_city_layout_snapshot(&home, &layout_snapshot()).unwrap();
        publish_city_patch(&home, &json!({"seed":7,"patch":sample_patch(7)})).unwrap();
        let created = create_project_from_city_layout(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-import", "world-rev-test").unwrap();
        let project_id = created["projectId"].as_str().unwrap();
        let project = read_project(&home, project_id).unwrap();
        assert_eq!(project["cityPatch"]["buildingMoves"]["session-1"], "parcel-2");
        assert_eq!(project["cityPatchImport"]["source"], "city-publish");
        // 创建幂等：同一 operationId 重试返回同一项目，不产生重复导入。
        let retry = create_project_from_city_layout(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-import", "world-rev-test").unwrap();
        assert_eq!(retry["projectId"], created["projectId"]);

        let upsert = preview_scene_operations(&home, "studio-instance", project_id, 0, &json!([{"op":"city.patch.upsert","patch":sample_patch(7)}])).unwrap();
        let saved = commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", project_id, upsert["previewId"].as_str().unwrap(), 0, "patch-upsert-1").unwrap();
        assert_eq!(saved["revision"], 1);
        let after_upsert = read_project(&home, project_id).unwrap();
        assert_eq!(after_upsert["cityPatch"]["updatedAt"], 1000);
        assert!(after_upsert["cityPatchImport"].is_null());
        assert_eq!(preview_scene_operations(&home, "studio-instance", project_id, 1,
            &json!([{"op":"city.patch.upsert","patch":sample_patch(8)}])).unwrap_err(), "creator_city_patch_seed_mismatch");
        let bare = create_project(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-bare").unwrap();
        assert_eq!(preview_scene_operations(&home, "studio-instance", bare["projectId"].as_str().unwrap(), 0,
            &json!([{"op":"city.patch.upsert","patch":sample_patch(7)}])).unwrap_err(), "creator_city_patch_requires_city_layout");
        let remove = preview_scene_operations(&home, "studio-instance", project_id, 1, &json!([{"op":"city.patch.remove"}])).unwrap();
        commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", project_id, remove["previewId"].as_str().unwrap(), 1, "patch-remove").unwrap();
        assert!(read_project(&home, project_id).unwrap()["cityPatch"].is_null());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn city_patch_read_reports_newest_bound_project() {
        let home = home();
        assert_eq!(read_city_patch_for_seed(&home, 7).unwrap(), json!({"projectId":null,"revision":null,"patch":null}));
        publish_city_layout_snapshot(&home, &layout_snapshot()).unwrap();
        publish_city_patch(&home, &json!({"seed":7,"patch":sample_patch(7)})).unwrap();
        let created = create_project_from_city_layout(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-read", "world-rev-test").unwrap();
        let found = read_city_patch_for_seed(&home, 7).unwrap();
        assert_eq!(found["projectId"], created["projectId"]);
        assert_eq!(found["patch"]["seed"], 7);
        assert!(read_city_patch_for_seed(&home, 9).unwrap()["projectId"].is_null());
        let _ = std::fs::remove_dir_all(home);
    }

    // 事务中途失败（写入阶段约束冲突）不得消费预览凭据：同一 previewId 与
    // operationId 必须能重试成功；成功后再重试命中幂等记录返回同一结果。
    #[test]
    fn failed_commit_keeps_preview_available_for_retry() {
        let home = home();
        publish_city_layout_snapshot(&home, &layout_snapshot()).unwrap();
        let created = create_project_from_city_layout(&home, LOCAL_CREATOR_OWNER, "checkpoint-race", "create-retry", "world-rev-test").unwrap();
        let project_id = created["projectId"].as_str().unwrap().to_owned();
        // 预置一条 change 行挡住 revision 1 的提交写入，制造事务中途失败。
        {
            let db = database(&home).unwrap();
            db.execute("INSERT INTO creator_changes(project_id,revision,actor_id,operation_id,operation_hash,document_json,created_at_ms) VALUES(?1,1,'blocker','block','block','{}',0)", params![project_id]).unwrap();
        }
        let preview = preview_scene_operations(&home, "studio-instance", &project_id, 0, &json!([{"op":"skin.select","skinId":"desert-evening"}])).unwrap();
        let preview_id = preview["previewId"].as_str().unwrap().to_owned();
        assert_eq!(commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", &project_id, &preview_id, 0, "retry-op").unwrap_err(), "creator_store_unavailable");
        {
            let db = database(&home).unwrap();
            db.execute("DELETE FROM creator_changes WHERE project_id=?1 AND revision=1", params![project_id]).unwrap();
        }
        let saved = commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", &project_id, &preview_id, 0, "retry-op").unwrap();
        assert_eq!(saved["revision"], 1);
        let again = commit_preview_as(&home, LOCAL_CREATOR_OWNER, "studio-instance", &project_id, &preview_id, 0, "retry-op").unwrap();
        assert_eq!(again, saved);
        let _ = std::fs::remove_dir_all(home);
    }
}
