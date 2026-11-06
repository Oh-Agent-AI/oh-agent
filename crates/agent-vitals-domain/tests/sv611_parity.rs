//! §14.4 逐字节 parity：SV611 走两条路径必须产出完全相同的 legacy JSON。
//! 结构同 `sv601_parity.rs`；见那份文件顶部注释解释共享的 `build_dsh_
//! evidence` 调用方式，以及为什么生产切换之后"旧路径"必须直接调
//! `detect_sv611_legacy`（不能再走 `match_trajectory`——那已经是新路径本
//! 身，参见 `sv601_parity.rs` 同一处注释）。这条比 SV601 多验一件事：跨事件
//! 状态（连续计数/anchor）在新路径下是否与旧路径重算出相同的 `run_end_seq`。

use agent_vitals_domain::compatibility::canonical_session::{canonical_session_to_vitals, KIND_TOOL_CALL, SIGNAL_TOOL_CALLS};
use agent_vitals_domain::compatibility::findings::vitals_report_to_legacy_findings;
use agent_vitals_domain::detectors::Sv611Detector;
use agent_vitals_harnesses::dsh_evidence::build_dsh_evidence;
use agent_vitals_domain::trajectory::{detect_sv611_legacy, flatten_trajectory};
use agent_vitals_domain::util::post_fork;
use serde_json::{json, Value};
use vitals_core::coverage::Coverage;
use vitals_core::engine::{AuditInput, VitalsEngine};
use vitals_core::signal::SignalId;

fn ev(etype: &str, seq: i64, time: i64, data: Value) -> Value {
    json!({"type": etype, "seq": seq, "time": time, "data": data})
}

fn tool_call(name: &str, arguments: &str, seq: i64) -> Value {
    ev("tool/call", seq, 1000 + seq, json!({"name": name, "arguments": arguments}))
}

fn old_path_sv611_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    flatten_trajectory(&[("SV611", detect_sv611_legacy(&dsh_evidence.canonical))])
}

fn new_path_sv611_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    let vitals_events = canonical_session_to_vitals(&dsh_evidence.canonical).unwrap();

    let mut engine = VitalsEngine::builder()
        .with_detector(Sv611Detector)
        .with_signal(SignalId::from(SIGNAL_TOOL_CALLS), vec![KIND_TOOL_CALL.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let report = engine.audit(AuditInput { events: vitals_events, coverage: Coverage::new(), config: json!({}) }).unwrap();
    vitals_report_to_legacy_findings(&report).unwrap()
}

fn assert_parity(events: &[Value]) {
    let old = old_path_sv611_findings(events);
    let new = new_path_sv611_findings(events);
    assert_eq!(old, new, "old/new SV611 path diverged for events: {events:#?}");
}

#[test]
fn three_repeats_produce_one_finding_on_both_paths() {
    let events = vec![tool_call("bash", "ls", 1), tool_call("bash", "ls", 2), tool_call("bash", "ls", 3)];
    let old = old_path_sv611_findings(&events);
    assert_eq!(old.len(), 1, "sanity: 3 identical calls should trigger exactly once");
    assert_parity(&events);
}

#[test]
fn two_repeats_do_not_trigger_on_either_path() {
    let events = vec![tool_call("bash", "ls", 1), tool_call("bash", "ls", 2)];
    let old = old_path_sv611_findings(&events);
    assert!(old.is_empty());
    assert_parity(&events);
}

#[test]
fn six_repeats_report_twice_with_matching_run_end_seq() {
    let events: Vec<Value> = (1..=6).map(|i| tool_call("bash", "ls", i)).collect();
    let old = old_path_sv611_findings(&events);
    assert_eq!(old.len(), 2, "sanity: 6-run should fire at 3 and 6");
    assert_parity(&events);
}

#[test]
fn a_different_call_breaking_the_streak_matches_on_both_paths() {
    let events = vec![tool_call("bash", "ls", 1), tool_call("bash", "ls", 2), tool_call("bash", "pwd", 3), tool_call("bash", "ls", 4)];
    let old = old_path_sv611_findings(&events);
    assert!(old.is_empty());
    assert_parity(&events);
}

#[test]
fn turn_step_call_id_coordinates_carry_through_on_the_anchor() {
    let events = vec![
        ev("turn/start", 1, 1001, json!({"turn": 9})),
        ev("step/start", 2, 1002, json!({"turn": 9, "step": 2})),
        ev("tool/call", 3, 1003, json!({"turn": 7, "step": 1, "callId": "call_a", "name": "bash", "arguments": "ls"})),
        ev("tool/call", 4, 1004, json!({"turn": 7, "step": 2, "callId": "call_b", "name": "bash", "arguments": "ls"})),
        ev("tool/call", 5, 1005, json!({"turn": 7, "step": 3, "callId": "call_c", "name": "bash", "arguments": "ls"})),
    ];
    assert_parity(&events);
}
