use agent_vitals_data::{authority::{AuthorityDb, default_authority_path}, extension_authority::*};
use agent_vitals_query::query::{app_harnesses, app_local};
use agent_vitals_runtime_core::core::extension_objects::ObjectStore;
use serde_json::json;
use sha2::{Digest, Sha256};

#[test]
fn preview_install_normal_ingest_and_uninstall_preserve_plugin_statistics() {
    use agent_vitals_ingest::ingest::{local_manifest_install::local_manifest_install,
        local_manifest_lifecycle::{local_harness_change, HarnessChange}};
    let _lock = agent_vitals_query::ENV_LOCK.lock().unwrap();
    let root = std::env::temp_dir().join(format!("av-harness-lifecycle-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let user_home = root.join("user");
    let data_home = root.join("authority");
    let source = user_home.join("synthetic/s_demo.jsonl");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    let now = agent_vitals_query::clock::now_ms();
    std::fs::write(&source, json!({"requestId":"r1","attempt":1,
        "completedAt":jiff::Timestamp::from_millisecond(now).unwrap().to_string(),
        "model":{"modelId":"fixture-model","providerId":"custom"},
        "response":{"providerMetadata":{"anthropic":{"usage":{"input_tokens":100,"output_tokens":5}}}}}).to_string()+"\n").unwrap();
    let manifest = root.join("gamma-agent/manifest.json");
    std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
    std::fs::write(&manifest, json!({"manifest_version":1,"slug":"gamma-agent","display":{"name":"Gamma Agent"},
        "discovery":{"roots":["~/synthetic"],"include":["s_*.jsonl"]},"source":{"format":"jsonl"},
        "session":{"from":"filename","pattern":r"^s_(?P<id>.+)\.jsonl$"},"recipe":"request-usage-anthropic-v1",
        "overrides":{"event_ts":"completedAt","model_raw":"model.modelId","provider_raw":"model.providerId",
            "uncached_input_tokens":"response.providerMetadata.anthropic.usage.input_tokens",
            "output_tokens":"response.providerMetadata.anthropic.usage.output_tokens","provider_request_id":"requestId"},
        "event_key":{"paths":["requestId","attempt"]},"billing":{"policy":"lock:metered_estimate"}}).to_string()).unwrap();
    let files = vec![source];
    let preview = local_manifest_install(&manifest,"fixture-machine",&data_home,&user_home,&files,None).unwrap();
    assert_eq!(preview["impact"]["candidate_facts"],1);
    assert!(!default_authority_path(&data_home).exists());
    local_manifest_install(&manifest,"fixture-machine",&data_home,&user_home,&files,preview["preview_sha256"].as_str()).unwrap();
    let before = app_harnesses::list(&data_home).unwrap()["data_revision"].as_u64().unwrap();
    let ingest = agent_vitals_ingest::plugin_ingest::ingest_installed("fixture-machine",&data_home,&user_home);
    assert!(ingest.iter().all(|(_, result)| result.is_ok()), "normal ingestion failed: {ingest:?}");
    let list = app_harnesses::list(&data_home).unwrap();
    let revision = list["data_revision"].as_u64().unwrap();
    assert!(revision > before);
    let stats = app_harnesses::sessions(&data_home,"harness:gamma-agent",30,now+1000,revision,"metrics").unwrap();
    assert_eq!(stats["coverage"]["total"],1);
    assert_eq!(stats["sessions"][0]["tokens"]["total"],105);
    let city = app_local::city_projection(&data_home,30,now+1000).unwrap();
    assert_eq!(city["sessions"][0]["harness"],"harness:gamma-agent");
    // Exercise a real installed-source failure and retry, not only receipt
    // classification: removing the source fails closed, restoring it allows
    // normal sync to recover without duplicating the already-ingested fact.
    let unavailable_source = files[0].with_extension("jsonl.unavailable");
    std::fs::rename(&files[0], &unavailable_source).unwrap();
    let failed = agent_vitals_ingest::plugin_ingest::ingest_installed("fixture-machine",&data_home,&user_home);
    assert!(failed.iter().any(|(_, result)| result.is_err()), "missing source must remain diagnosable: {failed:?}");
    std::fs::rename(&unavailable_source, &files[0]).unwrap();
    let recovered = agent_vitals_ingest::plugin_ingest::ingest_installed("fixture-machine",&data_home,&user_home);
    assert!(recovered.iter().all(|(_, result)| result.is_ok()), "restored source should recover on retry: {recovered:?}");
    let repeat = agent_vitals_ingest::plugin_ingest::ingest_installed("fixture-machine",&data_home,&user_home);
    assert!(repeat.iter().all(|(_, result)| result.is_ok()));
    let db = AuthorityDb::open_readonly(&default_authority_path(&data_home)).unwrap();
    let count: i64 = db.conn().query_row("SELECT COUNT(*) FROM usage_facts",[],|r|r.get(0)).unwrap();
    assert_eq!(count,1,"repeat sync must not double count");
    drop(db);
    let preview = local_harness_change(&data_home,&user_home,"gamma-agent",HarnessChange::Uninstall,&[],None,None).unwrap();
    local_harness_change(&data_home,&user_home,"gamma-agent",HarnessChange::Uninstall,&[],None,preview["preview_sha256"].as_str()).unwrap();
    let list = app_harnesses::list(&data_home).unwrap();
    let stats = app_harnesses::sessions(&data_home,"harness:gamma-agent",30,now+1000,list["data_revision"].as_u64().unwrap(),"metrics").unwrap();
    assert_eq!(stats["sessions"][0]["tokens"]["total"],105);
    let inventory = app_harnesses::inventory(&data_home,30,now+1000).unwrap();
    let row = inventory["harnesses"].as_array().unwrap().iter().find(|h|h["id"]=="harness:gamma-agent").unwrap();
    assert_eq!(row["registration_state"],"inactive_history");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn generic_plugin_face_tracks_activation_history_revision_and_corruption() {
    let home = std::env::temp_dir().join(format!("av-harness-face-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let now = 1_791_014_400_000i64;
    assert_eq!(app_harnesses::list(&home), Err("data_unavailable"));
    assert!(!default_authority_path(&home).exists());
    let db = AuthorityDb::open(&default_authority_path(&home), now).unwrap();
    db.begin_run("fixture", "cli", now).unwrap();
    let manifest = |slug: &str, name: &str| json!({"manifest_version":1,"slug":slug,"display":{"name":name},
        "discovery":{"roots":["~/.synthetic/rollout"],"include":["s_*.jsonl"]},"source":{"format":"jsonl"},
        "session":{"from":"filename","pattern":r"^s_(?P<id>.+)\.jsonl$"},
        "recipe":"request-usage-anthropic-v1","event_key":{"paths":["requestId"]}});
    let candidate = home.join("harnesses.d/candidate-agent/manifest.json");
    std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
    std::fs::write(&candidate, manifest("candidate-agent", "Candidate").to_string()).unwrap();
    let bad_candidate = home.join("harnesses.d/bad-agent/manifest.json");
    std::fs::create_dir_all(bad_candidate.parent().unwrap()).unwrap();
    std::fs::write(&bad_candidate, b"not json; private path and details must not escape").unwrap();
    assert!(!app_harnesses::list(&home).unwrap().to_string().contains("candidate-agent"));
    let initial_inventory = app_harnesses::inventory(&home, 30, now).unwrap();
    assert!(initial_inventory.to_string().contains("activation_required"));
    assert_eq!(initial_inventory["invalid_candidates"][0]["id"], "harness:bad-agent");
    assert_eq!(initial_inventory["invalid_candidates"][0]["registration_state"], "invalid");
    assert_eq!(initial_inventory["invalid_candidates"][0]["diagnostic"], "manifest_invalid");
    assert!(!initial_inventory.to_string().contains("private path"));
    assert!(!initial_inventory.to_string().contains("manifest.json"));
    std::fs::create_dir_all(home.join("state/extensions")).unwrap();
    let store = ObjectStore::open(&home.join("state/extensions")).unwrap();
    let mut slots = SlotMap::new();
    let mut revisions = Vec::new();
    let mut hashes = Vec::new();
    for (slug, name) in [("alpha-agent", "Alpha Agent"), ("beta-agent", "Beta Agent")] {
        let bytes = manifest(slug, name).to_string().into_bytes();
        let staged = store.stage(&bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        store.install(std::path::Path::new(&staged), &hash).unwrap();
        slots.insert(("harness_manifest".into(), slug.into()), slug.into());
        revisions.push(ExtensionRevision { revision_id:slug.into(),slot_type:"harness_manifest".into(),slot_id:slug.into(),
            content_sha256:hash.clone(),origin:RevisionOrigin::Local,schema_version:1,capabilities:json!({}),installed_at_ms:now });
        hashes.push(hash);
    }
    activate(db.conn(), 0, &revisions, &slots, &"a".repeat(64), ActivationAction::Activate, now).unwrap();
    for (key, harness) in [("private-a", "harness:alpha-agent"), ("private-b", "harness:beta-agent"), ("private-c", "codex")] {
        db.conn().execute("INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms)
            VALUES(?1,?2,?1,'private-machine',?3)", rusqlite::params![key,harness,now]).unwrap();
        db.conn().execute("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,session_key,source_event_id,
            observation_kind,event_ts_ms,uncached_input_tokens,output_tokens,ingested_run_id,created_at_ms,updated_at_ms)
            VALUES(?1,?2,'private-machine',?1,?1,'private-event','delta',?3,10,20,'fixture',?3,?3)",
            rusqlite::params![key,harness,now]).unwrap();
    }
    let list = app_harnesses::list(&home).unwrap();
    let revision = list["data_revision"].as_u64().unwrap();
    for id in ["codex", "harness:alpha-agent", "harness:beta-agent"] {
        let data = app_harnesses::sessions(&home, id, 30, now, revision, "test-plugin").unwrap();
        assert_eq!(data["coverage"]["total"], 1);
        assert_eq!(data["sessions"][0]["tokens"]["total"], 30);
        assert!(!data.to_string().contains("private-"));
        assert_eq!(app_harnesses::sessions(&home, id, 30, now, revision+1, "test-plugin"), Err("revision_changed"));
        let other = app_harnesses::sessions(&home, id, 30, now, revision, "other-plugin").unwrap();
        assert_ne!(data["sessions"][0]["id"], other["sessions"][0]["id"]);
    }
    let city = app_local::city_projection(&home, 30, now).unwrap();
    assert_eq!(city["protocol"], "city:v2");
    assert!(city["sessions"].as_array().unwrap().iter().any(|s| s["harness"] == "harness:alpha-agent"));
    for forbidden in ["origin", "registration_state", "manifest_path", "compiled", "private-machine"] {
        assert!(!list.to_string().contains(forbidden));
    }
    let alpha = list["harnesses"].as_array().unwrap().iter().find(|h| h["id"] == "harness:alpha-agent").unwrap();
    assert_eq!(alpha["display_name"], "Alpha Agent");
    assert_eq!(alpha["capabilities"]["findings"]["available"], false);
    std::fs::write(home.join("state/extensions/objects").join(&hashes[0]).join("payload.json"), b"{}").unwrap();
    let inventory = app_harnesses::inventory(&home, 30, now).unwrap();
    let alpha = inventory["harnesses"].as_array().unwrap().iter().find(|h| h["id"] == "harness:alpha-agent").unwrap();
    assert_eq!(alpha["registration_state"], "invalid");
    assert_eq!(alpha["diagnostic"], "manifest_metadata_unavailable");
    assert_eq!(alpha["data_state"], "ready", "bad metadata does not erase historical statistics");
    activate(db.conn(), 1, &[], &SlotMap::new(), &"b".repeat(64), ActivationAction::Uninstall, now+1).unwrap();
    assert_eq!(app_harnesses::sessions(&home, "codex", 30, now, revision, "test-plugin"), Err("revision_changed"));
    let latest = app_harnesses::list(&home).unwrap()["data_revision"].as_u64().unwrap();
    assert_eq!(app_harnesses::sessions(&home, "harness:beta-agent", 30, now, latest, "test-plugin").unwrap()["status"], "ready");
    assert_eq!(app_harnesses::sessions(&home, "harness:beta-agent", 7, now+40*86_400_000, latest, "test-plugin").unwrap()["status"], "empty");
    assert_eq!(app_harnesses::sessions(&home, "unregistered", 30, now, latest, "test-plugin"), Err("harness_unavailable"));
    drop(db);
    std::fs::remove_dir_all(home).unwrap();
}
