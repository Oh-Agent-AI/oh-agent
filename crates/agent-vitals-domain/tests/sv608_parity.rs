//! §14.4 逐字节 parity：SV608（工具调用超时）。

use agent_vitals_domain::behavior::{detect_sv608_legacy, flatten};
use agent_vitals_domain::compatibility::canonical_session::{canonical_session_to_vitals, KIND_TOOL_RESULT, SIGNAL_TOOL_RESULTS};
use agent_vitals_domain::compatibility::findings::vitals_report_to_legacy_findings;
use agent_vitals_domain::detectors::Sv608Detector;
use agent_vitals_harnesses::dsh_evidence::build_dsh_evidence;
use agent_vitals_domain::util::post_fork;
use serde_json::{json, Value};
use vitals_core::coverage::Coverage;
use vitals_core::engine::{AuditInput, VitalsEngine};
use vitals_core::signal::SignalId;

fn ev(etype: &str, seq: i64, time: i64, data: Value) -> Value {
    json!({"type": etype, "seq": seq, "time": time, "data": data})
}

fn old_path_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    flatten(&[("SV608", detect_sv608_legacy(&dsh_evidence.canonical))])
}

fn new_path_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    let vitals_events = canonical_session_to_vitals(&dsh_evidence.canonical).unwrap();

    let mut engine = VitalsEngine::builder()
        .with_detector(Sv608Detector)
        .with_signal(SignalId::from(SIGNAL_TOOL_RESULTS), vec![KIND_TOOL_RESULT.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let report = engine.audit(AuditInput { events: vitals_events, coverage: Coverage::new(), config: json!({}) }).unwrap();
    vitals_report_to_legacy_findings(&report).unwrap()
}

fn assert_parity(events: &[Value]) {
    assert_eq!(old_path_findings(events), new_path_findings(events));
}

#[test]
fn hit_and_miss_match_the_old_path() {
    assert_parity(&[ev("tool/result", 1, 1001, json!({"message": "t", "error": {"name": "TimeoutError", "code": "TOOL_TIMEOUT"}}))]);
    assert_parity(&[ev("tool/result", 2, 1002, json!({"message": "ok"}))]);
}

#[test]
fn other_denied_codes_do_not_leak_into_sv608() {
    assert_parity(&[ev("tool/result", 1, 1001, json!({"message": "x", "error": {"name": "E", "code": "FS_SANDBOX_DENIED"}}))]);
}
