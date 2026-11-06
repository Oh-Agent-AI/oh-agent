//! §14.4 生产切换：SV607（拒绝/中止类工具结果码）。读 `agent.tool_result`
//! 的 `error_code`，命中 `DENIED_CODES` 集合（`TOOL_TIMEOUT` 归 SV608，不在
//! 这里）。

use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::error::VitalsError;
use vitals_core::event::SourceRef as VitalsSourceRef;
use vitals_core::evidence::Evidence as VitalsEvidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::signal::SignalId;

use crate::behavior::{normalize, DENIED_CODES};
use crate::compatibility::canonical_session::{KIND_TOOL_RESULT, SIGNAL_TOOL_RESULTS};

pub struct Sv607Detector;

impl Detector for Sv607Detector {
    fn id(&self) -> &str {
        "sv607"
    }

    fn version(&self) -> &str {
        "1"
    }

    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(SIGNAL_TOOL_RESULTS)])
    }

    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let mut findings = Vec::new();
        for event in ctx.events {
            if event.kind != KIND_TOOL_RESULT {
                continue;
            }
            let Some(code) = event.attributes.get("error_code").and_then(|v| v.as_str()) else { continue };
            if !DENIED_CODES.contains(&code) {
                continue;
            }

            let seq = event.attributes.get("seq").cloned().unwrap_or(serde_json::Value::Null);
            let turn = event.attributes.get("turn").cloned().unwrap_or(serde_json::Value::Null);
            let step = event.attributes.get("step").cloned().unwrap_or(serde_json::Value::Null);
            let call_id = event.attributes.get("call_id").cloned().unwrap_or(serde_json::Value::Null);
            let time = event.occurred_at_ms.map_or(serde_json::Value::Null, |t| serde_json::json!(t));

            findings.push(FindingDraft {
                kind: "approval.denied_result".to_string(),
                severity: Severity::Warning,
                confidence: None,
                evidence: vec![VitalsEvidence {
                    event_ids: vec![event.id.clone()],
                    description: format!("tool result denied/aborted: {code}"),
                    source_refs: vec![VitalsSourceRef {
                        source_type: event.source.source_type.clone(),
                        source_id: event.source.source_id.clone(),
                        raw_reference: event.source.raw_reference.clone(),
                        raw_ordinal: event.source.raw_ordinal,
                    }],
                    attributes: serde_json::json!({}),
                }],
                summary: "tool result carried a denied/aborted error code".to_string(),
                attributes: serde_json::json!({
                    "rule": "SV607",
                    "severity": "warning",
                    "category": "approval",
                    "tool_name": serde_json::Value::Null,
                    "evidence": normalize(code),
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

    fn tool_result_event(id: &str, ordinal: u64, error_code: Option<&str>) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_TOOL_RESULT.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({"error_code": error_code, "seq": ordinal as i64, "turn": null, "step": null, "call_id": null}),
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
        Sv607Detector.detect(&ctx).unwrap()
    }

    #[test]
    fn detects_sandbox_denied() {
        let events = vec![tool_result_event("e0", 0, Some("FS_SANDBOX_DENIED"))];
        assert_eq!(detect(&events).len(), 1);
    }

    #[test]
    fn tool_timeout_is_not_sv607() {
        // TOOL_TIMEOUT 归 SV608。
        let events = vec![tool_result_event("e0", 0, Some("TOOL_TIMEOUT"))];
        assert!(detect(&events).is_empty());
    }

    #[test]
    fn no_error_code_is_ignored() {
        let events = vec![tool_result_event("e0", 0, None)];
        assert!(detect(&events).is_empty());
    }
}
