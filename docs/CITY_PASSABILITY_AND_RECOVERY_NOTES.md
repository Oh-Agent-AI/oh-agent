# B3：逐路通行审计（RoadPassabilityAudit）与安全恢复（SafeRecovery）

日期：2026-10-16。基线 `01cfae34`。接 [B2 跨层 portal 与固体碰撞](CITY_PORTALS_AND_COLLISION_NOTES.md)。

分工：B（本文两个模块、对应守卫）由主线维护；C（`DrivingSimulation.ts`、`DrivingKernel.ts`、`CollisionIndex.ts` 的接触推进、有界滑动、路面距离）由另一方负责。本轮**只消费** C 的现有接口，没有改动它们。共享接口如需调整，由提出方记录兼容方式。

## 交付：每条审计路线返回三种结果之一，并绑定世界版本

`game/driving/audit/RoadPassabilityAudit.ts`（纯 CPU）：

| 结果 | 只能从哪里来 |
| --- | --- |
| `passed` | 动态试跑通过，且固体覆盖完整 |
| `blocked` | 带见证（witness）的静态证据 |
| `inconclusive` | 其余一切，带原因（`pilot-failed`、`route-deviation`、`simulation-invalid`、`budget-exhausted`、`unconfirmed`） |

每个结果带 `worldRevision`、`AuditKey`、`auditVersion`，以及给 `evaluateAuditRelease` 用的 `StaticUnitEvidence`（每个单元一条）。

### 世界绑定

- `passabilityWorld(snapshot, regions, isCurrent)`：输入是 `CitySurfacePort` 的 `readWorld()` 冻结快照。`regions.revision` 必须等于快照的 surface revision。
- `auditRoute` 要求 `key.baseSnapshotHash === worldRevision`，否则返回 `inconclusive: key-world-mismatch`。
- 返回前再查一次 `isCurrent()`：世界在审计途中变了，任何结论都降为 `inconclusive: stale-world`。
- `auditCapture(capture, keyFor, routes)` 直接接宿主 capture。守卫里走 CityParts 真实的显示冻结租约（`acquireDrivingWorldSource`）；释放租约后 capture 立即不再是当前的。

### 静态证据（可认证的「挡住」）

1. **拓扑**：起点和出口点不在同一个区域 → `blocked: topology-disconnected`。区域是分类器的连通分量（portal 已并入），验证器禁止换区域，所以这是证明，不需要试跑。
2. **几何截面**：沿合法走廊的直段每 0.5 取一条横截线，横截线跨满走廊宽度。
   - **可行驶区间**：用该层的区域边界线段精确切分，每段中点用唯一分类器判定。
   - **扣掉精确结构固体**：车身高度带内（支撑面上 0.16–1.19，两端各让出 0.06 的拟合残差）被固体占住的点不算可行驶。只按采样点扣（0.05 一个），没采到的点算空，所以只会少扣，不会多扣。
   - **判定**：车心落在截线上时，车身（含侧余量）在截线上的弦长至少为 `2·(半宽+0.2)`，且整条弦必须在同一个无边界区间内。所有区间都短于这个值，就是 `blocked: geometry-blocked`。见证记录截线位置、最宽区间、所需宽度，以及限制它的边界和固体。
   - **成立条件**：截线必须跨满走廊、位于直段内部（离折点至少一个半宽）、不靠近走廊的其他段——这时走廊内从起点到出口的连续路径必然穿过它。另外，验证器把车心离开走廊判为 `route-deviation`。
   - **不下结论的截线**：区间碰到截线端点（可行驶面在走廊外还延续），或截线上两层都有可行驶区间（整车规则会按层豁免线段）。
   - **不当证据的固体**：场景包围盒代理（保守外包）、分流岛（凸包外包）、护栏和桥面板（区域规则已精确处理）。它们只参与动态试跑。
3. **矛盾**：有证据却跑通了 → `inconclusive: simulation-invalid`（`passed-against-witness`）。这说明模拟或证据有缺陷，不是通过。

### 动态试跑（可认证的「通过」）

- 用同一个 `DrivingKernel`。`CorridorPilot` 是按钮式的纯追踪驾驶员，沿走廊中线开，保持巡航速度。
- 执行链：`DrivingRouteRunner` → `GateAuditObserver`（出口门：整车有向穿越，含高度和区域）→ `CorridorValidator`（车心不得离开走廊）→ `SurfaceWorldValidator`（整车覆盖 + 连续运动 + 固体，固体用结构 + 场景代理）。
- **覆盖完整才能 passed**：快照里有场景代理，或调用方显式声明世界里没有建筑（`declareNoBuildings`，仅限合成夹具）。只有规划、没有场景的 capture 不算完整：那里的建筑只是没被捕获。
- 试跑失败本身永远不是道路证据：没有静态证据时，结果一律 `inconclusive`，并给出 runner 的原因。

### 路线来源

`directedEdgeRoutes(roadEdges)`：每条道路边双向各一条路线，两端各裁掉 6（避开节点扇面），走廊半宽 = 路宽/2 + 0.5。这只是真实城市的起始集合，**不是 D 的规划器**：不包括转向、出生点到终点、结构过渡，也不冻结完整分母。

## 安全恢复

`game/driving/SafeRecovery.ts`：

- `findSafePose(world, request, options)`：有界、确定性的最近合法位姿搜索。
  - **候选顺序**：按（环半径, 航向变化, 方位角）的字典序逐个试。默认最大位移 6、步长 0.25；航向变化最大 ±45°、步长 7.5°；可选掉头。
  - **合法**：`footprintSupport`（整车覆盖、坡度、扭曲、固体）和独立验证器 `validateStart` 都通过。
  - **只在请求的区域内找**：绝不借机换区域。多层区域按请求的高度选层。
  - **找不到时**：返回 `no-safe-pose-within-bound`（界内无解）或 `budget`（预算用尽）。预算用尽不是「此处无路」的证据。
- `commitRecovery(result, world)`：只有结果的 revision 等于当前世界、且世界仍是当前的，才返回位姿。旧世界的位姿永远不会落到新世界上。
- 不做「按碰撞法线推出去」：推的方向取决于最近的那一个固体，常常推进另一个固体或推下路缘（spec §6 明令初始重叠不随机推出）。

## 证据

- 合成（`verify-city-road-passability.mjs`）：
  - **passed**：开放道路；证据交给发布策略后仍为 pending（`final-boundary-replay-required`）。
  - **blocked**：精确桥墩横截全路（见证就在桥墩处）；2.0 宽的瓶颈小于车身所需的 2.06；两段互不相连的道路（拓扑）。
  - **不算挡住**：桥墩只占半幅时，没有见证；桥墩抬高到车顶以上时，开得过去。
  - **inconclusive**：
    - 半幅岛：车开得过去但中线驾驶员会撞上，没有见证，静态 geometry 记 passed；
    - 同一堵墙换成场景代理：试跑被挡，但不认证为挡住；
    - 有渲染建筑却没有代理、或只有规划没有场景：不给通过；
    - 世界过期、key 与世界不一致、路线非法。
  - **变异检查**：关掉固体扣除后，守卫失败。
- 合成（`verify-city-safe-recovery.mjs`）：
  - 已合法的位姿原样返回；
  - 压在路缘上、或压在固体上：恢复到最近的合法位姿，经独立验证，且结果确定；
  - 2.4 宽的单车道里车横着停：航向上限 45° 时界内无解，放到 90° 时恢复成功；
  - 预算耗尽返回 `budget`；不跨区域；提交按 revision 绑定。
- 真实渲染城市（`--cities`，0/90/500 会话 × 5 种子，经 CityParts 显示冻结租约 → CitySurfacePort）：
  - 每个场景取前 N 条道路边，双向审计；
  - 守卫断言：每个结果都绑定该场景的 world revision；blocked 必带见证；passed 必来自通过的试跑；没有「跑通却与证据矛盾」的路线；释放租约后 capture 失效。
  - 实测 4 条边/场景：94/94 条有向路线 passed。
  - 实测 30 条边/场景：722 条有向路线中，716 条 passed，0 条 blocked，6 条 inconclusive（5 条 `pilot-failed`，1 条 `unconfirmed`）。
    - 6 条全部出在 seed 42 和 65537，即 B2 发现高架桥墩立在地面路里的场景。桥墩只占一部分路宽，车身仍放得下，所以没有截面见证。中线驾驶员绕不开它，于是如实记为 inconclusive，而不是 blocked。
    - 没有任何一条路线出现「跑通却与证据矛盾」。

## 已知限制

1. 截面证据只在直段内部取，弯段、路口、结构过渡上的阻塞只能来自拓扑，或保持 inconclusive。
2. `CorridorPilot` 很朴素：需要绕障、需要大角度转向的路线会是 `inconclusive: pilot-failed`。更好的驾驶员属于 D。
3. 动态试跑仍是整步拒绝。C 的接触推进和滑动落地后，`pilot-failed` 的比例应该下降，届时需要重测，不改判定规则。
4. 场景代理是包围盒：代理挡住的路线只会是 inconclusive，永远不会是 blocked。精确渲染网格碰撞（`renderedSolids`）尚未接入碰撞。
5. 正式开放仍需 D 的完整用例覆盖、冻结分母和最终边界复跑；本轮结果不能用来开放整张路网。

## 命令

```sh
node scripts/verify-city-road-passability.mjs                         # 合成：三种结果的每条来源
PASSABILITY_EDGES=12 node scripts/verify-city-road-passability.mjs --cities   # 15 个真实渲染场景
node scripts/verify-city-safe-recovery.mjs                             # 恢复：最近合法位姿、界限、预算、不跨区域、提交绑定
```

## B4：动态试跑切到 C 的连续内核（2026-10-16）

- **默认引擎**：动态试跑改用 C 的连续驾驶环境和内核：`ContinuousDrivingEnvironment` + `createContinuousDrivingKernel`，每个用例新建一个 `ContinuousWorldValidator`，外层再套 `CorridorValidator`。旧的整步拒绝环境保留为 `engine: "legacy"`，用于对比。
- **身份**：key 必须带 C 的物理/碰撞/查询版本（2/2/3），以及覆盖碰撞体与求解参数的 `vehicleConfigHash`（`continuousAuditKeyFields()`）。旧引擎的 key 一律判 `key-engine-mismatch`，不复用旧结论。固体索引有被拒绝的固体时，结果为 inconclusive。
- **按实际轨迹判定**：`GateAuditObserver` 沿 `motion.trajectory` 逐段判断穿门。没有分段轨迹时，退化为 `previous → next` 这一段，和原来完全相同（兼容）。走廊约束同样检查轨迹上的每一个点。
- **出生恢复**：起点与固体重叠时，先由 SafeRecovery 恢复，再作为新用例（`<id>:recovered`）重跑。SafeRecovery 新增 0.1 的净空余量，恢复出的位姿不能只是「刚好不接触」。
- **性能**：宿主 capture 的 `isCurrent()` 每次调用都会重新采集场景代理；C 在每个支撑分段都调用它，导致真实场景每 tick 约 103 ms（669 个固体）。现在动态试跑用一个节流、锁存的检查（每 1000 次调用才真查一次），降到约 1.1 ms/tick。staleness 是单调的，而且每个结论返回前都会做一次真实检查，所以试跑途中世界变了，只会让结果作废，不会产生结论（有守卫）。正式驾驶入口 `createCityCarSession` 每步也调用同一个检查，需要宿主端口负责方处理。

### 十五城对比（30 条边/场景，722 条有向路线）

| 引擎 | passed | blocked | inconclusive |
| --- | --- | --- | --- |
| legacy（整步拒绝） | 716 | 0 | 6：5 条 `pilot-failed`，1 条 `unconfirmed` |
| continuous（C） | 716 | 0 | 6：3 条 `simulation-invalid`，2 条 `pilot-failed`，1 条 `unconfirmed` |

- **通过集合完全相同**：两个引擎通过的是同一批 716 条路线。
- **6 条无结论路线分布在 3 条边上**：
  - 0/42 的 `-172.59:542.83/…`：正向起点在界内找不到安全位姿（`start-unrecoverable`）；反向是 `pilot-failed`。
  - 500/42 的 `-103.81:-388.59/…`：双向都是 `simulation-invalid`。
  - 500/65537 的 `-136.97:-232.97/…`：一向 `pilot-failed`，一向 `simulation-invalid`。
- **新增的 `simulation-invalid` 是 C 的问题**：逐 tick 追踪 500/42 正向，车贴着高架桥墩滑了 229 个 tick，然后那一步返回 `continuous-collision:budget`（`queryStatus: unresolved`），复核器按规则判为模拟无效。合成复现已交给 C：6 宽道路、停放盒中心 (−40, 1, 1.2)、半尺寸 (1, 1, 0.6)、车从 (−40.18, −0.47) 出发，第 38 个 tick 出现。
- **审计处理正确**：这些都是 inconclusive，不是 blocked。C 修好后，应优先复测这几条。
