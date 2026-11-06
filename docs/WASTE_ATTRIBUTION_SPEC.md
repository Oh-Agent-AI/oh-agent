# 失败区间成本暴露与告警 Spec（原 Waste Attribution 提案）

> 状态：**Draft v1.1（2026-09-30，评审修订；未实现）**。依据两路代码调研（2026-09-29，subAgent
> 报告全文见会话记录；关键证据以 file:line 内嵌本文）。
> 触发：原 v1.0 提议将重复失败涉及的整回合输入折算为「疑似浪费金额」。
> 评审发现这并非已证明的浪费，且逐回合取整与现有会话名义成本口径不同。
> 本版先验证「失败区间成本暴露」是否有用；`SESSION_TRACE_DIAGNOSTICS_SPEC.md`
> r6 的「诊断不给浪费金额」红线**暂不撤销**。
> 关联：`docs/SESSION_TRACE_DIAGNOSTICS_SPEC.md`（r7 现行）、
> `docs/ATTRIBUTABLE_WASTE.md`（v3，浪费口径真相源）、
> `docs/LANDING_VALUE_FIRST_SPEC.md`（首发不依赖本 spec 的金额）。

---

## 0. 一句话结论

先在**单会话**展示重复失败区间涉及的回合、输入 token、证据与可用时的
**相关回合名义成本估算**。这衡量的是成本暴露，**不是浪费、可节省金额或
已支付账单**。跨会话月度汇总与后台通知是独立决策门，只有证据覆盖、
计费模式、去重、性能和误报验收通过后才实施；landing 首发不等待它们。

---

## 1. 预期 vs 现实：用户目标视角的差异分析

用户的完整目标是四层（G1→G4），逐层对照代码现实：

| 层 | 用户目标（预期） | 代码现实（调研证据） | 差距定性 |
|---|---|---|---|
| G1 感知 | 「本月哪些会话值得复核」 | ❌ 诊断仅在打开单个会话详情时现算；无跨会话汇总 | 可先做候选列表，不预设可加总的浪费金额 |
| G2 定位 | 「烧在哪个会话、哪次失败」 | ✅ 已达成：repeated_failure 诊断 + 证据摘录（错误/参数）+ R1 深链 | 无 |
| G3 量化 | 「这段失败涉及多少计费暴露」 | ❌ r6 红线：诊断不含金额；现有名义成本是回合/会话投影，不是浪费归因 | 先验证单会话展示的净价值与误读率 |
| G4 行动 | 「新的重复失败能否提醒我」 | ❌ 查询时现算、无告警钩子；tick 不跑诊断 | 后续告警，不承诺实时止血 |

**三个关键的「现实比预期更难」**（决定设计边界）：

1. **逐调用 token × 失败状态不可 JOIN**（调研一 §3）：token 最小单元是
   `usage_facts` 逐助手调用行，失败最小单元是 `workflow_events.tool_finished`
   行；两表 id 空间不同源（`usage_fact.rs:57-67` vs `workflow.rs:46-49`），
   唯一公共轴是回合桶。且**失败的模型 API 调用通常整行缺失**（claude
   emitter 无 usage 载荷即 SKIP）。→ 事实级归因需要 ingest 桥接改造，
   本期不做；回合粒度只能称「相关范围」，不能称浪费上界。
2. **可避免性不可判**：`error_class` 全空（G8 缺口，2,775 次失败无分类，
   spec §5.3:150）。→ 不能给可避免性或确认浪费结论。
3. **r6 移除金额的理由正是粒度与可避免性**：失败所在回合还含正常工作，
   加免责声明无法把整回合输入变成「浪费」。金额若展示，只能解释为该范围
   的名义成本暴露。

## 2. 口径裁决与现有代码差异

`ATTRIBUTABLE_WASTE.md` 的分类框架**不能代替因果证据**：给整回合输入附上
`classification=opportunity`，也无法证明其中多少可避免。本期保留 r6 对
「浪费金额」的禁令，只允许经独立验收的「相关回合名义成本估算」进入诊断。

现有 [`session_insights.rs`](../crates/agent-vitals-query/src/query/session_insights.rs)
已给回合和会话分别计价，但注释明确：**会话合计另按会话级分组计价，不是
回合金额相加**，因为逐回合取整会累积误差。原 v1.0「每组取整求和沿用会话
合计」的说法错误，不能作为月度汇总依据。还必须核对计费路由：订阅覆盖的
名义 API 价格不是边际实付；未知 provider/价卡不得折成零或实付金额。

展示守卫：始终同屏标明「相关回合、含正常工作、不是可节省金额」；按量估算、
订阅覆盖与无法计价分别呈现；不同币种、不同计费 basis 不合并。不进入
`MonthlySummary`、账单、确认浪费分子或营销 Hero 的「省钱」读数。

## 3. 数据可用性矩阵（实施前按当前代码与真机样本复核）

| 维度 | 状态 | 证据 |
|---|---|---|
| 逐助手调用 token（四桶+模型+provider+峰谷+就近价卡版本） | ✅ | usage_facts；load_calls query/session_insights.rs:38-67 |
| 逐工具失败（outcome/参数指纹/错误摘录） | ✅ | workflow_events + v16 富化列 |
| 失败命中回合输入 × 回合名义金额 | ⚠️ 可关联、不可直接等同浪费 | domain `repeated_failure` 的 `impact.tokens` 对命中回合输入求和；query 的 `price_groups` 独立计价 |
| 事实级 token-失败血缘 | ❌（本期不做） | 两表 id 不同源 |
| error_class（可避免性） | ❌ 全空 | G8 |
| DSH 式 measured 净增长 | ⚠️ 仅 DSH | dsh/sessions/waste.rs:169-215 |
| 通知冷却原语 | ✅ | `claim_delivery_key_with`（billing/budget_notifications.rs:64-108，通用键、投递失败不记账本可重试）|
| 计价入口 | ✅ 名义按量估算入口；须审计适用计费模式 | `metered_estimate_minor` cost/mod.rs:45；None≠0，订阅不等于实际按量支出 |

## 4. 设计

### 4.1 S1 · 单会话失败区间成本暴露（工期待样本/性能评估）

**口径定义（本 spec 的核心裁决）**：
- `affected_input_tokens` = `repeated_failure.impact.tokens`：失败命中回合的
  输入四桶之和，含正常工作；**不命名为 `waste_tokens`**。
- 仅选中命中回合的 usage facts，经现有价卡快照与计费 basis 规则生成
  `affected_turn_nominal_cost`；逐组/逐回合舍入规则须与现有回合展示一致，
  同屏说明它**不保证与会话名义成本可相加或严格相等**。不得把「回合输入
  Token」直接乘单价：缓存读/写、输出、峰谷、provider 均有不同价格语义。
- 对订阅覆盖、未知路由、缺价卡、不同币种分别降级；部分计价必须附未计价
  Token 与原因。若无法保证 basis 正确，先只显示 Token 与证据，不显示金额。

**DTO（独立键；既有 golden 计费输出不变，但 insights fixture 需评审更新）**：
```json
failure_exposure: {
  affected_input_tokens: <i64>,
  nominal_amounts: [{amount_minor, currency, billing_basis}],
  coverage: "full" | "partial" | "unavailable",
  unpriced_tokens: <i64>,
  granularity: "affected-turns",
  reason: null | "no_pricing_snapshot" | "no_price_card" | "route_unresolved" | "subscription_covered",
  disclaimer: "<相关回合含正常工作；不是浪费、可节省额或实付账单>"
}
```
挂载点：仅 session insights envelope（`fixtures/session_insights/
insights_envelope.json` 冻结面，additive 追加并经 fixture 评审）。不预设
`waste_summary(month)`。若使用 ReadMemo，需证明数据库 revision、价卡叠加层、
计费配置与统计时区的变更均能使缓存失效，而不是只凭旧 spec 推断。

**UI**：只在 repeated_failure 诊断详情显示「涉及回合输入」和可用时的
「相关回合名义成本估算」，紧邻证据与边界说明；不放进会话摘要、Overview
发现条或本月费用卡。契约脚本仍禁「浪费 ¥X / 可节省 / 省下 / 已多付」；
只对这个明确标注的成本暴露字段放开金额，断言口径标签、缺价/订阅降级与
免责声明同屏可见。

**文档**：`SESSION_TRACE_DIAGNOSTICS_SPEC` 记录「名义成本暴露不等于浪费
金额」的有限例外；`ATTRIBUTABLE_WASTE.md` 的 confirmed/opportunity 分子
保持不变。仅在证据支持独立浪费指标后另案申请修订。

### 4.2 S2 · 跨会话候选汇总（独立决策门，非 S1 自动延伸）

先验证「重复失败会话列表」是否比单个大金额更能帮助用户行动。若拟做月度
金额，必须先证明：会话/诊断区间不重复计数、逐回合与会话级舍入差异可解释、
按量/订阅/未知路由与币种隔离、无价卡覆盖率同屏展示、全月查询在真实大库
满足性能预算。未通过时只列 top 会话及涉及 Token，**不展示月度金额合计**。
月度结果无论如何不称「浪费总额」。

### 4.3 S3 · 新增重复失败通知（独立开关与实机验收）

1. **触发面**：light tick 尾部（drain 后）对**本轮有新事实的活跃会话**跑
   轻量检查；先量化查询成本与同步延迟。通知只保证「检测到新证据后提醒」，
   不宣称实时、能阻止后续消耗或必然覆盖短暂失败串。
2. **判定**：与 domain 配置对齐：同一调用指纹的默认阈值为 2 次，同工具
   短窗口默认阈值为 3 次；通知可另定更高阈值，但必须明确写为告警阈值，
   不称「与诊断一致」。用稳定的会话/窗口/指纹身份去重，应用重启、日志
   回填和会话更新后均不得重复轰炸；单纯进程内存不足以承担持久去重。
3. **通知**：`claim_delivery_key_with(data_home, key, now_ms, send)`，键=
   `failure-alert:{session_key}:{window_id}:{fingerprint}`（精确定义与过期策略
   在实施前冻结），冷却默认 30 分钟；正文仅说「连续失败 N 次，点此检查」；
   新增独立偏好（默认关），不复用 Trust 通知同意。
4. **验收**：通知点击到对应会话/区间；无权限、来源延迟、重复回填、重启、
   发送失败与冷却到期均有测试。循环检测另案，不借用本告警的成立结论。

### 4.4 明确不做（本期）

- 事实级 token-失败血缘（usage_facts/workflow_events 加列或归因桥表）：
  ingest 改造 + 回填，另案立项；本 spec 的粒度上限声明就是对它的诚实对冲。
- 跨执行环境 measured 净增长口径（DSH SV-COST-02 式）：claude/codex 标准化层
  无 context_tokens，不可比。
- 把 `failure_exposure` 计入 MonthlySummary、账单、`amounts_by_basis` 或
  confirmed waste 分子；也不以其制作 landing「白烧金额」Hero。
- 「可节省金额」及无法验证的已浪费金额，均不做。

## 5. 分期与验收

- [ ] **S1a 口径与样本审计**：至少覆盖正常工作与失败同回合、订阅、未知
  路由、缺价、跨币、回合/会话舍入差异；确认显示金额的适用范围。
- [ ] **S1b 单会话 DTO + UI**：`failure_exposure` additive 追加、fixture
  评审、证据同屏、契约断言及本地真机可用性测试。
- [ ] **S1c 文档**：诊断 spec 记录有限例外；不改浪费分类真相源。
- [ ] **S2 候选汇总决策**：去重、覆盖、计费隔离、性能与用户理解度验收；
  未通过则只保留候选列表，不上月度金额。
- [ ] **S3 通知决策**：阈值/身份/延迟/重启/冷却/点击深链/默认关验收。

**S1 发布门**：golden 与 Python/Rust 锁步零意外漂移；契约与真机测试通过；
无价会话显示 Token 与原因而非 0；订阅覆盖绝不冒充实际按量支出；测试
确认用户不会将该金额理解为可节省额。**landing 发布不依赖 S1/S2/S3**。

## 6. 风险与守卫

| 风险 | 守卫 |
|---|---|
| 用户把暴露金额误读为浪费/实付 | 字段和主标签明确为「相关回合名义成本」；同屏给出正常工作混入与计费 basis；用户理解度实测 |
| r6 红线被营销绕过 | 不允许「疑似白烧 ¥X」上 Hero；若未来有因果证据，另案修订诊断与浪费真相源 |
| 月度重叠与性能 | S2 独立发布门：去重/舍入/覆盖/真实大库预算，不靠 memo 掩盖冷启动成本 |
| 告警疲劳与时效误导 | S3 独立偏好、冷却、持久去重、同步延迟标注、点击证据深链 |
| 双真相与舍入 | 同一计价组件，但分别记录回合/会话聚合单位；测试允许可解释的舍入差，不宣称必然相等 |

## 7. 测试矩阵

| 层 | 测试 | 阶段 |
|---|---|---|
| domain/query | 命中回合筛选、四桶计价、计费 basis、缺价/跨币、回合/会话舍入差异 | S1 |
| 契约 | DTO 形状、禁浪费/节省词、边界同屏、空值与 reason 词表 | S1 |
| 汇总 | 去重、覆盖、冷启动性能、不同 basis 隔离、月份时区 | S2 决策门 |
| 桌面 | 阈值、延迟、冷却、重启/回填不重报、默认关、点击深链 | S3 决策门 |
| 全局 | golden 零漂移 + Python 锁步 + clippy -D + verify:react | 每阶段 |

---

## 实施状态与决策门处置（2026-09-30，S1 落地后记录）

> 本节由实施会话补记：spec v1.1 评审修订（"疑似浪费金额"收紧为"失败区间成本
> 暴露"）曾以工作副本形式存在，未及提交即被分支操作覆盖；其 §4.1 语义已由
> 提交 c320a8b9 + 2eb84200 完整实现（failure_exposure / affected_input_tokens /
> affected-turns 名义口径 / 跨币分栏 / unpriced 不按 0 / r8 有限例外文档），
> 实现以本节记录为准与代码对齐。

- **S1（单会话失败区间成本暴露）：已实施并通过 subAgent 验收**（一轮拒绝
  [S1c 文档门 + 3×P3] 全部修复后复验全绿：workspace 56 套件 0 失败、clippy
  -D 干净、golden 16 一致、Python OK、verify:react 14 OK；r8 有限例外已记入
  SESSION_TRACE_DIAGNOSTICS_SPEC）。
- **S2（跨会话候选汇总）：明确延后至后续版本。** 理由：它是独立决策门而非
  S1 的自动延伸（v1.1 §4.2 原文）；S1 刚落地，跨会话汇总的排序/去重/展示
  语义应先由 S1 的真机使用证据驱动，避免在单会话口径尚未被用户验证前预制
  汇总口径。重开条件：S1 在真机使用中证明"失败区间暴露"被用户理解且被
  要求跨会话对比。
- **S3（新增重复失败通知）：明确延后至后续版本。** 理由：v1.1 §4.3 要求
  独立开关与实机验收（触发时效、默认关闭、持久去重、点击到证据）——通知
  是打扰面，须在 S2 证据与通知疲劳政策（冷却/去重/勿扰）一起设计后另案。
  现有 quota/budget 通知基建（claim_delivery_key_with）已确认可复用。
