use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use agent_vitals_data::authority::{AuthorityDb, AuthorityError, revision_of};
use agent_vitals_data::extension_authority::{activate, ActivationAction, ExtensionRevision, RevisionOrigin};
use agent_vitals_data::fact_writer_sql::{ExtensionFactContext, SqlFactWriter, SqlInsertReport};
use serde_json::{json, Value};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Database(PathBuf);
impl Database {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("vitals-extension-writer-{}-{}.sqlite3",
            std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))))
    }
    fn open(&self) -> AuthorityDb {
        let db = AuthorityDb::open(&self.0, 10).unwrap();
        db.begin_run("run", "cli", 10).unwrap();
        db
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(format!("{}-wal", self.0.display()));
        let _ = std::fs::remove_file(format!("{}-shm", self.0.display()));
    }
}
fn activate_revision(db: &AuthorityDb, expected: i64, id: &str) -> i64 {
    activate_revision_with_origin(db, expected, id, RevisionOrigin::Local)
}
fn activate_revision_with_origin(db: &AuthorityDb, expected: i64, id: &str, origin: RevisionOrigin) -> i64 {
    let revision = ExtensionRevision { revision_id: id.into(), slot_type: "harness_manifest".into(),
        slot_id: "zcode".into(), content_sha256: "a".repeat(64), origin,
        schema_version: 1, capabilities: json!({}), installed_at_ms: 10 };
    activate(db.conn(), expected, &[revision],
        &BTreeMap::from([(("harness_manifest".into(), "zcode".into()), id.into())]),
        &"b".repeat(64), ActivationAction::Activate, 10).unwrap()
}
fn context(generation: i64, id: &str) -> ExtensionFactContext {
    ExtensionFactContext { generation, revision_id: id.into(), engine_version: "1.4.0".into() }
}
fn fact(id: &str) -> Value {
    json!({"fact_id": id, "harness": "harness:zcode", "machine_namespace": "machine",
        "source_profile": "default", "native_session_id": "session", "source_event_id": id,
        "observation_kind": "token_count", "event_ts_utc": "2026-09-05T10:00:00.000Z",
        "model_id": "claude-opus-4", "uncached_input_tokens": 100, "cache_read_tokens": 50,
        "cache_write_tokens": 10, "output_tokens": 5})
}
fn stored_id(event: &str) -> String {
    agent_vitals_domain::usage_fact::fact_id("machine", "harness:zcode", "default",
        "session", event, "token_count")
}
fn write(db: &AuthorityDb, facts: &[Value], provenance: Option<&ExtensionFactContext>)
    -> Result<SqlInsertReport, AuthorityError> {
    db.with_immediate_txn(|conn| {
        let writer = SqlFactWriter::new(conn, "run", 20)?;
        let source = writer.upsert_source_file("harness:zcode", Path::new("/fixture/zcode.jsonl"),
            100, 1, Some("session"), 1)?;
        writer.upsert_session("harness:zcode", "machine", "session", Some("default"), 20)?;
        writer.insert_facts_with_extension(facts, &source, "session", provenance)
    })
}
fn count(db: &AuthorityDb, table: &str) -> i64 {
    db.conn().query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap()
}

#[test]
fn extension_write_outside_transaction_rejects_before_inserting() {
    let path = Database::new(); let db = path.open();
    let generation = activate_revision(&db, 0, "first");
    db.with_immediate_txn(|conn| {
        let writer = SqlFactWriter::new(conn, "run", 20)?;
        writer.upsert_batch_source("harness:zcode")?;
        writer.upsert_session("harness:zcode", "machine", "session", Some("default"), 20)
    }).unwrap();
    let writer = SqlFactWriter::new(db.conn(), "run", 20).unwrap();
    assert!(writer.insert_facts_with_extension(&[fact("outside")],
        &writer.upsert_batch_source("harness:zcode").unwrap(), "session",
        Some(&context(generation, "first"))).is_err());
    assert_eq!(count(&db, "usage_facts"), 0);
    assert_eq!(count(&db, "extension_fact_provenance"), 0);
}

#[test]
fn inserted_fact_and_provenance_commit_together() {
    let path = Database::new(); let db = path.open();
    let generation = activate_revision(&db, 0, "first");
    let before = revision_of(db.conn()).unwrap();
    let report = write(&db, &[fact("new")], Some(&context(generation, "first"))).unwrap();
    assert_eq!((report.inserted, report.duplicate, report.rejected), (1, 0, 0));
    let provenance: (String, i64, String, String) = db.conn().query_row(
        "SELECT fact_id,generation,revision_id,engine_version FROM extension_fact_provenance",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap();
    assert_eq!(provenance, (stored_id("new"), generation, "first".into(), "1.4.0".into()));
    assert_eq!(revision_of(db.conn()).unwrap(), before + 1);
}

#[test]
fn duplicate_replay_keeps_original_generation_and_revision() {
    let path = Database::new(); let db = path.open();
    let first = activate_revision(&db, 0, "first");
    write(&db, &[fact("same")], Some(&context(first, "first"))).unwrap();
    let second = activate_revision(&db, first, "second");
    let report = write(&db, &[fact("same")], Some(&context(second, "second"))).unwrap();
    assert_eq!((report.inserted, report.duplicate), (0, 1));
    assert_eq!(count(&db, "usage_facts"), 1);
    assert_eq!(count(&db, "extension_fact_provenance"), 1);
    let retained: (i64, String) = db.conn().query_row(
        "SELECT generation,revision_id FROM extension_fact_provenance", [],
        |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(retained, (first, "first".into()));
}

#[test]
fn historical_duplicate_without_provenance_is_not_reclassified() {
    let path = Database::new(); let db = path.open();
    write(&db, &[fact("historical")], None).unwrap();
    let generation = activate_revision_with_origin(&db, 0, "reviewed-now",
        RevisionOrigin::VendorCatalog { source: "MixLabPro/agent-vitals".into(),
            commit: "c".repeat(40), index_sha256: "d".repeat(64) });
    let report = write(&db, &[fact("historical")], Some(&context(generation, "reviewed-now"))).unwrap();
    assert_eq!((report.inserted, report.duplicate), (0, 1));
    assert_eq!(count(&db, "usage_facts"), 1);
    assert_eq!(count(&db, "extension_fact_provenance"), 0);
}

#[test]
fn invalid_provenance_rolls_back_fact_source_session_and_revision() {
    let path = Database::new(); let db = path.open();
    activate_revision(&db, 0, "first");
    let before = revision_of(db.conn()).unwrap();
    assert!(write(&db, &[fact("bad")], Some(&context(0, "first"))).is_err());
    for table in ["usage_facts", "extension_fact_provenance", "source_files", "sessions"] {
        assert_eq!(count(&db, table), 0, "{table} must roll back with the failed provenance link");
    }
    assert_eq!(revision_of(db.conn()).unwrap(), before);
    assert_eq!(write(&db, &[fact("bad")], Some(&context(1, "first"))).unwrap().inserted, 1);
}
