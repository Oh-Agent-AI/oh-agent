# Road audit release integration

The native audit runs two phases on one immutable captured world. A complete diagnostic run is not a certificate. Final replay is attempted only if every mandatory route passed and dynamic solid coverage is complete. Failed or unconfirmed cases are never removed, relabelled as exclusions, or silently closed.

The first boundary producer supports the complete existing drivable support surface, including holes, curbs, height layers and validated portals. Its identity binds the world, region rules, full boundary segments and strict footprint policy. The continuous kernel and independent validator enforce full-body support/swept motion with mounting disabled. No new virtual fences or selectively closed roads are introduced. A boundary capability is bound to its issuing world; arbitrary non-null hashes cannot enable final replay.

Publication requires the unchanged frozen denominator, a second complete run under the final boundary identity, current host lease and deep verification, and bounded per-unit boundary evidence. Unsupported boundaries and evidence budgets refuse publication. A strict audit graph is not gameplay admission: gameplay's mountable/slide policy differs and existing gameplay must not inherit a certificate from this audit.

Automatic-run failure clips are bounded local diagnostics. Local history is versioned, capacity-limited and never rehydrated as a live graph, lease, or admission credential. It contains no session titles, source paths, raw harness logs, credentials or external network requests. Memory clips are evidence for debugging, not an alternative to release-policy proof. Recovery-specific mandatory cases and selectively closed-road fence production remain separate work.


## Implemented retention and UI

The worker records bounded automatic-run evidence (2 MiB in memory, 120 tail frames per failed run, at most 8 failure clips). Delivery retains at most 4 clips/512 KiB. The native UI separately projects coordinates, speed, heading and buttons into a local versioned history (8 records, 512 KiB total). Internal support IDs, arbitrary properties, graph objects and credentials are discarded. Frame inspection is a scrubber over recorded data, not deterministic resimulation. Map relocation requires a matching current captured world; old history cannot reactivate its graph. Quota or unavailable-storage failures show a current-view-only notice. Corrupt, oversized or unsupported-version archives are discarded; malformed records are filtered. Completed results and interrupted/timeout summaries are retained when storage is available.

Whole elevated expressway/ramp spans are now mandatory in both directions when structure paths are supplied (planner version 6). Exclusions refuse full-surface publication: selectively closed roads still require a separate verified physical fence producer. The final producer does not authorize the gameplay mounting/sliding policy. Recovery-specific mandatory test generation, signed/exported reports, native full-city acceptance and graphical ghost-vehicle replay are not claimed complete by this integration.

## Acceptance boundaries

Regression entry points:

- `node scripts/verify-city-road-audit-worker.mjs`: real worker serialization and two-phase execution; a fully passing fixture publishes. Incomplete collision coverage, excluded roads, forged boundary objects, stale worlds and gameplay/legacy policy overrides refuse certification. Elevated-span planning includes the curved middle in both directions.
- `node scripts/verify-city-road-audit-history.mjs`: archive projection, FIFO/byte limits, corrupt/quota degradation, interrupted unknown coverage and rendering of the actual history component. Historical success never restores permission, and map relocation is disabled for absent, stale or different-world captures.
- `node scripts/verify-city-suite.mjs module game --no-cache`: shared flight/driving runtime and audit regressions. Passing this suite does not establish whole-city passability or native long-duration stability.

Native manual acceptance remains separate: open More tools → road audit, complete or cancel a real-city run, inspect recorded failure frames, change the city revision and verify the old capture loses authority, then restart the app and confirm history remains diagnostic only. The currently installed app must be rebuilt before testing these new controls; updating TypeScript sources alone does not update the installed bundle.

## Local validation, 2026-10-21

Typecheck, production UI build and the new worker/history regressions passed. The game module's 34 stages were exercised in segments: 33 passed; `verify-city-driving-bridge-crossing` remains failed. The first run also exposed missing English HUD incident-log copy; that copy was added and its shared-UX guard passed on rerun. Remaining stages were then executed explicitly rather than treating unrun stages as passed.

The bridge failure reproduces on an isolated archive of pre-change HEAD `2f4f2ddd`: `beam bridge from: clears far bank under power (v=3.4)`, below the guard's required speed > 5. No bridge/physics source or assertion was modified in this audit integration. This is an unresolved baseline failure, not a passing release gate. Native bundle/manual acceptance of this integration has not yet been performed.
