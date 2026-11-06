# 权威库 V16/V17：内容富化 + 探针面 schema 规格

**状态：** Draft v1（2026-09-19）。
**目标版本：** v1.0.0-beta.3 起；V16 先行独立交付，V17 随「测试」tab P1。
**关联文档：** [数据留存与出口政策](../../AGENTS.md)（2026-09-19 节，本 spec 的政策依据）·
[SQL 权威库迁移 spec](../AGENT_VITALS_V0_9_1_SQL_AUTHORITY_MIGRATION_SPEC.md)（DDL 是其 §3 的镜像，
本 spec 是其 V16/V17 增补的权威定义）· [发现 tab 规格](WORKBENCH_FINDINGS_TAB_SPEC.md)（§3.3/§3.4/§9.5 的
联动修订见 §12）· [问题分类图谱](../AGENT_EXECUTION_PROBLEM_TAXONOMY.md)（实现前登记清单见 §11）·
CLAUDE.md「数据留存与出口政策」节。

---

## 0. 一句话结论

V16 把「摄取期不再销毁分析信号」落成库表（错误分类/摘录/尺寸/锚点/任务意图文本/effort 证据位），
V17 为「测试」tab 建探针面五表。两条总纪律贯穿全文：**旧数据未重摄取时新列 NULL = 未富化，
绝不当 0/空串**（不编数）；**用户文本只进库、只进本地 UI，MCP 与 redacted 导出两个出口一个字节都不放宽**（出口收口）。

## 1. 范围与不编数判据

1. V16 覆盖：`workflow_events` 富化 + 源锚点、`usage_facts.reasoning_effort`、`sessions` 三列
   （`probe_run_ref` / `task_profile` / `task_profile_basis`）、新表 `session_excerpts`。
2. V17 覆盖：`probe_routes` / `probe_suites` / `probe_runs` / `probe_results` / `probe_verdicts`。
3. 判据：所有新增列 nullable；所有新词表用 CHECK 闭集；执行环境没报的信号留 NULL；
   派生值（task_profile）必须带 basis 标注（inferred 纪律的库内形态）。

## 2. V16 DDL（语义镜像；实现为幂等 `apply_schema_v16`，见 §8-2）

```sql
-- workflow_events：错误分类/摘录/尺寸/锚点（旧行全 NULL = 未富化）
ALTER TABLE workflow_events ADD COLUMN error_code TEXT;         -- 'http:429' | 'jsonrpc:-32601' | 'tool:…' | 'harness:<raw>'
ALTER TABLE workflow_events ADD COLUMN error_class TEXT
  CHECK (error_class IS NULL OR error_class IN (
    'transport','rate_limit','auth','schema_violation','method_not_found',
    'timeout','parse','tool_policy','context_overflow','unknown'));
ALTER TABLE workflow_events ADD COLUMN error_excerpt TEXT;      -- 错误首行截断，仅本地呈现
ALTER TABLE workflow_events ADD COLUMN args_excerpt TEXT;       -- 参数摘要截断，仅本地呈现
ALTER TABLE workflow_events ADD COLUMN request_bytes INTEGER;
ALTER TABLE workflow_events ADD COLUMN result_bytes INTEGER;
ALTER TABLE workflow_events ADD COLUMN native_event_id TEXT;    -- 执行环境原生 id（Seq|Uuid|CallId|TurnId），锚点重定位键
ALTER TABLE workflow_events ADD COLUMN source_line INTEGER;     -- 加速 hint，自校验（漂移按 native id 重扫）
ALTER TABLE workflow_events ADD COLUMN source_byte_offset INTEGER;

CREATE INDEX workflow_events_error_class_time
  ON workflow_events(error_class, event_ts_ms) WHERE error_class IS NOT NULL;

-- usage_facts：effort 被静默调低（2026-04 复盘同款失效模式）的被动证据位
ALTER TABLE usage_facts ADD COLUMN reasoning_effort TEXT;       -- 执行环境报了才填；NULL = 未报

-- sessions：探针标记 + 任务画像位（画像填充在 P3，列先占位）
ALTER TABLE sessions ADD COLUMN probe_run_ref TEXT;             -- 探针工作区 cwd 识别，成本视图过滤键
ALTER TABLE sessions ADD COLUMN task_profile TEXT;
ALTER TABLE sessions ADD COLUMN task_profile_basis TEXT
  CHECK (task_profile_basis IS NULL OR task_profile_basis IN ('rule_toolmix','user_label','local_model'));

-- session_excerpts：任务意图三段式文本（政策 §「留存放开」的正文载体）
CREATE TABLE session_excerpts (
  session_key TEXT NOT NULL REFERENCES sessions(session_key),
  ordinal INTEGER NOT NULL,                  -- 会话内生产顺序序（单调唯一；§3-6）
  role TEXT NOT NULL CHECK (role IN ('user_first','user_turn','assistant_final','subagent_task')),
  excerpt TEXT NOT NULL,                     -- scrub+截断后文本；无文本的 turn 不产行
  provenance TEXT NOT NULL CHECK (provenance IN ('verbatim','truncated','scrubbed')),
  native_event_id TEXT,                      -- 锚点：本地 UI 直跳源日志原文段
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  PRIMARY KEY(session_key, ordinal, role)
);
CREATE INDEX session_excerpts_session ON session_excerpts(session_key, ordinal);
```

`error_class` 词表定义在 `agent-vitals-domain`（闭合枚举 + 测试钉住），Python 镜像同名常量——
分类是 Python/Rust 字节对等契约的一部分。`error_code` 语法：`家族:细节`，家族 ∈
{`http`,`jsonrpc`,`tool`,`harness`}；执行环境原生码原样进 `harness:`，不做二次猜测。

## 3. session_excerpts 提取算法（双语言字节对等，golden 走评审）

1. **取材**：`user_first` = 会话首条纯文本用户消息（复用适配器 `is_pure_text_user`）；
   `user_turn` = 其后每条纯文本用户消息；`assistant_final` = 末条含文本的 assistant 消息；
   `subagent_task` = 子代理任务 prompt（执行环境支持则产，不支持的执行环境如实缺行）。
2. **归一**：去首尾 Unicode White_Space；内部空白原样保留（归一会改字节，不做）。
   空白集 = 25 字符全集，两侧共享同一份 `WS_CHARS` 字面量并以独立构造的测试钉住
   （Python `str.strip()` 多裁 `\x1c`–`\x1f`、内建 `\s` 同理多匹配——凡空白类
   **一律用 WS_CHARS 字面类，禁裸 `\s`**，Step1 验收实锤过分歧）。
3. **scrub（先于截断）**：命中即把命中 span 替换为 `[…]`，provenance 记 `scrubbed`。正则表
   （domain crate 定义 + Python 镜像 + 正负例测试向量钉住）：`sk-`、`ghp_/gho_/github_pat_`、
   `AKIA[0-9A-Z]{16}`、`xox[baprs]-`、`Bearer …`（scheme 大小写不敏感，分隔符 = WS_CHARS
   字面类）、JWT（**仅要求首段 `eyJ`**——真实 JWT 的签名段是随机 base64url）、
   `-----BEGIN … PRIVATE KEY-----` 块（整块 + 裸头两条模式）。理由：用户会把凭据贴进对话——「凭据永不落盘」
   与「保留用户文本」两条政策只能靠这一步自洽。
4. **截断**：按 Unicode code point 计（代理对不劈半）；
   `user_first` 200、其余 role 120；不追加省略号（provenance 已声明）。
   **截断不得劈开 scrub 标记**：若截断产物以 `[` 或 `[…` 结尾，去掉该残尾
   （两侧同规则；标记恰好在限内则整段保留）。超限 → `truncated`；限内且未 scrub → `verbatim`。
5. **错误码整数为 ASCII 纯数字**：`http:`/`jsonrpc:` 家族的细节必须是可选负号
   + ASCII 数字串——Python `int()` 额外接受 Unicode 数字/下划线/前后空白/正号，
   Rust 解析不接受，双侧显式收窄到同一条边界（`http:+401`/`http: 401`/`http:٤٠١`
   两侧同拒）。JSON-RPC 保留带恰为 **−32768..−32000**。
6. **ordinal**：会话内**生产顺序序**（emitter 每 push 一条 +1）——单调、
   天然唯一。曾定义「CanonicalSession 时间线 ordinal」，实现时放弃：该序是
   三条 timeline 的合成计数，且同一记录多个 Task tool_use（并行子代理）会
   同 `(session_key, ordinal, role)` PK 碰撞。生产序与 TraceNode.native 的
   对应关系由 `native_event_id` 承担（锚点重定位键），不再由 ordinal 冒充。

## 4. V17 DDL（SCHEMA_V17_ADD，随测试 tab P1）

```sql
CREATE TABLE probe_routes (
  route_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  harness_kind TEXT NOT NULL CHECK (harness_kind IN ('claude-code','codex')),
  endpoint_base_url TEXT,
  credential_ref TEXT,                       -- 'ccswitch:<provider_row>' | 'env:VAR_NAME'：引用，永不存凭据本体
  model_requested TEXT NOT NULL,
  consent_granted_at_ms INTEGER,             -- 用此凭据发起测试请求的显式授权时刻；NULL = 未授权不得跑
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(label, harness_kind)
);

CREATE TABLE probe_suites (
  suite_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('l0_identity','l0_capability','l1_canary')),
  manifest_ref TEXT NOT NULL,                -- data_home/probe/suites/<suite>/<version>/ 清单文件
  manifest_sha256 TEXT NOT NULL,             -- 题面/判据/canary 串留文件系统（机密待遇），库只存引用+校验
  rule_version TEXT NOT NULL,                -- 冻结的统计判据版本（golden 纪律的判定层对应物）
  created_at_ms INTEGER NOT NULL,
  UNIQUE(suite_id, version)
);

CREATE TABLE probe_runs (
  run_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('single','paired')),
  route_a_id TEXT NOT NULL REFERENCES probe_routes(route_id),
  route_b_id TEXT REFERENCES probe_routes(route_id),   -- single 模式为 NULL
  suite_id TEXT NOT NULL REFERENCES probe_suites(suite_id),
  n_repeats INTEGER NOT NULL CHECK (n_repeats >= 1),
  interleave_seed INTEGER,                   -- A/B 交错顺序的种子（复现用）
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','budget_stopped')),
  currency TEXT,
  cost_budget_minor INTEGER,                 -- 硬熔断线；budget_stopped 状态由它触发
  cost_estimated_minor INTEGER,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  lease_owner TEXT,                          -- job 文件锁归属（billing_recalculation_jobs 先例）
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE probe_results (
  result_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES probe_runs(run_id),
  route_id TEXT NOT NULL REFERENCES probe_routes(route_id),
  task_id TEXT NOT NULL,
  repeat_idx INTEGER NOT NULL CHECK (repeat_idx >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass','fail','error','timeout')),
  uncached_input_tokens INTEGER,             -- 四桶与 usage_facts 同名同义（探针会话本身也产 usage facts，两路记账必须对得上）
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  turns INTEGER,
  wall_ms INTEGER,
  ttft_ms INTEGER,                           -- 仅辅助证据：网络混杂需在 verdict.confounders 里如实记
  requested_model TEXT NOT NULL,
  resolved_model TEXT,                       -- L0 身份证据主位；取不到 = NULL，不猜
  reasoning_effort_requested TEXT,
  reasoning_effort_reported TEXT,
  thinking_blocks INTEGER,                   -- 0|1|NULL=该探针不适用
  context_accepted_tokens INTEGER,           -- 窗口阶梯探针：实际接受的最大上下文
  error_code TEXT,                           -- 复用 V16 error_code 语法
  evidence_json TEXT NOT NULL,               -- B 类富证据：逐探针结构化原始结果（合成数据，放开存）
  session_key TEXT REFERENCES sessions(session_key),   -- 探针自身会话：下钻直连现有会话详情链
  UNIQUE(run_id, route_id, task_id, repeat_idx)
);
CREATE INDEX probe_results_run ON probe_results(run_id, route_id);

CREATE TABLE probe_verdicts (
  verdict_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES probe_runs(run_id),
  verdict TEXT NOT NULL CHECK (verdict IN (
    'confirmed_mismatch','suspected_degradation','no_signal','underpowered','inconclusive_confounded')),
  statistic_json TEXT NOT NULL,              -- 检验名/效应量/CI/p
  evidence_chain_json TEXT NOT NULL,         -- 有序证据引用（哪些 result/字段支撑该判定）
  confounders_json TEXT NOT NULL,            -- RTT 实测/交错完整性/缓存冷态——混杂如实记录
  rule_version TEXT NOT NULL,                -- 与 probe_suites.rule_version 对应：判定可归因到冻结规则
  decided_at_ms INTEGER NOT NULL,
  UNIQUE(run_id)
);
```

判定回流 findings 走现有 `issue_instances` 体系：`source_kind` 词表加 `'probe'`（登记制，不另起表）。
金额一律 `*_minor + currency` 分币种（`harness_bills` 同款纪律，永不跨币相加）。

## 5. 锚点语义（V16 `native_event_id` + `source_line/byte_offset`）

1. 只存 `source_id + native_event_id + 行号/偏移 hints`，**不存本地路径**——`source_files.path_hash`
   的既有红线不动；现场路径解析归 trace_service（呈现时）。
2. hint 自校验：展示前比对内容指纹，偏移漂移 → 按 native id 重扫定位（降级不失败）；
   源日志被执行环境轮换掉 → 诚实降级「源已过期，仅存库内投影」，不静默 404。
3. 锚点只在本地呈现层命令中使用——**载体是 CLI `trace-anchors`（本地子命令，
   直接读 authority，不经 mcp dispatch）**，不进 MCP 工具面、不进 MCP 载荷——
   把"去哪找原文"的地图发给有网的 agent 等于把原文发出去。（与发现 tab 规格
   §3.3 v3 的口径一致；本节早期写作「session_trace 扩展」是错的——session_trace
   是 MCP 注册工具，扩它就是把锚点发出去。）

## 6. 出口投影（政策「出口收口」的逐面落实）

| 面 | V16 新字段可见性 |
|---|---|
| MCP（data-mcp） | 可出：`error_class`、`error_code`、`task_profile`（含 basis）。**不出**：`error_excerpt`、`args_excerpt`、`session_excerpts.*`、锚点字段 |
| `data-export-redacted` | excerpt 类字段与 `session_excerpts` 整体不出现（键不出现的既有纪律，`scan.py --redact-names` 对 description wholesale drop 先例）；`error_class/error_code/task_profile` 保留 |
| `data-export-private` | 原样全带 |
| 本地 UI | 全量（含原文查看器，呈现时读取） |

注意（实现后修正，2026-09-19）：v0.9.1 起 sync 已停写 `facts/<harness>.jsonl`（存量
为遗留），excerpt **只进 authority DB**，不流经任何 JSONL——「facts 文件自此携带
用户文本」的原设想不成立，敏感面就是 `agent-vitals.sqlite3` 本身（离线单机可接受；
redacted 导出与 MCP 面的排除规则见上表与 §10-4/5 守护测试）。

## 7. 保留滚动（retention）

`session_excerpts` 随会话活跃月滚动：cutoff 与 `RETENTION_MONTHS_MINUS_ONE` 同源，
会话最后活跃月早于 cutoff 时该会话 excerpts 整组删除（与 `retention_usage_facts` 同一趟跑，
不另起定时）。probe 表不滚（判定历史是产品数据，量级可控）。

## 8. 迁移与兼容

1. `SCHEMA_VERSION` 15 → 16（V16 合入）→ 17（V17 合入，可与 16 之间隔一个版本窗口）。
2. `ensure_schema` 的全历史版本级联（authority.rs 的 `match found.cmp(&SCHEMA_VERSION)` 长链）
   每个早于新版本的分支追加对应 V16 应用调用（16 处：Some(15) 新分支 + Some(14)..Some(4)
   的 and_then 链 + Some(3)/(2)/(1) 的 if-let 块 + None 新建库）。v16 因是 ALTER-加列式增量，
   不以静态 batch 应用而以幂等的 `apply_schema_v16`（pragma 守卫加列 + `IF NOT EXISTS` 建表），
   保住 stale-v9 幂等升级不变量——实现说明见 SQL 权威库 spec §3.8；DDL 改动与其 §3
   镜像同步（authority.rs 头注纪律）。
3. 迁移写法沿用现成模式：加列一律 `ALTER TABLE ADD COLUMN`（v13 billing 列先例）；
   只有改 CHECK 才走 `_vN` 重建（scopes 表先例）。本 spec 全部为加列/新表，无重建。
4. 历史行回填：富化字段由 emitter 产生，**旧行在源日志重摄取前保持 NULL**；不提供
   SQL 侧假回填。AC 见 §10-3。
5. Python/Rust 对等面（golden 评审更新，绝不为绿灯刷新）：
   excerpt 提取算法（§3 全文）、`error_class` 分类规则、scrub 正则表、`error_code` 语法。

## 9. ATIF 导入映射（实现于 P2，规则先冻结于此）

| ATIF v1.7 | 本库落点 |
|---|---|
| step `metrics.prompt_tokens − cached_tokens` | `usage_facts.uncached_input_tokens` |
| step `metrics.cached_tokens` | `usage_facts.cache_read_tokens` |
| step `metrics.extra.cache_creation_input_tokens` | `usage_facts.cache_write_tokens`（ATIF 标准公式不含 cache write，本库计价一等公民——映射时不得丢） |
| step `metrics.completion_tokens` | `usage_facts.output_tokens` |
| step `model_name`（逐 step） | `model_switched` 事件（workflow_events 词表已有位，本 spec 使其开始产出） |
| step `reasoning_effort` | `usage_facts.reasoning_effort` |
| step `reasoning_content` / `message` / `tool_calls.arguments` 原文 | 按 §3 scrub+截断进 excerpts/args_excerpt；其余丢弃 |
| `subagent_trajectories` | 暂不映射（CanonicalSession 无子代理编号空间——TraceGraph 诚实性边界 3），导入器如实记 coverage 缺口 |
| `context_management`（compaction 边界） | `Compaction` 词表已有位，导入器可作其首个产出源（随 v0.10 Phase 2 走） |

## 10. 验收标准

1. scrub 正则表双语言测试向量：每个模式 ≥1 正例（替换为 `[…]`、provenance=`scrubbed`）+ ≥1 负例（不动）。
2. 截断：CJK 与代理对边界（emoji）按 code point 一致，双语言同输入同输出字节。
3. v15 库升级到 v16/17 后：旧行新列全 NULL；任一消费查询对 NULL 呈现「未富化」，无 0/空串误报（抽查 sessions/workflow_events/usage_facts 三表）。
4. `data-export-redacted` 产物中 excerpt 类键不出现（字节级断言）；`data-export-private` 原样包含。
5. MCP 面载荷与升级前字节一致（新增字段一个不进面）——现有 golden 不变即证。
6. 锚点自校验：篡改源文件行序后定位仍成功（native id 降级重扫）；源文件删除后 UI 呈现「源已过期」。
7. probe_results 四桶与该探针会话产出的 usage_facts 四桶一致（同一 run 抽 1 个 task 全 repeat 对账）。
8. `probe_verdicts.rule_version` 非空且能在 `probe_suites` 找到同名版本；verdict CHECK 拒绝词表外值。
9. `ensure_schema` 从 v5/v9/v15 三个历史版本起步各跑一次，均一步升到当前版本且 `integrity_check` 通过。

## 11. 图谱登记预清单（动 emitter 前登记，图谱自己的规矩）

§1「参数误用」❌→✅（error_code/class）；§2「JSON-RPC 错误分类」❌→✅（同）；
§2「结果过大」❌→✅（result_bytes）；§5「单会话模型混切」❌→✅（model_switched 产出）；
§5 新增两类：「模型降级 fallback」（probe_verdicts 信号源）与「请求被改写」（resolved vs
requested / effort 不符）；§6 新增：「任务画像」（task_profile，标 inferred）。

## 12. 联动文档修订清单（本 spec 合入时同步）

1. [发现 tab 规格](WORKBENCH_FINDINGS_TAB_SPEC.md) §3.3：「永不是原始 JSONL」改为
   「原文查看是本地呈现层专属（呈现时读取、永不落库、不进 MCP/导出）」；
   §3.4：「摘录不进库」改为「摄取时摘录入库（session_excerpts），源在时锚点增强」，
   「不进 MCP 面」保留。
2. [SQL 权威库迁移 spec](../AGENT_VITALS_V0_9_1_SQL_AUTHORITY_MIGRATION_SPEC.md) §3：
   追加 V16/V17 表定义为 DDL 镜像源。
3. taxonomy 图谱按 §11 登记。

## 13. 分期

- **P1（V16）**：全部加列 + `session_excerpts` + extractor/分类/scrub 的双语言实现与 golden、
  redacted 导出过滤、retention 扩展、锚点读取命令。`task_profile` 列占位不填。
  **落地顺序纪律（Step2 验收后明确）**：导出过滤、retention 扩展、锚点命令与**首个 emitter
  同一变更落地**——在没有任何 excerpt 数据能流入库之前，过滤是空转；在首个 emitter 合入
  之后再补过滤则存在泄漏窗口。二者必须同 PR，顺序不可拆。
- **P2（测试 tab P1）**：~~probe 五表~~（已提前于 Step4 落库——schema v17 全量合入，
  见 §4 与 SQL 权威库 spec §3.9；runner/判定/UI 仍随本档）、`source_kind='probe'`、
  `model_switched` 读面、ATIF 导入器。
- **P3**：`task_profile` 规则填充（rule_toolmix）、本地 FTS 会话搜索（LIKE 先行）、
  本地语义分类器评估（**不得调用云 LLM——违反无回传不变式**）。

## 14. 明确不做

- 不存全文与中间 assistant 轮（三段式之外不扩）；不做跨会话正文聚合。
- 不做云侧语义分类/摘要（无回传前提钉死）。
- MCP 面与 redacted 导出不因本 spec 放宽任何字节。
- 探针表不做 retention 滚动；不把金丝雀题面/判据/canary 串写入任何库表（manifest 引用除外）。
- 不为旧数据提供 SQL 假回填——NULL 诚实保留到源日志重摄取。

## 15. 待拍板清单（默认值已按建议采纳，可推翻）

1. 截断档位 200/120/120 —— **已按默认采纳**。
2. `assistant_final` 保留 —— **已采纳**（任务结果确认维度）。
3. `task_profile` 规则先行、语义分类 P3 —— **已采纳**。
4. scrub span 替换标记固定为 `[…]` —— 已采纳（改字形=双语言同时改+golden 评审）。
5. FTS：P1 用 LIKE，P3 评估 SQLite FTS5（含中文分词形态）。
6. `subagent_task` 各执行环境覆盖顺序（claude-code 先、codex 随后）——实现时按执行环境成熟度排。
