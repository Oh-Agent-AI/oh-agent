# Oh Agent City Shared Contracts RFC v1

> 状态：**v1.1 契约冻结；不是已实现 API**
> 日期：2026-11-18
> 适用：`@oh-agent/city-sdk`、`@oh-agent/city-game-sdk`、City Runtime、Narrative Engine、Creator Studio、Creator MCP
> 实施状态：包级契约、V2 Host/Preview、Registry、Snapshot Headless、Story CAS/Outbox、持久 City Clock/Run 与内置 City 本地 Story commit 入口已落地；持久 Scheduler、Dialogue/PlayerScope 完整接线、完整 Narrative、全量旧入口 Router 和五环境验收未完成。Story 不开放 MCP 直写，也不接受调用方提交整份状态。

> 引用文档：`AGENT_CITY_SDK_V2_PRD_RFC_2026-11-18.md`、`AGENT_CITY_GAME_SDK_V2_PRD_RFC_2026-11-18.md`（v2.5）
> 变更规则：后续兼容新增进入 v1.2；字段、语义、Token、Revision 或生命周期的破坏性变更进入 Shared Contracts v2 与兼容评审

## 0. 决策摘要

City SDK 定义世界与公共身份，Game SDK 定义游戏及可访问操作，Runtime 承担权威解释、授权、租约、事务与发布，Narrative Engine 承担剧情业务实现。两个包不得分别发明同名 DTO、Token 或生命周期状态。

本 RFC 冻结七组公共契约：

1. 空间语义、Generator Plan、World Compiler 与可移植快照；
2. Capability、Permission Request、Host Grant 三轴判定；
3. 不可变 Build、内容摘要、Revision 与失效范围；
4. City Simulation Clock、Scheduler、事务、幂等与 Outbox；
5. Game Type、Installed Game、Interaction、Launch 与 Run；
6. Actor Intent、Canon 引用、玩家私有状态与远程数据政策门；
7. 有界世界查询、资产读取和跨包验证证据。

公共 DTO 不得包含 Three.js、Node、Tauri、Codex Thread、数据库客户端、任意 JS 执行权限、物理路径或凭据。现有怪兽→战棋等 V1 入口保持行为兼容，`ContentPackageV2` 不得从数据包隐式升级为可执行代码包。

### 0.1 规范语言与版本

- **MUST**：合并前必须满足；**SHOULD**：默认满足，偏离必须进入 ADR；**MAY**：兼容扩展。
- `Existing` 仅表示已有代码路径，不表示本 RFC 已执行编译或端到端测试；`Target` 表示冻结目标。
- `schemaVersion` 表示数据编码版本；`contractVersion` 表示运行时协议版本；包 semver 不能替代二者。
- 文档是规范说明，机器权威是下述同源 TypeScript + JSON Schema；二者不一致时不得发布，必须以兼容评审修正，而不是任选其一。

## 1. 单一来源与包结构

```text
@oh-agent/city-sdk
  /contracts     世界 DTO / Capability / Revision / 时间 / 公共身份与 Actor Intent
  /authoring     WorldPlan / Generator API / defineCityWorld
  /validate      与 DTO 同版本生成的 JSON Schema 和运行时校验
  /testing       确定性、拓扑、迁移 fixtures
  /runtime       迁移期 legacy export，不复制第二套实现

@oh-agent/city-game-sdk
  /protocol      Manifest / Permission / Grant / InstalledGame / Story / Actor Turn
  /host          Host Port；特权实现仅存在于受信任 Runtime
  /testing       Input Trace / Headless / Fixture

City Runtime      世界、时钟、授权、租约和提交权威
Narrative Engine  Story Graph / Canon / Arc / Director / Memory / Reflection
Creator Studio    可视与调试客户端，不拥有独立世界真相
Creator MCP       授权观察、预览和操作入口，不成为第二个写通道
```

**SC-01**：`@oh-agent/city-sdk/contracts` 是世界、Capability、Revision、公共身份与 Actor Intent 的唯一类型来源；Game SDK 只 import type 或纯类型重导出。Game Permission、Manifest、Grant、InstalledGame、Story Rule 和 Actor Turn 由 Game SDK 维护。类型与运行时 Schema 必须由同一 source 生成，禁止手工复制枚举。

## 2. 世界对象、身份与编译

### 2.1 空间与稳定 ID

```ts
export type StableIdV1 = string; // ^[a-z][a-z0-9]*:[a-z0-9][a-z0-9._-]*$，最长 128 字节
export type DigestV1 = string;   // sha256:<64 lowercase hex>
export type RevisionIdV1 = string;
export type BuildId = string;
export type OperationId = string;
export type Vec2V1 = readonly [number, number];
export type Vec3V1 = readonly [number, number, number];
export type QuatV1 = readonly [number, number, number, number]; // x,y,z,w，单位四元数

export type Bounds3V1 = Readonly<{ min: Vec3V1; max: Vec3V1 }>;
export type TransformV1 = Readonly<{
  position: Vec3V1;
  rotation: QuatV1;
  scale: Vec3V1; // 各分量 > 0
}>;

export interface CityPageV1<T> {
  items: readonly T[];
  nextCursor?: string;
}

export interface TerrainSampleV1 {
  height: number;
  normal: Vec3V1;
  walkable: boolean;
}

export type CityTargetRefV1 =
  | { kind: "world-object"; id: StableIdV1 }
  | { kind: "resident"; id: StableIdV1 }
  | { kind: "place"; id: StableIdV1 };

export interface PlayerScopeV1 {
  playerId: string; // 宿主生成的不可猜测 opaque ID，不使用浏览器指纹
  kind: "local-profile" | "remote-guest";
}
```

坐标使用 `city-local-m-v1`：米、Y-up、右手系；角度不进入公共 DTO，统一使用单位四元数；法线必须归一化。所有数值有限，拒绝 NaN/Infinity、负零和不合法 Bounds。

ID 在同一 City 世界命名空间内唯一，由生成器稳定语义键经规范规则生成；不得使用数组下标、随机 UUID 或 `THREE.Object3D.uuid`。数组顺序不影响身份。

### 2.2 对象语义

| 类型 | 冻结语义 | 关键关系 |
|---|---|---|
| `SiteDtoV2` | 规划与地理单元，不直接等于可视对象 | 通过 `objectIds` 绑定对象，可关联 `placeId` |
| `WorldObjectDtoV2` | 有稳定变换、Bounds、资产与碰撞语义的对象 | 可属于一个 Site |
| `AnchorDtoV2` | 出生、路线、区域、检查点等语义位置 | 可引用对象；道路端点必须引用 Anchor |
| `RoadEdgeDtoV2` | 可导航拓扑边及中心线 | 连接两个已存在 Anchor |
| `WorldVolumeDtoV1` | 水体、空域、检查点、危险区或触发区 | 使用显式几何和用途，不等于完整寻路 |
| `CityPlaceV1` | 公共场所以及活动语义 | 必须定位到真实对象或 Anchor |
| `CityResidentV1` | 公共居民身份和日程 | 私密关系与记忆不在此对象中 |

```ts
export interface SiteDtoV2 {
  id: StableIdV1;
  kind: string;
  bounds: Bounds3V1;
  objectIds: readonly StableIdV1[];
  placeId?: StableIdV1;
}

export interface WorldObjectDtoV2 {
  id: StableIdV1;
  kind: string;
  transform: TransformV1;
  bounds: Bounds3V1;
  siteId?: StableIdV1;
  assetDigest?: DigestV1;
  collision: Readonly<
    | { kind: "none" }
    | { kind: "box" }
    | { kind: "mesh"; assetDigest: DigestV1 }
  >;
}

export interface AnchorDtoV2 {
  id: StableIdV1;
  kind: "spawn" | "route" | "zone" | "object" | "checkpoint";
  position: Vec3V1;
  radiusMeters?: number;
  objectId?: StableIdV1;
  travelModes: readonly ("walk" | "drive" | "fly" | "swim" | "submersible")[];
}

export interface RoadEdgeDtoV2 {
  id: StableIdV1;
  kind: "road" | "tunnel" | "walkway" | "flight-path";
  fromAnchorId: StableIdV1;
  toAnchorId: StableIdV1;
  directed: boolean;
  travelModes: readonly ("walk" | "drive" | "fly" | "swim" | "submersible")[];
  centerline: readonly Vec3V1[]; // 至少两点，首末点与 Anchor 容差一致
}

export type VolumeGeometryV1 = Readonly<
  | { kind: "box"; bounds: Bounds3V1 }
  | { kind: "sphere"; center: Vec3V1; radiusMeters: number }
  | { kind: "convex-prism"; polygonXZ: readonly Vec2V1[]; minY: number; maxY: number }
  | { kind: "ring"; center: Vec3V1; normal: Vec3V1;
      innerRadiusMeters: number; outerRadiusMeters: number; thicknessMeters: number }
>;

export interface WorldVolumeDtoV1 {
  id: StableIdV1;
  kind: "water" | "airspace" | "checkpoint" | "hazard" | "trigger" | "navigation";
  geometry: VolumeGeometryV1;
  travelModes?: readonly ("walk" | "drive" | "fly" | "swim" | "submersible")[];
  objectId?: StableIdV1;
}
```

所有引用必须存在；Road 中心线不得自交为不可验证拓扑，Volume 半径/厚度必须为正，ring normal 必须归一化且 `0 < inner < outer`。P0 只要求静态 Volume 查询与线段/扫掠体穿越判定；完整二维/三维路径规划不属于 Volume 基础语义。`segmentCrossesWorldVolume` 判定与环体相交，飞行计分必须使用 `segmentPassesRingGate` 判定穿过 `innerRadiusMeters` 环孔；缺少可信朝向的旧触发区保持 Sphere 兼容，不得虚构 Ring 法线。

### 2.3 公共 Place 与 Resident

```ts
export interface CityPlaceV1 {
  id: StableIdV1;
  kind: string;
  displayName: string;
  objectRef: StableIdV1;
  activities: readonly string[];
}

export interface CityResidentV1 {
  id: StableIdV1;
  displayName: string;
  prefabRef: string;
  homePlaceId?: StableIdV1;
  schedule?: readonly Readonly<{
    daysOfWeek: readonly (0 | 1 | 2 | 3 | 4 | 5 | 6)[];
    startLocalTime: string;
    endLocalTime: string;
    placeId: StableIdV1;
  }>[];
  interactions: readonly string[];
}
```

日程按 City IANA 时区解释；跨午夜与 DST 由 Runtime 统一解析。Place/Resident 是公开内容，不包含玩家好感度、聊天摘要、私人记忆或活跃 Actor Session。

### 2.4 Generator Plan 与 World Compiler

**SC-02**：Generator 只返回 `WorldPlanV1`；World Compiler 才生成 Snapshot。作者层 `routes` 必须经编译成为标准 `roads`，不得由游戏各自解释。

```ts
export interface CityResolvedGeneratorIdentityV1 {
  id: string;
  contractVersion: 1;
  version: string;
  codeDigest: DigestV1;
}

export interface CompileContextV1 {
  cityId: string;
  cityRevision: number;
  seed: number;
  generator: CityResolvedGeneratorIdentityV1;
  assetsDigest: DigestV1;
  capabilities: readonly WorldCapabilityV2[];
}

export interface RoutePlanV1 {
  id: StableIdV1;
  kind: RoadEdgeDtoV2["kind"];
  fromAnchorId: StableIdV1;
  toAnchorId: StableIdV1;
  bidirectional: boolean;
  travelModes: RoadEdgeDtoV2["travelModes"];
  centerline: readonly Vec3V1[];
}

export interface WorldPlanV1 {
  schemaVersion: 1;
  terrain: CityTerrainV1;
  environment?: Readonly<{
    medium: "air" | "water" | "vacuum" | "mixed";
    biome: string;
  }>; // v1.1 可选；缺省为 air/unknown，海底必须显式声明 water
  sites: readonly SiteDtoV2[];
  routes: readonly RoutePlanV1[];
  objects: readonly WorldObjectDtoV2[];
  anchors: readonly AnchorDtoV2[];
  volumes: readonly WorldVolumeDtoV1[];
  places: readonly CityPlaceV1[];
  residents: readonly CityResidentV1[];
}

export interface WorldCompilerV1 {
  compile(plan: WorldPlanV1, context: CompileContextV1): CityWorldSnapshotV4;
}
```

Compiler MUST 验证引用、连通性、碰撞范围、Volume 和 Anchor，生成稳定排序、拓扑摘要与 Snapshot 摘要；缺失引用或不可用几何时失败关闭。RoutePlan 编译规则固定为 `RoadEdge.id = RoutePlan.id`、`directed = !bidirectional`，from/to、kind、travelModes 与 centerline 原样经校验后映射；不得由不同消费方自行补边。Site 不隐式生成 Object，空 `volumes` 不得被解释为已完成水下/空域能力。

### 2.5 Header、完整 Snapshot 与摘要域

```ts
export interface CityTerrainV1 {
  format: "heightfield-tiles-v1";
  tiles: readonly Readonly<{
    id: StableIdV1;
    assetDigest: DigestV1;
    bounds: Bounds3V1;
  }>[];
}

export interface CityRevisionSetV1 {
  worldRevision: RevisionIdV1;
  environmentRevision: RevisionIdV1;
  weatherRevision: RevisionIdV1;
  placeRevision: RevisionIdV1;
  residentRevision: RevisionIdV1;
  interactionRevision: RevisionIdV1;
  appearanceRevision: RevisionIdV1;
  renderRevision: RevisionIdV1;
  clockRevision: RevisionIdV1;
}

export interface CityWorldHeaderV1 {
  schemaVersion: 1;
  cityId: string;
  cityRevision: number;
  seed: number;
  generator: CityResolvedGeneratorIdentityV1;
  coordinateSystem: "city-local-m-v1";
  capabilities: readonly WorldCapabilityV2[];
  revisions: CityRevisionSetV1;
  topologyDigest: DigestV1;
  snapshotDigest: DigestV1;
}

export interface CityWorldSnapshotV4 {
  schemaVersion: 4;
  header: CityWorldHeaderV1;
  terrain: CityTerrainV1;
  environment: Readonly<{
    medium: "air" | "water" | "vacuum" | "mixed";
    biome: string;
  }>;
  roads: readonly RoadEdgeDtoV2[];
  sites: readonly SiteDtoV2[];
  objects: readonly WorldObjectDtoV2[];
  anchors: readonly AnchorDtoV2[];
  volumes: readonly WorldVolumeDtoV1[];
  places: readonly CityPlaceV1[];
  residents: readonly CityResidentV1[];
}
```

- `topologyDigest` 覆盖规范化 roads + anchors。
- `worldRevision` 是规范化静态空间事实摘要，覆盖 terrain/roads/sites/objects/anchors/volumes 及影响通行的语义环境；不覆盖天气、外观、时钟、Place/Resident 文本或私人状态。
- `snapshotDigest` 覆盖完整可移植公开内容，包含 Place/Resident 与语义环境；计算时排除 `cityRevision`、`snapshotDigest` 自身、动态天气状态、外观和时钟样本。
- `cityRevision` 是公共持久更改的单调 CAS 序号，不是内容摘要，也不是全局 Run 失效标志。
- 私有 Session Buildings 和 Story State 不进入任何公共摘要。

### 2.6 有界查询与资产读取

**SC-03**：Game 不直接接收完整 Snapshot。完整 Snapshot 仅用于 Builder、导入导出和 Headless Fixture。

```ts
export interface BoundedAssetReaderV1 {
  readonly digest: DigestV1;
  readonly byteLength: number;
  read(): Promise<Uint8Array>; // Host 在读取前后复核 digest 与资产字节上限
}

export interface WorldQueryV1 {
  header(): CityWorldHeaderV1;
  roads(query: { bounds?: Bounds3V1; limit: number; cursor?: string }): CityPageV1<RoadEdgeDtoV2>;
  objects(query: { bounds?: Bounds3V1; kinds?: readonly string[]; limit: number; cursor?: string }): CityPageV1<WorldObjectDtoV2>;
  anchors(query: { kinds?: readonly AnchorDtoV2["kind"][]; limit: number; cursor?: string }): CityPageV1<AnchorDtoV2>;
  volumes(query: { bounds?: Bounds3V1; kinds?: readonly WorldVolumeDtoV1["kind"][]; limit: number; cursor?: string }): CityPageV1<WorldVolumeDtoV1>;
  terrainSample(x: number, z: number): TerrainSampleV1;
}

export interface WorldAssetV1 {
  openTerrainTile(id: StableIdV1, expectedDigest: DigestV1): Promise<BoundedAssetReaderV1>;
  openModel(assetDigest: DigestV1): Promise<BoundedAssetReaderV1>;
}
```

所有查询 MUST 有服务端/宿主上限、稳定排序、分页和 Revision 身份；Cursor 绑定 header.snapshotDigest，世界变化后旧 Cursor 失败关闭。资产按 ID + digest 读取，不接受路径、URL 或任意 offset。

### 2.7 环境与外观只读引用

```ts
export interface CityEnvironmentV1 {
  schemaVersion: 1;
  medium: "air" | "water" | "vacuum" | "mixed";
  biome: string;
  simulationUtcMs: number;
  timeZoneId: string;
  localHour: number; // [0,24)
  environmentRevision: RevisionIdV1;
  weatherRevision: RevisionIdV1;
  clockRevision: RevisionIdV1;
  weather: Readonly<{ kind: string; intensity: number }>;
}

export interface CityRenderProfileRefV1 {
  id: string;
  version: string;
  digest: DigestV1;
  renderRevision: RevisionIdV1;
}

export interface CityAppearanceRefV1 {
  theme: Readonly<{ id: string; version: string; digest: DigestV1 }>;
  renderProfile: CityRenderProfileRefV1;
  appearanceRevision: RevisionIdV1;
}
```

环境语义、动态天气、时钟与外观分别绑定各自 Revision；不得用 worldRevision 代替动态状态版本，也不得把 medium 变化当作纯视觉更新。

## 3. Capability、Permission 与 Grant

**SC-04**：Capability 表示世界实际能力，Permission Request 表示 Manifest 申请，Grant 表示当前 Host 授权；三者不得互相推断。

```ts
export type WorldCapabilityV2 =
  | "world.snapshot" | "roads.graph" | "terrain.heightfield"
  | "environment.parameters" | "sites.indexed" | "objects.indexed"
  | "volumes.indexed" | "navigation.surface" | "navigation.volume"
  | "appearance.profiles" | "time.simulation"
  | "residents.registry" | "places.registry";

export type GamePermissionV2 =
  | "world.read" | "roads.read" | "terrain.sample" | "environment.read"
  | "sites.read" | "objects.read" | "volumes.read" | "navigation.query"
  | "appearance.read" | "time.read" | "residents.read" | "places.read"
  | "entities.write.owned" | "input.read" | "ui.hud" | "audio.play.assets"
  | "ui.dialogue" | "storage.game" | "story.schedule" | "actors.interact";

export interface GameAccessV1 {
  availableCapabilities: readonly WorldCapabilityV2[];
  requestedPermissions: readonly GamePermissionV2[];
  grantedPermissions: readonly GamePermissionV2[];
}

export type InvokeContextV1 = Readonly<{
  navigationMode?: "surface" | "volume";
  runId: string;
  playerScope?: PlayerScopeV1;
}>;
```

`canInvoke(permission, context)` MUST 同时满足：Permission 已申请、已授予、Run 有效；若 Permission 有世界映射，还要求对应 Capability 可用。`navigation.query` 按 `navigationMode` 映射到不同 Capability；`ui.hud` 等纯游戏权限不检查世界能力。

| Permission | Capability | 最低阶段 |
|---|---|---|
| world.read / roads.read / terrain.sample | world.snapshot / roads.graph / terrain.heightfield | V1 适配已有 |
| environment.read / sites.read / objects.read | environment.parameters / sites.indexed / objects.indexed | P0 |
| volumes.read | volumes.indexed | **P0：静态查询与基础穿越判定** |
| navigation.query | navigation.surface / navigation.volume | P1：有界路径规划 |
| appearance.read / time.read | appearance.profiles / time.simulation | P1 |
| residents.read / places.read | residents.registry / places.registry | P1 |

V1 适配器仅做显式映射：旧 `world.read → world.snapshot + world.read`，旧 `roads.read → roads.graph + roads.read`，旧 `terrain.sample → terrain.heightfield + terrain.sample`。安装游戏不自动授予 Permission，City 支持 Capability 也不自动授权。

## 4. Build、Revision 与失效

### 4.1 不可变 Build

**SC-05**：WorldBuild 和 GameBuild 都是内容寻址、不可变、自包含产物。BuildId 输入至少包括规范化 Manifest、源/编译产物、资产摘要、Generator/Compiler/SDK 协议版本、工具链及固定参数。

运行、测试、预览和发布只读取封存产物。工作区变化不影响旧 BuildId；只有封存缺失、摘要不匹配或调用方显式要求当前工作区匹配时才拒绝。新工作区内容必须产生新 BuildId。

### 4.2 Revision 失效矩阵

| 变更 | 必变 Revision | Run/Scheduler 处理 |
|---|---|---|
| 地形、道路、稳定世界对象 | worldRevision + cityRevision | 仅终止或重绑定依赖相关空间事实的 Run |
| 语义环境 medium/深度 | environmentRevision + cityRevision；影响通行时再变 worldRevision | 重校验环境/导航依赖，必要时停止或迁移 |
| 动态天气 | weatherRevision + cityRevision | 不终止物理；重校验明确声明天气条件的规则 |
| 主题/材质 | appearanceRevision + cityRevision | 不终止 |
| Render Profile | renderRevision + cityRevision | 不终止；失败回滚旧管线 |
| Interaction 绑定 | interactionRevision + cityRevision | 已启动 Run 通常继续；新启动读最新映射 |
| Place 公共属性 | placeRevision + cityRevision | 重校验相关地点与剧情条件 |
| Resident 公共身份/行程 | residentRevision + cityRevision | 重校验 Actor 与日程依赖 |
| 时钟锚点/策略 | clockRevision + cityRevision | Scheduler 重校验，不改变道路摘要 |
| 某玩家私人剧情 | 该 player scope 的 storyRevision | 只影响对应 player/city/game；不增加公共 cityRevision |

每个公共写命令 MUST 携带对应 `expectedRevision + operationId`；剧情写命令按 §5.3 携带 Story/Clock Revision。冲突返回稳定诊断与当前 Revision，不得悄悄覆盖。Patch Preview 不是 Commit。

## 5. City Time、Scheduler 与原子事务

### 5.1 时间权威

一座 City 只有一个可提交故事的 Simulation Time。真实 UTC 默认 1:1，IANA timeZoneId 解释日历；Game/Agent 只读。Replay Cursor 与 Cinematic Time 只读，Preview Clock 只写隔离 Fork，Fixed Step 只影响当前 Run。

```ts
export interface CityTemporalSnapshotV1 {
  schemaVersion: 1;
  cityId: string;
  clockId: string;
  simulationUtcMs: number;
  timeZoneId: string;
  mode: "realtime" | "paused" | "accelerated";
  timeScale: number;
  tick: number;
  clockRevision: RevisionIdV1;
  uncertainty?: "clock_uncertain";
}

export interface CityTemporalPolicyV1 {
  schemaVersion: 1;
  defaultMode: "realtime";
  timeZoneId: string;
  offlinePolicy: "pause" | "advance";
  maxCatchUpMs: number;
}
```

App 关闭期间没有后台 Scheduler。City `offlinePolicy` 只有 `pause | advance`：pause 冻结 Simulation 锚点；advance 按真实 UTC 推进并在 `maxCatchUpMs` 内有界恢复。Rule 的 `missedPolicy` 独立决定 `skip | reschedule | expire | persist`；reschedule 必须有延迟和次数上限，persist 只保存待处理事实，不自动选择或发奖励。

本地时钟回拨不得重复事件，异常前跳进入有界恢复并标记 `clock_uncertain`；联机共享剧情必须由服务端权威时钟仲裁。

### 5.2 Scheduler 记录

Scheduler 至少持久化：

```ts
interface StoryEventRecordV1 {
  eventId: string;
  occurrenceId: string;
  dueAtUtcMs: number;
  status: "scheduled" | "due" | "processing" | "committed" | "skipped" | "expired" | "failed";
  lastProcessedTick: number;
  idempotencyKey: string;
  storyRevision: RevisionIdV1;
  clockRevision: RevisionIdV1;
}
```

去重键为 `playerId/cityId/gameId/ruleId/occurrenceId`。`processing` 不等于剧情事实发生，只有 §5.3 原子提交成功才可进入 `committed`。

### 5.3 Story Commit 与 Outbox

**SC-06**：LLM/Agent 只生成候选 Intent。Actor Turn 期间不得持有数据库事务；最终校验与提交使用短事务。

```text
Read Canon + State + Clock + allowed intents
  -> Actor Turn: propose Intent（事务外）
  -> Read fresh state + validate identity/permissions/time/location/story invariants
  -> CAS Transaction: event + story state + outbox
  -> Broadcast committed outcome
```

```ts
interface ValidatedStoryIntentV1 extends ActorIntentV1 {
  canonDigest: DigestV1;
  baseStoryRevision: RevisionIdV1;
  auditTraceId: string;
}

interface StoryCommitCommandV1 {
  operationId: OperationId;
  eventId: string;
  playerScope: PlayerScopeV1;
  cityId: string;
  gameId: string;
  residentId?: StableIdV1;
  expectedStoryRevision: RevisionIdV1;
  expectedClockRevision: RevisionIdV1;
  intent: ValidatedStoryIntentV1;
}
```

Event Record、Story State、奖励和待通知 Outbox MUST 在同一权威事务内提交。广播成功不代表提交成功；崩溃后凭 `operationId/eventId` 幂等恢复。晚到 Actor 回调必须重新检查 Run 和 Revision，不得写入已释放或已过期状态。

### 5.4 Storage

Game Storage 按 `playerId × cityId × gameId` 隔离，Actor 记忆额外包含 `residentId`。单键更新使用 `expectedRevision + operationId` CAS；跨键更新使用有界声明式事务。不得提供无条件 set，不得向游戏暴露数据库句柄或任意事务回调。

## 6. Game Registry、Interaction 与 Run

### 6.1 两级 Registry 与统一启动读模型

**SC-07**：GameTypeRegistry 注册类型/运行时契约，InstalledGameRegistry 注册具体安装实例；InteractionRouter 只消费统一的 InstalledGame 读模型，不分别理解老战棋和新代码游戏。

```ts
interface InstalledGameEntryV1 {
  id: string;
  presentations: readonly ("overlay" | "exclusive")[];
}

interface InstalledGameV1 {
  installationId: string;
  gameId: string;
  gameVersion: string;
  kind: "declarative" | "legacy-runtime" | "code";
  buildId?: BuildId;
  contentDigest: DigestV1;
  manifestDigest?: DigestV1;
  trustLevel: "legacy" | "local-trusted" | "signed-community";
  status: "installed" | "disabled" | "revoked";
  entries: readonly InstalledGameEntryV1[];
}
```

MiniGamePackV1 通过 Declarative Adapter，旧 GameRuntimeV1 通过 Legacy Runtime Adapter，CodeGameManifestV2 通过 Code Host Adapter 注册。CityEngine 不得保留绕过 Router 的新业务分支。

### 6.2 Interaction Descriptor、Launch 与生命周期

```ts
export type CityInteractionActionV1 =
  | { type: "game.launch"; gameId: string; entry?: string; presentation: "exclusive" | "overlay" }
  | { type: "dialogue.open"; dialogueId: string; presentation: "overlay" }
  | { type: "place.enter"; placeId: StableIdV1 }
  | { type: "quest.start"; questId: string };

export interface CityInteractionDescriptorV1 {
  schemaVersion: 1;
  id: StableIdV1;
  target: CityTargetRefV1;
  trigger: "click" | "approach" | "event";
  action: CityInteractionActionV1;
  conditions?: readonly Readonly<{
    key: string;
    op: "eq";
    value: string | number | boolean;
  }>[];
  priority?: number;
}

interface GameLaunchRequestV1 {
  launchId: string; // 幂等
  cityId: string;
  cityRevision: number;
  worldRevision: RevisionIdV1;
  snapshotDigest: DigestV1;
  interactionRevision: RevisionIdV1;
  environmentRevision?: RevisionIdV1;
  weatherRevision?: RevisionIdV1;
  placeRevision?: RevisionIdV1;
  residentRevision?: RevisionIdV1;
  target: CityTargetRefV1;
  gameId: string;
  entry: string;
  presentation: "overlay" | "exclusive";
  playerScope: PlayerScopeV1;
}
```

唯一启动链：CityEngine 拾取稳定目标 → InteractionRouter 选择 Descriptor → 校验安装状态、entry、世界能力、申请权限与 Host Grant → 申请租约 → 创建 Run → 运行 → 退出/失败后清理并恢复 City。旧怪兽、汽车和飞机必须经 Legacy Adapter 走同一 Router。

Run 状态至少覆盖 `created → preparing → ready → running ⇄ paused → stopping → stopped`，以及 `finished/failed/cancelled` 和最终 `disposed`。V2 保持同步 `setup()` 注册和唯一异步 `onStart()`；所有异步资源、Dialogue 与 Actor Turn 可取消。每次 await 恢复必须重新鉴权；异步清理有超时且幂等，晚到回调不得修改已释放 Run。

`overlay` 只申请 UI/Input Focus，`exclusive` 保持 Scene/Camera 互斥。相同 launchId 不得创建第二个权威 Run。

## 7. Actor 与远程数据政策门

公共 Resident、Place、Canon 引用属于世界内容；私人好感度、选择、摘要和记忆按 `playerId × cityId × gameId × residentId` 隔离。Codex/Claude Thread 是可重建计算资源，不是角色身份或事实权威。

```ts
export type ActorIntentKindV1 =
  | "speak" | "move" | "interact" | "invite" | "join-game"
  | "offer-quest" | "suggest-meetup";

export interface ActorIntentV1 {
  kind: ActorIntentKindV1;
  targetId?: StableIdV1;
  payload?: Readonly<Record<string, string | number | boolean>>;
}

export interface CityAgentActorBindingV1 {
  schemaVersion: 1;
  actorId: string;
  residentId: StableIdV1;
  mode: "external-mcp" | "managed-session";
  personaRef: string;
  allowedIntents: readonly ActorIntentKindV1[];
  routineRef?: string;
}
```

City `allowedIntents` 与 Game `proposedIntents` MUST 使用同一类型。Actor 不得直接修改 Canon、公共 Clock、游戏胜负或玩家奖励。

**SC-08**：在仓库数据政策新增独立、用户主动触发、可撤销的远程 Actor 例外前，外部或托管 Actor 只能处理合成 Preview 数据，不得接收真实玩家输入、私密关系记忆、剧情摘要或可关联身份。未来例外必须固定字段白名单、目的地、留存/撤销和本地降级。Manifest、Permission、Grant 或 MCP 声明均不构成远程发送授权；未开放时返回 `game_actor_remote_unavailable`。

## 8. Render 与确定性

RenderProfile 由 City SDK 声明、City Runtime 的可信 Adapter 实施。风格切换只改变 renderRevision，不改变空间几何、拓扑、游戏计时、Story State 或 Run 身份。

Generator 确定性 MUST 由工程机制保证：

- 禁止未授权 Date、Math.random、网络、文件系统和环境变量；随机只能来自注入 seeded PRNG。
- 数组、对象键、拓扑边和资产引用按稳定 ID/规范键排序后计算摘要。
- 使用 Canonical JSON；统一 UTF-8、TypedArray 字节序和序列化规则。
- 浮点坐标按合同精度量化，规范负零，拒绝 NaN/Infinity；四元数与法线归一化后再量化。
- 同 codeDigest + seed + params + assetsDigest 在支持的 Node/OS/CPU 环境产生相同 snapshotDigest；不支持的环境必须明确拒绝，不得静默近似。

## 9. 错误域与运行证据

City 生成器、地形、公共时钟和公共世界动作抛 `city_*`；Game 加载、权限、运行、玩家剧情和 Story 事务抛 `game_*`。`city_actor_intent_denied` 仅用于公共世界动作，`game_actor_intent_denied` 仅用于玩家剧情 Intent，不是同义别名。

一次错误保留 `cause/traceId` 并可映射恢复动作，但不得重复发出两个互相冲突的根因码。诊断码必须分别记录“枚举已声明”和“运行路径已发射 + 测试”。

Build、Headless 和 Studio Preview 返回适用的 `buildId/cityId/cityRevision/worldRevision/snapshotDigest/interactionRevision/runId/evidenceId`。`queued/running/succeeded/failed/cancelled/preview-ready` 必须分开，生成 URL 不等于渲染完成。

## 10. 合并门槛

| ID | 必须验证的情境 |
|---|---|
| SC-AC01 | 两包编译引用同一组 Snapshot 子 DTO，TypeScript 与 JSON Schema 一致 |
| SC-AC02 | Generator routes 编译为 roads，Site/Object/Anchor/Volume 引用全部有效 |
| SC-AC03 | 同 codeDigest/seed/params/assetsDigest 在支持矩阵中得到相同 snapshotDigest |
| SC-AC04 | 无 Capability、已申请但未授权、已授权但未申请均被拒绝；纯游戏权限不检查世界能力 |
| SC-AC05 | 静态水体/ring Volume 查询与线段穿越判定可用，未假装实现 3D pathfinding |
| SC-AC06 | Game 只能读取 WorldHeader 和有界查询；大 Snapshot 不进入逐帧 API，资产按 digest 读取 |
| SC-AC07 | 旧怪兽/汽车/飞机经 Legacy Adapter 后保持等价，Router 只读统一 InstalledGame |
| SC-AC08 | Render 切换不变 worldRevision 和 Run；Interaction 变化不错误终止已有 Run |
| SC-AC09 | 语义环境、天气、Place、Resident 和 Clock 各自更新 Revision，不错误更新 worldRevision |
| SC-AC10 | 旧 BuildId 封存完整时仍可测试/预览/发布；更改 workspace 产生新 BuildId |
| SC-AC11 | Headless 使用目标 City Snapshot；关闭 Studio 时视觉 Preview 明确 unavailable |
| SC-AC12 | Replay/Preview Fork 无法写真实 Story、奖励或经济状态 |
| SC-AC13 | Actor 重启、压缩和并发后 Canon/Story/公共位置一致，晚到回调不能提交 |
| SC-AC14 | 同一 Event/Operation 重试不重复奖励，Event/Story/Outbox 同事务一致 |
| SC-AC15 | 并发 Storage CAS 只有一个成功，跨键状态与 Event Log 原子提交 |
| SC-AC16 | onStart 取消、异步清理超时和 launchId 重试均无重复 Run 或租约泄漏 |
| SC-AC17 | 海底 City + 基础 Volume Game 在真实 Studio 完成生成→启动→结束，完整 navigation.volume 仍属 P1 |
| SC-AC18 | 原 WorldProfile、SkinPack、MiniGame、ContentPackageV2 和 city-sdk/runtime 兼容读取 |
| SC-AC19 | 远程政策未开放时真实 Actor 数据不离开本机，合成 Preview 与固定剧本可运行 |
| SC-AC20 | 五个构建环境矩阵通过：开发仓库、干净 macOS、无 Node、无源码、CLI/MCP 独立启动 |

## 11. 实施序列与已决 ADR

| 阶段 | 所有者 | 必须交付 |
|---|---|---|
| F0 Contract Freeze | City + Game SDK | 本 RFC 的 TS + JSON Schema、交叉 import 编译与 CI |
| F1 World Compile | City Builder/Runtime | Plan→Snapshot、稳定 ID、Volume、确定性、真实 Headless Fixture |
| F2 Game Host Bridge | Game SDK/Runtime | Registry、Grant、Legacy Adapter、Launch、Lease、Cancel |
| F3 Studio Loop | Creator Studio/MCP | Builder Job、真实 Preview、Inspect、Visual Diff、Render Switch |
| F4 Spatial Game | City Game SDK | 基础 Volume 穿环/检查点、计时、计分，不做完整 3D 寻路 |
| F5 Story Game | City + Game + Narrative/Actor Runtime | NPC/Place、Scheduler、Story Transaction、Replay/Preview 隔离 |
| F6 Community | 安装与安全平台 | 签名、沙箱、下载、可执行世界包授权、多人隔离 |

既有两份文档的构建器可交付、不可变 Build、真实 City Headless 和 Creator MCP 写入语义四项前置仍先于 F1～F3。

已决事项，不留实现期暗中选择：

1. 公共契约继续使用 `@oh-agent/city-sdk/contracts`，不新增第四套包；多语言服务端确有需求时再经新版本拆包。
2. `worldRevision` 使用规范化静态空间内容摘要，`cityRevision` 保持公共 CAS 序号。
3. P0 提前基础 Volume 查询和穿越判定，完整三维导航保留 P1。
4. 单机使用可信桌面宿主，远程共享使用服务端权威时钟和状态。
5. NPC 公共位置按权威 Event Log 序列化仲裁，私人对话与记忆按玩家作用域隔离。
6. GameTypeRegistry 与 InstalledGameRegistry 分层，InteractionRouter 只认统一安装读模型。
7. Narrative Engine 独立；LLM 事务外生成，Runtime 短事务提交。
8. 远程 Actor 数据政策未开放前一律失败关闭。
