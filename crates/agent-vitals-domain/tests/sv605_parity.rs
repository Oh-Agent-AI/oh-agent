//! §14.4 逐字节 parity：SV605（工作区外写入）。与其它 family① parity 测试
//! 的唯一区别：需要显式构造 `config`（`{"workspace_root": ...}`），跟生产
//! 切换里 `behavior.rs::detect_sv605` 拼 config 的方式完全一致。

use agent_vitals_domain::behavior::{detect_sv605_legacy, flatten};
use agent_vitals_domain::compatibility::canonical_session::{canonical_session_to_vitals, KIND_TOOL_CALL, SIGNAL_TOOL_CALLS};
use agent_vitals_domain::compatibility::findings::vitals_report_to_legacy_findings;
use agent_vitals_domain::detectors::Sv605Detector;
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

fn old_path_findings(events: &[Value], workspace_root: Option<&str>) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), workspace_root.map(str::to_owned), "session-1".to_string());
    flatten(&[("SV605", detect_sv605_legacy(&dsh_evidence.canonical))])
}

fn new_path_findings(events: &[Value], workspace_root: Option<&str>) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), workspace_root.map(str::to_owned), "session-1".to_string());
    let vitals_events = canonical_session_to_vitals(&dsh_evidence.canonical).unwrap();
    // 与 `behavior.rs::detect_sv605` 生产 wrapper 同一种拼法——从
    // `meta.workspace_roots` 取，不是直接透传测试参数，确保测的是同一条链路。
    let config = json!({"workspace_root": dsh_evidence.canonical.meta.workspace_roots.first()});

    let mut engine = VitalsEngine::builder()
        .with_detector(Sv605Detector)
        .with_signal(SignalId::from(SIGNAL_TOOL_CALLS), vec![KIND_TOOL_CALL.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let report = engine.audit(AuditInput { events: vitals_events, coverage: Coverage::new(), config }).unwrap();
    vitals_report_to_legacy_findings(&report).unwrap()
}

fn assert_parity(events: &[Value], workspace_root: Option<&str>) {
    assert_eq!(old_path_findings(events, workspace_root), new_path_findings(events, workspace_root));
}

#[test]
fn hit_and_miss_without_a_workspace_root() {
    assert_parity(&[tool_call("edit", r#"{"file_path":"/tmp/notes.md"}"#, 1)], None);
    assert_parity(&[tool_call("write", r#"{"file_path":"notes.md"}"#, 2)], None);
}

#[test]
fn path_inside_workspace_root_is_not_flagged() {
    assert_parity(&[tool_call("write", r#"{"file_path":"/workspace/agent-vitals/dsh/package.json"}"#, 1)], Some("/workspace/agent-vitals"));
}

#[test]
fn path_outside_workspace_root_is_still_flagged() {
    assert_parity(&[tool_call("write", r#"{"file_path":"/other/file.txt"}"#, 1)], Some("/workspace/agent-vitals"));
}

#[test]
fn sibling_directory_with_similar_prefix_is_not_mistaken_for_inside() {
    // 路径段边界：agent-vitals-other 不在 agent-vitals 下，不能裸 startsWith。
    assert_parity(&[tool_call("write", r#"{"file_path":"/workspace/agent-vitals-other/file.txt"}"#, 1)], Some("/workspace/agent-vitals"));
}

#[test]
fn sensitive_path_is_left_to_sv604_on_both_paths() {
    assert_parity(&[tool_call("write", r#"{"file_path":"/etc/passwd"}"#, 1)], None);
}
