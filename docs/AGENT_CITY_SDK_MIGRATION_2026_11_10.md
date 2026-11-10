# Agent City 迁移到创作 SDK

本文把 [SDK API v0.1](AGENT_CITY_SDK_API_2026_11_10.md) 映射到现有实现。官方 Agent City 成为 SDK 的参考应用。City 内部活动沿用 [活动平台方案](CITY_ACTIVITY_PLATFORM_ARCH_2026_11_07.md) 的统一入口与资源租约。创作者通过公开契约创建内容，City 将内容挂载为活动。Studio 与 City 间的 WebView 切换另由 [Creator Studio 架构](AGENT_CITY_CREATOR_STUDIO_ARCH_2026_11_09.md) 定义。

## 当前 dev 基线

以本地 `dev@cd3da82e8` 的已提交树为准。审阅时工作目录的 HEAD 指向同一提交，另有未提交的 City、远程会话和类型化数据改动。下面把这些改动与已提交能力分开。

| 已提交能力 | 重构判断 |
|---|---|
| `GameRuntime`、`FixedStepClock`、`CarAdapter`、`FlightAdapter` 和 `HostGameScenePort` 已存在。`createCityCarSession` 与飞行 `GameSession` 已获取场景租约 | 复用底层运行与租约。新增一处活动准入和资源协调，覆盖准备期间的竞争、退出和取消。机甲目前仍获取独立的 `acquireModeLease`，先协调这条路径的互斥，再迁它的入口。 |
| `CitySurfacePort` 已提供版本化地表捕获、地表查询与失效判断，驾驶已有连续碰撞和道路验证脚本 | SDK 通过场地适配器复用这些能力。先从实际可行驶路线固定一组锚点，再把检查点区域转换为规则事件。暂用可信的固定场地，公开场地协议只提供必需字段。 |
| 已有 App SDK、官方插件注册以及 City Building MCP 的读取、预览和带 revision 写入 | 复用宿主接入和事务经验。当前 Building MCP 编辑会话楼，Creator 项目需要自己的草稿、授权和试玩快照。`dev` 尚无独立 City SDK 包和 Creator Studio 官方注册。 |
| `dev` 的官方描述仍包含旧 City 投影。工作区另有类型化数据授权和 City TS 适配器改动 | 创作 SDK 首轮使用合成场地。按当前仓库政策接入可信 TS 数据适配器，类型化数据与远程会话迁移分别验收。 |

迁移前用现有 `verify-city-game-scene-lease.mjs`、`verify-city-driving-entry.mjs`、`verify-city-driving-architecture.mjs` 和 `verify-city-game-flight.mjs` 建立行为基线。机甲入口迁移时补验 `verify-mecha-lease.ts` 及已有的远程和回放验证。这里记录的是代码盘点，脚本通过情况由实施时确认。

## 代码边界

| 位置 | 迁移后的责任 |
|---|---|
| `packages/agent-vitals-app-sdk` | Oh Agent 插件生命周期、宿主通信、已授权的类型化数据和状态接口 |
| `packages/agent-vitals-city-sdk` | 场景、资产、锚点、小游戏包与挂载的版本化契约，纯校验和规则运行器。根入口和运行器可被 CLI 及浏览器使用 |
| `apps/agent-city/ui/src/engine` | 现有生成器、渲染、地表、碰撞和城市快照。通过可信适配器向 SDK 提供查询和事件 |
| `apps/agent-city/ui/src/game` | 活动宿主、官方驾驶／飞行／机甲适配器、输入、HUD 和会话资源 |
| `apps/agent-city/ui` | 官方应用入口和用户界面。加载官方布局、皮肤和活动清单，展示活动状态 |
| Creator 服务、Studio、CLI | 桌面事务与授权由宿主持有。Studio 和 MCP 共用项目服务。CLI 对独立目录复用 SDK schema、校验和规则运行器 |

依赖方向为 City 应用和工具指向 SDK。SDK 使用普通数据和注入的场地查询，能在没有 React、Three.js、Tauri 或 Agent Vitals 会话数据时运行。包只看公开槽位和运行事件。渲染对象、租约、输入控制和数据授权留在应用或宿主。现有本地数据投影继续走 Rust 类型化数据边界与可信 TS 适配器。

## 现有代码如何迁移

| 现有入口 | 迁移方式 |
|---|---|
| `CityApp.tsx`、`CityExperience.tsx` | 接入内部活动注册表和 `ActivityHost`。工具栏、场景标记和其他正式入口统一请求启动，UI 读取同一活动状态及拒绝原因。城市修复、预览等也参与互斥策略。 |
| `cityPlan.ts`、`cityShape.ts`、`cityTheme.ts` | 用布局描述包装现有迈阿密生成器，先保持同输入生成同结果。将可替换材质、色板和灯光注册为默认皮肤。影响路网、地形、模型占地或碰撞的迈阿密参数仍属于布局。先声明小范围官方锚点，再做第二张固定合成地图。 |
| `citySurfacePort.ts` | 从同一布局及地表快照提供地面、障碍和路线查询。场景重建后旧查询句柄失效。SDK 的坐标和单位在适配器边界显式转换。 |
| `GameScenePort.ts`、`HostGameScenePort.ts`、`CityEngine.ts` | 保留现有场景租约作为底层机制。ActivityHost 在准备阶段取得活动所有权，并按活动需求申请底层资源。退出后统一清理。 |
| `createCityCarSession.ts`、`DrivingSimulation.ts` | 将自由驾驶注册为官方活动。新增地面检查点竞速参考包，复用驾驶会话与控制。基于受信任的车辆移动结果检测检查点，向规则运行器提供事件。 |
| `GameSession.ts`、`RaceCourse.ts`、`RaceMission.ts` | 把现有飞行练习和穿环挑战注册为官方活动。保留赛道生成、空中检测和现有评分。地面玩法已验证后，再评估哪些穿环规则可迁到公共规则原语。 |
| `CityMechaWorld.tsx`、`SequentialMechaMatch.tsx` | 注册为可信机甲活动。用只需相机与输入能力的活动适配器接管当前模式租约，保持战棋规则、对局存档、远程协议和回放边界。 |

统一的是活动入口和生命周期。官方活动可以继续使用可信 TypeScript 逻辑。声明式小游戏通过同一个活动宿主启动，但执行的是 SDK 规则。内置飞行和机甲都要接入统一生命周期，其完整规则不需要用首版计时与计数原语重写。

## 迁移切片和验收

1. **统一活动入口。** 在现有应用里建立活动 ID 到可信适配器的映射。用 `idle → preparing → running → stopping → idle` 管理所有权。准备阶段即阻止竞争启动，取消、初始化失败和场景失效都触发同一清理路径。使用运行标识和场景代次拒绝迟到回调。首个切片只迁自由驾驶及与现有活动的互斥。地面竞速纵向切片通过后，依次迁机甲和飞行，验证原入口、控制、镜头、结果及退出恢复。
2. **定义最小 SDK 契约。** 实现固定布局与锚点、玩法包与挂载、结构化诊断。把迈阿密当前场地通过适配器呈现为公开数据。只选一段可通车路线与三个检查点，固定其布局版本、场地快照和锚点 ID。布局锚点缺失时在启动前返回可修复的错误。
3. **用真实驾驶跑通 SDK。** 在 City 增加官方检查点竞速入口。启动时执行 `validateMount → compileRules → createRun`，规则接收车辆实际通过检查点的事件，输出计时、目标进度和胜负。车辆、相机与碰撞沿用现有会话。运行停止后成绩按挂载隔离，编辑草稿与城市布局不受影响。同一个包用固定事件序列做无头检查，玩家从正常 City 入口完成可视试玩。
4. **验证内容能脱离官方代码。** 让独立目录使用公开 SDK 与 CLI 生成、修改、校验和打包一个竞速包。分别挂到迈阿密与绿洲。换一套纯视觉皮肤后，核对锚点、道路、碰撞、成绩不变。用第二种规则的寻宝包验证同城可配置多个入口。把被挡检查点作为诊断样例，创作者移动它后重跑。
5. **接 Studio、MCP 和交付。** 项目服务保存草稿、revision、预览和试玩快照。Studio 与 Agent 经同一事务编辑规则、模型实例和锚点。玩家可视试玩走宿主的 Studio 到 City 交接。先让 City 通过本地包格式加载内容，Shop 后续使用同一安装与挂载入口。独立 App Game 模板使用 App SDK 和合成数据开发宿主，作为插件接入的独立验收。

每个现有玩法迁完后，再移除其重复启动逻辑与 UI 互斥判断。正式存档与远程协议需要自己的迁移与兼容验证。首轮使用新竞速包的独立成绩空间，既有飞行和机甲成绩继续由原存档路径持有，直到有可验证的迁移方案。

## 首个可合并切片

先将驾驶入口接到统一准入，复用现有 `GameRuntime`、车辆会话和租约。随后在同一入口跑通固定合成场地的三点竞速，打通最小场地绑定、规则执行和 City HUD 反馈。验收用正常驾驶输入完成一局，覆盖取消准备、场景失效、结束返回、重复进入及错序检查点的无头检查。机甲和飞行只需在首刀参与互斥，各自入口迁移可与第二地图和外部模板并行验收。Studio 与 City 的最小宿主交接可在首周独立验证，完整交接随项目服务与 Studio 接入验收。
