# A6：结构描述符、整城驾驶路面聚合、会话矩阵与宿主快照端口

日期：2026-10-15。接 [A5贴地记录](CITY_GROUND_SURFACE_TERRAIN_FIT_NOTES.md) 与 [A4区域记录](CITY_SURFACE_REGIONS_NOTES.md)。本轮完成A批次的剩余几何部分。**不认证任何道路可通行**：`geometricallyEligibleLength` 仍为0，跨层portal、固体碰撞（CollisionIndex）和正式开放图仍归B/C/D。

## 代码入口（相对UI src）

| 文件 | 作用 |
| --- | --- |
| `engine/surface/structureProfiles.ts` | 高架剖面常量与 `expresswayDeckHeights`（从 render/shared 移出，shared 原样re-export） |
| `engine/surface/structureCompiler.ts` | 纯描述符：`bridgeDeckParts`、`expresswayPieces`、`trussBars`/`trussBarPart`、`culDeSacDiscs`/`culDeSacTopCap`、`channelizedGeometry`/`flareTriangles`；`eulerMatrix`（XYZ/YZX/YXZ，与THREE同公式）、`boxPoint`/`boxTopFace`/`boxCorners` |
| `engine/systems/roadSystem.ts`（改） | 桥面/高架/桁架/尽端圆盘/渠化口改为消费描述符，自身只负责组实例矩阵 |
| `engine/surface/compileSurface.ts` | `compileCitySurface(layout)`：地面路面 + 喇叭口 + 分流岛 + 尽端圆盘 + 桥面 + 高架合成一份 `CompiledCitySurface`（geometryVersion 2），另输出静态障碍、桥头/匝道 `landings` 和计数；`landingConnectivity(编译结果, 区域)` 按区域规则给出桥头是否真正连通 |
| `engine/surface/terrainClip.ts`（扩） | `terrainFit(layout, lift)`（精确贴地判定，路面与喇叭口共用）、`conformMesh`（任意共享顶点网格的保形裁剪）、`earClip`、`convexHullOf` |
| `engine/surface/citySurfacePort.ts` | `CitySurfacePort`：按需编译、发布到SurfaceStore（本地SHA-256）、按revision读取；invalidate后旧捕获读不到，在途捕获返回stale |
| `engine/cityParts.ts` / `CityEngine.ts`（改） | 路面只编译一次，渲染与驾驶共用，并随静态城缓存保存；`parts.drivingSurfaceSource()` 返回**当前画出来的**静态城所用的布局与地面编译（静态缓存可能沿用旧布局对象）；`CityEngine.captureDrivingSurface(signal)`；applyModel / setSeed / dispose 时invalidate |

## 规则

- **渲染与驾驶同源**：几何只在描述符里算一次。驾驶取BOX实例的真实顶面（缩放 → Euler旋转 → 平移），不按 `deckHeights + 厚度` 猜；行车面横向收到护栏内侧（桥：width/2 − 0.3；高架：±4.95）。车道线和虚线0.025–0.05高，按路漆处理，不算台阶。
- **层**：
  - 地面路、喇叭口、尽端圆盘、分流岛都在 `ground` 层。
  - 桥面若在离两端3个单位以外不压任何不属于两端节点的地面车行面（即跨河），也放进 `ground` 层，两端叠置由alias规则判：接得上就同区域，接不上就是conflict/step，关闭——这就是同层落地。
  - 压着地面路的桥面（立交）用 `bridge:<id>` 层，每条高架用 `expressway:<i>` 层。**跨层portal未实现**，这些入口一律关闭。
- **渠化口**：喇叭口改为贴「渲染地形 + 0.035」并保形（原来按 `terrain.height` 真值取高，坡地上会与路面错开），平地和线性坡上与原几何一致。分流岛是 `island`，在区域里是curb孔洞，同时输出为棱柱障碍。
- **尽端圆盘**：顶面取自渲染器的倾斜圆柱顶盖（20段），比路面高0.10，在接缝容差内（alias比较加1e-6浮点余量，规则版本v2）。
- **静态障碍**（交CollisionIndex，本轮不参与碰撞）：桥护栏、桥墩、高架护栏、高架桥墩、桁架杆件（8角点），分流岛（棱柱）。地面路缘仍由人行道边界的curb语义表达，未输出为障碍盒。
- **扇面**：只有多边形相对扇心呈星形时才用扇形三角化；不是星形的（偏移1.2的转角人行道圆弧）改用耳切；自交的闭合渐变轮廓用其凸包。星形扇面的三角形与原来逐字节一致。

## 证据

- **渲染不变**：`fixtures/city-driving/structure-render-baseline.json` 记录了改动前（8ec8c11）十五城五个结构系统的实例矩阵、颜色和几何属性摘要；`verify-city-structure-surface --cities` 逐城逐系统字节对照，全部一致。道路标线守卫（含合成渠化场景）全部通过；合成场景补了 `extent`，因为喇叭口现在按渲染地形三角网取高，真实CityLayout都带这个字段。
- **变换精确**：pure Euler/BOX变换与THREE `Matrix4.compose` 在三种顺序下误差 ≤1e-9；尽端顶盖与THREE圆柱顶盖误差 ≤1e-6。
- **合成夹具**：
  - 平岸桥：两端连通，内核从西开到东；
  - 西岸低0.56：台阶，被挡在西桥头；
  - 立交：桥面单独成层，桥下路不受影响，没有隐式跨层；
  - 悬空端报no-ground，多点桥报unsupported；
  - 高架：单独成层，中段顶面9.1，匝道末端比路面高约0.26，护栏界±4.95；
  - 40°渠化T口：岛是curb；
  - 尽端圆盘：路宽以外可行驶，与道路同区域。
- **十五城规划布局**：
  - 所有编译片段的边界都是流形（修复前seed 7 tier 3有1个人行道扇面例外，现为0）；
  - 28座桥、56个桥头中，按区域规则只有**3个**与桥面连通。其余为deck-end-blocked 31、ground-blocked 15（桥对岸在渲染路网里没有路）、different-region 7；
  - **没有一座桥两端都连通**（A6时）——A7修复后见下节。
- **0/90/500会话 × 5种子的显示布局**（`verify-city-surface-sessions`）：
  - 每层精确贴地，所有片段边界是流形；
  - 地面路/路口片段之间高差冲突为0；
  - 299/299次直路同核试跑每tick独立复核合法；
  - 桥头连通0–1个。

## A7：桥面视觉修复（2026-10-16，经产品确认）

A6 的发现：原来的桥面是一块平板，顶面取两岸**原始**地形高度的较大值，而引道贴着渲染地形、带坡度；桥头路面要么戳出桥面，要么形成 0.1–1.1 的台阶，十五城没有一座桥两端都接得上。现修复如下：

- **斜板桥面**（`bridgeDeckProfile`）：每个落在道路上的端点，桥面顶高等于该处的渲染路面高（渲染地形 + 0.04），中间线性过渡；没有路的一端沿用已落地一端的高度，避免伸进水里；两端都没路时保持原平板。桥面按两端路面横坡的平均值做横向倾斜（BOX 不能扭转）。护栏、车道线和虚线立在桥面实际顶面上，桥墩顶跟随剖面，桁架弦杆随纵坡倾斜，悬索桥的塔、主缆、吊索和灯串都以同一剖面为底（无落地道路时保留原有的最低 0.3）。
- **区域规则 v3：桥面遮挡**：同层、被桥面盖住、且不高于桥面超过容差的地面片段，不算冲突、也不提供支撑（桥头扇面会伸进桥跨 1.5–2.3）；高出桥面超过容差的才判为高差冲突。桥面端边与地面的接缝照旧检查台阶。
- **渲染基线**：桥面所在的基础设施系统（15 城）和桁架（12 城）改为对照 `corrected` 段，并记录原因；路缘单独摘要，与改动前逐字节一致；高架、尽端、渠化口仍逐字节一致。地标基线（含悬索桥合成场景）与 golden 一致。

**结果（十五城规划布局）**：

- 56 个桥头中 37 个与桥面连通（修复前 3 个）；15 个属于对岸没有道路的断头桥；4 个仍不连通（different-region）。
- 两端都落在道路上的 13 座桥里，10 座两端连通（修复前 0 座），每座的桥跨本身都能被内核整段开过。
- 沿桥轴从引道开到对岸引道：7 座通过。另 3 座卡在桥头区，如实上报：
  - 1/2：出生区有一块局部冲突；
  - 7/3：对岸引道有转角，直线驾驶撞上路缘（桥跨已开过）；
  - 2026/3：桥尾前 1.4 处有一块局部冲突。
- 仍关闭的 2 座：7/1 两端横坡方向相反，单块 BOX 无法扭转；42/2 是一座很短的桥，紧挨一条陡升道路，戳出 0.74。

合成夹具：西岸低 0.6 的桥两端都连通，内核可以爬坡通过；两端横坡相反的桥保持关闭；断头桥远端在水上时桥面保持落地端高度。

后续可选：把桥面拆成多段 BOX 以支持扭转（可修复 7/1 这类）；守卫里的直线测试改为沿路线跟踪（7/3 这类本身不是几何问题）。

## 未完成（移交）

2026-10-16 后续实现同时包含 [任务1/2实施记录](CITY_DRIVING_STRUCTURE_HOST_PROGRESS.md) 的宿主冻结与诊断，以及 [B2记录](CITY_PORTALS_AND_COLLISION_NOTES.md) 的跨层 portal、匝道落地和固体碰撞。以上 A6/A7 段落保留为历史证据；其中「跨层未实现」「匝道端约0.26台阶」及旧矩阵数量不代表合并后的现状。几何版本以 `CITY_SURFACE_GEOMETRY_VERSION` 为准。

- 跨层 portal、CollisionIndex：B2 已实现区域层复核与共享内核消费；匝道端落到路面、匝道区加密采样，相关证据见 B2 记录。入口端边、二维重叠走廊与局部坡变的独立检查也已加入，几何连接仍不是正式道路开放。
- 新端口使用 `readWorld()` / `checkStructures()` 与 generation 校验，不再暴露可逃逸的原始 `compilation`。`captureDrivingWorld()` 显式冻结当前显示几何，租约释放后恢复显示；scene solids 与精确建筑网格的覆盖范围必须分别声明，不能把有结构碰撞等同于完整城市碰撞。
- SafeRecovery；正式开放图与审计仍待完成（B/C/D）。
- 宿主端口已接 CityEngine，GameRuntime/CarAdapter 与 `createCityCarSession` 已有冻结租约消费基础和合成生命周期验证；完整城市驾驶入口需具备声明范围内的障碍碰撞与正式开放条件，不能仅凭租约可读而启用。编译在主线程同步执行，Worker 是后续项。
- 含修复补丁（planPatch）的显示布局已加入宿主版本失效与道路修改矩阵，具体命令/覆盖见任务1/2实施记录；原生 bundle 性能与内存仍未测。
- 已存在的守卫失败（与本轮无关，在744f926上就失败）：`verify-city-culdesac-bulbs`（380会话布局 `culDeSacEnds` 为空）、`verify-city-scene-baseline`（场景图摘要不一致）。

## 2026-10-16：反向横坡桥面与门式高架支撑（geometryVersion 6）

上述 A7 的单块 BOX 限制已有后续修复：两岸横坡差较大时，桥面、护栏与标线共用短分段 BOX，逐段过渡横坡。seed 7/tier 1 的唯一东西连接桥，两端均连通；使用校准整车碰撞体和独立连续复核器，双向共 572 tick 通过。没有放宽轮面扭曲、碰撞或桥头高度容差，其他桥头故障仍需各自核验。

高架的墙式桥墩改为两根独立立柱与顶部横梁，渲染和碰撞使用同一组真实盒体。优先沿桥面移动支撑位置避开横穿道路，再扩大两柱间距；检查地面车道、路口肩部和相邻较低匝道，横梁保留 1.5 高净空。若有界搜索仍找不到空位，保留实体支撑供审计报告，不能靠省略碰撞放行。

`verify-city-expressway-piers.mjs --cities` 检查五种子 × 三等级全部 15 个布局、753 个桥墩盒体，没有发现桥墩占用可行驶路面；这是采样诊断，不能代替逐路开放审计。另用实际连续碰撞查询验证 8/12 宽的平行、垂直、斜向道路整车穿越，同时确认立柱仍阻止初始重叠。渲染基线保留旧记录，新增 `rollTransition` 和 `portalPiers` 记录有意的几何变化；路缘等其他渲染组保持原摘要。

`--scenes` 进一步按 CityParts 的真实 Miami 配置构建 0/90/500 会话 × 五种子的 15 个渲染场景：633 个桥墩盒体，路面占用诊断为零。完整结构回归的 28 座桥、14 个匝道连接通过相应检查；仍有一条直线引道路线碰路缘、一条匝道起点 footprint 失败，守卫如实报告，不作正式开放证据。

## 2026-10-16：道路几何后续验证

2026-10-16 地形精度修复（geometryVersion 8）：原 0 会话/seed 1 的 (158.7,429.1) 受岸边粗地形网格影响。早期浅岸填方原型虽能消除该点扭曲，但对桥头接缝有副作用，已撤回。当前改为实际地形精度 192→384，保留原始高度场和路网；实际 148,225 个地形顶点与高度源一致，旧故障点 32 个朝向及整车双向连续试跑通过，0.06 容差不变。最终方案已建立独立的 terrainResolution 基线记录，历史记录保留；15 个规划布局的路面/结构矩阵、15 个实际场景占路诊断、30 次连续内核试跑共 1800 tick 均通过。基线生成同时断言平坦夹具、路缘和回车圈渲染不变。地形顶点约四倍，原生性能留待 E 验收。

更细地形使一条长岸路的边界边数增加，暴露边界提取器在 AABB 拒绝前仍穷举所有边对的问题。现按边界最长 XZ 轴排序扫描，只访问主轴区间重叠的候选；每个候选仍计入原有 20 万上限，最大 4000 边与 10 万三角形上限不变。交叉/非流形/孔洞及预算负例保留，新增双轴 1202 边长条回归与远离网格的未引用顶点负例。

桥头纵横分块 BOX 原型曾改善静态连通，但外侧引道起点仍 excessive-slope，长桥在接缝前发生真实车底/底板接触。长桥在提交版本 7 也未通过同一连续复现。静态连通不代表可驾驶，不能删去底板碰撞或放宽坡度以放行。该原型已从活动代码撤回，实验补丁在 `/tmp/agent-city-bank-loft-prototype.patch`；下一步需处理桥头落点或引道工程几何。详见 [收尾检查表](CITY_DRIVING_COMPLETION_TRACKER.md)。

2026-10-16 后续修复（geometryVersion 7）：机场占路部件实际是堤道第一块桥面，现按地面道路高度采样抬升堤道剖面，底面保留 2 高净空；机场仍是装饰场景，不因此成为开放驾驶路线。区级地标检查渲染编译器的道路/人行道三角形，避免路口外扩填充区；新增真实街区中心候选，保留整面预留和 17 宽裙楼。桁架低位杆件在两岸各内退至多 8，避开桥头路口。全部碰撞体保留。

`verify-city-road-obstructions.mjs` 按真实 Miami 配置构建 15 场景并检查所有结构与场景 proxy，没有发现静态物体占路的采样见证；这不代替整车动态审计。500/780 会话布局仍各有四个区级地标，11/17 个 civic，全部选址义务通过。机场连续碰撞回归明确比较旧几何挡车与新几何允许通过。详细未完成项见 [收尾检查表](CITY_DRIVING_COMPLETION_TRACKER.md)。

## 命令

```sh
node scripts/verify-city-road-terrain.mjs                 # 实际地形一致性、扭曲点与双向整车连续验证
node scripts/verify-city-airport-clearance.mjs            # 旧净空反例与修复后的实际网格连续穿越
node scripts/verify-city-road-obstructions.mjs            # 所有结构及场景 proxy 的占路见证
node scripts/verify-city-bridge-roll-transition.mjs       # seed 7/1 双向整车连续复核
node scripts/verify-city-expressway-piers.mjs --cities    # 门式桥墩净空及十五城路面占用诊断
node scripts/verify-city-expressway-piers.mjs --scenes    # 真实 Miami 渲染场景的桥墩占路诊断
node scripts/verify-city-structure-surface.mjs            # 合成 + THREE对照 + 宿主端口
node scripts/verify-city-structure-surface.mjs --cities   # 十五城渲染字节对照、桥头连通、同核过桥
node scripts/verify-city-surface-sessions.mjs             # 0/90/500会话 × 5种子显示布局
```
