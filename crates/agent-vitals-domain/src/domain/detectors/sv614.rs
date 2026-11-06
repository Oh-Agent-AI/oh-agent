//! §14.4 第五批迁移规则：SV614（权限异常）。判定逻辑与
//! `trajectory.rs::detect_sv614` **完全相同**：三个独立子判定，各自读不同
//! 信号：
//!   (a) 同一 `call_id` 请求审批 ≥3 次——只算有 `asked` 端的 approval；
//!   (b) 连续 `decided.outcome == "rejected"` ≥3 次——只算有 `decided` 端的
//!       approval，越过阈值倍数就再报一次（与 SV611 同款语义，不是"报真实
//!       run 长度"，与 SV613 不同）；
//!   (c) `agent.sandbox_mode` 事件里 `mode == "danger-full-access"` 出现
//!       ≥2 次——**不要求连续**，是整段轨迹的总计数，锚定第一次出现。
//!
//! 三者都是"计数类"判定，不是"区间类"——`run_end_seq` 恒为 `null`（旧实现
//! 原话："没有'从哪烧到哪'的概念，诚实置 null，不臆造一个区间"）。
//!
//! `requirement()` 用 `SignalRequirement::Any`（`SIGNAL_APPROVAL_DECISIONS`,
//! `SIGNAL_SANDBOX_MODES`）——(a)(b) 依赖前者、(c) 依赖后者，任一有证据规则
//! 就不是完全测不了，与 SV613 同一条纪律（`trajectory.rs::OR_REQUIRES_CODES`）。

use std::collections::BTreeMap;

use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::error::VitalsError;
use vitals_core::event::{CanonicalEvent, SourceRef as VitalsSourceRef};
use vitals_core::evidence::Evidence as VitalsEvidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::signal::SignalId;

use crate::behavior::normalize;
use crate::compatibility::canonical_session::{KIND_APPROVAL, KIND_SANDBOX_MODE, SIGNAL_APPROVAL_DECISIONS, SIGNAL_SANDBOX_MODES};

const MIN_SAME_CALL_APPROVALS: usize = 3;
const MIN_CONSECUTIVE_REJECTIONS: usize = 3;
const MIN_DANGER_GRANTS: usize = 2;

fn attr(v: &serde_json::Value, key: &str) -> serde_json::Value {
    v.get(key).cloned().unwrap_or(serde_json::Value::Null)
}

fn draft(evidence_text: &str, anchor: &CanonicalEvent, event_ids: Vec<vitals_core::id::EventId>) -> FindingDraft {
    FindingDraft {
        kind: "trajectory.approval_anomaly".to_string(),
        severity: Severity::Warning,
        confidence: None,
        evidence: vec![VitalsEvidence {
            event_ids,
            description: evidence_text.to_string(),
            source_refs: vec![VitalsSourceRef {
                source_type: anchor.source.source_type.clone(),
                source_id: anchor.source.source_id.clone(),
                raw_reference: anchor.source.raw_reference.clone(),
                raw_ordinal: anchor.source.raw_ordinal,
            }],
            attributes: serde_json::json!({}),
        }],
        summary: "approval decisions show an anomalous permission pattern".to_string(),
        attributes: serde_json::json!({
            "rule": "SV614",
            "severity": "warning",
            "category": "approval",
            "tool_name": serde_json::Value::Null,
            "evidence": normalize(evidence_text),
            "seq": attr(&anchor.attributes, "seq"),
            "time": anchor.occurred_at_ms.map_or(serde_json::Value::Null, |t| serde_json::json!(t)),
            "turn": attr(&anchor.attributes, "turn"),
            "step": attr(&anchor.attributes, "step"),
            "call_id": attr(&anchor.attributes, "call_id"),
            "evidence_recency": "log",
            // 计数类判定，没有"这段烧到哪"的概念——诚实置 null，不臆造区间
            // （与 SV611/612/613 的区别，见模块文档）。
            "run_end_seq": serde_json::Value::Null,
        }),
    }
}

pub struct Sv614Detector;

impl Detector for Sv614Detector {
    fn id(&self) -> &str {
        "sv614"
    }

    fn version(&self) -> &str {
        "1"
    }

    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::Any(vec![SignalId::from(SIGNAL_APPROVAL_DECISIONS), SignalId::from(SIGNAL_SANDBOX_MODES)])
    }

    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let mut out = Vec::new();

        // (a) 同一 call_id 请求审批 ≥3 次——只算有 `asked` 端的 approval。
        // `BTreeMap` 直接按 call_id 排序，不需要像旧实现那样另外 collect+sort
        // 一遍（那是为了绕开 `HashMap` 迭代顺序不确定，`BTreeMap` 天生确定）。
        let mut by_call: BTreeMap<String, (usize, &CanonicalEvent)> = BTreeMap::new();
        for event in ctx.events {
            if event.kind != KIND_APPROVAL {
                continue;
            }
            if attr(&event.attributes, "asked").is_null() {
                continue;
            }
            let Some(call_id) = event.attributes.get("call_id").and_then(|v| v.as_str()) else { continue };
            let entry = by_call.entry(call_id.to_string()).or_insert((0, event));
            entry.0 += 1;
        }
        for (call_id, (count, anchor)) in &by_call {
            if *count >= MIN_SAME_CALL_APPROVALS {
                let evidence_text = format!("权限异常: 同一调用 {call_id} 请求审批 {count} 次");
                out.push(draft(&evidence_text, anchor, vec![anchor.id.clone()]));
            }
        }

        // (b) 连续 rejected——只遍历有 `decided` 端的 approval；没有 `decided`
        // 端的（asked-only）entry 透明跳过，不打断 run（与 SV612 空 turn 同
        // 一条纪律）。越过阈值倍数就再报一次，不是"报真实 run 长度"。
        let mut rej_run: usize = 0;
        let mut rej_anchor: Option<&CanonicalEvent> = None;
        for event in ctx.events {
            if event.kind != KIND_APPROVAL {
                continue;
            }
            let decided = attr(&event.attributes, "decided");
            if decided.is_null() {
                continue;
            }
            let outcome = decided.get("outcome").and_then(|v| v.as_str()).unwrap_or_default();
            if outcome == "rejected" {
                if rej_run == 0 {
                    rej_anchor = Some(event);
                }
                rej_run += 1;
                if rej_run >= MIN_CONSECUTIVE_REJECTIONS && rej_run % MIN_CONSECUTIVE_REJECTIONS == 0 {
                    if let Some(a) = rej_anchor {
                        let evidence_text = format!("权限异常: 连续 {rej_run} 次审批被拒");
                        let mut event_ids = vec![a.id.clone(), event.id.clone()];
                        event_ids.sort();
                        event_ids.dedup();
                        out.push(draft(&evidence_text, a, event_ids));
                    }
                }
            } else {
                rej_run = 0;
                rej_anchor = None;
            }
        }

        // (c) danger-full-access 出现次数——不要求连续，整段轨迹的总计数。
        let mut danger_count: usize = 0;
        let mut danger_anchor: Option<&CanonicalEvent> = None;
        for event in ctx.events {
            if event.kind != KIND_SANDBOX_MODE {
                continue;
            }
            if event.attributes.get("mode").and_then(|v| v.as_str()) == Some("danger-full-access") {
                if danger_count == 0 {
                    danger_anchor = Some(event);
                }
                danger_count += 1;
            }
        }
        if danger_count >= MIN_DANGER_GRANTS {
            if let Some(a) = danger_anchor {
                let evidence_text = format!("权限异常: 危险模式 danger-full-access 授予 {danger_count} 次");
                out.push(draft(&evidence_text, a, vec![a.id.clone()]));
            }
        }

        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vitals_core::coverage::Coverage;
    use vitals_core::id::{ActorId, EventId, TrajectoryId};
    use vitals_core::provenance::Provenance;
    use vitals_core::trajectory::Trajectory;

    fn approval_event(id: &str, ordinal: u64, seq: i64, call_id: Option<&str>, asked: bool, decided_outcome: Option<&str>) -> CanonicalEvent {
        let asked_val = if asked { serde_json::json!({"tool_name": "bash", "reason": null}) } else { serde_json::Value::Null };
        let decided_val = decided_outcome.map_or(serde_json::Value::Null, |o| serde_json::json!({"outcome": o}));
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_APPROVAL.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({"seq": seq, "turn": null, "step": null, "call_id": call_id, "asked": asked_val, "decided": decided_val}),
            outcome: None,
            source: VitalsSourceRef { source_type: "dsh_session".to_string(), source_id: "actor-1".to_string(), raw_reference: None, raw_ordinal: Some(ordinal) },
            provenance: Provenance::Measured,
        }
    }

    fn sandbox_mode_event(id: &str, ordinal: u64, seq: i64, mode: &str) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_SANDBOX_MODE.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({"mode": mode, "seq": seq, "turn": null, "step": null}),
            outcome: None,
            source: VitalsSourceRef { source_type: "dsh_session".to_string(), source_id: "actor-1".to_string(), raw_reference: None, raw_ordinal: Some(ordinal) },
            provenance: Provenance::Measured,
        }
    }

    fn detect(events: &[CanonicalEvent]) -> Vec<FindingDraft> {
        let mut traj = Trajectory::open(TrajectoryId::from("traj-1"), ActorId::from("actor-1"), None, 1);
        for e in events {
            traj.append(e.id.clone(), e.occurred_at_ms).unwrap();
        }
        let coverage = Coverage::new();
        let config = serde_json::json!({});
        let ctx = AuditContext { trajectory: &traj, events, coverage: &coverage, config: &config };
        Sv614Detector.detect(&ctx).unwrap()
    }

    #[test]
    fn same_call_id_asked_three_times_triggers_a() {
        let events = vec![
            approval_event("a1", 0, 1, Some("c1"), true, None),
            approval_event("a2", 1, 2, Some("c1"), true, None),
            approval_event("a3", 2, 3, Some("c1"), true, None),
        ];
        let findings = detect(&events);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].attributes["evidence"].as_str().unwrap().contains("c1"));
        assert_eq!(findings[0].attributes["run_end_seq"], serde_json::Value::Null);
    }

    #[test]
    fn three_consecutive_rejections_trigger_b() {
        let events = vec![
            approval_event("a1", 0, 1, None, false, Some("rejected")),
            approval_event("a2", 1, 2, None, false, Some("rejected")),
            approval_event("a3", 2, 3, None, false, Some("rejected")),
        ];
        let findings = detect(&events);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].attributes["evidence"].as_str().unwrap().contains("连续 3 次审批被拒"));
    }

    #[test]
    fn asked_only_entries_between_rejections_do_not_break_the_run() {
        let events = vec![
            approval_event("a1", 0, 1, Some("c9"), true, None), // 只有 asked，透明跳过
            approval_event("a2", 1, 2, None, false, Some("rejected")),
            approval_event("a3", 2, 3, None, false, Some("rejected")),
            approval_event("a4", 3, 4, None, false, Some("rejected")),
        ];
        let findings = detect(&events);
        assert_eq!(findings.iter().filter(|f| f.attributes["evidence"].as_str().unwrap().contains("被拒")).count(), 1);
    }

    #[test]
    fn danger_full_access_twice_non_consecutively_triggers_c() {
        let events = vec![
            sandbox_mode_event("s1", 0, 1, "danger-full-access"),
            sandbox_mode_event("s2", 1, 2, "workspace-write"),
            sandbox_mode_event("s3", 2, 3, "danger-full-access"),
        ];
        let findings = detect(&events);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].attributes["evidence"].as_str().unwrap().contains("2 次"));
    }

    #[test]
    fn all_three_sub_detectors_can_fire_together() {
        let events = vec![
            approval_event("a1", 0, 1, Some("c1"), true, None),
            approval_event("a2", 1, 2, Some("c1"), true, None),
            approval_event("a3", 2, 3, Some("c1"), true, None),
            approval_event("r1", 3, 4, None, false, Some("rejected")),
            approval_event("r2", 4, 5, None, false, Some("rejected")),
            approval_event("r3", 5, 6, None, false, Some("rejected")),
            sandbox_mode_event("s1", 6, 7, "danger-full-access"),
            sandbox_mode_event("s2", 7, 8, "danger-full-access"),
        ];
        assert_eq!(detect(&events).len(), 3);
    }
}
