//! Claude Code JSONL → harness-neutral WorkflowEvent + SessionExcerpt.
//!
//! Claude's log contains tool arguments, paths, prompts, and tool-result
//! bodies.  Under the 2026-09-19 retention & serving-face policy this adapter
//! keeps bounded, scrubbed derivations of exactly those: error/argument
//! excerpts and task-intent excerpts go through
//! `domain::enrichment::make_excerpt`（scrub 先于截断），sizes are byte
//! counts, anchors carry line/offset + native id（路径永不落库）.  What is
//! still NOT inferred: error codes——claude 只给 `is_error` 布尔，从文本猜码
//! 是编造，`error_code/error_class` 保持 `None` 直到有结构化来源（codex/
//! MCP 层接入时填）。Unbounded raw text still never crosses.

use std::collections::HashMap;
use std::path::Path;

use agent_vitals_domain::contracts::session_key::SessionKey;
use agent_vitals_domain::contracts::workflow::{SessionExcerpt, SessionTitle};
use agent_vitals_domain::session_semantics::{
    fingerprint, invocation_fingerprint, iso_to_epoch_ms, safe_label, ModelSwitchTracker, TurnTracker, TurnTransition,
};
use agent_vitals_domain::source_identity::fnv1a64_hex;
use agent_vitals_domain::workflow::WorkflowEvent;
use agent_vitals_domain::{enrichment::{ExcerptRole, make_excerpt}};
use serde_json::Value;

use crate::harnesses::claude_code::sessions::turns::{turn_signal, user_prompt_text};

/// tool_use id → 调用种类 + 调用指纹。指纹在 tool_use 处按参数算好，随 id 带到
/// tool_result——结果块里没有参数，不在这里记就配不上。
#[derive(Clone)]
enum CallKind { Tool(String, String), Skill(String) }

/// 一个事件的 V16 富化载荷。claude 源没有结构化错误码——`error_code/class`
/// 恒 `None`（见模块 doc 的「不从文本猜码」），摘录与尺寸按 policy 保留。
#[derive(Default)]
struct Enrichment {
    error_code: Option<String>,
    error_class: Option<String>,
    error_excerpt: Option<String>,
    args_excerpt: Option<String>,
    request_bytes: Option<i64>,
    result_bytes: Option<i64>,
}

fn event_id(path: &Path, offset: usize, ordinal: usize, event_type: &str) -> String {
    let material = format!("claude|{}|{}|{}|{}", path.to_string_lossy(), offset, ordinal, event_type);
    format!("workflow:claude:{}", fnv1a64_hex(material.as_bytes()))
}

#[allow(clippy::too_many_arguments)]
fn add_event(
    out: &mut Vec<WorkflowEvent>, path: &Path, offset: usize, anchor_offset: i64, line: i64,
    ordinal: usize, session_key: &str, event_type: &str, time: Option<i64>, kind: Option<&str>,
    id: Option<String>, result: &str, error: Option<String>, invocation: Option<String>,
    native: Option<&str>, enrich: Enrichment,
) {
    let Some(event_ts_ms) = time else { return };
    let event = WorkflowEvent {
        event_id: event_id(path, offset, ordinal, event_type),
        session_key: Some(session_key.to_string()),
        event_ts_ms,
        event_type: event_type.to_string(),
        capability_kind: kind.map(str::to_string),
        capability_id: id,
        capability_version: None,
        outcome: result.to_string(),
        duration_ms: None,
        error_fingerprint: error,
        invocation_fingerprint: invocation,
        error_code: enrich.error_code,
        error_class: enrich.error_class,
        error_excerpt: enrich.error_excerpt,
        args_excerpt: enrich.args_excerpt,
        request_bytes: enrich.request_bytes,
        result_bytes: enrich.result_bytes,
        native_event_id: native.map(str::to_string),
        source_line: Some(line),
        source_byte_offset: Some(anchor_offset),
    };
    if event.validate().is_ok() { out.push(event); }
}

/// assistant 消息的可读文本（content 字符串或 text 块拼接）——`assistant_final`
/// 摘录的取材。tool_use 块被跳过（那是调用，不是回复文本）。
fn assistant_text(content: Option<&Value>) -> Option<String> {
    match content {
        Some(Value::String(value)) => (!value.trim().is_empty()).then(|| value.clone()),
        Some(Value::Array(values)) => {
            let mut text = String::new();
            for value in values {
                if value.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(part) = value.get("text").and_then(Value::as_str) {
                        if !part.trim().is_empty() { text.push_str(part); }
                    }
                }
            }
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

/// tool_result 的 content 文本（字符串，或 blocks 的 text 拼接）——错误首行
/// 摘录的取材。
fn tool_result_text(block: &Value) -> Option<String> {
    match block.get("content") {
        Some(Value::String(value)) => (!value.trim().is_empty()).then(|| value.clone()),
        Some(Value::Array(values)) => {
            let mut text = String::new();
            for value in values {
                if value.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(part) = value.get("text").and_then(Value::as_str) {
                        text.push_str(part);
                    }
                }
            }
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn serialized_len(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(|value| serde_json::to_string(value).ok())
        .map(|text| text.len() as i64)
}

fn skill_name(input: Option<&Value>) -> String {
    input
        .and_then(Value::as_object)
        .and_then(|object| object.get("skill").or_else(|| object.get("name")))
        .and_then(Value::as_str)
        .map(safe_label)
        .unwrap_or_else(|| "<unknown-skill>".to_string())
}

/// 一条记录：行首字节偏移（锚点 + event_id 稳定性的既有基座）、行号（1 基，
/// V16 加速 hint）、解析后的 JSON。
struct Record { offset: usize, line: i64, value: Value }

fn read_records(path: &Path) -> Result<Vec<Record>, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut line = 1i64;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' { continue; }
        let mut content = &bytes[start..index];
        if content.last() == Some(&b'\r') { content = &content[..content.len() - 1]; }
        if !content.is_empty() {
            let value = serde_json::from_slice::<Value>(content)
                .map_err(|error| format!("non-json line in {}: {error}", path.display()))?;
            out.push(Record { offset: start, line, value });
        }
        start = index + 1;
        line += 1;
    }
    // A non-newline-terminated tail is potentially an in-flight writer.  The
    // usage emitter has the same rule, so do not manufacture workflow events.
    Ok(out)
}

fn record_uuid(record: &Value) -> Option<&str> {
    record.get("uuid").and_then(Value::as_str)
}

fn push_excerpt(
    out: &mut Vec<SessionExcerpt>, session_key: &str, ordinal: &mut i64, role: ExcerptRole,
    text: &str, native: &str,
) {
    if let Some(excerpt) = make_excerpt(text, role) {
        let candidate = SessionExcerpt {
            session_key: session_key.to_string(),
            ordinal: *ordinal,
            role: role.as_str().to_string(),
            excerpt: excerpt.text,
            provenance: excerpt.provenance.as_str().to_string(),
            native_event_id: native.to_string(),
        };
        if candidate.validate().is_ok() {
            out.push(candidate);
            *ordinal += 1;
        }
    }
}

/// `claude_file_to_workflow_events` 的产出三元组（事件 / 摘录 / 会话标题）。
pub type ClaudeWorkflowEmit = (Vec<WorkflowEvent>, Vec<SessionExcerpt>, Vec<SessionTitle>);

/// Emit privacy-safe workflow events and task-intent excerpts from one Claude
/// session file.  摘录与富化字段的算法真相源是 `domain::enrichment`；本函数
/// 只做取材（哪个块是用户首条/后续 prompt、末条 assistant 回复、Task 子代理
/// 派活）与锚点（uuid + 行号 + 字节偏移）。
pub fn claude_file_to_workflow_events(
    path: &Path,
    machine_namespace: &str,
    source_profile: &str,
    native_session_id: &str,
) -> Result<ClaudeWorkflowEmit, String> {
    let records = read_records(path)?;
    let session_key = SessionKey::new("claude-code", native_session_id, source_profile, machine_namespace).ledger_key();
    let mut out = Vec::new();
    let mut excerpts = Vec::new();
    let mut calls: HashMap<String, CallKind> = HashMap::new();
    let mut models = ModelSwitchTracker::default();
    let mut task_started: Option<(usize, i64)> = None;
    // 回合语义（开回合、中断至多一次）在 domain；这里只喂 wire 翻译出的信号。
    let mut turns = TurnTracker::default();
    let mut user_prompt_seen = false;
    let mut last_assistant: Option<(String, String)> = None; // (uuid, 文本)
    // 摘录序号 = 会话内生产顺序（每 push 一次 +1）。不用记录位置序：同一记录里
    // 多个 Task tool_use（并行子代理）会同 PK 碰撞；生产序天然唯一且单调。
    let mut excerpt_ordinal: i64 = 0;

    for record in records.iter() {
        let Record { offset, line, value } = record;
        let time = value.get("timestamp").and_then(Value::as_str).and_then(|v| iso_to_epoch_ms(Some(v)));
        let sidechain = value.get("isSidechain").and_then(Value::as_bool).unwrap_or(false);
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "user" => {
                let message = value.get("message");
                let content = message.and_then(|value| value.get("content"));
                // 回合（G6）：判据是 `sessions::turns::turn_signal`（与 evidence 共用
                // 一份）。首回合沿用历史判据，event_id 不变。
                match turns.observe(turn_signal(value, task_started.is_some())) {
                    TurnTransition::Opened { .. } => {
                        if task_started.is_none() {
                            task_started = time.map(|v| (*offset, v));
                        }
                        add_event(&mut out, path, *offset, *offset as i64, *line, 0, &session_key, "task_started", time,
                            None, None, "unknown", None, None, record_uuid(value), Enrichment::default());
                    }
                    // ordinal 1：与同 offset 的其他事件（task_started 用 0、工具结果
                    // 用块序 + 1——中断记录不带 tool_result 块）互不碰撞。
                    TurnTransition::Cancelled => add_event(&mut out, path, *offset, *offset as i64, *line, 1, &session_key,
                        "task_finished", time, None, None, "cancelled", None, None, record_uuid(value), Enrichment::default()),
                    TurnTransition::None => {}
                }
                // 任务意图摘录：首条纯文本用户消息 = user_first，其后 = user_turn。
                // isSidechain 守卫：sidechain 是子代理自己的会话流，混进主会话
                // 摘录就是污染（且首见语义不可逆）——evidence.rs 的 turn 判据
                // 同款守卫。
                if !sidechain {
                    if let Some(text) = user_prompt_text(content) {
                        let role = if user_prompt_seen { ExcerptRole::UserTurn } else { ExcerptRole::UserFirst };
                        user_prompt_seen = true;
                        if let Some(uuid) = record_uuid(value) {
                            push_excerpt(&mut excerpts, &session_key, &mut excerpt_ordinal, role, &text, uuid);
                        }
                    }
                }
                if let Some(Value::Array(blocks)) = content {
                    // `toolUseResult` 是 record 级结构化结果：只有这条 user 记录
                    // 恰好带一个 tool_result 时，它才无歧义地属于该调用（真机
                    // 16/16 如此；并行工具调用时退回块级信号）。
                    let single_tool_result = blocks.iter()
                        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
                        .count() == 1;
                    for (block_index, block) in blocks.iter().enumerate() {
                        if block.get("type").and_then(Value::as_str) != Some("tool_result") { continue; }
                        let call_id = block.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                        let Some(kind) = calls.get(call_id).cloned() else { continue };
                        let failed = block.get("is_error").and_then(Value::as_bool);
                        let mut result = match failed { Some(true) => "failed", Some(false) => "succeeded", None => "unknown" };
                        // Skill 的 tool_result **不写 is_error**（bash 恒带，skill
                        // 实测恒无——2026-09-20 真机 16/16）。Skill 的成败信号在
                        // record 级 `toolUseResult.success`；两个信号都缺席时保持
                        // unknown —— 「没看到失败」不折算成成功。
                        if matches!(kind, CallKind::Skill(_)) && single_tool_result {
                            if let Some(success) = value.get("toolUseResult")
                                .and_then(|t| t.get("success")).and_then(Value::as_bool) {
                                result = if success { "succeeded" } else { "failed" };
                            }
                        }
                        let error = (result == "failed").then(|| fingerprint("claude-tool-error"));
                        // V16：错误首行摘录（失败才有；scrub 先于截断）+ 结果尺寸。
                        // 错误码不猜——claude 只给了 is_error 布尔（摘录条件用
                        // 合成后的 result，覆盖 toolUseResult.success=false 的失败）。
                        let mut enrich = Enrichment {
                            result_bytes: serialized_len(block.get("content")),
                            ..Enrichment::default()
                        };
                        if result == "failed" {
                            if let Some(text) = tool_result_text(block) {
                                if let Some(excerpt) = make_excerpt(&text, ExcerptRole::UserTurn) {
                                    enrich.error_excerpt = Some(excerpt.text);
                                }
                            }
                        }
                        match kind {
                            CallKind::Tool(name, invocation) => add_event(&mut out, path, *offset, *offset as i64, *line, block_index + 1,
                                &session_key, "tool_finished", time, Some("tool"), Some(name),
                                result, error, Some(invocation),
                                Some(call_id), enrich),
                            CallKind::Skill(name) => add_event(&mut out, path, *offset, *offset as i64, *line, block_index + 1,
                                &session_key, "skill_finished", time, Some("skill"), Some(name),
                                result, error, Some(fingerprint("claude-skill-invocation")),
                                Some(call_id), enrich),
                        }
                    }
                }
            }
            "assistant" => {
                let message = value.get("message");
                if let Some(model) = message.and_then(|value| value.get("model")).and_then(Value::as_str) {
                    let model = safe_label(model);
                    if models.observe(&model) {
                        add_event(&mut out, path, *offset, *offset as i64, *line, 0, &session_key, "model_switched", time,
                            Some("model"), Some(model), "succeeded", None, None,
                            record_uuid(value), Enrichment::default());
                    }
                }
                if !sidechain {
                    if let Some(text) = message
                        .and_then(|value| value.get("content"))
                        .and_then(|content| assistant_text(Some(content)))
                    {
                        if let Some(uuid) = record_uuid(value) {
                            last_assistant = Some((uuid.to_string(), text));
                        }
                    }
                }
                if let Some(Value::Array(blocks)) = message.and_then(|value| value.get("content")) {
                    for (block_index, block) in blocks.iter().enumerate() {
                        if block.get("type").and_then(Value::as_str) != Some("tool_use") { continue; }
                        let raw_name = block.get("name").and_then(Value::as_str).unwrap_or("");
                        let call_id = block.get("id").and_then(Value::as_str).unwrap_or("");
                        // V16：参数摘要摘录 + 请求尺寸；Task 工具的 prompt 另产
                        // subagent_task 摘录（派活的原文）。
                        let input = block.get("input");
                        let mut enrich = Enrichment {
                            request_bytes: serialized_len(input),
                            ..Enrichment::default()
                        };
                        if let Some(text) = input
                            .and_then(Value::as_object)
                            .and_then(|object| object.get("prompt"))
                            .and_then(Value::as_str)
                        {
                            if raw_name.eq_ignore_ascii_case("task") && !sidechain {
                                if let Some(uuid) = record_uuid(value) {
                                    push_excerpt(&mut excerpts, &session_key, &mut excerpt_ordinal,
                                        ExcerptRole::SubagentTask, text, uuid);
                                }
                            }
                        }
                        if let Some(text) = input.and_then(|input| serde_json::to_string(input).ok()) {
                            if let Some(excerpt) = make_excerpt(&text, ExcerptRole::UserTurn) {
                                enrich.args_excerpt = Some(excerpt.text);
                            }
                        }
                        if raw_name.eq_ignore_ascii_case("skill") {
                            let name = skill_name(input);
                            calls.insert(call_id.to_string(), CallKind::Skill(name.clone()));
                            add_event(&mut out, path, *offset, *offset as i64, *line, block_index + 1, &session_key,
                                "skill_invoked", time, Some("skill"), Some(name), "unknown", None,
                                Some(fingerprint("claude-skill-invocation")), Some(call_id), enrich);
                        } else {
                            let name = safe_label(raw_name);
                            let invocation = invocation_fingerprint("claude", &name, input);
                            calls.insert(call_id.to_string(), CallKind::Tool(name.clone(), invocation.clone()));
                            add_event(&mut out, path, *offset, *offset as i64, *line, block_index + 1, &session_key,
                                "tool_invoked", time, Some("tool"), Some(name), "unknown", None,
                                Some(invocation), Some(call_id), enrich);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if let Some((offset, _)) = task_started {
        let last = records.last();
        let last_time = last
            .and_then(|record| record.value.get("timestamp"))
            .and_then(Value::as_str)
            .and_then(|value| iso_to_epoch_ms(Some(value)));
        // event_id 仍锚 task_started 的 offset + usize::MAX（重放稳定性）；锚点
        // 三元组（line/offset/uuid）一致指向末条记录——event_id 基与锚点基
        // 是两回事，混用会让 (line, offset) 指向不同记录（验收 finding）。
        let anchor = last
            .map(|record| (record.line, record.offset as i64))
            .unwrap_or((0, offset as i64));
        add_event(&mut out, path, offset, anchor.1, anchor.0, usize::MAX, &session_key,
            "task_finished", last_time, None, None, "unknown", None, None,
            last.and_then(|record| record_uuid(&record.value)), Enrichment::default());
    }
    // assistant_final：末条含文本的 assistant 回复（"改完了，测试通过" = 任务
    // 结果确认维度）。
    if let Some((uuid, text)) = last_assistant {
        push_excerpt(&mut excerpts, &session_key, &mut excerpt_ordinal, ExcerptRole::AssistantFinal, &text, &uuid);
    }
    // 会话标题（V32）：取最后一条有效 ai-title 记录（`sources::title_of` 同款取材：
    // `aiTitle` 优先、`title` 兜底——那条函数收 owned 切片，这里的 records 是
    // 借用，取材逻辑就地重写、语义逐字段一致），`bound_session_title` 脱敏 +
    // 截断。整形后为空 → 不产行（同摘录纪律）。
    let raw_title = records
        .iter()
        .rev()
        .filter(|r| r.value.get("type").and_then(Value::as_str) == Some("ai-title"))
        .find_map(|r| {
            r.value.get("aiTitle").and_then(Value::as_str)
                .and_then(agent_vitals_domain::enrichment::bound_session_title)
                .or_else(|| r.value.get("title").and_then(Value::as_str)
                    .and_then(agent_vitals_domain::enrichment::bound_session_title))
        });
    let session_titles = raw_title
        .map(|title| vec![SessionTitle {
            native_session_id: native_session_id.to_string(),
            title,
            source: "claude_ai_title".to_string(),
        }])
        .unwrap_or_default();
    Ok((out, excerpts, session_titles))
}

#[cfg(test)]
mod tests {
    use super::claude_file_to_workflow_events;
    use std::path::PathBuf;

    /// V32 会话标题：最后一条有效 ai-title 记录（`aiTitle` 优先、`title` 兜底）整形
    /// 后随解析产出；后续有效条目覆盖旧标题，与 Claude 会话当前标题一致；
    /// 无 ai-title → 空集（City 走 fallback 命名，不编造）。
    #[test]
    fn ai_title_records_yield_bounded_session_title() {
        let path = std::env::temp_dir().join(format!("av-claude-aititle-{}.jsonl", std::process::id()));
        std::fs::write(&path, concat!(
            r#"{"type":"user","timestamp":"2026-10-01T10:00:00.000Z","uuid":"u1","message":{"content":"帮我修登录页"}}"#, "\n",
            // 最后一条有效 ai-title：更新后的会话标题应胜过旧标题。
            r#"{"type":"ai-title","aiTitle":"修复登录页跳转","title":"不该用我"}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"后来更新的标题，不该赢"}"#, "\n",
            // 最新记录为空时，不让它抹掉最近一条有效标题。
            r#"{"type":"ai-title","aiTitle":"   ","title":""}"#, "\n",
        )).unwrap();
        let (_events, _excerpts, titles) = claude_file_to_workflow_events(&PathBuf::from(&path), "machine", "default", "session-1").unwrap();
        assert_eq!(titles.len(), 1);
        assert_eq!(titles[0].native_session_id, "session-1");
        assert_eq!(titles[0].title, "后来更新的标题，不该赢");
        assert_eq!(titles[0].source, "claude_ai_title");
        assert!(titles[0].validate().is_ok());
        std::fs::remove_file(path).ok();

        // aiTitle 缺席 → title 兜底。
        let path2 = std::env::temp_dir().join(format!("av-claude-aititle2-{}.jsonl", std::process::id()));
        std::fs::write(&path2, concat!(
            r#"{"type":"user","timestamp":"2026-10-01T10:00:00.000Z","uuid":"u1","message":{"content":"hi"}}"#, "\n",
            r#"{"type":"ai-title","title":"兜底标题"}"#, "\n",
        )).unwrap();
        let (_, _, titles2) = claude_file_to_workflow_events(&PathBuf::from(&path2), "machine", "default", "session-2").unwrap();
        assert_eq!(titles2[0].title, "兜底标题");
        std::fs::remove_file(path2).ok();

        // 无 ai-title 记录 → 空集。
        let path3 = std::env::temp_dir().join(format!("av-claude-aititle3-{}.jsonl", std::process::id()));
        std::fs::write(&path3, concat!(
            r#"{"type":"user","timestamp":"2026-10-01T10:00:00.000Z","uuid":"u1","message":{"content":"hi"}}"#, "\n",
        )).unwrap();
        let (_, _, titles3) = claude_file_to_workflow_events(&PathBuf::from(&path3), "machine", "default", "session-3").unwrap();
        assert!(titles3.is_empty());
        std::fs::remove_file(path3).ok();
    }

    /// Skill 的 tool_result 不带 is_error（真机 16/16）；成败信号在 record 级
    /// `toolUseResult.success`（WORKBENCH_FINDINGS_TAB_SPEC §9.4-① 修复）。
    /// 钉住三态：true → succeeded、false → failed（带错误指纹）、都缺席 →
    /// unknown（「没看到失败」不得折算成成功）。工具路径不受影响。
    #[test]
    fn skill_outcome_reads_tool_use_result_success() {
        let path = std::env::temp_dir().join(format!("av-claude-skill-{}.jsonl", std::process::id()));
        std::fs::write(&path, concat!(
            // skill 加载成功：无 is_error，toolUseResult.success=true
            r#"{"type":"assistant","timestamp":"2026-08-20T14:27:05.000Z","message":{"content":[{"type":"tool_use","id":"s1","name":"Skill","input":{"skill":"code-review"}}]}}"#, "\n",
            r#"{"type":"user","timestamp":"2026-08-20T14:27:08.000Z","toolUseResult":{"commandName":"code-review","success":true},"message":{"content":[{"type":"tool_result","tool_use_id":"s1","content":"loaded"}]}}"#, "\n",
            // skill 失败：无 is_error，toolUseResult.success=false
            r#"{"type":"assistant","timestamp":"2026-08-20T14:28:00.000Z","message":{"content":[{"type":"tool_use","id":"s2","name":"Skill","input":{"skill":"nope"}}]}}"#, "\n",
            r#"{"type":"user","timestamp":"2026-08-20T14:28:02.000Z","toolUseResult":{"commandName":"nope","success":false},"message":{"content":[{"type":"tool_result","tool_use_id":"s2","content":"not found"}]}}"#, "\n",
            // 两个信号都缺席 → unknown
            r#"{"type":"assistant","timestamp":"2026-08-20T14:29:00.000Z","message":{"content":[{"type":"tool_use","id":"s3","name":"Skill","input":{"skill":"third"}}]}}"#, "\n",
            r#"{"type":"user","timestamp":"2026-08-20T14:29:02.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"s3","content":"loaded"}]}}"#, "\n",
            // 工具路径不变：is_error=false → succeeded
            r#"{"type":"assistant","timestamp":"2026-08-20T14:30:00.000Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#, "\n",
            r#"{"type":"user","timestamp":"2026-08-20T14:30:02.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"ok"}]}}"#, "\n",
        )).unwrap();
        let (events, _excerpts, _titles) = claude_file_to_workflow_events(&PathBuf::from(&path), "machine", "default", "s1").unwrap();
        let finished = |skill: &str| events.iter().find(|event|
            event.event_type == "skill_finished" && event.capability_id.as_deref() == Some(skill)).cloned();
        assert_eq!(finished("code-review").map(|e| e.outcome).as_deref(), Some("succeeded"));
        let failed = finished("nope").expect("failed skill event");
        assert_eq!(failed.outcome, "failed");
        assert!(failed.error_fingerprint.is_some(), "success=false 的失败要带错误指纹");
        assert_eq!(finished("third").map(|e| e.outcome).as_deref(), Some("unknown"),
            "两个信号都缺席时保持 unknown");
        // safe_label 保留原大小写（"Bash" 合法且 ≤128 → 原样返回）。
        assert!(events.iter().any(|event| event.event_type == "tool_finished"
            && event.capability_id.as_deref().is_some_and(|name| name.eq_ignore_ascii_case("bash"))
            && event.outcome == "succeeded"),
            "工具路径的 is_error 语义不变");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn emits_safe_claude_workflow_events_without_raw_payloads() {
        // v2（2026-09-19 政策）：防线从「错误/参数文本绝不出现」移到三条更精确的：
        // ① 无界原文（完整序列化参数/错误体）绝不跨边界；② 摘录必须有界
        // （≤120 码点）且经 scrub（v16 测试另钉凭据）；③ excerpt 类字段只进
        // 本地库/呈现，MCP 与 redacted 导出面不携带（由那两侧的投影测试钉）。
        let path = std::env::temp_dir().join(format!("av-claude-workflow-{}.jsonl", std::process::id()));
        std::fs::write(&path, concat!(
            r#"{"type":"user","timestamp":"2026-08-20T14:27:00.000Z","uuid":"u1","message":{"content":"do it"}}"#, "\n",
            r#"{"type":"assistant","timestamp":"2026-08-20T14:27:05.000Z","uuid":"a1","message":{"model":"claude-sonnet","content":[{"type":"tool_use","id":"c1","name":"Bash","input":{"command":"cat /Users/private/secret"}}]}}"#, "\n",
            r#"{"type":"user","timestamp":"2026-08-20T14:27:08.000Z","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"c1","is_error":true,"content":"private error"}]}}"#, "\n",
        )).unwrap();
        let (events, excerpts, _titles) = claude_file_to_workflow_events(&PathBuf::from(&path), "machine", "default", "s1").unwrap();
        assert!(events.iter().any(|event| event.event_type == "tool_invoked"));
        assert!(events.iter().any(|event| event.event_type == "tool_finished" && event.outcome == "failed"));
        assert!(events.iter().all(|event| event.validate().is_ok()));
        // ① 有界残留在、且只在摘录字段里：本 fixture 的参数整体只有 39 码点，
        // args_excerpt 就是完整序列化参数（这是政策允许的有界残留，不是泄漏）；
        // 错误体同理以 error_excerpt 全量出现。防线在「字段有界」+「出口投影」，
        // 不在「文本绝不出现」。
        let invoked = events.iter().find(|e| e.event_type == "tool_invoked").unwrap();
        assert_eq!(
            invoked.args_excerpt.as_deref(),
            Some(r#"{"command":"cat /Users/private/secret"}"#),
            "有界参数摘要按原样保留（≤120 码点）"
        );
        let finished = events.iter().find(|e| e.event_type == "tool_finished").unwrap();
        assert_eq!(finished.error_excerpt.as_deref(), Some("private error"));
        // ② 摘录有界：全部 ≤120 码点（UserTurn 档）——上面对原文的出现做了
        // 正面认定，本条就是防它变成无界通道的钉子。
        for event in &events {
            for excerpt in [&event.error_excerpt, &event.args_excerpt].into_iter().flatten() {
                assert!(excerpt.chars().count() <= 120, "摘录超界：{excerpt:?}");
            }
        }
        // ③ 非摘录字段仍是单向脱敏：capability_id 只有工具名。
        assert!(events.iter().all(|event| event.capability_id.as_deref() != Some("cat /Users/private/secret")));
        // 摘录面：首条用户消息 "do it" 是纯文本 → user_first 存在且有界
        // （复用 excerpts 变量，别让测试声明的防线只覆盖事件面）。
        let first = excerpts.iter().find(|e| e.role == "user_first").expect("user_first");
        assert_eq!(first.excerpt, "do it");
        assert!(excerpts.iter().all(|e| e.excerpt.chars().count() <= 200));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn v16_enrichment_fills_anchors_sizes_and_scrubbed_excerpts() {
        // 富化三件套：锚点（uuid/行号/偏移）、尺寸、scrub 后摘录。凭据必须被
        // scrub（[…] 标记），错误码必须留 NULL（claude 只有布尔，不猜码）。
        let path = std::env::temp_dir().join(format!("av-claude-enrich-{}.jsonl", std::process::id()));
        std::fs::write(&path, concat!(
            r#"{"type":"user","timestamp":"2026-09-19T10:00:00.000Z","uuid":"u1","message":{"content":"帮我修登录页，凭据是 sk-abcdefghij0123456789 别提交"}}"#, "\n",
            r#"{"type":"user","timestamp":"2026-09-19T10:00:30.000Z","uuid":"u2","message":{"content":"再检查一下迁移脚本"}}"#, "\n",
            r#"{"type":"assistant","timestamp":"2026-09-19T10:01:00.000Z","uuid":"a1","message":{"model":"claude-sonnet","content":[{"type":"tool_use","id":"c1","name":"Bash","input":{"command":"pytest tests/ -x"}}]}}"#, "\n",
            r#"{"type":"user","timestamp":"2026-09-19T10:01:05.000Z","uuid":"u3","message":{"content":[{"type":"tool_result","tool_use_id":"c1","is_error":true,"content":"Error: 3 failed, harness=prod db=sk-zyxwvutsrqponmlkjihg"}]}}"#, "\n",
            r#"{"type":"assistant","timestamp":"2026-09-19T10:02:00.000Z","uuid":"a2","message":{"model":"claude-sonnet","content":[{"type":"text","text":"改完了，测试通过"}]}}"#, "\n",
        )).unwrap();
        let (events, excerpts, _titles) = claude_file_to_workflow_events(&PathBuf::from(&path), "machine", "default", "s1").unwrap();

        // 锚点与尺寸：
        let invoked = events.iter().find(|e| e.event_type == "tool_invoked").unwrap();
        assert_eq!(invoked.native_event_id.as_deref(), Some("c1"));
        assert_eq!(invoked.source_line, Some(3));
        assert!(invoked.source_byte_offset.unwrap() > 0);
        assert!(invoked.request_bytes.unwrap() > 0);
        assert!(invoked.args_excerpt.as_deref().is_some_and(|t| t.contains("pytest")));
        let finished = events.iter().find(|e| e.event_type == "tool_finished").unwrap();
        assert_eq!(finished.native_event_id.as_deref(), Some("c1"));
        assert!(finished.result_bytes.unwrap() > 0);
        // 错误摘录：含错误首行语义、凭据被 scrub、闭集校验过：
        let error_excerpt = finished.error_excerpt.as_deref().expect("失败必须有错误摘录");
        assert!(error_excerpt.contains("3 failed"));
        assert!(!error_excerpt.contains("sk-zyxwvutsrqponmlkjihg"), "凭据必须被 scrub");
        // 错误码不猜：claude 只有 is_error 布尔。
        assert!(finished.error_code.is_none());
        assert!(finished.error_class.is_none());

        // 摘录三段式 + scrub：
        let first = excerpts.iter().find(|e| e.role == "user_first").expect("user_first");
        assert!(first.excerpt.contains("帮我修登录页"));
        assert!(first.excerpt.contains("[…]"), "首条用户消息里的凭据必须被 scrub");
        assert!(!first.excerpt.contains("sk-abcdefghij0123456789"));
        assert_eq!(first.provenance, "scrubbed");
        assert_eq!(first.native_event_id, "u1");
        let turn = excerpts.iter().find(|e| e.role == "user_turn").expect("user_turn");
        assert!(turn.excerpt.contains("迁移脚本"));
        let final_reply = excerpts.iter().find(|e| e.role == "assistant_final").expect("assistant_final");
        assert!(final_reply.excerpt.contains("测试通过"));
        assert_eq!(final_reply.native_event_id, "a2");
        assert!(excerpts.iter().all(|e| e.validate().is_ok()));

        std::fs::remove_file(path).ok();
    }

    #[test]
    fn sidechain_records_do_not_pollute_session_excerpts() {
        // 验收 finding（MEDIUM-HIGH）：sidechain 是子代理自己的会话流，混进主
        // 会话摘录就是污染，且首见语义不可逆——本测试钉住 isSidechain 守卫。
        let path = std::env::temp_dir().join(format!("av-claude-sidechain-{}.jsonl", std::process::id()));
        std::fs::write(&path, concat!(
            r#"{"type":"user","timestamp":"2026-09-19T12:00:00.000Z","uuid":"u1","message":{"content":"主会话的任务"}}"#, "
",
            r#"{"type":"user","timestamp":"2026-09-19T12:00:01.000Z","uuid":"sc1","isSidechain":true,"message":{"content":"子代理自己收到的 prompt"}}"#, "
",
            r#"{"type":"assistant","timestamp":"2026-09-19T12:00:02.000Z","uuid":"sc2","isSidechain":true,"message":{"content":[{"type":"text","text":"子代理的回复"}]}}"#, "
",
            r#"{"type":"assistant","timestamp":"2026-09-19T12:00:03.000Z","uuid":"a2","message":{"content":[{"type":"text","text":"主会话的确认"}]}}"#, "
",
        )).unwrap();
        let (_events, excerpts, _titles) = claude_file_to_workflow_events(&PathBuf::from(&path), "machine", "default", "s1").unwrap();
        let first = excerpts.iter().find(|e| e.role == "user_first").expect("主会话首条");
        assert_eq!(first.native_event_id, "u1");
        assert!(first.excerpt.contains("主会话的任务"));
        // sidechain 的用户消息不得成为 user_turn，其回复不得抢 assistant_final。
        assert!(excerpts.iter().all(|e| !e.excerpt.contains("子代理")), "sidechain 文本不得混入：{excerpts:?}");
        let final_reply = excerpts.iter().find(|e| e.role == "assistant_final").expect("assistant_final");
        assert!(final_reply.excerpt.contains("主会话的确认"));
        assert_eq!(final_reply.native_event_id, "a2");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn parallel_task_blocks_in_one_record_do_not_collide_on_pk() {
        // 验收 finding 3：同一 assistant 记录里两个 Task tool_use（并行子代理）
        // 若用记录位置序会同 (session_key, ordinal, role) PK 碰撞、静默丢一个。
        // 摘录序号 = 会话内生产序，天然唯一。
        let path = std::env::temp_dir().join(format!("av-claude-parallel-{}.jsonl", std::process::id()));
        std::fs::write(&path, concat!(
            r#"{"type":"user","timestamp":"2026-09-19T13:00:00.000Z","uuid":"u1","message":{"content":"并行审查两个文件"}}"#, "
",
            r#"{"type":"assistant","timestamp":"2026-09-19T13:00:05.000Z","uuid":"a1","message":{"model":"claude-sonnet","content":[{"type":"tool_use","id":"t1","name":"Task","input":{"prompt":"审查迁移脚本"}},{"type":"tool_use","id":"t2","name":"Task","input":{"prompt":"审查测试 fixture"}}]}}"#, "
",
        )).unwrap();
        let (_events, excerpts, _titles) = claude_file_to_workflow_events(&PathBuf::from(&path), "machine", "default", "s1").unwrap();
        let subs: Vec<_> = excerpts.iter().filter(|e| e.role == "subagent_task").collect();
        assert_eq!(subs.len(), 2, "两个并行 Task 都要留下摘录：{subs:?}");
        let ordinals: Vec<i64> = subs.iter().map(|e| e.ordinal).collect();
        assert_ne!(ordinals[0], ordinals[1], "生产序号必须互异");
        assert!(subs.iter().any(|e| e.excerpt.contains("迁移脚本")));
        assert!(subs.iter().any(|e| e.excerpt.contains("测试 fixture")));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn task_tool_prompt_becomes_subagent_excerpt() {
        let path = std::env::temp_dir().join(format!("av-claude-subagent-{}.jsonl", std::process::id()));
        std::fs::write(&path, concat!(
            r#"{"type":"user","timestamp":"2026-09-19T11:00:00.000Z","uuid":"u1","message":{"content":"重构迁移脚本"}}"#, "\n",
            r#"{"type":"assistant","timestamp":"2026-09-19T11:00:10.000Z","uuid":"a1","message":{"model":"claude-sonnet","content":[{"type":"tool_use","id":"c9","name":"Task","input":{"prompt":"检查 tests/test_migration.py 的 fencepost，只读不改","description":"审查子任务"}}]}}"#, "\n",
        )).unwrap();
        let (_events, excerpts, _titles) = claude_file_to_workflow_events(&PathBuf::from(&path), "machine", "default", "s1").unwrap();
        let sub = excerpts.iter().find(|e| e.role == "subagent_task").expect("Task prompt 必须产 subagent_task 摘录");
        assert!(sub.excerpt.contains("fencepost"));
        assert_eq!(sub.native_event_id, "a1");
        std::fs::remove_file(path).ok();
    }

    fn emit(name: &str, lines: &[&str]) -> Vec<agent_vitals_domain::workflow::WorkflowEvent> {
        let path = std::env::temp_dir().join(format!("av-claude-{name}-{}.jsonl", std::process::id()));
        std::fs::write(&path, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
        let (events, _, _titles) = claude_file_to_workflow_events(&PathBuf::from(&path), "machine", "default", "s1").unwrap();
        std::fs::remove_file(path).ok();
        events
    }

    /// G6：此前整个会话只有首条用户消息产 `task_started`（真机 293 个会话共
    /// 299 个），「定位消耗区间」无从谈起。每条用户新请求开一个回合；执行环境回灌、
    /// meta 注入、压缩摘要、只改设置的斜杠命令、子代理对话都不算。
    #[test]
    fn each_user_request_opens_a_turn_but_harness_echoes_do_not() {
        let events = emit("turns", &[
            r#"{"type":"user","timestamp":"2026-09-01T10:00:00.000Z","uuid":"u1","message":{"content":"first request"}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:01:00.000Z","uuid":"m1","isMeta":true,"message":{"content":"Base directory for this skill: ..."}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:02:00.000Z","uuid":"t1","message":{"content":"<task-notification>\n<task-id>x</task-id>"}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:03:00.000Z","uuid":"c1","message":{"content":"<local-command-stdout>ok</local-command-stdout>"}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:04:00.000Z","uuid":"c2","message":{"content":"<command-name>/model</command-name>\n<command-args>opus</command-args>"}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:05:00.000Z","uuid":"s1","isSidechain":true,"message":{"content":"subagent prompt"}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:06:00.000Z","uuid":"k1","isCompactSummary":true,"message":{"content":"This session is being continued..."}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:07:00.000Z","uuid":"b1","message":{"content":"<bash-input>ls</bash-input>"}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:08:00.000Z","uuid":"u2","message":{"content":[{"type":"text","text":"second request"}]}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:09:00.000Z","uuid":"g1","message":{"content":"<command-name>/goal</command-name>\n<command-args>ship it</command-args>"}}"#,
        ]);
        let starts: Vec<i64> = events.iter().filter(|e| e.event_type == "task_started").map(|e| e.event_ts_ms).collect();
        assert_eq!(starts.len(), 3, "first request / second request / goal command：{starts:?}");
        let natives: Vec<&str> = events.iter().filter(|e| e.event_type == "task_started")
            .filter_map(|e| e.native_event_id.as_deref()).collect();
        assert_eq!(natives, ["u1", "u2", "g1"]);
    }

    /// 首回合的 event_id 与 G6 之前一致——存量库里那一行重放后仍是同一行，
    /// 不会留下旧 id 的孤儿（首回合保留历史谓词的原因）。
    #[test]
    fn first_turn_keeps_its_historical_event_id() {
        let lines = [
            r#"{"type":"user","timestamp":"2026-09-01T10:00:00.000Z","uuid":"u1","message":{"content":"<command-name>/model</command-name>"}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:01:00.000Z","uuid":"u2","message":{"content":"real request"}}"#,
        ];
        let events = emit("first-id", &lines);
        let starts: Vec<&str> = events.iter().filter(|e| e.event_type == "task_started")
            .filter_map(|e| e.native_event_id.as_deref()).collect();
        // 历史谓词只看「非空文本」：设置命令也开了首回合；其后的真实请求开第二个。
        assert_eq!(starts, ["u1", "u2"]);
        let path = std::env::temp_dir().join(format!("av-claude-first-id-{}.jsonl", std::process::id()));
        let expected = super::event_id(&path, 0, 0, "task_started");
        assert!(events.iter().any(|e| e.event_type == "task_started" && e.event_id == expected));
    }

    /// 用户中断当前回合 → 该回合产一条 `task_finished{cancelled}`（每回合至多
    /// 一条）；spec §11.1 的「主动取消」样本此前在 claude 上一个都没有。
    #[test]
    fn user_interrupt_marks_the_turn_cancelled_once() {
        let events = emit("interrupt", &[
            r#"{"type":"user","timestamp":"2026-09-01T10:00:00.000Z","uuid":"u1","message":{"content":"do a thing"}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:00:30.000Z","uuid":"i1","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:00:31.000Z","uuid":"i2","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:01:00.000Z","uuid":"u2","message":{"content":"do another"}}"#,
        ]);
        let cancelled: Vec<&str> = events.iter()
            .filter(|e| e.event_type == "task_finished" && e.outcome == "cancelled")
            .filter_map(|e| e.native_event_id.as_deref()).collect();
        assert_eq!(cancelled, ["i1"]);
        assert_eq!(events.iter().filter(|e| e.event_type == "task_started").count(), 2,
            "中断标记不开新回合");
        let ids: std::collections::HashSet<&str> = events.iter().map(|e| e.event_id.as_str()).collect();
        assert_eq!(ids.len(), events.len(), "event_id 不得碰撞");
    }

    /// 调用指纹区分参数：此前只编码工具名，同一会话里两条不同的 Bash 命令
    /// 各失败一次就被算成「同一调用重复失败」。键序不同的同一参数视为同一调用。
    #[test]
    fn invocation_fingerprint_distinguishes_arguments() {
        let events = emit("fp", &[
            r#"{"type":"user","timestamp":"2026-09-01T10:00:00.000Z","uuid":"u1","message":{"content":"go"}}"#,
            r#"{"type":"assistant","timestamp":"2026-09-01T10:00:01.000Z","uuid":"a1","message":{"model":"m","content":[{"type":"tool_use","id":"c1","name":"Bash","input":{"command":"npm test","timeout":5}}]}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:00:02.000Z","uuid":"r1","message":{"content":[{"type":"tool_result","tool_use_id":"c1","is_error":true,"content":"fail"}]}}"#,
            r#"{"type":"assistant","timestamp":"2026-09-01T10:00:03.000Z","uuid":"a2","message":{"model":"m","content":[{"type":"tool_use","id":"c2","name":"Bash","input":{"timeout":5,"command":"npm test"}}]}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:00:04.000Z","uuid":"r2","message":{"content":[{"type":"tool_result","tool_use_id":"c2","is_error":true,"content":"fail"}]}}"#,
            r#"{"type":"assistant","timestamp":"2026-09-01T10:00:05.000Z","uuid":"a3","message":{"model":"m","content":[{"type":"tool_use","id":"c3","name":"Bash","input":{"command":"ls"}}]}}"#,
            r#"{"type":"user","timestamp":"2026-09-01T10:00:06.000Z","uuid":"r3","message":{"content":[{"type":"tool_result","tool_use_id":"c3","is_error":true,"content":"fail"}]}}"#,
        ]);
        let fps: Vec<&str> = events.iter().filter(|e| e.event_type == "tool_finished")
            .filter_map(|e| e.invocation_fingerprint.as_deref()).collect();
        assert_eq!(fps.len(), 3);
        assert_eq!(fps[0], fps[1], "同一参数（键序不同）= 同一调用");
        assert_ne!(fps[0], fps[2], "不同命令 = 不同调用");
        let invoked: Vec<&str> = events.iter().filter(|e| e.event_type == "tool_invoked")
            .filter_map(|e| e.invocation_fingerprint.as_deref()).collect();
        assert_eq!(invoked, fps, "invoked 与 finished 同指纹（重试链按它配对）");
        assert!(fps.iter().all(|fp| !fp.contains("npm")), "指纹不携带参数原文");
    }

}
