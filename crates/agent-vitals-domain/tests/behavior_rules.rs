//! `behavior.rs` 门控 dispatcher 的 canonical-fixture 测试 —— v0.8 Phase D1
//! 从 `behavior.rs` 的 inline `#[cfg(test)] mod tests` 迁出：这些测试经
//! `agent_vitals_harnesses::dsh_evidence::build_dsh_evidence` 造 `CanonicalSession`
//! fixture，跨 crate 传 domain 类型 —— inline test + `[dev-dependencies]` 成环会
//! 撞 `multiple versions of crate`（Phase C Step 3 记录）。integration test
//! 里 `agent-vitals-domain` 只编一遍，无碍。只测 gating dispatcher 对
//! canonical 的三态产出，不重验 evidence 抽取（那是 adapters 自己的测试）。

use agent_vitals_harnesses::dsh_evidence::build_dsh_evidence;
use agent_vitals_domain::behavior::{flatten, match_behavior_canonical, rule_outcomes_json};
use agent_vitals_domain::evidence::{CanonicalSession, Coverage, CoverageCounts, RuleOutcome, Signal};
use agent_vitals_domain::trajectory;
use serde_json::{json, Value};

fn ev(etype: &str, seq: i64, time: i64, data: Value) -> Value {
    json!({"type": etype, "seq": seq, "time": time, "data": data})
}

fn measured_coverage(signal: Signal, count: u64) -> Coverage {
    let mut cov = Coverage::new();
    cov.set(signal, CoverageCounts { measured: count, ..Default::default() });
    cov
}

fn tool_call(name: &str, arguments: &str, seq: i64) -> Value {
    ev("tool/call", seq, 1000 + seq, json!({"name": name, "arguments": arguments}))
}

/// 事件流 → `CanonicalSession`（门控 dispatcher 的入口）。复用适配器
/// `build_dsh_evidence`——覆盖计数 + 时间线填充都是它干的，测试只给事件。
fn canonical_from(events: Vec<Value>) -> CanonicalSession {
    build_dsh_evidence(events, Vec::new(), None, "test".to_string()).canonical
}

/// family ① 的三态 = 前置门控 dispatcher 对 canonical 的产出。
fn family1_outcomes(events: Vec<Value>) -> Vec<(&'static str, RuleOutcome)> {
    match_behavior_canonical(&canonical_from(events))
}

/// family ④ 的三态 = 前置门控 dispatcher 对 canonical 的产出。
fn trajectory_outcomes(events: Vec<Value>) -> Vec<(&'static str, RuleOutcome)> {
    trajectory::match_trajectory_canonical(&canonical_from(events))
}

/// 覆盖计数可以手工盖（测三态门控用），时间线用适配器从事件建好。门控读
/// **timeline 非空**（`CanonicalSession::timeline_is_empty`），所以"测某个
/// 信号有证据"要同时满足两件事：事件把对应 timeline 填上 + coverage 手工盖
/// 成非零。旧 `trajectory_rule_outcomes(findings, cov)` 允许把 coverage 与
/// findings 分开喂；迁移到 canonical 后，这条测"某个信号有证据"的路径就
/// 要能手工设覆盖。
fn canonical_with_coverage(events: Vec<Value>, coverage: Coverage) -> CanonicalSession {
    let mut c = build_dsh_evidence(events, Vec::new(), None, "test".to_string()).canonical;
    c.coverage = coverage;
    c
}

/// family ④ 的三态，但 coverage 手工盖（配 `canonical_with_coverage`）。
fn trajectory_outcomes_with(events: Vec<Value>, coverage: Coverage) -> Vec<(&'static str, RuleOutcome)> {
    trajectory::match_trajectory_canonical(&canonical_with_coverage(events, coverage))
}

/// P3 group①：requires 里的信号全零覆盖 → Unavailable，不是"测了是零"的假 []。
/// 十条规则各自的 requires 信号覆盖为零时都该拿到 Unavailable，不能有漏网的。
/// family ① 与 family ④ 都由各自的前置门控 dispatcher 产出——两边都要覆盖到。
#[test]
fn each_rule_is_unavailable_when_its_required_signal_has_zero_coverage() {
    let family1 = family1_outcomes(vec![]);
    for (code, missing_signal) in [
        ("SV601", Signal::ToolCalls), ("SV602", Signal::ToolCalls),
        ("SV603", Signal::ToolCalls), ("SV604", Signal::ToolCalls),
        ("SV605", Signal::ToolCalls), ("SV606", Signal::ToolCalls),
        ("SV607", Signal::ToolResults), ("SV608", Signal::ToolResults),
        ("SV609", Signal::ApprovalDecisions), ("SV610", Signal::SandboxModes),
    ] {
        let (found_code, outcome) = family1.iter().find(|(c, _)| *c == code).unwrap();
        assert_eq!(*found_code, code);
        match outcome {
            RuleOutcome::Unavailable { missing, .. } => {
                assert!(missing.contains(&missing_signal),
                    "{code} 应该因为缺 {missing_signal:?} 判 unavailable，实际 missing={missing:?}");
            }
            _ => panic!("{code} 在零覆盖时应该是 Unavailable，实际是别的分支"),
        }
    }
    let trajectory = trajectory_outcomes_with(vec![], Coverage::new());
    for (code, missing_signal) in [
        ("SV611", Signal::ToolCalls), ("SV612", Signal::TurnBoundaries),
    ] {
        let (_, outcome) = trajectory.iter().find(|(c, _)| *c == code).unwrap();
        match outcome {
            RuleOutcome::Unavailable { missing, .. } => {
                assert!(missing.contains(&missing_signal),
                    "{code} 应该因为缺 {missing_signal:?} 判 unavailable，实际 missing={missing:?}");
            }
            _ => panic!("{code} 在零覆盖时应该是 Unavailable，实际是别的分支"),
        }
    }
}

#[test]
fn measured_zero_is_distinct_from_unavailable_for_the_same_rule() {
    // ToolCalls 有覆盖(测过)、检测器跑了但没命中 → MeasuredZero，不是
    // Unavailable——这正是这条机制存在的意义:能分清"测了是零"和"没法测"。
    let outcomes = family1_outcomes(vec![tool_call("bash", r#"{"command":"ls"}"#, 1)]);
    let (_, outcome) = outcomes.iter().find(|(c, _)| *c == "SV601").unwrap();
    assert!(matches!(outcome, RuleOutcome::MeasuredZero), "有覆盖、零命中该是 MeasuredZero");
}

#[test]
fn findings_outcome_carries_the_matching_findings_for_that_rule_only() {
    // 同一次 bash 调用命中 SV601（rm -rf）、不命中 SV602 → 各归各的。
    let outcomes = family1_outcomes(vec![tool_call("bash", r#"{"command":"rm -rf /x"}"#, 1)]);
    let (_, outcome) = outcomes.iter().find(|(c, _)| *c == "SV601").unwrap();
    match outcome {
        RuleOutcome::Findings(items) => assert_eq!(items.len(), 1),
        _ => panic!("SV601 有一条命中，应该是 Findings"),
    }
    let (_, sv602_outcome) = outcomes.iter().find(|(c, _)| *c == "SV602").unwrap();
    assert!(matches!(sv602_outcome, RuleOutcome::MeasuredZero),
        "SV601 的 finding 不该被算进 SV602 的 outcome");
}

#[test]
fn sv610_treats_approval_decisions_as_enhances_not_requires() {
    // 只有 SandboxModes 覆盖、ApprovalDecisions 全零——SV610 仍应可用
    // (sandbox/mode 单独就能出一条 finding)，不是 Unavailable。用非触发 mode
    // 让检测器跑完、零命中 → MeasuredZero，正好证明"能测、测了是零"而不是
    // "缺 ApprovalDecisions 证据测不了"。
    let outcomes =
        family1_outcomes(vec![ev("sandbox/mode", 1, 1001, json!({"mode": "normal"}))]);
    let (_, outcome) = outcomes.iter().find(|(c, _)| *c == "SV610").unwrap();
    assert!(matches!(outcome, RuleOutcome::MeasuredZero),
        "SandboxModes 有覆盖时 SV610 不该因为 ApprovalDecisions 缺覆盖变成 Unavailable");
}

#[test]
fn sv612_treats_toolcalls_as_enhances_not_requires() {
    // TurnBoundaries 有覆盖、ToolCalls 全零——真测出来的结论是"有 turn
    // 结构但没有工具调用可循环",是 MeasuredZero，不是 Unavailable。
    // 门控读 timeline 而非 coverage：turn/start 事件把 turns 填上，SV612
    // 的 requires 才有证据（ToolCalls 只是 enhances，timeline 恒空也不该
    // Unavailable）。coverage 盖回 TurnBoundaries 是为钉死「enhances 全零
    // 不影响 availability」这一条。
    let cov = measured_coverage(Signal::TurnBoundaries, 1);
    let outcomes =
        trajectory_outcomes_with(vec![ev("turn/start", 1, 1001, json!({}))], cov);
    let (_, outcome) = outcomes.iter().find(|(c, _)| *c == "SV612").unwrap();
    assert!(matches!(outcome, RuleOutcome::MeasuredZero),
        "TurnBoundaries 有覆盖时 SV612 不该因为 ToolCalls 缺覆盖变成 Unavailable");
}

/// P3 group④：SV613/614 的 requires 是"至少一个信号有证据"（OR）——
/// 两个子判定分别读不同信号，任一有证据规则就不是完全测不了。
#[test]
fn sv613_and_sv614_are_unavailable_only_when_all_their_signals_are_missing() {
    let empty = Coverage::new();
    let outcomes = trajectory_outcomes_with(vec![], empty);
    for code in ["SV613", "SV614"] {
        let (_, outcome) = outcomes.iter().find(|(c, _)| *c == code).unwrap();
        assert!(matches!(outcome, RuleOutcome::Unavailable { .. }),
            "{code} 两个信号都全零覆盖时应该 Unavailable");
    }
}

#[test]
fn sv613_is_available_when_only_one_of_its_two_signals_has_coverage() {
    // 只有 ToolResults 有覆盖(TurnBoundaries 全零)——613b(连续工具失败)
    // 那半边测得了，规则不该整体判 Unavailable。tool/result 事件把
    // tool_results 填上，OR 门控（TurnBoundaries 或 ToolResults 任一非空）
    // 放行；单条结果凑不齐「连续失败」→ MeasuredZero。
    let cov = measured_coverage(Signal::ToolResults, 1);
    let outcomes = trajectory_outcomes_with(vec![ev("tool/result", 1, 1001, json!({}))], cov);
    let (_, outcome) = outcomes.iter().find(|(c, _)| *c == "SV613").unwrap();
    assert!(matches!(outcome, RuleOutcome::MeasuredZero),
        "ToolResults 有覆盖时 SV613 不该因为 TurnBoundaries 缺覆盖变成 Unavailable");

    // 反过来:只有 TurnBoundaries 有覆盖——613a(连续 error turn)测得了。
    let cov2 = measured_coverage(Signal::TurnBoundaries, 1);
    let outcomes2 = trajectory_outcomes_with(vec![ev("turn/start", 1, 1001, json!({}))], cov2);
    let (_, outcome2) = outcomes2.iter().find(|(c, _)| *c == "SV613").unwrap();
    assert!(matches!(outcome2, RuleOutcome::MeasuredZero));
}

#[test]
fn sv614_is_available_when_only_one_of_its_two_signals_has_coverage() {
    // sandbox/mode 事件把 sandbox_modes 填上，OR 门控（ApprovalDecisions
    // 或 SandboxModes 任一非空）放行；"normal" 不触发检测器 → MeasuredZero，
    // 证明是"能测、测了是零"而不是"缺 ApprovalDecisions 证据测不了"。
    let cov = measured_coverage(Signal::SandboxModes, 1);
    let outcomes =
        trajectory_outcomes_with(vec![ev("sandbox/mode", 1, 1001, json!({"mode": "normal"}))], cov);
    let (_, outcome) = outcomes.iter().find(|(c, _)| *c == "SV614").unwrap();
    assert!(matches!(outcome, RuleOutcome::MeasuredZero),
        "SandboxModes 有覆盖时 SV614 不该因为 ApprovalDecisions 缺覆盖变成 Unavailable");
}

/// 门控的形状不变量：coverage 非零但 timeline 为空 → Unavailable，不是
/// MeasuredZero。`derive_coverage` 把 task_started/task_complete/
/// mcp_tool_call_end 数成非零 measured，timeline 却为空——门控读 coverage
/// 会让 SV612/SV601 空转产出假零；读 timeline（`timeline_is_empty`）才诚实
/// 说"测不了"。这正是本次门控修正钉住的真实缺陷：同一 canonical，coverage
/// 有数、无一条可消费观测。Codex 的 approvals timeline 至今仍是这个形状
/// （覆盖非零但 approvals 空 → SV609 Unavailable，见 codex_evidence.rs 的
/// 真值表）——防御的不变量不是"Codex 恒为空"，而是"空就是空"。
#[test]
fn empty_timeline_with_nonzero_coverage_is_unavailable_not_measured_zero() {
    let mut s = canonical_from(vec![]);
    s.coverage
        .set(Signal::TurnBoundaries, CoverageCounts { measured: 2, ..Default::default() });
    s.coverage
        .set(Signal::ToolCalls, CoverageCounts { measured: 1, ..Default::default() });

    let trajectory = trajectory::match_trajectory_canonical(&s);
    let (_, sv612) = trajectory.iter().find(|(c, _)| *c == "SV612").unwrap();
    assert!(matches!(sv612, RuleOutcome::Unavailable { .. }),
        "turn 覆盖非零但 turns timeline 为空：SV612 必须 Unavailable，不得 MeasuredZero");

    let family1 = match_behavior_canonical(&s);
    let (_, sv601) = family1.iter().find(|(c, _)| *c == "SV601").unwrap();
    assert!(matches!(sv601, RuleOutcome::Unavailable { .. }),
        "tool_calls 覆盖非零但 tool_calls timeline 为空：SV601 必须 Unavailable，不得 MeasuredZero");
}

#[test]
fn sv611_through_sv614_findings_are_picked_up_by_trajectory_rule_outcomes() {
    // match_trajectory_canonical 是前置门控 dispatcher——确认 SV611 真的被
    // TRAJECTORY_RULES 认得，不是只声明了规格却匹配不到 finding。喂真实的
    // 3 连重复调用让检测器产出 finding，而不是手拼 findings 数组。
    let events = vec![
        tool_call("bash", r#"{"command":"ls"}"#, 1),
        tool_call("bash", r#"{"command":"ls"}"#, 2),
        tool_call("bash", r#"{"command":"ls"}"#, 3),
    ];
    let outcomes = trajectory_outcomes(events);
    let (_, outcome) = outcomes.iter().find(|(c, _)| *c == "SV611").unwrap();
    match outcome {
        RuleOutcome::Findings(items) => assert_eq!(items.len(), 1),
        _ => panic!("SV611 有一条命中，应该是 Findings"),
    }
}

#[test]
fn rule_outcomes_json_shape_for_each_status() {
    // family ①（canonical 门控）+ family ④（canonical 门控）合并后才是
    // `--json` 那份 14 键的 outcomes——三态各自落一个键。
    let mut all = family1_outcomes(vec![tool_call("bash", r#"{"command":"rm -rf /x"}"#, 1)]);
    let traj = trajectory_outcomes(vec![tool_call("bash", r#"{"command":"ls"}"#, 1)]);
    all.extend(traj);
    let json_val = rule_outcomes_json(&all);
    assert_eq!(json_val["SV601"], json!({"status": "findings", "count": 1}));
    assert_eq!(json_val["SV602"], json!({"status": "measured_zero"}));
    let unavailable = &json_val["SV609"];
    assert_eq!(unavailable["status"], json!("unavailable"));
    assert_eq!(unavailable["missing"], json!(["ApprovalDecisions"]));
}

/// 分叉路径回归（这次重构的**唯一**有意的行为修正）：有 approval/decided
/// {allowed-once}、无 sandbox/mode——SV610 的 requires 只有 SandboxModes，
/// 前置门控下检测器不跑，`flatten` 出的 findings 必须**不含** SV610。
/// 旧实现先跑满检测器、后置标注，这条 allowed-once 会漏进 findings，与
/// rule_outcomes 判 unavailable 自相矛盾。golden 语料里 SV610 恒 available，
/// 此分叉不在 goldens，必须用回归测试钉住新语义。
#[test]
fn sv610_unavailable_rule_never_leaks_a_finding() {
    let events = vec![
        ev("turn/start", 1, 1001, json!({"turn": 1})),
        ev("approval/decided", 2, 1002, json!({"id": "a1", "outcome": "allowed-once"})),
        ev("turn/end", 3, 1003, json!({"turn": 1})),
    ];
    let evidence =
        build_dsh_evidence(events, Vec::new(), None, "test".to_string());
    let outcomes = match_behavior_canonical(&evidence.canonical);
    let (_, outcome) = outcomes.iter().find(|(c, _)| *c == "SV610").unwrap();
    match outcome {
        RuleOutcome::Unavailable { missing, .. } => {
            assert!(missing.contains(&Signal::SandboxModes),
                "无 sandbox/mode 时 SV610 缺的证据是 SandboxModes");
        }
        _ => panic!("无 sandbox/mode 时 SV610 必须 Unavailable，不能是别的分支"),
    }
    let findings = flatten(&outcomes);
    assert!(findings.iter().all(|f| f.get("rule").and_then(|v| v.as_str()) != Some("SV610")),
        "unavailable 的规则绝不报出 finding");
}

/// flatten 的排序等价：一条 bash 调用同时命中 SV601+SV602——flatten 后
/// (event, rule) 序 = dispatcher 表序（SV601 在 SV602 前），且 `__ord` 键不泄漏。
#[test]
fn flatten_preserves_event_then_rule_order_without_leaking_ord_key() {
    let outcomes = family1_outcomes(vec![tool_call("bash", r#"{"command":"sudo rm -rf /x"}"#, 1)]);
    let findings = flatten(&outcomes);
    assert_eq!(findings.len(), 2, "一条 bash 调用同时命中 SV601+SV602");
    assert_eq!(findings[0]["rule"], json!("SV601"));
    assert_eq!(findings[1]["rule"], json!("SV602"));
    for f in &findings {
        assert!(f.get("__ord").is_none(), "私有排序键不能泄漏进最终输出");
    }
}

/// 时间线坐标等价：适配器 `populate_timelines` 用 Coords 给每条 entry 解
/// 出 turn/step/call_id/seq/ordinal——与旧 `match_behavior` 直接读裸事件
/// 时 `Coords.resolve` 出的坐标同一套（differential/goldens 已逐字节证明
/// findings 带出的坐标不变）。这里是更快的针对性钉子：坐标解析归适配器，
/// 规则层只读 payload，这一刀钉住分界，防止将来把坐标挪回规则层。
#[test]
fn timeline_entries_carry_resolved_coords() {
    let events = vec![
        ev("turn/start", 1, 1001, json!({"turn": 2})),
        // 自带坐标优先于顺延值（turn 7，不是活跃的 2）。
        ev("tool/call", 2, 1002, json!({"turn": 7, "step": 1, "callId": "c1",
                                        "name": "bash", "arguments": "x"})),
        // 无坐标的 approval/asked 从边界顺延 turn（不臆造 step/call_id）。
        ev("approval/asked", 3, 1003, json!({"id": "a1", "toolName": "bash"})),
        ev("turn/end", 4, 1004, json!({"turn": 2})),
    ];
    let canonical = canonical_from(events);
    let tc = &canonical.tool_calls.entries[0];
    assert_eq!((tc.turn, tc.step, tc.seq), (Some(7), Some(1), Some(2)));
    assert_eq!(tc.call_id.as_deref(), Some("c1"));
    assert_eq!(tc.ordinal, 1, "ordinal = 在 post_fork 执行流里的下标（turn/start=0、本事件=1），供 flatten 重建 (event, rule) 序");
    let ap = &canonical.approvals.entries[0];
    assert_eq!(ap.turn, Some(2), "无自带坐标的事件从 turn/start 顺延");
    assert_eq!(ap.step, None, "没有 step/start 就没有 step，不臆造");
    assert_eq!(ap.call_id, None, "没有自带 callId 就不填，不臆造");
}
