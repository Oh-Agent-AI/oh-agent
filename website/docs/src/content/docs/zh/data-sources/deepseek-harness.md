---
lastUpdated: 2026-10-27
title: DeepSeek Harness（DSH）的会话存在哪？Oh Agent 怎么读取
description: Oh Agent 从 $DSH_HOME/sessions（默认 ~/.dsh）读取 DeepSeek Harness 的会话日志，支持 zstd 压缩文件，并在 Agent City 里建成 DSH 城区。
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
          {"@type": "ListItem", "position": 3, "name": "DeepSeek Harness 数据来源", "item": "https://ohagent.ai/docs/zh/data-sources/deepseek-harness"}
        ]
      }
---

DeepSeek Harness（DSH）把每次会话存成一个 `session.jsonl` 文件（有时压缩成 `session.jsonl.zstd`），放在它主目录下的 `sessions/` 文件夹里。主目录是 `$DSH_HOME`，没设置这个变量时是 `~/.dsh`。Agent Vitals 在你的 Mac 上读取这些文件，把每次会话显示成 Agent City 里 DSH 城区的一栋楼。

## 关键事实

- **位置**：`$DSH_HOME/sessions/`，递归读取。`DSH_HOME` 默认是 `~/.dsh`。
- **读取的文件**：`session.jsonl` 和 `session.jsonl.zstd`。
- **会跟随 `DSH_HOME`**，即使它在用户主目录之外。这是唯一一个用环境变量决定位置的内置数据源。
- **标题**来自 DSH 的工作区索引 `storages/workspace.json`。
- **行为检查**：有。DSH 会话和 Claude Code、Codex 一样会评估 SV6xx 行为发现。
- **其他目录**：可以在设置里添加。

<!-- source: dsh/sources/discovery.rs; crates/agent-vitals-query/src/sessions/discovery.rs; watch_topology.rs ("当前仅 DSH_HOME"); session_harnesses.rs -->

## Oh Agent 从 DSH 会话里取什么？

和其他数据源一样的摘要：时间范围、事件数、Token 数和截断后的标题。DSH 日志里记录了服务商证据，所以 DSH 的费用估算比 Claude Code 更能区分线路。

<!-- source: AGENTS.md (Cross-harness audit status) -->

## 还有 DSH 插件吗？

有，但和读取会话是两回事。`integrations/dsh/` 的 `dsh-agent-vitals` 插件包把旧的 skill 体检工具作为一个 skill 加进 DSH（`dsh plugin --profile web add dsh-agent-vitals`）。用 Agent City 不需要它。

<!-- source: integrations/dsh/README.md -->

在 Agent City 里，这个执行环境对应的城区显示名是 **DSH**（fixture：`id: "dsh"`，`display_name: "DSH"`）。

<!-- source: apps/agent-city/ui/src/data/provider.ts -->

## 相关页面

- [Claude Code 数据来源](/docs/zh/data-sources/claude-code)
- [Codex 数据来源](/docs/zh/data-sources/codex)
- [Agent City 里的楼代表什么](/docs/zh/city-guide)
- [安装](/docs/zh/install) · [常见问题](https://ohagent.ai/#faq)
