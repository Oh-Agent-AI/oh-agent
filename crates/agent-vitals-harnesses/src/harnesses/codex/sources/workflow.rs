//! Codex rollout JSONL → harness-neutral WorkflowEvent.
//!
//! The rollout format has Legacy and Paginated variants with overlapping
//! shadow records.  This adapter follows the same existence probing as the
//! evidence adapter: a Paginated CommandExecution is the primary tool event;
//! Legacy response items are used only when no CommandExecution exists.
//! Commands, prompts, output, paths, and raw errors never cross this boundary.

use std::collections::HashMap;
use std::path::Path;

use agent_vitals_domain::contracts::session_key::SessionKey;
use agent_vitals_domain::session_semantics::{fingerprint, iso_to_epoch_ms, safe_label, ModelSwitchTracker};
use agent_vitals_domain::source_identity::fnv1a64_hex;
use agent_vitals_domain::workflow::WorkflowEvent;
use serde_json::Value;

use super::parse_codex_session_log;

fn event_id(path: &Path, ordinal: usize, event_type: &str) -> String {
    let material = format!("codex|{}|{}|{}", path.to_string_lossy(), ordinal, event_type);
    format!("workflow:codex:{}", fnv1a64_hex(material.as_bytes()))
}

#[allow(clippy::too_many_arguments)]
fn add_event(
    out: &mut Vec<WorkflowEvent>, path: &Path, ordinal: usize, session_key: &str,
    event_type: &str, timestamp: Option<&str>, kind: Option<&str>, capability_id: Option<String>,
    outcome: &str, error: Option<String>, invocation: Option<String>, duration_ms: Option<i64>,
) {
    let Some(event_ts_ms) = iso_to_epoch_ms(timestamp) else { return };
    let event = WorkflowEvent {
        event_id: event_id(path, ordinal, event_type),
        session_key: Some(session_key.to_string()),
        event_ts_ms,
        event_type: event_type.to_string(),
        capability_kind: kind.map(str::to_string),
        capability_id,
        capability_version: None,
        outcome: outcome.to_string(),
        duration_ms: duration_ms.filter(|value| *value >= 0),
        error_fingerprint: error,
        invocation_fingerprint: invocation,        // V16 富化字段：本执行环境的结构化错误码接入是下一批；不猜、不填
        // （NULL = 未富化，不编数）。
        error_code: None,
        error_class: None,
        error_excerpt: None,
        args_excerpt: None,
        request_bytes: None,
        result_bytes: None,
        native_event_id: None,
        source_line: None,
        source_byte_offset: None,
    };
    if event.validate().is_ok() { out.push(event); }
}

fn item_name(item: &Value) -> Option<String> {
    item.get("name").and_then(Value::as_str)
        .or_else(|| item.get("tool_name").and_then(Value::as_str))
        .map(safe_label)
}

/// 可执行文件名只取末段（`/bin/zsh` → `zsh`）：`safe_label` 允许 `/`，路径会原样
/// 进权威表并经 insights 出 MCP（§10 禁止路径，验收 finding）。
fn command_name(item: &Value) -> Option<String> {
    item.get("command").and_then(Value::as_array)
        .and_then(|command| command.first()).and_then(Value::as_str)
        .map(|program| program.rsplit('/').next().unwrap_or(program))
        .filter(|program| !program.is_empty())
        .map(safe_label)
}

/// 调用参数取材（指纹公式在 `session_semantics::invocation_fingerprint`）：
/// CommandExecution 取 `command` 数组，Legacy 调用取 `arguments` / `input`。
fn invocation_fingerprint(name: &str, item: &Value) -> String {
    let args = item.get("command").filter(|value| value.is_array())
        .or_else(|| item.get("arguments"))
        .or_else(|| item.get("input"));
    agent_vitals_domain::session_semantics::invocation_fingerprint("codex", name, args)
}

fn is_skill(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "skill" | "skills")
        || name.to_ascii_lowercase().starts_with("skill/")
}

#[allow(clippy::too_many_arguments)]
fn completed_item(item: &Value, has_command_execution: bool, calls: &mut HashMap<String, (String, String)>,
    out: &mut Vec<WorkflowEvent>, path: &Path, ordinal: usize, session_key: &str,
    timestamp: Option<&str>) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    if item_type == "CommandExecution" {
        let Some(name) = command_name(item) else { return };
        let invocation = Some(invocation_fingerprint(&name, item));
        let item_id = item.get("id").and_then(Value::as_str).unwrap_or("");
        if !item_id.is_empty() { calls.insert(item_id.to_string(), (name.clone(), invocation.clone().unwrap_or_default())); }
        add_event(out, path, ordinal, session_key, "tool_invoked", timestamp, Some("tool"),
            Some(name.clone()), "unknown", None, invocation.clone(), None);
        let exit_code = item.get("exit_code").and_then(Value::as_i64);
        let result = match exit_code { Some(0) => "succeeded", Some(_) => "failed", None => "unknown" };
        let error = exit_code.filter(|code| *code != 0)
            .map(|code| fingerprint(&format!("codex-exit:{code}")));
        let duration = item.get("duration").and_then(Value::as_i64);
        add_event(out, path, ordinal, session_key, "tool_finished", timestamp, Some("tool"),
            Some(name), result, error, invocation, duration);
        return;
    }
    if has_command_execution { return; }
    let Some(name) = item_name(item) else { return };
    let invocation = Some(invocation_fingerprint(&name, item));
    let call_id = item.get("tool_call_id").and_then(Value::as_str).unwrap_or("");
    if !call_id.is_empty() { calls.insert(call_id.to_string(), (name.clone(), invocation.clone().unwrap_or_default())); }
    if is_skill(&name) {
        add_event(out, path, ordinal, session_key, "skill_invoked", timestamp, Some("skill"),
            Some(name), "unknown", None, invocation, None);
    } else {
        add_event(out, path, ordinal, session_key, "tool_invoked", timestamp, Some("tool"),
            Some(name), "unknown", None, invocation, None);
    }
}

/// Emit privacy-safe workflow events from one Codex rollout file.
pub fn codex_file_to_workflow_events(
    path: &Path,
    machine_namespace: &str,
    source_profile: &str,
) -> Result<Vec<WorkflowEvent>, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let parsed = parse_codex_session_log(&String::from_utf8_lossy(&bytes));
    let Some(items) = parsed.get("items").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let native_session_id = parsed.get("session_id").and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| path.file_stem().and_then(|value| value.to_str()).unwrap_or("").to_string());
    let session_key = SessionKey::new("codex", &native_session_id, source_profile, machine_namespace).ledger_key();
    let has_command_execution = items.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("event_msg")
            && item.pointer("/payload/type").and_then(Value::as_str) == Some("item_completed")
            && item.pointer("/payload/item/type").and_then(Value::as_str) == Some("CommandExecution")
    });
    let mut out = Vec::new();
    let mut calls = HashMap::new();
    let mut models = ModelSwitchTracker::default();
    for (ordinal, item) in items.iter().enumerate() {
        let timestamp = item.get("timestamp").and_then(Value::as_str);
        let top = item.get("type").and_then(Value::as_str).unwrap_or("");
        let inner = item.pointer("/payload/type").and_then(Value::as_str).unwrap_or("");
        let payload = item.get("payload").unwrap_or(&Value::Null);
        if top == "turn_context" {
            if let Some(model) = payload.get("model").and_then(Value::as_str) {
                let model = safe_label(model);
                if models.observe(&model) {
                    add_event(&mut out, path, ordinal, &session_key, "model_switched", timestamp,
                        Some("model"), Some(model), "succeeded", None, None, None);
                }
            }
        }
        if top == "event_msg" {
            match inner {
                "task_started" => add_event(&mut out, path, ordinal, &session_key, "task_started",
                    timestamp, None, None, "unknown", None, None, None),
                "task_complete" => {
                    let error = (!payload.get("error").is_none() && !payload["error"].is_null())
                        .then(|| fingerprint("codex-task-error"));
                    let result = if error.is_some() { "failed" } else { "succeeded" };
                    add_event(&mut out, path, ordinal, &session_key, "task_finished", timestamp,
                        None, None, result, error, None, None);
                }
                "item_completed" => {
                    if let Some(item) = payload.get("item") {
                        completed_item(item, has_command_execution, &mut calls, &mut out, path,
                            ordinal, &session_key, timestamp);
                    }
                }
                _ => {}
            }
        }
        if top == "response_item" && !has_command_execution {
            match inner {
                "custom_tool_call" | "function_call" | "tool_search_call" => {
                    completed_item(payload, false, &mut calls, &mut out, path, ordinal,
                        &session_key, timestamp);
                }
                "custom_tool_call_output" | "function_call_output" | "tool_search_output" => {
                    let call_id = payload.get("call_id").and_then(Value::as_str).unwrap_or("");
                    let Some((name, invocation)) = calls.get(call_id).cloned() else { continue };
                    let invocation = Some(invocation);
                    add_event(&mut out, path, ordinal, &session_key, "tool_finished", timestamp,
                        Some("tool"), Some(name), "unknown", None, invocation, None);
                }
                _ => {}
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::codex_file_to_workflow_events;

    #[test]
    fn paginated_rollout_emits_safe_task_tool_and_model_events() {
        let path = std::env::temp_dir().join(format!("av-codex-workflow-{}.jsonl", std::process::id()));
        let text = concat!(
            r#"{"type":"session_meta","timestamp":"2026-07-25T11:19:35.404Z","payload":{"session_id":"s1"}}"#, "\n",
            r#"{"type":"turn_context","timestamp":"2026-07-25T11:19:36.000Z","payload":{"model":"gpt-5","sandbox_policy":"workspace-write"}}"#, "\n",
            r#"{"type":"event_msg","timestamp":"2026-07-25T11:20:00.000Z","payload":{"type":"task_started"}}"#, "\n",
            r#"{"type":"event_msg","timestamp":"2026-07-25T11:20:02.000Z","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"x","command":["bash","-c","cat /Users/private/secret"],"exit_code":1,"duration":10}}}"#, "\n",
            r#"{"type":"event_msg","timestamp":"2026-07-25T11:20:03.000Z","payload":{"type":"task_complete","error":null}}"#, "\n",
        );
        std::fs::write(&path, text).unwrap();
        let events = codex_file_to_workflow_events(&path, "machine", "default").unwrap();
        assert!(events.iter().any(|event| event.event_type == "tool_invoked"));
        assert!(events.iter().any(|event| event.event_type == "tool_finished" && event.outcome == "failed"));
        assert!(events.iter().any(|event| event.event_type == "task_started"));
        assert!(events.iter().all(|event| event.validate().is_ok()));
        let debug = format!("{events:?}");
        assert!(!debug.contains("/Users/private"));
        std::fs::remove_file(path).ok();
    }

    /// 调用指纹区分命令参数（PARSER_VERSION 6）：此前 `codex-tool:bash` 一个
    /// 指纹覆盖所有 shell 命令，「同一调用重复失败」无从谈起。
    #[test]
    fn command_execution_fingerprint_includes_the_command() {
        let path = std::env::temp_dir().join(format!("av-codex-fp-{}.jsonl", std::process::id()));
        let item = |id: &str, cmd: &str| format!(
            r#"{{"type":"event_msg","timestamp":"2026-07-25T11:20:02.000Z","payload":{{"type":"item_completed","item":{{"type":"CommandExecution","id":"{id}","command":["/bin/zsh","-c","{cmd}"],"exit_code":1}}}}}}"#);
        let text = [
            r#"{"type":"session_meta","timestamp":"2026-07-25T11:19:35.404Z","payload":{"session_id":"s1"}}"#.to_string(),
            item("a", "npm test"), item("b", "npm test"), item("c", "ls"),
        ].join("\n") + "\n";
        std::fs::write(&path, text).unwrap();
        let events = codex_file_to_workflow_events(&path, "machine", "default").unwrap();
        let fps: Vec<&str> = events.iter().filter(|e| e.event_type == "tool_finished")
            .filter_map(|e| e.invocation_fingerprint.as_deref()).collect();
        assert_eq!(fps.len(), 3);
        assert_eq!(fps[0], fps[1]);
        assert_ne!(fps[0], fps[2]);
        assert!(events.iter().all(|e| e.capability_id.as_deref().is_none_or(|c| !c.contains('/'))),
            "能力名不得是路径");
        std::fs::remove_file(path).ok();
    }
}
