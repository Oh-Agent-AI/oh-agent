---
draft: true
title: Agent Vitals 的 Skill 体检：OpenClaw、Hermes 和 DeepSeek Harness 插件包
description: 在 Agent City 之前，Agent Vitals 是一个 skill 体检工具，覆盖 Claude Code、Codex、OpenClaw、Hermes、WorkBuddy 和 DSH。它是什么、dsh-agent-vitals 插件包怎么装、为什么 OpenClaw 在城市里没有城区。
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
          {"@type": "ListItem", "position": 2, "name": "文档", "item": "https://ohagent.ai/docs/zh"},
          {"@type": "ListItem", "position": 3, "name": "集成", "item": "https://ohagent.ai/docs/zh/integrations"},
          {"@type": "ListItem", "position": 4, "name": "Skill 体检", "item": "https://ohagent.ai/docs/zh/integrations/skill-auditor"}
        ]
      }
---

除了会话数据，Agent Vitals 还有一类更早的集成：**Skill 体检**。它检查某个 Agent 装了哪些 Agent Skills、是否真的被加载、占多少启动上下文、互相有没有冲突。覆盖 Claude Code、Codex、OpenClaw、Hermes、WorkBuddy 和 DeepSeek Harness。OpenClaw 和 Hermes **只**在这里支持：它们是 skill 来源而不是会话来源，所以不会出现在 Agent City 里。

## 关键事实

- **作为 agent skill**：仓库根目录的 `SKILL.md`。由 `.github/workflows/package-clawhub.yml` 打包发布到 ClawHub，`agents/openai.yaml` 是给 Codex 的描述。
- **在 DSH 里**：`integrations/dsh/` 的 `dsh-agent-vitals` 插件包把体检工具作为一个 skill 加进去。
- **用命令行**：`agent-vitals list`、`doctor`、`plan`、`explain`、`overlap`、`snapshot`、`diff`。
- **OpenClaw 适配器**：`crates/agent-vitals-harnesses/src/harnesses/openclaw/` 只有 `sources/skills.rs`，没有 `sessions/`。它会发现多个实例目录，并调用 `openclaw skills list --eligible`；同一份代码也负责发现 Hermes。

<!-- source: SKILL.md; .github/workflows/package-clawhub.yml; agents/openai.yaml; crates/agent-vitals-harnesses/src/harnesses/openclaw/mod.rs -->

## DSH 插件包怎么装？

```sh
dsh plugin --profile web add dsh-agent-vitals
```

这个包刻意做得很薄：npm 预构建包，没有构建步骤，也没有安装脚本。它只带使用说明，不带扫描器副本；实际体检由 PATH 上的 `agent-vitals` 二进制完成。

**待确认**：`dsh-agent-vitals` 是否真的发布到了 npm，版本是多少。

<!-- source: integrations/dsh/README.md -->

## 怎么判断 skill “已加载”？

它把状态分成四级：已安装、可发现、已启用、已加载，绝不把磁盘上有 `SKILL.md` 当成已加载的证据。证明不了的一律报 `unknown`，而不是 `false`。

<!-- source: docs/HARNESS_ADAPTER_CONTRACT.md -->

## 相关

- [集成总览](/docs/zh/integrations)
- [命令行](/docs/zh/vitals/cli)
- [DeepSeek Harness 数据来源](/docs/zh/data-sources/deepseek-harness)
