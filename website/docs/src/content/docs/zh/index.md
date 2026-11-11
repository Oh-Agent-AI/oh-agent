---
title: Oh Agent 是什么？开源的 AI Agent 行为数据分析平台，附带 Agent City
lastUpdated: 2026-10-22
description: Oh Agent 是免费开源的 AI Agent 行为数据分析平台，在你的电脑上本地运行。Agent Vitals 分析 Claude Code、Codex 等会话，Agent City 把它们变成一座 3D 城市，数据不上传。
head:
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "@id": "https://ohagent.ai/#software",
        "name": "Oh Agent",
        "inLanguage": "zh-CN",
        "applicationCategory": "DeveloperApplication",
        "operatingSystem": "macOS 11+（Apple Silicon）、Windows x64、Linux x64",
        "softwareVersion": "1.0.0-beta.3",
        "downloadUrl": "https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3",
        "isAccessibleForFree": true,
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "license": "https://opensource.org/licenses/MIT",
        "url": "https://ohagent.ai/",
        "sameAs": ["https://github.com/Oh-Agent-AI/oh-agent", "https://x.com/ohagentai"],
        "description": "开源、本机运行的 AI Agent 行为数据分析平台。底层 Agent Vitals 在你的电脑上采集和分析 Claude Code、Codex 等 Agent 的会话；上层 Agent City 把它们变成一座可以探索的 3D 城市。"
      }
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
          {"@type": "ListItem", "position": 1, "name": "Oh Agent", "item": "https://ohagent.ai/"},
          {"@type": "ListItem", "position": 2, "name": "文档", "item": "https://ohagent.ai/docs/zh"}
        ]
      }
---

Oh Agent 是一个免费开源的 AI Agent 行为数据分析平台。Agent 已经成了每个人工作和生活的一部分，Oh Agent 想让你的 Agent 更有价值。它以桌面应用的形式运行，构建在开源的 **Agent Vitals** 引擎之上，**Agent City** 是这个引擎上的第一个应用：

- **Agent Vitals（底层）**：本机优先的 Agent 行为数据引擎，作为库嵌在应用里（不是服务器，不常驻后台）。Claude Code、Codex 这些 Agent 本来就会在你电脑上留下会话记录。Agent Vitals 读取并解析这些记录，分析出活动、Token、费用估算和行为发现。
- **Agent City（上层）**：基于 Agent Vitals 的数据接口做成的数据可视化开放世界游戏。每次会话是一栋楼，组成一座可以自由探索的 3D 城市。

所有分析都在你的电脑上完成，会话不会上传。

<!-- source: README.md（“What is Oh Agent?”“Your history stays on your machine”及中文段）；定位按 Bear 2026-10-21 的说法 -->
<!-- source: 两层的代码边界与文件路径见 /docs/zh/architecture/overview（“两层在代码里分别在哪？”） -->

## 关键事实

- **版本**：1.0.0-beta.3，是 [GitHub](https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3) 上的预发布版（Beta）。
- **平台**：Apple Silicon Mac（已签名、已公证）、Windows x64 和 Linux x64（暂未代码签名）。Intel Mac 随后提供。详见[安装](/docs/zh/install)。
- **支持的 Agent**：Claude Code、Codex、DeepSeek Harness、WorkBuddy。
- **一栋楼对应一次会话**，楼高按这次会话的 Token 数取对数后计算。
- **本机运行**：不用注册账号，不用 API Key，会话不上传。
- **许可**：MIT 开源，源码在 [github.com/Oh-Agent-AI/oh-agent](https://github.com/Oh-Agent-AI/oh-agent)。
- **网页演示**：[ohagent.ai](https://ohagent.ai/) 上跑的是真实的城市前端，数据是 2000 条模拟会话，不会读取你电脑上的任何东西。

<!-- source: apps/desktop/src-tauri/tauri.conf.json（version 1.0.0-beta.3，minimumSystemVersion 11.0）；GitHub release app-v1.0.0-beta.3（预发布，arm64 dmg 与 Windows/Linux x86_64 安装包） -->
<!-- source: crates/agent-vitals-query/src/sources/watch_topology.rs（四个数据源监听根） -->
<!-- source: website/landing/README.md（演示 30 天 2000 条模拟会话）；LICENSE -->

## Oh Agent 能看到什么？

- **Agent City**：会话变成数据楼，每种 Agent 占一个城区，Token 多少决定天际线的高低。点一栋楼，就能查看对应的会话。详见[城市里每栋楼代表什么](/docs/zh/city-guide)。
- **活动回放**：在选定的时间范围内回放城市是怎么长起来的。桌面版可以选近 7、30、90 或 366 天。
- **用量视图**：桌面版另有一个页面，按来源和时间查看用量和费用。在城市里，每栋楼的详情会显示估算费用；市政厅等公共建筑可以打开数据面板。

<!-- source: README.md；apps/agent-city/ui/src/CityApp.tsx（windowOptions = [7, 30, 90, 366]） -->

城市只是把记录画出来，并不是生产力评分。楼更高只说明 Token 更多，不说明活干得更好。

## 数据从哪里来？

Oh Agent 读取的是各个 Agent 自己写在用户目录里的会话日志。比如 Claude Code 的在 `~/.claude/projects`，Codex 的在 `~/.codex/sessions`。各家的具体情况：

- [Claude Code 的会话记录存在哪？Oh Agent 怎么读取](/docs/zh/data-sources/claude-code)
- [Codex 的会话记录存在哪？怎么用 Oh Agent 可视化](/docs/zh/data-sources/codex)
- DeepSeek Harness（`~/.dsh`，设置了 `$DSH_HOME` 时读它）和 WorkBuddy（`~/.workbuddy`）也按同样方式读取，见 [Oh Agent 会读取哪些文件](/docs/zh/privacy-and-data)。

## 它是怎么搭起来的？能扩展吗？

项目以 MIT 协议开源，代码在 [Oh-Agent-AI/oh-agent 仓库](https://github.com/Oh-Agent-AI/oh-agent)：Agent Vitals 引擎是 `crates/` 下的一组 Rust crate，桌面应用在 `apps/desktop/`，Agent City 在 `apps/agent-city/`。引擎、命令行、Data MCP 服务和架构的文档会在接下来几天陆续上线。

## 我的数据安全吗？

会话在本机分析，不会上传。应用只会为几件事联网，比如获取公开的价格表、检查新版本，这些请求都不带你的数据。详见[Oh Agent 会上传我的会话吗？](/docs/zh/privacy-and-data)，以及[隐私政策](https://ohagent.ai/#privacy)。

## 怎么安装？

可以下载 1.0.0-beta.3，支持 Apple Silicon Mac、Windows 和 Linux。下载文件、各平台安装步骤和校验方法见[安装 Oh Agent](/docs/zh/install)。

## 更多

- [Agent City 介绍](https://ohagent.ai/?lang=zh#city) · [下载](https://ohagent.ai/?lang=zh#download) · [常见问题](https://ohagent.ai/?lang=zh#faq)
- 关于名字：对外品牌叫 **Oh Agent**，桌面应用叫 `Oh Agent.app`；命令行工具和数据目录内部还叫 `agent-vitals`，不用手动改名。

<!-- source: README.md（“对外品牌为 Oh Agent，内部 CLI、路径和应用标识暂时保留 agent-vitals，无需手工迁移或改名数据目录”） -->
