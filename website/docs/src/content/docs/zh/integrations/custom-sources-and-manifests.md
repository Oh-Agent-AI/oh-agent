---
draft: true
title: 怎么让 Oh Agent 读其他目录的日志，或者接入暂不支持的 Agent？
description: 在设置里给 Claude Code、Codex、DSH 添加其他日志目录；或者用一个 JSON manifest 描述其他 Agent 的 JSONL 日志，Oh Agent 导入时不执行任何代码。
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
          {"@type": "ListItem", "position": 4, "name": "其他目录与 manifest 数据源", "item": "https://ohagent.ai/docs/zh/integrations/custom-sources-and-manifests"}
        ]
      }
---

Agent Vitals 有两种方式读取默认目录以外的数据。**其他目录**：给内置数据源（Claude Code、Codex 或 DeepSeek Harness）多加几个读取位置，用的是同一套解析器。**manifest 数据源**：用一个 JSON 文件描述另一个 Agent 的 JSONL 日志，不写代码、不用重启就能导入它的 Token 用量。manifest 数据源有用量和费用估算，但没有行为检查。

## 关键事实

- **其他目录**：桌面设置 →“其他读取位置”。支持 Claude Code、Codex、DSH，不支持 WorkBuddy。必须是已存在目录的绝对路径。
- **保存在** `~/.agent-vitals/state/custom-sources.json`，只在本机生效。
- **manifest 数据源**放在 `~/.agent-vitals/harnesses.d/<slug>/manifest.json`，数据的来源 id 是 `harness:<slug>`。
- **不执行任何代码**：manifest 只能从三个内置提取配方里选一个，用点路径映射字段。脚本适配器和表达式规则都会被拒绝。
- **费用永远是估算**（`metered_estimate`，带 `has_unresolved`），manifest 改不了这一点。
- **会出现在城市里**：City 的数据源列表用的是通用身份，所以 manifest 数据源也能有自己的城区。**待确认**：在真机上核实。

<!-- source: apps/desktop/ui-dev/react/src/lib/i18n.ts ("sx.locTitle": "其他读取位置"); apps/desktop/src-tauri/src/lib.rs (custom_source_roots …); custom_sources.rs; harness_registry.rs; source_controls.rs; generic/manifest.rs; plugin_ingest.rs (billing lock); docs/CITY_LOCAL_DATA_PROJECTION.md -->

## 其他目录该选哪个文件夹？

:::caution[待确认：发布前核实]
代码里，你添加的目录会交给和用户主目录同一个文件查找函数，这个函数会自动拼上该 Agent 的常规子路径。所以 Codex 实际读的是 `<目录>/.codex/sessions/` 和 `<目录>/.codex/archived_sessions/`，Claude Code 读的是 `<目录>/.claude/projects/`，DSH 读的是 `<目录>/sessions/`。但设置页输入框的提示文字是 `/Volumes/…/sessions`，暗示直接选 sessions 文件夹本身，这样 Codex 和 Claude Code 会什么都读不到。需要和维护者确认预期行为，然后改代码或改提示文字。
:::

<!-- source: sync_service.rs ((harness.files_under)(Path::new(&source.root))); session_harnesses.rs; SettingsPage.tsx (placeholder="/Volumes/…/sessions") -->

这也是为什么自定义的 `CLAUDE_CONFIG_DIR` 或 `CODEX_HOME` 通常覆盖不到：这类目录很少恰好叫 `.claude` 或 `.codex`，又放在一个你能选中的父目录里。

## manifest 长什么样？

下面的例子来自设计规格，描述的是一个叫 ZCode 的 Agent。只是示意，不代表官方支持它：

```json
{
  "manifest_version": 1,
  "slug": "zcode",
  "display": { "name": "ZCode" },
  "discovery": {
    "roots": ["~/.zcode/cli/rollout"],
    "include": ["model-io-sess_*.jsonl"]
  },
  "source": { "format": "jsonl" },
  "session": {
    "from": "filename",
    "pattern": "^model-io-sess_(?P<id>.+)\\.jsonl$"
  },
  "recipe": "request-usage-anthropic-v1",
  "overrides": {
    "event_ts": "completedAt",
    "model_raw": "model.modelId",
    "uncached_input_tokens": "usage.input_tokens",
    "output_tokens": "usage.output_tokens",
    "cache_read_tokens": "usage.cache_read_input_tokens",
    "cache_write_tokens": "usage.cache_write_input_tokens",
    "provider_request_id": "requestId"
  },
  "event_key": { "paths": ["requestId", "attempt"] },
  "billing": { "policy": "lock:metered_estimate" }
}
```

- **配方**（三选一）：`request-usage-anthropic-v1`、`request-usage-openai-total-input-v1`、`request-usage-four-bucket-v1`。
- **可重映射的字段**：`event_ts`、`model_raw`、`provider_raw`、`uncached_input_tokens`、`total_input_tokens`、`cache_read_tokens`、`cache_write_tokens`、`output_tokens`、`provider_request_id`。
- **保留名**：`claude-code`、`codex`、`dsh`、`workbuddy`、`openclaw`、`hermes`，防止 manifest 冒充内置数据源。
- **行数上限**：每个文件默认 5 万条，最多 50 万条。超过上限整个文件跳过，不会截断。
- **Schema**：仓库里的 `docs/schemas/harness-manifest-v1.json`。

<!-- source: docs/HARNESS_MANIFEST_DSL_SPEC.md Appendix B.1; generic/manifest.rs; docs/schemas/harness-manifest-v1.json; golden/harness-generic-zcode.json -->

## 怎么测试和安装 manifest？

用命令行：

```sh
M=~/.agent-vitals/harnesses.d/zcode/manifest.json

# 试运行：发现文件、提取、检查事实 ID 稳定性和格式。不写任何东西。
agent-vitals manifest-validate --manifest "$M" --json

# 安装分两步：先预览，再用预览打印出的 preview_sha256 确认。
agent-vitals manifest-install --manifest "$M" --machine-namespace <ns>
agent-vitals manifest-install --manifest "$M" --machine-namespace <ns> --confirm <preview_sha256>

# 查看已登记的数据源和数据情况。
agent-vitals manifest-list
agent-vitals harness-inventory --window-days 30
```

`manifest-uninstall --slug`、`manifest-rollback --slug --revision` 和 `manifest-recompute` 都是同样的“先预览、再 `--confirm`”流程。旧的直写命令 `manifest-ingest` 已经退役：安装之后，交给正常同步去导入数据。

**待确认**：用户从哪里拿到 `<ns>`。有一个 `machine-namespace` 子命令，但这套流程还没有为文档完整跑过一遍。另外待确认：桌面版会不会加本地导入界面。目前桌面只有官方目录相关的命令（`manifest_catalog_status`、`install_manifest_catalog_harness`）。

<!-- source: apps/cli/src/main.rs (Manifest* args; ManifestIngest "Retired direct-write command"; MachineNamespace); apps/desktop/src-tauri/src/lib.rs -->

## manifest 数据源没有什么？

- **行为发现**（SV6xx 检查）和会话轨迹。这些只对审核过的内置数据源开放。
- **订阅计价**。没有官方订阅证据，用量始终是按量估算。
- **官方目录**（暂时）。应用可以从本仓库的目录拉取审核过的 manifest，但 `catalog/index.json` 目前没有条目。

<!-- source: docs/HARNESS_MANIFEST_DSL_SPEC.md §0–§1; docs/APP_PLUGIN_HARNESS_DATA_CONTRACT.md; catalog/README.md -->

## 相关

- [数据管线](/docs/zh/architecture/data-pipeline)
- [用代码添加新的数据源](/docs/zh/contributing/adding-a-data-source)
- [集成总览](/docs/zh/integrations)
