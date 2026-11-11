# Oh Agent 创作 SDK API v0.1

状态：v0.1 接口规格与初始实现。`@agent-vitals/city-sdk` 已实现小游戏 JSON 解析、布局/玩法/挂载校验、CityWorldProfileV1 世界生成配置校验、锚点/场景对象/资产目录查询、皮肤兼容、基础 GLB 检查、确定性规则运行，以及有界的 City mini-game 包 manifest 结构校验。`oh-agent-sdk` 支持初始化 App Game WebView 源码、City mini-game 项目和 City world profile、校验、无头试玩、生成和校验 unsigned development package；包摘要使用规范化 JSON 与 SHA-256，明确不是可安装/可信发布包。App Game 模板默认链接当前 checkout 的私有 App SDK，也可通过 `--app-sdk-tarball` 指向显式本地 tarball；该 tarball 已在仓库外生成的样例中完成安装、TypeScript 检查和 Vite production build。App SDK 仍未发布 registry，City SDK 也未发布；这些能力不注册桌面插件、不签名、不授予运行权限，也不构成可安装包。City 可信 TypeScript 适配器、官方活动运行器、Miami/沙丘生成器，以及 Creator Studio 首版项目服务、MCP 规则/场景/挂载/皮肤事务和 Studio 显式发布到 City 的不可变本地 release 已接入；release 固定注册的 City 皮肤 ID，City 小游戏运行期间临时应用并在正常退出时恢复。City 地图可发现和启动兼容当前布局的已发布驾驶小游戏。Studio→City→Studio 的本地可视试玩导航、发布快照认领、有界终态摘要持久化、`creator_playtest_history` MCP 读取和 projectId/revision 恢复已接入；City World Profile 也新增 MCP 两阶段预览/应用，只能修改当前官方 City 已注册的生成器和主题。GLB 可导入项目级 SHA-256 内容寻址目录，Creator 场景对象可引用已导入模型，CLI 开发包也能携带这些资源。Creator release 现在还支持显式静态盒体碰撞代理：SDK 和 Rust 分别校验场景对象，City 驾驶运行时把有界碰撞代理绑定到 release/world revision 并合并进冻结碰撞索引；模型不自动推断碰撞。桌面发布会把场景、资产目录和精确摘要引用冻结到 release；原始 GLB 字节仍存于本机项目的内容寻址文件中，因此 release 不是可导出或独立安装的完整包。City 通过只对当前活动官方 City WebView 开放的 `ohcityasset://` 协议按摘要读取资产，并在运行时加载受限的静态 GLB。此链路支持有界的静态网格呈现，不代表完整 glTF 支持或第三方包安装。输入轨迹/事件级断言证据与完整编辑器上下文恢复尚未实现。其他待实现项包括 App SDK 的受控外部分发与插件注册/安装、步行活动运行时、组合 City World 项目和可安装格式、签名/外部包发现、完整 glTF 安全导入、Studio/Rust 提交阶段的真实场地可达性验证、按用户/项目隔离的 MCP grants。宿主权限与交接沿用 [Creator Studio 架构](AGENT_CITY_CREATOR_STUDIO_ARCH_2026_11_09.md)。开发包格式校验和摘要验证不替代发布者签名、来源信任或安装授权。

## 1. 包与模板

### 1.1 SDK 包构建与分发边界

`@agent-vitals/city-sdk` 的 Node 构建入口为根包 `.` 和 `./runtime`，均输出 ESM 与对应声明文件。包内构建使用精确钉定版本的 TypeScript 7.0.2 生成 declarations、esbuild 0.25.12 打包 JavaScript；包级 `package-lock.json` 锁定构建工具依赖。`files` allowlist 纳入 `dist/`、`bin/` 和 `README.md`，不把源码、测试、脚本或本机依赖放入 tarball。干净检出后需先在 SDK 包目录运行 `npm ci` 和 `npm run build`，再运行 City UI 的 typecheck/build；UI 的本地 `file:` link 不会替 SDK 安装构建工具。SDK 包目录可运行 `npm ci`、`npm run typecheck`、`npm run build` 和 `npm run pack:check`。`pack:check` 先构建，再使用 `npm pack --dry-run` 检查 tarball 文件清单，不会发布。

当前构建和打包检查只证明仓库内实现能产出一个最小 npm 包，不代表 API 已稳定、包已发布或官方桌面可安装。首次发布前仍需补充版本策略、正式许可证、变更日志、独立消费者兼容性检查与包完整性/签名安装链；不要让普通应用构建自动发布。

| 入口 | 职责 | 依赖 |
|---|---|---|
| `@agent-vitals/app-sdk` | 插件清单类型、宿主 RPC、WebView 生命周期与授权数据客户端。复用现有包和桥接 | 独立 App Game 使用这一层 |
| `@agent-vitals/city-sdk` | 布局、世界生成 profile、皮肤、锚点、挂载、规则定义和纯校验。根入口可在 Node 与浏览器运行 | City 世界、内嵌小游戏、Studio 和 CLI 使用 |
| `@agent-vitals/city-sdk/runtime` | 编译规则、解析挂载、执行规则和无头测试。可信 City 适配器接入现有场景与车辆 | 依赖 City SDK 契约。官方 City、Studio 预览和 CLI 使用同一实现 |
| `oh-agent-sdk` | 当前实现 `init app-game/city-minigame/city-world`、City mini-game `validate`、`validate-world`、`asset inspect/import/verify`、`sync-refs`、`playtest`、`pack`、`verify`；可视预览和正式安装仍未实现 | 使用以上契约和运行器。仅对明确指定的 GLB 执行检查/导入，资产目录限定在本地项目；不连接桌面 Creator 服务 |

`oh-agent-sdk init app-game` 默认生成引用本地 App SDK checkout 的 Vite WebView 项目，也可用 `--app-sdk-tarball` 指向本地 tarball；该路径已验证可在仓库外独立安装并构建。它可编译为 WebView 静态资源，但不会注册插件、声明官方 descriptor grants 或安装到桌面宿主；App SDK 仍是 private workspace 包，尚未发布 registry。`city-world` 生成布局、皮肤引用、锚点和可选挂载的组合项目，最终使用官方 City 运行时。`city-minigame` 生成规则和素材项目，交付可装入 City 的玩法包。

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

`@agent-vitals/app-sdk` 已提供这层便利 API。`connectAppGame` 等待 `start()` 成功后，再等待宿主确认空工具栏 `toolbar.update` 才返回 disposer/标记 ready；启动失败会上报 `runtime.error`、调用 `dispose()` 清理部分初始化资源并拒绝 Promise。suspend/resume 重复事件会合并，显式 dispose 与 `pagehide` 清理幂等。`createAppHostClient().state` 只通过 `/ui-host` 的 `plugin_request` 调用 `plugin.state.read/write`，校验 envelope、稳定错误码、state key 和 revision；描述表授权、并发及序列化大小仍由宿主执行。它不提供通用 IPC 或文件访问。独立游戏的开发打包输出预编译 WebView 资源和描述文件。正式桌面分发首轮走官方注册与构建链。外部可执行包的安装、签名、进程隔离和数据授权另行验收。

## 3. City 内容与绑定

以下签名描述首轮公开字段。布局的地形、道路与模型输入使用独立的版本化 schema，先支持固定合成场地以及内置生成器的有界参数。兼容内置生成器通过 ID 与版本选择。

```ts
type ContentKind = "city-layout" | "city-skin" | "city-minigame";
type ContentRef<K extends ContentKind = ContentKind> = {
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
  anchors: CityAnchorV1[];
  /** Optional in general layouts; trusted Creator snapshots include bounded traversal topology. */
  links?: CityAnchorLinkV1[];
}

interface CityAnchorLinkV1 {
  id: string;
  fromAnchorId: string;
  toAnchorId: string;
  capabilities: AnchorCapability[];
}

interface CitySkinPackV1 {
  schemaVersion: 1;
  id: string;
  renderContract: "city-render-v1";
  compatibleGeographies: CityGeographyGeneratorV1[];
  visuals: { themeId: "miami" | "desert" };
}

type CityGeographyGeneratorV1 = "coastal-islands-v1" | "arid-dunes-v1";

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

interface SceneTransformV1 {
  positionMeters: { x: number; y: number; z: number };
  rotationRadians: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}
type SceneObjectV1 =
  | { id: string; kind: "model"; asset: ModelAssetRefV1; transform: SceneTransformV1 }
  | { id: string; kind: "anchor"; anchor: CityAnchorV1; transform: SceneTransformV1 };
interface SceneDraftV1 { schemaVersion: 1; objects: ReadonlyArray<SceneObjectV1> }
interface ModelAssetRefV1 {
  package: ContentRef;
  assetId: string;
  digest: `sha256:${string}`;
}
interface ModelAssetCatalogEntryV1 {
  ref: ModelAssetRefV1;
  relativePath: string;
  byteLength: number;
  boundsMeters: { x: number; y: number; z: number };
  unit: "meter";
}
interface ModelAssetCatalogV1 { schemaVersion: 1; entries: ReadonlyArray<ModelAssetCatalogEntryV1> }
interface ModelAssetFilterV1 {
  assetId?: string;
  packageId?: string;
  packageKind?: ContentKind;
  maxByteLength?: number;
}
interface ResolvedModelAssetRefsV1 {
  refs: ReadonlyArray<ModelAssetRefV1>;
  entries: ReadonlyArray<ModelAssetCatalogEntryV1>;
}
interface SceneObjectFilterV1 {
  kind?: SceneObjectV1["kind"];
  id?: string;
  assetId?: string;
  anchorKind?: AnchorKind;
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

declare function validateCityLayout(input: unknown): Result<CityLayoutV1>;
declare function validateCitySkinPack(input: unknown): Result<CitySkinPackV1>;
declare function validateMiniGamePack(input: unknown): Result<MiniGamePackV1>;
declare function validateAssetRefs(input: unknown): Result<ResolvedModelAssetRefsV1>;
declare function listAssets(catalog: ModelAssetCatalogV1, filter?: ModelAssetFilterV1): ModelAssetCatalogEntryV1[];
declare function listAnchors(layout: CityLayoutV1, filter?: AnchorFilterV1): CityAnchorV1[];
declare function listSceneObjects(scene: SceneDraftV1, filter?: SceneObjectFilterV1): SceneObjectV1[];
declare function validateMount(input: { layout: unknown; game: unknown; mount: unknown; resolvedRefs?: {
  layout: ContentRef<"city-layout">; game: ContentRef<"city-minigame">;
} }): Result<ResolvedMountV1>;
```

Creator 快照中的 layout、anchor、link 与 `geometryRef` 标识符必须是稳定的宿主安全 ID：首字符为 ASCII 字母或数字，后续仅允许 ASCII 字母、数字、`.`、`_`、`:`、`-`，最长 128 字节。City 内部道路/节点 ID 不直接成为公开 anchor ID；适配器必须映射为确定性、无路径分隔符的 ID，并在几何映射中保留对应关系。几何坐标和道路内部标识仍留在受信任的 City 运行时，不进入 Creator 快照。

- 当前 `CityLayoutV1` 仅投影稳定锚点目录；锚点几何保存在可信引擎适配器中，由 `geometryRef` 关联，不随内容 JSON 暴露。SDK 的 layout 校验限制最多 20,000 个锚点，拒绝重复 ID、未知字段、未知能力与未知坐标系，并返回 SDK 自有的冻结快照。City 适配器另限制锚点 20,000 个，并过滤断开节点、桥面及非地面可驾驶道路。`listSceneObjects` 目前只对传入的有界内存草稿执行只读过滤，返回源顺序；它没有连接项目服务，也不提供分页或持久化项目读取。
- 一个槽位的绑定数组有顺序，规则可引用索引。`validateMount` 校验 ID、版本 1 schema、锚点类型/能力、槽位数量和整数参数范围。它只根据布局与玩法对象检查 ID；当调用方传入 `resolvedRefs` 时还逐项比较完整 `kind/id/version/digest`。包解析器必须先从可信 manifest 解析并校验摘要，再将解析出的引用传入；纯 SDK 校验不负责文件散列、签名或权限验证。
- `validateMount` 校验声明、摘要、数量、锚点类型和能力。若布局携带 `links`，SDK 会按槽位所需能力检查绑定锚点能否从入口到达；City 适配器将可信道路事实投影到有界链接快照，Creator Studio、Rust 提交服务和 City 运行时复用该拓扑。几何存在性、净空、碰撞和路线质量仍由 City 可信场地适配器校验。没有 `links` 的一般布局只通过结构校验，不代表空间可达。
- 皮肤可替换材质、光照和非碰撞外观。改变道路、实体足迹或碰撞属于布局修改。小游戏存档按城市实例和 mountId 隔离，游戏版本变化时显式处理存档兼容。
- 打包输出 `PackageManifestV1` 与文件清单。包摘要取规范化 manifest 主体和排序后的文件摘要，摘要字段和签名本身排除在摘要输入之外。内容引用只解析包内声明资源或固定版本的依赖。打包、安装和权益分别记录。

#### PackageManifestV1（City mini-game v1）

```ts
interface PackageManifestV1 {
  schemaVersion: 1;
  package: { kind: "city-minigame"; id: string; version: string };
  entry: { layout: string; game: string; mount: string };
  files: Array<{ path: string; mediaType: "application/json" | "model/gltf-binary"; byteLength: number; sha256: `sha256:${string}` }>;
  packageDigest: `sha256:${string}`;
  signature: null;
}
```

v1 development artifact 收 layout/game/mount JSON，并可选包含 `assets/catalog.json` 与 `model/gltf-binary` 文件。JSON 文件摘要覆盖递归按 key 排序、保留数组顺序的 canonical JSON UTF-8 字节；GLB 以规范 base64 字符串存入 JSON artifact，manifest 的 `byteLength` 和 SHA-256 覆盖解码后的原始 GLB 字节。文件清单拒绝绝对路径、`..`、反斜杠、重复/未声明文件和超限内容（单个 GLB 最大 64 MiB，包原始内容总计最大 100 MiB）。mount 引用携带对应 layout/game 的同一摘要。包摘要覆盖 `{ schemaVersion, package, entry, files }` 的 canonical JSON，排除 `packageDigest` 与 `signature` 字段。`validatePackageManifest`/`validateCityContentPackage` 校验结构、媒体类型和 base64 长度/规范编码；CLI `verify` 重算每个 JSON/二进制文件及 manifest 摘要，并对 GLB 执行当前受限结构检查。CLI `pack` 生成的 `oh-agent-city-package-v1` 仍是 unsigned development artifact；不代表 Creator/City 能加载包内模型，也不能安装、上架或视为可信发布内容。签名和安装由后续受信任发布/安装链负责。

### 3.1 模型资源与场景实例

首版提供随内容包版本化的本地模型目录。官方内置模型和创作者导入的 GLB 都用同一种引用方式。模型条目描述资源，场景实例决定把哪个模型放在哪里。十个街区可以引用同一份模型，每个实例各有稳定 ID、位置、旋转和缩放。

| 建议 API | 输入与输出 |
|---|---|
| `listAssets(catalog, filter?)` | 筛选调用方提供的已校验目录快照；不扫描磁盘或代表持久化资产商店 |
| `inspectGlbBytes(bytes)` | 对内存中的 GLB v2 做有界容器、嵌入 URI、bufferView/accessor 边界和基础 POSITION 网格统计；当前只支持常见 SCALAR/VEC2/VEC3/VEC4 accessor，明确拒绝稀疏/矩阵 accessor、多 buffer 和声明的扩展；不读取路径、不验证散列/签名 |
| `oh-agent-sdk asset inspect <file.glb>` | 显式读取最多 64 MiB 的本地文件，输出 GLB 结构摘要和所读字节的 SHA-256；不复制文件、不签名、不打包或安装 |
| `oh-agent-sdk asset import <project> <file.glb> --asset-id <id>` | 检查显式指定的 GLB，将原始字节复制到项目 `assets/<sha256>.glb`，并更新 `assets/catalog.json`；拒绝覆盖同一 ID 对应的不同内容 |
| `oh-agent-sdk asset verify <project>` | 校验项目资产目录元数据，重新读取每个内容寻址文件并检查字节长度、SHA-256 和受限 GLB 结构；不代表签名或发布审核 |
| `oh-agent-sdk pack <project> --out <file>` | 若项目有已导入资产，将目录、场景草稿和原始 GLB 纳入 artifact；base64 仅是 JSON 容器编码，manifest 摘要覆盖解码后的 GLB 字节 |
| `validateSceneDraft(scene)` | 校验场景实例 ID、类型、变换预算和模型引用结构；通过 `validateAssetRefs` 将引用解析到已校验资产目录 |
| `inspectModel(source)` | CLI 或 Studio 可信导入阶段读取文件并组合字节检查、受限 GLB 结构验证和目录登记；CLI 与桌面 Creator Studio 已有各自的导入适配器，不代表完整 GLB 语义验证 |
| `validateAssetRefs({ refs, catalog })` | 校验模型引用能否解析到已检查的目录快照、包版本与摘要是否一致，以及路径、包围盒和声明大小预算 |
| `listSceneObjects(scene, filter?)` | 查询内存草稿中的模型实例和锚点，按类型、ID、资源 ID 或锚点类型过滤；桌面项目读取/分页尚未实现 |
| `scene.placeModel` / `scene.updateModel` / `scene.removeModel` | 创建、移动或删除模型实例。Studio 和 MCP 经 `edit_preview` / `edit_commit` 提交 |
| `anchor.upsert` / `anchor.remove` | 创建、移动或删除草稿中的出生点与检查点等锚点。修改时重新检查引用和绑定 |

`ModelAssetRefV1` 由包引用、包内 `assetId` 和资源 SHA-256 摘要组成。`validateAssetRefs` 只校验调用方提供的已检查目录快照及其元数据，拒绝不安全相对路径、重复目录条目、未知资源、摘要/版本不匹配和超限声明；它不扫描磁盘或验证签名。项目级 `CityProjectAssetCatalogV1` 是本地开发目录：CLI `asset import` 将显式选取的 GLB 复制到由其 SHA-256 派生的相对路径，并输出当前游戏 identity 下可放入场景草稿的 `ModelAssetRefV1`；CLI `validate` 用项目目录解析场景中的模型引用，`pack` 将目录、scene.json 和 GLB 纳入 artifact。桌面 Creator Studio 也可显式打开原生文件选择器导入 GLB；Rust 项目服务校验资源、保存项目级内容寻址文件并增加项目 revision，场景 preview 和发布会检查引用、资产目录与磁盘字节摘要。该本机 UI 操作不接受 Agent/MCP 传来的文件路径或字节。桌面 release 会冻结场景与所引用资产的目录/摘要元数据；原始 GLB 字节仍存于本机项目的内容寻址文件中，所以 release 不是独立可分发包。City runtime 使用独立 `ohcityasset://localhost/v1/<releaseId>/<sha256>.glb` 请求读取资产；宿主仅允许活动官方 City WebView 请求，并按 release 目录与摘要重验原始字节后返回。Three.js 加载器按 release+digest 去重，实例变换按米制坐标应用，并有模型数量、资产数量和累计字节预算；资源随 City overlay 卸载释放。该运行时目前仅覆盖受限静态 GLB 子集：禁止外部 URI、扩展、动画和蒙皮，桌面检查器不是完整 glTF 验证器。支持 GLB 的官方资源格式扩展、签名和安装审核仍待实现。模型条目记录相对文件名、摘要、包围盒和米制单位。玩法包可以引用声明的素材，布局拥有静态障碍与触发区域，皮肤只替换视觉资源。可交互对象的锚点与模型实例分别记录。

桌面首轮编辑范围是基于固定布局的场景草稿，允许修改模型实例、出生点、有界触发区域和显式静态盒体碰撞代理。当前 Studio 通过场景 JSON 编辑这些碰撞代理，尚无独立图形化碰撞编辑器。地形与道路生成参数先通过 CLI 创作。草稿实例和锚点使用稳定 ID，移动或改名保留引用。删除仍被挂载引用的锚点时，预览列出受影响的槽位，创作者可在同一批操作内换绑或移除挂载。模型实例可以复用官方提供的对象模板，模板可带预设的碰撞或交互配置，实例化后这些配置分别记录。

### 3.2 场地查询与碰撞

City 已有固定步长驾驶模拟、地表查询和飞行扫掠碰撞。首版复用这些实现，通过受信任的场地适配器提供 `sampleGround(point)`、`checkClearance(shape, pose)` 和 `validateRoute(anchorId, capability)`。查询绑定到同一布局和地表快照，区分可用、被阻挡和无法判定。小游戏规则消费 `zone.entered` 等事件，场地适配器根据实际移动产生这些事件。

Creator 场景可显式声明静态盒体碰撞代理，SDK 单个草稿最多 256 个，发布 release 最多 64 个；视觉模型不会自动变成障碍。City 运行时只把当前 Creator release 的盒体附加到这次驾驶会话冻结的碰撞快照，碰撞 revision 同时绑定 City 世界 revision 与 release ID。换模型或皮肤时，碰撞和触发区域保持原配置。碰撞体由 SDK 与 Rust 项目服务分别校验，尺寸限制为每轴 0.1–100 米，运行前由 City 可信适配器编译进现有碰撞索引。动态刚体、网格碰撞、约束、堆叠或大范围破坏仍未支持；只有玩法确实需要时再评估通用物理引擎。

Studio 发起可视试玩时，City 可把同一份已编译盒体几何显示为线框调试层；线框绑定场景租约并在试玩退出、失败或 City 场景失效时清理。该层用于核对模型与碰撞代理，不会进入普通玩家模式。Studio 当前仍通过场景 JSON 编辑碰撞代理，暂未提供图形化碰撞编辑器；实际桌面端视觉验收仍需单独完成。

## 4. 玩法 API

规则图由有类型的事件、守卫与动作组成。竞速至少需要开始、进入检查点区域、计时结束三个事件。寻宝增加拾取事件。引擎提供有限整数计数、布尔值、状态比较、计时、HUD 提示和胜负结算。动作只修改本次活动状态或提交受校验的表现效果。

SDK 规则 schema 可以表达 `walk` 与 `item.collected`，但当前官方 City runtime 适配器只产生 `run.started`、`zone.entered` 和 `timer.expired`，并只挂载 drive 能力的 zone 槽位。因此 Creator Studio 当前提供的是驾驶检查点与驾驶区域收集模板；步行与拾取事件暂时不能在 City 实际运行，不能仅凭 schema 可校验就视为运行时已支持。

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

首轮 HUD 支持目标、进度、倒计时及胜负，复用 City 的呈现组件。校验和试玩分别定位问题。挂载校验返回布局与对象 ID、受影响的槽位、失败位置，以及 `anchor_unreachable`、`anchor_blocked` 或 `geometry_unresolved` 等原因。规则试玩通过 `PlaytestEvidenceV1` 产出本地无头断言；跨 WebView 可视试玩以 `VisualPlaytestEvidenceV1` 持久化绑定 runId 的 release/project revision、snapshot digest、world revision、game ref、seed、tick、最终计数器与终态。Rust 限定字段、长度和数值预算，并校验 release 内容引用；MCP `creator_playtest_history` 返回有界项目历史。此证据由 City 客户端报告，不是防作弊或排行证明；完整事件轨迹和失败节点断言仍未持久化。

## 5. CLI、Studio 和 MCP

| CLI 命令 | 输入与输出 |
|---|---|
| `oh-agent-sdk init city-minigame ./race` | **已实现**：生成 layout/game/mount/scene/trace JSON 样例目录；不覆盖已有文件 |
| `oh-agent-sdk init city-world ./world --generator arid-dunes` | **已实现**：生成公开 `CityWorldProfileV1` 配置样例；不执行世界生成，也不打包 |
| `oh-agent-sdk validate-world ./world` | **已实现**：校验 generator、biome、theme、参数范围并返回结构化诊断 |
| `oh-agent-sdk validate ./race` | **已实现**：校验 layout、声明式规则、挂载内容摘要与锚点绑定；若有 scene，则校验模型引用能否解析到本地项目资产目录 |
| `oh-agent-sdk sync-refs ./race` | **已实现**：更新 mount 摘要和场景模型引用绑定的当前游戏摘要 |
| `oh-agent-sdk playtest ./race --seed 42` | **已实现**：读取 trace 并执行确定性无头试玩，输出终态和证据；失败时返回非零退出码 |
| `oh-agent-sdk pack ./race --out ./race.ohcity.json` | **已实现**：生成 unsigned development artifact；含 layout/game/mount、可选 scene 和已导入资产 catalog/GLB，自动写入 mount 内容摘要 |
| `oh-agent-sdk verify ./race.ohcity.json` | **已实现**：检查 manifest/file set、布局/玩法/挂载、场景资产引用、JSON/GLB SHA-256 内容与包摘要；不验证签名 |
| `oh-agent-sdk preview ...` | **未实现**：需要本地/桌面场景预览器与 City 运行时连接 |

CLI 文件模式面向开发目录。`pack` 输出仅供 City mini-game 开发和内容完整性检查，包含可选场景草稿及已导入 GLB；City 当前不会从该 CLI artifact 安装或加载模型。city-world 当前只生成/校验 profile JSON，未纳入该包格式。桌面作品的读取与写入经过本机 Creator 服务。Studio 与 `data-mcp` 已共用项目事务；MCP 提供项目列表/分块读取、操作状态、创建、规则和场景预览/提交，并可用 `creator_project_publish` 显式发布指定 revision。创建、提交、发布均受 `--allow-local-writes` 控制，且要求 Creator Studio 前台活动。Studio UI 另外提供同一发布操作。Rust 将有效项目 revision 冻结为不可变本地 release。City 专用 `city.creator.experiences.list/read` 只对活动、就绪的官方 City WebView 开放，按当前 layout ID 与 worldRevision 筛选发布内容；不会读取 Creator 草稿，也不经 MCP 暴露。`city_world_profile_preview/apply` 通过 City 插件自己的 `localCalls` 队列工作；写入要求 City 前台、该 City 实例已完成渲染且没有正在运行的活动。预览令牌绑定当前 WebView 实例、当前世界配置和五分钟有效期；应用要求 `--allow-local-writes`，不接受可执行代码或未注册生成器。

当前宿主场景事务为 `creator.scene.preview({ projectId, baseRevision, operations })` 与 `creator.scene.commit({ projectId, previewId, expectedRevision, operationId })`。单次预览最多 128 项，项目场景最多 10,000 个对象，文档最多 2 MiB。`scene.object.upsert`、`scene.object.remove`、`anchor.upsert`、`anchor.remove` 通过 stable ID 编辑模型实例和锚点；模型需带包引用、资源 ID 和 SHA-256 字符串，锚点及变换由 Rust 再做结构和数值范围校验。挂载/皮肤已可经 Creator scene preview/commit 事务编辑；仍不执行真实 City 道路连通、障碍净空或资源签名验证。预览凭据仍为短期、实例绑定，提交沿用 SQLite revision CAS 与 operationId 幂等记录。

桌面 Studio 另提供 `creator.asset.import({ projectId, expectedRevision, operationId })`。调用只会打开桌面原生 GLB 文件选择器；Rust 检查并复制资源到本地项目的 SHA-256 内容寻址目录，写入资源目录与精确 `assetRefs`，并推进 revision。项目分块读取会包含这些引用，因此 Agent 可将本机已导入资源用于普通场景事务。资产字节、源路径不进入 WebView/MCP 消息，MCP 不能触发文件选择器或提交任意路径。桌面导入只接受有界 GLB v2、内嵌资源和基础 POSITION 包围盒；创建模型实例后，scene preview、发布和运行时读取会检查资源引用与磁盘/快照摘要。发布 release 和 City runtime 支持受限静态模型渲染；外部包安装、完整 glTF 解析与模型物理仍不支持。

City 当前只运行带 `drive` 能力的 `zone` 槽位，事件源限于 `run.started`、`zone.entered`、`timer.expired`；入口从 City 实际道路 spawn 锚点解析。运行时通过固定步 SDK runner 处理声明式规则，并复用车辆会话、HUD、相机和活动租约。发布场景可以按 release 加载受限静态 GLB 模型，并可另行声明受限静态盒体碰撞代理；碰撞代理进入该 release 的驾驶碰撞快照，视觉模型不会推断碰撞。动态刚体、网格碰撞、游戏脚本执行和模型交互仍未支持。其它尚未进入 City runtime 的能力包括步行玩家与独立插件包。

| 当前 MCP 工具及后续规划 | 主要输入 → 输出 |
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
| `city_world_profile_preview` | CityWorldProfileV1 → 当前世界摘要、拟应用世界摘要、短期 previewId |
| `city_world_profile_apply` | previewId、operationId → 已应用世界与主题；需 `--allow-local-writes`、同一 City WebView 实例和空闲场景 |

后续完整编辑操作还需覆盖 `rule.upsert`、`rule.remove`、`mount.bind`、`mount.remove` 和 `skin.select`。预览绑定调用者、项目和基线。宿主事务持久化成功的幂等结果，原请求在超时后用相同 operationId 重试或重新授权查询。冲突返回当前 revision。`operation_status` 的未找到只表示没有可见的已提交记录。可视试玩由玩家在 Studio 发起，切换到 City 时锁定版本并交给玩家控制。

诊断码应稳定，首轮至少覆盖 `schema_unsupported`、`missing_dependency`、`anchor_not_found`、`anchor_capability_missing`、`anchor_unreachable`、`revision_conflict`、`preview_expired`、`permission_denied` 和 `rule_budget_exceeded`。错误文本面向玩家，Agent 用 code、path 和对象 ID 决定下一步。

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
