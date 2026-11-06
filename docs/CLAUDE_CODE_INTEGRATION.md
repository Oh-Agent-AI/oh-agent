# Claude Code 执行环境接入：调研结论与适配边界

> 采集 2026-09-01。本机 Claude Code 全部会话 JSONL 实测。
> 关联：[CLAUDE_CODE_CORPUS.md](./CLAUDE_CODE_CORPUS.md)（数据面快照）· [VITALS_CORE_V0_5_IMPLEMENTATION_SPEC.md](./VITALS_CORE_V0_5_IMPLEMENTATION_SPEC.md)（v0.5 架构）· [MENUBAR_MULTIHARNESS_NAVIGATION_SPEC.md](./MENUBAR_MULTIHARNESS_NAVIGATION_SPEC.md)（多执行环境导航）。
> 状态：**调研结论 + 适配器已落地**（2026-09-02 更新）。数据面证据已实测（2026-09-01 二次
> 抽查修正：日期轴原生、事件类型 12 种、usage 富字段、tool_result 三态——见 §2）；接入层级、
> 规则能力矩阵、provenance、SessionStore、WASM 五个问题已定案（P0 修正版）；§7 工具名规范化
> 与 §8 turn 重建状态机已**实现并验证**（§11 工作项 1/2/5，`claude_code_evidence.rs` /
> `claude_evidence.py` + 三份 leaf fixture 差分钉住，见 §10/§11）。§4 的
> `TimelineEntry.provenance` + `source_type` 按 harness 生成、§3 的 `ToolResultObservation.failed`
> 已实现进 `agent-vitals-core`（core 单测 + golden 差分 15/15 全绿，输出字节不变，见 §4）。
> 评审结论：v0.5 通用 Core 不修改的方向**成立**。§5 SessionStore 接入已**落地**（2026-09-02，
> §11 工作项 7/8，见 §5——三源并行 `all()`、`source_statuses["claude-code"]` 三态、
> workbench 会话 tab 执行环境 chip）；仅剩 §9 成本部分（§11 工作项 6，需价表）与 menubar
> 导航第三执行环境行（MENUBAR spec 自证两行，另行跟进）。

## 0. 结论

Claude Code 接入**不需要修改通用 `vitals-core`**——这一条成立。但「只是一个适配器
工作量」不成立：至少还涉及 `agent-vitals-core` 证据模型（provenance）、SessionStore
（r2a 统一数据入口）和 Tauri/WASM 接入。

正确层级（§1 代码验证）：

```text
Claude JSONL
→ ClaudeEvidence {          ← 与 codex_evidence.rs / dsh_evidence.rs 同层
    canonical: CanonicalSession,
    raw_records
  }
→ compatibility/canonical_session.rs::canonical_session_to_vitals()
→ CanonicalEvent → Detector
```

**不要写 `session.jsonl → CanonicalEvent` 直连**——那会绕开五条通用 timeline、
Coverage 三态、SourceAttempt、Session metadata 与既有兼容测试路径（§1.1）。

## 1. 现有链路（代码验证，2026-09-01）

### 1.1 真实接入路径

`crates/agent-vitals-core/src/compatibility/canonical_session.rs:97`
`canonical_session_to_vitals(&CanonicalSession) -> Vec<CanonicalEvent>` 是唯一合法的
CanonicalSession → CanonicalEvent 桥。Claude 适配器必须先产出 `CanonicalSession`，
走这条桥，**不新增第二条桥**。

### 1.2 证据适配器范式（Claude 的挂载层）

`dsh_evidence.rs:355 DshEvidence` / `:498 build_dsh_evidence` / `:546 reverse_project`
是既有范式：适配器持有 `canonical + raw_records`，`build_*` 产出、`reverse_project`
回吐原始形状。`codex_evidence.rs` 同层。Claude 新增 `ClaudeEvidence`（§11 工作项 2）
与这两者同构。

### 1.3 TrajectoryAssigner 的职责边界（评审 P0-2，已验证）

`vitals-core/src/trajectory.rs:86-89`：

```rust
pub trait TrajectoryAssigner: Send + Sync {
    fn id(&self) -> &str;
    fn assign(&self, event: &CanonicalEvent) -> Result<TrajectoryId, VitalsError>;
}
```

它只把 `CanonicalEvent → TrajectoryId`，**不修改事件、不写 `vitals.turn`**。Claude 的
branch linearization、turn 重建、step 计算、tool call/result 关联必须在**适配器的
derive 阶段**完成并写进 `CanonicalSession` timeline，再由 §8.4.1 纪律（坐标是事件属性）
经桥带进 `attributes`。TrajectoryAssigner 不是 turn 状态机的挂载点。

### 1.4 SignalVocabulary 不需要 Claude 专属词表（评审 P0-3，已验证）

现有 Detector 不止靠词表门控，还**硬编码检查** kind 与 attributes 键，例如
`sv607.rs:36` `attributes.get("error_code")`、`sv607.rs:48` kind `"approval.denied_result"`。
注册 `claude.assistant → agent.tool_call` 这类映射会让门控放行但 Detector 忽略事件。

正确方式：适配器统一输出**已有 canonical kinds**：

```text
Bash tool_use  → agent.tool_call（tool_name="bash"）
tool_result    → agent.tool_result
derived turn   → agent.turn
```

通常**不需要新增 Claude 专属词表**，复用领域词表即可。

## 2. Claude Code 数据面（实测 2026-09-01）

### 2.1 语料口径（评审指出的数字矛盾，必须分别标明）

| 数字 | 值 | 口径 |
|---|---|---|
| corpus 全语料 | 130 文件 / 47,837 assistant 请求 | `CLAUDE_CODE_CORPUS.md` 采集日快照（全家族） |
| corpus minimax 家族 | 2,958 请求（M2.7 1,155 + M3 1,803） | 同上，**仅 minimax 家族**，不是总量 |
| 本次结构抽查 | 51 会话 / 125,803 事件 | 2026-09-01 walk，事件含 assistant/user/attachment 等全部类型 |
| 本次 minimax 复现 | 16 文件 / 1,705 请求 | 2026-09-01 walk，仅**仍存在**的文件 |

早前会话 65633310/8b85e949/dcf9e5b6 已被清理——Claude Code 会话会轮换删除，
任何会话文件统计都是时点值（§9.1）。**以上四行不可互比，引用时须带采集时间与范围。**

### 2.2 session.jsonl 事件类型（51 会话抽样，实测 13 种）

| 类型 | 数量 | 对适配的价值 |
|---|---:|---|
| `assistant` | 41,754 | `message.model` + `message.usage` —— 用量/成本源；`error`/`isApiErrorMessage`/`quotaLimits` 是 assistant **顶层字段**（70/90/20），不是独立事件类型 |
| `user` | 21,296 | 含 `tool_result` 块（19,437 个）；**无 tool_result 的纯文本 user = 新 turn 根**（§8 问 4） |
| `attachment` | 21,073 | `deferred_tools_delta` —— 工具名清单 |
| `permission-mode` | 6,024 | **仅模式快照** `{permissionMode, sessionId}`，无逐次审批 |
| `mode` | 未逐类计数 | 权限模式事件——复核结论（适配器落地时）：`mode` 在已知类型里但不喂任何信号（§13 Claude 列无对应项）；`permission-mode` 喂 `ApprovalPolicy` measured |
| `file-history-snapshot` / `file-history-delta` | 未逐类计数 | 文件内容快照/差异——`FileMutations` 信号候选 |
| `last-prompt` / `ai-title` / `atis-latch` | 未逐类计数 | 会话元数据更新，无审计价值 |
| `queue-operation` | 未逐类计数 | Continue 排队操作，无 uuid |
| `system` | 未逐类计数 | 系统事件，无 uuid |
| `cost-state` | 未逐类计数（12/51 会话文件有——新客户端随压缩点/会话结束写入） | **账单真值**（§9.3 的 fold 基线）：`{type, totalCostUSD, startTime, modelUsage:{模型:{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD}}, hasUnknownModelCost}`。`modelUsage` camelCase、与 `message.usage` 的 snake 桶一一对应（§2.4）。`costUSD` 对网关模型按默认卡计、高估 20–70×，**只能当官方等效价参照**（§9.3）；`totalCostUSD` 与 `~/.claude.json::projects.*.lastCost` 同源。同一会话压缩后仍累积保留 |

**计数只标已逐类的；未逐类的不编列（缺列不编列）。** `uuid`/`parentUuid` 树只出现在
`user`/`attachment`/`assistant` 三类上——其余事件无 uuid，是附属信号不是 turn 树成员（§2.3）。

### 2.3 结构事实（三态矩阵锚点）

- **`tool_result` 块 = `{content, is_error, tool_use_id, type}`，无 `exit_code` 数值**：
  `is_error` 是布尔，本次实测三态——`true`×3 / `false`×37 / **键缺失**×18。true 只证明
  「失败了」、不证明原因：译成 `failed=true`（lossy），`error_code` 保持 None，绝不伪造
  一个码（§3 的 SV607/608 Unavailable 判定因此站得住）。
- **时间轴原生**：`user`/`assistant`/`attachment` 事件恒带 ISO-8601 `timestamp`
  （实测 342/342）。**`CLAUDE_CODE_CORPUS.md` §1 的「无日期字段、不编」已被推翻**——
  `date_first`/`date_last`、date 过滤、按天聚合全部原生可做，不做是自废。无 uuid 的事件
  （mode 等）同样带时间戳。
- **`permission-mode` = `{type, permissionMode, sessionId}`**：模式切换快照，无逐次审批。
- **无 provider 字段、无 turn/step**：全事件无结构化端点/provider 字段；turn 需从
  `uuid`/`parentUuid` 树重建。
- **`uuid`/`parentUuid` 树 + `tool_use_id`**：工具调用有唯一 ID，可关联 call/result。
  树**只在 `user`/`attachment`/`assistant` 三类事件上**（§2.2），turn 重建（§8）只消费
  这三类。

### 2.4 usage 富字段

| 字段 | 本次实测 | 价值 |
|---|---|---|
| `output_tokens_details.thinking_tokens` | M2.7: **91% 非零**（max 488，中位 34）；M3: 19% 非零（max 3,102）；deepseek-*: **恒 0**；claude-opus/sonnet-5: 非零（max 1,889/7,870） | reasoning 维度 |
| `cache_creation.ephemeral_1h/5m` | 本次 16 文件几乎全无（仅 13 条 cc>0 无分桶） | Anthropic 式缓存分档 |
| `server_tool_use` | `{web_search_requests, web_fetch_requests}` | 服务端工具计数 |

**assistant 事件承载完整 usage**（本次 126/126 条完整）：四桶 + `output_tokens_details.thinking_tokens` +
`cache_creation.ephemeral_1h|5m` 子桶 + `server_tool_use` + `service_tier`/`inference_geo`/
`iterations`/`speed`。两个必守的桶纪律：

- **计数键名两形（2026-09-02 勘误）**：本表上两行记的短键（`input`/`cache_creation_input`/
  `cache_read_input`/`output`）来自 09-01 语料；claude-sync 的 fold 目标语料里 assistant
  usage 是 **API 全形键**（`input_tokens`/`cache_read_input_tokens`/
  `cache_creation_input_tokens`/`output_tokens`）。claude_cost.rs 的 `SNAKE_KEYS`（全形，
  真机 100%）是计数键唯一真源、`SHORT_KEYS`（短键）兜旧客户端语料——**两态都认**
  （wide-in），两态皆无 → 不计 + 哨兵，不硬猜。cost-state 的 `modelUsage` 是 camelCase
  （`inputTokens`/`outputTokens`/`cacheReadInputTokens`/`cacheCreationInputTokens`），
  fold 读时只做 camel→snake 键名映射后走**同一条** `price_claude_map` 计价，不重算。

- **缓存桶是「父标量 + 子桶」**：实测 15844 = ephemeral_1h 15844 + ephemeral_5m 0——父字段
  与子桶**不得重复计费**。usage.rs 的 `usage_sample` 判据（CLAUDE.md「wide in, narrow out」）
  认这个形状：宽入窄出，机器先捞、人再归类。
- **四模型家族（claude/deepseek/minimax/kimi）是四个互不贯通的缓存宇宙**：同一文件的缓存
  命中只能按家族内对比，混合家族文件是结构性事实（51 文件中 17 个含多家族）——跨家族加总
  缓存金额没有意义。

**MiniMax thinking 是会话级配置，不是模型恒定**：M3 跨文件 0%~55% 差异
（6145a051=19%、agent-a652=55%、agent-a17a=0%）——不能写死模型属性。

## 3. 规则能力矩阵（评审 P0-4 修正版）

判据沿用 §7.4.1：**该信号在本输入里有没有可消费事件**，不是 coverage 计数。

| 规则 | Claude Code 判定 | 依据 |
|---|---|---|
| SV601–606（工具名族） | **Available** | 前提：工具名+参数规范化（§7）；`tool_use` 块结构化 |
| SV607（拒绝/中止/sandbox denied） | **Unavailable** | `is_error=true` 证明失败，不能证明**失败原因**；SV607 只匹配 `DENIED_CODES`（sv607.rs:2）。把一切失败伪造成一个错误码 → SV607/608 错误地 MeasuredZero |
| SV608（超时） | **Unavailable** | 只匹配 `error_code == "TOOL_TIMEOUT"`（sv608.rs:2），is_error 不含超时类型 |
| SV609（approval） | **Unavailable** | `permission-mode` 仅模式快照，无逐次审批 |
| SV610（sandbox） | **Unavailable** | 无结构化 sandbox 策略事件 |
| SV611（重复调用） | **Available** | 比较 `(name, args_text)`，非 `tool_use_id`；工具名+参数稳定规范化后即跑 |
| SV612（turn 分组） | **Derived/Partial** | 依赖 turn 重建状态机（§8）；重建不出的维度降级 |
| SV613(a)（第一个 error turn） | **Derived/Partial** | 依赖可靠推导 error turn |
| SV613(b)（连续工具失败） | **Lossy/Partial** | 可用 `is_error` 部分运行（轨迹级 `error_code.is_some()` 逻辑，trajectory.rs:402） |
| SV614 | **Unavailable** | approval + sandbox 两侧皆缺 |

### SV607/608 的模型修正（评审 P0-4，已落地）

`ToolResultObservation` 已有 `error_code: Option<String>`，本轮**补上 `failed: Option<bool>`**
（2026-09-01 第一刀，属 `agent-vitals-core` 领域证据层，不动通用 `vitals-core`）：

```rust
pub struct ToolResultObservation {
    pub failed: Option<bool>,      // 通用失败检测（SV613(b) 用）
    pub error_code: Option<String>, // 原因级检测（SV607/608 用）
}
```

- `failed` 服务通用失败（is_error → failed=true，provenance=lossy）；**现有 DSH/Codex 适配器
  一律设 `None`**——它们的失败信息在 `error_code` 里（`exit_code:N`/`error`），不重复造信号；
  Claude 适配器已填：`is_error` 三态 → `Some(bool)`（键存在 = lossy、键缺失 = measured，
  `claude_code_evidence.rs:236-243`）。
- `error_code` 服务拒绝/超时原因级——Claude 无来源时保持 `None`，**绝不伪造一个码**。
- 兼容桥把 `failed` 原样投影进 `CanonicalEvent.attributes`（与 `error_code` 并列），
  SV613(b) 的 lossy 路径读得到；core 单测 `tool_result_failed_flag_carries_through_bridge` 钉住。

## 4. Provenance 缺口（评审 P0-5，第一刀已落地）

文档此前要求「is_error 翻译标 lossy、turn 重建标 derived」——此前结构兑现不了，两个缺口
本轮（2026-09-01 第一刀）都已修复：

1. **`TimelineEntry<T>` 补 `provenance: Provenance`**（evidence.rs，适配器层类型），兼容桥
   原样透传。映射是**保真的**：`evidence::Provenance`（`&'static str`，每事件热路省分配）
   → `vitals_core::provenance::Provenance`（`String`/`Vec<SignalId>`，公开模型）——Derived
   恒 Derived、Estimated 恒 Estimated，**绝落不进 Measured**。
2. **`source_type` 改为按 `SessionMeta.harness_id` 生成**，不再硬编码 `"dsh_session"`：
   `dsh_session` / `codex_session` / `claude_code_session`，未登记执行环境走 `{harness}_session`
   通用形状，一律不许落回 dsh 名下。

```rust
pub struct TimelineEntry<T> {
    pub observation: T,
    pub provenance: Provenance,   // 已加，桥接时透传
    // existing coordinates...
}
```

回归由三条 core 单测钉住（都过）：
- `source_type_follows_harness_id_not_hardcoded_dsh`——codex 输入 → `codex_session`，非 dsh；
- `derived_provenance_passes_through_not_as_measured`——Derived 过桥不降级 Measured；
- `tool_result_failed_flag_carries_through_bridge`——`failed` 随桥进 attributes。

DSH/Codex 现有输入全部 Measured，输出字节不变（golden 差分 15/15 一致，Python↔Rust）。

## 5. SessionStore 接入面（此前完全缺席；**已落地 2026-09-02**）

`src/agent/r2a_store.rs` 曾对 Codex/DSH **硬编码分发**（`codex_cache_path`/
`dsh_cache_path`、`codex_source_fingerprints`/`dsh_source_fingerprints`、`source_statuses`
均按执行环境写死）。已接入 Claude（本计划的「第三源」）：

- `SessionStore::claude_code(home)` + `sessions list --harness-kind claude-code` ✅
- `sessions read` 接受 Claude `SessionKey`（渲染走 pretty JSON，不落 codex HTML 渲染器）✅
- `SessionStore::all()` 三源并行合并（`thread::scope` 三 spawn；sort_key 字典序 →
  claude-code 在合并列表最前；`source_statuses` 键序 `{claude-code, codex, dsh}` 稳定）✅
- Claude source fingerprint（`~/.claude/projects/**/*.jsonl`）+ 缓存 revision
  （`cache/r2a/claude-sessions.json` v2，增量重建与 codex 同构）✅
- `source_statuses["claude-code"]` **DSH 式三态**（files 空 → ok/0 诚实零；built>0 →
  ok；files>0 但 built==0 → unavailable，CLI 报类型化错误码而非空页，§4.3 同款）✅
- list/read/filter/pagination 测试（`tests/test_r2a.py` ClaudePopulation/Reconciliation
  E2E + `tests/test_cli_matrix.py` 差分，py==rs 逐字节，含 cache 共享双方向）✅
- Workbench harness filter（`src-tauri/ui/workbench.html` chips 全部/Claude Code/DSH/Codex）
  ✅；menubar 导航保持两执行环境（MENUBAR spec 自证两行，另行跟进）

**source registry 不抽（follow-up）**：本次保持 list/read 显式三臂（各 3 行，diff 最小），
registry 抽取等第四执行环境出现再做——刚写完的 codex 镜像不重构，避免两件事互相污染。

## 6. WASM 复用修正（评审 P0-5）

`agent-vitals-wasm::audit_events(events_json, workspace_root)`（lib.rs:21）接收的是
**DSH 原始事件形状**（`Vec<Value>` 直喂 `match_behavior`），**不是通用
`CanonicalEvent`**——Claude 原始 JSONL 不能直接传给它。

推荐架构：

```text
Tauri Rust backend
→ Claude source/parser → unified SessionEnvelope
→ WebView 只负责显示
```

计算保持 harness-side（repo 纪律：计算在执行环境侧，浏览器只读投影）。若要浏览器侧纯计算，
须新增**明确的 canonical WASM API**，不是让 JS 再实现一套 Claude parser。

## 7. 工具名规范化（设计草案，2026-09-01 定稿）

| Claude 原始值 | canonical name | 备注 |
|---|---|---|
| `Bash` | `bash` | `args_text` = `input.command`（shell 字符串），与 DSH/Codex 的 bash 处理同一形状 |
| `Write` | `write` | |
| `Edit` | `edit` | `MultiEdit` 并入 `edit`——SV611 会把同一语义拆成两个名字识别成不同调用 |
| `MultiEdit` | `edit` | 同上 |
| `Read` | `read` | |
| `Glob` | `glob` | |
| `Grep` | `grep` | |
| `WebFetch` | `web_fetch` | |
| `WebSearch` | `web_search` | |
| `Task` | `task` | 子代理；**不下降**——子代理活动在独立 session 文件，Task 在本文件里只是一次 tool call |
| `TodoWrite` | `todo_write` | |
| `NotebookEdit` | `notebook_edit` | |

- **不做这层映射，SV601–606 不会命中**（现有规则用小写名字，sv601-606 测试为证）。
- **`args_text` 确定性序列化**：`tool_use.input` 是 JSON object，按 key 递归排序后压缩
  序列化（参考 `canonical_string`，vitals-core/canonical.rs:36）——否则 SV611 把键序不同、
  语义相同的参数识别成不同调用。Bash 例外：直接取 `input.command` 字符串。
- 规范化发生在**适配器 derive 阶段**（§1.3 的 TrajectoryAssigner 边界），不是 Detector 里；
  映射表已随适配器落地（§11 工作项 5，`normalize_tool_name`，core 单测钉住）。

## 8. turn 重建状态机（2026-09-01 定稿设计，已实现验证）

`parentUuid` 树**不等于** turn，但 uuid 树只出现在 `user`/`attachment`/`assistant` 三类
事件上（§2.3），且每个真 root 是 `parentUuid=null` 的 user 事件。八问的草案答案：

1. **当前有效 leaf path**：维护「当前 leaf」= 最近一条 user-root 的 uuid 链；新 root
   （parentUuid=null 的 user）到达即切链。多 leaf 并列时选最近被扩展（max timestamp）的
   那个；非主干分支一律 Derived。
2. **abandoned branch 排除**：是。未被后续事件扩展、且已被更新 root 接替的分支，标
   `isSidechain=true` 不进 turn 边界——SV612 的 turn 分组只认主干。
3. **root/orphan/cycle**：user 事件 parentUuid=null = 新 turn 根；parentUuid 指向不存在的
   uuid（截断/清理后的孤儿）→ 归入当前 open turn，无 open turn 时起一个合成 turn（Derived）。
   append-only JSONL 父恒先于子，cycle 结构性不存在——见到即按孤儿处理，不 panic。
4. **human prompt vs tool_result user**：看 `message.content`。含 `tool_result` 块的 user 是
   当前工具循环的续写（**不是**新 turn）；纯文本/image 是新的 human prompt → turn 根。
5. **assistant 连续消息**：同属一个 turn——turn 内按 tool_use 边界或事件序切 step，不切
   turn。turn 边界 = 纯文本 user-root 或 EOF。
6. **子代理**：Task 的 tool_use 是一次调用，子代理活动在独立 session 文件（独立 uuid）——
   本文件不下降，turn 树里只留一条 tool call。
7. **未结束 turn**：EOF 兜底 flush——最后一个 open turn 在文件尾关闭，end 坐标 = 最后一条
   事件 timestamp；时间戳缺失（按 §2.3 不应发生）end=None。
8. **重建失败**：逐 turn 判。主干链完好的 turn 计 Measured；孤儿/歧义 turn 计 Derived
   （就近根启发）；整文件无 user-root（截断文件）→ 整个 TurnBoundaries **Unavailable**
   （沿用 evidence.rs 的 `timeline_is_empty` gate）。**绝不发明不存在的边界。**

**已实现验证**：SV612/613(a) 在重建出的 turn 上跑（Derived/Partial——turn 是合成的，不是
原生坐标）；重建失败逐 turn 判，整文件无 user-root（截断文件）→ TurnBoundaries **Unavailable**
（`timeline_is_empty` gate，绝不发明不存在的边界）。状态机按 §1.3 的纪律实现在适配器 derive
阶段（写进 `CanonicalSession.turns`），不挂 TrajectoryAssigner。

## 9. 成本部分（收紧）

### 9.1 provider 判定三类（设计 → 落地映射）

`ANTHROPIC_BASE_URL` 只证明**当前配置**，不证明历史会话当时的 provider；
`claude-* + cache_creation>0` 也可能来自兼容代理。定价依据分三类，**本方案按此落地**：

| 设计类 | 语义 | 落地 |
|---|---|---|
| observed-route | 明确路由 → 精确价 | DSH 既有 state 折叠（today.json/month.json，¥ 实付估算）——主账单，`pricing_basis` 恒 exact（core cost.rs，DSH 字节钉死） |
| inferred-provider | 模型+缓存推断 → 标估算 | Claude 账 fold 的计价面：core `resolve_card_catalog` 按模型族命中 `catalog_2026_09` 官方卡（deepseek→providers ¥ 卡、claude-*→anthropic USD、MiniMax→CNY、moonshot→USD），report 的 `pricing_basis="catalog"`、per_model 带 `priced_with` provider 与 `currency`，全量标「按模型族官方卡折算的估算，不是账单」（`estimate_disclaimer`） |
| unknown-provider | 无法可靠归属 → 不出价 | `<synthetic>` 等未知模型 → 4 型 token 全进 `unpriced_tokens`（不丢不零）；币种只可能是 USD/CNY，真第三种落进来会静默混进 CNY——加新币种时改 `price_claude_map` 的分桶 |

**推断金额不得与明确路由金额混成同一精度**：DSH 精确账与 Claude catalog 估在托盘
账卡里**分列**（`今日按量成本：¥A` DSH 实 + ` · Claude 估 ≈¥B/≈$C` 后缀），两币
分开不混加，预算/alert 只对 DSH。

### 9.2 计数规则（落地后逐条验证）

- `thinking_tokens` 是否已含在 `output_tokens` 中：**fold 不碰它**——Claude 账只数
  `SNAKE_KEYS` 4 型（input/cache_read/cache_creation/output），thinking 既不加也不
  从 output 里剔（§2.4 该问题留作展示层未来项，不影响账单桶）；
- `ephemeral_5m/1h` 是 `cache_creation` 的**子桶**，不能与父字段重复计费：fold 只计
  `cache_creation_input_tokens` 父标量，子桶不读；
- catalog 卡平费率（无 DSH 的 peak/off-peak 时段拆分），`price_flat` 按模型类型 ×
  单价累加，无时段轴；MiniMax tiers 按会话输入总量选 ≤512K 档（v1，行归属超档
  `[1M]` 等变体走记录在案的近似）。

### 9.3 Claude 账 fold（cost-state 基线 + 行尾增量，落地 2026-09-02）

「Claude Code 的钱从未被计量」的缺口由独立数据面补上（D4：不动 month.json/状态链
不变量）。实现三件套：`claude-sync` CLI（`src/agent/claude_cost.rs` ↔
`scripts/agent_vitals/agent/claude_cost.py` 逐字节镜像，`tests/test_claude_cost.py`
`both()` 差分看守）、`state/claude-fold.json` checkpoint、逐日 ledger。

- **成本-state = 账单真值**：随压缩点/会话结束写入、同一会话压缩后仍累积。逐行
  `message.usage` 求和**必然漏**（压缩掉的 cache read 在行里零可见）——某会话
  cost-state 全模型合计 16.9M、行里只有 77%～78%。所以 fold 以**最后一条 cost-state
  的 modelUsage** 为会话基线，基线后行尾增量补；无 cost-state 的老会话 = 纯行和
  （标 partial）。
- **append-only 尾读**：每会话一 checkpoint（session_id → {offset, mtime, size}），
  只解析新行；size/mtime 指纹决定 skip / 尾读续折 / 整份重折替换。折完全部会话后
  **从 checkpoint 全量重建** ledger（重建天然幂等——崩溃重跑不双计；2026-08 的
  month.json 三倍计数事故明确是增量累加的温床，claude 账不复刻）。
- **日界**：assistant 行带 ISO-8601 timestamp → 北京日（UTC+8，`day_from_iso_ts`
  从字符串直算不经过 epoch——真机 100% 定宽 Z 格式）；cost-state 基线没有日界，
  折到会话 `startTime` 日（v1 已文档化近似）。会话删除**不清** ledger（按日键控
  无尸害——语料是时点值，会话轮换删除会让任何会话文件统计都过期）。
- **ledger 形状**：`claude-ledger.json` = `{days: {"YYYY-MM-DD": {模型: 4 型 snake
  tokens}}}` **flat 直图**（只有 token，价格会变、token 不会——DSH month.json 同
  一条纪律，钱在 `claude_day_cost` 读时才算）。只装当前北京月；跨月日滚动进
  `claude-ledger-archive.json`（`{"months": {"YYYY-MM": {"days": …}}}`，逐日替换
  幂等）。缺账日 = 没测到（托盘 null/—，不编 0）；当日存在但全零 → Some(0)「测到
  0」不是「没测」。
- **消费方**：core `claude_day_cost`/`claude_session_cost` 同源计价（同一
  `price_claude_map`，日面 flat/包一层两形都认、cost-state 面只做 camel→snake 键名
  映射）；托盘账卡分列读 `claude_today`/`claude_month`；`sessions navigation` 的
  claude-code 执行环境行 `today_tokens` basis=ledger（MENUBAR spec §5.2）。

## 10. 验收章节（新增）

1. 原始 Claude 字段不得进入 `vitals-core`；
2. Claude adapter 必须先生成 `CanonicalSession`，走 `canonical_session_to_vitals` 桥；
3. Derived/Lossy provenance 不得变成 Measured（§4 的 `TimelineEntry.provenance` 测试）；
4. unsupported 规则（SV607/608/609/610/614）必须 Unavailable，不得 MeasuredZero；
5. 跨执行环境相同行为产生相同 finding（Claude 与 DSH/Codex fixture 对齐——`dangerous.jsonl`
   的 `rm -rf` 与 codex paginated 夹具产出同 evidence/severity/call_id 形状）；
6. 每个 leaf-path 与 all-recorded 形状分别有 fixture（`fixtures/claude/` 三份——
   `healthy.jsonl` = healthy leaf、`dangerous.jsonl` = finding leaf、
   `all-recorded.jsonl` = full-shape leaf；「leaf」= 刻意狭窄的会话，只走映射表的
   一条路径，改动停了那条路径就响亮失败，而不是静默改掉验收数字）；
7. SessionStore list/read/all/filter/cursor 通过（§5）；
8. Tauri 不解析 Claude 原始日志（§6 架构）；
9. usage/cache/thinking 各桶可以对账（§9.2 不重复计数）；
10. provider 不确定时不得生成伪精确价格（§9.1）。

## 11. 接入工作项（依赖序）

1. ~~**turn 重建状态机实现**（§8 草案已定，待实现验证）——一切 Derived 判定的前置~~ **已落地**
   （`claude_code_evidence.rs` / `claude_evidence.py`，判据是内容不是 `parentUuid`，
   `is_error_three_state_maps_to_failed_with_honest_provenance` 等 core 单测钉住）；
2. ~~`ClaudeEvidence` 适配器：Claude JSONL → `CanonicalSession`（tool_use/tool_result/
   parentUuid → timeline；turn/step 由 §8 状态机算出）~~ **已落地**（core `claude_code_evidence.rs`
   + binary `claude_session.rs` + Python 镜像 `adapters/claude_session.py` /
   `agent/claude_evidence.py` / `agent/claude_session_audit.py`，`claude-session` CLI）；
3. ~~`TimelineEntry.provenance` 字段 + 桥透传 + `source_type` 按 harness_id 生成~~ **已落地**
   （2026-09-01 第一刀，core 单测 + golden 差分 15/15 全绿，输出字节不变，见 §4）；
4. ~~`ToolResultObservation.failed` 字段 + SV613(b) 的 lossy 路径改读 `failed`~~ **已落地**
   （见 §3：is_error 三态 → `Some(bool)`；DSH/Codex 的 `failed` 恒 None，布尔式退化成原判据，
   真值表见 `claude_code_evidence.rs`，golden 字节零漂移）；
5. ~~工具名规范化表 + `args_text` 确定性序列化（§7 定稿，落地随适配器）~~ **已落地**
   （`normalize_tool_name` / `canonical_string`，`args_text_is_deterministic_regardless_of_key_order`
   等 core 单测钉住）；
6. ~~pricing.json 补 MiniMax/claude 官方价（业务数据，需价表；§9）~~ **已落地**
   （2026-09-02 `catalog_2026_09`：anthropic 三卡 USD + MiniMax 两卡 CNY + moonshot
   kimi-k3 USD + deepseek providers 兜底，语料模型全覆盖；pricing.json 零改动延续，
   卡被 core `resolve_card_catalog` 消费，见 §9.1）；
7. ~~SessionStore：`claude_code(home)` + source registry 抽取（§5）~~ **已落地**
   （2026-09-02：第三源全弧线——`SessionStore::claude_code` + payload `files` 键 +
   `claude_source_statuses` 三态 + `all()` 三源并行 + roots 报告，Rust/Python 锁步，
   `tests/test_r2a.py` + `tests/test_cli_matrix.py` 差分逐字节；source registry **不抽**——
   list/read 保持显式三臂，第四执行环境出现时再做，见 §5）；
8. ~~Tauri/workbench 消费（§6 架构，计算 harness-side）~~ **已落地**（2026-09-02：工作台
   会话 tab 三执行环境 chips + 会话列表/详情/Findings 页消费 claude 源，wasm 零改动——
   claude 源只在 CLI/r2a 面；menubar 导航第三执行环境行按 MENUBAR spec 另行跟进）；
9. ~~验收 10 条 + fixtures 入库~~ **已落地**（`fixtures/claude/` 三份 leaf 夹具——
   `healthy.jsonl` / `dangerous.jsonl` / `all-recorded.jsonl`，`build_claude_fixture.py`
   自校验钉死 §10 验收 #4/#5/#6 数字；`tests/test_cli_matrix.py` `test_claude_session_*`
   八条差分，py==rs 逐字节；证据层验收 #1–6 已覆盖，#7–10 属 SessionStore/Tauri/cost
   后续阶段）；
10. ~~Claude Code 成本数据面（claude-sync + ledger + catalog 计价）~~ **已落地**
    （2026-09-02：`claude-sync`（`src/agent/claude_cost.rs` ↔
    `scripts/agent_vitals/agent/claude_cost.py`）cost-state 基线 + 行尾增量 fold →
    `state/claude-fold.json` checkpoint + `claude-ledger.json`/`claude-ledger-archive.json`
    逐日账，`tests/test_claude_cost.py` both() 差分逐字节；core `resolve_card_catalog`/
    `claude_day_cost`/`claude_session_cost` 计价，见 §9）；
11. ~~托盘账卡分列 + 导航第三执行环境行~~ **已落地**（2026-09-02：托盘 today/month 行挂
    ` · Claude 估 ≈¥/≈$` 后缀（read_overview 增读 ledger → Overview claude_today/
    claude_month），预算 alert 保持 DSH-only；`sessions navigation` 第三执行环境行
    claude-code（today_tokens basis=ledger）+ HarnessesSnapshot 兜底三行，见 MENUBAR spec；
    tick 顺序 DSH fold → `claude-sync`，SyncStatus 失败留痕不 abort）。

## 12. 诚实性注记

1. **会话会轮换删除**：可复现语料（1,705 请求）< corpus 快照（2,958）——钱行是下界；
2. **turn 重建是近似**：parentUuid 推断非原生坐标，重建不出报 Unavailable；
3. **is_error ≠ error_code**：只做 `failed`（lossy），不伪造原因码；
4. **thinking 是配置性**：逐请求读 `output_tokens_details.thinking_tokens`；
5. **`adapters/claude.py` 现只做静态配置证据**（enabledPlugins/skillUsage），会话数据面
   适配器净新增；
6. **§7/§8 的草案已随适配器实现并验证**（`claude_code_evidence.rs` / `claude_evidence.py`，
   三份 leaf fixture + 八条差分测试钉住）；§9 成本部分已随 claude-sync 落地并验证
   （§9.1 三分类落地映射 + §9.3 fold，`tests/test_claude_cost.py` + `test_catalog_pricing.py`
   差分钉住）——价表与对账不再缺口。
7. **Claude 估的钱是「按官方卡折算的估算」不是账单**：catalog 无 provider 路由证据，
   网关模型价差 20–70×（cost-state 的默认卡 costUSD 高估量级同源），托盘挂 `≈`/「估」
   标签、不与 DSH 实付混加、预算只对 DSH——三条诚实性由 `claude_est_suffix` 与
   DSH-only alert 的执行面保证。
8. **语料是时点值**：会话文件轮换删除——ledger 是「扫描时刻看到的会话」的下界，
   与 corpus 快照（CLAUDE_CODE_CORPUS.md）同一条纪律；会话删除不清 ledger，跨月日
   靠 ledger-archive 按月滚动而非删除。
