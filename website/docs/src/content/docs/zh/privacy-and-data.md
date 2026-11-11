---
title: Oh Agent 会上传我的会话吗？数据与隐私说明
lastUpdated: 2026-10-22
description: Oh Agent 在 本机分析 Claude Code、Codex 历史，不上传会话。说明它读什么、什么时候联网、接入 MCP 后有什么不同。
head:
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
          {
            "@type": "ListItem",
            "position": 1,
            "name": "Oh Agent",
            "item": "https://ohagent.ai/"
          },
          {
            "@type": "ListItem",
            "position": 2,
            "name": "文档",
            "item": "https://ohagent.ai/docs/zh"
          },
          {
            "@type": "ListItem",
            "position": 3,
            "name": "数据与隐私",
            "item": "https://ohagent.ai/docs/zh/privacy-and-data"
          }
        ]
      }
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "inLanguage": "zh-CN",
        "mainEntity": [
          {
            "@type": "Question",
            "name": "Oh Agent 会上传我的会话吗？",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "不会。Oh Agent 在你的电脑 上分析 Agent 历史，会话、日志和分析结果都不会上传。不需要云端账号，也不需要 API Key。"
            }
          },
          {
            "@type": "Question",
            "name": "Oh Agent 会读取哪些文件？",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "只读取各个 Agent 自己留在用户目录里的会话日志：Claude Code 的 ~/.claude/projects，Codex 的 ~/.codex/sessions 和 ~/.codex/archived_sessions，WorkBuddy 的 ~/.workbuddy，DeepSeek Harness 的 ~/.dsh（设置了 $DSH_HOME 时读该目录）。"
            }
          },
          {
            "@type": "Question",
            "name": "Oh Agent 应用什么时候会联网？",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "只有几种公开请求，而且都不带本机数据：下载公开的价格表和汇率表、到 GitHub 检查有没有新版本，以及在你主动选择时下载官方插件索引或签名包。"
            }
          },
          {
            "@type": "Question",
            "name": "Agent City 能看到哪些信息？",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "城市只拿到宿主声明过、有上限的字段。每次会话：不透明的 ID、属于哪个 Agent、开始和结束时间、事件数、按未缓存输入/缓存读/缓存写/输出拆分的 Token 数、用到的模型 ID、估算费用及其状态、一段有长度限制的标题、最多两条简短的任务摘录，以及一个稳定的 City 资产 ID。整个时间窗：合计、每日活动、按 Agent 和严重度统计的行为发现数量，以及有记录的 skill 使用情况（skill 名称、调用次数、结果、最近使用时间）。它看不到完整提示词、原始日志、文件路径、工作目录、工具参数和原始报错。"
            }
          },
          {
            "@type": "Question",
            "name": "通过 MCP 把 Oh Agent 接给 AI Agent，隐私边界会变吗？",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "会。MCP 只把脱敏后的数据提供给你电脑上的 Agent，但如果这个 Agent 连着云端模型，它拿到的内容就可能随上下文离开你的电脑。要不要接，由你决定；这和只在本机查看不是一回事。"
            }
          }
        ]
      }
---

不会。Oh Agent 在你的电脑 上分析 Agent 历史，会话、日志和分析结果都不会上传。这一页逐条说明：应用读取什么、哪几种情况会联网、接入 MCP 或导出时边界有什么变化。法律意义上的条款见[隐私政策](https://ohagent.ai/#privacy)。

<!-- source: README.md（“Your history stays on your machine”）；AGENTS.md（“Data Retention & Serving-Face Policy (2026-09-19)”） -->

## 关键事实

- 会话在本机分析，**不上传、没有遥测、没有云同步**。
- **不需要账号，也不需要 API Key。**
- 联网只为下载公开文件（价格表、汇率表、版本检查、可选的官方插件索引），**请求里不带任何本机数据**。
- 城市视图只拿到每次会话的有限摘要，**拿不到文件路径、工作目录、工具参数、原始报错和完整提示词**。
- 对话原文留在各个 Agent 自己的日志文件里；Oh Agent 的数据库只存位置索引和统计结果，不存全文副本。
- 代码以 MIT 协议开源，可以自己审查。但开源不等于通过了安全认证。

<!-- source: AGENTS.md 政策第 2、4、6 条；README.md（“MIT licensing makes the implementation inspectable; it is not a security certification”） -->

## Oh Agent 会上传我的会话吗？

不会。Oh Agent 在你的电脑 上分析 Agent 历史，会话、日志和分析结果都不会上传。不需要云端账号，也不需要 API Key。

分析结果存在你电脑上的本地数据库里。[网页演示](https://ohagent.ai/)只用模拟会话，不读取你电脑上的任何东西。

<!-- source: README.md；AGENTS.md（“the app never uploads user data ... do not add telemetry, payload-bearing crash reports, cloud sync”）；website/landing/i18n.js faq.1、faq.7 -->

## Oh Agent 会读取哪些文件？

只读取各个 Agent 自己留在用户目录里的会话日志：Claude Code 的 ~/.claude/projects，Codex 的 ~/.codex/sessions 和 ~/.codex/archived_sessions，WorkBuddy 的 ~/.workbuddy，DeepSeek Harness 的 ~/.dsh（设置了 $DSH_HOME 时读该目录）。

| Agent | 读取的目录 | 详情 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | [Claude Code 数据来源](/docs/zh/data-sources/claude-code) |
| Codex | `~/.codex/sessions`、`~/.codex/archived_sessions`（`rollout-*.jsonl`） | [Codex 数据来源](/docs/zh/data-sources/codex) |
| WorkBuddy | `~/.workbuddy` | — |
| DeepSeek Harness | `~/.dsh`，设置了 `$DSH_HOME` 时读该目录 | — |

对话原文留在这些文件里。Oh Agent 自己的数据库只记录指向日志的位置（来源、事件 ID、偏移量）和统计结果，不保存全文副本。如果 Agent 删掉或轮换了旧日志，Oh Agent 会如实显示“来源已过期”，而不是偷偷留一份。

系统可能会请你允许读取这些目录。

<!-- source: crates/agent-vitals-query/src/sources/watch_topology.rs（default_source_watch_roots） -->
<!-- source: crates/agent-vitals-harnesses/src/harnesses/claude_code/sources/mod.rs；crates/agent-vitals-harnesses/src/harnesses/codex/sources/mod.rs；crates/agent-vitals-harnesses/src/harnesses/workbuddy/sources/mod.rs；crates/agent-vitals-runtime-core/src/core/home.rs（dsh_home） -->
<!-- source: AGENTS.md 政策第 4 条；website/landing/i18n.js faq.7 -->

## Oh Agent 应用什么时候会联网？

只有几种公开请求，而且都不带本机数据：下载公开的价格表和汇率表、到 GitHub 检查有没有新版本，以及在你主动选择时下载官方插件索引或签名包。

| 请求 | 去哪里 | 发送什么 |
|---|---|---|
| 价格表和汇率快照（约每 6 小时检查一次，有更新开关） | 项目仓库里的静态 JSON 文件（`raw.githubusercontent.com`） | 只是下载文件，不带用户数据 |
| 新版本检查 | 项目仓库的 GitHub Releases API | 普通请求，不带用户数据 |
| 官方插件索引或签名包（只在你主动选择时） | 固定的公开 HTTPS 地址 | 只是下载，不带用户数据 |

任何请求都不允许带上本机日志、设备标识、凭据或分析数据。价格表和汇率更新**默认关闭**，只有你明确允许后应用才会检查。

<!-- source: apps/desktop/src-tauri/src/lib.rs（PUBLIC_PRICING_CATALOG_URL、PUBLIC_FX_SNAPSHOT_URL、PRICING_CHECK_INTERVAL_MS = 6 小时、LATEST_RELEASE_API） -->
<!-- source: crates/agent-vitals-ingest/src/ingest/vendor_manifest_install.rs（官方索引地址）；AGENTS.md -->
<!-- source: apps/desktop/src-tauri/src/lib.rs（PricingCatalogPolicy.network_enabled 默认 false，未明确允许前拒绝联网检查）。地址已指向 Oh-Agent-AI/oh-agent。 -->

## Agent City 能看到哪些信息？

城市只拿到宿主声明过、有上限的字段。每次会话：不透明的 ID、属于哪个 Agent、开始和结束时间、事件数、按未缓存输入/缓存读/缓存写/输出拆分的 Token 数、用到的模型 ID、估算费用及其状态、一段有长度限制的标题、最多两条简短的任务摘录，以及一个稳定的 City 资产 ID。整个时间窗：合计、每日活动、按 Agent 和严重度统计的行为发现数量，以及有记录的 skill 使用情况（skill 名称、调用次数、结果、最近使用时间）。它看不到完整提示词、原始日志、文件路径、工作目录、工具参数和原始报错。

交给城市的会话 ID 是加盐生成的应用内标识，不是 Agent 自己的会话 ID。城市作为内置插件运行：它碰不到数据库和日志文件，不能执行任意 SQL，只能拿到宿主为它声明好的字段。费用只是估算，不是账单。City 资产 ID 是随机生成的，存在单独的本地注册表里，不是从你的文件推出来的。

<!-- source: crates/agent-vitals-query/src/query/app_local.rs（dev bf7196a city:v2 字段：id = session_ref(salt, ...)、harness、title、title_source、first/last_event_at、event_count、tokens 含 uncached_input/cache_read/cache_write、model_ids、cost_minor、cost_breakdown、cost_status、task_excerpts；summary、models、activity、findings）；city_v3.rs（asset_ref；module.read findings 计数、skills ≤200 行）；city_assets.rs；AGENTS.md 政策第 6 条 -->

## 通过 MCP 把 Oh Agent 接给 AI Agent，隐私边界会变吗？

会。MCP 只把脱敏后的数据提供给你电脑上的 Agent，但如果这个 Agent 连着云端模型，它拿到的内容就可能随上下文离开你的电脑。要不要接，由你决定；这和只在本机查看不是一回事。

内置 MCP 服务保留脱敏规则，永远不暴露原始报错和工具调用参数。导出默认是脱敏版，要导出未脱敏的版本必须你明确选择。

<!-- source: AGENTS.md 政策第 2 条；README.md（“connecting a networked agent is not equivalent to viewing data locally”） -->

## Oh Agent 会保存我的 API Key 吗？

不会。凭据不会保存在 Oh Agent 的任何文件或数据库里。个别测试功能只会在内存中把 Key 传给子进程。

<!-- source: AGENTS.md 政策第 3 条 -->

## 相关页面

- [隐私政策](https://ohagent.ai/#privacy)
- [Agent City 里的楼代表什么](/docs/zh/city-guide)
- [Claude Code 数据来源](/docs/zh/data-sources/claude-code) · [Codex 数据来源](/docs/zh/data-sources/codex)
- [常见问题](https://ohagent.ai/#faq)
