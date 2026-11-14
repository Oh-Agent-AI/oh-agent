//! Local, unsigned content-package installation. This is deliberately not a
//! trust boundary: it stores integrity-checked bytes under the Creator data
//! home and records them in SQLite, but does not make them runnable, trusted or
//! shareable. Runtime loading is a separate product capability.
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::creator_content_v2::inspect_world_integrity_v2;
use crate::creator_store::{bytes_digest, database, now_ms, valid_id};

const PENDING_TTL: Duration = Duration::from_secs(600);
const MAX_PENDING: usize = 8;

struct PendingInspection {
    home: PathBuf,
    instance: String,
    source: PathBuf,
    package_id: String,
    version: String,
    digest: String,
    created: Instant,
}

#[derive(Debug)]
pub(crate) struct ClaimedInspection {
    pub source: PathBuf,
    pub package_id: String,
    pub version: String,
    pub digest: String,
}

fn pending() -> &'static Mutex<HashMap<String, PendingInspection>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingInspection>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("content-inspection-{}-{}", now_ms(), NEXT.fetch_add(1, Ordering::Relaxed))
}

/// Remember the exact native-picker selection that was just inspected. The
/// token is one-shot and scoped to the Studio instance; the file path never
/// leaves the host or enters MCP/UI payloads.
pub(crate) fn remember_inspection(home: &Path, instance: &str, source: &Path, package_id: &str, version: &str, digest: &str) -> Result<String, &'static str> {
    if !valid_id(instance) || !valid_id(package_id) || version.is_empty() || version.len() > 64 || !digest.starts_with("sha256:") { return Err("content_inspection_invalid"); }
    let token = next_token();
    let mut map = pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    map.retain(|_, entry| entry.created.elapsed() <= PENDING_TTL);
    if map.len() >= MAX_PENDING {
        if let Some(oldest) = map.iter().min_by_key(|(_, entry)| entry.created).map(|(key, _)| key.clone()) {
            map.remove(&oldest);
        }
    }
    map.insert(token.clone(), PendingInspection { home: home.to_path_buf(), instance: instance.to_owned(),
        source: source.to_path_buf(), package_id: package_id.to_owned(), version: version.to_owned(), digest: digest.to_owned(), created: Instant::now() });
    Ok(token)
}

/// Consume a preflight token. The caller must still re-read and re-check the
/// file: the path may have changed between inspection and confirmation.
pub(crate) fn claim_inspection(home: &Path, instance: &str, token: &str) -> Result<ClaimedInspection, &'static str> {
    let mut map = pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(entry) = map.get(token) else { return Err("content_inspection_expired"); };
    if entry.home != home || entry.instance != instance {
        // A different Studio instance must not burn another instance's token.
        return Err("content_inspection_expired");
    }
    if entry.created.elapsed() > PENDING_TTL { map.remove(token); return Err("content_inspection_expired"); }
    let entry = map.remove(token).ok_or("content_inspection_expired")?;
    Ok(ClaimedInspection { source: entry.source, package_id: entry.package_id, version: entry.version, digest: entry.digest })
}

fn content_root(home: &Path) -> PathBuf { home.join("state/creator/content") }

fn safe_component(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value != "." && value != ".."
        && !value.contains('/') && !value.contains('\\') && !value.contains('\0')
}

fn existing_installation(db: &rusqlite::Connection, package_id: &str, version: &str) -> Result<Option<(String, String, u64)>, &'static str> {
    db.query_row("SELECT content_digest,package_path,installed_at_ms FROM creator_content_packages WHERE package_id=?1 AND version=?2",
        params![package_id, version], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional().map_err(|_| "creator_store_unavailable")
}

fn installation_json(manifest: &Value, byte_length: usize, installed_at_ms: u64, already_installed: bool) -> Value {
    json!({"packageId": manifest["packageId"], "version": manifest["version"], "contentDigest": manifest["contentDigest"],
        "fileCount": manifest["files"].as_array().map_or(0, Vec::len), "byteLength": byte_length,
        "installedAtMs": installed_at_ms, "alreadyInstalled": already_installed})
}

/// Install already-inspected bytes atomically. Re-inspects the bytes first so a
/// caller cannot bypass the integrity gate, and verifies the confirmed
/// identity before writing anything.
pub(crate) fn install_inspected_world(home: &Path, raw: &[u8], expected_package: &str, expected_version: &str, expected_digest: &str) -> Result<Value, &'static str> {
    let checked = inspect_world_integrity_v2(raw)?;
    let manifest = &checked.manifest;
    let package_id = manifest["packageId"].as_str().ok_or("content_invalid")?;
    let version = manifest["version"].as_str().ok_or("content_invalid")?;
    let digest = manifest["contentDigest"].as_str().ok_or("content_invalid")?;
    if package_id != expected_package || version != expected_version || digest != expected_digest { return Err("content_file_changed"); }
    if !safe_component(package_id) || !safe_component(version) { return Err("content_package_invalid"); }
    let db = database(home)?;
    if let Some((stored_digest, stored_path, installed_at)) = existing_installation(&db, package_id, version)? {
        if stored_digest != digest { return Err("content_package_conflict"); }
        if content_root(home).join(&stored_path).is_file() { return Ok(installation_json(manifest, raw.len(), installed_at, true)); }
        return Err("content_store_unavailable");
    }
    let root = content_root(home);
    std::fs::create_dir_all(&root).map_err(|_| "content_store_unavailable")?;
    let metadata = std::fs::symlink_metadata(&root).map_err(|_| "content_store_unavailable")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err("content_store_unavailable"); }
    let final_dir = root.join("world").join(package_id).join(version);
    if std::fs::symlink_metadata(&final_dir).is_ok_and(|metadata| metadata.file_type().is_symlink()) { return Err("content_package_conflict"); }
    let final_file = final_dir.join("package.json");
    let relative = format!("world/{package_id}/{version}/package.json");
    if final_dir.exists() {
        // Crash between rename and DB insert leaves an orphan. Adopt only if its
        // bytes match the confirmed digest; never overwrite a different package.
        let orphan = std::fs::read(&final_file).map_err(|_| "content_package_conflict")?;
        if bytes_digest(&orphan) != bytes_digest(raw) { return Err("content_package_conflict"); }
        let adopted_at = now_ms();
        db.execute("INSERT INTO creator_content_packages(package_id,version,kind,content_digest,manifest_json,package_path,file_count,byte_length,installed_at_ms) VALUES(?1,?2,'city-world',?3,?4,?5,?6,?7,?8)",
            params![package_id, version, digest, serde_json::to_string(manifest).map_err(|_| "content_invalid")?, relative,
                checked.files.len() as u64, raw.len() as u64, adopted_at]).map_err(|_| "creator_store_unavailable")?;
        return Ok(installation_json(manifest, raw.len(), adopted_at, true));
    }
    std::fs::create_dir_all(final_dir.parent().ok_or("content_package_invalid")?).map_err(|_| "content_store_unavailable")?;
    let staging = root.join(format!(".staging-{}-{}", now_ms(), std::process::id()));
    std::fs::create_dir(&staging).map_err(|_| "content_store_unavailable")?;
    let staged_file = staging.join("package.json");
    let write_result = (|| -> Result<(), &'static str> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&staged_file).map_err(|_| "content_store_unavailable")?;
        file.write_all(raw).map_err(|_| "content_store_unavailable")?;
        file.sync_all().map_err(|_| "content_store_unavailable")?;
        Ok(())
    })();
    if write_result.is_err() { let _ = std::fs::remove_dir_all(&staging); return Err("content_store_unavailable"); }
    if std::fs::rename(&staging, &final_dir).is_err() { let _ = std::fs::remove_dir_all(&staging); return Err("content_store_unavailable"); }
    let installed_at = now_ms();
    let insert = db.execute("INSERT INTO creator_content_packages(package_id,version,kind,content_digest,manifest_json,package_path,file_count,byte_length,installed_at_ms) VALUES(?1,?2,'city-world',?3,?4,?5,?6,?7,?8)",
        params![package_id, version, digest, serde_json::to_string(manifest).map_err(|_| "content_invalid")?, relative,
            checked.files.len() as u64, raw.len() as u64, installed_at]);
    if insert.is_err() { let _ = std::fs::remove_dir_all(&final_dir); return Err("creator_store_unavailable"); }
    Ok(installation_json(manifest, raw.len(), installed_at, false))
}

pub(crate) fn list_installed(home: &Path) -> Result<Value, &'static str> {
    let db = database(home)?;
    let mut statement = db.prepare("SELECT package_id,version,content_digest,file_count,byte_length,installed_at_ms FROM creator_content_packages ORDER BY installed_at_ms DESC,package_id ASC,version ASC LIMIT 128")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map([], |row| Ok(json!({"packageId":row.get::<_,String>(0)?,"version":row.get::<_,String>(1)?,
        "contentDigest":row.get::<_,String>(2)?,"fileCount":row.get::<_,u64>(3)?,"byteLength":row.get::<_,u64>(4)?,"installedAtMs":row.get::<_,u64>(5)?})))
        .map_err(|_| "creator_store_unavailable")?;
    let packages = rows.collect::<Result<Vec<_>, _>>().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"packages":packages}))
}

pub(crate) fn uninstall(home: &Path, package_id: &str, version: &str) -> Result<Value, &'static str> {
    if !valid_id(package_id) || !safe_component(version) { return Err("content_package_invalid"); }
    let db = database(home)?;
    let path: Option<String> = db.query_row("SELECT package_path FROM creator_content_packages WHERE package_id=?1 AND version=?2",
        params![package_id, version], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?;
    let Some(path) = path else { return Err("content_package_not_found"); };
    if !path.starts_with("world/") || path.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\')) {
        return Err("content_package_invalid");
    }
    let root = content_root(home);
    let dir = root.join(path).parent().map(Path::to_path_buf).ok_or("content_package_invalid")?;
    if !dir.starts_with(&root) { return Err("content_package_invalid"); }
    if dir.exists() { std::fs::remove_dir_all(&dir).map_err(|_| "content_store_unavailable")?; }
    db.execute("DELETE FROM creator_content_packages WHERE package_id=?1 AND version=?2", params![package_id, version])
        .map_err(|_| "creator_store_unavailable")?;
    let _ = std::fs::remove_dir(root.join("world").join(package_id));
    Ok(json!({"packageId":package_id,"version":version,"removed":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn home() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!("creator-content-install-{}-{}", now_ms(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn fixture() -> Vec<u8> {
        include_bytes!("../../../../fixtures/city-content-v2/integrity-vector.json").to_vec()
    }

    #[test]
    fn install_is_idempotent_and_uninstall_removes_bytes_and_row() {
        let home = home();
        let raw = fixture();
        let first = install_inspected_world(&home, &raw, "example.desert", "1.0.0", "sha256:432a5a6173179521080db1ae9aa71a0d49e41d27681ed2b5ce0b62ba87383682").unwrap();
        assert_eq!(first["alreadyInstalled"], false);
        let second = install_inspected_world(&home, &raw, "example.desert", "1.0.0", "sha256:432a5a6173179521080db1ae9aa71a0d49e41d27681ed2b5ce0b62ba87383682").unwrap();
        assert_eq!(second["alreadyInstalled"], true);
        let listed = list_installed(&home).unwrap();
        assert_eq!(listed["packages"].as_array().unwrap().len(), 1);
        assert_eq!(listed["packages"][0]["packageId"], "example.desert");
        let removed = uninstall(&home, "example.desert", "1.0.0").unwrap();
        assert_eq!(removed["removed"], true);
        assert_eq!(list_installed(&home).unwrap()["packages"].as_array().unwrap().len(), 0);
        assert_eq!(uninstall(&home, "example.desert", "1.0.0").unwrap_err(), "content_package_not_found");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn install_rejects_confirmed_identity_drift_and_does_not_write() {
        let home = home();
        let raw = fixture();
        assert_eq!(install_inspected_world(&home, &raw, "example.other", "1.0.0", "sha256:432a5a6173179521080db1ae9aa71a0d49e41d27681ed2b5ce0b62ba87383682").unwrap_err(), "content_file_changed");
        assert_eq!(install_inspected_world(&home, &raw, "example.desert", "2.0.0", "sha256:432a5a6173179521080db1ae9aa71a0d49e41d27681ed2b5ce0b62ba87383682").unwrap_err(), "content_file_changed");
        assert_eq!(list_installed(&home).unwrap()["packages"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn install_adopts_an_orphan_directory_left_by_a_crash() {
        let home = home();
        let raw = fixture();
        let first = install_inspected_world(&home, &raw, "example.desert", "1.0.0", "sha256:432a5a6173179521080db1ae9aa71a0d49e41d27681ed2b5ce0b62ba87383682").unwrap();
        assert_eq!(first["alreadyInstalled"], false);
        {
            let db = crate::creator_store::database(&home).unwrap();
            db.execute("DELETE FROM creator_content_packages", []).unwrap();
        }
        let adopted = install_inspected_world(&home, &raw, "example.desert", "1.0.0", "sha256:432a5a6173179521080db1ae9aa71a0d49e41d27681ed2b5ce0b62ba87383682").unwrap();
        assert_eq!(adopted["alreadyInstalled"], true);
        assert_eq!(list_installed(&home).unwrap()["packages"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn pending_inspection_is_thread_scoped_one_shot_and_expiry_safe() {
        let home = home();
        let token = remember_inspection(&home, "studio-1", Path::new("/tmp/package.json"), "example.desert", "1.0.0", "sha256:432a5a6173179521080db1ae9aa71a0d49e41d27681ed2b5ce0b62ba87383682").unwrap();
        assert_eq!(claim_inspection(&home, "studio-2", &token).unwrap_err(), "content_inspection_expired");
        let claimed = claim_inspection(&home, "studio-1", &token).unwrap();
        assert_eq!(claimed.package_id, "example.desert");
        assert_eq!(claim_inspection(&home, "studio-1", &token).unwrap_err(), "content_inspection_expired");
        let _ = std::fs::remove_dir_all(home);
    }
}
