# APP_LAYER M0 评审与路线决议（2026-10-03）

> 本文保留当时的路线决议与检查范围；当前归并版本和验收状态见
> `WORKTREE_MAIN_CONSOLIDATION_REPORT.md`。

版本：修订版 r2。状态：用户既有范围决策已记录；实现状态已复核；最终合并验收待关闭。
评审对象：`codex/app-layer-city` worktree，路径 `/Users/Admin/.codex/worktrees/app-layer-city/skill-vitals`。
本次复核时 HEAD 为 `564c6726c7194fd72ab42051ed510c80061ca4d7`，评审包含未提交工作区；该提交号不能单独重现本文所述新增实现。
本次修订核对源码和现有验收台账，没有重新执行完整测试或原生 UI 验收。最终合并结论须绑定整理后的提交与验证记录。

## §1 评审结论

**正式目标是 Agent Vitals 内的官方前端插件：City 与 Overview 平级，以独立 WebView 呈现；Rust 后端为插件提供数据服务。用户明确不认可独立版 City APP，该路线从本项目目标和里程碑中移除。**

当前可以继续整理提交与完成验收；本文尚不构成合并通过记录。插件化和 `host`→`harness` 改名均来自用户明确需求。内部开发阶段允许不兼容改名和旧数据库重建，缺少历史迁移不能直接认定为需求违约。

当前源码已有真实本地数据投影处理器，不能继续以“fixture-only、Rust provider 未实现”描述分支。合并前重点是实际接口契约收口、规格状态一致、新版原生 UI 验收及最终提交验证。

## §2 已确认的产品决策

| 决策 | 适用范围 |
| --- | --- |
| City 抽成插件，Rust 与前端分离 | City 是前端项目；数据查询由 Agent Vitals Rust 后端提供，插件不直接读取数据库 |
| City 与 Overview 是平级 tab | 同一宿主窗口、统一导航和顶部工具栏；插件定义工具项，宿主渲染并派发命令 |
| 不做独立版 City APP | 不交付 AgentCity.app、独立 City 窗口、安装器、应用授权入口或独立应用更新回滚；这些均不进入后续 City 里程碑 |
| 首版只接入自己的官方插件 | 先做好代码解耦、独立 UI 执行边界、通信与故障恢复；第三方市场及其接入规范不属于当前目标 |
| `host` 是 Agent Vitals 本体，执行环境改称 `harness` | 统一内部字段、来源 ID、crate、CLI 与文档命名 |
| 内部开发期无需历史兼容，数据库可以重建 | 允许不兼容切换，不强制保留旧字段别名或完整旧库迁移链 |

以上范围已有用户明确授权，本修订将其记录为项目决定。`AgentCity.plugin` 是宿主加载的普通插件资源目录，不是 macOS 应用包；源码独立、构建独立与独立桌面产品是不同概念。

数据库可重建不等于自动删除现有数据。需明确重建步骤，保留原始日志；当前仍支持的 harness 日志必须正常摄入。旧派生文件、来源控制状态与历史标识的处理范围应写入重建说明。

官方内置插件的简化范围已确认。敏感字段增加和出网变化仍按具体用途记录产品决定；这不授权任意用户数据上传、完整提示词、凭据或 canary 暴露。

## §3 当前实现与证据

### 3.1 UI、隔离及真实数据路径

City 源码与资源位于 `apps/agent-city/ui`，独立构建为插件 UI 产物。宿主通过通用插槽加载；桌面使用同窗原生子 WebView，浏览器预览使用 iframe/postMessage。

当前真实数据路径：

`City → SDK plugin_request → Rust PluginHost → plugin_projections → query::app_local → readonly AuthorityDb`

`apps/desktop/plugins.json` 声明投影与操作范围。PluginHost 校验活动 WebView、实例及请求信封，处理器执行查询，响应交付前再次检查实例。因此撤回旧稿“plugin_request 恒返 provider_unavailable”“Rust provider 未实现”的判断。

原生生产 City 读取真实本地投影；Standalone 前端预览、浏览器和明确的隔离测试模式使用合成 fixture。这里的 Standalone 仅指前端开发预览，不表示独立 City APP 产品。生产读取失败显示不可用，不自动换成 fixture 冒充真实统计。

当前还包含私有种子设置、宿主会话导航及导出路径。数据最多返回 500 个会话，coverage 报告截断；Findings 为部分汇总，费用、模型和完整轨迹尚未进入投影。源码路径已接通不代表新版原生界面与最终安装包全部验收完成。

### 3.2 规格版本与历史方案

| 文档 | 当前定位 | 收口要求 |
| --- | --- | --- |
| 主 checkout 架构规格 v0.2 | 已被用户否定的独立 City APP 设计稿 | 归档为历史方案，明确取消；不得继续作为实施或验收依据 |
| worktree 架构规格 v1.6 | 当前同窗官方插件路线的实现参考 | 统一头部及早期 fixture-only / 无 provider 段落与后续真实数据接入状态 |
| worktree 实施计划 | 早期 fixture 迭代记录与后续接入记录并存 | 区分历史完成记录、当前实现和待验收事项 |

主 checkout 与 worktree 的架构规格目前均为未跟踪文件；查询到的 Git 历史没有提供该路径的修订记录。可以确认方案并存及权威不清，不能据此断言原始稿被覆盖丢失或承诺全文可从 Git 恢复。此前提及的 P0–P6/ADR 原稿应标为待定位材料，找到可核验内容后再归档。

统一规格须明确替代关系，和本评审、实施计划一起纳入版本控制。历史方案中的通用服务边界可以参考；独立 City APP 的安装、签名和 broker 生命周期不再纳入 City 任务。

### 3.3 实际契约

UI provider 当前把 `CityProjectionV1` 定义为 SDK `CityUiProjectionV1` 的类型别名，已不在 provider 内复制完整结构；但 **`CityUiProjectionV1` 是手写共享类型，不是 schema 生成物**。

现有 `city-v1-app-local-{request,response}.json` 与生成的 `CityDataProjectionV1` 对应旧设计的分页、snapshot/cursor 接口。当前 MVP 请求使用 `{ projection: "city", version: 1, windowDays }`，响应使用 `protocol / sessions / findings / coverage`。两套接口不同，旧 schema 合约测试通过不能证明实际 Rust 输出符合 UI 契约。

需要为当前插件实际请求与响应建立 schema 单一真源，生成共享类型并验证真实处理器输出。推荐沿用已有简化数据形状；不因旧 schema 存在而强制引入分页、独立应用授权或 broker。

### 3.4 工作区整理

本次检查中，旧宿主 CityPage、engine、assets 等源码已不在旧路径；当前桌面 tsconfig 也没有 City 专项 exclude。因此撤回旧稿关于重复副本、CityPage 悬空 import 与 exclude 掩盖的现状断言。

较大的未提交变更集仍需形成可审查提交，检查移动、删除与引用关系。固定文件数量不作为验收依据。空 `apps/agent-city/backend/` 目录属于整理项，Git 不跟踪空目录；它不构成编译阻断，也不应暗示 City 需要自有 Rust 后端。

## §4 架构边界

宿主负责导航、统一工具栏、实例生命周期、超时与局部恢复；City 拥有自己的前端代码、React 根、DOM、CSS、领域模型和渲染引擎。双方通过通用版本化请求、响应和事件通信，不共享 React store 或数据库连接。

Rust 中的业务投影处理器属于 Agent Vitals 后端；通用 PluginHost 管理调用及实例边界。插件前端不应为数据服务另建独立桌面应用。`AgentCity.plugin` 的独立构建和加载边界用于宿主内扩展。

原生隔离结论只适用于已测试的平台、构建和故障类型。浏览器 iframe 测试不证明原生独立进程；共享 GPU 或全系统资源耗尽不承诺绝对隔离。旧稿“约 10% 成本”的说法没有测量依据，撤回。

第三方插件市场、独立插件分发等可在用户另行立项后评估，当前不预置为 City 后续必做路线，也不因插件增加功能自动触发独立版 City APP。

## §5 合并前收口

| 项目 | 当前判定 | 关闭条件 |
| --- | --- | --- |
| B1 改名与重建 | 内部硬切换已有用户决定，缺少旧库迁移不是既定阻断 | 整理改名提交与重建步骤；验证当前日志、来源控制及 Python/Rust parity；逐文件解释 golden 和 fact_id 变化 |
| B2 规格权威 | 尚未关闭 | 统一架构规格及计划，清除状态矛盾，明确取消并归档独立 City APP 方案 |
| B3 实际接口契约 | 尚未关闭 | 为实际 MVP 请求/响应建立唯一 schema、生成类型与对应验证；旧分页 schema 归档或明确标为非当前契约 |
| B4 提交及原生验收 | 旧源码残留指控撤回；最终提交与新版 UI 验收待关闭 | 整理提交并构建 bundle；验证布局、焦点、缩放、真实数据、导航、导出及故障恢复 |
| B5 字段与政策记录 | 官方插件简化范围已确认；具体新增字段需核对 | 记录任务摘录等字段的用途、产品决定、脱敏与限制测试；出网条款准确，不扩展用户数据上传权限 |

收口不要求重新实现已存在的 provider、补完整历史迁移链或建设独立 City 安装器。最终合并结论依赖整理后的代码与验证证据；本评审修订本身不宣称这些项目已完成。

## §6 里程碑

| 里程碑 | 定义 | 当前状态与出口条件 |
| --- | --- | --- |
| M0：插件 UI 与隔离 | 宿主内插件插槽、独立 UI 产物、工具栏通信、实例恢复与故障隔离 | 已有实现及历史自动验证；最终提交、新版布局/焦点验收与适用故障回归待关闭 |
| M1：本地真实数据 MVP | Rust 提供版本化投影，City 使用真实统计并明确覆盖与不可用状态 | 数据路径已有实现；实际契约、字段审查及新版原生端到端验收待关闭 |
| M2：官方插件扩展 | 按已确定产品需求改善宿主通用插槽、功能和测试，验证第二个官方插件接入 | 后续按需求安排；第二插件 fixture 可先用于通用边界测试，City 继续运行于 Agent Vitals 内 |

独立 City APP 不在任何里程碑中。市场与独立分发另行立项，不是关闭 M0/M1 的条件。M0/M1 可并行开发；生产读取失败显示不可用，fixture 仅保留在明确的预览或测试模式。费用、模型、全量分页等缺失需记录，不自动升级为首版范围。

## §7 验证记录与最终验收

现有台账记录了 City 守卫、SDK 旧 schema 合约测试、类型检查、原生隔离探针、本地投影测试及后续浏览器回归，CI 已包含 City 守卫与合约检查。记录覆盖不同时间和构建，本次文档修订未重跑这些测试，不能表述为最新版全部通过。

`CITY_PLUGIN_FEATURE_MIGRATION.md` 记录了插件单测、本地投影与浏览器影片验证，也明确新版原生 bundle 的 UI 验收因锁屏未完成；`/Applications` 的旧安装不代表本次构建。历史原生隔离记录不能替代新增功能的端到端验收。

最终验收应包含：

- 实际 MVP 请求、共享类型和 Rust 输出通过同一版本契约验证。
- 整理后提交的构建、插件守卫、当前日志摄入及 golden/Python-Rust parity；golden 变化逐文件解释。
- 本次原生 bundle 的真实数据、布局、焦点、工具栏、会话导航与导出验证；按最终生命周期改动复验进程故障恢复。
- 浏览器与原生测试各自适用范围、数据限制及未完成项清楚记录。

桌面运行验证按仓库约定构建 Agent Vitals `.app` bundle 并通过 `open` 启动。该宿主 bundle 与被取消的独立 AgentCity.app 是不同对象。本文修订不操作数据库、安装目录或其他用户数据。

## 附 A：r2 修订记录

- 记录用户不做独立 City APP 的明确决定，移除独立应用里程碑及自动触发路线。
- 更新真实本地数据路径，撤回 fixture-only / provider 未实现的过期判断。
- 记录已授权的内部不兼容改名与数据库可重建决定，取消重复裁决同一范围的要求。
- 将原稿覆盖与可恢复说法改为待定位材料，撤回过期的旧源码残留和 tsconfig 判断。
- 澄清手写共享类型与 schema 生成物的区别，保留实际接口一致性收口任务。
- 撤回无依据的成本比例，取消生产数据失败静默回退 fixture 的要求。
- 明确源码复核、历史测试、新版原生验收与最终合并结论的证据范围。

## 附 B：证据位置

主 checkout 中，本文为 `docs/APP_LAYER_M0_REVIEW_AND_ROUTE_DECISION.md`；v0.2 独立 City APP 草稿位于 `docs/AGENT_VITALS_APP_LAYER_ARCHITECTURE_SPEC.md`，待归档。

worktree 根目录见本文开头，关键位置包括：

- `docs/AGENT_VITALS_APP_LAYER_ARCHITECTURE_SPEC.md`、`docs/APP_LAYER_IMPLEMENTATION_PLAN.md`：当前插件路线与早期/后续状态记录。
- `docs/CITY_LOCAL_DATA_PROJECTION.md`、`docs/CITY_PLUGIN_FEATURE_MIGRATION.md`：数据范围、功能与验收限制。
- `apps/desktop/plugins.json`、`apps/desktop/src-tauri/src/plugin_host.rs`、`plugin_projections.rs`：描述符、实例检查与处理器分发。
- `crates/agent-vitals-query/src/query/app_local.rs`：真实数据投影。
- `apps/agent-city/ui/src/data/provider.ts`、`packages/agent-vitals-app-sdk/src/city-ui-projection.ts`：实际 UI 接口与手写共享类型。
- `docs/schemas/city-v1-app-local-{request,response}.json`、`packages/agent-vitals-app-sdk/src/generated/contracts.ts`：旧分页接口 schema 与生成类型。
- `crates/agent-vitals-data/src/authority.rs`、`docs/HOST_HARNESS_TERMINOLOGY.md`：v31 不兼容改名与开发数据库重建约束。
