# WorkBuddy Phase A：口径与时间轴修复

> 状态：待实施。本文从 [WORKBUDDY_ONBOARDING_SPEC.md](./WORKBUDDY_ONBOARDING_SPEC.md) 拆出，可独立交付；若本文与总规格冲突，以总规格为准。

## 目标

修复已存在 `workbuddy-session` 输出的两项真实性缺陷，并让 fixture 成为真机数据形状的有效代理：

1. 不再把 WorkBuddy credit（积分）作为人民币 `cny` 输出。
2. 正确解析真机 SQLite/audit log 的 epoch-ms 时间戳，使会话日期范围可用。
3. fixture 的列类型、时间戳类型和 credit 数值量级与真机一致。

本阶段不接 SQL authority、不改 `FACT_HARNESSES`、不让 WorkBuddy 进入统一 sessions/金额/预算视图。

## 已核实的输入事实

- 真机 `sessions.created_at`、`sessions.updated_at` 和 audit log `timestamp` 都是 epoch-ms 数字；现有只接受 ISO 字符串的实现让 `date_span` 恒为 `null`。
- `credit_json` 的值是积分，不是现金。公开加量包换算依据为 `1,000 credit = ¥50`（自 2026-07-01）；它只能产生名义成本，不是实付证据。
- 真机会话可跨北京日；不能以会话更新时间替代逐请求时间。

## 输出契约

积分会话的 `cost` 对象必须为：

```json
{
  "tokens": 133966,
  "credits": 1763.88,
  "cash_cny": null,
  "nominal_cny": 88.19,
  "nominal_basis": "pack-price-public:1000cr=50CNY@2026-07-01",
  "harness_billed": true
}
```

- `credits` 是 `credit_json` 的积分和，保留既有按厘累计规则。
- `cash_cny` 恒为 `null`：本机没有付款证据；不得填 `0`。
- `nominal_cny = credits × 0.05`，只表示公开兑换价下的名义成本；不得进入实付、预算分子或自动生成账单。
- 非积分轨会话可输出 `credits: 0.0`、`nominal_cny: 0.0`，但须以 notes 说明用户自配 API 的真实成本在本机不可观测。
- `credits` 为零且 `used` 缺失时，整个 `cost` 保持 `null`。
- 旧 `cny` 键必须消失；Rust/Python 的 JSON 键序一致。

## 时间戳契约

三处输入（audit log、`sessions.created_at`、`sessions.updated_at`）统一按以下规则归一：

1. 字符串：沿用现有 ISO 解析。
2. 整数或浮点：按 epoch-ms 解析，标准化为 UTC `YYYY-MM-DDTHH:MM:SSZ`。
3. 结果在 `2000-01-01T00:00:00Z` 至 `now + 24h` 之外：返回 `null` 并计入 `attempts`。
4. bool、null、对象及其他类型：返回 `null`。

不得根据位数猜测秒或毫秒；该执行环境的已知事实只有毫秒。归一后的 ISO 串可按字典序排序。

## 实施项

1. 更新 `fixtures/workbuddy/build_workbuddy_fixture.py`：`sessions` 的 `created_at`/`updated_at` 用 INTEGER，`session_usage` 含 `updated_at`，audit log timestamp 使用 epoch-ms 整数，credit 调整到真机量级；同步 builder 自校验。
2. 在 Rust `harnesses/workbuddy/sources/mod.rs` 与对应 Python 镜像中实现相同的时间戳归一，并接入 `date_span_of` 与会话元数据。
3. 在 Rust/Python 的 `cost_of` 实现新成本对象，删除含义错误的 `cny`。
4. 重新冻结六条既有 Rust/Python 差分输出，并新增针对整数、越界、错误货币键和实付隔离的回归。
5. 勘误 [WORKBUDDY_INTEGRATION.md](./WORKBUDDY_INTEGRATION.md)：`credit_json` 明确为 credit；更新总量、成本对象和对本文件的引用。

## 验收与门禁

- 真机 `workbuddy-session --list` 的日期列不再全为 `-`。
- 真机 top-credit 会话的 JSON 符合上方成本对象；`cash_cny` 为 `null`，`nominal_cny` 精确到分。
- fixture 的 schema/type/量级满足本文件输入事实；六条既有差分在新 fixture 上逐字节一致。
- 回归覆盖：整数时间戳可解析、越界值为空且计 attempts、`cny` 不出现、`nominal_cny` 不进入任何实付 DTO。
- 运行受影响 Rust/Python 测试、完整 Python suite、golden、Rust release tests、clippy，以及 Rust/Python parity；不以更新快照掩盖契约变化。

## 明确不做

- 不新增 `BillingBasis` 枚举值。
- 不动 `assets/pricing.json`，不写入自动账单。
- 不接统一会话、SQL authority、日历、by_harness、by_provider 或预算。
- 不修改待删除的 `r2a_store.rs`，不重建 wasm，不碰 DSH tab，也不用 traces 猜会话。
