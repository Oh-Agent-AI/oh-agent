//! SourceGraph 纯策略面（AGENT_VITALS_SOURCE_GRAPH_INFRASTRUCTURE_SPEC §4-§6）。
//!
//! P3 从 runtime 下沉：执行环境 crate 要实现 `SourceParser`，而依赖方向是
//! runtime → harnesses，trait 必须住在共同下游 domain。这里只装**纯数据 + 纯判定 +
//! 插件位契约**：
//! - `FileCheckpoint` / `Invalidation` / `classify` — 软硬失效判定（spec §6 表）；
//! - `SourceParser` / `ParserDescriptor` / `ParseContext` / `ParseOutput` —
//!   解析器插件位契约（spec §5.2）；
//! - `PARSER_VERSION` — 事实解析器世代号（sql_sync 的重放纪律共用）。
//!
//! **不装**：SQL 封装（read/advance/mark_dirty/dirty_set 在 runtime，data 访问）、
//! 执行环境 wire 解释（`agent-vitals-harnesses::parsers` 注册表，spec §11 非目标明文
//! 「不在 infra 里做任何执行环境 wire 解释」）、watcher（P2 notify）。
//!
//! 语义纪律（spec §1.3）：offset 只由解析成功的事务推进——半途崩溃 offset 不动，
//! 下轮重读同一段，fact_id 幂等吸收。与 outbox §1.2 同一条教训。

use serde_json::Value;

use crate::contracts::source_identity::fnv1a64_hex;
use crate::contracts::workflow::{SessionExcerpt, SessionTitle, WorkflowEvent};

/// `source_files.parser_version`。版本 2 增加了 workflow_events 的派生提取；
/// 即使源文件指纹不变，也必须重放一次，才能把历史源补齐到 workflow authority。
/// 语义与 `usage_fact.rs::CURRENT_SCHEMA_VERSION` 的演进纪律一致。
///
/// 版本 3（自动归因规格 A3）：claude-code emitter 开始产 L1 路由证据
/// （`attribution_version` provider-v0.11 → provider-v1.0-beta.1）。存量事实的
/// `provider_id/evidence_basis/route_evidence_id` 只有在源文件被重放时才会经
/// `fact_writer_sql` 的版本重分类路径改写——不升这个号，历史 25k+ 条 claude 事实
/// 会永远停在 `missing`，列表照旧全部推给用户。
///
/// 版本 4（V16 内容富化，2026-09-19 政策）：claude-code emitter 开始产任务
/// 意图摘录（`session_excerpts`）与 workflow 富化列（错误/参数摘录、尺寸、
/// uuid/行号/偏移锚点）。不升这个号，存量 claude 源不重放，182k+ 事件行的
/// 新列永远 NULL——回填依赖 `insert_events` 的守卫式 upsert（只补 NULL 列）。
///
/// 版本 5（WORKBENCH_FINDINGS_TAB_SPEC §9.4-①）：claude-code emitter 修复
/// skill_finished 的 outcome 信号——skill 的 tool_result 不带 is_error，改读
/// record 级 `toolUseResult.success`。历史行的纠正走 `insert_events` 的派生列
/// upsert（provenance 保持原样）；不升这个号，v4 重放时仍为 unknown 的
/// skill_finished 行不会因指纹未变而被再次触达。
///
/// 版本 6（SESSION_TRACE_DIAGNOSTICS_SPEC r6 P0）：claude-code 每条用户请求开
/// 一个回合（此前整个会话只有首条 `task_started`，G6），用户中断产
/// `task_finished{cancelled}`；claude / codex 的 `invocation_fingerprint` 从
/// 「工具名」改为「工具名 + 规范化参数」（存量行经 `insert_events` 的派生列
/// 纠正改写）；claude 增量轮开始重扫 workflow（此前增量轮不产 workflow，活跃
/// 会话尾部的工具结果与回合永远缺席）；codex 的能力名取可执行文件末段
/// （`/bin/zsh` → `zsh`，路径不进权威表）。重放时 `insert_events` 的派生列纠正
/// 连带改写 `invocation_fingerprint` / `event_ts_ms` / `capability_id` / 锚点。
/// 不升这个号，存量源不重放，上述各点都只对新文件生效。
pub const PARSER_VERSION: i64 = 6;

/// P0 阶段的解析器标记——sync_harness 与 advance_checkpoint 共用（失配会导致
/// 每 tick 永久全量重扫，已被 sync_is_incremental_across_runs 钉住，但共享
/// 常量从源头消灭失配面）。P1 增量解析器接入后逐执行环境替换为各自 id
/// （claude-code → `claude-jsonl-v1`）；保持全量路径的执行环境（codex 批 emitter /
/// dsh zstd / workbuddy sqlite）继续以本 id 落检查点。
pub const FULL_PARSE_V0: &str = "full-parse-v0";

/// 文件的 SourceGraph 检查点（`source_files` 行的投影，加上 stat 现值）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FileCheckpoint {
    pub source_id: String,
    pub harness: String,
    pub path_hash: String,
    /// 磁盘当前值（stat）
    pub size_bytes: u64,
    pub mtime_ns: u64,
    /// 上次成功处理的字节位置；`None` = 首见或不支持增量。
    pub byte_offset: Option<u64>,
    /// 负责此文件的解析器身份；`None` = 尚未被 SourceGraph 路径处理。
    pub parser_id: Option<String>,
    pub parser_version: i64,
    pub dirty: bool,
}

/// 软硬失效判定结果（spec §6，映射 Vite 的 graded invalidation）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Invalidation {
    /// 软失效（Vite "soft"）：append-only 增量可从 offset 续读。
    Incremental { from_offset: u64 },
    /// 硬失效（Vite "hard"/full-reload）：offset 作废，全量重读。
    Full {
        /// 截断、轮转、parser 升版或首见等原因标记（进 last_error 供诊断）。
        reason: &'static str,
    },
    /// 未变：指纹完全匹配，跳过。
    Unchanged,
}

/// 判定一个文件的失效等级（spec §6 表）。纯函数：只读 checkpoint 与磁盘现值。
///
/// **can_increment 是解析器的申报**（P0 阶段恒 false——没有增量解析器注册时，
/// 所有文件走全量路径）。本函数只把"物理上可增量"与"解析器申报可增量"合取。
pub fn classify(
    checkpoint: &FileCheckpoint,
    on_disk: Option<(u64, u64)>, // (size, mtime_ns)
    can_increment: bool,
    expected_parser_id: &str,
    expected_parser_version: i64,
) -> Invalidation {
    let Some((disk_size, disk_mtime)) = on_disk else {
        return Invalidation::Full { reason: "file-vanished" };
    };
    // F2（P1 交接雷）：parser_id 不匹配（含 full-parse-v0 旧行）→ 硬失效。
    // P0 把 offset 推到 stat size（非换行边界），P1 增量解析器直接按
    // Incremental 续读会从行中间起读、静默丢事实。硬失效一次让 P1 全量
    // 重放对齐（fact_id 幂等吸收，代价一次性）。
    // **检查顺序**：先于 parser_version——首见文件（id=None, version=0）
    // 否则会误报 "parser-version-bumped"（复跑发现：reason 是诊断面，
    // id 缺失比版本不匹配更准确地描述"这是新文件"）。
    if checkpoint.parser_id.as_deref() != Some(expected_parser_id) {
        return Invalidation::Full { reason: "parser-id-mismatch" };
    }
    // F1（P1 接线雷）：parser 升版 → 硬失效，文件字节不变也要全量重放
    // （spec §6 明文行）。旧代码只比 (size, mtime, dirty)，升级会被 Unchanged 吞。
    if checkpoint.parser_version != expected_parser_version {
        return Invalidation::Full { reason: "parser-version-bumped" };
    }
    if disk_size == checkpoint.size_bytes && disk_mtime == checkpoint.mtime_ns
        && !checkpoint.dirty
    {
        return Invalidation::Unchanged;
    }
    if !can_increment {
        return Invalidation::Full { reason: "parser-refused-increment" };
    }
    // byte_offset None 但 parser_id 匹配（理论上 P1 接管后不该出现——
    // advance 总是写 offset；防御性全量处理）。
    let Some(offset) = checkpoint.byte_offset else {
        return Invalidation::Full { reason: "first-seen" };
    };
    if disk_size < offset {
        return Invalidation::Full { reason: "truncated" };
    }
    Invalidation::Incremental { from_offset: offset }
}

/// 增量文件的检查点覆写——由 emit 层产、写事务消费（B1 修复：写路径不再
/// 无条件推 FULL_PARSE_V0 + stat size，而是尊重增量解析器给出的换行边界与
/// parser_id）。
pub struct SourceCheckpointOverride {
    pub parser_id: String,
    pub byte_offset: Option<u64>,
}

/// path → path_hash（与 sql_sync 的 source_file_fingerprint 同一哈希——
/// 不暴露本地路径进 SQL 索引）。
pub fn path_hash(path: &std::path::Path) -> String {
    fnv1a64_hex(path.to_string_lossy().as_bytes())
}

/// 解析产出（M2 决议后的冻结形状）：三个面 + 新 offset。
///
/// **facts** 是与 emit 产出的 flat fact JSON 同构的 `Vec<Value>`（与
/// `write_flat_facts_with_sources` 的 `facts: &[Value]` 同一形态）。
///
/// **workflow_events / session_excerpts**：增量轮允许通过全文件幂等重扫
/// 填充（workflow 解析器有跨行状态——tool_use 配对、model_switched——
/// 真增量需状态传递，成本不成比例；全扫的 event_id 幂等吸收重复）。
/// 调度器把三个面一并交给既有写入路径。
///
/// **new_offset** 是换行边界（不是 stat size——与 P0 full-parse-v0 语义
/// 不同，见 classify 的 F2 注释）。全量-only 执行环境（无增量能力）的
/// `new_offset` 无语义，落 0、调度器不覆写检查点。
pub struct ParseOutput {
    pub facts: Vec<Value>,
    pub workflow_events: Vec<WorkflowEvent>,
    pub session_excerpts: Vec<SessionExcerpt>,
    /// 会话标题（解析产出的那一族：claude-code 的 ai-title 记录）。索引型
    /// 标题（codex `session_index.jsonl` / DSH `workspace.json`）不走这里——
    /// 它们与单文件无关，由 sync 的侧车索引趟直接喂标题写入路径。
    pub session_titles: Vec<SessionTitle>,
    pub new_offset: u64,
}

/// 解析器描述符（注册表的行）：身份 + 能力申报。发现层（skip vs 处理）与
/// emit 层（增量 vs 全量）都以此为唯一依据——runtime 不允许出现 harness 字符串
/// 特判的解析路由（P3 收编目标）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParserDescriptor {
    pub parser_id: &'static str,
    pub can_increment: bool,
}

/// 逐文件解析的调用上下文。machine_namespace 是事实身份的必需盐
/// （所有 emitter 都要）；source_profile 是执行环境内 profile 隔离键。
pub struct ParseContext<'a> {
    pub machine_namespace: &'a str,
    pub source_profile: &'a str,
}

/// SourceParser 插件位（spec §5.2 冻结接口，P3 起由执行环境 crate 实现）。
/// **逐文件**语义；跨批 emitter（codex 的整批折叠 + 跨文件去重）装不进这个
/// 形状，走 descriptor 申报 + 独立批路径。
///
/// `can_increment` 的判定条件（trait 文档即契约，spec §12「解析器谎报」守卫）：
/// 文件是 append-only JSONL（或等价的字节追加语义）、且检查点里已有本解析器
/// 写下的换行边界 offset。缺一不可——descriptor 申报能力，checkpoint 提供
/// 起读位置。
pub trait SourceParser: Send + Sync {
    /// 注册行：解析器身份 + 增量能力申报。
    fn descriptor(&self) -> ParserDescriptor;

    /// 事实解析器世代号。缺省 = 当前 `PARSER_VERSION`（derive 世代是全局的，
    /// 与 sql_sync 的重放纪律同一来源）；个别解析器如需独立升版再覆写。
    fn parser_version(&self) -> i64 {
        PARSER_VERSION
    }

    /// 增量能力判定（按文件当前检查点，不许猜测）。缺省 =
    /// descriptor 申报可增量 **且** 检查点已有起读 offset。
    fn can_increment(&self, state: &FileCheckpoint) -> bool {
        self.descriptor().can_increment && state.byte_offset.is_some()
    }

    /// 从 offset 读到 EOF、停在最后完整换行。缺省拒绝——全量-only 解析器
    /// 不需要实现（调度器只在 `can_increment` 为真时调用本方法）。
    fn parse_increment(
        &self,
        ctx: &ParseContext,
        path: &std::path::Path,
        from_offset: u64,
    ) -> Result<ParseOutput, String> {
        let _ = (ctx, path, from_offset);
        Err("parser did not register an incremental path".to_string())
    }

    /// 全量路径（首见/硬失效/不支持增量）。
    fn parse_full(&self, ctx: &ParseContext, path: &std::path::Path) -> Result<ParseOutput, String>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 软/硬/未变三路判定（spec §6 表逐行覆盖 + F1/F2 P1 接线雷钉死）。
    #[test]
    fn classify_covers_incremental_full_unchanged() {
        let cp = FileCheckpoint {
            size_bytes: 100,
            mtime_ns: 1000,
            byte_offset: Some(100),
            parser_id: Some("jsonl".into()),
            parser_version: 5,
            dirty: false,
            ..FileCheckpoint::default()
        };
        let args = ("jsonl", 5i64); // (expected_parser_id, expected_parser_version)
        // 未变（含 dirty=false）
        assert_eq!(classify(&cp, Some((100, 1000)), true, args.0, args.1),
            Invalidation::Unchanged);
        // 软：size 增长 + can_increment + offset 已建
        assert_eq!(classify(&cp, Some((200, 2000)), true, args.0, args.1),
            Invalidation::Incremental { from_offset: 100 });
        // 硬：size < offset（截断）
        assert_eq!(classify(&cp, Some((50, 2000)), true, args.0, args.1),
            Invalidation::Full { reason: "truncated" });
        // 硬：can_increment = false（F5 分拆：与首见不同 reason）
        assert_eq!(classify(&cp, Some((200, 2000)), false, args.0, args.1),
            Invalidation::Full { reason: "parser-refused-increment" });
        // 硬：文件消失
        assert_eq!(classify(&cp, None, true, args.0, args.1),
            Invalidation::Full { reason: "file-vanished" });
        // 硬：首见（无 offset，F5 分拆：独立 reason）
        let first_seen = FileCheckpoint { parser_version: 5, ..FileCheckpoint::default() };
        // 首见 + 旧库 None 行在 classify 眼里同判 parser-id-mismatch（都是「不知道
        // 谁负责此文件」→ 交给请求者全量处理）；与「有 id 但不是我的」共用同一
        // reason 语义等价——动作都是全量、由请求者接管。
        assert_eq!(classify(&first_seen, Some((100, 1000)), true, args.0, args.1),
            Invalidation::Full { reason: "parser-id-mismatch" });
        // dirty=true 即便指纹相同也不算 Unchanged
        let dirty_cp = FileCheckpoint { dirty: true, ..cp.clone() };
        assert_eq!(classify(&dirty_cp, Some((100, 1000)), true, args.0, args.1),
            Invalidation::Incremental { from_offset: 100 });
        // F1：parser_version 不匹配 → 硬失效（即便指纹全同、非 dirty）
        let bumped = FileCheckpoint { parser_version: 4, ..cp.clone() };
        assert_eq!(classify(&bumped, Some((100, 1000)), true, args.0, args.1),
            Invalidation::Full { reason: "parser-version-bumped" },
            "解析器升版必须硬失效，Unchanged 不得吞掉（spec §6 明文行）");
        // F2：parser_id 不匹配（含 full-parse-v0 旧行）→ 硬失效
        let v0_row = FileCheckpoint {
            parser_id: Some("full-parse-v0".into()),
            ..cp.clone()
        };
        assert_eq!(classify(&v0_row, Some((200, 2000)), true, args.0, args.1),
            Invalidation::Full { reason: "parser-id-mismatch" },
            "P0 旧行的 offset 是 stat size 非换行边界，增量解析器不得直接续读");
        // F2 补：parser_id 为 None（旧库 v23 行）同样硬失效
        let none_id = FileCheckpoint { parser_id: None, ..cp.clone() };
        assert_eq!(classify(&none_id, Some((200, 2000)), true, args.0, args.1),
            Invalidation::Full { reason: "parser-id-mismatch" });
    }

    /// 全量-only 解析器（descriptor.can_increment=false）：缺省 can_increment
    /// 恒 false，parse_increment 走缺省拒绝——「解析器谎报」守卫的正面。
    #[test]
    fn full_only_parser_defaults_refuse_increment() {
        struct StubFull;
        impl SourceParser for StubFull {
            fn descriptor(&self) -> ParserDescriptor {
                ParserDescriptor { parser_id: FULL_PARSE_V0, can_increment: false }
            }
            fn parse_full(&self, _ctx: &ParseContext, _path: &std::path::Path)
                -> Result<ParseOutput, String> {
                Ok(ParseOutput {
                    facts: Vec::new(),
                    workflow_events: Vec::new(),
                    session_excerpts: Vec::new(),
                    session_titles: Vec::new(),
                    new_offset: 0,
                })
            }
        }
        let ctx = ParseContext { machine_namespace: "ns", source_profile: "default" };
        // 即便检查点有 offset（残留/伪造），申报不可增量 → 判 false
        let forged = FileCheckpoint { byte_offset: Some(42), ..FileCheckpoint::default() };
        assert!(!StubFull.can_increment(&forged),
            "descriptor 申报 false 时缺省判定必须恒 false（不许猜）");
        assert!(StubFull.parse_increment(&ctx, std::path::Path::new("/x"), 0).is_err(),
            "未实现增量路径的解析器必须拒绝而非静默全量");
        assert_eq!(StubFull.parser_version(), PARSER_VERSION,
            "缺省世代号 = 全局 PARSER_VERSION");
    }

    /// 增量申报但检查点无 offset（首见）：缺省判定 false——没有起读位置
    /// 就没有增量，即便 descriptor 申报了能力。
    #[test]
    fn increment_descriptor_without_checkpoint_offset_is_full() {
        struct StubInc;
        impl SourceParser for StubInc {
            fn descriptor(&self) -> ParserDescriptor {
                ParserDescriptor { parser_id: "stub-inc-v1", can_increment: true }
            }
            fn parse_full(&self, _ctx: &ParseContext, _path: &std::path::Path)
                -> Result<ParseOutput, String> {
                unimplemented!("本测试只判 can_increment")
            }
        }
        let first_seen = FileCheckpoint::default();
        assert!(!StubInc.can_increment(&first_seen),
            "首见（无 offset）必须走全量引导，增量不得凭空起读");
        let with_offset = FileCheckpoint { byte_offset: Some(10), ..FileCheckpoint::default() };
        assert!(StubInc.can_increment(&with_offset));
    }
}
