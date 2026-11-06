//! §14.4 逐字节 parity：SV602（提权命令）。结构同 `sv601_parity.rs`.

use agent_vitals_domain::behavior::{detect_sv602_legacy, flatten};
use agent_vitals_domain::compatibility::canonical_session::{canonical_session_to_vitals, KIND_TOOL_CALL, SIGNAL_TOOL_CALLS};
use agent_vitals_domain::compatibility::findings::vitals_report_to_legacy_findings;
use agent_vitals_domain::detectors::Sv602Detector;
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

fn old_path_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    flatten(&[("SV602", detect_sv602_legacy(&dsh_evidence.canonical))])
}

fn new_path_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    let vitals_events = canonical_session_to_vitals(&dsh_evidence.canonical).unwrap();

    let mut engine = VitalsEngine::builder()
        .with_detector(Sv602Detector)
        .with_signal(SignalId::from(SIGNAL_TOOL_CALLS), vec![KIND_TOOL_CALL.to_string()])
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
    assert_parity(&[tool_call("bash", r#"{"command":"sudo systemctl restart x"}"#, 1)]);
    assert_parity(&[tool_call("bash", r#"{"command":"systemctl restart x"}"#, 2)]);
}

#[test]
fn chmod_777_and_chown_r_are_detected() {
    assert_parity(&[tool_call("bash", r#"{"command":"chmod 777 /tmp/x"}"#, 1)]);
    assert_parity(&[tool_call("bash", r#"{"command":"chown -R user /tmp/x"}"#, 1)]);
}
