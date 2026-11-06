# Agent Vitals v0.9 Data Foundation 架构规格

> 状态：架构规格 R4（2026-09-05 修订；R3 同日发布。R4 收录当日落地的
> KPI/计费归属实现、实现状态对照表与剩余工作分期——架构决策与 R3 一致，无推翻）  
> 前置：干净收口的 v0.8（含 Skill Surface ownership migration）  
> 后续：`AGENT_VITALS_V0_10_VALUE_LOOP_ARCHITECTURE_SPEC.md`

## 0. 版本定位

v0.9 是独立可发布的**可信数据底座**，不是 v0.10 的施工前置。

它回答的产品问题是：

> 用户看到的月度成本、用量、订阅覆盖、按量估算和数据缺口，能否追溯、重放、恢复并诚实解释？

```text
Harness source
  → CanonicalSession / UsageFact / HarnessBillRecord
  → agent-vitals-data durable evidence plane
  → rebuildable SQLite query projection
  → cost / coverage / billing projection
  → CLI / Tauri / HTML
```

v0.9 不交付通用任务图、问题→方案→执行闭环或 LLM evaluator；这些属于 v0.10。

### 0.1 Stage 0 的可信度边界

v0.9 不把当前展示错误留到后续版本。它的 **v0.9.0 Stage 0：Data Access Foundation**
首先完成控制台的**诚实展示**：过期、未同步、部分覆盖或执行环境未接入的日/月数据不得渲染为
`¥0`、“正常”或看似完整的总额；每一个金额都必须可见其执行环境范围、计费口径与最后有效时间。

Stage 0 不要求先完成 SQLite 迁移。它先建立稳定的 Data Query API，并可由现有 JSON
projection、Claude ledger 和 WorkBuddy source adapter 实现；UI/CLI 自此不再直接读取这些
文件。随后阶段只替换 Data 内部的写入与索引实现，不改变上层查询契约。

### 0.2 实现状态对照（R4，2026-09-05 收盘）

当日两轮迭代已落地（提交序见 git log `c7d0e06..01f0d9a`），§2.1 清单之外**计划外提前
完成**的部分一并列入：

| 交付物 | 状态 | 落点 |
|---|---|---|
| Stage 0 全部七步（DTO 冻结 / data crate / CLI 收口 / 三执行环境接线 / data CLI / Tauri 命令 + 数据源 panel / 四执行环境 fixture） | ✅ 已完成并合入 main | `1596836`（执行记录 `AGENT_VITALS_V0_9_STAGE0_RESEARCH.md`） |
| 计费模式声明层 `billing_modes` + `billing_route_of`（与价卡解耦，无价卡模型可归属） | ✅ | Stage A `c7d0e06` |
| 权威归属视角 `by_provider`（harness ≠ billing source，条目级单币 currency） | ✅ | Stage B `f004756` |
| `FixedSubscription` 写入方（账期过滤、零用量照摊、只进月不进日）+ `total_actual_spend` 分币 | ✅ | Stage C `68ca4eb` |
| 总览感知层看板（KPI 行 / 双轨账 / 决策卡 / 本月结论行）+ Token 日历跨执行环境逐日 | ✅ | Stage D `6586112`/`f110066` |
| 名义成本口径（list-price，"名义 GDP"式客观基准） | ✅ 定义 + 实现 | 定义 `ATTRIBUTABLE_WASTE.md` §6.7（提交 `9b279ca`）；实现 = catalog 计价面既有产物被正式命名 |
| 性能形状：codex fold 进程级 60s memo（`codex_merged_cached`，Arc 命中） | ✅ | `d8c6c83` |
| 审查修复：`CODE_REVIEW_V0_9_STAGE_A_D_KPI_BILLING` 10 条 + `CODE_REVIEW_V0_9_WORKBENCH_UX` 14 条 | ✅ | `29c0717`/`0096607`/`01f0d9a` |
| §2.1 其余八项：writer（✅ `93fbc0d`）、emitter 归位（✅ `f1850bc`）、ingest service（✅ `0f1d6b5`）、SQLite 投影（✅ `2d32ed0`）、lease（✅ `6b3aadd`）、BillingContext（✅ `9fbf920`）、checkpoint（✅ `e03e712`，随 sync_service）、故障注入（🔶 `3ffe10f`：facts/projection/lease 三点有注入测试）；**SummaryRepository 索引实现（替换 Stage 0 read adapter）—— ❌ 未达成（v0.10 主线，见 §5.2a）**；生成事务 / HarnessBillRecord（待 WorkBuddy 范围确认） | 🔶 | 分期见 §7 Stage A–C |

**数据缺口（阻塞实际侧计费精度，等用户输入，非工程阻塞）**：中转商对
claude-sonnet-5 的 cache_read 单价（决定 claude-* 实际支出 78.9%）、GLM 官方按量
价卡（77.3M token 报 unpriced）、ChatGPT Plus 月费金额（利用率不可算）、
名义成本统一展示用的汇率（可先分币不折算）。

## 1. 用户可见能力

1. 月度总感知成本：固定订阅与按量成本分开，不把 API 等价额伪装成账单。
2. 每一项成本都有 `basis`：`measured`、`derived`、`estimated` 或 `unresolved`。
3. 数据源状态可见：哪些执行环境、日期和模型已覆盖，哪些仍在估算或缺失。
4. 用户可重建本地索引，应用崩溃、索引损坏或并发运行不应悄悄改变账目。
5. CLI、Tauri、HTML 对同一 projection 的关键数字一致。

## 2. 范围

### 2.1 必做（R4 分期；状态对照见 §0.2）

**P0 —— 消除已知病灶（Stage A，下一轮主体）**

- `UsageFact` append-only writer、稳定 identity、去重与 reconciliation；
  *这是读侧形状歧义的根本解：summary.rs 现按执行环境逐个适配 month.json /
  claude-ledger / codex fold 三种 wire 形状，写入统一后歧义消失（审查 #2/#5 类
  缺陷的病根）*；
- `CanonicalSession` 最小持久化 + JSONL 事实作为审计输入；
- Runtime 共享 evidence/ingest service（Stage 0.3 已收口 CLI 侧，本项补 data 侧）。

**P1 —— 多进程一致性（Stage B 前半，与 SQLite 投影同批）**

- 跨进程 writer lease（托盘 tick 与 CLI 同时写 `month.json` 已有真实冲突面）；
- `SourceFingerprint`、checkpoint、增量失效；
- 可删除、可重建的 SQLite 查询投影（替换 Stage 0 的 JSON read adapter；
  Data Query API 与上层 DTO 不变——§0.1 承诺在此兑现）。

**P2 —— 完整性收口（Stage B 后半 + Stage C）**

- intent → facts → projection → manifest 的可恢复 generation transaction；
- `HarnessBillRecord`（WorkBuddy credit_json 是全仓唯一真实执行环境账单，落地时
  BillingBasis::HarnessBilled 首次获得生产写入方）；
- BillingContext / UserProfile：订阅、按量账户、预算、模型/价格来源和
  unresolved（吸收本轮的 `billing_modes` 声明层——见 §4.1）；
- replay、故障注入测试、`data rebuild-index` CLI；
- coverage / data-quality projection 完整化（字段已有，投影层缺）。

此前清单中的「JSONL 事实与 canonical snapshot 作为审计输入」并入 P0；「Python
边界守卫、文档主从图」随各阶段同行交付，不单列。

### 2.2 明确不做

- `TraceGraph`、节点图、关键路径与图级指标；
- `IssueInstance`、`RemedyPlan`、自动执行、回滚、实际节省；
- LLM evaluator 或默认上传会话正文；
- 主动 MCP 网络健康探测；
- DuckDB 作为运行时第二状态库；
- `notify`/FSEvents watcher、DSH live subscription。

当前 Tauri 的五分钟 tick 与手动同步继续服务；watcher 必须等 checkpoint、replay、可恢复 writer 稳定后再进入后续版本。

## 3. 数据与所有权

```text
agent-vitals-harnesses
  raw wire → CanonicalSession / UsageObservation / HarnessBillRecord candidate

agent-vitals-data
  validation + fact identity + JSONL evidence + SQLite index
  checkpoint + writer lease + generation/recovery + query repository

agent-vitals-runtime
  ingest orchestration + source scheduling + projection invalidation/events

apps/cli / apps/desktop
  commands, authorization, versioned DTO rendering only
```

- Harnesses 不写 state、不决定套餐覆盖、不输出产品结论；
- Domain 保持纯：不读文件、不读凭据、不发网络请求、不取当前时间；
- `agent-vitals-data` 是事实写入、索引、恢复和查询的唯一数据边界；
- Runtime 编排 adapter 与 data，不拥有另一份账本或查询规则；
- UI 不从空数组推断 unavailable，必须消费 capability 与 coverage；
- 新命令不得直接读取执行环境日志或 state JSON。

### 3.1 `agent-vitals-data`：数据层，不是独立服务

新增 workspace crate `crates/agent-vitals-data/`。它是嵌入式本地数据层，不启动 daemon、
不开放网络端口，也不让 Tauri 或 CLI 绕过它直读 SQLite。

| crate / 层 | 允许依赖 | 不允许承担的职责 |
|---|---|---|
| `agent-vitals-domain` | 纯 Rust 类型与规则 | I/O、SQL、当前时间、执行环境解析 |
| `agent-vitals-harnesses` | Domain、受 feature 门控的源 I/O | 写共享账本、价格/套餐结论 |
| `agent-vitals-data` | Domain、SQLite 驱动 | 解析 harness wire、UI 呈现、同步调度 |
| `agent-vitals-runtime` | Harnesses + Data | 第二个 state/projection store |
| `apps/cli` / `apps/desktop` | Runtime 的版本化 DTO | SQL、state JSON、执行环境日志直读 |

数据层提供小型 typed repository/query service，而不是通用 Active Record ORM。例如：

~~~rust
data.ingest(batch)?;
data.rebuild_index()?;
data.daily_summary(DailySummaryQuery { date, harness_scope })?;
data.monthly_summary(MonthlySummaryQuery { month, harness_scope, billing_scope })?;
data.coverage_status(CoverageQuery { month, harness_scope })?;
~~~

`MonthlySummary` 必须同时返回 `total_summable`、`total_actual_spend`（分币）、
`by_harness`、`by_provider`、`tokens_by_harness`、`coverage`、`freshness`、`excluded_harnesses`
与 `last_observed_at`。金额不是脱离来源的 scalar；任何 UI 若只消费金额而丢弃这些
字段，视为契约违规。调用者不应知道数据来自 JSON、SQLite 或未来的离线分析索引，
但不得忽略这些业务语义字段。

**该 DTO 已于 Stage 0 冻结并在消费中（Tauri/CLI），Stage B 的 SQLite repository
必须产出同一形状。** R4 补充：权威计费归属在 `by_provider`（键 `"harness/provider"`，
条目级单币 currency——claude-code 执行环境内 anthropic(USD)+minimax(CNY) 同桶跨币
相加就是编造）；`by_harness` 保留币种分栏的旧口径（有测试钉着），新增消费方一律读
`by_provider`。

### 3.2 DSH 是参考实现，不是数据模型

DSH + dsh-client 是当前审计闭环最完整的执行环境集成：它已经验证了
原始会话事件 → 语义信号 → coverage → detector → finding → projection 这条链。
但 v0.9 不得把 DSH 的 JSONL 字段、四 token 桶、峰谷定价、compaction 事件或
session projection 协议提升为跨执行环境模型。

复用单位必须是能力与事实契约：

~~~
DSH / Claude Code / Codex 原始 wire
  → 各自 harness adapter
  → CanonicalSession + UsageObservation + SourceAttempt
  → shared identity / validation / reconciliation
  → UsageFact + coverage + projection
~~~

- DSH 的 zstd、header、cwd/profile、approval、sandbox、hook、峰谷定价仍是 DSH adapter 的责任；
- Claude/Codex 的累计快照、rollout、cache 桶、逻辑 session identity 仍是各自 adapter 的责任；
- UsageFact 的 ID、schema、provenance、缺失语义、事实校验和写入协议必须只有一份；
- 行为检测器以 Signal / capability 为输入。执行环境未提供足够信号时，必须得到
  unavailable / partial，不能把 DSH 规则硬跑后输出 measured zero；
- dsh-client 的 WASM 复用证明同一规则可跨 CLI、harness、browser 运行，但它不是
  其他执行环境必须实现的 UI 插件接口。

### 3.3 最小执行环境接入契约

一个执行环境要进入 v0.9 的可信数据面，必须分别声明下列能力；不能以已扫到文件替代。

| 交付物 | Harness adapter 责任 | Runtime 责任 |
|---|---|---|
| Source descriptor | roots、文件类型、读取错误与 source revision | 调度、checkpoint、source status |
| CanonicalSession | 原始 session → 可重放最小会话输入 | 持久化、保留、重放 |
| UsageObservation | 原始用量载体 → token/金额/时间/身份输入 | schema 校验、reconciliation、emit |
| UsageFact | 提供 build_usage_fact 所需字段和原始证据 | 去重、append、lease、transaction |
| HarnessBillRecord | 提供执行环境账单金额、周期、原始账单证据与不可归因字段 | 独立持久化、不可与 token 估算混淆 |
| Coverage | 可观察/不可观察字段与分母 | 跨执行环境汇总、投影和 UI 降级 |
| Capability | 支持的 trace、cost、session、MCP 等面 | 命令/UI 是否启用及 unavailable 解释 |

UsageObservation 是内部规范化输入，不是第二份账本，也不是公开 API。它允许不同执行环境
保留精确 token、amount、provider、模型、时间和 identity 语义；Runtime 只消费已经
完成执行环境解释的观察值，绝不从通用 writer 反向猜 wire 字段。

### 3.4 事实与索引

| 层 | 权威性 | 用途 |
|---|---|---|
| 原始执行环境日志 | 执行环境拥有 | 不复制、不作为本项目写入目标 |
| `UsageFact` JSONL | 审计事实 | 追加、去重、账目对账、导出 |
| `HarnessBillRecord` JSONL | 执行环境账单事实 | 不可验证 token 时的可信费用、周期与来源 |
| CanonicalSession snapshot | 可重放输入 | session 级解释、重建与审计 |
| SQLite | 可重建投影 | 筛选、排序、分页、跨页面查询 |
| Tauri cache | 临时 | 加速显示，不能成为账目权威 |

SQLite 损坏或删除后，必须从 JSONL + canonical snapshot 重建；SQLite 主键、数组序号、导入顺序均不能充当 `fact_id` 或 `source_event_id`。

### 3.5 写入协议

```text
lease acquired → intent durable → facts/canonical durable
→ projection durable → manifest commit → checkpoint advance
```

重启恢复必须识别每个中断点；双进程竞争不得双计、漏计或留下不可恢复半提交。禁止用简单的“ledger-first”顺序替代该协议。

## 4. Billing 与成本口径

> R4 注：本节的 Basis 分离表已在 2026-09-05 落地为
> `data_contract.rs::BillingBasis`（五档枚举 + `summable_into_total`）。
> 口径的完整词表、实测锚点与诚实性边界以
> `ATTRIBUTABLE_WASTE.md` §6/§6.7 为权威，此处只写 R4 新增的结构性决定。

`BillingContext` / `UserProfile` 允许用户声明固定订阅套餐、按量账户、预算、模型价格来源和可计量范围。所有投影必须保留以下分离：

| 值 | 含义 | 能否冒充真实账单 |
|---|---|---|
| fixed subscription | 用户声明的固定订阅费用 | 否，只能按周期单列 |
| metered actual | 可观测到的按量实际费用 | 可以按口径汇总 |
| metered estimate | 依据价格表的估算 | 不可以 |
| harness-billed | 执行环境提供的账单/credits 消耗，但无逐请求 token 归因 | 可以按执行环境账单口径汇总，不能重标为模型 API 成本 |
| API equivalent | 套餐消耗的等价 API 标价 | 不可以，只作诊断 |
| unresolved | 模型或价格不可确认 | 不得归零 |

### 4.1 计费模式声明层（已落地，Stage A）

`pricing.json::catalog_2026_09.billing_modes` 是「这个模型的钱付给谁、按什么方式付」
的单一判定点（`domain::cost::billing_route_of`）：与价卡**相互独立**（无价卡模型
glm-* 也能归属——`resolve_card_catalog` 靠价卡反查是已知缺陷面，不得新增依赖它的
归属逻辑）；声明序即优先级（先专后泛：shengsuanyun 的 0813 专属行必须排在
deepseek-official 的 `deepseek-v4` 泛行前）；`unknown` 是合法判定结果，不得默认。
金额在 `subscriptions` 节（`subscription_fee_of`/`declared_subscriptions`），金额
未声明 → `None`，不得拿挂牌价猜。Stage E 方向：实现 §4.1 计费判定四步链
（oauthAccount.billingType → 路由层 → quotaLimits 拒绝史 → 才问用户），把 basis
从 user-declared 升级为 evidence-derived——词表已预留，接入不需改 DTO。

### 4.2 名义成本（收编自 ATTRIBUTABLE_WASTE §6.7，2026-09-05）

`nominal_cost` = 各桶 token × 官方市场标价，不扣套餐/中转折扣/促销——"名义 GDP"式
跨供应商可比基准，与 6.1 套餐摊销、6.2 按量成本并列感知层第三栏。实测：缓存两桶
占名义成本 92.8%（命中率 99.18%），`cache_write` 档位假设（1hr vs 5min）差 5.2%，
展示必须标注。**词表让位**：`nominal_vs_actual_cost` 已改名
`cache_counterfactual_cost`（"无缓存反事实"，与市场标价实测差 8~10 倍），
`nominal` 一词专指本节口径，不得回用。派生护栏：订阅利用率倍数 >50× 不得显示
「值 N 倍」，必须告警「归属待核」——anthropic 380× 实测即声明错误的自检信号。

### 4.3 权威归属与实际支出（已落地，Stage B/C）

权威计费归属 = `by_provider`（每 billing_source 一条、条目级单币）；实际支出 =
按量实付 + 订阅月费（`total_actual_spend`，分币分栏，跨币不相加——**名义可换算
（显式声明汇率）、实际是账不可换算**，两者性质不同不冲突 §6.4）。订阅月费摊入
三条纪律：零用量月份照摊（不付用量也在付）；账期过滤（`billing_period_start`，
缺省 `reported_at`）；只进月不进日（月费不是日发生额）。

### 4.4 数据缺口（等用户输入）

中转商对 claude-sonnet-5 的 `cache_read` 单价（一个数决定 claude-* 实际支出
78.9%——三种借卡选法实测差 46 倍，禁止硬凑）；GLM 官方按量价卡；ChatGPT Plus
月费金额；名义成本统一展示汇率。补齐前相应数字诚实报 unpriced / 「单价未知」
/ 分币并列。

## 5. 数据访问接口与 Runtime 编排

```text
agent-vitals-data/
├── evidence/             append / replay / reconciliation
├── store/                SQLite schema / migration / transaction
├── repository/           typed query and mutation boundary
├── billing/              BillingContext / cost basis
├── coverage/             source and denominator coverage
└── projection/           versioned summary DTO builders

agent-vitals-runtime/
├── ingest_service.rs     harnesses → data batch orchestration
├── sync_service.rs       scheduling / checkpoint trigger / recovery entry
└── projection_events.rs  cache invalidation / UI refresh event only
```

建议命令：

```text
agent-vitals data coverage [--json]
agent-vitals data rebuild-index
agent-vitals data replay [--harness <harness>]
agent-vitals billing show
agent-vitals billing validate
```

旧命令兼容一个版本周期，但内部统一调用 Runtime → Data；不得保留第二条 JSON 直读路径。

**month.json / today.json 的退休路径（2026-09-06 拍板，不做立即一刀切）**：
它们不是 SQL 索引的重复——是 DSH oneline fold 的**状态链**（8 桶含 peak
峰谷拆分、by_source、预算/告警的 rotate/snooze 语义），这些维度 facts/
索引当前都没有；而索引按 §3.4 是可删除投影，把状态语义搬进去就变成第二
权威。退休按四步走：① ✅ sync_service（2026-09-06 落地 `runtime::sync_service` +
`sync-facts` CLI，托盘 tick 已接线——facts 平面常态化）；② ✅ facts
schema v2 补 peak 标志 + source 维度（同日，纯索引侧派生零 emitter 改动）；
③ ✅ 预算的索引数据面（2026-09-06：`store::dsh_days_map` 投影 +
`budget::compute_month_from_index`，喂同一个 `domain::cost::month_cost`——
零新计价数学；**双轨对账** `data budget-reconcile` 真机逐厘相等
¥1752.4498154 ≡ ¥1752.4498154（2026-08，含 peak 拆分），零月/覆盖缺口的
两态语义有 note 规则；对账面在开发期当场抓到两个投影 bug：peak 行只写
子桶（base ⊆ 语义反了）与漏 by_model 分组（pro 专属卡落 fallback flash
价，钱差 2.9×））；④ state JSON 退役（未动——前置「双轨连续为真」成立
后开，兼容读留一个版本周期）。在那之前 JSON 状态链与
facts 链是**并行的两条写路径**（fold 写状态、--write 写事实），不是多头
维护同一份数据。

### 5.1 SQLite、`rusqlite` 与 ORM 决策

v0.9 的权威事实仍是 JSONL；SQLite 只承担可删除、可重建的本地查询索引。选择 SQLite
是因为产品是单用户、离线优先、嵌入式桌面/CLI 运行：无需 App Server，事务、迁移、索引
和时间范围查询均已足够。

- 使用 `rusqlite` 作为 Rust 的 SQLite driver；它已经在 WorkBuddy 只读 source adapter
  中使用，v0.9 将把**共享数据写入**依赖放进 `agent-vitals-data`，不得泄漏到 Domain；
- 不引入 Diesel、SeaORM、SQLx 等完整 ORM/异步数据栈。它们不能定义成本口径或覆盖率，
  反而会扩大依赖、编译和模型迁移成本；
- repository 的 typed query 是唯一取数接口，手写、参数化 SQL 可审计且适合有限 schema；
- DuckDB 仍只可作为显式离线分析/导出 adapter，不可成为实时状态库或第二权威源；
- 将来若需要云同步，再在 Data 之上增加 sync adapter；不得改变 Harness/Runtime/UI 的查询契约。

### 5.2a 统一查询源的差距（2026-09-06 外部审计 P1 确认，v0.10 主线）

**现状**：`JsonSummaryRepository` 仍直读 month.json / claude ledger / codex
fold——facts 索引只在 DSH 预算对账（`data budget-reconcile`）与小时分布
面板被消费，不驱动 CLI/Tauri/HTML 的日/月汇总。Stage B「替换 Stage 0
JSON read adapter」目标**未达成**，v0.9 数据访问维度保持未完成。

**三执行环境的索引覆盖实测（2026-09-06 真机）**：
- **DSH**：双轨逐厘相等（¥1752.45，`data budget-reconcile`）——索引可全权
  接管 ✅；
- **Codex**：差 0.25%（fold 的 untimed 残差样本不产 fact）——小且方向
  保守，索引接管需在投影里如实标注残差缺口；
- **Claude**：差 48%（索引 3.02B vs ledger 6.3B）。**根因不是 cost-state
  基线**（真机现存会话文件里没有 cost-state 行——该假设已被实测推翻），
  而是**文件轮转不对称**：ledger 跨时间累积（checkpoint + 逐日），claude
  客户端会压缩/轮转会话文件，历史行物理消失后 ledger 里仍有账，facts
  重放只见现存文件。**结论：claude 的深历史不可从现文件重建，ledger 是
  这部分账的 store of record。**

**分阶段补全计划（轴分离设计，2026-09-06 定稿）**：

核心模式：**fold 的日投影作为「日轴事实」进索引（observation_kind=
`day-summary`，event_ts_utc = 北京日 12:00Z 代表点），行级/槽级 facts
保持「会话轴」证据**。两轴用途分离，日/月汇总只读日轴事实——这绕开了
「行 facts 与 ledger-day 同账双计」的死结（ledger 的历史日在轮转后不存在
行级对应物，任何 (day, model) 去重规则都救不了缺口的行）。查询面按
observation_kind 显式分轴：小时分布只读行/槽 facts（day-summary 的代表
点不污染小时桶），日/月汇总只读 day-summary。

1. **day-summary ingest**：claude ledger 逐日 by_model、codex fold
   by_model-per-day（覆盖 untimed 残差）、DSH 沿用月账已证明等值的
   slot facts（`data budget-reconcile` 已钉）；
2. **SummaryRepository 索引实现**：日/月汇总读 day-summary 事实，DTO
   逐字段与现实现对账（复用 budget-reconcile 的双轨 harness 模式）；
3. **切换**：双轨连续为真后，JsonSummaryRepository 退役（兼容读留一个
   版本周期）。

### 5.2 CLI application-layer extraction

v0.9 开工前必须完成 v0.8 E7 的所有权收口。当前 apps/cli/src/agent/ 仍混有三类职责：
执行环境 UsageFact emitter、跨执行环境 SessionStore/缓存/分页，以及命令输出。该目录不能继续
成为新的数据面 owner。

| 当前类别 | 目标位置 | 迁移原则 |
|---|---|---|
| Claude/Codex/DSH 的 wire → UsageFact emitter | harnesses/<harness>/sessions/ | 每执行环境一份 adapter；不在 CLI 重抄 wire |
| roots、解码、数据库/文件读取 | harnesses/<harness>/sources/ | 受 sources feature 门控 |
| SessionStore、跨执行环境分页、cache、checkpoint、writer | agent-vitals-runtime/ | 一套服务，不按 harness 复制 |
| 成本、ID、coverage、事实校验、纯指标 | Domain / Vitals Core | 无 I/O、无 UI、无执行环境文件路径 |
| 参数解析、human/JSON 终端渲染 | apps/cli/ | 只能调用 Runtime projection |

迁移不是机械移动文件：例如 Codex 单会话审计的成本/证据组合是 Runtime projection，
不应塞回 harnesses/codex；反之 Claude/Codex/DSH 的原始 usage 解释不能继续留在 CLI。

## 6. 存储、隐私与导出

- JSONL 适合审计、append、跨语言 parity 和脱敏导出；
- SQLite 只承担交互查询，不承担第二份权威事实；
- DuckDB 只作为显式启用的离线分析/benchmark/export adapter，读取同一份脱敏输入；
- 原始执行环境日志不复制；CanonicalSession 默认 90 天、UsageFact 保留**最近 13 个自然月**（含当月；fencepost 钉死——cutoff = current − 12，两端含）、可重建 cache 30 天；
- 私有 trace 与脱敏 export 必须是不同写路径，不能由一个 `redacted: bool` 决定；
- 用户配置与可重建 state/cache 分目录，配置与导出均不得保存凭据。

## 7. 实施阶段

### v0.9.0 Stage 0：Data Access Foundation

- 创建 `agent-vitals-data` crate，冻结 versioned Data Query API 与 Summary/coverage/freshness DTO；
- 用现有 DSH `today/month`、Claude ledger 与 WorkBuddy source 实现只读 source adapters；
  Stage 0 可继续读取 JSON，不要求先迁移历史账本；
- Tauri、CLI、HTML 改为只调用 `daily_summary`、`monthly_summary`、`coverage_status` 等 API，
  禁止再直读 state JSON 或执行环境账本；
- 控制台日/月/预算展示 freshness、coverage、harness scope 和 excluded harnesses；stale / partial /
  excluded 不得降级成零或“正常”；
- 完成 v0.8 E7：Skill Surface ownership migration 与 CLI application-layer extraction；
- 将三执行环境 UsageFact emitter 的 wire 解释迁到 harnesses/<harness>/sessions/，将 SessionStore 的
  cache/checkpoint 所有权迁到 Runtime；
- 为 DSH、Claude Code、Codex 和 WorkBuddy 建立 v0.9 最小执行环境接入契约 fixture；
- 保持现有 CLI/Python/WASM 输出零漂移，除新增的 freshness/coverage 契约字段外不重写既有数值。

**门槛：**上层仅依赖 Data Query API，且接口实现可以在不改 UI/CLI 的情况下由 JSON
切换至 SQLite；控制台不会把 stale / partial / excluded 当作零或正常；CLI 不再拥有执行环境
wire 解释或事实写入；各执行环境的 capability/coverage 与实际注册实现双向对账。

### ✅ v0.9.0 Stage 0：Data Access Foundation（2026-09-05 完成）

七步全部落地并合入 main（`1596836`），门槛逐条达成：上层只依赖 Data Query API；
stale/partial/excluded 不降级为零或正常（含 DSH 0-token 月回归 `9ccc488`）；
CLI 执行环境 wire 解释收口至 runtime（Stage 0.3 六文件搬迁）；四执行环境 capability/
coverage 双向对账 fixture。执行记录：`AGENT_VITALS_V0_9_STAGE0_RESEARCH.md`。

### ✅ 计划外插入（2026-09-05，同日）：KPI/计费归属与总览感知层

用户指出总览 KPI 只反映 DSH 一家后展开，最终演化为计费归属重构：计费模式
声明层（Stage A `c7d0e06`）、by_provider 权威归属（Stage B `f004756`）、
FixedSubscription 写入方与 total_actual_spend（Stage C `68ca4eb`）、总览
KPI 行/双轨账/决策卡与跨执行环境 Token 日历（Stage D `6586112`/`f110066`）、
两轮审查修复（`29c0717`/`0096607`/`01f0d9a`）、tab 卡顿性能回归修复
（`d8c6c83`/`4ed99e7`）。全部在冻结 DTO 上 additive 演进，未破 Stage 0 契约。
教训沉淀：`CLAUDE.md`「v0.9 成本词表与计费归属」节。

### v0.9.0 Stage A（P0）：事实写入与恢复 —— ✅ 本体完成

UsageFact writer（`agent-vitals-data::evidence`：fact_id exactly-once、
崩溃尾面**修复**——半行截断/缺封口补换行，open 落实而非只容忍）、稳定
identity（v0.7 契约层）、去重与 reconciliation（`reconcile_tokens` 报告式）、
Runtime 共享 ingest service（`agent-vitals-runtime::ingest_service`：执行环境
封闭词表、按事实自身 harness 分组成 `<data_home>/facts/<harness>.jsonl`、写后
重放自检）。CLI 端到端：`{claude,codex,dsh}-usage-facts --write`（Rust-only
——Python 不长 writer，spec DoD #7；flag 关闭时输出与 Python 字节相等）。
**剩余**：CanonicalSession snapshot writer、facts vs 投影 DTO 的全量
reconcile（投影在 Stage B 落地后接）。

§5.2 遗留的 `{claude,codex,dsh}_usage_fact.rs` 执行环境归位（Stage 0.3 曾记录的
scope gap）已完成：emitter 落 `agent-vitals-harnesses/harnesses/<h>/sources/usage_fact.rs`
（读文件 → sources 层；行级原语下沉 `claude_code/sessions/usage.rs`、
`dsh_header`/`dsh_source_profile` 下沉 `dsh/sessions/header.rs`——runtime 对
执行环境词表的所有权就此清零），CLI 经 flat alias re-export，212 项差分 +
golden 15/15 钉住字节零漂移。

### v0.9.0 Stage B（P1→P2）：索引、计费和覆盖

SQLite schema/migration/rebuild（P1，与 writer lease、checkpoint、增量失效
同批——托盘 tick 与 CLI 并写 month.json 的冲突面由 lease 收口），替换 Stage 0
JSON read adapter；BillingContext/UserProfile 吸收 4.1 声明层（P2）；
HarnessBillRecord 落地（WorkBuddy credit_json 首个生产写入方）；coverage
projection 完整化。Data Query API 与上层 DTO 不变。

### ✅ v0.9.0 Stage C（P2）：发布收口（2026-09-06 完成）

保留滚动（UsageFact 最近 13 个自然月，fencepost 钉死；无日期行保留；幂等）、
故障注入与 replay 测试（rebuild 事务回滚 + 损坏自愈 + facts 尾面修复 +
lease 原子 rename——DoD #2 三点有测试，intent/manifest 未实现如实标注）、
脱敏导出**双写路径**（`data-export-private` / `data-export-redacted`，
四个身份字段伪名化 + fact_id 契约层重 stamp，§6 的「不能由一个 bool 决定」
落地）、数据面维护文档（CLAUDE.md「v0.9 数据面维护」节）。跨实现 parity
（golden 15/15 + Python 1164）与 DTO 对账（DoD #6）由既有差分 gate 持续
看守。审查（P1 脱敏泄漏 + P2×5）已全部修复（`c5841f4`）。

### 7.1 Watcher 的进入门槛

文件 watcher、DSH live subscription 和任何文件一变立即更新的机制均不属于
v0.9.0 发布条件。当前 Tauri 的五分钟 tick 与手动同步是允许的保守实现。

只有下列条件全部满足后，才可以另开后续 feature 实现 watcher：

1. fold_resume(checkpoint, appended) == fold(all) 有 fixture 证明；
2. source revision、稳定 identity 与 exactly-once writer 已在三执行环境跑通；
3. append 中、半写入、rename、zstd 更新、重复事件和 watcher 重启均有恢复测试；
4. watcher 只触发 Runtime ingest，不直接让 Tauri、CLI 或 harness adapter 写权威 state；
5. UI 只接收 versioned projection 更新事件，而不以文件事件本身作为账已结清的证明。

## 8. Definition of Done

v0.9 可发布，当且仅当（R4 标注当前达成状态）：

1. 删除 SQLite 后可由事实文件重建等价 projection；—— ✅ Stage B `2d32ed0`：`data::store::FactsIndex`（fact_id 主键 + raw 全文列），open_or_rebuild 对删库/损坏/旧版本自动从 JSONL 重建（真机验证删库 → `data-rebuild-index` 等价投影）
2. 在 lease、intent、facts、projection、manifest 各提交点注入崩溃，均不双计、不漏计、可恢复；—— 🔶 Stage C：facts（尾面修复 + exactly-once 重跑）、projection（rebuild 事务回滚 + 损坏自愈）、lease（TTL 偷取 + 原子 rename）三点有注入测试钉住；**intent/manifest 两点未实现**（P0/P1 写协议未含，如实不声称达成）
3. 双进程竞争遵守同一 writer lease；—— ✅ Stage B `6b3aadd`：`runtime::lease`（O_EXCL + 原子 rename 陈旧偷取），接线 merge_today/merge_month（托盘 vs CLI 的读改写序列）与 facts ingest/reconcile/rebuild 临界区；Python 写入方按 §7.1 退役路线不纳入
4. 每月成本按 fixed / actual / estimate / equivalent / unresolved 分开，且可下钻来源；—— ✅ Stage B `9fbf920`：`data-unresolved` 逐模型下钻（billing-route-unknown / billing-mode-unknown / no-price-card / partial-price-basis 四类原因，键与 by_provider 同词表）；五档分离为 Stage B/C `f004756`/`68ca4eb` 落地
5. coverage 不把未知伪装成零，所有分母有版本化定义；—— 🔶 字段级已钉（contract_violations + denominator_version），投影层待完整化
6. CLI、Tauri、HTML 均通过同一 Data query DTO 取数；关键账目、执行环境范围、新鲜度与覆盖率一致；—— ✅ Stage 0 达成并保持
7. Python/Rust 的公开 JSON 保持必要的 byte-parity，Python 没有新增 writer、ORM 或网络持久化旁路；—— ✅ 持续保持（golden 15/15 + 锁步测试）
8. v0.10 所需的 Trace/Issue/Action 数据可以只依赖本版事实与 projection，而无需回读 UI 文件。—— ❌ 依赖 Stage A/B

## 9. 与 v0.10 的交接

v0.9 产出稳定的事实、canonical 输入、成本口径、coverage 与查询接口；v0.10 在此基础上建立任务轨迹、诊断、方案、行动和收益验证。没有 v0.9 的 data readiness，不得在 v0.10 将趋势、节省或自动建议表述为可信结论。

## 附录 A：SQLite 索引 Schema（v2，2026-09-06 定稿）

> 唯一 DDL 源 = `crates/agent-vitals-data/src/store.rs::ensure_schema`（本文档
> 是它的镜像，改动必须两处同步 + `INDEX_SCHEMA_VERSION` 递增）。SQLite 是
> §3.4 的「可重建投影」：整库可删、从 JSONL 重放重建（§8 DoD #1），因此
> **这里没有任何权威语义**——身份在契约层、口径在 domain、钱在读取时算。

### A.1 v1 DDL

```sql
CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- schema_version = '2'

CREATE TABLE facts(
    fact_id            TEXT PRIMARY KEY,   -- 契约层 6 元组 fnv1a64（uf1-…）；去重容器，不产生身份
    harness               TEXT NOT NULL,      -- 封闭词表：claude-code / codex / dsh
    machine_namespace  TEXT NOT NULL,
    native_session_id  TEXT NOT NULL,
    source_event_id    TEXT NOT NULL,
    observation_kind   TEXT NOT NULL,
    event_ts_utc       TEXT,               -- 执行环境事件时间（UTC ISO）；月/小时窗都在读取时按它切
    model_id           TEXT,               -- model_id ?? model_raw
    provider_id        TEXT,               -- provider_id ?? billing_source
    source_profile     TEXT,               -- fact 自带 source_profile（DSH by_source 视角的索引落位）
    event_peak         INTEGER NOT NULL DEFAULT 0,  -- 插入时 is_peak_slot(event_ts_utc) 派生；坏 ts → 0
    t_uncached_input   INTEGER NOT NULL DEFAULT 0,
    t_cache_read       INTEGER NOT NULL DEFAULT 0,
    t_cache_write      INTEGER NOT NULL DEFAULT 0,
    t_output           INTEGER NOT NULL DEFAULT 0,
    raw                TEXT NOT NULL       -- 事实全文 JSON（列不够用时从自己身上读回）
);
CREATE INDEX facts_harness_ts  ON facts(harness, event_ts_utc);      -- 月/小时窗扫描
CREATE INDEX facts_session  ON facts(harness, native_session_id); -- 会话下钻
```

### A.2 设计规则（每条都有测试或守卫钉着）

1. **不派生 day 列**：北京日归属是执行环境逻辑（claude UTC+8 日线 / codex
   `codex_hour_of` / DSH 各自），索引层复制任何一份都违反「单一 wire 解释」
   ——月/小时窗都在**读取时**按 `event_ts_utc` 现算（`hours_by_harness`）。
2. **迁移 = 整库重建**：schema_version 不匹配 / 库损坏（SQLITE_CORRUPT/
   NOTADB）/ 删除 → open 时从 JSONL 全量重放；比本二进制新的 schema 报错
   不重建（重建丢新语义）。
3. **rebuild 事务化**：DELETE+插入同事务（IMMEDIATE），中途失败回滚旧索引
   ——绝不留「空索引装健康」的假零态。
4. **无 ORM**：手写参数化 SQL（spec §5.1），dependency_budget 测试钉死
   Diesel/SeaORM/SQLx 禁入。
5. **去重双层同键**：writer 层（JSONL fact_id 集合）与索引层（PRIMARY KEY
   + INSERT OR IGNORE）同源同键，两层不会各说各话。

### A.3 v2 候选（未设计，需求触发才动）

| 维度 | 触发条件 | 形状 |
|---|---|---|
| ~~peak 峰谷标志~~ | ✅ v2 已落地（插入时派生，零 emitter 改动） | `event_peak` 列 |
| ~~by_source~~ | ✅ v2 已落地 | `source_profile` 列 |
| HarnessBillRecord | WorkBuddy credit_json 写入方落地 | 独立 `harness_bills` 表（执行环境账单口径，不冒充 API 成本） |
| canonical snapshot | §3.4 第三层落地 | 独立 `sessions` 表 + 90 天保留 |
| checkpoint/lease 表 | 多进程 ingest 常态化 | 独立表或继续文件锁（P0 文件锁够用） |

**evolution 纪律**：加列必须「不破坏 JSONL 重建等价性」（新列可从 raw 列或
重放重算 → 重建后等价），否则该维度属于权威层，放 facts 契约而不是索引。
