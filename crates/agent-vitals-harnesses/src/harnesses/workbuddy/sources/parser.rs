//! workbuddy 的 `SourceParser` 注册位（AGENT_VITALS_SOURCE_GRAPH_
//! INFRASTRUCTURE_SPEC §5 插件位，P3 显式全量申报）。wire 解释在
//! `usage_fact.rs`。
//!
//! workbuddy：sqlite trace 库，一个 trace 文件 = 一个 source_id
//! （spec WORKBUDDY_ONBOARDING §9E.4 纪律 7 的增量索引就是 source_files
//! 指纹）。emitter 自身按 trace.sessionId 归属，无 sessionId 的 trace 不发
//! 事实——那些文件同样落指纹（本轮「已处理」），不会每 tick 重读 686MB。
//! spec §11 非目标明文「不做 SQLite 行级差量」——停留在 mtime 文件级。

use std::path::Path;

use agent_vitals_domain::source_graph::{
    ParseContext, ParseOutput, ParserDescriptor, SourceParser, FULL_PARSE_V0,
};

use super::usage_fact::workbuddy_trace_file_to_usage_facts;

pub struct WorkbuddyParser;

impl SourceParser for WorkbuddyParser {
    fn descriptor(&self) -> ParserDescriptor {
        ParserDescriptor { parser_id: FULL_PARSE_V0, can_increment: false }
    }

    fn parse_full(&self, ctx: &ParseContext, path: &Path) -> Result<ParseOutput, String> {
        let r = workbuddy_trace_file_to_usage_facts(
            path, ctx.machine_namespace, ctx.source_profile,
        )?;
        Ok(ParseOutput {
            facts: r.facts,
            workflow_events: r.workflow_events,
            session_excerpts: Vec::new(),
            // WorkBuddy 标题在 workbuddy.db 的 sessions 表（SQLite），不在
            // trace wire 里；当前不接（City 楼名走 fallback 命名）。
            session_titles: Vec::new(),
            new_offset: 0,
        })
    }
}
