//! §14.4 第一批迁移规则之一：SV601（危险 shell 命令）。事件局部、纯正则、
//! 无跨事件状态——按 spec §14.4 patch 的重排理由，是验证"管线能不能把最简
//! 单的东西端到端跑通且逐字节一致"的第一条,排在 SV611/SV612 之前。
//!
//! 判定逻辑与 `behavior.rs::detect_sv601` **完全相同**：同一个正则、同一条
//! "只看 `name == bash`"过滤。正则字面量直接复制过来（不能 `pub use`——旧
//! 函数是 crate-private `fn destructive_re()`），如果两边哪天不一致了，
//! `sv601_parity.rs` 的逐字节对账会先红。

use std::sync::OnceLock;

use regex::Regex;
use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::error::VitalsError;
use vitals_core::event::SourceRef as VitalsSourceRef;
use vitals_core::evidence::Evidence as VitalsEvidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::signal::SignalId;

use crate::behavior::normalize;
use crate::compatibility::canonical_session::{KIND_TOOL_CALL, SIGNAL_TOOL_CALLS};

/// 与 `behavior.rs::destructive_re()` 逐字节相同的正则——不能复用旧函数本
/// 身，它是模块私有的（`fn destructive_re()`，无 `pub(crate)`），只能复制字
/// 面量。`normalize` 不在这条限制里：它是 `pub(crate)`，直接 `use` 过来，
/// 不重复实现。
fn destructive_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\brm\s+-[a-z]*r[a-z]*f[a-z]*\b|\brm\s+-[a-z]*f[a-z]*r[a-z]*\b|\bdd\b[^\n]{0,60}\bof=/dev/|\bmkfs\b").unwrap()
    })
}

pub struct Sv601Detector;

impl Detector for Sv601Detector {
    fn id(&self) -> &str {
        "sv601"
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
            if name != "bash" {
                continue;
            }
            let args_text = event.attributes.get("args_text").and_then(|v| v.as_str()).unwrap_or_default();
            let Some(matched) = destructive_re().find(args_text).map(|m| m.as_str().to_string()) else {
                continue;
            };

            let seq = event.attributes.get("seq").cloned().unwrap_or(serde_json::Value::Null);
            let turn = event.attributes.get("turn").cloned().unwrap_or(serde_json::Value::Null);
            let step = event.attributes.get("step").cloned().unwrap_or(serde_json::Value::Null);
            let call_id = event.attributes.get("call_id").cloned().unwrap_or(serde_json::Value::Null);
            let time = event.occurred_at_ms.map_or(serde_json::Value::Null, |t| serde_json::json!(t));

            findings.push(FindingDraft {
                kind: "shell.destructive_command".to_string(),
                severity: Severity::Critical,
                confidence: None,
                evidence: vec![VitalsEvidence {
                    event_ids: vec![event.id.clone()],
                    description: format!("bash call matched destructive pattern: {matched}"),
                    source_refs: vec![VitalsSourceRef {
                        source_type: event.source.source_type.clone(),
                        source_id: event.source.source_id.clone(),
                        raw_reference: event.source.raw_reference.clone(),
                        raw_ordinal: event.source.raw_ordinal,
                    }],
                    attributes: serde_json::json!({}),
                }],
                summary: "bash invocation matched a destructive shell pattern".to_string(),
                // legacy 展示字段——vitals_core::Finding 不认识这些名字，output
                // bridge（compatibility::findings）按约定的键名原样取出。
                attributes: serde_json::json!({
                    "rule": "SV601",
                    "severity": "critical",
                    "category": "shell",
                    "tool_name": "bash",
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
    use vitals_core::trajectory::{Trajectory, TrajectoryStatus};

    fn tool_call_event(id: &str, ordinal: u64, args_text: &str) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_TOOL_CALL.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({"name": "bash", "args_text": args_text, "seq": ordinal as i64, "turn": null, "step": null, "call_id": null}),
            outcome: None,
            source: VitalsSourceRef { source_type: "dsh_session".to_string(), source_id: "actor-1".to_string(), raw_reference: None, raw_ordinal: Some(ordinal) },
            provenance: Provenance::Measured,
        }
    }

    fn ctx_for<'a>(trajectory: &'a Trajectory, events: &'a [CanonicalEvent], coverage: &'a Coverage, config: &'a serde_json::Value) -> AuditContext<'a> {
        AuditContext { trajectory, events, coverage, config }
    }

    #[test]
    fn detects_destructive_bash_command() {
        let events = vec![tool_call_event("evt-0", 0, r#"{"command":"rm -rf /tmp/build"}"#)];
        let mut traj = Trajectory::open(vitals_core::id::TrajectoryId::from("traj-1"), ActorId::from("actor-1"), None, 1);
        traj.append(EventId::from("evt-0"), Some(1000)).unwrap();
        assert_eq!(traj.status, TrajectoryStatus::Open);

        let coverage = Coverage::new();
        let config = serde_json::json!({});
        let ctx = ctx_for(&traj, &events, &coverage, &config);
        let drafts = Sv601Detector.detect(&ctx).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].attributes["rule"], serde_json::json!("SV601"));
        assert_eq!(drafts[0].attributes["evidence"], serde_json::json!("rm -rf"));
    }

    #[test]
    fn ignores_non_destructive_bash_command() {
        let events = vec![tool_call_event("evt-0", 0, r#"{"command":"rm /tmp/build"}"#)];
        let mut traj = Trajectory::open(vitals_core::id::TrajectoryId::from("traj-1"), ActorId::from("actor-1"), None, 1);
        traj.append(EventId::from("evt-0"), Some(1000)).unwrap();
        let coverage = Coverage::new();
        let config = serde_json::json!({});
        let ctx = ctx_for(&traj, &events, &coverage, &config);
        assert!(Sv601Detector.detect(&ctx).unwrap().is_empty());
    }

    #[test]
    fn ignores_non_bash_tool_calls() {
        let mut event = tool_call_event("evt-0", 0, r#"{"command":"rm -rf /tmp"}"#);
        event.attributes["name"] = serde_json::json!("write_file");
        let events = vec![event];
        let mut traj = Trajectory::open(vitals_core::id::TrajectoryId::from("traj-1"), ActorId::from("actor-1"), None, 1);
        traj.append(EventId::from("evt-0"), Some(1000)).unwrap();
        let coverage = Coverage::new();
        let config = serde_json::json!({});
        let ctx = ctx_for(&traj, &events, &coverage, &config);
        assert!(Sv601Detector.detect(&ctx).unwrap().is_empty());
    }
}
