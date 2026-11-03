//! 通用插件本地状态端口（CITY_GAME_MODE_IMPLEMENTATION_PLAN §9）：
//! 有界 JSON 文档存储于应用私有数据目录 `state/plugins/<plugin_id>/state/<key>.json`，
//! 路径由宿主生成（插件只传 key）；单文档 ≤ 32 KiB（读与写同限）；读写携带 revision
//! 做乐观并发检查——「读版本→校验→临时文件→原子替换」在进程级互斥锁下串行执行，
//! 同 key 并发请求不会同时通过同一 revision 检查，也不会互踩临时文件；
//! 损坏文件读取报错、写入前保留可恢复副本。
//! 常规状态使用有界 JSON；机甲本地回放使用受授权、固定操作的 SQLite。
//! 本模块不实现游戏规则，也不进 authority DB。
use serde_json::Value;
use std::sync::MutexGuard;

const MAX_DOCUMENT_BYTES: usize = 32 * 1024;

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
    // game-links:v1 是描述符授予的宿主处理器，不按插件 id 再拦一道。
    // 这份存档在宿主侧只有一份；声明了该键的插件共用它。
    if payload["key"].as_str()==Some("game-links:v1") {
        if !allowed_keys.iter().any(|key| key=="game-links:v1") { return Err("state_key_denied"); }
        return agent_vitals_runtime::query::city_assets::game_links_state(data_home, method, payload);
    }
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

/// A narrowly scoped replay repository, separate from analytical authority data.
/// Only validated, bounded local PvE replay inputs can be stored here.
fn mecha_replays(home: &std::path::Path, method: &str, payload: &Value) -> Result<Value, &'static str> {
    use rusqlite::{params, Connection, OptionalExtension};
    let op = payload["op"].as_str().ok_or("invalid_state_value")?;
    if !matches!((method, op), ("plugin.state.read", "list") | ("plugin.state.write", "insert" | "delete")) {
        return Err("method_unavailable");
    }
    let dir = home.join("state/plugins/city-assets");
    std::fs::create_dir_all(&dir).map_err(|_| "state_unavailable")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|_| "state_unavailable")?;
    }
    let path = dir.join("mecha-replays.sqlite");
    let mut db = Connection::open(&path).map_err(|_| "state_unavailable")?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_| "state_unavailable")?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS replay_entries (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
        .map_err(|_| "state_unavailable")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|_| "state_unavailable")?;
    }
    if op == "list" {
        let mut stmt = db.prepare("SELECT id, record FROM replay_entries ORDER BY id").map_err(|_| "state_unavailable")?;
        let rows = stmt.query_map([], |row| Ok(serde_json::json!({"key": row.get::<_,String>(0)?, "raw": row.get::<_,String>(1)?})))
            .map_err(|_| "state_unavailable")?;
        let entries = rows.collect::<Result<Vec<_>,_>>().map_err(|_| "state_unavailable")?;
        return Ok(serde_json::json!({"entries": entries}));
    }
    let id = payload["id"].as_str().ok_or("invalid_state_value")?;
    let prefix = "agent-city:mecha-local-replay-entry:v1:";
    let suffix = id.strip_prefix(prefix).ok_or("invalid_state_value")?;
    if suffix.len() != 36 || !suffix.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') { return Err("invalid_state_value"); }
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "state_unavailable")?;
    if op == "insert" {
        let raw = payload["raw"].as_str().ok_or("invalid_state_value")?;
        if !valid_replay_record(raw) { return Err("invalid_state_value"); }
        let existing: Option<String> = tx.query_row("SELECT record FROM replay_entries WHERE id=?1", [id], |row| row.get(0))
            .optional().map_err(|_| "state_unavailable")?;
        if let Some(existing) = existing {
            if existing != raw { return Err("revision_conflict"); }
        } else {
            let count: i64 = tx.query_row("SELECT count(*) FROM replay_entries", [], |row| row.get(0)).map_err(|_| "state_unavailable")?;
            if count >= 20 { return Err("replay_full"); }
            tx.execute("INSERT INTO replay_entries(id,record) VALUES (?1,?2)", params![id,raw]).map_err(|_| "state_unavailable")?;
        }
    } else {
        tx.execute("DELETE FROM replay_entries WHERE id=?1", [id]).map_err(|_| "state_unavailable")?;
    }
    tx.commit().map_err(|_| "state_unavailable")?;
    Ok(serde_json::json!({"ok": true}))
}

fn valid_replay_record(raw: &str) -> bool {
    fn exact(v: &Value, keys: &[&str]) -> bool {
        v.as_object().is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k)))
    }
    fn one(v: &Value, names: &[&str]) -> bool { v.as_str().is_some_and(|s| names.contains(&s)) }
    fn unit(v: &Value) -> bool { one(v, &["Assault", "Gunner", "Support"]) }
    fn cell(v: &Value) -> bool {
        exact(v, &["x", "y"]) && v["x"].as_u64().is_some_and(|n| n < 10) && v["y"].as_u64().is_some_and(|n| n < 10)
    }
    if raw.len() > 41_024 { return false; }
    let Ok(record) = serde_json::from_str::<Value>(raw) else { return false; };
    if !exact(&record, &["schema", "savedAt", "turns", "archive"]) || record["schema"] != "mecha-local-replay-entry:v1"
        || !record["savedAt"].as_str().is_some_and(|s| s.len() == 24 && s.bytes().all(|c| c.is_ascii_digit() || b"-:.TZ".contains(&c))) { return false; }
    let Some(turns) = record["turns"].as_u64().filter(|n| (1..=15).contains(n)) else { return false; };
    let Some(raw_archive) = record["archive"].as_str().filter(|s| s.len() <= 40_000) else { return false; };
    let Ok(a) = serde_json::from_str::<Value>(raw_archive) else { return false; };
    if !exact(&a, &["schema", "ruleset", "siteDigest", "resultDigest", "preset", "script", "stake", "deployment", "placements", "plans"])
        || a["schema"] != "mecha-local-replay:v1" || a["ruleset"] != "mecha-v1.4"
        || !["siteDigest", "resultDigest"].iter().all(|k| a[*k].as_str().is_some_and(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))))
        || !one(&a["preset"], &["covers_sparse_mid", "covers_diag_corridor", "covers_twin_clusters"])
        || !one(&a["script"], &["stationary_smash", "cadence_ssw", "raid_ssw", "siege"])
        || !one(&a["stake"], &["all", "frontage"]) { return false; }
    let Some(deployment) = a["deployment"].as_bool() else { return false; };
    let Some(placements) = a["placements"].as_array() else { return false; };
    if placements.len() != if deployment { 3 } else { 0 } || !placements.iter().all(|p| exact(p, &["mechId", "pos"]) && unit(&p["mechId"]) && cell(&p["pos"])) { return false; }
    let Some(plans) = a["plans"].as_array() else { return false; };
    if plans.len() != turns as usize { return false; }
    plans.iter().all(|p| {
        exact(p, &["revision", "items"]) && p["revision"].as_u64().is_some_and(|v| v <= 9_007_199_254_740_991)
            && p["items"].as_array().is_some_and(|items| items.len() <= 3 && items.iter().all(|item| {
                if !exact(item, &["mechId", "moveTo", "action"]) || !unit(&item["mechId"]) || !(item["moveTo"].is_null() || cell(&item["moveTo"])) { return false; }
                let action = &item["action"];
                if !(exact(action, &["kind"]) || exact(action, &["kind", "target"]))
                    || !one(&action["kind"], &["skip", "melee", "shoot", "charge", "pierce", "repair"]) { return false; }
                let target = action.get("target");
                if action["kind"] == "skip" { return target.is_none(); }
                if action["kind"] == "repair" { return target.is_some_and(unit); }
                target.is_none_or(|v| v.as_str().is_some_and(|s| s == "boss" || s.strip_prefix('r').is_some_and(|n| !n.is_empty() && n.len() <= 2 && n.bytes().all(|b| b.is_ascii_digit()) && (n == "0" || !n.starts_with('0')))))
            }))
    })
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

    const KEYS: &[&str] = &["flight-profile:v1"];
    fn keys() -> Vec<String> { KEYS.iter().map(|key| key.to_string()).collect() }

    #[test]
    fn replay_database_is_authorized_bounded_and_transactional() {
        let home = temp_home();
        let allowed = vec!["mecha-replays:v1".to_string()];
        let key = "agent-city:mecha-local-replay-entry:v1:12345678-1234-1234-1234-123456789abc";
        let archive = json!({"schema":"mecha-local-replay:v1", "ruleset":"mecha-v1.4", "siteDigest":"a".repeat(64),
            "resultDigest":"b".repeat(64), "preset":"covers_sparse_mid", "script":"siege", "stake":"all",
            "deployment":false, "placements":[], "plans":[{"revision":0,"items":[{"mechId":"Assault","moveTo":null,"action":{"kind":"skip"}}]}]});
        let record = json!({"schema":"mecha-local-replay-entry:v1", "savedAt":"2026-11-03T12:00:00.000Z", "turns":1, "archive":archive.to_string()}).to_string();
        let list = json!({"key":"mecha-replays:v1", "op":"list"});
        let insert = json!({"key":"mecha-replays:v1", "op":"insert", "id":key, "raw":record});
        assert_eq!(handle(&keys(), &home, "city", "plugin.state.read", &list), Err("state_key_denied"));
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.read", &list).unwrap()["entries"].as_array().unwrap().len(), 0);
        handle(&allowed, &home, "city", "plugin.state.write", &insert).unwrap();
        handle(&allowed, &home, "city", "plugin.state.write", &insert).unwrap();
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.read", &list).unwrap()["entries"][0]["raw"], record);
        let mut corrupted = insert.clone();
        corrupted["raw"] = Value::String(record.replace("2026", "2025"));
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.write", &corrupted), Err("revision_conflict"));
        let mut injected_archive = archive.clone();
        injected_archive["prompt"] = json!("private data");
        let mut injected_record: Value = serde_json::from_str(&record).unwrap();
        injected_record["archive"] = json!(injected_archive.to_string());
        corrupted["raw"] = json!(injected_record.to_string());
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.write", &corrupted), Err("invalid_state_value"));
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.read", &insert), Err("method_unavailable"));
        for n in 0..19 {
            let another = format!("agent-city:mecha-local-replay-entry:v1:{n:08x}-0000-4000-8000-000000000000");
            handle(&allowed, &home, "city", "plugin.state.write", &json!({"key":"mecha-replays:v1", "op":"insert", "id":another, "raw":record})).unwrap();
        }
        let overflow = json!({"key":"mecha-replays:v1", "op":"insert", "id":"agent-city:mecha-local-replay-entry:v1:aaaaaaaa-0000-4000-8000-000000000000", "raw":record});
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.write", &overflow), Err("replay_full"));
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.read", &list).unwrap()["entries"].as_array().unwrap().len(), 20);
        let delete = json!({"key":"mecha-replays:v1", "op":"delete", "id":key});
        handle(&allowed, &home, "city", "plugin.state.write", &delete).unwrap();
        assert_eq!(handle(&allowed, &home, "city", "plugin.state.read", &list).unwrap()["entries"].as_array().unwrap().len(), 19);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn replay_database_concurrent_connections_preserve_capacity_and_records() {
        use std::sync::{Arc, Barrier};
        // Independent SQLite connections bypass the in-process handle lock, so this
        // also checks the transaction boundary used by separate app processes.
        let home = temp_home();
        let record = include_str!("../tests/fixtures/mecha-replay-browser-synthetic.json");
        let allowed = vec!["mecha-replays:v1".to_string()];
        let list = json!({"key":"mecha-replays:v1", "op":"list"});
        let prefix = "agent-city:mecha-local-replay-entry:v1:";
        for n in 0..19 {
            let id = format!("{prefix}{n:08x}-0000-4000-8000-000000000000");
            handle(&allowed, &home, "city", "plugin.state.write", &json!({"key":"mecha-replays:v1", "op":"insert", "id":id, "raw":record})).unwrap();
        }
        let barrier = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8).map(|n| {
            let home = home.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let id = format!("{prefix}{:08x}-0000-4000-8000-000000000000", n + 100);
                let payload = json!({"key":"mecha-replays:v1", "op":"insert", "id":id, "raw":record});
                barrier.wait();
                mecha_replays(&home, "plugin.state.write", &payload)
            })
        }).collect();
        let results: Vec<_> = workers.into_iter().map(|worker| worker.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1, "{results:?}");
        assert_eq!(results.iter().filter(|result| **result == Err("replay_full")).count(), 7, "{results:?}");
        let entries = handle(&allowed, &home, "city", "plugin.state.read", &list).unwrap();
        let entries = entries["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 20);
        for n in 0..19 {
            let id = format!("{prefix}{n:08x}-0000-4000-8000-000000000000");
            assert!(entries.iter().any(|entry| entry["key"] == id && entry["raw"] == record));
        }
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn replay_database_concurrent_conflicts_never_replace_a_record() {
        use std::sync::{Arc, Barrier};
        let home = temp_home();
        let record = include_str!("../tests/fixtures/mecha-replay-browser-synthetic.json");
        let mut changed: Value = serde_json::from_str(record).unwrap();
        changed["savedAt"] = json!("2025-11-03T12:00:00.000Z");
        let candidates = [record.to_string(), changed.to_string()];
        let id = "agent-city:mecha-local-replay-entry:v1:abcdef12-0000-4000-8000-000000000000";
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = candidates.iter().cloned().map(|raw| {
            let home = home.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let payload = json!({"key":"mecha-replays:v1", "op":"insert", "id":id, "raw":raw});
                barrier.wait();
                mecha_replays(&home, "plugin.state.write", &payload)
            })
        }).collect();
        let results: Vec<_> = workers.into_iter().map(|worker| worker.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1, "{results:?}");
        assert_eq!(results.iter().filter(|result| **result == Err("revision_conflict")).count(), 1, "{results:?}");
        let allowed = vec!["mecha-replays:v1".to_string()];
        let entries = handle(&allowed, &home, "city", "plugin.state.read", &json!({"key":"mecha-replays:v1", "op":"list"})).unwrap();
        let entries = entries["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["raw"], candidates[results.iter().position(|result| result.is_ok()).unwrap()]);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn replay_database_accepts_browser_generated_match() {
        // Produced by verify-city-mecha-replay-file-browser.mjs from synthetic City data.
        let record = include_str!("../tests/fixtures/mecha-replay-browser-synthetic.json");
        let home = temp_home();
        let allowed = vec!["mecha-replays:v1".to_string()];
        let key = "agent-city:mecha-local-replay-entry:v1:12345678-1234-1234-1234-123456789abc";
        let insert = json!({"key":"mecha-replays:v1", "op":"insert", "id":key, "raw":record});
        handle(&allowed, &home, "city", "plugin.state.write", &insert).unwrap();
        let result = handle(&allowed, &home, "city", "plugin.state.read", &json!({"key":"mecha-replays:v1", "op":"list"})).unwrap();
        assert_eq!(result["entries"][0]["raw"], record);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn game_links_follow_the_declared_state_key() {
        let home=temp_home().join("game-links");
        let payload=json!({"key":"game-links:v1"});
        assert_eq!(handle(&keys(),&home,"city","plugin.state.read",&payload),Err("state_key_denied"));
        let allowed=vec!["game-links:v1".to_owned()];
        assert_eq!(handle(&allowed,&home,"other","plugin.state.read",&payload).unwrap()["revision"],0);
        assert_eq!(handle(&allowed,&home,"city","plugin.state.read",&payload).unwrap()["revision"],0);
        assert_eq!(handle(&allowed,&home,"city","plugin.state.write",&json!({"key":"game-links:v1","revision":0,"value":{"schemaVersion":1,"assetRefs":[]}})).unwrap()["revision"],1);
        std::fs::remove_dir_all(home).unwrap();
    }

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
        let big = "x".repeat(33 * 1024);
        assert_eq!(handle(&keys(), &home, "city", "plugin.state.write",
            &json!({"key":"flight-profile:v1","revision":0,"value":{"blob":big}})), Err("state_too_large"));
        // 读路径同限：直接落盘的超限文件按损坏处理，不整读进内存解析。
        let path = state_path(&home, "city", "flight-profile:v1");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("{{\"revision\":1,\"value\":\"{}\"}}", "x".repeat(40 * 1024))).unwrap();
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
