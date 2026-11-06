//! MCP Surface（v0.8 Phase F，第一刀 F1a）—— **只做会话证据里已经存在的
//! `mcp__<server>__<tool>` 命名拆分**，不读任何配置文件、不发起任何网络请求。
//!
//! spec（`docs/AGENT_VITALS_V0_8_ARCHITECTURE_SPEC.md` §1.6/§13）把 MCP 定义为
//! 与 Skill/Session 并列的第三条证据面，但 Phase F 是净新功能，不是目录搬迁——
//! 调研发现见 `docs/AGENT_VITALS_V0_8_PHASE_F_RESEARCH.md` §2。这里先落地风险
//! 最低、确定性最高的切面：Claude Code 的工具调用名字本身就带着 MCP 服务器身份
//! （`mcp__github__search_issues` 这种三段式），今天这些名字原样滚进通用
//! `tool_calls` 桶（`harnesses/claude_code/sessions/evidence.rs::normalize_tool_name`
//! 的 `other => other` 分支），跟内置工具混在一起——本模块只是把这层身份剥出来，
//! **不改动、不重算**现有的 `tool_calls`/SV611 桶，两者是同一批事件的两个独立
//! 投影（与 skill invocation 同时喂 Session 的 `tool_calls` 和 Skill 的
//! Installed→Loaded→Triggered 漏斗是同一个道理，spec §1.6）。
//!
//! **命名约定目前只在 Claude Code 上被证实**：真实运行环境里 MCP 工具确凿以
//! `mcp__<server>__<tool>` 三段式出现。Codex 的 `McpToolCall` item 类型已经在
//! `harnesses/codex/sessions/evidence.rs` 里被识别（计进 `Signal::ToolCalls`），但它
//! 的 `name` 字段真实形状未经真机语料验证——本仓库自己的 Codex fixture
//! （`fixtures/codex/paginated.jsonl`）里那条 `"mcp__github"` 是手写合成值，两段式，
//! 不能当作证据。DSH/WorkBuddy 未调研。**因此本模块的解析函数只声明识别三段式
//! 命名，不为任何执行环境的 wire 形状背书**——调用方决定要不要在某个执行环境上使用它。
//! Python 平行实现 `packages/agent-vitals-python/agent_vitals/agent/mcp.py`，
//! 由 `tests/test_mcp.py` 的字符对字符钉测交叉锁定（尚无 CLI 命令，暂不进
//! `both()` 差分——那需要 F2 的报告面落地之后才有 JSON 输出可比）。

use std::collections::BTreeMap;

/// `mcp__<server>__<tool>` → `Some((server, tool))`；不匹配三段式（缺前缀、
/// 少一段、多一段都算不匹配）→ `None`，调用方原样当内置工具处理，不是
/// MCP 调用，不臆造服务器身份。
///
/// `server`/`tool` 本身允许含单下划线/连字符（MCP 服务器名/工具名不保证不含
/// `_`/`-`），例如本环境实测的 `mcp__claude-in-chrome__read_console_messages`。
/// 但 `mcp__` 前缀之后**必须恰好有一处** `__` 分隔——如果出现第二处 `__`
/// （例如 `mcp__server__part__tool`），server 与 tool 的真实边界就是歧义的，
/// 没有约定告诉我们该在哪一处切，所以整体判不匹配、返回 `None`，而不是贪心
/// 取最后一处 `__` 猜一个（曾经的实现用 `rsplit_once` 只取最后一处，会把
/// `server__part` 当成 server 名——这只是巧合地对多数真实名字有效，对歧义
/// 输入是静默猜测，不是诚实拒绝，`test_ambiguous_four_segment_form_is_rejected`
/// 钉住这条回归）。
pub fn parse_mcp_tool_name(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix("mcp__")?;
    let mut parts = rest.split("__");
    let server = parts.next()?;
    let tool = parts.next()?;
    if parts.next().is_some() {
        return None; // 第三段起出现 → 边界歧义，拒绝而不是猜
    }
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    Some((server, tool))
}

/// 一批工具调用名字 → `{server: {tool: 次数}}`。非 MCP 名字（`parse_mcp_tool_name`
/// 返回 `None`）静默跳过——这个函数只回答"MCP 那部分调用了什么"，不是"总共调用
/// 了什么"（那是既有 `tool_calls` 桶的职责，两者不重复也不互斥）。
pub fn count_mcp_tool_calls<'a>(
    tool_names: impl IntoIterator<Item = &'a str>,
) -> BTreeMap<String, BTreeMap<String, u64>> {
    let mut out: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    for name in tool_names {
        if let Some((server, tool)) = parse_mcp_tool_name(name) {
            *out
                .entry(server.to_string())
                .or_default()
                .entry(tool.to_string())
                .or_insert(0) += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_three_segment_convention() {
        assert_eq!(
            parse_mcp_tool_name("mcp__github__search_issues"),
            Some(("github", "search_issues"))
        );
    }

    #[test]
    fn server_and_tool_may_contain_underscores_and_hyphens() {
        // 实测本环境真实工具名：server 含连字符，tool 含单下划线，但两者都不含
        // 第二处 "__"，所以恰好一处分隔点、无歧义。
        assert_eq!(
            parse_mcp_tool_name("mcp__claude-in-chrome__read_console_messages"),
            Some(("claude-in-chrome", "read_console_messages"))
        );
    }

    #[test]
    fn missing_prefix_is_not_mcp() {
        assert_eq!(parse_mcp_tool_name("Bash"), None);
        assert_eq!(parse_mcp_tool_name("Read"), None);
    }

    #[test]
    fn ambiguous_four_segment_form_is_rejected() {
        // 回归测试：曾经的实现用 rsplit_once 只找最后一处 "__"，会把
        // "server__part" 悄悄当成 server 名返回 Some，而不是诚实报告"边界
        // 歧义、不认识"。真实 MCP 服务器/工具名是否会出现第二处 "__" 没有
        // 约定可查，宁可拒绝也不猜。
        assert_eq!(parse_mcp_tool_name("mcp__server__part__tool"), None);
    }

    #[test]
    fn two_segment_form_is_not_recognized() {
        // Codex fixture 里合成的 "mcp__github"（无第三段）—— rsplit_once 会把
        // "mcp__" 后面的整个 "github" 当 tool、server 拆不出来（没有第二个
        // "__"），所以 rsplit_once 返回 None，函数诚实报不认识，不猜一个空
        // server。这正是本模块只服务 Claude Code、不为 Codex 背书的体现。
        assert_eq!(parse_mcp_tool_name("mcp__github"), None);
    }

    #[test]
    fn empty_server_or_tool_segment_is_rejected() {
        assert_eq!(parse_mcp_tool_name("mcp____tool"), None);
        assert_eq!(parse_mcp_tool_name("mcp__server__"), None);
    }

    #[test]
    fn bare_mcp_prefix_is_not_recognized() {
        assert_eq!(parse_mcp_tool_name("mcp__"), None);
        assert_eq!(parse_mcp_tool_name("mcp"), None);
    }

    #[test]
    fn count_aggregates_per_server_per_tool_and_skips_non_mcp_names() {
        let names = [
            "mcp__github__search_issues",
            "mcp__github__search_issues",
            "mcp__github__list_prs",
            "mcp__figma__get_metadata",
            "Bash",
            "Read",
        ];
        let counts = count_mcp_tool_calls(names);
        assert_eq!(counts.len(), 2, "两个 MCP 服务器，内置工具不计入");
        assert_eq!(counts["github"]["search_issues"], 2);
        assert_eq!(counts["github"]["list_prs"], 1);
        assert_eq!(counts["figma"]["get_metadata"], 1);
    }

    #[test]
    fn empty_input_yields_empty_map_not_a_default_server() {
        let counts = count_mcp_tool_calls(std::iter::empty());
        assert!(counts.is_empty());
    }
}
