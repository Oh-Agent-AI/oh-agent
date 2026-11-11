---
draft: true
title: Oh Agent 能接哪些东西？集成与扩展点
description: Oh Agent 现在实际有的集成点：各 Agent 数据源、其他目录、manifest 数据源、本机 Data MCP 服务、内置插件、导出和 skill 体检，以及还在规划中的功能。
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
          {"@type": "ListItem", "position": 3, "name": "集成", "item": "https://ohagent.ai/docs/zh/integrations"}
        ]
      }
---

Oh Agent 构建在开源的 Agent Vitals 引擎之上，Agent City 是它的第一个应用。引擎在两个方向上对接外部。**数据进来**：读取各 Agent 的本机会话日志，包括四个内置数据源、你添加的其他目录和本地 manifest 数据源。**数据出去**：只走范围很窄的本机接口，包括给你自己的 AI Agent 用的 stdio Data MCP 服务、给内置插件（比如 Agent City）的只读投影，以及你手动发起的文件导出。除了“Roadmap / 规划中”一节，下面所有内容在 `dev` 分支 `bf7196a` 的代码里都有。

## 现在有哪些

| 集成 | 方向 | 给谁用 | 状态 |
| --- | --- | --- | --- |
| [Claude Code](/docs/zh/data-sources/claude-code) | 进 | 所有人 | 内置 |
| [Codex](/docs/zh/data-sources/codex) | 进 | 所有人 | 内置 |
| [DeepSeek Harness (DSH)](/docs/zh/data-sources/deepseek-harness) | 进 | 所有人 | 内置 |
| [WorkBuddy](/docs/zh/data-sources/workbuddy) | 进 | 所有人 | 内置（用量；行为检查较少） |
| [其他目录](/docs/zh/integrations/custom-sources-and-manifests) | 进 | 日志放在别处的用户 | 桌面设置里，支持 Claude Code、Codex、DSH |
| [manifest 数据源](/docs/zh/integrations/custom-sources-and-manifests) | 进 | 用暂不支持的 Agent 的用户 | 命令行和桌面；只支持本地导入，官方目录为空 |
| [Skill 体检](/docs/zh/integrations/skill-auditor) | 进（skills） | 想体检已装 Agent Skills 的用户 | Agent skill、DSH 插件包、命令行 |
| [Data MCP 服务](/docs/zh/vitals/mcp-tools) | 出 | 你本机的 AI Agent（stdio MCP 客户端） | `agent-vitals data-mcp serve` |
| [内置插件](/docs/zh/vitals/app-sdk) | 出（应用内） | 开发 City 这类视图的贡献者 | 官方插件、编译进应用；不支持第三方安装 |
| 数据导出 | 出（文件） | 想备份或分析的用户 | `data-export-private` / `data-export-redacted`，每个数据源一个 `<harness>.jsonl` |
| City 拍照和视频导出 | 出（文件） | 想分享的用户 | 系统保存对话框；只叠加统计，不含摘录 |

<!-- source: session_harnesses.rs; custom_sources.rs; catalog/index.json; apps/cli/src/mcp.rs; apps/desktop/plugins.json; apps/cli/src/main.rs (DataExportPrivate / DataExportRedacted); docs/CITY_LOCAL_DATA_PROJECTION.md; apps/agent-city/ui/src/export/ -->

## 代码里有哪些适配器？

`crates/agent-vitals-harnesses/src/harnesses/` 下每个目录就是一个适配器：

| 适配器目录 | 会话与用量（城市城区） | 行为发现 | Skill 体检 | 文档 |
| --- | --- | --- | --- | --- |
| `claude_code` | 有 | 有 | 有 | [Claude Code](/docs/zh/data-sources/claude-code) |
| `codex` | 有 | 有 | 有 | [Codex](/docs/zh/data-sources/codex) |
| `dsh` | 有 | 有 | 有（按 agent/preset 作用域） | [DeepSeek Harness](/docs/zh/data-sources/deepseek-harness) |
| `workbuddy` | 有 | 同步时不评估 | 有 | [WorkBuddy](/docs/zh/data-sources/workbuddy) |
| `openclaw`（兼管 Hermes） | 无 | 无 | 有 | [Skill 体检](/docs/zh/integrations/skill-auditor) |
| `generic`（manifest 数据源） | 只有用量 | 无 | 无 | [manifest 数据源](/docs/zh/integrations/custom-sources-and-manifests) |

<!-- source: crates/agent-vitals-harnesses/src/harnesses/mod.rs; session_harnesses.rs; */skills; docs/HARNESS_ADAPTER_CONTRACT.md (observer table) -->

**待确认**：DSH 是否有自己的 skill 模块。代码里没有 `harnesses/dsh/skills/` 目录，DSH 的 skill 作用域只在 `HARNESS_ADAPTER_CONTRACT.md` 里有描述。

## 该用哪一个？

- **想让自己的 AI Agent 回答用量问题**：用 [Data MCP 服务](/docs/zh/vitals/mcp-tools)。
- **Claude Code、Codex 或 DSH 的日志在别的地方**（比如备份盘）：添加[其他目录](/docs/zh/integrations/custom-sources-and-manifests)。
- **你的 Agent 还不支持**，但会写带 Token 用量的 JSONL 日志：写一个 [manifest](/docs/zh/integrations/custom-sources-and-manifests)，不用写代码。
- **想给新 Agent 做完整支持**（包括行为检查）：用 Rust [添加数据源](/docs/zh/contributing/adding-a-data-source)，然后提 PR。
- **想在 Agent Vitals 数据上做新的可视化视图**：见 [App SDK](/docs/zh/vitals/app-sdk)。

## 仓库里还保留的旧集成

在 Agent City 之前，项目做的是一个 skill 体检工具，现在仍在仓库里：一个 agent skill（`SKILL.md`，打包发布到 ClawHub）、一个 DSH 插件包（`integrations/dsh/`），以及一组命令行命令。OpenClaw 和 Hermes 只出现在这里。见 [Skill 体检](/docs/zh/integrations/skill-auditor)。

<!-- source: README.md ("The earlier Skill scanner, integrations and CLI remain in the repository, but are not the primary product story") -->

## Roadmap / 规划中

下面这些在 `dev` 分支 `bf7196a` 的代码里都还没有，上线前一律标为待确认。

- **待确认：增量热更新**。现在数据一变，City 会重新读取完整投影并重建整个场景，布局保持稳定、带生长动画（见[数据管线](/docs/zh/architecture/data-pipeline#有新会话时-agen
- **部分完成：让 Agent 帮你建城（MCP）。** `get_building` / `preview_building` / `set_building_model` / `reset_building` 按 `asset_ref` 持久化 `session-kit/v1` 覆盖。打开的 City 窗口用共享 `CityEntityChanged` 事件播放施工；预览显示幽灵楼，合规/细节回退/设计连贯性拒绝会闪地块。偏软的设计问题走 `data.warnings`。写入还会扇出小队 IM 信封；Agent 用 `im_publish` 发 `chat` / `claim` / `release`。见 `docs/CITY_BUILDING_MCP.md` 与 `docs/CITY_SQUAD_IM.md`。
- **待确认：增量热更新**。现在数据一变，City 会重新读取投影并重建场景，布局保持稳定、带生长动画（见[数据管线](/docs/zh/architecture/data-pipeline#有新会话时-agent-city-怎么更新)）。像 Vite 那样只传变化的会话、只更新单栋楼，还没有实现。默认的 `city:v3` 分页已经能在不重排岛屿的前提下追加后续页。
- **待确认：城市作品廊（UGC）**，分享和浏览别人的城市。仓库里没有相关代码。
- **待确认：人人可用的地图编辑器**。城市“修复”编辑器已经有了，P0 在 2026-10-12 完成；但做成正式功能（去掉开发开关、中英文、新手引导）和地图修改的导入导出，都排在后面的 P3。
- **待确认：官方 manifest 目录**。下载通道和校验都有了，但 `catalog/index.json` 目前没有条目。
- **未承诺**：manifest 的脚本适配器（P1.5）、表达式语言（P2）和社区 manifest 目录（P3）只是设计预留。
- **评估过、没实现**：仓库里有把 Cline、Pi、Hermes 作为会话数据源的评估文档（`docs/*_HARNESS_ASSESSMENT.md`）。**待确认**：有没有计划接入。

<!-- source: crates/agent-vitals-mcp/src/mcp/mod.rs (city building tools); docs/CITY_MAP_EDITOR_ROADMAP_SPEC.md; docs/HARNESS_MANIFEST_DSL_SPEC.md §1; catalog/README.md; docs/*_HARNESS_ASSESSMENT.md -->

## 相关

- [Agent Vitals 引擎](/docs/zh/vitals/overview)
- [架构总览](/docs/zh/architecture/overview)
- [数据管线](/docs/zh/architecture/data-pipeline)
- [添加新的数据源](/docs/zh/contributing/adding-a-data-source)
