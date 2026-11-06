# Agent Vitals v0.9.1 SQL 权威迁移——实施计划

> **规格**：`AGENT_VITALS_V0_9_1_SQL_AUTHORITY_MIGRATION_SPEC.md`（已冻结，2026-09-06）
> **本文档**：把规格的 Phase 0–4 拆成可勾选的工程工作项——每项标注落点文件、
> 规格章节、验收方式。实施按既定循环推进：**实现 → 全量测试 → subAgent 审查
> → 修复**，每个 Phase 一个收口点。
>
> 状态标记：✅ 完成 · 🔨 进行中 · ⬜ 未开始 · 🔶 部分完成

---

## 0. 当前进度快照（2026-09-08 更新）

| Phase | 状态 | 说明 |
|---|---|---|
| Phase 0 冻结与基线 | ✅ | spec 冻结；基线备份 `~/.agent-vitals/backup-v0.9.1-baseline/`（facts 48,999 条 + 索引库 + state JSON + 对账报告） |
| Phase 1 schema 与迁移框架 | ✅ | authority.rs（DDL v1 全 12 表 + 版本闸 + 中断清扫 + 事务帮助器 + retention）+ 时钟注入（sql_sync::now_ms）+ 迁移记录（sync_runs/migrations 表）。**1.7 损坏恢复文档化**：`data-status` 加 `PRAGMA integrity_check` + `health`/`hints`（critical → 退出码 1），58c38b8 |
| Phase 2 清洗写入与同步 | ✅ | 三路并发实现合流（c06de2e）+ 审查收口（6776fe0）+ 收口批（b1f8b38）+ 迁移哨兵真 bug 修复（1f67331）。2.1–2.3/2.6/2.7 复选框此前滞后——功能随三路合流全部落地，本次盘点补勾（命令名是 `data-*` 前缀，非 `data <sub>`）。2.8（harness_bills + pricing_snapshots）cf04121/64aa87d |
| Phase 3 SQL repository 与读路径切换 | ✅ | 3.1–3.7 全部完成（见各条）。Tier B 逐消费点切完 + Q01–Q14 端到端 fixture（b082a79）。**Q13 价格历史重放**（`PricingCards::asof`，`SqlSummaryRepository`/`calendar_month` 按查询窗口月末时点选历史价卡）3eecf09——3.5 Tier B 的最后一个后续项收口 |
| Phase 4 双轨验收与旧路径退役 | 🔨（仅剩真机观察期） | 4.1（77a59ab）+ 4.2（e339cce）+ 4.4 可自动化部分（58c38b8）✅。**4.3 旧路径退役全部落 `main`**：Stage 1–5a（ad4e33e/b5ca48c/98602a7/8498023）+ Stage 5b（4c0fba9/cf71a22/a1e4851/c503563/370e495 + 本次差分收口）+ Stage 6。`JsonSummaryRepository` / `data-reconcile*` / legacy `budget show` / `index.sqlite3` / `store` / DSH tick 的业务 state 写链 / 主二进制 `state merge-*` 子命令 / `behavior --json` 的 `hour_buckets` 全部退役；`SummaryRepository` 只剩 SQL；例行同步以 SQL `source_files` 做唯一差量索引；`data-unresolved` / 会话导航今日 token / Codex 配额（schema v2 `harness_runtime_snapshots`）均读 authority。Python mirror + 全部差分/lockstep 测试已对齐（`cargo test` + `clippy -D warnings` + `unittest discover tests` 1151 + golden 15/15 + `e2e_smoke` 全绿）。**仍待（用户本机）**：spec §6.1 备份 → `data-migrate` → 逐月核对 → `data authority enable` → ≥1–2 周观察期（4.4 最后一项）。 |

### claude ledger 去重 bug——发现、修复、真机验证（2026-09-06，非本 Phase 引入）

`SqlSummaryRepository` 写完后用真机 `~/.agent-vitals` 数据跑
`crates/agent-vitals-runtime/examples/reconcile_real.rs`（json vs sql 逐执行环境
对比），claude-code 月度 token 相差近 2 倍。排查定位到 **`apps/cli/src/agent/
claude_cost.rs::apply_record`（`claude_sync` 重建 `claude-ledger.json` 的 fold
核心）没有按 `message.id` 去重**——Claude Code 的 session JSONL 会把同一条
已完成的 assistant 消息重复写出多行（真机实例逐字节验证：同一 `message.id`
出现 4 次，`usage` 字段完全相同，只有各行自己的 `uuid`/`timestamp` 不同），
`apply_record` 对每一行无条件累加，系统性高估真实花费。v0.7 UsageFact
emitter（喂新 SQL 管线）从 Stage 1c 就按 `message.id`/`uuid` 正确去重——两条
管线共用同一行解析器 `parse_claude_usage_row`，但去重逻辑只在 emitter 侧，
fold 侧从未补齐，这是 v0.7 就存在的缺陷，不是本 Phase 引入。

**已修复**（用户 2026-09-06 决策：先修此 bug 再继续 Phase 3.2/3.5，避免
读路径切换时无法区分"SQL 迁移效果"与"旧账修正"）：`apply_record`/
`_apply_record`（Rust + Python 双侧）按 `source_event_id` 去重，持久化
`sess["seen_event_ids"]`（增量 resume 也要认得出跨批次重复）；
`FOLD_SCHEMA_VERSION` 2→3 强制真机全量重折（已写入的重复计数不可逆）。
新增 3 组测试：同 message.id 重复 3 次只计一次、不同 message.id 都计入、
真机语料 fixture 扩展进 `tests/test_claude_cost.py` 的 `both()` 差分（byte-parity
覆盖去重后的正确值）。

**真机验证**（修复前后对比，2026-09 月）：claude-code token 总量
6,752,783,759 → 3,403,484,732（−49.6%，此前 ≈2.0× 高估）；ApiEquivalent
（anthropic，USD）$1368.92 → $788.81（−42.4%）；MeteredEstimate（deepseek
relay，CNY）¥591.68 → ¥216.79（−63.4%）；真机 `claude-sync` 报告
`duplicate usage rows: 38708`（169 个真实 session 文件）。修复后 json/sql
两条独立管线的月度 token 差距从 ~49% 收窄到 ~1.7%——两条管线互相印证的
直接证据。详情见 memory `claude-ledger-overcount-bug`。

---

## Phase 1：SQLite 权威 schema 与迁移框架（spec §7 Phase 1）

目标：权威库 `agent-vitals.sqlite3` 成库、可重复打开、损坏与半建状态诚实报错、
批次可观测。**恢复语义在此定调：损坏不自愈**（与旧 index.sqlite3 的本质区别）。

- [x] **1.1 DDL v1 全量建库** — `agent-vitals-data/src/authority.rs`
  （spec §3.1–§3.6 逐表：schema_meta / sync_runs / source_files / sessions /
  usage_facts / harness_bills / pricing_snapshots / budget_config /
  budget_snoozes / data_quality_issues / migrations / workflow_events；
  `foreign_keys=ON` + WAL + `busy_timeout` 5s）
- [x] **1.2 版本闸** — 空/同版本/更新版本三态；半建库（有业务表无版本行）
  报 `__corrupt_partial_schema__`（建库必须事务化完成）
- [x] **1.3 中断批次清扫** — open 时 running → cancelled（`error_code=interrupted`）
- [x] **1.4 事务帮助器** — `with_immediate_txn`（Err → ROLLBACK）；全部业务
  写入必须走它
- [x] **1.5 时钟纪律接线** — `sql_sync::now_ms()` 是 runtime 唯一读时钟
  点；data crate 全部 `*_at_ms` 由调用方注入
- [x] **1.6 数据迁移记录** — `migrations` 表已建（DDL 与数据迁移分离）；
  legacy import 的迁移记录走 sync_runs（trigger=migration）
- [x] **1.7 损坏恢复文档化**（58c38b8）— `data-status`（spec §9 data doctor
  的权威库部分）加 `PRAGMA integrity_check` → `integrity` 字段 + `health`
  ∈ ok/warn/critical + `hints[]` 恢复路径（库刚被建且 sql_authority_enabled
  → critical + `sync-facts`/`disable`；integrity 失败 → critical +
  「权威库不自愈——`rm agent-vitals.sqlite3* && data-migrate` 重建」；
  facts==0 且 enabled → critical）。
  critical → 退出码 1，open 失败 → 退出码 2 + stderr。

**验收**：空安装 / 重复 open / 中断清扫 / 损坏报错 / 半建拒绝 / 新版本拒绝
六条测试全绿（已有）；`data doctor` 能报库状态（Phase 2 补）。

## Phase 2：清洗写入与同步（spec §5.1 / §7 Phase 2）

**接口契约（实现前钉死，实现 agent 不得偏离）**：

```rust
// agent-vitals-data/src/fact_writer_sql.rs —— SQL 写入面（spec §5.1 四步协议）
pub struct SqlFactWriter<'a> { /* conn + run_id + now_ms */ }
impl<'a> SqlFactWriter<'a> {
    pub fn new(conn: &'a Connection, run_id: &str, now_ms: i64) -> Result<Self, AuthorityError>;
    /// source_files upsert（path_hash = fnv1a64(路径)，不存明文）。返回 source_id。
    pub fn upsert_source_file(&self, harness: &str, path: &Path, size: u64,
        mtime_ns: u64, native_session_id: Option<&str>, parser_version: i64) -> Result<String, AuthorityError>;
    /// sessions upsert（session_key = r2a 键构造）。
    pub fn upsert_session(&self, harness: &str, ns: &str, native_id: &str,
        profile: Option<&str>, last_observed_ms: i64) -> Result<String, AuthorityError>;
    /// 事实批写入：契约校验（build_usage_fact 同款）→ 合格 INSERT OR CONFLICT
    /// DO NOTHING；不合格写 data_quality_issues（不静默丢）。重复 = duplicate 计数。
    pub fn insert_facts(&self, facts: &[Value], source_id: &str,
        native_session_id: &str) -> Result<SqlInsertReport, AuthorityError>;
}
pub struct SqlInsertReport { pub inserted: usize, pub duplicate: usize, pub rejected: usize }
```

- 事务边界：调用方（runtime sync）`with_immediate_txn` 包「upsert sources/
  sessions + insert_facts」整段（spec §5.1.4）；`SqlFactWriter` 内部不再开
  事务（嵌套 BEGIN 是 sqlite 错误）。
- `sync_facts` 切换：发现/差量逻辑不变；checkpoint 改查 `source_files`；
  emit 后走 `SqlFactWriter`；**JSONL 停写**（存量文件保留为遗留）。
- 敏感点：fact 的 `event_ts_ms` 由 ISO ts 解析（复用 store.rs `parse_ymd` 同
  层 helper）；`event_peak` 复用 `peak_of`（三个尾部形态都已钉测）。
- **批次合成 source 行排除规则**（审查收口定稿）：`upsert_batch_source` 落
  的合成行路径 = `/sync/{harness}`、size/mtime 恒 0——Phase 3 的差量判定、
  repair 重放、source 计数必须排除（`source_id LIKE '%:sync'` 或按指纹
  判 0），并把「迁移窗口内事实的 source_id 指向批次行」记录为已知
  provenance 限制（fact_id/会话下钻不受影响，文件级溯源在此窗口缺失）。



目标：三执行环境 emitter → **SQL writer**；JSON checkpoint → `source_files`；
lease 包住完整事务。旧 `index.sqlite3` 的 facts 按 §6.2.1 一次性导入。

- [x] **2.1 SQL writer**（c06de2e，`agent-vitals-data/src/fact_writer_sql.rs`）
  — `SqlFactWriter`：candidate facts 校验 → 不合格写 `data_quality_issues`
  → 合格项进 `BEGIN IMMEDIATE` `INSERT ... ON CONFLICT DO NOTHING`；幂等键
  = `fact_id`，第二道防线 = 表上 UNIQUE 五元组。12 单测（重放幂等 / 五元组
  冲突 / 坏 ts 拒绝 / 混会话批回滚 / rejected 写 issue 不写 usage 行…）
- [x] **2.2 `source_files` 迁移**（c06de2e + b1f8b38）— `sql_sync::
  migrate_checkpoint`：JSON checkpoint 的 (size, mtime) 指纹迁入
  `source_files`（path_hash = fnv1a64，不存明文），迁移后文件重命名退役
  （`migrate_renamed_checkpoint_is_noop_on_second_call` 钉幂等）
- [x] **2.3 sessions 最小索引**（c06de2e）— `SqlFactWriter` upsert `sessions`
  （session_key = r2a 键构造，含 profile；`session_conflict_updates_last_
  observed_not_started` / `session_key_is_collision_free_for_colon_bearing_ids`），
  `usage_facts.session_key` 外键关联
- [x] **2.4 双写（迁移窗口 §6.1）** — `sync_facts` emit 一次，同一批事实
  先写 SQL 权威（write_flat_facts_to_authority）再走旧链 ingest；两轨都
  成功才进 checkpoint。JSONL 停写推迟到 Phase 4（旧读面切换完成后）
- [x] **2.5 一次性导入** — `data-migrate`：facts/*.jsonl 重放入权威库
  （真机 49,321 条，重跑全 duplicate 幂等）；旧 `store`（index.sqlite3）
  保留至 Phase 3 读切换后退役
- [x] **2.6 命令面**（b1f8b38 + Stage B）— `sync-facts`（= `data sync`，SQL
  权威 + legacy 双写）/ `data-status`（schema + sync_runs + 来源 + 质量摘要
  + health）/ `data-rebuild-index`（= `data repair`，从权威 JSONL 重放）/
  `data-migrate`（§6.1 手动迁移入口）。命令名用 `data-*` 前缀（clap 扁平），
  非计划里试写的 `data <sub>`
- [x] **2.7 lease 接线**（c06de2e，`runtime::lease` + `sync_service`/
  `ingest_service` 多处 `acquire_blocking(".ingest.lock")`）— O_EXCL + 原子
  rename 陈旧偷取，包住「发现→解析→事务写入」；`lease.rs` 8 单测（互斥 /
  TTL 偷锁 / 偷锁后 drop 尊重所有权…）
- [x] **2.8 HarnessBillRecord + 价格快照** — ✅
  - `pricing_snapshots`（cf04121）：`sql_sync::snapshot_current_pricing`
    在 `data-migrate` / `sync-facts` 各落一次当前版本；`authority::
    pricing_snapshot_asof/latest/get` 是历史重放读原语。**Q13 消费面已收口
    （3eecf09）**：`summary::PricingCards::asof(db, 窗口月末 ms)` →
    `SqlSummaryRepository::{monthly,daily}_summary` / `calendar_month` 按
    查询窗口时点选历史价卡；「只有一份快照」时 == 当前卡逐字节相同（对当前
    真机数据 no-op）。粒度 = 窗口级（月末），逐日重放是独立后续项。reconcile
    §6.3 加 `pricing_replayed` 例外（SQL 按历史卡 vs legacy 按当前卡 →
    explained 非 mismatch）。
  - `harness_bills` 写入方：`authority::harness_bill_put/harness_bills_for_period/
    harness_bill_delete`（YYYY-MM + 五档 basis + amount_minor≥0 + currency
    非空四项校验，同键 upsert，soft delete）；CLI `data-harness-bill
    {set,list,delete}`（spec §5.3 显式管理 API，不由 UI 直写表）；
    `summary::apply_harness_bills` 把活账单行折进 `MonthlySummary.by_provider`
    对应 `{harness}/{provider}` 条目的 basis 桶（跨币不相加，冲突撤 currency
    + unresolved）。WorkBuddy credit_json 是首个消费方——录入仍是人工
    （`workbuddy-session` 读到的 credit_json 值 → `data-harness-bill set
    --basis harness_billed`），自动接线是后续项。
  - 附带：`persist_reconcile_exceptions` 修 scope 从 mismatch 转
    exact/explained 后陈旧 `reconcile_mismatch` 行不 resolve 的 bug
    （真机 2026-08/claude-code 挂了一条假警告）。

**验收**：同一事件重放/文件修改/截断/坏行/并发同步的测试矩阵（spec §8.2）；
`sync_runs` 与 `data_quality_issues` 如实记录。

## Phase 3：SQL repository 与全部读路径切换（spec §5.2 / §7 Phase 3）

目标：**所有产品查询只走 `SqlSummaryRepository`**。禁止运行时读取
month.json / ledger / Codex fold / facts JSONL（spec §5.2 禁读清单）。

- [x] **3.1 `SqlSummaryRepository`** — 实现 `SummaryRepository` trait
  （daily/monthly）：tokens 从 `usage_facts` 聚合（harness × 日/月 ×
  model/provider，event_ts_ms → 北京日/月窗口）；金额走
  `domain::cost` 同一计价面，DSH peak 按 `event_peak` 列。
  `crates/agent-vitals-data/src/authority_query.rs`（反查层）+
  `SqlSummaryRepository`（`summary.rs`）；5 个真实数据 client-parity 测试
  + 真机对账脚本 `examples/reconcile_real.rs`。**pricing_snapshots 未接入**
  ——当前仍读 `domain::cost::load_pricing()`（与 JSON 路径同一张活价表），
  价格快照版本化是独立的 3.4 相邻工作，非阻断项
- [x] **3.2 legacy_aggregate 导入** — ✅ 8436b37（2026-09-07，subagent 实施）：
  接线 `data-migrate`（load_claude_ledger_days → with_immediate_txn →
  import_claude_ledger_days，错误路径与 JSONL 导入同款 failed+exit 2）；
  **审查发现的语义修复一并落地**：legacy 同键值变更从「conflict 永不覆盖」
  改为「UPDATE 新值 + 计 updated」（同源快照刷新——ledger 是全量重建的
  滚动投影，永不覆盖会让 SQL 永久留旧高估值；§6.2.5 只保护实时行级事实），
  跨 kind 冲突防御分支保留。真机验证：236 条 legacy_aggregate 入库、重跑
  全 duplicate 幂等、coverage 降级标记落库。**诚实观察**：本机 ledger 35 天
  全部同时有实时事实（legacy_only_days=0），legacy 行当前在合并视图不可见
  ——价值在未来轮转月（实时行物理消失后按日回退）。
  **`unaccounted` 残差池裁决（已定，Phase 4）**：ledger 的
  `unaccounted`（cost-state 基线 −行级和，真机 3.575B tokens、**无日期**）
  **不进 `usage_facts`**——没有日期，编一个北京日就是 fabrication。也不静默
  丢（§5.4「无日期或质量异常事实不能静默删除，必须先标记」）。折中：
  `data-migrate` 时把整个残差池汇总成**一条 `data_quality_issues`**
  （`code='undated_residual'`，逐模型 token 写 detail_json）。`data-status`
  的 `open_quality_issues_by_code` 按名可见；Phase 4.1 对账的 SQL vs ledger
  token 缺口 = 这条残差，显式可解释。实现：`legacy_import::
  {load,import}_claude_ledger_unaccounted` + `data-migrate` 接线。
- [x] **3.3 coverage_status** — ✅ 390d3f8 + 1f1ed4e（2026-09-07，主 agent
  实施 + subAgent 审查收口）：三维分母 v1（usage/price/sync，
  COVERAGE_DENOMINATOR_VERSION=1），trait 新增 coverage_status(month)；
  Sql 侧真实三维、Json 侧二值近似 version=0（两把尺异版不可互比）；
  summary 级字段（接线执行环境数语义）刻意不动。审查确认 spent 口径与
  price 维单点否决（与 has_unresolved 同源）为设计意图。
  **设计定稿（2026-09-07，主 agent 拍板）**：分母 v1（`denominator_
  version=1`，定义变更必须递增）= 每执行环境 3 维：① usage 维——窗口内有
  可解析时间戳的事实存在；② price 维——窗口内全部非零 token 模型能经
  `billing_route_of`/价卡归属（认不出的模型让本维不算 measured，与
  has_unresolved 同源）；③ sync 维——`source_files` 该执行环境最近
  last_seen_at_ms 落在窗口内。`measured_fields` = 三维命中数、
  `total_fields = 3`。落点 `authority_query::coverage_status(conn, harness,
  start, end)`；`SqlSummaryRepository` 改用它（Json 侧保持静态 3/3 直至
  Phase 4 退休）。诚实约束：窗口零事实的执行环境三维全 0/3 + Unavailable；
  「接线了」是能力不是观测，永不计入 measured
- [x] **3.4 budget_status** — ✅ 390d3f8 + 1f1ed4e（同上循环）：authority
  CRUD（config/snooze，minor 整数）+ budget_status_sql（CNY summable→
  pyround minor 全整数判断，level=no_budget/ok/warn/exceeded）+ CLI
  budget-sql 五动作（既有 budget show 零改动保差分）；seed 门禁两轮收口
  （默认值 ≠ 用户输入；merged 恒有默认 → 查原始 TOML 键）；snooze ISO
  解析对齐 domain parse_iso（后缀静默错位 8h 修复）；档位阈值精确钉界。
  **设计定稿（2026-09-07，主 agent 拍板）**：① 配置迁移——首次使用时
  `budget_config` 行缺失且旧 `budget.json` 存在 → 一次性 seed（文档化、
  幂等：行存在后不再读旧文件）；spec §6.2.4「today/alert 不迁移」不适用
  ——配置是用户输入不是派生数据。② CRUD API——`AuthorityDb::
  {budget_config_get, budget_config_set, budget_snooze_get,
  budget_snooze_set}` 全走 `with_immediate_txn`；CLI `budget config
  show/set`、`budget snooze set/clear`。③ 计算——预算口径 = CNY 实际支出
  （by_provider summable 桶的 CNY 列：MeteredActual+FixedSubscription+
  HarnessBilled）→ minor 单位一律 `pyround(×100)`（银行家舍入与全仓一致），
  **判断全部 minor 整数比较、不落浮点**（纪律 2）；ratio vs
  warning_ratio_bp，snoozed（until_ms > now）输出标记不告警；输出带
  coverage/freshness（复用 3.3）。④ 替代路径——alert.json/budget.json
  读取面在 3.5 Tier B 切完后停写（Phase 4 删）
- [x] **3.5 Tier A** — ✅ e56abc8（2026-09-07，subagent 实施并与 3.2 收口批
  同提交）：三处 trait 消费点切 `SqlSummaryRepository`（CLI `Cmd::Data`
  分发、Tauri `data_monthly_summary`/`data_daily_summary`）；
  `DataReconcile` 刻意保持 Json（对账基准）；受影响 python e2e 种子改走
  facts JSONL + `data-migrate`（断言零改动，9/9 绿）。真机验证全绿：
  total_actual_spend 逐位一致、2026-08 dsh metered 1752.4498 逐位一致、
  contract_violations 双侧全空、Tauri 93 测试全绿。
  **重要纠偏（部署层，2026-09-07 01:11 主 agent 处置）**：3.5 agent 报告的
  「当月 claude tokens JSON 6.96B vs SQL 3.46B = unaccounted 池」归因有误
  ——实测 `claude-fold.json` schema_version 回落为 2、ledger days 充气到
  7.01B：**去重修复的部署缺口**。修复后二进制只存在于 target/release，
  `/Applications/agent-vitals.app/Contents/Resources/bin/agent-vitals`
  （9-6 15:26 旧构建）与 `~/.local/bin/agent-vitals`（9-1）每次托盘 tick
  都用 v2 算法清 fold 重折充气，与新二进制乒乓。已把当前构建装进两处 +
  重跑 claude-sync 恢复（days 3.52B、fold v3、duplicate 39,056）。教训
  入 CLAUDE.md 级纪律：**改 fold/ledger 语义的提交必须同步重装全部部署
  点（App bundle 内置 CLI + PATH 上的拷贝），否则新旧二进制对同一状态
  文件写出版本乒乓**。unaccounted 残差池（~3.5B）仍是独立的 Phase 4 待决
  项，与本次 50% 无关
- [x] **3.5 Tier B**（逐个消费点切 + 双轨验证）—— 全部子项 + Q13 价格重放
  收口（3eecf09）。剩「前端 hover 展开分币」等纯展示层项见下方「待做」，
  非 v0.9.1 门槛。
  - [x] `runtime::summary::JsonSummaryRepository` → `SqlSummaryRepository`（Tier A 已切三个 trait 消费点）
  - [x] `data coverage` / `data daily` CLI（Tier A）
  - [x] Tauri：`read_hourly_distribution`（4823db3）、`read_calendar_month`（ce856db）
  - [x] **预算卡地基**（2e72958）：`SqlSummaryRepository` 参数化（ZST → `data_home:
    Option<PathBuf>`，`::new()`/`::at(dh)`）+ `budget::budget_status_sql_at(dh, month)`；
    `budget_status_sql` 退成薄封装，外部行为逐字节不变（golden 15/15 +
    test_cli_matrix 157 全绿）。TDD：失败测试先行（两临时库同配置、无锁断言
    spent 严格更大）。为什么单独一提交：ZST 只认 `crate::home::data_home()`
    是本会话预算卡连续 4 次实现失败的根因，先把这个坑填平再接线。
  - [x] **预算口径改按量**（下一提交）：`budget_status_sql` 支出分子从
    `summable_total()`（含 FixedSubscription）改成 `MeteredActual + HarnessBilled`，
    **排除订阅月费**；JSON 键 `spent_cny_minor` → `metered_cny_minor`。见下
    「预算口径（PM 决策 2026-09-07）」。
  - [x] **evaluate_alert 切 SQL**（f749e8e）：`runtime::budget::evaluate_alert_
    from_sql(dh)`——**不改 domain `evaluate_alert` 一行**（因此不碰 Python 差分）。
    `month_days` = DSH `peaked_days_map`（当月北京毫秒窗，与 month.json days
    同形），`today_data` = 该 map 里今天 entry，直接喂。config 从
    `budget_config`（3 字段 → merged_config 补默认），snooze 从
    `budget_snoozes.until_ms` → ISO。CLI `budget-sql alert`（SQL 版
    `budget show`）。附带修 3.4 遗留 bug：`iso_to_ms_beijing` 漏 秒→毫秒
    ×1000（CLI snooze-set 写的 snooze 恒显示已过期）。
  - [x] **托盘预算卡接线**（afed41f）：`overview::read_overview_at` 的预算卡从
    读 `alert.json` 改成 `evaluate_alert_from_sql(dh)` 实时算。`read_budget_
    alert`/`alert_beijing_month` + month-stale 校正整段删除（SQL 按当月窗查，
    「评估月 ≠ 当前月」漂移结构上不可能）。`source="sql"`、`generated_at=None`
    （实时算无快照时刻，新鲜度归托盘「上次同步」行）。删 4 个测 alert.json
    的用例 + 新 wiring 测试（当月/上月事实分离 + 月窗归属）。
  - [x] **托盘「本月订阅」行**（`?`）：`Overview.subscription_cny_month` =
    `overview::monthly_cny_subscriptions`（纯 pricing.json 计算，月份过滤同
    `apply_subscription_fees`）。托盘按量预算行下方单列「本月订阅
    ¥232（已付，不计入按量预算）」。
  - [x] **HTML 模板消费面 / codex-cost 切 SQL**（7ae69b7，PM 拍板「整命令迁移
    + 退役 Python 侧」）：`codex-cost`（`--json`/`--html`/文本）从 rollout 全量
    fold 改读 `runtime::summary::codex_merged_from_sql`（→ `authority_query::
    codex_by_hour_model` 全窗，`codex_report_from_merged` 的 `filter_key` 做
    视图过滤）。Python 侧整命令删除（`codex_cost.py` 模块 + `codex_fold_merged`
    等留给 Python-only `calendar`——其 SQL 迁移是 §5.2 独立后续项）。5 个
    `test_codex_cost_*` py==rs 差分删除，calendar 交叉测试退成结构冒烟，新增
    Rust `codex_sql_tests`（读事实/降级/订阅标注 + `Some(filter_key)` 月过滤
    守恒）+ Python e2e 冒烟。SQL 面降级：`unaccounted=[]`（哨兵是 fold 独有）、
    `plan` 只带 `plan_type:"plus"`（pricing.json `billing_modes.openai._note`
    实测不变量，保「(按量标价)」诚实标注，限额快照丢失待后续）、库缺失时
    stderr 提示 `sync-facts`。subagent 审查 6 条 should-fix 全处置。
    附带修 pre-existing `test_help_defaults_to_english` 红（`budget-sql`/`data`
    的中文 doc 混进 `--help`）。

  #### 预算口径（PM 决策 2026-09-07，PM熊叔评审）

  **预算 = 跨执行环境「按量实付」的成本闸门。** 不是全执行环境总预算（含订阅），也
  不是 token 预算。

  | 花钱类型 | basis | 本月还会变 | 用户当下能干预 | 进预算告警 |
  |---|---|---|---|---|
  | 按量实付 | `MeteredActual` | 是（越用越多） | 换模型/少跑/开缓存/避峰 | ✅ |
  | 执行环境账单 | `HarnessBilled` | 是（用量变动） | 同上 | ✅ |
  | 订阅月费 | `FixedSubscription` | 否（月初已付） | 只能下月退订 | ❌ 完整面板单列「本月订阅 ¥X（已付）」 |
  | 无价卡 token | —— | 未知 | 补价卡映射 | ❌ 进「数据可信度」 |

  - **理由**：告警职责是对「越用越多、且当下能拧」的花钱设闸门。订阅是常数，
    摊进每 5 分钟刷新的分子 = 月初凭空涨一截然后整月杵着，是告警剧场。
    adaptive floor（7 日均 ×1.5）与 peak_share 反博弈本就是按量概念（订阅
    没有「日均」、峰谷差只发生在按量计费上）——这本身证明预算是按量口径。
  - **跨币**：CNY 主栏，非零 USD 按量流加副栏 / 显式标注「仅 CNY 按量」，
    绝不用一个 ¥ 数字盖住多币现实。USD 按量若起量→加独立 USD 预算行。
  - **token 预算**：不做主口径（单价非常数，Opus vs Flash 差数十倍；用户脑子
    里是「还剩 ¥200」不是「还剩 40M token」）。作 per-model 高级下钻视图。
  - **「只是 DSH」是缺陷**：历史遗留（DSH 曾是唯一有真实 CNY 按量的执行环境）。
    切 SQL 后 `budget_status_sql` 的分子已是跨 by_provider 的 CNY 按量之和。
  - **落地**：`budget_status_sql` 分子排除 FixedSubscription（已改，
    `metered_cny_minor`）；`evaluate_alert` SQL 端口喂「跨执行环境按量日/月窗」
    而非 DSH-only；托盘完整面板加「本月订阅 ¥X（已付，不计入按量预算）」行。
  - **验收指标**：告警「有效触发率」（触发后 24h 内确实降调用/换模型）≥40%；
    「告警后无动作」率 ≤30%；跨币遗漏投诉 = 0；托盘逐日分子之和 ≡ 月度
    metered 分子（±未计时样本，`token_by_date_model` 已有纪律）。

  #### 货币折算（PM 决策 2026-09-07，续）

  速览层可以把混币金额并成一个 `≈¥` 数（PM熊叔评审）——**是估算标签不是口径**：

  - 汇率是**版本化数据**：`assets/pricing.json::fx_estimate {USD_CNY, as_of}`
    （+ dsh-client 运行时副本，`test_pricing_lockstep` 字节比对）。随 release 更新，
    不硬编码常数（6.7 已过时，2026 spot ≈7.1–7.2，本仓库取 7.15）。
  - **只进速览层**：托盘标题 / 菜单「今日·本月按量成本」行。带 `≈` 前缀，
    hover / 详情 / DTO 里永远保留原始分币。**不进**预算 ratio / 实际支出 / 导出 /
    对账 / `budget-sql` —— 那些永远分币不相加。
  - **已落地**（下一提交 `?`）：`overview::fx_estimate()` 提取 + `Overview.fx`
    字段（`{usd_cny, as_of}`）；`lib.rs::metered_amount` 加 `usd_cny_rate` 形参——
    有汇率 → anthropic USD 按率折进 ¥ 主账（此前混币时 USD 被整个丢弃，
    「只是 DSH」缺陷的一个面）；无 `fx_estimate` 节 → 退回分币旧行为。
  - **待做**：前端 hover 把 `≈¥X` 展开成「$A 折 + ¥B 实」（消费 `Overview.fx` +
    `claude_today/claude_month` 已有的 currency_totals）；`as_of` 过期时展示层弱化；
    「主币」改成用户设置（当前默认 CNY，语言≠货币基准）。
- [x] **3.6 导出切 SQL** — ✅ 5a9504d（2026-09-07，subagent 实施）：双路径结构
  保留（各自 `BEGIN DEFERRED` 一致截面、无共享中间产物），JSONL 读实现整体
  删除；字段映射表显式入模块文档（`model_id` 列回填 `model_raw`、
  `event_ts_ms` 反算 emitter 格式 ISO、ingest 元数据键不再出现且已验证不
  影响 fact_id 哈希基）；redacted round-trip 全文档相等测试钉 restamp 正确
  性；行序 = fact_id 字典序保证字节确定性。spec §9 核对无矛盾（原文明确
  二者均从 SQL 生成）。语义变更记录：软删除行不导出（authority 新行为）、
  「完整面」= 权威库完整面。1129 测试全绿 + CLI 端到端冒烟。
  **附带收获（范围外发现 → 主 agent 已修）**：`fact_writer_sql::
  insert_facts` 的 payload_conflict 信号自 Phase 2 落地起是死代码（查询
  旧 index 库的 `facts` 表，恒 no-such-table 被 `.ok()` 吞掉、无测试覆盖）
  ——已改为对 `usage_facts` 四桶列直读比较并补回归测试
- [x] **3.7 用户查询验收 Q01–Q14（spec §4.2）端到端 fixture** — ✅
  8bef871（3.7a facts_page_window）+ b082a79（3.7b e2e，2026-09-07 主 agent
  实施）：blocker 集 Q01–Q05、Q11–Q12 + Q14 + §4 分离纪律全部以 e2e fixture
  钉住（`crates/agent-vitals-runtime/tests/q_acceptance.rs`，走公开 trait
  面）；Q06–Q10 记 v0.10；Q13 挂 pricing_snapshots 欠账。原盘点表保留如下。
  逐用例现状（实施前）：

  | 用例 | 现有覆盖（层级） | 缺口 |
  |---|---|---|
  | Q01 跨执行环境小时曲线 | `codex_by_hour_model` 单元测试 | 跨执行环境小时聚合面在 Tier B（未切 SQL）；e2e 无 |
  | Q02 同模型跨执行环境不重不漏 | parity 测试隐式（三执行环境同测） | 「各执行环境之和 == 总量」未显式断言 |
  | Q03 北京月界 00:30 归属 | `authority_query` 边界单元测试（±1ms） | e2e fixture 无 |
  | Q04 峰值小时下钻、会话合计==峰值 | **无** | **前置 3.7a**：authority 库缺最小 `facts_page` 查询面（`SummaryRepository` 现只有 daily/monthly 两个方法，spec §4「最少提供」9 个方法只落 2 个） |
  | Q05 无价卡 unresolved 不归零 | claude/codex unresolved 单元测试 | e2e fixture 无 |
  | Q11 执行环境 24h 未同步 → stale/partial 显式 | freshness/excluded_harnesses 契约测试 | 「单执行环境过期不得冒充完整总额」e2e 无 |
  | Q12 双次导入+中断 → 重跑恒等 | writer 级幂等/回滚测试 | 跨「导入→查询」e2e 无 |
  | Q13 调价日前后价格版本 | `pricing_snapshots` 写入方 + `pricing_snapshot_asof` 读原语（2.8，cf04121） | `SqlSummaryRepository` 按事件时间点选版本重放未接（存储/读侧已齐），非 blocker、显式记欠 |
  | Q14 同 raw 模型名跨执行环境 | unknown→unresolved 单元测试 | 跨执行环境同名 fixture 无 |
  | Q06–Q10 workflow_events | 表已建、无 writer/reader | spec 自身定位 v0.9.1 最小化，随 v0.10 任务图，不阻塞 release |

  另：spec §4 行轴/聚合轴分离纪律明文要求 Phase 3 repository 验收矩阵含
  「聚合数 ≠ 行级数 + 聚合数 = ledger 数」fixture——单元级已钉
  （`peaked_days_map` 排除 legacy、`claude_legacy_days` 只读 peak=0），但
  `SqlSummaryRepository` 层「同日两类行并存不双计」未落。

  执行方案（3.2/3.5/3.6 之后、Phase 3 收口审查之前）：
  - **3.7a**：authority 库补最小 `facts_page`（harness × 时间窗 × cursor 分页），
    落 `agent_vitals_data::authority_query`，供 Q04 下钻。
  - **3.7b**：新建 e2e 测试文件（临时 `AGENT_VITALS_HOME` + 权威库 seed 的
    fixture builder），blocker 集 Q01–Q05、Q11–Q12 + §4 分离纪律 fixture
    逐条钉判别值；Q14 顺带（成本低）；Q13 挂 3.4 验收；Q06–Q10 记 v0.10。

**验收**：client parity 测试（CLI/Tauri 命令/HTML 由同一 DTO 返回）；
双轨对账 harness 逐字段通过；3.7 blocker 集 e2e 全绿。

### 任务书：3.2 / 3.5 / 3.6（2026-09-06，供派发 subagent 前确认）

#### 3.2 legacy_aggregate 导入接线

**范围**：把已经写好、有单测、但从未被任何命令调用的
`agent_vitals_data::legacy_import::import_claude_ledger_days` 接进
`data-migrate`。纯接线，不改算法。

**落点**：`apps/cli/src/main.rs`，`Cmd::DataMigrate` 分支（约 2246-2322 行）。
现有代码在 `for harness in ["claude-code", "codex", "dsh"]` 的 JSONL 导入循环
结束、`db.finish_run(...)` 之前收尾。

**步骤**：
1. 循环结束后，加一段：`agent_vitals_data::legacy_import::
   load_claude_ledger_days(&agent_vitals_runtime::state::state_dir())` 读
   `claude-ledger.json` + `claude-ledger-archive.json` 合并出的 `{day:
   {model: 4桶}}`（当前月优先于归档，函数已实现）。
2. 若非空对象，`db.with_immediate_txn(|conn| legacy_import::
   import_claude_ledger_days(conn, &run_id, now_ms, &days))`，把
   `LegacyImportReport{imported, duplicate, conflicts}` 累进汇总输出（新加
   一行 `println!`，格式参照现有 `"  {harness}: +{} inserted, ..."`）。
3. 读文件失败（`AuthorityError::Io`，如非法 JSON）与 JSONL 导入失败同一
   处理：`finish_run("failed", ...)` + `exit(2)`——不能吞。
4. **不需要判断"这天是否已有实时事实"**——两者身份字段完全不重叠
   （`native_session_id="day:{day}"` + `machine_namespace="legacy"` 是
   legacy 专属固定值，`UNIQUE` 约束不会撞实时事实），查询侧
   （`SqlSummaryRepository::merged_claude_days`）已经做「有实时用实时、
   没有才退回 legacy」——导入侧只管把 ledger 全量灌进去，不用自己判重叠。
5. `migrations` 表的 `checkpoint_json` 可以顺带把 legacy 导入的五个数字也
   塞进去（跟 JSONL 导入的 `{"inserted":...}` 合并成一个对象），不需要
   单开一行 migrations 记录。

**验收**：
- 新增一条集成测试（或扩展现有 `data-migrate` 冒烟）：临时 data home 里放
  一份 `facts/claude-code.jsonl`（几条真实事实）+ `state/claude-ledger.json`
  （几天历史，其中至少一天与 jsonl 事实的日期不重叠），跑 `data-migrate`
  后 `usage_facts` 表里应同时出现 `observation_kind='assistant-usage'`（或
  实际用的 kind 名）与 `observation_kind='legacy_aggregate'` 两类行，且
  `SELECT COUNT(*) FROM data_quality_issues WHERE code LIKE 'legacy_aggregate%'`
  能看到 coverage 降级标记（`mark_coverage_degradation` 已实现）。
- 重跑 `data-migrate` 两次，第二次 legacy 部分应全 duplicate（幂等）。
- 真机（`~/.agent-vitals`）跑一次 `data-migrate`，确认 `usage_facts` 出现
  `legacy_aggregate` 行且 `SqlSummaryRepository` 对历史月份（当前月之前、
  ledger 已滚出但归档还在的月份）不再报 Unavailable。
- `cargo test --release` 全量 + `cargo clippy --release --all-targets -D warnings`。

**注意**：本次会话刚修完 `claude-ledger.json` 的重复计数 bug（见
「claude ledger 去重 bug」章节）——真机的 `claude-ledger.json`/
`claude-ledger-archive.json` 现在已经是修复后的正确值，3.2 接线时不需要
再关心这条历史 bug。

---

#### 3.5 读路径切换清单——先分两层，再派发

**关键澄清（写任务书前查代码发现的落差，与规划文档原有清单不同）**：
清单里六个消费点，**只有前两类真的经过 `SummaryRepository` trait**、切换
是一行改动；**后三类（calendar/hourly、budget/alert、HTML）根本不走这条
trait**，是各自直接读 JSON 状态文件/codex fold 的独立函数——切到 SQL
是和 `SqlSummaryRepository` 同等量级的新实现工作，不是"改一行调用"。
派发前务必按下面两层分别处理，不要把 3.5 当成一个均质任务整体丢出去。

**Tier A（真·一行切换，适合直接派发）**：

| 消费点 | 文件:行 | 改法 |
|---|---|---|
| `data coverage` / `data daily` CLI | `apps/cli/src/main.rs:2789-2790` | `Box::new(agent_vitals_runtime::summary::JsonSummaryRepository)` → `SqlSummaryRepository` |
| Tauri `data_monthly_summary` | `apps/desktop/src-tauri/src/lib.rs:1239` | 同上 |
| Tauri `data_daily_summary` | `apps/desktop/src-tauri/src/lib.rs:1248` | 同上 |

`apps/cli/src/main.rs:2129`（`Cmd::DataReconcile`）**故意不在这份清单
里**——它比较的是「facts 索引 vs DTO」，用途是验证旧 index.sqlite3 投影
本身的一致性，不是终端用户消费面；保持读 `JsonSummaryRepository` 不动，
除非 Phase 4 决定连这条诊断命令也一起退休。

Tier A 验收：client parity——同一份真机数据，切换前后 CLI/Tauri 输出
byte-diff 应只有本来就存在的「json vs sql 已知残差」（本次会话
`reconcile_real.rs` 已量出：claude token 差 ~1.7%、codex 差 ~0.3%，来自
SQL facts 同步覆盖率/未计时事件，不是新 bug）；`cargo test --release` +
clippy 全绿。**这三行切完之后必须重跑一次 `reconcile_real.rs` 确认残差
没有扩大**——扩大说明切换本身引入了新问题，不是已知残差。

**Tier B（需要新实现，工作量与 `SqlSummaryRepository` 本体相当，不建议
现在派发给不熟悉本次会话上下文的 subagent）**：

1. **`calendar_month`/`hourly_distribution`**
   （`crates/agent-vitals-runtime/src/summary.rs`，Tauri
   `read_calendar_month`/`read_hourly_distribution` 调用）——直接读 DSH
   month/today.json、codex fold、claude ledger，逐日/逐小时组装，完全在
   `SummaryRepository` trait 之外。SQL 版需要仿照本次会话
   `authority_query.rs` 的模式：DSH 已经有 `peaked_days_map`
   可以直接复用出日轴；小时轴（`hourly_distribution`）需要新写一个
   `authority_query::hourly_by_harness`（三执行环境，参照 `codex_by_hour_model`
   的整数除法算北京小时，claude/dsh 也要各自补一版）。
2. **`budget show` / alert**
   （`crates/agent-vitals-runtime/src/budget.rs::{budget_show,
   budget_show_month, evaluate_alert}`）——DSH-only，读
   `month.json`/`today.json`/`alert.json`。切 SQL 前必须先做 **3.4**
   （`budget_config`/`budget_snoozes` 表的 CRUD API）——alert 阈值现在存在
   `budget.json`，没有 SQL 对应物，3.4 不做，3.5 这块无法切。
3. **HTML 模板消费面**（`codex-cost --html` →
   `render_codex_cost_html`/`codex_calendar_blob`，`apps/cli/src/main.rs`
   约 1146 行起）——内联进模板的 JSON 直接来自 codex fold 的 `merged`
   对象，不经过任何 repository。

**建议**：3.5 只派发 Tier A；Tier B 三项等 3.3/3.4 落地、或由我本人（已有
`authority_query`/`SqlSummaryRepository` 的完整上下文）继续做，避免 subagent
冷启动重新踩一遍北京时区算术、峰谷分离这类本次会话已经趟出结论的坑。

---

#### 3.6 导出切 SQL——先决问题，不要直接派发实现

**范围**：`crates/agent-vitals-runtime/src/export.rs` 的
`export_private`/`export_redacted`，当前都读 `facts/<harness>.jsonl` 原文件
（`export_private` 逐字节复制；`export_redacted` 经 `evidence::replay` 重放
后重导身份）。

**必须先回答的问题（不是实现细节，是方向判断）**：`usage_facts` 表的列
是原始 UsageFact JSON 字段的**子集**——`identity_basis`/`time_basis`/
`source_usage_semantics`/`model_raw` vs `model_id` 的区分/
`normalization_version`/`schema_version`/`event_ts_utc`（字符串）这些字段
在写入 SQL 时就没有对应列（`fact_writer_sql.rs` 只抽取了计价/查询需要
的列）。如果 3.6 真的把导出源换成 SQL 表，`export_private`
（"私有 trace 的完整面"，模块头原话）会从**逐字节精确复制**退化成
**从残缺投影重建的近似**——这是保真度倒退，且与 `export.rs` 模块头
"两条路径写各自的输出目录，绝不共用中间产物"暗含的"JSONL 是完整原始
证据"这条设定冲突。

**建议先确认再派发**：
- 若 spec §9 的本意是"JSONL 作为私有导出的权威源永久保留"（即使 SQL
  成为查询权威后，JSONL 仍是 evidence 层，不退役）——3.6 可能根本不需要
  改 `export_private`，只需要在文档/spec 里把这条决策明确写下来，检查
  项变成"确认现状符合预期"而不是"实现改动"。
- 若 spec §9 真的要求两个导出函数都改读 SQL——需要先决定
  `export_private` 能接受的保真度损失范围（哪些字段允许在导出里消失），
  这是产品/隐私决策，不是工程细节，我建议先问用户再让 subagent 动手，
  避免做出一个之后要推翻重来的实现。
- `export_redacted` 的伪名化逻辑（`pseudonym`/身份字段重导）与"读源是
  JSONL 还是 SQL"正交——不管往哪个方向走，这部分代码不用大改。

**如果确认要切 SQL**：读 `usage_facts WHERE deleted_at_ms IS NULL`（私有
导出可能还要决定是否包含软删除行——这也是需要先问的点，`export_private`
当前的"逐字节复制"语义下，被删除的行从未被排除，因为 JSONL 是
append-only 没有删除概念），按 harness 分文件写出，字段名映射回原
UsageFact JSON 形状（`fact_id`/`harness`/`machine_namespace`/... 直接对应列，
`event_ts_utc` 需要从 `event_ts_ms` 反算 ISO 字符串）。

## Phase 4：双轨验收与旧路径退役（spec §6.3 / §7 Phase 4 / §10）

- [x] **4.1 机器可读对账报告**（77a59ab）— `data-reconcile-authority
  [--month] [--json]`：`SqlSummaryRepository` vs `JsonSummaryRepository`
  逐 `harness × bucket`（token 严格相等）+ `provider × basis × currency`
  （金额最小货币单位）。分档 exact / explained（§6.3 允许例外：claude
  历史月 legacy 不保留—SQL 有 legacy_aggregate 更完整 / 当月缺口 ≤
  undated_residual / codex reasoning 双计 legacy bug）/ mismatch。
  `reconciled` = 全 exact-or-explained → 退出 0。`persist_reconcile_
  exceptions` 落 `data_quality_issues`（§6.3「每个例外必须有 issue code」），
  `data-status` `open_quality_issues_by_code` 可见。真机 2026-08/09 均
  `reconciled: true`。
- [x] **4.2 切换门槛 + 停写机制**（下一提交）— `runtime::sql_authority`：
  标记文件 `<data_home>/.sql-authority-enabled`。`data authority
  {status,enable,disable}`：`enable` 先跑 4.1 对账当月+上月，两个月都
  `reconciled: true` 才设标记（`--force` 越过）。标记存在 ⟺
  `fold_session` 跳过 merge_today/merge_month/write_alert、`claude-sync`
  跳过 ledger/archive 写（`oneline.json`/`sessions.jsonl`/`claude-fold.json`
  快照照常）。旧文件保留不删（spec §6.1 备份窗口）。**默认 OFF**——
  真机翻开关需用户先做备份确认（spec §6.1）。差分链（`test_oneline_
  lockstep`/`test_claude_cost` claude-sync）测试夹具无标记 → 不受影响。
- [x] **4.3 退役清单执行**（spec §10）— 用户 2026-09-07 决定提前执行（翻
  开关 + 纯 SQL 重导入），分 6 stage 落 `main`（代码全绿；真机启用 + 观察期
  见 4.4 最后一项）：
  - [x] **Stage 1**（ad4e33e）— 退役 `reconcile_authority_vs_legacy` /
    `persist_reconcile_exceptions` / `reconcile_budget_sources` /
    `compute_month_from_index` + CLI `data-reconcile-authority` /
    `data-budget-reconcile` + `examples/reconcile_real.rs`。`data authority
    enable` 门槛改查权威库健康（integrity + facts + last-run）。
  - [x] **Stage 2**（b5ca48c）— 删 `summary::JsonSummaryRepository` +
    impl + 4 个 legacy 读 wrapper（claude/codex ledger·fold 读层）+ CLI
    `data-reconcile` + `ingest_service::reconcile_index_vs_dto`。~987 行；
    2 条 client-parity 测删除、7 条组装层不变式迁到 `SqlSummaryRepository`
    + `seed_fact`。`SummaryRepository` 只剩 SQL 一个实现。
  - [x] **Stage 3**（98602a7）— `budget show` / `budget show --month M` 读
    SQL 权威库（`evaluate_alert_from_sql` / `month_cost_sql` + 新
    `budget_config_sql`）；删 `compute_month`。`test_cli_matrix::
    test_budget_show_differential` 退役（Rust SQL vs Python month.json 不再
    逐字节可比；Python `budget show` 保留给 ClawHub，覆盖在 test_budget.py）。
  - [x] **Stage 4**（b5ca48c）— `data-migrate` 的 `legacy_aggregate` ledger
    深历史导入改 opt-in（`--with-legacy-ledger`，默认 off）。`legacy_import`
    模块保留（spec §10「只留 importer」）。`sync-facts` 本就不碰 ledger。
  - [x] **Stage 5a**（8498023）— 退役旧 `index.sqlite3` / `store` 模块 +
    `FactsIndex` + `ingest_facts` 的索引写块 + `rebuild_index` /
    `RebuildOutcome` + CLI `data-rebuild-index`。`peak_of` 移进
    `fact_writer_sql`。13 个月保留（`enforce_retention`）保留、`sync_facts`
    每天首轮自动跑。权威损坏恢复 = `rm agent-vitals.sqlite3* && data-migrate`。
  - [x] **Stage 5b** — **5b-a（4c0fba9 + 本次收口）**：DSH `oneline` 只产
    `oneline.json` / `sessions.jsonl` 导航快照；`state.rs` 的日/月/告警/budget
    写入口（`merge_today` / `merge_month` / `write_alert` / `set_snooze` /
    `by_source_report` / …）、`evaluate_alert_from_state` /
    `evaluate_alert_after_fold`、`takeover::fold_session` 的 merge/write_alert
    分支、`behavior --json` 的 `hour_buckets` 键、主二进制的 `state
    merge-today/merge-month/write-alert/snooze/unsnooze/by-source/by-model` 子命令
    **全部删除**。Python 侧：`takeover.py::fold_session_req` mirror 对齐成
    「只落导航快照」；`state.py` 的 merge/alert/snooze 函数保留给 ClawHub 兼容
    CLI（`test_state.py` / `test_state_history_rotate.py` / `test_budget.py`
    覆盖），但不再进 Rust↔Python 差分。差分测试收口：`test_oneline_lockstep`
    只比导航协议 + 「旧业务 JSON 不得复活」断言；`test_state_write_chain` 的
    `StateWriteChainDiff`（对端 Rust 子命令已删）整层移除、保留 Python-only
    `StateMergeCharacterization`；`test_takeover_lockstep` 的 `TakeoverShadowDiff`
    / `TakeoverFencingExactlyOnce` 改比 `sessions.jsonl` + ledger（不再读
    `today.json` / `month.json`）；`e2e_smoke.py` M1/M5 改比 `usage` 折叠、
    删去已退役的 xbar M7。**Python 差分门全绿**（`unittest discover tests`
    1151 例 + golden 15/15 + `e2e_smoke` ALL OK）。
    **5b-b（cf71a22）**：例行 `sync-facts`
    用 `source_files(harness,path_hash,size_bytes,mtime_ns)` 作为唯一差量索引，
    source 元数据和 facts 在同一 SQL 事务提交；旧 `.ingest-checkpoint.json`
    只在首启迁入后改名为 `.migrated`，运行时不再读写。**5b-c（a1e4851）**：
    `data-unresolved` 复用 authority 的三执行环境窗口查询和同一份历史价格卡，
    不再读取 ledger/codex fold/month JSON。**5b-d（c503563 + 370e495 + 本次
    schema v2 backfill 收口）**：`sessions navigation` 的三执行环境今日 token 改为
    authority 聚合；Codex 配额作为 schema v2 `harness_runtime_snapshots` 的
    `codex_quota` 快照，在同一次 `sync-facts` 事务写入、桌面端只读 SQL——
    schema v1→v2 升级时强制重放一次 Codex rollout 补齐该派生快照（`schema_meta`
    标记保证只补一次）。配额不混入 UsageFact（形状/写语义/聚合三方面都不同）。
  - [x] **Stage 6** — 文档 + plan + spec §10 sweep + 收口。
- [x] **4.4 人工验收（可自动化部分，58c38b8）** — `tests/test_data_status_
  health.py`（5 例 AGENT_VITALS_BIN 二进制用例）：删库 → critical 退出 1
  不静默零、非 SQLite 内容 → 退出 2 + stderr、截断库 → integrity critical、
  权威启用后删 state/*.json → `data coverage` 照常从 SQL 出数。kill 后恢复
  = `authority::interrupted_running_batches_are_swept_on_open` +
  `q12_double_import_with_interrupted_run`（既有）。
  - [ ] **真机迁移演练**：备份 → `data-migrate` → 逐月对账 → 启用 → 观察。
    步骤见 §「真机启用 runbook」，用户本机执行（spec §6.1 需用户确认备份）。

---

## 测试矩阵（spec §8 → 落点）

**2026-09-07 盘点**：⬜ 多为滞后标记——Phase 2/3/4 落地时各自带了测试，下表
按真实覆盖重标。

| # | 类别 | 落点 | 状态 |
|---|---|---|---|
| 1 | schema migration（空装/升级/重复/中断/低版本/高版本） | `agent-vitals-data/src/authority.rs::tests` | ✅ 核心 6 条（空装建全 schema / 中断清扫 / 损坏报不删 / 半建拒绝 / 高版本拒绝 / txn 回滚）。低版本升级路径仍缺 |
| 2 | ingest（重放/修改/截断/坏行/并发） | `fact_writer_sql`（12）+ `sql_sync`（12）+ `lease`（8） | ✅ 重放幂等 / source 指纹更新 / 坏 ts 拒绝 / 负 token 拒绝 / 混会话回滚；并发 = lease 互斥 + TTL 偷锁。截断恢复走 legacy `sync_service` 半行修复 |
| 3 | transaction 故障注入（facts/bills/checkpoint/run 各提交点） | `authority::immediate_txn_rolls_back_on_error` + `fact_writer_sql::mixed_session_batch_..._rolls_back` + `store::failed_rebuild_rolls_back_to_previous_index` | 🔶 通用回滚 + rebuild 回滚有；逐提交点注入（bills/checkpoint 单独）未穷举 |
| 4 | CRUD（soft delete/retention/分页 cursor） | `authority::retention_deletes_only_dated_rows` + `harness_bill_put`（soft delete + 复活）+ `authority_query::facts_page_window_is_stable_and_cursor_paginates` + `store::pagination_is_ordered_and_sliced` | ✅ |
| 5 | query（时区边界/峰谷/跨月/跨币/unresolved） | `authority_query`（12：月/日边界 / 峰谷分桶 / legacy 排除 / untimed 排除 / coverage 三维）+ `q03`（北京月首 00:30）+ `q05`（unpriced）+ `summary` 跨币 ProviderAcc | ✅ |
| 6 | reconciliation（全量+增量） | `q12_double_import_with_interrupted_run`（增量幂等 + 回滚）+ `data-reconcile` 命令（迁移期用过）| 🔶 Phase 4.3 退役了 SQL-vs-legacy / index-vs-DTO 两条对账（legacy 侧已删）；增量幂等 + 中断回滚仍有测试。迁移收敛后对账不再是常设面 |
| 7 | client parity | `summary::sql_repository_{dsh_month,claude_day,codex_day}_matches_json_repository` + `q_acceptance::separation_discipline` | ✅ |
| 8 | performance（不枚举原始日志/索引命中） | `authority_query::windowed_queries_hit_the_harness_time_index_never_full_scan`（306af6e，EXPLAIN QUERY PLAN 逐条断言命中 `usage_facts_harness_time`、不 SCAN） | ✅ |
| 9 | 用户查询验收 Q01–Q14 | `crates/agent-vitals-runtime/tests/q_acceptance.rs`（q01–q05/q11/q12/q14 e2e）+ `summary` 内 Q13 4 例 | ✅ Q01–Q05/Q11–Q12 blocker 集 e2e 齐（b082a79）；Q13 lib 级 |

---

## 真机启用 runbook（用户本机执行——4.4 真机演练 + 4.3 观察期起点）

spec §6.1 要求**用户先确认备份**再翻 `sql_authority_enabled`——代码侧不代做。
下面每步给命令 + 通过判据；任何一步不通过就停下，别硬翻开关。

> **2026-09-08 部署状态**：本机 `~/.agent-vitals/agent-vitals.sqlite3` 已在开发
> 测试中迁到 schema v2（`sql_authority_enabled=true`，~54,900 facts，health ok）。
> `/Applications/agent-vitals.app`（内置 CLI）+ `~/.local/bin/agent-vitals` 均已
> 多轮用当前 `main` 的构建重装（`cargo tauri build --bundles app` → 替换 .app +
> `cp target/release/agent-vitals`；最新含 Data MCP Q04/Q12 —— `sessions_search`
> / `session_detail` / `data-reimport-verify`）——旧 v1 二进制会对 v2 库报
> `NewerSchema`。教训同 §3.5 部署纪律：**schema/fold 语义变更必须同步重装所有
> 部署点**。备份因此只是补做（迁移已发生）；下面的逐月核对 + 观察期仍需走。

### 1. 备份（不可跳过）

```bash
cp -a ~/.agent-vitals ~/.agent-vitals.backup-$(date +%Y%m%d)
ls -la ~/.agent-vitals.backup-*        # 确认 facts/ + state/ + agent-vitals.sqlite3 都在
```

### 2. 全量同步 + 迁移（把权威库刷到最新）

```bash
agent-vitals sync-facts                 # 三执行环境 emit → SQL 权威 + legacy 双写
agent-vitals data-migrate               # 存量 facts JSONL → 权威库（幂等，可重跑）
agent-vitals data-status                # health: ok / integrity: ok / facts 数量合理
```

判据：`health: ok`、`integrity: ok`、`facts` 与 `~/.agent-vitals/facts/*.jsonl`
行数量级一致、`recent_runs` 最新一条 `succeeded`。

### 3. 逐月对账（当月 + 上月 + 抽查一个历史月）

```bash
agent-vitals data-status --json        # health: ok / integrity: ok
agent-vitals data monthly --month "$(date +%Y-%m)" --json   # 逐执行环境数字与体感核对
agent-vitals budget show               # DSH 按量预算态
```

判据：`data-status` health=ok、integrity=ok、facts 数量级合理；`data monthly`
的逐执行环境数字与你对本月花销的体感一致。Phase 4.3 起没有 legacy 第二实现
可对账——核对靠 `data-status` 健康 + 人眼看数字。

### 4. 翻开关

```bash
agent-vitals data authority enable      # 内部再跑一次当月+上月对账做门槛
agent-vitals data-status                # sql_authority_enabled: true
```

`enable` 通过 ⟺ 门槛对账绿。通过后：旧 state JSON（today/month/alert、claude
ledger）**停止更新**，导航快照（oneline.json/sessions.jsonl/claude-fold.json）
照常。旧文件保留不删。

### 5. 观察期（4.3 退役的门槛，建议 ≥ 1–2 周）

期间正常用 CLI / 托盘 / 工作台，关注：

- 至少经历 **一次增量 `sync-facts`**、**一次重启**、**一次日界 + 一次月界**；
- 每天 `agent-vitals data-status` 看 `health`；托盘/日历/预算的数字与体感一致；
- 任何时候想回退：`agent-vitals data authority disable` → 立即恢复双写，
  legacy JSON 重新成为权威（观察期内旧文件没删，回退无损）。

观察期无异常 → Phase 4.3 的真机验收完成；旧业务 JSON 继续保留为备份，不再
重新成为运行时读写源。
异常 → `disable` + 从 `~/.agent-vitals.backup-*` 恢复，带现场回来。

### 6. 真机演练（4.4 的自动化测不到的部分）

在**备份之后、观察期之前**各做一次，确认机制在真数据上成立：

```bash
# kill 后恢复：迁移中途 Ctrl-C，重跑
agent-vitals data-migrate &  sleep 1; kill %1;  agent-vitals data-migrate
agent-vitals data-status        # recent_runs 有 cancelled，facts 无重复、无半写

# 删旧 JSON 仍可查（开关已启用的前提下）
mv ~/.agent-vitals/state/month.json /tmp/ ; agent-vitals data coverage --month "$(date +%Y-%m)"
mv /tmp/month.json ~/.agent-vitals/state/

# 删库明确告警不回落
mv ~/.agent-vitals/agent-vitals.sqlite3 /tmp/ ; agent-vitals data-status; echo "exit=$?"
mv /tmp/agent-vitals.sqlite3 ~/.agent-vitals/    # 退出码应为 1，health critical
```

---

## 关键工程纪律（实施期间不可违反）

1. **禁读清单**（Phase 3 起）：product 代码不得直读 month.json /
   today.json / ledger / codex fold / facts JSONL——只能经 repository。
2. **金额不落浮点**：库内一律最小货币单位整数；展示层换算。
3. **无日期/质量异常事实不静默删除**：retention 只处理有日期且过窗的行；
   异常行走显式修复流程。
4. **两处同步**：DDL 改动 = spec §3 + `authority.rs::SCHEMA_V1` 同改 +
   `SCHEMA_VERSION` 递增。
5. **MSRV 1.74**：不引入 >1.74 的 std API（clippy incompatible-mssvr 已
   开 `-D`）。
6. **每 Phase 收口**：全量测试（含 `AGENT_VITALS_BIN` 差分 + golden）→
   subAgent 审查 → 修复 → 编译安装 App 验证内置 CLI。

---

## 验证命令

```bash
# 权威库单元面
cargo test -p agent-vitals-data authority

# 全量 gate（每个收口点必跑）
cargo clippy --all-targets -- -D warnings
cargo test
AGENT_VITALS_BIN=$PWD/target/release/agent-vitals python3 -m unittest discover tests
AGENT_VITALS_BIN=$PWD/target/release/agent-vitals python3 tests/golden_runner.py

# 双轨对账（迁移期持续观测）
./target/release/agent-vitals data-status --json
./target/release/agent-vitals data monthly --month 2026-09 --json

# App 编译安装（Phase 切换点）
cd apps/desktop/src-tauri && cargo tauri build --bundles app
```
