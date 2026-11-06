//! 轨迹级检测器 —— 跨事件/序列级的高危模式（family ④，SV611–614）。
//!
//! 与 `behavior` 模块（SV601–610 单事件静态匹配）是两层审计：这里的四个检测器
//! 看窗口、计数、连续段，捕捉「单条事件看不出来」的轨迹症状：
//!   SV611 重复工具调用 —— 连续相同 (name, arguments) 签名 ≥3 次
//!   SV612 死循环 —— 连续两个动作序列相同的 turn
//!   SV613 进度停滞 —— 连续 error turn / 连续工具失败
//!   SV614 权限异常 —— 同一调用反复审批 / 连续拒绝 / 危险模式反复授予
//!
//! phase B 第二刀：检测器改吃 `CanonicalSession` 的五个时间线（不再读裸执行环境
//! 事件），三态由 `match_trajectory_canonical` **前置门控**产出（`requires ⊆
//! coverage` 不满足就根本不跑，§10 三态契约）。`match_trajectory(&[Value])`
//! 降级为兼容 shim（wasm `audit_events` 与差分测试继续调），内部 = post_fork
//! → 建 canonical → 门控 dispatch → flatten，与 `match_behavior` shim 同款。
//! Python 平行实现 `scripts/agent_vitals/agent/trajectory.py`，parity 测试逐字节看守。
//!
//! 阈值常量选值避开 `fixtures/dsh/behavior.jsonl`（无重复调用、≤2 审批、≤1 超时、
//! 无连续 error turn），让「全部规则都命中」的 fixture 保持干净。harness 侧证实：
//! `turn/end.reason.kind` 是唯一 LLM 失败信号、`step/end` 是完成心跳、`repeat-tool-
//! reminder` guard 只存内存（事后审计必须自己重算）——这些都直接落到下面的语义里。

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::behavior::{normalize, outcome_from, FamilyRule};
use crate::evidence::{
    ApprovalObservation, CanonicalSession, RuleOutcome, SandboxModeObservation, Signal,
    TimelineEntry, ToolCallObservation, ToolResultObservation, TurnObservation,
};

// ── 阈值常量（与 Python 镜像逐字节一致）─────────────────────────────────
const MIN_REPEAT: usize = 3; // SV611 连续相同签名次数
const MIN_LOOP_TURNS: usize = 2; // SV612 连续相同签名 turn 数
const MIN_ERROR_TURNS: usize = 2; // SV613a 连续 error turn 数
const MIN_FAILED_RESULTS: usize = 3; // SV613b 连续带 error.code 的 tool/result 数
const MIN_SAME_CALL_APPROVALS: usize = 3; // SV614a 同一 callId 审批次数
const MIN_CONSECUTIVE_REJECTIONS: usize = 3; // SV614b 连续 rejected 数
const MIN_DANGER_GRANTS: usize = 2; // SV614c danger-full-access 出现次数

/// 一条轨迹 finding。与 `match_behavior` 的 finding 同构（12 键、键序一致，
/// `tests/test_characterization.py::test_trajectory_findings_share_the_same_
/// key_order` 逐字节看守）——追加进同一数组时 diff/排序/渲染零改动。
/// `tool_name` 只在 SV611 有意义（重复的工具名），其余轨迹级模式诚实置 null。
///
/// `run_end_seq`（G2，GOVERNANCE_BACKLOG.md）：`seq` 只是判定命中那一刻的
/// 锚点，本身推不出这段异常在事件流里烧到哪个 seq 才算完——`[seq,
/// run_end_seq]` 才是可以拿去跟 `costReport.series`/`request_metrics` 对齐、
/// 算"这段烧了多少钱"的真实区间。只有 SV611/612/613 填真实值；SV614（权限
/// 异常）没有"这一段烧了多少"的概念（是计数类判定，不是区间类），置 null——
/// 不臆造一个不存在的区间。SV612 的区间刻意**只覆盖被判定重复的那个 turn**
/// （`seq` 锚定的那个），不回溯到被复制的原 turn——扩到两个 turn 需要在
/// finding 里再带一个"区间起点"，backlog 把这个決定判给了"先给最小可用版本"
/// 一侧，读这条 finding 的人要连原 turn 的花费一起看，需要另外用 `turn`
/// 字段自己找上一个 turn。
#[allow(clippy::too_many_arguments)]
fn finding(
    rule: &'static str,
    severity: &'static str,
    category: &'static str,
    tool: Option<&str>,
    evidence: String,
    seq: Option<i64>,
    time: Option<i64>,
    turn: Option<i64>,
    step: Option<i64>,
    call_id: Option<&str>,
    run_end_seq: Option<i64>,
) -> Value {
    let to_json = |v: Option<i64>| v.map_or(Value::Null, |n| json!(n));
    json!({
        "rule": rule,
        "severity": severity,
        "category": category,
        "tool_name": match tool {
            Some(t) => Value::String(t.to_string()),
            None => Value::Null,
        },
        "evidence": normalize(&evidence),
        "seq": to_json(seq),
        "time": to_json(time),
        "turn": to_json(turn),
        "step": to_json(step),
        "call_id": call_id.map_or(Value::Null, |s| json!(s)),
        "evidence_recency": "log",
        "run_end_seq": to_json(run_end_seq),
    })
}

/// `finding` 的 entry 便捷层：seq/time/turn/step/call_id 全部取自 entry——
/// 适配器已经用 `Coords` 顺延定好（§11.5），检测器不再需要坐标状态机。
/// SV613(a) 例外：锚点是 turn/end 自身的 seq/time（`end_seq`/`end_time`），
/// 直接调 `finding` 而非走这里。
fn from_entry<T>(
    rule: &'static str,
    severity: &'static str,
    category: &'static str,
    tool: Option<&str>,
    evidence: String,
    entry: &TimelineEntry<T>,
    run_end_seq: Option<i64>,
) -> Value {
    finding(
        rule,
        severity,
        category,
        tool,
        evidence,
        entry.seq,
        entry.time,
        entry.turn,
        entry.step,
        entry.call_id.as_deref(),
        run_end_seq,
    )
}

/// `seq → (turn, step, call_id)`。
///
/// 只在适配器之前做坐标顺延（`Coords` 状态机）。phase B 第二刀之后轨迹检测器
/// 直接读 timeline entry 的坐标，不再查这张表——它留给 `skill.rs`（T3，Skill
/// 执行审计）给 `skill-invocation` 载体找 turn/step 用，那类事件不像 `tool/call`
/// 自带坐标，只能靠边界顺延。
pub(crate) fn coord_map(events: &[Value]) -> std::collections::HashMap<i64, (Value, Value, Value)> {
    let mut map = std::collections::HashMap::new();
    let mut coords = crate::coords::Coords::default();
    for event in events {
        if !event.is_object() {
            continue;
        }
        coords.observe(event);
        if let Some(seq) = event.get("seq").and_then(|v| v.as_i64()) {
            map.insert(seq, coords.resolve(event));
        }
    }
    map
}

// `match_trajectory`（DSH 原始事件 → findings 的兼容 shim）phase C 迁进
// `agent-vitals-harnesses` 的 `harnesses/dsh/sessions/audit`（Phase D1）。规则本体
// `match_trajectory_canonical`（吃 `&CanonicalSession`）与 `coord_map`
// （skill.rs 用的坐标顺延）留在这里。

/// family ④（trajectory，SV611–614）**前置门控**的 dispatcher——先滤后调，
/// 镜像 `match_behavior_canonical`：`requires` 里任一信号对应的 timeline 为空
/// → 直接 `Unavailable`、不跑检测器；否则跑检测器，命中 → `Findings`、零命中
/// → `MeasuredZero`。门控读 timeline 而非 coverage（为什么，见
/// `CanonicalSession::timeline_is_empty`）。
///
/// SV613/614 的 `requires` 是「至少一个信号有证据」（OR），不是「全部都要」
/// （AND）——两个子判定读不同信号、任一有证据规则就不是完全测不了，见
/// `OR_REQUIRES_CODES`。旧实现 `trajectory_rule_outcomes` 是在 `match_trajectory`
/// 跑满之后**后置**补三态；门控后检测器根本不跑，unavailable 的规则绝不
/// 报出 finding（与 family ① SV610 同一个分叉修正）。
pub fn match_trajectory_canonical(s: &CanonicalSession) -> Vec<(&'static str, RuleOutcome)> {
    TRAJECTORY_RULES
        .iter()
        .map(|rule| {
            // 门控读 timeline 非空而非 coverage 计数：对 DSH 恒等价（coverage 与
            // timeline 同源），但 Codex 上曾分叉——`derive_coverage` 数出非零
            // measured、timeline 却为空（当时「恒为空」的假结论，2026-08 起原生
            // 填满 4 条，只余 approvals 空），读计数会让门控放行、检测器在空
            // 时间线上空转产出 MeasuredZero。见
            // `CanonicalSession::timeline_is_empty`。
            let missing: Vec<Signal> = rule
                .requires
                .iter()
                .filter(|sig| s.timeline_is_empty(**sig))
                .copied()
                .collect();
            let is_unavailable = if OR_REQUIRES_CODES.contains(&rule.code) {
                !rule.requires.is_empty() && missing.len() == rule.requires.len()
            } else {
                !missing.is_empty()
            };
            if is_unavailable {
                return (
                    rule.code,
                    RuleOutcome::Unavailable {
                        missing,
                        reason: "no evidence for required signal(s) in this session".to_string(),
                    },
                );
            }
            (rule.code, (rule.detect)(s))
        })
        .collect()
}

/// 把 family ④ 的 outcomes 摊平成 findings 数组。轨迹 finding 本就按码序产出
/// （SV611→614、子判定 a→b→c），**不 sort、不带 `__ord`**——`flatten` 重建
/// (event, rule) 字节序的私有键机制只属于 family ①（`match_behavior` 一条 bash
/// 同时命中多条规则、需要按事件下标排序）；轨迹按码序追加，与旧实现逐字节一致。
pub fn flatten_trajectory(outcomes: &[(&'static str, RuleOutcome)]) -> Vec<Value> {
    outcomes
        .iter()
        .flat_map(|(_, outcome)| match outcome {
            RuleOutcome::Findings(fs) => fs.clone(),
            _ => Vec::new(),
        })
        .collect()
}

/// `requires` 是"至少一个信号有证据"（OR），不是"全部都要"（AND）的规则码。
/// SV613/614 各自的子判定读不同信号、任一有证据规则就不是完全测不了；
/// SV611/612 都是单信号 requires，AND/OR 在单元素列表上等价，不受影响。
/// 从 behavior.rs 挪到本模块（trajectory dispatcher 是它唯一的使用方）。
const OR_REQUIRES_CODES: [&str; 2] = ["SV613", "SV614"];

/// family ④ 规则表。`requires` 必须与 `rule_specs()`（behavior.rs）里同名规则的
/// `requires` 逐条一致——两处漂移会让「前置门控」和规格声明对同一条规则给出
/// 不同的三态语义，静默破坏契约（lockstep 测试钉着）。
/// severity/category 沿用旧值：SV611/612/613 = warning/trajectory，
/// SV614 = warning/approval。
pub(crate) const TRAJECTORY_RULES: &[FamilyRule] = &[
    FamilyRule { code: "SV611", severity: "warning", category: "trajectory", requires: &[Signal::ToolCalls], detect: detect_sv611 },
    FamilyRule { code: "SV612", severity: "warning", category: "trajectory", requires: &[Signal::TurnBoundaries], detect: detect_sv612 },
    FamilyRule { code: "SV613", severity: "warning", category: "trajectory", requires: &[Signal::TurnBoundaries, Signal::ToolResults], detect: detect_sv613 },
    FamilyRule { code: "SV614", severity: "warning", category: "approval", requires: &[Signal::ApprovalDecisions, Signal::SandboxModes], detect: detect_sv614 },
];

/// SV611：连续相同 (name, arguments) 签名 ≥3 次。
///
/// 对齐 harness `repeat-tool-reminder` 的**连续**语义（同一个调用紧挨着又来一遍
/// 才是「重复」，不是全会话里出现过几次）——区别在：它只存内存、重启即清零，
/// 这里从事件流重算。每次越过 MIN_REPEAT 的倍数报一条（run 为 6 时报 ×3 和 ×6，
/// 锚点始终是 run 起点）。
/// §14.4 生产切换。见 `behavior.rs::detect_sv601` 头部注释——同一套纪律：
/// 门控不受影响，`run_single_rule` 失败退回 `detect_sv611_legacy`。
fn detect_sv611(s: &CanonicalSession) -> RuleOutcome {
    match crate::compatibility::run_single_rule(
        s,
        crate::detectors::Sv611Detector,
        &[(crate::compatibility::canonical_session::SIGNAL_TOOL_CALLS, crate::compatibility::canonical_session::KIND_TOOL_CALL)],
    ) {
        Some(findings) => outcome_from(findings),
        None => detect_sv611_legacy(s),
    }
}

/// 原判定逻辑，一字未改——见 `behavior.rs::detect_sv601_legacy` 为什么特意
/// 留 `pub`：这份也是 `sv611_parity.rs` 差分对照的入口。
pub fn detect_sv611_legacy(s: &CanonicalSession) -> RuleOutcome {
    let mut out = Vec::new();
    let mut prev: Option<(String, String)> = None; // (name, args) 签名
    let mut count: usize = 0;
    let mut anchor: Option<&TimelineEntry<ToolCallObservation>> = None;
    for e in &s.tool_calls.entries {
        let sig = (e.observation.name.clone(), e.observation.args_text.clone());
        if prev.as_ref() == Some(&sig) {
            count += 1;
        } else {
            prev = Some(sig);
            count = 1;
            anchor = Some(e);
        }
        if count >= MIN_REPEAT && count % MIN_REPEAT == 0 {
            if let Some(a) = anchor {
                out.push(from_entry(
                    "SV611",
                    "warning",
                    "trajectory",
                    Some(&a.observation.name),
                    format!("{} 连续重复 {} 次", a.observation.name, count),
                    a,
                    // G2：本次达标窗口的终点就是让 count 越过阈值倍数的这个事件；
                    // 窗口是累计的（锚点 anchor 始终是 run 起点），所以 run 到 6 时
                    // 再报一次，覆盖的区间会比到 3 时那次更宽——如实反映"这一段
                    // 到目前为止一共烧了多少"，不是"最近 3 次"这个更窄的窗口。
                    e.seq,
                ));
            }
        }
    }
    outcome_from(out)
}

/// SV612：连续两个「动作序列相同」的 turn。
///
/// turn 签名 = 该 turn 内 tool/call（含 code-dispatch）的 (name, arguments) 有序
/// 列表，按 turn/start 边界分组（`TurnObservation.sig`）；空 turn（无工具调用）
/// 跳过——两个都没有动作的 turn 不是死循环。同一段连续相同 turn 只报一次
/// （run 内不再重报）。
/// §14.4 生产切换（同 `detect_sv611` 头部注释）。
fn detect_sv612(s: &CanonicalSession) -> RuleOutcome {
    match crate::compatibility::run_single_rule(
        s,
        crate::detectors::Sv612Detector,
        &[(crate::compatibility::canonical_session::SIGNAL_TURN_BOUNDARIES, crate::compatibility::canonical_session::KIND_TURN)],
    ) {
        Some(findings) => outcome_from(findings),
        None => detect_sv612_legacy(s),
    }
}

/// 原判定逻辑，一字未改——`sv612_parity.rs` 差分对照的入口。
pub fn detect_sv612_legacy(s: &CanonicalSession) -> RuleOutcome {
    let mut out = Vec::new();
    let mut prev_sig: Option<Vec<(String, String)>> = None;
    let mut run_count: usize = 0;
    for e in &s.turns.entries {
        if e.observation.sig.is_empty() {
            continue;
        }
        if prev_sig.as_ref() == Some(&e.observation.sig) {
            run_count += 1;
        } else {
            prev_sig = Some(e.observation.sig.clone());
            run_count = 1;
        }
        // 只在 run 长度恰好到达阈值时报一次（run 更长不重报，run 中断后新序列重新数）
        if run_count == MIN_LOOP_TURNS {
            out.push(from_entry(
                "SV612",
                "warning",
                "trajectory",
                None,
                format!(
                    "死循环: turn {} 与上一 turn 动作序列相同",
                    e.observation.turn,
                ),
                e,
                // G2：只覆盖判定命中的这个 turn（seq 锚定的那个），不含被
                // 复制的上一个 turn——见 finding() 文档注释的设计取舍。
                // `last_seq` = 这个 turn 烧到的最后一个事件 seq（下一个
                // turn/start 前的任何事件都推进它），不是 turn/end 自己的 seq。
                e.observation.last_seq,
            ));
        }
    }
    outcome_from(out)
}

/// SV613：进度停滞。
///
/// (a) 连续 `turn/end` 以 `reason.kind=="error"` 结束 —— LLM 级停滞；
/// (b) 连续 `tool/result` 带 `error.code` —— 工具级停滞。
/// 各自只在同类事件上跑 run；**run 在「断掉」（一个成功/无关事件）或流结束时
/// 关闭，报 run 的真实总长度**（真实 run 5 个失败就报 5，不报阈值倍数 3）——
/// 锚点仍是 run 起点。真实日志 e4b0be69 的 6 连 edit 失败由此报「连续 5 个」。
/// §14.4 生产切换。SV613 是第一条用 `Any` requirement 的切换——两个信号任一
/// 有证据都要跑，`run_single_rule` 的 `signal_kinds` 列出两组 (signal, kind)，
/// 由 `Sv613Detector::requirement()` 自己声明 `Any`，这里不用关心。
fn detect_sv613(s: &CanonicalSession) -> RuleOutcome {
    match crate::compatibility::run_single_rule(
        s,
        crate::detectors::Sv613Detector,
        &[
            (crate::compatibility::canonical_session::SIGNAL_TURN_BOUNDARIES, crate::compatibility::canonical_session::KIND_TURN),
            (crate::compatibility::canonical_session::SIGNAL_TOOL_RESULTS, crate::compatibility::canonical_session::KIND_TOOL_RESULT),
        ],
    ) {
        Some(findings) => outcome_from(findings),
        None => detect_sv613_legacy(s),
    }
}

/// 原判定逻辑，一字未改——`sv613_parity.rs` 差分对照的入口。
pub fn detect_sv613_legacy(s: &CanonicalSession) -> RuleOutcome {
    let mut out = Vec::new();

    // (a) 连续 error turn。只把有 turn/end 的 turn 算进序列（`end_seq == None`
    // 说明这个 turn 没有 turn/end 事件——旧实现遍历 turn/end 事件，这类 turn
    // 根本不出现，既不断 run 也不续 run，所以这里直接跳过不冲刷）：
    // `end_reason_kind == Some("error")` 续 run，`Some(其他)` 冲刷。
    let mut err_run: usize = 0;
    let mut err_anchor: Option<&TimelineEntry<TurnObservation>> = None;
    let mut err_last: Option<i64> = None; // G2：run 内最后一个 error turn/end 的 seq
    for e in &s.turns.entries {
        match (&e.observation.end_seq, &e.observation.end_reason_kind) {
            (None, _) => continue,
            (Some(_), Some(k)) if k == "error" => {
                if err_run == 0 {
                    err_anchor = Some(e);
                }
                err_run += 1;
                err_last = e.observation.end_seq;
            }
            (Some(_), _) => flush_error_run(&mut out, &mut err_run, &mut err_anchor, &mut err_last),
        }
    }
    flush_error_run(&mut out, &mut err_run, &mut err_anchor, &mut err_last);

    // (b) 连续 tool/result 失败。失败判据 = 原因码（DSH/Codex）**或** lossy 失败
    // 标志（Claude：is_error→failed，§3，error_code 恒 None 时该标志是唯一的失败
    // 证据）。DSH/Codex 的 `failed` 恒 None，`failed == Some(true)` 对它们恒 false，
    // 整个布尔式退化成原来的 `error_code.is_some()`——golden 字节零漂移。
    let mut fail_run: usize = 0;
    let mut fail_anchor: Option<&TimelineEntry<ToolResultObservation>> = None;
    let mut fail_last: Option<i64> = None; // G2：run 内最后一个事件的 seq
    for e in &s.tool_results.entries {
        if e.observation.failed == Some(true) || e.observation.error_code.is_some() {
            if fail_run == 0 {
                fail_anchor = Some(e);
            }
            fail_run += 1;
            fail_last = e.seq;
        } else {
            flush_fail_run(&mut out, &mut fail_run, &mut fail_anchor, &mut fail_last);
        }
    }
    flush_fail_run(&mut out, &mut fail_run, &mut fail_anchor, &mut fail_last);

    outcome_from(out)
}

/// 关闭一个 error-turn run：达到阈值则报一条（evidence 用 run 总长度），再复位。
/// `last_seq`（G2）是 run 里最后一个 error turn/end 的 seq——与锚点 seq 一起
/// 构成 `[seq, run_end_seq]` 这段停滞真实覆盖的区间。
fn flush_error_run(
    out: &mut Vec<Value>,
    run: &mut usize,
    anchor: &mut Option<&TimelineEntry<TurnObservation>>,
    last_seq: &mut Option<i64>,
) {
    if *run >= MIN_ERROR_TURNS {
        if let Some(a) = anchor {
            let code = a.observation.end_error_code.clone().unwrap_or_default();
            let suffix = if code.is_empty() {
                String::new()
            } else {
                format!("（{}）", code)
            };
            // 锚点是**第一个 error turn/end** 自身的 seq/time（`end_seq`/
            // `end_time`），不是 turn/start 的——旧实现按 seq 回填坐标时
            // turn/end 事件自带的 data.turn 就是锚点 seq 的解；turn/step/call_id
            // 走 entry（turn/start 的坐标）。两者在 fixture 里同值（turn/end
            // 恒带 data.turn），`turn` 用 entry 的即可。
            out.push(finding(
                "SV613",
                "warning",
                "trajectory",
                None,
                format!("进度停滞: 连续 {} 个 turn 以 error 结束{}", *run, suffix),
                a.observation.end_seq,
                a.observation.end_time,
                a.turn,
                a.step,
                a.call_id.as_deref(),
                *last_seq,
            ));
        }
    }
    *run = 0;
    *anchor = None;
    *last_seq = None;
}

/// 关闭一个 tool-failure run：同上，evidence 报 run 总长度。
fn flush_fail_run(
    out: &mut Vec<Value>,
    run: &mut usize,
    anchor: &mut Option<&TimelineEntry<ToolResultObservation>>,
    last_seq: &mut Option<i64>,
) {
    if *run >= MIN_FAILED_RESULTS {
        if let Some(a) = anchor {
            let first_code = a.observation.error_code.clone().unwrap_or_default();
            out.push(from_entry(
                "SV613",
                "warning",
                "trajectory",
                None,
                format!("进度停滞: 连续 {} 个工具失败（首个 {}）", *run, first_code),
                a,
                *last_seq,
            ));
        }
    }
    *run = 0;
    *anchor = None;
    *last_seq = None;
}

/// §14.4 生产切换（同 `detect_sv613`：`Any` requirement，两个信号任一有证
/// 据都要跑）。
fn detect_sv614(s: &CanonicalSession) -> RuleOutcome {
    match crate::compatibility::run_single_rule(
        s,
        crate::detectors::Sv614Detector,
        &[
            (crate::compatibility::canonical_session::SIGNAL_APPROVAL_DECISIONS, crate::compatibility::canonical_session::KIND_APPROVAL),
            (crate::compatibility::canonical_session::SIGNAL_SANDBOX_MODES, crate::compatibility::canonical_session::KIND_SANDBOX_MODE),
        ],
    ) {
        Some(findings) => outcome_from(findings),
        None => detect_sv614_legacy(s),
    }
}

/// 原判定逻辑，一字未改——`sv614_parity.rs` 差分对照的入口。
pub fn detect_sv614_legacy(s: &CanonicalSession) -> RuleOutcome {
    let mut out = Vec::new();

    // (a) 同一 callId 审批次数（只算 asked 端——callId 是 approval/asked 自带、
    //    approval/decided 没有，见 Coords::resolve 的 own-only 解析）。
    let mut by_call: HashMap<&str, (usize, &TimelineEntry<ApprovalObservation>)> = HashMap::new();
    for e in &s.approvals.entries {
        if e.observation.asked.is_none() {
            continue;
        }
        let Some(call_id) = e.call_id.as_deref() else {
            continue;
        };
        let entry = by_call.entry(call_id).or_insert_with(|| (0, e));
        if entry.0 == 0 {
            entry.1 = e;
        }
        entry.0 += 1;
    }
    // HashMap 迭代顺序不确定 —— 按 callId 排序保证确定性（差分护栏要求）。
    let mut calls: Vec<(&&str, &(usize, &TimelineEntry<ApprovalObservation>))> =
        by_call.iter().collect();
    calls.sort_by(|a, b| a.0.cmp(b.0));
    for (call_id, (count, anchor)) in calls {
        if *count >= MIN_SAME_CALL_APPROVALS {
            out.push(from_entry(
                "SV614",
                "warning",
                "approval",
                None,
                format!("权限异常: 同一调用 {} 请求审批 {} 次", call_id, count),
                anchor,
                // G2：SV614 是计数类判定（同一调用审批几次），不是区间类
                // （没有"从哪烧到哪"的概念）——诚实置 null，不臆造一个区间。
                None,
            ));
        }
    }

    // (b) 连续 rejected。只遍历 decided 端；asked 事件夹在中间不断 run
    //    （旧实现先按 type 过滤 approval/decided，asked 从不进循环）。
    let mut rej_run: usize = 0;
    let mut anchor: Option<&TimelineEntry<ApprovalObservation>> = None;
    for e in &s.approvals.entries {
        let Some(decided) = &e.observation.decided else { continue };
        if decided.outcome == "rejected" {
            if rej_run == 0 {
                anchor = Some(e);
            }
            rej_run += 1;
            if rej_run >= MIN_CONSECUTIVE_REJECTIONS && rej_run % MIN_CONSECUTIVE_REJECTIONS == 0 {
                if let Some(a) = anchor {
                    out.push(from_entry(
                        "SV614",
                        "warning",
                        "approval",
                        None,
                        format!("权限异常: 连续 {} 次审批被拒", rej_run),
                        a,
                        None,
                    ));
                }
            }
        } else {
            rej_run = 0;
            anchor = None;
        }
    }

    // (c) danger-full-access 出现次数
    let mut danger: usize = 0;
    let mut danchor: Option<&TimelineEntry<SandboxModeObservation>> = None;
    for e in &s.sandbox_modes.entries {
        if e.observation.mode == "danger-full-access" {
            if danger == 0 {
                danchor = Some(e);
            }
            danger += 1;
        }
    }
    if danger >= MIN_DANGER_GRANTS {
        if let Some(a) = danchor {
            out.push(from_entry(
                "SV614",
                "warning",
                "approval",
                None,
                format!("权限异常: 危险模式 danger-full-access 授予 {} 次", danger),
                a,
                None,
            ));
        }
    }
    outcome_from(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    // `match_trajectory` 的 raw-shim 已迁 audit；raw-events 测试继续在这里调它
    // （测试依赖，非生产依赖——crate 拆分后经 dev-dependency 解析）。
    use agent_vitals_harnesses::audit::match_trajectory;

    fn ev(etype: &str, seq: i64, time: i64, data: Value) -> Value {
        json!({"type": etype, "seq": seq, "time": time, "data": data})
    }

    fn tool_call(name: &str, arguments: &str, seq: i64) -> Value {
        ev("tool/call", seq, 1000 + seq, json!({"name": name, "arguments": arguments}))
    }

    fn turn_start(turn: i64, seq: i64) -> Value {
        ev("turn/start", seq, 1000 + seq, json!({"turn": turn}))
    }

    fn turn_end(turn: i64, seq: i64, kind: &str) -> Value {
        ev("turn/end", seq, 1000 + seq, json!({"turn": turn, "reason": {"kind": kind}}))
    }

    fn tool_result_error(seq: i64, code: &str) -> Value {
        ev("tool/result", seq, 1000 + seq,
           json!({"message": {"content": []}, "error": {"name": "x", "code": code}}))
    }

    #[test]
    fn sv611_repeated_tool_call_hit_and_miss() {
        let hit = [
            tool_call("bash", r#"{"command":"ls"}"#, 1),
            tool_call("bash", r#"{"command":"ls"}"#, 2),
            tool_call("bash", r#"{"command":"ls"}"#, 3),
        ];
        let out = match_trajectory(&hit);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["rule"], "SV611");
        assert_eq!(out[0]["tool_name"], "bash");
        assert_eq!(out[0]["seq"], 1); // 锚点是 run 起点

        // miss：参数不同不算重复；只有 2 次不算
        let miss1 = [
            tool_call("bash", r#"{"command":"ls"}"#, 1),
            tool_call("bash", r#"{"command":"ls -la"}"#, 2),
            tool_call("bash", r#"{"command":"ls"}"#, 3),
        ];
        assert!(match_trajectory(&miss1).is_empty());
        let miss2 = [
            tool_call("bash", r#"{"command":"ls"}"#, 1),
            tool_call("bash", r#"{"command":"ls"}"#, 2),
        ];
        assert!(match_trajectory(&miss2).is_empty());
    }

    #[test]
    fn sv612_dead_loop_hit_and_miss() {
        // turn 1 与 turn 2 动作序列相同 → 命中
        let hit = [
            turn_start(1, 1),
            tool_call("bash", r#"{"command":"ls"}"#, 2),
            tool_call("write", r#"{"file_path":"a"}"#, 3),
            turn_start(2, 4),
            tool_call("bash", r#"{"command":"ls"}"#, 5),
            tool_call("write", r#"{"file_path":"a"}"#, 6),
        ];
        let out = match_trajectory(&hit);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["rule"], "SV612");
        assert_eq!(out[0]["seq"], 4); // 第二个 turn 的 turn/start

        // miss：turn 序列不同
        let miss = [
            turn_start(1, 1),
            tool_call("bash", r#"{"command":"ls"}"#, 2),
            turn_start(2, 3),
            tool_call("write", r#"{"file_path":"a"}"#, 4),
        ];
        assert!(match_trajectory(&miss).is_empty());
    }

    #[test]
    fn sv613_stall_hit_and_miss() {
        // (a) 连续 2 个 error turn
        let hit_a = [
            turn_start(1, 1),
            turn_end(1, 2, "error"),
            turn_start(2, 3),
            turn_end(2, 4, "error"),
        ];
        let out = match_trajectory(&hit_a);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["rule"], "SV613");
        // 锚点是第一个 error turn/end（seq 2），不是 turn/start
        assert_eq!(out[0]["seq"], 2);

        // (b) 连续 3 个工具失败
        let hit_b = [
            tool_result_error(1, "TOOL_TIMEOUT"),
            tool_result_error(2, "TOOL_TIMEOUT"),
            tool_result_error(3, "TOOL_TIMEOUT"),
        ];
        let out_b = match_trajectory(&hit_b);
        assert_eq!(out_b.len(), 1);
        assert_eq!(out_b[0]["rule"], "SV613");

        // miss：中间有成功结果打断
        let miss = [
            tool_result_error(1, "TOOL_TIMEOUT"),
            tool_result_error(2, "TOOL_TIMEOUT"),
            ev("tool/result", 3, 1003, json!({"message": {"content": []}})),
            tool_result_error(4, "TOOL_TIMEOUT"),
        ];
        assert!(match_trajectory(&miss).is_empty());
    }

    #[test]
    fn sv614_permission_anomaly_hit_and_miss() {
        // (a) 同一 callId 审批 3 次
        let hit_a = [
            ev("approval/asked", 1, 1001, json!({"id": "a1", "toolName": "bash", "callId": "c1"})),
            ev("approval/asked", 2, 1002, json!({"id": "a2", "toolName": "bash", "callId": "c1"})),
            ev("approval/asked", 3, 1003, json!({"id": "a3", "toolName": "bash", "callId": "c1"})),
        ];
        let out = match_trajectory(&hit_a);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["rule"], "SV614");
        assert!(out[0]["evidence"].as_str().unwrap().contains("c1"));

        // (b) 连续 3 次 rejected
        let hit_b = [
            ev("approval/decided", 1, 1001, json!({"id": "a1", "outcome": "rejected"})),
            ev("approval/decided", 2, 1002, json!({"id": "a2", "outcome": "rejected"})),
            ev("approval/decided", 3, 1003, json!({"id": "a3", "outcome": "rejected"})),
        ];
        let out_b = match_trajectory(&hit_b);
        assert_eq!(out_b.len(), 1);
        assert_eq!(out_b[0]["rule"], "SV614");

        // (c) danger-full-access 2 次
        let hit_c = [
            ev("sandbox/mode", 1, 1001, json!({"mode": "danger-full-access"})),
            ev("sandbox/mode", 2, 1002, json!({"mode": "workspace-write"})),
            ev("sandbox/mode", 3, 1003, json!({"mode": "danger-full-access"})),
        ];
        let out_c = match_trajectory(&hit_c);
        assert_eq!(out_c.len(), 1);
        assert_eq!(out_c[0]["rule"], "SV614");

        // miss：2 次审批不同 callId；1 次 rejected；1 次 danger
        let miss = [
            ev("approval/asked", 1, 1001, json!({"id": "a1", "toolName": "bash", "callId": "c1"})),
            ev("approval/asked", 2, 1002, json!({"id": "a2", "toolName": "bash", "callId": "c2"})),
            ev("approval/decided", 3, 1003, json!({"id": "a1", "outcome": "rejected"})),
            ev("sandbox/mode", 4, 1004, json!({"mode": "danger-full-access"})),
        ];
        assert!(match_trajectory(&miss).is_empty());
    }

    /// Python `json.dumps(match_trajectory(events), ensure_ascii=False, separators=(",", ":"))`
    /// 对同一事件流（覆盖全部 4 个检测器：重复调用/死循环/停滞/权限异常）的逐字节对照。
    /// 期望串在 Python 侧生成后硬编码于此，Python 一改这里就红。
    #[test]
    fn match_trajectory_python_rust_byte_for_byte_parity() {
        let events = [
            json!({"type":"tool/call","seq":1,"time":1001,"data":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}),
            json!({"type":"tool/call","seq":2,"time":1002,"data":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}),
            json!({"type":"tool/call","seq":3,"time":1003,"data":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}),
            json!({"type":"turn/start","seq":4,"time":1004,"data":{"turn":1}}),
            json!({"type":"tool/call","seq":5,"time":1005,"data":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}),
            json!({"type":"tool/call","seq":6,"time":1006,"data":{"name":"write","arguments":"{\"file_path\":\"a\"}"}}),
            json!({"type":"turn/start","seq":7,"time":1007,"data":{"turn":2}}),
            json!({"type":"tool/call","seq":8,"time":1008,"data":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}),
            json!({"type":"tool/call","seq":9,"time":1009,"data":{"name":"write","arguments":"{\"file_path\":\"a\"}"}}),
            json!({"type":"turn/start","seq":10,"time":1010,"data":{"turn":3}}),
            json!({"type":"turn/end","seq":11,"time":1011,"data":{"turn":3,"reason":{"kind":"error"}}}),
            json!({"type":"turn/start","seq":12,"time":1012,"data":{"turn":4}}),
            json!({"type":"turn/end","seq":13,"time":1013,"data":{"turn":4,"reason":{"kind":"error"}}}),
            json!({"type":"tool/result","seq":14,"time":1014,"data":{"message":{"content":[]},"error":{"name":"x","code":"TOOL_TIMEOUT"}}}),
            json!({"type":"tool/result","seq":15,"time":1015,"data":{"message":{"content":[]},"error":{"name":"x","code":"TOOL_TIMEOUT"}}}),
            json!({"type":"tool/result","seq":16,"time":1016,"data":{"message":{"content":[]},"error":{"name":"x","code":"TOOL_TIMEOUT"}}}),
            json!({"type":"approval/asked","seq":17,"time":1017,"data":{"id":"a1","toolName":"bash","callId":"c1"}}),
            json!({"type":"approval/asked","seq":18,"time":1018,"data":{"id":"a2","toolName":"bash","callId":"c1"}}),
            json!({"type":"approval/asked","seq":19,"time":1019,"data":{"id":"a3","toolName":"bash","callId":"c1"}}),
            json!({"type":"approval/decided","seq":20,"time":1020,"data":{"id":"a1","outcome":"rejected"}}),
            json!({"type":"approval/decided","seq":21,"time":1021,"data":{"id":"a2","outcome":"rejected"}}),
            json!({"type":"approval/decided","seq":22,"time":1022,"data":{"id":"a3","outcome":"rejected"}}),
            json!({"type":"sandbox/mode","seq":23,"time":1023,"data":{"mode":"danger-full-access"}}),
            json!({"type":"sandbox/mode","seq":24,"time":1024,"data":{"mode":"workspace-write"}}),
            json!({"type":"sandbox/mode","seq":25,"time":1025,"data":{"mode":"danger-full-access"}}),
        ];
        let out = match_trajectory(&events);
        assert_eq!(
            serde_json::to_string(&out).unwrap(),
            r#"[{"rule":"SV611","severity":"warning","category":"trajectory","tool_name":"bash","evidence":"bash 连续重复 3 次","seq":1,"time":1001,"turn":null,"step":null,"call_id":null,"evidence_recency":"log","run_end_seq":3},{"rule":"SV612","severity":"warning","category":"trajectory","tool_name":null,"evidence":"死循环: turn 2 与上一 turn 动作序列相同","seq":7,"time":1007,"turn":2,"step":null,"call_id":null,"evidence_recency":"log","run_end_seq":9},{"rule":"SV613","severity":"warning","category":"trajectory","tool_name":null,"evidence":"进度停滞: 连续 2 个 turn 以 error 结束","seq":11,"time":1011,"turn":3,"step":null,"call_id":null,"evidence_recency":"log","run_end_seq":13},{"rule":"SV613","severity":"warning","category":"trajectory","tool_name":null,"evidence":"进度停滞: 连续 3 个工具失败（首个 TOOL_TIMEOUT）","seq":14,"time":1014,"turn":null,"step":null,"call_id":null,"evidence_recency":"log","run_end_seq":16},{"rule":"SV614","severity":"warning","category":"approval","tool_name":null,"evidence":"权限异常: 同一调用 c1 请求审批 3 次","seq":17,"time":1017,"turn":null,"step":null,"call_id":"c1","evidence_recency":"log","run_end_seq":null},{"rule":"SV614","severity":"warning","category":"approval","tool_name":null,"evidence":"权限异常: 连续 3 次审批被拒","seq":20,"time":1020,"turn":null,"step":null,"call_id":null,"evidence_recency":"log","run_end_seq":null},{"rule":"SV614","severity":"warning","category":"approval","tool_name":null,"evidence":"权限异常: 危险模式 danger-full-access 授予 2 次","seq":23,"time":1023,"turn":null,"step":null,"call_id":null,"evidence_recency":"log","run_end_seq":null}]"#
        );
    }

    /// 分叉会话的回归：分叉前缀（从上游会话 branch 时抄进日志的那段历史）里的
    /// 轨迹异常**不得**算进本会话的审计。
    ///
    /// 第二刀之前，`match_trajectory` 读**分叉前**的裸事件，而三态又用分叉后
    /// coverage 判（`src/behavior.rs` 老代码 `:133` `&events` + `:135` post_fork
    /// coverage）——分叉会话里上游的 3 连重复调用会被误报成 SV611，与 family ①
    /// 已确立的「审计只答本会话干了什么」纪律冲突。现在 shim 先 `post_fork`
    /// 再检测（先滤后调，同 `match_behavior`），上游轨迹不再算本会话。
    #[test]
    fn match_trajectory_post_forks_before_detecting() {
        // 日志头 `seedLength: 4` → seq < 4 全是从上游抄来的历史。
        let events = [
            json!({"type": "session", "seq": Value::Null, "data": {"seedLength": 4}}),
            // ── 分叉前：3 连相同签名（够触发 SV611）──
            tool_call("bash", r#"{"command":"ls"}"#, 1),
            tool_call("bash", r#"{"command":"ls"}"#, 2),
            tool_call("bash", r#"{"command":"ls"}"#, 3),
            // ── 分叉后：本会话自己的一次干净调用 ──
            tool_call("bash", r#"{"command":"pwd"}"#, 5),
        ];
        let out = match_trajectory(&events);
        assert!(
            out.is_empty(),
            "分叉前缀的重复调用属于上游会话，shim 应先 post_fork 再检测，实际产出: {out:?}"
        );
    }

    /// `last_seq`（SV612 的 run_end_seq）与 `end_seq`（SV613(a) 锚点）是两个不同
    /// 语义：前者是「下一个 turn/start 之前最后出现的事件」的 seq，**任何**事件
    /// 都推进；后者是 turn/end 自身 seq。fixture 里两者恒相等（turn/end 总紧邻
    /// 下一个 turn/start），但一个夹心事件就会分开它们——turn/end 之后、下一个
    /// turn/start 之前若还有活动，SV612 的区间终点必须是那个夹心事件，不是
    /// turn/end。
    #[test]
    fn sv612_run_end_seq_is_last_event_before_next_turn_start_not_turn_end() {
        let events = [
            turn_start(1, 1),
            tool_call("bash", r#"{"command":"ls"}"#, 2),
            tool_call("write", r#"{"file_path":"a"}"#, 3),
            turn_end(1, 4, "success"),
            // 夹心：turn 1 的 turn/end 之后、turn 2 开始之前还有一次活动。
            // 它不属于任何 turn 的 sig，但推进 turn 1 的 last_seq → 5。
            ev("assistant/message", 5, 1005, json!({})),
            turn_start(2, 6),
            tool_call("bash", r#"{"command":"ls"}"#, 7),
            tool_call("write", r#"{"file_path":"a"}"#, 8),
            turn_end(2, 9, "success"),
            // 夹心：同样推进 turn 2 的 last_seq → 10。
            ev("assistant/message", 10, 1010, json!({})),
            turn_start(3, 11),
            tool_call("bash", r#"{"command":"ls"}"#, 12),
            tool_call("write", r#"{"file_path":"a"}"#, 13),
        ];
        let out = match_trajectory(&events);
        // turn 2 与 turn 1 动作序列相同（都是 ls+write，夹心事件不进 sig）→ SV612
        // 在 turn 2 的 turn/start 命中一条。turn 3 再同 → run_count 到 3，但
        // 只在 run 恰长 2 时报一次（run 更长不重报），所以总共就一条。
        let hits: Vec<_> = out.iter().filter(|f| f["rule"] == "SV612").collect();
        assert_eq!(hits.len(), 1, "run 更长不重报，turn 2 命中即止: {out:?}");
        // 锚点是 turn 2 的 turn/start，run_end_seq 是 turn 2 里**最后出现的事件**——
        // 夹心消息 seq 10，不是 turn/end 的 seq 9。若 last_seq 误合并成 end_seq，
        // 这里会拿到 9。
        assert_eq!(hits[0]["seq"], 6);
        assert_eq!(
            hits[0]["run_end_seq"], 10,
            "夹心事件（turn/end 之后、下个 turn/start 之前）推进 last_seq，run_end_seq 必须是它"
        );
    }
}
