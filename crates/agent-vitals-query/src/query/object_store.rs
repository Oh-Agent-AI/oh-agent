//! Descriptor-neutral storage primitives for trusted plugin-owned objects.
//!
//! The caller must authenticate the active plugin instance and select a grant
//! from its verified descriptor before invoking this module. This module only
//! enforces that grant's type/version/size/event bounds and storage isolation;
//! it does not interpret object or event body fields.

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

const MAX_OBJECT_BODY_BYTES: usize = 1024 * 1024;
const MAX_EVENT_BODY_BYTES: usize = 64 * 1024;
const MAX_OBJECTS_PER_PLUGIN: usize = 100_000;
const MAX_TOTAL_STORE_BYTES: usize = 512 * 1024 * 1024;
const MAX_IDEMPOTENCY_RECORDS: usize = 200_000;
const MAX_EVENTS_PER_COMMIT: usize = 64;
const MAX_EVENTS_PER_OBJECT: usize = 100_000;
const MAX_PAGE_SIZE: usize = 500;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 128;
const MAX_SCOPES_PER_PLUGIN: usize = 100_000;
const MAX_SCOPE_MEMBERS: usize = 4_000;
const MAX_STABLE_REFS_PER_DATASET: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    InvalidGrant,
    InvalidPluginId,
    InvalidObjectType,
    InvalidSchemaVersion,
    InvalidBody,
    InvalidHandle,
    InvalidAlias,
    AliasDenied,
    AliasConflict,
    StableRefUnavailable,
    InvalidStableRefRequest,
    InvalidIdempotencyKey,
    InvalidEvent,
    InvalidCursor,
    InvalidPage,
    ObjectUnavailable,
    ObjectDeleted,
    ObjectLimit,
    ScopeUnavailable,
    ScopeLimit,
    MemberTypeDenied,
    MemberUnavailable,
    EventLimit,
    StoreLimit,
    IdempotencyCapacity,
    BodyTooLarge,
    EventTooLarge,
    RevisionConflict,
    IdempotencyConflict,
    StorageUnavailable,
    NumericOutOfRange,
}

impl StoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidGrant => "invalid_grant",
            Self::InvalidPluginId => "invalid_plugin_id",
            Self::InvalidObjectType => "invalid_object_type",
            Self::InvalidSchemaVersion => "invalid_schema_version",
            Self::InvalidBody => "invalid_body",
            Self::InvalidHandle => "invalid_handle",
            Self::InvalidAlias => "invalid_alias",
            Self::AliasDenied => "alias_denied",
            Self::AliasConflict => "alias_conflict",
            Self::StableRefUnavailable => "stable_ref_unavailable",
            Self::InvalidStableRefRequest => "invalid_stable_ref_request",
            Self::InvalidIdempotencyKey => "invalid_idempotency_key",
            Self::InvalidEvent => "invalid_event",
            Self::InvalidCursor => "invalid_cursor",
            Self::InvalidPage => "invalid_page",
            Self::ObjectUnavailable => "object_unavailable",
            Self::ObjectDeleted => "object_deleted",
            Self::ObjectLimit => "object_limit",
            Self::ScopeUnavailable => "scope_unavailable",
            Self::ScopeLimit => "scope_limit",
            Self::MemberTypeDenied => "member_type_denied",
            Self::MemberUnavailable => "member_unavailable",
            Self::EventLimit => "event_limit",
            Self::StoreLimit => "store_limit",
            Self::IdempotencyCapacity => "idempotency_capacity",
            Self::BodyTooLarge => "body_too_large",
            Self::EventTooLarge => "event_too_large",
            Self::RevisionConflict => "revision_conflict",
            Self::IdempotencyConflict => "idempotency_conflict",
            Self::StorageUnavailable => "storage_unavailable",
            Self::NumericOutOfRange => "numeric_out_of_range",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectGrant {
    pub object_type: String,
    pub schema_version: u32,
    #[serde(default)]
    pub allow_aliases: bool,
    pub operations: Vec<String>,
    pub max_object_bytes: usize,
    pub max_objects: usize,
    pub max_total_bytes: usize,
    pub max_event_bytes: usize,
    pub max_events_per_object: usize,
    pub max_events_per_commit: usize,
    pub max_event_page: usize,
    pub max_list_page: usize,
    pub event_types: Vec<String>,
}

impl ObjectGrant {
    pub fn validate(&self) -> Result<(), StoreError> {
        if !valid_token(&self.object_type) || self.schema_version == 0
            || self.operations.is_empty() || self.operations.len() > 8
            || self.operations.iter().any(|op| !["create", "read", "commit", "eventPage", "list", "delete", "readAlias", "attachAlias"].contains(&op.as_str()))
            || (self.operations.iter().any(|op| op == "readAlias" || op == "attachAlias") && !self.allow_aliases)
            || self.operations.iter().collect::<std::collections::BTreeSet<_>>().len() != self.operations.len()
            || !(1..=MAX_OBJECT_BODY_BYTES).contains(&self.max_object_bytes)
            || !(1..=MAX_OBJECTS_PER_PLUGIN).contains(&self.max_objects)
            || self.max_total_bytes < self.max_object_bytes
            || self.max_total_bytes > MAX_TOTAL_STORE_BYTES
            || !(1..=MAX_EVENT_BODY_BYTES).contains(&self.max_event_bytes)
            || !(1..=MAX_EVENTS_PER_OBJECT).contains(&self.max_events_per_object)
            || !(1..=MAX_EVENTS_PER_COMMIT).contains(&self.max_events_per_commit)
            || self.max_events_per_commit > self.max_events_per_object
            || !(1..=MAX_PAGE_SIZE).contains(&self.max_event_page)
            || !(1..=MAX_PAGE_SIZE).contains(&self.max_list_page)
            || self.event_types.len() > 128
            || self.event_types.iter().any(|kind| !valid_token(kind))
            || self.event_types.iter().collect::<std::collections::BTreeSet<_>>().len() != self.event_types.len() {
            return Err(StoreError::InvalidGrant);
        }
        Ok(())
    }

    pub fn validate_for(&self, object_type: &str) -> Result<(), StoreError> {
        self.validate()?;
        if self.object_type != object_type { return Err(StoreError::InvalidGrant); }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredObject {
    pub handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    pub schema_version: u32,
    pub revision: u64,
    pub body: Value,
    pub deleted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AliasBinding {
    pub handle: String,
    pub alias: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingEvent {
    pub event_type: String,
    pub body: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredEvent {
    pub event_id: String,
    pub revision: u64,
    pub event_type: String,
    pub body: Value,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventPage {
    pub events: Vec<StoredEvent>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitResult {
    pub revision: u64,
    pub event_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectListPage {
    pub objects: Vec<StoredObject>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteResult {
    pub revision: u64,
    pub deleted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeGrant {
    pub scope_type: String,
    pub operations: Vec<String>,
    pub object_types: Vec<String>,
    pub max_scopes: usize,
    pub max_members: usize,
}

impl ScopeGrant {
    pub fn validate_for(&self, scope_type: &str, object_grants: &BTreeMap<String, ObjectGrant>) -> Result<(), StoreError> {
        if self.scope_type != scope_type || !valid_token(&self.scope_type)
            || self.operations.is_empty() || self.operations.len() > 2
            || self.operations.iter().any(|op| !["read", "commit"].contains(&op.as_str()))
            || self.operations.iter().collect::<std::collections::BTreeSet<_>>().len() != self.operations.len()
            || self.object_types.is_empty() || self.object_types.len() > 128
            || self.object_types.iter().any(|kind| !valid_token(kind)
                || object_grants.get(kind).map_or(true, |grant| grant.validate_for(kind).is_err() || !grant.operations.iter().any(|op| op == "read")))
            || self.object_types.iter().collect::<std::collections::BTreeSet<_>>().len() != self.object_types.len()
            || !(1..=MAX_SCOPES_PER_PLUGIN).contains(&self.max_scopes)
            || !(1..=MAX_SCOPE_MEMBERS).contains(&self.max_members) {
            return Err(StoreError::InvalidGrant);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeMemberRef {
    pub object_type: String,
    pub handle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredScopeMember {
    pub object_type: String,
    pub handle: String,
    pub revision: u64,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredScope {
    pub handle: String,
    pub scope_type: String,
    pub revision: u64,
    pub members: Vec<StoredScopeMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeCommitResult {
    pub scope_handle: String,
    pub revision: u64,
    pub member_count: usize,
}

pub struct ObjectStore {
    path: PathBuf,
    plugin_id: String,
    conn: Connection,
}

impl ObjectStore {
    /// The host constructs this path; plugin requests never supply filesystem paths.
    pub fn open(home: &Path, plugin_id: &str) -> Result<Self, StoreError> {
        if !valid_plugin_id(plugin_id) { return Err(StoreError::InvalidPluginId); }
        let dir = home.join("state/plugin-objects").join(plugin_id);
        std::fs::create_dir_all(&dir).map_err(|_| StoreError::StorageUnavailable)?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|_| StoreError::StorageUnavailable)?;
        }
        let path = dir.join("objects.sqlite");
        let mut conn = Connection::open(&path).map_err(|_| StoreError::StorageUnavailable)?;
        conn.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_| StoreError::StorageUnavailable)?;
        ensure_wal_mode(&conn)?;
        conn.execute_batch("BEGIN IMMEDIATE").map_err(|_| StoreError::StorageUnavailable)?;
        if conn.execute_batch("
            CREATE TABLE IF NOT EXISTS generic_object_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
            INSERT OR IGNORE INTO generic_object_schema(id,version) VALUES (1,1);
            CREATE TABLE IF NOT EXISTS objects(
                object_type TEXT NOT NULL,
                handle TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                body TEXT NOT NULL,
                deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(object_type,handle));
            CREATE TABLE IF NOT EXISTS operations(
                object_type TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                result_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                PRIMARY KEY(object_type,idempotency_key));
            CREATE TABLE IF NOT EXISTS events(
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                object_type TEXT NOT NULL,
                handle TEXT NOT NULL,
                event_id TEXT NOT NULL UNIQUE,
                revision INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS events_object_sequence ON events(object_type,handle,sequence);
            CREATE TABLE IF NOT EXISTS scopes(scope_type TEXT NOT NULL,handle TEXT NOT NULL,revision INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(scope_type,handle));
            CREATE TABLE IF NOT EXISTS scope_members(scope_type TEXT NOT NULL,scope_handle TEXT NOT NULL,
                object_type TEXT NOT NULL,object_handle TEXT NOT NULL,
                PRIMARY KEY(scope_type,scope_handle,object_type,object_handle),
                FOREIGN KEY(scope_type,scope_handle) REFERENCES scopes(scope_type,handle) ON DELETE CASCADE);
            CREATE INDEX IF NOT EXISTS scope_members_object ON scope_members(object_type,object_handle);")
            .is_err() {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(StoreError::StorageUnavailable);
        }
        conn.execute_batch("COMMIT").map_err(|_| StoreError::StorageUnavailable)?;
        let version: u32 = conn.query_row("SELECT version FROM generic_object_schema WHERE id=1", [], |row| row.get(0))
            .map_err(|_| StoreError::StorageUnavailable)?;
        if version != 1 { return Err(StoreError::StorageUnavailable); }
        ensure_alias_support(&mut conn)?;
        ensure_stable_ref_support(&mut conn)?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|_| StoreError::StorageUnavailable)?;
        }
        Ok(Self { path, plugin_id: plugin_id.to_owned(), conn })
    }

    /// `open_in_memory` is intended for unit tests and embedding under a trusted host.
    pub fn open_in_memory(plugin_id: &str) -> Result<Self, StoreError> {
        if !valid_plugin_id(plugin_id) { return Err(StoreError::InvalidPluginId); }
        let conn = Connection::open_in_memory().map_err(|_| StoreError::StorageUnavailable)?;
        let mut store = Self { path: PathBuf::new(), plugin_id: plugin_id.to_owned(), conn };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&mut self) -> Result<(), StoreError> {
        self.conn.execute_batch("CREATE TABLE IF NOT EXISTS generic_object_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
            INSERT OR IGNORE INTO generic_object_schema(id,version) VALUES (1,1);
            CREATE TABLE IF NOT EXISTS objects(object_type TEXT NOT NULL,handle TEXT NOT NULL,schema_version INTEGER NOT NULL,
                revision INTEGER NOT NULL,body TEXT NOT NULL,deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,PRIMARY KEY(object_type,handle));
            CREATE TABLE IF NOT EXISTS operations(object_type TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,
                result_json TEXT NOT NULL,created_at_ms INTEGER NOT NULL,PRIMARY KEY(object_type,idempotency_key));
            CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,object_type TEXT NOT NULL,handle TEXT NOT NULL,
                event_id TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,event_type TEXT NOT NULL,body TEXT NOT NULL,created_at_ms INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS events_object_sequence ON events(object_type,handle,sequence);
            CREATE TABLE IF NOT EXISTS scopes(scope_type TEXT NOT NULL,handle TEXT NOT NULL,revision INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(scope_type,handle));
            CREATE TABLE IF NOT EXISTS scope_members(scope_type TEXT NOT NULL,scope_handle TEXT NOT NULL,
                object_type TEXT NOT NULL,object_handle TEXT NOT NULL,
                PRIMARY KEY(scope_type,scope_handle,object_type,object_handle),
                FOREIGN KEY(scope_type,scope_handle) REFERENCES scopes(scope_type,handle) ON DELETE CASCADE);
            CREATE INDEX IF NOT EXISTS scope_members_object ON scope_members(object_type,object_handle);")
            .map_err(|_| StoreError::StorageUnavailable)?;
        let version: u32 = self.conn.query_row("SELECT version FROM generic_object_schema WHERE id=1", [], |row| row.get(0))
            .map_err(|_| StoreError::StorageUnavailable)?;
        if version != 1 { return Err(StoreError::StorageUnavailable); }
        ensure_alias_support(&mut self.conn)?;
        ensure_stable_ref_support(&mut self.conn)?;
        Ok(())
    }

    pub fn path(&self) -> &Path { &self.path }

    /// Mint durable opaque references for private source keys inside the trusted host.
    /// This method is not exposed as a plugin operation; callers must first authorize
    /// a versioned typed-data field from the active plugin descriptor. The private
    /// source keys are HMACed and are never persisted or returned.
    pub fn stable_source_refs(&mut self, dataset: &str, source_keys: &[String], max_refs: usize) -> Result<Vec<String>, StoreError> {
        if !valid_token(dataset) || !(1..=500).contains(&max_refs) || source_keys.len() > max_refs
            || source_keys.iter().any(|key| key.is_empty() || key.len() > 4096)
            || source_keys.iter().collect::<std::collections::BTreeSet<_>>().len() != source_keys.len() {
            return Err(StoreError::InvalidStableRefRequest);
        }
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| StoreError::StorageUnavailable)?;
        let key: Option<(Vec<u8>,String)> = tx.query_row("SELECT secret,key_check FROM stable_ref_keys WHERE dataset_id=?1", [dataset],
            |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| StoreError::StorageUnavailable)?;
        let key = match key {
            Some((value,check)) if value.len() == 32 && stable_ref_key_check(&value) == check => value,
            Some(_) => return Err(StoreError::StableRefUnavailable),
            None => {
                let count: usize = tx.query_row("SELECT COUNT(*) FROM stable_source_refs WHERE dataset_id=?1", [dataset], |row| row.get(0))
                    .map_err(|_| StoreError::StorageUnavailable)?;
                if count > 0 { return Err(StoreError::StableRefUnavailable); }
                let mut secret = [0u8; 32];
                getrandom::fill(&mut secret).map_err(|_| StoreError::StableRefUnavailable)?;
                tx.execute("INSERT INTO stable_ref_keys(dataset_id,secret,key_check) VALUES (?1,?2,?3)",
                    params![dataset, secret.as_slice(), stable_ref_key_check(&secret)])
                    .map_err(|_| StoreError::StorageUnavailable)?;
                secret.to_vec()
            }
        };
        let mut dataset_ref_count: usize = tx.query_row("SELECT COUNT(*) FROM stable_source_refs WHERE dataset_id=?1", [dataset], |row| row.get(0))
            .map_err(|_| StoreError::StorageUnavailable)?;
        let mut result = Vec::with_capacity(source_keys.len());
        for source_key in source_keys {
            let source_hash = stable_source_hash(&key, dataset, source_key);
            let existing: Option<String> = tx.query_row("SELECT opaque_ref FROM stable_source_refs WHERE dataset_id=?1 AND source_hash=?2",
                params![dataset, source_hash], |row| row.get(0)).optional().map_err(|_| StoreError::StorageUnavailable)?;
            let reference = if let Some(value) = existing { value } else {
                if dataset_ref_count >= MAX_STABLE_REFS_PER_DATASET { return Err(StoreError::StableRefUnavailable); }
                let mut inserted = None;
                for _ in 0..4 {
                    let candidate = random_token("srp_")?;
                    match tx.execute("INSERT OR IGNORE INTO stable_source_refs(dataset_id,source_hash,opaque_ref) VALUES (?1,?2,?3)",
                        params![dataset, source_hash, candidate]) {
                        Ok(1) => { dataset_ref_count += 1; inserted = Some(candidate); break; }
                        Ok(_) => continue,
                        Err(_) => return Err(StoreError::StorageUnavailable),
                    }
                }
                inserted.ok_or(StoreError::StableRefUnavailable)?
            };
            result.push(reference);
        }
        tx.commit().map_err(|_| StoreError::StorageUnavailable)?;
        Ok(result)
    }

    /// Resolve already-minted opaque source refs against trusted source keys.
    /// This is a host-only join helper: raw keys never leave the query layer,
    /// and unknown refs do not create mappings as a side effect.
    pub fn match_stable_source_refs(&self, dataset: &str, source_keys: &[String], references: &[String])
        -> Result<Vec<Option<String>>, StoreError> {
        if !valid_token(dataset) || source_keys.len() > 500 || references.len() > 200
            || source_keys.iter().any(|key| key.is_empty() || key.len() > 4096)
            || source_keys.iter().collect::<std::collections::BTreeSet<_>>().len() != source_keys.len()
            || references.iter().any(|reference| reference.len() != 36 || !reference.starts_with("srp_")
                || !reference[4..].bytes().all(|byte| byte.is_ascii_hexdigit()))
            || references.iter().collect::<std::collections::BTreeSet<_>>().len() != references.len() {
            return Err(StoreError::InvalidStableRefRequest);
        }
        if references.is_empty() || source_keys.is_empty() { return Ok(vec![None; source_keys.len()]); }
        let stored: Option<(Vec<u8>,String)> = self.conn.query_row(
            "SELECT secret,key_check FROM stable_ref_keys WHERE dataset_id=?1", [dataset],
            |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| StoreError::StorageUnavailable)?;
        let key = match stored {
            Some((secret,check)) if secret.len() == 32 && stable_ref_key_check(&secret) == check => secret,
            Some(_) => return Err(StoreError::StableRefUnavailable),
            None => {
                let count: usize = self.conn.query_row("SELECT COUNT(*) FROM stable_source_refs WHERE dataset_id=?1", [dataset],
                    |row| row.get(0)).map_err(|_| StoreError::StorageUnavailable)?;
                if count > 0 { return Err(StoreError::StableRefUnavailable); }
                return Ok(vec![None; source_keys.len()]);
            }
        };
        let mut hash_to_reference = std::collections::HashMap::new();
        for reference in references {
            let source_hash: Option<String> = self.conn.query_row(
                "SELECT source_hash FROM stable_source_refs WHERE dataset_id=?1 AND opaque_ref=?2",
                params![dataset,reference], |row| row.get(0)).optional().map_err(|_| StoreError::StorageUnavailable)?;
            if let Some(source_hash) = source_hash { hash_to_reference.insert(source_hash, reference.clone()); }
        }
        Ok(source_keys.iter().map(|source_key| {
            hash_to_reference.get(&stable_source_hash(&key,dataset,source_key)).cloned()
        }).collect())
    }

    pub fn create(&mut self, grant: &ObjectGrant, schema_version: u32, body: &Value, idempotency_key: &str) -> Result<StoredObject, StoreError> {
        self.create_with_alias(grant, schema_version, body, None, idempotency_key)
    }

    pub fn create_with_alias(&mut self, grant: &ObjectGrant, schema_version: u32, body: &Value, alias: Option<&str>, idempotency_key: &str) -> Result<StoredObject, StoreError> {
        self.check_grant(grant,"create")?;
        if schema_version != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
        if let Some(alias) = alias {
            if !grant.allow_aliases { return Err(StoreError::AliasDenied); }
            validate_alias(alias)?;
        }
        validate_body(body, grant.max_object_bytes)?;
        validate_idempotency_key(idempotency_key)?;
        let request = match alias {
            Some(alias) => json!({"op":"create","schemaVersion":schema_version,"body":body,"alias":alias}),
            None => json!({"op":"create","schemaVersion":schema_version,"body":body}),
        };
        let request_hash = hash_json(&request)?;
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| StoreError::StorageUnavailable)?;
        if let Some(result) = read_idempotent::<StoredObject>(&tx, &grant.object_type, idempotency_key, &request_hash)? { return Ok(result); }
        if let Some(alias) = alias {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM object_aliases WHERE object_type=?1 AND alias=?2)",
                params![grant.object_type, alias], |row| row.get(0)).map_err(|_| StoreError::StorageUnavailable)?;
            if exists { return Err(StoreError::AliasConflict); }
        }
        let count: usize = tx.query_row("SELECT COUNT(*) FROM objects WHERE object_type=?1 AND deleted=0", [&grant.object_type], |row| row.get(0))
            .map_err(|_| StoreError::StorageUnavailable)?;
        if count >= grant.max_objects { return Err(StoreError::ObjectLimit); }
        let handle = random_token("ob_")?;
        let now = now_ms()?;
        let raw = String::from_utf8(canonical_json(body)?).map_err(|_| StoreError::InvalidBody)?;
        let total_bytes: usize = tx.query_row("SELECT COALESCE(SUM(length(body)),0) FROM objects WHERE object_type=?1", [&grant.object_type], |row| row.get(0))
            .map_err(|_| StoreError::StorageUnavailable)?;
        if total_bytes.saturating_add(raw.len()) > grant.max_total_bytes { return Err(StoreError::StoreLimit); }
        tx.execute("INSERT INTO objects(object_type,handle,alias,schema_version,revision,body,deleted,created_at_ms,updated_at_ms)
            VALUES (?1,?2,?3,?4,1,?5,0,?6,?6)", params![grant.object_type,handle,alias,schema_version,raw,now])
            .map_err(|error| if is_unique_alias_conflict(&error) { StoreError::AliasConflict } else { StoreError::StorageUnavailable })?;
        if let Some(alias) = alias {
            tx.execute("INSERT INTO object_aliases(object_type,alias,handle,is_primary,created_at_ms) VALUES (?1,?2,?3,1,?4)",
                params![grant.object_type,alias,handle,now])
                .map_err(|error| if is_unique_alias_conflict(&error) { StoreError::AliasConflict } else { StoreError::StorageUnavailable })?;
        }
        let object = StoredObject { handle, alias: alias.map(str::to_owned), schema_version, revision: 1, body: body.clone(), deleted: false };
        write_idempotent(&tx, &grant.object_type, idempotency_key, &request_hash, &object, now)?;
        tx.commit().map_err(|_| StoreError::StorageUnavailable)?;
        Ok(object)
    }

    pub fn read(&self, grant: &ObjectGrant, handle: &str) -> Result<StoredObject, StoreError> {
        self.check_grant(grant,"read")?;
        validate_handle(handle)?;
        let record = self.conn.query_row("SELECT alias,schema_version,revision,body,deleted FROM objects WHERE object_type=?1 AND handle=?2",
            params![grant.object_type,handle], |row| Ok((row.get::<_,Option<String>>(0)?,row.get::<_,u32>(1)?,row.get::<_,u64>(2)?,row.get::<_,String>(3)?,row.get::<_,bool>(4)?)))
            .optional().map_err(|_| StoreError::StorageUnavailable)?.ok_or(StoreError::ObjectUnavailable)?;
        if record.1 != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
        decode_object(handle, if grant.allow_aliases { record.0 } else { None }, record.1, record.2, &record.3, record.4)
    }

    pub fn read_alias(&self, grant: &ObjectGrant, alias: &str) -> Result<StoredObject, StoreError> {
        self.check_grant(grant, "readAlias")?;
        if !grant.allow_aliases { return Err(StoreError::AliasDenied); }
        validate_alias(alias)?;
        let row = self.conn.query_row("SELECT o.handle,o.schema_version,o.revision,o.body,o.deleted FROM object_aliases a
            JOIN objects o ON o.object_type=a.object_type AND o.handle=a.handle WHERE a.object_type=?1 AND a.alias=?2",
            params![grant.object_type,alias], |row| Ok((row.get::<_,String>(0)?,row.get::<_,u32>(1)?,row.get::<_,u64>(2)?,row.get::<_,String>(3)?,row.get::<_,bool>(4)?)))
            .optional().map_err(|_| StoreError::StorageUnavailable)?.ok_or(StoreError::ObjectUnavailable)?;
        if row.1 != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
        decode_object(&row.0, Some(alias.to_owned()), row.1, row.2, &row.3, row.4)
    }

    /// Attach a descriptor-authorized secondary alias without changing object revision.
    /// Existing bindings to the same object are idempotent; aliases remain reserved after tombstoning.
    pub fn attach_alias(&mut self, grant: &ObjectGrant, handle: &str, alias: &str, idempotency_key: &str) -> Result<AliasBinding, StoreError> {
        self.check_grant(grant,"attachAlias")?;
        if !grant.allow_aliases { return Err(StoreError::AliasDenied); }
        validate_handle(handle)?;
        validate_alias(alias)?;
        validate_idempotency_key(idempotency_key)?;
        let request_hash = hash_json(&json!({"op":"attachAlias","handle":handle,"alias":alias}))?;
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| StoreError::StorageUnavailable)?;
        if let Some(result) = read_idempotent::<AliasBinding>(&tx,&grant.object_type,idempotency_key,&request_hash)? {
            return Ok(result);
        }
        let object: Option<(u32,bool)> = tx.query_row("SELECT schema_version,deleted FROM objects WHERE object_type=?1 AND handle=?2",
            params![grant.object_type,handle], |row| Ok((row.get(0)?,row.get(1)?)))
            .optional().map_err(|_| StoreError::StorageUnavailable)?;
        let Some((schema_version,deleted)) = object else { return Err(StoreError::ObjectUnavailable); };
        if schema_version != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
        let binding: Option<String> = tx.query_row("SELECT handle FROM object_aliases WHERE object_type=?1 AND alias=?2",
            params![grant.object_type,alias], |row| row.get(0)).optional().map_err(|_| StoreError::StorageUnavailable)?;
        match binding {
            Some(existing) if existing != handle => return Err(StoreError::AliasConflict),
            Some(_) => {},
            None if deleted => return Err(StoreError::ObjectDeleted),
            None => {
                let now = now_ms()?;
                tx.execute("INSERT INTO object_aliases(object_type,alias,handle,is_primary,created_at_ms) VALUES (?1,?2,?3,0,?4)",
                    params![grant.object_type,alias,handle,now])
                    .map_err(|error| if is_unique_alias_conflict(&error) { StoreError::AliasConflict } else { StoreError::StorageUnavailable })?;
            }
        }
        let result = AliasBinding { handle:handle.to_owned(),alias:alias.to_owned() };
        write_idempotent(&tx,&grant.object_type,idempotency_key,&request_hash,&result,now_ms()?)?;
        tx.commit().map_err(|_| StoreError::StorageUnavailable)?;
        Ok(result)
    }

    /// List a bounded page using the previous opaque object handle as cursor.
    /// Cursors are scoped by plugin storage and object type; tombstones remain visible.
    pub fn list(&self, grant: &ObjectGrant, schema_version: u32, cursor: Option<&str>, limit: usize) -> Result<ObjectListPage, StoreError> {
        self.check_grant(grant,"list")?;
        if schema_version != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
        if !(1..=grant.max_list_page).contains(&limit) { return Err(StoreError::InvalidPage); }
        let anchor = match cursor {
            None => None,
            Some(handle) => {
                validate_handle(handle)?;
                self.conn.query_row("SELECT created_at_ms,handle FROM objects WHERE object_type=?1 AND handle=?2",
                    params![grant.object_type,handle], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?)))
                    .optional().map_err(|_| StoreError::StorageUnavailable)?.ok_or(StoreError::InvalidCursor).map(Some)?
            }
        };
        let mut stmt = self.conn.prepare("SELECT handle,alias,schema_version,revision,body,deleted FROM objects
            WHERE object_type=?1 AND (?2 IS NULL OR created_at_ms>?2 OR (created_at_ms=?2 AND handle>?3))
            ORDER BY created_at_ms,handle LIMIT ?4")
            .map_err(|_| StoreError::StorageUnavailable)?;
        let (after_ms, after_handle) = anchor.map(|(at,handle)| (Some(at),Some(handle))).unwrap_or((None,None));
        let rows = stmt.query_map(params![grant.object_type,after_ms,after_handle,(limit + 1) as i64], |row| {
            Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,u32>(2)?,row.get::<_,u64>(3)?,row.get::<_,String>(4)?,row.get::<_,bool>(5)?))
        }).map_err(|_| StoreError::StorageUnavailable)?;
        let mut objects = Vec::new();
        for row in rows {
            let (handle,alias,version,revision,body,deleted) = row.map_err(|_| StoreError::StorageUnavailable)?;
            if version != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
            objects.push(decode_object(&handle,if grant.allow_aliases { alias } else { None },version,revision,&body,deleted)?);
        }
        let has_more = objects.len() > limit;
        objects.truncate(limit);
        let next_cursor = if has_more { objects.last().map(|object| object.handle.clone()) } else { None };
        Ok(ObjectListPage { objects,next_cursor,has_more })
    }

    /// Resolve a bounded set of stable aliases in one generic object request.
    /// The alias filter is data, not a table/field selector; all access remains
    /// scoped to this descriptor grant and object type.
    pub fn list_by_aliases(&self, grant: &ObjectGrant, schema_version: u32, aliases: &[String], limit: usize) -> Result<ObjectListPage, StoreError> {
        self.check_grant(grant,"list")?;
        if !grant.allow_aliases { return Err(StoreError::AliasDenied); }
        if schema_version != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
        if aliases.len() > grant.max_list_page || aliases.len() > MAX_PAGE_SIZE || !(1..=grant.max_list_page).contains(&limit) {
            return Err(StoreError::InvalidPage);
        }
        let mut unique = std::collections::BTreeSet::new();
        for alias in aliases {
            validate_alias(alias)?;
            if !unique.insert(alias) { return Err(StoreError::InvalidAlias); }
        }
        if aliases.is_empty() { return Ok(ObjectListPage { objects:Vec::new(),next_cursor:None,has_more:false }); }
        let encoded = serde_json::to_string(aliases).map_err(|_| StoreError::InvalidPage)?;
        let mut stmt = self.conn.prepare("SELECT o.handle,o.alias,o.schema_version,o.revision,o.body,o.deleted FROM objects o
            WHERE o.object_type=?1 AND o.handle IN (SELECT DISTINCT a.handle FROM object_aliases a
                WHERE a.object_type=?1 AND a.alias IN (SELECT value FROM json_each(?2)))
            ORDER BY o.created_at_ms,o.handle LIMIT ?3")
            .map_err(|_| StoreError::StorageUnavailable)?;
        let rows = stmt.query_map(params![grant.object_type,encoded,limit as i64], |row| {
            Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,u32>(2)?,row.get::<_,u64>(3)?,row.get::<_,String>(4)?,row.get::<_,bool>(5)?))
        }).map_err(|_| StoreError::StorageUnavailable)?;
        let mut objects = Vec::new();
        for row in rows {
            let (handle,alias,version,revision,body,deleted) = row.map_err(|_| StoreError::StorageUnavailable)?;
            if version != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
            objects.push(decode_object(&handle,if grant.allow_aliases { alias } else { None },version,revision,&body,deleted)?);
        }
        Ok(ObjectListPage { objects,next_cursor:None,has_more:false })
    }

    /// Read a bounded set of objects by opaque handles in one generic request.
    /// Handles are constrained to the caller's descriptor grant and object type.
    pub fn list_by_handles(&self, grant: &ObjectGrant, schema_version: u32, handles: &[String], limit: usize) -> Result<ObjectListPage, StoreError> {
        self.check_grant(grant,"list")?;
        if schema_version != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
        if handles.len() > grant.max_list_page || handles.len() > MAX_PAGE_SIZE || !(1..=grant.max_list_page).contains(&limit) {
            return Err(StoreError::InvalidPage);
        }
        let mut unique = std::collections::BTreeSet::new();
        for handle in handles {
            validate_handle(handle)?;
            if !unique.insert(handle) { return Err(StoreError::InvalidPage); }
        }
        if handles.is_empty() { return Ok(ObjectListPage { objects:Vec::new(),next_cursor:None,has_more:false }); }
        let encoded = serde_json::to_string(handles).map_err(|_| StoreError::InvalidPage)?;
        let mut stmt = self.conn.prepare("SELECT handle,alias,schema_version,revision,body,deleted FROM objects
            WHERE object_type=?1 AND handle IN (SELECT value FROM json_each(?2))
            ORDER BY created_at_ms,handle LIMIT ?3")
            .map_err(|_| StoreError::StorageUnavailable)?;
        let rows = stmt.query_map(params![grant.object_type,encoded,limit as i64], |row| {
            Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,u32>(2)?,row.get::<_,u64>(3)?,row.get::<_,String>(4)?,row.get::<_,bool>(5)?))
        }).map_err(|_| StoreError::StorageUnavailable)?;
        let mut objects = Vec::new();
        for row in rows {
            let (handle,alias,version,revision,body,deleted) = row.map_err(|_| StoreError::StorageUnavailable)?;
            if version != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
            objects.push(decode_object(&handle,if grant.allow_aliases { alias } else { None },version,revision,&body,deleted)?);
        }
        Ok(ObjectListPage { objects,next_cursor:None,has_more:false })
    }

    pub fn read_scope(&self, grant: &ScopeGrant, scope_type: &str, handle: &str,
        object_grants: &BTreeMap<String,ObjectGrant>) -> Result<StoredScope, StoreError> {
        self.read_scope_with_hook(grant,scope_type,handle,object_grants,|| {})
    }

    fn read_scope_with_hook<F: FnOnce()>(&self, grant: &ScopeGrant, scope_type: &str, handle: &str,
        object_grants: &BTreeMap<String,ObjectGrant>, after_revision_read: F) -> Result<StoredScope, StoreError> {
        grant.validate_for(scope_type,object_grants)?;
        if !grant.operations.iter().any(|op| op == "read") { return Err(StoreError::InvalidGrant); }
        validate_scope_handle(handle)?;
        let tx = self.conn.unchecked_transaction().map_err(|_| StoreError::StorageUnavailable)?;
        let revision: u64 = tx.query_row("SELECT revision FROM scopes WHERE scope_type=?1 AND handle=?2",
            params![scope_type,handle], |row| row.get(0)).optional().map_err(|_| StoreError::StorageUnavailable)?
            .ok_or(StoreError::ScopeUnavailable)?;
        after_revision_read();
        let mut stmt = tx.prepare("SELECT m.object_type,m.object_handle,o.revision,o.deleted FROM scope_members m
            JOIN objects o ON o.object_type=m.object_type AND o.handle=m.object_handle
            WHERE m.scope_type=?1 AND m.scope_handle=?2 ORDER BY m.object_type,m.object_handle")
            .map_err(|_| StoreError::StorageUnavailable)?;
        let rows = stmt.query_map(params![scope_type,handle], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,u64>(2)?,row.get::<_,bool>(3)?)))
            .map_err(|_| StoreError::StorageUnavailable)?;
        let mut members = Vec::new();
        for row in rows {
            let (object_type,object_handle,object_revision,deleted) = row.map_err(|_| StoreError::StorageUnavailable)?;
            if !grant.object_types.contains(&object_type) || !object_grants.contains_key(&object_type) { return Err(StoreError::MemberTypeDenied); }
            members.push(StoredScopeMember { object_type,handle:object_handle,revision:object_revision,deleted });
        }
        if members.len() > grant.max_members { return Err(StoreError::ScopeLimit); }
        drop(stmt);
        tx.commit().map_err(|_| StoreError::StorageUnavailable)?;
        Ok(StoredScope { handle:handle.to_owned(),scope_type:scope_type.to_owned(),revision,members })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn commit_scope(&mut self, grant: &ScopeGrant, scope_type: &str, scope_handle: Option<&str>, expected_revision: u64,
        members: &[ScopeMemberRef], idempotency_key: &str, object_grants: &BTreeMap<String,ObjectGrant>) -> Result<ScopeCommitResult, StoreError> {
        grant.validate_for(scope_type,object_grants)?;
        if !grant.operations.iter().any(|op| op == "commit") { return Err(StoreError::InvalidGrant); }
        if let Some(handle) = scope_handle { validate_scope_handle(handle)?; }
        validate_idempotency_key(idempotency_key)?;
        if expected_revision > 9_007_199_254_740_991 { return Err(StoreError::NumericOutOfRange); }
        if members.len() > grant.max_members { return Err(StoreError::ScopeLimit); }
        let mut normalized = members.to_vec();
        normalized.sort_by(|left,right| left.object_type.cmp(&right.object_type).then_with(|| left.handle.cmp(&right.handle)));
        let mut seen = std::collections::BTreeSet::new();
        for member in &normalized {
            if !grant.object_types.contains(&member.object_type) { return Err(StoreError::MemberTypeDenied); }
            let object_grant = object_grants.get(&member.object_type).filter(|value| value.validate_for(&member.object_type).is_ok())
                .ok_or(StoreError::MemberTypeDenied)?;
            if !object_grant.operations.iter().any(|op| op == "read") { return Err(StoreError::MemberTypeDenied); }
            validate_handle(&member.handle)?;
            if !seen.insert((member.object_type.clone(),member.handle.clone())) { return Err(StoreError::InvalidBody); }
        }
        let namespace = format!("scope:{scope_type}");
        let request_hash = hash_json(&json!({"op":"scopeCommit","scopeHandle":scope_handle,"expectedRevision":expected_revision,"members":normalized}))?;
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| StoreError::StorageUnavailable)?;
        if let Some(result) = read_idempotent::<ScopeCommitResult>(&tx,&namespace,idempotency_key,&request_hash)? { return Ok(result); }
        let (scope_handle,current_revision,is_new) = match scope_handle {
            Some(handle) => {
                let current: u64 = tx.query_row("SELECT revision FROM scopes WHERE scope_type=?1 AND handle=?2",params![scope_type,handle],|row|row.get(0))
                    .optional().map_err(|_|StoreError::StorageUnavailable)?.ok_or(StoreError::ScopeUnavailable)?;
                (handle.to_owned(),current,false)
            }
            None => {
                if expected_revision != 0 { return Err(StoreError::RevisionConflict); }
                let count: usize = tx.query_row("SELECT COUNT(*) FROM scopes WHERE scope_type=?1",[scope_type],|row|row.get(0)).map_err(|_|StoreError::StorageUnavailable)?;
                if count >= grant.max_scopes { return Err(StoreError::ScopeLimit); }
                (random_token("sc_")?,0,true)
            }
        };
        if current_revision != expected_revision { return Err(StoreError::RevisionConflict); }
        for member in &normalized {
            let object_grant = object_grants.get(&member.object_type).ok_or(StoreError::MemberTypeDenied)?;
            let row: Option<(u32,bool)> = tx.query_row("SELECT schema_version,deleted FROM objects WHERE object_type=?1 AND handle=?2",
                params![member.object_type,member.handle],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_|StoreError::StorageUnavailable)?;
            let Some((version,_deleted)) = row else { return Err(StoreError::MemberUnavailable); };
            if version != object_grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
        }
        let next = current_revision.checked_add(1).filter(|revision| *revision <= 9_007_199_254_740_991).ok_or(StoreError::NumericOutOfRange)?;
        let now = now_ms()?;
        if is_new {
            tx.execute("INSERT INTO scopes(scope_type,handle,revision,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,?4)",
                params![scope_type,scope_handle,next,now]).map_err(|_|StoreError::StorageUnavailable)?;
        } else {
            let changed = tx.execute("UPDATE scopes SET revision=?3,updated_at_ms=?4 WHERE scope_type=?1 AND handle=?2 AND revision=?5",
                params![scope_type,scope_handle,next,now,current_revision]).map_err(|_|StoreError::StorageUnavailable)?;
            if changed != 1 { return Err(StoreError::RevisionConflict); }
            tx.execute("DELETE FROM scope_members WHERE scope_type=?1 AND scope_handle=?2",params![scope_type,scope_handle])
                .map_err(|_|StoreError::StorageUnavailable)?;
        }
        for member in &normalized {
            tx.execute("INSERT INTO scope_members(scope_type,scope_handle,object_type,object_handle) VALUES (?1,?2,?3,?4)",
                params![scope_type,scope_handle,member.object_type,member.handle]).map_err(|_|StoreError::StorageUnavailable)?;
        }
        let result = ScopeCommitResult { scope_handle,revision:next,member_count:normalized.len() };
        write_idempotent(&tx,&namespace,idempotency_key,&request_hash,&result,now)?;
        tx.commit().map_err(|_|StoreError::StorageUnavailable)?;
        Ok(result)
    }

    /// Compare-and-swap object body and append all events in the same transaction.
    pub fn commit(&mut self, grant: &ObjectGrant, handle: &str, expected_revision: u64, body: &Value,
        events: &[PendingEvent], idempotency_key: &str) -> Result<CommitResult, StoreError> {
        self.check_grant(grant,"commit")?;
        validate_handle(handle)?;
        validate_body(body, grant.max_object_bytes)?;
        validate_idempotency_key(idempotency_key)?;
        if events.len() > grant.max_events_per_commit { return Err(StoreError::EventLimit); }
        for event in events {
            if !grant.event_types.contains(&event.event_type) || !valid_token(&event.event_type) { return Err(StoreError::InvalidEvent); }
            validate_body_size(&event.body, grant.max_event_bytes).map_err(|_| StoreError::EventTooLarge)?;
        }
        let request_hash = hash_json(&json!({"op":"commit","handle":handle,"expectedRevision":expected_revision,"body":body,"events":events}))?;
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| StoreError::StorageUnavailable)?;
        if let Some(result) = read_idempotent::<CommitResult>(&tx, &grant.object_type, idempotency_key, &request_hash)? { return Ok(result); }
        let (schema_version, current, deleted, event_count): (u32,u64,bool,usize) = tx.query_row(
            "SELECT o.schema_version,o.revision,o.deleted,(SELECT COUNT(*) FROM events e WHERE e.object_type=o.object_type AND e.handle=o.handle)
             FROM objects o WHERE o.object_type=?1 AND o.handle=?2", params![grant.object_type,handle],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()
            .map_err(|_| StoreError::StorageUnavailable)?.ok_or(StoreError::ObjectUnavailable)?;
        if deleted { return Err(StoreError::ObjectDeleted); }
        if schema_version != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
        if current != expected_revision { return Err(StoreError::RevisionConflict); }
        if event_count.saturating_add(events.len()) > grant.max_events_per_object { return Err(StoreError::EventLimit); }
        let next_revision = current.checked_add(1).filter(|revision| *revision <= 9_007_199_254_740_991).ok_or(StoreError::NumericOutOfRange)?;
        let now = now_ms()?;
        let raw = String::from_utf8(canonical_json(body)?).map_err(|_| StoreError::InvalidBody)?;
        let other_bytes: usize = tx.query_row("SELECT COALESCE(SUM(length(body)),0) FROM objects WHERE object_type=?1 AND handle<>?2",
            params![grant.object_type,handle], |row| row.get(0)).map_err(|_| StoreError::StorageUnavailable)?;
        if other_bytes.saturating_add(raw.len()) > grant.max_total_bytes { return Err(StoreError::StoreLimit); }
        let changed = tx.execute("UPDATE objects SET revision=?3,body=?4,updated_at_ms=?5
            WHERE object_type=?1 AND handle=?2 AND revision=?6 AND deleted=0",
            params![grant.object_type,handle,next_revision,raw,now,current]).map_err(|_| StoreError::StorageUnavailable)?;
        if changed != 1 { return Err(StoreError::RevisionConflict); }
        let mut event_ids = Vec::with_capacity(events.len());
        for event in events {
            let event_id = random_token("ev_")?;
            let event_body = serde_json::to_string(&event.body).map_err(|_| StoreError::InvalidEvent)?;
            tx.execute("INSERT INTO events(object_type,handle,event_id,revision,event_type,body,created_at_ms)
                VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![grant.object_type,handle,event_id,next_revision,event.event_type,event_body,now])
                .map_err(|_| StoreError::StorageUnavailable)?;
            event_ids.push(event_id);
        }
        let result = CommitResult { revision: next_revision, event_ids };
        write_idempotent(&tx, &grant.object_type, idempotency_key, &request_hash, &result, now)?;
        tx.commit().map_err(|_| StoreError::StorageUnavailable)?;
        Ok(result)
    }

    /// CAS tombstone. The body and existing scope memberships are retained so
    /// readers can identify deleted references without reusing a handle.
    pub fn delete(&mut self, grant: &ObjectGrant, handle: &str, expected_revision: u64,
        idempotency_key: &str) -> Result<DeleteResult, StoreError> {
        self.check_grant(grant,"delete")?;
        validate_handle(handle)?;
        validate_idempotency_key(idempotency_key)?;
        let request_hash = hash_json(&json!({"op":"delete","handle":handle,"expectedRevision":expected_revision}))?;
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| StoreError::StorageUnavailable)?;
        if let Some(result) = read_idempotent::<DeleteResult>(&tx, &grant.object_type, idempotency_key, &request_hash)? { return Ok(result); }
        let (schema_version,current,deleted): (u32,u64,bool) = tx.query_row("SELECT schema_version,revision,deleted FROM objects WHERE object_type=?1 AND handle=?2",
            params![grant.object_type,handle], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))
            .optional().map_err(|_| StoreError::StorageUnavailable)?.ok_or(StoreError::ObjectUnavailable)?;
        if schema_version != grant.schema_version { return Err(StoreError::InvalidSchemaVersion); }
        if deleted { return Err(StoreError::ObjectDeleted); }
        if current != expected_revision { return Err(StoreError::RevisionConflict); }
        let next = current.checked_add(1).filter(|revision| *revision <= 9_007_199_254_740_991).ok_or(StoreError::NumericOutOfRange)?;
        let now = now_ms()?;
        let changed = tx.execute("UPDATE objects SET revision=?3,deleted=1,updated_at_ms=?4 WHERE object_type=?1 AND handle=?2 AND revision=?5 AND deleted=0",
            params![grant.object_type,handle,next,now,current]).map_err(|_| StoreError::StorageUnavailable)?;
        if changed != 1 { return Err(StoreError::RevisionConflict); }
        let result = DeleteResult { revision:next,deleted:true };
        write_idempotent(&tx, &grant.object_type, idempotency_key, &request_hash, &result, now)?;
        tx.commit().map_err(|_| StoreError::StorageUnavailable)?;
        Ok(result)
    }

    pub fn event_page(&self, grant: &ObjectGrant, handle: &str, after_cursor: Option<&str>, limit: usize) -> Result<EventPage, StoreError> {
        self.check_grant(grant,"eventPage")?;
        validate_handle(handle)?;
        if !(1..=grant.max_event_page).contains(&limit) { return Err(StoreError::InvalidPage); }
        let after_sequence = match after_cursor {
            None => 0,
            Some(cursor) => {
                validate_event_id(cursor)?;
                self.conn.query_row("SELECT sequence FROM events WHERE object_type=?1 AND handle=?2 AND event_id=?3",
                    params![grant.object_type,handle,cursor], |row| row.get::<_,i64>(0)).optional()
                    .map_err(|_| StoreError::StorageUnavailable)?.ok_or(StoreError::InvalidCursor)?
            }
        };
        let mut stmt = self.conn.prepare("SELECT event_id,revision,event_type,body,created_at_ms FROM events
            WHERE object_type=?1 AND handle=?2 AND sequence>?3 ORDER BY sequence ASC LIMIT ?4")
            .map_err(|_| StoreError::StorageUnavailable)?;
        let rows = stmt.query_map(params![grant.object_type,handle,after_sequence,limit as i64], |row| {
            Ok((row.get::<_,String>(0)?,row.get::<_,u64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,i64>(4)?))
        }).map_err(|_| StoreError::StorageUnavailable)?;
        let mut events = Vec::new();
        for row in rows {
            let (event_id,revision,event_type,body,created_at_ms) = row.map_err(|_| StoreError::StorageUnavailable)?;
            validate_event_id(&event_id)?;
            if !grant.event_types.contains(&event_type) { return Err(StoreError::StorageUnavailable); }
            let body: Value = serde_json::from_str(&body).map_err(|_| StoreError::StorageUnavailable)?;
            validate_body_size(&body, grant.max_event_bytes).map_err(|_| StoreError::StorageUnavailable)?;
            events.push(StoredEvent { event_id,revision,event_type,body,created_at_ms });
        }
        let boundary = events.last().map(|event| self.conn.query_row("SELECT sequence FROM events WHERE event_id=?1", [&event.event_id], |row| row.get::<_,i64>(0)))
            .transpose().map_err(|_| StoreError::StorageUnavailable)?.unwrap_or(after_sequence);
        let has_more = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE object_type=?1 AND handle=?2 AND sequence>?3)",
            params![grant.object_type,handle,boundary], |row| row.get::<_,bool>(0))
            .map_err(|_| StoreError::StorageUnavailable)?;
        let next_cursor = events.last().map(|event| event.event_id.clone());
        Ok(EventPage { events,next_cursor,has_more })
    }

    fn check_grant(&self, grant: &ObjectGrant, operation: &str) -> Result<(), StoreError> {
        grant.validate()?;
        if !valid_plugin_id(&self.plugin_id) { return Err(StoreError::InvalidPluginId); }
        if !grant.operations.iter().any(|allowed| allowed == operation) { return Err(StoreError::InvalidGrant); }
        Ok(())
    }
}

fn ensure_wal_mode(conn: &Connection) -> Result<(), StoreError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0)) {
            Ok(mode) if mode.eq_ignore_ascii_case("wal") => return Ok(()),
            Ok(_) => return Err(StoreError::StorageUnavailable),
            Err(rusqlite::Error::SqliteFailure(code, _))
                if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(_) => return Err(StoreError::StorageUnavailable),
        }
    }
}

fn read_idempotent<T: for<'de> Deserialize<'de>>(tx: &Transaction<'_>, namespace: &str, key: &str, request_hash: &str) -> Result<Option<T>, StoreError> {
    let row: Option<(String,String)> = tx.query_row("SELECT request_hash,result_json FROM operations WHERE object_type=?1 AND idempotency_key=?2",
        params![namespace,key], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| StoreError::StorageUnavailable)?;
    let Some((saved_hash,result)) = row else { return Ok(None); };
    if saved_hash != request_hash { return Err(StoreError::IdempotencyConflict); }
    serde_json::from_str(&result).map(Some).map_err(|_| StoreError::StorageUnavailable)
}

fn write_idempotent<T: Serialize>(tx: &Transaction<'_>, namespace: &str, key: &str, request_hash: &str, result: &T, now: i64) -> Result<(), StoreError> {
    let count: usize = tx.query_row("SELECT COUNT(*) FROM operations WHERE object_type=?1", [namespace], |row| row.get(0))
        .map_err(|_| StoreError::StorageUnavailable)?;
    if count >= MAX_IDEMPOTENCY_RECORDS { return Err(StoreError::IdempotencyCapacity); }
    let result = serde_json::to_string(result).map_err(|_| StoreError::StorageUnavailable)?;
    tx.execute("INSERT INTO operations(object_type,idempotency_key,request_hash,result_json,created_at_ms) VALUES (?1,?2,?3,?4,?5)",
        params![namespace,key,request_hash,result,now]).map_err(|_| StoreError::StorageUnavailable)?;
    Ok(())
}

fn decode_object(handle: &str, alias: Option<String>, schema_version: u32, revision: u64, body: &str, deleted: bool) -> Result<StoredObject, StoreError> {
    let body: Value = serde_json::from_str(body).map_err(|_| StoreError::StorageUnavailable)?;
    Ok(StoredObject { handle:handle.to_owned(),alias,schema_version,revision,body,deleted })
}

fn ensure_alias_support(conn: &mut Connection) -> Result<(), StoreError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| StoreError::StorageUnavailable)?;
    let mut statement = tx.prepare("PRAGMA table_info(objects)").map_err(|_| StoreError::StorageUnavailable)?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|_| StoreError::StorageUnavailable)?;
    let mut has_alias = false;
    for column in columns {
        if column.map_err(|_| StoreError::StorageUnavailable)? == "alias" { has_alias = true; }
    }
    drop(statement);
    if !has_alias {
        tx.execute("ALTER TABLE objects ADD COLUMN alias TEXT", []).map_err(|_| StoreError::StorageUnavailable)?;
    }
    tx.execute("CREATE UNIQUE INDEX IF NOT EXISTS objects_alias_unique ON objects(object_type,alias) WHERE alias IS NOT NULL", [])
        .map_err(|_| StoreError::StorageUnavailable)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS object_aliases(
            object_type TEXT NOT NULL,
            alias TEXT NOT NULL,
            handle TEXT NOT NULL,
            is_primary INTEGER NOT NULL CHECK(is_primary IN (0,1)),
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(object_type,alias),
            UNIQUE(object_type,handle,alias));
        CREATE INDEX IF NOT EXISTS object_aliases_handle ON object_aliases(object_type,handle);")
        .map_err(|_| StoreError::StorageUnavailable)?;
    tx.execute("INSERT OR IGNORE INTO object_aliases(object_type,alias,handle,is_primary,created_at_ms)
        SELECT object_type,alias,handle,1,created_at_ms FROM objects WHERE alias IS NOT NULL", [])
        .map_err(|_| StoreError::StorageUnavailable)?;
    tx.commit().map_err(|_| StoreError::StorageUnavailable)?;
    Ok(())
}

fn ensure_stable_ref_support(conn: &mut Connection) -> Result<(), StoreError> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS stable_ref_keys(
            dataset_id TEXT PRIMARY KEY,
            secret BLOB NOT NULL,
            key_check TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS stable_source_refs(
            dataset_id TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            opaque_ref TEXT NOT NULL UNIQUE,
            PRIMARY KEY(dataset_id,source_hash));")
        .map_err(|_| StoreError::StorageUnavailable)?;
    Ok(())
}

fn is_unique_alias_conflict(error: &rusqlite::Error) -> bool {
    matches!(error, rusqlite::Error::SqliteFailure(code, _)
        if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
}

fn validate_body(body: &Value, max_bytes: usize) -> Result<(), StoreError> {
    if !body.is_object() { return Err(StoreError::InvalidBody); }
    validate_body_size(body,max_bytes).map_err(|_| StoreError::BodyTooLarge)
}

fn validate_body_size(body: &Value, max_bytes: usize) -> Result<(), StoreError> {
    let bytes = canonical_json(body)?.len();
    if bytes > max_bytes { Err(StoreError::BodyTooLarge) } else { Ok(()) }
}

fn canonical_json(value: &Value) -> Result<Vec<u8>, StoreError> {
    fn sort(value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                let mut keys = object.keys().collect::<Vec<_>>();
                keys.sort();
                let mut sorted = Map::new();
                for key in keys { sorted.insert(key.clone(), sort(&object[key])); }
                Value::Object(sorted)
            }
            Value::Array(values) => Value::Array(values.iter().map(sort).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_vec(&sort(value)).map_err(|_| StoreError::InvalidBody)
}

fn hash_json(value: &Value) -> Result<String, StoreError> {
    use sha2::{Digest, Sha256};
    Ok(format!("{:x}",Sha256::digest(canonical_json(value)?)))
}

fn stable_source_hash(key: &[u8], dataset: &str, source_key: &str) -> String {
    let message = format!("{dataset}\0{source_key}");
    lower_hex(&stable_ref_hmac(key, message.as_bytes()))
}

fn stable_ref_key_check(key: &[u8]) -> String {
    lower_hex(&stable_ref_hmac(key, b"agent-vitals/stable-source-ref-key-check:v1"))
}

fn lower_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes { use std::fmt::Write; let _ = write!(&mut output,"{byte:02x}"); }
    output
}

fn stable_ref_hmac(key: &[u8], message: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    const BLOCK: usize = 64;
    let mut normalized = [0u8; BLOCK];
    if key.len() > BLOCK { normalized[..32].copy_from_slice(&sha2::Sha256::digest(key)); }
    else { normalized[..key.len()].copy_from_slice(key); }
    let mut inner_pad = [0x36u8; BLOCK];
    let mut outer_pad = [0x5cu8; BLOCK];
    for index in 0..BLOCK {
        inner_pad[index] ^= normalized[index];
        outer_pad[index] ^= normalized[index];
    }
    let inner = sha2::Sha256::new().chain_update(inner_pad).chain_update(message).finalize();
    let digest = sha2::Sha256::new().chain_update(outer_pad).chain_update(inner).finalize();
    let mut output = [0u8;32];
    output.copy_from_slice(&digest);
    output
}

fn random_token(prefix: &str) -> Result<String, StoreError> {
    let mut bytes = [0u8;16];
    getrandom::fill(&mut bytes).map_err(|_| StoreError::StorageUnavailable)?;
    let mut out = String::with_capacity(prefix.len()+32);
    out.push_str(prefix);
    for byte in bytes { use std::fmt::Write; write!(&mut out,"{byte:02x}").map_err(|_| StoreError::StorageUnavailable)?; }
    Ok(out)
}

fn now_ms() -> Result<i64, StoreError> {
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| StoreError::StorageUnavailable)?;
    i64::try_from(duration.as_millis()).map_err(|_| StoreError::NumericOutOfRange)
}

fn validate_idempotency_key(key: &str) -> Result<(), StoreError> {
    if key.is_empty() || key.len() > MAX_IDEMPOTENCY_KEY_BYTES || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)) {
        Err(StoreError::InvalidIdempotencyKey)
    } else { Ok(()) }
}

fn validate_handle(handle: &str) -> Result<(), StoreError> {
    validate_random_id(handle,"ob_").map_err(|_| StoreError::InvalidHandle)
}

fn validate_alias(alias: &str) -> Result<(), StoreError> {
    if alias.is_empty() || alias.len() > 128 || !alias.bytes().all(|byte|
        byte.is_ascii_alphanumeric() || b"._:-".contains(&byte)) {
        Err(StoreError::InvalidAlias)
    } else { Ok(()) }
}

fn validate_scope_handle(handle: &str) -> Result<(), StoreError> {
    validate_random_id(handle,"sc_").map_err(|_| StoreError::InvalidHandle)
}

fn validate_event_id(handle: &str) -> Result<(), StoreError> {
    validate_random_id(handle,"ev_").map_err(|_| StoreError::InvalidCursor)
}

fn validate_random_id(value: &str, prefix: &str) -> Result<(), ()> {
    let suffix = value.strip_prefix(prefix).ok_or(())?;
    if suffix.len() != 32 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(()); }
    Ok(())
}

fn valid_plugin_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b,b'-'|b'_'|b'.'|b':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant() -> ObjectGrant {
        ObjectGrant { object_type:"test.record:v1".into(),schema_version:1,allow_aliases:false,operations:vec!["create".into(),"read".into(),"commit".into(),"eventPage".into(),"list".into(),"delete".into()],max_object_bytes:2048,max_objects:4,max_total_bytes:8192,
            max_event_bytes:512,max_events_per_object:8,max_events_per_commit:4,max_event_page:2,max_list_page:2,
            event_types:vec!["record.changed".into(),"record.reset".into()] }
    }

    #[test]
    fn create_is_idempotent_and_handles_are_plugin_scoped() {
        let mut first = ObjectStore::open_in_memory("test-app").unwrap();
        let body = json!({"name":"alpha"});
        let created = first.create(&grant(),1,&body,"create-1").unwrap();
        assert_eq!(created.revision,1);
        assert!(created.handle.starts_with("ob_"));
        assert_eq!(first.create(&grant(),1,&body,"create-1").unwrap(),created);
        assert_eq!(first.create(&grant(),1,&json!({"name":"different"}),"create-1"),Err(StoreError::IdempotencyConflict));
        let other = ObjectStore::open_in_memory("other-app").unwrap();
        assert_eq!(other.read(&grant(),&created.handle),Err(StoreError::ObjectUnavailable));
    }

    #[test]
    fn aliases_are_opt_in_stable_unique_and_deleted_aliases_stay_reserved() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let mut aliased = grant();
        aliased.allow_aliases = true;
        aliased.operations.push("readAlias".into());
        let body = json!({"name":"saved kit"});
        let object = store.create_with_alias(&aliased,1,&body,Some("ca_abc-123:legacy"),"create-alias").unwrap();
        assert_eq!(object.alias.as_deref(),Some("ca_abc-123:legacy"));
        assert_eq!(store.create_with_alias(&aliased,1,&body,Some("ca_abc-123:legacy"),"create-alias").unwrap(),object);
        assert_eq!(store.read_alias(&aliased,"ca_abc-123:legacy").unwrap(),object);
        assert_eq!(store.read(&aliased,&object.handle).unwrap().alias.as_deref(),Some("ca_abc-123:legacy"));
        let page = store.list(&aliased,1,None,2).unwrap();
        assert_eq!(page.objects[0].alias.as_deref(),Some("ca_abc-123:legacy"));
        assert_eq!(store.create_with_alias(&aliased,1,&body,Some("ca_abc-123:legacy"),"create-duplicate"),Err(StoreError::AliasConflict));
        store.delete(&aliased,&object.handle,1,"delete-alias").unwrap();
        let deleted = store.read_alias(&aliased,"ca_abc-123:legacy").unwrap();
        assert!(deleted.deleted);
        assert_eq!(deleted.revision,2);
        assert_eq!(store.create_with_alias(&aliased,1,&body,Some("ca_abc-123:legacy"),"create-after-delete"),Err(StoreError::AliasConflict));
        assert_eq!(store.read_alias(&aliased,"../private"),Err(StoreError::InvalidAlias));
        assert_eq!(store.read_alias(&aliased,"white space"),Err(StoreError::InvalidAlias));
    }

    #[test]
    fn list_by_aliases_returns_only_requested_objects_and_rejects_unbounded_filters() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let mut aliased = grant();
        aliased.allow_aliases = true;
        let first = store.create_with_alias(&aliased,1,&json!({"v":1}),Some("src_first"),"create-first").unwrap();
        let _second = store.create_with_alias(&aliased,1,&json!({"v":2}),Some("src_second"),"create-second").unwrap();
        let page = store.list_by_aliases(&aliased,1,&["src_second".into(),"missing".into()],2).unwrap();
        assert_eq!(page.objects.len(),1);
        assert_eq!(page.objects[0].alias.as_deref(),Some("src_second"));
        assert!(!page.has_more);
        assert_eq!(page.next_cursor,None);
        assert_eq!(store.list_by_aliases(&aliased,1,&["src_first".into(),"src_first".into()],2),Err(StoreError::InvalidAlias));
        assert_eq!(store.list_by_aliases(&aliased,1,&["../private".into()],1),Err(StoreError::InvalidAlias));
        assert_eq!(store.list_by_aliases(&aliased,1,&["src_first".into()],3),Err(StoreError::InvalidPage));
        assert_eq!(store.read(&aliased,&first.handle).unwrap().alias.as_deref(),Some("src_first"));
    }

    #[test]
    fn list_by_handles_reads_only_requested_objects_within_the_descriptor() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let grant = grant();
        let first = store.create(&grant,1,&json!({"value":1}),"create-handle-first").unwrap();
        let second = store.create(&grant,1,&json!({"value":2}),"create-handle-second").unwrap();
        let page = store.list_by_handles(&grant,1,std::slice::from_ref(&second.handle),1).unwrap();
        assert_eq!(page.objects.len(),1);
        assert_eq!(page.objects[0],second);
        assert!(!page.has_more);
        assert_eq!(store.list_by_handles(&grant,1,&[first.handle.clone(),first.handle.clone()],2),Err(StoreError::InvalidPage));
        assert_eq!(store.list_by_handles(&grant,1,&["ob_000000000000000000000000000000ff".into()],1).unwrap().objects.len(),0);
        let mut denied = grant.clone();
        denied.operations.retain(|operation| operation != "list");
        assert_eq!(store.list_by_handles(&denied,1,&[first.handle],1),Err(StoreError::InvalidGrant));
    }

    #[test]
    fn secondary_aliases_are_idempotent_conflict_safe_and_reserved_by_tombstones() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let mut aliased = grant();
        aliased.allow_aliases = true;
        aliased.operations.extend(["readAlias".into(), "attachAlias".into()]);
        let first = store.create(&aliased,1,&json!({"v":1}),"create-first").unwrap();
        let binding = store.attach_alias(&aliased,&first.handle,"src_legacy-1","attach-first").unwrap();
        assert_eq!(binding,AliasBinding { handle:first.handle.clone(),alias:"src_legacy-1".into() });
        assert_eq!(store.attach_alias(&aliased,&first.handle,"src_legacy-1","attach-retry").unwrap(),binding);
        assert_eq!(store.read_alias(&aliased,"src_legacy-1").unwrap().alias.as_deref(),Some("src_legacy-1"));
        assert_eq!(store.read(&aliased,&first.handle).unwrap().alias,None);
        assert_eq!(store.read(&aliased,&first.handle).unwrap().revision,1);

        let second = store.create(&aliased,1,&json!({"v":2}),"create-second").unwrap();
        assert_eq!(store.attach_alias(&aliased,&second.handle,"src_legacy-1","attach-conflict"),Err(StoreError::AliasConflict));
        store.delete(&aliased,&first.handle,1,"delete-first").unwrap();
        assert!(store.read_alias(&aliased,"src_legacy-1").unwrap().deleted);
        assert_eq!(store.attach_alias(&aliased,&first.handle,"src_legacy-1","attach-after-delete").unwrap(),binding);
        assert_eq!(store.attach_alias(&aliased,&first.handle,"src_after-delete","new-alias-after-delete"),Err(StoreError::ObjectDeleted));
        assert_eq!(store.attach_alias(&grant(),&second.handle,"src_denied","denied"),Err(StoreError::InvalidGrant));
    }

    #[test]
    fn additive_alias_table_migration_backfills_primary_aliases() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let mut aliased = grant();
        aliased.allow_aliases = true;
        aliased.operations.push("readAlias".into());
        let created = store.create_with_alias(&aliased,1,&json!({"v":1}),Some("src_primary"),"create-primary").unwrap();
        store.conn.execute_batch("DROP TABLE object_aliases").unwrap();
        ensure_alias_support(&mut store.conn).unwrap();
        assert_eq!(store.read_alias(&aliased,"src_primary").unwrap(),created);
        let primary: i64 = store.conn.query_row("SELECT is_primary FROM object_aliases WHERE object_type=?1 AND alias=?2",
            params![aliased.object_type,"src_primary"],|row| row.get(0)).unwrap();
        assert_eq!(primary,1);
    }

    #[test]
    fn aliases_are_denied_without_grant_and_isolated_by_plugin_and_object_type() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        assert_eq!(store.create_with_alias(&grant(),1,&json!({}),Some("ca_1"),"denied"),Err(StoreError::AliasDenied));
        assert_eq!(store.read_alias(&grant(),"ca_1"),Err(StoreError::InvalidGrant));
        let mut aliased = grant();
        aliased.allow_aliases = true;
        aliased.operations.push("readAlias".into());
        let created = store.create_with_alias(&aliased,1,&json!({"v":1}),Some("ca_same"),"first").unwrap();
        let mut other_type = aliased.clone(); other_type.object_type = "test.other:v1".into();
        let other_created = store.create_with_alias(&other_type,1,&json!({"v":2}),Some("ca_same"),"second").unwrap();
        assert_ne!(created.handle,other_created.handle);
        assert_eq!(store.read_alias(&other_type,"ca_same").unwrap().handle,other_created.handle);
        let other_plugin = ObjectStore::open_in_memory("second-app").unwrap();
        assert_eq!(other_plugin.read_alias(&aliased,"ca_same"),Err(StoreError::ObjectUnavailable));
    }

    #[test]
    fn file_store_reopen_keeps_alias_mapping_and_tombstone_reservation() {
        let home = std::env::temp_dir().join(format!("object-alias-reopen-{}-{}",std::process::id(),now_ms().unwrap()));
        let mut aliased = grant();
        aliased.allow_aliases = true;
        aliased.operations.push("readAlias".into());
        let created = {
            let mut store = ObjectStore::open(&home,"test-app").unwrap();
            store.create_with_alias(&aliased,1,&json!({"kit":"stored"}),Some("ca_stable-ref"),"create-stable").unwrap()
        };
        {
            let store = ObjectStore::open(&home,"test-app").unwrap();
            assert_eq!(store.read_alias(&aliased,"ca_stable-ref").unwrap(),created);
        }
        {
            let mut store = ObjectStore::open(&home,"test-app").unwrap();
            store.delete(&aliased,&created.handle,1,"delete-stable").unwrap();
        }
        let mut store = ObjectStore::open(&home,"test-app").unwrap();
        assert!(store.read_alias(&aliased,"ca_stable-ref").unwrap().deleted);
        assert_eq!(store.create_with_alias(&aliased,1,&json!({}),Some("ca_stable-ref"),"reuse-stable"),Err(StoreError::AliasConflict));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn additive_alias_migration_keeps_legacy_objects_and_create_idempotency() {
        let home = std::env::temp_dir().join(format!("object-alias-migration-{}-{}",std::process::id(),now_ms().unwrap()));
        let dir = home.join("state/plugin-objects/test-app");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("objects.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE generic_object_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
            INSERT INTO generic_object_schema(id,version) VALUES (1,1);
            CREATE TABLE objects(object_type TEXT NOT NULL,handle TEXT NOT NULL,schema_version INTEGER NOT NULL,revision INTEGER NOT NULL,
                body TEXT NOT NULL,deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(object_type,handle));
            CREATE TABLE operations(object_type TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,PRIMARY KEY(object_type,idempotency_key));
            CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,object_type TEXT NOT NULL,handle TEXT NOT NULL,event_id TEXT NOT NULL UNIQUE,
                revision INTEGER NOT NULL,event_type TEXT NOT NULL,body TEXT NOT NULL,created_at_ms INTEGER NOT NULL);
            CREATE INDEX events_object_sequence ON events(object_type,handle,sequence);
            CREATE TABLE scopes(scope_type TEXT NOT NULL,handle TEXT NOT NULL,revision INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,PRIMARY KEY(scope_type,handle));
            CREATE TABLE scope_members(scope_type TEXT NOT NULL,scope_handle TEXT NOT NULL,object_type TEXT NOT NULL,object_handle TEXT NOT NULL,
                PRIMARY KEY(scope_type,scope_handle,object_type,object_handle));
            CREATE INDEX scope_members_object ON scope_members(object_type,object_handle);
            INSERT INTO objects(object_type,handle,schema_version,revision,body,deleted,created_at_ms,updated_at_ms)
                VALUES('test.record:v1','ob_00000000000000000000000000000001',1,1,'{\"state\":\"saved\"}',0,10,10);").unwrap();
        let body = json!({"state":"saved"});
        let request_hash = hash_json(&json!({"op":"create","schemaVersion":1,"body":body})).unwrap();
        conn.execute("INSERT INTO operations(object_type,idempotency_key,request_hash,result_json,created_at_ms) VALUES (?1,?2,?3,?4,?5)",
            params!["test.record:v1","legacy-create",request_hash,
                r#"{"handle":"ob_00000000000000000000000000000001","schemaVersion":1,"revision":1,"body":{"state":"saved"},"deleted":false}"#,10]).unwrap();
        drop(conn);

        let first_home = home.clone();
        let second_home = home.clone();
        let first = std::thread::spawn(move || {
            let mut store = ObjectStore::open(&first_home,"test-app").unwrap();
            let legacy = store.read(&grant(),"ob_00000000000000000000000000000001").unwrap();
            let retry = store.create(&grant(),1,&json!({"state":"saved"}),"legacy-create").unwrap();
            (legacy,retry)
        });
        let second = std::thread::spawn(move || {
            let mut store = ObjectStore::open(&second_home,"test-app").unwrap();
            let legacy = store.read(&grant(),"ob_00000000000000000000000000000001").unwrap();
            let retry = store.create(&grant(),1,&json!({"state":"saved"}),"legacy-create").unwrap();
            (legacy,retry)
        });
        let (first_legacy,first_retry) = first.join().unwrap();
        let (second_legacy,second_retry) = second.join().unwrap();
        assert_eq!(first_legacy.body,body);
        assert_eq!(first_legacy.alias,None);
        assert_eq!(second_legacy,first_legacy);
        assert_eq!(first_retry,first_legacy);
        assert_eq!(second_retry,first_legacy);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn compare_and_swap_and_events_commit_atomically_and_retry_idempotently() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let created = store.create(&grant(),1,&json!({"state":"old"}),"create-1").unwrap();
        let events = [PendingEvent { event_type:"record.changed".into(),body:json!({"kind":"update"}) },
            PendingEvent { event_type:"record.reset".into(),body:json!({"kind":"reset"}) }];
        let committed = store.commit(&grant(),&created.handle,1,&json!({"state":"new"}),&events,"commit-1").unwrap();
        assert_eq!(committed.revision,2);
        assert_eq!(committed.event_ids.len(),2);
        assert_eq!(store.commit(&grant(),&created.handle,1,&json!({"state":"new"}),&events,"commit-1").unwrap(),committed);
        assert_eq!(store.read(&grant(),&created.handle).unwrap().body,json!({"state":"new"}));
        assert_eq!(store.commit(&grant(),&created.handle,1,&json!({"state":"stale"}),&[],"commit-stale"),Err(StoreError::RevisionConflict));
        assert_eq!(store.event_page(&grant(),&created.handle,None,2).unwrap().events.len(),2);
    }

    #[test]
    fn database_failure_during_event_append_rolls_back_object_revision_and_body() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let created = store.create(&grant(),1,&json!({"state":"old"}),"create-1").unwrap();
        store.conn.execute_batch("CREATE TRIGGER fail_event_insert BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'forced'); END;").unwrap();
        let events = [PendingEvent { event_type:"record.changed".into(),body:json!({"kind":"update"}) }];
        assert_eq!(store.commit(&grant(),&created.handle,1,&json!({"state":"new"}),&events,"commit-fail"),Err(StoreError::StorageUnavailable));
        let after = store.read(&grant(),&created.handle).unwrap();
        assert_eq!(after.revision,1);
        assert_eq!(after.body,json!({"state":"old"}));
        assert!(store.event_page(&grant(),&created.handle,None,2).unwrap().events.is_empty());
    }

    #[test]
    fn event_pages_use_object_scoped_cursor_and_are_bounded() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let created = store.create(&grant(),1,&json!({"v":0}),"c").unwrap();
        for revision in 1..=3 {
            let events = [PendingEvent { event_type:"record.changed".into(),body:json!({"n":revision}) }];
            store.commit(&grant(),&created.handle,revision,&json!({"v":revision}),&events,&format!("m{revision}")).unwrap();
        }
        let first = store.event_page(&grant(),&created.handle,None,2).unwrap();
        assert_eq!(first.events.len(),2);
        assert!(first.has_more);
        let second = store.event_page(&grant(),&created.handle,first.next_cursor.as_deref(),2).unwrap();
        assert_eq!(second.events.len(),1);
        assert!(!second.has_more);
        assert_eq!(store.event_page(&grant(),&created.handle,Some("ev_00000000000000000000000000000000"),2),Err(StoreError::InvalidCursor));
        assert_eq!(store.event_page(&grant(),&created.handle,None,3),Err(StoreError::InvalidPage));
    }

    #[test]
    fn grant_body_event_and_identifier_bounds_are_enforced() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        assert_eq!(store.create(&grant(),2,&json!({}),"bad-version"),Err(StoreError::InvalidSchemaVersion));
        assert_eq!(store.create(&grant(),1,&json!("not an object"),"bad-body"),Err(StoreError::InvalidBody));
        assert_eq!(store.create(&grant(),1,&json!({"blob":"x".repeat(3000)}),"large"),Err(StoreError::BodyTooLarge));
        let created = store.create(&grant(),1,&json!({}),"ok").unwrap();
        let ungranted = [PendingEvent { event_type:"arbitrary".into(),body:json!({}) }];
        assert_eq!(store.commit(&grant(),&created.handle,1,&json!({}),&ungranted,"event-denied"),Err(StoreError::InvalidEvent));
        let oversized = [PendingEvent { event_type:"record.changed".into(),body:json!({"blob":"x".repeat(600)}) }];
        assert_eq!(store.commit(&grant(),&created.handle,1,&json!({}),&oversized,"event-large"),Err(StoreError::EventTooLarge));
        let too_many = (0..5).map(|_| PendingEvent { event_type:"record.changed".into(),body:json!({}) }).collect::<Vec<_>>();
        assert_eq!(store.commit(&grant(),&created.handle,1,&json!({}),&too_many,"event-count"),Err(StoreError::EventLimit));
        let mut invalid = grant(); invalid.max_event_page = MAX_PAGE_SIZE + 1;
        assert_eq!(store.read(&invalid,&created.handle),Err(StoreError::InvalidGrant));
        assert!(matches!(ObjectStore::open_in_memory("../outside"),Err(StoreError::InvalidPluginId)));
        let mut limited = grant(); limited.max_objects = 1;
        let mut capped = ObjectStore::open_in_memory("limited-app").unwrap();
        capped.create(&limited,1,&json!({}),"one").unwrap();
        assert_eq!(capped.create(&limited,1,&json!({}),"two"),Err(StoreError::ObjectLimit));
    }

    #[test]
    fn per_grant_total_storage_and_event_count_caps_are_enforced() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let mut small = grant();
        small.max_object_bytes = 1000;
        small.max_total_bytes = 1100;
        let body = json!({"blob":"x".repeat(700)});
        let first = store.create(&small,1,&body,"first").unwrap();
        assert_eq!(store.create(&small,1,&body,"second"),Err(StoreError::StoreLimit));
        let mut one_event = grant();
        one_event.max_events_per_object = 1;
        one_event.max_events_per_commit = 1;
        let created = store.create(&one_event,1,&json!({}),"event-object").unwrap();
        let events = [PendingEvent { event_type:"record.changed".into(),body:json!({}) }];
        store.commit(&one_event,&created.handle,1,&json!({"one":1}),&events,"event-1").unwrap();
        assert_eq!(store.commit(&one_event,&created.handle,2,&json!({"two":2}),&events,"event-2"),Err(StoreError::EventLimit));
        assert_eq!(store.read(&small,&first.handle).unwrap().revision,1);
    }

    #[test]
    fn object_listing_is_page_bounded_scoped_and_includes_tombstones() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let mut g = grant();
        g.max_list_page = 2;
        let a = store.create(&g,1,&json!({"n":1}),"a").unwrap();
        let b = store.create(&g,1,&json!({"n":2}),"b").unwrap();
        let c = store.create(&g,1,&json!({"n":3}),"c").unwrap();
        store.delete(&g,&b.handle,1,"delete-b").unwrap();
        let first = store.list(&g,1,None,2).unwrap();
        assert_eq!(first.objects.len(),2);
        assert!(first.has_more);
        let second = store.list(&g,1,first.next_cursor.as_deref(),2).unwrap();
        assert_eq!(second.objects.len(),1);
        assert!(!second.has_more);
        let objects = first.objects.iter().chain(&second.objects).collect::<Vec<_>>();
        assert!(objects.iter().any(|object| object.handle == b.handle && object.deleted));
        assert!(objects.iter().any(|object| object.handle == a.handle));
        assert!(objects.iter().any(|object| object.handle == c.handle));
        assert_eq!(store.list(&g,1,Some("ob_00000000000000000000000000000000"),2),Err(StoreError::InvalidCursor));
        assert_eq!(store.list(&g,2,None,2),Err(StoreError::InvalidSchemaVersion));
    }

    #[test]
    fn delete_uses_cas_idempotency_and_keeps_references_readable_as_tombstones() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let g = grant();
        let object = store.create(&g,1,&json!({"keep":"body"}),"create").unwrap();
        let deleted = store.delete(&g,&object.handle,1,"delete-1").unwrap();
        assert_eq!(deleted,DeleteResult { revision:2,deleted:true });
        assert_eq!(store.delete(&g,&object.handle,1,"delete-1").unwrap(),deleted);
        assert_eq!(store.delete(&g,&object.handle,1,"delete-stale"),Err(StoreError::ObjectDeleted));
        assert_eq!(store.delete(&g,&object.handle,2,"delete-again"),Err(StoreError::ObjectDeleted));
        let read = store.read(&g,&object.handle).unwrap();
        assert!(read.deleted);
        assert_eq!(read.body,json!({"keep":"body"}));
    }

    fn scope_grant(object_type: &str) -> ScopeGrant {
        ScopeGrant { scope_type:"test.save:v1".into(),operations:vec!["read".into(),"commit".into()],
            object_types:vec![object_type.into()],max_scopes:8,max_members:4 }
    }

    #[test]
    fn scopes_are_plugin_and_scope_type_scoped_cas_memberships_with_deleted_refs() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let g = grant();
        let grants = BTreeMap::from([(g.object_type.clone(),g.clone())]);
        let object = store.create(&g,1,&json!({"n":1}),"object").unwrap();
        let scope_grant = scope_grant(&g.object_type);
        let members = [ScopeMemberRef { object_type:g.object_type.clone(),handle:object.handle.clone() }];
        let created = store.commit_scope(&scope_grant,"test.save:v1",None,0,&members,"scope-create",&grants).unwrap();
        assert_eq!(created.revision,1);
        assert_eq!(store.commit_scope(&scope_grant,"test.save:v1",None,0,&members,"scope-create",&grants).unwrap(),created);
        assert_eq!(store.read_scope(&scope_grant,"test.save:v1",&created.scope_handle,&grants).unwrap().members.len(),1);
        assert_eq!(store.commit_scope(&scope_grant,"test.save:v1",Some(&created.scope_handle),0,&[],"stale",&grants),Err(StoreError::RevisionConflict));
        let denied = store.commit_scope(&scope_grant,"other.save:v1",None,0,&members,"other",&grants);
        assert_eq!(denied,Err(StoreError::InvalidGrant));
        store.delete(&g,&object.handle,1,"delete").unwrap();
        let after_delete = store.read_scope(&scope_grant,"test.save:v1",&created.scope_handle,&grants).unwrap();
        assert!(after_delete.members[0].deleted);
        let other = ObjectStore::open_in_memory("other-app").unwrap();
        assert_eq!(other.read_scope(&scope_grant,"test.save:v1",&created.scope_handle,&grants),Err(StoreError::ScopeUnavailable));
    }

    #[test]
    fn failed_scope_membership_transaction_keeps_old_revision_and_members() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let g = grant();
        let grants = BTreeMap::from([(g.object_type.clone(),g.clone())]);
        let object = store.create(&g,1,&json!({}),"object").unwrap();
        let scope_grant = scope_grant(&g.object_type);
        let created = store.commit_scope(&scope_grant,"test.save:v1",None,0,&[],"scope-create",&grants).unwrap();
        store.conn.execute_batch("CREATE TRIGGER fail_scope_member BEFORE INSERT ON scope_members BEGIN SELECT RAISE(ABORT,'forced'); END;").unwrap();
        let member = [ScopeMemberRef { object_type:g.object_type.clone(),handle:object.handle }];
        assert_eq!(store.commit_scope(&scope_grant,"test.save:v1",Some(&created.scope_handle),1,&member,"scope-update",&grants),Err(StoreError::StorageUnavailable));
        let after = store.read_scope(&scope_grant,"test.save:v1",&created.scope_handle,&grants).unwrap();
        assert_eq!(after.revision,1);
        assert!(after.members.is_empty());
    }

    #[test]
    fn scope_read_keeps_revision_members_and_object_metadata_on_one_sqlite_snapshot() {
        let home = std::env::temp_dir().join(format!("scope-snapshot-{}-{}",std::process::id(),now_ms().unwrap()));
        let mut reader = ObjectStore::open(&home,"test-app").unwrap();
        let g = grant();
        let first = reader.create(&g,1,&json!({"value":"first"}),"first").unwrap();
        let second = reader.create(&g,1,&json!({"value":"second"}),"second").unwrap();
        let grants = BTreeMap::from([(g.object_type.clone(),g.clone())]);
        let scope_grant = scope_grant(&g.object_type);
        let created = reader.commit_scope(&scope_grant,"test.save:v1",None,0,
            &[ScopeMemberRef{object_type:g.object_type.clone(),handle:first.handle.clone()}],"scope-create",&grants).unwrap();
        let mut writer = ObjectStore::open(&home,"test-app").unwrap();
        let snapshot = reader.read_scope_with_hook(&scope_grant,"test.save:v1",&created.scope_handle,&grants,|| {
            writer.commit_scope(&scope_grant,"test.save:v1",Some(&created.scope_handle),1,
                &[ScopeMemberRef{object_type:g.object_type.clone(),handle:second.handle.clone()}],"scope-update",&grants).unwrap();
        }).unwrap();
        assert_eq!(snapshot.revision,1);
        assert_eq!(snapshot.members.len(),1);
        assert_eq!(snapshot.members[0].handle,first.handle);
        let current = reader.read_scope(&scope_grant,"test.save:v1",&created.scope_handle,&grants).unwrap();
        assert_eq!(current.revision,2);
        assert_eq!(current.members.len(),1);
        assert_eq!(current.members[0].handle,second.handle);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn file_store_reopens_and_keeps_plugin_directories_separate() {
        let unique = random_token("case_").unwrap();
        let home = std::env::temp_dir().join(format!("generic-object-store-{unique}"));
        let mut store = ObjectStore::open(&home,"test-app").unwrap();
        let created = store.create(&grant(),1,&json!({"persisted":true}),"create").unwrap();
        drop(store);
        let reopened = ObjectStore::open(&home,"test-app").unwrap();
        assert_eq!(reopened.read(&grant(),&created.handle).unwrap().body,json!({"persisted":true}));
        assert!(ObjectStore::open(&home,"other-app").unwrap().read(&grant(),&created.handle).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn stable_source_refs_survive_reopen_and_fail_closed_after_same_length_key_corruption() {
        let unique = random_token("case_").unwrap();
        let home = std::env::temp_dir().join(format!("generic-stable-ref-{unique}"));
        let source_keys = vec!["private-source-a".to_owned(), "private-source-b".to_owned()];
        let mut store = ObjectStore::open(&home,"test-app").unwrap();
        let first = store.stable_source_refs("harness-sessions:v4",&source_keys,10).unwrap();
        assert!(first.iter().all(|reference| reference.starts_with("srp_") && reference.len()==36));
        assert_eq!(store.match_stable_source_refs("harness-sessions:v4",&source_keys,&[first[1].clone()]).unwrap(),
            vec![None,Some(first[1].clone())]);
        assert_eq!(store.match_stable_source_refs("harness-sessions:v4",&["unknown-source".into()],&first).unwrap(),vec![None]);
        let persisted: String = store.conn.query_row("SELECT group_concat(source_hash||':'||opaque_ref) FROM stable_source_refs",[],|row| row.get(0)).unwrap();
        assert!(!persisted.contains("private-source-a"));
        assert!(!persisted.contains("private-source-b"));
        drop(store);
        let mut reopened = ObjectStore::open(&home,"test-app").unwrap();
        assert_eq!(reopened.stable_source_refs("harness-sessions:v4",&source_keys,10).unwrap(),first);
        reopened.conn.execute("UPDATE stable_ref_keys SET secret=zeroblob(32) WHERE dataset_id='harness-sessions:v4'",[]).unwrap();
        assert_eq!(reopened.stable_source_refs("harness-sessions:v4",&source_keys,10),Err(StoreError::StableRefUnavailable));
        assert_eq!(reopened.match_stable_source_refs("harness-sessions:v4",&source_keys,&first),Err(StoreError::StableRefUnavailable));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn stable_source_refs_are_partitioned_by_dataset_and_bounded() {
        let mut store = ObjectStore::open_in_memory("test-app").unwrap();
        let keys = vec!["private-source".to_owned()];
        let first = store.stable_source_refs("harness-sessions:v4",&keys,1).unwrap();
        let second = store.stable_source_refs("another-dataset:v1",&keys,1).unwrap();
        assert_ne!(first,second);
        assert_eq!(store.stable_source_refs("harness-sessions:v4",&keys,0),Err(StoreError::InvalidStableRefRequest));
        assert_eq!(store.stable_source_refs("harness-sessions:v4",&keys,0),Err(StoreError::InvalidStableRefRequest));
        assert_eq!(store.stable_source_refs("harness-sessions:v4",&[keys[0].clone(),keys[0].clone()],2),Err(StoreError::InvalidStableRefRequest));
    }
}
