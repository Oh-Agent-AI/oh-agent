---
draft: true
title: "Agent Vitals skill auditor: OpenClaw, Hermes and the DeepSeek Harness skill bundle"
description: Before Agent City, Agent Vitals shipped a skill auditor for Claude Code, Codex, OpenClaw, Hermes, WorkBuddy and DSH. What it is, the dsh-agent-vitals bundle, and why OpenClaw has no city district.
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
          {"@type": "ListItem", "position": 3, "name": "Integrations", "item": "https://ohagent.ai/docs/integrations"},
          {"@type": "ListItem", "position": 4, "name": "Skill auditor", "item": "https://ohagent.ai/docs/integrations/skill-auditor"}
        ]
      }
---

Besides session data, Agent Vitals has a second, older kind of integration: a **skill auditor**. It checks which Agent Skills are installed for an agent, whether they actually load, what they cost in startup context, and where they conflict. It covers Claude Code, Codex, OpenClaw, Hermes, WorkBuddy and DeepSeek Harness. OpenClaw and Hermes are supported **only** here: they're skill sources, not session sources, so they don't appear in Agent City.

## Key facts

- **As an agent skill:** `SKILL.md` at the repo root. It's packaged for ClawHub by `.github/workflows/package-clawhub.yml`, and `agents/openai.yaml` describes it for Codex.
- **Inside DSH:** the `dsh-agent-vitals` bundle in `integrations/dsh/` adds the auditor as a skill.
- **From the CLI:** `agent-vitals list`, `doctor`, `plan`, `explain`, `overlap`, `snapshot`, `diff`.
- **OpenClaw adapter:** `crates/agent-vitals-harnesses/src/harnesses/openclaw/` has only `sources/skills.rs`, with no `sessions/`. It finds multiple instance folders and asks `openclaw skills list --eligible`. The same code also discovers Hermes.

<!-- source: SKILL.md (frontmatter: "Claude Code, Codex, OpenClaw, Hermes, WorkBuddy, DeepSeek Harness"); .github/workflows/package-clawhub.yml; agents/openai.yaml -->
<!-- source: crates/agent-vitals-harnesses/src/harnesses/openclaw/mod.rs ("OpenClaw（含 Hermes 的目录发现，两者共用一份解析代码）… Skill-Surface-only 执行环境 … 没有 sessions/") -->

## How do I install the DSH bundle?

```sh
dsh plugin --profile web add dsh-agent-vitals
```

The bundle is deliberately thin: an npm prebuilt package with no build step and no install scripts. It ships instructions, not a copy of the scanner; the audit runs from the `agent-vitals` binary on your PATH.

**TBD:** whether `dsh-agent-vitals` is actually published to npm, and at which version.

<!-- source: integrations/dsh/README.md (Install; "npm prebuilt only, never git install"; "No scanner copy"; "No build step") -->

## How does the skill auditor judge "loaded"?

It separates four stages (installed, discoverable, enabled, loaded) and never treats a `SKILL.md` on disk as proof that a skill is loaded. Anything it can't prove is reported as `unknown`, not `false`.

<!-- source: docs/HARNESS_ADAPTER_CONTRACT.md (Skill state funnel; "unknown is not false") -->

## Related

- [Integrations overview](/docs/integrations)
- [CLI](/docs/vitals/cli)
- [DeepSeek Harness data source](/docs/data-sources/deepseek-harness)
