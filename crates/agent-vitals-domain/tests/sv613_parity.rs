//! §14.4 逐字节 parity：SV613 走两条路径必须产出完全相同的 legacy JSON。
//! 结构同前几份 parity 测试；夹具取自 `trajectory.rs::sv613_stall_hit_and_miss`。
//! 这是第一条用 `Any` requirement 的规则——`SIGNAL_TURN_BOUNDARIES` 与
//! `SIGNAL_TOOL_RESULTS` 任一有证据都该跑，见 `assert_parity` 分别用只含
//! turn 事件、只含 tool_result 事件的夹具各测一次子判定。

use agent_vitals_domain::compatibility::canonical_session::{
    canonical_session_to_vitals, KIND_TOOL_RESULT, KIND_TURN, SIGNAL_TOOL_RESULTS, SIGNAL_TURN_BOUNDARIES,
};
use agent_vitals_domain::compatibility::findings::vitals_report_to_legacy_findings;
use agent_vitals_domain::detectors::Sv613Detector;
use agent_vitals_harnesses::dsh_evidence::build_dsh_evidence;
use agent_vitals_domain::trajectory::{detect_sv613_legacy, flatten_trajectory};
use agent_vitals_domain::util::post_fork;
use serde_json::{json, Value};
use vitals_core::coverage::Coverage;
use vitals_core::engine::{AuditInput, VitalsEngine};
use vitals_core::signal::SignalId;

fn ev(etype: &str, seq: i64, time: i64, data: Value) -> Value {
    json!({"type": etype, "seq": seq, "time": time, "data": data})
}

fn turn_start(turn: i64, seq: i64) -> Value {
    ev("turn/start", seq, 1000 + seq, json!({"turn": turn}))
}

fn turn_end(turn: i64, seq: i64, kind: &str) -> Value {
    ev("turn/end", seq, 1000 + seq, json!({"turn": turn, "reason": {"kind": kind}}))
}

fn tool_result_error(seq: i64, code: &str) -> Value {
    ev("tool/result", seq, 1000 + seq, json!({"message": {"content": []}, "error": {"name": "x", "code": code}}))
}

fn old_path_sv613_findings(events: &[Value]) -> Vec<Value> {
    // §14.4 生产切换之后：`match_trajectory` 已经是新路径本身（`detect_sv613`
    // 内部 `run_single_rule` 失败才退回 legacy），拿它当"旧路径"比较毫无意
    // 义——必须直接调 `detect_sv613_legacy`，见 `sv601_parity.rs` 同一处注释。
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    flatten_trajectory(&[("SV613", detect_sv613_legacy(&dsh_evidence.canonical))])
}

fn new_path_sv613_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    let vitals_events = canonical_session_to_vitals(&dsh_evidence.canonical).unwrap();

    let mut engine = VitalsEngine::builder()
        .with_detector(Sv613Detector)
        .with_signal(SignalId::from(SIGNAL_TURN_BOUNDARIES), vec![KIND_TURN.to_string()])
        .unwrap()
        .with_signal(SignalId::from(SIGNAL_TOOL_RESULTS), vec![KIND_TOOL_RESULT.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let report = engine.audit(AuditInput { events: vitals_events, coverage: Coverage::new(), config: json!({}) }).unwrap();
    vitals_report_to_legacy_findings(&report).unwrap()
}

fn assert_parity(events: &[Value]) {
    let old = old_path_sv613_findings(events);
    let new = new_path_sv613_findings(events);
    assert_eq!(old, new, "old/new SV613 path diverged for events: {events:#?}");
}

#[test]
fn two_consecutive_error_turns_hit_on_both_paths() {
    let events = vec![turn_start(1, 1), turn_end(1, 2, "error"), turn_start(2, 3), turn_end(2, 4, "error")];
    let old = old_path_sv613_findings(&events);
    assert_eq!(old.len(), 1);
    assert_eq!(old[0]["seq"], json!(2), "sanity: anchor is the first error turn/end, not turn/start");
    assert_parity(&events);
}

#[test]
fn three_consecutive_tool_failures_hit_on_both_paths() {
    let events = vec![tool_result_error(1, "TOOL_TIMEOUT"), tool_result_error(2, "TOOL_TIMEOUT"), tool_result_error(3, "TOOL_TIMEOUT")];
    let old = old_path_sv613_findings(&events);
    assert_eq!(old.len(), 1);
    assert_parity(&events);
}

#[test]
fn a_success_result_interrupting_the_run_misses_on_both_paths() {
    let events = vec![
        tool_result_error(1, "TOOL_TIMEOUT"),
        tool_result_error(2, "TOOL_TIMEOUT"),
        ev("tool/result", 3, 1003, json!({"message": {"content": []}})),
        tool_result_error(4, "TOOL_TIMEOUT"),
    ];
    let old = old_path_sv613_findings(&events);
    assert!(old.is_empty());
    assert_parity(&events);
}

#[test]
fn both_sub_detectors_firing_together_preserve_legacy_push_order_not_chronological_order() {
    // 发布前全量 Python/Rust 矩阵测试抓到的真实回归：`detect_sv613_legacy`
    // 先扫完全部 error-turn（子判定 a）、再扫全部 tool-failure（子判定
    // b）——这是**固定的 push 顺序**，不是时间顺序。`flatten_trajectory`
    // （family④）原样透传这个顺序，不像 `flatten()`（family①）那样按 __ord
    // 重新排过。
    //
    // 这里故意把 tool-failure 的锚点放在时间上更早（seq 1-3），error-turn
    // 放在更晚（seq 4-7）——如果兼容投影按时间顺序（frame/replay 顺序）
    // 而不是 detect() 的 push 顺序来产出结果，这条会先给出 tool-failure、
    // 再给出 error-turn，跟旧路径反过来。之前只分别测过"两个子判定各自单
    // 独触发"，没测过"两个都触发、且时间顺序与 push 顺序相反"，专项 parity
    // 全绿但完整 CLI matrix（`tests/test_cli_matrix.py::
    // test_behavior_trajectory_findings`）会红——这是那个真实回归在本文件
    // 里的最小复现。
    let events = vec![
        tool_result_error(1, "TOOL_TIMEOUT"),
        tool_result_error(2, "TOOL_TIMEOUT"),
        tool_result_error(3, "TOOL_TIMEOUT"),
        turn_start(1, 4),
        turn_end(1, 5, "error"),
        turn_start(2, 6),
        turn_end(2, 7, "error"),
    ];
    let old = old_path_sv613_findings(&events);
    assert_eq!(old.len(), 2, "sanity: both sub-detectors should fire once each");
    // legacy push order: error-turn (子判定 a) 先，tool-failure (子判定 b) 后
    // ——即使 tool-failure 的锚点在时间上更早。
    assert!(old[0]["evidence"].as_str().unwrap().contains("以 error 结束"), "legacy 顺序应该是 error-turn 先: {old:#?}");
    assert!(old[1]["evidence"].as_str().unwrap().contains("工具失败"), "legacy 顺序应该是 tool-failure 后: {old:#?}");
    assert_parity(&events);
}

#[test]
fn signal_only_turn_boundaries_still_runs_the_engine_gate_via_any() {
    // 只有 turn 事件、完全没有 tool/result——Any requirement 应该仍然放行
    // （turn boundaries 有证据），不因为另一半信号缺席就整体 Unavailable。
    let events = vec![turn_start(1, 1), turn_end(1, 2, "error"), turn_start(2, 3), turn_end(2, 4, "error")];
    assert_parity(&events);
}

#[test]
fn signal_only_tool_results_still_runs_the_engine_gate_via_any() {
    let events = vec![tool_result_error(1, "TOOL_TIMEOUT"), tool_result_error(2, "TOOL_TIMEOUT"), tool_result_error(3, "TOOL_TIMEOUT")];
    assert_parity(&events);
}
