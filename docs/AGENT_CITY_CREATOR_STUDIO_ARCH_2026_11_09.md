# Oh Agent Creator Studio 软件架构

## 代码落地状态（2026-11-11）

Creator Studio 已作为官方插件 `creator-studio` 注册并有内嵌 WebView 首版：支持本地项目列表、竞速/收集模板、声明式规则 JSON 与场景对象 JSON 编辑、预览校验和 revision 提交。桌面端使用独立 SQLite Creator 项目库；插件请求路由只接受当前就绪且前台的 `creator-studio` 实例，数据库与分析 authority 分离。预览凭据绑定调用实例、项目、基线 revision 和内容，十分钟失效且最多保留 128 个活跃预览；提交采用 SQLite immediate transaction、revision CAS 和 operationId 幂等。持久操作结果使用稳定的本机 Creator principal，因而 Studio WebView 重开后仍可查询或幂等重试；短期预览仍绑定原 WebView 实例，不能被新实例接管。Rust 再校验规则字段、模型/锚点/静态盒体碰撞对象、变换数值、操作 allowlist 和预算。场景支持模型实例、锚点和显式静态盒体碰撞对象的 upsert/remove；碰撞对象目前通过 JSON 编辑，未提供独立图形碰撞编辑工具。`data-mcp` 已注册 Creator Studio 的项目读写工具，经官方插件 descriptor 的 `localCalls` 队列投递给当前前台 Studio；项目创建和 revision 提交仍要求 `--allow-local-writes`。MCP 读取按 UTF-8 字节分块，以适配本机插件调用队列的 64 KiB 单消息上限。

City 布局快照、项目挂载/皮肤事务和本地不可变发布版本已接通。布局快照包含稳定锚点及有界、按 drive/walk 能力标记的道路连通链接，不包含几何坐标；SDK、Rust 项目服务、Studio 和 City 运行时据此一致检查绑定是否从入口可达。几何解析、净空与路线质量仍由 City 可信运行时判断。Creator 可发布已保存 revision；release 固定游戏规则、挂载、布局引用、注册的 City 皮肤 ID、场景模型实例、显式静态盒体碰撞代理、资产目录和对应摘要引用；GLB 字节仍由本机项目内容寻址存储持有，因此当前 release 不是独立可分发包。City 插件只能读取匹配当前布局版本的发布内容，并在小地图“小游戏”图层显示驾驶区域小游戏入口。运行时会重新校验游戏摘要、布局、锚点能力和事件类型，然后复用 City 驾驶租约与固定步规则运行器；小游戏开始时临时应用 release 皮肤，退出时恢复此前的 City 外观，不改用户皮肤偏好和地图版本。Creator release 的静态盒体碰撞代理有独立数量和尺寸限制，并与 City 世界 revision 合并进该次驾驶的冻结碰撞索引；视觉模型不会自动推断碰撞。Studio 发起的可视试玩会以同一份编译几何显示碰撞线框，并在试玩退出、失败或 City 场景失效时清理；碰撞代理仍通过 JSON 编辑，尚无独立图形编辑器，桌面视觉验收尚未完成。发布场景中的受限静态 GLB 通过宿主注册的 `ohcityasset://` 协议按 release 与内容摘要加载；协议只向当前活动的官方 City WebView 开放，读取时重新验证资产引用与字节摘要。动画、蒙皮、glTF 扩展、动态/网格碰撞和模型交互仍未支持。MCP 仍通过当前前台 Studio 操作项目；发布必须显式触发，草稿不会进入 City 运行面。

按用户/项目隔离的授权 grants 与撤销、跨日授权恢复、Creator 视觉场景对象的真实渲染、步行位移运行时、无头断言/输入事件级试玩证据、Shop 安装/权益流程仍未实现。可视驾驶小游戏现会将有界终态摘要写入本机 SQLite，并通过 `creator_playtest_history` MCP 工具读取；该摘要由 City 客户端报告，不是防作弊或排行榜凭据。Studio“预览”仍是结构校验和差异摘要，不等于可视试玩；跨插件试玩往返只恢复 projectId/revision，桌面端 smoke test 尚未完成。当前代码切片尚不能称为完整 Creator Studio。

状态：P0 架构规格，首个本地发布/City 运行切片已落地；授权 grants、跨插件可视交接与 Shop 尚未验收。适用于随 Oh Agent 发布的官方 City 和 Creator Studio 插件。产品假设、竞品研究和商店路线见[产品方案](AGENT_CITY_CREATOR_STORE_PRODUCT_2026_11_09.md)。

先升级现有 City 的皮肤、场地与小游戏组合架构，再接官方 Shop。用两种皮肤、两个固定合成布局和两种玩法验证。玩家和 Agent 可以编辑同一份草稿，启动独立于草稿的试玩，退出后继续修改。正式可视试玩使用 City 的生产输入、相机和 HUD 路径。City 是用户入口，Studio 从 City 的挑战入口打开。

## 1. 组件和信任边界

```text
Agent ── stdio ── Creator MCP ── 本机 IPC ─┐
Studio 官方 WebView ── 创作请求 ───────────┼── Rust 宿主 ── 项目、授权、试玩交接
City 官方 WebView ──── 运行请求 ───────────┘
Studio 预览 / City 试玩 ── 共用场地绑定和规则运行器
```

| 组件 | 建议归属 | 职责 |
|---|---|---|
| Studio 插件 | `apps/agent-creator-studio/ui` | 编辑、三维预览、差异、连接状态、版本历史、试玩结果 |
| Creator MCP | 随桌面发行的现有 CLI 可执行文件新增 `creator-mcp serve` | Agent 启动的独立进程。处理 stdio、工具输入与结构化错误，经本机 IPC 转发；无作品库访问 |
| Creator 服务 | 桌面 Rust 进程内的领域模块与存储适配 | 项目授权、有限的作品 schema、校验、预览、提交、撤销、快照、结果与本地 SQLite |
| 试玩协调器 | 桌面 Rust 宿主，使用现有工作台插件生命周期 | 保存返回上下文、串行切换插件、绑定活动实例、结算、超时与恢复 |
| 玩法适配库 | Studio 与 City 均可引用的受信任 TypeScript 模块 | 合成场地加载、声明式规则、无头验证及可视运行。City 适配正常的玩家输入、渲染与 HUD |

Studio 在 `apps/desktop/plugins.json` 注册为 `creator-studio`，随 Oh Agent 分发并使用独立 WebView。Studio 首版的 `dataProjections` 为空。Creator 方法由宿主根据已注册插件 ID、活动实例 ID、方法和项目范围校验。草稿、运行和证据使用独立的本地作品库。项目和试玩的读取接口均使用显式字段，运行所需资产来自固定清单。没有分析库投影、任意 SQL、路径、脚本或网络权限。运行结果由获授权的第一方实例提供，宿主检查其结构和归属。签名、社区内容执行和线上授权在后续阶段单独设计。

现有宿主替换插件会关闭旧 WebView，挂起只隐藏当前实例。交接复用单实例的打开与关闭路径，由工作台执行宿主导航。现有官方插件注册和 Building MCP 的本地通知是参考，Creator 的本机请求通道与跨插件交接需要新增。参见[插件接入指南](OFFICIAL_PLUGIN_INTEGRATION_GUIDE.md)、[插件宿主](../apps/desktop/src-tauri/src/plugin_host.rs)和[Building MCP](CITY_BUILDING_MCP.md)。

## 2. 布局、皮肤、小游戏与挂载契约

| 模型 | 关键字段和责任 |
|---|---|
| `CityLayoutV1` | cityId、version、场景摘要、可用能力、挂点 ID 与类型。City 生成器或固定场景负责提供空间事实，例如道路连通性、可步行区域。 |
| `CitySkinPackV1` | skinId、version、资源摘要、兼容的渲染契约，声明材质、色板、灯光和不改变碰撞的外观覆盖。 |
| `MiniGamePackV1` | gameId、version、规则契约版本、槽位类型与数量、能力要求、默认参数、规则图与资产引用。游戏使用槽位名引用场地。 |
| `CityGameMountV1` | mountId、城市与游戏的精确版本及摘要、槽位到挂点的绑定、参数覆盖、入口 ID。可复制为不同挂载。成绩和运行状态按挂载隔离。 |

皮肤应用记录与小游戏挂载分别存储。运行时先加载布局及空间事实，再应用视觉覆盖。皮肤缺失、损坏或不兼容时回退到默认皮肤。会改变空间事实的内容归布局版本。

Studio 向宿主查询可用挂点、规则原语和兼容性，再提交带 revision 的草稿操作。宿主校验挂点类型、数量、布局边界、场地能力、依赖摘要与授权。匹配建议只是预览，提交与启动均重新校验。场景升级后若挂点缺失或几何条件变化，挂载显示待重新绑定，并保留原记录供修复。小游戏持有活动租约，临时对象和游戏状态随运行释放。城市布局只通过项目编辑操作改变。

P0 使用有界的事件、条件、动作与状态转换。事件包括区域进入、拾取和计时结束；条件包括计数、次序与当前状态；动作包括更新计数、显示目标和结算胜负。固定事件顺序，限制图大小、每步事件数、状态容量和运行时长。官方玩法样例、无头检查与 City 可视试玩使用同一规则解释器。无头检查覆盖规则与事件结果，城市可达性与实际控制另测。Agent 可以添加和改写规则节点，规则配置只引用已登记动作、资源和场地槽位。

试玩快照固定项目 revision、布局与游戏版本、挂载、规则版本与种子。视觉复现另固定皮肤版本。只读场地快照和结果沿用 Creator 服务与宿主交接。P0 的两个固定城市可由测试项目引用，完整的多城市存档管理留待后续。

先用随应用提供的官方皮肤和小游戏包验证本地安装、换肤、挂载与恢复。Shop 后续使用相同的安装和应用入口。联网目录和下载须遵循仓库政策。Agent Vitals 的分析数据保留在原有投影边界内。

## 3. MCP 连接与权限

适配器由 Agent 启动，在每个桌面用户的运行目录内通过受 OS 用户权限保护的 IPC 连接同一 Oh Agent 实例。macOS/Linux 使用私有目录中的 Unix socket，Windows 使用带当前用户 ACL 的命名管道。宿主校验连接方的 OS 用户身份，配置和启动参数只包含端点定位信息。宿主未运行或无法确认身份时，返回 `host_unavailable` 或 `permission_denied`。

1. 新连接向宿主登记待配对请求。Studio 显示连接和项目，由玩家批准读、编辑、发起试玩等具体能力。Agent 自报名称只用于展示。
2. 宿主把授权保存在内存，并绑定 IPC 连接、Studio 实例、项目、能力和期限。各请求重新检查授权。连接关闭、到期、宿主重启或用户撤销即失效。授权不进入草稿、日志、命令行或作品包。
3. 可视试玩接管前，宿主废止 Studio 的编辑绑定，并单独将该连接绑定到本次运行。切到 City 后，MCP 只能查看该运行的授权状态和结果。可视试玩由玩家结束。返回 Studio 后，对新的 Studio 实例重新授权编辑。若玩家切去其他页面或关闭 Studio，编辑入口立即失效。
4. 一个连接只可操作一个已授权项目。新建项目使用一次性的新建授权，创建成功后宿主可将连接绑定到该项目。断线重连、切项目和重新启动都走显式绑定。Studio 仍可在没有 Agent 连接的情况下手动编辑与试玩。

MCP 和 Studio UI 各有身份适配层，最终调用同一项目服务。适配器只拥有创作工具，项目数据在宿主不可用时也无法通过适配器修改。Agent 只接收作品所需的摘要、对象和诊断，不接收原始客户端日志。工具返回明确的 `studio_inactive`、`grant_expired`、`revision_conflict` 等错误，Agent 可以据此停止或请求重新绑定。

## 4. 项目事务与数据契约

- `CreatorProjectV1` 包含 projectId、revision、场地 ID／版本／摘要、模型实例、锚点、规则图和挂载。P0 支持在固定布局的草稿中修改模型实例、出生点和有界触发区域，以及编辑规则节点、场地绑定、挂载入口和参数覆盖。对象使用稳定 ID。官方场地清单给出坐标系、可建边界、对象上限和资源摘要。Rust 验证结构、引用、数值、体积和场地边界。可信运行时检查地表、障碍和路线，玩家验证实际控制体验。接口见 [SDK API](AGENT_CITY_SDK_API_2026_11_10.md)。
- `edit_preview(projectId, baseRevision, ops)` 返回差异、诊断和限时 `previewId`。凭据绑定项目、基线、请求者和规范化操作摘要。预览不写草稿。UI 可自行做即时反馈，权威结果以宿主为准。
- `edit_commit(previewId, expectedRevision, operationId)` 在宿主中检查编辑授权和当前 revision，以同一 SQLite 事务写草稿、变更历史和幂等结果。检查授权和前台实例的一次判定与提交在同一串行边界内完成。先于交接提交的操作进入新版本，后续提交因权限失效或 revision 冲突被拒绝。对同一已授权请求者，项目和操作 ID 相同且载荷一致的重试返回已记结果，载荷不符时返回冲突。断线后重新授权，再通过项目历史确认提交结果。
- 撤销使用当前 revision 作前置条件，首版只撤销当前头部变更，生成新的 revision。后续有人提交时返回冲突，避免覆盖其他编辑。项目变更事件只作为刷新提示，客户端可以根据 revision 主动拉取。
- `PlaytestSnapshotV1` 绑定 projectId、revision、规范化快照摘要、模板与资源摘要、规则／运行时版本、seed。快照来自已保存版本，运行中的计时、成绩、对象状态和输入不反写草稿。项目版本、试玩快照、内容发行版本各有独立标识。

建议本地表按 `projects`、`project_changes`、`operation_results`、`playtest_runs` 分开。活跃快照由本次运行持有，结束后保留有界证据。草稿、历史和结果持久化，短期授权和领取引用留在内存。重启时将未完成的运行标为中断，Studio 可从已保存的草稿打开。

## 5. Studio 与 City 交接契约

### P0 当前实现状态（2026-11-11）

P0 已实现最小的跨 WebView 试玩往返：Studio 对已发布 release 调用 `creator.project.playtest.start`，Rust 将 `runId`、release、项目与 revision 写入本地 SQLite；宿主发出固定的 City 导航事件。活动的官方 City 实例通过 `city.creator.playtest.claim` 领取固定 release，运行小游戏；游戏完成、失败或玩家退出时，City 以单一终态调用 `city.creator.playtest.finish`，并附带有界的运行摘要。运行启动或内容预检失败时，City 可附带受限字符集的稳定 `failureCode`，让 Studio 与本地历史呈现可诊断的失败原因，而不把它伪装成运行证据。Rust 绑定并验证 release snapshot digest、项目 revision、world revision 与 game 引用后本地持久化。宿主随后发出固定的 Studio 返回事件，新的 Studio 实例调用 `creator.project.playtest.return_context`，读取一次性返回信息和摘要并重开原项目；Agent 可通过 MCP `creator_playtest_history` 按项目读取有界历史。

当前返回信息只恢复 `projectId` 与已试玩的 `revision`，另附终态摘要；不会保留选中对象、面板、视口或原 WebView 实例。它是“关闭后重建 Studio 并恢复项目”的交接，不是多 WebView 并行、挂起/恢复或完整 `ReturnContextV1`。运行引用绑定 City 实例；未完成的 pending run 在 30 分钟后过期。自动导航、项目重开与后端状态机已有契约检查、定向 Rust 测试及前端构建验证；生产桌面端真实交互仍需人工 smoke test。

### 后续目标契约

```text
Studio → Host: requestPlaytest(projectId, revision, mode, returnContext)
Host: 检查授权，固定快照，登记 runId 和返回上下文
Host → Workbench: 关闭 Studio 实例，启动 City 实例
City → Host: ready，然后 claim(runId)
Host → City: 固定快照，由玩家操作
City → Host: report(runId, terminalResult)
Host → Workbench: 结算结果，释放运行，重新打开 Studio
Studio → Host: 领取返回上下文，按 runId 查询结果
```

- `ReturnContextV1` 只含 projectId、选中对象 ID、面板和有界视口姿态。UI 请求直接提供；玩家在 Studio 发起可视试玩。MCP 启动无头检查，不发起可视切换或注入输入。准备阶段内出现未提交的表单修改时，Studio 先提示保存或取消。上下文确认前保留原实例。
- 每次运行使用唯一 `runId` 和相应的宿主导航代次。状态为 `preparing → launching → running → terminal → returning`。终态分别记录 `completed`、`cancelled`、`timeout`、`failed` 和 `interrupted`。P0 同时只允许一次可视试玩。无头运行在活跃 Studio 内执行，绑定快照和本次实例，切走时中止。
- `claim` 只能由本次启动并通过就绪检查的 City 实例调用，运行引用有期限并绑定该实例。只允许首次有效领取，重复或过期调用返回明确状态。City 用合成场地启动独立玩法会话。
- 试玩在 City 退出按钮、工作台取消、启动失败、运行超时或宿主发现实例失效时结算。宿主只接受一次终态，迟到结果不覆盖。正常退出由 City 释放输入、相机、音频、HUD 和帧回调。清理超时由宿主关闭运行实例并结束租约。启动失败也回到 Studio。若用户已主动导航到其他页面，宿主保留可恢复的项目入口，避免抢回页面。
- 返回时打开新的 Studio 实例，宿主在其就绪后交付返回上下文。对象已删除则恢复项目并清除选择。Studio 启动失败时，工作台提供打开已保存项目的入口。重复返回请求、旧实例消息和用户导航都按导航代次裁决。

P0 先做一条最小交接切片，验证关闭、就绪、领取、终态和恢复。若生产宿主上暂时无法稳定完成交接，可用 Studio 内运行同一玩法适配器验证编辑与规则；验收应标明该路径仅覆盖 Studio 内试玩，City 的正式输入和生命周期仍待验证。

## 6. Shop 与宿主职责

Shop 是随 Oh Agent 分发的独立官方 WebView。Rust 宿主持有目录、安装状态和可验证的使用权，提供按商品版本的验证、安装与兼容性查询。商品条目引用皮肤或小游戏包，购买记录和本地安装记录分别保存。购买、安装、应用皮肤和挂载游戏各有独立状态。官方 Shop 发布前确定支付来源、确认流程、失败重试、退款、恢复购买和离线行为。目录与安装逻辑先用本地官方包验收。

皮肤的「应用到 City」交给宿主校验权益和渲染兼容性，再更新当前 City 的皮肤配置。小游戏的「添加到 City」交给 City 或 Studio 选择场地并预览绑定，确认后保存挂载记录。Shop 通过宿主传递已验证内容引用，City 通过现有运行器启动。包以声明式数据加载，购买与分析数据授权各有独立边界。

## 7. 试玩证据和验收

无头 `PlaytestEvidenceV1` 由 City SDK 本地 `runHeadless` 生成。可视 `VisualPlaytestEvidenceV1` 当前持久化运行 ID（由表行关联）、release/project revision、release snapshot digest、world revision、game 引用、seed、tick、计数器、终态和可选稳定错误码。Rust 对字段 allowlist 与预算严格校验，结果标记为 `city-client-reported`；它可帮助 Agent 继续调试，不是服务器权威模拟、反作弊或排行榜证明。输入轨迹、原始日志、截图、提示文本和 Agent 分析数据均不保存。完整运行事件/断言证据仍待实现；运行结果不写回输入快照。

| 验收层 | 通过条件 |
|---|---|
| 编辑与权限 | 使用真实 Agent stdio 连接完成读、预览、提交和撤销。双客户端冲突、重复提交、授权撤销、切换期间写入及重开草稿均有明确结果。 |
| 跨插件交接 | 在 Oh Agent 桌面应用中由 Studio 切到 City，检查旧实例关闭、指定快照领取、结果结算、恢复原项目。覆盖退出、取消、City 启动失败、过期引用和用户主动导航。 |
| 无头规则 | 同一快照、规则版本、seed 和规则输入产生一致的计时、计数、事件和胜负事实。无头结果不替代可视验收。 |
| 可视输入 | 由玩家通过生产控制链操作，检查移动、到点提示、HUD、终局、退出和资源释放。按平台独立确认结果，图像和物理表现允许预先定义的容差。 |
| 内容搭配 | 两种皮肤分别与竞速、寻宝组合。换肤保留路线、碰撞、入口及成绩。同一游戏绑定两个兼容布局，同城可同时挂两种小游戏。不兼容时提示缺失的能力。重启后恢复皮肤与挂载。 |
| 产品试点 | 真人让 Agent 创建或改写一条规则，完成场地搭配并试玩，重开项目后能继续修改。 |

建议先用现有 City 验证场地契约和两种玩法的规则表达，同时验证宿主交接切片。随后接入 Rust 项目事务、MCP、Studio 编辑和 City 正式可视试玩。需要在编码前确认 P0 场地清单、平台 IPC 支持矩阵、预览和运行超时，以及结果保留上限。
