//! Single-harness local rollback and uninstall; every operation preserves other slots.
use std::path::{Path, PathBuf};

use agent_vitals_data::authority::AuthorityDb;
use agent_vitals_data::extension_authority::{self as ledger, ActivationAction, SlotMap};
use agent_vitals_harnesses::generic_manifest;
use agent_vitals_runtime_core::core::extension_objects::ObjectStore;
use rusqlite::params;
use serde_json::{json, Value};

use super::extension_installer::{self, LocalInputBinding, PreviewTicket};
use super::plugin_ingest;

#[derive(Clone, Copy)]
pub enum HarnessChange<'a> { Uninstall, Rollback { revision_id: &'a str } }

fn slug_valid(slug: &str) -> bool {
    slug.len() <= 32 && slug.bytes().next().is_some_and(|byte| byte.is_ascii_lowercase())
        && slug.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn active(db: &AuthorityDb) -> Result<(i64, SlotMap), String> {
    let generation = ledger::current_generation(db.conn()).map_err(|e| e.to_string())?;
    let map = ledger::generation_slots(db.conn(), generation).map_err(|e| e.to_string())?;
    Ok((generation, map))
}

pub(crate) fn object_manifest(db: &AuthorityDb, store: &ObjectStore, slug: &str, revision_id: &str)
    -> Result<(agent_vitals_harnesses::generic_manifest::PluginManifest, String), String> {
    let hash: String = db.conn().query_row(
        "SELECT content_sha256 FROM extension_revisions WHERE revision_id=?1 AND slot_type='harness_manifest' AND slot_id=?2",
        params![revision_id, slug], |row| row.get(0)).map_err(|_| "unknown harness revision".to_string())?;
    let value = store.load(&hash).map_err(|e| format!("harness object: {e}"))?;
    let manifest = generic_manifest::parse_manifest(value).map_err(|e| format!("harness manifest: {e}"))?;
    if manifest.slug != slug { return Err("harness revision slot mismatch".into()); }
    Ok((manifest, hash[..16].to_string()))
}

struct Prepared {
    ticket: PreviewTicket,
    impact: Option<plugin_ingest::ManifestImpact>,
    changed: bool,
    slug: String,
}

fn prepare(data_home: &Path, home: &Path, slug: &str, change: HarnessChange<'_>,
    files: &[PathBuf], machine_namespace: Option<&str>) -> Result<Prepared, String> {
    if !slug_valid(slug) { return Err("invalid harness slug".into()); }
    let db_path = agent_vitals_data::authority::default_authority_path(data_home);
    let db = AuthorityDb::open_readonly(&db_path).map_err(|e| format!("authority read: {e}"))?;
    let (generation, mut map) = active(&db)?;
    let key = ("harness_manifest".to_string(), slug.to_string());
    let current = map.get(&key).cloned();
    let (action, impact, binding) = match change {
        HarnessChange::Uninstall => {
            map.remove(&key);
            (ActivationAction::Uninstall, None, None)
        }
        HarnessChange::Rollback { revision_id } => {
            let current_id = current.as_deref().ok_or("harness is not active")?;
            let namespace = machine_namespace.filter(|value| !value.is_empty())
                .ok_or("rollback requires machine namespace")?;
            let historically_active: bool = db.conn().query_row(
                "SELECT EXISTS(SELECT 1 FROM extension_activation_slots WHERE slot_type='harness_manifest' AND slot_id=?1 AND revision_id=?2)",
                params![slug, revision_id], |row| row.get(0)).map_err(|e| e.to_string())?;
            if !historically_active { return Err("revision was never active for this harness".into()); }
            let store = ObjectStore::open_readonly(&data_home.join("state/extensions"))
                .map_err(|e| format!("object store: {e}"))?;
            let previous = object_manifest(&db, &store, slug, current_id)?;
            let target = object_manifest(&db, &store, slug, revision_id)?;
            let impact = plugin_ingest::preview_captured_manifest_change(Some(previous), target,
                files, namespace, home)?;
            let binding = LocalInputBinding { machine_namespace:namespace.to_string(),
                corpus_fingerprint:impact.corpus_fingerprint.clone(), impact_sha256:impact.impact_sha256.clone() };
            map.insert(key, revision_id.to_string());
            extension_installer::ensure_harness_map_sources_exclusive(&db, &store, &map, home, data_home)?;
            (ActivationAction::Rollback, Some(impact), Some(binding))
        }
    };
    let changed = match change {
        HarnessChange::Uninstall => current.is_some(),
        HarnessChange::Rollback { revision_id } => current.as_deref() != Some(revision_id),
    };
    let ticket = PreviewTicket { expected_generation:generation,
        engine_version:env!("CARGO_PKG_VERSION").into(), action,
        new_revisions:Vec::new(), target_map:map, local_input:binding };
    Ok(Prepared { ticket, impact, changed, slug:slug.into() })
}

/// Preview is read-only. Confirm recomputes the ticket and commits only the
/// requested harness slot; facts and historical revisions are retained.
pub fn local_harness_change(data_home: &Path, home: &Path, slug: &str,
    change: HarnessChange<'_>, files: &[PathBuf], machine_namespace: Option<&str>,
    confirm: Option<&str>) -> Result<Value, String> {
    let prepared = prepare(data_home, home, slug, change, files, machine_namespace)?;
    let preview_sha256 = prepared.ticket.preview_sha256();
    let action = match change { HarnessChange::Uninstall => "uninstall", HarnessChange::Rollback { .. } => "rollback" };
    if let Some(confirmed) = confirm {
        if confirmed != preview_sha256 { return Err("preview expired; preview the harness change again".into()); }
        if !prepared.changed {
            let db = AuthorityDb::open_readonly(&agent_vitals_data::authority::default_authority_path(data_home))
                .map_err(|e| e.to_string())?;
            if ledger::current_generation(db.conn()).map_err(|e| e.to_string())? != prepared.ticket.expected_generation {
                return Err("preview expired; active generation changed".into());
            }
            return Ok(json!({"state":"unchanged", "action":action, "harness":format!("harness:{}", slug),
                "generation":prepared.ticket.expected_generation, "preview_sha256":preview_sha256}));
        }
        let now = crate::clock::now_ms();
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(data_home), now)
            .map_err(|e| format!("authority open: {e}"))?;
        let generation = if prepared.ticket.target_map.is_empty() {
            extension_installer::commit_empty_uninstall(&db, &prepared.ticket, now)
        } else {
            let store = ObjectStore::open_readonly(&data_home.join("state/extensions"))
                .map_err(|e| format!("object store: {e}"))?;
            extension_installer::commit(&db, &store, &prepared.ticket, now)
        }.map_err(|e| format!("harness change activation: {e}"))?;
        let warning = extension_installer::rebuild_registry_snapshot(data_home, &db, now)
            .err().map(|e| format!("registry snapshot: {e}"));
        return Ok(json!({"state":"active", "action":action, "harness":format!("harness:{}", prepared.slug),
            "generation":generation, "preview_sha256":preview_sha256, "warning":warning}));
    }
    Ok(json!({"state":"preview", "action":action, "harness":format!("harness:{}", prepared.slug),
        "generation":prepared.ticket.expected_generation, "preview_sha256":preview_sha256,
        "changed":prepared.changed, "impact":prepared.impact,
        "history":"retained"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::local_manifest_install::tests::fixture;
    use sha2::{Digest, Sha256};

    fn install(home: &Path, data_home: &Path, manifest: &Path, files: &[PathBuf]) {
        let preview = crate::ingest::local_manifest_install::local_manifest_install(
            manifest, "m1", data_home, home, files, None).unwrap();
        crate::ingest::local_manifest_install::local_manifest_install(
            manifest, "m1", data_home, home, files,
            preview["preview_sha256"].as_str()).unwrap();
    }

    #[test]
    fn rollback_only_one_harness_and_uninstall_preserves_other_slot() {
        let (home, data_home, manifest, file) = fixture();
        let files = vec![file];
        install(&home, &data_home, &manifest, &files);
        let db_path = agent_vitals_data::authority::default_authority_path(&data_home);
        let db = AuthorityDb::open(&db_path, 10).unwrap();
        let old_id = ledger::generation_slots(db.conn(), 1).unwrap()
            .get(&("harness_manifest".into(), "zcode".into())).unwrap().clone();
        let store = ObjectStore::open(&data_home.join("state/extensions")).unwrap();
        let raw = br#"{"card":"other"}"#;
        let hash = format!("{:x}", Sha256::digest(raw));
        let staged = store.stage(raw).unwrap();
        store.install(Path::new(&staged), &hash).unwrap();
        store.discard(&staged).unwrap();
        let other = agent_vitals_data::extension_authority::ExtensionRevision {
            revision_id:"price-other".into(), slot_type:"price_card".into(), slot_id:"other".into(),
            content_sha256:hash, origin:agent_vitals_data::extension_authority::RevisionOrigin::Local,
            schema_version:1, capabilities:json!({}), installed_at_ms:11 };
        let mut map = ledger::generation_slots(db.conn(), 1).unwrap();
        map.insert(("price_card".into(), "other".into()), other.revision_id.clone());
        ledger::activate(db.conn(), 1, &[other], &map, &"a".repeat(64), ActivationAction::Activate, 11).unwrap();
        let raw = std::fs::read_to_string(&manifest).unwrap();
        std::fs::write(&manifest, raw.replace("ZCode", "ZCode Updated")).unwrap();
        install(&home, &data_home, &manifest, &files);
        let current = ledger::generation_slots(db.conn(), 3).unwrap();
        assert_ne!(current.get(&("harness_manifest".into(), "zcode".into())), Some(&old_id));
        assert_eq!(current.get(&("price_card".into(), "other".into())), Some(&"price-other".into()));
        let preview = local_harness_change(&data_home, &home, "zcode",
            HarnessChange::Rollback { revision_id:&old_id }, &files, Some("m1"), None).unwrap();
        assert_eq!(preview["impact"]["candidate_facts"], 1);
        let rolled = local_harness_change(&data_home, &home, "zcode",
            HarnessChange::Rollback { revision_id:&old_id }, &files, Some("m1"),
            preview["preview_sha256"].as_str()).unwrap();
        assert_eq!(rolled["generation"], 4);
        let rolled_map = ledger::generation_slots(db.conn(), 4).unwrap();
        assert_eq!(rolled_map.get(&("harness_manifest".into(), "zcode".into())), Some(&old_id));
        assert_eq!(rolled_map.get(&("price_card".into(), "other".into())), Some(&"price-other".into()));
        let uninstall = local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, None).unwrap();
        assert_eq!(uninstall["changed"], true);
        let stopped = local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, uninstall["preview_sha256"].as_str()).unwrap();
        assert_eq!(stopped["generation"], 5);
        let final_map = ledger::generation_slots(db.conn(), 5).unwrap();
        assert!(!final_map.contains_key(&("harness_manifest".into(), "zcode".into())));
        assert_eq!(final_map.get(&("price_card".into(), "other".into())), Some(&"price-other".into()));
        let revisions: i64 = db.conn().query_row("SELECT COUNT(*) FROM extension_revisions", [], |row| row.get(0)).unwrap();
        assert_eq!(revisions, 3);
        let repeated = local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, None).unwrap();
        assert_eq!(repeated["changed"], false);
        local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, repeated["preview_sha256"].as_str()).unwrap();
        assert_eq!(ledger::current_generation(db.conn()).unwrap(), 5);
        drop(db);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn rollback_rejects_wrong_revision_and_bad_object_uninstall_still_works() {
        let (home, data_home, manifest, file) = fixture();
        let files = vec![file];
        install(&home, &data_home, &manifest, &files);
        let db_path = agent_vitals_data::authority::default_authority_path(&data_home);
        let db = AuthorityDb::open_readonly(&db_path).unwrap();
        assert!(local_harness_change(&data_home, &home, "zcode",
            HarnessChange::Rollback { revision_id:"never-installed" }, &files, Some("m1"), None)
            .unwrap_err().contains("never active"));
        let hash: String = db.conn().query_row(
            "SELECT content_sha256 FROM extension_revisions LIMIT 1", [], |row| row.get(0)).unwrap();
        std::fs::write(data_home.join("state/extensions/objects").join(hash).join("payload.json"), "{}").unwrap();
        let preview = local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, None).unwrap();
        std::fs::remove_dir_all(data_home.join("state/extensions/objects")).unwrap();
        let without_objects = local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, None).unwrap();
        assert_eq!(preview["preview_sha256"], without_objects["preview_sha256"]);
        local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, preview["preview_sha256"].as_str()).unwrap();
        assert_eq!(ledger::current_generation(db.conn()).unwrap(), 2);
        drop(db);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn stale_confirm_refused_and_snapshot_failure_reports_committed_change() {
        let (home, data_home, manifest, file) = fixture();
        let files = vec![file];
        install(&home, &data_home, &manifest, &files);
        let db_path = agent_vitals_data::authority::default_authority_path(&data_home);
        let db = AuthorityDb::open(&db_path, 10).unwrap();
        let stale = local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, None).unwrap();
        let map = ledger::generation_slots(db.conn(), 1).unwrap();
        ledger::activate(db.conn(), 1, &[], &map, &"b".repeat(64), ActivationAction::Activate, 11).unwrap();
        assert!(local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, stale["preview_sha256"].as_str()).unwrap_err().contains("preview expired"));
        let fresh = local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, None).unwrap();
        let catalog = data_home.join("catalog");
        std::fs::remove_file(catalog.join("registry.json")).unwrap();
        std::fs::remove_dir(&catalog).unwrap();
        std::fs::write(&catalog, "block snapshot directory").unwrap();
        let changed = local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, fresh["preview_sha256"].as_str()).unwrap();
        assert_eq!(changed["generation"], 3);
        assert!(changed["warning"].as_str().unwrap().contains("registry snapshot"));
        assert_eq!(ledger::current_generation(db.conn()).unwrap(), 3);
        assert!(ledger::generation_slots(db.conn(), 3).unwrap().is_empty());
        drop(db);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn uninstall_retains_ingested_facts_and_provenance() {
        let (home, data_home, manifest, file) = fixture();
        install(&home, &data_home, &manifest, &[file]);
        let ingested = crate::ingest::plugin_ingest::ingest_installed("m1", &data_home, &home);
        assert_eq!(ingested.len(), 1);
        assert!(ingested[0].1.is_ok(), "{:?}", ingested[0].1);
        let db_path = agent_vitals_data::authority::default_authority_path(&data_home);
        let db = AuthorityDb::open_readonly(&db_path).unwrap();
        let counts = || {
            let facts: i64 = db.conn().query_row("SELECT COUNT(*) FROM usage_facts WHERE harness='harness:zcode'",
                [], |row| row.get(0)).unwrap();
            let links: i64 = db.conn().query_row("SELECT COUNT(*) FROM extension_fact_provenance",
                [], |row| row.get(0)).unwrap();
            (facts, links)
        };
        assert_eq!(counts(), (1, 1));
        let preview = local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, None).unwrap();
        local_harness_change(&data_home, &home, "zcode", HarnessChange::Uninstall,
            &[], None, preview["preview_sha256"].as_str()).unwrap();
        assert_eq!(counts(), (1, 1));
        assert_eq!(ledger::current_generation(db.conn()).unwrap(), 2);
        drop(db);
        let _ = std::fs::remove_dir_all(home);
    }
}
