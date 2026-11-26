use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;
use crate::creator_store::{canonical_json, database, digest, new_id, now_ms};

const PREVIEW_TTL_MS: u64 = 10 * 60 * 1_000;

pub(crate) fn migrate(db: &Connection) -> Result<(), &'static str> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS city_game_installations (
        installation_id TEXT PRIMARY KEY, city_id TEXT NOT NULL, game_id TEXT NOT NULL,
        build_id TEXT NOT NULL, city_revision INTEGER NOT NULL, status TEXT NOT NULL,
        installed_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        UNIQUE(city_id,game_id)
    );
    CREATE TABLE IF NOT EXISTS city_game_install_previews (
        preview_id TEXT PRIMARY KEY, build_id TEXT NOT NULL, target_city_id TEXT NOT NULL,
        expected_city_revision INTEGER NOT NULL, request_json TEXT NOT NULL, can_install INTEGER NOT NULL,
        diagnostics_json TEXT NOT NULL, status TEXT NOT NULL, current_build_id TEXT,
        created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS city_game_install_receipts (
        operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    );").map_err(|_| "creator_store_unavailable")?;
    let installation_columns = {
        let mut statement = db.prepare("PRAGMA table_info(city_game_installations)").map_err(|_| "creator_store_unavailable")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|_| "creator_store_unavailable")?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|_| "creator_store_unavailable")?
    };
    if !installation_columns.iter().any(|column| column == "city_revision") {
        db.execute("ALTER TABLE city_game_installations ADD COLUMN city_revision INTEGER", []).map_err(|_| "creator_store_unavailable")?;
        // 只在补列的旧库上回填一次；健康库保持只读 migrate——嵌套 database() 调用
        // 会撞上外层 Immediate 写事务的写锁（busy_timeout 3s 才失败）。
        db.execute("UPDATE city_game_installations SET city_revision=COALESCE((SELECT revision FROM creator_cities WHERE city_id=city_game_installations.city_id),0) WHERE city_revision IS NULL", [])
            .map_err(|_| "creator_store_unavailable")?;
    }
    let preview_columns = {
        let mut statement = db.prepare("PRAGMA table_info(city_game_install_previews)").map_err(|_| "creator_store_unavailable")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|_| "creator_store_unavailable")?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|_| "creator_store_unavailable")?
    };
    if !preview_columns.iter().any(|column| column == "current_build_id") {
        db.execute("ALTER TABLE city_game_install_previews ADD COLUMN current_build_id TEXT", []).map_err(|_| "creator_store_unavailable")?;
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.starts_with(|c: char| c.is_ascii_alphanumeric())
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-'))
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    value.get(key).and_then(Value::as_str).filter(|value| valid_id(value)).ok_or("game_argument_invalid")
}
fn flag(request: &Value, key: &str) -> Result<bool, &'static str> {
    match request.get(key) { None => Ok(false), Some(value) => value.as_bool().ok_or("game_argument_invalid") }
}

fn receipt(db: &Connection, operation: &str, hash: &str) -> Result<Option<Value>, &'static str> {
    let row = db.query_row("SELECT request_hash,result_json FROM city_game_install_receipts WHERE operation_id=?1", [operation],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional().map_err(|_| "creator_store_unavailable")?;
    match row {
        Some((existing, result)) if existing == hash => Ok(Some(serde_json::from_str(&result).map_err(|_| "creator_store_unavailable")?)),
        Some(_) => Err("operation_id_conflict"),
        None => Ok(None),
    }
}
fn save_receipt(tx: &rusqlite::Transaction<'_>, operation: &str, hash: &str, result: &Value, now: u64) -> Result<(), &'static str> {
    tx.execute("INSERT INTO city_game_install_receipts(operation_id,request_hash,result_json,created_at_ms) VALUES (?1,?2,?3,?4)",
        params![operation,hash,canonical_json(result).map_err(|_| "game_argument_invalid")?,now]).map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

fn current_city_revision(db: &Connection, city_id: &str) -> Result<u64, &'static str> {
    let (revision, raw) = db.query_row("SELECT revision,document_json FROM creator_cities WHERE city_id=?1", [city_id],
        |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?))).optional().map_err(|_| "creator_store_unavailable")?
        .ok_or("creator_city_not_found")?;
    let document: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    if document.get("cityId").and_then(Value::as_str) != Some(city_id) || document.get("revision").and_then(Value::as_u64) != Some(revision) {
        return Err("creator_store_corrupt");
    }
    Ok(revision)
}

fn compatibility(db: &Connection, manifest: &Value, city_id: &str) -> Result<(bool, Vec<String>), &'static str> {
    let required = manifest.get("world").and_then(Value::as_object).and_then(|world| world.get("requiredCapabilities"))
        .and_then(Value::as_array).ok_or("game_manifest_invalid")?;
    let snapshot = db.query_row("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id=?1 ORDER BY city_revision DESC LIMIT 1", [city_id],
        |row| row.get::<_, String>(0)).optional().map_err(|_| "creator_store_unavailable")?;
    let anchors = snapshot.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|snapshot| snapshot.get("layout").and_then(Value::as_object).and_then(|layout| layout.get("anchors")).and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let has_drive = anchors.iter().any(|anchor| anchor.get("capabilities").and_then(Value::as_array)
        .is_some_and(|capabilities| capabilities.iter().any(|capability| capability == "drive")));
    let has_fly = anchors.iter().any(|anchor| anchor.get("capabilities").and_then(Value::as_array)
        .is_some_and(|capabilities| capabilities.iter().any(|capability| capability == "fly")));
    let mut diagnostics = Vec::new();
    for capability in required.iter().filter_map(Value::as_str) {
        let supported = match capability {
            "world.read" | "world.snapshot" => true,
            "roads.read" | "roads.graph" => has_drive,
            "volumes.indexed" => has_fly,
            _ => false,
        };
        if !supported { diagnostics.push(format!("city_capability_missing:{capability}")); }
    }
    if required.iter().any(|capability| !capability.is_string()) { return Err("game_manifest_invalid"); }
    Ok((diagnostics.is_empty(), diagnostics))
}

pub(crate) fn preview(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let build_id = text(payload, "buildId")?;
    let city_id = text(payload, "targetCityId")?;
    let revision = payload.get("expectedCityRevision").and_then(Value::as_u64).ok_or("game_argument_invalid")?;
    let operation = text(payload, "operationId")?;
    if flag(payload, "runAfterInstall")? || flag(payload, "replaceCurrentView")? || flag(payload, "allowOfficialStoryWrites")? {
        return Err("preview_approval_required");
    }
    let hash = digest(&canonical_json(payload).map_err(|_| "game_argument_invalid")?);
    let now = now_ms();
    let mut db = database(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some(result) = receipt(&tx, operation, &hash)? { return Ok(result); }
    let manifest = crate::creator_code_game::sealed_build_manifest(home, build_id)?;
    let game_id = manifest.get("gameId").and_then(Value::as_str).ok_or("game_manifest_invalid")?;
    if current_city_revision(&tx, city_id)? != revision { return Err("city_install_revision_conflict"); }
    let (can_install, diagnostics) = compatibility(&tx, &manifest, city_id)?;
    let existing = tx.query_row("SELECT build_id FROM city_game_installations WHERE city_id=?1 AND game_id=?2", [city_id,game_id],
        |row| row.get::<_, String>(0)).optional().map_err(|_| "creator_store_unavailable")?;
    let preview_id = new_id("install-preview-")?;
    let diagnostic_rows: Vec<Value> = diagnostics.iter().map(|code| json!({"code":code,"severity":"error","message":code,"path":"world.requiredCapabilities"})).collect();
    let result = json!({"previewId":preview_id,"buildId":build_id,"targetCityId":city_id,"expectedCityRevision":revision,
        "gameId":game_id,"canInstall":can_install,"diagnostics":diagnostic_rows,"requiresUpdateConfirmation":existing.is_some(),
        "currentBuildId":existing,"expiresAtMs":now + PREVIEW_TTL_MS});
    tx.execute("INSERT INTO city_game_install_previews(preview_id,build_id,target_city_id,expected_city_revision,request_json,can_install,diagnostics_json,status,current_build_id,created_at_ms,expires_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9,?10)", params![preview_id,build_id,city_id,revision,canonical_json(payload).map_err(|_| "game_argument_invalid")?,
        can_install,canonical_json(&json!(diagnostics)).map_err(|_| "game_argument_invalid")?,existing,now,now + PREVIEW_TTL_MS])
        .map_err(|_| "creator_store_unavailable")?;
    save_receipt(&tx, operation, &hash, &result, now)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

fn require_update_confirmation(payload: &Value, current_build_id: &str, target_build_id: &str) -> Result<(), &'static str> {
    let confirmation = payload.get("updateConfirmation").and_then(Value::as_object).ok_or("city_install_existing_game")?;
    if confirmation.len() != 2
        || confirmation.get("currentBuildId").and_then(Value::as_str) != Some(current_build_id)
        || confirmation.get("buildId").and_then(Value::as_str) != Some(target_build_id) {
        return Err("city_install_existing_game");
    }
    Ok(())
}

pub(crate) fn commit(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let preview_id = text(payload, "previewId")?;
    let operation = text(payload, "operationId")?;
    let hash = digest(&canonical_json(payload).map_err(|_| "game_argument_invalid")?);
    let now = now_ms();
    let mut db = database(home)?;
    migrate(&db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    if let Some(result) = receipt(&tx, operation, &hash)? { return Ok(result); }
    let preview = tx.query_row("SELECT build_id,target_city_id,expected_city_revision,request_json,can_install,expires_at_ms,status,current_build_id FROM city_game_install_previews WHERE preview_id=?1",
        [preview_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,u64>(2)?,row.get::<_,String>(3)?,
            row.get::<_,bool>(4)?,row.get::<_,u64>(5)?,row.get::<_,String>(6)?,row.get::<_,Option<String>>(7)?)))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_preview_not_found")?;
    let (build_id, city_id, expected_revision, request_json, can_install, expires_at, status, preview_current_build) = preview;
    if expires_at <= now || status != "pending" { return Err("preview_expired"); }
    let request: Value = serde_json::from_str(&request_json).map_err(|_| "creator_store_unavailable")?;
    if !can_install { return Err("city_game_incompatible"); }
    if flag(&request, "runAfterInstall")? || flag(&request, "replaceCurrentView")? || flag(&request, "allowOfficialStoryWrites")? {
        return Err("preview_approval_required");
    }
    let manifest = crate::creator_code_game::sealed_build_manifest(home, &build_id)?;
    let game_id = manifest.get("gameId").and_then(Value::as_str).ok_or("game_manifest_invalid")?;
    if current_city_revision(&tx, &city_id)? != expected_revision { return Err("city_install_revision_conflict"); }
    let (compatible, _) = compatibility(&tx, &manifest, &city_id)?;
    if !compatible { return Err("city_game_incompatible"); }
    let existing = tx.query_row("SELECT installation_id,build_id FROM city_game_installations WHERE city_id=?1 AND game_id=?2", [&city_id, game_id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional().map_err(|_| "creator_store_unavailable")?;
    if existing.as_ref().map(|(_, current)| current.as_str()) != preview_current_build.as_deref() {
        return Err(if existing.is_some() { "city_install_existing_game" } else { "city_game_installation_not_found" });
    }
    let installation_id = match existing {
        Some((installation_id, current_build_id)) => {
            require_update_confirmation(payload, &current_build_id, &build_id)?;
            let changed = tx.execute("UPDATE city_game_installations SET build_id=?2,city_revision=?3,status='installed',updated_at_ms=?4
                WHERE installation_id=?1 AND city_id=?5 AND game_id=?6 AND build_id=?7",
                params![installation_id,build_id,expected_revision,now,city_id,game_id,current_build_id]).map_err(|_| "creator_store_unavailable")?;
            if changed != 1 { return Err("city_install_existing_game"); }
            installation_id
        }
        None => {
            if payload.get("updateConfirmation").is_some() { return Err("game_argument_invalid"); }
            let installation_id = new_id("installation-")?;
            tx.execute("INSERT INTO city_game_installations(installation_id,city_id,game_id,build_id,city_revision,status,installed_at_ms,updated_at_ms)
                VALUES (?1,?2,?3,?4,?5,'installed',?6,?6)",
                params![installation_id,city_id,game_id,build_id,expected_revision,now]).map_err(|_| "creator_store_unavailable")?;
            installation_id
        }
    };
    let changed = tx.execute("UPDATE city_game_install_previews SET status='committed' WHERE preview_id=?1 AND status='pending'", [preview_id])
        .map_err(|_| "creator_store_unavailable")?;
    if changed != 1 { return Err("preview_expired"); }
    let result = json!({"installationId":installation_id,"cityId":city_id,"cityRevision":expected_revision,"gameId":game_id,"buildId":build_id,
        "status":"installed","runAfterInstall":false,"replaceCurrentView":false,"officialStoryWrites":false});
    save_receipt(&tx, operation, &hash, &result, now)?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    Ok(result)
}

pub(crate) fn list(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let limit = payload.get("limit").and_then(Value::as_u64).unwrap_or(50).min(100);
    let city = payload.get("cityId").and_then(Value::as_str);
    let game = payload.get("gameId").and_then(Value::as_str);
    if city.is_some_and(|value| !valid_id(value)) || game.is_some_and(|value| !valid_id(value)) { return Err("game_argument_invalid"); }
    let mut db = database(home)?;
    migrate(&db)?;
    let tx = db.transaction().map_err(|_| "creator_store_unavailable")?;
    let installed_count: u64 = tx.query_row("SELECT COUNT(*) FROM city_game_installations
        WHERE (?1 IS NULL OR city_id=?1) AND (?2 IS NULL OR game_id=?2) AND status='installed'", params![city,game], |row| row.get(0))
        .map_err(|_| "creator_store_unavailable")?;
    let sql = "SELECT installation_id,city_id,game_id,build_id,COALESCE(city_revision,0),status,installed_at_ms,updated_at_ms FROM city_game_installations
        WHERE (?1 IS NULL OR city_id=?1) AND (?2 IS NULL OR game_id=?2) ORDER BY updated_at_ms DESC,installation_id LIMIT ?3";
    let mut statement = tx.prepare(sql).map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![city,game,limit], |row| Ok(json!({"installationId":row.get::<_,String>(0)?,
        "cityId":row.get::<_,String>(1)?,"gameId":row.get::<_,String>(2)?,"buildId":row.get::<_,String>(3)?,
        "cityRevision":row.get::<_,u64>(4)?,"status":row.get::<_,String>(5)?,"createdAtMs":row.get::<_,u64>(6)?,
        "installedAtMs":row.get::<_,u64>(6)?,"updatedAtMs":row.get::<_,u64>(7)?})))
        .map_err(|_| "creator_store_unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"installations":rows,"installedCount":installed_count}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::creator_store::bytes_digest;

    fn write_build(home: &Path, game_id: &str, game_version: &str) -> String {
        let manifest = json!({"schemaVersion":1,"kind":"code-game","gameId":game_id,"displayName":"Install Test","version":game_version,
            "entry":"src/index.ts","sdk":{"name":"@oh-agent/city-game-sdk","apiMajor":1},"world":{"requiredCapabilities":["world.read","roads.read"]},
            "permissions":["world.read","roads.read"],"limits":{"maxEntities":1,"maxProjectiles":0},"assets":[]});
        let bundle = b"export default {}";
        let map = b"{}";
        let manifest_digest = bytes_digest(canonical_json(&manifest).unwrap().as_bytes());
        let bundle_digest = bytes_digest(bundle);
        let map_digest = bytes_digest(map);
        let content_digest = bytes_digest(canonical_json(&json!({"manifestDigest":manifest_digest,"bundleDigest":bundle_digest,
            "sourceMapDigest":map_digest,"assetDigests":{}})).unwrap().as_bytes());
        let identity = json!({"domain":"oh-agent-code-game-build-v2","gameId":game_id,"gameVersion":game_version,
            "manifestDigest":manifest_digest,"contentDigest":content_digest,"sourceRevision":"source","sdkVersion":"1","toolchainVersion":"tool"});
        let build_id = bytes_digest(canonical_json(&identity).unwrap().as_bytes()).trim_start_matches("sha256:").to_string();
        let root = home.join("code-games/builds").join(&build_id);
        std::fs::create_dir_all(&root).unwrap();
        let record = json!({"schemaVersion":2,"kind":"code-game-build","buildId":build_id,"gameId":game_id,"gameVersion":game_version,
            "manifestSchemaVersion":1,"sdk":manifest["sdk"],"entry":"src/index.ts","bundle":"game.js","byteLength":bundle.len(),
            "bundleDigest":bundle_digest,"sourceMapDigest":map_digest,"manifestDigest":manifest_digest,"assetDigests":{},
            "contentDigest":content_digest,"sourceRevision":"source","sdkVersion":"1","toolchainVersion":"tool","bundler":"test"});
        std::fs::write(root.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        std::fs::write(root.join("game.js"), bundle).unwrap();
        std::fs::write(root.join("game.js.map"), map).unwrap();
        std::fs::write(root.join("build.json"), serde_json::to_vec(&record).unwrap()).unwrap();
        build_id
    }

    fn create_install_city(home: &Path, name: &str, operation: &str) -> Value {
        let profile = json!({"schemaVersion":1,"id":"desert","version":1,"biome":"arid",
            "geography":{"generator":"arid-dunes-v1","parameters":{"dunes":{"duneScale":190,"duneAmplitude":11,"orientationDeg":18}}},
            "visuals":{"themeId":"desert"}});
        let city = crate::creator_cities::create_city(home, "local", operation, name, 42, &profile).unwrap();
        let city_id = city["cityId"].as_str().unwrap();
        let revision = city["revision"].as_u64().unwrap();
        let db = database(home).unwrap();
        let snapshot = json!({"layout":{"anchors":[{"id":"road-spawn:a","capabilities":["drive"]}]}});
        db.execute("INSERT INTO creator_city_layouts_v2(city_id,city_revision,world_revision,layout_id,snapshot_json,snapshot_digest,created_at_ms)
            VALUES (?1,?2,'world-1','layout-1',?3,'digest',1)", params![city_id, revision, snapshot.to_string()]).unwrap();
        city
    }

    fn install_request(build_id: &str, city: &Value, operation: &str) -> Value {
        json!({"buildId":build_id,"targetCityId":city["cityId"],"expectedCityRevision":city["revision"],"operationId":operation,
            "runAfterInstall":false,"replaceCurrentView":false,"allowOfficialStoryWrites":false})
    }

    fn table_count(home: &Path, table: &str) -> u64 {
        database(home).unwrap().query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap()
    }

    fn install(home: &Path, build_id: &str, city: &Value, operation: &str) -> Value {
        let checked = preview(home, &install_request(build_id, city, &format!("{operation}-preview"))).unwrap();
        commit(home, &json!({"previewId":checked["previewId"],"operationId":format!("{operation}-commit")})).unwrap()
    }

    #[test]
    fn install_preview_commit_and_receipts_use_real_build_and_city() {
        let home = std::env::temp_dir().join(format!("city-install-flow-{}", now_ms()));
        let build_id = write_build(&home, "community.install-test", "1.0.0");
        let city = create_install_city(&home, "Install City", "city-create");
        let city_id = city["cityId"].as_str().unwrap();
        let revision = city["revision"].as_u64().unwrap();
        let request = install_request(&build_id, &city, "install-preview-1");
        let checked = crate::creator_projects::dispatch_as(&home, "local-profile-v1", "studio-test", "creator.code.install.preview", &request).unwrap();
        assert_eq!(checked["canInstall"], true);
        assert!(checked.get("ok").is_none());
        assert_eq!(checked["requiresUpdateConfirmation"], false);
        assert_eq!(checked["currentBuildId"], Value::Null);
        let commit_request = json!({"previewId":checked["previewId"],"operationId":"install-commit-1"});
        let committed = crate::creator_projects::dispatch_as(&home, "local-profile-v1", "studio-test", "creator.code.install.commit", &commit_request).unwrap();
        assert_eq!(committed["status"], "installed");
        assert_eq!(committed["cityRevision"], revision);
        assert_eq!(commit(&home, &commit_request).unwrap(), committed);
        assert_eq!(commit(&home, &json!({"previewId":"install-preview-other","operationId":"install-commit-1"})).unwrap_err(), "operation_id_conflict");
        let rows = list(&home, &json!({"cityId":city_id})).unwrap();
        assert_eq!(rows["installations"].as_array().unwrap().len(), 1);
        assert_eq!(rows["installations"][0]["buildId"], build_id);
        assert_eq!(rows["installations"][0]["cityRevision"], revision);
        assert_eq!(rows["installations"][0]["createdAtMs"], rows["installations"][0]["installedAtMs"]);
        assert_eq!(table_count(&home, "city_game_installations"), 1);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn update_requires_bound_confirmation_and_does_not_touch_other_city() {
        let home = std::env::temp_dir().join(format!("city-install-update-{}", now_ms()));
        let game_id = "community.install-test";
        let build_v1 = write_build(&home, game_id, "1.0.0");
        let build_v2 = write_build(&home, game_id, "2.0.0");
        let first_city = create_install_city(&home, "First City", "city-first");
        let second_city = create_install_city(&home, "Second City", "city-second");
        let first = install(&home, &build_v1, &first_city, "first-install");
        let second = install(&home, &build_v1, &second_city, "second-install");
        assert_ne!(first["installationId"], second["installationId"]);

        let checked = preview(&home, &install_request(&build_v2, &first_city, "update-preview")).unwrap();
        assert_eq!(checked["requiresUpdateConfirmation"], true);
        assert_eq!(checked["currentBuildId"], build_v1);
        let without_confirmation = json!({"previewId":checked["previewId"],"operationId":"update-commit-missing"});
        assert_eq!(commit(&home, &without_confirmation).unwrap_err(), "city_install_existing_game");
        let wrong_confirmation = json!({"previewId":checked["previewId"],"operationId":"update-commit-wrong",
            "updateConfirmation":{"currentBuildId":build_v2,"buildId":build_v2}});
        assert_eq!(commit(&home, &wrong_confirmation).unwrap_err(), "city_install_existing_game");
        assert_eq!(list(&home, &json!({"cityId":first_city["cityId"]})).unwrap()["installations"][0]["buildId"], build_v1);

        let confirmed_request = json!({"previewId":checked["previewId"],"operationId":"update-commit",
            "updateConfirmation":{"currentBuildId":build_v1,"buildId":build_v2}});
        let updated = crate::creator_projects::dispatch_as(&home, "local-profile-v1", "studio-test", "creator.code.install.commit", &confirmed_request).unwrap();
        assert_eq!(updated["installationId"], first["installationId"]);
        assert_eq!(updated["buildId"], build_v2);
        assert_eq!(commit(&home, &confirmed_request).unwrap(), updated);
        assert_eq!(commit(&home, &json!({"previewId":checked["previewId"],"operationId":"update-commit-replay",
            "updateConfirmation":{"currentBuildId":build_v1,"buildId":build_v2}})).unwrap_err(), "preview_expired");
        let first_rows = list(&home, &json!({"cityId":first_city["cityId"]})).unwrap();
        let second_rows = list(&home, &json!({"cityId":second_city["cityId"]})).unwrap();
        assert_eq!(first_rows["installations"][0]["buildId"], build_v2);
        assert_eq!(second_rows["installations"][0]["buildId"], build_v1);
        assert_eq!(second_rows["installations"][0]["installationId"], second["installationId"]);
        assert_eq!(table_count(&home, "city_game_installations"), 2);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn update_confirmation_cannot_overwrite_a_changed_current_build() {
        let home = std::env::temp_dir().join(format!("city-install-update-race-{}", now_ms()));
        let build_v1 = write_build(&home, "community.install-test", "1.0.0");
        let build_v2 = write_build(&home, "community.install-test", "2.0.0");
        let city = create_install_city(&home, "Install City", "city-create");
        install(&home, &build_v1, &city, "initial-install");
        let checked = preview(&home, &install_request(&build_v2, &city, "update-preview")).unwrap();
        let db = database(&home).unwrap();
        db.execute("UPDATE city_game_installations SET build_id=?1 WHERE city_id=?2", params![build_v2,city["cityId"].as_str().unwrap()]).unwrap();
        drop(db);
        let request = json!({"previewId":checked["previewId"],"operationId":"update-commit",
            "updateConfirmation":{"currentBuildId":build_v1,"buildId":build_v2}});
        assert_eq!(commit(&home, &request).unwrap_err(), "city_install_existing_game");
        assert_eq!(list(&home, &json!({"cityId":city["cityId"]})).unwrap()["installations"][0]["buildId"], build_v2);
        assert_eq!(table_count(&home, "city_game_installations"), 1);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn expired_and_replayed_commits_leave_no_partial_installation() {
        let home = std::env::temp_dir().join(format!("city-install-expiry-{}", now_ms()));
        let build_id = write_build(&home, "community.install-test", "1.0.0");
        let city = create_install_city(&home, "Install City", "city-create");
        let checked = preview(&home, &install_request(&build_id, &city, "expired-preview")).unwrap();
        database(&home).unwrap().execute("UPDATE city_game_install_previews SET expires_at_ms=0 WHERE preview_id=?1", [checked["previewId"].as_str().unwrap()]).unwrap();
        let expired_commit = json!({"previewId":checked["previewId"],"operationId":"expired-commit"});
        assert_eq!(commit(&home, &expired_commit).unwrap_err(), "preview_expired");
        assert_eq!(table_count(&home, "city_game_installations"), 0);
        let db = database(&home).unwrap();
        let status: String = db.query_row("SELECT status FROM city_game_install_previews WHERE preview_id=?1", [checked["previewId"].as_str().unwrap()], |row| row.get(0)).unwrap();
        assert_eq!(status, "pending");
        let commit_receipts: u64 = db.query_row("SELECT COUNT(*) FROM city_game_install_receipts WHERE operation_id='expired-commit'", [], |row| row.get(0)).unwrap();
        assert_eq!(commit_receipts, 0);
        drop(db);

        let checked = preview(&home, &install_request(&build_id, &city, "valid-preview")).unwrap();
        let committed = commit(&home, &json!({"previewId":checked["previewId"],"operationId":"valid-commit"})).unwrap();
        assert_eq!(committed["status"], "installed");
        assert_eq!(commit(&home, &json!({"previewId":checked["previewId"],"operationId":"valid-commit-other"})).unwrap_err(), "preview_expired");
        assert_eq!(table_count(&home, "city_game_installations"), 1);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn city_revision_conflict_is_atomic_and_preview_replay_is_idempotent() {
        let home = std::env::temp_dir().join(format!("city-install-revision-{}", now_ms()));
        let build_id = write_build(&home, "community.install-test", "1.0.0");
        let city = create_install_city(&home, "Install City", "city-create");
        let request = install_request(&build_id, &city, "revision-preview");
        let checked = preview(&home, &request).unwrap();
        let city_id = city["cityId"].as_str().unwrap();
        let next_revision = city["revision"].as_u64().unwrap() + 1;
        let mut document = crate::creator_cities::read_city(&home, city_id).unwrap();
        document["revision"] = json!(next_revision);
        let db = database(&home).unwrap();
        db.execute("UPDATE creator_cities SET revision=?2,document_json=?3 WHERE city_id=?1",
            params![city_id,next_revision,canonical_json(&document).unwrap()]).unwrap();
        drop(db);
        let commit_request = json!({"previewId":checked["previewId"],"operationId":"revision-commit"});
        assert_eq!(commit(&home, &commit_request).unwrap_err(), "city_install_revision_conflict");
        assert_eq!(preview(&home, &request).unwrap(), checked);
        assert_eq!(table_count(&home, "city_game_installations"), 0);
        let db = database(&home).unwrap();
        let status: String = db.query_row("SELECT status FROM city_game_install_previews WHERE preview_id=?1", [checked["previewId"].as_str().unwrap()], |row| row.get(0)).unwrap();
        assert_eq!(status, "pending");
        let commit_receipts: u64 = db.query_row("SELECT COUNT(*) FROM city_game_install_receipts WHERE operation_id='revision-commit'", [], |row| row.get(0)).unwrap();
        assert_eq!(commit_receipts, 0);
        drop(db);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn receipt_failure_rolls_back_installation_and_preview_status() {
        let home = std::env::temp_dir().join(format!("city-install-rollback-{}", now_ms()));
        let build_id = write_build(&home, "community.install-test", "1.0.0");
        let city = create_install_city(&home, "Install City", "city-create");
        let checked = preview(&home, &install_request(&build_id, &city, "rollback-preview")).unwrap();
        let db = database(&home).unwrap();
        db.execute_batch("CREATE TRIGGER reject_install_commit_receipt BEFORE INSERT ON city_game_install_receipts
            WHEN NEW.operation_id='rollback-commit' BEGIN SELECT RAISE(ABORT,'rejected'); END;").unwrap();
        drop(db);
        assert_eq!(commit(&home, &json!({"previewId":checked["previewId"],"operationId":"rollback-commit"})).unwrap_err(), "creator_store_unavailable");
        assert_eq!(table_count(&home, "city_game_installations"), 0);
        let db = database(&home).unwrap();
        let status: String = db.query_row("SELECT status FROM city_game_install_previews WHERE preview_id=?1", [checked["previewId"].as_str().unwrap()], |row| row.get(0)).unwrap();
        assert_eq!(status, "pending");
        drop(db);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn installation_list_preserves_status_revision_and_limit() {
        let home = std::env::temp_dir().join(format!("city-install-list-{}", now_ms()));
        let city = create_install_city(&home, "Install City", "city-create");
        let city_id = city["cityId"].as_str().unwrap();
        let revision = city["revision"].as_u64().unwrap();
        let db = database(&home).unwrap();
        for index in 0..105 {
            db.execute("INSERT INTO city_game_installations(installation_id,city_id,game_id,build_id,city_revision,status,installed_at_ms,updated_at_ms)
                VALUES (?1,?2,?3,?4,?5,'disabled',?6,?6)",
                params![format!("installation-{index}"),city_id,format!("community.game-{index}"),format!("build-{index}"),revision,index]).unwrap();
        }
        db.execute("UPDATE city_game_installations SET status='installed' WHERE game_id IN ('community.game-1','community.game-2')", []).unwrap();
        drop(db);
        let first = list(&home, &json!({"cityId":city_id,"limit":1})).unwrap();
        assert_eq!(first["installations"].as_array().unwrap().len(), 1);
        assert_eq!(first["installedCount"], 2);
        let bounded = list(&home, &json!({"limit":1000})).unwrap();
        assert_eq!(bounded["installations"].as_array().unwrap().len(), 100);
        let filtered = list(&home, &json!({"cityId":city_id,"gameId":"community.game-7"})).unwrap();
        assert_eq!(filtered["installations"].as_array().unwrap().len(), 1);
        assert_eq!(filtered["installations"][0]["cityRevision"], revision);
        assert_eq!(filtered["installations"][0]["status"], "disabled");
        assert_eq!(filtered["installedCount"], 0);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn unsupported_install_side_effects_fail_closed() {
        let home = std::env::temp_dir().join(format!("city-install-approval-{}", now_ms()));
        let build_id = write_build(&home, "community.install-test", "1.0.0");
        let city = create_install_city(&home, "Install City", "city-create");
        for (index, key) in ["runAfterInstall", "replaceCurrentView", "allowOfficialStoryWrites"].iter().enumerate() {
            let mut request = install_request(&build_id, &city, &format!("approval-preview-{index}"));
            request[*key] = json!(true);
            assert_eq!(preview(&home, &request).unwrap_err(), "preview_approval_required");
        }
        assert_eq!(table_count(&home, "city_game_install_previews"), 0);
        assert_eq!(table_count(&home, "city_game_install_receipts"), 0);
        assert_eq!(table_count(&home, "city_game_installations"), 0);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn schema_is_player_scoped_by_city_and_game() {
        let home = std::env::temp_dir().join(format!("city-install-schema-{}", now_ms()));
        let db = database(&home).unwrap();
        migrate(&db).unwrap();
        let columns: Vec<String> = db.prepare("PRAGMA table_info(city_game_installations)").unwrap()
            .query_map([], |row| row.get(1)).unwrap().collect::<Result<_,_>>().unwrap();
        assert!(columns.contains(&"city_id".to_string()));
        assert!(columns.contains(&"game_id".to_string()));
        assert!(columns.contains(&"build_id".to_string()));
        assert!(columns.contains(&"city_revision".to_string()));
        std::fs::remove_dir_all(home).ok();
    }
}
