# City visual style 开发接管记录

更新时间：2026-10-15（Asia/Shanghai）

## 工作位置

- Worktree：`.claude/worktrees/city-visual-style-analysis-a9ddd6`
- 分支：`claude/city-visual-style-analysis-a9ddd6`
- 接管时 HEAD：`9e4a0ad4`
- 原 Claude 会话：`45f9349c-fbb5-43e6-a478-495342ff1fd3`
- 原目录中的未提交改动全部保留；主 checkout 的驾驶模式开发不属于本任务。

## 用户已确认的范围

原会话最后的功能授权为「可以，3个都要做」：

1. 普通环岛：在符合条件的主干交汇处建环，增加中心绿岛。
2. 支路小环：让普通支路交汇也能出现小型环岛。
3. 立交匝道：高架与地面干道之间增加坡道、分流和合流过渡。

另有尚未收尾的高架出口曲线和湾岸主干道连通性改动。

## 当前实现

- `planner/connect.ts`：通用路口建环事务。
- `planner/junctionRings.ts`：主干环岛与支路小环选址及路线引用改写（未跟踪新文件）。
- `planner/highwayRamps.ts`：立交选址与匝道折线生成（未跟踪新文件）。
- `cityPlan.ts`、`cityLayout.ts`、`roadSystem.ts` 等：规划、数据结构和渲染接线。
- `planner/skeleton.ts`：高架出口切线约束及曲线接驳。
- `planner/coastalRingRoad.ts`：湾岸主干道连接调整。

这些是实现现状，不代表已经通过功能或视觉验收。

## 验证证据

接管时重新执行 `npm run typecheck`（`apps/agent-city/ui`）：通过。

Claude 的历史批次 `verify-head6.json` 共 79 项，67 项通过、12 项未通过；此批次早于最终匝道改动，不可冒充当前验证结果。

历史未通过项：

- `verify-city-villa-placement`
- `verify-city-shore-plot-access-named`
- `verify-city-required-placement`（crowdedArterials）
- `verify-city-road-report`（市政路口引用）
- `verify-city-planning`（crowdedArterials）
- `verify-react-city-infrastructure`（tier 1 高架过河保留）
- `verify-city-scene-baseline`
- `verify-city-solve`（invalid-world-versions）
- `verify-city-baseline`
- `verify-plan-remap`（跨档保留率 79%，低于 80%）
- `verify-city-survey`（独立验收集 crowdedArterials 回归）
- `seaside-tier10`（SIGKILL，不能视作断言失败或通过）

## 收尾顺序

1. 对当前代码重新执行针对性守卫，区分现存问题与此次功能引入的回归。
2. 修复路网净距、引用一致性与高架连接约束；不通过放宽断言消除失败。
3. 核对主干环岛、支路小环与匝道的生成数量、连接关系和视觉效果。
4. 审查生成器版本与基线变化，完成有证据的契约更新。
5. 完整回归通过后提交；本接管动作未自动提交或合并。

## 接管后的本轮修复

- 建环走同一 `roadCandidateCrowding` 准入规则，拒绝新增主干净距冲突，半径阶梯与失败零副作用有回归。
- 支路小环覆盖普通三岔和十字；保留被设施引用的固定节点，并验证车流引用沿真实环边改写。
- 市政广场周边接线在展示裁剪中保留，道路报告回归通过。
- 匝道起点沿真实高架采样；桥面端避开主桥落地坡；地面落点必须属于实际有限宿主（包括路口拆分后的共线边）。
- 修复闭合高架上的立交间距判定；分流段同高，主桥与地面接口留护栏开口。
- 用户截图指出断桥：`buildDistrictExpressways` 的旧 `length < 6` 跳过了连续出口短弧。同种子 1927/t5 有 19 条这样的合法边，现只拒绝近零长度段；新增每段均有桥面的回归。
- 生成器递增为 3；规划基线增加独立 `infrastructure` 分区，记录 `junctionRings/highwayRamps`。
- 庄园湿地基见证显式使用旧地块模式，保留真实 violation→partial 修复；未放宽原物理/服务/容量断言。
- 原跨河见证在原 HEAD 三档已不含高架，改用显式平岛窄河检验真实骨架生成；基础设施守卫改走原生公共加载器。

已完成的验证：快速套件 32/32、类型检查、构建、必需设施 10 场景、道路报告、连接器、solve、庄园物理回归、命名港口回归、跨档重映射（96%/86%）。独立验收集四档共 120 座通过（t1 60/t3 30/t5 20/t10 10），t1 净距零违例、t3/t10 全约束零违例；原门槛内保留 t1 门路 1/锐角 2、t5 主干净距 2。30 座规划基线及 4 个日夜场景基线复验通过。另一组固定种子的 120 座普查已经执行完毕，结果见下方；不能宣称全量普查全绿。

### 复验命令

```sh
npm run typecheck --prefix apps/agent-city/ui
npm run build --prefix apps/agent-city/ui
node scripts/verify-city-suite.mjs fast
node scripts/verify-city-required-placement.mjs
node scripts/verify-city-road-report.mjs
node scripts/verify-city-solve.mjs
node scripts/verify-city-villa-placement.mjs
node scripts/verify-react-city-infrastructure.mjs
node scripts/verify-city-shore-plot-access.mjs --named
node scripts/verify-plan-remap.mjs
node scripts/verify-city-baseline.mjs
node scripts/verify-city-scene-baseline.mjs
node scripts/verify-city-survey.mjs
```

大型普查也可用 `--set acceptance|tuning --tier 1|3|5|10` 分片执行；不带参数仍跑全部 240 座、使用相同种子与原验收上限。此次独立集完整通过后停止了合并进程的重复后续工作，调优集改由四个分档进程分别执行，完成情况见最终记录。

基线变更是用户已确认的功能变更：新增环岛改变路网拓扑/引用，中心岛及匝道避让改变可用地块和半径校准，连带改变用地与交通布局；并非为掩盖约束失败而刷新。`generatorVersion=3` 与新基线同时变更，旧规划补丁继续走已有坐标重映射流程。

## 最终验证记录

| 检查 | 结果 |
| --- | --- |
| TypeScript 类型检查、Vite 构建 | 通过 |
| 环岛与匝道合成回归 | 通过：准入、拒绝零副作用、确定性、三岔选择、路线引用、实际高架/宿主接触、分流高度与护栏开口 |
| 断桥基础设施回归 | 通过：每条非零短弧有桥面，窄河架空环线保留、各档地块高架避让 |
| 必需设施 10 场景、命名港口、庄园湿地基见证、solve | 通过 |
| 道路报告 + 42/t5 匝道地面宿主展示保留 | 通过 |
| 跨档补丁重映射 | 通过，96% / 86% |
| 规划 / 场景基线 | 30 / 4 全部匹配；生成器版本 3 |
| 独立验收集 120 座 | 四档均在原门槛内；t3/t10 全约束零违例 |
| 调优线 t1 60 座 | 通过，锐角残留 1（原门槛内） |
| 调优线 t5 20 座 / t10 10 座 | 通过，全部注册约束零违例 |
| 调优线 t3 30 座 | **未通过**：2001361477/t3 主干净距 1，原上限 0 |

### 明确保留的既有失败

对照原提交 `9e4a0ad4` 的源代码快照重新生成 `2001361477/t3`，得到与当前实现完全相同的冲突：

- 宽 12：`-6.29:455.49/-7.73:435.73`
- 宽 8：`15.31:458.83/20.69:406.52`
- 违例位置：`(-7.01, 445.61)`。

该失败在原提交即存在；未通过改坐标、缩窄主干道、改变种子或放宽 `crowdedArterials: 0` 上限消除它。因此，本轮新增功能与截图中的断桥修复已有针对性通过证据，但全量 City 普查仍有这一处既有失败。生产规划继续保留既有 `degraded` 语义，不宣称完整物理/预算认证。

代码与两份审阅后的基线留在原工作分支；本轮未创建提交或合并到主目录的驾驶模式分支。

## 2026-10-15 匝道衔接视觉修正

用户近景指出分流口护栏和边线交叠。渲染改为在匝道完整横截面离开主桥幅后才开始下降；重叠区不绘制匝道边线；主桥护栏开口覆盖前 40% 分流段。此修正不改变规划拓扑和 golden。已在当前 2000 会话预览观察，并增加主线范围内不得出现匝道边线的实例矩阵回归断言。

## 合并前修复（2026-10-15，进行中）

上文版本 3 的「既有失败」记录保留为历史证据，本轮针对它修复准入盲区：长主干道的中点可能离开局部重叠范围，待后续路口拆边才暴露净距冲突。准入现在额外按最长 10 单位的直线分段应用相同 `crowdedPolylinePair` 判据，拒绝发布冲突街区，不放宽约束、不缩窄主干道、不删除已引用边界。增加长宿主合成见证和 2001361477/t3 的最终规划回归。

匝道选址移动到 `solvePlan` 之后，30 岛基线同时断言每条最终匝道仍接触非桥地面宿主。生成器版本 4；规划基线变化为 9/30 岛，影响道路、地块、设施避让和车流，场景日夜变化对应同样布局。

纳入 main 的回放起点和时间跳变修复，恢复 `verify-city-replay-snap` 与显示组登记，清单为 82。迁移守卫的鸟间距从旧绝对单位改为至少一个实际渲染翼展，与本分支已完成的 2 米比例尺迁移一致；没有改变鸟群或物理约束来迁就测试。

当前快速套件 32/32、回放守卫、迁移守卫通过；完整 City 套件运行中。最终是否具备合并条件以本轮完整结果为准。

### 大城市准入扫描优化

对分段准入增加相同 25 单位阈值的扩展包围盒排除，并在单次批次内复用已采样道路；不可能接近的道路不再反复分段分配数组。优化后 30 岛版本 4 基线逐项匹配。优化前的完整测试运行在最高档海滨阶段主动停止，不计为通过；最终完整结果将来自优化后的重新执行。

已创建功能提交 `ad697cfa` 和 main 整合提交 `46d3c213`；整合只解决回放/登记重复编辑，整合前后代码树相同。main 为当前分支祖先；尚未把功能分支合并回 main。
