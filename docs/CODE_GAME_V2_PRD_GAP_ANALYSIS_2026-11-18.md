# 两份 City/Game SDK v2 PRD-RFC 与 dev 实现的差距评估

> **评估基线**：`Oh-Agent-AI/oh-agent` @ `dev` = `1373b496`（2026-11-18 18:23:33 +0800，与 `origin/dev` 同一提交，工作树干净）。
> **被评估对象**
> - **A** = `Oh_Agent_City_Game_SDK_v2_PRD_RFC_2026-11-18 (1).md`（v2.2，849 行）
> - **B** = `Oh_Agent_City_SDK_v2_PRD_RFC_2026-11-18.md`（v2.2，784 行）
> - 两份文档落盘时间均为 18:47，晚于 HEAD 的提交时间 18:23。
> **方法**：静态读码 + 符号级 grep（`packages/`、`apps/agent-city/ui/src`、`crates/`）+ 读 CI 验证脚本。**未**启动 Studio、未跑 CI、未做真机截图。判定口径是"代码里有没有这条路径"，不是"这条路径是否通过实机回归"。
> **边界**：只评估差距，不改动任何产品代码；本文件是新的评估产物。
> **修订版**：本报告的两条修订建议已落成新稿 —— `docs/AGENT_CITY_GAME_SDK_V2_PRD_RFC_2026-11-18.md`、`docs/AGENT_CITY_SDK_V2_PRD_RFC_2026-11-18.md`（v2.3，2026-11-18）。

---

## 0. 结论摘要

1. **目标面站得住，盘点面已过期。** A 的 §1.1 表 19 行里 15 行完全一致、2 行部分一致、2 行与 HEAD 不符（`buildGame.ts` 已自带 typecheck、`creator_code_*` 工具族已存在）；B 的 §1 表 16 行全部能在代码里找到对应，只有 CLI 行不完整。**两份文档都系统性低估了 11-18 当天最后 3 个提交的产物。**
2. **目标能力几乎全空：文档自己的 28 个 epic 里，0 个完全达成、10 个部分、18 个未开始**（见 §2.4）。A 的 Game API v2 / Interaction Bridge / Dialogue / Storage / Temporal / Agent Actor，B 的 WorldDefinitionV2 / WorldGeneratorV1 / SnapshotV4 / ThemePackV2 / RenderProfileV1 / Place-Resident / Interaction / Temporal / Actor —— 对这些符号的 grep 在三个代码根里 **0 命中**。这是"未开始"，不是"部分实现"。
3. **代码在文档没写的方向上更远。** 代码游戏已有 `create → 读写源码(内容 CAS) → typecheck+build → headless 试玩 → 真机 Playwright 预览 → 发布 immutable experience → 安装(逐文件摘要复核)` 的闭环 + 14 个 MCP 工具 + **4 个验证脚本（其中 2 个进 CI：`loop`/`publish`；`city-loop`/`preview` 需 Vite+Playwright，本地跑）**；还有文档完全未提的第三包 `@agent-vitals/city-game-runtime`。**但这个闭环只在源码树里成立**（见 §2.5）。
4. **最大风险不是"没实现"，是三个结构性缺口**：
   - (a) **两套游戏抽象并存**：`MiniGamePackV1`/`GameTypeDescriptorV1`/`GameRuntimeV1`（city-sdk + city-game-runtime）vs `CodeGameManifestV1`/`defineGame`/`CodeGameHostV1`（city-game-sdk）。两份文档都没有提到前者，也没有收敛策略。
   - (b) **Run 绑定缺身份**：一次 Run 只有 `worldRevision`/`layoutId`，没有 `cityRevision`、`snapshotDigest`、`interactionRevision`；dev 预览里 `cityId` 兜底为字面量 `"city:dev"`。
   - (c) **缺玩家身份**：v2.1/v2.2 的 Storage/Dialogue/Story/Actor 全部按 `playerId × cityId × gameId` 隔离，但 Code Game 路径上不存在任何 player identity（`playerId` 只出现在 remote 会话与 mecha 对局里）。
5. **两份文档互相/内部都有硬矛盾**，按它们排期会撞车：DTO 命名两套、权限词表两套、A 的 G-01 排在 B 的 P0-02/P0-05 之前——而 G-01 要交付的正是 P0-02/P0-05 的产物。
6. **在 v2 清单之前还有四个更底层的落地问题（见 §2.5）**：构建器出不了开发机（只在源码树可用）、buildId 不绑定 manifest 与资产（旧 bundle + 新 manifest/新资产可组合）、无头试玩用合成 20 m 世界（不绑目标 City）、对外 MCP 文案声称"never files"但已有写文件的工具。前三条不修，G-05/G-06 与 headless 验收都建立在沙上；第四条是信任面。

---

## 1. 文档 §1「当前 dev 盘点」对账

### 1.1 A（Game SDK）§1.1 逐行核对

| # | 文档说法 | 代码事实 | 判定 |
|---|---|---|---|
| 1 | `@oh-agent/city-game-sdk` v0.1.0，入口 `. /host /protocol /testing` | `packages/city-game-sdk/package.json:2,13-30` 完全一致 | ✅ |
| 2 | `defineGame` + `GameContextV1`（world/entities/input/events/ui/audio/clock/random） | `src/api/types.ts:140-152`；`src/api/defineGame.ts:21` | ✅ |
| 3 | 有 `entity.clicked`/`zone.entered`/`ui.action` + `setHud`；无 Interaction/Dialogue/Storage | `src/api/types.ts:93-97,111-115`；无相关符号 | ✅ |
| 4 | `CodeGameManifestV1` 严格校验；`requiredCapabilities` 词表窄 | `src/protocol/manifest.ts:25-40,124`；`permissions.ts:13` 仅 `world.read/roads.read/terrain.sample` | ✅ |
| 5 | 权限与 anchor travel capability 是两套语义 | `src/protocol/permissions.ts:1-12` 注释即此意 | ✅ |
| 6 | Host：生命周期、固定步、Run-owned 实体、权限复验、HUD、诊断、清理 | `src/host/codeGameHost.ts:60-63,144-200`；`tests/lifecycle.test.ts` 10 例 | ✅ |
| 7 | `ClockAPIV1` 固定 dt + 诊断 `nowMs()`；Host 默认 `() => 0` | `src/host/codeGameHost.ts:119`；`api/types.ts:122-128` | ✅ |
| 8 | `host/types.ts` 的 WorldSource/RenderPort/Options/Telemetry | `src/host/types.ts:19-81` | ✅ |
| 9 | `buildGame.ts` 固定 esbuild；**文件注释明确"不做 typecheck"** | 注释仍在（`scripts/buildGame.ts:18-20`），但代码**已内联 tsc**（`:89-92`、`:219-281`，commit `5641339e`） | ❌ **过时** |
| 10 | `codeGameSession.ts` 联 Activity/Scene Lease/固定步/清理；**须继续遵守世界 revision 与活动独占** | 有 `tryAcquire("code-game")`（`:234`）、`lease.isCurrent()`→`stop("world_changed")`（`:208-211`）；但**没有** revision 级诊断 | ⚠️ 部分 |
| 11 | `CityEngine.setTimeCursor` 是 Session 回放游标 | `apps/agent-city/ui/src/engine/CityEngine.ts:1594`，`cursorMs` 语义见 `:238` | ✅ |
| 12 | `CityEnvironment.sample(timestampMs)`，实时来自 `Date.now`，默认 host-local | `CityEnvironment.ts:11,25-29`；调用点 `CityEngine.ts:203,2361` | ✅ |
| 13 | `addEncounterTarget`/`handleClick`/`playableKind`/`playableAt`/`onPlay` | `CityEngine.ts:1629-1637,1723-1747,1762` | ✅ |
| 14 | `useCodeGamePreview` 把可信 Bundle 经 Blob 进真实 City | `useCodeGamePreview.ts:113-119`**且**只有 DEV 才由 URL 参数触发（`CityApp.tsx:387-413`）——比文档描述更严格 | ✅ |
| 15 | GLTFLoader 预加载、克隆复用、Run 退出释放 | `threeRenderPort.ts:97-99,125-134,141-142` | ✅ |
| 16 | live 投影上限 16 路 / 每路 256 点 / 256 锚点 / 128 地块 | `cityEngineWorldSource.ts:39-42` 完全一致 | ✅ |
| 17 | snapshot 投影：V2 无几何拒绝，不杜撰路线/地形 | `cityWorldSource.ts:44-49,81` | ✅ |
| 18 | `games/hello-city` 是 manifest+TS 样本 | 存在；但**漏了 `games/tower-defense`**（185 行，3 波 ×5 敌人，已进 CI） | ⚠️ 不完整 |
| 19 | `creator_studio.rs` **尚无 `creator_code_*` 构建与试玩工具族** | 就文件而言属实——工具不在 `creator_studio.rs`，在 `creator_code.rs` / `creator_code_workspace.rs` / `creator_code_experience.rs`，共 **14 个工具**，已在 `mod.rs:109-110,293-300` 注册 | ❌ **能力盘点结论错误**（"这个文件没有" ≠ "工具族不存在"） |

### 1.2 B（City SDK）§1 逐行核对

16 行全部可在代码里定位（`@agent-vitals/city-sdk` 0.1.0 + `/runtime`、`CityGeographyGeneratorV1` 闭集、`exactKeys` 严格校验、能力参数目录 + 构建期 `assets/creator/*.json`、`validateWorldPlanPatch`、`CityLayoutSnapshotV3`、`CitySkinPackV1`、CLI、CityEngine 渲染管线、Raycast 点击、`cursorMs`、`city-timeline`、`CityEnvironment.sample`、`ClockAPIV1`）。

两处不完整：

| 文档说法 | 代码事实 | 影响 |
|---|---|---|
| CLI「已有 init city-world / init city-project / validate-world / pack-world / verify-world」 | 另有 `validate`、`asset inspect/import/verify`、`sync-refs`、`playtest`、`pack`、`verify`（`bin/oh-agent-sdk.mjs:758-829`）；**且没有** `city build/test/preview` | 目标 CLI 是新增，判定正确；但盘点清单不完整 |
| `creator_studio.rs`「create / create_from_world / patch preview / commit / view / capture 等已存在」 | 属实，且更多：`creator_scene_*`、`creator_vehicle_*`、`creator_playtest_*`、`creator_job_*`、`creator_experience_*` | 判断正确（B 的问题在别处：完全没提 `creator_code_*`，见 §3 第 2 行） |

### 1.3 文档 §1 未覆盖、但代码已存在的东西（反向 gap）

| 代码 | 是什么 | 文档覆盖情况 |
|---|---|---|
| `crates/agent-vitals-mcp/src/mcp/creator_code_workspace.rs`（757 行） | 受控工作区：`project_create`（仅 `hello-city` 模板）、`file_read/write`（内容 CAS + 路径逃逸防护 + 256 KiB/64 KiB 预算）、`build`、`preview`、`test` | A §1 说"没有"，§6.1 列为"目标、尚未实现" |
| `creator_code.rs`（228 行） | 只读状态面：`builds_list`、`build_status`、`preview_status`（`preview.json` + 120s stale 判定） | 同上 |
| `creator_code_experience.rs`（506 行） | `publish`（冻结 bundle + 资产 + 权限 + world 绑定 + 逐文件摘要 + 规范化 `contentDigest`）、`experience_list/install/uninstall`（安装重算摘要、同 id+version 换包拒绝） | A §9 把它写成"P1 才产生"，且命名为 `CodeGameExperienceV2`（代码是 `kind:"code-game-experience", schemaVersion:1`） |
| `apps/desktop/src-tauri/src/creator_code_game.rs` | WebView→文件桥：把 `code-game.state` 收敛成有界白名单后原子落盘，供 MCP 读 | 未提 |
| `games/tower-defense/` + `docs/CODE_GAME_AGENT_LOOP_2026_11_18.md` | 一个 DSH subagent 独立写完的塔防（含一轮"玩法失败→调参→成功"的真实反馈），已进 CI | A §12 仍写"P0 建议先完成 hello-city V2 和一个简单塔防" |
| `scripts/verify-code-game-{loop,city-loop,preview,publish}.mjs` | 四段验证，但**只有 2 段进 CI**：`verify-code-game-loop.mjs`、`verify-code-game-publish.mjs`（`verify.yml:134,138`）；`verify-code-game-city-loop.mjs` 与 `verify-code-game-preview.mjs`（Playwright + 自起 Vite）不进 CI，只能本地跑 | A §11 没引用这些脚本（G-AC05/G-AC10 事实上已有对应实现） |
| `packages/agent-vitals-city-game-runtime/`（311 行） | **第三套东西**：`GameRuntimeV1` 契约 + `GameRuntimeRegistryV1` + scene/input/audio/clock/activity ports + Miami 四活动 catalog + `FlightCheckpoint` 类型 | 两份文档 **0 提及** |
| `packages/agent-vitals-city-sdk/src/gameTypes.ts` | `GameTypeDescriptorV1`（slots/parameters/assetRoles/runtime 契约）+ `validateGameTypeDescriptorV1` | 0 提及 |
| `packages/agent-vitals-city-sdk/src/content.ts` / `runtime.ts` | `MiniGamePackV1`、`compileRules`/`createRun`/`runHeadless`（规则级无头运行时） | 0 提及 |
| `packages/agent-vitals-city-sdk/src/vehicleProfile.ts` | `VehicleProfileV1`（物理/相机/性能推导 + bounds 校验）+ 4 个预设 | 0 提及 |
| `apps/desktop/src-tauri/src/embedded_city_sdk.rs` | 宿主内 QuickJS 跑 city-sdk 语义闸（同一条 import 链打包） | 0 提及 |
| `CityEngine.applyCreatorSkin()`（`CityEngine.ts:769-780`） | 可逆的 Creator skin 覆盖租约（`miami-vice`/`desert-evening`，带 owner token） | B §5.1 只说"硬编码 Creator Skin"，未提这个可复用的 appearance lease 雏形 |

---

## 2. 目标能力 gap 矩阵

等级：**P0** = 阻塞 P0 闭环或与现状冲突；**P1** = v2.1/v2.2 主线；**P2** = 社区/远期；**D** = 纯文档问题。

### 2.1 Game SDK（A §3–§4）

| 文档要求 | 代码现状 | 等级 |
|---|---|---|
| `CodeGameManifestV2`（`schemaVersion:2`、`citySdk`、`render.compatibleProfiles`、`presentation.supported`、`compatibleBiomes`、`minSnapshotSchema`、`binding`） | 只有 V1：顶层键闭集 11 个（`manifest.ts:50-62`），schemaVersion 只接受 1（`:142`） | P0 |
| `WorldAPIV2`（`capabilities/supports/listRoutes(query)/getRoute/listAnchors(query)/sampleTerrain/queryObjects({bounds,kinds,limit})/environment/renderProfile`） | `WorldAPIV1` 6 个方法，`getRoute` 抛 `game_world_object_missing`，`queryObjects` 只收 `WorldBoundsV1`（`api/types.ts:46-55`） | P0 |
| `GameContextV2`（`world: WorldAPIV2`、可选 `launch/dialogue/storage/cityTime/story/actors`、`onAppearanceChanged`） | `GameContextV1` = 8 个只读子 API + `onFixedUpdate/onDispose/finish`，无任何可选增量（`api/types.ts:140-152`） | P0（v2.1/P1 分批） |
| `GameLaunchContextV1`（`launchId/cityId/worldRevision/interactionRevision/source/entry/presentation`） | 无；Run 只知道 `CitySnapshotV1{cityId,seed,worldRevision,layoutId}` | P0 |
| `DialogueAPIV1.open()` 返回 Promise、Host 渲染受控对话 | 无 `ui.dialogue`、无对话面板、无 `Promise` 取消语义 | P1 |
| `GameStorageAPIV1`（`playerId × cityId × gameId` 隔离） | 无；且没有 playerId 来源 | P1 |
| `CityTimeReadAPIV1` + `StoryEventAPIV1`（`schedule/cancel/list`、`StoryEventRuleV1`、`offlinePolicy`、去重键） | 无；`ClockAPIV1.nowMs` 明写"仅诊断" | P1 |
| `AgentActorAPIV1.requestTurn`（Canon/StoryState/Intent 校验） | 无 | P1（A 自己排在最后） |
| `onAppearanceChanged` / 切换画风不重启 Game | 无 RenderProfile 概念；`applyCreatorSkin` 是全局主题覆盖，与"Game 声明兼容画风"无关 | P1 |
| 三个事件源：World geometry changed / Appearance changed / Build changed | World changed **有**（`stop("world_changed")`，`code-game-session.test.ts:190`）；另外两个没有 | P1（1/3 已有） |
| 错误码表 22 条 | 实际 22 条里只有 8 条存在（`game_sdk_version_mismatch`/`game_world_revision_conflict`/`game_build_failed`/`game_typecheck_failed`/`game_dependency_denied`/`game_asset_invalid`/`game_entity_budget_exceeded`/`game_activity_busy`）；另有 13 条代码里有而文档没写（`workspace_revision_conflict`、`game_manifest_invalid/unsupported`、`game_argument_invalid`、`game_entity_unknown`、`game_world_object_missing`、`game_ui_budget_exceeded`、`game_runtime_fault`、`game_execution_timeout`、`game_build_not_trusted`、`game_package_integrity_failed`…，见 `protocol/diagnostics.ts:8-32`） | D + P1 |

### 2.2 City SDK（B §3–§7）

| 文档要求 | 代码现状 | 等级 |
|---|---|---|
| 包名/导出 `@oh-agent/city-sdk` + `. /contracts /authoring /testing /legacy` | `@agent-vitals/city-sdk`，仅 `. /runtime`（`package.json:2,14-22`） | P0-01（低风险，纯改名+映射） |
| `CityWorldDefinitionV2`（generator/environment/theme/renderProfile/capabilities） | 无；`CityWorldProfileV1` 是 2 值 generator + 2 值 biome + 2 值 themeId 的闭集联合（`types.ts:100-105`） | P0-02 |
| `defineWorldGenerator` + `WorldGeneratorV1` + 受信 Builder | **全仓 0 命中**；生成逻辑在 `apps/agent-city/ui/src/engine/cityLayout.ts` 里是过程式代码，不是注册表 | P0-03（工作量大：要把生成器从 app 抽成可信 builder） |
| `CityWorldSnapshotV4`（terrain tiles/roads/sites/objects/anchors/volumes/topologyDigest/snapshotDigest） | 最高 V3，且 V3 只序列化"锚点引用到的几何"，不含地形（`types.ts:56-66`） | P0-05 |
| `ThemePackV2`（结构/环境语义，禁任意 CSS/Shader） | `CitySkinPackV1` 只有 `renderContract:"city-render-v1"` + `themeId: miami|desert`（`types.ts:117-123`） | P1 |
| `RenderProfileV1`（pipeline/palette/resolutionScale/targetPixelHeight…） | 0 命中；`pixelate|pixel-3d|toon|RenderPipeline` 在 UI 源码里 0 命中；画质等级 ≠ 画风（B 自己说对了） | P1 |
| 能力目录（`volumes.read`/`navigation.surface`/`navigation.volume`/`environment.read`/`appearance.read`/`time.read`/`residents.read`） | 无统一能力表；anchor capability 只有 `drive|walk|fly`（`types.ts:10`） | P0（词表要先冻结） |
| `CityInteractionDescriptorV1` + `CityInteractionRouter` + `CityTargetRefV1` | 0 命中；只有 `addEncounterTarget(object, onClick)` 这种 Three 对象回调（`CityEngine.ts:1629`） | P0-08 |
| `CityPlaceV1` / `CityResidentV1` | 0 命中（`resident` 在 UI 源码里只出现在 zone 名 `residential`） | P1 |
| `CityTemporalSnapshotV1`（IANA `timeZoneId`、`clockRevision`、`tick`、`timeScale`）+ `CityTemporalPolicyV1` | 0 命中；环境时间只有整数偏移 `utcOffsetMinutes` + `host-local|fixed-offset`（`CityEnvironment.ts:11,25`），**没有 IANA、没有 DST 规则、没有 clockRevision** | P1 |
| `CityAgentActorBindingV1` | 0 命中 | P1 |
| `PatchOpsV2`（interaction upsert/rebind、environment/theme/render set、terrain sculpt/water volume） | `validateWorldPlanPatch` 只到 road/site/highway/terrain pad+ramp（`worldPlanPatch.ts:16-56`）；无 interaction/theme/render op | P1 |
| CLI `city init/validate/build/test/preview/pack` | 只有 `init/validate/validate-world/asset/sync-refs/playtest/pack-world/verify-world/pack/verify`（`bin/oh-agent-sdk.mjs:758-829`） | P1 |
| MCP **16** 个新工具（`creator_city_workspace_attach`/`code_build`/`code_build_status`/`build_preview`/`validate_geometry`/`render_profile_preview`/`object_inspect`/`interaction_inspect`/`interaction_preview`/`interaction_simulate`/`clock_inspect`/`time_preview`/`agent_actor_inspect`/`agent_actor_simulate`/`visual_diff`/`workspace_commit`） | 实际存在的是**另一套命名**：`creator_code_{project_create,workspace_info,file_read,file_write,build,test,preview,builds_list,build_status,preview_status,publish,experience_*}`（14 个）；**没有** cityId/cityRevision 绑定、没有 capture/inspect/interaction/story/actor | P0（命名与作用域都要重定） |
| `WorldBuildV1` buildId（内容摘要派生） | `buildId = sha256(文件树 + sdk/esbuild 版本 + gameId)`（`buildGame.ts:303-317`），已有 | ✅ 部分 |

### 2.3 Studio / Progress / 示例

| 文档要求 | 代码现状 | 等级 |
|---|---|---|
| Studio 真实 Viewport 预览（buildId + city revision）、`runId`、capture | `creator_code_preview` 只是**把产物拷到 City dev server 的 `public/code-games/preview/<buildId>/` 并返回 URL**（`creator_code_workspace.rs:337-374`）；没有 runId，没有 capture | P0（A §6.1 的 `creator_code_capture/inspect/preview_stop` 全缺） |
| Agent Progress Bridge（`CreatorGameTaskEventV1`/`CreatorTaskEventV1`，phase 机） | 无统一任务事件；只有 `creator_job_*`（另一条作业面）+ `preview.json` 状态快照 | P1 |
| Interaction Inspector / Story Mode（双时间轴、Preview Fork） | `apps/creator-studio/ui/src` 里没有任何 interaction/story/clock 组件 | P1 |
| 本地示例：hello-city（V1 保留）+ 塔防 + 潜艇 + 跨画风 + City Romance（固定剧情 + 真实日历） | hello-city ✅、塔防 ✅（文档未收录）、潜艇 ❌（无 underwater/navigation.volume）、跨画风 ❌、City Romance ❌ | P1 |
| 游戏工程模板：`package-lock/tsconfig/vite.config/浏览器 Mock World` | `games/hello-city` 与 `games/tower-defense` 只有 `package.json` + `src/` + `tests/`；**无 tsconfig、无 vite.config、无浏览器预览**（`find games/hello-city -type f`） | P0-G-05 |

### 2.4 Epic 总表（按文档自己的编号）

> 判定口径：**已有** = 主路径可跑且有测试；**部分** = 有可用的骨架但文档要求的验收项未满足；**未开始** = 代码里 0 命中。

| 文档 | Epic | 状态 | 已有 / 缺什么 |
|---|---|---|---|
| A | G-01 共享世界 DTO | 部分 | buildId 身份已有；共享 DTO 未做（`api/types.ts` 自造 3 个类型） |
| A | G-02 Manifest V2 | 未开始 | V1 闭集 11 键，无 render/presentation/biome/citySdk |
| A | G-03 WorldSource V2 | 部分 | 两个适配器都在；route identity 与 capability 语义未统一 |
| A | G-04 Host 能力增量 | 部分 | 权限复验/预算/清理已有；无 appearance/render 增量、无 revision 诊断 |
| A | G-05 编译/作业 | 部分 | esbuild + tsc + 不可变 BuildId 已有；无 Vite 模板、无构建缓存、无作业状态机 |
| A | G-06 Creator MCP | 部分 | build/status/preview/test/publish 已有；capture/inspect/interaction/story/actor 全缺 |
| A | G-07 Render/GLB 兼容 | 未开始 | GLB 加载已有；RenderProfile/pixelate 0 命中 |
| A | G-08 端到端作品 | 部分 | hello-city ✅ 塔防 ✅；潜艇/跨画风 ❌ |
| A | G-09 发布与安全 | 部分 | publish/install + 逐文件摘要 + 篡改拒绝已有；沙箱/签名/信任级别 ❌ |
| A | G-10 Interaction Bridge | 未开始 | 只有 `addEncounterTarget(THREE.Object3D, cb)` |
| A | G-11 Dialogue/Story Storage | 未开始 | 无 dialogue/storage 权限与 API |
| A | G-12 Studio Story Mode | 未开始 | Creator Studio UI 无任何 interaction/story 组件 |
| A | G-13 Temporal Scheduler | 未开始 | 无 Scheduler/Story Rule Registry |
| A | G-14 Agent Actor Bridge | 未开始 | 无 Actor Adapter/Canon/Intent 校验 |
| A | G-15 Studio Temporal Inspector | 未开始 | 无 Preview Clock/Fork |
| B | P0-01 包命名迁移 | 未开始 | 仍是 `@agent-vitals/city-sdk` |
| B | P0-02 World V2 类型及校验 | 未开始 | V1 闭集联合 + 严格 validator |
| B | P0-03 World Generator Registry | 未开始 | 无 `defineWorldGenerator`/Builder；生成在 app 内过程式代码里 |
| B | P0-04 Render Profile V1 | 未开始 | 无 pipeline/palette/pixelate |
| B | P0-05 Snapshot V4 + Preview | 未开始 | 最高 V3（只有锚点引用几何） |
| B | P0-06 Code-first CLI + MCP Jobs | 部分 | MCP 作业面已有（另一套命名）；CLI 无 `city build/test/preview` |
| B | P0-07 Underwater Demo | 部分 | 塔防在真实 City 可跑；海底世界/穹顶/透明隧道 ❌ |
| B | P0-08 Interaction Router 兼容层 | 未开始 | 与 A G-10 同一件事 |
| B | P1 编辑事务/volume/nav | 未开始 | Patch 只到 road/site/highway/terrain pad+ramp |
| B | P1-Story Place/Resident + Story Mode | 未开始 | 0 命中 |
| B | P1-Temporal City Clock | 未开始 | 只有整数偏移时区 + `Date.now()` 采样 |
| B | P1-Agent-Actor | 未开始 | 0 命中 |
| B | P2 可下载可执行世界包 | 部分 | 有 code-game experience 的 publish/install；无沙箱/签名/授权安装 |

**合计：28 个 epic，0 个完全达成，10 个部分达成，18 个未开始。**（"完全达成"按**文档自己的验收矩阵口径**判定，不是代码能力计数——例如塔防已跑通、publish/install 已跑通，但 G-08/G-09 的验收项还差潜艇、跨画风、签名与沙箱。）且 10 个"部分"里没有一个是按文档描述完成的（例如 G-06 有 build 却没有 capture，P0-07 有塔防却没有海底），所以"部分"不能直接当作"已完成一部分验收"。

### 2.5 比 v2 功能更底层的落地阻断

这四条不在任何一份 PRD 里，但按依赖排在 v2 清单之前。每条都在 §8 有对应的核验命令。

**2.5.1 构建器出不了开发机（P0 —— 阻断 G-05/G-06 及所有依赖构建的 epic）**

- `creator_code_build` 走 `run_node()`：脚本路径由 `repo_root()` 从**编译期** `CARGO_MANIFEST_DIR/../..` 解析（env 覆盖键 `AGENT_VITALS_REPO` 只在测试/开发时有人设），node 来自 `PATH`（`AGENT_VITALS_NODE` 同上）（`creator_code_workspace.rs:628-659`）。
- app 的打包资源只声明了一个文件：`../../../target/release/agent-vitals` → `bin/agent-vitals`（`apps/desktop/src-tauri/tauri.conf.json:45-47`）。**没有 `packages/`、`scripts/`、`node_modules/`。**
- MCP 服务本身也不是 app 内嵌的：它是外部 agent 启动的 `agent-vitals data-mcp serve --allow-local-writes`（app 里生成的就是这条命令，`lib.rs:4556-4570`）。所以构建发生在**用户机器上没有仓库目录**的那个进程里。
- 代码自己的注释已经承认这一点："当前是 P0 本机受控构建进程；打包产物如何携带 Node/构建器是后续架构决定"（`creator_code_workspace.rs:1-13`）。
- 更糟的是 app 仍把这 14 个工具列出来（`lib.rs:4520,4538` 用 `tool_specs()` 生成工具清单与 MCP skill 文案）；agent 在清单里看到它们"可用"，调用后拿到的是 `data_unavailable`。
- 影响：v2 的 G-05/G-06 以及所有"在 Studio 里 build/preview"的验收都假设存在一个可用构建服务；这个服务现在只在源码树里活。**这是"14 个工具"这个数字最容易误导人的地方。**

**2.5.2 buildId 不绑定 manifest 与资产（P0 —— 正确性，不是能力缺失）**

- `build.json` 只有 buildId/gameId/gameVersion/sdk/entry/bundle/byteLength/sdkVersion/bundler，**没有 manifest 摘要，也没有资产摘要**（`buildGame.ts:130-149`）。
- 三个消费者都用**当前工作区**的 manifest / 资产，而不是 build 时那份：
  - `creator_code_test`：bundle 来自 `builds/<buildId>/game.js`，manifest 来自 `directory.join("game.manifest.json")`（`creator_code_workspace.rs:424`）；
  - `creator_code_preview`：复制当前 manifest（`:357`）**并把当前 `assets/` 整目录拷进预览**（`:359-362`）；
  - `creator_code_publish`：读当前 manifest（`creator_code_experience.rs:110`），按当前 manifest 里的 assets 路径从工作区拷文件（`:135-155`）。
- 后果：Agent 在 build 之后改权限/资产/世界绑定，就得到"旧 bundle + 新 manifest + 新资产"的组合，没有任何摘要能对账；manifest 校验发生在 build 时，运行/预览/发布时用的是另一份文件。这不是理论风险：preview 阶段直接把新资产喂给旧 bundle 就会在 GPU 侧表现成"模型变了"而不是"构建过期"。
- 修法：build 时把 manifest 快照 + 资产摘要写进 build 目录；test/preview/publish 只消费该快照，只复制快照登记的资产；`build_status` 回 `manifestDigest`。

**2.5.3 无头试玩用合成世界，不绑定目标 City（P1 —— 是 §0 第 4 条 (b) 的下游）**

- `previewGame.ts:38` 调 `createGameTestWorld()`（无参数）；默认 `cityId:"test-city"`、`worldRevision:"world-1"`、seed 42、一条 20 m 的 `test-road`、地形恒 0（`testing/headless.ts:67-75,115-130`）。
- `CitySnapshotV1` 结构上就没有 `cityRevision`/`snapshotDigest`，所以"在目标 City 上跑 headless"目前无法表达（`api/types.ts:9-14`）；`createGameTestWorld(options)` 虽然接受 `cityId/routes/terrain`，但 `previewGame.ts` 一个都没传。
- 后果：DSH Agent 的塔防平衡是在合成 20 m 路线上调的（`docs/CODE_GAME_AGENT_LOOP_2026_11_18.md`），进真实 City 只是"恰好也过了"；City 布局一变，headless 结论不迁移。
- 修法：`creator_code_test` 接受 layout snapshot / `cityRevision`（或 cityId + snapshot digest），让测试世界由真实快照投影；至少要在 telemetry 里回传所用世界的身份，让 Agent 知道自己在哪个世界上通过的。

**2.5.4 对外安全文案与写入面冲突（P1 —— 信任面，社区故事之前必须修）**

- app 设置页导出的 MCP skill 文案写着：`--allow-local-writes` 下"the only writes are typed local actions (price cards, billing declarations, budget settings, source controls, city building model overrides) — **never SQL, never files, never URLs**"（`lib.rs:4575`）。
- 但同一份 `tool_specs()` 里已经有 `creator_code_file_write`（在受控工作区写 .ts/.json，256 KiB 上限，`creator_code_workspace.rs:244-283`）、`creator_code_project_create`（建目录 + 复制模板）、`creator_code_preview`（把产物写进**仓库**的 `apps/agent-city/ui/public/code-games/preview/`，`:337-374`，且不清理旧 build）、`creator_code_publish` / `experience_install`（写 `data_home/code-games/`）。
- 更直接的是：**同一份生成的 skill 文案里两句话自相矛盾**——`lib.rs:7057` 的测试要求"每个工具都出现在 skill 文案里"，所以 `creator_code_file_write — Write one UTF-8 file ... Requires --allow-local-writes` 就在 "never SQL, never files" 旁边。
- 这是**产品自己的文案与实现不一致**，不是 PRD 的问题：一个按 skill 文案建立信任的 agent 会认为"这个服务器不写文件"，然后看到写文件的工具。
- 修法：把写入类型清单补全（含 code-game 工作区与预览暂存），或者把 code-game 写入面单独标成需要显式授权的二级权限。

---

## 3. 两份文档之间的矛盾（照单排期必撞车）

| # | A（Game） | B（City） | 后果 |
|---|---|---|---|
| 1 | §4.1 从 `@oh-agent/city-sdk/contracts` 导入 `CityReadOnlySnapshotV2`、`CityRouteDtoV2`、`CityObjectDtoV2`、`CityAnchorDtoV2`、`CityRenderProfileRefV1` | §4.3 定义 `CityWorldSnapshotV4` + `RoadEdgeDtoV2`、`SiteDtoV2`、`WorldObjectDtoV2`、`AnchorDtoV2`、`WorldVolumeDtoV1` | **同一批 DTO 两套名字**；G-01/G-03 的验收标准无法写死 |
| 2 | §3.1 manifest 能力/权限：`world.read`、`terrain.sample`、`environment.read`、`navigation.volume`；§7.4 又要求 `residents.read`、**`places.read`**、`ui.dialogue`、`storage.game` | §4.4 能力表：`terrain.sample`、`roads.read`/`routes.read`、`sites.read`/`objects.read`、`volumes.read`、`navigation.surface`、`navigation.volume`、`environment.read`、`appearance.read`、`time.read`、`residents.read` | **`places.read`、`world.read`、`ui.dialogue`、`storage.game` 只在 A 出现**；A 的 §7.4 示例 manifest 按 B 的目录根本通不过校验 |
| 3 | §8.3 错误码 `game_time_domain_invalid` / `game_story_*` / `game_actor_*` | §9.3 错误码 `city_time_zone_invalid` / `city_replay_write_denied` / `city_actor_intent_denied` | 同一故障两个码、两个域，未定义谁抛哪个 |
| 4 | §10 执行顺序：**G-01 先行**（"不再独立复制 City v2 的 DTO"） | §11：P0-01 改名 → **P0-02 World V2 类型** → P0-05 Snapshot V4 | G-01 的产出就是 P0-02/P0-05 的产出；A 的顺序在当前 B 的计划下不可执行 |
| 5 | §4.4 生命周期新增 "Appearance changed：游戏默认继续运行" + §3.2 "仅风格切换不得改变权威数值" | §5.2 "原子切换 Render Pipeline…保留正在运行的玩法状态" | 方向一致，但**都没有定义 appearanceRevision 的持久化位置**（A 说 Theme/RenderProfile revision 单独标记，B 的 `CityInstanceV2` 才有 appearanceRevision） |
| 6 | §4.8 `AgentActorTurnRequestV1/ResponseV1`（storyRevision、idempotencyKey、auditTraceId） | §5.4 只有 `CityAgentActorBindingV1`，没有请求/响应 DTO | Actor 协议两头都不完整，接口对不上 |
| 7 | §2 表格：Game SDK **不可以**"直接调整 City 时钟" | §4.5 定义 `CityTemporalPolicyV1`/`timeScale`，但没有"谁能改"的权限模型 | 权限归属空白（A §4.7 有 `time.read`/`story.schedule`，B 无对应动作权限） |

---

## 4. 文档自身的问题（与代码无关，但影响可执行性）

1. **A 自相矛盾**：§0 第 5 条要求"已有能力不能仍标为待做"，但 §1.1 表最后一行（`creator_studio.rs` 那一行）与 §6.1 把已经落地的 `creator_code_build/build_status/test/preview` 标成"尚未实现"。
2. **A 引用了已失效的注释**：§5.1/§1 引用 `buildGame.ts` 的"不做 typecheck"注释——注释还在，代码已加 tsc 闸（`buildGame.ts:89`）。这既是 PRD 的问题，**也是代码里的一个待修项**：`buildGame.ts:18-20` 那句 "It does not typecheck" 现在是错的，应随 v2 文档一起改。这类"注释即事实"的引用方式会在下一轮继续误导。
3. **A §4.2 把两套世界投影的等价性说成"必须统一"，但没给 target**：live 侧（arterial roads + blocks）与 snapshot 侧（anchor link 链）的 route identity 规则不同（`road-<edgeId>` vs 锚点链），文档只说"要统一夹具"，没有定义统一后的 ID 规则。
4. **B §3 目录布局漏了 v2.1/v2.2 新增域**：`contracts/authoring/world/scene/appearance/editing/packaging/testing/legacy` 里没有 `interaction/`、`temporal/`、`actors/`，而 §4.5/§5.3/§5.4 正是这三个域。
5. **B 的"六种对象"没有覆盖已存在的对象**：`MiniGamePackV1`、`GameTypeDescriptorV1`、`CityGameMountV1`、`VehicleProfileV1`、`ContentPackageV2` 都不在六种对象里，而它们已经在 `city-sdk` 里承担"游戏内容"职责。
6. **两份文档都没定义玩家身份**：Storage/Dialogue/Story/Actor 全部依赖 `playerId`，但没有任何一节说明它从哪来（登录？本地 profile？remote guest？）。代码里 `playerId` 只存在于 remote 会话（`owner`/`guest`）与 mecha 对局契约。
7. **验收矩阵里有一部分已经自动成立**：G-AC01（hello-city 不回归）、G-AC05（塔防 3 波沿可信路网、不改 CityEngine 专用分支）、G-AC10（Studio 不在也能 build/test）在 `1373b496` 已有对应实现/脚本，文档仍把它们写成"待验收"。
8. **A §9 的 Experience 命名/内容与实现不符**：文档叫 `CodeGameExperienceV2`，代码是 `kind:"code-game-experience", schemaVersion:1`；文档要求"受信任代码来源、签名、运行时最低版本"，代码只有 `contentDigest` + `provenance.buildId/sdkVersion`，**没有签名、没有最低宿主版本、没有信任级别字段**。

---

## 5. 已经成立的不变量（不用重做）

这些在代码里已有守卫，文档可以引用而不必再列为"必须新增"：

- **Game SDK 无宿主面**：`GameContextV1` 不含 scene/renderer/invoke/DOM，`tests/boundary.test.ts` 钉住。
- **两个 SDK 的 import 边界**：`packages/agent-vitals-city-sdk/src` 与 `packages/city-game-sdk/src` 均无 `node:`/`three`/`react` 导入（grep 空）。
- **固定步 + LIFO 清理 + 实体预算 + 权限复验**：`tests/lifecycle.test.ts`（10 例）、`entities.test.ts`（5 例）、`permissions.test.ts`。
- **失败闭合**：`cityWorldSource` 对 V2 快照直接 reject（`:44-49`）；无地形采样器返回 `null` 而不是 0 高度（`:81`）；构建缺资产/缺 tsc 一律失败（`buildGame.ts:78-92,220-223`）。
- **活动互斥**：`game_activity_busy`（`codeGameSession.ts:234-241` + 测试 `:164`）。
- **世界变化停 Run**：lease epoch + `isCurrent()` → `stop("world_changed")`（`code-game-session.test.ts:190`）。
- **dev 才允许 URL 载入 bundle**：`CityApp.tsx:388` 的 `import.meta.env.DEV` 闸。
- **MCP 面不返回物理路径**：`creator_code*.rs` 全部走 workspaceId + 相对路径白名单（`creator_code_workspace.rs:477-507`）。

---

## 6. 建议

### 6.1 先改文档（1–2 天，零代码风险）

1. **把 §2.5 的四条写成 P0 前置**，而不是把现有的 build/test/publish 当作"已有闭环"。
2. 重写 A §1.1 表的第 9、19 行，删除"尚无 `creator_code_*`"；补 `games/tower-defense`、验证脚本（2 个进 CI + 2 个本地）、`creator_code_experience`。**证据列从"文件"改成"能力/工具族名"**——用文件当证据，重构一次就过期一次。
3. 统一 DTO 名：以 B §4.3 的 `CityWorldSnapshotV4`/`RoadEdgeDtoV2`/`WorldObjectDtoV2` 为准，把 A §4.1 的 `CityReadOnlySnapshotV2`/`CityRouteDtoV2`/`CityObjectDtoV2` 改成别名并注明"以 B 为准"。
4. 出一张**唯一能力表**：把 `world.read/roads.read/routes.read/places.read/residents.read/environment.read/appearance.read/time.read/volumes.read/navigation.*` 收成一张表，标清"世界能力 / 游戏权限 / 属于哪个 revision"三列，并删掉重复项。
5. 把 A §10 的顺序改成"依赖 B 的 P0-02 → P0-05"，即 `B P0-01/02/05 → A G-01/G-03 → A G-02/G-10 → …`。
6. 错误码以 `packages/city-game-sdk/src/protocol/diagnostics.ts:8-32` 为基线重出，新增码必须同 PR 落表。
7. 明确 playerId 的来源（本地 profile / remote session），否则 §4.6/§4.7/§4.8 三节无法落地。

### 6.2 再改代码（按依赖顺序，不是按文档章节顺序）

**第 0 步：构建器可交付性（§2.5.1）**
- 让构建器随 app 分发：内置固定 Node/构建脚本，或把 esbuild+tsc 收进 Rust 侧（wasm/内置二进制）；`repo_root()` 这条编译期路径依赖必须消失。
- 验收：打包后的 app 里 `creator_code_build` 能对一个工作区产出 buildId（不是 `data_unavailable`）。

**第 1 步：build 绑定 manifest 与资产快照（§2.5.2）**
- build 时把 `game.manifest.json` 快照 + manifestDigest + 资产摘要写进 build 目录；`creator_code_test/preview/publish` 只消费该快照、只复制快照登记的资产；`build_status` 回 `manifestDigest`。
- 验收：build 后改工作区 manifest 或替换资产，再用旧 buildId 跑 test/preview，必须报 `workspace_revision_conflict`（或等价码），不能静默用新文件。

**第 2 步：测试世界绑定（§2.5.3）**
- `creator_code_test` 接受 layout snapshot / `cityRevision`（或 cityId + snapshot digest），测试世界由真实快照投影；telemetry 回传所用世界的身份。

**第 2.5 步：写入面文案对齐（§2.5.4）**
- 把 app 导出的 MCP skill 写入清单补全（code-game 工作区、预览暂存、experience 库），或给 code-game 写入单列一级授权。这条必须在任何"社区可安装"叙事之前做完。

**第 3 步：Run 绑定（§0 第 4 条 (b)）**
- `CodeGameHostOptionsV1`/`CitySnapshotV1` 加 `cityRevision`、`worldDigest`、`interactionRevision`；`useCodeGamePreview` 去掉 `"city:dev"` 兜底（`useCodeGamePreview.ts:125`）。
- 把 `world_changed` 升成可恢复诊断（`game_world_revision_conflict`），而不是只给一个 reason 字符串。

**第 4 步：收敛两套游戏抽象（§0 第 4 条 (a)）**
- 建议的收敛方向（不是唯一解，但必须落一个）：
  - `MiniGamePackV1` 保留为**纯声明式内容**（规则 + 槽位 + 资产引用，不含代码）；
  - `CodeGameManifestV1` 是**代码内容**（bundle + 权限 + 世界绑定）；
  - `GameTypeDescriptorV1` 继续做**可注册类型的词表**（type → runtime 契约版本）；
  - `agent-vitals-city-game-runtime` **冻结为 legacy adapter**，长期并入代码游戏 SDK 的 `/host` 面，不新建第四套包。
- 这一步决定 Manifest V2 的字段，必须先于 G-02。

**第 5 步：playerId 来源（§0 第 4 条 (c)）**
- 先定身份来源与作用域键（本地 profile / remote session / 未来账号），再写 Storage/Dialogue/Story/Actor 的表结构。

**第 6 步：能力/权限词表（B P0-02 的最小切片）**
- 把 `WORLD_CAPABILITIES_V1`（3 项）扩到文档要求的集合，并让 manifest 校验与 Host 调用点共用同一张表。

**第 7 步：Interaction Router（G-10/B P0-08）**
- 在 `CityEngine.handleClick`（`:1723`）的既有拾取结果上产 `CityTargetRefV1`，加 `CityInteractionDescriptorV1` 注册表 + `game.launch` 白名单动作；旧怪兽→战棋注册为 `exclusive` legacy adapter，用现有回归测试锁行为。

**第 8 步：Render Profile（G-07/B P0-04）**
- 在 `CityEngine.ts` 的 `EffectComposer`/`GTAO`/`UnrealBloom` 组织处（`:16-20`、`:311`）抽 `RenderPipelineAdapter`；复用 `applyCreatorSkin` 的"可逆租约 + owner token"模式做原子切换与回滚。

**第 9 步：Temporal（P1-Temporal）**
- 先把 `CityEnvironment` 的整数偏移升级为 IANA `timeZoneId` + 显式 DST 策略（当前 `utcOffsetMinutes` 无法表达 `Asia/Shanghai`，`CityEnvironment.ts:25`）。
- 再把 `Date.now()` 采样点（`CityEngine.ts:203,2361`）替换为单一 Simulation Clock；Replay Cursor 保持在只读面。

**第 10 步：Story/Actor（G-13/G-14）**
- 依赖第 3/5/9 步；建议先做"声明式规则 + 持久 Scheduler + occurrence 去重键"，Agent Actor 最后接。

### 6.3 不建议现在做的

- **先别做 Studio UI，先做宿主构建服务**：`creator_code_preview` 的文件桥已经把 Agent 闭环跑通，但那是 dev server 的路径；打包后 build 根本起不来（§2.5.1），此时做面板等于给一个不可用的后端做前端。这句要读成"Studio 面板可以后置"，**不是**"P0-05 可以取消"。
- **不要为 v2 新建第四套游戏包**：已有 `city-game-sdk`（代码游戏）+ `city-game-runtime`（类型+运行时注册表）+ `city-sdk`（内容/描述符）三处，再加一层就是第四次重复。
- **不要在打包 app 里假设 PATH 上有 node、磁盘上有仓库**：这是当前 14 个工具里最容易在演示通过、装机失败的一条。

---

## 7. 复现（只读命令）

```bash
cd <repo>
git log -1 --format='%h %ci'                # 1373b496 2026-11-18 18:23:33
# 目标符号是否落地（预期全空）
grep -rn "WorldAPIV2\|GameContextV2\|DialogueAPI\|GameStorage\|StoryEvent\|AgentActor\|CityTemporal\|InteractionDescriptor\|LaunchContext\|RenderProfile\|ThemePackV2\|WorldDefinitionV2\|WorldSnapshotV4" \
  packages apps/agent-city/ui/src crates --include=*.ts --include=*.tsx --include=*.rs
# MCP code-game 工具族（预期 14 个）
grep -n "creator_code_" crates/agent-vitals-mcp/src/mcp/mod.rs
# 构建里的 typecheck 闸
sed -n 85,95p packages/city-game-sdk/scripts/buildGame.ts
# 哪些验证脚本真进了 CI（预期只有 loop / publish）
grep -n "verify-code-game" .github/workflows/verify.yml
# 游戏工程缺 Vite/tsconfig（预期只有 package.json/src/tests）
find games -maxdepth 2 -name "tsconfig.json" -o -name "vite.config.ts"
# 构建器依赖 repo_root / PATH 上的 node
sed -n 626,660p crates/agent-vitals-mcp/src/mcp/creator_code_workspace.rs
# 打包资源里只有 CLI 二进制
sed -n 39,48p apps/desktop/src-tauri/tauri.conf.json
# build 记录里没有 manifest / 资产摘要
sed -n 130,162p packages/city-game-sdk/scripts/buildGame.ts
# 无头试玩用的是合成世界
sed -n 36,42p packages/city-game-sdk/scripts/previewGame.ts
sed -n 67,75p packages/city-game-sdk/src/testing/headless.ts
# 对外文案声称 never files
grep -n "never SQL, never files, never URLs" apps/desktop/src-tauri/src/lib.rs
```

---

## 8. 核验记录（结论 → 证据，逐条可复查）

| # | 结论 | 证据 | 结果 |
|---|---|---|---|
| 1 | 目标符号 0 命中 | §7 第 2 条 grep | 三个代码根全空 |
| 2 | 14 个 code-game MCP 工具 | `mod.rs:109-110,293-300` + 三个 `creator_code*.rs` 的 `specs()` | 3 状态 + 7 工作区 + 4 体验 = 14 |
| 3 | 只有 2 个验证脚本进 CI | `verify.yml:134,138` | `city-loop` / `preview` 需 Vite+Playwright，走本地 |
| 4 | B §8.2 目标工具 16 个 | B 文档 620-635 行逐行数 | 16 |
| 5 | 构建器依赖编译期仓库路径 + PATH 上的 node | `creator_code_workspace.rs:628-659` | env 键只有 `AGENT_VITALS_REPO` / `AGENT_VITALS_NODE`，app 不设 |
| 6 | 打包资源只有 CLI 二进制 | `tauri.conf.json:45-47` | `target/release/agent-vitals` → `bin/agent-vitals`，无 `packages/`/`scripts/`/`node_modules/` |
| 7 | MCP 服务由外部 agent 起，不是 app 内嵌 | `lib.rs:4556-4570` | `data-mcp serve --allow-local-writes` |
| 8 | build 记录无 manifest / 资产摘要 | `buildGame.ts:130-149` | 只有 buildId/gameId/gameVersion/sdk/entry/bundle/byteLength/sdkVersion/bundler |
| 9 | test/preview/publish 消费当前 manifest（预览还消费当前资产） | `creator_code_workspace.rs:424,357,359-362`；`creator_code_experience.rs:110,135-155` | 旧 bundle + 新 manifest/新资产可组合 |
| 10 | headless 用合成世界 | `previewGame.ts:38` + `headless.ts:67-75,115-130` | `test-city` / `world-1` / 20 m `test-road` / 地形 0 |
| 11 | `CitySnapshotV1` 无法表达城市修订 | `api/types.ts:9-14` | 只有 cityId/seed/worldRevision/layoutId |
| 12 | 对外文案 "never files" 与写入面冲突 | `lib.rs:4575` vs `creator_code_workspace.rs:244-283,337-374` | 文案未列 code-game 写入与预览暂存 |
| 13 | 两套游戏抽象并存 | `city-sdk/src/gameTypes.ts:19-32`、`city-game-runtime/src/types.ts:52-66`、`city-game-sdk/src/api/defineGame.ts:21` | 三处各有自己的"游戏"契约 |
| 14 | playerId 只存在于 remote / mecha | `apps/agent-city/ui/src/remote/**`、`game/mecha/contracts/match.ts:10` | Code Game 路径无身份 |
| 15 | `buildGame.ts` 顶部注释已过期 | `buildGame.ts:18-20` vs `:89-92,219-281` | 注释说"不做 typecheck"，代码做了 |

**本次未核验、报告也不声称的**：打包 app 真机点击这 14 个工具的失败表现（只从代码路径推断）、CI 当前是否绿、`verify-code-game-city-loop.mjs` / `-preview.mjs` 在 CI 机器上的可运行性（它们要 Playwright + WebGL）。

---

## 附：一句话给决策者

**这两份文档作为"要做什么"是合格的目标书，作为"现在到哪了"已经失真；按它们直接排期，第一周就会卡在"DTO 叫什么"和"G-01 等 B 的 P0-05"上。真正的技术债不在 v2 功能缺失，而在①两套游戏抽象没有收敛、②一次 Run 没有绑定城市版本、③整套 v2.1/v2.2 设计缺玩家身份；而在这三条之前，还有"构建器出不了开发机、build 不绑 manifest/资产、headless 不绑 City"三个更硬的落地阻断——它们决定 v2 清单最乐观也只是设计稿。**
