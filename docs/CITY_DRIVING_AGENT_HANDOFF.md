# 城市驾驶核心代码：Agent 接手指南

2026-10-17 运行时增量：飞机与汽车已接入同一 GameRuntime 实现、共同定步时钟/KeyboardInput 与宿主 CityEnvironment；完整 GameScenePort 与统一固体源仍待后续。详见 `CITY_SHARED_VEHICLE_RUNTIME_NOTES.md`。以下早期分工保留作历史，完成状态以收尾检查表为准。

日期：2026-10-15；分支 `codex/city-driving-car-model`。
先读 [架构设计](CITY_DRIVING_ARCHITECTURE_SPEC.md) 与 [产品 SPEC](CITY_GAME_VEHICLE_MODE_SPEC.md)，再运行本文验收命令。本次已有实现是基础契约与合成试跑内核，**不是城市通行认证器已完成**。

## 1. 已实现的核心

| 文件（相对 UI src） | 已落实的约束 |
| --- | --- |
| `engine/surface/types.ts` | 编译路面、三角面、边界、portal、来源、渲染 batch、编译诊断的 CPU 数据类型；未实现编译器 |
| `game/driving/DrivingKernel.ts` | 手动驾驶/试跑共同入口；不可变输出、非法状态/非预期平面瞬移拒绝；world/车辆/代码版本身份绑定 |
| `game/driving/vehicleFootprint.ts` | 模型尺寸派生的保守转向轮包络；旧 DrivingWorld 和 gate observer 共用 |
| `game/driving/audit/contracts.ts` | 有向门、路面/portal序列、waypoints、速度策略、manifest、版本key、pilot、独立验证器、结果契约 |
| `AuditIdentity.ts` | key 与 case 的规范比较、manifest 覆盖/排除/门/预算验证、用例深拷贝冻结；不是加密哈希生成器 |
| `GateAuditObserver.ts` | 独立 start/step 验证 + 有序、有向、整车通过出口门；错误层/宽度不算通过 |
| `DrivingRouteRunner.ts` | pilot 只能交按钮；同核固定步、有界无进展/全局用例时限、失败不算 blocked、不自动复位、取消/过期清覆盖 |
| `AuditScheduler.ts` | 可恢复分块、批次/总tick预算、yield、工厂核对整个case、完成前/投递前版本复核；取消/过期/超预算不返回可用成功结果 |
| `AuditReleasePolicy.ts` | 静态+所有mandatory动态证据同key匹配；缺失/重复/未通过证据关闭；必须含spawn-access、最终关闭边界复跑key |
| `game/runtime/FixedStepClock.ts` | 交互定步时钟，长帧暂停、后台不追赶、每帧最多5步；离线试跑不用屏幕帧率 |
| `game/runtime/GameScenePort.ts` | lease/载具适配器接口和有效玩法联合；未实现 CityEngine lease 或共同运行时 |

上述 audit 文件均在 `game/driving/audit/`。`dev/drivingPreview.ts` 已改用同一个 DrivingKernel，现有物理与操作语义保持。现有 `DrivingSimulation.ts` 暂作兼容叶子，不复制第二份物理算法。

## 2. 如何接入审计

1. 冻结 City 当前生效几何/障碍快照，由构建器生成真实内容身份；不要把 seed、sessionCount 或任意固定字符串当生产hash。
2. RoadAuditPlanner 构造完整 AuditManifest，生成全部 mandatory 用例/门/走廊/策略；排除必须显式给理由。`validateManifest()` 会拒绝空计划、漏规划单位和错误门。
3. 每个case创建自己的 RoutePilot、GateAuditObserver/独立验证器和 DrivingRouteRunner，禁止共用有状态 observer/pilot。只读 kernel/world 可在同一快照中共享。
4. 调用 `scheduleAudit(manifest, factory, options)`；浏览器由 adapter 提供让出事件循环的 `yieldControl`，不能只 `Promise.resolve()` 假装让出任务。每次 currentKey 读取实时身份，isCancelled 读取当前取消状态。
5. 只有 report.state=`complete` 且当前key仍匹配时，将静态证据与 report.results 送 `evaluateAuditRelease()`；结果还有 pending/blocked 时不能默认开放。
6. 将真正要开放的图和实际策略护栏编译为 finalBoundaryHash，重跑最终边界下用例。key.releaseBoundaryHash=null 的基础检查无法取得整体 ready。

contracts 是内部可信模块间协议，不是验证恶意插件的安全沙盒。RoadAuditPlanner/验证器/哈希构建器仍须正确实现，不能用“全passed”桩骗过上层。ReleasePolicy 不会自行证明输入的几何证据真实；必须通过已知坏路、坏控制器和坏模拟的负例验证这些生产者。

## 3. 当前实现限制（必须保留）

- DrivingKernel 仍包装原型动力学：速度当前按XZ位移积分、碰撞整步拒绝；并未实现坡度力、TOI/切线滑动。平面步长上限仅拦明显瞬移，不是完整碰撞正确性证明。坡度接入时同步更新速度量纲与kernel断言/版本。
- GateAuditObserver 的门 crossing 是有界单步线性插值；普通路面/孔洞/转弯 swept footprint、真实portal顺序、完整净空依赖必填 AuditWorldValidator，不可省略。更换速度/转向模型后需补极限旋转过门测试。
- 当前 observer 不支持计划停车窗口，plannedStop 始终为false；后续如增加停车策略，必须显式写进case/key和计时验证。
- 当前无生产 RoadSurfaceCompiler/SurfaceStore、RoadAuditPlanner、几何检查器、RoutePilot、真实城市validator、证据环形缓冲、Worker、本地审计UI。不会自动给现有城市标绿。
- KernelIdentity 由world构建者提供并由runner核对，框架不自行哈希world。最终key覆盖真实参数、障碍、版本和manifest的责任属于唯一快照构建器；dev页与测试的字符串身份仅限合成夹具。
- ReleasePolicy 是整体资格判定，不生成 ReleasedDrivingGraph/策略护栏，也不代替关闭后可达性和最小可玩长度检查；开放图Agent必须在上层加这些门槛。
- 类型层 readonly 不会冻结 TypedArray 的底层字节；SurfaceStore 仍要负责所有权。没有新存档、DB访问或MCP面。

## 4. Agent 工作包与文件所有权

先让各Agent读相同契约并反馈不兼容点，由集成人统一改 contracts/key，禁止各自建一套重名协议。并行工作需要共享这批未提交代码，或先由协调者提交后再创建worktree；新worktree不会自动包含当前未提交文件。

### Agent A：路面编译（可先启动）

任务：提取 `engine/surface/groundRoadCompiler.ts`、`terrainSampling.ts`、`structureCompiler.ts`、`compileSurface.ts`，实现 SurfaceStore 与内容身份；改 roadSurfaceSystem/roadSystem 为消费共享数据。按现有矩阵得到高架顶面、保留实际显示剪枝与修复，禁止用中心线补造表面。对照旧渲染几何，路口/尽端/渠化岛/桥坡均有分类。

独占：`engine/surface/`（types.ts由集成人维护）、相关road/terrain渲染包装、surface专项测试。交付：15城市夹具+专项结构报告，固定生成器版本，旧/新可视几何对照。不要改game runtime或车辆物理。

### Agent B：世界查询、静态审计与恢复（依赖A，可先做合成夹具）

任务：实现 SurfaceIndex/Query、CollisionIndex、完整footprint覆盖、显式portal转换、SafeRecovery、RoadPassabilityAudit；实现AuditWorldValidator并接GateAuditObserver。区分真正几何阻塞证据与路径搜索未找到，后者inconclusive。真实障碍看垂直区间，不能把桥墩仅分配到一个高度层。

独占：`game/driving/` 查询/索引/恢复模块、`audit/RoadPassabilityAudit.ts`、对应负例。交付：桥上桥下、窄口、孔洞、单转向阻塞、出生堵塞与断接证据；不能改GateAuditObserver宣布成功的条件绕过失败。

### Agent C：连续碰撞与坡度动力学（可和A并行用合成世界）

任务：实现DrivingCollision TOI/法线/有界滑动与预测支撑；升级DrivingSimulation和Kernel使用实际路面速度/路程，保留兼容入口。输入策略、wheelDistance、physics/collision/query版本必须同批校准。几何world接口变化先向集成人提案。

独占：`DrivingSimulation.ts`、`driving/DrivingKernel.ts`、新增碰撞/参数模块、物理专项测试。交付：薄墙高速/旋转、双墙角、擦墙滑动、倒车脱困、上下坡/停车/倒车、30/60/120Hz一致。不得改审计状态把物理失败变成passed。

### Agent D：用例规划、自动控制与开放图（依赖A/B/C，先合成跑）

任务：实现RoadAuditPlanner、RoutePilot、AuditAttribution、ReleasedDrivingGraph和本地有界证据store；接现有runner/scheduler/release policy。覆盖双向、所有合法转向、桥坡及spawn端到端；冻结原始分母。policy final边界加入后复跑，不拿局部成功认证整城。

独占：`audit/RoadAuditPlanner.ts`、`RoutePilot.ts`、`AuditAttribution.ts`、`AuditEvidenceStore.ts`、开放图生成和审计夹具。核心contracts/runner/scheduler/release接口变更由集成人统一处理。交付：好路过、坏路定位、坏pilot是pending、坏simulation是pending、取消/版本/预算不假绿，报告明确条件与覆盖。

### Agent E：宿主共同运行时与本地展示（接口可先做，城市开放等A–D）

任务：在CityEngine实现token校验的gameSceneLease，抽共同GameRuntime，兼容FlightAdapter再接CarAdapter；统一输入/相机/hook与冻结投影。审计任务只拿只读快照，不抢相机；失败回放用户主动打开才取得lease。低频HUD与文字+颜色覆盖图遵守本地数据边界。

独占：`game/runtime/`（FixedStepClock可复用）、CityEngine门面、useCityGame/GameHud及驾驶UI。交付：飞机既有测试不回退、准备取消/失败清理、迟到结果、context lost退出、20次进退、最终原生bundle UAT。不要新建renderer/rAF、Rust数据协议或改飞机profile。

## 5. 合并与验收命令

本轮已运行：

```sh
node scripts/verify-city-driving-architecture.mjs
node scripts/verify-city-driving.mjs
node scripts/verify-city-car-model.mjs
npm --prefix apps/agent-city/ui run typecheck
npm --prefix apps/agent-city/ui run build
```

浏览器验收需先启动Vite（端口以实际输出为准）：

```sh
npm --prefix apps/agent-city/ui run dev -- --port 5179 --strictPort
node scripts/verify-city-driving-browser.mjs http://127.0.0.1:5179
```

architecture测试覆盖：同核逐tick终态、不同调度批一致、整车有向门/错误层、非法起点、无进展/计划停车全局预算、NaN/瞬移防线、重复或缺失证据、无见证不判阻塞、缺最终边界复跑、key与kernel不匹配、取消/过期/迟到成功及交互时钟。它不证明真实城市已通畅。

合并顺序：共享契约 → A → B/C → D → E → 产品SPEC原生/性能验收。所有Agent保留现有门槛；未完成或缺证据必须显式降级，不能补无条件通过桩。不要运行rustfmt；不为本轮纯TS工作改Rust或golden。

## 6. A1增量交付（2026-10-15）

普通道路与地形采样已从渲染system提取到 `engine/surface/groundRoadCompiler.ts`、`terrainSampling.ts`，renderer已消费同源计算，旧API继续可用。Agent A无需重新搬移这部分。优先接续边界/岛排除、桥高架顶面和SurfaceStore；当前返回的只是geometry-only，不能作为正式SurfacePatch/Portal或通行证明。

基线、接口、十五规划布局与剩余范围见 [CITY_GROUND_SURFACE_EXTRACTION_NOTES.md](CITY_GROUND_SURFACE_EXTRACTION_NOTES.md)。新增必跑 `node scripts/verify-city-ground-surface.mjs --cities`；不要更新基线来掩盖几何变化。

## 7. A2增量交付（2026-10-15）

已增加单片段meshBoundaries、buildGroundSurfaceSnapshot、SurfaceStore与本地SHA256。闭环/孔洞、几何错误/预算、复制所有权、版本/并发失效均有测试。它们不生成跨片段union或portal，eligibleLength仍为0；Store也尚未接CityEngine。Agent A/B应优先诊断原几何中的unresolved片段，再做union/岛排除/结构连接。

## 8. A3增量交付（2026-10-15）

2026-10-16：结构与宿主后续实施进度见 [任务1/2实施记录](CITY_DRIVING_STRUCTURE_HOST_PROGRESS.md)。宿主capture现提供readWorld与checkStructures，worldRevision含结构实体；完整建筑/地标障碍及合法图尚未纳入，不能用作正式审计base hash。

接缝后续：landings带实际端边与patchId；checkLandings对整个端边做精确有理数区间切分，返回覆盖/高度/坡变证据和连续宽度区间。候选区间不自动生成portal。实际CityEngine浏览器守卫已核对初始/修复后道路mesh与快照buffer一致，含缓存复用和hash期间换seed/销毁失效。

`engine/surface/SurfaceIndex.ts` 提供有界XZ三角候选索引和显式layerId的点采样。构建会复制patch缓冲区，限制三角数、桶数、总索引项、单三角跨格数；查询在同一patch共边按稳定ID取样，跨patch重叠明确返回ambiguous，超候选预算返回budget。它不做整车footprint、portal穿越、固体碰撞或可行性认证，也未接入CityEngine/Store生命周期。

后续B工作包可在此候选层上增加跨三角的连续运动验证、坡度/台阶阈值和全footprint覆盖；必须先完成普通路面union及岛/路缘语义，再允许任何点采样结果参与正式开放图。

见 [CITY_SURFACE_STORE_NOTES.md](CITY_SURFACE_STORE_NOTES.md)。Store revision只代表路面，禁止直接当含全部障碍的baseSnapshotHash。新增必跑 `node scripts/verify-city-surface-store.mjs --cities`。

## 9. A4/B1增量交付（2026-10-15）

- **跨片段合并**：`engine/surface/surfaceRegions.ts` 把同layer、叠置高差 ≤0.1（按精确叠置顶点判定）的车行片段合成区域，有唯一点分类器 `classify`。高差冲突的叠置区、边界未解决的片段、跨区域叠置都判不可行驶。
- **路缘/岛语义**：区域边界在线段交点处切分，按两侧分类给标签：`curb`（人行道或岛）、`closed`（无路面、未解决、跨区域）、`step`（同区域内台阶）。岛是区域里的curb孔洞；边界未解决的岛按全部三角边保守扣除。
- **整车覆盖/连续运动**：`game/driving/surfaceFootprint.ts` 的 `footprintSupport` 和 `validateMotion` 负责（侧向余量0.2；细分扫掠凸包按旋转弦高膨胀）。`SurfaceDrivingWorld.ts` 提供 `SurfaceDrivingEnvironment`（现有kernel可直接用，整步拒绝）和独立的 `SurfaceWorldValidator`（kernel放过非法运动时判 `simulation-invalid`）。
- **SurfaceIndex修正**：法线分量错位已修，平路法线原先是水平的；单三角按真实触及格计预算，seed 42 tier 2 的长斜路因此不再构建失败。

规则、锁定数值、十五城证据与限制见 [CITY_SURFACE_REGIONS_NOTES.md](CITY_SURFACE_REGIONS_NOTES.md)。新增必跑：`node scripts/verify-city-surface-regions.mjs [--cities]`、`node scripts/verify-city-driving-surface.mjs [--cities]`。

接续优先级：Agent A 修路口扇面坡地细分与急弯带子自折叠（十五城报告中的conflicts/excluded可直接定位），再产出桥/高架顶面与渠化岛；Agent B 实现CollisionIndex并接入 `validateMotion`，再做portal与SafeRecovery；Agent C 用同一区域边界做TOI/滑动以替换整步拒绝。不得为让城市变绿而放宽aliasTolerance、余量或把closed改成curb。

## 10. A5增量交付（2026-10-15）

编译器缺陷已修复：`groundRoadCompiler.ts` 改为精确贴地判定，不贴地的条带/扇区按渲染地形三角网裁成凸片（`engine/surface/terrainClip.ts`，规范交点保证无T形接点）；带子不再沿线插行，必要时收窄斜接，凹条带改用过凹角的对角线，闭合环线首尾斜接焊接。

- 十五城：贴地偏差 ≤0.019（修复前0.33）；车行片段边界全部是流形；顶点数基本持平。
- 驾驶层：高差冲突0、排除片段0，600/600直路试跑通过。
- 基线：七个平地夹具仍与重构前逐字节一致；closed-loop、wavy-tee与十五城对照 `corrected` 段。这是**有意的几何变更**，不要再改回重构前基线。

见 [CITY_GROUND_SURFACE_TERRAIN_FIT_NOTES.md](CITY_GROUND_SURFACE_TERRAIN_FIT_NOTES.md)。Agent A剩余：桥/高架顶面（structureCompiler + compileSurface聚合 + roadSystem消费）、渠化岛、尽端铺面、portal、0/90/500会话矩阵、SurfaceStore接CityEngine；另有seed 7 tier 3一个人行道转角扇面自重叠（修改前就存在，不影响支撑）。

## 11. A6增量交付（2026-10-15）——A批次几何部分完成

- 桥面、高架、桁架、尽端圆盘、渠化口改为纯描述符（`engine/surface/structureCompiler.ts`），roadSystem只消费描述符；十五城结构渲染与改动前逐字节一致（有基线守卫）。
- `compileCitySurface` 聚合整城驾驶路面：地面 + 喇叭口（改为贴渲染地形）+ 分流岛（curb孔洞）+ 尽端圆盘 + 桥面（跨河在 `ground` 层、立交单独成层）+ 高架（每条单独成层）；同时输出静态障碍和桥头诊断，`landingConnectivity` 按区域规则判定桥头是否连通。
- 不是星形的扇面改用耳切，自交的渐变轮廓用凸包：十五城与15个显示布局的所有片段边界都是流形。
- 0/90/500会话 × 5种子的显示布局守卫：`verify-city-surface-sessions`。
- `CitySurfacePort`：CityEngine的 `captureDrivingSurface()` 返回当前画出来那座城的快照（SHA-256 revision），布局一变即失效。

**关键发现**：桥面是平板（取两岸原始地形高的较大值），引道却有坡。十五城里没有一座桥两端都连通，桥梁全部关闭并上报。开放桥梁需要另行做视觉修复（斜板或匝道），需产品确认。详见 [CITY_STRUCTURE_SURFACE_NOTES.md](CITY_STRUCTURE_SURFACE_NOTES.md)。

A批次剩余项不再是几何问题：跨层portal（立交、高架匝道）与B/C/D的碰撞、恢复、开放图一起做。新增必跑：`verify-city-structure-surface [--cities]`、`verify-city-surface-sessions`。

## 12. A7增量交付（2026-10-16）——桥面视觉修复

经产品确认，桥面从平板改为两端贴合桥头路面的斜板，并带两端横坡的平均倾斜；护栏、桥墩、桁架、悬索桥都随同一剖面变化。区域规则 v3：桥面遮挡其下方更低的地面。

十五城：37/56 个桥头连通（修复前 3 个），10 座桥两端连通且桥跨都能整段开过（修复前 0 座），7 座可从引道开到对岸引道。剩余未通的逐条记录在 [CITY_STRUCTURE_SURFACE_NOTES.md](CITY_STRUCTURE_SURFACE_NOTES.md) 的 A7 一节。路缘、高架、尽端、渠化口的渲染仍逐字节不变。

正式开放仍需 D 的审计与开放图，本轮不自动开放任何桥。

## 13. B2增量交付（2026-10-16）——跨层 portal 与固体碰撞

① **跨层 portal**：
- 几何修复：高架匝道端落到渲染路面上（原来 22 个匝道端都高出路面 0.24–0.26）；匝道区按 ≤10 的小段采样 ease 剖面（原来 137–280 长的单段支线是一整块直坡板，从侧面插进环线桥面）。
- 编译器给 portal 候选，区域规则 v4 复核后并区域；整车规则 v2 按高度选层，只看车所在那层的边界。
- 十五城：14/14 个匝道端连通，13/14 从地面开上环线桥面，14/14 从桥面开回地面。
- 立交只有合成夹具（十五城没有立交）。

② **固体碰撞**：`CollisionIndex`。
- 固体为凸多面体，车身是有向盒，两者用 SAT 精确判交。
- 固体来源：结构描述符（含桥面板与高架桥面板，用于判净空），以及 capture 时冻结的渲染建筑和地标。
- 环境层与验证器都接入。
- 15 个渲染场景：立在路上的固体只上报不打开，包括高架桥墩、机场部件、区级地标、桁架弦杆，每场景最多 7 个。

详见 [CITY_PORTALS_AND_COLLISION_NOTES.md](CITY_PORTALS_AND_COLLISION_NOTES.md)。正式开放仍需 D 的审计与开放图。

## 14. B3增量交付（2026-10-16）——逐路通行审计与安全恢复

分工：B（审计、恢复）由主线维护；C（接触推进、有界滑动、路面距离：`DrivingSimulation.ts` / `DrivingKernel.ts` / `CollisionIndex.ts`）由另一方负责。本轮只消费 C 的现有接口。

- `RoadPassabilityAudit`：每条路线返回以下三种之一，并绑定 world revision 与 AuditKey：
  - 通过：动态试跑通过，且固体覆盖完整；
  - 挡住：必带见证（拓扑不连通，或走廊直段截面的精确证明）；
  - 无结论：其余一切，带原因。
  它直接接宿主 capture（`auditCapture`），产出的 `StaticUnitEvidence` 可交给发布策略。
- `SafeRecovery`：有界、确定性的最近合法位姿搜索。整车经独立验证，不跨区域，按同一 revision 提交。
- 场景代理和凸包外包的固体永远不当「挡住」的证据；只有规划、没有场景的 capture 永远不给「通过」。

详见 [CITY_PASSABILITY_AND_RECOVERY_NOTES.md](CITY_PASSABILITY_AND_RECOVERY_NOTES.md)。这些结果不能替代 D 的完整用例覆盖，也不能据此开放整张路网。

## 15. B4（2026-10-16）——审计改用 C 的连续内核

- **身份与轨迹**：key 按 C 的版本校准，`vehicleConfigHash` 覆盖碰撞体与求解参数。门和走廊按实际分段轨迹判定；`GateAuditObserver` 没有分段轨迹时行为不变（兼容）。
- **出生恢复**：起点与固体重叠时先用 SafeRecovery 恢复，再作为新用例运行。
- **性能**：动态试跑里对世界是否最新的检查做了节流，每 tick 从约 103 ms 降到约 1.1 ms。
- **十五城结果**：722 条有向路线，716 条通过（与旧环境是同一批）、0 条挡住、6 条无结论。
- **交给 C 的问题**：贴墙滑动时碰撞查询预算耗尽（`continuous-collision:budget`），有合成复现和真实城市复现。
- **交给宿主端口负责方的问题**：正式驾驶入口每步调用的 `isCurrent()` 开销很大。

B 批次（审计、恢复）到此完成。下一步是 D 的用例规划器，以及更强的驾驶员。详见 [CITY_PASSABILITY_AND_RECOVERY_NOTES.md](CITY_PASSABILITY_AND_RECOVERY_NOTES.md)。

## 16. P1 正式出生点交接（2026-10-20）

正式入口必须消费 `PublishedDrivingGraph` 和由 `validateSpawnSpec` 签发的 `VerifiedSpawnCredential`。`DrivingSpawnConfirmationController` 的最小接线契约为：`publishedGraph: PublishedDrivingGraph | null`、宿主冻结 `capture`、与其 revision / 发布边界 / 车辆配置完全一致的 `SpawnConfirmationBinding`、`useCityDriving` 返回的确认状态与 actions，以及正式入口 `onEnter`。controller 仅从已发布图导出候选；校验时把候选交给完整 `validateSpawnSpec`，只把验证器签发的凭证写入 `SpawnConfirmationStore`。缺图、过期租约、binding 不匹配或验证失败均不可确认；同一新鲜凭证的重复确认幂等。卸载时失效 Store。验证异常会撤销候选并显式报告 `spawn-validation-failed`。

**2026-10-21 进展：完整支撑面的严格审计图生产者已接入，正式驾驶准入仍未接通。** `useRoadAudit` 的第一阶段仍使用 `releaseBoundaryHash: null`；仅全部 mandatory 路线通过且没有排除项时，才编译 `FinalSurfaceBoundary`，对同一冻结计划执行第二阶段复跑，并在宿主深度新鲜度检查通过后绑定发布图。此生产者只支持未裁剪的完整支撑面：实际 region/layer 边界与严格整车覆盖、连续运动验证构成边界约束，mounting 禁用；不新增虚拟围栏，不允许用通过子集关闭失败道路。边界对象必须由同一 world 签发，证据超预算则拒绝发布。详见 [发布与历史集成说明](CITY_ROAD_AUDIT_RELEASE_INTEGRATION.md)。

当前的发布图仅证明该严格审计策略下的已测计划，不授予游戏准入。游玩模式的可越路缘、边界滑动与之不同，不能继承证明。选择性封路仍缺少实际 fence 编译及正式 runtime 的同源接线；普通 passability 结果、planner corridor、任意非空 hash 和历史记录都不能代替边界证据。正式确认及正式入口仍须等待与实际运行策略一致的边界、凭证及租约集成验收。

接续实现应先提供版本化 fence 编译/哈希与单一数据源，再把它接到正式 runtime 和冻结 replay world；对 manifest/key 绑定的完整 mandatory plan 执行边界重放，最后由现有 verifier 校验并发布图。至少验收：无 hash 或 replay 不完整时拒绝发布；任一 fence/runtime/revision/key 不匹配时拒绝发布或确认；修改场景后旧租约、候选、凭证和已确认状态全部失效；成功凭证只可在同一 binding 下进入正式入口；取消/卸载释放 capture 并失效确认；重复确认不改变结果；validator 返回拒绝或抛异常时不留下可用凭证；free-drive 与诊断入口不创建正式确认状态。

**联调生命周期注意**：`useRoadAudit` 持有 capture lease 到结果消费结束，取消、禁用和卸载应释放它；新一轮 audit 开始前也必须释放上一轮已完成而保留的 capture。完成态若继续暴露 capture，仍须检测 revision/scene 失效，不能依赖 React 再次渲染才发现租约过期。正式确认 controller 卸载会调用 `invalidateSpawn`；capture 的释放仍归 audit hook 所有。当前 `useCityDrivingPlay` 显式设置 `confirmationEnabled: false`，其 handler 与 `enter` 不能作为正式确认接线；集成需由 `useCityDriving` 的正式配置提供 enabled actions、binding 和入口。不要为绕过该边界而改用本地支撑检查或新建同名发布协议。

