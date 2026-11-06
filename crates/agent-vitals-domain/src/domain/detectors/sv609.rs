//! §14.4 生产切换：SV609（审批请求，纯信息级）。**无条件**——每一条有
//! `asked` 端的 `agent.approval` 事件都报一条 info，不做任何正则/阈值过
//! 滤，是这批规则里唯一"看见就报"的一条。

use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::error::VitalsError;
use vitals_core::event::SourceRef as VitalsSourceRef;
use vitals_core::evidence::Evidence as VitalsEvidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::signal::SignalId;

use crate::behavior::normalize;
use crate::compatibility::canonical_session::{KIND_APPROVAL, SIGNAL_APPROVAL_DECISIONS};

pub struct Sv609Detector;

impl Detector for Sv609Detector {
    fn id(&self) -> &str {
        "sv609"
    }

    fn version(&self) -> &str {
        "1"
    }

    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(SIGNAL_APPROVAL_DECISIONS)])
    }

    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let mut findings = Vec::new();
        for event in ctx.events {
            if event.kind != KIND_APPROVAL {
                continue;
            }
            let asked = event.attributes.get("asked").cloned().unwrap_or(serde_json::Value::Null);
            if asked.is_null() {
                continue;
            }
            let reason = asked.get("reason").and_then(|v| v.as_str()).unwrap_or_default();
            let tool_name = asked.get("tool_name").and_then(|v| v.as_str()).unwrap_or_default();
            let evidence_text = if !reason.is_empty() {
                reason.to_string()
            } else if !tool_name.is_empty() {
                tool_name.to_string()
            } else {
                String::new()
            };
            let tool_name_json = asked.get("tool_name").cloned().unwrap_or(serde_json::Value::Null);

            let seq = event.attributes.get("seq").cloned().unwrap_or(serde_json::Value::Null);
            let turn = event.attributes.get("turn").cloned().unwrap_or(serde_json::Value::Null);
            let step = event.attributes.get("step").cloned().unwrap_or(serde_json::Value::Null);
            let call_id = event.attributes.get("call_id").cloned().unwrap_or(serde_json::Value::Null);
            let time = event.occurred_at_ms.map_or(serde_json::Value::Null, |t| serde_json::json!(t));

            findings.push(FindingDraft {
                kind: "approval.requested".to_string(),
                severity: Severity::Info,
                confidence: None,
                evidence: vec![VitalsEvidence {
                    event_ids: vec![event.id.clone()],
                    description: format!("approval requested: {evidence_text}"),
                    source_refs: vec![VitalsSourceRef {
                        source_type: event.source.source_type.clone(),
                        source_id: event.source.source_id.clone(),
                        raw_reference: event.source.raw_reference.clone(),
                        raw_ordinal: event.source.raw_ordinal,
                    }],
                    attributes: serde_json::json!({}),
                }],
                summary: "an approval was requested".to_string(),
                attributes: serde_json::json!({
                    "rule": "SV609",
                    "severity": "info",
                    "category": "approval",
                    "tool_name": tool_name_json,
                    "evidence": normalize(&evidence_text),
                    "seq": seq,
                    "time": time,
                    "turn": turn,
                    "step": step,
                    "call_id": call_id,
                    "evidence_recency": "log",
                    "run_end_seq": serde_json::Value::Null,
                }),
            });
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

    fn approval_event(id: &str, ordinal: u64, tool_name: Option<&str>, reason: Option<&str>) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_APPROVAL.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({
                "seq": ordinal as i64, "turn": null, "step": null, "call_id": null,
                "asked": {"tool_name": tool_name, "reason": reason},
                "decided": null,
            }),
            outcome: None,
            source: VitalsSourceRef { source_type: "dsh_session".to_string(), source_id: "actor-1".to_string(), raw_reference: None, raw_ordinal: Some(ordinal) },
            provenance: Provenance::Measured,
        }
    }

    fn no_asked_event(id: &str, ordinal: u64) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_APPROVAL.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({"seq": ordinal as i64, "turn": null, "step": null, "call_id": null, "asked": null, "decided": {"outcome": "rejected"}}),
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
        Sv609Detector.detect(&ctx).unwrap()
    }

    #[test]
    fn every_asked_approval_is_reported_unconditionally() {
        let events = vec![approval_event("e0", 0, Some("bash"), Some("escalate to root")), approval_event("e1", 1, Some("write"), None)];
        let findings = detect(&events);
        assert_eq!(findings.len(), 2);
    }

    #[test]
    fn evidence_prefers_reason_over_tool_name() {
        let events = vec![approval_event("e0", 0, Some("bash"), Some("escalate"))];
        let findings = detect(&events);
        assert_eq!(findings[0].attributes["evidence"], serde_json::json!("escalate"));
    }

    #[test]
    fn evidence_falls_back_to_tool_name_when_reason_is_absent() {
        let events = vec![approval_event("e0", 0, Some("bash"), None)];
        let findings = detect(&events);
        assert_eq!(findings[0].attributes["evidence"], serde_json::json!("bash"));
    }

    #[test]
    fn decided_only_entries_without_asked_are_skipped() {
        let events = vec![no_asked_event("e0", 0)];
        assert!(detect(&events).is_empty());
    }
}
