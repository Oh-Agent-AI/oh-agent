use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use agent_vitals_data::authority::AuthorityDb;
use agent_vitals_data::extension_authority::{self, ActivationAction, ExtensionError, ExtensionRevision, RevisionOrigin, SlotMap};
use agent_vitals_ingest::ingest::extension_installer::{
    self, InstallError, PreviewTicket, REGISTRY_SNAPSHOT_SCHEMA,
};
use agent_vitals_runtime_core::core::extension_objects::ObjectStore;
use sha2::{Digest, Sha256};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temporary(PathBuf);
impl Temporary {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("vitals-installer-{}-{}-{}", tag, std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Database(PathBuf);
impl Database {
    fn new() -> Self { Self(std::env::temp_dir().join(format!("vitals-installer-db-{}-{}.sqlite3", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))) }
    fn open(&self) -> AuthorityDb { AuthorityDb::open(&self.0, 10).unwrap() }
}
impl Drop for Database {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let _ = fs::remove_file(format!("{}-wal", self.0.display()));
        let _ = fs::remove_file(format!("{}-shm", self.0.display()));
    }
}

fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

struct Fixture {
    db_home: Database,
    store_home: Temporary,
    data_home: Temporary,
}
impl Fixture {
    fn new() -> (Self, AuthorityDb, ObjectStore) {
        let fixture = Self { db_home: Database::new(), store_home: Temporary::new("store"), data_home: Temporary::new("data") };
        let db = fixture.db_home.open();
        let store = ObjectStore::open(&fixture.store_home.0).unwrap();
        (fixture, db, store)
    }
}

/// stage → install → revision(ticket) 的完整原料；payload 必须是合法 JSON。
fn revision(id: &str, origin: RevisionOrigin, store: &ObjectStore, payload: &[u8]) -> ExtensionRevision {
    let staged = store.stage(payload).unwrap();
    store.install(Path::new(&staged), &digest(payload)).unwrap();
    ExtensionRevision {
        revision_id: id.to_string(),
        slot_type: "harness_manifest".to_string(),
        slot_id: "zcode".to_string(),
        content_sha256: digest(payload),
        origin,
        schema_version: 1,
        capabilities: serde_json::json!({}),
        installed_at_ms: 10,
    }
}
fn slot_map(id: &str) -> SlotMap {
    BTreeMap::from([(("harness_manifest".to_string(), "zcode".to_string()), id.to_string())])
}
fn ticket(expected: i64, revisions: Vec<ExtensionRevision>, map: SlotMap) -> PreviewTicket {
    PreviewTicket { expected_generation: expected, engine_version: "1.4.0".to_string(), action: ActivationAction::Activate, new_revisions: revisions, target_map: map, local_input: None }
}

#[test]
fn preview_hash_binds_vendor_capabilities_and_unambiguous_slot_fields() {
    let (_fixture, _db, store) = Fixture::new();
    let vendor = revision("vendor", RevisionOrigin::VendorCatalog {
        source:"catalog".into(), commit:"b".repeat(40), index_sha256:"c".repeat(64),
    }, &store, br#"{"manifest_version":1}"#);
    let original = ticket(0, vec![vendor], slot_map("vendor"));
    let hash = original.preview_sha256();
    let mut changed = original.clone();
    changed.new_revisions[0].origin = RevisionOrigin::VendorCatalog {
        source:"different-catalog".into(), commit:"b".repeat(40), index_sha256:"c".repeat(64),
    };
    assert_ne!(changed.preview_sha256(), hash);
    for (commit, index_sha256) in [("d".repeat(40), "c".repeat(64)), ("b".repeat(40), "d".repeat(64))] {
        changed = original.clone();
        changed.new_revisions[0].origin = RevisionOrigin::VendorCatalog {
            source:"catalog".into(), commit, index_sha256,
        };
        assert_ne!(changed.preview_sha256(), hash);
    }
    changed = original.clone();
    changed.new_revisions[0].capabilities = serde_json::json!({"features":["changed"]});
    assert_ne!(changed.preview_sha256(), hash);
    let mut left = ticket(0, vec![], BTreeMap::from([(("a\tb".into(), "c".into()), "r".into())]));
    let right = ticket(0, vec![], BTreeMap::from([(("a".into(), "b\tc".into()), "r".into())]));
    assert_ne!(left.preview_sha256(), right.preview_sha256(), "field separators must not alias tickets");
    left.new_revisions = original.new_revisions.clone();
    left.new_revisions[0].capabilities = serde_json::from_str(r#"{"b":{"y":2,"x":1},"a":0}"#).unwrap();
    let mut reordered = left.clone();
    reordered.new_revisions[0].capabilities = serde_json::from_str(r#"{"a":0,"b":{"x":1,"y":2}}"#).unwrap();
    assert_eq!(left.preview_sha256(), reordered.preview_sha256());
}

#[test]
fn lifecycle_commit_rollback_uninstall_and_derived_snapshot() {
    let (fixture, db, store) = Fixture::new();
    let local = revision("local-1", RevisionOrigin::Local, &store, br#"{"slot":"zcode-local"}"#);
    let vendor = revision("vendor-1", RevisionOrigin::VendorCatalog {
        source: "MixLabPro/agent-vitals".to_string(), commit: "b".repeat(40), index_sha256: "c".repeat(64),
    }, &store, br#"{"slot":"zcode-vendor"}"#);

    // gen1：local 激活。
    assert_eq!(extension_installer::commit(&db, &store, &ticket(0, vec![local.clone()], slot_map("local-1")), 20).unwrap(), 1);
    // gen2：vendor 替换 local。
    assert_eq!(extension_installer::commit(&db, &store, &ticket(1, vec![vendor], slot_map("vendor-1")), 30).unwrap(), 2);
    // 回滚到 gen1：不重复登记 revision，映射恢复。
    assert_eq!(extension_installer::rollback_to(&db, &store, 1, "1.4.0", 40).unwrap(), 3);
    assert_eq!(extension_authority::generation_slots(db.conn(), 3).unwrap(), slot_map("local-1"));
    let count: i64 = db.conn().query_row("SELECT COUNT(*) FROM extension_revisions", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 2, "rollback must not re-register revisions");
    let action: String = db.conn().query_row("SELECT action FROM extension_activations WHERE generation=3", [], |r| r.get(0)).unwrap();
    assert_eq!(action, "rollback");

    // 卸载：空映射，历史保留。
    assert_eq!(extension_installer::uninstall_all(&db, &store, "1.4.0", 50).unwrap(), 4);
    assert!(extension_authority::generation_slots(db.conn(), 4).unwrap().is_empty());
    let count: i64 = db.conn().query_row("SELECT COUNT(*) FROM extension_revisions", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 2, "uninstall keeps revision history");

    // 派生快照：重建自 authority，删除/损坏后可恢复，且内容反映当前 generation。
    extension_installer::rebuild_registry_snapshot(&fixture.data_home.0, &db, 60).unwrap();
    let snapshot_path = fixture.data_home.0.join("catalog").join("registry.json");
    let snapshot: serde_json::Value = serde_json::from_str(&fs::read_to_string(&snapshot_path).unwrap()).unwrap();
    assert_eq!(snapshot["schema"], REGISTRY_SNAPSHOT_SCHEMA);
    assert_eq!(snapshot["generation"], 4);
    assert_eq!(snapshot["slots"].as_array().unwrap().len(), 0);
    // 重新激活后快照跟上市面状态。
    assert_eq!(extension_installer::commit(&db, &store, &ticket(4, vec![], slot_map("local-1")), 70).unwrap(), 5);
    extension_installer::rebuild_registry_snapshot(&fixture.data_home.0, &db, 80).unwrap();
    fs::write(&snapshot_path, b"corrupt").unwrap();
    extension_installer::rebuild_registry_snapshot(&fixture.data_home.0, &db, 90).unwrap();
    let snapshot: serde_json::Value = serde_json::from_str(&fs::read_to_string(&snapshot_path).unwrap()).unwrap();
    assert_eq!(snapshot["generation"], 5);
    let slots = snapshot["slots"].as_array().unwrap();
    assert_eq!(slots.len(), 1);
    assert_eq!(slots[0]["revision_id"], "local-1");
    assert_eq!(slots[0]["origin"], "local");
}

#[test]
fn stale_ticket_is_rejected_after_a_concurrent_activation() {
    let (fixture, db, store) = Fixture::new();
    let _ = fixture;
    let local = revision("local-1", RevisionOrigin::Local, &store, br#"{"a":1}"#);
    let vendor = revision("vendor-1", RevisionOrigin::VendorCatalog {
        source: "MixLabPro/agent-vitals".to_string(), commit: "b".repeat(40), index_sha256: "c".repeat(64),
    }, &store, br#"{"b":2}"#);
    let first = ticket(0, vec![local], slot_map("local-1"));
    let second = ticket(0, vec![vendor], slot_map("vendor-1"));
    assert_eq!(extension_installer::commit(&db, &store, &first, 20).unwrap(), 1);
    assert!(matches!(
        extension_installer::commit(&db, &store, &second, 21),
        Err(InstallError::Ledger(ExtensionError::StaleGeneration { expected: 0, actual: 1 }))
    ));
    assert_eq!(extension_authority::current_generation(db.conn()).unwrap(), 1);
    assert_eq!(extension_authority::generation_slots(db.conn(), 1).unwrap(), slot_map("local-1"));
}

#[test]
fn tampered_or_missing_object_blocks_commit_and_generation_is_untouched() {
    let (fixture, db, store) = Fixture::new();
    let _ = fixture;
    let local = revision("local-1", RevisionOrigin::Local, &store, br#"{"stable":true}"#);
    assert_eq!(extension_installer::commit(&db, &store, &ticket(0, vec![local.clone()], slot_map("local-1")), 20).unwrap(), 1);
    let payload_path = fixture.store_home.0.join("objects").join(local.content_sha256).join("payload.json");

    // 篡改对象：引用它的下一张 ticket 必须被拒。
    fs::write(&payload_path, b"{}").unwrap();
    let reactivate = ticket(1, vec![], slot_map("local-1"));
    assert!(matches!(extension_installer::commit(&db, &store, &reactivate, 30), Err(InstallError::Object("object_hash"))));
    assert_eq!(extension_authority::current_generation(db.conn()).unwrap(), 1);

    // 对象整目录消失：同样拒绝，且不影响既有 generation。
    fs::remove_file(&payload_path).unwrap();
    fs::remove_dir(payload_path.parent().unwrap()).unwrap();
    assert!(matches!(extension_installer::commit(&db, &store, &reactivate, 31), Err(InstallError::Object(_))));
    assert_eq!(extension_authority::current_generation(db.conn()).unwrap(), 1);
}

#[test]
fn unknown_revision_missing_object_for_new_revision_and_empty_engine_are_rejected() {
    let (fixture, db, store) = Fixture::new();
    let _ = fixture;
    // 映射引用了既不在 ticket 也不在台账里的 revision。
    let unknown = ticket(0, vec![], slot_map("ghost"));
    assert!(matches!(
        extension_installer::commit(&db, &store, &unknown, 20),
        Err(InstallError::UnknownRevision { revision_id }) if revision_id == "ghost"
    ));
    // 新 revision 声明的哈希没有对应已安装对象：发布前即拒绝。
    let mut orphan = revision("orphan", RevisionOrigin::Local, &store, br#"{"c":3}"#);
    let staged = store.stage(br#"{"different":true}"#).unwrap();
    store.install(std::path::Path::new(&staged), &digest(br#"{"different":true}"#)).unwrap();
    orphan.content_sha256 = digest(br#"{"never-installed":true}"#);
    assert!(matches!(
        extension_installer::commit(&db, &store, &ticket(0, vec![orphan], slot_map("orphan")), 21),
        Err(InstallError::Object(_))
    ));
    assert_eq!(extension_authority::current_generation(db.conn()).unwrap(), 0);
    // 空引擎版本：预览绑定不成立。
    let mut empty_engine = ticket(0, vec![], SlotMap::new());
    empty_engine.engine_version = "  ".to_string();
    assert!(matches!(
        extension_installer::commit(&db, &store, &empty_engine, 22),
        Err(InstallError::Ledger(ExtensionError::Invalid("empty engine version")))
    ));
}
