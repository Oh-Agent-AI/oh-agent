//! City-owned asset identity registry and bounded bookmark save, separate from analytical authority.
//! No title, excerpt, path, native id or reward is persisted here.
use std::{collections::BTreeMap, path::Path};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use super::session_ref::session_ref;

const LEGACY_EXPORT_DATASETS: [&str; 5] = ["registry.save_refs", "registry.game_links", "building.overrides", "building.claims", "building.squad_mailbox"];
const LEGACY_EXPORT_PAGE_MAX: usize = 500;
const LEGACY_EXPORT_BYTES_MAX: usize = 1024 * 1024;
pub(crate) const LEGACY_EXPORT_PAGE_ROWS_BYTES_MAX: usize = 900 * 1024;
pub(crate) const LEGACY_EXPORT_TOTAL_BYTES_MAX: usize = 32 * 1024 * 1024;
pub(crate) const LEGACY_EXPORT_TOTAL_ROWS_MAX: usize = 100_000;
pub(crate) const LEGACY_EXPORT_RECORD_BYTES_MAX: usize = LEGACY_EXPORT_PAGE_ROWS_BYTES_MAX;

#[derive(Default)]
pub(crate) struct LegacyExportBudget { rows: usize, bytes: usize }

impl LegacyExportBudget {
    pub(crate) fn charge(&mut self, size: usize) -> Result<(), &'static str> {
        if size > LEGACY_EXPORT_RECORD_BYTES_MAX { return Err("legacy_export_record_too_large"); }
        self.rows = self.rows.checked_add(1).ok_or("legacy_export_limit")?;
        self.bytes = self.bytes.checked_add(size).ok_or("legacy_export_limit")?;
        if self.rows > LEGACY_EXPORT_TOTAL_ROWS_MAX || self.bytes > LEGACY_EXPORT_TOTAL_BYTES_MAX { return Err("legacy_export_limit"); }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyExportPage {
    pub schema: String,
    pub consistency: String,
    pub source_revision: String,
    pub records: Vec<Value>,
    pub next_cursor: Option<String>,
}

/// Read-only, resumable export of the old City asset/building stores.
/// The cursor pins a version vector of two independent SQLite read snapshots,
/// not one cross-file atomic instant. Each connection holds its own SQLite
/// transaction; the export must therefore validate referential closure before
/// import. Every continuation recomputes both fingerprints and rejects any
/// change, so pages from different source versions are never silently mixed.
/// The bounded full-store rehash is intentionally migration-only: at most
/// 100,000 rows / 32 MiB total and 900 KiB per row/page payload, with each
/// enveloped response <= 1 MiB. The legacy game_links document is bounded at
/// 16 KiB by its existing writer, so any larger source row is corruption and
/// fails closed rather than being silently truncated.
pub fn legacy_export_page(home: &Path, cursor: Option<&str>, limit: usize) -> Result<LegacyExportPage, &'static str> {
    legacy_export_page_for_dataset(home, None, cursor, limit)
}

pub fn legacy_export_dataset_page(home: &Path, dataset: &str, cursor: Option<&str>, limit: usize) -> Result<LegacyExportPage, &'static str> {
    if !LEGACY_EXPORT_DATASETS.contains(&dataset) { return Err("legacy_export_invalid_dataset"); }
    legacy_export_page_for_dataset(home, Some(dataset), cursor, limit)
}

/// Resolve old City asset aliases to generic stable session refs without
/// exposing the registry key hash, native session identifiers, or authority
/// session keys. This is a migration-only bridge for old local bookmarks and
/// building records; it does not produce a City presentation projection.
pub fn legacy_asset_crosswalk(
    home: &Path,
    plugin_id: &str,
    asset_refs: &[String],
    expected_source_revision: &str,
    expected_data_revision: u64,
) -> Result<Value, &'static str> {
    use agent_vitals_data::authority::{AuthorityDb, default_authority_path};
    use super::object_store::ObjectStore;

    if asset_refs.is_empty() || asset_refs.len() > 4_000
        || asset_refs.iter().any(|reference| reference.len() != 35
            || !reference.starts_with("ca_")
            || !reference[3..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        || asset_refs.iter().collect::<std::collections::BTreeSet<_>>().len() != asset_refs.len() {
        return Err("invalid_asset_crosswalk_request");
    }

    let authority = AuthorityDb::open_readonly(&default_authority_path(home)).map_err(|_| "data_unavailable")?;
    let data_revision = authority.revision().map_err(|_| "data_unavailable")?;
    if data_revision != expected_data_revision { return Err("revision_changed"); }

    let source_snapshot = legacy_export_page(home, None, 1)?;
    if source_snapshot.source_revision != expected_source_revision { return Err("legacy_export_changed"); }
    let Some(mut registry) = open_registry_export(home)? else {
        let source_after = legacy_export_page(home, None, 1)?;
        let revision_after = authority.revision().map_err(|_| "data_unavailable")?;
        if source_after.source_revision != source_snapshot.source_revision || revision_after != data_revision {
            return Err("revision_changed");
        }
        return Ok(json!({"schema":"city-asset-crosswalk:v1","dataRevision":data_revision,
            "sourceRevision":source_snapshot.source_revision,"pairs":[],"unresolved":asset_refs}));
    };
    let tx = registry.transaction_with_behavior(TransactionBehavior::Deferred).map_err(|_| "legacy_export_unavailable")?;
    let city_salt: Vec<u8> = tx.query_row("SELECT secret FROM identity_secret WHERE id=1", [], |row| row.get(0))
        .map_err(|_| "legacy_export_unavailable")?;
    let city_salt: [u8; 32] = city_salt.try_into().map_err(|_| "legacy_export_unavailable")?;
    let requested = json!(asset_refs).to_string();
    let mut asset_hashes = BTreeMap::<String, String>::new();
    let mut stmt = tx.prepare("SELECT asset_ref,key_hash FROM assets WHERE asset_ref IN (SELECT value FROM json_each(?1)) AND state='present' AND key_hash IS NOT NULL")
        .map_err(|_| "legacy_export_unavailable")?;
    let rows = stmt.query_map([requested], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|_| "legacy_export_unavailable")?;
    for row in rows {
        let (asset_ref, key_hash) = row.map_err(|_| "legacy_export_unavailable")?;
        if asset_hashes.insert(key_hash, asset_ref).is_some() { return Err("legacy_export_invalid_identity"); }
    }
    drop(stmt);

    let mut key_by_asset = BTreeMap::<String, String>::new();
    if !asset_hashes.is_empty() {
        let mut sessions = authority.conn().prepare("SELECT session_key,harness,machine_namespace,native_session_id FROM sessions WHERE deleted_at_ms IS NULL")
            .map_err(|_| "data_unavailable")?;
        let rows = sessions.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
            row.get::<_, String>(2)?, row.get::<_, String>(3)?))).map_err(|_| "data_unavailable")?;
        for row in rows {
            let (session_key, harness, machine, native) = row.map_err(|_| "data_unavailable")?;
            let identity_hash = session_ref(&city_salt, &json!([harness, machine, native]).to_string());
            if let Some(asset_ref) = asset_hashes.get(&identity_hash) {
                if key_by_asset.insert(asset_ref.clone(), session_key).is_some() { return Err("legacy_export_invalid_identity"); }
            }
        }
    }

    let mut store = ObjectStore::open(home, plugin_id).map_err(|_| "stable_ref_unavailable")?;
    let mut pairs = Vec::with_capacity(key_by_asset.len());
    let entries = key_by_asset.into_iter().collect::<Vec<_>>();
    for chunk in entries.chunks(500) {
        let keys = chunk.iter().map(|(_, key)| key.clone()).collect::<Vec<_>>();
        let refs = store.stable_source_refs("harness-sessions:v4", &keys, 500).map_err(|_| "stable_ref_unavailable")?;
        for ((asset_ref, _), stable_ref) in chunk.iter().zip(refs) {
            pairs.push(json!({"asset_ref":asset_ref,"stable_ref":stable_ref}));
        }
    }
    let resolved = pairs.iter().filter_map(|pair| pair["asset_ref"].as_str()).collect::<std::collections::BTreeSet<_>>();
    let unresolved = asset_refs.iter().filter(|reference| !resolved.contains(reference.as_str())).cloned().collect::<Vec<_>>();
    tx.commit().map_err(|_| "legacy_export_unavailable")?;

    let source_after = legacy_export_page(home, None, 1)?;
    let revision_after = authority.revision().map_err(|_| "data_unavailable")?;
    if source_after.source_revision != source_snapshot.source_revision || revision_after != data_revision {
        return Err("revision_changed");
    }
    Ok(json!({"schema":"city-asset-crosswalk:v1","dataRevision":data_revision,
        "sourceRevision":source_snapshot.source_revision,"pairs":pairs,"unresolved":unresolved}))
}

fn legacy_export_page_for_dataset(home: &Path, only_dataset: Option<&str>, cursor: Option<&str>, limit: usize) -> Result<LegacyExportPage, &'static str> {
    if !(1..=LEGACY_EXPORT_PAGE_MAX).contains(&limit) { return Err("legacy_export_invalid_page"); }
    let parsed = cursor.map(parse_legacy_cursor).transpose()?;
    let mut registry_conn = open_registry_export(home)?;
    let mut building_conn = open_legacy_building_store(home)?;
    let registry_tx = registry_conn.as_mut().map(|db| db.transaction_with_behavior(TransactionBehavior::Deferred).map_err(|_| "legacy_export_unavailable")).transpose()?;
    let building_tx = building_conn.as_mut().map(|db| db.transaction_with_behavior(TransactionBehavior::Deferred).map_err(|_| "legacy_export_unavailable")).transpose()?;
    let mut budget = LegacyExportBudget::default();
    let squad_mailbox = read_squad_mailbox_snapshot(home)?;
    let registry_hash = registry_fingerprint(registry_tx.as_ref(), &mut budget)?;
    let building_hash = building_fingerprint(building_tx.as_ref(), &squad_mailbox, &mut budget)?;
    let revision = format!("{registry_hash}.{building_hash}");
    let requested_index = only_dataset.map(|dataset| LEGACY_EXPORT_DATASETS.iter().position(|entry| *entry == dataset).expect("validated dataset"));
    let (mut dataset_index, mut offset) = match parsed {
        Some((expected, index, offset)) => {
            if expected != revision { return Err("legacy_export_changed"); }
            if requested_index.is_some_and(|requested| requested != index) { return Err("legacy_export_invalid_cursor"); }
            (index, offset)
        }
        None => (requested_index.unwrap_or(0), 0),
    };
    if dataset_index >= LEGACY_EXPORT_DATASETS.len() { return Err("legacy_export_invalid_cursor"); }

    let mut records = Vec::new();
    let mut record_positions = Vec::new();
    let mut next_cursor = None;
    while dataset_index < LEGACY_EXPORT_DATASETS.len() && requested_index.map_or(true, |requested| dataset_index == requested) {
        let remaining = limit.saturating_sub(records.len());
        if remaining == 0 { break; }
        let dataset = LEGACY_EXPORT_DATASETS[dataset_index];
        let (rows, has_more) = if dataset.starts_with("registry.") {
            match registry_tx.as_ref() {
                Some(tx) => registry_export_page(tx, dataset, offset, remaining)?,
                None => (Vec::new(), false),
            }
        } else if dataset == "building.squad_mailbox" {
            squad_mailbox_export_page(&squad_mailbox, offset)?
        } else {
            match building_tx.as_ref() {
                Some(tx) => legacy_building_export_page(tx, &dataset["building.".len()..], offset, remaining)?,
                None => (Vec::new(), false),
            }
        };
        if !rows.is_empty() {
            let count = rows.len();
            for (index, values) in rows.into_iter().enumerate() {
                records.push(export_record(dataset, values));
                record_positions.push((dataset_index, offset + index));
            }
            if has_more {
                next_cursor = Some(format_legacy_cursor(&revision, dataset_index, offset + count));
                break;
            }
        }
        dataset_index += 1;
        offset = 0;
        if records.len() == limit {
            if requested_index.is_none() && dataset_index < LEGACY_EXPORT_DATASETS.len() {
                next_cursor = Some(format_legacy_cursor(&revision, dataset_index, 0));
            }
            break;
        }
    }
    while serde_json::to_vec(&json!({"schema":"city-legacy-export:v1","consistency":"independent-sqlite-version-vector",
        "sourceRevision":&revision,"records":&records,"nextCursor":&next_cursor})).map_err(|_| "legacy_export_unavailable")?.len() > LEGACY_EXPORT_BYTES_MAX {
        if records.len() <= 1 { return Err("legacy_export_record_too_large"); }
        records.pop();
        let (index, offset) = record_positions.pop().ok_or("legacy_export_unavailable")?;
        next_cursor = Some(format_legacy_cursor(&revision, index, offset));
    }
    let output = LegacyExportPage { schema: "city-legacy-export:v1".into(), consistency: "independent-sqlite-version-vector".into(),
        source_revision: revision, records, next_cursor };
    if serde_json::to_vec(&output).map_err(|_| "legacy_export_unavailable")?.len() > LEGACY_EXPORT_BYTES_MAX {
        return Err("legacy_export_page_too_large");
    }
    if let Some(tx) = registry_tx { tx.commit().map_err(|_| "legacy_export_unavailable")?; }
    if let Some(tx) = building_tx { tx.commit().map_err(|_| "legacy_export_unavailable")?; }
    Ok(output)
}

fn open_registry_export(home: &Path) -> Result<Option<Connection>, &'static str> {
    let path = home.join("state/plugins/city-assets/registry.sqlite");
    if !path.exists() { return Ok(None); }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| "legacy_export_unavailable")?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_| "legacy_export_unavailable")?;
    Ok(Some(db))
}

fn registry_fingerprint(tx: Option<&Transaction<'_>>, budget: &mut LegacyExportBudget) -> Result<String, &'static str> {
    let mut digest = Sha256::new();
    let Some(tx) = tx else { digest.update(b"registry:absent"); return Ok(format!("{:x}", digest.finalize())); };
    fingerprint_rows(tx, &mut digest, budget, "registry.assets", "SELECT asset_ref, key_hash, state FROM assets ORDER BY asset_ref",
        |row| Ok(json!([row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?])))?;
    fingerprint_rows(tx, &mut digest, budget, "registry.save_refs", "SELECT save_id, asset_ref FROM save_refs ORDER BY save_id, asset_ref",
        |row| Ok(json!([row.get::<_, String>(0)?, row.get::<_, String>(1)?])))?;
    if table_exists(tx, "game_links")? {
        fingerprint_rows(tx, &mut digest, budget, "registry.game_links", "SELECT id, revision, document FROM game_links ORDER BY id",
            |row| Ok(json!([row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?])))?;
    } else { digest.update(b"registry.game_links:absent"); }
    Ok(format!("{:x}", digest.finalize()))
}

fn building_fingerprint(tx: Option<&Transaction<'_>>, squad_mailbox: &Option<String>, budget: &mut LegacyExportBudget) -> Result<String, &'static str> {
    let mut digest = Sha256::new();
    if let Some(tx) = tx {
        fingerprint_legacy_building_store(tx, &mut digest, budget)?;
    } else {
        digest.update(b"building:absent");
    }
    if let Some(mailbox) = squad_mailbox {
        let bytes = mailbox.as_bytes();
        if bytes.len() > 64 * 1024 { return Err("legacy_export_record_too_large"); }
        budget.charge(bytes.len())?;
        digest.update(b"building.squad_mailbox");
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    } else {
        digest.update(b"building.squad_mailbox:absent");
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn read_squad_mailbox_snapshot(home: &Path) -> Result<Option<String>, &'static str> {
    let path = home.join("state/plugins/city-buildings/squad.json");
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("legacy_export_unavailable"),
    };
    if bytes.len() > 64 * 1024 { return Err("legacy_export_record_too_large"); }
    String::from_utf8(bytes).map(Some).map_err(|_| "legacy_export_unavailable")
}

/// Read-only compatibility source used solely by the bounded migration export.
/// It never creates the old store or runs its schema migrations.
fn open_legacy_building_store(home: &Path) -> Result<Option<Connection>, &'static str> {
    let path = home.join("state/plugins/city-buildings/overrides.sqlite");
    if !path.exists() { return Ok(None); }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| "legacy_export_unavailable")?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_| "legacy_export_unavailable")?;
    Ok(Some(db))
}

fn fingerprint_legacy_building_store(tx: &Transaction<'_>, digest: &mut Sha256,
    budget: &mut LegacyExportBudget) -> Result<(), &'static str> {
    fingerprint_rows(tx, digest, budget, "building.overrides",
        "SELECT asset_ref, revision, kit_version, model_json, updated_at_ms FROM overrides ORDER BY asset_ref",
        |row| Ok(json!([row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, i64>(4)?])))?;
    fingerprint_rows(tx, digest, budget, "building.claims",
        "SELECT session_id, asset_ref, agent_id, agent_name, expires_at, updated_at FROM claims ORDER BY session_id, asset_ref",
        |row| Ok(json!([row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?])))?;
    Ok(())
}

fn legacy_building_export_page(tx: &Transaction<'_>, dataset: &str, offset: usize, limit: usize) -> Result<(Vec<Value>, bool), &'static str> {
    match dataset {
        "overrides" => page_legacy_building_rows(tx, "SELECT asset_ref, revision, kit_version, model_json, updated_at_ms FROM overrides ORDER BY asset_ref LIMIT ?1 OFFSET ?2", offset, limit,
            |row| Ok(json!([row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, i64>(4)?]))) ,
        "claims" => page_legacy_building_rows(tx, "SELECT session_id, asset_ref, agent_id, agent_name, expires_at, updated_at FROM claims ORDER BY session_id, asset_ref LIMIT ?1 OFFSET ?2", offset, limit,
            |row| Ok(json!([row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?]))) ,
        _ => Err("legacy_export_invalid_cursor"),
    }
}

fn page_legacy_building_rows<F>(tx: &Transaction<'_>, sql: &str, offset: usize, limit: usize, map: F) -> Result<(Vec<Value>, bool), &'static str>
where F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut stmt = tx.prepare(sql).map_err(|_| "legacy_export_unavailable")?;
    let rows = stmt.query_map(params![(limit + 1) as i64, offset as i64], map).map_err(|_| "legacy_export_unavailable")?;
    let mut values = Vec::new();
    let mut bytes_used = 0usize;
    let mut has_more = false;
    for row in rows {
        let value = row.map_err(|_| "legacy_export_unavailable")?;
        let bytes = serde_json::to_vec(&value).map_err(|_| "legacy_export_unavailable")?.len();
        if bytes > LEGACY_EXPORT_RECORD_BYTES_MAX { return Err("legacy_export_record_too_large"); }
        if values.len() == limit || bytes_used.saturating_add(bytes) > LEGACY_EXPORT_PAGE_ROWS_BYTES_MAX {
            has_more = true;
            break;
        }
        bytes_used += bytes;
        values.push(value);
    }
    Ok((values, has_more))
}

fn squad_mailbox_export_page(squad_mailbox: &Option<String>, offset: usize) -> Result<(Vec<Value>, bool), &'static str> {
    if offset > 1 { return Err("legacy_export_invalid_cursor"); }
    let Some(mailbox) = squad_mailbox else { return Ok((Vec::new(), false)); };
    if offset == 1 { return Ok((Vec::new(), false)); }
    let values = vec![json!([mailbox])];
    Ok((values, false))
}

fn fingerprint_rows<F>(tx: &Transaction<'_>, digest: &mut Sha256, budget: &mut LegacyExportBudget, source: &str, sql: &str, mut map: F) -> Result<(), &'static str>
where F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    digest.update(source.as_bytes()); digest.update([0]);
    let mut stmt = tx.prepare(sql).map_err(|_| "legacy_export_unavailable")?;
    let rows = stmt.query_map([], |row| map(row)).map_err(|_| "legacy_export_unavailable")?;
    for row in rows {
        let bytes = serde_json::to_vec(&row.map_err(|_| "legacy_export_unavailable")?).map_err(|_| "legacy_export_unavailable")?;
        budget.charge(bytes.len())?;
        digest.update((bytes.len() as u64).to_be_bytes()); digest.update(bytes);
    }
    digest.update([0xff]);
    Ok(())
}

fn table_exists(tx: &Transaction<'_>, name: &str) -> Result<bool, &'static str> {
    tx.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1", [name], |_| Ok(()))
        .optional().map(|value| value.is_some()).map_err(|_| "legacy_export_unavailable")
}

fn registry_export_page(tx: &Transaction<'_>, dataset: &str, offset: usize, limit: usize) -> Result<(Vec<Value>, bool), &'static str> {
    match dataset {
        "registry.save_refs" => page_registry_rows(tx, "SELECT save_id, asset_ref FROM save_refs ORDER BY save_id, asset_ref LIMIT ?1 OFFSET ?2", offset, limit,
            |row| Ok(json!([row.get::<_, String>(0)?, row.get::<_, String>(1)?]))) ,
        "registry.game_links" => {
            if table_exists(tx, "game_links")? {
                page_registry_rows(tx, "SELECT id, revision, document FROM game_links ORDER BY id LIMIT ?1 OFFSET ?2", offset, limit,
                    |row| Ok(json!([row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?])))
            } else { Ok((Vec::new(), false)) }
        }
        _ => Err("legacy_export_invalid_cursor"),
    }
}

fn page_registry_rows<F>(tx: &Transaction<'_>, sql: &str, offset: usize, limit: usize, map: F) -> Result<(Vec<Value>, bool), &'static str>
where F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut stmt = tx.prepare(sql).map_err(|_| "legacy_export_unavailable")?;
    let rows = stmt.query_map(params![(limit + 1) as i64, offset as i64], map).map_err(|_| "legacy_export_unavailable")?;
    let mut values = Vec::new();
    let mut bytes_used = 0usize;
    let mut has_more = false;
    for row in rows {
        let value = row.map_err(|_| "legacy_export_unavailable")?;
        let bytes = serde_json::to_vec(&value).map_err(|_| "legacy_export_unavailable")?.len();
        if bytes > LEGACY_EXPORT_RECORD_BYTES_MAX { return Err("legacy_export_record_too_large"); }
        if values.len() == limit || bytes_used.saturating_add(bytes) > LEGACY_EXPORT_PAGE_ROWS_BYTES_MAX {
            has_more = true;
            break;
        }
        bytes_used += bytes;
        values.push(value);
    }
    Ok((values, has_more))
}

fn export_record(source: &str, values: Value) -> Value {
    let columns: &[&str] = match source {
        "registry.save_refs" => &["save_id", "asset_ref"],
        "registry.game_links" => &["id", "revision", "document"],
        "building.overrides" => &["asset_ref", "revision", "kit_version", "model_json", "updated_at_ms"],
        "building.claims" => &["session_id", "asset_ref", "agent_id", "agent_name", "expires_at", "updated_at"],
        "building.squad_mailbox" => &["document"],
        _ => &[],
    };
    json!({"source": source, "columns": columns, "values": values})
}

fn format_legacy_cursor(revision: &str, dataset: usize, offset: usize) -> String {
    format!("v1:{revision}:{dataset}:{offset}")
}

fn parse_legacy_cursor(cursor: &str) -> Result<(String, usize, usize), &'static str> {
    if cursor.len() > 180 { return Err("legacy_export_invalid_cursor"); }
    let parts = cursor.split(':').collect::<Vec<_>>();
    let hashes = parts.get(1).ok_or("legacy_export_invalid_cursor")?.split('.').collect::<Vec<_>>();
    if parts.len() != 4 || parts[0] != "v1" || hashes.len() != 2 || hashes.iter().any(|hash| hash.len() != 64
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())) {
        return Err("legacy_export_invalid_cursor");
    }
    let dataset = parts[2].parse::<usize>().map_err(|_| "legacy_export_invalid_cursor")?;
    let offset = parts[3].parse::<usize>().map_err(|_| "legacy_export_invalid_cursor")?;
    if offset > 9_007_199_254_740_991 { return Err("legacy_export_invalid_cursor"); }
    Ok((parts[1].to_owned(), dataset, offset))
}

#[cfg(test)]
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

#[cfg(test)]
pub(crate) struct Assets {
    pub by_session: BTreeMap<String,String>,
}

/// One set-based authority identity read and one set-based registry update per page.
#[cfg(test)]
pub(crate) fn publish(home: &Path, authority: &Connection, keys: &[String]) -> Result<Assets, &'static str> {
    let db = registry(home)?;
    let secret: Vec<u8> = db.query_row("SELECT secret FROM identity_secret WHERE id=1",[],|r| r.get(0)).map_err(|_| "asset_state_unavailable")?;
    let salt: [u8;32] = secret.try_into().map_err(|_| "asset_state_unavailable")?;
    if keys.len() > 500 || keys.iter().collect::<std::collections::BTreeSet<_>>().len() != keys.len() {
        return Err("invalid_page_size");
    }
    let encoded_keys = json!(keys).to_string();
    let mut stmt = authority.prepare("SELECT session_key,harness,machine_namespace,native_session_id,deleted_at_ms FROM sessions
        WHERE session_key IN (SELECT value FROM json_each(?1))")
        .map_err(|_| "data_unavailable")?;
    let rows = stmt.query_map([encoded_keys],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,
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
    db.execute("UPDATE assets SET state='present' WHERE key_hash IN (SELECT value FROM json_each(?1))",
        [json!(active).to_string()]).map_err(|_| "asset_state_unavailable")?;
    db.execute("INSERT OR IGNORE INTO assets(asset_ref,key_hash,state)
        SELECT 'ca_'||lower(hex(randomblob(16))),value,'present' FROM json_each(?1)",
        [json!(selected).to_string()]).map_err(|_| "asset_state_unavailable")?;
    db.execute_batch("COMMIT").map_err(|_| "asset_state_unavailable")?;
    let mut stmt = db.prepare("SELECT key_hash,asset_ref FROM assets WHERE key_hash IN (SELECT value FROM json_each(?1))")
        .map_err(|_| "asset_state_unavailable")?;
    let rows = stmt.query_map([json!(active).to_string()],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))
        .map_err(|_| "asset_state_unavailable")?;
    let mut by_hash = BTreeMap::new();
    for row in rows {
        let (hash,asset) = row.map_err(|_| "asset_state_unavailable")?;
        by_hash.insert(hash,asset);
    }
    Ok(Assets { by_session: hashes.into_iter().filter_map(|(key,hash)| by_hash.get(&hash).map(|asset| (key,asset.clone()))).collect() })
}

#[cfg(test)]
mod legacy_export_tests {
    use super::*;

    fn home() -> std::path::PathBuf {
        let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("city-legacy-export-{id}"))
    }

    #[test]
    fn crosswalk_resolves_legacy_identity_without_exposing_source_keys() {
        use agent_vitals_data::authority::{AuthorityDb, default_authority_path};
        let home = home();
        let authority = AuthorityDb::open(&default_authority_path(&home), 1_700_000_000_000).unwrap();
        authority.conn().execute("INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms)
            VALUES('private-key','codex','private-native','private-machine',1)", []).unwrap();
        let published = publish(&home, authority.conn(), &["private-key".into()]).unwrap();
        let alias = published.by_session["private-key"].clone();
        let missing = format!("ca_{}", "f".repeat(32));
        let source_revision = legacy_export_page(&home, None, 1).unwrap().source_revision;
        let revision = authority.revision().unwrap();
        let result = legacy_asset_crosswalk(&home, "city", &[alias.clone(), missing.clone()], &source_revision, revision).unwrap();
        assert_eq!(result["pairs"][0]["asset_ref"], alias);
        assert_eq!(result["unresolved"], json!([missing]));
        let mut store = super::super::object_store::ObjectStore::open(&home, "city").unwrap();
        let expected = store.stable_source_refs("harness-sessions:v4", &["private-key".into()], 1).unwrap();
        assert_eq!(result["pairs"][0]["stable_ref"], expected[0]);
        let encoded = result.to_string();
        for secret in ["private-key", "private-native", "private-machine"] { assert!(!encoded.contains(secret)); }
        assert_eq!(legacy_asset_crosswalk(&home, "city", &[alias], &source_revision, revision + 1), Err("revision_changed"));
        drop(store);
        drop(authority);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn export_pages_preserve_source_rows_and_pin_both_legacy_databases() {
        let home = home();
        let registry_db = registry(&home).unwrap();
        registry_db.execute("INSERT INTO assets(asset_ref,key_hash,state) VALUES('ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','hash-a','present')", []).unwrap();
        registry_db.execute("INSERT INTO save_refs(save_id,asset_ref) VALUES('city-primary','ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')", []).unwrap();
        registry_db.execute("CREATE TABLE game_links(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,document TEXT NOT NULL)", []).unwrap();
        registry_db.execute("INSERT INTO game_links VALUES(1,3,'{\"schemaVersion\":1,\"assetRefs\":[]}')", []).unwrap();

        let building = super::super::city_building::open_store(&home).unwrap();
        building.execute("INSERT INTO overrides(asset_ref,revision,kit_version,model_json,updated_at_ms) VALUES('ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',4,'kit/v1','{\"opaque\":true}',100)", []).unwrap();
        building.execute("INSERT INTO claims(session_id,asset_ref,agent_id,agent_name,expires_at,updated_at) VALUES('session-a','ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','agent-a','Agent A',200,100)", []).unwrap();
        drop(building);
        drop(registry_db);

        let first = legacy_export_page(&home, None, 1).unwrap();
        assert_eq!(first.records.len(), 1);
        assert_eq!(first.records[0]["source"], "registry.save_refs");
        assert_eq!(first.consistency, "independent-sqlite-version-vector");
        let revision = first.source_revision.clone();
        let mut cursor = first.next_cursor.clone();
        let mut exported = first.records.clone();
        let mut sources = vec![first.records[0]["source"].as_str().unwrap().to_owned()];
        while let Some(next) = cursor {
            let page = legacy_export_page(&home, Some(&next), 1).unwrap();
            assert_eq!(page.source_revision, revision);
            exported.extend(page.records.clone());
            sources.extend(page.records.iter().filter_map(|row| row["source"].as_str().map(str::to_owned)));
            cursor = page.next_cursor;
        }
        assert_eq!(sources, LEGACY_EXPORT_DATASETS[..4].iter().map(|source| (*source).to_owned()).collect::<Vec<_>>());
        assert!(exported.iter().all(|row| row["source"] != "registry.assets"));
        assert_eq!(exported.iter().find(|row| row["source"] == "registry.save_refs").unwrap()["values"],
            json!(["city-primary", "ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]));
        assert_eq!(exported.iter().find(|row| row["source"] == "registry.game_links").unwrap()["values"],
            json!([1, 3, "{\"schemaVersion\":1,\"assetRefs\":[]}"]));
        assert_eq!(exported.iter().find(|row| row["source"] == "building.overrides").unwrap()["values"],
            json!(["ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 4, "kit/v1", "{\"opaque\":true}", 100]));
        assert_eq!(exported.iter().find(|row| row["source"] == "building.claims").unwrap()["values"],
            json!(["session-a", "ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "agent-a", "Agent A", 200, 100]));

        let first = legacy_export_page(&home, None, 1).unwrap();
        let cursor = first.next_cursor.unwrap();
        let db = registry(&home).unwrap();
        db.execute("DELETE FROM save_refs WHERE save_id='city-primary'", []).unwrap();
        drop(db);
        assert_eq!(legacy_export_page(&home, Some(&cursor), 1), Err("legacy_export_changed"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn export_is_read_only_when_stores_are_absent_and_rejects_bad_cursors() {
        let home = home();
        let version = format!("{}.{}", "a".repeat(64), "b".repeat(64));
        let cursor = format_legacy_cursor(&version, 3, 17);
        assert_eq!(parse_legacy_cursor(&cursor), Ok((version, 3, 17)));
        let page = legacy_export_page(&home, None, 10).unwrap();
        assert!(page.records.is_empty());
        assert!(page.next_cursor.is_none());
        assert!(!home.exists());
        assert_eq!(legacy_export_page(&home, Some("bad"), 10), Err("legacy_export_invalid_cursor"));
        assert_eq!(legacy_export_page(&home, None, 0), Err("legacy_export_invalid_page"));
    }

    #[test]
    fn export_caps_page_memory_and_resumes_at_the_first_unreturned_row() {
        let home = home();
        let db = registry(&home).unwrap();
        let save_id = "x".repeat(300_000);
        for index in 0..5 {
            db.execute("INSERT INTO save_refs(save_id,asset_ref) VALUES(?1,?2)",
                params![save_id, format!("ca_{index:032x}")]).unwrap();
        }
        drop(db);
        let first = legacy_export_page(&home, None, 10).unwrap();
        assert_eq!(first.records.len(), 3);
        let cursor = first.next_cursor.unwrap();
        let second = legacy_export_page(&home, Some(&cursor), 10).unwrap();
        assert_eq!(second.records.len(), 2);
        assert!(second.next_cursor.is_none());
        let _ = std::fs::remove_dir_all(home);
    }
}
