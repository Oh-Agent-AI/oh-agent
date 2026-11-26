# Agent City SDK 内容创作与本地安装 MVP 规格

状态：提案，待实施与验收；2026-11-11。适用范围为 `codex/city-sdk-migration-slice` 工作区。本文定义下一阶段目标，不代表列出的接口已经实现。现有实现以 [SDK 迁移盘点](AGENT_CITY_SDK_MIGRATION_2026_11_10.md)、[SDK API](AGENT_CITY_SDK_API_2026_11_10.md) 和 [Creator Studio 架构](AGENT_CITY_CREATOR_STUDIO_ARCH_2026_11_09.md) 为准；发生冲突时，实施前记录决议并同步这些文档。

发行方向补充：官方 City 应可在独立仓库维护，开发者可在 GitHub 托管 City 和小游戏内容。仓库拆分、GitHub 市场索引及发行信任链见 [GitHub 发行与 City 独立维护规格](AGENT_CITY_GITHUB_DISTRIBUTION_SPEC_2026_11_11.md)。本文件第 5 节的本地文件导入仍是首个可验收安装切片；GitHub 在线目录与下载需要另行满足该规格的政策和验收门槛。

## 1. 目标与验收场景

创作者或 Agent 在仓库外使用公开 SDK 创建世界配置和声明式小游戏，打包为完整的本地内容包；用户在 Oh Agent 导入安装，创建独立 City 实例，在地图中挂载并试玩游戏；Agent 根据诊断修改项目、更新包并再次试玩。通过第二个世界和第二个游戏验证同一套接口可以组合内容。

MVP 使用官方 City App Plugin 作为受信任运行时，安装的是数据型内容包。City World 包引用宿主已注册的 `coastal-islands-v1` 或 `arid-dunes-v1` 生成器；小游戏执行已有的有界声明式规则，首轮支持 `drive`、`zone` 及运行时实际支持的事件。模型仅支持现有受限静态 GLB 和显式静态盒体。安装本身不授予本地分析数据访问权，也不启用远程传输。

首版不包含第三方可执行 App Plugin、动态地理生成器代码、任意 JS/WASM、付费、社区发布、多人通用运行时及完整图形编辑器。Shop 日后可复用安装服务，但本规格不要求 Shop。

## 2. 基线与差距

| 能力 | 当前工作区证据 | 本阶段需要 |
|---|---|---|
| 世界 | 已有 Miami/沙丘 profile 和注册生成器；当前偏好主要存在 City localStorage | 世界内容包与多个独立实例的宿主持久化 |
| 游戏 | SDK 声明式规则、无头运行、City 驾驶适配器及地图入口已有代码 | 与布局无关的游戏定义、按实例绑定及真实试玩验收 |
| 包 | 现有 `oh-agent-city-package-v1` 为 unsigned 小游戏开发包，含布局/挂载，校验器严格限定 kind | 新格式支持 world/game，完整资源闭包与安装；不得把旧格式静默当成新格式 |
| 发布 | Rust Creator 服务冻结本机 release，GLB 字节留在项目内容寻址目录 | 可移植包携带完整资产字节；本机 release 与安装包身份分离 |
| Studio | 官方插件、项目事务与交接代码存在 | 排查桌面导航/打包并完成真实试玩；Studio 不是 SDK 交付的前置 UI |
| SDK 分发 | 本地构建和 tarball 消费路径已验证，未发布 registry | 固定可复现的本地 tarball 与仓库外样例 |

2026-11-11 桌面验收：按迁移构建路径确认 Creator Studio 导航存在，此前缺失的观察源于同名应用实例混淆。修正试玩领取时遗漏的场景和资产引用后，已通过 release 预检并进入 City；驾驶场景捕获失败。启动失败不再附带未开始的规则运行证据后，桌面复测已自动返回 Studio 并恢复项目。最新诊断为 `scene-unavailable:unsupported-rendered-solid-deformation:landmark:skinned`。代码显示机场地标包含可异步替换为骨骼 GLB 的停放机甲，且明确属于驾驶障碍；这是需进一步验证的候选来源，不能通过忽略障碍物掩盖错误。相同 seed 和 382 条合成会话的独立场景捕获成功，不代表真实场景已通过。自动化通过不替代桌面交互验收。

补充：合成浏览器验收预加载官方机甲 GLB 后复现同类故障。现在可信的机场停放机甲在驾驶场景租约期间暂停模型异步升级，并将骨骼当前姿态烘焙为实际三角形碰撞几何；租约释放后才应用等待中的升级。浏览器验收覆盖 GLB、实际几何、延迟升级、驾驶入口和释放；骨骼姿态变更有独立回归测试。最新修复仍需生产桌面 bundle 真实试玩复验。

桌面复验：迁移构建中 Studio 发布 revision 2 后，City 进入驾驶试玩准备界面；正常玩家按键使车辆前进，退出后自动返回原项目并显示 `cancelled` 与 tick 1203 的结果。此回归验证了启动、输入和取消返回，尚未完成检查点通关、资产安装或多城市验收；道路体检界面提示当前 City 有 5 处阻断，不代表已验证试玩路径畅通。

## 3. 对象与责任

| 对象 | 身份及用途 | 权威 |
|---|---|---|
| CreatorProject | 可修改的源项目，`projectId + revision` | 项目服务；独立 SDK 目录由创作者持有 |
| ContentPackage | 不可变、完整的 world 或 game 产物，`kind + packageId + version + digest` | 包内容及宿主校验结果 |
| InstallRecord | 已验证的本机包记录，按 digest 指向不可变内容 | Rust 本地安装服务 |
| CityInstance | 用户创建的城市，包含 `cityId`、世界包固定引用、seed、皮肤、revision | Rust City 实例服务 |
| GameMount | 一次城市内游戏配置，绑定 `cityId + mountId`、游戏包 digest、layout/world revision、入口及槽位 | City 实例服务；几何可用性由 City 运行时复核 |
| PlaytestRun / Evidence | 固定运行输入和有界终态结果；每次独立 `runId` | 宿主记录；City 客户端报告结果 |

同一世界包可创建多个实例；同一游戏包可在多个实例分别绑定。更新包不会原地改变已有实例或挂载。实例切换前结束当前活动并释放租约，数据和成绩按 `cityId + mountId` 隔离。

依赖方向：SDK 提供数据契约、规则、纯校验和 CLI；City 提供生成器、布局快照、几何检查、输入、渲染和活动生命周期；Rust 宿主负责安装、实例、事务和授权；Studio 与 MCP 是宿主服务的受限入口。应用不得通过 SDK 绕过既有 typed-data 授权。

## 4. 内容包契约

定义新格式 `oh-agent-city-content-v2`，与现有 v1 开发包并存。新 manifest 最小字段：`formatVersion`、`kind`（`city-world` / `city-minigame`）、`packageId`、`version`、`sdkContractVersion`、`minCityRuntimeVersion`、`entry`、排序的 `files[]`（相对路径、mediaType、byteLength、sha256）、`contentDigest`。每种 kind 对 entry 定义固定 schema；未知字段、格式或版本明确拒绝。digest 的规范化 JSON、文件排序和摘要输入须在实现前写成可跨 Rust/TS 共享的规范及测试向量；不得自包含 digest。

**当前实现切片**：SDK `validateContentPackageManifestV2` 已实现清单结构校验。world 入口为 `profile/scene/assets/generatorVersion/defaultSeed`，game 入口为 `game/assets`；入口路径必须是已声明的不同 JSON 文件。当前文件类型限 JSON、GLB、PNG 和 JPG，最多 128 个文件、总计 100 MiB；路径按代码点排序，拒绝大小写冲突、绝对路径、反斜杠及路径穿越。`verifyContentPackageBytesV2` 检查精确文件集合、原始字节长度及 SHA-256，并验证 manifest 摘要；这是完整性校验，尚不验证 JSON 语义、资产闭包、来源或运行时兼容，也不提供打包和安装，不得作为可信安装依据。

`inspectContentPackageV2` 在独立字节快照上先验完整性，再检查 profile、场景或游戏规则、项目资产目录、受限 GLB 结构和场景模型 ID/摘要是否能在目录中解析。世界场景模型引用必须指向当前包的 `city-world`、packageId 和 version，digest 使用 `self` 标记，避免内容摘要循环；导出时仅对匹配本项目资产目录及摘要的引用改写为该标记。其 `unchecked` 明确包含来源、运行时兼容、图片解码、额外 JSON 语义、世界道路几何及安装。即使返回成功，也不是完整资产闭包、可运行或可安装的证明。

CLI 现提供 `pack-world <目录> --out <文件> --seed N --generator-version N` 和 `verify-world <文件>`：将 world.json、可选 scene.json、可选 plan-patch.json 和项目资产目录中的 GLB 写入确定性的 base64 JSON 开发产物，并验证完整性与已实现的语义检查。可选补丁保留道路、高架、静态设施和地形操作，并检查 seed、生成器版本及形状；会话建筑标识和移动不允许进入可分享包。补丁的实际重放、地形与道路几何仍须 City 引擎验证。命令必须显式提供 seed 和生成器版本，拒绝覆盖已有输出；结果标记 unsigned、不可安装并返回未检查项目。当前不导出图片或游戏包，也不能将此产物导入宿主安装。

摘要输入：从已校验的清单移除 `contentDigest`，其余字段以 SDK `canonicalJson` 递归按键排序、无多余空白编码为 UTF-8，再计算 SHA-256；每个文件的摘要针对原始字节。清单当前允许的字符串和路径为 ASCII、数字为安全整数。TypeScript 与 Rust 使用相同固定向量覆盖此输入；正式安装实现还须独立校验实际内容与文件系统操作。

桌面 Rust 新增独立的 v2 世界产物完整性检查器，拒绝重复 JSON 键、非法路径、文件集合不一致、非规范 base64 及摘要不符；Rust 与 SDK 测试读取同一完整性向量。此函数尚未接入安装入口，不验证世界语义、GLB、图片、签名/来源或兼容性；它返回的字节仍属于不可信输入。

**本机安装切片（2026-11-14）**：Studio 预检返回一次性 `inspectionId`；用户确认后宿主重新读取并校验同一文件，写入 `<data_home>/state/creator/content/world/<packageId>/<version>/package.json`，元数据写入 `creator_content_packages`。安装通过临时目录 + 原子 rename + DB insert 完成，崩溃留下的孤儿目录在再次安装时按摘要收养；`creator.content.list/uninstall` 提供列表与卸载。安装**仍不**执行内容、不切换城市、不验证来源/签名/运行时兼容，也不代表可分发。

world entry 包含经 SDK 校验的 profile、生成器版本、默认 seed 和兼容主题引用；game entry 包含规则、槽位能力、参数与资产引用，**不包含某座 City 的锚点 ID**。场景资源和 GLB 字节必须包含在包闭包内。游戏包不可执行代码，不接受外部 URI、绝对路径、`..`、链接、重复路径、未声明文件或无法验证的资源。沿用现有 GLB 限制；包与解码大小、文件数、模型数和规则预算需由实现常量统一限制并纳入契约文档和测试，不能只限制压缩大小。

现有 v1 可继续用于开发验证；仅当显式转换器能完整解析、校验并产出 v2 时才能导入为 v2，转换失败保留原文件并给出诊断。v1 的具体 layout/mount 是绑定数据，转换不得伪装成可跨城市的通用游戏；可以生成 game 包和一份仅针对原布局的绑定建议。禁止从 v1 静默升级。

## 5. 本地导入与安装

MVP 仅允许用户主动通过宿主文件选择器导入本地文件。安装流程：选择文件 → 有界读取并显示包类型、ID、版本、摘要和来源未验证状态 → 用户确认安装 → 校验格式、完整文件集合、摘要、资源和运行时兼容 → 写入隔离 staging → 原子提交不可变内容与 SQLite 记录 → 可供选择。SHA-256 证明字节完整性，不证明作者身份或安全来源。安装权限不等于数据授权；不接受可执行内容。

同一 ID/version/digest 重复安装为幂等成功；同一 ID/version 对应不同 digest 返回 `package_identity_conflict`，不得覆盖。不同版本可并存；切换版本由用户显式操作。中途失败、断电或磁盘空间不足不能出现可启动的半安装状态；启动时清理无引用 staging。运行中的包固定 digest，卸载被引用或正在运行的版本时返回引用列表并拒绝；用户先解除引用或切换版本。回滚是选择保留的旧版本并重新验证绑定，不修改旧包。文件选择器路径与包字节不经过 MCP 或 WebView 通用 payload。

安装结果使用稳定错误码：`package_invalid`、`package_digest_mismatch`、`package_unsupported`、`package_budget_exceeded`、`package_identity_conflict`、`package_in_use`、`storage_unavailable`。返回可修复的字段路径；不得泄露本地绝对路径。

## 6. City 实例、迁移与布局

`CityInstanceV1` 包含 `cityId`、显示名称、世界包 digest、seed、皮肤引用、revision、创建/更新时间。宿主使用 CAS 更新 revision 和 operationId 幂等；同一操作重试返回相同结果，参数不同复用 operationId 报冲突。实例创建后由 City 生成布局并发布 `layoutId + worldRevision + anchors + capability links`；宿主只接受当前活动官方 City 的有界快照。

一次性迁移：首次启用实例库时读取现有 City profile、seed、skin 和现有存档引用，生成默认实例并持久标记迁移版本。迁移失败保留旧状态并阻止重复创建；成功后才切换新权威。已有建筑、用户数据引用与官方玩法存档必须保持可访问；不能迁移的记录保留并显示原因，不自动删除。实例隔离需要逐项审计现有 localStorage、对象存储、缓存及远端协议；未完成隔离的能力不得声称可独立多城使用。远端 City 的现有授权边界不因多实例扩展。

世界生成器或参数变更会产生新 worldRevision。旧挂载保留但标记 `needs_rebind`，不能按旧锚点运行；用户或 Agent 重新预览并提交绑定。皮肤仅在声明为不影响布局/碰撞且兼容时可不改 worldRevision。切换实例需保存已提交状态、停止活动并释放资源；失败保持原实例可恢复。

## 7. 挂载与试玩

游戏包声明槽位的语义、数量和能力；绑定时选择具体 City 实例及其固定布局快照，再提供入口和每个槽位的锚点。`mount.preview` 检查包摘要、能力、数量、拓扑及参数并返回有时限的凭据；`mount.commit` 检查实例 revision、layout/world revision 和凭据后原子写入。预览凭据绑定调用实例、规范化请求和基线，有数量与 TTL 上限。若地貌变化、锚点不可达、游戏版本更新或 City runtime 无对应能力，拒绝启动并返回可修复诊断；可信 City 适配器在运行前另查几何净空。

地图显示该实例已启用挂载的名称、状态和入口；只有通过校验的入口可启动。活动租约保证驾驶、其他玩法与场景重建互斥，退出、失败、取消和切换都清理资源。

`PlaytestSnapshotV1` 固定 cityId、实例 revision、world/layout revision、world/game 包 digest、mount revision、规则/引擎版本与 seed。试玩用同一个 City 驾驶适配器和玩家输入路径；终态 Evidence 至少含 runId、快照摘要、状态、完成时间、目标进度和稳定失败码。Evidence 是 City 客户端报告的本地结果，不作为防作弊凭证。可重复的规则结果由无头固定事件序列验证；视觉和真实输入路径单独通过桌面手动验收，不承诺跨设备逐帧确定性。Studio→City→Studio 交接复用现有 runId 和宿主导航机制；失败/取消返回项目，未保存表单先提示，用户拒绝切换时保持 Studio 前台。

## 8. SDK、MCP 与用户流程

以下为目标操作，具体命令/方法签名以实现前冻结的 schema 为准：

| 入口 | 目标能力 | 写入与边界 |
|---|---|---|
| SDK CLI | `init city-world/city-minigame`、`validate`、`playtest`、`pack`、`verify` | 仅访问用户指定项目目录；world/game 产物为 v2 完整包 |
| 宿主 UI | 导入、确认安装、管理内容，创建/选择 City，绑定游戏，地图试玩 | 文件经原生选择器；用户显式安装 |
| MCP | 项目读取、preview/commit、操作状态、布局读取、挂载预览/提交、试玩历史 | 沿用 `--allow-local-writes`、活动 Studio 等现有约束；不得从任意路径安装或绕过用户确认 |
| Studio | 显示项目、诊断和预览，发起试玩 | 使用同一项目/挂载服务；首版可保留 JSON 编辑 |

Agent 修改项目以 `expectedRevision + operationId` 提交；断线后查询 operation status，避免已提交请求重复执行。Agent 的无头试玩由固定事件序列驱动；可视试玩由玩家控制，Agent 仅读取结果和取消。SDK 纯逻辑不依赖 React、Three.js 或 Tauri；宿主 UI 和 CLI 复用同一 schema 及跨语言测试向量。

## 9. 实施顺序与验收门槛

1. **基线与交接**：确认实际运行的桌面包、Studio 注册/导航和已有预检失败原因；恢复 Studio→City→Studio，并证明取消和失败可返回。保持现有 City 驾驶和存档行为。
2. **v2 内容格式**：冻结 world/game schema、摘要向量、资源闭包和 v1 显式转换策略。仓库外样例只依赖 SDK 本地 tarball；篡改、缺文件、超限和不兼容输入均被拒绝。
3. **安装与实例**：实现 staging/原子提交、内容库和独立实例，完成旧偏好/存档迁移、异常恢复及重启持久化。
4. **绑定与运行**：一个游戏在两个兼容 City 实例分别绑定；地图入口、预检、活动租约、终态记录和解绑正常。布局变化使旧绑定失效，不能静默使用。
5. **Agent 迭代**：Agent 调整游戏参数，预览、CAS 提交、重新打包，用户安装新版本并显式更新绑定；失败可根据诊断修复。验证重试幂等。
6. **桌面端端到端验收**：海滨城 + 检查点竞速、沙丘城 + 区域寻宝各完成一局；同一竞速游戏在两城分别绑定并完成试玩。重启后两个实例、各自挂载及结果仍隔离；卸载引用中的包被拒绝，解除引用后可卸载。旧 City、驾驶及现有存档回归通过。

每项验收记录构建版本、平台、包 digest、实例及布局 revision、运行结果和失败诊断。自动化覆盖 schema/摘要向量、恶意或损坏包、安装恢复、CAS/幂等、迁移、绑定失效和规则运行；真实桌面验收覆盖导入确认、安装、地图入口、正常输入、退出与重启恢复。所有测试使用合成或已有授权的本地数据，禁止上传真实 session 数据。

## 10. 完成定义与后续

只有六个实施切片全部通过，才能称为“City SDK 内容创作、安装与试玩 MVP 完成”。通过说明已注册生成器与受支持规则可组合；不说明外部作者可以安装新代码或创建任意类型游戏。后续独立决议包括新生成器/脚本运行时及沙箱、完整资产管线、签名与发布者身份、Shop 授权和交易、多人与云分发。它们须复用版本化内容及安装边界，并分别满足仓库的数据与独立应用安全政策。
