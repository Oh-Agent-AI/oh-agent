# Creator Studio 自定义城市与 MCP 接口设计

状态：设计提案，尚未实现或通过真机验收。日期：2026-11-14。

实施进度：已接入独立 City 草稿的创建、读取、列表、配置替换预览与版本化提交、只读视口/状态/截图、布局保存；V2 布局绑定 City ID、修订和种子，并可通过 `creator_project_create` 的 `cityId` 绑定项目（项目与 release 快照冻结 cityId/cityRevision/cityLayoutId）。只读视口尚未完成桌面真机验收，也不是 City 运行时切换；旧迈阿密尚未迁移，城市切换与全链路隔离尚未实现，活动 City 的跨 generator 世界切换已被拒绝（`city_world_profile_city_mismatch`）。因此这些接口仍不能作为独立城市验收通过的证据。

关联：[Creator Studio 架构](AGENT_CITY_CREATOR_STUDIO_CODE_ARCHITECTURE_2026_11_11.md)、[SDK 迁移现状](AGENT_CITY_SDK_MIGRATION_2026_11_10.md)、[沙海之门 SPEC](EGYPT_DESERT_CITY_SPEC_2026_11_14.md)。本方案细化城市身份与自定义风格，不改变仓库本地数据及远程访问政策。

## 1. 目标与现状

创作者及本地 Agent 能新建、预览、保存并重新打开具有独立地形、外观、场景和小游戏的 City；创建沙丘 City 不得修改迈阿密 City。支持基于真实运行画面的审查和修订。首个目标是「沙海之门」：沙丘、暖砂色主题、原创纪念性巨门与驾驶收集游戏。

现有 `city_world_profile_preview/apply` 操作活动 City 的单份偏好，且只接受已注册生成器和主题；不得用它实现独立新城。Creator MCP 已有项目、场景/游戏预览提交、静态检查、捕获画面和试玩工具，项目当前绑定布局而非独立 City。模型须先通过桌面原生选择器导入，MCP 只能引用已登记资源。现有真实数据链路与前台插件限制继续生效。预览参数有效不代表城市完成渲染或持久化成功。

## 2. 对象与权威

| 对象 | 身份与内容 | 权威及约束 |
|---|---|---|
| City | `cityId`、名称、状态、`revision`、世界 profile、seed、风格、场景及布局引用 | 本地 City 服务拥有已提交状态；`cityId` 与 WebView 实例 ID、profile ID 均不同。草稿也持久化，但新建不自动切换活动城市 |
| Layout | `cityId + worldRevision + layoutId`、生成器版本、受限锚点 | 由对应 City 运行时生成；不得按裸 `worldRevision` 跨 City 查找或绑定 |
| Style | 版本化、声明式的地形参数、主题、光照和已登记资产引用 | 仅可使用运行时能力目录中已实现且经校验的字段；缺失能力明确报错，不静默替换 |
| Creator 项目 | `projectId + revision + cityId + layoutId + worldRevision`、游戏、场景和挂载 | 复用项目服务事务；已发布 release 固定完整城市及布局身份和资产摘要 |
| Preview | 不可猜的 `previewId`、cityId、base revision、操作摘要、插件实例、过期时间 | 仅临时存在，不是保存或安装；不可跨城市、版本或实例提交 |

持久化由本机宿主服务统一维护城市及修订记录；SDK 定义类型与纯校验，可信 TS 适配器负责 City 业务、生成器和渲染语义，Rust 负责身份授权、结构/预算约束与原子事务。不得新增 City 专用 Rust 数据投影或绕开已批准 typed-data 边界。适配器生成的布局及验证结论必须绑定输入摘要、城市与 revision；宿主检查来源、绑定和时效，不能信任调用方自报通过。

## 3. 建议 MCP 契约（目标接口，非现有能力）

所有接口为版本化固定操作，`additionalProperties: false`，ID 长度、分页、请求和响应大小有明确上限，数值须有限且在能力目录声明的范围内。输出沿用 `{ok, data}` / 稳定错误信封。除能力查询外，均经获授权的活动官方 Studio 实例处理；操作开始及返回前检查实例和授权。写入需要 `--allow-local-writes`。城市创建/切换不会扩展 MCP、导出或远程数据权限。

| 工具 | 输入 → 输出及行为 |
|---|---|
| `creator_city_list` | `cursor?`, `limit` → 城市摘要、revision、状态、下一页；不返回会话分析数据 |
| `creator_city_create` | `name`, `profile`, `seed`, `operationId` → `cityId`, `revision`；创建独立草稿，不修改或切换其他 City。profile 通过 SDK 与已注册能力校验 |
| `creator_city_read` | `cityId`, `revision?` → 有界配置、style、layout 摘要；revision 不匹配返回冲突。大内容采用有界分页 |
| `creator_city_open` | `cityId`, `expectedRevision` → 加载请求及状态；有活动冲突时返回 busy。仅在目标已渲染且布局就绪后切换活动 City，失败保留原活动 City；不修改已保存城市 |
| `creator_city_edit_preview` | `cityId`, `baseRevision`, `operations[]` → `previewId`, 差异、诊断、过期时间、`checks`；只预览不保存。允许 `world.set`、`style.set`、`scene.object.upsert/remove`，枚举和预算由能力目录提供 |
| `creator_city_edit_commit` | `cityId`, `previewId`, `expectedRevision`, `operationId` → 新 revision、变更摘要及布局状态；仅提交同城市、同实例、同基线的有效预览 |
| `creator_city_operation_status` | `cityId`, `operationId` → 已提交结果或 not_found；供超时后的安全重试使用 |
| `creator_city_layout_read` | `cityId`, `worldRevision`, `cursor?`, `limit` → 该城受限锚点及能力；无布局、过期或来源不符明确返回错误 |
| `creator_city_validate` | `cityId`, `revision`, `profile: static | runtime` → 每项 `passed/failed/unchecked`、诊断及证据身份；runtime 模式需要对应场景就绪 |
| `creator_city_capture` | `cityId`, `revision` → 有界画面和相机、城市与 revision；画面未准备好返回错误，不能把旧帧当新城证据 |

**2026-11-14 实现状态**：已实现 `creator_city_list/create/read/edit_preview/edit_commit`（当前 edit_preview 只做 name/seed/profile 的配置替换，**不接受 operations[]**）、`creator_city_view/view_status/capture`、`creator_city_layout_read/layout_save` 与诊断读取。**未实现** `creator_city_open`、`creator_city_operation_status`、`creator_city_validate`、按 operations 的场景/样式编辑、项目绑定与发布、旧迈阿密迁移、城市切换与全链路隔离；只读视口尚未做桌面真机验收。表内其余行为是目标契约，不是现有能力。

能力发现扩充现有 `creator_capabilities_list`，列出受支持的生成器、主题、风格字段与数值范围、对象类型、资产类别及预算。与既有项目接口演进兼容：新增按城市筛选的 layout 查询，新建项目必须显式提供 `cityId + layoutId + worldRevision`；场景、项目、发布和试玩在服务端逐层核对城市身份。保留旧接口供迁移期旧项目使用，不能将旧调用隐式指向沙丘。具体兼容窗口及版本号在实现 PR 中确定。

`world.set` 修改地形或 seed 时生成新布局身份并标记旧布局绑定为待修复，不能自动把旧锚点视为有效。风格变更按能力区分纯视觉与影响几何的变更；后者同样使受影响布局/挂载失效。已发布 release 保持不可变，运行前仍需确认其城市及布局匹配。

## 4. 风格与资产

首期风格配方组合现有 `CityWorldProfileV1`、显式注册的视觉参数和场景对象，不接受代码、着色器、任意 URL、路径或自定义生成器。沙丘地形与 `desert` 主题可立即表达；薄雾、光照和专用地标必须先注册并实现后才可出现在能力目录。规范应包含可复现的参数、资产摘要、坐标、旋转与比例；风格文字描述只能作为设计意图，不能当作运行时配置。

资源首期仍由用户通过桌面文件选择器导入受限静态 GLB，宿主校验并保存内容寻址副本；MCP 经有界目录发现已授权资产，再用 `assetId + digest` 引用。不得把本机路径或 GLB 字节放入 MCP 请求。资产所有权、城市场景与项目 release 的引用关系必须持久化，删除或清理不得移除仍被其他城市/发布版本引用的内容；同摘要可共享只读字节，引用与修改权限仍按城市/项目隔离。任何未来生成或下载流程须另行设计授权与数据边界。

## 5. 事务、迁移和恢复

- 城市创建及提交使用稳定 `operationId`：同主体、城市、操作类型、ID 与同一规范化请求返回先前结果；相同 ID 对不同请求返回 `operation_id_conflict`。结果与数据在同一事务持久化，跨重启可查询。创建时使用主体和操作 ID 作为幂等范围，因为 cityId 尚不存在。
- 提交事务先检查实例、授权、cityId、基线 revision、预览摘要和有效期，再写入完整新 revision 与操作结果；失败不产生半个 revision。并发提交只允许一个基线获胜；其他调用重新读取、预览。
- 运行时加载是独立阶段：持久化成功返回 `committed`，生成与渲染以 `pending/ready/failed` 独立报告，不能仅因事务成功声称画面已就绪。失败保留可恢复的已保存版本与诊断；活动城市切换失败时保留原城市。
- 迁移现有迈阿密：先读取并备份原 profile、skin、seed、patch、布局、项目及 release 引用，分配稳定 cityId；验证映射并在事务中建立新记录，成功前旧数据只读保留。重复迁移使用稳定 operationId。无法可靠绑定的项目标记待修复，不猜测归属；不得覆盖旧数据。迁移失败或中断可重试并恢复原城市。迁移期间暂停旧存储写入，完成 cutover 后只有一个写入权威，避免双写。
- 对视觉数据和项目的快照或导出，沿用现有权限与投影；视口截图会进入调用 Agent 的上下文，不得假设其只留在本机。

### 本地预览诊断

`creator_city_diagnostics` 按城市读取最近的有界事件，包含城市 revision、每次视口打开时生成的关联 ID、事件类别、固定错误码、耗时和本机时间。当前覆盖预览开始/首帧/失败及布局保存成功/失败；每城市最多 500 条、全局最多 2000 条，超限淘汰最旧事件。UI 无法写入诊断时状态接口标记诊断不可用；不持久化异常原文、文件路径、会话或截图。事件仅供本地 Studio/MCP 查询，不增加网络发送。

当前尚未覆盖城市创建/编辑的完整操作时间线、规划器的逐项诊断、资源释放及试玩事件；已有历史失败发生在诊断实现之前，不会被追溯补造。需分别验收日志持久化、裁剪、跨城市隔离、记录失败的降级与桌面重启后的查询。

## 6. 创作工作流

1. 查询能力，列出并记录迈阿密 cityId、revision 和布局/项目引用；创建独立沙丘 City 草稿，记录新 cityId。
2. 查询/预览沙丘配置及已授权资源摆放，检查结构、预算、静态诊断后提交；等待目标 revision 的布局和真实视口就绪，截图检查并迭代。
3. 用该城的 `cityId + layoutId + worldRevision` 创建驾驶区域收集项目，绑定该布局中锚点，预览并提交规则及场景，保存并发布固定 revision。
4. 启动真实可视试玩，玩家完成一次驾驶；读取与 cityId、release、revision、runId 绑定的结果。静态检查与试玩证据分别记录。
5. 切换迈阿密并重启，复核原数据与画面；再切回沙丘，复核配置、场景和小游戏。不得从其他城市借用锚点冒充目标 City 的布局。

## 7. 发布验收与交付顺序

| 优先级 | 交付 | 必须通过的验证 |
|---|---|---|
| P0 | 独立 City 身份、迁移和存储；可恢复切换 | 两城互不影响；重启、强杀、磁盘写入失败、旧迁移重试、并发冲突、幂等重放；跨城市引用拒绝 |
| P0 | 城市 MCP 创建/读取/预览/提交及权限 | 预览过期、实例切换、跨城提交、权限撤销、重复操作、超时状态查询；旧接口不误写新城市 |
| P1 | 真实沙丘布局、状态与截图、风格能力目录 | 真实桌面 bundle 渲染并重启恢复；生成器/资源缺失与渲染失败明确报告；截图 revision 与城市一致 |
| P1 | 项目/布局/release/试玩贯通 cityId | 城市间锚点、项目、release 混用全部拒绝；驾驶收集从创建、保存、发布到玩家试玩终态完成 |
| P2 | 原创资产与扩展光照、编辑体验 | 资产导入、摘要校验、引用计数及清理；地标可见且不遮挡道路，运行时性能和视觉审查通过 |

测试包含 SDK 契约与非法输入、宿主事务和迁移故障注入、适配器身份边界、Creator/City 集成；最终在通过 `open` 启动的 Tauri `.app` 上执行双城市、真实输入和重启测试。报告明确记录城市、布局、项目、release、run 的 ID/revision 与截图；纯 schema、无头或合成数据测试不能替代真机结果。

## 8. 实现前需定稿

明确 City 存储位置与迁移事务边界；确定旧活动 City 写路径冻结和回滚方法；列出风格参数具体白名单、范围及资源预算；定义布局构建任务的取消、失败和恢复；确定多城市 release 兼容协议与旧项目归属处理。上述细节未定前不得宣称已有隔离保障。
