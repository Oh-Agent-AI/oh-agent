# WorkBuddy 执行环境接入：调研结论与适配边界

> 采集 2026-09-02。本机 `~/.workbuddy/` 真实语料实测（memory：`workbuddy-data-facts`）。
> 关联：[RUNTIME_EVIDENCE_CONTRACT.md](./RUNTIME_EVIDENCE_CONTRACT.md)（§13/§14.6 的 WorkBuddy 对账）·
> [CLAUDE_CODE_INTEGRATION.md](./CLAUDE_CODE_INTEGRATION.md)（同构接入范式的上一例）·
> [MENUBAR_MULTIHARNESS_NAVIGATION_SPEC.md](./MENUBAR_MULTIHARNESS_NAVIGATION_SPEC.md)（多执行环境导航）·
> [VITALS_CORE_V0_5_IMPLEMENTATION_SPEC.md](./VITALS_CORE_V0_5_IMPLEMENTATION_SPEC.md)（v0.5 架构）。
> 状态：**调研结论 + 适配器已落地**（2026-09-02 更新）。数据面证据已实测（§2 的 4 表面 3 可
> join、audit-log 三层决策账本、traces 由 `trace.sessionId` 可 join（09-11 纠正，原误判「匿名」）、credit_json 执行环境**积分**账单）；§3 规则能力矩阵、§7
> 决策映射、§8 请求重建已定案（P0 修正版）。§4 的 provenance / `ToolResultObservation.failed`
> 是 Claude 接入第一刀落进 `agent-vitals-core` 的既有成果，WorkBuddy 直接复用，**不需要再改
> core 模型**。评审结论：不修改通用 `vitals-core`、不修改 `agent-vitals-core` 既有证据模型的
> 方向**成立**。适配器本体已实现并验证（§11 工作项 1–9：`workbuddy_evidence.rs` /
> `workbuddy_session.rs` + Python 镜像 + fixtures + 六条差分，`workbuddy-session` CLI 双侧
> 逐字节一致）。SessionStore/Tauri 接入仍属后续阶段（§5）。

## 0. 结论

WorkBuddy 接入**不需要修改通用 `vitals-core`，也不需要修改 `agent-vitals-core` 的证据模型**
——Claude 接入第一刀已经把 provenance（`TimelineEntry.provenance`）与 `ToolResultObservation.failed`
补进 core，WorkBuddy 需要的全部 observation 类型（`ToolCallObservation`/`ApprovalObservation{asked,decided}`/
`SandboxModeObservation{mode}`/`TurnObservation`/`TimelineEntry`）都已存在。净新增的是一个**适配器**
（`agent-vitals-core/src/adapters/harnesses/workbuddy/sessions/evidence.rs` + binary `src/agent/workbuddy_session.rs` + Python
镜像三个文件），外加一个**新依赖类**：rusqlite（bundled，仅二进制侧，§1.4）。

正确层级（与 Claude §0 同构）：

```text
~/.workbuddy/{workbuddy.db, audit-log/*.jsonl, file-history/<sessionId>/}
→ WorkBuddyEvidence {           ← 与 claude_code_evidence.rs / codex_evidence.rs 同层
    canonical: CanonicalSession,
    raw_records
  }
→ compatibility/canonical_session.rs::canonical_session_to_vitals()
→ CanonicalEvent → Detector
```

**不要写 `workbuddy.db → CanonicalEvent` 直连**——理由与 Claude 相同：绕开五条通用 timeline、
Coverage 三态、SourceAttempt 与既有兼容测试路径（§1.1）。

**与 Claude/DSH/Codex 的关键差异**（全部来自实测，§2）：

- 会话数据**不在一个文件里**，而是**四张可 join 表面**（2026-09-11 修正：traces 也可 join，
  见 §2.1 表/§12.2）。已落地的适配器只拼装前三张（db 行、audit-log、file-history）；traces
  的接入是独立后续 Phase（`WORKBUDDY_ONBOARDING_SPEC.md` Phase E），**现有实现仍按 §14.4
  记 attempts、标 Unavailable，绝不猜 session**——「不猜」的纪律不变，变的是「不用猜」。
- audit-log 是**安全决策账本**，不是逐请求账本（13/22 requestId 可 join）。工具调用只有
  **bash 子集**（`commandPreview`）+ **WebFetch**（`messageParams.target`）可 join；
  write/edit/subagent/duration 证据只在 traces 里，**E2（2026-09-11）已接入**（按 `trace.sessionId` 归属，
  §12.2）→ SV604/605 现为 Available（function span → tool_calls，见 §3.1 矩阵）、SubagentSpawns 从
  trace agent span 折叠。
- 成本是**执行环境自己按积分记的账**（`session_usage.credit_json`，单位是平台积分不是货币），
  不是 token 桶 × 单价——**不涉及 pricing.json，不涨第四份价格拷贝**（§9）。
- audit-log 自带 `prevHash→hash` 链，是最老可能轮转的安全账本——完整性校验是适配器的
  职责之一，轮转要诚实标注 verified-from（§2.3、§12.3）。

## 1. 现有链路（代码验证，2026-09-02）

### 1.1 真实接入路径

与 Claude §1.1 同一桥：`crates/agent-vitals-core/src/compatibility/canonical_session.rs`
`canonical_session_to_vitals(&CanonicalSession) -> Vec<CanonicalEvent>` 是唯一合法的
CanonicalSession → CanonicalEvent 桥。WorkBuddy 适配器先产出 `CanonicalSession`，走这条桥，
**不新增第二条桥**。

### 1.2 证据适配器范式（WorkBuddy 的挂载层）

`claude_code_evidence.rs` 是本轮要镜像的范式：适配器持有 `canonical + raw_records`，
`build_workbuddy_evidence` 产出、`workbuddy_evidence_json` 回吐原始形状。与
`claude_code_evidence.rs` / `codex_evidence.rs` / `dsh_evidence.rs` 同层同构。

### 1.3 数据面定位与 join 锚点

本机实测 4 表面（§2.1 表），3 个可 clean-join。**`sessionId` 是唯一 join 锚点**：
db `sessions.id`、`session_usage.session_id`、audit-log 记录的 `sessionId` 字段、
file-history 目录名四处对齐；**traces 由 `trace.sessionId` 对齐**（第五处，09-11 修正，§12.2）。

### 1.4 第一个 sqlite 读取依赖（设计决策，待评审）

WorkBuddy 的主表面是 SQLite `workbuddy.db`。Python 用 stdlib `sqlite3` 读；Rust 侧
**新增 `rusqlite = { version = "0.31", features = ["bundled"] }`**（仅二进制 root 的
`[dependencies]`，core crate 保持纯函数零 I/O）。理由：

- **差分门禁要求两边读同一个真实 sqlite 夹具**：`test_cli_matrix.py` 的 `both()` 把同一
  个 fixture home 喂给 py==rs 逐字节比对；若 Rust 读不了 db，usage/策略信号两边必分叉。
  JSON 镜像方案（把 db 行导出成 JSON 让两边读）是**同一数据的第二份表示**，产生漂移风险，
  违背「core 是唯一真相源」纪律——不用。
- 零依赖约束只约束**被分发的 Python skill 形式**（CLAUDE.md：「what is *distributed* as the
  in-harness skill」）；Rust binary 通道（npm/brew/cargo/Release）本就带 clap/regex/serde/sha2/
  walkdir/ruzstd 等常规 crates.io 依赖，`ruzstd` 先例（2026-08-30 用户拍板）已确认这一条。
- `bundled` 编译 sqlite3.c，构建期需要 C 工具链（macOS clang / CI ubuntu gcc 都有）；
  CI `cargo test`/`clippy` 构建时间略有增加，可接受。
- wasm crate 不依赖 root 的 `[dependencies]`，WorkBuddy 也不是 DSH tab 面，**不重建 wasm**（§6）。

### 1.5 TrajectoryAssigner 的职责边界（同 Claude §1.3，评审 P0-2 已验证）

turn/step/请求重建、工具调用关联必须在**适配器的 derive 阶段**完成并写进
`CanonicalSession` timeline；TrajectoryAssigner 只做 `CanonicalEvent → TrajectoryId`，
不挂 turn 状态机（WorkBuddy 没有 turn 结构可挂，§8）。

### 1.6 SignalVocabulary 不需要 WorkBuddy 专属词表（同 Claude §1.4，评审 P0-3 已验证）

适配器统一输出**已有 canonical kinds**：audit-log `commandPreview` → `agent.tool_call`
（`tool_name="bash"`）、`WebFetch` → `agent.tool_call`（`tool_name="web_fetch"`）、
审批/拒绝决策 → `approval/asked` + `approval/decided`。不需要新增 WorkBuddy 专属词表。

## 2. WorkBuddy 数据面（实测 2026-09-02）

### 2.1 表面清单（4 表面，3 个可 clean-join）

| 表面 | 本机实测 | join key | 对适配的价值 |
|---|---|---|---|
| `workbuddy.db` `sessions` | 22 行 | id | 元数据 / `permission_mode` / `model` / `cwd` / 时间戳 |
| `workbuddy.db` `session_usage` | 22 行 | session_id | `used`(token) / `size` / `credit_json`(执行环境**积分**账单) |
| `audit-log/*.jsonl` | 23 文件 / 2563 条 / 23 sessionId（21 在 DB） | 记录内 `sessionId` 字段 | 安全决策账本（命令/网络/批量删除），自带 hash 链 |
| `file-history/<sessionId>/<contentHash>@v<n>` | 16 会话 / 730 文件 | 目录名 | 文件内容快照（**无路径**，只有内容 hash@版本） |
| `traces/<pid>/trace_<id>.json` | 675 文件 / 653MB / 105 pid（09-11 重测） | **`trace.sessionId`**（结构化字段，`RUNTIME_EVIDENCE_CONTRACT.md:747` 早有记录） | span 树：tool calls + generations + duration —— **可 join**：354/675 有 `sessionId`、**100% 匹配 `sessions.id`、覆盖 22/23 会话**；其余 321 个全是 `name='Agent workflow'`（无 `sessionId` 键、`metadata:{}`、`totalTokens: 0`）——
   **E5 纠正：name 不是类；`totalTokens` 302/675 为 0 而 span 有 usage，不可信**；未归属
   generation span 有真实用量（1,202 个，发 fact 前拦下）。**09-02「会话匿名」结论系
   分析方法错误**（§12.2） |

**三条读表纪律**：

- **audit-log 按记录内 `sessionId` 字段分组，不是按文件名**（真实文件名与 sessionId 未必
  对应）；文件名只用于枚举 `audit-log/*.jsonl`。
- **db 列按名读取**：`sessions` 读 `id/permission_mode/model/cwd` 及时间戳，`session_usage`
  读 `session_id/used/size/credit_json`。任何必需列缺失 → 该信号报 Unavailable，**绝不编造**
  （缺列报缺，编列害人）。
- **file-history 只数版本数**（目录下 `@v<n>` 文件数 = FileMutations measured），内容 hash
  与版本号原样保留，**路径不存在**——SV604/605 在 WorkBuddy 上结构性无解（§3）。

### 2.2 audit-log 是三层决策账本（比 §13 的「security decisions」更细）

每条记录字段（并集）：`sessionId / requestId / toolCallId / category / eventType / decision /
commandPreview / commandHash / messageKey / messageParams / timestamp / sequence / prevHash /
hash`。命令类记录带 `commandPreview`/`commandHash`，网络/审批类带 `messageKey`/`messageParams`。
三类决策路径（实测计数）：

| 路径 | category | eventType | decision | 适配价值 |
|---|---|---|---|---|
| 命令进沙箱执行 | `command-safety` | `command-safety.sandbox-executed`（2391） | `allowed` | `commandPreview` 是完整 bash 命令 → **SV601-603 的 exec→bash 源**；沙箱轴 |
| 命令需批准放行 | `approval` | `Bash`（1） | `approved` | 审批轴：asked + decided |
| 命令被用户拒绝 | `rejection` | `Bash`（11） | `rejected` | 审批轴：asked + decided(rejected) |
| 批量删除审批流 | `file-safety` | `file-safety.bulk-delete.{needs-approval,approved,rejected}`（34/28/6） | — | 审批轴；`messageParams` 有 count/threshold/targets |
| 网页抓取 | `network` | `WebFetch`（75） | `allowed` | `messageParams.target`=URL → **SV606 源** |

> **词表漂移事故（2026-09-02 真机核实，分类键必须用 (category, eventType) 对）**：
> 本表早期两行曾写成 `approval.commandApproved` / `rejection.commandRejected`（纸面词），
> 且 evidence 白名单（`KNOWN_EVENT_TYPES`）一度只按 eventType 裸词列
> `sandbox-executed`/`commandApproved`/`bulk-delete.*`——真机零命中，2,471/2,563 条
> 记录全被当 unknown 丢弃（ToolCalls 只剩 WebFetch 的 75 条），差分门禁全绿是因为
> fixture 写的也是纸面词。§14.4 的 schema-drift sentinel 当时照实报了 attempts——
> 哨兵没漏，白名单错了。修复：分类键 = `(category, eventType)` 对（category 是
> WorkBuddy 自己的决策轴，eventType 是轴内路径——命令类是 category 全限定名，
> 审批类是裸工具名 `Bash`）；并加回归断言钉住真机形状（fixture 与单测全部用真机词表，
> 纸面词写进 fixture 就是让门禁测错东西）。账本轮转段标记（17 条，键为
> `entryCount/segment/firstHash/lastHash/fileSha256`，无 category/eventType）不是
> 会话事件，归入 unknown → attempts 哨兵，由文档层解释。

### 2.3 链路完整性：`prevHash→hash` 链

记录按 `sequence` 排序后，`records[i+1].prevHash == records[i].hash` 实测 99.8% 链接连续
（8d4719f0 188/188 全连；少量 seq 跳号来自并发 spool 写）。**最老记录可能被轮转**：
5018bac6 从 seq=1268 起、首条 prevHash 指向不存在的旧链。

适配器的校验职责（§4）：**验证链路连续性**（`prevHash[i+1] == hash[i]`，纯结构校验，
不重算 hash 算法），report `verified_from = 首条记录的 sequence`；首条 prevHash 非空且
匹配不到任何记录 → note「最老记录可能被轮转，链从 seq=N 起验证」——**绝不假定链完整**。
`sha2` 已在二进制依赖里，但结构校验只需要字符串相等，不需要算 hash。

### 2.4 关键口径：audit-log 不是逐请求账本

`credit_json` 的 22 个 requestId 里只有 13（59%）出现在同 session 的 audit-log——其余 41%
的请求没有安全决策（没跑命令/没上网/没批量删除）。**不能拿 audit-log 当请求/轮次计数**，
它只记录安全相关动作。因此 TurnBoundaries 只能按 `requestId` 去重得**下界**（§8）。

## 3. 规则能力矩阵（评审 P0-4 修正版）

判据沿用 §7.4.1：**该信号在本输入里有没有可消费事件**，不是 coverage 计数。
实测结论（memory `workbuddy-data-facts` §13 对账 + 本设计定稿）：

| 规则 | WorkBuddy 判定 | 依据 |
|---|---|---|
| SV601–603（bash 命令族） | **Available** | `command-safety.sandbox-executed` 的 `commandPreview` → bash `args_text`（SV601-603 的 exec→bash 源）。**只覆盖 bash 子集**——其余工具名在 traces 里（E2 起 write/edit 已另列 SV604/605 行，§12.2） |
| SV604（敏感路径 write/edit） | **Available**（E2，2026-09-11） | traces 的 Edit/Write function span 解码后 783/784 带 `file_path` → `tool_calls{name: write/edit, args_text: {"file_path": …}}`，SV604 正则直接跑。回归 `test_sv604_and_sv605_actually_fire_on_span_paths` 钉住 `/etc/harnesses` 命中 critical。降级行已删（§3.1） |
| SV605（write/edit 出 workspace） | **Available**（同上） | 同上；workspace 外路径命中 warning |
| SV606（内网 web_fetch） | **Available** | `WebFetch` 事件 → `tool_name="web_fetch"`、`args_text=messageParams.target`；`_INTERNAL_IP_URL_RE` 直接跑 |
| SV607（拒绝/中止） | **Available**（E2，诚实 MeasuredZero） | function span 的 `status`/`error` → `tool_results{failed, error_code: 原生 status}`。WorkBuddy 的码是 `error`/`cancelled`，**不翻译**成 DSH 的 `FS_SANDBOX_DENIED` 等——规则照跑零命中（Codex `exit_code:N` 同款纪律） |
| SV608（超时） | **Available**（同上） | 无 `TOOL_TIMEOUT` 原生码 → 诚实 MeasuredZero |
| SV609（approval 请求） | **Available** | `commandApproved`/`commandRejected`/`bulk-delete.*` → `approval/asked`（有记录时）；健康会话无审批记录则走 timeline gate 报 Unavailable（§3.2） |
| SV610（危险授权/sandbox） | **Available**（诚实 MeasuredZero） | `sandbox-executed` → SandboxModes 非空，SV610 可跑；但 WorkBuddy 的 `permission_mode` 只有 `bypassPermissions`/`fullAccess` 两值，**不等于 DSH 的 `danger-full-access`**（use_sandbox_cli 恒 1，命令永远进沙箱），词表不翻译 → 诚实 MeasuredZero（§3.3） |
| SV611（重复调用） | **Available** | 在 bash+web_fetch 子集上跑 `(name, args_text)` 去重；audit-log 的 `commandHash`+`commandPreview` 是同一语义的两面（§7） |
| SV612（turn 分组） | **Unavailable** | 无 turn 结构（audit-log 无 turn/step）；turns timeline 恒空，timeline gate 自然给出 |
| SV613(a/b) | **Available**（E2，有 span 时） | requires `[TurnBoundaries, ToolResults]` OR 门控——tool_results 非空即放行；(a) 因 turns 恒空跑不出、(b) 读 tool_results 照跑。无 trace 的会话仍 Unavailable |
| SV614 | **Available** | requires `[ApprovalDecisions, SandboxModes]` OR 门控——audit-log 双轴都在，是 OR 门控的天然输入；健康会话 MeasuredZero（§3.4） |

### 3.1 ~~SV604/605 的执行环境能力降级~~（**已于 E2 移除**，2026-09-11）

> 本节保留作历史。降级的前提「write/edit 只存在于会话匿名的 traces」是 09-02 的分析
> 错误（§12.2）；E2 起 Edit/Write span 折进 tool_calls，`harness_capability.rs` workbuddy
> 行的 `degraded_rules` 清空，`WORKBUDDY_SV604_605_REASON` 常量删除。下文的机制描述
> 对 Claude 的 SV607/608 override 仍成立，对 WorkBuddy 不再适用。


Claude 侧：tool_results 存在但 `error_code` 结构性恒 None → SV607/608 从 MeasuredZero
降级 Unavailable（`degrade_sv607_608`）。WorkBuddy 侧同一形状，对象换成 SV604/605：
**现有实现 join 进来的 tool_calls 只有 bash+web_fetch**（traces 可 join 但未接，§12.2），write/edit 证据只在 traces——
SV604/605 在 WorkBuddy 上「规则照跑零命中」就是假阴性。降级发生在**调度层**
（`agent/workbuddy_session_audit.py::workbuddy_audit_projection` + Rust
`src/agent/workbuddy_session.rs::degrade_sv604_605`），**不进共享求值器**
`canonical_audit.audit_projection` / `match_behavior_canonical`——与 Claude 的 override
同纪律。降级 reason 定稿：

```text
workbuddy harness capability: only bash (audit-log commandPreview) and web_fetch
(WebFetch target) tool calls are joinable to sessions; write/edit tool calls exist
only in session-anonymous traces (file-history has content without paths), so
SV604/605 cannot discriminate
```

> **该字面量已过时**（2026-09-11）：`harness_capability.rs::WORKBUDDY_SV604_605_REASON`
> 的原文被差分与 `test_harness_capability.py` 逐字钉住，本文在历史块中不改用字面量；且
> **Phase E E2 已落地**：SV604/605 转 Available（Edit/Write span → tool_calls），该
> degradation 已被删除——上文对被降级机制的描述不再适用，只保留作历史。

### 3.2 SV609 的三态随会话内容诚实变化

SV609 门控读 `ApprovalDecisions` timeline。audit-log **结构性**承载审批记录（实测
1 commandApproved + 11 commandRejected + 28 bulk-delete.approved），所以 ApprovalDecisions
signal `available=true`；但**具体会话**有没有审批记录决定 SV609 的三态：

- 有审批记录 → SV609 跑 → 有 asked 就出 finding（info）；
- 无审批记录 → approvals timeline 空 → SV609 Unavailable（timeline gate）。

§10 验收的健康会话故意无审批记录（§10.4 数字），审批映射另由 approval-flow 会话钉住（§11.7）。

### 3.3 SV610 的诚实 MeasuredZero（词表不翻译）

DSH 的 `danger-full-access` 语义是「沙箱本身授予无限制访问」。WorkBuddy 的 `permission_mode`
（bypassPermissions/fullAccess）是**审批模式**，且 `use_sandbox_cli` 恒 1（命令永远进沙箱）
——bypassPermissions 也不是 `danger-full-access`。所以 SandboxModes 的 `mode` 直接写
WorkBuddy 原生值（`fullAccess`/`bypassPermissions`），**不翻译成 DSH 词表**；SV610 检查
`mode == "danger-full-access"` 永不命中 → 诚实 MeasuredZero + note。任何「把 fullAccess
映射成 danger-full-access」的改动都是回归（误报）。

### 3.4 SV614 在 WorkBuddy 上可跑

SV614 是 OR 门控（approvals 或 sandbox 任一非空即可跑）。audit-log 双轴都在：
`commandApproved`/`commandRejected`/`bulk-delete.*` → approvals，`sandbox-executed` → sandbox。
所以 SV614 在 WorkBuddy 上**跑得动**：SV614a（同一调用多次请求审批，按 call_id 分组）、
SV614b（连续 ≥3 次拒绝）、SV614c（danger-full-access ≥2）都可用。健康会话 MeasuredZero。

## 4. Provenance 与链路校验（复用 Claude 第一刀，无 core 改动）

Claude 第一刀已把两样东西落进 core，WorkBuddy 直接复用：

1. **`TimelineEntry<T>.provenance`**（evidence.rs）：适配器层类型，兼容桥原样透传。
   WorkBuddy 的 provenance 分配：bash/web_fetch tool_calls、approval/sandbox 决策 = **Measured**
   （audit-log 原生记录）；TurnBoundaries（distinct requestId 去重）= **Derived**（lossy 下界，
   非原生轮次坐标）；无任何 Estimated/Lossy 需要编。Derived 恒 Derived、绝落不进 Measured。
2. **`source_type` 按 `SessionMeta.harness_id` 生成**：`workbuddy_session`，不许落回 dsh 名下。

**链路完整性校验放 evidence 层**（§2.3）：canonical 是执行环境中立的，hash 链信息不进
`CanonicalSession`，而是 `build_workbuddy_evidence` 读 raw audit-log 记录时算，
结果进 `build_notes()` 的 note（`verified_from` / rotation 标注）。Python 与 Rust 必须
算同一条 note（差分逐字节钉住）——但只需要字符串相等，`sha2` 不参与。

## 5. SessionStore 接入面（本阶段不做，后续阶段）

与 Claude §5 同属一个待办：`SessionStore::workbuddy(home)` + `sessions list --harness-kind
workbuddy` + `all()` 合并 + source fingerprint（`~/.workbuddy/workbuddy.db` mtime +
`audit-log/` 目录）等。Claude 的 §11 工作项 7 尚未落地，WorkBuddy 排在其后，本阶段
只做 CLI `workbuddy-session`（§11），不进 SessionStore/Tauri。

## 6. WASM（明确：不重建）

WorkBuddy 不是 DSH audit-tab 的执行环境——DSH tab 消费的是 DSH session 事件（`audit_events`
wasm 直喂 DSH 原始形状）。WorkBuddy 接入**不重建 wasm、不拷 pkg/**，与 Claude 同理由：
计算保持 harness-side，浏览器不解析 WorkBuddy 原始数据（也没有 tab 消费它）。

## 7. 决策映射（audit-log → canonical timeline）

**先定一条不双计纪律**：审批/拒绝记录（`commandApproved`/`commandRejected`/`bulk-delete.*`）
**只进 approvals 轴**；`sandbox-executed` **只进 tool_calls + sandbox 轴**。两条记录之间不
做 join（被批准的命令是否另有 sandbox-executed 记录不可靠）——独立记录各归各轴，同一
`(sessionId, requestId)` 的跨记录不双计（§10 验收 #6）。

| audit-log 记录 | canonical timeline 条目 | provenance |
|---|---|---|
| `command-safety.sandbox-executed`，`commandPreview=C` | ToolCalls：`{name:"bash", args_text:C}`；SandboxModes：`{mode: permission_mode}` | Measured |
| `WebFetch`，`messageParams.target=U` | ToolCalls：`{name:"web_fetch", args_text:U}` | Measured |
| `approval.commandApproved` / `rejection.commandRejected` | approvals：`asked={tool_name:"bash", reason:messageKey}` + `decided={outcome:"allowed-once"|"rejected"}` | Measured |
| `file-safety.bulk-delete.{approved,rejected}` | approvals：`asked={tool_name:"bulk_delete", reason:messageKey}` + `decided={outcome:"allowed-once"|"rejected"}` | Measured |
| `file-safety.bulk-delete.needs-approval` | approvals：`asked`（无 decided） | Measured |

**decision → outcome 映射**：`approved → "allowed-once"`（一次性放行，与 DSH 语义同）、
`rejected → "rejected"`（直译）。`"allowed-once"` 会让 SV610 出 finding——这正是「WorkBuddy
授予了一次性审批」的诚实审计结果；健康会话没有审批记录，SV610 走 sandbox 轴 MeasuredZero
（§3.3）。`bulk-delete.needs-approval` 只有 `asked` 无 `decided` → 只喂 SV609，不喂 SV610/614
的 decided 分支。

**`args_text` 的 bash 例外**：`commandPreview` 是 shell 字符串，直接作 `args_text`（与
DSH/Codex/Claude 的 bash 处理同一形状）；`WebFetch` 的 `args_text = messageParams.target`。
不需要 Claude §7 的 JSON 键序确定性序列化（audit-log 没有 tool_use.input JSON object）——
但 `commandHash` 保留在 raw_records，作为 SV611 语义同一性的旁证（§3）。

## 8. 请求/轮次重建（WorkBuddy 没有 turn 结构）

**TurnBoundaries 只到「请求」粒度，且是下界**：

- audit-log 记录带 `requestId`；一个 requestId ≈ 一次用户请求的决策流。distinct requestId
  = 该会话可观察的请求数下界（41% 的请求没有安全决策、不进 audit-log，§2.4）。
- 按 §3 的矩阵，**turns timeline 保持空**：不把 distinct requestId 硬填成 `TurnObservation`
  ——那会发明 turn 坐标、且 sig 只有 bash 子集（漏非 bash 工具会漏报循环、短 sig 会误报），
  违背「绝不发明不存在的边界」。TurnBoundaries 的 **coverage** 报 derived=N（下界），规则层
  SV612/613 因 turns timeline 空而 Unavailable——这正是
  `empty_timeline_with_nonzero_coverage_is_unavailable_not_measured_zero` 钉住的模式。
- 时间戳缺失/异常 → 该记录不参与 requestId 去重，记为 attempts（§14.4），不 panic。

## 9. 成本部分（执行环境已记账，不重复计价）

> **成本块的当前权威是 [WORKBUDDY_ONBOARDING_SPEC.md](./WORKBUDDY_ONBOARDING_SPEC.md)
> §5（四栏归属）+ §6.1（`cost` 块 6 键契约）。** 本节下面的 `credit_json` = 「执行环境积分
> 账单」这一事实仍然成立；但把积分当人民币显示（旧 `cny` 键）是 Phase A 修掉的 bug，
> 数字口径以 onboarding spec 为准。
> The current authority for the cost block is WORKBUDDY_ONBOARDING_SPEC.md §5 / §6.1;
> `credit_json` is a harness **credit** ledger, and the old `cny` key that rendered credits
> as CNY was a Phase A bug.

**`session_usage.credit_json` = `{requestId: credit}`**（值是平台**积分**，不是货币；键与
audit-log requestId 可 join，实测 13/22）。TOTAL 4,307.76 credit（名义 ¥215.39，按公开
兑换价 1,000 积分 = ¥50 @2026-07-01 折算；现金口径无实付证据）/ 11 会话有 credit，榜首
「分析演示模块重构计划」1,763.88 credit。`used` = token 计数（5018bac6=218256）。模型
分布：deepseek-v4-flash 6 / MiniMax-M3 5 / hy3 4 / auto 4 / MiniMax-M2.5 2。

三条纪律：

- **cost = 逐会话求 `credit_json` 各 requestId 之和**（值可能是数字或数字字符串，适配器
  稳健求和，按厘累计防浮点漂移）。这是执行环境自己的**积分**账单，**不重新做 token × 单价**
  ——不涉及 pricing.json、不长第四份价格拷贝。
- **token（E4a/E5 已接正，spec §9E.5）**：`used` 是**最后一次调用的上下文占用 prompt_tokens
  快照**，不是使用量——traces **有**逐请求四桶（E4a → usage_facts、`cost.processed_tokens` 同源），
  E2 起 Usage 信号 measured 而非曾经的「Unavailable + 刻意不用」。`totalTokens` 不可信，不读
  （§12.2）。
- 输出契约：`workbuddy-session --json` 的顶层加一个 `cost` 键，形状 =
  `{tokens, processed_tokens, credits, cash_cny, nominal_cny, nominal_basis, harness_billed}`
  （**7 键**，E5 起含 `processed_tokens`；键序是字节契约的一部分；`cash_cny` 恒 `null`——
  本机无支付证据，绝不填 0；`processed_tokens` 无 trace 证据时 `null`——不编 0；
  `nominal_cny` = `credits × 0.05` 落名义栏，永不进实付栏/预算分子）。权威定义见
  WORKBUDDY_ONBOARDING_SPEC.md §6.1；旧的 `{tokens, cny, harness_billed}` 三键形状已废弃。

## 10. 验收章节（新增）

1. 原始 WorkBuddy 字段（audit-log 记录/credit_json/commandHash）不得进入 `vitals-core`；
2. WorkBuddy adapter 必须先生成 `CanonicalSession`，走 `canonical_session_to_vitals` 桥；
3. Derived/Lossy provenance 不得变成 Measured（§4 的 `TimelineEntry.provenance` 测试）；
4. unsupported 规则必须 Unavailable，不得 MeasuredZero——**E2 起 unsupported 集合缩为
   SV609（无审批时）/ SV612（turns 恒空）/ 无 trace 会话的 SV607/608/613**；SV604/605
   已 Available（Edit/Write span 带 file_path），SV607/608 有 span 时 Available（原生码
   不翻译 → 诚实 MeasuredZero）——
   SV607/608/609/612/613 由 timeline gate 自然给出，SV604/605 是执行环境能力降级 override（§3.1）；
5. 跨执行环境相同行为产生相同 finding（与 DSH/Codex/Claude fixture 对齐）；
6. 独立记录不双计：审批记录只进 approvals 轴、sandbox-executed 才进 tool_calls 轴（§7）；
7. audit-log 计数是下界（非逐请求账本）；TurnBoundaries derived 下界诚实标注（§8）；
8. hash 链完整性：linkage 校验 + 轮转时 verified-from 标注（§2.3/§4）；
9. cost = credit_json 执行环境积分账单求和（不重复计价），token = `session_usage.used`（§9）；
10. traces 归属只认 `trace.sessionId` 字符串相等（09-11 纠正：可 join，非匿名，§12.2）；**E2/E4 已接**（span 折叠 + usage_facts），无 `sessionId` 键的 trace 计 unattributed（不归属、不简单 0）；**不得**用 prompt 文本里的 UUID 猜 session。

## 11. 接入工作项（依赖序）

1. ~~**rusqlite（bundled）进二进制依赖**~~ **已落地**（§1.4），core crate 不动；
2. ~~core 证据模型~~ —— 无需改动（Claude 第一刀已备齐 provenance + failed）；
3. ~~**`crates/agent-vitals-adapters/src/harnesses/workbuddy/sessions/evidence.rs`**~~ **已落地**：
   `build_workbuddy_evidence`（audit-log → tool_calls/approvals/sandbox timeline +
   TurnBoundaries derived coverage + 链路完整性 note）+ `is_unavailable` +
   `derive_coverage` + `build_notes`。core 单测：
   `approval_records_feed_only_the_approvals_axis`、`rotated_chain_reports_verified_from`、
   `turns_timeline_stays_empty_so_sv612_613_are_unavailable`、
   `mode_stays_workbuddy_native_not_danger_full_access`；
4. ~~**`src/agent/workbuddy_session.rs`**（binary I/O + CLI）~~ **已落地**：rusqlite 读
   `sessions`/`session_usage`、glob `audit-log/*.jsonl` 按 `sessionId` 字段分组、
   file-history 计数；`workbuddy_session_list` / `workbuddy_audit_projection`（core
   `match_behavior_canonical` + `degrade_sv604_605`）/ `workbuddy_session_audit_json`；
   `Cmd::WorkbuddySession` 已进 `src/main.rs` + `pub mod workbuddy_session` 已进
   `src/agent/mod.rs`；
5. ~~**Python 镜像**~~ **已落地**：`adapters/workbuddy_session.py`（I/O，sqlite3 stdlib）+
   `agent/workbuddy_evidence.py`（derive→coverage）+ `agent/workbuddy_session_audit.py`
   （组合 + `workbuddy_audit_projection` + SV604/605 override + `cost` 块 + list）；
   `workbuddy-session` 子命令已进 `scripts/agent_vitals/cli.py`（镜像 claude-session：
   --list / --session（默认最新）/ --json，None → exit 2）；
6. ~~**fixtures/workbuddy/** + `build_workbuddy_fixture.py`（自校验）~~ **已落地**：真实
   sqlite `workbuddy.db` + `audit-log/s1.jsonl`（健康会话）+ `audit-log/s2.jsonl`
   （approval-flow + 轮转链）+ `file-history/s1|s2/`。builder 确定性、自校验钉死
   §10.4 数字（见下）；
7. ~~**tests/test_cli_matrix.py** workbuddy 差分（py==rs 逐字节）~~ **已落地**（六条）：
   `test_workbuddy_session_list_differential`、`test_workbuddy_session_detail_differential`
   （钉死 §10.4 数字 + key 序 + notes 精确串）、`test_workbuddy_session_approval_flow_differential`
   （钉审批映射：approvals timeline 3 条（asked+decided）、SV609 出 3 条 finding、SV610 出
   1 条（allowed-once）、轮转链 verified-from note）、
   `test_workbuddy_session_defaults_to_latest`、`test_workbuddy_session_missing_session_is_tool_error`、
   `test_workbuddy_session_db_only_session_audits_empty_records`；
8. ~~**清单守卫三处**~~ **已落地**：`tests/test_classification.py` `PY_AGENT_FAMILY` 已含
   `workbuddy_evidence`/`workbuddy_session_audit`、`RS_AGENT_FAMILY` 已含 `workbuddy_session`；
   `tests/test_clawhub_packaging.py` `ALLOWED_PACKAGE_FILES` 已含
   `agent/workbuddy_evidence.py`/`agent/workbuddy_session_audit.py`/`adapters/workbuddy_session.py`；
   `.github/workflows/package-clawhub.yml` case-list 已同步（三处逐字一致）；
9. ~~**无 wasm、pricing.json 不动**~~ **已满足**（§6/§9，两侧均未引入 wasm/价表改动）。

**健康会话 s1 的 §10.4 验收数字**（自校验 + 差分都钉死）：

```text
coverage:  ToolCalls measured=5 (bash×2 + web_fetch×1 + E2: edit + write) · ToolResults measured=2 available=true (E2)
           SubagentSpawns measured=1 (E2, agent span)
           TurnBoundaries derived=2 (requestId r1/r2) · ApprovalDecisions available=true measured=0
           ApprovalPolicy measured=1 · SandboxModes measured=2 · NetworkAccess measured=1
           QuotaConsumption measured=2 available=true（B6，credit_json r1/r2；分母不可观测由 note 说明）
           UsageAggregate measured=1 · FileMutations measured=3
rules:     measured_zero = SV601/602/603/604/605/606/607/608/610/611/613/614 (E2)
           unavailable  = SV609/612
           rules_unavailable=2 · findings_total=0
```

## 12. 诚实性注记

1. **audit-log 不是逐请求账本**（13/22 可 join）：一切从 audit-log 来的计数（ToolCalls/
   ApprovalDecisions/SandboxModes/TurnBoundaries）都是**下界**；
2. **traces 可 join——09-02「会话匿名」结论作废**（2026-09-11，独立验收抓出）：
   当时的分析在 **prompt 文本里扫 UUID**，得出「65% 无法归属、能归属的全是内容假阳性」；
   它从未读过 trace 包装对象上的**结构化字段 `trace.sessionId`**——而
   `RUNTIME_EVIDENCE_CONTRACT.md:747` 的 schema 例子里本来就写着它。真机重测（675 文件）：
   **354 个有 `sessionId`，100% 匹配 `sessions.id`，覆盖 22/23 会话，自 2026-07 起就有**
   （不是新加字段）。其余 321 个 `name='Agent workflow'`、无 `sessionId` 键、`metadata:{}`
   ——**E5 纠正：「另一类 0 token」不成立**：`Agent workflow` 是 trace name 不是类；
   `totalTokens` 302/675 为 0 而 span 有 usage，不可信；未归属 generation span 有真实
   用量（E4a 实测 1,202 个记 unattributed）。两条纪律边界不变：**绝不用 prompt 文本里的
   UUID 猜 session**；无 sessionId 的 trace 记 unattributed，不归属不断计。
   **E3（Bash 双源）**：audit-log `toolCallId` 与 span `spanId` 是两套命名空间（0/2,398
   可 join），audit-log sandbox-executed 2,398 条 vs Bash span 1,661 个（traces 轮转丢失
   约 30%），命令文本 59% 相等——**audit-log 是 Bash 唯一源**，span 的 Bash 永不并入
   tool_calls；代价是 Bash 没有 tool_results（status/duration 无键可挂）。
   **教训**：「本机不可观测」必须以读过仓库自己的 schema 文档为前提——这次的
   「结构性不可接」差一点被硬写进 spec，被验收者的一次 live spot-check 拦下；
3. **hash 链最老可能轮转**（5018bac6 从 seq=1268 起）：verified-from 诚实标注，不假定链完整；
4. **TurnBoundaries derived 是 lossy 下界**（distinct requestId，无 turn 结构）：SV612/613 报
   Unavailable，不发明不存在的轮次边界；
5. **ToolCalls 只有 bash+web_fetch 子集可 join——仅限现有实现**：write/edit/subagent/
   duration 证据在 traces 里，而 traces **可**按 `trace.sessionId` 接入（第 2 条）。所以
   SV604/605 的 Unavailable 降级（§3.1）是**当前实现的状态，不是执行环境能力的上限**——
   接入 traces 后（`WORKBUDDY_ONBOARDING_SPEC.md` Phase E）这两条以及 SubagentSpawns、
   工具调用耗时都可能转为 Available。此前写「留待 traces join 落地」，现在这句是对的，
   只是「落地」有了明确的归属键，不再是猜；
6. **cost = credit_json 执行环境积分账单**（不重算价、不动 pricing.json）+ **`used` 是最后一次
   调用上下文快照**（E5）：`tokens` 键保留 used 语义（新注记承担），真正的处理量在
   `cost.processed_tokens`（E4a usage_facts 逐请求源）。
7. **permission_mode 只两值 + use_sandbox_cli 恒 1**：ApprovalPolicy/SandboxModes 保真度低于
   DSH；SV610 的 `danger-full-access` 词表不适用于 WorkBuddy，诚实 MeasuredZero；
8. **`mode` 恒 craft、welcomeMode 会话级配置**（workbuddy.rs 静态层已守不变量 12）：模型/模式
   属性不能写死，逐会话读；
9. **会话/文件会被轮换清理**（file-history 16/22 会话、审计记录从 seq=1268 起）：一切统计都是
   时点值；
10. **`adapters/workbuddy.py` 现只做静态 skill 发现**（marketplace.json 清单，src/skills/
    workbuddy.rs 同构）：会话数据面适配器净新增，不并进静态文件。
