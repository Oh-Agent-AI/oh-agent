# Agent Vitals v0.11.0 Final Spec

状态：最终收口规范（以本文件为验收基线）
日期：2026-09-10
范围：SQL 权威数据、provider/billing 归因、成本估算、Data MCP、桌面控制台、价格快照与发布物

## 1. 最终目标

v0.11.0 必须让 MCP、CLI、桌面控制台和菜单栏对同一批 SQL 权威事实使用同一套 provider/billing/price 语义：

1. 能确认官方订阅的，标记 `subscription`，不虚构逐 token 账单。
2. provider、路由或订阅/按量模式无法确认的，必须默认 `metered_estimate`。
3. `metered_estimate` 必须使用匹配模型的原厂按量价格计算；provider 不明不能阻止模型匹配价格。
4. 价格缺失只能返回 `unpriced`/`partial` 和原因，不能返回 0 冒充免费。
5. 所有金额必须保留币种、价格版本、计费依据和证据状态；不同币种不得直接相加。
6. 事实、价格和账单必须来自 SQL authority；legacy JSON、ledger、旧 fold 不得进入产品读路径。

## 2. 数据与归因合同

### 2.1 权威事实

- 唯一产品读源：`agent-vitals.sqlite3` 的 `usage_facts`、`sessions`、`pricing_snapshots`、`harness_bills`。
- token 守恒：`uncached_input + cache_read + cache_write + output = total`。
- 重复事实按 `fact_id` 去重；重放不得改变事实数量或 token 合计。
- 观察不到的事实必须保留为缺失/未解析状态，不得静默丢弃。

### 2.2 Provider 与 billing

优先级：session/event 原生证据 > 时间绑定账户/endpoint 证据 > 当前配置/env > provider 声明 > unknown fallback。

归因结果必须包含：

```text
provider_id?
provider_raw?
billing_source?
billing_mode: subscription | metered | unknown
pricing_basis: provider | fallback | metered_estimate | subscription | unavailable
evidence_basis
has_unresolved
unresolved_reason?
```

规则：

- 只有明确官方订阅证据可以是 `subscription`。
- unknown、冲突、第三方网关、缺失路由证据统一为 `metered + has_unresolved=true`。
- unknown 不等于免费；必须尝试按原厂价格估算。
- 模型名只能匹配价格，不能覆盖事实中的 provider。

## 3. 统一价格体系

### 3.1 单一逻辑价格快照

`assets/pricing.json` 与 `assets/codex_pricing.json` 可以暂时作为兼容源文件，但产品运行时必须合并为一个版本化价格快照：

```text
pricing_snapshot {
  pricing_version
  captured_at
  valid_from?
  source_kind: official | reviewed_import | user_configured
  currency / fx
  providers
  models
  billing_modes
  subscriptions
}
```

价格匹配键为：

```text
(harness, provider_id?, raw_model, normalized_model, billing_basis)
```

### 3.2 价格来源与更新

- 首选原厂官方价格页/API。
- 第三方聚合站只能做发现和交叉校验，不能直接成为账单权威。
- 自动同步必须生成新快照，不覆盖旧快照。
- 每次更新必须记录来源、抓取时间、版本/hash、变更摘要和校验结果。
- 自动同步失败时继续使用最近有效快照，并显式报告 stale。
- 价格变化超过阈值或模型被删除时进入待审核，不自动替换生产价格。

### 3.3 价格缺失

- Codex unknown：去除路由前缀后使用对应 Codex 原厂按量卡。
- Claude/GLM unknown：使用 GLM 原厂 pay-as-you-go 卡；订阅月费不得替代按量价格。
- 仍无价格卡时：金额为 `unavailable`，token 必须进入 `unpriced_tokens`，并带 `no-price-card`，绝不能输出 0。

## 4. 成本计算合同

统一成本引擎必须覆盖：

- uncached input
- cache read
- cache write
- output
- peak/off-peak（价格卡支持时）
- 原厂币种
- `metered_estimate` 与 `subscription` 分离

成本输出使用精确金额结构：

```json
{
  "amount_minor": 72847,
  "currency": "CNY",
  "basis": "metered_estimate",
  "pricing_versions": ["..."],
  "pricing_source": "official",
  "has_unresolved": true
}
```

`MCP`、`CLI`、`Tauri` 必须逐值使用同一个成本投影，不能各自把 `f64` 或 USD 再转换一次。

## 5. MCP 合同

### 5.1 必须保留的工具

- `data_status`
- `usage_hourly`
- `sessions_search`
- `session_detail`
- `session_trace`

### 5.2 成本路径收口

公开 MCP 不再直接走 `session_cost_minor → pricing.json → cost_report` 的旧调用链；统一入口是
`session_cost_view`。内部可以保留 `session_cost_minor` 作为兼容/复用 helper，但它只能读取
SQL 的历史 `pricing_snapshots`，不得回读 `pricing.json`。

`sessions_search` 和 `session_detail` 的 `cost_minor` 必须调用统一成本引擎，并满足：

- Codex unknown 产生 `metered_estimate`；
- GLM unknown 产生按量估算或明确 `no-price-card`；
- 不能出现“有 token、cost 为 0/null 但无原因”；
- 无价格时返回 unavailable，不得伪装为零。

兼容字段 `cost_minor` 允许为空，但同级必须返回：

```json
{
  "cost_status": {
    "state": "estimated | subscription | unpriced | unavailable",
    "reason": "stable-machine-readable-code",
    "has_unresolved": true,
    "pricing_versions": ["..." ]
  }
}
```

有金额时，`cost_minor` 还必须携带 `pricing_versions`、`pricing_source`、
`evidence_basis` 和 `has_unresolved`。订阅用量的 `cost_minor` 为 null 是合法的，
但 `cost_status.state=subscription` 且原因必须明确说明“无逐 token 账单”；缺价卡
和无快照分别使用 `unpriced/no-price-card` 与 `unavailable/no-pricing-snapshot`。

### 5.3 MCP 状态

`data_status` 必须同时报告：

- authority health
- 每个 harness 的 coverage/freshness
- pricing snapshot 数量、最新版本和 stale 状态
- unresolved token 数量
- unpriced token 数量
- open data-quality issues 及严重等级

## 6. 控制台与菜单栏

### 6.1 数据源

- 工作台总览、日汇总、月汇总、日历和菜单栏全部读取 SQL authority。
- 不再读取 `month.json`、`today.json`、Claude ledger 或旧 fold 作为产品数字来源。

### 6.2 展示规则

- `by_provider` 必须展示 `metered_estimate`，包括 Codex unknown。
- unresolved estimate 不进入 confirmed/summable actual spend，但必须显示在估算分栏。
- 订阅月费单独展示，不与按量 token 成本混成一个“实际扣费”。
- 缺价格显示“未计价 + 原因”，不显示 0 元。
- 跨币种只分币展示；速览层如需合并，必须标 `≈` 并保留原始币种明细。
- 估算值必须显示价格版本、来源和更新时间。

### 6.3 当前已验证的 2026-09-09 基线

- 总 token：529,004,854。
- Codex unknown：293,376,049 tokens，当前应估算为 `$101.8839`，按 7.15 汇率约 `¥728.47`。
- Claude/GLM unknown：12,696,803 tokens，当前缺少原厂按量卡，必须显示为未计价缺口。

## 7. 数据质量与覆盖

以下状态必须进入总览告警，而不是只写日志：

- DSH stale/missing：对应日期显示 coverage partial/unavailable。
- `invalid_fact` 或其他开放质量问题：显示数量、影响执行环境和影响 token。
- provider unknown/conflict：显示 unresolved token 和估算金额。
- 价格快照过期或缺失：显示 pricing stale/unavailable。

当前真机已发现的收口问题：

1. DSH 数据源 stale，9 月 9 日没有可靠 DSH 覆盖。
2. authority 中存在大量 `invalid_fact` 开放质量问题，健康结论不能只显示 `ok`。
3. 当前只有一份价格快照，无法证明自动价格更新和历史版本链路。

## 8. 发布与版本

v0.11.0 发布前必须：

- 更新 Cargo/Tauri/App 的版本号为 `0.11.0`。
- 创建 `v0.11.0` tag。
- 重新构建、安装并运行 App。
- 记录安装包路径、构建 commit、价格快照版本和 authority revision。
- 包含回归报告：Python、Rust、golden、clippy、MCP、控制台三方金额 parity。

## 9. 硬性验收项

以下任一项失败，v0.11.0 不得宣称完成：

1. unknown token 没有按原厂按量价估算或明确记录 no-price-card。
2. MCP、CLI、Tauri 对同一窗口的 token、金额、币种、basis 不一致。
3. unresolved estimate 被计入 confirmed actual spend。
4. 任一缺失价格/缺失事实被输出为 0 且无告警。
5. 两套价格文件产生不同金额，或价格版本无法追溯。
6. 历史查询使用当前价格覆盖历史价格。
7. stale harness、invalid facts 或 unpriced tokens 未在总览中可见。
8. 发布物版本不是 `0.11.0`，或未能从干净构建复现。

## 10. 当前实现状态（2026-09-10）

已完成并有测试/构建证据的项目：

1. provider、billing 和 unknown 路由降级规则已进入 SQL authority。
2. 两份兼容源价表已在运行时合并为带指纹的 `pricing_snapshots`，历史快照保持不可变。
3. MCP `sessions_search/session_detail.cost_minor`、CLI/Tauri 共享 domain metered estimate；Codex unknown 使用 USD 原厂卡，Claude 使用原生 token 字段。
4. `data_status` 报告 pricing snapshot、stale、unresolved token、unpriced token，并由控制台显示质量告警。
5. App 版本、bundle、安装运行和验证脚本已对齐 `0.11.0`；当前安装路径为 `/Applications/agent-vitals.app`，本次构建提交为 `1c811d8`。
6. workspace Rust、desktop Rust、Python、golden、Clippy 和 JS 语法检查通过。

仍不得宣称“所有硬性验收项完成”的项目：

1. 尚未实现从官方价格页/API 自动抓取、变更审核和失败回退的联网同步器；当前快照来源仍为 `embedded-assets`。
2. GLM 原厂 pay-as-you-go 价卡尚未取得可复核的官方输入/缓存/输出费率，因此 GLM unknown 必须继续显示 `unpriced/no-price-card`，不得借用其他模型价格。
3. 现有本地 `v0.11.0` annotated tag 仍指向旧提交 `72fa1be`，未包含本次 `main` 收口提交 `1c811d8`；在明确是否允许移动已有发布 tag 前，不能把 tag 视为最终发布记录。
4. 真机中的 DSH stale 和既有 `invalid_fact` 必须继续在总览中显示为 partial/quality warning，不能以安装包成功掩盖。

因此，当前准确结论是：**v0.11.0 核心实现和已安装发布包已完成；价格自动同步、GLM 原厂价卡以及现有 tag 与最终提交对齐仍未完成，不能把当前状态宣称为完整发布闭环。**
