//! §14.4 逐字节 parity：SV614 走两条路径必须产出完全相同的 legacy JSON。
//! 夹具取自 `trajectory.rs::sv614_permission_anomaly_hit_and_miss`，覆盖三
//! 个独立子判定 (a)(b)(c) 各自的 hit 与共同的 miss。

use agent_vitals_domain::compatibility::canonical_session::{
    canonical_session_to_vitals, KIND_APPROVAL, KIND_SANDBOX_MODE, SIGNAL_APPROVAL_DECISIONS, SIGNAL_SANDBOX_MODES,
};
use agent_vitals_domain::compatibility::findings::vitals_report_to_legacy_findings;
use agent_vitals_domain::detectors::Sv614Detector;
use agent_vitals_harnesses::dsh_evidence::build_dsh_evidence;
use agent_vitals_domain::trajectory::{detect_sv614_legacy, flatten_trajectory};
use agent_vitals_domain::util::post_fork;
use serde_json::{json, Value};
use vitals_core::coverage::Coverage;
use vitals_core::engine::{AuditInput, VitalsEngine};
use vitals_core::signal::SignalId;

fn ev(etype: &str, seq: i64, time: i64, data: Value) -> Value {
    json!({"type": etype, "seq": seq, "time": time, "data": data})
}

fn old_path_sv614_findings(events: &[Value]) -> Vec<Value> {
    // §14.4 生产切换之后：`match_trajectory` 是新路径本身，"旧路径"对照必须
    // 直接调 `detect_sv614_legacy`（同 sv611–613_parity.rs）。
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    flatten_trajectory(&[("SV614", detect_sv614_legacy(&dsh_evidence.canonical))])
}

fn new_path_sv614_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    let vitals_events = canonical_session_to_vitals(&dsh_evidence.canonical).unwrap();

    let mut engine = VitalsEngine::builder()
        .with_detector(Sv614Detector)
        .with_signal(SignalId::from(SIGNAL_APPROVAL_DECISIONS), vec![KIND_APPROVAL.to_string()])
        .unwrap()
        .with_signal(SignalId::from(SIGNAL_SANDBOX_MODES), vec![KIND_SANDBOX_MODE.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let report = engine.audit(AuditInput { events: vitals_events, coverage: Coverage::new(), config: json!({}) }).unwrap();
    vitals_report_to_legacy_findings(&report).unwrap()
}

fn assert_parity(events: &[Value]) {
    let old = old_path_sv614_findings(events);
    let new = new_path_sv614_findings(events);
    assert_eq!(old, new, "old/new SV614 path diverged for events: {events:#?}");
}

#[test]
fn same_call_id_asked_three_times_hits_on_both_paths() {
    let events = vec![
        ev("approval/asked", 1, 1001, json!({"id": "a1", "toolName": "bash", "callId": "c1"})),
        ev("approval/asked", 2, 1002, json!({"id": "a2", "toolName": "bash", "callId": "c1"})),
        ev("approval/asked", 3, 1003, json!({"id": "a3", "toolName": "bash", "callId": "c1"})),
    ];
    let old = old_path_sv614_findings(&events);
    assert_eq!(old.len(), 1);
    assert!(old[0]["evidence"].as_str().unwrap().contains("c1"));
    assert_parity(&events);
}

#[test]
fn three_consecutive_rejections_hit_on_both_paths() {
    let events = vec![
        ev("approval/decided", 1, 1001, json!({"id": "a1", "outcome": "rejected"})),
        ev("approval/decided", 2, 1002, json!({"id": "a2", "outcome": "rejected"})),
        ev("approval/decided", 3, 1003, json!({"id": "a3", "outcome": "rejected"})),
    ];
    let old = old_path_sv614_findings(&events);
    assert_eq!(old.len(), 1);
    assert_parity(&events);
}

#[test]
fn danger_full_access_twice_hits_on_both_paths() {
    let events = vec![
        ev("sandbox/mode", 1, 1001, json!({"mode": "danger-full-access"})),
        ev("sandbox/mode", 2, 1002, json!({"mode": "workspace-write"})),
        ev("sandbox/mode", 3, 1003, json!({"mode": "danger-full-access"})),
    ];
    let old = old_path_sv614_findings(&events);
    assert_eq!(old.len(), 1);
    assert_parity(&events);
}

#[test]
fn below_threshold_on_all_three_sub_judgments_misses_on_both_paths() {
    let events = vec![
        ev("approval/asked", 1, 1001, json!({"id": "a1", "toolName": "bash", "callId": "c1"})),
        ev("approval/asked", 2, 1002, json!({"id": "a2", "toolName": "bash", "callId": "c2"})),
        ev("approval/decided", 3, 1003, json!({"id": "a1", "outcome": "rejected"})),
        ev("sandbox/mode", 4, 1004, json!({"mode": "danger-full-access"})),
    ];
    let old = old_path_sv614_findings(&events);
    assert!(old.is_empty());
    assert_parity(&events);
}

#[test]
fn all_three_sub_judgments_fire_together_in_one_session() {
    let events = vec![
        ev("approval/asked", 1, 1001, json!({"id": "a1", "toolName": "bash", "callId": "c1"})),
        ev("approval/asked", 2, 1002, json!({"id": "a2", "toolName": "bash", "callId": "c1"})),
        ev("approval/asked", 3, 1003, json!({"id": "a3", "toolName": "bash", "callId": "c1"})),
        ev("approval/decided", 4, 1004, json!({"id": "a1", "outcome": "rejected"})),
        ev("approval/decided", 5, 1005, json!({"id": "a2", "outcome": "rejected"})),
        ev("approval/decided", 6, 1006, json!({"id": "a3", "outcome": "rejected"})),
        ev("sandbox/mode", 7, 1007, json!({"mode": "danger-full-access"})),
        ev("sandbox/mode", 8, 1008, json!({"mode": "danger-full-access"})),
    ];
    let old = old_path_sv614_findings(&events);
    assert_eq!(old.len(), 3);
    assert_parity(&events);
}

#[test]
fn all_three_sub_judgments_preserve_legacy_push_order_even_when_chronology_disagrees() {
    // 上面那个测试的夹具里，时间顺序恰好等于 push 顺序（a 同调用审批 → b 连
    // 续拒绝 → c 危险模式，三者在事件流里也是这个先后），所以就算兼容投影
    // 走时间顺序也会碰巧对上——测不出真实的 SV613 回归那类 bug。这里把
    // danger-full-access 放在最前面（时间上最早），但 legacy 的 push 顺序
    // 固定是 (a) 同调用审批 → (b) 连续拒绝 → (c) 危险模式，与时间顺序完全
    // 相反，专门堵住"family④ 的兼容投影按时间顺序而不是 detect() push 顺序
    // 排序"这类回归。
    let events = vec![
        ev("sandbox/mode", 1, 1001, json!({"mode": "danger-full-access"})),
        ev("sandbox/mode", 2, 1002, json!({"mode": "danger-full-access"})),
        ev("approval/decided", 3, 1003, json!({"id": "r1", "outcome": "rejected"})),
        ev("approval/decided", 4, 1004, json!({"id": "r2", "outcome": "rejected"})),
        ev("approval/decided", 5, 1005, json!({"id": "r3", "outcome": "rejected"})),
        ev("approval/asked", 6, 1006, json!({"id": "a1", "toolName": "bash", "callId": "c1"})),
        ev("approval/asked", 7, 1007, json!({"id": "a2", "toolName": "bash", "callId": "c1"})),
        ev("approval/asked", 8, 1008, json!({"id": "a3", "toolName": "bash", "callId": "c1"})),
    ];
    let old = old_path_sv614_findings(&events);
    assert_eq!(old.len(), 3);
    assert!(old[0]["evidence"].as_str().unwrap().contains("同一调用"), "legacy push 顺序 (a) 同调用审批先: {old:#?}");
    assert!(old[1]["evidence"].as_str().unwrap().contains("连续"), "legacy push 顺序 (b) 连续拒绝居中: {old:#?}");
    assert!(old[2]["evidence"].as_str().unwrap().contains("危险模式"), "legacy push 顺序 (c) 危险模式最后: {old:#?}");
    assert_parity(&events);
}
