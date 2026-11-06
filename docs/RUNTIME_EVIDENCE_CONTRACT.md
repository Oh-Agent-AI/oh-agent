# Runtime Evidence Contract

Status: required contract for every runtime (session-log) adapter.

Companion to [HARNESS_ADAPTER_CONTRACT.md](./HARNESS_ADAPTER_CONTRACT.md), which governs
the **install-time** layer (does a skill exist / is it enabled / is it loaded).
This document governs the **runtime** layer: what an agent actually did, what it
cost, and how long it took.

The install-time layer has had a capability contract since 2026-08. The runtime
layer has not, and the consequence is visible in the code: DSH's event vocabulary
(`tool/call`, `approval/asked`, `data.toolName`, `chunk.usage`) is read directly
inside `crates/agent-vitals-core`, which makes DSH's session format the de-facto
universal interface by accident. This document defines the interface that should
have been there, and the rules an adapter must satisfy to claim a harness is
supported.

Related: [AGENT_BEHAVIOR_AUDIT.md](./AGENT_BEHAVIOR_AUDIT.md) (rule engine,
SV601–SV614) · [ARCHITECTURE.md](./ARCHITECTURE.md) (funnel model, four cost
buckets) · [PRODUCT_CAPABILITY_MATRIX.md](./PRODUCT_CAPABILITY_MATRIX.md)
(install-time matrix and reporting language).

---

## 1. Why a normalized event stream is the wrong interface

The obvious design is: each harness gets an adapter that translates its log into
DSH-shaped events, and the core runs unchanged. It is wrong for three reasons,
each established by a harness in the support list rather than by speculation.

**Harnesses differ by which projections they durably record, not by field names.**
WorkBuddy keeps no conversation transcript: `~/.workbuddy/workbuddy.db` holds
session *metadata* and one aggregate usage row per session, its event-level
record is a hash-chained security-decision log, and its execution record is an
OpenTelemetry-shaped span tree — **three unrelated stores, three formats, three
fidelities** (§14.6). Claude Code is close to the mirror image — tool calls,
per-request usage and turn durations in one JSONL tree, but no approval or
sandbox decisions anywhere in it. Their surfaces are complementary. A model where
one canonical stream has "some fields missing" cannot express this; it can only
express "WorkBuddy performed zero tool calls", which is a fabrication.

The sharper form of the claim, which §14.6 records the cost of learning: evidence
is not merely uneven **across** harnesses — **within** a single harness it is scattered
across stores that must each be located, and an adapter that stops after two of
them will report `unavailable` for signals that were sitting in the third.

**Evidence can be present but lossy.** WorkBuddy's audit log records
`commandPreview` and `commandHash`, not the command. A dangerous-command rule
can *convict* on a preview but can never *acquit* on one. That is a second axis,
independent of presence.

**Storage medium differs.** WorkBuddy requires SQL over SQLite plus a JSONL
sidecar plus a blob store. `read_session_log(path) -> Value` is already the wrong
signature. An adapter owns its I/O; it is an evidence source, not a parser.

---

## 2. Three axes

The install-time contract has one axis (`available` / `unknown` /
`unavailable(reason)`). The runtime layer needs three. Two of them exist in the
codebase today only as comments, which is why they are periodically violated.

| Axis | Question | Today |
|---|---|---|
| **Availability** | Does the harness record this at all? | Install-time only |
| **Fidelity** | It records it — how lossy is the record? | Absent |
| **Provenance** | Is this number measured, derived, or estimated? | Comments only |

The third is an existing debt. `compaction.shadowedTokenCount` is harness-measured;
`context_composition` is `est_tokens`-estimated. Today a comment says the display
layer must not mix them. Making it a type removes the requirement to remember.
This is the same argument `src/harness.rs` already makes for `Option`: "Rust 里
`Option` 让这个区分变成编译期的事 —— 这正是选 Rust 的理由之一."

```rust
pub struct Observed<T> { pub value: T, pub prov: Provenance }

pub enum Provenance {
    Measured,                                 // the harness recorded this number
    Derived   { from: &'static str },         // the adapter inferred it
    Estimated { estimator: &'static str },    // est_tokens and friends
    Lossy     { kind: LossKind },             // present but degraded
}

pub enum LossKind { Truncated { hint: Option<usize> }, Hashed, Redacted }
```

`Observed<T>` with no `value` is legal and meaningful: "N requests happened here
and we know nothing about their tokens" is a fact, not an absence.

---

## 3. Signals

A **Signal** is a named, typed channel that may be present or absent
*independently of every other signal*. This is the property that makes the model
survive all four harnesses.

```rust
pub enum Signal {
    ToolCalls, ToolResults,
    TurnBoundaries, StepBoundaries,
    Usage,             // per-request time series
    UsageAggregate,    // totals only
    ContextWindow,
    ApprovalDecisions, ApprovalPolicy,
    SandboxModes, SandboxPolicy,
    NetworkAccess,
    Compaction,
    SubagentSpawns,
    SkillInvocations,
    Hooks,
    FileMutations,
    UserPrompts,       // genuine human turns
    UserCorrections,   // §3.2 — always Estimated, never Measured
}
```

### 3.1 Signal classes

Signals answer three different kinds of question, and conflating them is how
"Codex has no approval data" becomes a false statement.

| Class | Answers | Example |
|---|---|---|
| **Occurrence** | What happened | `tool/call`, `approval/decided` |
| **Policy** | What the rules were at the time | `approval_policy: Never`, `permission_profile` |
| **Outcome** | How it ended | `turn_aborted { reason }` |

Codex persists no approval *events* but always persists the approval *policy*
(§8). That supports a real finding — "this session ran under `approval_policy:
Never` and executed N commands matching dangerous-command rules" — with no
approval events at all. Claude Code's `permission-mode` records are the same
class. Any rule whose `requires` list contains only Policy and Occurrence signals
runs on harnesses that have no approval events whatsoever, which is most of them.

### 3.2 One signal is subjective, and that is the point

Every signal above answers a question about what the *system* did. `SV611`–`SV614`
are built on them and are correspondingly objective: a repeated tool signature, a
turn whose action sequence recurs, a run of failing results, a run of denials.

None of them can measure **the user's own verdict that the run was going wrong**.
That verdict is often the earliest and strongest indicator, and it leaves a trace
in the log: the user stops the agent and says "no, not like that".

`UserCorrections` names it. It is derived from `UserPrompts` plus
`TurnBoundaries` — a human turn arriving shortly after the agent stopped and
reading as a course-correction rather than a new task — and it is therefore
**always `Provenance::Estimated`, never `Measured`.** Keyword and time-window
heuristics are exactly the sort of thing §10.1 governs: it may support a finding,
it may never withdraw one, and its absence proves nothing.

Recording it separately (rather than folding it into the objective detectors)
keeps two things from being confused: *the system misbehaved* and *the user
thought the system misbehaved*. Both are worth reporting. They are not the same
claim and must not be summed into one score.

### 3.3 Visibility

A signal carries a visibility marker, because a harness may durably record data it
deliberately withholds from its own users.

```rust
pub enum Visibility { HarnessVisible, HarnessHidden { reason: &'static str } }
```

Codex persists `SecurityRiskScore` to the rollout file with the source comment
"Scores must not enter model-visible conversation context or user-visible thread
item projections." agent-vitals reads that file and has an export path.
**`HarnessHidden` data is excluded from export by default, and the exclusion itself
is reported.** Silently exporting what the harness chose to hide is a defect even
when the file is readable.

---

## 4. Coverage is counted, not categorical

Coverage is not `available` / `degraded` / `unavailable`. It is a set of
independent counts plus a ratio, so that a missing category lowers the
denominator instead of disappearing.

```rust
pub struct CoverageCounts {
    pub measured:  u64,   // the harness recorded it
    pub derived:   u64,   // the adapter inferred it
    pub lossy:     u64,   // present but degraded
    pub unmetered: u64,   // known to have happened; nothing else known
}
// ratio = (measured + derived) / total ; None when total == 0
```

`unmetered` is the load-bearing one. It is the third destination for data that
can be neither counted nor discarded — see §6. Because it sits in the
denominator, an adapter cannot quietly improve its own coverage number by
dropping what it could not read.

**Coverage is computed per session, not looked up per harness.** Codex proves this
is mandatory: `ThreadHistoryMode` is `Legacy` or `Paginated`, the two modes
persist different event vocabularies, and `ThreadSettingsSnapshot` — the record
that carries every other setting — does **not** contain the mode. The file does
not declare its own shape. The adapter's `shape` stage must probe it by
inspecting content, and `coverage` is its output, not a static property of the
harness id.

An adapter is a fixed five-stage pipeline (`locate → shape → extract → derive →
coverage`), **not a trait** — for the reason given in
[ARCHITECTURE.md §4.2](./ARCHITECTURE.md) and restated for this layer in §10 of
that document: harnesses differ in *which stages exist*, and a trait manufactures
empty implementations that hide exactly that.

### 4.1 Window is not coverage

A report over a requested window must never be labelled complete when the
underlying scan covered less of it. State the covered span, not the requested
one.

---

## 5. Provenance under aggregation

Per-datum provenance is not enough; summing rows of different provenance produces
a value whose provenance must be *computed*. `Mixed` is a first-class value, and
it narrows back to a pure value when a window happens to contain only one kind.

```rust
pub enum AggregateProvenance { Measured, Derived, Estimated, Lossy, Mixed, Unknown }

impl AggregateProvenance {
    /// Narrow a set-level provenance to what a particular window actually contains.
    pub fn for_window(set: Self, present: &ProvenanceSet) -> Self { /* … */ }
}
```

Without this rule, one estimated row silently taints an otherwise measured total,
or — worse — is absorbed into it.

---

## 6. Linearization, forks, and `unmetered`

Claude Code's transcript is a **tree** (`uuid` / `parentUuid`); Codex records
`thread_rolled_back`; DSH branches carry a `seedLength` prefix. In all three, the
log contains paths the user abandoned, and the choice of which path to count
changes every number in the report.

```rust
pub enum Linearization { LeafPath, AllRecorded }   // default: LeafPath
```

The default is `LeafPath` — the timeline the user actually ended up with. The
adapter must make the choice explicitly and record it.

**Abandoned and unresolvable material goes to `unmetered`, not to zero and not to
the floor.** A fork whose parent cannot be resolved is not priced, not dropped,
and not silently merged: it is counted as `unmetered` so the gap appears in the
coverage ratio. This generalises the rule already stated in `src/behavior.rs` for
`pre_fork` — "没分叉时是 null，不是全零结构" — and extends it: the excluded volume
must be reported, because a total that shrank without explanation reads as broken
data.

---

## 7. Overlapping sources must not be merged

Two evidence sources may describe the same traffic. A subagent session that is
also a top-level session file; a shared `~/.agents/skills` root projected into two
harnesses; a session log plus a separate usage log for the same run.

**Default to separate rows. Merging is opt-in and requires a proven disjointness
argument.** Silent merging double-counts, and double-counted totals are worse
than absent ones because they look plausible.

`crates/agent-vitals-core/src/domain/subagent.rs` already documents a live instance of
this hazard: of 19 subagent invocations in a real session, only 5 child sessions
pointed back at the parent; the other 14 were spawned before the fork. A
`SessionSet` layer sits above `CanonicalSession` and holds the overlap
declaration.

---

## 8. Cost

### 8.1 Units are not commensurable

```rust
pub enum Cost {
    Money   { amount: Decimal, currency: CurrencyCode },
    Credits (f64),
    Quota   (Vec<QuotaWindow>),
    Unavailable (Reason),
}

pub struct QuotaWindow {
    pub plan: String,
    pub used_percent: f64,
    pub window_minutes: u32,
    pub resets_at_ms: i64,
}
```

Amounts in different currencies are **never added and never ranked against each
other** — not summed into a total, not sorted into one leaderboard. WorkBuddy
meters credits (`session_usage.credit_json`), which are not tokens; credits must
not be converted into tokens and then priced.

**`Quota` is a third, distinct kind of cost, not a variant of `Credits`.**
Confirmed against a real 47-session Codex corpus: every `token_count` event
carries `rate_limits: { plan_type, primary: { used_percent, window_minutes,
resets_at }, credits: { has_credits, unlimited, balance } }`. On a subscription
account (`plan_type: "plus"` in 100% of the sampled sessions) `credits.has_credits`
is always `false` — there is no metered balance and no per-token dollar price to
report at all, only a percentage consumed against a rolling window that resets.
Reporting that as `Money` invents a unit price OpenAI does not publish; reporting
it as `Credits` conflates "spendable balance" with "quota percentage," which
silently misleads a reader who assumes `Credits(f64)` is summable the way a
balance is. `QuotaWindow` is a `Vec`, not one flattened number, because a plan
can carry more than one window at once (Codex's own `primary`/`secondary`
split — e.g. a weekly window plus a shorter burst window); collapsing that to a
single percentage is exactly the mistake §14.10 flags in `cc-switch`'s
`tiers[]` note. This field is unaffected by `ThreadHistoryMode` — `token_count`
is emitted in both Codex vocabularies (§13), so `Quota` costs are available
before the rest of the P4 Codex adapter's format-shape work lands.

### 8.2 Bucket sets are per harness

Four buckets is a DSH fact, not a universal one. Codex records six
(`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`,
`output_tokens`, `reasoning_output_tokens`, `total_tokens`); Claude Code records
input / cache-creation / cache-read / output plus
`output_tokens_details.thinking_tokens`. `reasoning_output_tokens` has no DSH
equivalent.

```rust
pub struct UsageBuckets(BTreeMap<BucketId, Observed<i64>>);
```

A bucket the source did not establish is **absent**, never `0`.

**And the same bucket name can mean different things.** This is sharper than
differing bucket sets, because it produces no error and no missing field — only
a number that is quietly too large.

In OpenAI-protocol responses, `input_tokens` **already includes** the cached
portion; in Anthropic-protocol responses it excludes it. Summing `input_tokens`
across providers without normalising counts cache reads twice. `cc-switch`
(§14.10) hit this and stores the answer per row:

```sql
input_token_semantics INTEGER NOT NULL DEFAULT 0   -- proxy_request_logs
```

The rule that follows:

> **A `BucketId` names a measurement convention, not just a field.** Two harnesses
> may only share a `BucketId` when they share the convention. When they do not,
> the adapter either normalises to one convention and records that it did, or
> emits distinct `BucketId`s — never a silent merge.

The same trap exists in reverse: a protocol may not report a bucket *separately*
even though the underlying quantity is non-zero. OpenAI-style responses carry no
cache-**creation** figure at all, so a naive adapter records `0`. That is the
invariant-12 violation again, and the correct value is absent.

### 8.3 The day-bucketing timezone belongs to the price table

`is_peak_slot` in `usage.rs` hardcodes Beijing time. That is correct *for
DeepSeek*, whose peak/off-peak rule is defined in that zone — the pinned zone is
part of the pricing rule, not a property of the reader. When a second harness is
added, the zone must travel with its price table. Re-bucketing the same history
under a different zone moves midnight-adjacent events and changes totals.

The zone is pinned when cost tracking is first enabled for a harness and stored;
it is not re-read from current settings on each scan.

---

## 9. Identity and join keys

Each harness uses a different key: DSH `seq`; Codex `turn_id` / `call_id`; Claude
Code `uuid` / `parentUuid` / `toolUseID`; WorkBuddy `toolCallId` / `requestId`.

```rust
pub struct EventId {
    pub harness_scope: ScopeId,   // numbering space: main session, or one subagent
    pub ordinal:    u64,       // adapter-local; ordering *within one scope* only
    pub native:     NativeId,  // Seq | Uuid | CallId | TurnId
}
```

**Cross-scope joins go through `native`, never through `ordinal`.** Adapter-local
ordinals are synthesized (Claude Code has no `seq` at all) and are not comparable
across scopes or adapters.

This is the structural form of a guard that already exists by hand: the
`skillAttribution` projection in `dsh-client/src/harness/index.ts` checks
`source_agent_id === null` before joining on `seq`, precisely because subagent
sessions use a different numbering space. A remembered guard becomes a type.

---

## 10. Rules declare what they need

```rust
pub struct RuleSpec {
    pub code:         &'static str,       // "SV601"
    pub requires:     &'static [Signal],  // missing one ⇒ Unavailable, rule does not run
    pub enhances:     &'static [Signal],  // missing ⇒ degraded, rule still runs
    pub min_fidelity: Fidelity,           // below this ⇒ `possible`, never `confirmed`
}
```

The engine produces, **for every rule, on every harness**, exactly one of three
outcomes:

```
N findings   |   measured, zero findings   |   Unavailable { missing: [Signal], reason }
```

Consequently the core's return type is `(Vec<Finding>, Vec<RuleOutcome>)`, not
`Vec<Finding>`.

This three-state output is the single non-negotiable property of this contract.
It is exactly what a "translate the harness into DSH events" adapter can never
deliver: with no approval events to translate, such an adapter reports zero
approval anomalies, and the report is quietly wrong.

### 10.1 Fidelity sorts, it never acquits

`Finding` carries `evidence: Provenance`. It participates in ordering. It does
**not** remove a finding from the count, and it never converts a finding into an
absence. This is the existing `is_cited` rule applied to a new axis: heuristics
sort, they never acquit (`max_severity` is authoritative; `max_severity_uncited`
only decides reading order).

Concretely, on WorkBuddy: a `rm -rf` match inside a `commandPreview` is a real
finding. The absence of a match is **not** the statement "no dangerous commands
were run" — it is "the evidence is lossy and cannot support that conclusion."

### 10.2 Folds must be resumable from a turn boundary

Every fold in the rule engine must be able to start from a checkpoint taken at a
turn boundary and consume only the events appended since, producing the same
result as folding the whole log.

This is not an optimisation. Measured on one developer machine:

| Harness | Largest single session log |
|---|---|
| Codex | **200 MB** |
| Claude Code | 33 MB (current session) |
| DSH | 8.5 MB (52 MB total, `.zstd`) |

A resident consumer that re-parses the whole log on every tick is not viable at
those sizes, and `watch` (PRODUCT §5.8) has three modes that all depend on this
property.

The requirement, stated as a rule:

```text
fold(events[0..n])  ==  fold_resume(checkpoint@k, events[k..n])
    for any k that is a turn boundary
```

Turn boundary, not arbitrary offset: `trajectory` groups by turn, and
`token_by_model` carries replacement state within a `(turn, step)`. A checkpoint
mid-turn would have to serialise that state; a checkpoint at a boundary does not.

Two things follow for adapters:

1. **The checkpoint is a value, not a process.** It is written to disk and read
   back by a different, short-lived process — see PRODUCT §5.8.4: xbar executes a
   script per tick and the script exits, so nothing of ours is resident.
2. **A compressed or non-append-only source cannot be resumed by byte offset.**
   DSH's on-disk logs are `session.jsonl.zstd`, and WorkBuddy's primary store is
   SQLite. Those adapters need their own checkpoint token (frame index, rowid,
   `updated_at`), which is why the checkpoint type is opaque and adapter-owned
   rather than a `u64` offset.

Folds that cannot satisfy this must say so in their `RuleSpec`, and the modes in
PRODUCT §5.8 that need them degrade to `unavailable` rather than silently
re-scanning.

---

## 11. Adapter result and the attempt trail

When a report says a signal is unavailable, the reader's next question is what
was tried. Free-text notes do not answer it structurally.

```rust
pub struct CanonicalSession {
    pub meta:     SessionMeta,          // id, harness, workspace roots, model, span
    pub signals:  SignalSet,
    pub coverage: Coverage,
    pub attempts: Vec<SourceAttempt>,   // structured, not prose
    pub notes:    Vec<AdapterNote>,
}

pub struct SourceAttempt {
    pub source_id:  &'static str,       // "codex.rollout.jsonl", "workbuddy.audit-log"
    pub kind:       SourceKind,         // LogFile | Sqlite | BlobStore | RuntimeProbe
                                        //   | HookStream | TelemetryExport   (§14.8.3)
    pub surface:    Surface,            // SessionLog | Telemetry | Hook
    pub available:  bool,
    pub error:      Option<String>,
    /// The span this source actually covers. Never assume it equals the
    /// report window: surfaces 2 and 3 begin when they were configured (§14.8.6).
    pub observed_span: Option<TimeSpan>,
}
```

An adapter error degrades only the affected signal. Failure to read one source
must not discard the signals another source already supplied — the same rule the
install-time contract states for filesystem measurements.

---

## 12. Harness-specific data does not travel in shared types

Shared types (`CanonicalSession`, `Coverage`, `RuleSpec`, the fetch context)
must contain no harness-specific fields. Harness-specific data lives in an opaque
per-harness payload keyed by harness id.

This rule has a test: assert that no identifier in the shared type layer contains
a harness name. It exists because the failure is gradual and invisible per commit —
one Claude-specific recovery flag in a shared context is harmless; after enough
harnesses the "generic" layer is a union of every harness's quirks and no longer
supports adding the next one cheaply.

---

## 13. Harness coverage matrix

Runtime counterpart to the install-time matrix in
[PRODUCT_CAPABILITY_MATRIX.md](./PRODUCT_CAPABILITY_MATRIX.md).

Rows are signals; each cell states availability and, where relevant, fidelity or
provenance. **Codex occupies two columns because `ThreadHistoryMode` produces two
incompatible vocabularies** (§4).

| Signal | DSH | Codex (Legacy) | Codex (Paginated) | Claude Code | WorkBuddy |
|---|---|---|---|---|---|
| ToolCalls | measured | measured | measured (**argv + cwd + exit code + output**) | measured | measured (`span.name`) ※ / lossy in audit-log |
| ToolResults | measured (6 error codes) | measured | measured | measured (different error vocabulary) | measured (`span.status` + `span.error`) ※ |
| TurnBoundaries | measured | measured (`task_started`/`task_complete`) | measured | **derived** (+ `system/turn_duration`) | derived (one trace = one run) ※ |
| StepBoundaries | measured | unavailable | unavailable | derived | unavailable |
| Usage (per request) | measured (4 buckets) | measured (6 buckets) | measured | measured (4 + thinking) | unverified (`generation` spans exist; per-span tokens unchecked) ※ |
| UsageAggregate | derivable | derivable | derivable | derivable | measured (credits) |
| ContextWindow | measured | measured (`model_context_window`) | measured | unavailable | unavailable |
| QuotaConsumption | unavailable | measured (`token_count.rate_limits`) | measured | unavailable | unavailable ⁶ |
| ApprovalDecisions | measured | unavailable in rollout ‡ | partial (`FileChangeItem.auto_approved`) ‡ | **partial** — denials only, derived+lossy ¶ | **measured** (hash-chained) |
| ApprovalPolicy | measured (`sandbox/mode`) | **measured** (`ThreadSettingsSnapshot`) | same | measured (`permission-mode`) | measured (`sessions.permission_mode`) |
| SandboxModes | measured | unavailable | unavailable | unavailable | measured |
| NetworkAccess | unavailable | unavailable | unavailable | unavailable | **measured** |
| Compaction | measured (+ shadowed tokens) | measured (+ `replacement_history`) | measured | lossy (`compact_boundary`, no volume) | unavailable |
| SubagentSpawns | measured | measured | measured (**+ parent→child link**) | measured (`isSidechain` / `Task`) | measured (`type:'agent'` + `parentId` tree) ※ |
| SkillInvocations | measured | **derived** (not persisted; §14.3) | derived | derived (`Skill` tool call) | unavailable |
| Hooks | measured | **unavailable — not persisted by design** | **measured** (`HookPromptItem`) | lossy (`stop_hook_summary`) | unavailable |
| FileMutations | measured | lossy (`patch_apply_end` only) | **measured** (`FileChangeItem` + status) | derived (from tool calls) | measured (`file-history/`) |
| Tool-call duration | measured | **unavailable** (no begin/end pair) | **not consumed** (`CommandExecutionItem.duration` is observed microseconds, not verified wall time) | derived | **measured** (`span.duration`) ※ |
| Workspace root | `cwd` | `turn_context.workspace_roots` | same | `cwd` | `sessions.cwd` |
| Storage medium | JSONL | JSONL | JSONL | JSONL | SQLite + JSONL + **span-tree JSON** + blobs |
| Process liveness | unavailable | unavailable | unavailable | unavailable | partial (`workerPid`, `status:"running"`) — see §16.1 |

> ⁶ **WorkBuddy QuotaConsumption 单元格已滞后于代码**（2026-09-11，spec §10 B6）：`session_usage.credit_json` 的每个 requestId 条目是执行环境报告的一次配额消耗，代码已改 **measured（分子）**；分母（allowance/余额）不可观测由 note 说明。按 G5 在 `tests/test_harness_contract.py::_REGISTERED_DEVIATIONS` 登记，单元格保留原文以让登记项继续「与原矩阵不一致」（该测试的反向校验要求）。

`¶` — recoverable from the Claude Code transcript **without a hook**, by
matching marker strings in tool-result text (§14.5). Denials only: grants leave
no trace, so **SV614c (dangerous mode repeatedly *granted*) stays `unavailable`**.

`※` — from `~/.workbuddy/traces/` (§14.6), found only on a second pass. Cells
marked `※` are read off a sampled span schema and have **not** been reconciled
against a full corpus.

`‡` — **session-log surface only.** Codex and Claude Code both emit approval and
sandbox evidence over an opt-in OpenTelemetry channel that this table does not
cover; see §14.8. A cell marked `‡` means "not in the durable session log", not
"this harness has no such evidence anywhere."

Hermes and OpenClaw appear in the install-time matrix but are absent here: no
instance of either existed on the audited machine, so their runtime evidence
surfaces are unmeasured. §14.9 records second-hand leads for both (skill roots
and hook backends) — leads, not measurements. They stay out of this table until
verified against a real corpus. CodeBuddy is likewise absent: it is not in the
product's harness list, and what §14.9 records about its transcript shape is
second-hand.

Every cell above is derived from either upstream source code or a first-party log
corpus; see §14.

---

## 14. Evidence

### 14.1 Codex — authoritative, from source

`codex-rs/rollout/src/policy.rs::is_persisted_rollout_item` is the authority on
what can appear in a rollout file. Its `false` arm names, among others:

```
ExecApprovalRequest · ApplyPatchApprovalRequest · RequestPermissions
ExecCommandBegin · ExecCommandEnd · ExecCommandOutputDelta
HookStarted · HookCompleted
PatchApplyBegin · PatchApplyUpdated · TurnDiff
GuardianAssessment · GuardianWarning · SafetyBuffering
```

These are **not** absent because of a local configuration; they are excluded from
persistence upstream. This function is the citation for the Codex `unavailable`
cells in §13 — but only for `Legacy`, and only for the log surface (§14.8).

`ThreadHistoryMode { Legacy, Paginated }` gates a second set: in `Paginated`,
`UserMessage`, `AgentMessage`, `PatchApplyEnd`, `ContextCompacted`,
`McpToolCallEnd`, `WebSearchEnd`, and `SubAgentActivity` are not persisted and
are replaced by `ItemCompleted(TurnItem)`. `ThreadSettingsSnapshot` does not
carry the mode, so it must be probed.

**`Paginated` is not a reduced `Legacy`; for several signals it is strictly
richer.** `TurnItem` (`codex-rs/protocol/src/items.rs`) carries typed items that
have no Legacy equivalent:

| `TurnItem` variant | Fields that matter | Signal it supplies |
|---|---|---|
| `CommandExecution` | `command: Vec<String>` (argv), `cwd`, `parsed_cmd`, `status`, `exit_code`, `stdout`/`stderr`, **`duration`** | ToolCalls at higher fidelity **and tool-call duration**, which Legacy cannot supply at all |
| `FileChange` | `changes`, `status`, **`auto_approved`** | FileMutations, plus a partial approval Occurrence |
| `HookPrompt` | `fragments` | Hooks — `unavailable` in Legacy |
| `SubAgentActivity` | `agent_thread_id`, `agent_path` | SubagentSpawns **with an explicit parent→child link** |
| `McpToolCall`, `ContextCompaction`, `DynamicToolCall` | — | typed equivalents of Legacy's event forms |

An adapter that treats `Paginated` as "Legacy minus some events" will under-report
on every row above. This is the concrete reason the `shape` stage exists.

### 14.2 Codex — policy is recorded even when events are not

`EventMsg::ThreadSettingsApplied` is persisted in **both** modes and carries
`ThreadSettingsSnapshot { approval_policy: AskForApproval, approvals_reviewer,
permission_profile, active_permission_profile, cwd, model, model_provider_id,
service_tier, … }`, where `AskForApproval` is `UnlessTrusted | OnRequest |
Granular(GranularApprovalConfig) | Never`. This is the basis for the
Occurrence/Policy split in §3.1.

### 14.3 Codex — skill invocation is inferred, not recorded

`codex-rs/skills/src/invocation.rs::detect_implicit_skill_invocation_for_command`
recognises a skill document read or script run by inspecting a shell command at
runtime. The result is not persisted. Offline, `SkillInvocations` can therefore
only be `Derived`, by re-running an equivalent heuristic.

**Do not port Codex's heuristic.** A fifth implementation to keep in lockstep is
a worse outcome than an honest `Derived` marker stating that the offline
inference may disagree with the harness's runtime decision.

### 14.4 Codex — no format version

`RolloutItem` derives `JsonSchema` and `TS`, but no generated schema is checked
in, and `SessionMetaLine` carries a hand-written `Deserialize` that back-fills
`session_id` from a legacy `id` field. The format evolves behind compatibility
shims and exposes no version number.

Consequence: agent-vitals' DSH strategy — "`SESSION_FORMAT_VERSION` mismatch ⇒
degrade the whole read" — **cannot be applied to Codex.** Codex degrades by
existence probing: unknown item types are skipped and recorded in `attempts`,
never treated as corruption. The version check remains DSH adapter–private and is
not part of this contract.

Because the format is unversioned and upstream is under active development, a
schema-drift sentinel is required: generate `RolloutItem`'s JSON Schema from
upstream, check it in, and diff it in CI. Without it, an upstream change to the
persistence policy silently removes a whole signal class.

### 14.5 Claude Code — from a first-party corpus

Measured against a 14,575-line transcript. Structure is a message tree
(`uuid` / `parentUuid`), not an event stream; `type` is a role
(`assistant` / `user` / `attachment` / `system`), not an event kind. There is no
`seq`.

- Tool calls: `message.content[]` blocks of type `tool_use` (`id`, `name`,
  `input`, `caller`); results arrive as `toolUseResult` on the following user
  message.
- Usage: `message.usage` — `input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `output_tokens`,
  `output_tokens_details.thinking_tokens`, plus `service_tier` and
  `cache_creation.ephemeral_{5m,1h}_input_tokens`.
- Turn duration: `system` records with `subtype: turn_duration` carrying
  `durationMs`.
- Compaction: `system` / `compact_boundary` — a marker with no pruned-token
  volume, hence `lossy` rather than `measured`.
- Hooks: `system` / `stop_hook_summary` (`hookCount`, `hookErrors`, `hookInfos`,
  `toolUseID`) — partial.
- Subagents: `isSidechain`, plus `Task` tool calls.
- Skills: `Skill` tool calls.
- Approvals and sandbox: no records. `permission-mode` entries are Policy-class
  only.

**Two friction signals are recoverable without a hook, by string marker.** The
CLI writes recognisable text into the transcript, and `Tencent/teamai-cli`
(§14.9) extracts both from it:

```text
user interrupt   entry text starts with  "[Request interrupted by user"
user rejection   tool_result contains    "The tool use was rejected"
                                      or "doesn't want to proceed with this tool use"
```

This is what moves Claude Code's `ApprovalDecisions` cell from `unavailable` to
`partial`, and it needs no hook and no configuration — it is retroactive like the
rest of surface 1.

**But it is a UI string, not an API contract.** It carries no version, no schema,
and no compatibility promise; a wording change breaks it silently, and it is
English-only. Mark it `Derived` + `Lossy`, keep the matched strings in one named
constant rather than inline, and add a fixture that fails when a real corpus
stops matching. Denials only — a *granted* permission leaves no marker at all,
which is why SV614c stays unavailable regardless.

**Usage must be deduplicated per assistant message.** One turn spans many JSONL
lines and Claude Code repeats the same `message.usage` object on every
content-block line; naive summation over-counts by a large factor. The dedup key
is `message.id`, falling back to the top-level `requestId`. This is the same
defect class the DSH fold already handles with its `(turn, step)` replacement
logic in `usage.rs` — two independent implementations converged on it, so treat
it as universal rather than harness-specific. (Independently confirmed by
`Tencent/teamai-cli`'s `scanTranscriptStop`; see §14.9.)

### 14.6 WorkBuddy — from a first-party install

- `~/.workbuddy/workbuddy.db` (SQLite): `sessions` (id, cwd, model, mode,
  `permission_mode`, `use_sandbox_cli`, expert fields) and `session_usage`
  (`used`, `size`, `credit_json`) — one aggregate row per session. **No
  transcript.**
- `~/.workbuddy/audit-log/*.jsonl`: hash-chained security decisions —
  `category` (`command-safety`, `network`), `eventType`
  (e.g. `command-safety.sandbox-executed`), `decision`, `commandHash`,
  `commandPreview`, `toolCallId`, `requestId`, `sessionId`; `segment-closed`
  records carry `firstHash` / `lastHash` / `fileSha256`.
- `~/.workbuddy/file-history/<sessionId>/<hash>@v<n>`: file version history.
- `~/.workbuddy/sessions/*.json` is a **process heartbeat registry** (pid,
  `lastHeartbeat`, cwd), not a session transcript. Do not mistake it for one.
- `~/.workbuddy/blobs/` is content-addressed **image** storage (`<sha>.png`), not
  transcripts. Checked.
- **`~/.workbuddy/traces/<pid>/trace_<id>.json` — 670 files, 652 MB.** An
  OpenTelemetry-shaped local span store, and by far the richest WorkBuddy surface:

```jsonc
{ "trace": { traceId, name: "Agent workflow", workerPid, startedAt, endedAt,
             duration, status, spanCount, totalTokens, sessionId },
  "spans": [ { traceId, spanId, parentId, name, type,
               startedAt, endedAt, duration, status, error }, … ] }
```

  Sampled span content: `type` ∈ {`custom`, `generation`, `function`, `agent`};
  `name` carries real tool names (`Read`, `Edit`, `WebSearch`, `mcp_tools`,
  `cli`); `status` ∈ {`ok`, `running`, `error`}. `parentId` gives a tree.
  `~/.workbuddy/observability-adapter-state.json` tracks which traces have been
  exported, so this is a maintained store rather than debug residue.

Commands reach the *audit log* as a preview plus a hash. This is the origin of the
`Lossy` axis and of the convict-but-never-acquit rule in §10.1 — but note it
applies to that surface, not to the trace store.

#### The investigation error this section records

The first pass of this document concluded, from two directories, that
**"WorkBuddy has no transcript at all"**, and §1 used that as one of three
load-bearing arguments for the whole design. The trace store was in a third
directory, unexamined.

The conclusion survives in weakened form — WorkBuddy has no *conversation*
transcript, and its evidence surface really is complementary to Claude Code's —
but the stronger and more accurate statement is different:

> **Evidence is not merely uneven across harnesses; within a single harness it is
> scattered across three or four unrelated stores with different formats,
> different retention, and different fidelity.** WorkBuddy alone has SQLite +
> hash-chained JSONL + a span-tree store + a blob store + a heartbeat registry.

This is precisely what §11's `SourceAttempt` trail exists to make visible: an
adapter reporting `unavailable` must say what it tried. **The requirement was
written for adapters and then violated by this document's own investigation.**
Treat every `unavailable` cell in §13 as provisional until the adapter that
produces it enumerates its attempts.

### 14.7 Prior art — CodexBar

[steipete/CodexBar](https://github.com/steipete/CodexBar) (MIT) is a macOS
menu-bar app tracking quota and cost across 69 providers. It is not a behaviour
auditor, but it is the only mature project that has solved "N heterogeneous
harnesses, each with a different evidence surface" at scale, and several rules in this
document are adopted from it:

- `CostProvenance` — provenance as a type, with `isBillingReceipt` hardcoded to
  `false` so the type itself cannot claim authority (§2).
- `CostProvenance.forWindow(...)` — provenance propagation through aggregation,
  with `mixed` as a narrowable first-class value (§5).
- `CostUsageCoverageCounts { priced, unpriced, unmetered, estimated }` and its
  ratio — coverage as counts, "so a missing category is `0` rather than
  collapsing into another bucket" (§4).
- `CostUsageScanner+ForkCoverage` — "Missing-parent forks stay out of priced
  totals. Count them as unmetered so Spend coverage can show the gap instead of
  silently dropping the session." (§6).
- `CostUsageTokenMix` — every bucket `Int?`, "`nil` means the source did not
  establish that class — never treat as zero" (§8.2). Independently derived, and
  identical to this repo's own invariant 12.
- Non-merging of overlapping sources: native Codex sessions and OpenCodex logs
  stay on separate rows because "merging would double-count the same traffic"
  (§7).
- Never adding *or ranking* across currencies (§8.1); a pinned IANA timezone
  stored at first enable (§8.3); a requested window not labelled complete when
  the scan covered less (§4.1).
- `ProviderFetchOutcome { result, attempts }` — a structured attempt trail (§11).
- UI enforcement worth adopting: a day with no coverage "is a gap, not zero
  activity, and is not clickable." Make a fabricated zero physically unreachable
  rather than annotated.

Two anti-patterns observed there and prohibited by §12: harness-specific fields
accumulating in the shared fetch context (`claudeOwnerCLIRecoveryOnly`, a
hardcoded Antigravity session shutdown, a `.kiro` branch inside a generic error),
and a 278 KB single-type scanner.

**Scale calibration.** CodexBar's `Vendored/CostUsage/` is roughly 530 KB of
Swift covering the *cost slice only*, for *two* harnesses, backed by 909 test files,
with dedicated modules for fork coverage, truncated prefixes, source priority,
report reconciliation, timestamps, subagent rollout shape, and a fast JSON path.
A runtime adapter is a subsystem, not a file. Plan accordingly.

---

### 14.8 Evidence surfaces beyond the session log

The matrix in §13 surveys **durable session logs only**. There are at least three
other surfaces, and they carry different signals with different preconditions.

| # | Surface | Retroactive | Precondition | Position | Schema |
|---|---|---|---|---|---|
| 1 | Session log | **yes** — readable after the agent exits | none | outside | harness-defined, N of them |
| 2 | OTel export | no | exporter configured *before* the session | outside | semi-standard |
| 3 | Self-installed hook | no | hook installed *before* the session | **in the decision path** | ours, one of them |
| 4 | Reverse proxy | no | the agent's base URL repointed at us | **in the data path** | ours, one of them |

Only surface 1 answers the question this product exists to answer, and only
surface 1 requires nothing of the user before the session it reports on. The
others are additive, never substitutes.

The `Position` column is the one that decides what this product may do. Surfaces
1 and 2 observe from outside. Surface 3 puts our code where a decision is made
(§14.8.4). Surface 4 puts our code where the traffic flows (§14.8.5). Both of
the latter are out of bounds here, for the same reason stated in different
strengths.

#### 14.8.1 Opt-in telemetry

Both Codex and Claude Code emit agent activity over OpenTelemetry, and this
surface does not carry the same signals as the log.

Codex's `codex-rs/otel/src/events/session_telemetry.rs` emits, among others:

```
codex.tool_decision   { decision: ReviewDecision, … }   ← the approval decision
codex.sandbox_outcome { … }
session telemetry     { approval_policy, sandbox_policy }
```

`ExecApprovalRequest` is excluded from the rollout file (§14.1) **and** the
decision is exported over OTel. "Codex does not record approvals" is therefore
false as stated; the correct statement is "Codex does not persist approvals to
the rollout file, and exports the decision over OTel when an exporter is
configured."

Claude Code has the equivalent channel: `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus
`OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` produce metrics and structured
events over OTLP, with distributed traces behind
`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`. Enterprise deployments can enable it via
managed settings, so on a managed machine this surface may already exist.

Consequences for this contract:

1. **Availability is per (harness, surface), not per harness.** A signal absent from
   the log may be present in telemetry. The §13 matrix needs a second sheet
   before any `unavailable` cell touching approvals or sandboxing is final.
2. **The telemetry surface has a precondition the log surface does not**: it must
   have been configured *before* the session ran. It is never retroactive. This
   is a distinct degradation reason — `unavailable(not configured at the time)` —
   and it belongs in the `locate` stage, not in the rule engine.
3. **It is push, not pull.** There is no file to read; the data went to whatever
   collector was configured. Supporting it means reading a collector's store,
   which is a different adapter shape from every harness in §13 and should not be
   assumed to be in scope without a decision.
4. Alignment with the OTel GenAI semantic conventions (`gen_ai.usage.*`,
   `gen_ai.client.operation.duration`, agent/tool spans) should be evaluated for
   the *naming* of overlapping signals. The conventions are span-oriented and
   have no vocabulary for approval decisions, sandbox modes, skill invocation, or
   coverage/provenance — so alignment means borrowing names for the overlap, not
   adopting the model.

#### 14.8.2 Self-installed hooks

`Tencent/teamai-cli` (§14.9) takes the third route: it installs a hook into each
harness, receives events on the hook's STDIN, and writes its own `events.jsonl`.
This sidesteps the N-format problem entirely — the schema is the tool's own — and
it collapses N harnesses into three hook formats plus two special backends.

Its normalized vocabulary is five values:

```ts
type DashboardEventType = 'session_start' | 'tool_use' | 'prompt_submit'
                        | 'stop' | 'process_exit';
```

> **Correction.** An earlier revision of this section presented those five values
> as *the ceiling of the hook surface*. They are not — they are one tool's
> design choice. Claude Code alone exposes **31 hook events**, including
> `PermissionRequest`, `PermissionDenied`, `StopFailure`, `PostToolUseFailure`,
> `SubagentStart`/`SubagentStop`, and `PreCompact`/`PostCompact` — i.e. most of
> the control plane that its transcript omits. Every payload also carries
> `permission_mode` (a Policy signal) and `transcript_path` (the session
> pointer). See §14.8.4.

What hooks do *not* carry is per-request token usage or context-window size.
teamai-cli therefore reads the transcript anyway: the hook payload supplies
`transcript_path`, and the collector tail-reads that file. **The hybrid is
structural, not a workaround** — hooks are the control plane, the log is the cost
plane.

**The useful half of this design is the split, not the hook.** The hook supplies
the *session pointer and lifecycle* — which file, and when it stopped being
written — and the log supplies the detail. agent-vitals answers the pointer
question today by globbing directories and guessing at liveness. The same split
can be had **without writing anything into the user's configuration**, by using
the harness's own session registry as the pointer: WorkBuddy's `sessions` table and
its `~/.workbuddy/sessions/*.json` heartbeat files (§14.6) are exactly that.

#### 14.8.3 Why surface 3 is probably not optional forever

Read §13 by row rather than by column and a structural problem appears: the
signals with the **thinnest log coverage are the highest-value security
signals**.

| Signal | Harnesses with it in the log |
|---|---|
| ApprovalDecisions | DSH, WorkBuddy, Claude Code (denials only, §14.5) |
| SandboxModes | DSH, WorkBuddy |
| NetworkAccess | WorkBuddy only |
| Tool-call duration | DSH, Codex (Paginated) |

This is not an accident of effort. These are **operational** events, not
conversational ones; a session log exists to reconstruct a conversation, so
transient control-plane decisions are the first thing its designers drop —
`policy.rs` shows Codex doing exactly that, deliberately (§14.1).

The consequence: **for approval and sandbox coverage on Claude Code and Codex,
the log route is permanently closed.** Not expensive — closed, by upstream
design. Only surfaces 2–4 remain: surface 2 has a stricter precondition (a
configured collector) than surface 3 (a hook the tool installs itself), and
surface 4 is excluded outright (§14.8.5). None of the three is retroactive.

So surface 3 should be treated as a likely future requirement, not a rejected
alternative. What that costs is a change in what the product *is* — agent-vitals
is read-only today, and installing hooks writes into the user's agent
configuration. That decision is not taken here. What this contract does require
is that taking it later must not need a rewrite:

1. `Coverage` is keyed by **(signal, surface)**, never by signal alone.
2. `SourceAttempt.kind` must already admit `HookStream` and `TelemetryExport`
   alongside the file-based kinds (§11).
3. A `Finding` records the surface it came from. Two surfaces do not carry the
   same trust or the same time span, and a report that merges them without
   saying so is the §7 double-counting hazard in a new costume.
4. §14.8.6 — the ragged left edge — must be enforced from the first surface-3
   adapter, not retrofitted.

#### 14.8.4 Claude Code's hook surface, and one rule it forces

Mapping the trajectory detectors (SV611–SV614) onto Claude Code shows precisely
where a hook is and is not needed:

| Rule | Needs | Claude Code log | Hook required? |
|---|---|---|---|
| SV611 repeated tool call | `(name, arguments)` signature | ✅ `tool_use.input` | no |
| SV612 dead loop | turn grouping | ⚠️ derived (`promptId`, `turn_duration`) | no — a hook only improves precision |
| SV613b tool-level stall | consecutive tool errors | ✅ `tool_result.is_error` | **no** |
| SV613a LLM-level stall | "turn ended in an LLM error" | ❌ no equivalent | yes → `StopFailure` |
| SV614 permission anomaly | approval asked/decided | ❌ | yes → `PermissionRequest` / `PermissionDenied` |

The commonly assumed answer — "we need hooks to get the trajectory rules" — is
wrong for the majority of them. Three of the five already work off the log today.

**But the two that do need hooks are not equally safe to install**, and that
produces a rule this contract did not previously state:

> **An audit tool must not enter the decision path of the thing it audits.**

Claude Code's documentation is explicit: the `PermissionRequest` hook *does not
receive* the decision — the hook's **output determines whether the tool call is
allowed or denied**. A hook installed there is not an observer; it is a
participant. A bug, a timeout, or an unexpected JSON shape in our code could
block or permit a tool call in the user's agent.

This is a different and larger category than "writing to the user's config":

| | Nature | Reversible |
|---|---|---|
| Writing config | changes a file | yes |
| **Entering the decision path** | **an audit tool can change the behaviour of what it audits** | not after the fact |

Consequences, binding:

1. **Never subscribe to a hook event whose output participates in a decision.**
   `PermissionRequest` is out of bounds for this product.
2. Post-hoc notification events (`PermissionDenied`, `StopFailure`,
   `PostToolUseFailure`, `SubagentStop`, `PostCompact`) are acceptable, because
   the decision has already been made when they fire.
3. Accept the resulting gap honestly: with `PermissionDenied` alone we observe
   refusals but not grants, so **SV614c (dangerous mode repeatedly *granted*)
   stays `unavailable`** on Claude Code. Report it as such; do not approximate it
   from denials.

#### 14.8.5 The reverse-proxy surface, and the rule it extends

`cc-switch` (§14.10) obtains usage by **being the proxy**: the agent's base URL
is repointed at it, every request passes through, and it writes its own
`proxy_request_logs` table. The data that yields is strictly better than any log:

```sql
latency_ms, first_token_ms, duration_ms, status_code, is_streaming,
error_message, input_tokens … cache_creation_tokens, total_cost_usd
```

`latency_ms`, `first_token_ms`, `status_code` and `is_streaming` appear in **no
session log on any harness surveyed here**. They are only observable from the wire.

This surface is nevertheless out of bounds for this product, and the reason is
the same one as §14.8.4 at a higher strength:

| Surface | Where our code sits | Failure blast radius |
|---|---|---|
| Hook (`PermissionRequest`) | in the **decision** path | one tool call allowed or blocked wrongly |
| **Reverse proxy** | in the **data** path | **the agent stops working** |

If the proxy is down, slow, mangles a model name, or mis-handles a streaming
response, the agent it audits fails. An audit tool that can take down its subject
is not an audit tool.

For `cc-switch` this is not a defect — being in the path *is* its function; it is
a switcher, and routing is the product. The distinction to keep is therefore
about role, not about technique:

> **A tool may sit in the traffic path when routing is what the user asked it to
> do. A tool that was asked only to observe may not.**

One consequence worth recording rather than regretting: `latency_ms` and
`first_token_ms` are **permanently unavailable** to this product on every harness.
They are not unimplemented; they are unobservable from where we stand. Report
them as `unavailable(not observable from a log)`, alongside process liveness
(§16.1).

#### 14.8.6 Mixed surfaces have a ragged left edge

Surface 1 covers all retained history. Surfaces 2 and 3 cover only the period
since someone configured them. A report drawing on both therefore has a
**different time span per signal**, and the shortest one is invisible unless it
is stated.

> "0 approval anomalies in the last 30 days" is a lie when the hook supplying
> approval data was installed three days ago.

This is §4.1 (window is not coverage) applied across surfaces, and it is
strictly worse there, because the gap is not a scan-window shortfall the tool can
measure — it is a period during which the evidence never existed.

**Every signal carries its own observed span.** A report states the span per
signal, or states the narrowest span for the whole report; it never presents the
union window as if every signal covered it.

### 14.9 Second-hand evidence — `Tencent/teamai-cli`

[`Tencent/teamai-cli`](https://github.com/Tencent/teamai-cli) (MIT) distributes
skills, rules, and docs *into* Claude Code / Codex / CodeBuddy / WorkBuddy /
OpenClaw / Hermes and ~27 more. It is the write-side mirror of this product's
read-side problem, over substantially the same harness set.

> **Provenance of this section is weaker than §14.1–14.7.** Those cells come from
> upstream source code or a first-party log corpus. Everything below is read out
> of *another tool's* source and comments. It is a lead, not a measurement.
> **No §13 matrix cell may depend on it until re-verified against a real corpus.**

#### What it supplies

| Harness | Fact | Where |
|---|---|---|
| **CodeBuddy** | Transcript is a single `index.json` document: `{ messages: [{ role }], requests: [{ usage: { inputTokens, outputTokens, totalTokens } }] }` — **not** JSONL, and **no cache read/creation split at request level** | `readCodebuddyIndexOnce` |
| **WorkBuddy** | `~/.workbuddy/settings.json` (verified by them on 5.2.0); hooks use the Claude-style settings injection path, same as CodeBuddy | `hooks.ts` |
| **Hermes** | `~/.hermes/skills`; hook backend is `config.yaml` | `hermes-config.ts`, `hermes-hooks.ts` |
| **OpenClaw** family | hook backend is `HOOK.md` + `handler.ts`; family covers `openclaw`, `qclaw`, `easyclaw`, `autoclaw` | `openclaw-hooks.ts` |
| **CodeBuddy IDE** | Tool names differ from CLI form: `execute_command`→`Bash`, `search_content`→`Grep`, `write_to_file`→`Write`, `replace_in_file`→`Edit`, `list_dir`→`Glob`, `read_file`→`Read`, `task`→`Task` | `utils/tool-names.ts` |

None of it closes the approval / sandbox / tool-duration gaps for these harnesses —
hooks do not carry those either.

#### Why its adaptation strategy does not transfer

Its harness registry is a flat table, one line per harness, **zero harness-specific code**
for the common case:

```ts
{ id: 'claude', displayName: 'Claude Code', category: 'coding', skillsPath: '.claude/skills' }
```

The comment states the precondition: *"agents whose skills directory layout is
**predictable** (`~/.<id>/skills/`)"*. Where that breaks — hooks — 33 harnesses
collapse to `type ToolFormat = 'claude' | 'cursor' | 'codex'` plus two backends,
with `'claude'` as the fallback. Claude Code's format and Claude Code's tool
names are its de-facto IR, deliberately.

**Writing to a convention is symmetric across harnesses; reading truth is not.**
Writing requires only that the harness *look* in an agreed place. Reading requires
the harness to *report* what it did, and each harness reports differently or not at
all. This is why a one-line-per-harness table is sufficient there and insufficient
here, and why §13 is a matrix rather than a list.

One consequence is directly instructive. Where a target lacks an event, its hook
writer does:

```ts
const cursorEvent = CLAUDE_TO_CURSOR_EVENTS[def.event];
if (!cursorEvent) continue;   // event Cursor doesn't support → skip
```

Skipping is correct for a writer — one cannot install a hook for an event that
does not exist. The same action in a reader is fabrication. **The correct
behaviour for a missing capability is opposite in the two directions**, which is
why a read tool cannot borrow a write tool's harness abstraction wholesale.

#### The violation this contract exists to prevent

`readCodebuddyIndexOnce` returns four fabricated zeros in one function, each one
directly beneath a comment acknowledging the data is unavailable:

```ts
// CodeBuddy reports no cache-read/creation split at the request level,
// so those map to 0
tokens.input  += toNum(usage.inputTokens);
tokens.output += toNum(usage.outputTokens);
…
// CodeBuddy transcripts don't expose interrupt / tool-reject / tool-error markers.
return { interrupt: 0, toolReject: 0, toolError: 0, tokens, prompts };
```

A CodeBuddy session therefore renders as "cache read 0 / interrupts 0 / tool
rejects 0" — indistinguishable from a genuinely clean session. This is invariant
12 and §10's three-state output violated four times, by a competent shipping
tool, in exactly the place this contract predicts. It is the strongest available
argument for making the distinction a type rather than a convention.

#### Friction gating — an alerting design worth copying

Its Stop hook decides whether a session was *worth interrupting the user about*,
which is a different question from whether findings exist:

```text
Layer 1 (≈1ms)  toolCount < BASE_THRESHOLD            → exit
Layer 2 (lazy)  score = f(interrupt, toolReject, correction, toolError)
                score < SMART_THRESHOLD               → exit
Hard gate       toolCount < BASE_THRESHOLD (=15)      → exit, whatever the score
                → emit ONE hint, listing only the non-zero signals
```

Four properties, all of which this product currently lacks — `doctor` reports
whatever it finds, every time it is run:

1. **A long, smooth session does not qualify.** Many tool calls with no friction
   is success, not a subject. The gate is "did the user have to fight", not "is
   there data".
2. **A hard gate independent of the score.** A one-command session the user
   rejected scores high and is still not worth reporting. Severity alone is not
   a reason to interrupt.
3. **Only the signals that actually fired are named.** No zero rows.
4. **At most one hint per session**, via a persisted `hinted` flag, so a cache
   hit on a later Stop does not re-emit.

The scoring itself is coarse — four weighted counters — and is *weaker* than
SV611–SV614, which carry thresholds, evidence and `run_end_seq` ranges. The part
worth taking is the gate, not the score.

**Scope boundary.** teamai-cli's purpose is to capture team knowledge; a
`/teamai-share-learnings` skill writes a summary to a shared repo. Adopting that
flow wholesale would turn this product into a knowledge base, which
[PRODUCT §2.2](./PRODUCT.md) excludes. What transfers is the *trigger*, not the
*action*: at end of session, if SV611–SV614 fired, say so once. See
[PRODUCT §5.8.5](./PRODUCT.md) — and note that this needs no hook at all, because
a `watch` tick observing the log stop growing reaches the same moment without
writing anything into the user's configuration.

#### Practices worth adopting

- **Redact before truncating.** Their transcript reader redacts and *then*
  slices, "so a placeholder (not a raw token fragment) is what lands near the
  length boundary." Verify agent-vitals' export path does the same ordering.
- **The pointer/detail split** — see §14.8.2.
- **Per-assistant-message usage dedup** — see §14.5.

### 14.10 Prior art — `cc-switch`

[`farion1231/cc-switch`](https://github.com/farion1231/cc-switch) is a Tauri app
managing Claude Code / Codex / Gemini CLI / OpenCode / OpenClaw / Hermes — again
close to this product's harness list. It answers "quota" and "usage" by two
completely separate paths, and neither resembles surface 1.

**Quota — a sandboxed JavaScript plugin.** Each provider's quota query is a
user-supplied script run in an embedded QuickJS runtime
(`src-tauri/src/usage_script.rs`), in three phases with network I/O held by Rust:

```text
① JS evaluates  → RequestConfig { url, method, headers }   (JS has no network)
② Rust          → send_http_request(&config)
③ JS (fresh ctx)→ config.extractor(response) → normalised result
```

Limits are set before `eval`: 5 s interrupt deadline, 16 MiB memory, 256 KiB
stack; secrets are template-substituted rather than written into the script; both
`base_url` and the resolved request URL must be HTTPS unless loopback. The stated
reason is that scripts arrive from deeplinks and imports — untrusted input.

This is a third answer to "N heterogeneous providers": CodexBar compiles 69
strategies, teamai-cli asserts one convention over 33 harnesses, cc-switch **ships an
interpreter and makes provider support data**.

**Usage — it is the proxy.** See §14.8.5.

#### Three practices worth adopting

1. **Store the measurement convention next to the measurement.**
   `proxy_request_logs.input_token_semantics` records, per row, whether
   `input_tokens` was cache-inclusive. Adopted as a rule in §8.2.
2. **Three-state availability that propagates through aggregation.**
   `getCacheWriteAvailability(appTypes) → "ok" | "partial" | "na"`, with the
   comment that a protocol reporting no cache-creation figure means the UI
   "should label it as N/A rather than 0". Aggregating across app types with
   mixed coverage degrades to `partial`. This is §4 and §5 independently
   derived — the **third** convergence on invariant 12 after CodexBar's
   `CostUsageTokenMix` and this repo's own rule.
3. **Credential state is not a boolean.** `SubscriptionQuota` separates
   `credentialStatus: valid | expired | not_found | parse_error` from `success`,
   and carries `queriedAt` — the time coordinate a probe-class answer requires
   (`HARNESS_ADAPTER_CONTRACT`'s `evidence_recency: probe`). `tiers[]` is a list,
   because a plan has several windows, not one number.

#### One judgment worth copying

`claude-desktop` traffic is folded into `claude` for display, with the reason
recorded: a separate bucket "would only ever show a partial number and mislead
users into reading it as the Desktop's full usage."

> **When a category can only ever be partially covered, omitting the category is
> more honest than showing a partial figure under its name.**

That is §4.1 (window is not coverage) applied to a dimension rather than a time
range, and it is the correct default for any harness whose adapter can see only part
of a signal.

---

## 15. Reporting language

Extends the vocabulary in
[PRODUCT_CAPABILITY_MATRIX.md](./PRODUCT_CAPABILITY_MATRIX.md#reporting-language).

- **measured**: the harness recorded this value.
- **derived**: the adapter inferred it from adjacent records; state from what.
- **estimated**: computed by an estimator; name the estimator.
- **lossy**: recorded but degraded (truncated, hashed, redacted).
- **unmetered**: known to have occurred; nothing further is known.
- **unavailable**: the harness records no such evidence; state the reason.

Prohibited phrasings:

- Do not report a missing signal as `0`, "none found", or "clean".
- Do not describe an `unavailable` signal as "not applicable".
- Do not present a `derived` turn boundary as a measured one.
- Do not subtract an estimate from a measurement and present the difference as a
  measured breakdown.
- Do not describe a lossy non-match as evidence of absence.
- Do not state one time window for a report whose signals come from surfaces
  with different observed spans (§14.8.6).

---

## 16. Acceptance

A harness is supported when, for every signal in §13, the adapter reports
`measured`, `derived`, `estimated`, `lossy`, or `unavailable(reason)` — and for
every rule in the engine, the report states findings, a measured zero, or
unavailability. Completeness means every cell is answered, not that every cell
has a number.

### 16.1 A signal a log-reader structurally cannot have

`Tencent/teamai-cli` (§14.9) records a `process_exit` event, obtained by
monitoring the agent's PID. It answers a question no session log answers:

> **Did the agent process die, or did it finish?**

A session killed with `SIGKILL` and one that ended cleanly leave logs that end
the same way. Reading files after the fact cannot distinguish them, and this is
exactly the discriminator a "stalled session" verdict needs.

This is the one place where a 5-event hook vocabulary holds something our
16-signal vocabulary does not. Record it as `unavailable(no process observer)`
rather than inferring liveness from a truncated log.

**One harness escapes this.** WorkBuddy's trace store carries `workerPid` on every
trace and `status: "running"` on spans that never completed — process-level
liveness is *in the durable record* there, so the cell is `partial` rather than
`unavailable` (§13, §14.6).

**Wire-level timing is the other permanent gap.** `latency_ms`, `first_token_ms`,
`is_streaming` and HTTP status codes are observable only from the traffic path
(§14.8.5), which this product does not occupy. No harness writes them to a log.
Report `unavailable(not observable from a log)` — they are unobservable from
where we stand, not unimplemented.

> This asymmetry is worth keeping in view when comparing vocabularies: 16 signals
> read unevenly from logs is a **larger vocabulary over a raggeder matrix** than
> 5 signals pushed uniformly from hooks across 33 harnesses. That is a trade-off, not
> a win.

---

## 17. Implementation plan

The new model is introduced beside the existing one and proven equivalent on DSH
before anything is switched over. The only proof that a refactor preserved
behaviour is the golden corpus, and the golden corpus speaks only DSH.

| Phase | Work | Acceptance |
|---|---|---|
| **P0** | This document, plus the §13 matrix as a checked-in baseline | Matrix committed; it *is* the test baseline |
| **P1 ✅** | `evidence` module in `agent-vitals-core`: `CanonicalSession`, `Signal`, `Observed<T>`, `Provenance`, `CoverageCounts`, `RuleSpec`, `RuleOutcome` | Zero behaviour change — nothing consumes it yet. Landed in `crates/agent-vitals-core/src/contracts/evidence.rs`: all §2–§12 types plus `AggregateProvenance::for_window`, `CoverageCounts`/`Coverage` ratios, and the §12 no-harness-identifier self-check, 12 unit tests. 15/15 goldens byte-identical before/after (nothing calls it yet) |
| **P2 ✅** | `crates/agent-vitals-core/src/adapters/harnesses/dsh/sessions/evidence.rs`: a plain function (`build_dsh_evidence`, **not a trait** — see `CanonicalSession`'s own doc comment and `ARCHITECTURE.md` §4.2) that folds `src/dsh.rs`'s already-extracted `execution_events`/`usage_events` into a `CanonicalSession` (Signal/Coverage counted per §13's DSH column; the 3 rows §13 doesn't cover — `SandboxPolicy`/`UserPrompts`/`UserCorrections` — are left `Unavailable`, not fabricated), bundled with the raw events (`CanonicalSession` alone has no event-payload field); plus `reverse_project`, a temporary bridge back to today's `behavior.rs` input shape | **Byte-identical `behavior --json` output**, proven three ways: `cargo test` (154 core + 137 binary), `AGENT_VITALS_BIN=<rust> python3 -m unittest tests.test_cli_matrix` (the real Python↔Rust differential — `golden/*.json` covers the unrelated `scan` command, not this), and a manual before/after diff on `fixtures/dsh/behavior.jsonl`. `reverse_project` is deleted when P3 completes |
| **P3 ✅ (all 5 groups)** | Migrate rules one family per PR: read Signals, declare `requires`, goldens unchanged. Order: ① command/path (SV601–610) ② cost fold ③ duration ④ trajectory ⑤ skill / subagent / compaction / waste | See §17.1a for what actually landed per group. `reverse_project` is retained (not deleted) — see note at the end of §17.1a |
| **P4 ✅** | Codex adapter | Chosen second not for coverage breadth — §14.1 shows it lacks tool-call duration, approvals, and hooks — but because it is the only harness that emits **two incompatible formats without declaring which**. If the model absorbs both Codex modes without structural change, it is sound. See §17.1c for what actually landed: **sound — zero structural change to the shared type layer** (`shared_type_layer_has_no_harness_identifiers_in_code` stayed green throughout; §13's Codex Legacy + Paginated columns are absorbed by one flat type→Signal table in `derive_coverage`) |
| **P4.5** | Schema-drift sentinel for `RolloutItem` (§14.4) | CI fails on upstream persistence-policy change |
| **P5** | Claude Code adapter | First real use of `Provenance::Derived` (turn boundaries) and `Linearization` (message tree) |
| **P6** | WorkBuddy adapter | First real use of `unavailable`, `LossKind::Hashed`, `Cost::Credits`, and non-JSONL I/O. **Last not because it is hardest, but because it is the strongest falsifier**: if `CanonicalSession` has quietly become a synonym for "event stream" during P1–P5, WorkBuddy exposes it immediately |

### 17.1a P3 group log

**① command/path (SV601–610) ✅**: `RuleSpec` declared for all 10 rules in
`behavior.rs` (`crates/agent-vitals-core` + Python mirror); a new pure
`rule_outcomes()`/`rule_outcomes_json()` derives `Findings`/`MeasuredZero`/
`Unavailable` per rule from `findings` + `Coverage` — additive only,
`detect_svNNN` untouched, `findings` byte-identical. Exposed as a new,
additive `rule_outcomes` key in `--json` (sanctioned by this repo's "字段只
增不删不改语义" policy). Fixed two real bugs found in the process: (1)
`dsh_evidence.rs` never counted `approval/asked` toward `ApprovalDecisions`
coverage; (2) coverage for `rule_outcomes` must be computed from **post-fork**
events, not the pre-fork `execution_events` `dsh_evidence`'s `CanonicalSession`
carries for other consumers — otherwise a signal whose only evidence is
pre-fork history reads as "covered" when the audited findings never saw it.

**Phase B (Vite design lesson, filter-before-handler)**: P3's group ① was
post-hoc annotation — `match_behavior` ran all 10 detectors unconditionally,
then `rule_outcomes` "补" an outcome per rule from `findings` + `Coverage`.
That order is the exact anti-pattern Vite's `filter-before-handler` warns
against, and it had shipped a real bug: SV610 reads both `sandbox/mode` and
`approval/decided`, but its `requires` is only `SandboxModes` — a session with
`approval/decided{allowed-once}` and no `sandbox/mode` produced an SV610
finding *and* an `unavailable` outcome for the same rule (findings array and
`rule_outcomes` self-contradictory). The corpus couldn't catch it (5
`sandbox/mode` events in the golden fixture make SV610 always available), so
the fix carries a dedicated regression on both sides. Phase B changed family
① to **pre-gate**: the dispatcher `match_behavior_canonical(&CanonicalSession)`
checks `requires ⊆ coverage` *before* running the detector (missing → 
`Unavailable`, detector never runs), and the 10 detectors were rewritten to
iterate the adapter-populated timelines (`Timeline<T>` in `evidence.rs`
§11.5) — signature `fn(&CanonicalSession) -> RuleOutcome`, reading
`session.tool_calls`/`tool_results`/`approvals`/`sandbox_modes` instead of raw
DSH events. `match_behavior(&[Value], ws)` is retained as a shim (wasm
`audit_events` unchanged); `flatten()` reconstructs the old (event, rule)
byte order via a private `__ord` key (stable sort by event ordinal, stripped
before output). `rule_outcomes` was split: family ① comes from the gate,
family ④ (SV611–614) stays post-hoc in `trajectory_rule_outcomes`. Golden /
differential byte-identity is preserved (all family ① signals covered in the
corpus); the *only* intended behavior change is the SV610 divergence fix. The
binary also fixed a latent cwd bug alongside (post-fork canonical was built
with `None` as workspace root, silently degrading SV605 to the absolute-path
heuristic).

**② cost fold ✅**: unlike SV601–610, this family (`token_by_model`/
`request_metrics`/`context_composition`/`cost_report`) already had its own
anti-fabrication discipline predating the evidence model —
`unreported_fields`, `by_model == {}` on zero samples, `cost_report`
returning `None` — which *is* the §10 three-state contract, just not
expressed in `Signal` vocabulary. No `RuleOutcome`/`RuleSpec` reuse here:
those types are shaped for finding-producing rules (`Vec<Finding>`), and a
fold doesn't produce discrete findings — for this family "has evidence but
folds to nothing" and "has no evidence at all" are the same condition (zero
samples ⇔ zero `Signal::Usage` coverage), so there's no `MeasuredZero` state
distinct from `Unavailable` to add. Added one small new pure function,
`usage_signal_status(coverage) -> {"status": "measured"|"unavailable", ...}`,
formally connecting the existing behavior to `Signal::Usage`, exposed as a
new additive `usage_coverage` key in `--json`. Coverage computed from
post-fork `usage_events`, same reasoning as group ①'s fix.

**③ duration ✅**: the 5 duration sub-audits (`tool_calls`/`turns`/`steps`/
`approvals`/`hooks`) each depend on one signal (`ToolCalls`/`TurnBoundaries`/
`StepBoundaries`/`ApprovalDecisions`/`Hooks`) — same situation as group ①:
an empty array today conflates "no such events in this log" (should be
`Unavailable`) with "events exist but none paired up" (a real
`MeasuredZero`, e.g. `tool_call_durations` skips any `tool/call` lacking a
`callId`). Added `duration_coverage(duration, coverage)` — reads the
already-computed `duration` JSON + `Coverage`, doesn't touch the 5 pairing
functions. Exposed as a new additive `duration_coverage` key in `--json`.
Consolidated Python's signal-counting (previously a `behavior.py`-local
`_SIGNAL_EVENT_TYPES`/`_signal_coverage` scoped to only 4 signals) into a
shared `util.py::signal_coverage`/`SIGNAL_EVENT_TYPES` covering all signals
used so far, since group ③ needed 3 more (`TurnBoundaries`/`StepBoundaries`/
`Hooks`) and duplicating the dict a second time would have let the two
copies drift.

**④ trajectory (SV611–614) ✅**: unlike ②③, this family produces discrete
rule-coded findings exactly like group ①, so it reuses the *same*
`rule_specs()`/`rule_outcomes()` engine from group ① — 4 new `RuleSpec`
entries, no new function. The one real design wrinkle: SV613 and SV614 each
have **2–3 independent sub-checks sharing one rule code** (SV613:
`turn/end` error runs *or* consecutive `tool/result` failures; SV614: same
`callId` repeated approval, consecutive rejections, *or* repeated
`danger-full-access` grants) — each sub-check reads a different signal, and
any one having evidence means the rule isn't fully unmeasurable. So for
these two codes only, `requires` means "at least one of these" (OR) rather
than "all of these" (AND) — encoded as a small `OR_REQUIRES_CODES` list
consulted in `rule_outcomes`, not a change to `RuleSpec`'s shape (which stays
a plain `&[Signal]`; AND/OR is indistinguishable on single-element lists, so
groups ①–③'s existing specs are unaffected). Also found while reasoning
through SV612: `ToolCalls` being absent while `TurnBoundaries` is present is
a legitimate `MeasuredZero` ("turns exist, genuinely zero tool calls to
loop"), not `Unavailable` — so SV612's `requires` is `TurnBoundaries` alone,
with `ToolCalls` as `enhances`, mirroring SV610's pattern from group ①.

**⑤ skill / subagent / compaction / waste ✅**: `skill_invocations`/
`subagent_spawns`/`compaction_events` each gate on one signal
(`SkillInvocations`/`SubagentSpawns`/`Compaction`); `waste` gates on
`ToolCalls` OR `ToolResults` (same OR pattern as SV613/614/group③'s waste
analogue). One real fix made along the way, not just plumbing: P2's
`dsh_evidence.rs` had approximated `SubagentSpawns`/`SkillInvocations`
coverage as "does this session have *any* header at all" (always true, so
effectively always "covered" — exactly the P2 comment's own TODO: "P3 迁移
规则时直接把这两个函数的产出接进 Signal model 才是正确位置"). Replaced
with precise counting: `SubagentSpawns` = `tool/call` events with
`data.name == "subagent"`; `SkillInvocations` = `user/message` events
(guaranteed to only be skill-invocation carriers by construction — `dsh.rs`
never lets a plain `user/message` into `execution_events`) plus `tool/call`
with `data.name == "skill"`. Also caught before it shipped: `compaction_events`
returns a nested `{compactions, prunes, ...}` object, not a bare array —
treating it like one would have silently reported `measured_zero` always,
regardless of real content.

**Note on `reverse_project` (not deleted, contrary to the original P2 row's
"deleted when P3 completes")**: P3's five groups landed coverage/outcome
annotations *alongside* the existing `findings`/`usage`/`duration`/etc.
outputs — `detect_svNNN`, `token_by_model`, the duration pairing functions,
and `skill_invocations`/`subagent_spawns`/`compaction_events`/`waste`
detectors all consumed the legacy raw-event shape that `reverse_project`
reconstructs, not `CanonicalSession`/`Signal`-typed data directly. Phase B
narrowed that: family ① detectors (SV601–610) were rewritten to iterate
`CanonicalSession`'s timelines, so their findings no longer touch the raw
shape. But `reverse_project` is still retained — `match_trajectory`
(SV611–614), `token_by_model`/`request_metrics`/`context_composition`,
`compaction_events`, `detect_structural_waste`, `subagent_spawns`,
`skill_invocations`, and the five duration pairing functions all still read
the legacy shape. Deleting `reverse_project` waits for family ④ and the
remaining signals to migrate, not for this pass.

All five groups verified the same way: `cargo test`, `cargo clippy -D
warnings`, full Python suite, `AGENT_VITALS_BIN=<rust> python3 -m unittest
tests.test_cli_matrix` (byte-identical new keys both languages), wasm
rebuilt + `dsh-client`'s full `npm test` (including `verify-harness.mjs`) green
against the new binary each time.

### 17.1c P4 group log

> **2026-08 update**: two statements below are superseded. (1) The "six
> unavailable signals" are now **four** — `SandboxModes` went `measured` once the
> real rollout showed `turn_context.sandbox_policy` persists (object `{type}` /
> legacy string, both counted; it also feeds the `sandbox_modes` timeline), and
> `UserPrompts` flipped `measured` on 2026-08-30: `response_item` with
> `payload.type:"message"` + `role:"user"` is a real wire shape (15 messages in
> session 01a029cb), counted by role only, never by reading `content[].text`.
> Both implementations reference the same four-entry list
> (`_UNAVAILABLE_SIGNALS` / `is_unavailable`:
> `StepBoundaries`/`SandboxPolicy`/`NetworkAccess`/`UserCorrections`).
> (2) "No detectors run against Codex" is no longer true at the core level:
> `populate_codex_timelines` natively fills 4 of 5 timelines (approvals excepted;
> `CommandExecution` is the primary source, the `custom_tool_call` shadow is
> skipped), so SV601-603/610/611-613/614c actually run with honest
> `MeasuredZero`/`Unavailable` for the dimensions Codex lacks (see the truth
> table in `codex_evidence.rs::build_codex_evidence`). A CLI/audit-tab consumer
> (`codex behavior`) remains out of scope — the core-level truth-table test is
> the proof. `codex-evidence --json` output shape is unchanged (timelines are
> not serialized); only `SandboxModes` coverage flips zero→measured.

**P4 ✅** — the acceptance word was "sound": the shared type layer
(`CanonicalSession`/`Coverage`/`RuleSpec`, harness-neutral since P1) had to absorb
Codex's **two incompatible formats without declaring which** — with zero
structural change. It did: `shared_type_layer_has_no_harness_identifiers_in_code`
stayed green throughout, and no shared type in `evidence.rs` was touched.

What landed, one new module per layer of the five-stage pipeline (§4.2):

- **locate/shape/extract** — `src/codex_session.rs` ↔
  `scripts/agent_vitals/adapters/codex_session.py`: read the JSONL, pull
  provenance (`session_id` with §14.4 id back-fill, `history_mode`,
  `cli_version`, `model` + `workspace_roots` from the latest non-empty
  `turn_context`), keep every record in `items`. **No version gate** — §14.4:
  Codex evolves behind compatibility shims and declares no version, so degrade
  by existence probing only (empty → `missing-header`, non-JSON line →
  `non-json`, unreadable → `file-missing`), never by a `SESSION_FORMAT_VERSION`
  check that would misclassify a new record type as corruption.
- **derive/coverage** — `crates/agent-vitals-adapters/src/harnesses/codex/sessions/evidence.rs` ↔
  `scripts/agent_vitals/agent/codex_evidence.py`: **one flat type→Signal table**
  (never a per-mode fork — real Paginated rollouts carry `task_started`/
  `task_complete`, so mixed streams must just work). Both §13 Codex columns
  live in the same table. `UsageAggregate` and `SkillInvocations` are
  `derived(1)` markers — §14.3 says do NOT port Codex's own skill-invocation
  heuristic, so it is marked Derived with an offline-inference-may-disagree
  note instead of being re-implemented. The four unavailable signals
  (`StepBoundaries`/`SandboxPolicy`/`NetworkAccess`/`UserCorrections`) are left
  at zero and never inserted into the `SignalSet` — the "zero = absent, don't
  fabricate" rule. (`SandboxModes` and `UserPrompts` both flipped `measured`
  during 2026-08 — see the group log above.)
- **`attempts`, first adapter to populate it** — unknown top-level `type`,
  unknown `item.type`, or unknown `response_item.type` values are skipped and
  recorded as `SourceAttempt { source_id: "codex.rollout.jsonl", kind:
  LogFile, surface: SessionLog, available: false, error: … }` (§14.4
  "skipped and recorded in attempts, never treated as corruption"). Real
  corpus: 0 attempts.
- **CLI** — `codex-evidence <rollout.jsonl> [--json]` subcommand (both
  implementations), emitting `{harness, session_id, history_mode, cli_version,
  model, workspace_roots, signals, coverage (all 20 keys), attempts, notes}`.
  No detectors run against Codex (the deferred detector-decoupling P3 named);
  this is the observable "sound" proof, not findings.
- **wasm deliberately untouched** — `audit_events` only ever returns `findings`
  (`match_behavior` + `match_trajectory`); P4 touches neither, so
  `agent-vitals-wasm`/`dsh-client` need no rebuild.

Verified: `cargo test` (202 binary + core, incl. `codex_evidence.rs` +
`codex_session.rs` unit tests), `cargo clippy -D warnings`, full Python suite
(705, incl. 17 new characterization tests pinning the pure functions and the
ClawHub packaging allowlist now admitting the two new modules), and
`AGENT_VITALS_BIN=<rust> python3 -m unittest tests.test_cli_matrix` (73
tests, incl. the new `test_codex_evidence_legacy`/`_paginated` byte-for-byte
differentials). Manual: `codex-evidence` on real rollouts of **both** modes —
Legacy (`0.147.0-alpha.1.2`: 10 signals, `Compaction` measured, `FileMutations`
all `lossy` from `patch_apply_end`) and Paginated (`0.149.0-alpha.4.1`:
9 signals, 0 attempts, mixed-stream `TurnBoundaries` measured) — byte-identical
Python↔Rust on both. Fixtures under `fixtures/codex/` are synthetic and
self-verifying (`build_codex_fixture.py` re-asserts the exact §13 coverage on
every build), so the mapping table can't silently drift.

### 17.1 Tests

- **Coverage-matrix golden**: harness × session shape × rule family →
  `run` / `degrade` / `unavailable`. Codex(Legacy) and Codex(Paginated) are two
  rows, not one. A forgotten `requires` declaration turns it red.
- **Per-harness fixture corpora** under `fixtures/<harness>/`, redacted.
- **Reverse-projection equivalence** (P2 only; deleted afterwards).
- **Anti-fabrication assertion**: a Claude Code corpus must yield
  `Unavailable` for approval rules, never `[]`. This is the property most likely
  to regress silently, so it gets its own test rather than relying on review.
- **Shared-type purity**: no harness name appears in any identifier in the shared
  type layer (§12).
