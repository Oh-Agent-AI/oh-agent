//! City-owned asset identity registry and bounded bookmark save, separate from analytical authority.
//! No title, excerpt, path, native id or reward is persisted here.
use std::{collections::BTreeMap, path::Path};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use super::session_ref::session_ref;

fn registry(home: &Path) -> Result<Connection, &'static str> {
    let dir = home.join("state/plugins/city-assets");
    std::fs::create_dir_all(&dir).map_err(|_| "asset_state_unavailable")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir,std::fs::Permissions::from_mode(0o700)).map_err(|_| "asset_state_unavailable")?;
    }
    let path = dir.join("registry.sqlite");
    let db = Connection::open(&path).map_err(|_| "asset_state_unavailable")?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_| "asset_state_unavailable")?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS identity_secret(id INTEGER PRIMARY KEY CHECK(id=1),secret BLOB NOT NULL);
        INSERT OR IGNORE INTO identity_secret VALUES(1,randomblob(32));
        CREATE TABLE IF NOT EXISTS assets(asset_ref TEXT PRIMARY KEY,key_hash TEXT UNIQUE,state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS save_refs(save_id TEXT NOT NULL,asset_ref TEXT NOT NULL,PRIMARY KEY(save_id,asset_ref));")
        .map_err(|_| "asset_state_unavailable")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o600)).map_err(|_| "asset_state_unavailable")?;
    }
    Ok(db)
}

pub(crate) struct Assets {
    pub by_session: BTreeMap<String,String>,
    pub states: BTreeMap<String,String>,
}

/// One set-based authority identity read and one set-based registry update per page.
pub(crate) fn publish(home: &Path, authority: &Connection, keys: &[String]) -> Result<Assets, &'static str> {
    let db = registry(home)?;
    let secret: Vec<u8> = db.query_row("SELECT secret FROM identity_secret WHERE id=1",[],|r| r.get(0)).map_err(|_| "asset_state_unavailable")?;
    let salt: [u8;32] = secret.try_into().map_err(|_| "asset_state_unavailable")?;
    let mut stmt = authority.prepare("SELECT session_key,harness,machine_namespace,native_session_id,deleted_at_ms FROM sessions")
        .map_err(|_| "data_unavailable")?;
    let rows = stmt.query_map([],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,
        r.get::<_,String>(3)?,r.get::<_,Option<i64>>(4)?))).map_err(|_| "data_unavailable")?;
    let mut active = Vec::new();
    let mut deleted = Vec::new();
    let mut hashes = BTreeMap::new();
    for row in rows {
        let (key,harness,machine,native,removed) = row.map_err(|_| "data_unavailable")?;
        let hash = session_ref(&salt,&json!([harness,machine,native]).to_string());
        if removed.is_some() { deleted.push(hash); } else { active.push(hash.clone()); hashes.insert(key,hash); }
    }
    let selected: Vec<&str> = keys.iter().filter_map(|k| hashes.get(k).map(String::as_str)).collect();
    db.execute_batch("BEGIN IMMEDIATE").map_err(|_| "asset_state_unavailable")?;
    db.execute("UPDATE assets SET state='source_deleted',key_hash=NULL WHERE key_hash IN (SELECT value FROM json_each(?1))",
        [json!(deleted).to_string()]).map_err(|_| "asset_state_unavailable")?;
    db.execute("UPDATE assets SET state=CASE WHEN key_hash IN (SELECT value FROM json_each(?1)) THEN 'present' ELSE 'orphaned' END
        WHERE key_hash IS NOT NULL",[json!(active).to_string()]).map_err(|_| "asset_state_unavailable")?;
    db.execute("INSERT OR IGNORE INTO assets(asset_ref,key_hash,state)
        SELECT 'ca_'||lower(hex(randomblob(16))),value,'present' FROM json_each(?1)",
        [json!(selected).to_string()]).map_err(|_| "asset_state_unavailable")?;
    db.execute_batch("COMMIT").map_err(|_| "asset_state_unavailable")?;
    let mut stmt = db.prepare("SELECT key_hash,asset_ref,state FROM assets").map_err(|_| "asset_state_unavailable")?;
    let rows = stmt.query_map([],|r| Ok((r.get::<_,Option<String>>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))
        .map_err(|_| "asset_state_unavailable")?;
    let mut by_hash = BTreeMap::new();
    let mut states = BTreeMap::new();
    for row in rows {
        let (hash,asset,state) = row.map_err(|_| "asset_state_unavailable")?;
        if let Some(hash)=hash { by_hash.insert(hash,asset.clone()); }
        states.insert(asset,state);
    }
    Ok(Assets { by_session: hashes.into_iter().filter_map(|(key,hash)| by_hash.get(&hash).map(|asset| (key,asset.clone()))).collect(), states })
}

/// Trusted host GameSave integration only. Not registered as a plugin data operation.
/// Until a save has registered references, resolve honestly returns save_not_registered.
pub fn retain_save_refs(home: &Path, save_id: &str, refs: &[String]) -> Result<(), &'static str> {
    if save_id.is_empty() || save_id.len()>100 || refs.len()>4000 { return Err("invalid_asset_request"); }
    let db = registry(home)?;
    let known: i64 = db.query_row("SELECT COUNT(*) FROM assets WHERE asset_ref IN (SELECT value FROM json_each(?1))",
        [json!(refs).to_string()],|r| r.get(0)).map_err(|_| "asset_state_unavailable")?;
    if known as usize != refs.iter().collect::<std::collections::BTreeSet<_>>().len() { return Err("asset_unavailable"); }
    db.execute_batch("BEGIN IMMEDIATE").map_err(|_| "asset_state_unavailable")?;
    db.execute("DELETE FROM save_refs WHERE save_id=?1",[save_id]).map_err(|_| "asset_state_unavailable")?;
    db.execute("INSERT INTO save_refs SELECT ?1,value FROM json_each(?2) GROUP BY value",
        params![save_id,json!(refs).to_string()]).map_err(|_| "asset_state_unavailable")?;
    db.execute_batch("COMMIT").map_err(|_| "asset_state_unavailable")?;
    Ok(())
}

/// Host-only bounded building bookmarks. Document and resolve grants commit together.
/// No analytical text, currency or inferred rewards enter this save.
pub fn game_links_state(home: &Path, method: &str, payload: &Value) -> Result<Value, &'static str> {
    let db=registry(home)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS game_links(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,document TEXT NOT NULL)")
        .map_err(|_|"asset_state_unavailable")?;
    if method=="plugin.state.read" {
        use rusqlite::OptionalExtension;
        let saved=db.query_row("SELECT revision,substr(document,1,16385) FROM game_links WHERE id=1",[],|r|Ok((r.get::<_,u64>(0)?,r.get::<_,String>(1)?)))
            .optional().map_err(|_|"asset_state_unavailable")?;
        return match saved {
            None=>Ok(json!({"revision":0,"value":null})),
            Some((revision,document))=>{
                if revision>9_007_199_254_740_991 || document.len()>16384 { return Err("asset_state_unavailable"); }
                let value=serde_json::from_str::<Value>(&document).map_err(|_|"asset_state_unavailable")?;
                let object=value.as_object().filter(|v|v.len()==2 && v.get("schemaVersion")==Some(&json!(1))).ok_or("asset_state_unavailable")?;
                let refs=object.get("assetRefs").and_then(Value::as_array).filter(|v|v.len()<=200).ok_or("asset_state_unavailable")?;
                if refs.iter().any(|v|!v.as_str().is_some_and(|s|s.len()==35 && s.starts_with("ca_") && s[3..].bytes().all(|c|c.is_ascii_hexdigit()))) { return Err("asset_state_unavailable"); }
                if refs.iter().filter_map(Value::as_str).collect::<std::collections::BTreeSet<_>>().len()!=refs.len() { return Err("asset_state_unavailable"); }
                Ok(json!({"revision":revision,"value":value}))
            },
        };
    }
    if method!="plugin.state.write" { return Err("method_unavailable"); }
    let value=payload["value"].as_object().ok_or("invalid_state_value")?;
    if value.len()!=2 || value.get("schemaVersion")!=Some(&json!(1)) { return Err("invalid_state_value"); }
    let refs=value.get("assetRefs").and_then(Value::as_array).filter(|v|v.len()<=200).ok_or("invalid_asset_request")?
        .iter().map(|v|v.as_str().filter(|s|s.len()==35 && s.starts_with("ca_") && s[3..].bytes().all(|c|c.is_ascii_hexdigit())).map(str::to_owned).ok_or("invalid_asset_request"))
        .collect::<Result<std::collections::BTreeSet<_>,_>>()?;
    let revision=payload["revision"].as_u64().filter(|v|*v<9_007_199_254_740_991).ok_or("revision_required")?;
    db.execute_batch("BEGIN IMMEDIATE").map_err(|_|"asset_state_unavailable")?;
    let current=db.query_row("SELECT COALESCE((SELECT revision FROM game_links WHERE id=1),0)",[],|r|r.get::<_,u64>(0)).map_err(|_|"asset_state_unavailable")?;
    if current!=revision { return Err("revision_conflict"); }
    let encoded=json!(refs).to_string();
    let known=db.query_row("SELECT COUNT(*) FROM assets WHERE asset_ref IN (SELECT value FROM json_each(?1))",[&encoded],|r|r.get::<_,usize>(0)).map_err(|_|"asset_state_unavailable")?;
    if known!=refs.len() { return Err("asset_unavailable"); }
    let document=json!({"schemaVersion":1,"assetRefs":refs}).to_string();
    db.execute("INSERT OR REPLACE INTO game_links VALUES(1,?1,?2)",params![revision+1,document]).map_err(|_|"asset_state_unavailable")?;
    db.execute("DELETE FROM save_refs WHERE save_id='city-primary'",[]).map_err(|_|"asset_state_unavailable")?;
    db.execute("INSERT INTO save_refs SELECT 'city-primary',value FROM json_each(?1)",[encoded]).map_err(|_|"asset_state_unavailable")?;
    db.execute_batch("COMMIT").map_err(|_|"asset_state_unavailable")?;
    Ok(json!({"revision":revision+1}))
}

pub(crate) fn resolve(home: &Path, authority: &Connection, save_id: &str, refs: &[String], from: i64, to: i64) -> Result<Value, &'static str> {
    if refs.len()>200 || refs.iter().any(|s| s.len()!=35 || !s.starts_with("ca_") || !s[3..].bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err("invalid_asset_request");
    }
    let assets = publish(home,authority,&[])?;
    let db = registry(home)?;
    let mut stmt = db.prepare("SELECT asset_ref FROM save_refs WHERE save_id=?1").map_err(|_| "asset_state_unavailable")?;
    let known = stmt.query_map([save_id],|r| r.get::<_,String>(0)).map_err(|_| "asset_state_unavailable")?
        .collect::<Result<std::collections::BTreeSet<_>,_>>().map_err(|_| "asset_state_unavailable")?;
    if known.is_empty() { return Ok(json!({"state":"unavailable","reason":"save_not_registered","assets":[]})); }
    if refs.iter().any(|r| !known.contains(r)) { return Err("asset_scope_denied"); }
    let mut stmt = authority.prepare("SELECT DISTINCT session_key FROM usage_facts WHERE deleted_at_ms IS NULL AND event_ts_ms>=?1 AND event_ts_ms<=?2")
        .map_err(|_| "data_unavailable")?;
    let visible = stmt.query_map(params![from,to],|r| r.get::<_,String>(0)).map_err(|_| "data_unavailable")?
        .collect::<Result<std::collections::BTreeSet<_>,_>>().map_err(|_| "data_unavailable")?;
    let visible_assets: std::collections::BTreeSet<&String> = assets.by_session.iter().filter(|(key,_)| visible.contains(*key)).map(|(_,asset)| asset).collect();
    Ok(json!({"state":"ready","assets":refs.iter().map(|r| json!({"asset_ref":r,"state":match assets.states.get(r).map(String::as_str) {
        Some("present") if !visible_assets.contains(r) => "outside_window", Some(state) => state, None => "unavailable",
    }})).collect::<Vec<_>>()}))
}
