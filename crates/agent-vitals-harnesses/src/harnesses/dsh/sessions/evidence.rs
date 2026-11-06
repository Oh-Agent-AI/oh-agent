//! P2 of the runtime evidence model (`docs/RUNTIME_EVIDENCE_CONTRACT.md` §17).
//!
//! DSH 的五段式适配器流水线（locate → shape → extract → derive → coverage,
//! `evidence::CanonicalSession` 的文档注释）里 "derive → coverage" 这两段：
//! 从 `src/dsh.rs` 已经抽好的 execution_events / usage_events 里数出每个
//! `Signal` 的覆盖情况，拼成 `evidence::CanonicalSession`。"locate → shape →
//! extract" 三段留在 `src/dsh.rs::read_session_log`（I/O，P2 不动——Python
//! 那边的 `adapters/dsh.py` 还要继续逐字节对齐它）。
//!
//! **不是 trait**——`evidence::CanonicalSession` 自己的文档注释已经写明理由
//! （`ARCHITECTURE.md` §4.2）：执行环境之间差的是"哪些阶段存在"，trait 会强迫
//! 每个执行环境实现一堆空方法，反而把这个差异藏起来。这里就是普通函数。
//!
//! `DshEvidence` 把 `CanonicalSession`（纯 provenance/coverage 记账，§12
//! 规定它不持有任何执行环境专属 payload）和它派生自的原始事件捆在一起——
//! `behavior.rs` 的规则引擎现在还得靠原始事件跑（`match_behavior` /
//! `token_by_model` 等还没迁到读 `Signal`，那是 P3 的事），P2 阶段两者必须
//! 一起往下传，不能只留 `CanonicalSession`。
//!
//! `reverse_project` 是临时的桥：P3 把规则迁到直接读 `Signal` 之后这个函数
//! 就删掉，连同 `behavior.rs` 里调用它、再把结果拆包成裸事件数组的桥接代码
//! 一起删。

use serde_json::{Map, Value};

// `Coords`（事件定位坐标顺延状态机）phase C 迁进 `domain::coords`——见那里的
// 模块注释（住 domain 是过渡：`trajectory::coord_map`/`duration`/`skill` 还对
// raw 事件跑它，那几个要留 domain）。adapter 侧经 `harnesses → domain` 正向依赖取。
use agent_vitals_domain::coords::Coords;
use agent_vitals_domain::evidence::{
    ApprovalAsked, ApprovalDecided, ApprovalObservation, CanonicalSession, Coverage,
    CoverageCounts, Provenance, SandboxModeObservation, SessionMeta, Signal, SignalSet, Timeline,
    TimelineEntry, ToolCallObservation, ToolResultObservation, TurnObservation,
};

// ────────────────────── extraction: DSH event shape → payload ──────────────────────
// phase B 把这段「翻译」从 behavior.rs 挪到适配器——规则不再碰 DSH 的 JSON 事件
// 形状，适配器负责把工具调用/结果/审批/沙箱事件翻译成 evidence.rs 的窄 payload
// 存进 timeline。翻译是适配器段，匹配（正则）是规则段，两段分开住。

/// 工具调用型事件（tool/call + code-dispatch*）的类型白名单——与 Python
/// behavior.py 的 TOOL_CALL_TYPES 逐字节对齐。dangerous command 可能藏在
/// run_code 桥接出的嵌套子调用里（§6.2 注），规则须一并匹配。
pub(crate) const TOOL_CALL_TYPES: [&str; 3] = [
    "tool/call",
    "tool/code-dispatch-start",
    "tool/code-dispatch",
];

/// 把 JSON 对象/数组拍平成字符串叶子（字典键排序）。与 Python `_flatten_strings`
/// 逐字节对齐：code-dispatch 的 `arguments` 对象里的命令/路径/URL 都是字符串叶子。
fn flatten_strings(value: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    fn walk(v: &Value, parts: &mut Vec<String>) {
        match v {
            Value::String(s) => parts.push(s.clone()),
            Value::Array(arr) => {
                for item in arr {
                    walk(item, parts);
                }
            }
            Value::Object(obj) => {
                let mut keys: Vec<&String> = obj.keys().collect();
                keys.sort();
                for key in keys {
                    walk(&obj[key], parts);
                }
            }
            _ => {}
        }
    }
    walk(value, &mut parts);
    parts.join("\n")
}

/// 从 `data` 取出可搜索的参数文本：原始 JSON 字符串直接用；对象/数组拍平。
fn args_text(data: &Map<String, Value>) -> String {
    match data.get("arguments") {
        Some(Value::String(s)) => s.clone(),
        Some(v @ (Value::Object(_) | Value::Array(_))) => flatten_strings(v),
        _ => String::new(),
    }
}

/// 工具调用型事件 → (工具名, 参数文本)；否则 None。
pub(crate) fn tool_invocation(event: &Value) -> Option<(&str, String)> {
    let etype = event.get("type")?.as_str()?;
    if !TOOL_CALL_TYPES.contains(&etype) {
        return None;
    }
    let data = event.get("data")?.as_object()?;
    let name = data.get("name")?.as_str()?;
    Some((name, args_text(data)))
}

/// tool/result 的 error.code，不是 tool/result 或缺 error 时返回 None。
fn result_code(event: &Value) -> Option<&str> {
    if event.get("type")?.as_str()? != "tool/result" {
        return None;
    }
    event.get("data")?.get("error")?.get("code")?.as_str()
}

// ────────────────────── populate: execution events → timelines ──────────────────────

/// turn 生命周期 pass 的中间状态：turn/start 开启，之后任意事件推进 `last_seq`、
/// tool/call 追加 `sig`、turn/end 填 `end_*` 字段，下一个 turn/start 或 EOF 收尾
/// push 进 `turns`。语义逐字复刻 `trajectory::detect_loop` 的单遍累加（见
/// `evidence.rs::TurnObservation` 的字段注释）：
/// - turn/start 只开新 turn、push 上一个，**本身**不推进任何 `last_seq`
///   （detect_loop 那里 `continue` 了）；
/// - turn 内任何事件都推进 `last_seq`——不止工具调用，G2 的 `run_end_seq` 要覆盖
///   这个 turn 真实占到的位置（包括它自己的 tool/result / turn/end）；
/// - turn 外的 tool/call 不归任何 turn（`sig` 只在 pending 存在时追加）。
struct PendingTurn {
    turn: i64,
    sig: Vec<(String, String)>,
    last_seq: Option<i64>,
    /// turn/start 事件解析出的 entry 坐标，push 时落进 `TimelineEntry`：
    /// (seq, time, turn, step, call_id, ordinal)。
    entry: (Option<i64>, Option<i64>, Value, Value, Value, usize),
    end_reason_kind: Option<String>,
    end_error_code: Option<String>,
    end_seq: Option<i64>,
    end_time: Option<i64>,
}

fn flush_turn(turns: &mut Timeline<TurnObservation>, p: PendingTurn) {
    let (seq, time, turn, step, call_id, ordinal) = p.entry;
    turns.entries.push(make_entry(
        TurnObservation {
            turn: p.turn,
            sig: p.sig,
            last_seq: p.last_seq,
            end_reason_kind: p.end_reason_kind,
            end_error_code: p.end_error_code,
            end_seq: p.end_seq,
            end_time: p.end_time,
        },
        seq, time, turn, step, call_id, ordinal,
    ));
}

/// 跑一遍 `Coords`，把 execution_events 里的工具调用/结果/审批/沙箱/turn 事件
/// 翻译成五个 harness-neutral timeline（§11.5）。与旧 `match_behavior` 的迭代序
/// 一致：边界事件先推进坐标、再对本事件取坐标，`ordinal` 就是「在传入数组里的
/// 下标」——flatten 用它重建 (event, rule) 字节序。turn 生命周期是同一遍里额外
/// 跑的状态化 pass（`PendingTurn`），不是第二次遍历——`last_seq` 需要"下一个
/// turn/start 之前最后出现的事件 seq"，单遍才能拿到。
pub(crate) fn populate_timelines(
    execution_events: &[Value],
    tool_calls: &mut Timeline<ToolCallObservation>,
    tool_results: &mut Timeline<ToolResultObservation>,
    approvals: &mut Timeline<ApprovalObservation>,
    sandbox_modes: &mut Timeline<SandboxModeObservation>,
    turns: &mut Timeline<TurnObservation>,
) {
    let mut coords = Coords::default();
    let mut pending: Option<PendingTurn> = None;
    for (ordinal, event) in execution_events.iter().enumerate() {
        if !event.is_object() {
            continue;
        }
        coords.observe(event);
        let (turn, step, call_id) = coords.resolve(event);
        let seq = event.get("seq").and_then(|v| v.as_i64());
        let time = event.get("time").and_then(|v| v.as_i64());
        let etype = event.get("type").and_then(|v| v.as_str());
        if etype == Some("turn/start") {
            if let Some(p) = pending.take() {
                flush_turn(turns, p);
            }
            let turn_no = event.pointer("/data/turn").and_then(|v| v.as_i64()).unwrap_or(0);
            pending = Some(PendingTurn {
                turn: turn_no,
                sig: Vec::new(),
                last_seq: seq,
                entry: (seq, time, turn, step, call_id, ordinal),
                end_reason_kind: None,
                end_error_code: None,
                end_seq: None,
                end_time: None,
            });
            continue;
        }
        // turn/start 之外的任何事件都推进「最后事件 seq」——turn/end 自身也在内
        // （它既推进 last_seq 又填 end_* 字段，两者在 fixture 里恒相等但语义不同）。
        if let Some(p) = pending.as_mut() {
            if let Some(s) = seq {
                p.last_seq = Some(s);
            }
        }
        match etype {
            Some(t) if TOOL_CALL_TYPES.contains(&t) => {
                if let Some((name, args_text)) = tool_invocation(event) {
                    tool_calls.entries.push(make_entry(
                        ToolCallObservation { name: name.to_string(), args_text: args_text.clone() },
                        seq, time, turn, step, call_id, ordinal,
                    ));
                    if let Some(p) = pending.as_mut() {
                        p.sig.push((name.to_string(), args_text));
                    }
                }
            }
            Some("tool/result") => {
                tool_results.entries.push(make_entry(
                    ToolResultObservation { failed: None, error_code: result_code(event).map(str::to_owned) },
                    seq, time, turn, step, call_id, ordinal,
                ));
            }
            Some("approval/asked") => {
                let asked = event.get("data").and_then(|v| v.as_object()).map(|d| ApprovalAsked {
                    tool_name: d.get("toolName").and_then(|v| v.as_str()).map(str::to_owned),
                    reason: d.get("reason").and_then(|v| v.as_str()).map(str::to_owned),
                });
                approvals.entries.push(make_entry(
                    ApprovalObservation { asked, decided: None },
                    seq, time, turn, step, call_id, ordinal,
                ));
            }
            Some("approval/decided") => {
                let decided = event
                    .get("data")
                    .and_then(|v| v.as_object())
                    .and_then(|d| d.get("outcome").and_then(|v| v.as_str()))
                    .map(|o| ApprovalDecided { outcome: o.to_string() });
                approvals.entries.push(make_entry(
                    ApprovalObservation { asked: None, decided },
                    seq, time, turn, step, call_id, ordinal,
                ));
            }
            Some("sandbox/mode") => {
                let mode = event
                    .get("data")
                    .and_then(|v| v.as_object())
                    .and_then(|d| d.get("mode").and_then(|v| v.as_str()))
                    .unwrap_or("");
                sandbox_modes.entries.push(make_entry(
                    SandboxModeObservation { mode: mode.to_string() },
                    seq, time, turn, step, call_id, ordinal,
                ));
            }
            Some("turn/end") => {
                if let Some(p) = pending.as_mut() {
                    let d = event.get("data").and_then(|v| v.as_object());
                    p.end_reason_kind = d
                        .and_then(|d| d.get("reason"))
                        .and_then(|r| r.get("kind"))
                        .and_then(|v| v.as_str())
                        .map(str::to_owned);
                    p.end_error_code = d
                        .and_then(|d| d.get("reason"))
                        .and_then(|r| r.get("error"))
                        .and_then(|e| e.get("code"))
                        .and_then(|v| v.as_str())
                        .map(str::to_owned);
                    p.end_seq = seq;
                    p.end_time = time;
                }
            }
            _ => {}
        }
    }
    if let Some(p) = pending {
        flush_turn(turns, p);
    }
}

/// 按一次事件的坐标塞一条 timeline entry。`turn`/`step` 来自 `Coords` 顺延
/// 解析后的 `Value`（自带优先、turn 外为 null）——转成 `Option<i64>` 存下。
fn make_entry<T>(
    observation: T,
    seq: Option<i64>,
    time: Option<i64>,
    turn: Value,
    step: Value,
    call_id: Value,
    ordinal: usize,
) -> TimelineEntry<T> {
    TimelineEntry {
        observation,
        // DSH 全部是执行环境原生记录——逐事件 provenance 恒 Measured，没有推导/估算。
        provenance: Provenance::Measured,
        seq,
        time,
        turn: turn.as_i64(),
        step: step.as_i64(),
        call_id: call_id.as_str().map(str::to_owned),
        ordinal,
    }
}

/// DSH 适配器一次审计的产物：`CanonicalSession` + 它派生自的原始事件。
pub struct DshEvidence {
    pub canonical: CanonicalSession,
    pub execution_events: Vec<Value>,
    pub usage_events: Vec<Value>,
    pub cwd: Option<String>,
}

fn event_type(ev: &Value) -> Option<&str> {
    ev.get("type").and_then(|v| v.as_str())
}

fn count_types(events: &[Value], types: &[&str]) -> u64 {
    events
        .iter()
        .filter(|e| event_type(e).map(|t| types.contains(&t)).unwrap_or(false))
        .count() as u64
}

fn measured(count: u64) -> CoverageCounts {
    CoverageCounts { measured: count, ..Default::default() }
}

fn derived(count: u64) -> CoverageCounts {
    CoverageCounts { derived: count, ..Default::default() }
}

/// 非零覆盖才计入 `SignalSet`——一个信号在这份日志里从没出现过时，既不
/// 该出现在 signals 集合里，也不该在 `Coverage` 里留一条全零但"看起来
/// 存在"的记录之外的东西（`Coverage::get` 对缺席信号本来就返回全零，见
/// `evidence.rs`）。
fn add(signals: &mut SignalSet, coverage: &mut Coverage, signal: Signal, counts: CoverageCounts) {
    if counts.total() > 0 {
        signals.insert(signal);
    }
    coverage.set(signal, counts);
}

/// execution_events / usage_events → 每个 `Signal` 的覆盖计数，按
/// `docs/RUNTIME_EVIDENCE_CONTRACT.md` §13 harness coverage matrix 的 DSH 列
/// 逐条对应。矩阵没覆盖到的三行（SandboxPolicy / UserPrompts /
/// UserCorrections）不编造 provenance——一律记全零（unavailable，不进
/// `SignalSet`），等真正需要这三个信号时再去读 `src/dsh.rs` 的事件类型
/// 补上，不能靠猜。
fn derive_coverage(execution_events: &[Value], usage_events: &[Value]) -> (SignalSet, Coverage) {
    let mut signals = SignalSet::EMPTY;
    let mut coverage = Coverage::new();

    add(&mut signals, &mut coverage, Signal::ToolCalls, measured(count_types(
        execution_events,
        &["tool/call", "tool/code-dispatch-start", "tool/code-dispatch"],
    )));
    add(&mut signals, &mut coverage, Signal::ToolResults, measured(count_types(execution_events, &["tool/result"])));
    add(&mut signals, &mut coverage, Signal::TurnBoundaries, measured(count_types(execution_events, &["turn/start", "turn/end"])));
    add(&mut signals, &mut coverage, Signal::StepBoundaries, measured(count_types(execution_events, &["step/start", "step/end"])));
    // approval/asked 和 approval/decided 是同一个「问了 → 给了结果」生命周期
    // 的两端——P3 group① 发现的真 bug：这里之前只数 decided,漏了 asked,
    // 导致一个只问过、还没等到 approval/decided 就结束的会话(真实存在,
    // 比如会话中途中断)被判定成 ApprovalDecisions 全零覆盖(unavailable),
    // 但日志里明明有 approval/asked 这条证据。
    add(&mut signals, &mut coverage, Signal::ApprovalDecisions, measured(count_types(
        execution_events, &["approval/asked", "approval/decided"],
    )));
    // ApprovalPolicy 和 SandboxModes 目前都只能从 `sandbox/mode` 反推——DSH
    // 日志里没有把"策略"和"当前模式"分成两类事件,§13 对这两行给的都是
    // measured,共用同一个计数源如实反映这一点,不是重复计错。
    add(&mut signals, &mut coverage, Signal::ApprovalPolicy, measured(count_types(execution_events, &["sandbox/mode"])));
    add(&mut signals, &mut coverage, Signal::SandboxModes, measured(count_types(execution_events, &["sandbox/mode"])));
    add(&mut signals, &mut coverage, Signal::Compaction, measured(count_types(
        execution_events,
        &["compaction/start", "compaction/summary", "compaction/end", "compaction/prune"],
    )));
    add(&mut signals, &mut coverage, Signal::Hooks, measured(count_types(execution_events, &["hook/invoked", "hook/result"])));

    // SubagentSpawns / SkillInvocations 曾经只用「本会话有没有 session
    // 头」做覆盖率下界——P3 group⑤落地：直接数真正驱动这两个函数的字段，
    // 不是重新实现 subagent.rs/skill.rs 的完整判定逻辑（那两个函数还要
    // 从 tool/result 文本里抠 UUID、按 callId 配对——覆盖率只需要知道"有
    // 没有这类证据"，不需要精确复刻最终计数）。
    //
    // tool/call name=="subagent" 是 subagent.rs 判定子代理启动的唯一入口
    // （`subagent.rs` 模块注释：父日志的 tool/call name=subagent → 配
    // tool/result 文本 "started subagent <uuid>"，这里只数前半段，够回答
    // "这份日志里有没有派过子代理"）。
    let subagent_calls = execution_events
        .iter()
        .filter(|e| {
            e.get("type").and_then(|v| v.as_str()) == Some("tool/call")
                && e.pointer("/data/name").and_then(|v| v.as_str()) == Some("subagent")
        })
        .count() as u64;
    add(&mut signals, &mut coverage, Signal::SubagentSpawns, measured(subagent_calls));

    // SkillInvocations 有两条独立路径（skill.rs 模块注释）：explicit 挂在
    // user/message 上——dsh.rs 只在 data.source.kind=="skill-invocation"
    // 时才把 user/message 塞进 execution_events（普通 user/message 不会
    // 出现在这里，见 dsh.rs 的过滤逻辑与它自己的测试），所以这里出现的
    // user/message 天生就是 skill-invocation 载体，数它不需要再判一次
    // source.kind。model_selected 挂在 tool/call name=="skill" 上。
    let skill_related = execution_events
        .iter()
        .filter(|e| {
            let etype = e.get("type").and_then(|v| v.as_str());
            etype == Some("user/message")
                || (etype == Some("tool/call")
                    && e.pointer("/data/name").and_then(|v| v.as_str()) == Some("skill"))
        })
        .count() as u64;
    add(&mut signals, &mut coverage, Signal::SkillInvocations, measured(skill_related));

    // FileMutations：DSH 没有独立的 file/write 事件类型（不在 dsh.rs 的
    // EXECUTION_EVENT_TYPES 白名单里）。§13 判它 measured 是因为可以从
    // tool/result 反推出具体改了哪些文件,但反推规则是另一层判定逻辑,P2
    // 不重新发明——这里只标 Derived,用 tool/result 的出现次数做下界。
    let tool_result_count = count_types(execution_events, &["tool/result"]);
    add(&mut signals, &mut coverage, Signal::FileMutations, if tool_result_count > 0 { derived(tool_result_count) } else { CoverageCounts::default() });

    // Usage / UsageAggregate 来自单独的 usage_events 数组,不是
    // execution_events——两者是 dsh.rs 里并列的独立字段。
    add(&mut signals, &mut coverage, Signal::Usage, measured(usage_events.len() as u64));
    add(&mut signals, &mut coverage, Signal::UsageAggregate, if usage_events.is_empty() { CoverageCounts::default() } else { derived(1) });

    // ContextWindow：usage_events 里 header 的 system/tools 载荷已经在喂
    // `usage::context_composition`,这里只做存在性判定,不重算那份计算
    // （避免出现第二份可能跑偏的常驻上下文估算）。
    add(&mut signals, &mut coverage, Signal::ContextWindow, if usage_events.is_empty() { CoverageCounts::default() } else { derived(1) });

    // NetworkAccess（EXECUTION_EVENT_TYPES 里确实没有任何网络访问事件类型）/
    // QuotaConsumption / SandboxPolicy / UserPrompts / UserCorrections：§13
    // 矩阵判 DSH unavailable 或矩阵没有 DSH 列的信号，如实记全零 coverage、
    // 不进 SignalSet，不编一个措辞好看的"未来支持"。v0.6 harness-contract spec
    // §6/§11-M2a：这五个信号不再是本文件的字面量表，改从 core
    // `harness_capability::HARNESSES` 的 "dsh" 行读（行上的值就是从这里原来的五行
    // 字面量搬过去的，golden 字节不变）。
    if let Some(profile) = agent_vitals_domain::harness_capability::harness_profile("dsh") {
        for signal in profile.unmeasured_signals.iter().copied() {
            coverage.set(signal, CoverageCounts::default());
        }
    }

    (signals, coverage)
}

/// execution_events + usage_events + cwd → `DshEvidence`。五段式流水线的
/// "derive → coverage" 两段；"locate → shape → extract" 留在
/// `src/dsh.rs::read_session_log`（P2 不动）。
pub fn build_dsh_evidence(
    execution_events: Vec<Value>,
    usage_events: Vec<Value>,
    cwd: Option<String>,
    session_id: String,
) -> DshEvidence {
    let (signals, coverage) = derive_coverage(&execution_events, &usage_events);
    let mut tool_calls = Timeline::new();
    let mut tool_results = Timeline::new();
    let mut approvals = Timeline::new();
    let mut sandbox_modes = Timeline::new();
    let mut turns = Timeline::new();
    // phase B：时间线在适配器的「derive」段一并填充——phase A（旧 match_behavior）
    // 里坐标顺延逻辑跑在规则引擎里，现在它是「翻译」的产物，先于规则存在。
    // 传进来的 execution_events 是分叉后的，时间线自然只含审计范围内的分叉后
    // 事件（audit_session_log 对 post_fork 后的 events 调用本函数）。
    populate_timelines(
        &execution_events,
        &mut tool_calls,
        &mut tool_results,
        &mut approvals,
        &mut sandbox_modes,
        &mut turns,
    );
    let canonical = CanonicalSession {
        meta: SessionMeta {
            session_id,
            harness_id: "dsh",
            workspace_roots: cwd.clone().into_iter().collect(),
            model: None,
            // D1–D4：喂进本证据的**执行流**事件的 `time` min/max。
            //
            // **只用 execution_events，不含 usage_events**——这是双实现口径的统一，
            // 不是遗漏：Python 侧 `dsh_evidence.build_dsh_canonical` 只接收
            // execution_events（`usage_events` 从未进过它的签名），若这里算上
            // usage，两个实现就会对同一份会话给出不同跨度，而差分门是逐字节比的。
            // 若将来需要覆盖 usage 时间，两边必须同时改（含 `behavior.py` 的调用点）。
            //
            // DSH 的 `time` **是毫秒**，过 `session_span` 是无操作但保持「单位归一
            // 只在一处」的纪律。调用方给的是分叉后的事件时，跨度自然只覆盖分叉后
            // ——这正确：跨度描述「这份证据是从什么算出来的」。0 条 → None。
            span: crate::workflow_utils::session_span(
                execution_events
                    .iter()
                    .filter_map(|e| e.get("time").and_then(Value::as_i64)),
            ),
        },
        signals,
        coverage,
        attempts: Vec::new(),
        notes: Vec::new(),
        tool_calls,
        tool_results,
        approvals,
        sandbox_modes,
        turns,
    };
    DshEvidence { canonical, execution_events, usage_events, cwd }
}

/// 临时反向投影——把 `DshEvidence` 转回 `behavior.rs` 现有规则引擎期待的
/// 输入形状（裸的 execution_events / usage_events / cwd）。P3 把规则迁到
/// 直接读 `Signal` 之后删掉这个函数，连同调用它的桥接代码。
pub fn reverse_project(evidence: &DshEvidence) -> (Vec<Value>, Vec<Value>, Option<String>) {
    (evidence.execution_events.clone(), evidence.usage_events.clone(), evidence.cwd.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(t: &str) -> Value {
        json!({"type": t, "seq": 0, "time": 0, "data": {}})
    }

    #[test]
    fn reverse_project_recovers_exact_events_and_cwd() {
        let execution_events = vec![ev("tool/call"), ev("tool/result")];
        let usage_events = vec![json!({"type": "tool/call", "seq": 0, "time": 0,
            "data": {"header": {"config": {"model": "m"}}}})];
        let evidence = build_dsh_evidence(
            execution_events.clone(), usage_events.clone(),
            Some("/repo".to_string()), "s1".to_string());
        let (ex, us, cwd) = reverse_project(&evidence);
        assert_eq!(ex, execution_events, "反向投影必须字节级还原 execution_events");
        assert_eq!(us, usage_events, "反向投影必须字节级还原 usage_events");
        assert_eq!(cwd, Some("/repo".to_string()));
    }

    #[test]
    fn reverse_project_recovers_none_cwd() {
        let evidence = build_dsh_evidence(vec![], vec![], None, "s1".to_string());
        let (_, _, cwd) = reverse_project(&evidence);
        assert_eq!(cwd, None);
    }

    #[test]
    fn tool_calls_and_results_counted_from_matching_event_types() {
        let events = vec![ev("tool/call"), ev("tool/call"), ev("tool/result"), ev("turn/start")];
        let evidence = build_dsh_evidence(events, vec![], None, "s1".to_string());
        let cov = &evidence.canonical.coverage;
        assert_eq!(cov.get(Signal::ToolCalls).measured, 2);
        assert_eq!(cov.get(Signal::ToolResults).measured, 1);
        assert!(evidence.canonical.signals.contains(Signal::ToolCalls));
        assert!(evidence.canonical.signals.contains(Signal::ToolResults));
    }

    #[test]
    fn subagent_spawns_counted_precisely_not_by_session_header_proxy() {
        // 回归测试：P3 group⑤ 之前用"有没有 session 头"这个粗代理判
        // SubagentSpawns 覆盖率——任何真实会话都有头，等于永远"有覆盖"，
        // 测不出"这份日志真的一次子代理都没派过"。现在直接数
        // tool/call name=="subagent"。
        let no_subagent = vec![ev("session"), ev("tool/call")];
        let evidence = build_dsh_evidence(no_subagent, vec![], None, "s1".to_string());
        assert!(!evidence.canonical.signals.contains(Signal::SubagentSpawns),
            "有 session 头但没有 tool/call name==subagent，不该判 SubagentSpawns 有覆盖");

        let with_subagent = vec![
            ev("session"),
            json!({"type": "tool/call", "seq": 1, "time": 1, "data": {"name": "subagent"}}),
        ];
        let evidence2 = build_dsh_evidence(with_subagent, vec![], None, "s1".to_string());
        assert_eq!(evidence2.canonical.coverage.get(Signal::SubagentSpawns).measured, 1);
    }

    #[test]
    fn skill_invocations_counts_user_message_and_tool_call_name_skill() {
        let events = vec![
            ev("session"),
            json!({"type": "user/message", "seq": 1, "time": 1,
                   "data": {"source": {"kind": "skill-invocation", "name": "b"}}}),
            json!({"type": "tool/call", "seq": 2, "time": 2, "data": {"name": "skill"}}),
            json!({"type": "tool/call", "seq": 3, "time": 3, "data": {"name": "bash"}}),
        ];
        let evidence = build_dsh_evidence(events, vec![], None, "s1".to_string());
        assert_eq!(evidence.canonical.coverage.get(Signal::SkillInvocations).measured, 2,
            "user/message(载体) + tool/call name==skill 各算一次，bash 那条不算");
    }

    #[test]
    fn absent_signal_is_not_in_signal_set_and_coverage_is_zero() {
        let evidence = build_dsh_evidence(vec![ev("tool/call")], vec![], None, "s1".to_string());
        assert!(!evidence.canonical.signals.contains(Signal::Hooks),
            "没有 hook/* 事件时 Hooks 不应进 SignalSet");
        assert_eq!(evidence.canonical.coverage.get(Signal::Hooks), CoverageCounts::default());
    }

    #[test]
    fn approval_asked_counts_toward_approval_decisions_signal() {
        // 回归测试:P3 group① 发现——只问过(approval/asked)但会话在等到
        // approval/decided 之前就结束,之前会被错判成 ApprovalDecisions
        // 全零覆盖(unavailable),明明日志里有证据。
        let evidence = build_dsh_evidence(vec![ev("approval/asked")], vec![], None, "s1".to_string());
        assert_eq!(evidence.canonical.coverage.get(Signal::ApprovalDecisions).measured, 1);
        assert!(evidence.canonical.signals.contains(Signal::ApprovalDecisions));
    }

    #[test]
    fn network_access_is_always_unavailable_for_dsh() {
        let evidence = build_dsh_evidence(vec![ev("tool/call")], vec![json!({"a": 1})], None, "s1".to_string());
        assert!(!evidence.canonical.signals.contains(Signal::NetworkAccess));
        assert_eq!(evidence.canonical.coverage.get(Signal::NetworkAccess), CoverageCounts::default());
    }

    #[test]
    fn unmapped_signals_are_unavailable_not_fabricated() {
        // §13 矩阵没有 DSH 列的三行——必须原样全零,不能编一个非零数字出来。
        let evidence = build_dsh_evidence(vec![ev("tool/call")], vec![json!({"a": 1})], None, "s1".to_string());
        for signal in [Signal::SandboxPolicy, Signal::UserPrompts, Signal::UserCorrections, Signal::QuotaConsumption] {
            assert_eq!(evidence.canonical.coverage.get(signal), CoverageCounts::default());
            assert!(!evidence.canonical.signals.contains(signal));
        }
    }

    #[test]
    fn usage_signal_measured_count_matches_usage_events_len() {
        let usage_events = vec![json!({"a": 1}), json!({"a": 2}), json!({"a": 3})];
        let evidence = build_dsh_evidence(vec![], usage_events, None, "s1".to_string());
        assert_eq!(evidence.canonical.coverage.get(Signal::Usage).measured, 3);
        assert!(evidence.canonical.signals.contains(Signal::Usage));
    }

    #[test]
    fn empty_session_has_no_signals_measured() {
        let evidence = build_dsh_evidence(vec![], vec![], None, "s1".to_string());
        assert_eq!(evidence.canonical.coverage.overall_ratio(), None);
    }

    #[test]
    fn session_meta_carries_dsh_harness_id_and_workspace_root() {
        let evidence = build_dsh_evidence(vec![], vec![], Some("/x/y".to_string()), "s1".to_string());
        assert_eq!(evidence.canonical.meta.harness_id, "dsh");
        assert_eq!(evidence.canonical.meta.workspace_roots, vec!["/x/y".to_string()]);
        assert_eq!(evidence.canonical.meta.session_id, "s1");
    }
}
