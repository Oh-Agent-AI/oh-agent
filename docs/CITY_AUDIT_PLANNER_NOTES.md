# D1：用例规划器（RoadAuditPlanner）与路线驾驶员（RoutePilot）

日期：2026-10-16。接 [B3/B4 逐路审计](CITY_PASSABILITY_AND_RECOVERY_NOTES.md)。判定规则不变：三种结论仍完全来自 B 的审计。本轮负责冻结「测什么」，并把每个用例交给审计执行。

## 冻结的必测清单（manifest）

`game/driving/audit/RoadAuditPlanner.ts` 的 `planRoadAudit(input)`，输入是冻结世界的路网（`roadEdges`）、结构落地点（`landings`）和可选的审计出生点。**分母先于任何试跑冻结**（spec §11.2/§11.3）：

| 单元 | 生成规则 | 排除（仍在分母里，带原因） |
| --- | --- | --- |
| `directed-edge` | 每条边两个方向，两端各裁 6 避开节点扇面 | 裁后不足 8：`edge-too-short` |
| `turn` | 每个节点上每一对「入边→出边」，不含掉头；尽端没有转向 | 某一腿不足 5：`turn-leg-too-short` |
| `structure-transition` | 每个落地点的上（ground→结构层）、下（结构层→ground）两个方向，走廊宽度取接缝的实际宽度 | 悬空端：`no-ground-landing` |
| `spawn-access` | 每个审计出生点到图上最远可达节点的端到端路线 | 出生边缺失、无可达目标 |

- 每个单元恰有一个用例，用例只覆盖它自己。出生端到端路线经过的边和路口**不因此计数**：只有 observer 记录了单元的进入/离开才能计数，首版不做组合覆盖。
- **默认审计出生点**：每个连通分量取最长边的中点。这只是审计用起点，**不是正式玩家出生区**（产品 SPEC 未定义）。
- **转向与出生路线的中线在折点处做圆角**：半径 5，受两腿长度限制。中线是规划器的选择，不是道路几何；在节点上原地转 90° 的折线本来就开不过去。
- `manifestHash`：单元、排除、参数、用例几何的规范 JSON 的 FNV-1a 64，与输入顺序无关，几何一变就变。执行时 key 的 `manifestHash` 与 `plannerVersion` 必须与之一致。

## 执行与覆盖报告

`executeAuditPlan(world, plan, keyFor)`：

- 每个用例走 B 的 `auditRoute`（默认连续内核）。
- 发布策略使用冻结的 manifest：每个单元一个计划用例，id、单元、门、预算都与 auditRoute 一致；从恢复起点重跑的用例是另一个用例，不算数。
- 返回每类单元的候选/排除/通过/挡住/未确认，以及 spec §11.7 格式的摘要：「已验 X/Y 个方向、A/B 个转向、C/D 个结构连接、S/T 个出生可达；候选 N，排除 E，挡住 B，未确认 U」。
- 没有最终边界复跑时，发布策略恒为未就绪（`final-boundary-replay-required`）。

## RoutePilot（controllerVersion 2）

`game/driving/audit/RoutePilot.ts` 的 `CurvatureRoutePilot`：

- **输入**：只输出按钮，确定性；只读给它的不可变状态和冻结路线，不读出口门。
- **控制**：前视距离随车速在 1.8–5 之间变化；目标速度取 `min(巡航, √(3·R_前方))`，R 为前方 8 内的最小转弯半径；航向误差大于 0.35 时降到 2；超速时轻点刹车。
- **接入**：经 `PassabilityOptions.pilot` 注入。`executeAuditPlan` 默认使用它，并要求 key 的 `controllerVersion` 与之一致，换驾驶员就是另一个 key。B 的 `auditRoute` 默认仍用 `CorridorPilot`，B4 的结果不受影响。

## 证据（合成，`verify-city-audit-planner.mjs`）

- 十字路口（4 臂，各长 40、宽 6）：8 个方向、12 个转向、1 个出生，共 21 个单元，全部通过。修复前，B 的驾驶员在 8 个直角转弯上全部 `pilot-failed`。
- **清单性质**：与输入顺序无关；几何一变哈希就变；过短的支路留在分母里作为可见排除；落地点的上/下两向带层；悬空端被排除。
- **故障注入**：
  - 东臂上的精确桥墩：只让东臂两个方向 blocked（带见证），其余方向与转向不受影响，发布策略带上这条见证。
  - 一个永远不转向的驾驶员：转向全部 inconclusive，没有一条 blocked。
  - key 的 `controllerVersion` 与驾驶员不符：执行直接拒绝。

## 真实城市

（待补：`--cities` 实测结果。）

## 未完成（D 的后续批次）

1. **ReleasedDrivingGraph**：开放图、可见关闭标识、出生区可达复核，以及带最终边界复跑。
2. **AuditEvidenceStore**：有界的失败片段环形缓冲（spec §11.6），以及本地回放句柄。
3. **组合覆盖**：长路线由 observer 按单元记录进入/离开，从而减少重复用例。
4. **桥下通行**作为独立的 `structure-transition` 用例；`recovery` 单元（安全点复位后重新起步）。
5. **更强的驾驶员**：绕开占了半幅路的障碍；诊断复跑（更低巡航速度）作为独立 case/key，保留首次失败。
