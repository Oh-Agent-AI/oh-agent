//! 通用插件本地状态端口（CITY_GAME_MODE_IMPLEMENTATION_PLAN §9）：
//! 有界 JSON 文档存储于应用私有数据目录 `state/plugins/<plugin_id>/state/<key>.json`，
//! 路径由宿主生成（插件只传 key）；单文档 ≤ 32 KiB（读与写同限）；读写携带 revision
//! 做乐观并发检查——「读版本→校验→临时文件→原子替换」在进程级互斥锁下串行执行，
//! 同 key 并发请求不会同时通过同一 revision 检查，也不会互踩临时文件；
//! 损坏文件读取报错、写入前保留可恢复副本。
//! 本模块只提供有界本地 JSON 存储，不实现飞机/任务规则，不进 authority DB。
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
    match method {
        "plugin.state.read" => read(allowed_keys, data_home, plugin_id, payload),
        "plugin.state.write" => write(allowed_keys, data_home, plugin_id, payload),
        _ => Err("method_unavailable"),
    }
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
        let dir = std::env::temp_dir().join(format!("plugin-state-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const KEYS: &[&str] = &["flight-profile:v1"];
    fn keys() -> Vec<String> { KEYS.iter().map(|key| key.to_string()).collect() }

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
