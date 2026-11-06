//! P4 of the runtime evidence model (`docs/RUNTIME_EVIDENCE_CONTRACT.md` §17).
//!
//! Codex 适配器的 "derive → coverage" 两段（五段式流水线 locate → shape →
//! extract → derive → coverage，"locate → shape → extract" 留在
//! `src/codex_session.rs`，I/O 不在这里）。它把一份 rollout JSONL 里抽出的
//! 原始条目折成 `evidence::CanonicalSession`，覆盖计数按
//! `docs/RUNTIME_EVIDENCE_CONTRACT.md` §13 harness coverage matrix 的 **Codex
//! (Legacy) 与 Codex (Paginated) 两列**逐条对应。
//!
//! **P4 的验收标准是单个词 "sound"**：Codex 是唯一一个在两种互不兼容的词表
//! （`ThreadHistoryMode` 的 Legacy / Paginated，见 §14.1）之间不自我声明、
//! 必须靠探测内容区分的执行环境。如果加这一个执行环境、两种形状会逼着共享类型层
//! （`CanonicalSession`/`Coverage`/`RuleSpec`，P1 落地）做结构性改动，这个
//! 模型就失败了。这里的职责就是证明它不用改——本文件**不修改 evidence.rs
//! 的任何类型**，只用它们；`shared_type_layer_has_no_harness_identifiers_in_code`
//! 测试继续绿就是那份证明的自动化形态。
//!
//! **§14.1 的 Rust 枚举名不是线格式。** 文档自己也承认格式无版本、靠兼容
//! shim 演进（§14.4），本机 51 份真实 rollout 实测出的 `event_msg.type` /
//! `item_completed.payload.item.type` / `response_item.payload.type` 三套
//! **snake_case / PascalCase 线格式**才是权威。下面的映射表直接以实测词表为
//! 准（见本文件脚注的完整枚举），不是为了省事抄 §14.1。
//!
//! **不是 trait**——理由同 `dsh_evidence.rs`：执行环境之间差的是"哪些阶段
//! 存在"，trait 会强迫每个执行环境实现一堆空方法。
//!
//! `CodexEvidence` 把 `CanonicalSession`（§12 规定不持有任何执行环境专属 payload）
//! 和它派生自的原始条目捆在一起——将来把 SV 规则迁到 Codex 上时，规则引擎
//! 需要原始条目，跟 DSH 的 `DshEvidence` 同一个理由、同一个形状。

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use agent_vitals_domain::contracts::evidence::{
    AdapterNote, CanonicalSession, Coverage, CoverageCounts, Provenance, SandboxModeObservation,
    SessionMeta, Signal, SignalSet, SourceAttempt, SourceKind, Surface, Timeline, TimelineEntry,
    ToolCallObservation, ToolResultObservation, TurnObservation,
};

/// Codex 适配器一次审计的产物：`CanonicalSession` + 它派生自的原始条目。
/// `history_mode`/`cli_version`/`title` 是 provenance（`session_meta` 里读出来的
/// 前两个；`title` 是 `~/.codex/session_index.jsonl` 查出的 `thread_name`），
/// 只进报告不参与计数。`title` 是 **Codex 专属字段**，所以放 evidence 顶层而
/// 不是 `CanonicalSession`（§12 铁律「执行环境专属字段不进共享类型层」）——与
/// `history_mode`/`cli_version` 同一个位置。
pub struct CodexEvidence {
    pub canonical: CanonicalSession,
    pub items: Vec<Value>,
    pub title: Option<String>,
    pub history_mode: Option<String>,
    pub cli_version: Option<String>,
}

// ────────────────────────── 词表：实测 + §14.1 补缺 ──────────────────────────

/// 顶层 `{type, timestamp, payload}` 包络的已知 type 值。实测（本机 51 份
/// rollout）出现 7 种；`compacted` 是顶层独立类型（带着 `replacement_history`，
/// §13 Compaction 行 "measured (+ replacement_history)" 的来源）。
const KNOWN_TOP_LEVEL_TYPES: &[&str] = &[
    "session_meta",
    "turn_context",
    "event_msg",
    "response_item",
    "world_state",
    "compacted",
    "inter_agent_communication_metadata",
];

/// `event_msg.payload.type` 的已知值。实测 17 种（Legacy 词表 + Paginated 的
/// `item_completed` 载体）。`HookPrompt` 是 §14.1 文档里有、本机语料没采样到
/// 的 Paginated item——不是 event，所以这里不放。
const KNOWN_EVENT_TYPES: &[&str] = &[
    "agent_message",
    "agent_reasoning",
    "context_compacted",
    "image_generation_end",
    "item_completed",
    "mcp_tool_call_end",
    "patch_apply_end",
    "sub_agent_activity",
    "task_complete",
    "task_started",
    "thread_goal_updated",
    "thread_rolled_back",
    "thread_settings_applied",
    "token_count",
    "turn_aborted",
    "user_message",
    "web_search_end",
];

/// `event_msg.payload.type == "item_completed"` 时 `payload.item.type` 的已知值
/// （Paginated 的 TurnItem 词表）。实测 13 种；`HookPrompt` 是 §14.1 文档
/// 明确列出的 TurnItem 变体，本机语料没采样到（n=2 份 Paginated 太小，不能
/// 当"不存在"，见 docs §14.1 与 `codex-corpus-facts` 记忆）。
const KNOWN_ITEM_TYPES: &[&str] = &[
    "AgentMessage",
    "CollabAgentToolCall",
    "CommandExecution",
    "ContextCompaction",
    "DynamicToolCall",
    "Extension",
    "FileChange",
    "HookPrompt",
    "ImageView",
    "McpToolCall",
    "Plan",
    "Reasoning",
    "SubAgentActivity",
    "UserMessage",
];

/// `response_item.payload.type` 的已知值。实测 9 种。
const KNOWN_RESPONSE_TYPES: &[&str] = &[
    "agent_message",
    "custom_tool_call",
    "custom_tool_call_output",
    "function_call",
    "function_call_output",
    "message",
    "reasoning",
    "tool_search_call",
    "tool_search_output",
];

/// A `message/user` can contain harness-injected context rather than a human
/// prompt. Inspect only known wrapper prefixes and never retain the body.
enum UserPromptKind { Human, AmbientOnly, Mixed, Unknown }

fn user_prompt_kind(payload: &Map<String, Value>) -> UserPromptKind {
    let Some(parts) = payload.get("content").and_then(|v| v.as_array()) else {
        return UserPromptKind::Unknown;
    };
    let mut nonempty = 0usize;
    let mut ambient = 0usize;
    for part in parts {
        let Some(text) = part.get("text").and_then(|v| v.as_str()) else {
            return UserPromptKind::Unknown;
        };
        let text = text.trim();
        if text.is_empty() { continue; }
        nonempty += 1;
        if ["<recommended_plugins>", "<environment_context>", "<skills_instructions>",
            "<permissions instructions>", "<collaboration_mode>", "<apps_instructions>",
            "<plugins_instructions>"].iter().any(|p| text.starts_with(p)) {
            ambient += 1;
        }
    }
    if nonempty == 0 { UserPromptKind::Unknown }
    else if ambient == nonempty { UserPromptKind::AmbientOnly }
    else if ambient > 0 { UserPromptKind::Mixed }
    else { UserPromptKind::Human }
}

/// 一个条目在哪个命名空间、叫什么类型。`Unknown` 的字符串是"要记进 attempts
/// 的报错文本"，已去重。
enum Classification {
    Known,
    Unknown(String),
}

/// 顶层 type 在不在已知表里；在的话，按命名空间往下看内层 type 认不认得。
/// 任何一层不认识 → `Unknown("<命名空间>/<type>")`，调用方把它记进
/// `attempts`（§14.4："unknown item types are skipped and recorded in
/// attempts, never treated as corruption"）——这是 P4 顺带证明的第一条
/// `SourceAttempt` 真实使用（DSH 的 attempts 一直是空的）。
///
/// **已知但恰好不映射到任何 Signal 的条目（`reasoning` / `agent_reasoning` /
/// `world_state` …）直接跳过，不记 attempts**——`attempts` 只记"不认识"的，
/// 不记"认识但恰好不喂信号"的，否则一份真实会话会因为这类高频条目刷出
/// 一墙噪音。
fn classify(item: &Value) -> Classification {
    let top = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if !KNOWN_TOP_LEVEL_TYPES.contains(&top) {
        return Classification::Unknown(format!("unknown record type: {top}"));
    }
    let Some(payload) = item.get("payload").and_then(|v| v.as_object()) else {
        return Classification::Known; // 没有 payload 的 record 是合法的（如 session_meta 可能极简）
    };
    let inner = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    // 三段独立的存在性探测。用 match guard + 一个 if 的平铺写法，避免
    // "if 套 if" 的嵌套控制流（clippy collapsible-match 会拦）。
    let unknown_msg: Option<String> = match top {
        "event_msg" if !KNOWN_EVENT_TYPES.contains(&inner) => {
            Some(format!("unknown event type: {inner}"))
        }
        "event_msg" if inner == "item_completed" => {
            // item_completed 是 Paginated 的载体：再往下探一层 item.type。
            let item_type = payload
                .get("item")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !KNOWN_ITEM_TYPES.contains(&item_type) {
                Some(format!("unknown item type: {item_type}"))
            } else {
                None
            }
        }
        "response_item" if !KNOWN_RESPONSE_TYPES.contains(&inner) => {
            Some(format!("unknown response item type: {inner}"))
        }
        _ => None,
    };
    match unknown_msg {
        Some(msg) => Classification::Unknown(msg),
        None => Classification::Known,
    }
}

// ────────────────────────── coverage 计数 ──────────────────────────

/// `CoverageCounts` 里四个互斥计数桶之一——Codex 的一个条目能同时喂多个
/// Signal（`CommandExecution` 同时是 ToolCalls 和 ToolResults 的载体），每个
/// 桶独立累加，不是 DSH 那种"一个事件类型只进一个 Signal"的覆盖式 `set`。
#[derive(Clone, Copy)]
enum Bucket {
    Measured,
    Derived,
    Lossy,
}

/// 往某个 Signal 的某个桶里加计数。`CoverageCounts` 是 `Copy`，取出来改了
/// 再放回去即可；`signals` 集合的成员资格统一在收尾时按 total>0 补。
fn bump(coverage: &mut Coverage, signal: Signal, bucket: Bucket, n: u64) {
    if n == 0 {
        return;
    }
    let mut c = coverage.get(signal);
    match bucket {
        Bucket::Measured => c.measured += n,
        Bucket::Derived => c.derived += n,
        Bucket::Lossy => c.lossy += n,
    }
    coverage.set(signal, c);
}

/// 顶层/event/item/response 四个来源的计数。返回 `(signals, coverage, 未知类型
/// 的报错列表)`——报错是 §14.4 要求记进 `attempts` 的那份"skipped, never
/// corruption"清单，去重后按字典序排序，保证跨语言字节一致。
///
/// 映射表逐条对应 §13 的 Codex 两列（Legacy / Paginated 同列时说明两套词表
/// 都覆盖；分列时标在注释里）：
///
/// | Signal | 来源（命名空间:type） | §13 列 |
/// |---|---|---|
/// | ToolCalls | event_msg:`mcp_tool_call_end`,`web_search_end`; item:`McpToolCall`,`DynamicToolCall`,`CollabAgentToolCall`,`CommandExecution`,`Extension`; response_item:`custom_tool_call`,`function_call`,`tool_search_call` | 两列 measured |
/// | ToolResults | response_item:`custom_tool_call_output`,`function_call_output`,`tool_search_output`; item:`CommandExecution`（带 stdout/stderr/exit_code） | 两列 measured |
/// | TurnBoundaries | event_msg:`task_started`,`task_complete` | 两列 measured |
/// | Usage | event_msg:`token_count`（逐请求时间序列） | 两列 measured (6 buckets) |
/// | UsageAggregate | 有 token_count 时 `derived(1)`（只有总量无逐请求——不对，token_count 有逐请求；这里照 DSH 的 UsageAggregate 语义标 derived(1) 只做存在性） | derivable |
/// | ContextWindow | event_msg:`token_count` 且 `payload.info.model_context_window` 在 | 两列 measured |
/// | ApprovalDecisions | item:`FileChange` 且 `payload.item.auto_approved` 非空——§13 Paginated 列 "partial (`FileChangeItem.auto_approved`)"。本机语料 60 份 FileChange 全都没带这字段（见 codex-corpus-facts 记忆），所以真实语料大概率走不到这条；Legacy 列 unavailable（`policy.rs` 不持久化 ExecApprovalRequest） | 两列 unavailable/partial |
/// | ApprovalPolicy | event_msg:`thread_settings_applied`（`payload.thread_settings.approval_policy`）; 顶层 `turn_context`（`payload.approval_policy`）——§14.2：两种 mode 都持久化策略 | 两列 measured |
/// | SandboxModes | 顶层 `turn_context` 的 `payload.sandbox_policy`——真实线格式是对象 `{type:"danger-full-access"}`，旧 fixture 是字符串 `"workspace-write"`，两态都数（2026-08 从 unavailable 改 measured 时发现的线格式漂移，P4.5 sentinel 早该抓到） | 两列 measured |
/// | SandboxPolicy | §13 矩阵没有 Codex 列——照 DSH 的规矩 unavailable，不编造 | — |
/// | NetworkAccess | 无来源 | 两列 unavailable |
/// | Compaction | event_msg:`context_compacted`; item:`ContextCompaction`; 顶层 `compacted`（带 `replacement_history`） | 两列 measured |
/// | SubagentSpawns | event_msg:`sub_agent_activity`; item:`SubAgentActivity`（`agent_thread_id` 给 parent→child 链） | 两列 measured |
/// | SkillInvocations | **不 port Codex 的启发式**（§14.3：`detect_implicit_skill_invocation_for_command` 不持久化，离线只能 Derived；"Do not port... 第五份平行实现比诚实的 Derived 标记更糟"）。这里只做存在性下界：有任何工具执行形态的证据 → `derived(1)`，并附一条 AdapterNote 说明离线推断可能与执行环境运行时决定不一致 | 两列 derived |
/// | Hooks | item:`HookPrompt`（§14.1；本机语料没采样到）——Legacy 无 | 两列 unavailable/measured |
/// | FileMutations | event_msg:`patch_apply_end`（lossy，只有 end 没有变更明细）; item:`FileChange`（measured，带 changes/status） | 两列 lossy/measured |
/// | StepBoundaries | 无来源 | 两列 unavailable |
///
/// **"Tool-call duration" 不在上表里**——20 个 `Signal` 没有它的变体。
/// `CommandExecutionItem.duration` 是**值**不是通道：它跟着 item 走，将来做
/// duration 折叠（DSH `duration-audit` 的同款路径）时从原始条目上读即可。
/// P4 的 "sound" 恰好体现在这里：吸收 Paginated 的 duration 不需要给共享
/// 类型层开新槽。
/// | UserPrompts | response_item:`message` + `role:"user"`（真实线格式，正文在 `content[].text`；2026-08 实测 session 01a029cb 15 条） | measured |
/// | UserCorrections | 无任何执行环境的参考实现（§3.2 的关键词/时间窗启发未移植，DSH 也显式置零） | unavailable |
/// §13 没有 Codex 列 / 明确 unavailable 的信号。`derive_coverage` 的置零与
/// `codex_evidence_json` 的 `available` 标记共用同一份清单，不准两处各写一份
/// 漂移（UserPrompts 2026-08 起 measured，不在其中；UserCorrections 的定义
/// 是 §3.2 的关键词/时间窗启发，没有任何执行环境有参考实现，移植即发明）。
/// v0.6 harness-contract spec §6/§11-M2a：执行环境级 unmeasured 声明不再是本文件的
/// 字面量表，改从 core `harness_capability::HARNESSES` 的 "codex" 行读（行上的值就
/// 是从这个函数原来的字面量表搬过去的，golden 字节不变）。
fn is_unavailable(signal: Signal) -> bool {
    agent_vitals_domain::contracts::harness_capability::harness_profile("codex")
        .is_some_and(|h| h.unmeasured_signals.contains(&signal))
}

fn derive_coverage(items: &[Value]) -> (SignalSet, Coverage, Vec<String>) {
    let mut coverage = Coverage::new();
    let mut unknown: Vec<String> = Vec::new();

    for item in items {
        match classify(item) {
            Classification::Unknown(msg) => {
                if !unknown.contains(&msg) {
                    unknown.push(msg);
                }
            }
            Classification::Known => {}
        }

        let Some(payload) = item.get("payload").and_then(|v| v.as_object()) else {
            continue;
        };
        let inner = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match item.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "event_msg" => match inner {
                "mcp_tool_call_end" | "web_search_end" => {
                    bump(&mut coverage, Signal::ToolCalls, Bucket::Measured, 1);
                }
                "task_started" | "task_complete" => {
                    bump(&mut coverage, Signal::TurnBoundaries, Bucket::Measured, 1);
                }
                "token_count" => {
                    bump(&mut coverage, Signal::Usage, Bucket::Measured, 1);
                    // 只有 rate_limits 真是 object 才计 QuotaConsumption——键存在但
                    // 值为 null（真实线格式偶尔如此）不是配额证据，is_some() 会
                    // 把 null 也 bump 成 1（LOW-5：与 usage_shaped 哨兵的「宽进」不
                    // 冲突——这里是覆盖计数，宽进会虚增 measured）。
                    if payload.get("rate_limits").is_some_and(|v| v.is_object()) {
                        bump(&mut coverage, Signal::QuotaConsumption, Bucket::Measured, 1);
                    }
                    // 常驻上下文窗口（model_context_window）在 payload.info 里——
                    // 与逐请求 token 分离，§13 ContextWindow 行的来源。
                    let has_window = payload
                        .get("info")
                        .and_then(|v| v.get("model_context_window"))
                        .and_then(|v| v.as_u64())
                        .is_some();
                    if has_window {
                        bump(&mut coverage, Signal::ContextWindow, Bucket::Measured, 1);
                    }
                }
                "thread_settings_applied" => {
                    // §14.2：ThreadSettingsSnapshot 两种 mode 都持久化，携带
                    // approval_policy（AskForApproval）。策略是"设置了策略"这
                    // 件事的载体，数它即可，不解析策略值。
                    let has_policy = payload
                        .get("thread_settings")
                        .and_then(|v| v.get("approval_policy"))
                        .is_some();
                    if has_policy {
                        bump(&mut coverage, Signal::ApprovalPolicy, Bucket::Measured, 1);
                    }
                }
                "patch_apply_end" => {
                    // §13 FileMutations (Legacy) = "lossy (patch_apply_end only)"——
                    // 只有 end，没有变更明细，进 lossy 桶。
                    bump(&mut coverage, Signal::FileMutations, Bucket::Lossy, 1);
                }
                "context_compacted" => {
                    bump(&mut coverage, Signal::Compaction, Bucket::Measured, 1);
                }
                "sub_agent_activity" => {
                    bump(&mut coverage, Signal::SubagentSpawns, Bucket::Measured, 1);
                }
                "item_completed" => {
                    let item_type = payload
                        .get("item")
                        .and_then(|v| v.get("type"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    classify_item(&mut coverage, item_type, payload);
                }
                _ => {} // agent_message/agent_reasoning/user_message/turn_aborted/... 不喂信号
            },
            "response_item" => match inner {
                "custom_tool_call" | "function_call" | "tool_search_call" => {
                    bump(&mut coverage, Signal::ToolCalls, Bucket::Measured, 1);
                }
                "custom_tool_call_output" | "function_call_output" | "tool_search_output" => {
                    bump(&mut coverage, Signal::ToolResults, Bucket::Measured, 1);
                }
                "message" if payload.get("role").and_then(|v| v.as_str()) == Some("user") => {
                    match user_prompt_kind(payload) {
                        UserPromptKind::Human | UserPromptKind::Mixed => bump(&mut coverage, Signal::UserPrompts, Bucket::Measured, 1),
                        UserPromptKind::Unknown => bump(&mut coverage, Signal::UserPrompts, Bucket::Lossy, 1),
                        UserPromptKind::AmbientOnly => {},
                    }
                }
                _ => {} // reasoning/agent_message 不喂信号
            },
            "turn_context" => {
                // 顶层 turn_context 也携带 approval_policy（实测字段）——与
                // thread_settings_applied 同源不同载体，数它的存在性即可。
                if payload.get("approval_policy").is_some() {
                    bump(&mut coverage, Signal::ApprovalPolicy, Bucket::Measured, 1);
                }
                // sandbox_policy 同源：真实线格式是对象 `{type}`、旧 fixture 是
                // 字符串，两态都认。populate 侧把它填进 sandbox_modes timeline，
                // 这里必须同步计数——coverage 与 timeline 同一来源，否则门控
                // 读 timeline 非空而 coverage 全零，两条账对不上。
                if has_sandbox_policy(payload) {
                    bump(&mut coverage, Signal::SandboxModes, Bucket::Measured, 1);
                }
            }
            "compacted" => {
                bump(&mut coverage, Signal::Compaction, Bucket::Measured, 1);
            }
            _ => {} // session_meta/world_state/inter_agent_communication_metadata 不喂信号
        }
    }

    let mut signals = SignalSet::EMPTY;
    for s in &Signal::ALL {
        if coverage.get(*s).total() > 0 {
            signals.insert(*s);
        }
    }

    // UsageAggregate / SkillInvocations 的存在性派生，收尾统一判——它们不依赖
    // 具体条目形态，只依赖"有没有 Usage 证据 / 有没有工具执行证据"。
    let usage_present = coverage.get(Signal::Usage).total() > 0;
    if usage_present {
        bump(&mut coverage, Signal::UsageAggregate, Bucket::Derived, 1);
        signals.insert(Signal::UsageAggregate);
    }
    let tool_exec_evidence = coverage.get(Signal::ToolCalls).total() > 0;
    if tool_exec_evidence {
        bump(&mut coverage, Signal::SkillInvocations, Bucket::Derived, 1);
        signals.insert(Signal::SkillInvocations);
    }

    // §13 没有 Codex 列 / 明确 unavailable 的信号——照 DSH 的规矩显式记全零
    // （不进 SignalSet），不能编一个非零数字出来。SandboxModes 不在其中：2026-08
    // 确认 turn_context.sandbox_policy 持久化，已改 measured（见上方映射表）。
    // UserPrompts 同样不在其中：response_item.message+role=user 是真实线格式，
    // 2026-08 已改 measured。清单统一走 is_unavailable，序列化侧同源。
    for signal in Signal::ALL.iter().copied().filter(|s| is_unavailable(*s)) {
        coverage.set(signal, CoverageCounts::default());
    }

    unknown.sort();
    (signals, coverage, unknown)
}

/// `item_completed.payload.item` 的 TurnItem 分型喂信号——单独抽出来，让
/// `derive_coverage` 的主循环只读一层。
fn classify_item(coverage: &mut Coverage, item_type: &str, payload: &serde_json::Map<String, Value>) {
    match item_type {
        // 工具执行：McpToolCall/DynamicToolCall/CollabAgentToolCall/Extension 是
        // §14.1 列出的 typed 等价物。CommandExecution 的 duration 仍保留在
        // 原始 item，但实测微秒级且不是已验证的墙钟时长，因此不喂时长信号。
        "McpToolCall" | "DynamicToolCall" | "CollabAgentToolCall" | "Extension" => {
            bump(coverage, Signal::ToolCalls, Bucket::Measured, 1);
        }
        "CommandExecution" => {
            bump(coverage, Signal::ToolCalls, Bucket::Measured, 1);
            // 带 stdout/stderr/exit_code 的执行记录同时是"结果"载体。
            bump(coverage, Signal::ToolResults, Bucket::Measured, 1);
            // `.duration`（实测 157/157 都有）是**值**不是通道——20 个 Signal
            // 里没有 ToolCallDuration 变体，P4 的 "sound" 恰好证明不需要加：
            // duration 跟着原始条目走，将来做 duration 折叠时从 item 上读即可，
            // 覆盖率模型不为它开新槽。
        }
        // FileChange：§13 Paginated FileMutations 列 measured；`auto_approved`
        // 非空时是 ApprovalDecisions 的 partial 证据（§13 Paginated 列）。
        "FileChange" => {
            bump(coverage, Signal::FileMutations, Bucket::Measured, 1);
            let auto = payload
                .get("item")
                .and_then(|v| v.get("auto_approved"))
                .is_some_and(|v| !v.is_null());
            if auto {
                bump(coverage, Signal::ApprovalDecisions, Bucket::Measured, 1);
            }
        }
        "ContextCompaction" => bump(coverage, Signal::Compaction, Bucket::Measured, 1),
        "SubAgentActivity" => bump(coverage, Signal::SubagentSpawns, Bucket::Measured, 1),
        "HookPrompt" => bump(coverage, Signal::Hooks, Bucket::Measured, 1),
        _ => {} // Plan/Reasoning/AgentMessage/UserMessage/ImageView 不喂信号
    }
}

// ────────────────────── populate: Codex wire → five timelines ──────────────────────
//
// 2026-08 把 Codex 从「5 条 timeline 恒为空」改为「原生填充」。上一轮的结论
// 「Codex wire 格式凑不齐 observation payload、硬填即编造零」基于旧 fixture，
// 被真实 rollout 纠正：Paginated 线格式其实能原生填满 4 条 timeline（approvals
// 除外）。映射规则见 `build_codex_evidence` 里那份逐条的诚实真值表。
//
// 两条翻译（L2 适配器持有执行环境词表，共享类型层不碰）：
// - `CommandExecution` → tool_calls `name:"bash"`（Codex 的 exec 翻译成 DSH 的
//   bash）。`exec≠bash` 是语义近似——Codex 的 exec 不一定是 bash，但它是 shell
//   执行，让 SV601/602/603 的 shell 规则能跑。代价：write/edit/web_fetch 这类
//   Codex 根本没有的工具名永远不命中（诚实 MeasuredZero，见真值表）。
// - `exit_code` → tool_results `error_code:"exit_code:N"`（N≠0 时）。合成码不在
//   DSH 的 DENIED_CODES 里，所以 SV607/608 不会误报，但 `error_code.is_some()`
//   让 SV613(b) 的「连续工具失败」能跑。
//
// **以 `CommandExecution` 为 tool_calls/tool_results 的主源，跳过
// `custom_tool_call`/`custom_tool_call_output`**：真实日志里 7 次 exec =
// 7 custom_tool_call + 7 CommandExecution + 7 output，同一逻辑 exec 的两份影子，
// 但 `call_id`（`call_…`）与 item `id`（`exec_…`）不相等、无 join key。两份都填
// 会双重计数、破坏 SV611 的连续重复检测。

/// `turn_context.sandbox_policy` 的存在性判定（覆盖计数用，不取值）：真实线格式
/// 是对象 `{type:"danger-full-access"}`，旧 fixture 是字符串 `"workspace-write"`，
/// 两态都认。与 `sandbox_policy_mode`（populate 取值）是同一个判定的两个读法。
fn has_sandbox_policy(payload: &Map<String, Value>) -> bool {
    match payload.get("sandbox_policy") {
        Some(Value::String(_)) => true,
        Some(Value::Object(o)) => o.contains_key("type"),
        _ => false,
    }
}

/// 取 `sandbox_policy` 的模式字符串：对象取 `.type`，字符串取自身，其他/缺失 None。
fn sandbox_policy_mode(payload: &Map<String, Value>) -> Option<String> {
    match payload.get("sandbox_policy") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Object(o)) => o.get("type").and_then(|v| v.as_str()).map(str::to_owned),
        _ => None,
    }
}

/// 从 `CommandExecution.item.command` 数组抽命令文本：剥掉 `/bin/zsh -lc …` /
/// `bash -c …` 这类 shell 前缀（解释器 + 紧跟的 `-*` 标志段），剩下的 join 成串。
/// 剥前缀是让 SV601-603 的正则在命令本体上匹配，不是把命令改掉。
fn command_text(item: &Map<String, Value>) -> String {
    let Some(command) = item.get("command").and_then(|v| v.as_array()) else {
        return String::new();
    };
    let mut parts: Vec<&str> = command.iter().filter_map(|v| v.as_str()).collect();
    if let Some(first) = parts.first() {
        let basename = first.rsplit('/').next().unwrap_or(first);
        if matches!(basename, "zsh" | "bash" | "sh" | "dash" | "ksh") {
            let mut rest = &parts[1..];
            if rest.first().is_some_and(|f| f.starts_with('-')) {
                rest = &rest[1..];
            }
            parts = rest.to_vec();
        }
    }
    parts.join(" ")
}

/// task_complete 的 `error` 对象 → 字符串错误码的防御性抽取。真实日志/fixture 全
/// 是 null（本机 51 份语料无一份带非 null 的 task_complete.error），所以这只看做
/// 结构保险：有 `codex_error_info.code` 用它的，否则退化成稳定标记 "error"——
/// 宁可语义含糊也不能在这里 panic 或编造一个不存在的码。
fn error_code_from(error: &Value) -> Option<String> {
    match error {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Object(o) => {
            let nested = o.get("codex_error_info").and_then(|v| v.as_object());
            nested
                .and_then(|n| n.get("code"))
                .or_else(|| o.get("code"))
                .or_else(|| o.get("type"))
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .or_else(|| Some("error".to_string()))
        }
        _ => Some("error".to_string()),
    }
}

/// `function_call_output` 的 `error`（真实日志全 null）→ `error_code` 的稳定性标记：
/// 非 null 即 `Some("error")`。SV613(b) 只判 `is_some()`，SV607/608 只认 DSH 码，
/// 所以「有没有失败」这条轴是诚实的，具体码值不值得逐对象猜。
fn output_error_code(error: &Value) -> Option<String> {
    match error {
        Value::Null => None,
        _ => Some("error".to_string()),
    }
}

/// 一条 timeline entry 的构造器。Codex 无 seq/step：`seq` 用 enumerate 序数当合成
/// seq（`NativeId::Seq` 注释「适配器内部合成的序号」的正当用法），`time`/`step`
/// 留 None。
///
/// **单位问题不在这里**（2026-09-13 更正）：Claude 的构造器填秒、Codex 填 None、
/// DSH 填毫秒，单位确实各执行环境不同；但归一**不在适配器里做**，而在 trace 边界
/// ——`domain::trace::entry_ms` 调 `domain::util::to_epoch_ms`（`_ms` 契约的唯一
/// 实现）。所以 Codex 留 None 是对的，不需要为了"统一单位"去补一个时间。
/// （原文此处写"时间轴统一是 timeaxis 阶段的事"——那个阶段从未落地，且它的规格
/// 讲的是北京时区偏移的合并，不是本字段的单位。见
/// `docs/v1.0.0/MS_FIELD_UNIT_AUDIT_2026-09-13.md` §6。）
fn timeline_entry<T>(
    observation: T,
    seq: Option<i64>,
    turn: Option<i64>,
    call_id: Option<String>,
    ordinal: usize,
) -> TimelineEntry<T> {
    // Codex 的观测值全部来自原生事件（tool/call、result、task_started/complete），
    // 逐事件 provenance 恒 Measured——turn 号的合成序数只做会话内排序，不改变
    // 边界事件本身是执行环境记下的事实。
    TimelineEntry { observation, provenance: Provenance::Measured, seq, time: None, turn, step: None, call_id, ordinal }
}

/// turn 生命周期 pass 的中间状态：task_started 开新 turn、turn 内 CommandExecution
/// 追加 `sig`、task_complete 填 `end_*` 字段、EOF 兜底 push 进 turns。与 DSH 的
/// `PendingTurn`（dsh_evidence.rs）同一个形状，但 Codex 的 turn 边界是
/// task_started/task_complete（携带字符串 `turn_id`），turn 号是**合成序数**——
/// Codex 没有数值 turn，只能按 task_started 出现序 0,1,2,… 编号（编造序数不是
/// 编造零：序数只做会话内排序，不做任何「Codex 没记录的事」）。
struct PendingCodexTurn {
    turn: i64,
    sig: Vec<(String, String)>,
    last_seq: Option<i64>,
    end_reason_kind: Option<String>,
    end_error_code: Option<String>,
    end_seq: Option<i64>,
    end_time: Option<i64>,
}

/// 按 task_started 出现序给 turn_id 分配合成序数：见过的返回旧号，新的分配
/// `map.len()`（保证 0,1,2,… 连续且按出现序递增）。
fn next_turn_ordinal(map: &mut HashMap<String, i64>, turn_id: &str) -> i64 {
    if let Some(&o) = map.get(turn_id) {
        return o;
    }
    let o = map.len() as i64;
    map.insert(turn_id.to_string(), o);
    o
}

/// 跑一遍 `items`，把 Codex 线格式翻译成五个 harness-neutral timeline（§11.5）。
/// 仿 `dsh_evidence::populate_timelines` 的状态机写法，但输入是 Codex items：
/// - `sandbox_modes`：顶层 turn_context 的 sandbox_policy（对象/字符串两态）→ 一条。
/// - `tool_calls`：`CommandExecution` → `name:"bash"` + 命令文本；`function_call` →
///   原生工具名 + arguments。**跳过** `custom_tool_call`（CommandExecution 影子）。
/// - `tool_results`：`CommandExecution` → `exit_code≠0` 时 `"exit_code:N"`；
///   `function_call_output` → `.error` 非 null 时 `"error"`。**跳过**
///   `custom_tool_call_output`（影子）。
/// - `turns`：task_started 开、task_complete 收，合成 turn 序数；turn 内
///   CommandExecution 的 (name, args_text) 进 `sig`（SV612 死循环检测的输入）。
///   `function_call` 无 turn_id，只进 tool_calls、不进任何 turn 的 sig。
///
/// Legacy 回退：从 `custom_tool_call` 的 `input`（JS 片段）里挖真 shell 命令。
///
/// `custom_tool_call{name:"exec"}` 是 **JS 沙箱工具**，不是 shell——真实日志 7/25
/// 的 679 次工具执行里，`input` 真跑的是 exec_command（474）、apply_patch（127）、
/// write_stdin（61）、view_image（23）、web__run（8）、image_gen（2）、
/// mcp__node_repl__js（1）。只有字面量 `exec_command({"cmd":"…"})` 才是 shell 命令，
/// 翻译成 `bash` 有依据；其余（JS 动态拼 cmd / 非 shell 工具）诚实跳过——SV601-603
/// 只认 `name=="bash"`，不会在 apply_patch 上误报。
///
/// quote-aware：值以 `"` 开就吃到匹配的 `"`（允许 `\"`），以 `'` 开就吃到 `'`。
/// 旧写法 `[^"']` 会在值内嵌的单引号处截断，把 `sed -n '1,240p' '…'` 截成
/// `sed -n ` 这种看着像命令的残片——args_text 必须取完整命令，正则得认全引号。
fn exec_command_cmd(input: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"exec_command\(\s*\{\s*["']cmd["']\s*:\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')"#)
            .expect("valid exec_command({cmd}) regex")
    });
    let caps = re.captures(input)?;
    // 二选一分支只有一个组参与匹配：双引号值落 group 1、单引号值落 group 2。
    caps.get(1).or_else(|| caps.get(2)).map(|m| m.as_str().to_string())
}

/// `approvals` 不在参数里：Codex 无 asked/decided 生命周期（approval_policy 是
/// 策略不是审批事件），approvals timeline 由 `build_codex_evidence` 直接构造为
/// 空——一个「故意空」的构造点，比传一个永不填充的 `&mut` 参数更诚实。
pub(crate) fn populate_codex_timelines(
    items: &[Value],
    tool_calls: &mut Timeline<ToolCallObservation>,
    tool_results: &mut Timeline<ToolResultObservation>,
    sandbox_modes: &mut Timeline<SandboxModeObservation>,
    turns: &mut Timeline<TurnObservation>,
) {
    let mut turn_ordinals: HashMap<String, i64> = HashMap::new();
    let mut pending: HashMap<String, PendingCodexTurn> = HashMap::new();
    // 未关闭 turn 的开启序——EOF 兜底时按这个序 flush，保证 turns 输出顺序确定
    // （HashMap 迭代序不定，不能直接遍历 pending）。
    let mut open_order: Vec<String> = Vec::new();

    // 线格式探测：整份 session 有没有 CommandExecution？
    // - 有（Paginated，真实 8/27：127 CommandExecution + 255 custom_tool_call）→
    //   CommandExecution 是 tool_calls 主源，custom_tool_call 是它的影子（call_id
    //   与 item.id 无 join key），跳过，否则双重计数破坏 SV611。
    // - 没有（Legacy，真实 7/25：0 item_completed，679 次工具执行全是
    //   custom_tool_call）→ 回退到 `exec_command_cmd` 从 input JS 里挖真 shell 命令。
    // coverage 侧 `custom_tool_call` 本来就计 ToolCalls measured（见 derive_coverage），
    // 回退是把 timeline 补到与覆盖一致，不是凭空造信号。
    let has_command_execution = items.iter().any(|item| {
        let Some(payload) = item.get("payload").and_then(|v| v.as_object()) else {
            return false;
        };
        payload.get("type").and_then(|v| v.as_str()) == Some("item_completed")
            && payload
                .get("item")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str())
                == Some("CommandExecution")
    });

    for (ordinal, item) in items.iter().enumerate() {
        let Some(payload) = item.get("payload").and_then(|v| v.as_object()) else {
            continue;
        };
        let seq = ordinal as i64;
        let inner = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match item.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "turn_context" => {
                if let Some(mode) = sandbox_policy_mode(payload) {
                    sandbox_modes.entries.push(timeline_entry(
                        SandboxModeObservation { mode },
                        Some(seq),
                        None,
                        None,
                        ordinal,
                    ));
                }
            }
            "event_msg" if inner == "task_started" => {
                let turn_id = payload.get("turn_id").and_then(|v| v.as_str()).unwrap_or("");
                let turn = next_turn_ordinal(&mut turn_ordinals, turn_id);
                open_order.push(turn_id.to_string());
                pending.insert(
                    turn_id.to_string(),
                    PendingCodexTurn {
                        turn,
                        sig: Vec::new(),
                        last_seq: Some(seq),
                        end_reason_kind: None,
                        end_error_code: None,
                        end_seq: None,
                        end_time: None,
                    },
                );
            }
            "event_msg" if inner == "task_complete" => {
                let turn_id = payload.get("turn_id").and_then(|v| v.as_str()).unwrap_or("");
                let started_at = payload.get("started_at").and_then(|v| v.as_i64());
                let error = payload.get("error");
                if let Some(mut p) = pending.remove(turn_id) {
                    p.last_seq = Some(seq);
                    p.end_seq = Some(seq);
                    p.end_time = started_at;
                    if let Some(e) = error {
                        if !e.is_null() {
                            p.end_reason_kind = Some("error".to_string());
                            p.end_error_code = error_code_from(e);
                        }
                    }
                    turns.entries.push(timeline_entry(
                        TurnObservation {
                            turn: p.turn,
                            sig: p.sig,
                            last_seq: p.last_seq,
                            end_reason_kind: p.end_reason_kind,
                            end_error_code: p.end_error_code,
                            end_seq: p.end_seq,
                            end_time: p.end_time,
                        },
                        Some(seq),
                        Some(p.turn),
                        None,
                        ordinal,
                    ));
                }
            }
            "event_msg" if inner == "item_completed" => {
                let item_type = payload
                    .get("item")
                    .and_then(|v| v.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if item_type == "CommandExecution" {
                    let Some(item) = payload.get("item").and_then(|v| v.as_object()) else {
                        continue;
                    };
                    let name = "bash"; // exec → bash 翻译（L2 适配器执行环境词表）
                    let args = command_text(item);
                    let turn_coord = payload
                        .get("turn_id")
                        .and_then(|v| v.as_str())
                        .and_then(|tid| turn_ordinals.get(tid).copied());
                    let call_id = item.get("id").and_then(|v| v.as_str()).map(str::to_owned);
                    tool_calls.entries.push(timeline_entry(
                        ToolCallObservation { name: name.to_string(), args_text: args.clone() },
                        Some(seq),
                        turn_coord,
                        call_id.clone(),
                        ordinal,
                    ));
                    // 结果：exit_code 非零 → 合成码 "exit_code:N"（SV613(b) 认 is_some，
                    // SV607/608 的 DSH 码集不会误报）；零 → None（成功）。
                    let exit_code = item.get("exit_code").and_then(|v| v.as_i64());
                    let error_code = exit_code.and_then(|c| (c != 0).then(|| format!("exit_code:{c}")));
                    tool_results.entries.push(timeline_entry(
                        ToolResultObservation { failed: None, error_code },
                        Some(seq),
                        turn_coord,
                        None,
                        ordinal,
                    ));
                    // 归属 turn 的 sig（按 payload.turn_id 直接归属，不依赖状态机：
                    // 该 turn 的 task_started 先到，pending 里必然在）。
                    if let Some(tid) = payload.get("turn_id").and_then(|v| v.as_str()) {
                        if let Some(p) = pending.get_mut(tid) {
                            p.sig.push((name.to_string(), args));
                        }
                    }
                }
            }
            "response_item" if inner == "custom_tool_call" => {
                // Legacy 回退：有 CommandExecution 时这分支是影子、整支跳过（见上
                // has_command_execution 注释）；没有时挖 input 里 exec_command({cmd})。
                // 只挖得出真 shell 命令的才翻成 bash；**本路径不填 tool_results**——
                // 同源 custom_tool_call_output.error 实测恒 null，无 exit/error 源，
                // 用 None 填充只是假装 MeasuredZero。规则最终结果看整份 session：
                // function_call_output 路径照常填 tool_results（error 恒 null → None），
                // 所以真机 Legacy 的 SV607/608 是 MeasuredZero 不是 Unavailable
                // （真值表见 build_codex_evidence 注释）；不进 turn sig（Legacy
                // custom_tool_call 无 turn_id，679/679 实测）。
                if !has_command_execution {
                    let input = payload.get("input").and_then(|v| v.as_str()).unwrap_or("");
                    if let Some(cmd) = exec_command_cmd(input) {
                        let call_id =
                            payload.get("call_id").and_then(|v| v.as_str()).map(str::to_owned);
                        tool_calls.entries.push(timeline_entry(
                            ToolCallObservation { name: "bash".to_string(), args_text: cmd },
                            Some(seq),
                            None,
                            call_id,
                            ordinal,
                        ));
                    }
                }
            }
            "response_item" if inner == "function_call" => {
                let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args_text = payload.get("arguments").and_then(|v| v.as_str()).unwrap_or("");
                tool_calls.entries.push(timeline_entry(
                    ToolCallObservation { name: name.to_string(), args_text: args_text.to_string() },
                    Some(seq),
                    None,
                    payload.get("call_id").and_then(|v| v.as_str()).map(str::to_owned),
                    ordinal,
                ));
            }
            "response_item" if inner == "function_call_output" => {
                let error_code = payload
                    .get("error")
                    .and_then(output_error_code);
                tool_results.entries.push(timeline_entry(
                    ToolResultObservation { failed: None, error_code },
                    Some(seq),
                    None,
                    payload.get("call_id").and_then(|v| v.as_str()).map(str::to_owned),
                    ordinal,
                ));
            }
            _ => {}
        }
    }
    // EOF 兜底：未收到 task_complete 的 turn 也 push（end_* 为 None）——SV613(a)
    // 跳过 end_seq == None 的 turn，这类 turn 只贡献 sig 给 SV612，语义与 DSH 的
    // EOF 关闭一致。
    for tid in open_order {
        if let Some(p) = pending.remove(&tid) {
            turns.entries.push(timeline_entry(
                TurnObservation {
                    turn: p.turn,
                    sig: p.sig,
                    last_seq: p.last_seq,
                    end_reason_kind: None,
                    end_error_code: None,
                    end_seq: None,
                    end_time: None,
                },
                None,
                Some(p.turn),
                None,
                0,
            ));
        }
    }
}

/// 条目数组 → `CodexEvidence`。五段式流水线的 "derive → coverage" 两段；
/// "locate → shape → extract" 留在 `src/codex_session.rs`。
///
/// 这是**第一条真的把 `attempts` 填起来**的适配器（DSH 的 attempts 一直是
/// 空 `Vec::new()`）：未知条目类型记成 `SourceAttempt { available: false,
/// error: "unknown … type: …" }`——§14.4 说 Codex 只能靠 existence probing
/// 降级，"skipped and recorded in attempts, never treated as corruption"。
pub fn build_codex_evidence(
    items: Vec<Value>,
    session_id: String,
    title: Option<String>,
    history_mode: Option<String>,
    cli_version: Option<String>,
    workspace_roots: Vec<String>,
    model: Option<String>,
) -> CodexEvidence {
    let (signals, coverage, unknown) = derive_coverage(&items);
    let attempts: Vec<SourceAttempt> = unknown
        .into_iter()
        .map(|msg| SourceAttempt {
            source_id: "codex.rollout.jsonl",
            kind: SourceKind::LogFile,
            surface: Surface::SessionLog,
            available: false,
            error: Some(msg),
            observed_span: None,
        })
        .collect();

    let mut notes: Vec<AdapterNote> = Vec::new();
    if coverage.get(Signal::SkillInvocations).total() > 0 {
        // §14.3：诚实标记 Derived，说明离线推断可能与执行环境运行时决定不一致，
        // 且明确拒绝 port 上游的 detect_implicit_skill_invocation_for_command
        //（第五份平行实现只会增加跨语言 lockstep 的维护面）。这段文本在
        // Python 镜像里逐字节相同。
        notes.push(AdapterNote {
            message: "Codex does not persist skill invocations (§14.3); SkillInvocations coverage is a derived presence lower bound, and offline inference may disagree with the harness's runtime decision. The upstream heuristic detect_implicit_skill_invocation_for_command is deliberately not ported.".to_string(),
        });
    }

    // §11.5 timeline 原生填充（2026-08）：Codex 线格式能填满 4 条（approvals
    // 除外），见 `populate_codex_timelines`。上一轮「Codex wire 格式凑不齐 payload、
    // 硬填即编造零、timeline 恒为空」的结论基于旧 fixture，被真实 rollout 纠正。
    // 诚实真值表（喂 Codex canonical 后每条 SV 规则的结果）：
    //
    // | 规则 | Paginated（CommandExecution 在） | Legacy（无 CommandExecution） |
    // |---|---|---|
    // | SV601/602/603 | 跑（exec→bash） | 跑——只挖得出 `exec_command({cmd})` 的
    //   翻 bash（真实 7/25：679 次 custom_tool_call 里 187 次），apply_patch 等
    //   非 shell 不误报 |
    // | SV604/605/606 | MeasuredZero（无 write/edit/web_fetch） | MeasuredZero |
    // | SV607/608 | MeasuredZero（`exit_code:N` ∉ DSH 码集） | MeasuredZero——
    //   custom_tool_call 路径不产 tool_results，但 function_call_output 仍填
    //   （error 恒 null → error_code None），真机 7/25 有 63 条，规则照跑零命中 |
    // | SV609 | Unavailable（approvals 空） | Unavailable |
    // | SV610 | 跑（sandbox_modes 非空） | 跑 |
    // | SV611 | 跑（重复检测） | 跑——只在挖出的 bash 子集上 |
    // | SV612 | 跑（turn sig） | MeasuredZero——custom_tool_call 与 function_call
    //   都无 turn_id，turn sig 恒空被跳过 |
    // | SV613 | 跑（a: error turn；b: exit_code） | MeasuredZero——(a) 无 error turn；
    //   (b) tool_results 的 error_code 恒 None（custom_tool_call 无 exit/error 源、
    //   function_call_output 的 error 也恒 null） |
    // | SV614 | c 可发；a/b 空转 | 同左 |
    //
    // 一个已知的诚实性代价：populate tool_calls 本身就把 Paginated 的 SV604-606/
    // 607-608 从 Unavailable 翻成 MeasuredZero——正是「门控读 timeline 而非
    // coverage」要保护的那类问题。`exec→bash` 救回 3 条 shell 规则，但
    // write/edit/web_fetch、DSH 错误码这些 Codex 没有的维度只能 MeasuredZero
    // （name-aware 门控是后续项）。Legacy 的另一半诚实性：挖不出的 non-cmd 调用
    // 不硬翻 bash（避免在 apply_patch 上误报 SV601），代价是 SV611 只覆盖
    // shell 子集——宁缺勿假。
    let mut tool_calls = Timeline::new();
    let mut tool_results = Timeline::new();
    let mut sandbox_modes = Timeline::new();
    let mut turns = Timeline::new();
    populate_codex_timelines(&items, &mut tool_calls, &mut tool_results, &mut sandbox_modes, &mut turns);
    // approvals 保持空：Codex 无审批生命周期，诚实 Unavailable（见真值表 SV609）。
    let approvals = Timeline::new();

    let canonical = CanonicalSession {
        meta: SessionMeta {
            session_id,
            harness_id: "codex",
            workspace_roots,
            model,
            // D1–D4：Codex 的顶层 `{type, timestamp, payload}` 包络**带 ISO 时间戳**，
            // 但本适配器此前没有读它（timeline entry 的 `time` 恒 None——见
            // `timeline_entry` 的注释）。这里用与 `sources/workflow.rs:31` **同一个**
            // `iso_to_epoch_ms` 读出，不新造第二个 ISO 解析。
            // 0 条记录 → None。
            span: crate::workflow_utils::session_span(
                items
                    .iter()
                    .filter_map(|r| r.get("timestamp").and_then(Value::as_str))
                    .filter_map(|t| crate::workflow_utils::iso_to_epoch_ms(Some(t))),
            ),
        },
        signals,
        coverage,
        attempts,
        notes,
        tool_calls,
        tool_results,
        approvals,
        sandbox_modes,
        turns,
    };
    CodexEvidence { canonical, items, title, history_mode, cli_version }
}

/// `CodexEvidence` → `codex-evidence --json` 的输出形状。`RuleOutcome` /
/// `CanonicalSession` 都不是 serde 类型（§10/§11 的类型定义没有 derive
/// Serialize），展示层自己转一道——与 `behavior.rs::rule_outcomes_json` 同一个
/// 做法，输出形状由这里单独控制，Python 镜像逐字节对齐。
pub fn codex_evidence_json(evidence: &CodexEvidence) -> Value {
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
                "observed_span": a.observed_span.map(|s| serde_json::json!({
                    "start_ms": s.start_ms,
                    "end_ms": s.end_ms,
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
        "harness": "codex",
        "session_id": evidence.canonical.meta.session_id,
        "title": evidence.title,
        "history_mode": evidence.history_mode,
        "cli_version": evidence.cli_version,
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

    fn legacy_item(event_type: &str, payload: Value) -> Value {
        // `json!` 不支持 map spread（`**`），payload 必须是运行时拼出来的对象
        // —— 先塞入调用方给的字段，再把 type/turn_id 补上。
        let mut p = payload_as_map(payload);
        p.insert("type".into(), json!(event_type));
        p.insert("turn_id".into(), json!("t1"));
        json!({"type": "event_msg", "timestamp": 0, "payload": p})
    }

    fn payload_as_map(payload: Value) -> serde_json::Map<String, Value> {
        payload.as_object().cloned().unwrap_or_default()
    }

    fn item_completed(item: Value) -> Value {
        json!({"type": "event_msg", "timestamp": 0, "payload": {
            "type": "item_completed", "turn_id": "t1", "item": item
        }})
    }

    fn response_item(item_type: &str) -> Value {
        json!({"type": "response_item", "timestamp": 0, "payload": {"type": item_type}})
    }

    fn token_count(window: bool) -> Value {
        let mut info = serde_json::Map::new();
        if window {
            info.insert("model_context_window".into(), json!(128000));
        }
        legacy_item("token_count", json!({"info": info, "rate_limits": {}}))
    }

    fn build(items: Vec<Value>) -> CodexEvidence {
        // title 在真实调用里由 session_index 查表注入；单测默认 None（无索引态）。
        build_codex_evidence(items, "s1".into(), None, Some("legacy".into()),
            Some("0.146.0".into()), vec!["/repo".into()], Some("gpt-5.3-codex".into()))
    }

    #[test]
    fn legacy_fixture_counts_measured_signals_and_leaves_paginated_ones_zero() {
        let items = vec![
            legacy_item("task_started", json!({})),
            legacy_item("mcp_tool_call_end", json!({})),
            legacy_item("web_search_end", json!({})),
            legacy_item("patch_apply_end", json!({})),
            legacy_item("context_compacted", json!({})),
            legacy_item("sub_agent_activity", json!({})),
            legacy_item("thread_settings_applied", json!({"thread_settings": {"approval_policy": "Never"}})),
            token_count(true),
        ];
        let evidence = build(items);
        let cov = &evidence.canonical.coverage;
        assert_eq!(cov.get(Signal::ToolCalls).measured, 2);
        assert_eq!(cov.get(Signal::TurnBoundaries).measured, 1);
        assert_eq!(cov.get(Signal::FileMutations).lossy, 1, "Legacy 的 patch_apply_end 只进 lossy 桶");
        assert_eq!(cov.get(Signal::Compaction).measured, 1);
        assert_eq!(cov.get(Signal::SubagentSpawns).measured, 1);
        assert_eq!(cov.get(Signal::ApprovalPolicy).measured, 1);
        assert_eq!(cov.get(Signal::Usage).measured, 1);
        assert_eq!(cov.get(Signal::ContextWindow).measured, 1);
        assert_eq!(cov.get(Signal::UsageAggregate).derived, 1);
        // Paginated-only 的信号在 Legacy 里必须是零，且不进 SignalSet：
        assert_eq!(cov.get(Signal::Hooks), CoverageCounts::default(), "Legacy 没有 HookPrompt");
        assert_eq!(cov.get(Signal::ApprovalDecisions), CoverageCounts::default(), "Legacy 没有 auto_approved");
        assert!(!evidence.canonical.signals.contains(Signal::Hooks));
    }

    #[test]
    fn paginated_fixture_counts_richer_signals_legacy_cannot_supply() {
        let items = vec![
            item_completed(json!({"type": "CommandExecution", "duration": 1234,
                                  "command": ["bash", "-c", "echo hi"], "exit_code": 0,
                                  "stdout": "hi", "stderr": ""})),
            item_completed(json!({"type": "FileChange", "changes": [], "status": "applied",
                                  "auto_approved": true})),
            item_completed(json!({"type": "McpToolCall"})),
            item_completed(json!({"type": "SubAgentActivity", "agent_thread_id": "a",
                                  "agent_path": "sub"})),
            item_completed(json!({"type": "ContextCompaction"})),
            item_completed(json!({"type": "HookPrompt", "fragments": []})),
        ];
        let evidence = build(items);
        let cov = &evidence.canonical.coverage;
        assert_eq!(cov.get(Signal::ToolCalls).measured, 2, "CommandExecution + McpToolCall");
        assert_eq!(cov.get(Signal::ToolResults).measured, 1, "CommandExecution 也是结果载体");
        assert_eq!(cov.get(Signal::FileMutations).measured, 1, "FileChange 是 measured 桶，不是 lossy");
        assert_eq!(cov.get(Signal::ApprovalDecisions).measured, 1, "FileChange.auto_approved 非空 → partial 证据");
        assert_eq!(cov.get(Signal::SubagentSpawns).measured, 1);
        assert_eq!(cov.get(Signal::Compaction).measured, 1);
        assert_eq!(cov.get(Signal::Hooks).measured, 1);
        assert!(evidence.canonical.signals.contains(Signal::Hooks));
    }

    #[test]
    fn skill_invocations_is_derived_presence_marker_not_measured() {
        let items = vec![item_completed(json!({"type": "CommandExecution", "duration": 1}))];
        let evidence = build(items);
        assert_eq!(evidence.canonical.coverage.get(Signal::SkillInvocations).derived, 1);
        assert_eq!(evidence.canonical.coverage.get(Signal::SkillInvocations).measured, 0);
        assert!(evidence.canonical.signals.contains(Signal::SkillInvocations));
        assert_eq!(evidence.canonical.notes.len(), 1, "必须带 §14.3 的 Derived 说明");
        assert!(evidence.canonical.notes[0].message.contains("detect_implicit_skill_invocation_for_command"));

        // 完全没有工具执行证据时，SkillInvocations 必须 absent，不能编一个非零。
        let empty = build(vec![legacy_item("task_started", json!({}))]);
        assert!(!empty.canonical.signals.contains(Signal::SkillInvocations));
        assert_eq!(empty.canonical.coverage.get(Signal::SkillInvocations), CoverageCounts::default());
    }

    #[test]
    fn unknown_item_types_are_recorded_in_attempts_not_corruption() {
        // §14.4：未知类型必须"skipped and recorded in attempts, never treated
        // as corruption"——不能把整份日志判成畸形。
        let items = vec![
            json!({"type": "event_msg", "timestamp": 0, "payload": {"type": "brand_new_event"}}),
            json!({"type": "event_msg", "timestamp": 0, "payload": {"type": "item_completed", "item": {"type": "BrandNewItem"}}}),
            json!({"type": "response_item", "timestamp": 0, "payload": {"type": "brand_new_response"}}),
            json!({"type": "totally_new_top_level", "timestamp": 0, "payload": {}}),
        ];
        let evidence = build(items);
        assert_eq!(evidence.canonical.attempts.len(), 4);
        assert!(evidence.canonical.attempts.iter().all(|a| !a.available));
        assert!(evidence.canonical.attempts.iter().any(|a| a.error.as_deref().unwrap_or("").contains("brand_new_event")));
        assert!(evidence.canonical.attempts.iter().any(|a| a.error.as_deref().unwrap_or("").contains("BrandNewItem")));
        assert!(evidence.canonical.attempts.iter().any(|a| a.error.as_deref().unwrap_or("").contains("brand_new_response")));
        assert!(evidence.canonical.attempts.iter().any(|a| a.error.as_deref().unwrap_or("").contains("totally_new_top_level")));
        // attempts 是 evidence 的一部分，不是把日志判成不可读：
        assert_eq!(evidence.canonical.meta.harness_id, "codex");
    }

    #[test]
    fn known_non_signal_items_are_not_attempts() {
        // agent_reasoning / user_message / response_item.reasoning / world_state
        // 是"认识但恰好不喂信号"的高频条目——绝不能刷进 attempts。
        let items = vec![
            legacy_item("agent_reasoning", json!({"content": "thinking"})),
            legacy_item("user_message", json!({"content": "hi"})),
            response_item("reasoning"),
            response_item("message"),
            json!({"type": "world_state", "timestamp": 0, "payload": {"state": {}}}),
            json!({"type": "inter_agent_communication_metadata", "timestamp": 0, "payload": {}}),
        ];
        let evidence = build(items);
        assert_eq!(evidence.canonical.attempts.len(), 0, "认识的条目不记 attempts");
    }

    #[test]
    fn unavailable_signals_are_zero_and_not_in_signal_set() {
        // 结构缺口（StepBoundaries/SandboxPolicy/NetworkAccess/UserCorrections）
        // 任何输入都全零、不进 SignalSet；SandboxModes 已 available，但这份输入
        // 没有 sandbox_policy 证据 → 同样全零不进（无证据 ≠ 有覆盖）。
        // UserPrompts 已 available 且有自己的正测（下面那条），不混在这里。
        let evidence = build(vec![token_count(true)]);
        for signal in [
            Signal::StepBoundaries, Signal::SandboxPolicy,
            Signal::NetworkAccess, Signal::UserCorrections,
        ] {
            assert_eq!(evidence.canonical.coverage.get(signal), CoverageCounts::default(),
                "{signal:?} 应全零、不进 SignalSet（结构缺口）");
            assert!(!evidence.canonical.signals.contains(signal));
        }
        // SandboxModes 2026-08 从 unavailable 改 measured：有 turn_context.sandbox_policy
        // 才算，没有则保持全零不进 SignalSet（token_count 不携带 sandbox_policy）。
        assert_eq!(evidence.canonical.coverage.get(Signal::SandboxModes), CoverageCounts::default());
        assert!(!evidence.canonical.signals.contains(Signal::SandboxModes));
    }

    #[test]
    fn user_message_response_item_counts_user_prompts() {
        // 真实线格式（session 01a029cb 实测 15 条）：response_item.payload.
        // type="message" + role="user"，正文在 content[].text——计数只看 role
        // 存在性。role="assistant" 的 message 是模型回复、reasoning 是思考块，
        // 都不算用户提示。
        let items = vec![
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "你好"}]}}),
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "<environment_context>harness data</environment_context>"}]}}),
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "message", "role": "user", "content": []}}),
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "你好"}]}}),
            json!({"type": "response_item", "timestamp": 0, "payload": {"type": "reasoning"}}),
        ];
        let evidence = build(items);
        assert_eq!(evidence.canonical.coverage.get(Signal::UserPrompts).measured, 1);
        assert_eq!(evidence.canonical.coverage.get(Signal::UserPrompts).lossy, 1);
        assert!(evidence.canonical.signals.contains(Signal::UserPrompts));
        // UserPrompts 不再是结构缺口：序列化标记 available。
        let out = codex_evidence_json(&evidence);
        assert_eq!(out["coverage"]["UserPrompts"]["available"], true);
    }

    #[test]
    fn approval_policy_comes_from_turn_context_and_thread_settings() {
        // turn_context 顶层也带 approval_policy（实测字段）——两个载体都数。
        let items = vec![
            json!({"type": "turn_context", "timestamp": 0, "payload": {"approval_policy": "Never", "cwd": "/repo"}}),
            legacy_item("thread_settings_applied", json!({"thread_settings": {"approval_policy": "OnRequest"}})),
        ];
        let evidence = build(items);
        assert_eq!(evidence.canonical.coverage.get(Signal::ApprovalPolicy).measured, 2);
    }

    #[test]
    fn file_change_without_auto_approved_does_not_raise_approval_decisions() {
        // 真实语料里 FileChange 全都不带 auto_approved（n=60）——不能因此
        // 把 ApprovalDecisions 误判成有覆盖。
        let items = vec![item_completed(json!({"type": "FileChange", "changes": [], "status": "applied"}))];
        let evidence = build(items);
        assert_eq!(evidence.canonical.coverage.get(Signal::ApprovalDecisions), CoverageCounts::default());
        assert!(!evidence.canonical.signals.contains(Signal::ApprovalDecisions));
        assert_eq!(evidence.canonical.coverage.get(Signal::FileMutations).measured, 1);
    }

    #[test]
    fn evidence_json_title_none_is_null_and_some_is_surfaced() {
        // 无索引态 → title 是 null（存在性探测，绝不编造）；有索引 → thread_name。
        let none = build(vec![]);
        assert!(codex_evidence_json(&none)["title"].is_null());
        let with_title = build_codex_evidence(
            vec![], "s1".into(), Some("评估项目添加UI".into()), Some("legacy".into()),
            Some("0.146.0".into()), vec!["/repo".into()], Some("gpt-5.3-codex".into()));
        assert_eq!(codex_evidence_json(&with_title)["title"], "评估项目添加UI");
    }

    #[test]
    fn evidence_json_has_stable_shape_and_no_unknown_signal_keys() {
        let evidence = build(vec![legacy_item("mcp_tool_call_end", json!({}))]);
        let out = codex_evidence_json(&evidence);
        assert_eq!(out["harness"], "codex");
        assert_eq!(out["session_id"], "s1");
        assert!(out["title"].is_null(), "build() 默认无标题");
        assert_eq!(out["history_mode"], "legacy");
        assert_eq!(out["cli_version"], "0.146.0");
        assert_eq!(out["workspace_roots"], json!(["/repo"]));
        assert_eq!(out["model"], "gpt-5.3-codex");
        assert!(out["signals"].as_array().unwrap().contains(&json!("ToolCalls")));
        // 所有 19 个 Signal 都出现在 coverage 里，缺一个就说明序列化漏了。
        let coverage = out["coverage"].as_object().unwrap();
        assert_eq!(coverage.len(), 20);
        for s in &Signal::ALL {
            assert!(coverage.contains_key(&format!("{s:?}")));
        }
        assert_eq!(coverage["ToolCalls"], json!({"measured": 1, "derived": 0, "lossy": 0, "unmetered": 0, "available": true}));
        // available 标记（2026-08 起）：结构缺口 false、可数信号 true——KPI 分母
        // 和模板「结构缺口 vs 会话缺口」的折叠都靠这个键。
        assert_eq!(coverage["StepBoundaries"], json!({"measured": 0, "derived": 0, "lossy": 0, "unmetered": 0, "available": false}));
        assert_eq!(coverage["UserPrompts"], json!({"measured": 0, "derived": 0, "lossy": 0, "unmetered": 0, "available": true}),
            "UserPrompts 已翻 measured，不再是结构缺口");
    }

    #[test]
    fn no_usage_evidence_leaves_usage_and_derived_markers_zero() {
        let evidence = build(vec![legacy_item("task_started", json!({}))]);
        assert_eq!(evidence.canonical.coverage.get(Signal::Usage), CoverageCounts::default());
        assert_eq!(evidence.canonical.coverage.get(Signal::UsageAggregate), CoverageCounts::default());
        assert_eq!(evidence.canonical.coverage.get(Signal::ContextWindow), CoverageCounts::default());
    }

    /// 一份覆盖 populate 全部路径的 Codex items：两个 turn、每个 turn 一个
    /// turn_context（sandbox_policy 对象形态）、CommandExecution（exec→bash +
    /// 命令文本剥前缀 + exit_code→错误码）、function_call/function_call_output
    /// （原生名 + .error）、task_started/task_complete（turn 序数 + end_*）。
    fn populated_items() -> Vec<Value> {
        vec![
            json!({"type": "turn_context", "timestamp": 0, "payload": {
                "sandbox_policy": {"type": "danger-full-access"}, "approval_policy": "never",
                "turn_id": "t1"}}),
            json!({"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_started", "turn_id": "t1", "started_at": 100}}),
            json!({"type": "event_msg", "timestamp": 0, "payload": {
                "type": "item_completed", "turn_id": "t1", "item": {
                    "type": "CommandExecution", "id": "exec-1",
                    "command": ["/bin/zsh", "-lc", "rm -rf /tmp/x"], "exit_code": 0}}}),
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "function_call", "name": "send_message",
                "arguments": "{\"target\":\"/root\"}", "call_id": "call-1"}}),
            json!({"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_complete", "turn_id": "t1", "started_at": 100, "error": null}}),
            json!({"type": "turn_context", "timestamp": 0, "payload": {
                "sandbox_policy": {"type": "danger-full-access"}}}),
            json!({"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_started", "turn_id": "t2", "started_at": 200}}),
            json!({"type": "event_msg", "timestamp": 0, "payload": {
                "type": "item_completed", "turn_id": "t2", "item": {
                    "type": "CommandExecution", "id": "exec-2",
                    "command": ["echo", "boom"], "exit_code": 1}}}),
            json!({"type": "event_msg", "timestamp": 0, "payload": {
                "type": "item_completed", "turn_id": "t2", "item": {
                    "type": "CommandExecution", "id": "exec-3",
                    "command": ["echo", "boom"], "exit_code": 1}}}),
            json!({"type": "event_msg", "timestamp": 0, "payload": {
                "type": "item_completed", "turn_id": "t2", "item": {
                    "type": "CommandExecution", "id": "exec-4",
                    "command": ["echo", "boom"], "exit_code": 1}}}),
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "function_call_output", "call_id": "call-1", "error": null}}),
            json!({"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_complete", "turn_id": "t2", "started_at": 200, "error": null}}),
        ]
    }

    #[test]
    fn populate_fills_four_timelines_natively() {
        let evidence = build(populated_items());
        let c = &evidence.canonical;

        // sandbox_modes：两个 turn_context（对象形态）各一条。
        assert_eq!(c.sandbox_modes.entries.len(), 2);
        assert_eq!(c.sandbox_modes.entries[0].observation.mode, "danger-full-access");

        // tool_calls：CommandExecution→bash 翻译 + function_call 原生名；
        // custom_tool_call 影子不填（本数据无 shadow，见真值表测试的注释）。
        let names: Vec<&str> =
            c.tool_calls.entries.iter().map(|e| e.observation.name.as_str()).collect();
        assert_eq!(names, vec!["bash", "send_message", "bash", "bash", "bash"]);
        assert_eq!(c.tool_calls.entries[0].observation.args_text, "rm -rf /tmp/x",
            "shell 前缀 /bin/zsh -lc 被剥掉，SV601-603 的正则在命令本体上匹配");
        assert_eq!(c.tool_calls.entries[2].observation.args_text, "echo boom",
            "无 shell 前缀的命令原样 join");
        assert_eq!(c.tool_calls.entries[0].call_id.as_deref(), Some("exec-1"),
            "call_id 用 item.id（Codex 无 call_id，CommandExecution 自带 id）");

        // tool_results：exit_code≠0 → 合成码 exit_code:N；0 / output.error null → None。
        let codes: Vec<Option<&str>> = c.tool_results.entries.iter()
            .map(|e| e.observation.error_code.as_deref()).collect();
        assert_eq!(codes, vec![None, Some("exit_code:1"), Some("exit_code:1"),
                               Some("exit_code:1"), None]);

        // turns：两个 turn，合成序数 0/1，sig 按 payload.turn_id 归属，end_* 来自
        // task_complete（end_seq = task_complete 的合成 seq）。
        assert_eq!(c.turns.entries.len(), 2);
        assert_eq!(c.turns.entries[0].observation.turn, 0);
        assert_eq!(c.turns.entries[0].observation.sig,
                   vec![("bash".to_string(), "rm -rf /tmp/x".to_string())]);
        assert_eq!(c.turns.entries[0].observation.end_seq, Some(4));
        assert_eq!(c.turns.entries[1].observation.turn, 1);
        assert_eq!(c.turns.entries[1].observation.sig.len(), 3);
        assert_eq!(c.turns.entries[1].observation.end_seq, Some(11));
        assert_eq!(c.turns.entries[1].observation.end_time, Some(200));

        // approvals：Codex 无 asked/decided 生命周期，诚实保持空。
        assert!(c.approvals.entries.is_empty());

        // coverage lockstep：SandboxModes 计数与 sandbox_modes timeline 条数一致，
        // 且进 SignalSet（覆盖与时间线同源，两条账不能对不上）。
        assert_eq!(c.coverage.get(Signal::SandboxModes).measured, 2);
        assert!(c.signals.contains(Signal::SandboxModes));
    }

    #[test]
    fn empty_items_leave_all_timelines_empty() {
        // 空输入 → 空 timeline：这是「结构对齐 + 反编造」的底线，不管 populate
        // 逻辑怎么改都不能把空会话填出东西来。
        let evidence = build(vec![]);
        assert!(evidence.canonical.tool_calls.entries.is_empty());
        assert!(evidence.canonical.tool_results.entries.is_empty());
        assert!(evidence.canonical.approvals.entries.is_empty());
        assert!(evidence.canonical.sandbox_modes.entries.is_empty());
        assert!(evidence.canonical.turns.entries.is_empty());
    }

    #[test]
    fn sandbox_policy_string_and_object_shapes_both_count() {
        // 线格式漂移：真实日志是对象 `{type}`、旧 fixture 是字符串。两态都要数进
        // SandboxModes 覆盖 + 填进 sandbox_modes timeline；无 sandbox_policy 的
        // turn_context 不数。
        let items = vec![
            json!({"type": "turn_context", "timestamp": 0, "payload": {
                "sandbox_policy": "workspace-write", "approval_policy": "on-request"}}),
            json!({"type": "turn_context", "timestamp": 0, "payload": {
                "sandbox_policy": {"type": "danger-full-access"}, "approval_policy": "never"}}),
            json!({"type": "turn_context", "timestamp": 0, "payload": {
                "approval_policy": "never"}}),
        ];
        let evidence = build(items);
        assert_eq!(evidence.canonical.sandbox_modes.entries.len(), 2);
        assert_eq!(evidence.canonical.sandbox_modes.entries[0].observation.mode, "workspace-write");
        assert_eq!(evidence.canonical.sandbox_modes.entries[1].observation.mode, "danger-full-access");
        assert_eq!(evidence.canonical.coverage.get(Signal::SandboxModes).measured, 2);
        assert!(evidence.canonical.signals.contains(Signal::SandboxModes));
    }

    #[test]
    fn task_complete_error_sets_end_reason_and_code() {
        // task_complete.error 非 null → end_reason_kind="error" + end_error_code 防御性
        // 抽取（真实日志全 null，这条是结构保险）。
        let items = vec![
            json!({"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_started", "turn_id": "t1", "started_at": 100}}),
            json!({"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_complete", "turn_id": "t1", "started_at": 100,
                "error": {"codex_error_info": {"code": "AGENT_PANICKED"}}}}),
        ];
        let evidence = build(items);
        assert_eq!(evidence.canonical.turns.entries.len(), 1);
        assert_eq!(evidence.canonical.turns.entries[0].observation.end_reason_kind.as_deref(),
                   Some("error"));
        assert_eq!(evidence.canonical.turns.entries[0].observation.end_error_code.as_deref(),
                   Some("AGENT_PANICKED"));
    }

    /// 从 outcomes 数组里按码取一条 `RuleOutcome`（真值表断言的取数器）。显式
    /// lifetime——闭包在这里推不出来，用模块级 fn 是干净的写法。
    fn outcome<'a>(
        outcomes: &'a [(&'static str, agent_vitals_domain::contracts::evidence::RuleOutcome)],
        code: &str,
    ) -> &'a agent_vitals_domain::contracts::evidence::RuleOutcome {
        outcomes.iter().find(|(cc, _)| *cc == code).map(|(_, o)| o).expect("rule present")
    }

    #[test]
    fn codex_canonical_runs_behavior_and_trajectory_rules() {
        // 真值表（诚实结果，build_codex_evidence 注释里那张表的可测形态）：Codex
        // 填了 4 条 timeline 后，SV 规则按门控真正跑起来。这是「解析对齐」的可测
        // 证明——不需要 `codex behavior` CLI 消费者。
        use agent_vitals_domain::domain::behavior::match_behavior_canonical;
        use agent_vitals_domain::domain::trajectory::match_trajectory_canonical;

        let evidence = build(populated_items());
        let c = &evidence.canonical;
        let behavior = match_behavior_canonical(c);
        let trajectory = match_trajectory_canonical(c);

        // SV601/602/603（exec→bash 翻译）：rm -rf 命中 SV601；无 sudo/curl|sh。
        assert!(matches!(outcome(&behavior, "SV601"), agent_vitals_domain::contracts::evidence::RuleOutcome::Findings(_)));
        assert!(matches!(outcome(&behavior, "SV602"), agent_vitals_domain::contracts::evidence::RuleOutcome::MeasuredZero));
        assert!(matches!(outcome(&behavior, "SV603"), agent_vitals_domain::contracts::evidence::RuleOutcome::MeasuredZero));
        // SV604/605/606：Codex 没有 write/edit/web_fetch 工具，诚实 MeasuredZero。
        assert!(matches!(outcome(&behavior, "SV604"), agent_vitals_domain::contracts::evidence::RuleOutcome::MeasuredZero));
        assert!(matches!(outcome(&behavior, "SV605"), agent_vitals_domain::contracts::evidence::RuleOutcome::MeasuredZero));
        assert!(matches!(outcome(&behavior, "SV606"), agent_vitals_domain::contracts::evidence::RuleOutcome::MeasuredZero));
        // SV607/608：exit_code:N 不在 DSH 错误码集里，诚实 MeasuredZero。
        assert!(matches!(outcome(&behavior, "SV607"), agent_vitals_domain::contracts::evidence::RuleOutcome::MeasuredZero));
        assert!(matches!(outcome(&behavior, "SV608"), agent_vitals_domain::contracts::evidence::RuleOutcome::MeasuredZero));
        // SV609：approvals 空 → 门控 Unavailable（诚实能力缺失）。
        assert!(matches!(outcome(&behavior, "SV609"),
                         agent_vitals_domain::contracts::evidence::RuleOutcome::Unavailable { .. }));
        // SV610：sandbox_policy 翻译进 sandbox_modes → danger-full-access 命中。
        assert!(matches!(outcome(&behavior, "SV610"), agent_vitals_domain::contracts::evidence::RuleOutcome::Findings(_)));

        // SV611：三连相同签名 (bash,"echo boom") 触发连续重复。
        assert!(matches!(outcome(&trajectory, "SV611"),
                         agent_vitals_domain::contracts::evidence::RuleOutcome::Findings(_)));
        // SV612：两 turn 的 sig 不同，不是死循环。
        assert!(matches!(outcome(&trajectory, "SV612"), agent_vitals_domain::contracts::evidence::RuleOutcome::MeasuredZero));
        // SV613：三连 exit_code:1 触发工具级停滞。
        assert!(matches!(outcome(&trajectory, "SV613"),
                         agent_vitals_domain::contracts::evidence::RuleOutcome::Findings(_)));
        // SV614：OR 门控（approvals 空但 sandbox 非空）放行，两个 danger 授予触发 c。
        assert!(matches!(outcome(&trajectory, "SV614"),
                         agent_vitals_domain::contracts::evidence::RuleOutcome::Findings(_)));
    }

    #[test]
    fn populate_skips_custom_tool_call_shadow_entries() {
        // 真实日志里 exec = custom_tool_call + CommandExecution + output 三份影子，
        // call_id 与 item.id 无 join key。都填会双重计数、破坏 SV611。主源是
        // CommandExecution，custom_tool_call/custom_tool_call_output 必须被跳过。
        let items = vec![
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "custom_tool_call", "name": "exec",
                "input": "const r = await tools.exec_command({cmd:\"echo hi\"})",
                "call_id": "call-x"}}),
            json!({"type": "event_msg", "timestamp": 0, "payload": {
                "type": "item_completed", "turn_id": "t1", "item": {
                    "type": "CommandExecution", "id": "exec-x",
                    "command": ["echo", "hi"], "exit_code": 0}}}),
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "custom_tool_call_output", "call_id": "call-x",
                "output": "hi", "error": null}}),
        ];
        let evidence = build(items);
        // 只有 CommandExecution 一条进 tool_calls/tool_results——影子被跳过。
        assert_eq!(evidence.canonical.tool_calls.entries.len(), 1);
        assert_eq!(evidence.canonical.tool_calls.entries[0].observation.name, "bash");
        assert_eq!(evidence.canonical.tool_results.entries.len(), 1);
    }

    #[test]
    fn populate_legacy_fallback_extracts_real_shell_cmds_only() {
        // Legacy 线格式（真实 7/25）：0 item_completed/CommandExecution，679 次工具
        // 执行全是 custom_tool_call{name:"exec"}。但 "exec" 是 JS 沙箱工具——input
        // 里真跑的不一定是 shell（apply_patch/write_stdin/view_image/web__run 都有）。
        // 回退只把能提取到 exec_command({cmd}) 的翻成 bash（真 shell 命令）：
        // - 双引号 cmd 值内嵌单引号不截断（quote-aware——旧 `[^"']` 会把
        //   `sed -n '1,240p'` 截成 `sed -n ` 这种看着像命令的残片）；
        // - apply_patch / JS 动态拼 cmd 的不进 tool_calls（SV601-603 只在 bash 上跑，
        //   不会在 apply_patch 上误报）；
        // - tool_results 恒空（Legacy 无 exit/error 源）、不进 turn sig（无 turn_id）。
        let items = vec![
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "custom_tool_call", "name": "exec", "call_id": "call-1",
                "input": "const r = await tools.exec_command({\"cmd\":\"sed -n '1,240p' 'x'\"})"}}),
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "custom_tool_call", "name": "exec", "call_id": "call-2",
                "input": "const r = await tools.apply_patch({patch: '...'})"}}),
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "custom_tool_call", "name": "exec", "call_id": "call-3",
                "input": "const cmd = 'git log'; await tools.exec_command({cmd})"}}),
            json!({"type": "response_item", "timestamp": 0, "payload": {
                "type": "custom_tool_call", "name": "exec", "call_id": "call-4",
                "input": "await tools.exec_command({'cmd':'ls -la'})"}}),
        ];
        let evidence = build(items);
        let calls = &evidence.canonical.tool_calls.entries;
        assert_eq!(calls.len(), 2, "只挖得出真 shell 命令的才进 tool_calls");
        assert_eq!(calls[0].observation.name, "bash");
        assert_eq!(
            calls[0].observation.args_text, "sed -n '1,240p' 'x'",
            "双引号值内嵌单引号必须完整保留，不许截成 sed -n 残片"
        );
        assert_eq!(calls[0].call_id.as_deref(), Some("call-1"));
        assert_eq!(calls[1].observation.name, "bash");
        assert_eq!(calls[1].observation.args_text, "ls -la", "单引号 cmd 值同样提取");
        assert_eq!(
            evidence.canonical.tool_results.entries.len(), 0,
            "Legacy 工具结果无 exit/error 源 → tool_results 保持空（诚实 Unavailable）"
        );
        assert_eq!(evidence.canonical.turns.entries.len(), 0);
    }
}
