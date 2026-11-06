//! §14.4 逐字节 parity：SV612 走两条路径必须产出完全相同的 legacy JSON。
//! 结构同 `sv601_parity.rs`/`sv611_parity.rs`；见 `sv601_parity.rs` 顶部注释
//! 解释共享的 `build_dsh_evidence` 调用方式，以及生产切换之后"旧路径"必须
//! 直接调 `detect_sv612_legacy`（不能走 `match_trajectory`——那已经是新路
//! 径本身）。
//!
//! 夹具直接取自 `trajectory.rs` 自己的单测（`sv612_dead_loop_hit_and_miss`、
//! `sv612_run_end_seq_is_last_event_before_next_turn_start_not_turn_end`）——
//! 这些是已经被验证过、覆盖了"夹心事件推进 last_seq 但不进 sig"这种边界情
//! 形的真实回归夹具，不是重新拍脑袋编的。

use agent_vitals_domain::compatibility::canonical_session::{canonical_session_to_vitals, KIND_TURN, SIGNAL_TURN_BOUNDARIES};
use agent_vitals_domain::compatibility::findings::vitals_report_to_legacy_findings;
use agent_vitals_domain::detectors::Sv612Detector;
use agent_vitals_harnesses::dsh_evidence::build_dsh_evidence;
use agent_vitals_domain::trajectory::{detect_sv612_legacy, flatten_trajectory};
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

fn tool_call(name: &str, arguments: &str, seq: i64) -> Value {
    ev("tool/call", seq, 1000 + seq, json!({"name": name, "arguments": arguments}))
}

fn old_path_sv612_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    flatten_trajectory(&[("SV612", detect_sv612_legacy(&dsh_evidence.canonical))])
}

fn new_path_sv612_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    let vitals_events = canonical_session_to_vitals(&dsh_evidence.canonical).unwrap();

    let mut engine = VitalsEngine::builder()
        .with_detector(Sv612Detector)
        .with_signal(SignalId::from(SIGNAL_TURN_BOUNDARIES), vec![KIND_TURN.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let report = engine.audit(AuditInput { events: vitals_events, coverage: Coverage::new(), config: json!({}) }).unwrap();
    vitals_report_to_legacy_findings(&report).unwrap()
}

fn assert_parity(events: &[Value]) {
    let old = old_path_sv612_findings(events);
    let new = new_path_sv612_findings(events);
    assert_eq!(old, new, "old/new SV612 path diverged for events: {events:#?}");
}

#[test]
fn identical_consecutive_turns_hit_on_both_paths() {
    let events = vec![
        turn_start(1, 1),
        tool_call("bash", r#"{"command":"ls"}"#, 2),
        tool_call("write", r#"{"file_path":"a"}"#, 3),
        turn_start(2, 4),
        tool_call("bash", r#"{"command":"ls"}"#, 5),
        tool_call("write", r#"{"file_path":"a"}"#, 6),
    ];
    let old = old_path_sv612_findings(&events);
    assert_eq!(old.len(), 1, "sanity: identical turn 1/turn 2 sequences should trigger once");
    assert_parity(&events);
}

#[test]
fn different_turn_sequences_miss_on_both_paths() {
    let events = vec![
        turn_start(1, 1),
        tool_call("bash", r#"{"command":"ls"}"#, 2),
        turn_start(2, 3),
        tool_call("write", r#"{"file_path":"a"}"#, 4),
    ];
    let old = old_path_sv612_findings(&events);
    assert!(old.is_empty());
    assert_parity(&events);
}

#[test]
fn sandwiched_events_advance_run_end_seq_but_not_the_signature() {
    // 直接搬 trajectory.rs 自己的回归夹具：turn/end 之后、下一个 turn/start
    // 之前的"夹心事件"必须推进 run_end_seq，但不进 turn 的 sig。这是
    // §8.4.1 设计要验证的核心一条——`last_seq` 这个派生量能不能原样穿过桥接
    // 存进 `attributes["last_seq"]`，而不是被规则重新计算出别的值。
    let events = vec![
        turn_start(1, 1),
        tool_call("bash", r#"{"command":"ls"}"#, 2),
        tool_call("write", r#"{"file_path":"a"}"#, 3),
        turn_end(1, 4, "success"),
        ev("assistant/message", 5, 1005, json!({})),
        turn_start(2, 6),
        tool_call("bash", r#"{"command":"ls"}"#, 7),
        tool_call("write", r#"{"file_path":"a"}"#, 8),
        turn_end(2, 9, "success"),
        ev("assistant/message", 10, 1010, json!({})),
        turn_start(3, 11),
        tool_call("bash", r#"{"command":"ls"}"#, 12),
        tool_call("write", r#"{"file_path":"a"}"#, 13),
    ];
    let old = old_path_sv612_findings(&events);
    assert_eq!(old.len(), 1, "run 更长（turn 3 再同）不重报");
    assert_eq!(old[0]["run_end_seq"], json!(10), "sanity: sandwiched event advances run_end_seq to 10, not turn/end's 9");
    assert_parity(&events);
}

#[test]
fn empty_turn_is_transparent_so_the_surrounding_identical_turns_still_match() {
    // turn 2 完全没有 tool/call（空 turn）——它自己不算死循环参与方，但也不
    // 打断比较：旧实现对空 sig 的 turn 直接 `continue`，既不推进 run_count
    // 也不更新 prev_sig，所以 turn 1 与 turn 3（都只有一次 `ls`）被当成"紧
    // 邻的两个相同 turn"命中，跳过的 turn 2 就像从没出现过。这条断言容易凭
    // 直觉猜反（"空 turn 隔开了两次同样的调用，怎么会算连续"）——本测试第
    // 一版就断言错了方向，被 `Sv612Detector` 自己的单测
    // （`empty_sig_turns_are_transparent_to_the_comparison`）先纠正过来。
    let events = vec![
        turn_start(1, 1),
        tool_call("bash", r#"{"command":"ls"}"#, 2),
        turn_end(1, 3, "success"),
        turn_start(2, 4),
        turn_end(2, 5, "success"),
        turn_start(3, 6),
        tool_call("bash", r#"{"command":"ls"}"#, 7),
    ];
    let old = old_path_sv612_findings(&events);
    assert_eq!(old.len(), 1, "空 turn 2 对比较透明，turn1/turn3 应当被当成相邻相同 turn 命中");
    assert_parity(&events);
}
