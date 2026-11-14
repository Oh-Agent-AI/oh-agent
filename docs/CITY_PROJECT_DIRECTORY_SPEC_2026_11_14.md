# City 项目目录与内容交付规范（v1）

状态：项目目录约定，2026-11-14。适用于数据型 City 创作；不扩展宿主权限、不引入可执行城市代码。本规范区分**现有 SDK 已支持**与**目标能力**，不得把目标目录解释成已经存在的 API、包格式或安装能力。格式合同以 [内容包 MVP 规格](AGENT_CITY_SDK_CONTENT_MVP_SPEC_2026_11_11.md) 和 SDK 校验器为准；本规范中的项目目录是创作组织约定，不是新增 v2 manifest 字段。

## 1. 身份与权威

| 对象 | 身份 | 权威及用途 |
|---|---|---|
| City 源项目 | 创作者持有的目录及版本控制记录 | 编辑配方、场景、资产、小游戏及说明；不是用户存档 |
| world 内容包 | `kind + packageId + version + contentDigest` | 不可变、可校验的世界内容；digest 不等于发布者身份 |
| game 内容包 | `kind + packageId + version + contentDigest` | 目标能力；规则和资产与具体城市锚点绑定分离 |
| CityInstance | `cityId + revision` | 用户的本机城市、活动偏好和修改；不得写入源码或分享包 |
| 布局与挂载 | `cityId + cityRevision + layoutId + worldRevision`，以及 `mountId` | 布局派生于固定生成输入；挂载须重新校验锚点、能力和可达性 |
| 试玩 | `runId + releaseId + snapshotDigest` | 本机执行及有界结果；不与可分享内容混存 |

一个世界包可服务多个实例；实例名字、用户修改、会话建筑和小游戏成绩不属于包身份。`cityId` 不是包 ID、项目 ID、WebView 实例或 seed。项目版本应通过版本控制记录；不要将“实例 revision”写成源码包版本。

## 2. 创作源码目录

以下为**推荐项目根目录**。`world/` 是当前 `oh-agent-sdk pack-world` 的输入目录；其内部文件名是现有 CLI 的实际输入约定。`games/`、`design/`、`tests/`、`dist/` 是组织约定，当前不会自动被 `pack-world` 扫描或导出。

```text
arid-dunes/                         # 创作项目根目录
├── README.md                       # 目标、来源、构建及已知限制；必需
├── world/                          # 现有 SDK world 输入根
│   ├── world.json                  # 必需：CityWorldProfileV1
│   ├── scene.json                  # 可选：SceneDraftV1；缺省为空场景
│   ├── plan-patch.json             # 可选：可移植的道路/设施/地形补丁
│   └── assets/                     # 可选，按资产导入生成
│       ├── catalog.json            # CityProjectAssetCatalogV1
│       └── <sha256>.glb            # 内容寻址、受限的静态 GLB
├── games/                          # 可选：每个游戏独立项目，非 world 包内容
│   └── <game-id>/                  # 现有 CLI 示例含 game.json、layout.json、
│                                   # mount.json、scene.json、trace.json、assets/
├── design/                         # 可选：SPEC、原创概念、资产版权和验收说明
├── tests/                          # 可选：项目级样例/预期；不包含真实用户数据
└── dist/                           # 本地生成物；不作为源码权威，不默认提交
```

- `world/world.json` 的 `id` 和整数 `version` 当前分别决定 `pack-world` 生成的 `packageId` 和字符串 `version`。更改身份是显式版本决策；不能让目录名、实例 `cityId` 或显示名称隐式决定包身份。
- `world/scene.json` 使用 SDK 的受限场景 schema；模型通过资产 ID 和 digest 引用 catalog，不在场景内放本机路径、网络 URL 或任意脚本。只有已有渲染及碰撞协议明确支持的对象可宣称运行可用；模型视觉不自动等于碰撞体。
- 模型通过 `oh-agent-sdk asset import <world目录> <模型.glb> --asset-id <id>` 导入。当前受支持的是经过有界检查的静态 GLB 子集；不得声称支持所有 glTF、扩展、动画、蒙皮或外部 URI。记录资产作者、授权与来源于 `design/`；版权说明不会自动进入当前 world 包。
- `plan-patch.json` 使用 `validateWorldPlanPatch` 支持的结构，并绑定 seed 和生成器版本。它不得携带会话建筑 ID、建筑移动、原始会话/日志或本机路径。结构验证不等于道路、地形、净空或可达性验证。
- `games/<game-id>/layout.json` 和 `mount.json` 是当前 CLI 所需的**特定布局绑定**，不能当作通用 game 包。布局重建后必须重新生成/校验绑定；v2 game 导出及跨城市可移植绑定仍是目标能力。
- `dist/` 可由 `.gitignore` 排除；是否提交成品由项目决定，但其内容应可由固定输入复现。不得为让命令通过而更新金样或覆盖已存在产物。

## 3. 可交换 world 包：当前格式

现有命令生成单个 JSON artifact（不是解压后的文件夹）：

```text
arid-dunes-world.ohcity.json
├── format = "oh-agent-city-content-v2"
├── manifest                      # formatVersion、kind、packageId、version、
│                                 # sdkContractVersion、minCityRuntimeVersion、
│                                 # entry、files[]、contentDigest
└── files                         # 以下为逻辑路径 → 原始字节的 base64
    ├── world/profile.json
    ├── scene/objects.json
    ├── assets/catalog.json
    ├── world/plan-patch.json     # 仅当有补丁
    └── assets/<sha256>.glb       # 仅当 catalog 引用
```

`files[]` 以逻辑路径排序，记录媒体类型、原始字节长度和 SHA-256；`contentDigest` 按现行 SDK 对去掉自身摘要的 manifest 做 canonical JSON 后计算。必须拒绝重复路径、大小写冲突、绝对路径、`..`、反斜杠、未声明内容和内容与摘要不一致。具体限额和精确校验以 SDK 常量为准，不能在目录层复制出一套互相矛盾的限额。图片虽可出现在 v2 清单允许的媒体类型中，**当前 `pack-world` 不导出图片**。

包中不包含用户 City 实例、已安装记录、layout 私有缓存、真实会话数据或试玩结果。当前 world 打包不会扫描 `games/`，也不会输出一个包含 world+game+mount 的复合包；不要给单个 world 包标记为完整可玩城市。游戏包、跨包依赖、绑定/场景资产闭包的最终格式需在实现前另行冻结，不在本规范中伪造已支持字段。

## 4. 本机内容库与实例：当前与目标

| 存储 | 当前实现 | 目标要求 |
|---|---|---|
| 安装内容 | `<data_home>/state/creator/content/world/<packageId>/<version>/package.json` 与 SQLite 安装记录 | 不可变包和记录按摘要一致；重复安装幂等；版本冲突不覆盖；异常恢复 |
| City 草稿 | Creator SQLite 中的 `cityId + revision`、profile、seed 和可选补丁 | 实例固定世界包 digest、独立皮肤/偏好、用户修改和恢复状态；现阶段不可假设包 digest 已接入 |
| 项目与游戏 | Creator SQLite 项目及项目级资产；发布冻结 release | 与城市、世界版本和挂载显式关联，完整导出和安装后可重建 |
| 运行结果 | Creator SQLite 试玩记录及证据 | 保持本机且按 run/实例隔离；不自动进入内容包 |

桌面预检及显式本机安装是**有限存储能力**：当前不证明发布者身份、运行时兼容或安装包可被运行时加载。目标实例库、活动城市切换、卸载引用保护、实例级偏好与旧城迁移尚需实现并验收；本规范不授权直接编辑应用 SQLite 或覆盖用户存档。

## 5. `arid-dunes` 首个项目约定

- 项目目录名：`arid-dunes/`；world profile 和生成的 world package 暂定 `id=arid-dunes`、`version=1`，与现有本机开发包保持区分和一致性检查。若同 ID/version 的既有包摘要不同，应递增版本或使用新 ID，**禁止覆盖**。
- `world/world.json` 使用 `arid-dunes-v1`、`biome=arid`、`themeId=desert`；初始参数 `duneScale=190`、`duneAmplitude=11`、`orientationDeg=18`。
- 试验 seed 为 `42`，当前 `CITY_GENERATOR_VERSION=6`。两者是生成和打包的显式输入，不新增未被 SDK 接受的 `world.json` 字段。seed 42 曾报告 `degraded`，道路和规划质量仍待验收。
- 视觉方向与小游戏目标以 [沙海之门 SPEC](EGYPT_DESERT_CITY_SPEC_2026_11_14.md) 为准：原创砂岩巨门、地标及沙漠氛围为待制作资产，不能用空 catalog 或配置通过冒充视觉完成。首个小游戏按 SPEC 采用驾驶区域收集；实际布局绑定需针对生成结果验证。
- 用户的迈阿密 City 是独立实例和数据域；不得通过覆盖其 profile、seed、建筑、项目、存档或发布来实现沙漠 City。分享产物不携带会话建筑或用户分析数据。

## 6. 检查与验收

1. **源码**：目录与所声明文件一致；`validate-world` 通过；如有 GLB，`asset verify` 通过；素材来源与授权可核对。
2. **打包与完整性**：显式 seed/生成器版本，执行 `pack-world` 与 `verify-world`；在干净目录重复构建比较 digest，并测试缺文件、篡改、重复键/路径及不兼容版本拒绝。保留输出中的 `unchecked`，不以 `ok` 宣称运行兼容。
3. **世界几何**：用真实 City 生成指定版本；检查 `degraded` 项、补丁回放、道路连接、入口净空与小游戏锚点可达性；保留布局/worldRevision 和验证证据。
4. **未来完整闭环**：独立干净环境导入世界及游戏内容 → 显式安装 → 按固定 digest 创建实例和绑定 → 试玩至成功/失败/取消 → 退出、重启并重载；核对实例、版本和资产。该步骤要求尚未完成的运行时安装接入与 game 包能力。
5. **隔离与恢复**：记录迈阿密配置、布局、建筑修改、项目/发布及存档；创建、编辑、试玩沙漠后切回并重启逐项比对；测试并发、强杀恢复、旧版本和被引用包卸载拒绝。
6. **视觉**：按 SPEC 对原创沙漠资产、光照和可读性提供桌面截图及审查记录；不将测试 fixture 或空城截图记为完成。

当前可执行的开发命令（在仓库根，输出目标须不存在）：

```sh
node packages/agent-vitals-city-sdk/bin/oh-agent-sdk.mjs init city-project <项目> --generator arid-dunes
node packages/agent-vitals-city-sdk/bin/oh-agent-sdk.mjs init city-minigame <项目>/games/<游戏名>
node packages/agent-vitals-city-sdk/bin/oh-agent-sdk.mjs validate-world <项目>/world
node packages/agent-vitals-city-sdk/bin/oh-agent-sdk.mjs asset verify <项目>/world
node packages/agent-vitals-city-sdk/bin/oh-agent-sdk.mjs pack-world <项目>/world --out <输出文件> --seed 42 --generator-version 6
node packages/agent-vitals-city-sdk/bin/oh-agent-sdk.mjs verify-world <输出文件>
```

以上命令验证当前开发格式和支持的内容，不代替发布者验证、正式安装、运行时兼容或真机试玩验收。
`init city-project` 创建新源码目录，不会读取或导出 Studio 中已有的 City/游戏；小游戏示例使用合成布局，必须针对实际 City 重新绑定。

Studio 项目面板提供“导出源码目录…”：当前仅接受已保存、绑定独立 City 与一个游戏挂载的项目；导出前校验城市 revision、布局、挂载和可移植补丁，带未区分来源的 suppressed context 时拒绝。桌面宿主通过原生目录选择器在用户选定位置新建目录，并验证项目 revision 和资产摘要；不会覆盖已有目录。游戏的场景与模型资产放入 `games/game/`，布局绑定是开发快照，生成新世界后需重新绑定。导出 README 记录 seed 与生成器版本；不凭空生成试玩 trace。该源码目录不是可安装的 world+game 复合包，不改变 SQLite 草稿权威，也不承诺导入后运行。

## 7. 官方 Agent City 采用同一内容规范

**决议**：官方 Miami 和 `arid-dunes` 等自定义世界使用相同的世界配方、场景、资产目录和内容包契约，并运行相同版本化校验与兼容性测试。官方 Agent City 同时是承载这些内容的可信应用：应用代码、生成器、渲染器、数据适配和玩法运行时继续按应用边界构建和授权。官方身份不改变内容字段含义或跳过摘要、兼容与隔离验证。

下图为**目标源码组织示意**，不是当前仓库已有目录，也不是本次文件迁移：

```text
agent-city/
├── runtime/                       # 官方应用代码：UI、生成器、玩法、数据适配
├── worlds/
│   ├── miami/                     # 官方世界内容项目
│   │   ├── README.md
│   │   └── world/                 # world.json、scene.json、assets/ 等同 §2
│   └── arid-dunes/                # 如将沙漠作为官方内容，使用同一布局
│       ├── README.md
│       └── world/
├── games/                         # 官方玩法的独立内容项目及资产
├── tests/                         # 内容契约、运行时与迁移回归
└── dist/                          # 构建生成，不是用户数据
```

物理仓库路径、是否采用 `worlds/` 和 `runtime/`、发布物清单与版本锁需在迁移实施时确定；不要通过移动现有 `apps/agent-city` 来声称已完成迁移。当前官方应用仍位于 `apps/agent-city/ui`，还有 `mcp/`、`relay/`、桌面插件注册、主仓相对依赖及用户数据接入。迁移盘点、固定版本构建和回滚以 [独立仓库与发行规格](AGENT_CITY_GITHUB_DISTRIBUTION_SPEC_2026_11_11.md) 为准。

### 7.1 内容、应用和用户数据的边界

| 层 | 可以包含 | 不能混入或误称 |
|---|---|---|
| 官方世界/游戏内容 | 版本化 profile、声明式场景、受支持资产和规则；适用时使用 §2、§3 的同一合同 | 本机实例、会话楼、会话统计、路径、凭据、存档及运行日志 |
| 官方 City 应用 | 已注册生成器、Three.js 渲染、玩法、输入和可信 TS 数据投影；受宿主控制构建与注册 | 不把应用代码打进数据型 world 包，也不把 world 包验证等同于代码运行授权 |
| 宿主与用户实例 | 已审核的插件描述符、逐请求 typed-data 授权、本机 City 状态、分析数据和旧数据迁移 | 不把官方内置权限继承给外部世界包、浏览器预览或独立安装的应用 |

官方 City 的会话楼、动态高度、建筑映射与统计由 descriptor 授权的本机 typed DTO 和可信 City TS 适配器生成；world 包提供**静态世界配方**，不能包含用户会话或依靠其快照才能让其他用户重建。离线内容校验使用合成数据；真实用户数据只在本机、经已授权的官方插件使用。现有远程例外的范围不因目录统一扩大。现行静态 GLB 包限制也不自动覆盖官方应用中由代码生成或具有动画/蒙皮的资源；须先明确资源归属与运行支持，再决定是否转换或保留为应用资源。

### 7.2 官方 Miami 迁移的实施顺序与门槛

1. **盘点基线**：固定当前应用构建、默认世界 profile/seed、生成器版本、官方资源和游戏目录；记录代码生成资源、静态资源、授权和依赖。避免把用户当前 Miami 的 seed 或分析数据误当官方发行默认值。
2. **并行建立内容源码**：在不替换现有权威的前提下，创建官方 Miami 内容项目和适配映射；先用固定合成输入对比旧、新 profile、生成布局、资源引用和游戏绑定。尚不能用 v2 表达或当前 CLI 不支持的内容列为缺口，不能悄然丢弃。
3. **运行接入和隔离**：实现宿主对内置/已安装内容的统一身份、版本和 digest 解析；同一套内容解析必须保留官方内置插件的数据授权边界。用户 Miami 的本地修改、旧补丁、书签及玩法存档以明确版本的迁移或兼容适配保留，失败时继续使用旧数据并可回滚。
4. **真实用户升级验证**：在备份和隔离测试数据上验证升级、重启、异常中断、重复迁移、切换和回退；核对 Miami 原有世界、建筑、会话映射、项目、游戏与存档，且不受沙漠实例修改影响。合成数据与真实数据的结果分别记录。
5. **切换构建权威**：只有固定版本构建、资源完整性、官方数据授权、双城隔离和兼容验收均通过后，才让官方 bundle 消费新内容来源；保留可回滚的原版本并消除双写。仓库独立、官方内置内容和第三方 App Plugin 动态安装分别验收。

完成标准：同一 SDK 验证与包合同能处理官方和自定义世界；官方 Miami 的现有用户行为与数据经对照验收无非预期变化；`arid-dunes` 可以作为独立实例创建、保存、重载和试玩。当前这些是**目标**，不是已经实现或已经通过验收的结论。
