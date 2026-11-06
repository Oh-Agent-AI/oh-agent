# 规划器重构进度（R0–R5 落地记录）

> 规格：`docs/CITY_PLANNER_REFACTOR_SPEC.md`（在 `worktree-city-plan-repair` 的 a2f4df1f，本线尚未合入）。
> 本文记录 2026-10-13 ~ 10-14 在 city-opt 线上的实际执行结果、验收证据与遗留项。全部提交只在本地分支，未推送。

## 1. 结论

- R0–R5 已落地，集成在分支 `city-integrate`。合入后规划结果与 `411606a1` 逐字节一致（30 岛 × 6 分区），跨引擎一致。
- `verify-city-baseline` 重新可信（R0），此后它本身就是「重构不改行为」的证明。
- 单轮完整基线校验：`411606a1` 约 606 s → 现在 199 s（`516cd8d9` 是 29 s，余下差距见 §5）。
- `cityPlan.ts`：1595 行 → 792 行（规格预估「降到 800 行以下」）。
- 新增生成器版本戳，补丁随生成器换代重定位；基线 `--update` 强制递增版本。
- R6（选址后置）只完成设计（`docs/CITY_SITE_PLACEMENT_DESIGN.md`），未实施。

## 2. 提交清单

| 步骤 | 提交 | 内容 | 行为 |
| --- | --- | --- | --- |
| R1 | `67d76170` | `roadGeometry.ts` / `scaleTier.ts` 逐字搬迁，值层面循环 1 个（26 模块）→ 0 | 不变 |
| R2 | `7d9f226d` | `scripts/verify-city-import-boundary.mjs`（4 条规则，只看值导入）；对 `411606a1` 报 14 处违规 | 不变 |
| R3 生成器半 | `5ea84b9c` | `constraints.ts` 导出 `ACUTE_JUNCTION_RAD`（30°，表达式原样） | 不变 |
| R4 | `d386fa4c` | `planner/network.ts::commitNetwork`，替换 3 处手写 clear+set；`Network.version` 去断言 | 不变 |
| R5 | `ae855351` `a74ad545` `78e9921b` `aa822465` `c61fd47d` `4515e5a7` `8be6d610` `ce5f0f67` | 碎边合并、断头路收尾、海滨带+滨海大道、环岛滨海路+河岸路、用地临街、扇区街网、站点入口路、街网缝合 → `planner/*` | 不变 |
| models 分层 | `8802bfca` | `models/` 6 处值导入 `three`/`render` 移到 `render/`，R2 钉住名单清空 | 渲染几何逐字节一致 |
| 性能一 | `9aa1187c` | 节点合并廊道结果按 (起点, 终点, 策略) 记忆 | 不变 |
| 性能二 | `3243ee4d` | `DetMath` 快属性、geography 单槽缓存、采样循环外提 | 不变（含 320 万输入数学对比） |
| R0 | `2e8f3c55` | 只改 `golden/city-plan-baseline.json` | 基线重建 |
| 性能三 | `602df76e` | 孤立分量节点合并：首个拒绝取完整原因，其后用布尔快判 `corridorBlocked` | 不变（7 岛完整 plan JSON 一致） |
| 版本戳 | `c83fc886` | `engine/generatorVersion.ts`；补丁 `generatorVersion`；基线 `--update` 校验版本 | 编辑器行为：换代时重定位 |

## 3. R0 归因（516cd8d9..411606a1，相对前一提交）

| 提交 | 变化岛数 | 判断 |
| --- | --- | --- |
| e77f3737 | 30（roads 30） | 预期：关闭路线校验绕过 |
| 7edabf98 | 22 | 预期：地面路口连接 |
| ae48a7e6 | 12 | 预期：需求路径与近路口/桥引道校验 |
| feabf8df | 25（blocks 24） | 预期：修复策略单调隔离事务 |
| 8b571016 | 30（6 分区几乎全变） | 预期但为 WIP：干线经 `screenTrunkRoute` + `commitNetworkPatch` 发布 |
| 188a5ff2 | 0 | 符合要求（编辑器钩子不得改哈希） |
| 0dc3c235 | 21 | 预期但为工作区快照，自述带 6 个已知失败守卫 |
| 8881f482 / 6e9d086e / cc2c7cb7 | 各 1 | 预期 |
| 14b1c450 | 6 | 预期：jointSiteRoad |
| 其余 5 个 | 0 | — |

确定性：`411606a1` 上两次完整导出逐字节相同；`cc2c7cb7` 与 `411606a1` 一致，归因链闭合。
基线冻结的是「当前行为」，8b571016 / 0dc3c235 带入的已知问题（别墅 wet=6、2003037141/t1、种子 2000000000 残余交叉）仍在。

## 4. 验收证据（`city-integrate` 520fa6aa）

`tsc --noEmit` 干净；`verify-city-import-boundary`、`verify-city-verification`、6 个 `verify-plan-*`、`verify-city-connect`、
`verify-react-city-seaside`、`verify-city-baseline`（30/30，199 s）、`verify-city-cross-engine`（30 布局 V8 = JavaScriptCore）全部通过。
版本戳的拒绝路径已实测：改一个岛哈希后 `--update` 退出码 1，基线未被改写。

## 5. 遗留项

- **性能**：`i0 t2` 单岛约 2 s（`516cd8d9` 为 0.37 s）。剩余耗时在派生布局修复收尾（约 4.1 s @t5）、街区生成（约 3.6 s）、
  `solvePlan` 修复事务（约 3.3 s），都来自残余闭合工作，需单独剖析。
  曾提议「pass 2 只试前 12 个成员」可再省约 1.2 s，但会改变道路与桥，未做、不建议。
- **R5 余量**：连接器世界与 `connectToNetwork` 工厂（约 25 行）、`connectGeneratedComponents` 及其后连通性块未迁出。
- **R3 编辑器半**：`planRoadRules.ts:25` 的 `ACUTE_LIMIT` 改为导入常量，同时在 R2 守卫白名单加一行（编辑器线）。
- **plan ↔ repair 衔接**：编辑器只共用 `checkSitePlacement` 与几何小工具；路的合法性、移楼、体检、自由级落位各写一份。
  建议顺序：P0 两向契约守卫 → P1 `planner/rules.ts` 门面 → P2 `CityPlan`/`CityLayout` 视图适配 → P3 编辑器改用共享规则 → P4 派生物共用。未开始。
- **R6**：见 `docs/CITY_SITE_PLACEMENT_DESIGN.md`；建议先原型验证 R6-3（必需设施优先回退）能否让 `east-stadium`（2005655366/t1）落位，做到 R6-4 为止。
- **不在本轮**：`city-scene-baseline` 约 190 分区漂移；`verify-city-planning` 的 east-stadium 红灯（R6）。

## 6. 以后每步的验收

纯重构：`verify-city-baseline` 必须绿（不得 `--update`），加 `tsc`、`verify-city-import-boundary` 与该步涉及的专项守卫。
有意改变布局：同一提交递增 `CITY_GENERATOR_VERSION` 并 `--update`，提交信息附 `--diff` 的逐岛审阅结论。
