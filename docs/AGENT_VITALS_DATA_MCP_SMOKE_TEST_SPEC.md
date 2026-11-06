# Agent Vitals Data MCP 真机可用性冒烟测试规格

> 状态：v4（2026-09-13）——`authority_audit`（S4.5）与 `cost_breakdown`（Q05/Q13）落地并纳入内部 MCP 冒烟。
> 脚本：`tests/mcp_smoke.py`。上位规格：`AGENT_VITALS_DATA_MCP_SPEC.md`。

## 0. 目的与定位

把**用户实际会问的数据问题**逐条打到 `agent-vitals data-mcp serve` 上，在**真机
`~/.agent-vitals` 数据**上回答三个问题：

1. 这个问题今天能不能通过 MCP 回答？（能 / 部分 / 被未实现的工具挡住）
2. 能回答的，数值对不对？——与 CLI（`agent-vitals data …`）**逐值对账**，不是"看起来差不多"。
3. 回答里有没有泄露不该泄露的东西（本机路径 / 原生会话 ID / 对话正文）。

这是**冒烟**，不是契约测试。契约测试（`M01–M19`）在 `cargo test` 里用受控
fixture 跑；本规格用真机数据做端到端可用性巡检，抓的是"工具在真实数据形状上
到底行不行"——例如增量 2 的 `usage_hourly` 单测全绿，真机一跑就暴露
`total_output_tokens` 是垃圾（`d3251ea` 修）。

## 1. 参考基准

冒烟用例直接取自两份规格里的用户查询集，不另造：

| 来源 | 内容 | 本规格如何用 |
|---|---|---|
| `AGENT_VITALS_V0_9_1_SQL_AUTHORITY_MIGRATION_SPEC.md` §4.1 | 面向用户的查询目录（7 类能力 + 下钻链路） | 冒烟矩阵的"能力"分组 |
| 同上 §4.2 | **Q01–Q15 用户查询验收用例**（既是产品验收也是 e2e fixture） | **冒烟矩阵的主轴**——每条 Q 一行 |
| `AGENT_VITALS_DATA_MCP_SPEC.md` §3 | 用户场景（使用节奏 / 成本与预算 / 问题与效率 / 数据可信度） | 补 §4.2 未覆盖的可信度问题（S4.x） |
| 同上 §12.2 | U01–U10（§4.2 的 MCP 工具投影） | 工具映射参考 |
| 同上 §12.1 | M01–M19 契约测试 | 协议 / 安全冒烟（M07 / M12 / M18 / M19）从中取 |

§4.2 的 Q 分三档，本规格沿用：**Q01–Q05 首批可见价值**；**Q06–Q10 依赖
`workflow_events`**；**Q11–Q15 是所有查询成立的可信度底线**。

## 2. 前置条件

```bash
# 公开构建（data_status / usage_hourly）
cargo build --release
python3 tests/mcp_smoke.py --bin target/release/agent-vitals

# 内部构建（+ query_sql_readonly，跑得动更多代理查询与 M19）
cargo build --release --features mcp-internal
python3 tests/mcp_smoke.py --bin target/release/agent-vitals --internal

# 隔离数据根（默认真机 ~/.agent-vitals）
AGENT_VITALS_HOME=/path/to/fixture python3 tests/mcp_smoke.py --bin … [--internal]
```

真机跑之前权威库必须是 schema v2 且 `sql_authority_enabled`：

```bash
agent-vitals data-status   # health: ok · schema v2 · sql_authority_enabled true
agent-vitals sync-facts    # 让 freshness 是新的
```

## 3. 判定口径（承 `AGENT_VITALS_DATA_MCP_SPEC.md` §12.3）

| 判定 | 含义 | 脚本退出码影响 |
|---|---|---|
| `EXACT` | MCP 返回值与 CLI 对照项**逐值相等**（token 整数、金额 `amount_minor` 整数） | — |
| `EXPLAINED` | 有差异，但**有书面原因**（已知实现缺口、口径差、时区窗设计差） | — |
| `MISMATCH` | 未解释差异 | **exit 1**——必须开 data quality issue 或修，禁止调容差关掉 |
| `PARTIAL` | 目标工具在，但只覆盖问题的一部分（例如有 token 维、缺金额维） | — |
| `BLOCKED` | 目标工具**未实现**（附解锁里程碑） | — |

## 4. 冒烟矩阵

每行：**目标工具**（spec §7 承诺的）· **今日可跑**（现在实际能打的调用，含
`query_sql_readonly` 代理）· **CLI 对照** · **判据** · **当前判定**。

### 4.1 Q01–Q05：首批可见价值

| Q | 目标工具 | 今日可跑 | CLI 对照 | 判据 | 判定 |
|---|---|---|---|---|---|
| **Q01** 今天各模型小时曲线 | `usage_hourly(group_by=model)` | 同 ✅ | `data daily --date <today> --json` | 每序列 24 桶；`peak_hour` 在场且是最大桶；model 轴按 harness 求和 == harness 轴（守恒）；MCP 逐执行环境 total == CLI `tokens_by_harness` | **EXACT** |
| **Q02** 今天各执行环境小时曲线 + 峰值 | `usage_hourly(group_by=harness)` | 同 ✅ | `data daily` | 执行环境曲线分开；`totals_by_harness` 之和 == 全局；`peak_hour_by_harness` 自洽 | **EXACT** |
| **Q03** 北京月/日界归属 | `usage_hourly` / `summary_monthly` | `usage_hourly(date=<月初>)` ✅ | `data daily --date <月初>` | 月初 00 点桶（= UTC 前一天晚上）归属北京当日；逐执行环境 total == CLI | **EXACT** |
| **Q04** 峰值下钻到会话，token 合计==峰值 | `sessions_search` → `session_detail` | 同 ✅ | — | `usage_hourly` 给 `peak_hour` → `sessions_search(date, hour=peak)` 逐会话 total 之和 == 该小时 `usage_hourly` total == `data.window_total_tokens`，且 `has_more=false`；`session_detail(session_ref)` 反解 + 时间线；响应无原生 id / 路径 / `session_key` | **EXACT** |
| **Q05** 缺价卡模型不归零 | `cost_breakdown` | `cost_breakdown(from,to,group_by)` + `data-unresolved --json` | `data-unresolved` | 用量可见；成本 `unresolved`，不以 0 或估算冒充实付；`MoneyMinor` 金额保持整数且不跨币种/口径相加 | **EXACT**（2026-09-13 真机：40 行、25 个 unresolved 行，token 分区守恒、金额类型与脱敏通过） |

### 4.2 Q06–Q10：依赖 `workflow_events`

| Q | 目标工具 | 判定 |
|---|---|---|
| **Q06** 本周重复错误指纹聚为问题卡 | `issues_summary` | **PARTIAL**：已能按脱敏错误指纹/重复调用聚合，趋势与 token/cost 归因仍不完整 |
| **Q07** 连续失败后成功 = 一组重试链 | `issues_summary` | **PARTIAL**：已按同一会话/能力/脱敏调用形状配对失败→再次调用→成功；真实数据若缺少指纹或结束事件仍显式返回 partial/unknown |
| **Q08** Skill 成功率 + 样本不足判定 | `skills_summary` | **PARTIAL**：已按 `skill_invoked` 与 `skill_finished` 汇总成功/失败/未知，并报告结束事件与耗时覆盖；token/cost 关联和样本门槛仍不完整 |
| **Q09** Skill 版本回归识别 | `skills_summary` | **PARTIAL**：已按 `capability_version` 输出版本分桶，并在两个版本均满足最小样本且生命周期/耗时证据完整时计算基线→候选差异；真实窗口若版本数、样本或证据不足，明确返回 `unavailable` |
| **Q10** 会话时间线关联失败/峰值 | `session_detail` | **PARTIAL**：已返回独立脱敏 `workflow_timeline`，尚未把 workflow 事件硬归因到 token/cost 或峰值 |

`workflow_events` 已完成执行环境 wire 提取 → 脱敏指纹 → SQL writer → reader 的基础管线。
Q06、Q08、Q09、Q10 因此可以诚实返回部分结果；Q07 仍缺完整重试配对。任何覆盖不足都必须返回
`partial/unavailable`，不能用空列表冒充“没有问题”。

### 4.3 Q11–Q14：可信度底线

| Q | 目标工具 | 今日可跑 | 判据 | 判定 |
|---|---|---|---|---|
| **Q11** 执行环境 24h 未同步 → 标 stale/partial、列明缺失执行环境 | envelope `freshness.stale_harnesses` + `coverage.missing_harnesses` | `data_status` → `by_harness.covered_to` / `last_seen_at` | envelope 按最后一条实时事实将过期执行环境折成显式标记；扫描时间单独呈现 | **EXACT** |
| **Q12** 重复导入 + 中途中断 → 重跑查询逐值恒等 | `reimport_verify`（MCP 外命令） | `agent-vitals data-reimport-verify --json` ✅ | 两临时库各重放（round B 迁完首执行环境"崩溃"→ 重开清扫 → 完整迁移 → 幂等重跑），逐执行环境 × 北京月 `COUNT + 四桶 SUM` 全等；`interrupted_runs_swept ≥ 1`；**绝不碰生产库** | **EXACT** |
| **Q13** 调价日前后用正确价格版本 | `cost_breakdown` | `cost_breakdown(from,to)` + `query_sql_readonly(pricing_snapshots)`（internal） | 调价日前后分别用对应 `pricing_snapshots` 版本；历史不被当前价卡覆盖 | **EXACT**（2026-09-13 真机返回 2 个事实时点价格版本） |
| **Q14** 同 raw 模型名跨执行环境 | `usage_hourly` / `cost_breakdown` 的 `identity_kind` | `usage_hourly(group_by=model)` ✅ | 每序列显式 `identity_kind`；无法映射标 `unresolved`，不并入相似名 | **PARTIAL**（`identity_kind: "harness_raw"` 每序列在场，key 带 `harness` 消歧 ✅；canonical 归一 = v0.9.2+；`unresolved` 语义在 `data-unresolved` / M3） |
| **Q15** 数据质量问题筛选与脱敏下钻 | `data_quality_issues` | `status/codes/harnesses/from/to` + 稳定 cursor | reader 仅返回安全 issue ref、范围、状态和 code-aware allowlist detail；未知 code 只返回 code/count，原始 `detail_json` 不跨边界 | **EXACT** |

### 4.4 数据可信度补充（Data MCP §3.4，`data_status` 直接答）

| ID | 问题 | 调用 | 判据 | 判定 |
|---|---|---|---|---|
| **S4.1** 最近一次同步 | `data_status` | `freshness.last_successful_sync_at` + `authority_revision.committed_at` 在场且是 RFC3339 +08:00 | **EXACT** |
| **S4.2** 哪些执行环境/日期不完整 | `data_status` | `by_harness` 逐执行环境 `covered_from/covered_to/facts`；`coverage.missing_harnesses` | **EXACT**（原始数据齐；折成 stale 标记见 #F1） |
| **S4.3** 重复事实 / 无法识别模型 / 缺价 / 重导入差异 | `data_status` | `open_quality_issues_by_code`（真机：`legacy_aggregate`×3 / `reconcile_exception`×4 / `undated_residual`×1） | **EXACT** |
| **S4.4** 正式 SQL 权威库还是候选 | `data_status` | `authority_state ∈ {enabled, candidate}` + `data.sql_authority_enabled` + `schema_version` | **EXACT** |
| **S4.5** SQL 权威库当前是否自洽 | internal `authority_audit` | 真实事实 token 守恒（harness/model 轴，容差显式）、非负、重复组、孤儿 session、legacy/realtime 混轴、revision 未来性；只返回聚合证据，不泄露身份/路径；`verdict ∈ {exact, explained, mismatch}` | **EXACT**（本轮月范围 `2026-09`） |

## 5. 协议与安全冒烟（取自 M07 / M12 / M18 / M19）

| ID | 检查 | 判据 | 判定 |
|---|---|---|---|
| **M07** 敏感字段 | 扫 `data_status` + `usage_hourly` 全响应文本 | 不含 `native_session_id` / `path_hash` / `machine_namespace` / `session_key` / `source_event_id` / `/Users/` | **EXACT**（零命中） |
| **M12** 公开工具清单 | 公开构建 `tools/list` | **不含任意 SQL / 通用写入 / 同步迁移 / repair / `authority_audit`** 工具；`control_plane` 的读取及价格策略动作均为类型化 API，mutation 仍需 `--allow-local-writes`（不是「恰好 N 个」） | **EXACT** |
| **M18** 线协议 | JSON-RPC 序列 | `initialize` 前发别的 → JSON-RPC error（真机 `-32002`）；未知方法 → `-32601`；未知工具 → `-32602`；坏日期 / 多余字段 / 坏枚举 → `isError` + `invalid_argument`；stdin EOF → exit 0；stdout 无非协议行 | **EXACT** |
| **M19** `query_sql_readonly` 来源列拒绝（`--internal`） | authorizer 冒烟 | `SELECT native_session_id AS x` / `INSERT …` / `SELECT * FROM usage_facts` 全部 `invalid_argument`；`SELECT … FROM v_facts_safe GROUP BY harness` 放行 | **EXACT** |

## 6. 执行

```bash
python3 tests/mcp_smoke.py --bin <bin> [--internal] [--home <dir>]
```

### 6.1 v1.0 管理闭环（隔离库、显式写权限）

v1.0 的 AC26–AC28、AC13–AC14、AC10–AC12 还需要验证候选确认、声明版本、撤销、
重算任务、账单和双币种预算。它们不能通过公开只读 MCP 完成，因此 `mcp-internal`
额外注册 `billing_workflow` 与 `control_plane`；只有带 `--allow-local-writes` 的 MCP
进程才允许类型化写入。该开关不开放任意 SQL，不读执行环境原始日志，不允许任意 URL 或
通用文件写入；`control_plane.sync_facts` 是唯一显式的来源同步动作。

```bash
cargo build --release --features mcp-internal
python3 tests/mcp_v1_management_smoke.py --bin target/release/agent-vitals
```

控制面覆盖的隔离烟测：

```bash
python3 tests/mcp_control_plane_smoke.py --bin target/release/agent-vitals
```

该脚本验证自定义来源、执行环境排除、留存、统计时区、同步暂停、价格目录联网策略和安全删除确认；还验证
默认无写开关会拒绝 mutation。UI 导航、截图、文件选择器、更新页和系统保存对话框
属于产品壳层，不作为业务控制面 API。

脚本自行创建临时 `AGENT_VITALS_HOME`，通过真实 stdio JSON-RPC 依次执行 20 个动作，
验证候选→声明→预览→重算→撤销、harness bill、预算配置/静默及状态读取；默认不带
`--allow-local-writes` 的 mutation 必须返回 `permission_denied`。生产库不参与该烟测。

**不变式（脚本断言，不只是打印）**：

1. **守恒**：`usage_hourly` model 轴按 harness 分组求和 ≡ harness 轴 `totals_by_harness` ≡ CLI `data daily` 逐执行环境 total。
2. **诚实零**：某执行环境真机零事实（dsh 当日）→ 两侧都不出现该执行环境的 0 行，不是"claude=X, codex=Y, dsh=0"。
3. **窗口**：24 个北京小时桶恒在场（含全零桶）；`peak_hour` 是最大非零桶。
4. **脱敏**：见 M07。
5. **退出码**：出现 `MISMATCH` → exit 1。`BLOCKED` / `PARTIAL` / `EXPLAINED` 不影响退出码（它们是路线状态，不是回归）。
6. **权威审计**：`authority_audit` 只读 SQL 权威库；harness/model realtime token 轴差量必须 `<= tolerance_tokens`，结构性异常直接 `mismatch`，已登记质量例外只能使结果为 `explained`。

**何时重跑**：每次 Data MCP 增量收口；每次改 `authority_query` 的窗口/聚合 SQL；
真机启用观察期内每周一次。

## 7. 真机结果

`~/.agent-vitals`（schema v2，~54,900 facts，`sql_authority_enabled=true`）。

### 7.2 第二轮（2026-09-08，Q04 + Q12 落地后），`--internal` 构建

| 判定 | 数量 | 用例 |
|---|---|---|
| EXACT | 11 | Q01 Q02 Q03 **Q04** **Q12** · S4.1 S4.4（S4.2/S4.3 归 EXACT）· M07 M18 M19 M19b |
| EXPLAINED | 1 | Q11（缺口 #F1） |
| PARTIAL | 2 | Q05 Q14 |
| BLOCKED | 6 | Q06–Q10 · Q13 |
| MISMATCH | **0** | — |

公开构建：EXACT 10 / EXPLAINED 1 / PARTIAL 2 / BLOCKED 6（少 `--internal` 专属的
M19/M19b，多 M12；Q04/Q12 都在公开面）。

### 7.3 第三轮（2026-09-13，`authority_audit` 纳入）

内部构建在真实 `~/.agent-vitals` 上通过 JSON-RPC 调用 `authority_audit`：全库范围
与 `month=2026-09` 范围均返回 `verdict=exact`；月范围 21,182 条事实、
4,166,143,636 realtime tokens。harness/model realtime token 守恒差量均为 0，负 token、
重复组、孤儿 session、legacy/realtime 混轴、未来成功 revision、未解决质量例外均为 0；
聚合响应敏感字段扫描零命中。工具只存在于 `mcp-internal`，不具备写入或重导入能力。

同轮完整内部黑盒结果：**EXACT 18 / PARTIAL 2 / BLOCKED 6 / MISMATCH 0**。

**Q04 逐值对账**（2026-09-07 峰值小时）：`usage_hourly(group_by=harness)` 给
`peak_hour` → `sessions_search(date, hour=peak, harnesses=[h])` 逐会话 `tokens.total`
之和 **== 该小时 `usage_hourly` total == `data.window_total_tokens`**，`has_more
=false`：claude-code 峰 22 点 = 4 会话 `225857332`；codex 峰 12 点 = 1 会话
`10239273`。`session_detail(session_ref)` 反解 + 时间线，响应 leak 扫描零命中。

**Q12**：`data-reimport-verify` VERIFIED — byte-identical，2 rounds / 6
harness-months / facts 逐值相等 / `interrupted_runs_swept=1`。

### 7.4 第四轮（2026-09-13，`cost_breakdown` 真机对拍）

本轮先以公开构建、再以 `mcp-internal` 构建执行 `tests/mcp_smoke.py`，避免把内部
工具误计入公开清单。公开与内部均通过成本明细真实调用：`cost_breakdown` 采用配置的
统计时区，按每条事实的 `event_ts_ms` 选择不晚于该事实的 `pricing_snapshots`，金额输出
为 `MoneyMinor`，CNY/USD 与计费口径分别汇总；无价卡或路线证据不足的 token 保留在
`unresolved`，不转成零或订阅实付。内部额外通过 `authority_audit`，且显式开启本地写入
后管理烟测 20 个类型化动作通过。

最新黑盒结果：

| 构建 | EXACT | PARTIAL | BLOCKED | MISMATCH |
|---|---:|---:|---:|---:|
| 公开 | 19 | 6 | 0 | 0 |
| `mcp-internal` | 21 | 6 | 0 | 0 |

Q09 已接入版本分桶与安全比较器，当前真实数据因可比较版本证据不足保持 partial；Q07 已输出安全
重试链但因部分生命周期缺失保持 partial；Q06、Q08、Q10
已接入基础 reader 但保持 partial；Q14
仍是 harness raw 身份语义，canonical 归一未完成。`cost_breakdown` 当前保留事实时点价格版本切片以保证审计性，
`group_by` 会回显请求维度但尚未做跨价格版本的父层滚动聚合；`compare_to_previous`
目前提供等长对比窗口摘要，变化因子分解（用量/组合/缓存/价格/账单）仍未完成。

### 7.5 第五轮（2026-09-13，workflow reader 与过滤覆盖修正）

本轮在 release CLI 上直接调用公开 `issues_summary` / `skills_summary`，并验证过滤
范围不会借用全库事件数。2026-09-13 无过滤窗口返回 `observed_events=4,341`，
实际观测执行环境为 `claude-code`、`codex`，覆盖状态为 `partial`；`harnesses=["codex"]`
返回 `observed_events=4,236` 且 `observed_harnesses=["codex"]`。覆盖缺口仅保留
`unique token/cost linkage`；若重试事件缺少配对，才额外列出 `complete retry baseline`。Skill 查询继续明确列出
`skill_finished`、可比较版本基线、完整耗时和 token/cost 归因缺口。未安装或窗口内无事件的执行环境不计为
缺失执行环境。Q06/Q08/Q09/Q10 保持 PARTIAL，Q07 仍为 PARTIAL；这不改变 v1.0 的发布门槛。

### 7.1 首轮（2026-09-08，Q01–Q03 + 协议）

**逐值对账样本**（Q01/Q02，2026-09-07）：MCP `usage_hourly` 逐执行环境 `total` +
`total_output_tokens` 与 `agent-vitals data daily --date 2026-09-07 --json`
**逐位相等**（claude-code total `1227310463` / output `1975245`；codex total
`28194124`；dsh 两侧均无 0 行）。

**首轮修的真机 bug**（`d3251ea`）：`usage_hourly group_by=harness` 曾走
`hourly_by_harness`（导航查询只回单个 i64），总量塞进 `output_tokens` 槽 →
`total_output_tokens == total_tokens`；`group_by=model` 不带 `harnesses` 参数静默
返回空 series。两个 `group_by` 现统一走 `hourly_by_harness_model`。

## 8. 缺口表 → 解锁触发

| # | 缺口 | 现状 | 解锁 |
|---|---|---|---|
| ~~**F1**~~ | ~~`freshness.stale_harnesses` 未折叠逐执行环境过期状态~~ | ✅ 已关闭：以最后一条实时事实的 24h 阈值生成 `stale_harnesses`，`data_status.coverage` 同步降为 `partial`，并由单测与 Q11 真机冒烟守住；`last_seen_at` 仍独立表示扫描新鲜度 | — |
| **F2** | 金额消费面不完整 → S2「花了多少」「哪个最贵（钱）」及三消费面 parity 仍不完整 | ✅ `cost_breakdown` 已提供事实时点 harness/provider/model/basis 明细、`MoneyMinor`、unresolved 与订阅 token 分离；`summary_*` 成本占比/三面逐值 parity 未接齐 | 增量 3（`summary_daily`/`summary_monthly`）+ M15 成本 parity + cost factor decomposition |
| ~~**F3**~~ | ~~无 `data_quality_issues` 工具 → Q05/S2.4 只能 `query_sql_readonly` 数 code，不能逐模型下钻 unresolved 原因~~ | ✅ 已关闭：公开类型化 reader 支持状态/严重度/代码/执行环境/日期筛选、稳定 cursor 和 code-aware allowlist；原始 `detail_json` 不跨 MCP 边界 | — |
| ~~**F4**~~ | ~~Q04/S1.4 会话下钻~~ | ✅ **已关闭（2026-09-08）**：`session_ref` HMAC-SHA256 基元（`<data_home>/.mcp-session-salt`，0600）+ `sessions_search`（窗口/小时 × 逐会话聚合，keyset 分页，`window_total_tokens` 供守恒核对）+ `session_detail`（反解 ref → usage 时间线）。`started_at_ms`/`ended_at_ms` 从 `MIN/MAX(event_ts_ms)` 读时派生，不依赖那两列。**待**：`session_detail` 时间线的失败/错误事件富化 = F5（`workflow_events`）。 | — |
| **F5** | Q06–Q10 问题 / Skill 洞察（含 `session_detail` 的失败事件轴） | 基础 writer/reader、问题/Skill reader 和覆盖度已接通；Skill reader 已消费调用/结束事件，计算 outcome/duration coverage，并输出按版本分桶及证据门控的回归比较；issues reader 已输出安全重试链，但历史回填、跨执行环境覆盖和唯一 token/cost 归因仍缺 | M4 收口：历史回填、跨执行环境覆盖、唯一 token/cost 归因及稳定重试/回归 fixture |
| ~~**F6**~~ | ~~Q12 重导入幂等验收~~ | ✅ **已关闭（2026-09-08）**：`agent-vitals data-reimport-verify [--json]`（MCP 外隔离命令，`runtime::reimport_verify`）。 | — |
| **F7** | Q13 历史价版重放 | ✅ `cost_breakdown` 已按每条事实的 `event_ts_ms` 选择历史价格版本，真机出现 2 个版本并通过 Q13；变化因子分解与冻结多版本 fixture 仍未完成 | M3 收口：跨窗口因子分解、稳定 fixture、账单录入归因与父层聚合 |
| **F8** | `usage_hourly group_by=provider` 与 `model` 等价 | `provider_id` 归一表 §3.4 未建；schema 描述已注明"identical here" | v0.9.2+ canonical 归一 |

## 9. 通过门槛

- **当前阶段**：Q01–Q05 / Q11–Q13 / Q15 / S4.* / M07 / M12 / M18 / M19 全 `EXACT`；
  Q06–Q10 和 Q14 为 `PARTIAL`，`MISMATCH` == 0。Q07 的
  重试链按证据输出 recovered/unrecovered，未闭合部分显式降级；公开/内部历史结果见 §7.4，workflow reader 最新
  范围验证见 §7.5。
- **M1/M3 部分收口**：F1 已关闭；`cost_breakdown` 已落地并把 Q05/Q13 推到 `EXACT`，
  但 `summary_daily`/`summary_monthly` 成本消费面、三面 parity 与变化因子仍待完成。
- **M2 收口**：`authority_audit` 已纳入并通过真实 MCP 调用（Loop 313）；`reimport_verify`
  仍作为 MCP 外隔离命令验证，二者职责不混用。
- **v1.0.0（M5）**：Q01–Q15 全部 `EXACT` 或 `EXPLAINED`；无未关闭 `mismatch`
  （`AGENT_VITALS_DATA_MCP_SPEC.md` §14 DoD 末条）。
