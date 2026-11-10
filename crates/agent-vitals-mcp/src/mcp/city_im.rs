//! MCP `im_publish`: agents post chat / claim / release onto the squad channel.
//!
//! Server assigns `id`/`ts`. Building preview/set/reset/reject are **not**
//! accepted here — City MCP fans those out itself. `observe` stays closed.

use std::path::Path;

use serde_json::{json, Value};

use super::{build_envelope, coverage_not_applicable, AuthorityHandle, ToolError, ToolSpec};

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
    let handle = AuthorityHandle::open(data_home)?;
    let method = "city.im.publish";
    let request = json!({ "session_id": session_id, "agent_id": agent_id, "agent_name": agent_name, "kind": kind, "payload": payload });
    let response = agent_vitals_query::query::plugin_calls::call(data_home, "city", method, &request, 20_000)
        .map_err(map_host_error)?;
    if response["ok"] != true {
        let code = response["error"]["code"].as_str().unwrap_or("plugin_call_failed");
        return Err(map_host_error(code));
    }
    let data = response.get("result").filter(|value| value.is_object()).cloned()
        .ok_or_else(|| ToolError::new("data_unavailable", "City returned an invalid response"))?;
    Ok(envelope(&handle, data))
}

fn map_host_error(code: &str) -> ToolError {
    match code {
        "session_unavailable" => ToolError::new("not_found", "the session is not available in the open Agent City window"),
        "invalid_actor" | "invalid_chat" | "invalid_payload" | "invalid_ttl" | "invalid_release" | "kind_forbidden" | "asset_mismatch" => {
            ToolError::new("invalid_argument", code)
        }
        "plugin_call_timeout" | "plugin_call_expired" | "plugin_call_method_unavailable" => {
            ToolError::new("plugin_unavailable", "Open the local Agent City window and retry the request")
        }
        _ => ToolError::new("data_unavailable", code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;
    use crate::mcp::{dispatch, dispatch_with_permissions};
    use std::time::{Duration, Instant};

    fn tmp_home() -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!(
            "avmcp-im-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    fn seed(home: &Path) {
        let _ = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(home), 1_700_000_000_000).unwrap();
    }

    fn dispatch_through_city_host(args: Value, expected_error: Option<&'static str>) -> Result<Value, ToolError> {
        let home = tmp_home();
        seed(&home);
        let worker_home = home.clone();
        let worker = std::thread::spawn(move || dispatch_with_permissions("im_publish", &args, &worker_home, true));
        let allowed = vec!["city.im.publish".to_string()];
        let started = Instant::now();
        let (call_id, payload) = loop {
            let pending = crate::query::plugin_calls::claim_pending(&home, "city", "test-city-instance", &allowed, 1).unwrap();
            if let Some(call) = pending.into_iter().next() {
                assert_eq!(call["method"], "city.im.publish");
                break (call["callId"].as_str().unwrap().to_string(), call["payload"].clone());
            }
            assert!(started.elapsed() < Duration::from_secs(2), "City host call was not queued");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(payload["session_id"], "session-test");
        let response = if let Some(code) = expected_error {
            json!({"ok":false,"error":{"code":code}})
        } else {
            json!({"ok":true,"result":{"ok":true,"envelope":{"kind":"claim","agent_name":"Nano","v":1,"id":"evt_test"}}})
        };
        crate::query::plugin_calls::respond(&home, "city", "test-city-instance", &call_id, &response).unwrap();
        let result = worker.join().unwrap();
        let _ = std::fs::remove_dir_all(&home);
        result
    }

    #[test]
    fn publish_requires_writes_and_rejects_building_kinds() {
        let home = tmp_home();
        seed(&home);
        let denied = dispatch("im_publish", &json!({
            "session_id": "session-test", "agent_id": "nano", "agent_name": "Nano",
            "kind": "chat", "payload": {"text": "hi"},
        }), &home).unwrap_err();
        assert_eq!(denied.code, "permission_denied");

        let forbidden = dispatch_through_city_host(json!({
            "session_id": "session-test", "agent_id": "nano", "agent_name": "Nano",
            "kind": "preview", "payload": {"asset_ref": "x"},
        }), Some("kind_forbidden")).unwrap_err();
        assert_eq!(forbidden.code, "invalid_argument");

        let claimed = dispatch_through_city_host(json!({
            "session_id": "session-test", "agent_id": "nano", "agent_name": "Nano",
            "kind": "claim", "payload": {"asset_ref": "ca_test", "ttl_sec": 60},
        }), None).unwrap();
        assert_eq!(claimed["data"]["ok"], true);
        assert_eq!(claimed["data"]["envelope"]["kind"], "claim");
        assert_eq!(claimed["data"]["envelope"]["agent_name"], "Nano");
        assert_eq!(claimed["data"]["envelope"]["v"], 1);
        assert_eq!(claimed["data"]["envelope"]["id"], "evt_test");
        let _ = std::fs::remove_dir_all(&home);
    }
}
