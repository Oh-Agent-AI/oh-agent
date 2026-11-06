# Codex 会话审计信号挖掘 — Spec

> 状态：**已实现**（2026-08-30）。实现按可验证能力拆分提交；原有的字段
> 富化仍保留，但不再是第一个阶段。
>
> 来源：对真实会话 `01a029cb`（2026-08-22，`gpt-5.6-sol`，paginated，`codex_work_desktop`）
> 的逐字段深挖。该会话说明 Codex 已有比当前报告更多的原始证据；同时也暴露出：
> 只有“更多字段”仍不足以形成可行动的审计结论。

## 0. 产品目标与审计状态模型

目标不是像素级复制 DSH Client，也不是把 rollout 的每个字段堆进 HTML。`codex-session`
必须满足与 DSH Audit 相同的决策链：

```text
原始 Codex rollout → CanonicalSession → 规则结果 / 真实 finding
  → 可定位的 turn、tool、evidence → 资源与权限解释 → 跨会话聚合（后续）
```

当前页面的“Finding 队列”混合了残差哨兵和零覆盖信号，而不是规则 finding；“异常”KPI
实际显示覆盖率。这两类信息必须拆开。所有消费者使用以下三种状态：

| 概念 | 含义 | UI 表示 | 是否计入异常 |
|---|---|---|---|
| 执行环境结构缺口 | Codex wire 从不提供该维度 | `Unavailable` / 结构缺口 | 否 |
| 会话未观测 | 执行环境可提供，但本会话没有此事件 | `Not observed` / 证据缺口 | 否 |
| 审计 finding | 可运行规则命中风险模式 | severity + rule + evidence | 是 |

`coverage.<signal>.available` 只回答第一行；coverage 计数只回答第二行；
`audit.rule_outcomes` 与 `audit.findings` 才回答第三行。

## Phase 0 — 审计结论投影（必须先做）

### 0.1 复用现有 canonical 规则引擎

不得在 `codex_session_audit.py`、`.rs` 或 HTML 重写 SV 规则。建立一次
`CanonicalSession` 后，复用共享层的 family ① behavior outcomes（SV601–SV610）和
trajectory outcomes（SV611–SV614），再通过既有 flatten / `rule_outcomes_json` 产生展示投影。
Python 必须以相同 gating 和字节形状镜像 Rust。

### 0.2 JSON 形状

在 `date_span` 后、`cost_report` 前新增 `audit`，并保持 Python/Rust 键序一致：

```json
"audit": {
  "summary": {
    "critical": 0,
    "warning": 1,
    "info": 0,
    "findings_total": 1,
    "rules_unavailable": 2
  },
  "findings": [
    {"rule":"SV610","severity":"warning","category":"approval",
     "turn":7,"step":null,"tool":null,"evidence":"danger-full-access"}
  ],
  "rule_outcomes": {
    "SV601":{"status":"measured_zero"},
    "SV609":{"status":"unavailable","missing":["ApprovalDecisions"]},
    "SV610":{"status":"findings","count":1}
  }
}
```

`findings` 复用既有 finding 的字段与坐标，不能为了 HTML 再建一份会漂移的简化格式。
`summary` 只是便利投影，必须可以从 `findings` / `rule_outcomes` 完全重建。

### 0.3 页面契约

- “异常”KPI 只显示 `audit.summary.findings_total` 与最严重 rule；
- “Finding 队列”只显示真实 `audit.findings`；
- `Unavailable` rule 要显示缺少的信号和执行环境限制，不显示为零命中；
- coverage 移回“证据质量”，不进入 finding 计数；
- 每条 finding 显示 rule、severity、turn、工具（若有）和截断 evidence。

### 0.4 UserPrompts 数据纪律

`response_item.message + role:"user"` 并不天然等于真人提示：真实会话中已有仅含
`<recommended_plugins>` 与 `<environment_context>` 的执行环境注入 message。Python/Rust 必须
以同一规则把它分类为 `human` / `ambient_only` / `mixed` / `unknown`：

- `human` 与 `mixed` 每条 message 最多计一次 `UserPrompts.measured`；
- `ambient_only` 不计入；
- `unknown` 计入 `lossy`，不得伪装为 `measured`；
- 分类只检查最小结构和已知 wrapper 前缀，不读取或导出用户正文。

## 1. Context：线格式里被丢弃的证据

对 `/Users/Admin/.codex/sessions/2026/08/22/rollout-2026-08-22T22-06-31-01a029cb-692f-7be0-b984-2ed06347eea9.jsonl`
（208 行、25 分钟、$3.38 / 114.5 万 tokens）实测，当前 19 信号模型 + codex-session 报告
丢弃以下证据：

| # | 证据 | 实测（01a029cb） | 现状 |
|---|---|---|---|
| 1 | **配额消耗轨迹** | `rate_limits.primary.used_percent` 24 个快照，19%→20%（本会话消耗周配额 1 个百分点） | fold 只保留最后一条 plan 快照（`_combine_plan` last-seen wins），轨迹被丢弃 |
| 2 | **active_permission_profile** | 6 个 turn 激活 `:danger-full-access`、8 个 turn 为 null（「保持上一档」语义）；静态 `permission_profile` 恒 `{type: disabled}`。**wire 形态是 object `{"id": ":danger-full-access"}`**（01a029cb 11/14 turn_context、01a050f5 28/44；thread_settings_applied 的 thread_settings 里另有 42 个同形态嵌套，无 turn_id 不作轨迹轴） | 全仓零提取（grep 无命中）——比静态 sandbox_policy 细一个粒度的 per-turn 权限档位；修复前只认 string 形态，真机轨迹 observed/effective 全 null（HIGH-1） |
| 3 | **turn 结束原因** | 14 个 turn 全 `error=None, reason=None`（干净结束） | canonical 的 `turns` timeline 已提取 `end_reason_kind`/`end_error_code`，审计层转 `codex_evidence_json` 时丢弃 |
| 4 | **effort / reasoning_effort** | 恒 `"low"`；`thread_settings.reasoning_effort:"low"` + `reasoning_summary:"detailed"` | 零提取——§3.1 的 Policy 类伴随变量，与成本/推理强度强相关 |
| 5 | **工具 stdout 体积** | 5 条 CommandExecution 共 9150B stdout（2641/2045/2080/2096/288B） | ToolResults 只数 presence，不数「多少字节灌进上下文」 |
| 6 | **duration 语义** | `{secs:0, nanos:4416-9250}` = **4–9µs**——sed 读 2KB 文件不可能 9µs，**不是进程墙钟** | §13 矩阵声称 `CommandExecutionItem.duration` → measured，注释称「也喂 Tool-call duration」——实为误导 |

附注：`turn_context.comp_hash` 14 个 turn 恒 `3000`——本会话零压缩，**Compaction=0 是如实
的**；且该字段是未来的**免费压缩证据载体**（跨 turn 变化即压缩发生，不依赖
`context_compacted` 事件）。本 spec 只注记不实现。

## 2. 设计决策

- **D1 分层线 = 已落地消费者**：`Signal` enum 只放已经有检测器或聚合消费者的维度。
  配额先作为报告富化字段；只有 quota burn-rate、额度告警、日历/菜单栏聚合或可行动 KPI
  与 enum 同一阶段落地时，才新增 `QuotaConsumption`。其余五项是已有信号的数据富化或
  防御性更正，进报告不进 enum。先例：§13 矩阵本就有非 enum 维度行（Tool-call duration /
  Workspace root / Storage medium / Process liveness）。
- **D2 不动 fold**：配额轨迹在**审计层**扫 `all_items`（`_context_window_of` 先例：
  `codex_session_audit.py:58-80` ↔ `src/agent/codex_session_audit.rs:57-75`）。
  `codex_fold_file`/`codex_merge_folds`/`codex-cost` 锁步**零风险**——探索确认 fold 输出
  不序列化、四键形状被 characterization 钉死，改它得不偿失。
- **D3 turn 结束从 canonical 取**：审计层现把 `build_codex_evidence` 返回的 canonical 丢弃
  （py `codex_session_audit.py:186-189` 转 json 即丢）——改为**保留 canonical**，从
  `canonical.turns` 聚合 end_reason_kind/end_error_code 分布。复用 `populate_codex_timelines`
  的配对状态机，不重扫 items（第二份配对逻辑必然漂移）。
- **D4 模板不加 JS 折叠**：所有数值在 Python/Rust 审计层**预计算**，模板只显示。新字段
  的锁步由 `both()` 差分天然覆盖（新 key = 新字节），不新增 verify 脚本。
- **D5 duration 不读数**：实测微秒级非墙钟，语义待 Codex 上游澄清。本 spec 只做
  **文档/注释更正**（防御），不引入 duration 信号、不接 duration-audit。

## 3. 数据形状（`codex-session --json` 新 key）

插入位置：`date_span` 之后、`cost_report` 之前（Python
`codex_session_audit.py:194-211` dict、Rust `src/agent/codex_session_audit.rs:233-255`
Map，**同序号插入**；键序是字节一致的一部分，不能重排）。

```json
"audit": {                                // Phase 0：真实规则结论，详见 §0
  "summary": {"critical":0,"warning":0,"info":0,"findings_total":0,"rules_unavailable":2},
  "findings": [],
  "rule_outcomes": {"SV601":{"status":"measured_zero"}}
},
"quota_trajectory": {                     // 审计层扫 all_items 的 token_count.rate_limits
  "scope": "primary",
  "samples": 24,
  "first": {"used_percent": 19.0, "observed_at": "2026-08-22T14:07:33.058Z"},
  "last":  {"used_percent": 20.0, "observed_at": "2026-08-22T14:32:49.509Z"},
  "consumed_percent": 1.0,
  "resets_at": null,
  "comparable": true,
  "reason": null                           // first 缺失 / reset / 跨窗口时不可编数
},
"permission_transitions": {               // 按 turn_context 事件序；页面默认只展示变化点
  "dangerous_turns": 6,
  "transitions": [{"turn": 1,
   "observed_profile": ":danger-full-access", "effective_profile": ":danger-full-access",
   "sandbox": "danger-full-access", "approval": "never"}
  ]
},
"turn_ends": {"total": 14, "clean": 14, "error": 0, "incomplete": 0, "codes": {}},
"effort": {"effective": "low", "reasoning_effort": "low",
           "reasoning_summary": "detailed", "changed": false},
"tool_output_bytes": {"stdout": 9150, "stderr": 0, "commands": 5,
                      "top": [{"turn": 5, "tool": "bash", "stdout_bytes": 2641}]},
"turn_timeline": [                        // source-order 事件一览（权限/turn 边界/命令/用量）
  {"source_order": 1, "turn": "t1", "kind": "turn_context",
   "summary": "权限上下文", "rule_refs": ["SV610"]}   // rule_refs: 该 source_order 命中的规则
]
```

实现纪律：

- **`active_permission_profile` 两态读取**（2026-08-30 修复，HIGH-1）：真实线格式是
  object `{"id": ...}`（01a029cb/01a050f5 实测），旧 fixture 的 string 形态是假想——
  两态都认，`observed_profile` 取 id 字符串。`effective_profile` 按 last-seen 推进：
  observed 为 null 的 turn 保持上一档（「保持上一档」语义），所以 null 档**如实记
  observed=null、effective=携带值**，模板用 effective 展示。
- **`dangerous_turns` 按 distinct turn_id 计**：同一 turn 的多次 turn_context（真实会话
  常见，01a050f5 实报 43 条事件）只计 1；无 turn_id 的事件无从去重，退化为按事件计。
- **`turn_timeline.source_order` 是显式序号**（`enumerate(all_items)`），不是从 seq 编造
  的——规则 `rule_refs` 按 `finding.seq == source_order` 反查，seq 是 canonical 事件序
  与 source_order 同序，但模板永远展示 source_order 而非假装它是任何时间戳。

- **严格类型镜像 serde_json**（`as_i64`/`as_f64` ↔ isinstance + bool 排除），扫描 helper 仿
  `_context_window_of` 的写法。
- **used_percent 提取复用** `codex_usage._plan_from_rate_limits`（py `codex_usage.py:92` ↔
  rust `codex_usage.rs:182`）的字段读取口径，不重写第二份字段路径。
- `quota_trajectory.first/last` 为「有效 used_percent 的首/末快照」；只有 1 个快照时
  first==last、consumed=0；0 个快照时整键 `null`（`_empty_cost_report` 式兜底，绝不编数）。
- 遇到 reset、不同额度窗口或无法解释的倒退，`consumed_percent` 必须为 `null`、
  `comparable:false`，并给出 machine-readable `reason`；绝不把跨窗口差值展示成会话消耗。

## 4. Phase 1 — 报告富化（无 enum 变更）

### 4.1 双实现审计层（锁步铁律）

- `scripts/agent_vitals/agent/codex_session_audit.py`：在 Phase 0 保留的 canonical 基础上新增
  5 个 scan helper（
  `_quota_trajectory_of` / `_permission_trajectory_of` / `_turn_ends_of` /
  `_effort_of` / `_tool_output_bytes_of`），`codex_session_audit_json` 插入 5 个 key；
  `turn_ends` 从 `canonical["turns"]` 聚合。
- `src/agent/codex_session_audit.rs`：同结构镜像（`FileInfo.items` 已在手 rs:47/107）。

额外约束：permission 的 raw `null` 不得清空上一条 effective state；effort 发生变化时
不得只输出 last-seen；输出体积要包含最大贡献者；turn end 必须区分 `incomplete` 与 clean。

### 4.2 模板 `scripts/agent_vitals/templates/codex_session.html`

- 配额轨迹：`#s-plan` 区块（:360-393）加一行「本会话消耗配额 N 个百分点（A%→B%）」。
- 权限轨迹：`#s-timeline` 与 `#s-plan` 之间（:134/:145）新 subcard「权限轨迹」，默认显示
  effective state 的变化点和危险状态持续 turn 数；完整逐 turn 数据折叠展示。
- turn 结束：`#s-coverage` / provenance 一行（`.sv-insight`）。
- effort：topbar-chips 徽章。
- 工具输出体积：`#s-coverage` 一行（「工具输出 N KB 进上下文」）+ 最大贡献命令列表。
- **无新 JS 折叠**（D4），全部读预计算字段。

### 4.3 防御性文档/注释更正（D5 + comp_hash）

- `docs/RUNTIME_EVIDENCE_CONTRACT.md:561` §13 Tool-call duration 行 Codex-Paginated cell 加
  「⚠️ 实测 4–9µs 非墙钟，语义待澄清」脚注；`:623` TurnItem 表 duration 句同。
- `crates/agent-vitals-adapters/src/harnesses/codex/sessions/evidence.rs:403-404` 过时注释（「CommandExecution
  额外带 duration → 也喂 Tool-call duration」——实际从未喂）改为诚实话；
  `codex_evidence.py:218-220` 同源注释同步。
- comp_hash 注记：`scripts/agent_vitals/adapters/codex_session.py:116`（turn_context 分支）
  + Rust `src/agent/codex_session.rs:103` + contract §14.1。
- 记忆 `codex-corpus-facts.md` 补 duration 语义实测 + comp_hash 事实。

### 4.4 测试

- `tests/test_cli_matrix.py::test_codex_session_detail_differential`（:1350）：新 key 语义
  断言（fixtures/codex/cost/ 三文件带 rate_limits，可测 trajectory）。
- `test_codex_session_multi_file_union`（:1431）：多文件 resume 时 trajectory 跨文件
  first/last 正确。
- `tests/test_cli_m3.py::TestCodexSessionHtml`（:647-727）：新 section 结构断言。
- 差分本身由 `both()` 自动钉（新 key 即新字节，Python↔Rust 逐字节相等）。

## 5. Phase 2 — 按 turn 的审计时间线

逐小时 token 曲线保留为成本概览，但不能承担审计定位。新增按 source order / turn 排列的
事件层；没有可靠 `seq` 时不得伪造 seq。每个可显示事件至少含：

```text
turn、source_order、kind、summary、rule refs、permission 状态、token/quota 快照
```

时间线要叠加 finding marker、permission/sandbox 变化、tool call/result/错误、高输出量命令、
quota checkpoint 与 turn 结束状态。点击 finding 必须能定位对应事件；图下必须提供同序事件
列表，不能只依赖颜色或 hover。少于 4 个趋势点时用摘要卡或事件列表，不能把退化折线伪装
成趋势。

## 6. Phase 3 — `QuotaConsumption` 信号（enum 变更，独立提交）

### 6.1 共享层

- 前置条件：quota burn-rate、额度告警、日历/菜单栏聚合或可行动 quota KPI 至少有一个与
  enum 同一阶段落地。未满足时，Phase 1 的 `quota_trajectory` 已足够。
- `crates/agent-vitals-core/src/contracts/evidence.rs`：`Signal::QuotaConsumption`
  （harness-neutral 名，不违反 `shared_type_layer_has_no_harness_identifiers_in_code`）。

### 6.2 Codex 侧（measured）

- `crates/agent-vitals-adapters/src/harnesses/codex/sessions/evidence.rs` ALL_SIGNALS（:438）+1；
  `derive_coverage` 的 `token_count` 分支：`rate_limits` 存在 → `bump(QuotaConsumption,
  Measured, 1)`（每事件 1，同 Usage 口径；无 rate_limits 的 token_count 不数——同
  ContextWindow 的守卫式）。
- `scripts/agent_vitals/agent/codex_evidence.py` ALL_SIGNALS（:37-57）+1、derive_coverage
  同步。
- `available: true`（wire 提供，Legacy/Paginated 两种 mode 都持久化）——
  `is_unavailable`/`_UNAVAILABLE_SIGNALS` **不动**（仍是 4 项）。

### 6.3 DSH 侧（honest unavailable）

- `crates/agent-vitals-core/src/adapters/harnesses/dsh/sessions/evidence.rs:486-489` 零填充列表 +1
  （`coverage.set(Signal::QuotaConsumption, CoverageCounts::default())`），注释「矩阵没
  覆盖的三行」→ 四行；单测 `unmapped_signals_are_unavailable_not_fabricated`
  （:649-652）列表 +1。
- Python DSH 行为路径（`behavior.py`）无 enum/ALL_SIGNALS，`requires` 不含新信号 → **不动**。

### 6.4 wasm + 文案 19→20

- wasm 重编（core enum 变更波及 `audit_events` 输出）+ 拷进 `dsh-client/` + 跑其 verify
  （锁步铁律：wasm↔CLI 漂移只能靠重跑 wasm build 抓）。
- 文案全量：
  - 模板 subtitle「19 信号覆盖」（codex_session.html:141）→「20 信号覆盖」；
  - `scripts/verify-codex-session-findings.mjs` synthetic 数据：covered 加
    QuotaConsumption、availCount 15→16、KPI 10/16；
  - `tests/test_characterization.py:2872` `test_all_19_signals_appear_in_coverage` → 20；
  - contract §3 enum 列表（:100-118）+ §13 矩阵新行
    `| Quota consumption | unavailable | measured | measured | unavailable | unavailable |`
    （DSH/Claude Code/WorkBuddy 诚实 unavailable——wire 无此字段，将来实测再翻，同
    NetworkAccess 先例）。

## 7. 测试矩阵

| 层 | 测试 |
|---|---|
| 审计结论 | 同一 canonical 导出的 findings 与 rule outcomes 自洽；unavailable rule 不得泄漏 finding |
| Prompt 分类 | ambient-only / mixed / human / malformed 四类 Python↔Rust parity |
| 差分锁步 | `AGENT_VITALS_BIN=target/release/agent-vitals python3 -m unittest tests.test_cli_matrix`（所有新 key 字节级） |
| 资源富化 | quota 单样本/无样本/reset/倒退/多文件续写；effective permission 不被 raw null 清空；turn incomplete 单列 |
| 时间线 | 0 / 1 / N event，finding 定位、无障碍事件列表、无伪造 seq |
| HTML | test_cli_m3 结构断言；blob 内联 = `--json` 输出，自动覆盖新 key |
| 枚举 | cargo test（dsh 零填充单测 +1）、characterization 20 信号 |
| 模板 JS | verify-codex-session-findings.mjs 更新后经 test_codex_session_template.py 跑 |
| wasm | 重编 + dsh-client verify（Phase 3） |

## 8. 验证（端到端）

```bash
cargo test && cargo clippy --release --all-targets -- -D warnings
python3 -m unittest discover tests
AGENT_VITALS_BIN=target/release/agent-vitals python3 -m unittest tests.test_cli_matrix
(cd crates/agent-vitals-wasm && wasm-pack build --target web)   # Phase 3
# 真机回归：01a029cb 再跑 codex-session，核对真实 findings、prompt 分类、quota 与权限轨迹
```

## 9. Out of scope（后续项）

- 日历/菜单栏聚合配额轨迹（跨会话投影）、quota 烧速检测器规则、codex duration-audit
  消费、comp_hash 实现、name-aware 门控、Claude Code/WorkBuddy/DSH 配额来源实测。

## 10. 交付

提交边界按可验证能力划分：

1. `feat(codex): project canonical audit findings and rule outcomes`
2. `fix(codex): classify human prompts and separate evidence quality`
3. `feat(codex): enrich quota permission turn and tool-output evidence`
4. `feat(codex): add turn-event audit timeline`
5. `feat(core): add quota consumption signal and consumers`

每个提交都必须让 Python/Rust 差分通过；Phase 3 不允许只更新 Codex 而遗漏 DSH 的
unavailable 语义或 WASM 构建产物。本文件是 spec 正本；草案阶段在
`.claude/plans/cryptic-waddling-floyd.md`。
