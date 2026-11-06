# Agent Vitals Data Layer Provider/Billing Attribution Specification

> 状态：Draft R4  
> 日期：2026-09-09  
> 适用范围：Provider Catalog、Harness Adapter、Runtime ingest、UsageFact、SQL Authority、成本与 coverage 查询
> 迭代范围：v0.11.0 Provider Evidence；v0.12.0 Billing Templates & Cost  
> 前置：Authority 当前 schema 为 v2
>
> 外部参考：[`farion1231/cc-switch`](https://github.com/farion1231/cc-switch)，
> 调研基线 `f21e094`（2026-09-09，MIT License）

## 1. 问题定义

当前链路同时存在证据丢失与职责越界：

1. `UsageFact` 已定义 `provider_raw`、`billing_source`、`billing_mode`、
   `pricing_basis`，但 `usage_facts` 只保存 `provider_id`。
2. Codex endpoint 解析位于 `runtime::sync_service`，而它属于 Codex
   source adapter 的执行环境知识。
3. Codex adapter 仅凭 `model_provider=openai` 写
   `billing_mode=subscription`，混合了“观测证据”和“计费政策”。
4. Claude adapter 明确只保存 `model_raw`，无法保留 route/provider 证据。
5. DSH adapter 保存 `provider_raw`，但没有统一完成 provider normalization。
6. `session_cost_minor` 和 `coverage_status` 忽略事实级 provider，重新从模型名
   推断计费方。
7. `sessions_in_window` 固定写死三个执行环境，新执行环境有事实也可能在查询面消失。
8. Claude legacy ledger 的读取、解释和写库全部位于 data crate，形成执行环境专属
   import 逻辑。

未知 provider、未知计费模式和无价格卡不得被转换为 OpenAI、订阅或零金额。

## 2. 分层原则

引入新的纯逻辑 crate `agent-vitals-provider`。依赖方向调整为：

```text
apps → runtime → harnesses ───────→ domain
              → provider ─────→ domain
              → data ─────────→ domain
```

`agent-vitals-data` 不得依赖 `agent-vitals-harnesses` 或
`agent-vitals-provider`。Runtime 同时认识 harnesses、provider 和 data，负责组合。

| 层 | 必须负责 | 禁止负责 |
|---|---|---|
| Harness Adapter | 路径发现、执行环境配置读取、wire 解析、原始证据提取、执行环境去重与降级 | SQL、跨执行环境查询、价格政策 |
| Provider | provider catalog、endpoint 匹配、计费模板、provider normalization、归属 resolver | 凭据、网络请求、SQL、执行环境日志解析 |
| Domain | BillingMode/Basis、Money、EvidenceStrength 等稳定业务类型与不变量 | provider preset、文件 I/O、数据库 I/O |
| Data | 通用 schema、迁移、校验后持久化、通用维度查询、幂等与质量问题 | 解析 Codex/Claude/DSH 文件、从模型猜 provider |
| Runtime | 调 Adapter、Provider resolver、quota probe executor、驱动重放、写 Data、组装 DTO | 重写执行环境解析、内嵌 provider catalog、复制计价规则 |

Adapter 产出“观察到什么”；Provider 决定“这是谁、属于哪种计费模板”；
Domain 定义稳定业务语义；Data 负责“完整保存和可重复查询”。

## 3. CC Switch 调研结论

cc-switch 已经把 provider 计费问题拆成多个独立概念：

- 用量查询模板：`token_plan`、`official_subscription`、`balance`、
  `custom`、`general`、`newapi` 等；
- provider 元数据：`costMultiplier`、`pricingModelSource`、日/月限额；
- 模型价格：输入、输出、cache read、cache creation 的每百万 token 单价；
- Token/Coding Plan provider 的 endpoint 匹配与额度查询；
- 官方订阅的本机 OAuth 凭据与 quota window 查询。

这证明 provider 不只是一个字符串映射，而是独立 bounded context。但
Agent Vitals 不直接复制其结论：

- `costMultiplier` 是用户配置的估算参数，不是账单；
- quota snapshot 证明套餐/额度存在，不证明某条历史事实一定被该套餐覆盖；
- current active provider 不能替代历史 session route；
- provider preset 是发现和查询模板，不是实际支付凭证；
- cc-switch 统一 session history 后也可能无法恢复历史 provider，Agent Vitals
  必须继续保留 unknown/unresolved。

> **2026-09-17 增补：cc-switch 的库现在是一个数据源，不只是调研参考。**
> `~/.cc-switch/cc-switch.db` 的 `providers.created_at` + `backups/db_backup_*.db`
> 的 `is_current` 是本机唯一带时间的路由证据（`config-time-bound`(5) 的第一个
> emitter，`agent-vitals-harnesses/src/sources/ccswitch.rs`）。它仍不能恢复"某条会话走了
> 哪家"（上一条结论不变），但能**排除**"那时还不存在的中转"：真机事故里 codex 的
> `custom` 会话被当前 `config.toml` 整月建议成胜算云，而胜算云那条 provider 09-11
> 23:43 才建——09-09~11 的 443 条 gpt-5.6-sol/luna（134M tokens、官方价估 ¥736）不可能
> 经它，胜算云账单上也确实没有。判定器（`billing_preview::auto_verdict`）据此把
> 建立晚于事实窗口的中转从候选剔除（`config.timeline.excluded`）、建立于窗口中途的标
> `partial` 并数出前半段（`tokens_before`），确认列表逐条显示。同一端点在 cc-switch
> 里的多条（用户起名不同）合并为一条、取最早建立时刻。只读 `base_url` /
> `env.ANTHROPIC_BASE_URL`，凭据不进结构。

可复用的是分类、字段设计和 probe 思路；不能复用的是“模板命中即账单真值”的
隐含假设。若复制实质代码或模板，必须保留 MIT 许可证声明与来源版本。

调研依据：

- [`src/config/constants.ts`](https://github.com/farion1231/cc-switch/blob/main/src/config/constants.ts)：
  usage template 词表；
- [`src-tauri/src/provider.rs`](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/provider.rs)：
  provider multiplier、pricing model source 与限额字段；
- [`src-tauri/src/services/model_pricing.rs`](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/model_pricing.rs)：
  模型价格与 models.dev 同步结构；
- [`src-tauri/src/services/coding_plan.rs`](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/coding_plan.rs)：
  Token/Coding Plan endpoint 检测与额度查询；
- [`src-tauri/src/services/subscription.rs`](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/subscription.rs)：
  官方订阅凭据、quota tier 与 extra usage。

## 4. Provider Crate 合同

建议新增：

```text
crates/agent-vitals-provider/
  src/
    lib.rs
    catalog.rs
    identity.rs
    endpoint.rs
    attribution.rs
    template.rs
    pricing_policy.rs
```

核心类型：

```text
ProviderProfile {
  provider_id,
  aliases,
  endpoint_matchers,
  billing_templates,
  pricing_policy?,
  quota_probe?,
  source,
  version,
  effective_from?,
  effective_to?
}

BillingTemplate {
  template_id,
  kind,
  provider_id,
  product_scope?,
  credential_binding?,
  quota_probe_kind?,
  default_billing_mode,
  evidence_requirement
}
```

第一版模板词表：

```text
MeteredApi
TokenPlan
OfficialSubscription
BalanceAccount
RelayMultiplier
Custom
```

`PricingPolicy` 至少支持：

```text
pricing_model_source = request | response | observed
cost_multiplier?
currency?
price_catalog_ref?
```

这些字段只描述“如何估算”。`cost_multiplier` 或 `price_catalog_ref` 在没有
invoice/provider usage API 证据时只能产生 estimate。

Provider crate 必须是纯逻辑：

- 不读取 API key、OAuth token 或用户配置文件；
- 不执行 HTTP；
- 不连接 SQLite；
- 不持有用户账户状态；
- catalog 输入输出可序列化、可版本化、可确定性测试。

Quota probe 的执行描述可以放在 Provider crate，但实际凭据解析和请求由
Runtime 调 Harness Adapter 或专门的 runtime probe executor 完成。

## 5. Adapter 合同

`RouteEvidence` 是 **Domain-owned contract**，由 Adapter 填充；它不能定义在
Codex/Claude 模块里，否则 Runtime 无法用同一 resolver 处理多执行环境。Adapter
应返回 `UsageFactCandidate` 与可选 `RouteEvidence`：

```text
RouteEvidence {
  provider_raw?,
  endpoint_host?,
  account_ref?,
  plan_type?,
  quota_window?,
  is_using_overage?,
  evidence_basis,       // session-native | config-current | env-current | inferred
  observed_at?
}
```

要求：

- Codex 的 `~/.codex/config.toml` 解析迁入
  `harnesses/codex/sources/`；Runtime 不再解析 TOML 文本。
- 显式 session `model_provider` 优先于 current-config hint。
- current config 只能标为 `config-current`，不得冒充历史 session 原生证据。
- Claude adapter 负责读取 Claude session、账户与环境中可用的 route evidence；
  无法绑定到历史事件时必须标为 current hint。
- DSH adapter 继续保存 `provider_raw`；规范化 provider 由 Domain resolver
  统一完成。
- Adapter 不得仅凭 provider 名称宣布 subscription。订阅必须由 Domain 根据
  provider、plan、endpoint、overage 和证据范围裁决。

Python/Rust adapter 必须保持同输入同输出；环境级 evidence 由调用方显式传入，
不得让 parity 测试隐式读取本机配置。

### 5.1 当前代码迁移表

| 当前实现 | 问题 | 目标位置 |
|---|---|---|
| `runtime::sync_service::codex_route_provider` | Runtime 解析 Codex TOML | `harnesses/codex/sources/route_evidence.rs` |
| Codex emitter 直接写 subscription/metered | Adapter 执行计费政策 | Provider attribution resolver |
| Claude emitter 只写 `model_raw` | Route evidence 未进入事实 | Claude source adapter |
| DSH emitter 只写 `provider_raw` | 三执行环境 normalization 不统一 | Provider attribution resolver |
| `data::legacy_import` 读取 Claude ledger | Data 解释执行环境文件 | Claude source adapter + Runtime |
| `data::codex_by_hour_model` 生成 `standard`/五桶形状 | Data 生成执行环境消费形状 | Runtime/harness projection adapter |

现有 dependency guard 不需要放宽：Data 继续禁止依赖 Harnesses，Harness I/O 继续只允许
位于 `harnesses/*/sources`。

## 6. 归属裁决合同

在 `agent-vitals-provider` 中新增纯函数：

```text
resolve_billing_attribution(model_raw, route_evidence, provider_catalog)
  -> BillingAttribution
```

```text
BillingAttribution {
  provider_id?,
  billing_source?,
  billing_mode,         // subscription | metered | unknown
  pricing_basis,
  evidence_basis,
  has_unresolved
}
```

裁决优先级：

1. 事件/session 原生 provider 和账单证据；
2. 与事件时间可绑定的账户或 endpoint 证据；
3. current config/env hint；
4. provider 声明；
5. unknown fallback。

只有明确官方订阅证据可以产生 `subscription`。Custom endpoint、第三方网关、
冲突或缺失证据统一报告为 `metered + has_unresolved=true`；展示 basis 为
`metered_estimate`。模型名只能帮助匹配价格卡，不能覆盖事实中的 provider。

Evidence strength 必须可比较：

```text
session-native > account-time-bound > config-time-bound >
config-current/env-current > inferred > missing
```

Enrichment 只能用更强 evidence 补齐或替换更弱 evidence。强度相同但 provider
冲突时不自动覆盖，写质量问题并保留两份 evidence 引用。`normalization_version`
变化可以重新计算 `provider_id`，但不得修改 `provider_raw`。

### 6.1 模板不是事实

归属结果必须区分：

```text
template_match       catalog/preset 命中
route_observed       session/request route 证据
quota_observed       套餐额度探测结果
invoice_confirmed    账单或用户确认
```

`OfficialSubscription` 模板本身不能产生 `subscription` 事实；至少还需要有效账户
凭据与适用时间范围。`TokenPlan` quota snapshot 不能自动覆盖 endpoint 切换之前
或之后的事实。`RelayMultiplier` 永远是估算规则，不能产生 MeteredActual。

## 7. SQL 数据合同

v0.11/schema v3 为 `usage_facts` 新增可空归属列：

```text
provider_raw
billing_source
billing_mode
pricing_basis
evidence_basis
normalization_version
route_evidence_id
attribution_version
```

v0.12/schema v4 再新增：

```text
billing_template_id
```

`provider_id` 保持规范化 provider。`provider_raw` 与 `provider_id` 不得折叠为
同一列；`billing_source` 也不得再作为 `provider_id` 的无损替代。

`route_evidence_id` 可引用可选审计表：

```text
route_evidence(
  evidence_id PRIMARY KEY,
  harness,
  machine_namespace,
  native_session_id NULL,
  provider_raw NULL,
  endpoint_host NULL,
  account_ref NULL,
  plan_type NULL,
  quota_window NULL,
  evidence_basis,
  observed_at_ms NULL,
  source_id NULL,
  ingested_run_id
)
```

不需要审计 endpoint 的执行环境可以只填事实列；一条 current-config evidence 可以被
多条事实引用，避免为每个 token event 重复保存配置内容。

Provider catalog 与模板在 v0.12 必须快照化：

```text
provider_catalog_snapshots(
  catalog_version PRIMARY KEY,
  source,
  captured_at_ms,
  payload_json
)
```

事实从 v0.11 起保存 `attribution_version`；v0.12 再保存
`billing_template_id`。这样历史归属可以复算，但当前 catalog 更新不得静默
改写已落库结论。

写入规则：

- 首次写入完整保存 UsageFact 字段。
- 同 fact_id 重放允许从 NULL 补齐 evidence 字段。
- 已有非空原生证据不得被 current-config fallback 覆盖。
- 非空值冲突写 `data_quality_issues`，保留较强 evidence；禁止静默 last-write-wins。
- Safe view、private export、Trace 和 Session detail 必须包含新增列。
- Redacted export 可脱敏 account/endpoint，但不得删除 billing basis。
- Provider/billing/evidence 字段不属于 fact_id 身份六元组；enrichment 不得改变
  fact_id、token 桶、时间或 source identity。

## 8. 通用查询

Data 层目标接口返回规范化 typed rows：

```text
usage_aggregate(conn, harness_scope, window, dimensions, include_legacy)
active_harnesses(conn, start_ms, end_ms)
```

`dimensions` 第一阶段至少支持 `harness/provider/model/hour/day/event_peak`。返回行：

```text
UsageAggregateRow {
  harness,
  provider_id?,
  model_id?,
  time_bucket?,
  event_peak?,
  uncached_input_tokens,
  cache_read_tokens,
  cache_write_tokens,
  output_tokens
}
```

现有 `facts_by_hour_model_provider` 是过渡实现：SQL 维度是通用的，但返回值仍
生成 Codex `standard`/五桶形状。完成本 spec 后，它应改为上述 typed rows 或
退役。不得新增 `codex_by_hour_provider`、`claude_by_day_provider` 等 provider
专属 SQL。

Codex 的 `standard` speed、五桶命名等下游输入形状应在 harness/runtime
适配函数中生成。Data 只返回 SQL 中真实存在的通用四桶及维度，不生成
`reasoning_output_tokens=0` 或 `speed=standard` 这类执行环境形状。

`sessions_in_window` 默认查询窗口内 `DISTINCT harness`；显式 harness filter 直接作为
查询范围。Capability registry 可以标注能力，但不得隐藏已经存在的事实。

现有 `claude_days`、`claude_legacy_days`、`codex_by_hour_model` 可以在迁移期
保留兼容 wrapper，但其 SQL 与执行环境形状转换应逐步由通用聚合原语替代。

## 9. 成本与 Coverage

### 9.1 Session cost

`session_cost_minor` 必须按：

```text
(provider_id, model_id, event_peak)
```

聚合，并向 Domain 同时传 `by_model` 与 `providers`。同一模型跨 provider
不得合并。若一个 session 内同一模型由多个 provider 提供，应使用内部稳定键
区分桶，展示时再还原 model/provider。

Provider 缺失、provider 无价卡、价格只来自原厂 fallback 时只能返回
`MeteredEstimate` 或 unavailable，并携带 unresolved 原因。

### 9.2 Coverage

Price coverage 必须按 `(provider_id, model_id)` 检查：

- provider 有明确价卡且模型命中，才算 provider-price covered；
- provider 为 NULL 或 `<unknown>`，不算完整 price coverage；
- CogFoundry 模型命中 OpenAI 卡，只能算 fallback estimate，不能算 exact；
- billing attribution coverage 与 price-card coverage 分开计数。

Coverage denominator 变更时必须递增 `denominator_version`。

## 10. Legacy Import

Claude legacy ledger 是执行环境格式，应拆分为：

```text
harnesses::claude_code::sources::legacy_ledger
  -> Vec<UsageFactCandidate> + LegacyCoverageEvidence

runtime migration orchestration
  -> data::import_facts / data_quality_issues
```

Data crate 仅保留通用 legacy fact 写入与冲突处理，不读取
`claude-ledger.json`，不硬编码 `LEGACY_HARNESS="claude-code"`。

历史 ledger 没有 provider 证据时，写入 NULL/unknown 和明确
`evidence_basis=legacy-aggregate`；不得由模型名回填 Anthropic、DeepSeek
或其他 provider。

## 11. Schema 与版本协调

Authority schema 按现有版本地图拆分：

| 产品版本 | Authority schema | 内容 |
|---|---|---|
| v0.11.0 | v2 → v3 | Provider evidence、归属字段、route evidence、Issue state |
| v0.12.0 | v3 → v4 | Billing templates、catalog snapshots、价格与 Savings measurement |

这与 Value Loop 的风险边界一致：v0.11 回答“事实属于谁、证据是否足够”；
v0.12 才回答“按什么合同计费、金额是多少、能节省多少”。

### 11.1 v0.11 Schema v3

`usage_facts` 新增：

```text
provider_raw
billing_source
billing_mode
pricing_basis
evidence_basis
normalization_version
route_evidence_id
attribution_version
```

同时新增 `route_evidence` 和 v0.11 Issue tables。`billing_template_id` 在 v0.11
保持 NULL 或不落列，避免尚未实现模板系统时产生半成品合同。

### 11.2 v0.12 Schema v4

新增：

```text
provider_catalog_snapshots
billing_templates / billing_template_snapshots
usage_facts.billing_template_id
pricing snapshot extensions
OutcomeMeasurement / Savings entities
```

Schema v4 才允许模板、倍率、quota 和价格参与金额计算。

共同迁移要求：

- 新列 nullable，不批量猜测历史 provider。
- migration 在单一事务内创建列、表和索引。
- parser version 递增，重放可恢复 evidence 的 source files。
- 迁移记录 run、parser version、补齐数、冲突数和 unresolved 数。
- 迁移前后 token 四桶总量、fact 数和 fact_id 必须守恒；仅允许 evidence
  字段被 enrichment。

## 12. v0.11.0 Iteration: Provider Evidence

### 12.1 目标

v0.11 只建立可靠归属，不承诺新的金额能力：

- 能回答事实经过哪个 provider；
- 能区分原生证据、current hint 和 unknown；
- Issues、Trace 和 Session detail 可以展示归属及证据缺口；
- 错误归属宁可降级为 unknown/unresolved，也不能生成错误金额。

### 12.2 范围

1. 创建 `agent-vitals-provider` crate 的最小骨架、ProviderId、endpoint matcher、
   EvidenceStrength 和 attribution resolver。
2. 将 Codex route config 读取迁到 Codex source adapter。
3. Claude adapter 补充可获得的 route evidence；DSH 统一走 resolver。
4. 移除 Adapter/Runtime 中直接判定 subscription/metered 的代码。
5. 完成 schema v3、writer enrichment、safe view、private/redacted export。
6. 修复 `coverage_status`，拆分 attribution coverage 与 price coverage。
7. 修复 `sessions_in_window` 固定执行环境列表。
8. 将 Claude legacy 文件解释移出 data；无证据历史保持 unknown。
9. 重放三执行环境事实并输出归属/冲突审计报告。

### 12.3 非范围

- 不执行 provider quota/balance HTTP probe；
- 不应用 cost multiplier；
- 不根据 Token Plan 或订阅模板计算金额；
- 不把 catalog fallback 计入 actual spend；
- 不实现 Savings/OutcomeMeasurement。

### 12.4 发布门槛

- 显式 OpenAI 与 CogFoundry 事实分开；
- unknown 历史事实不再并入 OpenAI；
- Issues/Trace 可显示 provider evidence basis；
- provider 缺失不会让 usage 消失；
- schema v3 与 Issue migration 在同一升级路径完成；
- 所有现有金额若证据不足，降级为 estimate/unavailable。

## 13. v0.12.0 Iteration: Billing Templates & Cost

### 13.1 目标

v0.12 在 v0.11 可靠归属之上，回答计费合同与金额：

- 区分 Metered API、Token Plan、Official Subscription、Balance Account、
  Relay Multiplier 和 Custom；
- 可追溯到 catalog/template/pricing/quota/invoice evidence；
- 为 Savings 提供可复算、版本化的成本基础。

### 13.2 范围

1. 完成 Provider catalog、BillingTemplate、PricingPolicy 和 catalog version。
2. 实现 catalog snapshot 与 billing template snapshot。
3. 实现 quota probe descriptor；Runtime 执行已支持 provider 的 probe。
4. 支持 request/response/observed pricing model source。
5. 支持 provider multiplier，但固定标为 estimate，除非账单证据确认。
6. 修复 `session_cost_minor`，按 provider/model/peak 分桶。
7. provider 无价卡时使用明确 fallback estimate 或 unavailable。
8. 将 quota、账单和用户确认绑定到 account/product/effective window。
9. 与 OutcomeMeasurement/Savings schema v4 接线。

### 13.3 非范围

- 不自动抓取所有第三方 provider 的发票；
- 不把当前 quota snapshot 反推到全部历史；
- 不因模板名称含“订阅”就认定 session 被订阅覆盖；
- 不允许跨币直接汇总；
- 不允许 estimate 进入 actual/realized savings。

### 13.4 发布门槛

- 同一模型跨 provider 的成本不合并；
- Token Plan 和 Official Subscription 的额度状态可区分；
- multiplier、fallback card、用户输入价格均标明来源；
- catalog 或价格更新创建新版本，不覆盖历史计算；
- Savings 的每个金额可追溯到 fact set、template、pricing snapshot 和算法版本。

## 14. Acceptance Criteria

- Data dependency guard 继续禁止依赖 harnesses/runtime。
- Provider crate 只能依赖 Domain、Serde 和纯解析依赖；不得依赖 Data/Runtime/App。
- Harness I/O 只存在于 `harnesses/*/sources` 或既有允许目录。
- Python/Rust emitter 对显式输入 evidence 保持字节级一致。
- OpenAI 官方 session 不因当前 custom endpoint 被覆盖。
- CogFoundry 独立显示；无供应商价卡时为 estimate/unresolved。
- 同一模型跨 provider 的 session cost 不合并。
- `coverage_status` 不再从模型名单独认定 provider-price covered。
- provider 缺失的历史事实仍可查询，并显示 `<unknown>`。
- 新增测试执行环境无需修改 data 查询代码即可进入 sessions/provider 聚合。
- Private export 可重建 provider/billing evidence，不再声明这些字段只能回原始日志取证。
- 覆盖 migration、duplicate enrichment、evidence conflict、malformed input、
  golden parity、query plan 和跨 provider 守恒测试。

## 15. Required Test Matrix

| 测试 | 必须证明 |
|---|---|
| Adapter route evidence | session-native 优先于 current config |
| Domain attribution table | official/custom/unknown/conflict 每格 basis 正确 |
| SQL migration | v2 数据无损升级，新增列为 NULL |
| Duplicate enrichment | 同 fact_id 只补强 evidence，不重复 token |
| Evidence conflict | 同强度冲突产生 quality issue |
| Cross-provider session | 同模型不同 provider 不合桶 |
| Coverage | fallback card 不算 exact provider coverage |
| Harness extensibility | 新 harness 无需修改 data hardcoded 列表 |
| Private/redacted export | basis 保留，敏感 endpoint/account 按路径脱敏 |
| Python/Rust parity | 显式 evidence 输入产生相同 UsageFact |
| Template classification | Metered/TokenPlan/Subscription/Balance/Relay 不混淆 |
| Catalog replay | catalog 更新不改写历史 attribution |
| Probe isolation | probe 失败只降低 evidence，不删除 usage |
