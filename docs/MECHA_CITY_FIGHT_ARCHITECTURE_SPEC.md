# Mecha City Fight Architecture Specification

**Status:** Proposed architecture  
**Date:** 2026-10-25  
**Scope:** Agent City built-in plugin, city-derived mecha battlefield generation, battle-mode lifecycle, and rule verification  
**Related gameplay contract:** [`MECHA_CITY_FIGHT_NEXT_SPEC.md`](./MECHA_CITY_FIGHT_NEXT_SPEC.md)

## 1. Purpose

This specification defines the production architecture for the Mecha tactics mode embedded in Agent City. It addresses four risks in the current integration:

1. City-derived battlefield search runs synchronously during React rendering and can block the plugin host heartbeat.
2. Entry points do not all enforce the same mutual-exclusion rules for camera, input, export, repair, and game modes.
3. City layout extraction, battlefield selection, combat state, and Three.js presentation are too close together.
4. TypeScript and Rust carried separate combat implementations, while only the TypeScript one drove the City UI. The duplicate Rust rules crate has been removed; one runtime authority remains.

The intended outcome is a responsive, deterministic, testable game mode whose presentation remains a view of local City data. This specification does not change the gameplay values or balance frozen by the related gameplay contract.

## 2. Goals and non-goals

### 2.1 Goals

- Keep the Agent City plugin responsive while discovering battlefields.
- Make battlefield generation deterministic for a given City snapshot and ruleset version.
- Keep the City engine, combat rules, mode lifecycle, and 3D rendering behind explicit interfaces.
- Ensure every entry point uses the same mode guards and teardown behavior.
- Define one authoritative combat implementation; do not keep a second divergent rules copy.
- Make failures explicit and recoverable without corrupting City state or session data.
- Add automated verification for the new feature to the standard City verification workflow.

### 2.2 Non-goals

- Change combat stats, enemy scripts, scoring, or strategy weights. (The ruleset itself moved to `mecha-v1.4` on 2026-10-26 through the reviewed decision D1 in `MECHA_CITY_FIGHT_REMEDIATION_SPEC.md`; no numbers changed.)
- Change City planning, roads, buildings, or the City projection contract beyond reading the fields required for a battlefield snapshot.
- Add cloud services, telemetry, remote gameplay, or MCP access to combat internals.
- Introduce arbitrary plugins or unrestricted host IPC.
- Require a Rust/WASM runtime for the built-in Agent City plugin.
- Guarantee a particular battlefield shape when the source City does not contain suitable terrain or buildings.

## 3. Architectural principles

1. **Responsive host first.** Expensive geometry and search work must not run in a render function or block the plugin event loop.
2. **One-way data flow.** City state is read into a snapshot; the game consumes that snapshot and never mutates the City plan.
3. **Pure domain logic.** Combat and battlefield selection operate on serializable values and have no DOM, React, Three.js, database, or MCP dependencies.
4. **One owner per resource.** A mode coordinator owns camera, keyboard, frame hooks, and mutually exclusive activity leases.
5. **Deterministic results.** Stable sorting, explicit seeds, versioned policies, and bounded search make output reproducible.
6. **Honest degradation.** Missing terrain, stale snapshots, unsupported worker execution, and absent battlefield shapes are reported as such; no fake City geometry is silently substituted.
7. **Local-only product boundary.** The built-in mode uses registered local plugin projections and does not upload user data.

## 4. Component model

```text
CityEngine
   │ read-only snapshot request
   ▼
City Snapshot Adapter ──> immutable CityFightSnapshot
                                  │
                                  ▼
                           Battlefield Worker
                                  │ FightCatalog
                                  ▼
City Mode Coordinator ──> Mecha Controller ──> Pure Combat Rules
                                  │
                                  ▼
                           Mecha Presentation
                      (React HUD + Three.js view)
```

### 4.1 City Snapshot Adapter

The adapter is the only component allowed to translate City engine structures into game input. It reads the current modeled City and creates a serializable, immutable snapshot. It does not choose a battlefield or execute combat rules.

Responsibilities:

- Extract terrain height and optional slope query data through a worker-safe representation.
- Extract building anchors and dimensions needed to place board lots.
- Extract road edges needed to paint road cells after a window is selected.
- Assign a monotonically increasing revision and stable content fingerprint.
- Omit unrelated fields, session content, raw logs, paths, and identifiers not needed by the game.
- Return an explicit error when the City is not modeled or the requested geometry cannot be represented.

The snapshot must not contain references to live `CityEngine`, Three.js, DOM, database, or React objects. If the current terrain representation is a function closure, the adapter must materialize a worker-safe representation such as a compact height/slope grid plus interpolation parameters, or a transferable typed-array payload. The implementation must document its approximation error and sampling resolution.

### 4.2 Battlefield Worker

The battlefield worker accepts a snapshot and a versioned generation request, then returns a `FightCatalog` containing `flat`, `shore`, `ridge`, and `alley` candidates. Missing candidates are `null`.

Responsibilities:

- Run candidate generation and scoring off the UI thread.
- Preserve deterministic ordering and tie-break rules.
- Support cancellation and stale-result rejection.
- Report bounded progress for long requests.
- Return structured failures rather than throwing across the worker boundary.
- Never read local files, user prompts, session logs, or database state.

The worker may internally use chunked search, but a worker task must also support cancellation between chunks. Search bounds, sampling policy, and generation version must be explicit constants included in the cache key.

### 4.3 Mecha Controller

The controller owns game state transitions and user intent. It receives a selected `CityMechaSite`, initializes the match, produces legal action options, constructs a complete plan, asks the pure rules to validate/apply it, and emits presentation state.

It must not:

- Read the City engine directly.
- Perform terrain sampling or battlefield search.
- Create or dispose Three.js objects.
- Reach into plugin host internals or perform arbitrary IPC.

The controller should expose commands such as `selectShape`, `selectDoctrine`, `setDraft`, `submitPlan`, `restart`, and `close`. Commands must be validated against the current match revision.

Implemented 2026-10-26 as `game/mecha/controller.ts` (`createMechaController`): `selectMech`, `setMove`, `setAction`, `clickCell`, `applyDoctrine`, `setDoctrine`, `submit`, `restart`, `startAuto`/`stopAuto`, `pause`/`resume`, `tick`. It is pure TypeScript (no React, Three, or engine imports, enforced by `scripts/verify-mecha-layers.ts`); `MechaBoard` subscribes with `useSyncExternalStore`. Turns advance only through `rules.playTurn`; previews use `rules.previewPlan`; combat cues come from the `TurnEvent` log. The full target layering is §3.0 of `MECHA_CITY_FIGHT_REMEDIATION_SPEC.md`.

### 4.4 Pure Combat Rules

Combat rules remain deterministic and independent of UI. The current gameplay contract is `mecha-v1.4` (2026-10-26); a further change needs another reviewed increment.

Rules input and output must be plain serializable data. A rejected order must not partially mutate the committed match state. For a submitted pack, validation occurs against a cloned trial state; only a fully valid plan commits.

The contract must explicitly define whether pack actions resolve sequentially or simultaneously. **Resolved in `mecha-v1.4`** (remediation spec §3.2 stage B): resolution order is the canonical `MECH_IDS` order regardless of `plan.items`; moves are validated together (allies do not block each other, final cells must be distinct); actions are validated together on the post-move board; at resolution an action whose actor or target died, or that an earlier knockback put out of reach, fizzles without consuming cooldown instead of rejecting the pack. Under `mecha-v1.3` the pack resolved in item order and such cases rejected the whole pack.

### 4.5 Mecha Presentation

React owns menus, HUD, draft editing, accessible controls, loading/error states, and keyboard routing. Three.js owns board meshes, actors, telegraphs, health bars, and camera framing.

Presentation code subscribes to controller state and issues commands. It does not compute legal combat outcomes independently. The Three.js view must be disposable and reconstructible from controller state.

## 5. Data contracts

### 5.1 City snapshot

```ts
type CityFightSnapshot = {
  schemaVersion: 1;
  cityRevision: number;
  fingerprint: string;
  dimensions: { width: number; depth: number; sampleSpacing: number };
  terrain: TransferableTerrain;
  anchors: SiteAnchor[];
  roads: RoadEdge[];
};
```

`TransferableTerrain` is a serializable representation selected by implementation. It must permit deterministic `heightAt(x,z)` and `slopeAt(x,z)` behavior in the worker. It must not include closures or engine instances.

### 5.2 Generation request and result

```ts
type GenerateFightCatalog = {
  requestId: string;
  cityRevision: number;
  fingerprint: string;
  generationVersion: string;
};

type FightCatalogResult = {
  requestId: string;
  cityRevision: number;
  fingerprint: string;
  generationVersion: string;
  catalog: FightCatalog;
  diagnostics: { candidatesVisited: number; durationMs: number };
};
```

Worker messages are a discriminated union: `progress`, `result`, `cancelled`, or `error`. Errors carry a stable code and user-safe message; raw stack traces remain local diagnostics and are not included in user-facing projections.

### 5.3 Match state

Match state contains only game entities and ruleset metadata. It must not store live City objects. The selected site is copied into a match-owned value when the match starts so later City changes cannot silently alter an active battle.

## 6. Battlefield generation behavior

### 6.1 Determinism

For identical snapshot fingerprint, generation version, and options, generation must return identical candidates, spawn positions, scores, and tie-break outcomes. Any randomness must use a seeded PRNG derived from an explicit request seed; unseeded `Math.random()` is prohibited in battlefield generation.

### 6.2 Bounds and quality

- Candidate seeds and candidate offsets must be bounded and observable in diagnostics.
- Search complexity must be budgeted against representative small and large Cities.
- Search must stop promptly after cancellation or when a newer City revision supersedes it.
- Spawn constraints must follow the gameplay contract. Any fallback that relaxes a constraint must be documented, surfaced in diagnostics, and covered by tests. It may not silently relax the spawn-height limit.
- The result must distinguish “no eligible field of this shape” from “generation failed”.

### 6.3 Cache

Cache keys include:

```text
fingerprint + schemaVersion + generationVersion + relevant options
```

Cache entries are local and bounded by entry count or memory size. A City update invalidates only entries whose fingerprint changes. Cached data is a derived game projection, not an authority source.

## 7. Mode lifecycle and resource ownership

### 7.1 Coordinator

Introduce a single City mode coordinator for mutually exclusive activities. At minimum it tracks:

- `idle`
- `flight`
- `driving`
- `mecha`
- `repair`
- `cinema` / export

Long-running export can be modeled as a resource conflict rather than a full-screen mode if its rendering requirements permit it. That decision must be explicit and tested.

Every entry path—toolbar, settings, clicking an aircraft/car/mecha, keyboard command—must call the coordinator. Components must not independently implement partial guard lists.

### 7.2 Lease contract

Entering a mode obtains a lease containing the resources it owns, such as camera, keyboard, scene frame hook, pointer lock, and input focus. The lease has an idempotent `release()` method and is released on normal close, component unmount, host tab teardown, error, and cancellation.

The coordinator must reject conflicting entry with a stable reason. It must never silently start a second mode that can overwrite a camera or frame hook owned by another mode.

### 7.3 State transitions

```text
idle ──enter──> preparing ──ready──> active ──close/error──> idle
                         └─cancel/failure───────────────> idle
```

`preparing` covers snapshot creation and worker generation. During preparation, the UI displays progress and allows cancellation. The City remains usable for non-conflicting work where safe. A stale response cannot transition the state to `ready`.

## 8. Responsiveness and performance budgets

### 8.1 Required behavior

- No unbounded search, large terrain scan, plan enumeration, or 3D resource construction in React render or a synchronous input handler.
- Worker search must not prevent the plugin heartbeat or host message loop from running.
- Worker cancellation must be checked at bounded intervals.
- Three.js scene creation must be staged if it exceeds the frame budget; disposal must release geometries, materials, listeners, hooks, and leases.

### 8.2 Initial acceptance targets

These are proposed guardrails and should be calibrated on CI and a representative desktop build:

- Opening Mecha must yield to the UI immediately; the first loading/progress state is visible within 100 ms on the reference machine.
- No main-thread task attributable to Mecha exceeds 50 ms during field generation.
- Worker search returns or reports no eligible site within 5 seconds for the largest supported fixture; cancellation is acknowledged within 250 ms.
- No missed plugin heartbeat during generation, scene mount, or repeated open/close cycles.
- Repeatedly entering and closing Mecha 20 times leaves no accumulating frame hooks, listeners, or GPU resources.

If hardware variance makes wall-clock budgets unsuitable for CI, CI should enforce deterministic operation-count ceilings and the desktop smoke check should enforce wall-clock and heartbeat budgets.

## 9. Runtime authority and duplicate rules

### 9.1 Runtime authority

The TypeScript rules in the Agent City plugin (`apps/agent-city/ui/src/game/mecha/rules.ts`) are the sole runtime authority because they directly drive the built-in UI. The ruleset string `mecha-v1.4` means that implementation; no second copy may claim it. The rules now live in `game/mecha/{board,combat,enemy}.ts` behind the unchanged `rules.ts` public surface.

### 9.2 Duplicate implementation removed (2026-10-25)

The `crates/mecha-tactics` reference crate was deleted. It had no consumer (no app, wasm, MCP or CLI path used it), it lacked the City board, half-steps, terrain, buildings, raiders, siege and doctrines, and it still declared the same ruleset string as the shipped rules. A shared-fixture gate over that shrinking flat-board subset would have certified only the part that does not ship.

If cross-language execution is needed later, build one shared core (for example a wasm module consumed by both sides) rather than reinstating a second divergent rules copy and comparing the two in CI.

## 10. Error handling and degradation

| Condition | Required behavior |
| --- | --- |
| City not modeled | Keep Mecha unavailable with a clear reason; do not crash the City plugin |
| Snapshot creation fails | Return to City mode, release resources, show retryable error |
| Worker unavailable | Use a bounded fallback only if it stays under the main-thread budget; otherwise disable generation with an explicit message |
| No candidate for selected shape | Disable that shape and explain no eligible City terrain was found |
| City changes during generation | Cancel or discard stale result and regenerate from the latest revision |
| Invalid or stale plan | Reject atomically, preserve draft, explain the rejection |
| View mount failure | Release the mode lease and return to a usable City screen |
| Host closes/unloads plugin | Cancel worker tasks and release all owned resources |

No fallback may fabricate roads, water, mountains, buildings, or a successful combat result while presenting it as City-derived data.

## 11. Privacy and local data boundary

- The game consumes only the registered local City projection needed for geometry.
- No session prompt, raw event, raw source path, working directory, credential, or database handle enters the snapshot or worker messages.
- Worker messages remain within the built-in plugin instance and are not a new MCP or export surface.
- The plugin does not make network requests for gameplay or send diagnostics externally.
- Diagnostics may include counts, durations, stable error codes, and synthetic request ids; do not include sensitive source paths or session text.

## 12. Verification strategy

### 12.1 Unit and contract tests

- Snapshot serialization contains only declared fields and round-trips through structured clone.
- Same snapshot and generation version produce byte-equivalent catalog output.
- Cancellation and stale-result rejection work across repeated requests.
- Every shape either satisfies all documented terrain/spawn constraints or returns `null`.
- Spawn-height fallback behavior is tested and cannot exceed the published rule.
- Combat pack rejection is atomic, and the v1.4 simultaneous-validation / fizzle semantics are pinned (`scripts/verify-mecha-tactics.ts`, permutation invariance included).
- Mode coordinator denies conflicting entries and releases each resource exactly once.
- Worker and controller errors return the coordinator to `idle` without leaking resources.

### 12.2 Integration checks

- Open Mecha from each supported entry point while idle.
- Attempt entry during flight, driving, repair, cinema/export, and another Mecha session; verify consistent rejection.
- Change the City revision while a worker request is pending; verify stale results are ignored.
- Open, cancel, retry, play, close, and reopen; verify camera and controls return to their prior owners.
- Verify the plugin heartbeat continues during maximum-size battlefield generation.

### 12.3 Standard verification wiring

All deterministic Mecha scripts must be registered in the standard City verification manifest/module stage. A feature-specific script that exists but is not invoked by normal CI does not count as a CI gate. Desktop-only heartbeat, GPU disposal, and input ownership checks may be a documented smoke stage if they cannot run in headless CI.

### 12.4 Review and release evidence

The implementation PR must list:

- Verification commands and their actual results.
- Largest fixture size and operation-count/runtime result.
- Whether the macOS plugin host stayed responsive during search.
- Ruleset authority: one TypeScript implementation; confirm no duplicate rules copy was reintroduced.
- Screenshots or recording of loading, no-candidate, error, and active states.

## 13. Migration plan

### Phase 0 — Contract freeze

- Confirm `MECHA_CITY_FIGHT_NEXT_SPEC.md` is the gameplay source of truth.
- Resolve sequential versus simultaneous plan semantics. (Done: `mecha-v1.4`.)
- Resolve the spawn-height fallback discrepancy; do not implement a hidden relaxation.
- Record runtime rule authority and confirm the duplicate Rust rules implementation is gone.

### Phase 1 — Extract snapshot and generator

- Add `CityFightSnapshot` and adapter from engine data.
- Make snapshot transferable and fingerprinted.
- Separate battlefield generator from React and engine imports.
- Add deterministic fixtures and no-candidate cases.

### Phase 2 — Worker and preparation UX

- Add worker protocol with request ids, progress, cancellation, structured errors, and stale response checks.
- Replace render-time `siteFightShapes()` call with an explicit preparation state.
- Add bounded cache keyed by snapshot and generation versions.
- Add performance and operation-count checks.

### Phase 3 — Mode coordinator and controller

- Centralize mode guards and resource leases.
- Route every Mecha entry point through the coordinator.
- Extract command/state transitions from `MechaBoard` into a controller.
- Add mode conflict, cancellation, and cleanup tests.

### Phase 4 — Presentation hardening and CI

- Keep the Three.js component view-only and verify teardown.
- Wire Mecha validation into standard CI stages.
- Add cross-language shared fixtures for the common combat contract.
- Perform a desktop smoke run, including the original plugin-unresponsive reproduction.

Each phase should be independently reviewable. Phase 2 is the minimum required to address the reported host hang; Phase 3 is required before treating mode interaction as complete. The full architecture is accepted only after all phases and release evidence pass.

## 14. Acceptance criteria

This SPEC is implemented when all conditions below hold:

1. Battlefield generation is off the UI thread and no longer runs as a render side effect.
2. The UI displays a cancellable preparation state and rejects stale worker results.
3. City geometry is passed through a versioned, immutable, worker-safe snapshot.
4. All mode entry points use one coordinator and resource-lease lifecycle.
5. Closing or failing Mecha restores camera, input, and frame ownership without leaks.
6. Gameplay rules match the approved `mecha-v1.4` contract, including explicit plan resolution and spawn constraints.
7. TypeScript is the documented sole runtime authority, and no second combat implementation is kept.
8. The normal City CI suite executes the deterministic Mecha checks.
9. Desktop verification demonstrates no plugin heartbeat loss under the largest supported City fixture.
10. The local-only data boundary remains intact.

## 15. Open decisions

The following decisions must be closed during Phase 0 rather than silently chosen in implementation:

1. **Plan resolution:** sequential order or simultaneous movement/action phases. **Decided 2026-10-26 (D1): simultaneous phases with fizzles, ruleset `mecha-v1.4`.**
2. **Spawn height — resolved 2026-10-25:** the gameplay contract now documents a strict pass at 1 and a bounded relaxed pass at 2, surfaced in the panel (`出生高差 … · 标准 1，已放宽`) and covered by a test; the search never relaxes past 2. Removing the relaxed pass remains a product decision.
3. **Worker terrain representation:** materialized sampled grid versus compact deterministic terrain parameters. Decide based on memory, transfer cost, and error bounds.
4. **Rust crate lifecycle — resolved 2026-10-25:** the duplicate `mecha-tactics` reference crate was removed. TypeScript is the only rules implementation; reintroducing a second one requires a shared-core design, not a fixture gate over a divergent copy.
5. **Export overlap:** whether background video export can safely coexist with Mecha. Until measured and proven, treat it as mutually exclusive.

