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

## 4. 迁移顺序（下一步）

1. **包装现有实现**（不改行为）：
   - flight：包装 `GameSession`；
   - driving：先把 `useCityDrivingPlay` 引擎侧逻辑抽成 session，再包装；
   - mecha：包装 `MechaModeRuntime`；
   - cinema：包装航拍会话。
   每步用 Miami 金样/回归锁行为，注册在 app 侧本地 registry，不进入 SDK 默认表。
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
