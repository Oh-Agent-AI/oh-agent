//! Durable City identities; semantic validation is performed by the trusted
//! Studio adapter and bound to the request before the host calls this module.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Mutex, OnceLock}, time::{Duration, Instant}};

use crate::creator_store::{canonical_json, database, digest, new_id, now_ms, valid_id};

const MAX_PROFILE_BYTES: usize = 16 * 1024;
const PREVIEW_TTL: Duration = Duration::from_secs(300);

struct CityPreview { home: PathBuf, instance: String, city_id: String, base_revision: u64, document: Value, created: Instant }
fn previews() -> &'static Mutex<HashMap<String, CityPreview>> {
    static PREVIEWS: OnceLock<Mutex<HashMap<String, CityPreview>>> = OnceLock::new();
    PREVIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The profile must already have passed the SDK and runtime registration checks.
pub(crate) fn create_city(home: &Path, actor: &str, operation_id: &str, name: &str, seed: u32, profile: &Value) -> Result<Value, &'static str> {
    if !valid_id(actor) || !valid_id(operation_id) || name.trim() != name || name.is_empty()
        || name.chars().count() > 120 || name.chars().any(char::is_control) || !profile.is_object() {
        return Err("creator_city_invalid");
    }
    let profile_json = canonical_json(profile).map_err(|_| "creator_city_invalid")?;
    if profile_json.len() > MAX_PROFILE_BYTES { return Err("creator_city_invalid"); }
    let request = json!({"name":name,"seed":seed,"profile":profile});
    let request_hash = digest(&canonical_json(&request).map_err(|_| "creator_city_invalid")?);
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let previous: Option<(String, String)> = tx.query_row(
        "SELECT operation_hash,result_json FROM creator_city_operations WHERE actor_id=?1 AND operation_id=?2",
        params![actor, operation_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|_| "creator_store_unavailable")?;
    if let Some((previous_hash, result)) = previous {
        if previous_hash != request_hash { return Err("operation_id_conflict"); }
        return serde_json::from_str(&result).map_err(|_| "creator_store_unavailable");
    }
    let city_id = new_id("city-")?;
    let document = json!({"schemaVersion":1,"cityId":city_id,"revision":0,"name":name,"seed":seed,"profile":profile});
    let document_json = canonical_json(&document).map_err(|_| "creator_city_invalid")?;
    let result = json!({"cityId":city_id,"revision":0});
    let result_json = canonical_json(&result).map_err(|_| "creator_city_invalid")?;
    let now = now_ms();
    tx.execute("INSERT INTO creator_cities(city_id,revision,document_json,created_at_ms,updated_at_ms) VALUES(?1,0,?2,?3,?3)",
        params![city_id, document_json, now]).map_err(|_| "creator_store_unavailable")?;
    tx.execute("INSERT INTO creator_city_operations(actor_id,operation_id,operation_hash,city_id,result_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",
        params![actor, operation_id, request_hash, city_id, result_json, now]).map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

pub(crate) fn read_city(home: &Path, city_id: &str) -> Result<Value, &'static str> {
    if !valid_id(city_id) { return Err("creator_city_invalid"); }
    let db = database(home)?;
    let raw: String = db.query_row("SELECT document_json FROM creator_cities WHERE city_id=?1", [city_id], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_city_not_found")?;
    serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")
}

/// Fixed diagnostic vocabulary only; no raw errors, paths or session content.
pub(crate) fn record_diagnostic(home: &Path, city_id: &str, revision: u64, correlation_id: &str, event: &str, code: Option<&str>, elapsed_ms: Option<u64>) -> Result<(), &'static str> {
    if !valid_id(city_id) || !valid_id(correlation_id) || revision > i64::MAX as u64
        || !matches!(event, "view_started" | "view_ready" | "view_failed" | "layout_saved" | "layout_save_failed")
        || code.is_some_and(|v| !matches!(v, "engine_initialization_failed" | "layout_preparation_failed" | "planning_outcome_failed" | "layout_store_failed"))
        || elapsed_ms.is_some_and(|v| v > 86_400_000)
        || (event == "view_failed" && code.is_none())
        || (event == "layout_save_failed" && code != Some("layout_store_failed"))
        || (matches!(event, "view_started" | "view_ready" | "layout_saved") && code.is_some()) { return Err("creator_diagnostic_invalid"); }
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let current: Option<u64> = tx.query_row("SELECT revision FROM creator_cities WHERE city_id=?1", [city_id], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?;
    if current.is_none_or(|value| revision > value) { return Err("creator_city_not_found"); }
    tx.execute("INSERT INTO creator_city_diagnostics(city_id,city_revision,correlation_id,event,code,elapsed_ms,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![city_id,revision,correlation_id,event,code,elapsed_ms,now_ms()]).map_err(|_| "creator_store_unavailable")?;
    tx.execute("DELETE FROM creator_city_diagnostics WHERE city_id=?1 AND id NOT IN (SELECT id FROM creator_city_diagnostics WHERE city_id=?1 ORDER BY id DESC LIMIT 500)", [city_id]).map_err(|_| "creator_store_unavailable")?;
    tx.execute("DELETE FROM creator_city_diagnostics WHERE id NOT IN (SELECT id FROM creator_city_diagnostics ORDER BY id DESC LIMIT 2000)", []).map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

pub(crate) fn read_diagnostics(home: &Path, city_id: &str, limit: u64) -> Result<Value, &'static str> {
    if !valid_id(city_id) || !(1..=100).contains(&limit) { return Err("creator_diagnostic_invalid"); }
    let db = database(home)?;
    let exists: Option<u64> = db.query_row("SELECT revision FROM creator_cities WHERE city_id=?1", [city_id], |row| row.get(0)).optional().map_err(|_| "creator_store_unavailable")?;
    if exists.is_none() { return Err("creator_city_not_found"); }
    let mut stmt = db.prepare("SELECT city_revision,correlation_id,event,code,elapsed_ms,created_at_ms FROM creator_city_diagnostics WHERE city_id=?1 ORDER BY id DESC LIMIT ?2").map_err(|_| "creator_store_unavailable")?;
    let rows = stmt.query_map(params![city_id,limit], |row| Ok(json!({"revision":row.get::<_,u64>(0)?,"correlationId":row.get::<_,String>(1)?,"event":row.get::<_,String>(2)?,"code":row.get::<_,Option<String>>(3)?,"elapsedMs":row.get::<_,Option<u64>>(4)?,"atMs":row.get::<_,u64>(5)?}))).map_err(|_| "creator_store_unavailable")?;
    let entries = rows.collect::<Result<Vec<_>, _>>().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"cityId":city_id,"events":entries,"retention":"latest_500_per_city_and_2000_total"}))
}

pub(crate) fn list_cities(home: &Path, after: &str, limit: u64) -> Result<Value, &'static str> {
    if (!after.is_empty() && !valid_id(after)) || !(1..=50).contains(&limit) { return Err("creator_city_invalid"); }
    let db = database(home)?;
    let mut statement = db.prepare("SELECT city_id,revision,document_json FROM creator_cities WHERE city_id>?1 ORDER BY city_id LIMIT ?2")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![after, limit + 1], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?, row.get::<_, String>(2)?)))
        .map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>, _>>().map_err(|_| "creator_store_unavailable")?;
    let has_more = rows.len() > limit as usize;
    let mut cities = Vec::new();
    for (city_id, revision, raw) in rows.iter().take(limit as usize) {
        let doc: Value = serde_json::from_str(raw).map_err(|_| "creator_store_unavailable")?;
        let name = doc.get("name").and_then(Value::as_str).ok_or("creator_store_unavailable")?;
        cities.push(json!({"cityId":city_id,"revision":revision,"name":name}));
    }
    let next = if has_more { cities.last().and_then(|city| city["cityId"].as_str()).map(str::to_owned) } else { None };
    Ok(json!({"cities":cities,"nextCursor":next}))
}

/// Store a transient, SDK-validated replacement; the durable draft is unchanged.
pub(crate) fn preview_city(home: &Path, instance: &str, city_id: &str, base_revision: u64, name: &str, seed: u32, profile: &Value) -> Result<Value, &'static str> {
    if !valid_id(instance) || !valid_id(city_id) || name.trim() != name || name.is_empty()
        || name.chars().count() > 120 || name.chars().any(char::is_control) || !profile.is_object()
        || canonical_json(profile).map_err(|_| "creator_city_invalid")?.len() > MAX_PROFILE_BYTES { return Err("creator_city_invalid"); }
    let mut document = read_city(home, city_id)?;
    if document["revision"].as_u64() != Some(base_revision) { return Err("revision_conflict"); }
    let mut changed = Vec::new();
    if document["name"] != json!(name) { changed.push("name"); }
    if document["seed"] != json!(seed) { changed.push("seed"); }
    if &document["profile"] != profile { changed.push("profile"); }
    document["name"] = json!(name);
    document["seed"] = json!(seed);
    document["profile"] = profile.clone();
    let preview_id = new_id("city-preview-")?;
    let mut entries = previews().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.retain(|_, preview| preview.created.elapsed() <= PREVIEW_TTL);
    if entries.len() >= 128 { return Err("creator_preview_budget_exceeded"); }
    entries.insert(preview_id.clone(), CityPreview { home: home.to_path_buf(), instance: instance.into(), city_id: city_id.into(), base_revision, document, created: Instant::now() });
    Ok(json!({"previewId":preview_id,"cityId":city_id,"baseRevision":base_revision,"changedFields":changed,"expiresInMs":PREVIEW_TTL.as_millis(),"checks":{"static":"passed","runtime":"unchecked"}}))
}

pub(crate) fn commit_city(home: &Path, owner: &str, instance: &str, city_id: &str, preview_id: &str, expected_revision: u64, operation_id: &str) -> Result<Value, &'static str> {
    if !valid_id(owner) || !valid_id(instance) || !valid_id(city_id) || !valid_id(preview_id) || !valid_id(operation_id) { return Err("creator_city_invalid"); }
    let request_hash = digest(&canonical_json(&json!({"cityId":city_id,"previewId":preview_id,"expectedRevision":expected_revision})).map_err(|_| "creator_city_invalid")?);
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let previous: Option<(String, String)> = tx.query_row("SELECT operation_hash,result_json FROM creator_city_operations WHERE actor_id=?1 AND operation_id=?2",
        params![owner,operation_id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?;
    if let Some((hash, raw)) = previous {
        if hash != request_hash { return Err("operation_id_conflict"); }
        return serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable");
    }
    let mut entries = previews().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let preview = entries.get(preview_id).ok_or("preview_expired")?;
    if preview.created.elapsed() > PREVIEW_TTL { entries.remove(preview_id); return Err("preview_expired"); }
    if preview.home != home || preview.instance != instance || preview.city_id != city_id { return Err("permission_denied"); }
    if preview.base_revision != expected_revision { return Err("revision_conflict"); }
    let current: u64 = tx.query_row("SELECT revision FROM creator_cities WHERE city_id=?1", [city_id], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_city_not_found")?;
    if current != expected_revision { return Err("revision_conflict"); }
    let next = current.checked_add(1).filter(|n| *n <= i64::MAX as u64).ok_or("creator_city_invalid")?;
    let mut document = preview.document.clone();
    document["revision"] = json!(next);
    let serialized = canonical_json(&document).map_err(|_| "creator_city_invalid")?;
    let now = now_ms();
    let changed = tx.execute("UPDATE creator_cities SET revision=?2,document_json=?3,updated_at_ms=?4 WHERE city_id=?1 AND revision=?5",
        params![city_id,next,serialized,now,current]).map_err(|_| "creator_store_unavailable")?;
    if changed != 1 { return Err("revision_conflict"); }
    let result = json!({"cityId":city_id,"revision":next,"runtimeStatus":"not_loaded"});
    let result_json = canonical_json(&result).map_err(|_| "creator_city_invalid")?;
    tx.execute("INSERT INTO creator_city_operations(actor_id,operation_id,operation_hash,city_id,result_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",
        params![owner,operation_id,request_hash,city_id,result_json,now]).map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    entries.remove(preview_id);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_is_durable_idempotent_and_does_not_touch_existing_projects() {
        let home = std::env::temp_dir().join(new_id("city-store-test-").unwrap());
        let db = database(&home).unwrap();
        db.execute("INSERT INTO creator_projects VALUES('miami-project',3,'{\"name\":\"Miami\"}',0,0)", []).unwrap();
        drop(db);
        let profile = json!({"schemaVersion":1,"id":"desert","version":1});
        let first = create_city(&home, "local-profile", "op-1", "沙海之门", 42, &profile).unwrap();
        let city_id = first["cityId"].as_str().unwrap();
        assert_eq!(read_city(&home, city_id).unwrap()["name"], "沙海之门");
        assert_eq!(create_city(&home, "local-profile", "op-1", "沙海之门", 42, &profile).unwrap(), first);
        assert_eq!(create_city(&home, "local-profile", "op-1", "Changed", 42, &profile).unwrap_err(), "operation_id_conflict");
        let second = create_city(&home, "local-profile", "op-2", "Another", 42, &profile).unwrap();
        assert_ne!(first["cityId"], second["cityId"]);
        let db = database(&home).unwrap();
        let miami: (u64, String) = db.query_row("SELECT revision,document_json FROM creator_projects WHERE project_id='miami-project'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(miami, (3, "{\"name\":\"Miami\"}".to_string()));
        drop(db);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn failed_operation_record_rolls_back_city_and_allows_retry() {
        let home = std::env::temp_dir().join(new_id("city-store-test-").unwrap());
        let db = database(&home).unwrap();
        db.execute_batch("CREATE TRIGGER reject_city_operation BEFORE INSERT ON creator_city_operations BEGIN SELECT RAISE(ABORT, 'test'); END;").unwrap();
        drop(db);
        let profile = json!({"schemaVersion":1,"id":"desert"});
        assert_eq!(create_city(&home, "local-profile", "op-1", "Desert", 42, &profile).unwrap_err(), "creator_store_unavailable");
        let db = database(&home).unwrap();
        let count: u64 = db.query_row("SELECT COUNT(*) FROM creator_cities", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
        db.execute_batch("DROP TRIGGER reject_city_operation").unwrap();
        drop(db);
        assert!(create_city(&home, "local-profile", "op-1", "Desert", 42, &profile).is_ok());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn studio_create_requires_verdict_bound_to_exact_request() {
        let home = std::env::temp_dir().join(new_id("city-store-test-").unwrap());
        let mut request = json!({"name":"Desert","seed":42,"profile":{"id":"profile"},"operationId":"op-1"});
        let validation = json!({"schemaVersion":1,"requestDigest":digest(&canonical_json(&request).unwrap()),"ok":true});
        let invoke = |payload: &Value| crate::creator_projects::dispatch_as(&home, "local-profile", "studio-1", "creator.city.create", payload);
        assert_eq!(invoke(&request).unwrap_err(), "creator_request_invalid");
        request["validation"] = validation;
        let mut altered = request.clone();
        altered["seed"] = json!(43);
        assert_eq!(invoke(&altered).unwrap_err(), "creator_validation_scope_mismatch");
        altered = request.clone();
        altered["validation"]["ok"] = json!(false);
        assert_eq!(invoke(&altered).unwrap_err(), "creator_preview_invalid");
        let created = invoke(&request).unwrap();
        let cities = crate::creator_projects::dispatch_as(&home, "local-profile", "studio-1", "creator.city.list", &json!({"limit":1})).unwrap();
        assert_eq!(cities["cities"][0]["cityId"], created["cityId"]);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn city_edit_is_scoped_revision_checked_and_retryable() {
        let home = std::env::temp_dir().join(new_id("city-store-test-").unwrap());
        let profile = json!({"schemaVersion":1,"id":"desert"});
        let city = create_city(&home, "owner", "create-1", "Desert", 42, &profile).unwrap();
        let city_id = city["cityId"].as_str().unwrap();
        let other = create_city(&home, "owner", "create-2", "Miami", 42, &profile).unwrap();
        let other_id = other["cityId"].as_str().unwrap();
        let preview = preview_city(&home, "studio-1", city_id, 0, "Dunes", 43, &profile).unwrap();
        assert_eq!(preview["changedFields"], json!(["name", "seed"]));
        let stale = preview_city(&home, "studio-1", city_id, 0, "Stale", 44, &profile).unwrap();
        let id = preview["previewId"].as_str().unwrap();
        assert_eq!(read_city(&home, city_id).unwrap()["name"], "Desert");
        assert_eq!(commit_city(&home, "owner", "studio-2", city_id, id, 0, "edit-1").unwrap_err(), "permission_denied");
        assert_eq!(commit_city(&home, "owner", "studio-1", other_id, id, 0, "edit-1").unwrap_err(), "permission_denied");
        let result = commit_city(&home, "owner", "studio-1", city_id, id, 0, "edit-1").unwrap();
        assert_eq!(result["revision"], 1);
        assert_eq!(commit_city(&home, "owner", "studio-2", city_id, id, 0, "edit-1").unwrap(), result);
        assert_eq!(commit_city(&home, "owner", "studio-1", city_id, stale["previewId"].as_str().unwrap(), 0, "edit-2").unwrap_err(), "revision_conflict");
        assert_eq!(read_city(&home, other_id).unwrap()["name"], "Miami");
        assert_eq!(read_city(&home, city_id).unwrap()["name"], "Dunes");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn scoped_layout_storage_checks_city_revision_seed_and_immutable_identity() {
        let home = std::env::temp_dir().join(new_id("city-store-test-").unwrap());
        let profile = json!({"schemaVersion":1,"id":"desert"});
        let city = create_city(&home, "owner", "create-1", "Desert", 42, &profile).unwrap();
        let city_id = city["cityId"].as_str().unwrap();
        let mut snapshot = json!({"schemaVersion":2,"cityId":city_id,"cityRevision":0,"worldRevision":"world-r1","seed":42,
            "layout":{"schemaVersion":1,"id":"layout-1","coordinateSystem":"city-local-m-v1","anchors":[{"id":"start","kind":"spawn","capabilities":["drive"],"geometryRef":"g:start"}],"links":[]}});
        let saved = crate::creator_city_patch::store_scoped_city_layout(&home, &snapshot).unwrap();
        assert_eq!(crate::creator_city_patch::store_scoped_city_layout(&home, &snapshot).unwrap(), saved);
        snapshot["seed"] = json!(43);
        assert_eq!(crate::creator_city_patch::store_scoped_city_layout(&home, &snapshot).unwrap_err(), "creator_layout_scope_invalid");
        snapshot["seed"] = json!(42);
        snapshot["layout"]["anchors"][0]["id"] = json!("changed");
        assert_eq!(crate::creator_city_patch::store_scoped_city_layout(&home, &snapshot).unwrap_err(), "creator_layout_revision_conflict");
        snapshot["cityId"] = json!("city-missing");
        assert_eq!(crate::creator_city_patch::store_scoped_city_layout(&home, &snapshot).unwrap_err(), "creator_city_not_found");
        snapshot["cityId"] = json!(city_id);
        snapshot["cityRevision"] = json!(1);
        assert_eq!(crate::creator_city_patch::store_scoped_city_layout(&home, &snapshot).unwrap_err(), "revision_conflict");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn diagnostics_persist_with_bounded_redacted_events() {
        let home = std::env::temp_dir().join(new_id("city-diag-test-").unwrap());
        let city = create_city(&home, "owner", "create", "Desert", 42, &json!({"id":"desert"})).unwrap();
        let id = city["cityId"].as_str().unwrap();
        record_diagnostic(&home, id, 0, "view:one", "view_started", None, Some(0)).unwrap();
        record_diagnostic(&home, id, 0, "view:one", "view_failed", Some("planning_outcome_failed"), Some(23)).unwrap();
        assert_eq!(record_diagnostic(&home, id, 0, "view:one", "view_failed", Some("/private/raw-error"), Some(1)).unwrap_err(), "creator_diagnostic_invalid");
        assert_eq!(record_diagnostic(&home, "missing", 0, "view:one", "view_ready", None, Some(1)).unwrap_err(), "creator_city_not_found");
        let events = read_diagnostics(&home, id, 10).unwrap();
        assert_eq!(events["events"].as_array().unwrap().len(), 2);
        assert_eq!(events["events"][0]["code"], "planning_outcome_failed");
        assert_eq!(events["events"][0]["correlationId"], "view:one");
        assert!(!events.to_string().contains("private"));
        let mut db = database(&home).unwrap();
        let tx = db.transaction().unwrap();
        for _ in 0..500 {
            tx.execute("INSERT INTO creator_city_diagnostics(city_id,city_revision,correlation_id,event,created_at_ms) VALUES(?1,0,'view:bulk','view_started',0)", [id]).unwrap();
        }
        tx.commit().unwrap();
        drop(db);
        record_diagnostic(&home, id, 0, "view:last", "view_ready", None, Some(1)).unwrap();
        let db = database(&home).unwrap();
        let count: u64 = db.query_row("SELECT count(*) FROM creator_city_diagnostics WHERE city_id=?1", [id], |row| row.get(0)).unwrap();
        assert_eq!(count, 500);
        drop(db);
        std::fs::remove_dir_all(home).unwrap();
    }
}
