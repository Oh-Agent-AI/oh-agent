# `dsh-agent-vitals`

[Agent Vitals](../README.md) as a DeepSeek Harness profile bundle. Installing it makes
`agent-vitals` available as a skill inside DSH, so a DSH agent can audit the *other*
skill harnesses on the machine.

## Install

```sh
dsh plugin --profile web add dsh-agent-vitals
```

The package declares `dsh.bundle.patch`, so the profile composer activates its patch
layer automatically after `pnpm` resolves it.

## What it ships

| File | Role |
|---|---|
| `package.json` | `name: dsh-agent-vitals`, `dsh.bundle.patch`, no build, no dependencies |
| `cordis.patch.yml` | one insert row mounting the glue plugin |
| `index.js` | a Cordis plugin registering one skill provider on `ctx.skills` |
| `SKILL.md` | the DSH-facing skill body (frontmatter + instructions) |

## Three hard constraints

This bundle is deliberately thin, for reasons written up in
[`docs/ENGINEERING.md`](../docs/ENGINEERING.md) §6.6.1:

1. **npm prebuilt only, never git install.** Git installs need `allowBuilds`, which
   grants install-time code execution outside the sandbox — self-contradictory for a
   supply-chain auditor. This package has no `prepare` script, so installing it grants
   nothing.
2. **No scanner copy.** The bundle ships instructions, not `scan.py`. The audit runs
   from the `agent-vitals` binary on PATH (or a repo checkout today). A vendored scanner
   would create a third Python consumer and a second source of truth.
3. **No build step.** Plain ESM JavaScript, published as-is.

## Status

DSH is health-checked via `--harness dsh` (DSH-2). Description budget is reported
unavailable — DSH has no global budget, so per-description truncation (SV004) replaces
SV001/SV002 — and loaded/trigger evidence comes from the session log and the registry
snapshot. See [`docs/DSH_INTEGRATION.md`](../docs/DSH_INTEGRATION.md).
