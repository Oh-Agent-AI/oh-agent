# Agent Vitals v0.11.0 Implementation Addendum

状态：实施锁定（2026-09-09）

本文是 v0.11.0 两份规格的实施补充，不扩大版本范围。若与主规格冲突，以本文对下列歧义的明确化为准。

## 1. Provider identity 与 Billing catalog 分界

v0.11 允许一个不可变、纯身份用途的 endpoint/provider normalization catalog，至少包含
OpenAI、CogFoundry 和 unknown 的 endpoint matcher。它只回答“事实归属哪个 provider”，不包含
价格、quota、billing template 或 subscription 合同。可版本化的 billing catalog、模板和价格快照属于 v0.12。

## 2. Billing 字段词表

`billing_mode` 只允许 `subscription | metered | unknown`。`metered_estimate` 是
`pricing_basis`，不是 billing mode。Custom endpoint、证据缺失或冲突的结果固定为：

```text
billing_mode=metered
pricing_basis=metered_estimate
has_unresolved=true
```

## 3. Route evidence 可追溯性

事实必须保存 `evidence_basis`，但 `route_evidence_id` 可为空。只要存在可绑定的 route evidence，
就必须写入 `route_evidence` 并由事实引用；没有可绑定历史 route 时只能使用
`config-current`/`route-config-fallback` 等明确 basis，不得伪装成 session-native。

## 4. Issue 状态和 reopen

合法迁移为：

```text
open -> acknowledged | closed | wontfix
acknowledged -> closed | wontfix | open
closed -> open       # reopen
wontfix -> open      # reopen
```

Issue 稳定键仍为 `(machine_namespace, issue_type, instance_fingerprint)`。重放同一输入不得创建新 Issue；
每次状态变化必须插入独立 transition，transition 以 `(issue_id, transition_id)` 幂等，时间相同按
`transition_id` 排序。`transition_id` 必须由 canonical transition payload（issue_id、from/to、
evidence fingerprint、evaluator/version、触发输入指纹）确定性派生；禁止每次重放随机生成 UUID。
重复 reopen 输入不得产生重复 transition。

## 5. Remedy candidate

v0.11 使用代码内只读 remedy catalog。每个稳定 Issue 必须有 catalog remedy candidate，或明确
`diagnostic_only=true`。v0.11 不持久化可执行 SQL、Shell、MCP payload，也不创建 v0.12 的
`issue_remedies`/Savings 实体。

## 6. Codex/CogFoundry 验收矩阵

必须覆盖以下固定 fixture：

| session provider | route evidence | 结果 |
|---|---|---|
| `openai` | current CogFoundry config | `provider_id=openai`，session-native，不能被 current hint 覆盖 |
| `custom` | `router.cogfoundry.ai` | `provider_id=cogfoundry.ai`，`metered` + `metered_estimate` + unresolved |
| 缺失 | current CogFoundry config | `route-config-fallback`，不得宣称历史确定归属 |
| 任意 | 同强度 OpenAI/CogFoundry 冲突 | 保留两份 evidence，写 quality issue，不静默覆盖 |

## 7. 金额边界

v0.11 不新增 Savings/OutcomeMeasurement 或新的金额承诺。已有 cost projection 若继续展示，
必须使用 `MeteredEstimate`/unavailable；unknown provider 不得使用原厂价卡冒充 exact。

## 8. 重放审计交付物

重放必须提供可重复命令和机器可读报告（默认 `artifacts/v0.11/provider-replay-report.json`）：

```text
cargo run -p agent-vitals -- data replay-provider-evidence \
  --report artifacts/v0.11/provider-replay-report.json
```

报告不存在、守恒失败或输入不可重放时必须返回非零退出码。报告至少包含：
重放 run、parser version、before/after fact count、fact_id 守恒、四桶 token 总量、provider 分布、
conflict/unresolved 数、恢复的 CogFoundry facts 和无法恢复的 unknown facts。

## 9. 发布前置

v0.10 前台 P0 与 A1–A3 证据是 v0.11 发布门槛；可以先在独立 worktree 实施 v0.11 代码，
但在这些证据完成前不得宣称 v0.11 发布验收通过。
