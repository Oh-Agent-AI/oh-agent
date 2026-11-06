# v1.0.0-beta.1 计费三轴模型规格（执行环境 × 模型 × 计费方/计费机制）

**状态：** v1.0 Draft（2026-09-16）。**问题清单已按真机取证，§7 有 4 个待产品定夺的决策点，未定之前不动代码。**

> **2026-09-17 修订（产品定向，已实装）——本节覆盖下文与 D02 冲突的条款：**
> 1. **按量/中转声明改金额**：`user_declared` 归因的事实从 `MeteredEstimate` 搬到新档 `MeteredDeclared`，归到声明的计费方名下，价卡按「声明计费方的卡 → 原厂官方卡 → 执行环境默认卡」解析；仍是估算档、不 summable。D02「按量声明不改金额」与 R4 **作废**。
> 2. **KPI「按量费用」三级口径**：`metered_view` = 账单（`metered_actual`/`harness_billed`）> 归因估算 > 默认估算，同计费方内取代、跨币分栏，带 `actual/estimate/mixed` 标签（`data_contract.rs`）。
> 3. **结算币种跟计费方走**：声明的 `settlement` 作用域（schema v15）> 目录卡片币种 > CNY；fallback 估算按 `fx_estimate` 折成结算币并标 `fair-market-fallback-fx`。
> 4. **声明是持续生效的规则**：每轮 `sync-facts` 末尾把当前有效声明套用到新事实（`billing_apply_active_declarations`）；开放期声明覆盖之后的事实——§3「事实 3」的顾虑作废。作用域默认计费方级，模型清单只在勾「仅限这些模型」时写。
> 5. **候选与声明一致性**：被有效声明占着的候选恒 `accepted`（reopen 拒绝、同步自愈）。
> 6. **预算口径**（取代 09-07）：`estimate` profile 已用 = 按量三级口径 + 订阅月费按天摊派。
> 执行记录见 `crates/agent-vitals-domain/src/domain/data_contract.rs`（MeteredView）、`runtime/src/summary.rs`（declared_provider_amounts）、`runtime/src/budget.rs`。
**日期：** 2026-09-16
**范围编号：** [发布规格](BETA_1_RELEASE_SPEC.md) B06、B07
**关联文档：** [计费确认主链规格](BETA_1_BILLING_CONFIRMATION_CHAIN_SPEC.md)（v1.4）、[自动归因规格](BETA_1_AUTO_ATTRIBUTION_SPEC.md)、[设置页规格](BETA_1_SETTINGS_PAGE_SPEC.md)、[Provider 路由归属规格](../PROVIDER_ROUTE_ATTRIBUTION_SPEC.md)（Draft）、[ATTRIBUTABLE_WASTE §6](../ATTRIBUTABLE_WASTE.md)

## 0. 一句话结论

问题不是某个 bug，而是两件结构性的错：

1. **「这批用量是不是订阅内的」在库里有两套权威**：事实行的 `billing_mode`（价卡/覆盖在摄入时写死、撤销不回退）与声明行的归因（可撤销、版本化）。而三个读取方各认一套——会话页认事实行（判订阅、不计费），月度金额只认归因（照旧算按量），待确认组只认事实行（判已解决、不再问）。**同一批事实，三个面三个结论**；被标成订阅的型号，声明从此再也覆盖不了它（F2，死角）。
2. **`relationship_kind` 一个枚举当三个轴用**（通道 × 计费机制 × 付款人）。于是「中转 + 套餐」这个**同时为真的组合**没有槽位，而它正是常见形态：真机取证显示两个 harness 都指向 `router.shengsuanyun.com`，用户订阅 MiniMax ¥44/月。

### 0.1 问题清单

| # | 问题 | 严重度 | 证据 |
|---|---|---|---|
| F1 | 事实行 `billing_mode='subscription'` **在钱的口径里不生效、在另外两个地方生效**——同一批事实两个面互相矛盾，且该组被永久挡在待确认之外 | **P0** | 排除谓词只认 `subscription_covered` 归因（`authority.rs:195` 起）；会话/事实投影却按裸列判订阅并不计费（`authority_query.rs:1293-1302`、`:1367`）；组查询硬过滤裸列（`authority_query.rs:165,187`） |
| F2 | 被标成订阅的型号，**声明再也不可能覆盖它**（重算匹配 0 条事实，「保存成功」但数字不变） | **P0** | `authority.rs:194` 的选取谓词也过滤 `billing_mode != 'subscription'` |
| F3 | 「中转 + 套餐」无法表达（选中转即隐藏订阅字段且不走金额） | **P0**（真机形态被挡在门外） | `workbench.js:1920-1931` 路由先说话；`workbench.js:1841-1847` 文案；`authority.rs:723,756` 两张表的 CHECK |
| F4 | 金额语义挂在 `official_subscription` 上，而不是「机制＝套餐」上 | P1 | `billing_preview.rs:45`；`summary.rs:1331/1367`（月费摊派只认它） |
| F5 | 「通道是否官方」的词汇表在 JS 与 Rust 各写一份，无守卫 | P1 | `billing_preview.rs:205` vs `workbench.js:1902` |
| F6 | 非订阅声明的归因行（`user_declared`）全仓库零消费方 | P1（**主体已修**，2026-09-16：保存对**所有关系**入队重算，待确认组谓词认 `user_declared`——确认经中转/按量/组织后行关掉、撤销重开；剩"已声明"徽标一项见 B10） | 修前：全仓库 grep 只有写入与 CHECK；真机发作：确认经中转后行永远留在待确认 |
| F7 | 同一件事有两条写入路径，一条可撤销、一条不可 | P2 | 声明不写 `billing_mode`；覆盖写它（`workbench.js:956` 设置页、`workbench.js:2494-2499` 声明连带），且撤销不回退 |
| F8 | `billing_declaration_put` 是死代码（仅测试调用），与 `revision_save` 并行 | P2 | 全仓库唯一调用方是测试；**本次修候选泄漏时就只改了后者** |
| F9 | 同一订阅分成两条声明（按模型组各声明一次）→ 月费**双计**（¥44+¥44） | P1（潜伏；**摊派侧已修**，见 §3.4；弹窗侧守卫 B14 未做） | `summary.rs::declared_subscription_fees`（修前不去重） |

**F1–F2 是同一个根**：`billing_mode='subscription'` 这个**事实行状态**被三个读取方分别理解成三件事。根因是"谁算订阅"有两套权威（事实行 vs 归因行），而只有归因行可撤销、只有事实行被组查询认。

**谁会把事实行标成订阅**（两个入口，都是用户可点的）：设置 › 价格目录的「型号归属 + 模式」（`workbench.js:956`，模式可选中/按量）；声明保存时的连带覆盖（`workbench.js:2494-2499`，`routeMode = kind === "official_subscription" ? "subscription" : "metered"`，条件是 `missing.provider && kind !== "third_party"`）。

**已修（本次会话，记录在案，不再是问题）**：声明的订阅月费无任何消费方（→ 主链规格 §10.3）；撤销未释放 `source_candidate_id` 导致 UNIQUE 死角（→ `8bf660e`）；订阅声明把结束日写成"今天"导致次月归零（→ 主链规格 §10.3）。

## 1. 现状盘点：三个轴各自存在哪

| 轴 | 承载 | 值域 / 来源 | 备注 |
|---|---|---|---|
| **A 执行环境 harness** | `usage_facts.harness` | codex / claude-code / dsh / workbuddy | 只答"谁发起、谁记录"，**与钱无关** |
| **B 模型** | `usage_facts.model_id`（+ `provider_raw`） | 型号串 | 厂商线索：`attribution_signatures.json` 的 `model_prefixes`（minimax←`minimax`/`abab`；zhipu-glm←`glm-`/`chatglm`；alibaba←`qwen`/`qwq`）。**只答"哪家的模型"，不答"钱付给谁"** |
| **C 计费方 provider** | `usage_facts.provider_id`（+ `billing_source`） | ①日志证据 ②价目表 `catalog_2026_09.billing_modes` 解析（`cost/billing.rs::billing_route_of`）③用户覆盖（`save_price_route`） | 解析不出 → NULL（真机 23,868 条 claude-code + 3,874 workbuddy + 2,544 codex） |
| **D 计费机制** | `usage_facts.billing_mode` **+ 声明行的 `relationship_kind` + 归因行** | `metered` / `subscription` | **两套表示**，见 §2 |
| **E 通道/证据** | `usage_facts.evidence_basis`（+ `route_evidence_id`） | session-native / explicit-official-route / inferred / conflict / config-current / env-current / missing | 判据：**先从型号名推厂商，再问"配置里的基址是不是该厂商的官方端点"**（`billing_preview.rs` 的 `official_for_vendor`，表在 `attribution_signatures.json`）。**不是**"相对于执行环境厂商是不是第三方" |
| **F 付款人** | 仅存在于 `relationship_kind = organization` | 个人 / 组织 | 与机制正交，却被塞进同一个枚举 |

**真机取证**（`agent-vitals.sqlite3` 只读副本）：

```
codex        | metered | openai            | 26720
claude-code  | metered | <null>            | 23868
claude-code  | metered | anthropic         | 22196
workbuddy    | metered | <null>            |  3874
codex        | metered | <null>            |  2544
dsh          | metered | shengsuanyun      |  1757
dsh          | metered | deepseek-official |   703
```

**全部是 `metered`——包括用户已声明为订阅的 `codex/openai`（26,720 条）。** 即"声明是订阅"完全没有回写到事实行；两者的调和只发生在一处（`authority_query.rs:1293-1323`：有 `subscription_covered` 归因就按 `subscription` 算，否则用裸列）。

**端点配置**（判 E 轴的输入）：

```
~/.claude/settings.json  ANTHROPIC_BASE_URL       = https://router.shengsuanyun.com/api
                         ANTHROPIC_DEFAULT_OPUS_MODEL = bigmodel/glm-5.3-flash
~/.codex/config.toml     [model_providers.custom] base_url = https://router.shengsuanyun.com/api/v1
                         model = "openai/gpt-5.6-sol"
```

两个 harness 都指向胜算云（对 glm/deepseek 而言确实不是官方端点 → 判"中转"**判得对**），而用户对 MiniMax 是**订阅 ¥44/月**——通道是中转、机制是套餐，两者同时为真。

## 2. 问题详述

### F1 同一批事实，三个面三个结论（P0）

`billing_mode='subscription'` 这个**事实行状态**被三个读取方分别理解成三件事：

| 读取方 | 位置 | 它怎么理解 |
|---|---|---|
| 会话 / 事实投影 | `authority_query.rs:1293-1302`（`billing_mode_expr`）+ `:1367`（`cost_minor = if billing_mode == "subscription" { None }`） | **是订阅 → 不计费** |
| 月度金额（唯一排除谓词） | `authority.rs:195` 起（`NOT EXISTS <subscription_covered 归因>`） | **不认它** → 这批用量照旧计入按量与名义 |
| 待确认组 | `authority_query.rs:165,187`（`billing_mode != 'subscription'`） | **已是订阅 → 不再问** |

于是同一个型号的用量：会话页说「订阅、不计费」，月度总额把它算进按量，待确认列表也不提它。这不是"数字有偏差"，是**同一份数据自相矛盾**——正是主链规格 §3「一个谓词」想避免的那类问题，只是这里多长出了一套平行权威。

触发入口都是用户可点的：设置 › 价格目录的「型号 + 服务商 + 模式」（`workbench.js:956`，模式可选中/按量），以及声明保存时的连带覆盖（`workbench.js:2494-2499`）。**真机今天未触发**（`~/.agent-vitals/state/pricing-overrides.json` 不存在，公共目录里也没有任何 subscription 条目），所以这是潜伏缺陷。

### F2 被标成订阅的型号，声明再也不可能覆盖它（P0）

即使忽略 F1，还有一个死角：**声明的事实选取谓词**也过滤裸列（`authority.rs:194`）：

```sql
AND COALESCE(f.billing_mode, 'unknown') != 'subscription'
```

于是对这批事实，声明永远匹配 0 条 → 重算回执 `fact_count = 0`、「保存成功」但任何数字都不变——也正是主链规格 G1 / AC27 要防的失败模式（"用户以为确认了、数字没变"），只是触发路径从候选按钮换成了价格目录里的那个模式选择。

**附带**：撤销声明后，组不会自动回到待确认（它被同一列挡着），要恢复得去设置 › 价格目录把模式的归属删掉或改回按量。这是一条**不可发现**的恢复路径。

### F3 「中转 + 套餐」无法表达（P0）

`relationship_kind` 的五个值里塞了三种性质：

| 取值 | 其实是 |
|---|---|
| `official_subscription` | 通道=官方 **×** 机制=套餐 |
| `official_api` | 通道=官方 **×** 机制=按量 |
| `third_party` | **通道** = 不是该模型厂商的官方端点 |
| `organization` | **付款人** = 组织 |

UI 再让**通道先说话**（`billingRelationshipFromSteps`：`route === "third_party"` 直接返回它），而 `third_party` 按 Beta 规则**不改金额**且**隐藏订阅信息行**（`BILLING_RELATIONSHIP_EFFECT` + `subscription.hidden = kind !== "official_subscription"`）。结果：**用户的实际形态（中转 + 订阅 ¥44/月）在弹窗里没有填法**——选中转填不了钱，想填钱得把通道答成官方。

补充一条事实（写进验收口径，免得被当成"已经错了"）：**通道下拉的值不落库**。`billingDeclarationScopes()` 只产生 `provider` 与 `model` 两种作用域；`usage_facts` 按规格不因任何声明而变。它只参与推导 `relationship_kind`。

### F4 金额语义挂错了锚点（P1）

`billing_preview.rs:45`：`let changes_amounts = relationship_kind == "official_subscription";`，以及本次新增的月费摊派（`summary.rs:1331/1367`）也只枚举 `official_subscription`。**钱的口径由此绑在"通道=官方"上，而不是绑在"机制=套餐"上**——但真正决定要不要改金额的是机制：套餐是固定费、不需要单价；按量才需要可信的价卡。

### F5 词汇表双份（P1）

`ROUTE_KNOWN_OFFICIAL`（`billing_preview.rs:205`）与 `BILLING_ROUTE_KNOWN_OFFICIAL`（`workbench.js:1902`）是同一份词表的两份拷贝。仓库对纯规则有"三处锁步 + 守卫"的纪律，这里两处都没有守卫。

### F6 非订阅声明在任何面上都不可见（P1）

`user_declared` 归因行**全仓库零读取方**（只有写入与 CHECK）。所以「官方 API（按量）」「组织承担」「中转」这三种声明除了出现在"当前计费声明"列表里，**对任何数字、任何标记都不产生可见效果**。这不是 bug 而是未完工：要么给它一个面（例如"已声明：按量/组织承担"的标记），要么承认它只是备注。

### F7 两条写入路径、一条不可撤销（P2）

同一次保存做两件事：写声明（可撤销）+ 写价卡覆盖（不可撤销）。**"这批用量是套餐内"有两个来源，而不是一个。**

### F8 `billing_declaration_put` 是死代码（P2）

唯一调用方是测试。它与 `revision_save` 是并行的两条写入路径，改一处漏一处——本次修 `source_candidate_id` 泄漏时就只改了 `revision_save`。

## 3. 目标模型

保留六轴，**明确各自谁是权威、谁是证据**：

| 轴 | 权威来源 | 可撤销 | 用途 |
|---|---|---|---|
| A 执行环境 | 事实行（执行环境日志） | — | 分组维度 |
| B 模型 | 事实行 | — | 厂商线索、作用域 |
| C 计费方 provider | 事实行（日志 → 目录 → **用户覆盖**） | 覆盖可删 | 归价卡；决定归到谁名下 |
| **D 计费机制** | **声明（归因）**，事实行的 `billing_mode` 只作目录默认 | **是** | **唯一决定要不要改金额** |
| E 通道/证据 | 事实行（端点证据） | — | 决定"官方价卡可不可信" |
| F 付款人 | 声明 | 是 | 组织承担标签 |

**唯一改动原则（本规格的核心）：把"谁改金额"从 `relationship_kind == official_subscription` 改成"机制 == 套餐"，并把通道从计费枚举里拿出去。**

- **机制＝套餐**：不论通道是官方还是中转，都改金额——命中事实移出按量估算（`subscription_covered`），声明的月费进 `FixedSubscription`。理由：套餐是固定费，不需要可信单价，中转的"价卡不可信"这个问题根本不存在。
- **机制＝按量**：不改金额（维持 D02：第三方价的编辑随后续版本提供，仍按官方价估算并标待确认）。
- **付款人**：只加标签，不改金额（现状）。

### 3.1 词表改造

`relationship_kind`（5 值混合枚举）→ 拆成两个正交字段：

| 旧 | 新 |
|---|---|
| `official_subscription` | `billing_mode='subscription'` + `payer='self'` |
| `official_api` | `billing_mode='metered'` + `payer='self'` |
| `third_party` | `billing_mode='metered'` + `payer='self'`（通道由事实行记；按量的中转仍不改金额） |
| `organization` | `billing_mode='metered'` + `payer='organization'` |
| `unknown` | 不是声明（维持） |

- `billing_mode`：`metered` / `subscription`
- `payer`：`self` / `organization`
- 通道**不进声明**（留在事实行 `evidence_basis`）。若将来要在声明上钉"这条声明只作用于中转流量"，再加一个可选的 `route_scope`，而不是复用计费枚举。

### 3.2 两套表示的收口

"这批用量是不是订阅内的"只留**一个权威：归因行**（`subscription_covered`，可撤销、版本化）。三个读取方各自的例外都取消：

- **钱**：维持现状——唯一排除谓词只认归因，不动。
- **待确认组**：去掉裸列过滤（B2）。"已解决"只由归因决定，于是撤销后该组自然回到列表。
- **声明选取**：去掉裸列过滤（B2）。于是价格目录里的模式选择不会让声明匹配 0 条事实（F2 死角消失）。
- **会话/事实投影**：`authority_query.rs:1293` 那条调和表达式保留作为过渡，D6 定案后与上面两处统一（要么一致地只认归因，要么一致地认两套）。

事实行的 `billing_mode` 降级为**定价提示**——"这个型号不按 token 计价"，它只影响计价/展示，**不再参与"是否已解决"，也不再单独改金额**（§7-D6-(i)）。

**两条写 mode 的路径要区分开**（这是 F7 的关键）：

| 路径 | 写什么 | 为什么 |
|---|---|---|
| 声明保存的**连带**覆盖（`workbench.js:2494-2499`） | **不再写 mode**（B4） | 它是把"关系状态"写进一个不可撤销的地方；关系状态本来就该由声明表达，而声明可撤销 |
| 设置 › 价格目录的**显式**选择（`workbench.js:956`） | 保留 mode | 这是用户在型号级的有意声明（"这个型号怎么算"），保留，但语义按 D6-(i) 收窄为"不按 token 计价" |

### 3.3 声明即订阅事实（2026-09-16 产品定向）

**用户想要的场景**：在归因的过程中就把订阅事实（哪家、每月多少、从哪天起）填掉，**不**再单独维护一套账单。产品已确认这是目标形态。

**架构依据**：「声明永不产生已付款」（发布规格 §3.1 / 主链规格 §2.3 原文）把两件不同的事压成了一条——

1. **按量实付不可编造**：不看到账单，不可能知道一次调用真付了多少。这条**保留**。
2. **自报固定月费不可信**：防过头了。¥44/月是用户直接知道的**承诺事实**，不是估算；它的风险是**过期**（停付/涨价后声明还在），那是新鲜度问题，用标注与校准解决，不该用"不计入"解决。

**目标：每种钱一个权威，账单降级为校准层（不是必填的并行体系）**：

| 钱的口径 | 权威 | 说明 |
|---|---|---|
| `fixed_subscription` 订阅月费 | **声明**（归因时填） | 已接通（主链规格 §10.3）。声明天然版本化、可撤销、带起止——比 `harness_bills` 的平表更适合当权威 |
| `metered_actual` / `harness_billed` 按量实付 | **账单/付款记录**（`harness_bills`） | 纪律原样保留：没有账单就没有这个数 |
| 名义 / 估算 | 价卡 | 现状不变 |

**取代规则（防双计，B11）**：同一 provider 同一月份，若存在 `harness_bills` 的 `fixed_subscription` 行，**以账单为准、取代**声明那条月费，二者不相加（现状 `apply_harness_bills` 在声明摊派之后叠加执行，会双计——真机 `harness_bills` 为空，未触发，属潜伏）。

**过期风险的处置（代替"不计入"）**：口径标注（自报 / 账单校准，`basis` 词表已有）；撤销即停（已有）；可选的 N 个月后温和再确认（不确认也照扣——把"可能过期"暴露出来，比制造数据缺失诚实）。

**弹窗文案已同步**：两处旧的"月费只在有账单或付款记录时才计入实际支出"与 §10.3 之后的实际行为相反，已改为"按此声明计入（自报口径），录到真实账单时以账单为准校准"。

### 3.4 订阅的存储与修改（2026-09-16 产品追问的定案）

**Q：用户不用单独维护账单，数据层还要不要一张"订阅表"？**
**A：不需要新表——`billing_declarations`（+ 不可变修订历史）就是订阅表。** 订阅事实需要的每个字段它都有：谁（harness/provider）、什么套餐（`subscription_name`）、多少钱（`amount_minor`+`currency`）、从哪天起（`effective_start`，锚点即首次扣款日）、到哪天止（`effective_end` 可空＝持续有效）、完整审计（修订链）。§3.3 的月费摊派读的就是它。各表职责重划：

| 表 | 职责 | 不再承担 |
|---|---|---|
| `billing_declarations` + revisions | **订阅登记**（关系+金额+期间，版本化、可撤销） | — |
| `harness_bills` | 只有账单才能证明的钱：`metered_actual`（按量实付）、`harness_billed`（充值/积分消耗）；以及对声明月费的**校准**（B11 取代规则） | ~~订阅登记~~ |
| 价目表 `catalog_2026_09` | 路由归属 + 价卡 | ~~`subscriptions` 段~~（从未存在，方向上也不再需要——订阅一律来自用户声明） |

**Q：用户能不能修改订阅情况？**
**A：必须能——订阅会涨价、换档、退订，而"声明即订阅事实"意味着修改订阅＝修改声明。** 现状是三个能力里只有两个：

| 操作 | 现状 | 说明 |
|---|---|---|
| 新建 | ✅ | 明确计费方式弹窗 |
| 撤销 | ✅ | 撤即停扣（`8bf660e` 之后连候选占位也释放）；语义＝**全链作废**（写错了） |
| **修改（涨价/换档/退订）** | ✅（B13，2026-09-16） | 当前计费声明面板「修改订阅」内联表单，追加 supersede 修订；改价自当月起（`created_at` 定界，不重写历史），退订＝带结束日的修订（过去照摊） |

**目标形态（B13）：修改＝追加一条 supersede 修订**——数据层早已支持（`revision_save` 要求 supersede 当前修订、`revision_number` 递增），只是桌面从不走。两个必须一起解决的语义：

1. **按月取价**：月费摊派当前只读当前态（一行一个金额），改价会**追溯改写历史**（¥44→¥49 会把 2025-07 起的所有月份都变成 ¥49）。修订链里每条 saved 修订自带金额+起止，摊派改为按月查"当月生效的那条修订"。
2. **撤销不抹历史**：当前态被软删后，过去月份的月费一并消失——但那些月用户**真付过钱**。退订语义应是"修订链在今天终止"，过去的月份照摊。撤销"这条声明写错了"的语义则确实是全链作废——两种意图要用不同的修订形态区分（`amended` vs `revoked`）。

**顺带修掉的双计风险（F9）**：待确认组按模型组切，同一订阅常被分两次声明（MiniMax-M3 一组、M2.7 一组），两条声明各带 ¥44——摊派不去重就是 ¥88/月。已修：`declared_subscription_fees` 按 harness+provider 去重，留最早生效的一条（多账户同服务商的订阅当前模型表达不了，不冒充支持）。弹窗侧的同伴守卫（B14）：保存第二条同服务商订阅声明时提示"已有 ¥44/月 的订阅声明，重复声明会双计——请撤销旧的或等修改功能"。

## 4. 改动清单

| # | 位置 | 改动 | 依据 |
|---|---|---|---|
| B1 | `authority.rs` 两张表的 CHECK + `valid_kind` | 新增 `billing_mode`、`payer` 两列，退役 `relationship_kind`（表重建迁移，照 v14 重建 scopes 的同一套做法） | F3、F4 |
| B2 | `authority_query.rs::SQL_UNRESOLVED_BILLING_GROUPS`（`:165,187`）、`authority.rs` 声明选取谓词（`:194`） | **去掉裸列的 `billing_mode != 'subscription'` 过滤**，改为只认归因（"是否订阅"回到单一权威，见 §7-D6） | F1、F2 |
| B3 | `workbench.js` 弹窗 | 「通道」与「计费关系」拆成两问；计费关系对任意通道都放出来；套餐分支才出订阅信息 | F3 |
| B4 | `workbench.js:2494-2499` | **声明保存时不再连带写 `mode`**（只写型号归属）。理由：那是把"关系状态"写进一个不可撤销的地方（F7）；用户要在型号级声明模式，走设置 › 价格目录那条**显式**路径 | F1、F7 |
| B5 | `billing_preview.rs:45` | `changes_amounts = billing_mode == "subscription"` | F4 |
| B6 | `summary.rs:1331/1367` | 月费枚举改为按 `billing_mode='subscription'`，不再按 `official_subscription` | F4 |
| B7 | `lib.rs::revoke_billing_declaration` + 迁移 | 历史数据里"已撤销的声明留下的 `mode=subscription` 覆盖"回退为 `metered`，让被挡住的事实重新进入待确认（防御性；真机当前不存在） | F1 |
| B8 | `ROUTE_KNOWN_OFFICIAL` / `BILLING_ROUTE_KNOWN_OFFICIAL` | 收敛为一份（Rust 侧为准，JS 从 DTO 拿或加一条守卫比对） | F5 |
| B9 | `authority.rs::billing_declaration_put` | 删除（死代码） | F8 |
| B10 | 非订阅声明的可见面 | 待 §7-D4 定：给标记 or 降级为备注 | F6 |
| B11 | `summary.rs::apply_harness_bills` | **取代规则**：同一 provider 同月存在 `harness_bills` 的 `fixed_subscription` 行时，以账单为准、**取代**声明月费（现状是叠加，会双计；真机 `harness_bills` 为空，潜伏） | §3.3 |
| B12 | KPI「订阅月费」行 | 口径标注：自报（声明）/ 账单校准（有 `harness_bills` 取代的月份），hover 展开 | §3.3 |
| B13 | 弹窗「修改订阅」+ `summary.rs` 摊派 | **已落地（2026-09-16）**：当前计费声明面板的「修改订阅」内联表单追加 supersede 修订（改价/退订，作用域原样带回）；摊派 `declared_fee_for_month` **按修订链按月取价**——首修订允许回溯（订阅自始在付），后续修订只从**声明那个月**起改价（`created_at_ms` 定界，改价不重写历史）；**退订＝带结束日的修订**（过去的月照摊、到期停），**撤销＝全链作废**（写错了，任何月份都不摊）——两种意图用修订形态天然区分，不需要新增撤销模式 | §3.4 |
| B14 | 弹窗保存校验 | 保存第二条同 harness+provider 的订阅声明时提示已有声明（金额/起始日），拦双计于写入前 | §3.4、F9 |

## 5. 迁移

1. **表重建**（B1）：`billing_declarations` 与 `billing_declaration_revisions` 原地重建，旧 `relationship_kind` 映射到新两列（映射表见 §3.1；`unknown` 行不迁移——它不是声明）。既有库在 open 时迁移。
2. **一次性数据修复**（B7）：把历史上"覆盖写了 `mode=subscription` 但声明已撤销"的型号，其覆盖的 mode 回落 `metered`，让被挡住的事实重新进入待确认。**真机当前不存在这种行**（`pricing-overrides.json` 缺席），所以这一步是防御性的。
3. `billing_declaration_revisions` 的 `relationship_kind` 保留原样作为历史（不可变修订不改写），新列在旧行上按映射回填。

## 6. 测试计划

| # | 用例 | 钉住 |
|---|---|---|
| R1 | 保存"套餐"→ 重算 → 撤销 → 组**重新出现**在待确认 | F1（死角） |
| R2 | 同一次保存后，事实行的 `billing_mode` 仍是 `metered`（机制只活在声明里） | F7、§3.2 |
| R3 | 「中转 + 套餐」可保存，命中事实移出按量估算，月费进 `FixedSubscription` | F3、F4 |
| R4 | 「中转 + 按量」保存后金额不变、`changes_amounts = false` | 维持 D02 |
| R5 | 旧库（v14 词表）迁移后，五种旧 kind 映射到新两列的取值逐条对拍 | §5.1 |
| R6 | **三个读取方对同一批事实结论一致**：会话投影 / 月度金额 / 待确认组（造一批 `billing_mode='subscription'` 且**无归因**的事实钉住） | F1 |
| R7 | 守卫：JS 与 Rust 的"通道已知官方"词表逐项一致 | F5 |
| R8 | 在价格目录把型号模式选成订阅之后，**声明仍能覆盖它**（重算匹配 > 0 条事实） | F2 |
| R9 | 声明保存不再连带写 `mode`：保存一条套餐声明后，`pricing-overrides.json` 里那条覆盖只有归属、没有 subscription 模式 | F7、B4 |

## 7. 决策点（D1/D2/D3/D6 已于 2026-09-16 定向，见 §3.3；其余待定）

- **D1｜套餐是否对任意通道都改金额？** **已定向：是**（用户场景即实例：中转 + MiniMax 订阅 ¥44/月）。规格 §2.2/§2.3 与 D02 的"third_party 只记录关系、不改金额"限定为**仅按量**。
- **D2｜通道进不进声明？** **已定向：不进**（留在事实行）。"通道值不落库"成为显式设计；将来要按通道限定作用域，另加 `route_scope`。
- **D3｜按量的第三方路由，是否继续按官方价估算？** **已定向：继续**（维持 D02，拿不到中转真实单价）。
- **D4｜非订阅声明（按量/组织承担）要不要可见面？** 现在它们在任何数字/标记上都不出现（F6）。建议给一个"已声明：按量 / 组织承担"的小标记，否则用户会重复声明。**待定。**
- **D5｜积分（HarnessBilled）要不要在声明里可选？** 用户的"积分是按量的变体"成立，但它已经是执行环境账单口径（`harness_bills`），是否需要在弹窗里单选，取决于是否要把它和"按量"分开显示。**待定。**
- **D6｜「这批用量是不是订阅内的」谁说了算？** **已定向：(i) 归因是唯一权威**——钱、「已解决」、会话投影三处都只认 `subscription_covered` 归因；事实行的 `billing_mode` 降级为定价提示（"这个型号不按 token 计价"），不参与"是否已解决"，也不单独改金额。三面立刻一致、撤销天然可逆、F2 死角消失。价格目录那条路径补一句说明：选了订阅模式而不声明关系时，这批用量不计价也不被覆盖。

## 8. 实施顺序与风险

按"先数据后 UI"两步走，每步独立可验收：

1. **第一步（B1、B2、B9 + §5 迁移）**：词表与谓词。不动 UI；保证旧数据可读、旧 kind 可映射；真机可跑。风险中等（表重建，与 v14 同款）。
2. **第二步（B3–B8、B10）**：弹窗两问、金额锚点、词汇表收敛、覆盖不写机制、撤销清理。

**风险**：B1 是两张权威表的表重建，失败会让声明不可读——迁移必须在一个事务里，并在真机前用"从 facts JSONL 重建 + 现有库迁移"两条路径各跑一遍（`data-migrate` 与原地升级）。
