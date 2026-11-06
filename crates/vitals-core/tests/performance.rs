//! §17 performance baseline. Not a promise (the spec is explicit: "这些指标
//! 是回归基线，不作为对外性能承诺") — this is a smoke test against a very
//! generous upper bound (10x the spec's target latency) so a catastrophic
//! regression fails CI, plus printed numbers a human can copy into
//! `PERFORMANCE.md` when re-measuring on a specific machine.
//!
//! `cargo test -p vitals-core --test performance -- --nocapture` to see the
//! printed numbers; without `--nocapture` they're captured and discarded on
//! a pass, same as everywhere else in this workspace.

use std::time::Instant;

use vitals_core::coverage::Coverage;
use vitals_core::detector::{AuditContext, Detector, SignalRequirement};
use vitals_core::engine::{AuditInput, VitalsEngine};
use vitals_core::error::VitalsError;
use vitals_core::event::{CanonicalEvent, SourceRef};
use vitals_core::evidence::Evidence;
use vitals_core::finding::{FindingDraft, Severity};
use vitals_core::id::{ActorId, EventId};
use vitals_core::provenance::Provenance;
use vitals_core::signal::SignalId;

const ACTION_SIGNAL: &str = "generic.action";

/// Same shape as the README/example detector — realistic in that it does a
/// full linear scan and constructs real `FindingDraft`s, not a no-op stub
/// that would make the benchmark measure nothing but pipeline overhead.
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
        let mut last: Option<String> = None;
        // Extracted so it can also run once after the loop — an earlier
        // version of this file (and the README/example it was copied from)
        // only flushed inside the `else` branch, silently dropping a run
        // still in progress when the event stream ends. That undercounts
        // findings by up to one per benchmark run — not the kind of thing
        // you want quietly baked into a recorded performance baseline.
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
                    summary: String::new(),
                    attributes: serde_json::json!({}),
                });
            }
            run.clear();
        };
        for e in ctx.events {
            let action = e.attributes.get("action").and_then(|v| v.as_str()).map(str::to_string);
            if action.is_some() && action == last {
                run.push(e);
            } else {
                flush(&mut run, &mut findings);
                run.push(e);
                last = action;
            }
        }
        flush(&mut run, &mut findings);
        Ok(findings)
    }
}

/// Realistic-shaped input: a run of 1..4 identical actions, then a switch —
/// same statistical shape as the README fixture, scaled up. Not literally
/// realistic session data (there is none for a domain-free crate), but not
/// a degenerate all-identical or all-distinct stream either, which would
/// bias the detector's own loop cost in either direction.
fn synthetic_events(count: usize) -> Vec<CanonicalEvent> {
    let mut events = Vec::with_capacity(count);
    let actions = ["edit", "test", "commit", "review"];
    let mut ordinal = 0u64;
    let mut action_idx = 0usize;
    let mut run_len = 0usize;
    let mut run_target = 2usize;
    while events.len() < count {
        events.push(CanonicalEvent {
            schema_version: 1,
            id: EventId::from(format!("evt-{ordinal}")),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: ACTION_SIGNAL.to_string(),
            ordinal,
            occurred_at_ms: Some(1_000_000 + ordinal as i64),
            attributes: serde_json::json!({"action": actions[action_idx]}),
            outcome: None,
            source: SourceRef { source_type: "bench".to_string(), source_id: "session-1".to_string(), raw_reference: None, raw_ordinal: Some(ordinal) },
            provenance: Provenance::Measured,
        });
        ordinal += 1;
        run_len += 1;
        if run_len >= run_target {
            run_len = 0;
            action_idx = (action_idx + 1) % actions.len();
            run_target = 2 + (ordinal as usize % 3);
        }
    }
    events
}

fn run_audit(count: usize) -> (std::time::Duration, usize) {
    let events = synthetic_events(count);
    let mut engine = VitalsEngine::builder()
        .with_detector(RepeatedActionDetector)
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let start = Instant::now();
    let report = engine.audit(AuditInput { events, coverage: Coverage::new(), config: serde_json::json!({}) }).unwrap();
    let elapsed = start.elapsed();
    (elapsed, report.findings.len())
}

#[test]
fn ten_thousand_events_complete_well_within_ten_times_the_spec_target() {
    let (elapsed, findings) = run_audit(10_000);
    println!("10,000 events: {elapsed:?}, {findings} findings");
    // §17 target: <100ms. 10x margin absorbs slow CI/dev-machine variance
    // without the test being a real performance promise (spec is explicit
    // these are baselines, not commitments).
    assert!(elapsed.as_millis() < 1_000, "10k events took {elapsed:?}, more than 10x the §17 target of 100ms");
}

#[test]
fn one_hundred_thousand_events_complete_well_within_ten_times_the_spec_target() {
    let (elapsed, findings) = run_audit(100_000);
    println!("100,000 events: {elapsed:?}, {findings} findings");
    // §17 target: <1s.
    assert!(elapsed.as_secs() < 10, "100k events took {elapsed:?}, more than 10x the §17 target of 1s");
}

#[test]
fn one_thousand_events_baseline_for_comparison() {
    let (elapsed, findings) = run_audit(1_000);
    println!("1,000 events: {elapsed:?}, {findings} findings");
}
