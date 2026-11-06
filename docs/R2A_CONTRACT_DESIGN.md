# R2a 最小可查询 SessionStore + 版本化契约 · 纯契约设计

> 状态：**契约设计稿**（2026-08-30）。服务于 `docs/TAURI_RUNTIME_WORKBENCH_SPEC.md`
> §8 R2a 的实现，只定义「数据来源、查询模型与版本化 IPC」的契约，不写任何实现。
> 与 `docs/R2A_SOURCE_CAPABILITY.md`（真实语料能力表）配套：本文件引用的所有
> 数字/结论以那份文档为准，不重复实测。
>
> 本文件是**纯契约**：不碰 `src/`、`crates/`、`src-tauri/`、`scripts/`、`tests/`；
> 只回答「SessionKey 怎么定、SessionReport 怎么封装、SessionStore 怎么查询、谁写
> state 谁写 cache、adapter 接口长什么样、initial population 先扫谁、跟 R1 的写链
> 怎么不打架」七个问题。
>
> 标注约定：每个设计点后跟依据（`spec §` / `capability §` / adapter 字段路径）；
> 无直接依据、基于代码/既有结论的推论标 **「推断」**。
>
> 术语与 `TAURI_RUNTIME_WORKBENCH_SPEC.md` 保持一致：`SessionKey`、`SourceFingerprint`、
> `SessionRevision`、`StoreRevision`、`SchemaVersion/EngineVersion/PricingVersion`、
> `NormalizedEvidence`、`schema-mismatch/Unavailable`、writer fencing、app cache。

---

## 1. SessionKey 逐源身份映射

### 1.1 为什么是四元组而不是裸 `session_id`

`spec §4.3` 把会话身份定义为 **`SessionKey` = harness kind + harness-native id + source
profile / machine namespace**。裸 `session_id` 会在两种情况下把同一逻辑会话数成两笔
成本：① 不同执行环境/不同机器上 id 恰好相同（App Server 回退 rollout、重连接管时）；
② 同一台机器上**续接会话**——Codex 续接会话写新文件但保留原逻辑 `session_id`
（`codex-corpus-facts` 实测 51% 文件名 UUID ≠ 逻辑 session_id）。所以去重的权威键
必须是四元组，其中 native id 分量对 Codex 是**逻辑 session_id 而非文件名**。

`SessionKey` 序列化形状（**推断**，键序建议固定以便字节对账）：

```json
{ "harness_kind": "codex", "native_id": "<逻辑 session_id>",
  "source_profile": "/repo, /data", "machine_namespace": "<uuid>" }
```

- `harness_kind` + `native_id` 已足以在同一 namespace 内去重；`source_profile` 与
  `machine_namespace` 负责把「跨工作区同名」「跨机器同名」的碰撞拆开
  （`spec §4.3`：只用执行环境 `session_id` 会在不同执行环境/机器上碰撞）。
- **machine namespace 是隐私边界**（`spec §4.3`）：直接 hash 用户名/路径会把可识别
  信息稳定泄漏到导出，所以必须是「可重放派生、持久在 app 自有 config 的随机 UUID」。

### 1.2 Codex 源身份表

| 分量 | 值 / 规则 | 依据 |
|---|---|---|
| harness kind | `codex`（`canonical.meta.harness_id` 实测 = `codex`） | `capability §5` |
| native id 字段 | `session_meta.payload.session_id`（缺时退回 `payload.id`） | `codex_session.py:60-75` / `codex_session.rs:60-64`；`capability §5` |
| 规范化 | 字符串原样；键存在但值非 string → 不取（Rust 与 Python 都用 `as_str` 门）；`session_id` 与 `id` 双缺 → 该 rollout 无法归入任何 SessionKey | `codex_session.py:104-109`；**推断**双缺处理 |
| source profile | `workspace_roots`（`turn_context.payload.workspace_roots` **最新非空**一条）——「当前工作区」惯例，与 dsh 的 last_catalog_wins 同款 | `codex_session.py:72` / `codex_session.rs:64`；`capability §5` |
| alias join key | **无去重 alias**。续接文件共享同一 `session_id` 本身就是 join 键（跨文件 resume 按 `session_id` 合并，`src/main.rs:1175`）；`session_index` 的 `id→thread_name` 是**标题查询**（`codex_session.py:237-270`），参与展示、不参与去重 | adapter 字段路径；`capability §3.2-5` |
| 缺场行为 | `archived_sessions` 根缺席 → `exists=false` 零填充，**不是 0 条真数据**（存在性探测，`codex_session_roots_report`）；`session_index.jsonl` 缺失 → 空映射，标题为 `null`（诚实缺失，`codex_session.py:273-288`） | adapter 字段路径；`capability §3.1` |
| 碰撞处理 | 同名 `session_id` 出现在多个 rollout 文件（续接）→ **并成一个 SessionKey**，折叠按文件家族合并；**绝不按文件名去重**（否则 51% 续接会话被数成两笔） | `capability §1.1/§4-5`；`codex-corpus-facts` |

**Codex 51% 去重结论（必须写死）**：`capability §1.1` 实测 55 会话中 28/55（51%）
文件名 UUID ≠ `session_meta.payload.session_id`——续接会话写新文件、保留原逻辑 id。
去重键 = `session_id`（逻辑会话），绝不能用 rollout 文件名。这正是「断线→回退→重连
无重复」fixture 要断言的事：同一逻辑会话跨多文件，token/成本不翻倍。

### 1.3 DSH 源身份表

| 分量 | 值 / 规则 | 依据 |
|---|---|---|
| harness kind | `dsh` | `capability §5` |
| native id 字段 | 头行 `id` = `session-<uuid>`（UUID 语义、全局唯一）；**目录名 ≠ header id 是常态**——实测 `~/.dsh/sessions/<project>/<id>/` 的会话目录名**混着裸 UUID 与 `session-<uuid>` 前缀**，discovery/join 必须读头行 `id`，不能用目录名当 id。此处修正 `capability §1.2` 的「目录名==id（58/58）」说法 | 实测事实（2026-08-30）；`dsh.rs` 头行字段 |
| 规范化 | 字符串原样；header `type=="session"` 且 `version` 为整数 0（bool 显式排除）才认 | `dsh.py:139-149` / `dsh.rs:104-115` |
| source profile | project 目录名 = 头行 `cwd` 的路径清洗：`/`→`-` 并包 `--`（实测如 `--Users-Admin-projects-project-skill-vitals--`）；58 个 zstd 会话分布 deepseek-harness 3 / investment-research-team 20 / skill-vitals 32 / dsh-article 3 | 实测事实（2026-08-30）；`capability §1.2/§5` |
| alias join key | **无 alias 需求**：header `id` 是 UUID、全局唯一，本身可验证；但**目录名不可作 id**（实测混着裸 UUID 与 `session-` 前缀），join 一律以头行 `id` 为准，不需要时间/路径猜测 | 实测事实（2026-08-30）；`spec §4.3`（alias 只在有可验证 join key 时归一） |
| 缺场行为 | `$DSH_HOME` 未设 → 默认 `~/.dsh/sessions`；project 目录缺席 → 存在性探测，不报错 | `capability §1.2`；adapter 注释 |
| 碰撞处理 | 目录名不可作 id（实测不一致是常态）；同一 header `id` 出现多份 → 按 id 归一；**不按目录名猜测合并** | 实测事实（2026-08-30）；`spec §4.3`（alias 无证据显示「可能重复」也不猜） |

子代理 `subagentSpawns` 的 `call_id`↔`agent_id` join 是**父子会话关系**，不是同一
会话的 alias——`capability §5` 明说「非本表范围」，不参与 SessionKey 去重。

### 1.4 machine namespace 契约

`spec §4.3` 原文：「machine namespace 是可重放派生的、持久在 app 自有 config 的随机
UUID（可备份/迁移，默认不导出）：每次安装随机生成会让重装/恢复 cache 后同一日志变新
会话；直接 hash 用户名/路径会把可识别信息稳定泄漏到导出。重装丢失时明示为「新
profile」，不静默重排历史。」

契约要点：

1. **生成**：随机 UUID，写入 Tauri app 自有 config（`spec §4.3`「持久在 app 自有
   config」）。两源（Codex/DSH）共用同一个 namespace——它标识「这台机器」而不是
   「这个源」（`capability §3.2-3`：两源都还缺这个分量，R2a 需新增）。
2. **可重放派生**：同一台机器重装后，从备份/迁移的 config 恢复 → 同一 UUID → 同一
   历史不被重排；config 丢失 → 生成新 UUID，UI 明示「新 profile」，**不把旧会话静默
   并入新 profile**（`spec §4.3`）。
3. **默认不导出**：`safe-share` 导出时 machine namespace 不在 allowlist
   （`spec §5.4` 两态导出；§4.3「默认不导出」）。`source_profile`（Codex
   `workspace_roots` 实测含本机绝对路径）同理不在默认导出集——**推断**，导出字段表
   在 R2b 的 keep/drop/transform 表里钉死。
4. **fixture 对账时的确定性**：冻结 fixture 对账（`spec §8 R2a`）需要在 Python、
   Rust core/CLI、wasm+DSH 三侧对同一 raw fixture 得到同一 SessionKey——测试环境注入
   固定 `machine_namespace`，生产从 app config 读。**推断**：注入点由测试 harness
   控制，不改变生产读取路径。

### 1.5 强类型 revision 四件套（不复用一个字段）

`spec §4.3` 列出四个互不混用的 revision 类型。R2a 契约逐一定义：

| 类型 | 语义 | R2a 具体化 |
|---|---|---|
| `SourceFingerprint` | **不透明、仅相等比较**的源文件指纹；无顺序 | **推断**组成 = `(size, mtime_ns, 首/尾 N 字节)` 或等价不透明串；契约只要求「相等 ⇒ 内容未变」这一条，不要求可排序。用于 cache 失效判断（源文件截断/替换时重建，`spec §5.2`） |
| `SessionRevision` | **每会话单调**；`session-updated`/`read_session`/export 只用它 | Codex = 该会话 rollout 家族内最大事件 `timestamp`（`capability §2`，每条事件都带 ISO 时间戳）；DSH = 最大 `seq`/`time`（`capability §2`）。**因为从源内容派生，重启后自然持久**（重算得同一值），不需要单独 epoch |
| `StoreRevision` | **每 Store 查询快照单调**；分页 cursor 绑定它 + filter hash | Store 内存中的全局写序号；重启后归零（新 epoch），旧 cursor 失效（见 §3.5）。**不随无关会话更新 bump**（见 §3.3「不误拒」设计） |
| `SchemaVersion`/`EngineVersion`/`PricingVersion` | 语义见 `spec §4.2` 兼容矩阵 | 见 §2.2 |

「重启后 revision 是持久还是换 epoch」的结论：**`SessionRevision` 持久**（派生自源，
重算即得）；**`StoreRevision` 换 epoch**（内存态，重启归零）。据此，
`session-updated` 事件的 revision 是 `SessionRevision`（跨重启可比）；分页 cursor 的
`StoreRevision` 跨重启失效 → 客户端必须重新拉 page 0（`spec §5.4` 类型化错误码
`stale-revision` 兜底）。

### 1.6 跨来源同一逻辑会话不双计的验收锚点

`spec §8 R2a` 验收：「跨来源同一逻辑会话不被数成两笔成本」。契约上的落实：

- Codex：按 `session_id`（非文件名）去重 + 续接文件家族合并（§1.2）。
- DSH：header id 全局唯一（§1.3），天然无双计路径。
- 跨来源（同一逻辑会话在 Codex 与 DSH 各有一份）**不合并**——harness_kind 不同即不同
  SessionKey；这是两套独立观测账本（`spec §4.3` 源优先级/接管状态机，App Server
  live 优先、rollout 回放补洞），R2a 不跨源归一。fixture 断言的是「**同源内**断线→
  回退→重连无重复」，不是「跨源合并」。

---

## 2. versioned DTO envelope（§5.4）

### 2.1 envelope 形状

`spec §5.4`：所有 DTO 包 versioned envelope——`schema_version`、`store_revision`、
`generated_at`、`source_statuses`；稳定排序 + cursor 分页。`SessionReport` 在其上
加会话身份与修订（**推断**组合，字段名全部沿用既有输出，不发明）：

```json
{
  "schema_version": "1",
  "engine_version": "<core 规则版本>",
  "pricing_version": "<pricing.json 版本>",
  "store_revision": 123,
  "generated_at": "ISO8601",
  "source_statuses": { "codex": { "status": "ok", "roots": [...], "last_success": "...", "degraded": null },
                       "dsh":   { "status": "source-unavailable", "reason": "unsupported-compression", ... } },
  "session_key": { "harness_kind": "codex", "native_id": "...", "source_profile": "...", "machine_namespace": "<uuid>" },
  "session_revision": "<派生自源的最大 timestamp/seq>",
  "session": { ... }
}
```

- `source_statuses` 的形状（**推断**）对应 `spec §3.2`「数据源状态」只读页：每源给
  根发现存在性、最后成功时间、schema 版本、降级状态。**逐文件降级汇总进这里，绝不
  把单个文件降级当 0 条真数据**（`capability §4-3`）。
- `session` 载荷 = 现有 CLI 输出的并集，按源分形状（§2.4），**不再发明字段名**。

### 2.2 版本矩阵（contract / engine / pricing 各自 min/max + 字段进化）

`spec §4.2`：「`contract_version`（wire 形态）、`engine_version`（规则版本）、
`pricing_version`（价表版本）各自定义语义与最低/最高支持范围；字段进化规则为
『只增不改，删除需新 major』。」

| 版本 | 语义 | 最低 | 最高 | 进化规则 |
|---|---|---|---|---|
| `contract_version` | wire 形状：envelope + `session` 里存在哪些字段 | 本次 R2a 首发 = `1` | 当前实现支持的最高 major | **只增不改**：加字段 → 兼容（minor）；改/删字段 → 新 major |
| `engine_version` | core 规则版本：findings/coverage 三态语义 | core 的版本化规则集 | 同左 | 规则语义变更 → 新版本；老版本报告的 finding 不得按新语义解释 |
| `pricing_version` | 价表版本：`pricing.json` 的快照 | 源价表 | 同左 | 价是**业务数据不是规则**（CLAUDE.md：价表变更不走 golden `--update`） |

「各自 min/max」的落点：**每个 DTO 携带 `contract_version`；引擎与价表版本进
`source_statuses` 或 `session` 的 provenance 区**（推断位置）。读取方按
`contract_version` 决定字段解析；按 `engine_version`/`pricing_version` 决定「这份
报告能不能按当前语义用」。DSH 原生投影路径下这三个版本就是 wasm 投影携带的
`contract_version`/`engine_version`/`pricing_version`（`spec §4.2` DSH 两条合法
路径之一）。

### 2.3 不兼容行为（N±1 fixture + 独立升级顺序测试）

`spec §4.2`：不兼容时只能二选一——

1. **有原始事件** → 用本地 core 重算（不显示旧语义，不默认为空）；
2. **无原始事件** → 显示 `schema-mismatch / Unavailable`，**不得默认为空或沿用旧
   语义**。

`spec §8 R2a` 要求用 **N-1/N/N+1 投影 fixture** 钉住：同一 raw fixture 分别经
`contract_version = N-1 / N / N+1` 的投影生成报告，断言：

- N 对 N-1：**向后兼容**——旧字段仍在，N 多出的字段不影响旧字段值；
- N 对 N+1：**新 major 的删除/改型**必须在 envelope 层被识别为
  `schema-mismatch`，不得静默降级；
- **独立升级顺序测试**：直接 N-1 → N+1（跳过中间 major）必须报不兼容，不能「碰巧
  字段还叫这名字就放行」。

对 DSH，`contract_version` 不兼容 → 若有原始 `.zstd`/`.jsonl` 事件 → 本地 core 重算
（`spec §4.2` 优先级 2）；`.zstd` 未落地前连原始事件都读不了 → `source-unavailable`
（§4.3），谈不上 schema-mismatch——两者错误码语义要分清。

### 2.4 SessionReport 字段语义（不发明新字段名）

`session` 载荷按源复用既有 CLI/HTML 的字段名（`spec §4.2`「core 是唯一纯规则计算」、
CLAUDE.md「别发明新字段名」）：

- **Codex**：复用 `codex-session --html` 的 `codex_session_audit_json` 形状
  （`scripts/agent_vitals/templates/codex_session.html`）：`session_id`、`title`（可
  null，`capability §3.2-5`）、`model`、`cli_version`、`history_mode`、
  `workspace_roots`、`date_span`、`files`、`effort`、`context_window`、`cost_report`
  （`total_cost_usd` / `per_model` / `total_tokens` 五桶 / `unpriced_tokens` /
  `unaccounted_usage` / `hours` / `plan`）、`coverage`、`audit`（`summary` /
  `findings` / `rule_outcomes`）、`quota_trajectory`、`permission_transitions`、
  `turn_timeline`、`turn_ends`、`tool_output_bytes`。
- **DSH**：复用 `behavior --json` 的会话级输出（`src/agent/behavior.rs`）：
  `findings`、多路 `*_coverage`（`usage/duration/skill/subagents/compaction/waste`）、
  `cost`、`duration`。客户端 `AuditReportView`（`dsh-client/src/client/components/
  audit/types.ts`）已定义这些字段的 TS 形状，直接消费同一 versioned DTO
  （`spec §6` TauriAdapter 路线）。
- **覆盖三态**：`Measured / Unmetered / Unavailable` 只在 core 判定，adapter 不得
  直接声明（`spec §4.2` NormalizedEvidence + core 独占）；**任何界面都不把
  Unavailable 显示为零**（`spec §8 R2b` 验收）。
- **金额**：`Money DTO` = `{amount, currency, pricing_basis, estimated}`；聚合一律
  `by_currency` map，禁止默认跨币种求和（`spec §4.2` 约束 5）。`cost_report` 里的
  `total_cost_usd` 是 Codex 侧既有单币种字段，保留；跨源聚合时按 by_currency 分组。
- **残差哨兵**：`unaccounted_usage` 原样透传（CLAUDE.md——折叠层每层都报它，读侧
  不得丢弃）。

### 2.5 Page\<SessionSummary\>（list_sessions 列表项）

`spec §5.4`：会话列表可无界增长，一次返回整数组会撑爆 IPC/WebView 内存 → 必须
cursor 分页。`SessionSummary` 字段（**推断**，全部来自既有字段）：

```json
{ "session_key": {...}, "session_revision": "...", "title": "… | null",
  "harness_kind": "codex", "model": "…", "date_span": {"first": "...", "last": "..."},
  "files": 3, "cost_usd": 1.23, "tokens_total": 45678, "findings_total": 2 }
```

- `title` **必须可 null**：Codex 标题命中率 87% 不是 100%（`capability §3.2-5`），
  13% 会话无标题 → 诚实缺失，不是数据坏了。
- 稳定排序 = `(harness_kind, native_id)` 的字典序（**推断**，需全局稳定以便分页 cursor
  定位）。

---

## 3. SessionStore 查询模型 + 写权边界（§5.2）

### 3.1 内存只读索引 + 可删除 app cache

- `spec §5.2`：cursor / checkpoint / index 存 **Tauri 自有、可删除**的 cache 目录
  （带 schema / engine / source-fingerprint 版本），**严禁写入 `~/.agent-vitals/
  state` 的权威文件**。
- SessionStore = **内存只读查询模型**（`spec §4.2` 管线图）：持有规范化后的
  `SessionReport` 只读索引，供 IPC / HTML 导出 / 状态栏摘要消费。R3 验收锚点：
  **删除 cache 只影响性能，不改变最终字节输出**（`spec §5.2` / §8 R3）——所以 cache
  里的一切都是可重建的 memo，不是唯一真相。
- cache 目录需与 state 目录**严格分开**（`state.py::cache_dir` 的既有惯例：可重建
  派生 memo 不进用户可读 state，避免 `list_state_files` 被污染）。Tauri app cache
  沿用同一分界，落在 Tauri 的 app data 目录（**推断**，具体路径 R2a 实现时定，原则
  是「不在 `state_dir()` 下」）。

### 3.2 写权边界：谁写 state vs 谁写 cache，与 writer fencing 不冲突

`spec §4.2` 数据产出责任矩阵：`oneline.json / today.json / month.json(+archive) /
alert.json / sessions.jsonl / calendar.html` 唯一写者 = Python `oneline`
（R1c/R1d 后迁移为 Rust 写链）；`dsh_autosync.json` 唯一写者 = `dsh_autosync.py`；
**Tauri app cache（cursor / checkpoint / index）= Tauri 自有**，可删除、非权威。

**为什么不和 writer fencing 打架**：`spec §4.2` 唯一写者接管协议（shadow / writer
fencing / 原子 cutover / 可测 rollback）治理的是**权威 state 文件的写者**——
`writer_epoch`/`owner` manifest 让 Python 与 Rust 都拒绝非当前 owner 写入。SessionStore
**从不写权威 state 文件**（它只写自己 cache 目录里的 cursor/checkpoint/index），
所以：

- 它不在 fencing 的写者集合里，不参与 `writer_epoch` 竞争；
- 它的 cache 是可删除 memo（§3.1），即便崩溃残留，删除后重扫即重建，不影响最终字节
  输出 → 不需要 fencing 级别的互斥（fencing 防的是「同一会话被两个 writer 依次累加
  两次」；cache 重建是幂等全量 fold，不累加）；
- 反过来，SessionStore **读**权威 state 时只当读者（`spec §4.2` 矩阵「Tauri 角色 =
  只读」），遵循「读最后有效 generation」（`current-snapshot.json` manifest 指针，
  `spec §4.2` 约束 6）——它不得绕过 manifest 拼装多文件快照。

一句话：**state 的写权被 fencing 垄断，cache 的写权归 Store 自己，两套写权互不重叠**
——这就是「Store 消费 R1 的 writer 模型却不制造第二写者」的论证。

### 3.3 IPC 签名草案（list_sessions / read_session / 类型化错误码）

`spec §5.4` 原文签名，R2a 只实现前两个查询命令（`export_session_html` 属 R2b）：

```text
invoke("list_sessions", filter, cursor)                -> Page<SessionSummary[]>
invoke("read_session", session_key, revision)          -> SessionReport
```

- `list_sessions`：`filter` = 按执行环境/日期/模型/会话筛选（`spec §3.2`）；`cursor` 携带
  `(store_revision, filter_hash, last_key)`。返回 `Page { items, next_cursor | null,
  total, store_revision }`。稳定排序 + cursor 分页（§2.5）。
- `read_session`：`session_key` 定位，`revision` 是 **`SessionRevision`**（派生自源，
  持久可比）。调用方可要求指定 revision；缺省返回当前。`revision` 冲突 → `stale-revision`
  （见 §3.5 导出冻结的同类机制）。
- **类型化错误码**（`spec §5.4`）：`not-found` / `permission` / `stale-revision` /
  `schema-mismatch` / `source-unavailable` / `cancelled`。**禁止用「空数组/空字符串」
  同时表达「无会话」与「源无权限/协议不兼容」**——`list_sessions` 的
  `source-unavailable` 是错误码，不是空页；「诚实空」（真的 0 个会话）才是空页。
- **并发顺序**（`spec §5.4`）：`session-updated` 事件只带 `{session_key, revision}`；
  前端忽略低于当前 revision 的响应，能取消被新筛选替代的请求（旧请求晚到不覆盖新 UI）。
- **分页期间其他会话更新不误拒**：`StoreRevision` 不能是「任何更新都 bump」的全局
  计数，否则翻页途中无关会话 append 会让下一页误报 `stale-revision`。设计（**推断**）：
  每个 filter 维护一个**派生 revision**（= 该 filter 命中的会话集合的最新变更版本），
  与 filter 无关的会话更新不 bump 它 → 分页 cursor 校验通过；只有命中集自身变化才
  使 cursor 失效。`spec §4.3`「测试『分页期间其他会话更新』不误拒」即此。

### 3.4 checkpoint/cursor/fingerprint 仅 turn 边界

`spec §5.2` + CLAUDE.md：`UsageFoldState` 只保证 turn 边界恢复，同一 `(turn, step)`
的 `last` 去重槽不序列化；中途 checkpoint 会重复计费。R2a 契约：

- **只有已验证的 turn 边界才持久 checkpoint**；活跃 turn 保留可重放尾部，每次
  append 从最后边界重 fold；无法识别边界则全量回退（`spec §5.2`）。
- **先例**：`usage_fold_resume(checkpoint@k, events[k..n]) == fold(events[0..n])` 对任意
  **turn 边界** k 成立（CLAUDE.md，Rust `usage_fold_resume_equals_full_fold_at_turn_boundaries`
  + Python `tests/test_resumability.py`）。`last` 同 step 去重槽**故意不在 checkpoint**
  里——resume 后缀从 turn 边界开始，其首个 usage 事件是新 turn，不会与前缀末
  `(turn, step)` 碰撞。R2a 的 checkpoint 序列化沿用同一不变量，不得「扩展序列化覆盖
  所有去重状态」——那必须先在 Python↔Rust 字节差分 + wasm 回放中通过才改规格
  （`spec §5.2` 原话，反过来不行）。
- **按源落点**：
  - DSH：turn 边界 = `turn/end` 事件（`dsh.py` 的 `EXECUTION_EVENT_TYPES` 含
    `turn/start·turn/end·step/start·step/end`）。checkpoint 只能在 `turn/end` 之后；
    活跃 turn 内不做增量 checkpoint，append 从最后 `turn/end` 重 fold。
  - Codex：**没有 turn 边界**（`capability §2`：Codex 无逐 turn 行为信号，时间线是
    「逐小时 token 曲线」）。R2a **不承诺 Codex 字节级增量 checkpoint**——每个 rollout
    文件全量 fold、以文件为原子单位；跨文件 resume 按 `session_id` 家族合并（§1.2）。
    R3 若做 Codex 字节 offset tail（cc-trace `ScanFileState.offset_bytes` 模型），须先
    证明其去重语义等价于「从最后验证边界重 fold」（`VITE_DESIGN_LESSONS.md` 纪律：
    先证明 `fold_resume(checkpoint, appended) == fold(all)`），并把「文件内无 turn 边界」
    显式映射到「全量重 fold」约束上。
- **DSH 增量多帧压缩：帧边界是比 turn 边界更细的天然 resume 点**（实测事实
  2026-08-30）：DSH 会话文件是**增量多帧 zstd**——每 flush 一批事件就把新一帧
  zstd **追加**到同一文件（真机实测：4MB 文件 = 6694 帧、882KB 文件 = 2090 帧；
  首帧仅 ~207 字节 ≈ 1 行事件；个别 4 帧大块疑似 compaction/导入）。每帧是**独立
  自洽的压缩 JSONL 块**、帧间无跨帧状态 → **帧边界是天然增量 resume 点**（帧索引
  尾随、只解新增帧），比 turn 边界更细、比 Codex 整段 jsonl 更适合增量。这与
  「checkpoint 仅 turn 边界」的保守设计构成对照：**turn 边界是语义正确性底线**
  （usage fold 的去重槽语义），**帧边界是物理增量粒度**；R2a 仍以 turn 边界承诺
  正确性（§4.2「是否全量读」），帧边界留作 R3 增量 tail 候选（§4.4）。
- **fingerprint 与 checkpoint 的关系**：`SourceFingerprint`（§1.5）用于 checkpoint
  失效判断——源文件截断/替换（指纹不等）→ 该源的 checkpoint 作废、全量重建
  （`spec §5.2`「源文件截断/替换时的重建规则」）。

### 3.5 cursor 失效与安全回退全量 fold

`spec §8 R2a` 验收：「cursor 失效时安全回退全量 fold」。契约：

1. 分页 cursor（`StoreRevision` + filter hash）失效 → `stale-revision`，客户端重拉
   page 0（§3.3）。
2. 增量 fold 的 checkpoint 失效（fingerprint 不匹配 / 找不到 turn 边界 / cache 被删）
   → **全量回退**：从头 fold，不增量。全量回退是幂等的（同一 raw 事件 → 同一 fold
   结果），所以「cache 被删不影响最终字节输出」成立。
3. 兜底（`spec §5.3`）：目录重扫 1–5 分钟，修复漏掉的文件事件——它不是正确性来源，
   cursor/字节谓词/幂等 fold/周期 rescan 才是（`spec §9` 风险表）。

---

## 4. source adapter 接口

### 4.1 接口形状（五段式，adapter 不产出计算）

`docs/RUNTIME_EVIDENCE_CONTRACT.md` §4.2 定义五段式：**locate → shape → extract →
derive → coverage**。I/O 在 adapter（locate/shape/extract），derive/coverage 在 core。
`spec §4.2` 重画管线：SourceReader → HarnessNormalizer → core → versioned SessionReport →
SessionStore。adapter 只做**词汇/schema 转换**，产出 `NormalizedEvidence`：

```json
{ "events": [...], "observed_signals": [...],
  "unsupported_signals": [...], "usage_shaped_unparsed": [...] }
```

（`spec §4.2` 原形状）。**coverage 三态归属只有 core**——adapter 不得把「读不到」
提前翻成 0 再让 core 对假 0 忠实地算。R2a 的 adapter 接口契约 = 每个源实现
locate（根发现）+ shape（逐行解析→规范化事件）+ extract（provenance + 事件流），
derive/coverage 全走 core。

### 4.2 per-source capability 表引用

| 维度 | Codex | DSH | 依据 |
|---|---|---|---|
| 根发现路径 | `~/.codex/sessions/YYYY/MM/DD/` + `archived_sessions/`；**adapter 已实现** `codex_session_roots_report`（Python+Rust 锁步） | `$DSH_HOME/sessions/<项目清洗>/<会话id>/session.jsonl[.zstd]`（项目目录名=`/`→`-` 包 `--`）；会话→工作区/标题/归档查 `$DSH_HOME/storages/workspace.json`（§4.5）；**adapter 只有 env 单文件注入**（`AGENT_VITALS_DSH_SESSION_LOG`），根发现是 R2a 缺口 | `capability §2`；实测事实（2026-08-30） |
| 支持格式 | 明文 append-only JSONL，无版本闸（兼容 shim 演进） | 裸 `.jsonl`（当前仅此）；`.zstd` 多帧只有 `dsh_autosync.py`/`dsh-client` 能解，Rust/核心 crate 无 zstd 依赖 | `capability §1.2/§3.2-1` |
| 是否全量读 | 是 | 是（R2a 全量读；增量多帧压缩使**帧边界**天然支持增量 tail——实测事实 2026-08-30，见 §3.4/§4.4，R3 候选） | `capability §2`；实测事实（2026-08-30） |
| 无权限/损坏行为 | 存在性探测 + 逐文件降级 | 同左；对 `.zstd` 目前**误报 `non-json`**（不诚实） | `capability §2` |
| 资源上限 | 544.4MB / 55 会话；Python 全量 ~75s，Rust 更快；单文件最坏 210.6MB | 215.8MB 明文 / 58 会话；解压+解析 18.2s | `capability §1.1/§1.2` |

### 4.3 诚实降级路径（`source-unavailable` 而非 0 会话）

- **逐文件降级原样透传**（`capability §4-3`）：`missing-header` / `non-json` /
  `file-missing` / `schema-version-mismatch`（DSH，版本必须整数 0）——
  汇总进 `source_statuses`，**绝不把单个文件降级当 0 条真数据**。
- **`.zstd` → `unsupported-compression`，不是 `non-json`**（`capability §3.2-4`）：
  当前 `dsh.py`/`dsh.rs` 把 zstd 原始字节当 UTF-8 读、报 `non-json`——这是「reader 不
  认识格式」被说成「日志坏了」。R2a 契约：adapter 显式识别 `.zstd` 后缀并给
  `unsupported-compression`（或在 zstd crate 落地后直接解压，见 §6.3-1），不能再沿用
  `non-json`。
- **根缺席**（Codex archived / DSH project 目录）→ 存在性探测 `exists=false` 零填充，
  不猜路径、不把缺席当 0 条真数据（`codex_session_roots_report` 的既有铁律）。
- **DSH zstd 落地前**：整个 DSH 源显示 `source-unavailable`（`capability §4-2`），
  **不得显示 0 会话**——这正是 `spec §5.4`「禁止用空数组同时表达『无会话』与『源
  不可用』」的实例。

### 4.4 revision 判定

- **Codex**：`SessionRevision` = 文件内最大事件 `timestamp`（ISO，每条事件都带）
  （`capability §2`）。新文件 = 新会话或续接；append = 新事件。
- **DSH**：`SessionRevision` = 最大 `seq`/`time`（`capability §2`，seq 单调不减，样本
  首 0 / 末 16201）。新 zstd 帧 = 追加。**写入即增量多帧压缩**（实测事实 2026-08-30，
  §3.4）：活跃会话文件持续增长、每次 flush 追加一帧 → revision 判定随帧追加**单调
  前进**（最大 seq/time 只增不减），与「每帧独立自洽」的增量读取模型天然一致。
- 增量场景（R3）：Codex 字节偏移 tail 可行（明文 append-only）；DSH 走「全量重解 +
  按 seq 差分」或「帧边界跟踪」，**不承诺未证明的 offset tail**（`capability §2` 末行
  实测：对最大文件尾部 2MB naive 解压报 frame header 错误——正是增量多帧结构所致：
  naive `[offset:]` tail 从帧中间起解、帧头非法，需按帧边界 seek，见 §3.4）。

### 4.5 DSH storages/：会话索引/缓存层（实测事实 2026-08-30）

`~/.dsh/storages/` 是 DSH 的**会话索引/缓存层，不是会话日志本体**（日志本体在
`~/.dsh/sessions/`）。R2a 的 discovery 与 `list_sessions` 要区分对待：

| 文件 | 实测 | 用途与契约 |
|---|---|---|
| `storages/workspace.json` | 2.5KB | workspace id → 路径 + 标题 + `sessionIds[]`，带 `archivedSessionIds`（实测 2 个已归档）。**这是 DSH 侧的 `session_index` 等价物**——对应 Codex 侧 `session_index.jsonl` 的标题/归档查询（`codex_session.py:237-270`）。SessionStore 的 `list_sessions` 用它做 **会话→工作区/标题/归档** 查询，**不用碰 379MB 大缓存** |
| `storages/session_projcache.json` + `storages/session_projcache/sessions/*.json` | **379MB**（索引）+ 每会话一份缓存投影 | 大会话→项目缓存索引，按 session id 存 identity/投影。可当**快速路径/缓存源**，但 **379MB 体积需标注谨慎**：**推断**——索引文件常驻内存不可取，只按需读单会话条目，绝不整文件载入 |

契约落点：`workspace.json` 进 DSH 根发现（§4.2 / §6.3-2），标题/归档查询走它而不是
扫日志本体；`session_projcache` 是「可删除、可重建」的 cache 源（同 §3.1 的 cache
铁律：删了只影响性能不影响字节输出），不是权威真相。注意「目录名 ≠ header id」
（§1.3）同样适用于 storages 里的索引——join 一律以头行 `id` 为准。

---

## 5. initial population 切法

`spec §8 R2a`：initial population 子阶段——`list_sessions`/`read_session` 首次就能被
真实数据填充（Codex `~/.codex/sessions` 根扫描、DSH 历史发现、zstd 降级）。R3 只加
watcher/增量调度，不再首次引入数据发现。

### 5.1 先扫 Codex（adapter 就绪）

`capability §4-1`：顺序 = `codex_session_roots_report`（stat，1ms）→ 逐文件
`read_codex_session_log` → core `build_codex_evidence` → 按逻辑 `session_id` 去重 +
`session_index` 拼标题。

- 资源上限：per-file 单飞；单文件最大 210.6MB / p90 1.6s 可接受；对 >50MB 大文件先
  size/mtime 快照，避免每 tick 重读（`capability §4-1`）。
- 一轮全量 Python ~75s，Rust 侧预计 ≤10–20s（落在 `spec §5.3` 全量 rescan 预算附近）
  （`capability §1.1`；「Rust 应更快」原文）。
- 标题 87% 命中：`title` 允许 null（§2.5）。

### 5.2 DSH 排在 zstd 落地之后

`capability §4-2`：当前 adapter 读不了任何文件（58/58 都是 `.zstd`，`.zstd` 路径实测
降级为 `non-json`）。先做 §6.3-1/2（zstd 多帧 + 根发现），落点后：58 会话 / 215.8MB
明文，全量 18.2s（解压 0.4s），coverage 25,510 exec + 10,894 usage。

- **zstd 落地前，DSH 源必须显示 `source-unavailable`，不能显示 0 会话**（§4.3）。
- 多帧 zstd 解压参照 `dsh_autosync.py::_decompress_zstd`（`read_across_frames=True`）与
  Node `readZstdFrames`（`capability §3.2-1`）。
- 会话→工作区/标题/归档查询走 `storages/workspace.json`（§4.5，2.5KB 索引），不扫日志
  本体；379MB `session_projcache.json` 只在需要快速路径时按需读单条目，不整文件载入
  （实测事实 2026-08-30）。

### 5.3 资源上限与降级

- 无权限/损坏降级：逐文件降级原样透传 → `source_statuses`（§4.3）。
- 全量 rescan 预算参考 `spec §5.3`（普通 fixture ≤10s 上限；隐藏窗口不跑全量）。
- `spec §8 R2a` 验收「隔离的仿真 HOME 中用 Codex + DSH **真实格式语料**重建索引后，
  重启能从空 cache 得到稳定、相同的会话列表」→ 这是 initial population 的端到端验收：
  cache 可删、重建结果字节一致。

---

## 6. 与 R1 的关系

### 6.1 SessionStore 消费 R1 的什么

R1 定稿为 **A：Rust 产出链**（`spec §4.2` 决策 13；R1a 读侧 tick 已完成、R1b
`budget.evaluate()` 迁 core、R1c Rust 状态写链、R1d tick 切 Rust 产出）。R2a 的
SessionStore 与之的关系是**只读消费者**：

- 消费 R1 的**写权分界模型**（`spec §4.2` 数据产出责任矩阵 + 唯一写者接管协议）——
  Store 明确自己不在权威 state 写者集合里（§3.2）。
- 消费 R1 确立的 **exactly-once 语义**（同一 session_log 多 tick 不重复累加，`spec
  §8 R1` 验收）——R2a 的断线→回退→重连无重复 fixture 是同一不变量在「身份/去重」
  维度的投影。
- 消费 R1 的 **turn-boundary resume 契约**（`usage_fold_resume` 先例）——R2a 的
  checkpoint 只位于 turn 边界是这条契约的延续（§3.4）。
- 消费 R1 的**持久 state 产物**（`oneline.json`/`sessions.jsonl`/`alert.json`）作为
  「最近会话/预算状态」的降级数据源（R1a 已读它们；R2a 的 Store 仍只读它们，不写）。

### 6.2 写权边界与 §4.2 不冲突的论证

已在 §3.2 完整给出。要点复述：writer fencing（`writer_epoch`/`owner`）治理**权威 state
文件**的写者；SessionStore 只写**自己 cache**（可删除、非权威、重建幂等）。二者写权
不相交，Store 不可能触发 fencing 拒绝，fencing 也不可能被 Store 绕过——因为 Store 从
不碰被 fencing 保护的文件。`spec §5.2`「R3 验收：删除 cache 只影响性能，不改变最终
字节输出」进一步保证 cache 写权再乱也不影响正确性。

### 6.3 R2a 拆解子任务清单

按依赖序（括号内为契约依据）：

1. **DSH zstd 多帧读取落地**（`capability §3.2-1`，**阻断项**）：给 Rust 侧补多帧
   zstd 读取。**已决策（用户拍板 2026-08-30）：`ruzstd`（纯 Rust）**——零 C 依赖、
   供应链干净、可编 wasm；多帧鲁棒性不如 libzstd 但满足本场景。注意：`spec §7.1`
   G1 的「不依赖 `zstandard`」指**分发出去的宿内 Python skill** 不拉第三方库；
   Tauri/Rust 桌面运行时加一个 zstd crate 是另一条约束（`capability §3.2-1` 明说
   需在 R2a 决策时确认）。
2. **DSH 根目录发现**（`capability §3.2-2`）：补 `dsh_session_roots_report`（与
   `codex_session_roots_report` 同级：存在性 + 计数 + 字节量，绝不报错），并把
   `storages/workspace.json`（§4.5）读进会话→工作区/标题/归档索引，才能做 initial
   population 的目录扫描与列表。
3. **machine namespace 持久化**（`capability §3.2-3`；`spec §4.3`）：Tauri app
   config 落随机 UUID，可重放派生、可备份迁移、默认不导出；重装丢失明示「新 profile」。
4. **DSH 降级语义修正**（`capability §3.2-4`）：`.zstd` → `unsupported-compression`，
   不是 `non-json`。
5. **SessionKey + 强类型 revision 类型**（`spec §4.3`）：harness_kind / native_id /
   source_profile / machine_namespace 四元组 + `SourceFingerprint` / `SessionRevision` /
   `StoreRevision`（`Schema/Engine/PricingVersion` 进 envelope）。
6. **versioned SessionReport envelope + 版本矩阵**（`spec §5.4`/§4.2）：§2 的形状 +
   N-1/N/N+1 投影 fixture + 独立升级顺序测试。
7. **SessionStore + IPC**（`spec §5.4`/§8 R2a）：内存只读索引 + 可删 app cache +
   `list_sessions`（分页）/`read_session` + 类型化错误码 + StoreRevision/cursor 语义
   （§3.3–§3.5）。
8. **turn-boundary checkpoint 管道**（`spec §5.2`）：DSH 只在 `turn/end` 后持久
   checkpoint；Codex 文件原子全量 fold（§3.4）。
9. **冻结 fixture 对账 harness**（`spec §8 R2a`）：同一 raw fixture 分别经 Python、
   Rust core/CLI、wasm+DSH 投影生成报告，对 token buckets、cost、coverage 三态、
   findings、residuals 做字节/逐字段对账；测试环境注入固定 machine_namespace（§1.4）。
10. **断线→回退→重连无重复 fixture**（`spec §4.3`/§8 R2a）：Codex 续接会话按
    `session_id` 合并不双计；DSH 头行 `id` 全局唯一（目录名≠id，join 以头行为准，
    实测事实 2026-08-30）。
11. **initial population 端到端验收**（`spec §8 R2a`）：隔离仿真 HOME + Codex/DSH
    真实格式语料，从空 cache 重建索引 → 重启稳定相同会话列表。

---

## 附：与 spec 逐条对齐索引

| 契约点 | spec 位置 | 本文件节 |
|---|---|---|
| SessionKey = harness kind + native id + source profile / machine namespace | §4.3 | §1.1 |
| machine namespace 可重放派生、app config 持久、默认不导出、重装明示新 profile | §4.3 | §1.4 |
| 按源 identity 表；alias 只在有可验证 join key 时归一 | §4.3 | §1.2–1.3 |
| 强类型 revision 四件套 | §4.3 | §1.5 |
| versioned envelope + 版本矩阵 + 不兼容行为 | §4.2/§5.4 | §2 |
| 写权边界（app cache vs 权威 state）、删 cache 只影响性能 | §5.2 | §3.1–3.2 |
| checkpoint 仅 turn 边界、usage_fold_resume 先例 | §5.2/CLAUDE.md | §3.4 |
| IPC list_sessions/read_session + 类型化错误码 + 并发顺序 | §5.4 | §3.3 |
| source adapter 接口 + NormalizedEvidence + coverage 归属 core | §4.2 | §4 |
| 诚实降级（source-unavailable / unsupported-compression） | §5.4/§8 R2a | §4.3 |
| initial population 先 Codex、DSH 排 zstd 落地后 | §8 R2a / capability §4 | §5 |
| 与 R1 写链/takeover 的关系、不冲突论证 | §4.2 | §6.1–6.2 |
