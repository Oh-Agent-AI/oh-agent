# WorkBuddy Phase B：统一会话面决策

> 状态：默认延期。本文从 [WORKBUDDY_ONBOARDING_SPEC.md](./WORKBUDDY_ONBOARDING_SPEC.md) 拆出；实施路径需在重新评估活跃用量后决定。

## 决策

当前选择路径 2：保留 `workbuddy-session` 独立子命令，不接入统一 `sessions list/read`。

原因是 WorkBuddy 当前语料已停止增长，只有 22 个历史会话；逐 requestId 的 audit 时间戳 join 率为 64%，预计只有 10 个会话能在统一时间窗中出现，且 token 总量必须诚实显示为 0、按 token 排序沉底。这个收益不足以抵消扩展 `FACT_HARNESSES`、新 observation kind 及逐消费面排除审计的成本。

重新开启本阶段的触发条件：WorkBuddy 恢复活跃使用，且统一会话面的发现价值大于维护成本。Phase A 全部验收通过是硬前置。

## 架构事实

统一 `sessions list/read` 来源于 authority SQLite 的 `usage_facts` 时间窗 GROUP BY，而非旧 `SessionStore`。会话必须具有至少一条：

- 非 `legacy_aggregate` 的 UsageFact；
- 非空 `session_key`；
- 非空 `event_ts_ms`。

因此不能通过在待删除的 `r2a_store.rs` 新增 WorkBuddy 分支达成目标，也不能先“接会话、以后再接 facts”。

## 如被批准实施：路径 1

粒度为每个 `credit_json.requestId` 一条 UsageFact，而非每会话一条。会话可跨 13 天，按会话更新时间归因会伪造日历分布。

| 字段 | 值 |
| --- | --- |
| `harness` | `workbuddy` |
| `native_session_id` | `sessions.id` |
| `source_event_id` | requestId |
| `observation_kind` | 新值 `harness-credit-entry` |
| `event_ts_utc` | 同 requestId audit record 的最早时间；不可 join 则 null |
| `time_basis` | 有时间时 `native`，否则 null |
| 四个 token 桶 | 全部 0 |
| `amount_decimal` / `amount_basis` | credits / `harness_billed` |
| `source_usage_semantics` | 明示执行环境原生粒度 |

四桶均为 0 表达“执行环境不报告分桶”，不是 token 测量。无时间戳的事实仍入库、可在状态计数中查询，但不进入时间窗会话查询。不得用会话级 `used` 填充任何桶，也不得伪造会话回退时间。

## 实施范围

1. 将 WorkBuddy 加入 facts 导入注册表，建立幂等 requestId source identity。
2. 实现 audit requestId 到最早时间戳的关联；未命中时保留 null 时间。
3. 增加 `harness-credit-entry` 的解析、持久化、重放与状态计数。
4. 逐一审计 summary、日历、token DTO、provider/harness 汇总、MCP 和桌面消费方：WorkBuddy 的 facts 不能使 token DTO 显示“测得为 0”，也不能意外进入金额/预算面。
5. 保持另外三执行环境输出不变。

## 验收

- `sessions list --harness-kind workbuddy --day <有数据日>` 显示有 timestamp 的 WorkBuddy 会话，token 为 0 且排序沉底。
- 其他三执行环境的会话输出逐字节不变。
- `tokens_by_harness` 没有 `workbuddy`；`monthly_summary.excluded_harnesses` 仍含它。
- 无 timestamp 的事实可通过 data status 查到，但不进入任何时间窗查询。
- `data-reimport-verify` 证明重放幂等；覆盖 join、无 join、跨日和 source identity。

## 明确不做

- 不在 `r2a_store.rs` 加代码。
- 不把会话级 `used` 拆到四个 token 桶。
- 不因接入事实就推导真实现金、预算支出或自动账单。
