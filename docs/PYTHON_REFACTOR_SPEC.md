# Python CLI Refactor Specification

Status: Proposed  
Scope: `scripts/scan.py` architecture only  
Behavior baseline: the Python CLI on `main`  
Design reference: the Rust modules in `src/` (merged from `refactor/rust-port`)

## 1. Decision

Refactor the current 3,394-line `scripts/scan.py` into a small executable
wrapper and an importable, standard-library-only Python package.

This is a behavior-preserving extraction, not a rewrite. The existing Python
CLI remains the compatibility authority during the refactor. The Rust port is
a useful guide to module boundaries, but it is not allowed to introduce Rust-
only behavior into the Python refactor.

The refactor is complete only when:

- all current command lines, exit codes, JSON fields, ordering rules, and
  degradation behavior remain compatible;
- all Python tests and reviewed golden files pass without regeneration;
- the Python and Rust implementations still pass the same language-neutral
  integration suite where their feature sets overlap;
- the minimal ClawHub package contains every required Python module;
- `scripts/scan.py` is no more than 40 lines and contains no product logic.

## 2. Why the file must be split

`scan.py` currently owns six unrelated responsibilities:

1. harness discovery and runtime subprocess probing;
2. filesystem traversal and SKILL.md parsing;
3. report calculation and JSON schema assembly;
4. diagnostics, overlap, and explanation logic;
5. terminal rendering;
6. snapshots, diffing, redaction, and CLI dispatch.

These responsibilities have different failure modes. Discovery must degrade
on malformed external state, analysis should be a deterministic pure function,
and rendering should never change measurements. Keeping them in one module
makes those boundaries unenforceable and makes every harness addition a regression
risk for every command.

The target is not a particular line count per file. The target is one source of
truth for every measurement and an explicit boundary between I/O and pure data
transformation.

## 3. Architectural principles

### 3.1 Preserve the pipeline

All commands must use this single data flow:

```text
CLI options
   -> harness roots
   -> filesystem inventory
   -> optional runtime probes
   -> evidence reconciliation
   -> pure report build
   -> diff, then redaction
   -> command-specific rendering or JSON
```

No renderer may rescan the filesystem, invoke a harness, or recompute a report
metric from a truncated display field.

### 3.2 I/O at the edges

- `adapters/`, `discovery.py`, and `snapshots.py` may read external state.
- `report.py`, `analysis.py`, `overlap.py`, `doctor.py`, and `explain.py` must be
  deterministic for the same input values.
- `cli.py` owns process exit codes and terminal streams.
- Runtime probes must return evidence plus visible errors; they must not print.

### 3.3 Unknown is not zero

Use an internal `Capability[T]` value for evidence that may be unavailable:

```python
@dataclass(frozen=True)
class Capability(Generic[T]):
    available: bool
    value: Optional[T]
    reason: Optional[str]
```

Construction helpers must reject these invalid states:

- `available=True` with no value when a value is required;
- `available=False` with a fabricated empty measurement;
- unavailable evidence without a reason.

Do not change the public JSON schema merely to introduce this internal type.
Serialize unavailable measurements exactly as the existing schema requires,
usually `null` plus an availability or error field.

### 3.4 Keep schema records stable

During this refactor, skill records and the final report remain JSON-compatible
dictionaries. Typed internal boundary objects may be introduced for inventory,
runtime evidence, source metadata, and options, but a schema v2 migration is a
separate project.

This avoids combining three risky changes: module extraction, type-model
redesign, and public schema migration.

### 3.5 Do not force a generic harness interface

The Rust implementation correctly avoids a trait whose methods would be empty
for most harnesses. Python should follow the same reasoning.

Every harness participates in four explicit phases, but not every harness implements
all four:

| Phase | Responsibility | Implementations |
|---|---|---|
| roots | locate candidate Skills | all harnesses |
| probe | ask the runtime what it sees | Codex, OpenClaw |
| reconcile | apply runtime evidence | Codex, OpenClaw |
| facts | emit harness-specific report evidence | as available |

`inventory.py` orchestrates these phases explicitly. Do not hide the important
Codex additive versus OpenClaw exclusive reconciliation difference behind a
generic plugin hook.

## 4. Target package layout

The package lives under `scripts/` so direct execution continues to work after
the repository or ClawHub package is copied without installation.

```text
scripts/
  scan.py                         # compatibility wrapper only
  probe_logs.py                   # independent log probe; unchanged initially
  agent_vitals/
    __init__.py                   # version and stable exports
    cli.py                        # argparse, orchestration, exit codes
    model.py                      # Capability, SourceMeta, Inventory, option types
    util.py                       # paths, lossy text, token estimate, wrapping
    frontmatter.py                # deterministic SKILL.md frontmatter parsing
    security.py                   # security rules and scanning
    discovery.py                  # classify, scan_skill_dir, collect
    inventory.py                  # roots -> collect -> probe -> reconcile
    report.py                     # final schema assembly; pure
    analysis.py                   # budget, conflicts, usage, structure, summaries
    overlap.py                    # tokenization, pair calculation, overlap renderer
    doctor.py                     # diagnostic records and doctor renderer
    explain.py                    # funnel, fixes, explain renderer
    lifecycle.py                  # lifecycle and list rows/rendering
    redact.py                     # report redaction
    snapshots.py                  # snapshot storage and snapshot/diff rendering
    diff.py                       # pure report-to-report comparison
    adapters/
      __init__.py
      claude.py                   # enabledPlugins and skillUsage
      codex.py                    # app-server JSONL probe and reconciliation
      openclaw.py                 # instances, bundled roots, CLI probe/reconcile
      workbuddy.py                # manifest/cache/welcome-mode discovery
      hermes.py                   # external_dirs discovery
```

The file count is deliberate. The harness adapters change for different external
reasons and need independent fixtures. Pure product logic is separated by the
user command that owns it. Files must not be combined merely to reduce the
number of modules.

Recommended size limits are guardrails, not goals:

- wrapper: at most 40 lines;
- `cli.py`: at most 350 lines;
- normal module: preferably 150-500 lines;
- 650 lines is a review threshold requiring a written reason;
- generated tables and test fixtures are excluded.

## 5. Module contracts

### 5.1 `scan.py`

Responsibilities:

- ensure the adjacent `scripts/` directory is importable;
- re-export a temporary compatibility surface used by characterization tests;
- invoke `agent_vitals.cli.main()` under `if __name__ == "__main__"`.

It must not parse arguments, scan files, build reports, or render output.
Temporary re-exports are removed only after tests import the owning modules.

### 5.2 `inventory.py`

Input: selected harness, explicit paths, home/cwd, harness configuration, probe
timeouts, and feature-disable environment flags.

Output: one `Inventory` containing disk skills, scanned roots, unreadable
entries, runtime capabilities, and harness-specific facts.

It is the only place that defines phase ordering. A harness adapter must not call
another harness adapter.

### 5.3 `discovery.py`

Owns generic filesystem semantics only:

- path classification and precedence metadata;
- plugin identity and conflict-domain inputs;
- one-Skill scanning;
- deterministic traversal and unreadable-entry capture.

It accepts source metadata from adapters. It must not know how WorkBuddy reads a
manifest or how Codex speaks JSONL.

### 5.4 `report.py`

Input: `Inventory` plus report options.  
Output: a report document and summary counts.

The function is pure and is the sole assembler of the top-level JSON schema.
`doctor`, `explain`, `list`, and JSON output all consume this same report.

`diff` and `redact` are deliberately excluded. The caller must apply them in
this order:

1. build report;
2. compare against the unredacted baseline;
3. attach diff;
4. redact the completed output.

### 5.5 `analysis.py`

Contains pure calculations with narrow inputs and outputs:

- conflict classification;
- description budget;
- trigger-age gates;
- structure cost groups;
- security summary;
- harness and OpenClaw instance summaries.

Each metric has exactly one implementation. Renderers consume calculated
fields and never rederive the metric.

### 5.6 Command modules

`lifecycle.py`, `overlap.py`, `doctor.py`, and `explain.py` each expose a data
function and a renderer. The data function returns JSON-serializable values;
the renderer accepts those values and returns text. Printing remains in
`cli.py`.

This separation lets JSON tests validate data independently of terminal layout.

### 5.7 Adapter error contract

Expected external failures are data, not exceptions:

- executable absent;
- timeout;
- malformed config or JSONL;
- unsupported harness version;
- permission or encoding failure on one Skill.

Adapters return unavailable capability evidence and error strings. Programmer
errors and violated internal invariants may raise normally in tests.

## 6. Dependency rules

Allowed dependency direction:

```text
model, util
  <- frontmatter, security, adapters
  <- discovery
  <- inventory
  <- analysis, overlap
  <- report
  <- lifecycle, doctor, explain, diff, redact, snapshots
  <- cli
  <- scan.py
```

Additional rules:

- adapters must not import `report`, command modules, or `cli`;
- pure modules must not import `subprocess`, `argparse`, or environment globals;
- renderers must not import adapters or discovery;
- `cli.py` may coordinate modules but may not implement measurements;
- circular imports are forbidden;
- module import must not probe harnesses or scan the filesystem.

## 7. Compatibility requirements

This refactor does not authorize changes to:

- command names, flags, defaults, or exit codes;
- default English-output work already approved separately;
- JSON key names, nullability, ordering, or schema version;
- deterministic ordering of roots, skills, findings, and conflicts;
- precedence and conflict-domain rules;
- security severity or `cited` semantics;
- token estimation and cost buckets;
- snapshot privacy, permissions, retention, or baseline ordering;
- path handling on Windows, macOS, and Linux;
- supported Python baseline (3.8+ unless changed by a separate decision).

The 12 invariants in `docs/ENGINEERING.md` remain acceptance criteria. Harness-
specific invariants added since that list—OpenClaw instance isolation, Codex
runtime additivity, and WorkBuddy manifest-selected top-level packages—are also
mandatory.

## 8. Migration plan

Every phase must end in a green commit. Do not keep a second maintained Python
implementation.

### Phase 0 — Freeze and map

- restore a green baseline before extraction;
- record `scan.py` line/function inventory;
- add characterization coverage for every directly imported symbol;
- run the full suite and golden runner without updating golden files;
- document the current CLI help and exit-code matrix.

### Phase 1 — Extract pure leaves

Move, in order:

1. `util.py` and `frontmatter.py`;
2. `security.py`;
3. `redact.py` and pure `diff.py`.

Keep compatibility re-exports in `scan.py`. This phase should produce no output
diff and no changed fixture.

### Phase 2 — Extract harness adapters

Move Claude config, Codex, OpenClaw, WorkBuddy, and Hermes logic into separate
adapter modules. Add adapter-local tests for success, absent, timeout, malformed,
and partial-result cases before moving orchestration.

### Phase 3 — Extract discovery and inventory

Move generic traversal to `discovery.py`, then implement the explicit four-phase
orchestration in `inventory.py`. Verify additive and exclusive reconciliation
with fake-harness tests.

### Phase 4 — Extract report and analysis

Move calculations without changing their dictionary shapes. Then move top-level
schema assembly into one pure `build_report()` entry point.

At the end of this phase, running the old command path and calling the new report
builder over the same inventory must produce canonical JSON byte-for-byte.

### Phase 5 — Extract commands and rendering

Move list/lifecycle, overlap, doctor, explain, snapshots, and diff rendering.
Update tests to import their owning modules. Remove compatibility re-exports only
after all external and test imports have migrated.

### Phase 6 — Reduce the wrapper and package

- move argparse and dispatch to `cli.py`;
- reduce `scan.py` to the wrapper;
- update ClawHub packaging to copy `scripts/agent_vitals/**`;
- add a packaged-artifact smoke test, not merely a source-tree test;
- update SKILL.md commands only if the entry path changes (the preferred design
  keeps `python scripts/scan.py` unchanged).

## 9. Test and release gates

Each phase must pass:

```text
python -m py_compile scripts/scan.py scripts/agent_vitals/*.py
python -m unittest discover tests -v
python tests/golden_runner.py --diff
```

Final gates:

1. Linux, macOS, and Windows CI pass on the supported Python minimum.
2. Fake Codex and OpenClaw success paths pass without installed harnesses.
3. Malformed and unreadable Skill tests prove scan continuation.
4. Property tests preserve redaction and token-estimation invariants.
5. The packaged ClawHub artifact runs `--version`, `--help`, default doctor,
   `--json -`, and one command with an isolated fixture home.
6. When Rust is present, both implementations pass reviewed golden and shared
   integration tests. A mismatch blocks merging; golden regeneration does not
   count as a fix without a semantic explanation.
7. A new architecture test enforces dependency direction, import side-effect
   freedom, wrapper size, and the 650-line review threshold.

## 10. Packaging changes

The current workflow copies only `scripts/scan.py` and `scripts/probe_logs.py`.
After modularization it must recursively copy the package:

```bash
cp scripts/scan.py scripts/probe_logs.py "$package_dir/scripts/"
cp -R scripts/agent_vitals "$package_dir/scripts/agent_vitals"
```

The exact-file allowlist must be replaced with either:

- a generated sorted manifest committed with the package, or
- an allowlist that includes every package module and rejects `__pycache__`,
  tests, temporary files, and bytecode.

CI must execute the CLI from `dist/agent-vitals`, with the repository source
directory absent from `PYTHONPATH`, so missing packaged modules fail before
publication.

## 11. Non-goals

This refactor does not:

- merge the Rust branch;
- decide whether Python or Rust is the final distributed implementation;
- add new harness capabilities or runtime probes;
- redesign schema v1 into the aspirational schema v2;
- add third-party Python dependencies;
- optimize performance without a measured regression;
- translate internal comments or documentation solely for line reduction;
- change `probe_logs.py` beyond packaging/import adjustments required later.

## 12. Risks and controls

| Risk | Control |
|---|---|
| Hidden import contracts in tests | temporary re-exports; migrate imports phase by phase |
| Golden passes while harness success paths are broken | fake-harness positive-path tests |
| Circular imports after extraction | dependency architecture test |
| Environment reads at import time make tests nondeterministic | pass home/cwd/env through context objects |
| Missing modules in ClawHub | run commands from the built artifact in CI |
| Python and Rust drift | shared integration suite and reviewed golden equivalence |
| Refactor mixes with English-output changes | land or revert the output change first; start extraction from a green commit |
| Big-bang type migration | keep schema dictionaries; type only internal boundaries |

## 13. Acceptance checklist

- [ ] `scripts/scan.py` is a wrapper of 40 lines or fewer.
- [ ] No product calculation exists in `cli.py` or a renderer.
- [ ] `report.build_report()` performs no I/O.
- [ ] Runtime probes return visible unavailable reasons rather than empty facts.
- [ ] Codex additive and OpenClaw exclusive reconciliation have direct tests.
- [ ] WorkBuddy manifest and mode filtering have direct tests.
- [ ] All 12 engineering invariants and added harness invariants remain green.
- [ ] Existing reviewed golden files pass without unexplained regeneration.
- [ ] ClawHub artifact smoke tests import the packaged modules only.
- [ ] Python/Rust shared behavior is equivalent where both implement the command.
- [ ] Public documentation names the Python module layout and packaging contract.

## 14. Recommended implementation order

Approve and land this specification first. Then complete the already-started
English-output change as its own commit and restore a green baseline. Begin the
module extraction only after that commit, starting with `util`, `frontmatter`,
and `security`.

This ordering prevents reviewers from having to distinguish wording changes
from architectural moves in the same diff and preserves meaningful golden
evidence throughout the refactor.
