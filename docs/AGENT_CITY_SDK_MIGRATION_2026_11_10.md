# Agent City 迁移到创作 SDK

本文把 [SDK API v0.1](AGENT_CITY_SDK_API_2026_11_10.md) 映射到现有实现。官方 Agent City 成为 SDK 的参考应用。City 内部活动沿用 [活动平台方案](CITY_ACTIVITY_PLATFORM_ARCH_2026_11_07.md) 的统一入口与资源租约。创作者通过公开契约创建内容，City 将内容挂载为活动。Studio 与 City 间的 WebView 切换另由 [Creator Studio 架构](AGENT_CITY_CREATOR_STUDIO_ARCH_2026_11_09.md) 定义。

## 实施进度

2026-11-11 更新：Creator 项目的 `cityLayout` 现在绑定 City 运行时导出的受限快照。City 适配器从当前道路图选择可达的稳定锚点 ID；快照只包含 layout ID、worldRevision、seed 与锚点能力/几何引用，不包含场景坐标或几何。宿主只接受活动官方 City 插件发布的快照，Rust 项目服务按 worldRevision 保存并拒绝同一 revision 对应不同内容；Studio 与 MCP 可以列出这些快照，新项目必须选定一个 revision。Studio 的挂载预览和 Rust 提交校验都以该快照中的锚点为准。`city-road-v2` revision 覆盖道路端点及边中点的地面高度，并使用 128 位确定性 freshness 指纹；它用于检测版本漂移，不是安全签名。地貌变化会使旧挂载失效。

2026-11-11 更新：新增显式 `creator.project.publish` / MCP `creator_project_publish`，Rust 按保存的项目 revision 冻结不可变 release，包含规则包、已校验挂载、布局版本、注册的 City 皮肤 ID、场景模型和资产摘要引用；GLB 字节仍位于本机项目的内容寻址存储中，当前 release 不是独立分发包。MCP 发布受 `--allow-local-writes` 控制。City 专用 `city.creator.experiences.list/read` 只读取已发布 release，并要求匹配活动 City 的 layout ID 与 worldRevision；Studio 草稿不暴露给 City。City 当前支持通过小地图「小游戏」图层发现入口，并复用车辆驾驶会话启动 drive 能力的 zone 小游戏；运行前会重新校验内容摘要、场地引用、锚点和玩法事件，开始时临时应用 release 皮肤，退出后恢复原外观，保留布局 revision 与用户偏好。远端 City 不读取本地 Creator release。

该切片完成的是“发布到我的 City → 在当前城市地图发现并游玩”的本地闭环。当前运行时只支持驾驶与区域触发；步行玩家位移、3D 世界中的实体入口标记、外部包安装和 Shop 仍未完成。Studio 到 City 的最小自动交接已落地：本地 SQLite 保存 run，宿主按固定事件导航，活动 City 认领已发布 release，运行终态摘要绑定 release snapshot digest 后持久化，可经 `creator_playtest_history` MCP 按项目读取；终态后新 Studio 实例消费返回上下文并重开项目。当前只恢复 projectId/revision；没有完整编辑器上下文，也没有输入轨迹/规则失败断言证据持久化，生产桌面端真实交互 smoke test 未做。

当前实现包括：

- 世界配置已通过 `CityWorldProfileV1` 组合生成器、生成参数、生物群系和主题。Miami 海岸/岛屿与干旱沙丘两种生成器已接入 City 布局、规划 worker、缓存和远端快照校验。无海岸时海港、岸线地标、海滨街区、水面与船只按地貌能力关闭。City 设置现可独立选择 Miami/沙丘世界和两款内置视觉皮肤，profile 与 skin ID 分别保存在插件本地 localStorage；启动时按 SDK 皮肤兼容性校验组合，不兼容或未知值回退默认。更换后重载 City。尚无古埃及专属资产、多个可管理 City 实例或 Shop 皮肤安装流程。
- `@agent-vitals/city-sdk` 有独立 ESM 和声明文件构建，涵盖小游戏 JSON 解析、未知输入校验、冻结快照、锚点与场景对象查询、已检查目录快照的资产筛选/引用校验、GLB v2 容器及常见 accessor 边界检查、挂载校验、确定性规则编译/运行、无头试玩、CityWorldProfileV1 profile 契约与参数校验、package manifest 结构校验和 unsigned development package 的摘要生成/验证。`oh-agent-sdk asset inspect` 可对显式指定、最多 64 MiB 的本地 GLB 做受限结构检查并计算实际字节摘要；`asset import` 将其复制到项目内由 SHA-256 派生的路径并登记 `CityProjectAssetCatalogV1`，`asset verify` 重新读取文件并复核长度、摘要和结构。CLI 现在通过 `scene.json` 与 `ModelAssetRefV1` 将资产目录、场景摆放和引用校验连起来；`pack` 将 catalog、scene 与原始 GLB 字节（JSON artifact 中以 base64 表示）收入 manifest，`verify` 重算原始二进制摘要并重新检查 GLB。桌面 Creator Studio 现可通过原生文件选择器导入 GLB，Rust 项目服务检查 GLB v2、保存至项目级 SHA-256 内容寻址目录、更新项目 revision，并在场景 preview/提交与 release 发布时复核模型引用和磁盘字节摘要；文件路径和二进制不经 MCP 或 WebView payload 传输。release 冻结场景、资产目录和精确摘要引用；GLB 原始字节仍存于本机项目的内容寻址文件中，因此当前 release 不是可导出、迁移或独立安装的完整包。City 运行时通过独立 `ohcityasset://` 本机资源协议按 release ID 与 SHA-256 加载 GLB；协议只向当前活动的官方 City WebView 提供 GET/HEAD，Rust 在返回字节前重新检查 release 引用、文件长度、摘要及受限 GLB 结构，Three.js 加载器再按有界模型/资产预算渲染静态模型实例。该导入与运行路径仍拒绝外部 URI、glTF 扩展、动画和蒙皮；只支持当前受限的静态 GLB 子集，不是完整 glTF 验证器或通用资产沙箱。`support.glb` 使用当前受限检查器拒绝的 glTF 扩展，不能直接复用。`oh-agent-sdk` 支持 City mini-game 的 init/validate/sync-refs/playtest/pack/verify，以及 city-world profile 的 init/validate-world。world profile CLI 只生成和校验数据配置，不执行生成器或生成可安装包。SDK 未发布，开发包不可安装，且不做发布者签名或外部包发现。SDK 包级 typecheck、build、CLI 闭环与 `npm pack --dry-run` 已验证；桌面资产 release/runtime 链路通过目标 Rust 单测、Tauri `cargo check` 及 City/Studio TypeScript 类型检查，但尚无桌面真实视觉试玩验收。
- `oh-agent-sdk init app-game` 可生成 Vite WebView App Game 样例，默认链接当前 checkout 的私有 `@agent-vitals/app-sdk`，也可通过 `--app-sdk-tarball` 使用显式本地 tarball。App SDK 的 allowlist 打包已验证；一个从仓库外生成的样例已从 tarball 安装，并通过 TypeScript 检查和 Vite production build。包仍标记为 private、未发布 registry；该路径支持独立消费验证与受控本地分发，不注册桌面插件、不签名、不授予运行权限，也不构成可安装包。
- City 可信 TypeScript 适配器把地面可驾驶路网投影为 SDK 锚点和 capability-scoped traversal links；固定步活动宿主把车辆状态转换为规则事件。官方三检查点竞速、区域寻宝和 Creator 发布的小游戏使用同一 SDK 挂载校验、声明式规则与固定步触发器；City 驾驶模式和小地图入口可发现并启动匹配当前布局的已发布 Creator 挂载。运行时复用道路锚点、车辆控制、目标标记、进度 HUD 和 City 活动租约。挂载启动时比较当前 City layout ID/worldRevision，并由 SDK 校验解析出的 game ref 与 mount digest。SDK、Creator Studio、Rust 项目服务与 City 运行时按同一份链接快照检查拓扑可达性；入口几何、净空和路线质量仍由 City 可信适配器检查。Creator release 可携带静态 GLB 场景模型与显式静态盒体碰撞代理；盒体按 release 和 City revision 加入该次驾驶的冻结碰撞索引，模型本身不推断碰撞。Studio 发起的可视试玩会显示同源碰撞线框；focused tests 覆盖规则、包围盒变换、碰撞索引命中、线框几何一致性与 Rust 输入校验。City 桌面端完整视觉试玩及 GLB 画面的真实视觉验收仍未完成。
- Creator Studio 官方 WebView 与 Rust SQLite 项目服务支持规则、场景对象、锚点、静态盒体碰撞代理、挂载、皮肤与 GLB 导入的 preview/commit；项目绑定已捕获的 City 布局快照，Studio 与 Rust 服务校验挂载入口、槽位绑定、能力、引用和资产摘要。项目 revision 使用 CAS 和 operationId 幂等。Creator 可显式发布已保存 revision；City 只读取兼容当前布局的不可变 release。运行完成、失败或取消会将绑定 release digest/revision 的有限终态摘要写入 SQLite，Agent 可通过 `creator_playtest_history` 读取。MCP 创建、提交和发布要求 `--allow-local-writes` 且 Studio 前台活动。剩余缺口包括 walk 玩家运行时、3D 实体入口标记、动态/网格碰撞与模型交互、完整 ReturnContext、输入轨迹/断言级试玩证据、按用户/项目隔离的 MCP grants、完整 glTF 支持、外部包发现/签名/安装及 Shop。
- City World Profile 现在可通过 `city_world_profile_preview` → `city_world_profile_apply` 由 Agent 修改当前官方 City：预览在 City WebView 内运行 SDK/schema 与 City 生成器注册校验，令牌绑定 WebView 实例和基线 Profile，五分钟过期且数量有界；提交受 `--allow-local-writes`、活动空闲检查和 operationId 幂等保护。此路由只组合现有 Miami/沙丘生成器与官方主题，不会安装资产或引入新代码。World Profile 仍是当前 City 插件的单个本地偏好，多座 City 的 profile/skin 分仓尚未实现。

近期优先级仍是 City 引擎边界和可组合内容能力。剩余地理重构债务包括部分规划代码继续读取 `signedLandDistance`、河道闭包和山脊场兼容字段，以及 Miami 专用的道路、地块和植被规则。`CoastalRoadSystem` 是按海岸能力启用的世界规划模块，不是皮肤插件。跨世界 SDK 自动化测试覆盖了生成路网和玩法路线绑定；仍需验证沙丘下的真实驾驶、Creator release 的真实画面、完整编辑器上下文恢复，以及补齐步行/实体入口/互动对象能力。当前小游戏挂载已能进入 City 驾驶运行时，Creator release 的静态 GLB 已有本机读取链路；二者还没有桌面端视觉 smoke test。皮肤与挂载草稿使用 revision 持久化。

## 当前 dev 基线

以 `origin/dev@2466e1dd` 的已提交树为准。实现位于独立 worktree 的 `codex/city-sdk-migration-slice` 分支，`dev` 工作区保持不变。下表按该基线盘点。

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
4. **验证内容能脱离官方代码。** 让独立目录使用公开 SDK 与 CLI 生成、修改、校验、无头试玩，并生成/验证 unsigned development package。该产物验证内容完整性但不可安装；正式发布仍需签名/信任链。分别挂到迈阿密与绿洲。换一套纯视觉皮肤后，核对锚点、道路、碰撞、成绩不变。用第二种规则的寻宝包验证同城可配置多个入口。把被挡检查点作为诊断样例，创作者移动它后重跑。
5. **接 Studio、MCP 和交付。** 项目服务保存草稿、revision、预览和试玩快照。Studio 与 Agent 经同一事务编辑规则、模型实例和锚点。玩家可视试玩走宿主的 Studio 到 City 交接。先让 City 通过本地包格式加载内容，Shop 后续使用同一安装与挂载入口。独立 App Game 模板使用 App SDK 和合成数据开发宿主，作为插件接入的独立验收。

每个现有玩法迁完后，再移除其重复启动逻辑与 UI 互斥判断。正式存档与远程协议需要自己的迁移与兼容验证。首轮使用新竞速包的独立成绩空间，既有飞行和机甲成绩继续由原存档路径持有，直到有可验证的迁移方案。

## 首个可合并切片

先将驾驶入口接到统一准入，复用现有 `GameRuntime`、车辆会话和租约。随后在同一入口跑通固定合成场地的三点竞速，打通最小场地绑定、规则执行和 City HUD 反馈。验收用正常驾驶输入完成一局，覆盖取消准备、场景失效、结束返回、重复进入及错序检查点的无头检查。机甲和飞行只需在首刀参与互斥，各自入口迁移可与第二地图和外部模板并行验收。Studio 与 City 的最小宿主交接可在首周独立验证，完整交接随项目服务与 Studio 接入验收。
