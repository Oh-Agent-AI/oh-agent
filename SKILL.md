---
name: agent-vitals
description: Audit installed Agent Skills: which actually load, what they cost in context, where they conflict, and which are unused. Use when users ask how many skills are installed or active, why a skill never triggered, which are duplicated or safe to remove, how much startup context they cost, or whether one looks unsafe. Claude Code, Codex, OpenClaw, Hermes, WorkBuddy, DeepSeek Harness. 体检已安装 Skills：清单、是否真的加载、上下文成本、覆盖冲突、为什么没触发、僵尸清理与供应链风险。
---

# Agent Vitals

Audit an installed skill library and report cost versus value with concrete actions.

The scanner measures, `doctor` diagnoses, and you judge what neither can decide. Keep those three separate, and never turn an unavailable field into a guessed value.

## 1. Run one harness at a time

```bash
python3 scripts/scan.py doctor --harness claude-code
```

Harnesses: `claude-code`, `codex`, `openclaw`, `hermes`, `workbuddy`, `dsh`. Never combine context budgets or conflicts across harnesses — run one report per runtime.

On `dsh` (DeepSeek Harness), description budget is unavailable — there is no global budget, so per-description truncation (SV004) replaces SV001/SV002 — and loaded/trigger evidence comes from the session log and the registry snapshot, not a live plugin list.

Use `--path <dir>` when the inventory is clearly incomplete. Use `--all` only to diagnose why installed copies did not load; never present its aggregate as the active context cost.

Harness evidence differs and degrades explicitly. Read [references/harnesses.md](references/harnesses.md) before reporting on any harness other than Claude Code, or whenever a field comes back unavailable.

## 2. Read the diagnosis

`doctor` prints each finding as an SV code with cause, impact, and action, followed by `!` caveat lines and a "Not assessed" section naming what it deliberately refuses to judge. Carry those caveats into your report verbatim in substance — do not reword them into something more confident, and do not drop them.

| Code | Meaning |
|---|---|
| SV001 / SV002 | description budget warning / overflow |
| SV101 / SV102 / SV103 | shadowed by newer / redundant copy / intentional override |
| SV105 | invalid or missing frontmatter |
| SV201 / SV202 | zero triggers / dormant |
| SV301 / SV303 | high per-trigger cost / expensive and unused |
| SV401 | lexical overlap candidate |
| SV501–SV508 | security findings |
| SV901 / SV902 | capability unavailable / skill unreadable |

Drill down only where the diagnosis points:

```bash
python3 scripts/scan.py explain <name>   # why one skill is ineffective, and the fix
python3 scripts/scan.py plan --startup-rate 30   # ranked savings plan from the report
python3 scripts/scan.py list --unused    # dormant and zombie candidates
python3 scripts/scan.py overlap          # the shared terms behind SV401
python3 scripts/scan.py diff             # what changed since the last snapshot
python3 scripts/scan.py --json -         # raw measurements, when you need a field
```

`plan` machineizes the Recommended disposition (§4): it turns the report into a
ranked, executable list — each item names a skill, its execution risk, the measured
token saving per event, and the SV codes it answers. It obeys the same honesty rules
as the report: `savings_per_event` is always measured; `events_per_month` is filled
only from `--startup-rate` (an estimate — the lifetime `usage_count` is exposed
separately as `measured_lifetime_triggers`, never as a monthly figure); and
`diagnosis_refs` cites only codes the report actually emits. A plan is a proposal:
the risk ordering is a suggested reading order, and the §5 rule against disabling a
skill without the user asking still holds.

`doctor` writes a snapshot and compares against the previous one automatically; `--no-snapshot` turns that off. Add `--redact --redact-names` before sharing any output.

## 3. Supply the judgment the tool withholds

The codes below are where `doctor` stops and you start. Read [references/judgment.md](references/judgment.md) when any of them appears:

- **SV401** — is the overlap real? Lexical similarity is a filter, not a verdict.
- **SV101 / SV103** — which copy should win, and does the user know which one is effective?
- **SV301 / SV303** — where exactly should this skill be split?
- **SV501–SV508** — review every flagged line manually. `cited=true` changes reading order only; it never suppresses or downgrades a finding.
- **SV201 / SV202** — genuinely dead, or simply never selected?

## 4. Report format

Lead with the conclusion, then the evidence:

```markdown
# Skill health report

## Critical finding
Only when budget overflow, a high-severity conflict, or a serious security finding exists.

## Overview
Harness and instance · run <marker> · installed N · active/runtime-verified M · estimated Tier 1 cost · evidence availability

## Immediate actions
1. `SV___` — concrete action naming the skill and its path

## Context cost
`SV301` / `SV303` — highest-cost skills, distinguishing core / references / worst case

## Conflicts and semantic overlap
`SV101` / `SV103` / `SV401` — effective copy, shadowed copies, and a realistic prompt that would trigger both

## Usage evidence
`SV201` / `SV202` — measured counters, or an explicit statement that they are unavailable

## Security and structure
`SV501`–`SV508` / `SV105` — reviewed findings with file and line evidence

## Recommended disposition
Keep · revise · merge · disable/delete after confirmation
```

Every recommendation must be executable and name the affected skill. Cite the SV code each finding answers, so the reader can re-run with the same `run` marker and land on that exact line — and if a finding has no SV code to cite, doctor did not report it and you should ask yourself where it came from.

## 5. Interaction rules

- Never delete or disable a skill unless the user explicitly asks.
- Every number, skill name, and path in your report is copied from the scan output. Do not compute one, round one, or recall one — if it is not in the output, it does not go in the report. The same holds for doctor's `!` caveats: reproduce their substance or drop the finding with them, because a finding stripped of its caveat reads as a verdict.
- Quote doctor's `run` marker in the report header. It is derived from this scan's contents, so it is the reader's evidence that the report describes a scan you actually ran rather than one you remember.
- Label token counts as estimates, trigger counters as measurements, and semantic overlap as your own judgment.
- When a capability is unavailable, say so and omit the claim entirely. A report missing a column is useful; a report with a fabricated one is not.
- Splitting a skill lowers average load cost, not necessarily worst-case cost — name which number dropped.

For the complete Chinese workflow, read [references/guide.zh-CN.md](references/guide.zh-CN.md) when the user requests Chinese or when Chinese terminology would improve the report.
