# v0.10 Value Loop 架构规格审查

> 审查对象：`docs/AGENT_VITALS_V0_10_VALUE_LOOP_ARCHITECTURE_SPEC.md`
> 审查基线：工作副本（含**尚未提交**的 §10 schema v3 增量 + §11 待合并 patch，共 648 行；
> 已提交版本 d676f68 只有 §0–§9 共 473 行）。
> 代码基线：main @ d9fe06e（v0.9.1 SQL 权威库 schema v2 已落地）。
> 结论：**方向正确，但不能按现状进入 v0.10-A 实施**——17 条 finding，其中 4 条 P0
> 会直接产出编造数字或数据损坏，6 条 P1 与已落地代码脱节、照写即返工。
>
> **落地状态（2026-09-08）：F1–F17 全部已应用，spec 升版 R1 → R2**，§11 patch 影子章节
> 已并入 §2–§9 正文，changelog 见 spec §12。唯一未闭合的是 **F17 之外的范围建议**
> （v0.10-D 降 v0.11、v0.10-C 首批 1 条 remedy、DoD 第 10 条 3 → 1），已在 spec §7 / §9
> 标注「待 PM 拍板」——那是产品决策，不是技术修正。本报告保留为 finding 的论证来源。

---

## 0. 总评

§0–§9（R1 正文）的**产品判断是对的**，而且对得很关键：把北极星从「发现多少异常」挪到
「多少问题拿到了可执行方案并真的省下了钱」，这是 v0.9「可信数据」之后唯一有价值的下一
步。§2.2 的三档 savings 分离、§3 的「程序评估优先 / LLM 默认关闭」、§8 的「不伪造
parent/time/status」，都是这个仓库既有纪律（Unavailable vs MeasuredZero、residual
sentinel、coverage 三态）的正确延伸。

§10 + §11 是把 R1 往下钉一层的正确动作，但**这一层的落地细节大量脱离了 main 上的真实
代码**，且引入了四个会自我伤害的设计。下面按严重度排。

---

## P0 — 会产出编造数字或数据损坏

### F1. `potential = nominal_cost − metered_spend` 是口径错误（§11.3）

§11.3 给出的映射表把 `potential` 定义为「名义成本 − 按量实付（仅适用于按量计费模型；
订阅型模型不产 potential）」。**这个差额不是可避免浪费，是你已经拿到的折扣。**

按 `ATTRIBUTABLE_WASTE.md` §6/§6.7 与 CLAUDE.md 的权威定义：`nominal_cost` 是官方标价
折算的客观基准（"名义 GDP"式），`metered_spend` 是按量实付；两者之差来自套餐/中转/促销
折扣。**没有任何 remedy 能"实现"这个差额**——修掉一个僵尸 Skill 省的是 token，省不出
中转折扣。按现状实现会得到：

- 一个巨大且恒定的 `potential savings`，与 issue 数量无关，与任何修复动作无关；
- `realized / potential` 比值恒为接近 0，§9 DoD 第 10 条「验证实际结果」永远不达标；
- 首页「可避免浪费」（§11.5 Overview 新增 tile）显示的是折扣额——正是 8 月
  「日历 ¥2386 vs 实测 ¥1733」那类事故的同形态：一个没人能对账的大数字。

**建议改成**：`potential` = **归因到该 issue 的浪费量 × 该 issue 自己的计价基准**，即
`Σ(wasted_tokens × price_on_same_basis)`，与 observed 同 basis 同币种。名义/实付之差
属于 §6.7 的「订阅利用率」指标，归 Settings/计费页，**不进 savings 三档**。

另外「订阅型模型不产 potential」也需要改：订阅制下浪费照样存在，只是**收益不落在钱上**
——应按本仓库既有纪律报 **token 口径的 potential + money = `unavailable`**（配额/限流
余量），而不是不产。填 0 或不产，就是 `evidence.rs`「adapter 不得用读不到的东西刷覆盖」
的镜像违规。

### F2. `issue_instances` 的 PRIMARY KEY 与 UNIQUE 自相矛盾，且击穿 DoD 第 7 条（§10.2.1）

```sql
issue_id TEXT PRIMARY KEY,   -- fnv1a64_hex(canonical_json(harness, issue_type, instance_fingerprint))
...
UNIQUE(harness, instance_fingerprint, status)  -- §9 DoD 第 7 条幂等性
```

两个约束的键不同：`issue_id` 不含 `status`，`UNIQUE` 含。后果：

1. 按 `UNIQUE` 的语义，同一个 issue 可以**同时存在 open / acknowledged / closed /
   wontfix 四行**——status 不同即放行；
2. 状态流转会被实现成 INSERT（新 status 不冲突）而不是 UPDATE，历史静默重复；
3. 但 `issue_id` 是 PK 且不含 status，第二行插入时 PK 冲突 —— **两个约束打架，
   实现者只能二选一，而 spec 没说选哪个**。注释却写着这条 UNIQUE 就是 DoD 第 7 条
   「同一输入重放不重复写」的落地，实际是它的反面。

**建议**：`UNIQUE(harness, instance_fingerprint)`，`status` 作为可变列 UPDATE；需要状态
历史就单开 `issue_status_transitions(issue_id, from, to, at_ms)`，别塞进幂等键。

### F3. 派生层 memo 的失效条件永不触发，且表名不存在（§10.1 / §10.3 / §11.7）

三处都写「失效条件 = session_facts 表 `MAX(fact_id) WHERE session_key=?` 计数器对比」。
两个问题：

1. **`fact_id` 是哈希不是序号**。真实实现 `contracts/usage_fact.rs:97-110`：
   `format!("uf1-{}", fnv1a64_hex(...))`。对哈希字符串取 `MAX()` 是字典序最大值——新写入
   的事实只要哈希字典序小于当前最大值，`MAX` 就不变，**memo 永不失效，长期喂陈旧
   TraceGraph**。这正是本仓库反复踩的「看着正常、静默返回旧数据」类缺陷。
2. **`session_facts` 表不存在**。authority 库的 13 张表是：`usage_facts` / `sessions` /
   `source_files` / `sync_runs` / `data_quality_issues` / `harness_bills` /
   `harness_runtime_snapshots` / `pricing_snapshots` / `budget_config` / `budget_snoozes` /
   `workflow_events` / `migrations` / `schema_meta`。会话事实在 `usage_facts`。

**建议**：失效条件改为 `(COUNT(*), MAX(rowid))` 或每会话 `updated_at_ms`/ingest 序号；
表名改 `usage_facts`。**并加一条守卫测试**：写入一条新 fact 后 memo 必须失效——否则
这个 bug 会以「gate 全绿的假绿」形态存活（Stage A–D 审查同根因）。

### F4. `outcome_measurements` 缺 metric / pricing 版本戳（§10.2.5）

`metric_id TEXT NOT NULL` 但 §10.3 明确 MetricDefinition **不入 schema**（现算），而
§2.2 又说 MetricDefinition 带版本。于是：**baseline 行的寿命长于产生它的指标定义**。
指标口径一改，历史 baseline 与新 observed 的比较就是拿两把不同的尺子相减。

同理 pricing：`assets/pricing.json` 是业务数据，**改价不需要 golden `--update`**
（CLAUDE.md 明写）。用 9 月价卡去减 7 月 baseline 得到的 `realized savings` 是编造的。

**建议**：`outcome_measurements` 增 `metric_version TEXT NOT NULL` +
`pricing_snapshot_id`（authority 已有 `pricing_snapshots` 表，直接引用），并把
`metric_version` 并入 UNIQUE 键；版本不一致时 `savings_coverage_json` 报
`unavailable`，不出数。

---

## P1 — 与已落地代码脱节，照写即返工

### F5. schema 版本机制写错：本仓库不用 `PRAGMA user_version`（§10.4）

§10.4 整节的升级路径（`PRAGMA user_version < 3` → `migrate_v2_to_v3()` → 置 3）在本
仓库不成立。真实机制（`crates/agent-vitals-data/src/authority.rs`）：

- `pub const SCHEMA_VERSION: i64 = 2;`（:33）
- 版本存在 **`schema_meta` 表**：`SELECT value FROM schema_meta WHERE key='schema_version'`
- 升级逻辑在 `ensure_schema` 的版本比较分支里（:401 `found.cmp(&SCHEMA_VERSION)`），
  低版本走 :98 的 "run product migration" 错误路径
- 全仓库 `PRAGMA user_version` 只在一处注释里出现，且是**明确说"不是它"**
  （`harnesses/dsh/sources.rs:31`）

§10.4 需整节重写为：bump `SCHEMA_VERSION` 常量 2→3、在 `ensure_schema` 的版本比较分支
加 v2→v3 迁移、`migrations` 表记录 checkpoint、`data-migrate` 子命令接线。

### F6. §11.6「基座层」目录树多处与 main 不符

§11.6 的价值恰恰是「让读 spec 的人知道哪些已落地」，所以它错得最贵。逐条：

| spec 写的 | main 上的真实位置 |
|---|---|
| `agent-vitals-data/src/store.rs` | **已退役**（Phase 4.3 删除 `index.sqlite3`/`FactsIndex`）。JSONL writer 在 `fact_writer_sql.rs` / `evidence.rs` |
| `agent-vitals-data/src/sql_sync.rs` | 在 **runtime**：`agent-vitals-runtime/src/sql_sync.rs` |
| `agent-vitals-runtime/src/authority/` | 是文件 `sql_authority.rs`（无该目录） |
| `agent-vitals-runtime/src/lease/` | 是文件 `lease.rs` |
| `domain/contracts/canonical.rs` | **不存在**；`CanonicalSession` 在 `contracts/evidence.rs` |
| `domain/{usage,evidence,behavior,plan}/` | 均为**文件**非目录（`usage.rs` 等）；`evidence` 在 **contracts/** 不在 domain/（扁平 re-export 路径可用） |
| `domain/cost/` | ✅ 正确（唯一是目录的） |

另：`agent-vitals-data/` 实际还有 `billing.rs` ✅ / `authority_query.rs` ✅ /
`coverage.rs` / `projection.rs` / `repository.rs` / `safe_query.rs` / `legacy_import.rs`
/ `reimport_verify.rs`，`harness_bills` 表也已存在（memory 里记的「HarnessBillRecord 待做」
已过期）。

### F7. `codex_merged_cached` 不存在（§10.1 / §10.3）

两处把它当作派生层 memo 的参照实现（"复用 `runtime::summary::codex_merged_cached` 同
模式，进程级 60s memo，按 home 键控"）。main 上的函数是
`runtime::summary::codex_merged_from_sql`（`summary.rs:1305`），**且已改为直接读 SQL
权威库、没有 60s memo**。CLAUDE.md 里那段描述也已过期（v0.9.1 SQL 迁移后遗留）。

后果：§10.3 整张表的缓存策略引用了一个不存在的模板。**建议**：要么把 memo 模式在
v0.10-A 里当作新建的东西写清楚（含 F3 的失效条件），要么直接复用
`sessions/r2a_store.rs` 已有的 checkpoint/memo 形状。顺手把 CLAUDE.md 那句也改掉。

### F8. 两个被当作「直接复用」的纯函数名不存在

- §11.2：`agent_vitals_domain::cost::{priced_token, priced_day, cost_report}` ——
  **`priced_token` 不存在**。`domain/cost/mod.rs` 的公开面是：`load_pricing` /
  `cache_counterfactual_cost` / `cost_report` / `cost_series` / `priced_day` /
  `bucket_cost` / `month_cost` / `today_cost` / `cost_block`。
- §11.11（两处）+ §4：`plan::rank` —— **不存在**，真实是
  `domain/plan.rs::build_plan(report, startup_rate)`。

§11.11 的论点（「v0.9 plan 已是 remedy 雏形，不要推翻重写」）是对的，但函数名错了就
无法在 review 时核对是否真的复用了。另 §11.2 的 `usage::usage_fold_state` 是**结构体
`UsageFoldState`** 不是函数。

### F9. §11.4 的 redaction 路径既写错 API，也用错了脱敏器

写的是 `agent_vitals.redact(redact_names=True, drop_description=True)`。真实签名
（`packages/agent-vitals-python/agent_vitals/compat.py:39`）：
`redact(obj, names=False, name_map=None, *, home_n=None, cwd_n=None)` —— 没有
`redact_names` 也没有 `drop_description`（description 整体丢弃是 redact 内部行为）。

更要紧的是**类别错误**：这个 redact 是给**扫描报告**做的（skill 名、路径、description），
它的属性测试 `tests/test_properties.py` 保证的是「报告里不残留真实 skill 名」。而 LLM
evaluator 的输入是**会话正文 / 工具结果 / 提示词**——完全不同的敏感面（凭证、客户数据、
文件内容）。把前者当成后者的单一权威，会得到一个**看起来被守卫覆盖、实际没覆盖**的
脱敏路径。

**建议**：§11.4 改为「LLM evaluator 输入需要一条**新的**会话正文脱敏管线，
与扫描器 redact 并列、各自有属性测试」，并把它列为 v0.10-D 的前置门槛（而不是复用）。
§11.4 的核心主张（不得自造第二份脱敏、cache 只存 redacted 指纹）保留，是对的。

### F10. feature-gated 建表混进 schema v3，两种 DB 同称 v3（§10.2.6 / §10.4）

§10.4 第 2 步「若 feature llm-evaluator 启用 → CREATE TABLE llm_evaluator_cache」，然后
统一置版本 3。于是 `schema_version=3` 的库有两种表集合；且**先以关闭态迁到 v3、之后
再开 feature 的机器永远不会建这张表**（迁移已跑过）。§10.2.6 的
「evaluator_registry 启动时检测该表存在性」正是这个歧义的症状。

**建议**：v3 无条件建表（空表零成本），feature 只 gate **写入与读取路径**；或给它
独立的 v4。schema 版本必须唯一决定表集合。

---

## P2 — 设计取向，建议调整

### F11. `remedy_definitions.applies_via_json` 存可执行 SQL 字符串（§10.2.2）

`{kind:'sql', sql:'...'}` 让 remedy catalog 变成**可执行内容**：一行被改写的 DB 记录
就是对权威库的任意 SQL。这与本仓库的核心立场（「审计供应链风险的 skill 自己不能在扫描
时拉第三方代码」）方向相反，也绕过了已有的 `safe_query.rs` 授权器（它连**只读**查询都
要按列拒绝）。§10.7 第 3 条只约束了「必须走 preview/approval」，没约束「内容本身是
可执行的」。

**建议**：`applies_via` 改为**代码注册的 handler 枚举** + 参数 JSON
（`{kind:'disable_skill', params:{...}}`），runtime 按 kind 分派到编译进二进制的实现。
DB 里永远不存可执行文本。

### F12. remedy catalog 不该是 DB 表（§10.2.2 / §10.5）

catalog 是**代码版本化的业务规则**（§11.11 自己说种子来自 `plan::build_plan` 纯函数），
不是用户状态。放进 SQLite 会导致：升级后旧行与新二进制口径不一致；§10.5 又给它豁免
retention，于是陈旧条目永久存活；还带来 F11 的可执行内容问题和两条 FK。

**建议**：catalog 与 `assets/pricing.json` 同待遇——放 `assets/remedies.json`（或直接
代码常量），DB 只存 `remedy_id` 引用。`issue_remedies` / `action_receipts` 的
`FOREIGN KEY(remedy_id)` 随之去掉。

### F13. 「空串代替 NULL」被推广到了 FK 形状的列（§10.6 / §10.2.4 / §10.2.5）

v0.9 那条规则的**理由**是：SQLite 的 UNIQUE 把多个 NULL 视为互不相同，所以**参与
UNIQUE 键**的可空列必须写空串。但 §10.2.4 的 `rollback_receipt_id` 和 §10.2.5 的
`receipt_id` **都不在任何 UNIQUE 里**，却按这条规则写了 `DEFAULT ''`。代价：`''` 破坏
引用完整性（JOIN 到不存在的 receipt）、`WHERE receipt_id IS NULL` 语义失效、若哪天补上
FK 会直接违反。

**建议**：把规则收窄成它本来的样子——**只有参与 UNIQUE 键的可空列用空串**，FK 形状的
列用 NULL。在 §10.6 表格里把理由写出来，否则它会继续被当成全局规则 cargo-cult。

### F14. 跨币导致的 NULL 与「尚未测量」不可区分（§10.6）

「跨币相加自动 None → `savings_value_minor` 自动 NULL」。但 NULL 在这张表里已经表示
「还没测」。聚合查询会把这两种静默合并，`SUM` 直接跳过——**又是一次「不完整却不标记」**。

**建议**：跨币走已有的 `savings_coverage_json` 三态（`coverage` / `partial` /
`unavailable`），填 `unavailable` + `counterfactual_note` 说明跨币；`savings_value_minor`
的 NULL 只表示未测量。这与 §10.6 自己引用的
「`unaccounted_usage` residual sentinel 语义：绝不填 0 假装完整」一致。

### F15. `coverage_ratio` 是个会被误用的单值（§11.1）

`1.0 - (missing_parent + missing_time + missing_status) / (3 * total_nodes)`：
`total_nodes = 0` 时除零；`missing_time` 一个节点最多计 1（起止都缺也是 1），与另两维
不同权；更重要的是——**一个 0..1 的比率会诱导跨会话求平均**，而本仓库的纪律是「部分
覆盖必须打标，不得按精确值计价/聚合」。

**建议**：保留三个计数 + `total_nodes`，`coverage_ratio` 要么删掉，要么显式标注
`display_only`、禁止进任何聚合。

### F16. §11.5 的 tab 映射表漏了一个现存 tab，且提了一次无收益的破坏性改名

- 工作台当前实际是 5 个 tab：`总览 / Token 日历 / 会话 / Findings / 数据源`
  （`apps/desktop/src-tauri/ui/workbench.html:12-16`）。§11.5 的表把
  「Token 日历」当成 Overview 里的一块内容在正文里提，**表里没有它的行**——读表的人会
  以为 5→6 是纯新增，实际还有一个 tab 要被合并掉（这正是 §11.5 自己想避免的
  「在两个版本里被两边都改一次」）。补一行 `Token 日历 → 并入 Overview / v0.10-A`。
- 「DSH audit tab 的 `behaviorFindings` projection 同步改名为 `issueFindings`」：这是
  跨 harness/client 两半的契约改名（`harness/index.ts` 注册 + `client/index.cts` 的
  `useProjection` 键 + 若干注释），**收益为零**（UI tab 名与 projection 名本就不必同名），
  风险是双面插件不同步。建议删掉这条。

### F17. §11 作为「待合并 patch」的影子章节，本身是个隐患

现在这份 spec 里同一件事有两处描述：§2–§9 的原文，和 §11「改哪里 / 改成什么」。读者
必须在脑子里做 patch 才能得到真实规格。这正是 CLAUDE.md 反复警告的多副本漂移形态
（`pricing.json` 三副本要靠 lockstep 测试守，就是因为副本必然漂）。§11.12 的「按节奏
拆 PR 合并进原文」如果不马上做，§10 一改、§11 忘改，规格就自相矛盾。

**建议**：**先把 §11.1–§11.11 应用进 §2–§9 正文（一个 PR），版本 R1 → R2**，§11 压缩
成一张 changelog 表（哪节改了、为什么）。§10 保留为独立章节没问题（它是新增持久化层，
不是对既有章节的 patch）。

---

## 1. 范围建议

§6 一次列了 10 个新 service（trace / metrics / validation / evaluation /
llm_evaluation / issue / remedy / action / outcome / projection）+ 5 张状态表 + 3 个新
tab + 执行/回滚闭环。参考 v0.9→v0.9.1 的实际节奏（数据面三阶段 + 三轮审查循环 + 一次
SQL 权威库迁移，且 Stage 5b / Data MCP M1 仍未收口），这是 2–3 个版本的量。

建议显式收敛：

1. **v0.10-A 必须能单独发布并有独立价值**——只做 TraceGraph + Traces tab + coverage
   降级显示，不依赖 Issues/Savings。目前 §7 的 A 段基本满足，保持。
2. **v0.10-D（LLM）整体降为 v0.11 候选**。它带来 §10.2.6 的 schema 歧义（F10）和 F9 的
   脱敏管线新建成本，而 §3 自己说它「默认关闭、不阻塞 A–C」——那就不该占 schema v3 的
   版本位。
3. **v0.10-C 的 action/rollback 是本版本唯一不可逆面**，建议首批只做 §4 点名的
   「禁用长期未触发且证据充分的 Skill」一条，把 preview→approve→apply→receipt→verify
   的骨架跑通，再扩 catalog。§9 DoD 第 10 条要求「至少三个低风险方案端到端」，
   建议降到 1 条并把另两条挪到 v0.10.1。

## 2. 补充建议（spec 目前完全没提）

- **§10 新表全部缺 `machine_namespace`**。v0.9 的事实层是按 `machine_namespace` 隔离
  的（`source_identity` 的隐私护栏），issue/receipt/outcome 不带这个维度，多机同步或
  导出时会串。至少 `issue_instances` 需要。
- **§6 `data-export-private` / `data-export-redacted` 双路径（v0.9.1 spec §6 明令）没有
  覆盖新表**。issue 的 `title`/`summary`/`root_cause`/`metadata_json` 和
  `action_receipts.action_target_json` 都是自由文本，是导出泄漏面。需要在 §10 里说明
  两条导出路径如何处理这 5 个字段。
- **§9 DoD 缺一条**：「savings 的每一个数字都必须能下钻到产生它的 fact_id 集合」。这是
  把 F1/F4 这类口径错误挡在发布之外的唯一可操作手段——不能下钻的数字就是不能对账的
  数字。

---

## 3. 建议的落地顺序

| 优先级 | 动作 |
|---|---|
| 1 | 修 F1（potential 口径）——它决定整个产品的北极星指标是否有意义 |
| 2 | 修 F2 / F3 / F4（幂等键矛盾、memo 永不失效、缺版本戳）——都是会静默出错的 |
| 3 | 按 F5–F8 校正所有对 main 的代码引用（半天工作量，避免 A 阶段返工） |
| 4 | 执行 F17：§11 合并进正文，R1 → R2 |
| 5 | F9–F16 在对应阶段 PR 里处理；F10/F9 随 v0.10-D 一起延后 |
