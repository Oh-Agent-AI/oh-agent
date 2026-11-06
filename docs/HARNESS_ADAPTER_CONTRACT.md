# Harness Adapter Contract

Status: required contract for the Python oracle and the planned Rust CLI.

Scope: the **install-time** layer — does a skill exist, is it enabled, is it
loaded. The runtime counterpart (what the agent did, what it cost, how long it
took) is [RUNTIME_EVIDENCE_CONTRACT.md](./RUNTIME_EVIDENCE_CONTRACT.md), which
extends the capability model here with two further axes (fidelity and
provenance).

This document supersedes harness assumptions that treat a discovered `SKILL.md` as
proof that a skill is enabled or loaded. Every harness adapter must preserve the
source of its evidence and uncertainty.

## Skill state funnel

The four stages are independent capabilities:

1. `installed`: a skill artifact exists on disk.
2. `discoverable`: the harness's documented/configured roots can discover it.
3. `enabled`: harness configuration permits it.
4. `loaded`: a harness runtime confirms it is in the current capability set.

Each stage is represented as one of:

```text
available(true)
available(false)
unknown
unavailable(reason)
```

`unknown` is not `false`. A filesystem root can prove installed/discoverable,
but cannot by itself prove enabled or loaded.

## The observer

The four stages above are not machine-wide facts. `enabled` and `loaded` are
answered **for one capability scope**, and a harness may have more than one.

```text
funnel(skill)            # machine-level; correct only where the harness has one scope
funnel(skill, observer)  # the contract
```

| Harness | Observer | Values |
|---|---|---|
| claude-code, codex, hermes, workbuddy | none | one implicit scope |
| openclaw | agent | `--agent main`, … |
| dsh | agent / preset scope | the scope chain |

A single-scope harness degenerates to the machine-level funnel, and its records
are unchanged. A multi-scope harness MUST name the observer on every record: a
bare `loaded: true` is not a meaningful assertion there, because a sibling
agent may resolve the same name to a different skill or to nothing at all.

OpenClaw's `skills list --eligible --agent main` was already per-observer
evidence; it is not a special case, it is this field with one value filled in.

## Evidence recency

`runtime_verified: bool` conflates two kinds of proof that age differently.
Adapters MUST report which one they hold:

```text
evidence_recency:
  probe    | the harness answered just now; no time coordinate
  log      | a durable harness record states what was true THEN; time coordinate required
  none     | filesystem inference only
```

A `log` record carries its own coordinate and is never presented as current
state:

```json
{
  "evidence_recency": "log",
  "observed_at": { "session_id": "…", "seq": 412, "ts": "2026-08-14T09:12:03Z" }
}
```

The distinction is load-bearing, not bookkeeping: a `log`-sourced `loaded:
true` from last month says nothing about the present, and rendering it beside
a `probe`-sourced one without the coordinate is how a report starts lying
about time. `runtime_verified` remains as a compatibility field
(`recency != "none"`) until the next schema version.

## Required skill fields

```json
{
  "harness": "openclaw",
  "instance_id": ".openclaw-xiongshu",
  "instance_root": "~/.openclaw-xiongshu",
  "config_path": "~/.openclaw-xiongshu/openclaw.json",
  "root_kind": "workspace",
  "conflict_domain": "openclaw:.openclaw-xiongshu",
  "installed": true,
  "discoverable": true,
  "enabled_state": null,
  "loaded_state": null,
  "runtime_verified": false,
  "evidence_recency": "none",
  "observer": null,
  "loaded_reason": "openclaw-discoverable-runtime-unverified"
}
```

The Rust schema should replace nullable booleans with a tagged `Capability<T>`.
The Python output keeps compatibility fields until the next schema version.

## Adapter result

```rust
pub struct AdapterResult {
    pub harness: HarnessId,
    pub instances: Vec<HarnessInstance>,
    pub skills: Vec<DiscoveredSkill>,
    pub capabilities: HarnessCapabilities,
    pub errors: Vec<AdapterError>,
}

pub struct DiscoveredSkill {
    pub path: PathBuf,
    pub instance_id: Option<String>,
    pub source: DiscoverySource,
    pub installed: Capability<bool>,
    pub discoverable: Capability<bool>,
    pub enabled: Capability<bool>,
    pub loaded: Capability<bool>,
    pub observer: Option<ObserverId>,
    pub evidence: EvidenceRecency,
}

pub enum EvidenceRecency {
    Probe,
    Log { session_id: String, seq: u64, ts: String },
    None,
}
```

An adapter error degrades only the affected capability. Failure of runtime
enumeration must not discard filesystem measurements or security findings.

## Codex

Authoritative runtime source: `codex app-server` using `skills/list`.

Runtime fields:

- `name`, `description`, `path`, `scope`, `enabled`
- optional `interface`, `dependencies`, `shortDescription`

Filesystem scanning is the fallback, not the primary catalog. The adapter must
handle executable absence, initialization timeout, malformed JSONL, request
error, and partial per-CWD errors.

Description-list policy is official: at most 2% of model context, or 8,000
characters when context size is unknown. The estimate counts name, description,
and path. It is not prompt telemetry. Per-skill trigger history is unavailable.

## WorkBuddy

Discovery sources:

- project `.workbuddy/skills` and `.codebuddy/skills`
- user `~/.workbuddy/skills`
- top-level `category=skill` packages declared by
  `~/.workbuddy/plugins/marketplaces/workbuddy-builtin/.codebuddy-plugin/marketplace.json`

The manifest selects package name/version, while the installed `SKILL.md` is
resolved under `~/.workbuddy/plugins/cache/workbuddy-builtin/<package>/<version>`.
Marketplace source is a fallback only. Resolved manifest sources must remain
below the marketplace root.

Explicit exclusions:

- content nested *inside* a `builtin-plugin` package that is neither the package
  root `SKILL.md` nor `skills/*/SKILL.md` — e.g. `experts/` role definitions.

  > **Superseded 2026-08-13.** This previously read "skills nested inside
  > `builtin-plugin` packages" and excluded those packages wholesale. Reconciling
  > against WorkBuddy's own runtime skill list showed 18 skills it actually loads
  > (Tencent Docs/PPTX/Docx, WeChat Pay, sheet agent) were being dropped: we
  > reported 31 on disk / 25 loaded against a runtime total of 43. The rule below
  > is a **positive allowlist** derived from that reconciliation, not from reading
  > directory names. Evidence: runtime `available_skills` enumeration, 2026-08-13,
  > macOS, WorkBuddy builtin marketplace manifest v2.
- `connectors-marketplace`, which is a catalog rather than proof of installation

The latest local session log supplies `welcomeMode`. In Work mode, the six
design-only `ardot-*` packages are filtered; on the audited machine this maps 18
top-level installed packages to the same 12 Skills reported by WorkBuddy itself.
An `.orphaned_at` marker is recorded but is not treated as disabled for builtin
seed packages. No public description budget or trigger counter is known.

## OpenClaw

Every directory containing `openclaw.json` is a separate instance. The adapter
records its configured workspace plus instance-local `skills`, `plugin-skills`,
and the installed npm package's bundled `openclaw/skills`. Shared
`~/.agents/skills` is projected into each instance but keeps a separate conflict
domain per instance.

Conflict identity is:

```text
(conflict_domain, namespace, skill_name)
```

Never compare skills across OpenClaw instances. Filesystem discovery is the
fallback inventory. When available, `openclaw skills list --eligible --json
--agent main` is authoritative for eligibility, model visibility, disabled and
allowlist state, source, and missing dependencies. Returned model-visible Skills
retain the backward-compatible `loaded=true` field and add
`runtime_status=eligible-model-visible`, `body_loaded_state=null`, and
`runtime_verified=true`. This means compact metadata visibility, not proof that
the complete body was read. Installed entries absent from the eligible result
remain inventory but are not discoverable to that agent.

Instance summaries report candidate Tier 1 cost separately. Candidate cost must
not be described as actual injected context.

## DSH (DeepSeek Harness)

Status: specified, not implemented. Scheduling and rationale are in
[DSH_INTEGRATION.md](./DSH_INTEGRATION.md).

Discovery roots, in DSH's own rank order (lower wins **within one layer**):

| Rank | Root | Source |
|---|---|---|
| 100 | `<project>/.dsh/skills` | `project-dsh` |
| 200 | `<project>/.agents/skills` | `project-agents` |
| 300 | configured `customSkillDirs` | `custom` |
| 400 | `$DSH_HOME/skills` (default `~/.dsh/skills`) | `user-dsh` |
| 500 | `$DSH_AGENTS_HOME/skills` (default `~/.agents/skills`) | `user-agents` |
| 600 | packaged providers | `bundled` |

Resolution is two-dimensional and rank alone does not describe it: reads merge
the global layer with the observer's scope chain, **the nearest layer's entry
wins a duplicate name outright**, and rank decides duplicates only within one
layer. A single-layer precedence model applied here reports intentional
cross-layer overrides as redundant copies.

Conflict identity is therefore:

```text
(dsh:<DSH_HOME>:<layer>, namespace, skill_name)
```

The layer belongs in the domain. Cross-layer duplicates are the design, not a
conflict.

`~/.agents/skills` is **shared with OpenClaw**. Project it into both harnesses and
keep the conflict domains separate, exactly as the OpenClaw rule requires for
its own instances.

### No global description budget

DSH does not concatenate descriptions into one budgeted list and does not drop
entries silently. It truncates **each** description at
`catalogDescriptionMaxLength` (default 500). Consequences for the adapter:

- Budget capability is `unavailable(no global description budget)`. Do not
  substitute a guessed budget.
- A distinct finding replaces it: description truncated, which silently removes
  the routing tail — usually the "when to use" half.
- The threshold is deployment-configurable. Read it from the runtime evidence;
  never hardcode 500.

### Two independent evidence sources

DSH is the first harness where the authoritative record of the past is available
without the harness running.

| Source | Answers | Recency | Requires DSH running |
|---|---|---|---|
| registry snapshot | what this scope resolves **now** | `probe` | yes |
| session log | what was published to the model **then** | `log` | no |

The session log is the stronger one for the question users actually ask.
Every catalog publication is a durable session message carrying the exact
entries advertised at that point, and user-explicit invocations are recorded
separately. It is queryable offline, after the agent has exited.

A registry snapshot reports its own completeness. Map it without collapsing:

| Snapshot | Contract |
|---|---|
| present, discovery complete | `loaded: available(true)`, `evidence_recency: probe` |
| absent, discovery complete | `loaded: available(false)` |
| discovery incomplete | **all `unknown`**, never `false` |

DSH suppresses catalog publication entirely for a turn whose discovery is
incomplete, so an incomplete observation is not a partial answer — it is the
same condition that makes every skill invisible to the model that turn. Report
it as such.

### Hot reload

DSH watches its skill roots and republishes the catalog when it changes, so the
catalog the model saw is a snapshot taken at the previous `agent/pre-step`, not
a mirror of the disk. An adapter MUST NOT report the difference between its own
scan and a catalog record as a conflict; it is the expected consequence of two
different observation times, which is what `evidence_recency` records.

Three watcher conditions are worth reporting, and the third is readable from
deployment configuration alone — no runtime evidence and no running harness:

| Condition | Effect | Source |
|---|---|---|
| change takes effect next turn | a skill added mid-turn is invisible that turn | runtime only |
| incomplete discovery during the reload window | no catalog published that turn; the model keeps the previous one, silently | runtime only |
| `watchMaxProjects` LRU eviction (default 128) | evicted project roots stop being watched; later edits there trigger no reload | **config** |

The eviction case is the concrete cause of "hot reload works sometimes" for
users who move between many repositories. It warrants its own finding, distinct
from shadowing: shadowing means two copies compete, this means one copy exists
and the harness never saw it change.

### Precision of `loaded`

As with OpenClaw: a snapshot proves compact metadata entered the catalog, not
that the body was read. Keep `body_loaded_state: null` and use
`runtime_status: catalog-visible`.

### Trigger data

Unlike Claude Code's `skillUsage` counter, DSH's session store distinguishes
**user-explicit invocation** from **model-selected load**. Zero triggers is
therefore decomposable into "never selected" versus "never invoked", which no
other harness supports. `SESSION_FORMAT_VERSION` carries no compatibility promise;
on a schema mismatch report `unavailable`, never zero.

## Schema evolution

The next stable JSON contract must include `schema_version` and preserve:

- evidence source and degradation errors
- instance identity and conflict domain
- capability states without collapsing unknown into false
- candidate estimates versus runtime-verified measurements
- harness-specific metadata under namespaced fields
- the observer a scoped capability state was answered for
- evidence recency, with a time coordinate on every `log` record

Golden output may only be regenerated after a reviewer confirms each semantic
difference from the previous oracle.
