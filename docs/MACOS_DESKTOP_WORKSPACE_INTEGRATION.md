# macOS desktop workspace integration

Status: Phases 1-2 implemented; Phase 3 query-contract work is partially implemented. 2026-09-24.

## Boundaries

The independent `react/prototypes/macos.html` is a mock interaction study, not a
new backend contract. Do not ingest its numbers, session titles, file paths,
confidence labels or acknowledgement state into production.

Preserve harness-agnostic ingestion, domain rules, billing honesty, authority data,
MCP redaction, dynamic harness registration and revision-based invalidation.
The desktop redesign does not itself require an authority schema migration.

## Architecture

```text
Harness adapters -> Runtime ingestion/orchestration -> Domain calculations
                         |                              |
                         +--------> Authority <---------+
                                      |
                         Query services + revision events
                                      |
                           Tauri commands/event bridge
                                      |
                          React data state -> Workspace

Tauri window: native traffic lights, drag area, window lifecycle
Presentation preferences: sidebar, split widths, selection, filters, scroll
```

Database facts and domain rules do not depend on desktop layout. UI preferences
do not belong in fact tables. The local UI, MCP and export remain separate
serving faces; a new inspector is not permission to expose raw source text.

## Phase 1: desktop shell

Implemented:

- Native decorated macOS window with Overlay title bar and hidden native title.
  The React toolbar reserves traffic-light space only in a native Mac runtime.
  There are no HTML window-control substitutes in production.
- Initial window 1100 x 760; existing 640 x 480 minimum retained for validation.
- 48px toolbar, persistent single-column sidebar, independent content scrolling.
- Sidebar collapsed preference in localStorage, failure-tolerant and UI-only.
- Remove duplicated global visible headings, navigation subtitles and the
  global reload button. Feature-level actions remain available.
- Overview refresh re-queries existing interfaces without reloading the document;
  loading is bounded by the latest request generation and both requests settling.
- Compact desktop styles isolated in desktop-shell.css; data semantics unchanged.

Validation: React build, TypeScript and existing bridge contract checks;
`npm run verify:desktop-shell` checks shell/config invariants.
These checks are not visual or native-window acceptance.

Pending native acceptance: use a built .app through LaunchServices, never run
the bare menubar executable. Verify traffic lights, dragging, fullscreen,
double-click titlebar behavior, minimum window size, keyboard focus, and other
platforms' decorated-window fallback. Do not call this release-ready before UAT.

## Phase 2: list/detail workspaces — implemented

- Sessions reuses `sessions_list` and `sessions_read`, including opaque
  references and cursors. Selection is re-resolved from refreshed rows by
  `session_ref`, so a refresh cannot leave the inspector showing a stale row.
- Wide windows use a list plus a side inspector; narrow windows stack the
  inspector after the list. Filters and selected opaque reference are preserved
  in `sessionStorage` (presentation-only; no authority data is written).
- No global search/sort is claimed. Existing harness/model/provider filters are
  explicitly server-side query filters; cost-state filtering is on loaded rows.
- Trust evidence is the primary surface. Profile approval/revoke and notification
  suppression controls are folded into a secondary disclosure.
- Added `trust evidence --limit [--harness] [--cursor] --json` and the Tauri
  `trust_evidence_read` command. It reads a bounded allowlist projection with
  SQLite read-only flags; it does not run profile discovery or filesystem audit.
  No schema change was needed. UI refresh and monitor invalidation reload this
  saved evidence independently from an explicit “本地审计” scan.
- History uses keyset pagination by `(observed_at_ms, observation_id)` and binds
  each opaque cursor to its originating harness filter; reusing it with another
  filter is rejected instead of silently skipping rows. The UI labels
  additional pages as older evidence; the cursor never appears as visible
  evidence text. Runtime, Tauri, and React accept the same bounded 320-character
  cursor contract. Runtime snapshots and explicit history refresh both
  release stale one-off audit results before displaying persisted history.
- History reads filter `expires_at_ms` against the query time without deleting
  rows. Monitor invalidation releases the last explicit audit report so newly
  persisted observations are visible. Session invalidations also increment the
  selected inspector query generation, preventing stale detail/pagination data
  from overwriting the refreshed projection.

Validation: React build/typecheck/contracts, session and trust bridge contracts,
Rust CLI/Tauri `cargo check`, plus the bounded/read-only/history filter runtime
unit test pass. The release `.app` bundle builds at
`apps/desktop/src-tauri/target/release/bundle/macos/agent-vitals.app`; its bundle
identifier and `LSUIElement` metadata were checked. It was not launched for
visual UAT, so titlebar geometry and interactive window behavior remain open.

## Phase 3: query and operation contracts — partially implemented

Audit existing query capabilities before adding commands:

1. **Done for current Trust history surface:** saved evidence is read separately
   from executing an audit, keyset-paginated in bounded pages of at most 500,
   harness-filterable, expiry-filtered, and parsed through the redacted DTO allowlist.
   The existing evidence anchors are HMAC-safe references. Missing/expired native
   source material is represented only by the remaining safe projection.
2. **Done for Overview's daily/monthly/calendar panels:** one Tauri command
   returns the three bounded SQL projections bracketed by authority revision.
   It retries once when a commit overlaps the read and reports
   `is_consistent=false` with a safe degradation message if the authority is
   unavailable or keeps changing. Window, revision, freshness, coverage, and
   billing basis remain explicit; the UI no longer presents independently
   fetched cross-revision panels as one snapshot.
3. **Operation status audit:** Current long-running workflows already have
   operation-specific tracking: sync uses request IDs plus queryable completion,
   billing recalculation uses persisted job IDs/status, and pricing catalog
   refresh exposes persisted status. Synchronous mutations return scoped receipts.
   A generic operation registry is deferred until another concrete workflow
   needs the same lifecycle; do not add a second task framework speculatively.
   Any future operation must report progress only when measurable and must not
   promise cancellation for uncancellable work.
4. **Implemented for current React query surfaces:** Events invalidate bounded
   queries and do not carry raw evidence. The bridge has revision gating and
   burst coalescing; manual refresh is the recovery path for missed events.
   Session detail and Trust evidence now participate in those invalidations.
5. **Not implemented (no product decision requested):** User acknowledgement is
   different from suppression, risk clearance and
   authorization revocation. Specify persistence and migration only if this
   feature is approved; the mock 'read' button is not an implementation.

## Acceptance gates

- Test 640x480, 760x560, 1100x760 and larger windows at normal display scale.
- First viewport contains meaningful data/actions, not repeated headings.
- No top-of-page multi-row navigation at desktop minimum size.
- Refresh preserves existing results and distinguishes stale/partial/error.
- Cross-page values use the same billing basis and statistics window; missing
  data is not zero, estimates are not actual bills, currencies stay separate.
- Trust coverage gaps remain visible; accepted client state is not proof of
  network transfer or unauthorized use.
- Mock preview, bridge-contract tests and bundled-app UAT are reported separately.

Current closeout (2026-09-24): implementation and automated contracts are green
for the desktop shell, Sessions split inspector and saved Trust evidence read.
Read-only Agent acceptance passed for the integration, revision snapshot, and
cursor contracts, including cross-harness cursor rejection and the maximum-length
React cursor case. The reviewer found a duplicate Tauri command registration;
it was removed and re-reviewed. The revision overlap path is bracketed and
retries, but automated tests currently cover stable and reported-inconsistent
responses rather than injecting a deterministic concurrent commit mid-query.
The React production build, TypeScript check, page contracts, runtime history
unit test, overview snapshot unit test, and CLI/Tauri compile checks passed.
Generic operation receipts remain a separate architecture task; no
acknowledgement product behavior was added; and no screenshot-based bundled-app
UAT was performed in this closeout. The latest source successfully built the
release app bundle at `apps/desktop/src-tauri/target/release/bundle/macos/agent-vitals.app`;
its bundle identifier and `LSUIElement` metadata were checked. Keep the remaining
architecture and visual acceptance gates visible rather than marking the full
workspace integration complete.
