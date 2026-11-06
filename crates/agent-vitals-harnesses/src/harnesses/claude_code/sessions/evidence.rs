//! Claude Code 适配器的 "derive → coverage" 两段（五段式流水线 locate → shape →
//! extract → derive → coverage，"locate → shape → extract" 留在
//! `src/agent/claude_session.rs`，I/O 不在这里）。它把 `~/.claude/projects/*.jsonl`
//! 里抽出的原始记录折成 `evidence::CanonicalSession`，覆盖计数按
//! `docs/RUNTIME_EVIDENCE_CONTRACT.md` §13 harness coverage matrix 的 **Claude Code 列**
//! 逐条对应。设计权威是 `docs/CLAUDE_CODE_INTEGRATION.md`。
//!
//! **§8 turn 重建的判据是内容，不是 `parentUuid`。** 真机语料（8 会话、2,447 条
//! 消息）里纯文本 user 且 `parentUuid != null` 的有 886 条、`parentUuid == null`
//! 的只有 8 条——naive「parentUuid=null 即根」会漏掉 99% 的 turn 边界。文档 §8 问 4
//! 的判定（`message.content` 含 `tool_result` 块 = 工具循环续写；纯文本/image =
//! 新 human prompt → turn 根）才是可靠的。本文件以内容为准。
//!
//! **孤儿不合成 turn。** §8 问 3 说「无 open turn 时起一个合成 turn（Derived）」，
//! 但问 8 的收尾是「重建不出报 Unavailable……**绝不发明不存在的边界**」。两者冲突
//! 时后者赢：没有纯文本 user 根的记录（截断文件）→ turns 恒空 → SV612 经
//! `timeline_is_empty` 诚实 Unavailable；中途无根可归的 tool_result/assistant →
//! `turn=None`（不归属任何 turn，也不进任何 sig）。合成一个不存在的边界正是问 8
//! 禁止的事。
//!
//! **`is_error` 译 `failed` 是 lossy，`error_code` 恒 None。** Claude 的
//! `tool_result.is_error` 是布尔三态（实测 true×169 / false×5336 / 键缺失×3947），
//! 只证明「失败了」、不证明**失败原因**（§2.3）。译成 `failed=Some(bool)`、
//! provenance=lossy（理由被截断成布尔）；键缺失的记 Measured。`error_code` 保持
//! None——绝不伪造一个码（§3：把一切失败伪造成错误码 → SV607/608 错误地
//! MeasuredZero）。SV607/608 的 Unavailable 是 dispatcher 层的判定（SV7.4.1 门控 +
//! 原因级读 error_code），不在本适配器：本适配器的职责是产出**诚实的证据**，不能
//! 靠「不填 tool_results」把 SV613(b) 的 lossy 路径一起饿死。
//!
//! `ClaudeEvidence` 把 `CanonicalSession`（§12 规定不持有任何执行环境专属 payload）
//! 和它派生自的原始记录捆在一起——与 `DshEvidence`/`CodexEvidence` 同一个理由、
//! 同一个形状。

use std::collections::HashSet;

use serde_json::Value;

use agent_vitals_domain::domain::budget::parse_iso;
use agent_vitals_domain::contracts::evidence::{
    AdapterNote, CanonicalSession, Coverage, CoverageCounts, LossKind, Provenance, SessionMeta,
    Signal, SignalSet, SourceAttempt, SourceKind, Surface, Timeline, TimelineEntry,
    ToolCallObservation, ToolResultObservation, TurnObservation,
};

/// Claude Code 适配器一次审计的产物：`CanonicalSession` + 它派生自的原始记录。
pub struct ClaudeEvidence {
    pub canonical: CanonicalSession,
    pub raw_records: Vec<Value>,
}

// ────────────────────────── 词表：实测 + §2.2 补缺 ──────────────────────────

/// 顶层 `{type, timestamp, uuid, parentUuid, ...}` 记录的已知 type 值。实测
/// （8 会话抽样）出现 14 种；其余 type 记成 `SourceAttempt`，绝不当作损坏吞掉。
const KNOWN_TYPES: &[&str] = &[
    "ai-title",
    "assistant",
    "atis-latch",
    "attachment",
    "file-history-delta",
    "file-history-snapshot",
    "frame-link",
    "last-prompt",
    "mode",
    "permission-mode",
    "pr-link",
    "queue-operation",
    "system",
    "user",
];

/// §13 Claude Code 列明确 unavailable / 没有对应列的信号。`derive_coverage` 的
/// 置零与 `claude_evidence_json` 的 `available` 标记共用这一份清单，不准两处各写
/// 一份漂移。v0.6 harness-contract spec §6/§11-M2a：执行环境级 unmeasured 声明不再是
/// 本文件的字面量表，改从 core `harness_capability::HARNESSES` 的 "claude-code" 行读
/// （行上的值就是从这个函数原来的字面量表搬过去的，golden 字节不变）；
/// `ApprovalDecisions` 是 first-slice 范围的注记仍留在 `HARNESSES` 行的行内文档，
/// 后续做 marker 恢复时从行上摘掉这一项即可，不用回这个文件改代码。
fn is_unavailable(signal: Signal) -> bool {
    agent_vitals_domain::contracts::harness_capability::harness_profile("claude-code")
        .is_some_and(|h| h.unmeasured_signals.contains(&signal))
}

// ────────────────────────── §7 工具名规范化 + args_text ──────────────────────────

/// §7 工具名规范化表。未映射的名字原样透传（won't match 规则 → 诚实 MeasuredZero，
/// 不会误报）。`MultiEdit` 并入 `edit`——SV611 会把同一语义拆成两个名字识别成
/// 不同调用。
fn normalize_tool_name(name: &str) -> &str {
    match name {
        "Bash" => "bash",
        "Write" => "write",
        "Edit" | "MultiEdit" => "edit",
        "Read" => "read",
        "Glob" => "glob",
        "Grep" => "grep",
        "WebFetch" => "web_fetch",
        "WebSearch" => "web_search",
        "Task" => "task",
        "TodoWrite" => "todo_write",
        "NotebookEdit" => "notebook_edit",
        other => other,
    }
}

/// `(canonical_name, args_text)`。`args_text` 用 `vitals_core::canonical::
/// canonical_string` 做 key 递归排序的压缩序列化——否则 SV611 把键序不同、语义相同
/// 的参数识别成不同调用。**Bash 例外**：直接取 `input.command`（shell 字符串），与
/// DSH/Codex 的 bash 处理同一形状。
fn normalize_tool(name: &str, input: Option<&Value>) -> (String, String) {
    let canonical = normalize_tool_name(name);
    if canonical == "bash" {
        let cmd = input
            .and_then(|i| i.get("command"))
            .and_then(Value::as_str)
            .unwrap_or("");
        return (canonical.to_string(), cmd.to_string());
    }
    let args_text = match input {
        Some(i) if !i.is_null() => vitals_core::canonical::canonical_string(i),
        _ => String::new(),
    };
    (canonical.to_string(), args_text)
}

// ────────────────────────── §8 turn 重建：内容判定 ──────────────────────────

/// §8 问 4：user 事件是不是「新 human prompt」（turn 根）。判据按**内容**，
/// 不是 `parentUuid`（模块文档：真机 886 vs 8）；具体规则与 workflow 的
/// `task_started` 共用 `sessions::turns::turn_signal` 一份（此前这里是「字符串
/// 或不含 tool_result 的数组」，把 skill 正文注入、`<task-notification>`、
/// 中断标记都算成新 turn，与消耗诊断的回合数对不上）。
fn is_turn_root(record: &Value, has_turn: bool) -> bool {
    super::turns::turn_signal(record, has_turn) == agent_vitals_domain::session_semantics::UserTurnSignal::Request
}

fn is_tool_result_block(b: &Value) -> bool {
    b.get("type").and_then(Value::as_str) == Some("tool_result")
}

/// turn 生命周期 pass 的中间状态。turn 号是**合成序数**（Claude 没有数值 turn）——
/// 编造序数不是编造零：序数只做会话内排序，不做任何「Claude 没记录的事」。
/// `start_*` = turn 根事件的坐标（`TimelineEntry` 坐标 = turn/start 的坐标，
/// evidence.rs）；`last_*` = turn 内最后一条主干事件（SV612 的 run_end_seq）；
/// `end_seq`/`end_time` 由 `flush_turn` 填 `last_*`（镜像 DSH fixture 里
/// `last_seq == end_seq` 的不变式），`end_reason_kind`/`end_error_code` 恒 None——
/// Claude 没有 turn/end 事件，没有收尾原因可抄。
struct PendingClaudeTurn {
    turn: i64,
    sig: Vec<(String, String)>,
    start_seq: Option<i64>,
    start_time: Option<i64>,
    last_seq: Option<i64>,
    last_time: Option<i64>,
}

/// 一条 timeline entry 的构造器。Claude 逐事件带 timestamp（`parse_iso` → 秒），
/// 比 Codex（无时间戳）多一维；`step` 恒 None——Claude 无原生 step，StepBoundaries
/// 只在 coverage 层按 assistant 消息数派生。
fn timeline_entry<T>(
    observation: T,
    provenance: Provenance,
    seq: Option<i64>,
    time: Option<i64>,
    turn: Option<i64>,
    call_id: Option<String>,
    ordinal: usize,
) -> TimelineEntry<T> {
    TimelineEntry { observation, provenance, seq, time, turn, step: None, call_id, ordinal }
}

/// 一条 tool_result user 的续写块 → `tool_results`。三态 is_error（§2.3）：
/// - 键存在（true/false）→ `failed=Some(bool)`，provenance=**lossy**（失败理由被
///   截断成布尔，`LossKind::Truncated` 的 hint 缺——不知道原详情有多长）；
/// - 键缺失 → `failed=None`，provenance=**measured**（执行环境记了结果、无失败信号）。
///
/// `error_code` 恒 None（§3：Claude 无原因码来源，绝不伪造）。
///
/// `next_ordinal` 是**跨块**的唯一序号（§compatibility:canonical_session 的
/// `evt-{ordinal}` 契约）：一条 message 记录可含多个 tool_result 块，若用记录
/// 序号当 ordinal，同记录的块会产出重复 `evt-{n}`——契约文档曾声称「同一个
/// 原始事件不会出现在两条 timeline 里」，Claude 的多块记录是反例。
fn process_tool_result_blocks(
    record: &Value,
    tool_results: &mut Timeline<ToolResultObservation>,
    seq: i64,
    time: Option<i64>,
    turn: Option<i64>,
    next_ordinal: &mut usize,
) {
    let Some(Value::Array(items)) = record.pointer("/message/content") else {
        return;
    };
    for blk in items {
        if !is_tool_result_block(blk) {
            continue;
        }
        let ordinal = *next_ordinal;
        *next_ordinal += 1;
        let is_error = blk.get("is_error");
        let failed = is_error.and_then(Value::as_bool);
        let provenance = if is_error.is_some() {
            Provenance::Lossy { kind: LossKind::Truncated { hint: None } }
        } else {
            Provenance::Measured
        };
        tool_results.entries.push(timeline_entry(
            ToolResultObservation { failed, error_code: None },
            provenance,
            Some(seq),
            time,
            turn,
            blk.get("tool_use_id").and_then(Value::as_str).map(str::to_owned),
            ordinal,
        ));
    }
}

/// 一条 assistant 的 tool_use 块 → `tool_calls`，返回各块 `(name, args_text)` 的
/// sig 贡献。**sidechain 归属由调用方决定**：调用方只在非 sidechain 时把返回值
/// extend 进当前 turn 的 sig（SV612 死循环检测的输入）——abandoned branch 不进
/// turn 边界（§8 问 2），但它的工具调用本身照常记录（`turn=None`）。返回而非就地
/// push 是因为 sidechain 判据在调用方手里，传 `&mut pending` + `is_sidechain` 两个
/// 参数会让签名过肥，也让「谁拥有 turn 归属」这个决定藏在两层里。
///
/// `next_ordinal` 是**跨块**的唯一序号（同 `process_tool_result_blocks` 的契约）。
fn process_tool_use_blocks(
    record: &Value,
    tool_calls: &mut Timeline<ToolCallObservation>,
    seq: i64,
    time: Option<i64>,
    turn: Option<i64>,
    next_ordinal: &mut usize,
) -> Vec<(String, String)> {
    let Some(Value::Array(items)) = record.pointer("/message/content") else {
        return Vec::new();
    };
    let mut sig = Vec::new();
    for blk in items {
        if blk.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let ordinal = *next_ordinal;
        *next_ordinal += 1;
        let name = blk.get("name").and_then(Value::as_str).unwrap_or("");
        let (canonical_name, args_text) = normalize_tool(name, blk.get("input"));
        let call_id = blk.get("id").and_then(Value::as_str).map(str::to_owned);
        tool_calls.entries.push(timeline_entry(
            ToolCallObservation { name: canonical_name.clone(), args_text: args_text.clone() },
            Provenance::Measured,
            Some(seq),
            time,
            turn,
            call_id,
            ordinal,
        ));
        sig.push((canonical_name, args_text));
    }
    sig
}

/// 关掉一个 turn：push `TurnObservation`。entry 坐标 = turn/start（根事件）；
/// `end_seq`/`end_time` = `last_*`（最后一个主干事件——镜像 DSH fixture 里
/// `last_seq == end_seq` 的不变式），`end_reason_kind`/`end_error_code` 恒 None
/// （Claude 无 turn/end 事件）。SV613(a) 读 `end_reason_kind=="error"` 恒不命中 →
/// 诚实 MeasuredZero，不发明 error turn。
///
/// `next_ordinal` 同前：turn 是第三条 timeline，序号必须与前两条共用同一把
/// 递增（曾硬编码 0——第一对真实数据就产出 `evt-0` 撞 `tool_calls` 的首条）。
fn flush_turn(
    turns: &mut Timeline<TurnObservation>,
    p: PendingClaudeTurn,
    next_ordinal: &mut usize,
) {
    let ordinal = *next_ordinal;
    *next_ordinal += 1;
    turns.entries.push(timeline_entry(
        TurnObservation {
            turn: p.turn,
            sig: p.sig,
            last_seq: p.last_seq,
            end_reason_kind: None,
            end_error_code: None,
            end_seq: p.last_seq,
            end_time: p.last_time,
        },
        Provenance::Derived { from: "content_turn_root" },
        p.start_seq,
        p.start_time,
        Some(p.turn),
        None,
        ordinal,
    ));
}

/// 跑一遍 `records`，把 Claude 线格式翻译成五个 harness-neutral timeline（§11.5）
/// 里的三条（approvals/sandbox_modes 恒空——§13 Claude 列两行 unavailable）：
/// - `tool_calls`：assistant 的 `tool_use` 块 → §7 规范化名 + 确定性 args_text。
/// - `tool_results`：user 的 `tool_result` 块 → 三态 is_error → `failed`。
/// - `turns`：纯文本 user 根开 turn、EOF 兜底关闭；turn 内主干 tool_use 的
///   (name, args_text) 进 `sig`。
///
/// turn 边界判据 = 内容（§8 问 4），非 `parentUuid`（模块文档的实测论证）。
pub(crate) fn populate_claude_timelines(
    records: &[Value],
    tool_calls: &mut Timeline<ToolCallObservation>,
    tool_results: &mut Timeline<ToolResultObservation>,
    turns: &mut Timeline<TurnObservation>,
) {
    let mut pending: Option<PendingClaudeTurn> = None;
    let mut next_turn: i64 = 0;
    // `next_ordinal` 与 `rec_idx` 是两把不同的尺：rec_idx = 记录序（`seq` 坐标，
    // 同记录的所有块共享），next_ordinal = 跨三条 timeline 的 entry 唯一序。
    // 曾用记录序当 ordinal——一条记录多块（或 flush_turn 硬编码 0）就撞号。
    let mut next_ordinal: usize = 0;

    for (rec_idx, record) in records.iter().enumerate() {
        let Some(typ) = record.get("type").and_then(Value::as_str) else {
            continue;
        };
        let is_sidechain = record.get("isSidechain").and_then(Value::as_bool).unwrap_or(false);
        let seq = rec_idx as i64;
        let time = record.get("timestamp").and_then(|v| v.as_str()).and_then(parse_iso).map(|(s, _)| s);

        match typ {
            "user" => {
                if !is_sidechain {
                    if is_turn_root(record, next_turn > 0) {
                        // 新 turn 根：flush 上一个、开新的。根**不**推进上一个 turn
                        // 的 last_seq（上一个 turn 到根**之前**的最后一个事件为止）。
                        if let Some(p) = pending.take() {
                            flush_turn(turns, p, &mut next_ordinal);
                        }
                        pending = Some(PendingClaudeTurn {
                            turn: next_turn,
                            sig: Vec::new(),
                            start_seq: Some(seq),
                            start_time: time,
                            last_seq: Some(seq),
                            last_time: time,
                        });
                        next_turn += 1;
                    } else if let Some(p) = pending.as_mut() {
                        // tool_result 续写推进 turn 的 last_seq（turn 内任何事件都推进）
                        p.last_seq = Some(seq);
                        p.last_time = time;
                    }
                }
                process_tool_result_blocks(
                    record,
                    tool_results,
                    seq,
                    time,
                    if is_sidechain { None } else { pending.as_ref().map(|p| p.turn) },
                    &mut next_ordinal,
                );
            }
            "assistant" => {
                if !is_sidechain {
                    if let Some(p) = pending.as_mut() {
                        p.last_seq = Some(seq);
                        p.last_time = time;
                    }
                }
                let turn_opt =
                    if is_sidechain { None } else { pending.as_ref().map(|p| p.turn) };
                let sig = process_tool_use_blocks(
                    record, tool_calls, seq, time, turn_opt, &mut next_ordinal);
                if !is_sidechain {
                    if let Some(p) = pending.as_mut() {
                        p.sig.extend(sig);
                    }
                }
            }
            _ => {}
        }
    }
    // EOF 兜底（§8 问 7）：最后一个 open turn 在文件尾关闭。
    if let Some(p) = pending.take() {
        flush_turn(turns, p, &mut next_ordinal);
    }
}

// ────────────────────────── coverage：§13 Claude Code 列 ──────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Bucket {
    Measured,
    Derived,
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

/// §13 Claude Code 列逐条喂覆盖。**ToolCalls/ToolResults/TurnBoundaries 三个计数
/// 与 populate 的 timeline 同源**（tool_use 块数 = tool_calls.entries.len()，等）——
/// 这是 repo 的纪律：coverage 与 timeline 两条账必须对得上，否则门控读 timeline
/// 非空而 coverage 全零。Usage 按 `message.id` 去重：Claude 在消息的每条 content
/// 行上重复同一份 `message.usage`（实测 1,517/2,447 消息跨 2-4 行），不去重会把
/// Usage 虚增 2-4 倍。
fn derive_coverage(records: &[Value], turns_len: usize) -> (SignalSet, Coverage, Vec<String>) {
    let mut coverage = Coverage::new();
    let mut unknown: Vec<String> = Vec::new();
    let mut usage_ids: HashSet<&str> = HashSet::new();
    let mut step_ids: HashSet<&str> = HashSet::new();
    let mut prompts: usize = 0;

    for record in records {
        let Some(typ) = record.get("type").and_then(Value::as_str) else {
            // 缺 type（或 type 非字符串）的记录没有归类的锚点——静默跳过等于让
            // 证据消失（评审 P4-13：skipped and recorded, never treated as
            // corruption）。记进 `unknown` 由 SourceAttempt 上报，绝不吞。
            let msg = "missing record type".to_string();
            if !unknown.contains(&msg) {
                unknown.push(msg);
            }
            continue;
        };
        if !KNOWN_TYPES.contains(&typ) {
            let msg = format!("unknown record type: {typ}");
            if !unknown.contains(&msg) {
                unknown.push(msg);
            }
            continue;
        }
        let is_sidechain = record.get("isSidechain").and_then(Value::as_bool).unwrap_or(false);
        let message = record.get("message");

        match typ {
            "user" => {
                let content = message.and_then(|m| m.get("content"));
                if !is_sidechain && is_turn_root(record, prompts > 0) {
                    // turn 根 = 真人 human prompt（与 codex 的 UserPrompts 同义）。
                    prompts += 1;
                    bump(&mut coverage, Signal::UserPrompts, Bucket::Measured, 1);
                }
                if let Some(Value::Array(items)) = content {
                    for blk in items {
                        if is_tool_result_block(blk) {
                            bump(&mut coverage, Signal::ToolResults, Bucket::Measured, 1);
                        }
                    }
                }
            }
            "assistant" => {
                if let Some(Value::Array(items)) = message.and_then(|m| m.get("content")) {
                    for blk in items {
                        if blk.get("type").and_then(Value::as_str) != Some("tool_use") {
                            continue;
                        }
                        bump(&mut coverage, Signal::ToolCalls, Bucket::Measured, 1);
                        let name = blk.get("name").and_then(Value::as_str).unwrap_or("");
                        match name {
                            "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
                                // §13 FileMutations = "derived (from tool calls)"。
                                bump(&mut coverage, Signal::FileMutations, Bucket::Derived, 1);
                            }
                            // is_sidechain 守卫 = SubagentSpawns 的**按记录去重**：
                            // 记录级 is_sidechain 臂（下面）已数过这条记录，sidechain
                            // 记录里的 Task 块不能再数一次——否则一条 sidechain 记录
                            // 既走 Task 臂又走 is_sidechain 臂，双计（评审 P4-12）。
                            // 主干（非 sidechain）的 Task 块 = 一次真实子代理 spawn，
                            // 按块数。
                            "Task" if !is_sidechain => {
                                bump(&mut coverage, Signal::SubagentSpawns, Bucket::Measured, 1);
                            }
                            "Skill" => {
                                // §13 SkillInvocations = "derived (Skill tool call)"。
                                bump(&mut coverage, Signal::SkillInvocations, Bucket::Derived, 1);
                            }
                            _ => {}
                        }
                    }
                }
                // Usage measured：按 message.id 去重（模块文档）。无 id 时回退 uuid
                //（每条 content 行计一次，罕见行，可接受）。
                if message.and_then(|m| m.get("usage")).is_some_and(|u| u.is_object()) {
                    let key: &str = message
                        .and_then(|m| m.get("id"))
                        .and_then(Value::as_str)
                        .or_else(|| record.get("uuid").and_then(Value::as_str))
                        .unwrap_or("");
                    if usage_ids.insert(key) {
                        bump(&mut coverage, Signal::Usage, Bucket::Measured, 1);
                    }
                }
                // StepBoundaries derived：每个 assistant message = 一个 step（§13
                // Claude 列 "derived"；没有原生 step 事件，按消息数派生，去重跨行）。
                if let Some(id) = message.and_then(|m| m.get("id")).and_then(Value::as_str) {
                    if step_ids.insert(id) {
                        bump(&mut coverage, Signal::StepBoundaries, Bucket::Derived, 1);
                    }
                }
            }
            "system" => {
                let subtype = record.get("subtype").and_then(Value::as_str).unwrap_or("");
                match subtype {
                    // §13 Compaction = "lossy (compact_boundary, no volume)"。
                    "compact_boundary" => bump(&mut coverage, Signal::Compaction, Bucket::Lossy, 1),
                    // §13 Hooks = "lossy (stop_hook_summary)"。
                    "stop_hook_summary" => bump(&mut coverage, Signal::Hooks, Bucket::Lossy, 1),
                    _ => {}
                }
            }
            "permission-mode" => {
                // §13 ApprovalPolicy = "measured (permission-mode)"——模式快照即策略。
                bump(&mut coverage, Signal::ApprovalPolicy, Bucket::Measured, 1);
            }
            _ => {} // mode/attachment/last-prompt/ai-title/file-history-*/queue-operation/… 不喂信号
        }
        // §13 SubagentSpawns：isSidechain 真本身就是子代理分支的证据。记录级去重
        // 锚点：Task 臂只认主干（守卫在上面），所以一条 sidechain 记录无论含几个
        // Task 块都只计一次（评审 P4-12）。
        if is_sidechain {
            bump(&mut coverage, Signal::SubagentSpawns, Bucket::Measured, 1);
        }
    }

    // TurnBoundaries derived，count = populate 重建出的 turn 数——coverage 与 turns
    // timeline 同源。整文件无 user 根（截断）→ 0 → 不进 SignalSet → SV612 经
    // timeline_is_empty 诚实 Unavailable（§8 问 8）。
    if turns_len > 0 {
        bump(&mut coverage, Signal::TurnBoundaries, Bucket::Derived, turns_len as u64);
    }

    let mut signals = SignalSet::EMPTY;
    for s in &Signal::ALL {
        if coverage.get(*s).total() > 0 {
            signals.insert(*s);
        }
    }

    // UsageAggregate 的存在性派生（§13 "derivable"）。
    if coverage.get(Signal::Usage).total() > 0 {
        bump(&mut coverage, Signal::UsageAggregate, Bucket::Derived, 1);
        signals.insert(Signal::UsageAggregate);
    }

    // §13 unavailable 的信号显式置零（不进 SignalSet）——不能编一个非零数字出来。
    for signal in Signal::ALL.iter().copied().filter(|s| is_unavailable(*s)) {
        coverage.set(signal, CoverageCounts::default());
    }

    unknown.sort();
    (signals, coverage, unknown)
}

// ────────────────────────── build: records → ClaudeEvidence ──────────────────────────

/// 第一条真的把 `attempts` 填起来的适配器是 codex_evidence.rs；Claude 同规矩：
/// 未知记录类型记成 `SourceAttempt { available: false }`，不当作损坏吞掉。
fn extract_model(records: &[Value]) -> Option<String> {
    records.iter().find_map(|r| {
        r.get("message")
            .and_then(|m| m.get("model"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

/// §13 Claude 列的 Workspace root = `cwd`（逐事件携带）。取第一条非空 cwd——
/// 会话的起跑目录，比「最常见的 cwd」少一次全量扫描，且同一会话内 cwd 几乎不变。
fn first_cwd(records: &[Value]) -> Vec<String> {
    records
        .iter()
        .find_map(|r| r.get("cwd").and_then(Value::as_str).map(str::to_owned))
        .map(|c| vec![c])
        .unwrap_or_default()
}

fn build_notes(coverage: &Coverage) -> Vec<AdapterNote> {
    let mut notes: Vec<AdapterNote> = Vec::new();
    if coverage.get(Signal::SkillInvocations).total() > 0 {
        notes.push(AdapterNote {
            message: "Claude Code does not persist skill invocations as structured events; SkillInvocations coverage is a derived presence lower bound from `Skill` tool calls, and offline inference may disagree with the harness's runtime decision.".to_string(),
        });
    }
    if coverage.get(Signal::TurnBoundaries).total() > 0 {
        notes.push(AdapterNote {
            // 判据是内容不是 parentUuid 树（模块文档的 886 vs 8 实测）——文案与
            // 算法一致才叫诚实，曾写 "message tree" 与 `Derived{from:"content_turn_root"}`
            // 的标签自相矛盾（评审 P4-9）。
            message: "Turn boundaries are rebuilt from the message stream (pure-text user roots), not native turn events; SV612/613(a) are Derived/Partial and rebuild failure degrades to Unavailable, never fabricated boundaries.".to_string(),
        });
    }
    if coverage.get(Signal::ApprovalDecisions).total() == 0 {
        notes.push(AdapterNote {
            message: "ApprovalDecisions is unavailable in this slice: only `permission-mode` snapshots are persisted, and per-decision recovery needs marker strings in tool-result text (RUNTIME_EVIDENCE_CONTRACT §14.5), a follow-up.".to_string(),
        });
    }
    notes
}

/// 记录数组 → `ClaudeEvidence`。五段式流水线的 "derive → coverage" 两段；
/// "locate → shape → extract" 留在 `src/agent/claude_session.rs`。
///
/// 诚实真值表（喂 Claude canonical 后每条 SV 规则的实际结果——claude-session
/// 差分测试 + fixture 自校验钉住的当前实现行为，评审 P4-10 修正「Task #30 待接线」
/// 的过时表述：轨迹级接线已落地）：
///
/// | 规则 | Claude Code |
/// |---|---|
/// | SV601–606 | 跑（§7 规范化 + args_text 确定性序列化） |
/// | SV607/608 | **Unavailable**（error_code 恒 None，原因级不可消费——SV7.4.1 门控；本适配器不伪造码） |
/// | SV609/610/614 | Unavailable（approvals / sandbox_modes 恒空） |
/// | SV611 | 跑（比较 (name, args_text)） |
/// | SV612 | Derived/Partial（turn 重建） |
/// | SV613(a) | MeasuredZero（无 error turn/end） |
/// | SV613(b) | Lossy/Partial（is_error → failed；`trajectory.rs` 连续失败检测读 `failed == Some(true)` 或 `error_code.is_some()`——DSH/Codex 的 `failed` 恒 None，布尔式退化成原判据，golden 字节零漂移） |
pub fn build_claude_evidence(
    raw_records: Vec<Value>,
    session_id: String,
) -> ClaudeEvidence {
    let mut tool_calls = Timeline::new();
    let mut tool_results = Timeline::new();
    let mut turns = Timeline::new();
    populate_claude_timelines(&raw_records, &mut tool_calls, &mut tool_results, &mut turns);

    let (signals, coverage, unknown) = derive_coverage(&raw_records, turns.entries.len());
    let attempts: Vec<SourceAttempt> = unknown
        .into_iter()
        .map(|msg| SourceAttempt {
            source_id: "claude.session.jsonl",
            kind: SourceKind::LogFile,
            surface: Surface::SessionLog,
            available: false,
            error: Some(msg),
            observed_span: None,
        })
        .collect();
    let notes = build_notes(&coverage);

    // approvals / sandbox_modes 恒空：§13 Claude 列 SandboxModes unavailable、
    // ApprovalDecisions first-slice unavailable——「故意空」的构造点，比传永不填充的
    // `&mut` 参数更诚实（同 codex_evidence.rs 的 approvals）。
    let canonical = CanonicalSession {
        meta: SessionMeta {
            session_id,
            harness_id: "claude-code",
            workspace_roots: first_cwd(&raw_records),
            model: extract_model(&raw_records),
            // D1–D4：喂进本证据的**原生记录**时间 min/max。Claude 的 `timestamp`
            // 经 `parse_iso` 出**秒**，由 `session_span` 统一归一到毫秒。
            // 0 条记录 → None（不造 (0,0)，那会被读成 1970）。
            span: crate::workflow_utils::session_span(
                raw_records
                    .iter()
                    .filter_map(|r| r.get("timestamp").and_then(Value::as_str))
                    .filter_map(parse_iso)
                    .map(|(secs, _)| secs),
            ),
        },
        signals,
        coverage,
        attempts,
        notes,
        tool_calls,
        tool_results,
        approvals: Timeline::new(),
        sandbox_modes: Timeline::new(),
        turns,
    };
    ClaudeEvidence { canonical, raw_records }
}

/// `ClaudeEvidence` → `claude-evidence --json` 的输出形状。与
/// `codex_evidence_json` 同构（signals/coverage/attempts/notes），Python 镜像
/// 逐字节对齐。
pub fn claude_evidence_json(evidence: &ClaudeEvidence) -> Value {
    let signals: Vec<String> = Signal::ALL
        .iter()
        .filter(|s| evidence.canonical.signals.contains(**s))
        .map(|s| format!("{s:?}"))
        .collect();
    let mut coverage_map = serde_json::Map::new();
    for s in &Signal::ALL {
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
        "harness": "claude-code",
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

    fn rec(typ: &str, extra: Value) -> Value {
        let mut o = serde_json::Map::new();
        o.insert("type".into(), json!(typ));
        o.insert("timestamp".into(), json!("2026-08-20T14:27:08.827Z"));
        if let Some(obj) = extra.as_object() {
            for (k, v) in obj {
                o.insert(k.clone(), v.clone());
            }
        }
        Value::Object(o)
    }

    fn user_msg(content: Value) -> Value {
        rec("user", json!({"message": {"id": "msg_u", "content": content}}))
    }

    fn assistant_tool_use(name: &str, input: Value) -> Value {
        rec("assistant", json!({"message": {
            "id": "msg_a",
            "content": [{"type": "tool_use", "id": "toolu_1", "name": name, "input": input}],
            "model": "claude-sonnet-5",
            "usage": {"input_tokens": 1, "output_tokens": 1}
        }}))
    }

    fn tool_result_user(is_error_opt: Option<bool>) -> Value {
        let mut blk = serde_json::Map::new();
        blk.insert("type".into(), json!("tool_result"));
        blk.insert("tool_use_id".into(), json!("toolu_1"));
        blk.insert("content".into(), json!("ok"));
        if let Some(e) = is_error_opt {
            blk.insert("is_error".into(), json!(e));
        }
        user_msg(Value::Array(vec![Value::Object(blk)]))
    }

    #[test]
    fn normalize_tool_maps_known_names_and_passes_unknown_through() {
        // §7 表逐条 + 未映射原样透传（不命中规则 = 诚实，不误报）。
        for (raw, want) in [
            ("Bash", "bash"), ("Write", "write"), ("Edit", "edit"), ("MultiEdit", "edit"),
            ("Read", "read"), ("Glob", "glob"), ("Grep", "grep"), ("WebFetch", "web_fetch"),
            ("WebSearch", "web_search"), ("Task", "task"), ("TodoWrite", "todo_write"),
            ("NotebookEdit", "notebook_edit"), ("SomethingNew", "SomethingNew"),
        ] {
            assert_eq!(normalize_tool_name(raw), want, "{raw}");
        }
    }

    #[test]
    fn bash_args_text_is_input_command_not_json() {
        // §7 Bash 例外：args_text 直接取 input.command（shell 字符串）。
        let input = json!({"command": "rm -rf /tmp/x", "description": "nope"});
        let (name, args) = normalize_tool("Bash", Some(&input));
        assert_eq!(name, "bash");
        assert_eq!(args, "rm -rf /tmp/x");
    }

    #[test]
    fn args_text_is_deterministic_regardless_of_key_order() {
        // SV611 把键序不同、语义相同的参数识别成不同调用的风险：canonical 序列化
        // 必须给出同串。
        let a = json!({"b": 1, "a": {"y": 2, "x": 1}});
        let b = json!({"a": {"x": 1, "y": 2}, "b": 1});
        let (_, ta) = normalize_tool("Read", Some(&a));
        let (_, tb) = normalize_tool("Read", Some(&b));
        assert_eq!(ta, tb);
        assert_eq!(ta, r#"{"a":{"x":1,"y":2},"b":1}"#);
    }

    #[test]
    fn turn_root_is_content_based_not_parent_null() {
        // 真机 886 vs 8 的实测：parentUuid 非 null 的纯文本 user 也必须是 turn 根。
        let records = vec![
            rec("user", json!({"uuid": "a", "parentUuid": "p0", "message": {"id": "m1", "content": "prompt one"}})),
            assistant_tool_use("Bash", json!({"command": "ls"})),
            rec("user", json!({"uuid": "b", "parentUuid": "a1", "message": {"id": "m2", "content": "prompt two"}})),
        ];
        let mut tc = Timeline::new();
        let mut tr = Timeline::new();
        let mut turns = Timeline::new();
        populate_claude_timelines(&records, &mut tc, &mut tr, &mut turns);
        assert_eq!(turns.entries.len(), 2, "两个纯文本 user → 两个 turn，不看 parentUuid");
        assert_eq!(turns.entries[0].observation.turn, 0);
        assert_eq!(turns.entries[1].observation.turn, 1);
        assert_eq!(tc.entries.len(), 1);
        // 第一个 turn 的 sig 只含 turn 内的 bash（第二个 turn 里没有工具调用）。
        assert_eq!(turns.entries[0].observation.sig, vec![("bash".to_string(), "ls".to_string())]);
        assert!(turns.entries[1].observation.sig.is_empty());
    }

    #[test]
    fn tool_result_user_does_not_open_a_turn() {
        // §8 问 4：含 tool_result 块的 user 是续写，不是新 turn。
        let records = vec![
            user_msg(json!("prompt")),
            assistant_tool_use("Bash", json!({"command": "ls"})),
            tool_result_user(Some(false)),
        ];
        let mut tc = Timeline::new();
        let mut tr = Timeline::new();
        let mut turns = Timeline::new();
        populate_claude_timelines(&records, &mut tc, &mut tr, &mut turns);
        assert_eq!(turns.entries.len(), 1);
        assert_eq!(tr.entries.len(), 1);
        assert_eq!(tr.entries[0].observation.failed, Some(false));
        assert_eq!(tr.entries[0].observation.error_code, None);
        // 续写的 tool_result 归属 open turn（turn 0）。
        assert_eq!(tr.entries[0].turn, Some(0));
    }

    #[test]
    fn is_error_three_state_maps_to_failed_with_honest_provenance() {
        // true → failed=Some(true) lossy；false → Some(false) lossy；缺失 → None measured。
        let records = vec![
            tool_result_user(Some(true)),
            tool_result_user(Some(false)),
            tool_result_user(None),
        ];
        let mut tc = Timeline::new();
        let mut tr = Timeline::new();
        let mut turns = Timeline::new();
        populate_claude_timelines(&records, &mut tc, &mut tr, &mut turns);
        assert_eq!(tr.entries.len(), 3);
        assert_eq!(tr.entries[0].observation.failed, Some(true));
        assert!(matches!(tr.entries[0].provenance, Provenance::Lossy { .. }));
        assert_eq!(tr.entries[1].observation.failed, Some(false));
        assert!(matches!(tr.entries[1].provenance, Provenance::Lossy { .. }));
        assert_eq!(tr.entries[2].observation.failed, None);
        assert!(matches!(tr.entries[2].provenance, Provenance::Measured));
        // error_code 恒 None——绝不伪造原因码（§3）。
        for e in &tr.entries {
            assert_eq!(e.observation.error_code, None);
        }
        // 无纯文本 user 根 → turns 空 → TurnBoundaries Unavailable（§8 问 8）。
        assert!(turns.entries.is_empty());
    }

    #[test]
    fn sidechain_excluded_from_turn_boundaries_and_sig() {
        // §8 问 2：isSidechain 分支不进 turn 边界、不进任何 turn 的 sig；工具调用
        // 本身照常记录（turn=None）。
        let records = vec![
            user_msg(json!("prompt")),
            assistant_tool_use("Bash", json!({"command": "ls"})),
            rec("assistant", json!({"isSidechain": true, "message": {
                "id": "msg_side", "content": [{"type": "tool_use", "id": "toolu_side", "name": "Bash", "input": {"command": "rm -rf /tmp"}}]
            }})),
            user_msg(json!("next prompt")),
        ];
        let mut tc = Timeline::new();
        let mut tr = Timeline::new();
        let mut turns = Timeline::new();
        populate_claude_timelines(&records, &mut tc, &mut tr, &mut turns);
        assert_eq!(turns.entries.len(), 2);
        assert_eq!(tc.entries.len(), 2);
        // 主干 turn 的 sig 不含 sidechain 的 rm。
        assert_eq!(turns.entries[0].observation.sig, vec![("bash".to_string(), "ls".to_string())]);
        // sidechain tool_use turn=None。
        assert_eq!(tc.entries[1].turn, None);
    }

    #[test]
    fn build_produces_claude_harness_id_and_empty_approvals_and_measured_usage_dedup() {
        // usage 在跨行重复时只计一次（message.id 去重），Usage measured。
        let records = vec![
            rec("user", json!({"message": {"id": "m0", "content": "hi"}})),
            rec("assistant", json!({"message": {"id": "msg_a", "model": "claude-sonnet-5", "usage": {"x": 1}, "content": [{"type": "text", "text": "t"}]}})),
            // 同一 message.id 的第二行：usage 重复，去重后不计第二次。
            rec("assistant", json!({"message": {"id": "msg_a", "model": "claude-sonnet-5", "usage": {"x": 1}, "content": [{"type": "tool_use", "id": "tu1", "name": "Write", "input": {"path": "/etc/x", "content": "y"}}]}})),
        ];
        let evidence = build_claude_evidence(records, "s1".to_string());
        assert_eq!(evidence.canonical.meta.harness_id, "claude-code");
        assert_eq!(evidence.canonical.meta.model.as_deref(), Some("claude-sonnet-5"));
        assert!(evidence.canonical.approvals.entries.is_empty());
        assert!(evidence.canonical.sandbox_modes.entries.is_empty());
        assert_eq!(evidence.canonical.coverage.get(Signal::Usage).measured, 1, "跨行 usage 只计一次");
        assert_eq!(evidence.canonical.coverage.get(Signal::StepBoundaries).derived, 1, "同一 assistant message 只算一个 step");
        assert_eq!(evidence.canonical.coverage.get(Signal::FileMutations).derived, 1, "Write 工具调用 → FileMutations derived");
        // 时序：turns 有 1 个（根 m0），ToolCalls 有 1（tu1），ToolResults 0。
        assert_eq!(evidence.canonical.coverage.get(Signal::TurnBoundaries).derived, 1);
        assert_eq!(evidence.canonical.tool_calls.entries.len(), 1);
        // usage 去重后的 signals 含 Usage + UsageAggregate。
        assert!(evidence.canonical.signals.contains(Signal::Usage));
        assert!(evidence.canonical.signals.contains(Signal::UsageAggregate));
    }

    #[test]
    fn unknown_record_type_is_a_source_attempt_not_silently_dropped() {
        let records = vec![
            user_msg(json!("hi")),
            rec("hologram-beacon", json!({"message": {"id": "m1"}})),
        ];
        let evidence = build_claude_evidence(records, "s1".to_string());
        assert_eq!(evidence.canonical.attempts.len(), 1);
        assert!(evidence.canonical.attempts[0].error.as_deref().unwrap().contains("hologram-beacon"));
        assert!(!evidence.canonical.attempts[0].available);
    }

    #[test]
    fn json_shape_lists_signals_in_declaration_order_and_marks_unavailable() {
        let records = vec![
            rec("user", json!({"message": {"id": "m0", "content": "hi"}})),
            rec("permission-mode", json!({})),
        ];
        let evidence = build_claude_evidence(records, "s1".to_string());
        let j = claude_evidence_json(&evidence);
        assert_eq!(j["harness"], "claude-code");
        // TurnBoundaries derived 计入 signals；SandboxModes unavailable 且不在 signals。
        let cov = j["coverage"].as_object().unwrap();
        assert_eq!(cov["SandboxModes"]["available"], json!(false));
        assert_eq!(cov["ApprovalDecisions"]["available"], json!(false));
        assert_eq!(cov["ApprovalPolicy"]["measured"], json!(1));
        let sigs: Vec<&str> = j["signals"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        assert!(sigs.contains(&"ApprovalPolicy"));
        assert!(!sigs.contains(&"SandboxModes"));
    }

    #[test]
    fn ordinals_are_unique_across_all_three_timelines_and_bridge_emits_distinct_evt_ids() {
        // `evt-{ordinal}` 契约（compatibility/canonical_session.rs 模块文档声称的
        // 安全前提）：跨 tool_calls/tool_results/turns 的 entry 序号必须唯一。曾犯
        // 的两种错——flush_turn 硬编码 0、一条 message 多块共用记录序——都产出
        // 重复 evt-{n}，bridge 后事件 id 撞号、按 ordinal 排序错乱。夹具必须两条
        // 都踩到：一条 assistant 记录带两个 tool_use 块、一条 user 记录带两个
        // tool_result 块、两个纯文本 turn 根（turn 的 flush 穿插在中间）。
        let records = vec![
            rec("user", json!({"message": {"id": "m1", "content": "第一轮"}})),
            rec("assistant", json!({"message": {"id": "m2", "content": [
                {"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "ls"}},
                {"type": "tool_use", "id": "tu2", "name": "Write", "input": {"file_path": "/a"}},
            ]}})),
            rec("user", json!({"message": {"id": "m3", "content": [
                {"type": "tool_result", "tool_use_id": "tu1", "content": "ok", "is_error": true},
                {"type": "tool_result", "tool_use_id": "tu2", "content": "ok"},
            ]}})),
            rec("user", json!({"message": {"id": "m4", "content": "第二轮"}})),
            rec("assistant", json!({"message": {"id": "m5", "content": [
                {"type": "tool_use", "id": "tu3", "name": "Bash", "input": {"command": "git status"}},
            ]}})),
        ];
        let mut tc = Timeline::new();
        let mut tr = Timeline::new();
        let mut turns = Timeline::new();
        populate_claude_timelines(&records, &mut tc, &mut tr, &mut turns);
        assert_eq!(tc.entries.len(), 3);
        assert_eq!(tr.entries.len(), 2);
        assert_eq!(turns.entries.len(), 2);

        // 两把尺各司其职：seq = 记录序（同记录多块共享），ordinal = entry 唯一序。
        assert_eq!(tc.entries[0].seq, Some(1));
        assert_eq!(tc.entries[1].seq, Some(1));
        assert_eq!(tr.entries[0].seq, Some(2));
        assert_eq!(tr.entries[1].seq, Some(2));

        // 跨三条 timeline 收集 ordinal：两两不同（旧代码这里给出 [0, 0, 0, 1, 2, 4, 5]）。
        let mut ordinals: Vec<usize> = tc.entries.iter().map(|e| e.ordinal).collect();
        ordinals.extend(tr.entries.iter().map(|e| e.ordinal));
        ordinals.extend(turns.entries.iter().map(|e| e.ordinal));
        let mut uniq = ordinals.clone();
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(uniq.len(), ordinals.len(), "ordinals 必须两两不同: {ordinals:?}");
        ordinals.sort_unstable();
        assert_eq!(ordinals, vec![0, 1, 2, 3, 4, 5, 6]);

        // bridge 层面（真实消费方）：事件 id 唯一、按 ordinal 排序后 = 会话时序。
        let evidence = build_claude_evidence(records, "s1".to_string());
        let events = agent_vitals_domain::compatibility::canonical_session::canonical_session_to_vitals(
            &evidence.canonical).unwrap();
        assert_eq!(events.len(), 7);
        let ids: Vec<&str> = events.iter().map(|e| e.id.as_str()).collect();
        let mut id_uniq = ids.clone();
        id_uniq.sort_unstable();
        id_uniq.dedup();
        assert_eq!(id_uniq.len(), ids.len(), "事件 id 必须唯一: {ids:?}");
        // 前 4 条 = 第一轮的两个 tool_call + 两个 tool_result（续写紧跟调用）。
        assert_eq!(ids[..4], ["evt-0", "evt-1", "evt-2", "evt-3"]);
        assert_eq!(events[0].kind, "agent.tool_call");
        assert_eq!(events[1].kind, "agent.tool_call");
        assert_eq!(events[2].kind, "agent.tool_result");
        assert_eq!(events[3].kind, "agent.tool_result");
        // 第 5 条 = 第一轮的 turn 收尾，最后两条 = 第二轮 tool_call + turn。
        assert_eq!(ids[4..], ["evt-4", "evt-5", "evt-6"]);
        assert_eq!(events[4].kind, "agent.turn");
        assert_eq!(events[5].kind, "agent.tool_call");
        assert_eq!(events[6].kind, "agent.turn");
    }
}
