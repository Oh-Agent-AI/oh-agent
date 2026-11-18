# Oh Agent City Game SDK v2 — 更新版产品需求与技术设计（PRD + RFC）

> 日期：2026-11-18
> 文档修订：**v2.5（2026-11-18，对齐 Shared Contracts RFC v1）**
> 状态：**产品与实施 RFC；公共契约由 Shared Contracts v1 冻结，本文件不另起或静默修改公共契约，不代表已经实现**
> 实施状态：包级契约、V2 Host/Preview、Registry、Snapshot Headless、Story CAS/Outbox 与 macOS bundle Build/Test 已落地；完整 Narrative、全量旧入口 Router 和五环境验收未完成。

> 审查对象：Oh-Agent-AI/oh-agent 的 dev（静态源码审查，未在本次环境执行真实 Studio）
> 公开包：**@oh-agent/city-game-sdk**（沿用现有名称）
> 基础世界包：**@oh-agent/city-sdk**（由 @agent-vitals/city-sdk 迁移）
> 上版基线：Oh_Agent_City_Game_SDK_PRD_Technical_Spec_v1_2026-11-17.md

> 配套文档：docs/AGENT_CITY_SDK_V2_PRD_RFC_2026-11-18.md
> 公共契约：docs/OH_AGENT_CITY_SHARED_CONTRACTS_RFC_V1_2026-11-18.md
> 修订依据：docs/CODE_GAME_V2_PRD_GAP_ANALYSIS_2026-11-18.md（同基线静态审查）

> 新增重点：City as Code、共享世界契约、Studio 真机联调、Render Profile、统一交互、真实时间和定时剧情、Codex 角色扮演、社区分发

---

## 0. 变化摘要

**City Game SDK 是在一座真实 City 上运行独立 TypeScript/JavaScript 游戏的公共开发 API + 可信运行时 Host。** Codex 可以像开发标准前端项目一样编写玩法逻辑；Studio 提供真正的 City 预览和可验证反馈；City 本身可由另一套 City SDK 代码生成。

### 0.1 v2.5 Shared Contracts 对齐（本次）

1. 公共世界 DTO、Capability/Grant、Revision、事务、InstalledGame、Launch 与 Actor Intent 统一引用 Shared Contracts RFC v1；本文保留 Game API、Host、Studio、实施 Epic 与验收。
2. `city(): CityWorldSnapshotV4` 改为 `header()` 与有界 `WorldQueryV1/WorldAssetV1`，完整 Snapshot 仅用于 Builder、导入导出和 Headless Fixture。
3. 增加 Host Grant 第三轴：Manifest 申请和 City Capability 均不等于实际授权。
4. GameTypeRegistry 与 InstalledGameRegistry 分层，Declarative/Legacy/Code Adapter 经统一 Router 启动。
5. Story 采用 Actor 事务外生成、提交前重读 Revision、Event/Story/Outbox 短事务原子提交。
6. P0 提前静态 Volume 查询和基础穿越判定，完整 `navigation.volume` 路径规划仍属 P1。

### 0.2 v2.4 契约修订与冻结（历史）

> v2.4 解决 v2.3 评审发现的跨文档冲突。冻结的是公开契约，不是交付日期或实现状态；远程 Actor 的真实用户数据传输另有政策门，不因本稿冻结而开放。

| # | 冻结决定 | 影响 |
|---|---|---|
| 1 | City Capability 与 Game Permission 分离；能力类型由 City SDK 定义，权限类型由 Game SDK 定义 | §3.1、§4.0；V1 仅经显式适配器映射 |
| 2 | Build 是不可变、自包含产物；工作区变化不使旧 BuildId 失效 | §2.1.2、G-AC29 |
| 3 | 打包构建器结论改为“资源声明不足，标准路径存在明确失败风险”，用干净安装矩阵确认范围 | §2.1.1、G-AC32 |
| 4 | V2 保持同步 `setup()` 注册，新增唯一异步 `onStart()`；统一取消、恢复鉴权和有界清理 | §4.4.1、G-AC33 |
| 5 | Narrative Engine 独立拥有剧情业务；Game SDK 只提供受限 Port | §2、§4.7、§4.8 |
| 6 | Storage 使用 Revision + CAS + operationId，跨键变更与 Event Log 原子提交 | §4.6、G-AC34 |
| 7 | Temporal 拆分 once/weekly，City 离线策略只控制时钟，Rule 负责 missed/persist/reschedule | §4.7、G-AC24 |
| 8 | Actor Intent 与玩家作用域统一；远程真实数据路径在政策改写前禁止 | §4.8、G-AC35 |
| 9 | 动态环境、Place、Resident 纳入 Revision 绑定；语义环境与视觉环境分离 | §3.2、§4.0 |
| 10 | Manifest 增加 entries；Interaction 排在 Manifest V2 之后，两份文档共用一张依赖图 | §3.1、§10 |
| 11 | 时间快进/Actor 模拟只保留 City MCP；任务进度共用一个事件契约 | §6.1、§6.2 |
| 12 | 诊断码区分“枚举已声明”与“路径已发射”，不再把枚举数量当作已落地数量 | §8.3 |

### 0.3 v2.3 修订（历史）

> 基线 `dev@1373b496`。本次**不改产品目标**，只做三类改动：修正与代码不符的盘点、消除两份文档的契约冲突、把"落地前置"提到 P0 之前。

| # | 改动 | 依据 |
|---|---|---|
| 1 | 盘点修正：`buildGame.ts` 自 2026-11-18 起在构建内联 `tsc --noEmit`；`creator_code_*` 工具族已存在（14 个） | `packages/city-game-sdk/scripts/buildGame.ts:89-92,219-281`；`crates/agent-vitals-mcp/src/mcp/creator_code{,_workspace,_experience}.rs` |
| 2 | 盘点补全：`games/tower-defense`、`creator_code_experience`（publish/install）、4 段验证脚本（2 段在 CI） | `games/tower-defense/`；`scripts/verify-code-game-*.mjs`；`.github/workflows/verify.yml:134,138` |
| 3 | 新增 §4.0 唯一能力/权限词表；§4.1 的 DTO 改用 City 文档 §4.3 的规范名 | 原两文档各有一套 DTO 名与权限词表 |
| 4 | 新增 §4.6.1 `PlayerScopeV1`：`playerId` 的来源必须先定义 | Code Game 路径当前无 player identity |
| 5 | 新增 §2.1「P0 落地前置」四条（构建器可交付、build 绑定 manifest/资产、headless 绑定目标 City、MCP 写入文案对齐） | 见该节；这是本次唯一新增的 P0 工作项 |
| 6 | §8.3 错误码以 `protocol/diagnostics.ts` 为基线重出，未落地的码标注"待落地" | `packages/city-game-sdk/src/protocol/diagnostics.ts:8-32` |
| 7 | §10 交付顺序：G-01 之前先做 B 的 P0-02/P0-05 与 §2.1 前置 | G-01 的产物就是 P0-02/05 的产物 |
| 8 | §9 Experience 与实现对齐；签名/信任级别/最低宿主版本标为 V2 增量 | `crates/agent-vitals-mcp/src/mcp/creator_code_experience.rs:179-195` |

### 0.4 v2.2 基线摘要（原文保留）

本版相对 2026-11-17 v1 文档的修订：

1. 由“游戏架设在已有 Miami/Desert City”升级为“游戏架设在任意符合 City v2 契约的 City”，包括未来海底、月球、沙漠和玩家自定义地形。
2. 不合并 City SDK 与 Game SDK；Game SDK 直接复用 @oh-agent/city-sdk 的世界 DTO/能力/版本协议，而不是维护两份同名语义的 Route、TerrainSample 等类型。
3. City Render Profile 是 City Runtime 的能力，**游戏仅声明兼容画风与偏好，不可直接替换整个城市渲染器**；画风切换原则上不影响游戏判定。
4. Codex 独立写 TS/JS、运行浏览器开发环境；Studio 不复制 IDE，只提供真实 City 绑定、真实画面、构建/试玩作业和 Agent 反馈。
5. 结合 dev 的新进展调整路线图：已有 defineGame、Manifest、Host、City 预览、GLB 加载和 hello-city 纵向切片，不能把这些仍标为“待做”；尚缺 Studio Code Game MCP 的完整作业链和安全 UGC 安装。
6. “Vite 可用于游戏工程开发”与“当前受控构建器已是 Vite”不是一回事；当前 scripts/buildGame.ts 明确使用 **esbuild**，独立 TypeScript typecheck 尚需工作流接入。
7. 新增世界/游戏联合版本规则、真实路网 vs 快照差异、海底潜艇案例、塔防和 Render Profile 的跨城兼容测试。
8. **v2.1 新增 City Interaction Bridge**：复用现有 CityEngine 点击怪兽启动战棋的能力，改造成稳定对象 ID + 声明式交互 + 受控游戏启动。支持不离开城市的 Overlay 剧情对话和独占画面的 Exclusive 战棋，并将 NPC/Place、对话、选择、私有进度和 Studio Story Mode 纳入路线图。
9. **v2.2 新增 Temporal Story**：恋爱游戏不是持续聊天，而是由真实 UTC 为默认基准的 City Simulation Time、居民日程、关系条件和世界事件驱动。历史 Session Replay 不能触发游戏剧情；Studio 快进只作用于隔离的预览 Fork。
10. **v2.2 新增 Agent Actor Bridge**：可以启动/恢复独立 Codex Thread 让其扮演居民，但人物 Canon 与 Story State 外置并由 Runtime 校验。游戏声明时间/剧情条件，Scheduler 按时唤醒 Agent；不让 Codex Session 自己充当时钟或无授权修改城市。

---

## 1. 实际 dev 实现盘点

### 1.1 已实现或已有代码路径

| 证据 | 实际能力 | 重要限制 |
|---|---|---|
| packages/city-game-sdk/package.json | @oh-agent/city-game-sdk v0.1.0，入口 . /host /protocol /testing | 仍为预发布，不代表社区执行安全 |
| src/api/defineGame.ts、api/types.ts | defineGame、GameContextV1、world/entities/input/events/ui/audio/clock/random | 公开类型自己定义 CitySnapshot、Route、TerrainSample，尚未引用 City SDK 统一协议 |
| src/api/types.ts 的 GameEventMapV1 / UiAPI | 已有 entity.clicked、zone.entered、ui.action 事件和 setHud | **没有**完整的 City 目标→Interaction Router→Game LaunchContext、对话选项 UI 或玩家私有 Story Storage 协议 |
| src/protocol/manifest.ts | CodeGameManifestV1 严格校验、文件/权限/预算字段 | world.requiredCapabilities 词表较窄，缺 underwater/volume/nav |
| src/protocol/permissions.ts | world.read、roads.read、terrain.sample、owned entities、input、HUD、audio | 权限和 Anchor travel capability 是两套不同语义 |
| src/host/codeGameHost.ts | 生命周期、固定步、Run-owned 实体、权限复验、HUD、诊断、清理 | Host 并非 sandbox，本身也不选择渲染画风 |
| src/api/types.ts：ClockAPIV1 / src/host/codeGameHost.ts | 固定 dt + 诊断 nowMs()；Host 默认注入 nowMs 时钟为 () => 0，测试可注入 | **不是城市日历**，不支持可靠的周六 18:00 / 离线约会等调度 |
| src/host/types.ts | WorldSourceV1、RenderPortV1、CodeGameHostOptionsV1、Telemetry | Port 只处理 owned entity spawn/update/destroy |
| scripts/buildGame.ts | Manifest 校验 → **构建内联 `tsc --noEmit`** → 固定工具链 esbuild → 内容哈希 BuildId / ESM | 2026-11-18 起有 typecheck 闸；仍不是完整 Studio Builder（无缓存、无作业状态机），且依赖开发机 Node/仓库（§2.1.1） |
| apps/agent-city/ui/src/game/codeGameHost/codeGameSession.ts | Game Session 联接 City Activity、Scene Lease、固定步和清理 | 必须继续遵守世界 revision 与活动独占 |
| CityEngine.ts：setTimeCursor / CityExperience.tsx：city-timeline | Session 历史回放、速度、实时游标；城市视觉随时间变化 | 这是浏览与回放能力，不能直接向游戏发出可写的故事事件 |
| engine/environment/CityEnvironment.ts：sample(timestampMs) | 与环境渲染共享的 timestampMs、hour、weather、timeZone；实时来自 Date.now | 当前默认 host-local，需明确 City 时区、真实 UTC 锚点以及共享 Simulation Time |
| apps/agent-city/ui/src/engine/CityEngine.ts | addEncounterTarget/removeEncounterTarget、handleClick 射线拾取、playableKind/playableAt 与 onPlay 游戏入口 | 既有“点击怪兽进入战棋”能力应适配为通用交互，不应另起一套拾取系统；具体 legacy 路由需迁移测试锁定 |
| apps/agent-city/ui/src/game/codeGameHost/useCodeGamePreview.ts | 可信 bundle 通过 Blob URL 进入真实 City，查询 live layout 并启动 CodeGameRun | 明确仅限 P0 可信开发，WebView 具有宿主权限 |
| apps/agent-city/ui/src/game/codeGameHost/threeRenderPort.ts | 真实 GLB 预加载、克隆复用模板、方块占位 fallback、Run 退出销毁资源 | RenderPort 不是美术风格插件，材质/资源仍需适配 |
| apps/agent-city/ui/src/game/codeGameHost/cityEngineWorldSource.ts | 把 live City arterial roads/terrain/blocks 投影到 WorldSource | 最多 16 路、每路 256 点、256 锚点、128 地块；不是完整语义路网 |
| apps/agent-city/ui/src/game/codeGameHost/cityWorldSource.ts | V3 LayoutSnapshot 锚点/几何投影与链路推导，地形可注入 | V2 快照无几何时拒绝，不杜撰路线/地形 |
| games/hello-city、games/tower-defense | 两个真实样本：hello-city（沿可信路线移动 + HUD + route_complete）、tower-defense（3 波 ×5 敌人、两座塔、基地血量、success/failure） | tower-defense 由 DSH subagent 独立写成并跑过“失败→调参→成功”；两者都只是基础 slice，不是潜艇/物理玩法 |
| crates/agent-vitals-mcp/src/mcp/creator_studio.rs、creator_code*.rs | 结构化 Creator City/Game/Scene/发布/视觉工具；**另有 14 个 `creator_code_*` 工具**（项目/工作区/文件/build/test/preview/status/publish/install） | `creator_code_*` 不在 `creator_studio.rs`，在 `creator_code{,_workspace,_experience}.rs`；构建器与 manifest 绑定问题见 §2.1 |
| crates/agent-vitals-mcp/src/mcp/creator_code_experience.rs | `creator_code_publish` / `experience_list` / `experience_install` / `experience_uninstall`：冻结 bundle + 资产 + 权限 + world 绑定，逐文件摘要 + 规范化 `contentDigest`；安装复核摘要，同 id+version 换包拒绝 | 安装只入本地库、不授予执行权；无签名/信任级别/最低宿主版本 |
| scripts/verify-code-game-{loop,city-loop,preview,publish}.mjs | 4 段验证：MCP 闭环、City 创建闭环、Playwright 真机预览、发布→安装→幂等→篡改拒绝 | 仅 loop/publish 进 CI；另两段需 Vite+Playwright，本地跑 |

**纠正 v1 文档的过时描述**：v1 需求文件曾把 GLB 真正加载列为后续工作，而现 dev 的 threeRenderPort.ts 已使用 GLTFLoader 预加载并按 Run 租约释放；该功能在新规划中属于已落地基础。剩余工作是验证资源寻址、尺寸/摘要、安全缓存及跨主题表现，而不是从零开始写一个加载器。

审查方式（v2.3）：在 `dev@1373b496` 上静态读源文件与 CI 脚本；“已实现”是代码路径证据，不是本次 CI PASS。

源码：

- [Game SDK README](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/packages/city-game-sdk/README.md)
- [Game public API](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/packages/city-game-sdk/src/api/types.ts)
- [Game Manifest](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/packages/city-game-sdk/src/protocol/manifest.ts)
- [Game Host](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/packages/city-game-sdk/src/host/codeGameHost.ts)
- [Game Builder](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/packages/city-game-sdk/scripts/buildGame.ts)
- [City live World Source](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/apps/agent-city/ui/src/game/codeGameHost/cityEngineWorldSource.ts)
- [City Render Port](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/apps/agent-city/ui/src/game/codeGameHost/threeRenderPort.ts)
- [Game Preview](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/apps/agent-city/ui/src/game/codeGameHost/useCodeGamePreview.ts)

---

## 2. 产品边界：City SDK、Game SDK、City Runtime、Studio

| 模块 | 数据/代码拥有权 | 可以做 | 不可以做 |
|---|---|---|---|
| @oh-agent/city-sdk | 世界契约、静态场景、Place、Resident、Interaction、City Temporal Snapshot、Actor Binding、Theme、RenderProfile | 公开类型、校验、只读 DTO 和时间/角色绑定声明 | 修改真实时钟、执行 Agent、写私有剧情 |
| @oh-agent/city-game-sdk | 游戏 API、Host 类型、Run-owned 实体、Dialogue Port、Story Port、Storage Port、Actor Port | 玩法、对话、按时间/事件声明剧情、请求角色 Intent | 修改共享道路、直接调整 City 时钟、获得 CityEngine 或 Agent Shell、内置 Narrative Engine 业务实现 |
| City Runtime/Engine | 权威 City 世界、时钟、事件队列、交互路由和租约 | 从真实 UTC 推进时间、持久化 Scheduler、校验并提交事件 | 让历史回放写入真实剧情或不经授权安装第三方 JS |
| Narrative Engine（独立可信服务） | Story Graph、Character Canon、Arc、Director、Episodic Memory、Reflection | 剧情一致性检查、叙事规则与角色记忆实现 | 直接操作 CityEngine、绕过 Game Port 权限或把私密记忆写入公共世界包 |
| Agent Actor Runtime | Agent Actor Session、模型适配器、预算与候选 Intent | 按授权组装上下文、生成表达与 Intent Proposal | 作为时钟/存档权威、直接写 City 或在政策开放前发送真实用户数据 |
| Creator Studio | 真实 Viewport、城市编辑、Story Mode、Preview Clock、事件/Agent Trace、Build/Test 作业 | 隔离快进、注入剧情测试、展示 Codex 意图与实际结果 | 通过测试时间操纵真实玩家状态 |
| Codex / 本地前端工程 | 游戏和世界的 TS/JS 源码 | 任意独立编辑、单测、前端预览、提交构建 | 绕过 Studio Host 权限与世界版本 |

**Game SDK 单向依赖 City SDK（目标）**。截至 v2.3，Game SDK 对 City SDK 的 npm 依赖为 0：`packages/city-game-sdk/src/api/types.ts` 自带 `CitySnapshotV1`、`RouteV1`、`TerrainSampleV1`。V2 必须改为共享 City SDK 规范化的只读世界 DTO，两包不得各维护一套定义；迁移期保留 V1 的 re-export 或转换器。

与 City 文档 §2.1.1 共用同一收敛决定：`MiniGamePackV1` 保持纯声明式内容，`CodeGameManifestV1/V2` 表示代码内容，`GameTypeDescriptorV1` 进入 GameTypeRegistry，具体安装实例统一进入 Shared Contracts §6.1 的 InstalledGameRegistry，`agent-vitals-city-game-runtime` 作为 legacy adapter 长期并入 Game SDK `/host`。InteractionRouter 只消费统一 InstalledGame 读模型。不新建第四套游戏包，也不把 Narrative Engine 塞进任一 SDK。

---

## 2.1 P0 落地前置（v2.3 新增，四条）

> 这四条不是 v2 功能，是现有代码的落地缺陷。它们排在 §10 的所有 Epic 之前；验收项见 §11 G-AC28~32。

### 2.1.1 构建器可交付性（阻断 G-05/G-06）

**现状**：`creator_code_build` 经 `run_node()` 启动 Node，脚本路径由 `repo_root()` 取**编译期** `CARGO_MANIFEST_DIR/../..`，node 取 `PATH`（`crates/agent-vitals-mcp/src/mcp/creator_code_workspace.rs:628-659`）。app 的打包资源只声明 `target/release/agent-vitals → bin/agent-vitals`（`apps/desktop/src-tauri/tauri.conf.json:45-47`），**没有 `packages/`、`scripts/`、`node_modules/`**；MCP 服务本身还是外部 agent 启动的 `data-mcp serve`。因此，**当前资源声明不足以保证干净安装环境可用，标准打包路径存在明确的构建失败风险**；静态审查不把所有启动方式一概断言为恒 `data_unavailable`。

**要求**：构建器随宿主分发（内置固定 Node + 脚本，或把 esbuild/tsc 收进 Rust/wasm），`data_unavailable` 不再是标准安装路径的正常结果。开发仓库、干净 macOS 安装、无全局 Node、无源码目录、CLI/MCP 独立启动五种环境必须分别验证 Build/Test；Preview 验证正式应用托管的真实 City，不再以复制进源码树 dev-server 目录作为完成标准。**在此之前，任何"Agent 可闭环"的对外表述都不成立。**

### 2.1.2 build 绑定 manifest 与资产

**现状**：`build.json` 只有 buildId/gameId/gameVersion/sdk/entry/bundle/byteLength/sdkVersion/bundler，没有 manifest 摘要与资产摘要（`packages/city-game-sdk/scripts/buildGame.ts:130-149`）；`creator_code_test`（`creator_code_workspace.rs:424`）、`preview`（`:357,359-362`）、`publish`（`creator_code_experience.rs:110,135-155`）都读**当前工作区**的 manifest 与资产。

**冻结契约**：Build 是不可变、自包含产物。build 时冻结 JS bundle、manifest、全部登记资产及摘要；BuildId 由全部构建输入摘要、SDK 与工具链身份派生。test/preview/publish 只读该产物，绝不读取当前工作区；工作区后续变化不影响旧 BuildId，只有冻结文件缺失或摘要不符才拒绝。使用新文件必须产生新 BuildId。`build_status` 返回 `manifestDigest`、`bundleDigest`、`assetDigests`、`sourceRevision` 与 `toolchainVersion`。

~~~ts
export interface CodeGameBuildV2 {
  buildId: string;
  gameId: string;
  gameVersion: string;
  bundleDigest: string;
  manifestDigest: string;
  assetDigests: Readonly<Record<string, string>>;
  sourceRevision: string;
  sdkVersion: string;
  toolchainVersion: string;
}
~~~

### 2.1.3 无头试玩绑定目标 City

**现状**：`scripts/previewGame.ts:38` 用 `createGameTestWorld()`（无参数）的合成世界：`cityId:"test-city"`、`worldRevision:"world-1"`、seed 42、20 m `test-road`、地形恒 0（`packages/city-game-sdk/src/testing/headless.ts:67-75,115-130`）。

**要求**：headless 接受 layout snapshot 或 cityId + snapshotDigest，测试世界由真实快照投影；telemetry 回传所用世界身份。

### 2.1.4 MCP 写入面文案与实现对齐

**现状**：app 导出的 MCP skill 文案写 `--allow-local-writes` 下"never SQL, never files, never URLs"（`apps/desktop/src-tauri/src/lib.rs:4575`），而同一份工具清单里就有 `creator_code_file_write`；`creator_code_preview` 还会把产物写进仓库的 `apps/agent-city/ui/public/code-games/preview/`。

**要求**：补全写入类型清单，或把 code-game 写入单列授权；文案与工具清单必须同源可校验。

## 3. 版本协议

### 3.1 Game v1 保留、v2 显式升级

当前 CodeGameManifestV1：schemaVersion=1、sdk.apiMajor=1、kind=code-game，不要直接在其允许字段中悄悄新增可执行世界扩展。

建议新增 CodeGameManifestV2，并由 Registry 明确区分：

~~~json
{
  "schemaVersion": 2,
  "kind": "code-game",
  "gameId": "community.submarine-explorer",
  "displayName": "Submarine Explorer",
  "version": "0.2.0",
  "entry": "src/index.ts",
  "sdk": {
    "name": "@oh-agent/city-game-sdk",
    "apiMajor": 2
  },
  "citySdk": {
    "name": "@oh-agent/city-sdk",
    "schemaMajor": 2
  },
  "world": {
    "requiredCapabilities": [
      "world.snapshot",
      "terrain.heightfield",
      "environment.parameters",
      "navigation.volume"
    ],
    "compatibleBiomes": ["underwater"],
    "minSnapshotSchema": 4,
    "binding": "capability-based"
  },
  "render": {
    "compatibleProfiles": ["realistic-3d", "pixel-3d"],
    "preferredProfile": "pixel-3d"
  },
  "presentation": {
    "supported": ["exclusive", "overlay"],
    "default": "exclusive"
  },
  "permissions": [
    "world.read",
    "terrain.sample",
    "environment.read",
    "navigation.query",
    "entities.write.owned",
    "input.read",
    "ui.hud"
  ],
  "entries": [
    {
      "id": "default",
      "export": "default",
      "presentation": ["exclusive", "overlay"]
    }
  ],
  "limits": {
    "maxEntities": 64,
    "maxProjectiles": 0
  },
  "assets": [
    {
      "id": "submarine",
      "path": "assets/submarine.glb",
      "type": "model/glb"
    }
  ]
}
~~~

以上为冻结的目标 Manifest，尚不被当前 V1 validator 接受。**capability 与 permission 分别使用 §4.0 的两张词表，不再互相同名或重复声明。** `compatibleBiomes` 表达生物群系约束，不把 `biome.*` 伪装成运行能力。

`entries` 是 Interaction Router 的唯一入口注册表：`id` 稳定且包内唯一，`export` 指向受控构建可验证的导出，`presentation` 必须落在全局 `presentation.supported` 内。`game.launch.entry` 缺省为 `default`，未登记入口返回 `game_entry_invalid`；不得把任意模块路径或函数名当作入口。

### 3.2 必须固定的版本

一次 Game Run 至少绑定：

- gameId、game sourceRevision、BuildId、SDK API major；
- cityId、cityRevision、worldRevision、interactionRevision、WorldSnapshotDigest；
- 按实际声明能力固定 environmentRevision、weatherRevision、placeRevision、residentRevision；只读 API 的恢复与重绑定必须检查对应 Revision，不能只检查 worldRevision；
- 对涉及日历剧情的游戏，额外固定 clockId、clockRevision、timeZoneId、simulationUtcMs 与 Event Log 边界；
- world generator ID/version/digest、terrain/nav capabilities；
- seed、固定步、输入 Trace；
- runId、权限与实体预算。
- 对交互启动的游戏还需 launchId、稳定 targetRef、entry、presentation 与触发来源；拒绝把 Three.Object3D 直接持久化。

Theme / Render Profile 的 revision 单独标记。**仅风格切换不得改变权威游戏数值结果，也不能让一局塔防敌人因切换像素模式而重置**；修改道路、地形、锚点则需停止或在受控迁移后重绑定游戏。

---

## 4. Game API v2

### 4.0 City Capability、Game Permission 与 Host Grant（v2.5 Shared）

**Capability 回答“City 能提供什么”，Permission Request 回答“Game 申请什么”，Host Grant 回答“当前实例获准调用什么”。三轴契约以 Shared Contracts RFC v1 §3 为唯一权威，本节是 Game Manifest/Host 的实施摘要。** City 支持能力、Manifest 申请权限和 Host 实际授权不得互相推断。

#### 4.0.1 City Capability 与所需 Permission 映射

机器可读 Capability 类型唯一来源是 `@oh-agent/city-sdk/contracts` 的 `WorldCapabilityV2`；Game SDK import 该类型，不反向依赖。

| City Capability | Game 使用该能力所需 Permission | 绑定 Revision | 状态 |
|---|---|---|---|
| `world.snapshot` | `world.read` | worldRevision + snapshotDigest | V1 适配已有 |
| `roads.graph` | `roads.read` | worldRevision | V1 适配已有 |
| `terrain.heightfield` | `terrain.sample` | worldRevision | V1 适配已有 |
| `environment.parameters` | `environment.read` | environmentRevision + weatherRevision + clockRevision | 目标 P0 |
| `sites.indexed` | `sites.read` | worldRevision | 目标 P0 |
| `objects.indexed` | `objects.read` | worldRevision | 目标 P0 |
| `volumes.indexed` | `volumes.read` | worldRevision | 目标 P0：静态查询与基础穿越判定 |
| `navigation.surface` | `navigation.query` | worldRevision | 目标 P1 |
| `navigation.volume` | `navigation.query` | worldRevision + environmentRevision | 目标 P1 |
| `appearance.profiles` | `appearance.read` | appearanceRevision + renderRevision | 目标 P1 |
| `time.simulation` | `time.read` | clockRevision | 目标 P1 |
| `residents.registry` | `residents.read` | residentRevision | 目标 P1 |
| `places.registry` | `places.read` | placeRevision | 目标 P1 |

`world.requiredCapabilities` 只填写第一列；`permissions` 只填写第二列及下表的游戏权限。Manifest Validator 按本表检查映射覆盖：声明使用某 Capability 时必须同时持有对应 Permission，但不要求两个字段字符串相同。未声明使用的 City Capability 不会自动授予任何权限。

#### 4.0.2 Game-only Permission

机器可读 Permission 类型唯一来源是 `packages/city-game-sdk/src/protocol/permissions.ts` 的 `GamePermissionV2`；它 import City 的 Capability 映射，但下列游戏专属字符串不进入 City SDK。

| Permission | 含义 | 绑定 | 状态 |
|---|---|---|---|
| `entities.write.owned` | Run-owned 实体增删改 | runId | 已实现 |
| `input.read` | 读取输入 | runId | 已实现 |
| `ui.hud` | Host 渲染 HUD | runId | 已实现 |
| `audio.play.assets` | 播放声明资产音频 | runId | 已实现 |
| `ui.dialogue` | 受控对话浮层 | interactionRevision + runId | 目标 P1 |
| `storage.game` | 玩家私有存储 | playerScope + runId + storyRevision | 目标 P1 |
| `story.schedule` | 声明式剧情规则 | playerScope + storyRevision + clockRevision | 目标 P1 |
| `actors.interact` | 请求 Actor Turn | playerScope + storyRevision | 目标 P1；远程另有政策门 |

规则：

1. 两张词表之外不得出现新字符串；新增词必须同时更新机器类型、映射验证、本表与 City 文档 §4.4 的只读摘要，并由 CI 检查一致性。
2. `interactionRevision` 等 Revision 是绑定字段，不是 Capability 或 Permission。
3. V1 兼容适配器将旧 `world.read` 映射为 `world.snapshot + world.read`，旧 `roads.read` 映射为 `roads.graph + roads.read`，旧 `terrain.sample` 映射为 `terrain.heightfield + terrain.sample`；V1 Host 行为不变，V2 Manifest 不沿用该同名双义写法。
4. 环境外观与语义分离：雾色等视觉变化走 appearance/weather Revision；medium、可通行体积等语义变化走 environmentRevision，影响导航时还必须更新 worldRevision 并停止或迁移受影响 Run。
5. 每次调用使用 Shared `GameAccessV1` 检查 `requestedPermissions ∩ grantedPermissions`，并按调用上下文检查 Capability；`navigation.query` 还需区分 surface/volume。`ui.hud` 等纯游戏权限不检查世界能力。安装、申请或 City 支持任一项都不构成 Grant。
6. Host Grant 按 installationId + runId + playerScope 复核，撤销或过期后晚到回调不得继续写入；远程 Actor 另受 §4.8 数据政策门约束。

### 4.1 开发者入口

保留当前 defineGame 入口和原有生命周期，但对 V2 明确新的 GameContext：

~~~ts
// v2.5 对齐 Shared Contracts；当前 dev 尚未发布或实现
import type {
  RoadEdgeDtoV2,
  SiteDtoV2,
  CityEnvironmentV1,
  CityAppearanceRefV1,
  WorldCapabilityV2,
  CityPlaceV1,
  CityResidentV1,
  CityPageV1,
  WorldQueryV1,
  WorldAssetV1
} from "@oh-agent/city-sdk/contracts";

export interface WorldAPIV2 extends WorldQueryV1, WorldAssetV1 {
  capabilities(): readonly WorldCapabilityV2[];
  supports(capability: WorldCapabilityV2): boolean;
  getRoute(routeId: string): RoadEdgeDtoV2;
  listSites(query?: { kind?: string; limit?: number; cursor?: string }): CityPageV1<SiteDtoV2>;
  listResidents(query?: { limit?: number; cursor?: string }): CityPageV1<CityResidentV1>;
  getResident(id: string): CityResidentV1;
  listPlaces(query?: { kind?: string; limit?: number; cursor?: string }): CityPageV1<CityPlaceV1>;
  environment(): CityEnvironmentV1;
  appearance(): CityAppearanceRefV1;
  // header/roads/objects/anchors/volumes/terrainSample 来自 Shared WorldQueryV1
  // openTerrainTile/openModel 来自 Shared WorldAssetV1；完整 Snapshot 不进入 Game API
}

export interface GameContextV2 extends Omit<GameContextV1, "world" | "onDispose"> {
  readonly world: WorldAPIV2;
  readonly signal: AbortSignal;
  onStart(handler: (context: { signal: AbortSignal }) => Promise<void>): void;
  onDispose(handler: () => void | Promise<void>): UnsubscribeV1;
  readonly launch?: GameLaunchContextV1;
  readonly dialogue?: DialogueAPIV1;
  readonly storage?: GameStorageAPIV1;
  readonly cityTime?: CityTimeReadAPIV1;
  readonly story?: StoryEventAPIV1;
  readonly actors?: AgentActorAPIV1;
  onAppearanceChanged?(
    handler: (appearance: CityAppearanceRefV1) => void
  ): () => void;
}
~~~

`CityWorldHeaderV1`、`WorldQueryV1`、`WorldAssetV1`、`CityPageV1` 及全部世界子 DTO 均在 City SDK 按 Shared Contracts 定义，由 Game SDK re-export type。`CityReadOnlySnapshotV2` / `CityRouteDtoV2` / `CityObjectDtoV2` / `CityAnchorDtoV2` 是 v2.2 的旧名，**不得再出现在实现里**。

### 4.2 WorldAPI

| 能力 | V1 现状 | V2 目标 |
|---|---|---|
| header() | cityId、seed、worldRevision、layoutId | Shared WorldHeader：身份、Capability、Revision、topology/snapshot Digest；不返回完整城市数组 |
| roads / getRoute | 只读 route 点列表 | 有界分页、稳定 Cursor、travelMode、拓扑版本；V1 listRoutes 由适配器兼容 |
| terrainSample | 高度/法线/可建造 | 明确静态 surface；无地形采样返回诊断，不虚构高度 |
| anchors | 仅现有 kind、位置 | 有界分页并引入海底/垂直 3D travel mode |
| objects | 有界对象摘要 | 支持 site/building/road/tunnel/object 分类与空间索引 |
| volumes | 无 | P0 静态水体/空域/checkpoint/trigger 查询与基础穿越判定；不等于三维寻路 |
| openTerrainTile / openModel | GLB 预加载已有基础 | 按稳定 ID + digest 有界读取，复核大小/摘要，不接受路径或 URL |
| environment | 无 | 水/空气/真空、雾、深度环境元信息 |
| appearance | 无 | **只读**当前 Theme/RenderProfile 引用及 appearance/render Revision，便于 HUD/素材适配 |
| listPlaces / listResidents | 无 | P1 只读、分页/有界返回公开 Place/Resident DTO；必须从共享 City SDK 契约导入 |
| interactionRevision | 无 | 独立于道路/地形 worldRevision，用于判断点击/接近绑定是否过期 |
| cityTime | 无城市日历 | 只读 CityTemporalSnapshot；与 CityEnvironment 共用时间域，不把 Replay Cursor 当游戏时间 |
| story.events | 无跨 Run 持久调度 | P1 受控注册/取消、幂等触发、事件状态查询；独立于单次 Run 的寿命 |
| navigation | 无通用寻路 | P1 显式二维/三维有界规划，不能用随机路冒充结果 |

特别注意当前 dev 的两条世界投影路径：

1. **Live City**：cityEngineWorldSource.ts 从当前布局提取 arterial road edges 与地形；最多暴露 16 条道路，objects 主要来自有界 City blocks。
2. **Snapshot**：cityWorldSource.ts 从 LayoutSnapshotV3 的锚点 link 构建路线；地形必须由宿主注入采样器，否则明确失败。

它们不是完全等价的 WorldSource。V2 必须明确统一快照能力、route identity、拓扑条件和测试夹具，避免“无头塔防走得通，Studio 真城却走不通”。有分叉和多环的路网应升级为 Graph API，不能继续只依赖链表式 route 推导。

### 4.3 Entity、事件、输入与物理

保留现有 EntityAPI 的 spawn/update/get/query/destroy、Host-owned 权限检查与幂等释放。新增能力按阶段进入：

| 能力 | 策略 |
|---|---|
| 3D prefab / GLB | 复用已实现的预加载加载器，增加资源摘要/缓存与渲染兼容检查 |
| click / collision events | 仍由可信 Host 归一化发送；不直接 expose Three Raycaster |
| PhysicsAPI | P1 才做有界刚体、碰撞、流体阻尼等宿主模拟，不把物理引擎实例给游戏 |
| NavigationAPI | P1 以 City World Graph 为输入，支持路面、空域、海水体积 |
| Entity ownership | 所有游戏实体仍属于 RunId；游戏绝不能删除 City 的静态建筑 |
| Shared City edits | 不在游戏 Runtime 内暴露；创作阶段通过 City SDK + Studio 编辑/审批事务 |

塔防游戏的塔、敌人、投射物只存在本次 Game Run，不能为了放塔永久改写 City buildings。若用户希望真的改道路或建研究站，则必须切换到 Creator 的城市编辑工作流，并造成明确的 City revision。

### 4.4 Game 生命周期与画风变化

当前 Host 状态 created → preparing → ready → running ⇄ paused → finished/failed → disposed 已实现；继续保持一 Run 一租约、固定步、权限每调用复查和 LIFO/一次性清理。

新增三个事件来源：

- World geometry changed：停止受影响运行，返回 game_world_revision_conflict，要求重绑定；
- Appearance changed：游戏默认继续运行，Renderer 维护 GPU 资源，Game 可选择更新 HUD/资产 LOD；
- Build changed：安全停止旧 Run → 新 BuildId、新 RunId，不能直接 Vite HMR 替换正在模拟的闭包而不释放旧资源。

**Renderer 归 City Engine；Game SDK 只通过 RenderPort 向宿主提交实体创建/变化/删除。** 在真实/像素切换期间，Game Simulation 不应使用渲染帧率或像素坐标做权威判定。

#### 4.4.1 V2 异步生命周期与取消（v2.5 Shared）

- `setup(ctx)` 保持同步，只注册处理器；V2 不允许 `async setup()`。每个 Game 最多注册一个 `onStart()`，Host 在 ready 后调用一次。
- `ctx.signal` 只提供取消通知。Run 停止、City 切换、Build 变化或权限撤销时，Host 先取消 signal，再按 LIFO 执行有界清理；异步 `onDispose()` 必须有超时，最终结果幂等。
- Dialogue、Actor Turn 和其他 Host Promise 在取消时必须稳定 reject/cancel（`game_run_cancelled`），不得永久悬挂。Dialogue 选择只走 `dialogue.open()` Promise，不再保留第二个权威 `ui.choice` 通道。
- 每次 `await` 恢复后，Host 在写操作前重新检查 runId、Run 状态、权限及相关 World/Story Revision；`AbortSignal` 不能替代鉴权。
- Storage 的取消不能假装回滚已提交事务。响应必须区分“未提交已取消”和“已提交后收到取消通知”；Event Log 与状态提交原子完成。
- `onStart` 抛出异常、取消或返回后，Run 分别进入 failed、cancelled 或 finished 的明确状态；重复点击不得为同一 launchId 启动第二个权威流程。

### 4.5 City Interaction Bridge 与 GameLaunchContext（v2.1 新增）

City 不是只能嵌入大型战斗小游戏，也可以通过居民、咖啡馆、电影院、告示牌等任意已注册目标进入轻量游戏。交互的 **数据定义** 归 `@oh-agent/city-sdk`，**点击拾取和路由** 归可信 City Runtime，**玩法及 UI** 才归 Game SDK。这样不需要每增加一种游戏就修改 `CityEngine.handleClick()` 的业务分支。

~~~ts
// 目标契约（与 City SDK 的 CityTargetRefV1 对齐，非当前已发布 API）
export interface GameLaunchContextV1 {
  readonly launchId: string;
  readonly cityId: string;
  readonly worldRevision: string;
  readonly interactionRevision: string;
  readonly cityRevision: number;
  readonly worldSnapshotDigest: string;
  readonly environmentRevision?: string;
  readonly weatherRevision?: string;
  readonly placeRevision?: string;
  readonly residentRevision?: string;
  readonly playerScope: PlayerScopeV1;
  readonly source: CityTargetRefV1;
  readonly interactionId: string;
  readonly entry?: string;                 // 例如 linxia-intro / monster-encounter
  readonly presentation: "overlay" | "exclusive";
}
~~~

建议启动顺序：

1. CityEngine 延用 `addEncounterTarget` / `handleClick` 既有屏幕拾取与遮挡判断，转换为稳定的 `CityTargetRefV1`，不把 THREE 对象传给游戏。
2. `CityInteractionRouter` 根据目标 ID 查询声明式 `CityInteractionDescriptorV1`，再读取 Shared Contracts §6.1 的统一 InstalledGameRegistry，验证安装状态、entry、manifest、Permission Request、Host Grant、当前 interactionRevision 与目标实例是否仍有效。GameTypeRegistry 只负责类型契约，不作为第二个安装启动入口。
3. `game.launch` 动作按 `gameId + entry + presentation` 申请所需租约。Declarative/Legacy/Code 分别经对应 Adapter 进入同一 Router；原怪兽→战棋注册为 `exclusive` Legacy Adapter，原有战斗实现不强制重写。
4. Game Host 仅向对应 Run 发放经过审查的 LaunchContext。`ctx.launch.source` 是定位 NPC/地点/世界物体的公共引用，不是权限令牌；后续读取仍需权限复验。
5. 返回城市后释放 owned entities、输入焦点、UI/Scene 资源；原 City 场景/点击状态恢复。

如果交互所指的对象已经消失、游戏未安装、世界条件不符合或 Exclusive 活动正在运行，必须返回明确的拒绝/诊断，不应伪造一次成功启动。

### 4.6 Dialogue、Resident 与 Game Storage（v2.1 新增）

目标是让 Codex 可以开发一个**纯 TypeScript 的恋爱剧情游戏**：玩家在 City 街头看见居民、点击聊天，在 City 内打开剧情浮层，根据选择积累好感度，再去咖啡馆赴约；这些内容都不需要把 CityEngine 改成恋爱游戏引擎。

#### 4.6.1 PlayerScopeV1（v2.3 新增，所有玩家私有数据的前置）

v2.2 把 Storage/Dialogue/Story/Actor 全部按 `playerId × cityId × gameId` 隔离，却没有定义 `playerId` 从哪来，代码里也没有对应概念。v2.3 定义：

`PlayerScopeV1` 由 **Shared Contracts RFC v1 §2.1** 冻结，Game SDK 从 City contracts import type；这里不再复制字段定义。

规则：

- `local-profile` 由宿主在首次进入 City 时生成并持久化，**不得**由浏览器指纹推导；
- `remote-guest` 只在本次 remote 会话内稳定，会话结束即失效，不得写入跨会话存档，也不得创建跨 Run 的持久 Story Rule；
- 所有 Storage/Story/Actor 键**必须**显式包含 `playerId`、`cityId`、`gameId`，Actor 记忆额外包含 `residentId`，缺失即拒绝（`game_storage_denied`）；
- Studio Preview Fork 使用独立 `playerScope`，禁止复用真实玩家 id。

~~~ts
// v2.5 对齐 Shared Contracts；当前 dev 尚未实现
export interface DialogueAPIV1 {
  open(input: {
    speaker: { residentId?: string; displayName: string; portraitAssetId?: string };
    text: string;
    choices: readonly { id: string; label: string; enabled?: boolean }[];
  }): Promise<{ choiceId: string }>;
  close(): void;
}

export interface GameStorageRecordV1<T> {
  value: T | null;
  revision: string;              // null value 也有可比较的宿主 Revision
}

export interface GameStorageAPIV1 {
  get<T>(key: string): Promise<GameStorageRecordV1<T>>;
  compareAndSet<T>(input: {
    key: string;
    expectedRevision: string;
    value: T;
    operationId: string;
  }): Promise<{ revision: string }>;
  delete(input: {
    key: string;
    expectedRevision: string;
    operationId: string;
  }): Promise<void>;
}
~~~

- **Resident / Place 读 API**：建议 `ctx.world.listResidents()`、`ctx.world.getResident(id)`、`ctx.world.listPlaces()`，只返回经授权、可公开的静态身份/活动锚点。居民排班、位置、资产引用统一沿用 City SDK，不在 Game SDK 再定义第二套模型。
- **剧情 UI**：`ctx.dialogue.open()` 必须由 Host 渲染受控的文字、立绘和选项；Promise 仅在真实玩家选择后 resolve，取消时按 §4.4.1 落定。V2 不引入第二个权威 `ui.choice` 通道。
- **个人进度**：Game Storage 按 `playerId × cityId × gameId` 隔离，键和值容量有界、序列化可校验，可按产品授权进行跨城迁移。NPC 好感度、已读章节、私人剧情记忆**绝不写入公共 City WorldPackage 或 Scene Snapshot**。
- **原子性**：V2 不提供无条件 `set()`。单键更新使用 `expectedRevision + operationId` CAS；Revision 冲突返回 `game_storage_revision_conflict`，调用方重读后决定。跨键更新使用 Host 的有界声明式事务，事务与 Story Event Log 原子提交，不向游戏暴露数据库句柄或任意事务回调。
- **条件与结局**：选择规则建议先由 TS/JSON 确定性状态机实现，Story 测试使用固定 seed 和脚本化 choices。P2 才考虑接入可选 LLM 对话，且不得把用户隐私或 Agent Session 原始数据发给未授权模型。
- **生命周期**：UI 关闭、City 卸载、Game Run stop、Manifest 撤销时，未完成的 `open()` 必须受控 reject/cancel，不能留下永远悬挂的对话 Promise。

### 4.7 Temporal Story Port 与独立 Narrative Engine（v2.5 Shared）

`Story Graph`、角色 Arc、Narrative Director、Episodic Memory 与 Reflection 由独立 Narrative Engine 实现；本节只冻结 Game SDK 的受限 Port 和 City Runtime 的持久调度契约，不在 Game SDK 内实现恋爱/RPG 专用剧情框架。

**时间定义**：默认线上 City 的权威 Simulation Time 以真实 UTC 为基准、按 **1:1** 流逝；`Asia/Shanghai` 这类 City IANA 时区只负责把 UTC 映射为本地周几和时刻，不改变经过的秒数。游戏不从浏览器 `Date.now()` 取得剧情时间，也不把已有 Agent Session History Replay Cursor 当作剧情时钟。固定步 `ctx.clock.fixedDtSeconds` 继续供战棋/飞行物理模拟，不承担每周约会或跨天任务调度。

| 时间域 | 负责 | 游戏使用方式 | 能否产生正式剧情效果 |
|---|---|---|---|
| Wall UTC | 宿主可信时钟/服务端 | City 时钟锚点、审计 | 不直接触发游戏逻辑 |
| City Simulation UTC | City Runtime 单一权威时钟 | `ctx.cityTime.now()`；事件调度来源 | 可以，由持久化 Scheduler 仲裁 |
| City local calendar | Simulation UTC + City IANA 时区 | 每周六 18:00、生日、昼夜营业 | 可以，需明确 DST/日历策略 |
| Agent Session Replay | 既有 City 轨迹回放 | 只读历史观察 | **不可以** |
| Studio Preview Fork | 隔离时钟/世界/玩家剧情快照 | 快进 72h、模拟失约、调试 | **不可以写正式存档** |
| Game Fixed Step | Game Host 的模拟 tick | 物理、战棋、输入 Trace | 只影响当前 Run 的受控数值 |

~~~ts
// v2.5 对齐 Shared Contracts，尚未在 dev 落地；时间模型来自 City SDK 公共契约
import type { CityTemporalSnapshotV1 } from "@oh-agent/city-sdk";

export interface CityTimeReadAPIV1 {
  now(): Readonly<CityTemporalSnapshotV1>;
  subscribe(listener: (snapshot: Readonly<CityTemporalSnapshotV1>) => void): () => void;
}

export type StoryTriggerV1 =
  | { kind: "calendar"; recurrence: "once"; atUtcMs: number }
  | { kind: "calendar"; recurrence: "weekly"; timeZone: "city";
      dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; localTime: string }
  | { kind: "city-event"; eventType: string; targetId?: string }
  | { kind: "relationship"; residentId: string; threshold: number };

export interface StoryEventRuleV1 {
  ruleId: string;                   // 玩家/城市/游戏内唯一，跨 Run 不变
  version: number;
  trigger: StoryTriggerV1;
  target?: CityTargetRefV1;
  requirePlayerAtTarget?: boolean;
  conditions: readonly { key: string; op: "eq" | "gte"; value: string | number | boolean }[];
  action: { kind: "offer-dialogue" | "update-quest" | "emit-game-event"; eventId: string };
  cooldownMs?: number;
  missedPolicy: "skip" | "reschedule" | "expire" | "persist";
  rescheduleDelayMs?: number;       // reschedule 必填
  maxRescheduleCount?: number;      // reschedule 必填且有界
}

export interface StoryEventAPIV1 {
  resolveLocalTime(input: {
    localDate: string;              // YYYY-MM-DD，按 City IANA 时区解释
    localTime: string;              // HH:mm
  }): Promise<{ atUtcMs: number; clockRevision: string }>;
  schedule(rule: StoryEventRuleV1, options: {
    expectedStoryRevision: string;
    expectedClockRevision: string;
    operationId: string;
  }): Promise<{ ruleId: string; storyRevision: string }>;
  cancel(ruleId: string, options: {
    expectedStoryRevision: string;
    operationId: string;
  }): Promise<void>;
  list(): Promise<readonly { ruleId: string; nextDueUtcMs?: number }[]>;
}
~~~

`schedule()` 只能提交**可序列化、可校验的声明规则**，并以 `expectedStoryRevision + expectedClockRevision + operationId` 做 CAS、时钟校验与幂等。Host 将它持久化到玩家作用域的 Story Rule Registry，由 Runtime Scheduler 负责每个 City Simulation Tick/唤醒检查、权限复验、条件求值、去重、事务提交和 Event Log。**一段对话所属的 Game Run 关闭后，未来周六的约会仍必须存在**；不能用某个挂起的 JS `setTimeout` 或常驻 Codex 会话承载这一事实。故事事件可以重新拉起经授权的 Overlay，也可以变为待领取通知；**没有玩家在场时不可伪造其对话选择**。

一次性本地日历必须先用 `resolveLocalTime()` 由宿主按 City IANA 时区解析成 `atUtcMs`，再提交 once Trigger；weekly 必须同时提供 `dayOfWeek + localTime`，不允许混入 `atUtcMs`。DST 不存在或重复的本地时刻必须显式拒绝或按固定策略解析并返回证据。条件 key 只能来自 Host 的授权只读条件目录，不能借字符串读取任意 Storage 或其他玩家状态。`target + requirePlayerAtTarget` 是赴约地点检查的结构化语义，不能用自由文本条件冒充。

周期性事件每个自然 occurrence 使用 `playerId/cityId/gameId/ruleId/occurrenceId` 构成去重键；同一个 occurrence 在网络重试、宿主重启或快照恢复后最多产生一次正式效果。City `offlinePolicy` 只决定离线期间 Simulation Clock 是 `pause` 还是 `advance`，Rule 不再声明第二个 offlinePolicy。`advance` 时按受限 `maxCatchUpMs` 恢复，Rule 的 `missedPolicy` 决定 skip/reschedule/expire/persist；`persist` 只保存有界待处理事实，不自动替玩家选择或发奖励，`reschedule` 必须有延迟和次数上限。

**时间修改权限**：游戏只有 `time.read`；创建/删除个人剧情规则需要 `story.schedule`，均受 Manifest 和 Host 重新鉴权。`ctx.cityTime` 只读，`Studio` 对快进/冻结时间只在隔离 Preview Fork 生效；正式线上改变权威 Simulation Time 必须经过特权 City 操作与审计，不能由游戏 API 或 Agent Actor 直接调用。App 关闭期间没有 Scheduler 在后台运行，恢复时只按锚点和上述策略结算。本地系统时钟不可信：回拨不得重复事件，异常前跳进入有界恢复并标记 `clock_uncertain`；联机共享剧情必须由服务端或其他权威时钟仲裁。

Scheduler Record、`processing → committed`、StoryCommitCommand 与 Event/Story/奖励/Outbox 原子事务以 **Shared Contracts RFC v1 §5** 为唯一权威。Actor Turn 在事务外执行，提交前重读 Story/Clock Revision；只有短事务提交成功才算剧情事实发生，广播与晚到回调均不能替代提交。

### 4.8 Agent Actor Bridge（v2.2：Codex / Claude Code 扮演 NPC）

角色身份、人格约束、人物关系与剧情已发生事实不能只放进一个不断变长的提示词。目标协议由三部分组成：

1. **Character Canon**：City SDK 注册角色的稳定身份、性格、说话方式、知识边界、住址/日程规则、可触发场景。通过版本与摘要引用，不由对话模型擅自改写。
2. **Authoritative Story State**：玩家私有关系、已完成章节、承诺、待赴约事件、世界公开位置及时间戳，由受控 Storage/Scheduler 事务化保存和版本校验。
3. **Ephemeral Actor Session**：Codex app-server 的 Thread（或另一个受信 Agent Adapter）只负责生成**候选对白和意图提案**；Session 是可重启的计算资源，不是人设、存档、时钟或世界状态的最终权威。

~~~ts
// 目标受控宿主桥接协议；不是向第三方 Game 暴露 Codex 原始 shell 会话
import type { ActorIntentV1 } from "@oh-agent/city-sdk/contracts";

export interface AgentActorTurnRequestV1 {
  residentId: string;
  interactionId: string;
  playerMessage?: string;
  storyRevision: string;
  idempotencyKey: string;
}

export interface AgentActorTurnResponseV1 {
  utterance: string;
  proposedIntents: readonly ActorIntentV1[];
  canonDigest: string;
  baseStoryRevision: string;
  auditTraceId: string;
}

export interface AgentActorAPIV1 {
  requestTurn(input: AgentActorTurnRequestV1): Promise<AgentActorTurnResponseV1>;
}
~~~

由 Host/Agent Actor Runtime 负责将角色 Canon、当前 Simulation Time、City 公共事件、玩家**授权可见**的关系记忆与最近有效剧情摘要注入 Session；通过既有 Codex 通信能力开始/续接 Thread 和 Turn（或由 Claude Code Adapter 实现同一接口）。Game SDK 不公开 Thread ID、原始提示词、API 密钥、系统 Shell 或文件读写工具。上下文压缩、重连和 Session 丢失时，从持久化 Canon/Story State 重建，而不是让 LLM 自己回忆。

模型生成 `proposedIntents` 后必须执行：JSON/schema 校验 → Canon/剧情不变量校验 → 当前 City 时空/权限/玩家状态校验 → `storyRevision` 乐观并发校验 → 受控 Host 提交 → 记录 Trace。未经验证的台词不能直接更改好感度、安排约会或修改城市建筑；若模型偏离人格、虚构既定事件、发出不被允许的行为，应拒绝该意图并退回确定性剧本。`ActorIntentV1` 及 `allowedIntents` 使用 City SDK 的同一种类词表。私密会话与记忆按 `playerId × cityId × gameId × residentId` 隔离；跨玩家共享 NPC 仅共享 City 允许公开的世界事实。

**远程数据政策门（v2.5 Shared，契约冻结不等于远程开放）**：在仓库数据政策新增独立、用户主动触发、可撤销的远程 Actor 例外前，Codex/Claude 等外部或托管会话只能处理合成 Preview 数据，不得接收真实 `playerMessage`、私密关系记忆、剧情摘要或可关联玩家身份。政策落地时必须定义字段白名单、目的地、留存/撤销和本地降级；通用 `actors.interact` 权限不构成远程发送授权。未开放时返回 `game_actor_remote_unavailable`，固定剧本与本地确定性叙事必须可完整运行。

**Agent 不必常驻在线**。周六 18:00 到点由 Temporal Story Scheduler 唤醒事件或入队；玩家实际进入约会 UI 时再按需创建/恢复一个角色 Turn。设置超时、Token/成本预算、频率限制与低成本固定对白兜底。P1 先支持一个角色、一个工作流与单独玩家身份，P2 再扩展多角色群像/跨城叙事。

---

## 5. 两种开发预览：浏览器与真实 City

| 环境 | 谁启动 | 解决的问题 | 不能代表 |
|---|---|---|---|
| 独立 Vite/browser Dev | Codex 在游戏工程运行 npm scripts | 快速改 TS、TypeScript 报错、使用 Mock World 调玩法和 UI | 不代表真实 City 的道路、相机、地形、资源租约 |
| Studio City Preview | Creator MCP 根据 BuildId + City revision 启动 | 真机画面、真实世界布局、点击/输入/碰撞、Render Profile、性能 | 不自动具备社区 Sandbox 信任 |
| Headless Game Test | Game SDK testing fixture | 确定性模拟、输入 Trace、数值回归 | 无法代替视觉截图/实际 GPU 测试 |

### 5.1 Vite 和 esbuild 的正确定位

现在 packages/city-game-sdk/scripts/buildGame.ts 使用 esbuild，输出 ESM + BuildId；**自 2026-11-18 起构建内联 `tsc --noEmit`**（缺编译器即失败闭合），并且不运行游戏工程的 vite.config.ts、postinstall 或任意 npm scripts。City/Studio 作为宿主应用本身使用 Vite。

建议：

- Game Workspace 的本地开发用标准 TypeScript + Vite 模板，提供浏览器 Mock World / Canvas 预览。
- 正式可信构建任务起初可继续复用当前受控 esbuild 与已有 tsc --noEmit 闸，补齐不可变资产快照、完整 Build 输入摘要和诊断。
- 如果将来将 Builder 改成 Vite Library Mode，应由宿主固定配置、依赖白名单、版本锁与 OS 级资源预算，不能把可执行 vite.config.ts/插件当作安全文本。
- 不要求 Studio 代替 Codex 进行文件编辑；没有 Studio 时也应该能够 typecheck、build、headless test。

### 5.2 推荐 Game Workspace

~~~text
games/submarine-explorer/
  game.manifest.json
  package.json
  package-lock.json
  tsconfig.json
  vite.config.ts             # 本地可信开发模板
  src/
    index.ts
    game/Submarine.ts
    systems/NavigationSystem.ts
    systems/Checkpoints.ts
    ui/Hud.ts
  assets/
    submarine.glb
  tests/
    gameplay.test.ts
    compatibility.test.ts
  dist/
~~~

游戏依赖 @oh-agent/city-game-sdk；公开 World DTO 由 @oh-agent/city-sdk 提供。工程可以放在一个 City Project 的 games/ 下，但不应和 City Generator 源码合并为一个 JS 包。

### 5.3 Overlay / Exclusive 两种呈现协议（v2.1 新增）

| 模式 | City 的状态 | 游戏持有的资源 | 典型案例 | 关闭行为 |
|---|---|---|---|---|
| `exclusive` | City 可保留但战棋场景或其视图接管当前体验；同类活动受独占限制 | Activity Lease + Scene/Camera Lease + Input Focus Lease | 点击怪兽进入机甲战棋、驾驶/飞行等大型玩法 | 释放全部租约，恢复 City 场景和输入 |
| `overlay` | City 的道路、建筑、居民和相机继续可见，默认不卸载场景 | UI Layer Lease + 受控 Input Focus Lease；默认不能接管 Scene/Camera | NPC 聊天、恋爱文字游戏、任务面板、商店 | 关闭浮层，恢复 City 点击/键盘焦点，不重建世界 |

路由优先级：游戏 `manifest.presentation.supported`、City 交互动作请求、当前运行态三者共同校验，取明确允许的模式；不允许 Game 自行将 overlay 提升为 exclusive。Overlay 必须定义焦点政策：当对话浮层打开时拦截 UI 点击，禁止同一点击透传触发城市第二次拾取；Escape/关闭/切 City 都必须能释放输入和 UI 租约。

`exclusive` 沿用现有 CityActivityCoordinator/Scene Lease 能力；`overlay` 需要 **新的轻量 UI/Input Focus Lease**，不能为仅弹出几句对白强行替换整个 3D 场景。统一的 Run 生命周期仍适用于两者，且要避免同时存在的 overlay 对话绕过战斗独占限制。

---

## 6. Studio MCP、调试与 Codex 工作进度

### 6.1 建议新增的 Code Game MCP API

**现状（v2.3 核对）**：下表是**目标**。已实现的是另一套命名、共 14 个工具：`creator_code_project_create`、`workspace_info`、`file_read`、`file_write`、`build`、`test`、`preview`、`builds_list`、`build_status`、`preview_status`、`publish`、`experience_list`、`experience_install`、`experience_uninstall`。其中 `preview` 只是把产物拷到 City dev server 的 public 目录并返回 URL（无 runId、无 capture）；**没有任何工具接受 cityId/cityRevision 绑定**，`project_create` 也不带 City 参数。下表标"缺"的，是尚未落地部分。

| 工具（目标） | 输入 | 返回 |
|---|---|---|
| creator_code_project_attach | workspaceId、cityId、cityRevision、operationId | 绑定 ID、worldCapabilities、期望 sourceRevision |
| creator_code_build | workspaceId、expectedRevision、operationId | jobId、受控构建摘要 |
| creator_code_build_status | jobId | queued/running/succeeded/failed、诊断、BuildId |
| creator_code_test | buildId、fixture/citySnapshot、seed | testJobId、evidenceId |
| creator_code_preview | buildId、cityId、worldRevision、seed | runId、previewJobId |
| creator_code_preview_status | runId | 真正的运行状态、telemetry、错误 |
| creator_code_capture | runId、cameraPose? | 已绑定 Revision 的真实 City 截图 |
| creator_code_inspect | runId、objectId? | 游戏实体 / 世界对象及事件信息 |
| creator_code_interaction_preview | cityId、targetRef、interactionRevision、entry? | 实际绑定到哪个 gameId、presentation、入口及诊断，不启动游戏 |
| creator_code_interaction_simulate | cityId、targetRef、BuildId、expectedInteractionRevision | 在真实 City 注入受控点击/接近事件并返回 launchId/runId/拒绝原因 |
| creator_code_dialogue_trace | runId | 当前对话节点、选项 ID、隐藏敏感值后的分支 Trace |
| creator_game_story_schedule_inspect | cityId、playerScope、gameId、ruleId? | 脱敏规则、下次触发 UTC/City Local、条件/权威状态和事件 Log |
| creator_code_preview_stop | runId、operationId | 停止与全部资源清理结果 |
| creator_code_publish | buildId、manifestVersion、用户授权 | 本地 Release 或安全拒绝 |

P0 默认 Codex 已有获授权的本地工作区文件读写能力；MCP 不重复实现随意写文件的通用工具。MCP 是 Studio/Host 的**控制面**。时间快进只调用 City 文档的 `creator_city_time_preview`，Actor 模拟只调用 `creator_city_agent_actor_simulate`；Game 不再注册第二套同名语义工具，Story Inspector 消费同一 Preview Fork ID 和 Trace。

**前置**：在 §2.1.1 的构建器可交付性解决前，当前 `build`/`test`/`preview` 只证明源码树路径可用，标准安装包的可用性必须由 G-AC32 实测；此时把 G-06 标为“已交付可演示”是不诚实的。

### 6.2 Agent Progress Bridge

Studio 采用统一任务流，但状态必须有实际证据：

~~~ts
interface CreatorTaskEventV1 {
  taskId: string;
  workspaceId?: string;
  phase:
    | "planning" | "editing" | "typecheck" | "building" | "testing"
    | "loading" | "playing" | "reviewing"
    | "succeeded" | "failed" | "cancelled";
  sourceRevision?: string;
  buildId?: string;
  cityRevision?: number;
  runId?: string;
  progress?: number;
  diagnosticIds?: readonly string[];
  previewFrameId?: string;
}
~~~

其中编辑进度来自 Codex/工作区变更；构建来自 Builder Job；真实 City ready 来自 Scene/Viewport；截图来自真实渲染。Studio 不应展示 Agent 内部隐式推理内容，也不能在 Build 仍 queued 时展示“游戏完成”。

### 6.3 可视化调试的两个例子

**塔防游戏发现道路错误**：Codex 从 Game Telemetry 获知敌人路径断开 → Studio 选中 road edge，返回稳定 ID、几何诊断 → 用户若授权修改城市则调用 City SDK Patch Preview/Commit → worldRevision 更新 → 塔防依新世界重新构建路线并重测。

**海底潜艇游戏发现画风不匹配**：当前 City renderProfile 为 realistic-3d，但游戏希望 pixel-3d → Studio 展示兼容性与风格切换选项 → City Runtime 对全部场景启用 pixel-3d → 游戏保留进度，HUD 做高分辨率绘制，真实截图用于验证。

**恋爱剧情入口调试（Story Mode）**：Codex 构建 City Romance → Studio 选中居民「林夏」，在 Interaction Inspector 看见 `interaction:resident-linxia-talk → game.launch(city-romance, linxia-intro, overlay)` → 模拟点击 → City 原场景仍可见并打开 Dialogue 面板 → 测试者点击选项 → Trace 只显示选择 ID 和脱敏状态变化 → 关闭面板验证 City 相机与怪兽点击仍然有效。

**真实时间剧情与角色漂移调试（v2.2）**：Studio 明示当前 UTC、`Asia/Shanghai` 城市本地时间、`clockId/clockRevision` 和 `previewForkId`；开发者从当前星期五快进到周六 18:00，验证已登记约会是否且仅是否出现一次；模拟玩家缺席检查失约分支，再重放同一 occurrence 验证幂等。接着启动「林夏」Actor Turn，Inspector 展示 Canon 摘要、输入 Story Revision、候选台词、受拒 Intents 与有效状态变更；若角色宣称一个从未发生的约会，应标记 Canon/Story Drift，并回退静态对白。整个过程不得改真实 Simulation Clock 或正式玩家关系记录。

Studio 的 Interaction Inspector 复用 City SDK 的 `creator_city_interaction_inspect` / `preview` / `simulate` 和 Game SDK 的运行诊断，不应出现两套互相矛盾的交互绑定写入 API；实际编辑/发布仍走 City Patch 的预览与受控 commit。

**注意**：Game SDK 本身不负责调用 City Patch 写共享世界，也不负责覆盖 RenderProfile。

---

## 7. 本地游戏示例

### 7.1 沿用当前 V1 的 hello-city

当前 games/hello-city/src/index.ts 已能选择可信道路、spawn cube、按 dt 沿点运动、更新 HUD 并以 route_complete 结束；这应作为所有新增 Game v2 集成回归的基础。它是代码游戏真实纵向切片，不应重新开发一套新的 Hello City。

### 7.2 海底潜艇（v2 API 示意）

~~~ts
import { defineGame } from "@oh-agent/city-game-sdk";

export default defineGame({
  id: "community.submarine-explorer",
  setup(ctx) {
    // 新 API 需声明 manifest.apiMajor=2，并由 Host 验证
    if (!ctx.world.supports("navigation.volume")) {
      throw new Error("This City has no underwater navigation volume.");
    }
    const spawn = ctx.world.anchors({ kinds: ["spawn"], limit: 16 }).items[0];
    if (!spawn) throw new Error("Missing submarine spawn.");

    const submarine = ctx.entities.spawn("submarine", { position: spawn.position });
    let distance = 0;
    ctx.onFixedUpdate(dt => {
      const actions = ctx.input.actions();
      const forward = Number(actions.forward ?? 0);
      // 只是说明固定步输入/世界耦合，不是真正的完整水动力学。
      distance += Math.max(0, forward) * dt;
      ctx.ui.setHud({ distance, mode: "submarine" });
      if (distance >= 100) ctx.finish("success", "checkpoint_complete");
    });
    ctx.onDispose(() => { ctx.entities.destroy(submarine); });
  }
});
~~~

这是**预期开发者体验**，其中 world.supports 等为规划 API。实际 V2 游戏还需维护潜艇坐标、运动、碰撞、检查点与资源回收；不能直接拿示例当已可玩的游戏。

### 7.3 同一游戏跨画风

测试矩阵：

| City | Render Profile | 期望 |
|---|---|---|
| Underwater City | realistic-3d | 潜艇和城市材质/阴影正确 |
| Underwater City | pixel-3d | 同一关卡/坐标/输入，像素视觉但数值结果一致 |
| Miami City | realistic-3d | 没有 navigation.volume，应给明确兼容诊断或选择另一玩法 |
| Desert City | pixel-3d | 塔防如果具备 roads/terrain，就应能运行；不依赖海底 Theme |

### 7.4 City Romance：街头点击居民进入文字恋爱游戏（v2.1 新增）

最小纵向切片：City World 中登记 `resident:linxia`、咖啡馆 `place:cafe-01` 和公开交互 `interaction:resident-linxia-talk`；Codex 编写一个 `city-romance` Game，以 `overlay` 模式运行。玩家在街头点击林夏，打开有三个选择的对话；不同选择更新该玩家的好感度/章节标记；再次点击继续剧情，在咖啡馆触发第二章。整个过程中 City 3D 街景保持可见。

其目标 V2 Manifest 应至少声明 `presentation: { supported: ["overlay"], default: "overlay" }`、`world.requiredCapabilities: ["residents.registry", "places.registry"]`、`permissions: ["residents.read", "places.read", "ui.dialogue", "storage.game"]`，并在 `entries` 注册 `linxia-intro` 的 overlay 入口。这些 token 与现有 V1 permission 枚举**不兼容，需同时扩展 Manifest Schema、Host 权限中间层和安全测试**；不因已安装就默认有权读取某玩家的进度。

~~~ts
import { defineGame } from "@oh-agent/city-game-sdk";

// V2 冻结写法示意：同步 setup 注册，当前 dev 仍不可直接运行
export default defineGame({
  id: "community.city-romance",
  setup(ctx) {
    ctx.onStart(async () => {
      if (!ctx.launch || !ctx.dialogue || !ctx.storage) {
        throw new Error("City Romance requires interaction, dialogue and storage APIs.");
      }
      const residentId = ctx.launch.source.kind === "resident"
        ? ctx.launch.source.id : null;
      if (!residentId) throw new Error("Expected a resident target.");
      const key = `relationship:${residentId}`;
      const record = await ctx.storage.get<number>(key);
      const affection = record.value ?? 0;
      const result = await ctx.dialogue.open({
        speaker: { residentId, displayName: "林夏" },
        text: affection > 0 ? "你又来了！" : "你好，第一次见面吧？",
        choices: [
          { id: "hello", label: "打招呼" },
          { id: "coffee", label: "邀请喝咖啡" },
          { id: "goodbye", label: "下次见" }
        ]
      });
      await ctx.storage.compareAndSet({
        key,
        expectedRevision: record.revision,
        value: affection + (result.choiceId === "hello" ? 1 : 0),
        operationId: `${ctx.launch.launchId}:${result.choiceId}`
      });
      ctx.finish("success", result.choiceId);
    });
  }
});
~~~

此示例遵守 §4.4.1：V1 的同步 `setup()` 不直接改成异步，V2 由 Host 调度唯一 `onStart()`。中途取消、世界切换、重复点击、CAS 冲突与提交后取消必须按 G-AC33/G-AC34 验证。面向 MVP，优先实现固定剧情分支和 Storage 隔离，不把 LLM 生成对话设为前置依赖。

### 7.5 City Romance：真实日历 + 定时事件 + 角色会话（v2.2）

场景：在真实 UTC 对应的城市本地周五 19:20，玩家路过咖啡馆并点击林夏；她说「明天傍晚六点海边见」。玩家选择接受，Game Host 写入该玩家好感度/邀约状态及 `ruleId=linxia-beach-date`，Scheduler 登记**城市本地周六 18:00** 的一次性事件，绑定 `place:beach-01`。完成对话后 Overlay Run 结束，Codex Thread 可释放，但邀约仍在持久存储中。

| 到期事实 | Runtime 行为 | 游戏/Agent 能做什么 |
|---|---|---|
| 玩家周六 17:55 在 City 里 | 生成赴约提示或 Place 互动入口 | 玩家自主选择出发；不自动模拟完成 |
| 周六 18:00 玩家在海边 | 检查邀约、地点、玩家 Scope 与 occurrence 去重 | 打开新 Overlay；如获准可请求林夏 Actor Turn |
| 周六 18:00 玩家不在线 | City 按 `offlinePolicy=pause/advance` 推进或暂停时钟，Rule 按 `missedPolicy` 记录待通知或失约状态 | 下次上线显示确定性后果，不能把玩家写成已赴约 |
| Studio 快进到周六 18:00 | 在 Preview Fork 创建事件及分支 Trace | 可测试不同选择，但不污染正式存档 |
| 同一事件重试 3 次 | 相同 idempotency key 命中同一结果 | 不重复扣奖励、不重复增加好感度 |

参考**声明式** Story Rule（非当前 dev 可执行 API）：

~~~ts
const occurrence = await ctx.story!.resolveLocalTime({
  localDate: plannedLocalDate,
  localTime: "18:00"
});
const beachDate: StoryEventRuleV1 = {
  ruleId: "linxia-beach-date",
  version: 1,
  trigger: { kind: "calendar", recurrence: "once", atUtcMs: occurrence.atUtcMs },
  target: { kind: "place", id: "beach-01" },
  requirePlayerAtTarget: true,
  conditions: [
    { key: "relationship.linxia.invited", op: "eq", value: true },
    { key: "relationship.linxia.chapter", op: "gte", value: 2 }
  ],
  action: { kind: "offer-dialogue", eventId: "linxia-beach-meetup" },
  missedPolicy: "expire"
};
await ctx.story!.schedule(beachDate, {
  expectedStoryRevision: currentStoryRevision,
  expectedClockRevision: occurrence.clockRevision,
  operationId: `${ctx.launch!.launchId}:linxia-beach-date`
});
~~~

该示例的 `atUtcMs` 必须由可信宿主通过 `resolveLocalTime()` 根据 City 日历生成，`plannedLocalDate` 来自确定性剧情状态；未绑定日期、时钟 Revision 过期或 CAS 冲突均拒绝调度。**不能由 LLM 临时计算后直接写入正式 Event Log**。初始 P1 纵向切片可只做 1 位居民、1 个邀约、1 个固定失约分支；角色 Agent 作为可插拔体验增强，关掉 Agent 适配器仍能完成整个剧情循环。

---

## 8. 可测试性、权限与安全

### 8.1 测试分级

1. **Types/Build**：tsc --noEmit、受控打包、Manifest Schema、依赖与资源摘要。
2. **SDK Contract**：同城快照、世界能力、宿主权限、API Major 和错误码检查。
3. **Headless**：固定 seed + WorldSnapshot + Input Trace、胜负/实体摘要。
4. **City Host Integration**：Activity Lease、Scene Lease、输入焦点、暂停/恢复、世界失效、幂等清理。
   需额外覆盖 InteractionRouter → LaunchContext、Overlay UI/Input Focus Lease 与独占模式兼容。
5. **Studio Real City**：真实路网、模型、碰撞、HUD、像素/写实截图与帧率。
6. **Fresh Installation**：打包/解包/摘要/权限/安全运行；P2 开放第三方可执行代码前必测。
7. **Temporal Story & Actor**：真实 UTC→City 日历转换、定时事件、DST/离线恢复、去重幂等、Replay/Preview Fork 隔离、会话压缩后的 Canon/Story 一致性与跨玩家隔离。

测试必须包含**失败闭合**：无真实道路不可编造 route，无实际地形不可补 0 高度，不满足 volume 能力不可假装潜艇可以开，Build 失败不返回可运行 BuildId。

### 8.2 安全底线

- @oh-agent/city-game-sdk/host **不是** Sandbox；package exports 字符串不能隔离恶意 JS。
- 当前 useCodeGamePreview.ts 把可信 Bundle import 到 City WebView，P0 仅用于用户明确授权的本地代码。
- 社区下载包不能沿用上述执行模式；需独立低权限 Origin/进程或等价隔离、受限 RPC、资源预算、权限弹窗、签名/来源审查。
- Game Context 永不返回 THREE.Scene、THREE.WebGLRenderer、Tauri invoke、DOM 主窗口、本地磁盘句柄或用户 Agent Session 数据。
- 所有 World/Entity 请求必须在 Host 按 runId、权限、资源拥有者及预算重新验证，不能靠 TypeScript 静态类型。
- 交互 Descriptor 不能携带可执行 JS 回调、任意 URL/Shell 及宿主指令；Runtime 用白名单处理 `game.launch`、`dialogue.open` 等声明动作，公开 `targetRef` 本身不授予玩家读取 NPC 私人状态的能力。
- Story Storage 必须以玩家/City/Game 隔离并控制大小、频率、可导出边界；只允许相应 Game 和经用户授权的 Studio 测试视图读取脱敏进度。所有更新使用 CAS/幂等事务，不允许无条件覆盖。
- `time.read`、`story.schedule`、`actors.interact` 是新增受限权限，不暗示 Game 能写正式 City Time、访问其他玩家记忆或任意启动 Agent 工具；正式 Clock 只允许受权操作修改，Studio 快进永远限隔离 Fork。
- Agent Actor 必须限制 Codex/Claude Code 可调用工具、运行时长、Token 预算及上下文；不向角色会话暴露 Agent Session 原文、API Key、Shell/代码执行或多玩家私有数据。模型输出的 Intent 必须经 Host 审核并记录审计。远程真实用户数据在 §4.8 政策门前禁止，权限声明不等于远程发送授权。
- Story Scheduler 必须使用作用域去重 Key、持久规则与事务性 Event Log；多端/重启/离线回补时不得重复执行游戏奖励或让已经结束的 Run 保有持久写权限。
- 内容摘要/构建身份/世界快照版本绑定；不能运行动态读取编辑中的源码文件。

- **构建器不得只存在于开发机**：打包应用必须能 build/test，否则对外不得宣称“Agent 可闭环”。
- **MCP 写入面文案必须与实现一致**：app 导出的 skill 文案当前写 `never SQL, never files, never URLs`，而 `creator_code_file_write` 就在同一清单里；二者必须择一改正。
- **预览暂存会写仓库目录**：`creator_code_preview` 把产物写进 `apps/agent-city/ui/public/code-games/preview/`，必须有清理策略与“仅 dev”标记。

- 使用 P0 的 GLTFLoader 时校验受控 URL、摘要、大小、资源数、GPU 生命周期；加载失败不应把错误中的敏感本地 URL 回传社区 UI。

### 8.3 错误码（v2.3：以代码为基线）

机器可读权威是 `packages/city-game-sdk/src/protocol/diagnostics.ts`；**新增码必须同 PR 落表**。MCP 只做 `code → 恢复动作` 映射，不发明字符串。

**V1 枚举已声明（21 条；不等于所有运行路径均已发射）**

下表证明机器枚举与对应代码路径存在。实现验收必须逐码记录 throw/emit 位置与测试；例如 `game_world_revision_conflict` 仍待把 `stop("world_changed")` 接入结构化诊断，`game_build_not_trusted` 与 `game_execution_timeout` 当前仅可确认枚举声明，不得据此宣称运行路径已覆盖。

| code | 类别 | 触发 | 恢复动作 |
|---|---|---|---|
| workspace_revision_conflict | 工作区 | 写入/构建时期望修订不符 | 重新读 workspace info / 文件后重试 |
| game_manifest_invalid | 清单 | 字段缺失、类型错、未知字段 | 按诊断路径修 manifest |
| game_manifest_unsupported | 清单 | schemaVersion / apiMajor 不支持 | 升级 SDK 或改 manifest |
| game_entry_invalid | 入口 | 缺 `export default defineGame` 或 id 不符 | 修入口或 manifest gameId |
| game_build_failed | 构建 | esbuild 失败或空产物 | 读相对路径与行列号 |
| game_typecheck_failed | 类型 | tsc 报错 | 按文件/行号修 |
| game_dependency_denied | 构建 | 无法解析的依赖 | 只使用受信任依赖 |
| game_build_not_trusted | 构建 | 构建身份不可信 | 重新受控构建 |
| game_package_integrity_failed | 安装 | 摘要/尺寸不符，或同 id+version 换包 | 重新发布或提升版本 |
| game_sdk_version_mismatch | 运行前 | API major 不符 | 升级 Host 或换 SDK |
| game_asset_invalid | 运行前 | 资产缺失或类型不符 | 修 assets |
| game_permission_denied | 运行期 | 未授权调用 | 在 manifest 里申请该权限 |
| game_entity_budget_exceeded | 运行期 | 超 `limits.maxEntities` | 减少实体 |
| game_ui_budget_exceeded | 运行期 | HUD 超字节预算 | 精简 HUD 快照 |
| game_argument_invalid | 运行期 | 参数类型/范围非法 | 修调用 |
| game_entity_unknown | 运行期 | 未知实体 id | 只用 `spawn` 返回值 |
| game_world_object_missing | 运行期 | 路线/地形不存在 | 先 `listRoutes` 再取，或降级玩法 |
| game_world_revision_conflict | 运行期 | 世界已变、租约失效 | 停旧 Run、重绑定（当前以 `stop("world_changed")` 落地，诊断码待接） |
| game_activity_busy | 运行期 | 活动租约被占 | 等待/停止先前活动 |
| game_runtime_fault | 运行期 | 未分类运行时异常 | 读绑定消息与 telemetry |
| game_execution_timeout | 运行期 | 单步/作业超时 | 拆分计算或降载 |

**待落地（v2 目标，随功能同 PR 加入）**

| code | 归属 | 何时 |
|---|---|---|
| game_world_capability_missing | 能力 | World V2 capability 发现（G-02/G-03） |
| game_render_profile_incompatible | 外观 | RenderProfile（G-07） |
| game_interaction_target_missing | 交互 | Interaction Router（G-10） |
| game_interaction_revision_conflict | 交互 | 同上 |
| game_presentation_unsupported | 交互 | 同上 |
| game_dialogue_cancelled | 对话 | Dialogue API（G-11） |
| game_run_cancelled | 生命周期 | V2 onStart/取消（G-04/G-11） |
| game_storage_denied | 存储 | Storage（G-11） |
| game_storage_revision_conflict | 存储 | CAS/事务（G-11） |
| game_time_domain_invalid | 时间 | Temporal（G-13） |
| game_story_schedule_conflict | 剧情 | Story Scheduler（G-13） |
| game_story_event_missed | 剧情 | 同上 |
| game_actor_intent_denied | 角色 | Actor Bridge（G-14） |
| game_actor_session_unavailable | 角色 | 同上 |
| game_actor_remote_unavailable | 角色/数据政策 | 远程政策门未开放时请求真实用户数据（G-14） |
| game_preview_unavailable | 预览 | 真机预览作业（G-06） |
| game_package_untrusted | 发布 | UGC 沙箱（G-09） |

> 与 City 文档 §9.3 的划分：**产生方抛码**——生成器/世界几何/时钟问题由 City 侧 `city_*` 抛出，游戏运行时问题由 Game 侧 `game_*` 抛出；消费方只做映射，不重抛另一域的码。`city_actor_intent_denied` 仅用于 City 公共世界动作（如 move/interact）被 City Router 拒绝；`game_actor_intent_denied` 仅用于玩家作用域剧情 Intent 被 Narrative/Game Host 拒绝，二者不得互作同义别名。

---

## 9. Game Experience 与跨 City 安装

**v2.3 与实现对齐**：当前已落地的是 `kind:"code-game-experience"`、`schemaVersion:1`（bundle + 资产 + 权限 + world 绑定 + 逐文件 `sha256` + 规范化 `contentDigest`）；`publish` 与 `install` 分离，安装只登记本地库，不授予执行权。

**v2.5 Registry 对齐**：Experience 是不可变包格式，InstalledGameV1 是 Runtime 安装读模型，两者不混用。安装时由 Declarative/Legacy/Code Adapter 生成 Shared Contracts §6.1 的统一记录，包含 installationId、contentDigest、trustLevel、status 和 entries；安装记录仍不等于 Host Grant，启动前必须另行授权。

**v2.2 原表述**：P0 只发布本地可信开发 Build；P1 产生有摘要的本地 Experience；P2 才允许未知第三方可执行代码包通过沙箱被安装/运行。

**V2 增量（目标）**：`schemaVersion:2` 增加 `signature`、`trustLevel`、`minHostVersion`、`worldCapabilities`；在此之前不得把 v1 包称作"可信来源"。

Experience 打包必须包括：

- CodeGameManifestV2、游戏 bundle、资产摘要、SDK/API major、BuildId、运行时最低版本；
- World Capability Requirement，而非强行依赖固定 Miami City ID；
- 受信任代码来源、签名与权限说明（正式公开前强制；**现状：只有 `contentDigest` + `provenance.buildId/sdkVersion`，无签名/信任级别/最低宿主版本**）；
- 明确不包含用户 City 私有 Session 数据；
- 使用内容摘要确定 immutable bundle；安装不代表立即执行。

多城市游戏兼容策略：

1. 无特殊环境依赖的游戏（例如塔防）：检查 roads.read、terrain.sample、适合的 route graph 和地块条件。
2. 环境特定游戏（例如潜艇）：检查 underwater biome、navigation.volume 等能力。
3. 环境外观只能影响渲染体验；默认不作为胜负的输入。
4. 游戏附带可选 City Theme/World 建议，但不得未经授权安装或修改用户城市。
5. 恋爱/剧情游戏：声明 overlay 支持、居民/地点所需的公开能力、Dialogue/Storage 最小权限；安装 Game 不自动向用户 City 注入 NPC，新增角色和交互必须经过 City Creator 显式安装/绑定。
6. 定时剧情：Manifest 声明 `time.read`、`story.schedule`、支持的 City 时间域及最小宿主版本；安装/卸载必须有持久规则的迁移、停用和用户告知方案，禁止卸载后残留隐形事件。
7. Agent Actor：Manifest 只引用经授权的 Actor Adapter、Character Canon ID/Version，不打包 Codex 会话、API 密钥、玩家私密记忆或未经审计的执行权限。

---

## 10. 代码变更清单（建议按 PR 交付）

**当前状态（v2.3 核对）**：下面 15 个 Epic 里 **0 个完全达成、7 个部分、8 个未开始**（按各自验收项判定，不是代码行数）。“部分”指有骨架但验收项未满足——例如 G-06 有 build 却没有 capture，G-08 有 hello-city/塔防却没有潜艇/跨画风。**另需先做 §2.1 的四条前置。**

| Epic | 必须修改/新增 | 验收 |
|---|---|---|
| G-01 共享世界 DTO | packages/city-game-sdk/src/api/types.ts、Shared TS+JSON Schema、WorldSource adapter、依赖新 @oh-agent/city-sdk | 不再独立复制 Shared DTO；V1 仍通过 |
| G-02 Manifest V2 | protocol/manifest.ts、permissions.ts、Grant、InstalledGameRegistry、version.ts、diagnostics.ts、Capability 映射、entries | Capability/Request/Grant 三轴校验，统一安装读模型，支持 biome、volume、Render Profile 与注册入口 |
| G-03 WorldSource V2 | City live/World snapshot 双适配器、WorldHeader/Query/Asset、测试 fixture | 同一 snapshot 的 route/terrain/object/volume 语义一致，完整 Snapshot 不进入逐帧 API |
| G-04 Host 能力增量 | host/codeGameHost.ts、ports、onStart/AbortSignal、资源清理 | 新权限严格复验；异步取消与有界清理闭合；Style-only 更新不重启 Game |
| G-05 编译/作业 | scripts/buildGame.ts、Workspace Service、tsc job、构建缓存 | TypeScript 报错能定位，BuildId 不可变 |
| G-06 Creator MCP | Rust creator_studio.rs、creator_session.rs、Studio UI | 真正的 build/status/preview/capture/stop |
| G-07 Render/GLB 兼容 | threeRenderPort.ts、City Engine RenderProfile Adapter | 模型正常加载且像素化统一，切换无资源泄漏 |
| G-08 端到端作品 | hello-city 回归、塔防、潜艇最小案例 | 在真实 City 中可玩、可诊断、可干净退出 |
| G-09 发布与安全 | code-game experience + sandbox（后续） | 第三方代码仅在隔离环境执行 |
| G-10 Interaction Bridge | CityEngine 点击适配、CityInteractionRouter、LaunchContext、Manifest presentation | 怪兽→战棋行为不回归；任一注册居民能启动指定 Game Entry |
| G-11 Dialogue / Story Storage | 受控 Dialogue UI、CAS/事务 Storage Port、Place/Resident Read API、Overlay UI/Input Lease、Narrative Port | 三选项剧情可关闭/重进，不泄露或覆盖玩家私有好感度，不抢走 City 相机 |
| G-12 Studio Story Mode | City Interaction Inspector、模拟点击、Dialogue Trace、Codex 构建反馈 | 在真实 City 中看到 NPC 对话、分支和租约释放的证据 |
| G-13 Temporal Story Scheduler | 共享 City Temporal Snapshot、Story Rule Registry、持久 Scheduler、Event/Story/Outbox 原子事务、离线/去重策略 | 真实 UTC 默认 1:1、周六 18:00 定时赴约、重试不重复、崩溃可恢复、关闭 Run 后事件仍有效 |
| G-14 Agent Actor Bridge | 独立 Narrative Engine、Actor Adapter（可选）、Canon/Story State Hydrator、统一 Intent Validator、审计及超时兜底、远程数据政策门 | 合成 Preview 可断开重建且不漂移；真实远程数据在政策开放前稳定拒绝，不越权修改 City 或玩家关系 |
| G-15 Studio Temporal Story Inspector | Preview Clock Fork、Calendar Schedule Inspector、Actor Turn Trace、漂移诊断及回放隔离 | 3 天快进/离线/失约/Actor Drift 调试不改变真实用户状态 |

推荐执行顺序（v2.5，与 City 文档 §11 和 Shared §11 对齐）：**Shared F0（TS + JSON Schema + 跨包 CI）→ §2.1 四条前置 → B P0-01（改名含 runtime 兼容）/P0-02（World V2、Capability、Resolved Generator）→ B P0-03/P0-05（Builder/Snapshot V4）→ G-01/G-03 → G-02（Manifest、Permission 映射、entries）→ G-05/G-06 → G-04/G-07 与 B P0-04 → G-10/B P0-08（Interaction）与 G-08/B P0-07（真实作品，可并行；Interaction 案例必须先等 G-10）→ G-11/G-12（固定剧情与 CAS Storage）→ G-13/G-15（Temporal/Narrative）→ G-14（Actor，真实远程数据另等政策门）**。B P0-06 与 G-05/G-06 是同一构建/作业闭环的 City/Game 两个适配面。G-09 始终是独立安全门；不得再把 Interaction 排在 entries/Manifest V2 之前。

---

## 11. 验收矩阵（必须执行，不只看 API 是否存在）

| ID | 结果判定 |
|---|---|
| G-AC01 | 现有 hello-city 的 V1 Manifest、SDK Host 和真实 City 浏览器集成不回归 |
| G-AC02 | 新 V2 Game 使用同一 City SDK 世界 DTO，不存在坐标、单位或 revision 漂移 |
| G-AC03 | 不同城市的世界能力发现正确，缺失 underwater volume 给稳定诊断 |
| G-AC04 | tsc 制造一个错误、Studio Build Job 返回失败与文件行号，修复后生成新 BuildId |
| G-AC05 | 真实 City 内塔防至少 3 波，敌人沿可信路网行进，不改 CityEngine 的塔防专用分支 |
| G-AC06 | 真实海底 City 内看到潜艇，输入/相机/HUD/检查点可用 |
| G-AC07 | 切 pixel-3d → realistic-3d，不改变固定 seed/input trace 的游戏胜负与世界拓扑摘要 |
| G-AC08 | 游戏期间修改道路 worldRevision，旧 Run 被停止/失效，不继续写新城市 |
| G-AC09 | start → stop 连续 10 次，Entities/GLB/输入/HUD/事件/SceneLease/ActivityLease 无泄漏 |
| G-AC10 | Studio 不在时能完成代码构建和 headless test，但拒绝伪造真实视觉成功 |
| G-AC11 | 编译插件/脚本、外部 URI、绝对路径、过量实体、未授权世界读取均失败关闭 |
| G-AC12 | Legacy MiniGame/Experience V1、Miami flight/driving/mecha/cinema 不因重命名/新 Host 退化 |
| G-AC13 | 既有怪兽点击区域、遮挡和点击判定不变，迁移为稳定 Interaction Target 后仍进入相同战棋入口（exclusive） |
| G-AC14 | 新注册居民的 interactionId 定位到对应 Game ID / entry；未安装游戏或 target 消失时显示确定性错误，不崩溃 |
| G-AC15 | Overlay 恋爱对话开启时仍能看到当前 City 建筑/道路/居民，关闭时不销毁或重建 City Scene/Camera |
| G-AC16 | 选择对话更新对应玩家的独立 Storage；两位玩家、两款游戏互不可读，WorldPackage 导出不带好感度 |
| G-AC17 | 打开/关闭 Overlay 对话 10 次无 UI/Input Focus Lease 泄漏，无点击透传、重复启动或悬挂 Promise |
| G-AC18 | 只改 interactionRevision 不误判世界路网冲突，真正修改道路仍触发 game_world_revision_conflict |
| G-AC19 | Studio 从真实居民对象选择→绑定检查→模拟点击→分支 Trace→关闭，全程具备 BuildId/City Revision/RunId 证据 |
| G-AC20 | City Simulation Time 在正常 Live 模式按可信真实 UTC 1:1 推进；固定 City IANA 时区下，宿主系统切换时区不改变剧情时间与约会 occurrence |
| G-AC21 | 拖动旧 Agent Session Timeline Replay Cursor 不触发 `story.schedule`、奖励、NPC 行动或关系变化；Game Fixed Step 不改变 City 日历 |
| G-AC22 | Studio 将周五快进到周六 18:00，只在 Preview Fork 创建约会与 Dialog Trace；退出后正式 Simulation Clock、Story Revision 与玩家进度均未变更 |
| G-AC23 | 游戏对话 Run 结束/宿主重启后，已登记的邀约在真实周六 18:00 正确触发；同 occurrence 连续 3 次重试只结算一次 |
| G-AC24 | 玩家离线 72 小时，City 分别按 pause/advance 推进或暂停，Rule 分别按 skip/reschedule/expire/persist 恢复，不虚构到场、不产生无界补发；DST、系统回拨与异常前跳不重复派发，异常前跳标记 clock_uncertain |
| G-AC25 | Codex Actor Thread 断开/压缩/重建后，林夏性格、认识玩家的状态和已完成章节从 Canon/Story State 恢复，模型编造事实的 Intent 被拒绝 |
| G-AC26 | 两个玩家、两款游戏同时与同一 NPC 对话时，按 playerId/cityId/gameId/residentId 隔离私有好感度、对话记忆和会话 ID；只有公开 City 事实可见，冲突修改按 CAS/授权事务仲裁 |
| G-AC27 | Codex/Claude Actor Adapter 超时、超过 Token 预算或输出恶意 Intent 时稳定降级到固定对白，无任意文件/Shell/Session 原文权限，正式剧情状态不丢失 |
| G-AC28 | 打包应用内 `creator_code_build` 能产出 buildId（不是 `data_unavailable`）；`test`/`preview` 同样可用 |
| G-AC29 | build 后改工作区 manifest 或替换资产，旧 buildId 的 test/preview/publish 仍只使用冻结产物并复现旧摘要，不得读取新文件；冻结文件缺失/篡改用 `game_package_integrity_failed` 拒绝，新文件必须生成新 BuildId |
| G-AC30 | headless telemetry 携带所用世界身份（cityId/cityRevision 或 snapshotDigest），且测试世界可由目标 City 的 snapshot 投影 |
| G-AC31 | app 导出的 MCP skill 文案与实际写入面一致，或 code-game 写入被单列授权并写明 |
| G-AC32 | 开发仓库、干净 macOS 安装、无全局 Node、无源码目录、CLI/MCP 独立启动五种环境分别验证 Build/Test；正式 App Preview 由真实 City 托管，失败范围有实测记录，不依赖源码树 public 目录 |
| G-AC33 | onStart 在 Dialogue、Actor Turn、Storage await 期间被取消时均稳定落定；恢复写操作重新鉴权，重复 launchId 不重复启动，异步清理超时后所有租约仍释放 |
| G-AC34 | 两个并发关系更新只有一个 CAS 成功，另一个收到 game_storage_revision_conflict；operationId 重试不重复提交，跨键状态与 Event Log 同成功或同失败 |
| G-AC35 | Actor allowedIntents 与 proposedIntents 共用 ActorIntentV1；远程政策未开放时真实 playerMessage/关系记忆绝不离开本机并返回 game_actor_remote_unavailable，合成 Preview 与固定剧本仍可用 |
| G-AC36 | Capability/Permission 映射与 V1 适配通过契约测试；语义环境、天气、Place、Resident 变化更新各自 Revision，纯视觉变化不重建 World，影响导航的 medium 变化停止或迁移受影响 Run |
| G-AC37 | 静态水体与 ring Volume 可分页查询，线段穿越判定确定且可重放；未声明 navigation.volume 时不得伪报三维寻路成功 |
| G-AC38 | Game API 只返回 WorldHeader 与有界查询，Snapshot 数组不进入逐帧调用；旧 Cursor 在 snapshotDigest 变化后失败，资产按 ID+digest 校验读取 |
| G-AC39 | 无 Capability、未申请、未授予分别失败；Declarative/Legacy/Code Adapter 均经统一 InstalledGameRegistry 与 Router，Host Grant 撤销后晚到回调不能写入 |
| G-AC40 | Actor 在事务外生成，崩溃重试后 Event/Story/奖励/Outbox 仅提交一次；processing 不等于事实发生，晚到回调不能写已释放 Run |

---

## 12. 交付阶段与优先级

**P0 — 代码游戏真实城市闭环 + Interaction 兼容**：先完成 §2.1 的四条落地前置（构建器可交付、build 绑定 manifest/资产、headless 绑定 City、MCP 写入文案），再做 Shared City 契约、Game Manifest v2、Capability/Request/Grant、统一 InstalledGameRegistry、可观察的 Build/Test/Preview 作业、真实 City 渲染、静态 Volume 查询与基础穿越判定、旧案例回归，以及 City Interaction Router、稳定 LaunchContext、怪兽→战棋旧入口的行为一致回归。hello-city 与塔防已经可跑，P0 的增量是“在打包环境里也可跑 + 世界身份可追溯”；**P0 不以完整恋爱游戏或完整三维寻路为验收前置**。

**P1 — 海底/复杂环境 + Story/Overlay 游戏**：navigation.volume、可选物理/碰撞、潜艇实例、更多 UI 和资产能力、稳定的渲染风格适配；新增只读 Place/Resident、Overlay UI/Input Focus Lease、Dialogue/Choice、带 CAS/事务的隔离 Game Storage、独立 Narrative Engine、Studio Story Mode 与 City Romance 固定剧情 MVP。在这个基础上按顺序加入 **Temporal Story Scheduler（默认真实时间 1:1，City 时区决定日历）→ Studio 隔离快进预览 → 可选 Codex Agent Actor Adapter**。P1 Actor 只做单 NPC 纵向切片，且不阻断纯固定剧本游戏；真实远程用户数据必须在 §4.8 政策门开放后才可发送。

**P2 — 社区可执行 UGC**：独立沙箱、签名与供应链校验、权限授权、分发、Remix、跨城市兼容升级与回滚；扩展跨城长线剧情、多 NPC Actor 和更复杂的调度公平性。

阶段门槛：未通过真实 City/Studio 预览的功能不得标为可玩；未通过隔离与权限测试的外来代码不得标为社区安全可安装。

---

## 13. 两个 SDK 的最终关系

~~~text
@oh-agent/city-sdk             负责：World / Generator / Theme / RenderProfile /
                                Snapshot / Patch / Place / Resident /
                                Interaction Descriptor / Asset Contract / Validation /
                                City Temporal Contract / Agent Actor Identity
              │
              └── 只读世界契约 →

@oh-agent/city-game-sdk        负责：defineGame / GameContext / Entity Scope /
                                Input / Event / HUD / Dialogue / Story Storage /
                                GameLaunchContext / Story Rule API / Actor Bridge /
                                Game Host / Playtest
              │
              └── 使用可信 City Runtime →

Narrative Engine             负责：Story Graph / Canon / Arc / Director /
                                Episodic Memory / Reflection；不直接进入 SDK

Creator Studio + City Engine   负责：真实生成、渲染、编辑、作业、截图和运行证据
                                以及 Interaction Router、Overlay/Exclusive 租约；
                                Runtime 统一 Simulation Clock、持久 Story Scheduler；
                                Studio 隔离 Preview Fork、Actor Intent/Drift Inspector
~~~

**判断 SDK 是否成功的唯一标准，不是 TypeScript 类型越多越好，而是：Codex 新建一种城市或一种游戏时，不再需要为每一种海底/沙漠/塔防/潜艇组合去修改 CityEngine 的专用逻辑分支。**

**v2.2 补充原则**：正式游戏时间以现实 UTC 为默认基准；City 本地日历控制周几/几点触发；长期事件属于持久 Story Scheduler；Codex/Claude 只扮演人物并提出意图，不能成为存档、时间轴或剧情既定事实的权威。

**v2.4 原则保留**：Capability/Permission 分型、分源；Build 自包含且不可变；同步 setup + 唯一 onStart；Storage CAS/幂等；Narrative Engine 独立；远程 Actor 数据政策门未开放时失败关闭。

**v2.5 单一规范原则**：公共字段、子 DTO、Grant、Revision、事务、Registry 和生命周期只在 Shared Contracts RFC 中修改。Game API 只读 Header、有界查询与按摘要资产；破坏性变更进入 Shared Contracts v2、兼容评审与机器契约测试。

本文件交付的是基于当前 dev 源码的 v2 需求、协议与迁移计划；未修改 dev 仓库代码、未发布 npm 包，且没有把静态审查误写成已通过实机测试。
