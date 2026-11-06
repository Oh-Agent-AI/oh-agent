//! §14.4 逐字节 parity：SV610（危险沙箱模式 / 单次放行）。只登记
//! `SIGNAL_SANDBOX_MODES`（门控只 `requires` 这一个，`ApprovalDecisions` 是
//! `enhances`）——与 `behavior.rs::detect_sv610` 生产 wrapper 的登记完全一
//! 致，approvals 数据仍然从 `ctx.events` 里读得到（见
//! `detectors::sv610` 模块文档）。
//!
//! `new_path_findings` 必须走 `run_single_family1_rule`（带 `__ord`）再喂给
//! `flatten()`，不能直接调 `vitals_report_to_legacy_findings`——第一版就是
//! 直接调的，长期测不出问题是因为 SV601–609 都只有一路线性扫描，push 顺序
//! 恒等于时间顺序；SV610 是 family① 里唯一有两个独立子扫描（sandbox 一
//! 遍、approvals 一遍）的规则，一旦 approvals 的锚点在时间上早于
//! sandbox（`both_sources_fire_together_and_preserve_true_chronological_
//! order` 这个夹具就是这样），"裸投影"（push 顺序：sandbox 先）与"走完
//! `flatten()`"（`__ord` 重排后的时间顺序：approvals 先）就会不一致——这不
//! 是新 Engine 的 bug，是这个测试没有量出 `flatten()` 那一步。SV613 那次真
//! 实回归修完之后，`vitals_report_to_legacy_findings` 从"时间顺序"改成了
//! "push 顺序"（见 `findings.rs` 顶部文档），这个测试跟着从"侥幸测对"变成
//! "明确测错"，在这里补上完整链路后重新对。

use agent_vitals_domain::behavior::{detect_sv610_legacy, flatten};
use agent_vitals_domain::compatibility::canonical_session::{KIND_SANDBOX_MODE, SIGNAL_SANDBOX_MODES};
use agent_vitals_domain::compatibility::run_single_family1_rule;
use agent_vitals_domain::detectors::Sv610Detector;
use agent_vitals_harnesses::dsh_evidence::build_dsh_evidence;
use agent_vitals_domain::evidence::{RuleOutcome, Signal};
use agent_vitals_domain::util::post_fork;
use serde_json::{json, Value};

fn ev(etype: &str, seq: i64, time: i64, data: Value) -> Value {
    json!({"type": etype, "seq": seq, "time": time, "data": data})
}

fn old_path_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    // `detect_sv610_legacy` 本身不做门控——它是被 `match_behavior_canonical`
    // 的 dispatcher 在门控通过之后才调用的（先滤后调，见 `behavior.rs` 顶部
    // 注释）。直接调用它会绕过门控，对"SandboxModes 完全没有证据"这类输入
    // 产出一个真实旧生产管线永远不会给出的结果——第一版测试就是这么写错
    // 的。这里手动复刻门控判据（`timeline_is_empty`，与 dispatcher 用的是
    // 同一个方法），保证"旧路径"测的是"门控 + 原判定"，不是"裸判定"。
    if dsh_evidence.canonical.timeline_is_empty(Signal::SandboxModes) {
        return Vec::new();
    }
    flatten(&[("SV610", detect_sv610_legacy(&dsh_evidence.canonical))])
}

fn new_path_findings(events: &[Value]) -> Vec<Value> {
    let post_forked = post_fork(events);
    let dsh_evidence = build_dsh_evidence(post_forked, Vec::new(), None, "session-1".to_string());
    // 复刻 `detect_sv610`（生产 wrapper）的真实两步链路：
    // `run_single_family1_rule` 拿到带 `__ord` 的 legacy JSON，交给
    // `flatten()` 做 family① 的最终重排——而不是直接测
    // `vitals_report_to_legacy_findings` 的裸输出（见本文件顶部文档）。
    let findings = run_single_family1_rule(
        &dsh_evidence.canonical,
        Sv610Detector,
        &[(SIGNAL_SANDBOX_MODES, KIND_SANDBOX_MODE)],
    )
    .unwrap();
    let outcome = if findings.is_empty() { RuleOutcome::MeasuredZero } else { RuleOutcome::Findings(findings) };
    flatten(&[("SV610", outcome)])
}

fn assert_parity(events: &[Value]) {
    assert_eq!(old_path_findings(events), new_path_findings(events));
}

#[test]
fn hit_and_miss_match_the_old_path() {
    assert_parity(&[ev("sandbox/mode", 1, 1001, json!({"mode": "danger-full-access"}))]);
    assert_parity(&[ev("approval/decided", 2, 1002, json!({"id": "a1", "outcome": "rejected"}))]);
}

#[test]
fn zero_sandbox_events_gates_the_whole_rule_unavailable_even_with_an_allowed_once_approval() {
    // `enhances` 的方向容易搞反：不是"缺 requires 也能靠 enhances 补上"，是
    // "缺 enhances 时 requires 单独也能跑"。SandboxModes 是 `requires`——它
    // 一条都没有，门控直接判 Unavailable，`detect_sv610` 根本不会被调用，
    // 就算 approvals（`enhances`）里有 allowed-once 也不例外。这个测试第一
    // 版方向写反了（断言"能读到 approvals 所以应该命中"），被这条 parity
    // 测试当场抓到：老路径走真实门控也是空，不是我这边新引擎的门控算错。
    assert_parity(&[ev("approval/decided", 1, 1001, json!({"id": "a1", "outcome": "allowed-once"}))]);
}

#[test]
fn once_the_gate_passes_on_any_sandbox_event_the_enhancing_approval_data_still_contributes() {
    // 门控通过之后（这里随便一个非 danger 的 sandbox/mode 就够——门控只看
    // "这个信号有没有证据"，不看命中的是不是 danger-full-access），
    // enhances 信号（approvals）才真正发挥作用：allowed-once 一起报出来。
    let events = vec![
        ev("sandbox/mode", 1, 1001, json!({"mode": "workspace-write"})),
        ev("approval/decided", 2, 1002, json!({"id": "a1", "outcome": "allowed-once"})),
    ];
    let old = old_path_findings(&events);
    assert_eq!(old.len(), 1, "sanity: gate passes on the workspace-write event, only the allowed-once approval fires");
    assert_parity(&events);
}

#[test]
fn both_sources_fire_together_and_preserve_true_chronological_order() {
    let events = vec![
        ev("approval/decided", 1, 1001, json!({"id": "a1", "outcome": "allowed-once"})),
        ev("sandbox/mode", 2, 1002, json!({"mode": "danger-full-access"})),
    ];
    let old = old_path_findings(&events);
    assert_eq!(old.len(), 2);
    assert_parity(&events);
}
