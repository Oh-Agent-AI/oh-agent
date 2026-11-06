# Agent Vitals Data MCP——实施计划

> **规格**：`AGENT_VITALS_DATA_MCP_SPEC.md`（draft-3，待冻结）
> **本文档**：把 spec 的 Phase M0–M5 拆成可勾选的工程增量——每项标落点文件、
> spec 章节、验收方式。执行循环（与 v0.9.1 实施计划同）：
> **实现 → 全量测试（cargo test + clippy + golden + `AGENT_VITALS_BIN` 差分）→
> subAgent 代码审查 → 修复 → commit**，每个增量一个收口点。
>
> 状态：✅ 完成 · 🔨 进行中 · ⬜ 未开始

---

## M0 决策裁决（spec §13 M0 D1–D10）

spec 把 D1–D10 列为「冻结前必须拍板」。本节按 spec 的推荐默认逐条裁决，
供实施依据；有异议在评审时改这里，不在代码里留隐式默认。

| 决策 | 裁决 | 依据 / 落点 |
|---|---|---|
| **D1 传输层 + 线协议** | 手写最小 JSON-RPC 2.0 over stdio（stdlib + `serde_json`）。MCP protocol version = `"2025-06-18"`（支持 `structuredContent`）。逐行 JSON framing（`\n` 分隔，UTF-8）。方法集 = `initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `ping`。业务错误走 `tools/call` 结果的 `isError: true` + envelope，不塞 JSON-RPC error。stdin EOF → flush stderr + 关连接 + exit 0。单连接串行。 | spec §6.4；`apps/cli/src/mcp/` |
| **D2 金额精度** | `MoneyMinor { amount_minor: i64, currency, basis }`。舍入：本次查询最细上报维度一次 `pyround(× 10^minor_digits)`，父层 = 子项整数和。落点 = `agent-vitals-data` / `agent-vitals-runtime`，三消费面同源读。`minor_digits` 由 currency 决定（CNY/USD=2）。 | spec §5.1 规则 5；增量 2（首个带金额工具落地时） |
| **D3 模型归属范围** | `(harness, raw_model, billing_route)` 语义。过滤字段 `models: [{kind, harness, value}]`，v1 仅 `kind="harness_raw"`；响应带 `identity_kind`。canonical 归一表不拉进 v0.9.1。 | spec §5.1 规则 4、§7.2 |
| **D4 内部工具 gating** | cargo feature `mcp-internal`（`apps/cli`）。公开构建编译期排除 `authority_audit` / `query_sql_readonly`。 | spec §8；`apps/cli/Cargo.toml` |
| **D5 `session_ref` salt** | `<data_home>/.mcp-session-salt`（32 字节随机，权限 `0600`），首次 `data-mcp serve` 时生成。HMAC-SHA256（`sha2` 已是依赖）。**不进权威库**。 | spec §9.2；增量 6（session 工具） |
| **D6 迁移验收工具** | 拆分：MCP 内只读 `authority_audit`（守恒/重复/覆盖/`authority_revision` 自检）+ MCP 外 `agent-vitals data reimport-verify`（临时库重导入比对，非 MCP 工具）。 | spec §8.1；增量 7 |
| **D7 `authority_revision`** | envelope 字段 `{last_completed_run_id, committed_at, max_observed_at}`，从 `sync_runs` 最近 `succeeded` 行 + 查询窗口 `MAX(event_ts_ms)` 取。`as_of_run_id` 入参：v1 只「识别并 warn」，钉截面 M2 补。 | spec §6.1、§10；增量 1（envelope） |
| **D8 summary 输出范围** | 保留 spec 承诺的完整输出，把会话数 / 活跃小时 / `group_by=model` / 逐日趋势 / 月底预测 / 成本占比作为**新增聚合查询**逐项列进增量 3，工作量按新查询计。 | spec §7.3/§7.4；增量 3 |
| **D9 `query_sql_readonly` 脱敏** | 若实现：SQLite `authorizer` 按来源表 + 列拒绝 + 脱敏 view allowlist；结果列名扫描仅第二层。默认**不实现**（不在 v1 兼容承诺内）。 | spec §8.2；延后 |
| **D10 JSON Schema 交付** | 每个工具的 `inputSchema` / `outputSchema` 作为 `serde_json::Value` 常量随工具定义，`tools/list` 直出；用 `additionalProperties: false` + 显式枚举。校验测试 = 每个 schema 能被 `serde_json` 解析且结构自洽（M0 退出条件）。 | spec §6.4、§13 M0；每个增量随工具 |

---

## 增量拆分

spec 的 Phase 是能力里程碑；这里是可 commit 的工程增量，每个都过完整循环。

> **2026-09-08**：增量 1 / 2 / 7.5 已 rebase 到 `main`（在 v0.9.1 SQL 权威迁移
> Phase 4.3 全部落地之后），与 schema v2（`harness_runtime_snapshots`）+ Stage 5b
> 退役对齐：`data_status` 走 `mcp::data_status_report`（CLI/MCP 同源）、损坏恢复
> 提示改为 `rm sqlite3* && data-migrate`、脱敏 view 版本无关幂等重建。
>
> **真机验证抓出增量 2 的两个缺陷（已修）**：① `usage_hourly group_by=harness`
> 曾走 `hourly_by_harness`（导航查询只回单个 i64 总量），总量被塞进 `output_tokens`
> 槽 → `total_output_tokens == total_tokens`、逐桶亦然；② `group_by=model` 不带
> `harnesses` 参数曾静默返回空 series（违反 schema「empty = all harnesses」承诺 + 诚实
> 返回原则）。两个 `group_by` 现统一走 `hourly_by_harness_model`（真四桶 + 空 harness
> 列表即全 wired）。真机对账：`usage_hourly` 逐执行环境总量 + output 与 CLI `data
> daily --date` 逐值相等；harness 轴 == model 轴按执行环境求和（守恒）。回归测试
> `harness_axis_reports_real_output_split_and_model_axis_needs_no_harnesses_arg`。
>
> 全 gate 绿（`cargo test` + `clippy -D warnings` 双 feature + `unittest discover
> tests` + golden）。**M1 尚未完成**：增量 3 / 4 / 5 未开始；M0 D1–D10 只有
> D2/D3/D4/D9 ack。`usage_hourly` 的 `metrics="cost"`（MoneyMinor 逐小时）按
> spec §7.2 校正推迟到 `cost_breakdown`（M3）；`group_by=provider` v1 与 model
> 等价（provider_id 归一表 §3.4 未建，schema 描述已注明）。
>
> **2026-09-08 续**：用户要求提前做 Q04 + Q12（`docs/AGENT_VITALS_DATA_MCP_
> SMOKE_TEST_SPEC.md` 缺口 #F4 / #F6）。落地：`data-reimport-verify` CLI（增量 7）、
> `sessions_search` + `session_detail` + `session_ref` HMAC 基元（增量 8a，M3 前置
> 提前）。真机冒烟：Q04 峰值下钻逐会话 token 之和 == `usage_hourly` 峰值小时
> total（claude 22点 4 会话 225857332 / codex 12点 1 会话 10239273）；Q12
> `data-reimport-verify` byte-identical。EXACT 11 / EXPLAINED 1 / PARTIAL 2 /
> BLOCKED 6（Q06–Q10 / Q13）/ MISMATCH 0。

| # | 增量 | spec 对应 | 状态 |
|---|---|---|---|
| **1** | 传输层 + envelope + `data_status` | M1 起步 | ✅ (rebased `fde1c09` + `e2da5d6`) |
| **2** | `MoneyMinor` 精确投影 + `usage_hourly`（执行环境轴 + model/provider 轴 + 逐小时成本） + S2/S4/S5/S7 review follow-ups | M1 | ✅ (rebased `4bf7433`) |
| 3 | `summary_daily` + `summary_monthly`（含会话数 / 活跃小时 / 逐日趋势 / 月底预测 / 占比新查询） | M1 | ⬜ |
| 4 | `data_quality_issues` + code-aware 脱敏 allowlist | M1 | ⬜ |
| 5 | M1 收口：M01–M08 / M13–M18 契约测试 + 三消费面 parity（M15）+ 真机 U01/U02/U08 + 缺口 #F1（`freshness.stale_harnesses` 落地） | M1 退出 | ⬜ |
| 6 | `authority_revision` `as_of_run_id` 钉截面 + `authority_audit`（`mcp-internal`）| M2 | ⬜ |
| **7** | **`reimport_verify`（`agent-vitals data-reimport-verify` CLI，MCP 外）** —— 用户 2026-09-08 提前做（Q12） | M2 退出 | ✅ (`4c7f75b`) |
| **7.5** | **`query_sql_readonly`（内部 MCP 工具，让其他 Agent 调试用）** | M2 并行 | ✅ (rebased `e73a46a`，`mcp-internal` only) |
| **8a** | **`sessions_search` + `session_detail` + `session_ref` HMAC 基元（D5）+ session 索引 v1** —— 用户 2026-09-08 提前做（Q04）。时间线的失败/错误事件富化留 M4（`workflow_events`）。 | M3 前置 | ✅ (`?`) |
| 8+ | M3：`cost_breakdown` + 变化因子分解 + 历史价重放（`authority_query` 按事实时点选价版） | M3 | ⬜ |
| … | M4：`workflow_events` 管线 + `issues_summary` / `skills_summary` | M4 | ⬜ |
| … | M5：公开/内部构建分离 + 打包 + 发布文档 | M5 | ⬜ |

### 增量 1 review disposition（subAgent `a25df914c9a1c27ec`）

| # | 严重度 | 处置 |
|---|---|---|
| S1 损坏库走错路径（corrupt/schema 不符先前返回带 `unavailable` 的成功响应） | should-fix → **已修（合入前）** | `data_status::run` 直接 `Err(ToolError::new("database_unreadable" \| "schema_migration_required", ...))`；新增 `corrupt_db_is_a_business_error_not_silent_unavailable` + `schema_mismatch_is_a_business_error` 两单测；真机 smoke 已验（isError=True + database_unreadable）。 |
| S2 `AuthorityHandle::authority_state` 返回类型误导 | should-fix → **延后** | 增量 2 改成 `Result<&'static str, UnavailableReason>` 或让现有工具直接走 `authority_state_for(data_home)` helper。 |
| S3 `error_envelope` 硬编码 `"1"` 与 `ENVELOPE_SCHEMA_VERSION` 不同源 | should-fix → **已修（合入前）** | 改用常量 + `error_envelope_uses_envelope_schema_version_constant` 单测。 |
| S4 `authority_revision.max_observed_at` 缺 `observation_kind != 'legacy_aggregate'` 过滤 | should-fix → **延后** | 增量 2 修（`MAX(event_ts_ms) FROM usage_facts WHERE deleted_at_ms IS NULL AND observation_kind != 'legacy_aggregate'`）。 |
| S5 `validate_args` 对未设 `additionalProperties:false` 放行 | should-fix → **延后** | 增量 2 加 `assert_eq!` fail-fast（debug_assert）+ 启动期 lint。 |
| S6 `by_harness[*].facts` 排除 legacy_aggregate 但 `data_status` 用户期望全表 | should-fix → **延后** | 增量 2 拆 `live_facts` / `legacy_aggregates` 两栏。 |
| S7 `PRAGMA integrity_check` 每次调用都跑零缓存 | should-fix → **延后** | 增量 2 加频次 warn；增量 5/6 接 `data-status-health` watcher 时再做进程级 60s memo（与 `runtime::summary::codex_merged_cached` 同形）。 |
| N1 `schema_version()` 损坏时静默回零 | nit → **延后** | 增量 2 直接 `Err` 让 `error_envelope` 接管。 |
| N2 `mcp-internal` feature 在 `apps/cli/Cargo.toml` 占位 | nit → 接受 | 增量 6 落地时加 `#[cfg(feature = "mcp-internal")]` 引用即可。 |

---

## 增量 1：传输层 + envelope + `data_status`

**目标**：`agent-vitals data-mcp serve` 起一个本机 stdio MCP server，能完成
握手、`tools/list`、`ping`，并把 `data_status` 作为第一个工具跑通——为后续
工具钉死 envelope 形状、错误映射、authority 状态/revision 的读取方式。

### 落点

- **`crates/agent-vitals-data/src/authority.rs`**：新增 `AuthorityDb::open_readonly(db_path)`
  ——`SQLITE_OPEN_READ_ONLY`，**不建库、不跑 DDL**；`AuthorityError` 加
  `MissingFile` / `Corrupt` / `OlderSchema { found }` 变体（typed，供错误码映射）。
- **`crates/agent-vitals-runtime/src/mcp/`**（工具应用层，spec §5.2）：
  - `mod.rs`：`Envelope` 构建、`AuthorityHandle`（只读打开 + `authority_state` +
    `authority_revision` + `data_version`）、`ToolError`（映射 spec §11 错误码）、
    `tool_specs()`（`[ToolSpec { name, description, input_schema, output_schema }]`）、
    `dispatch(name, args, data_home) -> Result<Value /*envelope*/, ToolError>`。
  - `data_status.rs`：从 `apps/cli/src/main.rs` 抽出的 `data-status` 查询
    + spec §7.1 要求补的逐执行环境 `GROUP BY harness`。
- **`apps/cli/src/mcp.rs`**（传输层）：`serve()` stdio 循环 + JSON-RPC 编解码
  + method dispatch + 错误映射。
- **`apps/cli/src/main.rs`**：`DataMcp { action: Serve }` 命令（→ `data-mcp serve`）
  + handler 调 `mcp::serve()`。
- **`apps/cli/Cargo.toml`**：`[features] mcp-internal = []`（本增量只声明，不用）。
- **`apps/cli/src/main.rs` `Cmd::DataStatus` handler**：改调
  `agent_vitals_runtime::mcp::data_status(...)` 的 `data` 部分（去重，保证 CLI/MCP 同源）。

### 验收

- Rust 单元：`open_readonly` 六态（缺文件→MissingFile / 正常 / 损坏→Corrupt /
  新版本→NewerSchema / 旧版本→OlderSchema / 只读连接写入失败）；envelope 形状
  （必含 `schema_version` / `data_version` / `authority_state` / `authority_revision` /
  `generated_at` / `timezone` / `coverage` / `freshness` / `warnings` / `data`）；
  `data_status` 空库 vs 有数据。
- Rust 集成（`apps/cli/tests/`）：喂 JSON-RPC 到 `serve` 的 stdin，断言
  `initialize` 回 protocol version + `tools` capability；`initialize` 前发别的方法 →
  JSON-RPC error；`tools/list` 含 `data_status` schema；`tools/call data_status` →
  envelope；未知方法 → `-32601`；stdin EOF → exit 0；`stdout` 无非协议行（M18）。
- 差分：`AGENT_VITALS_BIN` 下 `data-mcp serve` 的 `data_status.data` 与
  `data-status --json` 的核心字段逐值相等（M15 的 data_status 切片）。
- 全量 `cargo test` + `cargo clippy --release --all-targets -- -D warnings` + golden 15/15
  + `AGENT_VITALS_BIN` python 差分不回归。

### 收口（已完成，2026-09-07）

subAgent 审查（envelope 契约、错误映射、只读边界、CLI/MCP 去重是否真的同源、
stdout 纪律）→ 修复 S1/S3 → commit `dcb672e` + `5b8e38e`。

- 全量 cargo test + clippy -D warnings 全绿
- golden 15/15 字节一致
- Python AGENT_VITALS_BIN 差分 1161 测试 OK
- 真机 smoke：handshake / `tools/list` 携带 inputSchema+outputSchema / `tools/call data_status` 端出完整 envelope（`schema_version` / `data_version` / `authority_state` / `authority_revision` / `coverage` / `freshness` / `warnings` / `data`）/ 损坏库返回 `isError:true` + `database_unreadable`

---

## 增量 2：`MoneyMinor` 精确投影 + `usage_hourly`（含 review S2/S4/S5/S7 follow-ups）

**目标**：把 spec §5.1.1 `MoneyMinor` 三元组（amount_minor 整数 + currency + basis）
作为权威读面统一投影落地，MCP / CLI / Tauri 三消费面同源读（不再各自乘回分）；
并把第一个时间窗口工具 `usage_hourly` 端到端跑通——执行环境 / model / provider 三轴
+ 逐小时 `MoneyMinor` 成本（24 桶含零）。同时并入增量 1 review 的 4 处
should-fix（S2 / S4 / S5 / S7）：

- S2 `AuthorityHandle::authority_state` 改成 `Result<&'static str, UnavailableReason>`
- S4 `authority_revision.max_observed_at` SQL 排除 `observation_kind='legacy_aggregate'`
- S5 `validate_args` 对未设 `additionalProperties:false` 强制 fail-fast
- S7 `data_status` 调用频次 > N 记 stderr warn（worker 60s memo 留到增量 5/6）

### 落点

- **`crates/agent-vitals-domain/src/domain/data_contract.rs`**：新增 `MoneyMinor`
  类型 + JSON 序列化 + 构造器（Rust 风格伪类型，运行时落 `agent-vitals-runtime`
  下，不引新 crate）。
- **`crates/agent-vitals-runtime/src/money.rs`**（新模块）：
  - `pub fn minor_digits_for(currency: &str) -> u32`（CNY/USD=2, JPY=0, 其它查 ISO 4217 表 + 兜底 2）。
  - `pub fn from_f64(value: f64, currency: &str, basis: BillingBasis) -> MoneyMinor`（一次 `pyround(× 10^minor_digits)`；NaN/Inf 输入 → 业务错误 `internal_error`，不静默）。
  - `pub fn sum_minor(items: &[MoneyMinor]) -> Option<MoneyMinor>`（同 `currency` + `basis` 求和；跨币返回 `None` + warn，**不**伪造总金额）。
- **`crates/agent-vitals-data/src/authority_query.rs`**：
  - 新增 `hourly_by_harness_and_model(conn, start_ms, end_ms, harnesses, models) -> Result<BTreeMap<(String, String, String), HourlyCell>, AuthorityError>`——三执行环境「小时 × harness × raw_model」聚合 + token 之和 + cost（`MoneyMinor` 字段）。复用 `hourly_by_harness` 的窗口算术（`(event_ts_ms + BEIJING_OFFSET_MS) / HOUR_MS % 24`）。
  - **修正 S4**：`authority_state_for` / `authority_revision` 内的 SQL 加 `observation_kind != 'legacy_aggregate'`（目前 envelope + per_harness 都过滤了，只有 revision 还漏）。
  - 已有 `hourly_by_harness` 加 `cost` 字段——可选；M1 阶段先用 model 轴查，执行环境轴的 cost 留给后续工具。
- **`crates/agent-vitals-runtime/src/mcp/usage_hourly.rs`**（新工具）：
  - `ToolSpec`（inputSchema：`{date: YYYY-MM-DD, group_by: enum, harnesses?, models?, metrics?, as_of_run_id?}`，所有参数 `additionalProperties: false`）。
  - `run(args, data_home) -> Result<Value, ToolError>`：
    1. 参数解析 + schema 校验（参数错误 → `invalid_argument`）。
    2. `AuthorityHandle::open(data_home)` 取只读 conn（**先**改正 S2：返回 `Result` 而非 panic）。
    3. 调 `hourly_by_harness_and_model`（或 `hourly_by_harness` for `group_by=harness`）拼 envelope。
    4. 窗口拉满 24 桶含零值（缺桶填 `null` + warning）。
    5. `as_of_run_id` 处理按 §6.4.1：drift → `warnings:[{code:"snapshot_drift",...}]`，不存在 → `invalid_argument`。
- **`crates/agent-vitals-runtime/src/mcp/mod.rs`**：
  - `authority_revision` 加 `legacy_aggregate` 过滤（**S4 fix**——已落 + 测试 `authority_revision_max_observed_excludes_legacy_aggregate`）。
  - `validate_args` 改成 **runtime** `assert`-类返回（**S5 fix**——`debug_assert_eq!` 在 release 是 no-op，不能用）。
  - **`AuthorityHandle::authority_state` 改 `Result<&'static str, UnavailableReason>`（S2）——延后**：保留 `&'static str`，调用点（`data_status`/`usage_hourly`）走 helper `authority_state_for(data_home)`——已对齐 spec §6.1 的两态（库能打开 ⇒ `enabled`/`candidate`）；不可达态在打开时 fail-fast。
  - 频次日志：超过 50 calls / 分钟 → stderr warn（**S7 fix**——延后到增量 5/6 worker memo 那次）。
- **`crates/agent-vitals-runtime/src/mcp/mod.rs::tool_specs()`**：注册 `usage_hourly`。
- **`apps/cli/src/main.rs`**：现有 `Cmd::Data { action: DataAction::Coverage | Daily | Authority }` 不变；`data-mcp serve` 通过 `tool_specs()` 自动暴露 `usage_hourly`——CLI 端不需要新子命令。
- **测试**：
  - `money` 模块：`minor_digits_for("CNY")==2`、`from_f64(0.125, "CNY", MeteredActual).amount_minor==13`（银行家舍入；0.125 → 12.5 → 13）。
  - `hourly_by_harness_and_model`：3 执行环境 × 2 模型 × 24 桶 fixture，守恒（小时累加 == 日累计）+ 北京小时边界。
  - `usage_hourly`：空库（24 个 `null` + `coverage.covered_to=null`）+ drift warn + invalid_argument（多余字段、坏 enum、坏日期）+ 真机 fixture 守恒。
  - `validate_args`：缺 `additionalProperties:false` 触发 panic（debug_assert）。
  - `authority_revision`：fixture 含 legacy_aggregate 行时 `max_observed_at` ≠ legacy 行的 `event_ts_ms`。
- **文档**：实施计划本节同步记录 M0 D2 ack（`MoneyMinor` 落地）+ D3 ack（`models.kind="harness_raw"` + `identity_kind` 落地）。

### 验收

- Rust 单元：`money::minor_digits_for` 覆盖 `CNY/USD/JPY/EUR`；`from_f64` 银行家舍入；`sum_minor` 跨币返 None。
- Rust 集成：`usage_hourly` 三执行环境 × 双模型 × 24 桶 fixture，每小时与日累计守恒。
- 三消费面 parity：MCP `usage_hourly.data.totals_by_currency_basis` 与 `data coverage` / `data daily`（按日累计聚合）逐值 `amount_minor` 相等。
- 错误路径：corrupt DB → `isError:true` + `database_unreadable`（与 data_status 同形态，已 S1 验证）；缺 `additionalProperties:false` → debug_assert panic 触发（**S5**）；`as_of_run_id` drift → `warnings:[snapshot_drift]`。
- 全量 gate：`cargo test --workspace`、`cargo clippy --workspace --all-targets -D warnings`、golden 15/15、`AGENT_VITALS_BIN` 差分 + 真机 U01/U02（小时曲线 24 桶 / 峰值小时）。

### 收口

subAgent 审查（MoneyMinor 三消费面逐值相等、`from_f64` 舍入点、`hourly_by_harness_and_model` 索引命中、`as_of_run_id` drift 检测、`validate_args` fail-fast 强度、`usage_hourly` 输出 schema 闭合） → 修复 → commit。

---

## 增量 7.5：`query_sql_readonly`（内部 MCP 工具）

**目标**：让其他 Agent 在 review / 调试 SQL 路径时不依赖 shell 直连权威库——通过 MCP 走受限的只读 SELECT。**仅 `mcp-internal` feature 构建**（不在 v1 兼容承诺内，公开二进制不含此工具——用户 2026-09-07 决定提前做，让 debug Agent 立即可用）。

**审查基调**（用户 2026-09-08 校正）：**给本地的 Agent 做数据分析**——所以**不必过度严格**。

- 写入类（`Insert` / `Update` / `Delete` / 任何 DDL / 事务 / PRAGMA / ATTACH）**仍必须 deny**——这是数据完整性的底线；`mcp-internal` feature 的存在就是显式声明「开发 Agent 用」。
- 敏感列 deny：保留。Agent 看 `native_session_id` / `path_hash` 没有业务价值，反而可能被发散——这是隐私边界。
- 函数 deny 收紧到「能写文件 / 装扩展 / 改变行为的」：`load_extension` / `readfile` / `writefile` / `edit`（SQLite 3.38+ virtual table）。**放行** `random` / `randomblob` / `zeroblob`（分析 Agent 想看随机抽样 / 哈希特征——合理）+ `json_*` 表达式（运营查询常用）。
- 字符串字面量 / 注释里的 `LIMIT` 误匹配：当前实现是字符级子串匹配，已经在 `colimit_audit` 词边界上做了 guard。**进一步严格（双引号转义扫描）**超出"本地 Agent 工具"的范围，先不做。
- 1 MiB 行数 / 时间预算保留——是 prod safety guard，**不**因为"放宽"就关。

> **底线**：authorizer 的写入 deny + 敏感列 deny 必须保持；其它收紧项（函数黑名单、字符串转义扫描）按"是不是真会带来安全风险"判断，不是按"理论上能绕过"判断。

**威胁模型**（spec §8.2）：
- 调用者可能用 `AS` / 表达式 / 字符串拼接 / `json_extract` 把 `native_session_id` / `path_hash` / `machine_namespace` 等敏感字段改名后返回——所以**仅结果列名扫描**不够（增量 1 review P1-5 已警示）。
- 来源层 authorizer（`SQLITE_READ` 回调）按 **来源表 + 列名** 拒绝，是**唯一可靠的**屏障。
- 退路：所有合法查询只能命中一组**脱敏只读 view**（`v_facts_safe` / `v_sessions_safe` / `v_data_quality_safe` / `v_sync_runs_safe`），view 定义里就 `SELECT` 不含敏感列。
- 结果列名扫描只作为「view 内部某列意外被改」的第二层防线。

### 落点

- **`crates/agent-vitals-data/src/authority.rs`**：新增 `pub fn make_readonly_connection(db_path) -> Result<Connection, AuthorityError>` ——在 `open_readonly` 基础上挂 `sqlite3_set_authorizer`：
  - `SQLITE_READ` on `usage_facts.native_session_id` / `usage_facts.source_event_id` / `usage_facts.source_id`（与 `source_files.path_hash` 拼接可反推路径）→ deny
  - `SQLITE_READ` on `sessions.native_session_id` / `sessions.machine_namespace` / `sessions.session_key` / `source_files.path_hash` → deny
  - `SQLITE_INSERT` / `SQLITE_UPDATE` / `SQLITE_DELETE` / `SQLITE_PRAGMA` / `SQLITE_ATTACH` / `SQLITE_DETACH` / `SQLITE_TRANSACTION` / `SQLITE_SAVEPOINT` / `SQLITE_REPLACE` → 一律 deny
  - `SQLITE_FUNCTION` on 任何非 `sqlite3_builtin_*` 函数 → deny（禁 `load_extension` / 自定义函数；SQLite 内置 whitelist：`avg/sum/count/min/max/abs/round/group_concat/json_extract/json_array_length/typeof/coalesce/nullif/ifnull/upper/lower/length/substr/replace/trim/ltrim/rtrim/printf/strftime/datetime/zeroblob/random/unicode/abs/sign/round/floor/ceil`——其它都 deny）
  - `SQLITE_SELECT` 限定：col-attr 至少有一个来自 `usage_facts` / `sessions` / `source_files` / `pricing_snapshots` / `harness_bills` / `sync_runs` / `data_quality_issues` / `migrations` / `budget_config` / `budget_snoozes` / `workflow_events` **或** v_* view；其它来源 deny
- **`crates/agent-vitals-data/src/safe_views.rs`**（新模块）：建库时同步建（DDL 入 `SCHEMA_V1` const 里和现有 12 表一起）。
  - `v_facts_safe`：SELECT 14 列（不含 `native_session_id` / `machine_namespace` / `source_event_id` / `source_id` / `session_key`）
  - `v_sessions_safe`：SELECT 6 列（不含 `native_session_id` / `machine_namespace`）
  - `v_data_quality_safe`：SELECT 8 列（不含 `detail_json`——可能含 raw 模型名或路径片段）
  - `v_sync_runs_safe`：SELECT 7 列（不含 `error_detail`）
- **`crates/agent-vitals-runtime/src/mcp/query_sql_readonly.rs`**（新工具，仅 `#[cfg(feature = "mcp-internal")]`）：
  - `ToolSpec`：input = `{ sql: string, max_rows?: int (default 200, max 200), timeout_ms?: int (default 3000, max 30000) }`，`additionalProperties: false`
  - `run(args, data_home) -> Result<Value, ToolError>`：
  1. **预处理**：`sqlite3_prepare_v2`（rusqlite `prepare`）一次——本身就是单语句且不允许 `;` 多语句（SQLite prepare 的 documented 行为）。校验首 token 非 `EXPLAIN`/`ATTACH`/`PRAGMA` 关键字（不区分大小写）。
  2. **执行**：另开只读连接 + authorizer + `busy_timeout(3000)`；`query_map` 取行。
  3. **行数限制**：prepare 时挂 `LIMIT max_rows` 自动追加——SQLite prepare 阶段裁剪，**不让出超过 max_rows 的行**。用户传原 `LIMIT 10000` → 改写为 `LIMIT max_rows`。
  4. **响应体限制**：估算 JSON 序列化字节数 > 1MiB → 截断 + `warnings:[{code:"result_truncated", ...}]`。
  5. 返回 `data = { columns: [string], rows: [[Value]], row_count, sql_safe (改写后), elapsed_ms }`，envelope 套 spec §6。
- **`crates/agent-vitals-runtime/src/mcp/mod.rs`**：
  - `#[cfg(feature = "mcp-internal")] mod query_sql_readonly;` + 工具注册 + 分发（都包 cfg）。
- **测试**（**测试本身也包 cfg**——公开构建不编译）：
  - 安全（9 条）：`SELECT native_session_id FROM usage_facts` / `SELECT * FROM usage_facts` / `INSERT INTO usage_facts ...` / `DELETE FROM usage_facts WHERE 1=1` / `UPDATE usage_facts SET ...` / `SELECT load_extension('/tmp/x')` / `SELECT 1; SELECT 2` / `SELECT * FROM pragma_compile_options()` / `SELECT * FROM sqlite_master` → 都拒
  - 功能：合法 `SELECT count(*) FROM v_facts_safe` / `SELECT harness, SUM(...) FROM v_facts_safe GROUP BY harness` / `WITH cte AS (...) SELECT ... FROM v_facts_safe` → 都通过
  - 上限：`SELECT * FROM v_facts_safe` 改写 LIMIT 200 → 不返 201+ 行
  - 脱敏：所有 view 输出 JSON Schema 反查，**不**含 `native_session_id` / `machine_namespace` / `path_hash` 字段名
- **审查重点（subAgent 必看）**：
  - authorizer callback 是不是真的 deny 了所有写入类 + 所有敏感列
  - 内置函数 whitelist 是否漏了 `load_extension` / `json_*` / `random` / `unicode` 之类
  - 多语句拒绝：`prepare` 默认拒绝 `;` 多语句——写测试断言
  - LIMIT 改写逻辑：用户原 SQL 不带 LIMIT 时正确追加；带 LIMIT 大于 max_rows 时正确截到 max_rows（`min(user_limit, max_rows)`）
  - 作者列名：v_* view 实际 SELECT 列表与 authorizer deny 列对比

**验收**：
- cargo test：authorizer 安全矩阵 + 合法查询 + 行数 / 体积极限 + view 脱敏 + cfg 守卫（公开构建 `cargo build --release -p agent-vitals` 无此工具）
- clippy `-D warnings` clean（含 `--features mcp-internal`）
- 真机：`cargo run --features mcp-internal -- data-mcp serve`；`tools/list` 多出 `query_sql_readonly`；合法 `SELECT * FROM v_facts_safe LIMIT 10` 返10 行；`SELECT native_session_id FROM usage_facts` 拒；`INSERT INTO ...` 拒
- 公开构建验证：`cargo tree -e features --depth 1 -p agent-vitals` 不含 query_sql_readonly 模块符号；`tools/list` JSON 不含此工具名
- 真机 leak 测试：调 `SELECT * FROM v_facts_safe`，grep响应含 `native_session_id` → 必须零命中

**收口**：subAgent 重点审 authorizer callback 完整性（spec §8.2 P1-5）→ 修复 → commit（commit message 标注 `[mcp-internal]`，让 reviewer 一眼看到这个工具不进 v1 兼容承诺）。
