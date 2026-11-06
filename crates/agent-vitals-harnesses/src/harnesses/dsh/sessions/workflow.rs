//! DSH execution events -> the harness-neutral workflow contract.
//!
//! This is deliberately an adapter, not a product query.  DSH's `data` object
//! may contain command text, arguments, prompts, and error messages; none of
//! those values are copied into [`WorkflowEvent`].  Only stable names and
//! fingerprints cross the adapter boundary.

use std::collections::HashMap;

use agent_vitals_domain::contracts::session_key::SessionKey;
use agent_vitals_domain::workflow::WorkflowEvent;
use serde_json::Value;

fn session_key(native_session_id: &str, machine_namespace: &str, profile: &str) -> String {
    SessionKey::new("dsh", native_session_id, profile, machine_namespace).ledger_key()
}

fn event_time(event: &Value) -> Option<i64> {
    event.get("time").and_then(Value::as_i64).filter(|time| *time >= 0)
}

fn stable_id(session_id: &str, ordinal: usize, event_type: &str, event: &Value) -> String {
    let encoded = serde_json::to_string(event).unwrap_or_default();
    let mut material = format!("dsh|{session_id}|{ordinal}|{event_type}|");
    material.push_str(&encoded);
    format!(
        "workflow:dsh:{}",
        agent_vitals_domain::source_identity::fnv1a64_hex(material.as_bytes())
    )
}

// `fingerprint` / `safe_label` 是执行环境无关的规则，唯一实现在
// `session_semantics`（此前这里有一份逐字相同的私有副本）。
use agent_vitals_domain::session_semantics::{fingerprint, safe_label, ModelSwitchTracker};

fn capability_id(event: &Value) -> Option<String> {
    event
        .pointer("/data/name")
        .and_then(Value::as_str)
        .map(safe_label)
}

fn error_code(event: &Value) -> Option<&str> {
    event
        .pointer("/data/error/code")
        .and_then(Value::as_str)
        .or_else(|| {
            event
                .pointer("/data/message/content")
                .and_then(Value::as_array)
                .and_then(|content| {
                    content.iter().find_map(|part| {
                        part.get("isError")
                            .and_then(Value::as_bool)
                            .filter(|is_error| *is_error)
                            .and_then(|_| part.get("errorCode"))
                            .and_then(Value::as_str)
                    })
                })
        })
}

fn result_outcome(event: &Value) -> (&'static str, Option<String>) {
    if let Some(code) = error_code(event) {
        return ("failed", Some(fingerprint(&format!("dsh-error:{code}"))));
    }
    let is_error = event
        .pointer("/data/message/content")
        .and_then(Value::as_array)
        .and_then(|content| {
            content
                .iter()
                .find_map(|part| part.get("isError").and_then(Value::as_bool))
        });
    match is_error {
        Some(true) => ("failed", Some(fingerprint("dsh-error:unknown"))),
        Some(false) => ("succeeded", None),
        None => ("unknown", None),
    }
}

fn turn_number(event: &Value) -> Option<i64> {
    event.pointer("/data/turn").and_then(Value::as_i64)
}

fn turn_outcome(event: &Value) -> &'static str {
    match event.pointer("/data/reason/kind").and_then(Value::as_str) {
        Some("completed") | Some("success") => "succeeded",
        Some("cancelled") | Some("canceled") | Some("aborted") => "cancelled",
        Some("failed") | Some("error") => "failed",
        _ => "unknown",
    }
}

#[allow(clippy::too_many_arguments)]
fn push_event(
    out: &mut Vec<WorkflowEvent>,
    session_id: &str,
    machine_namespace: &str,
    profile: &str,
    ordinal: usize,
    event_type: &str,
    event: &Value,
    capability_kind: Option<&str>,
    capability_id: Option<String>,
    outcome: &str,
    duration_ms: Option<i64>,
    error_fingerprint: Option<String>,
    invocation_fingerprint: Option<String>,
) {
    let Some(event_ts_ms) = event_time(event) else { return };
    let candidate = WorkflowEvent {
        event_id: stable_id(session_id, ordinal, event_type, event),
        session_key: Some(session_key(session_id, machine_namespace, profile)),
        event_ts_ms,
        event_type: event_type.to_string(),
        capability_kind: capability_kind.map(str::to_string),
        capability_id,
        capability_version: None,
        outcome: outcome.to_string(),
        duration_ms,
        error_fingerprint,
        invocation_fingerprint,        // V16 富化字段：本执行环境的结构化错误码接入是下一批；不猜、不填
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
    if candidate.validate().is_ok() {
        out.push(candidate);
    }
}

/// Produce the minimal, privacy-safe workflow event stream for DSH.
///
/// The input arrays are the already reshaped arrays emitted by the DSH source
/// parser, so this function performs no file I/O and no harness discovery.
pub fn from_events(
    execution_events: &[Value],
    usage_events: &[Value],
    native_session_id: &str,
    machine_namespace: &str,
    profile: &str,
) -> Vec<WorkflowEvent> {
    let mut out = Vec::new();
    let mut started_turns: HashMap<i64, i64> = HashMap::new();
    let mut calls: HashMap<String, String> = HashMap::new();

    for (ordinal, event) in execution_events.iter().enumerate() {
        let Some(event_type) = event.get("type").and_then(Value::as_str) else { continue };
        match event_type {
            "turn/start" => {
                let Some(turn) = turn_number(event) else { continue };
                if let Some(time) = event_time(event) {
                    started_turns.insert(turn, time);
                }
                push_event(
                    &mut out,
                    native_session_id,
                    machine_namespace,
                    profile,
                    ordinal,
                    "task_started",
                    event,
                    None,
                    None,
                    "unknown",
                    None,
                    None,
                    None,
                );
            }
            "turn/end" => {
                let duration = turn_number(event)
                    .and_then(|turn| started_turns.get(&turn).copied())
                    .and_then(|start| event_time(event).and_then(|end| end.checked_sub(start)))
                    .filter(|duration| *duration >= 0);
                push_event(
                    &mut out,
                    native_session_id,
                    machine_namespace,
                    profile,
                    ordinal,
                    "task_finished",
                    event,
                    None,
                    None,
                    turn_outcome(event),
                    duration,
                    None,
                    None,
                );
            }
            "tool/call" => {
                let name = capability_id(event);
                if let Some(call_id) = event.pointer("/data/callId").and_then(Value::as_str) {
                    if let Some(name) = name.clone() {
                        calls.insert(call_id.to_string(), name);
                    }
                }
                if event.pointer("/data/name").and_then(Value::as_str) == Some("skill") {
                    let skill = event
                        .pointer("/data/arguments")
                        .and_then(Value::as_str)
                        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                        .and_then(|args| args.get("name").and_then(Value::as_str).map(safe_label));
                    push_event(
                        &mut out,
                        native_session_id,
                        machine_namespace,
                        profile,
                        ordinal,
                        "skill_invoked",
                        event,
                        Some("skill"),
                        skill,
                        "unknown",
                        None,
                        None,
                        Some(fingerprint("dsh-skill-invocation")),
                    );
                } else {
                    push_event(
                        &mut out,
                        native_session_id,
                        machine_namespace,
                        profile,
                        ordinal,
                        "tool_invoked",
                        event,
                        Some("tool"),
                        name.clone(),
                        "unknown",
                        None,
                        None,
                        name.map(|name| fingerprint(&format!("dsh-tool:{name}"))),
                    );
                }
            }
            "tool/result" => {
                let call_id = event.pointer("/data/message/content")
                    .and_then(Value::as_array)
                    .and_then(|content| content.iter().find_map(|part| {
                        part.get("toolCallId").and_then(Value::as_str)
                    }));
                let name = call_id.and_then(|id| calls.get(id).cloned());
                let (outcome, error) = result_outcome(event);
                push_event(
                    &mut out,
                    native_session_id,
                    machine_namespace,
                    profile,
                    ordinal,
                    "tool_finished",
                    event,
                    Some("tool"),
                    name.clone(),
                    outcome,
                    None,
                    error,
                    name.map(|name| fingerprint(&format!("dsh-tool:{name}"))),
                );
            }
            "approval/decided" => {
                let denied = event
                    .pointer("/data/outcome")
                    .and_then(Value::as_str)
                    .map(|value| matches!(value, "rejected" | "denied" | "cancelled"))
                    .unwrap_or(false);
                if denied {
                    push_event(
                        &mut out,
                        native_session_id,
                        machine_namespace,
                        profile,
                        ordinal,
                        "approval_denied",
                        event,
                        Some("tool"),
                        event.pointer("/data/name").and_then(Value::as_str).map(safe_label),
                        "failed",
                        None,
                        Some(fingerprint("dsh-approval-denied")),
                        None,
                    );
                }
            }
            _ => {}
        }
    }

    let mut models = ModelSwitchTracker::default();
    for (ordinal, event) in usage_events.iter().enumerate() {
        if event.get("type").and_then(Value::as_str) != Some("request/header") {
            continue;
        }
        let model = event
            .pointer("/data/header/config/model")
            .and_then(Value::as_str)
            .map(safe_label);
        if let Some(model) = model {
            if models.observe(&model) {
                push_event(
                    &mut out,
                    native_session_id,
                    machine_namespace,
                    profile,
                    ordinal,
                    "model_switched",
                    event,
                    Some("model"),
                    Some(model),
                    "succeeded",
                    None,
                    None,
                    None,
                );
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::from_events;
    use serde_json::json;

    #[test]
    fn maps_execution_events_without_copying_arguments_or_error_text() {
        let execution = vec![
            json!({"type":"turn/start","time":1000,"data":{"turn":1}}),
            json!({"type":"tool/call","time":1100,"data":{"callId":"c1","name":"bash","arguments":"{\"command\":\"cat /Users/private/secret\"}"}}),
            json!({"type":"tool/result","time":1200,"data":{"message":{"content":[{"toolCallId":"c1","isError":true,"text":"private raw failure text"}]}}}),
            json!({"type":"approval/decided","time":1300,"data":{"outcome":"denied","name":"bash"}}),
            json!({"type":"turn/end","time":1400,"data":{"turn":1,"reason":{"kind":"completed"}}}),
        ];
        let usage = vec![
            json!({"type":"request/header","time":1050,"data":{"header":{"config":{"model":"deepseek/v4"}}}}),
            json!({"type":"request/header","time":1250,"data":{"header":{"config":{"model":"deepseek/v5"}}}}),
        ];
        let events = from_events(&execution, &usage, "s1", "ns1", "default");
        assert!(events.iter().any(|event| event.event_type == "tool_invoked"));
        assert!(events.iter().any(|event| event.event_type == "tool_finished"));
        assert!(events.iter().any(|event| event.event_type == "approval_denied"));
        assert!(events.iter().any(|event| event.event_type == "model_switched"));
        assert!(events.iter().any(|event| event.event_type == "task_finished" && event.duration_ms == Some(400)));
        let debug = format!("{events:?}");
        assert!(!debug.contains("/Users/private/secret"));
        assert!(!debug.contains("private raw failure text"));
        assert!(events.iter().all(|event| event.validate().is_ok()));
    }
}
