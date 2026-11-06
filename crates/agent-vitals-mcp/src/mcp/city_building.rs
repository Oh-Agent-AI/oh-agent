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
use crate::query::city_building::{self, BuildingError};

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
        "Return the current Agent City model for one session building (override or default). Includes asset_ref, resolved parts (≤64), optional inheritance subclass, revision, kit_version, and a geometric summary. Primary feedback is JSON, not an image.",
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

fn map_error(error: BuildingError) -> Result<Value, ToolError> {
    match error.kind {
        "not_found" if error.rule == "unknown_session" => {
            Err(ToolError::new("not_found", error.message.as_str()))
        }
        _ => Err(ToolError::new("data_unavailable", error.message.as_str())),
    }
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
    match city_building::get_building(data_home, handle.conn(), session_id) {
        Ok(data) => Ok(envelope(&handle, data)),
        Err(error) => map_error(error),
    }
}

pub fn run_preview(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    reject_full_mesh_replace(args)?;
    let session_id = required_string(args, "session_id")?;
    let inheritance = required_object(args, "inheritance")?;
    let handle = AuthorityHandle::open(data_home)?;
    match city_building::preview_building(data_home, handle.conn(), session_id, inheritance) {
        Ok(data) => Ok(envelope(&handle, data)),
        Err(error) => map_error(error),
    }
}

pub fn run_set(args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    if !allow_local_writes { return Err(writes_denied()); }
    reject_full_mesh_replace(args)?;
    let session_id = required_string(args, "session_id")?;
    let inheritance = required_object(args, "inheritance")?;
    let expected = required_u64(args, "expected_revision")?;
    let handle = AuthorityHandle::open(data_home)?;
    match city_building::set_building_model(data_home, handle.conn(), session_id, inheritance, expected) {
        Ok(data) => Ok(envelope(&handle, data)),
        Err(error) => map_error(error),
    }
}

pub fn run_reset(args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    if !allow_local_writes { return Err(writes_denied()); }
    let session_id = required_string(args, "session_id")?;
    let expected = required_u64(args, "expected_revision")?;
    let handle = AuthorityHandle::open(data_home)?;
    match city_building::reset_building(data_home, handle.conn(), session_id, expected) {
        Ok(data) => Ok(envelope(&handle, data)),
        Err(error) => map_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;
    use crate::mcp::{dispatch, dispatch_with_permissions};
    use crate::query::city_building_inheritance::INHERITANCE_KIT_VERSION;

    fn tmp_home() -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!(
            "avmcp-city-bldg-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    fn seed(home: &Path) -> String {
        let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(home), 1_700_000_000_000).unwrap();
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version) VALUES ('run',1,'cli','succeeded',2)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, last_observed_at_ms)
             VALUES ('sess-city', 'codex', 'native-city', 'ns', 1)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, session_key,
                 source_event_id, observation_kind, event_ts_ms, uncached_input_tokens, cache_read_tokens,
                 cache_write_tokens, output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('fc', 'codex', 'ns', 'native-city', 'sess-city', 'e1', 'assistant-usage', 1, 50000, 0, 0, 50000, 'run', 1, 1)",
            [],
        ).unwrap();
        drop(db);
        let salt = crate::query::session_ref::load_or_create_salt(home).unwrap();
        crate::query::session_ref::session_ref(&salt, "sess-city")
    }

    fn data(env: &Value) -> &Value { &env["data"] }

    fn catalog_inheritance(catalog_id: &str) -> Value {
        json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "catalog", "catalog_id": catalog_id },
            "overrides": {}
        })
    }

    fn overlapping_inheritance() -> Value {
        json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "catalog", "catalog_id": "kit-low-block" },
            "overrides": {
                "parts_add": [
                    {"id": "a", "kind": "box", "role": "wall", "at": [0, 0.2, 0], "size": [2, 1, 2]}
                ]
            }
        })
    }

    #[test]
    fn react_loop_get_preview_set_reset() {
        let home = tmp_home();
        let session_id = seed(&home);

        let denied = dispatch_with_permissions(
            "set_building_model",
            &json!({"session_id": session_id, "inheritance": catalog_inheritance("kit-low-block"), "expected_revision": 0}),
            &home,
            false,
        ).unwrap_err();
        assert_eq!(denied.code, "permission_denied");

        let mesh_denied = dispatch("preview_building", &json!({
            "session_id": session_id,
            "model": catalog_inheritance("kit-low-block"),
        }), &home).unwrap_err();
        assert_eq!(mesh_denied.code, "invalid_argument");

        let got = data(&dispatch("get_building", &json!({"session_id": session_id}), &home).unwrap()).clone();
        assert_eq!(got["ok"], true);
        assert_eq!(got["source"], "default");
        assert_eq!(got["revision"], 0);
        let asset = got["projection"]["asset_ref"].as_str().unwrap();
        assert!(asset.starts_with("ca_"));
        assert_eq!(got["observe"]["summary"]["part_count"], 5);

        let fail = data(&dispatch("preview_building", &json!({"session_id": session_id, "inheritance": overlapping_inheritance()}), &home).unwrap()).clone();
        assert_eq!(fail["ok"], false);
        assert_eq!(fail["error"]["kind"], "validation");
        assert_eq!(fail["error"]["rule"], "overlap");
        assert!(fail["error"]["suggested_fix"].as_str().unwrap().contains("shrink"));

        let projection_inheritance = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {}
        });
        let pass = data(&dispatch("preview_building", &json!({"session_id": session_id, "inheritance": projection_inheritance}), &home).unwrap()).clone();
        assert_eq!(pass["ok"], true);
        assert_eq!(pass["persisted"], false);
        assert_eq!(pass["warnings"].as_array().map(|a| a.len()), Some(0));

        let conflict = data(&dispatch_with_permissions(
            "set_building_model",
            &json!({"session_id": session_id, "inheritance": projection_inheritance, "expected_revision": 7}),
            &home,
            true,
        ).unwrap()).clone();
        assert_eq!(conflict["ok"], false);
        assert_eq!(conflict["error"]["kind"], "conflict");
        assert_eq!(conflict["error"]["rule"], "revision_conflict");
        assert_eq!(conflict["revision"], 0);

        let set = data(&dispatch_with_permissions(
            "set_building_model",
            &json!({"session_id": session_id, "inheritance": projection_inheritance, "expected_revision": 0}),
            &home,
            true,
        ).unwrap()).clone();
        assert_eq!(set["ok"], true);
        assert_eq!(set["revision"], 1);
        let event = set["build_event_id"].as_str().unwrap().to_string();
        assert!(event.starts_with("be_"));
        assert_eq!(set["construction"]["mode"], "block-by-block");
        assert_eq!(set["construction"]["replayable"], true);
        assert!(matches!(set["construction"]["ui"].as_str(), Some("pushed") | Some("queued")));

        let confirm = data(&dispatch("get_building", &json!({"session_id": session_id}), &home).unwrap()).clone();
        assert_eq!(confirm["ok"], true);
        assert_eq!(confirm["revision"], 1);
        assert_eq!(confirm["source"], "override");
        assert_eq!(confirm["model"]["parts"][1]["id"], "shaft");
        assert!(confirm["inheritance"].is_object());
        assert_eq!(confirm["projection"]["asset_ref"], set["projection"]["asset_ref"]);

        let by_asset = data(&dispatch("get_building", &json!({"session_id": asset}), &home).unwrap()).clone();
        assert_eq!(by_asset["revision"], 1);

        let reset = data(&dispatch_with_permissions(
            "reset_building",
            &json!({"session_id": session_id, "expected_revision": 1}),
            &home,
            true,
        ).unwrap()).clone();
        assert_eq!(reset["ok"], true);
        assert_eq!(reset["revision"], 2);
        assert_eq!(reset["source"], "default");
        assert_ne!(reset["build_event_id"], event);

        let after = data(&dispatch("get_building", &json!({"session_id": session_id}), &home).unwrap()).clone();
        assert_eq!(after["source"], "default");
        assert_eq!(after["revision"], 2);
        assert_eq!(after["model"]["parts"][0]["id"], "podium");

        let _ = std::fs::remove_dir_all(&home);
    }
}
