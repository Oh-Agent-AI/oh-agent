//! MCP `im_publish`: agents post chat / claim / release onto the squad channel.
//!
//! Server assigns `id`/`ts`. Building preview/set/reset/reject are **not**
//! accepted here — City MCP fans those out itself. `observe` stays closed.

use std::path::Path;

use serde_json::{json, Value};

use super::{build_envelope, coverage_not_applicable, AuthorityHandle, ToolError, ToolSpec};
use crate::query::city_building::BuildingError;
use crate::query::city_im;

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "im_publish",
        description: "Publish a squad IM envelope (chat, claim, or release) into the open Agent City window. Server assigns id and ts. Building preview/set/reset/reject are fanned out by those MCP tools — do not also report them here. Requires --allow-local-writes. Soft claims are stealable with TTL; set still uses expected_revision CAS.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "City session handle from sessions_search.session_ref (sr_…) or the building asset_ref (ca_…)."
                },
                "agent_id": {
                    "type": "string",
                    "description": "Stable calling-agent identity. Display uses agent_name; identity is this field."
                },
                "agent_name": {
                    "type": "string",
                    "description": "Short display name for the City HUD (required)."
                },
                "kind": {
                    "type": "string",
                    "enum": ["chat", "claim", "release"],
                    "description": "Agent-publishable kinds only. preview/reject/set/reset are server fanout; observe is off."
                },
                "payload": {
                    "type": "object",
                    "description": "chat: {text}. claim: {asset_ref, ttl_sec?}. release: {asset_ref, reason?: manual}."
                }
            },
            "required": ["session_id", "agent_id", "agent_name", "kind", "payload"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "Standard MCP envelope. data.ok plus data.envelope (v:1)."
        }),
    }
}

fn required_string<'a>(args: &'a Value, name: &str) -> Result<&'a str, ToolError> {
    args.get(name).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| {
        ToolError::new("invalid_argument", format!("`{name}` is required"))
    })
}

fn required_object<'a>(args: &'a Value, name: &str) -> Result<&'a Value, ToolError> {
    match args.get(name) {
        Some(value) if value.is_object() => Ok(value),
        _ => Err(ToolError::new("invalid_argument", format!("`{name}` must be a JSON object"))),
    }
}

fn writes_denied() -> ToolError {
    ToolError::new(
        "permission_denied",
        "im_publish requires the explicit `--allow-local-writes` server flag; default MCP remains read-only",
    )
}

fn map_error(error: BuildingError) -> Result<Value, ToolError> {
    match error.kind {
        "not_found" if error.rule == "unknown_session" => {
            Err(ToolError::new("not_found", error.message.as_str()))
        }
        "validation" => Err(ToolError::new("invalid_argument", error.message.as_str())),
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

pub fn run(args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    if !allow_local_writes { return Err(writes_denied()); }
    let session_id = required_string(args, "session_id")?;
    let agent_id = required_string(args, "agent_id")?;
    let agent_name = required_string(args, "agent_name")?;
    let kind = required_string(args, "kind")?;
    let payload = required_object(args, "payload")?;
    let actor = match city_im::parse_actor(agent_id, agent_name) {
        Ok(actor) => actor,
        Err(error) => return map_error(error),
    };
    let handle = AuthorityHandle::open(data_home)?;
    match city_im::publish(data_home, handle.conn(), session_id, &actor, kind, payload) {
        Ok(data) => Ok(envelope(&handle, data)),
        Err(error) => map_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;
    use crate::mcp::{dispatch, dispatch_with_permissions};

    fn tmp_home() -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!(
            "avmcp-im-{}-{}",
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
             VALUES ('sess-im-mcp', 'codex', 'native-im-mcp', 'ns', 1)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, session_key,
                 source_event_id, observation_kind, event_ts_ms, uncached_input_tokens, cache_read_tokens,
                 cache_write_tokens, output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('fim', 'codex', 'ns', 'native-im-mcp', 'sess-im-mcp', 'e1', 'assistant-usage', 1, 50000, 0, 0, 50000, 'run', 1, 1)",
            [],
        ).unwrap();
        drop(db);
        let salt = crate::query::session_ref::load_or_create_salt(home).unwrap();
        crate::query::session_ref::session_ref(&salt, "sess-im-mcp")
    }

    fn data(env: &Value) -> &Value { &env["data"] }

    #[test]
    fn publish_requires_writes_and_rejects_building_kinds() {
        let home = tmp_home();
        let session_id = seed(&home);
        let denied = dispatch("im_publish", &json!({
            "session_id": session_id, "agent_id": "nano", "agent_name": "Nano",
            "kind": "chat", "payload": {"text": "hi"},
        }), &home).unwrap_err();
        assert_eq!(denied.code, "permission_denied");

        let forbidden = dispatch_with_permissions("im_publish", &json!({
            "session_id": session_id, "agent_id": "nano", "agent_name": "Nano",
            "kind": "preview", "payload": {"asset_ref": "x"},
        }), &home, true).unwrap_err();
        assert_eq!(forbidden.code, "invalid_argument");

        let got = dispatch("get_building", &json!({"session_id": session_id}), &home).unwrap();
        let asset = got["data"]["projection"]["asset_ref"].as_str().unwrap();
        let claimed = data(&dispatch_with_permissions("im_publish", &json!({
            "session_id": session_id, "agent_id": "nano", "agent_name": "Nano",
            "kind": "claim", "payload": {"asset_ref": asset, "ttl_sec": 60},
        }), &home, true).unwrap()).clone();
        assert_eq!(claimed["ok"], true);
        assert_eq!(claimed["envelope"]["kind"], "claim");
        assert_eq!(claimed["envelope"]["agent_name"], "Nano");
        assert_eq!(claimed["envelope"]["v"], 1);
        assert!(claimed["envelope"]["id"].as_str().unwrap().starts_with("evt_"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
