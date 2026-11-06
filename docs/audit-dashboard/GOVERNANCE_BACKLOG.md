# Agent 治理研究 → agent-vitals 治理 Backlog

> 来源：一份关于 Agent 成本失控/可靠性/治理缺失的行业研究（步骤超时、成本断路器、
> per-task 预算、反循环恢复、SubAgent 成本乘数等），对照当前 `dsh-client` 审计 tab
> 与 core 规则引擎的实际能力拆出来的。**先看 §0**，不然会把这份 backlog 做错方向。

---

## 0. 定位澄清（先说这个，不然会做错方向）

`dsh-client` 插件声明 `inject: ['sessionProjections']`（`dsh-client/src/harness/index.ts`
顶部，`scripts/verify.mjs` 断言过这一行）——这是**纯读投影**接口。浏览器侧连原始
事件都读不到（CLAUDE.md 原话："approval/sandbox events are log-only"），更没有
"在下一次 `tool/call` 执行前拦截并返回拒绝"这种钩子。

这不是实现疏漏，是 `docs/audit-dashboard/PRD.md` §3.2/§3.3 的**显式产品边界**：

> 不得设计任何看起来会暂停 Agent、阻止工具、修改审批策略、限制 Token/费用或改变
> 模型选择的控件，**除非该能力已经真实存在**。

真正的干预能力（预算硬顶、失败循环熔断、模型使用限制）已经被安排进 PRD §14 的
V3（预算管理）/V4（Guardrails），且明确要求"控制按钮存在的前提是背后有真实生效
的能力"——V2 宁可少做，也不做一个点了没反应的假按钮。

**因此这份 backlog 分三档**：
1. §1 已经实现、可以直接拿来当"治理证据"用的——不是从零开始；
2. §2 在现有只读审计架构里能做、只是没做的 V2.1/V3 增量（G1–G4）；
3. §3 结构性做不到的——需要 DSH 平台本身开放执行前拦截钩子，不是这个插件单方面
   能解决的，写清楚是为了不让人误以为"下个迭代就能补上"。

---

## 1. 已经覆盖的（对照研究里的四类痛点）

### 1.1 成本失控 → 已有观测能力

- `costReport` 投影（`dsh-client/src/harness/index.ts:468`）：逐模型定价
  （`per_model[*].total/peak/cache_read_cost`）、峰值/非峰值拆分、缓存命中实付、
  逐请求累计曲线（`series`，单调不降）；CLI 侧 `src/cost.rs`/
  `scripts/agent_vitals/agent/cost.py` 同款计价逻辑（四方 lockstep 的一环）。
- `tokenByModel`：逐模型 token 分桶 + 模型切换序列。
- Subagent 成本：`subagentUsage`（`dsh-client/src/harness/index.ts:260`）把子会话
  token/费用汇总进主会话费用卡副标题，**明确标注"合计是下限"**——子会话日志读不到
  时不冒充完整，这条纪律本身就是治理研究里"看不见有多少 Agent 在跑"的部分解药。

对应研究里"实时归因与可见性：按 Agent、团队、工作流精确记账"——**已经有**，缺的
是"预算上限/告警阈值"这层比较逻辑（见 G1）。

### 1.2 可靠性差 & 失控循环 → 已有检测，没有恢复动作

`crates/agent-vitals-core/src/domain/trajectory.rs` 的四个轨迹级检测器，和研究里"反循环
恢复"描述的**检测标准**几乎逐条对应：

| 研究里的描述 | agent-vitals 现有规则 | 阈值（`trajectory.rs` 常量） |
|---|---|---|
| 重复动作检测（同一工具连续调用超过 N 次） | SV611 重复工具调用 | 连续相同 `(name, arguments)` 签名 ≥3 次 |
| 无进展窗口（连续多步没有状态变化） | SV612 死循环 | 连续 2 个 turn 动作序列相同 |
| 连续 error turn / 连续工具失败 | SV613 进度停滞 | 连续 2 个 error turn 或连续 3 次带 `error.code` 的 `tool/result` |
| 权限异常（连续拒绝、危险模式反复授予） | SV614 权限异常 | 同一 `callId` ≥3 次审批 / 连续 ≥3 次 rejected / `danger-full-access` ≥2 次 |

**这是检测，不是恢复**：findings 只是标记出来给人看，不会自动打断循环、不会强制
反思、不会清理上下文。这条边界是 PRD §3.2 明确要求的，不是漏做——见 §3。

### 1.3 治理与控制缺失 → 已有可见性

- SV601–606：破坏性命令/提权/远程执行/敏感文件写/工作区外写/内网外联——覆盖
  "权限过大导致数据泄露/错误操作"的检测面。
- SV607–610：沙箱拒绝/工具超时/审批请求/`danger-full-access` 授权——覆盖"审批
  与责任"的可见性。
- Skill 审计（backlog `SKILL_EXECUTION_BACKLOG.md` T1–T12，刚验证完整条链路可用）：
  谁在什么时候用什么方式触发了哪个 skill、加载成功没有、花了多久，外加子 Agent
  覆盖率——直接对应研究里"看不见有多少 Agent 在跑"的一部分（前提是子会话日志
  读得到；读不到时 T6 的纪律是显式报缺口，不是显示"完整"）。

### 1.4 效率与集成痛点

- 上下文构成归因（FR-04a）、结构性浪费识别（FR-04b，重复工具结果跨 turn 判定）——
  已覆盖"上下文债务"里最容易量化的一块（重复读同一文件/同一工具结果）。

---

## 2. V2.1/V3 范围内能做、目前没做的（G1–G4）

这四项不需要新的执行时钩子，纯粹是"现有只读数据 + 一层阈值比较/展示"，架构上
站得住，符合 PRD §3.3 对 Audit Report 层的定位。按实现成本从低到高排序。

### G1 · 预算阈值 + 告警展示（2026-08-24 已完成）

对应研究里"per-task 预算"的"告警级"那一档。

**实现落点**：`dsh-client/src/client/components/audit/budget.ts`（存储，照抄
`notes.ts` 的 localStorage 守卫写法，但**不按 sessionId 隔离**——预算是可
复用的个人偏好，不是某条证据的备注）；`derive.ts::budgetStatus`（纯比较函数，
`ok`/`near`(≥70%)/`over`(≥100%) 三态，颜色只用现成的 `T.warn`/`T.error`
两档，没有为 85% 单独发明第三种颜色，具体百分比数字本身携带更细的信号）；
`VerdictSection.tsx::BudgetEditor`（挂在费用卡的展开面板里，**不新增
KPI 卡**）。全程未碰 core/wasm/harness——纯 `dsh-client` 前端叠加层，符合预期。
`verify-render.mjs` 补了 G1 专属断言（未设置/超预算/接近预算/远低于预算
四态），复用了 `__notes` 的 localStorage 桩子模式扩出 `__budget`。

- 现状：`costReport`/`tokenByModel` 只报**实际花了多少**，不报"相对于设定的预算
  还剩多少"。
- 做法：加一个用户可配置的 session/task 预算数字（纯前端本地存储，不需要后端），
  在 `costReport` 之上叠一层比较：接近阈值（70%/85%）→ 视觉告警；超过 → 醒目标红。
- 存储照抄 `dsh-client/src/client/components/audit/notes.ts` 的既有做法：
  `localStorage` + **`typeof localStorage === 'undefined'` 守卫 + try/catch
  best-effort**（存储被禁用或配额满不能让整个 tab 崩）。别自己发明一套。
- **仍然是只读展示，不拦截**——研究里"硬熔断"（调用前拒绝）那一档需要 §3 的执行
  钩子，这里只做可见性，对应 PRD V3"会话/项目预算上限、预警阈值"里的"预警阈值"
  部分（"超限策略"是 §3 的范围）。

### G2 · 循环检测的"代价标注"（2026-08-25 已完成）

- 现状（实现前）：SV611/612/613 报"发生了"，不报"这段循环烧了多少钱/多少 token"。

- **实现前必须先解决的前提**（查过 `trajectory.rs` 后发现，原来的估计过于乐观）：
  finding 的 11 键结构（`rule/severity/category/tool_name/evidence/seq/time/turn/
  step/call_id/evidence_recency`）**只有锚点 `seq`/`time`，没有区间终点**。
  - SV611：`seq` 是这一段连续重复的**起点**，重复了多少次只写进了 `evidence`
    文本（"bash 连续重复 6 次"），不是机读字段。
  - SV612：`seq` 是命中判定那一刻（第 2 个重复 turn 的 `turn/start`）的锚点，
    循环如果继续到第 5、第 10 个 turn **不会再报**（`trajectory.rs` 原话："run
    更长不重报"），所以从这条 finding 本身推不出循环真正在哪个 seq 结束。
  - SV613：同样只有 run 起点的锚点，`evidence` 文本里带真实 run 长度
    （"连续 6 个工具失败"），机读字段里没有。
  - 客户端 `FindingRow` 已有的 `f.seqs`/`f.count` 是**跨整段会话的去重分组**
    （同一个 `rule+evidence` 在会话里出现几次、各自的锚点 `seq` 是什么），
    不是"这一次循环覆盖了从 seq A 到 seq B 的区间"——两者容易混为一谈，
    G2 用错了会把"这个规则命中过几次"当成"这次循环烧了多久"来对齐 cost，
    对出来的数字是错的。
  - 结论：**G2 不能只在客户端拼接**，需要先在 `trajectory.rs`/`trajectory.py`
    给 SV611/612/613 的 finding 补一个机读的区间字段（例如 `run_end_seq`，
    SV611/613 已经在维护 run 长度和锚点，加一个字段成本不高；SV612 稍麻烦——
    "循环还在继续"这件事当前实现里判定完就丢了，要么改成"run 结束时才报、
    带真实终点"，要么额外收窄成"只标注已确认的 2-turn 区间，不追踪循环是否
    还在延续"，这是一个需要先定的设计决策，不是纯粹的拼接工作）。这一步动了
    `trajectory.rs` 的 finding 结构，要走四方 lockstep（core/Python/wasm/CLI）
    和 `tests/test_characterization.py` 的 byte-for-byte 断言，golden 大概率
    需要 `--update`（trajectory findings 在 `behavior --json` 的输出里）。

- **对齐 cost 之后要不要报，还取决于检测本身的漏检率**：SV611/612 是**参数原始
  字符串精确匹配**，不是语义匹配——模型如果每次换一点参数"试错"（换文件名、换
  flag），根本不会被判定成循环，G2 也就无从标注代价。也就是说 G2 能覆盖的只是
  "精确重复"这一类循环烧的钱，那类"看起来在瞎试、参数总在变"的烧钱循环，G2 上线
  后依然是盲区——这条要写进 G2 的验收范围里，不然容易被理解成"所有循环的代价都能
  看到"。

- 做法（前提解决后）：把 SV611–613 finding 的区间（锚点 `seq` → `run_end_seq`）和
  `costReport.series`/`tokenByModel` 对齐，findings 详情里加一行"这段循环消耗了
  X token / ¥Y"。研究反复强调的痛点是"看起来正常的日志，实际在烧钱"——这条直接
  把两者钉在一起；cost 引擎本身已经是纯函数，对齐这一步成本不高，**成本都在上面
  那条"先补区间字段"的前提里**。

**实现落点**：

- **前提（区间字段，四方 lockstep）**：`trajectory.rs`/`trajectory.py` 的
  `finding()`/`_finding()` 加了第 8 个参数 `run_end_seq`（`Value`/`None`）——
  与 `match_behavior`（SV601–610）追加同一个键，恒 `null`，保住
  `tests/test_characterization.py::test_trajectory_findings_share_the_same_
  key_order` 断言的"两类 finding 同构"不变量（12 键、键序一致）。三个真值
  语义：SV611 = 越过阈值倍数那一刻的当前事件 seq（窗口随重报累计变宽）；
  SV612 = **只覆盖判定命中的那个 turn**（`seq` 锚定的那个），不回溯被复制
  的上一个 turn（设计取舍，见 `trajectory.rs::finding` 的文档注释——"2-turn
  区间"曾经的两个候选方案里选了"不追踪循环是否还在延续"这支，更小的改动、
  不改变 SV612 的既有报告时机）；SV613 = run 里最后一个事件的 seq（`flush_
  error_run`/`flush_fail_run` 新增 `last_seq` 参数）。SV614 恒 `null`——计数
  类判定，没有区间概念。`crates/agent-vitals-wasm`/`src/behavior.rs`（CLI）/
  `scripts/agent_vitals/agent/behavior.py` 全是纯透传，无需改动；wasm 重新构建
  （`wasm-pack build --target web`）并只重新拷贝 `.wasm` 二进制（`.js`
  字节相同，`.d.ts` 是手写文件，不能被生成产物覆盖）。`dsh-client/src/harness/
  index.ts` 的 `findingSchema`（zod）补了 `run_end_seq: z.number().nullable()`
  ——不声明的话 zod 会静默剥掉这个键，前提字段就白加了；`behaviorFindings`
  的 `stateVersion` 4→5（state 形状没变，但 schema/view() 契约变了）。
- **对齐（执行环境侧，纯 TS，不产生新的四方 lockstep）**：新增 `loopCosts` 投影
  （`dsh-client/src/harness/index.ts`）——按 (行为规则事件类型 ∪ 计价用量事件
  类型) 的并集折叠，`view()` 里用 `audit_events` 拿到带 `run_end_seq` 的
  findings，筛出 SV611/612/613，按 `request_metrics` 逐请求行的 `seq` 落在
  `[seq, run_end_seq]` 区间内过滤，用新增的 `loopCostFor()`（复用
  `costSeriesFrom` 同款 `resolveCard` + `is_peak` 选档定价，不是另一套算法）
  求和，返回 `{rule, seq, tokens, cost}[]`（`tokens`/`cost` 为 `null` = 区间
  内算不出，不是 0）。客户端 `derive.ts::linkLoopCostToFindings` 按
  `(rule, latestSeq)` 把结果拼回 `FindingGroupedRow`（这三条规则的 evidence
  文本本身带次数/turn 号，同 `(rule, evidence)` 不会有第二次命中，不存在
  "合并后对错行"的歧义）；`FindingRow.tsx` 在展开详情里加一行"这段循环消耗
  了约 X token · ¥Y"（`tokens` 有值、`cost` 算不出时降级为"仅 token 数"）。
  `export.ts` 顺带把 `loop_tokens`/`loop_cost` 加进导出的 finding 行（同
  `waste_tokens`/`suggestion` 的模式）。`verify-harness.mjs` 用真实定价卡
  （`deepseek-v4-pro` 高峰价 9.0/27.0 每百万 token）手算期望值验证求和与
  区间过滤都对；`verify-render.mjs` 验证详情文案渲染与英文 locale 下的
  翻译完整性。

### G3 · Subagent 扇出可见性（2026-08-25 已完成）

- 现状：`skillAudit` 的 T6 覆盖率报"发现了几个子会话、覆盖了几个"，但没有把"子
  Agent 数量 vs 总 token 消耗"做成一个显式的"扇出成本"指标。
- 做法：加一个"本次会话派生了 N 个子 Agent，累计消耗 ¥X（占总费用 Y%）"的汇总行——
  数据都在（`subagent_spawns` + `subagentUsage`），只是没拼成这个视角。研究里
  DSH/Codex 官方都点名 SubAgent 是最大的成本乘数（Codex 官方文档："subagent
  workflows consume more tokens...each subagent does its own model and tool
  work"），这个指标能让"扇出决策"在事中就可见，而不是事后翻账单才发现。

**实现落点**：`SubagentSection.tsx` 新增 `fanoutLine()`（纯函数），挂在区块
标题下方——`total_cost`（已有）加上新传入的 `selfCost` 算总费用，`derive.ts`
的 `formatShare()` 复用小占比不被取整抹平那条纪律。`selfCost` 算不出时
（老执行环境/投影未就绪）降级为"仅金额"文案，不拿一个算不出的分母硬凑百分比——
两套 i18n 模板（`subagentFanoutSummary` / `subagentFanoutSummaryNoPct`）分开
写，不共用一句话再拼接。全程未碰 core/wasm/harness，纯 `dsh-client` 前端叠加层。
`verify-render.mjs` 补了三条断言：汇总行内容、`selfCost` 不可用时的降级路径、
英文 locale 下的中文残留扫描（同 D7 的做法，正则扫描而不是关键词枚举）。

### G4 · 历史基线对比

- 研究里"同一任务不同运行成本可差 30 倍"，正是 PRD V2.1"缓存命中历史基线"要解决
  的问题的一般化版本——把范围从"缓存命中率"扩到"本任务 vs 历史同类任务的成本/
  token 分布"。
- 技术上不难：`costReport`/`tokenByModel` 已经是纯函数，喂历史会话的输出进来对比
  即可，不需要新事件源；但需要先有"同类任务"的分组口径（按 skill？按项目 cwd？），
  这条待 PRD V2.1 排期时一起定义，不在本 backlog 展开。

---

## 3. 结构性做不到的（不是不想做，是这层插件没有这个权限）

研究里呼吁最强烈的三样——**成本断路器（调用前拒绝）、per-task 硬超时/步数熔断、
反循环恢复的"自动打断 + 清理"动作**——agent-vitals 的 `dsh-client` 插件结构上做
不到，原因见 §0：`inject: ['sessionProjections']` 是纯读投影接口，没有"执行前
拦截"钩子；这也是 PRD §3.2 的显式非目标，不是实现疏漏。

这类能力在 PRD §14 归入 **V4 Guardrails**（失败循环熔断、危险操作前置审批、模型
使用限制），**必须由 DSH 本身在 Agent Loop 里开放执行前钩子**才能做——类似
Anthropic Claude 的子 Agent 隔离机制，或 Codex Harness 强调的"应用层控制审批"
模式（应用/插件决定拦不拦，Harness 负责执行循环）。

在 DSH 开放这类钩子之前，agent-vitals 能做的最多是：把 §1 已有的判定逻辑（`SV601
–614` 复用 `crates/agent-vitals-core/src/domain/behavior.rs`/`trajectory.rs` 的纯函数）
准备好，等钩子开放后直接喂给它做"该不该拦截"的判断——**但执行拦截本身不可能在
一个只读插件里实现**。如果治理目标包含"真正挡住下一次调用"，这条路线需要先跟
DSH 侧确认它是否/何时会开放 pre-execution hook；在那之前，G1–G4 是这个仓库能
独立交付、且立刻可用的部分。

---

## 4. 建议顺序

G1（预算阈值展示）→ G2（循环代价标注）→ G3（扇出可见性）→ G4（历史基线，依赖
V2.1 排期）。G1–G3 都是纯前端叠加层，不碰 core 规则引擎，不产生新的四方 lockstep
义务；G4 触碰"同类任务分组"这个新概念，需要先在 PRD 里定义口径，成本明显更高，
放最后。
