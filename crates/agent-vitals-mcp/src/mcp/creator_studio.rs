//! Creator Studio MCP tools. Calls are routed through the active, descriptor-
//! authorized Creator Studio WebView; this module never opens project storage.
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

fn project_id_prop() -> Value { json!({"type":"string","minLength":1,"maxLength":128}) }
fn operation_id_prop() -> Value { json!({"type":"string","minLength":1,"maxLength":128,"description":"稳定幂等键；超时重试必须复用同一个值。"}) }
fn revision_prop() -> Value { json!({"type":"integer","minimum":0}) }

pub fn specs() -> Vec<ToolSpec> {
    vec![
        spec("creator_layout_list", "List bounded, host-captured City layout snapshots available for new Creator projects. Layouts contain stable trusted anchor IDs and a world revision, not geometry or user analytics.", json!({"limit":{"type":"integer","minimum":1,"maximum":16}}), &[]),
        spec("creator_project_list", "List local Creator Studio projects. Requires the official Creator Studio plugin to be open.", json!({"limit":{"type":"integer","minimum":1,"maximum":100}}), &["limit"]),
        spec("creator_project_read", "Read a bounded UTF-8 byte chunk of a local Creator Studio project document. Reassemble chunks by nextOffset until complete=true; verify the shared documentDigest.", json!({"projectId":project_id_prop(),"offset":{"type":"integer","minimum":0},"maxBytes":{"type":"integer","minimum":1,"maximum":32768}}), &["projectId"]),
        spec("creator_operation_status", "Look up the durable result for a project operation after a timeout; not_found means no committed result is visible.", json!({"projectId":project_id_prop(),"operationId":operation_id_prop()}), &["projectId","operationId"]),
        spec("creator_playtest_history", "Read bounded local visual-playtest summaries for one project. Evidence is client-reported gameplay state, not anti-cheat or leaderboard proof; no input traces, raw logs or analytics are returned.", json!({"projectId":project_id_prop(),"limit":{"type":"integer","minimum":1,"maximum":32}}), &["projectId","limit"]),
        spec("creator_scene_describe", "Compact Agent-facing summary of one project/revision: revision, object counts by kind, optional selected-object whitelist summary, mounts/skin overview, city patch size and editable categories. Bounded; does not return the full project document. Provide `revision` to fail with revision_conflict when the project has moved on. Requires the official Creator Studio plugin to be open.", json!({"projectId":project_id_prop(),"revision":revision_prop(),"selectedObjectId":{"type":"string","minLength":1,"maxLength":128}}), &["projectId"]),
        spec("creator_scene_capture", "Capture a bounded JPEG frame of the live 3D viewport from the active official Studio renderer (local only; no file paths or URLs). Bound to the capture-time project revision with camera info; rejected when the viewport is not ready or the encoded frame exceeds the byte budget. Clients that cannot render images should use the readable degrade summary instead.", json!({"projectId":project_id_prop(),"revision":revision_prop()}), &["projectId"]),
        spec("creator_capabilities_list", "List the registered Creator operation categories, object kinds, budgets and capability versions (schemaVersion 1). Provide `category` to get just that category's capabilities (unknown categories return creator_capability_unknown); `schemaVersion` only supports 1. Stable contract discovery; returns no executable code, and generated operations still go through preview/commit validation.", json!({"category":{"type":"string","minLength":1,"maxLength":64},"schemaVersion":{"type":"integer","enum":[1]}}), &[]),
        spec("creator_scene_inspect", "Inspect one stable objectId (scene object, mount id, or pinned City layout anchor) at an explicit revision: whitelist fields, references and edit constraints only. Never returns source paths, GLB bytes or unrelated analytics. revision_conflict means the project moved on; creator_object_not_found means the id is not an object, mount or layout anchor of this project.", json!({"projectId":project_id_prop(),"revision":revision_prop(),"objectId":{"type":"string","minLength":1,"maxLength":128}}), &["projectId","revision","objectId"]),
        spec("creator_scene_validate", "Run bounded structural validation for one project revision and return per-item diagnostics with stable codes, severity, objectId and source (static-schema vs asset-store), plus explicitly unchecked items that require the City runtime (drive reachability, collision, visual review). Deterministic for the same input/revision; consumes nothing. `validationProfile` only supports \"static\". Requires the official Creator Studio plugin to be open.", json!({"projectId":project_id_prop(),"revision":revision_prop(),"validationProfile":{"type":"string","enum":["static"]}}), &["projectId"]),
        spec("creator_playtest_start", "Ask the active Studio to start one visual playtest of a published, immutable City release. The player drives the playtest in the City plugin; results are read by creator_playtest_result. Provide projectId/expectedRevision to fail fast when the release belongs to another project or revision. Requires `data-mcp serve --allow-local-writes` and the official Creator Studio plugin to be open.", json!({"releaseId":{"type":"string","minLength":1,"maxLength":128},"projectId":project_id_prop(),"expectedRevision":revision_prop(),"requestId":{"type":"string","minLength":1,"maxLength":128,"description":"调用方关联标识；原样回传，便于对齐消息与结果。"}}), &["releaseId"]),
        spec("creator_playtest_result", "Read one playtest run by runId: status (pending/claimed/completed/cancelled/failed/expired), finish time, failure code and bounded client-reported evidence summary.", json!({"runId":{"type":"string","minLength":1,"maxLength":128}}), &["runId"]),
        spec("creator_playtest_cancel", "Cancel one pending or claimed playtest run and release its activity lease. Requires `data-mcp serve --allow-local-writes`. Cancelling an already-finished run returns its terminal state unchanged (cancelled=false); unknown runIds return not_found.", json!({"runId":{"type":"string","minLength":1,"maxLength":128}}), &["runId"]),
        spec("creator_project_create", "Create a local City mini-game project. Pin a listed worldRevision to bind it to trusted City road anchors. Requires `data-mcp serve --allow-local-writes` and the official Creator Studio plugin to be open.", json!({"template":{"type":"string","enum":["checkpoint-race","collect-one"]},"operationId":operation_id_prop(),"worldRevision":{"type":"string","minLength":1,"maxLength":256}}), &["template","operationId","worldRevision"]),
        spec("creator_game_preview", "Validate a declarative mini-game JSON draft without committing it. Returns a short-lived previewId bound to the active Studio instance and base revision.", json!({"projectId":project_id_prop(),"baseRevision":revision_prop(),"game":{"type":"object"}}), &["projectId","baseRevision","game"]),
        spec("creator_scene_preview", "Preview up to 128 operations: scene.object.upsert/remove, anchor.upsert/remove, mount.bind {mount}, mount.remove {mountId}, and skin.select {skinId}. Rust checks schema, IDs, references, slot cardinality, transforms, budgets, and drive/walk reachability in the pinned City's trusted traversal graph. Requires the official Creator Studio plugin to be open.", json!({"projectId":project_id_prop(),"baseRevision":revision_prop(),"operations":{"type":"array","minItems":1,"maxItems":128,"items":{"type":"object"}}}), &["projectId","baseRevision","operations"]),
        spec("creator_project_commit", "Commit a previously previewed game, scene, mount, or skin edit. Requires `data-mcp serve --allow-local-writes`; the preview is single-instance, revision-bound, short-lived, and single-use.", json!({"projectId":project_id_prop(),"previewId":{"type":"string","minLength":1,"maxLength":128},"expectedRevision":revision_prop(),"operationId":operation_id_prop()}), &["projectId","previewId","expectedRevision","operationId"]),
        spec("creator_project_publish", "Publish one saved Creator project revision as an immutable local City release. Requires `data-mcp serve --allow-local-writes`; the official Creator Studio plugin must be open and the project must contain a valid City mount.", json!({"projectId":project_id_prop(),"expectedRevision":revision_prop()}), &["projectId","expectedRevision"]),
    ]
}

fn call_error(code: &str) -> ToolError {
    match code {
        "plugin_call_timeout" | "plugin_call_expired" | "plugin_call_method_unavailable" | "plugin_unavailable" => ToolError::new("plugin_unavailable", "Open the official Creator Studio plugin and retry."),
        "plugin_call_capacity" => ToolError::new("busy", "Creator Studio local request capacity was reached."),
        "plugin_call_too_large" => ToolError::new("invalid_argument", "Creator request exceeded the local IPC payload limit."),
        "creator_project_not_found" => ToolError::new("not_found", "Creator project was not found."),
        "creator_playtest_not_found" => ToolError::new("not_found", "Playtest run was not found; list history to find valid runIds."),
        "creator_playtest_active" => ToolError::new("busy", "Another playtest run is active; cancel it via creator_playtest_cancel or wait for it to finish."),
        "creator_playtest_instance_mismatch" => ToolError::new("permission_denied", "The playtest run belongs to a different Studio session."),
        "creator_playtest_expired" => ToolError::new("preview_expired", "The playtest run expired before completion; start a new one."),
        "creator_playtest_terminal" | "creator_playtest_not_claimed" | "creator_playtest_evidence_required" => ToolError::new("invalid_argument", "Playtest run reached a terminal or invalid state for this transition."),
        "creator_release_project_mismatch" | "creator_release_revision_mismatch" => ToolError::new("invalid_argument", "The releaseId does not match the declared project or revision."),
        "creator_release_not_found" => ToolError::new("not_found", "The City release was not found; publish the project revision again."),
        "creator_capture_unavailable" => ToolError::new("data_unavailable", "Viewport capture is unavailable: open Creator Studio with a loaded 3D viewport and retry, or use creator_scene_describe for a readable summary."),
        "creator_capture_budget_exceeded" => ToolError::new("invalid_argument", "The captured frame exceeded the bounded image budget."),
        "creator_object_not_found" => ToolError::new("not_found", "The objectId is not a scene object, mount or pinned layout anchor of this project."),
        "creator_capability_unknown" => ToolError::new("invalid_argument", "Unknown capability category; call without `category` to list supported categories."),
        "creator_capability_version_unsupported" => ToolError::new("invalid_argument", "Only capability schemaVersion 1 is supported."),
        "creator_validation_profile_unsupported" => ToolError::new("invalid_argument", "`validationProfile` only supports \"static\"; runtime checks are reported as unchecked instead of executed."),
        "creator_layout_not_found" => ToolError::new("not_found", "The selected City layout snapshot is no longer available. List layouts again and retry."),
        "revision_conflict" => ToolError::new("revision_conflict", "Project revision changed; read the current draft and preview again."),
        "preview_expired" => ToolError::new("preview_expired", "Preview expired or was already consumed; create a new preview."),
        "permission_denied" => ToolError::new("permission_denied", "Creator request is not authorized for the active plugin instance."),
        "creator_method_unavailable" | "plugin_call_invalid" => ToolError::new("plugin_unavailable", "Creator Studio does not expose this operation in the current build."),
        "creator_store_unavailable" | "plugin_call_store_unavailable" => ToolError::new("data_unavailable", "Local Creator Studio storage is unavailable."),
        value if value.starts_with("creator_scene_") || value.starts_with("creator_mount_") || value == "creator_skin_not_found" || value == "creator_game_invalid" || value == "creator_game_operation_unsupported" => ToolError::new("invalid_argument", "Creator payload failed schema or budget validation."),
        _ => ToolError::new("data_unavailable", "Creator Studio request failed."),
    }
}

fn call(data_home: &Path, method: &str, payload: &Value, timeout_ms: u64) -> Result<Value, ToolError> {
    let response = agent_vitals_query::query::plugin_calls::call(data_home, "creator-studio", method, payload, timeout_ms).map_err(call_error)?;
    if response["ok"] != true {
        let code = response["error"]["code"].as_str().unwrap_or("creator_request_failed");
        return Err(call_error(code));
    }
    let result = response.get("result").cloned().ok_or_else(|| ToolError::new("data_unavailable", "Creator Studio returned no result."))?;
    Ok(json!({"ok":true,"data":result}))
}

fn required_string<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or_else(|| ToolError::new("invalid_argument", format!("`{key}` is required")))
}

pub fn run(name: &str, args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    match name {
        "creator_layout_list" => {
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(8);
            if !(1..=16).contains(&limit) { return Err(ToolError::new("invalid_argument", "`limit` must be in 1..=16")); }
            call(data_home, "creator.layout.list", &json!({"limit":limit}), 15_000)
        }
        "creator_project_list" => {
            let limit = args.get("limit").and_then(Value::as_u64).filter(|limit| (1..=100).contains(limit)).ok_or_else(|| ToolError::new("invalid_argument", "`limit` must be in 1..=100"))?;
            call(data_home, "creator.project.list", &json!({"limit":limit}), 15_000)
        }
        "creator_project_read" => {
            let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0);
            let max_bytes = args.get("maxBytes").and_then(Value::as_u64).unwrap_or(32 * 1024);
            if max_bytes == 0 || max_bytes > 32 * 1024 { return Err(ToolError::new("invalid_argument", "`maxBytes` must be in 1..=32768")); }
            call(data_home, "creator.project.read_chunk", &json!({"projectId":required_string(args,"projectId")?,"offset":offset,"maxBytes":max_bytes}), 15_000)
        }
        "creator_operation_status" => call(data_home, "creator.operation.status", &json!({"projectId":required_string(args,"projectId")?,"operationId":required_string(args,"operationId")?}), 15_000),
        "creator_playtest_history" => {
            let limit = args.get("limit").and_then(Value::as_u64).filter(|limit| (1..=32).contains(limit)).ok_or_else(|| ToolError::new("invalid_argument", "`limit` must be in 1..=32"))?;
            call(data_home, "creator.project.playtest.history", &json!({"projectId":required_string(args,"projectId")?,"limit":limit}), 15_000)
        }
        "creator_playtest_start" => {
            if !allow_local_writes { return Err(ToolError::new("permission_denied", "Starting a playtest requires `data-mcp serve --allow-local-writes`.")); }
            let release_id = required_string(args,"releaseId")?;
            if !release_id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) || !release_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-')) {
                return Err(ToolError::new("invalid_argument", "`releaseId` must be a stable object id"));
            }
            let mut payload = json!({"releaseId":release_id});
            if let Some(project_id) = args.get("projectId").and_then(Value::as_str).filter(|value| !value.is_empty()) {
                payload["projectId"] = json!(project_id);
            }
            if let Some(revision) = args.get("expectedRevision").and_then(Value::as_u64) {
                payload["expectedRevision"] = json!(revision);
            }
            if let Some(request_id) = args.get("requestId").and_then(Value::as_str).filter(|value| !value.is_empty()) {
                payload["requestId"] = json!(request_id);
            }
            call(data_home, "creator.project.playtest.start", &payload, 15_000)
        }
        "creator_playtest_result" => call(data_home, "creator.project.playtest.result", &json!({"runId":required_string(args,"runId")?}), 15_000),
        "creator_playtest_cancel" => {
            if !allow_local_writes { return Err(ToolError::new("permission_denied", "Cancelling a playtest requires `data-mcp serve --allow-local-writes`.")); }
            call(data_home, "creator.project.playtest.cancel", &json!({"runId":required_string(args,"runId")?}), 15_000)
        }
        "creator_scene_describe" => {
            let project_id = required_string(args,"projectId")?;
            let mut payload = json!({"projectId":project_id});
            if let Some(revision) = args.get("revision").and_then(Value::as_u64) { payload["revision"] = json!(revision); }
            if let Some(selected) = args.get("selectedObjectId").and_then(Value::as_str).filter(|value| !value.is_empty()) {
                payload["selectedObjectId"] = json!(selected);
            }
            call(data_home, "creator.scene.describe", &payload, 15_000)
        }
        "creator_scene_capture" => {
            let project_id = required_string(args,"projectId")?;
            let mut payload = json!({"projectId":project_id});
            if let Some(revision) = args.get("revision").and_then(Value::as_u64) { payload["revision"] = json!(revision); }
            call(data_home, "creator.scene.capture", &payload, 20_000)
        }
        "creator_capabilities_list" => {
            let mut payload = json!({});
            if let Some(category) = args.get("category").and_then(Value::as_str).filter(|value| !value.is_empty()) {
                payload["category"] = json!(category);
            }
            if let Some(version) = args.get("schemaVersion").and_then(Value::as_u64) {
                payload["schemaVersion"] = json!(version);
            }
            call(data_home, "creator.capabilities.list", &payload, 15_000)
        }
        "creator_scene_inspect" => call(data_home, "creator.scene.inspect", &json!({
            "projectId":required_string(args,"projectId")?,
            "revision":args.get("revision").and_then(Value::as_u64).ok_or_else(|| ToolError::new("invalid_argument", "`revision` must be a non-negative integer"))?,
            "objectId":required_string(args,"objectId")?}), 15_000),
        "creator_scene_validate" => {
            let project_id = required_string(args,"projectId")?;
            let mut payload = json!({"projectId":project_id});
            if let Some(revision) = args.get("revision").and_then(Value::as_u64) { payload["revision"] = json!(revision); }
            if let Some(profile) = args.get("validationProfile").and_then(Value::as_str).filter(|value| !value.is_empty()) {
                payload["validationProfile"] = json!(profile);
            }
            call(data_home, "creator.scene.validate", &payload, 20_000)
        }
        "creator_project_create" => {
            if !allow_local_writes { return Err(ToolError::new("permission_denied", "Creator project creation requires `data-mcp serve --allow-local-writes`.")); }
            let template = required_string(args,"template")?;
            if !matches!(template,"checkpoint-race"|"collect-one") { return Err(ToolError::new("invalid_argument", "unsupported Creator project template")); }
            let payload = json!({"template":template,"operationId":required_string(args,"operationId")?,
                "worldRevision":required_string(args,"worldRevision")?});
            call(data_home, "creator.project.create", &payload, 15_000)
        }
        "creator_game_preview" => {
            let project_id = required_string(args,"projectId")?;
            let revision = args.get("baseRevision").and_then(Value::as_u64).ok_or_else(|| ToolError::new("invalid_argument", "`baseRevision` must be a non-negative integer"))?;
            let game = args.get("game").filter(|value| value.is_object()).ok_or_else(|| ToolError::new("invalid_argument", "`game` must be an object"))?;
            if game.to_string().len() > 48 * 1024 { return Err(ToolError::new("invalid_argument", "Game preview exceeds the bounded MCP payload size.")); }
            call(data_home, "creator.game.preview", &json!({"projectId":project_id,"baseRevision":revision,"game":game}), 15_000)
        }
        "creator_scene_preview" => {
            let project_id = required_string(args,"projectId")?;
            let revision = args.get("baseRevision").and_then(Value::as_u64).ok_or_else(|| ToolError::new("invalid_argument", "`baseRevision` must be a non-negative integer"))?;
            let operations = args.get("operations").filter(|value| value.as_array().is_some_and(|items| !items.is_empty() && items.len() <= 128)).ok_or_else(|| ToolError::new("invalid_argument", "`operations` must contain 1..=128 operations"))?;
            if operations.to_string().len() > 48 * 1024 { return Err(ToolError::new("invalid_argument", "Scene operations exceed the bounded MCP payload size.")); }
            call(data_home, "creator.scene.preview", &json!({"projectId":project_id,"baseRevision":revision,"operations":operations}), 15_000)
        }
        "creator_project_commit" => {
            if !allow_local_writes { return Err(ToolError::new("permission_denied", "Creator project commit requires `data-mcp serve --allow-local-writes`.")); }
            let project_id = required_string(args,"projectId")?;
            let preview_id = required_string(args,"previewId")?;
            let revision = args.get("expectedRevision").and_then(Value::as_u64).ok_or_else(|| ToolError::new("invalid_argument", "`expectedRevision` must be a non-negative integer"))?;
            let operation_id = required_string(args,"operationId")?;
            let payload = json!({"projectId":project_id,"previewId":preview_id,"expectedRevision":revision,"operationId":operation_id});
            // The host inspects the one-time preview capability and commits its
            // validated document regardless of whether it contains game or scene edits.
            call(data_home, "creator.project.commit", &payload, 15_000)
        }
        "creator_project_publish" => {
            if !allow_local_writes { return Err(ToolError::new("permission_denied", "Creator project publication requires `data-mcp serve --allow-local-writes`.")); }
            let project_id = required_string(args,"projectId")?;
            let revision = args.get("expectedRevision").and_then(Value::as_u64).ok_or_else(|| ToolError::new("invalid_argument", "`expectedRevision` must be a non-negative integer"))?;
            call(data_home, "creator.project.publish", &json!({"projectId":project_id,"expectedRevision":revision}), 15_000)
        }
        _ => Err(ToolError::new("internal_error", "Creator Studio MCP tool is not wired.")),
    }
}
