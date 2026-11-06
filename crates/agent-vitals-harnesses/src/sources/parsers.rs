//! `SourceParser` 注册表（AGENT_VITALS_SOURCE_GRAPH_INFRASTRUCTURE_SPEC §5
//! 插件位，P3「执行环境铺开」）。执行环境 wire 解释只住在本 crate 的各执行环境解析器；
//! runtime 经 [`descriptor_for`] / [`parser_for`] 查表——**调度器里不允许再
//! 出现 harness 字符串特判的解析路由**（P3 收编目标，此前是
//! `harness == "claude-code"` 字面量散落 sync_service 两处）。
//!
//! 注册面分两类：
//! - **trait 背书**（[`parser_for`] 返回 `Some`）：逐文件语义的解析器。
//!   claude-code（增量）、dsh / workbuddy（显式全量申报）。实现各住
//!   `harnesses/<h>/sources/parser.rs`（SOURCE_GRAPH_DEPENDENCY_MAP 纪律：
//!   一个解析器一个文件、一个 impl 块）。
//! - **仅 descriptor 申报**（只在 [`descriptor_for`] 出现）：codex——它是
//!   **批** emitter（跨文件 `seen` 去重 + 整批配额折叠），per-file trait
//!   装不下；sync 的 codex 批路径继续走 `codex_usage_fact` 批函数。
//!
//! 放在 `src/sources/`（而非 crate 根）：注册表编排各执行环境 I/O 解析器，
//! 落进 `tests/dependency_budget.rs::io_tokens_only_appear_under_sources`
//! 的路径守卫（"路径含 `/sources`"）。本文件本身无 I/O——纯查表。
//!
//! parser_id 纪律：**接管文件 offset 语义的解析器才有自己的 id**
//! （claude-code → `claude-jsonl-v1`，offset = 换行边界）。保持全量路径的
//! 执行环境继续以 `FULL_PARSE_V0` 落检查点——换 id 会触发 classify 的
//! parser-id-mismatch 硬失效，让所有存量文件无谓地全量重放一轮。

use agent_vitals_domain::source_graph::{ParserDescriptor, SourceParser, FULL_PARSE_V0};

use crate::harnesses::claude_code::sources::parser::ClaudeCodeParser;
use crate::harnesses::dsh::sources::parser::DshParser;
use crate::harnesses::workbuddy::sources::parser::WorkbuddyParser;

/// codex 的注册行（仅 descriptor；无 trait 实现，见模块文档）。struct 留在
/// 注册表里是因为它没有执行环境专属代码——申报即全部内容。
pub struct CodexParser;

impl CodexParser {
    /// codex 的注册行。三重全文件前缀依赖使增量不安全（AGENTS.md 计费诚实
    /// 规则）：① `CodexFoldState::last_total_sig` 连续复读去重——起读点落在
    /// 复读序列中间会把复读判成新事件：同累计值双计，且 fact_id 含字节偏移、
    /// 与原事件不同，ingest 层幂等吸收救不了；② route/provider 状态时间线：
    /// 事件时刻的路由证据必须来自文件前缀的状态段，丢前缀 = 静默误归因；
    /// ③ 配额快照是整批折叠的产物，增量轮的部分折叠会产出假快照。
    /// emit-gate（全扫状态 + 只 emit 新段）是可选项，需差分门重新验证后
    /// 才能接管；在此之前 codex 保持全量批路径。
    pub fn descriptor(&self) -> ParserDescriptor {
        ParserDescriptor { parser_id: FULL_PARSE_V0, can_increment: false }
    }
}

static CLAUDE_CODE: ClaudeCodeParser = ClaudeCodeParser;
pub static CODEX: CodexParser = CodexParser;
static DSH: DshParser = DshParser;
static WORKBUDDY: WorkbuddyParser = WorkbuddyParser;

/// 解析器描述符查表：发现层判 skip/处理 + emit 层判增量/全量的唯一依据。
/// 未知执行环境 → 全量缺省（防御：新增执行环境漏注册时行为 = 现状全量，不会错增量）。
pub fn descriptor_for(harness: &str) -> ParserDescriptor {
    match harness {
        "claude-code" => CLAUDE_CODE.descriptor(),
        "codex" => CODEX.descriptor(),
        "dsh" => DSH.descriptor(),
        "workbuddy" => WORKBUDDY.descriptor(),
        _ => ParserDescriptor { parser_id: FULL_PARSE_V0, can_increment: false },
    }
}

/// trait 背书的逐文件解析器查表。codex 不在这里（批 emitter，见模块文档）。
pub fn parser_for(harness: &str) -> Option<&'static dyn SourceParser> {
    match harness {
        "claude-code" => Some(&CLAUDE_CODE),
        "dsh" => Some(&DSH),
        "workbuddy" => Some(&WORKBUDDY),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::parsers::parser_for as lookup;
    use agent_vitals_domain::source_graph::FileCheckpoint;
    use std::path::Path;

    /// 注册表完备性（spec §9-P3「执行环境铺开」的申报面）：增量执行环境恰好一个、
    /// 其余全部显式申报全量；未知执行环境落全量缺省。
    #[test]
    fn descriptor_table_declares_every_sync_harness() {
        let claude = descriptor_for("claude-code");
        assert_eq!(claude.parser_id, "claude-jsonl-v1");
        assert!(claude.can_increment, "claude-code 是 P1a 增量解析器");

        for harness in ["codex", "dsh", "workbuddy"] {
            let d = descriptor_for(harness);
            assert_eq!(d.parser_id, FULL_PARSE_V0,
                "{harness} 保持全量 id——换 id 会触发无谓全量重放");
            assert!(!d.can_increment, "{harness} 必须显式申报不可增量");
        }

        let unknown = descriptor_for("not-a-harness");
        assert_eq!(unknown.parser_id, FULL_PARSE_V0);
        assert!(!unknown.can_increment, "未知执行环境缺省必须全量（不许错增量）");
    }

    /// trait 查表与 descriptor 查表一致：trait 背书的执行环境 descriptor 可增量
    /// 申报与查表一致；codex 只有 descriptor、不在 trait 查表里。
    #[test]
    fn parser_table_matches_descriptor_table() {
        assert!(lookup("claude-code").is_some());
        assert!(lookup("dsh").is_some());
        assert!(lookup("workbuddy").is_some());
        assert!(lookup("codex").is_none(),
            "codex 是批 emitter，per-file trait 装不下（模块文档）");
        assert_eq!(lookup("claude-code").unwrap().descriptor(), descriptor_for("claude-code"));
        assert_eq!(lookup("dsh").unwrap().descriptor(), descriptor_for("dsh"));
        assert_eq!(lookup("workbuddy").unwrap().descriptor(), descriptor_for("workbuddy"));
    }

    /// 全量执行环境的 parse_increment 走缺省拒绝（trait 文档契约：
    /// 「解析器谎报」守卫）；descriptor 申报 false 时缺省 can_increment
    /// 恒 false（不许猜）。
    #[test]
    fn full_only_parsers_refuse_increment() {
        let checkpoint = FileCheckpoint { byte_offset: Some(10), ..FileCheckpoint::default() };
        for harness in ["dsh", "workbuddy"] {
            let parser = lookup(harness).unwrap();
            assert!(!parser.can_increment(&checkpoint), "{harness} 不得判可增量");
            assert!(
                parser.parse_increment(
                    &agent_vitals_domain::source_graph::ParseContext {
                        machine_namespace: "ns",
                        source_profile: "default",
                    },
                    Path::new("/nonexistent"),
                    0,
                ).is_err(),
                "{harness} 的 parse_increment 必须拒绝",
            );
        }
    }
}
