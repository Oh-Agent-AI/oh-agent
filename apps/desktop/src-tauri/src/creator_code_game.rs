//! Code Game 预览状态的唯一写入口。
//!
//! City WebView 持有实时状态（tick/实体数/结束原因），但 MCP 是另一个进程；两边
//! 只共享 `<data_home>/state/creator/code-games/preview.json`。这里把 WebView
//! 上报的 DTO 收敛成**有界白名单**再落盘：状态词表、id 长度、计数值范围都在宿主
//! 侧校验，MCP 读取时不需要信任调用方。
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use crate::creator_store::{bytes_digest, canonical_json, new_id};

const MAX_ID: usize = 128;
const MAX_REASON: usize = 120;
const MAX_TICK: u64 = 100_000_000;
const MAX_ENTITIES: u64 = 4_096;

fn code_games_root(home: &Path) -> PathBuf {
    home.join("state/creator/code-games")
}

fn bounded(state: &Value, key: &str, max: usize) -> Option<String> {
    state
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= max)
        .map(ToString::to_string)
}

fn bounded_count(state: &Value, key: &str, max: u64) -> Option<u64> {
    state.get(key).and_then(Value::as_u64).filter(|value| *value <= max)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Persist one preview state snapshot. Idempotent and atomic (tmp + rename), so
/// a crash mid-write cannot leave a truncated record for MCP to parse.
///
/// Two entry points share it: the City plugin message (`plugin_message` is the
/// only channel a plugin webview may use — custom commands are rejected for
/// `plugin-*` webviews) and, for local tooling, the Tauri command below.
#[tauri::command]
pub fn code_game_preview_state(state: Value) -> Result<Value, String> {
    record_preview_state(&crate::overview::data_home(), &state)?;
    Ok(json!({"ok": true}))
}

pub(crate) fn record_preview_state(home: &Path, state: &Value) -> Result<(), String> {
    let status = match state.get("status").and_then(Value::as_str) {
        Some("starting") => "starting",
        Some("running") => "running",
        Some("finished") => "finished",
        Some("error") => "error",
        _ => return Err("code_game_state_invalid: unknown status".to_string()),
    };
    let record = json!({
        "status": status,
        "gameId": bounded(state, "gameId", MAX_ID),
        "buildId": bounded(state, "buildId", 64),
        "runId": bounded(state, "runId", 64),
        "reason": bounded(state, "reason", MAX_REASON),
        "outcome": bounded(state, "outcome", 16),
        "tick": bounded_count(state, "tick", MAX_TICK),
        "entities": bounded_count(state, "entities", MAX_ENTITIES),
        "updatedAtMs": now_ms(),
    });
    let root = code_games_root(home);
    std::fs::create_dir_all(&root).map_err(|error| format!("code_game_state_unavailable: {error}"))?;
    let target = root.join("preview.json");
    let temporary = root.join("preview.json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(&record).map_err(|error| format!("code_game_state_invalid: {error}"))?)
        .map_err(|error| format!("code_game_state_unavailable: {error}"))?;
    std::fs::rename(&temporary, &target).map_err(|error| format!("code_game_state_unavailable: {error}"))?;
    Ok(())
}

const MAX_PREVIEW_REQUEST_BYTES: usize = 4_096;
const MAX_PREVIEW_TOTAL_BYTES: usize = 5_000_000;

fn request_string(request: &Value, key: &str, max: usize) -> Result<String, String> {
    request.get(key).and_then(Value::as_str).filter(|value| !value.is_empty() && value.len() <= max)
        .map(ToString::to_string).ok_or_else(|| "code_game_preview_request_invalid".to_string())
}

fn sealed_file(root: &Path, relative: &str, max: usize) -> Result<Vec<u8>, String> {
    let segments: Vec<&str> = relative.split('/').collect();
    if segments.is_empty() || segments.iter().any(|segment| segment.is_empty() || matches!(*segment, "." | "..")) {
        return Err("game_package_integrity_failed".to_string());
    }
    let mut current = root.to_path_buf();
    for segment in &segments[..segments.len() - 1] {
        current.push(segment);
        let metadata = std::fs::symlink_metadata(&current).map_err(|_| "game_package_integrity_failed".to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err("game_package_integrity_failed".to_string()); }
    }
    current.push(segments[segments.len() - 1]);
    let metadata = std::fs::symlink_metadata(&current).map_err(|_| "game_package_integrity_failed".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max as u64 {
        return Err("game_package_integrity_failed".to_string());
    }
    std::fs::read(current).map_err(|_| "game_package_integrity_failed".to_string())
}

fn record_text<'a>(record: &'a Value, key: &str) -> Result<&'a str, String> {
    record.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or_else(|| "game_package_integrity_failed".to_string())
}

type SealedPreview = (Value, Vec<u8>, Vec<(String, Vec<u8>)>);

fn load_sealed_preview(home: &Path, build_id: &str) -> Result<SealedPreview, String> {
    if build_id.len() != 64 || !build_id.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        return Err("game_argument_invalid".to_string());
    }
    let root = home.join("code-games").join("builds").join(build_id);
    let manifest_bytes = sealed_file(&root, "manifest.json", 1_000_000)?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes).map_err(|_| "game_package_integrity_failed".to_string())?;
    let record_bytes = sealed_file(&root, "build.json", 1_000_000)?;
    let record: Value = serde_json::from_slice(&record_bytes).map_err(|_| "game_package_integrity_failed".to_string())?;
    if record_text(&record, "buildId")? != build_id || record.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || record.get("kind").and_then(Value::as_str) != Some("code-game-build") {
        return Err("game_package_integrity_failed".to_string());
    }
    let bundle = sealed_file(&root, "game.js", 2_000_000)?;
    let source_map = sealed_file(&root, "game.js.map", 2_000_000)?;
    String::from_utf8(bundle.clone()).map_err(|_| "game_package_integrity_failed".to_string())?;
    let bundle_digest = bytes_digest(&bundle);
    let source_map_digest = bytes_digest(&source_map);
    let manifest_digest = bytes_digest(canonical_json(&manifest).map_err(|_| "game_package_integrity_failed".to_string())?.as_bytes());
    if record_text(&record, "bundleDigest")? != bundle_digest || record_text(&record, "sourceMapDigest")? != source_map_digest
        || record_text(&record, "manifestDigest")? != manifest_digest || record.get("byteLength").and_then(Value::as_u64) != Some(bundle.len() as u64) {
        return Err("game_package_integrity_failed".to_string());
    }
    let manifest_assets = manifest.get("assets").and_then(Value::as_array).ok_or_else(|| "game_package_integrity_failed".to_string())?;
    let recorded_assets = record.get("assetDigests").and_then(Value::as_object).ok_or_else(|| "game_package_integrity_failed".to_string())?;
    if recorded_assets.len() != manifest_assets.len() { return Err("game_package_integrity_failed".to_string()); }
    let mut asset_digests = serde_json::Map::new();
    let mut assets = Vec::new();
    let mut total = bundle.len() + source_map.len() + manifest_bytes.len() + record_bytes.len();
    for asset in manifest_assets {
        let path = asset.get("path").and_then(Value::as_str).ok_or_else(|| "game_package_integrity_failed".to_string())?;
        let id = asset.get("id").and_then(Value::as_str).ok_or_else(|| "game_package_integrity_failed".to_string())?;
        let bytes = sealed_file(&root, path, 2_000_000)?;
        total = total.saturating_add(bytes.len());
        if total > MAX_PREVIEW_TOTAL_BYTES { return Err("game_preview_too_large".to_string()); }
        let digest = bytes_digest(&bytes);
        if recorded_assets.get(path).and_then(Value::as_str) != Some(digest.as_str()) { return Err("game_package_integrity_failed".to_string()); }
        asset_digests.insert(path.to_string(), json!(digest));
        assets.push((id.to_string(), bytes));
    }
    let content_digest = bytes_digest(canonical_json(&json!({"manifestDigest":manifest_digest,"bundleDigest":bundle_digest,
        "sourceMapDigest":source_map_digest,"assetDigests":Value::Object(asset_digests)})).map_err(|_| "game_package_integrity_failed".to_string())?.as_bytes());
    if record_text(&record, "contentDigest")? != content_digest { return Err("game_package_integrity_failed".to_string()); }
    let identity = json!({"domain":"oh-agent-code-game-build-v2","gameId":record_text(&record, "gameId")?,
        "gameVersion":record_text(&record, "gameVersion")?,"manifestDigest":manifest_digest,"contentDigest":content_digest,
        "sourceRevision":record_text(&record, "sourceRevision")?,"sdkVersion":record_text(&record, "sdkVersion")?,
        "toolchainVersion":record_text(&record, "toolchainVersion")?});
    if bytes_digest(canonical_json(&identity).map_err(|_| "game_package_integrity_failed".to_string())?.as_bytes()) != format!("sha256:{build_id}")
        || record.get("gameId") != manifest.get("gameId") || record.get("gameVersion") != manifest.get("version") {
        return Err("game_package_integrity_failed".to_string());
    }
    Ok((manifest, bundle, assets))
}

pub(crate) fn request_city_open(home: &Path, now: u64) -> bool {
    let path = home.join("state/creator/code-games/preview-request.json");
    let Ok(bytes) = std::fs::read(&path) else { return false; };
    if bytes.len() > MAX_PREVIEW_REQUEST_BYTES { return false; }
    let Ok(mut request) = serde_json::from_slice::<Value>(&bytes) else { return false; };
    if request.get("status").and_then(Value::as_str) != Some("queued") { return false; }
    let last = request.get("cityOpenRequestedAtMs").and_then(Value::as_u64).unwrap_or(0);
    if last != 0 && now.saturating_sub(last) < 10_000 { return false; }
    request["cityOpenRequestedAtMs"] = json!(now);
    let temporary = path.with_extension("json.tmp");
    let Ok(encoded) = serde_json::to_vec(&request) else { return false; };
    std::fs::write(&temporary, encoded).and_then(|_| std::fs::rename(&temporary, &path)).is_ok()
}

struct PreviewSnapshot {
    instance: String,
    bundle: Vec<u8>,
    assets: Vec<(String, Vec<u8>)>,
}

fn preview_snapshots() -> &'static Mutex<HashMap<String, PreviewSnapshot>> {
    static SNAPSHOTS: OnceLock<Mutex<HashMap<String, PreviewSnapshot>>> = OnceLock::new();
    SNAPSHOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn next_preview(home: &Path, city_instance: &str) -> Result<Value, &'static str> {
    next_preview_result(home, city_instance).map_err(|code| match code.as_str() {
        "code_game_preview_request_invalid" => "code_game_preview_request_invalid",
        "game_argument_invalid" => "game_argument_invalid",
        "game_package_integrity_failed" => "game_package_integrity_failed",
        "game_preview_too_large" => "game_preview_too_large",
        _ => "code_game_state_unavailable",
    })
}

fn next_preview_result(home: &Path, city_instance: &str) -> Result<Value, String> {
    let path = home.join("state/creator/code-games/preview-request.json");
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(_) => return Err("code_game_state_unavailable".to_string()),
    };
    if bytes.len() > MAX_PREVIEW_REQUEST_BYTES { return Err("code_game_preview_request_invalid".to_string()); }
    let request: Value = serde_json::from_slice(&bytes).map_err(|_| "code_game_preview_request_invalid".to_string())?;
    if request.get("status").and_then(Value::as_str) != Some("queued") { return Ok(Value::Null); }
    let request_id = request_string(&request, "requestId", 128)?;
    let build_id = request_string(&request, "buildId", 64)?;
    let seed = request.get("seed").and_then(Value::as_u64).ok_or_else(|| "code_game_preview_request_invalid".to_string())?;
    let (manifest, bundle, assets) = load_sealed_preview(home, &build_id)?;
    let claimed = json!({"requestId":request_id,"buildId":build_id,"seed":seed,"status":"claimed","claimedAtMs":now_ms()});
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(&claimed).map_err(|_| "code_game_state_invalid".to_string())?)
        .map_err(|_| "code_game_state_unavailable".to_string())?;
    std::fs::rename(&temporary, &path).map_err(|_| "code_game_state_unavailable".to_string())?;
    let snapshot_id = new_id("code-preview-")?;
    let mut snapshots = preview_snapshots().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    snapshots.retain(|_, snapshot| snapshot.instance != city_instance);
    snapshots.insert(snapshot_id.clone(), PreviewSnapshot { instance: city_instance.to_string(), bundle, assets });
    drop(snapshots);
    Ok(json!({"requestId":request_id,"buildId":build_id,"seed":seed,"manifest":manifest,"snapshotId":snapshot_id}))
}

pub(crate) fn read_preview(city_instance: &str, payload: &Value) -> Result<Value, &'static str> {
    let snapshot_id = payload.get("snapshotId").and_then(Value::as_str).ok_or("game_argument_invalid")?;
    let path = payload.get("path").and_then(Value::as_str).ok_or("game_argument_invalid")?;
    let offset = payload.get("offset").and_then(Value::as_u64).ok_or("game_argument_invalid")? as usize;
    let snapshots = preview_snapshots().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let snapshot = snapshots.get(snapshot_id).filter(|snapshot| snapshot.instance == city_instance).ok_or("content_snapshot_expired")?;
    let bytes = if path == "game.js" { &snapshot.bundle }
        else { path.strip_prefix("asset:").and_then(|id| snapshot.assets.iter().find(|(asset, _)| asset == id).map(|(_, bytes)| bytes)).ok_or("game_asset_invalid")? };
    if offset > bytes.len() { return Err("game_argument_invalid"); }
    let end = offset.saturating_add(512 * 1024).min(bytes.len());
    Ok(json!({"contentBase64":BASE64.encode(&bytes[offset..end]),"byteLength":bytes.len(),"nextOffset":end,"complete":end == bytes.len()}))
}

pub(crate) fn close_preview(city_instance: &str, payload: &Value) -> Result<Value, &'static str> {
    let snapshot_id = payload.get("snapshotId").and_then(Value::as_str).ok_or("game_argument_invalid")?;
    let mut snapshots = preview_snapshots().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !snapshots.get(snapshot_id).is_some_and(|snapshot| snapshot.instance == city_instance) { return Err("content_snapshot_expired"); }
    snapshots.remove(snapshot_id);
    Ok(json!({"closed":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_is_bounded_atomic_and_whitelisted() {
        let home = std::env::temp_dir().join(format!("code-game-state-{}-{}", now_ms(), std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        record_preview_state(
            &home,
            &json!({
                "status": "running",
                "outcome": "success",
                "gameId": "community.hello-city",
                "runId": "run-7",
                "tick": 12,
                "entities": 1,
                "secret": "/Users/someone/private",
                "tickTooLarge": 999_999_999_999_u64,
            }),
        )
        .unwrap();
        let path = home.join("state/creator/code-games/preview.json");
        let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["status"], "running");
        assert_eq!(value["tick"], 12);
        assert_eq!(value["outcome"], "success");
        assert!(value.get("secret").is_none(), "unknown fields must not be persisted");
        assert!(record_preview_state(&home, &json!({"status": "nope"})).is_err());
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn preview_reads_only_sealed_bytes_and_rejects_tampering() {
        let home = std::env::temp_dir().join(format!("code-game-preview-{}-{}", now_ms(), std::process::id()));
        let build_id = "a".repeat(64);
        let root = home.join("code-games/builds").join(&build_id);
        std::fs::create_dir_all(&root).unwrap();
        let manifest = json!({"schemaVersion":2,"kind":"code-game","gameId":"test.preview","displayName":"Preview","version":"1.0.0",
            "entry":"src/index.ts","sdk":{"name":"@oh-agent/city-game-sdk","apiMajor":2},"world":{"requiredCapabilities":[],"binding":"capability-based"},
            "render":{"compatibleProfiles":[]},"presentation":{"supported":["exclusive"],"default":"exclusive"},"permissions":[],
            "entries":[{"id":"default","export":"default","presentation":["exclusive"]}],"limits":{"maxEntities":1,"maxProjectiles":0},"assets":[{"id":"cube","path":"assets/cube.glb","type":"model/glb"}]});
        let bundle = b"export default {}";
        let map = b"{}";
        let asset_bytes = vec![7_u8; 600_000];
        let asset_digest = bytes_digest(&asset_bytes);
        let manifest_digest = bytes_digest(canonical_json(&manifest).unwrap().as_bytes());
        let bundle_digest = bytes_digest(bundle);
        let map_digest = bytes_digest(map);
        let content_digest = bytes_digest(canonical_json(&json!({"manifestDigest":manifest_digest,"bundleDigest":bundle_digest,
            "sourceMapDigest":map_digest,"assetDigests":{"assets/cube.glb":asset_digest}})).unwrap().as_bytes());
        let identity = json!({"domain":"oh-agent-code-game-build-v2","gameId":"test.preview","gameVersion":"1.0.0",
            "manifestDigest":manifest_digest,"contentDigest":content_digest,"sourceRevision":"source","sdkVersion":"1","toolchainVersion":"tool"});
        let actual_id = bytes_digest(canonical_json(&identity).unwrap().as_bytes()).trim_start_matches("sha256:").to_string();
        let root = home.join("code-games/builds").join(&actual_id);
        std::fs::create_dir_all(&root).unwrap();
        let record = json!({"schemaVersion":2,"kind":"code-game-build","buildId":actual_id,"gameId":"test.preview","gameVersion":"1.0.0",
            "manifestSchemaVersion":2,"sdk":manifest["sdk"],"entry":"src/index.ts","bundle":"game.js","byteLength":bundle.len(),
            "bundleDigest":bundle_digest,"sourceMapDigest":map_digest,"manifestDigest":manifest_digest,"assetDigests":{"assets/cube.glb":asset_digest},
            "contentDigest":content_digest,"sourceRevision":"source","sdkVersion":"1","toolchainVersion":"tool","bundler":"test"});
        std::fs::write(root.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        std::fs::write(root.join("game.js"), bundle).unwrap();
        std::fs::write(root.join("game.js.map"), map).unwrap();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/cube.glb"), &asset_bytes).unwrap();
        std::fs::write(root.join("build.json"), serde_json::to_vec(&record).unwrap()).unwrap();
        let request_dir = home.join("state/creator/code-games");
        std::fs::create_dir_all(&request_dir).unwrap();
        let request = json!({"requestId":"request-1","buildId":actual_id,"seed":7,"status":"queued","createdAtMs":1});
        std::fs::write(request_dir.join("preview-request.json"), serde_json::to_vec(&request).unwrap()).unwrap();
        assert!(request_city_open(&home, 2));
        assert!(!request_city_open(&home, 3));
        let loaded = next_preview(&home, "city-test").unwrap();
        assert_eq!(loaded["manifest"]["gameId"], "test.preview");
        let read = read_preview("city-test", &json!({"snapshotId":loaded["snapshotId"],"path":"game.js","offset":0})).unwrap();
        assert_eq!(BASE64.decode(read["contentBase64"].as_str().unwrap()).unwrap(), bundle);
        assert_eq!(read["complete"], true);
        let asset_first = read_preview("city-test", &json!({"snapshotId":loaded["snapshotId"],"path":"asset:cube","offset":0})).unwrap();
        let asset_second = read_preview("city-test", &json!({"snapshotId":loaded["snapshotId"],"path":"asset:cube","offset":512 * 1024})).unwrap();
        assert_eq!(asset_first["complete"], false);
        assert_eq!(asset_second["complete"], true);
        assert_eq!(BASE64.decode(asset_first["contentBase64"].as_str().unwrap()).unwrap().len() + BASE64.decode(asset_second["contentBase64"].as_str().unwrap()).unwrap().len(), asset_bytes.len());
        close_preview("city-test", &json!({"snapshotId":loaded["snapshotId"]})).unwrap();
        assert_eq!(read_preview("city-test", &json!({"snapshotId":loaded["snapshotId"],"path":"game.js","offset":0})).unwrap_err(), "content_snapshot_expired");
        assert_eq!(next_preview(&home, "city-test").unwrap(), Value::Null);
        std::fs::write(request_dir.join("preview-request.json"), serde_json::to_vec(&request).unwrap()).unwrap();
        std::fs::write(root.join("game.js"), b"export default { tampered: true }").unwrap();
        assert_eq!(next_preview(&home, "city-test").unwrap_err(), "game_package_integrity_failed");
        std::fs::remove_dir_all(home).ok();
    }
}
