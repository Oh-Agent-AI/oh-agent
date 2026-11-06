# 飞机与汽车共享游戏基础设施 SPEC

日期：2026-10-18。状态：实施与集成验收中，尚未全部完成。审查基线：`dev@82a1dc1a6e92ff790f9dcef0830586d4f19e0a82`。逐项证据与剩余项见 [实施台账](CITY_SHARED_GAME_IMPLEMENTATION_TASKS.md)，本文件的审查表保留基线问题，不表示当前代码仍全部存在。

本文将现有运行时的第一阶段实现收尾，建立第三种载具（如游艇）可复用的宿主边界。本文不代表任何功能已经修复或验收。

关联文档：[共享运行时现状](CITY_SHARED_VEHICLE_RUNTIME_NOTES.md)、[开放世界路线图](CITY_OPEN_WORLD_ARCHITECTURE_PLAN.md)、[驾驶架构](CITY_DRIVING_ARCHITECTURE_SPEC.md)、[产品出生点契约](CITY_GAME_VEHICLE_MODE_SPEC.md#135-正式出生点契约)、[收尾检查表](CITY_DRIVING_COMPLETION_TRACKER.md)。

## 1. 审查结论与范围

当前已共用 `GameRuntime`、`FixedStepClock`、`KeyboardInput`、`VehicleChaseCamera` 和宿主 `CityEnvironment`。飞机与汽车保留独立的物理、输入映射和活动规则是合理设计。各自持有运行时实例本身也不是缺陷：在当前单活动模式中，关键要求是宿主只允许一个活动占有帧与相机。

本轮必须完成：宿主租约实装、静态固体事实统一、正式出生校验闭环、相机授权与遮挡、音频生命周期接入、长帧定位及原生验收。持续世界、角色上下车、动态交通、流送和存档属于后续版本，不作为本次修复的隐含交付。

天气目前影响呈现与飞机雨声；“共享天气”不要求立即改变抓地力或飞行受风。雨天物理属于另一个有版本的玩法变更，不能夹在本次架构迁移里改变审计结论。

## 2. 代码审查发现

以下“确认”指静态代码事实；风险后果未声称已经在真实 App 中复现。

| ID / 优先级 | 当前证据 | 影响与处理 |
| --- | --- | --- |
| F1 / P1 | `game/runtime/GameScenePort.ts` 定义完整租约；代码中没有实现和消费 `GameScenePort.acquire`。`GameSession.ensureRunObjects/attachRun/exit` 直接改宿主相机、对象与全局 hook；汽车走 `CityEngine.captureDrivingWorld`。 | 两套所有权路径仍并存。飞机清理缺少 token 校验，存在过期清理干扰新活动的风险。以 §4 替换活动入口，审计捕获保留只读语义。 |
| F2 / P1 | `FlightWorld.ts` 按 layout/model、类型高度表和整桥包围盒推导障碍；`createCityCarSession.ts` 合并结构、scene proxies、rendered solids。 | 同一建筑和桥梁有两种事实推导。统一输入事实与身份；允许载具查询形状不同，禁止重新猜建筑高度。 |
| F3 / P1 | `driving/spawnPoints.ts::validateSpawnSpec` 构造 `environment` 后直接 `{ok:true,spec}`，没有遍历 `spec.spawns`；导出的 `validateSpawnPoint` 也没有被它调用。边界和切向常量未用于验证。 | 任意合法世界上，点位本身的错误可能被整表验证放行。现有守卫仅测整表早期拒绝和候选派生，不能证明有效世界中的坏点会拒绝。必须补真实有效世界负例。 |
| F4 / P1 | 出生校验未合并 `renderedSolids`，上限固定 4096；正式 `createCityCarSession` 接受坐标/层，并未消费已确认 spawn 或有效开放图凭据。 | 校验与实际入场的障碍集合、预算和发布条件不一致。UAT 当前独立且显式；在正式入口开放前必须完成 §6。 |
| F5 / P2 | `CarCamera`、`FlightCamera` 已共同调用 `VehicleChaseCamera`。但汽车策略与撞击 shake 的编排仍在 CityEngine，汽车只注入 terrain 查询；核心遮挡采用三个点采样。`CameraPose` 没有 up 字段。 | 不能将“相机核心已共享”误报为完全没有复用，也不能声称相机已防穿墙。移动策略归属、补近裁面体积查询和完整 pose。 |
| F6 / P2 | `DrivingSfx` 在应用驾驶链中无消费者；其构造会尝试建 AudioContext。飞机 `GameSfx` 有模块级共享 context，并在暂停后延时 suspend 整个 context。 | 不是“两种载具已经同时占用多个 context”的实测事实，而是汽车音效未接线、未来共享后暂停会互相干扰的生命周期缺口。按 §8 接入。 |
| F7 / P2 | `CityEnvironment` 已为天空和飞机雨声提供一致快照；当前取宿主本地时区。物理未消费天气。 | 保留既有天气行为，明确时区与时间来源；为未来玩法暴露独立版本的 tick 环境，不擅自增加雨天制动力变化。 |
| F8 / P1 验收 | `FixedStepClock` 单帧最多 5 tick，积压一个完整 tick 或超过 250ms 都暂停；原生笔记记录长帧暂停，但尚未归因。 | 不能只盯 250ms：60Hz 下约 100ms 的稳定帧也可能超预算暂停。先测渲染、准备、查询和音频成本，再决定是否调整交互策略。 |

另有原有工作：桥头工程几何、最终几何版本的全城审计、本地审计界面及故障分解路线。它们继续在原检查表跟踪；本 SPEC 不把合并完成当作这些工作完成。

## 3. 必须保持的约束

1. 同一个 City 宿主只使用既有 renderer/rAF；每个活动物理步只执行一次。
2. `GameRuntime` 管生命周期与活动时钟；`RaceMission` 和 `GameModeController` 保留比赛/倒计时/结果规则，不塞入汽车自由驾驶状态机。
3. 汽车人工驾驶与审计复用 `DrivingKernel`。现有人工宽容碰撞配置与严格审计配置保持显式不同身份，不将宽容玩法结果发布成严格审计通过。
4. 固体构建/查询失败、超预算、未知几何和过期身份返回明确失败，不视为空场景。构建总量预算与每次查询预算分别记录。
5. 数据投影、路面和建筑碰撞在活动中保持一致；天气与天空可持续更新。准备期间也必须冻结依赖的静态事实。
6. 本地游戏功能不新增用户数据上传、MCP/export 字段或直接 DB/日志读取。真实城市审计和性能信息默认仅在当前实例内存中保留。

## 4. 统一宿主场景租约

### 4.1 所有权与 API

沿用 `GameScenePort` 名称和选择联合 `plane/practice`、`plane/race`、`car/free`。一个 CityEngine 拥有一个端口实现；端口的内部宿主适配器可以操作 Three，Runtime 和物理模块不依赖 Three/React/DOM。

`acquire(selection, runId, signal)` 在调用时同步预留活动槽，之后异步准备快照。第二次 acquire 在第一次尚未完成时也必须返回 `busy`。完成、失败和取消统一走同一资源事务。外部使用 typed result（busy/cancelled/unavailable/ready）；不得靠不同错误字符串猜是否取得所有权。

租约包含：不可伪造 token、宿主 epoch、worldRevision、只读能力快照、快检、attach/detach、setFrameHook、setCamera、环境车可见性覆盖以及 release。`runId` 是调用方上下文，不代替宿主 token；两种运行时都可能从 runId=1 开始。

`CameraPose` 扩展 `up`，校验所有数值有限、0<fov<180、position/target 不重合、up 非零且不与视线平行。setCamera 只校验授权并应用 pose；阻尼、FOV 响应、跟车距离和抖动在呈现策略内计算。

### 4.2 获取与释放事务

获取顺序：

1. 检查宿主存活、航拍/导出/修复互斥、signal；同步预留 token。
2. 在改 controls/owner 前保存 ReturnState：相机完整姿态、controls.enabled/autoRotate、环境车实际可见状态。
3. 取得静态内容 pin/freeze；冻结静态几何，准备共享事实。任意 await 后复核 token、signal、宿主 epoch 和世界身份。
4. 授予对象/相机/帧能力。Runtime 完成 adapter.prepare 后入场暂停；首帧呈现不推进物理。

释放顺序：使 token 失效并终止准备 → 清本租约 hook → adapter 清输入/相机策略/音频 → 摘本租约挂载对象 → 恢复 ReturnState → 释放静态 pin → 宿主应用最新待更新投影 → 发一次活动结束通知。

Runtime 负责 adapter.dispose 的调用，端口负责宿主资源；对象摘除不代表端口代替对象所有者 dispose 共享 GPU 资源。任何一环抛错也必须继续释放其他资源。

所有租约写操作验证 token。release 幂等；旧租约的 setFrameHook(null)、detach、release 不得清新租约的 hook、对象或相机。失效后的写操作返回 stale；清理操作允许幂等 no-op。

### 4.3 兼容与迁移

- `captureDrivingSurface/captureDrivingWorld` 保留给只读审计，不能因审计捕获抢占活动槽、隐藏环境车或改变相机。相机/帧所有权从汽车只读捕获中拆出，由 GameSceneLease 管。
- 飞机入场改为可取消准备；旧同步 UI 包装可立即进入 preparing，但不得先宣告成功、启动飞行或挂对象，再等待快照。迁移 hook 的返回类型及重试/退出调用方。
- `enterSync` 仅供资源确实就绪的夹具/兼容内部路径；不能对 Promise 强行同步。重试是否复用原快照由仍有效的 lease 决定。
- 完成两种入口迁移后，清除活动代码对 `setCameraOwner/setGameFrameHook/renderCamera` 的直接写入。其余航拍和编辑调用需要明确兼容边界。

## 5. 共享静态世界事实

### 5.1 内容与能力

引入宿主内 `StaticWorldSnapshotV1`：schema/compiler version、静态身份、来源 coverage、不可变 solids、地形查询能力、可选道路编译能力以及构建诊断。依托现有 `CitySurfacePort` 和冻结源提取，不另建第二套渲染遍历器或数组 hash。

静态内容至少包含当前两条链已有的结构、建筑/地标和白名单代理；远山、背景楼等飞行现有覆盖逐项对照。未纳入共同事实的类别必须显示为 coverage 缺口，不能在替换旧 FlightWorld 后静默消失。

固体汇编只有一个实现：结构描述符 + whitelisted proxies + rendered-solid 转换，稳定 ID、稳定排序、明确去重/别名规则、深层只读或只读缓冲所有权。不能只 freeze 顶层后仍允许修改 nested geometry。

能力按需准备：汽车必须有 ready 的路面/portal；飞机可在路面编译 unavailable 时使用 ready 的固体/地形能力，不将汽车特有的道路约束变成飞机入场门槛。快照身份须明确区分共用 staticContentRevision 与各查询编译版本，不能把 surface revision、worldRevision、runId 混用。

### 5.2 查询与身份

汽车继续整车 OBB/TOI/滑动，飞机继续球体扫掠/地形检查。可从共同固体派生保守包络，但每个派生结果绑定原 solidId 与转换版本，禁止另按建筑类型猜高度。

`FlightWorld` 保留飞行边界、出生和 terrain API，将其布局造盒代码迁为仅供旧语料对照的迁移夹具；共同来源接通后生产路径不再叠加旧盒。检查桥下和桥墩空隙，不能把整段桥梁重新封成一大盒。

短期整个有限岛屿仍整体冻结；内容更新使持有该内容的活动失效。天气采样不改变 staticContentRevision。后续动态实体使用独立 tick revision，不写回当前静态障碍数组。

固体包络变化是行为变更：记录 compiler/flight-collision/course 版本依赖，失效受影响路线与成绩证据；不直接刷新 golden 掩盖差异。汽车审计 key 同样绑定采用的固体编译版本。

## 6. 正式出生点和开放图接线

### 6.1 真实验证

`validateSpawnSpec` 必须校验每个点后才能返回整表成功，且验证开始/结束都核对世界与开放图 lease。拒绝空列表、重复/空 ID、非有限坐标/朝向、未知层、错误 schema、过期 graph key 或世界身份。失败返回带点 ID 的结构化结果；不得静默删坏点再把原表标为成功。

每点必须通过：

- layer/region 与当前可行驶区域一致，四轮支撑、姿态、完整车身覆盖和障碍净空合法。
- 三源固体与实际正式入场完全一致；采用同一个汇编器和显式车辆/碰撞配置。不得遗漏 renderedSolids，也不得继续把构建总量固定成单次查询的 4096。
- 对应当前 passed 的有向开放单元，具有可验证的层、中心线、沿程位置和局部边界事实；相同 XZ 的桥上/桥下不能互认。
- 满足产品 SPEC 的开放边界 2 单位余量。本版定义为出生参考点 XZ 到同一支撑层开放可行驶集合边界的最短平面距离；集合边界包括外轮廓、孔洞及通向未开放单元的封闭边界。相连且已验证的内部 patch/portal 接缝不算边界，另一高度层的轮廓不参与。整车净空另行校验，不能用点距通过代替它，也不能用入口 gate 宽度冒充边界距离。
- requireTangentAlign 默认 true；按候选所在沿程处的有向切向校验 ±45°，不只比较第一段 startHeading。

`ReleasedUnitGeometry.halfWidth` 目前已存在，但取自首 gate；它不是整条路径的最小净宽证明。因此仍需版本化增加沿程/层/边界依据，缺证据返回 unavailable。不得将一个宽度字段的存在等同于边界检查已经可做。

### 6.2 入场与确认

正式 `createCityCarSession` 消费绑定 current graph/世界/车辆配置的已校验出生凭据，而非裸坐标。凭据只能由当前校验服务构造；入场再次复核 freshness 与整车放置。确认记录表达“选定哪个候选”，不能越过安全校验或在 revision 变化后继续使用。

正式驾驶运行中也必须执行开放范围，而非只在出生时查一次图。按既有架构从待关闭单元产生可见护栏/提示与同源碰撞边界，冻结后进行最终边界重放审计，再发布带一致 `releaseBoundaryHash` 的图；禁止发布后新增未审计障碍。缺少该闭环时保持正式入口 unavailable。UAT 可检查尚未开放的道路，但必须继续标诊断，不能复用正式可通行承诺。

用户主动确认/取消是本地明确操作。候选状态为 derived → validated → confirmed；内容或车辆规则改变后失效。确认记录与场景 ID/内容版本绑定，存储走已有宿主注册的游戏配置能力；若无该能力，应先提供当前实例内存确认，明确退出后失效。持久化需单独声明最小字段与测试，不能借机扩展插件数据权限。

诊断入口继续独立 `diagnostic-only`，不生成确认记录、不发布开放图、不绕过正式入口校验。普通构建保持既有关闭状态，直到正式门禁完成。

## 7. 相机策略和呈现

复用现有 `VehicleChaseCamera` 阻尼和 `CarCamera/FlightCamera` 参数壳。新增的呈现会话持有载具镜头、指针控制、撞击效果和 reset/dispose；CityEngine 通过租约只应用 CameraPose。先提供 Three 相机适配层，逐步将核心计算改为输出 pose，避免一次重写已调好的阻尼。

提供共用静态查询适配器，对目标到相机的运动以及近裁面体积执行有预算的扫掠/净空检测。三个离散点只作启发式，不能作为防穿墙证明。检查**阻尼后的实际相机位置**，防止期望锚点已收缩而插值相机仍留在墙后。初始重叠/预算耗尽采用可见的安全收缩或暂停诊断，不能当作无遮挡。

首帧、复位、切换载具、世界失效清历史。reduced-motion 禁止 shake 和速度 FOV 冲击；当前 CityEngine 的撞击 shake 也必须受同一策略控制。保留环绕、缩放与暂停观察行为，验证桥下/窄巷/薄墙/快速转弯。

## 8. 音频和环境服务

### 8.1 音频生命周期

建立宿主级 `GameAudioService`，统一 AudioContext 预热、手势解锁、音量、静音、宿主挂起和会话通道释放。各载具声音映射保持独立，音乐可保留 HTMLAudioElement，但进入同一会话生命周期。

通道 token 管 master gain 与节点所有权。暂停载具仅静音/暂停该通道；延迟 suspend、resume promise 和 dispose 都校验当前 generation。只有服务确认没有活跃通道/预热需求时才能挂起 context，单个载具不得关闭共享 context。退出必须 stop/disconnect 所有自建 source 和 timer，不能仅置 nodes=null 后留下运行图。

DrivingSfx 接入真实城市驾驶的油门、刹车、倒车及碰撞事件；构造不创建音频设备。碰撞音不能只由持续 blocked 每帧触发，需明确有效接触事件/节流。无音频能力或拒绝解锁时静默降级。车辆切换后旧通道的延迟回调不得挂起新通道。

### 8.2 环境事实

继续由宿主唯一 CityEnvironment 采样，帧内先更新环境，再推进活动/呈现。显式区分内容 cursor、模拟 tick 与呈现时长；暂停模拟不会隐式改变回放 cursor。

保持现有本地日期天气行为，快照显式携带用于解释日界的时区/偏移信息。回放可复现承诺须限定相同时区策略；跨机器复现需使用固定的环境时区输入，不能声称仅 timestamp 就保证跨时区一致。航拍晴天 override 作为模式覆盖，退出恢复世界环境。

本轮将同一环境快照接到两种载具的呈现/音频。未来若增加风、湿路附着或水面波浪，使用版本化 `SimulationEnvironment`、固定 tick 输入和显式启用配置；审计 key 必须纳入环境 profile，未启用时保持现有物理。

## 9. 长帧定位和验收

维持现有定步/暂停规则作为迁移基线。先区分 `invalid-delta`、`frame-gap`、`catch-up-budget`、`query-budget`，避免都显示同一个原因而无法定位。

内存诊断记录有界聚合：帧时 P50/P95/P99、tick CPU、查询 CPU/候选数、准备耗时、呈现/渲染耗时、补步数量、超限原因、活动资源计数；建议固定 120 秒滚动窗口。CPU 段用 monotonic time，天气/回放使用显式环境时间；不采集按键轨迹、业务标识或用户日志，不自动写盘或上传。

验收设备和画质档位必须记入报告。每种载具至少连续运行 10 分钟，至少 20 次飞机/汽车交替进入退出；包含失焦、回放 seek、切日、窗口 resize、context lost。记录 GC/音频解锁/布局准备与暂停的时间关系。普通主动驾驶阶段不得出现未解释的自动长帧暂停；若达不到，保持验收未通过并列出瓶颈。

不通过增大预算、跳过碰撞或把失败改成 inconclusive 来达成流畅性。只有测量说明需要调整交互时钟时，另行记录策略/版本并验证比赛时间与 30/60/120Hz 一致性。

## 10. 开放世界后续边界

P0 完成后，未来 WorldRuntime 才接管单一世界 tick；届时 GameRuntime 转为活动生命周期编排，移除其 authoritative FixedStepClock，避免双时钟。EntityStore 保存实体状态，PossessionController 转移控制权，活动结束不自动销毁世界车辆。

动态碰撞、区域 pin/流送、角色 Motor、座位/上下车、安全迁移及存档按原开放世界 P1–P4 分阶段实现。上述模块本轮不创建空壳、不标完成，也不要求为了“统一”修改现有汽车/飞机物理状态类型。

## 11. 实施批次与文件归属

| 批次 | 交付与主要落点 | 依赖与完成证据 |
| --- | --- | --- |
| S1：活动租约 | 实装 `GameScenePort`；宿主 token/ReturnState 事务；迁移 `GameSession`、`createCityCarSession`、两种 hooks | 先写跨 Runtime 的旧 lease 清理负例；准备并发/取消/失败/失效/重复释放全过；审计不占相机 |
| S2：事实统一 | 将 `createCityCarSession` 的固体汇编提取为共享编译服务；FlightWorld 消费共同快照 | S1；按类别对照 coverage，桥下/显示高度/昼夜装饰与独立查询回归；明确版本迁移 |
| S3：出生与发布 | `spawnPoints` 整表真实校验、图几何证据升级、正式入场凭据、最小确认流程 | S2；有效世界内的无效点全部拒绝；旧图/层错/建筑/边界/方向负例；UAT 与正式隔离 |
| S4：呈现服务 | 移出 CityEngine 汽车镜头策略；补相机体积查询；共享音频服务，接 DrivingSfx；环境时间契约 | S1/S2；遮挡/输入/音频异步代际与 reduced-motion 负例；两载具功能回归 |
| S5：实测收尾 | 有界性能诊断、原生 bundle 与 10 分钟/20 次切换验收、更新历史文档入口 | S1–S4；原生实际记录，失败保留；最终版本重跑相关城市/审计证据 |

S1 可先做；S2 后才能对齐正式出生障碍。S3 的确认 UI 不能先于真实验证开放。S4 的音频通道可独立开发，但集成依赖统一租约清理。每批完成更新收尾检查表，不把未来开放世界批次混入本轮完成率。

## 12. 验证门槛

新增或扩展现有守卫并登记 `scripts/city-kit/verification-manifest.json` 和 game 组：

- **宿主事务**：两实例同时 acquire、准备取消后立即换载具、旧 release/hook/attach/camera 回调无权操作新局；准备每个失败点都无残留对象/监听/freeze。
- **固体事实**：同一 solidId 与 revision 两种查询适配器来源一致；楼体生长高度冻结、空实例与坏矩阵、桥墩柱间通道、非盒 mesh 保守覆盖、超预算拒绝。
- **出生**：使用真实 ready 快照测试整表内一个有效点加一个无效点；楼内/孔洞/错层/逆向/近边界/过期图/空表/重复 ID/NaN 必拒绝。检查正式入口不能绕过确认和 graph lease。
- **相机/音频**：薄墙和桥底近裁面、阻尼路径、reduced-motion 无抖动；旧音频 timer/promise 不影响新通道，20 次切换资源计数回基线。
- **兼容**：飞机比赛倒计时/重试/结算/档案不回退；汽车滑动、坡度、倒车与审计语义不变；30/60/120Hz 同输入固定 tick 结果一致。允许镜头呈现误差，禁止拿镜头误差阈值替代物理一致性。

建议命令（按对应批次执行，不因纯文档变更重跑全城长测试）：

```sh
cd apps/agent-city/ui
npm run typecheck
npm run build

# 以下从仓库根目录执行
node scripts/verify-city-suite.mjs module game --no-cache
node scripts/verify-city-car-runtime.mjs
node scripts/verify-city-car-rendered-collision.mjs
node scripts/verify-city-continuous-driving.mjs
node scripts/verify-city-continuous-driving.mjs --contact-cities
node scripts/verify-city-driving-entry.mjs --cities
node scripts/verify-city-driving-spawns.mjs
```

原生必须通过 `.app` bundle 构建后 `open` 验收，遵循仓库 AGENTS.md，不直接运行 menubar 裸二进制。合成/浏览器通过只说明对应范围，不能替代原生持续性能，也不能证明所有道路开放。

## 13. 完成定义与文档维护

本轮完成需要 S1–S5 全部有对应证据；代码通过但原生未测时，状态为“代码完成、原生验收待完成”。正式出生流程或图几何缺失时，正式驾驶继续拒绝，UAT 单独可用。

已有 `CITY_VEHICLE_RUNTIME_ARCHITECTURE_REVIEW.md` 保持历史评估性质；新状态链接到本 SPEC 与共享运行时笔记。修正旧笔记中“尚未共用相机核心”“宽度字段尚不存在”“候选完全未缩碰撞体”等与当前代码不符的描述时，应注明适用版本，不重写历史验收结果。

本次文档交付不修改 TypeScript、Rust、golden 或发布开关。现有桥头/道路几何问题按原任务跟踪，关闭它们需要最终几何下独立连续试跑证据。

## 14. 飞机与汽车的 UX/UI 复用

2026-10-18 补充审查。依据 `GameHud.tsx`、`DrivingHud.tsx`、`game.css`、`gameCopy.ts`、`useCityGame.ts`、`useCityDrivingUat.ts`、`KeyboardInput.ts`、`CityExperience.tsx` 与 `CityApp.tsx`。本节是设计契约，未实现新界面。

### 14.1 当前差异与风险

| 项目 | 飞机当前实现 | 汽车当前实现 | 判断 |
| --- | --- | --- | --- |
| HUD 布局 | 左上活动、右上遥测/声音、右下可收起提示；暂停/错误用独立覆盖面板 | 左下大卡片常驻，速度、说明、诊断、操作混排 | 复用飞机的分区布局，驾驶时缩小常驻 UI，避免遮挡近处道路 |
| 暂停/退出 | Esc 暂停/继续，按钮退出 | Space 暂停/继续，Esc 直接退出 | 切载具容易误退出；改为共同 Esc 规则，保留显式退出动作 |
| 声音 | 主音量、音效、BGM 面板 | 没有声音 UI，DrivingSfx 未接入城市链 | 共享声音面板和服务，按实际能力显示开关 |
| 操作提示 | 可收起，中英翻译和相机操作说明 | 中文硬编码、单行提示，相机环绕/缩放无说明 | 共用提示组件和国际化入口；键位内容由各载具提供 |
| 错误/恢复 | 准备、暂停、重试、比赛结果已有分层 | 原因与受阻状态混在 HUD，失效主要要求退出 | 共用通用状态面板，按能力提供恢复/重试，不把擦碰显示为致命错误 |
| 遥测 | 速度/高度、比赛进度和计时 | 速度、挡位、blocked | 共用外观和刷新节流，数据语义保持载具独立 |
| 诊断内容 | 正常 UI 不展示固体实现名称 | 常驻 UAT 说明与碰撞 coverage | UAT 状态保留明确标记；技术内容只在主动展开的诊断区显示 |

不能直接把 `GameHud` 改名后给汽车传一份假的 `GameSessionSnapshot`：其内部假定有飞机 controller、mission、best 和 profile。相同视觉不意味着共用比赛状态或成绩 schema。

### 14.2 复用边界与组件

从现有飞机 HUD 中提取以下共享呈现组件，不另做一套汽车设计系统：

- `GameHudShell`：左上活动区、右上遥测/声音区、右下帮助区、状态面板层与 UAT 标记插槽；定位相对 City 画布而非整个宿主窗口，不覆盖宿主导航。
- `GameSessionPanel`：准备、初始暂停、用户暂停、失焦暂停、长帧暂停、错误；动作由 capability 列表提供，包含明确 label、enabled 与 callback。
- `GameControlsHelp`：由声明式键位表产生收起提示与暂停页说明，两处内容同源；同时说明鼠标环绕、滚轮缩放和双击镜头复位。
- `GameSoundPanel`：主音量、音效、可选 BGM；使用共享音频会话的受控状态。无 BGM 能力时不展示空开关。
- `TelemetryChip`、`GameStatusNotice`：数值外观、单位、状态语义与低频更新基础；保持读屏与视觉可读性。

`FlightHud`（由现 GameHud 拆出）保留自由飞行/穿环、剩时、罚时、成绩和高度；`DrivingHud` 保留速度、挡位、受阻/恢复、诊断标记。未来游艇只增加它自己的遥测与操控映射，复用上述外壳。

组件接收窄的只读 view model 与动作，不直接引用 `ReturnType<typeof useCityDrivingUat>`、CityEngine、物理内核或存储端口。通用状态只描述 `preparing/paused/running/error`；比赛结果与倒计时通过专用活动内容接入，不硬塞成所有载具的必填属性。

沿用 `game.css` 与已有 `--city-*` tokens；汽车独立硬编码面板色、边距和 z-index 在迁移后移除。两种 HUD 在同一画布内共用 overlay 层级规则，不靠各自增大 z-index 竞争可见性。

### 14.3 建议驾驶布局

```text
┌ City 画布 ─────────────────────────────────────────┐
│ [自由驾驶] [UAT（仅诊断构建）]       [声音] [暂停]   │
│                                                     │
│                 道路与车体主要视野                  │
│                                                     │
│ [可恢复状态提示（出现时）]       [速度 km/h] [D/R/B/N]│
│                                      [操作提示 ▾]   │
└─────────────────────────────────────────────────────┘
```

共享的是信息区域和组件，允许各载具配置遥测位置：飞机速度/高度可保持右上，汽车速度/挡位可放右下；共同帮助区布局需自动避让。运行中不常驻大按钮卡片。暂停时显示同一外观的面板，包含原因、继续、可用的复位动作、操作说明与退出。

准备页有取消按钮；初始暂停的主动作显示“开始驾驶”，运行后暂停显示“继续”。正式汽车场景暂无安全复位能力接入前，不显示能点击却无效果的“复位/重新开始”。受阻不等于允许重置：复位须在当前世界通过既有恢复/出生校验。

UAT 标记在运行、暂停、错误状态始终可见；“出生点未确认”说明保留在首次准备/暂停说明中，后续可在诊断展开区阅读。coverage、原始 query reason 和版本信息只在诊断区，正常状态使用“前方有障碍”“道路支撑不足”“场景已更新，请重新进入”等可理解的文案。

### 14.4 键盘、焦点和暂停规则

共同交互目标：Esc 在运行中打开暂停面板；在普通暂停面板按 Esc 可继续；准备中 Esc 取消；错误面板 Esc 不得恢复无效世界。帮助/声音子面板打开时，第一次 Esc 只关闭子面板，保持暂停。退出使用面板或宿主工具栏明确动作，不把普通 Esc 当作离开车辆的快捷键。

这会改变现汽车 UAT 的 Esc 行为，属于显式 UX 迁移：同步修改 `useCityDrivingUat`、统一命令 router、帮助、HUD 文案和测试；不能只改按钮文字。飞机当前 Esc handler 未过滤 repeat，迁移时需保证一次按下只触发一次，不反复暂停/继续。

本轮保留汽车 Space 暂停的兼容别名，并由统一 router 处理一次；W 加速、S 制动后倒车、A/D 和方向键转向维持当前驾驶规则。若后续引入 Space 手刹，必须另行修改物理输入契约、帮助和版本，不能让 Space 同时制动与暂停。飞机上下方向键爬升/下降不能复制到汽车提示。

区分两个输入上下文：

1. **驾驶上下文**：焦点在 canvas，拦截用于驾驶的键并避免组合输入进入画布；失焦/隐藏清键并暂停，不自动恢复。只消费 App 能收到的事件，不承诺禁用操作系统输入法或系统快捷键。
2. **UI 上下文**：打开暂停/帮助/声音面板时先清驾驶输入并暂停，然后将焦点移到面板。Tab、方向键、Space/Enter 正常操作控件，事件不下传驾驶；关闭子面板仍保持暂停，用户显式继续后再聚焦 canvas。

现 `KeyboardInput.isTextEntryTarget` 将所有 INPUT/SELECT 都当文本输入并在 focusin 强制 blur，其中包括音量 range。这会妨碍共用飞机声音面板的键盘操作。迁移时将文本组合输入防护限于实际文本可编辑目标与驾驶上下文，允许 range、checkbox、button、select 在 UI 上下文接受焦点；不能为了禁止输入法而让 HUD 控件无法操作。

暂停面板使用正确 dialog 语义、可见焦点、限定面板内的 Tab 顺序；关闭后根据动作回到 canvas 或原入口按钮。仅设置 `role=dialog`、`autoFocus` 不算完成焦点管理。准备取消、错误重试和组件卸载不能将焦点留在已移除元素上。

### 14.5 遥测、国际化与可访问性

- 展示单位与物理单位分离。驾驶速度显示 `km/h = abs(speed) × METERS_PER_UNIT × 3.6`，比例尺从 `engine/worldScale.ts` 读取；按当前 1 单位=2米，13 世界单位/秒对应 93.6 km/h。不能直接乘 3.6，也不为了修改仪表改变物理速度。挡位独立显示方向，诊断区可保留有符号原始速度。
- 飞机高度/速度若增加 m、km/h 标签，也须经过同一单位转换；不能给现有未转换数值直接贴新单位。低频 React 更新维持最多 10Hz，镜头与车模不经 HUD 状态驱动。
- 共用 `gameCopy.ts` 的中英文路径及语言入口，新增汽车/通用状态文案，删除 DrivingHud 中硬编码中文。缺失 key 验证需防止英文界面静默回退中文。
- 状态变化用文字和颜色共同表达；正常擦碰不用 alert 每帧播报。速度/挡位提供可访问名称和当前读数，但不把 10Hz 遥测放进 live region；仅关键暂停、错误、恢复变化做低频播报。飞机现遥测容器 `aria-hidden=true` 需要提供等价可访问读数路径。
- 使用实际控件命中区至少 44×44 CSS px、可见 focus ring。当前飞机声音按钮 28px、面板按钮 36px 不能直接视为满足该交互目标；提取时统一修正。
- 窄窗、低高度窗口、宿主侧栏展开、中英文长文案都要有可滚动暂停面板、可重排遥测和帮助区。支持 reduced-motion；HUD 不增加常驻动画和闪烁反馈。

焦点建议经 `ui-ux-pro-max` 的 `keyboard focus modal` 本地检索核对；分区/收起信息的建议依据现有飞机实现和本次审查，相关渐进披露检索未找到可用匹配，不作为外部证据。

### 14.6 入口和宿主返回

两种载具复用准备中、忙碌/被占用、入口错误、退出恢复的视觉和交互规则。可以先保留飞机/汽车现有工具栏命令 ID，在共同入口组件中按注册能力展示载具与活动；正式汽车能力未 ready 时不能因 UI 复用而移除 UAT 开关。

任何活动期间只允许一个活动退出入口，不显示可直接启动另一载具的可用按钮；切换要显式先退出/释放当前租约再准备目标。面板关闭不等于取消后台准备，取消必须传播 AbortSignal。退出恢复原城市相机、标签、宿主控制及入口焦点，并只应用一次最新待更新投影。

不要复用飞机的“换路线”“罚时”“最佳成绩”“穿环倒计时”作为汽车自由驾驶功能。汽车将来有竞速活动时再接专用 Activity；飞机 profile 保持其格式，不保存汽车诊断路线。

### 14.7 实施和验收补充

本节并入 S4 的呈现服务批次；其中键盘上下文/命令分发需与 S1 的单租约同步，声音 UI 等待 §8 的实际通道能力。顺序为：先提取现飞机外壳并保持飞行行为 → 接汽车 view model 和提示 → 统一暂停键/焦点 → 接声音与恢复能力 → 清除旧汽车大卡片样式。

在 §12 基础上追加：

- 飞机/汽车运行、首次暂停、普通暂停、失焦、长帧、准备取消、世界失效均有对应 UI；汽车自由驾驶不出现飞机成绩或赛程组件。
- 长按 Esc 不反复切换；从声音滑条用方向键调音量时不转车/不爬升；Space 激活面板按钮不同时暂停/继续游戏。
- 鼠标与纯键盘均能完成进入→开始→暂停→调声音→关闭子面板→继续→退出；UI 焦点不会被 IME 防护抢回 canvas。应用失焦后的按键释放不会留下油门。
- 无音频、无 BGM、无安全复位、无正式出生点时按能力正确降级；UAT 标记和正式入口限制不丢失。
- 中英、窄窗、低高度、侧栏展开、reduced-motion、读屏状态播报；速度转换的边界/倒车/零速值正确。
- 浏览器与原生 `.app` 各走一次上述完整交互；不能只靠组件快照断言确认游戏输入与 HUD 不冲突。
