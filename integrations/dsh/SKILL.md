---
name: agent-vitals
description: Audit installed Agent Skills: which actually load, what they cost in context, where they conflict, and which are unused. Use when users ask how many skills are installed or active, why a skill never triggered, which are duplicated or safe to remove, how much startup context they cost, or whether one looks unsafe. Claude Code, Codex, OpenClaw, Hermes, WorkBuddy, DeepSeek Harness. 体检已安装 Skills：清单、是否真的加载、上下文成本、覆盖冲突、为什么没触发、僵尸清理与供应链风险。
---

# Agent Vitals (DeepSeek Harness)

Audit an installed skill library and report cost versus value with concrete actions.

## Harness support

Supported harnesses: `claude-code`, `codex`, `openclaw`, `hermes`, `workbuddy`, `dsh`.

On `dsh` (DeepSeek Harness), description budget is unavailable — there is no global
budget, so per-description truncation (SV004) replaces SV001/SV002 — and loaded/trigger
evidence comes from the session log and the registry snapshot, not a live plugin list.

## Run the scanner

The scanner is not bundled. Install it once, then run one harness at a time:

```bash
agent-vitals doctor --harness claude-code
```

If the standalone binary is not on PATH yet, use a repository checkout instead:

```bash
git clone https://github.com/Oh-Agent-AI/oh-agent
cd agent-vitals
python3 scripts/scan.py doctor --harness claude-code
```

Never combine context budgets or conflicts across harnesses — run one report per runtime.
Use `--path <dir>` only when the inventory is clearly incomplete, and `--all` only to
diagnose why installed copies did not load.

## Judgment

The scanner measures and `doctor` diagnoses; you supply the judgment it withholds. The
complete procedure — the SV codes, the report format, and the interaction rules — lives
in the repository's root `SKILL.md` and `references/`; consult them before reporting.
The rules that matter in every report: copy every number, skill name, and path from the
scan output rather than computing or recalling them; cite the SV code each finding
answers; label token counts as estimates, trigger counters as measurements, and overlap
as your own judgment; when a capability is unavailable, say so and omit the claim —
never substitute a guessed value.
