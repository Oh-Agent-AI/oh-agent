# City 游戏运行时 SDK 代码架构（2026-11-15）

状态：**接口与注册表已落地；Miami adapter 迁移未开始**。本文描述新增的
`@agent-vitals/city-game-runtime` 包及与 `@agent-vitals/city-sdk` 的边界，不把
未实现的 adapter/扑翼游戏记为已完成。

## 1. 包边界

```text
@agent-vitals/city-sdk                 纯内容契约（无 Three/DOM/CityEngine）
  GameTypeDescriptorV1                 game type id、runtime id/contract、slot、参数、
                                       asset role、HUD 名；唯一校验器
  MiniGamePackV1 / rules / runHeadless 声明式规则执行
        ↑
@agent-vitals/city-game-runtime       可信运行时契约与注册表（本包）
  GameRuntimeV1 / GameRuntimeHandleV1  prepare / telemetry / fixedStep / dispose
  GameRuntimeRegistryV1                type + contractVersion → adapter；失败关闭
  ports（scene/input/audio/clock/activity）
  内置活动目录/Miami 四类 descriptor    仅目录，未注册
        ↑
apps/agent-city/ui                     adapter 实现、渲染/HUD/场景租约
apps/creator-studio/ui                预览/试玩消费者（后续）
```

关键约束：

- 内容不能携带代码；运行时不能自己再定义一套内容校验。
- `city-sdk` 保持纯数据，不引入 Three.js/React/DOM。
- `city-game-runtime` 也不直接依赖 Three.js/CityEngine；通过 ports 注入。
- Rust/MCP 不依赖 runtime 包；它们只读 `city-sdk` 的 descriptor 数据。

## 2. 已实现 API

### 2.1 `city-sdk` 新增 `GameTypeDescriptorV1`

```ts
type GameTypeDescriptorV1 = {
  schemaVersion: 1;
  id: string;
  version: number;
  label: string;
  templateCatalog: "creator" | "builtin" | "planned";
  template: string;
  runtime: { id: string; contractVersion: number };
  slots: Record<string, { kind: "spawn"|"route"|"zone"|"object"; min: number; max: number;
    requires: ("drive"|"walk"|"fly")[]; role?: string }>;
  parameters: Record<string, { min: number; max: number; default: number; unit?: string }>;
  assetRoles: Record<string, { kind: "model-glb"; required: boolean; maxBytes?: number; nodeRoles?: string[] }>;
  hud: string;
};
```

`validateGameTypeDescriptorV1` 严格拒绝未知字段、越界参数、非 `model-glb` 资产、
未知 capability 和不可执行字段。`templateCatalog` 明确 `template` 属于哪一本目录：
`creator` 必须命中 `CREATOR_TEMPLATES_V1`，`builtin` 必须命中
`BUILTIN_ACTIVITY_TEMPLATE_IDS`，`planned` 不可注册。测试见
`tests/game-types.test.ts` 与 runtime 的 `registry.test.ts`。

### 2.2 `city-game-runtime` 注册表

```ts
const registry = createGameRuntimeRegistry();
registry.register(descriptor, runtime);              // descriptor 由 city-sdk 校验
registry.resolve("creator.flight-ornithopter-v1", 1); // 精确 contractVersion
registry.descriptors();
```

错误码：`game_type_invalid`、`game_type_duplicate`、`game_type_unknown`、
`game_type_version_mismatch`、`game_type_template_mismatch`、`game_runtime_invalid`。

### 2.3 assets 目录中的 catalog

- `MIAMI_ACTIVITY_CATALOG_V1`：flight/driving/mecha/cinema 四个 descriptor；
  **只是目录**，没有 runtime 实现，不能 resolve。
- `ORNITHOPTER_GAME_TYPE_V1`：扑翼飞行 descriptor（`fly` slot、扑翼参数、
  vehicle 资产 role、nodeRoles），也尚未注册。

## 3. 接口语义

- `GameRuntimeContextV1.city` 是宿主选定的冻结 City 实例；runtime 不得读其他 City。
- `GameRuntimeHandleV1.fixedStep()` 使用注入的 `clock.fixedDtSeconds`，保证确定性。
- telemetry 是呈现/证据面；游戏规则事件由 adapter 发送给 `city-sdk` 规则解释器。
- `dispose` 必须释放 scene 附加物、输入/音频资源，不泄漏活动租约。
- `GameRuntimeRegistryV1` 线程/实例安全由宿主保证；它本身是纯内存注册表。

## 3.1 本轮 adapter 包装

`city-game-runtime` 已新增 `createMiamiLegacyRegistry(host)` / `createMiamiLegacyRuntime`：

- 四个 Miami 活动都通过 `MiamiLegacyActivityHostV1.enter(activity)` 委托给既有实现；
- adapter `execution: "host-driven"`，`fixedStep` 不存在，SDK 不会二次驱动 Miami 的帧循环；
- `dispose` 只调用 host handle 的 dispose；host 负责原有活动租约/相机/HUD；
- descriptor→runtime 的 id/template 映射有 **golden 锁定测试**（flight/driving/mecha/cinema 的顺序、runtime id、contractVersion、template）。
- 该层不修改 `GameSession`/`useCityGame`/`useCityDrivingPlay`/mecha/cinema 代码，也不改变 Miami 行为。

App 侧 catalog：[gameTypeCatalog.ts](../apps/agent-city/ui/src/game/runtime/gameTypeCatalog.ts)
列出四个 Miami adapter 目录 + 飞行原型 `creator.flight-ornithopter-prototype-v1`
+ 计划的 `creator.flight-ornithopter-v1`；
`PLANNED_GAME_TYPE_IDS` 与 `gameTypeBlockReason()` 让 UI/Agent 能发现扑翼类型但
不会误注册（registry 仍拒绝 `planned`）。

App 侧注入点：

- [miamiActivityHost.ts](../apps/agent-city/ui/src/game/runtime/miamiActivityHost.ts)
  `createMiamiGameRuntimeRegistry(entries)`；
- [miamiActivityEntries.ts](../apps/agent-city/ui/src/game/runtime/miamiActivityEntries.ts)
  把四个活动的命令（enter/exit/active/telemetry）变成 host entries；
- [CityApp.tsx](../apps/agent-city/ui/src/CityApp.tsx) 已用 refs 注入现有
  `useCityGame`、`useCityDrivingPlay`、`openMecha`、cinema helper，并实例化
  registry。**工具栏四类活动现在经 registry 启动/停止**；无 handle 时保留直接
  退出 fallback。原型入口为 City 右下角的「扑翼原型」按钮；点击画布聚焦后
  `Shift+O` 也可触发（两者都只在无活动/无航拍时可用）。

测试：app `verify:game-runtime-host`（6，含 entry/prototype/能力锁步）、runtime（11）。
Miami 金样已在当前树重跑：

- flight：`verify-city-game-session`、`verify-city-game-flight`、
  `verify-city-game-controller`、`verify-city-game-world`、`verify-city-game-race`、
  `verify-city-game-profile`、`verify-city-game-audio-service`、
  `verify-city-game-scene-lease` 全部通过；
- driving：`verify-city-driving`、`verify-city-driving-vtol`、
  `verify-city-driving-structure-world`、`verify-city-driving-release-graph`、
  `verify-city-driving-entry` 全部通过；
- cinema：`verify-react-city-cinematic`（5 seeds）通过；
- 快守卫里的陈旧 ground fixture 已修：`verify-city-joint-site-road`、
  `verify-city-model-envelope`、`verify-city-model-ground`、
  `verify-city-shore-plot-access`、`verify-city-joint-frontage`、
  `verify-city-world` 分别通过；这些改动只补 `elevation/landform` 上下文，不改规划逻辑。
- 继续补 `verify-city-endpoint-routing`、`verify-city-junction-rings`、
  `verify-city-connect`、`verify-city-loop`、`verify-city-landing`、
  `verify-city-repair-safety` 的 `elevation/landform` fixture 后，
  **`verify-city-suite fast` 33/33 全部通过**（74.6s，2026-11-15）。
  这些改动只补测试夹具的合成地形合同，不改生产生成器、Miami 启动路径或规划逻辑。

## 3.2 扑翼 descriptor 已进入 Creator 能力发现

`CREATOR_CAPABILITIES_PROJECTION_V1.categories.gameTypes` 现在包含六项：

- `miami.flight-v1` / `miami.driving-v1` / `miami.mecha-v1` / `miami.cinema-v1`
  （`status:"builtin-adapter"`）；
- `creator.flight-ornithopter-prototype-v1`（`status:"prototype"`，复用
  `miami.flight` runtime 与 `miami-flight` template；Shift+O 可进入，明确不是扑翼物理）；
- `creator.flight-ornithopter-v1`（`status:"planned"`，`templateCatalog:"planned"`）。

这不是运行能力：`planned` descriptor 仍被 registry 拒绝注册，也没有 Creator
template/运行时。它只是让 Studio/Agent 能发现“未来会有扑翼类型”，同时避免把
descriptor 当作可玩游戏。

锁步测试：

- app catalog ↔ `CREATOR_GAME_TYPES_V1`；
- runtime 四个 Miami descriptor + 扑翼 descriptor ↔ `CREATOR_GAME_TYPES_V1`；
- 生成物 `assets/creator/capabilities.json` 由
  `scripts/generate-creator-capabilities.mjs --check` 锁定。

## 3.3 正式扑翼 Creator 内容（2026-11-15）

已将正式扑翼作为 Creator 模板接入：

- `CREATOR_TEMPLATES_V1` 新增 `ornithopter-flight`；
- pack id `creator.ornithopter-flight`，`gates` 槽要求 `fly`（3–8 个），
  参数 `timeLimitTicks` / `flapPower`；
- `AnchorCapability`、content-pack 校验与 Rust layout 快照均接受 `fly`；
- Studio 新建项目模板下拉新增「扑翼飞行检查点」；
- 生成物 `assets/creator/templates/ornithopter-flight.json` 与
  `templates-index.json` / `capabilities.json` 已更新。

通过 Creator Studio 实际创建：

```text
projectId: project-4567906979e08c193133142564f5663b
title:     扑翼飞行检查点
game.id:   creator.ornithopter-flight
slots:     gates requires ["fly"]
mounts:    0
```

**它不是可玩项目**：创建时的 City 布局只有 `drive` 锚点，没有 `fly` 空域锚点，
因此无法绑定 `gates`；同时正式 `city-flight-ornithopter` runtime 还没有实现。
下一片必须是空域锚点 + 正式 runtime + Creator 飞行试玩链路，不能把本模板当成
已可运行。

## 4. 迁移顺序（下一步）

1. **宿主接线**（不改行为）：在 CityApp 实现 `MiamiLegacyActivityHostV1`，把现有
   `useCityGame` / `useCityDrivingPlay` / mecha / cinema 的进入、退出和 telemetry
   接到四个 host-driven adapter；用 Miami 现有金样脚本做真回归。
2. **flight 直接包装**：在 host 内优先用 `GameSession` 实例实现 flight adapter，
   验证 enter/exit 与 HUD 快照完全等价；driving/mecha/cinema 仍由 React 宿主驱动。
2. **接入 Creator**：扑翼 adapter 注册为 `city-flight-ornithopter`；Studio 模板/
   capability 读取 `ORNITHOPTER_GAME_TYPE_V1`；发布/试玩按 `gameType +
   runtimeContractVersion` 冻结。
3. **可选 kernels**：当 flight/driving 出现第二消费者时，再抽
   `@agent-vitals/city-game-kernels`；不提前搬 Three/React/HUD。
4. **能力发布**：把 `gameTypes` 加入 `creator_capabilities` 生成链路，Rust/MCP
   只读生成产物。

## 5. 测试与 CI 组合

- `city-sdk`：descriptor 校验、预算、冻结、非法字段。
- `city-game-runtime`：注册/解析/重复/未知/版本漂移/实现不匹配；template
  catalog 锁步（`creator` 必须在 `CREATOR_TEMPLATES_V1`，`builtin` 必须在
  `BUILTIN_ACTIVITY_TEMPLATE_IDS`，`planned` 不可注册）；四个 Miami 目录与
  扑翼 descriptor 均通过校验。
- 后续 adapter：Miami 行为 golden、确定性 fixed-step、dispose/租约泄漏、
  未知 gameType fail-closed。

CI 专用 job `city_game_runtime`（Node 22）执行：

```sh
(cd packages/agent-vitals-city-sdk && npm ci && npm run build)
mkdir -p packages/agent-vitals-city-game-runtime/node_modules/@agent-vitals
ln -s ../../../agent-vitals-city-sdk \
  packages/agent-vitals-city-game-runtime/node_modules/@agent-vitals/city-sdk
npm test --prefix packages/agent-vitals-city-game-runtime
npm run typecheck --prefix packages/agent-vitals-city-game-runtime
node --experimental-transform-types scripts/generate-creator-capabilities.mjs --check
npm test --prefix packages/agent-vitals-city-sdk
npm test --prefix apps/creator-studio/ui
npm run typecheck --prefix apps/creator-studio/ui
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test -p agent-vitals-mcp
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy -p agent-vitals-mcp --all-targets -- -D warnings
```

本地若已有 `city-sdk/node_modules`，运行时包可直接复用其 `tsc`；CI 必须在
`city-sdk` 安装后创建上述链接，运行时包不提交自己的 `node_modules`/lockfile。

## 6. 明确未实现

- Miami 四类活动的 runtime adapter、kernels 抽取；
- Creator 飞行模板/编辑器/试玩；
- `gameTypes` 能力发布、资产动画、空域锚点/City layout v3；
- 任何扑翼飞行真机验收。

这些均不得用本文档或 descriptor 目录冒充完成。
