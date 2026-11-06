//! §14.4 生产切换：SV610（危险沙箱模式 / 单次放行）。两个独立子来源各自
//! 产出 finding：`agent.sandbox_mode` 里的 `danger-full-access`，和
//! `agent.approval` 里 `decided.outcome == "allowed-once"`。
//!
//! # `enhances` 在这里怎么落地
//!
//! 旧 `RuleSpec` 里 SV610 的门控只 `requires: [SandboxModes]`，
//! `ApprovalDecisions` 是 `enhances`——缺了它规则仍然跑，只是"跑了但读不到
//! 审批数据"。`vitals-core` 的 `SignalRequirement` 目前只有 `All`/`Any`，没
//! 有正式的 `enhances` 概念（spec §9.1.1 记的已知缺口）——但**这条规则不需
//! 要它**：`requirement()` 只声明 `SignalRequirement::All([SIGNAL_SANDBOX_
//! MODES])`，门控只卡这一个信号；`detect()` 内部照样从 `ctx.events` 里读
//! `agent.approval` kind 的事件——Engine 从不按 `requirement()` 过滤
//! `AuditContext.events`（那是投影阶段就已经放进去的全部数据，见
//! `vitals_core::detector::AuditContext` 文档），所以"门控只卡一个信号，
//! detect 内部多读一个"不需要额外机制，`enhances` 缺口在这条规则上是理论
//! 缺口、不是实现障碍。

use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::error::VitalsError;
use vitals_core::event::SourceRef as VitalsSourceRef;
use vitals_core::evidence::Evidence as VitalsEvidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::signal::SignalId;

use crate::behavior::normalize;
use crate::compatibility::canonical_session::{KIND_APPROVAL, KIND_SANDBOX_MODE, SIGNAL_SANDBOX_MODES};

fn attr(v: &serde_json::Value, key: &str) -> serde_json::Value {
    v.get(key).cloned().unwrap_or(serde_json::Value::Null)
}

fn draft(evidence_text: &str, event: &vitals_core::event::CanonicalEvent) -> FindingDraft {
    FindingDraft {
        kind: "approval.sandbox_grant".to_string(),
        severity: Severity::Warning,
        confidence: None,
        evidence: vec![VitalsEvidence {
            event_ids: vec![event.id.clone()],
            description: evidence_text.to_string(),
            source_refs: vec![VitalsSourceRef {
                source_type: event.source.source_type.clone(),
                source_id: event.source.source_id.clone(),
                raw_reference: event.source.raw_reference.clone(),
                raw_ordinal: event.source.raw_ordinal,
            }],
            attributes: serde_json::json!({}),
        }],
        summary: "a permissive sandbox/approval decision was observed".to_string(),
        attributes: serde_json::json!({
            "rule": "SV610",
            "severity": "warning",
            "category": "approval",
            "tool_name": serde_json::Value::Null,
            "evidence": normalize(evidence_text),
            "seq": attr(&event.attributes, "seq"),
            "time": event.occurred_at_ms.map_or(serde_json::Value::Null, |t| serde_json::json!(t)),
            "turn": attr(&event.attributes, "turn"),
            "step": attr(&event.attributes, "step"),
            "call_id": attr(&event.attributes, "call_id"),
            "evidence_recency": "log",
            "run_end_seq": serde_json::Value::Null,
        }),
    }
}

pub struct Sv610Detector;

impl Detector for Sv610Detector {
    fn id(&self) -> &str {
        "sv610"
    }

    fn version(&self) -> &str {
        "1"
    }

    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(SIGNAL_SANDBOX_MODES)])
    }

    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let mut findings = Vec::new();
        for event in ctx.events {
            if event.kind != KIND_SANDBOX_MODE {
                continue;
            }
            if event.attributes.get("mode").and_then(|v| v.as_str()) == Some("danger-full-access") {
                findings.push(draft("danger-full-access", event));
            }
        }
        for event in ctx.events {
            if event.kind != KIND_APPROVAL {
                continue;
            }
            let decided = attr(&event.attributes, "decided");
            if decided.get("outcome").and_then(|v| v.as_str()) == Some("allowed-once") {
                findings.push(draft("allowed-once", event));
            }
        }
        Ok(findings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vitals_core::coverage::Coverage;
    use vitals_core::event::CanonicalEvent;
    use vitals_core::id::{ActorId, EventId};
    use vitals_core::provenance::Provenance;
    use vitals_core::trajectory::Trajectory;

    fn sandbox_mode_event(id: &str, ordinal: u64, mode: &str) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_SANDBOX_MODE.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({"mode": mode, "seq": ordinal as i64, "turn": null, "step": null}),
            outcome: None,
            source: VitalsSourceRef { source_type: "dsh_session".to_string(), source_id: "actor-1".to_string(), raw_reference: None, raw_ordinal: Some(ordinal) },
            provenance: Provenance::Measured,
        }
    }

    fn approval_event(id: &str, ordinal: u64, outcome: &str) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_APPROVAL.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({"seq": ordinal as i64, "turn": null, "step": null, "call_id": null, "asked": null, "decided": {"outcome": outcome}}),
            outcome: None,
            source: VitalsSourceRef { source_type: "dsh_session".to_string(), source_id: "actor-1".to_string(), raw_reference: None, raw_ordinal: Some(ordinal) },
            provenance: Provenance::Measured,
        }
    }

    fn detect(events: &[CanonicalEvent]) -> Vec<FindingDraft> {
        let mut traj = Trajectory::open(vitals_core::id::TrajectoryId::from("traj-1"), ActorId::from("actor-1"), None, 1);
        for e in events {
            traj.append(e.id.clone(), e.occurred_at_ms).unwrap();
        }
        let coverage = Coverage::new();
        let config = serde_json::json!({});
        let ctx = AuditContext { trajectory: &traj, events, coverage: &coverage, config: &config };
        Sv610Detector.detect(&ctx).unwrap()
    }

    #[test]
    fn detects_danger_full_access() {
        let events = vec![sandbox_mode_event("e0", 0, "danger-full-access")];
        assert_eq!(detect(&events).len(), 1);
    }

    #[test]
    fn ignores_workspace_write() {
        let events = vec![sandbox_mode_event("e0", 0, "workspace-write")];
        assert!(detect(&events).is_empty());
    }

    #[test]
    fn detects_allowed_once_approvals_even_without_any_sandbox_event() {
        // 门控只卡 SandboxModes，但审批数据仍然被读——这是 enhances 落地的
        // 关键断言：没有任何 sandbox_mode 事件时，approval 那一半照样能出
        // finding（只要门控本身放行了，见模块文档）。
        let events = vec![approval_event("e0", 0, "allowed-once")];
        assert_eq!(detect(&events).len(), 1);
    }

    #[test]
    fn ignores_rejected_approvals() {
        let events = vec![approval_event("e0", 0, "rejected")];
        assert!(detect(&events).is_empty());
    }

    #[test]
    fn both_sources_can_fire_together() {
        let events = vec![sandbox_mode_event("e0", 0, "danger-full-access"), approval_event("e1", 1, "allowed-once")];
        assert_eq!(detect(&events).len(), 2);
    }
}
