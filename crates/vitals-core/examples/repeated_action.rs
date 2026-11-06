//! The 30-second example from `README.md` — kept as a real, compiled,
//! runnable example (not just a code block in prose) precisely so it can't
//! silently drift out of sync with the actual API. If you change this file,
//! copy the same change into the README's fenced code block; there is no
//! automated check that they stay identical (a doctest can't easily wrap a
//! full `fn main()` that needs `vitals_core` as an external crate path this
//! way), so treat divergence here as a review item, not a CI failure.
//!
//! Run with: `cargo run -p vitals-core --example repeated_action`

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

/// Flags 3+ consecutive events with the same `attributes.action`.
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
        // `flush` as its own closure — not inlined into the `else` branch —
        // specifically so it can also be called once *after* the loop ends.
        // The first version of this example only flushed inside the `else`
        // branch (when a *different* action interrupted the run), which
        // silently drops a run that's still going when the event stream
        // ends: three trailing identical actions with nothing after them
        // never got their finding. Real detectors over real streams end
        // mid-run constantly (the stream doesn't know to end on a
        // convenient boundary) — this bug would have under-reported.
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
            if action.is_some() && action == last {
                run.push(e);
            } else {
                flush(&mut run, &mut findings);
                run.push(e);
                last = action;
            }
        }
        flush(&mut run, &mut findings); // the run in progress when the stream ends still counts
        Ok(findings)
    }
}

fn event(id: &str, ordinal: u64, action: &str) -> CanonicalEvent {
    CanonicalEvent {
        schema_version: 1,
        id: EventId::from(id),
        actor_id: ActorId::from("actor-1"),
        goal_id: None,
        kind: ACTION_SIGNAL.to_string(),
        ordinal,
        occurred_at_ms: Some(1000 + ordinal as i64),
        attributes: serde_json::json!({"action": action}),
        outcome: None,
        source: SourceRef {
            source_type: "example".to_string(),
            source_id: "session-1".to_string(),
            raw_reference: None,
            raw_ordinal: Some(ordinal),
        },
        provenance: Provenance::Measured,
    }
}

fn main() {
    let events = vec![event("e1", 1, "edit"), event("e2", 2, "edit"), event("e3", 3, "edit"), event("e4", 4, "commit")];

    let mut engine = VitalsEngine::builder()
        .with_detector(RepeatedActionDetector)
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .expect("ACTION_SIGNAL is a well-formed, non-reserved signal id")
        .build()
        .expect("no duplicate detector ids, no unregistered signals");

    let report =
        engine.audit(AuditInput { events, coverage: Coverage::new(), config: serde_json::json!({}) }).expect("well-formed input");

    println!("{} finding(s)", report.findings.len());
    println!("{} replay frame(s)", report.replay.frames.len());
    assert_eq!(report.findings.len(), 1, "expected exactly one repetition finding");
    assert_eq!(report.replay.frames.len(), 4, "one frame per input event");

    // The case that would have been silently dropped without the final
    // `flush()` call above: the stream ends *while still mid-run*, with no
    // trailing different action to trigger the old else-branch-only flush.
    let mid_run_events = vec![event("e1", 1, "edit"), event("e2", 2, "edit"), event("e3", 3, "edit")];
    let mut engine2 = VitalsEngine::builder()
        .with_detector(RepeatedActionDetector)
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .unwrap()
        .build()
        .unwrap();
    let report2 =
        engine2.audit(AuditInput { events: mid_run_events, coverage: Coverage::new(), config: serde_json::json!({}) }).unwrap();
    assert_eq!(report2.findings.len(), 1, "a run still in progress when the stream ends must still be reported");
}
