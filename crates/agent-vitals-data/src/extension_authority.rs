//! Local extension audit state. No payload deserialization or network access.
//! Vendor metadata is an internal installer assertion, not a signature proof.
use std::collections::BTreeMap;
use rusqlite::{params, Connection};
use crate::authority::{begin_immediate, commit_advancing_revision};

pub(crate) const SCHEMA_V28_ADD: &str = r#"
CREATE TABLE IF NOT EXISTS extension_revisions (
  revision_id TEXT PRIMARY KEY,
  slot_type TEXT NOT NULL, slot_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  origin TEXT NOT NULL CHECK(origin IN ('local','vendor-catalog')),
  vendor_source TEXT, vendor_commit TEXT, index_sha256 TEXT,
  schema_version INTEGER NOT NULL CHECK(schema_version>0),
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json) AND json_type(capabilities_json)='object'),
  installed_at_ms INTEGER NOT NULL,
  UNIQUE(revision_id,slot_type,slot_id),
  CHECK((origin='local' AND vendor_source IS NULL AND vendor_commit IS NULL AND index_sha256 IS NULL)
    OR (origin='vendor-catalog' AND vendor_source IS NOT NULL AND length(vendor_source)>0 AND vendor_commit IS NOT NULL
      AND length(vendor_commit)=40 AND vendor_commit NOT GLOB '*[^0-9a-f]*'
      AND index_sha256 IS NOT NULL AND length(index_sha256)=64 AND index_sha256 NOT GLOB '*[^0-9a-f]*'))
);
CREATE TABLE IF NOT EXISTS extension_activations (
  generation INTEGER PRIMARY KEY CHECK(generation>=0),
  previous_generation INTEGER REFERENCES extension_activations(generation),
  action TEXT NOT NULL CHECK(action IN ('initial','activate','rollback','uninstall')),
  preview_sha256 TEXT NOT NULL CHECK(length(preview_sha256)=64 AND preview_sha256 NOT GLOB '*[^0-9a-f]*'),
  committed_at_ms INTEGER NOT NULL
);
INSERT OR IGNORE INTO extension_activations VALUES(0,NULL,'initial','0000000000000000000000000000000000000000000000000000000000000000',0);
CREATE TABLE IF NOT EXISTS extension_activation_slots (
  generation INTEGER NOT NULL REFERENCES extension_activations(generation),
  slot_type TEXT NOT NULL, slot_id TEXT NOT NULL, revision_id TEXT NOT NULL,
  PRIMARY KEY(generation,slot_type,slot_id),
  UNIQUE(generation,revision_id),
  FOREIGN KEY(revision_id,slot_type,slot_id) REFERENCES extension_revisions(revision_id,slot_type,slot_id)
);
CREATE TABLE IF NOT EXISTS extension_active (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  generation INTEGER NOT NULL REFERENCES extension_activations(generation)
);
INSERT OR IGNORE INTO extension_active VALUES(1,0);
CREATE TABLE IF NOT EXISTS extension_fact_provenance (
  fact_id TEXT NOT NULL REFERENCES usage_facts(fact_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL, revision_id TEXT NOT NULL,
  engine_version TEXT NOT NULL CHECK(length(engine_version)>0),
  PRIMARY KEY(fact_id,revision_id),
  FOREIGN KEY(generation,revision_id) REFERENCES extension_activation_slots(generation,revision_id)
);
CREATE TRIGGER IF NOT EXISTS extension_revision_no_update BEFORE UPDATE ON extension_revisions
BEGIN SELECT RAISE(ABORT,'extension revision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS extension_revision_no_delete BEFORE DELETE ON extension_revisions
BEGIN SELECT RAISE(ABORT,'extension revision history is retained'); END;
CREATE TRIGGER IF NOT EXISTS extension_activation_no_update BEFORE UPDATE ON extension_activations
BEGIN SELECT RAISE(ABORT,'extension activation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS extension_activation_no_delete BEFORE DELETE ON extension_activations
BEGIN SELECT RAISE(ABORT,'extension activation history is retained'); END;
CREATE TRIGGER IF NOT EXISTS extension_slot_no_update BEFORE UPDATE ON extension_activation_slots
BEGIN SELECT RAISE(ABORT,'extension activation map is immutable'); END;
CREATE TRIGGER IF NOT EXISTS extension_slot_no_delete BEFORE DELETE ON extension_activation_slots
BEGIN SELECT RAISE(ABORT,'extension activation map history is retained'); END;
"#;

#[derive(Debug)]
pub enum ExtensionError { Sql(rusqlite::Error), Invalid(&'static str), StaleGeneration { expected: i64, actual: i64 } }
impl From<rusqlite::Error> for ExtensionError {
    fn from(error: rusqlite::Error) -> Self { Self::Sql(error) }
}
impl std::fmt::Display for ExtensionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{self:?}") }
}
impl std::error::Error for ExtensionError {}

#[derive(Debug, Clone)]
pub enum RevisionOrigin {
    Local,
    /// Constructed by the trusted installer after checking the catalog/object.
    /// Never map a manifest's self-declared origin to this variant.
    VendorCatalog { source: String, commit: String, index_sha256: String },
}

#[derive(Debug, Clone)]
pub struct ExtensionRevision {
    pub revision_id: String,
    pub slot_type: String,
    pub slot_id: String,
    pub content_sha256: String,
    pub origin: RevisionOrigin,
    pub schema_version: i64,
    pub capabilities: serde_json::Value,
    pub installed_at_ms: i64,
}

#[derive(Debug, Clone, Copy)]
pub enum ActivationAction { Activate, Rollback, Uninstall }
impl ActivationAction {
    fn as_str(self) -> &'static str {
        match self { Self::Activate => "activate", Self::Rollback => "rollback", Self::Uninstall => "uninstall" }
    }
}

pub type SlotMap = BTreeMap<(String, String), String>;

fn hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn validate_revision(revision: &ExtensionRevision) -> Result<(), ExtensionError> {
    if revision.revision_id.is_empty() || revision.slot_type.is_empty() || revision.slot_id.is_empty()
        || !hex(&revision.content_sha256,64) || revision.schema_version < 1
        || !revision.capabilities.is_object() { return Err(ExtensionError::Invalid("invalid revision metadata")); }
    if let RevisionOrigin::VendorCatalog { source, commit, index_sha256 } = &revision.origin {
        if source.is_empty() || !hex(commit,40) || !hex(index_sha256,64) {
            return Err(ExtensionError::Invalid("invalid vendor identity"));
        }
    }
    Ok(())
}

/// Register immutable metadata inside an existing authority transaction.
/// Reusing an id is rejected; callers must allocate a distinct id for local and
/// catalog origins even when the content digest is identical.
pub fn register_revision_in_transaction(conn: &Connection, revision: &ExtensionRevision) -> Result<(), ExtensionError> {
    if conn.is_autocommit() { return Err(ExtensionError::Invalid("revision requires a write transaction")); }
    validate_revision(revision)?;
    let (origin, source, commit, index) = match &revision.origin {
        RevisionOrigin::Local => ("local",None,None,None),
        RevisionOrigin::VendorCatalog { source, commit, index_sha256 } => ("vendor-catalog",Some(source),Some(commit),Some(index_sha256)),
    };
    conn.execute("INSERT INTO extension_revisions VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![revision.revision_id,revision.slot_type,revision.slot_id,revision.content_sha256,
            origin,source,commit,index,revision.schema_version,revision.capabilities.to_string(),revision.installed_at_ms])?;
    Ok(())
}

pub fn current_generation(conn: &Connection) -> Result<i64, ExtensionError> {
    Ok(conn.query_row("SELECT generation FROM extension_active WHERE singleton=1",[],|row| row.get(0))?)
}

pub fn generation_slots(conn: &Connection, generation: i64) -> Result<SlotMap, ExtensionError> {
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM extension_activations WHERE generation=?1)",params![generation],|row| row.get(0))?;
    if !exists { return Err(ExtensionError::Invalid("unknown generation")); }
    let mut statement = conn.prepare("SELECT slot_type,slot_id,revision_id FROM extension_activation_slots WHERE generation=?1 ORDER BY slot_type,slot_id")?;
    let rows = statement.query_map(params![generation],|row| Ok(((row.get(0)?,row.get(1)?),row.get(2)?)))?;
    Ok(rows.collect::<Result<SlotMap,_>>()?)
}

/// One transaction commits revision registrations, the complete replacement
/// map, and CAS pointer. Object durability/preview verification belong to the
/// installer and are not claimed by this storage operation.
pub fn activate(conn: &Connection, expected: i64, revisions: &[ExtensionRevision], slots: &SlotMap,
    preview_sha256: &str, action: ActivationAction, now_ms: i64) -> Result<i64, ExtensionError> {
    if !hex(preview_sha256,64) { return Err(ExtensionError::Invalid("invalid preview hash")); }
    let mark = begin_immediate(conn)?;
    let result = (|| {
        let actual = current_generation(conn)?;
        if actual != expected { return Err(ExtensionError::StaleGeneration { expected, actual }); }
        let next = actual.checked_add(1).ok_or(ExtensionError::Invalid("generation exhausted"))?;
        for revision in revisions { register_revision_in_transaction(conn,revision)?; }
        conn.execute("INSERT INTO extension_activations VALUES(?1,?2,?3,?4,?5)",params![next,actual,action.as_str(),preview_sha256,now_ms])?;
        for ((slot_type,slot_id),revision) in slots {
            conn.execute("INSERT INTO extension_activation_slots VALUES(?1,?2,?3,?4)",params![next,slot_type,slot_id,revision])?;
        }
        let changed = conn.execute("UPDATE extension_active SET generation=?1 WHERE singleton=1 AND generation=?2",params![next,expected])?;
        if changed != 1 { return Err(ExtensionError::Invalid("active pointer CAS failed")); }
        Ok(next)
    })();
    match result {
        Ok(generation) => {
            if let Err(error) = commit_advancing_revision(conn,mark) { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
            Ok(generation)
        }
        Err(error) => { let _ = conn.execute_batch("ROLLBACK"); Err(error) }
    }
}

/// Must be called in the SAME transaction that writes the fact. FK binds the
/// immutable selected revision to the pinned generation; no payload is stored.
pub fn link_fact_in_transaction(conn: &Connection, fact_id: &str, generation: i64, revision_id: &str,
    engine_version: &str) -> Result<(), ExtensionError> {
    if conn.is_autocommit() { return Err(ExtensionError::Invalid("fact provenance requires a write transaction")); }
    if engine_version.is_empty() { return Err(ExtensionError::Invalid("empty engine version")); }
    conn.execute("INSERT INTO extension_fact_provenance VALUES(?1,?2,?3,?4)",params![fact_id,generation,revision_id,engine_version])?;
    Ok(())
}
