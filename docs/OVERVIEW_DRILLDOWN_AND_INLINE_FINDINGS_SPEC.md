# 试点前补齐：总览→会话穿透、内嵌发现项、小时分布化石清理 Spec

> 状态：**Draft v1.0（2026-09-27）**。
> 触发：首发试点的痛点覆盖审计（2026-09-26）+ 审计修正。审计曾误判「Claude
> 无小时分布」，核实后收回：`hourly_by_harness` 自 v0.9.1 Phase 3.5 Tier B 起就是
> 三执行环境统一查询（`usage_facts` 行级事实 × 北京小时），UI 三执行环境全画。剩余真缺口
> 是**点击穿透**与**内嵌发现项**两项，外加三处误导性化石。
> 定位：让 landing page 的每张截图都有实物背书——痛点②（消耗突变找到对应任务）
> 与痛点③（高消耗后知道原因和下一步）在首发四页内闭环。
> 前置：refresh-storm R1–R6a 已合并（`779915c`…`2a2856a`）；React cutover 已
> 出货（`frontendDist: ui-react-dist`）；W3 分层重构后小时分布住在
> `crates/agent-vitals-query/src/query/summary/bundle.rs`。
> 关联：`AGENT_VITALS_APP_V1_0_0_PRD.md`（首轮验收目标）、精益画布讨论
> （首发保留 总览/用量/会话/设置；「发现」作为相关页面中的事项呈现——本 spec
> 就是兑现这句）、`RUNTIME_INVALIDATION_AND_READ_BACKPRESSURE_SPEC.md`
> （刷新/gate 纪律沿用，不重开）。

---

## 0. 一句话结论

三件事让首发四页真正覆盖痛点②③：**总览/用量页的日与执行环境行一键穿透到过滤后的
会话列表**（异常→会话从两步手工变一步）、**总览页内嵌 top 发现条**（「发现作为
相关页面中的事项呈现」的落地，痛点③从无到有）、**清理小时分布的三处化石**
（死参数/陈旧注释/特化测试名——它们刚误导过天天在仓库里干活的人）。全部为
additive 改动，不动计费口径、不动 golden 契约、不动 hourly 数据面。

---

## 1. 不可变决策（实施期间不重开）

1. **数据面零新口径。** 穿透所需的日期过滤若 `sessions_list` 现无参数，则给它
   加**可选**参数（additive，旧调用行为逐字节不变），SQL 走 `sessions` 表既有
   的 `span_first/span_last` × `beijing_day_bounds_ms`——与日历/小时轴同一个
   北京日语义，不发明新窗口定义。不新建命令。
2. **React 导航用既有 hash 路由扩展**（`#sessions?date=YYYY-MM-DD`），不引入
   路由库/状态管理（背压 spec §6 同款裁决）。后端托盘深链（`WorkbenchTarget`
   / `focus-tab`）不动——那是菜单栏的另一条通路。
3. **内嵌发现条只读既有安全投影。** 数据全部来自 `findings_groups_safe` /
   `decision_matrix_safe` 的现成 DTO（脱敏纪律 = 数据保留与 serving-face 政策，
   不在总览引入任何新载荷字段）；每条必须有「去看证据」的可达路径，没有路径
   的发现不上条。
4. **不恢复 Findings 独立页。** 首发 4 页裁决不变；发现条的内联展开就是它的
   完整呈现面（画布原话：「Trust、Skill 和测试能力留待各自用户任务验证后再
   开放独立入口」——findings 以事项形式呈现，不开页）。
5. **化石清理零行为变更。** `hourly_distribution` 的载荷、SQL、memo 键全部
   不动，只删死参数、改写误导注释、去测试名特化；golden 与既有契约零漂移是
   验收线。`calendar_month` 的 `codex_home` 参数是否同为死参实施时核实，是则
   一并清理，否则保留。
6. **不跑 rustfmt / 不做自动格式化**；React 契约脚本同步扩展（overview /
   sessions 两个）。不引入新依赖。

---

## 2. 现状与缺陷（代码证据）

### 2.1 痛点②的缺口：异常 → 会话无点击穿透

| 事实 | 证据 |
|---|---|
| 总览页执行环境行纯展示，无任何导航接线 | `OverviewPage.tsx:114`（`overview-harness-row` 只有 token 计数文本） |
| 总览日条/用量页日格无「查当日会话」入口 | `UsagePage.tsx` 日值图例 `["DSH","CC","CX"]` 与小时图均为纯展示 |
| React 无带参导航 | hash 路由只有页名（`pageFromHash`），无 query 解析 |
| `sessions_list` 疑似无日期参数 | 需实施时核实（IPC 签名 + SQL WHERE；sessions 表有 `span_first/span_last` 可用） |

结果：「这周烧得快 → 是哪个任务」要手工切到会话页再人肉翻——landing page 的
会话轨迹截图（转化核心图）没有对应的实机动线。

### 2.2 痛点③的缺口：总览无发现项

| 事实 | 证据 |
|---|---|
| findings API 只被 FindingsPage 消费 | `tauri.ts:2306`（`findings_groups_safe`）、`:2323`（`decision_matrix_safe`） |
| OverviewPage 无任何 findings 元素 | grep 零命中 |
| 画布首发承诺未兑现 | 「发现作为相关页面中的事项呈现」——目前是 0% 呈现 |

结果：痛点③（知道原因和下一步）在首发界面上只有预算告警阈值可看，「下一步
怎么办」没有落点。

### 2.3 化石（误导源，审计报错的直接原因）

| 化石 | 位置 | 危害 |
|---|---|---|
| 死参数 `codex_home` | `agent-vitals-query/src/query/summary/bundle.rs:5-6`（函数体第一行 `let _ = codex_home;`） | 暗示 hourly 依赖 codex 源 |
| 陈旧 doc 注释 | `lib.rs` `read_hourly_distribution` 命令上方：仍描述已退役的三路拼装（「claude=facts-index，该日会话被 ingest 过才有」） | 描述不存在的覆盖面限制 |
| 特化测试名 | `read_hourly_distribution_matches_calendar_codex_day`（fixture 用 codex 日） | 名字读作「仅 codex」 |

---

## 3. 架构总图

```
数据面（不动）
  usage_facts ──hourly_by_harness──▶ 小时分布（三执行环境，已统一）
  sessions(span_first/span_last) ──beijing_day_bounds──▶ [新增] 日期过滤 WHERE（可选参数）
  findings_groups_safe / decision_matrix_safe ──▶ [新增] 总览内嵌条（只读既有 DTO）

动线（本 spec 新增的箭头）
  用量页日格 ──点击──▶ #sessions?date=YYYY-MM-DD ──▶ sessions_list(date) 首屏锁定
  总览执行环境行/日行 ──点击──▶ 同上
  总览发现条(3) ──展开──▶ decision_matrix 行内证据锚点 ──跳──▶ 会话详情
```

---

## 4. 修复设计

### 4.1 R0 · 化石清理（~0.5 小时，先行）

1. `hourly_distribution` / `hourly_distribution_memoized` 删 `codex_home` 参数
   （连带 `lib.rs` 命令与 `agent-vitals-query` 门面签名）；`calendar_month` 的
   同名参数实施时核实真伪，同死则同删。
2. 命令 doc 注释改写为现实现：「三执行环境统一——`usage_facts` 行级事实按北京小时
   聚合（v0.9.1 Tier B）；`harnesses_available` 如实标注每执行环境在场与否；库打不开
   = 全执行环境缺席」。
3. 测试改名 `read_hourly_distribution_matches_authority_facts_day`，并把断言
   从「与 codex 日对拍」扩为「三执行环境字段 + 来源标注」。
4. 验收：golden 16 条零漂移；Rust/React 既有契约全绿。

### 4.2 R1 · 点击穿透（~1 天）

1. **后端**：`sessions_list` 加可选 `date: Option<String>`（北京日
   `YYYY-MM-DD`）→ SQL 附加 `span_last >= day_start AND span_first < day_end`
   （`beijing_day_bounds_ms`；无参 = 现行为）。参数校验：非法日期返回
   `invalid_argument` 错误（不静默忽略——与 MCP 面的参数纪律一致）。
2. **React**：`pageFromHash` 扩展 query 解析（仅 `date`，URL-encoded，白名单
   页：sessions）；`navigate("sessions", { date })`；UsagePage 日格与
   OverviewPage 执行环境行/日行挂 `onClick`（含键盘可达性：`role="link"` +
   `tabIndex`，与既有 a11y 断言风格一致）。
3. **SessionsPage**：首载读 hash 的 `date`，传入 invoke；页内显示「按 2026-09-27
   过滤 · 清除」chip（清除 = 去 query 重载，回到全量）。
4. **降级**：`date` 过滤查零结果 → 如实空态「该日无已导入会话」（不是 bug 面）。
5. 不做：小时粒度穿透（首发到日即可）、跨日区间选择。

### 4.3 R2 · 总览内嵌发现条（~1 天）

1. **数据**：`OverviewPage` 挂载时单独 invoke `findings_groups_safe(pageSize=3)`
   ——独立于 `readOverviewDetails` 批（刷新节奏可独立，且 gate/revision 锁存
   已由 refresh-storm R1 覆盖）。DTO 原样（脱敏投影，零新字段）。
2. **呈现**：预算卡下方一条「需要注意」区：每项 = 规则名 + 脱敏一句话 +
   实例计数 + 严重度样式。排序沿用 FindingsPage 既有口径（不发明新排序）。
3. **展开**：点条目内联展开该 finding 的 `decision_matrix_safe` 对应行摘要 +
   「去看会话」锚点（有会话证据锚的 finding 才给锚点；无锚点的不给——
   决策 #3「没有路径的发现不上条」指不把无路径项放进 top3 的展示优先级，
   展开体内同样只给真实可达链接）。
4. **降级**：`findings_groups_safe` 失败 → 区块显示「发现服务暂不可用」（不
   隐藏、不编造空列表）；零发现 → 显示「当前没有需要注意的事项」+ 上次评估
   时间（诚实空态）。
5. **契约**：`verify-react-overview-contract` 扩展断言：发现条存在性、脱敏
   （不含路径/原始错误串——沿用 findings 契约的红线词表）、降级两态。

---

## 5. 明确不做

- 不恢复 Findings / Trust / Skills 独立页（首发 4 页裁决）。
- 不动 `hourly_distribution` 的数据面、memo 键、载荷形状。
- 不做小时粒度穿透、日期区间选择、per-model 小时图（数据有 `model_id` 但首发
  不需要——留给试点反馈驱动）。
- 不改托盘深链（`WorkbenchTarget`）与菜单导航。
- 不引入路由库/React Query；不在总览新增任何未脱敏载荷。

## 6. 分期与进度（每阶段测试绿后打勾）

- [x] **R0 化石清理**（6fb37f3）：hourly/calendar 双死参删除、注释改写三执行环境
  真相、测试改名；golden 16 零漂移
- [x] **R1 点击穿透**（6fb37f3 + 验收修复 3b5b914）：后端零改动（day/harness_kind
  v0.9.1 已有），hash 深链 date/harness 白名单 + day 窗 + 一次性消费 + hashchange
  跟随；契约断言入 sessions 脚本
- [x] **R2 内嵌发现条**（6fb37f3 + 3b5b914）：top3 + 证据链接门控（可过滤执行环境
  且有会话证据）+ 两态降级；契约断言入 overview 脚本。**偏差记录**：条内
  decision-matrix 展开未做（以执行环境会话深链为证据路径的等价落法），真机
  三动线手测待 bundle 后

验收评审（2026-09-28）：首判不通过（4×P2），全部修复后复验 10/10 契约绿；
P2-4 契约扩展以字面包含断言落地（正则转义事故 aeb4e3e 已修）。

## 7. 验收标准

1. **动线手测**（landing page 截图的实操背书）：用量页点一个高消耗日 → 会话页
   首屏即该日列表且带过滤 chip；总览执行环境行点击同理；发现条展开 → 点会话锚点
   → 会话详情打开。
2. **契约**：verify:react 全绿（含扩展后的 overview/sessions 断言）；
   `sessions_list` 无参调用输出与改前逐字节一致（对拍测试钉住）。
3. **golden / Python**：零漂移。
4. **量化门**：穿透首屏仅 1 次 `sessions_list`（带过滤，不先拉全量再筛）；
   总览挂载 invoke 数 +1（findings）。

## 8. 风险与守卫

| 风险 | 守卫 |
|---|---|
| `sessions_list` 加参数破坏既有调用 | 可选参数 + 无参对拍测试；IPC 契约 additive 纪律 |
| date 过滤与日历口径漂移（时区/边界） | 统一走 `beijing_day_bounds_ms`，测试用跨午夜会话 fixture 钉住边界（含 span_first=23:59 / span_last=次日 00:01 的会话归属） |
| 内嵌发现条引入脱敏泄漏 | 只读既有 safe 投影 + 契约红线词表断言（serving-face 政策） |
| hash query 解析引入任意参数注入面 | 白名单（页 × 参数名），未识别参数丢弃并保持页默认 |
| R1 onClick 损坏既有 a11y 契约 | 新交互元素带 role/tabIndex/aria-label，扩展而非绕过既有断言 |

## 9. 测试矩阵

| 层 | 测试 | 阶段 |
|---|---|---|
| Rust（query/desktop） | `sessions_list` date 过滤正确性（含跨午夜边界）+ 无参逐字节对拍 | R1 |
| 契约脚本 | hash date deep link 解析白名单；发现条存在性/脱敏/两态降级 | R1/R2 |
| 契约脚本 | hourly 化石清理后旧契约仍绿（载荷不变） | R0 |
| 全局 | golden 16 零漂移、Python 全绿、verify:react 10+ 全绿、clippy -D 干净 | 每阶段 |
| 手测 | §7.1 三条动线 | 收尾 |
