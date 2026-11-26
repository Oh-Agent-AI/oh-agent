//! 体验包（city-experience）宿主侧：把**已发布**的 release 打成自包含目录，并登记进共享
//! 内容库。
//!
//! 为什么需要它：release 只引用 `(cityId, cityRevision, worldRevision, layoutId)`，资产字节
//! 留在项目目录里。换一台机器（干净客户端）就没有 Creator 库，也就没有布局快照和资产——
//! 体验包把「冻结发布快照 + v3 布局快照（含锚点几何）+ 资产字节」补齐成一份可拷走的目录。
//!
//! 目录结构（与 `apps/agent-city/mcp/experienceStore.mjs` 同一契约）：
//!   manifest.json          体验元数据 + 文件清单 + contentDigest
//!   release.json           冻结发布快照（逐字）
//!   layout.json            v3 布局快照（逐字，必须带 geometry）
//!   assets/<sha256>.glb    发布引用到的资产字节（逐字）
//!
//! `contentDigest = sha256(canonicalJson(manifest 去掉 contentDigest))`；每个文件在 `files[]`
//! 里有独立摘要与长度。TS 侧（`experienceStore.mjs`）会用同一算法再校验一次——两边是同一份
//! 契约，宿主不因为"自己写的"就跳过校验。
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::creator_store::{bytes_digest, canonical_json, database, digest, now_ms, valid_id};

const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_FILES: usize = 512;

fn experience_root(home: &Path) -> PathBuf { home.join("state/creator/experience") }
fn content_root(home: &Path) -> PathBuf { home.join("state/creator/content") }

fn safe_component(value: &str) -> bool { value.len() <= 64 && !value.contains("..") && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+')) }
fn valid_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && part.len() <= 9 && part.bytes().all(|byte| byte.is_ascii_digit()) && (part == &"0" || !part.starts_with('0')))
}

fn read_json(path: &Path, code: &'static str) -> Result<Value, &'static str> {
    let bytes = std::fs::read(path).map_err(|_| code)?;
    serde_json::from_slice(&bytes).map_err(|_| code)
}

/// 计算 manifest 的 contentDigest（去掉 contentDigest 自身后做规范 JSON 摘要）。
fn manifest_content_digest(manifest: &Value) -> Result<String, &'static str> {
    let mut copy = manifest.clone();
    copy.as_object_mut().ok_or("experience_manifest_invalid")?.remove("contentDigest");
    canonical_json(&copy).map(|text| digest(&text)).map_err(|_| "experience_manifest_invalid")
}

fn experience_id(project_id: &str, revision: u64) -> String {
    let seed = canonical_json(&json!({"projectId": project_id, "revision": revision})).unwrap_or_default();
    let digest = digest(&seed);
    format!("experience-{}", &digest[7..23.min(digest.len())])
}

fn read_layout_snapshot(home: &Path, city_id: &str, city_revision: u64, world_revision: &str, layout_id: &str) -> Result<Value, &'static str> {
    let db = database(home)?;
    let raw: Option<String> = db.query_row("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 AND city_revision=?2 AND world_revision=?3 AND layout_id=?4",
        rusqlite::params![city_id, city_revision, world_revision, layout_id], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?;
    raw.map(|text| serde_json::from_str(&text).map_err(|_| "creator_layout_snapshot_invalid")).transpose()?.ok_or("creator_layout_not_found")
}

/// 打包一个已发布 release。返回摘要（不含任何路径——路径不出宿主）。
pub(crate) fn build_experience(home: &Path, release_id: &str, version: &str) -> Result<Value, &'static str> {
    if !valid_id(release_id) || !valid_version(version) { return Err("creator_experience_invalid"); }
    let db = database(home)?;
    let (project_id, revision, release_layout_id, release_world_revision, snapshot_raw): (String, u64, String, String, String) = db.query_row(
        "SELECT project_id,revision,layout_id,world_revision,snapshot_json FROM creator_releases WHERE release_id=?1", [release_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).optional().map_err(|_| "creator_store_unavailable")?
        .ok_or("release_not_found")?;
    let snapshot: Value = serde_json::from_str(&snapshot_raw).map_err(|_| "release_snapshot_invalid")?;
    let city_id = snapshot["cityId"].as_str().filter(|id| valid_id(id)).ok_or("creator_experience_city_scope_missing")?;
    let city_revision = snapshot["cityRevision"].as_u64().ok_or("creator_experience_city_scope_missing")?;
    let world_revision = snapshot["worldRevision"].as_str().unwrap_or(&release_world_revision);
    let layout_id = snapshot["layoutId"].as_str().or(snapshot["cityLayoutId"].as_str()).unwrap_or(&release_layout_id);
    let layout = read_layout_snapshot(home, city_id, city_revision, world_revision, layout_id)?;
    // 没有锚点几何的布局在干净客户端上无法定位门——不能算可交付。
    if layout["schemaVersion"].as_u64() != Some(3) || !layout["geometry"].is_array() || !layout["layout"]["anchors"].is_array() {
        return Err("experience_layout_incomplete");
    }
    let city_document: Option<String> = db.query_row("SELECT document_json FROM creator_city_revisions WHERE city_id=?1 AND revision=?2",
        rusqlite::params![city_id, city_revision], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?;
    let city_document = match city_document {
        Some(text) => text,
        None => db.query_row("SELECT document_json FROM creator_cities WHERE city_id=?1", [city_id], |row| row.get(0)).map_err(|_| "creator_store_unavailable")?,
    };
    let city: Value = serde_json::from_str(&city_document).map_err(|_| "creator_store_unavailable")?;
    drop(db);

    let id = experience_id(&project_id, revision);
    let final_dir = experience_root(home).join(&id).join(version);
    let staging = experience_root(home).join(format!(".staging-{}-{}", now_ms(), std::process::id()));
    std::fs::create_dir_all(staging.join("assets")).map_err(|_| "experience_store_unavailable")?;
    let mut files: Vec<Value> = Vec::new();
    let mut assets: Vec<Value> = Vec::new();
    let mut write_file = |relative: &str, bytes: &[u8]| -> Result<(), &'static str> {
        if bytes.len() as u64 > MAX_FILE_BYTES { return Err("experience_package_too_large"); }
        let target = staging.join(relative);
        if let Some(parent) = target.parent() { std::fs::create_dir_all(parent).map_err(|_| "experience_store_unavailable")?; }
        std::fs::write(&target, bytes).map_err(|_| "experience_store_unavailable")?;
        files.push(json!({"path": relative, "digest": bytes_digest(bytes), "byteLength": bytes.len()}));
        Ok(())
    };
    let cleanup = |code| { let _ = std::fs::remove_dir_all(&staging); code };
    if let Err(code) = write_file("release.json", snapshot_raw.as_bytes()) { return Err(cleanup(code)); }
    let layout_raw = canonical_json(&layout).map_err(|_| cleanup("experience_layout_incomplete"))?;
    if let Err(code) = write_file("layout.json", layout_raw.as_bytes()) { return Err(cleanup(code)); }
    for entry in snapshot["assets"]["entries"].as_array().cloned().unwrap_or_default() {
        let sha = entry["sha256"].as_str().filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())).ok_or_else(|| cleanup("experience_asset_entry_invalid"))?;
        let byte_length = entry["byteLength"].as_u64().ok_or_else(|| cleanup("experience_asset_entry_invalid"))?;
        let source = home.join("state/creator/projects").join(&project_id).join("assets").join(format!("{sha}.glb"));
        let bytes = std::fs::read(&source).map_err(|_| cleanup("experience_asset_missing"))?;
        if bytes.len() as u64 != byte_length || bytes_digest(&bytes) != format!("sha256:{sha}") { return Err(cleanup("experience_asset_digest_mismatch")); }
        let relative = format!("assets/{sha}.glb");
        if let Err(code) = write_file(&relative, &bytes) { return Err(cleanup(code)); }
        assets.push(json!({"assetId": entry["assetId"], "relativePath": entry["relativePath"], "sha256": sha,
            "byteLength": byte_length, "format": entry["format"].as_str().unwrap_or("glb-v2"), "packagePath": relative}));
    }
    if files.len() > MAX_FILES { return Err(cleanup("experience_package_too_large")); }
    let mut manifest = json!({
        "schemaVersion": 1, "kind": "city-experience", "experienceId": id, "version": version,
        "world": {"cityId": city_id, "cityRevision": city_revision, "seed": city["seed"].as_u64().unwrap_or(layout["seed"].as_u64().unwrap_or(0)),
            "profile": city["profile"].as_str().unwrap_or(""), "worldRevision": world_revision, "layoutId": layout_id,
            "layoutRevision": layout["layout"]["id"]},
        "release": {"releaseId": release_id, "projectId": project_id, "revision": revision,
            "gameType": snapshot["gameType"], "vehicleId": snapshot["vehicleId"]},
        "assets": assets, "files": files,
    });
    let content_digest = manifest_content_digest(&manifest).map_err(&cleanup)?;
    manifest["contentDigest"] = json!(content_digest);
    let manifest_text = serde_json::to_string_pretty(&manifest).map_err(|_| cleanup("experience_manifest_invalid"))?;
    if std::fs::write(staging.join("manifest.json"), format!("{manifest_text}\n")).is_err() { return Err(cleanup("experience_store_unavailable")); }
    let byte_length: u64 = files.iter().filter_map(|file| file["byteLength"].as_u64()).sum();

    // 幂等：同 id+version 同摘要 → 已构建；不同摘要 → 冲突，绝不覆盖一份已存在的包。
    if final_dir.join("manifest.json").exists() {
        let existing = read_json(&final_dir.join("manifest.json"), "experience_manifest_invalid")?;
        if existing["contentDigest"].as_str() != Some(content_digest.as_str()) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err("experience_digest_conflict");
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Ok(json!({"experienceId": id, "version": version, "contentDigest": content_digest, "alreadyBuilt": true,
            "fileCount": files.len(), "byteLength": byte_length, "assetCount": assets.len(),
            "anchorCount": layout["layout"]["anchors"].as_array().map_or(0, Vec::len)}));
    }
    if let Some(parent) = final_dir.parent() { std::fs::create_dir_all(parent).map_err(|_| cleanup("experience_store_unavailable"))?; }
    if std::fs::rename(&staging, &final_dir).is_err() { let _ = std::fs::remove_dir_all(&staging); return Err("experience_store_unavailable"); }
    Ok(json!({"experienceId": id, "version": version, "contentDigest": content_digest, "alreadyBuilt": false,
        "fileCount": files.len(), "byteLength": byte_length, "assetCount": assets.len(),
        "anchorCount": layout["layout"]["anchors"].as_array().map_or(0, Vec::len)}))
}

/// 重新校验一份已构建/已安装的包。返回 (manifest, 文件总字节数)。路径只用于本地读取。
fn verify_package(dir: &Path) -> Result<(Value, u64), &'static str> {
    let manifest = read_json(&dir.join("manifest.json"), "experience_manifest_missing")?;
    if manifest["schemaVersion"].as_u64() != Some(1) || manifest["kind"].as_str() != Some("city-experience") { return Err("experience_kind_unsupported"); }
    let files = manifest["files"].as_array().filter(|files| !files.is_empty() && files.len() <= MAX_FILES).ok_or("experience_manifest_invalid")?;
    let expected_digest = manifest["contentDigest"].as_str().ok_or("experience_manifest_invalid")?;
    if manifest_content_digest(&manifest)? != expected_digest { return Err("experience_digest_mismatch"); }
    let mut total = 0u64;
    for file in files {
        let relative = file["path"].as_str().ok_or("experience_manifest_invalid")?;
        if relative.is_empty() || relative.contains("..") || relative.starts_with('/') { return Err("experience_manifest_invalid"); }
        let declared = file["digest"].as_str().ok_or("experience_manifest_invalid")?;
        let declared_length = file["byteLength"].as_u64().ok_or("experience_manifest_invalid")?;
        let bytes = std::fs::read(dir.join(relative)).map_err(|_| "experience_file_missing")?;
        if bytes.len() as u64 != declared_length || bytes_digest(&bytes) != declared { return Err("experience_file_digest_mismatch"); }
        total = total.saturating_add(declared_length);
    }
    let layout = read_json(&dir.join("layout.json"), "experience_file_missing")?;
    if layout["schemaVersion"].as_u64() != Some(3) || !layout["geometry"].is_array() { return Err("experience_layout_incomplete"); }
    Ok((manifest, total))
}

pub(crate) fn list_experiences(home: &Path) -> Result<Value, &'static str> {
    let root = experience_root(home);
    let db = database(home)?;
    let mut installed: std::collections::HashMap<(String, String), u64> = std::collections::HashMap::new();
    {
        let mut statement = db.prepare("SELECT package_id,version,installed_at_ms FROM creator_content_packages WHERE kind='city-experience'")
            .map_err(|_| "creator_store_unavailable")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, u64>(2)?)))
            .map_err(|_| "creator_store_unavailable")?;
        for row in rows { let (id, version, at) = row.map_err(|_| "creator_store_unavailable")?; installed.insert((id, version), at); }
    }
    let mut entries: Vec<Value> = Vec::new();
    if let Ok(ids) = std::fs::read_dir(&root) {
        for id in ids.flatten().filter(|entry| entry.path().is_dir()) {
            let Ok(name) = id.file_name().into_string() else { continue };
            if name.starts_with('.') { continue; }
            if let Ok(versions) = std::fs::read_dir(id.path()) {
                for version in versions.flatten().filter(|entry| entry.path().is_dir()) {
                    let Ok(version_name) = version.file_name().into_string() else { continue };
                    let Ok(manifest) = read_json(&version.path().join("manifest.json"), "experience_manifest_invalid") else { continue };
                    let installed_at = installed.get(&(name.clone(), version_name.clone())).copied();
                    entries.push(json!({"experienceId": name, "version": version_name,
                        "contentDigest": manifest["contentDigest"], "gameType": manifest["release"]["gameType"],
                        "releaseId": manifest["release"]["releaseId"], "fileCount": manifest["files"].as_array().map_or(0, Vec::len),
                        "installed": installed_at.is_some(), "installedAtMs": installed_at}));
                }
            }
        }
    }
    entries.sort_by(|left, right| left["experienceId"].as_str().cmp(&right["experienceId"].as_str())
        .then(left["version"].as_str().cmp(&right["version"].as_str())));
    entries.truncate(128);
    Ok(json!({"experiences": entries}))
}

/// 把已构建的包登记进共享内容库（`creator_content_packages`，kind=city-experience），并把
/// 目录原子复制到 `<home>/state/creator/content/experience/<id>/<version>`。
pub(crate) fn install_experience(home: &Path, experience_id: &str, version: &str) -> Result<Value, &'static str> {
    if !valid_id(experience_id) || !safe_component(version) { return Err("creator_experience_invalid"); }
    let source = experience_root(home).join(experience_id).join(version);
    let (manifest, byte_length) = verify_package(&source)?;
    let manifest_json = serde_json::to_string(&manifest).map_err(|_| "experience_manifest_invalid")?;
    let content_digest = manifest["contentDigest"].as_str().unwrap_or_default().to_owned();
    let relative = format!("experience/{experience_id}/{version}/manifest.json");
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let existing: Option<(String, String)> = tx.query_row("SELECT content_digest,package_path FROM creator_content_packages WHERE package_id=?1 AND version=?2",
        rusqlite::params![experience_id, version], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?;
    let installed_at = now_ms();
    if let Some((digest, path)) = existing {
        if digest != content_digest || path != relative { return Err("experience_digest_conflict"); }
        tx.commit().map_err(|_| "creator_store_unavailable")?;
        return Ok(json!({"experienceId": experience_id, "version": version, "contentDigest": content_digest, "alreadyInstalled": true, "installedAtMs": installed_at}));
    }
    let final_dir = content_root(home).join("experience").join(experience_id).join(version);
    let staging = content_root(home).join(format!(".staging-experience-{}-{}", now_ms(), std::process::id()));
    copy_dir(&source, &staging)?;
    if final_dir.exists() { let _ = std::fs::remove_dir_all(&final_dir); }
    if let Some(parent) = final_dir.parent() { std::fs::create_dir_all(parent).map_err(|_| "experience_store_unavailable")?; }
    if std::fs::rename(&staging, &final_dir).is_err() { let _ = std::fs::remove_dir_all(&staging); return Err("experience_store_unavailable"); }
    let file_count = manifest["files"].as_array().map_or(0, Vec::len) as u64;
    let insert = tx.execute("INSERT INTO creator_content_packages(package_id,version,kind,content_digest,manifest_json,package_path,file_count,byte_length,installed_at_ms) VALUES(?1,?2,'city-experience',?3,?4,?5,?6,?7,?8)",
        rusqlite::params![experience_id, version, content_digest, manifest_json, relative, file_count, byte_length, installed_at]);
    if insert.is_err() { let _ = std::fs::remove_dir_all(&final_dir); return Err("creator_store_unavailable"); }
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"experienceId": experience_id, "version": version, "contentDigest": content_digest, "alreadyInstalled": false, "installedAtMs": installed_at}))
}

fn copy_dir(source: &Path, target: &Path) -> Result<(), &'static str> {
    std::fs::create_dir_all(target).map_err(|_| "experience_store_unavailable")?;
    let entries = std::fs::read_dir(source).map_err(|_| "experience_manifest_missing")?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if entry.file_type().map_err(|_| "experience_store_unavailable")?.is_dir() { copy_dir(&path, &target.join(&name))?; }
        else { std::fs::copy(&path, target.join(&name)).map_err(|_| "experience_store_unavailable")?; }
    }
    Ok(())
}

/// 把已构建（或已安装）的体验包复制到用户选择的目录。选择器在 `plugin_host` 里开，
/// 这里只负责"从哪个目录复制、复制到哪、失败怎么收拾"——返回值不含路径。
pub(crate) fn export_experience(home: &Path, parent: &Path, payload: &Value) -> Result<Value, &'static str> {
    let experience_id = payload["experienceId"].as_str().filter(|id| valid_id(id)).ok_or("creator_experience_invalid")?;
    let version = payload["version"].as_str().filter(|v| safe_component(v)).ok_or("creator_experience_invalid")?;
    let built = experience_root(home).join(experience_id).join(version);
    let installed = content_root(home).join("experience").join(experience_id).join(version);
    let source = if built.join("manifest.json").exists() { built } else if installed.join("manifest.json").exists() { installed } else { return Err("experience_not_found"); };
    let (manifest, byte_length) = verify_package(&source)?;
    let content_digest = manifest["contentDigest"].as_str().unwrap_or_default().to_owned();
    let file_count = manifest["files"].as_array().map_or(0, Vec::len) as u64;
    let directory = parent.join(format!("{experience_id}-{version}"));
    // 不覆盖用户已有的目录：导出是"给出一份新副本"，不是同步。
    if directory.exists() { return Err("experience_export_target_exists"); }
    let staging = parent.join(format!(".{experience_id}-{version}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    copy_dir(&source, &staging)?;
    if std::fs::rename(&staging, &directory).is_err() { let _ = std::fs::remove_dir_all(&staging); return Err("experience_store_unavailable"); }
    Ok(json!({"exported": true, "experienceId": experience_id, "version": version,
        "contentDigest": content_digest, "fileCount": file_count, "byteLength": byte_length}))
}

pub(crate) fn uninstall_experience(home: &Path, experience_id: &str, version: &str) -> Result<Value, &'static str> {
    if !valid_id(experience_id) || !safe_component(version) { return Err("creator_experience_invalid"); }
    let db = database(home)?;
    let removed = db.execute("DELETE FROM creator_content_packages WHERE package_id=?1 AND version=?2 AND kind='city-experience'",
        rusqlite::params![experience_id, version]).map_err(|_| "creator_store_unavailable")?;
    let dir = content_root(home).join("experience").join(experience_id).join(version);
    if dir.exists() { std::fs::remove_dir_all(&dir).map_err(|_| "experience_store_unavailable")?; }
    Ok(json!({"experienceId": experience_id, "version": version, "removed": removed == 1}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        // 并行测试同毫秒会撞名（撞上就两个测试共享库、互相 UNIQUE 冲突）——加进程内序号。
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!("creator-experience-{}-{}-{}", now_ms(), std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_release(home: &Path, layout_version: u64) -> (String, String) {
        let created = crate::creator_cities::create_city(home, "local-profile", "create-exp", "Exp City", 42, &json!({"schemaVersion":1})).unwrap();
        let city_id = created["cityId"].as_str().unwrap().to_owned();
        let layout = json!({"schemaVersion": 1, "id": "layout-exp", "coordinateSystem": "city-local-m-v1",
            "anchors": [{"id": "spawn-air", "kind": "spawn", "capabilities": ["fly"], "geometryRef": "creator-air:spawn"},
                {"id": "air-gate:1", "kind": "zone", "capabilities": ["fly"], "geometryRef": "creator-air:g1"}],
            "links": [{"id": "l1", "fromAnchorId": "spawn-air", "toAnchorId": "air-gate:1", "capabilities": ["fly"]}]});
        let mut snapshot = json!({"schemaVersion": 2, "cityId": city_id, "cityRevision": 0, "worldRevision": "world-exp", "seed": 42, "layout": layout});
        if layout_version >= 3 {
            snapshot["schemaVersion"] = json!(3);
            snapshot["geometry"] = json!([{"geometryRef": "creator-air:spawn", "positionMeters": {"x": 0, "y": 40, "z": 0}},
                {"geometryRef": "creator-air:g1", "positionMeters": {"x": 150, "y": 40, "z": 0}, "activationRadiusMeters": 20}]);
        }
        crate::creator_city_patch::store_scoped_city_layout(home, &snapshot).unwrap();
        let game = json!({"schemaVersion": 1, "id": "creator.race", "rulesVersion": 1, "slots": {"gates": {"kind": "zone", "min": 1, "max": 1, "requires": ["fly"]}}, "rules": {"nodes": []}});
        let game_digest = digest(&canonical_json(&game).unwrap());
        let release = json!({"projectId": "project-exp", "revision": 0, "title": "Exp", "gameType": "flight", "vehicleId": "vehicle-exp",
            "vehicle": {"schemaVersion": 1, "id": "vehicle-exp"}, "skinId": "miami-vice", "game": game,
            "scene": {"schemaVersion": 1, "objects": []}, "assets": {"schemaVersion": 1, "entries": []}, "assetRefs": [],
            "layoutId": "layout-exp", "worldRevision": "world-exp", "cityId": city_id, "cityRevision": 0, "cityLayoutId": "layout-exp",
            "mounts": [{"schemaVersion": 1, "mountId": "mount-exp", "entryAnchorId": "spawn-air", "bindings": {"gates": ["air-gate:1"]},
                "game": {"kind": "city-minigame", "id": game["id"], "version": "1", "digest": game_digest}}]});
        let db = database(home).unwrap();
        db.execute("INSERT INTO creator_releases(release_id,project_id,revision,layout_id,world_revision,snapshot_json,snapshot_digest,created_at_ms) VALUES(?1,?2,0,?3,?4,?5,?6,?7)",
            rusqlite::params!["release-exp", "project-exp", "layout-exp", "world-exp", release.to_string(), digest(&release.to_string()), now_ms()]).unwrap();
        (city_id, "release-exp".to_owned())
    }

    #[test]
    fn builds_a_self_contained_package_and_is_idempotent() {
        let dir = home();
        let (_city, release_id) = seed_release(&dir, 3);
        let built = build_experience(&dir, &release_id, "1.0.0").unwrap();
        assert_eq!(built["alreadyBuilt"], false);
        assert_eq!(built["fileCount"], 2, "release.json + layout.json");
        assert_eq!(built["assetCount"], 0);
        let id = built["experienceId"].as_str().unwrap();
        assert!(id.starts_with("experience-"));
        let package = dir.join("state/creator/experience").join(id).join("1.0.0");
        assert!(package.join("manifest.json").exists() && package.join("release.json").exists() && package.join("layout.json").exists());
        let again = build_experience(&dir, &release_id, "1.0.0").unwrap();
        assert_eq!(again["alreadyBuilt"], true);
        assert_eq!(again["contentDigest"], built["contentDigest"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_a_v2_layout() {
        let dir = home();
        let (_city, release_id) = seed_release(&dir, 2);
        assert_eq!(build_experience(&dir, &release_id, "1.0.0").unwrap_err(), "experience_layout_incomplete");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn install_verifies_registers_lists_and_uninstalls() {
        let dir = home();
        let (_city, release_id) = seed_release(&dir, 3);
        let built = build_experience(&dir, &release_id, "1.0.0").unwrap();
        let id = built["experienceId"].as_str().unwrap().to_owned();
        let installed = install_experience(&dir, &id, "1.0.0").unwrap();
        assert_eq!(installed["alreadyInstalled"], false);
        assert!(dir.join("state/creator/content/experience").join(&id).join("1.0.0").join("manifest.json").exists());
        assert_eq!(install_experience(&dir, &id, "1.0.0").unwrap()["alreadyInstalled"], true);
        let listed = list_experiences(&dir).unwrap();
        assert_eq!(listed["experiences"][0]["experienceId"], id);
        assert_eq!(listed["experiences"][0]["installed"], true);
        let removed = uninstall_experience(&dir, &id, "1.0.0").unwrap();
        assert_eq!(removed["removed"], true);
        assert!(!dir.join("state/creator/content/experience").join(&id).join("1.0.0").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn exports_to_a_chosen_directory_without_overwriting() {
        let dir = home();
        let (_city, release_id) = seed_release(&dir, 3);
        let built = build_experience(&dir, &release_id, "1.0.0").unwrap();
        let id = built["experienceId"].as_str().unwrap().to_owned();
        let destination = dir.join("export");
        std::fs::create_dir_all(&destination).unwrap();
        let exported = export_experience(&dir, &destination, &json!({"experienceId": id, "version": "1.0.0"})).unwrap();
        assert_eq!(exported["exported"], true);
        assert_eq!(exported["contentDigest"], built["contentDigest"]);
        let copy = destination.join(format!("{id}-1.0.0"));
        assert!(copy.join("manifest.json").exists() && copy.join("layout.json").exists());
        assert!(!exported.to_string().contains(destination.to_string_lossy().as_ref()), "export must not leak the path");
        assert_eq!(export_experience(&dir, &destination, &json!({"experienceId": id, "version": "1.0.0"})).unwrap_err(),
            "experience_export_target_exists");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tampered_bytes_are_refused_on_install() {
        let dir = home();
        let (_city, release_id) = seed_release(&dir, 3);
        let built = build_experience(&dir, &release_id, "1.0.0").unwrap();
        let id = built["experienceId"].as_str().unwrap().to_owned();
        let package = dir.join("state/creator/experience").join(&id).join("1.0.0");
        let mut layout = std::fs::read(package.join("layout.json")).unwrap();
        layout.truncate(layout.len() - 2);
        std::fs::write(package.join("layout.json"), layout).unwrap();
        assert_eq!(install_experience(&dir, &id, "1.0.0").unwrap_err(), "experience_file_digest_mismatch");
        let _ = std::fs::remove_dir_all(dir);
    }
}
