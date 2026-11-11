---
title: Claude Code 的会话记录存在哪？Oh Agent 怎么读取
lastUpdated: 2026-10-22
description: Claude Code 把每次会话存成 ~/.claude/projects 下的 JSONL 文件。Oh Agent 在本机读取，把每次会话变成一栋楼。
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
          {"@type": "ListItem", "position": 3, "name": "Claude Code 数据来源", "item": "https://ohagent.ai/docs/zh/data-sources/claude-code"}
        ]
      }
---

Claude Code 把会话记录存在 `~/.claude/projects/` 下面，每个项目一个文件夹，每次会话一个 `.jsonl` 文件。Oh Agent 在你的电脑 上读取这些文件，不会上传，并把每次会话变成 Agent City 里 Claude Code 城区的一栋楼。

## 关键事实

- **读取位置**：`~/.claude/projects/**/*.jsonl`，会递归读取所有 `.jsonl` 文件。
- **一个文件 = 一次会话**，文件名（去掉 `.jsonl`）就是会话 ID。
- **实时更新**：Oh Agent 会监听 `~/.claude/projects`，有新会话或会话变长了都会自动更新。
- **统计的 Token**：日志里记录的输入、缓存读、缓存写和输出 Token。
- **只读**：不修改、不移动 Claude Code 的文件。
- **暂不支持**：用 `CLAUDE_CONFIG_DIR` 指定的自定义目录（见下文）。可以在设置的“其他读取位置”里手动添加目录。

<!-- source: crates/agent-vitals-harnesses/src/harnesses/claude_code/sources/mod.rs（claude_project_files：home/.claude/projects，后缀 jsonl，递归遍历） -->
<!-- source: crates/agent-vitals-harnesses/src/sources/session_harnesses.rs（文件名 = 原生会话 ID） -->
<!-- source: crates/agent-vitals-query/src/sources/watch_topology.rs（监听根 .claude/projects）；crates/agent-vitals-query/src/query/app_local.rs（Token 字段） -->

## Claude Code 的会话具体存在哪？

在 macOS 上，路径是：

```
~/.claude/projects/<项目文件夹>/<会话 ID>.jsonl
```

文件里每一行是对话中的一个事件，比如一条消息、一次工具调用或一条 Token 用量记录。`<项目文件夹>` 是 Claude Code 根据你启动它时所在的目录生成的。

<!-- source: docs/CLAUDE_CODE_INTEGRATION.md（~/.claude/projects/**/*.jsonl） -->

## Oh Agent 从这些文件里取了什么？

每次会话，Oh Agent 会记下时间范围、事件数、Token 数，有的话再加一段有长度限制的标题或任务摘要。这些数据用来建城：一次会话一栋楼，楼高由总 Token 数决定。详见[城市里每栋楼代表什么](/docs/zh/city-guide)。

城市视图拿不到完整提示词、文件路径、工作目录、工具参数和原始报错，对话原文始终留在 Claude Code 自己的文件里。详见[Oh Agent 会上传我的会话吗？](/docs/zh/privacy-and-data)

<!-- source: crates/agent-vitals-query/src/query/app_local.rs；AGENTS.md 政策第 4、6 条 -->

## 为什么 Claude Code 城区是空的，或者比预期小？

- **时间范围里没有会话**：桌面版城市显示近 7、30、90 或 366 天，可以把范围调大。
- **旧记录被清理了**：如果 Claude Code 在 Oh Agent 导入之前就删除了记录，该会话将无法导入。已经导入的统计在 Oh Agent 的保留期内仍可显示；删除源日志只会使对应原文无法查看。Claude Code 默认 30 天后删除会话记录，见[为什么 Agent City 里缺了较早的会话？](#为什么-agent-city-里缺了较早的会话)
- **在别的电脑上用的**：其他设备上的历史不会合并进来。
- **改过配置目录**：设置了 `CLAUDE_CONFIG_DIR` 后，Claude Code 会把会话历史存到那个目录，不再放在 `~/.claude`（见 [Anthropic 设置文档](https://docs.anthropic.com/en/docs/claude-code/settings)）。Oh Agent 1.0.0-beta.3 不跟随这个变量。可以在“设置 → 其他读取位置”里添加目录，但每个目录都会按 `<目录>/.claude/projects` 去读，所以多数自定义配置目录还是读不到。
- **会话超过 4000 次**：每个时间范围只载入最近的 4000 次。
- **权限**：macOS 可能需要你允许 Oh Agent 读取这个目录。

<!-- source: apps/agent-city/ui/src/CityApp.tsx（windowOptions）；website/landing/i18n.js faq.4、faq.5、faq.7；app_local.rs（SESSION_CAP = 4_000） -->
<!-- source: claude_code/sources/mod.rs 写死了 home/.claude/projects；仓库中未搜到 CLAUDE_CONFIG_DIR -->
<!-- source（外部）：docs.anthropic.com/en/docs/claude-code/settings，“set CLAUDE_CONFIG_DIR; Claude Code then stores your settings, session history, and plugins there”（2026-10-20 读取） -->

## 为什么 Agent City 里缺了较早的会话？

Claude Code 会自己删除旧的会话记录。它的 `cleanupPeriodDays` 设置默认是 **30 天**，清理在会话启动后于后台静默进行。Oh Agent 只能导入日志文件还在电脑上的会话。所以，如果某条记录在 Oh Agent 读取之前就被 Claude Code 删掉了，即使选 90 天或 366 天的时间范围，这个会话也不会出现在 Agent City 里。

想保留更久，可以在 `~/.claude/settings.json` 里调大这个值：

```json
{
  "cleanupPeriodDays": 365
}
```

取值是整数天数，最小为 1。`0` 不被接受；想长期保留，Anthropic 建议填一个很大的值，比如 `3650`。这个设置只对还在的记录生效，已经删掉的找不回来。

Oh Agent 已导入的统计，在 Claude Code 删除日志文件后仍保存在本地数据库里，受 Oh Agent 的保留期（默认 13 个月）和设置中的显式数据删除操作约束。原始对话仍保存在 Claude Code 的日志文件中；源文件被删除后，原文无法查看，但保留下来的统计仍可在所选时间范围内显示于 City。

<!-- source（外部）：https://code.claude.com/docs/en/settings-reference#cleanupperioddays，“Default: 30 … Setting 0 fails validation, so pick a large value such as 3650”；User 作用域为 ~/.claude/settings.json（2026-10-21 读取） -->
<!-- source: sync_service.rs（文件消失只记为遍历错误，不删除数据）；apps/desktop/src-tauri/src/lib.rs（delete_imported_source_data 是用户显式操作）；retention.rs（DEFAULT_RETENTION_MONTHS = 13） -->

## 需要 API Key 或者登录吗？

不需要。Oh Agent 读的是 Claude Code 已经写好的文件，不需要 Anthropic 的 API Key，也不需要注册 Oh Agent 账号。

<!-- source: README.md；website/landing/i18n.js faq.7 -->

## 相关页面

- [Codex 数据来源](/docs/zh/data-sources/codex)
- [Agent City 里的楼代表什么](/docs/zh/city-guide)
- [安装](/docs/zh/install) · [常见问题](https://ohagent.ai/#faq)
