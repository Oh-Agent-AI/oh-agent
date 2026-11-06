//! §14.4 第二批迁移规则：SV611（连续相同工具调用签名 ≥3 次）。判定逻辑与
//! `trajectory.rs::detect_sv611` **完全相同**——同一个阈值常量、同一条"越过
//! 阈值倍数就再报一次"规则,只是读的输入换成了投影后的 `CanonicalEvent`
//! （`kind == agent.tool_call`）而不是 `CanonicalSession.tool_calls` 的裸
//! timeline entry。
//!
//! # 与 SV601 的两个结构性差异
//!
//! 1. **跨事件状态**：SV601 逐事件独立判定，这里需要在 `detect()` 内部维护
//!    "上一个签名 + 连续计数 + run 起点(anchor)"——这是 v0.5 里第一条真正
//!    有状态的 Detector,但状态只活在一次 `detect()` 调用里，不跨 trajectory、
//!    不跨会话,符合 §4.5 Deterministic-first。
//! 2. **`run_end_seq` 是真实值**：SV601 恒为 `null`（§10.2 的 legacy
//!    展示字段直接透传），SV611 的 `run_end_seq` 是"这一段重复烧到哪个
//!    seq"——展示坐标（`seq`/`time`/`turn`/`step`/`call_id`）仍然锚定在
//!    run 起点（`anchor`），`run_end_seq` 单独取当前越过阈值那个事件的
//!    `seq`。
//!
//!    `Evidence.event_ids` 必须同时包含 `anchor` **和**当前事件，不能只放
//!    `anchor`——第一次实现只放了 anchor，被 parity 测试当场抓到：6 连击本
//!    该在 count=3、count=6 各报一次，只报了一次。原因是 §10.3 的
//!    fingerprint 只吃 `evidence.event_ids`，不吃 `attributes`——两条
//!    finding 的 `run_end_seq`（3 vs 6）只活在 attributes 里，若 evidence
//!    仍然都是 `[anchor]`，fingerprint 逐字节相同，第二条会被 §10.3 的报告
//!    内去重误判成"同一条 finding 又报了一次"而丢弃。把越过阈值的当前事件
//!    也算进 evidence 之后没有这个问题：它本来就是这条 finding 成立的真实
//!    原因之一（"count 达到 N"这件事，正是由这个事件的出现促成的），把它
//!    排除在证据之外才是简化过头。这也顺带修好了 replay 锚点（§11.4）：
//!    frame 现在停在"阈值被跨过"的那一刻，而不是错误地停在 run 起点。

use std::collections::BTreeSet;

use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::error::VitalsError;
use vitals_core::event::{CanonicalEvent, SourceRef as VitalsSourceRef};
use vitals_core::evidence::Evidence as VitalsEvidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::signal::SignalId;

use crate::behavior::normalize;
use crate::compatibility::canonical_session::{KIND_TOOL_CALL, SIGNAL_TOOL_CALLS};

/// 与 `trajectory.rs::MIN_REPEAT` 相同。
const MIN_REPEAT: usize = 3;

fn tool_call_signature(event: &CanonicalEvent) -> Option<(String, String)> {
    let name = event.attributes.get("name")?.as_str()?.to_string();
    let args_text = event.attributes.get("args_text")?.as_str()?.to_string();
    Some((name, args_text))
}

/// 从 bridge 塞进 `attributes` 的原始坐标里取一个键，取不到就是 `null`
/// （§14.3："无法无损映射的字段不得猜测"的同一条纪律，取不到就诚实置空,
/// 不猜）。
fn attr(v: &serde_json::Value, key: &str) -> serde_json::Value {
    v.get(key).cloned().unwrap_or(serde_json::Value::Null)
}

pub struct Sv611Detector;

impl Detector for Sv611Detector {
    fn id(&self) -> &str {
        "sv611"
    }

    fn version(&self) -> &str {
        "1"
    }

    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(SIGNAL_TOOL_CALLS)])
    }

    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let mut findings = Vec::new();
        let mut prev: Option<(String, String)> = None;
        let mut count: usize = 0;
        let mut anchor: Option<&CanonicalEvent> = None;

        for event in ctx.events {
            if event.kind != KIND_TOOL_CALL {
                continue;
            }
            let Some(sig) = tool_call_signature(event) else { continue };
            if prev.as_ref() == Some(&sig) {
                count += 1;
            } else {
                prev = Some(sig);
                count = 1;
                anchor = Some(event);
            }
            if count >= MIN_REPEAT && count % MIN_REPEAT == 0 {
                let Some(a) = anchor else { continue };
                let name = a.attributes.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let evidence_text = format!("{name} 连续重复 {count} 次");
                let run_end_seq = attr(&event.attributes, "seq");

                // anchor（run 起点）+ 当前事件（把 count 推过这次阈值倍数的
                // 那一个）——两者都是这条 finding 成立的证据，缺一都不构成
                // "连续重复到这个 seq"这件事。用 BTreeSet 只是为了在
                // count == MIN_REPEAT 且 anchor 恰好等于 event 的边界情形下
                // （理论上不会发生，MIN_REPEAT > 1，但不依赖这个假设）不重
                // 复塞同一个 id。
                let event_ids: Vec<_> = [a.id.clone(), event.id.clone()].into_iter().collect::<BTreeSet<_>>().into_iter().collect();

                findings.push(FindingDraft {
                    kind: "trajectory.repeated_tool_call".to_string(),
                    severity: Severity::Warning,
                    confidence: None,
                    evidence: vec![VitalsEvidence {
                        event_ids,
                        description: evidence_text.clone(),
                        source_refs: vec![VitalsSourceRef {
                            source_type: a.source.source_type.clone(),
                            source_id: a.source.source_id.clone(),
                            raw_reference: a.source.raw_reference.clone(),
                            raw_ordinal: a.source.raw_ordinal,
                        }],
                        attributes: serde_json::json!({}),
                    }],
                    summary: "the same tool call signature repeated consecutively".to_string(),
                    attributes: serde_json::json!({
                        "rule": "SV611",
                        "severity": "warning",
                        "category": "trajectory",
                        "tool_name": name,
                        "evidence": normalize(&evidence_text),
                        "seq": attr(&a.attributes, "seq"),
                        "time": a.occurred_at_ms.map_or(serde_json::Value::Null, |t| serde_json::json!(t)),
                        "turn": attr(&a.attributes, "turn"),
                        "step": attr(&a.attributes, "step"),
                        "call_id": attr(&a.attributes, "call_id"),
                        "evidence_recency": "log",
                        "run_end_seq": run_end_seq,
                    }),
                });
            }
        }
        Ok(findings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vitals_core::coverage::Coverage;
    use vitals_core::id::{ActorId, EventId, TrajectoryId};
    use vitals_core::provenance::Provenance;
    use vitals_core::trajectory::Trajectory;

    fn tool_call_event(id: &str, ordinal: u64, seq: i64, args_text: &str) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_TOOL_CALL.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({"name": "bash", "args_text": args_text, "seq": seq, "turn": null, "step": null, "call_id": null}),
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
        Sv611Detector.detect(&ctx).unwrap()
    }

    #[test]
    fn three_identical_calls_trigger_one_finding_anchored_at_the_first() {
        let events = vec![
            tool_call_event("e0", 0, 1, "ls"),
            tool_call_event("e1", 1, 2, "ls"),
            tool_call_event("e2", 2, 3, "ls"),
        ];
        let findings = detect(&events);
        assert_eq!(findings.len(), 1);
        // evidence = anchor（run 起点，展示坐标来源）+ 当前事件（把 count 推
        // 过阈值的那个）——见模块顶部注释，这不是"多余的第二条证据"，是
        // fingerprint 需要靠它区分不同长度的 run。
        assert_eq!(findings[0].evidence[0].event_ids, vec![EventId::from("e0"), EventId::from("e2")]);
        assert_eq!(findings[0].attributes["run_end_seq"], serde_json::json!(3));
        assert_eq!(findings[0].attributes["seq"], serde_json::json!(1));
    }

    #[test]
    fn two_identical_calls_do_not_trigger() {
        let events = vec![tool_call_event("e0", 0, 1, "ls"), tool_call_event("e1", 1, 2, "ls")];
        assert!(detect(&events).is_empty());
    }

    #[test]
    fn six_identical_calls_report_twice_both_anchored_at_the_run_start() {
        let events: Vec<CanonicalEvent> = (0..6).map(|i| tool_call_event(&format!("e{i}"), i, i as i64 + 1, "ls")).collect();
        let findings = detect(&events);
        assert_eq!(findings.len(), 2);
        // 两条 finding 共享同一个 anchor（e0），但各自的"当前事件"不同
        // （e2 vs e5）——这正是它们没有被 §10.3 的报告内去重误判成同一条的
        // 原因，evidence 因此必须不同，不能只放 anchor。
        assert_eq!(findings[0].evidence[0].event_ids, vec![EventId::from("e0"), EventId::from("e2")]);
        assert_eq!(findings[1].evidence[0].event_ids, vec![EventId::from("e0"), EventId::from("e5")]);
        assert_eq!(findings[0].attributes["run_end_seq"], serde_json::json!(3));
        assert_eq!(findings[1].attributes["run_end_seq"], serde_json::json!(6));
    }

    #[test]
    fn a_different_call_breaks_the_streak() {
        let events = vec![
            tool_call_event("e0", 0, 1, "ls"),
            tool_call_event("e1", 1, 2, "ls"),
            tool_call_event("e2", 2, 3, "pwd"),
            tool_call_event("e3", 3, 4, "ls"),
        ];
        assert!(detect(&events).is_empty());
    }
}
