use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use agent_vitals_data::authority::{AuthorityDb, begin_immediate, commit_advancing_revision, revision_of, SCHEMA_VERSION};
use agent_vitals_data::extension_authority::*;
use rusqlite::params;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Database(PathBuf);
impl Database {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("vitals-extension-{}-{}.sqlite3",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed))))
    }
    fn open(&self) -> AuthorityDb { AuthorityDb::open(&self.0,10).unwrap() }
}
impl Drop for Database {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(format!("{}-wal",self.0.display()));
        let _ = std::fs::remove_file(format!("{}-shm",self.0.display()));
    }
}
fn revision(id: &str, origin: RevisionOrigin) -> ExtensionRevision {
    ExtensionRevision { revision_id:id.into(),slot_type:"harness_manifest".into(),slot_id:"zcode".into(),
        content_sha256:"a".repeat(64),origin,schema_version:1,capabilities:serde_json::json!({}),installed_at_ms:10 }
}
fn slots(id: &str) -> SlotMap { BTreeMap::from([(("harness_manifest".into(),"zcode".into()),id.into())]) }

#[test]
fn fresh_and_v27_upgrade_have_identical_extension_state() {
    let path = Database::new();
    let db = path.open();
    assert_eq!(current_generation(db.conn()).unwrap(),0);
    db.conn().execute_batch("DROP TABLE extension_fact_provenance; DROP TABLE extension_active;
        DROP TABLE extension_activation_slots; DROP TABLE extension_activations; DROP TABLE extension_revisions;
        UPDATE schema_meta SET value='27' WHERE key='schema_version';").unwrap();
    drop(db);
    let db = path.open();
    assert_eq!(current_generation(db.conn()).unwrap(),0);
    let version: String = db.conn().query_row("SELECT value FROM schema_meta WHERE key='schema_version'",[],|r|r.get(0)).unwrap();
    assert_eq!(version,SCHEMA_VERSION.to_string());
    assert!(generation_slots(db.conn(),0).unwrap().is_empty());
}

#[test]
fn same_content_origins_are_distinct_and_stale_connections_cannot_activate() {
    let path = Database::new(); let first = path.open(); let second = path.open();
    let local = revision("local",RevisionOrigin::Local);
    let vendor = revision("vendor",RevisionOrigin::VendorCatalog { source:"MixLabPro/agent-vitals-catalog".into(),commit:"b".repeat(40),index_sha256:"c".repeat(64) });
    let before = revision_of(first.conn()).unwrap();
    assert_eq!(activate(first.conn(),0,&[local,vendor],&slots("vendor"),&"d".repeat(64),ActivationAction::Activate,20).unwrap(),1);
    assert_eq!(revision_of(first.conn()).unwrap(),before+1);
    assert!(matches!(activate(second.conn(),0,&[],&slots("local"),&"d".repeat(64),ActivationAction::Activate,21),Err(ExtensionError::StaleGeneration { actual:1,.. })));
    assert_eq!(generation_slots(second.conn(),1).unwrap(),slots("vendor"));
    assert_eq!(activate(second.conn(),1,&[],&slots("local"),&"d".repeat(64),ActivationAction::Rollback,22).unwrap(),2);
    assert_eq!(generation_slots(first.conn(),1).unwrap(),slots("vendor"));
    assert_eq!(generation_slots(first.conn(),2).unwrap(),slots("local"));
    assert_eq!(activate(first.conn(),2,&[],&SlotMap::new(),&"d".repeat(64),ActivationAction::Uninstall,23).unwrap(),3);
    assert!(generation_slots(first.conn(),3).unwrap().is_empty());
    let count:i64=first.conn().query_row("SELECT COUNT(*) FROM extension_revisions",[],|r|r.get(0)).unwrap();
    assert_eq!(count,2);
    assert!(first.conn().execute("UPDATE extension_revisions SET origin='local' WHERE revision_id='vendor'",[]).is_err());
    assert!(first.conn().execute("DELETE FROM extension_revisions WHERE revision_id='local'",[]).is_err());
}

#[test]
fn invalid_activation_rolls_back_revisions_mapping_pointer_and_authority_revision() {
    let path = Database::new(); let db = path.open(); let before = revision_of(db.conn()).unwrap();
    assert!(activate(db.conn(),0,&[revision("orphan",RevisionOrigin::Local)],&slots("missing"),&"d".repeat(64),ActivationAction::Activate,20).is_err());
    assert_eq!(current_generation(db.conn()).unwrap(),0);
    assert_eq!(revision_of(db.conn()).unwrap(),before);
    let count:i64=db.conn().query_row("SELECT COUNT(*) FROM extension_revisions",[],|r|r.get(0)).unwrap();
    assert_eq!(count,0);
    let mut bad=revision("bad",RevisionOrigin::Local); bad.content_sha256="a".repeat(16);
    assert!(activate(db.conn(),0,&[bad],&slots("bad"),&"d".repeat(64),ActivationAction::Activate,20).is_err());
    let bad=revision("bad",RevisionOrigin::VendorCatalog { source:"catalog".into(),commit:"main".into(),index_sha256:"c".repeat(64) });
    assert!(activate(db.conn(),0,&[bad],&slots("bad"),&"d".repeat(64),ActivationAction::Activate,20).is_err());
}

#[test]
fn provenance_is_in_fact_transaction_and_foreign_keys_reject_mismatches() {
    let path = Database::new(); let db = path.open();
    activate(db.conn(),0,&[revision("local",RevisionOrigin::Local)],&slots("local"),&"d".repeat(64),ActivationAction::Activate,20).unwrap();
    assert!(link_fact_in_transaction(db.conn(),"fact",1,"local","1.4.0").is_err());
    let mark=begin_immediate(db.conn()).unwrap();
    db.conn().execute("INSERT INTO sync_runs(run_id,trigger,status,schema_version,started_at_ms) VALUES('run','cli','running',?1,10)",params![SCHEMA_VERSION]).unwrap();
    db.conn().execute_batch("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,source_event_id,observation_kind,ingested_run_id,created_at_ms,updated_at_ms)
        VALUES('fact','harness:zcode','machine','session','event','usage','run',10,10);").unwrap();
    assert!(link_fact_in_transaction(db.conn(),"fact",0,"local","1.4.0").is_err());
    assert!(link_fact_in_transaction(db.conn(),"missing",1,"local","1.4.0").is_err());
    link_fact_in_transaction(db.conn(),"fact",1,"local","1.4.0").unwrap();
    db.conn().execute_batch("ROLLBACK").unwrap();
    let count:i64=db.conn().query_row("SELECT COUNT(*) FROM usage_facts",[],|r|r.get(0)).unwrap();
    assert_eq!(count,0);
    // A succeeding fact transaction and relation commit together.
    let _ = mark;
    let mark=begin_immediate(db.conn()).unwrap();
    db.conn().execute("INSERT INTO sync_runs(run_id,trigger,status,schema_version,started_at_ms) VALUES('run','cli','running',?1,10)",params![SCHEMA_VERSION]).unwrap();
    db.conn().execute_batch("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,source_event_id,observation_kind,ingested_run_id,created_at_ms,updated_at_ms)
        VALUES('fact','harness:zcode','machine','session','event','usage','run',10,10);").unwrap();
    link_fact_in_transaction(db.conn(),"fact",1,"local","1.4.0").unwrap();
    commit_advancing_revision(db.conn(),mark).unwrap();
    drop(db);
    let db=path.open();
    let count:i64=db.conn().query_row("SELECT COUNT(*) FROM extension_fact_provenance",[],|r|r.get(0)).unwrap();
    assert_eq!(count,1);
    let mark=begin_immediate(db.conn()).unwrap();
    db.conn().execute("UPDATE usage_facts SET event_ts_ms=10 WHERE fact_id='fact'",[]).unwrap();
    db.conn().execute_batch("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,source_event_id,observation_kind,ingested_run_id,event_ts_ms,created_at_ms,updated_at_ms)
        VALUES('new-fact','harness:zcode','machine','session','new-event','usage','run',30,10,10);").unwrap();
    link_fact_in_transaction(db.conn(),"new-fact",1,"local","1.4.0").unwrap();
    commit_advancing_revision(db.conn(),mark).unwrap();
    assert_eq!(db.retention_usage_facts(20).unwrap(),1);
    let count:i64=db.conn().query_row("SELECT COUNT(*) FROM extension_fact_provenance",[],|r|r.get(0)).unwrap();
    assert_eq!(count,1,"retention must cascade only the deleted fact's provenance");
    let retained:String=db.conn().query_row("SELECT fact_id FROM extension_fact_provenance",[],|r|r.get(0)).unwrap();
    assert_eq!(retained,"new-fact");
    assert_eq!(generation_slots(db.conn(),1).unwrap(),slots("local"));
}

#[test]
fn raw_sql_vendor_null_source_is_rejected() {
    let path=Database::new(); let db=path.open();
    assert!(db.conn().execute("INSERT INTO extension_revisions VALUES('bad','harness_manifest','zcode',?1,'vendor-catalog',NULL,?2,?3,1,'{}',10)",
        params!["a".repeat(64),"b".repeat(40),"c".repeat(64)]).is_err());
}

#[test]
fn failed_v28_migration_does_not_advance_v27_stamp() {
    let path=Database::new(); let db=path.open();
    db.conn().execute_batch("DROP TABLE extension_fact_provenance; DROP TABLE extension_active;
        DROP TABLE extension_activation_slots; DROP TABLE extension_activations; DROP TABLE extension_revisions;
        CREATE TABLE extension_activations(broken TEXT); UPDATE schema_meta SET value='27' WHERE key='schema_version';").unwrap();
    drop(db);
    assert!(AuthorityDb::open(&path.0,10).is_err());
    let conn=rusqlite::Connection::open(&path.0).unwrap();
    let version:String=conn.query_row("SELECT value FROM schema_meta WHERE key='schema_version'",[],|r|r.get(0)).unwrap();
    assert_eq!(version,"27");
}

#[test]
fn v29_reopen_migrates_plugin_harness_rows_to_harness_prefix() {
    let path=Database::new(); let db=path.open();
    let mark=begin_immediate(db.conn()).unwrap();
    db.conn().execute("INSERT INTO sync_runs(run_id,trigger,status,schema_version,started_at_ms) VALUES('run','cli','running',?1,10)",params![SCHEMA_VERSION]).unwrap();
    db.conn().execute_batch("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,source_event_id,observation_kind,ingested_run_id,created_at_ms,updated_at_ms)
        VALUES('f1','plugin:zcode','m','s','e','usage','run',10,10);
        INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,source_event_id,observation_kind,ingested_run_id,created_at_ms,updated_at_ms)
        VALUES('f2','codex','m','s','e','usage','run',10,10);").unwrap();
    commit_advancing_revision(db.conn(),mark).unwrap();
    drop(db);
    // 重新 open → v29 迁移把 plugin: 行折算到 harness:，官方执行环境不动。
    let db=path.open();
    let harnesses: Vec<(String,String)> = db.conn().prepare("SELECT fact_id,harness FROM usage_facts ORDER BY fact_id").unwrap()
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(harnesses, vec![("f1".to_string(),"harness:zcode".to_string()),("f2".to_string(),"codex".to_string())]);
    let version:String=db.conn().query_row("SELECT value FROM schema_meta WHERE key='schema_version'",[],|r|r.get(0)).unwrap();
    assert_eq!(version,SCHEMA_VERSION.to_string());
}

#[test]
fn v28_stamped_database_upgrades_through_the_idempotent_band() {
    // 回归：v29 bump 曾把「上一发布版本 28」漏出幂等带，真机 28 库掉进
    // unsupported 分支被拒开。任何 v∈[27, 当前] 都必须能走加性尾事务升级。
    let path=Database::new();
    { let _db=path.open(); } // 建库到当前版本
    {
        let conn=rusqlite::Connection::open(&path.0).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=DELETE; UPDATE schema_meta SET value='28' WHERE key='schema_version';").unwrap();
    }
    // 重开：28 → 29 走幂等带，扩展表 IF NOT EXISTS 补齐 + harness 行迁移。
    let db=path.open();
    let version:String=db.conn().query_row("SELECT value FROM schema_meta WHERE key='schema_version'",[],|r|r.get(0)).unwrap();
    assert_eq!(version,SCHEMA_VERSION.to_string());
    let tables:i64=db.conn().query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='extension_revisions'",[],|r|r.get(0)).unwrap();
    assert_eq!(tables,1);
    drop(db);
    // 27 同样在带内（旧分支提交点）。
    {
        let conn=rusqlite::Connection::open(&path.0).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=DELETE; UPDATE schema_meta SET value='27' WHERE key='schema_version';").unwrap();
    }
    let db=path.open();
    let version:String=db.conn().query_row("SELECT value FROM schema_meta WHERE key='schema_version'",[],|r|r.get(0)).unwrap();
    assert_eq!(version,SCHEMA_VERSION.to_string());
}

#[test]
fn v30_restamps_plugin_profile_ids_to_harness_identity() {
    use agent_vitals_domain::contracts::usage_fact::fact_id;
    let path=Database::new();
    { let _db=path.open(); }
    {
        let conn=rusqlite::Connection::open(&path.0).unwrap();
        conn.execute_batch("PRAGMA journal_mode=DELETE;").unwrap();
    }
    let db=path.open();
    let mark=begin_immediate(db.conn()).unwrap();
    db.conn().execute("INSERT INTO sync_runs(run_id,trigger,status,schema_version,started_at_ms) VALUES('run','cli','running',?1,10)",params![SCHEMA_VERSION]).unwrap();
    // 旧行：v29 后形态（harness 已折算），source_profile 仍 plugin- —— v30 的标记。
    let insert="INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,source_event_id,observation_kind,source_profile,ingested_run_id,created_at_ms,updated_at_ms) VALUES(?1,'harness:zcode','m','s',?2,'usage',?3,'run',10,10)";
    db.conn().execute(insert,params!["old-e1","e1","plugin-abcd"]).unwrap();
    db.conn().execute(insert,params!["old-e2","e2","plugin-abcd"]).unwrap();
    commit_advancing_revision(db.conn(),mark).unwrap();
    drop(db);
    let db=path.open(); // 重开 → v30
    let new_e1=fact_id("m","harness:zcode","harness-abcd","s","e1","usage");
    let new_e2=fact_id("m","harness:zcode","harness-abcd","s","e2","usage");
    for (old_id,new_id) in [("old-e1",new_e1.as_str()),("old-e2",new_e2.as_str())] {
        let profile:String=db.conn().query_row("SELECT source_profile FROM usage_facts WHERE fact_id=?1",params![new_id],|r|r.get(0))
            .unwrap_or_else(|_| panic!("{old_id} 应已重 stamp 为 {new_id}"));
        assert_eq!(profile,"harness-abcd");
    }
    let leftover:i64=db.conn().query_row("SELECT COUNT(*) FROM usage_facts WHERE source_profile LIKE 'plugin-%' OR fact_id LIKE 'old-%'",[],|r|r.get(0)).unwrap();
    assert_eq!(leftover,0);
    // 幂等：再开一次无变化。
    drop(db);
    let db=path.open();
    let count:i64=db.conn().query_row("SELECT COUNT(*) FROM usage_facts",[],|r|r.get(0)).unwrap();
    assert_eq!(count,2);
}
