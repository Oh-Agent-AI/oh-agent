---
draft: true
title: Agent City 怎么把会话变成楼？城市模型
description: Agent City 从 Agent Vitals 数据接口读取最近最多 4000 个会话，包括 Token、模型和费用估算。楼高按总 Token 取对数计算，公共建筑可以打开数据面板。
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
          {"@type": "ListItem", "position": 3, "name": "城市模型", "item": "https://ohagent.ai/docs/zh/architecture/city-model"}
        ]
      }
---

Agent City 是建在 Agent Vitals 之上的游戏层。它默认向宿主请求分页快照 `city:v3`（落地页宿主和 `?cityData=v2` 仍走 `city:v2`），里面是所选时间窗内你最近的最多 4000 个会话。纯 TypeScript 的模型（`cityModel.ts`）把每个会话映射成一栋楼，再由规划器和渲染器排布岛屿、用 three.js 画出来。本页讲数据这一侧；每栋楼长什么样，见[城市里每栋楼代表什么](/docs/zh/city-guide)。

## 关键事实

- **时间窗**：7、30、90 或 366 天，滚动计算。`city:v2` 按 UTC；`city:v3` 按你声明的时区。
- **会话上限**：每个时间窗 4000 个。按最后活动时间保留最近的，再按开始时间从早到晚排，城市因此由内向外生长。
- **1 个会话 = 1 栋楼**。渲染上限同样是 4000，所以载入的每个会话都有自己的楼。
- **楼高 = 总 Token**：未缓存输入 + 缓存读 + 缓存写 + 输出。
- **楼高公式**：`clamp(0.75 × (log10(tokens) − 1)^2.2, 2.6, 48)`。1K Token 约 3.4，100K 约 15.8，10M 约 38.6（场景单位）。
- **岛屿档位**：`ceil(窗口会话数 / 400)`，1 到 10 档，按全窗数量规划，后续分页不会换档重排；每档规划 `ceil(400 × 档位 × 1.35)` 块地。
- **城区 = 数据源**（Claude Code、Codex……），按总 Token 排序。
- **费用以估算显示**。v3 楼卡在费用按需加载时提示打开详情查看估价（`load_on_demand`）；v2 仍在列表行带费用。无法完整计价时，City 显示原因而不是数字。费用不影响楼高。
- **数据设施**：部分公共建筑可以打开数据面板（城市总览、活动与模型、Findings、Skills）。

<!-- source: crates/agent-vitals-query/src/query/app_local.rs（dev bf7196a：SESSION_CAP = 4_000；selection/order；window timezone "UTC"；费用来自 city_v3::cost_breakdown）；city_v3.rs（timezone、rolling、半开区间）；apps/agent-city/ui/src/cityModel.ts；engine/scaleTier.ts；CityExperience.tsx（costLabel）；CityApp.tsx -->

## City 投影里有什么？

默认情况下，City 每个时间窗读取一个 JSON 对象（`protocol: "city:v2"`）：

| 字段 | 含义 |
| --- | --- |
| `harnesses` | 数据源的公开身份：id、显示名、能力 |
| `sessions[]` | 每个会话：不透明的 `id`、`harness`、截断后的 `title` 和 `title_source`、首末事件时间、`event_count`、`tokens {input, uncached_input, cache_read, cache_write, output, total}`、`model_ids`、`cost_minor`、`cost_breakdown`（按币种和计费依据）、`cost_complete`、`cost_status {state, reason, has_unresolved}`、最多 2 条 `task_excerpts` |
| `summary` | 整个时间窗的合计（会话数、用量事件数、Token），不只是已载入的会话 |
| `models`、`model_coverage` | 整个时间窗里出现的模型 ID，以及模型未知或旧数据的用量计数 |
| `activity` | 每日活跃会话、用量行数和 Token，以及最忙的一天 |
| `findings[]` | 按数据源和严重度统计的未关闭行为发现（不细到单个会话） |
| `coverage` | `total`、`returned`、`truncated`、时间未知的计数，以及选取和排序规则 |
| `window`、`generated_at`、`data_revision`、`status` | 快照信息；`status` 是 `ready` 或 `empty` |

- **会话 ID 不可反推**：每个都是加盐的单向句柄（`sr_` + 32 位十六进制），只在 City 内有效。插件拿不到原生会话 ID、路径或数据库主键。
- **费用是估算**：`cost_status.state` 取值为 `estimated`、`subscription`、`unpriced` 或 `unavailable`。多币种或只部分定价的会话不给单一总价。
- **摘录很短，且经过过滤**：每个会话最多 2 条，第一条最多 200 字符，后续一条最多 120 字符。系统包装内容、单独的文件路径和“ok”“继续”这类一词回复会被跳过。
- **不会用假数据顶替**：真实数据读取失败时，City 显示“不可用”，不会切到模拟数据。

<!-- source: app_local.rs（dev：clean_excerpts → make_presentation_excerpt，最多 2 条）；crates/agent-vitals-domain/src/domain/enrichment.rs（make_presentation_excerpt）；packages/agent-vitals-app-sdk/src/city-ui-projection.ts；docs/CITY_LOCAL_DATA_PROJECTION.md -->

### `city:v3` 多了什么？

`city:v3` 是同一份数据的分页、快照版本，有五个操作（见 [App SDK](/docs/zh/vitals/app-sdk)）。打包后的 City 插件默认走 v3（插件 WebView 没有查询串），v3 出错或快照重试耗尽时回退 `city:v2`。网站落地页宿主只回答 v2；`?cityData=v2` 仍可显式关闭。Findings、Skills 和会话详情按需调用 v3。它新增了：

- **`asset_ref`**：每个会话一个稳定、随机的 City 资产 ID，存在单独的注册表 `~/.agent-vitals/state/plugins/city-assets/` 里，不含标题、摘录、路径或原生 ID。
- **`layout_order`、`usage_event_count`、`title_state`**，以及分开的“窗口内”和“整个会话”首末事件时间。
- **按需详情**：`session.detail` 返回单栋楼的费用拆分和摘录，范围是整个会话。

首屏只需总览加第一页；后续页写入按全窗规模规划好的岛屿，不换档重排。原生 macOS 包的点击验收仍是独立步骤。

<!-- source: crates/agent-vitals-query/src/query/city_v3.rs；city_assets.rs；apps/agent-city/ui/src/data/provider.ts（cityDataProtocol：landing/cityData=v2 → v2，否则 v3 并在失败时回退；onPartial 第一页；readCityModule）；docs/CITY_PROJECTION_DATA_COMPLETION_SPEC.md §12 -->

## 哪些建筑能打开数据面板？

公共建筑是数据入口，不是额外的会话，也不是游戏收入。每座建筑对应 `cityDataPlaces.ts` 里的一个数据设施：

| 数据设施（`id`） | 建筑（catalog id） | 显示什么 | dev 上的状态 |
| --- | --- | --- | --- |
| 市政厅 · 城市总览（`overview`） | `civic-hall` | 整个时间窗的统计和载入覆盖情况 | 真实数据 |
| 城市观测站 · 活动与模型（`activity`） | `observation-tower` | 每日活跃会话、用量行数和 Token；出现过的模型 ID | 真实数据 |
| 诊断中心 · Findings（`findings`） | `hospital` | 当前未关闭的积压和窗口内新增，按数据源和严重度 | 按需读取（`module.read`） |
| 技能学院 · Skills（`skills`） | `school` | 有调用证据的 skill：次数、会话数、结果、最近使用时间 | 按需读取（`module.read`），最多 200 行 |
| 调度站 · Workflow（`workflow`） | `station` | 工具执行与结果 | 暂未提供，显示为不支持 |

城市规模小、某座建筑还没生成时，也可以从城市摘要里的“数据设施”目录打开对应面板。

<!-- source: apps/agent-city/ui/src/cityDataPlaces.ts；CityDataFacility.tsx；city_v3.rs（module.read）；docs/CITY_DATA_FACILITIES_PRESENTATION_SPEC.md；commits 3405a36、d4479f2 -->

## 一栋楼怎么算出来？

`buildCityModel` 对每个会话计算：

| 属性 | 规则 |
| --- | --- |
| `height` | `tokensToHeight(total)`（见上面的公式）。Token 最多的约 12 个会话作为地标，再乘 1.12 |
| `seed` | 会话 ID 的 FNV-1a 哈希，刷新后外观不变 |
| `archetype` | 按高度和 seed 定的初始形态：塔楼、板楼、中层、街坊楼或地标 |
| `active` | 今天（本机本地日）有过事件，和菜单栏同一口径 |
| `builtFraction` | 已结束的会话为 1；进行中的会话 = Token ÷ 本区 p95，限制在 0.08–0.92 |
| `busyness` | 近期每小时 Token 量，驱动工地吊车的节奏 |
| `startedAt` | 第一条事件的时间，决定回放时楼什么时候出现 |

**待确认**：`cityModel.ts` 只定初始形态。建筑说明里写的是最终形态跟随地价（好地段长塔楼，便宜地段长板楼和街坊楼），这一步在后面的布局阶段决定。详细写之前要确认最终由哪个文件决定。

<!-- source: cityModel.ts (buildCityModel); apps/agent-city/ui/src/i18n.tsx (地价 strings) -->

## 超过 4000 个会话怎么办？

宿主只返回最近的 4000 个，并设 `coverage.truncated = true`。模型本身也能处理多于渲染上限的情况：按各城区会话占比分配 4000 个楼位，多出来的每个城区合并成 2 到 26 栋低细节的“聚合楼群”。由于宿主上限等于渲染上限，目前真实数据走不到这条分支。

<!-- source: cityModel.ts (quotaOf largest-remainder; fillerCount); app_local.rs (truncated) -->

## 回放怎么实现？

每栋楼从第一条事件长到最后一条事件。模型没有逐事件的 Token 序列，所以会话内的生长是线性近似。回放时，每栋楼的升起时长被限制在 0.9–3.5 秒（墙钟时间），短会话不会一闪而过，长会话也不会一直慢慢爬。

<!-- source: cityModel.ts (builtFractionAt) -->

## 行为发现怎么显示？

行为发现只按数据源统计，所以显示为城区异常标记，而不是落到某一栋楼上。这份列表是不完整的：列表为空不能证明没有问题。目前只覆盖 Claude Code、Codex 和 DSH。更多细节可以打开诊断中心（医院）的面板。

<!-- source: cityModel.ts header; app_local.rs (findings_state: "partial"); session_harnesses.rs (findings for claude-code, codex, dsh) -->

## 渲染在哪里做？

模型之后，City 依次运行规划器（地形、道路、地块）、布局（会话分配到地块）和 three.js 渲染器，代码在 `apps/agent-city/ui/src/engine/`。目标架构是 L0（模型）到 L5（运行时）分层，只有 L4 认识 three.js。这套设计目前还是提案，只落地了一部分。

<!-- source: docs/CITY_ARCHITECTURE.md ("状态：提案"); apps/agent-city/ui/src/engine/ -->

## 相关

- [城市里每栋楼代表什么](/docs/zh/city-guide)
- [架构总览](/docs/zh/architecture/overview)
- [数据管线](/docs/zh/architecture/data-pipeline)
- [App SDK：插件怎么读 Vitals 数据](/docs/zh/vitals/app-sdk)
