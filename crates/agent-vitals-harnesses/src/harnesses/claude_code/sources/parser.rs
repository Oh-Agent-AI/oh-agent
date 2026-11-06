//! claude-code 的 `SourceParser` 注册位（AGENT_VITALS_SOURCE_GRAPH_
//! INFRASTRUCTURE_SPEC §5 插件位，P1a 增量解析器 + P3 注册制）。
//!
//! 本文件是薄注册壳：wire 解释都在 `usage_fact.rs`（增量/全量 emitter）——
//! 这里只做 trait 形状适配（`ParseOutput` 组装、检查点 offset 语义）与
//! claude-jsonl-v1 的身份申报。**不在本文件直接调 `insert_outbox`**：
//! 事件发射是调度器（写事务内）的职责（SOURCE_GRAPH_DEPENDENCY_MAP 纪律表）。
//!
//! 增量纪律：`parse_increment` 从检查点 offset 续读到 EOF、停在最后完整
//! 换行。workflow / session_excerpts 增量轮**整文件重扫**（PARSER_VERSION 6
//! 起；M2 当初决议「增量轮不重扫」，结果是首轮全量之后追加的工具结果、回合、
//! 模型切换永远不入库——真机 9 个活跃会话的 2527 次调用落在 workflow 覆盖之外，
//! 会话诊断恰恰最关心这些尾部）。跨行状态（tool_use→tool_result 配对、回合、
//! 模型）让「从 offset 续扫」不成立，整文件重扫靠 event_id 幂等吸收重复；
//! 代价是活跃会话每轮多读一次文件（真机 p99 37MB、最大 130MB）。全量轮也写
//! 换行边界 offset（不是 stat size）——F2 死循环防线：写 stat size 会让
//! 增量从行中间起读。

use std::path::Path;

use agent_vitals_domain::source_graph::{
    ParseContext, ParseOutput, ParserDescriptor, SourceParser,
};

use super::usage_fact::{claude_jsonl_to_usage_facts, claude_jsonl_to_usage_facts_incremental};
use super::workflow::claude_file_to_workflow_events;

/// claude-code JSONL 会话日志（append-only）。P1a 增量解析器的注册位。
pub struct ClaudeCodeParser;

/// 换行边界：文件里最后一个 `\n` 的下一字节位置；无换行 = 0（整文件
/// 都是不完整行，留给下一轮）。从末尾往回分块扫——GB 级会话文件不能
/// 整读一遍只为找边界。
fn last_newline_offset(path: &Path) -> std::io::Result<u64> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    let len = file.seek(SeekFrom::End(0))?;
    const CHUNK: u64 = 64 * 1024;
    let mut tail = vec![0u8; CHUNK as usize];
    let mut scanned = 0u64;
    while scanned < len {
        let want = CHUNK.min(len - scanned);
        file.seek(SeekFrom::Start(len - scanned - want))?;
        file.read_exact(&mut tail[..want as usize])?;
        if let Some(pos) = tail[..want as usize].iter().rposition(|&b| b == b'\n') {
            return Ok(len - scanned - want + pos as u64 + 1);
        }
        scanned += want;
    }
    Ok(0)
}

/// 文件主干 = 会话的 native id 兜底（`resolve_native_session_id` 缺席时按
/// stem 归属——与 sync_service 既有行为一致）。
fn file_stem_of(path: &Path) -> String {
    path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string()
}

impl SourceParser for ClaudeCodeParser {
    fn descriptor(&self) -> ParserDescriptor {
        ParserDescriptor { parser_id: "claude-jsonl-v1", can_increment: true }
    }

    fn parse_increment(
        &self,
        ctx: &ParseContext,
        path: &Path,
        from_offset: u64,
    ) -> Result<ParseOutput, String> {
        let sid = file_stem_of(path);
        let (facts, new_offset) = claude_jsonl_to_usage_facts_incremental(
            path, ctx.machine_namespace, ctx.source_profile, &sid, from_offset,
        )?;
        let (workflow_events, session_excerpts, session_titles) = claude_file_to_workflow_events(
            path, ctx.machine_namespace, ctx.source_profile, &sid,
        )?;
        Ok(ParseOutput {
            facts,
            workflow_events,
            session_excerpts,
            session_titles,
            new_offset,
        })
    }

    fn parse_full(&self, ctx: &ParseContext, path: &Path) -> Result<ParseOutput, String> {
        let sid = file_stem_of(path);
        let r = claude_jsonl_to_usage_facts(
            path, ctx.machine_namespace, ctx.source_profile, &sid,
        )?;
        let new_offset = last_newline_offset(path).unwrap_or(0);
        Ok(ParseOutput {
            facts: r.facts,
            workflow_events: r.workflow_events,
            session_excerpts: r.session_excerpts,
            session_titles: r.session_titles,
            new_offset,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::parsers::parser_for;

    fn ctx<'a>() -> ParseContext<'a> {
        ParseContext { machine_namespace: "ns", source_profile: "default" }
    }

    fn write_jsonl(path: &Path, lines: &[&str]) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
    }

    fn fact_ids(facts: &[serde_json::Value]) -> Vec<String> {
        let mut ids: Vec<String> = facts
            .iter()
            .filter_map(|f| f.get("fact_id").and_then(|v| v.as_str()).map(String::from))
            .collect();
        ids.sort();
        ids
    }

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "avd-claude-parser-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 身份申报：claude-jsonl-v1 + 可增量（descriptor 表的 claude 行）。
    #[test]
    fn descriptor_declares_claude_jsonl_v1_increment() {
        let d = ClaudeCodeParser.descriptor();
        assert_eq!(d.parser_id, "claude-jsonl-v1");
        assert!(d.can_increment);
        // 检查点已有 offset → 可增量；首见（无 offset）→ 全量引导
        let with_offset =
            agent_vitals_domain::source_graph::FileCheckpoint {
                byte_offset: Some(10),
                ..Default::default()
            };
        assert!(ClaudeCodeParser.can_increment(&with_offset));
        assert!(!ClaudeCodeParser.can_increment(&Default::default()));
    }

    /// 差分门主体（spec §10.1 验收 #1）：分三次追加写入，每次经注册表
    /// trait 解析；最后与全量比对 fact_id 集——全量/增量必须逐条一致。
    /// 从 runtime 迁来（P1a 版）并改走注册表（P3），断言不变。
    #[test]
    fn differential_gate_full_vs_incremental_fact_id_parity() {
        let dir = tmp_dir("gate");
        let file = dir.join("session-a.jsonl");
        let parser = parser_for("claude-code").unwrap();

        let batch1 = [
            r#"{"type":"assistant","uuid":"u1","timestamp":"2026-09-05T10:00:00.000Z","message":{"id":"msg_1","model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":3}}}"#,
            r#"{"type":"user","uuid":"u2","timestamp":"2026-09-05T10:01:00.000Z","message":{"content":[{"type":"text","text":"run"}]}}"#,
        ];
        let batch2 = [
            r#"{"type":"assistant","uuid":"u3","timestamp":"2026-09-05T10:02:00.000Z","message":{"id":"msg_3","model":"claude-sonnet-5","usage":{"input_tokens":15,"cache_read_input_tokens":25,"cache_creation_input_tokens":8,"output_tokens":6}}}"#,
            // M1（复跑发现）：无 message.id、无 uuid 的 assistant 行——触发
            // derived_event_id 路径，fact_id 由 (session, line_offset, record)
            // 派生。增量版的 line_offset = start + from_offset 基准换算是
            // 全量/增量 fact_id 一致性的关键坐标数学。
            r#"{"type":"assistant","timestamp":"2026-09-05T10:02:30.000Z","message":{"model":"claude-sonnet-5","usage":{"input_tokens":7,"cache_read_input_tokens":1,"cache_creation_input_tokens":0,"output_tokens":2}}}"#,
            r#"{"type":"assistant","uuid":"u4","timestamp":"2026-09-05T10:03:00.000Z","message":{"id":"msg_4","model":"claude-haiku-4","usage":{"input_tokens":5,"cache_read_input_tokens":1,"cache_creation_input_tokens":0,"output_tokens":2}}}"#,
        ];
        let batch3 = [
            r#"{"type":"user","uuid":"u5","timestamp":"2026-09-05T10:04:00.000Z","message":{"content":[{"type":"tool_use","id":"c1","name":"Bash","input":{"command":"ls"}}]}}"#,
            r#"{"type":"assistant","uuid":"u6","timestamp":"2026-09-05T10:04:01.000Z","message":{"id":"msg_6","model":"claude-sonnet-5","usage":{"input_tokens":20,"cache_read_input_tokens":30,"output_tokens":10}}}"#,
        ];

        // 首见：descriptor 申报可增量但检查点无 offset → 走全量引导
        write_jsonl(&file, &batch1);
        let full1 = parser.parse_full(&ctx(), &file).unwrap();
        assert!(!full1.facts.is_empty(), "第一批应有事实");
        assert!(full1.new_offset > 0, "全量引导也要写换行边界（F2 防线）");

        // 软失效：从检查点续读
        write_jsonl(&file, &batch2);
        let inc2 = parser.parse_increment(&ctx(), &file, full1.new_offset).unwrap();
        assert!(inc2.new_offset > full1.new_offset, "第二批 offset 应继续推进");
        // PARSER_VERSION 6：增量轮整文件重扫 workflow——追加段里的用户请求
        // 必须产出回合事件，且与全量同 event_id（幂等吸收的前提）。
        let full2 = parser.parse_full(&ctx(), &file).unwrap();
        let ids = |events: &[agent_vitals_domain::workflow::WorkflowEvent]| {
            let mut ids: Vec<String> = events.iter().map(|e| e.event_id.clone()).collect();
            ids.sort();
            ids
        };
        assert_eq!(ids(&inc2.workflow_events), ids(&full2.workflow_events),
            "增量轮的 workflow 事件必须与同一时刻的全量逐条一致");

        write_jsonl(&file, &batch3);
        let inc3 = parser.parse_increment(&ctx(), &file, inc2.new_offset).unwrap();
        assert!(inc3.new_offset > inc2.new_offset);

        // 全量对照
        let full = parser.parse_full(&ctx(), &file).unwrap();

        let mut incremental_facts = full1.facts;
        incremental_facts.extend(inc2.facts);
        incremental_facts.extend(inc3.facts);
        assert_eq!(
            fact_ids(&incremental_facts),
            fact_ids(&full.facts),
            "差分门（spec §10.1）：全量与增量的 fact_id 必须逐条一致\n  增量: {:?}\n  全量: {:?}",
            fact_ids(&incremental_facts), fact_ids(&full.facts),
        );

        // offset 一致性：全量轮的换行边界 = 全部行处理完的增量终点 = 文件长度
        let file_len = std::fs::metadata(&file).unwrap().len();
        assert_eq!(inc3.new_offset, file_len, "增量终点 = 文件长度");
        assert_eq!(full.new_offset, file_len, "全量换行边界 = 文件长度");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 尾部不完整行（in-flight writer）：增量不产事实、offset 不进半行；
    /// 半行补全后下一轮产出。
    #[test]
    fn differential_gate_partial_line_left_for_next_round() {
        use std::io::Write;
        let dir = tmp_dir("partial");
        let file = dir.join("partial.jsonl");
        let parser = parser_for("claude-code").unwrap();

        let complete = r#"{"type":"assistant","uuid":"u1","timestamp":"2026-09-05T10:00:00.000Z","message":{"id":"msg_1","model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_read_input_tokens":2,"cache_creation_input_tokens":1,"output_tokens":3}}}"#;
        let partial = r#"{"type":"assistant","uuid":"u2","timestamp":"2026-09-05T10:01"#; // 截断

        let mut f = std::fs::File::create(&file).unwrap();
        writeln!(f, "{complete}").unwrap();
        write!(f, "{partial}").unwrap(); // 不带换行
        drop(f);

        let out = parser.parse_increment(&ctx(), &file, 0).unwrap();
        assert_eq!(out.facts.len(), 1, "只有完整行产事实");
        let file_len = std::fs::metadata(&file).unwrap().len();
        assert!(out.new_offset < file_len,
            "offset 停在完整换行后，不进半行: offset={}, len={file_len}", out.new_offset);

        // 补全半行 + 换行 → 下轮增量应处理它
        let mut f2 = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        let tail = r#":00.000Z","message":{"id":"msg_2","model":"claude-sonnet-5","usage":{"input_tokens":5,"cache_read_input_tokens":1,"cache_creation_input_tokens":0,"output_tokens":2}}}"#;
        writeln!(f2, "{tail}").unwrap();
        drop(f2);

        let out2 = parser.parse_increment(&ctx(), &file, out.new_offset).unwrap();
        assert_eq!(out2.facts.len(), 1, "补全后的半行在下一轮产出");
        let file_len2 = std::fs::metadata(&file).unwrap().len();
        assert_eq!(out2.new_offset, file_len2, "全部完成后 offset = 文件长度");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
