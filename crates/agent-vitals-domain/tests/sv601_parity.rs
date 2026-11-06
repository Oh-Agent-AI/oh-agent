//! §14.4 逐字节 parity：SV601 走两条路径必须产出完全相同的 legacy JSON。
//!
//! - **旧路径**：`behavior::detect_sv601_legacy`——原判定逻辑，未经新路径包
//!   装的独立实现；
//! - **新路径**：`compatibility::canonical_session_to_vitals` →
//!   `vitals_core::VitalsEngine`（`Sv601Detector`）→
//!   `compatibility::vitals_report_to_legacy_findings`。
//!
//! **生产切换后的读法**：`behavior::detect_sv601`（`match_behavior()` 实际
//! 调用的那个）现在本身就是"新路径，失败退回 legacy"——拿它当"旧路径"对照
//! 组毫无意义，会永远相等。差分测试必须直接调 `detect_sv601_legacy`，才是
//! 两个真正独立、彼此没有耦合的实现在比较（`compatibility::mod.rs` 的文档
//! 注释解释了 `detect_sv601_legacy` 为什么特意留成 `pub`）。
//!
//! 两条路径共享同一个 `build_dsh_evidence` 调用——parity 测的是"从
//! `CanonicalSession` 往后，新旧两条尾巴产出是否一致"，不是重新验证适配器
//! 本身（那是 `dsh_evidence.rs` 自己的测试范围）。

use agent_vitals_domain::behavior::{detect_sv601_legacy, flatten};
use agent_vitals_domain::compatibility::canonical_session::{canonical_session_to_vitals, KIND_TOOL_CALL, SIGNAL_TOOL_CALLS};
use agent_vitals_domain::compatibility::findings::vitals_report_to_legacy_findings;
use agent_vitals_domain::detectors::Sv601Detector;
use agent_vitals_harnesses::dsh_evidence::build_dsh_evidence;
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

fn old_path_sv601_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    // `flatten` 是拿掉私有排序键 `__ord` 的正确方式——直接从 `RuleOutcome`
    // 里取 `Findings(v)` 会把 `__ord` 留在 JSON 里，跟新路径的输出对不上，
    // 而这根本不是一处真实分歧，是漏了调用同一份既有工具函数。
    flatten(&[("SV601", detect_sv601_legacy(&dsh_evidence.canonical))])
}

fn new_path_sv601_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    let vitals_events = canonical_session_to_vitals(&dsh_evidence.canonical).unwrap();

    let mut engine = VitalsEngine::builder()
        .with_detector(Sv601Detector)
        .with_signal(SignalId::from(SIGNAL_TOOL_CALLS), vec![KIND_TOOL_CALL.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let report = engine.audit(AuditInput { events: vitals_events, coverage: Coverage::new(), config: json!({}) }).unwrap();
    vitals_report_to_legacy_findings(&report).unwrap()
}

fn assert_parity(events: &[Value]) {
    let old = old_path_sv601_findings(events);
    let new = new_path_sv601_findings(events);
    assert_eq!(old, new, "old/new SV601 path diverged for events: {events:#?}");
}

#[test]
fn hit_and_miss_match_the_old_path_byte_for_byte() {
    assert_parity(&[tool_call("bash", r#"{"command":"rm -rf /tmp/build"}"#, 1)]);
    assert_parity(&[tool_call("bash", r#"{"command":"rm /tmp/build"}"#, 2)]);
}

#[test]
fn multiple_events_mixed_hits_preserve_order() {
    let events = vec![
        tool_call("bash", r#"{"command":"echo hi"}"#, 1),
        tool_call("bash", r#"{"command":"rm -rf /a"}"#, 2),
        tool_call("bash", r#"{"command":"ls"}"#, 3),
        tool_call("bash", r#"{"command":"dd if=/dev/zero of=/dev/sda"}"#, 4),
    ];
    let old = old_path_sv601_findings(&events);
    assert_eq!(old.len(), 2, "sanity: this fixture should hit exactly twice");
    assert_parity(&events);
}

#[test]
fn turn_step_call_id_coordinates_survive_the_bridge() {
    let events = vec![
        ev("turn/start", 1, 1001, json!({"turn": 9})),
        ev("step/start", 2, 1002, json!({"turn": 9, "step": 2})),
        ev("tool/call", 3, 1003, json!({
            "turn": 7, "step": 1, "callId": "call_own",
            "name": "bash", "arguments": r#"{"command":"mkfs.ext4 /dev/sdb1"}"#
        })),
    ];
    assert_parity(&events);
}

#[test]
fn non_bash_tool_calls_never_hit_on_either_path() {
    let events = vec![ev(
        "tool/call",
        1,
        1001,
        json!({"name": "write_file", "arguments": r#"{"path":"a","content":"rm -rf /"}"#}),
    )];
    let old = old_path_sv601_findings(&events);
    assert!(old.is_empty(), "sanity: non-bash tool should never trigger SV601");
    assert_parity(&events);
}

#[test]
fn privilege_escalation_pattern_does_not_trigger_sv601() {
    // sudo/chmod 777 命中的是 SV602，不是 SV601——顺带确认桥接没有把两条规
    // 则的判定混到一起。
    let events = vec![tool_call("bash", r#"{"command":"sudo rm /tmp/x"}"#, 1)];
    let old = old_path_sv601_findings(&events);
    assert!(old.is_empty());
    assert_parity(&events);
}
