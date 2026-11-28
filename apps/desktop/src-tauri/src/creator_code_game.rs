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

pub(crate) fn active_previews_for_city(home: &Path, city_id: &str) -> Result<Vec<Value>, String> {
    let mut active = Vec::new();
    for preview_id in preview_ids(home)? {
        let directory = preview_dir(home, &preview_id)?;
        let Some(request) = read_json(&directory.join("request.json"), MAX_PREVIEW_REQUEST_BYTES)? else { continue; };
        let state = read_json(&directory.join("state.json"), 16 * 1024)?;
        let status = state.as_ref().and_then(|value| value.get("status")).or_else(|| request.get("status")).and_then(Value::as_str).unwrap_or("unknown");
        if !matches!(status, "queued" | "starting" | "running" | "stop_requested") { continue; }
        if request.get("source").and_then(|source| source.get("cityId")).and_then(Value::as_str) != Some(city_id) { continue; }
        active.push(json!({"runId":state.as_ref().and_then(|value| value.get("runId")).and_then(Value::as_str),
            "previewId":preview_id,"kind":"code-preview","status":status}));
    }
    Ok(active)
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
            // PR08：run 终态即终态化试玩会话（保结果可读）并撤销未消费的截图请求。
            finish_playtest_on_terminal(home, &preview_id);
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
    let Some(request) = read_json(&path, MAX_PREVIEW_REQUEST_BYTES)? else { return Ok(idle_preview_envelope(home, city_instance)); };
    if request.get("status").and_then(Value::as_str) != Some("queued")
        || terminal_preview_state(home, city_instance)? { return Ok(idle_preview_envelope(home, city_instance)); }
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

// ── PR05 City Snapshot Test（桌面臂）：CityWorldSnapshotV4 冻结缓存 + broker 服务 ──
// 快照只能由 live 渲染端确定（citySnapshot.ts::createCitySnapshotV4 需要 CityEngine
// 的地形采样器与生成器身份摘要，宿主不重算、绝不合成）：真实 City 的 Code 预览
// webview 经 code_preview_window 的 plugin_message 窄面 `city.snapshot.export` 上报
// 一份，宿主做三重身份绑定（preview 请求 source、权威 revision、header 自洽）后
// 原子落盘 `state/creator/code-games/city-snapshots/<cityId>-<cityRevision>.json`，
// 每城只保留最新 MAX_CITY_SNAPSHOT_REVISIONS 份。broker 方法
// `creator.code.test.city_snapshot`（creator-studio 描述符，headless 臂与 Studio
// 在场拦截同答一个 handler）从这里服务：先复核 creator_cities.revision，再校验
// 缓存 header 自洽。真正的密码学校验（validateCityWorldSnapshot +
// header.snapshotDigest 对照）在无头 runner 执行——宿主只做结构/身份一致性，
// 不重算 canonical digest。字节上限与 §5.5 描述符响应预算联动：broker 响应 =
// snapshotDigest + snapshotJson 信封，预算取描述符 localCallBudgets（1 MiB 平台
// 上限），信封开销另留 4 KiB 余量；超限快照在 store 侧就按 too_large 拒收。
const MAX_CITY_SNAPSHOT_BYTES: usize = (1024 * 1024) - (4 * 1024);
const MAX_CITY_SNAPSHOT_REVISIONS: usize = 2;

fn city_snapshots_root(home: &Path) -> PathBuf {
    code_games_root(home).join("city-snapshots")
}

/// `sha256:` + 64 位小写十六进制（CityWorldSnapshotV4 header.snapshotDigest 词表，
/// city-sdk digest.ts canonicalDigest 输出格式）。
fn valid_snapshot_digest(value: &str) -> bool {
    value.len() == 71 && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// V4 快照的 header 世界身份：schemaVersion、cityId/cityRevision 与 digest 词表
/// 必须自洽；返回声明的 snapshotDigest（供服务臂回显与 store 侧落盘记录）。
fn snapshot_header_identity(snapshot: &Value, city_id: &str, city_revision: u64) -> Result<String, &'static str> {
    if snapshot.get("schemaVersion").and_then(Value::as_u64) != Some(4) { return Err("creator_city_snapshot_invalid"); }
    let header = snapshot.get("header").ok_or("creator_city_snapshot_invalid")?;
    if header.get("cityId").and_then(Value::as_str) != Some(city_id)
        || header.get("cityRevision").and_then(Value::as_u64) != Some(city_revision) {
        return Err("creator_city_snapshot_invalid");
    }
    let digest = header.get("snapshotDigest").and_then(Value::as_str).ok_or("creator_city_snapshot_invalid")?;
    if !valid_snapshot_digest(digest) { return Err("creator_city_snapshot_invalid"); }
    Ok(digest.to_owned())
}

/// 权威 revision 复核：creator_cities.revision 是唯一权威（MCP 侧同表先行复核，
/// broker 到达后这里独立复核，两侧同源不互信）。城市缺失与不可用是不同失败。
fn authoritative_city_revision(home: &Path, city_id: &str) -> Result<u64, &'static str> {
    use rusqlite::OptionalExtension;
    if !crate::creator_store::valid_id(city_id) { return Err("creator_city_invalid"); }
    let db = crate::creator_store::database(home)?;
    db.query_row("SELECT revision FROM creator_cities WHERE city_id=?1", [city_id], |row| row.get::<_, i64>(0))
        .optional().map_err(|_| "creator_store_unavailable")?
        .ok_or("creator_city_not_found")
        .and_then(|revision| u64::try_from(revision).map_err(|_| "creator_store_corrupt"))
}

/// 预览 webview 的快照上报唯一入口（code_preview_window plugin_message 窄面）：
/// 入参就是渲染端序列化的快照 JSON 字符串。先在字符串层执行预算，再解析并做
/// 三重绑定；同一 (cityId, revision) 的缓存可被同身份重复导出覆盖（tmp+rename
/// 原子发布），过期 revision 拒收（缓存只服务当前权威）。
pub(crate) fn store_city_test_snapshot(home: &Path, preview_id: &str, snapshot_json: &str) -> Result<Value, &'static str> {
    if !valid_preview_id(preview_id) { return Err("code_game_preview_request_invalid"); }
    // 入口预算（渲染端发紧凑序列化）：超限在解析前就按 too_large 拒收，权威上限
    // 仍是落盘前的 canonical 字节数。
    if snapshot_json.is_empty() || snapshot_json.len() > MAX_CITY_SNAPSHOT_BYTES { return Err("creator_city_snapshot_too_large"); }
    let snapshot: Value = serde_json::from_str(snapshot_json).map_err(|_| "creator_city_snapshot_invalid")?;
    let header = snapshot.get("header").ok_or("creator_city_snapshot_invalid")?;
    let city_id = header.get("cityId").and_then(Value::as_str)
        .filter(|value| crate::creator_store::valid_id(value)).ok_or("creator_city_snapshot_invalid")?;
    let city_revision = header.get("cityRevision").and_then(Value::as_u64)
        .filter(|revision| *revision <= i64::MAX as u64).ok_or("creator_city_snapshot_invalid")?;
    let current = authoritative_city_revision(home, city_id)?;
    if current != city_revision { return Err("creator_city_revision_stale"); }
    // preview 绑定：快照必须来自装载这座 City 的这个预览；synthetic 预览没有权威
    // 世界（宿主无法离线重算 terrain），显式拒绝。
    let request = read_json(&preview_dir(home, preview_id).map_err(|_| "code_game_state_unavailable")?.join("request.json"), MAX_PREVIEW_REQUEST_BYTES)
        .map_err(|_| "code_game_state_unavailable")?
        .ok_or("code_game_preview_request_invalid")?;
    let source = request.get("source").ok_or("code_game_preview_request_invalid")?;
    if source.get("synthetic").and_then(Value::as_bool) == Some(true)
        || source.get("cityId").and_then(Value::as_str) != Some(city_id)
        || source.get("cityRevision").and_then(Value::as_u64).is_some_and(|revision| revision != city_revision) {
        return Err("creator_city_snapshot_source_mismatch");
    }
    let digest = snapshot_header_identity(&snapshot, city_id, city_revision)?;
    let bytes = canonical_json(&snapshot).map_err(|_| "creator_city_snapshot_invalid")?;
    if bytes.len() > MAX_CITY_SNAPSHOT_BYTES { return Err("creator_city_snapshot_too_large"); }
    let _guard = preview_io_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = city_snapshots_root(home);
    std::fs::create_dir_all(&root).map_err(|_| "code_game_state_unavailable")?;
    // cityId 已过宿主词表（无路径分隔符），revision 是 u64：目标恒为单一安全组件。
    let target = root.join(format!("{city_id}-{city_revision}.json"));
    let temporary = root.join(format!("{city_id}-{city_revision}.json.tmp"));
    std::fs::write(&temporary, bytes.as_bytes()).map_err(|_| "code_game_state_unavailable")?;
    if std::fs::rename(&temporary, &target).is_err() {
        std::fs::remove_file(&temporary).ok();
        return Err("code_game_state_unavailable");
    }
    prune_city_snapshots(home, city_id).map_err(|_| "code_game_state_unavailable")?;
    Ok(json!({"stored":true,"cityId":city_id,"cityRevision":city_revision,"snapshotDigest":digest}))
}

/// 每城只保留最新 MAX_CITY_SNAPSHOT_REVISIONS 份（按 revision 排序修剪），给磁盘
/// 一个确定的界；其他 City 的文件不受影响。
fn prune_city_snapshots(home: &Path, city_id: &str) -> Result<(), String> {
    let prefix = format!("{city_id}-");
    let mut revisions: Vec<(u64, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(city_snapshots_root(home)).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&prefix) || !name.ends_with(".json") { continue; }
        // get() 而非切片：外来文件名可能非 ASCII 边界，parse 失败即忽略。
        if let Some(revision_text) = name.get(prefix.len()..name.len().saturating_sub(5)) {
            if let Ok(revision) = revision_text.parse::<u64>() {
                revisions.push((revision, entry.path()));
            }
        }
    }
    revisions.sort();
    while revisions.len() > MAX_CITY_SNAPSHOT_REVISIONS {
        let (_, path) = revisions.remove(0);
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// broker `creator.code.test.city_snapshot` 服务臂（creator-studio 描述符）：权威
/// revision 复核 → 缓存读取 → header 自洽校验 → `{snapshotDigest, snapshotJson}`。
/// 缓存缺席（City 还没在 Studio 里开过 Code 预览、渲染端无从物化快照）按
/// `creator_city_snapshot_not_cached` 结构化失败，绝不回退合成世界。
pub(crate) fn city_test_snapshot(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let city_id = payload.get("cityId").and_then(Value::as_str)
        .filter(|value| crate::creator_store::valid_id(value)).ok_or("creator_request_invalid")?;
    let city_revision = payload.get("cityRevision").and_then(Value::as_u64)
        .filter(|revision| *revision <= i64::MAX as u64).ok_or("creator_request_invalid")?;
    let current = authoritative_city_revision(home, city_id)?;
    if current != city_revision { return Err("creator_city_revision_stale"); }
    let path = city_snapshots_root(home).join(format!("{city_id}-{city_revision}.json"));
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err("creator_city_snapshot_not_cached"),
        Err(_) => return Err("code_game_state_unavailable"),
    };
    if bytes.len() > MAX_CITY_SNAPSHOT_BYTES { return Err("creator_city_snapshot_invalid"); }
    let snapshot: Value = serde_json::from_slice(&bytes).map_err(|_| "creator_city_snapshot_invalid")?;
    let digest = snapshot_header_identity(&snapshot, city_id, city_revision)?;
    // bytes 刚被 serde_json::from_slice 成功解析，必为 UTF-8；照原字节回执（MCP
    // 按同一字符串暂存给 runner）。
    let snapshot_json = String::from_utf8(bytes).map_err(|_| "creator_city_snapshot_invalid")?;
    Ok(json!({"snapshotDigest":digest,"snapshotJson":snapshot_json}))
}

/// PR06 无头测试记录的宿主读面（creator.task.preview.verify 家族同模式）：
/// UI 经 creator.* 行表读取，与 MCP 的 `creator_code_test_record` 读同一份
/// `state/creator/code-games/tests/<buildId>.json`，内容逐字透传（写入侧已保证
/// 原子性与上限）；字段级解释由 UI 的 fail-closed 解析器负责，缺记录是明确缺席。
pub(crate) fn code_test_record(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let build_id = payload.get("buildId").and_then(Value::as_str)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        .ok_or("game_argument_invalid")?;
    let path = code_games_root(home).join("tests").join(format!("{build_id}.json"));
    let bytes = match std::fs::read(&path) {
        Ok(bytes) if bytes.len() <= 64 * 1024 => bytes,
        Ok(_) => return Err("creator_store_unavailable"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err("creator_code_test_record_not_found"),
        Err(_) => return Err("creator_store_unavailable"),
    };
    serde_json::from_slice::<Value>(&bytes).map_err(|_| "creator_store_unavailable")
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
            "gameVersion":bounded(row,"gameVersion",32),"displayName":bounded(row,"displayName",320).filter(|name| name.chars().count() <= 80),
            "byteLength":row.get("byteLength").and_then(Value::as_u64),
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
/// 并存时不互相覆盖。PR08：会话存在时附加 `playtest` 投影（预算/最近接受
/// 时刻/最近错误）——只是同一目录下 playtest.json 的补缺，不是新状态系统。
pub(crate) fn studio_status_for(home: &Path, preview_id: &str) -> Result<Value, &'static str> {
    let path = match preview_dir(home, preview_id) {
        Ok(directory) => directory.join("state.json"),
        Err(_) => return Err("game_argument_invalid"),
    };
    let value = match read_json(&path, 16 * 1024).map_err(|_| "creator_store_unavailable")? {
        Some(value) => value,
        None => return Ok(json!({"available":false,"status":"unavailable","previewId":preview_id})),
    };
    let mut status = json!({"available":true,"previewId":preview_id,"status":bounded(&value,"status",32),"gameId":bounded(&value,"gameId",128),
        "buildId":bounded(&value,"buildId",64),"runId":bounded(&value,"runId",64),"reason":bounded(&value,"reason",120),
        "outcome":bounded(&value,"outcome",16),"tick":bounded_count(&value,"tick",MAX_TICK),
        "entities":bounded_count(&value,"entities",MAX_ENTITIES),"updatedAtMs":bounded_count(&value,"updatedAtMs",u64::MAX)});
    if let Some(playtest) = playtest_status_projection(home, preview_id) {
        status["playtest"] = playtest;
    }
    Ok(status)
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

// ── PR08 自动化视觉试玩（Automated Visual Playtest）────────────────
// 隔离 preview 窗口的有界输入注入 + 渲染证据截图。会话状态落在每个 Preview
// 自己的目录（`playtest.json` / `capture-request.json` / `screenshot.json`），
// MCP 与宿主共用同一份文件面：MCP 侧按 creator_code_workspace::stage_preview
// 的既有先例直接做有界写入（不占用 creator-studio 邮箱，Studio 在场与否都
// 可用），宿主在 `city.code.preview.next` 的既有 pull 轮询里消费队列——与
// stop control 完全同通道，不新增 host→webview 通道。所有上限都是常量：
// Agent 不能要求更长/更大的会话；动作词表是封闭形状（1..=8 键、键 1..64 个
// [A-Za-z0-9_.-]、值 bool 或 |v|≤1e6 的有限数），经由宿主侧 setInput 归一化
// 后由游戏 ctx.input.actions() 读取。截图是**渲染证据**：只有像素，几何/
// 物理断言仍然只能来自 code-game.state 观测（tick/entities）与宿主运行时。
// 本模块的报告永不自动断言“passed”——结论留给 PR06 的场景机制。会话是
// 顺序的：预算耗尽/超时/stop 终态化后允许开新会话（每段各有完整上限），
// 单 Preview 任一时刻只有一个活跃会话。
const MAX_PLAYTEST_ACTIONS: u64 = 64;
const MAX_PLAYTEST_WINDOW_MS: u64 = 120_000;
const MAX_PLAYTEST_BATCH_KEYS: usize = 8;
const MAX_PLAYTEST_BATCHES: usize = 4;
const MAX_PLAYTEST_HOLD_MS: u64 = 5_000;
const MAX_PLAYTEST_STEPS: usize = 64;
const MAX_PLAYTEST_INPUT_VALUE: f64 = 1_000_000.0;
/// 与 MCP 捕获面同一数据Url 预算（creator_studio::MAX_CAPTURE_ENCODED_CHARS 同数）。
const MAX_PLAYTEST_SCREENSHOT_CHARS: usize = 350_000;
const MAX_PLAYTEST_SCREENSHOT_FILE: usize = 512 * 1024;

fn playtest_path(home: &Path, preview_id: &str) -> Result<PathBuf, String> {
    Ok(preview_dir(home, preview_id)?.join("playtest.json"))
}

fn playtest_session_is_active(session: &Value) -> bool {
    session.get("status").and_then(Value::as_str) == Some("active")
}

/// 动作词表（封闭形状）：对象、1..=MAX_PLAYTEST_BATCH_KEYS 个键、键为
/// 1..64 个 [A-Za-z0-9_.-]、值为 bool 或有限数（|v| ≤ 1e6）。返回归一化后的
/// (keys, count)，宿主落盘与 serve 双侧共用同一判定。
fn validate_playtest_actions(actions: &Value) -> Result<(Vec<String>, usize), String> {
    let object = actions.as_object().ok_or("playtest_invalid_actions")?;
    if object.is_empty() || object.len() > MAX_PLAYTEST_BATCH_KEYS { return Err("playtest_invalid_actions".into()); }
    let mut keys = Vec::with_capacity(object.len());
    for (key, value) in object {
        let valid_key = !key.is_empty() && key.len() <= 64
            && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'));
        let valid_value = match value {
            Value::Bool(_) => true,
            Value::Number(number) => number.as_f64().is_some_and(|raw| raw.is_finite() && raw.abs() <= MAX_PLAYTEST_INPUT_VALUE),
            _ => false,
        };
        if !valid_key || !valid_value { return Err("playtest_invalid_actions".into()); }
        keys.push(key.clone());
    }
    Ok((keys, object.len()))
}

/// MCP 直写面同款校验（creator_code_playtest.rs 镜像同一规则）：预览必须存在
/// 且 run 处于 starting/running；会话终态或过期则开新会话；预算/窗口上限在
/// 这里收口。返回回执（sessionId/seq/预算状态）。
///
/// PR08 注：当前生产写路径是 MCP 侧直写会话文件（creator_code_playtest.rs 自带
/// 同款校验），serve 路径读取时再独立校验动作词表——本函数是同一文件契约的宿主
/// 侧参考实现，仅由测试调用（钉住预算/队列/回执语义），供未来宿主内写路径复用。
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn playtest_input(home: &Path, preview_id: &str, actions: &Value, hold_ms: Option<u64>, now: u64) -> Result<Value, String> {
    let (_keys, count) = validate_playtest_actions(actions)?;
    let hold = hold_ms.unwrap_or(0);
    if hold > MAX_PLAYTEST_HOLD_MS { return Err("playtest_invalid_actions".into()); }
    let state = studio_status_for(home, preview_id).map_err(|code| code.to_string())?;
    if !matches!(state.get("status").and_then(Value::as_str), Some("starting" | "running")) {
        return Err("game_run_not_found".into());
    }
    let _guard = preview_io_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = playtest_path(home, preview_id)?;
    let mut session = read_json(&path, 256 * 1024)?.unwrap_or_else(|| json!({}));
    let expired = session.get("expiresAtMs").and_then(Value::as_u64).is_some_and(|expiry| now >= expiry);
    if !session.is_object() || !playtest_session_is_active(&session) || expired { session = json!({}); }
    let object = session.as_object_mut().ok_or_else(|| "code_game_state_unavailable".to_string())?;
    let new_session = !object.contains_key("sessionId");
    if new_session {
        object.clear();
        let request = read_json(&preview_dir(home, preview_id)?.join("request.json"), MAX_PREVIEW_REQUEST_BYTES)?
            .ok_or_else(|| "code_game_preview_request_invalid".to_string())?;
        let source = request.get("source").cloned().unwrap_or_else(|| json!({}));
        object.insert("sessionId".into(), json!(new_id("playtest-")?));
        object.insert("status".into(), json!("active"));
        object.insert("previewId".into(), json!(preview_id));
        object.insert("buildId".into(), request.get("buildId").cloned().unwrap_or(Value::Null));
        object.insert("cityId".into(), source.get("cityId").cloned().unwrap_or(Value::Null));
        object.insert("cityRevision".into(), source.get("cityRevision").cloned().unwrap_or(Value::Null));
        object.insert("startedAtMs".into(), json!(now));
        object.insert("expiresAtMs".into(), json!(now.saturating_add(MAX_PLAYTEST_WINDOW_MS)));
        object.insert("maxActions".into(), json!(MAX_PLAYTEST_ACTIONS));
        object.insert("acceptedActions".into(), json!(0));
        object.insert("deliveredBatches".into(), json!(0));
        object.insert("lastInputAcceptedAtMs".into(), Value::Null);
        object.insert("lastError".into(), Value::Null);
        object.insert("pending".into(), json!([]));
        object.insert("steps".into(), json!([]));
        // 步骤序列号是会话内单调递增计数器（steps 超过 MAX_PLAYTEST_STEPS 会
        // 从头部修剪，长度不能反推 seq），只能由显式计数器续接。
        object.insert("nextSeq".into(), json!(1));
    }
    let delivered = object.get("acceptedActions").and_then(Value::as_u64).unwrap_or(0);
    // 预算收口按 已投递 + 队列中 待投递 动作合计：入队不能绕过 64 动作上限。
    let pending_actions: u64 = object.get("pending").and_then(Value::as_array).map(|items| items.iter()
        .filter_map(|batch| batch.get("actions").and_then(Value::as_object).map(|actions| actions.len() as u64))
        .sum()).unwrap_or(0);
    if delivered.saturating_add(pending_actions).saturating_add(count as u64) > MAX_PLAYTEST_ACTIONS {
        return Err("playtest_budget_exhausted".into());
    }
    let pending_len = object.get("pending").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    if pending_len >= MAX_PLAYTEST_BATCHES { return Err("playtest_queue_full".into()); }
    let seq = object.get("nextSeq").and_then(Value::as_u64).unwrap_or(1);
    object.insert("nextSeq".into(), json!(seq + 1));
    {
        let pending = object.get_mut("pending").and_then(Value::as_array_mut).ok_or_else(|| "code_game_state_unavailable".to_string())?;
        pending.push(json!({"seq":seq,"actions":actions,"holdMs":hold}));
    }
    object.insert("updatedAtMs".into(), json!(now));
    write_json_atomic(&path, &Value::Object(object.clone()))?;
    Ok(json!({"sessionId":object["sessionId"],"seq":seq,"queued":true,"holdMs":hold,
        "budget":{"maxActions":MAX_PLAYTEST_ACTIONS,"acceptedActions":delivered,
            "expiresAtMs":object["expiresAtMs"],"queuedBatches":pending_len + 1}}))
}

/// MCP stop 面：终态化会话（清空 pending），下一次轮询由 serve 发出一次
/// playtest.end，渲染端释放仍按下的动作。无会话是幂等成功。
///
/// PR08 注：同 playtest_input——生产 stop 路径在 MCP 侧直写，本函数是同一
/// 契约的宿主侧参考实现，仅由测试调用。
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn playtest_stop(home: &Path, preview_id: &str, now: u64) -> Result<Value, String> {
    if !valid_preview_id(preview_id) { return Err("code_game_preview_request_invalid".into()); }
    let _guard = preview_io_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = playtest_path(home, preview_id)?;
    let Some(mut session) = read_json(&path, 256 * 1024)? else { return Ok(json!({"stopped":false,"reason":"no_session"})); };
    if !playtest_session_is_active(&session) { return Ok(json!({"stopped":false,"reason":"already_finished"})); }
    let object = session.as_object_mut().ok_or_else(|| "code_game_state_unavailable".to_string())?;
    object.insert("status".into(), json!("finished"));
    object.insert("reason".into(), json!("stopped"));
    object.insert("pending".into(), json!([]));
    object.insert("updatedAtMs".into(), json!(now));
    write_json_atomic(&path, &Value::Object(object.clone()))?;
    Ok(json!({"stopped":true,"sessionId":object["sessionId"].clone(),"reason":"stopped"}))
}

/// 终态清理：preview 进入 finished/error 时终止活跃会话（保结果可读）并撤销
/// 未消费的截图请求。record_preview_state 的终态分支与窗口销毁都会走到这里。
fn finish_playtest_on_terminal(home: &Path, preview_id: &str) {
    let Ok(path) = playtest_path(home, preview_id) else { return };
    let mut session = match read_json(&path, 256 * 1024) {
        Ok(Some(session)) => session,
        _ => return,
    };
    if playtest_session_is_active(&session) {
        if let Some(object) = session.as_object_mut() {
            object.insert("status".into(), json!("finished"));
            object.insert("reason".into(), json!("preview_closed"));
            object.insert("pending".into(), json!([]));
            object.insert("updatedAtMs".into(), json!(now_ms()));
        }
        write_json_atomic(&path, &session).ok();
    }
    if let Ok(directory) = preview_dir(home, preview_id) {
        std::fs::remove_file(directory.join("capture-request.json")).ok();
    }
}

/// 轮询空闲臂的入口：无 claim / 无 stop control 时，把试玩投递（终态通知 →
/// 截图请求 → 输入批次）并入既有 pull 通道，否则维持 Null（渲染端继续等待）。
fn idle_preview_envelope(home: &Path, preview_id: &str) -> Value {
    serve_preview_playtest(home, preview_id, now_ms()).unwrap_or(Value::Null)
}

/// 轮询空闲臂（city.code.preview.next 在无 claim/无 stop control 时）：按
/// 优先级投递 终态通知 → 截图请求 → 输入批次。所有失败路径都安静地退回
/// None——试玩投递绝不能打断 preview 生命周期轮询。
fn serve_preview_playtest(home: &Path, preview_id: &str, now: u64) -> Option<Value> {
    let path = playtest_path(home, preview_id).ok()?;
    let mut session = match read_json(&path, 256 * 1024) {
        Ok(Some(session)) => session,
        Ok(None) => return serve_preview_capture(home, preview_id),
        // 损坏/超限的会话文件 fail-closed：移除并继续轮询，绝不卡死预览。
        Err(_) => { std::fs::remove_file(&path).ok(); return serve_preview_capture(home, preview_id); }
    };
    let Some(object) = session.as_object_mut() else {
        std::fs::remove_file(&path).ok();
        return serve_preview_capture(home, preview_id);
    };
    let active = object.get("status").and_then(Value::as_str) == Some("active");
    if active {
        let expired = object.get("expiresAtMs").and_then(Value::as_u64).is_some_and(|expiry| now >= expiry);
        let delivered = object.get("acceptedActions").and_then(Value::as_u64).unwrap_or(0);
        if expired {
            object.insert("status".into(), json!("finished"));
            object.insert("reason".into(), json!("expired"));
        } else if delivered >= object.get("maxActions").and_then(Value::as_u64).unwrap_or(MAX_PLAYTEST_ACTIONS) {
            object.insert("status".into(), json!("finished"));
            object.insert("reason".into(), json!("budget"));
        }
    }
    // 终态通知只发一次：渲染端收到后释放仍按下的动作。
    if object.get("status").and_then(Value::as_str) != Some("active")
        && object.get("endNotified").and_then(Value::as_bool) != Some(true) {
        object.insert("endNotified".into(), json!(true));
        object.insert("pending".into(), json!([]));
        object.insert("updatedAtMs".into(), json!(now));
        let envelope = json!({"control":"playtest.end","previewId":preview_id,
            "sessionId":object.get("sessionId").cloned().unwrap_or(Value::Null),
            "reason":object.get("reason").cloned().unwrap_or(json!("finished"))});
        write_json_atomic(&path, &Value::Object(object.clone())).ok();
        return Some(envelope);
    }
    if object.get("status").and_then(Value::as_str) == Some("active")
        && object.get("pending").and_then(Value::as_array).is_some_and(|items| !items.is_empty()) {
        let batch = object.get_mut("pending").and_then(Value::as_array_mut)
            .and_then(|items| if items.is_empty() { None } else { Some(items.remove(0)) });
        if let Some(batch) = batch {
            let seq = batch.get("seq").and_then(Value::as_u64).unwrap_or(0);
            let actions = batch.get("actions").cloned().unwrap_or_else(|| json!({}));
            // 队列里的动作在 serve 时复验（文件可能被外部改写）：不合格的
            // 批次直接丢弃（批次已从内存队列移除，落盘即持久化丢弃）并继续，
            // 绝不下发越界动作。
            let validated = validate_playtest_actions(&actions);
            if let Ok((keys, count)) = validated {
                let delivered = object.get("acceptedActions").and_then(Value::as_u64).unwrap_or(0).saturating_add(count as u64);
                object.insert("acceptedActions".into(), json!(delivered));
                object.insert("deliveredBatches".into(), json!(object.get("deliveredBatches").and_then(Value::as_u64).unwrap_or(0) + 1));
                let observed = studio_status_for(home, preview_id).ok();
                let step = json!({"seq":seq,"keys":keys,"holdMs":batch.get("holdMs").cloned().unwrap_or(json!(0)),
                    "deliveredAtMs":now,
                    "tick":observed.as_ref().and_then(|state| state.get("tick")).cloned().unwrap_or(Value::Null),
                    "entities":observed.as_ref().and_then(|state| state.get("entities")).cloned().unwrap_or(Value::Null),
                    "ok":Value::Null,"ackAtMs":Value::Null,"errorCode":Value::Null});
                if let Some(steps) = object.get_mut("steps").and_then(Value::as_array_mut) {
                    steps.push(step);
                    if steps.len() > MAX_PLAYTEST_STEPS { let overflow = steps.len() - MAX_PLAYTEST_STEPS; steps.drain(0..overflow); }
                }
                object.insert("updatedAtMs".into(), json!(now));
                let envelope = json!({"control":"playtest.input","previewId":preview_id,
                    "sessionId":object.get("sessionId").cloned().unwrap_or(Value::Null),
                    "seq":seq,"actions":actions,"holdMs":batch.get("holdMs").cloned().unwrap_or(json!(0))});
                write_json_atomic(&path, &Value::Object(object.clone())).ok();
                return Some(envelope);
            }
            write_json_atomic(&path, &Value::Object(object.clone())).ok();
            return None;
        }
    }
    serve_preview_capture(home, preview_id)
}

/// 截图请求消费：MCP 直写 capture-request.json，宿主在轮询里取走并下发
/// playtest.capture 信封；渲染端回 playtest.screenshot 后落 screenshot.json。
/// 请求无论有效与否都取走（fail-closed 移除），坏请求绝不反复重投。
fn serve_preview_capture(home: &Path, preview_id: &str) -> Option<Value> {
    let path = preview_dir(home, preview_id).ok()?.join("capture-request.json");
    let request = match read_json(&path, 4_096) {
        Ok(Some(request)) => request,
        Ok(None) => return None,
        Err(_) => { std::fs::remove_file(&path).ok(); return None; }
    };
    std::fs::remove_file(&path).ok();
    let capture_id = request.get("captureId").and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128
            && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
        .map(ToString::to_string)?;
    Some(json!({"control":"playtest.capture","previewId":preview_id,"captureId":capture_id}))
}

/// 渲染端回执（plugin_message playtest.input.result）：按 sessionId+seq 记录
/// 应用结果；会话已被替换/终止时回执按未记录处理（陈旧回执不是伪造）。
pub(crate) fn record_playtest_ack(home: &Path, preview_id: &str, result: &Value) -> Result<bool, &'static str> {
    let session_id = result.get("sessionId").and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128).ok_or("playtest_input_result_invalid")?;
    let seq = result.get("seq").and_then(Value::as_u64).filter(|seq| *seq > 0).ok_or("playtest_input_result_invalid")?;
    let ok = result.get("ok").and_then(Value::as_bool).ok_or("playtest_input_result_invalid")?;
    let error_code = match result.get("errorCode") {
        None | Some(Value::Null) => None,
        Some(code) => Some(code.as_str().filter(|text| !text.is_empty() && text.len() <= 48
            && text.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'))
            .ok_or("playtest_input_result_invalid")?.to_owned()),
    };
    let _guard = preview_io_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = playtest_path(home, preview_id).map_err(|_| "code_game_preview_request_invalid")?;
    let Some(mut session) = read_json(&path, 256 * 1024).map_err(|_| "playtest_input_result_invalid")? else { return Ok(false) };
    let Some(object) = session.as_object_mut() else { return Ok(false) };
    if object.get("sessionId").and_then(Value::as_str) != Some(session_id) { return Ok(false); }
    let now = now_ms();
    for step in object.get_mut("steps").and_then(Value::as_array_mut).into_iter().flatten() {
        if step.get("seq").and_then(Value::as_u64) == Some(seq) {
            step["ok"] = json!(ok);
            step["ackAtMs"] = json!(now);
            step["errorCode"] = error_code.clone().map(|code| json!(code)).unwrap_or(Value::Null);
        }
    }
    if ok {
        object.insert("lastInputAcceptedAtMs".into(), json!(now));
    } else if let Some(code) = error_code {
        object.insert("lastError".into(), json!(code));
    }
    object.insert("updatedAtMs".into(), json!(now));
    write_json_atomic(&path, &session).map_err(|_| "playtest_input_result_invalid")?;
    Ok(true)
}

/// 渲染端截图回执（plugin_message playtest.screenshot）：绑定 previewId/buildId
/// 与 captureId 后有界落盘 screenshot.json（≤512KiB，tmp+rename 原子发布）。
/// 这是渲染证据面：像素之外不带任何几何/物理语义。
pub(crate) fn store_preview_screenshot(home: &Path, preview_id: &str, screenshot: &Value) -> Result<bool, &'static str> {
    let capture_id = screenshot.get("captureId").and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128
            && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
        .ok_or("playtest_screenshot_invalid")?;
    // 失败回执（errorCode）不带像素：按 invalid 拒收（只进宿主日志）；MCP 侧
    // 等不到匹配 captureId 的帧时按 creator_capture_unavailable 诚实超时。
    if let Some(error_code) = screenshot.get("errorCode") {
        if !error_code.is_null() {
            return Err("playtest_screenshot_invalid");
        }
    }
    let data_url = screenshot.get("dataUrl").and_then(Value::as_str)
        .filter(|url| url.starts_with("data:image/jpeg;base64,") && url.len() <= MAX_PLAYTEST_SCREENSHOT_CHARS)
        .ok_or("playtest_screenshot_invalid")?;
    let width = screenshot.get("width").and_then(Value::as_u64).filter(|value| *value <= 16_384).ok_or("playtest_screenshot_invalid")?;
    let height = screenshot.get("height").and_then(Value::as_u64).filter(|value| *value <= 16_384).ok_or("playtest_screenshot_invalid")?;
    let downscaled = screenshot.get("downscaled").and_then(Value::as_bool).ok_or("playtest_screenshot_invalid")?;
    let directory = preview_dir(home, preview_id).map_err(|_| "code_game_preview_request_invalid")?;
    let build_id = read_json(&directory.join("request.json"), MAX_PREVIEW_REQUEST_BYTES)
        .map_err(|_| "playtest_screenshot_invalid")?
        .and_then(|request| request.get("buildId").and_then(Value::as_str).map(ToString::to_string));
    let tick = read_json(&directory.join("state.json"), 16 * 1024).ok().flatten()
        .map(|state| state.get("tick").cloned().unwrap_or(Value::Null))
        .unwrap_or(Value::Null);
    let record = json!({"captureId":capture_id,"previewId":preview_id,"buildId":build_id,
        "dataUrl":data_url,"width":width,"height":height,"downscaled":downscaled,
        "bytes":data_url.len(),"tick":tick,"capturedAtMs":now_ms()});
    let bytes = serde_json::to_vec(&record).map_err(|_| "playtest_screenshot_invalid")?;
    if bytes.len() > MAX_PLAYTEST_SCREENSHOT_FILE { return Err("playtest_screenshot_invalid"); }
    let _guard = preview_io_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let target = directory.join("screenshot.json");
    let temporary = directory.join("screenshot.json.tmp");
    std::fs::write(&temporary, bytes).map_err(|_| "code_game_state_unavailable")?;
    if std::fs::rename(&temporary, &target).is_err() {
        std::fs::remove_file(&temporary).ok();
        return Err("code_game_state_unavailable");
    }
    Ok(true)
}

/// studio_status_for 的试玩投影（观察面补缺）：只补会话预算/最近接受时刻/
/// 最近错误三个字段，绝不复制一份新状态系统。
fn playtest_status_projection(home: &Path, preview_id: &str) -> Option<Value> {
    let session = read_json(&playtest_path(home, preview_id).ok()?, 256 * 1024).ok()??;
    Some(json!({
        "sessionId": session.get("sessionId").cloned().unwrap_or(Value::Null),
        "status": session.get("status").cloned().unwrap_or(Value::Null),
        "reason": session.get("reason").cloned().unwrap_or(Value::Null),
        "acceptedActions": bounded_count(&session, "acceptedActions", MAX_PLAYTEST_ACTIONS),
        "deliveredBatches": bounded_count(&session, "deliveredBatches", MAX_PLAYTEST_ACTIONS),
        "lastInputAcceptedAtMs": bounded_count(&session, "lastInputAcceptedAtMs", u64::MAX),
        "lastError": session.get("lastError").cloned().unwrap_or(Value::Null),
    }))
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

    /// S-0 Top5-③（V3_S0_CI_AUDIT §3 P1-3a）：容量回收——32 上限时最旧终态
    /// 优先驱逐（连同其 Clock Fork 行一并清理），全部非终态时显式 busy。
    #[test]
    fn preview_capacity_evicts_oldest_terminal_and_fails_busy_when_all_live() {
        let home = std::env::temp_dir().join(format!("code-game-capacity-{}-{}", now_ms(), std::process::id()));
        let mut ids: Vec<String> = (0..MAX_PREVIEW_RECORDS)
            .map(|index| format!("preview-cap-{index:03}")).collect();
        // updatedAtMs 递增 + id 字典序与时间序相反：驱逐必须由时间戳决定，不是目录名。
        for (index, id) in ids.iter().enumerate() {
            let directory = preview_dir(&home, id).unwrap();
            std::fs::create_dir_all(&directory).unwrap();
            write_json_atomic(&directory.join("state.json"), &json!({"status":"finished","previewId":id,
                "gameId":"game.capacity","updatedAtMs":1_000 + index as u64 * 10})).unwrap();
        }
        ids.sort();
        let oldest = ids[0].clone();
        // 最旧终态 Preview 的 Clock Fork 行：驱逐时必须被 forget_preview_clock 清掉。
        crate::city_runtime::read_preview_clock_at(&home, &oldest, "city:one", 1_000).unwrap();
        let fork_rows = |preview_id: &str| database_fork_rows(&home, preview_id);
        assert!(fork_rows(&oldest).is_some());
        // 已到 32 上限：下一个入场（studio_preview 在创建目录前调用）触发一次驱逐，
        // 且被驱逐的恰是 updatedAtMs 最旧的终态——不是字典序最靠后的。
        ensure_preview_capacity(&home).unwrap();
        assert!(!preview_dir(&home, &oldest).unwrap().exists(), "oldest terminal preview must be evicted");
        assert!(fork_rows(&oldest).is_none(), "evicted preview's clock fork row must be forgotten");
        assert_eq!(preview_ids(&home).unwrap().len(), MAX_PREVIEW_RECORDS - 1);
        // 其余 31 个终态原样保留（只驱逐一个）。
        for id in ids.iter().skip(1) {
            assert!(preview_dir(&home, id).unwrap().exists(), "{id} must survive");
        }
        std::fs::remove_dir_all(home).ok();

        // 全部 32 个非终态（running）：无终态可驱逐 → 显式 game_activity_busy。
        let home = std::env::temp_dir().join(format!("code-game-capacity-live-{}-{}", now_ms(), std::process::id()));
        for index in 0..MAX_PREVIEW_RECORDS {
            let id = format!("preview-live-{index:03}");
            let directory = preview_dir(&home, &id).unwrap();
            std::fs::create_dir_all(&directory).unwrap();
            write_json_atomic(&directory.join("state.json"), &json!({"status":"running","previewId":id,
                "gameId":"game.capacity","updatedAtMs":2_000 + index as u64})).unwrap();
        }
        assert_eq!(ensure_preview_capacity(&home).unwrap_err(), "game_activity_busy");
        // busy 拒绝不破坏现场：32 个 running 全部原样保留。
        assert_eq!(preview_ids(&home).unwrap().len(), MAX_PREVIEW_RECORDS);
        std::fs::remove_dir_all(home).ok();
    }

    /// city_preview_clocks 行的直读探针（驱逐清理的断言面）。
    fn database_fork_rows(home: &Path, preview_id: &str) -> Option<(String,)> {
        use rusqlite::OptionalExtension;
        let db = crate::creator_store::database(home).ok()?;
        db.query_row("SELECT preview_id FROM city_preview_clocks WHERE preview_id=?1", [preview_id],
            |row| row.get::<_, String>(0)).optional().ok().flatten().map(|id| (id,))
    }

    // ── PR05 City Snapshot Test（桌面臂）────────────────────────────

    fn snapshot_city_fixture(home: &Path, city_id: &str, revision: u64) {
        let db = crate::creator_store::database(home).unwrap();
        // city_id 是主键：revision 前进用 upsert（模拟编辑推进权威 revision）。
        db.execute("INSERT INTO creator_cities(city_id,revision,document_json,created_at_ms,updated_at_ms) VALUES(?1,?2,'{}',1,1) ON CONFLICT(city_id) DO UPDATE SET revision=?2",
            rusqlite::params![city_id, revision as i64]).unwrap();
    }

    /// 与 city-sdk canonicalDigest 同词表的自洽最小快照（header 三元组 + V4 形状；
    /// 真实密码学校验由 runner 的 validateCityWorldSnapshot 承担，这里测宿主的
    /// 结构/身份一致性臂）。
    fn fixture_city_snapshot(city_id: &str, revision: u64, digest: &str) -> String {
        json!({
            "schemaVersion": 4,
            "header": {"schemaVersion": 1, "cityId": city_id, "cityRevision": revision, "snapshotDigest": digest, "seed": 7},
            "terrain": {"format": "heightfield-tiles-v1", "tiles": []},
        }).to_string()
    }

    fn snapshot_preview_fixture(home: &Path, preview_id: &str, source: Value) {
        let directory = preview_dir(home, preview_id).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        write_json_atomic(&directory.join("request.json"), &json!({"previewId":preview_id,"buildId":"a","source":source})).unwrap();
    }

    /// 导出（preview 上报）→ 落盘 → broker 服务臂回执的全链路：digest 照 header
    /// 原样回显，快照字节可原样交回 runner。
    #[test]
    fn city_snapshot_export_stores_and_the_broker_arm_serves_it() {
        let home = std::env::temp_dir().join(format!("code-game-snapshot-ok-{}-{}", now_ms(), std::process::id()));
        snapshot_city_fixture(&home, "city:pr05", 7);
        let digest = bytes_digest(b"city-pr05-world");
        let snapshot_json = fixture_city_snapshot("city:pr05", 7, &digest);
        snapshot_preview_fixture(&home, "preview-snap-ok", json!({"cityId":"city:pr05","cityRevision":7}));
        let receipt = store_city_test_snapshot(&home, "preview-snap-ok", &snapshot_json).unwrap();
        assert_eq!(receipt, json!({"stored":true,"cityId":"city:pr05","cityRevision":7,"snapshotDigest":digest}));
        let cached = city_snapshots_root(&home).join("city:pr05-7.json");
        assert!(cached.exists(), "cache file must exist at <cityId>-<revision>.json");
        assert!(!cached.with_extension("json.tmp").exists(), "cache writes must be atomic (tmp+rename)");
        let served = city_test_snapshot(&home, &json!({"cityId":"city:pr05","cityRevision":7})).unwrap();
        assert_eq!(served["snapshotDigest"], json!(digest));
        let roundtrip: Value = serde_json::from_str(served["snapshotJson"].as_str().unwrap()).unwrap();
        assert_eq!(roundtrip["header"]["snapshotDigest"], json!(digest));
        assert_eq!(roundtrip["header"]["cityId"], json!("city:pr05"));
        assert_eq!(roundtrip["header"]["cityRevision"], json!(7));
        std::fs::remove_dir_all(home).ok();
    }

    /// 权威 revision 前进后：serve 旧 revision 与 store 旧 revision 都按 stale 拒绝，
    /// 不落盘、不服务（与 MCP 侧同源复核同一稳定码）。
    #[test]
    fn stale_city_revision_is_rejected_on_store_and_serve() {
        let home = std::env::temp_dir().join(format!("code-game-snapshot-stale-{}-{}", now_ms(), std::process::id()));
        snapshot_city_fixture(&home, "city:pr05", 8);
        let digest = bytes_digest(b"city-pr05-world");
        snapshot_preview_fixture(&home, "preview-snap-stale", json!({"cityId":"city:pr05","cityRevision":8}));
        assert_eq!(city_test_snapshot(&home, &json!({"cityId":"city:pr05","cityRevision":7})).unwrap_err(), "creator_city_revision_stale");
        assert_eq!(store_city_test_snapshot(&home, "preview-snap-stale", &fixture_city_snapshot("city:pr05", 7, &digest)).unwrap_err(), "creator_city_revision_stale");
        assert!(!city_snapshots_root(&home).join("city:pr05-7.json").exists(), "stale export must not be cached");
        std::fs::remove_dir_all(home).ok();
    }

    /// 缓存缺席（City 还没开过 Code 预览）与城市缺失是不同稳定码；绝不合成回退。
    #[test]
    fn missing_cache_entry_fails_structured_without_a_synthetic_fallback() {
        let home = std::env::temp_dir().join(format!("code-game-snapshot-miss-{}-{}", now_ms(), std::process::id()));
        snapshot_city_fixture(&home, "city:pr05", 7);
        assert_eq!(city_test_snapshot(&home, &json!({"cityId":"city:pr05","cityRevision":7})).unwrap_err(), "creator_city_snapshot_not_cached");
        assert_eq!(city_test_snapshot(&home, &json!({"cityId":"city:none","cityRevision":7})).unwrap_err(), "creator_city_not_found");
        std::fs::remove_dir_all(home).ok();
    }

    /// 损坏缓存 fail-closed：非 JSON、cityId 不符、digest 词表不符都按 invalid 拒绝。
    #[test]
    fn malformed_cached_snapshot_is_rejected_by_the_serving_arm() {
        let home = std::env::temp_dir().join(format!("code-game-snapshot-bad-{}-{}", now_ms(), std::process::id()));
        snapshot_city_fixture(&home, "city:pr05", 7);
        let root = city_snapshots_root(&home);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("city:pr05-7.json"), b"{not json").unwrap();
        assert_eq!(city_test_snapshot(&home, &json!({"cityId":"city:pr05","cityRevision":7})).unwrap_err(), "creator_city_snapshot_invalid");
        std::fs::write(root.join("city:pr05-7.json"), fixture_city_snapshot("city:other", 7, &bytes_digest(b"x"))).unwrap();
        assert_eq!(city_test_snapshot(&home, &json!({"cityId":"city:pr05","cityRevision":7})).unwrap_err(), "creator_city_snapshot_invalid");
        std::fs::write(root.join("city:pr05-7.json"), fixture_city_snapshot("city:pr05", 7, "deadbeef")).unwrap();
        assert_eq!(city_test_snapshot(&home, &json!({"cityId":"city:pr05","cityRevision":7})).unwrap_err(), "creator_city_snapshot_invalid");
        std::fs::remove_dir_all(home).ok();
    }

    /// 导出三重绑定：synthetic 预览、装载别的 City 的预览、未知预览都拒收；请求
    /// 未写 cityRevision（跟随权威）时按 cityId 绑定放行。
    #[test]
    fn snapshot_export_requires_the_matching_real_preview() {
        let home = std::env::temp_dir().join(format!("code-game-snapshot-bind-{}-{}", now_ms(), std::process::id()));
        snapshot_city_fixture(&home, "city:pr05", 7);
        let digest = bytes_digest(b"city-pr05-world");
        let snapshot_json = fixture_city_snapshot("city:pr05", 7, &digest);
        snapshot_preview_fixture(&home, "preview-snap-synth", json!({"cityId":"city:pr05","synthetic":true}));
        assert_eq!(store_city_test_snapshot(&home, "preview-snap-synth", &snapshot_json).unwrap_err(), "creator_city_snapshot_source_mismatch");
        snapshot_preview_fixture(&home, "preview-snap-other", json!({"cityId":"city:other","cityRevision":7}));
        assert_eq!(store_city_test_snapshot(&home, "preview-snap-other", &snapshot_json).unwrap_err(), "creator_city_snapshot_source_mismatch");
        assert_eq!(store_city_test_snapshot(&home, "preview-unknown", &snapshot_json).unwrap_err(), "code_game_preview_request_invalid");
        snapshot_preview_fixture(&home, "preview-snap-open", json!({"cityId":"city:pr05"}));
        assert!(store_city_test_snapshot(&home, "preview-snap-open", &snapshot_json).is_ok());
        std::fs::remove_dir_all(home).ok();
    }

    /// 每城只保留最新 MAX_CITY_SNAPSHOT_REVISIONS 份；其他 City 的缓存不受影响。
    #[test]
    fn snapshot_cache_keeps_only_the_latest_revisions_per_city() {
        let home = std::env::temp_dir().join(format!("code-game-snapshot-prune-{}-{}", now_ms(), std::process::id()));
        snapshot_preview_fixture(&home, "preview-snap-prune", json!({"cityId":"city:pr05"}));
        let digest = bytes_digest(b"city-pr05-world");
        for revision in 7..=9_u64 {
            snapshot_city_fixture(&home, "city:pr05", revision);
            store_city_test_snapshot(&home, "preview-snap-prune", &fixture_city_snapshot("city:pr05", revision, &digest)).unwrap();
        }
        let root = city_snapshots_root(&home);
        assert!(root.join("city:pr05-9.json").exists() && root.join("city:pr05-8.json").exists());
        assert!(!root.join("city:pr05-7.json").exists(), "oldest revision must be pruned");
        snapshot_city_fixture(&home, "city:other", 3);
        snapshot_preview_fixture(&home, "preview-snap-prune2", json!({"cityId":"city:other"}));
        store_city_test_snapshot(&home, "preview-snap-prune2", &fixture_city_snapshot("city:other", 3, &digest)).unwrap();
        assert!(root.join("city:pr05-9.json").exists(), "other cities' caches must survive");
        std::fs::remove_dir_all(home).ok();
    }

    /// 预算联动：入口 too_large 拒收超限上报；满预算（≤1 MiB 信封）的缓存经
    /// plugin_calls 真实 respond_with_budget（描述符 responseBytes 上限）回执成功。
    #[test]
    fn snapshot_budgets_bound_the_export_and_the_broker_response() {
        let home = std::env::temp_dir().join(format!("code-game-snapshot-budget-{}-{}", now_ms(), std::process::id()));
        snapshot_city_fixture(&home, "city:pr05", 7);
        snapshot_preview_fixture(&home, "preview-snap-big", json!({"cityId":"city:pr05"}));
        let digest = bytes_digest(b"city-pr05-world");
        let oversized = format!("{{\"header\":{{}},\"padding\":\"{}\"}}", "x".repeat(MAX_CITY_SNAPSHOT_BYTES + 1));
        assert_eq!(store_city_test_snapshot(&home, "preview-snap-big", &oversized).unwrap_err(), "creator_city_snapshot_too_large");
        // 满预算但合规的快照：canonical 字节数贴近上限，仍可落盘并被服务臂取回。
        let mut padded: Value = serde_json::from_str(&fixture_city_snapshot("city:pr05", 7, &digest)).unwrap();
        let canonical_base = canonical_json(&padded).unwrap().len();
        // 键排序插入 "notes" 会新增一个逗号，预算里一并扣除。
        let slack = MAX_CITY_SNAPSHOT_BYTES - canonical_base - "\"notes\":\"\"".len() - 1;
        padded["notes"] = json!("x".repeat(slack));
        let big = canonical_json(&padded).unwrap();
        assert!(big.len() <= MAX_CITY_SNAPSHOT_BYTES, "{} must fit the store budget", big.len());
        store_city_test_snapshot(&home, "preview-snap-big", &big).unwrap();
        let served = city_test_snapshot(&home, &json!({"cityId":"city:pr05","cityRevision":7})).unwrap();
        let envelope = json!({"ok": true, "result": served});
        assert!(serde_json::to_string(&envelope).unwrap().len() <= 1024 * 1024, "serve envelope must fit the descriptor response budget");
        let call_id = agent_vitals_runtime::query::plugin_calls::submit_with_budget(&home, "creator-studio",
            "creator.code.test.city_snapshot", &json!({"cityId":"city:pr05","cityRevision":7}), 60_000, 16384).unwrap();
        agent_vitals_runtime::query::plugin_calls::claim_pending(&home, "creator-studio", "budget-instance",
            &["creator.code.test.city_snapshot".to_string()], 4).unwrap();
        agent_vitals_runtime::query::plugin_calls::respond_with_budget(&home, "creator-studio", "budget-instance",
            &call_id, &envelope, 1024 * 1024).expect("full-budget snapshot must pass the descriptor response budget");
        std::fs::remove_dir_all(home).ok();
    }

    /// PR06 无头测试记录读面：逐字透传 `tests/<buildId>.json`；缺记录是明确缺席
    /// （`creator_code_test_record_not_found`），buildId 必须是 64 位小写 hex。
    #[test]
    fn code_test_record_reads_the_mcp_written_record_verbatim() {
        let home = std::env::temp_dir().join(format!("code-game-test-record-{}-{}", now_ms(), std::process::id()));
        let build_id = "a".repeat(64);
        let record = json!({
            "buildId": build_id, "workspaceRevision": format!("sha256:{}", "b".repeat(64)), "ok": true,
            "executionOk": true, "verdict": "passed", "seed": 7, "ticks": 120,
            "source": {"source": "synthetic"}, "atMs": 42,
        });
        let tests = code_games_root(&home).join("tests");
        std::fs::create_dir_all(&tests).unwrap();
        std::fs::write(tests.join(format!("{build_id}.json")), serde_json::to_vec(&record).unwrap()).unwrap();
        let served = code_test_record(&home, &json!({"buildId": build_id})).unwrap();
        assert_eq!(served, record, "the route must return the record verbatim for the UI's fail-closed parser");
        assert_eq!(code_test_record(&home, &json!({"buildId": "c".repeat(64)})).unwrap_err(), "creator_code_test_record_not_found");
        assert_eq!(code_test_record(&home, &json!({"buildId": "../escape"})).unwrap_err(), "game_argument_invalid");
        assert_eq!(code_test_record(&home, &json!({})).unwrap_err(), "game_argument_invalid");
        std::fs::remove_dir_all(home).ok();
    }

    // ── PR08 自动化视觉试玩 ────────────────────────────────────────

    fn playtest_preview_fixture(home: &Path, preview_id: &str) {
        let directory = preview_dir(home, preview_id).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        write_json_atomic(&directory.join("request.json"), &json!({"previewId":preview_id,"buildId":"b".repeat(64),
            "source":{"cityId":"city:pr08","cityRevision":3}})).unwrap();
        record_preview_state(home, &json!({"status":"running","previewId":preview_id,"gameId":"game.pr08",
            "buildId":"b".repeat(64),"runId":"run-pr08","tick":5,"entities":2})).unwrap();
    }

    /// 输入白名单/预算收口 + 队列投递（每轮一次）+ 回执记录：只有封闭形状的
    /// 动作能进入会话；serve 只在空闲轮询投递一个批次；回执按 sessionId+seq
    /// 落步骤；陈旧回执按未记录处理（不是伪造，配对窗口才能到达这里）。
    #[test]
    fn playtest_input_whitelist_caps_queue_and_ack_are_enforced() {
        let home = std::env::temp_dir().join(format!("code-game-playtest-input-{}-{}", now_ms(), std::process::id()));
        playtest_preview_fixture(&home, "preview-pt-input");
        // 没有 run 状态的 preview：输入被拒绝（game_run_not_found）。
        assert_eq!(playtest_input(&home, "preview-pt-ghost", &json!({"forward":true}), None, 1).unwrap_err(), "game_run_not_found");
        // 白名单：空对象 / 超键数 / 非法键字符 / 非法值 / 超长 hold。
        assert_eq!(playtest_input(&home, "preview-pt-input", &json!({}), None, 1).unwrap_err(), "playtest_invalid_actions");
        assert_eq!(playtest_input(&home, "preview-pt-input",
            &json!({"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9}), None, 1).unwrap_err(), "playtest_invalid_actions");
        assert_eq!(playtest_input(&home, "preview-pt-input", &json!({"bad key!":true}), None, 1).unwrap_err(), "playtest_invalid_actions");
        assert_eq!(playtest_input(&home, "preview-pt-input", &json!({"forward":"yes"}), None, 1).unwrap_err(), "playtest_invalid_actions");
        assert_eq!(playtest_input(&home, "preview-pt-input", &json!({"throttle":1.0e7}), None, 1).unwrap_err(), "playtest_invalid_actions");
        assert_eq!(playtest_input(&home, "preview-pt-input", &json!({"forward":true}), Some(MAX_PLAYTEST_HOLD_MS + 1), 1).unwrap_err(), "playtest_invalid_actions");
        // 合法入队：会话建立，预算回执可读。
        let first = playtest_input(&home, "preview-pt-input", &json!({"forward":true}), Some(400), 1_000).unwrap();
        assert_eq!(first["seq"], 1);
        assert_eq!(first["queued"], true);
        let session_id = first["sessionId"].as_str().unwrap().to_string();
        let second = playtest_input(&home, "preview-pt-input", &json!({"forward":false,"steer":0.5}), None, 1_100).unwrap();
        assert_eq!(second["seq"], 2);
        assert_eq!(second["sessionId"], json!(session_id));
        assert_eq!(second["budget"]["queuedBatches"], 2);
        // serve 每轮投递一个批次，动作照原样下发，观察态绑定 tick/entities。
        let served_first = serve_preview_playtest(&home, "preview-pt-input", 1_200).unwrap();
        assert_eq!(served_first["control"], "playtest.input");
        assert_eq!(served_first["sessionId"], json!(session_id));
        assert_eq!(served_first["seq"], 1);
        assert_eq!(served_first["actions"], json!({"forward":true}));
        assert_eq!(served_first["holdMs"], 400);
        let served_second = serve_preview_playtest(&home, "preview-pt-input", 1_300).unwrap();
        assert_eq!(served_second["seq"], 2);
        // 队列空了：不再投递（截图请求由独立文件面走）。
        assert_eq!(serve_preview_playtest(&home, "preview-pt-input", 1_400), None);
        // 回执：seq 1 失败（合法错误码），seq 2 成功。
        assert_eq!(record_playtest_ack(&home, "preview-pt-input", &json!({"sessionId":session_id,"seq":1,
            "ok":false,"errorCode":"game_run_not_found"})).unwrap(), true);
        assert_eq!(record_playtest_ack(&home, "preview-pt-input", &json!({"sessionId":session_id,"seq":2,"ok":true})).unwrap(), true);
        let session = read_json(&playtest_path(&home, "preview-pt-input").unwrap(), 256 * 1024).unwrap().unwrap();
        assert_eq!(session["lastError"], "game_run_not_found");
        assert!(session["lastInputAcceptedAtMs"].as_u64().is_some());
        assert_eq!(session["steps"].as_array().unwrap()[0]["ok"], false);
        assert_eq!(session["steps"].as_array().unwrap()[1]["ok"], true);
        // 陈旧回执（会话 id 不符）与畸形回执。
        assert_eq!(record_playtest_ack(&home, "preview-pt-input", &json!({"sessionId":"playtest-other","seq":2,"ok":true})).unwrap(), false);
        assert_eq!(record_playtest_ack(&home, "preview-pt-input", &json!({"sessionId":session_id,"seq":2,"ok":"yes"})).unwrap_err(), "playtest_input_result_invalid");
        assert_eq!(record_playtest_ack(&home, "preview-pt-input", &json!({"sessionId":session_id,"seq":2,"ok":true,"errorCode":"BAD CODE"})).unwrap_err(), "playtest_input_result_invalid");
        // 投影：studio_status_for 附带 playtest 子对象。
        let status = studio_status_for(&home, "preview-pt-input").unwrap();
        assert_eq!(status["playtest"]["lastError"], "game_run_not_found");
        assert_eq!(status["playtest"]["acceptedActions"], 3);
        std::fs::remove_dir_all(home).ok();
    }

    /// 预算/过期终态只通知一次；stop 幂等；preview 终态（record_preview_state
    /// finished/error）终态化会话并撤销未消费的截图请求。
    #[test]
    fn playtest_sessions_end_by_budget_stop_and_preview_terminal() {
        let home = std::env::temp_dir().join(format!("code-game-playtest-end-{}-{}", now_ms(), std::process::id()));
        playtest_preview_fixture(&home, "preview-pt-end");
        // 过期：now 越过 expiresAtMs → serve 发出一次 playtest.end。
        playtest_input(&home, "preview-pt-end", &json!({"forward":true}), None, 1_000).unwrap();
        let ended = serve_preview_playtest(&home, "preview-pt-end", 1_000 + MAX_PLAYTEST_WINDOW_MS).unwrap();
        assert_eq!(ended["control"], "playtest.end");
        assert_eq!(ended["reason"], "expired");
        assert_eq!(serve_preview_playtest(&home, "preview-pt-end", 1_000 + MAX_PLAYTEST_WINDOW_MS + 1), None);
        // 预算：队列中的待投递动作也计入上限；接近满预算时入队被拒；
        // 正常跑满 64 动作后 serve 发出一次 budget end（新会话另起预算）。
        let home_budget = std::env::temp_dir().join(format!("code-game-playtest-budget-{}-{}", now_ms(), std::process::id()));
        playtest_preview_fixture(&home_budget, "preview-pt-budget");
        // 快进到接近上限的活跃会话（61 已投递 + 待投 4 = 65 > 64 → 拒绝）。
        playtest_input(&home_budget, "preview-pt-budget", &json!({"a":true,"b":true,"c":true,"d":true}), None, 1_000).unwrap();
        serve_preview_playtest(&home_budget, "preview-pt-budget", 1_100);
        let budget_session_path = playtest_path(&home_budget, "preview-pt-budget").unwrap();
        let mut budget_session = read_json(&budget_session_path, 256 * 1024).unwrap().unwrap();
        budget_session["acceptedActions"] = json!(61);
        write_json_atomic(&budget_session_path, &budget_session).unwrap();
        assert_eq!(playtest_input(&home_budget, "preview-pt-budget", &json!({"e":true,"f":true,"g":true,"h":true}), None, 1_200).unwrap_err(), "playtest_budget_exhausted");
        // 正常流（新 preview = 新会话）：8 批 × 8 动作 = 64 → 恰好触发 budget end。
        playtest_preview_fixture(&home_budget, "preview-pt-budget2");
        let full_batch = json!({"a":true,"b":true,"c":true,"d":true,"e":true,"f":true,"g":true,"h":true});
        let mut served_batches = 0;
        let mut end_reason: Option<Value> = None;
        'budget_flow: for _ in 0..40 {
            if playtest_input(&home_budget, "preview-pt-budget2", &full_batch, None, 1_000).is_err() { break; }
            while let Some(envelope) = serve_preview_playtest(&home_budget, "preview-pt-budget2", 2_000) {
                if envelope["control"] == "playtest.end" {
                    end_reason = Some(envelope["reason"].clone());
                    break 'budget_flow;
                }
                assert_eq!(envelope["control"], "playtest.input");
                served_batches += 1;
            }
        }
        assert_eq!(served_batches, (MAX_PLAYTEST_ACTIONS / 8) as usize);
        assert_eq!(end_reason, Some(json!("budget")));
        let session = read_json(&playtest_path(&home_budget, "preview-pt-budget2").unwrap(), 256 * 1024).unwrap().unwrap();
        assert_eq!(session["acceptedActions"], MAX_PLAYTEST_ACTIONS);
        // stop：终态化并清空 pending；再 stop 幂等。
        let home_stop = std::env::temp_dir().join(format!("code-game-playtest-stop-{}-{}", now_ms(), std::process::id()));
        playtest_preview_fixture(&home_stop, "preview-pt-stop");
        playtest_input(&home_stop, "preview-pt-stop", &json!({"forward":true}), None, 1_000).unwrap();
        playtest_input(&home_stop, "preview-pt-stop", &json!({"forward":true}), None, 1_100).unwrap();
        let stopped = playtest_stop(&home_stop, "preview-pt-stop", 1_200).unwrap();
        assert_eq!(stopped["stopped"], true);
        let session = read_json(&playtest_path(&home_stop, "preview-pt-stop").unwrap(), 256 * 1024).unwrap().unwrap();
        assert_eq!(session["status"], "finished");
        assert_eq!(session["reason"], "stopped");
        assert_eq!(session["pending"].as_array().unwrap().len(), 0);
        assert_eq!(playtest_stop(&home_stop, "preview-pt-stop", 1_300).unwrap()["stopped"], false);
        assert_eq!(playtest_stop(&home_stop, "preview-no-session", 1_300).unwrap()["reason"], "no_session");
        // preview 终态：活跃会话按 preview_closed 终态化（结果保留可读），截图请求撤销。
        let home_terminal = std::env::temp_dir().join(format!("code-game-playtest-terminal-{}-{}", now_ms(), std::process::id()));
        playtest_preview_fixture(&home_terminal, "preview-pt-terminal");
        playtest_input(&home_terminal, "preview-pt-terminal", &json!({"forward":true}), None, 1_000).unwrap();
        write_json_atomic(&preview_dir(&home_terminal, "preview-pt-terminal").unwrap().join("capture-request.json"),
            &json!({"captureId":"cap-1","requestedAtMs":1_000})).unwrap();
        record_preview_state(&home_terminal, &json!({"status":"finished","previewId":"preview-pt-terminal","gameId":"game.pr08"})).unwrap();
        let session = read_json(&playtest_path(&home_terminal, "preview-pt-terminal").unwrap(), 256 * 1024).unwrap().unwrap();
        assert_eq!(session["status"], "finished");
        assert_eq!(session["reason"], "preview_closed");
        assert!(!preview_dir(&home_terminal, "preview-pt-terminal").unwrap().join("capture-request.json").exists());
        std::fs::remove_dir_all(home).ok();
        std::fs::remove_dir_all(home_budget).ok();
        std::fs::remove_dir_all(home_stop).ok();
        std::fs::remove_dir_all(home_terminal).ok();
    }

    /// 截图是渲染证据面：只接受绑定 captureId 的有界 JPEG dataUrl，落盘绑定
    /// previewId/buildId/tick；请求经轮询取走一次，坏请求 fail-closed 移除。
    #[test]
    fn preview_screenshot_request_capture_and_storage_are_bounded() {
        let home = std::env::temp_dir().join(format!("code-game-playtest-shot-{}-{}", now_ms(), std::process::id()));
        playtest_preview_fixture(&home, "preview-pt-shot");
        let directory = preview_dir(&home, "preview-pt-shot").unwrap();
        // 请求消费：合法 captureId → playtest.capture 信封 + 文件取走；坏请求移除。
        write_json_atomic(&directory.join("capture-request.json"), &json!({"captureId":"cap-shot-1","requestedAtMs":1})).unwrap();
        let served = serve_preview_playtest(&home, "preview-pt-shot", 2).unwrap();
        assert_eq!(served["control"], "playtest.capture");
        assert_eq!(served["captureId"], "cap-shot-1");
        assert!(!directory.join("capture-request.json").exists());
        write_json_atomic(&directory.join("capture-request.json"), &json!({"captureId":"../escape","requestedAtMs":1})).unwrap();
        assert_eq!(serve_preview_playtest(&home, "preview-pt-shot", 3), None);
        assert!(!directory.join("capture-request.json").exists());
        // 落盘：绑定 previewId/buildId/tick；像素预算与词表在入口收口。
        let data_url = format!("data:image/jpeg;base64,{}", "A".repeat(64));
        assert_eq!(store_preview_screenshot(&home, "preview-pt-shot", &json!({"captureId":"cap-shot-1",
            "dataUrl":data_url,"width":1100,"height":760,"downscaled":false})).unwrap(), true);
        let stored: Value = serde_json::from_slice(&std::fs::read(directory.join("screenshot.json")).unwrap()).unwrap();
        assert_eq!(stored["captureId"], "cap-shot-1");
        assert_eq!(stored["previewId"], "preview-pt-shot");
        assert_eq!(stored["buildId"], json!("b".repeat(64)));
        assert_eq!(stored["tick"], 5);
        assert_eq!(stored["bytes"], data_url.len());
        // 拒绝：非 JPEG 前缀、超预算 dataUrl、尺寸越界、失败回执、未知预览。
        assert_eq!(store_preview_screenshot(&home, "preview-pt-shot", &json!({"captureId":"cap-shot-2",
            "dataUrl":"data:text/html;base64,AAAA","width":1,"height":1,"downscaled":false})).unwrap_err(), "playtest_screenshot_invalid");
        let oversized = format!("data:image/jpeg;base64,{}", "A".repeat(MAX_PLAYTEST_SCREENSHOT_CHARS + 1));
        assert_eq!(store_preview_screenshot(&home, "preview-pt-shot", &json!({"captureId":"cap-shot-2",
            "dataUrl":oversized,"width":1,"height":1,"downscaled":false})).unwrap_err(), "playtest_screenshot_invalid");
        assert_eq!(store_preview_screenshot(&home, "preview-pt-shot", &json!({"captureId":"cap-shot-2",
            "dataUrl":data_url,"width":999_999,"height":1,"downscaled":false})).unwrap_err(), "playtest_screenshot_invalid");
        assert_eq!(store_preview_screenshot(&home, "preview-pt-shot", &json!({"captureId":"cap-shot-2",
            "errorCode":"creator_capture_unavailable"})).unwrap_err(), "playtest_screenshot_invalid");
        assert!(store_preview_screenshot(&home, "preview-unknown", &json!({"captureId":"cap-shot-2",
            "dataUrl":data_url,"width":1,"height":1,"downscaled":false})).is_err());
        std::fs::remove_dir_all(home).ok();
    }
}
