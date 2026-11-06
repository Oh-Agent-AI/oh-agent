//! Official harness catalog installation. Transport stays in the desktop adapter;
//! this service consumes its exact fetched bytes, never paths or caller-selected URLs.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use agent_vitals_data::authority::AuthorityDb;
use agent_vitals_data::extension_authority::{ActivationAction, ExtensionRevision, RevisionOrigin};
use agent_vitals_domain::domain::catalog_index::{self, SlotSupport};
use agent_vitals_harnesses::generic_manifest::CapabilitySet;
use agent_vitals_runtime_core::core::extension_objects::{ObjectStore, MAX_PAYLOAD_BYTES};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::extension_installer::{self, LocalInputBinding};
use super::local_manifest_install;

pub const OFFICIAL_INDEX_URL: &str = "https://raw.githubusercontent.com/Oh-Agent-AI/oh-agent/main/catalog/index.json";
pub const MAX_GROUP_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_GROUP_ENTRIES: usize = 64;

pub fn harness_slot_support() -> BTreeMap<String, SlotSupport> {
    let capabilities = CapabilitySet::default();
    BTreeMap::from([("harness_manifest".into(), SlotSupport {
        schemas:vec![1], capabilities:capabilities.recipes.iter().map(|r| format!("recipe:{r}"))
            .chain(capabilities.features.iter().map(|f| format!("feature:{f}"))).collect(),
    })])
}

/// Validates the whole index before constructing fixed, commit-pinned official URLs.
pub fn harness_dependency_group(index_bytes: &[u8], slug: &str) -> Result<Vec<Value>, String> {
    let index = catalog_index::parse_catalog(index_bytes).map_err(str::to_string)?;
    let hash = format!("{:x}", Sha256::digest(index_bytes));
    catalog_index::validate_catalog(&index, &harness_slot_support(), &CapabilitySet::default().app_version,
        &hash, None).map_err(str::to_string)?;
    let entries = index["entries"].as_array().ok_or("catalog entries missing")?;
    let mut pending = vec![slug.to_string()];
    let mut selected = BTreeMap::new();
    while let Some(id) = pending.pop() {
        if selected.contains_key(&id) { continue; }
        let entry = entries.iter().find(|e| e["slot_type"] == "harness_manifest" && e["slot_id"] == id)
            .ok_or_else(|| format!("catalog harness missing: {id}"))?;
        if selected.len() == MAX_GROUP_ENTRIES { return Err("catalog dependency group exceeds 64 entries".into()); }
        for dependency in entry["dependencies"].as_array().ok_or("catalog dependencies missing")? {
            if dependency["slot_type"] != "harness_manifest" { return Err("unsupported dependency handler".into()); }
            pending.push(dependency["slot_id"].as_str().ok_or("dependency identity")?.to_string());
        }
        selected.insert(id, entry.clone());
    }
    Ok(selected.into_values().collect())
}

pub fn official_payload_url(entry: &Value) -> Result<String, String> {
    // Reject unvalidated entries, even when called separately from group resolution.
    if !entry.is_object() { return Err("catalog entry shape".into()); }
    let mut index = json!({"index_schema_version":1,"catalog_sequence":0,
        "published_at":"2026-10-01T00:00:00Z","entries":[entry]});
    // Dependencies are checked against the complete index by harness_dependency_group.
    index["entries"][0]["dependencies"] = json!([]);
    catalog_index::validate_catalog(&index, &harness_slot_support(), &CapabilitySet::default().app_version,
        &"0".repeat(64), None).map_err(str::to_string)?;
    Ok(format!("https://raw.githubusercontent.com/Oh-Agent-AI/oh-agent/{}/{}",
        entry["revision"].as_str().ok_or("catalog revision")?,
        entry["payload_path"].as_str().ok_or("catalog path")?))
}

/// Call only after fetching index and payloads through the fixed official channel.
/// A local file/cache must use local_manifest_install and cannot acquire vendor origin.
/// Confirmation recomputes the entire dependency group's preview and commits one CAS.
#[allow(clippy::too_many_arguments)]
pub fn install_official_harness_group(index_bytes: &[u8], slug: &str,
    payloads: &BTreeMap<String, Vec<u8>>, release_local_pins: &[String],
    machine_namespace: &str, data_home: &Path, home: &Path,
    files: &[PathBuf], confirm: Option<&str>) -> Result<Value, String> {
    let entries = harness_dependency_group(index_bytes, slug)?;
    let selected: BTreeSet<_> = entries.iter().map(|e| e["slot_id"].as_str().unwrap().to_string()).collect();
    let pins: BTreeSet<_> = release_local_pins.iter().cloned().collect();
    if pins.len() != release_local_pins.len() || !pins.is_subset(&selected) {
        return Err("release_local_pins must name unique harnesses in the selected group".into());
    }
    if payloads.keys().cloned().collect::<BTreeSet<_>>() != selected {
        return Err("payload set must match the complete dependency group".into());
    }
    let mut total = 0_usize;
    let index_hash = format!("{:x}", Sha256::digest(index_bytes));
    let mut prepared = Vec::new();
    let mut group_manifests = Vec::new();
    for entry in &entries {
        let id = entry["slot_id"].as_str().unwrap();
        let raw = &payloads[id];
        total = total.checked_add(raw.len()).ok_or("catalog group bytes limit")?;
        if raw.len() > MAX_PAYLOAD_BYTES || total > MAX_GROUP_BYTES { return Err("catalog group bytes limit".into()); }
        let digest = format!("{:x}", Sha256::digest(raw));
        if entry["sha256"] != digest { return Err(format!("catalog payload hash mismatch: {id}")); }
        let payload: Value = serde_json::from_slice(raw).map_err(|e| format!("catalog payload JSON: {e}"))?;
        let group_manifest = agent_vitals_harnesses::generic_manifest::parse_manifest(payload.clone())
            .map_err(|e| format!("catalog manifest invalid: {e}"))?;
        for previous in &group_manifests {
            extension_installer::ensure_manifest_sources_exclusive(&group_manifest, previous, home)?;
        }
        let recipe = payload["recipe"].as_str().ok_or("payload recipe missing")?;
        if payload["slug"] != id || payload["manifest_version"] != entry["schema_version"]
            || payload["min_app_version"] != entry["min_app_version"]
            || extension_installer::canonical_value(&payload["requires"]) != extension_installer::canonical_value(&entry["requires"])
            || !entry["requires"]["recipes"].as_array().unwrap().iter().any(|r| r == recipe) {
            return Err(format!("catalog/payload contract mismatch: {id}"));
        }
        let commit = entry["revision"].as_str().unwrap();
        let revision = ExtensionRevision {
            revision_id:format!("vendor:harness_manifest:{id}:{commit}:{digest}:{index_hash}"),
            slot_type:"harness_manifest".into(), slot_id:id.into(), content_sha256:digest,
            origin:RevisionOrigin::VendorCatalog { source:OFFICIAL_INDEX_URL.into(),
                commit:commit.into(), index_sha256:index_hash.clone() },
            schema_version:entry["schema_version"].as_i64().ok_or("catalog schema")?,
            capabilities:entry["requires"].clone(), installed_at_ms:0,
        };
        let presentation_path = PathBuf::from("official-catalog").join(id).join("manifest.json");
        prepared.push(local_manifest_install::prepare_bytes(&presentation_path,
            raw.clone(), revision, machine_namespace, data_home, home, files, pins.contains(id))?);
        group_manifests.push(group_manifest);
    }
    let mut ticket = prepared[0].ticket.clone();
    ticket.new_revisions.clear();
    let mut impacts = BTreeMap::new();
    let mut all_active = true;
    for candidate in &prepared {
        if candidate.ticket.expected_generation != ticket.expected_generation {
            return Err("preview expired; active generation changed during group preview".into());
        }
        let key = ("harness_manifest".into(), candidate.slug.clone());
        ticket.target_map.insert(key.clone(), candidate.ticket.target_map[&key].clone());
        ticket.new_revisions.extend(candidate.ticket.new_revisions.clone());
        impacts.insert(candidate.slug.clone(), serde_json::to_value(&candidate.impact).map_err(|e| e.to_string())?);
        all_active &= candidate.already_active;
    }
    let commitment = extension_installer::canonical_value(&json!({"index_sha256":index_hash,
        "selected_harness":slug,"release_local_pins":pins,"impacts":impacts})).to_string();
    let binding_hash = format!("{:x}", Sha256::digest(commitment.as_bytes()));
    ticket.action = ActivationAction::Activate;
    ticket.local_input = Some(LocalInputBinding { machine_namespace:machine_namespace.into(),
        corpus_fingerprint:binding_hash.clone(), impact_sha256:binding_hash });
    let preview_hash = ticket.preview_sha256();
    if let Some(confirmed) = confirm {
        if confirmed != preview_hash { return Err("preview expired; preview the official catalog group again".into()); }
        if all_active {
            let db = AuthorityDb::open_readonly(&agent_vitals_data::authority::default_authority_path(data_home))
                .map_err(|e| e.to_string())?;
            if agent_vitals_data::extension_authority::current_generation(db.conn()).map_err(|e| e.to_string())?
                != ticket.expected_generation { return Err("preview expired; active generation changed".into()); }
            return Ok(json!({"state":"already_active","generation":ticket.expected_generation,"preview_sha256":preview_hash}));
        }
        let now = crate::clock::now_ms();
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(data_home), now)
            .map_err(|e| e.to_string())?;
        let root = data_home.join("state/extensions");
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let store = ObjectStore::open(&root).map_err(str::to_string)?;
        for candidate in &prepared {
            let staged = store.stage(&candidate.raw).map_err(str::to_string)?;
            let hash = format!("{:x}", Sha256::digest(&candidate.raw));
            let publish = store.install(Path::new(&staged), &hash);
            let discard = store.discard(&staged);
            publish.map_err(str::to_string)?;
            discard.map_err(str::to_string)?;
        }
        for revision in &mut ticket.new_revisions { revision.installed_at_ms = now; }
        let generation = extension_installer::commit(&db, &store, &ticket, now).map_err(|e| e.to_string())?;
        let warning = extension_installer::rebuild_registry_snapshot(data_home, &db, now)
            .err().map(|e| e.to_string());
        return Ok(json!({"state":"active","generation":generation,"preview_sha256":preview_hash,"warning":warning}));
    }
    Ok(json!({"state":"preview","origin":"vendor-catalog","generation":ticket.expected_generation,
        "preview_sha256":preview_hash,"harnesses":selected,"release_local_pins":pins,
        "impacts":impacts,"already_active":all_active}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::extension_authority as ledger;

    fn catalog(raw: &[u8], dependency: bool) -> (Vec<u8>, BTreeMap<String, Vec<u8>>) {
        let mut payload: Value = serde_json::from_slice(raw).unwrap();
        payload["requires"] = json!({"recipes":[payload["recipe"].clone()],"features":[]});
        payload["min_app_version"] = json!("1.0.0");
        let mut payloads = BTreeMap::new();
        let mut entries = Vec::new();
        for id in if dependency { vec!["zcode", "helper"] } else { vec!["zcode"] } {
            payload["slug"] = json!(id);
            if id == "helper" { payload["discovery"]["roots"] = json!(["~/other-data"]); }
            let bytes = serde_json::to_vec(&payload).unwrap();
            entries.push(json!({"slot_type":"harness_manifest","slot_id":id,
                "revision":"a".repeat(40),"payload_path":format!("catalog/harnesses/{id}/manifest.json"),
                "sha256":format!("{:x}", Sha256::digest(&bytes)),"schema_version":1,
                "requires":payload["requires"],"min_app_version":"1.0.0","display":id,"dependencies":[]}));
            payloads.insert(id.into(), bytes);
        }
        if dependency {
            entries[0]["dependencies"] = json!([{"slot_type":"harness_manifest","slot_id":"helper",
                "revision":entries[1]["revision"],"sha256":entries[1]["sha256"]}]);
        }
        (serde_json::to_vec(&json!({"index_schema_version":1,"catalog_sequence":7,
            "published_at":"2026-10-01T00:00:00Z","entries":entries})).unwrap(), payloads)
    }

    #[test]
    fn official_dependency_group_is_readonly_until_exact_confirmation() {
        let (home, data_home, manifest, file) = local_manifest_install::tests::fixture();
        let (index, payloads) = catalog(&std::fs::read(&manifest).unwrap(), true);
        let files = vec![file.clone()];
        let preview = install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files, None).unwrap();
        assert_eq!(preview["harnesses"], json!(["helper","zcode"]));
        assert!(!data_home.exists());
        let confirm = preview["preview_sha256"].as_str().unwrap();
        std::fs::write(&file, std::fs::read_to_string(&file).unwrap().replace("100", "101")).unwrap();
        assert!(install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files,
            Some(confirm)).unwrap_err().contains("preview expired"));
        let preview = install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files, None).unwrap();
        let active = install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files,
            preview["preview_sha256"].as_str()).unwrap();
        assert_eq!(active["generation"], 1);
        let db = AuthorityDb::open_readonly(&agent_vitals_data::authority::default_authority_path(&data_home)).unwrap();
        assert_eq!(ledger::generation_slots(db.conn(), 1).unwrap().len(), 2);
        let count: i64 = db.conn().query_row("SELECT COUNT(*) FROM extension_revisions WHERE origin='vendor-catalog' AND vendor_source=?1",
            [OFFICIAL_INDEX_URL], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
        let count: i64 = db.conn().query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        drop(db);
        let repeat = install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files, None).unwrap();
        assert_eq!(repeat["already_active"], true);
        assert_eq!(install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files,
            repeat["preview_sha256"].as_str()).unwrap()["state"], "already_active");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn local_pin_requires_exact_harness_release_and_a_new_preview() {
        let (home, data_home, manifest, file) = local_manifest_install::tests::fixture();
        let files = vec![file];
        let preview = local_manifest_install::local_manifest_install(&manifest, "m1", &data_home, &home, &files, None).unwrap();
        local_manifest_install::local_manifest_install(&manifest, "m1", &data_home, &home, &files,
            preview["preview_sha256"].as_str()).unwrap();
        let (index, payloads) = catalog(&std::fs::read(&manifest).unwrap(), false);
        assert!(install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files, None)
            .unwrap_err().contains("local pin protected"));
        let pins = vec!["zcode".to_string()];
        let preview = install_official_harness_group(&index, "zcode", &payloads, &pins, "m1", &data_home, &home, &files, None).unwrap();
        assert!(install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files,
            preview["preview_sha256"].as_str()).is_err());
        let active = install_official_harness_group(&index, "zcode", &payloads, &pins, "m1", &data_home, &home, &files,
            preview["preview_sha256"].as_str()).unwrap();
        assert_eq!(active["generation"], 2);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn bad_dependency_payload_and_contract_fail_without_activation() {
        let (home, data_home, manifest, file) = local_manifest_install::tests::fixture();
        let (index, mut payloads) = catalog(&std::fs::read(&manifest).unwrap(), true);
        payloads.get_mut("helper").unwrap().push(b' ');
        assert!(install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, std::slice::from_ref(&file), None)
            .unwrap_err().contains("hash mismatch"));
        assert!(!data_home.exists());
        let (index, payloads) = catalog(&std::fs::read(&manifest).unwrap(), false);
        let mut index: Value = serde_json::from_slice(&index).unwrap();
        index["entries"][0]["requires"]["recipes"] = json!([]);
        assert!(install_official_harness_group(&serde_json::to_vec(&index).unwrap(), "zcode", &payloads,
            &[], "m1", &data_home, &home, &[file], None).unwrap_err().contains("contract mismatch"));
        assert!(!data_home.exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn payload_url_uses_commit_and_rejects_external_or_parent_paths() {
        let (home, _, manifest, _) = local_manifest_install::tests::fixture();
        let (index, _) = catalog(&std::fs::read(&manifest).unwrap(), false);
        let index: Value = serde_json::from_slice(&index).unwrap();
        let mut entry = index["entries"][0].clone();
        assert_eq!(official_payload_url(&entry).unwrap(), format!(
            "https://raw.githubusercontent.com/Oh-Agent-AI/oh-agent/{}/catalog/harnesses/zcode/manifest.json", "a".repeat(40)));
        for path in ["../private.json", "https://evil.example/payload.json", "/catalog/a.json"] {
            entry["payload_path"] = json!(path);
            assert!(official_payload_url(&entry).is_err());
        }
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn dependency_pin_is_not_released_by_selecting_another_harness() {
        let (home, data_home, manifest, file) = local_manifest_install::tests::fixture();
        let raw = std::fs::read(&manifest).unwrap();
        let helper_path = home.join("harnesses.d/helper/manifest.json");
        std::fs::create_dir_all(helper_path.parent().unwrap()).unwrap();
        let mut helper: Value = serde_json::from_slice(&raw).unwrap();
        helper["slug"] = json!("helper");
        helper["discovery"]["roots"] = json!(["~/other-data"]);
        std::fs::write(&helper_path, serde_json::to_vec(&helper).unwrap()).unwrap();
        let files = vec![file];
        let local = local_manifest_install::local_manifest_install(&helper_path, "m1", &data_home, &home, &files, None).unwrap();
        local_manifest_install::local_manifest_install(&helper_path, "m1", &data_home, &home, &files,
            local["preview_sha256"].as_str()).unwrap();
        let (index, payloads) = catalog(&raw, true);
        assert!(install_official_harness_group(&index, "zcode", &payloads, &["zcode".into()], "m1",
            &data_home, &home, &files, None).unwrap_err().contains("harness:helper"));
        let preview = install_official_harness_group(&index, "zcode", &payloads, &["helper".into()], "m1",
            &data_home, &home, &files, None).unwrap();
        let active = install_official_harness_group(&index, "zcode", &payloads, &["helper".into()], "m1",
            &data_home, &home, &files, preview["preview_sha256"].as_str()).unwrap();
        assert_eq!(active["generation"], 2);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn catalog_and_generation_changes_expire_confirmation_and_preserve_other_slots() {
        let (home, data_home, manifest, file) = local_manifest_install::tests::fixture();
        let (index, payloads) = catalog(&std::fs::read(&manifest).unwrap(), true);
        let files = vec![file];
        let preview = install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files, None).unwrap();
        let mut changed_index: Value = serde_json::from_slice(&index).unwrap();
        changed_index["catalog_sequence"] = json!(8);
        assert!(install_official_harness_group(&serde_json::to_vec(&changed_index).unwrap(), "zcode", &payloads,
            &[], "m1", &data_home, &home, &files, preview["preview_sha256"].as_str()).unwrap_err().contains("preview expired"));
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(&data_home), 1).unwrap();
        let root = data_home.join("state/extensions");
        std::fs::create_dir_all(&root).unwrap();
        let store = ObjectStore::open(&root).unwrap();
        let raw = br#"{"card":"unrelated"}"#;
        let digest = format!("{:x}", Sha256::digest(raw));
        let stage = store.stage(raw).unwrap();
        store.install(Path::new(&stage), &digest).unwrap();
        store.discard(&stage).unwrap();
        let revision = ExtensionRevision { revision_id:"other-price".into(), slot_type:"price_card".into(),
            slot_id:"other".into(), content_sha256:digest, origin:RevisionOrigin::Local,
            schema_version:1, capabilities:json!({}), installed_at_ms:1 };
        let slots = BTreeMap::from([(("price_card".into(),"other".into()), "other-price".into())]);
        ledger::activate(db.conn(), 0, &[revision], &slots, &"0".repeat(64), ActivationAction::Activate, 1).unwrap();
        assert!(install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files,
            preview["preview_sha256"].as_str()).unwrap_err().contains("preview expired"));
        assert_eq!(ledger::generation_slots(db.conn(), 1).unwrap(), slots);
        let fresh = install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files, None).unwrap();
        install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files,
            fresh["preview_sha256"].as_str()).unwrap();
        assert_eq!(ledger::generation_slots(db.conn(), 2).unwrap().get(&("price_card".into(),"other".into())),
            Some(&"other-price".into()));
        drop(db);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn publication_failure_cannot_partially_activate_a_dependency_group() {
        let (home, data_home, manifest, file) = local_manifest_install::tests::fixture();
        let (index, payloads) = catalog(&std::fs::read(&manifest).unwrap(), true);
        let files = vec![file];
        let preview = install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files, None).unwrap();
        let root = data_home.join("state/extensions");
        std::fs::create_dir_all(&root).unwrap();
        let store = ObjectStore::open(&root).unwrap();
        let bad_hash = format!("{:x}", Sha256::digest(&payloads["zcode"]));
        let corrupt = root.join("objects").join(&bad_hash);
        std::fs::create_dir(&corrupt).unwrap();
        std::fs::write(corrupt.join("payload.json"), b"{}").unwrap();
        assert!(install_official_harness_group(&index, "zcode", &payloads, &[], "m1", &data_home, &home, &files,
            preview["preview_sha256"].as_str()).unwrap_err().contains("object_hash"));
        let db = AuthorityDb::open_readonly(&agent_vitals_data::authority::default_authority_path(&data_home)).unwrap();
        assert_eq!(ledger::current_generation(db.conn()).unwrap(), 0);
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM extension_revisions", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert!(store.load(&format!("{:x}", Sha256::digest(&payloads["helper"]))).is_ok());
        assert_eq!(std::fs::read_dir(root.join("staging")).unwrap().count(), 0);
        drop(db);
        std::fs::remove_dir_all(home).unwrap();
    }
}
