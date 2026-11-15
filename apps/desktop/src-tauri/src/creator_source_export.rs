//! Bounded filesystem sink for the trusted Studio's source export projection.
//! Studio owns City/game serialization; this module handles only fixed paths,
//! scoped asset bytes, revision checks and an explicit native destination.
use serde_json::{json, Value};
use std::{collections::HashSet, io::Write, path::Path};
use crate::creator_store::{bytes_digest, new_id, valid_id};

pub(crate) const REQUIRED: &[&str] = &["README.md", ".gitignore", "world/world.json", "games/game/game.json", "games/game/layout.json", "games/game/scene.json", "games/game/assets/catalog.json"];
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
    if files.len() < REQUIRED.len() || files.len() > REQUIRED.len() + 2 || !REQUIRED.iter().all(|key| files.contains_key(*key))
        || files.keys().any(|key| !REQUIRED.contains(&key.as_str()) && !matches!(key.as_str(), "world/plan-patch.json" | "games/game/mount.json")) { return Err("creator_export_invalid"); }
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
    let mounts = project.get("mounts").and_then(Value::as_array).ok_or("creator_export_invalid")?;
    if mounts.len() > 1 || files.contains_key("games/game/mount.json") != (mounts.len() == 1) { return Err("creator_export_mount_mismatch"); }
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
    let name = write_source(parent, files, Vec::new(), assets, true)?;
    Ok(json!({"directoryName":name,"assetCount":requested.len(),"projectRevision":revision}))
}

pub(crate) fn export_city_source(home: &Path, parent: &Path, payload: &Value) -> Result<Value, &'static str> {
    let object = payload.as_object().filter(|v| v.len() == 4).ok_or("creator_export_invalid")?;
    let city_id = object.get("cityId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("creator_export_invalid")?;
    let revision = object.get("revision").and_then(Value::as_u64).ok_or("creator_export_invalid")?;
    let files = object.get("files").and_then(Value::as_object).ok_or("creator_export_invalid")?;
    let digests = object.get("assetDigests").and_then(Value::as_array).filter(|v| v.len() <= MAX_ASSETS).ok_or("creator_export_invalid")?;
    let mut requested = HashSet::new();
    for value in digests { let value = value.as_str().filter(|v| hash(v).is_some()).ok_or("creator_export_invalid")?; if !requested.insert(value.to_owned()) { return Err("creator_export_invalid"); } }
    const CITY_REQUIRED: &[&str] = &["README.md", ".gitignore", "world/world.json"];
    if files.len() < CITY_REQUIRED.len() || files.len() > CITY_REQUIRED.len() + 1 || !CITY_REQUIRED.iter().all(|key| files.contains_key(*key))
        || files.keys().any(|key| !CITY_REQUIRED.contains(&key.as_str()) && key != "world/plan-patch.json") { return Err("creator_export_invalid"); }
    let mut total = 0usize;
    for value in files.values() {
        total = total.checked_add(value.as_str().ok_or("creator_export_invalid")?.len()).ok_or("creator_export_too_large")?;
        if total > MAX_TEXT { return Err("creator_export_too_large"); }
    }
    let city = crate::creator_cities::read_city(home, city_id)?;
    if city.get("revision").and_then(Value::as_u64) != Some(revision) { return Err("revision_conflict"); }
    let mut source_files = files.clone();
    let mut world_assets = Vec::new();
    let pinned = crate::creator_cities::read_world_package_ref(home, city_id)?;
    if let Some(reference) = pinned.get("worldPackage").filter(|v| !v.is_null()) {
        let package_id = reference.get("packageId").and_then(Value::as_str).ok_or("content_store_corrupt")?;
        let version = reference.get("version").and_then(Value::as_str).ok_or("content_store_corrupt")?;
        let content_digest = reference.get("contentDigest").and_then(Value::as_str).ok_or("content_store_corrupt")?;
        let checked = crate::creator_content_install::read_installed_world(home, package_id, version)?;
        let manifest = &checked.manifest;
        if manifest.get("contentDigest").and_then(Value::as_str) != Some(content_digest) { return Err("content_store_corrupt"); }
        let entry = manifest.get("entry").ok_or("content_store_corrupt")?;
        let scene_path = entry.get("scene").and_then(Value::as_str).ok_or("content_store_corrupt")?;
        let catalog_path = entry.get("assets").and_then(Value::as_str).ok_or("content_store_corrupt")?;
        let scene = checked.files.get(scene_path).ok_or("content_store_corrupt")?;
        let catalog_bytes = checked.files.get(catalog_path).ok_or("content_store_corrupt")?;
        let scene_text = std::str::from_utf8(scene).map_err(|_| "content_store_corrupt")?;
        let catalog_text = std::str::from_utf8(catalog_bytes).map_err(|_| "content_store_corrupt")?;
        let catalog: Value = serde_json::from_slice(catalog_bytes).map_err(|_| "content_store_corrupt")?;
        if catalog.get("schemaVersion").and_then(Value::as_u64) != Some(1) || catalog.as_object().is_none_or(|v| v.len() != 2) { return Err("content_store_corrupt"); }
        let entries = catalog.get("entries").and_then(Value::as_array).ok_or("content_store_corrupt")?;
        if entries.len() > MAX_ASSETS || entries.len() != requested.len() { return Err("creator_export_asset_mismatch"); }
        let mut catalog_digests = HashSet::new();
        let mut total_asset = 0u64;
        for item in entries {
            let fields = item.as_object().filter(|v| (5..=6).contains(&v.len()) && v.keys().all(|key| matches!(key.as_str(), "assetId" | "relativePath" | "sha256" | "byteLength" | "format" | "boundsMeters"))).ok_or("content_store_corrupt")?;
            let asset_id = item.get("assetId").and_then(Value::as_str).ok_or("content_store_corrupt")?;
            if !valid_id(asset_id) || item.get("format").and_then(Value::as_str) != Some("glb-v2") || (fields.len() == 6 && !fields.contains_key("boundsMeters")) { return Err("content_store_corrupt"); }
            if let Some(bounds) = item.get("boundsMeters") {
                if !bounds.is_object() || bounds.as_object().is_none_or(|v| v.len() != 3 || !["x", "y", "z"].iter().all(|key| v.get(*key).and_then(Value::as_f64).is_some_and(|n| n.is_finite() && n > 0.0 && n <= 10_000.0))) { return Err("content_store_corrupt"); }
            }
            let digest = item.get("sha256").and_then(Value::as_str).filter(|v| hash(v).is_some()).ok_or("content_store_corrupt")?;
            let relative_path = item.get("relativePath").and_then(Value::as_str).ok_or("content_store_corrupt")?;
            let expected_name = format!("assets/{}.glb", hash(digest).ok_or("content_store_corrupt")?);
            let size = item.get("byteLength").and_then(Value::as_u64).filter(|n| (20..=64 * 1024 * 1024).contains(n)).ok_or("content_store_corrupt")?;
            let bytes = checked.files.get(relative_path).ok_or("content_store_corrupt")?;
            total_asset = total_asset.checked_add(size).ok_or("creator_export_too_large")?;
            if total_asset > MAX_ASSET_TOTAL { return Err("creator_export_too_large"); }
            if relative_path != expected_name || !catalog_digests.insert(digest.to_owned()) || !requested.contains(digest)
                || bytes.len() as u64 != size || bytes_digest(bytes) != digest { return Err("creator_export_asset_mismatch"); }
            crate::creator_assets::inspect_glb(bytes)?;
            world_assets.push((format!("world/{relative_path}"), bytes.clone()));
        }
        if catalog_digests != requested { return Err("creator_export_asset_mismatch"); }
        source_files.insert("world/scene.json".to_owned(), json!(scene_text));
        source_files.insert("world/assets/catalog.json".to_owned(), json!(catalog_text));
        if !source_files.contains_key("world/plan-patch.json") {
            if let Some(patch_path) = entry.get("patch").and_then(Value::as_str) {
                let patch = checked.files.get(patch_path).ok_or("content_store_corrupt")?;
                let patch_text = std::str::from_utf8(patch).map_err(|_| "content_store_corrupt")?;
                source_files.insert("world/plan-patch.json".to_owned(), json!(patch_text));
            }
        }
    } else if !requested.is_empty() {
        return Err("creator_export_asset_mismatch");
    }
    let name = write_source(parent, &source_files, world_assets, Vec::new(), false)?;
    Ok(json!({"directoryName":name,"cityRevision":revision,"assetCount":requested.len()}))
}

fn write_source(parent: &Path, files: &serde_json::Map<String, Value>, world_assets: Vec<(String, Vec<u8>)>, game_assets: Vec<(String, Vec<u8>)>, has_game: bool) -> Result<String, &'static str> {
    let info = std::fs::symlink_metadata(parent).map_err(|_| "creator_export_destination_invalid")?;
    if !info.is_dir() || info.file_type().is_symlink() { return Err("creator_export_destination_invalid"); }
    let name = new_id("city-source-")?;
    let staging = parent.join(format!(".{name}.tmp"));
    let final_path = parent.join(&name);
    std::fs::create_dir(&staging).map_err(|_| "creator_export_write_failed")?;
    let result = (|| -> Result<(), &'static str> {
        for dir in ["world", "games", "design", "tests"] {
            std::fs::create_dir(staging.join(dir)).map_err(|_| "creator_export_write_failed")?;
        }
        if has_game {
            std::fs::create_dir(staging.join("games/game")).map_err(|_| "creator_export_write_failed")?;
            std::fs::create_dir(staging.join("games/game/assets")).map_err(|_| "creator_export_write_failed")?;
        }
        if !world_assets.is_empty() || files.contains_key("world/assets/catalog.json") { std::fs::create_dir(staging.join("world/assets")).map_err(|_| "creator_export_write_failed")?; }
        for (path, value) in files {
            if let Some(parent) = staging.join(path).parent() { std::fs::create_dir_all(parent).map_err(|_| "creator_export_write_failed")?; }
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(staging.join(path)).map_err(|_| "creator_export_write_failed")?;
            file.write_all(value.as_str().ok_or("creator_export_invalid")?.as_bytes()).map_err(|_| "creator_export_write_failed")?;
        }
        for (path, bytes) in world_assets {
            let target = staging.join(path);
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(target).map_err(|_| "creator_export_write_failed")?;
            file.write_all(&bytes).map_err(|_| "creator_export_write_failed")?;
        }
        for (name, bytes) in game_assets {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(staging.join("games/game/assets").join(name)).map_err(|_| "creator_export_write_failed")?;
            file.write_all(&bytes).map_err(|_| "creator_export_write_failed")?;
        }
        commit_directory(&staging, &final_path)?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_dir_all(&staging); }
    result?;
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::creator_store::{canonical_json, database, digest, now_ms};
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    fn fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(new_id("creator-source-test-").unwrap());
        std::fs::create_dir(&dir).unwrap();
        let db = database(&dir).unwrap();
        let document = json!({"projectId":"project-test","revision":3,"cityId":"city-test","mounts":[],"assets":{"schemaVersion":1,"entries":[]}});
        db.execute("INSERT INTO creator_projects(project_id,revision,document_json,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?4)",
            rusqlite::params!["project-test",3,document.to_string(),now_ms()]).unwrap();
        dir
    }
    fn payload() -> Value {
        let mut files = serde_json::Map::new();
        for name in REQUIRED { files.insert((*name).to_owned(), json!("{}\n")); }
        json!({"projectId":"project-test","revision":3,"files":files,"assetDigests":[]})
    }
    fn package_with_empty_scene_and_catalog() -> Vec<u8> {
        let mut artifact: Value = serde_json::from_slice(include_bytes!("../../../../fixtures/city-content-v2/integrity-vector.json")).unwrap();
        let scene = br#"{"schemaVersion":1,"objects":[]}"#;
        let catalog = br#"{"schemaVersion":1,"entries":[]}"#;
        let patch = br#"{}"#;
        artifact["manifest"]["entry"]["patch"] = json!("world/plan-patch.json");
        artifact["files"]["scene/objects.json"] = json!(STANDARD.encode(scene));
        artifact["files"]["assets/catalog.json"] = json!(STANDARD.encode(catalog));
        artifact["files"]["world/plan-patch.json"] = json!(STANDARD.encode(patch));
        let declarations = artifact["manifest"]["files"].as_array_mut().unwrap();
        declarations.push(json!({"path":"world/plan-patch.json","mediaType":"application/json","byteLength":patch.len(),"sha256":bytes_digest(patch)}));
        for declaration in declarations {
            let path = declaration["path"].as_str().unwrap();
            let bytes = match path { "scene/objects.json" => scene.as_slice(), "assets/catalog.json" => catalog.as_slice(), "world/plan-patch.json" => patch.as_slice(), _ => b"{}".as_slice() };
            declaration["byteLength"] = json!(bytes.len());
            declaration["sha256"] = json!(bytes_digest(bytes));
        }
        artifact["manifest"]["files"].as_array_mut().unwrap().sort_by(|a,b| a["path"].as_str().cmp(&b["path"].as_str()));
        let mut manifest = artifact["manifest"].as_object().unwrap().clone();
        manifest.remove("contentDigest");
        artifact["manifest"]["contentDigest"] = json!(digest(&canonical_json(&Value::Object(manifest)).unwrap()));
        serde_json::to_vec(&artifact).unwrap()
    }
    fn package_with_model_asset() -> (Vec<u8>, String, Vec<u8>) {
        let mut artifact: Value = serde_json::from_slice(include_bytes!("../../../../fixtures/city-content-v2/integrity-vector.json")).unwrap();
        let scene = br#"{"schemaVersion":1,"objects":[]}"#;
        let glb_json = br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":12}],"bufferViews":[{"buffer":0,"byteLength":12}],"accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[-1,0,-1],"max":[1,2,1]}],"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}]}"#;
        let padded = (glb_json.len() + 3) & !3;
        let total = 12 + 8 + padded + 8 + 12;
        let mut glb = Vec::with_capacity(total);
        glb.extend_from_slice(b"glTF"); glb.extend_from_slice(&2u32.to_le_bytes()); glb.extend_from_slice(&(total as u32).to_le_bytes());
        glb.extend_from_slice(&(padded as u32).to_le_bytes()); glb.extend_from_slice(&0x4e4f534au32.to_le_bytes()); glb.extend_from_slice(glb_json);
        glb.resize(20 + padded, b' '); glb.extend_from_slice(&12u32.to_le_bytes()); glb.extend_from_slice(&0x004e4942u32.to_le_bytes()); glb.extend_from_slice(&[0u8; 12]);
        let asset_digest = bytes_digest(&glb);
        let asset_path = format!("assets/{}.glb", hash(&asset_digest).unwrap());
        let catalog = json!({"schemaVersion":1,"entries":[{"assetId":"desert-model","relativePath":asset_path,"sha256":asset_digest,
            "byteLength":glb.len(),"format":"glb-v2","boundsMeters":{"x":2,"y":2,"z":2}}]});
        let catalog = canonical_json(&catalog).unwrap();
        artifact["files"]["scene/objects.json"] = json!(STANDARD.encode(scene));
        artifact["files"]["assets/catalog.json"] = json!(STANDARD.encode(&catalog));
        artifact["files"][&asset_path] = json!(STANDARD.encode(&glb));
        let declarations = artifact["manifest"]["files"].as_array_mut().unwrap();
        declarations.push(json!({"path":asset_path,"mediaType":"model/gltf-binary","byteLength":glb.len(),"sha256":asset_digest}));
        for declaration in declarations {
            let path = declaration["path"].as_str().unwrap();
            let (bytes, media_type) = match path {
                "scene/objects.json" => (scene.as_slice(), "application/json"),
                "assets/catalog.json" => (catalog.as_bytes(), "application/json"),
                value if value == asset_path => (glb.as_slice(), "model/gltf-binary"),
                _ => (b"{}".as_slice(), "application/json"),
            };
            declaration["mediaType"] = json!(media_type);
            declaration["byteLength"] = json!(bytes.len());
            declaration["sha256"] = json!(bytes_digest(bytes));
        }
        artifact["manifest"]["files"].as_array_mut().unwrap().sort_by(|a,b| a["path"].as_str().cmp(&b["path"].as_str()));
        let mut manifest = artifact["manifest"].as_object().unwrap().clone(); manifest.remove("contentDigest");
        artifact["manifest"]["contentDigest"] = json!(digest(&canonical_json(&Value::Object(manifest)).unwrap()));
        (serde_json::to_vec(&artifact).unwrap(), asset_digest, glb)
    }
    #[test]
    fn source_export_is_scoped_and_refuses_stale_or_unsafe_input() {
        let home = fixture();
        let destination = home.join("destination");
        std::fs::create_dir(&destination).unwrap();
        let output = export_source(&home, &destination, &payload()).unwrap();
        let root = destination.join(output["directoryName"].as_str().unwrap());
        assert_eq!(std::fs::read_to_string(root.join("world/world.json")).unwrap(), "{}\n");
        assert!(root.join("games/game/game.json").is_file());
        assert!(root.join("design").is_dir());
        let mut unexpected_mount = payload(); unexpected_mount["files"]["games/game/mount.json"] = json!("{}\n");
        assert_eq!(export_source(&home, &destination, &unexpected_mount).unwrap_err(), "creator_export_mount_mismatch");
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
    #[test]
    fn independent_city_export_checks_revision_and_fixed_paths() {
        let home = fixture();
        let city = crate::creator_cities::create_city(&home, "owner", "city-source-test", "Desert", 42,
            &json!({"schemaVersion":1,"id":"egypt-desert","version":1})).unwrap();
        let destination = home.join("destination");
        std::fs::create_dir(&destination).unwrap();
        let mut payload = json!({"cityId":city["cityId"],"revision":0,"assetDigests":[],"files":{
            "README.md":"city\n", ".gitignore":"dist/\n", "world/world.json":"{}\n"}});
        let result = export_city_source(&home, &destination, &payload).unwrap();
        let root = destination.join(result["directoryName"].as_str().unwrap());
        assert!(root.join("world/world.json").is_file());
        assert_eq!(result["assetCount"], 0);
        assert!(root.join("games").is_dir());
        assert!(!root.join("games/game").exists());
        payload["revision"] = json!(1);
        assert_eq!(export_city_source(&home, &destination, &payload).unwrap_err(), "revision_conflict");
        payload["revision"] = json!(0);
        payload["files"]["../outside"] = json!("escape");
        assert_eq!(export_city_source(&home, &destination, &payload).unwrap_err(), "creator_export_invalid");
        assert!(!home.join("outside").exists());
        let _ = std::fs::remove_dir_all(home);
    }
    #[test]
    fn independent_city_export_includes_its_pinned_scene_and_catalog() {
        let home = fixture();
        let raw = package_with_empty_scene_and_catalog();
        let installed = crate::creator_content_install::install_inspected_world(&home, &raw, "example.desert", "1.0.0",
            &serde_json::from_slice::<Value>(&raw).unwrap()["manifest"]["contentDigest"].as_str().unwrap()).unwrap();
        let digest = installed["contentDigest"].as_str().unwrap();
        let city = crate::creator_cities::create_city_with_world_package(&home, "owner", "city-source-pinned", "Desert", 42,
            &json!({"schemaVersion":1,"id":"desert"}), Some(("example.desert", "1.0.0", digest))).unwrap();
        let destination = home.join("destination");
        std::fs::create_dir(&destination).unwrap();
        let payload = json!({"cityId":city["cityId"],"revision":0,"assetDigests":[],"files":{
            "README.md":"city\n", ".gitignore":"dist/\n", "world/world.json":"{}\n"}});
        let result = export_city_source(&home, &destination, &payload).unwrap();
        let root = destination.join(result["directoryName"].as_str().unwrap());
        assert_eq!(std::fs::read(root.join("world/scene.json")).unwrap(), br#"{"schemaVersion":1,"objects":[]}"#);
        assert_eq!(std::fs::read(root.join("world/assets/catalog.json")).unwrap(), br#"{"schemaVersion":1,"entries":[]}"#);
        assert_eq!(std::fs::read(root.join("world/plan-patch.json")).unwrap(), b"{}");
        assert_eq!(result["assetCount"], 0);
        let _ = std::fs::remove_dir_all(home);
    }
    #[test]
    fn independent_city_export_copies_digest_verified_pinned_glb_assets() {
        let home = fixture();
        let (raw, asset_digest, glb) = package_with_model_asset();
        let manifest: Value = serde_json::from_slice(&raw).unwrap();
        let content_digest = manifest["manifest"]["contentDigest"].as_str().unwrap();
        let installed = crate::creator_content_install::install_inspected_world(&home, &raw, "example.desert", "1.0.0", content_digest).unwrap();
        let city = crate::creator_cities::create_city_with_world_package(&home, "owner", "city-source-model", "Desert", 42,
            &json!({"schemaVersion":1,"id":"desert"}), Some(("example.desert", "1.0.0", installed["contentDigest"].as_str().unwrap()))).unwrap();
        let destination = home.join("destination"); std::fs::create_dir(&destination).unwrap();
        let payload = json!({"cityId":city["cityId"],"revision":0,"assetDigests":[asset_digest],"files":{
            "README.md":"city\n", ".gitignore":"dist/\n", "world/world.json":"{}\n"}});
        let result = export_city_source(&home, &destination, &payload).unwrap();
        let root = destination.join(result["directoryName"].as_str().unwrap());
        assert_eq!(std::fs::read(root.join(format!("world/assets/{}.glb", hash(&asset_digest).unwrap()))).unwrap(), glb);
        assert_eq!(result["assetCount"], 1);
        let mut tampered = payload.clone(); tampered["assetDigests"] = json!([]);
        assert_eq!(export_city_source(&home, &destination, &tampered).unwrap_err(), "creator_export_asset_mismatch");
        let _ = std::fs::remove_dir_all(home);
    }
}
