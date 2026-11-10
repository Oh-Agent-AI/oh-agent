//! MCP tools for one session building's 3D model (Agent City).
//!
//! ReACT loop: `get_building` → `preview_building` → `set_building_model`
//! (confirm `revision` + `build_event_id`) → `get_building`. Observe is a
//! structured summary; screenshots are not part of this MVP.
//!
//! Agent-facing preview/set accept **inheritance rewrites only** (layer 2) —
//! not full mesh replace. Full mesh remains available to internal callers/tests.
//!
//! Writes require `--allow-local-writes`. Validation errors share the same
//! `{kind, rule, parts, message, suggested_fix}` shape on preview and set.
//!
//! After a successful persist the query layer notifies PluginHost
//! (socket and mailbox) with a shared `CityEntityChanged` envelope.
//! `construction.ui` is `pushed` or `queued`. Preview success and
//! compliance / detail-regression / design-coherence rejects use the
//! same channel (`action=preview|reject`) so City can show a ghost or
//! fail-flash. Soft design issues stay on `data.warnings`.

use std::path::Path;

use serde_json::{json, Value};

use super::{build_envelope, coverage_not_applicable, AuthorityHandle, ToolError, ToolSpec};

fn spec(name: &'static str, description: &'static str, properties: Value, required: &[&str]) -> ToolSpec {
    ToolSpec {
        name,
        description,
        input_schema: json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "Standard MCP envelope. data.ok distinguishes success from structured validation/conflict/design errors. data.ok is not design approval: always read data.warnings (massing_shift / additive_override) and show them before set. data.observe.text is the mandatory non-vision summary."
        }),
    }
}

fn session_id_prop() -> Value {
    json!({
        "type": "string",
        "description": "City session handle from sessions_search.session_ref (sr_…) or the building asset_ref (ca_…)."
    })
}

fn inheritance_prop() -> Value {
    json!({
        "type": "object",
        "description": "session-kit/inheritance/v1 rewrite: {kit_version, base: {kind: projection|catalog, catalog_id?}, overrides: {params, parts_replace, parts_add, parts_remove}} or {kit_version, reset: true}. Server resolves base → merges overrides → runs compliance, detail regression, and design coherence (attach to the current mass; do not widen a same-height shaft). Full mesh replace is not accepted on this tool surface."
    })
}

fn revision_prop() -> Value {
    json!({
        "type": "integer",
        "minimum": 0,
        "description": "Optimistic concurrency token from get_building.revision. 0 means no override yet."
    })
}

pub fn get_spec() -> ToolSpec {
    spec(
        "get_building",
        "Return the current Agent City model for one session building (override or default) from the open local City window. Includes asset_ref, resolved parts (≤64), revision, kit_version, and a geometric summary. Primary feedback is JSON, not an image.",
        json!({ "session_id": session_id_prop() }),
        &["session_id"],
    )
}

pub fn preview_spec() -> ToolSpec {
    spec(
        "preview_building",
        "Validate a proposed inheritance rewrite without writing. Resolves base → merges overrides → runs compliance, detail-regression, then design coherence (parts must attach to the current mass; same-height footprint blow-outs are rejected). data.ok is not design approval — if data.warnings is non-empty you must show every warning to the user before set_building_model.",
        json!({ "session_id": session_id_prop(), "inheritance": inheritance_prop() }),
        &["session_id", "inheritance"],
    )
}

pub fn set_spec() -> ToolSpec {
    spec(
        "set_building_model",
        "Apply an inheritance rewrite to one session building. Requires --allow-local-writes and expected_revision for optimistic concurrency. Persists the subclass document (not a full mesh dump). Same gates as preview_building, including design coherence. On success bumps revision, notifies the open City window, and returns build_event_id. If the matching preview had data.warnings, those warnings are also on this result — show them; do not treat ok as a silent pass.",
        json!({
            "session_id": session_id_prop(),
            "inheritance": inheritance_prop(),
            "expected_revision": revision_prop()
        }),
        &["session_id", "inheritance", "expected_revision"],
    )
}

pub fn reset_spec() -> ToolSpec {
    spec(
        "reset_building",
        "Clear a session building override and restore the default model. Requires --allow-local-writes and expected_revision. Bumps revision, notifies the open City window, and queues a construction replay of the default.",
        json!({
            "session_id": session_id_prop(),
            "expected_revision": revision_prop()
        }),
        &["session_id", "expected_revision"],
    )
}

fn required_string<'a>(args: &'a Value, name: &str) -> Result<&'a str, ToolError> {
    args.get(name).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| {
        ToolError::new("invalid_argument", format!("`{name}` is required"))
    })
}

fn required_u64(args: &Value, name: &str) -> Result<u64, ToolError> {
    args.get(name).and_then(Value::as_u64).ok_or_else(|| {
        ToolError::new("invalid_argument", format!("`{name}` must be a non-negative integer"))
    })
}

fn required_object<'a>(args: &'a Value, name: &str) -> Result<&'a Value, ToolError> {
    match args.get(name) {
        Some(value) if value.is_object() => Ok(value),
        _ => Err(ToolError::new("invalid_argument", format!("`{name}` must be a JSON object"))),
    }
}

fn reject_full_mesh_replace(args: &Value) -> Result<(), ToolError> {
    if args.get("model").is_some() {
        return Err(ToolError::new(
            "invalid_argument",
            "full mesh replace via `model` is not supported on agent tools; send an `inheritance` rewrite (base + overrides) instead",
        ));
    }
    Ok(())
}

fn writes_denied() -> ToolError {
    ToolError::new(
        "permission_denied",
        "city building mutations require the explicit `--allow-local-writes` server flag; default MCP remains read-only",
    )
}

fn envelope(handle: &AuthorityHandle, data: Value) -> Value {
    build_envelope(
        handle.conn(),
        handle.authority_state(),
        None,
        coverage_not_applicable(),
        Vec::new(),
        data,
    )
}

pub fn run_get(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let session_id = required_string(args, "session_id")?;
    let handle = AuthorityHandle::open(data_home)?;
    let request = json!({ "session_id": session_id });
    let response = agent_vitals_query::query::plugin_calls::call(
        data_home, "city", "city.building.get", &request, 5_000,
    ).map_err(map_host_error)?;
    if response["ok"] != true {
        let code = response["error"]["code"].as_str().unwrap_or("plugin_call_failed");
        return Err(map_host_error(code));
    }
    let data = response.get("result").filter(|value| value.is_object()).cloned()
        .ok_or_else(|| ToolError::new("data_unavailable", "City returned an invalid building response"))?;
    Ok(envelope(&handle, data))
}

fn map_host_error(code: &str) -> ToolError {
    match code {
        "session_unavailable" => ToolError::new("not_found", "the session is not available in the open Agent City window"),
        "invalid_payload" => ToolError::new("invalid_argument", "the building request is invalid"),
        "plugin_call_timeout" | "plugin_call_expired" | "plugin_call_method_unavailable" => {
            ToolError::new("plugin_unavailable", "Open the local Agent City window and retry the request")
        }
        _ => ToolError::new("data_unavailable", code),
    }
}

fn run_local_building_call(method: &str, args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let handle = AuthorityHandle::open(data_home)?;
    let response = agent_vitals_query::query::plugin_calls::call(data_home, "city", method, args, 10_000)
        .map_err(map_host_error)?;
    if response["ok"] != true {
        let code = response["error"]["code"].as_str().unwrap_or("plugin_call_failed");
        return Err(map_host_error(code));
    }
    let data = response.get("result").filter(|value| value.is_object()).cloned()
        .ok_or_else(|| ToolError::new("data_unavailable", "City returned an invalid building response"))?;
    Ok(envelope(&handle, data))
}

pub fn run_preview(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    reject_full_mesh_replace(args)?;
    let session_id = required_string(args, "session_id")?;
    let inheritance = required_object(args, "inheritance")?;
    run_local_building_call("city.building.preview", &json!({"session_id": session_id, "inheritance": inheritance}), data_home)
}

pub fn run_set(args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    if !allow_local_writes { return Err(writes_denied()); }
    reject_full_mesh_replace(args)?;
    let session_id = required_string(args, "session_id")?;
    let inheritance = required_object(args, "inheritance")?;
    let expected = required_u64(args, "expected_revision")?;
    run_local_building_call("city.building.set", &json!({"session_id": session_id, "inheritance": inheritance,
        "expected_revision": expected}), data_home)
}

pub fn run_reset(args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    if !allow_local_writes { return Err(writes_denied()); }
    let session_id = required_string(args, "session_id")?;
    let expected = required_u64(args, "expected_revision")?;
    run_local_building_call("city.building.reset", &json!({"session_id": session_id,
        "expected_revision": expected}), data_home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;
    use crate::mcp::{dispatch, dispatch_with_permissions};
    use std::time::{Duration, Instant};

    fn tmp_home() -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!(
            "avmcp-city-bldg-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    fn seed(home: &Path) {
        let _ = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(home), 1_700_000_000_000).unwrap();
    }

    fn dispatch_through_city_host(name: &'static str, args: Value, allow_local_writes: bool, expected_method: &'static str) -> Value {
        let home = tmp_home();
        seed(&home);
        let worker_home = home.clone();
        let worker = std::thread::spawn(move || dispatch_with_permissions(name, &args, &worker_home, allow_local_writes));
        let allowed = vec![expected_method.to_string()];
        let started = Instant::now();
        let (call_id, payload) = loop {
            let pending = crate::query::plugin_calls::claim_pending(&home, "city", "test-city-instance", &allowed, 1).unwrap();
            if let Some(call) = pending.into_iter().next() {
                assert_eq!(call["method"], expected_method);
                break (call["callId"].as_str().unwrap().to_string(), call["payload"].clone());
            }
            assert!(started.elapsed() < Duration::from_secs(2), "City host call was not queued");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(payload["session_id"], "session-test");
        crate::query::plugin_calls::respond(&home, "city", "test-city-instance", &call_id,
            &json!({"ok":true,"result":{"ok":true,"revision":1}})).unwrap();
        let result = worker.join().unwrap().unwrap();
        let _ = std::fs::remove_dir_all(&home);
        result
    }

    #[test]
    fn city_tools_dispatch_only_through_descriptor_scoped_plugin_calls() {
        let get = dispatch_through_city_host(
            "get_building", json!({"session_id":"session-test"}), false, "city.building.get",
        );
        assert_eq!(get["data"]["ok"], true);

        let inheritance = json!({"kit_version":"session-kit/inheritance/v1","base":{"kind":"projection"},"overrides":{}});
        let preview = dispatch_through_city_host(
            "preview_building", json!({"session_id":"session-test","inheritance":inheritance}), false, "city.building.preview",
        );
        assert_eq!(preview["data"]["ok"], true);

        let set = dispatch_through_city_host(
            "set_building_model",
            json!({"session_id":"session-test","inheritance":{"kit_version":"session-kit/inheritance/v1","base":{"kind":"projection"},"overrides":{}},"expected_revision":0}),
            true,
            "city.building.set",
        );
        assert_eq!(set["data"]["ok"], true);

        let reset = dispatch_through_city_host(
            "reset_building", json!({"session_id":"session-test","expected_revision":1}), true, "city.building.reset",
        );
        assert_eq!(reset["data"]["ok"], true);
    }

    #[test]
    fn city_mutations_and_legacy_mesh_payloads_fail_closed() {
        let home = tmp_home();
        seed(&home);
        let denied = dispatch_with_permissions(
            "set_building_model",
            &json!({"session_id":"session-test","inheritance":{"kit_version":"session-kit/inheritance/v1","base":{"kind":"projection"},"overrides":{}},"expected_revision":0}),
            &home,
            false,
        ).unwrap_err();
        assert_eq!(denied.code, "permission_denied");

        let mesh_denied = dispatch("preview_building", &json!({
            "session_id":"session-test",
            "model":{"parts":[]},
        }), &home).unwrap_err();
        assert_eq!(mesh_denied.code, "invalid_argument");
        let _ = std::fs::remove_dir_all(&home);
    }
}
