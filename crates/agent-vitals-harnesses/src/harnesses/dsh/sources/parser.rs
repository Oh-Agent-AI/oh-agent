//! DSH 的 `SourceParser` 注册位（AGENT_VITALS_SOURCE_GRAPH_INFRASTRUCTURE_
//! SPEC §5 插件位，P3 显式全量申报）。wire 解释在 `usage_fact.rs`。
//!
//! **为何显式申报全量**：DSH 会话日志是 zstd 多帧压缩（R2a §6.3-1，ruzstd
//! 纯 Rust 解压）。spec §11 非目标明文「不做 DSH zstd 解压增量」——压缩帧
//! 边界 ≠ 行边界，从中间帧起读需要帧索引，成本不成比例。检查点继续以
//! `FULL_PARSE_V0` + stat size 落（换 id 会触发 classify 的
//! parser-id-mismatch 硬失效，让存量文件无谓地全量重放一轮）。

use std::path::Path;

use agent_vitals_domain::source_graph::{
    ParseContext, ParseOutput, ParserDescriptor, SourceParser, FULL_PARSE_V0,
};

use super::usage_fact::dsh_session_to_usage_facts;

pub struct DshParser;

impl SourceParser for DshParser {
    fn descriptor(&self) -> ParserDescriptor {
        ParserDescriptor { parser_id: FULL_PARSE_V0, can_increment: false }
    }

    fn parse_full(&self, ctx: &ParseContext, path: &Path) -> Result<ParseOutput, String> {
        let r = dsh_session_to_usage_facts(path, ctx.machine_namespace, None)?;
        Ok(ParseOutput {
            facts: r.facts,
            workflow_events: r.workflow_events,
            session_excerpts: Vec::new(),
            // DSH 标题在侧车索引（`storages/workspace.json`），不在会话日志
            // wire 里——sync 的索引趟直接喂标题写入路径，不经过解析器。
            session_titles: Vec::new(),
            // 全量执行环境 offset 无语义，落 0；调度器不覆写其检查点。
            new_offset: 0,
        })
    }
}
