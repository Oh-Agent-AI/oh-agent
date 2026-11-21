use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;

use crate::creator_store::{canonical_json, database, digest, new_id, now_ms, read_creator_artifact, valid_id};

const DRAFT_TTL_MS: u64 = 30 * 60 * 1000;
const ARCHIVE_PREVIEW_TTL_MS: u64 = 10 * 60 * 1000;
const MAX_PROFILE_BYTES: usize = 16 * 1024;

fn required_text<'a>(payload: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    payload.get(key).and_then(Value::as_str).filter(|value| valid_id(value)).ok_or("creator_request_invalid")
}
fn required_name(payload: &Value) -> Result<&str, &'static str> {
    let name = payload.get("name").and_then(Value::as_str).ok_or("creator_city_invalid")?;
    if name.trim() != name || name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) { return Err("creator_city_invalid"); }
    Ok(name)
}
fn required_seed(payload: &Value) -> Result<u32, &'static str> {
    payload.get("seed").and_then(Value::as_u64).filter(|seed| *seed <= u32::MAX as u64).map(|seed| seed as u32).ok_or("creator_city_invalid")
}
fn required_profile(payload: &Value) -> Result<&Value, &'static str> {
    let profile = payload.get("profile").filter(|value| value.is_object()).ok_or("creator_city_invalid")?;
    if canonical_json(profile).map_err(|_| "creator_city_invalid")?.len() > MAX_PROFILE_BYTES { return Err("creator_city_invalid"); }
    Ok(profile)
}
fn validate_request(payload: &Value, name: &str, seed: u32, profile: &Value, operation_id: &str) -> Result<(), &'static str> {
    let validation = payload.get("validation").and_then(Value::as_object).ok_or("creator_validation_required")?;
    if validation.len() != 3 || validation.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || validation.get("ok").and_then(Value::as_bool) != Some(true) { return Err("creator_preview_invalid"); }
    let request = json!({"name":name,"seed":seed,"profile":profile,"operationId":operation_id});
    let expected = digest(&canonical_json(&request).map_err(|_| "creator_city_invalid")?);
    if validation.get("requestDigest").and_then(Value::as_str) != Some(expected.as_str()) { return Err("creator_validation_scope_mismatch"); }
    Ok(())
}
fn request_hash(payload: &Value) -> Result<String, &'static str> {
    Ok(digest(&canonical_json(payload).map_err(|_| "creator_request_invalid")?))
}
fn previous_receipt(tx: &rusqlite::Transaction<'_>, actor: &str, operation_id: &str, hash: &str) -> Result<Option<Value>, &'static str> {
    let previous: Option<(String,String)> = tx.query_row("SELECT operation_hash,result_json FROM creator_city_operations WHERE actor_id=?1 AND operation_id=?2",
        params![actor,operation_id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| "creator_store_unavailable")?;
    match previous {
        Some((existing, result)) if existing == hash => Ok(Some(serde_json::from_str(&result).map_err(|_| "creator_store_unavailable")?)),
        Some(_) => Err("operation_id_conflict"),
        None => Ok(None),
    }
}
fn save_receipt(tx: &rusqlite::Transaction<'_>, actor: &str, operation_id: &str, hash: &str, city_id: &str, result: &Value) -> Result<(), &'static str> {
    let result_json = canonical_json(result).map_err(|_| "creator_request_invalid")?;
    tx.execute("INSERT INTO creator_city_operations(actor_id,operation_id,operation_hash,city_id,result_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",
        params![actor,operation_id,hash,city_id,result_json,now_ms()]).map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

fn draft_summary(db: &rusqlite::Connection, draft_id: &str) -> Result<Value, &'static str> {
    let row = db.query_row("SELECT name,seed,profile_json,content_digest,status,city_id,created_at_ms,expires_at_ms FROM creator_city_drafts WHERE draft_id=?1",
        [draft_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,u32>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,
            row.get::<_,Option<String>>(5)?,row.get::<_,u64>(6)?,row.get::<_,u64>(7)?))).optional().map_err(|_| "creator_store_unavailable")?
        .ok_or("creator_city_draft_not_found")?;
    let (name, seed, profile_json, content_digest, mut status, city_id, created_at_ms, expires_at_ms) = row;
    if status == "pending" && expires_at_ms <= now_ms() {
        status = "expired".into();
        db.execute("UPDATE creator_city_drafts SET status='expired' WHERE draft_id=?1 AND status='pending'", [draft_id]).map_err(|_| "creator_store_unavailable")?;
    }
    let profile: Value = serde_json::from_str(&profile_json).map_err(|_| "creator_store_unavailable")?;
    if digest(&canonical_json(&json!({"name":name,"seed":seed,"profile":profile})).map_err(|_| "creator_city_invalid")?) != content_digest {
        return Err("creator_city_draft_digest_mismatch");
    }
    Ok(json!({"draftId":draft_id,"name":name,"seed":seed,"profile":profile,"contentDigest":content_digest,"status":status,
        "cityId":city_id,"createdAtMs":created_at_ms,"expiresAtMs":expires_at_ms}))
}

pub fn draft_create(home: &Path, actor: &str, payload: &Value) -> Result<Value, &'static str> {
    if !valid_id(actor) { return Err("creator_request_invalid"); }
    let name = required_name(payload)?;
    let seed = required_seed(payload)?;
    let profile = required_profile(payload)?;
    let operation_id = required_text(payload, "operationId")?;
    validate_request(payload, name, seed, profile, operation_id)?;
    let hash = request_hash(payload)?;
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some(result) = previous_receipt(&tx, actor, operation_id, &hash)? { return Ok(result); }
    let now = now_ms();
    let draft_id = new_id("city-draft-")?;
    let content_digest = digest(&canonical_json(&json!({"name":name,"seed":seed,"profile":profile})).map_err(|_| "creator_city_invalid")?);
    tx.execute("INSERT INTO creator_city_drafts(draft_id,name,seed,profile_json,content_digest,status,created_at_ms,expires_at_ms)
        VALUES(?1,?2,?3,?4,?5,'pending',?6,?7)", params![draft_id,name,seed,canonical_json(profile).map_err(|_| "creator_city_invalid")?,content_digest,now,now.saturating_add(DRAFT_TTL_MS)])
        .map_err(|_| "creator_store_unavailable")?;
    let result = json!({"draftId":draft_id,"status":"pending","contentDigest":content_digest,"expiresAtMs":now.saturating_add(DRAFT_TTL_MS)});
    save_receipt(&tx, actor, operation_id, &hash, &draft_id, &result)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    draft_summary(&db, &draft_id)
}

pub fn draft_read(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let draft_id = required_text(payload, "draftId")?;
    draft_summary(&database(home)?, draft_id)
}

pub fn draft_cancel(home: &Path, actor: &str, payload: &Value) -> Result<Value, &'static str> {
    if !valid_id(actor) { return Err("creator_request_invalid"); }
    let draft_id = required_text(payload, "draftId")?;
    let operation_id = required_text(payload, "operationId")?;
    let hash = request_hash(payload)?;
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some(result) = previous_receipt(&tx, actor, operation_id, &hash)? { return Ok(result); }
    let current = draft_summary(&tx, draft_id)?;
    let next = if current["status"] == "pending" { "cancelled" } else { current["status"].as_str().ok_or("creator_city_draft_invalid")? };
    if next == "cancelled" { tx.execute("UPDATE creator_city_drafts SET status='cancelled' WHERE draft_id=?1 AND status='pending'", [draft_id]).map_err(|_| "creator_store_unavailable")?; }
    let result = json!({"draftId":draft_id,"status":next,"cityId":current["cityId"]});
    save_receipt(&tx, actor, operation_id, &hash, draft_id, &result)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

pub fn draft_commit(home: &Path, actor: &str, payload: &Value) -> Result<Value, &'static str> {
    if !valid_id(actor) { return Err("creator_request_invalid"); }
    let draft_id = required_text(payload, "draftId")?;
    let operation_id = required_text(payload, "operationId")?;
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    let current = draft_summary(&tx, draft_id)?;
    if current["status"] == "expired" { return Err("creator_city_draft_expired"); }
    if current["status"] == "cancelled" { return Err("creator_city_draft_cancelled"); }
    if current["status"] == "committed" && current["cityId"].is_string() {
        return Ok(json!({"draftId":draft_id,"status":"committed","cityId":current["cityId"],"contentDigest":current["contentDigest"]}));
    }
    let name = current["name"].as_str().ok_or("creator_city_draft_invalid")?;
    let seed = current["seed"].as_u64().filter(|seed| *seed <= u32::MAX as u64).ok_or("creator_city_draft_invalid")? as u32;
    let profile = &current["profile"];
    validate_request(payload, name, seed, profile, operation_id)?;
    let registered = crate::creator_cities::create_city_in_transaction(&tx, actor, operation_id, name, seed, profile, None)?;
    let city_id = registered["cityId"].as_str().ok_or("creator_city_invalid")?;
    tx.execute("UPDATE creator_city_drafts SET status='committed',city_id=?2 WHERE draft_id=?1 AND status='pending'", params![draft_id,city_id])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"draftId":draft_id,"status":"committed","cityId":city_id,"revision":registered["revision"],"contentDigest":current["contentDigest"]}))
}

fn city_dependencies(tx: &rusqlite::Transaction<'_>, home: &Path, city_id: &str) -> Result<Value, &'static str> {
    let (revision, document): (u64,String) = tx.query_row("SELECT revision,document_json FROM creator_cities WHERE city_id=?1", [city_id], |row| Ok((row.get(0)?,row.get(1)?)))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_city_not_found")?;
    let document: Value = serde_json::from_str(&document).map_err(|_| "creator_store_unavailable")?;
    let mut statement = tx.prepare("SELECT installation_id,game_id,build_id,status FROM city_game_installations WHERE city_id=?1 ORDER BY installation_id").map_err(|_| "creator_store_unavailable")?;
    let installations = statement.query_map([city_id], |row| Ok(json!({"installationId":row.get::<_,String>(0)?,"gameId":row.get::<_,String>(1)?,"buildId":row.get::<_,String>(2)?,"status":row.get::<_,String>(3)?})))
        .map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")?;
    let mut statement = tx.prepare("SELECT project_id,revision,document_json FROM creator_projects WHERE json_extract(document_json,'$.cityId')=?1 ORDER BY project_id").map_err(|_| "creator_store_unavailable")?;
    let projects = statement.query_map([city_id], |row| {
        let raw = row.get::<_,String>(2)?;
        let document: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        Ok(json!({"projectId":row.get::<_,String>(0)?,"revision":row.get::<_,u64>(1)?,"title":document.get("title").cloned().unwrap_or(Value::Null)}))
    }).map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")?;
    let mut statement = tx.prepare("SELECT release_id,project_id,revision FROM creator_releases WHERE json_extract(snapshot_json,'$.cityId')=?1 ORDER BY release_id").map_err(|_| "creator_store_unavailable")?;
    let releases = statement.query_map([city_id], |row| Ok(json!({"releaseId":row.get::<_,String>(0)?,"projectId":row.get::<_,String>(1)?,"revision":row.get::<_,u64>(2)?})))
        .map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")?;
    let mut statement = tx.prepare("SELECT candidate_id,project_id,revision,accepted_release_id FROM creator_candidates WHERE json_extract(snapshot_json,'$.cityId')=?1 ORDER BY candidate_id").map_err(|_| "creator_store_unavailable")?;
    let candidates = statement.query_map([city_id], |row| Ok(json!({"candidateId":row.get::<_,String>(0)?,"projectId":row.get::<_,String>(1)?,"revision":row.get::<_,u64>(2)?,"acceptedReleaseId":row.get::<_,Option<String>>(3)?})))
        .map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")?;
    let world_package: Option<(String,String,String)> = tx.query_row("SELECT package_id,version,content_digest FROM creator_city_world_packages WHERE city_id=?1", [city_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|_| "creator_store_unavailable")?;
    let world_package = match world_package { Some((package_id,version,content_digest)) => json!({"packageId":package_id,"version":version,"contentDigest":content_digest}), None => Value::Null };
    let mut active_runs = Vec::new();
    let mut statement = tx.prepare("SELECT run_id,release_id,status FROM creator_playtest_runs WHERE active_slot=1 ORDER BY run_id").map_err(|_| "creator_store_unavailable")?;
    let template_runs = statement.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)))
        .map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")?;
    for (run_id, artifact_id, status) in template_runs {
        let artifact = read_creator_artifact(tx, &artifact_id)?;
        let snapshot: Value = serde_json::from_str(&artifact.snapshot_json).map_err(|_| "creator_store_unavailable")?;
        if snapshot["cityId"].as_str() == Some(city_id) { active_runs.push(json!({"runId":run_id,"kind":"template-playtest","status":status,"artifactId":artifact_id})); }
    }
    let mut statement = tx.prepare("SELECT run_id,game_id,status FROM city_game_runs WHERE city_id=?1 AND active_slot IS NOT NULL ORDER BY run_id").map_err(|_| "creator_store_unavailable")?;
    let game_runs = statement.query_map([city_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)))
        .map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")?;
    for (run_id, game_id, status) in game_runs { active_runs.push(json!({"runId":run_id,"kind":"city-game-runtime","status":status,"gameId":game_id})); }
    active_runs.extend(crate::creator_code_game::active_previews_for_city(home, city_id).map_err(|_| "creator_store_unavailable")?);
    let already_archived: Option<String> = tx.query_row("SELECT city_id FROM creator_city_archives WHERE city_id=?1", [city_id], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let mut dependencies = json!({"cityId":city_id,"revision":revision,"name":document["name"],"installations":installations,"projects":projects,
        "releases":releases,"candidates":candidates,"worldPackage":world_package,"activeRuns":active_runs,"alreadyArchived":already_archived.is_some()});
    dependencies["canArchive"] = json!(dependencies["activeRuns"].as_array().is_some_and(Vec::is_empty) && !already_archived.is_some());
    dependencies["dependencyDigest"] = json!(digest(&canonical_json(&dependencies).map_err(|_| "creator_request_invalid")?));
    Ok(dependencies)
}

pub fn archive_preview(home: &Path, actor: &str, payload: &Value) -> Result<Value, &'static str> {
    if !valid_id(actor) { return Err("creator_request_invalid"); }
    let city_id = required_text(payload, "cityId")?;
    let expected_revision = payload.get("expectedCityRevision").and_then(Value::as_u64).ok_or("creator_request_invalid")?;
    let operation_id = required_text(payload, "operationId")?;
    let hash = request_hash(payload)?;
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some(result) = previous_receipt(&tx, actor, operation_id, &hash)? { return Ok(result); }
    let dependencies = city_dependencies(&tx, home, city_id)?;
    if dependencies["revision"].as_u64() != Some(expected_revision) { return Err("revision_conflict"); }
    let now = now_ms();
    let preview_id = new_id("city-archive-preview-")?;
    tx.execute("INSERT INTO creator_city_archive_previews(preview_id,city_id,expected_revision,dependencies_json,operation_id,created_at_ms,expires_at_ms)
        VALUES(?1,?2,?3,?4,?5,?6,?7)", params![preview_id,city_id,expected_revision,canonical_json(&dependencies).map_err(|_| "creator_request_invalid")?,operation_id,now,now.saturating_add(ARCHIVE_PREVIEW_TTL_MS)])
        .map_err(|_| "creator_store_unavailable")?;
    let mut result = dependencies;
    result["previewId"] = json!(preview_id);
    result["expiresAtMs"] = json!(now.saturating_add(ARCHIVE_PREVIEW_TTL_MS));
    save_receipt(&tx, actor, operation_id, &hash, city_id, &result)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

pub fn archive_commit(home: &Path, actor: &str, payload: &Value) -> Result<Value, &'static str> {
    if !valid_id(actor) { return Err("creator_request_invalid"); }
    let preview_id = required_text(payload, "previewId")?;
    let operation_id = required_text(payload, "operationId")?;
    let confirmation_digest = required_text(payload, "dependencyDigest")?;
    let hash = request_hash(payload)?;
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some(result) = previous_receipt(&tx, actor, operation_id, &hash)? { return Ok(result); }
    let (city_id, expected_revision, expires_at_ms): (String,u64,u64) = tx.query_row("SELECT city_id,expected_revision,expires_at_ms FROM creator_city_archive_previews WHERE preview_id=?1",
        [preview_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_archive_preview_not_found")?;
    if expires_at_ms <= now_ms() { return Err("creator_archive_preview_expired"); }
    let dependencies = city_dependencies(&tx, home, &city_id)?;
    if dependencies["revision"].as_u64() != Some(expected_revision) { return Err("revision_conflict"); }
    if dependencies["dependencyDigest"].as_str() != Some(confirmation_digest) { return Err("creator_archive_dependencies_changed"); }
    if !dependencies["canArchive"].as_bool().unwrap_or(false) {
        return Err(if dependencies["alreadyArchived"].as_bool() == Some(true) { "creator_city_already_archived" } else { "creator_city_active_run" });
    }
    tx.execute("INSERT INTO creator_city_archives(city_id,archived_at_ms,dependencies_json) VALUES(?1,?2,?3)",
        params![city_id,now_ms(),canonical_json(&dependencies).map_err(|_| "creator_request_invalid")?]).map_err(|_| "creator_store_unavailable")?;
    let result = json!({"cityId":city_id,"status":"archived","archivedAtMs":now_ms(),"dependencyDigest":confirmation_digest});
    save_receipt(&tx, actor, operation_id, &hash, &city_id, &result)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

pub fn archive_list(home: &Path) -> Result<Value, &'static str> {
    let db = database(home)?;
    let mut statement = db.prepare("SELECT a.city_id,a.archived_at_ms,a.dependencies_json,c.document_json FROM creator_city_archives a JOIN creator_cities c ON c.city_id=a.city_id ORDER BY a.archived_at_ms DESC,a.city_id").map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map([], |row| {
        let dependencies: Value = serde_json::from_str(&row.get::<_,String>(2)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let document: Value = serde_json::from_str(&row.get::<_,String>(3)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
        Ok(json!({"cityId":row.get::<_,String>(0)?,"archivedAtMs":row.get::<_,u64>(1)?,"name":document.get("name").cloned().unwrap_or(Value::Null),"dependencies":dependencies}))
    }).map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"cities":rows}))
}

pub fn archive_restore(home: &Path, actor: &str, payload: &Value) -> Result<Value, &'static str> {
    if !valid_id(actor) { return Err("creator_request_invalid"); }
    let city_id = required_text(payload, "cityId")?;
    let operation_id = required_text(payload, "operationId")?;
    let hash = request_hash(payload)?;
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some(result) = previous_receipt(&tx, actor, operation_id, &hash)? { return Ok(result); }
    tx.execute("DELETE FROM creator_city_archives WHERE city_id=?1", [city_id]).map_err(|_| "creator_store_unavailable")?;
    let result = json!({"cityId":city_id,"status":"active"});
    save_receipt(&tx, actor, operation_id, &hash, city_id, &result)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let home = std::env::temp_dir().join(format!("city-lifecycle-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&home);
        home
    }
    fn profile() -> Value { json!({"schemaVersion":1,"id":"desert","geography":{"generator":"arid-dunes-v1"}}) }
    fn operation_request(operation_id: &str) -> Value {
        let profile = profile();
        json!({"name":"Draft City","seed":7,"profile":profile,"operationId":operation_id,
            "validation":{"schemaVersion":1,"requestDigest":digest(&canonical_json(&json!({"name":"Draft City","seed":7,"profile":profile,"operationId":operation_id})).unwrap()),"ok":true}})
    }

    #[test]
    fn draft_registers_only_on_first_save_and_cancel_is_clean() {
        let home = home();
        let created = draft_create(&home, "local", &operation_request("draft-create")).unwrap();
        let draft_id = created["draftId"].as_str().unwrap();
        assert_eq!(crate::creator_cities::list_cities(&home, "", 50).unwrap()["cities"].as_array().unwrap().len(), 0);
        let cancelled = draft_cancel(&home, "local", &json!({"draftId":draft_id,"operationId":"draft-cancel"})).unwrap();
        assert_eq!(cancelled["status"], "cancelled");
        assert_eq!(crate::creator_cities::list_cities(&home, "", 50).unwrap()["cities"].as_array().unwrap().len(), 0);
        assert_eq!(draft_commit(&home, "local", &json!({"draftId":draft_id,"operationId":"draft-commit","validation":operation_request("draft-commit")["validation"]})).unwrap_err(), "creator_city_draft_cancelled");
        let second = draft_create(&home, "local", &operation_request("draft-create-2")).unwrap();
        let second_id = second["draftId"].as_str().unwrap();
        let committed = draft_commit(&home, "local", &json!({"draftId":second_id,"operationId":"draft-commit-2","validation":operation_request("draft-commit-2")["validation"]})).unwrap();
        assert_eq!(committed["status"], "committed");
        assert_eq!(crate::creator_cities::list_cities(&home, "", 50).unwrap()["cities"].as_array().unwrap().len(), 1);
        let expired = draft_create(&home, "local", &operation_request("draft-create-3")).unwrap();
        let expired_id = expired["draftId"].as_str().unwrap();
        let db = database(&home).unwrap();
        db.execute("UPDATE creator_city_drafts SET expires_at_ms=0 WHERE draft_id=?1", [expired_id]).unwrap();
        assert_eq!(draft_read(&home, &json!({"draftId":expired_id})).unwrap()["status"], "expired");
        assert_eq!(draft_commit(&home, "local", &json!({"draftId":expired_id,"operationId":"draft-commit-3","validation":operation_request("draft-commit-3")["validation"]})).unwrap_err(), "creator_city_draft_expired");
        assert_eq!(crate::creator_cities::list_cities(&home, "", 50).unwrap()["cities"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn archive_hides_restores_and_preserves_dependencies() {
        let home = home();
        let created = crate::creator_cities::create_city(&home, "local", "city-create", "Archive City", 7, &profile()).unwrap();
        let city_id = created["cityId"].as_str().unwrap();
        let db = database(&home).unwrap();
        db.execute("INSERT INTO city_game_installations(installation_id,city_id,game_id,build_id,city_revision,status,installed_at_ms,updated_at_ms)
            VALUES('installation-1',?1,'game-1','build-1',0,'installed',1,1)", [city_id]).unwrap();
        db.execute("INSERT INTO creator_projects(project_id,revision,document_json,created_at_ms,updated_at_ms) VALUES('project-1',2,?1,1,1)",
            [json!({"cityId":city_id,"title":"Dependent project"}).to_string()]).unwrap();
        let snapshot = json!({"cityId":city_id}).to_string();
        db.execute("INSERT INTO creator_releases(release_id,project_id,revision,layout_id,world_revision,snapshot_json,snapshot_digest,created_at_ms)
            VALUES('release-1','project-1',2,'layout','world',?1,'digest',1)", [&snapshot]).unwrap();
        db.execute("INSERT INTO creator_candidates(candidate_id,project_id,revision,layout_id,world_revision,snapshot_json,snapshot_digest,created_at_ms)
            VALUES('candidate-1','project-1',2,'layout','world',?1,'digest',1)", [&snapshot]).unwrap();
        db.execute("INSERT INTO creator_content_packages(package_id,version,kind,content_digest,manifest_json,package_path,file_count,byte_length,installed_at_ms)
            VALUES('world-1','1','city-world','digest','{}','/unused',0,0,1)", []).unwrap();
        db.execute("INSERT INTO creator_city_world_packages(city_id,package_id,version,content_digest,created_at_ms) VALUES(?1,'world-1','1','digest',1)", [city_id]).unwrap();
        let preview = archive_preview(&home, "local", &json!({"cityId":city_id,"expectedCityRevision":0,"operationId":"archive-preview"})).unwrap();
        assert_eq!(preview["canArchive"], true);
        assert_eq!(preview["installations"].as_array().unwrap().len(), 1);
        assert_eq!(preview["projects"].as_array().unwrap().len(), 1);
        assert_eq!(preview["releases"].as_array().unwrap().len(), 1);
        assert_eq!(preview["candidates"].as_array().unwrap().len(), 1);
        assert_eq!(preview["worldPackage"]["packageId"], "world-1");
        let committed = archive_commit(&home, "local", &json!({"previewId":preview["previewId"],"operationId":"archive-commit","dependencyDigest":preview["dependencyDigest"]})).unwrap();
        assert_eq!(committed["status"], "archived");
        assert_eq!(crate::creator_cities::list_cities(&home, "", 50).unwrap()["cities"].as_array().unwrap().len(), 0);
        assert_eq!(archive_list(&home).unwrap()["cities"].as_array().unwrap().len(), 1);
        assert_eq!(archive_list(&home).unwrap()["cities"][0]["dependencies"]["installations"].as_array().unwrap().len(), 1);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM creator_releases", [], |row| row.get::<_,u64>(0)).unwrap(), 1);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM creator_candidates", [], |row| row.get::<_,u64>(0)).unwrap(), 1);
        assert_eq!(archive_restore(&home, "local", &json!({"cityId":city_id,"operationId":"archive-restore"})).unwrap()["status"], "active");
        assert_eq!(crate::creator_cities::list_cities(&home, "", 50).unwrap()["cities"].as_array().unwrap().len(), 1);
        assert!(crate::creator_cities::read_city(&home, city_id).is_ok());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn host_dispatch_supports_deferred_lifecycle_and_idempotent_replays() {
        let home = home();
        let created = crate::creator_projects::dispatch_as(&home, "local", "studio", "creator.city.draft.create", &operation_request("draft-host-create")).unwrap();
        let draft_id = created["draftId"].as_str().unwrap();
        assert_eq!(crate::creator_projects::dispatch_as(&home, "local", "studio", "creator.city.draft.create", &operation_request("draft-host-create")).unwrap()["draftId"], draft_id);
        let committed = crate::creator_projects::dispatch_as(&home, "local", "studio", "creator.city.draft.commit",
            &json!({"draftId":draft_id,"operationId":"draft-host-commit","validation":operation_request("draft-host-commit")["validation"]})).unwrap();
        let city_id = committed["cityId"].as_str().unwrap();
        assert_eq!(crate::creator_projects::dispatch_as(&home, "local", "studio", "creator.city.draft.commit",
            &json!({"draftId":draft_id,"operationId":"draft-host-commit","validation":operation_request("draft-host-commit")["validation"]})).unwrap()["cityId"], city_id);
        let preview = crate::creator_projects::dispatch_as(&home, "local", "studio", "creator.city.archive.preview",
            &json!({"cityId":city_id,"expectedCityRevision":0,"operationId":"archive-host-preview"})).unwrap();
        let archived = crate::creator_projects::dispatch_as(&home, "local", "studio", "creator.city.archive.commit",
            &json!({"previewId":preview["previewId"],"operationId":"archive-host-commit","dependencyDigest":preview["dependencyDigest"]})).unwrap();
        assert_eq!(crate::creator_projects::dispatch_as(&home, "local", "studio", "creator.city.archive.commit",
            &json!({"previewId":preview["previewId"],"operationId":"archive-host-commit","dependencyDigest":preview["dependencyDigest"]})).unwrap(), archived);
        assert_eq!(crate::creator_projects::dispatch_as(&home, "local", "studio", "creator.city.archive.list", &json!({})).unwrap()["cities"].as_array().unwrap().len(), 1);
        crate::creator_projects::dispatch_as(&home, "local", "studio", "creator.city.archive.restore", &json!({"cityId":city_id,"operationId":"archive-host-restore"})).unwrap();
        assert_eq!(crate::creator_projects::dispatch_as(&home, "local", "studio", "creator.city.list", &json!({"limit":50})).unwrap()["cities"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn archive_blocks_queued_code_preview_for_source_city() {
        let home = home();
        let created = crate::creator_cities::create_city(&home, "local", "city-code-preview", "Preview City", 7, &profile()).unwrap();
        let city_id = created["cityId"].as_str().unwrap();
        let directory = home.join("state/creator/code-games/previews/preview-active");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("request.json"), json!({"previewId":"preview-active","source":{"cityId":city_id},"status":"queued"}).to_string()).unwrap();
        let preview = archive_preview(&home, "local", &json!({"cityId":city_id,"expectedCityRevision":0,"operationId":"archive-code-preview"})).unwrap();
        assert_eq!(preview["canArchive"], false);
        assert_eq!(preview["activeRuns"].as_array().unwrap().len(), 1);
        assert_eq!(preview["activeRuns"][0]["kind"], "code-preview");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn archive_dependency_digest_blocks_toc_tou_and_active_runs() {
        let home = home();
        let created = crate::creator_cities::create_city(&home, "local", "city-active", "Active City", 7, &profile()).unwrap();
        let city_id = created["cityId"].as_str().unwrap();
        let preview = archive_preview(&home, "local", &json!({"cityId":city_id,"expectedCityRevision":0,"operationId":"archive-active-preview"})).unwrap();
        let db = database(&home).unwrap();
        db.execute("INSERT INTO city_game_runs(run_id,city_instance_id,city_id,game_id,player_id,build_id,status,active_slot,created_at_ms,expires_at_ms)
            VALUES('run-active','city-instance',?1,'game','player','build','active','active',1,9999999999999)", [city_id]).unwrap();
        let changed = archive_preview(&home, "local", &json!({"cityId":city_id,"expectedCityRevision":0,"operationId":"archive-active-preview-2"})).unwrap();
        assert_eq!(changed["canArchive"], false);
        assert_eq!(changed["activeRuns"].as_array().unwrap().len(), 1);
        assert_eq!(archive_commit(&home, "local", &json!({"previewId":preview["previewId"],"operationId":"archive-active-commit","dependencyDigest":preview["dependencyDigest"]})).unwrap_err(), "creator_archive_dependencies_changed");
        assert_eq!(archive_commit(&home, "local", &json!({"previewId":changed["previewId"],"operationId":"archive-active-commit-2","dependencyDigest":changed["dependencyDigest"]})).unwrap_err(), "creator_city_active_run");
        let _ = std::fs::remove_dir_all(home);
    }
}
