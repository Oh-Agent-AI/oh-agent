//! Claude Code 的回合 wire 翻译——**唯一一份**，evidence（SV612、调用树、
//! UserPrompts 覆盖）与 workflow（`task_started`、消耗诊断）共用。
//!
//! 此前两处各有判据且结论不同：evidence 用「字符串或不含 tool_result 的数组」
//! 开回合，把 skill 正文注入、`<task-notification>`、中断标记都算成回合；
//! workflow 只认会话首条文本。同一会话在调用树与消耗诊断里回合数对不上。
//! 本模块只回答「这条 user 记录对回合意味着什么」（wire 知识）；回合语义
//! （开回合、取消至多一次）在 `agent_vitals_domain::session_semantics::TurnTracker`。
//! Python 镜像：`claude_evidence.py::turn_signal`（差分门守）。

use agent_vitals_domain::session_semantics::UserTurnSignal;
use serde_json::Value;

/// 字符串或全 text 块且非空（首回合的历史判据；event_id 依赖它，见
/// `turn_signal`）。
pub(crate) fn text_content(content: Option<&Value>) -> bool {
    match content {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Array(values)) => !values.is_empty() && values.iter().all(|value| {
            value.get("type").and_then(Value::as_str) == Some("text")
                && value.get("text").and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty())
        }),
        _ => false,
    }
}

/// 用户文本：字符串，或数组但不含 `tool_result` 块（允许 image 等非文本块
/// 共存，只取 text 块）。返回拼接后的文本。
pub(crate) fn user_prompt_text(content: Option<&Value>) -> Option<String> {
    match content {
        Some(Value::String(value)) => (!value.trim().is_empty()).then(|| value.clone()),
        Some(Value::Array(values)) => {
            if values.iter().any(|value| value.get("type").and_then(Value::as_str) == Some("tool_result")) {
                return None;
            }
            let mut text = String::new();
            for value in values {
                if value.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(part) = value.get("text").and_then(Value::as_str) {
                        if !part.trim().is_empty() {
                            text.push_str(part);
                        }
                    }
                }
            }
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

/// 执行环境回灌到对话里、但不是用户向助手提的请求的文本前缀。
const HARNESS_ECHO: [&str; 8] = [
    "<task-notification", "<local-command-stdout", "<local-command-stderr",
    "<local-command-caveat", "<bash-input", "<bash-stdout", "<bash-stderr",
    "[Request interrupted",
];

/// 只改会话设置、不派活的内建斜杠命令。`/goal`、自定义命令与 skill 命令会让
/// 助手干活，算新请求。
const SETTINGS_ONLY: [&str; 16] = [
    "model", "effort", "clear", "compact", "fast", "config", "cost", "status", "help",
    "login", "logout", "permissions", "context", "memory", "resume", "exit",
];

/// 一条 `type: "user"` 记录的回合信号。`has_turn` = 会话里是否已开过回合。
///
/// - 子代理对话（`isSidechain`）永不开主会话回合。（历史 workflow 首回合不看
///   这个标记；真机 98 个会话没有一个以 sidechain 文本开头，所以加上它不会让
///   任何存量首回合换 id。）
/// - 首回合沿用历史判据 `text_content`（不看其余标记）：workflow 的
///   `task_started` event_id 依赖 offset，首回合换一条记录起算会让存量库里
///   那一行变成孤儿。
/// - 其后：`isMeta` 注入（skill 正文、图片占位、
///   续写提示）、`isCompactSummary`、执行环境回灌（HARNESS_ECHO）、只改设置的斜杠命令
///   都不开回合；`[Request interrupted…` 是中断；其余非空文本是新请求。真机
///   60 个会话里被排除的记录约占 user 文本记录的 40%。
pub(crate) fn turn_signal(record: &Value, has_turn: bool) -> UserTurnSignal {
    let content = record.get("message").and_then(|message| message.get("content"));
    let flag = |key: &str| record.get(key).and_then(Value::as_bool).unwrap_or(false);
    if flag("isSidechain") {
        return UserTurnSignal::Other;
    }
    if !has_turn {
        return if text_content(content) { UserTurnSignal::Request } else { UserTurnSignal::Other };
    }
    let Some(text) = user_prompt_text(content) else { return UserTurnSignal::Other };
    let text = text.trim_start();
    if text.starts_with("[Request interrupted") {
        return UserTurnSignal::Interrupt;
    }
    // 后续回合不要求「全是 text 块」：贴图的请求（text + image 块）也是新请求——
    // 验收发现真机 76 条这样的 prompt 被并进了上一回合。`user_prompt_text` 已排除
    // tool_result 数组并要求非空文本。
    if flag("isMeta") || flag("isCompactSummary") {
        return UserTurnSignal::Other;
    }
    if HARNESS_ECHO.iter().any(|prefix| text.starts_with(prefix)) {
        return UserTurnSignal::Other;
    }
    if let Some(rest) = text.strip_prefix("<command-name>/") {
        let command = rest.split(|c: char| c == '<' || c.is_whitespace()).next().unwrap_or("");
        if SETTINGS_ONLY.contains(&command) {
            return UserTurnSignal::Other;
        }
    }
    UserTurnSignal::Request
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(content: Value) -> Value {
        json!({"type": "user", "message": {"content": content}})
    }

    #[test]
    fn first_turn_uses_the_historical_predicate() {
        assert_eq!(turn_signal(&user(json!("<command-name>/model</command-name>")), false), UserTurnSignal::Request);
        assert_eq!(turn_signal(&user(json!("")), false), UserTurnSignal::Other);
        assert_eq!(turn_signal(&user(json!([{"type": "tool_result", "tool_use_id": "x"}])), false), UserTurnSignal::Other);
    }

    #[test]
    fn later_turns_exclude_echoes_meta_and_settings_commands() {
        let other = [
            user(json!("<task-notification>\n<task-id>x</task-id>")),
            user(json!("<local-command-stdout>ok</local-command-stdout>")),
            user(json!("<command-name>/model</command-name>")),
            user(json!("<bash-input>ls</bash-input>")),
            json!({"type": "user", "isMeta": true, "message": {"content": "Base directory for this skill"}}),
            json!({"type": "user", "isCompactSummary": true, "message": {"content": "This session is being continued"}}),
            json!({"type": "user", "isSidechain": true, "message": {"content": "subagent prompt"}}),
            user(json!([{"type": "tool_result", "tool_use_id": "x", "content": "ok"}])),
        ];
        for record in &other {
            assert_eq!(turn_signal(record, true), UserTurnSignal::Other, "{record}");
        }
        assert_eq!(turn_signal(&user(json!("fix the bug")), true), UserTurnSignal::Request);
        assert_eq!(
            turn_signal(&user(json!([{"type": "text", "text": "分析这张图 [Image #1]"}, {"type": "image", "source": {}}])), true),
            UserTurnSignal::Request,
            "贴图的请求也开回合"
        );
        assert_eq!(turn_signal(&user(json!([{"type": "image", "source": {}}])), true), UserTurnSignal::Other, "只有图、没有文本");
        assert_eq!(turn_signal(&user(json!("<command-name>/goal</command-name>")), true), UserTurnSignal::Request);
        assert_eq!(turn_signal(&user(json!([{"type": "text", "text": "[Request interrupted by user]"}])), true), UserTurnSignal::Interrupt);
    }
}
