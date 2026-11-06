---
draft: true
title: Agent Vitals App SDK：Agent City 和其他插件怎么读取 Vitals 数据
description: Agent City 作为 Oh Agent 桌面应用的官方插件运行，通过 @agent-vitals/app-sdk 的 PluginRequestV1 向宿主请求只读投影（city:v2、city:v3、harnesses:v1）。目前只加载编译进应用的官方插件。
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
          {"@type": "ListItem", "position": 4, "name": "App SDK", "item": "https://ohagent.ai/docs/zh/vitals/app-sdk"}
        ]
      }
---

Agent City 是构建在 Agent Vitals 引擎上的第一个应用，以插件的形式运行在 Oh Agent 桌面应用里。插件是一个网页前端，在应用窗口内独立的 WebView 里运行，只能通过一种消息 `plugin_request` 向宿主要数据。宿主按 `apps/desktop/plugins.json` 里声明的权限做检查，在 Rust 里执行查询，只返回对应的投影。目前插件都是官方的、编译进应用里；想加插件要给仓库贡献代码，而不是安装一个包。

## 关键事实

- **注册表**：`apps/desktop/plugins.json`，目前只有 City 一个条目，声明了 `city:v2`、`city:v3`、`city-settings:v1` 和 `harnesses:v1`。
- **隔离**：每个插件在同一窗口里的独立 WebView 中运行（浏览器预览里是 iframe），同一时间只有一个插件处于活动状态。
- **权限**：`dataProjections` 列出插件可以读什么，默认什么都不能读。
- **不能碰数据库**：插件拿不到 SQL、文件路径、原始日志，也拿不到不受限的宿主 IPC。
- **共用 SDK**：`packages/agent-vitals-app-sdk/`（`@agent-vitals/app-sdk`）提供协议类型和界面通信。
- **编译进应用**：注册表在构建时嵌入，改了它就要重新构建应用。

<!-- source: apps/desktop/plugins.json; docs/OFFICIAL_PLUGIN_INTEGRATION_GUIDE.md (同窗独立 Webview; 浏览器预览使用 iframe; 不支持用户动态安装第三方包; include_str! 编译嵌入; 当前一次只运行一个活动插件; dataProjections 默认无数据权限) -->
<!-- source: AGENTS.md policy item 6 -->

## SDK 里有什么？

`@agent-vitals/app-sdk`（私有包，版本 `0.0.0`，没有发布到 npm）导出：

| 导出 | 是什么 |
| --- | --- |
| `PluginRequestV1` | `{version: 1, instanceId, requestId, method, payload}`，插件发给宿主的唯一请求信封 |
| `PluginResponseV1` | `{version: 1, requestId, ok, result, error: {code, retryable}}` |
| `PluginState*` 类型 | 每个插件一个有上限的私有 JSON 存储：每份文档最多 32 KiB，按 revision 做乐观写入 |
| `CityUiProjectionV2` | Agent City 默认渲染用的 `city:v2` 数据 |
| `CityProjectionV3`、`CitySnapshotV3`、`CityWindowV3`、`CitySessionV3`、`CityModuleV3` | 分页投影 `city:v3` 的类型：快照上下文、半开时间窗、带 `asset_ref` 的会话行，以及模块状态（`ready`、`empty`、`unsupported`、`unavailable`、`stale`） |
| `validateCityProjectionV2`、`validateCityProjectionV3` | City 对每个响应做的运行时校验：安全整数、Token 加总、会话数上限（v2 最多 4000，v3 每页最多 500）、`sr_` 快照句柄 |
| `HarnessPublicIdentityV1`、`HarnessListV1`、`HarnessSessionsV1` | 通用 `harnesses:v1` 的类型 |
| `createHarnessDataClient(instanceId, send)` | 封装 `list`、`sessions` 和一致性 `snapshot` 的辅助函数 |
| `negotiateProjection` | 选出双方都支持的投影版本 |
| `./ui-host` | 给嵌入页面用的工具栏发布、宿主命令、语言和健康信号 |

契约类型由 `docs/schemas/` 里的 JSON Schema 生成（`npm run generate:contracts`），并由 `verify:contracts` 检查。

<!-- source: packages/agent-vitals-app-sdk/package.json; src/plugin-rpc.ts; src/index.ts; src/harness-data.ts; src/negotiation.ts; src/ui-host.ts -->

## Agent City 怎么用它？

1. City 的数据 provider 构造一个 `PluginRequestV1`，`method` 是 `"data.read"`，`payload` 是 `{projection: "city", version: 3, operation: "overview", windowDays, …}`，然后分页读取 `city:v3`。落地页宿主和 `?cityData=v2` 仍请求 `{projection: "city", version: 2, windowDays}`。
2. 宿主确认请求来自 City 当前活动的 WebView、且声明了 `city:v3`（或 `city:v2`），然后在 Rust 里执行 `query::city_v3::read` 或 `query::app_local::city_projection`。
3. City 把 v3 页适配成 v2 UI DTO，用 `validateCityProjectionV2` 校验，再在 `cityModel.ts` 里把每个会话映射成一栋楼。见[城市模型](/docs/zh/architecture/city-model)。
4. Findings、Skills 面板和单栋楼详情按需调用 `city:v3`。
5. 在浏览器里（官网演示、独立预览），同一个 provider 返回 `source: "fixture"` 的合成数据，从不调用宿主。

<!-- source: apps/agent-city/ui/src/data/provider.ts; apps/agent-city/ui/src/CityApp.tsx; docs/CITY_LOCAL_DATA_PROJECTION.md (MVP 契约) -->

## 插件能读哪些数据接口？

| 投影 | 方法 | 返回什么 | 谁能用 |
| --- | --- | --- | --- |
| `harnesses:v1` | `harnesses.list` | 数据源：不透明 id、显示名、能力 | 声明了它的任何插件 |
| `harnesses:v1` | `harnesses.sessions` | 7/30/90/366 天窗口内每个数据源的会话统计，每个数据源最多 500 个会话，不含摘录和费用 | 声明了它的任何插件 |
| `city:v2` | `data.read` | City 的视图：最多 4,000 个会话，含 Token 拆分、模型 ID、费用估算和状态、有长度上限的标题和摘录，以及全窗口合计、模型和每日活动 | 声明了它的插件（目前只有 City） |
| `city:v3` | 带 `operation` 的 `data.read` | 基于同一数据快照的分页 City 视图（见下文） | 声明了它的插件 |
| `city-settings:v1` | `data.read` | 种子设置，存在 `state/plugins/{pluginId}.json` | 声明了它的插件 |

`harnesses:v1` 是通用的 Agent Vitals 接口，`city:v2` 和 `city:v3` 是专为 City 设计的。**待确认**：要不要推出一个通用的、有文档的“Vitals 数据接口”供新应用依赖。目前新插件只能拿到 `harnesses:v1`，除非新增一个 Rust 投影处理器。

读取是一致性快照。如果数据在 `harnesses.list` 和 `harnesses.sessions` 之间变了，宿主返回 `revision_changed`，SDK 最多重试三次。

<!-- source: apps/desktop/src-tauri/src/plugin_projections.rs (read_for_plugin) -->
<!-- source: docs/APP_PLUGIN_HARNESS_DATA_CONTRACT.md (每个来源最多 500 个 session; revision_changed; 最多重试三轮) -->
<!-- source: crates/agent-vitals-query/src/query/app_local.rs (SESSION_CAP = 4_000) -->

### `city:v3` 的五个操作是什么？

每个 `city:v3` 请求都带 `operation`。宿主只接受下面五个，每个操作允许的字段各不相同：

| 操作 | 额外字段 | 返回 |
| --- | --- | --- |
| `overview` | `windowDays`、`timezone`、`calendar_mode`（只支持 `rolling`）、`page_size` | 快照上下文、时间窗、数据源身份、`overview` 和 `activity` 模块，以及第一页会话 |
| `sessions.page` | `cursor`、`page_size` | 同一快照的下一页 |
| `session.detail` | `id`、`include_excerpts` | 单个会话及其费用拆分和摘录 |
| `module.read` | `module`（`findings` 或 `skills`），可选 `harness` | 一个数据模块；`workflow` 返回不支持 |
| `assets.resolve` | `save_id`、`asset_refs` | 已保存的 City 资产 ID 是否还存在 |

- **分页**：默认每页 200 个会话，最多 500。时间窗是半开区间 `[from, to)`。
- **快照**：`overview` 之后的每个请求都要带回 `expected_revision` 和 `snapshot`。如果中途数据变了，宿主返回 `revision_changed`，City 丢掉已收集的页重新开始，最多 3 次。

<!-- source: crates/agent-vitals-query/src/query/city_v3.rs（操作白名单；各操作允许字段；page_size 默认 200、1..=500；revision_changed；module.read skills/findings）；apps/agent-city/ui/src/data/provider.ts（attempt < 3） -->

## 插件还能请宿主做什么？

- **在工作台里打开会话**（`navigationTargets: ["session"]`）。插件发送不透明句柄，由 Rust 解析，只返回 `{opened: true}`。
- **保存文件**（`allowLocalExports: true`）。文件以 blob 下载，由用户在系统保存对话框里选位置。没有网络下载，也不能随意写文件。
- **私有状态键**（`stateKeys`），比如 City 的 `flight-profile:v1`。

<!-- source: docs/CITY_LOCAL_DATA_PROJECTION.md (ui.open-session, allowLocalExports); apps/desktop/plugins.json (stateKeys); apps/desktop/src-tauri/src/plugin_state.rs -->

## 怎么加一个新的官方插件？

完整步骤见仓库里的指南 `docs/OFFICIAL_PLUGIN_INTEGRATION_GUIDE.md`。简单说：

1. 在 `apps/<name>/ui/` 建前端，带 `build` 脚本，依赖 `@agent-vitals/app-sdk`，提交 lockfile。
2. 在 `apps/desktop/plugins.json` 里加一个条目，包括 `id`、`name`、`entry`（`plugins/<Name>.plugin/ui/index.html`）、`commandNamespace`、`source` 和 `dataProjections`。
3. 如果需要 `harnesses:v1` 以外的数据，在 `plugin_projections.rs` 里加一个带版本的 Rust 投影处理器，背后是 `crates/agent-vitals-query` 里的查询。声明了投影不等于实现了它。
4. 重新构建桌面应用，因为注册表是编译进去的。

`id` 不能和宿主自带的页签冲突，比如 `overview`、`usage`、`sessions`、`findings`、`trust`、`skills`、`settings`。

<!-- source: docs/OFFICIAL_PLUGIN_INTEGRATION_GUIDE.md §1–§3 ("登记权限不等于实现处理器") -->

## 第三方能发布插件吗？

目前不能。桌面插件宿主只加载 `plugins.json` 里编译进应用的官方界面插件，没有第三方原生插件，也不能动态安装。独立安装或外部安装的应用需要包签名、进程身份、沙盒和按请求的数据授权。仓库里有相关规格（`docs/APP_PACKAGE_SIGNATURE_CONTRACT_V1.md`、`docs/AGENT_VITALS_EXTENSION_ARCHITECTURE_SPEC.md`），但政策文件说明它不保证这些已经实现。**待确认**：第三方插件是否在路线图上。

<!-- source: AGENTS.md policy item 6; AGENTS.md ("this policy does not certify their implementation") -->

## 相关

- [Agent Vitals 引擎总览](/docs/zh/vitals/overview)
- [城市模型](/docs/zh/architecture/city-model)
- [架构总览](/docs/zh/architecture/overview)
- [集成总览](/docs/zh/integrations)
