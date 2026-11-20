//! Code Game 预览的宿主状态、冻结产物与启停控制。
//!
//! City WebView 持有实时状态（tick/实体数/结束原因），MCP 和 Studio 是其他进程。
//! 每个 Preview 在 `<data_home>/state/creator/code-games/previews/<previewId>/`
//! 下持有独立请求、控制和状态；`preview.json` 仅保留最近状态供旧 MCP/Studio 读取。
//! WebView 上报的 DTO 收敛成**有界白名单**再落盘：状态词表、id 长度、计数值范围
//! 都在宿主侧校验，MCP 读取时不需要信任调用方。
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
const MAX_PREVIEW_RECORDS: usize = 32;
const PREVIEW_WINDOW_RETRY_MS: u64 = 10_000;

fn code_games_root(home: &Path) -> PathBuf {
    home.join("state/creator/code-games")
}

fn previews_root(home: &Path) -> PathBuf {
    code_games_root(home).join("previews")
}

pub(crate) fn valid_preview_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID && value.starts_with(|c: char| c.is_ascii_alphanumeric())
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn preview_dir(home: &Path, preview_id: &str) -> Result<PathBuf, String> {
    if !valid_preview_id(preview_id) { return Err("code_game_preview_request_invalid".to_string()); }
    Ok(previews_root(home).join(preview_id))
}

fn preview_io_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "code_game_state_invalid".to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|_| "code_game_state_unavailable".to_string())?;
    if std::fs::rename(&temporary, path).is_err() {
        std::fs::remove_file(temporary).ok();
        return Err("code_game_state_unavailable".to_string());
    }
    Ok(())
}

fn read_json(path: &Path, max_bytes: usize) -> Result<Option<Value>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("code_game_state_unavailable".to_string()),
    };
    if bytes.len() > max_bytes { return Err("code_game_preview_request_invalid".to_string()); }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| "code_game_preview_request_invalid".to_string())
}

fn preview_ids(home: &Path) -> Result<Vec<String>, String> {
    let entries = match std::fs::read_dir(previews_root(home)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("code_game_state_unavailable".to_string()),
    };
    let mut ids = Vec::new();
    for entry in entries.take(MAX_PREVIEW_RECORDS + 1) {
        let entry = entry.map_err(|_| "code_game_state_unavailable".to_string())?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if valid_preview_id(&id) && entry.file_type().is_ok_and(|kind| kind.is_dir()) { ids.push(id); }
    }
    ids.sort();
    Ok(ids)
}

fn ensure_preview_capacity(home: &Path) -> Result<(), String> {
    let ids = preview_ids(home)?;
    if ids.len() < MAX_PREVIEW_RECORDS { return Ok(()); }
    let mut terminal = Vec::new();
    for id in ids {
        let Some(state) = read_json(&preview_dir(home, &id)?.join("state.json"), 16 * 1024)? else { continue; };
        if matches!(state.get("status").and_then(Value::as_str), Some("finished" | "error")) {
            terminal.push((state.get("updatedAtMs").and_then(Value::as_u64).unwrap_or(0), id));
        }
    }
    terminal.sort();
    for (_, id) in terminal {
        std::fs::remove_dir_all(preview_dir(home, &id)?).map_err(|_| "code_game_state_unavailable".to_string())?;
        crate::city_runtime::forget_preview_clock(home, &id);
        crate::city_runtime::forget_story_fork(home, &id);
        if preview_ids(home)?.len() < MAX_PREVIEW_RECORDS { return Ok(()); }
    }
    Err("game_activity_busy".to_string())
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
    let preview_id = match state.get("previewId") {
        None | Some(Value::Null) => None,
        Some(_) => Some(bounded(state, "previewId", MAX_ID).filter(|id| valid_preview_id(id))
            .ok_or_else(|| "code_game_state_invalid: invalid previewId".to_string())?),
    };
    let record = json!({
        "status": status,
        "gameId": bounded(state, "gameId", MAX_ID),
        "previewId": preview_id,
        "buildId": bounded(state, "buildId", 64),
        "runId": bounded(state, "runId", 64),
        "reason": bounded(state, "reason", MAX_REASON),
        "outcome": bounded(state, "outcome", 16),
        "tick": bounded_count(state, "tick", MAX_TICK),
        "entities": bounded_count(state, "entities", MAX_ENTITIES),
        "updatedAtMs": now_ms(),
    });
    let _guard = preview_io_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = code_games_root(home);
    std::fs::create_dir_all(&root).map_err(|error| format!("code_game_state_unavailable: {error}"))?;
    if let Some(preview_id) = preview_id {
        let directory = preview_dir(home, &preview_id)?;
        std::fs::create_dir_all(&directory).map_err(|_| "code_game_state_unavailable".to_string())?;
        write_json_atomic(&directory.join("state.json"), &record)?;
        if matches!(status, "finished" | "error") {
            std::fs::remove_file(directory.join("control.json")).ok();
            crate::city_runtime::forget_preview_clock(home, &preview_id);
            crate::city_runtime::forget_story_fork(home, &preview_id);
        }
    } else if matches!(status, "finished" | "error") {
        std::fs::remove_file(root.join("preview-control.json")).ok();
    }
    write_json_atomic(&root.join("preview.json"), &record)?;
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

pub(crate) fn sealed_build_manifest(home: &Path, build_id: &str) -> Result<Value, &'static str> {
    load_sealed_preview(home, build_id).map(|(manifest, _, _)| manifest).map_err(|_| "game_package_integrity_failed")
}

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

fn migrate_legacy_preview_request(home: &Path) -> Result<(), String> {
    let legacy_path = code_games_root(home).join("preview-request.json");
    let Some(mut request) = read_json(&legacy_path, MAX_PREVIEW_REQUEST_BYTES)? else { return Ok(()); };
    if request.get("status").and_then(Value::as_str) != Some("queued") { return Ok(()); }
    let preview_id = match request.get("previewId") {
        None | Some(Value::Null) => new_id("preview-").map_err(|_| "code_game_state_unavailable".to_string())?,
        Some(_) => request_string(&request, "previewId", MAX_ID)?,
    };
    if !valid_preview_id(&preview_id) { return Err("code_game_preview_request_invalid".to_string()); }
    request["previewId"] = json!(preview_id);
    if request.get("source").is_none() {
        request["source"] = json!({"cityId":"city:preview-fixture","seed":7,"synthetic":true});
    }
    let directory = preview_dir(home, &preview_id)?;
    if directory.join("request.json").exists() {
        std::fs::remove_file(legacy_path).map_err(|_| "code_game_state_unavailable".to_string())?;
        return Ok(());
    }
    write_json_atomic(&legacy_path, &request)?;
    ensure_preview_capacity(home)?;
    std::fs::create_dir_all(&directory).map_err(|_| "code_game_state_unavailable".to_string())?;
    write_json_atomic(&directory.join("request.json"), &request)?;
    std::fs::remove_file(legacy_path).map_err(|_| "code_game_state_unavailable".to_string())?;
    Ok(())
}

fn terminal_preview_state(home: &Path, preview_id: &str) -> Result<bool, String> {
    let path = preview_dir(home, preview_id)?.join("state.json");
    Ok(read_json(&path, 16 * 1024)?.is_some_and(|state|
        matches!(state.get("status").and_then(Value::as_str), Some("finished" | "error"))))
}

pub(crate) fn request_preview_window(home: &Path, now: u64) -> Result<Option<Value>, &'static str> {
    let _guard = preview_io_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    migrate_legacy_preview_request(home).map_err(|_| "code_game_preview_request_invalid")?;
    let mut candidates = Vec::new();
    for preview_id in preview_ids(home).map_err(|_| "code_game_state_unavailable")? {
        let path = preview_dir(home, &preview_id).map_err(|_| "code_game_preview_request_invalid")?.join("request.json");
        let Some(mut request) = read_json(&path, MAX_PREVIEW_REQUEST_BYTES).map_err(|_| "code_game_preview_request_invalid")? else { continue; };
        if request.get("source").is_none() {
            request["source"] = json!({"cityId":"city:preview-fixture","seed":7,"synthetic":true});
        }
        if request.get("status").and_then(Value::as_str) != Some("queued")
            || terminal_preview_state(home, &preview_id).map_err(|_| "code_game_state_unavailable")? { continue; }
        let last = request.get("previewWindowRequestedAtMs").and_then(Value::as_u64).unwrap_or(0);
        if last != 0 && now.saturating_sub(last) < PREVIEW_WINDOW_RETRY_MS { continue; }
        let created = request.get("createdAtMs").and_then(Value::as_u64).unwrap_or(0);
        candidates.push((created, preview_id, request, path));
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let Some((_, _, mut request, path)) = candidates.into_iter().next() else { return Ok(None); };
    request["previewWindowRequestedAtMs"] = json!(now);
    write_json_atomic(&path, &request).map_err(|_| "code_game_state_unavailable")?;
    Ok(Some(request))
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

fn take_control_at(path: &Path, preview_id: &str, legacy: bool) -> Result<Option<Value>, String> {
    let Some(request) = read_json(path, MAX_PREVIEW_REQUEST_BYTES)? else { return Ok(None); };
    if request.get("status").and_then(Value::as_str) != Some("stop_requested") { return Ok(None); }
    if legacy && request.get("previewId").and_then(Value::as_str) != Some(preview_id) { return Ok(None); }
    let build_id = request_string(&request, "buildId", 64)?;
    let run_id = request_string(&request, "runId", 64)?;
    let request_preview_id = request_string(&request, "previewId", MAX_ID)?;
    if request_preview_id != preview_id { return Err("code_game_preview_request_invalid".to_string()); }
    request_string(&request, "requestId", 128)?;
    std::fs::remove_file(path).map_err(|_| "code_game_state_unavailable".to_string())?;
    Ok(Some(json!({"control":"stop","previewId":preview_id,"buildId":build_id,"runId":run_id})))
}

fn take_preview_control(home: &Path, preview_id: &str) -> Result<Option<Value>, String> {
    let path = preview_dir(home, preview_id)?.join("control.json");
    if let Some(control) = take_control_at(&path, preview_id, false)? { return Ok(Some(control)); }
    take_control_at(&code_games_root(home).join("preview-control.json"), preview_id, true)
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
    if !valid_preview_id(city_instance) { return Err("game_argument_invalid".to_string()); }
    let _guard = preview_io_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    migrate_legacy_preview_request(home)?;
    if let Some(control) = take_preview_control(home, city_instance)? { return Ok(control); }
    let path = preview_dir(home, city_instance)?.join("request.json");
    let Some(request) = read_json(&path, MAX_PREVIEW_REQUEST_BYTES)? else { return Ok(Value::Null); };
    if request.get("status").and_then(Value::as_str) != Some("queued")
        || terminal_preview_state(home, city_instance)? { return Ok(Value::Null); }
    let request_id = request_string(&request, "requestId", 128)?;
    let build_id = request_string(&request, "buildId", 64)?;
    let seed = request.get("seed").and_then(Value::as_u64).ok_or_else(|| "code_game_preview_request_invalid".to_string())?;
    let preview_id = request_string(&request, "previewId", MAX_ID)?;
    if preview_id != city_instance { return Err("code_game_preview_request_invalid".to_string()); }
    let source = request.get("source").cloned().ok_or_else(|| "code_game_preview_request_invalid".to_string())?;
    let (manifest, bundle, assets) = load_sealed_preview(home, &build_id)?;
    let claimed = json!({"requestId":request_id,"previewId":preview_id,"buildId":build_id,"seed":seed,"source":source,"status":"claimed","claimedAtMs":now_ms()});
    write_json_atomic(&path, &claimed)?;
    let snapshot_id = new_id("code-preview-")?;
    let mut snapshots = preview_snapshots().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    snapshots.retain(|_, snapshot| snapshot.instance != city_instance);
    snapshots.insert(snapshot_id.clone(), PreviewSnapshot { instance: city_instance.to_string(), bundle, assets });
    drop(snapshots);
    Ok(json!({"requestId":request_id,"previewId":preview_id,"buildId":build_id,"seed":seed,"source":source,"manifest":manifest,"snapshotId":snapshot_id}))
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

pub(crate) fn studio_builds(home: &Path, limit: u64) -> Result<Value, &'static str> {
    let path = home.join("state/creator/code-games/index.json");
    let value = match std::fs::read(&path) {
        Ok(bytes) if bytes.len() <= 256 * 1024 => serde_json::from_slice::<Value>(&bytes).map_err(|_| "creator_store_unavailable")?,
        Ok(_) => return Err("creator_store_unavailable"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!([]),
        Err(_) => return Err("creator_store_unavailable"),
    };
    let rows = value.as_array().ok_or("creator_store_unavailable")?.iter().take(limit.min(50) as usize).map(|row| {
        Some(json!({"buildId":bounded(row,"buildId",64)?,"gameId":bounded(row,"gameId",128)?,
            "gameVersion":bounded(row,"gameVersion",32),"byteLength":row.get("byteLength").and_then(Value::as_u64),
            "createdAtMs":row.get("createdAtMs").and_then(Value::as_u64)}))
    }).collect::<Option<Vec<_>>>().ok_or("creator_store_unavailable")?;
    Ok(json!({"builds":rows}))
}

pub(crate) fn studio_preview(home: &Path, build_id: &str, seed: u64, source: Option<Value>) -> Result<Value, &'static str> {
    if build_id.len() != 64 || !build_id.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) { return Err("game_argument_invalid"); }
    load_sealed_preview(home, build_id).map_err(|_| "game_package_integrity_failed")?;
    let root = code_games_root(home);
    std::fs::create_dir_all(&root).map_err(|_| "creator_store_unavailable")?;
    let request_id = new_id("preview-request-")?;
    let preview_id = new_id("preview-")?;
    let request = json!({"requestId":request_id,"previewId":preview_id,"buildId":build_id,"seed":seed,
        "source":source.unwrap_or_else(|| json!({"cityId":"city:preview-fixture","seed":7,"synthetic":true})),"status":"queued","createdAtMs":now_ms()});
    let _guard = preview_io_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    ensure_preview_capacity(home).map_err(|_| "game_activity_busy")?;
    std::fs::create_dir_all(previews_root(home)).map_err(|_| "creator_store_unavailable")?;
    let directory = preview_dir(home, &preview_id).map_err(|_| "game_argument_invalid")?;
    std::fs::create_dir(&directory).map_err(|_| "creator_store_unavailable")?;
    write_json_atomic(&directory.join("request.json"), &request).map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"requestId":request_id,"previewId":preview_id,"buildId":build_id,"seed":seed,"status":"queued"}))
}

/// 旧接口兼容面（隔离 Spec §5.2）：只反映最近一个 Preview 的状态，必须带
/// `legacyScope=true`；按 previewId 精确查询走 [`studio_status_for`]。
pub(crate) fn studio_status(home: &Path) -> Result<Value, &'static str> {
    let path = home.join("state/creator/code-games/preview.json");
    let value = match std::fs::read(&path) {
        Ok(bytes) if bytes.len() <= 16 * 1024 => serde_json::from_slice::<Value>(&bytes).map_err(|_| "creator_store_unavailable")?,
        Ok(_) => return Err("creator_store_unavailable"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({"available":false,"status":"unavailable","legacyScope":true})),
        Err(_) => return Err("creator_store_unavailable"),
    };
    Ok(json!({"available":true,"legacyScope":true,"status":bounded(&value,"status",32),"gameId":bounded(&value,"gameId",128),
        "previewId":bounded(&value,"previewId",128),"buildId":bounded(&value,"buildId",64),"runId":bounded(&value,"runId",64),"reason":bounded(&value,"reason",120),
        "outcome":bounded(&value,"outcome",16),"tick":bounded_count(&value,"tick",MAX_TICK),
        "entities":bounded_count(&value,"entities",MAX_ENTITIES),"updatedAtMs":bounded_count(&value,"updatedAtMs",u64::MAX)}))
}

/// 按 previewId 的权威状态：读该 Preview 自己的 `state.json`，多 Preview
/// 并存时不互相覆盖。
pub(crate) fn studio_status_for(home: &Path, preview_id: &str) -> Result<Value, &'static str> {
    let path = match preview_dir(home, preview_id) {
        Ok(directory) => directory.join("state.json"),
        Err(_) => return Err("game_argument_invalid"),
    };
    let value = match read_json(&path, 16 * 1024).map_err(|_| "creator_store_unavailable")? {
        Some(value) => value,
        None => return Ok(json!({"available":false,"status":"unavailable","previewId":preview_id})),
    };
    Ok(json!({"available":true,"previewId":preview_id,"status":bounded(&value,"status",32),"gameId":bounded(&value,"gameId",128),
        "buildId":bounded(&value,"buildId",64),"runId":bounded(&value,"runId",64),"reason":bounded(&value,"reason",120),
        "outcome":bounded(&value,"outcome",16),"tick":bounded_count(&value,"tick",MAX_TICK),
        "entities":bounded_count(&value,"entities",MAX_ENTITIES),"updatedAtMs":bounded_count(&value,"updatedAtMs",u64::MAX)}))
}

pub(crate) fn studio_stop(home: &Path, preview_id: &str) -> Result<Value, &'static str> {
    let status = studio_status_for(home, preview_id)?;
    if !matches!(status.get("status").and_then(Value::as_str), Some("starting" | "running")) {
        return Err("game_run_not_found");
    }
    let directory = preview_dir(home, preview_id).map_err(|_| "game_argument_invalid")?;
    std::fs::create_dir_all(&directory).map_err(|_| "creator_store_unavailable")?;
    let request_id = new_id("preview-stop-")?;
    let request = json!({"requestId":request_id,"previewId":preview_id,"buildId":status["buildId"],"runId":status["runId"],"status":"stop_requested","createdAtMs":now_ms()});
    write_json_atomic(&directory.join("control.json"), &request).map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"requestId":request_id,"previewId":preview_id,"status":"stop_requested"}))
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
        let window_request = request_preview_window(&home, 2).unwrap().unwrap();
        assert_eq!(window_request["source"]["synthetic"], true);
        assert!(window_request["previewId"].as_str().unwrap().starts_with("preview-"));
        assert!(request_preview_window(&home, 3).unwrap().is_none());
        // 隔离契约（Spec §5.2）：请求被迁移到 previews/<previewId>/ 后，只能由
        // 持有该 previewId 的 Preview 窗口认领；其他实例（如主 City）读不到它。
        let migrated_id = window_request["previewId"].as_str().unwrap().to_string();
        assert_eq!(next_preview(&home, "city-test").unwrap(), Value::Null);
        let loaded = next_preview(&home, &migrated_id).unwrap();
        assert_eq!(loaded["manifest"]["gameId"], "test.preview");
        let read = read_preview(&migrated_id, &json!({"snapshotId":loaded["snapshotId"],"path":"game.js","offset":0})).unwrap();
        assert_eq!(BASE64.decode(read["contentBase64"].as_str().unwrap()).unwrap(), bundle);
        assert_eq!(read["complete"], true);
        let asset_first = read_preview(&migrated_id, &json!({"snapshotId":loaded["snapshotId"],"path":"asset:cube","offset":0})).unwrap();
        let asset_second = read_preview(&migrated_id, &json!({"snapshotId":loaded["snapshotId"],"path":"asset:cube","offset":512 * 1024})).unwrap();
        assert_eq!(asset_first["complete"], false);
        assert_eq!(asset_second["complete"], true);
        assert_eq!(BASE64.decode(asset_first["contentBase64"].as_str().unwrap()).unwrap().len() + BASE64.decode(asset_second["contentBase64"].as_str().unwrap()).unwrap().len(), asset_bytes.len());
        close_preview(&migrated_id, &json!({"snapshotId":loaded["snapshotId"]})).unwrap();
        assert_eq!(read_preview(&migrated_id, &json!({"snapshotId":loaded["snapshotId"],"path":"game.js","offset":0})).unwrap_err(), "content_snapshot_expired");
        assert_eq!(next_preview(&home, &migrated_id).unwrap(), Value::Null);
        std::fs::write(request_dir.join("index.json"), serde_json::to_vec(&json!([record])).unwrap()).unwrap();
        let studio = "studio-test";
        let listed = crate::creator_projects::dispatch_as(&home, "local-creator", studio, "creator.code.builds.list", &json!({"limit":20})).unwrap();
        assert_eq!(listed["builds"].as_array().unwrap().len(), 1);
        let queued = crate::creator_projects::dispatch_as(&home, "local-creator", studio, "creator.code.preview", &json!({"buildId":actual_id,"seed":7})).unwrap();
        assert_eq!(queued["status"], "queued");
        let queued_id = queued["previewId"].as_str().unwrap().to_string();
        let claimed = next_preview(&home, &queued_id).unwrap();
        close_preview(&queued_id, &json!({"snapshotId":claimed["snapshotId"]})).unwrap();
        record_preview_state(&home, &json!({"status":"running","previewId":queued_id,"gameId":"test.preview","buildId":actual_id,"runId":"run-7","tick":1,"entities":1})).unwrap();
        let stopped = crate::creator_projects::dispatch_as(&home, "local-creator", studio, "creator.code.preview.stop", &json!({"previewId":queued_id})).unwrap();
        assert_eq!(stopped["status"], "stop_requested");
        let preview_dir = request_dir.join("previews").join(&queued_id);
        assert!(preview_dir.join("control.json").exists());
        // 认领即取走控制文件；终态后控制文件不得残留。
        assert_eq!(next_preview(&home, &queued_id).unwrap()["control"], "stop");
        assert!(!preview_dir.join("control.json").exists());
        record_preview_state(&home, &json!({"status":"finished","previewId":queued_id,"gameId":"test.preview","buildId":actual_id,"runId":"run-7","outcome":"success","tick":1,"entities":0})).unwrap();
        std::fs::write(request_dir.join("preview-request.json"), serde_json::to_vec(&request).unwrap()).unwrap();
        std::fs::write(root.join("game.js"), b"export default { tampered: true }").unwrap();
        let tampered = request_preview_window(&home, 4).unwrap().unwrap();
        let tampered_id = tampered["previewId"].as_str().unwrap().to_string();
        assert_eq!(next_preview(&home, &tampered_id).unwrap_err(), "game_package_integrity_failed");
        // 显式来源（Spec §4.1.3）：请求必须原样进入队列；形状不合法被拒绝。
        std::fs::write(root.join("game.js"), bundle).unwrap();
        let with_source = crate::creator_projects::dispatch_as(&home, "local-creator", studio, "creator.code.preview",
            &json!({"buildId":actual_id,"seed":7,"source":{"cityId":"city:one","cityRevision":3}})).unwrap();
        let second_source = crate::creator_projects::dispatch_as(&home, "local-creator", studio, "creator.code.preview",
            &json!({"buildId":actual_id,"seed":8,"source":{"cityId":"city:two","cityRevision":4}})).unwrap();
        assert_eq!(with_source["status"], "queued");
        assert_ne!(with_source["previewId"], second_source["previewId"]);
        assert!(!request_dir.join("preview-request.json").exists());
        let first_window = request_preview_window(&home, 5).unwrap().unwrap();
        let second_window = request_preview_window(&home, 6).unwrap().unwrap();
        let mut queued_ids = [first_window["previewId"].clone(), second_window["previewId"].clone()];
        queued_ids.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
        let mut expected_ids = [with_source["previewId"].clone(), second_source["previewId"].clone()];
        expected_ids.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
        assert_eq!(queued_ids, expected_ids);
        let first_source = if first_window["previewId"] == with_source["previewId"] { &first_window } else { &second_window };
        assert_eq!(first_source["source"]["cityId"], "city:one");
        assert_eq!(first_source["source"]["cityRevision"], 3);
        assert_eq!(first_source["source"].get("synthetic"), None);
        assert_eq!(crate::creator_projects::dispatch_as(&home, "local-creator", studio, "creator.code.preview",
            &json!({"buildId":actual_id,"seed":7,"source":{"cityId":"city:one"}})).unwrap_err(), "creator_request_invalid");
        assert_eq!(crate::creator_projects::dispatch_as(&home, "local-creator", studio, "creator.code.preview",
            &json!({"buildId":actual_id,"seed":7,"source":{"cityId":"city:one","cityRevision":-1}})).unwrap_err(), "creator_request_invalid");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn queued_window_request_defaults_to_an_explicit_synthetic_source() {
        let home = std::env::temp_dir().join(format!("code-game-source-default-{}-{}", now_ms(), std::process::id()));
        let preview_id = "preview-source-default";
        let directory = previews_root(&home).join(preview_id);
        std::fs::create_dir_all(&directory).unwrap();
        write_json_atomic(&directory.join("request.json"), &json!({"requestId":"request-1","previewId":preview_id,
            "buildId":"a".repeat(64),"seed":7,"status":"queued","createdAtMs":1})).unwrap();
        let request = request_preview_window(&home, 2).unwrap().unwrap();
        assert_eq!(request["source"]["cityId"], "city:preview-fixture");
        assert_eq!(request["source"]["synthetic"], true);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn preview_stop_targets_its_own_preview_while_another_stays_running() {
        let home = std::env::temp_dir().join(format!("code-game-stop-isolation-{}-{}", now_ms(), std::process::id()));
        let older = "preview-stop-older";
        let newer = "preview-stop-newer";
        record_preview_state(&home, &json!({"status":"running","previewId":older,"gameId":"game.a","buildId":"a","runId":"run-a","tick":1,"entities":1})).unwrap();
        record_preview_state(&home, &json!({"status":"running","previewId":newer,"gameId":"game.b","buildId":"b","runId":"run-b","tick":2,"entities":1})).unwrap();
        // 旧接口只反映最近状态并显式标记 legacyScope；新接口按 previewId 精确读取。
        let legacy = studio_status(&home).unwrap();
        assert_eq!(legacy["legacyScope"], true);
        assert_eq!(legacy["previewId"], newer);
        let older_status = studio_status_for(&home, older).unwrap();
        assert_eq!(older_status["available"], true);
        assert_eq!(older_status["runId"], "run-a");
        let stopped = studio_stop(&home, older).unwrap();
        assert_eq!(stopped["status"], "stop_requested");
        let control = read_json(&preview_dir(&home, older).unwrap().join("control.json"), MAX_PREVIEW_REQUEST_BYTES).unwrap().unwrap();
        assert_eq!(control["runId"], "run-a");
        assert!(!preview_dir(&home, newer).unwrap().join("control.json").exists());
        // 停止 newer 也不串扰：控制文件落在它自己的目录，指向自己的 run。
        assert_eq!(studio_stop(&home, newer).unwrap()["status"], "stop_requested");
        let newer_control = read_json(&preview_dir(&home, newer).unwrap().join("control.json"), MAX_PREVIEW_REQUEST_BYTES).unwrap().unwrap();
        assert_eq!(newer_control["runId"], "run-b");
        assert_eq!(studio_stop(&home, "preview-unknown").unwrap_err(), "game_run_not_found");
        assert_eq!(studio_stop(&home, "bad id!").unwrap_err(), "game_argument_invalid");
        std::fs::remove_dir_all(home).ok();
    }
}
