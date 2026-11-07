use super::*;
use serde_json::json;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../tests/remote_gateway_projection_fixture.json")).unwrap()
}

fn object_paths(value: &Value, path: &str, paths: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            paths.push(path.to_owned());
            for (key, child) in object {
                object_paths(child, &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")), paths);
            }
        }
        Value::Array(items) => for (index, child) in items.iter().enumerate() {
            object_paths(child, &format!("{path}/{index}"), paths);
        },
        _ => (),
    }
}

#[test]
fn actual_city_pve_and_outbound_messages_are_valid() {
    let data = fixture();
    assert!(valid_start(&data["arena"], &data["state"]));
    for command in data["commands"].as_array().unwrap() { assert!(valid_submit_plan(command)); }
    for (index, message) in data["messages"].as_array().unwrap().iter().enumerate() {
        assert!(valid_outbound(message, "m1"), "fixture message {index}: {message}");
    }
    assert!(!valid_outbound(&data["messages"][0], "another-match"));
}

#[test]
fn every_object_in_start_projection_rejects_nested_extra_fields() {
    let data = fixture();
    for root in ["arena", "state"] {
        let mut paths = Vec::new();
        object_paths(&data[root], "", &mut paths);
        for path in paths {
            let mut changed = data.clone();
            changed[root].pointer_mut(&path).unwrap().as_object_mut().unwrap().insert("secret".into(), json!({"prompt":"private"}));
            assert!(!valid_start(&changed["arena"], &changed["state"]), "accepted {root}{path}");
        }
    }
    let mut changed = data.clone();
    changed["arena"]["terrain"][0][0] = json!({"terrain":"land", "log":"private"});
    assert!(!valid_start(&changed["arena"], &changed["state"]));
    changed = data.clone();
    changed["state"]["ruleset"] = json!("unsupported-ruleset");
    assert!(!valid_start(&changed["arena"], &changed["state"]));
}

#[test]
fn every_object_in_actual_outbound_messages_rejects_unknown_fields() {
    let data = fixture();
    for (index, message) in data["messages"].as_array().unwrap().iter().enumerate() {
        let mut paths = Vec::new();
        object_paths(message, "", &mut paths);
        for path in paths {
            let mut changed = message.clone();
            changed.pointer_mut(&path).unwrap().as_object_mut().unwrap().insert("secret".into(), json!({"path":"private"}));
            assert!(!valid_outbound(&changed, "m1"), "accepted message {index}{path}");
        }
    }
}

#[test]
fn all_event_variants_and_optional_fields_are_strict() {
    let data = fixture();
    let mut message = data["messages"][2].clone();
    message["result"]["value"]["log"] = json!([
        {"type":"move","mechId":"Assault","from":{"x":1,"y":1},"to":{"x":2,"y":1}},
        {"type":"act","mechId":"Assault","action":"charge","target":"boss","damage":3,"fizzled":true,"cause":"target_gone","effects":[{"kind":"boss","id":"boss","before":40,"after":37,"order":0,"sequence":1}]},
        {"type":"shove","unit":"boss","dir":{"x":1,"y":0},"hit":"wall","damage":1,"effects":[],"sequence":2},
        {"type":"enemy","actor":"boss","skill":"smash","cells":[{"x":1,"y":2}],"damage":1},
        {"type":"outcome","outcome":"victory"}
    ]);
    assert!(valid_outbound(&message, "m1"));
    let mut paths = Vec::new();
    object_paths(&message["result"]["value"]["log"], "/result/value/log", &mut paths);
    for path in paths {
        let mut changed = message.clone();
        changed.pointer_mut(&path).unwrap().as_object_mut().unwrap().insert("secret".into(), json!("private"));
        assert!(!valid_outbound(&changed, "m1"), "accepted {path}");
    }
    let failure = json!({"protocol":NET,"type":"response","requestId":"r1","result":{"ok":false,"error":{"code":"invalid_plan","fault":{"code":"PLAN_PACK_REJECTED","mechId":"Assault","cause":"occupied"}}}});
    assert!(valid_outbound(&failure, "m1"));
    let mut changed = failure;
    changed["result"]["error"]["fault"]["reason"] = json!("private");
    assert!(!valid_outbound(&changed, "m1"));
}

#[test]
fn incoming_plan_cannot_poison_state_via_copied_coordinates() {
    let plan = json!({"type":"plan.submit","protocol":NET,"matchId":"m1","playerId":"owner","commandId":"c1","baseRevision":0,"plan":{"revision":0,"items":[{"mechId":"Assault","moveTo":{"x":1,"y":2},"action":{"kind":"melee","target":"boss"}}]}});
    assert!(valid_submit_plan(&plan));
    let mut paths = Vec::new();
    object_paths(&plan, "", &mut paths);
    for path in paths {
        let mut changed = plan.clone();
        changed.pointer_mut(&path).unwrap().as_object_mut().unwrap().insert("secret".into(), json!("private"));
        assert!(!valid_submit_plan(&changed), "accepted {path}");
    }
    let mut skip = plan.clone();
    skip["plan"]["items"][0]["moveTo"] = Value::Null;
    skip["plan"]["items"][0]["action"] = json!({"kind":"skip"});
    assert!(valid_submit_plan(&skip));
}

#[test]
fn known_scalar_fields_cannot_smuggle_local_text_or_native_ids() {
    let data = fixture();
    for path in ["/arena/terrain/0/0", "/arena/arenaId", "/arena/sourceRevision", "/arena/buildings/0/id",
        "/arena/raiders/0/id", "/state/preset", "/state/buildings/0/id", "/state/raiders/0/id",
        "/state/boss/intent/status", "/state/mechs/0/id"] {
        let mut changed = data.clone();
        *changed.pointer_mut(path).unwrap() = json!("/Users/example/private-log.jsonl");
        assert!(!valid_start(&changed["arena"], &changed["state"]), "accepted {path}");
    }
    let mut message = data["messages"][0].clone();
    message["result"]["value"]["state"]["mechs"][0]["id"] = json!("native-secret");
    assert!(!valid_outbound(&message, "m1"));
    let mut failure = data["messages"].as_array().unwrap().iter().find(|v| v["result"]["ok"] == false).unwrap().clone();
    failure["result"]["error"]["code"] = json!("private-error");
    assert!(!valid_outbound(&failure, "m1"));
    for shape in ["flat", "shore", "ridge", "alley"] {
        let mut changed = data.clone();
        changed["arena"]["arenaId"] = json!(format!("city-{shape}"));
        changed["arena"]["sourceRevision"] = json!(format!("{shape}-123"));
        assert!(valid_start(&changed["arena"], &changed["state"]));
    }
}

#[test]
fn sampled_terrain_safety_is_bounded_strict_and_does_not_enable_remote_deployment() {
    let data = fixture();
    let mut changed = data.clone();
    changed["state"]["assaultTerrainSafety"] = json!({
        "unsafeCells": [{"x":1,"y":8}],
        "unsafeEdges": [{"from":{"x":1,"y":8},"to":{"x":2,"y":9}}]
    });
    assert!(valid_start(&changed["arena"], &changed["state"]));
    for index in [0, 2] {
        let mut outbound = data["messages"][index].clone();
        outbound["result"]["value"]["state"]["assaultTerrainSafety"] = changed["state"]["assaultTerrainSafety"].clone();
        assert!(valid_outbound(&outbound, "m1"));
        outbound["result"]["value"]["state"]["assaultTerrainSafety"]["unsafeCells"][0]["secret"] = json!("private");
        assert!(!valid_outbound(&outbound, "m1"));
    }
    for path in ["/assaultTerrainSafety", "/assaultTerrainSafety/unsafeCells/0", "/assaultTerrainSafety/unsafeEdges/0", "/assaultTerrainSafety/unsafeEdges/0/from"] {
        let mut invalid = changed.clone();
        invalid["state"].pointer_mut(path).unwrap().as_object_mut().unwrap().insert("secret".into(), json!("private"));
        assert!(!valid_start(&invalid["arena"], &invalid["state"]), "accepted nested data at {path}");
    }
    for (path, value) in [
        ("/assaultTerrainSafety/unsafeCells/0/x", json!(10)),
        ("/assaultTerrainSafety/unsafeCells/0/x", json!(1.5)),
        ("/assaultTerrainSafety/unsafeEdges/0/to/x", json!(9)),
        ("/assaultTerrainSafety/unsafeEdges/0/to/y", json!(-1)),
    ] {
        let mut invalid = changed.clone();
        *invalid["state"].pointer_mut(path).unwrap() = value;
        assert!(!valid_start(&invalid["arena"], &invalid["state"]), "accepted bad coordinate at {path}");
    }
    let mut oversized = changed.clone();
    oversized["state"]["assaultTerrainSafety"]["unsafeCells"] = json!(vec![json!({"x":0,"y":0}); 101]);
    assert!(!valid_start(&oversized["arena"], &oversized["state"]));
    oversized["state"]["assaultTerrainSafety"]["unsafeCells"] = json!([]);
    oversized["state"]["assaultTerrainSafety"]["unsafeEdges"] = json!(vec![json!({"from":{"x":0,"y":0},"to":{"x":1,"y":0}}); 343]);
    assert!(!valid_start(&oversized["arena"], &oversized["state"]));
    changed["state"]["deployment"] = json!({"zone":[{"x":0,"y":8}],"reservedCells":[]});
    assert!(!valid_start(&changed["arena"], &changed["state"]), "deployment fields must remain closed even on a combat phase");
    changed["state"]["phase"] = json!("deployment");
    assert!(!valid_start(&changed["arena"], &changed["state"]));
}

#[test]
fn staged_deployment_command_rejects_unknown_fields_and_foreign_owners() {
    let command = json!({"type":"deployment.submit","protocol":NET,"matchId":"m1","playerId":"owner","commandId":"d1","baseRevision":0,
        "plan":{"revision":0,"placements":[{"mechId":"Assault","pos":{"x":1,"y":8}},{"mechId":"Gunner","pos":{"x":2,"y":8}},{"mechId":"Support","pos":{"x":3,"y":8}}]}});
    assert!(valid_submit_deployment(&command));
    let mut paths = Vec::new();
    object_paths(&command, "", &mut paths);
    for path in paths {
        let mut bad = command.clone();
        bad.pointer_mut(&path).unwrap().as_object_mut().unwrap().insert("secret".into(), json!("private"));
        assert!(!valid_submit_deployment(&bad), "accepted {path}");
    }
    for (path, value) in [
        ("/playerId", json!("guest")), ("/commandId", json!("/private/path")),
        ("/plan/revision", json!(1)), ("/plan/placements/0/mechId", json!("private")),
        ("/plan/placements/0/pos/x", json!(10)), ("/plan/placements/0/pos/y", json!(8.5)),
    ] {
        let mut bad = command.clone(); *bad.pointer_mut(path).unwrap() = value;
        assert!(!valid_submit_deployment(&bad), "accepted invalid {path}");
    }
    let mut incomplete = command.clone(); incomplete["plan"]["placements"] = json!([]);
    assert!(valid_submit_deployment(&incomplete), "semantic faults belong to the authoritative rules");
}

#[test]
fn staged_deployment_snapshot_is_strict_but_production_remains_closed() {
    let mut data = fixture();
    data["state"]["phase"] = json!("deployment");
    data["state"]["outcome"] = Value::Null;
    data["state"]["boss"]["intent"] = Value::Null;
    for raider in data["state"]["raiders"].as_array_mut().unwrap() { raider["intent"] = Value::Null; }
    data["state"]["deployment"] = json!({"zone":[{"x":0,"y":8},{"x":1,"y":8},{"x":2,"y":8}],"reservedCells":[{"x":3,"y":8}]});
    assert!(valid_start_deployment(&data["arena"], &data["state"]));
    assert!(!valid_start(&data["arena"], &data["state"]));
    let mut no_space = data.clone(); no_space["state"]["deployment"]["zone"] = json!([]);
    assert!(valid_start_deployment(&no_space["arena"], &no_space["state"]), "an unusable zone must still be recoverable and reported by the rules");
    let mut outbound = fixture()["messages"][0].clone();
    outbound["result"]["value"]["state"] = data["state"].clone();
    outbound["result"]["value"]["revision"] = data["state"]["revision"].clone();
    assert!(!valid_outbound(&outbound, "m1"));
    let mut paths = Vec::new(); object_paths(&data["state"]["deployment"], "/deployment", &mut paths);
    for path in paths {
        let mut bad = data.clone();
        bad["state"].pointer_mut(&path).unwrap().as_object_mut().unwrap().insert("secret".into(), json!("private"));
        assert!(!valid_start_deployment(&bad["arena"], &bad["state"]), "accepted {path}");
    }
    for (path, value) in [
        ("/deployment/zone/0/x", json!(10)), ("/deployment/zone/0/y", json!(8.5)),
        ("/deployment/zone/0", json!({"x":1,"y":8})), ("/deployment/reservedCells/0/x", json!(-1)),
        ("/mechs/0/id", json!("Gunner")), ("/outcome", json!("victory")),
        ("/boss/intent", fixture()["state"]["boss"]["intent"].clone()),
        ("/raiders/0/intent", fixture()["state"]["raiders"][0]["intent"].clone()),
    ] {
        let mut bad = data.clone(); *bad["state"].pointer_mut(path).unwrap() = value;
        assert!(!valid_start_deployment(&bad["arena"], &bad["state"]), "accepted invalid {path}");
    }
    let mut combat = fixture(); combat["state"]["deployment"] = Value::Null;
    assert!(!valid_start(&combat["arena"], &combat["state"]), "explicit null must not bypass the existing field allowlist");
}

#[test]
fn deployment_outbound_rejects_foreign_data_and_stays_out_of_v1() {
    let data = fixture();
    let mut snapshot = data["messages"][0]["result"]["value"].clone();
    snapshot["state"]["phase"] = json!("deployment");
    snapshot["state"]["outcome"] = Value::Null;
    snapshot["state"]["boss"]["intent"] = Value::Null;
    for raider in snapshot["state"]["raiders"].as_array_mut().unwrap() { raider["intent"] = Value::Null; }
    snapshot["state"]["deployment"] = json!({"zone":[{"x":0,"y":8},{"x":1,"y":8},{"x":2,"y":8}],"reservedCells":[]});
    let response = json!({"protocol":NET,"type":"response","requestId":"r1","result":{"ok":true,"value":snapshot}});
    let event = json!({"protocol":NET,"type":"event","event":{"type":"match.replaced","snapshot":response["result"]["value"]}});
    for message in [&response, &event] {
        assert!(valid_outbound_with_deployment(message, "m1"));
        assert!(!valid_outbound(message, "m1"), "v1 projection must remain closed");
        assert!(!valid_outbound_with_deployment(message, "another-match"));
        let mut paths = Vec::new(); object_paths(message, "", &mut paths);
        for path in paths {
            let mut bad = message.clone();
            bad.pointer_mut(&path).unwrap().as_object_mut().unwrap().insert("secret".into(), json!({"prompt":"private"}));
            assert!(!valid_outbound_with_deployment(&bad, "m1"), "accepted private field at {path}");
        }
    }
    let mut closed = response.clone(); closed["result"]["value"]["status"] = json!("closed");
    assert!(valid_outbound_with_deployment(&closed, "m1"), "closing during deployment must return the closed snapshot");
    assert!(!valid_outbound(&closed, "m1"));
    for (path, value) in [
        ("/mode", json!("unsupported-mode")), ("/status", json!("finished")),
        ("/players", json!([{"playerId":"owner","side":"A","role":"host"},{"playerId":"guest","side":"B","role":"guest"}])),
        ("/revision", json!(42)), ("/state/deployment/zone/0/x", json!(10)),
        ("/state/phase", json!("player_plan")), ("/state/boss/intent", data["state"]["boss"]["intent"].clone()),
    ] {
        let mut bad = response.clone(); *bad["result"]["value"].pointer_mut(path).unwrap() = value;
        assert!(!valid_outbound_with_deployment(&bad, "m1"), "accepted invalid {path}");
    }
    for message in data["messages"].as_array().unwrap() {
        assert!(valid_outbound_with_deployment(message, "m1"), "existing production output regressed");
    }
}

#[test]
fn staged_deployment_errors_have_bounded_faults() {
    let response = json!({"protocol":NET,"type":"response","requestId":"r1","result":{"ok":false,
        "error":{"code":"invalid_deployment","fault":{"code":"unsafe","mechId":"Assault"}}}});
    assert!(valid_outbound_with_deployment(&response, "m1"));
    assert!(!valid_outbound(&response, "m1"));
    let mut no_mech = response.clone(); no_mech["result"]["error"]["fault"].as_object_mut().unwrap().remove("mechId");
    assert!(valid_outbound_with_deployment(&no_mech, "m1"));
    for (path, value) in [
        ("/result/error/fault/mechId", Value::Null), ("/result/error/fault/mechId", json!("private")),
        ("/result/error/fault/code", json!("private")), ("/result/error/code", json!("invalid_plan")),
    ] {
        let mut bad = response.clone(); *bad.pointer_mut(path).unwrap() = value;
        assert!(!valid_outbound_with_deployment(&bad, "m1"), "accepted invalid {path}");
    }
    let mut paths = Vec::new(); object_paths(&response, "", &mut paths);
    for path in paths {
        let mut bad = response.clone();
        bad.pointer_mut(&path).unwrap().as_object_mut().unwrap().insert("secret".into(), json!("private"));
        assert!(!valid_outbound_with_deployment(&bad, "m1"), "accepted private field at {path}");
    }
}

#[test]
fn actual_deployment_session_outputs_pass_v2_projection() {
    // Generated by the actual TypeScript MatchSession; a UI test guards fixture parity.
    let data: Value = serde_json::from_str(include_str!("../tests/remote_deployment_gateway_fixture.json")).unwrap();
    assert!(valid_start_deployment(&data["arena"], &data["state"]));
    assert!(!valid_start(&data["arena"], &data["state"]));
    assert!(valid_submit_deployment(&data["command"]));
    for (index, message) in data["messages"].as_array().unwrap().iter().enumerate() {
        assert!(valid_outbound_with_deployment(message, "m1"), "actual deployment message {index}: {message}");
        if index != 1 { assert!(!valid_outbound_with_deployment(message, "another-match")); }
    }
}

#[test]
fn safe_concession_rejects_unknown_fields_and_unsafe_revisions() {
    let command = json!({"type":"match.concede-v2","protocol":NET,"matchId":"m1","playerId":"owner","commandId":"c1","baseRevision":9007199254740991_u64});
    assert!(valid_submit_concede(&command));
    for (path, value) in [
        ("/baseRevision", json!(9007199254740992_u64)),
        ("/baseRevision", json!(-1)),
        ("/playerId", json!("spectator")),
        ("/commandId", json!("")),
        ("/type", json!("match.concede")),
    ] {
        let mut bad = command.clone(); *bad.pointer_mut(path).unwrap() = value;
        assert!(!valid_submit_concede(&bad), "accepted {path}");
    }
    let mut bad = command.clone(); bad["private"] = json!("secret");
    assert!(!valid_submit_concede(&bad));
}

#[test]
fn local_rescue_marker_is_rejected_at_every_pve_start_gateway() {
    let data = fixture();
    assert!(valid_start(&data["arena"], &data["state"]));
    let mut deployment = data.clone();
    deployment["state"]["phase"] = json!("deployment");
    deployment["state"]["turn"] = json!(1);
    deployment["state"]["revision"] = json!(0);
    deployment["state"]["boss"]["intent"] = Value::Null;
    for raider in deployment["state"]["raiders"].as_array_mut().unwrap() { raider["intent"] = Value::Null; }
    deployment["state"]["deployment"] = json!({"zone":[{"x":0,"y":8},{"x":1,"y":8},{"x":2,"y":8}],"reservedCells":[]});
    assert!(valid_start_deployment(&deployment["arena"], &deployment["state"]));
    for marker in [Value::Null, json!({"kind":"rescue:v1","target":{"x":1,"y":1}}), json!("unexpected")] {
        let mut ready = data.clone();
        ready["state"]["mission"] = marker.clone();
        assert!(!valid_start(&ready["arena"], &ready["state"]));
        let mut setup = deployment.clone();
        setup["state"]["mission"] = marker;
        assert!(!valid_start_deployment(&setup["arena"], &setup["state"]));
    }
}
