# Agent Vitals v0.9.1 SQL Authority Migration Spec

> 状态：**已冻结（2026-09-06，Phase 0）**——实施期间的不可变决策见 §1.1；  
> 前置：v0.9 已具备 UsageFact 清洗/身份、执行环境读取、同步入口、SQLite 索引和冻结的 Summary DTO
> 目标：将运行时数据权威从「JSON state + 原始日志 + JSONL + SQLite 索引」收敛为 **SQLite 单一权威库**，以可恢复迁移和双轨对账避免错账。

## 1. 决策与非目标



### 1.1 本版本的不可变决策

1. SQLite 是唯一的**运行时权威数据源**。CLI、Tauri、HTML、预算、日历、导出与对账均只能通过 SQL repository 查询。
2. 执行环境日志（Claude/Codex/DSH）只是不可信输入；它们必须先被清洗、校验和规范化，才可进入权威库。
3. `facts/*.jsonl` 降级为可选导出/迁移输入，不再是在线重建 SQLite 的权威源。`month.json`、`month-archive.json`、Claude ledger 和 Codex fold 仅在迁移期用于导入与对账。
4. 任何写入都必须具有稳定幂等键、事务边界、来源指纹与可观测结果；不得允许 UI 或 CLI 直接写表。
5. 切换到 SQL 读路径前必须通过双轨对账。未对账或对账失败的月份/执行环境必须显示为 `partial` 或 `unavailable`，不得显示为零或完整。

### 1.2 非目标

- 不引入网络服务、云同步、ORM、DuckDB、watcher 或自动上传。
- 不把原始对话正文写入数据库。
- 不在 v0.9.1 实现 v0.10 的 TraceGraph、Issue、Action 或自动执行。
- 不承诺把无法从原始执行环境数据复原的旧聚合字段伪造为事实。

## 2. 成功标准

v0.9.1 可以发布，当且仅当：

1. 新安装只创建 SQLite 数据库；所有产品读取不依赖旧 state JSON、JSONL 或执行环境日志。
2. 升级安装可重复、可中断、可恢复地迁移；重复运行不增加 token、成本或账单记录。
3. 在可比较窗口，SQL 与旧链路按执行环境/日/月的 token 精确一致；金额按币种精确到分（或规格中明确的最小货币单位）。
4. SQL 损坏、迁移中断、源文件截断、并发同步、重复事件和保留清理均不会静默产生漏计、双计或假零。
5. CLI、Tauri、HTML、预算和导出使用同一 repository 与同一版本化 DTO。
6. 旧读路径删除或编译期禁止；只保留受控的迁移 importer 与显式 legacy export。

### 2.1 用户可验证的结果

SQL-first 不是技术替换本身，而是让用户能在一次查询内完成判断。发布时至少必须支持下列用户问题，且每项都能下钻到可解释的事实：

| 用户问题 | 用户据此做的决策 | 最低验收结果 |
|---|---|---|
| “我今天什么时候最集中地使用 AI？” | 调整工作节奏、定位异常高峰 | 模型/执行环境小时曲线可切换，峰值可下钻到会话 |
| “哪一个模型和执行环境花得最多？” | 预算控制、模型选择 | 按模型、执行环境、提供方、币种、计费口径拆分，不跨币种伪合计 |
| “这周哪些问题最反复？” | 优先修复高影响低效环节 | 重复错误、重复调用、重复拒绝按影响范围/频率/成本排序 |
| “哪些 Skill 值得保留或优化？” | 推荐、修复、下线 Skill | 看到调用量、成功率、耗时、失败原因、重试率与趋势 |
| “这个结论可信吗？” | 判断是否可据此行动 | 明示覆盖范围、最近同步时间、缺失来源和 unresolved 项 |

任何无法由现有数据可靠回答的问题必须显示为“尚无足够证据”，不得根据 token 或调用次数臆测任务成功率。

## 3. 目标数据模型

数据库文件位于 `<data_home>/agent-vitals.sqlite3`。启用 WAL、`foreign_keys=ON`、`busy_timeout`；由启动/同步入口执行 schema migration。所有表使用 UTC `created_at_ms`/`updated_at_ms`（整数毫秒），业务日/月在查询时按北京时区或执行环境规定的时间口径计算。

### 3.1 schema 元数据与运行批次

```sql
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sync_runs (
  run_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  trigger TEXT NOT NULL,                 -- cli | tray | migration | repair
  status TEXT NOT NULL,                  -- running | succeeded | failed | cancelled
  schema_version INTEGER NOT NULL,
  error_code TEXT,
  error_detail TEXT
);
```

`sync_runs` 是观测与恢复记录，不是业务事实。任何 `running` 批次在下次启动时应被标为 interrupted，并可由幂等重跑恢复。

### 3.2 来源、会话与 checkpoint

```sql
CREATE TABLE source_files (
  source_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  path_hash TEXT NOT NULL,                -- 不暴露本地路径
  native_session_id TEXT,
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  content_fingerprint TEXT,
  parser_version INTEGER NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  last_successful_run_id TEXT REFERENCES sync_runs(run_id),
  last_error_code TEXT,
  UNIQUE(harness, path_hash)
);

CREATE TABLE sessions (
  session_key TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  machine_namespace TEXT NOT NULL,
  source_profile TEXT,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  last_observed_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE(harness, machine_namespace, native_session_id)
);
```

`source_files` 取代 JSON checkpoint；`sessions` 是最小 CanonicalSession 索引，不保存对话正文。`path_hash` 与任何可识别路径不对外输出。

### 3.3 权威用量事实

```sql
CREATE TABLE usage_facts (
  fact_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  machine_namespace TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  session_key TEXT REFERENCES sessions(session_key),
  source_event_id TEXT NOT NULL,
  observation_kind TEXT NOT NULL,
  source_profile TEXT,
  provider_id TEXT,
  model_id TEXT,
  event_ts_ms INTEGER,
  event_peak INTEGER NOT NULL DEFAULT 0,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  CHECK (uncached_input_tokens >= 0),
  CHECK (cache_read_tokens >= 0),
  CHECK (cache_write_tokens >= 0),
  CHECK (output_tokens >= 0),
  UNIQUE(harness, machine_namespace, native_session_id, source_event_id, observation_kind)
);

CREATE INDEX usage_facts_harness_time
  ON usage_facts(harness, event_ts_ms) WHERE deleted_at_ms IS NULL;
CREATE INDEX usage_facts_session_time
  ON usage_facts(session_key, event_ts_ms) WHERE deleted_at_ms IS NULL;
CREATE INDEX usage_facts_provider_model_time
  ON usage_facts(provider_id, model_id, event_ts_ms) WHERE deleted_at_ms IS NULL;
CREATE INDEX usage_facts_event_time
  ON usage_facts(event_ts_ms) WHERE deleted_at_ms IS NULL;  -- v33：跨 harness 事件时间范围查询
```

`fact_id` 继续由既有 UsageFact 身份规则产生。`UNIQUE(...)` 是第二道防线：同一事实即使出现 hash 规则回归，也不能悄悄重复入账。事实修正采用 tombstone + 新事实，或受控 `UPDATE` 写入 `fact_revisions`；初版选择前者以保持审计可追溯。

### 3.4 模型、供应商、价格、账单与预算

模型和供应商必须写入 SQL，不能只作为 `usage_facts` 中的自由文本。用户需要按供应商、模型及其价格版本解释历史成本；若只保存事件中的字符串和当前价卡，模型改名、供应商路由变化或调价后，历史账将无法重放。

```sql
CREATE TABLE providers (
  provider_id TEXT PRIMARY KEY,           -- 稳定 ID，例如 openai / anthropic
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,                   -- active | retired | unknown
  created_at_ms INTEGER NOT NULL,
  retired_at_ms INTEGER
);

CREATE TABLE models (
  model_id TEXT PRIMARY KEY,              -- 内部 canonical ID，不以展示名充当主键
  provider_id TEXT NOT NULL REFERENCES providers(provider_id),
  canonical_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  model_family TEXT,
  status TEXT NOT NULL,                   -- active | retired | unknown
  created_at_ms INTEGER NOT NULL,
  retired_at_ms INTEGER,
  UNIQUE(provider_id, canonical_name)
);

CREATE TABLE model_aliases (
  alias_id TEXT PRIMARY KEY,
  harness TEXT,                              -- NULL = 跨执行环境别名
  raw_model_name TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES models(model_id),
  valid_from_ms INTEGER,
  valid_to_ms INTEGER,
  UNIQUE(harness, raw_model_name, valid_from_ms)
);

CREATE TABLE pricing_versions (
  pricing_version TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,              -- official | user_configured | imported
  source_reference TEXT,
  captured_at_ms INTEGER NOT NULL,
  effective_from_ms INTEGER NOT NULL,
  effective_to_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE model_prices (
  price_id TEXT PRIMARY KEY,
  pricing_version TEXT NOT NULL REFERENCES pricing_versions(pricing_version),
  model_id TEXT NOT NULL REFERENCES models(model_id),
  currency TEXT NOT NULL,
  unit_tokens INTEGER NOT NULL,           -- 通常为 1,000,000
  uncached_input_minor INTEGER,
  cache_read_minor INTEGER,
  cache_write_minor INTEGER,
  output_minor INTEGER,
  effective_from_ms INTEGER NOT NULL,
  effective_to_ms INTEGER,
  UNIQUE(pricing_version, model_id, currency)
);
```

写入 `usage_facts` 时必须先完成原始模型名 → `model_aliases` → canonical `models` 的解析；无法解析时使用受控的 `unknown` 模型/供应商记录，并同步生成 `data_quality_issue`。不可悄悄创建任意拼写的新模型行。

价格按“最小货币单位 / `unit_tokens`”保存，禁止浮点。查询历史成本时必须按事实时间选择当时生效的价格版本；没有匹配价卡则输出 `unresolved`。用户自定义套餐、代理商价格和官方公开价格必须以不同 `source_kind` 并列展示，不能互相覆盖。

```sql
CREATE TABLE harness_bills (
  bill_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  billing_period TEXT NOT NULL,           -- YYYY-MM
  billing_basis TEXT NOT NULL,            -- fixed_subscription | harness_billed | metered_actual
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  source_id TEXT REFERENCES source_files(source_id),
  evidence_ref TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE(harness, provider_id, billing_period, billing_basis, evidence_ref)
);

CREATE TABLE budget_config (
  config_id INTEGER PRIMARY KEY CHECK (config_id = 1),
  monthly_cny_minor INTEGER,
  daily_cny_minor INTEGER,
  warning_ratio_bp INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE budget_snoozes (
  snooze_id INTEGER PRIMARY KEY CHECK (snooze_id = 1),
  until_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

金额一律以最小货币单位存储，禁止在数据库中存储浮点金额。不能可靠归属或缺少价卡的用量必须在查询结果中标为 `unresolved`，而不是补零或估价成真实账单。

### 3.5 质量、迁移与审计

```sql
CREATE TABLE data_quality_issues (
  issue_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,               -- source | session | fact | month
  scope_key TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  detail_json TEXT NOT NULL,
  UNIQUE(scope_type, scope_key, code)
);

CREATE TABLE migrations (
  migration_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  status TEXT NOT NULL,
  source_version TEXT NOT NULL,
  target_version TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  error_detail TEXT
);
```

`migrations` 用于版本迁移/旧数据导入，不与 SQL DDL version 混用。迁移过程的每个阶段都必须能从 checkpoint 继续。

### 3.6 最小过程事件：支持重复问题与 Skill 健康

仅有 `usage_facts` 能回答“消耗了多少”，不能回答“为什么反复失败”或“哪个 Skill 表现差”。v0.9.1 不建立完整的 v0.10 任务图，但必须增加最小、脱敏的过程事件，记录运行结果而非对话正文：

```sql
CREATE TABLE workflow_events (
  event_id TEXT PRIMARY KEY,
  session_key TEXT REFERENCES sessions(session_key),
  event_ts_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,               -- task_started | task_finished | skill_invoked |
                                              -- skill_finished | tool_invoked | tool_finished |
                                              -- model_switched | approval_denied
  capability_kind TEXT,                   -- skill | tool | model
  capability_id TEXT,                     -- Skill/tool/model 的稳定标识
  capability_version TEXT,
  outcome TEXT NOT NULL,                  -- succeeded | failed | cancelled | unknown
  duration_ms INTEGER,
  error_fingerprint TEXT,                 -- 脱敏、稳定的错误分类/指纹
  invocation_fingerprint TEXT,            -- 脱敏调用指纹，用于识别重复重试
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX workflow_events_session_time
  ON workflow_events(session_key, event_ts_ms);
CREATE INDEX workflow_events_capability_time
  ON workflow_events(capability_kind, capability_id, event_ts_ms);
CREATE INDEX workflow_events_error_time
  ON workflow_events(error_fingerprint, event_ts_ms)
  WHERE error_fingerprint IS NOT NULL;
```

边界：不保存 prompt、工具参数、原始报错全文或对话正文。`error_fingerprint` 与 `invocation_fingerprint` 必须由脱敏规则生成；需要人工排查时，用户回到本机原始来源查看细节。

### 3.7 执行环境实时快照（schema v2）

有些产品状态不是用量事实，也不能让桌面端绕过 authority 直接扫描执行环境日志。
例如 Codex 的“当前套餐、已用比例、重置时间”是单一的实时快照，而不是可按日
相加的 token。schema v2 为这类状态提供独立表：

```sql
CREATE TABLE harness_runtime_snapshots (
  harness TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL,            -- 当前：codex_quota
  payload_json TEXT NOT NULL,             -- 已清洗、脱敏的产品 DTO
  observed_at_ms INTEGER NOT NULL,
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(harness, snapshot_kind)
);
```

快照与触发它的 `source_files`、`sync_runs` 在同一事务写入；较旧的观察时间
不得覆盖较新的值。既有 schema v1 库升级后，Codex rollout 即使指纹未变也会被
重放一次以补齐该派生快照；该回填完成标记只服务同步，不参与任何用户查询。
产品读面只从本表读 `codex_quota`，没有可用套餐证据时返回 unavailable，绝不
回退扫描 `~/.codex`。

### 3.8 v16 内容富化与源锚点（2026-09-19，权威定义 docs/v1.0.0/SCHEMA_V16_V17_ENRICHMENT_PROBE_SPEC.md §2）

2026-09-19「数据留存与出口政策」（AGENTS.md）落地：摄取期不再为隐私销毁分析
信号，富化进新列/新表、词表用 CHECK 闭集、账务/行为事实表纯度不动。旧行新列
**NULL = 未富化**（源日志重摄取前不得当 0/空串呈现）；出口投影（MCP /
`data-export-redacted`）不因本节放宽——excerpt 类字段与锚点字段不出这两个面。

```sql
ALTER TABLE workflow_events ADD COLUMN error_code TEXT;        -- 'http:429' | 'jsonrpc:-32601' | 'tool:…' | 'harness:<raw>'
ALTER TABLE workflow_events ADD COLUMN error_class TEXT
  CHECK (error_class IS NULL OR error_class IN (
    'transport','rate_limit','auth','schema_violation','method_not_found',
    'timeout','parse','tool_policy','context_overflow','unknown'));
ALTER TABLE workflow_events ADD COLUMN error_excerpt TEXT;     -- 错误首行截断，仅本地呈现
ALTER TABLE workflow_events ADD COLUMN args_excerpt TEXT;      -- 参数摘要截断，仅本地呈现
ALTER TABLE workflow_events ADD COLUMN request_bytes INTEGER;
ALTER TABLE workflow_events ADD COLUMN result_bytes INTEGER;
ALTER TABLE workflow_events ADD COLUMN native_event_id TEXT;   -- 执行环境原生 id，锚点重定位键
ALTER TABLE workflow_events ADD COLUMN source_line INTEGER;    -- 加速 hint，自校验
ALTER TABLE workflow_events ADD COLUMN source_byte_offset INTEGER;
CREATE INDEX workflow_events_error_class_time
  ON workflow_events(error_class, event_ts_ms) WHERE error_class IS NOT NULL;

ALTER TABLE usage_facts ADD COLUMN reasoning_effort TEXT;      -- 执行环境报了才填；NULL = 未报

ALTER TABLE sessions ADD COLUMN probe_run_ref TEXT;            -- 探针会话标记，成本视图过滤键
ALTER TABLE sessions ADD COLUMN task_profile TEXT;
ALTER TABLE sessions ADD COLUMN task_profile_basis TEXT
  CHECK (task_profile_basis IS NULL OR task_profile_basis IN ('rule_toolmix','user_label','local_model'));

CREATE TABLE session_excerpts (
  session_key TEXT NOT NULL REFERENCES sessions(session_key),
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user_first','user_turn','assistant_final','subagent_task')),
  excerpt TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('verbatim','truncated','scrubbed')),
  native_event_id TEXT,
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  PRIMARY KEY(session_key, ordinal, role)
);
CREATE INDEX session_excerpts_session ON session_excerpts(session_key, ordinal);
```

实现注意（`authority.rs`）：v16 是 v9 以来首个 ALTER-加列式增量，为保住
`stale_v9_stamp_with_later_tables_upgrades_idempotently` 钉住的幂等升级不变量
（版本戳陈旧、表已新形状的库上重跑不炸），`apply_schema_v16` 逐列以
`pragma_table_info` 守卫、建表/索引用 `IF NOT EXISTS`——上文的 DDL 是其语义
镜像。词表与提取算法的单一真相源在 `agent-vitals-domain::enrichment`
（Python 镜像 `agent_vitals/agent/enrichment.py` + 共享向量
`fixtures/enrichment/vectors.json` 双侧断言）。

### 3.9 v17 探针面五表（2026-09-19，权威定义 docs/v1.0.0/SCHEMA_V16_V17_ENRICHMENT_PROBE_SPEC.md §4）

「测试」tab 的数据层：`probe_routes`（路线档案：凭据只存**引用**——`ccswitch:<row>` /
`env:VAR`，`consent_granted_at_ms` 为 NULL 时不得发起请求）、`probe_suites`（题库只存
manifest 引用 + sha256，题面/判据/canary 串留文件系统按机密待遇）、`probe_runs`（job 行，
`lease_owner` 沿用 billing recalculation 的文件锁先例；`budget_stopped` 由预算熔断触发）、
`probe_results`（task × repeat × route；四桶与 `usage_facts` 同名同义，探针会话两路记账
必须对得上；`resolved_model` 取不到为 NULL 不猜；`evidence_json` 是 B 类判定证据的富存储）、
`probe_verdicts`（五级判定闭集 + 统计量/证据链/混杂记录 + `rule_version` 可归因到冻结
统计规则）。全部 `CREATE TABLE IF NOT EXISTS`——无加列、天然幂等，与 v16 的 pragma
守卫式 `apply_schema_v16` 相比是更简单的增量形态。runner 与判定计算属「测试」tab
迭代（[WORKBENCH_TEST_TAB_SPEC](v1.0.0/WORKBENCH_TEST_TAB_SPEC.md)），本节只落数据层。

```sql
CREATE TABLE IF NOT EXISTS probe_routes (
  route_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  harness_kind TEXT NOT NULL CHECK (harness_kind IN ('claude-code','codex')),
  endpoint_base_url TEXT,
  credential_ref TEXT,                       -- 'ccswitch:<row>' | 'env:VAR'：引用，永不存凭据本体
  model_requested TEXT NOT NULL,
  consent_granted_at_ms INTEGER,             -- NULL = 未授权，runner 拒绝发起
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(label, harness_kind)
);
CREATE TABLE IF NOT EXISTS probe_suites (
  suite_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('l0_identity','l0_capability','l1_canary')),
  manifest_ref TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  rule_version TEXT NOT NULL,                -- 冻结统计判据版本（判定可归因）
  created_at_ms INTEGER NOT NULL,
  UNIQUE(suite_id, version)
);
CREATE TABLE IF NOT EXISTS probe_runs (
  run_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('single','paired')),
  route_a_id TEXT NOT NULL REFERENCES probe_routes(route_id),
  route_b_id TEXT REFERENCES probe_routes(route_id),   -- single 模式 NULL
  suite_id TEXT NOT NULL REFERENCES probe_suites(suite_id),
  n_repeats INTEGER NOT NULL CHECK (n_repeats >= 1),
  interleave_seed INTEGER,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','budget_stopped')),
  currency TEXT,
  cost_budget_minor INTEGER,
  cost_estimated_minor INTEGER,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  lease_owner TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_results (
  result_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES probe_runs(run_id),
  route_id TEXT NOT NULL REFERENCES probe_routes(route_id),
  task_id TEXT NOT NULL,
  repeat_idx INTEGER NOT NULL CHECK (repeat_idx >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass','fail','error','timeout')),
  uncached_input_tokens INTEGER,             -- 四桶与 usage_facts 同名同义
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  turns INTEGER,
  wall_ms INTEGER,
  ttft_ms INTEGER,
  requested_model TEXT NOT NULL,
  resolved_model TEXT,                       -- 取不到 = NULL，不猜
  reasoning_effort_requested TEXT,
  reasoning_effort_reported TEXT,
  thinking_blocks INTEGER,
  context_accepted_tokens INTEGER,
  error_code TEXT,
  evidence_json TEXT NOT NULL,               -- B 类判定证据富存储（合成数据，放开存）
  session_key TEXT REFERENCES sessions(session_key),
  UNIQUE(run_id, route_id, task_id, repeat_idx)
);
CREATE INDEX IF NOT EXISTS probe_results_run
  ON probe_results(run_id, route_id);
CREATE TABLE IF NOT EXISTS probe_verdicts (
  verdict_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES probe_runs(run_id),
  verdict TEXT NOT NULL CHECK (verdict IN (
    'confirmed_mismatch','suspected_degradation','no_signal','underpowered','inconclusive_confounded')),
  statistic_json TEXT NOT NULL,
  evidence_chain_json TEXT NOT NULL,
  confounders_json TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  decided_at_ms INTEGER NOT NULL,
  UNIQUE(run_id)
);
```

## 4. SQL 查询模型

不把金额/聚合复制成第二份可变真相。以 `usage_facts`、`harness_bills`、价格快照和预算配置为基础建立 repository 查询；复杂查询可使用 SQL view，但 view 不持久化可写状态。

最少提供：

- `daily_summary(date, harness_scope, billing_scope)`；
- `monthly_summary(month, harness_scope, billing_scope)`；
- `coverage_status(month, harness_scope)`；
- `budget_status(month, now)`；
- `facts_page(filters, cursor)`；
- `sessions_page(filters, cursor)`；
- `harness_bills_page(filters, cursor)`；
- `sync_status()` 与 `data_quality_issues(filters)`。

每个摘要必须同时返回金额、币种、basis、tokens、coverage、freshness、excluded harnesses、`last_observed_at` 与 `data_version`。金额不能脱离来源/口径单独返回。

**行轴/聚合轴分离纪律（审查收口，2026-09-06）**：`usage_facts` 里
`observation_kind = 'legacy_aggregate'` 的行（§6.2.3 的 ledger 深历史聚合）
与实时行级事实**不得在同一条聚合查询里相加**——前者是「日轴账单真值」、
后者是「会话轴证据」，同日并存时相加必然双计。所有日/月/小时聚合查询必须
`WHERE observation_kind != 'legacy_aggregate'`（小时分布天然排除：该类行
的 `event_ts_ms` 是北京日 12:00 代表点）；ledger 聚合行只经专用的日/月
读取路径消费。Phase 3 的 repository 验收矩阵必须含「聚合数 ≠ 行级数 +
聚合数 = ledger 数」的 fixture。

### 4.1 面向用户的查询目录

| 查询能力 | 用户看到什么 | 典型筛选 | 必须支持的下钻 |
|---|---|---|---|
| 今日小时分布 | 按小时的 token、成本、活跃会话曲线 | 日期、模型、执行环境、提供方 | 小时 → 会话 → 相关事实/事件 |
| 模型/执行环境对比 | 用量、成本、成功率、重试率、平均耗时 | 日期范围、模型、执行环境 | 条目 → 会话与失败事件 |
| 异常峰值解释 | 高于基线的小时及原因 | 日期、阈值 | 峰值 → 模型/Skill/工具/会话 |
| 重复问题榜 | 重复错误、拒绝、无效调用 | 日期范围、执行环境、严重度 | 问题 → 受影响会话和最近发生记录 |
| Skill 健康度 | 调用量、成功率、耗时、成本、重复率 | Skill、版本、日期范围 | Skill → 失败指纹/调用会话 |
| 会话复盘 | 时间线、模型切换、调用结果、花费 | 会话 | 每个事件 → 关联用量/错误类别 |
| 数据可信度 | 覆盖、同步新鲜度、未定价/缺失项 | 月份、执行环境 | 缺口 → 来源文件/质量问题 |

### 4.2 用户查询验收用例

以下用例既是产品验收，也是 repository 的端到端测试 fixture。每条均应同时断言数值、下钻链路和数据质量状态。

| 编号 | 场景与输入 | 用户查询 | 预期结果 |
|---|---|---|---|
| Q01 | 同一天 Claude 在 09:00 有 120 token、Codex 在 10:00 有 300 token | “今天各模型的小时曲线” | 两个小时点分别归属正确模型；总览可切模型且总量一致 |
| Q02 | 同一模型在不同执行环境各有用量 | “今天各执行环境的小时曲线” | 执行环境曲线分开显示；总曲线等于各执行环境之和，不重复计数 |
| Q03 | 北京月初 00:30 的 UTC 前一天事件 | “本月用量” | 归属正确北京日/月，不落入上月或次月 |
| Q04 | 一个峰值小时由三条不同会话事实构成 | 点击小时峰值 | 下钻列出三会话；会话 token 合计严格等于峰值 |
| Q05 | 某模型有用量但缺价卡 | “本月成本排行” | 用量可见，成本显示 unresolved，不以 0 或估算冒充实际 |
| Q06 | 同一错误指纹在 7 天内出现 12 次、影响 5 会话 | “本周重复问题” | 聚为一个问题卡，显示次数/会话数/最近时间；可下钻记录 |
| Q07 | 同一调用指纹连续失败 3 次后成功 | “重复重试” | 标记为一组重试链，次数为 3，不将成功结果误判为失败 |
| Q08 | Skill A 调用 20 次：16 成功、4 失败；Skill B 只调用 1 次 | “哪些 Skill 有问题” | A 显示 80% 成功率和失败分类；B 标为样本不足，不做质量结论 |
| Q09 | Skill A 新版本失败率从 5% 升至 35% | “Skill 健康趋势” | 按版本识别回归并提示风险；不混淆两个版本 |
| Q10 | 一个会话有模型切换、Skill 失败与成本峰值 | “为什么任务拖延” | 时间线按时间排序，并将失败/峰值关联到会话，不读取对话正文 |
| Q11 | 某执行环境 24 小时未同步 | “今日总览” | 结果标为 partial/stale，明确缺失执行环境；不可显示“完整总额” |
| Q12 | 导入同一来源两次并在中途模拟中断 | 重跑任意月/日查询 | token、成本、调用次数与首次成功导入完全一致，无半提交 |
| Q13 | 同一模型在 9 月 1 日调价，且历史事件跨越调价日 | “本月成本排行” | 调价日前后分别使用正确价格版本；历史成本不会被当前价卡覆盖 |
| Q14 | 同一个原始模型名在不同执行环境映射到不同 canonical 模型 | “按模型/供应商对比” | 归属准确；无法映射的项目显式显示 unknown/unresolved，不被并入相似名称 |

Q01–Q05 是首批可见价值；Q06–Q10 依赖 `workflow_events`；Q11–Q14 是所有查询成立的可信度底线。

## 5. CRUD 契约

### 5.1 Create

1. 发现执行环境来源文件，建立或更新 `source_files`。
2. 解析执行环境 wire，生成 UsageFact/HarnessBillRecord candidate。
3. 校验 schema、时间、token 非负、执行环境词表与身份；不合格项写 `data_quality_issues`，不得入 `usage_facts`。
4. 在一个 `BEGIN IMMEDIATE` 事务内：创建 `sync_runs`、upsert sessions/source metadata、`INSERT ... ON CONFLICT DO NOTHING` 写 facts/bills、记录结果、更新 checkpoint。
5. 成功提交后才标记 `sync_runs=succeeded`。失败回滚业务写入、标记 run failed，并保留错误信息。

### 5.2 Read

所有公开读取经过 `SqlSummaryRepository`。禁止以下运行时读取：

- `month.json` / `month-archive.json` / `today.json`；
- Claude ledger；
- Codex rollout 全量 fold；
- `facts/*.jsonl` 重放。

执行环境文件只可被 sync/import 命令读取。UI、CLI 和预算不得绕过 repository 执行 SQL 或读取文件。

### 5.3 Update

- 同一来源文件 fingerprint 变化时重新解析；已有事实按 `fact_id` 幂等，不会重复。
- 源端历史更正造成事实变化时：旧事实写 `deleted_at_ms`，插入新身份事实，同时记录质量/审计记录。
- 账单和预算配置为显式管理 API；更新必须验证币种、账期和金额范围。
- 价格变化新增 `pricing_snapshots`；历史查询以记录的 pricing version 重放，不能用当前价卡覆盖历史解释。

### 5.4 Delete 与保留

- 用户删除/撤销的数据使用 soft delete；查询默认过滤 `deleted_at_ms IS NULL`。
- 物理清理只在 retention job 中进行，须先删除依赖的导出/审计副本并记录 maintenance run。
- 用量事实默认保留 13 个自然月；无日期或质量异常事实不能静默删除，必须先标记并由显式修复流程处理。

## 6. 迁移与切换

### 6.1 升级状态机

```text
detect legacy
  → create database + DDL
  → import legacy facts/state
  → replay harness sources
  → reconcile SQL vs legacy
  → enable SQL reads
  → freeze legacy writes
  → remove legacy reads (v0.9.2 or same release gate)
```

迁移必须记录在 `migrations` 表，任一步失败均可重跑。不会删除旧文件，直到 SQL 读路径已启用且用户完成备份确认窗口。

### 6.2 导入优先级

1. 已有 `facts/*.jsonl`：按既有 `fact_id` 导入，作为最保真的已清洗事实。
2. 执行环境原始日志：重新解析并写入 SQL；用唯一键吸收与 JSONL 重叠的事实。
3. Claude ledger、DSH `month.json`/archive：只用于补充无法从现存 raw source 重放的历史聚合；写为有明确 `source_kind=legacy_aggregate` 的记录，并标记 coverage 降级。
4. `today.json`、`alert.json`：不迁移为事实；由 SQL 聚合和预算配置重算。
5. 旧 JSON 永不覆盖更具体的 SQL fact；冲突必须产出 data-quality issue。

### 6.3 对账协议

按 `harness × month × token bucket` 比较：所有可比较 token 必须严格相等。金额按 `currency × basis × provider` 比较最小货币单位，禁止跨币种汇总。

允许例外只包括：旧状态缺少原始证据、旧聚合的已知历史 bug、或无法反演的订阅配置。每个例外必须有 issue code、范围、原因与用户可见的 partial 标记。

切换条件：连续一次全量导入和至少一次增量同步均通过对账；否则保持 legacy-only 读取并将迁移标为 failed，不允许半切换。

## 7. 实施阶段

### Phase 0：冻结规格与基线

- 冻结本文件、DTO 形状、token/货币单位和时区规则。
- 导出现有数据库/JSON/JSONL 的只读备份，并记录基线对账报告。
- 禁止新增任何直接读取旧 JSON 的产品功能。

### Phase 1：SQLite 权威 schema 与迁移框架

- 建立 DDL migration runner、事务帮助器、`sync_runs`/`migrations`/质量问题表。
- 将现有 SQLite index 迁移为新库或一次性导入，不再使用“删除 SQLite → 从 JSONL 重建”作为正常恢复方式。
- 为损坏数据库提供恢复：从用户备份 + 执行环境原始日志重新导入；若不能恢复，明确报告 coverage 缺口。

### Phase 2：清洗写入与同步

- 将三执行环境 emitter 改为向 SQL writer 写 candidate facts。
- 把 JSON checkpoint 迁到 `source_files`；将 lease 包住完整事务。
- 加入 HarnessBillRecord 导入与价格快照写入。
- 提供 `data sync`、`data status`、`data repair`、`data migrate` 命令。

### Phase 3：SQL repository 与全部读路径切换

- 实现 `SqlSummaryRepository`、事实/会话/账单分页查询、coverage 与 budget 查询。
- CLI、Tauri、HTML、overview、工作台日历和托盘预算全部切换到 repository。
- 删除运行时对 `JsonSummaryRepository`、`budget::read_month`、ledger 和 Codex fold 的读取依赖。

### Phase 4：双轨验收与旧路径退役

- 在迁移期以 SQL vs legacy 生成可机器读取的对账报告。
- 对账通过后设置 `sql_authority_enabled`，停止写旧 state JSON。
- 保留 legacy importer/export 一个版本；下一个兼容窗口后删除旧 state 读写代码。

## 8. 测试矩阵与发布门槛

必须新增或改造以下测试：

1. schema migration：空安装、v0.9 升级、重复运行、半途中断、低版本恢复、高版本拒绝。
2. ingest：同一事件重放、同一文件修改、文件截断/替换、坏行、跨执行环境同名会话、并发同步。
3. transaction：在 facts/bills/checkpoint/run 状态每个提交点故障注入，验证无半提交。
4. CRUD：事实、账单、session、budget config、soft delete、retention 与分页/cursor。
5. query：daily/monthly/coverage/budget 的时区边界、峰谷、跨月、跨币种、无数据与 unresolved。
6. reconciliation：全量与增量 SQL-vs-legacy；任何差异必须给出可行动原因。
7. client parity：CLI、Tauri 命令、HTML payload 都由同一 DTO 返回。
8. performance：常见月查询不枚举执行环境原始日志；索引命中计划与数据库大小增长受控。
9. 用户查询验收：Q01–Q14 必须作为端到端 fixture 运行；其中 Q01–Q05、Q11–Q14 为 v0.9.1 release blocker，Q06–Q10 在 `workflow_events` 接入后成为 blocker。

发布前的人工验收：真实机器迁移、断电/kill 后恢复、删除旧 JSON 后继续正常查询、删除 SQLite 后按恢复策略明确告警而不是回落到另一条隐式账本。

## 9. 兼容、隐私与运维

- 自动迁移前创建只读备份目录，并保留至少一个版本窗口。
- 数据库权限限定为当前用户；路径、会话 ID、machine namespace 在 export 中默认脱敏。
- `data export private` 是显式授权的私有导出；`data export redacted` 重写身份字段，二者均从 SQL 查询生成。
- `data doctor` 必须报告 schema version、最近同步、失败来源、对账状态、coverage、数据库完整性和 retention 状态。
- 禁止把 SQLite 文件复制到云端或作为同步协议；这是本地数据层，不是服务端数据库。

## 10. 删除清单

满足发布门槛后，删除或隔离以下运行时责任：

- `JsonSummaryRepository`；
- `month.json` / `month-archive.json` / `today.json` 作为业务读源；
- `alert.json` 作为预算计算来源；
- Claude ledger 和 Codex fold 在产品查询路径中的直接读取；
- JSON checkpoint；
- "SQLite 可由 JSONL 重建" 的权威语义。

保留的 legacy 代码只能位于 importer、导出兼容或测试 fixture 中，并且不得被 production query 调用。

## 11. 风险与决策点

| 风险 | 控制措施 |
|---|---|
| 旧 state 与 raw source 金额不一致 | 先对账，差异以质量问题呈现，不自动选择一方覆盖另一方 |
| 迁移中断 | 每批事务化、`migrations` checkpoint、可幂等重跑 |
| SQL 成为单点故障 | 用户备份 + raw source replay；失败明确报 coverage 缺口，不静默回退旧账本 |
| 时区或价格版本改变历史账目 | 存 UTC 毫秒、固定 query 口径、价格快照版本化 |
| 表设计过度预建 | 只建立本版本查询/CRUD 必需表；v0.10 图谱实体不提前写入 |

## 12. 结论

v0.9.1 的交付不是“新增一个 SQLite 表”，而是完成一次受控的权威迁移：**清洗后事实入 SQL、所有产品查询读 SQL、迁移过程可对账且可恢复、旧数据路径不再造成第二本账。**

---

## 13. Phase 0 执行记录（2026-09-06）

- **基线对账**：`data budget-reconcile --month 2026-08` 双轨逐厘相等
  （¥1752.4498154 ≡ ¥1752.4498154，含 peak 拆分）；facts 索引现存
  48,801 条（claude 31,552 / codex 14,789 / dsh 2,460）。
- **被本 spec 取代的设计**：R4 §5.2a 的「day-summary 轴分离」草案
  （未实现即废止）——ledger/codex-fold 日聚合按 §6.2.3 以
  `source_kind=legacy_aggregate` 导入并标记 coverage 降级，不再是
  独立的投影表设计。
- **继承与废止**：既有 `agent-vitals-data::store`（index.sqlite3,
  schema v2）保留至 Phase 1 迁移框架落地后一次性导入；「删库 →
  从 JSONL 重建」自新库启用起**不再是正常恢复方式**（§7 Phase 1），
  恢复 = 用户备份 + 执行环境原始日志重放 + coverage 缺口如实报告。
- **claude 覆盖缺口定论**（迁移的输入边界）：ledger 深历史来自已轮转
  文件，不可从现文件重放——按 §6.2.3 作为 legacy_aggregate 导入并标
  coverage 降级，不伪造为行级事实。
- **实施顺序**：Phase 1（schema + migration runner + 事务帮助器）→
  Phase 2（SQL writer + source_files 迁移 + data sync/status/repair/
  migrate）→ Phase 3（SqlSummaryRepository + 全读路径切换）→ Phase 4
  （双轨验收 + 旧路径退役）。每 Phase 完成走既定循环
  （全量测试 → subAgent 审查 → 修复）。

---

## 14. Phase 3 实施期修订记录（2026-09-07）

实施与审查过程中对正文的三处澄清/收窄，均不改变表结构与权威迁移目标：

1. **§6.2(5)「旧 JSON 永不覆盖更具体的 SQL fact」的适用边界**：该规则
   保护的是**实时行级事实不被旧 JSON 覆盖**（来源不同、具体度不同）。
   `legacy_aggregate` 行与 ledger JSON 是**同一来源的两个快照**——ledger
   是 `claude_sync` 全量重建的滚动投影，同 (day, model, peak) 键的桶值
   合法地会变（FOLD_SCHEMA_VERSION 升级的全量重折即实例），且这些月份
   原始 JSONL 已轮转、ledger 是唯一 store of record。因此同 kind 重导
   入遇值变更 → **更新既有行为新值并刷 `ingested_run_id`（last-writer
   溯源）+ 计入 report.updated**，不是违规；跨 kind 冲突（身份契约下
   不可达，防御分支）仍写 data-quality issue 且不覆盖。
2. **coverage 降级标记逐月化**：§6.2.3 的「标记 coverage 降级」落地为
   **每个实际生成 legacy 行的月份各写一条**（scope_key=该月），不再把
   跨月批粗化为单条 "all"——消费方（`SqlSummaryRepository` 把被标记
   月份的 claude 侧 freshness 降为 `Partial`）必须能按月回答「这个月
   是否被聚合兜底」。
3. **§9 导出双路径的数据源确认**：原文「二者均从 SQL 查询生成」与
   Phase 3.6 实施一致；随之的语义澄清：私有导出的「完整面」= 权威库的
   完整面（`identity_basis` 等 ingest 元数据不出现在导出中；软删除行按
   §5.4 默认过滤）。

---

## 15. §10 删除清单执行记录（2026-09-07，Phase 4.3）

用户 2026-09-07 决定不等观察期、提前执行 §10——分支
`v0.9.1-phase-4.3-retire-legacy`，分 6 stage：

| §10 条目 | 状态 | 落点 |
|---|---|---|
| `JsonSummaryRepository` | ✅ 删除 | Stage 2（b5ca48c）——struct + impl + 4 个 legacy 读 wrapper（claude/codex ledger·fold 读层）；`SummaryRepository` 只剩 `SqlSummaryRepository` |
| `month.json`/`month-archive.json`/`today.json` 作业务读源 | ✅ 退役 | `SqlSummaryRepository` 与 `budget show` 都只读 SQL；Stage 5b 删除业务 state 写入口，DSH tick 仅保留导航快照 |
| `alert.json` 作预算计算来源 | ✅ 退役 | `evaluate_alert_from_sql` 只读 authority；Stage 5b 删除 oneline 的 alert 写入 |
| ledger / codex fold 在产品查询路径的直接读取 | ✅ 退役 | Stage 2 删除 repository wrapper，Stage 5b-c 把 `data-unresolved` 改为 authority，5b-d 把 `sessions navigation` 的三执行环境今日 token 改为 authority；Codex quota 以 schema v2 `harness_runtime_snapshots/codex_quota` 在同步事务写入、桌面端只读 SQL |
| JSON checkpoint | ✅ 退役 | `sync_facts` 以 `source_files` 作为唯一差量索引；旧 checkpoint 仅首启迁入后改名留档，运行时不再读写 |
| "SQLite 可由 JSONL 重建" 的权威语义 | ✅ 退役 | Stage 5a（8498023）——删旧 `agent_vitals_data::store` / `index.sqlite3` / `FactsIndex` / `data-rebuild-index`。权威库**不自愈**，恢复 = `rm agent-vitals.sqlite3* && data-migrate` |
| legacy 代码只留 importer/export/fixture | ✅ | `legacy_import` 保留（`data-migrate --with-legacy-ledger` opt-in）；旧业务 state 的 merge/alert 写链、导航 token 与配额读路径均已迁出 |

**Stage 1**（ad4e33e）另删了 SQL-vs-legacy 对账机器（`reconcile_authority_
vs_legacy` / `data-reconcile-authority` / `data-budget-reconcile` /
`reconcile_budget_sources` / `compute_month_from_index` / `examples/
reconcile_real.rs`）——§10 未列（属迁移期脚手架），迁移收敛后不再需要。
`data authority enable` 门槛改查权威库健康（integrity + facts + last-run）。

**真机翻开关 + 观察期**仍是用户本机的事（spec §6.1 需备份）；代码侧 Stage
5b-d 已完成。
