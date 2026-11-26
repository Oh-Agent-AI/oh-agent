# Miami 内置游戏 SDK 化与独立仓库迁移 SPEC

> 日期：2026-11-19  
> 状态：Proposed，等待评审后实施（实施时序见关联的优先级 spec）  
> 适用范围：Agent City（City Engine / game 层）、city-game-sdk、agent-vitals-city-sdk、agent-vitals-city-game-runtime、Desktop Host、Creator Studio  
> 关联：`CITY_CODE_GAME_PREVIEW_ISOLATION_SPEC_2026-11-19.md`（City/Game 资源与安装模型）、`CITY_REPO_SPLIT_PRIORITY_SPEC_2026-11-19.md`（拆仓优先级与时序——**取代本文 §10 的实施时序**，并裁决 relay/mcp 归属，见其 §5.1.1/§5.1.2）、`AGENT_CITY_GAME_SDK_V2_PRD_RFC_2026-11-18.md`、`CITY_VICE_THEME_SPEC.md`（主题内容边界）  
> 决策来源（2026-11-19 评审讨论）：
> 1. Miami City 代码迁移到独立 GitHub 项目维护，打包默认包含；
> 2. 项目充分解耦，不与底层代码耦合，按 SDK + 安装包方式接入；
> 3. 代码归属三分：City Engine（可信宿主实现）/ SDK（契约与纯计算）/ 游戏包（内容）；
> 4. 迈阿密必须使用 SDK 通用 API，宿主内不得存在任何特殊定制分支；
> 5. 四个内置游戏（flight / driving / mecha / cinema）全部拆为独立项目，使用 game sdk 标准接口。

## 1. 背景与问题

当前四个 Miami 内置活动（飞行、驾车、机甲战棋、航拍）以源码形式硬编码在 City 插件内部，与引擎、宿主、workspace 包存在多层定制耦合：

1. **引擎反向依赖游戏**：`apps/agent-city/ui/src/engine/CityEngine.ts:50-66` 直接 import `game/FlightCameraControls`、`game/types`（ReturnCameraView）、`game/runtime/HostGameScenePort`、`game/runtime/GameScenePort`（CameraPose/GameSelection/GameSceneLease）、`game/runtime/GameSceneSnapshot`、`game/VehicleChaseCamera`（CameraClearanceQuery/ChaseCameraSafety）。引擎认识具体游戏，这是解耦的第一堵墙。
2. **workspace 包内含内容分支**：`packages/agent-vitals-city-game-runtime/src/builtin.ts` 硬编码 `MIAMI_ACTIVITY_CATALOG_V1` 与 `BUILTIN_ACTIVITY_TEMPLATE_IDS`（miami-flight 等）；`src/adapters.ts` 提供 `createMiamiLegacyRuntime/createMiamiLegacyRegistry` 专用工厂。平台包里出现内容名。
3. **launch 通道是仪式性的**：`apps/agent-city/ui/src/game/runtime/cityInteractionRuntime.ts` 为四个活动注册 `legacy-runtime` 安装项并通过 `InteractionRouter.launch`，但其全部 launch 适配器是返回 stub 的空壳（`result()`），真实启动由 `CityApp.tsx:1087-1118` 的闭包命令直接抓引擎完成。权限门存在但不约束实际路径。
4. **默认世界/主题写死**：`engine/cityWorldProfile.ts` 定义 `MIAMI_CITY_WORLD_V1`，`CityEngine.ts` 默认 theme 为 `"miami"`；Miami 驾车灯光 GLSL 位于 `engine/render/drivingStreetLights`。
5. **打包即源码**：`apps/desktop/plugins.json` 的 `city` 插件 `source: "apps/agent-city/ui"`，由 `scripts/official-plugins.mjs` 从仓内源码构建，无安装包形态；`plugins.json` 校验正则（`^apps/[a-z0-9-]+/ui$`）也只认仓内路径。
6. **安装注册表只写不读**：`city_game_installations`（`city_game_install.rs`）已实现两段式安装与 CAS，但运行时无消费者；主 City 的游戏运行路径全部是 dev/preview 性质（`?codeGame=` 仅 DEV、预览队列、调试钩子）。
7. **跨包深路径源码 import**：`cityInteractionRuntime.ts:1-7` 以 `../../../../../../packages/...` 相对路径直接引用 city-game-sdk 与 city-game-runtime 源码；`apps/creator-studio/ui` 以相对路径直接引用 agent-city 的 engine/viewport 源码（`main.tsx:21-26`、`cityPlanPreflight.ts:1-3`、`contentSnapshot.ts:3`）。

## 2. 核心决策

1. **四个内置游戏迁移为独立仓库中的四个游戏包**（一个仓库、四个包，沿用 `games/hello-city` 目录模式），构建产物为 sealed build（内容寻址 `buildId`），仅通过 `@oh-agent/city-game-sdk` 标准接口接入宿主。
2. **零内容分支原则**：迁移完成后，`apps/agent-city/ui/src/engine/**`、`apps/desktop/src-tauri/**`、`packages/**` 不得出现任何 `miami` 标识符；由防回归扫描测试强制（§9）。
3. **信任档与 API 面分离**：官方游戏的 `trustLevel: official` 只影响签名、预置安装与生命周期授权，不扩大 API 面。一切新能力（场景租约、相机、surface 读取、存储）都做成**任何游戏按 manifest 权限均可申请的通用口子**，由能力/权限门控，绝不出现 Miami 专属通道。
4. **宿主实现、SDK 契约、游戏内容三分**（归属矩阵见 §5）：确定性纯计算下沉 SDK（保证可信引擎与游戏包逐字节一致）；权威状态与渲染留在引擎；玩法、资产、文案随游戏包。
5. **cinema 一并外置**：引擎仅保留通用相机/过渡服务；切镜计划与文案作为游戏包数据。不保留引擎内 `startCinematic` 的 Miami 语义。
6. **mecha 远程对战单独设计**：`mecha:v4` remote session 目前是 city 插件的 remote capability（`plugins.json` remoteSessions），外置后远程会话口子需要单独评审，未完成前 mecha 迁移不得启用远程对战（见 §13 风险）。
7. **打包默认预置**：四个 sealed build 随桌面 bundle 分发，首启预置安装记录到 Game Registry；预置安装可被用户停用/卸载，行为遵循隔离 spec 的 Installation 模型。
8. **防回归测试先行**：§9 的四类测试先落库（初始为红），作为迁移验收标尺。

## 3. 目标架构（2026-11-19 评审补充）

一句话：**三个仓库、一个通用通道**——主仓（平台：宿主 + SDK 契约 + Studio）、city 仓（可信引擎 + City 应用）、games 仓（四个 Miami 游戏包），四游戏全部经 `city-game-sdk` 标准接口 + 权限门控 port 接入，宿主与引擎里不再存在任何 Miami 名字。

### 3.1 总架构图（三仓 + 配置面 + 数据流）

```text
┌────────────────────────── 主仓（平台层）──────────────────────────────────┐
│                                                                          │
│  Desktop Host（src-tauri）                  SDK 契约与运行时（packages）    │
│  ├ plugin_host（插件宿主 / grants 每请求校验） ├ agent-vitals-city-sdk      │
│  ├ city_game_install（安装注册表 CAS）        │   契约：快照V4/描述符/port类型│
│  ├ code_preview_window（隔离预览）            │   surface 纯计算库（下沉）    │
│  ├ storage.game 宿主实现（新）                ├ city-game-sdk              │
│  ├ infra/app-remote-relay（自 relay/ 上移）   │   GameContext/权限/manifest │
│  ├ creator-studio（消费包，不再碰 city 源码）  │   封印：buildGame/seal      │
│  │                                          └ city-game-runtime          │
│  │                                              InstalledGameRegistry    │
│  │                                              InteractionRouter        │
│  └ packages/city-engine（★可信引擎平台包，新；不随 city 仓外移）           │
│      CityEngine 核心（场景生命周期/租约/帧调度）·世界生成（权威）            │
│      port 可信实现（scene/surface/staticWorld capture）·通用相机服务       │
│      renderCanvas·天空灯光过渡·viewport·skin pack 加载器                   │
└────────────┬──────────────────────────────────────────────┬──────────────┘
             │ pinned ref + dist digest                     │ sealed build（内容寻址 buildId）
             ▼                                              ▲
┌── city 仓（City 应用内容层）────┐           ┌── games 仓 ─────────────────┐
│ City App UI 壳（CityApp/         │           │ games/miami-flight          │
│   CityExperience/面板/preview）  │           │ games/miami-driving         │
│ worlds/miami 世界数据            │           │ games/miami-mecha           │
│ 主题 skin pack（世界 profile 数  │           │ games/miami-cinema          │
│   据+城市纹理/flora，自引擎迁出） │           │ 每包 = manifest + 固定步逻辑  │
│ relay 部署配置（不含中继代码）    │           │   + 相机策略注入 + 资产       │
│ （过渡期暂存 game/ 四游戏源码，   │           │   + agent 无头 harness       │
│   阶段 C 移出；消费主仓引擎/SDK） │           └──────────┬─────────────────┘
└──────────┬───────────────────────┘                      │ seal + 签名
           │ 构建                                          ▼
   plugins/AgentCity.plugin/ui/          ┌── 预置安装（首启，可停用/卸载）──┘
                                         ▼
┌──────────────────── 桌面 App bundle ─────────────────────────────────────┐
│ builtin-city.json（city ref + digest）  builtin-games.json（4×buildId）   │
│ ← 主仓对内容的唯一合法引用，两个配置文件构成"打包默认包含"统一配置面          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 归属三分图

```text
┌── Miami（games 仓 · 内容）──────┐ ┌── CityEngine（主仓 · city-engine 包）┐
│ 玩法仿真（飞行/驾车/机甲回合/     │ │ 世界生成 cityLayout/planPatch      │
│   航拍切镜）与规则、AI           │ │ CityEngine 核心：场景生命周期/      │
│ 相机策略（追逐/自由/路径）        │ │   模式租约/帧调度                  │
│ GLB 模型·音频·立绘·文案·HUD 布局 │ │ port 可信实现：HostGameScenePort、 │
│ 输入词表（throttle/turn…）      │ │   citySurfacePort/staticWorldPort │
│ 驾车灯光 GLSL                   │ │ 通用相机服务·画布·天空/灯光过渡     │
│ 切镜计划数据 + 15~19.6h 昼夜区间 │ │ 渲染管线 renderCanvas              │
└────────────────────────────────┘ └───────────────────────────────────┘
┌── SDK（主仓 packages · 契约+纯计算）──┐ ┌── 宿主（src-tauri · 授权与安装）──┐
│ 快照V4 / GameTypeDescriptor /        │ │ 安装注册表（两段式+CAS）          │
│   port 类型契约（scene/camera V2）    │ │ storage.game 实现（作用域 KV）    │
│ surface 纯计算库（引擎与游戏          │ │ 隔离预览窗口 / 字节分块服务        │
│   共用同一份字节，digest 版本化）      │ │ app-remote-relay（通用中继）      │
│ GameContext / 权限 / manifest / 封印 │ │ typed data / stateKeys 兼容读    │
│ 相机间隙查询算法（ChaseCameraSafety   │ │ plugin_request 路由 / grants     │
│   等算法下沉）+ cityLayoutAdapter    │ └─────────────────────────────────┘
└─────────────────────────────────────┘
```

判断标准：**双方必须逐字节一致的 → SDK；权威状态/渲染/场景生命周期 → CityEngine；玩法与资产 → Miami 包；授权/安装/跨插件服务 → 宿主**。"官方可信"只影响签名与预置安装，不给 API 特权。

### 3.3 废弃的定制逻辑 → 通用通道映射

| # | 原定制逻辑（位置） | 处置 | 走的通用通道 |
|---|---|---|---|
| 1 | 引擎 import 游戏相机/参数（`CityEngine.ts:50-66`：CarCamera、FlightCameraControls、VehicleChaseCamera、DRIVING_PARAMS、carDimensions） | **废弃反向依赖** | `scene.camera` port；间隙查询算法下沉 SDK，相机策略由游戏注入 |
| 2 | `MIAMI_ACTIVITY_CATALOG_V1`、`BUILTIN_ACTIVITY_TEMPLATE_IDS`、`createMiamiLegacyRegistry`（city-game-runtime） | **删除** | 游戏包 manifest `entries[]` → `InstalledGameRegistryV1` 注册 |
| 3 | CityApp 四闭包硬编码入口（`CityApp.tsx:1087-1118`） | **删除** | `city.games.installed` 读安装注册表 → 入口动态生成 |
| 4 | `cityInteractionRuntime` stub launch（`result()` 空壳） | **删除** | `InteractionRouter.launch` 真实路径（manifest→权限评估→port 注入） |
| 5 | `miamiActivityHost.ts` / `miamiActivityEntries.ts` 命令适配层 | **删除** | 通用 boot + manifest 注册 |
| 6 | `MIAMI_CITY_WORLD_V1` 常量、默认 theme `"miami"`（cityWorldProfile.ts / CityEngine.ts:416）+ 引擎默认城市纹理与 flora 资产（~2.2MB，Miami 风味） | **外置为数据/资产** | skin pack / world profile 通用数据通道（validate.ts 已有校验）；引擎只留中性默认 + skin pack 加载器 |
| 7 | `engine/render/drivingStreetLights` GLSL | **随 driving 包** | `scene.attach` 自渲染 |
| 8 | 引擎内 Miami 语义 cinematic（`startCinematic` 的切镜计划、`cinematicCopy.ts`、15~19.6h 区间常量） | **数据外置**，引擎只留通用过渡服务 | `scene.camera mode:"path"` + 帧钩子 + overlay HUD |
| 9 | flight `data/profile.ts`（手打 `plugin.state.*`，`flight-profile:v1`）；mecha 回放/检查点（`mecha-replays:v1` 等 3 个 stateKeys） | **废弃手打通道**（旧数据一次性迁移） | `storage.game` API（宿主实现，作用域 = installationId + playerScope） |
| 10 | relay 内 `dreamCapability` 常量、城市品牌路由 | **配置化** | 平台 relay + 城市部署配置（capability 政策注入，见优先级 spec §5.1.1） |
| 11 | `agent-city/mcp/*.mjs` 直接 import 游戏仿真核心 | **随游戏迁 games 仓**，终态废弃 | 主仓通用 sealed-build harness（`code-game-mcp-cli.mjs` + `previewGame.ts`，见优先级 spec §5.1.2） |
| 12 | creator-studio 相对路径 import city 源码 + vite fs.allow/three alias 特例 | **废弃** | workspace 包依赖（cityLayoutAdapter、surface 库、CityViewport） |
| 13 | `trustLevel: "legacy"` 的 Miami 安装项 | **废弃** | `kind: "code"` + `trustLevel: "official"`（新信任档，只影响签名/预置，不扩 API） |

引擎里**保留**的（容易误删）：通用相机过渡服务、`citySky` 灯光曲线、渲染管线、capture 服务——它们是 port 的实现侧，只是不再认识"miami"。

### 3.4 运行时：一个游戏在通用通道上的完整生命周期

```text
City WebView
  │ ①入口发现   city.games.installed（投影 city_game_installations）
  ▼            停用/卸载 → 入口即时消失；city_game_incompatible → 置灰+原因
  │ ②启动       InteractionRouter.launch
  │             ├ manifest 校验（validateCodeGameManifestV2）
  │             ├ 权限评估（evaluateGameInvocation：manifest 声明 × 宿主 grant × 玩家作用域 × City 能力）
  ▼             └ 能力兼容（drive→roads.graph，fly→volumes.indexed）
  │ ③注入       CodeGameHostV2 → GameContext（world/entities/input/ui/audio/clock/storage/dialogue）
  ▼
  │ ④运行       bundle 动态 import → defineGame(setup)
  │             ├ scene.attach(THREE 对象)   → CityEngine 场景租约
  │             ├ leaseCamera(策略)          → 通用相机服务（间隙算法在 SDK）
  │             ├ onFrame / onFixedUpdate    → 固定步时钟（同参数同轨迹）
  │             └ storage.game / ui.hud / audio.play → 宿主实现，每次调用复查权限
  ▼
  │ ⑤结束       finish(outcome) → Run/Installation 记录（玩家作用域）
               停止顺序：拒输入 → abort → 拒挂起写入 → 停调度 → 释放租约 → 关 Host Run
```

四个游戏在这条通道上**没有任何一步出现 Miami 分支**——hello-city 走同一通道，区别只是各自 manifest 声明的权限与能力。

## 4. 目标与非目标

### 4.1 目标

- 四个游戏各自成为独立可构建、可封印、可版本化的游戏包，`npm run build` 产出 sealed build，行为与迁移前等价（同 seed 固定步基线）。
- City Engine 不 import 任何游戏模块；相机、输入、场景访问全部经 SDK 契约的注入 port。
- 引擎、宿主、SDK 三层零 `miami` 标识符；新增内置游戏 = 增加一个游戏包 + 一条预置配置，宿主零代码改动。
- Miami 主题/海岸世界配置降级为通用 skin pack / world profile 数据，不再是引擎常量。
- `city_game_installations` 成为运行时权威：City 活动入口从安装注册表发现，不再从闭包硬编码。
- creator-studio 与 agent-city 的共享代码改为 workspace 包依赖，删除相对路径源码 import。
- 打包环境（无全局 Node、无源码目录）下构建、预览、安装、运行全链路可用（复用 code-game builder 的 packaged 布局机制）。

### 4.2 非目标

- 不实现社区不可信代码沙箱（P2）；本 spec 只覆盖官方签名的本地可信游戏包。
- 不改变 MCP、导出、远程 City、Actor 的既有数据权限面；不新增遥测或后台网络。
- 不迁移 Miami 主题的城市世界生成器（cityLayout/planPatch/cityWorldProfile 的生成逻辑仍在引擎；仅主题数据外置）。
- 不在本 spec 内实现 mecha 远程对战的外置口子（单独 RFC）。
- 不要求四个游戏拆为四个独立 GitHub 仓库（单仓四包即可，理由见 §7.0）。

## 5. 代码归属矩阵

判定原则：

- **双方必须逐字节一致的 → SDK**（契约、数据类型、确定性纯计算）；
- **拥有权威状态/渲染/场景生命周期的可信实现 → City Engine**；
- **玩法、资产、文案 → 游戏包**；
- **授权、安装、跨插件服务 → 宿主（src-tauri）**。

### 5.1 归 SDK（`agent-vitals-city-sdk` 或 `city-game-sdk`）

| 内容 | 现位置 | 说明 |
|---|---|---|
| GameScenePortV1 / InputPort / AudioPort / ClockPort 契约 | `city-game-runtime/src/ports.ts`（已存在，Miami 未消费） | 保留并扩展（§6.1） |
| 相机口契约（attach / setCamera / frame hook / release） | 无，新建 | §6.1，权限 `scene.camera` |
| surface 纯计算库 | `apps/agent-city/ui/src/engine/surface/`（26 文件中约 19 个纯文件） | §6.2，权限 `surface.read` |
| 世界快照契约 `CityWorldSnapshotV4`、`GameSceneSnapshot` 类型 | city-sdk `contracts.ts` / `game/runtime/GameSceneSnapshot.ts` | 已有，收敛归位 |
| 布局→SDK 视图 `cityLayoutAdapter` | `engine/sdk/cityLayoutAdapter.ts` | 已是转换层，迁 SDK |
| skin pack / world profile 校验 | city-sdk `validate.ts` / `worldParameters.ts` | 已有，Miami 主题数据改走此通道 |

### 5.2 归 City Engine（主仓 `packages/city-engine` 平台包；现状 `apps/agent-city/ui/src/engine/`）

| 内容 | 说明 |
|---|---|
| `CityEngine` 核心（世界真相、场景生命周期、模式租约、帧调度） | 移除全部 `../game/*` import（§10 PR-03） |
| `cityLayout.ts` / `planPatch.ts` / `cityWorldProfile.ts` 生成逻辑 | 权威生成器；`MIAMI_CITY_WORLD_V1` 常量外置为通用 profile 数据 |
| `citySurfacePort` / `cityStaticWorldPort`（capture 服务） | 可信 port 实现侧，调用 SDK 纯库 |
| 通用相机服务（画布获取、相机调度、帧钩子、天空/灯光） | `renderCanvas`、`render/drivingStreetLights` **不**保留后者（随 driving 包走） |
| 通用 cinematic 过渡服务（不含切镜内容） | §6.4 |
| viewport（`CityViewport`） | Studio 与 City 应用共享，随引擎平台包发布（§8.4 包化的落点） |
| 引擎默认城市纹理/flora（`assets/*.jpg` ~1.9MB、`assets/flora` 304KB） | **转 city 仓主题 skin pack 资产**；引擎只留中性默认与 skin pack 加载器（Miami 风味内容不进平台包，见 §3.3 第 6 项） |

### 5.3 归游戏包（独立仓库 `agent-city-games`，四个包）

| 包 | 现文件（`apps/agent-city/ui/src/` 下） | 资产 |
|---|---|---|
| `games/miami-flight` | `game/GameSession.ts`、`FlightSimulation/World/Visuals/Camera/CameraControls/Collision/Input.ts`、`RaceCourse.ts`、`RaceMission` 相关、`GameModeController.ts`、`useCityGame.ts`、`GameHud.tsx`、`gameCopy.ts`（飞行部分）、`VehicleChaseCamera`（飞行参数）、`data/profile.ts`（玩家档案 → `storage.game`） | `game/leonida-nights.m4a`（1.2MB） |
| `games/miami-driving` | `DrivingSimulation/World/Input/Hud`、`CarCamera.ts`、`CarVisuals.ts`、`carDimensions`、`VehicleChaseCamera`、`driving/*`（CollisionIndex、citySolids、spawnPoints、surfaceFootprint、ContinuousDrivingEnvironment、VtolDrivingEnvironment、SafeRecovery、audit/*、DrivingSfx）、`RoadAuditWorker.ts`、`useCityDriving.ts`、`useCityDrivingPlay.ts`、`useRoadAudit.ts`、`roadValidation.ts` | 驾车灯光 GLSL（现 `engine/render/drivingStreetLights`） |
| `games/miami-mecha` | `MechaBoard.tsx`、`CityMechaWorld.tsx`、`MechaModeRuntime.ts`、`SequentialMechaMatch.tsx`、`mecha/*`（rules、ai、contracts、sequential*、citySite、monsterEncounters、fightSearchRunner、fightWorker、performance、presentation/*、unitPortraits）、`cityMonster.ts`、`MonsterWorldMarkers.tsx`、`render/mecha/*`（glbRegistry、models、animation、tacticalMarkers、assaultBattlePlayer、unitLight、statusAura、performance、connectedAssaultMode、monsterSpeciesOrnaments、legacyBossOrnament） | `assets/mecha/*.glb`（6.0MB）+ portraits（~120KB） |
| `games/miami-cinema` | `engine/cityCinematic.ts`（切镜计划）、`engine/cinematicCopy.ts`（文案）、`CityEngine.ts` 内 cinematic 昼夜区间常量（CINEMATIC_HOUR_FROM/TO）、`CityExperience.tsx` 的 city-cinematic-overlay 展示部分 | — |

公共搬迁：`game/runtime/miamiActivityHost.ts`、`miamiActivityEntries.ts`、`cityInteractionRuntime.ts` 在迁移完成后**删除**（注册职责由安装注册表与通用 boot 接管）；`game/GameAudio.ts`/`GameSfx.ts`/`audio/*` 按使用归属随包（纯 WebAudio 部分可复制为各包自含）。relay 与 `apps/agent-city/mcp/` 的归属由优先级 spec §5.1.1/§5.1.2 裁决（relay 上移主仓平台层、mcp 随游戏迁 games 仓），不在本矩阵重复。

### 5.4 归宿主（`apps/desktop/src-tauri/`）

| 内容 | 说明 |
|---|---|
| `city_game_install.rs` 安装注册表 | 不变，成为运行时权威（§8.2） |
| sealed build 校验、preview 窗口、字节服务 | 不变，四游戏复用同一管线 |
| `storage.game` 宿主实现 | §6.3，替换 mecha 手打的 `plugin.state.*` |
| stateKeys 迁移：`flight-profile:v1`、`mecha-replays:v1`、`mecha-replay-library:v1`、`mecha-checkpoint:v1` | 迁移期保留读取兼容；游戏包改走 `storage.game` 后标记废弃（§13） |
| mecha 远程对战会话（`mecha:v4` remoteSessions） | 迁移期留在宿主，口子外置另立 RFC |

## 6. SDK 标准接口扩展（全部为通用口子，任何游戏可按权限申请）

### 6.1 scene/camera port（权限 `scene.attach` + `scene.camera`）

现有 `GameScenePortV1`（ports.ts）仅有 `attach/detach(root)`，无相机与帧钩子。扩展为：

```ts
type GameScenePortV2 = Readonly<{
  revision: string;
  attach: (root: unknown) => void;            // 游戏 THREE 对象挂载
  detach: (root: unknown) => void;
  leaseCamera: (policy: CameraPolicyV1) => CameraLeaseV1;
  onFrame: (hook: (dtSeconds: number) => void) => Unsubscribe;
}>;

type CameraPolicyV1 = Readonly<{
  mode: "chase" | "orbit" | "path" | "free";
  collision: "engine-clearance" | "none";     // 引擎通用间隙查询，游戏提供目标
}>;

type CameraLeaseV1 = Readonly<{
  setPose: (pose: CameraPoseV1) => void;      // 位置/朝向/FOV
  follow: (target: EntityRefV1, offset: PoseOffsetV1) => void;
  release: () => void;
}>;
```

- 实现侧：引擎（复用现有 `HostGameScenePort` 租约机器与 `VehicleChaseCamera` 的通用间隙查询算法——算法下沉 SDK 纯库，策略由游戏注入）。
- 消费方：四个游戏全部需要（mecha 画布租约、cinema 相机路径、flight/driving 追逐相机）。
- 引擎剪依赖方式：`CityEngine.ts` 不再 import `FlightCameraControls/CarCamera/VehicleChaseCamera`，改为相机策略由游戏经 port 注入；`ReturnCameraView` 等类型收进 SDK 契约。

### 6.2 surface 纯计算库下沉（权限 `surface.read`）

`engine/surface/` 26 个文件分类迁移：

- **下沉 SDK（确定性纯函数，游戏 bundle 内联，引擎与游戏共用同一份字节）**：`SurfaceIndex`、`SurfaceStore`、`compileCitySolidInputs`、`compileSurface`、`surfaceRegions`、`groundRoadCompiler`、`roadClearance`、`terrainSampling`、`terrainClip`、`terrainOps`、`surfaceDigest`、`buildGroundSnapshot`、`sceneSolids`、`structureCompiler`、`structureChecks`、`structureProfiles`、`meshBoundaries`、`landingPortals`、`landingSeams`、`landmarkPlatforms`、`roadLandingGrading`、`types`。
- **留引擎（可信 capture 服务）**：`citySurfacePort.ts`、`cityStaticWorldPort.ts`。
- **逐文件评审（渲染派生，可能留引擎）**：`renderedSolids`、`renderedSolidObstacles`、`renderedSolidTypes`。
- 验收要求：迁移后 driving 的主线程与 `RoadAuditWorker` 全部改为 import SDK 包；引擎与游戏对同一 layout 的编译结果 digest 必须逐字节一致（现有 `surfaceDigest` 机制沿用，作为等价性黄金基线）。

### 6.3 `storage.game` 宿主实现

契约已存在（city-game-sdk `src/api/v2.ts` GameStorageAPIV1：get/compareAndSet/delete + revision CAS），宿主未实现。落地为 Rust 侧游戏作用域 KV（作用域 = installationId + playerScope），替换：

- mecha：`replayBackend.ts`（`plugin.state.read`，key `mecha-replays:v1`）、typed object client（`mecha-replay-library:v1`）、`sequentialCheckpoint.ts`（checkpoint key）；
- flight：`data/profile.ts` 的 ProfilePort（`flight-profile:v1`）。

旧 stateKeys 数据做一次性迁移读取（读兼容一个版本），`plugins.json` 的对应 stateKeys 在兼容期后删除。

### 6.4 cinematic 数据外置

引擎保留通用服务：相机路径插值、昼夜灯光过渡（`citySky` 灯光曲线）、overlay 容器。迁入 `games/miami-cinema`：

- `cityCinematic.ts` 切镜计划数据、`cinematicCopy.ts` 文案、`CINEMATIC_HOUR_FROM=15 / CINEMATIC_HOUR_TO=19.6` 昼夜区间常量（现为 `CityEngine.ts` 模块常量）；
- 游戏以 `scene.camera` 的 `mode: "path"` 驱动相机，overlay 经 HUD 通道呈现。

## 7. 游戏包标准形态

### 7.0 仓库布局（单仓四包）

独立 GitHub 仓库 `agent-city-games`，沿用 `games/hello-city` 模式。单仓理由：共享一套 seal CI、一份 SDK 版本 pin、一份清单流水线；四仓无额外隔离收益（均为官方签名内容）。

```text
agent-city-games/
├── games/miami-flight/      { game.manifest.json, src/, assets/, tests/ }
├── games/miami-driving/
├── games/miami-mecha/
├── games/miami-cinema/
├── parity/                  迁移等价性黄金基线（固定 seed 固定步 tick 对比）
└── ci/                      build → seal → digest → 签名 → 预置包
```

### 7.1 manifest 要求（V2）

每个包使用 `game.manifest.json` V2：

- `permissions` 按需声明：`world.read`、`roads.read`、`surface.read`、`scene.attach`、`scene.camera`、`input.read`、`ui.hud`、`audio.play.assets`、`storage.game`（+ mecha 预留远程口子位置，另立 RFC）；
- `world.requiredCapabilities` 声明能力（`roads.graph` 需 drive 锚点、`volumes.indexed` 需 fly，判定沿用 `city_game_install.rs compatibility()`）；
- `entries[]` 声明各入口与 presentation（`exclusive`/`overlay`）；
- `assets` 声明 GLB/audio/立绘，总量注意 manifest 与 sealed build 5MB 校验上限——**mecha 6.0MB GLB 超过当前 `game_preview_too_large`（5MB）预览上限**，需上调预览预算或将 GLB 拆分为按需资产（见 §13 风险 R4）；
- 产物 sealed build：buildId 内容寻址，`loadCodeGameBuildArtifact` 逐字节复核。

### 7.2 运行形态

游戏 bundle 在 City WebView 内运行（与现有 code game P0 同一信任模型：本地可信、全权限 WebView、权限门在 API 层）。四个游戏均为 `execution` 语义下的固定步逻辑 + 经 port 的渲染注入；不再存在 `host-driven` 的 Miami 适配器——`city-game-runtime/src/adapters.ts` 的 `createMiamiLegacyRuntime/createMiamiLegacyRegistry` 与 `builtin.ts` 的 `MIAMI_ACTIVITY_CATALOG_V1/BUILTIN_ACTIVITY_TEMPLATE_IDS` 在 PR-08 删除。

**小游戏的三层引擎职责**（澄清"小游戏有没有引擎"）：

| 层 | 归属 | 职责 |
|---|---|---|
| 微引擎（循环宿主） | SDK：`CodeGameHostV2`（内联进每个 bundle） | 固定步循环、实体预算、权限门、生命周期状态机、telemetry |
| 世界引擎（宿主服务） | 主仓 `packages/city-engine`（经 port 暴露） | 场景租约、相机服务、画布、帧调度、世界真相 |
| 玩法引擎（领域内核） | 各游戏包 | 物理/规则/AI（FlightSimulation、DrivingSimulation、mecha rules/turn engine、cinematic director）与内容渲染工厂（模型/动画/特效/HUD） |

本方案刻意**不做** Unity 式通用小游戏引擎：四个游戏领域差异过大（连续物理 / 回合棋盘 / 相机导演），通用化会退化为最小公约数；引擎中可共享的部分（循环/实体/权限/HUD/音频/storage）已在 SDK，世界服务在 CityEngine。games 仓内部允许一个**仓内共享包**（如 `packages/game-kit`：车辆公共件、相机策略实现、路径/赛道工具、HUD 组件、输入词表归一），只准依赖平台 SDK；其中某件被第三方游戏也需要时，经评审上移平台。

渲染依赖说明：mecha/driving 的模型工厂依赖 three.js，作为游戏包依赖内联进各自 bundle（版本按包隔离，互不影响），体积计入 bundle 预算（与 §13 R4 一并核算）；flight 的 2D 视觉走引擎 `renderCanvas` port 提供的画布工厂。

遗留项处理：`creator.flight-ornithopter-prototype-v1` 原型当前复用 miami.flight 运行时（`adapters.ts:44-51`），迁移时改为：原型能力降级为不注册（planned），或由 Creator 侧按 `FLIGHT_CHECKPOINT_GAME_TYPE_V1` + VehicleProfileV1 preset 重建。不得在新世界保留 Miami 名字的原型别名。

## 8. 宿主与配置接入

### 8.1 插件描述符不变

`plugins.json` 的 city 插件 localCalls（`city.code.preview.*`、`city.game.run.*`、`city.story.*` 等）已是通用通道，无需因 Miami 迁移而改动。拆仓后：City 插件的**应用壳**在 city 仓（pinned ref 构建、digest 记录进 `builtin-city.json`），**引擎在主仓**（`packages/city-engine` 平台包，构建期打进应用 dist），四游戏包外置 games 仓——三者信任角色与仓库归属对齐。（source 外部化与 digest 记录由优先级 spec §5.2 承接。）

### 8.2 预置安装（打包默认包含）

1. 桌面打包流水线（`prepare-desktop-bundle.mjs` 后续步骤）从 `agent-city-games` 的 pinned ref 获取四个 sealed build（或其签名包），校验 digest 后放入 bundle 资源（与 `code-game/` 资源同层，建议 `games/` 资源键）。
2. 首启（或版本升级检测到新 build）时，宿主将四个游戏**预置安装**进 `city_game_installations`（视为官方默认安装；用户可在游戏库停用/卸载；升级按既有 updateConfirmation CAS 流程走）。
3. pinned ref 与各 build 的 sha256 记录在主仓一条配置文件中（如 `apps/desktop/builtin-games.json`），CI 校验 bundle 内 build 与配置一致。该文件是**唯一**允许出现四个游戏 ID 的宿主配置。
4. 后续分发演进：官方 catalog 索引（`vendor_manifest_install.rs` 的 commit-pinned index + sha256 payload 机制）扩展 game payload 类型后，预置安装可切换为"索引拉取 + 校验安装"，本 spec 不强制。

### 8.3 活动入口改读安装注册表（关键改造）

现状：`CityApp.tsx:1087-1118` 闭包硬编码四活动入口。目标：

1. City 启动/安装变更时从宿主读取 Installation 列表（`city_game_installations` 经通用 localCall 投影，如新增 `city.games.installed`），生成活动入口；
2. 启动活动统一走 `InteractionRouter.launch` 真实路径（manifest 校验 → 权限评估 → port 注入 → 运行），删除现 stub 适配器；
3. 停用/卸载后入口即时消失；`city_game_incompatible` 时入口置灰并展示原因。

### 8.4 creator-studio 解耦

- `main.tsx`/`cityPlanPreflight.ts`/`contentSnapshot.ts` 对 `agent-city/ui/src/engine|viewport` 的相对路径 import 改为 workspace 包依赖（共享部分随 §6.2 下沉 SDK：cityLayoutAdapter、surface 纯库；CityViewport 若仍共享则发布为包）；
- 删除 `vite.config.ts` 的 `fs.allow` agent-city 特例与 three alias workaround（视拆包结果）；
- `cityInteractionRuntime.ts` 的 `../../../../../../packages/...` 深路径 import 同步改为包依赖。

## 9. 防回归机制（先落库，初始为红）

| ID | 测试 | 断言 | 落点 |
|---|---|---|---|
| GR-01 | 零内容分支扫描 | `apps/agent-city/ui/src/engine/**`、`apps/desktop/src-tauri/**`、`packages/**` 源码无 `/miami/i` 标识符；允许清单为空（`builtin-games.json` 的游戏 ID 白名单除外） | agent-city UI 测试 |
| GR-02 | bundle import 白名单 | 游戏产物 bundle 只含 SDK 公共面内联 + 包内模块；无引擎内部模块路径、无 bare workspace specifier（扩展 hello-city 既有断言） | games 仓各包测试 |
| GR-03 | 注册路径等价 | 任意官方游戏（含四 Miami 包）经同一链路 launch：manifest 校验 → `InstalledGameRegistryV1` → `InteractionRouter` → 权限评估；注册函数不存在任何按 gameId 的特化分支 | city-game-runtime 测试 |
| GR-04 | 行为等价基线 | 每包迁移前后以固定 seed 推进相同 tick，比较实体状态/遥测/HUD 摘要与 surface 编译 digest | games 仓 `parity/` |

GR-01/GR-03 不依赖迁移完成即可落库；红的条目即迁移待办，绿一个删一处。

## 10. 实施拆分（内容清单）

> **时序修订**：本节的先后顺序与 PR 编号已被 `CITY_REPO_SPLIT_PRIORITY_SPEC_2026-11-19.md` §6 取代——拆仓（PR-S）提前到阶段 B，游戏外置调整为 PR-04'~08' 在 city 仓与 games 仓之间执行。本节保留作为各 PR 的**内容清单**。

| PR | 内容 | 依赖 |
|---|---|---|
| PR-01 | 防回归测试落库（GR-01/GR-03 可先行；GR-02/GR-04 随首包） | 无 |
| PR-02 | SDK 扩展：surface 纯库下沉（§6.2）+ scene/camera port 契约与引擎实现（§6.1）+ `storage.game` 宿主实现（§6.3）；引擎/宿主改 import SDK 包；creator-studio 与深路径 import 解耦（§8.4） | PR-01 |
| PR-03 | 引擎反向依赖剪断：`CityEngine.ts` 移除全部 `../game/*` import，相机改注入（§6.1）；`cityWorldProfile` Miami 常量外置为通用 profile 数据 | PR-02 |
| PR-04 | `games/miami-cinema` 迁移 + 引擎通用 cinematic 服务收口（§6.4）；删 CityApp cinema 闭包 | PR-03 |
| PR-05 | `games/miami-mecha` 迁移（storage 接线、GLB 预算处理见 R4；**远程对战保持宿主内暂不外置**） | PR-03 |
| PR-06 | `games/miami-flight` 迁移（profile → storage.game；ornithopter 原型处置见 §7.2） | PR-03 |
| PR-07 | `games/miami-driving` 迁移（surface 依赖最深，最后迁；`drivingStreetLights` 随包） | PR-03 |
| PR-08 | 拆仓 + 预置安装：`builtin-games.json` + 打包流水线接入 pinned sealed builds + 首启预置安装 + 活动入口读注册表（§8.2/8.3）；删除 `miamiActivityHost/miamiActivityEntries/cityInteractionRuntime/builtin.ts Miami 目录/adapters.ts`；GR-01 转绿 | PR-04~07 |
| PR-09 | 打包环境验收：无全局 Node、无源码目录下构建/预览/安装/运行全链路；stateKeys 兼容读取验证 | PR-08 |

每个游戏包迁移 PR 必须附 GR-04 等价性证据；不许以"视觉上看一致"替代基线对比。

## 11. 错误与降级

沿用隔离 spec 错误词表，另新增：

- `game_package_missing`：预置 build 在 bundle 内缺失或 digest 不符——宿主拒绝预置安装，City 活动入口不出现，其余功能不受影响；
- `builtin_games_config_invalid`：`builtin-games.json` 与 bundle 不一致——fail-closed，不回退到任何内嵌路径；
- `game_storage_unavailable`：`storage.game` 未建立——依赖存储的游戏（mecha 回放/检查点、flight 档案）显式失败，不得静默回退 `plugin.state.*`；
- 迁移兼容期：旧 stateKeys 只读兼容一个版本；兼容期结束前删除属破坏性变更，需在变更说明声明。

## 12. 验收标准

| ID | 场景 | 必须证据 |
|---|---|---|
| MG-AC01 | GR-01 扫描 | engine/src-tauri/packages 零 `miami` 标识符（`builtin-games.json` 白名单除外） |
| MG-AC02 | 引擎依赖方向 | `CityEngine.ts` 无任何 `../game/*` import；相机策略由游戏注入并经 port 生效 |
| MG-AC03 | 注册路径等价（GR-03） | 四包与 hello-city 走同一 launch 链路；无 gameId 特化分支 |
| MG-AC04 | 单包等价（GR-04） | 固定 seed tick 对比逐项一致；surface 编译 digest 一致 |
| MG-AC05 | 预置安装 | 全新环境首启后四游戏出现在游戏库与 City 活动入口；卸载其一不影响其余 |
| MG-AC06 | 停用/卸载生效 | 入口即时消失；重装复用已验证 build；`city_game_incompatible` 时置灰展示原因 |
| MG-AC07 | 权限拒绝 | 移除 manifest 权限（如 `scene.camera`）后相关 API 调用返回 `game_permission_denied`，游戏降级可用或显式失败 |
| MG-AC08 | storage 迁移 | 旧 `flight-profile:v1`/`mecha-*` stateKeys 数据在新存储可读；兼容期后旧键删除 |
| MG-AC09 | 打包环境（PR-09） | 无全局 Node、无源码目录：构建/预览/安装/运行通过；bundle 内 build 与 `builtin-games.json` 一致 |
| MG-AC10 | Studio 不回归 | creator-studio 构建与现有预检/快照功能通过；无 agent-city 相对路径源码 import |
| MG-AC11 | mecha 远程边界 | 远程对战功能行为与迁移前一致且仍走宿主 `mecha:v4` 通道；未出现游戏包直连远程 |
| MG-AC12 | 数据面不变 | 无遥测、无后台网络新增；预置安装不改变 MCP/export 权限 |

## 13. 迁移要求与风险

- **R1 mecha 远程对战**：`mecha:v4` remote session（bootstrap/join/freeze + 中转边界）是宿主 remote capability，AGENTS.md 第 7 条的远程例外以 City 内置 mecha 为前提。外置口子需单独 RFC 明确：游戏包如何经 manifest 声明远程会话、信任档要求、字段允许清单。PR-05 期间远程对战保持宿主内实现，`RemoteMatchClient/remoteRequest/SequentialRemoteControls` 的迁移方式随该 RFC 决定。
- **R2 行为等价**：flight/driving 与引擎共享渲染时序与帧钩子；迁移后经 port 注入可能引入一帧内的调度顺序差异。等价基线必须覆盖帧序敏感断言（相机 pose 序列、碰撞命中序），不只比较终态。
- **R3 creator-studio**：`cityPlanPreflight/contentSnapshot` 依赖 engine 函数（非类型）。PR-02 必须先完成共享函数下沉，否则 PR-03 会打断 Studio；`CITY_GENERATOR_VERSION` 等版本常量随包语义归属引擎侧包。
- **R4 资产预算**：mecha sealed build 超 5MB 预览上限。方案二选一并在 PR-05 定案：上调 `game_preview_too_large` 预算（区分预览与安装上限），或 GLB 改为安装后按需资产（manifest 声明、运行时有界读取）。
- **R5 stateKeys 兼容**：`flight-profile:v1`、`mecha-replays:v1`、`mecha-replay-library:v1`、`mecha-checkpoint:v1` 是玩家数据；迁移必须先做一次性搬运并验证，再删键。禁止静默丢档。
- **R6 双轨期**：PR-04~07 期间同一活动可能同时存在闭包入口与已迁移包。开关（如 `builtin-games.json` 中 per-game `migrated: true`）决定入口来源；双轨期结束删除闭包。禁止双入口并存上线。
- **R7 在途不一致**：当前工作区 `CodeGamePreviewPanel.tsx:76-77` 的 `source` 键未被宿主 dispatch（`creator_projects.rs:1382`）放行，带 source 请求会 `creator_request_invalid`。本 spec 的 PR 序列不依赖它，但建议在 PR-02 一并修复或回退，避免与 §8.3 的入口改造叠加混淆。
- **R8 主题内容边界**：Miami 世界主题数据外置须遵守 `CITY_VICE_THEME_SPEC.md` 的原创性边界（不复制 GTA 标识/字体/地图/人物/招牌/载具外观）；主题数据作为通用 skin pack 的一个官方条目，不进入引擎常量。
- **R9 引擎平台包边界**：`packages/city-engine` 是新增包缝——`cityTextures/cityFlora` 拆为"加载器（引擎包）+ 资产（city 仓 skin pack）"；`generate-city-generator-identity` 预构建钩子随引擎包走；应用壳 dist 内嵌引擎代码，`builtin-city.json` 的 dist digest 语义不变（引擎升级 → digest 更新 → 单行配置 PR）。引擎渲染/世界生成功能的迭代多一道"主仓发版 → city 仓 pin 升级"环节，可接受：引擎变更频率远低于内容，且恰是需要平台级评审的变更。

## 14. 迁移要求汇总

- 四个游戏包是**内容**：除 `builtin-games.json`（ID + pinned build + digest 白名单）外，宿主与平台包不出现任何游戏名。
- 一切新能力走通用口子 + 权限门；"官方"不等于"特权 API"。
- 每个迁移 PR 以 GR-04 等价基线为验收，不以人工目测替代。
- 拆仓（`agent-city-games`）在 PR-08 执行；PR-01~07 全部在主仓以包形态完成，保证可回退（**时序修订见优先级 spec**：拆仓整体前移至阶段 B）。
- 本 spec 不放宽 MCP、导出、远程 City、Actor 数据权限；预置安装行为遵循 `CITY_CODE_GAME_PREVIEW_ISOLATION_SPEC_2026-11-19.md` 的 Installation 模型。
