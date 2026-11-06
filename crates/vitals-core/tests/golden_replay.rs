//! §16.3 Golden Replay Fixtures — domain-free JSON fixtures under
//! `tests/fixtures/`, loaded and run through the real pipeline. Each fixture
//! demonstrates exactly one mechanism from the spec; the assertions pin that
//! mechanism, not an incidental byte-for-byte snapshot of the whole report
//! (a literal `ReplayReport` JSON blob would be unreadable to maintain by
//! hand and wouldn't teach a new reader anything the assertions don't
//! already say more directly).
//!
//! This file is also the M4 acceptance check from
//! `docs/VITALS_CORE_V0_5_IMPLEMENTATION_SPEC.md` §19: "新开发者仅阅读
//! README 即可实现一个自定义 Detector，并用 fixture 得到 ReplayReport" — the
//! `RepeatedActionDetector` below is intentionally the same shape as the one
//! in the crate README's 30-second example, run against a real fixture file
//! instead of an inline `Vec`.

use std::fs;
use std::path::Path;

use vitals_core::coverage::Coverage;
use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::engine::{AuditInput, VitalsEngine};
use vitals_core::error::VitalsError;
use vitals_core::event::CanonicalEvent;
use vitals_core::evidence::Evidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::signal::SignalId;

const ACTION_SIGNAL: &str = "generic.action";
const FEEDBACK_SIGNAL: &str = "generic.feedback";

fn load_fixture(name: &str) -> Vec<CanonicalEvent> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse fixture {}: {e}", path.display()))
}

/// Flags 3+ consecutive events sharing the same `attributes.action` — the
/// same shape as the crate README's example detector, kept in lockstep by
/// eye (both are short enough that drift would be obvious in review).
struct RepeatedActionDetector;

impl Detector for RepeatedActionDetector {
    fn id(&self) -> &str {
        "repeated_action"
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
        let flush = |run: &mut Vec<&CanonicalEvent>, findings: &mut Vec<FindingDraft>| {
            if run.len() >= 3 {
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
                    attributes: serde_json::json!({}),
                });
            }
            run.clear();
        };
        for e in ctx.events {
            let action = e.attributes.get("action").and_then(|v| v.as_str()).map(str::to_string);
            if action.is_some() && action == last_action {
                run.push(e);
            } else {
                flush(&mut run, &mut findings);
                run.push(e);
                last_action = action;
            }
        }
        flush(&mut run, &mut findings);
        Ok(findings)
    }
}

/// Requires a signal (`generic.feedback`) this fixture set never registers a
/// `kind` for — demonstrating the Unavailable branch of §4.3's three states.
struct RequiresFeedbackDetector;

impl Detector for RequiresFeedbackDetector {
    fn id(&self) -> &str {
        "requires_feedback"
    }
    fn version(&self) -> &str {
        "1"
    }
    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(FEEDBACK_SIGNAL)])
    }
    fn detect(&self, _ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        panic!("gate should have kept this detector from ever running");
    }
}

fn engine_with_repeated_action() -> VitalsEngine {
    VitalsEngine::builder()
        .with_detector(RepeatedActionDetector)
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .unwrap()
        .build()
        .unwrap()
}

#[test]
fn repetition_json_finds_the_three_run_and_gets_a_replay_report() {
    let events = load_fixture("repetition.json");
    let mut engine = engine_with_repeated_action();
    let report = engine.audit(AuditInput { events, coverage: Coverage::new(), config: serde_json::json!({}) }).unwrap();

    assert_eq!(report.findings.len(), 1, "3 consecutive `edit` actions, then a `commit` — exactly one repetition finding");
    assert_eq!(report.findings[0].evidence[0].event_ids.len(), 3);
    // §16.3 acceptance: a fixture produces a real ReplayReport, not just an AuditReport.
    assert_eq!(report.replay.frames.len(), 4, "one frame per input event");
    assert!(report.replay.frames.iter().any(|f| !f.findings_opened.is_empty()), "the finding must anchor to some frame");
}

#[test]
fn alternating_sequence_json_never_repeats_so_no_finding_fires() {
    let events = load_fixture("alternating_sequence.json");
    let mut engine = engine_with_repeated_action();
    let report = engine.audit(AuditInput { events, coverage: Coverage::new(), config: serde_json::json!({}) }).unwrap();

    assert!(report.findings.is_empty(), "edit/test/edit/test never has 3 consecutive identical actions");
    assert_eq!(report.outcomes[0].outcome, vitals_core::detector::RuleOutcome::MeasuredZero, "evidence existed, detector ran, zero hits — MeasuredZero, not Unavailable");
}

#[test]
fn missing_feedback_json_reports_unavailable_not_a_fabricated_zero() {
    // §4.3: a signal this session's fixture never carries any evidence for
    // must report Unavailable, never be silently treated as "measured, zero
    // hits" — those are different facts and must not be conflated.
    let events = load_fixture("missing_feedback.json");
    let engine = VitalsEngine::builder()
        .with_detector(RequiresFeedbackDetector)
        .with_signal(SignalId::from(FEEDBACK_SIGNAL), vec![FEEDBACK_SIGNAL.to_string()])
        .unwrap()
        .build();
    let mut engine = engine.unwrap();
    let report = engine.audit(AuditInput { events, coverage: Coverage::new(), config: serde_json::json!({}) }).unwrap();

    assert!(report.findings.is_empty());
    assert!(matches!(report.outcomes[0].outcome, vitals_core::detector::RuleOutcome::Unavailable { .. }), "no generic.feedback evidence in this session at all — Unavailable, not MeasuredZero");
}

#[test]
fn duplicate_event_json_is_a_diagnostic_not_a_hard_error() {
    // §6.4: the same EventId appearing twice with identical content is
    // deduplicated with a diagnostic, not rejected — this fixture's third
    // event is byte-identical to its first.
    let events = load_fixture("duplicate_event.json");
    let mut engine = engine_with_repeated_action();
    let report = engine.audit(AuditInput { events, coverage: Coverage::new(), config: serde_json::json!({}) }).unwrap();

    assert!(report.diagnostics.iter().any(|d| d.code == "DUPLICATE_EVENT_IGNORED"));
    assert_eq!(report.replay.frames.len(), 2, "the duplicate collapses back to 2 distinct events");
}

#[test]
fn unavailable_signal_json_gates_a_detector_whose_signal_was_never_registered_as_a_kind() {
    // Same mechanism as missing_feedback.json, named for the infrastructure
    // reading rather than the domain reading — §16.3 lists both names
    // because a reader searching by symptom ("my detector never runs") and
    // a reader searching by domain concept ("no feedback happened") land on
    // different fixtures for what turns out to be the same underlying gate.
    let events = load_fixture("unavailable_signal.json");
    let engine = VitalsEngine::builder()
        .with_detector(RequiresFeedbackDetector)
        .with_signal(SignalId::from(FEEDBACK_SIGNAL), vec![FEEDBACK_SIGNAL.to_string()])
        .unwrap()
        .build();
    let mut engine = engine.unwrap();
    let report = engine.audit(AuditInput { events, coverage: Coverage::new(), config: serde_json::json!({}) }).unwrap();

    assert!(matches!(report.outcomes[0].outcome, vitals_core::detector::RuleOutcome::Unavailable { .. }));
}

#[test]
fn same_fixture_run_twice_yields_identical_input_fingerprint() {
    // §17: determinism baseline, exercised directly against a fixture file
    // rather than an inline Vec — the whole point of committing these files
    // is that they don't change between runs, so the fingerprint shouldn't
    // either.
    let mut fingerprints = Vec::new();
    for _ in 0..3 {
        let events = load_fixture("repetition.json");
        let mut engine = engine_with_repeated_action();
        let report = engine.audit(AuditInput { events, coverage: Coverage::new(), config: serde_json::json!({}) }).unwrap();
        fingerprints.push(report.input_fingerprint);
    }
    assert!(fingerprints.windows(2).all(|w| w[0] == w[1]));
}
