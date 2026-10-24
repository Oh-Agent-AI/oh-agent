use agent_vitals_data::authority::{AuthorityDb, default_authority_path};
use agent_vitals_query::query::app_local::city_projection;

#[test]
#[ignore = "explicit local installation check; never used in CI"]
fn local_installation_projection_smoke() {
    let result = city_projection(&agent_vitals_query::home::data_home(), 30,
        agent_vitals_query::clock::now_ms()).unwrap();
    assert_eq!(result["source"], "local");
    assert!(result["sessions"].as_array().unwrap().len() <= 4_000);
    // 由远到近：first_event_at 单调不减（城市生长与回放的顺序）。
    let firsts: Vec<&str> = result["sessions"].as_array().unwrap().iter().map(|s| s["first_event_at"].as_str().unwrap()).collect();
    assert!(firsts.windows(2).all(|w| w[0] <= w[1]), "sessions are returned oldest first");
    println!("Local projection: status={}, sessions={}, total={}, revision={}",
        result["status"], result["coverage"]["returned"], result["coverage"]["total"], result["data_revision"]);
}

#[test]
fn local_projection_is_bounded_redacted_window_scoped_and_honest() {
    let dir = std::env::temp_dir().join(format!("av-app-local-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let now = 1_791_014_400_000i64;
    assert_eq!(city_projection(&dir, 30, now), Err("data_unavailable"));
    assert!(!default_authority_path(&dir).exists(), "read must not create an empty database");
    assert_eq!(city_projection(&dir, 0, now), Err("invalid_window"));
    let db = AuthorityDb::open(&default_authority_path(&dir), now).unwrap();
    db.begin_run("fixture", "cli", now).unwrap();
    for (key, harness, ts) in [("private-native-session", "codex", Some(now)),
        ("untitled-session", "codex", Some(now)),
        ("old-session", "codex", Some(now - 40 * 86_400_000)),
        ("unknown-session", "private-harness-name", None)] {
        db.conn().execute("INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms)
            VALUES(?1,?2,?1,'private-machine',?3)", rusqlite::params![key,harness,now]).unwrap();
        db.conn().execute("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,
            session_key,source_event_id,observation_kind,event_ts_ms,uncached_input_tokens,cache_read_tokens,
            cache_write_tokens,output_tokens,ingested_run_id,created_at_ms,updated_at_ms)
            VALUES(?1,?2,'private-machine',?1,?1,'private-event','delta',?3,10,20,30,40,'fixture',?4,?4)",
            rusqlite::params![key,harness,ts,now]).unwrap();
    }
    db.conn().execute("UPDATE usage_facts SET model_id = 'fixture-model' WHERE fact_id = 'private-native-session'", []).unwrap();
    db.conn().execute("UPDATE usage_facts SET observation_kind = 'legacy_aggregate' WHERE fact_id = 'untitled-session'", []).unwrap();
    db.conn().execute("INSERT INTO session_excerpts(session_key,ordinal,role,excerpt,provenance,ingested_run_id)
        VALUES('private-native-session',0,'user_first',?1,'truncated','fixture')",
        ["帮我修复登录页".repeat(80)]).unwrap();
    // V32 楼名：有标题的会话投影出（有界、带来源）；超长标题被截到契约上限。
    db.conn().execute("UPDATE sessions SET title = ?1, title_source = 'codex_thread_name'
        WHERE session_key = 'private-native-session'", ["标题".repeat(300)]).unwrap();
    for (id, harness, status, opened) in [("public-issue", "codex", "open", now),
        ("closed-issue", "codex", "closed", now), ("old-issue", "codex", "open", now - 40 * 86_400_000),
        ("unknown-issue", "private-harness-name", "open", now)] {
        db.conn().execute("INSERT INTO issue_instances(issue_id,machine_namespace,harness,issue_type,
            instance_fingerprint,status,severity,evaluator_id,evaluator_version,evidence_fingerprint,opened_at_ms,metadata_json)
            VALUES(?1,'private-machine',?2,'fixture',?1,?3,'warning','fixture','1',?1,?4,'{\"raw_error\":\"private-error\"}')",
            rusqlite::params![id,harness,status,opened]).unwrap();
    }
    let result = city_projection(&dir, 30, now).unwrap();
    assert_eq!(result["source"], "local");
    assert_eq!(result["coverage"]["total"], 2);
    assert_eq!(result["coverage"]["unknown_time"], 1);
    assert_eq!(result["coverage"]["findings_state"], "partial");
    assert_eq!(result["findings"], serde_json::json!([{"harness":"codex","severity":"warning","count":1}]));
    assert_eq!(result["sessions"][0]["tokens"]["input"], 60);
    assert_eq!(result["sessions"][0]["tokens"]["total"], 100);
    assert_eq!(result["sessions"][0]["tokens"]["uncached_input"], 10);
    assert_eq!(result["sessions"][0]["tokens"]["cache_read"], 20);
    assert_eq!(result["sessions"][0]["tokens"]["cache_write"], 30);
    assert_eq!(result["sessions"][0]["model_ids"], serde_json::json!(["fixture-model"]));
    assert_eq!(result["sessions"][0]["cost_minor"], serde_json::Value::Null);
    assert_eq!(result["sessions"][0]["cost_status"]["state"], "unavailable");
    assert_eq!(result["sessions"][0]["cost_status"]["has_unresolved"], true);
    assert_eq!(result["models"], serde_json::json!(["fixture-model"]));
    assert_eq!(result["activity"]["days"].as_array().unwrap().len(), 1);
    assert_eq!(result["activity"]["days"][0]["session_count"], 2);
    assert_eq!(result["activity"]["days"][0]["event_count"], 2);
    assert_eq!(result["activity"]["days"][0]["tokens"], 200);
    assert!(result["activity"]["busiest_day"].is_object());
    // 两个窗口内会话按 first ASC + key 排序：private-native-session 在前（有标题），
    // untitled-session 在后（无标题 → null，不编造）。
    assert_eq!(result["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(result["sessions"][1]["title"], serde_json::Value::Null);
    assert_eq!(result["sessions"][1]["title_source"], serde_json::Value::Null);
    assert_eq!(result["sessions"][1]["cost_status"]["reason"], "legacy-aggregate-not-priced");
    assert_eq!(result["sessions"][1]["cost_status"]["has_unresolved"], true);
    let excerpt = &result["sessions"][0]["task_excerpts"][0];
    assert!(excerpt["text"].as_str().unwrap().chars().count() <= 200);
    assert_eq!(excerpt["provenance"], "truncated");
    assert_eq!(excerpt["is_excerpt"], true);
    // V32：标题投影（有界 + 来源）；old-session 无标题行 → title 为 null（不编造）。
    let title = result["sessions"][0]["title"].as_str().unwrap();
    assert_eq!(title.chars().count(), 256, "超长标题截到契约上限");
    assert_eq!(result["sessions"][0]["title_source"], "codex_thread_name");
    let encoded = result.to_string();
    for forbidden in ["private-native-session", "private-machine", "private-event", "private-harness-name", "private-error", "public-issue", "source_id", "native_event_id"] {
        assert!(!encoded.contains(forbidden), "projection leaked {forbidden}");
    }
    let again = city_projection(&dir, 30, now).unwrap();
    assert_eq!(result["sessions"][0]["id"], again["sessions"][0]["id"]);
    let handle = result["sessions"][0]["id"].as_str().unwrap();
    let (host_ref, harness) = agent_vitals_query::query::app_local::city_session_target(&dir, handle).unwrap();
    assert_eq!(harness, "codex");
    assert_ne!(host_ref, handle, "plugin and host handles must have separate scopes");
    assert_eq!(agent_vitals_query::query::app_local::plugin_session_target(&dir, "city", handle).unwrap(), (host_ref.clone(), harness.clone()));
    assert_eq!(agent_vitals_query::query::app_local::plugin_session_target(&dir, "metrics", handle), Err("session_unavailable"));
    assert_eq!(agent_vitals_query::query::app_local::plugin_session_target(&dir, "City", handle), Err("navigation_unavailable"));
    assert_eq!(agent_vitals_query::query::app_local::city_session_target(&dir, "private-native-session"), Err("invalid_session_handle"));
    db.conn().execute("UPDATE usage_facts SET deleted_at_ms = ?1", [now]).unwrap();
    assert_eq!(city_projection(&dir, 30, now).unwrap()["status"], "empty");
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
}
