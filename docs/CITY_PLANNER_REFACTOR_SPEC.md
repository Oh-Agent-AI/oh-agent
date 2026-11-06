# 城市规划器重构规格：拆解 `cityPlan.ts`

> 2026-10-13 · 状态：提案 · 提出方：编辑器线（`worktree-city-plan-repair`）· 执行方：**city-opt（生成器）线**
> 承接 [CITY_ARCHITECTURE.md](CITY_ARCHITECTURE.md)（目标架构，2026-10-08）的迁移步 5–6，补上它写完之后实测出的结构问题。
> 本文只提方案与验收，**编辑器线不改生成器文件**；§6 列出两条线各自的动作。

## 0. 一句话

`cityPlan.ts` 复杂，是因为迁移只做了一半：修复阶段已经是「约束 + 修复循环」，生成阶段还是一个 1430 行的函数；
再加上底层工具函数放在了顶层文件里，造成 26 个模块的运行时循环依赖。先做便宜、零行为变化的三步（R1–R3），
再迁出工序（R4–R5），最后才动会改变所有种子布局的「选址后置」（R6）。**前提是先修好安全网（R0）——它现在是红的。**

## 1. 现状度量

测于 `worktree-city-plan-repair`（含 city-opt `cc2c7cb7`；其后本分支的提交没有碰任何生成器文件），2026-10-13。

| 指标 | 数值 | 备注 |
| --- | --- | --- |
| `cityPlan.ts` | 1605 行 | 62 次提交，全部在 2026-10；约 15% 是注释，多为「曾经出过什么事」 |
| `buildPlan`（`cityPlan.ts:165–1594`） | ≈ 1430 行，单个函数 | 22 个内嵌闭包、16 个后续步骤会改的可变变量（grep 粗计） |
| 其中：求解之前（命令式生成） | 165–1430，≈ 1265 行 | 骨架 → 设施 → 海滨 → 环路 → 接入路 → 连接器 → 补连通 → … → 回车点 |
| 其中：求解之后（声明式修复收尾） | 1430–1594，≈ 160 行 | `solvePlan(repairCtx)`，16 条约束 + 修复策略表 |
| `planner/` | 44 个模块，9 750 行 | `cityPlan.ts` 值导入其中 20 个 |
| 运行时循环依赖（仅值导入，类型导入已剔除） | **1 个环，26 个模块** | `cityPlan.ts` + 25 个 `planner/*`（含 `solve`、`connect`、`network`、`footprint`） |
| 成环原因 | **4 个函数** | `planner/*` 回头从 `cityPlan.ts` 取 `segmentDistance`、`roadNodeId`、`clearsHighways`、`targetParcels` |
| 规划状态载体 | 7 种 | `ConnectorWorld`、`LandingWorld`、`SiteCandidateWorld`、`FrontageMoveContext`、`ShoreMoveContext`、`RepairContext`、`PlanningWorld` |
| **安全网：plan 基线（30 岛哈希）** | **30/30 不一致** | 见 §2.P6；最后一次更新 2026-10-09（`516cd8d9`） |

度量方法见附录 A。

## 2. 诊断

### P1 · 底层依赖顶层（循环依赖）
`planner/` 是 L1 的内部模块，`cityPlan.ts` 是它的编排器，依赖应单向。实际上 25 个 `planner/*` 为了几何小工具回头 import 编排器。
这 4 个函数各十来行，且被编辑器也用（`roadNodeId` 被 9 个模块、`segmentDistance` 被 7 个、`clearsHighways` 被 5 个、`polygonDistance` 被 4 个引用）。
模拟验证：把 `planner/*` 对 `cityPlan` 的值导入去掉，整个工程**不再有任何值层面的环**（附录 A 脚本）。

### P2 · 两种范式并存
- 尾部：`constraints.ts` 的 16 条约束（`{ measure, … }`）+ `solve.ts` 的「约束 id → 修复策略」表，逐策略在隔离草稿执行、接受检查通过才发布。这是 CITY_ARCHITECTURE §2 的目标形态。
- 头部：命令式、靠闭包共享变量的工序链，后一步默认前面几步已发生。注释里「禁止用降低硬约束换连通」这类教训就是这种形态的代价。
迁移步 5 因此是「做了尾巴、没做头」。

### P3 · 没有单一规划状态，事务靠手工
- 七种 World/Context 各自定义「这道工序看到的世界」。`RepairContext` 的注释自己写明：它是对 `buildPlan` 里同一份可变对象的引用袋，修复遍原地修改。
- `world.ts` 的 `PlanningWorld`（带版本与预留）像是想做成唯一权威，目前只有尾部在用。
- 「暂存一份 → 成功就提交」在 3 处手写成 `nodes.clear(); …set; edges.clear(); …set`（`cityPlan.ts:554–555`、`1108`、`1398`），版本号靠 `network as Network & { version?: number }` 的类型断言累加。同一个语义，三份拷贝。

### P4 · 选址仍在路网之前
CITY_ARCHITECTURE 要求「选址后置」：先出候选，路网生成后再挑。现状：公共用地与致敬地标在骨架之前就落位并预留土地，
之后用「用地临街 → 接入路 → 尽端环路 → 断头路收尾 → 桥头落地环」一串步骤让路去迁就它们。
已知后果：`2005655366/t1` 的 `east-stadium` 落位失败——192 个候选里 96 个败于干线净空 r+8、41 个败于干地、26 个败于用地间距、24 个中心不可建。每个淘汰条件都来自更早的步骤。

### P5 · 约束在两处各写一份
`constraints.ts::acuteJunctions` 与编辑器 `planRoadRules.ts::ACUTE_LIMIT` 各有一个 30°，靠注释「同 planner/constraints.ts::acuteJunctions」保持一致。
这正是目标架构要消灭的情形。前科：设施落位谓词原本在生成器里私有，编辑器只能近似，导出 `checkSitePlacement` 之后才发现并修掉两个缺陷（D1/D2）。

### P6 · 安全网失效
`scripts/verify-city-baseline.mjs` 是「重构不改行为」的机器证明（30 岛 = 10 种子 × 1/2/5 档，逐岛分区哈希）。
当前在 30/30 个岛上、全部 6 个分区（roads / sites / blocks / skeleton / traffic / seaside）都不一致。
基线最后更新于 2026-10-09（`516cd8d9`）；此后生成器目录有 16 个非合并提交（`e77f3737` … `cc2c7cb7`），**没有一个更新过基线**。
所以现在无法用它证明任何重构「没有改变行为」。这是本文的第一个阻塞项。

## 3. 目标与不变式

目标：消除 P1，让 P5 不可能再出现，把 P2/P3 逐道工序地收敛，最后解决 P4。**每一步都能单独停、单独回滚。**

不变式（每一步都必须满足，除非该步明写「有意改变行为」）：

- **I1 行为不变**：`verify-city-baseline` 30 岛哈希与步骤开始时一致。
- **I2 确定性**：同种子同结果。随机数是按键哈希取的（`random(key)`），所以**不得改变任何 `random()` 的调用键或相对顺序**，不得改变 Map/数组的迭代顺序。
- **I3 `Math` 是 `DetMath`**：`cityPlan.ts` 第 1 行 `import { DetMath as Math }`——搬出去的函数里的 `Math.hypot/max/min` 在新文件里必须同样引入 `DetMath as Math`，否则跨引擎数值可能不同。
- **I4 旧路径继续可用**：搬走的符号在 `cityPlan.ts` 里 `export { … } from` 重导出，编辑器与其它调用方不必同时改。
- **I5 一步一提交**：一步只搬一类东西，提交信息写明「逐字搬迁」或「有意改变行为」。

## 4. 步骤

### R0 · 修复安全网（阻塞项，先做）
- 在 city-opt 当前提交上运行 `node scripts/verify-city-baseline.mjs --diff`，逐岛、逐分区审阅差异，确认这 16 个提交带来的变化都是预期的（大多是联合站路、边界重定位、桥头相关）。
- 确认后 `--update`，**单独一个提交**，提交信息列出审阅结论。反射性 `--update` 会让这条守卫失去意义（脚本头部已警告）。
- 同时记录 `verify-city-scene-baseline`（约 190 个分区漂移，与本重构无关）与 `verify-city-planning`（`2005655366/t1` 体育场）两处已知红灯，**不要把它们混进 R1–R5 的验收**。
- 验收：`verify-city-baseline` 绿；记录它的耗时，后面每步都要跑。
- 归属：city-opt。风险：低；工作量取决于差异审阅。

### R1 · 抽出叶子模块，断开循环
- 新增 `engine/roadGeometry.ts`：`segmentDistance`、`polygonDistance`、`roadNodeId`、`SegmentIndex`、`clearsHighways`（后者依赖 `SegmentIndex`，要一起走）。
- 新增 `engine/scaleTier.ts`：`SESSIONS_PER_TIER`、`MAX_TIER`、`scaleTierFor`、`targetParcels`。
- `cityPlan.ts` 对两者 `export { … } from`（I4）；`planner/*` 与 `cityLayout.ts` 改为直接从新模块导入。
- 注意 I3：新文件首行 `import { DetMath as Math } from "./detMath"`。
- 验收：①`tsc` 干净；②`verify-city-baseline` 哈希不变；③模拟脚本（附录 A）报「值层面循环 0」；④编辑器 `verify-plan-*` 全绿。
- 归属：city-opt。风险：很低。预期：移出约 70 行，循环 26 → 0。

### R2 · import 边界守卫
CITY_ARCHITECTURE §1 写明「依赖方向由 tests/ 里的 import 边界守卫钉住」，实测 `scripts/` 里没有这样的守卫。新增 `scripts/verify-city-import-boundary.mjs`（规则只看值导入）：

1. `engine/` 非 render/systems 部分**无值层面循环**；
2. `planner/*` 不得值导入 `cityPlan.ts`、`cityLayout.ts`；
3. L1–L3（`planner/`、`cityLayout`、`cityPlan`、`models/`）不得导入 `three`、`render/`、`systems/`；
4. 编辑器（`plan*.ts`、`planRepair/`）对 `planner/` 的导入只允许显式白名单。

登记进 `verification-manifest.json`，`verify-city-verification.mjs` 的计数锁同步 +1。
验收：对 R1 之前的提交运行应报规则 2 失败（证明守卫有牙齿），之后通过。归属：city-opt（规则 4 由编辑器线提供白名单）。风险：低。

### R3 · 约束只写一份
- city-opt：`constraints.ts` 导出阈值常量（如 `ACUTE_JUNCTION_RAD`），`acuteJunctions` 引用它；不改值（仍是 30°）。
- 编辑器：`planRoadRules.ts::ACUTE_LIMIT` 改为导入该常量，删掉注释式「同步」。
- 之后评估是否把 `measure` 整体导出，让编辑器体检（`planAudit.ts`）直接复用而不是同名重写。
- **不在本步改阈值。** 是否按 CJJ 37 把锐角阈值提到 70° 是产品决策（会改变所有种子的布局，见 R6），单独评审。
- 验收：哈希不变；编辑器 `verify-plan-road-rules` 绿。归属：两条线各一半。风险：低。

### R4 · 事务原语 `commitNetwork`
- 在 `planner/network.ts` 增加 `commitNetwork(network, staged)`：原地用暂存内容替换 `nodes/edges` 并递增版本号（把 `network` 的类型加上 `version: number`，去掉断言）。
- 替换 `cityPlan.ts` 里 3 处手写的 `clear + set`（`554–555`、`1108`、`1398`）。
- 验收：哈希不变（必须逐字等价：同样的清空与重填顺序）。归属：city-opt。风险：低到中——Map 重填顺序影响迭代顺序，因此 I2 在这里要特别核对。

### R5 · 逐道迁出内嵌工序
从耦合最低的开始，每道一个提交，形式统一为纯函数 `(world, params) => result`，放进 `planner/<name>.ts`，原位置只剩一次调用，参数顺序不变。

| 顺序 | 工序 | 位置 | 规模 | 捕获的外部变量（需随参数传入） |
| --- | --- | --- | --- | --- |
| 1 | 碎边合并 | `1251–1335` | ≈ 85 行 | `network`（`edges/nodes`）、`publicSites`、`primaryAnchorNodeIds` |
| 2 | 断头路收尾 | `1336–1367` | ≈ 30 行 | `network`、`publicSites`、`landmarks`、接入路闭包 |
| 3 | 海滨带 | `562–617` | ≈ 55 行 | 待核 |
| 4 | 环岛滨海路 | `618–704` | ≈ 85 行 | 待核 |
| 5 | 用地临街 | `366–561` | ≈ 195 行 | `frontageCtx` 等 |
| 6 | 统一连接器 | `709–1135` | ≈ 430 行 | 最后做；它的闭包最多 |

- 「尽端环路」**已经**是模块（`planner/loop.ts::connectServiceLoops`），`cityPlan.ts` 里只剩一行调用，不在迁出清单里（见附录 B 的更正）。
- 每道迁出前先列出该段读写的所有外层变量，写进提交信息；有「读-改-写」同一变量的，改成显式返回值。
- 验收（每道）：哈希不变；`tsc`；R2 守卫；该道涉及的专项守卫（如 `verify-react-city-seaside`、`verify-city-connect`）。
- 预期：R1–R5 合计移出约 880 行，`cityPlan.ts` 降到 800 行以下（预估，以实测为准）。归属：city-opt。风险：中，逐道可停。

### R6 · 选址后置（有意改变行为，最后做）
CITY_ARCHITECTURE 迁移步 6。设计要点：
- 设施只产**候选表**（条件式：离水、离河、朝向、净空），骨架与街网生成之后再在候选里按约束挑位置。
- 修复手段保持「在候选内移动用地、补/删一条路段、绕行」，禁止修复步骤再生成骨架。
- **会改变大多数种子的布局**，因此是单独一个里程碑：先出设计（单独文档），实施后整体重建基线，并用 `--diff` 逐岛审阅；不与 R1–R5 混提交。
- 成功判据：`2005655366/t1` 的 `east-stadium` 落位；`verify-city-planning` 转绿；联合站路相关（`jointSiteRoad`）的补丁式修复可以删掉一部分。
- 风险：高。是否做、何时做，由 R0–R5 的结果和你的优先级决定。

## 5. 验证矩阵

| 守卫 | 作用 | R0 | R1 | R2 | R3 | R4 | R5 | R6 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `verify-city-baseline`（30 岛哈希） | 行为不变的证明 | 重建 | ✔ | ✔ | ✔ | ✔ | ✔ | 重建 |
| `tsc --noEmit` | 类型 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `verify-city-import-boundary`（新） | 依赖方向 | — | — | 新增 | ✔ | ✔ | ✔ | ✔ |
| 编辑器 `verify-plan-*`（6 个） | 编辑器不被带坏 | ✔ | ✔ | — | ✔ | — | — | ✔ |
| 工序专项守卫（react-city-seaside / city-connect / city-sitespec …） | 局部行为 | — | — | — | — | — | 按道 | ✔ |
| `verify-city-planning` | 体育场（已知红） | 记录 | — | — | — | — | — | 转绿 |

脚本须**串行**跑（共享转译缓存）。

## 6. 归属与协作

- **city-opt 线**：R0、R1、R2、R4、R5、R6，以及 R3 的生成器一半。编辑器线不改这些文件。
- **编辑器线**：R3 的编辑器一半；R2 规则 4 的白名单；每步合入后重跑 `verify-plan-*`，并在合入 city-opt 时按既有流程处理冲突（只取已提交版本）。
- 合并节奏：R1、R2 先行，合并后编辑器线再合入，之后编辑器新增对 `planner/` 的导入由 R2 守卫兜住。

## 7. 风险与明确不做

- **确定性**是最大风险：I2/I3 任何一条被破坏，都表现为哈希漂移；这也是不做整体重写的原因——重写会同时丢掉 44 个模块与基线。
- R5 中「读-改-写同一变量」若处理不当会改变迭代顺序；每道提交都要单独验。
- 不改会话楼语义、不换渲染技术、不改 L2 之后的层（沿用 CITY_ARCHITECTURE §8）。
- 不在本文范围：把锐角阈值提到 70° 等「用真实规范收紧生成器」的决策（先 R3，再单独评审）。

## 附录 A · 度量方法（可复现）

- 范围：`apps/agent-city/ui/src/engine/**/*.ts`，排除 `render/`、`systems/`、`models/`。
- 依赖边：相对路径的 `import … from "./…"`。**类型导入（`import type`、花括号里的 `type X`）剔除**——它们在编译后不存在，不构成运行时环。
- 环检测：Tarjan 强连通分量，大小 > 1 即为环。
- 模拟 R1：从边集中删掉 `planner/* → cityPlan` 的边后重算，结果「无环」。
- 行数、闭包数、可变变量数：`wc -l` 与 grep；闭包 = 函数体内缩进 2 格的 `const x = (…) =>` 与 `function`，可变变量 = 缩进 2 格的 `let` 与空数组/集合字面量，**是启发式计数，只用于数量级判断**。
- 基线结果：`node scripts/verify-city-baseline.mjs`，30/30 不一致。

## 附录 B · 对此前口头结论的更正

在本文成稿前的对话里，有两处说法与实测不符，这里订正：

1. 曾把「尽端环路」列为可迁出的候选。实测它已经是 `planner/loop.ts::connectServiceLoops`，`cityPlan.ts` 里只有一行调用；真正还内嵌的是碎边合并与断头路收尾。
2. 曾说 `planner/` 约 1.2 万行。实测是 9 750 行（44 个模块）；1.2 万是把 `cityPlan.ts` 与 `cityLayout.ts` 也算进去的合计。
