# 月度成本感知与可归因浪费定义(指标体系真相源)

> 状态:**修订稿 v3**(2026-09-02)。v1 被评审推翻三处 P0,v2 修正归因框架,
> v3 增加「感知—诊断—归因」三层产品指标与套餐/按量双口径:
> ①「98.7%→1.3%」不是浪费率;②四类归因粒度不同,不能相加;③「必须 measured」
> 与各定义实际证据属性冲突,需 basis 分离 + 覆盖率护栏。**评审原文即本文件的
> 「defect 记录」**——v1 的每个错误都在这版有对应的修复说明。
>
> 关联:[COST_BASELINE.md](./COST_BASELINE.md)(实测快照,含语料期纪律)·
> [CLAUDE_CODE_CORPUS.md](./CLAUDE_CODE_CORPUS.md)(Claude Code 快照,四模型族分栏)·
> [WINGLET_CAVEMAN_BENCHMARK.md](./WINGLET_CAVEMAN_BENCHMARK.md)(单边收据论证)·
> [PRODUCT.md](./PRODUCT.md) · [plan.rs](../crates/agent-vitals-core/src/domain/plan.rs)(诚实性规则先行者)·
> [waste.rs](../crates/agent-vitals-core/src/domain/waste.rs)(SV-COST-01/02 已落地)。
>
> **一句话**:产品第一感知 = **本月总成本 + 每百万处理 token 成本**;先按
> **套餐摊销 / 按量成本**拆开,满足同币种、同周期、无重叠等条件时再给综合值。
> 缓存率、模型结构、高峰占比等只负责解释「为什么」;确认浪费、估算机会、待复核
> 异常负责回答「哪里可以改」。本文钉死三层指标的边界,以及哪些数字**不许**互相冒充。

---

## 1. 三层指标体系:先让用户有感知,再做诊断归因

完整论证见 `WINGLET_CAVEMAN_BENCHMARK.md` 与 `COST_BASELINE.md`。决定本定义的三条硬约束不变:

1. **不是「省了多少钱」**——省多少要么反事实、要么基准差,都不可复核;且 Codex 订阅制、DSH 按量,绝对钱数不可统一。
2. **必须是 measured 的**——每一笔浪费点名、带证据,不许估算冒充测量。
3. **统一结构,不伪造可比性**——执行环境可以共用同一套卡片和归因分类;不同币种、
   不同 billing mode、不同证据覆盖下的绝对数值不强行横比。

产品指标分三层,各自回答一个问题:

| 层 | 用户问题 | 主指标 | 不负责什么 |
|---|---|---|---|
| **感知层** | 本月花了多少、这份钱换来多少模型处理量? | 本月感知成本、cost/M processed tokens、套餐/按量拆分 | 不证明某笔钱浪费 |
| **诊断层** | 为什么单位成本变高/变低? | 缓存率、模型/provider 结构、高峰占比、fresh/output 比等 | 不直接进入浪费分子 |
| **归因层** | 哪些具体请求、会话或常驻资源值得优化? | 确认浪费、估算机会、待复核异常、SV 证据 | 不冒充账单或反事实节省 |

归因层仍保留「一主一护栏」,但 billing mode 决定单位:

```text
按量: confirmed waste spend / eligible audited spend
订阅: confirmed avoidable usage / eligible audited usage
护栏: eligible audited population / observed population
```

UI 可以统一叫「确认浪费率」,但必须同时标 `basis=spend|usage`。固定套餐没有边际
token 账单,不得先把套餐费摊成伪单价再冒充 confirmed waste spend。用总成本/总用量
直接作分母,一个什么都测不到的执行环境会得到漂亮的 0%,所以审计覆盖率必须同屏。
`eligible` 不是固定要求四桶全有,而是满足**该规则 + 该 provider/billing mode**所需
字段、且事件能归因到请求;provider 不适用的桶不因缺场被误判为不合格。

产品层三栏呈现:

```
本月感知成本     ¥623.07
单位处理成本     ¥117.6 / M tokens
  套餐摊销       ¥600.00 · ¥142.9/M
  按量成本        ¥23.07 ·  ¥21.0/M
数据覆盖率        92%       ← 感知层护栏

确认浪费率       2.8%       ← 仅 measured attribution / 稳定 human-confirmed
审计覆盖率      71.4%       ← 归因层护栏
估算优化机会    184K tokens ← 不进确认分子
待复核异常       3 sessions ← 只展示会话与证据
```

> 上表为 UI 示意。**真实 感知层 实测样例**见 `CLAUDE_CODE_CORPUS.md` §6:USD 块
> $0.458/M processed、CNY 块 ¥0.246/M processed(catalog-provider 估算,两档口径)。

---

## 2. 为什么四类不能相加(v1 最核心的修订)

v1 的 `W1+W2+W3+W4` 可加总假设**不成立**,因为归因粒度不同:

| 类别 | 归因粒度 |
|---|---|
| W1 缓存 | 请求级输入 token |
| W2 重复调用 | 工具执行 / 工具结果 |
| W3 长尾 | 整个 session |
| W4 常驻僵尸 | 跨 session 的常驻上下文 |

重复工具结果会进入后续输入(同时落入 W1);skill 描述也可能属于 cached/uncached 输入。**当前日志没有 token-span 级血缘**,无法知道某一段输入成本究竟属于哪一类,因此 `W1→W2→W3→W4` 优先扣减顺序无法实现。

所以:**四类并列诊断,不相加**。可加总需要统一声明,并证明多个 claim 不占用同一笔 request/token amount(互斥证明):

```rust
WasteClaim {
    claim_id,
    session_key,
    session_revision,
    request_id,         // 命中的请求 / usage 证据
    category,           // 类别
    token_bucket,       // input / cache_read / output / …
    amount,
    currency,
    harness_id,            // 执行执行环境,不等于收费方
    billing_source,     // 套餐/API/credits 的实际归属
    billing_mode,       // subscription / metered / credits / unknown
    pricing_basis,
    measurement_basis,  // 数量怎么测的(§3)
    attribution_basis,  // 归因是否被证明(§3)
    source_refs,        // SV 码 / 事件流引用
}
```

---

## 3. Basis 体系:「必须 measured」与具体定义的和解

v1 声称「必须 measured」,但四类里严格 measured 的部分很少。**单个 basis 字段不够**,分离成三个维度:

```text
measurement_basis: measured | derived | estimated | unavailable
attribution_basis: evidence-confirmed | inferred | benchmark-counterfactual
                 | human-confirmed | none
pricing_basis: provider-reported | catalog-provider | catalog-fallback
             | user-reported-invoice | subscription-allocated | unpriced
classification: confirmed | opportunity | suspected | review
```

basis 取值表(当前证据属性,诚实标出):

| 类别 | measurement | attribution | 能否进确认分子 |
|---|---|---|---|
| W1 缓存低命中 | measured(命中率本身) | inferred(「本可命中」) | 否,默认 suspected 告警 |
| SV-COST-01 重复相同结果 | **estimated**(`est_tokens × (n−1)`——est_tokens 是估算器,量出的不是实付 token) | inferred(「第一次是必要」是假设) | 否,估算机会 |
| SV-COST-02 失败重试上下文增长 | **measured**(request_metrics 前后差值) | **inferred**(期间还含 assistant 输出等,不能证明全部由失败造成) | 否,估算机会 |
| W3 长尾 session | derived(usage×pricing 的成本分布) | **human-confirmed**(复核后) | 复核确认的具体请求/金额才进 |
| W4 常驻上下文 | estimated | none | 否,估算机会 |
| 真实重复计费请求(独立 provider billing 证据) | measured | evidence-confirmed | **是** |

只有 `measured`(且 attribution 可证明)或带稳定复核记录的 `human-confirmed` 才能进入「确认浪费」分子。

---

## 4. 分类定义(并列诊断 + 会计排除)

### W1 Cache Inefficiency Suspect(原名「缓存未命中」,降级为嫌疑)

| 项 | 定义 |
|---|---|
| **是什么** | 命中率低于阈值**只产生告警**,不直接归因。改名为嫌疑——「本可命中」是推测,不是测量 |
| **eligibility(全部满足才可评估)** | provider 缓存语义已知;排除首次请求;按模型族分别计算;排除模型切换边界;最小请求数;W1 所需的 uncached/cache_read 字段完整;会话路径已线性化 |
| **阈值** | 90% 是**默认告警阈值**,不是归因阈值——DSH 93% / Codex 95.7% 两个总体值推不出所有模型/任务/执行环境共用 90%;按执行环境+模型族校准 |
| **升级路径** | 已知生产缓存事故 + 请求级因果证据可进入 human/evidence-confirmed;稳定前缀只到 inferred;受控前后实验只到 benchmark-counterfactual,不冒充生产实付浪费 |
| **金额公式(即使估算,也是增量价差,不是全部未缓存费用)** | `excess_miss = max(0, uncached − (1−target_hit_rate) × eligible_input)`;金额交给 provider-specific pricing 函数(需考虑 cache creation/write 语义),结果标 `estimated` |
| **诚实性边界** | 首次请求、模型切换、provider 差异、分支/恢复、compaction、TTL、system prompt/工具列表变化、正常新增上下文——全部**不是**浪费,是数据属性 |

### W2 拆四(不再是一个可相加类别)

v1 把三个不同概念混在一个 W2 里,拆开:

| 概念 | 语义 | 进分子? |
|---|---|---|
| **AccountingShadow** | Codex `custom_tool_call{exec}` ↔ `CommandExecution` 是同一逻辑执行的两种日志表示,不是第二次计费。**ingestion 去重**,浪费成本为零 | 永远不算 |
| **RepeatedToolCall**(SV611) | 连续相同 `(name, args)` 签名 ≥3 次(代码现状,`trajectory.rs`)。行为告警:不证明调用无必要,**不计算费用** | 否 |
| **RepeatedIdenticalResult**(SV-COST-01) | 跨 turn 同名同参得到**完全相同结果**(`waste.rs` 已落地)。可能冗余的结构性机会:`waste_tokens = est_tokens(内容) × (次数−1)`;重复结果也可能是必要复核,所以 attribution 恒为 inferred | estimated,进估算机会 |
| **DuplicateProviderRequest** | 两个独立 provider request/billing id 及非累计 usage 证据指向同一逻辑计费(Codex shadow 之外的双份)。只有能排除累计快照/重复日志时才算 confirmed waste | 是(measured) |

工具调用本身通常不是 LLM 计费原子——**不能直接把「第二个 tool call」折算成模型成本**,必须关联到后续 request usage。

### W3 Review Queue(原名「长尾异常」,移出分子)

- 长尾 ≠ 浪费,复核前不计数——v1 已承认,本版**贯彻到底**:不存在 `W3_flag_cost`。
- `median × 10` 必须按执行环境、模型、时间段、请求数或任务规模**分组**,否则一个合法的大型 session 必然被标异常。
- 人工确认后记录的是**明确的浪费请求或金额**,不是「整个异常 session」:

```text
session_key | session_revision | confirmed_request_ids | confirmed_amount
| currency | pricing_basis | pricing_version | reviewer | reviewed_at | rationale
```

不带 revision 与 reviewer 的确认记录,在 session 更新、价格表更新或重复审核后无法复现。

### W4 Resident Opportunity(原名「常驻僵尸资源」,降级为估算机会)

| 项 | 定义 |
|---|---|
| **展示形式** | `estimated resident opportunity = estimated tier1 tokens × observed/declared exposure count`(启动次数取 plan.rs 的 `startup_rate`——只有用户显式提供,没有可靠月度数据就填 `unavailable`) |
| **为什么不进 measured** | `tier1_tokens` 是 tokenizer 估算;`loaded` 只证明 **catalog-visible**,不证明正文被读(`HARNESS_ADAPTER_CONTRACT.md` 的 `body_loaded_state: null` / `runtime_status: catalog-visible`);`skillUsage=0` 是终身零触发,不证明该 skill 没有发现/约束/安全价值 |
| **升级为 measured 的路径** | 请求头能明确测出该 skill 的实际常驻片段时才可能 |
| **诚实性边界** | 只算 `loaded` 的僵尸(`enabledPlugins` 判定);盘上未 loaded 副本不计 |

### SV-COST-02 失败重试上下文增长(补进四分类的缺口)

v1 四分类完全没提它,但代码已落地(`waste.rs`):连续 ≥3 次工具失败后,通过 `request_metrics` 前后两次请求的 `context_tokens` 差值衡量上下文实际增长。

- **amount = measured**(来自 provider usage 差值);**attribution = inferred**(增长期间还包含 assistant 输出、其他消息,不能证明全部由失败结果造成)——正是「单 basis 不够」的活例,必须拆 `measurement_basis` / `attribution_basis`。
- 与 `waste.rs` docstring 同源的分界:SV-COST-01/02 是**结构性浪费**(规则可直接判定、不需要历史基线);缓存命中率是**相对浪费**(需要基线才能判断)。混进来会破坏 FR-05「**无基线不告警**」——这也是 W1 只能告警、不能进分子的代码侧理由。

---

## 5. 实证修正(v1 的错误解释)

v1 原文:「可归因浪费从占成本的 98.7% 掉到 1.3%——一个修复把浪费率打下来」。

**这是错的。** `COST_BASELINE.md` §2 的 98.7% / 1.3% 是:

```text
bug 前时段成本 / 两个时段总成本
bug 后时段成本 / 两个时段总成本
```

是**时段成本占比**,不是各时段内部的浪费率;两个时段的请求量、任务量未控制一致。

可表述为:

> 缓存修复前时段贡献了全样本 98.7% 的成本,显示缓存异常与高成本高度相关。

**不可**表述为「浪费率从 98.7% 降到 1.3%」。

当前状态:两执行环境(Codex / DSH post-08-18)都**还没有可进分子的确认浪费数据**——北极星暂无实测值,这是诚实的现状;`COST_BASELINE.md` / `CLAUDE_CODE_CORPUS.md` 的快照数字全部是「估算机会/告警」级。

---

## 6. 月度感知成本与 cost/M processed tokens

这是用户认知门槛最低的总览数字,作用类似 DAU/MAU:快速回答「本月花了多少、这份钱
换来多少已观察模型处理量」,但不单独承担因果解释。统一分母叫
`processed_tokens`,不叫「完成的工作量」:

```text
processed_tokens = uncached_input + cache_read + cache_write + output
```

四桶必须是 adapter 归一后的互斥计量桶;若某 provider 的父/子字段有包含关系,先在
adapter 中去重,不得直接相加。`cost/M` 是**混合摊销指标**,不是 provider 公布单价,
也不等于生产力。

### 6.1 套餐摊销

```text
subscription_allocated_cost_per_mtok
  = allocated_plan_amount / observed_processed_tokens_in_scope × 1,000,000
```

- 套餐金额是 `user-reported-invoice`,不是运行时 measured;至少记录 `amount / currency /
  billing_period_start / billing_period_end / tax / credits / overage / product_scope /
  allocated_amount / confirmed_at`。
- ChatGPT/Claude 套餐可能还覆盖 Web、桌面等其它产品。默认可让用户选择「全额分摊」,
  但必须显示 `allocation_scope=full-plan`;更精确时由用户填 Agent 部分的 allocated amount。
- 套餐省 token 通常不减少当月固定账单;单位摊销下降表达的是同一套餐获得更多处理量,
  属于**使用效率/机会成本**,不是退款或边际节省。
- 如果日志只覆盖账期的一部分,`fee / observed_tokens` 是单位摊销的**上界**。展示
  `≤ ¥x/M · observed YYYY-MM-DD…YYYY-MM-DD`,不能冒充完整账期精确值。

### 6.2 按量成本

```text
metered_cost_per_mtok
  = priced_usage_cost / priced_processed_tokens × 1,000,000
```

- 分母只包含成功计价的 usage;未计价模型的 token 另报 `unpriced_tokens`,不得拿进分母
  压低单位成本。
- 导入 provider 账单时 `pricing_basis=provider-reported`;现有 `priced_day/month_cost`
  是 `measured tokens × catalog price`,因此是 `catalog-provider` 或
  `catalog-fallback`,不是 measured invoice。
- `pricing_basis=exact/partial` 目前只说明 `by_model` 覆盖是否完整,不说明报价等于实付。
  价格表必须带 `pricing_version / effective_at / priced_at`;否则更新价表会重写历史月份。

### 6.3 Harness 与 BillingSource 分离

Harness 是执行壳,不是收费方。Claude Code 可同时使用 Anthropic 套餐、Anthropic API、
DeepSeek、MiniMax、Kimi 等;同一会话甚至可以混用。每份 usage 应先归属:

```text
harness_id        = claude-code | codex | dsh | …
billing_source = plan/account/provider identity
billing_mode   = subscription | metered | credits | unknown
provider       = usage sample 的模型服务方
```

不能假定「Claude Code 四模型族天然由一份套餐覆盖」。无法确定收费归属的 usage 进入
`unknown`,不塞进任一单位成本分母。

### 6.4 综合感知成本

仅在**同币种、同统计周期、套餐/按量 token 归属互斥、各自 coverage 可见**时给综合值:

```text
recognized_total_cost = allocated_subscription_amount + metered_cost
blended_cost_per_mtok
  = recognized_total_cost
    / (subscription_tokens + metered_priced_tokens)
    × 1,000,000
```

不自动换汇;条件不满足时并列显示套餐与按量两张卡,不强拼一个总数。综合 cost/M 与
确认浪费率使用的 population 不同,**两者不得直接相乘**。

### 6.5 状态层现状

`month.json` 已保存逐日 token 桶与可选 `by_model`,但**不保存历史成本**;
`priced_day/month_cost` 在读取时按当前 `pricing.json` 投影。准确状态应表述为「月 token
已落地、按量成本计算器已落地」,不是「月账单已落地」。套餐金额输入、billing period、
pricing snapshot 和观察覆盖区间仍需新增。

### 6.6 覆盖率在感知层的含义

感知层的 `数据覆盖率` 默认指**进入本卡计算的 token ÷ 同期已观察 token**:

```text
perception_coverage = attributed_and_priceable_tokens / observed_processed_tokens
```

它回答「当前 cost/M 覆盖了多少已看到的用量」,不回答「磁盘日志是否覆盖整个账期」。
后者单独显示 `observed_from / observed_to / collector_health`;无法证明完整时不编百分比。
套餐日志只覆盖部分账期时,即使 perception coverage=100%,单位摊销仍是上界——两个
coverage 不得合并成一个看似精确的数字。

### 6.7 名义成本(list-price 口径,2026-09-05 新增)

6.1 与 6.2 都是「你实际付了多少」口径:套餐摊销受个人月费影响,按量成本受中转折扣
影响。两者都**不可跨用户、跨时间横比**——同一批 processed_tokens,买套餐的人与走中转
的人算出来差几十倍。名义成本补这个缺口:用**统一的官方市场标价**衡量同一批 token,
作用类似名义 GDP 用统一价格衡量产出。

```text
nominal_cost = Σ 各桶( bucket_tokens × 该桶的官方 list price )
             = uncached_input × input_uncached
             + cache_read     × input_cached
             + cache_write    × cache_write_<档>
             + output         × output

nominal_cost_per_mtok = nominal_cost / processed_tokens × 1,000,000
```

**不扣套餐、不扣中转折扣、不扣促销**——这正是「名义」的定义,也是它可比的来源。分母与
§6 的 `cost/M` 同为 `processed_tokens`,可与 6.1/6.2 并列成第三栏。

**实测构成**(Claude Code ledger 09-01→09-05,claude 族 33.3 亿 processed tokens,
anthropic 官方卡):

| 桶 | 金额 | 占比 |
|---|---|---|
| 缓存读取 | $1,002.07 | 78.9% |
| 缓存写入 | $176.86 | 13.9% |
| 输出 | $90.91 | 7.2% |
| 未缓存输入 | $0.05 | 0.0% |

缓存相关合计 92.8%,命中率 99.18%。**名义成本几乎完全由缓存单价决定**:补任何 provider
的价卡时,`input_cached` 是唯一必须问准的数,`output` 占 7%、`input_uncached` 占 0%。这也
给 §7 的下钻路径提供了量化依据——「缓存命中下降」排在诊断首位不是经验判断,是 92.8%。

**cache_write 档位是假设,不是观测**:Anthropic 分 5min/1hr 两档,价差 1.6×;实测 1hr
$176.86 vs 5min $110.54,**差额占名义总额 5.2%**。会话日志不记录实际 TTL,现有实现取
1hr(`cost/claude.rs`:Claude Code 自报 costUSD 按 1hr 计,照它走才能当差分 oracle)。展示
必须标注「cache_write 按 1hr 档计」,不得把 5.2% 的不确定性伪装成精确。

**与 §6.4「不自动换汇」的关系**:名义成本**允许**按显式声明、带日期的汇率折算成单一
货币展示(标注形如 `@7.1 · 2026-09-05`),不与 §6.4 冲突,因为两者性质不同——**名义是
度量衡(厘米可换英寸),实际是账(美元不能当人民币加进账本)**。`recognized_total_cost`
仍严格分币种、不自动换汇。

**派生:名义/实际倍数**(`nominal_cost / actual_cost`)表达套餐或中转带来的折扣杠杆,并
自带一条护栏:**倍数 > 50× 时不得显示「值 N 倍」,应告警「计费声明与实际用量不符」**。
实测 anthropic 族 380×——$20/月的 Claude Pro 物理上承载不了 33.3 亿 token,该倍数暴露的
是 billing_source 声明错误(实为中转路由),不是套利收益。与 §6.3「Harness ≠ BillingSource」
互为印证:倍数异常是归属错误的自检信号。

**护栏的第二种成因——已声明的免费额度(2026-09-11 补,发现于 WorkBuddy 接入)**:上面的
护栏隐含假定「极端倍数只有归属错误一种成因」。实测证伪:WorkBuddy 的 `hy3` 是平台推广
自家模型的**限免**,nominal > 0、actual = 0,倍数无定义/趋于无穷——而这**不是**声明错误,
平台确实免费给了。同一形状会出现在任何执行环境的新模型推广期、任何厂商的免费额度上,
**不是 WorkBuddy 特有**。护栏因此需要一条豁免分支:

- 展示层遇 actual = 0 且 nominal > 0 时,**先查是否有已声明的免费额度**(声明形状与
  `catalog_2026_09.subscriptions` 同类:provider / 模型或范围 / 起止日期 / `reported_at`);
  有声明 → 显示「名义 ¥X · 免费额度(已声明)」,**不**报「计费声明与实际用量不符」;
- 无声明 → 维持原告警。**成因归用户声明,不归机器推断**:「这是限免」与「这是自配路由」
  「这是执行环境未记账」在本机数据上不可分辨(`WORKBUDDY_ONBOARDING_SPEC.md` §2.1),机器
  只能报「actual 为零、成因未声明」;
- 限免的 token 仍是**真消耗、真产出**,名义价值不为零——这正是本节「不扣促销」的定义;
  它们进名义栏,显示的是**已捕获价值**(与浪费相反),不进任何实付栏。

> 出处:`WORKBUDDY_ONBOARDING_SPEC.md` §5.1.2/§5.3(发现地,已改为指向本节)。

**诚实性边界**:

- 名义成本**不是账单**,也**不是**「若不优化会花多少」的反事实节省(§8 铁律 4);它是
  计量尺,不进任何浪费分子(§8 铁律 1)。
- 无价卡的模型报 `unpriced_tokens`,**不得借用其他卡替代**。实测 claude-sonnet-5 分别按
  anthropic 官方卡 / v4-pro / v4-flash 计价得 $1,239 / ¥572 / ¥191,**相差 46 倍**——借卡
  等于编价。
- 命名冲突:现有 `nominal_vs_actual_cost`(`domain/cost/mod.rs`)里的 `nominal` 指「假设
  全部输入按 uncached 价算的无缓存反事实」,与本节的市场标价是两回事(实测两者差 8~10
  倍)。落地时该函数改名 `cache_counterfactual_cost`,把 `nominal` 让给本节口径。

---

## 7. 诊断指标:只解释变化,不进入浪费分子

用户从感知层点「为什么」后,按贡献度展示:

| 诊断维度 | 回答什么 |
|---|---|
| cache-read 命中率 / uncached 占比 | 单位成本是否受缓存结构影响 |
| 模型与 provider 构成 | 是否切到更贵或不同计费来源 |
| 高峰/低峰比例 | 分时价格是否推高按量成本 |
| fresh input / output / cache 四桶 | token 花在什么结构上 |
| 请求数 / session 数 / 平均上下文 | 用量增长来自频次还是单次变重 |
| compaction / 模型切换 | 上下文与缓存边界为何变化 |
| unpriced / unknown billing 比例 | 总览数字还缺多少列 |

典型下钻路径:

```text
单位处理成本上升
├─ 更贵模型/provider 占比上升
├─ 缓存命中下降
├─ 高峰时段占比上升
├─ output 占比上升
└─ 套餐观察用量下降(固定费被更少 token 摊销)
```

这些指标可以触发诊断或 W1 suspected,但不因「解释力强」就自动变成确认浪费。

---

## 8. 诚实性铁律(写进实现,像 `plan.rs` 的 docstring)

1. **证据不足 = 不计**。分子只收 `measured`(attribution 可证明)或带稳定复核记录的 `human-confirmed`;其余进「估算机会」「待复核」两块,永远不在分子。
2. **触发证据缺失 ≠ 零触发**(W4);**首个请求无前缀 ≠ 缓存 bug**(W1);**长尾 ≠ 全浪费**(W3);**影子记录 ≠ 双倍计费**(AccountingShadow)。
3. **标签不因措辞转化**——basis 三字段分离(measurement / attribution / pricing),「命中率低」是观察,「缓存坏了」是结论,互相不许代写。
4. **反事实隔离**。允许展示明确标为 `estimated` / `benchmark-counterfactual` 的机会,
   但绝不把「若不优化会花 X」写成生产实付节省或放进 confirmed 分子。
5. **baseline 必须带语料期标签**:DSH 08-18 前数据(bug 期)不进任何计算(`COST_BASELINE.md` §2);Claude Code 语料日期范围已实测(08-03 → 09-02)但**无已知事故分界**,只做结构不做前后对照(`CLAUDE_CODE_CORPUS.md` §7);其钱化是 catalog-provider 估算且分事件级/逻辑级两档(回声 1.99x),不冒充账单(§6)。
6. **无基线不告警(FR-05)**——结构性浪费(SV-COST)与相对浪费(缓存)分开;混进来用户会觉得系统冤枉自己的正常行为。
7. **分母诚实**——浪费率不用总成本作分母,审计覆盖率必须同屏;eligible 按规则与
   provider 需要的字段判断,不是机械要求所有执行环境四桶全有。
8. **Harness ≠ BillingSource**——执行入口不决定收费方;混合路由逐 usage 归属,归属未知
   就 unavailable。
9. **感知不冒充归因**——cost/M 可以做顶层产品指标,但它是摊销/混合效率,不能单凭
   变高或变低证明浪费。

---

## 9. 落地状态与动作

**已落地(代码,2026-09-01 核实)**:

- SV-COST-01(重复相同工具结果)与 SV-COST-02(失败重试上下文增长):core `waste.rs` ↔ Python `waste.py` 字节级 parity;wasm 导出 `structural_waste`;behavior 报告集成 `waste` + `waste_coverage`(三态门控,同 SV613/614 的 OR 覆盖)。
- 月 token(`token_by_date_model`)已进入 `month.json`;`priced_day/month_cost` 按读取时
  价表计算按量估算。单位成本的 token 分母与计算器已就位,账单确认、历史价格快照和
  billing source 尚未就位。
- **四族价目表 `catalog_2026_09`**(anthropic/minimax/moonshot + deepseek)已入
  `pricing.json`,`dsh-client/pricing.json` 字节复制,`test_pricing_lockstep.py` 三处一致;
  Claude Code 语料钱化落成 `CLAUDE_CODE_CORPUS.md` §6(catalog-provider 估算,事件级/逻辑级
  双档,cc TTL 实测 94.5% 1h、sonnet 09-01 分界、deepseek 平峰、M3 档位均已处理)。
  单位 token 成本(感知层)首次有真实数字:USD 块 $0.458/M、CNY 块 ¥0.246/M(processed)。

**未落地(本文定义的需求,按序)**:

1. `WasteClaim` 统一声明(core 类型 + 互斥证明测试)——可加总分子的前提。
2. 审计覆盖率计算:eligible audited cost 按规则/provider 所需字段 + 事件可归因判定进 core。
3. W1 eligibility 实现(按模型族、排除首请求/切换边界、最小请求数)+ 90% 阈值降级为**告警阈值**,按执行环境/模型族可配。
4. W3 人工确认记录结构(`reviewer`/`reviewed_at`/`confirmed_request_ids`),复核结果写入带 revision 的记录,可复现。
5. W4 exposure count 来源(启动次数)与 `catalog-visible ≠ body loaded` 的展示拆分。
6. **BillingSource + 套餐金额输入位**:按账户/账期记录 user-reported invoice 与
   allocated amount;没有就 unavailable,不按 harness 猜套餐。**输入位已落地**(2026-09-02:
   `pricing.json catalog_2026_09.subscriptions` 记 Claude Pro $20/月、MiniMax ¥114/月,
   basis=user-reported-invoice,锁步测试覆盖;Claude Code 语料已按订阅口径重算,见
   `CLAUDE_CODE_CORPUS.md` §6)。**账单确认**与历史价格快照仍待。
7. **月度感知成本投影**:套餐/按量分卡;同币种、同周期、无重叠才合并;输出数据覆盖区间。
8. **历史价格稳定性**:pricing card 增加 effective date,月投影保存/引用 pricing_version,
   防止当前价表静默重写历史。
