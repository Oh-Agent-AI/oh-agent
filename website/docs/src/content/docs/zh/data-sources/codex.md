---
title: Codex 的会话记录存在哪？怎么用 Oh Agent 可视化
lastUpdated: 2026-10-22
description: Codex CLI 把每次会话存成 ~/.codex/sessions 下的 rollout-*.jsonl 文件。Oh Agent 在本机读取，建成 Codex 城区。
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
          {"@type": "ListItem", "position": 3, "name": "Codex 数据来源", "item": "https://ohagent.ai/docs/zh/data-sources/codex"}
        ]
      }
---

Codex 把每次会话存成一个 rollout 文件（`rollout-*.jsonl`），放在 `~/.codex/sessions/` 下按日期分好的文件夹里；归档过的会话放在 `~/.codex/archived_sessions/`。Oh Agent 在你的电脑 上读取这两个目录，不会上传，并把每次会话显示成 Agent City 里 Codex 城区的一栋楼。

## 关键事实

- **读取位置**：`~/.codex/sessions/` 和 `~/.codex/archived_sessions/`，递归读取。
- **只读符合 `rollout-*.jsonl` 命名的文件。**
- **一个 rollout 文件 = 一次会话。**
- **归档的会话也算**：在 Codex 里归档，不会让它从城市里消失。
- **实时更新**：Oh Agent 会监听 `~/.codex` 的变化。
- **暂不支持**：用 `CODEX_HOME` 指定的自定义目录（见下文）。可以在设置的“其他读取位置”里手动添加目录。

<!-- source: crates/agent-vitals-harnesses/src/harnesses/codex/sources/mod.rs（codex_rollout_files：sessions + archived_sessions，文件名以 rollout- 开头、.jsonl 结尾） -->
<!-- source: crates/agent-vitals-query/src/sources/watch_topology.rs（监听根 .codex） -->

## Codex 的会话具体存在哪？

典型路径长这样：

```
~/.codex/sessions/2026/08/22/rollout-2026-08-22T22-06-31-<id>.jsonl
```

会话按年/月/日分文件夹存放，文件名以会话开始的时间开头。文件里每一行是一个事件，比如一条消息、一次工具调用或一条 Token 计数。

<!-- source: docs/CODEX_SESSION_ENRICHMENT.md（示例路径） -->

## Oh Agent 从这些文件里取了什么？

和其他 Agent 一样，每次会话只取一份摘要：时间范围、事件数、Token 数（输入、缓存读、缓存写、输出），有的话再加一段有长度限制的标题或任务摘要。城市里的楼高由总 Token 数决定，详见[城市里每栋楼代表什么](/docs/zh/city-guide)。

文件路径、工作目录、工具参数和原始报错都不会交给城市视图。详见[Oh Agent 会上传我的会话吗？](/docs/zh/privacy-and-data)

<!-- source: crates/agent-vitals-query/src/query/app_local.rs；AGENTS.md 政策第 6 条 -->

## 为什么有些 Codex 会话没显示？

- **不在时间范围内**：把范围调到 30、90 或 366 天试试。
- **改过 `CODEX_HOME`**：Codex 可以用 `CODEX_HOME` 环境变量把数据放到别的目录。Oh Agent 1.0.0-beta.3 不跟随这个变量。可以在“设置 → 其他读取位置”里添加目录，但每个目录都会按 `<目录>/.codex/sessions` 和 `<目录>/.codex/archived_sessions` 去读。
- **日志文件被删了**：如果 rollout 文件在 Oh Agent 导入之前已被删除，该会话将无法导入。已经导入的统计在 Oh Agent 的保留期（默认 13 个月）内仍可用，除非你在设置里显式删除该数据源的数据。保留下来的统计仍可在所选时间范围内显示于 City；源文件被删除后，对应的原始对话将无法查看。
- **在别的电脑上用的**：其他设备上的历史不会合并进来。
- **会话超过 4000 次**：每个时间范围只载入最近的 4000 次。

<!-- source: apps/agent-city/ui/src/CityApp.tsx；codex/sources/mod.rs 写死了 home/.codex（仓库中未搜到 CODEX_HOME）；website/landing/i18n.js faq.4；app_local.rs SESSION_CAP = 4_000 -->

## 需要 OpenAI 的 API Key 吗？

不需要。Oh Agent 读的是 Codex 已经保存好的文件，不需要 API Key，也不需要注册 Oh Agent 账号。

<!-- source: README.md；website/landing/i18n.js faq.7 -->

## 相关页面

- [Claude Code 数据来源](/docs/zh/data-sources/claude-code)
- [Agent City 里的楼代表什么](/docs/zh/city-guide)
- [安装](/docs/zh/install) · [常见问题](https://ohagent.ai/#faq)
