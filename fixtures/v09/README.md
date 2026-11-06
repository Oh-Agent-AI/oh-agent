# fixtures/v09 — 四执行环境最小接入契约语料（v0.9 Stage 0.7）

对应 `docs/AGENT_VITALS_V0_9_DATA_VALUE_ARCHITECTURE_SPEC.md` §3.3「最小执行环境
接入契约」表。每个执行环境一份最小 fixture + 声明现状；守卫测试
`tests/test_v09_onboarding_fixtures.py` 用它们驱动真实二进制的
`data coverage`（v0.9 Stage 0.5 的 Data Query API 面）逐执行环境对账 basis、
freshness、coverage 与 excluded_harnesses。

**日期占位**：所有 fixture 里的日期都是占位（`1970-01-01`），测试写入时替换
成查询月的真实日键——fixture 本身不携带时钟，同一份语料任何月份都能复放。

| 执行环境 | fixture | 过 Data Query API 后的 basis | 断言要点 |
|---|---|---|---|
| DSH | `dsh/month-day.json` | `metered_actual`（官方逐 token 真实费率） | 计入 `total_summable`；字段词表是 DSH 四桶 + `peak_*`，**不是** Claude 的 4 型 snake |
| Claude Code | `claude-code/ledger-day.json` | CNY 卡 → `metered_estimate`；USD 目录卡 → `api_equivalent` | 两个 basis 都**不**计入总额；`<synthetic>` 全零桶不计价不报错 |
| Codex | `codex/rollout-minimal.jsonl` | `api_equivalent`（订阅套餐的等价 API 标价，只作诊断） | 不计入总额；月过滤后重算 by_model（merge 的 by_model 不读小时轴） |
| WorkBuddy | `workbuddy/EXCLUDED.md` | —（无 basis：不进 `by_harness`） | **声明但排除**：capability 注册表里有它的行（`harnesses --json`），但 `session_store=false`/`fold=null`，且永久在 summary 的 `excluded_harnesses`（用户 2026-09-05 决定，Stage 0 不接任何真实数据源） |

## §3.3 七行交付物 × 四执行环境（v0.9 Stage 0 现状）

| 交付物 | DSH | Claude Code | Codex | WorkBuddy |
|---|---|---|---|---|
| Source descriptor | ✅ `sessions::discovery`（runtime） | ✅ harnesses `<h>/sources`（feature 门控） | ✅ `codex_rollout_files`（live+archived 全局排序） | ✅ harnesses `workbuddy/sources`（sqlite 读取在，**不接**） |
| CanonicalSession | ✅ evidence 链 | ✅ `claude_evidence` | ✅ `codex_evidence`（19 信号） | ✅ evidence + 会话审计在（独立于 summary 面） |
| UsageObservation | ✅ 8 桶 fold | ✅ ledger 4 型 snake | ✅ 5 桶 fold（`last_token_usage`） | ❌ 用户决定不接 |
| UsageFact | ✅ `dsh_usage_fact` | ✅ `claude_usage_fact` | ✅ `codex_usage_fact` | ❌ 同上（WorkBuddy 排除在这整条线外） |
| HarnessBillRecord | ❌ Stage B | ❌ Stage B（订阅费无本机声明来源，不编 FixedSubscription） | ❌ Stage B（同左） | ⚠️ credit_json 是真实执行环境账单形状，但 v0.9 明确不接 |
| Coverage | ✅ 19 信号 + summary 分母 v1 | ✅ 同左 | ✅ 同左 | —（excluded，不产 coverage） |
| Capability | ✅ `harnesses --json` 注册表 | ✅ 同左 | ✅ 同左 | ✅ **声明在册**（`unmeasured_signals`/`degraded_rules` 齐全）但 summary 排除 |

「声明但排除」是 WorkBuddy 行的全部要求：capability 注册表（声明面）与
SummaryRepository 的 `excluded_harnesses`（数据面）各自成立、互不冒充——注册表
说"这台机器认识这个执行环境"，summary 说"本版本不从它取数"。两者必须同时断言，
只断言其中一半就会让"忘记接线"和"决定不接"混成一团。
