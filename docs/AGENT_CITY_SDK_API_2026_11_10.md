# Oh Agent 创作 SDK API v0.1

状态：接口设计草案。以下新增包名、类型和命令用于评审，尚未发布。宿主权限、Studio 与 City 切换、试玩证据沿用 [Creator Studio 架构](AGENT_CITY_CREATOR_STUDIO_ARCH_2026_11_09.md)。

## 1. 包与模板

| 入口 | 职责 | 依赖 |
|---|---|---|
| `@agent-vitals/app-sdk` | 插件清单类型、宿主 RPC、WebView 生命周期与授权数据客户端。复用现有包和桥接 | 独立 App Game 使用这一层 |
| `@agent-vitals/city-sdk` | 布局、皮肤、锚点、挂载、规则定义和纯校验。根入口可在 Node 与浏览器运行 | City 世界、内嵌小游戏、Studio 和 CLI 使用 |
| `@agent-vitals/city-sdk/runtime` | 编译规则、解析挂载、执行规则和无头测试。可信 City 适配器接入现有场景与车辆 | 依赖 City SDK 契约。官方 City、Studio 预览和 CLI 使用同一实现 |
| `oh-agent-sdk` | 项目生成、校验、预览、打包的 CLI 命令名 | 使用以上契约和运行器。项目授权由桌面 Creator 服务处理 |

`app-game` 生成带代码的独立 WebView 项目。`city-world` 生成布局、皮肤引用、锚点和可选挂载的组合项目，最终使用官方 City 运行时。`city-minigame` 生成规则和素材项目，交付可装入 City 的玩法包。三个模板各有一个独立目录样例，只使用公开 API 和合成数据。

官方 Agent City 是参考使用者。先让现有驾驶模块接入相同的场地与规则接口。车辆、Three.js 场景对象、帧回调、相机和 `GameScenePort` 租约留在可信运行时适配器内部。第三方模板通过公开入口创建，不需要复制官方 City 源码。

## 2. App Game 接入

继续使用现有官方插件描述表、`PluginRequestV1` 和 `/ui-host` 桥接。模板带自己的 HTML、UI 与游戏代码。开发宿主给模板提供合成数据和模拟本地状态，按与桌面相同的描述表约束检查调用。下面是建议新增的便利层，映射到现有桥接。

```ts
type Dispose = () => void;

interface AppGameHooks {
  start(): void | Promise<void>;
  suspend(): void;
  resume(): void;
  dispose(): void;
}

interface AppHostClient {
  locale(): string;
  state: {
    read(key: string): Promise<PluginStateReadResult>;
    write(input: PluginStateWritePayload): Promise<PluginStateWriteResult>;
  };
  onSuspend(callback: () => void): Dispose;
  onResume(callback: () => void): Dispose;
}

declare function connectAppGame(hooks: AppGameHooks): Promise<Dispose>;
declare function createAppHostClient(): AppHostClient;
```

启动成功后才报告 ready。初始化失败时释放已分配的资源。销毁操作可重复调用，模板在页面卸载时接入清理。状态键由宿主描述表声明，按现有 revision 校验与单文档限制处理。独立游戏的开发打包输出预编译 WebView 资源和描述文件。正式桌面分发首轮走官方注册与构建链。外部可执行包的安装、签名、进程隔离和数据授权另行验收。

## 3. City 内容与绑定

以下签名描述首轮公开字段。布局的地形、道路与模型输入使用独立的版本化 schema，先支持固定合成场地以及内置生成器的有界参数。兼容内置生成器通过 ID 与版本选择。

```ts
type ContentKind = "city-layout" | "city-skin" | "city-minigame";
type ContentRef<K extends ContentKind> = {
  kind: K;
  id: string;
  version: string;
  digest: string;
};

type AnchorKind = "spawn" | "route" | "zone" | "object";
type AnchorCapability = "drive" | "walk";
type CityAnchorV1 = {
  id: string;
  kind: AnchorKind;
  capabilities: AnchorCapability[];
  geometryRef: string;
};

interface CityLayoutV1 {
  schemaVersion: 1;
  id: string;
  coordinateSystem: "city-local-m-v1";
  world: WorldSourceV1;
  anchors: CityAnchorV1[];
}

interface CitySkinPackV1 {
  schemaVersion: 1;
  id: string;
  renderContract: "city-render-v1";
  visuals: CityVisualOverridesV1;
}

type SlotSpecV1 = {
  kind: AnchorKind;
  min: number;
  max: number;
  requires?: AnchorCapability[];
};

interface MiniGamePackV1 {
  schemaVersion: 1;
  id: string;
  rulesVersion: 1;
  slots: Record<string, SlotSpecV1>;
  integerParameters?: Record<string, { min: number; max: number; default: number }>;
  rules: RuleGraphV1;
}

interface CityGameMountV1 {
  schemaVersion: 1;
  mountId: string;
  layout: ContentRef<"city-layout">;
  game: ContentRef<"city-minigame">;
  entryAnchorId: string;
  bindings: Record<string, string[]>;
  parameterOverrides: Record<string, number>;
}

interface DiagnosticV1 {
  code: string;
  severity: "error" | "warning";
  path: string;
  objectId?: string;
  message: string;
}

type Result<T> =
  | { ok: true; value: T; diagnostics: DiagnosticV1[] }
  | { ok: false; diagnostics: DiagnosticV1[] };

declare function validateContent(input: unknown): Result<CityContentV1>;
declare function listAnchors(layout: CityLayoutV1, filter?: AnchorFilterV1): CityAnchorV1[];
declare function listSceneObjects(scene: SceneDraftV1, filter?: SceneObjectFilterV1): SceneObjectV1[];
declare function validateMount(input: MountValidationInputV1): Result<ResolvedMountV1>;
```

- ID 在对象改名和显示顺序变化后保持稳定。挂载按精确版本和包摘要解析。一个槽位的绑定数组有顺序，规则可引用索引。坐标和实际几何由布局拥有。
- `validateMount` 检查声明、摘要、数量、锚点类型和能力，并使用场地适配器检查道路连通或区域可达。绑定建议可单独返回，保存和启动都重新校验。升级布局导致挂载不兼容时保留旧记录并给出待修复的槽位。
- 皮肤可替换材质、光照和非碰撞外观。改变道路、实体足迹或碰撞属于布局修改。小游戏存档按城市实例和 mountId 隔离，游戏版本变化时显式处理存档兼容。
- 打包输出 `PackageManifestV1` 与文件清单。包摘要取规范化 manifest 主体和排序后的文件摘要，摘要字段和签名本身排除在摘要输入之外。内容引用只解析包内声明资源或固定版本的依赖。打包、安装和权益分别记录。

### 3.1 模型资源与场景实例

首版提供随内容包版本化的本地模型目录。官方内置模型和创作者导入的 GLB 都用同一种引用方式。模型条目描述资源，场景实例决定把哪个模型放在哪里。十个街区可以引用同一份模型，每个实例各有稳定 ID、位置、旋转和缩放。

| 建议 API | 输入与输出 |
|---|---|
| `listAssets(filter?)` | 查询已安装或开发包中的模型元数据，返回包引用、资源 ID、包围盒与可用标签 |
| `inspectModel(source)` | CLI 或 Studio 导入阶段检查 GLB，返回单位、原点、体积、复杂度和外部依赖诊断 |
| `validateAssetRefs(content, catalog)` | 检查场景引用、文件摘要、依赖版本、资源预算与模型缺失 |
| `listSceneObjects(scene, filter?)` | 查询草稿中的模型实例和锚点，按类型或 ID 过滤。桌面查询通过 `project_read` 分页 |
| `scene.placeModel` / `scene.updateModel` / `scene.removeModel` | 创建、移动或删除模型实例。Studio 和 MCP 经 `edit_preview` / `edit_commit` 提交 |
| `anchor.upsert` / `anchor.remove` | 创建、移动或删除草稿中的出生点与检查点等锚点。修改时重新检查引用和绑定 |

`ModelRefV1` 由包引用和包内 `assetId` 组成。模型条目记录相对文件名、摘要、包围盒和单位。模型导入统一到 City 坐标约定，受信任适配器负责与现有引擎世界单位转换。加载器校验体积、网格和纹理预算，拒绝包外引用。可信渲染层按包摘要和资源 ID 缓存加载结果，并随场景生命周期释放引用。玩法包可以引用声明的素材，布局拥有静态障碍与触发区域，皮肤只替换视觉资源。可交互对象的锚点与模型实例分别记录。

桌面首轮编辑范围是基于固定布局的场景草稿，允许修改模型实例、出生点和有界触发区域。地形与道路生成参数先通过 CLI 创作。草稿实例和锚点使用稳定 ID，移动或改名保留引用。删除仍被挂载引用的锚点时，预览列出受影响的槽位，创作者可在同一批操作内换绑或移除挂载。模型实例可以复用官方提供的对象模板，模板可带预设的碰撞或交互配置，实例化后这些配置分别记录。

### 3.2 场地查询与碰撞

City 已有固定步长驾驶模拟、地表查询和飞行扫掠碰撞。首版复用这些实现，通过受信任的场地适配器提供 `sampleGround(point)`、`checkClearance(shape, pose)` 和 `validateRoute(anchorId, capability)`。查询绑定到同一布局和地表快照，区分可用、被阻挡和无法判定。小游戏规则消费 `zone.entered` 等事件，场地适配器根据实际移动产生这些事件。

新 SDK 场景显式声明静态碰撞代理和触发区域，首轮可用盒体等简单形状。换模型或皮肤时，障碍和触发区域保持原配置。现有官方地图由适配器提供兼容的场地事实。首轮用检查点竞速和寻宝验证静态碰撞、地表和触发区域。动态刚体、约束、堆叠或大范围破坏成为明确玩法需求时，再评估通用物理引擎并优先在独立活动场景验证。

## 4. 玩法 API

规则图由有类型的事件、守卫与动作组成。竞速至少需要开始、进入检查点区域、计时结束三个事件。寻宝增加拾取事件。引擎提供有限整数计数、布尔值、状态比较、计时、HUD 提示和胜负结算。动作只修改本次活动状态或提交受校验的表现效果。

```ts
type RuleEventV1 =
  | { type: "run.started"; tick: number }
  | { type: "zone.entered"; tick: number; slot: string; index: number }
  | { type: "item.collected"; tick: number; slot: string; index: number }
  | { type: "timer.expired"; tick: number; timerId: string };

type PlayerRuleInputV1 = Extract<RuleEventV1, { type: "zone.entered" | "item.collected" }>;
type RuleGuardV1 =
  | { op: "counter.eq"; counter: string; value: number }
  | { op: "counter.eqEventIndex"; counter: string };
type RuleActionV1 =
  | { op: "counter.add"; counter: string; amount: number }
  | { op: "timer.start"; timerId: string; durationTicks: number | { parameter: string } }
  | { op: "hud.hint"; text: string }
  | { op: "run.finish"; outcome: "success" | "failure" };

interface RuleGraphV1 {
  counters: Record<string, { initial: number; max: number }>;
  nodes: Array<{
    id: string;
    on: { type: "run.started" }
      | { type: "zone.entered" | "item.collected"; slot: string }
      | { type: "timer.expired"; timerId: string };
    when?: RuleGuardV1[];
    actions: RuleActionV1[];
  }>;
}

declare function compileRules(pack: MiniGamePackV1): Result<CompiledRulesV1>;
declare function createRun(input: {
  rules: CompiledRulesV1;
  mount: ResolvedMountV1;
  seed: number;
}): RuleRunV1;

interface RuleRunV1 {
  step(tick: number, inputs: ReadonlyArray<PlayerRuleInputV1>): Result<RuleStepV1>;
  snapshot(): Readonly<RuleStateV1>;
  stop(): void;
}

declare function runHeadless(input: HeadlessRunInputV1): Result<PlaytestEvidenceV1>;
```

由可信运行器生成开始与计时事件，外部 trace 只提交模拟区域或拾取输入。规则步使用连续整数 tick，从 0 开始，输入 tick 必须等于当前步。首步先发开始事件，其余步先处理到期计时，同一 tick 的计时按 ID 排序，再按输入顺序处理区域和拾取事件。同一个事件按规则声明顺序匹配，守卫全部满足时依序执行动作，前一条的状态更新对后一条可见，进入终态立即停止。编译时拒绝未知参数、计数器、槽位和不适用的守卫。计数溢出作为运行错误，计时只安排未来 tick，重复启动同 ID 计时会替换原期限。原语、图大小、步数、状态和运行时长均使用版本化预算。预算耗尽返回规则节点和事件序号。

竞速模板示例定义如下。三个检查点的实际位置由挂载提供。

```text
run.started             → 启动限时计时（next 初始为 0）
zone.entered(points[i]) → 若 i == next，则 next += 1
                         若 next == 3，则结算成功
timer.expired(limit)    → 若尚未结算，则结算超时
```

City 真实输入产生区域事件，无头模式读取预先构造的规则 trace。固定场地、版本、规则输入与 seed 用于复现规则结果。车辆控制、碰撞反馈和相机由玩家可视试玩验收。Agent 创作的内嵌包使用声明式规则与素材。若未来加入沙箱脚本，脚本仍消费相同场地与事件协议，提交受限动作。

首轮 HUD 支持目标、进度、倒计时及胜负，复用 City 的呈现组件。校验和试玩分别定位问题。挂载校验返回布局与对象 ID、受影响的槽位、失败位置，以及 `route_disconnected`、`anchor_blocked` 或 `geometry_unresolved` 等原因。规则试玩证据绑定 runId、快照摘要和 revision，失败时按可用性记录规则节点 ID、对象 ID、事件序号、tick 和断言的预期／实际结果。Studio 用这些字段选中对应对象或规则节点，Agent 据此修改并重跑。

## 5. CLI、Studio 和 MCP

| CLI 命令（草案） | 输入与输出 |
|---|---|
| `oh-agent-sdk init city-minigame ./race` | 可替换成 `app-game` 或 `city-world`，生成可运行样例与固定依赖版本 |
| `oh-agent-sdk validate ./race --json` | 返回 schema、资源、引用和规则诊断。绑定验证同时提供布局与挂载 |
| `oh-agent-sdk preview ./race --fixture miami --mount ./mount.json` | 打开合成场地的本地预览。独立插件模板使用开发宿主 |
| `oh-agent-sdk playtest ./race --fixture miami --mount ./mount.json --trace ./success.json --json` | 执行无头规则检查，返回断言、终态和证据引用 |
| `oh-agent-sdk pack ./race --out ./dist` | 先校验，再生成带 manifest 和摘要的本地产物 |

CLI 文件模式面向开发目录。桌面作品的所有读取与写入经过本机 Creator 服务。Studio 的类型化客户端和 Agent 的 MCP 使用同一事务，MCP stdio 适配器只转发已授权请求。

| MCP 工具 | 主要输入 → 输出 |
|---|---|
| `project_create` | 模板 ID、operationId → projectId、revision。需要新建授权 |
| `project_read` | projectId、可选 revision、对象过滤和分页游标 → 草稿摘要及有界对象视图 |
| `catalog_list` | 类型、布局引用、分页游标 → 模板、可用锚点或规则原语 |
| `edit_preview` | projectId、baseRevision、类型化操作 → diff、诊断、可提交时返回 previewId 与 expiresAt |
| `edit_commit` | projectId、previewId、expectedRevision、operationId → revision、变更摘要 |
| `edit_undo` | projectId、expectedRevision、operationId → 新 revision、变更摘要 |
| `operation_status` | projectId、operationId → 已提交结果或未找到 |
| `playtest_run` | projectId、revision、mountId、fixtureId、traceId → runId。仅启动无头检查 |
| `playtest_status` | runId → 状态与有界证据 |
| `playtest_cancel` | runId → 无头运行终态或取消请求状态 |

编辑操作覆盖模型实例、锚点，以及 `rule.upsert`、`rule.remove`、`mount.bind`、`mount.remove`、`skin.select`，每项使用稳定 ID。桌面 P0 从已安装或合成目录选择布局，在草稿内编辑场景实例与锚点。预览绑定调用者、项目和基线。宿主事务持久化成功的幂等结果，原请求在超时后用相同 operationId 重试或重新授权查询。冲突返回当前 revision。`operation_status` 的未找到只表示没有可见的已提交记录。可视试玩由玩家在 Studio 发起，切换到 City 时锁定版本并交给玩家控制。

诊断码应稳定，首轮至少覆盖 `schema_unsupported`、`missing_dependency`、`anchor_not_found`、`anchor_capability_missing`、`route_disconnected`、`revision_conflict`、`preview_expired`、`permission_denied` 和 `rule_budget_exceeded`。错误文本面向玩家，Agent 用 code、path 和对象 ID 决定下一步。

## 6. 第一轮验收顺序

1. 官方 City 使用现有驾驶输入和相机运行一个通过公开契约加载的竞速包。退出、取消和启动失败都归还活动资源。
2. 独立目录通过 CLI 创建竞速包，先校验和无头试玩，再绑定到迈阿密与绿洲的不同锚点，由玩家分别完成一局。
3. 同一运行器执行一个寻宝包。检查两类玩法能在同城共存，换皮前后路线和存档保持一致。
4. Studio 与 MCP 走相同项目事务。Agent 摆放并移动一个被障碍遮挡的检查点，先根据挂载诊断修正位置，再故意输入错序事件，根据规则证据定位未完成的检查点。修复后重跑无头检查，玩家试玩固定 revision 并回到草稿。验证并发冲突、重试和授权撤销。
5. 外部开发者从 SDK 模板生成独立游戏，使用合成数据宿主预览和打包。用独立项目验证公开 API 的完整性。

## 7. 引擎参照与采用范围

| 官方参照 | SDK 采用的做法 |
|---|---|
| [Unity 手册](https://docs.unity3d.com/6000.0/Documentation/Manual/UnityManual.html) | 场景对象组合外观、碰撞和交互。City 允许独立换肤并保留空间约束。 |
| [Unreal 玩法框架](https://dev.epicgames.com/documentation/en-us/unreal-engine/gameplay-framework-in-unreal-engine) · [编辑器自动化](https://dev.epicgames.com/documentation/en-us/unreal-engine/scripting-and-automating-the-unreal-editor) | 用会话管理控制权和局内状态。摆放和校验由同一套操作服务提供给 UI 和自动化。 |
| [Godot 功能列表](https://docs.godotengine.org/en/stable/about/list_of_features.html) | 复用对象模板，并提供场景对象检查与运行诊断。 |
| [Cocos Creator 概览](https://docs.cocos.com/creator/3.0/manual/en/getting-started/introduction/) · [物理后端](https://docs.cocos.com/creator/3.7/manual/en/physics/physics-engine.html) | 连通资源、场景、预览和打包。首轮复用 City 的碰撞和地表查询。 |
| [Roblox 创作概览](https://create.roblox.com/docs/creation) · [试玩模式](https://create.roblox.com/docs/studio/testing-modes) | 同一作品支持不同试玩方式。以固定版本运行，试玩状态与草稿分开。 |

首轮交付覆盖场景对象、资产、玩法会话、碰撞查询、基础 HUD、调试和打包。动态刚体与约束、可编辑动画和音频、多人同步等能力按后续玩法需求进入路线图。
