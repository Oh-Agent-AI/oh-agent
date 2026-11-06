//! §14.4 生产切换：SV605（工作区外写入）。`write`/`edit` 工具，路径既不是
//! SV604 已经处理过的敏感路径、又落在工作区根之外。
//!
//! 唯一需要 `config` 的规则——工作区根不是事件属性,是"这次审计针对哪个
//! session"这层的上下文,走 `AuditContext.config`（见
//! `compatibility::run_pipeline` 文档）。legacy 语义原样保留：根缺失或为空
//! 串时退化成纯绝对路径启发式（宁可多报不误放）。

use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::error::VitalsError;
use vitals_core::event::SourceRef as VitalsSourceRef;
use vitals_core::evidence::Evidence as VitalsEvidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::signal::SignalId;

use crate::behavior::{abs_path_re, first_match, normalize, sensitive_path_re};
use crate::compatibility::canonical_session::{KIND_TOOL_CALL, SIGNAL_TOOL_CALLS};

pub struct Sv605Detector;

impl Detector for Sv605Detector {
    fn id(&self) -> &str {
        "sv605"
    }

    fn version(&self) -> &str {
        "1"
    }

    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(SIGNAL_TOOL_CALLS)])
    }

    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let root = ctx
            .config
            .get("workspace_root")
            .and_then(|v| v.as_str())
            .filter(|w| !w.is_empty())
            .map(|w| w.trim_end_matches('/').to_string());

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
            // 敏感目标由 SV604 以 critical 负责，不重复报 warning。
            if sensitive_path_re().is_match(args_text) {
                continue;
            }
            let Some(path) = first_match(abs_path_re(), args_text) else { continue };
            if let Some(root) = &root {
                if path == *root || path.starts_with(&format!("{root}/")) {
                    continue;
                }
            }

            let seq = event.attributes.get("seq").cloned().unwrap_or(serde_json::Value::Null);
            let turn = event.attributes.get("turn").cloned().unwrap_or(serde_json::Value::Null);
            let step = event.attributes.get("step").cloned().unwrap_or(serde_json::Value::Null);
            let call_id = event.attributes.get("call_id").cloned().unwrap_or(serde_json::Value::Null);
            let time = event.occurred_at_ms.map_or(serde_json::Value::Null, |t| serde_json::json!(t));

            findings.push(FindingDraft {
                kind: "sensitive_fs.outside_workspace".to_string(),
                severity: Severity::Warning,
                confidence: None,
                evidence: vec![VitalsEvidence {
                    event_ids: vec![event.id.clone()],
                    description: format!("{name} call wrote outside the workspace root: {path}"),
                    source_refs: vec![VitalsSourceRef {
                        source_type: event.source.source_type.clone(),
                        source_id: event.source.source_id.clone(),
                        raw_reference: event.source.raw_reference.clone(),
                        raw_ordinal: event.source.raw_ordinal,
                    }],
                    attributes: serde_json::json!({}),
                }],
                summary: "write/edit call targeted a path outside the workspace root".to_string(),
                attributes: serde_json::json!({
                    "rule": "SV605",
                    "severity": "warning",
                    "category": "sensitive-fs",
                    "tool_name": name,
                    "evidence": normalize(&path),
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

    fn detect(events: &[CanonicalEvent], config: serde_json::Value) -> Vec<FindingDraft> {
        let mut traj = Trajectory::open(vitals_core::id::TrajectoryId::from("traj-1"), ActorId::from("actor-1"), None, 1);
        for e in events {
            traj.append(e.id.clone(), e.occurred_at_ms).unwrap();
        }
        let coverage = Coverage::new();
        let ctx = AuditContext { trajectory: &traj, events, coverage: &coverage, config: &config };
        Sv605Detector.detect(&ctx).unwrap()
    }

    #[test]
    fn no_workspace_root_falls_back_to_pure_absolute_path_heuristic() {
        let events = vec![tool_call_event("e0", 0, "write", r#"{"file_path":"/var/log/a.log"}"#)];
        let findings = detect(&events, serde_json::json!({}));
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn path_under_workspace_root_is_not_flagged() {
        let events = vec![tool_call_event("e0", 0, "write", r#"{"file_path":"/home/user/project/a.txt"}"#)];
        let findings = detect(&events, serde_json::json!({"workspace_root": "/home/user/project"}));
        assert!(findings.is_empty());
    }

    #[test]
    fn path_outside_workspace_root_is_flagged() {
        // 不敏感（不命中 SV604 的路径），但落在工作区根之外。
        let events = vec![tool_call_event("e0", 0, "write", r#"{"file_path":"/opt/other/a.txt"}"#)];
        let findings = detect(&events, serde_json::json!({"workspace_root": "/home/user/project"}));
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn sensitive_path_is_left_to_sv604_not_double_reported() {
        let events = vec![tool_call_event("e0", 0, "write", r#"{"file_path":"/etc/passwd"}"#)];
        assert!(detect(&events, serde_json::json!({})).is_empty());
    }

    #[test]
    fn empty_workspace_root_string_falls_back_to_pure_heuristic() {
        let events = vec![tool_call_event("e0", 0, "write", r#"{"file_path":"/opt/x/a.txt"}"#)];
        let findings = detect(&events, serde_json::json!({"workspace_root": ""}));
        assert_eq!(findings.len(), 1);
    }
}
