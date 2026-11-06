//! WorkBuddy 适配器的 "derive → coverage" 两段（五段式流水线 locate → shape →
//! extract → derive → coverage，"locate → shape → extract" 留在
//! `src/agent/workbuddy_session.rs`，I/O 不在这里）。它把
//! `~/.workbuddy/audit-log/*.jsonl` 里按 `sessionId` 分组出的原始记录 + db/file-history
//! 拆出的 `session_meta` 折成 `evidence::CanonicalSession`，覆盖计数按
//! `docs/WORKBUDDY_INTEGRATION.md` §3 矩阵逐信号对应。
//!
//! 与 Python `scripts/agent_vitals/agent/workbuddy_evidence.py` 逐字节对齐——产出同一个
//! `workbuddy_evidence_json` 输出字典（键序一致），`tests/test_cli_matrix.py::both()`
//! 的差分靠这份一致把关。
//!
//! **audit-log 只喂三条 timeline（approvals/sandbox_modes 非空，turns 恒空）。** 五条
//! timeline 里：`tool_calls` 只有 bash 子集（`command-safety.sandbox-executed` 的
//! `commandPreview`）+ `web_fetch`（`network`+`WebFetch` 的 `messageParams.target`）可
//! join——write/edit 只在匿名 traces 里（spec §3）；`approvals` 由
//! `approval`/`rejection`+`Bash`、`file-safety`+`bulk-delete.*` 喂（spec §7 决策映射）；
//! `sandbox_modes` 由 `command-safety.sandbox-executed` 喂（mode = WorkBuddy
//! 原生的 `permission_mode`，**不翻译成 DSH 的 danger-full-access**，spec §3.3）；
//! `turns` **恒空**——没有 turn 结构，把 distinct requestId 硬填成 turn 就是发明不存在
//! 的边界，SV612/613 靠 `timeline_is_empty` 诚实 Unavailable（spec §8）。
//!
//! **决策映射不双计。** 审批/拒绝记录只进 approvals 轴；sandbox-executed 才进
//! tool_calls + sandbox 轴。被批准的命令是否另有执行记录不可靠，两条记录之间不做
//! join（spec §7）。
//!
//! **audit-log 按 `sequence` 排序。** 记录可能来自多个并发 spool 文件，`sequence` 是
//! 执行环境原生顺序（实测有跳号，来自并发写）。排序键 = `(sequence or MAX, 文件内序)`；
//! 输出 `seq` = 排序后的下标（会话内序，同 Claude 的 `seq = ordinal` 惯例）。
//!
//! **`session_meta` 携带 db/file-history 拆出的会话级数据**（I/O 层拆好传进来）：
//! `permission_mode/use_sandbox_cli/model/cwd/used/credit_json/file_mutations/title`。
//! db 缺失的列 → 对应信号降级 Unavailable（缺列报缺，编列害人），绝不编一个非零数字
//! 出来。

use std::collections::HashSet;

use serde_json::Value;

use agent_vitals_domain::domain::budget::parse_iso;
use agent_vitals_domain::contracts::evidence::{
    AdapterNote, ApprovalAsked, ApprovalDecided, ApprovalObservation, CanonicalSession,
    Coverage, CoverageCounts, Provenance, SandboxModeObservation, SessionMeta, Signal, SignalSet,
    SourceAttempt, SourceKind, Surface, Timeline, TimelineEntry, ToolCallObservation,
    ToolResultObservation, TurnObservation,
};

/// 会话级元数据（I/O 层 `src/agent/workbuddy_session.rs` 从 db/file-history 拆好传进来）。
/// db 缺失的列是 `None`——缺列报缺，绝不编一个非零数字出来（spec §3 矩阵）。
pub struct WorkbuddySessionMeta {
    pub permission_mode: Option<String>,
    pub use_sandbox_cli: Option<i64>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub used: Option<i64>,
    pub credit_json: Option<String>,
    pub file_mutations: u64,
}

/// WorkBuddy 适配器一次审计的产物：`CanonicalSession` + 它派生自的原始记录。
pub struct WorkbuddyEvidence {
    pub canonical: CanonicalSession,
    pub raw_records: Vec<Value>,
}

/// 20 个 Signal 的声明序——`signals` 数组 / `coverage` 字典的输出顺序都靠这份显式
/// 表对齐（与 Python `workbuddy_evidence.py::ALL_SIGNALS` 同表同序），不靠 Rust 的
/// Debug 序。与 claude_code_evidence / codex_evidence 同一张表。
const ALL_SIGNALS: &[Signal] = &[
    Signal::ToolCalls,
    Signal::ToolResults,
    Signal::TurnBoundaries,
    Signal::StepBoundaries,
    Signal::Usage,
    Signal::UsageAggregate,
    Signal::ContextWindow,
    Signal::QuotaConsumption,
    Signal::ApprovalDecisions,
    Signal::ApprovalPolicy,
    Signal::SandboxModes,
    Signal::SandboxPolicy,
    Signal::NetworkAccess,
    Signal::Compaction,
    Signal::SubagentSpawns,
    Signal::SkillInvocations,
    Signal::Hooks,
    Signal::FileMutations,
    Signal::UserPrompts,
    Signal::UserCorrections,
];

/// audit-log 已知的 (category, eventType) 对——**WorkBuddy 自己的决策轴就是
/// category**（轴名 + 全限定 eventType），真机词表（2026-09-02 全量 2,563 条实测）：
/// 命令进沙箱 `command-safety`+`command-safety.sandbox-executed`、网页抓取
/// `network`+`WebFetch`、批量删除 `file-safety`+`file-safety.bulk-delete.*`、
/// 审批/拒绝 `approval`/`rejection`+`Bash`。其余对记成 `SourceAttempt`，绝不当作
/// 损坏吞掉——审计账本可能还有没被本机语料触发的路径，吞掉就是假装账本干净。
///
/// 曾用纸面词表（'sandbox-executed'/'commandApproved'/'bulk-delete.*' 裸名）当
/// 白名单——真机零命中，2,471/2,563 条记录全被当 unknown 丢掉（ToolCalls 只剩
/// WebFetch 的 75 条），差分门禁过了是因为 fixture 写的也是纸面词。§14.4 的
/// schema-drift sentinel（skipped and recorded）当时照实报了 attempts——哨兵没
/// 错，错在白名单本身。分类键必须用执行环境自己的判别器，见
/// docs/WORKBUDDY_INTEGRATION.md §2.2 的漂移注记。
const KNOWN_EVENT_TYPES: &[(&str, &str)] = &[
    ("command-safety", "command-safety.sandbox-executed"),
    ("network", "WebFetch"),
    ("file-safety", "file-safety.bulk-delete.needs-approval"),
    ("file-safety", "file-safety.bulk-delete.approved"),
    ("file-safety", "file-safety.bulk-delete.rejected"),
    ("approval", "Bash"),
    ("rejection", "Bash"),
];

/// spec §3 明确 unavailable / 没有对应列的信号（WorkBuddy 列）。`derive_coverage`
/// 的置零与 `workbuddy_evidence_json` 的 `available` 标记共用这一份清单，不准两处
/// 各写一份漂移。
///
/// - ToolResults / SubagentSpawns **不在**这个集合里（spec §9E.5 E2，2026-09-11）：
///   traces 可按 `trace.sessionId` 归属（B2），function span 的 status/error →
///   tool_results，agent span → SubagentSpawns。此前「接不进 session」是 09-02 的
///   分析错误；
/// - TurnBoundaries **不在**这个集合里——它按 distinct requestId 派生 coverage
///   （lossy 下界，available=true），但 turns timeline 恒空（spec §8）；
/// - Usage：无逐请求 token（traces 只有 trace 级 totalTokens）；UsageAggregate
///   反而 measured（session_usage.used，spec §9）；
/// - SandboxPolicy：use_sandbox_cli 是常量（恒 1），不是结构化策略事件；
/// - QuotaConsumption **不在**这个集合里（spec §10 B6，2026-09-11）：`credit_json`
///   的每个 requestId 条目就是一次「执行环境报告的配额消耗」——分子 measured；分母
///   （allowance/余额）在服务端账户面、本机不可观测，由 note 说明，不出百分比。
///   此前把它声明成 unavailable 是错的——那是「有证据却不计」，`evidence.rs`
///   「适配器不得刷覆盖」纪律的反面（不得**压**覆盖）。§13 矩阵文档滞后，
///   按 G5 流程在 `tests/test_harness_contract.py::_REGISTERED_DEVIATIONS` 登记；
/// - SubagentSpawns / SkillInvocations / Hooks / UserPrompts / UserCorrections /
///   ContextWindow / StepBoundaries / Compaction：只存于 traces（可按
///   `trace.sessionId` 归属但现有实现未接，Phase E）或根本不在会话面上。
fn is_unavailable(signal: Signal) -> bool {
    matches!(
        signal,
        Signal::StepBoundaries
            | Signal::Usage
            | Signal::ContextWindow
            | Signal::SandboxPolicy
            | Signal::Compaction
            | Signal::SkillInvocations
            | Signal::Hooks
            | Signal::UserPrompts
            | Signal::UserCorrections
    )
}

// 各 note 的说明文本——与 Python 逐字节相同，差分测试靠它。
const TURN_BOUNDARY_NOTE: &str = "turn boundaries are derived from distinct audit-log \
requestId (a lower bound: audit-log is not a per-request ledger); native turn structure is \
absent, so SV612/613 are Unavailable, never fabricated boundaries.";
const SANDBOX_MODE_NOTE: &str = "sandbox mode is the WorkBuddy-native permission_mode \
(bypassPermissions / fullAccess); the DSH danger-full-access vocabulary does not apply, so \
SV610 is an honest MeasuredZero, never a translation.";
// spec §9E.5 E2/E3：traces 已按 `trace.sessionId` 归属并折进 timeline（B2 推翻了
// 「session-anonymous」）。**Bash function span 永不进 tool_calls**（E3 裁决，2026-09-11
// 真机实测）：audit-log 的 `toolCallId`（`call_00_…`）与 span 的 `spanId`（`span_…`）
// 是两套命名空间，0/2,398 可 join；audit-log sandbox-executed 2,398 条 vs Bash span
// 1,661 个——traces 按 worker pid 存、会轮转丢失，少了约 30%；命令文本只 59% 相等，
// 模糊 join 就是猜。所以 audit-log（hash 链安全账本、更完整）是 Bash 唯一源，span 的
// Bash 并进去只会双计 SV601–603/SV611（Codex `custom_tool_call` vs `CommandExecution`
// 同款影子问题）。代价如实：Bash 的 status/duration 只在 span 里，无键可挂到
// tool_calls → Bash 没有 tool_results。与 Python 逐字节相同。
const TRACES_FOLDED_NOTE_PREFIX: &str = "traces folded via trace.sessionId: ";
// spec §10 B6：分子可测、分母不可观测——只报绝对量，不出百分比（§6.6「无法证明
// 完整时不编百分比」同款）。与 Python 逐字节相同。
const QUOTA_CONSUMPTION_NOTE: &str = "quota consumption is measured from credit_json \
entries (one per billed request); the allowance / balance that would give a percentage \
lives on the account plane and is not observable on this machine, so only the absolute \
consumption is reported";

/// §7 工具名规范化（与 claude_code_evidence.rs 同一张表，WorkBuddy 的 toolName 是
/// 同一套 PascalCase）。未映射的原样透传——规则不认、诚实 MeasuredZero，不误报。
/// **Bash 不在这里处理**：E2 把 Bash span 排除在 tool_calls 之外（见 populate）。
fn normalize_span_tool_name(name: &str) -> String {
    match name {
        "Write" => "write".to_string(),
        "Edit" | "MultiEdit" => "edit".to_string(),
        "Read" => "read".to_string(),
        "Glob" => "glob".to_string(),
        "Grep" => "grep".to_string(),
        "WebFetch" => "web_fetch".to_string(),
        "WebSearch" => "web_search".to_string(),
        "Task" => "task".to_string(),
        other => other.to_string(),
    }
}

/// span 的 ISO 毫秒串（`2026-08-14T23:49:18.442Z`）→ unix 秒。走 `parse_iso` 的字符串
/// 路径（A2）；解不出 → None（不猜）。
fn span_time(span: &Value) -> Option<i64> {
    span.get("started_at")
        .and_then(Value::as_str)
        .and_then(parse_iso)
        .map(|(secs, _)| secs)
}

/// spans 的确定性顺序：`(started_at, span_id)`——同一毫秒内多个 span 靠 span_id 定序。
fn sort_spans(spans: &[Value]) -> Vec<&Value> {
    let mut v: Vec<&Value> = spans.iter().filter(|s| s.is_object()).collect();
    v.sort_by(|a, b| {
        let ka = (
            a.get("started_at").and_then(Value::as_str).unwrap_or(""),
            a.get("span_id").and_then(Value::as_str).unwrap_or(""),
        );
        let kb = (
            b.get("started_at").and_then(Value::as_str).unwrap_or(""),
            b.get("span_id").and_then(Value::as_str).unwrap_or(""),
        );
        ka.cmp(&kb)
    });
    v
}

/// 一条 timeline entry 的构造器。`turn`/`step` 恒 None——WorkBuddy 无 turn/step
/// 结构；`time` = audit-log timestamp 归一后的 unix 秒（字符串走 `parse_iso`、
/// 整数/浮点按 epoch 毫秒解释，见 `parse_time`；无效则 None）。
/// 所有 entry 都是 `Measured`——它们来自真实 audit-log 记录，不是 derive 出来的。
fn timeline_entry<T>(
    observation: T,
    seq: Option<i64>,
    time: Option<i64>,
    call_id: Option<String>,
    ordinal: usize,
) -> TimelineEntry<T> {
    TimelineEntry {
        observation,
        provenance: Provenance::Measured,
        seq,
        time,
        turn: None,
        step: None,
        call_id,
        ordinal,
    }
}

/// 取下一个 entry 唯一序号并递增。五条 timeline 共用一把递增（`evt-{ordinal}`
/// 契约）：一条记录可以产多条 entry（sandbox-executed → tool_calls + sandbox），
/// 用记录序当 ordinal 会撞号。
fn take_ordinal(next: &mut usize) -> usize {
    let o = *next;
    *next += 1;
    o
}

fn text(record: &Value, key: &str) -> String {
    record.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// audit-log `sequence` 字段 → int（int 或数字字符串），否则 None。只认纯 ASCII
/// 数字，与 `claude_code_evidence` 的 `_num` 同纪律（不宽容出 Rust 不会给的值）；
/// 非对象记录 → None（排序兜底，不崩溃）。
fn seq_of(record: &Value) -> Option<i64> {
    let obj = record.as_object()?;
    match obj.get("sequence") {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s))
            if !s.is_empty() && s.is_ascii() && s.bytes().all(|b| b.is_ascii_digit()) =>
        {
            s.parse().ok()
        }
        _ => None,
    }
}

/// 按 `(sequence or MAX, 文件内序)` 排序。并发 spool 写的跳号不影响顺序；
/// 缺 sequence 的记录排最后、内部保输入序。返回 `(文件内序, 记录)`。
///
/// 负 sequence 按缺处理（排最后）——`seq as u64` 会把负 i64 回绕成巨大正数，
/// 与 Python（负 int 自然排最前）排序相反，是「同一字典」的一个隐藏分歧
/// （评审 P3-7）；`u64::try_from(s).ok()` 让两侧一致地把负值当缺失。
fn sort_records(records: &[Value]) -> Vec<(usize, &Value)> {
    let mut indexed: Vec<(usize, &Value)> = records.iter().enumerate().collect();
    indexed.sort_by_key(|(idx, rec)| {
        (seq_of(rec).and_then(|s| u64::try_from(s).ok()).unwrap_or(2_u64.pow(63)), *idx)
    });
    indexed
}

/// sandbox-executed 的完整 bash 命令 → SV601-603 的 args_text（spec §3）。
fn command_preview(record: &Value) -> String {
    text(record, "commandPreview")
}

/// WebFetch 的 `messageParams.target` URL → SV606 的 args_text。
fn target_of(record: &Value) -> String {
    record
        .get("messageParams")
        .and_then(|p| p.get("target"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// 审批/拒绝记录的 `messageKey` → `ApprovalAsked.reason`（spec §7）。
fn message_key(record: &Value) -> String {
    text(record, "messageKey")
}

/// (category, eventType) 对——分类键。WorkBuddy 的记录 schema 里 category 就是
/// 决策轴（command-safety / network / file-safety / approval / rejection），
/// eventType 是轴内路径（真机实测：命令类是 `command-safety.sandbox-executed`
/// 全限定名，审批类是裸工具名 `Bash`）。按对键分类才用得上执行环境自己的判别器；
/// 只按 eventType 裸词建白名单正是 2026-09-02 真机事故的根源（见 KNOWN_EVENT_TYPES
/// 的漂移注记）。
fn record_key(record: &Value) -> (String, String) {
    (text(record, "category"), text(record, "eventType"))
}

/// 审批记录的 tool_name：approval/rejection 轴（真机 eventType='Bash'）→ bash；
/// file-safety 批量删除 → bulk_delete。旧实现按 `startswith('command')` 猜
/// eventType——真机审批记录是裸 `Bash`，会被错标成 bulk_delete。
fn approval_tool(record: &Value) -> String {
    if matches!(text(record, "category").as_str(), "approval" | "rejection") {
        "bash".to_string()
    } else {
        "bulk_delete".to_string()
    }
}

/// epoch 秒的固定合法性窗口下界 —— `2000-01-01T00:00:00Z`。
const WB_TS_MIN_SECS: i64 = 946_684_800;
/// epoch 秒的固定合法性窗口上界（半开）—— `2100-01-01T00:00:00Z`。
///
/// `sources/mod.rs::normalize_wb_ts` 那侧在 `/sources` 层、能读时钟，用的是
/// `now + 24h` 上界。这里是纯 crate（可链进 wasm）、**读不了时钟**，所以退一步
/// 用固定的 2100 上界——spec §10 A6 明写「纯层用固定上下界，不用 now 窗口」。
const WB_TS_MAX_SECS: i64 = 4_102_444_800;

/// audit-log `timestamp` → 该 entry 的 `time`（`TimelineEntry.time` 是 unix
/// 秒 `Option<i64>`，不是 ISO 串）。
///
/// **字符串**走既有 `parse_iso` 路径，**原样不回归**（其他执行环境与旧 fixture 的
/// ISO 串形状不变）。**整数/浮点**按 epoch **毫秒**解释——真机
/// `~/.workbuddy/audit-log/*.jsonl` 的 `timestamp` 是 13 位 epoch-ms 整数
/// （2026-09-10 实测），旧实现只收 `Value::as_str`、整数一律读成 None，于是有
/// findings 的会话里每条 finding 的 `time` 都是 null。floor-除 1000 归一到秒，
/// 与 `sources/mod.rs::normalize_wb_ts` 同一公式（`i64::div_euclid(1000)` /
/// `(f / 1000.0).floor()`），不另发明第二套。
///
/// 合法性窗口是**固定**的 `[2000-01-01, 2100-01-01)`（见 `WB_TS_MAX_SECS`
/// doc：纯层读不了时钟）。窗口外 → `None`；纯层没有 `attempts` 汇——只 null，
/// 与今天非字符串输入的行为一致（越界进 attempts 的那条纪律留在 `/sources`）。
///
/// **不做「10 位当秒、13 位当毫秒」的位数嗅探**（spec §6.2 rule 5）：真机只
/// 观测到毫秒，在没有证据的地方发明秒/毫秒判别会把 2001 年的毫秒戳误当 1970
/// 年的秒戳。bool / null / object / 字段缺失 → `None`。
fn parse_time(record: &Value) -> Option<i64> {
    match record.get("timestamp") {
        Some(Value::String(s)) => parse_iso(s).map(|(secs, _)| secs),
        Some(Value::Number(n)) => {
            let secs = match n.as_i64() {
                Some(i) => i.div_euclid(1000),
                None => {
                    let f = n.as_f64()?;
                    if !f.is_finite() {
                        return None;
                    }
                    (f / 1000.0).floor() as i64
                }
            };
            (WB_TS_MIN_SECS..WB_TS_MAX_SECS).contains(&secs).then_some(secs)
        }
        _ => None,
    }
}

/// audit-log `prevHash→hash` 链的完整性 note（spec §2.3/§4）。只做**结构校验**
/// （`records[i+1].prevHash == records[i].hash`），不重算 hash 算法。轮转诚实
/// 标注：首条 prevHash 非空且匹配不到任何记录 → 「最老记录可能被轮转，链从
/// seq=F 起验证」。头 prevHash 空 = 该记录是已知起点（干净链）。
fn chain_note(records: &[Value]) -> Option<String> {
    let mut seqs: Vec<(usize, i64, &Value)> = Vec::new();
    for (idx, rec) in sort_records(records) {
        if !rec.is_object() {
            continue;
        }
        let seq = seq_of(rec);
        seqs.push((idx, seq.unwrap_or(idx as i64), rec));
    }
    if seqs.is_empty() {
        return None;
    }
    let first_seq = seqs[0].1;
    if seqs.len() == 1 {
        return Some(format!(
            "audit-log hash chain: 1 record, no links to verify (verified from seq={first_seq})"
        ));
    }
    let hashes: HashSet<String> =
        seqs.iter().map(|(_, _, rec)| text(rec, "hash")).collect();
    let head_prev = text(seqs[0].2, "prevHash");
    for i in 0..seqs.len() - 1 {
        let cur_hash = text(seqs[i].2, "hash");
        let nxt_prev = text(seqs[i + 1].2, "prevHash");
        if !cur_hash.is_empty() && nxt_prev != cur_hash {
            return Some(format!(
                "audit-log hash chain broken at seq={} (prevHash does not match hash of seq={})",
                seqs[i + 1].1, seqs[i].1
            ));
        }
    }
    if !head_prev.is_empty() && !hashes.contains(&head_prev) {
        return Some(format!(
            "audit-log hash chain verified from seq={first_seq}: oldest records may be rotated \
            (first prevHash has no predecessor)"
        ));
    }
    Some(format!(
        "audit-log hash chain continuous: {} records (verified from seq={first_seq})",
        seqs.len()
    ))
}

struct WorkbuddyTimelines {
    tool_calls: Timeline<ToolCallObservation>,
    tool_results: Timeline<ToolResultObservation>,
    approvals: Timeline<ApprovalObservation>,
    sandbox_modes: Timeline<SandboxModeObservation>,
    turns: Timeline<TurnObservation>,
}

/// 跑一遍（按 sequence 排序后的）audit-log 记录，翻译成五条 harness-neutral timeline
/// （spec §7 决策映射）：
/// - `tool_calls`：`command-safety`+`command-safety.sandbox-executed` → bash
///   （commandPreview）；`network`+`WebFetch` → web_fetch（messageParams.target）。
/// - `approvals`：`approval`/`rejection`+`Bash`、`file-safety`+`bulk-delete.*` →
///   asked（tool_name + messageKey），approved/rejected 再补 decided
///   （allowed-once/rejected）。needs-approval 只有 asked。
/// - `sandbox_modes`：`command-safety.sandbox-executed` → mode = permission_mode
///   （原生值，不翻译）。
/// - `turns`/`tool_results`：恒空（spec §3/§8）。
///
/// 返回 `(timelines, unknown)`。`seq` = 排序后的下标（会话内序）。`mode` 缺列时
/// 取空串（`SandboxModeObservation.mode` 是 `String` 不是 `Option`；SV610 只拿它和
/// `"danger-full-access"` 比，空串与 Python 的 `null` 判定相同——诚实空，不编值）。
fn populate_workbuddy_timelines(
    records: &[Value],
    session_meta: &WorkbuddySessionMeta,
    spans: &[Value],
) -> (WorkbuddyTimelines, Vec<String>) {
    let mut tool_calls = Timeline::new();
    let mut tool_results = Timeline::new();
    let mut approvals = Timeline::new();
    let mut sandbox = Timeline::new();
    let mut unknown: Vec<String> = Vec::new();
    let mode = session_meta.permission_mode.clone().unwrap_or_default();
    // `next_ordinal` 与 `rec_idx` 是两把不同的尺：rec_idx = 排序后下标（`seq`
    // 坐标），next_ordinal = 跨五条 timeline 的 entry 唯一序（`evt-{ordinal}`
    // 契约）。sandbox-executed 一条记录产 **2 条** entry（tool_calls + sandbox），
    // 曾共用记录序——bridge 后撞出重复 `evt-{n}`。
    let mut next_ordinal: usize = 0;
    for (rec_idx, (_, record)) in sort_records(records).into_iter().enumerate() {
        if !record.is_object() {
            // 非对象记录没有 (category, eventType) 可归类——静默跳过等于让证据
            // 消失（评审 P4-13：skipped and recorded, never treated as
            // corruption）。记进 `unknown` 由 SourceAttempt 上报（与
            // `derive_coverage` 的同款缺口一起修，两个 unknown 合并时去重）。
            let msg = "non-object audit-log record".to_string();
            if !unknown.contains(&msg) {
                unknown.push(msg);
            }
            continue;
        }
        let key = record_key(record);
        let key_ref = (key.0.as_str(), key.1.as_str());
        let known = KNOWN_EVENT_TYPES
            .iter()
            .any(|(c, e)| *c == key_ref.0 && *e == key_ref.1);
        if !known {
            let msg = format!(
                "unknown audit-log event (category={}, eventType={})",
                key.0, key.1
            );
            if !unknown.contains(&msg) {
                unknown.push(msg);
            }
            continue;
        }
        let seq = rec_idx as i64;
        let time = parse_time(record);
        let call_id = record.get("toolCallId").and_then(Value::as_str).map(str::to_owned);
        if key_ref == ("command-safety", "command-safety.sandbox-executed") {
            tool_calls.entries.push(timeline_entry(
                ToolCallObservation {
                    name: "bash".to_string(),
                    args_text: command_preview(record),
                },
                Some(seq),
                time,
                call_id.clone(),
                take_ordinal(&mut next_ordinal),
            ));
            sandbox.entries.push(timeline_entry(
                SandboxModeObservation { mode: mode.clone() },
                Some(seq),
                time,
                call_id,
                take_ordinal(&mut next_ordinal),
            ));
        } else if key_ref == ("network", "WebFetch") {
            tool_calls.entries.push(timeline_entry(
                ToolCallObservation {
                    name: "web_fetch".to_string(),
                    args_text: target_of(record),
                },
                Some(seq),
                time,
                call_id,
                take_ordinal(&mut next_ordinal),
            ));
        } else {
            let mut observation = ApprovalObservation {
                asked: Some(ApprovalAsked {
                    tool_name: Some(approval_tool(record)),
                    reason: Some(message_key(record)),
                }),
                decided: None,
            };
            if (key.0 == "approval" && key.1 == "Bash")
                || (key.0 == "file-safety" && key.1 == "file-safety.bulk-delete.approved")
            {
                observation.decided = Some(ApprovalDecided {
                    outcome: "allowed-once".to_string(),
                });
            } else if (key.0 == "rejection" && key.1 == "Bash")
                || (key.0 == "file-safety" && key.1 == "file-safety.bulk-delete.rejected")
            {
                observation.decided = Some(ApprovalDecided {
                    outcome: "rejected".to_string(),
                });
            }
            approvals.entries.push(timeline_entry(
                observation, Some(seq), time, call_id, take_ordinal(&mut next_ordinal)));
        }
    }

    // E2：traces 的 function span → tool_calls + tool_results（Measured，来源是真实
    // span）。**Bash 排除**（E3 定主源前不双计）。args_text 只放 `{"file_path": …}`
    // ——SV604/605 的正则读它；其余 input 一律不进（§4 不要正文）。
    // tool_results：`failed` = status≠ok 或 error 非空（执行环境给了失败信号）；
    // `error_code` = 执行环境原生 status（error/cancelled…），**不翻译成 DSH 码集**——
    // SV607/608 照跑零命中是诚实 MeasuredZero（Codex `exit_code:N` 同款纪律）。
    for span in sort_spans(spans) {
        let kind = span.get("kind").and_then(Value::as_str).unwrap_or("");
        if kind != "function" {
            continue;
        }
        let tool = span.get("tool_name").and_then(Value::as_str).unwrap_or("");
        if tool.is_empty() || tool == "Bash" {
            continue;
        }
        let call_id = span.get("span_id").and_then(Value::as_str).map(str::to_owned);
        let time = span_time(span);
        let args_text = match span.get("file_path").and_then(Value::as_str) {
            Some(fp) => serde_json::json!({ "file_path": fp }).to_string(),
            None => String::new(),
        };
        tool_calls.entries.push(timeline_entry(
            ToolCallObservation { name: normalize_span_tool_name(tool), args_text },
            None, time, call_id.clone(), take_ordinal(&mut next_ordinal)));
        let status = span.get("status").and_then(Value::as_str).unwrap_or("");
        let has_error = span.get("error").and_then(Value::as_str).map(|e| !e.is_empty()).unwrap_or(false);
        let not_ok = !status.is_empty() && status != "ok";
        tool_results.entries.push(timeline_entry(
            ToolResultObservation {
                failed: Some(not_ok || has_error),
                error_code: if not_ok { Some(status.to_string()) } else { None },
            },
            None, time, call_id, take_ordinal(&mut next_ordinal)));
    }

    (
        WorkbuddyTimelines {
            tool_calls,
            tool_results,
            approvals,
            sandbox_modes: sandbox,
            turns: Timeline::new(),
        },
        unknown,
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Bucket {
    Measured,
    Derived,
    // Lossy 在 WorkBuddy 路径上从未被构造（Python `_bump(coverage, ..., "lossy", n)`
    // 同样没有任何调用点——`coverage` 初始化里 lossy=0 恒零）。variant 留着是为了
    // 与 claude/codex 证据模块共用同一套 4 桶 bump 形状（measured/derived/lossy/
    // unmetered），WorkBuddy 的 coverage 输出也按这份形状序列化。allow 而非删除：
    // 删掉会破坏 bump 的穷尽 match，且未来若某个信号改为 lossy 下界还要再加回来。
    #[allow(dead_code)]
    Lossy,
}

fn bump(coverage: &mut Coverage, signal: Signal, bucket: Bucket, n: u64) {
    let mut c = coverage.get(signal);
    match bucket {
        Bucket::Measured => c.measured += n,
        Bucket::Derived => c.derived += n,
        Bucket::Lossy => c.lossy += n,
    }
    coverage.set(signal, c);
}

/// spec §3 矩阵逐信号喂覆盖。ToolCalls/SandboxModes/NetworkAccess/ApprovalDecisions
/// 与 populate 的 timeline 同源（sandbox-executed 数 = tool_calls 的 bash 数 =
/// sandbox 数，等）——coverage 与 timeline 两条账必须对得上，否则门控读 timeline
/// 非空而 coverage 全零。FileMutations/ApprovalPolicy/UsageAggregate 从
/// `session_meta`（db/file-history）拆出。返回 `(sigset, coverage, unknown)`。
/// `credit_json`（`{requestId: credit}` 的 JSON 串）里可解析为数值的条目数。
/// 解析失败 / 非对象 / 空串 → 0。bool 显式排除（Python `isinstance(True, int)`
/// 为真，两侧都要短路）；数值字符串（真实账单里出现过）算数值。与 Python
/// `_credit_entry_count` 逐字节同判。
fn credit_entry_count(credit_json: Option<&str>) -> u64 {
    let Some(raw) = credit_json else { return 0 };
    if raw.trim().is_empty() {
        return 0;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else { return 0 };
    let Some(obj) = parsed.as_object() else { return 0 };
    obj.values()
        .filter(|v| match v {
            Value::Bool(_) => false,
            Value::Number(n) => n.as_f64().map(|f| f.is_finite()).unwrap_or(false),
            Value::String(s) => s.parse::<f64>().map(|f| f.is_finite()).unwrap_or(false),
            _ => false,
        })
        .count() as u64
}

fn derive_coverage(
    records: &[Value],
    session_meta: &WorkbuddySessionMeta,
    spans: &[Value],
) -> (SignalSet, Coverage, Vec<String>) {
    let mut coverage = Coverage::new();
    let mut unknown: Vec<String> = Vec::new();
    let mut request_ids: HashSet<&str> = HashSet::new();

    for record in records {
        let Some(obj) = record.as_object() else {
            // 同 populate 的 P4-13 修复：非对象记录进 unknown，由 SourceAttempt
            // 上报（与 populate 的 unknown 合并，去重）。
            let msg = "non-object audit-log record".to_string();
            if !unknown.contains(&msg) {
                unknown.push(msg);
            }
            continue;
        };
        let key = record_key(record);
        let key_ref = (key.0.as_str(), key.1.as_str());
        let known = KNOWN_EVENT_TYPES
            .iter()
            .any(|(c, e)| *c == key_ref.0 && *e == key_ref.1);
        if !known {
            let msg = format!(
                "unknown audit-log event (category={}, eventType={})",
                key.0, key.1
            );
            if !unknown.contains(&msg) {
                unknown.push(msg);
            }
            continue;
        }
        if let Some(rid) = obj.get("requestId").and_then(Value::as_str) {
            if !rid.is_empty() {
                request_ids.insert(rid);
            }
        }
        if key_ref == ("command-safety", "command-safety.sandbox-executed") {
            bump(&mut coverage, Signal::ToolCalls, Bucket::Measured, 1);
            bump(&mut coverage, Signal::SandboxModes, Bucket::Measured, 1);
        } else if key_ref == ("network", "WebFetch") {
            bump(&mut coverage, Signal::ToolCalls, Bucket::Measured, 1);
            bump(&mut coverage, Signal::NetworkAccess, Bucket::Measured, 1);
        } else {
            bump(&mut coverage, Signal::ApprovalDecisions, Bucket::Measured, 1);
        }
    }

    // FileMutations measured = file-history 版本数（spec §3 Measured 行）。
    if session_meta.file_mutations > 0 {
        bump(&mut coverage, Signal::FileMutations, Bucket::Measured, session_meta.file_mutations);
    }
    // ApprovalPolicy measured = permission_mode / use_sandbox_cli 存在（spec §3）。
    if session_meta.permission_mode.is_some() || session_meta.use_sandbox_cli.is_some() {
        bump(&mut coverage, Signal::ApprovalPolicy, Bucket::Measured, 1);
    }
    // UsageAggregate measured = session_usage.used / credit_json 存在（spec §9）。
    // `credit_json` 是「非空字符串即真」的 Python truthiness——空串算没有。
    if session_meta.used.is_some()
        || session_meta.credit_json.as_deref().map(|s| !s.is_empty()).unwrap_or(false)
    {
        bump(&mut coverage, Signal::UsageAggregate, Bucket::Measured, 1);
    }
    // QuotaConsumption measured = credit_json 里**可解析为数值**的条目数（spec §10 B6）
    // ——每条 = 执行环境为一个 requestId 记了一笔配额消耗。只数条目不看金额：0 积分的
    // 条目也是一次记账观察。非数值（bool/字符串垃圾/null）不计——记账缺口报缺。
    // 与 `sources/mod.rs::credit_cents` 的求和是两件事：那边算钱，这边算观察次数。
    let quota_entries = credit_entry_count(session_meta.credit_json.as_deref());
    if quota_entries > 0 {
        bump(&mut coverage, Signal::QuotaConsumption, Bucket::Measured, quota_entries);
    }
    // E2：traces span 的覆盖。function（非 Bash）→ ToolCalls + ToolResults 各 +1；
    // agent → SubagentSpawns +1。Bash span 不计（E3 前主源是 audit-log，重复计
    // 就是虚增覆盖——`evidence.rs`「适配器不得刷覆盖」）。
    let mut fn_spans = 0_u64;
    let mut agent_spans = 0_u64;
    for span in spans.iter().filter(|s| s.is_object()) {
        match span.get("kind").and_then(Value::as_str).unwrap_or("") {
            "function" => {
                let tool = span.get("tool_name").and_then(Value::as_str).unwrap_or("");
                if !tool.is_empty() && tool != "Bash" {
                    fn_spans += 1;
                }
            }
            "agent" => agent_spans += 1,
            _ => {}
        }
    }
    if fn_spans > 0 {
        bump(&mut coverage, Signal::ToolCalls, Bucket::Measured, fn_spans);
        bump(&mut coverage, Signal::ToolResults, Bucket::Measured, fn_spans);
    }
    if agent_spans > 0 {
        bump(&mut coverage, Signal::SubagentSpawns, Bucket::Measured, agent_spans);
    }
    // TurnBoundaries derived = distinct requestId（lossy 下界，spec §8）。coverage
    // 与 turns timeline **不同源**（timeline 恒空）——这正是
    // `empty_timeline_with_nonzero_coverage_is_unavailable_not_measured_zero` 钉住的
    // 模式：SV612/613 读 timeline 判 Unavailable，coverage 只报可观察的请求下界。
    if !request_ids.is_empty() {
        bump(&mut coverage, Signal::TurnBoundaries, Bucket::Derived, request_ids.len() as u64);
    }

    let mut signals = SignalSet::EMPTY;
    for s in ALL_SIGNALS.iter().copied() {
        if coverage.get(s).total() > 0 {
            signals.insert(s);
        }
    }
    for s in ALL_SIGNALS.iter().copied().filter(|s| is_unavailable(*s)) {
        coverage.set(s, CoverageCounts::default());
    }
    unknown.sort();
    (signals, coverage, unknown)
}

fn build_notes(coverage: &Coverage, records: &[Value], spans: &[Value]) -> Vec<AdapterNote> {
    let mut notes: Vec<AdapterNote> = Vec::new();
    if coverage.get(Signal::TurnBoundaries).total() > 0 {
        notes.push(AdapterNote { message: TURN_BOUNDARY_NOTE.to_string() });
    }
    if coverage.get(Signal::SandboxModes).total() > 0 {
        notes.push(AdapterNote { message: SANDBOX_MODE_NOTE.to_string() });
    }
    if coverage.get(Signal::QuotaConsumption).total() > 0 {
        notes.push(AdapterNote { message: QUOTA_CONSUMPTION_NOTE.to_string() });
    }
    if let Some(chain) = chain_note(records) {
        notes.push(AdapterNote { message: chain });
    }
    // E2：有 span 就说明折了什么、没折什么。Bash span 数单独报——E3 定主源前它们
    // 不进 tool_calls，读者得知道这个缺口是刻意的。
    if spans.iter().any(|s| s.is_object()) {
        let (mut fn_non_bash, mut bash, mut agent) = (0_u64, 0_u64, 0_u64);
        for s in spans.iter().filter(|s| s.is_object()) {
            match s.get("kind").and_then(Value::as_str).unwrap_or("") {
                "function" => {
                    if s.get("tool_name").and_then(Value::as_str) == Some("Bash") {
                        bash += 1;
                    } else if s.get("tool_name").and_then(Value::as_str).map(|n| !n.is_empty()).unwrap_or(false) {
                        fn_non_bash += 1;
                    }
                }
                "agent" => agent += 1,
                _ => {}
            }
        }
        notes.push(AdapterNote {
            message: format!(
                "{TRACES_FOLDED_NOTE_PREFIX}{fn_non_bash} non-Bash function span(s) -> tool_calls/tool_results, \
{agent} agent span(s) -> SubagentSpawns; {bash} Bash span(s) NOT folded: audit-log sandbox-executed is \
the Bash source (no shared identity key — audit toolCallId vs span spanId — and audit-log is the \
hash-chained security ledger with the more complete record; merging would double-count)"
            ),
        });
    }
    notes
}

fn first_cwd(session_meta: &WorkbuddySessionMeta) -> Vec<String> {
    session_meta.cwd.clone().map(|c| vec![c]).unwrap_or_default()
}

/// 记录数组 + 会话元数据 → evidence（"derive → coverage" 两段；"locate → shape →
/// extract" 留在 `src/agent/workbuddy_session.rs`）。与 Python `build_workbuddy_evidence`
/// 对齐：`canonical` 是 `CanonicalSession`（meta/signals/coverage/attempts/notes +
/// 五条 timeline，turns 恒空——spec §8 的「故意空」构造点）。
///
/// 诚实真值表（喂 WorkBuddy canonical 后每条 SV 规则的结果）：
///
/// | 规则 | WorkBuddy |
/// |---|---|
/// | SV601–603 | 跑（`command-safety.sandbox-executed` 的 commandPreview → bash args_text） |
/// | SV604/605 | 跑（E2：Edit/Write span 解码后的 file_path → args_text）；降级行已删 |
/// | SV606 | 跑（network+WebFetch target → web_fetch args_text） |
/// | SV607/608 | 跑（E2：span status → error_code，原生码不翻译 → 诚实 MeasuredZero） |
/// | SV609 | 跑（audit-log 审批路径 → asked）；无审批记录则 Unavailable |
/// | SV610 | 跑（sandbox 非空），mode 恒非 danger-full-access → 诚实 MeasuredZero |
/// | SV611 | 跑（bash+web_fetch 子集） |
/// | SV612/613 | SV612 Unavailable（turns 恒空）；SV613 有 span 时跑（(b) 读 tool_results），无 span 时 Unavailable |
/// | SV614 | 跑（approvals+sandbox 双轴都在） |
pub fn build_workbuddy_evidence(
    raw_records: Vec<Value>,
    session_id: String,
    session_meta: &WorkbuddySessionMeta,
    spans: &[Value],
) -> WorkbuddyEvidence {
    let (timelines, unknown) = populate_workbuddy_timelines(&raw_records, session_meta, spans);
    let (signals, coverage, cov_unknown) = derive_coverage(&raw_records, session_meta, spans);
    let mut all_unknown = unknown;
    for m in cov_unknown {
        if !all_unknown.contains(&m) {
            all_unknown.push(m);
        }
    }
    all_unknown.sort();
    // E2：traces 不再是「已知但刻意不用」的表面——已折进 timeline，不再记 attempt。
    let mut attempts: Vec<SourceAttempt> = Vec::new();
    for msg in all_unknown {
        attempts.push(SourceAttempt {
            source_id: "workbuddy.audit-log",
            kind: SourceKind::LogFile,
            surface: Surface::SessionLog,
            available: false,
            error: Some(msg),
            observed_span: None,
        });
    }
    let notes = build_notes(&coverage, &raw_records, spans);
    let canonical = CanonicalSession {
        meta: SessionMeta {
            session_id,
            harness_id: "workbuddy",
            workspace_roots: first_cwd(session_meta),
            model: session_meta.model.clone(),
            // D1–D4：喂进本证据的原生记录时间 min/max。WorkBuddy 的 `timestamp`
            // 经 `parse_time` → `parse_iso` 出**秒**，由 `session_span` 归一到毫秒。
            // 0 条记录 → None。
            span: crate::workflow_utils::session_span(raw_records.iter().filter_map(parse_time)),
        },
        signals,
        coverage,
        attempts,
        notes,
        tool_calls: timelines.tool_calls,
        tool_results: timelines.tool_results,
        approvals: timelines.approvals,
        sandbox_modes: timelines.sandbox_modes,
        turns: timelines.turns,
    };
    WorkbuddyEvidence { canonical, raw_records }
}

/// evidence → `workbuddy-evidence --json` 的输出形状。与 Python `workbuddy_evidence_json`
/// 逐字节对齐——键序、嵌套结构、`attempts`/`notes` 的序列化都是这里单独控制的。
/// `signals` 数组按 ALL_SIGNALS 序；`coverage` 20 键全量（unavailable 的也是全零四条，
/// 不是缺键）；`available` 标记执行环境是否提供该维度——false = 结构缺口，任何会话都为零，
/// KPI 分母不算它。
pub fn workbuddy_evidence_json(evidence: &WorkbuddyEvidence) -> Value {
    let signals: Vec<String> = ALL_SIGNALS
        .iter()
        .filter(|s| evidence.canonical.signals.contains(**s))
        .map(|s| format!("{s:?}"))
        .collect();
    let mut coverage_map = serde_json::Map::new();
    for s in ALL_SIGNALS {
        let c = evidence.canonical.coverage.get(*s);
        coverage_map.insert(
            format!("{s:?}"),
            serde_json::json!({
                "measured": c.measured,
                "derived": c.derived,
                "lossy": c.lossy,
                "unmetered": c.unmetered,
                "available": !is_unavailable(*s),
            }),
        );
    }
    let attempts: Vec<Value> = evidence
        .canonical
        .attempts
        .iter()
        .map(|a| {
            serde_json::json!({
                "source_id": a.source_id,
                "kind": format!("{:?}", a.kind),
                "surface": format!("{:?}", a.surface),
                "available": a.available,
                "error": a.error,
                "observed_span": a.observed_span.map(|sp| serde_json::json!({
                    "start_ms": sp.start_ms,
                    "end_ms": sp.end_ms,
                })),
            })
        })
        .collect();
    let notes: Vec<Value> = evidence
        .canonical
        .notes
        .iter()
        .map(|n| serde_json::json!(n.message))
        .collect();
    serde_json::json!({
        "harness": "workbuddy",
        "session_id": evidence.canonical.meta.session_id,
        "workspace_roots": evidence.canonical.meta.workspace_roots,
        "model": evidence.canonical.meta.model,
        // 会话实际覆盖跨度（D1–D4）。与 `attempts[].observed_span` 同形；
        // 键位置与 Python 镜像逐字节对齐。
        "span": evidence.canonical.meta.span.map(|s| serde_json::json!({
            "start_ms": s.start_ms,
            "end_ms": s.end_ms,
        })),
        "signals": signals,
        "coverage": coverage_map,
        "attempts": attempts,
        "notes": notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta() -> WorkbuddySessionMeta {
        WorkbuddySessionMeta {
            permission_mode: Some("fullAccess".to_string()),
            use_sandbox_cli: Some(1),
            model: None,
            cwd: None,
            title: None,
            created_at: None,
            updated_at: None,
            used: None,
            credit_json: None,
            file_mutations: 0,
        }
    }

    #[test]
    fn sandbox_executed_dual_entries_have_distinct_ordinals() {
        // `evt-{ordinal}` 契约：sandbox-executed 一条记录产 **2 条** entry
        // （tool_calls + sandbox_modes），曾共用记录序 → bridge 后重复 evt-{n}。
        // 真机词表：命令类 eventType 是 category 全限定名，审批类是裸工具名。
        let records = vec![
            json!({"sequence": 1, "category": "command-safety",
                   "eventType": "command-safety.sandbox-executed", "toolCallId": "c1",
                   "commandPreview": "ls", "timestamp": "2026-08-31T10:00:00Z"}),
            json!({"sequence": 2, "category": "network", "eventType": "WebFetch",
                   "toolCallId": "c2",
                   "messageParams": {"target": "https://example.com"},
                   "timestamp": "2026-08-31T10:00:01Z"}),
            json!({"sequence": 3, "category": "command-safety",
                   "eventType": "command-safety.sandbox-executed", "toolCallId": "c3",
                   "commandPreview": "pwd", "timestamp": "2026-08-31T10:00:02Z"}),
        ];
        let (tl, unknown) = populate_workbuddy_timelines(&records, &meta(), &[]);
        assert!(unknown.is_empty());
        assert_eq!(tl.tool_calls.entries.len(), 3);
        assert_eq!(tl.sandbox_modes.entries.len(), 2);
        let mut ords: Vec<usize> =
            tl.tool_calls.entries.iter().map(|e| e.ordinal).collect();
        ords.extend(tl.sandbox_modes.entries.iter().map(|e| e.ordinal));
        // push 序 = [tc0, s0, tc1, tc2, s1]；旧代码（记录序）给出 [0, 1, 0, 0, 2] 撞号。
        assert_eq!(ords, vec![0, 2, 3, 1, 4], "tool_calls 与 sandbox 的 ordinal 交错唯一");
        // seq 仍是记录序：同记录的 entry 共享各自记录序。
        assert_eq!(tl.tool_calls.entries[0].seq, Some(0));
        assert_eq!(tl.sandbox_modes.entries[0].seq, Some(0));
        assert_eq!(tl.tool_calls.entries[2].seq, Some(2));
        assert_eq!(tl.sandbox_modes.entries[1].seq, Some(2));
    }

    #[test]
    fn chain_note_single_record_has_no_links_to_verify() {
        assert_eq!(
            chain_note(&[json!({"sequence": 7, "eventType": "sandbox-executed",
                                "hash": "h7", "prevHash": ""})]).as_deref(),
            Some("audit-log hash chain: 1 record, no links to verify (verified from seq=7)"));
    }

    #[test]
    fn chain_note_continuous_chain_reports_count() {
        let records = vec![
            json!({"sequence": 1, "hash": "h1", "prevHash": ""}),
            json!({"sequence": 2, "hash": "h2", "prevHash": "h1"}),
            json!({"sequence": 3, "hash": "h3", "prevHash": "h2"}),
        ];
        assert_eq!(
            chain_note(&records).as_deref(),
            Some("audit-log hash chain continuous: 3 records (verified from seq=1)"));
    }

    #[test]
    fn chain_note_broken_link_names_both_seqs() {
        let records = vec![
            json!({"sequence": 1, "hash": "h1", "prevHash": ""}),
            json!({"sequence": 2, "hash": "h2", "prevHash": "wrong"}),
        ];
        assert_eq!(
            chain_note(&records).as_deref(),
            Some("audit-log hash chain broken at seq=2 (prevHash does not match hash of seq=1)"));
    }

    #[test]
    fn chain_note_rotated_head_is_honest_about_verification_start() {
        // 首条 prevHash 非空且匹配不到任何记录 → 最老记录可能被轮转，链从首条起验证。
        let records = vec![
            json!({"sequence": 5, "hash": "h5", "prevHash": "h4"}),
            json!({"sequence": 6, "hash": "h6", "prevHash": "h5"}),
        ];
        assert_eq!(
            chain_note(&records).as_deref(),
            Some("audit-log hash chain verified from seq=5: oldest records may be rotated \
                  (first prevHash has no predecessor)"));
    }

    #[test]
    fn parse_time_reads_integer_epoch_ms_the_real_machine_shape() {
        // 真机 `~/.workbuddy/audit-log/*.jsonl` 的 `timestamp` 是 13 位 epoch-ms
        // 整数——旧实现 `and_then(Value::as_str)` 把它读成 None，于是有 findings
        // 的会话里每条 finding 的 `time` 是 null（评审 A6：Rust-only 改会打破
        // 与 Python `_parse_time` 的差分，双侧同一 commit）。
        assert_eq!(
            parse_time(&json!({"timestamp": 1_788_170_400_000_i64})),
            Some(1_788_170_400)
        );
        // 浮点同路径（floor 除 1000），与 Python `math.floor(v / 1000.0)` 对齐。
        assert_eq!(
            parse_time(&json!({"timestamp": 1_788_170_400_500.0_f64})),
            Some(1_788_170_400)
        );
        // 字符串路径原样不回归。
        assert_eq!(
            parse_time(&json!({"timestamp": "2026-08-31T10:00:00Z"})),
            parse_iso("2026-08-31T10:00:00Z").map(|(s, _)| s)
        );
    }

    #[test]
    fn parse_time_rejects_out_of_fixed_window_and_non_numeric() {
        // 纯 crate 读不了时钟——窗口是固定的 [2000-01-01, 2100-01-01)。
        // 999ms → 1970（< 2000）、253402300800000ms → 10000 年（>= 2100）：均 None。
        assert_eq!(parse_time(&json!({"timestamp": 999_i64})), None);
        assert_eq!(parse_time(&json!({"timestamp": 253_402_300_800_000_i64})), None);
        // 位数嗅探禁令：10 位数字按毫秒解释 = 1970，不是「当秒」。
        assert_eq!(parse_time(&json!({"timestamp": 1_788_170_400_i64})), None);
        // bool / null / object / 缺失 → None（bool 不是 Number）。
        assert_eq!(parse_time(&json!({"timestamp": true})), None);
        assert_eq!(parse_time(&json!({"timestamp": Value::Null})), None);
        assert_eq!(parse_time(&json!({"timestamp": {"nested": 1}})), None);
        assert_eq!(parse_time(&json!({})), None);
    }
}
