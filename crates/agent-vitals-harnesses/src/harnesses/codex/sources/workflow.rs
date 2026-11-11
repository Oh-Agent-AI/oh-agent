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

fn event_id(path: &Path, ordinal: usize, event_type: &str) -> String {
    let material = format!("codex|{}|{}|{}", path.to_string_lossy(), ordinal, event_type);
    format!("workflow:codex:{}", fnv1a64_hex(material.as_bytes()))
}

/// 归一化后的事件草稿：流式解析期间只保留这些字段（不保留整行 `Value`）。
/// `session_key` 要等最后一个 session_meta 才能定稿（fork 续接文件里
/// session_meta 可能出现多次，旧实现取「最后一个有效值」），所以先攒草稿，
/// 文件读完再统一构造 `WorkflowEvent`。
struct PendingEvent {
    ordinal: usize,
    event_type: &'static str,
    timestamp: Option<String>,
    kind: Option<&'static str>,
    capability_id: Option<String>,
    outcome: &'static str,
    error: Option<String>,
    invocation: Option<String>,
    duration_ms: Option<i64>,
}

#[allow(clippy::too_many_arguments)]
fn add_event(
    out: &mut Vec<(PendingEvent, bool)>, ordinal: usize, event_type: &'static str,
    timestamp: Option<&str>, kind: Option<&'static str>, capability_id: Option<String>,
    outcome: &'static str, error: Option<String>, invocation: Option<String>,
    duration_ms: Option<i64>, legacy: bool,
) {
    out.push((PendingEvent {
        ordinal,
        event_type,
        timestamp: timestamp.map(str::to_string),
        kind,
        capability_id,
        outcome,
        error,
        invocation,
        duration_ms,
    }, legacy));
}

fn finalize_events(
    pending: Vec<(PendingEvent, bool)>, path: &Path, session_key: &str,
) -> Vec<WorkflowEvent> {
    let mut out = Vec::new();
    for (event, _) in pending {
        let Some(event_ts_ms) = iso_to_epoch_ms(event.timestamp.as_deref()) else { continue };
        let workflow = WorkflowEvent {
            event_id: event_id(path, event.ordinal, event.event_type),
            session_key: Some(session_key.to_string()),
            event_ts_ms,
            event_type: event.event_type.to_string(),
            capability_kind: event.kind.map(str::to_string),
            capability_id: event.capability_id,
            capability_version: None,
            outcome: event.outcome.to_string(),
            duration_ms: event.duration_ms.filter(|value| *value >= 0),
            error_fingerprint: event.error,
            invocation_fingerprint: event.invocation,
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
        if workflow.validate().is_ok() { out.push(workflow); }
    }
    out
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
fn completed_item(
    item: &Value, has_command_execution: &mut bool,
    calls: &mut HashMap<String, (String, String)>,
    out: &mut Vec<(PendingEvent, bool)>, ordinal: usize, timestamp: Option<&str>,
) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    if item_type == "CommandExecution" {
        // 第一次看到 CommandExecution：它是主源，之前按 Legacy 解释的
        // response_item / item_completed 事件全部作废（否则影子记录双计）。
        if !*has_command_execution {
            *has_command_execution = true;
            out.retain(|(_, legacy)| !*legacy);
        }
        let Some(name) = command_name(item) else { return };
        let invocation = Some(invocation_fingerprint(&name, item));
        let item_id = item.get("id").and_then(Value::as_str).unwrap_or("");
        if !item_id.is_empty() {
            calls.insert(item_id.to_string(), (name.clone(), invocation.clone().unwrap_or_default()));
        }
        add_event(out, ordinal, "tool_invoked", timestamp, Some("tool"),
            Some(name.clone()), "unknown", None, invocation.clone(), None, false);
        let exit_code = item.get("exit_code").and_then(Value::as_i64);
        let result = match exit_code { Some(0) => "succeeded", Some(_) => "failed", None => "unknown" };
        let error = exit_code.filter(|code| *code != 0)
            .map(|code| fingerprint(&format!("codex-exit:{code}")));
        let duration = item.get("duration").and_then(Value::as_i64);
        add_event(out, ordinal, "tool_finished", timestamp, Some("tool"),
            Some(name), result, error, invocation, duration, false);
        return;
    }
    if *has_command_execution { return; }
    let Some(name) = item_name(item) else { return };
    let invocation = Some(invocation_fingerprint(&name, item));
    let call_id = item.get("tool_call_id").and_then(Value::as_str).unwrap_or("");
    if !call_id.is_empty() {
        calls.insert(call_id.to_string(), (name.clone(), invocation.clone().unwrap_or_default()));
    }
    if is_skill(&name) {
        add_event(out, ordinal, "skill_invoked", timestamp, Some("skill"),
            Some(name), "unknown", None, invocation, None, true);
    } else {
        add_event(out, ordinal, "tool_invoked", timestamp, Some("tool"),
            Some(name), "unknown", None, invocation, None, true);
    }
}

/// Emit privacy-safe workflow events from one Codex rollout file.
///
/// 2026-11-11：改为逐行流式（旧实现 `fs::read` + `parse_codex_session_log`
/// 把整份 2 GB rollout 变成 `Vec<Value>`，单轮 high-water 16 GB）。内存上限 =
/// 单行上限 + 事件草稿数，不随文件大小增长。
pub fn codex_file_to_workflow_events(
    path: &Path,
    machine_namespace: &str,
    source_profile: &str,
) -> Result<Vec<WorkflowEvent>, String> {
    let is_zst = path.to_string_lossy().ends_with(".jsonl.zst");
    let file = std::fs::File::open(path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    let mut pending: Vec<(PendingEvent, bool)> = Vec::new();
    let mut calls = HashMap::new();
    let mut models = ModelSwitchTracker::default();
    let mut native_session_id: Option<String> = None;
    let mut has_command_execution = false;
    let mut ordinal = 0usize;
    let mut degraded = false;

    let mut on_line = |_offset: u64, raw: &[u8]| -> bool {
        let text = String::from_utf8_lossy(raw);
        if text.trim().is_empty() {
            return true;
        }
        let item: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => {
                degraded = true;
                return false;
            }
        };
        let current = ordinal;
        ordinal += 1;
        if item.get("type").and_then(Value::as_str) == Some("session_meta") {
            // 与 `parse_codex_session_log` 同义：session_id 键存在即用（含 null，
            // 会清空前值），否则退回 id；后一条覆盖前一条。
            if let Some(payload) = item.get("payload").and_then(Value::as_object) {
                native_session_id = payload
                    .get("session_id")
                    .or_else(|| payload.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
        let timestamp = item.get("timestamp").and_then(Value::as_str);
        let top = item.get("type").and_then(Value::as_str).unwrap_or("");
        let inner = item.pointer("/payload/type").and_then(Value::as_str).unwrap_or("");
        let payload = item.get("payload").unwrap_or(&Value::Null);
        if top == "turn_context" {
            if let Some(model) = payload.get("model").and_then(Value::as_str) {
                let model = safe_label(model);
                if models.observe(&model) {
                    add_event(&mut pending, current, "model_switched", timestamp,
                        Some("model"), Some(model), "succeeded", None, None, None, false);
                }
            }
        }
        if top == "event_msg" {
            match inner {
                "task_started" => add_event(&mut pending, current, "task_started",
                    timestamp, None, None, "unknown", None, None, None, false),
                "task_complete" => {
                    let error = (!payload.get("error").is_none() && !payload["error"].is_null())
                        .then(|| fingerprint("codex-task-error"));
                    let result = if error.is_some() { "failed" } else { "succeeded" };
                    add_event(&mut pending, current, "task_finished", timestamp,
                        None, None, result, error, None, None, false);
                }
                "item_completed" => {
                    if let Some(item) = payload.get("item") {
                        completed_item(item, &mut has_command_execution, &mut calls,
                            &mut pending, current, timestamp);
                    }
                }
                _ => {}
            }
        }
        if top == "response_item" && !has_command_execution {
            match inner {
                "custom_tool_call" | "function_call" | "tool_search_call" => {
                    completed_item(payload, &mut has_command_execution, &mut calls,
                        &mut pending, current, timestamp);
                }
                "custom_tool_call_output" | "function_call_output" | "tool_search_output" => {
                    let call_id = payload.get("call_id").and_then(Value::as_str).unwrap_or("");
                    let Some((name, invocation)) = calls.get(call_id).cloned() else { return true };
                    let invocation = Some(invocation);
                    add_event(&mut pending, current, "tool_finished", timestamp,
                        Some("tool"), Some(name), "unknown", None, invocation, None, true);
                }
                _ => {}
            }
        }
        true
    };

    let stats = if is_zst {
        super::jsonl::MultiFrameZstdReader::new(file)
            .and_then(|reader| {
                super::jsonl::for_each_line(
                    reader,
                    super::jsonl::DEFAULT_MAX_LINE_BYTES,
                    &mut on_line,
                )
            })
    } else {
        super::jsonl::for_each_line(
            std::io::BufReader::with_capacity(256 * 1024, file),
            super::jsonl::DEFAULT_MAX_LINE_BYTES,
            &mut on_line,
        )
    }
    .map_err(|error| format!("read {}: {error}", path.display()))?;

    if degraded || stats.oversized > 0 {
        return Ok(Vec::new());
    }
    let native_session_id = native_session_id
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| path.file_stem().and_then(|value| value.to_str()).unwrap_or("").to_string());
    let session_key = SessionKey::new("codex", &native_session_id, source_profile, machine_namespace).ledger_key();
    Ok(finalize_events(pending, path, &session_key))
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
    /// Paginated 主源晚于 Legacy 影子记录出现时，先前按 Legacy 解释的事件必须
    /// 整体作废——否则同一逻辑调用会被 `function_call` 与 `CommandExecution`
    /// 双计。流式实现靠「看到 CommandExecution 即 retain 掉 legacy」保持这一
    /// 语义（旧实现靠全量预扫）。
    #[test]
    fn late_command_execution_purges_earlier_legacy_shadow_events() {
        let path = std::env::temp_dir()
            .join(format!("av-codex-late-cmd-{}.jsonl", std::process::id()));
        let text = concat!(
            r#"{"type":"session_meta","timestamp":"2026-07-25T11:19:35.404Z","payload":{"session_id":"s1"}}"#, "\n",
            r#"{"type":"response_item","timestamp":"2026-07-25T11:20:00.000Z","payload":{"type":"function_call","name":"exec","call_id":"c1","arguments":"{}"}}"#, "\n",
            r#"{"type":"event_msg","timestamp":"2026-07-25T11:20:02.000Z","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"x","command":["bash","-c","ls"],"exit_code":0}}}"#, "\n",
        );
        std::fs::write(&path, text).unwrap();
        let events = codex_file_to_workflow_events(&path, "machine", "default").unwrap();
        assert!(events.iter().any(|event| event.event_type == "tool_invoked"));
        assert!(events.iter().all(|event| event.capability_id.as_deref() != Some("exec")),
            "legacy shadow event must not survive: {events:?}");
        std::fs::remove_file(path).ok();
    }

}
