# Performance baseline (§17)

Not a promise — the spec is explicit: "这些指标是回归基线，不作为对外性能承诺。若未达到，应记录 profile 结果；不得为达标牺牲证据完整性或确定性"
(these are regression baselines, not an external performance commitment; if
not met, record the profile — do not sacrifice evidence completeness or
determinism to hit a number). Recorded here from a real run, not estimated.

Measured with `tests/performance.rs`'s `RepeatedActionDetector` against
`synthetic_events()` (a realistic-shaped, non-degenerate mix of 2–4-event
action runs), `--release`, single-threaded:

```bash
cargo test -p vitals-core --release --test performance -- --nocapture
```

## Results (2026-09-01, Apple M3 Pro, rustc 1.97.1, macOS 25.5.0/arm64)

| Events | Findings | Wall time | §17 target | Within target? |
|---|---|---|---|---|
| 1,000 | 166 | ~17 ms | (no target set) | — |
| 10,000 | 1,666 | ~87 ms | < 100 ms | yes |
| 100,000 | 16,666 | ~679 ms | < 1 s | yes |

Re-measured after fixing a bug in `RepeatedActionDetector` itself (not the
engine): the original detector only flushed a pending run inside the loop's
`else` branch (when a *different* action interrupted it), silently dropping
a run still in progress when the event stream ended — up to one missed
finding per run. `synthetic_events()`'s generator happens not to end
mid-run at these three sizes, so the finding counts above are unchanged
from before the fix; the fix still matters for real inputs, which don't
know to end on a convenient boundary. See the same bug (and fix) in
`examples/repeated_action.rs` and the README's copy of it — `tests/
pipeline.rs`'s and `tests/golden_replay.rs`'s versions of this detector
already had the correct unconditional final flush and were never affected.

Memory: not independently profiled (no memory-profiling dependency is in
budget for this crate per §5.3, and adding one just for this would violate
the same budget it's protecting). The one structural cost worth naming as a
qualitative note instead of a number: `events_by_trajectory` in
`engine.rs::run_pipeline` clones every `CanonicalEvent` once (grouping by
trajectory) — for a single-trajectory input this is one extra full copy of
the input on top of the original `Vec`, which is within the spec's "≤ 8×
normalized input JSON size" allowance but not free. If this crate ever
needs to process multi-trajectory sessions at the 100k+ event scale
routinely, that clone is the first place to look before adding a real
profiler dependency.

## A real bug this baseline caught

The first version of this benchmark measured **6.3 s** for 100,000 events —
6× over even a generous 10× safety margin on the §17 target, not just over
the target itself. That is not "a bit slow," it's a different complexity
class: `engine.rs`'s Finding Validation step checked
`trajectory.event_ids.contains(eid)` for every evidence event ID of every
finding, and `event_ids: Vec<EventId>` makes `.contains()` an O(trajectory
size) linear scan — done once per (finding × evidence event id), which made
the whole step effectively O(n²) on large single-trajectory sessions. Fixed
by building a `BTreeSet<&EventId>` once per trajectory before the detector
loop, turning each membership check into O(log n). 100k events dropped from
6.3 s to ~810 ms — inside the §17 target, not just inside the smoke-test
margin. This is exactly the scenario §21's stop-loss condition #2 is *not*
about (the abstraction didn't fail to express something) — it's the
mundane, unglamorous reason §17 exists at all: nobody had run 100k events
through the pipeline before writing this baseline, so nobody had noticed.

## Re-measuring

Numbers above are one machine, one run. Re-run with `--nocapture` before
trusting a regression claim; JIT/allocator warmup makes the 1,000-event
number in particular noisy relative to its total wall time.
