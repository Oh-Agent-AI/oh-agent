//! §14.4 第四批迁移规则：SV613（进度停滞）。判定逻辑与
//! `trajectory.rs::detect_sv613` **完全相同**：两个独立的子判定，各自跑
//! run、在中断或流结束时冲刷,报 run 的真实总长度（不是阈值倍数）：
//!   (a) 连续 `agent.turn` 事件以 `end_reason_kind == "error"` 结束——LLM 级停滞；
//!   (b) 连续 `agent.tool_result` 事件带 `error_code`——工具级停滞。
//!
//! # 第一条 `Any` requirement
//!
//! 旧模型里 SV613 的 `requires` 是"至少一个信号有证据"（OR）,不是"全部都
//! 要"（AND）——两个子判定读不同信号,任一有证据规则就不是完全测不了
//! （`trajectory.rs::OR_REQUIRES_CODES`）。这在 §7.4 的
//! `SignalRequirement::Any` 上是直接映射,M1 建 Engine 时就实现好了、也有
//! 门控测试覆盖（`gate_reports_measured_zero_when_evidence_exists_but_
//! detector_finds_nothing` 等）——这是它第一次接一条真实规则,不是新工作。

use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::error::VitalsError;
use vitals_core::event::{CanonicalEvent, SourceRef as VitalsSourceRef};
use vitals_core::evidence::Evidence as VitalsEvidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::signal::SignalId;

use crate::behavior::normalize;
use crate::compatibility::canonical_session::{KIND_TOOL_RESULT, KIND_TURN, SIGNAL_TOOL_RESULTS, SIGNAL_TURN_BOUNDARIES};

/// 与 `trajectory.rs::MIN_ERROR_TURNS` 相同。
const MIN_ERROR_TURNS: usize = 2;
/// 与 `trajectory.rs::MIN_FAILED_RESULTS` 相同。
const MIN_FAILED_RESULTS: usize = 3;

fn attr(v: &serde_json::Value, key: &str) -> serde_json::Value {
    v.get(key).cloned().unwrap_or(serde_json::Value::Null)
}

fn opt_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// 与 `trajectory.rs::finding()` 同一处 lint 豁免——两个独立子判定共用一
/// 份"拼出 12 键 legacy attributes"的样板，拆参数对象反而让调用点更难读。
#[allow(clippy::too_many_arguments)]
fn draft(
    kind: &str,
    evidence_text: &str,
    seq: serde_json::Value,
    time: serde_json::Value,
    turn: serde_json::Value,
    step: serde_json::Value,
    call_id: serde_json::Value,
    run_end_seq: serde_json::Value,
    event_ids: Vec<vitals_core::id::EventId>,
    source: &VitalsSourceRef,
) -> FindingDraft {
    FindingDraft {
        kind: kind.to_string(),
        severity: Severity::Warning,
        confidence: None,
        evidence: vec![VitalsEvidence {
            event_ids,
            description: evidence_text.to_string(),
            source_refs: vec![source.clone()],
            attributes: serde_json::json!({}),
        }],
        summary: "the trajectory stalled with no forward progress".to_string(),
        attributes: serde_json::json!({
            "rule": "SV613",
            "severity": "warning",
            "category": "trajectory",
            "tool_name": serde_json::Value::Null,
            "evidence": normalize(evidence_text),
            "seq": seq,
            "time": time,
            "turn": turn,
            "step": step,
            "call_id": call_id,
            "evidence_recency": "log",
            "run_end_seq": run_end_seq,
        }),
    }
}

pub struct Sv613Detector;

impl Detector for Sv613Detector {
    fn id(&self) -> &str {
        "sv613"
    }

    fn version(&self) -> &str {
        "1"
    }

    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::Any(vec![SignalId::from(SIGNAL_TURN_BOUNDARIES), SignalId::from(SIGNAL_TOOL_RESULTS)])
    }

    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let mut out = Vec::new();

        // (a) 连续 error turn。只把有 `end_seq`（即有 turn/end）的 turn 算进
        // 序列——没有 turn/end 的 turn 既不断 run 也不续 run，直接跳过。
        let mut err_run: usize = 0;
        let mut err_anchor: Option<&CanonicalEvent> = None;
        let mut err_last_event: Option<&CanonicalEvent> = None;
        let mut err_last_seq = serde_json::Value::Null;
        let flush_error = |out: &mut Vec<FindingDraft>, run: &mut usize, anchor: &mut Option<&CanonicalEvent>, last_event: &mut Option<&CanonicalEvent>, last_seq: &mut serde_json::Value| {
            if *run >= MIN_ERROR_TURNS {
                if let Some(a) = anchor {
                    let code = opt_str(&a.attributes, "end_error_code").unwrap_or_default();
                    let suffix = if code.is_empty() { String::new() } else { format!("（{code}）") };
                    let evidence_text = format!("进度停滞: 连续 {run} 个 turn 以 error 结束{suffix}");
                    let mut event_ids = vec![a.id.clone()];
                    if let Some(last) = last_event {
                        event_ids.push(last.id.clone());
                    }
                    event_ids.sort();
                    event_ids.dedup();
                    out.push(draft(
                        "trajectory.progress_stall_error_turns",
                        &evidence_text,
                        attr(&a.attributes, "end_seq"),
                        attr(&a.attributes, "end_time"),
                        attr(&a.attributes, "entry_turn"),
                        attr(&a.attributes, "step"),
                        attr(&a.attributes, "call_id"),
                        last_seq.clone(),
                        event_ids,
                        &a.source,
                    ));
                }
            }
            *run = 0;
            *anchor = None;
            *last_event = None;
            *last_seq = serde_json::Value::Null;
        };
        for event in ctx.events {
            if event.kind != KIND_TURN {
                continue;
            }
            let end_seq = event.attributes.get("end_seq").cloned().unwrap_or(serde_json::Value::Null);
            if end_seq.is_null() {
                continue;
            }
            let end_reason_kind = opt_str(&event.attributes, "end_reason_kind");
            if end_reason_kind.as_deref() == Some("error") {
                if err_run == 0 {
                    err_anchor = Some(event);
                }
                err_run += 1;
                err_last_event = Some(event);
                err_last_seq = end_seq;
            } else {
                flush_error(&mut out, &mut err_run, &mut err_anchor, &mut err_last_event, &mut err_last_seq);
            }
        }
        flush_error(&mut out, &mut err_run, &mut err_anchor, &mut err_last_event, &mut err_last_seq);

        // (b) 连续 tool/result 失败。
        let mut fail_run: usize = 0;
        let mut fail_anchor: Option<&CanonicalEvent> = None;
        let mut fail_last_event: Option<&CanonicalEvent> = None;
        let flush_fail = |out: &mut Vec<FindingDraft>, run: &mut usize, anchor: &mut Option<&CanonicalEvent>, last_event: &mut Option<&CanonicalEvent>| {
            if *run >= MIN_FAILED_RESULTS {
                if let Some(a) = anchor {
                    let first_code = opt_str(&a.attributes, "error_code").unwrap_or_default();
                    let evidence_text = format!("进度停滞: 连续 {run} 个工具失败（首个 {first_code}）");
                    let mut event_ids = vec![a.id.clone()];
                    if let Some(last) = last_event {
                        event_ids.push(last.id.clone());
                    }
                    event_ids.sort();
                    event_ids.dedup();
                    let run_end_seq = last_event.map_or(serde_json::Value::Null, |e| attr(&e.attributes, "seq"));
                    out.push(draft(
                        "trajectory.progress_stall_tool_failures",
                        &evidence_text,
                        attr(&a.attributes, "seq"),
                        a.occurred_at_ms.map_or(serde_json::Value::Null, |t| serde_json::json!(t)),
                        attr(&a.attributes, "turn"),
                        attr(&a.attributes, "step"),
                        attr(&a.attributes, "call_id"),
                        run_end_seq,
                        event_ids,
                        &a.source,
                    ));
                }
            }
            *run = 0;
            *anchor = None;
            *last_event = None;
        };
        for event in ctx.events {
            if event.kind != KIND_TOOL_RESULT {
                continue;
            }
            // 失败判据 = 原因码（DSH/Codex）**或** lossy 失败标志（Claude：
            // is_error→failed，error_code 恒 None 时该标志是唯一失败证据）。
            // DSH/Codex 的 failed 恒 None，布尔式退化成原 error_code 判定，
            // golden 字节零漂移。
            let has_error = attr(&event.attributes, "failed").as_bool() == Some(true)
                || !attr(&event.attributes, "error_code").is_null();
            if has_error {
                if fail_run == 0 {
                    fail_anchor = Some(event);
                }
                fail_run += 1;
                fail_last_event = Some(event);
            } else {
                flush_fail(&mut out, &mut fail_run, &mut fail_anchor, &mut fail_last_event);
            }
        }
        flush_fail(&mut out, &mut fail_run, &mut fail_anchor, &mut fail_last_event);

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

    fn turn_end_event(id: &str, ordinal: u64, seq: i64, turn: i64, reason_kind: Option<&str>, error_code: Option<&str>) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_TURN.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({
                "turn": turn, "sig": [], "end_reason_kind": reason_kind, "end_error_code": error_code,
                "end_seq": seq, "end_time": 1000 + seq, "last_seq": seq, "seq": seq,
                "entry_turn": turn, "step": null, "call_id": null,
            }),
            outcome: None,
            source: VitalsSourceRef { source_type: "dsh_session".to_string(), source_id: "actor-1".to_string(), raw_reference: None, raw_ordinal: Some(ordinal) },
            provenance: Provenance::Measured,
        }
    }

    fn tool_result_event(id: &str, ordinal: u64, seq: i64, error_code: Option<&str>) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from(id),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: KIND_TOOL_RESULT.to_string(),
            ordinal,
            occurred_at_ms: Some(1000 + ordinal as i64),
            attributes: serde_json::json!({"error_code": error_code, "seq": seq, "turn": null, "step": null, "call_id": null}),
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
        Sv613Detector.detect(&ctx).unwrap()
    }

    #[test]
    fn two_consecutive_error_turns_trigger_once() {
        let events = vec![turn_end_event("t1", 0, 2, 1, Some("error"), Some("E1")), turn_end_event("t2", 1, 4, 2, Some("error"), Some("E2"))];
        let findings = detect(&events);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].attributes["seq"], serde_json::json!(2), "锚点是第一个 error turn/end 的 end_seq");
        assert_eq!(findings[0].attributes["run_end_seq"], serde_json::json!(4));
    }

    #[test]
    fn a_success_turn_breaks_the_error_run() {
        let events = vec![
            turn_end_event("t1", 0, 2, 1, Some("error"), Some("E1")),
            turn_end_event("t2", 1, 4, 2, Some("success"), None),
        ];
        assert!(detect(&events).is_empty());
    }

    #[test]
    fn three_consecutive_tool_failures_trigger_once_reporting_the_true_run_length() {
        let events = vec![
            tool_result_event("r1", 0, 1, Some("TOOL_TIMEOUT")),
            tool_result_event("r2", 1, 2, Some("TOOL_TIMEOUT")),
            tool_result_event("r3", 2, 3, Some("TOOL_TIMEOUT")),
        ];
        let findings = detect(&events);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].attributes["evidence"].as_str().unwrap().contains("连续 3 个工具失败"));
    }

    #[test]
    fn five_consecutive_failures_report_the_real_run_length_not_a_multiple_of_the_threshold() {
        let events: Vec<CanonicalEvent> = (0..5).map(|i| tool_result_event(&format!("r{i}"), i, i as i64 + 1, Some("E"))).collect();
        let findings = detect(&events);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].attributes["evidence"].as_str().unwrap().contains("连续 5 个工具失败"), "{:?}", findings[0].attributes["evidence"]);
    }

    #[test]
    fn a_successful_result_breaks_the_failure_run() {
        let events = vec![
            tool_result_event("r1", 0, 1, Some("TOOL_TIMEOUT")),
            tool_result_event("r2", 1, 2, Some("TOOL_TIMEOUT")),
            tool_result_event("r3", 2, 3, None),
            tool_result_event("r4", 3, 4, Some("TOOL_TIMEOUT")),
        ];
        assert!(detect(&events).is_empty());
    }

    #[test]
    fn both_sub_detectors_can_fire_independently_in_the_same_trajectory() {
        let mut events = vec![turn_end_event("t1", 0, 2, 1, Some("error"), Some("E1")), turn_end_event("t2", 1, 4, 2, Some("error"), Some("E2"))];
        events.extend((0..3).map(|i| tool_result_event(&format!("r{i}"), 2 + i, 10 + i as i64, Some("E"))));
        let findings = detect(&events);
        assert_eq!(findings.len(), 2);
    }
}
