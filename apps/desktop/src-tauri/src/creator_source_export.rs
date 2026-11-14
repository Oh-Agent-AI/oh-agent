//! Bounded filesystem sink for the trusted Studio's source export projection.
//! Studio owns City/game serialization; this module handles only fixed paths,
//! scoped asset bytes, revision checks and an explicit native destination.
use serde_json::{json, Value};
use std::{collections::HashSet, io::Write, path::Path};
use crate::creator_store::{bytes_digest, new_id, valid_id};

pub(crate) const REQUIRED: &[&str] = &["README.md", ".gitignore", "world/world.json", "games/game/game.json", "games/game/layout.json", "games/game/mount.json", "games/game/scene.json", "games/game/assets/catalog.json"];
const MAX_TEXT: usize = 4 * 1024 * 1024;
const MAX_ASSETS: usize = 64;
const MAX_ASSET_TOTAL: u64 = 128 * 1024 * 1024;

fn hash(value: &str) -> Option<&str> {
    value.strip_prefix("sha256:").filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

#[cfg(any(target_vendor = "apple", target_os = "linux", target_os = "android"))]
fn commit_directory(from: &Path, to: &Path) -> Result<(), &'static str> {
    rustix::fs::renameat_with(rustix::fs::CWD, from, rustix::fs::CWD, to, rustix::fs::RenameFlags::NOREPLACE)
        .map_err(|_| "creator_export_write_failed")
}
#[cfg(target_os = "windows")]
fn commit_directory(from: &Path, to: &Path) -> Result<(), &'static str> {
    std::fs::rename(from, to).map_err(|_| "creator_export_write_failed")
}
#[cfg(not(any(target_vendor = "apple", target_os = "linux", target_os = "android", target_os = "windows")))]
fn commit_directory(_from: &Path, _to: &Path) -> Result<(), &'static str> { Err("creator_export_unsupported") }

pub(crate) fn export_source(home: &Path, parent: &Path, payload: &Value) -> Result<Value, &'static str> {
    let object = payload.as_object().filter(|v| v.len() == 4).ok_or("creator_export_invalid")?;
    let project_id = object.get("projectId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_export_invalid")?;
    let revision = object.get("revision").and_then(Value::as_u64).ok_or("creator_export_invalid")?;
    let files = object.get("files").and_then(Value::as_object).ok_or("creator_export_invalid")?;
    if files.len() < REQUIRED.len() || files.len() > REQUIRED.len() + 1 || !REQUIRED.iter().all(|key| files.contains_key(*key))
        || files.keys().any(|key| !REQUIRED.contains(&key.as_str()) && key != "world/plan-patch.json") { return Err("creator_export_invalid"); }
    let mut total = 0usize;
    for value in files.values() {
        let value = value.as_str().ok_or("creator_export_invalid")?;
        total = total.checked_add(value.len()).ok_or("creator_export_too_large")?;
        if total > MAX_TEXT { return Err("creator_export_too_large"); }
    }
    let digests = object.get("assetDigests").and_then(Value::as_array).filter(|v| v.len() <= MAX_ASSETS).ok_or("creator_export_invalid")?;
    let mut requested = HashSet::new();
    for value in digests { let value = value.as_str().filter(|v| hash(v).is_some()).ok_or("creator_export_invalid")?; if !requested.insert(value.to_owned()) { return Err("creator_export_invalid"); } }
    let project = crate::creator_projects::read_project(home, project_id)?;
    if project.get("revision").and_then(Value::as_u64) != Some(revision) { return Err("revision_conflict"); }
    if project.get("cityId").and_then(Value::as_str).filter(|id| valid_id(id)).is_none() { return Err("creator_export_city_required"); }
    let entries = project.get("assets").and_then(|v| v.get("entries")).and_then(Value::as_array).ok_or("creator_export_invalid")?;
    if entries.len() != requested.len() { return Err("creator_export_asset_mismatch"); }
    let mut assets = Vec::new();
    let mut total_asset = 0u64;
    for entry in entries {
        let digest = entry.get("sha256").and_then(Value::as_str).filter(|v| requested.contains(*v)).ok_or("creator_export_asset_mismatch")?;
        let name = hash(digest).ok_or("creator_export_invalid")?;
        let size = entry.get("byteLength").and_then(Value::as_u64).filter(|n| *n <= 64 * 1024 * 1024).ok_or("creator_export_asset_mismatch")?;
        total_asset = total_asset.checked_add(size).ok_or("creator_export_too_large")?;
        if total_asset > MAX_ASSET_TOTAL { return Err("creator_export_too_large"); }
        let path = home.join("state/creator/projects").join(project_id).join("assets").join(format!("{name}.glb"));
        let info = std::fs::symlink_metadata(&path).map_err(|_| "creator_export_asset_missing")?;
        if !info.file_type().is_file() || info.file_type().is_symlink() || info.len() != size { return Err("creator_export_asset_mismatch"); }
        let bytes = std::fs::read(path).map_err(|_| "creator_export_asset_missing")?;
        if bytes.len() as u64 != size || bytes_digest(&bytes) != digest { return Err("creator_export_asset_mismatch"); }
        crate::creator_assets::inspect_glb(&bytes)?;
        assets.push((format!("{name}.glb"), bytes));
    }
    let info = std::fs::symlink_metadata(parent).map_err(|_| "creator_export_destination_invalid")?;
    if !info.is_dir() || info.file_type().is_symlink() { return Err("creator_export_destination_invalid"); }
    let name = new_id("city-source-")?;
    let staging = parent.join(format!(".{name}.tmp"));
    let final_path = parent.join(&name);
    std::fs::create_dir(&staging).map_err(|_| "creator_export_write_failed")?;
    let result = (|| -> Result<(), &'static str> {
        for dir in ["world", "games", "games/game", "games/game/assets", "design", "tests"] {
            std::fs::create_dir(staging.join(dir)).map_err(|_| "creator_export_write_failed")?;
        }
        for (path, value) in files {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(staging.join(path)).map_err(|_| "creator_export_write_failed")?;
            file.write_all(value.as_str().ok_or("creator_export_invalid")?.as_bytes()).map_err(|_| "creator_export_write_failed")?;
        }
        for (name, bytes) in assets {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(staging.join("games/game/assets").join(name)).map_err(|_| "creator_export_write_failed")?;
            file.write_all(&bytes).map_err(|_| "creator_export_write_failed")?;
        }
        commit_directory(&staging, &final_path)?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_dir_all(&staging); }
    result?;
    Ok(json!({"directoryName":name,"assetCount":requested.len(),"projectRevision":revision}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::creator_store::{database, now_ms};

    fn fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(new_id("creator-source-test-").unwrap());
        std::fs::create_dir(&dir).unwrap();
        let db = database(&dir).unwrap();
        let document = json!({"projectId":"project-test","revision":3,"cityId":"city-test","assets":{"schemaVersion":1,"entries":[]}});
        db.execute("INSERT INTO creator_projects(project_id,revision,document_json,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?4)",
            rusqlite::params!["project-test",3,document.to_string(),now_ms()]).unwrap();
        dir
    }
    fn payload() -> Value {
        let mut files = serde_json::Map::new();
        for name in REQUIRED { files.insert((*name).to_owned(), json!("{}\n")); }
        json!({"projectId":"project-test","revision":3,"files":files,"assetDigests":[]})
    }
    #[test]
    fn source_export_is_scoped_and_refuses_stale_or_unsafe_input() {
        let home = fixture();
        let destination = home.join("destination");
        std::fs::create_dir(&destination).unwrap();
        let output = export_source(&home, &destination, &payload()).unwrap();
        let root = destination.join(output["directoryName"].as_str().unwrap());
        assert_eq!(std::fs::read_to_string(root.join("world/world.json")).unwrap(), "{}\n");
        assert!(root.join("games/game/mount.json").is_file());
        assert!(root.join("design").is_dir());
        assert_eq!(export_source(&home, &destination, &json!({"projectId":"project-test","revision":4,"files":payload()["files"],"assetDigests":[]})).unwrap_err(), "revision_conflict");
        let mut unsafe_payload = payload(); unsafe_payload["files"]["../outside"] = json!("escape");
        assert_eq!(export_source(&home, &destination, &unsafe_payload).unwrap_err(), "creator_export_invalid");
        assert!(!home.join("outside").exists());
        let mut missing_asset = payload(); missing_asset["assetDigests"] = json!([format!("sha256:{}", "a".repeat(64))]);
        assert_eq!(export_source(&home, &destination, &missing_asset).unwrap_err(), "creator_export_asset_mismatch");
        let _ = std::fs::remove_dir_all(home);
    }
    #[test]
    fn final_directory_never_replaces_existing_content() {
        let home = fixture();
        let stage = home.join("stage"); let final_path = home.join("final");
        std::fs::create_dir(&stage).unwrap(); std::fs::create_dir(&final_path).unwrap();
        std::fs::write(final_path.join("keep"), "user data").unwrap();
        assert!(commit_directory(&stage, &final_path).is_err());
        assert_eq!(std::fs::read_to_string(final_path.join("keep")).unwrap(), "user data");
        assert!(stage.is_dir());
        let _ = std::fs::remove_dir_all(home);
    }
}
