//! 通用插件本地状态端口（CITY_GAME_MODE_IMPLEMENTATION_PLAN §9）：
//! 有界 JSON 文档存储于应用私有数据目录 `state/plugins/<plugin_id>/state/<key>.json`，
//! 路径由宿主生成（插件只传 key）；单文档 ≤ 32 KiB（读与写同限）；读写携带 revision
//! 做乐观并发检查——「读版本→校验→临时文件→原子替换」在进程级互斥锁下串行执行，
//! 同 key 并发请求不会同时通过同一 revision 检查，也不会互踩临时文件；
//! 损坏文件读取报错、写入前保留可恢复副本。
//! 常规状态和机甲回合检查点使用有界 JSON/CAS；已保存回放走通用对象/scope API。
//! 旧 SQLite 回放与检查点只保留只读 copy-forward 入口。
//! 本模块不实现游戏规则，也不进 authority DB。
use serde_json::Value;
use std::sync::MutexGuard;

// v1.5 replay bundles cap at 40_000 bytes; leave room for the state envelope.
const MAX_DOCUMENT_BYTES: usize = 48 * 1024;

/// 全部状态操作的串行化锁（设置/档案写入低频，粗粒度互斥即可保证提交原子性）。
fn state_lock() -> MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// key 形如 `flight-profile:v1`（小写字母/数字/连字符 + 冒号 + v + 数字）。
fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64 && key.split(':').count() == 2 && {
        let mut parts = key.split(':');
        let name = parts.next().unwrap_or("");
        let version = parts.next().unwrap_or("");
        !name.is_empty() && name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            && version.len() >= 2 && version.starts_with('v') && version[1..].bytes().all(|c| c.is_ascii_digit())
    }
}

fn state_path(data_home: &std::path::Path, plugin_id: &str, key: &str) -> std::path::PathBuf {
    let safe_key = key.replace(':', "-");
    data_home.join(format!("state/plugins/{plugin_id}/state/{safe_key}.json"))
}

/// 有界读取：`take(MAX+1)` 截断读取流——超大/损坏文件的内存分配封顶在
/// 32 KiB + 1 字节，超限即判损坏，不整读进内存后再检查。
fn load(path: &std::path::Path) -> Result<Option<(u64, Value)>, &'static str> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("state_unavailable"),
    };
    let mut bytes = Vec::new();
    let mut bounded = file.take(MAX_DOCUMENT_BYTES as u64 + 1);
    bounded.read_to_end(&mut bytes).map_err(|_| "state_unavailable")?;
    if bytes.len() > MAX_DOCUMENT_BYTES { return Err("state_unavailable"); }
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| "state_unavailable")?;
    let revision = parsed["revision"].as_u64().ok_or("state_unavailable")?;
    let value = parsed.get("value").cloned().unwrap_or(Value::Null);
    Ok(Some((revision, value)))
}

/// 通用端口入口：read → {value, revision}；write → {revision}（成功后的新版本）。
/// 串行化保证 check-and-commit 原子（乐观并发的前提）。
pub fn handle(allowed_keys: &[String], data_home: &std::path::Path, plugin_id: &str, method: &str, payload: &Value) -> Result<Value, &'static str> {
    let _serialized = state_lock();
    if payload["key"].as_str() == Some("mecha-replays:v1") {
        if !allowed_keys.iter().any(|key| key == "mecha-replays:v1") { return Err("state_key_denied"); }
        return mecha_replays(data_home, method, payload);
    }
    match method {
        "plugin.state.read" => read(allowed_keys, data_home, plugin_id, payload),
        "plugin.state.write" => write(allowed_keys, data_home, plugin_id, payload),
        _ => Err("method_unavailable"),
    }
}

/// Read-only copy-forward access to archives written by the retired SQLite route.
/// New replay records are stored through the descriptor-scoped generic object API.
fn mecha_replays(home: &std::path::Path, method: &str, payload: &Value) -> Result<Value, &'static str> {
    if payload["format"].as_str() == Some("sequential-checkpoint-v1") {
        return legacy_checkpoint_read(home, method, payload);
    }
    if payload.get("format").and_then(Value::as_str) != Some("sequential-v1") {
        return Err("invalid_state_value");
    }
    let op = payload["op"].as_str().ok_or("invalid_state_value")?;
    if !matches!((method, op), ("plugin.state.read", "list")) {
        return Err("method_unavailable");
    }
    legacy_replay_list(home)
}

fn legacy_replay_list(home: &std::path::Path) -> Result<Value, &'static str> {
    use rusqlite::{Connection, OpenFlags, OptionalExtension};
    let path = home.join("state/plugins/city-assets/mecha-sequential-replays.sqlite");
    if !path.exists() { return Ok(serde_json::json!({"entries": []})); }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| "state_unavailable")?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_| "state_unavailable")?;
    let table_exists: Option<i64> = db.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='replay_entries'", [], |row| row.get(0))
        .optional().map_err(|_| "state_unavailable")?;
    if table_exists.is_none() { return Ok(serde_json::json!({"entries": []})); }
    let mut stmt = db.prepare("SELECT id, record FROM replay_entries ORDER BY id").map_err(|_| "state_unavailable")?;
    let rows = stmt.query_map([], |row| Ok(serde_json::json!({"key": row.get::<_,String>(0)?, "raw": row.get::<_,String>(1)?})))
        .map_err(|_| "state_unavailable")?;
    let entries = rows.collect::<Result<Vec<_>,_>>().map_err(|_| "state_unavailable")?;
    Ok(serde_json::json!({"entries": entries}))
}

/// Read-only copy-forward access to the former single-slot checkpoint.
fn legacy_checkpoint_read(home: &std::path::Path, method: &str, payload: &Value) -> Result<Value, &'static str> {
    use rusqlite::{Connection, OpenFlags, OptionalExtension};
    if method != "plugin.state.read" || payload["op"] != "read"
        || !payload.as_object().is_some_and(|map| map.len() == 3
            && ["key", "format", "op"].iter().all(|key| map.contains_key(*key))) {
        return Err("method_unavailable");
    }
    let path = home.join("state/plugins/city-assets/mecha-sequential-checkpoint.sqlite");
    if !path.exists() { return Ok(serde_json::json!({"revision":0,"raw":null})); }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| "state_unavailable")?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_| "state_unavailable")?;
    let table_exists: Option<i64> = db.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoint'", [], |row| row.get(0))
        .optional().map_err(|_| "state_unavailable")?;
    if table_exists.is_none() { return Ok(serde_json::json!({"revision":0,"raw":null})); }
    let current: Option<(u64, Option<String>)> = db.query_row(
        "SELECT revision, record FROM checkpoint WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional().map_err(|_| "state_unavailable")?;
    let (revision, raw) = current.unwrap_or((0, None));
    Ok(serde_json::json!({"revision":revision,"raw":raw}))
}

/// Validate only the bounded, anonymized v1.5 archive schema. Rule execution and
/// digest verification remain in the versioned game interpreter at restore time.
#[cfg(test)]
fn valid_sequential_replay_record(raw: &str) -> bool {
    fn exact(v: &Value, keys: &[&str]) -> bool {
        v.as_object().is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k)))
    }
    fn hash(v: &Value) -> bool {
        v.as_str().is_some_and(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
    }
    fn unit(v: &Value) -> bool { v.as_str().is_some_and(|s| ["Assault", "Gunner", "Support"].contains(&s)) }
    fn cell(v: &Value) -> bool {
        exact(v, &["x", "y"]) && v["x"].as_u64().is_some_and(|x| x < 10) && v["y"].as_u64().is_some_and(|y| y < 10)
    }
    if raw.len() > 41_024 { return false; }
    let Ok(record) = serde_json::from_str::<Value>(raw) else { return false; };
    if !exact(&record, &["schema", "savedAt", "archive"]) || record["schema"] != "mecha-sequential-replay-entry:v1"
        || !record["savedAt"].as_str().is_some_and(|s| s.len() == 24 && s.bytes().all(|c| c.is_ascii_digit() || b"-:.TZ".contains(&c))) { return false; }
    let Some(raw_archive) = record["archive"].as_str().filter(|s| s.len() <= 40_000) else { return false; };
    let Ok(a) = serde_json::from_str::<Value>(raw_archive) else { return false; };
    let status = match a["schema"].as_str() {
        Some("mecha-sequential-bundle:v1") => false,
        Some("mecha-sequential-bundle:v2") => true,
        _ => return false,
    };
    if !exact(&a, &["schema", "ruleset", "siteDigest", "opening", "replay"])
        || a["ruleset"] != "mecha-v1.5" || !hash(&a["siteDigest"]) { return false; }
    let opening = &a["opening"];
    if !exact(opening, if status { &["preset", "script", "placements", "encounter"] } else { &["preset", "script", "placements"] })
        || opening["preset"] != "covers_sparse_mid" || opening["script"] != "siege" { return false; }
    if status {
        let encounter = &opening["encounter"];
        if !exact(encounter, &["speciesId", "contentVersion", "statusRules"]) || encounter["contentVersion"] != 1
            || encounter["statusRules"] != "mecha-status-encounter:v1"
            || !encounter["speciesId"].as_str().is_some_and(|s| ["spore_leaper", "flux_lancer", "prism_warden", "gravity_core"].contains(&s)) { return false; }
    }
    let Some(placements) = opening["placements"].as_array().filter(|p| p.len() == 3) else { return false; };
    let mut seen_units = std::collections::HashSet::new();
    let mut seen_cells = std::collections::HashSet::new();
    for p in placements {
        if !exact(p, &["mechId", "pos"]) || !unit(&p["mechId"]) || !cell(&p["pos"]) { return false; }
        if !seen_units.insert(p["mechId"].as_str().unwrap()) || !seen_cells.insert((p["pos"]["x"].as_u64().unwrap(), p["pos"]["y"].as_u64().unwrap())) { return false; }
    }
    let replay = &a["replay"];
    let has_policy = replay.get("enemyPolicy").is_some();
    let fields: &[&str] = match (status, has_policy) {
        (true, true) => &["schema", "ruleset", "enemyPolicy", "initialDigest", "finalDigest", "entries", "statusRules"],
        (true, false) => &["schema", "ruleset", "initialDigest", "finalDigest", "entries", "statusRules"],
        (false, true) => &["schema", "ruleset", "enemyPolicy", "initialDigest", "finalDigest", "entries"],
        (false, false) => &["schema", "ruleset", "initialDigest", "finalDigest", "entries"],
    };
    if !exact(replay, fields) || (has_policy && !matches!(replay["enemyPolicy"].as_str(), Some("scripted" | "baup")))
        || replay["schema"] != if status { "mecha-sequential-replay:v2" } else { "mecha-sequential-replay:v1" }
        || (status && replay["statusRules"] != "mecha-status-encounter:v1")
        || replay["ruleset"] != "mecha-v1.5" || !hash(&replay["initialDigest"]) || !hash(&replay["finalDigest"]) { return false; }
    let Some(entries) = replay["entries"].as_array().filter(|entries| entries.len() <= 512) else { return false; };
    for (index, entry) in entries.iter().enumerate() {
        if !exact(entry, &["command", "eventDigest"]) || !hash(&entry["eventDigest"]) { return false; }
        let command = &entry["command"];
        if command["id"].as_str() != Some(format!("c{index}").as_str()) || command["revision"].as_u64() != Some(index as u64 + 1) { return false; }
        match command["kind"].as_str() {
            Some("move") if exact(command, &["kind", "id", "revision", "mech", "to"]) && unit(&command["mech"]) && cell(&command["to"]) => (),
            Some("undo" | "reset") if exact(command, &["kind", "id", "revision"]) => (),
            Some("end") if exact(command, &["kind", "id", "revision", "confirmUnused"]) && command["confirmUnused"].is_boolean() => (),
            Some("act") if exact(command, &["kind", "id", "revision", "mech", "action"]) && unit(&command["mech"]) => {
                let action = &command["action"];
                let target = action.get("target");
                match action["kind"].as_str() {
                    Some("skip") if exact(action, &["kind"]) => (),
                    Some("repair") if exact(action, &["kind", "target"]) && target.is_some_and(unit) => (),
                    Some("melee" | "charge" | "shoot" | "pierce") if exact(action, if target.is_some() { &["kind", "target"] } else { &["kind"] })
                        && target.is_none_or(|value| value.as_str().is_some_and(|s| s == "boss" || s.strip_prefix('r').is_some_and(|n|
                            !n.is_empty() && n.len() <= 4 && (n == "0" || !n.starts_with('0')) && n.bytes().all(|b| b.is_ascii_digit())
                            && n.parse::<u16>().is_ok_and(|i| i <= 1023)))) => (),
                    _ => return false,
                }
            },
            _ => return false,
        }
    }
    true
}

fn read(allowed_keys: &[String], data_home: &std::path::Path, plugin_id: &str, payload: &Value) -> Result<Value, &'static str> {
    let key = payload["key"].as_str().ok_or("invalid_state_key")?;
    if !valid_key(key) || !allowed_keys.iter().any(|allowed| allowed == key) { return Err("state_key_denied"); }
    match load(&state_path(data_home, plugin_id, key)) {
        Ok(Some((revision, value))) => Ok(serde_json::json!({"value": value, "revision": revision})),
        Ok(None) => Ok(serde_json::json!({"value": Value::Null, "revision": 0})),
        Err(code) => Err(code),
    }
}

fn write(allowed_keys: &[String], data_home: &std::path::Path, plugin_id: &str, payload: &Value) -> Result<Value, &'static str> {
    let key = payload["key"].as_str().ok_or("invalid_state_key")?;
    if !valid_key(key) || !allowed_keys.iter().any(|allowed| allowed == key) { return Err("state_key_denied"); }
    let value = payload["value"].as_object().ok_or("invalid_state_value")?;
    let revision = payload["revision"].as_u64().ok_or("revision_required")?;
    let path = state_path(data_home, plugin_id, key);
    let existing = load(&path);
    let current = match &existing {
        Ok(Some((seen, _))) => *seen,
        Ok(None) => 0,
        Err(_) => {
            // 损坏：保留可恢复副本后再启用空档案（不静默覆盖，§9）。
            let backup = path.with_extension(format!("corrupt-{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()));
            let _ = std::fs::rename(&path, &backup);
            0
        }
    };
    if current != revision { return Err("revision_conflict"); }
    let document = serde_json::json!({"revision": revision + 1, "value": value});
    let bytes = serde_json::to_vec(&document).map_err(|_| "state_unavailable")?;
    if bytes.len() > MAX_DOCUMENT_BYTES { return Err("state_too_large"); }
    std::fs::create_dir_all(path.parent().expect("state dir")).map_err(|_| "state_unavailable")?;
    // 纳秒后缀的独立临时文件：并发/重入写不会共用同一路径互踩（锁已串行化，双保险）。
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temp = path.with_extension(format!("tmp-{nanos}"));
    std::fs::write(&temp, &bytes).map_err(|_| "state_unavailable")?;
    std::fs::rename(&temp, &path).map_err(|_| "state_unavailable")?;
    Ok(serde_json::json!({"revision": revision + 1}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_home() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("plugin-state-{}-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sequential_replay_legacy_store_is_read_only() {
        let home = temp_home();
        let allowed = vec!["mecha-replays:v1".to_string()];
        let digest = "a".repeat(64);
        let commands = [
            json!({"kind":"move","id":"c0","revision":1,"mech":"Assault","to":{"x":0,"y":7}}),
            json!({"kind":"undo","id":"c1","revision":2}),
            json!({"kind":"act","id":"c2","revision":3,"mech":"Gunner","action":{"kind":"shoot","target":"r0"}}),
            json!({"kind":"reset","id":"c3","revision":4}),
            json!({"kind":"end","id":"c4","revision":5,"confirmUnused":true}),
        ];
        let archive = json!({"schema":"mecha-sequential-bundle:v1", "ruleset":"mecha-v1.5", "siteDigest":digest,
            "opening":{"preset":"covers_sparse_mid", "script":"siege", "placements":[
                {"mechId":"Assault","pos":{"x":0,"y":8}}, {"mechId":"Gunner","pos":{"x":3,"y":8}}, {"mechId":"Support","pos":{"x":6,"y":8}}]},
            "replay":{"schema":"mecha-sequential-replay:v1", "ruleset":"mecha-v1.5", "initialDigest":digest, "finalDigest":digest,
                "entries":commands.iter().map(|c| json!({"command":c,"eventDigest":digest})).collect::<Vec<_>>()}});
        let record = |archive: &Value| json!({"schema":"mecha-sequential-replay-entry:v1", "savedAt":"2026-11-06T12:00:00.000Z", "archive":archive.to_string()}).to_string();
        assert!(valid_sequential_replay_record(&record(&archive)));
        let id = "agent-city:mecha-sequential-replay-entry:v1:12345678-1234-1234-1234-123456789abc";
        let payload = json!({"key":"mecha-replays:v1", "format":"sequential-v1", "op":"insert", "id":id, "raw":record(&archive)});
        assert_eq!(handle(&[], &home, "city", "plugin.state.write", &payload), Err("state_key_denied"));
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.write", &payload), Err("method_unavailable"));
        let list = handle(&allowed, &home, "city", "plugin.state.read", &json!({"key":"mecha-replays:v1", "format":"sequential-v1", "op":"list"})).unwrap();
        assert!(list["entries"].as_array().unwrap().is_empty());
        let missing_format = handle(&allowed, &home, "city", "plugin.state.read", &json!({"key":"mecha-replays:v1", "op":"list"}));
        assert_eq!(missing_format, Err("invalid_state_value"));
        for edit in 0..6 {
            let mut changed = archive.clone();
            match edit {
                0 => changed["ruleset"] = json!("mecha-v1.4"),
                1 => changed["opening"]["placements"][0]["pos"]["x"] = json!(10),
                2 => changed["replay"]["entries"][2]["command"]["action"]["target"] = json!("private-city-id"),
                3 => changed["replay"]["entries"][0]["command"]["revision"] = json!(2),
                4 => changed["replay"]["entries"][0]["private"] = json!("data"),
                _ => changed["replay"]["entries"] = Value::Array(vec![Value::Null; 513]),
            }
            assert!(!valid_sequential_replay_record(&record(&changed)), "accepted mutation {edit}");
        }
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn sequential_checkpoint_accepts_known_enemy_policies_and_legacy_records() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/mecha-sequential-replay-browser-synthetic.json")).unwrap();
        let archive: Value = serde_json::from_str(fixture["archive"].as_str().unwrap()).unwrap();
        let record = |value: &Value| json!({"schema":"mecha-sequential-replay-entry:v1", "savedAt":"2026-11-06T12:00:00.000Z", "archive":value.to_string()}).to_string();
        assert!(valid_sequential_replay_record(&record(&archive)));
        for policy in ["scripted", "baup"] {
            let mut next = archive.clone();
            next["replay"]["enemyPolicy"] = json!(policy);
            assert!(valid_sequential_replay_record(&record(&next)));
        }
        let mut invalid = archive;
        invalid["replay"]["enemyPolicy"] = json!("unknown");
        assert!(!valid_sequential_replay_record(&record(&invalid)));
    }

    #[test]
    fn sequential_replay_validator_keeps_the_existing_byte_boundaries() {
        let fixture = include_str!("../tests/fixtures/mecha-sequential-replay-browser-synthetic.json");
        let base: Value = serde_json::from_str(fixture).unwrap();
        let original = base["archive"].as_str().unwrap();
        for size in [31 * 1024, 33 * 1024, 40_000] {
            let archive = format!("{}{}", original, " ".repeat(size - original.len()));
            let mut record = base.clone();
            record["archive"] = json!(archive);
            let raw = record.to_string();
            assert!(valid_sequential_replay_record(&raw), "archive bytes: {size}");
        }
        let mut record = base.clone();
        record["archive"] = json!(format!("{}{}", original, " ".repeat(40_001 - original.len())));
        assert!(!valid_sequential_replay_record(&record.to_string()));
        let mut raw = base.to_string();
        raw.push_str(&" ".repeat(41_024 - raw.len()));
        assert!(valid_sequential_replay_record(&raw));
        raw.push(' ');
        assert!(!valid_sequential_replay_record(&raw));
    }

    #[test]
    fn sequential_replay_legacy_writer_is_retired() {
        let raw = include_str!("../tests/fixtures/mecha-sequential-replay-browser-synthetic.json");
        assert!(valid_sequential_replay_record(raw));
        let home = temp_home();
        let allowed = vec!["mecha-replays:v1".to_string()];
        let id = "agent-city:mecha-sequential-replay-entry:v1:12345678-1234-1234-1234-123456789abc";
        let insert = json!({"key":"mecha-replays:v1", "format":"sequential-v1", "op":"insert", "id":id, "raw":raw});
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.write", &insert), Err("method_unavailable"));
        let list = handle(&allowed, &home, "city", "plugin.state.read", &json!({"key":"mecha-replays:v1", "format":"sequential-v1", "op":"list"})).unwrap();
        assert!(list["entries"].as_array().unwrap().is_empty());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn sequential_status_v2_requires_exact_versioned_encounter() {
        let digest = "a".repeat(64);
        let archive = json!({"schema":"mecha-sequential-bundle:v2", "ruleset":"mecha-v1.5", "siteDigest":digest,
            "opening":{"preset":"covers_sparse_mid", "script":"siege", "placements":[
                {"mechId":"Assault","pos":{"x":0,"y":8}}, {"mechId":"Gunner","pos":{"x":3,"y":8}}, {"mechId":"Support","pos":{"x":6,"y":8}}],
                "encounter":{"speciesId":"prism_warden","contentVersion":1,"statusRules":"mecha-status-encounter:v1"}},
            "replay":{"schema":"mecha-sequential-replay:v2", "ruleset":"mecha-v1.5", "statusRules":"mecha-status-encounter:v1",
                "initialDigest":digest, "finalDigest":digest, "entries":[{"command":{"kind":"end","id":"c0","revision":1,"confirmUnused":true},"eventDigest":digest}]}});
        let record = |a: &Value| json!({"schema":"mecha-sequential-replay-entry:v1", "savedAt":"2026-11-06T12:00:00.000Z", "archive":a.to_string()}).to_string();
        assert!(valid_sequential_replay_record(&record(&archive)));
        for edit in 0..7 {
            let mut bad = archive.clone();
            match edit {
                0 => bad["opening"]["encounter"]["speciesId"] = json!("neural_weaver"),
                1 => bad["opening"]["encounter"]["contentVersion"] = json!(2),
                2 => bad["opening"]["encounter"]["statusRules"] = json!("unknown"),
                3 => bad["opening"]["encounter"]["private"] = json!("data"),
                4 => bad["replay"]["schema"] = json!("mecha-sequential-replay:v1"),
                5 => bad["replay"]["statusRules"] = json!("unknown"),
                _ => bad["schema"] = json!("mecha-sequential-bundle:v1"),
            }
            assert!(!valid_sequential_replay_record(&record(&bad)), "accepted mutation {edit}");
        }
    }

    #[test]
    fn sequential_status_v2_checkpoint_is_read_only_during_copy_forward() {
        let raw = include_str!("../tests/fixtures/mecha-sequential-status-v2-synthetic.json");
        assert!(valid_sequential_replay_record(raw));
        let home = temp_home();
        let allowed = vec!["mecha-replays:v1".to_string()];
        let read = json!({"key":"mecha-replays:v1", "format":"sequential-checkpoint-v1", "op":"read"});
        let write = json!({"key":"mecha-replays:v1", "format":"sequential-checkpoint-v1", "op":"write", "revision":0, "raw":raw});
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.read", &read).unwrap(), json!({"revision":0,"raw":null}));
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.write", &write), Err("method_unavailable"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn sequential_checkpoint_legacy_record_can_be_read_without_mutating_sqlite() {
        let raw = include_str!("../tests/fixtures/mecha-sequential-replay-browser-synthetic.json");
        let home = temp_home();
        let allowed = vec!["mecha-replays:v1".to_string()];
        let read = json!({"key":"mecha-replays:v1", "format":"sequential-checkpoint-v1", "op":"read"});
        let path = home.join("state/plugins/city-assets/mecha-sequential-checkpoint.sqlite");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, record TEXT);").unwrap();
        db.execute("INSERT INTO checkpoint(id,revision,record) VALUES(1,7,?1)", [raw]).unwrap();
        drop(db);
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.read", &read).unwrap(), json!({"revision":7,"raw":raw}));
        let write = json!({"key":"mecha-replays:v1", "format":"sequential-checkpoint-v1", "op":"write", "revision":7, "raw":null});
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.write", &write), Err("method_unavailable"));
        let db = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let stored: (u64, String) = db.query_row("SELECT revision,record FROM checkpoint WHERE id=1", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(stored, (7, raw.to_string()));
        std::fs::remove_dir_all(home).unwrap();
    }

    const KEYS: &[&str] = &["flight-profile:v1"];
    fn keys() -> Vec<String> { KEYS.iter().map(|key| key.to_string()).collect() }

    #[test]
    fn round_trip_with_revision_and_allowlist() {
        let home = temp_home();
        // 空 → revision 0。
        let empty = handle(&keys(), &home, "city", "plugin.state.read", &json!({"key":"flight-profile:v1"})).unwrap();
        assert_eq!(empty["revision"], 0);
        assert!(empty["value"].is_null());
        // 未声明 key / 非法 key 拒绝。
        assert_eq!(handle(&keys(), &home, "city", "plugin.state.read", &json!({"key":"other:v1"})), Err("state_key_denied"));
        assert_eq!(handle(&keys(), &home, "city", "plugin.state.read", &json!({"key":"../escape:v1"})), Err("state_key_denied"));
        // 首写 revision 0；读回 revision 1。
        let written = handle(&keys(), &home, "city", "plugin.state.write",
            &json!({"key":"flight-profile:v1","revision":0,"value":{"best":120}})).unwrap();
        assert_eq!(written["revision"], 1);
        let read = handle(&keys(), &home, "city", "plugin.state.read", &json!({"key":"flight-profile:v1"})).unwrap();
        assert_eq!(read["revision"], 1);
        assert_eq!(read["value"]["best"], 120);
        // 旧 revision 写入冲突；正确 revision 推进。
        assert_eq!(handle(&keys(), &home, "city", "plugin.state.write",
            &json!({"key":"flight-profile:v1","revision":0,"value":{"best":1}})), Err("revision_conflict"));
        handle(&keys(), &home, "city", "plugin.state.write",
            &json!({"key":"flight-profile:v1","revision":1,"value":{"best":90}})).unwrap();
        assert_eq!(handle(&keys(), &home, "city", "plugin.state.read", &json!({"key":"flight-profile:v1"})).unwrap()["revision"], 2);
        // 按插件隔离：city 写入不影响其他插件。
        assert_eq!(handle(&keys(), &home, "other", "plugin.state.read", &json!({"key":"flight-profile:v1"})).unwrap()["revision"], 0);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn oversize_document_rejected_and_corrupt_preserved() {
        let home = temp_home();
        let big = "x".repeat(49 * 1024);
        assert_eq!(handle(&keys(), &home, "city", "plugin.state.write",
            &json!({"key":"flight-profile:v1","revision":0,"value":{"blob":big}})), Err("state_too_large"));
        // 读路径同限：直接落盘的超限文件按损坏处理，不整读进内存解析。
        let path = state_path(&home, "city", "flight-profile:v1");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("{{\"revision\":1,\"value\":\"{}\"}}", "x".repeat(50 * 1024))).unwrap();
        assert_eq!(handle(&keys(), &home, "city", "plugin.state.read", &json!({"key":"flight-profile:v1"})), Err("state_unavailable"));
        std::fs::remove_file(&path).unwrap();
        // 损坏文件：读取报错；写入先备份再成功。
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(handle(&keys(), &home, "city", "plugin.state.read", &json!({"key":"flight-profile:v1"})), Err("state_unavailable"));
        handle(&keys(), &home, "city", "plugin.state.write",
            &json!({"key":"flight-profile:v1","revision":0,"value":{"fresh":true}})).unwrap();
        assert!(path.parent().unwrap().read_dir().unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().contains("corrupt-")));
        assert_eq!(handle(&keys(), &home, "city", "plugin.state.read", &json!({"key":"flight-profile:v1"})).unwrap()["value"]["fresh"], true);
        // 不残留临时文件。
        assert!(!path.parent().unwrap().read_dir().unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().contains("tmp-")));
        std::fs::remove_dir_all(&home).unwrap();
    }
}
