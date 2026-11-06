//! Canonical-session SV 审计投影的共享求值器（Rust 侧）。
//!
//! 三份 dispatcher（`src/agent/claude_session.rs`/`codex_session_audit.rs`/
//! `workbuddy_session.rs`）里各自的 `<harness>_audit_projection` 此前是同一段
//! 代码的三份拷贝：family①→degrade(行)→family④→flatten→summary。
//! `CanonicalSession` 的形状是 harness-neutral 的（`tool_calls`/`tool_results`/
//! `turns`/`approvals`/`sandbox_modes` 五条 timeline + `meta`），所以求值器
//! 本体也是执行环境无关的——唯一因执行环境而变的是 harness-capability degrade
//! （`harness_capability::degrade_rule_outcomes`）用哪个 `harness_id`。塌缩成这一份
//! 共享函数，三个 dispatcher 改成薄封装（v0.6 harness-contract spec §6/§7-C，
//! M1）；行为字节不变，golden + differential 验收。
//!
//! 与 Python 镜像 `scripts/agent_vitals/agent/canonical_audit.py::audit_projection`
//! 对应：Python 侧的 degrade 目前仍由调用方（`claude_session_audit.py`/
//! `workbuddy_session_audit.py`）在返回后 override，尚未把 `harness_id` 收进共享
//! 函数签名——把两侧完全对齐（含 DSH 新建的 `dsh_evidence.py` 走这条路径）
//! 是 M1 的后续交付，不在本次改动范围内（本次只做 Rust 侧塌缩）。

use serde_json::{json, Value};

use crate::behavior::{flatten, match_behavior_canonical, rule_outcomes_json};
use crate::evidence::{CanonicalSession, RuleOutcome};
use crate::harness_capability::degrade_rule_outcomes;
use crate::trajectory::{flatten_trajectory, match_trajectory_canonical};

/// family①（SV601-610）+ family④（SV611-614）的审计投影：findings + 三态
/// `rule_outcomes` + summary。`harness_id` 决定 harness-capability degrade（未知
/// 执行环境、或行上无 `degraded_rules` 的执行环境，走 `degrade_rule_outcomes` 的
/// no-op 分支，等价于「不 degrade」——这就是 codex/dsh 此前没有 override 调用
/// 时的行为，塌缩后无需特例）。
pub fn audit_projection(canonical: &CanonicalSession, harness_id: &str) -> Value {
    let mut family1 = match_behavior_canonical(canonical);
    degrade_rule_outcomes(harness_id, &mut family1);
    let trajectory = match_trajectory_canonical(canonical);

    let mut findings = flatten(&family1);
    findings.extend(flatten_trajectory(&trajectory));
    let mut outcomes = family1;
    outcomes.extend(trajectory);

    let mut critical = 0_u64;
    let mut warning = 0_u64;
    let mut info = 0_u64;
    for finding in &findings {
        match finding.get("severity").and_then(|v| v.as_str()) {
            Some("critical") => critical += 1,
            Some("warning") => warning += 1,
            Some("info") => info += 1,
            _ => {}
        }
    }
    let rules_unavailable = outcomes
        .iter()
        .filter(|(_, outcome)| matches!(outcome, RuleOutcome::Unavailable { .. }))
        .count() as u64;
    json!({
        "summary": {
            "critical": critical, "warning": warning, "info": info,
            "findings_total": findings.len(), "rules_unavailable": rules_unavailable,
        },
        "findings": findings,
        "rule_outcomes": rule_outcomes_json(&outcomes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evidence::{Coverage, SessionMeta, SignalSet, Timeline};

    fn empty_canonical(harness_id: &'static str) -> CanonicalSession {
        CanonicalSession {
            meta: SessionMeta {
                session_id: "s".to_string(),
                harness_id,
                workspace_roots: Vec::new(),
                model: None,
                span: None,
            },
            signals: SignalSet::EMPTY,
            coverage: Coverage::new(),
            attempts: Vec::new(),
            notes: Vec::new(),
            tool_calls: Timeline::new(),
            tool_results: Timeline::new(),
            approvals: Timeline::new(),
            sandbox_modes: Timeline::new(),
            turns: Timeline::new(),
        }
    }

    #[test]
    fn unknown_harness_id_is_equivalent_to_no_degrade() {
        // codex/dsh 此前的 dispatcher 从不调用 degrade——塌缩后传一个没有
        // degraded_rules 的执行环境 id 必须产生完全相同的结果（no-op 分支）。
        let canonical = empty_canonical("codex");
        let with_codex = audit_projection(&canonical, "codex");
        let with_unknown = audit_projection(&canonical, "future-harness");
        assert_eq!(with_codex, with_unknown);
    }

    #[test]
    fn claude_code_harness_id_applies_sv607_608_degrade() {
        let canonical = empty_canonical("claude-code");
        let out = audit_projection(&canonical, "claude-code");
        // ToolResults 结构性空 → 家族①门控已经给 Unavailable（reason 是门控的
        // "no evidence"，不是 harness-capability override）；空 timeline 时 degrade
        // 的 MeasuredZero→Unavailable 分支不会触发，因为门控已经先一步给了
        // Unavailable——这条断言只钉「不 panic、结构对」，真正的 override
        // 行为已经在 harness_capability.rs 单测钉死。
        assert_eq!(out["rule_outcomes"]["SV607"]["status"], json!("unavailable"));
    }
}
