//! §14.4 生产切换：SV604（敏感路径写入）。`write`/`edit` 工具 + 敏感路径
//! 正则；与 SV601–603 的区别：`tool_name` 是动态的（`write` 或 `edit`），不
//! 是固定 `"bash"`。

use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::error::VitalsError;
use vitals_core::event::SourceRef as VitalsSourceRef;
use vitals_core::evidence::Evidence as VitalsEvidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::signal::SignalId;

use crate::behavior::{first_match, normalize, sensitive_path_re};
use crate::compatibility::canonical_session::{KIND_TOOL_CALL, SIGNAL_TOOL_CALLS};

pub struct Sv604Detector;

impl Detector for Sv604Detector {
    fn id(&self) -> &str {
        "sv604"
    }

    fn version(&self) -> &str {
        "1"
    }

    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(SIGNAL_TOOL_CALLS)])
    }

    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let mut findings = Vec::new();
        for event in ctx.events {
            if event.kind != KIND_TOOL_CALL {
                continue;
            }
            let name = event.attributes.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            if name != "write" && name != "edit" {
                continue;
            }
            let args_text = event.attributes.get("args_text").and_then(|v| v.as_str()).unwrap_or_default();
            let Some(matched) = first_match(sensitive_path_re(), args_text) else { continue };

            let seq = event.attributes.get("seq").cloned().unwrap_or(serde_json::Value::Null);
            let turn = event.attributes.get("turn").cloned().unwrap_or(serde_json::Value::Null);
            let step = event.attributes.get("step").cloned().unwrap_or(serde_json::Value::Null);
            let call_id = event.attributes.get("call_id").cloned().unwrap_or(serde_json::Value::Null);
            let time = event.occurred_at_ms.map_or(serde_json::Value::Null, |t| serde_json::json!(t));

            findings.push(FindingDraft {
                kind: "sensitive_fs.write".to_string(),
                severity: Severity::Critical,
                confidence: None,
                evidence: vec![VitalsEvidence {
                    event_ids: vec![event.id.clone()],
                    description: format!("{name} call targeted a sensitive path: {matched}"),
                    source_refs: vec![VitalsSourceRef {
                        source_type: event.source.source_type.clone(),
                        source_id: event.source.source_id.clone(),
                        raw_reference: event.source.raw_reference.clone(),
                        raw_ordinal: event.source.raw_ordinal,
                    }],
                    attributes: serde_json::json!({}),
                }],
                summary: "write/edit call targeted a sensitive filesystem path".to_string(),
                attributes: serde_json::json!({
                    "rule": "SV604",
                    "severity": "critical",
                    "category": "sensitive-fs",
                    "tool_name": name,
                    "evidence": normalize(&matched),
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

    fn tool_call_event(id: &str, ordinal: u64, name: &str, args_text: &str) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_TOOL_CALL.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({"name": name, "args_text": args_text, "seq": ordinal as i64, "turn": null, "step": null, "call_id": null}),
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
        Sv604Detector.detect(&ctx).unwrap()
    }

    #[test]
    fn detects_write_to_etc() {
        let events = vec![tool_call_event("e0", 0, "write", r#"{"file_path":"/etc/passwd"}"#)];
        let findings = detect(&events);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].attributes["tool_name"], serde_json::json!("write"));
    }

    #[test]
    fn detects_edit_to_ssh_authorized_keys() {
        let events = vec![tool_call_event("e0", 0, "edit", r#"{"file_path":"~/.ssh/authorized_keys"}"#)];
        assert_eq!(detect(&events).len(), 1);
    }

    #[test]
    fn ignores_write_to_a_normal_path() {
        let events = vec![tool_call_event("e0", 0, "write", r#"{"file_path":"/tmp/a.txt"}"#)];
        assert!(detect(&events).is_empty());
    }

    #[test]
    fn ignores_non_write_edit_tools() {
        let events = vec![tool_call_event("e0", 0, "bash", r#"{"command":"cat /etc/passwd"}"#)];
        assert!(detect(&events).is_empty());
    }
}
