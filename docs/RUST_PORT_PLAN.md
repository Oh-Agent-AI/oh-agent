# Rust Port Plan

Rust remains the preferred implementation for the distributable CLI binary; the
Python reference is retained and both are maintained in sync (permanent dual
maintenance, see ENGINEERING §6.8). Porting is gated by contract completeness
rather than calendar time.

## Entry criteria

Do not begin feature-by-feature Rust translation until all items pass:

- Python oracle contains the current Codex, WorkBuddy, and OpenClaw adapters.
- JSON schema represents capability state and harness instance identity.
- Harness fixtures are deterministic and independent of the developer machine.
- Golden files have been reviewed, not blindly regenerated.
- Degradation behavior is covered for every external/runtime dependency.

## Migration order

1. Freeze schema v2 and compatibility rules.
2. Extend fixtures and generate reviewed Python golden output.
3. Port pure functions: parsing, token estimation, hashing, redaction, security.
4. Port filesystem discovery and classification.
5. Port conflict domains and instance summaries.
6. Implement the WorkBuddy manifest adapter.
7. Implement the OpenClaw instance/config adapter.
8. Implement the Codex JSONL subprocess adapter.
9. Compare canonical Rust output against the Python oracle.
10. Run performance and packaging gates before shipping the binary.

## Required fixtures

### Codex

- successful `skills/list` with user, repo, system, and plugin skills
- disabled skill and optional interface/dependencies
- executable missing
- initialization timeout
- malformed JSONL and request error
- response with per-CWD errors

The test suite uses a stub process or captured JSONL. CI must not require Codex.

### WorkBuddy

- personal and project skill roots
- builtin manifest selecting package name and version
- cache resolution with marketplace-source fallback
- Work/design welcome-mode filtering
- `builtin-plugin` **package root + `skills/*`** are top-level Skills; anything
  else inside the package (e.g. `experts/`) is not
  （2026-08-13 依运行时对账更正；旧规则「整包排除」漏报 18 个）
- source traversal outside the marketplace root
- `.orphaned_at` marker retained as evidence, not interpreted as disabled
- connector catalog that must remain excluded
- malformed or missing manifest

### OpenClaw

- two instances with separate workspaces
- same skill name across instances: no conflict
- duplicate names within one instance: conflict
- shared `.agents/skills` projected into both instances
- explicit enabled, explicit disabled, and absent skill entry
- npm bundled root discovery and structured CLI eligibility overlay
- CLI timeout/error fallback to filesystem inventory without claiming loaded state
- malformed configuration and missing workspace

## Golden rules

Canonicalization may normalize paths, timestamps, and ordering. It must not erase:

- capability state differences
- instance identity
- conflict-domain differences
- adapter errors
- runtime verification flags

Use the Python oracle to generate expected output. A golden update requires a
human-readable semantic diff in the change description.

## Implementation notes

The Codex adapter is the only adapter here that starts an external process. It
must use newline-delimited JSON, wait for initialize response before sending
`initialized` and `skills/list`, wait for the matching request ID, then terminate
cleanly. On Windows, avoid command shims that detach under redirected stdio when
a native executable is available.

Path traversal and symlink behavior must be tested on Windows and Unix. Invalid
UTF-8 uses lossy decoding to preserve the Python oracle's current behavior.

## Release gates

- all Python characterization and regression tests pass
- Rust golden equivalence passes for every case
- no panic on malformed skill/config input
- 500-skill scan P95 is within the agreed CLI target
- Windows, macOS, and Linux packages run without Python
- fallback behavior is visible in JSON and human-readable output

Equivalence is the permanent differential contract: both implementations run the
same golden and any mismatch is fixed the same day. Python is not deleted — it
serves the ClawHub skill form and developer reading, while the Rust binary serves
the npm / brew / cargo / Release channels.
