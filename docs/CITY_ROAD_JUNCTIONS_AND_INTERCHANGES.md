# City 路口、环岛与立交：代码分析

更新时间：2026-10-20。代码基准：分支 `codex/city-driving-car-model` 的 `09558221`（生成器版本 5、路面几何版本 13、通行审计版本 4）。初稿写于 `claude/city-visual-style-analysis-a9ddd6` 合并 `origin/dev`（`be220c39`）之后。

本文按**当前代码**说明四项路网能力的实现：高架出口接驳（闸道）、湾岸主干道过桥头、路口环岛、高架立交匝道。规格层面的路口类型表见 [CITY_ROAD_NETWORK_SPEC.md](CITY_ROAD_NETWORK_SPEC.md) §5；开发过程与验证记录见 [CITY_VISUAL_STYLE_TAKEOVER.md](CITY_VISUAL_STYLE_TAKEOVER.md)。

---

## 1. 背景与结论

用户在 2026-10-15 指出了三类问题，这四项能力就是针对它们做的：

| 用户反馈 | 根因（代码分析结论） | 对应能力 |
|---|---|---|
| 「高架桥和闸道没有转弯衔接吗」 | 环线高架在海湾处断开后，断头用「离端点最近的干道点」接回路网，弦的方向与环线切线无约束，形成 150°–180° 尖刺或斜插长弦（基线 11 条高架里 10 条有） | §3.1 高架出口接驳 |
| 「这个主干道为什么不直接连起来」 | 河岸路逐点判定「28 内有主干道就不铺」，垂直穿过岸线的桥头引道也被当成平行主干道，每个桥头断 80–90，再由街网在内陆绕 V 字 | §3.2 湾岸路过桥头 |
| 「之前设计的几种交叉路口，包括环岛，没有用上吗」 | 规格 §5 的「度 ≥5 或 ≥3 主干交汇 → 环岛」从未实现；唯一的交叉口小环 `mini-roundabout` 只服务锐角三岔修复，28 座城 11 次尝试 0 次建成 | §3.3 路口环岛 |
| 「闸道应该是高架和普通道路交接转化的地方」 | 规格 §5「立交：上下穿；可选匝道（后续）」未实现，高架跨越干道时没有任何上下联系 | §3.4 立交匝道 |

当前状态（seed 1927/97/7/42，档 5 实测）：高架单点最大转角 14°–67°（无尖刺）；平交未成路口 0；每座城主干环岛 9–13 个、支路小环 3–11 个；有高架的城市匝道 0–4 条。湾岸路在桥头处已能贯通，但仍有少量断口（见 §7）。

---

## 2. 在规划流水线中的位置

`buildPlan`（[cityPlan.ts](../apps/agent-city/ui/src/engine/cityPlan.ts)）中与本文相关的工序，按执行顺序：

| 顺序 | 工序 | 位置 | 说明 |
|---|---|---|---|
| 1 | 骨架：主干放射、环线高架、**高架出口接驳** | [cityPlan.ts:341](../apps/agent-city/ui/src/engine/cityPlan.ts:341) → [skeleton.ts:301](../apps/agent-city/ui/src/engine/planner/skeleton.ts:301) | 出口在这里定形，后续所有工序看到的都是平滑接驳后的高架折线 |
| 2 | 环岛滨海路 + **河岸路过桥头** | [cityPlan.ts:363](../apps/agent-city/ui/src/engine/cityPlan.ts:363) → [coastalRingRoad.ts:78](../apps/agent-city/ui/src/engine/planner/coastalRingRoad.ts:78) | 岸路与引道的交叉在此拆出 T 口 |
| 2a | **高架落地端低段预留**（版本 5） | [cityPlan.ts:387](../apps/agent-city/ui/src/engine/cityPlan.ts:387) → [rampLowZone.ts](../apps/agent-city/ui/src/engine/planner/rampLowZone.ts) | 并进连接器的 `reservations`，之后加的地面路绕开低段（§3.1） |
| 3 | 街网、缝合、连通、尽端环路…… | — | 本文不涉及 |
| 4 | 桥头落地环（版本 5 起钉住高架出口节点） | [cityPlan.ts:653](../apps/agent-city/ui/src/engine/cityPlan.ts:653) → [landing.ts](../apps/agent-city/ui/src/engine/planner/landing.ts) | 既有能力；环岛要避开它（`bridgeClear`） |
| 5 | **路口环岛** | [cityPlan.ts:672](../apps/agent-city/ui/src/engine/cityPlan.ts:672) → [junctionRings.ts](../apps/agent-city/ui/src/engine/planner/junctionRings.ts) | 在 solve 之前：solve 的修复与校验看到的是带环的路网 |
| 6 | solve（修复循环） | [cityPlan.ts:686](../apps/agent-city/ui/src/engine/cityPlan.ts:686) | — |
| 7 | **立交匝道选址** | [cityPlan.ts:691](../apps/agent-city/ui/src/engine/cityPlan.ts:691) → [highwayRamps.ts](../apps/agent-city/ui/src/engine/planner/highwayRamps.ts) | 在 solve 之后：落地的干道已经定型，不会被修复删掉 |
| 8 | 派生收尾：路面切块、生成地块 | [cityPlan.ts:717](../apps/agent-city/ui/src/engine/cityPlan.ts:717) | 环岛中心岛作为预留地（不切地块），匝道并入 `highways` 避让走廊 |

关键设计点：**所有形状都在地块生成之前确定**。地块离高架桥面的实际余量只有 1.1–1.7 单位（实测），任何在渲染期改动高架形状的做法都会压到地块——曾试过渲染期用贝塞尔曲线修出口，压到 51 个地块，已放弃。

数据通路：`createCityPlan` 输出 `junctionRings`、`highwayRamps` → worker 快照（[planningProtocol.ts](../apps/agent-city/ui/src/engine/planningWorker/planningProtocol.ts) 把两者列入必需集合）→ `layoutCity` 展开到 `CityLayout`（[cityLayout.ts:105](../apps/agent-city/ui/src/engine/cityLayout.ts:105)）→ `roadSystem` 渲染。

---

## 3. 组件分析

### 3.1 高架出口接驳（闸道）——`planner/skeleton.ts`

环线高架在出海、进山或开湾的海湾处断开后，每段的两个断头要接回地面干道。这一段就是「高架 ↔ 普通道路」的过渡（闸道）。

**选出口**（`pickExit`，[skeleton.ts:301](../apps/agent-city/ui/src/engine/planner/skeleton.ts:301) 起）：

1. 对每条非桥地面路，取离断头最近的点作为候选出口；
2. 过滤：离市政广场核心 ≥110；接驳弦不切近广场（`chordClearsDisc`，净空 69）；不压公共用地与地标（桥面半宽 5.25 + 半径 + 1，与 `verify-react-city-geography` 同口径）；弦可走（逐 4 单位全可建）；
3. **朝前约束**：弦与环线切线夹角 ≤ `EXIT_CONE = 60°`（[skeleton.ts:291](../apps/agent-city/ui/src/engine/planner/skeleton.ts:291)）；
4. 打分 `距离 × (1 + 3·(1 − cos 偏角))`，偏好更直的出口，避免贴着锥边的近出口形成明显折角；
5. 前方没有合格候选时，把环线末端往回缩一个点再找，最多 8 次；仍找不到就丢弃这段高架。

**接驳形状**：三次贝塞尔，起点切线 = 环线切线，终点切线 = 干道方向（取与行进同向的一侧），按 8 单位采样。控制柄依次试 0.45 → 0.3 → 0.18，任一段不可走、切近广场或压用地就换更贴近弦的曲线，最后退回直线弦（仍满足朝前）。

**效果**（14 种子 × 2 档）：单点转角 >120° 的尖刺 32 → 0；首尾弦 >150 的长弦 23 → 8；剩余最大转角约 66°，出现在出口曲线被迫退回直线的情况。

**落地端低段预留区**（版本 5，[rampLowZone.ts](../apps/agent-city/ui/src/engine/planner/rampLowZone.ts)）：开放高架两端按 `EXPRESSWAY_RAMP`（90）的 ease 剖面落地，落地后约 50 内桥面底离路面不到车辆净空。骨架阶段这段只压着自己的宿主路，但之后的扇区街网、缝合、入口路不知道它是低的——0/42 的高架 0 两端各被 2–3 条 5 宽支路压着，桥面板就是车道上的固体。`rampLowZoneDiscs` 对每条非闭合 `ringRun` 的两端，从落地端起 6 到 48、每 4 放一个半径 5.25（桥面半宽）的预留圆盘（`RAMP_LOW_ZONE`），在 [cityPlan.ts:387](../apps/agent-city/ui/src/engine/cityPlan.ts:387) 并进连接器的 `reservations`：连接器路线与 `commitFixedLink` 的地面段按它做用地净距，新地面路因此绕开低段，只能在高架够高处跨越。圆盘让开落地区（前 6）；骨架已提交的路（含宿主路）、用地与地块不受影响。

**出口节点钉住**（版本 5，[landing.ts](../apps/agent-city/ui/src/engine/planner/landing.ts)）：`buildLandingCircles` 新增 `pinned`，[cityPlan.ts:654](../apps/agent-city/ui/src/engine/cityPlan.ts:654) 传入全部 `ringRuns` 首尾点所在的路网节点。落地环方案只要删除这些节点、或删除与之相连的边，就放弃该方案（原因 `pinned-exit`）——0/42 的落地环曾删掉高架 `to` 端所在的路，出口离最近路中线 2.29，路缘穿过落地区。路口环岛（§3.3）沿用同一组出口节点作为固定节点。

### 3.2 湾岸主干道过桥头——`planner/coastalRingRoad.ts`

河岸路（开湾时即湾岸路）沿河道/海湾两岸、离水边 14，每 20 单位采样一点，可用点连成段，宽 12。

**只有平行主干道才阻断**（[coastalRingRoad.ts:78](../apps/agent-city/ui/src/engine/planner/coastalRingRoad.ts:78)）：`parallelArterialNear` 只在 28 范围内有与岸线夹角 <50° 的主干道（宽 ≥8）时拒绝该采样点。垂直穿过岸线的引道不再阻断。

**交叉处做 T 口**（[coastalRingRoad.ts:120](../apps/agent-city/ui/src/engine/planner/coastalRingRoad.ts:120)）：逐段检查岸路与既有道路的交叉——

- 穿过地面路：在交点插入节点，用 `commitNetworkPatch` 的拆边原语把被穿过的路拆成 T 口（属性继承）；交点离被穿路端点 <3 时直接用端点；
- 穿过桥面：不在桥面上平交，改为经过桥面落在陆地一侧的桥头节点；
- **锐角保护**：交点处岸路两条腿与已有各腿的夹角任一 <35°（`acuteJunctions` 约束是 30°，留 5° 余量）就在此断开，不硬接；
- 上一个岸路点离交点 <3 时先并入交点，否则 0.x 长的「腿」方向随机，角度判定无意义（曾因此误判锐角）；
- 拆边失败就断开。原则：**宁可断开，也不留无路口的平交**。

### 3.3 路口环岛——`planner/junctionRings.ts` + `connect.ts::runJunctionRing`

**两类环岛**（`JUNCTION_RING_CONFIG`）：

| 类型 | 触发条件 | 半径（单位） | 环道 | 稀疏化 |
|---|---|---|---|---|
| 主干环岛 major | 度 ≥5；或 ≥3 条宽 12 主干交汇；或四岔全为宽 ≥8 干道 | 18 → 16 → 14（36–28 m） | 宽 8 干道 | 主干环岛之间 ≥220 |
| 支路小环 minor | 三岔或十字，全部为宽 5 支路，且种子哈希 < 0.14 | 10（20 m） | 宽 5 支路 | 离任何环 ≥130 |

条件的由来（规划期实测，seed 97 档 5）：「≥3 条主干」在规划期几乎都出现在桥头（岸路 × 引道），通往桥头那条腿只有 8–12，放不下环；城内真正的大路口是四条宽 8 次干道的十字（大岛约 25 个）。曾试「四岔里 ≥3 条宽 ≥8」，把 T 口也算进来，大岛建出 53 个，太密；改为四岔全宽 ≥8 加 220 间距。支路小环半径不能小于 10：再小，环上相邻切点相距 <12，会触发近距路口约束。

**统一拒绝条件**（任一命中即保留原路口）：节点被固定（设施出入口、主锚点、高架出口端点）；离市政广场核心 <140（已有礼仪环岛）；与已建环间距不足；离桥端 <60；任一腿是桥或非 `ground-road` 结构。主干环岛先建，同类按节点 id 排序（确定性）。

**建环事务**（`runJunctionRing`，[connect.ts:863](../apps/agent-city/ui/src/engine/planner/connect.ts:863)）与旧的 `mini-roundabout` 同构，但不限三岔、不要求锐角：

1. 只接受 3–6 条腿，每条腿必须可按 5/8/12 宽精确重建（`roundaboutRebuildable`）且为两点直线（多点曲线腿拆掉重建会丢形状）；
2. 按半径档依次试：每条腿剩余段 ≥6；环点 = 各腿方向上的切点 + 按 ≤30° 细分的弧点（环看起来是圆而不是菱形），总段数 ≤ `maxSegments`；
3. 弧段逐条校验：弦长 ≥3、地面走廊（不过水/可建/坡度/避让用地）、不与其他路交叉；
4. **净距准入**：新增边与既有路用 `roadCandidateCrowding` 校验，与道路准入、最终 `crowdedArterials` 同源（主干环岛的对边弧段在小半径下会互相「拥挤」，因此 r=10 的主干环会被拒、落到下一档）；
5. 补丁 = 删掉全部整腿 + 加回「腿剩余段 + 全部弧段」，一次 `commitNetworkPatch` 事务提交；提交时在草稿上复核环上每个 ≥3 度路口相邻夹角 ≥30°；
6. 失败零副作用（版本、节点、边都不变）；成功后清掉孤立的环心节点。

**引用折线改写**（`rewriteRoutes`）：干道 trunk、岸路/滨海路、滨海大道段、车流回路里经过环心 V 的「前 → V → 后」改写为「前 → 进口切点 → 沿环按角度升序的弧点 → 出口切点 → 后」；以 V 为端点的折线改从切点起。若 V 前后都不是这个路口的腿（理论上不应发生），V 被丢弃，由下游引用校验报出。

**中心岛**：生成地块时环岛作为预留地，半径取到环道内缘；`buildJunctionIslands`（[roadSystem.ts:357](../apps/agent-city/ui/src/engine/systems/roadSystem.ts:357)）画草坪圆盘 + 浅色路缘，主干环岛中间三棵棕榈 + 一圈花坛，支路小环一棵棕榈。岛周围剩不到 3 条环段时不画（编辑器删环道、或展示裁剪隐藏了环道时）。

### 3.4 高架立交匝道——`planner/highwayRamps.ts`

环线高架是架空结构，**不在 `roadEdges` 里**。匝道同样不进路网，是规划层预留走廊；几何（2026-10-20 起）与环线高架同进结构编译器（`surface/structureCompiler.ts::highwayRampPieces`），渲染、驾驶路面与碰撞共用同一批板件：

- **驾驶面**：每块桥面板一个 `ramp:<i>:<seg>` 面片（kind `ramp`），挂在所属高架的层 `expressway:<h>` 上，按与高架相同的「带」规则拼缝（`compileSurface.ts::ribbonFaces`）。起点压在高架桥面上同高，同层叠置直接并为一个区域，分流不需要门户。
- **落地**：地面端登记为落地点 `ramp:<i>` / `to`（结构过渡审计 `structure:ramp:<i>:to:onto|off`），并按端部 3 单位 × 可驾驶半宽内的地面面片给门户候选。
- **碰撞**：护栏 `ramp-rail`、墩柱 `ramp-pier` 是实体；桥面板 `ramp-deck` 与高架桥面同一规则（`mountableHeight` 只允许越过坡度错台）。`ramp-rail`/`ramp-deck` 与高架同类角色一样不计入路面实体诊断与通行证据。
- **审计规划**：匝道常落在宿主路中段（宿主路未在出口处切分），地面侧沿宿主路走（`RoadAuditPlanner.ts::midEdgeApproach`，规划器版本 4），不再沿匝道方向直出越过路缘。

**选址**（`planHighwayRamps`）：

- 高架与宽 ≥8 地面路的每个交叉点，跨越角 ≥50°；
- 开放高架要求跨越点离两端 ≥ 匝道长度 110 + `endClear` 90，保证分流点在高架完全抬起的路段；
- 排序：宽路优先 → 更接近直角 → 路程（确定性）；沿高架间距 ≥400（闭合高架按环向距离），每条最多 2 处；
- 一处立交至少通过 2 条匝道才保留。

**菱形几何**（`buildDiamond`）：高架两侧 × 跨越点前后，共 4 条匝道。

- 落地点：干道与「离高架中线 `offset = 17` 的平行线」的交点，且**必须落在真实有限的干道路段上**（包括路口拆边后的共线相邻段），不接受只落在干道延长线上；
- 前 40% 路程：沿**实际高架折线**采样（不是局部切线外推，弯道上外推会离开桥面），横向 smoothstep 从 0 外移到 offset；
- 后 60%：沿 offset 平行线直走到落地点；
- 折线按「桥面端 → 地面端」排列。

`offset` 的取舍：13 时与高架桥面间隙只有约 8 m，俯视像高架多了两条侧车道，菱形读不出来；22 分得开，但撞街道的多（通过的匝道 18 → 7）；取 17（间隙约 16 m）。

**校验**（`rampClear`，逐条，不过就丢这一条）：全程可建；不压公共用地/地标（半径 + 匝道半宽 + 2）；**只在路程 65%–90% 的低段**检查与宿主之外地面路的净距——前段架在空中，跨过地面路没问题，末段本来就要落到干道 T 口。

**避让**：匝道折线与高架一起并入地块生成的 `highways`（[cityPlan.ts:709](../apps/agent-city/ui/src/engine/cityPlan.ts:709)），落在匝道上的公园树被清除。

### 3.5 渲染——`systems/roadSystem.ts`

- **高架护栏开口**（`surface/structureCompiler.ts::expresswayPieces`）：两类开口叠加——`rampRailRuns` 在高架两端贴近地面路的落地段开口（`dev`）；`mergeRuns` 在匝道前 40% 分流段与护栏相交的 6 单位片处开口（合流口）。高架几何在 `dev` 中被抽到 `structureCompiler`，与驾驶路面/碰撞共用；合流口逻辑在抽取和后来的合并中各丢过一次，现由 `verify-city-highway-ramps` 的护栏断言守住。
- **匝道高度**（`structureCompiler.ts::highwayRampRun`，`buildHighwayRamps` 只渲染其板件）：匝道整个横截面离开主桥幅（与高架中线距离 ≥ (10.5 + 7)/2 + 0.5）之后才开始下降，按剩余路程 smoothstep 从 `EXPRESSWAY_DECK_Y` 降到地面以上 0.3。不能按固定百分比提前下降，否则会钻进主桥面。墩柱每 18 一根，离地 <1.5 不立。
- **短弧不跳过**（`expresswayPieces`）：高架绘制原先跳过 <6 的折线段；出口曲线按 8 单位采样，会产生合法短段，曾因此出现断桥（seed 1927/t5 有 19 条）。现只跳过近零长度段。

### 3.6 展示裁剪——`cityLayout.ts`

布局按活动裁剪街道：宽 12 与桥永远显示，宽 ≤8 的街道只在服务已建成街区、设施附近时显示。与本文相关的两条例外（[cityLayout.ts:784](../apps/agent-city/ui/src/engine/cityLayout.ts:784) 起）：

- 市政广场周边（半径 + 20）的路口永远保留，避免把广场入口裁成两岔；
- 匝道落地点、开放高架两端所在的地面路永远保留：它们是固定服务入口，附近没有建筑时宿主路也不能被裁掉。

推论：**支路小环（环道宽 5）只在城区长到那里时才显示**，未建成区的小环不画中心岛（§3.3 的「<3 条环段不画」）。

---

## 4. 不变量与守卫

| 不变量 | 守卫 |
|---|---|
| 建环失败零副作用；半径阶梯回落；确定性；新弧段不违反 `crowdedArterials` / `acuteJunctions`；支路环保留宽 5 | [verify-city-junction-rings.mjs](../scripts/verify-city-junction-rings.mjs) |
| 匝道桥面端在实际高架上、地面端在有限宿主上；路口拆分的共线宿主可用；宿主太短、不可建、压用地、离高架落地坡太近时不建；闭合高架的立交间距；渲染的分流高度与护栏开口 | [verify-city-highway-ramps.mjs](../scripts/verify-city-highway-ramps.mjs) |
| 高架、匝道不压地块与用地；每条非零短弧有桥面 | `verify-react-city-geography`、`verify-react-city-infrastructure` |
| 规划结构（含独立的 `infrastructure` 分区，记录 `junctionRings`/`highwayRamps`）与生成器版本绑定 | `verify-city-baseline`（30 岛）、`verify-city-scene-baseline` |
| 每条最终匝道仍接触非桥地面宿主 | `verify-city-baseline` |
| 展示裁剪保留市政路口与匝道落地宿主 | `verify-city-road-report` |
| 跨档补丁重映射保留率 ≥80% | [verify-plan-remap.mjs](../scripts/verify-plan-remap.mjs)（真实城市 380→420、1600→2000 两次跨档，各报「搬迁 + 已满足 / 总数」；**当前未达标**：最近实测 1600→2000 为 68%，始于 `ad697cfa`，其父提交为 86%，原因见 [CITY_DRIVING_COMPLETION_TRACKER.md](CITY_DRIVING_COMPLETION_TRACKER.md)「2026-10-19 收尾复核」；门槛未改；生成器 5 下待重测） |

规划行为变化必须同提交递增 `CITY_GENERATOR_VERSION`（[generatorVersion.ts](../apps/agent-city/ui/src/engine/generatorVersion.ts)）：版本 3 引入本文四项能力，版本 4 加入长主干局部净距准入、匝道选址移到 solve 之后。版本 5（`d3e3be73`）：高架落地端低段预留区（[rampLowZone.ts](../apps/agent-city/ui/src/engine/planner/rampLowZone.ts)，连接器预留 `rampLowZones`）、落地环钉住高架出口节点（[landing.ts](../apps/agent-city/ui/src/engine/planner/landing.ts) `pinned`）、`snapJunctions` 目标侧桥头、无街区时半径校准微调（[cityPlan.ts](../apps/agent-city/ui/src/engine/cityPlan.ts) `RADIUS_CALIBRATION_CONFIG` v2：一次尝试一个街区都没有是路网拓扑失败而非容量信号，半径只乘 `unsupportedNudge` 1.01 重试，不再按 0 地块外推）。规划基线在版本 5 重写（`7d71f94c`，30 岛中 24 岛变化，约束复核无新增违规）。

---

## 5. 配置参数

| 参数 | 值 | 位置 |
|---|---|---|
| 出口朝前锥角 / 采样步长 / 控制柄 | 60° / 8 / 0.45→0.3→0.18 | `skeleton.ts` |
| 岸路平行判定角 / 阻断半径 / 交点最小夹角 | 50° / 28 / 35° | `coastalRingRoad.ts` |
| 主干环岛半径 / 弧步长 / 最大段数 | 18,16,14 / 30° / 18 | `JUNCTION_RING_CONFIG.major` |
| 支路小环半径 / 弧步长 / 最大段数 | 10 / 30° / 14 | `JUNCTION_RING_CONFIG.minor` |
| 支路抽样比例 / 核心避让 / 主干间距 / 通用间距 / 桥端避让 | 0.14 / 140 / 220 / 130 / 60 | `JUNCTION_RING_CONFIG` |
| 匝道横移 / 长度 / 宽 / 跨越角 / 端点余量 / 间距 / 每条上限 | 17 / 110 / 7 / 50° / 90 / 400 / 2 | `HIGHWAY_RAMP_CONFIG` |
| 匝道低段净距检查区间 / 净距 | 65%–90% / 1.5 | `HIGHWAY_RAMP_CONFIG` |

长度单位均为世界单位（1 单位 = 2 m，见 [CITY_SCALE_AUDIT.md](CITY_SCALE_AUDIT.md)）。

---

## 6. 实测数据（档 5，2000 会话量级）

下表与 §1「当前状态」测于生成器版本 3/4；版本 5 改变了 24/30 个基线岛的规划，表中数字**待重测（生成器 5）**，未重跑前不应引用为当前值。

| 种子 | 岸路段数（点数） | 高架 / 最大单点转角 | 主干环岛 | 支路小环 | 匝道 | 平交未成路口 |
|---|---|---|---|---|---|---|
| 1927 | 6（9/9/6/73/49/5） | 1 / 14° | 13 | 3 | 4 | 0 |
| 97 | 6（21/12/39/19/6/49） | 1 / 67° | 13 | 11 | 0 | 0 |
| 7 | 6（38/8/27/37/5/4） | 1 / 66° | 9 | 9 | 0 | 0 |
| 42 | 5（12/4/80/43/3） | 1 / 49° | 11 | 8 | 2 | 0 |

dev 预览（`?fixtureSessions=2000`，按用户生成的种子）实测：21 个环岛中心岛（主干 10、支路 11），这座城没有环线高架，因此没有匝道。

---

## 7. 已知限制与后续

1. **湾岸路仍有断口**。seed 1927 西岸主体（z −429 → 971）已连成一段，但南端还有 3 处、东岸 1 处断开：两处是为电视塔、湾岸公园的预留用地让路（`riverUsable` 对用地半径 + 8 内的点一律拒绝，岸路不会绕行）；其余是 §3.2 的锐角保护拒接。seed 97 的岸路仍分成 6 段。改进方向：在预留用地处让岸路沿用地外缘绕行，而不是断开。
2. **高架与匝道不承载交通**。二者不在 `roadEdges` 里，车流不会上高架或匝道；玩家驾驶可以（驾驶面 + 落地门户），但路网层面落地点与干道之间没有网络连接。若要车流上高架，需要把高架与匝道纳入路网（带 `deck` 结构），影响面很大。
3. **匝道数量少**。开湾后环线高架被海湾切成短段，满足「离两端 ≥200、跨越角 ≥50°、四周有空间」的跨越点很少，多数城市 0–4 条。
4. **桥头大路口不建环岛**。岸路 × 引道形成的三主干交汇（规划期大部分主干候选）因 `bridgeClear = 60`、通往桥头的腿太短而全部放弃，这些路口仍是平交。
5. **出口曲线的退化**。曲线擦到水边/山坡时会退回直线弦，出口处仍可能有约 60° 的折角（锥角上限）。
6. **旧 `mini-roundabout` 路径未改**。它仍只作为 `acuteJunctions` 的修复档存在；新的 `runJunctionRing` 与它代码重复，后续可让前者成为后者的参数化特例（需验证基线不变）。
7. **城区地标场地压路（已修复）**：场地曾按街区内地块的包围盒铺矩形，非矩形街区的角伸到路面（500 会话 / seed 2026 一个场景 7 个部件在路上）。`dev` 的 `6c202531` 用真实路面几何（`surface/roadClearance.ts::groundRoadClearance`，含路口扇形与渐变段）把场地矩形从压路的一侧往里收，离路 ≥ `LANDMARK_ROAD_CLEARANCE`（1.0）；裙楼放不下时退回布局验证过的 17 见方裙楼、不留前院；雨棚、台阶、树只放在场地内。由 `verify-city-road-obstructions`（15 场景清零）与 `verify-city-collision`（城区地标零压路断言）守住。本分支同期的另一种修法（按街区多边形裁剪）在合并时让位于该实现。
8. **场景基线（已恢复通过）**：`verify-city-scene-baseline` 曾经不匹配，主因是时区——天气与天光按本机时区算当地时刻，基线在 +0800 机器上冻结，UTC 容器上同一份代码恒失配；守卫现在建场景前钉 `process.env.TZ = "Asia/Shanghai"`（[verify-city-scene-baseline.mjs](../scripts/verify-city-scene-baseline.mjs)）。其余差异是有意变更（版本 5 规划变化、与驾驶面共用的立交匝道几何），基线已在生成器 5 重新冻结（`7d71f94c`），现通过。
9. **大城市连续世界预算（已改为走廊局部固体）**：会话数约 1000 以上的城市（1000/7、1000/65537、2000/42）整城碰撞实体超过 `ContinuousDrivingEnvironment` 的 100 万元素上限，结构过渡用例曾全部 `continuous-world-budget` 未确认。`09558221` 起连续审计只装入路线走廊够得着的固体（[RoadPassabilityAudit.ts](../apps/agent-city/ui/src/game/driving/audit/RoadPassabilityAudit.ts) `corridorSolids`）：`CorridorValidator` 只接受中心在路线 ± `halfWidth` 内、每步前进 ≤ `maxForward·dt` 的状态，所以保留 XZ 包围盒离路线 ≤ 半宽 + 车体半径 + 一步 + 1 的固体，被接受的运动与整城完全一致；更远的固体只会改变本来就判 `route-deviation` 的结局。`solidScope: "world"` 保留整城口径供差分对照。`ROAD_PASSABILITY_AUDIT_VERSION` 3 → 4，旧审计 key 失效。（此前在临时放宽预算下，1000/7 与 1000/65537 的 8 个匝道过渡用例全部通过，见 `ce486a20`。）
   - 同类的大城市规模问题：5000/42 的路面合并曾栈溢出（`RangeError: Maximum call stack size exceeded`）——`buildRoadSurface` 用 `push(...layer.x)` 把整层展开成实参，一层的 run 属性就超出参数上限。`4d7e8af9` 改为逐元素追加（[roadSurfaceSystem.ts](../apps/agent-city/ui/src/engine/systems/roadSurfaceSystem.ts) `append()`），场景基线与路面着色不变。
10. **既有失败（非本文能力引入）**：`2001361477/t3` 主干净距 1，原提交 `9e4a0ad4` 即存在（见接管记录）。本文写作时没有重跑完整套件，当前是否全绿以最近一次 `verify-city-suite.mjs` 结果为准。

---

## 8. 复验

```sh
npm run typecheck --prefix apps/agent-city/ui
node scripts/verify-city-junction-rings.mjs
node scripts/verify-city-highway-ramps.mjs
node scripts/verify-react-city-geography.mjs
node scripts/verify-city-road-report.mjs
node scripts/verify-city-baseline.mjs
node scripts/verify-plan-remap.mjs
node scripts/verify-city-survey.mjs --set acceptance --tier 5
```

完整套件：`node scripts/verify-city-suite.mjs`——[verification-manifest.json](../scripts/city-kit/verification-manifest.json) 的 102 个守卫，另加 typecheck、verification-harness 与 build，共 105 项；耗时待重测（生成器 5）。
