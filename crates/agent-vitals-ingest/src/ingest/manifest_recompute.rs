//! Explicit historical replay into an immutable, isolated result, never the usage ledger.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use agent_vitals_data::authority::AuthorityDb;
use agent_vitals_data::extension_authority as ledger;
use agent_vitals_runtime_core::core::extension_objects::ObjectStore;
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Preview is read-only. Confirmation binds exact bytes, revision and generation.
/// Results do not change activation, historical provenance, usage or sealed bills.
pub fn recompute(data_home: &Path, home: &Path, slug: &str, revision: &str,
    namespace: &str, files: &[PathBuf], confirm: Option<&str>) -> Result<Value, String> {
    let db = AuthorityDb::open_readonly(&agent_vitals_data::authority::default_authority_path(data_home))
        .map_err(|e| format!("authority read: {e}"))?;
    let generation = ledger::current_generation(db.conn()).map_err(|e| e.to_string())?;
    let historical: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM extension_activation_slots WHERE slot_type='harness_manifest' AND slot_id=?1 AND revision_id=?2)",
        params![slug, revision], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !historical { return Err("revision was never active for this harness".into()); }
    let store = ObjectStore::open_readonly(&data_home.join("state/extensions")).map_err(str::to_string)?;
    let (manifest, hash) = super::local_manifest_lifecycle::object_manifest(&db, &store, slug, revision)?;
    let report = super::plugin_ingest::frozen_manifest_replay(manifest, hash, files, namespace, home)?;
    let mut facts = BTreeMap::new();
    for fact in report.facts {
        let id = fact["fact_id"].as_str().ok_or("replay fact missing identity")?.to_string();
        if let Some(previous) = facts.insert(id, fact.clone()) {
            if previous != fact { return Err("replay contains conflicting fact identities".into()); }
        }
    }
    let result = json!({"schema":"agent-vitals-manifest-recompute/v1",
        "harness":format!("harness:{slug}"), "revision_id":revision, "generation":generation,
        "engine_version":env!("CARGO_PKG_VERSION"), "machine_namespace":namespace,
        "corpus_fingerprint":report.corpus_fingerprint, "captured_files":report.files.len(),
        "coverage":"captured-corpus-only", "invalid":report.invalid, "skipped":report.skipped,
        "applied_to_usage_facts":false, "sealed_snapshots":"unchanged",
        "facts":facts.into_values().collect::<Vec<_>>()});
    let bytes = serde_json::to_vec(&super::extension_installer::canonical_value(&result)).map_err(|e| e.to_string())?;
    if bytes.len() > agent_vitals_runtime_core::core::extension_objects::MAX_PAYLOAD_BYTES {
        return Err("recompute result too large; select a smaller corpus".into());
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let mut response = json!({"state":"preview", "harness":result["harness"],
        "revision_id":revision, "generation":generation, "preview_sha256":digest,
        "fact_count":result["facts"].as_array().unwrap().len(),
        "captured_files":report.files.len(), "coverage":"captured-corpus-only",
        "invalid":report.invalid, "skipped":report.skipped,
        "applied_to_usage_facts":false, "sealed_snapshots":"unchanged"});
    if let Some(confirmed) = confirm {
        if confirmed != digest { return Err("preview expired; preview recomputation again".into()); }
        // Pin a read snapshot for publication; this result describes that generation,
        // not a new activation. No authority rows are changed.
        db.conn().execute_batch("BEGIN").map_err(|e| e.to_string())?;
        if ledger::current_generation(db.conn()).map_err(|e| e.to_string())? != generation {
            return Err("preview expired; active generation changed".into());
        }
        let root = data_home.join("state/extension-recomputations");
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let results = ObjectStore::open(&root).map_err(str::to_string)?;
        let staged = results.stage(&bytes).map_err(str::to_string)?;
        let published = results.install(Path::new(&staged), &digest);
        let _ = results.discard(&staged);
        published.map_err(str::to_string)?;
        db.conn().execute_batch("COMMIT").map_err(|e| e.to_string())?;
        response["state"] = json!("recorded");
        response["result_sha256"] = json!(digest);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority_snapshot(db: &AuthorityDb) -> Vec<String> {
        let mut tables = db.conn().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").unwrap();
        let names = tables.query_map([], |row| row.get::<_, String>(0)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();
        let mut snapshot = Vec::new();
        for name in names {
            let mut statement = db.conn().prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\""))).unwrap();
            let count = statement.column_count();
            let mut rows = statement.query_map([], |row| {
                let fields = (0..count).map(|index| row.get::<_, rusqlite::types::Value>(index))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(format!("{name}:{fields:?}"))
            }).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
            rows.sort();
            snapshot.extend(rows);
        }
        snapshot
    }

    #[test]
    fn explicit_replay_is_immutable_idempotent_and_preserves_authority() {
        let (home, data_home, manifest, file) = super::super::local_manifest_install::tests::fixture();
        let files = vec![file.clone()];
        let preview = super::super::local_manifest_install::local_manifest_install(
            &manifest, "m1", &data_home, &home, &files, None).unwrap();
        super::super::local_manifest_install::local_manifest_install(
            &manifest, "m1", &data_home, &home, &files, preview["preview_sha256"].as_str()).unwrap();
        let ingested = super::super::plugin_ingest::ingest_installed("m1", &data_home, &home);
        assert!(ingested[0].1.is_ok());
        let db_path = agent_vitals_data::authority::default_authority_path(&data_home);
        let writable = AuthorityDb::open(&db_path, 10).unwrap();
        writable.conn().execute("INSERT INTO pricing_snapshots (pricing_version,captured_at_ms,source_kind,payload_json) VALUES ('historical-price',1,'fixture','{}')", []).unwrap();
        writable.conn().execute("INSERT INTO harness_bills (bill_id,harness,provider_id,billing_period,billing_basis,amount_minor,currency,created_at_ms,updated_at_ms) VALUES ('historical-bill','harness:zcode','unknown','2026-09','metered_actual',100,'USD',1,1)", []).unwrap();
        drop(writable);
        let db = AuthorityDb::open_readonly(&db_path).unwrap();
        let revision = ledger::generation_slots(db.conn(), 1).unwrap()
            .get(&("harness_manifest".into(), "zcode".into())).unwrap().clone();
        let baseline = authority_snapshot(&db);
        let preview = recompute(&data_home, &home, "zcode", &revision, "m1", &files, None).unwrap();
        assert_eq!(preview["fact_count"], 1);
        assert!(!data_home.join("state/extension-recomputations").exists());
        let confirmed = recompute(&data_home, &home, "zcode", &revision, "m1", &files,
            preview["preview_sha256"].as_str()).unwrap();
        assert_eq!(confirmed["state"], "recorded");
        assert_eq!(confirmed["applied_to_usage_facts"], false);
        let digest = confirmed["result_sha256"].as_str().unwrap();
        let root = data_home.join("state/extension-recomputations");
        let store = ObjectStore::open_readonly(&root).unwrap();
        let saved = store.load(digest).unwrap();
        assert_eq!(saved["facts"].as_array().unwrap().len(), 1);
        let repeated = recompute(&data_home, &home, "zcode", &revision, "m1", &files,
            preview["preview_sha256"].as_str()).unwrap();
        assert_eq!(confirmed, repeated);
        assert_eq!(std::fs::read_dir(root.join("objects")).unwrap().count(), 1);
        assert_eq!(ledger::current_generation(db.conn()).unwrap(), 1);
        assert_eq!(authority_snapshot(&db), baseline);
        let mut other: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        other["slug"] = json!("another");
        let other = agent_vitals_harnesses::generic_manifest::parse_manifest(other).unwrap();
        assert!(super::super::extension_installer::ensure_compiled_sources_exclusive(
            &other, &home, &data_home).unwrap_err().contains("source scope overlap"));
        assert!(super::super::extension_installer::ensure_active_compiled_sources_exclusive(
            &data_home, &home).is_ok());
        crate::custom_sources::add_custom_source_root(&data_home, "codex", &home.join("data")).unwrap();
        assert!(super::super::extension_installer::ensure_active_compiled_sources_exclusive(
            &data_home, &home).unwrap_err().contains("compiled adapter: codex"));
        assert!(recompute(&data_home, &home, "zcode", "unknown", "m1", &files, None).is_err());
        assert!(recompute(&data_home, &home, "zcode", &revision, "other-machine", &files,
            preview["preview_sha256"].as_str()).unwrap_err().contains("expired"));
        let removal = super::super::local_manifest_lifecycle::local_harness_change(
            &data_home, &home, "zcode", super::super::local_manifest_lifecycle::HarnessChange::Uninstall,
            &[], None, None).unwrap();
        super::super::local_manifest_lifecycle::local_harness_change(
            &data_home, &home, "zcode", super::super::local_manifest_lifecycle::HarnessChange::Uninstall,
            &[], None, removal["preview_sha256"].as_str()).unwrap();
        assert!(super::super::extension_installer::ensure_active_compiled_sources_exclusive(
            &data_home, &home).unwrap_err().contains("compiled adapter: codex"));
        assert!(recompute(&data_home, &home, "zcode", &revision, "m1", &files,
            preview["preview_sha256"].as_str()).unwrap_err().contains("expired"));
        let preview = recompute(&data_home, &home, "zcode", &revision, "m1", &files, None).unwrap();
        assert_eq!(preview["fact_count"], 1); // Historical objects survive uninstall.
        let raw = std::fs::read_to_string(&file).unwrap();
        std::fs::write(&file, format!("{raw}\n")).unwrap();
        assert!(recompute(&data_home, &home, "zcode", &revision, "m1", &files,
            preview["preview_sha256"].as_str()).unwrap_err().contains("expired"));
        assert_eq!(store.load(digest).unwrap(), saved);
        drop(db);
        let _ = std::fs::remove_dir_all(home);
    }
}
