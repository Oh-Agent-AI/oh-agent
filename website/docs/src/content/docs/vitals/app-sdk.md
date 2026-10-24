---
draft: true
title: "Agent Vitals App SDK: how Agent City and other plugins read Vitals data"
description: Agent City is an official built-in plugin. Plugins run in their own WebView and read only the projections they declare in plugins.json, through the host, never the database.
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
          {"@type": "ListItem", "position": 2, "name": "Docs", "item": "https://ohagent.ai/docs"},
          {"@type": "ListItem", "position": 3, "name": "Agent Vitals engine", "item": "https://ohagent.ai/docs/vitals/overview"},
          {"@type": "ListItem", "position": 4, "name": "App SDK", "item": "https://ohagent.ai/docs/vitals/app-sdk"}
        ]
      }
---

Agent City is the first app built on the Agent Vitals engine, and it runs as a plugin of the Oh Agent desktop app. A plugin is a web frontend that runs in its own WebView inside the app window and asks the host for data through one message type, `plugin_request`. The host checks the plugin's declared permissions in `apps/desktop/plugins.json`, runs the query in Rust, and returns only that projection. Today plugins are official and compiled into the app. You add one by contributing to the repo, not by installing a package.

## Key facts

- **Registry:** `apps/desktop/plugins.json`. City is the only entry today; it declares `city:v2`, `city:v3`, `city-settings:v1` and `harnesses:v1`.
- **Isolation:** each plugin runs in a separate WebView in the same window (an iframe in the browser preview), and only one plugin is active at a time.
- **Permissions:** `dataProjections` lists what a plugin may read. The default is nothing.
- **No database access:** plugins never get SQL, file paths, raw logs or unrestricted host IPC.
- **Shared SDK:** `packages/agent-vitals-app-sdk/` (`@agent-vitals/app-sdk`) holds the protocol types and the UI transport.
- **Compiled in:** the registry is embedded at build time, so changing it means rebuilding the app.

<!-- source: apps/desktop/plugins.json; docs/OFFICIAL_PLUGIN_INTEGRATION_GUIDE.md (同窗独立 Webview; 浏览器预览使用 iframe; 不支持用户动态安装第三方包; include_str! 编译嵌入; 当前一次只运行一个活动插件; dataProjections 默认无数据权限) -->
<!-- source: AGENTS.md policy item 6 ("plugins never access the authority DB or harness logs directly and never receive arbitrary SQL or unrestricted host IPC") -->

## What is in the SDK?

`@agent-vitals/app-sdk` (private, version `0.0.0`, not published to npm) exports:

| Export | What it is |
| --- | --- |
| `PluginRequestV1` | `{version: 1, instanceId, requestId, method, payload}`, the only request envelope from plugin to host |
| `PluginResponseV1` | `{version: 1, requestId, ok, result, error: {code, retryable}}` |
| `PluginState*` types | A bounded private JSON store per plugin: up to 32 KiB per document, with revision-based optimistic writes |
| `CityUiProjectionV2` | The `city:v2` payload Agent City renders by default |
| `CityProjectionV3`, `CitySnapshotV3`, `CityWindowV3`, `CitySessionV3`, `CityModuleV3` | The paged `city:v3` types: snapshot context, half-open window, session rows with `asset_ref`, and module states (`ready`, `empty`, `unsupported`, `unavailable`, `stale`) |
| `validateCityProjectionV2`, `validateCityProjectionV3` | Runtime validators City runs on every response: safe integers, token sums, at most 4,000 (v2) or 500 per page (v3) sessions, `sr_` snapshot handles |
| `HarnessPublicIdentityV1`, `HarnessListV1`, `HarnessSessionsV1` | The generic `harnesses:v1` types |
| `createHarnessDataClient(instanceId, send)` | A helper for `list`, `sessions` and a consistent `snapshot` |
| `negotiateProjection` | Picks a projection version both sides support |
| `./ui-host` | Toolbar publishing, host commands, locale and health signals for the embedded page |

Contract types are generated from JSON Schemas in `docs/schemas/` (`npm run generate:contracts`) and checked by `verify:contracts`.

<!-- source: packages/agent-vitals-app-sdk/package.json ("private": true, "version": "0.0.0", exports "." and "./ui-host", generate:contracts / verify:contracts); src/plugin-rpc.ts (PluginRequestV1, PluginResponseV1, PluginState* "单文档 ≤ 32 KiB，revision 乐观并发"); src/index.ts (dev: export * from "./city-ui-projection.js"); src/city-ui-projection.ts (CityProjectionV3 …, validateCityProjectionV2/V3); src/harness-data.ts; src/negotiation.ts; src/ui-host.ts -->

## How does Agent City use it?

1. City's data provider builds a `PluginRequestV1` with `method: "data.read"` and `payload: {projection: "city", version: 3, operation: "overview", windowDays, …}`, then pages `city:v3`. The landing host and `?cityData=v2` still request `{projection: "city", version: 2, windowDays}`.
2. The host checks that the request came from City's active WebView, that `city:v3` (or `city:v2`) is declared, and runs `query::city_v3::read` or `query::app_local::city_projection` in Rust.
3. City adapts v3 pages into the v2 UI DTO, validates with `validateCityProjectionV2`, and maps each session to a building in `cityModel.ts`. See [City model](/docs/architecture/city-model).
4. The Findings and Skills panels, and per-building details, call `city:v3` on demand.
5. In the browser (website demo, standalone preview), the same provider returns a synthetic fixture with `source: "fixture"` and never calls a host.

<!-- source: apps/agent-city/ui/src/data/provider.ts (CityDataProvider; PluginRequestV1/PluginResponseV1 import; fixtureProjection source: "fixture"); apps/agent-city/ui/src/CityApp.tsx (projection → buildCityModel); docs/CITY_LOCAL_DATA_PROJECTION.md (MVP 契约: method "data.read", payload { projection: "city", version: 2, windowDays }) -->

## What data interfaces can a plugin read?

| Projection | Method | What it returns | Who uses it |
| --- | --- | --- | --- |
| `harnesses:v1` | `harnesses.list` | Sources: opaque id, display name, capabilities | Any plugin that declares it |
| `harnesses:v1` | `harnesses.sessions` | Per-source session stats for a 7/30/90/366-day window, at most 500 sessions per source, no excerpts or cost | Any plugin that declares it |
| `city:v2` | `data.read` | City's view: up to 4,000 sessions with token split, model IDs, cost estimate and status, bounded titles and excerpts, plus window totals, models and daily activity | Plugins that declare it (only City today) |
| `city:v3` | `data.read` with `operation` | Paged City view on one data snapshot (see below) | Plugins that declare it |
| `city-settings:v1` | `data.read` | Seed setting stored at `state/plugins/{pluginId}.json` | Plugins that declare it |

`harnesses:v1` is the general Agent Vitals interface. `city:v2` and `city:v3` are shaped for City. **TBD:** whether to promote a general, documented "Vitals data interface" that new apps can rely on. Today a new plugin gets `harnesses:v1` only, unless a new Rust projection handler is added.

Reads take a consistent snapshot. If the data changes between `harnesses.list` and `harnesses.sessions`, the host returns `revision_changed` and the SDK retries up to three times.

<!-- source: apps/desktop/src-tauri/src/plugin_projections.rs (read_for_plugin: harnesses.list / harnesses.sessions → query::app_harnesses; data.read city:v2 → query::app_local::city_projection; city-settings:v1) -->
<!-- source: docs/APP_PLUGIN_HARNESS_DATA_CONTRACT.md (每个来源最多 500 个 session; 不提供 task excerpts、成本、模型…; revision_changed; createHarnessDataClient … 最多重试三轮) -->
<!-- source: crates/agent-vitals-query/src/query/app_local.rs (SESSION_CAP = 4_000) -->

### What are the five `city:v3` operations?

Every `city:v3` request carries `operation`. The host accepts only these five, each with its own allowed fields:

| Operation | Extra fields | Returns |
| --- | --- | --- |
| `overview` | `windowDays`, `timezone`, `calendar_mode` (`rolling` only), `page_size` | Snapshot context, window, source identities, `overview` and `activity` modules, and the first page of sessions |
| `sessions.page` | `cursor`, `page_size` | The next page from the same snapshot |
| `session.detail` | `id`, `include_excerpts` | One session with its cost breakdown and excerpts |
| `module.read` | `module` (`findings` or `skills`), optional `harness` | One data module; `workflow` is reported as unsupported |
| `assets.resolve` | `save_id`, `asset_refs` | Whether saved City asset IDs still exist |

- **Pages:** default 200 sessions, at most 500. The window is half-open, `[from, to)`.
- **Snapshots:** every request after `overview` must send back `expected_revision` and `snapshot`. If the data changed in between, the host answers `revision_changed`. City then drops the pages it has collected and starts again, at most 3 times.

<!-- source: crates/agent-vitals-query/src/query/city_v3.rs (operation whitelist; allowed fields per operation; page_size default 200, 1..=500; revision_changed; module.read skills/findings); apps/agent-city/ui/src/data/provider.ts (attempt < 3) -->

## What else can a plugin ask the host for?

- **Open a session in the workbench** (`navigationTargets: ["session"]`). The plugin sends its opaque handle; Rust resolves it and only returns `{opened: true}`.
- **Save a file** (`allowLocalExports: true`). The file is a blob download, and the user picks the destination in a native save dialog. No network downloads, no arbitrary file writes.
- **Private state keys** (`stateKeys`), for example City's `flight-profile:v1`.

<!-- source: docs/CITY_LOCAL_DATA_PROJECTION.md (ui.open-session, allowLocalExports); apps/desktop/plugins.json (stateKeys: ["flight-profile:v1"]); apps/desktop/src-tauri/src/plugin_state.rs -->

## How do I add a new official plugin?

The repo's guide (`docs/OFFICIAL_PLUGIN_INTEGRATION_GUIDE.md`) covers the full steps. In short:

1. Create the frontend at `apps/<name>/ui/` with a `build` script and a dependency on `@agent-vitals/app-sdk`. Commit the lockfile.
2. Add an entry to `apps/desktop/plugins.json` with `id`, `name`, `entry` (`plugins/<Name>.plugin/ui/index.html`), `commandNamespace`, `source` and `dataProjections`.
3. If it needs data beyond `harnesses:v1`, add a versioned Rust projection handler in `plugin_projections.rs`, backed by a query in `crates/agent-vitals-query`. Declaring a projection doesn't implement it.
4. Rebuild the desktop app. The registry is compiled in.

`id` can't clash with host tabs such as `overview`, `usage`, `sessions`, `findings`, `trust`, `skills` or `settings`.

<!-- source: docs/OFFICIAL_PLUGIN_INTEGRATION_GUIDE.md §1–§3 ("登记权限不等于实现处理器") -->

## Can third parties publish plugins?

Not today. The desktop plugin host loads only the official UI plugins compiled into the app from `plugins.json`. There are no third-party native plugins and no dynamic install. Independent or externally installed apps would need package signing, process identity, sandboxing and per-request data grants. The repo has specs for these (`docs/APP_PACKAGE_SIGNATURE_CONTRACT_V1.md`, `docs/AGENT_VITALS_EXTENSION_ARCHITECTURE_SPEC.md`), but the policy says it doesn't certify their implementation. **TBD:** whether a third-party plugin path is on the roadmap.

<!-- source: AGENTS.md policy item 6 ("Independent or externally installed applications: retain package verification, platform process identity, sandbox restrictions …"); AGENTS.md ("this policy does not certify their implementation") -->

## Related

- [Agent Vitals engine overview](/docs/vitals/overview)
- [City model](/docs/architecture/city-model)
- [Architecture overview](/docs/architecture/overview)
- [Integrations overview](/docs/integrations)
