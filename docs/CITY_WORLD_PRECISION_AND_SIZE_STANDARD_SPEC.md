# 世界精度与统一尺寸规范（路桥 · 建筑物 · 交通工具）：标准表 + 尺寸统一 + 验收

> 状态：实施中（2026-10-22）。世界精度修复与回归、车辆尺寸登记、道路标准表已在 `dev`；本轮完成宽度接口迁移、入口校验及城市矩阵验收。建筑物碰撞裁剪和第二期几何阈值仍待单独评审。
> 起因：
> - 地标岛改造时，种子 7 的平台桥栏杆被碰撞索引拒绝（`collision-index-invalid-input`）。用户指出：
>   「如果是浮点精度导致的问题，那么可能不只有这个建筑物有问题……这是个系统问题」；
> - 用户问「道路和桥有没有标准规范？比如最小宽度不小于多少，或者统一用我们定义好的标准道路」；
> - 用户要求把建筑物和交通工具一起纳入。
>
> 两件事放在一起，是因为它们是同一类缺陷：**几何的「合法」边界没有写成一处规则，靠散落的数字碰运气**。
> 精度是「多小的误差算噪声」，尺寸是「多宽的路算标准」。
>
> 本期范围：
> - 第一部分（P1–P6），世界精度：精度规则写成文，补回归验收；
> - 第二部分（§1–§6），路桥尺寸：一张标准表、宽度全部从表里取、一个验收脚本；
> - 第三部分（B1–B2、V1–V4），建筑物与交通工具：尺寸登记、与路桥标准的互相约束、验收。
>
> 不在本期：桥的纵坡、斜交、缓和段、净空阈值（见 §6）。这些一旦开始拒绝就会改动路网，要单独评审。

比例尺沿用 `engine/worldScale.ts`：1 世界单位 = 2 m。下文的「宽度」都是世界单位，括号里是真实米数。

---

# 第一部分：世界精度

## P1. 事故与根因

- **现象**：种子 7 上一座落在歌剧院平台上的桥，有 4 个栏杆 box（约 0.3 × 0.65 × 0.2，位于 x ≈ −363、z ≈ −511）
  被 `buildCollisionIndex` 判为非法，整座城的碰撞索引构建失败。
- **根因**：数组形式的 `buildCollisionIndex(inputs[])`（`citySolids`、`RoadPassabilityAudit`、各验证脚本走这条路）
  把 box 先展开成 8 个世界坐标角点，再在 `shape()` 里重新证明每个面共面。容差是 `128·ε·max(1, 实体自身尺寸)`，
  对小实体约 2.8e-14；而 |x| ≈ 500 处一个坐标的舍入误差就有约 1e-13（`ulp(512)` ≈ 1.1e-13）。
  **容差只按实体大小算、不按它离原点多远算**，所以远离原点的小实体能不能通过，全看舍入的运气。
- **游戏内路径从未受影响**：`compileCitySolidInputs` → `buildVersionedCollisionIndex` 早就传入原始 box
  （中心 + 半轴），box 按仿射构造、不做角点共面复证。代码里还写着「subtracting large world corners loses
  precision for thin rotated boxes」——这个问题之前在一条路径上被发现过，但没有推广到另一条。

## P2. 规模实测（证明这是系统问题）

用 0/90/500 会话 × 5 种子共 15 个场景，统计每个 box 走旧检查时的最大面偏差 / 旧容差：

| 项目 | 数量 |
|---|---|
| box 实体总数 | 68,294 |
| 已超出容差（会被拒绝） | 8（全部是种子 7 平台桥的栏杆） |
| 在容差 2 倍以内（随时可能被几何改动推过线） | 12，分布在 7 个场景 |

12 个临界实体不属于任何一类特定建筑，只取决于位置和朝向。这正是用户说的「不只这个建筑物」。

## P3. 已做的修复（590c8b30，已在 `dev`）

1. **box 一律按半轴构造**：数组形式的 `buildCollisionIndex` 也把原始输入作为 `sourceSolids` 传下去，
   与 `buildVersionedCollisionIndex` 一致。box 不再进入角点共面检查，**这个问题对 box 在任何坐标上都不再存在**。
2. **角点实体的容差计入绝对坐标**：只有角点、没有半轴的实体（棱柱、结构描述符）仍走 `shape()`。
   它的共面容差改为 `128·ε·max(1, 实体尺寸, 最大 |坐标|)`，与同文件 `separation()` 的舍入估计同一口径。
   这只是把容差放到真实舍入的量级（|x| = 500 时约 1.4e-11），真正扭曲的几何（偏差 ≥ 1e-6 级）仍然拒绝。
3. **结果**：`verify-city-collision` 在 15 个场景中拒绝 0 个；9 个碰撞验证全部通过。

## P4. 其余代码的精度审计

| 类别 | 位置 | 结论 |
|---|---|---|
| 舍入容差，已按绝对坐标缩放 | `CollisionIndex.separation()`；`DrivingCollision.ts` 的 SAT 间隙、扫掠松弛、`precision` 拒绝门 | 与修复同口径，没有问题 |
| 舍入容差，在局部坐标下计算 | `DrivingCollision.ts:149`（顶点先减去起点再比较） | 局部坐标的舍入远小于 `skin`，判定由 `skin` 主导，没有问题 |
| 相对量，与坐标无关 | 体积 vs 半轴体积、单位法向长度 | 没有问题 |
| 退化判定的固定阈值（1e-9 … 1e-12，约 45 处） | `structureCompiler`、`terrainClip`、`SurfaceIndex`、`groundRoadCompiler`、`compileSurface`、道路审计 | 比较的都是邻近点之差（长度是否为零、是否平行、面积符号）。地图范围 ±1000 内舍入约 1e-13，比阈值小 4 个数量级以上，暂无风险 |

## P5. 精度规则（以后写新代码照此执行）

1. **用于判定「是否相等 / 共面 / 相交」的舍入容差，必须同时按两个量缩放**：参与运算的几何尺寸，
   以及坐标的绝对量级（`max |坐标|`）。只按其中一个量缩放就是这次的缺陷。
2. **有构造信息就不要从世界坐标反推**：已知是仿射 box（中心 + 半轴）、矩形、圆，就按构造信息判定，
   不展开成世界坐标角点再证明一遍。
3. **固定的小阈值只能用于局部差量的退化判定**（长度为零、平行），不能当作舍入容差；
   比较对象必须是两点之差，不能是绝对坐标本身。
4. **地图范围是前提**：现有阈值按 ±1000 单位（±2 km）评估。若地图扩到 ±10⁴ 以上，
   第 3 条里的固定阈值要重新评估，或改为相对原点的分块坐标。

## P6. 精度验收

在 `verify-city-driving-collision.mjs`（碰撞索引的单元验证）里补一组远离原点的用例。两条构建路径
（`buildCollisionIndex` 数组形、`buildVersionedCollisionIndex`）各跑一遍：

1. 一个 0.3 × 0.65 × 0.2、绕三个轴都有旋转的小 box，放在 x、z = ±500、±5000：必须被接受，拒绝数为 0；
2. 同位置的一个真正扭曲的 8 角点实体（一个角点偏离共面 1e-6）：必须被拒绝；
3. 同位置一个小棱柱（角点实体，走 `shape()`）：必须被接受；
4. 车辆在 ±5000 处对该 box 的扫掠：结果是 `contact` 或 `clear`，不得是 `invalid-input`；
   超出 `precision` 门的坐标必须明确返回 `precision`，不得静默通过。

另外保留 P2 的统计作为诊断脚本（`scripts/diagnose-city-collision-precision.mjs`，不进 CI）：
它输出每个场景的「超出容差 / 2 倍以内」数量，改容差或几何时用来对照。

---

# 第二部分：路桥统一尺寸

## 1. 现状（2026-10-22 实测）

### 1.1 生成结果其实已经只有三档

用 15 座规划城（种子 1/7/42/2026/65537 × tier 1–3）统计 `createCityPlan` 的路段宽度，再用 10 座完整城
（0/500 会话 × 5 种子）统计 `layoutCity` 的最终路网宽度：

| 路段 | 规划层（15 城） | 完整布局（10 城） |
|---|---|---|
| 地面 local，宽 5 | 6227 | 1810 |
| 地面 arterial，宽 8 | 3657 | 1139 |
| 地面 arterial，宽 12 | 2136 | 2298 |
| 桥 local，宽 5 | 27 | 13 |
| 桥 arterial，宽 12 | — | 67 |

结论：**事实上的标准是 5 / 8 / 12 三档**（10 / 16 / 24 m）。没有出现过第四种宽度。桥面宽度与它所连的道路同档，
宽 8 的路上从未出现过桥。

### 1.2 但这套标准没有写成一处，也没有东西守着

- **三处各写各的定义**，互相不引用：
  - `engine/worldScale.ts` 文件头注释：「支路/次干道/主干道 5 / 8 / 12」，只是注释，不是常量；
  - `engine/planner/connect.ts:144` `roadWidthOf`：`primary ? 12 : roadClass !== "local" ? 8 : 5`；
  - `planRepair/controller.ts:31` `ROAD_SPEC`：`local 5 / secondary 8 / main 12 / waterfront 12`。
    这是修复工具的路型，名字与规划层（local / collector / arterial）对不上。
- **76 处宽度字面量**散在 `engine/` 和 `planner/` 里，例如：
  - 用宽度反推等级：`width >= 8 ? "arterial" : "local"`（planPatch × 3、planRoadRules × 2、snapJunctions）；
  - 用宽度判断主干道：`width >= 12`（landing、deadEnds、coastalRingRoad、junctionRings、networkRepairs、report 等）；
  - 写死宽度：`roadAdmission.ts` 的 `width: 8`，`skeleton.ts` 的 `width !== 12`，`landing.ts:455` 的 `primary ? 12 : arterial ? 8 : 5`。
- **类型只有两级**：`RoadEdge.kind` 是 `"arterial" | "local"`，但规划层的 `RoadClass` 有三级
  （`"arterial" | "collector" | "local"`）。次干道（宽 8）在路网里记成 `kind: "arterial"`，只能靠宽度区分。
- **没有校验**：`planPatch` 的 `add` / `restyle` 只要求 `width > 0`。导入的方案或手写补丁可以铺一条宽 4.2 的路，
  下游所有 `>= 8` / `>= 12` 的判断都会默默把它当支路处理。
- **桥没有自己的规范**：桥面宽度就是那条路的宽度。没有最小桥面宽、最大纵坡、桥头缓和段长、最大斜交角。
  陡桥头、斜接桥头都要等试驾（`planRepair/testDrive.ts`）才发现。
- **地形坡度不是路面纵坡**：`maxSlope: 0.9`（普通路）和 `VALIDATION_CONFIG.roadApproachMaxSlope: 6`（引道）
  限制的是**路线经过的地形** `terrain.slope`，不是路面本身的纵坡。6 是按历史实测包络 4.98 × 1.2 标定的，非常松。

### 1.3 路网之外的宽度

| 名称 | 宽度 | 位置 | 本期处理 |
|---|---|---|---|
| 区界高架桥面 | 10.5（21 m） | `surface/structureProfiles.ts` `EXPRESSWAY_DECK_WIDTH`；`planGeometry.ts` `VIADUCT_DECK_WIDTH` | 收进标准表，作为「结构」等级 |
| 修复工具画的高架 | 10.5 + 1 | `planRoadRules.ts:618` | 引用表值，+1 的含义写进表注释 |
| 离岛庄园环路 / 支路 | `m(8)` / `m(6)` = 4 / 3 | `cityIsletEstate.ts`，`REAL.estateLoopRoad` / `estateSpurRoad` | 只是渲染，不进路网；作为**登记过的例外**留在 `REAL` |
| 机场堤道（2026-10-22 新增） | `max(5, 起点最宽地面路)` | `engine/airportPlan.ts` | 改成「取起点道路的等级」，宽度从表里取 |

---

## 2. 标准表

新增纯常量模块 `engine/roadStandard.ts`：
- 属于 L1 层：不依赖 three，DetMath 不涉及；规划层、渲染层、修复工具都能引用；
- 作为**唯一来源**，`worldScale.ts` 的注释改成指向它。

### 2.1 地面道路等级

| 等级 id | 宽度 | 实际 | `kind` | 修复工具路型 | 中文名 | 依据 |
|---|---|---|---|---|---|---|
| `local` | 5 | 10 m | `local` | `local` | 支路 | 实测 1.1 |
| `collector` | 8 | 16 m | `arterial` | `secondary` | 次干道 | 实测 1.1 |
| `arterial` | 12 | 24 m | `arterial` | `main` / `waterfront` | 主干道 | 实测 1.1 |

- **滨海大道**不是一个等级，是主干道加 `purpose: "waterfront"`。保持现状。
- **`kind` 保持两级**。三级等级由宽度唯一推出（见 §3.1）。不改 `RoadEdge` 的类型，所以快照和基线不会动。
  如果以后要把 `kind` 改成三级，另立项，并重冻相关基线。

### 2.2 结构等级

| 等级 id | 桥面宽 | 实际 | 依据 |
|---|---|---|---|
| `expressway` | 10.5 | 21 m | `EXPRESSWAY_DECK_WIDTH` 现值；顶面 9.1 = `EXPRESSWAY_DECK_Y` 8.2 + 厚 0.9 |
| `ramp` | 跟随所接地面路的等级 | — | `highwayRamps.ts` 现行为 |

### 2.3 桥（本期只定宽度）

| 规则 | 值 | 说明 |
|---|---|---|
| 桥面宽度 | = 所在路段的等级宽度 | 现状就是这样，本期写成规则并验收 |
| 桥面最小宽度 | 5（支路） | 由「必须是标准档」自然推出，不另设数字 |
| 桥与引道等宽 | 必须 | 桥两端的地面路与桥面同档。不等宽本期只**报告**，不拒绝 |

### 2.4 每个等级登记的字段

```ts
type RoadClassSpec = Readonly<{
  id: "local" | "collector" | "arterial";
  width: number;            // 世界单位；唯一允许出现宽度字面量的地方
  kind: "local" | "arterial";
  repairType: "local" | "secondary" | "main";
  label: { zh: string; en: string };
  sidewalk: number;         // = SIDEWALK_BAND 1.8，三档相同，集中到这里
  // —— 第二期才填，本期为 null；填之前必须先有测量和验收集证据（同 VALIDATION_CONFIG 的规矩）——
  maxGrade: number | null;          // 路面纵坡上限
  bridgeTransition: number | null;  // 桥头缓和段最短长度
  maxBridgeSkewDeg: number | null;  // 桥轴与所接道路的最大斜交角
}>;
```

---

## 3. 宽度统一

### 3.1 API（只有这几个出口）

```ts
export const ROAD_CLASSES: readonly RoadClassSpec[];
export function roadClassSpec(id: RoadClassId): RoadClassSpec;
/** 严格反查：只认三档标准宽度，其余返回 null（不再用 >= 8 / >= 12 区间猜）。 */
export function roadClassOfWidth(width: number): RoadClassId | null;
export function isStandardRoadWidth(width: number): boolean;
/** 宽度对应的两级 kind；旧数据的非标宽度保留原区间语义。 */
export function kindOfWidth(width: number): "local" | "arterial";
export function roadWidthFor(id: RoadClassId): number;
export function isStandardEdge(edge: { width: number; kind: "local" | "arterial" }): boolean;
/** 等级比较，替代散落的 width >= 8 / width >= 12。 */
export function atLeast(edge: { width: number }, id: RoadClassId): boolean;
export const EXPRESSWAY_DECK_WIDTH: number;
```

`roadClassOfWidth` 用严格相等。比较带 1e-9 容差，用来吸收 JSON 往返误差。

### 3.2 迁移清单

| 现状写法 | 改为 | 涉及（举例） |
|---|---|---|
| `width >= 8 ? "arterial" : "local"` | `kindOfWidth(w)`；新增/改路先校验标准宽度 | planPatch.ts:458/494/559，planRoadRules.ts:470/535 |
| `width >= 12` | `atLeast(e, "arterial")` | landing、deadEnds、coastalRingRoad、junctionRings、networkRepairs、report、cityLayout:697/802 等 |
| `width >= 8` | `atLeast(e, "collector")` | siteFrontage、highwayRamps、coastalRingRoad:81、planRoadRules:600 |
| `width !== 12` | `roadClassOfWidth(w) !== "arterial"` | skeleton.ts:34，networkRepairs.ts:358 |
| `primary ? 12 : arterial ? 8 : 5` | `roadClassSpec(...).width` | connect.ts:144 `roadWidthOf`，landing.ts:455，repairs.ts:241 |
| `width: 8` | `roadClassSpec("collector").width` | roadAdmission.ts:15 |
| `{ width: 12 }` 兜底主干道 | `roadClassSpec("arterial").width` | access.ts:323/410 |
| `ROAD_SPEC` 字面量 | 从标准表派生 | planRepair/controller.ts:31 |
| `EXPRESSWAY_DECK_WIDTH` / `VIADUCT_DECK_WIDTH` 两份 | 都 re-export 表里的一个值 | structureProfiles.ts、planGeometry.ts |
| 机场堤道 `max(5, …)` | 取起点道路的等级 | airportPlan.ts |

`models/`（地标场地的通道宽、球场等）不是路网宽度，不在迁移范围。

### 3.3 入口校验

- `planPatch` 的 `add` / `restyle` 只接受标准宽度。其余返回新失败码 `non-standard-width`，并给面板文案（中英）。
  不做静默吸附：吸附会改掉用户写下的值，而规范要的是明确拒绝。
- 读取旧存档时**不改写**已有路段。按 §1.1 的实测，已有路段全是标准档。万一出现非标路段，由验收脚本报出来，不在读取时修正。

### 3.4 本期不应改变生成结果

规划和布局中实际出现的宽度已经全是三档（§1.1），`>= 8` / `>= 12` 在三档上与严格反查等价。
因此**宽度统一必须对现有基线逐字节无变化**：

- `golden/`；
- `fixtures/city-driving/structure-render-baseline.json`；
- 地标、场景、跨引擎基线。

任何基线变化都说明某处原本在用非标宽度或区间语义，要先查清楚，不能直接重冻。

---

## 4. 验收

新增 `scripts/verify-city-road-standard.mjs`，登记进 `verification-manifest.json` 的 planning 段，同步
`verify-city-verification.mjs` 的计数。检查四项：

1. **路网只有标准宽度**：
   - 范围：15 座规划城，3 座海滨城（1703294958/2、1703310796/2、1703334553/5），以及 0/500 会话 × 5 种子的完整布局；
   - 每条路段（包括展示层生长出来的路、机场堤道、桥）满足 `isStandardRoadWidth(width)`；
   - 每条路段的 `kind` 等于 `roadClassSpec(roadClassOfWidth(width)).kind`。
2. **桥面宽 = 所在等级宽**；桥两端的地面路与桥同档的比例要报出来。本期**只报告**等宽比例和不等宽的桥，不失败。
3. **源码里没有游离的宽度字面量**：
   - 静态扫描 `engine/planner/`、`engine/plan*.ts`、`engine/cityLayout.ts`、`engine/airportPlan.ts`、`planRepair/`；
   - 不得再出现 `width >= 8`、`width >= 12`、`width !== 12`、`width: 5|8|12`、`? 12 : … 8 : 5` 这类写法；
   - 只有 `roadStandard.ts` 自己能写这些数；
   - 做法与 Rust 侧 `dependency_budget.rs` 的边界守卫相同：用白名单，不靠记性。
4. **入口拒绝非标宽度**：补丁 `add` 宽 4.2 和 `restyle` 宽 10 都必须得到 `non-standard-width`；宽 5 / 8 / 12 照常通过。

另外，以下现有验证必须保持全绿、基线不变：

- typecheck、导入边界；
- `verify-city-road-report`、`verify-city-structure-surface --cities`、`verify-city-landmark-platforms`；
- `verify-city-plan-patch`、`verify-city-repair-drivability`；
- `verify-city-suite full`。

---

## 5. 实施步骤

0. 世界精度：补 P6 的回归用例和诊断脚本（不改生成结果，最先做）。
   同时做 V3-1 的登记和 V4 的「登记 + 量测」验收：只登记现值，同样不改生成结果。
1. 写 `roadStandard.ts` 和它的单测（反查、等级比较、表的冻结）。
2. 按 §3.2 逐模块替换。每替换一组就跑 typecheck 和受影响的验证，确认基线无变化。
3. 改 `planPatch` 入口校验，加失败码和文案（`repairCopy.ts` 中英各一条）。
4. 写验收脚本，登记进清单，跑全量。
5. 建筑物最小碰撞厚度（B2）：先出「去掉哪些实体」的清单评审，再实施并重冻碰撞类基线。
6. 文档：`worldScale.ts` 的注释指向标准表；`CITY_MODULE.md` 的道路一节补一句「宽度只从 roadStandard 取」。

风险：
- 某处 `>= 8` 的真实意图其实是「不小于次干道，包括将来更宽的路」。严格反查会改变这种语义。
  替换时逐处确认，表达这种意图的一律用 `atLeast`。
- `access.ts` 的主干道兜底宽度是在没有路网时的近似值，替换后要确认它仍然只是近似。

---

### 5.1 实施记录（2026-10-22）

- 第 0、1 步：`51fa19b3` / `d0ccd045`，远原点精度回归、车辆登记与标准表单测已落地。
- 第 2 步：规划器、布局、修复工具、道路渲染/标线/照明和试驾已改用标准表；高架全宽与半宽、修复高架的额外净空、人行道带宽共用来源。保留各调用处原来的比较方向，不把场地尺寸、缓和段长度、建筑退距当作路宽替换。
- 第 3 步：直线/弧线预览、改路预览和补丁重放均拒绝非标准宽度，返回 `non-standard-width`；中英文原因已接入。无效操作在拆路和增节点之前拒绝。读取旧布局时保留已有非标准路段；导入的新增/改路操作仍需通过入口校验。
- 第 4 步：标准守卫默认执行完整城市矩阵，`--unit` 仅供开发快速检查；此前已经登记在 planning/full 清单中。新增 AST 扫描，避免把注释误当代码；补丁守卫验证直线、弧线、改路、存档重放和失败不留残片。
- 第 6 步：比例尺注释和 `CITY_MODULE.md` 指向标准表。

本轮验证记录：

| 验证 | 结果 |
|---|---|
| 迁移前后指纹比较 | 15 规划 + 3 海滨规划 + 10 完整布局，共 28 组序列化结果逐字节一致；未刷新 golden 或几何 fixture |
| `verify-city-road-standard` | 15 规划 + 3 海滨完整布局 + 10 完整布局，共 28 城、20,792 条道路全为标准档；133 座桥的桥面全宽与路段等级一致 |
| 桥头接入等宽（仅报告） | 225 个有地面路接入的桥端，215 个所有接入路均等宽；另 10 个路口含不同等级支路，不代表这 10 处不可通行；平台端无地面路者不计分母 |
| `verify-city-structure-surface --cities` | 15 城渲染/物理几何基线保持一致；27 座桥中 26 座完整穿越，7/2 既有岸端问题如实报告；4/4 高架匝道双向通过 |
| `verify-city-landmark-platforms` | 18 城全部平台端对齐连通；机场 18/18 双向通过，歌剧院 16/18，既有岸端问题为 7/2、1703310796/2m |
| `verify-city-road-report` | 10 座规划城 + 1 展示图通过 |
| `verify-plan-repair-drivability` | 100 个工具接受的编辑，451 次试驾，99/100 双向通过；既有 1 处绕岛/路缘受阻保留报告 |
| 类型、导入边界、补丁/文案/控制器 | 通过；补丁新增 4.2 / 10 / 非正数 / NaN / Infinity 拒绝回归，5/8/12 正常通过 |
| `verify-city-suite full` | 本轮运行通过前 38 阶段（含 31 种子地理、20 种子海滨及 tier 10 默认/Miami 矩阵）；随后被 `verify-react-city-layout` 的机场平台落点断言中止。该断言已按显式 causeway 契约修正，专项守卫通过；全量尚未重跑，不能标为全绿，见下 |

全量验收曾有两项既有阻塞，已在本轮修正守卫并补上可复现的证据：

- `verify-city-ground-surface`：旧基线使用 1.2 m 人行道；`48381b95` 有意将其加宽到标准 1.8 m。守卫现以 1.2 m 反事实编译逐个复现全部旧夹具摘要，再验证新旧路面/路口层逐字节相同；15 个当前生成布局另以 generator v6、1.8 m 标准单独固定摘要，并通过逐三角形地形偏差和拓扑检查。命令 `node scripts/verify-city-ground-surface.mjs --cities` 通过，15/15 布局人行道边界完整，最大采样偏差 0.0193（限值 0.035）。
- `verify-city-road-terrain`：旧坐标 `(158.7, 429.1)` 来自 `c9d84b15` 的 seed 1 空城，之后道路已随生成器更新而移动。守卫现使用版本化局部历史地形夹具重建旧 192/384 分段表面：192 分段稳定复现 8/32 个朝向的 wheel-twist 拒绝，384 分段支持 32/32，最大残差 0.009144，轮面阈值仍为 0.06。当前 seed 1 空城的 148,225 个渲染地形顶点与地形源一致，真实碰撞集上的双向连续驾驶通过。命令 `node scripts/verify-city-road-terrain.mjs` 通过。

这两项专项守卫已通过。完整套件跑完海滨 tier 10 的默认与 Miami coastal 矩阵后，曾在 `verify-react-city-layout` 停止：零会话 case 中 bridge `156.2:-392.68/247.69:-575.44` 的终点 `247.69:-575.44` 不在地面路图中，也没有进入 `missingBridgeLandings`。复核 `airportPlan.ts` 后确认这是机场 causeway 的显式机场平台落点，并非要求接地面道路的普通桥头；守卫已改为仅豁免与 `layout.airport.causeway` 的起点、终点及 edge ID 完全一致的机场 causeway 平台端。其余桥端规则不变。`node scripts/verify-react-city-layout.mjs` 已通过；完整套件尚未在该修正后重跑，故不能标为全绿。完整跑法为 `node scripts/verify-city-suite.mjs full`。已知道路实际问题 7/2 和 1703310796/2m 歌剧院桥头仍留在场景/规划验收记录中，未由本轮测试夹具工作修复。

仍未实施：第 5 步 B2 碰撞小件裁剪，先提交实体清单评审。最小厚度不等于高度：细而高的墙/栏杆可能真实挡车，不能仅按最短边阈值直接删除。车辆与桥坡、净空的新增硬阈值也不在本轮范围。

---

## 6. 第二期（单独评审，本期不做）

桥和路面的几何规范。阈值要先测量再定，做法同 `VALIDATION_CONFIG`：先测历史包络，再加余量，并引用验收集证据。

| 指标 | 现状 | 怎么定 |
|---|---|---|
| 路面纵坡上限 `maxGrade` | 没有，只有试驾的台阶和扭转判定 | 测 15 城桥面和引道的纵坡分布，对齐车辆爬坡能力 |
| 桥头缓和段 `bridgeTransition` | `bridgeDeckProfile` 每 0.5 一段渐变，长度由落地区决定 | 测现有通过试驾的桥头最短缓和段 |
| 最大斜交角 `maxBridgeSkewDeg` | 没有；机场堤道选起点时自己用了 40° | 用试驾通过与失败的桥头分出界线 |
| 桥下净空 | 没有 | 只在桥跨越道路时有意义，需先统计 |

这些一旦开始拒绝，就会让部分城市的路网换形（桥被拒、改道），基线会变。所以要先评审阈值，再决定是只报告还是拒绝。

---

---

# 第三部分：建筑物与交通工具

路桥的尺寸最终要服务于在上面开的车、和路边立着的楼：路多宽取决于车多宽，桥下净空取决于车多高，
最大纵坡取决于车能爬多陡，路缘退让取决于楼的边界。所以这三类尺寸必须互相引用，不能各管各的。

本部分的数据来自 2026-10-22 实测：5 座城（种子 1/7/42/2026/65537，500 会话）渲染后被碰撞索引收录的
场景实体，共 28,365 个；以及各车辆模型的源码常量。

## B1. 建筑物现状

### B1.1 已有的尺寸来源

| 来源 | 内容 | 有没有验收 |
|---|---|---|
| `planner/roadBlocks.ts` `ROAD_BLOCK_POLICY` | 会话地块 7.2 × 8（14.4 × 16 m），路缘退让 `roadMargin` 0.5，用地避让 9，高架走廊半宽 5.25 | 由规划验证间接覆盖 |
| `worldScale.ts` `REAL.floorHeight` | 层高 3.2 m；会话楼立面层数和地标窗格都按它算 | 无 |
| `worldScale.ts` `SIZE_POLICY` | 13 个地标/大件的真实参考高度和允许比例区间，每条带理由 | **有**：`verify-city-world-scale` 构建每个模型量高度，越界或缺条目即失败 |
| `worldScale.ts` `VISUAL_BOOST` | 登记过的视觉放大（目前只有鸟 2.5 倍） | 无 |

`SIZE_POLICY` 是本仓库里**唯一一套带验收的尺寸标准**：参考值、允许区间、理由、自动量测，四样都有。
第二部分的路桥标准表和本部分的建筑、车辆登记都应照这个模式做。

### B1.2 实测尺寸分布（世界单位；×2 即米）

| 类别（碰撞角色） | 数量 | 短边 p50 | 长边 p50 / p95 | 高 p50 / p95 / 最大 |
|---|---|---|---|---|
| 会话楼主体 `city-shafts` | 3,091 | 6.2 | 9.6 / 13.8 | 14.7 / 29.1 / 31.2 |
| 圆筒会话楼 `city-shafts-cylinder` | 65 | 6.8 | 6.8 / 10.1 | 25.9 / 31.6 / 32.4 |
| 屋顶轮廓 `city-roof-profile` | 1,096 | 5.4 | 7.7 / 13.9 | 2.6 / 6.0 / 8.1 |
| 背景楼立面 `city-vice-context-facades` | 841 | 7.8 | 9.2 / 10.0 | 18.5 / 46.8 / 69.9 |
| 公共建筑小件 `city-civic-boxes` | 7,336 | 0.2 | 0.3 / 17.0 | 1.3 / 3.0 / 22.0 |
| 公共场地 `city-public-sites-boxes` | 810 | 3.2 | 9.0 / 50.6 | 2.2 / 8.0 / 38.8 |
| 离岛豪宅 `city-landmark-islet-mansion` | 6,979 | 0.1 | 0.1 / 8.1 | 1.0 / 1.5 / 4.6 |

### B1.3 问题

1. **没有碰撞实体的最小尺寸**：28,365 个实体里，最薄方向（短边或高度）小于 0.05（10 cm）的有 1,703 个，
   小于 0.1（20 cm）的有 5,007 个。其中 1,439 个来自离岛豪宅，155 个来自机场，其余来自区域地标和公共场地。
   这些小件：
   - 不改变车能不能通过（比可越障阈值 0.144 还矮的，在 gameplay 下本来就可越）；
   - 白占碰撞预算（BVH 节点、候选数）；
   - 正是第一部分说的那种「远离原点的小实体」，对精度最敏感。
2. **会话楼只有间接约束**：地块尺寸、层高各有常量，但「会话楼的占地与高度应该在什么范围」没有登记，
   也没有像 `SIZE_POLICY` 那样的量测。目前实测最高 31.2（62 m，约 19 层），背景楼最高 69.9（140 m）。
3. **楼与路的关系只有事后报告**：楼体压到可行驶路面上，由 `solidsOnRoad`（碰撞验证里的「路面上的实体」）报告，
   规划阶段只有 0.5 的路缘退让，没有按道路等级区分的建筑退线。

## B2. 建筑物标准（提议）

在 `worldScale.ts` 旁边新增 `BUILDING_STANDARD`，与 `SIZE_POLICY` 并列，同样是「参考值 + 区间 + 理由」：

| 项目 | 提议 | 依据 |
|---|---|---|
| 会话地块 | 7.2 × 8（沿用 `ROAD_BLOCK_POLICY`，改为引用） | 现值 |
| 层高 | 3.2 m（沿用 `REAL.floorHeight`） | 现值 |
| 会话楼高度区间 | 按实测包络登记（当前 3.2 … 31.2），越界报告 | B1.2 |
| 会话楼占地短边下限 | 按实测 p5（4.3）登记 | B1.2 |
| 建筑退线（楼体到路缘） | 按道路等级取值，引用第二部分的标准表；本期只登记现值 0.5，并报告各等级的实测最小值 | 现值；分等级的取值属第二期 |
| 碰撞实体最小厚度 | 短于阈值的实体不进碰撞索引，改为装饰（标 `cityDrivingNonSolid`）或与相邻实体合并。阈值待测，候选 0.05 | B1.3-1 |

最小厚度这一条会改变碰撞实体数量，因此会改动碰撞、场景类基线。实施前先出一份「去掉哪些实体」的清单评审，
确认没有删掉真正挡车的东西（比如细柱、栏杆）。

## V1. 交通工具现状

| 交通工具 | 尺寸来源 | 世界单位 | 实际 | 真实参考 | 偏离 |
|---|---|---|---|---|---|
| 玩家车（驾驶） | `game/carDimensions.ts` `CAR_DIMENSIONS` | 长 2.8、宽 1.4、高 1.15；轴距 1.8、轮距 1.15、轮半径 0.24 | 5.6 × 2.8 × 2.3 m | 轿车 4.5 × 1.8 × 1.5 m（`REAL.car`） | 长 1.24 倍、宽 1.56 倍、高 1.53 倍，**未登记** |
| 背景车流 | `ambientSystem.ts`，`m(REAL.car)` | 2.25 × 0.9 × 0.75 | 4.5 × 1.8 × 1.5 m | 同上 | 无 |
| 飞行模式双翼机 | `FlightVisuals.ts`，按 `planeRadius` 缩放 | 翼展 4.2 × r；r = clamp(2.2, 5, 地图对角线 × 0.004)，即 9.2 … 21 | 翼展 18 … 42 m | 双翼机翼展约 8–10 m | 2 … 4 倍，随地图大小变化，**未登记** |
| VTOL | 复用玩家车车身 | 同玩家车 | 同玩家车 | — | 同玩家车 |
| 小艇 / 游艇 / 码头船 | `REAL.boat` / `REAL.yacht` / `REAL.marinaBoat` | 按真实尺寸换算 | 12 / 28 / 7–12 m | 同左 | 无 |
| 鸟群 | `REAL.bird` × `VISUAL_BOOST.bird` | — | 翼展约 5.5 m | 2.2 m | 2.5 倍，**已登记** |

## V2. 问题

1. **玩家车比路上其他车大一圈，而且没有登记**。同一条路上，玩家车宽 1.4，背景车宽 0.9。
   这不一定是错（玩家车放大便于驾驶视角读清楚），但它必须像鸟群一样登记在 `VISUAL_BOOST` 里并写明理由，
   否则以后有人「修正」它，整套驾驶判定都会变。
2. **驾驶物理的所有阈值都以玩家车为基准**，路桥标准实际上也是按它定的：
   - 车身包络：底 0.1、顶 1.25（`DEFAULT_BODY_PARAMS`），碰撞时四周内缩 0.12（`GAMEPLAY_COLLISION_INSET`）；
   - 可越障高度 0.144 = 轮半径 0.24 × 0.6；
   - 车轮可接受的最大坡度 0.3 rad ≈ 17°（`DEFAULT_FOOTPRINT_PARAMS.maxSlope`），单步最大台阶 0.18。

   这些数字决定了路要多宽、桥头能多陡、桥下要多高，但现在它们和路桥尺寸之间没有任何书面关系。
3. **飞机尺寸随地图大小变化**：`planeRadius` 按地图对角线取值，大城市的飞机更大。这是有意的
   （让飞机在大地图里看得见），同样应该登记，并说明碰撞球半径就是 r。

## V3. 交通工具标准（提议）

1. 在 `worldScale.ts` 的 `VISUAL_BOOST` 里登记：
   - 玩家车：长、宽、高各自相对 `REAL.car` 的倍数，以及理由；
   - 飞机：翼展相对真实双翼机的倍数区间（随 `planeRadius`），以及理由。

   `CAR_DIMENSIONS` 改为由 `REAL.car` × 登记倍数推出，或者保留现值、由验收断言两者一致。
   **本期不改玩家车的大小**：改车会改动全部驾驶、碰撞、试驾基线，要单独决定。
2. 写清车辆与路桥之间的约束，作为第二部分标准表的派生规则（由验收脚本检查，不靠记性）：

| 约束 | 公式 | 现值是否满足 |
|---|---|---|
| 最窄标准路能放下两车道 | 支路宽 5 ≥ 2 ×（车宽 1.4 + 2 × 横向余量 0.2） = 3.6 | 满足 |
| 背景车道中线在路面内 | 车道偏移 1.2 + 背景车半宽 0.45 ≤ 支路半宽 2.5 | 满足 |
| 桥面最大纵坡（第二期 `maxGrade`） | ≤ tan(车轮最大坡度 0.3 rad) ≈ 0.31 | 待第二期定值 |
| 桥下 / 高架下净空（第二期） | ≥ 车身顶 1.25 + 余量 | 待第二期定值 |
| 桥头接缝台阶 | ≤ 单步台阶 0.18；理想为 0（对齐） | 由现有 landing 检查覆盖 |

## V4. 验收

扩展 `verify-city-world-scale`（它已经在量地标高度）：

1. **每种交通工具都有登记**：要么按 `REAL` 真实尺寸，要么在 `VISUAL_BOOST` 里有倍数和理由。
   构建玩家车、背景车、飞机、船的模型，量包围盒，必须落在登记区间内；缺登记即失败。
2. **建筑物**：会话楼高度、占地短边落在 `BUILDING_STANDARD` 区间内；碰撞实体最小厚度的统计照常输出，
   阈值定下来之后改为失败条件。
3. **车辆 ↔ 路桥约束**：V3 表里已定值的行（两车道、车道中线）作为断言；第二期的行先只输出实测值。

这些检查与第二部分的 `verify-city-road-standard` 共用同一张标准表。车辆宽度变了，
路宽约束会立刻报出来，而不是等到试驾时才发现开不过去。

## 附：相关的已知问题

`verify-react-city-geography` 在种子 3576928465 上曾经失败：一座长 9.9 的短桥下面的浅水被桥头土方
（`roadLandingGrading`）填高到 ≥ 0.5，桥看起来架在陆地上。`main` 已经由 90fccf84 修复（桥跨下的浅水不再被填）。
它暴露出：「桥必须跨越水或道路」目前只是验收脚本里的事后检查，没有准入规则。建议列为第二期的一条。
