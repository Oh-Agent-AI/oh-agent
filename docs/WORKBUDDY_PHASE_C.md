# WorkBuddy Phase C：名义成本与真实账单

> 状态：分两部分处理。名义栏依赖 v1.0.0 的统一计费声明合同；真实账单已有手工录入通路，只有用户提供付款证据时才写入。

## 目标与口径

WorkBuddy 的积分、名义价值、实际支付与用户自配 API 使用是不同量，绝不相加：

| 栏位 | WorkBuddy 处理 |
| --- | --- |
| 名义成本 | `credits × ¥0.05`；当前真机基线为 ¥215.39 |
| 按量实付 | 不由 credit 推导；没有付款证据时未知 |
| 固定订阅 | 用户提供 WorkBuddy/CodeBuddy 账单后录入，与 credit 数无关 |
| 未计价 token | 自配 API 轨的 token，成本在本机不可见 |

名义单位成本只以积分轨 token 为分母：`¥215.39 / 1,109,007 = ¥194.2/M tokens`。不得将非积分轨 token 纳入分母；那会把结果稀释约 46%。名义与实际的比值在实际付款缺失时无定义，不得显示无穷大或“省了 N 倍”。

## C1：名义栏（后续实现）

前置条件：v1.0.0 的公共价目、用户计费声明、实际付款、预算、原始事实与派生估算已按独立模型建立，且版本化重算可用。

实现要求：

1. 在名义成本视图并列展示 WorkBuddy credit 兑换的名义值及 basis/date。
2. 不把它并入可求和的实付总额、`metered_spend` 或预算分子。
3. 将积分轨覆盖范围和自配 API 未计价 token 同时呈现，避免把不可观测误写为免费。
4. 维持与其它执行环境“并列可比较、不跨量尺合计”的展示。

验收：名义金额可追溯到 basis；实付/预算 DTO 没有从 credit 推导的金额；缺支付证据时没有倍数结论。

## C2：真实现金账单（现有手工通路）

只有用户提供收据、账期或明确付款声明时，才能录入 `harness_bills`。示例：

```bash
# 实际购买的 credit
agent-vitals data-harness-bill set --harness workbuddy --provider workbuddy \
  --month 2026-08 --basis harness_billed --amount-minor <分> --currency CNY \
  --evidence-ref "receipt:<订单号>"

# WorkBuddy/CodeBuddy 订阅月费
agent-vitals data-harness-bill set --harness workbuddy --provider workbuddy \
  --month 2026-08 --basis fixed_subscription --amount-minor <分> --currency CNY \
  --evidence-ref "subscription:<账期>"
```

录入前必须确认 WorkBuddy 已从金额面排除名单中按设计移除，并同步调整约束测试；否则系统应拒绝“排除执行环境同时贡献数据”的矛盾状态。

## 守则

- 系统永不从 `credits × 0.05` 自动创建 harness bill。
- 合同、账单、付款与积分兑换价分别存储，不允许同一金额多处维护。
- 不修改 `assets/pricing.json` 存放个人账单或套餐。
- 输入不完整时保留未知/未计价，不归零。
