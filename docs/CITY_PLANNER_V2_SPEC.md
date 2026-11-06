# Agent City 规划器 v2 SPEC：看得见路的选址 + 有偏好的求解

> 状态：草案（2026-10-07）。上位文档：`CITY_ARCHITECTURE.md` §2（约束 + 修复循环）、§7 步 6/8；
> 路网连接细节见 `CITY_ROAD_NETWORK_SPEC.md` §4–§6（本文不重复，只规定它在流水线里的位置）。
> 代码基准：`worktree-city-building-model-spec` @ `12092d46`。

2026-10-10 行为契约修订：[CITY_PLANNER_RESIDUAL_RESOLUTION_SPEC.md](CITY_PLANNER_RESIDUAL_RESOLUTION_SPEC.md)。
下文 §2 的行号、耗时和策略数是历史基线；当前残留以新 SPEC §1 与完成审计为准。
本次更新 §5.3/5.6/5.7 和验收规则，解决未落位设施、近接/短腿、桥头及求解闭环；均为待实施目标。

2026-10-11 统一实施批次见该 SPEC §9：固定世界/先验需求 → 骨架通行空间 → 联合选址与入口
接入 → 次干支路闭合 → 接受道路生成街区/地块 → 最终冻结与派生。选址状态、AccessProof、
世界版本和原子提交为本批权威契约，取代独立后置挪位；本文历史流程不代表该批已经实现。

## 1. 为什么要 v2

v1（约束 + 求解循环）已经把「补丁链」收成了可度量的形状：13 条约束（`planner/constraints.ts`）
同一份 `measure` 给求解和 CI 用，9 个修复策略（`planner/solve.ts`）跑到不动点，样本外普查
（`scripts/verify-city-survey.mjs`）钉住违例率。这套骨架是对的，不推翻。

但剩下的问题不再是「缺一个修复」，而是两处结构性短板——修复越加越多，只是在补它们的代价：

1. **判断发生在看不见路的时候。** 用地先落位，路网后生成，再对着路网把用地到处挪。
   最聪明的落位判据（`siting.ts::acceptable`，看得见路网）只在流水线最末尾、且只对违例用地启用。
2. **只有合法性，没有偏好。** 求解的终止条件是「一轮零改动」；两个都合法的方案之间无从取舍。
   `siting.ts` 选「离原位置最近的合法点」，而不是「最好的点」。规划质量的天花板因此是「不违规」。

## 2. 现状（实测，代码即事实）

### 2.1 流水线

`createCityPlan`（`cityPlan.ts:100`）→ `buildPlan`（`cityPlan.ts:125`，**一个约 1330 行的闭包**）：

| 段 | 行 | 产物 | 说明 |
| --- | --- | --- | --- |
| 岛形 / 河 / 山脊 | 129–192 | `coast` `height` `buildable` `landClearance` | 纯函数，只依赖种子与 R |
| 核心点 | 194–209 | `core` | 25×25 网格打分 |
| 公共用地 | 225–252 | `publicSites`（6 个） | 相对 `core` 放名义位，`snap()` 贴陆地 |
| 地标 | 254–344 | `landmarks`（固定 5 + 抽签） | 同上，`snap()` 互相避让 |
| 骨架 | 347–513 | `trunks` `bridges` `ringRuns` | 放射主干、桥、环线高架 |
| **用地二次落位** | 514–672 | 改 `publicSites`/`landmarks` 坐标 | **约 10 道挪动遍**：避高架、临街、岸边内移、港口贴岸、岸边地标贴岸、歌剧院上岛…… |
| 海滨带 / 滨海路 / 河岸路 | 682–811 | `seaside` `coastRoadRuns` | |
| 接入路 / 扇区街网 / 入口路 / 连通 | 812–1265 | `blocks` `parcels` 与大部分路段 | `connectToNetwork`、T 切分、并查集补连 |
| 碎边合并 / 车流 / 锚点 / 断头收尾 | 1278–1380 | | |
| 求解 | 1381–1385 | `solvePlan(repairCtx)` | 9 策略 × ≤3 轮 |
| 车流收口 / 地块终筛 | 1386–1440 | | 必须在求解之后（曾放在之前，守卫抓到） |

外层：`createCityPlan` 按实测地块数校正半径，**整张图重建最多 5 次**（`cityPlan.ts:115–121`）。

### 2.2 量化

- 用地坐标被写入的位置：`cityPlan.ts` 10 处 + `planner/` 5 处 = **15 处**，分布在 4 个阶段。
- 「占地圈 16 点是否落水」这一谓词：**8 份拷贝**（`cityPlan.ts:528/544/625/667`、`constraints.ts:43`、
  `siting.ts:20/45`、`repairs.ts:24`），阈值各异（`<0.5`、`<0.8`、`>-0.8`，是否含 `inRiver`、是否含河岸 14 带）。
- 「点到最近路」：`siting.ts:31` 与 `repairs.ts:14` 各一份全量扫描；`distanceToTrunks`、`distanceToRing`、
  地块终筛又各一份；`SegmentIndex`（`cityPlan.ts:39`）已存在但 planner 没用。
- `RepairContext`（`planner/context.ts`）18 个成员，其中 6 个是捕获 `buildPlan` 局部变量的闭包
  （`addEdge` `key` `height` `inRiver` `safeRoadLink` `crosses` …）→ planner 模块无法用合成输入单测。
- 耗时（`MIAMI_COASTAL`，样本外种子）：tier 1 均 218 ms（其中求解 ~16 ms）、tier 3 163 ms、tier 5 334 ms。
  性能不是瓶颈，**不为性能改结构**。
- 违例（样本外）：tier 1 60 种子在普查上限内；临时探针 tier 3（12 种子）有 siteInWater 1、looseInlandRoadEnds 1，
  tier 5（8 种子）有 acuteJunctions 1——**普查只测 tier 1，大岛的质量没有守卫**。

## 3. 缺陷清单

| # | 缺陷 | 证据 | 后果 |
| --- | --- | --- | --- |
| D1 | 选址先于路网 | §2.1「用地二次落位」10 道遍 + 求解里 3 个挪用地策略 | 每类违例一个特例修复；修复互相撤销靠 `MAX_SOLVE_ROUNDS` 封顶 |
| D2 | 没有目标函数 | `solve.ts` 以零改动终止；`siting.ts` 取最近合法点 | 合法但难看的布局无法被改进；无法比较两版规划器 |
| D3 | 谓词多份拷贝 | §2.2 的 8 份落水判断 | `measure` 说合格、修复说不合格（或反之）——v1 想根治的「两套口径」在谓词层复活 |
| D4 | 隐式顺序依赖 | 车流收口、地块终筛都曾放错位置被守卫抓到（代码注释为证） | 每次加一步都要重新推演整条链 |
| D5 | `RepairContext` 是闭包杂物袋 | §2.2 | planner 只能端到端测；新策略要先往袋子里塞东西 |
| D6 | 核心点 / 广场 / 环线分开决定 | `cityPlan.ts:237` 广场被 `snap` 推开后「核心点跟广场走」的事后补丁 | `civicPlazaCentred` 是普查里最后一个非零常驻项 |
| D7 | 半径重试是整图重建 | `cityPlan.ts:115–121` | 拓扑性失败（环合不拢）放大半径也治不了；最坏 5× 成本 |
| D8 | 普查只覆盖 tier 1 | `verify-city-survey.mjs:22` | 大岛退化不可见 |

## 4. 目标与非目标

**目标**

- G1 用地落位在路网骨架**之后**、对路网求解；生成期与修复期用**同一个**落位器。
- G2 引入显式评分 `score(plan)`；落位与求解按分数选，不再按「最近」「第一个」。
- G3 每个几何谓词只有一份实现，`measure` / 落位 / 修复共用。
- G4 流水线阶段之间用**类型化的不可变产物**传递，阶段内部可变、阶段之间不共享可变状态。
- G5 普查覆盖 tier 1/3/5/10，每档有上限。

**非目标**

- 不换路网生成算法（张量场追线另立项，见 `CITY_ROAD_NETWORK_SPEC.md` §2.1）。
- 不追求全局最优（不上 ILP / 模拟退火）；贪心 + 有限局部交换足够，且确定性好验证。
- 不改 `CityLayout` 对外形状——渲染层（L2 以下）零改动。
- 不为性能重构；性能门禁以同设备/引擎的 R0 测量标定，历史耗时不直接作为当前阈值。

## 5. 目标设计

### 5.1 阶段与产物

```
planner/
  geography.ts   Geography   = { coast, height, buildable, landClearance, coastDistance, river, hill, R }   ← cityPlan 129–192
  footprint.ts   共享谓词（§5.2）——只依赖 Geography 与 RoadIndex
  skeleton.ts    Skeleton    = { core, plaza, trunks, bridges, ringRuns }                                   ← 194–209 + 347–513，核心与广场联合决定（§5.4）
  network.ts     Network     = { nodes, edges, coastRoadRuns, seaside }  建在 Skeleton 上：滨海路、河岸路、扇区街网、连通（调用 connect.ts）
  connect.ts     统一连接器（CITY_ROAD_NETWORK_SPEC §4）
  sitespec.ts    每类用地的 SiteSpec 表（§5.3）
  assign.ts      候选生成 + 指派（§5.3）→ Sites
  access.ts      给落位后的用地接门前路（入口路、凯旋门骑路）——调用 connect.ts
  parcels.ts     街区/地块切分 + 终筛（读最终 Network 与 Sites）
  constraints.ts 不变（13 条 measure，改为调用 footprint.ts）
  score.ts       评分（§5.5）
  solve.ts       违例驱动的修复循环（§5.6）
  pipeline.ts    把以上串起来；cityPlan.ts 只剩 createCityPlan + 半径校正 + 组装 CityLayout
```

顺序：`geography → skeleton → network(骨架级：主干/环线/滨海/河岸) → joint(assign + access) → network(街网填充) → transactional repair → parcels → finalize/visible validation`。
容量试算可使用临时地块，但最终地块、车流与装饰在安全/必要需求通过后生成；地块已有消费者时
须在联合草稿中重建并保持其地址合同。assign/access 不是两个各自发布半条连接的阶段。

关键变化是 **assign 夹在骨架路网与街网之间**：用地看得见主干、环线、滨海路、桥头，街网再绕开已落位的用地铺——
这正是现在第 517–672 行十道挪动遍试图事后达成的状态。

每个阶段签名形如 `(prev: Readonly<Prev>, rng) => Next`；阶段内可以随意变更局部数组，但不得改上游产物。
`RepairContext` 被 `{ geo, skeleton, network, sites, blocks }` 取代——全是数据，没有闭包；
`addEdge` / `key` 变成 `network.ts` 导出的纯函数（`addEdge(network, a, b, kind)`）。

### 5.2 共享谓词 `footprint.ts`

一份实现，全部调用方共用；阈值作为命名常量，不再散落：

```ts
export const WATER_LEVEL = 0.5;            // 低于此即水（现 siteInWater 口径）
export const DRY_LEVEL = 0.8;              // 占地「干地」口径（现 footprintDry）
export function footprintSamples(c: Vec2, r: number): Vec2[];          // 16 点：奇数外圈 r、偶数内圈 0.6r
export function wetCount(geo, c, r, opts?: { river?: boolean; riverBank?: number }): number;
export function isDry(geo, c, r): boolean;
export function roadDistance(index: RoadIndex, p: Vec2, filter?: (e) => boolean): number;   // 基于 SegmentIndex，支持过滤桥/主干
export function clearsHighways(...)                                     // 迁自 cityPlan.ts:65
export function nearBridgeEnd(skeleton, c, r): boolean;
```

`RoadIndex` 在 `SegmentIndex` 上加「最近距离」查询（现在只有 `closerThan`），并支持增量 `add/remove`（求解删路时同步）。

**生成准入与终态水约束必须使用同一占地能力。** 内陆 frontage 用地若 `siteFootprint` 提供精确地面外廓，
`siteInWater` 必须按同一世界外廓及同一有界采样验证；不能再把未被实体覆盖的名义半径圆角当成建筑入水。
无精确外廓的 legacy/nominal 用地保留 16 点圆形代理；岸边/离岸规则继续沿用显式 wet-budget 与 `shore` 语义。
此为能力驱动的通用规则，不得维护建筑名白名单。由于它改变既有圆代理约束的适用范围，须以真实采样反例、
约束全量批次和独立档位普查验收，不能以单个修复种子替代。

2026-10-13 关键故障收尾补充：名义半径不能直接缩小来消除碰撞。`radius` 仍可能是模型尺寸、
岸线目标及未知用地的输入；改变它会改建筑本身，甚至触发不支持的基础尺寸。已声明模型按以下能力判断：

- 地形与基础使用真实地面占地；实体间碰撞使用包含悬挑和运动范围的完整俯视投影。
  海上岛和未声明模型继续使用保守圆代理；实际投影面积只是统计量，不能替代逐边碰撞检查。
- `siteFootprintSeparation` 是联合搬迁和重叠度量的共享几何入口。真实多边形相交须返回负间隔，
  贴边为零、分离为正；不能把无符号距离零当成无重叠。同类多个实例也须检查，违例身份由两个稳定 owner id 组成。
- 联合候选保留邻居的 id/kind/yaw/shore，不得先退化成圆再排除实际可行的位置。
  缺少物理占地能力的旧消费者仍保留其代理；入口朝向最终确定后重查该姿态的干地、间距和完整路幅净距。
- 固定端点的绕行在可见性搜索时检查原路口的入射方向，包含目前只有两条腿的连续路。
  不得折回形成新锐角；既有锐角可改善，不能变差。选择安全的一侧须发生在搜索期，而非只拒绝最短路径。
- 联合让位必须同时解决被搬邻居的主网服务。原候选位置/地形/间距预算不变，可在隔离网络上补建有界地面接入路；
  门点偏移为 r+8、路线长度上限 r+30，每个必需 owner 的邻居接路终筛共用 64 次预算。
  新路须保持所有已满足的 owner 安全关系；不能因旧路距大于 r+20 就拒绝本来能补路的干燥位置。
- 岸线局部与沿岸候选阶段均在选择前检查已登记基础支撑；入水和干燥的道路冲突均可提出同一联合改路事务。
  离岸设施的桥头按全路幅检查干地，不以中心高度替代两侧路肩；历史 6 单位内移不足时，在 6–24 的有限内移候选中续试。

以上均为通用几何/能力规则，不以种子或建筑名称分支。范围是当前关键规划故障收尾；有限采样、局部候选预算
不能升级为全模型物理认证或整城累计预算/取消完成，产物继续如实保留 `degraded` 与 pending coverage。

**声明车辆通行开口（2026-10-13）**：道路穿过设施声明的通道，与从设施外侧经过不是同一种关系。
`siteRoadClear` 为跨路候选、跨路约束及地面走廊终筛提供共同的 XY 判据：普通外侧仍使用路半宽 + 3 净距；
只有两处必需车辆入口的外向法线分别背向/沿向同一连接轴、路向与轴夹角不大于 15°、
且开口附近整段全宽道路严格落在较窄入口横向范围内时，才能按声明通道而非外侧预留带判断。
任何通道提案仍须与全部地面实体保持正的路肩间隙；贴墩、超宽、横穿、偏离开口及未知模型不得使用该能力。
生成与搬迁候选在生产入口消费实际地面道路宽度及全部折线，不得拿 12 宽骨架代理给更宽宿主作安全证明。
通道外侧净距、地形/水域/坡度及路口角度规则不变；这只闭合平面通行证据，不代表拱上构件竖向净空、基础或完整车辆通行认证。

**迁移规则**：先把 8 份拷贝逐一替换成调用，**每次替换计划哈希不变**才算完成；
口径确实不同的（歌剧院深水 `> -0.8`、岸边地标含河岸 14 带）用 `opts` 显式表达，不得「顺手统一」——
统一口径是行为变更，单独一步、单独审 golden。

### 5.3 选址：SiteSpec + 候选 + 指派

**SiteSpec**（每类用地一行，`sitespec.ts`）把今天散在名义位置、`snap` 参数和十道挪动遍里的知识集中成数据：

```ts
type SiteSpec = {
  kind: SiteKind; radius: number; priority: number;           // 必需设施/通道优先预留；可选性与优先级须显式声明
  anchor: (sk: Skeleton, geo) => Vec2;                         // 名义位置（今天的 around(...) / shoreOrder[...]）
  placement: "inland-frontage" | "shore" | "offshore-island" | "straddle-trunk" | "plaza";
  hard: Array<(c: Candidate, ctx) => boolean>;                  // 一票否决：落水、压高架、贴桥头、与已落位用地重叠……
  soft: Array<{ term: ScoreTerm; weight: number }>;             // 偏好：离名义位近、正门朝路、离核心距离、天际线间距……
};
```

**候选生成**按 `placement` 分派（每类一个生成器，不再是一个通吃的同心环）：

- `inland-frontage`：沿骨架路段两侧按步长取点，中心偏移由实际路幅、模型占地/入口及退界推导，
  在可行区间有界取样，`yaw` 按实际门方向对齐道路——
  候选**生来就贴路、门朝路**，`stationDoorFacesRoad` / `stationStadiumSetback` 从约束变成构造性质。
- `shore`：沿海岸法线向内取点，深度使落水点数落在 `[1, limit]`。
- `offshore-island`：沿海岸法线向外（今天歌剧院的 40 岸点搜索），附带堤道陆地端。
- `straddle-trunk`：主干道中线上的点，`yaw` = 路向（凯旋门）。
- `plaza`：见 §5.4。

**指派**：按 `priority` 降序逐个用地，在其候选里取 `hard` 全过、`soft` 加权分最高者；
已落位用地成为后续用地 `hard` 的障碍。之后做**一轮局部交换**：对每对同 `placement` 的用地尝试互换/各自换次优候选，
总分提高才接受。全过程确定性（候选有序、平分时按候选序号）。

候选为空时**不静默回落到名义位**（今天 `snap` 失败返回 `nominal`，是 siteInWater 残留的来源之一）：
可选用地仅在 SiteSpec 明确允许时省略并记入 `plan.diagnostics.dropped`；必选用地注册
`required-site-placement`，失败不省略需求。不能仅放宽 soft 重试同一组已硬拒的候选：
须按残留闭环 SPEC §4 有界扩展 frontage/可行偏移、其它城区位置与服务路、局部联合交换。
位置、实际入口/通道、接路与占地预留一起试算和提交；海上设施还包含堤道、岸側接地和主网路径。
必需设施缺失与已落位但不可达分别诊断，修复期使用生成期同一联合指派器。
仅确认可用面积/容量不足时进入半径校正，其它失败换局部候选或明确返回阶段/预算失败。

`siting.ts::resiteViolatingSites` 退化为「用同一指派器对违例用地重新指派」——修复期与生成期同一函数。

### 5.4 骨架：核心点 + 广场 + 环线联合决定（D6）

今天：核心点打分 → 在核心放广场（`snap` 可能推开）→ 核心跟着广场挪 → 环线/主干围新核心画。
v2：核心点评分时**直接要求广场可落**——候选核心 `c` 的硬条件包含 `isDry(geo, c, 44 + 8)`
且 `landClearance(c) ≥ PLAZA_RING + 余量`，不满足的格点不参与打分。广场即核心，`civicPlazaCentred` 构造成立，
可从「求解修复」降级为「断言」。环线半径在同一步按核心离岸距离夹取，环合不拢（`ringRuns` 全被剔除）的核心降分。

### 5.5 评分 `score.ts`

`score(plan) = Σ wᵢ · termᵢ`，每项归一化到 [0, 1]，权重写在一张表里。首批项（都是现在已有守卫或用户反馈过的口味，不发明新审美）：

| 项 | 含义 | 来源 |
| --- | --- | --- |
| `siteDrift` | 用地离名义位置的平均距离 / R | 名义位置承载城市结构（车站在外环、塔在核心旁） |
| `doorAlignment` | 车站/体育场正门与路向夹角 | 「门贴路」规则 |
| `shoreHug` | 岸边地标中心离岸 / 半径，越接近 0.7 越好 | 「歌剧院应该在水边」 |
| `landmarkSpread` | 地标两两最小间距 / R | 天际线不扎堆 |
| `networkQuality` | 锐角路口、扎堆主干、断头数（加权） | 现 3 条软约束 |
| `parcelYield` | 地块数 / 目标地块数（封顶 1） | 档位面积 |

硬约束不进分数——硬约束违例的方案不比较。**分数只用于选择，不用于验收**；验收仍是约束 + 普查上限。
`scripts/city-kit/survey.mjs` 增加平均分输出，用于比较两版规划器（这正是现在做不到的事）。

### 5.6 求解

保留有限、确定性的策略调度，但以残留闭环 SPEC §6 的安全/必要需求接受规则取代旧“分数下降
或任意计数上升即拒绝”的概括。策略目录覆盖未落位设施、入口失联、非主网分量、桥头与地面关系；
每轮按受影响对象/依赖调度，不只按旧七类形态约束触发。

1. 单个候选在局部隔离草稿上联合调整网络、设施、入口与预留；一个独立区域的失败不撤销其它
   可接受区域。中间态不发布，最终草稿一次接受。
2. 安全问题以稳定对象/关系身份与严重度比较；不新增/加重，旧坏草稿只接受旧问题减少。
   已满足 required 继续满足，不能用相同总数的问题转移冒充单调改善。
3. 安全合格后按固定需求向量比较落位/可达、其它连接、冗余与容量。安全或必要需求严格改善
   优先于软分；仅在安全/需求持平时要求软分严格提高。
4. 地块/车流后置或在受影响区域重建后复验容量与已发布地址。禁止删地块取得假改善；
   临时未发布的地块身份不应阻止有真实容量证明的联合重整。
5. `MAX_SOLVE_ROUNDS` 与所有候选搜索共用累计预算；停止时区分收敛、无候选、全拒、预算耗尽
   与未支持，并保留阶段、需求及具体原因。required 未满足或安全未归零的产物不返回普通 success。

选址类策略（`frontStationsAndStadiums`、`nudgeSitesOffRoads`、`resiteViolatingSites`）在 §5.3 落地后应基本不触发；
其触发次数作为指标进入 `verify-city-solve.mjs` 报告，持续非零即说明 SiteSpec 缺了一条 `hard`。

### 5.7 半径校正（D7）

保留「按地块数放大 R」，但：

- 第一次构建后用 `parcels / buildableArea` 的实测密度直接解出目标 R，取代逐次 `sqrt` 逼近，预期重试 ≤ 1 次；
- `geography` 与 `sitespec` 不依赖 R 的部分缓存复用；
- 必选用地失败先区分候选覆盖、入口/拓扑、水域/结构、预算与真实可用面积不足；
  仅最后一类经容量证明后作为放大理由。每次重建累计预算、重新验证所有设施与路网。

先加计数测量现在的重试分布再动；若绝大多数种子 0 次重试，本节降级为可选。

## 6. 确定性与基线政策

- 所有阶段只用 `DetMath` 与 `hashSeed` 派生的随机；候选枚举、排序、平分规则必须全序（坐标平分时按候选序号）。
- 跨引擎守卫、`skipSolve` 草案确定性守卫照旧。
- **哈希基线是迁移的度量衡**：
  - 纯搬迁步（§7 步 1–3）：`city-plan-baseline` / `city-scene-baseline` **必须不变**；
  - 行为变更步（步 4 起）：允许基线变化，但必须 (a) 按同口径普查安全/required 与兼容残留棘轮，
    (b) 平均 `score` 单列报告，不以软分下降否决必要安全/可达性修复，
    (c) 人工比对 4 张整城截图（`city-scene-baseline` 的 4 个场景）后再 `--update`，提交信息写明变化原因。
  - 禁止条件反射式 `--update`。

## 7. 分步

| 步 | 内容 | 基线 | 估时 |
| --- | --- | --- | --- |
| 1 | `footprint.ts`：8 份落水判断 + 5 份最近路距离替换为共享实现（口径差异用 opts 保留） | 不变 | 0.5 天 |
| 2 | 阶段切分：`geography.ts` / `skeleton.ts` 抽出，`buildPlan` 改为调阶段函数；`RepairContext` 改成纯数据 | 不变 | 1.5 天 |
| 3 | 普查扩到 tier 1/3/5/10（每档种子数按耗时取 60/30/20/10），各档设上限；`survey.mjs` 输出平均分（先实现 `score.ts` 只读版） | 不变 | 0.5 天 |
| 4 | 核心 + 广场 + 环线联合决定（§5.4）；`civicPlazaCentred` 上限降为 0 | **变** | 0.5 天 |
| 5 | `connect.ts` 统一连接器（`CITY_ROAD_NETWORK_SPEC` 步 1–3），替换 `connectToNetwork` 与入口路/连通补边 | **变** | 2–3 天 |
| 6 | SiteSpec + 候选 + 指派（§5.3），用地落位移到骨架路网之后；删除 `cityPlan.ts:514–672` 的挪动遍 | **变** | 2–3 天 |
| 7 | 求解改违例驱动 + 不回退（§5.6）；选址类策略触发次数进报告 | 可能变 | 1 天 |
| 8 | 半径校正改进（§5.7，先测再做） | 可能变 | 0.5 天 |

步 1–3 是安全网，可随时停；步 4 独立、收益确定；步 6 是本 SPEC 的核心（治 D1+D2）；
步 5 与 6 都改 `network` 阶段，**先 5 后 6**，避免两次大幅更新基线叠在一起无法归因。

## 8. 验收

2026-10-10 新增生产门禁：完整与活动展示图都检查未接地面关系、必需设施未落位/入口可达、
主网分量、桥头连续、非法断头与真实容量；intent 的“有判定”不能替代 required 已满足。
成功、合法降级、显式失败与 pending 模型能力分开报告，失败岛继续计入分母。
新增能力的 success 要求安全/required 合格；历史非零上限仅标识兼容残留，不成为放行新版的依据。
合成、2B 回归、四档独立验收、变换/跨引擎与视觉矩阵采用残留闭环 SPEC §7。

- `cityPlan.ts` ≤ 300 行（只剩入口、半径校正、组装）；`planner/` 每个文件 ≤ 400 行。
- 用地坐标写入点从 15 处降到 2 处：`assign.ts`（生成期 + 修复期共用）与 `skeleton.ts`（广场）。
- 落水谓词只有 1 份实现（`grep -c "k < 16"` 在 planner 外为 0）。
- 普查（tier 1/3/5/10）：`siteInWater` `sitesOverlap` `civicPlazaCentred` `stationDoorFacesRoad` 全档 0；
  `acuteJunctions` `crowdedArterials` `looseInlandRoadEnds` 各档不高于步 3 时记录的值。
- 选址类修复策略在普查中的触发总数 ≤ 步 3 时的 10%。
- 性能门禁在同设备/引擎、同四档样本与源码范围建立 R0 基准后冻结，报告阶段 p50/p95、峰值
  内存、候选/几何检查与累计预算；§2 的历史耗时不能直接充当当前阈值。不减少正确性覆盖换速度。

## 9. 风险

- **视觉漂移**：用地换了生成方式，整城布局会变。对策：`siteDrift` 权重设高，名义位置仍是首选；步 6 前后各截 4 张整城图对比。
- **候选过少的小岛**：先扩展有界联合候选/局部重选；确认容量不足后才放大 R。
  单列候选耗尽、预算失败、容量重试及最终生成失败率，不从普查中移除失败岛。
- **评分权重成为新的调参黑洞**：权重表必须短（≤ 8 项），每项有来源（上表），改权重与改 golden 同等对待。
