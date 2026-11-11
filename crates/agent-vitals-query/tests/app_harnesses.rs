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

#[test]
fn generic_session_detail_uses_plugin_scoped_handle_and_opt_in_lifetime_excerpts() {
    let home = std::env::temp_dir().join(format!("av-session-detail-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let now = agent_vitals_query::clock::now_ms();
    let db = AuthorityDb::open(&default_authority_path(&home), now).unwrap();
    db.begin_run("fixture", "cli", now).unwrap();
    db.conn().execute("INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms,title,title_source)
        VALUES('private-session-key','codex','private-native-session','private-machine',?1,'Safe title','codex_thread_name')", [now]).unwrap();
    db.conn().execute("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,session_key,source_event_id,
        observation_kind,event_ts_ms,uncached_input_tokens,output_tokens,model_id,ingested_run_id,created_at_ms,updated_at_ms)
        VALUES('private-fact','codex','private-machine','private-native-session','private-session-key','private-event','delta',?1,10,5,'test-model','fixture',?2,?2)",
        rusqlite::params![now - 1_000, now]).unwrap();
    db.conn().execute("INSERT INTO session_excerpts(session_key,ordinal,role,excerpt,provenance,ingested_run_id)
        VALUES('private-session-key',1,'user_first','Review this local project','scrubbed','fixture')", []).unwrap();
    let revision = db.revision().unwrap();
    drop(db);

    let page = app_harnesses::sessions_page(&home, "codex", 30, now, revision, "city", 0, 10).unwrap();
    let handle = page["sessions"][0]["id"].as_str().unwrap();
    let without_excerpts = app_harnesses::session_detail(&home, "city", handle, 30, now, revision, false).unwrap();
    assert_eq!(without_excerpts["protocol"], "harness-session-detail:v1");
    assert_eq!(without_excerpts["data_revision"], revision);
    assert_eq!(without_excerpts["session"]["id"], handle);
    assert_eq!(without_excerpts["session"]["tokens"]["total"], 15);
    assert!(without_excerpts["session"].get("excerpts").is_none());
    assert!(!without_excerpts.to_string().contains("private-session-key"));
    assert!(!without_excerpts.to_string().contains("private-native-session"));
    assert!(!without_excerpts.to_string().contains("private-machine"));

    let with_excerpts = app_harnesses::session_detail(&home, "city", handle, 30, now, revision, true).unwrap();
    assert_eq!(with_excerpts["session"]["excerpt_scope"], "session_lifetime");
    assert_eq!(with_excerpts["session"]["excerpts"].as_array().unwrap().len(), 1);
    assert_eq!(with_excerpts["session"]["excerpts"][0]["role"], "user_first");
    assert_eq!(with_excerpts["session"]["excerpts"][0]["provenance"], "scrubbed");
    assert!(!with_excerpts.to_string().contains("private-session-key"));
    assert_eq!(app_harnesses::session_detail(&home, "other-plugin", handle, 30, now, revision, false), Err("session_unavailable"));
    assert_eq!(app_harnesses::session_detail(&home, "city", handle, 30, now, revision + 1, false), Err("revision_changed"));
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn generic_activity_summary_returns_bounded_timezone_calendar_buckets() {
    let home = std::env::temp_dir().join(format!("av-activity-summary-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let now = agent_vitals_query::clock::now_ms();
    let db = AuthorityDb::open(&default_authority_path(&home), now).unwrap();
    db.begin_run("fixture", "cli", now).unwrap();
    for (key, event_ts) in [("synthetic-a", now - 1_000), ("synthetic-b", now - 86_401_000)] {
        db.conn().execute("INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms)
            VALUES(?1,'codex',?1,'synthetic-machine',?2)", rusqlite::params![key, now]).unwrap();
        db.conn().execute("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,session_key,
            source_event_id,observation_kind,event_ts_ms,uncached_input_tokens,cache_read_tokens,cache_write_tokens,
            output_tokens,ingested_run_id,created_at_ms,updated_at_ms)
            VALUES(?1,'codex','synthetic-machine',?1,?1,?1,'delta',?2,10,2,3,5,'fixture',?3,?3)",
            rusqlite::params![key, event_ts, now]).unwrap();
    }
    let revision = db.revision().unwrap();
    drop(db);

    let activity = app_harnesses::activity_summary(&home, 7, "UTC", now, revision).unwrap();
    assert_eq!(activity["protocol"], "activity-summary:v1");
    assert_eq!(activity["data_revision"], revision);
    assert_eq!(activity["window"]["days"], 7);
    assert_eq!(activity["timezone"], "UTC");
    let days = activity["days"].as_array().unwrap();
    assert_eq!(days.len(), 2);
    assert!(days.iter().all(|day| day["session_count"] == 1 && day["event_count"] == 1 && day["tokens"] == 20));
    assert_eq!(days[0].as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
        vec!["date", "session_count", "event_count", "tokens"]);
    assert!(!activity.to_string().contains("synthetic-a"));
    assert!(!activity.to_string().contains("codex"));
    assert_eq!(app_harnesses::activity_summary(&home, 7, "UTC", now, revision + 1), Err("revision_changed"));
    assert_eq!(app_harnesses::activity_summary(&home, 30, "not/a-timezone", now, revision), Err("invalid_timezone"));
    assert_eq!(app_harnesses::activity_summary(&home, 14, "UTC", now, revision), Err("invalid_window"));
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn generic_activity_summary_respects_dst_calendar_boundaries() {
    let home = std::env::temp_dir().join(format!("av-activity-dst-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let now = agent_vitals_query::clock::now_ms();
    let db = AuthorityDb::open(&default_authority_path(&home), now).unwrap();
    db.begin_run("fixture", "cli", now).unwrap();
    for (key, event_ts) in [
        ("before-gap", "2026-03-08T06:59:00Z"),
        ("after-gap", "2026-03-08T07:01:00Z"),
        ("next-day", "2026-03-09T04:00:00Z"),
    ] {
        let event_ts = event_ts.parse::<jiff::Timestamp>().unwrap().as_millisecond();
        db.conn().execute("INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms)
            VALUES(?1,'codex',?1,'synthetic-machine',?2)", rusqlite::params![key, now]).unwrap();
        db.conn().execute("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,session_key,
            source_event_id,observation_kind,event_ts_ms,uncached_input_tokens,output_tokens,ingested_run_id,created_at_ms,updated_at_ms)
            VALUES(?1,'codex','synthetic-machine',?1,?1,?1,'delta',?2,1,1,'fixture',?3,?3)",
            rusqlite::params![key, event_ts, now]).unwrap();
    }
    let revision = db.revision().unwrap();
    drop(db);

    let activity = app_harnesses::activity_summary(&home, 366, "America/New_York", now, revision).unwrap();
    let days = activity["days"].as_array().unwrap();
    let march_8 = days.iter().find(|day| day["date"] == "2026-03-08").unwrap();
    let march_9 = days.iter().find(|day| day["date"] == "2026-03-09").unwrap();
    assert_eq!(march_8["event_count"], 2);
    assert_eq!(march_9["event_count"], 1);
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn generic_model_usage_summary_preserves_unknown_legacy_and_token_buckets() {
    let home = std::env::temp_dir().join(format!("av-model-usage-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let now = agent_vitals_query::clock::now_ms();
    let db = AuthorityDb::open(&default_authority_path(&home), now).unwrap();
    db.begin_run("fixture", "cli", now).unwrap();
    for key in ["synthetic-a", "synthetic-b", "synthetic-c"] {
        db.conn().execute("INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms)
            VALUES(?1,'codex',?1,'synthetic-machine',?2)", rusqlite::params![key, now]).unwrap();
    }
    let facts = [
        ("fact-a", "synthetic-a", Some("model-a"), "delta", 10, 2, 3, 5),
        ("fact-b", "synthetic-b", Some("model-a"), "delta", 1, 0, 0, 4),
        ("fact-c", "synthetic-c", None, "legacy_aggregate", 0, 0, 0, 7),
        ("fact-d", "synthetic-c", Some("<unknown>"), "delta", 0, 0, 0, 2),
    ];
    for (fact, session, model, kind, uncached, cache_read, cache_write, output) in facts {
        db.conn().execute("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,session_key,source_event_id,
            observation_kind,event_ts_ms,uncached_input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,model_id,
            ingested_run_id,created_at_ms,updated_at_ms)
            VALUES(?1,'codex','synthetic-machine',?2,?2,?1,?3,?4,?5,?6,?7,?8,?9,'fixture',?4,?4)",
            rusqlite::params![fact, session, kind, now - 1_000, uncached, cache_read, cache_write, output, model]).unwrap();
    }
    let revision = db.revision().unwrap();
    drop(db);

    let result = app_harnesses::model_usage_summary(&home, 30, now, revision).unwrap();
    assert_eq!(result["protocol"], "model-usage:v1");
    assert_eq!(result["scope"], "window");
    assert_eq!(result["pricing_independent"], true);
    assert_eq!(result["coverage"], json!({"unknown_model_usage_events":2,"legacy_usage_events":1}));
    assert_eq!(result["models"].as_array().unwrap().len(), 2);
    let unknown = result["models"].as_array().unwrap().iter().find(|row| row["model_id"].is_null()).unwrap();
    assert_eq!(unknown["usage_event_count"], 2);
    assert_eq!(unknown["legacy_usage_event_count"], 1);
    assert_eq!(unknown["tokens"], json!({"uncached_input":0,"cache_read":0,"cache_write":0,"input":0,"output":9,"total":9}));
    let known = result["models"].as_array().unwrap().iter().find(|row| row["model_id"] == "model-a").unwrap();
    assert_eq!(known["usage_event_count"], 2);
    assert_eq!(known["tokens"], json!({"uncached_input":11,"cache_read":2,"cache_write":3,"input":16,"output":9,"total":25}));
    for forbidden in ["synthetic-a", "synthetic-machine", "codex"] { assert!(!result.to_string().contains(forbidden)); }
    assert_eq!(app_harnesses::model_usage_summary(&home, 30, now, revision + 1), Err("revision_changed"));
    assert_eq!(app_harnesses::model_usage_summary(&home, 14, now, revision), Err("invalid_window"));
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn generic_time_coverage_keeps_lifetime_denominator_and_categories() {
    let home = std::env::temp_dir().join(format!("av-time-coverage-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let now = agent_vitals_query::clock::now_ms();
    let db = AuthorityDb::open(&default_authority_path(&home), now).unwrap();
    db.begin_run("fixture", "cli", now).unwrap();
    for key in ["unknown-time", "mixed-time", "no-usage"] {
        db.conn().execute("INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms)
            VALUES(?1,'codex',?1,'synthetic-machine',?2)", rusqlite::params![key, now]).unwrap();
    }
    for (fact, session, event_ts) in [("fact-unknown", "unknown-time", None),
        ("fact-mixed-timed", "mixed-time", Some(now - 1_000)), ("fact-mixed-untimed", "mixed-time", None)] {
        db.conn().execute("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,session_key,source_event_id,
            observation_kind,event_ts_ms,uncached_input_tokens,output_tokens,ingested_run_id,created_at_ms,updated_at_ms)
            VALUES(?1,'codex','synthetic-machine',?2,?2,?1,'delta',?3,1,1,'fixture',?4,?4)",
            rusqlite::params![fact, session, event_ts, now]).unwrap();
    }
    let revision = db.revision().unwrap();
    drop(db);

    let coverage = app_harnesses::time_coverage(&home, revision).unwrap();
    assert_eq!(coverage, json!({"protocol":"time-coverage:v1","data_revision":revision,
        "scope":"all_non_deleted_sessions","unknown_time_only":1,"mixed_time":1,"excluded_no_usage":1}));
    for forbidden in ["unknown-time", "mixed-time", "no-usage", "synthetic-machine", "codex"] {
        assert!(!coverage.to_string().contains(forbidden));
    }
    assert_eq!(app_harnesses::time_coverage(&home, revision + 1), Err("revision_changed"));
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn generic_finding_summary_keeps_distinct_scopes_capability_and_redaction() {
    let home = std::env::temp_dir().join(format!("av-finding-summary-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let now = agent_vitals_query::clock::now_ms();
    let db = AuthorityDb::open(&default_authority_path(&home), now).unwrap();
    db.begin_run("fixture", "cli", now).unwrap();
    db.conn().execute("INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms)
        VALUES('unsupported-session','harness:unavailable-agent','native-private','machine-private',?1)", [now]).unwrap();
    db.conn().execute("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,session_key,
        source_event_id,observation_kind,event_ts_ms,uncached_input_tokens,output_tokens,ingested_run_id,created_at_ms,updated_at_ms)
        VALUES('private-fact','harness:unavailable-agent','machine-private','native-private','unsupported-session',
        'private-event','delta',?1,1,1,'fixture',?1,?1)", [now]).unwrap();
    for (id, harness, issue_type, fingerprint, status, severity, opened) in [
        ("private-old-backlog", "codex", "private-category", "private-fingerprint-old", "open", "warning", now - 40 * 86_400_000),
        ("private-new-closed", "codex", "private-category", "private-fingerprint-new", "closed", "critical", now - 1_000),
        ("private-unsupported", "harness:unavailable-agent", "private-category", "private-fingerprint-unsupported", "open", "info", now - 1_000),
    ] {
        db.conn().execute("INSERT INTO issue_instances(issue_id,machine_namespace,harness,issue_type,instance_fingerprint,status,
            severity,evaluator_id,evaluator_version,evidence_fingerprint,opened_at_ms,metadata_json)
            VALUES(?1,'machine-private',?2,?3,?4,?5,?6,'private-evaluator','1','private-evidence',?7,'{\"private\":true}')",
            rusqlite::params![id,harness,issue_type,fingerprint,status,severity,opened]).unwrap();
    }
    let revision = db.revision().unwrap();
    drop(db);

    let result = app_harnesses::finding_summary(&home, 30, now, revision).unwrap();
    assert_eq!(result["protocol"], "finding-summary:v1");
    assert_eq!(result["window"]["days"], 30);
    assert_eq!(result["current_backlog"], json!([{"harness_id":"codex","severity":"warning","count":1}]));
    assert_eq!(result["window_new"], json!([{"harness_id":"codex","severity":"critical","count":1}]));
    let unsupported = result["capabilities"].as_array().unwrap().iter()
        .find(|item| item["harness_id"] == "harness:unavailable-agent").unwrap();
    assert_eq!(unsupported["available"], false);
    assert_eq!(unsupported["reason"], "findings_not_supported");
    for forbidden in ["private-old-backlog", "private-new-closed", "private-unsupported", "private-category",
        "private-fingerprint", "private-evidence", "private-evaluator", "private-event", "machine-private", "native-private"] {
        assert!(!result.to_string().contains(forbidden), "finding DTO leaked {forbidden}");
    }
    assert_eq!(app_harnesses::finding_summary(&home, 30, now, revision + 1), Err("revision_changed"));
    assert_eq!(app_harnesses::finding_summary(&home, 14, now, revision), Err("invalid_window"));
    std::fs::remove_dir_all(home).unwrap();
}
