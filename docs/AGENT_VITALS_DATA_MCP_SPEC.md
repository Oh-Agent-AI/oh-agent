# Agent Vitals Data MCP Spec

> 版本：v0.9.1-draft-4  
> 日期：2026-09-07（draft-4：M0 D1–D10 裁决表 + §5.1.1 `MoneyMinor` 类型定义 + §6.1 行级口径 + §6.4.1 `as_of_run_id` 状态机 + §7.1 `data_status` 完整 JSON Schema + §7.2 `models.kind` 词表 + §9.4 脱敏 allowlist）  
> 状态：M0 退出条件中 D1 已锁定（D1 ack 表 ✅），D2–D10 写明裁决与 owner，等评审逐条 ack；每工具 JSON Schema 在 D10 推进中（增量 1 的 `data_status` 已生成）  
> 依赖：`AGENT_VITALS_V0_9_1_SQL_AUTHORITY_MIGRATION_SPEC.md`（冻结规格） · `AGENT_VITALS_V0_9_1_IMPLEMENTATION_PLAN.md`（Phase 实际进度）  
> 目标版本：v0.9.1 提供内部 MVP；v0.9.2/v0.10 补齐解释能力；达到发布门槛后随 v1.0.0 提供本机只读能力

> **draft-3 变更（第 2 轮评审）**：
> - **P1-1 金额精度**：成本引擎从 `pricing.json` 起是 `f64` 端到端；MCP 不得把展示 `f64` 事后乘回分。改为在 SQL repository 层加统一的精确 `MoneyMinor` 投影，三消费面同源读——§5.1 规则 5、§13 M0 D2、§13 M1。
> - **P1-2 reconcile 职责矛盾**：只读工具无法验证重导入幂等；`export_private` 只导 `usage_facts` 列、撑不起成本三元组对账。拆成 MCP 内只读 `authority_audit` + MCP 外隔离 `reimport_verify`——§8.1、§13 M0 D6、§13 M2。
> - **P1-3 线协议契约**：手写传输层意味着 protocol version / `initialize` / `tools/*` / framing / per-tool schema / error 映射 / 关闭行为必须 M0 冻结——新增 §6.4、§13 M0 D1。
> - **P1-4 M1 工作量**：`summary_daily`/`monthly` 的会话数、活跃小时、维度过滤、逐日趋势、月底预测不在冻结 DTO——§7.3/§7.4 拆「就绪面 vs 新增面」，§7 门槛表降级 🔶，M1 列明新增查询。
> - **P1-5 脱敏绕过**：按结果列名脱敏可被 `AS` / 表达式绕过；改为 SQLite authorizer 按来源表 + 列拒绝，只开脱敏 view + 函数 allowlist——§8.2。
> - **P2-6 快照版本**：envelope 加 `authority_revision`（`last_completed_run_id` / `committed_at` / `max_observed_at`），跨工具严格对账用 snapshot token——§6 envelope、§6.1、§10。
> - **P2-7 `model_ids` 命名**：实际匹配 harness raw name；MVP 改为 `models: [{kind, harness, value}]`，响应回 `identity_kind`——§7.2。
> - 保留 draft-2 全部校正（§5.3 实现现状锚点、§16 决策 8–12）。
>
> **draft-4 变更（M0 冻结补全）**：
> - **§5.1.1 `MoneyMinor` 类型定义**：完整 Rust 风格定义 + JSON 形状 + 舍入规则（最细维度一次 `pyround`、父层 = 子项整数和）+ ISO 4217 → `minor_digits` 映射 + 生产者 / 消费者边界 + M15 三消费面 parity 语义。
> - **§6.1 `authority_revision` 行级口径**：钉死 SQL 过滤（**排除 `observation_kind='legacy_aggregate'`**）+ `as_of_run_id` 状态机（v1 仅识别 + warn，不假装钉截面，假装比 drift 更危险）。
> - **§13 M0 D1–D10 裁决表**：把"倾向"改"裁决 + owner + ack 列"——D1 已锁（增量 1 落地），D2–D10 等评审逐条 ack；表内 ⬜ 全变 ✅ 才进冻结评审。
> - **§7.1 `data_status` 完整 JSON Schema**：`inputSchema` + `outputSchema` 端到端可校验（不仅是字段语义），包括 envelope / `data.*` / `recent_runs[].*` / `by_harness.*` / 业务错误码映射。增量 2/3/4 各自工具也按此形态生成。
> - **§7.2 `models.kind` 词表**：v1 只 `harness_raw`（schema `enum` 强约束），canonical 层未来作为新 `kind` 值加入，不改旧义。
> - **§9.4 脱敏 allowlist 表**：`data_quality_issues.detail_json` 按 `code` 字段级放行/屏蔽（增量 4 落地的契约）。

## 1. 一句话定义

Data MCP 是 Agent Vitals 面向 AI Agent 的**本机、语义稳定的数据与控制面接口**。
默认仍是只读；本地控制面写入必须由用户显式启动 `--allow-local-writes`，且只接受
下文列出的类型化动作。

它让 Agent 能安全回答“今天各模型怎么用、哪个执行环境花得多、哪些问题反复出现、哪些 Skill 需要关注、数据是否可信”等问题，并能自动执行验收；它不是任意 SQL 控制台，也不是新的数据权威层。

## 2. 为什么现在需要它

v0.9.1 正在把运行时读取统一到 SQLite 权威库。仅完成数据库和页面切换，还不足以证明系统真的满足用户需求。Data MCP 在产品界面与数据库之间增加一层稳定、可重复调用的“问题接口”，主要解决四件事：

1. **算得清**：统一模型、供应商、执行环境、币种、计费口径和时间范围。
2. **算得准**：MCP、CLI、桌面端读取同一 SQL repository，可逐值对账。
3. **看得懂**：结果携带覆盖范围、新鲜度、缺失来源和未定价项，不把“不知道”显示成零。
4. **用得上**：Agent 可以直接完成趋势分析、异常定位、成本解释和版本验收。

Data MCP 也是架构的“压力测试面”。当重导入不幂等、数据重复、模型无法归一、价格缺失或来源过期时，它应主动暴露问题，而不是用默认值掩盖问题。

## 3. 用户场景与核心问题

### 3.1 使用节奏

- 今天每个模型的小时分布曲线是什么？峰值发生在几点？
- 今天每个执行环境的小时分布曲线是什么？
- 某个高峰由哪些会话构成？
- 本周与上周相比，使用时间和模型选择发生了什么变化？

### 3.2 成本与预算

- 今天、本月分别花了多少钱？
- 哪个模型、供应商、执行环境贡献了最多成本？
- 成本上升是因为调用更多、换了模型、缓存下降、价格变化，还是录入了执行环境账单？
- 哪些用量无法计价？为什么无法计价？
- 实际账单、API 等价估算、订阅摊销是否被清晰区分？

### 3.3 问题与效率

- 哪些错误、拒绝、重试或重复调用反复出现？
- 哪些问题影响会话最多、浪费 token 最多？
- 哪些 Skill 调用频繁但失败率高？
- 哪些 Skill 缺少足够证据，暂时不能评价？

### 3.4 数据可信度

- 最近一次同步是什么时候？
- 哪些执行环境或日期数据不完整？
- 是否存在重复事实、无法识别的模型、缺失价格或重导入差异？
- 当前结果来自正式 SQL 权威库，还是尚未切换的候选库？

## 4. 产品边界

### 4.1 本版本包含

- 本机 `stdio` MCP server。
- 只读、参数化、面向用户问题的工具。
- 使用、成本、会话、工作流问题和数据质量查询。
- 统一的覆盖度、新鲜度、警告和分页协议。
- MCP 与 CLI、Tauri、SQL repository 的一致性验收。
- 内部开发模式下的迁移对账工具。

### 4.2 本版本不包含

- 公共的任意 SQL 执行。
- 写入、删除、修复、重建或修改 Agent Vitals 数据。
- 原始对话、Prompt、回复正文、工具参数或原始错误文本查询。
- HTTP/SSE 服务、远程访问、云同步或多人共享。
- 外部 MCP server 的安装、配置和健康检查；那属于 v0.8 Phase F，不属于 Data MCP。
- 自动判断任务“成功”或自动下线 Skill；证据不足时必须明确返回未知。
- MCP Resources、Prompts 和批量数据导出；首版只提供 Tools。

## 5. 架构与权威边界

```text
执行环境原始日志
    ↓ 清洗、校验、去重、身份归一
SQLite 权威库
    ↓ 统一 query/repository
Data MCP ── CLI ── Tauri ── HTML
```

### 5.1 不可违反的规则

1. Data MCP 不是新的计算实现。它必须调用 `agent-vitals-data` / `agent-vitals-runtime` 的统一查询与计价能力。
2. 任何 MCP 工具不得读取执行环境原始日志、legacy JSON、JSONL、ledger 或旧 fold。内部 `authority_audit`（§8.1.1）只读 SQL 权威库 + 可选冻结导出快照，也不读 legacy。（重导入验证由 MCP 外的 `reimport_verify` 做，§8.1.2。）
3. Data MCP 不直接写表，不调用同步、迁移、repair 或 harness bill 写接口。
4. 模型与供应商归属走 SQL 权威库**当前实际具备**的解析面：`usage_facts.provider_id` / `model_id`（v0.9.1 仍是执行环境 raw 值）+ `billing_route_of`（`pricing.json::catalog_2026_09.billing_modes` 声明序）。§3.4 的 `models` / `model_aliases` / `pricing_versions` 归一表在 v0.9.1 **未落地**（见 §5.3），canonical ID 是 v0.9.2+ 补强。归一层就绪前，MCP 工具按 `(harness, raw_model, billing_route)` 语义查询与展示；无法解析的项显式 `unresolved`，绝不并入相近拼写。
5. 价格与币种不可跨币种相加、不可把 unresolved 当成 0。MCP envelope 内金额一律 **`MoneyMinor { amount_minor: i64, currency, basis }`**（最小货币单位整数三元组），不复用冻结 DTO（`HarnessAmount.amounts_by_basis`）展示层的 `f64`。

### 5.1.1 `MoneyMinor` 投影定义（spec §5.1 规则 5 + P1-1；M0 D2 裁决）

MCP、CLI、Tauri 三消费面同源读这一个精确投影，不各自换算。下面是落地定义（Rust 风格伪类型，序列化即 spec 字段形状）：

```rust
/// spec §5.1.1 / §13 M0 D2。MCP envelope 与 summary 数据面里的「每一笔金额」
/// 都是这个三元组——金额整数 = 最小货币单位、currency = ISO 4217（CNY / USD / …）、
/// basis = 见 `BillingBasis` 词表（api_equivalent / metered_estimate /
/// metered_actual / harness_billed / fixed_subscription / unresolved）。
///
/// **序列化**：见下表 JSON 形状。
pub struct MoneyMinor {
    pub amount_minor: i64,
    pub currency: String,    // "CNY" / "USD" / ...
    pub basis: BillingBasis,
}
```

```json
{ "amount_minor": 173347, "currency": "CNY", "basis": "metered_actual" }
```

**舍入规则**（一次 `pyround`，与 `budget_status_sql` 的 `pyround(× 100)` 全仓一致）：

- **时机**：在本次查询的最细上报粒度（`cost_breakdown` 到 model；`summary_*` 到 provider）算出每个 `(维度, basis, currency)` 桶的浮点小计后，立刻 `pyround(× 10^minor_digits)`。
- **`minor_digits`** 由 currency 决定：`CNY = 2`、`USD = 2`、`JPY = 0`、其它见 ISO 4217 表。
- **不在父层再做 round**：父层金额 = 子项整数之和（守恒由构造保证，spec §6.2）。
- **单元边界**：每桶只 round 一次；测试夹具必须含恰好落在 `.5` 的输入（银行家舍入验证）。

**生产者**（唯一）：`agent-vitals-data::authority_query` / `agent-vitals-runtime::summary` 新增 `MoneyMinor::from_f64(x, currency, basis) -> Self` 构造函数；调用点 = SQL repository 的所有金额输出路径。

**消费者**：
- MCP envelope `data.<...>.amounts_by_*` / `data.total_*` / `data.by_*[*].amount_minor` 全部 `MoneyMinor` 形状。
- CLI / Tauri 展示金额：保留 `MoneyMinor` 原值显示；多币浮点展示（速览层 `≈¥X`）另起 `fx_estimate` 路径（与 `Overview.fx` 同源），不进主金额字段。

**未计价项**：`amount_minor = null` 或省略字段 + 显式 `basis: "unresolved"`；绝不把 unresolved 写成 0。

**M15 三消费面 parity 语义**：`amount_minor` 整数逐字节相等；`currency` 字符串相等；`basis` 字符串相等。`sum(child.amount_minor) == parent.amount_minor`（同 `currency` + `basis`）。
   **精度落地（P1-1）**：当前成本引擎（`domain::cost`）从 `pricing.json` 的浮点费率起就是 `f64` 端到端，没有整数分路径（唯一例外是 `budget_status_sql` 的分子——它已经 `pyround(浮点小计 × 100)` 得整数分，是本条的既有先例）。因此 MCP **不能**自己把 DTO 的 `f64` 乘回分——舍入点不确定会破坏「算得准」和三消费面逐值一致。必须在 SQL repository 层新增一个统一的 `MoneyMinor` 投影：
   - **舍入规则**：在**本次查询的最细上报维度**（`cost_breakdown` 到 model，`summary_*` 到 provider）对每个 `(维度, basis, currency)` 的浮点小计做一次 `pyround(× 10^minor_digits)`（银行家舍入，与 `pyround` 全仓一致），**父层金额 = 子项整数之和**（不对父层再 round），守恒由构造保证（§6.2）。
   - **落点**：`agent-vitals-data::authority_query` / `agent-vitals-runtime::summary`，**MCP、CLI、Tauri 从同一个精确投影读**，不各自换算。CLI / Tauri 的展示金额也切到 `MoneyMinor.amount_minor / 10^minor_digits`，否则 M15 三消费面 parity 名存实亡。
   - **minor_digits 来自 currency**（CNY / USD = 2）；`unit_tokens` 与费率精度不在此层丢失——费率仍是 `f64`，只有**每维度小计**这一步 round。
   
   这是 M1 的前置（§13 M0 D2 + M1）。
6. 在 SQL 尚未正式成为 runtime authority 时，可以用于内部验收，但每个响应必须标记 `authority_state=candidate`（直接读 `sql_authority::is_enabled(data_home)` 标记文件）。

### 5.2 落点与进程约束

建议落点：

- 协议入口：`agent-vitals data-mcp serve`（clap 子命令 doc 注释必须英文——`test_regressions::test_help_defaults_to_english` 钉住）。
- MCP adapter：`apps/cli` 仅负责 `stdio`、协议编解码和进程生命周期（D1 决定手写还是 `rmcp`）。
- 工具应用层：`agent-vitals-runtime`（唯一同时看得到 `harnesses` 与 `data` 的 crate）。
- SQL 查询、分页与覆盖度：`agent-vitals-data`（依赖预算：只允许 domain + rusqlite，`tests/dependency_budget.rs` 钉边界——新查询进 `authority_query`）。
- DTO 与枚举：复用 `agent_vitals_domain::data_contract`（`MonthlySummary` 等冻结 DTO）；MCP 专属 envelope 是独立版本化的新类型，`schema_version` 与 DTO 版本解耦。

`stdout` 只能输出 MCP 协议消息；日志必须写入 `stderr`。Server 不监听端口。

### 5.3 实现现状锚点（2026-09-07，draft-2 建立 / draft-3 扩充）

Data MCP 的前置是 v0.9.1 SQL 权威迁移。截至本次校正，`AGENT_VITALS_V0_9_1_IMPLEMENTATION_PLAN.md` 的实际进度是：Phase 0–3（schema / 清洗写入 / 读路径切换）已完成，Phase 4（双轨验收与旧路径退役）进行中——4.1/4.2 已收口，4.3 Stage 1（退役 SQL-vs-legacy 对账）已提交，真机翻开关 + 观察期待用户执行。本节钉死 MCP 的可依赖面，避免规格描述超前于代码。

**已落地、MCP 可直接依赖**：

- SQLite 权威库（DDL v1 共 12 表：`schema_meta` / `sync_runs` / `source_files` / `sessions` / `usage_facts` / `harness_bills` / `pricing_snapshots` / `budget_config` / `budget_snoozes` / `data_quality_issues` / `migrations` / `workflow_events`）+ 版本闸 + 中断批次清扫 + `PRAGMA integrity_check`（不自愈，损坏诚实报 critical）。
- `SqlSummaryRepository`（`daily_summary` / `monthly_summary` / `coverage_status`），已是 CLI/Tauri 的运行时读路径（Phase 3.5 Tier A/B 切完）。冻结 DTO：`MonthlySummary` / `DailySummary`（`by_harness` / `by_provider`（键 `"harness/provider"`，单币）/ `tokens_by_harness` / `coverage` / `freshness` / `excluded_harnesses`），`CoverageStatus`（带 `denominator_version`），`Freshness`（`FreshnessState` + `last_observed_at`）。
- `authority_query`：`peaked_days_map`（DSH 峰谷逐日）、`claude_days` / `claude_legacy_days`、`codex_by_hour_model`（**仅 Codex 单执行环境**的小时 × 模型）、`coverage_status`（逐执行环境三维分母 v1：usage / price / sync）、`facts_page_window`（harness × 时间窗 × keyset 分页，无 OFFSET 漂移）、`hourly_by_harness`（三执行环境北京小时轴，**仅 token 之和——无模型/供应商轴、无成本**）。窗口查询已断言命中 `usage_facts_harness_time` 索引（EXPLAIN QUERY PLAN，不 full scan）。
- `pricing_snapshots` + `summary::PricingCards::asof(窗口月末 ms)`：历史价卡重放，**粒度 = 窗口级（查询窗口月末时点）**。逐日 / 逐事实重放明确是独立后续项。
- `sql_authority::is_enabled(data_home)`：标记文件开关（`<data_home>/.sql-authority-enabled`）→ 直接映射 envelope 的 `authority_state` ∈ `candidate`（未翻）/ `enabled`（已翻）。
- `data_quality_issues` 表 + `data-status`（health / integrity / `open_quality_issues_by_code` / `recent_runs`）+ `data-unresolved`（逐模型 unresolved 下钻：billing-route-unknown / billing-mode-unknown / no-price-card / partial-price-basis）。

**未落地，MCP 规格不得假设其存在**：

- **§3.4 模型 / 供应商 / 价格归一表**（`providers` / `models` / `model_aliases` / `pricing_versions` / `model_prices`）——**从未建**。实际实现用 `pricing_snapshots`（整份 `pricing.json` 快照 blob）+ 查询时 `billing_route_of` 反查。canonical 模型 ID、`model_aliases` 时效区间、`pricing_versions.source_kind`（official / user_configured / imported）三分并列展示都还没有落点。
- **`workflow_events` 的完整度**——三执行环境（Claude Code / Codex / WorkBuddy）已有 wire 提取、脱敏指纹、同步写入；DSH 已有既有事件适配。`session_detail` 已能读出独立的安全 workflow 时间线，`issues_summary` / `skills_summary` 仍因覆盖度、完整重试生命周期和 token/cost 唯一归因未闭环而保持显式 partial/unknown。
- **`sessions` 表的会话级信息**——是最小索引（`session_key` / `harness` / `machine_namespace` / `last_observed_at_ms`），`started_at_ms` / `ended_at_ms` 大多为空，无会话级 token / 成本聚合。
- **`session_ref` 所需的 HMAC + 每安装随机 salt**——仓库内无此基元（`source_identity.rs` 的 `fnv1a64_hex` 是非密码学哈希，不满足「不可反推」）。
- **跨执行环境「小时 × 模型 / 供应商」聚合查询**——只有 `codex_by_hour_model` 单执行环境版；claude / dsh 及三执行环境合并的模型轴小时曲线要新写。
- **逐小时成本**——`hourly_by_harness` 只出 token。
- **精确整数分金额投影**——不存在。`domain::cost`（`cost_report` / `cost_series` / `priced_day`）全程 `f64`：`pricing.json` 费率是浮点、`tokens/1e6 × rate` 在 `f64` 累加，冻结 DTO 的 `amounts_by_basis` / `total_actual_spend` 都是 `f64`。整数分只在 `budget_status_sql` 的分子出现（`pyround(× 100)`）。`MoneyMinor` 投影是 M1 净新增（§5.1 规则 5）。
- **会话数 / 活跃小时 / 逐日趋势 / 月底预测**——不在 `DailySummary` / `MonthlySummary` 字段里（两者字段集 = `by_harness` / `tokens_by_harness` / `by_provider` / `coverage` / `freshness` / `excluded_harnesses` / `last_observed_at`）。`summary_daily` / `summary_monthly` 承诺的这几项是 M1 新增聚合查询，不是薄封装。
- **`data-export-private` / `data-export-redacted` 的覆盖面**——只导出 `usage_facts` 的折叠列（`fact_id` / `harness` / `machine_namespace` / `native_session_id` / `source_event_id` / `observation_kind` / `source_profile` / `model_raw` / `provider_id` / `event_ts_utc` / 四个 token 列）。**不含** `pricing_snapshots` / `harness_bills` / `sync_runs` 状态 / schema 版本 manifest。因此导出快照单独**不足以**支撑 `provider × basis × currency` 成本对账（§8.1 P1-2）。
- **SQL-vs-legacy 双轨对账机制**——已于 Phase 4.3 Stage 1（commit `ad4e33e`）**删除**（`summary::reconcile_authority_vs_legacy` / `persist_reconcile_exceptions` / CLI `data-reconcile-authority` / `data-budget-reconcile`）。`JsonSummaryRepository` 本体暂留（Stage 2+ 处理），但不再是对账基准；用户 2026-09-07 已决定「翻开关 + 纯 SQL 重导入」。这直接改变 §8.1 与 Phase M2 的定义。`data-reconcile`（index.sqlite3 投影 vs DTO，旧库自洽）仍在，与本工具无关。
- **MCP / JSON-RPC 协议栈**——工作区无 `rmcp` / `jsonrpc` / `tokio` 依赖，MSRV 1.74，且「分发物零第三方」约束（CLAUDE.md）。传输层实现方式是 M0 决策项（§13 M0 D1）。
- **`--profile internal` 运行时开关**——不存在。当前唯一类似机制是 `sql_authority` 的标记文件。内部工具的启用 / 排除方式是 M0 决策项（§13 M0 D4）。

## 6. 通用响应契约

所有成功工具返回相同顶层结构：

```json
{
  "schema_version": "1",
  "data_version": {
    "authority_schema": 1,
    "query_semantics": "2026-09-07"
  },
  "authority_state": "candidate",
  "authority_revision": {
    "last_completed_run_id": "run_2026-09-07T14-29-00Z_a1b2",
    "committed_at": "2026-09-07T14:29:12+08:00",
    "max_observed_at": "2026-09-07T14:28:55+08:00"
  },
  "generated_at": "2026-09-07T14:30:00+08:00",
  "timezone": "Asia/Shanghai",
  "coverage": {
    "status": "complete",
    "requested_from": "2026-09-07T00:00:00+08:00",
    "requested_to": "2026-09-08T00:00:00+08:00",
    "covered_from": "2026-09-07T00:00:00+08:00",
    "covered_to": "2026-09-07T14:29:12+08:00",
    "missing_harnesses": []
  },
  "freshness": {
    "last_successful_sync_at": "2026-09-07T14:29:12+08:00",
    "stale_harnesses": []
  },
  "warnings": [],
  "data": {}
}
```

### 6.1 枚举语义

`authority_state`：

- `enabled`：SQL 已是产品运行时权威源。
- `candidate`：SQL 可供迁移验收，但产品尚未正式切换。
- `unavailable`：数据库缺失、损坏或版本不兼容。

`coverage.status`：

- `complete`：请求区间内，所需来源均有可信覆盖。
- `partial`：部分执行环境、日期、维度或事件缺失。
- `unavailable`：无法形成可信结果。
- `not_applicable`：该工具不依赖时间覆盖。

`authority_revision`（P2-6：标识「本次答案基于哪一批已提交数据」）：

- `last_completed_run_id`：最近一次 `status='succeeded'` 的 `sync_runs.run_id`。
- `committed_at`：该 run 的提交时间（RFC 3339）。
- `max_observed_at`：本次查询窗口内命中事实的最大 `event_ts_ms`（RFC 3339）；窗口未限的工具（`data_status`）取全库 `MAX`。
- **行级口径（M0 D7 裁决）**：查询 SQL = `SELECT MAX(event_ts_ms) FROM usage_facts WHERE deleted_at_ms IS NULL AND observation_kind != 'legacy_aggregate'`——`legacy_aggregate` 是聚合兜底行（`event_ts_ms` 是北京日 12:00 代表点，**不可**被认作可信快照的最大值）。这条过滤与 `per_harness_breakdown`（`by_harness[*].facts`）+ 三执行环境 `hourly_by_harness` 一致，**不要**让它在 envelope vs per-harness 之间分叉。
- `schema_version` / `query_semantics` 只描述**结构**；`authority_revision` 描述**数据截面**。同步进行中连续调用多个工具（小时 / 日 / 月）可能跨越一次提交，`authority_revision` 让守恒与 M15 三消费面对账能识别「是真差异还是跨了批次」。

#### 6.4.1 `as_of_run_id` snapshot token 状态机（M0 D7 裁决）

客户端做严格跨工具对账（小时 → 日 → 月守恒、三消费面 parity）时，可在上一次响应的 `last_completed_run_id` 作为 `as_of_run_id` 参数回传。首版（v0.9.1 / M1）状态机：

- **未传 `as_of_run_id`**：正常返回，使用当前最新已提交数据。
- **传入 `as_of_run_id` 且 != 当前最新 run**：
  - v0.9.1 行为：响应**正常返回**当前最新数据，但在 `warnings[]` 里加一条 `{ "code": "snapshot_drift", "message": "as_of_run_id=<X> but current is <Y> — strict cross-tool consistency not yet enforced (M2)", "requested": "X", "current": "Y" }`。
  - 不返回错误，不假装钉住旧截面（假装钉住比 drift 更危险）。
- **传入 `as_of_run_id` 但不存在于 `sync_runs`**：业务错误 `isError: true` + `error.code: "invalid_argument"`，并提示「该 run 未发生过或不在本权威库」。

v1 不实现「钉住旧截面」——需要事务级 snapshot（M2 任务，由 `authority_audit` 验收门带）。

### 6.2 诚实返回原则

- “没有发生”返回数值 `0`。
- “没有采集到”返回 `null` 或省略指标，并给出 warning。
- “无法计价”返回 token 和 `unresolved`，金额不得写成 `0`。
- “缺少工作流事件”不能解释成“没有问题”。
- 任何聚合都应满足可守恒：下钻子项之和等于上层总量；无法守恒必须警告。

### 6.3 时间规则

- 默认统计时区来自 OS 的 IANA 时区；用户也可以通过类型化控制面显式保存一个
  IANA 时区。当前环境为 `Asia/Shanghai` 时，默认结果与 v0.9.1 业务日口径一致。
- 日期使用 `YYYY-MM-DD`，月份使用 `YYYY-MM`，时间戳使用 RFC 3339。
- `from` 为闭区间，`to` 为开区间。
- 同一个 MCP 进程内使用已保存的统计时区；修改时区是显式本地控制面写入，并应在
  修改后重新读取日/月窗口，避免把不同统计时区的结果混在一起。

### 6.4 MCP 线协议契约（P1-3——M0 必须逐条冻结）

选择手写传输层（§13 M0 D1）意味着以下内容不能留给实现者临场决定，否则两个实现者会写出互不兼容的 server。M0 冻结时本节每条给出确定值：

- **MCP protocol version**：声明并固定一个具体版本串（`initialize` 里回报），不接受未知次要版本的隐式降级。
- **握手**：`initialize`（回报 server info + capabilities：只声明 `tools`，不声明 `resources` / `prompts` / `logging`）→ `notifications/initialized` → 正常服务。`initialize` 之前只接受 `initialize`，其他方法回 JSON-RPC error。
- **方法集**：`initialize`、`tools/list`、`tools/call`、`ping`；`shutdown` 语义 = 客户端关闭 stdin / 发送 EOF → server 冲刷 `stderr`、关闭 DB 连接、退出 0。不实现 `resources/*`、`prompts/*`、`completion/*`、`roots/*`。
- **stdio framing**：逐行 JSON（`\n` 分隔，UTF-8，单条消息不跨行）；`stdout` 只出协议帧，任何日志 / 进度 / 诊断走 `stderr`。不使用 Content-Length 头式 framing（与逐行二选一，M0 定死一种）。
- **每个工具的 schema**：`tools/list` 为每个工具返回完整 `inputSchema`（JSON Schema draft 2020-12）**和** `outputSchema`；输入 schema 用 `additionalProperties: false` + 显式枚举，未知字段直接 `invalid_argument`。冻结前每个工具都必须有可被校验器加载的 schema 文件（§13 M0 退出条件）。
- **结果载荷**：成功返回用 `tools/call` 的 `structuredContent`（承载 §6 envelope），`content` 里放一份等价的人类可读 JSON 文本块；两者必须同源序列化，不允许只填一个。
- **错误映射**：传输 / 协议层错误（未知方法、schema 不符、解析失败）用 JSON-RPC error 对象（标准 code）；**业务错误**（§11 的 `database_missing` / `query_timeout` / …）用 `tools/call` 成功返回里的 `isError: true` + envelope 内 `error` 字段承载稳定 code——不要把业务错误塞进 JSON-RPC error，否则客户端拿不到 warnings / coverage。
- **notification / 取消 / 断开**：收到未知 `notifications/*` 静默忽略；不支持 `notifications/cancelled`（查询短、3s 超时兜底），收到即忽略；客户端断开（stdin EOF 或写 `stdout` 失败）= 立即按 `shutdown` 退出，不驻留。
- **并发**：单连接串行处理请求（一个 stdio 管道，无需请求 id 乱序）；`tools/call` 内部查询用只读一致性读事务。

## 7. 工具清单

交付版本不是一次性承诺。工具按以下门槛启用（draft-3 按 §5.3 实际能力面 + 第 2 轮评审校正。`✅` = 读路径已就绪、`🔶` = 部分就绪需新查询 / 新 DTO、`⬜` = 前置未落地）。**注**：所有带金额的工具都额外依赖 `MoneyMinor` 精确投影（§5.1 规则 5，M1 前置），下表不逐行重复。

| 工具 | 首次启用 | 前置条件（draft-3 校正） |
|---|---|---|
| `data_status` | v0.9.1 MVP | 🔶 `data-status` JSON + `schema_meta` / `sync_runs` / `source_files` 查询已在；补**逐执行环境**覆盖起止 + `authority_revision` |
| `usage_hourly` | v0.9.1 MVP | 🔶 `hourly_by_harness` 已在（执行环境轴、仅 token）；`group_by=model`/`provider` + 逐小时 `cost`（`MoneyMinor`）需新写（只有 `codex_by_hour_model` 覆盖单执行环境） |
| `summary_daily` | v0.9.1 MVP | 🔶 `SqlSummaryRepository::daily_summary` 覆盖 by_harness/by_provider/tokens/coverage/freshness；**会话数 / 活跃小时 / 维度过滤需新增查询**（P1-4） |
| `summary_monthly` | v0.9.1 MVP | 🔶 同上 + `budget_status_sql`；**逐日趋势 / 月底预测 / 成本占比 % 需新增**（P1-4，逐日趋势可基于 `peaked_days_map`） |
| `data_quality_issues` | v0.9.1 MVP | ✅ 公开类型化 reader 已落地：状态/严重度/代码/执行环境/日期筛选、稳定 cursor 和 code-aware 脱敏；未知 code 仅返回 code/count，原始 `detail_json` 不跨边界 |
| `authority_audit` | v0.9.1 internal only | ✅ **落地**：MCP 内只读——实时事实 token 守恒、重复 / 孤儿 / legacy-realtime 混轴、覆盖范围输入校验、`authority_revision` 未来性和已登记质量例外自检；不做重导入。见 §8.1 |
| `control_plane` | v1.0 local control plane | ✅ 类型化覆盖工作台的来源状态 / 自定义来源 / 排除 / 删除导入数据 / 留存 / 统计时区 / 同步暂停 / 同步执行 / 日月汇总 / 日历 / 小时分布 / Codex 配额 / 价格目录状态与联网策略 / Issue 列表与状态变更；读取安全可用且不返回绝对路径，写入必须显式启动 `data-mcp serve --allow-local-writes`，不提供任意 SQL / URL / 通用文件写入 |
| `billing_workflow` | v1.0 local control plane | ✅ 仅暴露类型化的候选 / 声明 / 重算 / 账单 / 预算管理动作；读取可用，写入必须显式启动 `data-mcp serve --allow-local-writes`，不提供任意 SQL 或通用写入 |
| `price_cards` | v1.0 local control plane | ✅ **落地（2026-09-17）**：让 Agent 替用户补价卡——`missing_list`（本月缺卡型号：该补到哪家、tokens、按量还是套餐内，与设置页「本月缺价卡的型号」/ `data-status.unpriced_models_month` 同源）、`card_list`、`card_put` / `card_delete` / `route_put`（与设置页「补一张卡 / 声明归属」同一套 `price_overrides` 写入，六个价必须填齐，半张卡整体拒绝）。**不预置任何未经确认的价格**：仓库里没有的数不能编，Agent 填的卡 `basis=user-set`，展示写「按其价卡估算」而非官方标价。写入需 `--allow-local-writes`。见 §7.12 |
| `reimport_verify` | v0.9.1（**MCP 外**） | ✅ **落地（`4c7f75b`）**：`agent-vitals data-reimport-verify [--json]`——两临时库各重放（round B 崩溃后重跑），逐执行环境 × 北京月比对；不碰生产库。不是 MCP 工具（P1-2）。 |
| `cost_breakdown` | v0.9.2 | 🔶 **部分落地**：按事实时间选择历史价格版本、`MoneyMinor`、币种/计费口径分离、订阅与 unresolved token 明细已在 MCP；变化因子分解、跨价格版本父层聚合与三消费面 parity 仍待补齐 |
| `sessions_search` / `session_detail` | v0.9.1（提前） | ✅ **落地（`7c68ab4` + 当前 workflow 收口）**：`session_ref` = HMAC-SHA256(salt, session_key)（salt `<data_home>/.mcp-session-salt` 0600，不进库）；`sessions_in_window` 逐会话聚合 + `session_facts_timeline`；`session_detail` 另返回独立、脱敏的 `workflow_timeline`，不把 workflow 硬归因到 token/cost。 |
| `issues_summary` / `skills_summary` | v0.10 | 🔶 **部分落地**：三执行环境 writer + reader + 显式覆盖度已接通；`skills_summary` 已按调用/结束事件汇总 outcome 与耗时覆盖，并输出 `capability_version` 分桶及证据门控的基线→候选比较；完整跨执行环境历史回填、重试生命周期和唯一 token/cost 归因仍未完成，因此结果继续返回 partial/unknown，不提前宣称 U06/U07 完成。 |

未达到前置条件的工具不得用空实现提前注册。客户端可通过 `tools/list` 判断可用能力。

### 7.1 `data_status`

**机器可校验 JSON Schema（spec D10 + §6.4）**：

```json
{
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "required": ["schema_version", "data_version", "authority_state",
                  "authority_revision", "coverage", "freshness", "warnings", "data"],
    "properties": {
      "schema_version": { "type": "string", "const": "1" },
      "data_version": {
        "type": "object",
        "required": ["authority_schema", "query_semantics"],
        "properties": {
          "authority_schema": { "type": "integer" },
          "query_semantics":  { "type": "string", "const": "2026-09-07" }
        }
      },
      "authority_state": {
        "type": "string",
        "enum": ["enabled", "candidate", "unavailable"]
      },
      "authority_revision": {
        "oneOf": [
          { "type": "null" },
          {
            "type": "object",
            "required": ["last_completed_run_id", "committed_at"],
            "properties": {
              "last_completed_run_id": { "type": "string" },
              "committed_at":          { "type": "string", "format": "date-time" },
              "max_observed_at":       { "type": ["string", "null"], "format": "date-time" }
            }
          }
        ]
      },
      "generated_at": { "type": "string", "format": "date-time" },
      "timezone":    { "type": "string", "description": "IANA statistics timezone used for date/hour boundaries and local timestamp formatting; defaults to the OS timezone and may be an explicit validated user preference." },
      "coverage": {
        "type": "object",
        "properties": {
          "status":        { "type": "string", "enum": ["not_applicable"] },
          "missing_harnesses": { "type": "array", "items": { "type": "string" } }
        }
      },
      "freshness": {
        "type": "object",
        "properties": {
          "last_successful_sync_at": { "type": ["string", "null"], "format": "date-time" },
          "stale_harnesses": { "type": "array", "items": { "type": "string" } }
        }
      },
      "warnings": { "type": "array" },
      "data": {
        "type": "object",
        "required": ["schema_version", "integrity", "facts", "sources", "sessions",
                      "open_quality_issues", "sql_authority_enabled", "pricing_snapshots",
                      "harness_bills", "recent_runs", "by_harness", "health", "hints"],
        "properties": {
          "schema_version": { "type": "string" },
          "integrity":      { "type": "string" },
          "facts":          { "type": "integer" },
          "sources":        { "type": "integer" },
          "sessions":       { "type": "integer" },
          "open_quality_issues":       { "type": "integer" },
          "open_quality_issues_by_code": { "type": "object", "additionalProperties": { "type": "integer" } },
          "sql_authority_enabled": { "type": "boolean" },
          "pricing_snapshots":        { "type": "integer" },
          "harness_bills":               { "type": "integer" },
          "recent_runs": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["run_id", "trigger", "status", "started_at_ms"],
              "properties": {
                "run_id":        { "type": "string" },
                "trigger":       { "type": "string" },
                "status":        { "type": "string", "enum": ["running","succeeded","failed","cancelled"] },
                "started_at_ms": { "type": "integer" },
                "error_code":    { "type": ["string", "null"] }
              }
            }
          },
          "by_harness": {
            "type": "object",
            "additionalProperties": {
              "type": "object",
              "required": ["facts", "sources"],
              "properties": {
                "facts":         { "type": "integer" },
                "sources":       { "type": "integer" },
                "covered_from":  { "type": ["string","null"], "format": "date-time" },
                "covered_to":    { "type": ["string","null"], "format": "date-time" },
                "last_seen_at":  { "type": ["string","null"], "format": "date-time" }
              }
            }
          },
          "health": { "type": "string", "enum": ["ok","warn","critical"] },
          "hints":  { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```

**业务错误**（缺 / 损坏 / schema 不符）走 §11 稳定码：
- `database_missing` / `database_unreadable`（**不**返成功 envelope + `authority_state="unavailable"`，spec §7.1 + 增量 1 review S1）
- `schema_migration_required` / `schema_too_new`

回答“当前数据是否可信、是否新鲜、是否已经切到 SQL”。

输入：无。

输出至少包含：

- 权威状态与 schema 版本。
- 最近一次成功、失败和进行中的同步。
- 各执行环境最近观测时间、事实数和覆盖起止。
- 未解决的数据质量问题数量，按严重度和类型分组。
- 未识别模型、未定价用量和重导入差异摘要（`data_quality_issues` 里 `undated_residual` / `reconcile_*` 等 code）。

该工具必须在业务数据为空时仍可使用；数据库不存在时返回结构化错误，不自动建库。

**实现注记（draft-3）**：现有 `data-status` JSON 已含 schema / integrity / `facts` / `sources` / `sessions` 全局计数 + `open_quality_issues_by_code` + `recent_runs` + `health` / `hints` + `sql_authority_enabled`。**需补**：① 逐执行环境的最近观测时间 / 事实数 / 覆盖起止（当前只有全局数）——数据在 `source_files` + `usage_facts`，加一条 `GROUP BY harness` 查询；② `authority_revision`（§6.1）——从 `sync_runs` 最近 succeeded 行取。「未识别模型 / 未定价用量」下钻可复用 `data-unresolved` 的逐模型口径。`integrity != ok` → envelope `authority_state=unavailable` + 错误码 `database_unreadable`。

### 7.2 `usage_hourly`

回答模型或执行环境的小时分布曲线。

输入：

```json
{
  "date": "2026-09-07",
  "group_by": "model",
  "harnesses": ["claude-code", "codex"],
  "models": [
    { "kind": "harness_raw", "harness": "claude-code", "value": "claude-opus-4" }
  ],
  "metrics": ["total_tokens", "output_tokens", "cost"]
}
```

约束：

- `group_by` 仅允许 `model`、`provider`、`harness`。
- 单次最多查询 31 天；使用 `date` 时返回 24 个小时桶，包括零值桶。
- `metrics` 允许 `["total_tokens", "output_tokens"]`（增量 2）；`"cost"` 推迟到 `cost_breakdown`（M3）——逐小时计价的 SQL 路径需要在事实时点选价版（`PricingCards::asof` 当前仅窗口级），且不能把 v0.9.2 之前用户看到的 M01 守恒测试夹具重写。
- **`models` 字段 `kind` 词表（M0 D3 裁决）**：v0.9.1 只支持 `"harness_raw"`，对应 `usage_facts.model_id` 的执行环境 raw 值（按 `harnesses` 限定）；其它 `kind` 值（含 `"canonical"`）在该版本中**非法**，schema 用 `enum: ["harness_raw"]` 强约束。canonical 归一表就绪后 v0.9.2+ 增 `"canonical"` 作为**新** `kind` 值，**不**改 `"harness_raw"` 语义。
- **响应序列的 `identity_kind` 字段**：每个序列显式带 `identity_kind: "harness_raw"`；下游消费者据此决定聚合方式（不能假定后续字段兼容其它身份）。

输出每个序列包含维度键、展示名、`identity_kind`、24 小时点、总量、峰值小时、覆盖度和 unresolved 信息。

**实现注记（draft-3）**：

- **P2-7 模型过滤字段**：不叫 `model_ids`（那会在 canonical 归一表落地时静默改变语义）。用 `models: [{kind, harness, value}]`，v0.9.1 只支持 `kind="harness_raw"`（匹配 `usage_facts.model_id` 的执行环境 raw 值，按 `harnesses` 限定）；`group_by=model` 的序列键是 `(harness, raw_model)`，响应每个序列显式带 `identity_kind: "harness_raw"`。canonical 层就绪后新增 `kind="canonical"` + `identity_kind: "canonical"`，**不改** `harness_raw` 的含义。
- **查询面**：`group_by=harness` 可复用 `authority_query::hourly_by_harness`；`group_by=model`/`provider` 与逐小时 `cost` 需新增查询（当前只有 `codex_by_hour_model` 覆盖单执行环境的小时 × 模型，且不含成本）。小时桶使用配置的统计 IANA 时区（SQLite `localtime` 与自然日边界），不以固定 `BEIJING_OFFSET_MS` 代替 DST-aware 投影。

### 7.3 `summary_daily`

回答某日的总体使用和成本，并支持按执行环境、模型或供应商拆分。

输入：`date`、可选 `group_by`、可选维度过滤器（`models` 同 §7.2 形状）。

输出：token 分类、会话数、活跃小时、各币种/口径金额（`MoneyMinor`）、缓存占比、未定价 token 和分组明细。

**实现注记（draft-3，P1-4）**：`DailySummary` DTO **已就绪**：`by_harness` / `by_provider`（键 `harness/provider`，单币）/ `tokens_by_harness`（四桶 + `cache_hit_ratio`）/ `coverage` / `freshness` / `excluded_harnesses`。**M1 新增**：① 会话数（`COUNT(DISTINCT session_key)` over `usage_facts` 窗口）；② 活跃小时（有事实的北京小时数）；③ `group_by=model`/`provider` 的分组明细 + 维度过滤（`DailySummary` 现在只按 harness/provider 聚合，没有 model 轴，也没有过滤参数）。金额全部走 `MoneyMinor` 投影（§5.1）。

### 7.4 `summary_monthly`

回答某月累计、日趋势、预算进度与成本构成。

输入：`month`、可选 `group_by`、可选维度过滤器。

输出：

- 月累计 token 与逐日趋势。
- 模型、供应商、执行环境的用量和成本占比。
- `api_equivalent`、`metered_estimate`、`harness_billed`、`subscription_allocated` 等口径分离结果。
- 预算值、已用比例和预计月底值；证据不足时预测为空。
- 未定价、跨币种和数据缺口警告。

**实现注记（draft-3，P1-4）**：`MonthlySummary` DTO + `budget_status_sql` **已就绪**：月累计 token、`by_harness`/`by_provider` 用量与金额、口径分离（`BillingBasis` 五档）、预算值 / 已用比例 / snooze 标记、`coverage` / `freshness`。**M1 新增**：① 逐日趋势（基于 `authority_query::peaked_days_map` + claude/codex 逐日，需组一个三执行环境逐日聚合）；② 月底预测（adaptive floor = 7 日均 × 1.5 是既有按量概念，但没有落成查询——证据不足必须返回 `null`，不外推）；③ 成本占比 %（各条目 `MoneyMinor` / 该币种 summable 总额，跨币不合并）。

### 7.5 `cost_breakdown`

回答“钱花在哪里、为什么变化”。

输入：

```json
{
  "from": "2026-09-01",
  "to": "2026-09-08",
  "compare_to_previous": true,
  "group_by": ["harness", "provider", "model", "basis"]
}
```

输出：

- 各币种、各计费口径的金额和 token。
- 与对比期的绝对变化和比例变化。
- 可解释的变化因子：用量、模型组合、缓存结构、价格版本和账单录入。
- 无法归因的余额；不得为了凑齐总额强行分配。
- 使用到的价格版本、有效时间和价格来源类型。

首版只做确定性分解，不生成自然语言结论。

**实现注记（draft-5，2026-09-13）**：`cost_breakdown` 已从窗口末价卡切换为按每条事实的
`event_ts_ms` 选择不晚于事实时间的 `pricing_snapshots`，并在响应中保留
`pricing.version/source_kind/captured_at_ms`。金额走 `MoneyMinor`；CNY/USD 与 billing
base 分开，不生成伪合计；订阅覆盖 token 和无价卡 / 路由证据不足的 unresolved token 均可
见。当前行粒度保留事实时点价格版本切片；`group_by` 回显请求维度但还没有跨版本的父层
滚动聚合，`compare_to_previous` 只返回等长窗口摘要。变化因子分解（用量 / 模型组合 /
缓存结构 / 价格版本 / 账单录入 + 未解释余额）、完整账单归因和三消费面 parity 仍是 M3
剩余工作。

### 7.6 `sessions_search`

回答“哪些会话构成了这个峰值或异常”。

输入：时间范围、可选执行环境/模型/供应商、排序字段、`limit`、`cursor`。

输出只包含：

- 不可逆或不可枚举的 `session_ref`。
- 执行环境、开始/结束时间、token、金额、模型构成、事件计数。
- 覆盖和质量标记。

禁止输出原生 session ID、机器 namespace、文件路径、标题、Prompt 或回复正文。默认 `limit=50`，最大 `200`。

**实现注记（draft-2）**：`session_ref` 依赖一个尚不存在的基元——每安装随机 salt + HMAC（§9.2）。`sessions` 表当前是最小索引：`started_at_ms` / `ended_at_ms` 多为空，无会话级 token / 成本聚合（`usage_facts.session_key` 外键在，但聚合查询要新写）。本工具的实际前置是一个「session 索引 v2」子阶段（补列 + 聚合 + `session_ref`），不只是查询封装——M3 应显式排期。

### 7.7 `session_detail`

回答一个聚合会话为什么消耗较高、包含哪些模型或工作流事件。

输入：`session_ref`。

输出：会话时间范围、执行环境、模型/供应商构成、小时分布、成本构成、问题类型统计、Skill 统计和数据质量标记。

它不是对话浏览器，不返回消息内容、工具输入输出或原始异常内容。

### 7.8 `issues_summary`

回答“哪些问题重复出现、影响多大”。

输入：时间范围、可选执行环境/Skill/严重度、`group_by`、分页参数。

可识别类别包括：

- 重复错误指纹。
- 重复工具调用。
- 拒绝、超时和重试。
- 无法解析或不完整的工作流事件。

输出每类问题的发生次数、影响会话数、关联 token/成本、首次和最近发生时间、趋势以及证据覆盖度；
同时输出安全的 `retry_chains` / `retry_evidence`。仅在同一会话、能力和脱敏调用形状下观察到失败→再次调用→
成功，才标记 `recovered`；缺少指纹或结束事件时保持 `partial/unavailable`，不把普通重复调用冒充重试链。
错误指纹只能来自脱敏后的稳定分类，不返回原始错误文本。

若 `workflow_events` 覆盖不足，应返回 `coverage=partial/unavailable`，不能返回“0 个问题”。

覆盖度必须按本次请求的时间窗以及 `harnesses` / `skills` 过滤条件计算；不得用全库
事件数填充一个被过滤的查询。响应应列出本次范围内实际观测到的
`observed_harnesses`。未安装或在该时间窗没有事件的执行环境不自动算作缺失执行环境，使用
`harness_absence_is_not_missing=true` 明确这一点；仍未闭合的工作流生命周期和
workflow↔token/cost 归因则继续列在 `missing` 中。

### 7.9 `skills_summary`

回答“哪些 Skill 值得关注”。

输入：时间范围、可选 Skill、排序方式、分页参数。

输出可包含调用数、涉及会话数、成功/失败/未知数、重试率、耗时、token、成本和趋势；同时按
`capability_version` 输出版本分桶。若至少两个版本各有 3 次调用，且完成事件、结果和耗时证据完整，
`version_regression` 返回基线/候选版本及成功率、耗时差异；否则返回 `status=unavailable` 和具体原因。
每个比率必须同时返回分子、分母和覆盖度。

本工具不得仅根据 token 少或调用次数少推断 Skill 无价值。若成功状态、耗时或关联事件未采集，应把相应指标标为 `unknown`。

### 7.10 `data_quality_issues`

回答“哪些数据问题会影响当前结论”。

输入：状态、严重度、类型、执行环境、时间范围和分页参数。

输出：脱敏 issue ID、类别、严重度、影响范围、首次/最近发生时间、出现次数、状态和建议的人类操作。禁止返回可能含路径、Prompt 或密钥的原始 payload。

**实现注记**：`data_quality_issues.detail_json` 继续在本地原样保留用于人工排查；MCP reader 已过一层 **code-aware allowlist 脱敏**，按 `code` 白名单放行已知安全字段，绝不整体回吐 `detail_json`。未知 `code` 只返回 code/count，不放行任何自由文本。

### 7.12 `price_cards`

回答"哪些型号还没有价卡、该补到哪家"，并让 Agent 代填。典型对话：用户对 Claude / Codex
说"帮我把缺的价卡补上"→ Agent `missing_list` → 去胜算云 / 厂商价格页查报价（Agent 自己的
网络能力，本工具零网络）→ `card_put` 逐张写入，回执带 `source`（价格出处）供用户核对。

输入：`action` ∈ {missing_list, card_list, card_put, card_delete, route_put}；`card_put` 需
`provider_id`（目录 id，如 `shengsuanyun`）、`model_id`（与日志一致，命名空间前缀可带）、
`input_uncached` / `input_cached` / `output` 各 `{off_peak, peak}`（元 / 百万 token；不分峰谷
两格填同一个数）、可选 `source`。

输出：`missing_list` → `{month, models: [{harness, provider, model, tokens, covered}]}`，
`covered=true` 表示在订阅内、只影响「按官方价折算」参考数，`false` 表示影响按量费用；
`card_put` → `{changed, provider_id, model_id, basis: "user-set", source}`。

规则：不返回路径 / 原始日志；价卡是**用户提供的价格证据**，不是官方标价；一张卡六个价缺一整体
拒绝（半张卡会让计价按缺档静默算出看似正常的错数）；`provider_id` 是目录 id，端点主机名
（`shengsuanyun.com`）由调用方先归一。

### 7.11 `query_sql_readonly`（内部调试工具——`mcp-internal` feature only）

**仅 mcp-internal 构建**——公开二进制不含此工具。**不在 v1 兼容承诺内**。让其他 Agent 在 review / 调试 SQL 路径时不依赖 shell 直连权威库。

**威胁模型（spec §8.2 P1-5）**：调用者可能用 `AS` / 表达式 / `json_extract` 把敏感字段改名后返回——所以**仅结果列名扫描不够**。本工具走**双层防线**：

1. **来源层 authorizer**（`agent_vitals_data::safe_query::authority_callback`）——按 `SQLITE_READ` 回调按来源表 + 来源列拒绝敏感字段：
   - `usage_facts.{native_session_id, source_event_id, source_id}`
   - `sessions.{native_session_id, machine_namespace, session_key}`
   - `source_files.{path_hash, source_id}`
   - `data_quality_issues.{detail_json}`
   - `sync_runs.{error_detail}`
   - `migrations.{checkpoint_json, error_detail}`
   - 写入类（`Insert` / `Update` / `Delete` + temp 变体）、DDL（`Create*` / `Drop*` / `Alter*` / `Reindex` / `Analyze` / `CreateVtable` / `DropVtable`）、`Pragma` / `Attach` / `Detach` / `Transaction` / `Savepoint` 一律 deny。
   - 危险函数 `load_extension` / `random` / `randomblob` / `zeroblob` / `readonly` deny；其它内建函数（聚合 / `coalesce` / `json_extract` 等）allow。
   - `Unknown` action + `#[non_exhaustive]` 通配一律 deny（fail-safe）。

2. **脱敏只读 view**（`v_facts_safe` / `v_sessions_safe` / `v_data_quality_safe` / `v_sync_runs_safe`）——view 定义里就**不**SELECT 敏感列。即便 authorizer 漏掉，view 也不暴露。

**输入**：

```json
{
  "sql": "SELECT harness, SUM(output_tokens) AS total FROM v_facts_safe GROUP BY harness",
  "max_rows": 200,
  "timeout_ms": 3000
}
```

`sql` 必须单条 `SELECT` 或 `WITH ... SELECT`（多语句不在 `prepare` 范围被 authorizer 拒；本工具前置的 `rewrite_with_limit` 在多语句 / 中间 `;` 时不改写）。`max_rows` 默认 200，cap 200。`timeout_ms` 默认 3000，cap 30000（通过 `busy_timeout` 实现——SQLite 真正 wall-clock 守卫要 `progress_handler`，本期不做）。

**约束 / 上限**：
- 自动 LIMIT 改写：用户 SQL 不带 LIMIT → 追加 `LIMIT max_rows`；带 LIMIT 且 > max_rows → 截到 max_rows；带 LIMIT 且 ≤ max_rows → 不动。
- 列名 token-level 词边界检查（防 `colimit_audit` 误中 `LIMIT`）。
- 响应体 1 MiB 估算上限——超过则按行截断到 80% 并加 `warnings:[{code:"result_truncated",...}]`。

**输出**：`envelope`（spec §6）+ `data = { sql_safe, columns: [string], row_count, row_count_cap, elapsed_ms, rows: [[Value]] }`。

**业务错误**（spec §11）：
- `database_missing` / `database_unreadable` / `schema_too_new` / `schema_migration_required`（库打不开 / 损坏 / schema 不符）——业务错误
- `invalid_argument`（prepare/execute 失败，authorizer deny，SQL 语法错）——业务错误
- `internal_error`（其它）——兜底

**审查重点（增量 7.5 review 必看）**：authorizer callback 完整性（每一类 SQLITE_* action 都有 deny 路径）；SENSITIVE_READ_COLUMNS 是否漏了源表敏感列；函数 deny 黑名单是否漏 `load_extension` 之类；LIMIT 改写不会误中字符串字面量 / 注释 / AS 别名；view 定义里实际 SELECT 列表不含敏感列；公开构建 `tools/list` 不含此工具。

## 8. 内部开发工具

调试工具（`query_sql_readonly` / `authority_audit`）只能在编译期 feature
`mcp-internal` 下注册。`control_plane` 与 `billing_workflow` 是显式类型化的本机
控制面：它们不提供任意 SQL、URL 或通用写入；所有 mutation 仍由运行时
`--allow-local-writes` 守门。公开构建可以提供安全的读取动作，但默认进程不能写。

### 8.1 迁移与自洽验收：`authority_audit`（MCP 内）+ `reimport_verify`（MCP 外）

**背景（draft-3，P1-2）**：draft-2 曾把一个工具（`authority_reconcile`）定义成「只读」+「验证重跑 `data-migrate` / `sync-facts` 幂等」，执行模型自相矛盾——只读工具无法执行重导入。而 `data-export-private` 当前只导出 `usage_facts` 折叠列（无价格快照、无 harness bills、无 schema/authority 状态，见 §5.3），单独也撑不起 `provider × basis × currency` 的成本对账。因此拆成两件东西：

#### 8.1.1 `authority_audit`（MCP 内、只读、`mcp-internal` feature）

用途：不改任何东西，只检查 SQL 权威库**当前状态**的自洽性。

- **守恒**：下钻子项之和 == 上层总量（§6.2）；跨聚合面守恒（hourly 累加 == daily、daily 累加 == monthly，token 严格相等、`MoneyMinor` 按 `(currency, basis)` 严格相等）。
- **重复 / 幂等痕迹**：`usage_facts` 的 UNIQUE 五元组无冲突残留；`observation_kind='legacy_aggregate'` 行未与实时行在同一聚合里相加（§4「行轴/聚合轴分离」）。
- **覆盖与新鲜度一致**：`coverage_status` 的三维分母与实际事实 / 价卡 / `source_files` 状态一致；`authority_revision` 自洽（最近 succeeded run 的 `committed_at` ≤ now）。
- **已登记例外**：`data_quality_issues` 里 `undated_residual` / `reconcile_*` 等 code 逐条列出，作为「已知、可解释」的缺口摘要。

输入：月份或日期、执行环境、容差配置。输出：`exact` / `explained`（差量 ≤ 已登记例外）/ `mismatch` 三态 + 脱敏差异摘要。**只读**。

#### 8.1.2 `reimport_verify`（**不是 MCP 工具**——隔离的开发命令）

用途：验证「重跑导入不改账」。因为要真的执行导入，它**不能**是只读 MCP 工具。

- 形态：`agent-vitals data reimport-verify`（`mcp-internal` 或 dev build），或独立测试 harness。
- 步骤：把权威库（或指定 facts JSONL / 导出快照）导入一个**临时数据库**，跑 `data-migrate` / `sync-facts` 两遍，逐 `harness × bucket` token + `MoneyMinor` 比较两遍结果与源库。
- 绝不写生产权威库；临时库用后即删。
- 对应契约测试 Q12（双次导入 + 中断 → 恒等）。

#### 8.1.3 若保留「快照对账」模式

`authority_audit` 可选一个 `--against <snapshot>` 模式对比冻结导出快照——但**前提是快照格式先补全**：一个 `snapshot.manifest.json`（导出时刻的 `authority_revision` + schema 版本）+ `pricing_snapshots` 副本 + `harness_bills` 副本，否则只能比 token、不能比金额。快照格式扩展本身是 M3 工作（不阻塞 M2 的 `authority_audit`）。

### 8.2 为什么不公开任意 SQL

任意 SQL 会绕过产品语义和安全边界：

- 调用者可能混淆 UTC 与北京时间、事件与聚合、账单与估算。
- 可能跨币种误加、把未定价当零，得到“语法正确、业务错误”的答案。
- schema 一升级，外部查询立即失效，形成不可维护的隐形 API。
- SQLite 中仍含本机标识和审计字段，`SELECT *` 会扩大隐私暴露面。
- 无界查询可能锁库、占用大量内存，影响正在同步的产品。
- 开放 PRAGMA、ATTACH、扩展或写语句会突破“只读数据产品”的承诺。

如调试确有需要，可以另设不随产品发布的 `query_sql_readonly`：

- 只在 `mcp-internal` feature 构建里注册（与 `authority_audit` 同门），并在工具描述中标记不稳定。
- 使用 SQLite read-only 连接和只读 authorizer。
- 仅接受单条 `SELECT` 或只读 `WITH ... SELECT`。
- 拒绝写入、DDL、事务控制、PRAGMA、ATTACH/DETACH、VACUUM、扩展加载和多语句。
- 3 秒超时、最多 200 行、最大 1 MiB 结果，超限即失败。
- **脱敏必须在来源层，不在结果列名层（P1-5）**：SQLite `authorizer` 回调按**来源表 + 来源列**拒绝——`SQLITE_READ` 命中 `usage_facts.native_session_id` / `sessions.native_session_id` / `sessions.machine_namespace` / `source_files.path_hash` / 任何 `*_id` 原生标识列即 deny，无论调用者用 `AS`、表达式、字符串拼接还是 JSON 提取改名。更稳妥的形态：只允许查询一组**专门建立的脱敏只读 view**（`v_facts_safe` 等，view 定义里就不 select 敏感列）+ 一个函数 allowlist（禁 `load_extension`、禁自定义函数）。结果列名扫描只作为第二层防线，不作为唯一防线。
- 只记录本地审计，不记录返回值。

该能力用于开发者排障，不属于 Data MCP v1 的兼容承诺，也不能作为验收用例依赖。

## 9. 隐私与安全

### 9.1 永不返回的内容

- Prompt、用户消息、模型回复正文。
- 工具原始参数、工具原始返回和原始错误文本。
- 本地绝对路径、用户名、机器 namespace、原生 session ID。
- API key、Cookie、Authorization header、环境变量和带 token 的 URL。
- 未经过脱敏分类的来源 payload。

### 9.2 会话引用

`session_ref` 必须是本机稳定、外部不可反推的引用。建议使用应用安装时生成的随机 salt 对内部 `session_key` 做 HMAC，并截断为足够长度。不得直接散列可枚举的原生 ID。

**实现注记（draft-2）**：仓库当前无此 salt——`source_identity.rs` 的 `fnv1a64_hex` 是非密码学哈希，不满足「不可反推」。M0 需定（D5）：① salt 生成时机（首次 `data-mcp serve` 或安装脚本）；② 存储位置——**不进权威库**，因为库会被 `data-export-*` 导出；建议 `<data_home>/.mcp-session-salt`，权限 `0600`；③ HMAC 原语——`sha2` 已是依赖，可实现 HMAC-SHA256，不新增 crate。`session_key` 本身含原生 ID 片段，绝不出现在响应里。

### 9.3 进程与文件权限

- Server 继承当前用户权限，不提权。
- 数据库以 read-only URI 打开；不得因查询自动创建数据库或执行 migration。
- 不监听网络端口。
- MCP 进程退出时释放连接；客户端断开后不得驻留后台。
- 错误响应只包含稳定错误码和安全描述，详细诊断写入本机 `stderr`。

### 9.4 `data_quality_issues` 的 code-aware 脱敏 allowlist（spec §7.10 注记 + 增量 4）

`data_quality_issues.detail_json` 按各 `code` 的需要原样存储（真机现在含：`undated_residual` 存逐模型 token；`missing_sid` 存来源提示；`legacy_aggregate*` 存 coverage 降级；`reconcile_exception` 存差异摘要），可能含模型 raw 名或路径片段。MCP reader **不能**整体回吐 `detail_json`——当前按 `code` 白名单放行已知安全字段，未知 `code` 仅放行结构化计数。

**字段级 allowlist（M0 退出条件）**：

| `code` | 放行字段 | 屏蔽字段 | 备注 |
|---|---|---|---|
| `undated_residual` | `total_tokens`、`by_model` 内仅 `model_raw` + `tokens` | `native_session_id` / `source_id` / 任何路径 | 已知安全 |
| `missing_sid` | `source_harness`、`reason`（枚举词） | `source_path_hash` / `path` | path_hash 可能与可枚举路径碰撞 |
| `legacy_aggregate_*` | `month`、`harness`、`coverage_kind` | 任何 raw 模型名 | coverage 状态元 |
| `reconcile_exception` | `month`、`harness`、`basis`、`currency`、`amount_minor`、`kind` (`exact`/`explained`) | 任何 `fact_id` / 模型名 / `session_ref` | 金额粒度足以解释差异 |
| `snapshot_drift`（增量 6 新增） | `requested`、`current`（两者都是 `last_completed_run_id` 字符串） | `details` | run_id 是稳定匿名词 |
| `*`（其它 / 未知 code） | 仅 `code` + `count` | `detail_json` 全部字段 | 未知 code 强制脱敏 |

**约束**：

- 屏蔽字段**绝不**出现在响应里（不是散列/截断——是删除；下游消费者读到字段名也读不到值）。
- allowlist 在工具层执行（`data_quality_issues::run`），不在 SQL 层；`detail_json` 仍原样入库（用于人工排查）。
- 新增 code 必须同时扩 allowlist + 单测，不允许「先入未知 code → 静默走 `*` 分支」。

## 10. 查询治理与性能

- 所有公开工具使用固定查询模板和绑定参数。
- 小时查询最大 31 天；一般聚合最大 24 个月；更长范围需按月分段。
- 分页默认 50、最大 200，使用稳定 cursor，不使用可能漂移的大 offset。
- 单工具默认 3 秒超时、最大 1 MiB 响应。
- 长查询使用一致性读事务，不能看到同步事务的半成品。
- 结果排序必须稳定；同值时以不可见稳定键补充排序。
- 对外 DTO 与数据库 schema 解耦；schema 变化不应无意改变 MCP 字段。
- 高频工具可以在 repository 层增加索引或可验证缓存，但缓存必须携带 `authority_revision`，不能返回跨同步批次的混合结果。
- **跨工具快照一致（P2-6）**：每个响应带 `authority_revision`。客户端做严格跨工具对账（小时→日→月守恒、三消费面 parity）时，应把上一次响应的 `last_completed_run_id` 作为 `as_of_run_id` 参数回传；服务端在 `as_of_run_id` ≠ 当前最新时，要么以一致读事务钉住该截面，要么返回 `data_unavailable` + warning 提示「数据在两次调用间前进了一批」。**首版最低要求**：识别并 warn（钉截面可 M2 补）。单工具内部本就是一次一致读事务，天然自洽。

## 11. 错误契约

错误统一返回稳定 code；不得只返回自由文本。

| code | 含义 | 调用者建议 |
|---|---|---|
| `database_missing` | 权威库不存在 | 先运行产品同步/迁移 |
| `database_unreadable` | 数据库损坏或无法读取 | 运行 data doctor，保留现场 |
| `schema_migration_required` | schema 过旧 | 用匹配版本的产品迁移 |
| `schema_too_new` | MCP 版本落后于数据库 | 升级 MCP/产品 |
| `invalid_argument` | 参数格式或枚举非法 | 修正参数 |
| `invalid_time_window` | 时间范围非法或超限 | 缩小范围 |
| `not_found` | session_ref 等不存在 | 重新搜索或检查范围 |
| `data_unavailable` | 无法形成可信结果 | 查看 warnings/status |
| `query_timeout` | 查询超过时间预算 | 缩小范围 |
| `result_too_large` | 结果超过行数或体积限制 | 使用分页/更细过滤 |
| `internal_error` | 未分类内部错误 | 查看本地日志；响应不泄露细节 |

数据部分缺失但仍可回答时，应返回成功响应并设置 `coverage=partial` 与 warnings，而不是把整次调用变成错误。

## 12. 测试与用户查询验收

### 12.1 契约测试

| ID | 场景 | 通过标准 |
|---|---|---|
| M01 | 空数据库 | `data_status` 如实显示空；聚合不制造历史数据 |
| M02 | 模型小时曲线 | 固定 fixture 返回 24 桶，合计与日汇总守恒 |
| M03 | 执行环境小时曲线 | 各执行环境合计与全局合计守恒，峰值小时正确 |
| M04 | 未定价模型 | token 保留，成本标记 unresolved，不显示为 0 |
| M05 | 来源过期/缺失 | coverage 为 partial，列明 stale/missing harness |
| M06 | 稳定分页 | 无重复、无遗漏；相同快照重复调用结果一致 |
| M07 | 敏感字段 | 全工具响应不含路径、原生 ID、正文或密钥样本 |
| M08 | 注入输入 | 参数不能改变查询结构；非法枚举被拒绝 |
| M09 | 数据库缺失/损坏 | 返回稳定错误，不自动建库、不吞错 |
| M10 | schema 新旧不兼容 | 分别返回 migration required / too new |
| M11 | authority 未启用 | 可供内部验收，但响应明确标记 candidate |
| M12 | 公开工具清单 | 不存在任意 SQL、写入、同步、repair 工具 |
| M13 | 同步与查询并发 | 查询只看到事务提交前或提交后的完整快照 |
| M14 | 查询限制 | 超时、行数和响应体限制均有效 |
| M15 | 三消费面一致性 | MCP、CLI、Tauri 对同一窗口的 token 与 `MoneyMinor`（`amount_minor` 整数、`currency`、`basis`）**逐值相等**，不是"约等" |
| M16 | 金额精度（P1-1） | `MoneyMinor` 由 SQL repository 的精确投影生成；MCP 不做二次换算；最细维度只 `pyround` 一次、父层 = 子项整数和；对拼造的浮点边界 fixture 父子守恒且无 off-by-one 分 |
| M17 | 快照一致（P2-6） | 模拟同步在两次工具调用之间提交一批；不带 `as_of_run_id` 时两次响应的 `authority_revision` 不同且 warn；带 `as_of_run_id` 时要么钉截面要么 `data_unavailable` |
| M18 | 线协议（P1-3） | `initialize` 前只接受 `initialize`；未知方法回 JSON-RPC error；业务错误走 `isError`+envelope；stdin EOF → 干净退出 0；`stdout` 无非协议帧 |
| M19 | 别名脱敏（P1-5，internal `query_sql_readonly`） | `SELECT native_session_id AS x` / JSON 提取 / 拼接均被 authorizer 按来源列拒绝，不是仅靠结果列名 |

### 12.2 用户问题验收

| ID | 用户问题 | 使用工具 | 必须验证 |
|---|---|---|---|
| U01 | 今天各模型的小时曲线是什么？ | `usage_hourly(group_by=model)` | 24 桶、峰值、模型合计、覆盖度 |
| U02 | 今天各执行环境什么时候最活跃？ | `usage_hourly(group_by=harness)` | 执行环境曲线与日汇总守恒 |
| U03 | 本月哪个模型最贵？ | `cost_breakdown` | 币种/口径分离、价格版本可解释 |
| U04 | 为什么本周成本上升？ | `cost_breakdown(compare=true)` | 用量/组合/缓存/价格/账单因子及未解释余额 |
| U05 | 高峰由哪些会话构成？ | `sessions_search` → `session_detail` | 能下钻且不泄露内容和原生标识 —— ✅ 真机验证（`7c68ab4`）：`sessions_search(hour=peak)` 逐会话 total 之和 == `usage_hourly` 峰值小时 total；`session_detail` 反解 `session_ref`，leak 扫描零命中 |
| U06 | 哪些问题反复出现？ | `issues_summary` | 次数、影响会话、成本、趋势、证据范围 |
| U07 | 哪些 Skill 有问题？ | `skills_summary` | 分子分母、失败率、未知态，不做越权推断 |
| U08 | 这个结论可信吗？ | 任一查询 + `data_status` | 新鲜度、缺口、未定价、`authority_revision` 和 authority 状态可见 |
| U09a | SQL 权威库当前自洽吗？ | internal `authority_audit` | 守恒 / 无重复 / 覆盖一致 / 已登记例外逐条列出，exact/explained/mismatch 可区分 |
| U09b | 重跑导入会不会改账？ | `reimport_verify`（MCP 外） | 临时库两遍导入逐值恒等（Q12）；不碰生产库 —— ✅ 真机（`4c7f75b`）：`data-reimport-verify` byte-identical，round B 含崩溃 + 幂等重跑 |
| U10 | 调价前后的历史成本对吗？ | `cost_breakdown` | 按事实时间选择价格版本，不用当前价覆盖历史（前置：逐日/逐事实价版重放，见 §7.5 注记） |

用户验收 fixture 必须包含：三个执行环境、至少两个供应商、同一 raw 模型名跨执行环境映射到不同归属、跨价格快照（`pricing_snapshots` 至少两版，覆盖一个调价日）、缓存 token、DSH 峰谷、重复事件、未定价模型（`billing_route` 认不出）、缺失来源、跨月边界和北京时间日界线。（draft-2：`model_aliases` / `pricing_versions` 归一表未落地，fixture 用 raw 模型名 + `pricing_snapshots` 表达同等场景。）

### 12.3 真机验收

内部版本使用本机真实数据执行，但报告只保存聚合和哈希引用：

1. 对今天、本月、跨月边界运行当前阶段已启用的 U 用例；到 v1.0.0 前完成 U01–U10。
2. 将 MCP 与 CLI/Tauri 结果逐值比较。
3. 对异常差异下钻到脱敏事实 ID；禁止复制原始对话到测试报告。
4. 所有差异必须分类为 `exact`、`explained` 或 `mismatch`。
5. `mismatch` 不得通过调大容差关闭；必须形成 data quality issue 或修复。

## 13. 交付阶段

### Phase M0：契约与风险冻结

- 冻结公开工具名、输入、输出 envelope、时间口径和错误码。
- 完成隐私 threat model，建立敏感字段阻断清单。
- 建立 MCP DTO 与 SQL schema 的映射测试（少一列 / 改一列类型必须让测试红）。

- **为每个工具产出机器可校验的 `inputSchema` + `outputSchema`（JSON Schema 2020-12），能被校验器加载。**
- **冻结 §6.4 的线协议每一条为确定值。**

**M0 D1–D10 裁决（评审对照表——每条标 ✅ ack / ✋ 改指令，未 ack 前不冻结）**：

| # | 裁决 | 依据 / 落点 | owner | ack |
|---|---|---|---|---|
| **D1** | **手写**最小 JSON-RPC 2.0 over stdio（stdlib + `serde_json`）。**不**引入 `rmcp` / `tokio`（MSRV 1.74 + 分发物零第三方）。`protocol_version = "2025-06-18"`；framing = 逐行 JSON（`\n` 分隔，UTF-8，单条消息不跨行）；能力声明只 `tools`；方法集 `initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `ping`；`tools/call` 成功载荷用 `structuredContent`（承载 envelope）+ `content[].text` 等价 JSON 文本块；业务错误 = `isError:true` + envelope `error`（**不**塞 JSON-RPC error）；JSON-RPC error 仅用于协议层（未知方法 / 解析失败 / 参数缺失）。 | spec §6.4；增量 1 已落地（`apps/cli/src/mcp.rs`） | `@claude-impl` | ⬜ |
| **D2** | `MoneyMinor { amount_minor: i64, currency, basis }`（§5.1.1）。最细上报维度一次 `pyround(× 10^minor_digits)`，父层 = 子项整数和（守恒由构造）。`minor_digits` 来自 currency（CNY/USD=2，JPY=0）。落点 `agent-vitals-data::authority_query` / `agent-vitals-runtime::summary`，MCP / CLI / Tauri 同源读。**所有带金额工具的前置**。 | spec §5.1.1；增量 2 落地（`agent_vitals_runtime::money::from_f64` 银行家舍入 + `sum_minor` 跨币返 None；domain `MoneyMinor::to_json/from_json`；11 单测全绿） | `@claude-impl` | ✅ |
| **D3** | v1 按 `(harness, raw_model, billing_route)`（§5 规则 4）。过滤字段 `models: [{kind, harness, value}]`，**v1 只支持 `kind="harness_raw"`**；canonical 归一表**不**进 v0.9.1。响应每个序列显式 `identity_kind: "harness_raw"`。 | spec §5.1 规则 4、§7.2；增量 2 落地（`usage_hourly` input schema `models[].kind enum=["harness_raw"]`；每个序列 key 带 `identity_kind`；未知 kind 静默过滤 + 测试 `unknown_model_kind_is_silently_ignored`） | `@claude-impl` | ✅ |
| **D4** | cargo feature `mcp-internal`（`apps/cli` → `agent-vitals-runtime/mcp-internal`），公开构建**编译期排除** `authority_audit` / `query_sql_readonly` / `reimport_verify`。已在增量 7.5 落地（apps/cli `tools/list` 公开=2 / feature=3）。 | spec §8；增量 6 落地时再加 `authority_audit` / `reimport_verify` | `@claude-impl` | ✅ |
| **D5** | `session_ref` salt：`<data_home>/.mcp-session-salt`（32 字节随机，权限 `0600`），首次调用 session 工具时生成。HMAC-SHA256（`sha2` 已是依赖，手写 HMAC，不新增 `hmac` crate）。**不进权威库**。反解 = 对 `sessions` 表逐行算 HMAC 匹配。已在 `7c68ab4` 落地（`mcp/session_ref.rs`，RFC 4231 测试向量钉住）。 | spec §9.2；`7c68ab4` | `@claude-impl` | ✅ |
| **D6** | **拆分**：MCP 内只读 `authority_audit`（守恒 / 重复 / 覆盖 / `authority_revision` 自检）+ **MCP 外**隔离命令 `agent-vitals data-reimport-verify`（临时库重导入比对）。快照对账模式 → M3 才接（要补 `snapshot.manifest.json` + `pricing_snapshots` / `harness_bills` 副本）。 | spec §8.1；增量 6 + 7；Loop 313 真机 MCP 冒烟 | `@claude-impl` | ✅ |
| **D7** | envelope `authority_revision` = `{last_completed_run_id, committed_at, max_observed_at}`。`max_observed_at` SQL 行级口径见 §6.1（**排除 `legacy_aggregate`**）。`as_of_run_id` 入参：v1 仅识别并 `warnings: [{code:"snapshot_drift", ...}]`，**不**假装钉住旧截面（假装比 drift 更危险）；钉截面 = M2 任务。 | spec §6.1 / §6.4.1；增量 6 落地（钉截面 + warn） | `@claude-impl` | ⬜ |
| **D8** | `summary_daily` / `summary_monthly` 输出**保留** spec §7.3/§7.4 承诺的完整字段（会话数 / 活跃小时 / `group_by=model` / 维度过滤 / 逐日趋势 / 月底预测 / 成本占比）。这些**不是**冻结 DTO 的字段——列进增量 3 作为**新增聚合查询**（不是薄封装）。工作量按「新增查询 + 测试」计。 | spec §7.3/§7.4；增量 3 落地 | `@claude-impl` | ⬜ |
| **D9** | `query_sql_readonly` 已在增量 7.5 落地（用户 2026-09-07 决定提前做，让其他 Agent 调试可用）。SQLite `authorizer` 按来源表 + 列拒绝 + 4 个脱敏只读 view（`v_facts_safe` / `v_sessions_safe` / `v_data_quality_safe` / `v_sync_runs_safe`）+ 危险函数 deny 黑名单 + `mcp-internal` 编译期 gating。**结果列名扫描不作唯一防线**（spec §8.2 P1-5 警示）。 | spec §8.2；增量 7.5 落地 | `@claude-impl` | ✅ |
| **D10** | 每个 M1 工具的 `inputSchema` / `outputSchema` 在 M0 结束时已随工具落地（增量 1 的 `data_status` 已生成；增量 2/3/4 各自生成），全部以 `serde_json::Value` 常量注册到 `tools/list`。冻结条件：每个 schema 在 `cargo test` 里被加载 + 结构自检通过。 | spec §6.4；每个增量同步 | `@claude-impl` | ⬜ |

退出条件：评审对 D1–D10 逐条 ack；§6.4 每条有确定值（D1 已锁定）；每个 M1 工具有可校验 JSON Schema（增量 1 起逐个生成）；D1–D10 表内 ⬜ 全变 ✅；任何未决语义都有后续版本（不在 spec 里留隐式默认）。

### Phase M1：最小可用查询面

- **传输层**：`data-mcp serve` + §6.4 全部线协议（`initialize` / `tools/list` 带 schema / `tools/call` / framing / error 映射 / 关闭）。
- **`MoneyMinor` 精确投影**（§5.1 规则 5，D2）——SQL repository 层，所有带金额工具的前置，CLI/Tauri 同步切过来。
- **envelope 类型** + `coverage` / `freshness` 从 DTO 投影 + `authority_revision`（从 `sync_runs`，D7）。
- **`data_status`**——现有 `data-status` 查询 + 逐执行环境 `GROUP BY harness` + `authority_revision`。
- **`summary_daily` / `summary_monthly`**——冻结 DTO 就绪部分薄封装 + **新增聚合查询**：会话数、活跃小时、`group_by=model` 明细、维度过滤（daily）；逐日趋势、成本占比 %、月底预测（monthly，证据不足返回 `null`）。
- **`usage_hourly`**——新增跨执行环境「小时 × model / provider」查询 + 逐小时 `MoneyMinor` 成本（`hourly_by_harness` 只够执行环境轴）。
- **`data_quality_issues`**——✅ 已落地 issue reader + code-aware 脱敏 allowlist（§7.10 注记）。
- 完成 M01–M08、M13–M18。

退出条件：Agent 能可靠回答使用曲线、日/月汇总和数据可信度。**M1 是本 spec 最大的单块工作**：传输层 + 线协议 + `MoneyMinor` 投影 + envelope + 至少 4 个净新增聚合查询——不是「薄封装」。

### Phase M2：v0.9.1 迁移验收能力

- `mcp-internal` feature 实现 `authority_audit`（§8.1.1：守恒 / 重复 / 覆盖 / `authority_revision` 自检，只读）；Loop 313 已用真实 MCP 调用验证 `exact`。
- `reimport_verify`（§8.1.2，**MCP 外**隔离命令）——临时库两遍导入比对。
- MCP、CLI、Tauri 三消费面对同一窗口逐值对账（M15，token + `MoneyMinor`）。
- `authority_revision` 跨工具一致性识别 + warn（M17）。
- 用真实本机数据完成 U01、U02、U08、U09a、U09b；关闭所有未解释 mismatch。

退出条件：Data MCP 可作为 SQL 权威库读路径与三消费面一致性的自动验收接口；M0–M2 即 v0.9.1 Data MCP MVP。

### Phase M3：v0.9.2 成本解释与会话下钻

- **前置子阶段**：① `authority_query` 补按事实时点选价版能力（逐日 / 逐事实历史价格重放）；② 「session 索引 v2」——`sessions` 表补 `started_at_ms` / `ended_at_ms` / 会话级聚合 + `session_ref` HMAC 基元（D5）；③ 导出快照 manifest 扩展（`snapshot.manifest.json` + `pricing_snapshots` / `harness_bills` 副本），供 `authority_audit --against` 做金额对账（§8.1.3）。
- `sessions_search`、`session_detail` 已落地；`cost_breakdown` 的事实时点价格重放、
  `MoneyMinor` 和安全/unresolved 投影已落地。
- 完成变化因子分解、跨价格版本父层聚合、完整账单归因、三消费面 parity，以及历史价格
  版本 fixture、脱敏和证据覆盖测试。

退出条件：Agent 能从异常曲线下钻到会话并解释成本变化；完成 U03–U05、U10。

### Phase M4：v0.10 问题与 Skill 洞察

- **当前状态**：`workflow_events` 的执行环境 wire 提取 → 脱敏指纹 → SQL writer → reader → 覆盖度基础管线已接通；`issues_summary` / `skills_summary` 的覆盖计数会遵循本次时间窗和过滤条件，并返回实际 `observed_harnesses`，不会把未安装执行环境误列为缺失。`issues_summary` 已按同一会话/能力/脱敏调用形状配对安全重试链，并在证据不足时降级；`skills_summary` 已把 `skill_invoked` 与 `skill_finished` 分开计数，未完成调用会落入 unknown，耗时覆盖不足会显式降级；同时按 `capability_version` 输出版本分桶，并仅在最小样本与生命周期/耗时证据满足时计算回归。仍需完成历史数据回填、跨执行环境覆盖和唯一 token/cost 归因，才可关闭 U06–U07。
- 实现 `issues_summary`、`skills_summary`。
- 完成重复问题、Skill 分子/分母、未知态和证据覆盖测试。

退出条件：完成 U06–U07；Agent 能基于证据回答重复问题和 Skill 健康度。

### Phase M5：v1.0.0 发布准备

- 公开构建确认不注册内部工具。
- 安装、发现、升级、schema 不兼容和卸载路径验证。
- 性能、资源占用、崩溃恢复和安全审查。
- 发布用户文档与示例问题，不暴露数据库内部概念。

退出条件：满足第 14 节 Definition of Done。

## 14. Definition of Done

Data MCP v1 完成必须同时满足：

- 所有公开查询只读 SQL 权威库，不读取 legacy 或执行环境原始日志。
- MCP、CLI、Tauri 对冻结 fixture 和真机窗口的核心数字一致——金额到 `MoneyMinor` 的 `amount_minor` 整数**逐值相等**（P1-1）。
- 每个结果都能表达 complete、partial、unavailable 和 unresolved，并带 `authority_revision`（P2-6）。
- 成本按币种、计费口径、供应商、模型和价格快照（`pricing_snapshots` 时点；归一 `pricing_versions` 就绪后升级为版本）解释，不产生伪合计。
- 每个工具有可校验的 `inputSchema` / `outputSchema`；§6.4 线协议每条有确定实现。
- 公开构建没有任意 SQL、通用写入、迁移、repair 工具；`control_plane` 的读取是
  类型化业务投影，所有写入需显式 `--allow-local-writes`；`authority_audit` /
  `query_sql_readonly` 只在 `mcp-internal` 构建里。
- 响应不含对话正文、本机路径、原生 session ID、密钥或工具原始参数；内部 SQL 工具的脱敏在来源列层（P1-5）。
- 公开工具具备固定查询模板、参数校验、超时、分页和响应体限制。
- stdio 无协议外 stdout 输出；客户端断开后进程干净退出。
- M01–M19 与 U01–U10 全部通过。
- 至少一次真实数据验收中，所有差异均为 exact 或有书面解释；无未关闭 mismatch。

## 15. 与版本路线的关系

- **v0.8**：外部 MCP 使用证据与健康分析；不是本 Data MCP 的前置依赖，未完成部分继续独立管理。
- **v0.9**：提供事实模型、清洗与产品汇总能力；剩余产品功能可与 Data MCP 契约阶段并行，但不能绕过统一 repository。
- **v0.9.1**：SQL 权威迁移是 Data MCP 的数据前提。Phase 0–3（schema / 清洗写入 / 读路径切换）已完成，Phase 4（双轨验收）进行中——4.3 Stage 1 已退役 SQL-vs-legacy 对账。M1 工具基于已完成的读路径 + 新增 `MoneyMinor` 投影 + 4 个净新增聚合查询；M2 的验收拆成 `authority_audit`（MCP 内只读自洽）+ `reimport_verify`（MCP 外重导入幂等），不依赖 legacy 第二实现。
- **v0.9.2**：可在稳定事实之上强化异常解释、质量守门、可观测性和性能；不得反向改变已发布的 MCP v1 语义。
- **v0.10**：TraceGraph、Issue、Action 等更高层能力可新增工具或 v2 字段，但必须基于明确证据，不污染 v1 的用量与成本事实。

## 16. 决策记录

1. 首版使用本机 stdio，不提供网络服务。
2. 首版只提供 Tools，不提供 Resources/Prompts。
3. 公开面不提供任意 SQL；受限 SQL 仅可作为不发布的开发工具。
4. MCP 是 SQL repository 的适配器，不复制业务计算。
5. SQL 尚为候选权威时允许内部查询，但必须显式标记 `candidate`。
6. 会话下钻使用不可反推的 `session_ref`，不暴露原生标识。
7. 缺失证据必须表现为 partial/unavailable/unknown，永不伪装成零。
8.（draft-2）MCP 传输层默认手写最小 JSON-RPC 2.0 over stdio；不引入 `rmcp` / `tokio`（MSRV 1.74 + 分发物零第三方），除非单独评审通过。**手写意味着 §6.4 的线协议每条必须 M0 冻结**（draft-3）。
9.（draft-3，替代 draft-2）envelope 金额是 `MoneyMinor { amount_minor: i64, currency, basis }`，由 SQL repository 层的**精确投影**生成（每桶一次 `pyround`）；MCP / CLI / Tauri 同源读，**不做二次换算**——成本引擎当前 `f64` 端到端，事后乘回分会破坏三消费面 parity。
10.（draft-2）v1 工具按 `(harness, raw_model, billing_route)` 语义归属；§3.4 canonical 归一表是 v0.9.2+ 补强，不阻塞 MVP。模型过滤字段用 `models: [{kind, harness, value}]` + 响应 `identity_kind`，不叫 `model_ids`（draft-3，P2-7）。
11.（draft-2）内部工具经 cargo feature `mcp-internal` 编译期排除，公开构建不含（不用运行时 profile 开关）。
12.（draft-3，替代 draft-2）迁移验收拆成两件：MCP 内只读 `authority_audit`（守恒 / 重复 / 覆盖自检）+ MCP 外隔离 `reimport_verify`（临时库重导入比对）。只读工具不做重导入。
13.（draft-3）envelope 带 `authority_revision`（`last_completed_run_id` / `committed_at` / `max_observed_at`）；跨工具严格对账用 `as_of_run_id` snapshot token，首版识别并 warn。
14.（draft-3）内部 SQL 排障工具的脱敏在 SQLite authorizer 按来源表 + 列拒绝 + 脱敏 view allowlist；结果列名扫描仅第二层防线。
