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
fn actual_city_pve_and_pvp_messages_pass() {
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
    changed["state"]["ruleset"] = json!(PVP);
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
    let mut message = data["messages"][4].clone();
    message["result"]["value"]["state"]["units"][0]["id"] = json!("native-secret");
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
