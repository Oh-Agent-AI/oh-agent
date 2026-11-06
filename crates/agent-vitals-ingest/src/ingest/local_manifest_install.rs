//! Local harness manifest preview and explicit activation. No network or fact writes.
use std::io::Read;
use std::path::{Path, PathBuf};

use agent_vitals_data::authority::AuthorityDb;
use agent_vitals_data::extension_authority::{self as ledger, ActivationAction, ExtensionRevision, RevisionOrigin, SlotMap};
use agent_vitals_harnesses::generic_manifest;
use agent_vitals_runtime_core::core::extension_objects::{ObjectStore, MAX_PAYLOAD_BYTES};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::extension_installer::{self, LocalInputBinding, PreviewTicket};
use super::plugin_ingest::{self, ManifestImpact};

pub(crate) struct Prepared {
    pub raw: Vec<u8>,
    pub ticket: PreviewTicket,
    pub impact: ManifestImpact,
    pub already_active: bool,
    pub slug: String,
}
type RevisionMetadata = (String, String, String, String, Option<String>, Option<String>, Option<String>, i64, String);

fn prepare(manifest_path: &Path, machine_namespace: &str, data_home: &Path,
    home: &Path, files: &[PathBuf]) -> Result<Prepared, String> {
    if machine_namespace.is_empty() { return Err("machine namespace is required".into()); }
    let file = std::fs::File::open(manifest_path).map_err(|e| format!("manifest read: {e}"))?;
    let mut raw = Vec::new();
    file.take((MAX_PAYLOAD_BYTES + 1) as u64).read_to_end(&mut raw)
        .map_err(|e| format!("manifest read: {e}"))?;
    if raw.len() > MAX_PAYLOAD_BYTES { return Err("manifest exceeds object byte limit".into()); }
    let (candidate, _) = plugin_ingest::parse_manifest_bytes(manifest_path, &raw)?;
    let digest = format!("{:x}", Sha256::digest(&raw));
    let capabilities = serde_json::from_slice::<Value>(&raw).map_err(|e| e.to_string())?
        .get("requires").filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({}));
    let revision = ExtensionRevision {
        revision_id:format!("local:harness_manifest:{}:{digest}", candidate.slug),
        slot_type:"harness_manifest".into(), slot_id:candidate.slug,
        content_sha256:digest, origin:RevisionOrigin::Local, schema_version:1,
        capabilities, installed_at_ms:0,
    };
    prepare_bytes(manifest_path, raw, revision, machine_namespace, data_home, home, files, true)
}

/// Shared harness handler; origin metadata comes from the caller's acquisition channel.
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_bytes(manifest_path: &Path, raw: Vec<u8>, revision: ExtensionRevision,
    machine_namespace: &str, data_home: &Path, home: &Path, files: &[PathBuf],
    release_local_pin: bool) -> Result<Prepared, String> {
    if machine_namespace.is_empty() { return Err("machine namespace is required".into()); }
    if raw.len() > MAX_PAYLOAD_BYTES { return Err("manifest exceeds object byte limit".into()); }
    let (candidate, candidate_revision) = plugin_ingest::parse_manifest_bytes(manifest_path, &raw)?;
    let slug = candidate.slug.clone();
    extension_installer::ensure_compiled_sources_exclusive(&candidate, home, data_home)?;
    let digest = format!("{:x}", Sha256::digest(&raw));
    if revision.slot_type != "harness_manifest" || revision.slot_id != slug || revision.content_sha256 != digest {
        return Err("manifest revision metadata mismatch".into());
    }
    let revision_id = revision.revision_id.clone();
    let db_path = agent_vitals_data::authority::default_authority_path(data_home);
    let (generation, mut slots, previous, revision_exists, already_active) = if db_path.exists() {
        let db = AuthorityDb::open_readonly(&db_path).map_err(|e| format!("authority read: {e}"))?;
        let generation = ledger::current_generation(db.conn()).map_err(|e| e.to_string())?;
        let slots = ledger::generation_slots(db.conn(), generation).map_err(|e| e.to_string())?;
        ensure_exclusive_with_active_harnesses(&candidate, &slots, data_home, home)?;
        let active_id = slots.get(&("harness_manifest".into(), slug.clone()));
        let previous = if let Some(active_id) = active_id {
            let (hash, origin): (String, String) = db.conn().query_row(
                "SELECT content_sha256,origin FROM extension_revisions WHERE revision_id=?1 AND slot_type='harness_manifest' AND slot_id=?2",
                params![active_id, slug], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e| e.to_string())?;
            if origin == "local" && matches!(revision.origin, RevisionOrigin::VendorCatalog { .. }) && !release_local_pin {
                return Err(format!("local pin protected: harness:{slug}; explicitly preview releasing the pin"));
            }
            let store = ObjectStore::open_readonly(&data_home.join("state/extensions"))
                .map_err(|e| format!("active object store: {e}"))?;
            let value = store.load(&hash).map_err(|e| format!("active object: {e}"))?;
            let manifest = generic_manifest::parse_manifest(value)
                .map_err(|e| format!("active manifest: {e}"))?;
            if manifest.slug != slug { return Err("active manifest slot mismatch".into()); }
            Some((manifest, hash[..16].to_string()))
        } else { None };
        let existing: Option<RevisionMetadata> = db.conn().query_row(
            "SELECT slot_type,slot_id,content_sha256,origin,vendor_source,vendor_commit,index_sha256,schema_version,capabilities_json FROM extension_revisions WHERE revision_id=?1",
            params![revision_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?)))
            .optional().map_err(|e| e.to_string())?;
        if let Some((slot_type, slot_id, hash, origin, source, commit, index_hash, schema, capabilities)) = &existing {
            let origin_matches = match &revision.origin {
                RevisionOrigin::Local => origin == "local" && source.is_none() && commit.is_none() && index_hash.is_none(),
                RevisionOrigin::VendorCatalog { source: expected_source, commit: expected_commit, index_sha256 } => {
                    origin == "vendor-catalog" && source.as_ref() == Some(expected_source)
                        && commit.as_ref() == Some(expected_commit) && index_hash.as_ref() == Some(index_sha256)
                }
            };
            let capabilities: Value = serde_json::from_str(capabilities).map_err(|e| e.to_string())?;
            if slot_type != "harness_manifest" || slot_id != &slug || hash != &digest || !origin_matches
                || *schema != revision.schema_version
                || extension_installer::canonical_value(&capabilities) != extension_installer::canonical_value(&revision.capabilities) {
                return Err("manifest revision identity conflict".into());
            }
        }
        let already_active = active_id == Some(&revision_id);
        (generation, slots, previous, existing.is_some(), already_active)
    } else { (0, SlotMap::new(), None, false, false) };
    let impact = plugin_ingest::preview_captured_manifest_change(previous,
        (candidate, candidate_revision), files, machine_namespace, home)?;
    slots.insert(("harness_manifest".into(), slug.clone()), revision_id.clone());
    let revisions = if revision_exists { Vec::new() } else { vec![revision] };
    let ticket = PreviewTicket { expected_generation:generation,
        engine_version:env!("CARGO_PKG_VERSION").into(), action:ActivationAction::Activate,
        new_revisions:revisions, target_map:slots,
        local_input:Some(LocalInputBinding { machine_namespace:machine_namespace.into(),
            corpus_fingerprint:impact.corpus_fingerprint.clone(), impact_sha256:impact.impact_sha256.clone() }) };
    Ok(Prepared { raw, ticket, impact, already_active, slug })
}

fn ensure_exclusive_with_active_harnesses(
    candidate: &generic_manifest::PluginManifest,
    slots: &SlotMap,
    data_home: &Path,
    home: &Path,
) -> Result<(), String> {
    let harnesses: Vec<_> = slots.iter()
        .filter(|((kind, slug), _)| kind == "harness_manifest" && slug != &candidate.slug)
        .map(|((_, slug), revision)| (slug.clone(), revision.clone())).collect();
    if harnesses.is_empty() { return Ok(()); }
    let db_path = agent_vitals_data::authority::default_authority_path(data_home);
    let db = AuthorityDb::open_readonly(&db_path).map_err(|e| format!("authority read: {e}"))?;
    let store = ObjectStore::open_readonly(&data_home.join("state/extensions"))
        .map_err(|e| format!("active object store: {e}"))?;
    for (slot, revision) in harnesses {
        let digest: String = db.conn().query_row(
            "SELECT content_sha256 FROM extension_revisions WHERE revision_id=?1 AND slot_type='harness_manifest' AND slot_id=?2",
            rusqlite::params![revision, slot], |row| row.get(0)).map_err(|e| e.to_string())?;
        let active = generic_manifest::parse_manifest(store.load(&digest).map_err(str::to_string)?)
            .map_err(|e| format!("active harness manifest: {e}"))?;
        if active.slug != slot { return Err("active manifest slot mismatch".into()); }
        extension_installer::ensure_manifest_sources_exclusive(candidate, &active, home)?;
    }
    Ok(())
}

/// Without `confirm`, this is strictly read-only. Confirmation repeats the
/// entire preview and compares the exact ticket hash before publishing bytes.
pub fn local_manifest_install(manifest_path: &Path, machine_namespace: &str,
    data_home: &Path, home: &Path, files: &[PathBuf], confirm: Option<&str>) -> Result<Value, String> {
    let mut prepared = prepare(manifest_path, machine_namespace, data_home, home, files)?;
    let preview_sha256 = prepared.ticket.preview_sha256();
    if let Some(confirmed) = confirm {
        if confirmed != preview_sha256 { return Err("preview expired; run manifest-install again".into()); }
        if prepared.already_active {
            let db_path = agent_vitals_data::authority::default_authority_path(data_home);
            let db = AuthorityDb::open_readonly(&db_path).map_err(|e| format!("authority read: {e}"))?;
            let current = ledger::current_generation(db.conn()).map_err(|e| e.to_string())?;
            if current != prepared.ticket.expected_generation {
                return Err("preview expired; active generation changed".into());
            }
            return Ok(json!({"state":"already_active", "harness":format!("harness:{}", prepared.slug),
                "generation":prepared.ticket.expected_generation, "preview_sha256":preview_sha256}));
        }
        let now = crate::clock::now_ms();
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(data_home), now)
            .map_err(|e| format!("authority open: {e}"))?;
        let root = data_home.join("state/extensions");
        std::fs::create_dir_all(&root).map_err(|e| format!("object root: {e}"))?;
        let store = ObjectStore::open(&root).map_err(|e| format!("object store: {e}"))?;
        let staged = store.stage(&prepared.raw).map_err(|e| format!("stage: {e}"))?;
        let hash = format!("{:x}", Sha256::digest(&prepared.raw));
        let publish = store.install(Path::new(&staged), &hash);
        let discard = store.discard(&staged);
        publish.map_err(|e| format!("publish: {e}"))?;
        discard.map_err(|e| format!("discard staging: {e}"))?;
        for revision in &mut prepared.ticket.new_revisions { revision.installed_at_ms = now; }
        let generation = extension_installer::commit(&db, &store, &prepared.ticket, now)
            .map_err(|e| format!("activation: {e}"))?;
        let warning = extension_installer::rebuild_registry_snapshot(data_home, &db, now)
            .err().map(|e| format!("registry snapshot: {e}"));
        return Ok(json!({"state":"active", "harness":format!("harness:{}", prepared.slug),
            "generation":generation, "preview_sha256":preview_sha256, "warning":warning}));
    }
    Ok(json!({"state":"preview", "harness":format!("harness:{}", prepared.slug),
        "generation":prepared.ticket.expected_generation,
        "preview_sha256":preview_sha256, "impact":prepared.impact,
        "already_active":prepared.already_active}))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    pub(crate) fn fixture() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let home = std::env::temp_dir().join(format!("vitals-local-install-{}-{}",
            std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let data_home = home.join("app-data");
        std::fs::create_dir_all(home.join("other-data")).unwrap();
        let manifest_path = home.join("harnesses.d/zcode/manifest.json");
        std::fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        std::fs::write(&manifest_path, r#"{
          "manifest_version":1,"slug":"zcode","display":{"name":"ZCode"},
          "discovery":{"roots":["~/data"],"include":["model-io-sess_*.jsonl"]},
          "source":{"format":"jsonl"},
          "session":{"from":"filename","pattern":"^model-io-sess_(?P<id>.+)\\.jsonl$"},
          "recipe":"request-usage-anthropic-v1",
          "overrides":{"event_ts":"completedAt","model_raw":"model.modelId",
            "provider_raw":"model.providerId",
            "uncached_input_tokens":"response.providerMetadata.anthropic.usage.input_tokens",
            "output_tokens":"response.providerMetadata.anthropic.usage.output_tokens",
            "provider_request_id":"requestId"},
          "event_key":{"paths":["requestId","attempt"]},
          "billing":{"policy":"lock:metered_estimate"}
        }"#).unwrap();
        let file = home.join("data/model-io-sess_abc.jsonl");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, json!({"requestId":"r1","attempt":1,
            "completedAt":"2026-09-19T15:18:41.337Z",
            "model":{"modelId":"M1","providerId":"custom"},
            "response":{"providerMetadata":{"anthropic":{"usage":{
                "input_tokens":100,"output_tokens":5}}}}}).to_string() + "\n").unwrap();
        (home, data_home, manifest_path, file)
    }

    #[test]
    fn preview_is_readonly_and_confirm_activates_exact_input() {
        let (home, data_home, manifest, file) = fixture();
        let files = vec![file.clone()];
        let preview = local_manifest_install(&manifest, "m1", &data_home, &home, &files, None).unwrap();
        assert_eq!(preview["state"], "preview");
        assert_eq!(preview["impact"]["candidate_facts"], 1);
        assert!(!agent_vitals_data::authority::default_authority_path(&data_home).exists());
        assert!(!data_home.join("state/extensions").exists());
        let hash = preview["preview_sha256"].as_str().unwrap();
        assert!(local_manifest_install(&manifest, "m2", &data_home, &home, &files, Some(hash))
            .unwrap_err().contains("preview expired"));
        let original = std::fs::read(&file).unwrap();
        std::fs::write(&file, String::from_utf8(original.clone()).unwrap().replace("100", "101")).unwrap();
        assert!(local_manifest_install(&manifest, "m1", &data_home, &home, &files, Some(hash))
            .unwrap_err().contains("preview expired"));
        std::fs::write(&file, original).unwrap();
        let activated = local_manifest_install(&manifest, "m1", &data_home, &home, &files, Some(hash)).unwrap();
        assert_eq!(activated["state"], "active");
        assert_eq!(activated["generation"], 1);
        let db = AuthorityDb::open_readonly(&agent_vitals_data::authority::default_authority_path(&data_home)).unwrap();
        assert_eq!(ledger::current_generation(db.conn()).unwrap(), 1);
        let count: i64 = db.conn().query_row("SELECT COUNT(*) FROM usage_facts", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0, "activation must not ingest facts");
        let repeat = local_manifest_install(&manifest, "m1", &data_home, &home, &files, None).unwrap();
        assert_eq!(repeat["already_active"], true);
        let repeated = local_manifest_install(&manifest, "m1", &data_home, &home, &files,
            repeat["preview_sha256"].as_str()).unwrap();
        assert_eq!(repeated["state"], "already_active");
        assert_eq!(ledger::current_generation(db.conn()).unwrap(), 1);
        drop(db);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn candidate_bytes_change_expires_preview_and_update_keeps_history() {
        let (home, data_home, manifest, file) = fixture();
        let files = vec![file];
        let first = local_manifest_install(&manifest, "m1", &data_home, &home, &files, None).unwrap();
        let old_hash = first["preview_sha256"].as_str().unwrap();
        let raw = std::fs::read_to_string(&manifest).unwrap();
        std::fs::write(&manifest, raw.replace("ZCode", "ZCode Updated")).unwrap();
        assert!(local_manifest_install(&manifest, "m1", &data_home, &home, &files, Some(old_hash))
            .unwrap_err().contains("preview expired"));
        std::fs::write(&manifest, raw).unwrap();
        local_manifest_install(&manifest, "m1", &data_home, &home, &files, Some(old_hash)).unwrap();
        let raw = std::fs::read_to_string(&manifest).unwrap();
        std::fs::write(&manifest, raw.replace("ZCode", "ZCode Updated")).unwrap();
        let update = local_manifest_install(&manifest, "m1", &data_home, &home, &files, None).unwrap();
        assert_eq!(update["impact"]["previous_facts"], 1);
        assert_eq!(update["impact"]["candidate_facts"], 1);
        let updated = local_manifest_install(&manifest, "m1", &data_home, &home, &files,
            update["preview_sha256"].as_str()).unwrap();
        assert_eq!(updated["generation"], 2);
        let db = AuthorityDb::open_readonly(&agent_vitals_data::authority::default_authority_path(&data_home)).unwrap();
        let revisions: i64 = db.conn().query_row("SELECT COUNT(*) FROM extension_revisions", [], |row| row.get(0)).unwrap();
        assert_eq!(revisions, 2);
        let generation_one = ledger::generation_slots(db.conn(), 1).unwrap();
        let generation_two = ledger::generation_slots(db.conn(), 2).unwrap();
        assert_ne!(generation_one, generation_two);
        drop(db);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn stale_ticket_rejected_and_update_preserves_other_slot() {
        let (home, data_home, manifest, file) = fixture();
        let files = vec![file];
        let first = local_manifest_install(&manifest, "m1", &data_home, &home, &files, None).unwrap();
        local_manifest_install(&manifest, "m1", &data_home, &home, &files,
            first["preview_sha256"].as_str()).unwrap();
        let stale = prepare(&manifest, "m1", &data_home, &home, &files).unwrap();
        let db_path = agent_vitals_data::authority::default_authority_path(&data_home);
        let db = AuthorityDb::open(&db_path, 10).unwrap();
        let store = ObjectStore::open(&data_home.join("state/extensions")).unwrap();
        let other_raw = br#"{"card":"other"}"#;
        let other_hash = format!("{:x}", Sha256::digest(other_raw));
        let staged = store.stage(other_raw).unwrap();
        store.install(Path::new(&staged), &other_hash).unwrap();
        store.discard(&staged).unwrap();
        let other = ExtensionRevision { revision_id:"local-price-card".into(),
            slot_type:"price_card".into(), slot_id:"other".into(),
            content_sha256:other_hash, origin:RevisionOrigin::Local,
            schema_version:1, capabilities:json!({}), installed_at_ms:11 };
        let mut slots = ledger::generation_slots(db.conn(), 1).unwrap();
        slots.insert(("price_card".into(), "other".into()), other.revision_id.clone());
        ledger::activate(db.conn(), 1, &[other], &slots, &"a".repeat(64), ActivationAction::Activate, 11).unwrap();
        assert!(extension_installer::commit(&db, &store, &stale.ticket, 12)
            .unwrap_err().to_string().contains("StaleGeneration"));
        assert!(local_manifest_install(&manifest, "m1", &data_home, &home, &files,
            Some(&stale.ticket.preview_sha256())).unwrap_err().contains("preview expired"));
        let raw = std::fs::read_to_string(&manifest).unwrap();
        std::fs::write(&manifest, raw.replace("ZCode", "ZCode Updated")).unwrap();
        let update = local_manifest_install(&manifest, "m1", &data_home, &home, &files, None).unwrap();
        let activated = local_manifest_install(&manifest, "m1", &data_home, &home, &files,
            update["preview_sha256"].as_str()).unwrap();
        assert_eq!(activated["generation"], 3);
        let final_slots = ledger::generation_slots(db.conn(), 3).unwrap();
        assert_eq!(final_slots.get(&("price_card".into(), "other".into())),
            Some(&"local-price-card".to_string()));
        assert_ne!(final_slots.get(&("harness_manifest".into(), "zcode".into())),
            slots.get(&("harness_manifest".into(), "zcode".into())));
        drop(db);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn damaged_active_object_refuses_update_preview() {
        let (home, data_home, manifest, file) = fixture();
        let files = vec![file];
        let first = local_manifest_install(&manifest, "m1", &data_home, &home, &files, None).unwrap();
        local_manifest_install(&manifest, "m1", &data_home, &home, &files,
            first["preview_sha256"].as_str()).unwrap();
        let db_path = agent_vitals_data::authority::default_authority_path(&data_home);
        let db = AuthorityDb::open_readonly(&db_path).unwrap();
        let hash: String = db.conn().query_row(
            "SELECT content_sha256 FROM extension_revisions LIMIT 1", [], |row| row.get(0)).unwrap();
        std::fs::write(data_home.join("state/extensions/objects").join(hash).join("payload.json"), "{}").unwrap();
        let raw = std::fs::read_to_string(&manifest).unwrap();
        std::fs::write(&manifest, raw.replace("ZCode", "ZCode Updated")).unwrap();
        let error = local_manifest_install(&manifest, "m1", &data_home, &home, &files, None).unwrap_err();
        assert!(error.contains("active object"), "{error}");
        assert_eq!(ledger::current_generation(db.conn()).unwrap(), 1);
        drop(db);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn active_harness_source_root_cannot_be_claimed_by_another_manifest() {
        let (home, data_home, manifest, file) = fixture();
        let files = vec![file];
        let preview = local_manifest_install(&manifest, "m1", &data_home, &home, &files, None).unwrap();
        local_manifest_install(&manifest, "m1", &data_home, &home, &files,
            preview["preview_sha256"].as_str()).unwrap();
        let mut candidate: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        candidate["slug"] = json!("helper");
        candidate["display"]["name"] = json!("Helper");
        let candidate_path = home.join("harnesses.d/helper/manifest.json");
        std::fs::create_dir_all(candidate_path.parent().unwrap()).unwrap();
        std::fs::write(&candidate_path, serde_json::to_vec(&candidate).unwrap()).unwrap();
        assert!(local_manifest_install(&candidate_path, "m1", &data_home, &home, &files, None)
            .unwrap_err().contains("source scope overlap"));
        let _ = std::fs::remove_dir_all(home);
    }
}
