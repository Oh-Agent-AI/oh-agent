# A4/B1：同层路面合并、路缘/岛语义、整车覆盖与连续运动

日期：2026-10-15。接 [A3 SurfaceIndex](CITY_SURFACE_INDEX_NOTES.md)。本轮把点级候选变成「整车能否停在这里、能否从这里移动到那里」的几何判定。它**不**认证任何道路可通行：无portal、无固体障碍、`geometricallyEligibleLength` 仍为0，未接CityEngine。

## 代码入口

| 文件（相对UI src） | 作用 |
| --- | --- |
| `engine/surface/SurfaceIndex.ts`（改） | 单三角入桶改为精确2D SAT格覆盖，`maxCellsPerTriangle`按真实触及格计，新增`maxScanCellsPerTriangle`限扫描成本；新增 `trianglesInBox`、`triangle`、`patches`；**修正法线分量错位**（A3草稿平路返回水平法线 (0,0,±1)） |
| `engine/surface/surfaceRegions.ts`（新） | `buildSurfaceRegions(snapshot, index)`：同层alias合并为区域、唯一点分类器 `classify`、带标签的区域边界、`segmentsInBox`/`boundaryOf`、报告 |
| `game/driving/surfaceFootprint.ts`（新） | `footprintSupport`（整车静态覆盖+四轮拟合+坡度/扭曲）、`validateMotion`（细分扫掠凸包）、`segmentTouchesConvex` |
| `game/driving/SurfaceDrivingWorld.ts`（新） | `SurfaceDrivingEnvironment`（实现现有 `DrivingEnvironment`，整步拒绝）、`SurfaceWorldValidator`（实现 `AuditWorldValidator`，独立复核）、`polylineProgress` |

## 规则

**合并（跨片段union）。** 同layer两个车行片段在重叠/接触区内，**所有叠置顶点**（双方三角形顶点 + 三角边交点）高差 ≤ `aliasTolerance` 才算alias并入同一区域。分段线性高差的极值只会出现在这些点上，所以这是精确判定，不是抽样。区域id = 最小成员patch id，与输入顺序无关。支撑高度取alias的上包络（实际画在上面的那层），并列按patchId、triangleIndex稳定排序。

**唯一分类器。** 一点可行驶当且仅当：被某区域成员覆盖；不被岛覆盖（curb）；不被边界未解决的车行片段覆盖（closed，unresolved-patch）；不被另一区域同时覆盖（ambiguous-region）；不被一对高差冲突的成员同时覆盖（height-conflict）。人行道不提供支撑，只把相邻边界标为curb。查询预算、非法输入都按closed失败。

**区域边界。** 不是片段环的并集。所有可能改变分类结果的线段（成员边界环、岛环、未解决片段和未解决岛的全部三角边）在交点处切分，每小段两侧各偏 `sideOffset` 重新分类：一侧属于本区域、另一侧不属于，就是边界，标签取不可行驶一侧（`curb`/`closed`，带cause）；两侧同区域但高差 > aliasTolerance 标为 `step`；两侧是不同区域时双方都标closed，因为没有portal。

**整车覆盖。** 车体矩形（侧向 +0.2、纵向 +0.1，见产品SPEC §13.1）与本区域边界线段无交，且中心点可行驶，才算整车在面上。区域是闭集，所以这等价于全车覆盖，能拦住「四轮四角都在路上、车底骑着岛或孔」这一类。随后在四个轮位上取高度拟合pitch/roll，检查扭曲残差和坡度。

**连续运动。** 按 `maxAngleStep`/`maxSampleDistance` 细分，每小段取两端矩形的凸包。矩形先按旋转弦高 `reach·(1−cos(Δθ/2))` 和弧形中心轨迹弦高膨胀，凸包也不得碰边界；每个样本点还要通过整车覆盖检查和中心台阶检查。高速一步跨过细隔离带、原地旋转扫过路缘角，都会在这里被拒。

## 锁定数值（规则版本 `SURFACE_REGION_RULES_VERSION=1`、`SURFACE_FOOTPRINT_RULES_VERSION=1`）

| 值 | 取值 | 依据 |
| --- | --- | --- |
| aliasTolerance | 0.1 | A4时十五城叠置高差最大0.30（编译器缺陷）；A5修复后最大0.020。0.1作为接缝容许上限保留，小于轮半径0.24的一半 |
| sideOffset | 1e-3 | 远大于Float32在±600坐标处的量化误差（约6e-5） |
| lateral / longitudinal margin | 0.2 / 0.1 | 产品SPEC §13.1 规定每侧至少0.2 |
| maxSlope | 0.3 rad ≈ 17° | 十五城车行三角面坡度p99为1.4°–31°；更陡的多是桥头截断处的贴地带子，判excessive-slope并上报 |
| maxWheelResidual / maxStepPerSample | 0.06 / 0.18 | 后者 = 接缝0.1 + tan(0.3)×采样距离0.25 |
| maxAngleStep / maxSampleDistance | 0.05 rad / 0.25 | 60Hz下单tick最大位移0.22，通常一tick一个样本 |

## 十五城证据（规划布局，非0/90/500会话矩阵）

> 2026-10-15 A5 修复编译器贴地与折叠后的数字；修复前的数据见下方「A5之前」。

`node scripts/verify-city-surface-regions.mjs --cities`：十五城全部ready，每城区域构建0.6–2.7秒（Node，无worker）。每城1–3个区域，排除片段0个，高差冲突0对，alias最大高差0.020。边界只剩curb(sidewalk)和closed:no-surface（尽端、截断）。抽样检查每条边界确实只有一侧属于本区域。

`node scripts/verify-city-driving-surface.mjs --cities`：每城取40条最长的单段直路，在中心线上距起点12处出生，用按钮式比例控制沿中心线开，穿过终点节点再开6。每个tick都由 `SurfaceWorldValidator` 独立复核，全部valid；600/600次开出≥12。穿节点的结果只作诊断：约70%直穿；停下的是度2转折（直开撞路缘）、度3/4路口对面臂偏角13–26°、以及尽端。直穿的四岔全部通过。这不是通行认证，也没有测转弯。

A5之前：每城1–9个区域，0–3个片段被排除，0–10对冲突（最大0.304）；595/600（5个出生点落在未解决片段上）。根因与修复见 [A5贴地记录](CITY_GROUND_SURFACE_TERRAIN_FIT_NOTES.md)。aliasTolerance保持0.1：它现在是接缝容许上限，不再被真实数据顶到。

## 已知限制（必须保留）

1. 不处理桥/高架（编译器尚未产出顶面），不处理渠化岛：编译器目前不产 `island` kind，岛语义只在合成夹具上验证过。
2. ~~带子在急弯斜接处自折叠、坡地扇面与带子叠置高差到0.30~~：已在A5修复（编译器精确贴地+折点处理）。规则不变——将来编译器再出现这类片段，仍是整片判不可行驶并上报，不能靠放宽aliasTolerance掩盖。
3. ~~无固体障碍~~：B2 起由 `CollisionIndex` 判（建筑、地标、护栏、桥墩、桁架、桥面板），作为可选参数接入整车与运动检查，见 [B2记录](CITY_PORTALS_AND_COLLISION_NOTES.md)。地面路缘仍由人行道边界的curb语义表达，不是固体。
4. ~~无portal~~：B2 起编译器给出跨层 portal 候选，本模块复核后并区域（v4）；未通过的 portal 与不同区域之间仍一律closed。环境层仍是整步拒绝，TOI和切线滑动属于Agent C。
5. 边界两侧偏移探测假设没有另一条线段在 `sideOffset` 内与之近平行。真实数据抽样未见违例，但这不是通用鲁棒布尔运算。
6. Environment和Validator共享surface事实（spec §11.1允许）；编译器错误要靠A批次的渲染几何对照兜底。
7. 构建是同步全量（每城约1–3秒），未接Worker和SurfaceStore生命周期，没有性能验收。

## 命令

```sh
node scripts/verify-city-surface-regions.mjs            # 合成：索引栅格化/法线、合并、冲突/台阶、路缘/尽端、岛/孔、未解决片段、分层、预算
node scripts/verify-city-surface-regions.mjs --cities   # 十五城区域与边界自洽
node scripts/verify-city-driving-surface.mjs            # 合成：整车覆盖、窄口、扫掠、接缝、坡度、分层、kernel/runner集成、漏碰撞环境检测、纯模块边界
node scripts/verify-city-driving-surface.mjs --cities   # 十五城真实路段同核试跑
```

## A6修订（2026-10-15）

规则版本 `SURFACE_REGION_RULES_VERSION=2`：所有aliasTolerance比较加1e-6浮点余量。尽端圆盘顶面比路面高0.10，计算结果是0.10000000000000002，按容差处理而不是超差。跨层规则不变：不同layer永不隐式互通。

## A7修订（2026-10-16）

规则版本 v3：同层的 `bridge-deck` 遮挡它所覆盖、且不高于它超过容差的地面片段——这些片段不提供支撑，也不构成冲突。高出桥面超过容差的地面判为 `height-conflict`。桥面端边与地面的接缝照旧检查 step。守卫新增两项：被遮挡的低处地面不算冲突，高出桥面 0.3 的地面算冲突（变异检查：关掉遮挡规则后测试失败）。

## B2修订（2026-10-16）：跨层 portal

规则版本 v4：
- 编译器给的 portal 候选（结构片段 ↔ 被它压着的下层片段）按同层合并的精确叠置点复核：
  - 下层高出结构 > 容差 → `height-conflict`；
  - 最小叠置高差 > 容差 → `no-contact`；
  - 另有 `same-layer`、`not-member`、`no-overlap` 三种拒绝原因；
  - 通过（`open`）的对并入同一区域，区域带 `layerIds`。
- 接缝不算边界：一侧在本层是无面或人行道，同区域另一层在容差内接得上。
- 边界线段带 `layerId`/`ya`/`yb`。
- 新增 `supportAt(x, z, regionId, nearY)`：按高度连续选层，上方容差内取上层，没给高度又压着两层时返回 `ambiguous-layer`。

整车规则 v2：只检查车此处所在那层的边界线段。单层区域与 v1 逐字相同。证据与命令见 [B2记录](CITY_PORTALS_AND_COLLISION_NOTES.md)。
