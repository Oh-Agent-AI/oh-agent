//! §14.4 第三批迁移规则：SV612（死循环——连续两个动作序列相同的 turn）。
//! 判定逻辑与 `trajectory.rs::detect_sv612` **完全相同**：同一个阈值常量、
//! 同一条"整段连续相同 turn 只报一次、更长不重报"规则,只是读的输入换成了
//! 投影后的 `CanonicalEvent`（`kind == agent.turn`,`attributes.sig`）。
//!
//! # 这条规则是 §8.4.1 设计的第一次真实检验
//!
//! v0.5 的 Trajectory 是扁平的（§8.4：一个 Event 只属于一条 Trajectory,不
//! 建子 trajectory）,但 SV612 天然需要"turn 内的动作序列"这个结构。
//! §8.4.1（spec patch）定的做法是：turn 坐标不建成子 trajectory,而是让适
//! 配器把已经算好的 `sig`（`TurnObservation.sig`,turn 内 tool/call 的有序
//! (name, args_text) 列表）随事件一起塞进 `attributes`,Detector 直接读、不
//! 在 Core 里重建 turn 状态机。
//!
//! 写这个 Detector 之前,桥接（`compatibility::canonical_session`）投影
//! `agent.turn` 事件时**漏了 `sig` 字段**——只搬了 `TurnObservation` 的其余
//! 六个字段。缺口在这里才暴露,因为 SV601/SV611 都不读 turn 事件,不会触发
//! 它。已经在 `canonical_session.rs` 补上,这是 §8.4.1 设计本身第一次被真实
//! 需求检验,而不是"理论上可行"。

use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::error::VitalsError;
use vitals_core::event::{CanonicalEvent, SourceRef as VitalsSourceRef};
use vitals_core::evidence::Evidence as VitalsEvidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::signal::SignalId;

use crate::behavior::normalize;
use crate::compatibility::canonical_session::{KIND_TURN, SIGNAL_TURN_BOUNDARIES};

/// 与 `trajectory.rs::MIN_LOOP_TURNS` 相同。
const MIN_LOOP_TURNS: usize = 2;

/// 从桥接塞进 `attributes["sig"]` 的 JSON 数组还原出 `(name, args_text)` 有
/// 序列表。格式错误的条目直接跳过而不是让整个签名判定失败——防御性地对待
/// 桥接层的输出,不假设它永远良构（虽然目前确实是）。
fn turn_sig(event: &CanonicalEvent) -> Vec<(String, String)> {
    event
        .attributes
        .get("sig")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|pair| {
                    let p = pair.as_array()?;
                    let name = p.first()?.as_str()?.to_string();
                    let args = p.get(1)?.as_str()?.to_string();
                    Some((name, args))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn attr(v: &serde_json::Value, key: &str) -> serde_json::Value {
    v.get(key).cloned().unwrap_or(serde_json::Value::Null)
}

pub struct Sv612Detector;

impl Detector for Sv612Detector {
    fn id(&self) -> &str {
        "sv612"
    }

    fn version(&self) -> &str {
        "1"
    }

    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(SIGNAL_TURN_BOUNDARIES)])
    }

    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let mut findings = Vec::new();
        let mut prev_sig: Option<Vec<(String, String)>> = None;
        let mut prev_event: Option<&CanonicalEvent> = None;
        let mut run_count: usize = 0;

        for event in ctx.events {
            if event.kind != KIND_TURN {
                continue;
            }
            let sig = turn_sig(event);
            if sig.is_empty() {
                // 空 turn（没有工具调用）不参与比较——两个都没有动作的 turn
                // 不是死循环。不推进 run_count、不更新 prev_sig/prev_event，
                // 对后续判定完全透明，与旧实现的 `continue` 语义一致。
                continue;
            }
            if prev_sig.as_ref() == Some(&sig) {
                run_count += 1;
            } else {
                prev_sig = Some(sig);
                run_count = 1;
            }

            // 只在 run 长度恰好到达阈值时报一次——run 更长不重报，run 中断
            // 后新序列重新数。
            if run_count == MIN_LOOP_TURNS {
                let turn_num = event.attributes.get("turn").and_then(|v| v.as_i64()).unwrap_or_default();
                let evidence_text = format!("死循环: turn {turn_num} 与上一 turn 动作序列相同");

                // evidence 同时包含触发判定的这个 turn 和与它比较的上一个
                // turn——两者共同构成"为什么这是一次死循环"的证据；只放当前
                // 事件在 SV611 上已经出过一次代价（同锚点、不同判定内容被误
                // 判成重复 finding），这里直接按更完整的版本写。
                let mut event_ids = vec![event.id.clone()];
                if let Some(prev) = prev_event {
                    event_ids.push(prev.id.clone());
                }
                event_ids.sort();
                event_ids.dedup();

                findings.push(FindingDraft {
                    kind: "trajectory.repeated_turn_sequence".to_string(),
                    severity: Severity::Warning,
                    confidence: None,
                    evidence: vec![VitalsEvidence {
                        event_ids,
                        description: evidence_text.clone(),
                        source_refs: vec![VitalsSourceRef {
                            source_type: event.source.source_type.clone(),
                            source_id: event.source.source_id.clone(),
                            raw_reference: event.source.raw_reference.clone(),
                            raw_ordinal: event.source.raw_ordinal,
                        }],
                        attributes: serde_json::json!({}),
                    }],
                    summary: "two consecutive turns had identical action sequences".to_string(),
                    attributes: serde_json::json!({
                        "rule": "SV612",
                        "severity": "warning",
                        "category": "trajectory",
                        "tool_name": serde_json::Value::Null,
                        "evidence": normalize(&evidence_text),
                        "seq": attr(&event.attributes, "seq"),
                        "time": event.occurred_at_ms.map_or(serde_json::Value::Null, |t| serde_json::json!(t)),
                        // 展示坐标用 entry 自身的 turn（`entry_turn`），不是
                        // observation.turn（本 turn 的编号，已经进了 evidence
                        // 文案）——两者是不同的问题，见 canonical_session.rs
                        // 的桥接注释。
                        "turn": attr(&event.attributes, "entry_turn"),
                        "step": attr(&event.attributes, "step"),
                        "call_id": attr(&event.attributes, "call_id"),
                        "evidence_recency": "log",
                        "run_end_seq": attr(&event.attributes, "last_seq"),
                    }),
                });
            }
            prev_event = Some(event);
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

    fn turn_event(id: &str, ordinal: u64, seq: i64, turn: i64, sig: &[(&str, &str)]) -> CanonicalEvent {
        let sig_json: Vec<serde_json::Value> = sig.iter().map(|(n, a)| serde_json::json!([n, a])).collect();
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_TURN.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({
                "turn": turn, "sig": sig_json, "end_reason_kind": null, "end_error_code": null,
                "end_seq": null, "end_time": null, "last_seq": seq + 1, "seq": seq,
                "entry_turn": turn, "step": null, "call_id": null,
            }),
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
        Sv612Detector.detect(&ctx).unwrap()
    }

    #[test]
    fn two_turns_with_identical_sig_trigger_once() {
        let events = vec![
            turn_event("t1", 0, 1, 1, &[("bash", "ls")]),
            turn_event("t2", 1, 2, 2, &[("bash", "ls")]),
        ];
        let findings = detect(&events);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].evidence[0].event_ids, vec![EventId::from("t1"), EventId::from("t2")]);
        assert_eq!(findings[0].attributes["run_end_seq"], serde_json::json!(3));
    }

    #[test]
    fn a_third_identical_turn_does_not_refire() {
        let events = vec![
            turn_event("t1", 0, 1, 1, &[("bash", "ls")]),
            turn_event("t2", 1, 2, 2, &[("bash", "ls")]),
            turn_event("t3", 2, 3, 3, &[("bash", "ls")]),
        ];
        assert_eq!(detect(&events).len(), 1);
    }

    #[test]
    fn different_sig_does_not_trigger() {
        let events = vec![
            turn_event("t1", 0, 1, 1, &[("bash", "ls")]),
            turn_event("t2", 1, 2, 2, &[("bash", "pwd")]),
        ];
        assert!(detect(&events).is_empty());
    }

    #[test]
    fn empty_sig_turns_are_transparent_to_the_comparison() {
        let events = vec![
            turn_event("t1", 0, 1, 1, &[("bash", "ls")]),
            turn_event("t2", 1, 2, 2, &[]), // 空 turn：跳过，不打断 run
            turn_event("t3", 2, 3, 3, &[("bash", "ls")]),
        ];
        // t1 与 t3 的 sig 相同，t2（空）被跳过——run_count 在 t3 处到 2，触发一次。
        let findings = detect(&events);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].evidence[0].event_ids, vec![EventId::from("t1"), EventId::from("t3")]);
    }

    #[test]
    fn a_new_identical_pair_after_a_break_fires_again() {
        let events = vec![
            turn_event("t1", 0, 1, 1, &[("bash", "ls")]),
            turn_event("t2", 1, 2, 2, &[("bash", "ls")]), // run #1: t1==t2 → fires
            turn_event("t3", 2, 3, 3, &[("bash", "pwd")]), // breaks the run
            turn_event("t4", 3, 4, 4, &[("bash", "pwd")]), // run #2: t3==t4 → fires again
        ];
        let findings = detect(&events);
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].evidence[0].event_ids, vec![EventId::from("t1"), EventId::from("t2")]);
        assert_eq!(findings[1].evidence[0].event_ids, vec![EventId::from("t3"), EventId::from("t4")]);
    }
}
