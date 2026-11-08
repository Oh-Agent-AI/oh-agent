---
lastUpdated: 2026-11-08
title: Agent Vitals 的 Python 对等实现：逐字节兼容的第二套实现
description: Agent Vitals 在 packages/agent-vitals-python 里维护一套只用标准库的 Python 实现，和 Rust 引擎通过 golden 测试保持逐字节一致，ClawHub 的 skill 包用的就是它。
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
          {"@type": "ListItem", "position": 3, "name": "Agent Vitals 引擎", "item": "https://ohagent.ai/docs/zh/vitals/overview"},
          {"@type": "ListItem", "position": 4, "name": "Python 对等实现", "item": "https://ohagent.ai/docs/zh/vitals/python"}
        ]
      }
---

除了 Rust 引擎，Agent Vitals 还在 `packages/agent-vitals-python/agent_vitals/` 里维护一套 Python 实现。它是兼容用的对等实现：同样的输入，两者的输出必须逐字节一致，CI 里用 golden 测试检查。它只用标准库，目标版本是 Python 3.9，ClawHub 的 skill 包通过 `scripts/scan.py` 运行的就是它。桌面应用和 Agent City 用的是 Rust 引擎，不是 Python。

## 关键事实

- **位置**：`packages/agent-vitals-python/agent_vitals/`，包括 `adapters/`（每个 Agent 一个）、`agent/`（会话、费用、用量事实、manifest、MCP）和 `skills/`（skill 体检）。
- **入口**：`python3 scripts/scan.py …`（一个把包加进路径的薄封装）。
- **对等检查**：`python3 tests/golden_runner.py --diff` 和 `golden/` 比较；设置 `AGENT_VITALS_BIN` 后也会比较 Rust 二进制。
- **Python 版本**：CI 里是 3.9。
- **不随桌面应用打包**；manifest 数据源也不需要 Python。

<!-- source: CLAUDE.md (packages/agent-vitals-python/agent_vitals; scripts/scan.py thin entrypoint, ClawHub ships scripts/scan.py); AGENTS.md (golden_runner commands; Python 3.9 CI) -->
<!-- source: .github/workflows/verify.yml (python-version: "3.9"); docs/HARNESS_MANIFEST_DSL_SPEC.md §1 ("不随 app 捆绑 Python 运行时"; "P0 完全不依赖 Python") -->
<!-- source: packages/agent-vitals-python/agent_vitals/agent/; adapters/ -->

## 有哪些命令？

Python 命令行对应 `packages/agent-vitals-python/agent_vitals/cli.py` 里注册的 skill 体检和会话审计命令：`list`、`overlap`、`doctor`、`plan`、`explain`、`snapshot`、`diff`、`behavior`、`duration-audit`、`harnesses`、`codex-evidence`、`codex-session`、`claude-session`、`claude-sync`、`claude-usage-facts`、`manifest-validate`、`workbuddy-usage-facts`、`codex-usage-facts`、`dsh-usage-facts`、`workbuddy-session`、`sessions`（含 `list`、`read`、`navigation`）、`oneline`、`calendar`、`state` 和 `budget`。桌面应用和 Agent City 用的是 Rust 的 `agent-vitals` 二进制，它还包含 Python 对等实现没有的数据面命令。

<!-- source: packages/agent-vitals-python/agent_vitals/cli.py (add_parser calls); apps/cli/src/main.rs (ManifestValidate "Mirrors Python scan.py manifest-validate") -->

## 为什么要维护两套实现？

Python 版本先有，是输出契约的参照（“oracle”）。两套保持同步，意味着任何契约变化都会以 golden 差异的形式出现，必须经过审查。不能为了让失败消失就刷新 golden 文件。

<!-- source: docs/HARNESS_ADAPTER_CONTRACT.md; AGENTS.md (Testing Guidelines) -->

## 相关

- [Agent Vitals 引擎总览](/docs/zh/vitals/overview) · [命令行](/docs/zh/vitals/cli) · [Data MCP 工具](/docs/zh/vitals/mcp-tools) · [App SDK](/docs/zh/vitals/app-sdk)
- [Agent City 里的楼代表什么](/docs/zh/city-guide)
- [Oh Agent 会上传我的会话吗？](/docs/zh/privacy-and-data)
