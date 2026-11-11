# Oh Agent City 0→1 产品方案

状态：产品与架构建议，待评审。研究基准日：2026-11-09。本文区分已观察到的竞品能力、仓库现状、拟议契约和待验证的市场假设。

**City 已经能玩。先升级 City 的内容架构，验证同一座城可以换肤、同一个小游戏可以挂到不同场地，再推出可购买这两类商品的官方 Shop。** 玩家可以给现有城市换成海滨或霓虹风格，再把竞速或寻宝加进自己的城。Creator Studio 和 Agent 用同一套规则与挂载契约创建、修改和试玩。

换肤改变城市的视觉风格。道路、碰撞、挂点和小游戏成绩仍属于原布局及挂载。小游戏包定义玩法和场地要求，玩家选择添加到哪个入口。首发 Shop 商品聚焦皮肤与内嵌小游戏。

关联：[Creator Studio 软件架构](AGENT_CITY_CREATOR_STUDIO_ARCH_2026_11_09.md)、[City 活动平台架构](CITY_ACTIVITY_PLATFORM_ARCH_2026_11_07.md)、[Sessions Building MCP](CITY_BUILDING_MCP.md)、[Mecha MCP](MECHA_MCP.md)、[梦境城市](AGENT_CITY_DREAM_CITY_DESIGN_2026_11_08.md)、[远程 City 提案](AGENT_CITY_REMOTE_3D_PROPOSAL_2026_11_08.md)、[仓库数据政策](../AGENTS.md)。

| 术语 | 本文含义 |
|---|---|
| Host / App Plugin | Oh Agent 桌面宿主 / 它加载的官方应用。首版包括 City 和 Creator Studio，各有插件身份和 WebView 实例。 |
| Project | 有 revision 和变更历史的作品草稿。 |
| Activity | 可启动的小游戏。规则包定义玩法，挂载记录把它与指定城市的场地绑定。 |
| Experience / Package / Listing | 可进入的发行作品 / 有版本的内容包 / 目录中的商品条目。 |

## 1. 市场稀缺性在可控的持续创作

首批创作者假设是**已经使用编程 Agent、愿意做小型游戏或关卡的 City 用户**。他们的任务可以具体到“让我的 Agent 把海滨广场做成一个计时检查点挑战，试玩后再改一次，并交给朋友复现”。第一次生成的速度只是其中一项成本。更长的路径包括发现素材、理解规则、修复软锁、解释修改、继续编辑，以及交付同一版本。以下调研以公开产品文档和官方发布为依据，未做竞品实操或代表性市场测量。

| 产品 | 官方可查能力 | 可借鉴的机制 |
|---|---|---|
| Roblox Studio / Build | Studio MCP 支持连接 Codex、选择 Studio 会话、查询实例和脚本、编辑并启停试玩。Build 另提供从自然语言生成、迭代和分享的低门槛入口，并可衔接 Studio。 | Agent 在真实编辑器里工作。简易入口和专业工具可以共享作品。连接时显式选择项目和编辑／运行模式。 [Studio MCP](https://create.roblox.com/docs/studio/mcp) · [Roblox Build](https://about.roblox.com/newsroom/2026/07/build-without-limits-on-roblox) |
| GDevelop | 官方 MCP 可连接外部 Agent，在活动窗口查询或编辑场景、对象、行为和事件，保存并运行玩法测试。部分项目与资源服务依赖账号或云服务。 | 场景、对象、行为、事件是稳定的 Agent 操作词汇。把保存和测试纳入工具面。 [GDevelop MCP](https://wiki.gdevelop.io/gdevelop5/interface/ai/mcp/) |
| Fortnite UEFN | 官方提供编辑器 MCP，覆盖场景与内容操作、Verse 等编辑流程及编译、试玩。 | 运行编译和试玩要成为可观察的步骤，工具应返回面向修复的诊断。 [UEFN MCP](https://dev.epicgames.com/documentation/fortnite/uefn-mcp?lang=en-US) |
| Unity | Unity 提供 CLI MCP，官方文档说明它替代了旧的编辑器 AI 包内 MCP 服务。 | 编辑器、CLI 与 Agent 可以共享同一条工具链，连接方式可以演进，核心契约独立于客户端。 [Unity CLI MCP](https://docs.unity.com/en-us/unity-cli/replace-mcp-server-unity-cli) |
| Rosebud AI | 官方展示提示词生成、编辑与分享网页游戏，也提供发布 CLI。CLI 说明独立发布入口的形态。 | 交付要有轻量入口，试玩结果适合直接给朋友体验。 [Rosebud](https://rosebud.ai/) · [发布 CLI](https://www.play.rosebud.ai/docs/get-started/quickstart) |
| Minecraft Bedrock | 内容包清单支持稳定身份、版本、模块和依赖。 | 资源、玩法和世界可各有生命周期，作品包需要可验证的依赖。 [Bedrock 包清单](https://learn.microsoft.com/minecraft/creator/reference/content/addonsreference/packmanifest?view=minecraft-bedrock-stable) |

Roblox 在 2026 年第三季度披露，Build 在四个 alpha 市场有超过 50 万用户，创作者发布了超过 7 万个游戏。这两项使用不同单位，不能相除得到创作者转化率。数据说明低门槛创作已受到市场关注，City 的目标人群和付费意愿仍需独立验证。 [Roblox Q3 股东信](https://www.sec.gov/Archives/edgar/data/1315098/000162828026068235/ex991-q32026earningsshar.htm)

可验证的机会是把三个已有需求连起来。第一，玩家可以带自己的 Agent，在固定的项目权限内工作。第二，玩家与 Agent 共享同一草稿，改动可见、可纠正、可撤销。第三，最终交付的是独立于会话数据、可离线试玩和复现的 City 作品。Agent 活动驱动的个人城市可以成为玩法灵感，公开发行的作品从合成 City 或独立、可分发的场景起步。产品的初期积累来自可组合的玩法模板、可复用的诊断、创作者的作品和许可明确的素材。

用现有 City 玩法建立操作基线。重点观察玩家能否通过 Agent 创建另一种目标或胜负逻辑，把它放到两个场地之一并亲自试玩，再重开草稿继续修改。记录他们是否主动利用道路和地标，以及失败发生在玩法、编辑还是接入。首轮以本地观察和访谈为主，样本用于定位阻力。跨设备分发另在内容包阶段验证。


## 2. Roblox 可借鉴的内核是作品模型、执行模型和发布模型

这里的“内核”指公开文档能核实的作品、编辑和运行契约。Roblox 引擎私有实现、进程拓扑和调度细节没有纳入推断。

| Roblox 的公开契约 | 对 Oh Agent 的架构要求 |
|---|---|
| 一个项目可有多个 Place。Place 用有类型的 Instance 层级描述对象。 [Projects](https://create.roblox.com/docs/projects) · [Data model](https://create.roblox.com/docs/projects/data-model) | 定义有稳定 ID 的作品图。场景对象、关卡组件、规则和资产引用能被查询、校验、比较和重新加载。Three.js 对象从作品数据构建，编辑时持久化的是作品数据。 |
| 发布的编辑模型进入运行会话，客户端与服务端承担不同职责。Studio 提供编辑、客户端和服务端测试视图。 [Client-server](https://create.roblox.com/docs/projects/client-server) · [Studio testing](https://create.roblox.com/docs/studio/testing-modes) | 每次试玩绑定草稿 revision、运行时版本和随机种子。试玩状态、进度和临时对象留在运行会话。多人阶段单独设计权威状态与投影协议。 |
| Studio 有版本历史。恢复历史版本产生新版本，公开发布是独立操作。 [Version history](https://create.roblox.com/docs/projects/version-history) | 草稿 revision、试玩快照、发行版本各有身份。回退生成新 revision，在线公开发行由人触发，接收者能选择固定版本。 |
| Packages 支持复用与版本管理。Creator Store 供应创作资源，游戏发布与发现有各自入口。 [Packages](https://create.roblox.com/docs/projects/assets/packages) · [Creator Store](https://create.roblox.com/docs/production/creator-store) · [游戏发布](https://create.roblox.com/docs/production/publishing/publish-games-and-places) · [发现](https://create.roblox.com/docs/discovery) | 分开资源库、可玩体验与商店商品。内容包锁定具体依赖和摘要，报价及授权独立变化。 |

仓库有三条可以直接利用的路径。**Sessions Building MCP** 已验证针对单栋建筑的读取、预览、版本检查、提交与持久化。**Mecha MCP** 能创建内存对局、执行真实规则命令、观察状态与运行自动对战，可作为试玩适配器的参考。**City Activity Host** 方案提出注册、路由、生命周期和独占资源租约，仍是建议稿，面向第一方模块。新 Studio 需要新增作品权威、多人或多 Agent 编辑冲突语义、独立于对局的版本管理、公开内容格式和导入运行链路。官方插件的宿主身份和应用包契约提供可复用思路，社区内容包须单独定义。[Building MCP](CITY_BUILDING_MCP.md) · [Mecha MCP](MECHA_MCP.md) · [Activity Host 建议稿](CITY_ACTIVITY_PLATFORM_ARCH_2026_11_07.md)

## 3. Agent 操作真实项目，Studio 保留人的控制

### 从 City 进入创作

Creator Studio 使用现有官方内置插件机制，随 Oh Agent 的桌面应用一起安装与升级。建议在 `apps/desktop/plugins.json` 登记 `creator-studio`，由宿主加载同窗独立 WebView，首版 `dataProjections` 为空。City 的挑战页提供「创建挑战」。Studio 首版显示场地绑定、游戏规则、Agent 改动和撤销入口。City 负责正式可视试玩和已安装体验的运行。两者可复用场景模型和渲染适配库，各自管理 WebView 和场景实例。[官方插件接入指南](OFFICIAL_PLUGIN_INTEGRATION_GUIDE.md)

可视试玩沿用宿主一次只运行一个活动插件的机制。宿主保存返回上下文和指定 revision 的不可变快照，关闭旧 Studio WebView，启动 City 并授权新实例领取快照。试玩完成、取消或启动失败后，宿主结算本次运行，重新打开 Studio，恢复项目和选中对象。交接、超时与恢复由新增的窄接口负责，详见[软件架构规格](AGENT_CITY_CREATOR_STUDIO_ARCH_2026_11_09.md)。

MCP 由 Agent 启动独立的本地 stdio 适配器，再经受限本地 IPC 访问宿主。Studio 与 MCP 共用 Rust 项目服务。P0 只允许 Agent 在获授权的 Studio 实例和项目处于前台时编辑，切到 City 后只可查询该项目获授权的试玩结果。返回 Studio 后重新绑定编辑权限，次日重开可继续编辑已保存项目。

```text
Studio UI ─┐
本地 MCP ──┴── 创作服务 ── 项目草稿 / revision / 变更记录
                  └── 固定试玩快照 ── 无头检查 / City 玩家试玩
```

Rust 项目服务负责有限的 P0 作品 schema、权威校验、预览凭据和原子写入。TypeScript 负责编辑呈现、场景预览和检查点玩法，运行时读取固定快照。项目服务从固定场地清单读取可建区域和玩法挂点。规则结构与场地兼容性由宿主校验，路径可达性和真实控制分别试玩。[仓库数据政策第 6 项](../AGENTS.md#data-retention--serving-face-policy-2026-09-19) · [City 活动平台架构](CITY_ACTIVITY_PLATFORM_ARCH_2026_11_07.md)

### 草稿与试玩分别保存

| 模型 | 拥有的状态 |
|---|---|
| `CreatorProjectV1` | 项目 ID、基础世界模板的固定版本和摘要、带稳定 ID 的对象与坐标、关卡目标和规则、精确资产引用、草稿 revision。首版支持已注册对象、游戏规则和场地槽位绑定。 |
| `PlaytestSnapshotV1` | 草稿 revision、规则集版本、种子、只读世界和规则参数。对局命令、事件和结果由运行会话持有。 |

### MCP 工具按创作任务设计

以下名称和字段是拟议契约，发布前与 Studio 的同一组操作一起冻结。采用本地 stdio，创建连接后由 Studio 显示客户端及绑定的项目。宿主为本地 IPC 连接建立限时授权，仅在内存中保留。项目选择和授权由用户确认，服务对每次操作检查项目、会话和权限，读和写分别授权。客户端自报名称只用于显示。宿主决定能力范围，文件路径、任意脚本执行、购买、发布和数据权限授予不进入首版工具集。

| 工具 | 输入与结果 |
|---|---|
| `project_create`、`project_describe` | 从用户准许的本地模板新建草稿，或返回当前项目 ID、revision、坐标系、支持的实体和玩法能力、限制和兼容信息。 |
| `scene_query`、`asset_search` | 按有限区域、对象类型或已安装素材查询，分页返回稳定 ID、可编辑属性和已锁定版本。 |
| `edit_preview` | 接受 `baseRevision` 与一批有类型的操作，返回规范化差异、按对象定位的错误、警告和有时限的 `previewId`。预览不写草稿。 |
| `edit_commit`、`edit_revert` | 提交已预览的同一内容，携带 `expectedRevision` 和幂等键，返回新 revision、变更 ID 和受影响对象。撤销是一笔新变更。 |
| `playtest_run`、`playtest_result`、`playtest_stop` | 按 revision、seed 和检查集合运行。MCP 启动无头规则检查。可视试玩由玩家在 Studio 发起并在 City 亲自操作。返回运行 ID、失败步骤、事件摘要及相关对象。MCP 只能取消自己发起的无头检查。结果始终绑定发起时的快照。 |

预览凭据绑定项目、revision、规范化操作摘要和发起会话。提交在当前权限下重新校验，校验、草稿写入和变更记录同一事务完成。并发修改返回 `revision_conflict`，Agent 应重新读取差异和预览。相同幂等键和相同请求返回原结果，同键异参拒绝。错误返回稳定代码、字段路径、对象 ID 和可执行的修正提示。大型查询、运行轨迹和截图使用有界结果，截图可作为辅助观察，几何和规则事实以运行结果为准。玩家可在 City 或宿主界面结束当前试玩，在 Studio 查看对应结果或撤销编辑权限。短暂预览、试玩失败和取消应释放各自资源。

例如玩家说：“在海滨广场放三个检查点，限时 60 秒按顺序通过。”Agent 查询合成城区的场地挂点，提交出生点、检查点、计时及胜负规则的预览。若检查点在障碍内，工具返回对象和坐标，Agent 修正后再提交。固定种子的无头检查验证可达性、检查点顺序和胜负状态。可视试玩走真实输入路径，检查按键移动、HUD 提示和终点结算，记录失败步骤与简短诊断。玩家手动把时限改为 75 秒后，Agent 读取新 revision，再移动一个检查点。玩家可重开同一草稿并再次试玩。规则测试、真实输入测试和真人对乐趣的判断分别记录。Roblox 也公开了面向游戏创作 Agent 的编辑和输入验证研究。 [OpenGameEval](https://about.roblox.com/newsroom/2025/12/opengameeval-benchmark-agentic-ai-assistants-roblox-studio)

## 4. City 皮肤和内嵌小游戏如何搭配

| 对象 | 提供什么 | 用户怎么用 |
|---|---|---|
| City 布局 | 道路、碰撞与场地挂点，例如路线、可步行区域、起点和目标点 | 使用已有城市。首版用两个固定布局验证兼容性 |
| City 皮肤包（Shop 商品） | 材质、色板、灯光、外观资源与兼容版本 | 预览后应用到当前城市，可以切回原皮肤 |
| 内嵌小游戏包（Shop 商品） | 声明式规则、需要的挂点类型和数量、默认参数、兼容版本 | 选择「添加到城市」，由 Agent 或玩家指定挂点 |
| 挂载记录 | 城市和小游戏的固定版本、具体挂点、参数覆盖、启动入口 | 保存到自己的 City。可以换位置、复制或移除，同一个游戏可在不同城市保留不同配置 |

同一个小游戏包可以给多座符合条件的城市使用，同一座城市也可以挂多个小游戏入口。预览先展示匹配结果、所需权限和缺失的场地条件。比如竞速需要一条可用路线，选中的城市没有路线时，Studio 明确提示缺什么，再让玩家换场地或改规则。宿主检查绑定、版本和场地约束后才提交。购买或领取、安装包、挂载到城市分别执行。挂载成功后，在 City 里从对应入口开始一局。

首版规则采用有类型的事件、条件、动作和状态转换。可从区域进入、拾取、计时与计数出发，组合计时竞速、自由顺序寻宝等机制。验收要让 Agent 从自然语言增删或改写规则，并让两个玩法共享同一个运行器。首版用可组合规则探索自由度，脚本扩展按实际创作需求另行设计。

## 5. 架构升级后推出 Shop

- **阶段一，升级并验证 City。** 用两种皮肤、竞速和寻宝两个小游戏、两份固定布局验证组合。同一布局换肤后，路线、碰撞、入口和成绩保持一致。同一个游戏包可在两份兼容布局运行，同城能同时挂两个小游戏。缺少场地条件时给出修复提示。先用本地官方内容验证安装、应用、挂载和重启恢复。
- **阶段二，推出官方 Shop。** 首发提供 City 皮肤和内嵌小游戏。购买皮肤后可预览并应用，购买小游戏后可选择兼容场地并挂载。目录、安装和权益由宿主负责。用户主动确认购买，Shop 说明退款、恢复购买和离线权益的规则。上架收费前用测试支付验证购买、安装、恢复和退款。支付渠道由实际发行范围决定。
- **创作延伸。** Studio 与 Agent 使用相同的规则和挂载接口。首发 Shop 可使用官方内容验证供给和消费。创作者上架、外部代码、通用插件市场和完整多城存档另行评估。联网分发与真实数据授权遵循仓库政策。[仓库数据政策](../AGENTS.md#data-retention--serving-face-policy-2026-09-19)
