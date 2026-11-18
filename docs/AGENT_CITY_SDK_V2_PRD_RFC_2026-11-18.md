# Oh Agent City SDK v2 — 产品需求与技术设计（PRD + RFC）

> 日期：2026-11-18
> 文档修订：**v2.5（2026-11-18，对齐 Shared Contracts RFC v1）**
> 状态：**产品与实施 RFC；公共契约由 Shared Contracts v1 冻结，本文件不另起或静默修改公共契约，不代表已经实现**
> 审查分支：Oh-Agent-AI/oh-agent 的 dev（静态源码审查；未在本次环境执行 CI / Studio）
> 新公开包名：**@oh-agent/city-sdk**
> 旧包名：@agent-vitals/city-sdk（迁移期兼容，禁止双份核心实现）
> 配套文档：docs/AGENT_CITY_GAME_SDK_V2_PRD_RFC_2026-11-18.md
> 公共契约：docs/OH_AGENT_CITY_SHARED_CONTRACTS_RFC_V1_2026-11-18.md
> 修订依据：docs/CODE_GAME_V2_PRD_GAP_ANALYSIS_2026-11-18.md（同基线静态审查）
> 核心示例：Codex 创建海底 City、切换像素 3D；真实时钟驱动居民日程，并在 City 中唤醒 Codex 角色会话

---

## 0. 执行摘要与决策

**City SDK 的使命不是在 npm 包里实现完整 Three.js 引擎，而是定义可编程城市的公开协议、校验工具、生成器开发契约、版本化场景快照和编辑事务。**

Agent 使用标准 TypeScript 工程创建城市；City Runtime 运行受信任的生成器、维护共享世界、渲染场景；Studio 连接真实 City 进行编辑、检查与截图；City Game SDK 在同一世界契约上提供玩法运行时。

决定如下：

1. 品牌命名统一为 **@oh-agent/city-sdk**、**@oh-agent/city-game-sdk**。重命名既有 City SDK 实现而非复制整个包。必要时提供 @agent-vitals/city-sdk 的薄兼容包。
2. **City World、Theme、Render Profile、City Instance 和 Game** 是五种不同对象，不把海底城市等价于换肤，不把像素风格等价于修改地形。
3. **City SDK 与 Game SDK 继续物理分包**；Game SDK 单向依赖 City SDK 的只读世界 DTO、City Capability 和版本协议。Game Permission 由 Game SDK 定义，不允许循环依赖或继续把 Capability 与 Permission 当作同义字符串。
4. **City as Code**：Codex 能创建独立的 world/generator.ts、主题/渲染配置和测试；City SDK 提供类型、验证、打包工具；真正执行生成器的是受信任的 City Builder / Runtime。
5. **Studio 是真实 City 运行和调试环境**，而非必须内置完整代码编辑器。Codex 可以在本地任意 IDE/CLI 修改代码，Studio 通过 MCP 观察构建作业、运行画面、选中对象和诊断。
6. P0 首先支持本地可信代码、生成器注册与海底主题、像素 3D Render Profile；第三方任意可执行世界包要等沙箱、权限、签名具备后才开放。
7. 新 Schema 版本明确升级：旧 WorldProfileV1、SkinPackV1、LayoutSnapshotV3 和 ContentPackageV2 必须仍可读取；新协议不在旧字段里偷偷增加不兼容值。
8. **统一 City Interaction Router**：把现有“点击怪兽/机甲进入战棋、点击汽车开始驾驶”的内建触发语义，扩展为可配置的“目标对象 → 触发条件 → 受权动作”契约；兼容旧玩法，不为恋爱或 RPG 单独实现一套点击系统。
9. **City Temporal System**：以真实世界 UTC 时刻为默认时间基准，按 City 时区解释日历，默认 1:1 运行；但将可改变剧情的 Simulation Time 与只读的历史 Replay Cursor 严格隔离。现有 Environment Timeline/Replay 能力优先复用，不新造第二套天空/天气时钟。
10. **Agent Actor Protocol 与 Narrative Engine 分包**：居民可绑定 Codex/Claude Code 等外部或托管 Agent 会话；Story Graph、Canon、Arc、Director 与记忆实现归独立 Narrative Engine，City Runtime 持久化时钟、公共事实与事件调度，Game SDK 只提供受限 Port。外部会话处理真实用户数据前必须另行开放远程数据政策。

### 0.1 v2.5 Shared Contracts 对齐（本次）

1. 公共世界 DTO、Capability/Grant、Revision、时间事务、Registry、Launch 与 Actor Intent 统一引用 Shared Contracts RFC v1；本文保留产品边界、现状证据、实施 Epic 与验收。
2. Generator 明确输出 `WorldPlanV1`，由 World Compiler 生成 Snapshot，不再把作者层 routes 直接当作标准 roads。
3. P0 提前静态 Volume 查询与基础穿越判定，完整 `navigation.volume` 路径规划仍属 P1。
4. 补齐确定性规范化、跨平台摘要、公共/私有摘要域和统一失效矩阵；完整子 DTO 不再由本文以“边界示意”替代。
5. GameTypeRegistry 与 InstalledGameRegistry 分层，InteractionRouter 只消费统一安装读模型。

### 0.2 v2.4 契约修订与冻结（历史）

> 与 Game 文档共用同一份 V2 冻结契约。冻结不代表功能已交付；远程 Actor 的真实用户数据传输仍需独立产品决策与仓库数据政策改写。

| # | 冻结决定 | 影响 |
|---|---|---|
| 1 | City Capability 与 Game Permission 分离，机器类型按依赖方向各有一个来源 | §4.4、C-26 |
| 2 | `@oh-agent/city-sdk/runtime` 在迁移期保留为 legacy export | §3、P0-01、C-28 |
| 3 | Generator Authoring Ref 与 Resolved Identity 分离，WorldDefinition/Snapshot 固定 version + codeDigest | §4.1～§4.3、C-29 |
| 4 | Narrative Engine 独立；City Runtime 只拥有时钟、Scheduler 与权威事件 | §2.2、§4.5 |
| 5 | 环境拆成语义/视觉/天气/时钟 Revision，Place/Resident 进入公开快照与 Run 绑定 | §4.1～§4.5、C-30 |
| 6 | 离线策略收敛为 City `pause/advance` + Rule `skip/reschedule/expire/persist` | §4.5、C-23 |
| 7 | Actor Intent 类型和记忆作用域与 Game 完全一致；远程真实数据默认禁止 | §5.4、C-31 |
| 8 | 时间快进和 Actor 模拟只保留 City MCP，任务进度使用统一 `CreatorTaskEventV1` | §8.2、§8.3 |
| 9 | Game Manifest entries 先于 Interaction Router，采用联合依赖图 | §11 |

### 0.3 v2.3 修订（历史）

> 基线 `dev@1373b496`。与 Game 文档同一批修订：把两份文档的契约对齐，并把代码里已存在、本文档未提的对象补进来。

| # | 改动 | 依据 |
|---|---|---|
| 1 | §1 补 4 类已存在对象/包：`MiniGamePackV1`、`GameTypeDescriptorV1`、`VehicleProfileV1`、`@agent-vitals/city-game-runtime`；并补 `creator_code_*`（14 个工具） | `packages/agent-vitals-city-sdk/src/{content,gameTypes,vehicleProfile}.ts`；`packages/agent-vitals-city-game-runtime/`；`crates/agent-vitals-mcp/src/mcp/creator_code*.rs` |
| 2 | §2.1.1 新增"与既有内容对象的关系"与收敛决定 | 两套游戏抽象并存（Game 文档 §2 亦引用该决定） |
| 3 | §3 目录补 `interaction/`、`temporal/`、`actors/` | v2.1/v2.2 新增域原先不在布局里 |
| 4 | §4.4 换成与 Game 文档 §4.0 **同一张**能力/权限表，并补 `CityEnvironmentV1` / `CityRenderProfileRefV1` | 消除两份文档的 DTO/词表冲突 |
| 5 | §9.3 诊断码标注"未落地"并给出与 `game_*` 的归属划分 | 代码里只有 `game_*` |
| 6 | §11 增加 P0-00（四条前置），并写明 P0-02/P0-05 先于 Game 文档 G-01 | 依赖倒置 |
| 7 | §10 新增 C-26/C-27（词表单一来源、构建/快照绑定） | 对应验收 |

### 0.4 P0 最小成功定义

用户说：“创建一个海底水世界，有海沟、珊瑚礁、12 座穹顶建筑和透明隧道；把画风改成像素 3D。”

Codex 在城市工程内编写或选择受信任的生成器 → 类型检查 → City SDK 校验 WorldPlan → World Compiler 生成确定性 WorldSnapshot（含静态水体 Volume）→ Studio 装载真实 City → Agent 截图分析 → 调整隧道/建筑/渲染参数 → 提交新修订。**仅更换像素 Render Profile 时，不重新生成道路或改变游戏世界版本；P0 不要求完整三维寻路。**

---

## 1. 当前 dev 代码审查

审查依据为 `dev@1373b496`（2026-11-18 18:23）的源文件；以下“已实现”只说明存在对应代码路径，不表示真实运行回归已通过。

| 代码证据 | 当前事实 | 对 v2 的影响 |
|---|---|---|
| packages/agent-vitals-city-sdk/package.json | 现包名 @agent-vitals/city-sdk，版本 0.1.0，公开根入口与 /runtime；内置 oh-agent-sdk CLI | 原位演进并安排 npm 名称迁移 |
| src/types.ts | CityGeographyGeneratorV1 仅 coastal-islands-v1 / arid-dunes-v1；biome 仅 tropical/arid；visuals.themeId 仅 miami/desert | 必须新增 V2 的可扩展 ID、环境和引用，而非改动 V1 联合类型 |
| src/validate.ts | validateCityWorldProfile 和 validateCitySkinPack 显式枚举当前两个生成器与主题，严格拒绝额外字段 | 需要新增 V2 Validator，保留 V1 Validator 语义 |
| src/worldParameters.ts、src/creatorCapabilities.ts | 以能力参数目录描述生成器，只有沙漠/海岸；构建期生成 assets/creator/worlds.json | 可复用能力目录和单一来源，但需加入插件型生成器描述符 |
| src/worldPlanPatch.ts | 道路 add/drop/move/restyle、地块 move/remove、局部 terrain pad/ramp 的有界结构校验；没有真实几何成功担保 | 需要生成后的语义校验、冲突检测与可视差异 |
| src/types.ts 中 CityLayoutSnapshotV3 | 快照记录 City ID/revision、worldRevision、seed、锚点与引用的几何，但不完整序列化地形/全部建筑 | 新增可移植 WorldSnapshot，保留 V3 适配 |
| src/types.ts 中 CitySkinPackV1 | renderContract 固定为 city-render-v1，只有主题，没有独立 Render Profile | 新增 ThemePackV2 + RenderProfileV1 |
| bin/oh-agent-sdk.mjs | 已有 init city-world、init city-project、validate-world、pack-world、verify-world，world 包是 unsigned development artifact | CLI 需增加生成器构建/无头预览与可验证的真实世界构建 |
| apps/agent-city/ui/src/engine/CityEngine.ts | Three.js WebGLRenderer、EffectComposer、GTAO、UnrealBloom、质量等级和硬编码 Creator Skin | 引入宿主 RenderPipeline/RenderProfile Adapter；避免所有新画风进入 CityEngine 条件分支 |
| crates/agent-vitals-mcp/src/mcp/creator_studio.rs | create / create_from_world / world.set preview / patch preview / commit / view / capture 等工具已存在 | 复用 City 编辑与修订机制，新增 Build/Attach/Visual Profile 工作流 |
| apps/creator-studio/ui/src/projectSourceExport.ts | 可导出 JSON 城市项目，明确不是可安装运行时包，也不是可执行生成器项目 | 新增真正的代码型 City Workspace 及其构建产物 |
| apps/agent-city/ui/src/engine/CityEngine.ts：addEncounterTarget / handleClick / playableAt | 已有 3D raycast 点击目标、对象回调、play:mecha 等可玩对象和 onPlay 入口；目前偏向内部 Three 对象与固定玩法 | 提取稳定对象 ID 的交互解析层，保留既有怪兽/机甲/驾驶点击行为 |
| CityEngine.ts：cursorMs、setTimeCursor、updateScene | 时间游标 null=live，支持按速度回放；真实 City 场景随历史 Session 数据重现 | 已有的是 Session 回放游标，并非可以直接提交游戏事件的权威模拟时钟 |
| CityExperience.tsx：city-timeline / seek / replay / live | 可见的“时间回放”滑块、播放/暂停、速度 600/3600/14400 | Studio 可复用时间预览 UX，但必须隔离真实剧情状态 |
| engine/environment/CityEnvironment.ts：sample() | 统一环境时间样本带 timestampMs、hour、weather、timeZone；实时采样来自 Date.now，回放采样来自 cursorMs | CityTemporalState 应共享环境所用时刻，不应复制第二份天气/昼夜逻辑；当前默认 host-local 时区要升级为 City 明确时区 |
| packages/city-game-sdk/src/api/types.ts：ClockAPIV1 | fixedDtSeconds + nowMs()，后者明确仅用于诊断 | 游戏尚无统一日历、约会调度、离线补触发 API |
| packages/agent-vitals-city-sdk/src/gameTypes.ts | `GameTypeDescriptorV1`（slots/parameters/assetRoles/runtime 契约）+ 严格校验 | 它已经是“可注册游戏类型”的词表；v2 不应另起一套 |
| packages/agent-vitals-city-sdk/src/content.ts、runtime.ts | `MiniGamePackV1`、`compileRules`/`createRun`/`runHeadless` | 声明式小游戏内容 + 规则级无头运行时；与 code-game 是两种内容 |
| packages/agent-vitals-city-sdk/src/vehicleProfile.ts | `VehicleProfileV1` + 4 个预设（物理/相机/性能推导） | 载具参数已版本化；Theme/RenderProfile 不要重复造 |
| packages/agent-vitals-city-game-runtime/ | `GameRuntimeV1` 契约 + `GameRuntimeRegistryV1` + scene/input/audio/clock/activity ports + Miami 四活动 catalog（descriptors only） | 运行时注册表已存在；app 侧 adapter 未接，本文档此前未提 |
| crates/agent-vitals-mcp/src/mcp/creator_code*.rs | 14 个 `creator_code_*` 工具（项目/工作区/文件/build/test/preview/status/publish/install） | Code Game 的 MCP 面已落地；但构建器依赖开发机（Game 文档 §2.1.1） |

明确边界：

- creator_city_create 仅创建独立保存的 City 草稿，不能据此声称已有完整独立 City Runtime。
- creator_city_create_from_world 能绑定已安装 city-world 的精确摘要，但不能据此声称生成器代码可以作为包执行。
- creator_city_edit_preview 的 world.set 只使用当前目录中的生成器参数，style.set 未登记且会被拒绝。
- 现有 WorldPlanPatch 明确拒绝可移植包中的私有 Session Building ID 与位置修改；未来绝不可把 Agent 会话数据偷偷塞进公开 City 包。
- CityEngine 的质量等级是性能策略，不等于美术风格；像素风不能单靠调低 devicePixelRatio 实现。

- `creator_city_create` 仍不能替代独立 City Runtime：错误码 `creator_independent_city_runtime_unavailable` 明确拒绝“在活跃 legacy City 之外挑选独立运行时”。
- `creator_code_*` 的存在不改变“City SDK 不执行代码”的边界：构建与运行都在 Host 侧，SDK 只给类型与校验。

源码入口：

- [City SDK types](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/packages/agent-vitals-city-sdk/src/types.ts)
- [City SDK validators](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/packages/agent-vitals-city-sdk/src/validate.ts)
- [World parameter catalog](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/packages/agent-vitals-city-sdk/src/worldParameters.ts)
- [World patch validator](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/packages/agent-vitals-city-sdk/src/worldPlanPatch.ts)
- [CityEngine](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/apps/agent-city/ui/src/engine/CityEngine.ts)
- [Creator MCP](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/crates/agent-vitals-mcp/src/mcp/creator_studio.rs)

---

## 2. SDK 产品模型

### 2.1 六种对象

| 对象 | 定义 | 可复用方式 | 修改影响 |
|---|---|---|---|
| World Generator | seed + params → terrain/roads/sites/anchors 的确定性代码 | 多座城市复用一种生成算法 | 改变世界几何，触发新 worldRevision |
| World/City Instance | 某个 seed、Generator 版本、Patch、资产引用形成的具体城市 | 保存/分享/安装 | cityRevision 单调增加 |
| City Theme | 建筑样式、纹理、植被、材料、天空/水下装饰 | 同世界可切换多个主题 | appearanceRevision 更新 |
| Render Profile | 写实、Toon、Pixel 3D 的渲染技术参数 | 跨主题复用 | renderRevision 更新；不改道路 |
| City Game | 在指定世界能力上运行的独立 TS/JS 玩法 | 跨 City 安装，按能力适配 | Game Run 有独立生命周期 |
| City Interaction | 目标对象、触发条件和受权行为的声明 | 跨 City 复用同一游戏入口 | 修改 interactionRevision，不必重建地形 |

海底主题不是 Render Profile。海底建筑的规则属于 Generator/Theme；水下雾效是 Theme 声明的环境语义 + Renderer 的执行；像素化 3D 是 Render Profile。

City Temporal State 和 Agent Actor Binding 是共享 Runtime 服务的公开契约，**不额外复制成可移植地形/建筑对象**；角色公开人设可进入 City Content，玩家私有故事经历和活跃会话令牌不可导出。

#### 2.1.1 与既有内容对象的关系（v2.3 新增）

“六种对象”是产品模型，不是当前代码的全部对象。以下对象已经存在，v2 必须把它们纳入同一个收敛方向，而不是再造一套：

| 既有对象 | 位置 | 在模型里的角色 |
|---|---|---|
| `MiniGamePackV1` | `city-sdk/src/content.ts` | 声明式小游戏内容（规则、槽位、资产引用），**不是可执行代码** |
| `GameTypeDescriptorV1` | `city-sdk/src/gameTypes.ts` | “可注册游戏类型”的词表：type → runtime 契约版本 + slots/parameters/assetRoles |
| `CityGameMountV1` | `city-sdk/src/validate.ts` | 把某个 pack 绑到某个 layout 的挂载记录 |
| `VehicleProfileV1` | `city-sdk/src/vehicleProfile.ts` | 载具物理/相机/性能的版本化预设 |
| `GameRuntimeV1` + `GameRuntimeRegistryV1` | `packages/agent-vitals-city-game-runtime/` | 可信运行时契约 + 注册表；content 不能提供代码 |
| `CodeGameManifestV1` + `defineGame` | `packages/city-game-sdk/` | 代码游戏：manifest + bundle 入口 + Host |

**收敛决定（v2.5 对齐 Shared）**：`MiniGamePackV1` 保持纯声明式内容；`CodeGameManifestV1/V2` 是代码内容；`GameTypeDescriptorV1` 继续做 GameTypeRegistry 的类型词表；具体安装实例统一进入 Shared Contracts §6.1 的 InstalledGameRegistry，`agent-vitals-city-game-runtime` 作为 legacy adapter 长期并入 Game SDK `/host`。InteractionRouter 只消费统一 InstalledGame 读模型。**不新建第四套游戏包，也不把 Narrative Engine 并入任一 SDK。** Game 文档 §2 引用同一决定；后续方向变化必须进入 Shared Contracts 新版本并同步修改 Manifest。

### 2.2 分层关系

~~~text
Codex / IDE
  ├─ city project: world/generator.ts + city.world.json + theme + render-profile
  └─ game project: games/*/src/index.ts
         ↓
@oh-agent/city-sdk (纯协议、作者 API、验证、测试)
         ↓
City Builder（受信任执行生成器、固化 WorldBuild）
         ↓
City Runtime（唯一共享世界 + Theme/Render Adapter + Clock/Scheduler）
         ↑                 ↔ Narrative Engine（Graph/Canon/Director/Memory）
Creator Studio MCP / Studio Viewer（构建、挂载、修改、截图、诊断）
         ↑
@oh-agent/city-game-sdk（只读世界 + Run-owned 实体/输入/玩法 + Narrative Ports）
~~~

**不可逆依赖约束**：City SDK 不 import Game SDK、Three、React、Tauri、Node 文件系统；Game SDK 的公开层不 import CityEngine 或 Three。执行器和宿主层承载特权功能。InteractionDescriptor 中只引用 gameId、placeId 或 residentId，不 import 具体游戏代码。

---

## 3. 包布局与命名迁移

目标包名：

~~~json
{
  "name": "@oh-agent/city-sdk",
  "version": "0.2.0",
  "exports": {
    ".": "./dist/index.js",
    "./contracts": "./dist/contracts.js",
    "./authoring": "./dist/authoring.js",
    "./testing": "./dist/testing.js",
    "./legacy": "./dist/legacy.js",
    "./runtime": "./dist/runtime.js"
  }
}
~~~

上述为目标 exports 示意；实际需同步输出 types 条件、ESM 入口与打包检查。`./runtime` 是现有公开入口的迁移期 legacy 映射，必须保留到消费者完成迁移并经独立弃用决策移除，不得在改名时静默删除。**0.2.0 为规划版本，不是已发布版本。**

推荐保留现有 packages/agent-vitals-city-sdk 源码目录完成第一次迁移，先替换 package.json 的 name、所有工作区 file:/import 映射和 lockfile；不同时进行大规模目录移动。只有外部仍依赖旧 npm 名时，另建极薄 @agent-vitals/city-sdk 兼容转发包并标记 deprecated；兼容包只 re-export，不复制验证或运行时。

迁移验收：原有 City World/MiniGame/Experience V1 的字节归一化、验证结果、CLI legacy 命令与现有 City UI 均不能回归。

建议内部目录：

~~~text
packages/agent-vitals-city-sdk/
  src/
    contracts/          # DTO + schema/version + error codes
    authoring/           # defineCityWorld / defineWorldGenerator 类型
    world/               # generator manifest、capabilities、world snapshot
    scene/               # typed layout、roads、sites、anchors、volumes
    appearance/          # ThemePackV2 + RenderProfileV1
    editing/             # patch validation、scope、CAS 事务类型
    interaction/         # CityInteractionDescriptorV1 + TargetRef + Router 的类型与校验（v2.1）
    temporal/            # CityTemporalSnapshotV1 / Policy + Story Rule 类型（v2.2）
    actors/              # CityAgentActorBindingV1 + Canon 引用（v2.2）
    packaging/           # content manifest、摘要、source/byte limits
    testing/             # fixtures、determinism/snapshot assertions
    legacy/              # V1/V2 向后兼容入口
  bin/oh-agent-sdk.mjs
~~~

现有顶层 src/types.ts、validate.ts、runtime.ts 可渐进提取，不要求一条 PR 内全部搬动。

---

## 4. 新增版本化公开协议

### 4.1 WorldDefinitionV2（数据声明）

~~~ts
// 目标类型；当前 dev 不存在
export interface CityGeneratorAuthoringRefV1 {
  id: string;
  contractVersion: 1;
  requestedVersion?: string;       // 仅源码工作区可省略，由 Builder 解析
  parameters: Readonly<Record<string, number | string | boolean>>;
}

// CityResolvedGeneratorIdentityV1 由 Shared Contracts §2.4 定义并从此处导入
import type { CityResolvedGeneratorIdentityV1 } from "@oh-agent/city-sdk/contracts";

export interface CityWorldDefinitionV2 {
  schemaVersion: 2;
  kind: "city-world";
  id: string;
  version: string;
  generator: CityResolvedGeneratorIdentityV1 & {
    parameters: Readonly<Record<string, number | string | boolean>>;
  };
  coordinateSystem: "city-local-m-v1";
  environment: {
    medium: "air" | "water" | "vacuum" | "mixed";
    biome: string;
    parameters?: Readonly<Record<string, number | string | boolean>>;
  };
  theme: { id: string; version: string; digest: string };
  renderProfile: { id: string; version: string; digest: string };
  requiredRuntimeCapabilities: readonly string[];
}
~~~

源码工作区使用 `CityGeneratorAuthoringRefV1`；Builder 解析 Registry 后生成只含已解析身份的 `CityWorldDefinitionV2`。发布、安装、迁移与重放不得继续使用省略 version/codeDigest 的 Authoring Ref。

CityInstanceV2 持有 seed、cityId、cityRevision、当前 definition 的精确 digest、实际 worldRevision、environmentRevision、weatherRevision、placeRevision、residentRevision、interactionRevision、appearanceRevision、renderRevision 与可选 Patch 引用。**seed 不应同时放在 Generator 定义里冒充实例身份**。

版本规则：

- worldRevision 绑定可观测的静态几何/拓扑；Generator、seed、地形或道路变动都会改变。
- appearanceRevision 绑定 Theme/材质/灯光等内容，不改变道路拓扑。
- renderRevision 绑定像素/写实等渲染参数，不改变世界拓扑。
- environmentRevision 绑定 medium、深度等语义环境；影响可通行性或导航时还必须更新 worldRevision。视觉雾色归 appearanceRevision，动态天气归 weatherRevision，时钟归 clockRevision。
- placeRevision / residentRevision 分别绑定公开 Place、Resident 定义；玩家私人关系不进入这些 Revision 或公共快照。
- interactionRevision 绑定城市对象到交互行为的映射；只改点击动作不改变 worldRevision。
- cityRevision 是所有持久变更的 CAS 序号，与上述子版本不同。
- 修改纯视觉配置不应迫使 Code Game 失去世界租约；修改道路/锚点应终止或重绑定依赖这些对象的 Game Run。

### 4.2 WorldGeneratorV1（Codex 可以编写的代码）

~~~ts
// 新的 authoring API 目标：SDK 只给类型/定义函数，执行在受信任 Builder
import { defineWorldGenerator, type WorldPlanV1 } from "@oh-agent/city-sdk/authoring";

export default defineWorldGenerator({
  id: "undersea-basin-v1",
  contractVersion: 1,
  generate(ctx) {
    // ctx.seed + ctx.random 决定性生成，不能使用 Date / Math.random
    const terrain = ctx.terrain.heightField({ biome: "underwater", scale: 260 });
    const sites = ctx.layout.placeSites({
      terrain,
      count: 12,
      maxSlopeDeg: 15,
      type: "dome"
    });
    const routes = ctx.layout.connectSites(sites, { mode: "tunnel" });
    const objects = ctx.layout.instantiateSites(sites, { type: "dome" });
    const anchors = ctx.layout.defaultAnchors(sites, { include: ["submarine-spawn"] });
    const volumes = ctx.volumes.forMedium({ medium: "water", terrain });
    return {
      schemaVersion: 1,
      terrain,
      sites,
      routes,
      objects,
      anchors,
      volumes,
      places: [],
      residents: []
    } satisfies WorldPlanV1;
  }
});
~~~

此示例展示**开发体验**，其中 ctx.terrain/layout/volumes helpers 仍需实现，当前不能直接运行。Generator 只产出 Shared Contracts §2.4 的 `WorldPlanV1`；World Compiler 将 routes 编译为标准 roads，校验 Site/Object/Anchor/Volume 引用并生成 Snapshot。P0 可先提供最小受信任 TS Generator、Compiler 及确定性测试，再逐步通用化 helpers。

执行规则：

1. 受信任 Generator Registry 按 id + version + digest 选择代码，禁止静默回退到别的生成器。
2. 输入、输出采用有限 JSON/TypedArray/资产引用，不把 THREE.Object3D 写入公共 SDK 协议。
3. 同一版本的 codeDigest + seed + params + assetsDigest 必须得到相同 WorldSnapshotDigest。
4. 生成器只能操作其 WorldBuild，不直接写全局 City、User Session Buildings、磁盘或网络。
5. 不兼容参数和越预算时拒绝，给出稳定的诊断码、源文件位置及目标实体 ID。
6. 外来社区代码生成器需要独立安全执行环境；P0 不允许不可信 TS 进入特权 WebView。

### 4.3 CityWorldSnapshotV4

现有 LayoutSnapshotV3 以锚点为中心，不是完整可移植三维世界。V4 的完整 TypeScript + JSON Schema、空间子 DTO、Header、稳定 ID 和摘要覆盖域以 **Shared Contracts RFC v1 §2** 为唯一权威，本文不再复制声明。

实施必须遵守以下边界：Generator 输出 `WorldPlanV1`，Compiler 输出 Snapshot；完整 Snapshot 只用于 Builder、导入导出和 Headless Fixture，Game 使用 `CityWorldHeaderV1 + WorldQueryV1 + WorldAssetV1`。`worldRevision` 是静态空间内容摘要，`snapshotDigest` 是完整公开可移植内容摘要，`cityRevision` 是公共 CAS 序号，三者不得互相替代。Snapshot 中的 Place/Resident 只含公开定义，玩家关系、私密对话和活跃 Actor Session 不进入摘要或世界包。

### 4.4 导航与环境能力

**City Capability 的机器来源是本包 `@oh-agent/city-sdk/contracts`；Game Permission 的机器来源是 Game SDK。** Capability/Permission/Grant 三轴、映射、V1 兼容规则与阶段以 **Shared Contracts RFC v1 §3** 为唯一权威，本节只列 City 侧摘要，不维护第二套权限定义。

| WorldCapabilityV2 | 含义 | 主要 Revision |
|---|---|---|
| `world.snapshot` / `roads.graph` / `terrain.heightfield` | 快照、路网、地形 | worldRevision + snapshotDigest |
| `environment.parameters` / `sites.indexed` / `objects.indexed` | 语义环境、地块、对象 | environment/world/weather/clock Revision 按字段绑定 |
| `volumes.indexed` / `navigation.surface` / `navigation.volume` | 体积与二维/三维导航 | worldRevision；导航另受 environmentRevision 约束 |
| `appearance.profiles` | Theme/Render Profile 能力 | appearanceRevision + renderRevision |
| `time.simulation` | 权威 Simulation Clock | clockRevision |
| `residents.registry` / `places.registry` | 公开居民与地点注册表 | residentRevision / placeRevision |

`CityEnvironmentV1`、`CityRenderProfileRefV1`、`CityAppearanceRefV1` 由 **Shared Contracts RFC v1 §2.7** 冻结，Game 文档 §4.1 从同一 City contracts 入口 import；两包不得各写一份。

海底通行能力用标准化 travel mode（walk、drive、fly、swim、submersible）表达，通过能力发现判断可用性，不扩大旧 `AnchorCapabilityV1` 联合（后者是“活动可以在哪开始”的布局语义，不是权限）。

### 4.5 City Temporal System（v2.2：真实时间基准与回放隔离）

#### 现状与时间域

现有 CityEngine.setTimeCursor() / CityExperience 时间滑块主要回放 Agent Session 的时间戳；CityEnvironment.sample(timestampMs) 已统一向环境渲染提供时刻/小时/天气，当前实时样本取 Date.now，默认按宿主本地时区解释；Game SDK 的 ClockAPIV1 仅有固定步和诊断时刻。**这些代码证明 City 已有时间基础，但尚不构成面向多游戏/NPC 的 Calendar + Scheduler。**

**v2.3 现状（必须写进实现前置）**：当前环境时间只有整数偏移 `utcOffsetMinutes` + `host-local | fixed-offset` 两种策略（`apps/agent-city/ui/src/engine/environment/CityEnvironment.ts:11,25`），**没有 IANA 时区、没有 DST 规则、没有 `clockRevision`**；采样点是 `Date.now()` 与回放游标（`CityEngine.ts:203,2361`）。因此 §4.5 的 `CityTemporalSnapshotV1` 是目标，不是现状描述；迁移时必须保持旧 City 的日夜/天气外观不静默变化。

| 时间域 | 默认时刻与用途 | 是否能提交剧情 |
|---|---|---|
| Wall UTC Time | 可信宿主或服务端实际 UTC 时间，作为 1:1 基准 | 只用于计算 Simulation Time；不能直接触发无校验的游戏动作 |
| City Simulation Time | 默认从真实 UTC 1:1 推进，以 City IANA timeZoneId 解释日历；暂停/加速仅走受控策略 | **唯一能驱动居民日程、任务、剧情的权威时间域** |
| Replay Cursor | 历史 Agent Session 的浏览指针，null 表示追随实时；可任意拖动 | **绝不自动触发故事、交易、奖励或 NPC 记忆写入** |
| Game Fixed Step | 独立于渲染帧率的固定模拟 dt | 只能决定局内物理/胜负，不自行解释真实日历 |
| Cinematic Time | 导出镜头所需的确定性光照/动画相位 | 仅画面表现，不是世界事件来源 |

`CityTemporalSnapshotV1` 与 `CityTemporalPolicyV1` 的冻结声明见 **Shared Contracts RFC v1 §5.1**，由 `@oh-agent/city-sdk/contracts` 同源导出；当前 dev 尚未发布这些类型。

City 创建时明确 timeZoneId；内部存储 UTC 时间戳而不是未带时区的本地字符串。生产共享城市由服务端/权威宿主负责时间锚点与推进；本地 City 则持久化锚点。将当前 host-local 环境时区迁移到 City 时区需要保持旧 City 的外观兼容默认，不得静默改变已有日夜与天气结果。

真实运行的目标关系：simulationUtcMs = anchorSimulationUtcMs + (nowWallUtcMs - anchorWallUtcMs) × timeScale；暂停时冻结 Simulation Time，Resume 恢复锚点。游戏只读该结果，不得直接修改时钟；调时由可信 Creator 控制，并记录 clockRevision / operationId。

**快进调试必须在隔离的 Preview Clock 和 Story State Fork 中执行**；不得因 Studio 把时间跳到三天后就真正失约、改变好感度或发放奖励。历史回放仍只回放过去，不与快进的故事预览共用写入通道。

#### 唯一时间来源和事件契约

- CityEnvironment 与 City 游戏都观察同一 Simulation Time 样本；仅视觉历史回放可使用 Replay Cursor 进行只读取样。天气、环境日期、NPC 行程和剧情用明确 timeZoneId / UTC 规则对齐。
- City Runtime 提供受控的 time.tick / calendar.hour / calendar.day 事件，不逐渲染帧分发；Scheduler 以持久化 eventId、dueAtUtcMs、lastProcessedTick 去重。
- City 离线策略只有 pause/advance：pause 冻结 Simulation 锚点，不结算离线 occurrence；advance 按真实 UTC 推进，并在 maxCatchUpMs 内有界恢复。Rule 的 missedPolicy 独立决定 skip/reschedule/expire/persist，reschedule 必须有延迟和次数上限，persist 只保存待处理事实，不自动做玩家选择或发奖励。App 关闭期间没有后台 Scheduler。
- 本地系统时间不是可信权威：回拨不得重复事件，异常前跳进入有界恢复并标记 `clock_uncertain`；联机共享剧情由服务端或其他权威时钟仲裁。
- 时钟修订与 World 的道路/地形 worldRevision 分离；只调整演示时钟不得重建 City WorldSnapshot，也不得在无授权下修改玩家真实记录。

Scheduler Record、`processing → committed` 语义、StoryCommitCommand 和 Event/Story/Outbox 原子事务以 **Shared Contracts RFC v1 §5.2～§5.4** 为唯一权威。Actor 在事务外生成，提交前重新读取 Revision；只有原子提交成功才算剧情事实发生。

---

## 5. Theme 和 Render Profile

### 5.1 ThemePackV2

Theme 只描述美术与环境，不直接包含 TypeScript Renderer 的宿主执行权：

~~~json
{
  "schemaVersion": 2,
  "id": "underwater-glass",
  "version": "1.0.0",
  "compatibleBiomes": ["underwater"],
  "assets": {
    "architecture": "sha256:...",
    "coral": "sha256:..."
  },
  "environment": {
    "fogColor": "#062A42",
    "fogDensity": 0.024,
    "caustics": "low",
    "ambientColor": "#4DABC0"
  }
}
~~~

正式 Schema 不接受任意 CSS、Shader 文本或外部网络地址；材质/Shader 插件要有显式声明、能力限制与审查。

### 5.2 RenderProfileV1

~~~ts
export interface RenderProfileV1 {
  schemaVersion: 1;
  id: string;                   // realistic-3d | toon-3d | pixel-3d ...
  backend: "three-webgl";
  pipeline: "standard" | "toon" | "pixelate";
  resolutionScale?: number;
  targetPixelHeight?: number;
  textureFiltering?: "linear" | "nearest";
  paletteId?: string;
  dithering?: boolean;
  postEffects?: readonly string[];
  qualityPolicy?: "respect-host" | "bounded-fixed";
}
~~~

像素海底城市建议 preset：pixel-3d、320×180 逻辑分辨率（16:9 情况）、nearest 放大、受控 16/32 色调色板、可关 Bloom/AO，UI 与文字保持原生分辨率。320×180 是示例基准，不应在任何显示比例下强制拉伸。

**实施位置**：修改 CityEngine.ts 中 renderFrame/EffectComposer 的组织方式，建立 RenderPipelineAdapter（normal、toon、pixel）。重用现有 Renderer、Scene、Camera、Quality 租约；RenderProfile 由 City Runtime 可信实现，City SDK 只提供声明和校验。禁止把任意 Shader 或 WebGLRenderer 实例暴露给 Game SDK。

**切换效果**：

- 保留 City ID、seed、世界几何、road graph、锚点、正在运行的玩法状态。
- 原子切换 Render Pipeline；失败时保留旧 Profile，释放新建 RenderTargets/材质，返回诊断。
- Studio 能做 A/B 同视角截图；视觉回归独立于生成器确定性测试。
- 高 DPI、窗口调整、自适应画质、截图导出和视频采集均必须验证 nearest 采样不会模糊。

### 5.3 City Interaction System（v2.1 新增，必须复用旧游戏触发）

#### 已有代码基础与问题

CityEngine.ts 已经有 addEncounterTarget(object, onClick)、removeEncounterTarget() 和 handleClick() 射线检测；对于可玩对象还存在 playableKind()/playableAt() 和 options.onPlay() 路径。用户当前能够通过点击怪兽进入战棋，这是一个应保留的既有体验。**当前回调的关键通常是 THREE.Object3D 或特定 play:mecha 字符串，不是可导出、可校验的 City SDK 交互契约。**

目标是新增 CityInteractionDescriptorV1（数据）和 CityInteractionRouter（可信 Runtime），而不是再实现一套 NPC 射线检测。

`CityTargetRefV1`、`CityInteractionActionV1`、`CityInteractionDescriptorV1` 由 **Shared Contracts RFC v1 §6.2** 冻结；当前 dev 尚无这些公开类型。Descriptor 只包含声明数据，不包含 JS 回调、URL、Shell 或宿主指令。

目标数据案例：

~~~json
{
  "schemaVersion": 1,
  "id": "interaction:resident-linxia-talk",
  "target": { "kind": "resident", "id": "linxia" },
  "trigger": "click",
  "action": {
    "type": "game.launch",
    "gameId": "city-romance",
    "entry": "linxia-intro",
    "presentation": "overlay"
  }
}
~~~

现有的战棋触发也要通过 Legacy Adapter 注册为 game.launch + exclusive，而不能在迁移时重写现有战斗规则。汽车/飞机同理。Descriptor 只表达用户点击时的意图；**解析、权限判断、Game 兼容检测、Activity Lease 和实际启动全部由可信 Runtime 执行**。

#### Place、Resident 数据契约

`CityPlaceV1`、`CityResidentV1`、公共日程和稳定 ID 的冻结声明见 **Shared Contracts RFC v1 §2.3**。City 内容层只保存公开身份与日程；Runtime 按 City IANA 时区统一解析跨午夜和 DST。

居民公开定义属于 City 内容层，**玩家与居民的私人关系、对话记忆和好感度不属于 WorldPackage**。它们应由 Game SDK 的授权 Storage 保存，按玩家与游戏隔离。不同玩家进入同一城市，不应自动共享私人恋爱剧情状态。

#### Runtime 触发顺序

1. 原 CityEngine 继续负责屏幕点击、射线拾取、遮挡判断，产出稳定 CityTargetRef。
2. InteractionRouter 解析该目标绑定的规则，检查 priority、conditions、权限、城市版本和 Game Manifest。
3. exclusive 动作通过既有 CityActivityCoordinator / Scene Lease 启动游戏；overlay 动作只申请必要 UI/Input Focus Lease，不应默认接管相机。
4. Game 收到经过校验的 LaunchContext：cityId、cityRevision、worldRevision、worldSnapshotDigest、interactionRevision、target、entry、launchId，以及所用能力对应的 environment/weather/place/resident Revision；entry 必须已在 Game Manifest entries 注册，不接触原始 Three 对象或回调函数。
5. 退出时释放各自拥有的租约和临时实体，恢复 City 点击/相机与 HUD。

若当前游戏活动处于独占状态，另一个交互应返回 activity_busy 或进入明确队列，不可同时把输入绑定给两个游戏。旧怪兽→战棋触发链必须拥有“行为一致”回归测试。

#### 安全和版本

- Interaction 绑定修改只更新 interactionRevision 与 cityRevision，不应影响道路/地形 worldRevision。
- 交互动作不得包含任意 JS、动态函数、Shell 命令、URL 导航或不受控 Tauri IPC。
- 目标丢失、模型尚未加载、游戏未安装、游戏能力不匹配时返回稳定诊断，不做隐式降级。
- Runtime 不允许用户绑定一个游戏去删除/写入另一游戏的实体。
- 世界包只包含公共 Place/Resident/Interaction 定义，Session 私有对象和用户关系数据不得导出。

### 5.4 Agent Actor Protocol（v2.2：Codex 会话扮演市民）

目标：一个 CityResidentV1 可与独立 Codex/Claude Code 会话建立身份映射；外部用户也可通过 City MCP 让自己的 Agent 进入城市。不得将 Session Thread 误当作可移植角色本体。

`ActorIntentV1`、`ActorIntentKindV1`、`CityAgentActorBindingV1` 由 **Shared Contracts RFC v1 §7** 冻结。City SDK 只保存公开绑定元信息；凭据、活跃 Thread ID、完整对话和本地目录不进入公共 Schema。

City SDK 定义身份与公共角色属性，**不负责执行 Codex，也不在 Schema 中存 token/完整对话/本地目录或 Shell 权限**。可信 Agent Actor Runtime 管理会话生命周期、工具白名单、预算、睡眠与唤醒；独立 Narrative Engine 实现 Story Graph、Canon、Arc、Director 与记忆；City Runtime 持久化时钟、公共事实与事件；Game SDK 只提供受限 Story/Dialogue/Storage/Actor Port；City MCP 暴露有限观察/意图工具。

**与 Game 文档的接口对齐（v2.3）**：Actor Turn 的请求/响应 DTO 定义在 Game 文档 §4.8（`AgentActorTurnRequestV1` / `AgentActorTurnResponseV1`，含 `storyRevision`、`idempotencyKey`、`auditTraceId`）；本文档只持有 `CityAgentActorBindingV1` 与公共日程，不持有 transcript、Thread id 或凭据。

长期角色一致性采用三层状态：

1. Character Canon（不可由角色自行修改）：身份、性格边界、背景、允许的成长范围、公共剧情事实。
2. Authoritative State（可审计事务）：City 时间、当前位置、计划日程、已发生事件、按 playerId × cityId × gameId × residentId 隔离的私人关系与记忆。
3. Agent Session（可随时重建）：临场对白、情绪、行为提案。每次唤醒注入最新 Canon + 脱敏 Context + Story State；会话压缩/重启不改变 Canon 或剧情事实。

角色输出必须是经 Schema 校验的 Intent Proposal；Runtime 再检查地点、目标、时间、游戏权限及故事状态，成功后提交 Event Log 并向视图广播。Codex app-server 的 thread/start、turn/start、thread/resume 是可用的集成方向；但创建 Thread 不表示 Agent 在用户离线时持续自主思考。**定时唤醒由 City Scheduler 负责，不能把一个常驻 Codex 对话当作 Cron 或时钟来源。**

共享城市并发：同一 NPC 的公共身份/世界位置单一权威；不同玩家的私人剧情使用隔离的对话上下文和关系存储，不能由一个不分玩家的 Session 混合阅读。多人同时要求同一个 NPC 移动时应按权威事件顺序仲裁，而不是允许多个 Session 直接改 Scene。

**远程数据政策门（v2.5 Shared）**：现有仓库远程例外不包含 Actor 模型调用。在另行形成明确产品决策并改写数据政策前，外部/托管 Actor 只能使用合成 Preview 数据，不得接收真实玩家输入、关系记忆、私密剧情摘要或可关联身份。未来例外必须用户主动触发、可撤销，并固定字段白名单、目的地、留存策略和本地降级；City/Game Manifest 或 MCP 能力声明本身不授予远程发送权。

---

## 6. 城市编辑：数据修改与代码修改分开

### 6.1 实例编辑（City Patch）

适用：“将 3 号研究站东移 80 米、重新连接隧道。”

流程：read(cityRevision) → preview(patch) → 运行几何/冲突校验 → Studio 显示差异 → commit(expectedRevision, operationId) → 新 WorldRevision → 相关游戏重新绑定。

目标 PatchOpsV2 需包括：

- road/tunnel add、drop、move、restyle、relink；
- site/building move、rotate、restyle、replace-asset（只允许可移植公共对象）；
- terrain sculpt、pad、ramp、water volume add；
- interaction upsert/remove/rebind（同一预览事务内校验目标 ID 与动作引用）；
- environment.visual-set（雾色等只引发 appearanceRevision）、weather.set（weatherRevision）、theme/render-profile set（appearance/render Revision）；
- environment.semantic-set（medium、深度等更新 environmentRevision；影响通行/导航时同时更新 worldRevision，并停止或迁移受影响 Run）；
- 明确引用对象的稳定 ID、revision、预算、可回退事务 ID。

现有 validateWorldPlanPatch 的 256 KiB 预算和私有 Session Building 排除原则应保留。新增 City Runtime 真实几何预演，不能拿结构性 validate 成功冒充 roads 真的连通。

### 6.2 生成器源代码编辑

适用：“海床坡度大于 15° 的位置永远不能放穹顶建筑。”

Codex 改 generator.ts → Build 新 buildId → 确定性测试 → 对同 seed 生成新 snapshot → Studio diff（建筑 ID 变化、道路变化、不可达数）→ 用户批准迁移已有城市。

绝不把生成器代码更新静默作用于全部已安装城市。已发布城市必须钉住 generator digest，并提供显式迁移/回滚。

### 6.3 修订身份与隐私

- 全部编辑必须做 CAS、operationId 幂等和权限检查。
- 公共世界包绝不包含真实用户 Agent sessions、建筑隐私属性、凭证或私人路径。
- Session Buildings 是安装后再投影到世界上的用户数据层，不属于可复用海底世界包。
- 没有权限时返回拒绝，不自动修改 repo、安装资产或切换其他用户的 City。

---

## 7. 标准 Code-first City 工程与 CLI

~~~text
my-underwater-city/
  city.project.json
  world/
    world.manifest.json
    generator.ts
    params.json
    patches/
    theme/theme.json
    render/pixel-3d.json
    assets/catalog.json
  games/
    submarine-explorer/     # 独立 Game SDK 项目
  tests/
    determinism.test.ts
    topology.test.ts
    rendering.visual.test.ts
  dist/                      # 不可变 WorldBuild
~~~

目标 CLI，**以下是新增要求，不是 dev 已支持的命令**：

~~~bash
oh-agent-sdk city init ./my-underwater-city --template underwater
oh-agent-sdk city validate ./my-underwater-city
oh-agent-sdk city build ./my-underwater-city --seed 42
oh-agent-sdk city test ./my-underwater-city --seed 42
oh-agent-sdk city preview ./my-underwater-city --city my-city
oh-agent-sdk city pack ./my-underwater-city --build-id <immutable-id>
~~~

设计原则：Codex 使用普通文件系统能力编写 TS，不依赖 Studio 做 IDE；City SDK CLI 用于低成本无头验证；真实视觉证据必须由已启动的 Studio/City Runtime 返回。CLI 不得把不存在的独立 City Runtime 伪装成可启动。

### 7.1 WorldBuildV1

构建产物内容：manifest、generator identity/build digest、seed、params、world snapshot、主题/渲染引用、静态模型/纹理摘要、拓扑验证、性能预算、构建诊断。buildId 必须由不可变内容摘要派生。

P0 发布本地可信 source/build；社区下载的可执行 Generator 需要单独的 code-world 包格式、安全环境和安装授权。现有 ContentPackageV2 数据-only 世界包继续按原语义读取；不要静默允许它执行 JS。

---

## 8. Creator Studio 与 Agent Progress Bridge

### 8.1 控制面职责

| 组件 | 做什么 | 不做什么 |
|---|---|---|
| Codex | 创建 City 工程、写 TS、做构建修复、分析截图 | 不需复刻 Studio 3D 编辑器 |
| City SDK CLI | validate/build/test/pack 的开发接口 | 不假装拥有桌面 City |
| Creator MCP | 项目关联、作业启动/查询、预览、对象选中、截图、Patch commit | 不作为任意 Shell 或无限制文件系统 |
| Studio | 真实 City Viewport、画风切换、对象拾取、diff/诊断 | 不决定 Generator 的源码实现 |
| City Runtime | 权威 World、渲染/相机/租约、几何验证 | 不直接执行未知社区 TS |

### 8.2 建议 MCP 扩展

**现状（v2.3）**：目标表中的 16 个工具**都还不存在**；已实现的是另一套命名的 14 个 `creator_code_*`（见 §1），且它们**不绑定 cityId/cityRevision**，没有 capture/inspect/interaction/story/actor。

沿用已有 creator_city_read、creator_city_edit_preview、creator_city_patch_preview、creator_city_edit_commit、creator_city_view/status/capture。补齐：

| 新工具（目标） | 功能 |
|---|---|
| creator_city_workspace_attach | 将授权代码工作区绑定 City 草稿与基线 revision |
| creator_city_code_build | 启动受控 generator build，返回 jobId，不直接返回“成功” |
| creator_city_code_build_status | 返回真实构建进度、BuildId、错误文件/行号 |
| creator_city_build_preview | 将不可变 WorldBuild 挂载到 Studio 预览，标记真实准备状态 |
| creator_city_validate_geometry | 反馈道路连通、建筑碰撞、坡度、生成预算 |
| creator_city_render_profile_preview | 不提交的像素/写实画风对比 |
| creator_city_object_inspect | 返回被选中建筑/道路的稳定 ID、变换、依赖 |
| creator_city_interaction_inspect | 读取对象绑定的交互、优先级、运行方式与版本 |
| creator_city_interaction_preview | 结构校验 + 真实目标可拾取性/游戏兼容性检查；沿用既有 creator_city_edit_commit 提交 |
| creator_city_interaction_simulate | 在 Studio 以真实对象点击流程进行不提交的启动测试 |
| creator_city_clock_inspect | 当前 City Simulation Time、UTC 锚点、IANA 时区、时间倍率、offlinePolicy；明确区别 Replay Cursor |
| creator_city_time_preview | 建立独立 Preview Clock + Story State Fork，受控快进/暂停/定位时间，不改真实玩家记录 |
| creator_city_agent_actor_inspect | 公开角色绑定、可用工具、Character Canon 版本、会话健康与预算；不回传私密 Thread 原文 |
| creator_city_agent_actor_simulate | 在隔离的城市预览里注入事件并唤醒测试会话，返回结构化 Intent Trace |
| creator_city_visual_diff | 同一 CameraPose 下比较两次 build 的截图和布局差异 |
| creator_city_workspace_commit | 按 expectedRevision + operationId 提交授权更新 |

MCP 响应必须区分 queued、running、succeeded、failed、cancelled、preview-ready，不把创建 job 或打开视口当作画面成功。`creator_city_time_preview` 与 `creator_city_agent_actor_simulate` 是时间快进和 Actor 模拟的唯一 MCP 入口；Game Story Inspector 只读取同一 Preview Fork/Trace，不再注册 `creator_game_story_time_preview` 或 `creator_game_actor_turn_simulate`。

### 8.3 Codex 工作进度面板

统一事件 `CreatorTaskEventV1`（与 Game 文档 §6.2 同源）：

~~~ts
type CreatorTaskEventV1 = Readonly<{
  taskId: string;
  workspaceId?: string;
  phase: "planning" | "editing" | "typecheck" | "building" |
         "testing" | "loading" | "playing" | "reviewing" |
         "succeeded" | "failed" | "cancelled";
  sourceRevision?: string;
  buildId?: string;
  cityRevision?: number;
  runId?: string;
  progress?: number;
  diagnosticIds?: readonly string[];
  previewFrameId?: string;
}>;
~~~

Studio 通过文件变更/构建作业/MCP 事件展示可核验进度。Codex 内部推理无需也不应曝光；“编辑完成”“真正预览完成”必须有不同来源和状态。

### 8.4 Creator Studio 的 Interaction Inspector / Story Mode

Studio 选中怪兽、车辆、建筑或 NPC 后显示统一的 Interaction Inspector：对象稳定 ID、Trigger、Action、游戏引用、presentation、条件、优先级、绑定修订；可从此处打开游戏预览或剧情预览。

对于 Story Mode，显示 Resident 资料、Place 关联、Dialogue 入口、游戏状态测试和剧情分支预览，但 Dialogue Graph 的玩法逻辑由 Game SDK/游戏工程持有。**Studio 展示同一套真实 City 交互结果，而不自行维护第二条点击→进入游戏的逻辑。**

若游戏/Story Overlay 只是短对话，City 摄像机和场景保持可见；战棋/飞行保留现有 Exclusive 模式。可视预览证据必须标记 City revision、Interaction revision、Game BuildId 和 RunId。

v2.2 在 Story Mode 增加 **双时间轴**：现有 Agent Session Replay 只读展示历史；Story Preview Clock 可人为跳转下一个日期、星期六 18:00、雨天或失约事件，但必须明确标识“模拟世界”，不向玩家真实世界提交。调试画面同步显示 Simulation UTC、City 时区与本地日历、Preview Fork ID、事件去重 Key、Story State before/after，以及受检 Actor Intent；支持按固定 seed/choice trace 重放。

---

## 9. 质量、安全与兼容性

### 9.1 版本矩阵

| 旧对象 | 处理策略 |
|---|---|
| CityWorldProfileV1 | 保持严格校验和既有默认值；显式升级为 WorldDefinitionV2 |
| CitySkinPackV1 | 只保留 legacy 兼容；映射到 Theme + 默认 realistic-3d Render Profile |
| LayoutSnapshotV2/V3 | 保留读取能力；无法从 V2 伪造缺失的几何；新构建产出 V4 |
| CityWorld ContentPackageV2 | 保持数据-only 和不可执行语义 |
| WorldPlanPatchV1 | 保留结构验证；迁移到 V2 需独立重放/语义校验 |
| 旧 npm 包名 | 引用重写或薄兼容包；避免双重 class/validation 实现 |
| 旧 Miami/Desert 世界 | 固定种子/版本的布局摘要和视觉基线不得漂移 |

### 9.2 必须防护

- 受控 Builder 禁止任意 npm lifecycle、任意 Vite 插件、任意本地路径和未知外部网络。
- 代码生成器、模型资产和 Shader 不是等价的安全对象；分别审计并限制权限/大小/执行成本。
- 生成器不可读取 Agent Session 私有数据；导出拒绝私有建筑映射。
- Renderer 管线自定义默认限制为可信 Adapter + 参数，不接受 UGC 自由注入 WebGL。
- GPU RenderTarget、Composer Pass、纹理、共享 Mesh 的生命周期必须有一次性清理和丢失上下文恢复。
- 输出日志必须有界、可定位、脱敏，不包含完整用户数据或任意物理路径。
- 不得通过历史 Replay Cursor 触发可变更状态的事件；Studio 的时间快进只能操作隔离预览，必须禁止向真实关系数据、奖励和世界经济写入。
- 角色 Agent 无 Shell、任意文件、任意网络与 CityEngine/THREE 的默认访问权限。身份绑定和可调用的 Intent Tool 经 Runtime 授权，角色生成对白不得携带更高权限。
- 真人玩家的私有恋爱记忆与 Agent 会话凭据不得进入世界包、模型 prompt 的未授权上下文、调试公开日志或社区资产。远程 Actor 在 §5.4 政策门前只处理合成 Preview 数据，任何 Manifest/MCP 声明都不构成远程发送授权。

### 9.3 诊断码（v2.3：未落地，含归属划分）

以下 `city_*` 码**当前都未落地**（代码里只有 `game_*`，见 Game 文档 §8.3）。落地时按“产生方抛码”划分：生成器/世界几何/时钟问题由 City 侧抛 `city_*`，游戏运行时问题由 Game 侧抛 `game_*`；消费方只做映射。

| code | 发生阶段 | 归属 | 对应的游戏侧码（若跨域） | 恢复动作 |
|---|---|---|---|---|
| city_generator_not_registered | validate | City | — | 查询 capabilities / 安装可信 generator |
| city_generator_version_mismatch | build | City | game_sdk_version_mismatch（类比） | 固定契约/版本 |
| city_world_nondeterministic | test | City | — | 排除随机、时间与不稳定遍历 |
| city_world_geometry_invalid | preview | City | — | 定位 roads/sites/terrain 对象并修复 |
| city_world_topology_disconnected | test | City | — | 调整道路/隧道连接 |
| city_render_profile_unsupported | preview | City | game_render_profile_incompatible | 回退 realistic-3d 或安装受信任 Renderer Adapter |
| city_render_pipeline_failed | runtime | City | — | 自动恢复上一套 Render Profile |
| city_world_revision_conflict | commit | City | game_world_revision_conflict | 读新基线并重放 Patch |
| city_world_package_untrusted | install | City | game_package_untrusted | 拒绝执行并请求授权 |
| city_time_zone_invalid | validate | City | game_time_domain_invalid | 选有效 IANA 时区；迁移旧 City 需显式确认 |
| city_time_revision_conflict | schedule/commit | City | game_story_schedule_conflict | 重新读取权威 City 时钟锚点 |
| city_replay_write_denied | replay | City | game_time_domain_invalid | 仅展示历史，不允许提交剧情/奖励 |
| city_preview_time_isolation_failed | Studio preview | City | game_preview_unavailable | 停止测试并回滚 Fork，严禁写入真实玩家状态 |
| city_actor_intent_denied | City Router 公共世界动作 | City | game_actor_intent_denied（仅玩家剧情域，非别名） | 拒绝未授权公共角色行动，附可审计拒绝码 |

---

## 10. 端到端测试与验收

| ID | 必须真实验证的行为 |
|---|---|
| C-01 | 同版本 generator + seed 42 + params，在支持的 Node/OS/CPU 矩阵生成相同 WorldSnapshotDigest |
| C-02 | 海底 City 生成海床、12 个穹顶、相互连通的海底隧道和静态水体 Volume，无悬空或穿模主通道；基础穿越判定不冒充 3D 寻路 |
| C-03 | Shared Contracts 的 CityWorldSnapshotV4/子 DTO 包含稳定道路/建筑/锚点/Volume IDs 与完整拓扑/地形引用，TS 与 JSON Schema 一致 |
| C-04 | Codex 修改 1 个建筑位置，Studio preview 反映真实移动；commit 产生新 worldRevision |
| C-05 | Codex 修改 generator 的坡度规则，重新生成后新旧 diff 能定位变化对象 |
| C-06 | 仅切换 realistic-3d → pixel-3d，世界拓扑摘要与游戏模拟不变 |
| C-07 | 像素模式 16:9 和高 DPI 均 nearest 清晰、UI 不模糊、质量降档不破坏像素网格 |
| C-08 | Renderer 切换失败可回滚，GPU 资源无泄漏；可完成重复 10 次切换 |
| C-09 | Studio 关闭时 build/test 可运行，视觉 preview 必须报 unavailable，不能伪报 ready |
| C-10 | Session Buildings 不进入可移植世界包，不泄漏用户 Agent 数据 |
| C-11 | 旧 CityWorldProfileV1、SkinPackV1、ContentPackageV2、Legacy mini-game 回归通过 |
| C-12 | 已发布城市固定 Generator digest；升级不会静默重写旧实例 |
| C-13 | 原有怪兽→战棋、机甲/汽车/飞机可玩对象的点击触发与退出恢复行为保持不变 |
| C-14 | Codex 将一个城市 NPC 点击绑定到 city-romance 后，Studio 真机点击能进入对应 Dialogue/Game |
| C-15 | 同一个点击目标缺失/被遮挡/已删除时明确拒绝或忽略，不误触发背后的对象 |
| C-16 | Overlay Game 不接管 City 场景独占租约；Exclusive Game 保留现有互斥与相机恢复 |
| C-17 | 只修改 InteractionDescriptor 不改变 WorldSnapshot 的地形、道路及 worldRevision |
| C-18 | 不同玩家的私人关系状态不进入可移植 City 世界包，也不被其他小游戏越权读取 |
| C-19 | 新 City 默认 Simulation Time 以真实 UTC 1:1 前进；指定 Asia/Shanghai 时区后日历/居民日程/环境小时一致 |
| C-20 | 同一真实 UTC 时刻在不同宿主本地时区下，固定 City 时区得到相同的剧情调度结果；旧 host-local City 视觉不静默回归 |
| C-21 | 拖动已有 Session Replay Cursor 不触发 Story Event，不改玩家关系、奖励或 City World Revision |
| C-22 | Studio 快进 3 天仅写预览 Fork；退出后真实 Simulation Time、NPC 日程、好感度均未发生额外变化 |
| C-23 | 离线 72 小时后 City 按 pause/advance、Rule 按 skip/reschedule/expire/persist 正确恢复，事件无重复发放、无无界积压；系统回拨/异常前跳不重复结算，异常前跳标记 clock_uncertain |
| C-24 | Codex Actor Session 重新启动或上下文压缩后，角色 Canon、既有剧情事实与公开位置仍被外部状态约束 |
| C-25 | 两位玩家访问同一居民时，各自私人对话/关系不串线；同一公共位置更新按 Runtime 顺序仲裁 |
| C-26 | City Capability 仅从 City SDK contracts 导出，Game Permission 仅从 Game SDK 导出；映射与 V1 适配经 CI 契约检查，不形成循环依赖或同名双义 |
| C-27 | 不可变 Build 遵循 Game 文档 §2.1.2；旧 BuildId 不读取变化后的工作区，干净安装可用性按 G-AC32 实测 |
| C-28 | 包改名后 `@oh-agent/city-sdk/runtime` 继续可用且与 legacy 导出同源，现有 runtime 消费者不中断 |
| C-29 | Authoring Ref 可省略 requestedVersion，但 Build/WorldDefinition/Snapshot 必须固定 generator id/version/codeDigest；Registry 不得静默回退 |
| C-30 | Snapshot/LaunchContext 固定所用 environment/weather/place/resident Revision；语义环境变化按影响更新 environment/world Revision，视觉变化不重建世界 |
| C-31 | Actor allowedIntents/proposedIntents 共用 ActorIntentV1，记忆键包含 playerId/cityId/gameId/residentId；政策未开放时真实远程数据失败关闭，合成 Preview 可测试 |
| C-32 | once 本地日历必须由 Host resolveLocalTime 生成 atUtcMs，weekly 必须 dayOfWeek+localTime；target 地点检查、CAS 调度与 operationId 幂等通过 DST/重试测试 |
| C-33 | City/Game 只存在一套 Time Preview、Actor Simulate MCP 和 CreatorTaskEventV1 状态机，诊断码逐条记录 emit 路径与测试 |
| C-34 | GameTypeRegistry 与 InstalledGameRegistry 分层，Declarative/Legacy/Code Adapter 均通过统一 InteractionRouter 启动；无 CityEngine 新业务旁路 |
| C-35 | Story Event/Story State/奖励/Outbox 在 Actor 事务外生成后由短事务原子提交，崩溃重试不重复，晚到回调不能写已释放 Run |

### 10.1 推荐首个验收作品

Underwater World + Retro Pixel Render：1 个海底盆地、12 座程序化穹顶、透明隧道、珊瑚礁、潜艇起点、静态水体 Volume 和基础穿越判定，能在真实 Studio 中切换像素/写实。先验证一座城，不在 P0 做真实海洋流体仿真或完整 navigation.volume 三维寻路。

---

## 11. 开发拆分与 PR 顺序

| 阶段 | PR/Epic | 改动区域 | 交付边界 |
|---|---|---|---|
| P0-00 | **落地前置（四条）** | Game 文档 §2.1：构建器可交付、不可变 Build、headless 绑定 City、MCP 写入文案 | G-AC28~32 通过；否则后续 Epic 的“可演示”不成立 |
| P0-01 | 包命名迁移 | package.json、imports、lockfiles、CI、legacy runtime export | @oh-agent/city-sdk 可构建，含 ./runtime 的旧消费者不中断 |
| P0-02 | Shared World 类型及校验 | sdk/contracts、validate、Capability、Resolved Generator Identity、TS+JSON Schema 同源生成 | V1 不变，Shared 子 DTO、三轴映射与已解析生成器身份可用 |
| P0-03 | World Generator Registry | City Builder、City Engine Adapter | 先支持可信本地 generator，seed 确定性 |
| P0-04 | Render Profile V1 | sdk/appearance、CityEngine 后处理 | 写实/像素 3D 可切换并清理 |
| P0-05 | World Compiler + Snapshot V4 + Preview | WorldPlan、Compiler、SDK、City Runtime、Studio | routes→roads、引用校验、静态 Volume、真正可复现的海底城市/拓扑 |
| P0-06 | Code-first CLI + MCP Jobs | oh-agent-sdk、MCP、Studio | build/status/preview/capture/debug 闭环 |
| P0-07 | Underwater Demo | world sample、tests | C-01~C-12 中 P0 部分通过 |
| P0-08 | City Interaction Router 兼容层 | CityEngine 点击适配、sdk/interaction、Studio Inspector；依赖 Game G-02 entries | C-13~C-17，零回归怪兽/驾驶入口 |
| P1 | 编辑事务、复杂 Volume 编辑与 navigation API、增量构建 | world patch、导航、测试 | 海沟/潜艇 3D 导航、稳定 Diff；P0 基础 Volume 查询不重复建设 |
| P1-Story | Place/Resident + Narrative Engine + Story Mode | City SDK、独立 Narrative Engine、CAS Storage、Studio、游戏绑定 | City Romance 单 NPC 的跨场所触发、原子状态与隐私隔离 |
| P1-Temporal | City Clock + 环境采样对齐 | City Runtime、sdk/temporal、Studio Preview Clock | C-19~C-23/C-32，真实时间默认 1:1，Replay 与 Simulation 完全隔离 |
| P1-Agent-Actor | Agent Actor Binding + Session Adapter | sdk/actors、City MCP、Narrative Engine、Agent Actor Runtime、Studio Trace、远程数据政策门 | C-24~C-25/C-31，合成 Preview 单角色重启恢复；真实远程数据在政策开放前禁止 |
| P2 | 可下载可执行世界包 | package + sandbox + signature | 授权安装、UGC、Remix |

DoD：每个公开 API 同时交付类型声明、运行时验证、错误码、示例、CLI 检查、旧数据兼容测试、真实 City 可视测试。**不接受只有 JSON 通过就宣布“海底城市成功”的验收。**

**联合依赖图（v2.5，对齐 Shared §11）**：Shared F0（TS + JSON Schema + 跨包 CI）→ P0-00 → P0-01/P0-02 → P0-03/P0-05 → Game G-01/G-03 → Game G-02（Manifest、Permission 映射、entries）→ P0-06/Game G-05/G-06 → P0-04/Game G-04/G-07 → P0-08/Game G-10 与 P0-07/Game G-08（可并行，Interaction 案例必须先等 P0-08）→ P1-Story/Game G-11/G-12 → P1-Temporal/Game G-13/G-15 → P1-Agent-Actor/Game G-14。Game G-09 与 P2 可执行包共用独立安全门。

---

## 12. 产品最终定义

**@oh-agent/city-sdk = 城市即代码的公共契约层。**

开发者和 Codex 可以定义全新世界生成器、环境与主题、渲染风格、道路/建筑和版本化补丁；统一 City Runtime 决定如何可信地执行并呈现；Studio 给出真实的运行证据。游戏不复制这个世界，而是通过 @oh-agent/city-game-sdk 使用 City SDK 暴露的只读世界信息。

**v2.2 补充原则**：一座城只有一个权威 Simulation Time；真实 UTC 是默认基准，City 时区决定日历；历史回放是只读观察；角色 Agent 可以即兴表演，但不能自行改写身份、时钟或既定剧情事实。

**v2.3 原则保留**：凡是代码已经跑通的路径（buildId、发布摘要、v3 快照拒绝），先写进“已有”栏，再谈新增。

**v2.4 原则保留**：Capability 与 Permission 分型、分源；不可变 Build 不依赖活工作区；公开世界与私有剧情严格分离；Narrative Engine 独立；异步恢复重新鉴权，剧情写入具备 CAS/幂等；远程 Actor 数据门未开放时失败关闭。

**v2.5 单一规范原则**：公共字段、子 DTO、Grant、Revision、事务、Registry 和生命周期只在 Shared Contracts RFC 中修改。本文不得复制出第二套规范；破坏性变更进入 Shared Contracts v2、兼容评审与机器契约测试。

当前文档是基于 dev 的实现差距分析和建设方案；未修改仓库、未发布 npm 包，也未声称已完成端到端验收。
