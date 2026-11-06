# Product Capability Matrix

Reports must distinguish measured facts, estimates, and unavailable data.

Scope: **install-time** capabilities. The runtime (session-log) matrix — tool
calls, usage, approvals, durations, per harness — is §13 of
[RUNTIME_EVIDENCE_CONTRACT.md](./RUNTIME_EVIDENCE_CONTRACT.md), and its
reporting vocabulary extends the one below.

| Capability | Claude Code | Codex | OpenClaw | Hermes | WorkBuddy |
|---|---|---|---|---|---|
| Filesystem inventory | Yes | Fallback | Yes, per instance | Yes | Yes |
| Runtime skill catalog | No | Yes, app-server | Yes, `skills list --eligible --json` | Not available | Not available |
| Enabled state | Plugins/config | Yes | Runtime verified | Unknown | Manifest + welcome mode |
| Loaded state | Inferred | Runtime verified | Runtime model visibility | Unknown | Unknown |
| Scope metadata | Local classification | Runtime scope | Root kind | Root kind | Root/manifest kind |
| Description budget | Configurable estimate | Official 2% / 8k estimate | Configurable cap | Not available | Not available |
| Per-skill triggers | Yes | Not available | Not available | Not available | Not available |
| Instance-aware conflicts | N/A | N/A | Required | N/A | N/A |

## Reporting language

Use these phrases consistently:

- **runtime verified**: returned by an authoritative runtime API.
- **discoverable candidate**: present in a documented/configured search root.
- **explicitly disabled**: disabled by harness configuration.
- **candidate context cost**: metadata cost if all candidates are selected.
- **not available**: the harness exposes no verified source.

Do not call a discoverable candidate “loaded”. Do not call candidate context cost
“actual context usage”. Do not interpret missing trigger data as zero usage.

## Harness views

OpenClaw is displayed as an instance tree, not a single flat harness total:

```text
OpenClaw
├─ .openclaw
│  ├─ installed candidates
│  ├─ explicitly disabled
│  ├─ eligible/model-visible (runtime verified)
│  └─ eligible Tier 1
└─ .openclaw-xiongshu
   └─ ...
```

Conflicts appear only inside the owning instance. Cross-instance duplicate names
may be shown as inventory similarity but never as shadowing.

Codex budget output includes the policy, assumed budget, counted fields, and the
fact that it is an estimate. WorkBuddy output distinguishes top-level installed
cache packages, mode-filtered Skills, builtin-plugin internals, and connector
catalog resources.

## Product acceptance

A report is complete when every field is either supported by evidence or marked
unknown/unavailable with a reason. Completeness does not mean inventing a value
for every column.
