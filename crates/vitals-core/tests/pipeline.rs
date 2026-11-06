//! §16.1/§16.3 通用（domain-free）Engine pipeline 测试。夹具不用 Agent 术
//! 语——`generic.action` 是唯一的信号/kind 名字，验证的是 §12.3 的管线本
//! 身，不是任何领域规则。

use vitals_core::coverage::Coverage;
use vitals_core::detector::{AuditContext, Detector, RuleOutcome, SignalRequirement};
use vitals_core::engine::{AuditInput, VitalsEngine};
use vitals_core::error::VitalsError;
use vitals_core::event::{CanonicalEvent, SourceRef};
use vitals_core::evidence::Evidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::id::{ActorId, EventId, GoalId};
use vitals_core::provenance::Provenance;
use vitals_core::signal::SignalId;

const ACTION_SIGNAL: &str = "generic.action";

fn event(id: &str, ordinal: u64, action: &str) -> CanonicalEvent {
    CanonicalEvent {
        schema_version: 1,
        id: EventId::from(id),
        actor_id: ActorId::from("actor-1"),
        goal_id: None::<GoalId>,
        kind: ACTION_SIGNAL.to_string(),
        ordinal,
        occurred_at_ms: Some(1000 + ordinal as i64),
        attributes: serde_json::json!({"action": action}),
        outcome: None,
        source: SourceRef {
            source_type: "generic_log".to_string(),
            source_id: "session-1".to_string(),
            raw_reference: None,
            raw_ordinal: Some(ordinal),
        },
        provenance: Provenance::Measured,
    }
}

/// 连续 `min_repeats` 个相同 `action` 判成一条 Finding——`repetition.json`
/// 场景（§16.3）的最小可运行实现，纯粹用来验证管线，不代表任何真实领域。
struct RepetitionDetector {
    min_repeats: usize,
}

impl Detector for RepetitionDetector {
    fn id(&self) -> &str {
        "repetition"
    }
    fn version(&self) -> &str {
        "1"
    }
    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(ACTION_SIGNAL)])
    }
    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let mut findings = Vec::new();
        let mut run: Vec<&CanonicalEvent> = Vec::new();
        let mut last_action: Option<String> = None;
        let flush = |run: &mut Vec<&CanonicalEvent>, findings: &mut Vec<FindingDraft>, min_repeats: usize| {
            if run.len() >= min_repeats {
                findings.push(FindingDraft {
                    kind: "repetition".to_string(),
                    severity: Severity::Warning,
                    confidence: None,
                    evidence: vec![Evidence {
                        event_ids: run.iter().map(|e| e.id.clone()).collect(),
                        description: format!("{} consecutive identical actions", run.len()),
                        source_refs: vec![run[0].source.clone()],
                        attributes: serde_json::json!({}),
                    }],
                    summary: "repeated action with no observed change".to_string(),
                    attributes: serde_json::json!({"run_length": run.len()}),
                });
            }
            run.clear();
        };
        for e in ctx.events {
            let action = e.attributes.get("action").and_then(|v| v.as_str()).map(|s| s.to_string());
            if action.is_some() && action == last_action {
                run.push(e);
            } else {
                flush(&mut run, &mut findings, self.min_repeats);
                run.push(e);
                last_action = action;
            }
        }
        flush(&mut run, &mut findings, self.min_repeats);
        Ok(findings)
    }
}

/// 证据齐全但故意零命中——用来验证 `MeasuredZero`。
struct NeverFiresDetector;

impl Detector for NeverFiresDetector {
    fn id(&self) -> &str {
        "never_fires"
    }
    fn version(&self) -> &str {
        "1"
    }
    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(ACTION_SIGNAL)])
    }
    fn detect(&self, _ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        Ok(Vec::new())
    }
}

/// requirement 指向一个从未注册过 kind 的信号——用来验证 `Unavailable`。
struct NeedsMissingSignalDetector;

impl Detector for NeedsMissingSignalDetector {
    fn id(&self) -> &str {
        "needs_missing_signal"
    }
    fn version(&self) -> &str {
        "1"
    }
    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from("generic.unseen")])
    }
    fn detect(&self, _ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        panic!("gate should have kept this from ever running");
    }
}

/// 故意返回一个没有 Evidence 的 Finding——用来验证 §10.1 的硬拒绝。
struct NoEvidenceDetector;

impl Detector for NoEvidenceDetector {
    fn id(&self) -> &str {
        "no_evidence"
    }
    fn version(&self) -> &str {
        "1"
    }
    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(ACTION_SIGNAL)])
    }
    fn detect(&self, _ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        Ok(vec![FindingDraft {
            kind: "broken".to_string(),
            severity: Severity::Info,
            confidence: None,
            evidence: vec![],
            summary: "no evidence".to_string(),
            attributes: serde_json::json!({}),
        }])
    }
}

/// 同一 trajectory 上重复发出两份内容完全相同的 draft——用来验证报告内去重
/// （§10.3）。
struct DuplicateEmitterDetector;

impl Detector for DuplicateEmitterDetector {
    fn id(&self) -> &str {
        "duplicate_emitter"
    }
    fn version(&self) -> &str {
        "1"
    }
    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(ACTION_SIGNAL)])
    }
    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let draft = FindingDraft {
            kind: "duplicate_probe".to_string(),
            severity: Severity::Info,
            confidence: None,
            evidence: vec![Evidence {
                event_ids: vec![ctx.events[0].id.clone()],
                description: String::new(),
                source_refs: vec![],
                attributes: serde_json::json!({}),
            }],
            summary: "same finding reported twice".to_string(),
            attributes: serde_json::json!({}),
        };
        Ok(vec![draft.clone(), draft])
    }
}

fn engine_with_repetition(min_repeats: usize) -> VitalsEngine {
    VitalsEngine::builder()
        .with_detector(RepetitionDetector { min_repeats })
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .unwrap()
        .build()
        .unwrap()
}

fn events_with_three_repeats() -> Vec<CanonicalEvent> {
    vec![
        event("e1", 1, "edit"),
        event("e2", 2, "edit"),
        event("e3", 3, "edit"),
        event("e4", 4, "commit"),
    ]
}

#[test]
fn repeated_action_produces_a_finding_with_the_expected_evidence() {
    let mut engine = engine_with_repetition(3);
    let report = engine
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap();

    assert_eq!(report.findings.len(), 1);
    let finding = &report.findings[0];
    assert_eq!(finding.kind, "repetition");
    assert_eq!(finding.evidence[0].event_ids, vec![EventId::from("e1"), EventId::from("e2"), EventId::from("e3")]);
}

#[test]
fn same_input_in_any_ingest_order_produces_the_same_report() {
    // §16.2 property 1：只要 ordinal 不变，打乱输入顺序不改变结果——包括
    // input_fingerprint（因为它是从排好序的事件重算的，不是从原始顺序）。
    let forward = events_with_three_repeats();
    let mut shuffled = forward.clone();
    shuffled.reverse();

    let mut engine_a = engine_with_repetition(3);
    let report_a = engine_a.audit(AuditInput { events: forward, coverage: Coverage::new(), config: serde_json::json!({}) }).unwrap();

    let mut engine_b = engine_with_repetition(3);
    let report_b = engine_b.audit(AuditInput { events: shuffled, coverage: Coverage::new(), config: serde_json::json!({}) }).unwrap();

    assert_eq!(report_a.findings, report_b.findings);
    assert_eq!(report_a.input_fingerprint, report_b.input_fingerprint);
    assert_eq!(report_a.replay.frames.iter().map(|f| f.event_id.clone()).collect::<Vec<_>>(),
               report_b.replay.frames.iter().map(|f| f.event_id.clone()).collect::<Vec<_>>());
}

#[test]
fn same_input_run_repeatedly_yields_identical_fingerprint() {
    // §17："相同数据运行 20 次，report fingerprint 完全一致" —— 用几次代表
    // 这条性质，不是真的跑 20 次拖慢 CI。
    let mut fingerprints = Vec::new();
    for _ in 0..5 {
        let mut engine = engine_with_repetition(3);
        let report = engine
            .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
            .unwrap();
        fingerprints.push(report.input_fingerprint);
    }
    assert!(fingerprints.windows(2).all(|w| w[0] == w[1]));
}

#[test]
fn identical_duplicate_event_is_a_diagnostic_not_an_error() {
    let mut events = events_with_three_repeats();
    events.push(event("e1", 1, "edit")); // 与已有 e1 完全相同
    let mut engine = engine_with_repetition(3);
    let report = engine.audit(AuditInput { events, coverage: Coverage::new(), config: serde_json::json!({}) }).unwrap();

    assert!(report.diagnostics.iter().any(|d| d.code == "DUPLICATE_EVENT_IGNORED"));
    // 去重之后事件数不变，找到的 Finding 也不因为多了一份重复输入而改变。
    assert_eq!(report.findings.len(), 1);
}

#[test]
fn conflicting_duplicate_event_id_is_a_hard_error() {
    let mut events = events_with_three_repeats();
    let mut conflicting = event("e1", 1, "different-action");
    conflicting.attributes = serde_json::json!({"action": "different-action"});
    events.push(conflicting);
    let mut engine = engine_with_repetition(3);
    let err = engine
        .audit(AuditInput { events, coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap_err();
    assert!(matches!(err, VitalsError::ConflictingDuplicate { .. }));
}

#[test]
fn gate_reports_unavailable_when_no_consumable_evidence_for_a_required_signal() {
    let engine = VitalsEngine::builder()
        .with_detector(NeedsMissingSignalDetector)
        .with_signal(SignalId::from("generic.unseen"), Vec::new()) // 注册过、但没有任何 kind 能满足它
        .unwrap()
        .build();
    let mut engine = engine.unwrap();
    let report = engine
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap();

    assert_eq!(report.outcomes.len(), 1);
    assert!(matches!(report.outcomes[0].outcome, RuleOutcome::Unavailable { .. }));
    // Detector::detect 从未被调用（它会 panic）——能跑到这里说明门控确实拦住了。
}

#[test]
fn gate_reports_measured_zero_when_evidence_exists_but_detector_finds_nothing() {
    let engine = VitalsEngine::builder()
        .with_detector(NeverFiresDetector)
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .unwrap()
        .build();
    let mut engine = engine.unwrap();
    let report = engine
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap();

    assert_eq!(report.outcomes.len(), 1);
    assert!(matches!(report.outcomes[0].outcome, RuleOutcome::MeasuredZero));
}

#[test]
fn coverage_counts_nonzero_does_not_leak_into_the_gate() {
    // §7.4.1 的核心回归：即便调用方提供的 Coverage 显示非零 measured，门控
    // 仍然只看"这个信号有没有 kind 映射能消费到的事件"——这里故意让
    // Coverage 撒谎（说 generic.unseen 有 10 条 measured），门控必须无视它。
    use vitals_core::coverage::CoverageCounts;
    let mut coverage = Coverage::new();
    coverage.set(SignalId::from("generic.unseen"), CoverageCounts { measured: 10, derived: 0, lossy: 0, unmetered: 0 });

    let mut engine = VitalsEngine::builder()
        .with_detector(NeedsMissingSignalDetector)
        .with_signal(SignalId::from("generic.unseen"), Vec::new())
        .unwrap()
        .build()
        .unwrap();
    let report = engine.audit(AuditInput { events: events_with_three_repeats(), coverage, config: serde_json::json!({}) }).unwrap();

    assert!(matches!(report.outcomes[0].outcome, RuleOutcome::Unavailable { .. }));
}

#[test]
fn finding_without_evidence_is_rejected() {
    let mut engine = VitalsEngine::builder()
        .with_detector(NoEvidenceDetector)
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let err = engine
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap_err();
    assert!(matches!(err, VitalsError::InvalidFinding { .. }));
}

#[test]
fn identical_findings_from_one_detector_are_deduplicated_within_a_report() {
    let mut engine = VitalsEngine::builder()
        .with_detector(DuplicateEmitterDetector)
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let report = engine
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap();

    assert_eq!(report.findings.len(), 1);
    assert!(report.diagnostics.iter().any(|d| d.code == "FINDING_DEDUPLICATED"));
}

#[test]
fn build_rejects_a_detector_requiring_an_unregistered_signal() {
    // `VitalsEngine` (the `Ok` side) intentionally doesn't derive `Debug` —
    // it holds `Box<dyn Detector>` trait objects — so assert on the `Err`
    // shape directly instead of `unwrap_err()`.
    let result = VitalsEngine::builder().with_detector(NeedsMissingSignalDetector).build();
    assert!(matches!(result, Err(VitalsError::UnknownSignal { .. })));
}

#[test]
fn build_rejects_duplicate_detector_ids() {
    let result = VitalsEngine::builder()
        .with_detector(NeverFiresDetector)
        .with_detector(NeverFiresDetector)
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .unwrap()
        .build();
    assert!(matches!(result, Err(VitalsError::DuplicateDetector { .. })));
}

#[test]
fn replay_frame_opens_the_finding_at_its_last_evidence_event() {
    let mut engine = engine_with_repetition(3);
    let report = engine
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap();

    let finding_id = report.findings[0].id.clone();
    let anchor_frame = report.replay.frames.iter().find(|f| f.findings_opened.contains(&finding_id));
    assert!(anchor_frame.is_some());
    // 锚点是 evidence 里 ordinal 最大的那个事件（e3，见 events_with_three_repeats）。
    assert_eq!(anchor_frame.unwrap().event_id, EventId::from("e3"));
}

#[test]
fn replay_frames_are_one_per_event_in_ordinal_order() {
    let mut engine = engine_with_repetition(3);
    let report = engine
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap();
    let ids: Vec<EventId> = report.replay.frames.iter().map(|f| f.event_id.clone()).collect();
    assert_eq!(ids, vec![EventId::from("e1"), EventId::from("e2"), EventId::from("e3"), EventId::from("e4")]);
}

#[test]
fn config_change_produces_a_different_input_fingerprint() {
    let mut engine_a = engine_with_repetition(3);
    let report_a = engine_a
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({"threshold": 3}) })
        .unwrap();
    let mut engine_b = engine_with_repetition(3);
    let report_b = engine_b
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({"threshold": 5}) })
        .unwrap();
    assert_ne!(report_a.input_fingerprint.config_hash, report_b.input_fingerprint.config_hash);
    assert_eq!(report_a.input_fingerprint.events_hash, report_b.input_fingerprint.events_hash);
}

#[test]
fn changing_detector_registration_order_changes_the_fingerprint() {
    // §62/§11.2：注册顺序决定 `FindingId` 怎么分配（第一个跑的 detector 拿
    // `finding-1`），报告内容会因为顺序不同而不同——指纹必须能感知到，否则
    // "同一个指纹 ⟹ 同一份报告"这条承诺是假的。这里两个 Engine 用同一组
    // Detector，只是注册顺序反过来。
    let mut engine_ab = VitalsEngine::builder()
        .with_detector(RepetitionDetector { min_repeats: 3 })
        .with_detector(NeverFiresDetector)
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let mut engine_ba = VitalsEngine::builder()
        .with_detector(NeverFiresDetector)
        .with_detector(RepetitionDetector { min_repeats: 3 })
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .unwrap()
        .build()
        .unwrap();

    let report_ab = engine_ab
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap();
    let report_ba = engine_ba
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap();

    assert_ne!(
        report_ab.input_fingerprint.detector_versions_hash, report_ba.input_fingerprint.detector_versions_hash,
        "registration order differs, fingerprint must differ too"
    );
}

#[test]
fn changing_the_trajectory_assigner_changes_the_fingerprint() {
    let mut engine_default = engine_with_repetition(3); // BySourceSession
    let mut engine_by_actor = VitalsEngine::builder()
        .with_assigner(vitals_core::trajectory::ByActor)
        .with_detector(RepetitionDetector { min_repeats: 3 })
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .unwrap()
        .build()
        .unwrap();

    let report_default = engine_default
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap();
    let report_by_actor = engine_by_actor
        .audit(AuditInput { events: events_with_three_repeats(), coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap();

    assert_ne!(report_default.input_fingerprint.assigner_id, report_by_actor.input_fingerprint.assigner_id);
}

#[test]
fn two_actors_colliding_on_the_same_trajectory_id_is_a_hard_error_not_a_silent_merge() {
    // `BySourceSession`（Engine 默认用它）只按 source_type+source_id 分组，
    // 不看 actor_id——两个不同 Actor 的事件如果落到同一个来源标识（跨来源
    // 合并审计时完全可能：两个不同 session 的适配器都恰好把 source_id 记
    // 成 "session-1"），不能被静默并成一条 Trajectory、让报告冒充成"这是
    // Actor A 的连续行为"。这里手工构造这个碰撞：两个事件 source 完全相
    // 同，但 actor_id 不同。
    let mut engine = engine_with_repetition(3);
    let mut event_a = event("e1", 0, "edit");
    event_a.actor_id = ActorId::from("actor-A");
    let mut event_b = event("e2", 1, "edit");
    event_b.actor_id = ActorId::from("actor-B"); // 同一 source，不同 actor

    let result = engine.audit(AuditInput { events: vec![event_a, event_b], coverage: Coverage::new(), config: serde_json::json!({}) });
    assert!(matches!(result, Err(VitalsError::InvalidTrajectory { .. })), "expected a hard error, got {result:?}");
}

#[test]
fn a_failed_audit_call_does_not_leak_events_into_the_engines_next_call() {
    // §4.6：`audit()` 承诺"这批要么整批生效、要么这次调用像没发生过"。第一
    // 版实现里，批中间某条事件校验失败时，`ingest()` 已经把它之前的所有事
    // 件 push 进了 `buffered_events`，`audit()` 的失败路径直接 `?` 返回、不
    // 清理——那些事件会一直留在引擎里，污染这个引擎实例下一次调用（不管是
    // 另一次 `audit()` 还是独立的 `ingest`/`finalize` 序列）的结果。
    let mut engine = engine_with_repetition(3);

    let mut bad_batch = events_with_three_repeats(); // e1..e4，合法
    let mut invalid = event("bad", 99, "whatever");
    invalid.id = EventId::from(""); // 空 id：validate() 必然拒绝
    bad_batch.push(invalid);

    let err = engine.audit(AuditInput { events: bad_batch, coverage: Coverage::new(), config: serde_json::json!({}) });
    assert!(err.is_err(), "sanity: the batch must actually fail");

    // 同一个引擎实例，干净的下一次调用——报告不该含有上一次失败批次里
    // e1..e4 的痕迹（它们不属于这次输入）。
    let clean_events = vec![event("z1", 1, "solo")];
    let report = engine
        .audit(AuditInput { events: clean_events, coverage: Coverage::new(), config: serde_json::json!({}) })
        .unwrap();
    let ids: Vec<EventId> = report.replay.frames.iter().map(|f| f.event_id.clone()).collect();
    assert_eq!(ids, vec![EventId::from("z1")], "leftover events from the failed audit() call leaked into this one: {ids:?}");
}
