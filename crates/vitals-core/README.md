# vitals-core

Harness-agnostic behavioral audit runtime. Turns a stream of `CanonicalEvent`s
into `Trajectory` + `Coverage`-gated `Detector` findings + a deterministic
`ReplayReport` — without knowing anything about Agents, tool calls, Codex,
DSH, or any other domain. See
`docs/VITALS_CORE_V0_5_IMPLEMENTATION_SPEC.md` in the repo root for the full
design; this README is the 30-second version.

## The 30-second example

No Agent terminology anywhere below — `generic.action` is a made-up event
kind, chosen only to be obviously not tied to any domain.

```rust
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
    fn id(&self) -> &str { "repeated_action" }
    fn version(&self) -> &str { "1" }
    fn requirement(&self) -> SignalRequirement {
        SignalRequirement::All(vec![SignalId::from(ACTION_SIGNAL)])
    }
    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
        let mut findings = Vec::new();
        let mut run: Vec<&CanonicalEvent> = Vec::new();
        let mut last: Option<String> = None;
        // `flush` is its own closure so it can also run once *after* the
        // loop — a run still in progress when the event stream ends must
        // still be reported (a stream doesn't know to end on a convenient
        // boundary). Only flushing inside the `else` branch would silently
        // drop that trailing run.
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
        flush(&mut run, &mut findings); // don't drop a run still in progress
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
    let events = vec![
        event("e1", 1, "edit"),
        event("e2", 2, "edit"),
        event("e3", 3, "edit"),
        event("e4", 4, "commit"),
    ];

    let mut engine = VitalsEngine::builder()
        .with_detector(RepeatedActionDetector)
        .with_signal(SignalId::from(ACTION_SIGNAL), vec![ACTION_SIGNAL.to_string()])
        .expect("ACTION_SIGNAL is a well-formed, non-reserved signal id")
        .build()
        .expect("no duplicate detector ids, no unregistered signals");

    let report = engine
        .audit(AuditInput { events, coverage: Coverage::new(), config: serde_json::json!({}) })
        .expect("well-formed input");

    println!("{} finding(s)", report.findings.len());
    println!("{} replay frame(s)", report.replay.frames.len());
}
```

This exact code is `examples/repeated_action.rs` — a real, compiled,
runnable file, not just a code block that could silently rot. Run it with:

```bash
cargo run -p vitals-core --example repeated_action
# 1 finding(s)
# 4 replay frame(s)
```

Run the same detector shape against a real fixture file (not an inline
`Vec`) with:

```bash
cargo test -p vitals-core --test golden_replay
```

## Where to go next

- `tests/fixtures/*.json` — five domain-free fixtures, each pinning one
  mechanism (repetition, a non-repeating sequence, an unavailable signal
  shown two ways, and identical-duplicate-event dedup). `tests/golden_replay.rs`
  loads and runs each one — read that file alongside this README for the
  fixture ↔ assertion mapping.
- `tests/pipeline.rs` — the fuller pipeline test suite (reordering
  invariance, fingerprint stability, `Unavailable`/`MeasuredZero`/`Findings`
  gating, report-internal dedup).
- `tests/dependency_boundary.rs` — the automated check that this crate
  stays domain-free and doesn't depend on `agent-vitals-core` (§4.1/§5.2 of
  the spec).
- `PERFORMANCE.md` — recorded latency/memory baseline (§17 of the spec).

## Known limitations (v0.5)

This crate deliberately does **not** implement (see spec §3.2 for the full
list and reasoning): a `State`/`Progress` runtime, dynamic/plugin-loaded
detectors, a `Validator` DSL, `Recommendation`/`Intervention` execution, a
`SemanticJudge`/LLM integration, a `HistoryProvider`, cross-session behavior
profiles, or an async runtime. A `CanonicalEvent` belongs to exactly one
`Trajectory` — no reopening, merging, or splitting trajectories.

The one piece of production-facing infrastructure this crate does *not* own
is signal-name-to-event-`kind` mapping and legacy-shape re-projection — that
lives in the domain layer (`agent-vitals-core::compatibility`), which is the
only crate allowed to depend on this one (§5.2's one-way dependency rule;
`tests/dependency_boundary.rs` enforces it mechanically).

## Migration notes (from `agent-vitals-core`)

`agent-vitals-core::behavior`/`trajectory` migrated all fourteen SV601–614
rules onto this engine (see `docs/VITALS_CORE_V0_5_IMPLEMENTATION_SPEC.md`
§14 for the compatibility bridge design). Each migrated rule keeps its
original implementation alive as `detect_svNNN_legacy` — a deliberate,
tested fallback, not dead code — and every migrated rule has a matching
`agent-vitals-core/tests/svNNN_parity.rs` that runs the same fixture through
both the legacy body and this engine and asserts byte-for-byte identical
legacy JSON output. If you're migrating rule number fifteen, copy the
shape of `crates/agent-vitals-core/src/domain/detectors/sv601.rs` (simplest, no
cross-event state) or `sv612.rs` (has cross-event state and reads a signal
this crate doesn't know the name of — `agent.turn_boundaries` — entirely
through the domain-layer's own kind-mapping, not through anything in this
crate) as the two ends of the difficulty range.
