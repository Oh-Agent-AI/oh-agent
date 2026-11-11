---
draft: true
title: "Agent Vitals Python twin: the byte-for-byte compatible implementation"
description: Agent Vitals keeps a stdlib-only Python implementation next to the Rust engine. Golden tests make both produce identical output, and it powers the ClawHub skill package.
head:
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
          {"@type": "ListItem", "position": 1, "name": "Oh Agent", "item": "https://ohagent.ai/"},
          {"@type": "ListItem", "position": 2, "name": "Docs", "item": "https://ohagent.ai/docs"},
          {"@type": "ListItem", "position": 3, "name": "Agent Vitals engine", "item": "https://ohagent.ai/docs/vitals/overview"},
          {"@type": "ListItem", "position": 4, "name": "Python twin", "item": "https://ohagent.ai/docs/vitals/python"}
        ]
      }
---

Next to the Rust engine, Agent Vitals keeps a Python implementation in `packages/agent-vitals-python/agent_vitals/`. It's a compatibility twin: for the same input, both must produce byte-identical output, which golden tests check in CI. It uses only the standard library, targets Python 3.9, and is what the ClawHub skill package runs through `scripts/scan.py`. The desktop app and Agent City use the Rust engine, not Python.

## Key facts

- **Location:** `packages/agent-vitals-python/agent_vitals/`, with `adapters/` (per agent), `agent/` (sessions, cost, usage facts, manifests, MCP) and `skills/` (skill audit).
- **Entry point:** `python3 scripts/scan.py …` (a thin wrapper that puts the package on the path).
- **Parity:** `python3 tests/golden_runner.py --diff` compares against `golden/`; with `AGENT_VITALS_BIN` set, it compares the Rust binary too.
- **Python version:** 3.9 in CI.
- **Not bundled** with the desktop app; manifest sources don't need Python either.

<!-- source: CLAUDE.md (packages/agent-vitals-python/agent_vitals: skills/ + agent/ subtrees, adapters/; scripts/scan.py thin entrypoint, ClawHub ships scripts/scan.py); AGENTS.md (golden_runner commands; "compatibility with Python 3.9 CI") -->
<!-- source: .github/workflows/verify.yml (python-version: "3.9"); docs/HARNESS_MANIFEST_DSL_SPEC.md §1 ("不随 app 捆绑 Python 运行时"; "P0 完全不依赖 Python") -->
<!-- source: packages/agent-vitals-python/agent_vitals/agent/ (generic_manifest.py, generic_recipe.py, mcp.py, usage_fact.py …); adapters/ (claude.py, codex.py, dsh.py, hermes.py, openclaw.py, workbuddy.py …) -->

## Which commands does it have?

The Python CLI mirrors the skill-auditor and session-audit commands: `list`, `overlap`, `doctor`, `plan`, `explain`, `snapshot`, `diff`, `behavior`, `duration-audit`, `harnesses`, `codex-evidence`, `codex-session`, `sessions`, `oneline`, `calendar`, `state`, `budget`, plus `manifest-validate`. **TBD:** the complete list; some subcommands are registered without a simple `add_parser("name")` call and weren't counted here.

<!-- source: packages/agent-vitals-python/agent_vitals/cli.py (add_parser calls); apps/cli/src/main.rs (ManifestValidate "Mirrors Python scan.py manifest-validate") -->

## Why keep two implementations?

The Python version came first and is the reference ("oracle") for output contracts. Keeping both in lockstep means a contract change shows up as a golden diff that has to be reviewed. Golden files must never be refreshed just to silence a failure.

<!-- source: docs/HARNESS_ADAPTER_CONTRACT.md ("required contract for the Python oracle and the planned Rust CLI"); AGENTS.md (Testing Guidelines: "Python/Rust lockstep checks"; "Never refresh snapshots merely to silence a failure") -->

## Related

- [Agent Vitals engine overview](/docs/vitals/overview)
- [CLI](/docs/vitals/cli)
- [Add a new data source](/docs/contributing/adding-a-data-source)
