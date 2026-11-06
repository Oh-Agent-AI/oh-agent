# 选址后置（R6）设计：候选表在路网之前，选址在路网之后

> 2026-10-14 · 状态：设计提案（**只含文档，未改任何引擎源码 / 脚本 / golden**）· 分支 `city-r6-design`（自 `city-integrate`）
> 承接 [CITY_PLANNER_REFACTOR_SPEC.md](CITY_PLANNER_REFACTOR_SPEC.md) §2 P4 与 §4 R6、[CITY_ARCHITECTURE.md](CITY_ARCHITECTURE.md) 迁移步 6。
> 锚点（`文件:行`）均核对自本分支当前树（`cityPlan.ts` 792 行，R1–R5 已落）；复现脚本在会话 scratchpad，不入库（§2.3 给出可入库的形态）。

## 0. 一句话

今天并不是「所有用地都先于路网」：**名义位置先于骨架，但骨架之后几乎全部被重新挪过**；真正卡住 `east-stadium` 的是**选址顺序**——
必需用地（车站 / 体育场）排在所有可选用地「贴路」之后，只能拿剩下的临街位，剩下的位置被公园、双子塔、庄园、车站挡满，而挪走挡路者的重试预算（≤2 个、各 64 候选）不够。
所以 R6 不必一步到位重排整条管线：**先把「候选表 + 必需用地先选」做成仅在失败时启用的回退（R6-3），东体育场即可落位**；
全面后置（R6-5…7，会改变几乎所有种子的布局）作为之后的可选里程碑，由 §8 的决策点控制。

## 1. 现状管线（`buildPlan`，`cityPlan.ts`）

| # | 工序 | 位置 | 与用地的关系 |
| --- | --- | --- | --- |
| 1 | 地理 `buildGeography`、核心点 `chooseCore` | `cityPlan.ts:116`、`:120` | 无关；`chooseCore` 的硬门保证广场 === 核心点 |
| 2 | **名义落位**：`snap` 同心环搜索 `:123`；`place()` `:150`——市政广场、观景塔、公园、港口 | `:150–:170` | **预留土地开始**：`publicSites` 入列 |
| 3 | **地标抽签 + 名义落位**：候选池、`random(\`landmark${n}\`)` 抽签 `:251`、海滨固定地标 `:220–:246`、`snap` | `:174–:262` | 抽签与路网无关；位置是名义位置 |
| 4 | `reservations()` `:264`；`declaredSiteDemands` `:144`、地标入需求 `:285` | | 之后**每个**造路步骤都读它 |
| 5 | **骨架** `buildSkeleton` | `:294`（入参只放 civic / harbor / 带 access 者 `:291`） | 骨架只受 civic + harbor 影响（`skeleton.ts:182` 干道止于岸边用地、`:202` 走廊避让预留）；其余用地未参与 |
| 6 | **用地临街 + 联合站点** `frontSitesAndAssignJointSites` | `:306` → `siteFrontage.ts:50` | 见下方展开 |
| 7 | 海滨带 + 滨海大道 | `:312`；`seasideBoulevard.ts:54` 读 `publicSites + landmarks` | 大道避让岸边用地 |
| 8 | 环岛滨海路 + 河岸路 | `:316`；`coastalRingRoad.ts:57,:85`（预留 +8） | 避让 |
| 9 | 扇区街网 `buildSectorBlocks` | `:362`；`sectorBlocks.ts:161`（与预留相交的**整块街区被丢弃**）、`:196`（角点离预留 < r+9 被丢弃） | 土地被「圈起来」是在这里发生 |
| 10 | 街网缝合 | `:367` | 连接器的 `directPolicy` 带 `sites: world.reservations()`（`connect.ts:143`） |
| 11 | **用地入口路 / 堤道** + 孤立分量接入 | `:378` → `siteEntrances.ts:56`；`connectGeneratedComponents` `:388` | **为用地而存在**（门前要有路，`siteWithoutDoorRoad`） |
| 12 | **尽端环路** | `:467` → `loop.ts`（体育场 / 公园类服务环） | **为用地而存在** |
| 13 | 碎边合并 | `:498` | 读 `publicSites` 保护站点节点 |
| 14 | **断头路收尾** | `:555` → `deadEnds.ts:26`（`sitesForGate`） | 部分为用地：门口断头不删 |
| 15 | **必需用地回访**（post-growth） | `:560–:598` | **为用地而存在**：路网长出来后只对「未落位」的必需用地再 `assignConnectedSite` 一次 |
| 16 | 桥头落地环 | `:604` → `landing.ts:195`（`sites: reservations`） | 为桥而存在，只是避让用地 |
| 17 | `solvePlan` + 派生 | `:616–:621`；策略表 `solve.ts:177` | 用地相关策略见下 |

**第 6 步展开**（`siteFrontage.ts`）：避高架 `:59` → 岸边内移 `:62` → 跨路（凯旋门）`:68` → 临街 `:69` → 重贴干地 `:72` → 港口贴岸 `:75` → 岸边地标贴岸 `:78` → 歌剧院离岸 `:81` → 对 `central-station`、`east-stadium` 逐个 `assignConnectedSite`（`:84–:85`）；
败于「用地间距」时走一次让位重试 `:88`（`moveOptionalSites` `:116`：被挡者 ≤2 个 `:154`，各取前 64 个重定位候选 `:179`）。

**solve 里专为用地存在的修复**（`solve.ts`）：`frontStationsAndStadiums` `:221`、`orientStationDoors` `:222`、`resiteArchesOnAcceptedRoads` `:223`、
`resiteUnservedShoreSites` `:224`、`nudgeSitesOffRoads` `:225`、`nudgeSitesWithAccessRepair` `:226`、`detourAroundSites` `:231`、`jointJunctionSite` `:194`、
`resiteWetShoreSites` `:266`、`resiteViolatingSites` `:270`；`unservedShoreCandidates` 内的 `resiteGroundJointRoad` `:149–:150` 是 `jointSiteRoad.ts` 唯一的调用点。

**已经存在的候选表雏形**（R6 要利用而不是重造）：`sitespec.ts` 的硬 / 软判据登记表（`INLAND_HARD` `:133`、车站 `:163`、体育场 `:177`、`nominalAnchorPoint` `:299`）、
`access.ts` 的候选生成（`inlandFrontageCandidates` `:142`、`candidatesFor` `:255`）与硬闸门 `siteCandidateHardReject` `:270`、`assign.ts` 的 `assignSite` `:85` / `runAssignment` `:109`
（**生产管线至今未用 `runAssignment`**，只有 `verify-city-sitespec.mjs` 用）、`jointSite.ts` 的分层候选（`JOINT_SITE_CONFIG` `:15`：frontage 64 → fallback 区域 8 圈 × 16 向 → outer 8 圈 × 24 向）。

## 2. 根因：`2005655366` · 1 档 · `east-stadium`

### 2.1 复现数字（本分支，`createCityPlan(2005655366, 1, MIAMI_COASTAL)`，R=390，1.4–1.6 s）

`siteObligations`：`central-station` 落位（`routeRetries: 2`）；`east-stadium` **未落位**。`verify-city-planning` 在 `scripts/verify-city-planning.mjs:135`（「seed 2005655366: required station and stadium must be jointly placed，1 !== 2」）变红，整条守卫耗时 5 分 51 秒才到这里。同一循环里 `2005864824`、`2005969553` 均落位（已单独验证），所以**这是唯一一个红点**。

三层候选统计（`assignConnectedSite`，`jointSite.ts:112–140`）——与任务给出的数字一致：

| 层 | 候选 | 淘汰原因（首个不过的判据，计数） |
| --- | --- | --- |
| primary（frontage 64 × 3 探针） | **192** | `trunk-clearance-r+8`=**96**、`dry-footprint`=41、`site-spacing(+10)`=26、`buildable-center`=24、`land-clearance-r+4`=5 |
| fallback（区域点） | 353 | trunk=122、buildable=113、dry=78、spacing=32、land=6、`no-target-outside-route-bound`=2 |
| outer（外圈） | 30 | spacing=13、buildable=10、dry=7 |
| 让位重试（`moveOptionalSites`） | 192 / 353 / 30 | 同上，另有 `site-relocation-refused(ownerSpacing=true…)`：被挡者 `landmark:twin-towers`、`riverside-park`，重定位候选里 `site-spacing(+10)` 276 / 716、`trunk-clearance` 113 / 490 全灭 |
| 路网长出来后回访（`cityPlan.ts:560`） | 512 / 753 / 28 | 仍失败（多出 `road-intersects-site-footprint` 14–15） |

### 2.2 反事实：谁是真正的瓶颈（scratch 探针，拦截首轮 `assignConnectedSite`；该探针用全部宽 ≥8 的非桥边，候选 232，与生产的 192 略有出入，只看比例）

| 去掉的条件 | 通过候选数 | 说明 |
| --- | --- | --- |
| 无（现状） | 0 | trunk=106、dry=55、buildable=37、spacing=26、land=8 |
| 只去掉其它用地（`placed=[]`） | **26** | 这 26 个**恰好是**「只败于间距」的那批 |
| 只去掉干道净空 | 0 | 全部转败于间距（132） |
| 两者都去掉 | 132 | |

这 26 个「只败于间距」的候选，挡路者分布：公园 6、公园+车站+双子塔 11、车站+双子塔 1、车站+双子塔+庄园 7、双子塔+庄园 1。
`trunk-clearance` 的 96 个**不是**离宿主干道近——候选恒在宿主干道侧向 r+12=61 处（`access.ts:170` `offset = spec.radius + 12`，宿主距离 min/max 都是 61.0），而是被**另一条**干道（相邻放射干道 / 弯折）压进 r+8=57 以内。

### 2.3 结论

1. 判据按固定顺序「首败」计数（地形 → 干道净空 → 高架 → 间距），所以 26 个间距败者的意思是：**它们已经通过了全部地形与骨架条件**。体育场不是无地可放，而是**可放的位置被已落位的可选用地占满**。
2. 间距挡路者里，公园 / 双子塔 / 庄园都是 `relocatable` 的可选用地，只因排序在后（`siteFrontage.ts:84` 的 `jointSiteProgramme` 在 `:59–:81` 所有可选用地贴路之后）而没有让位的机会。让位重试（`:88`）逐个候选只挪 1–2 个「被挡者」，其余挡路者纹丝不动，且被挡者**在已定局的骨架 + 其余用地下没有任何硬判据全过的重定位候选**（日志里 `riverside-park:no-hard-admissible-candidate`、`landmark:twin-towers:no-hard-admissible-candidate`；`siteFrontage.ts:180`）——它们的重定位候选同样被干道净空（113–490 个）与间距（276–716 个）吃光。要同时挪 3 个（公园 + 双子塔 + 庄园）则直接超预算（`:154`）。
3. 干道净空（占候选的约一半）是骨架的函数，与用地无关——**候选表必须在骨架之后评估这一项**；它决定了「先选址再造路」不可行，也解释了为什么表只能做成「路网无关条件 + 选址时再补路网相关条件」两段。
4. 因此根因是 **P4 的变体**：约束在更早的步骤里已被消耗（间距），而后续步骤只能在残局上修补。**不是**候选生成器太窄（fallback / outer 已是 8 圈 + 8 圈的格点）。

### 2.4 30 个基线岛的普查（已测，`createCityPlan` × 30，耗时约 5 分钟）

- 必需用地全部落位，`routeRetries` 全为 0——**30 岛基线与东体育场失败路径互不相交**（R6-3 的「基线必须不变」成立的前提）。
- 为用地服务的 solve 策略，30 岛中真正改过东西的：`nudgeSitesOffRoads` 6 岛、`resiteArchesOnAcceptedRoads` 2 岛、`resiteWetShoreSites` 2 岛、`resiteUnservedShoreSites` 1 岛；`resiteGroundJointRoad`（`jointSiteRoad` 的唯一调用）**0 岛**，`frontStationsAndStadiums`、`orientStationDoors`、`detourAroundSites`、`jointJunctionSite` 也是 0 岛。
- 含义：`jointSiteRoad` 在基线上没有触发，删除它在统计上很安全，但**基线只有 30 岛**，R6-0 要在更大种子集上重测才能作为删除依据（§4 R6-6）。

可入库的复现形态（R6-0）：`scripts/diagnose-city-site-candidates.mjs <seed> <tier>`——拦截 `jointSite.assignConnectedSite`，输出上面两张表；放在 `diagnose-*` 一族（不进 `verification-manifest.json`）。

## 3. 目标设计

### 3.1 三段式

```
A 候选表（路网之前）      地形 / 水 / 河 / 朝向 / 净空的「路网无关」硬条件  → 每个 SiteSpec 一张表，确定性、可缓存
B 骨架 + 街网（不变）     buildSkeleton 恒为一次；骨架只吃 civic + harbor（现状已如此）
C 选址（路网之后）        在「表 ∩ 路网相关条件」里按波次选；选中即带接入路（assignConnectedSite 的泛化）
```

**表的内容（每行 `SiteCandidateRow`，沿用 `access.ts:29` 的 `SiteCandidate`）**：`id`、`x`、`z`、`yaw`、`source`，外加预先算好的路网无关量：

| 类别 | 条件 | 现有谓词 |
| --- | --- | --- |
| 干地 | `buildable-center`、`dry-footprint`（`isDry`）、`land-clearance-r+4` | `access.ts:280–282`，`footprint.ts` |
| 离水 / 河 | 岸边类：`wet-budget-3-riverbank`、`coast-distance-0.7r`、`height-above-0.5`、`not-in-river`；海上岛：`deep-water-ring`、`causeway-land-dry` | `access.ts:285–299` |
| 朝向（路网无关部分） | 岸边类 `coast-parallel-face`、山地 `hillside-setting` | `sitespec.ts` 软偏好 |
| 软分属性 | 离名义锚点距离（`nominalAnchorPoint`）、离岸 / 离河距离 | `assign.ts` `softScore` |

**留到选址时再判的（路网相关）**：`trunk-clearance-r+8 / r+4`、`clear-of-highways`（环线只取决于核心点与半径，可前置，但保持与现状同口径放选址段）、`others-spacing-r+10`、`not-near-bridge-end`、`harbor-distance-120`、门前路距离（`spec.radius+20`）、朝路朝向（`planarAccessPose`）、接入路可达（`runConnection`，`jointSite.ts:93`）。

表的生成用**固定格点**，不用随机：沿用 `snap`（`cityPlan.ts:123`）与 `JOINT_SITE_CONFIG` 的「圈 × 向」结构——环 `ring` ∈ [0,60]、步长 12、角度 `k/steps·2π + ring·0.37`，id = `site:${kind}:${ring}:${k}`。岸边类沿岸线按弧长等距取点，id = `shore:${kind}:${i}`。

### 3.2 选址波次

| 波次 | 对象 | 位置（目标） | 理由 |
| --- | --- | --- | --- |
| W0 必需 | `central-station`、`east-stadium`（`declaredSiteDemands` 的 required 站点） | 骨架之后、任何可选用地贴路之前 | **直接修东体育场**：优先占用最稀缺的临街位 |
| W1 岸边 | 港口、灯塔、歌剧院、摩天轮、庄园（`coastalSitingKinds`） | W0 之后、海滨大道（`:312`）之前 | 海滨大道与环岛路读它们；岸线是一维资源 |
| W2 内陆可选 | 观景塔、公园、电视塔、双子塔 / 扭转塔、凯旋门（跨路）、宝塔 | **街网缝合（`:367`）之后** | 真正的「后置」：街网不再绕它们；大于街区的用地靠「删路段」让地 |

同一波次内按 `(spec.priority, kind)` 升序（`runAssignment` 同口径，`assign.ts:109`）；候选按 `softScore` 降序、id 升序（`assign.ts` 现有 tie-break）。

### 3.3 允许的修复手段（封闭集合）

| 手段 | 含义 | 现有实现（复用，不新写） |
| --- | --- | --- |
| M1 表内换位 | 同一用地在候选表内换一行；联合搜索被挡者，预算 ≤2 个 | `moveOptionalSites`（`siteFrontage.ts:116`）泛化 |
| M2 补一段路 | 接入路 / 绕行 / 有界 A* | `runConnection` 策略 `direct-projection / node-merge / detour / grid-astar`（`connect.ts`） |
| M3 删一段路 | 仅非桥、非主网锚点、不致断连的段，带三道保险 | `networkRepairs.ts`（`resolveCrowdedArterials`、`pruneShortSpurs`） |
| M4 绕行 | 路绕过占地 | `detourAroundSites`（`repairs.ts:173`）、`declaredOwnerDetour`（`jointSiteRoad.ts:66`） |

**禁止**：重新生成骨架（`buildSkeleton` 全程恰好调用一次；守卫见 §4 R6-5 门）；降低硬判据换取落位（与 `connectGeneratedComponents` 注释里「禁止用降低硬约束换连通」同一原则）；扩半径 / 加预算后冒充通过；静默丢弃必需用地。

### 3.4 事务

所有选址 / 让位都在**暂存草稿**上做，成功才 `commitNetwork`（`network.ts`，R4）+ 一次性换 `publicSites` / `landmarks`（`siteFrontage.ts:236` 的 `patches` 模式已是如此）。多用地联合让位要么整体提交，要么零副作用——这是回退不留残局的前提。

## 4. 分阶段迁移

每一阶段单独一个分支、单独合并、可单独 `git revert`。**行为变化类阶段的提交绝不与重构类阶段混在同一提交。**

| 阶段 | 内容 | 性质 | 回退 |
| --- | --- | --- | --- |
| R6-0 | 观测：`diagnose-city-site-candidates.mjs` + 「谁落位了必需用地」普查 | 不改引擎，哈希恒等 | 删脚本 |
| R6-1 | 拆谓词：`siteCandidateHardReject` → `siteTerrainReject` + `siteRoadReject`，原函数 = 二者按原序组合 | **重构，哈希恒等** | revert |
| R6-2 | 候选表生成 `planner/siteTable.ts`，只被诊断与守卫使用 | 重构（新增未接线代码），哈希恒等 | revert |
| R6-3 | **必需用地先选回退**：现状两次尝试都失败后，才启用表驱动的联合选址 | **行为变化，仅限失败路径** | 一个开关常量 + revert |
| R6-4 | 删除被 R6-3 取代的补丁（回访循环 `cityPlan.ts:560–598` 等） | 行为变化（仅当普查证明其确有触发），否则重构 | revert |
| R6-5 | W0 前移：必需用地先于可选用地贴路 | **行为变化，全种子** | revert |
| R6-6 | W1：岸边用地表驱动、海滨大道之前；删 `jointSiteRoad` 的节点重定位 | **行为变化，全种子** | revert |
| R6-7 | W2：内陆可选用地后置到街网之后；街网不再绕它们 | **行为变化，全种子，最大** | revert |

建议停在 R6-4（§8 Q1）；R6-5…7 是否做由决策点控制。

### R6-0 观测（不改引擎）
- 入库 `scripts/diagnose-city-site-candidates.mjs`（§2.3），并输出普查：对 30 个基线岛 + 追加种子，记录每个必需用地是由 **首次联合选址 / 让位重试 / 回访循环（`:560`）** 中哪一步落位；统计 solve 里 §1 所列「为用地」策略各触发多少次、`resiteGroundJointRoad` 触发多少次。
- 这些数字决定 R6-4 能删什么、R6-6 的 `jointSiteRoad` 删除是否安全——**先量再删**。
- 门：无引擎改动；`git diff --stat` 只含新脚本。

### R6-1 拆谓词（哈希恒等）
- `access.ts:270` 的判据顺序是：内陆 `buildable → dry → land → trunk → ring → spacing`；岸边 `wet → coast-distance → height → not-in-river → trunk → bridge-end → ring → spacing`；海上岛 `deep-water → causeway-land → harbor-distance → spacing`。**拆分点沿用这个顺序切**：前半归 `siteTerrainReject`，后半归 `siteRoadReject`；组合函数按原序返回**同一个首败字符串**（诊断串被 `siteObligations.reason` 与守卫引用）。
- `siteCandidateHardReject`、`SiteCandidateWorld`、`SiteCandidate` 的名字 / 签名 / 导出不变（§6）。
- 门：`verify-city-baseline` 30 岛哈希不变；`verify-city-sitespec`（登记表完整性 + `runAssignment` 确定性）；`verify-city-joint-frontage`；`verify-city-required-placement`；`verify-city-access-capabilities`；`tsc`；`verify-city-import-boundary`。
  另加一条守卫：对 30 岛 × 各 spec 的全部候选，新旧函数的返回串逐一相等（旧函数以测试内联副本保留一个阶段）。

### R6-2 候选表（哈希恒等，未接线）
- `planner/siteTable.ts`：`buildSiteTable(geo, spec, cfg)`，只调 `siteTerrainReject`，结果按 `(geo 指纹, kind)` 进程内缓存（`memoizeTerrain` 先例，`createCityPlan` 的 `opts.memoizeTerrain`）。
- 守卫「召回」：对 30 岛，**今天最终落位的每个用地**必须落在其表内（或表内存在距其 ≤ 格点间距的行）；表不是单向压缩。同时记录建表耗时，预算 ≤ 现规划耗时的 10%。
- 门：哈希不变；新守卫；`verify-city-cross-engine`（V8 与 JSC 一致，§5）。

### R6-3 必需用地先选回退（行为变化，仅失败路径）
- 触发条件：`siteFrontage.ts` 里首次 `assignConnectedSite`（`:85`）**且**让位重试（`:237`）都失败。此前任何成功路径逐字不变。
- 新路径：把所有 `relocatable` 的可选用地暂时从 `placed` 中移出（只保留 civic、harbor、带 access 者，即 `fixed`），用表驱动的 `assignConnectedSite` 为必需用地选位；成功后，被挤出的可选用地**按表**重新落位（候选按「离原位距离, id」升序，≤ `SITE_SELECT_CONFIG` 预算；整体暂存、原子提交）；任一可选用地无处可放则整体放弃、回到现状失败（不比现在更糟）。
- 预期哈希影响：**30 个基线岛应全部不变**（基线种子都是 `1703294958 + i·7919`，必需用地全部在首次或让位重试落位；`2005655366` 不在基线内）。若有任何基线岛变化，视为设计缺陷，不接受「更新基线」。
- 因为基线覆盖不到失败种子，**新增 outcomes 型 golden** `golden/city-site-obligations.json`：约 60 个种子 × 1 / 2 档，只记录 `{ownerId, placed, 位置量化到 1}`——小、可读、能被审阅（§8 Q4）。
- 门：东体育场落位；`verify-city-planning` 转绿（该守卫的唯一已知红点）；`verify-city-baseline` 30/30 不变；新 golden 仅 `2005655366/t1` 的 `east-stadium` 与被挤出的可选用地有差异（逐条人工核对位移与间距）；`verify-city-required-placement`、`verify-city-joint-frontage`、`verify-city-shore-plot-access`、`verify-city-causeway-primary`、`verify-city-villa-placement`、`verify-react-city-seaside`；`verify-city-solve`、`verify-city-repair-safety`、`verify-city-constraints`。

### R6-4 删除被取代的补丁
- 候选：回访循环 `cityPlan.ts:560–598`（约 40 行 + 对 `assignConnectedSite` 的第三次调用）。仅当 R6-0 普查显示它在所有普查岛上**零次**是落位的唯一来源，且 R6-3 已覆盖该种子，才删；否则保留并在本文登记原因。
- `jointSiteRoad.ts` **不在本阶段删**：它的唯一调用点是岸边用地湿地重定位（`solve.ts:140–152`），R6-3 不触及（见 R6-6）。
- 门：同 R6-3；删除后 `verify-city-baseline`、新 golden 与 `verify-city-planning` 仍绿。

### R6-5 W0 前移（行为变化，全种子）
- `siteFrontage.ts:84` 的联合选址移到 `:59` 之前：必需用地先于任何可选用地贴路；可选用地的各遍（`:59–:81`）在 `placed` 里已含车站 / 体育场。R6-3 的回退随之成为主路径。
- **所有基线岛的 `sites` / `roads` / `blocks` 分区哈希预期变化**（可选用地的间距参照变了，车站接入路更早出现）。
- 门：**基线重建**——先 `verify-city-baseline --diff` 逐岛、逐分区审阅（用 `scripts/diagnose-city-site-diff.mjs` 列出每个用地的位移，R6-5 内新增，不入 manifest），再 `--update`，**更新基线单独一个提交**，提交信息写审阅结论；`verify-city-scene-baseline`（已有约 190 个分区漂移，不能作闸门，只记录前后计数）、`verify-city-landmark-baseline`、`verify-city-radius` 与 `verify-city-layout-capacity`（容量不得下降）；§6 的编辑器守卫全部。
- 还要加一条守卫：`buildSkeleton` 的产物（`trunks / bridges / ringRuns`）在选址前后逐字相同（`skeleton` 分区哈希 + 直接比较），证明「修复不得重新生成骨架」。

### R6-6 W1 岸边用地表驱动（行为变化，全种子）
- 港口 / 灯塔 / 歌剧院 / 摩天轮 / 庄园改为表驱动，选址在 `buildSeasideBoulevard`（`:312`）之前；歌剧院的 `sailOperaCandidateSets` 并入表（`siting.ts:209`）。
- 删除 `jointSiteRoad.ts` 的节点重定位（`prepareJointSiteRoadRelocation` `:72`、`relocateSiteWithGroundRoads` `:212`、`JOINT_NODE_RELOCATION_CONFIG` `:21`）及 `solve.ts:149–150` 调用；**保留** `declaredOwnerDetour`（`:66`）作 M4 绕行原语。`verify-city-joint-site-road` 随之裁剪到保留的函数。条件：R6-0 普查里 `resiteGroundJointRoad` 在 W1 之后为零。
- 门：同 R6-5 全套 + `verify-city-sitespec`（登记表）、`verify-city-model-ground`、`verify-city-villa-*`、`verify-react-city-seaside`；基线再次重建（单独提交）。

### R6-7 W2 内陆可选用地后置（行为变化，全种子，最大）
- 内陆可选用地不再进入 `reservations()`（街网生成阶段）；`sectorBlocks.ts:161,:196` 的「整块丢弃」对它们失效；街网缝合（`:367`）之后统一选址，用地大于街区时以 M3 删路段让地（带 `networkRepairs` 三道保险）。
- 可随之删除或收缩：`connectSiteEntrances` 里内陆用地的逐用地入口路（岸边 / 堤道保留）、`deadEnds.ts` 的 `sitesForGate` 参数、`loop.ts` 的服务环（仅当普查证明体育场 / 公园的服务环形态不再出现）、solve 里 `nudgeSitesOffRoads` / `nudgeSitesWithAccessRepair` / `detourAroundSites` 中仅为用地服务的分支。
- 风险最高（§7）：街区形态、地块容量、半径校准（`createCityPlan` 的 `maxRetries: 4` 重建循环 `cityPlan.ts:95`）全部受影响。
- 门：同 R6-5 + `verify-city-planning` 的 `acute / inside / far / loose` 总量不得高于当前阈值（`verify-city-planning.mjs` 末尾断言）+ 容量与半径守卫；基线重建单独提交。

## 5. 确定性规则（I2 / I3）

1. **不新增、不改动、不重排任何已有 `random(key)`**。现有调用点：`cityPlan.ts:80–87`（岛形、生态）、`:138`（`siteTurn`）、`:202`（`miami-skyline`）、`:251`（`landmark${n}`）、`:487,:495`（树）、`sectorBlocks.ts:88–102`、`skeleton.ts:134–140`。**地标抽签（哪几种地标）保持在原位置、原键、原序**；R6 只改「抽中的地标放在哪」，所以抽签结果恒定。
2. 候选表**不使用随机数**：格点（环 × 向）与沿岸等距点全是整数下标的纯函数；若确需抖动，只能新增键 `` `${seed}:siteTable:${kind}:${rowId}` ``（`hashSeed` 无状态，新增键不扰动旧键）。
3. **迭代序**：表按 `(spec.priority, kind)`（`assign.ts:109`），行按 `(softScore 降序, id 升序)`（`assign.ts` 现有 tie-break）；对 `network.edges` 取子集一律先按 id 排序（`jointSite.ts:45` 先例），不依赖 `Map` / `Set` 插入序；`patches` 之类的 Map 只做查找。回溯搜索的候选下标序固定，预算常量放进版本化配置 `SITE_SELECT_CONFIG = { version: 1, … }`（仿 `JOINT_SITE_CONFIG` `jointSite.ts:15`）。
4. **I3**：所有新文件首行 `import { DetMath as Math } from "../detMath"`；不得出现全局 `Math.hypot/atan2/sin/cos`；坐标落表前量化到 0.01（`access.ts:174` 的 `Math.round(·*100)/100`），消除跨引擎末位漂移。
5. **候选排序如何做到确定**：生成顺序固定（环、向、弧长下标）→ 逐行打 id → 硬判据过滤（纯函数）→ 软分 `softScore`（纯函数，DetMath）→ `sort((a,b)=> b.score-a.score || (a.id<b.id?-1:1))`。比较里不出现浮点相等判断（距离相等一律落到 id）。
6. 缓存必须**纯**：有无缓存结果逐字相同（守卫：同一岛关缓存再算一遍，哈希相等）。
7. 门：`verify-city-cross-engine`（V8 vs JavaScriptCore，30 岛）必须覆盖新模块；每个阶段跑一遍。

## 6. 编辑器线的依赖（必须保持源码兼容）

| 依赖 | 位置 | R6 约束 |
| --- | --- | --- |
| `checkSitePlacement`（生成器 / 编辑器边界，按街区真实面判占地） | `cityLayout.ts:668`；被 `planSites.ts:22,:178` 的 `siteMoveProblem` 用 | **不改**。它是布局层谓词，与 `planner/access.ts` 的规划层谓词是两套，R6 不合并 |
| 从 `./cityPlan` 取几何小工具 | `planPatch.ts:28`（`clearsHighways`, `roadNodeId`）、`planSites.ts:24`（`clearsHighways`）、`planRoadRules.ts:19`（`polygonDistance`, `roadNodeId`） | `cityPlan.ts:48–49` 的 `export … from` 重导出必须保留（R1 的 I4） |
| 编辑器对 `engine/planner/` 的值导入 | `verify-city-import-boundary.mjs` 的 `EDITOR_PLANNER_WHITELIST`（当前为空） | R6 **不得**给编辑器新增对 `planner/` 的导入；若要共享（Q6），先在白名单登记 |
| 规划层谓词导出 | `siteCandidateHardReject`、`candidatesFor`、`SiteCandidateWorld`、`assignConnectedSite`（`access.ts`, `jointSite.ts`）被 `verify-city-sitespec / joint-frontage / required-placement` 导入 | R6-1 保持名字、签名、返回串；只新增导出 |
| 用地数据形状 | `PublicSite {id,kind,x,z,radius,yaw,access}`（`cityLayout.ts:76`；`PlotAccess` `jointSite.ts:13`）、`Landmark`、`siteObligations` | 字段只增不删；`id` 稳定（`landmark:<kind>`、既有公共用地 id）——`planRemap.ts` 按锚点 + `SITE_MATCH_RADIUS=40` 找新档里的同类设施 |
| 已存补丁 | `planPatch.ts` 的失效机制（`tier-changed`、`site-changed`、`pruneStalePatch`） | R6-5…7 会让**用户已存的修路 / 搬家补丁大面积失效**（用地与街网都变了），见 Q5 |

每个阶段合入前，在编辑器线运行：`verify-plan-sites`、`verify-plan-repair-controller`、`verify-plan-patch`、`verify-plan-remap`、`verify-plan-bulldozer`、`verify-plan-road-rules`（R6-1/2 之外的阶段必跑；R6-1/2 为哈希恒等，跑 `verify-plan-sites` + `verify-plan-repair-controller` 即可）。

## 7. 风险与明确不做

**风险**

| 风险 | 阶段 | 缓解 |
| --- | --- | --- |
| 基线覆盖不到失败种子（`2005655366` 不在 30 岛里） | R6-3 | 新增 outcomes 型 golden（Q4）；R6-3 约定「基线 30 岛必须不变」 |
| 拆谓词改变首败字符串，诊断 / 守卫引用漂移 | R6-1 | 新旧逐候选对账守卫 |
| 候选表召回不足（窄岛、1 档 R=390，车站 r=46 / 体育场 r=49 很大） | R6-2 | 召回守卫；格点间距不大于 12，与 `snap` 同 |
| 建表耗时 | R6-2 | 预算 ≤10% 规划耗时；`bench-plan-editor.mjs` 风格的前后对比 |
| 容量下降触发半径校准重建（每次 `buildPlan` 约 1–4 s） | R6-7 | 容量 / 半径守卫是闸门，不是记录 |
| 审阅疲劳：基线重建后 30 岛 × 6 分区全变 | R6-5/6/7 | 先出用地位移表（`diagnose-city-site-diff`），逐岛看，不整体 `--update` |
| `verify-city-scene-baseline` 已漂移（约 190 分区），无法证明视觉不变 | R6-5…7 | 前后计数对比 + 人工抽查几个岛的截图 |
| 与编辑器线冲突（`siteFrontage.ts` 被两线触及） | 全部 | 本设计不碰编辑器文件；合并按既有流程只取已提交版本 |

**明确不做**

- 不重新生成或改造骨架（`buildSkeleton` / `chooseCore` 不动）；不改锐角阈值（CJJ 37 的 70°，见 REFACTOR_SPEC §7）；不改海滨带 / 滨海大道的生成算法，只改它读到的用地来自何时。
- 不动 F1 路网（CITY_ARCHITECTURE 迁移步 8）、不动会话楼语义、渲染、地块（`roadBlocks` / `roadFaces`）算法。
- 不动半径校准的判据（`nextCalibrationRadius`）；不用「放大岛」当落位手段。
- 不做编辑器侧改动；不让编辑器与规划层共用 `siteCandidateHardReject`（Q6 仅作为可选后续）。

## 8. 待决问题（需要你拍板；每条给我的建议）

| # | 问题 | 建议 |
| --- | --- | --- |
| Q1 | **范围**：做到 R6-4（修东体育场 + 删回访循环）就停，还是继续 R6-5…7 的全面后置？ | **停在 R6-4。** 成功判据里「体育场落位、守卫转绿」只需 R6-3；全面后置会让所有种子的布局和用户已存补丁失效，应由 R6-0 普查出的**第二类失败**来驱动，而不是为了架构整洁 |
| Q2 | **谁能让位**：为必需用地，哪些可选用地允许被挪、最多挪多远？ | 仅 `relocatable` 的可选用地；每个必需用地最多挤出 2 个（沿用 `siteFrontage.ts:158` 的预算）；位移 ≤ 2.5×半径；位移写入 plan 的加性字段 `siteDisplacements`，供审阅 |
| Q3 | **仍放不下**：必需用地最终无处可放，是失败、扩岛、还是丢弃某个可选用地？ | **保持显式失败**（`siteObligations.reason` + `planningOutcome`），**不静默丢用地、不扩岛**；这与现状 `declaredSiteDemands` 里「承诺不能消失」的守卫一致 |
| Q4 | **基线种子集**：是否新增 outcomes 型 golden（~60 种子 × 1 / 2 档）？ | 是。`golden/city-site-obligations.json` 只记 `{ownerId, placed, x, z 量化}`；30 岛哈希基线不扩（成本太高） |
| Q5 | **已存补丁**：R6-5…7 之后用户的修路 / 搬家补丁如何处理？目前没有生成器版本号，只有 `tier-changed` | 若做 R6-5…7：补丁加生成器版本戳，版本不符时按 `tier-changed` 同一原则整份作废并如实提示。R6-3/4 只影响失败种子，不需要 |
| Q6 | 是否把 `siteTerrainReject` 暴露给编辑器的自由级搬家（`planSites.ts:240` `autoPlaceFree` 目前自行近似）？ | 是，但**单独一个跨线提交**，在 `EDITOR_PLANNER_WHITELIST` 登记一行；不在 R6 内做 |
| Q7 | R6-3 若使 30 个基线岛里任何一个的哈希变化怎么办？ | 视为实现缺陷（它应仅走失败路径），修实现，**不更新基线** |
| Q8 | `jointSiteRoad` 的节点重定位何时删？ | 只在 R6-6，且仅当 R6-0 普查里它在 W1 之后触发为 0；`declaredOwnerDetour` 保留 |
| Q9 | `verify-city-planning` 太慢（本次实测到首个断言失败就用了 5 分 51 秒）。红点修好后是否拆分，让必需用地回归独立成快速守卫？ | 是：把 `verify-city-planning.mjs:115–:145` 的必需用地回归抽成独立脚本进 manifest（秒级），长守卫保留给全量 |
| Q10 | 归属与节奏：R6-0…4 由 city-opt 线执行，是否排在 R5 余下步骤（6b 之后）之后？ | R6-0/1/2 与 R5 无冲突可并行；R6-3 起等 R5 合并完，避免对 `siteFrontage.ts` 双线改 |
