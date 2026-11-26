# City Code Game Preview Isolation Spec

> 日期：2026-11-19
> 状态：Proposed，等待评审后实施
> 适用范围：Creator Studio、Code Game Runtime、City Runtime、Desktop Host、Creator MCP
> 关联：`OH_AGENT_CITY_SHARED_CONTRACTS_RFC_V1_2026-11-18.md`
> 原型：`prototypes/creator-studio-city-game-libraries-2026-11-19.png`（可编辑 SVG 同名）

## 1. 背景与问题

当前 Studio 的“代码预览”会打开并复用正在运行的 City WebView，以验证不可变构建能在真实 City 中运行。这条技术链路已经通过验收，但它存在三个产品问题：

1. 预览会切换并占用玩家当前 City 的页面和场景租约。
2. 当前 Run 使用正式本地 PlayerScope，Story/Scheduler 尚无完整 Preview Fork，不能默认视为无副作用。
3. Studio 的控制面与 City 的展示面混在一起，停止、失败和历史状态缺少独立的 Preview 身份。
4. City、City AVG Story 与 Game 是不同资源，不能使用同一注册表或把“是否安装”当成任一资源自身的固有属性。

因此，现有行为必须迁移为“用户选择 City 项目并确认安装”的流程，不能继续作为 Studio 默认代码预览。

## 2. 核心决策

1. **City Project、City AVG Story Project 与 Game Project/Build 是三种独立的一等资源**。City 管理世界，Story 管理该 City 的角色、对白、分支、条件与剧情状态，Game 管理通用玩法与不可变 Build；安装关系另由 Installation Registry 持久化。Story Project Registry 尚未接入，当前 UI 必须显式显示不可用，不得从 Game Build 或玩家运行时 Story 状态推导创作项目。
2. Studio 和 MCP 的默认 Preview 均运行在**独立 Preview 窗口**，不打开、不替换、不聚焦现有 City。
3. Preview 窗口拥有独立 CityEngine、Scene、Game Run、Input、Dialogue、PlayerScope、Clock Fork 与 Story Fork。
4. “安装到 City”是与 Preview 完全分离的用户操作：Host 提供可用 City 项目列表，用户选择目标并确认安装；不得用 MCP 写权限代替安装授权。
5. 默认 Preview 不得打开、切换或聚焦现有 City WebView。只有用户在安装确认中明确选择“安装并替换当前 City 视图”，才允许导航到目标 City；安装游戏本身不等于替换 City 世界内容。
6. Preview 的权威运行身份是 `previewId + runId`；`buildId` 只标识不可变内容，不再承担窗口或运行身份。
7. 所有 Preview 都使用同一份冻结世界来源和不可变 Build，但隔离模式不得修改正式 City、玩家剧情或项目草稿。

## 3. 目标与非目标

### 3.1 目标

- 在独立窗口中运行真实 City 世界规则、渲染、输入、碰撞、Dialogue 和固定步游戏逻辑。
- Studio 提供平级的 City 项目库与游戏库；City 管理世界，Game 管理规则、构建和权限。
- Studio 始终保留构建选择、状态、停止和诊断能力。
- 关闭或崩溃时释放全部 Run 资源，正式 City 不发生状态变化。
- 支持安装到用户选择的 City 项目；安装、运行、替换当前视图和正式剧情写入是不同授权。
- 打包 App、无全局 Node、无源码目录和独立 MCP 行为保持一致。

### 3.2 非目标

- 不在本阶段实现社区不可信代码 Sandbox、远程 Actor 或多人同步。
- 不允许预览上传本地日志、玩家输入、私密剧情或其他用户数据。
- 不要求在 Studio 的小面板内同时承载完整 WebGL 游戏；内嵌预览可作为后续兼容形态。
- 不把 Preview 结果自动发布、安装或写入正式存档。

## 4. 用户体验

### 4.1 Studio 资源库与默认预览流程

1. Studio 首屏是资源库，提供平级的 **City 项目库**、**AVG Story** 与**游戏库**入口；可记住上次选择，但不得把 Story 或 Game 当作 City 的附属文件，也不得把 Story 当作 Game Build。
2. City 卡片展示世界版本、能力与已安装游戏数量；Game 卡片展示游戏版本、Build、权限与验证状态。安装状态属于二者的关系，不写在资源自身。
3. 用户进入游戏库，选择 Game 与不可变 Build，再选择源 City 版本；默认源为项目绑定的 City 快照，未绑定时必须显式选择，不得猜测最新 City。
4. 点击“打开独立预览”后，Desktop 创建或聚焦对应 Preview 窗口；当前 City 页面保持不变。
5. Studio 显示 `previewId`、构建、源世界版本、运行状态、tick、实体数、outcome 和诊断。
6. 用户可点击“聚焦预览”或“停止预览”；关闭窗口与停止按钮具有相同清理语义。
7. City 项目库与游戏库之外可提供“安装记录”视图，统一查看、更新、停用和卸载 City ↔ Game 关系。

### 4.2 安装到 City 项目

“安装到 City…”是独立按钮，不是 Preview 的隐式后续动作。

1. 用户点击后，Studio 从 Host 读取**可用 City 项目列表**，而不是直接进入主 City。
2. 每项显示名称、`cityId` 的短别名、版本、世界能力摘要、当前是否打开以及兼容状态；不暴露物理路径或原生标识。
3. 用户选择目标 City，先获得安装预检：Build 完整性、世界能力、权限、版本和现有玩法冲突。
4. 确认页分别说明：
   - 安装游戏到哪个 City 项目。
   - 是否立即运行。
   - 是否替换当前打开的 City 视图。
   - 是否申请正式剧情写入；默认不写。
5. 默认动作是“仅安装到所选 City”，不改变当前打开的页面。只有勾选“安装并替换当前 City 视图”并完成确认，才可导航到目标 City。
6. 安装在目标 City 项目卡片添加游戏入口，不替换 City 的地形、建筑、世界包或其他游戏。点击入口仍打开独立 Preview，不注入或切换主 City WebView。已有同名同版本游戏需要显式更新确认，不能静默覆盖。

### 4.3 MCP 默认行为

`creator_code_preview` 默认创建 `preview-window`，不触碰现有 City。请求安装只能进入待授权状态，并触发 Studio 的 City 项目选择与安装确认；`--allow-local-writes` 只授权本地构建/请求写入，不代表安装、替换当前视图或正式剧情授权。

## 5. 资源、安装与 Preview 公共契约

### 5.1 两类资源与安装关系

```ts
type CityProjectSummaryV1 = Readonly<{
  cityId: string;
  cityRevision: number;
  name: string;
  worldRevision: string;
  capabilities: readonly string[];
}>;

type StoryProjectSummaryV1 = Readonly<{
  storyId: string;
  cityId: string;
  cityRevision: number;
  title: string;
  revision: number;
  status: "draft" | "published";
}>;

type GameProjectSummaryV1 = Readonly<{
  gameId: string;
  version: string;
  displayName: string;
  latestBuildId?: string;
  validationStatus: "draft" | "built" | "verified" | "published";
}>;

type CityGameInstallationV1 = Readonly<{
  installationId: string;
  cityId: string;
  cityRevision: number;
  gameId: string;
  buildId: string;
  status: "installed" | "disabled" | "update-available";
}>;
```

- City Registry、Story Project Registry 与 Game Project Registry 分别持久化三类资源；Story 通过 `cityId + cityRevision` 绑定世界，Game 不以 City 子文件的形式存在。这里的 Game Project Registry 管理创作项目，不替代运行时的 GameTypeRegistry 或 InstalledGameRegistry。Story Project Registry 接入前，Story Tab 只显示明确的能力不可用说明。
- Installation Registry 以 `cityId + gameId` 为逻辑关系键，安装版本绑定不可变 `buildId`；同一关系可更新，但不得隐式覆盖。
- 一个 City 可安装多个 Game，一个 Game 可安装到多个 City；预览不创建 Installation。
- “未安装/已安装/可更新”描述 Installation，不是 City 或 Game 的固有属性。
- Game 的 `validationStatus` 不表示兼容所有 City；兼容判定必须结合目标 City 的能力与版本。

### 5.2 Preview 身份

```ts
type PreviewTargetV1 = "preview-window";

type PreviewSourceCityV1 = Readonly<{
  cityId: string;
  cityRevision: number;
  worldRevision: string;
  snapshotDigest: string;
}>;

type CodePreviewStartV1 = Readonly<{
  buildId: string;
  target: PreviewTargetV1;
  source: PreviewSourceCityV1;
  seed: number;
  operationId: string;
}>;

type CodePreviewIdentityV1 = Readonly<{
  previewId: string;
  runId: string;
  buildId: string;
  target: PreviewTargetV1;
  source: PreviewSourceCityV1;
  status: "queued" | "awaiting-approval" | "starting" | "running" |
    "stopping" | "finished" | "failed" | "cancelled" | "expired";
}>;

type CityProjectInstallRequestV1 = Readonly<{
  buildId: string;
  targetCityId: string;
  expectedCityRevision: number;
  operationId: string;
  runAfterInstall: boolean;
  replaceCurrentView: boolean;
  allowOfficialStoryWrites: boolean;
}>;
```

安装授权必须同时绑定 Build、目标 City、期望版本和上述三个独立选择；缺省值全部为 `false`。

规则：

- `previewId`、`runId` 由 Rust Host 生成，不接受客户端提供的玩家身份或窗口身份。
- 一个 Preview 窗口至多一个活跃 Run；重复 `operationId` 返回原回执。
- 旧 Build 在工作区修改后仍可复现；冻结文件缺失或摘要不符时失败关闭。
- 停止、关闭和状态查询必须携带 `previewId`；仅用 `buildId/runId` 会误停其他预览，不允许继续作为完整身份。
- 现有无 `previewId` 的状态接口可暂时返回最近一个 Preview，但必须标记 `legacyScope=true`，迁移完成后移除。
- City 项目列表必须来自 Host 的持久注册表；空列表时提供“创建/保存 City 项目”入口，不得把当前内存 City 冒充为已保存项目。
- 安装提交使用 `expectedCityRevision + operationId` CAS；安装预检不等于安装成功。

## 6. 窗口与引擎边界

```text
Creator Studio WebView                 Existing City WebView
  City 项目库 / 游戏库 / 安装记录         当前玩家场景与活动
             │                                   │ 仅安装确认后
             ▼                                   │ 选择替换视图
      Desktop Preview Host ── create/stop/status │
             │                                   │
             │             City Game Installer  ─┘
             │              list/preview/commit
             ▼
  Independent Preview Window + WebView
    CityEngine / SceneLease / Input
    GameRun / Dialogue / FixedStepClock
    PlayerScope / ClockFork / StoryFork
```

City Registry、Game Project Registry 与 Installation Registry 均位于 Host；Studio 只读取有界 DTO，不复制权威列表。

- Preview 窗口和 WebView 使用 Host 生成的不透明标签，与 `plugin-city-*` 正式实例区分。
- Host 通过受控 bootstrap DTO 注入 `previewId`；不得通过 URL 传递物理路径、任意 Bundle URL 或用户数据。
- City UI 可复用现有渲染组件，但必须新建 CityEngine，禁止读取正式 City 的单例引擎、活动协调器或内存状态。
- Preview 使用源 City 的冻结 Snapshot/World Package；源 City 后续变化只触发“源已更新”提示，不静默重绑定当前 Run。
- Preview 窗口获得独立输入焦点。只有该窗口聚焦时才接受游戏键鼠输入。
- Studio 的状态轮询、停止和关闭不依赖 City WebView 是否打开。

## 7. 数据与状态隔离

### 7.1 世界与项目

- Preview 读取冻结世界内容，不写正式 City Patch、项目草稿、发布记录或安装注册表。
- 游戏创建的实体、粒子和临时对象只属于当前 Preview Scene。
- 正式 City 的全局外观偏好、回放游标和标签设置不因 Preview 改变。

### 7.2 PlayerScope

- 每次 Preview 由 Host 签发新的 `remote-guest` 风格本地预览身份，或等价的不透明 `preview` 身份；不得复用正式玩家 ID。
- 若公共 `PlayerScopeV1.kind` 尚无预览类型，应在 Shared Contracts 兼容评审中新增 `preview`，不得把 `remote-guest` 误作远程身份。
- Preview 身份不表示网络用户，也不得进入远程遥测或远程 Actor 数据面。

### 7.3 Clock 与 Story

每个隔离 Preview 创建：

```ts
type PreviewForkV1 = Readonly<{
  forkId: string;
  previewId: string;
  baseClockRevision: string;
  baseStoryRevision: string;
  parentCityId: string;
}>;
```

- Clock 从源快照时间开始，可独立暂停、快进和恢复；不改变正式 Clock Revision。
- Story 使用 copy-on-read 基线 + Preview 私有写入覆盖；正式 Story 不可见这些写入。
- Preview Scheduler、Event、Outbox、奖励和对白证据写入 Preview 私有命名空间。
- 退出窗口时默认丢弃 Fork。保留调试证据必须是显式、可删除的本地操作。
- 安装到 City 默认使用只读 Story；写正式剧情需要在安装确认中单独授权，并同时满足 Manifest 权限和 Host Grant。仅安装或替换视图不授予剧情写权限。

## 8. 生命周期与取消

状态机：

```text
queued → starting → running → stopping → finished
   │          │         │        ├──────→ cancelled
   │          │         │        └──────→ failed
   │          └─────────┴───────────────→ failed
   └→ awaiting-approval → expired/cancelled
```

- 停止顺序固定为：拒绝新输入 → abort Run → 拒绝挂起 Dialogue/Agent/Storage 写入 → 停止 Scheduler → 释放 Scene/Activity Lease → 关闭 Host Run → 标记终态。
- 终态写入必须幂等；重复停止返回同一状态。
- 窗口关闭、宿主退出、WebView 崩溃都触发相同清理路径。
- 旧 Run 的异步回调必须同时验证 `previewId + runId + revision`，不得写入新 Run。
- Preview 结束后，Studio 可读取有界终态与证据，但不得重新启动已终止 Run；重新运行必须新建 Run。

## 9. Studio 与 Host API

建议新增/调整以下受控方法：

```text
creator.city.projects.list       limit + optional cursor + compatibility Game
creator.game.projects.list       limit + optional cursor
creator.game.builds.list         gameId + limit + optional cursor
creator.code.preview.start       buildId + target + source + seed + operationId
creator.code.preview.stop        previewId + operationId
creator.code.preview.focus       previewId
creator.code.preview.status      previewId
creator.code.preview.list        limit + optional cursor
creator.code.story.read          previewId + bounded evidence selector
creator.code.install.preview     buildId + targetCityId + expectedCityRevision
creator.code.install.commit      完整安装确认 + operationId
creator.code.install.list        cityId/gameId 二选一 + limit + optional cursor
creator.code.install.disable     installationId + expectedCityRevision + operationId
creator.code.install.uninstall   installationId + expectedCityRevision + operationId
```

City 项目列表复用现有受控 City 目录接口，但 Studio 必须增加面向安装的兼容性与能力投影，不新增另一套 City 注册表。

要求：

- Rust 校验目标、来源、身份、状态、权限、分页和响应大小。
- TS Studio 只消费白名单 DTO；不读取任意文件、数据库或宿主 IPC。
- Preview 字节继续采用实例隔离的分块读取；句柄绑定 `previewId` 和 WebView 实例。
- `creator_code_preview_status` 可保留为 MCP 最近状态兼容入口，新增按 `previewId` 查询。
- 现有 `creator.code.preview` 可迁移为 `preview.start` 的默认隔离别名，并记录弃用周期。
- 停用/卸载只修改 Installation，不删除 Game Project、历史 Build 或 City 世界；再次安装可复用已验证 Build。

## 10. 错误与降级

必须显式区分：

- `preview_source_unavailable`：源 City 快照不存在或版本不符。
- `preview_window_unavailable`：窗口/WebView 创建失败，Run 不得继续。
- `preview_run_cancelled`：停止、关闭或宿主退出。
- `preview_approval_required`：真实 City 安装、替换视图或正式剧情写入尚未授权。
- `city_project_list_unavailable`：无法取得可信 City 项目列表，不得回退到当前 City。
- `city_install_revision_conflict`：目标 City 在预检后发生变化，需要重新确认。
- `city_install_existing_game`：目标已存在同身份游戏，需要显式更新确认。
- `game_project_not_found`：Game 或请求 Build 不在可信项目库中。
- `city_game_installation_not_found`：安装关系不存在或已被移除。
- `city_game_incompatible`：目标 City 缺少 Game 声明的必需能力或版本不兼容。
- `preview_fork_unavailable`：Clock/Story 隔离未建立，隔离 Preview 不得回退到正式玩家状态。
- `game_package_integrity_failed`：冻结内容缺失或篡改。
- `game_activity_busy`：安装后立即运行与目标 City 的现有活动冲突。

隔离能力未实现时，可以拒绝启动；不得为通过测试而复用正式 City。

## 11. 验收标准

| ID | 场景 | 必须证据 |
|---|---|---|
| PV-AC01 | Studio 启动默认 Preview | 新 Preview 窗口运行；原 City 页面、焦点目标和活动未被替换 |
| PV-AC02 | 相同源 City/Build 启动 | Run 使用相同 Snapshot/Build Digest，但引擎、PlayerScope、Clock/Story Fork 独立 |
| PV-AC03 | Preview 修改实体、剧情和时间 | 正式 City 世界、玩家 Story、Clock 和项目草稿的 Revision 均不变 |
| PV-AC04 | 挂起 Dialogue 时停止/关闭 | Promise 被取消；输入、Scheduler、Scene、资产句柄全部释放 |
| PV-AC05 | 连续启动两个 Build | 不同 previewId/runId；旧停止命令不能停止新 Run |
| PV-AC06 | 源 City 在运行中更新 | 当前 Run 保持冻结版本并提示源更新，不自动重绑定 |
| PV-AC07 | 用户点击“安装到 City…” | 显示可用 City 项目及兼容状态；未选择目标或未确认时，主 City WebView 无任何变化 |
| PV-AC08 | 仅安装到所选 City | 目标 City 项目卡片获得可启动的独立 Preview 游戏入口；当前视图不切换；世界、其他游戏和正式 Story 不被替换或写入 |
| PV-AC09 | 无全局 Node、无源码、独立 MCP | Build/Test/独立 Preview 均通过，不依赖开发仓库 |
| PV-AC10 | WebView 崩溃/宿主重启 | 无活跃残留 Run；正式状态不变；证据可显式读取或过期 |
| PV-AC11 | 用户明确选择“安装并替换当前 City 视图” | 仅所选目标 City 被打开；授权范围可审计；未授权的剧情、外观和时间不变 |
| PV-AC12 | Studio 切换 City/Story/Game 资源库 | 三类资源语义平级且互不混淆；已有列表来自各自权威 Registry，未接入的 Story Registry 显式降级 |
| PV-AC13 | 同一 Game 安装到两个 City | 生成两个独立 Installation；更新/停用其中一个不影响另一个或 Game Build |
| PV-AC14 | 独立 Preview 后从未安装 | 不生成 Installation，不改变 City 的已安装游戏列表 |

## 12. 实施拆分

1. **PR-01 资源与兼容契约**：分离 City/Game 项目 DTO 和 Registry，新增 Installation 关系、previewId、源 City DTO、按 Preview 的状态/停止接口；保留旧状态兼容读。
2. **PR-02 独立窗口闭环**：Host 创建 Preview Window、独立 CityEngine 与 Run；默认 Studio/MCP 切换到隔离窗口。
3. **PR-03 Studio 双资源控制面**：City/Game 资源库、源选择、打开/聚焦/停止、分 Preview 状态、错误与证据；补真实窗口回归。
4. **PR-04 Clock/Story Fork**：预览身份、私有 Scheduler/Story/Outbox、快进和退出丢弃；未建立 Fork 前不得运行剧情写入。
5. **PR-05 City 项目安装流程**：可用项目列表、兼容预检、独立授权、CAS 安装、更新/停用/卸载、可选运行与替换视图；补安装/取消/冲突回归。
6. **PR-06 打包与故障验收**：执行 PV-AC01～14、无 Node/无源码/独立 MCP、WebView 崩溃与宿主重启测试。

## 13. 迁移要求

- 默认行为从“打开现有 City”改为“独立 Preview”，属于有意修复的交互契约变化，应在变更说明中明确。
- 现有“真实 City 验收”能力迁移为“安装到 City 项目”，必须经项目选择、预检与确认；仅替换当前视图也不能绕过安装授权。
- 在 PR-04 之前，隔离 Preview 中的 Story 写入应失败关闭；不得宣称已具备完整剧情隔离。
- 旧 `creator.code.*` 构建列表迁移到 Game Project Registry 的只读投影；不得把 City 的已安装数量写回 Game 资源。
- 已存在的 City/Game 内容通过稳定 ID 迁移；关系记录缺失时显示“未安装”，不得从目录名或当前页面推断安装。
- 本 Spec 不放宽现有 MCP、导出、远程 City 或 Actor 的数据权限。
