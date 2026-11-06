# Workbench × 新 Runtime 接入与旧交互收敛 SPEC

**状态：** Draft v1（2026-09-23，待实现与验收）
**范围：** macOS 桌面菜单、Tauri 本地 IPC、React Workbench；Windows 复用契约，平台传感能力另行验收。
**关联：** [React 迁移规格](WORKBENCH_REACT_MIGRATION_SPEC.md)、[迁移盘点](WORKBENCH_REACT_MIGRATION_INVENTORY.md)、[Runtime 失效信号规格](../RUNTIME_INVALIDATION_AND_READ_BACKPRESSURE_SPEC.md)、[Watcher 热插拔规格](../RUNTIME_REFACTOR_WATCHER_HOTPLUG_HARDENING_SPEC.md)。

## 0. 结论与实施边界

新 runtime 的数据链已经是：执行环境/插件来源 → SourceGraph 增量摄入 → SQLite authority → 事务事件与合并失效信号 → 本地只读投影。文件 watcher 只加快发现，不取代周期对账；Trust 传感只给有覆盖边界的行为线索，不代替网络内容取证。React 不应继续把一次完整同步、固定三个执行环境、某条规则 ID 或菜单快照当作全局真相。

本规格修复 **发布前契约断点**，并收敛旧工作台交互。默认 `tauri.conf.json` 目前仍打包 `ui/workbench.html`；`tauri.react.conf.json` 是候选构建。完成本规格不自动授权切换生产入口，必须经过 §10 门禁。

**不做：** 新增远端服务/遥测；改变计费归因和 Trust 风险算法；把原始日志、Trust/会话证据的原始路径、manifest 原文、命令参数或凭据交给 React/MCP；为动态插件假造它不具备的会话或进程监测能力。设置页用户显式展开的本机读取位置仍走现有 local-presentation-only 合同，不得进入 MCP、普通导出或诊断包。第一阶段原则上不改 authority schema；若实施中确需 schema 变更，单独评审迁移、golden 与 Python/Rust 对拍。

## 1. 已存在的能力与接线现状

| Runtime/桌面能力 | 当前接线 | 前端仍沿用的旧假设 |
|---|---|---|
| authority revision、合并 `Invalidated`、只读 memo/ReadGate | `lib.rs` 的事件发布和重读闸门已接；React 各页可订阅 `app-event` | `read_overview` 仅以 revision 缓存含同步状态/执行环境快照/日期的复合 DTO；设置页一次失效并发重拉多个分区 |
| watcher + 轻/重 tick | 轻 tick 定向摄入，重 tick 负责全量对账、navigation 与托盘 | React 不识别成功的 `light` stage；菜单可比页面晚约 5 分钟；“实时”文案容易暗示完整实时覆盖 |
| 校验后的热插拔执行环境、MCP Profile 提案 | `source_harness_controls` 已含插件；MCP 只能 stage，`trust_profile_approve/reject/revoke` 是 UI-only | 旧工作台有审批入口，React 没有；菜单 navigation 固定三执行环境，前端 invalidation harness 词表丢弃 `plugin:*` |
| session safe query | CLI navigation recent 已给 `session_ref`；React 会话详情使用 `session_ref` | 菜单仍按四字段 `session_key` 解码，最近会话项可见却不能跳转 |
| 通用 Finding 与分级 Trust 证据 | 安全 DTO 已有 evidence level、stage、origin、confidence、`read_only`、`manual_follow_up` | Findings 行动区仍按少数 rule ID/前缀硬编码；Trust 审批/抑制操作仍留在旧页 |
| 被动路线质量与主动 probe | 被动报告可安全读取；旧页另有主动 probe | React 页标题仍叫“测试”，同时指向旧页高级区；切换后入口语义失效 |

以上是 **2026-09-23 源码基线**，不是已通过发布验收的断言。实现 PR 必须重新对照当前代码、记录命令输出与真机截图。

## 2. 产品信息架构：按用户任务而非旧 tab 切分

React 顶层保持“总览、用量、会话、发现、路线质量、Trust、Skill、设置”，但各页含义调整：

1. **总览**只显示跨域摘要与下一步。数据状态拆为“最近观测”“最近成功对账”“读取/监测能力”；不再用一个 `sync.ok` 概括三者。不重复铺两份执行环境列表。
2. **发现**是结论与行动：可行动规则由后端的行动元数据决定；只读行为证据不因严重级别高就伪装为可自动修复的任务。无 Finding ≠ 安全。
3. **Trust**是覆盖、分级证据和用户授权中心。页面名称/文案用“本机出境风险线索”，保留证据等级 E0–E5、观测阶段和平台覆盖边界；不把 lsof 连接元数据写成内容传输或云端接收证明。
4. **路线质量**专指被动观测。主动 probe 若迁移，必须作为显式高成本子流程，单独展示凭据授权、请求预算和回执；否则在生产 React 中不提供入口，不再称“仍在旧工作台”。
5. **设置**负责来源、预算、计费、数据保留及诊断控制。执行环境自定义根目录仅列后端声明支持该能力的 adapter；插件加入来源控制注册表，不意味着它可任意选择新根或读取会话。

每个可见执行环境按能力显示标签：`已发现`、`事实摄入`、`会话可查`、`本地审计`、`运行时传感`、`可停止读取`，每项值为 `available | partial | unavailable | not_applicable`。不得用菜单的三条 session row 推断“本机已发现 Agent 数”。能力只能由 Rust/runtime 返回，React 不按 harness 名推断。

## 3. P0：菜单与 React 统一导航契约

### 3.1 单一目标

新增或演进本地导航 DTO（示意；实际字段名在实现 PR 固定并加 schema 测试）：

```json
{"schema_version":2,"generation":17,"kind":"page","page":"usage"}
{"schema_version":2,"generation":18,"kind":"session","page":"sessions","session_ref":"sr_...","harness_kind":"codex"}
```

- 页面词表使用 React 的 canonical id：`overview | usage | sessions | findings | test | trust | skills | settings`。旧 `calendar/sources/budget` 只在兼容入口转换，不继续写入新目标。
- 会话目标仅用本地安全 `session_ref`，绝不把 native session id、原始路径或四字段 `session_key` 交给 React。
- 后端 **先写待消费目标，再 show，再 emit**；前端在初次挂载、窗口恢复可见、`focus-target` 事件到达时 pull。应用成功后以 `generation` ack；旧事件或慢异步响应不能清除更新的点击。
- `page` 目标可直接路由；`session` 目标先进入会话页，再按 `session_ref` 读安全详情。详情已过期/不可解析时保留执行环境筛选并显示“会话已不可用”，不能静默无反应。
- 菜单 L2 最近会话只在目标可解析时 enabled。CLI navigation 失败与真零分开：错误显示“会话数据暂不可用”，不能显示“尚无会话”。
- 切换 React 前修好当前旧页的可点无效问题：旧页能消费新目标，或将 L2 降级为明确可用的执行环境列表入口；不允许用默认生产包保留无反馈菜单项。

### 3.2 能力驱动菜单

会话菜单只列 `sessions=available|partial` 的执行环境；仅有用量/Trust 能力的插件可列独立摘要或从工作台覆盖入口进入，不给空的“最近会话”。执行环境名取 runtime 校验后的 registry/display，失效事件中保留校验通过的 `plugin:<slug>`。托盘可维持 5 分钟节流，但必须标注快照生成时间；页面的秒级更新不能被托盘快照冒充为同步已停。

## 4. P0：Profile 授权闭环不能随 React 切换消失

React Trust 页加入“待批准 Profile / 已启用 Profile / 无效提案”区，通过 `lib/tauri.ts` 调用现有 `trust_profile_proposal_status`、`trust_profile_approve`、`trust_profile_reject`、`trust_profile_revoke`。MCP 仍只能 validate/stage，**不得暴露 approve/revoke 工具**。

现有 safe summary 只含 slug、manifest hash 和根/匹配规则数量，尚不足以让用户判断授权范围。批准前新增 **UI-only 安全预览**：显示读取范围类别、匹配类型、Trust adapter、watch 优先级及能力边界；路径只显示经过审查的类别/占位符和是否涵盖工作区/.git，不返回绝对路径或 manifest 原文。若后端无法生成有意义的预览，批准按钮禁用并说明原因，不以“仅有 N 个根目录”代替知情同意。确认框绑定 `slug + manifest_hash`，提交时重新校验待批版本；提案改变须重新确认。拒绝/撤销提供明确回执和可恢复边界，撤销不暗示既有证据已删除。

旧页的 Trust suppression 列表、创建和撤销须单独验收并迁入 React，或者在切换前明确决定暂不提供该能力并解释已有 suppression 仍生效。不能让用户无法查看或撤回过去的抑制。审批与 suppression 均是用户交互，不能用 Agent/MCP 代办。

## 5. P1：状态、缓存与刷新契约

### 5.1 分离三种状态

| 状态 | 来源 | UI 语义 |
|---|---|---|
| `authority_revision` + 数据窗口/时区 | SQLite authority | 数字属于哪一批提交、哪个统计窗口 |
| `sync_run`：`mode=light|heavy|manual|paused`、`ok`、`stage`、`finished_at` | `last-sync`/同步控制 | 最近一轮处理是否成功；`light` 成功是成功，不是未知 |
| `watcher_health`/Trust capability | watcher/传感器 | 能否加速发现/观察某类行为；不可用不等于安全 |

`SyncStatusChanged` 必须使同步状态可重读，即使 authority revision 未变。不要继续让复合 `read_overview` 只以 revision 为缓存键：首选把轻量 `read_sync_status_safe`、`read_harness_coverage_safe` 与重聚合 summary 分开；若暂保留复合 DTO，缓存键必须至少包含 authority revision、统计日期/时区、相关配置版本、`last-sync` 版本和 `harnesses` 快照版本。跨日无新事实也要换日。删除来源、暂停/恢复、Profile 批准/撤销、统计时区变更必须各自触发相关投影失效。

React bridge 将状态枚举做成有界显式映射，加入 `light` 与未来未知值的诚实降级；前端不得把 `unknown` 自动翻译成失败。`WatcherHealthChanged` 若事件负载仅作为提醒，则重新读取的命令必须返回与事件等价的 `throttled` 等状态；否则 UI 无法展示真实节流。`findings_freshness.syncing` 不得长期硬编码 `false`；若无可靠运行中证据，应删此字段及“同步中”文案。

### 5.2 读取背压与页面订阅

各页只订阅所需投影。设置页当前一次 `Invalidated` 可触发来源、预算、计费、统计、关于、通知等多路并发读取；调整为按可见分区和依赖键失效，后台非当前分区懒读。请求采用 latest-wins generation；失败保留旧数据并标明旧版本/窗口。ReadGate 是最后防线，不是前端无限发起重读的理由。外部 CLI/MCP 写入仍需低频 revision 检查兜底，但不能变成每页重复轮询。

## 6. P1：通用 Finding、Trust 和覆盖面

- 行动区使用 `manual_follow_up`、`read_only`、`action_kind` 等后端契约，不再根据 `PRICE_COVERAGE`、`ROUTE_UNCONFIRMED` 或 `SV6/SV7` 前缀决定是否为待办。未知 action 显示只读或“需人工判断”，不能自动生成修复按钮。
- 证据行继续显示观测时间、证据来源、阶段、等级、置信度、安全引用与范围；明确“打包/尝试/客户端声称接受/已验证远端接收”的差别。证据不足时显示已观察到什么、缺少哪一段链路，而不是一行“未生成 Finding”。
- `TrustMonitorInvalidated` 刷新监测配置与能力；authority `Invalidated` 刷新 Findings/证据投影。两种事件不合并成“发现了风险”。
- 动态插件的状态按能力展示。已安装且配置有效、仅暂存待批、配置无效、已撤销但有历史投影、当前未检测到数据应为不同状态。来源停止读取和删除投影是两个动作，删除不触及执行环境原始日志。

## 7. P2：旧交互退役清单

| 旧交互/文案 | 决策 |
|---|---|
| `calendar`、`sources`、`budget` 旧 tab id | 仅保留过渡解析；菜单/通知发 canonical 导航目标后退役 |
| “已覆盖执行环境 = 固定菜单行数” | 删除；改用能力投影分项计数 |
| “同步成功 = 数据实时完整” | 删除；拆成观测、对账、watcher/Trust 覆盖 |
| “测试”页只提供被动报告、却指向旧页 probe | 改名“路线质量”；主动 probe 独立评审，不在切换后显示死入口 |
| “计费归因／导入删除仍在旧工作台” | 按实际 React 功能逐项删改；剩余高风险操作列出具体名称与可用入口 |
| 自定义读取位置下拉仅三执行环境 | **暂保留**，因为 runtime `custom_sources` 只支持这三个 adapter；不要与动态插件注册表混为一谈 |
| 双份执行环境列表、无作用的刷新按钮 | 合并摘要；页面刷新只重读本页投影，明确其不等于执行重同步 |

## 8. 实施顺序与变更归属

1. **契约修复（发布阻断）：** CLI navigation/菜单 session_ref、失败语义、canonical 导航目标与 ack；旧页过渡行为测试。
2. **安全闭环（发布阻断）：** Profile 安全预览、React 审批/拒绝/撤销和 suppression 生命周期。审批仍只在本机 UI。
3. **读模型：** 拆分同步状态/执行环境能力与重聚合 overview，修正缓存键、`light`、watcher 节流及跨日行为。
4. **页面收敛：** Findings 行动元数据、动态执行环境覆盖、Trust 证据与能力边界、路线质量命名、设置页懒读及过时文案。
5. **生产切换：** 完成下述验证后才将默认 Tauri bundle 指向 React；旧 `ui/` 作为短期可回退资产，回退窗口和删除条件另记发布清单。

业务规则只放 runtime/data；Tauri 负责本机权限、命令编排和安全 DTO；`ui-dev/react/src/lib/tauri.ts` 是唯一 IPC/event 入口；组件只负责呈现与局部交互。菜单与 React 不各自实现执行环境识别、风险评分或金额计算。

## 9. 验收测试

| 层 | 必测场景 |
|---|---|
| Rust/CLI 契约 | 真实 `sessions navigation --json` 的 `session_ref` 可被菜单点击目标消费；单执行环境查询失败 ≠ 真零；插件只在具备对应能力时出现在菜单；旧/新二进制形状不兼容时明确降级 |
| Tauri 单测 | menu→target→show→ack generation；连续点击/冷启动/窗口隐藏/慢响应不丢最后目标；预算通知映射到有效 React 页面；轻 tick/暂停/跨日/无新 revision 的状态不会命中陈旧 overview |
| React bridge/组件 | `light`、未知 stage、`plugin:<slug>`、malformed/过量 DTO；审批 hash 变更拒绝旧确认；Findings 新 rule ID 仅凭行动元数据归类；无证据、传感不可用、旧数据不显示为安全或实时完整 |
| 安全 | MCP 无 approve/revoke；Trust/Findings/审批 DTO、日志、mock、普通导出不含证据绝对路径/manifest 原文/native id/JWT；设置页明确展开的本机读取位置仅在本机展示；审批预览足以描述范围但不泄露敏感路径 |
| 数据契约 | 若改 Rust/Python 公共输出，运行 Python suite、`golden_runner.py --diff`、Rust/Python 对拍；不得为消除失败直接 `--update` |
| 真机视觉/流程 | macOS `.app` 从菜单逐项打开 React；MCP 暂存→用户审批→执行环境热插拔→同步→发现/Trust→撤销；窗口隐藏/再开、窄窗口、键盘操作、无网络、权限失败、数据库不可读；与旧页逐项对照数字和错误态 |

对于本 SPEC 的纯前端/桌面合同修改，至少运行 React 构建与契约测试、受影响 Rust 测试、桌面打包检查。全量 release gate 依仓库 `AGENTS.md`；测试报告记录命令、结果、跳过项和机器环境，不能将“编译通过”称为视觉或真机验收。

## 10. React 生产切换门槛

以下全部满足方可修改默认 `frontendDist`：

- §3 导航和最近会话真实菜单点击无 silent no-op；所有菜单/通知目标均可达。
- §4 的 UI-only Profile 授权闭环存在，用户可查看范围、批准/拒绝/撤销并看到回执；已有 suppression 可查看并处理。
- §5 的 `light`、无 revision 状态变化、跨日、插件失效与 watcher 降级显示正确。
- §6 的行动区不依赖固定规则 ID；动态执行环境能力和“没有 Finding”均诚实呈现。
- 被动/主动测试边界和设置页遗留能力已逐项决定，不存在“到旧工作台操作”的死入口。
- 默认发布命令产出的 `.app` 已在真机启动；验证内置 CLI/schema 匹配，macOS 托盘必须由 `open .app` 启动，不能运行 bare binary；提供菜单、总览、来源、Findings、Trust、审批流程截图及失败态记录。
- 发布包离线运行，不新增用户数据出网；回退到旧 UI 的条件和期限明确。

## 11. 开放决策（实现前收口）

1. Profile 预览中的“读取范围类别”如何从 manifest 安全归一化：必须让用户理解是否涉及工作区、Git 历史和全盘宽范围，同时不把绝对路径放进 renderer。此合同需安全评审后固定。
2. Trust suppression 是否与审批同批迁移；若否，React 生产切换必须延期或明确提供仍可到达的本机用户控制面，不能交给 MCP。
3. 主动 probe、手工价卡编辑、authority 恢复属于高风险写操作：逐项保留、迁移或退役，不因 React 静态页已能读取结果就认为功能已覆盖。
