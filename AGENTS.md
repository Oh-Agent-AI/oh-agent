# Repository Guidelines

## Project Structure & Module Organization

Agent Vitals maintains a Python compatibility implementation and a Rust workspace. The Rust CLI lives in `apps/cli/`; reusable logic is split across `crates/agent-vitals-{data,domain,harnesses,runtime}` and `crates/vitals-core`. Python code is under `packages/agent-vitals-python/agent_vitals/`, with entry scripts in `scripts/`. Tests are in `tests/` for Python and beside each Rust crate in `tests/` modules. Golden outputs and fixtures live in `golden/` and `fixtures/`. Desktop Tauri code is in `apps/desktop/src-tauri/`, integrations in `integrations/`, shared runtime data in `assets/`, and design/specification material in `docs/`.

## Build, Test, and Development Commands

- `python3 -m unittest discover tests -v` runs the full Python suite.
- `python3 tests/golden_runner.py --diff` verifies byte-for-byte golden output. Use `--update` only for reviewed, intentional contract changes.
- `cargo test --release` runs the default Rust workspace tests.
- `cargo clippy --release --all-targets -- -D warnings` enforces the CI lint gate.
- `cargo build --release` builds `target/release/agent-vitals`.
- `AGENT_VITALS_BIN="$PWD/target/release/agent-vitals" python3 tests/golden_runner.py --diff` checks Rust/Python output parity.
- `cargo run -- --help` runs the CLI during development.
- `cd integrations/dsh-client && npm test` builds and verifies the DSH client when that integration changes.
- Desktop (Tauri) tray checks must go through the bundle: `cd apps/desktop/src-tauri && cargo tauri build --bundles app`, then `open "target/release/bundle/macos/Oh Agent.app"`. Never run `target/{debug,release}/agent-vitals-menubar` directly — macOS 26 never places a status item for a bare binary (sandboxed or not), and every bare-run path leaves a junk entry in System Settings › Menu Bar (the 2026-09-14 "tray vanished" incident). Keep `set_activation_policy(Accessory)` in code; tao resets the policy to Regular at launch, so `LSUIElement` in Info.plist alone is not enough.
- **2026-09-15 follow-up, same failure mode, one layer deeper.** A bare run from an agent shell (Codex, Claude Code, or Terminal) does not just fail to show a status item — macOS 26 attributes the status item to *whoever launched the process*, not to the item's own bundle id. The launcher's own entry in the "Allow in the Menu Bar" registry gets `agent-vitals-menubar` appended to its `menuItemLocations`, and since that launcher (Codex/Claude Code/Terminal) is normally toggled off there, the icon is swallowed. Only `open .app` makes the app itself the responsible process, landing it under its own `com.mixlabpro.agent-vitals` entry (toggled on) where it actually renders. The registry lives at `~/Library/Group Containers/group.com.apple.controlcenter/Library/Preferences/group.com.apple.controlcenter.plist`, top-level key `trackedApplications` — a *nested* binary plist (the outer XML stores it as an opaque `<data>` blob; `plutil -p` alone won't show its contents, you need `plistlib.loads()` twice). It is a flat list of (identity, record) pairs: identity is `{"bundle":{"_0": "<id>"}}` or `{"adhocBinary":{"_0":{"relative":"file://<path>"}}}`; record is `{"location", "menuItemLocations":[...], "isAllowed"}`. Every bare-run path (`target/debug`, `target/release`, a temp bundle dir) leaves its own `adhocBinary` ghost entry. **Editing this file directly races `cfprefsd`, which caches it in memory** — if the app is still running when you edit, ControlCenter/cfprefsd can flush its stale in-memory copy back over your edit (this survives a plain machine restart, since shutdown itself triggers a cfprefsd flush). Correct sequence: `pkill -f agent-vitals-menubar` (quit first, no live process to race) → `killall cfprefsd` (drop stale cache) → edit the file → `killall cfprefsd` again (force a fresh read) → `killall ControlCenter` → quit System Settings if it's open (it caches the list in its own process) → **remember to `open` the app again** — the cleanup's first step just killed it, and forgetting this step looks exactly like the icon-missing bug recurring. A verified read/preview/apply script for this exists at `~/cc_tracked.py` on this machine (not checked into the repo — it edits a machine-local plist, not project state).

## Coding Style & Naming Conventions

Do not run `rustfmt`, and do not run any auto-formatting command on an individual Rust file. This has previously reformatted hundreds of unrelated lines and obscured a small functional change. For Rust edits, preserve the surrounding formatting, inspect `git diff --stat` and the full diff immediately after editing, and use targeted manual formatting. A repository-wide formatter check may be used only as a read-only check (`cargo fmt --all -- --check`); it must not rewrite files unless the user explicitly requests a formatting-only change.

Rust modules and functions use `snake_case`; types use `PascalCase`. Python uses four-space indentation, `snake_case`, standard-library-first solutions, and compatibility with Python 3.9 CI. Keep harness-specific I/O in adapters/harness crates and deterministic policy logic in core/domain modules. Preserve explicit JSON field ordering where output participates in golden tests.

## Testing Guidelines

Name Python tests `test_*.py` and `unittest.TestCase` classes descriptively. Add Rust integration tests under the affected crate’s `tests/` directory. There is no numeric coverage threshold; regression fixtures, malformed-input degradation tests, harness contract tests, and Python/Rust lockstep checks are the acceptance criteria. Never refresh snapshots merely to silence a failure.

## Data Integrity Watchlist

Codex session logs can carry `model_provider` and a routed endpoint such as
`https://router.cogfoundry.ai/api/v1`. The emitter now preserves `provider_raw`,
`provider_id`, `billing_source`, and billing basis through Python/Rust parity and
SQLite ingestion. The generic authority query
`facts_by_hour_model_provider(harness, window)` must remain harness-agnostic; adding a harness
must not require a new provider-specific SQL query. Reprocess affected Codex logs
before reconciling costs. Current evidence for September 9, 2026 shows
`openai/gpt-5.6-sol` and `openai/gpt-5.6-luna` in `model_provider=custom` sessions,
while `gpt-5.6-terra` appears in `model_provider=openai` sessions.
Explicit `model_provider=openai` wins over a current custom endpoint hint. Facts with
no provider marker may use the current endpoint only as `route-config-fallback`; older
facts that cannot be safely enriched remain under `<unknown>` and must be reported as
metered estimates, never silently assigned to OpenAI.

Cross-harness audit status: DSH already persists provider evidence (`provider_raw` and the
provider/billing fields); Claude Code still has a similar unresolved route-evidence gap
because its emitter intentionally keeps only `model_raw`. Treat Claude provider/billing
classification as unavailable unless the source log contains explicit route evidence.

Billing fallback rule: a harness or model may be classified as `subscription` only when
there is explicit evidence for an official subscription route and the applicable
subscription scope. Custom endpoints, non-official routes, third-party gateways, and
missing or conflicting route evidence must default to `metered_estimate` for reporting,
with `has_unresolved=true` and a visible route/provider uncertainty reason. Never drop
such usage, turn it into zero, or treat an API-equivalent estimate as an actual bill.

## Data Retention & Serving-Face Policy (2026-09-19)

The product is an offline desktop app and the data experience comes first: the app never uploads user data. Existing outbound paths fetch public pricing/FX catalogs, check release versions, and explicitly opt in to the official manifest index. The data-extension policy also permits commit-pinned official payload downloads. The application-layer project permits explicit opt-in downloads of the official application index and signed packages from fixed public HTTPS sources. Download consent, installation consent, and data grants are separate decisions. Production application installation and data access must satisfy signature, process-identity, sandbox, and authorization gates; this policy does not certify their implementation. No request may include local logs, machine identifiers, grants, credentials, or analytical user data. This premise is protected — do not add telemetry, payload-bearing crash reports, cloud sync, or any other user-data upload without an explicit, reviewed product decision that also rewrites this section.

1. **Preserve analytical signal at ingest.** Adapters must no longer destroy signal for privacy reasons at ingestion. Extract and store structured derivations: error classification codes (HTTP status, JSON-RPC −32xxx, tool error taxonomy), truncated excerpts (~120 chars: error first line, argument summary), sizes and counts. Fingerprints (canonical args, `error_fingerprint`) remain as dedup/index keys, not as a replacement for the classified fields. Enrichment lands in new columns/tables with `Provenance` marked; existing fact-table contracts change only through reviewed golden updates — billing/behavior fact tables stay pure.
2. **Serving faces stay redacted.** The MCP surface keeps its current redaction rules ("never expose raw errors or invocation arguments" in issues_summary and friends) — local agents are networked consumers, so anything served over data-mcp can leave the machine inside an agent's context. Export keeps the dual path (`data-export-private` explicit, `data-export-redacted` default). Redaction is a per-face projection applied at serving time; it is never a reason to drop data at ingest.
3. **Secrets and canaries are never at-rest data.** Credentials (cc-switch tokens, API keys) are never persisted in anything we own; the probe/test feature may pass them in-memory as child-process env only. Canary task definitions (L1 probe suites) are confidential: never exposed via MCP, export, or any agent-readable surface.
4. **Raw text lives in the harnesses' logs, not in the authority DB.** Store anchors (source_id + native event id; line/byte offsets as self-validating acceleration hints) plus analytical increments, not full-text copies — sessions reach GB scale. Viewing raw JSONL segments is a local-presentation-only capability: read at presentation time, never persisted, never in MCP or export payloads; when the harness rotates the source log away, degrade honestly to "source expired, only the redacted projection remains".
5. **Unchanged by this policy:** billing honesty (`metered_estimate`, `has_unresolved`, no silent attribution), golden/Python-Rust byte parity, and the rule that new problem classes are registered in `docs/AGENT_EXECUTION_PROBLEM_TAXONOMY.md` before emitters are written.
6. **Scenario-scoped local application/plugin face (2026-10-03).** Data access depends on the application's deployment and presentation scenario, not a blanket ban on prompt-related fields.
   - **Official built-in plugins:** a plugin bundled with Agent Vitals and registered in the official plugin descriptor may consume real local data through registered, versioned Rust projection handlers. For this same-host scenario, the host's registered plugin identity, active WebView instance, method allowlist, and declared data scope are the access boundary; separate package-signature, external-process identity, market installation, and broker-grant infrastructure are not prerequisites. This is a scoped exception to the independent-package gates above, not permission to load untrusted packages.
   - **Field scope follows the feature:** session statistics and application-scoped opaque handles are permitted. When a documented local feature needs task context, its explicitly declared projection may additionally include existing scrubbed, bounded user-input/task excerpts, with role, provenance and truncation information; excerpts must not be presented as complete prompts. New sensitive fields require an explicit product decision and a reviewed projection contract/test update. Full prompts/raw JSONL, raw anchors, log paths, working directories, invocation arguments and raw errors are not enabled by this rule; full-text viewing remains a separate host-controlled local-presentation capability under item 4. Credentials and canaries remain prohibited.
   - **Independent or externally installed applications:** retain package verification, platform process identity, sandbox restrictions, explicit installation/data authorization and local broker gates appropriate to that deployment. Grants must be checked per request and before response delivery; connection credentials remain in memory. Unverified packages and browser previews use synthetic/redacted fixtures, not real user data.
   - **Common boundaries:** plugins never access the authority DB or harness logs directly and never receive arbitrary SQL or unrestricted host IPC. Rust performs the query and returns only the declared projection, checking the active authorized instance before access and response delivery. Missing data and denied/unsupported requests degrade explicitly. This face does not expand MCP or export permissions. No plugin may upload user data or use background external networking.
7. **Explicit remote mecha match exception (2026-10-31).** Only when the desktop user starts remote mecha play or approves a friend invitation may the built-in City feature send the declared `RemoteArenaV1` arena and current match commands, snapshots and battle events through the configured public HTTPS/WSS relay to the authorized match devices. A generic remote capability declaration or protocol does not itself authorize any other plugin or data for remote access. This is a user-initiated, match-scoped serving face, not general cloud sync. It must never include agent logs, prompts, session analytics, the complete City projection, local paths, native identifiers, credentials, tokens, costs or arbitrary host data. The relay may persist only short-lived room authorization, invitation, revocation and ticket metadata; match bodies are relayed in memory and must not be persisted. Remote methods are restricted to the versioned match allowlist and never include arbitrary `plugin_request`, host IPC, SQL, file or log access. This exception does not permit telemetry, payload-bearing crash reports, background networking, MCP/export expansion, or any other user-data upload. End-to-end encryption is not implied by TLS transport.

## Commit & Pull Request Guidelines

History follows Conventional Commit-style subjects such as `feat(v0.10.0): ...`, `fix(v0.10): ...`, `test(...): ...`, and `docs: ...`. Keep commits scoped and imperative. Pull requests should explain behavior and contract changes, link the relevant issue/spec, list commands run, and include screenshots for desktop or integration UI changes. Call out golden-file updates, schema changes, degradation behavior, and any intentionally unavailable evidence.
