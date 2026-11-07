# City 开放世界：小游戏活动平台架构

状态：建议稿，未实施。
日期：2026-11-07
范围：`apps/agent-city/ui/src/CityApp.tsx` 与 `src/game/**` 的活动接入层。
关联：

- `CITY_ARCHITECTURE.md`（City 自身的 L0–L5 分层，本文不动它）
- `MECHA_CITY_FIGHT_ARCHITECTURE_SPEC.md` §7（mode lifecycle / lease 的雏形）
- `MECHA_ITB_ALIGNMENT_ARCH_2026_11_07.md`（mecha 作为第一个模块的细化）

## 0. 结论

现在的 City 已经能同时承载飞行/竞速、驾驶、机甲战棋、航拍、视频导出、规划修复六种"活动"，但**没有平台层**：每种活动自带生命周期、HUD、输入、相机和存档，互斥关系靠 `CityApp.tsx` 里几份手写布尔列表维持。

要做"City 当开放世界、上面嵌很多小游戏"，需要的不是继续加模式，而是三样东西：

1. **一个活动宿主（Activity Host）**：唯一的活动状态机 + 唯一的资源租约。
2. **一份模块契约（Activity Module）**：懒加载、只通过 Host API 访问城市、HUD 渲染进统一插槽。
3. **入口即数据（Activity Entry）**：城市对象/工具栏/深链声明"这里能进什么"，而不是在每个入口各写一遍 guard。

目标不是做第三方插件 ABI。`GameScenePort` 的注释已经写清楚："Host-internal capability contracts, NOT plugin IPC"——这里的小游戏是第一方模块，不是外部插件。

## 1. 现状：六种活动，三套生命周期，N 份互斥表

| 活动 | 入口 | 生命周期 | 资源 | HUD | 存档 |
| --- | --- | --- | --- | --- | --- |
| 飞行 / 竞速 | `useCityGame.enterGame` | `GameModeController` 状态机（data → preparing → practice/countdown → racing → result → exiting） | `GameScenePort` 租约：相机、frame hook、labels | `GameHud` | `profile`（最佳成绩） |
| 驾驶 | `useCityDrivingPlay` | hook 内部状态（choosingVehicle / active / paused） | `CityCarSceneCapability` + 自有 visuals | `DrivingHud` | 车色（ref） |
| 机甲 | `CityApp` 的 `mechaOpen` | React 挂载/卸载 | `CityMechaWorld` + engine 相机 | `MechaHud*` | sequential checkpoint / replay |
| 航拍 | City 工具栏 | 自有 | 相机 | overlay | 无 |
| 视频导出 | City 工具栏 | 自有 | 相机 + 录制 | overlay | 文件 |
| 规划修复 | dev 开关 | `usePlanRepair` | engine | 面板 | 无 |

三个结构问题：

**P1 互斥靠手写列表，O(n²)。**
`CityApp.tsx` 里同一组条件至少出现在九处：飞行的 `busy`（:114）、`planRepair` 的 blocked（:126）、`mechaBlocked`（:132）、两处点击守卫（:302、:483）、`roadAuditEnabled`（:494）、`mechaEntryEnabled`（:495）、`repair` 与驾驶的 enabled（:512、:514）。每加一个活动要改 6–9 处；漏一处就是相机或 frame hook 被另一个活动覆盖——这正是 `GameScenePort` 的 token/epoch 想防的事，但它只覆盖飞行。

**P2 生命周期三种写法。**
状态机（飞行）、hook 内部布尔（驾驶）、组件挂载（机甲）。进入、退出、暂停、错误恢复、WebGL 上下文丢失、卸载清理，每种活动各实现一遍，行为不可能一致。

**P3 入口与 HUD 硬编码。**
工具栏、城市点击、地图标记各自判断能不能进；每个模式自带 HUD 根和层级；机甲模块被静态 import，不管开不开放都进包。

## 2. 目标结构

```text
City 世界（CityEngine / SceneSpec / 相机 / 输入 / 时间 / 音频）
        │  只读快照 + 租约
CityActivityHost
  ├─ Registry    模块清单、入口声明、懒加载
  ├─ Lease       唯一资源租约：相机 / 输入 / frame hook / labels / HUD / 音频
  ├─ Router      进入请求的唯一裁决（互斥矩阵只有一份）
  └─ Shell       暂停菜单、错误边界、HUD 插槽、存档与诊断
        │
Activity Modules（第一方、按需加载、互相不可见）
  flight | driving | mecha | cinema | film | repair
```

规则：

- **一个时刻只有一个活动持有租约**。默认全互斥；要并行（例如小地图叠加）必须显式声明为"非独占能力"，而不是靠布尔列表。
- **模块不 import `CityEngine`**，只拿 `HostApi`（只读快照 + 租约方法）。这条由 import 守卫钉住，做法同 `verify-mecha-layers.ts`。
- **模块不自己挂 HUD 根**，渲染进 host 的 HUD 插槽；全屏层、z-index、焦点陷阱由 shell 统一。
- **模块懒加载**：初始包只有 host + registry，模块代码在进入时 `import()`。

## 3. 契约

```ts
// host/contracts.ts
export type ActivityId = "flight" | "driving" | "mecha" | "cinema" | "film" | "repair";

export type HostSnapshot = Readonly<{
  cityReady: boolean;
  revision: number;
  locale: "zh-Hans" | "en";
  quality: "auto" | "high" | "eco";
  activeActivity: ActivityId | null;
}>;

export type ActivityRequest<P = unknown> = Readonly<{
  id: ActivityId;
  params: P;            // 例如 mecha: { siteId, species? }
  origin?: Readonly<{ x: number; y: number; z: number; heading: number }>;
}>;

export type Refusal = Readonly<{ reason: string; message: string }>;

export type ActivityLease = Readonly<{
  token: symbol;
  setFrameHook(hook: ((dt: number) => void) | null): void;
  setCamera(pose: CameraPose): void;
  captureInput(handlers: InputHandlers): () => void;
  setLabelsVisible(visible: boolean): void;
  hudSlot(): HTMLElement;
  audioBus(): AudioBus;
  release(): void;      // 幂等；恢复 ReturnState、清 frame hook、归还相机
}>;

export type ActivityModule<P = unknown> = Readonly<{
  id: ActivityId;
  version: number;
  entries: readonly ActivityEntry<P>[];       // 城市对象/菜单/深链
  load(): Promise<ActivityImplementation<P>>; // 懒加载
  save?: Readonly<{ schema: string; version: number; empty(): unknown }>;
}>;

export type ActivityImplementation<P = unknown> = Readonly<{
  canStart(host: HostSnapshot, req: ActivityRequest<P>): Refusal | null;
  start(ctx: ActivityContext, req: ActivityRequest<P>): Promise<ActivitySession>;
}>;

export type ActivitySession = Readonly<{
  runId: number;
  update(dt: number): void;
  pause(reason: "user" | "blur" | "system"): void;
  resume(): void;
  exit(): Promise<void>;
  dispose(): void;
}>;
```

React 侧只保留一个入口：

```tsx
<ActivityHost modules={MODULES} snapshot={hostSnapshot} />
```

模块用 `useActivity()` 拿 `{ host, lease, request, session }`，不再各自 `useCityGame` / `useCityDrivingPlay`。

## 4. 资源模型

| 资源 | 租约方法 | 现在谁在抢 | 平台后的规则 |
| --- | --- | --- | --- |
| 相机 | `setCamera` | 飞行、驾驶、机甲、航拍 | 租约独占；退出恢复进入前 pose |
| frame hook | `setFrameHook` | 飞行、驾驶、机甲 | 租约独占；退出置 null |
| 键盘 / 指针 | `captureInput` | 每个模式自己 `window.addEventListener` | 租约统一捕获；Esc 策略由 shell 定义 |
| City 标签 | `setLabelsVisible` | 飞行、驾驶手动关 | 租约自动隐藏/恢复 |
| HUD | `hudSlot` | 每个模式自带根 | 一个插槽；全屏层只在活动期间存在 |
| 音频 | `audioBus` | `GameAudio`/`DrivingSfx` 各自建 | 一条总线，退出时淡出 |
| 存档 | `save` schema | profile / checkpoint / ref | 统一 `ActivityProfileStore`，按 schema 分区 |

## 5. 入口即数据

```ts
type ActivityEntry<P> = Readonly<{
  where:
    | { kind: "object"; objectKind: "airport" | "garage" | "encounter" }
    | { kind: "menu"; group: "games" }
    | { kind: "deeplink"; query: string };
  params(input: EntryInput): ActivityRequest<P> | Refusal;
  enabled(host: HostSnapshot): boolean;
}>;
```

收益：

- 工具栏和地图标记由 registry 生成，`CityApp` 不再列模式。
- 互斥只剩 `Router` 一份：`enter()` 时检查 `activeActivity`，返回 `busy` 并带当前持有者。
- 深链 `?activity=mecha&site=...` 对所有模块自动成立，测试也能用它直接进场景。

## 6. 隔离与守卫

新增 `scripts/verify-activity-layers.ts`：

- `game/**` 的模块目录不得 import `engine/**`、其它模块、`CityApp`；只能 import `host/contracts` 和自己的文件。
- `CityApp` 不得出现 `mechaOpen` / `game.active` / `driving.active` 这类互斥布尔（用一条 grep 断言）。
- HUD 组件不得 import 规则模块（与 mecha 文档的 M1 守卫同一条）。

## 7. 迁移路线

| 步 | 内容 | 可独立上线 | 风险 |
| --- | --- | --- | --- |
| P0 | 从 `HostGameScenePort` 抽出通用 `ActivityLease`（它已有 token/epoch/camera/frame/labels），`GameSelection` 泛化为 `ActivityId` | 是（纯重构，无视觉变化） | 低 |
| P1 | 驾驶作为第一个模块接入（生命周期最简单、HUD 独立） | 是 | 中 |
| P2 | 机甲接入：`MechaBoard` 包成模块，entry 带 `siteId`；HUD 契约（mecha 文档 M1）落在平台插槽里 | 是 | 中 |
| P3 | 飞行/竞速接入：`GameSession` 已经是最成熟的实现，包一层，不重写 | 是 | 中 |
| P4 | 航拍/导出/规划修复登记为 host 活动，删掉 `CityApp` 的互斥列表 | 是 | 低 |
| P5 | 入口改为 registry 生成 + 模块懒加载 + 包体预算 | 是 | 低 |

顺序原则：**先抽租约，再迁一个简单模块，最后动飞行**。飞行是唯一已有完整租约的实现，最后迁，避免一边改平台一边改飞行。

## 8. 验收

| 检查 | 口径 |
| --- | --- |
| 互斥矩阵 | 任意两个活动两两进入：第二个必须拿到 `busy`，且第一个的相机/frame hook 不被改 |
| 租约泄漏 | 连续 100 次 enter/exit：相机回到进入前 pose、frame hook 为 null、labels 恢复、HUD 插槽为空 |
| 模块契约 | 每个模块跑同一套 8 例：进入、退出、暂停/恢复、拒绝、错误、WebGL 丢失、存档读写、深链 |
| 包体 | 初始 chunk 不含任何模块代码；`dist` 里能按模块名找到独立 chunk |
| 守卫 | `verify-activity-layers` 通过；`CityApp` 无互斥布尔 |

## 9. 与 mecha 文档的关系

- mecha 的 **M1 HUD 契约**就是平台 HUD 插槽的第一个消费者；两边可以共用一个 `MechaHudModel`，不要各定义一套。
- mecha 的 **M2 `resolveMechaMode`** 是 `ActivityRouter` 的前身：先在 mecha 内落地，P2 时上提到平台。
- mecha 的 **P0-1 预览性能**不受平台影响，照做。
- mecha 文档第 8 节"v1.5 是否进正式包"，上提后变成平台的"entry 策略"：用 `ActivityEntry.enabled(host)` 表达，而不是组件里的 `releasePicker`。

## 10. 不做

- 不做第三方插件 ABI、跨进程 IPC、任意脚本注入；模块是第一方代码。
- 不重写飞行/驾驶的实现，只包一层。
- 不把 City 改成通用 ECS 或通用游戏引擎；平台只负责"活动接入"，不负责"怎么玩"。
- 不为并行活动做通用叠加（小地图这类只读叠加走 host 的非独占能力，不进租约）。
