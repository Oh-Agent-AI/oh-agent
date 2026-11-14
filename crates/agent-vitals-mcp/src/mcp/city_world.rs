//! Agent tools for applying registered City world profiles through the active
//! official City WebView. World validation and persistence stay in City TS.
use std::path::Path;

use serde_json::{json, Value};

use super::{ToolError, ToolSpec};

fn spec(name: &'static str, description: &'static str, properties: Value, required: &[&str]) -> ToolSpec {
    ToolSpec {
        name,
        description,
        input_schema: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        output_schema: json!({"type":"object","properties":{"ok":{"type":"boolean"},"data":{"type":"object"}}}),
    }
}

pub fn specs() -> Vec<ToolSpec> {
    vec![
        spec("city_world_profile_preview", "Validate a data-only CityWorldProfileV1 in the active official City plugin. Only registered geography generators and visual themes are accepted; this does not execute code or install assets.", json!({
            "profile":{"type":"object","description":"CityWorldProfileV1 data recipe produced by @agent-vitals/city-sdk. Current runtime supports coastal-islands-v1 and arid-dunes-v1."}
        }), &["profile"]),
        spec("city_world_profile_apply", "Apply a City world profile previously previewed by city_world_profile_preview. Requires --allow-local-writes, the same active City plugin instance, and an idle, rendered City.", json!({
            "previewId":{"type":"string","minLength":1,"maxLength":128},
            "operationId":{"type":"string","minLength":1,"maxLength":128,"description":"Stable idempotency key; reuse it when retrying after a timeout."}
        }), &["previewId","operationId"]),
    ]
}

fn call_error(code: &str) -> ToolError {
    match code {
        "plugin_call_timeout" | "plugin_call_expired" | "plugin_call_method_unavailable" | "plugin_unavailable" | "plugin_instance_unavailable" | "plugin_instance_mismatch" => ToolError::new("plugin_unavailable", "Open the official Agent City plugin and retry."),
        "plugin_call_capacity" => ToolError::new("busy", "The City local request queue is busy."),
        "plugin_call_too_large" => ToolError::new("invalid_argument", "The world profile exceeds the local IPC payload limit."),
        "permission_denied" => ToolError::new("permission_denied", "The active City instance does not authorize world profile edits."),
        "preview_expired" => ToolError::new("preview_expired", "The preview expired or was already applied; create a new preview."),
        "revision_conflict" => ToolError::new("revision_conflict", "The current City world changed after preview; preview the profile again."),
        "city_world_busy" => ToolError::new("busy", "City is running another activity. Stop it, then apply the world profile."),
        "city_world_profile_city_mismatch" => ToolError::new("invalid_argument", "This profile targets a different City. Create an independent City draft instead of changing the active City."),
        "operation_id_conflict" => ToolError::new("invalid_argument", "This operationId was already used for a different preview."),
        value if value.starts_with("world_profile_") || value.starts_with("city_world_") => ToolError::new("invalid_argument", "The City world profile failed schema, runtime registration, or size validation."),
        _ => ToolError::new("data_unavailable", "The City world profile request failed."),
    }
}

fn call(data_home: &Path, method: &str, payload: &Value, timeout_ms: u64) -> Result<Value, ToolError> {
    let response = agent_vitals_query::query::plugin_calls::call(data_home, "city", method, payload, timeout_ms).map_err(call_error)?;
    if response["ok"] != true {
        let code = response["error"]["code"].as_str().unwrap_or("city_world_profile_failed");
        return Err(call_error(code));
    }
    let result = response.get("result").cloned().ok_or_else(|| ToolError::new("data_unavailable", "City returned no world profile result."))?;
    Ok(json!({"ok":true,"data":result}))
}

fn required_string<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key).and_then(Value::as_str).filter(|value| !value.is_empty())
        .ok_or_else(|| ToolError::new("invalid_argument", format!("`{key}` is required")))
}

pub fn run(name: &str, args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    match name {
        "city_world_profile_preview" => {
            let profile = args.get("profile").filter(|value| value.is_object())
                .ok_or_else(|| ToolError::new("invalid_argument", "`profile` must be a JSON object"))?;
            if profile.to_string().len() > 48 * 1024 {
                return Err(ToolError::new("invalid_argument", "World profile preview exceeds the bounded MCP payload size."));
            }
            call(data_home, "city.world.profile.preview", &json!({"profile":profile}), 15_000)
        }
        "city_world_profile_apply" => {
            if !allow_local_writes {
                return Err(ToolError::new("permission_denied", "Applying a City world profile requires `data-mcp serve --allow-local-writes`."));
            }
            call(data_home, "city.world.profile.apply", &json!({
                "previewId":required_string(args,"previewId")?,
                "operationId":required_string(args,"operationId")?,
            }), 30_000)
        }
        _ => Err(ToolError::new("internal_error", "City world MCP tool is not wired.")),
    }
}
