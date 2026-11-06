# Runtime Refactor, Watcher & Hot-plug Hardening Spec

> Status: **Draft for implementation** (2026-09-22)  
> Owners: runtime, desktop and React workbench  
> Depends on: `AGENT_VITALS_SOURCE_GRAPH_INFRASTRUCTURE_SPEC.md`,
> `AGENT_VITALS_EVENT_BUS_ARCHITECTURE_SPEC.md`,
> `P2_WATCHER_PRODUCT_REVIEW.md`, `RUNTIME_EVIDENCE_CONTRACT.md`

## 0. Decision summary

The current runtime directory refactor is retained. Its domain boundaries and
compatibility re-exports are sound, and the watcher must remain an optional,
best-effort **latency accelerator**. The filesystem event path must never become
an authority writer or a second ingest implementation.

Before describing the product as "real-time hot-plug harness monitoring", the
following gaps must be closed:

1. coalesce wake requests so sustained filesystem activity cannot build an
   unbounded backlog of full syncs;
2. derive watch roots from the same runtime source topology used by ingest,
   including approved dynamic sources, rather than a hard-coded desktop list;
3. make watcher state observable through a redacted typed DTO and the existing
   `app-event` bridge;
4. prove the complete path from a file mutation to a UI-visible authority
   refresh, including degradation and dynamic-root lifecycle cases.

This is a hardening and contract-completion specification. It does **not** add
cloud connectivity, telemetry, raw path export, raw file-content retention, or
an agent-readable sensor feed.

---

## 1. Observed baseline

### 1.1 What is already correct

`agent-vitals-runtime` is now arranged by responsibility:

| Domain | Responsibility |
| --- | --- |
| `core/` | platform-independent state, clocks, home and retention primitives |
| `billing/` | pricing, declarations, money and budget rules |
| `ingest/` | authority sync, source reconciliation, leases and watcher adapter |
| `query/` | summary, trace, decision matrix and export read surfaces |
| `trust/` | local trust audit, identity and runtime sensor |
| `sources/` | source controls, registry and custom-source configuration |

The crate root retains old module re-exports. This prevents a broad consumer
break while callers move at their own pace. It is an intentional compatibility
facade, not duplicate business logic.

The current desktop data path is also correctly single-sourced:

```text
filesystem event
  -> WatchRegistry route + debounce
  -> TickWaker
  -> desktop sync_tick
  -> existing source reconciliation / authority transaction
  -> transactional event outbox
  -> desktop dispatcher emits app-event
  -> React typed bridge refreshes projections
```

The watcher does not write the authority SQLite database. `sync_tick` remains
the sole coordinator of source discovery, source reconciliation, tray refresh,
outbox draining and UI invalidation. This preserves the SourceGraph principle:
the periodic fingerprint sweep is the correctness mechanism; a watch event only
asks for that sweep sooner.

### 1.2 Verified baseline checks

At the time of this specification:

- `notify` is optional in runtime and enabled only by the desktop dependency;
  the default runtime dependency tree does not contain it.
- Runtime watcher tests passed: 359 passed, 1 ignored platform-timing test.
- The ignored real macOS FSEvents test was run manually and passed.
- Desktop Rust tests passed: 134 passed.
- Runtime and desktop `clippy -D warnings` passed.
- React and legacy workbench build/contract verification passed.

These checks establish that the current path compiles and works for fixed
roots. They are not proof of dynamic root lifecycle, bounded wake pressure, or
end-to-end UI visibility.

---

## 2. Problem statement

### P0. Wake requests can accumulate during sustained writes

`TickWaker` currently uses an unbounded `std::sync::mpsc::channel`. Debouncing
combines a burst inside one 1.2-second window, but it does not coalesce separate
windows while `sync_tick` is busy. A harness that appends logs continuously can
therefore queue one full sync after another.

Consequences:

- elevated CPU and subprocess churn after the originating activity has ended;
- a manual sync can compete with stale queued watcher wakes;
- a source with a chatty log can unfairly dominate the shared sync loop;
- the UI may receive repeated identical `SyncStatusChanged` refreshes.

This is a liveness and resource-control problem, not an authority correctness
problem: a later fingerprint sweep remains correct.

### P1. Fixed watch roots are inconsistent with dynamic source topology

`default_source_watch_roots` currently enumerates a fixed set of built-in
roots. Imported profiles, approved plugin data sources and custom roots can be
known to the runtime without being installed into the watcher. They are still
eventually discovered by manual sync or the periodic tick, but do not receive
the advertised seconds-level acceleration.

The risk is primarily product truthfulness: "harness import" and "real-time" are
not equivalent today. It also creates a maintenance trap in which adding a harness
requires editing an unrelated desktop function.

### P2. Watcher health is invisible to the user

The watcher currently logs initialization or attachment degradation to stderr.
The webview cannot distinguish:

- active native watching;
- a feature-disabled/noop watcher;
- roots pending creation;
- partially attached roots;
- a backend or permission failure followed by periodic fallback.

The user sees data eventually update, but cannot tell whether it was immediate
or the five-minute fallback. This is especially important for the trust and
Finding product surface, where freshness is part of the evidence claim.

### P3. Existing tests stop short of the cross-layer contract

Runtime tests prove routing and a real native wake. Desktop tests compile the
feature and React tests validate the generic event bridge. There is no test
which proves that a source write wakes a sync exactly once, advances authority,
drains the outbox, and refreshes the corresponding React projection.

### P4. Compatibility re-exports need an explicit retirement plan

Approximately 220 Rust call sites still import the pre-refactor paths
(2026-09-22 full-scope measurement: 274 under the
`tests/legacy_import_budget.rs` counting rule — earlier figures used partial
module lists; the budget test pins the full-scope baseline). That is
safe now because the root facade forwards to the domain modules, but keeping
both paths indefinitely hides ownership and makes future removals risky.

---

## 3. Goals and non-goals

### 3.1 Goals

1. Guarantee at most one pending filesystem-triggered sync wake per desktop
   process.
2. Make watch roots a runtime-owned topology projection, not a desktop
   hard-coded list.
3. Support runtime hot-plug only for explicitly approved source descriptors.
4. Give the desktop a bounded, redacted watcher-health signal and clear
   fallback wording.
5. Preserve SourceGraph/tick correctness when every watcher operation fails.
6. Keep CLI and wasm free of `notify` unless they explicitly opt in.
7. Add deterministic unit tests plus platform-native integration acceptance.

### 3.2 Non-goals

- replacing the periodic fingerprint sweep with event-only ingestion;
- allowing an imported profile to make the app recursively watch arbitrary
  filesystem paths;
- making trust-audit history scans run automatically on every file event;
- sending watcher events, raw paths, command lines or file contents through
  MCP, export or any network service;
- changing fact schemas, billing semantics, golden output or Python/Rust
  parity contracts;
- adding Tokio, a daemon, an HTTP server or a second database writer.

---

## 4. Invariants

The following statements are release gates, not implementation suggestions.

1. **One authority writer.** Watcher threads never open, write or migrate the
   authority database. Only the existing sync/trust coordinators write it.
2. **Tick is authoritative.** A missing, duplicated, reordered or malicious
   filesystem event may change latency only. It must not change final facts.
3. **One pending wake.** At any time, source filesystem events may account for
   zero or one queued sync request. Additional events coalesce, never queue.
4. **Dynamic source roots are declared, not guessed.** The source topology
   registry supplies roots and capabilities; UI code does not infer them from a
   harness slug or home-directory convention.
5. **Root policy is fail-closed.** A plugin/imported descriptor cannot request
   an unapproved absolute root, filesystem root, home root, symlink escape or
   unsupported recursive scope.
6. **No raw paths on serving faces.** UI receives harness labels and counts, not
   local root paths or native watcher error strings. MCP/export receive none.
7. **No feature leakage.** Runtime default, CLI and wasm retain NoopWatcher
   behavior and must not acquire `notify` in their dependency graph.
8. **Event vocabulary stays governed.** Any new desktop event is registered in
   this specification and the event-bus specification before its emitter is
   added.

---

## 5. Target architecture

### 5.1 Coalescing wake primitive

Replace the unbounded wake channel with a one-slot signal.

```text
watcher event batch
        |
        v
  try_send(()) into sync_channel(1)
        | full / disconnected
        +--> intentionally drop; current or next tick reconciles everything

sync loop:
  sync_tick()
  recv_timeout(TICK_PERIOD)
  -> consumes one pending signal or times out
```

The first event during a running tick occupies the sole slot. Further events
are coalesced until the loop consumes it. This is sufficient because each tick
performs a whole topology/fingerprint reconciliation; event cardinality has no
semantic meaning.

#### API shape

`TickWaker` remains the public abstraction, but its implementation changes to
hold `SyncSender<()>`. `wake()` returns a small outcome for diagnostics:

```rust
pub enum WakeOutcome { Queued, Coalesced, ReceiverGone }
```

Callers do not branch on `Coalesced`; they may increment process-local health
counters. `ReceiverGone` causes no panic and retains periodic fallback.

The wake primitive must remain feature-independent so NoopWatcher compilation
uses the same tick-loop shape.

### 5.2 Runtime-owned watch topology

Introduce a source-topology projection owned by `runtime::sources`:

```rust
pub struct WatchRootDescriptor {
    pub key: WatchRootKey,             // stable opaque identifier
    pub harness: HarnessId,                  // validated built-in or plugin slug
    pub class: WatchRootClass,          // FactsSource | CacheOnly
    pub origin: WatchRootOrigin,        // BuiltIn | CustomApproved | Configured | PluginApproved
    pub path: PathBuf,                  // runtime-only; never a UI/MCP DTO
    pub recursive: bool,
}
```

`watch_root_descriptors(data_home, user_home)` derives descriptors from the
same validated registry/configuration used by `sync_service`. The existing
fixed roots become built-in descriptors; the desktop no longer constructs an
independent list.

`CacheOnly` continues to support Skill cache invalidation. It cannot trigger a
facts sync. `FactsSource` can wake the sync loop but cannot invoke parsing or
database writes from the watcher thread.

### 5.3 Dynamic root eligibility and safety

Dynamic roots are permitted only when all checks pass:

| Check | Requirement |
| --- | --- |
| provenance | descriptor is a built-in root, a locally approved custom source, or an explicit built-in-harness runtime configuration (`DSH_HOME`); plugin manifests are **deferred** — see the review note below |
| harness identity | slug passes the existing harness registry validator |
| lexical scope | normalized path is below an allowed per-user application-data prefix; `/`, home root and parent traversal are rejected |
| canonical scope | canonicalized existing roots must remain below the same allowed prefix; a symlink escape is rejected |
| role | manifest declares `FactsSource` or `CacheOnly`; arbitrary callbacks are not importable |
| parser match | a `FactsSource` has a registered parser and is enabled by source controls |
| user control | source exclusion immediately removes its watch descriptor |

A trust-audit profile is not automatically a facts source. It may describe
audit evidence locations, but it does not gain a recursive watcher merely by
being imported. Trust runtime sensing keeps its independently configured,
redacted process/connection sampling model.

### 5.4 Watcher supervisor and live reconfiguration

The current fire-and-forget watcher handle is adequate only for startup roots.
Replace it with a desktop-owned `WatcherSupervisor` that has one worker and a
control channel:

```text
source controls / custom source mutation / plugin install or revoke
                    |
                    v
          topology revision advances
                    |
                    v
      WatcherSupervisor::replace(descriptors, revision)
                    |
                    v
   unwatch removed roots; attach new roots; retain unchanged roots
```

Requirements:

- a configuration revision is monotonic and each descriptor snapshot is
  immutable after submission;
- reconfiguration is serialized with the watcher worker, not by starting a
  second watcher thread;
- failed/newly absent roots are represented as `pending`, retried at a bounded
  interval, and never spin;
- removed descriptors cease routing immediately, even if a native backend emits
  a delayed event;
- reconfiguration does not wait on, cancel or write through a running sync;
- application shutdown may drop the supervisor; no database cleanup is needed.

Phase 1 may implement snapshot replacement by rebuilding the native watcher in
the same worker. Incremental `unwatch` optimization is optional and must not
change the public semantics.

### 5.5 Redacted watcher health model

Add a process-local state projection:

```rust
pub enum WatcherMode { Active, Degraded, Disabled, Unavailable }

pub struct WatcherHealth {
    pub schema_version: u32,
    pub mode: WatcherMode,
    pub topology_revision: u64,
    pub facts_roots_registered: u32,
    pub facts_roots_attached: u32,
    pub cache_roots_registered: u32,
    pub cache_roots_attached: u32,
    pub pending_roots: u32,
    pub last_event_at_ms: Option<i64>,
    pub last_wake_at_ms: Option<i64>,
    pub coalesced_wake_count: u64,
    pub reason_code: Option<WatcherReasonCode>,
}
```

Allowed reason codes are closed and path-free:
`feature_disabled`, `no_roots`, `home_unavailable`, `backend_init_failed`,
`root_pending`, `root_permission_denied`, `root_attach_failed`,
`worker_terminated`, `topology_rejected`, and `throttled`. `root_attach_failed`
and `throttled` were added the same day (2026-09-22) on two independent
branches: `root_attach_failed` distinguishes a non-permission watch-attach
failure (any I/O error attaching a root other than `PermissionDenied`) from
`root_permission_denied`; `throttled` is added
by `EVENT_PROCESSING_AND_OBSERVABILITY_REVIEW.md` P4/G5 — the desktop's
self-monitor found sustained high self-CPU and stretched the watcher-triggered
sync cooldown past its baseline (`ingest::self_monitor::SelfMonitor`). It only
surfaces when the watcher itself has no more specific reason to report; a real
backend failure is never overwritten by this one.

The runtime must retain this state only in process memory. It is operational
health, not user analytics; do not persist it to authority SQLite solely for
display. Existing source health/freshness remains the durable user-data truth.

### 5.6 IPC and UI contract

Add a read-only Tauri command, `watcher_health`, returning a bounded DTO. It
must reject/omit unrecognized enum values and never forward raw errors, native
paths or event payloads.

Register one event-bus/UI event type before implementation:

```json
{
  "type": "WatcherHealthChanged",
  "schema_version": 1
}
```

It is emitted only on mode, topology revision, attachment count or reason-code
changes—not for every filesystem event. The React typed allowlist accepts it.

UI placement:

- Settings / Sources shows a compact status: `实时监听已启用`, `部分可用（n 个根等待）`,
  or `已降级为定期检查` plus the fallback interval.
- Findings/Trust does not imply a security finding from watcher degradation. It
  may show freshness context, never an accusation.
- Skills uses a monotonically increasing cache revision. A visible Skills page
  observes that revision and re-reads its report once after debounce; a hidden
  page rescans only when opened. No raw changed path is shown.
- All other pages may ignore the event. Their existing `FactsIngested`,
  `SyncStatusChanged` and `FoldCompleted` refresh paths remain unchanged.

The existing single `app-event` transport remains the only webview event
transport. Do not create a watcher-specific browser channel.

---

## 6. Implementation plan

### Phase A — bounded wake and deterministic core tests

1. Change `TickWaker::channel()` to `sync_channel(1)`.
2. Change `wake()` to `try_send`, expose `WakeOutcome`, and record coalescing
   counters in the health object.
3. Extract `wait_for_tick_or_wake` as a small, injectable helper so the
   sync loop's ordering is unit-testable without a Tauri application.
4. Preserve the existing `recv_timeout(TICK_PERIOD)` fallback and its behavior
   after sender disconnect.

Exit criterion: 10,000 wake attempts during a simulated blocked sync produce
one pending receive and bounded memory.

### Phase B — topology descriptors and startup parity

1. Add `WatchRootDescriptor` and runtime derivation from source registry,
   custom-source controls and skill roots.
2. ~~Move fixed root knowledge out of `apps/desktop/src-tauri/src/lib.rs`.~~
   (Superseded: the P2 merge had already moved enumeration into runtime's
   `default_source_watch_roots`; Phase B builds the descriptor projection on
   top and removes the remaining desktop-side construction entirely.)
3. Add root policy validation and unit fixtures for valid/invalid built-in,
   custom, plugin, symlink and excluded-harness cases.
4. Retain the prior fixed-root behavior exactly for existing users.

Exit criterion: startup descriptor snapshots produce the same built-in roots as
the current implementation, with no paths in public diagnostics.

### Phase C — supervisor and hot-plug lifecycle

1. Introduce `WatcherSupervisor` and a serial control channel.
2. Have source-control/custom-source/plugin lifecycle commands request a
   topology replacement after their authoritative configuration write commits.
3. Make attachment/pending state update `WatcherHealth`.
4. Ensure profile-only trust imports do not create facts watchers.

Exit criterion: add, exclude, restore and remove an approved dynamic source
without restarting the app; only currently enabled descriptors can wake sync.

### Phase D — IPC, React and accessibility

1. Add the bounded `watcher_health` command and `WatcherHealthChanged` event.
2. Extend the React bridge's closed event type allowlist and safe DTO parser.
3. Add the Settings/Sources status panel and a non-alarming degraded state.
4. Connect Skills cache revision refresh with visibility and one debounce.
5. Add accessible status text (`aria-live="polite"`) for mode transitions.

Exit criterion: an active, pending, disabled and failed watcher can be
distinguished visually without exposing a local path.

### Phase E — compatibility cleanup

1. New code imports domain paths (`runtime::ingest`, `runtime::query`, etc.).
2. Migrate existing consumers opportunistically in files already being changed.
3. Track old root-facade import count in a non-blocking architecture check.
4. Do not mark old re-exports deprecated while warning-as-error gates would
   break consumers. Remove only in a planned major-version migration after the
   count reaches zero.

---

## 7. Test and acceptance matrix

| Area | Required test | Expected result |
| --- | --- | --- |
| wake pressure | send many wakes before receive | exactly one pending wake; later calls report `Coalesced` |
| ordering | wake while sync is running | one follow-up reconciliation, not N queued reconciliations |
| fallback | drop all senders | periodic tick continues without panic |
| routing | built-in/custom/plugin/cache-only descriptors | only matching root/class receives intended action |
| security | root, home root, `..`, symlink escape, unknown harness | descriptor rejected with closed reason code |
| dynamic lifecycle | add/exclude/remove/re-add root | supervisor attachment set matches current topology revision |
| native backend | macOS FSEvents write test | one wake within bounded timeout; remains an explicit platform test |
| ingest E2E | temporary source mutation + fake sync runner | one reconciliation, authority revision/outbox forward, UI event emitted |
| desktop IPC | health DTO malformed/internal fields | parser rejects/degrades; no path/error text crosses boundary |
| React | event allowlist and Sources state | only known event accepted; proper active/degraded copy |
| dependency | runtime default/CLI/wasm dependency trees | no `notify`; desktop watcher tree contains it |
| regressions | golden and Python/Rust parity | unchanged unless an explicitly reviewed public contract changes |

Required commands before merge:

```bash
cargo test -p agent-vitals-runtime --features watcher
cargo test -p agent-vitals-runtime
cargo clippy -p agent-vitals-runtime --all-targets --features watcher -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cd apps/desktop/ui-dev && npm run verify:react && npm run verify
python3 tests/golden_runner.py --diff
AGENT_VITALS_BIN="$PWD/target/release/agent-vitals" python3 tests/golden_runner.py --diff
```

The platform-native watcher test is run explicitly on macOS and documented in
the PR. It may remain outside the ordinary timing-sensitive unit gate, but the
deterministic routing/coalescing/lifecycle tests may not be ignored.

---

## 8. Observability and privacy review

| Data | Allowed location | Forbidden location |
| --- | --- | --- |
| root path, native event path | watcher process memory only | authority DB, IPC, MCP, exports, notifications |
| native backend error | local diagnostic log, normalized reason code | IPC raw string, MCP, exports |
| root counts/mode/revision | bounded IPC DTO and Settings UI | user analytics or outbound reporting |
| coalesced wake count | process-local diagnostics/UI summary | billing/fact tables |
| actual suspicious harness behavior | existing trust observation/Finding flow | inferred solely from watcher health |

Watcher health is not proof that an Agent read, packaged or uploaded data. It
must never influence trust Finding severity. Trust evidence continues to require
the established local artifacts/process/network correlation rules.

---

## 9. Rollout and rollback

1. Ship Phase A behind the existing desktop `watcher` feature; it is behaviorally
   compatible and immediately eliminates unbounded pressure.
2. Ship Phase B with built-in topology parity first. Compare descriptor counts
   in local diagnostics before enabling dynamic replacement.
3. Ship Phase C with dynamic roots defaulting to `pending` until all policy
   checks pass. A rejected root still receives periodic/manual fallback only if
   its approved source ingest path already exists.
4. Ship Phase D after DTO and UI contract tests pass. Do not make UI health
   presence a prerequisite for facts ingestion.
5. If the native backend or supervisor fails in production, set mode to
   `Degraded`, stop accepting watcher wakes, and retain the existing periodic
   tick. No data repair or schema rollback is required.

Success metrics are local, qualitative diagnostics only: bounded pending wakes,
attached-root ratio, and observed mutation-to-sync latency. They must not be
uploaded or used as telemetry.

---

## 10. Release decision

The current refactor is acceptable for release as a **fixed-root, best-effort
low-latency accelerator with periodic fallback**. It is not yet acceptable to
promise all imported/dynamic harnesses are monitored in real time.

Phase A is the first release-blocking hardening item if a frequently writing
harness can be present. Phases B–D are release-blocking before marketing or UI copy
claims dynamic-harness hot-plug or watcher-status transparency.


---

## 11. Review corrections and as-built deviations (2026-09-22 implementation)

Recorded before implementation; the phases above are implemented against
these corrections:

1. **Phase B.2 was stale** — the fixed-root enumeration had already moved into
   runtime (`ingest::watch::default_source_watch_roots`) with the P2 merge.
   Phase B supersedes it with the descriptor projection; the desktop no longer
   constructs any root list.
2. **P0 consequence wording overstated** — `SyncLock::try_lock` already
   serializes ticks against manual sync; the real harm of the unbounded wake
   channel was post-activity stale-tick churn (rapid consecutive no-op ticks,
   skipped-round log noise, subprocess churn), not concurrent competition.
   The `sync_channel(1)` fix and its exit criterion stand unchanged.
3. **P4 count corrected** — full-scope measurement is 274 legacy-path imports
   (earlier figures used partial module lists). The non-blocking budget test
   pins the measured baseline + 10.
4. **Phase C trimmed: `PluginApproved` deferred** — the provenance row requires
   "validated signed/installed plugin manifest", and the repository has no
   plugin-signing infrastructure (HARNESS_MANIFEST_DSL is unsigned). Implementing
   plugin-origin roots would mean building a signing system first. Phase C as
   built covers `CustomApproved` only (custom-source lifecycle +
   source-control exclusion); plugin origin re-enters scope when signing
   exists.
5. **Phase D.4 (Skills cache revision) simplified** — the Skills watch-only
   callback already invalidates the in-process report cache; a visible page
   re-reads on its existing refresh triggers and a hidden page rescans when
   opened, which satisfies the intent. A dedicated monotonic revision counter
   with visible-page auto-refresh is UI polish, deferred.
6. **Bugs found by the Phase B parity exit criterion** — the codex watch root
   was `codex_home()` (the home directory itself, i.e. all of `~` was watched
   instead of `~/.codex`), and `source_read_locations` displayed the codex
   path as `~/sessions`. Both fixed in the Phase B commit; the parity test and
   a structural guard (no built-in root is ever home or `/`) pin them.

7. **CustomApproved roots may live outside the home directory** — §5.3's
   "below an allowed per-user application-data prefix" is interpreted per
   origin: built-in and cache roots must stay under `user_home` (lexical +
   canonical), while user-approved custom roots may point at external volumes
   (the spec's non-goal forbids *imported profiles* from watching arbitrary
   paths, not explicit user additions). `/`, the home root and `..` traversal
   are rejected for every origin; canonical escape checks still apply where a
   canonical form exists.
8. **Configured roots are a narrow exception, not an import path** — an
   explicit runtime configuration belonging to a known built-in harness (currently
   only `DSH_HOME`) may use `Configured` provenance and therefore point outside
   `user_home`. It is subject to the same `/`, home-root, `..`, and known-harness
   checks as `CustomApproved`; imported profiles and arbitrary harness manifests
   cannot create it.

9. **Watcher-triggered sync execution rate needed a floor (found in
   real-machine acceptance, 2026-09-22)** — Phase A bounded the wake QUEUE
   (one pending slot) but nothing bounded the wake-to-execution RATE. An
   active agent session continuously appends to a watched root, so every
   1.2s debounce window legitimately wakes the tick, and each wake ran a
   full sync_tick (in-process overview/tray SQLite aggregation + tray
   rebuild + child spawns) — measured at a sustained ~3 cores. Fix:
   `WATCHER_SYNC_COOLDOWN` (30s) in the desktop tick loop. A wake inside
   the cooldown sleeps out the remainder and then runs (the final batch
   of writes is served, not dropped); the periodic 5-minute tick and
   manual syncs are unaffected; the first event after idle is still
   served in seconds.

Implementation commits (feat/watcher-hardening):
- Phase A — one-slot tick wake with coalescing
- Phase B — runtime-owned watch topology with fail-closed root policy
- Phase C — supervised watcher with hot-plug topology replacement
- Phase D — watcher_health IPC, WatcherHealthChanged event, Sources status row
- Phase E — legacy import budget test (non-blocking) + this section

This document is committed with Phase E (it previously lived untracked in the
primary worktree).
