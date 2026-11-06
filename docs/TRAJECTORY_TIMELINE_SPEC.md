# 轨迹时间线设计说明（Timeline Series Contract）

> **状态订正（2026-09-08，`docs/TRACEGRAPH_TIMELINE_RECONCILIATION.md` 实测）**：
> 下面这句「已全部落地」**只对几何层成立**。实测：`timeline_series` 这个名字在全仓库
> （.rs/.py/.ts/.js/.cjs）**引用数为 0**——落地的是它下游的几何消费面（§4 的 points/
> events/values 形状 + §5 不变量），**§4 数据契约本身承载诚实性语义的 5 个字段
> `linearization` / `scope` / `native` / `ts` / `events[].provenance` 均未落地**。
> `ordinal`（含 `tests/test_timeline_ordinals.py` 的唯一性契约）、`task_id`、`values`
> （缺键不出现）已落地。v0.10 的 `TraceGraph` 将补齐这 5 个字段并把
> `timeline_series` 定义为 `project(TraceGraph, linearization)` 的输出类型
> （v0.10 spec §2.1.1 / §2.1.2）。
>
> 状态：**已全部落地（2026-09-01）**——§4 契约 + §5 不变量 + §6 的「几何只写一份」
>       已实现（`src-tauri/ui/timeline.js` + `scripts/verify-timeline-geometry.mjs`，
>       13 项断言由 `tests/test_codex_session_template.py` 调 node 执行），三个消费
>       面全部迁完、不再有第二份几何：
>         - 工作台单会话详情（DSH 逐请求累计 token + findings 事件、Codex 逐小时 token）；
>         - dsh-client `timeline.ts` 已改成**数据准备适配器**，经
>           `timeline-shared.cjs`（字节锁步副本，`tests/test_timeline_lockstep.py` 守）
>           import 共享 `buildGeometry`/`nearestPoint`；成本纵轴走 `'carry'` 语义
>           （执行环境算好的累计值，浏览器不再累加、不重算单价）；
>         - `codex_session.html` 内联块已重生成（`>>> sv-timeline-geometry` 逐字节
>           对齐源，`scripts/verify-codex-session-timeline.mjs` 守），调用点走
>           `TimelineGeometry.buildTimeline`，不再有内联 `svTimelineSvg`。
> 目标：给 DSH / Codex / Claude Code / WorkBuddy / 未来执行环境 的「会话时间线」
>       定一个统一的 canonical 数据形状 + 通用绘制范式，让几何只写一份。
> 配套：`RUNTIME_EVIDENCE_CONTRACT.md`（每执行环境的证据面与退化规则，本文的
>       事实来源）、`RUNTIME_EVIDENCE_CONVERGENCE_SPEC.md`（P1–P6 落地进度，
>       本文不碰行为检测，只碰「时间线」这个呈现投影）。

本文所有论断都有证据来源（`文件:行号` 或本机实测），不写无依据的结论。

---

## 0. 结论（TL;DR）

「绘制合理的轨迹时间线」不是「把日志按时间排成一行」，而是：

> **把一棵可能分叉的事件树，按显式选定的线性化路径投影到一条线上；序靠
> `(scope, ordinal)` 加 `native` 跨 scope join；时间戳只是展示/分桶的副属性；
> 粒度层（一个点是什么）与序列（y 轴值）按执行环境证据独立退化；事件标记是与线
> 正交、永不聚合的第二图层。**

五个正交维度，每条都随执行环境退化，退化方式各不相同：

1. **线性化**（树 → 线）：选 LeafPath 还是 AllRecorded。
2. **序**（x 轴真键）：`(scope, ordinal)`，跨 scope 走 `native`，时间戳不排序。
3. **粒度层**（一个点 = turn / step / subagent / task）：可用度天差地别。
4. **序列**（y 轴值）：token 桶分执行环境；成本是 Money/Credits/Quota 三种不可通约。
5. **事件标记**（与线正交）：永不聚合、永不丢；lossy 是独立第二轴。

canonical 形状是：

```js
timeline_series = {
  linearization: "leaf" | "all",          // 树投影时显式声明，不是默认
  points: [{
    scope,          // 编号空间：主会话 / 子代理
    ordinal,        // scope 内严格递增；跨 scope 不可比
    native,         // Seq | Uuid | CallId | TurnId —— 跨 scope join 只走它
    ts,             // 可选；只用于时间分桶与展示，不参与排序
    task_id,        // 可选；映射到 turn（数据现成，四执行环境都有）
                    // 注：无 goal_id——见 §3.3，goal 是「/goal 文本命令」或
                    // 「task 跟踪结构化列表」，两者都不该塞进 per-point 字段
    values,         // { context, input, output, cache, cost? } —— 按执行环境有的填
  }],
  events: [{       // 与 points 正交，永不参与聚合
    ordinal, native, kind, label, severity?, targetId?,
  }],
}
```

---

## 1. 问题与背景

工作台（`src-tauri`）要展示「会话时间线」，但仓库里已经有两份各画各的折线图，
且都不在同一个面上：

| 执行环境 | 现状 | x 轴 | 几何实现在哪 |
|---|---|---|---|
| DSH | `dsh-client` 浏览器插件 `TimelinePanel.tsx` | request_seq | `dsh-client/src/client/timeline.ts`（React + SVG） |
| Codex | `codex_session.html` 静态报告 | 逐小时桶 | 模板内联 `svTimelineSvg` |

两条几何是**两份实现**，且语义不同（per-request 三轴 vs per-hour 单轴）。这正好
是 CLAUDE.md 里那句「时间线几何被单独隔离，是因为比例尺算错了不报错、只有人眼
看出来」所警告的风险——而现在是两份都处于「各自有 verify 脚本、但互相不共享」的
状态。本文把「几何只写一份」的通用形状定下来。

`vitals-core` 的 `CanonicalEvent` 已经给了一半答案（§2），但「时间线」这个
**呈现投影**本身不在 vitals-core 的职责里（它是 domain-free 的测量层，不画图）。
本文的契约是架在 evidence 之上、喂给前端几何函数的那一层。

---

## 2. 本质：时间线是树的投影，不是日志排序

这条是五个维度成立的前提。四个执行环境的证据分别证实：

- **Claude Code** 的 transcript 是**消息树**（`uuid`/`parentUuid`），`type` 是角色
  （assistant/user/attachment/system）不是事件种类，**没有 `seq`**。本机实测一条
  5739 行的真实 transcript：顶层 type 分布 assistant 1796 / attachment 1034 /
  user 1004 / system 52，外加 bridge-session、permission-mode、file-history-delta
  等基础设施记录；`uuid`+`parentUuid` 各 3886 条。
- **Codex** 记录 `thread_rolled_back`；**DSH** 分支带 `seedLength` 前缀。
  （`RUNTIME_EVIDENCE_CONTRACT.md` §243）

三个执行环境日志里都躺着**用户放弃过的路径**。画线之前必须先决定画哪条。契约文档
§243 给出的形状是 `Linearization { LeafPath, AllRecorded }`，默认 `LeafPath`（用户
最终走的那条）。

**Claude Code 侧这条不用猜**：本机实测，281 条 `last-prompt` 记录都带 `leafUuid`
指向那一刻的当前叶节点，`isSidechain` 标旁支。也就是说「叶路径」是执行环境自己写在
日志里的信号，adapter 是去**读**它，不是去**发明**它。这一点比「adapter 选
LeafPath」更强——线性化有执行环境信号可循。

废弃/无法解析的分叉 → `unmetered`，不是 0，不是静默合并（`RUNTIME_EVIDENCE_CONTRACT.md`
§243：「fork 无法解析 → 不进 floor、不进 total、单独计入 unmetered，让缺口出现在
覆盖率里」）。

---

## 3. 五个正交维度

### 3.1 线性化（树 → 线）

- 选 `leaf`（默认，用户最终走的那条）还是 `all`（全部记录路径）。
- 选 `leaf` 时，废弃分叉 → `unmetered`，总览的覆盖率必须显示这个缺口。
- Claude Code 的 `leafUuid` / `isSidechain` 是执行环境给的线性化信号；Codex 的
  `thread_rolled_back`、DSH 的 `seedLength` 是同义但形态不同的信号。

### 3.2 序（x 轴真键）

`vitals-core` 已定：`CanonicalEvent.ordinal` 是「权威执行顺序」，`occurred_at_ms`
是 `Option<i64>`、「只用于展示和时间窗口，不参与排序」（`crates/vitals-core/src/
event.rs`）。契约文档把它升级成三段式（§9）：

```rust
EventId { harness_scope, ordinal, native }
// ordinal：adapter 局部、只在「一个 scope 内」可比（Claude Code 无 seq，是合成的）
// native ：Seq | Uuid | CallId | TurnId —— 跨 scope join 只走它，绝不走 ordinal
```

每执行环境 identity 键不同：DSH `seq`；Codex `turn_id`/`call_id`；Claude Code
`uuid`/`parentUuid`/`toolUseID`；WorkBuddy `toolCallId`/`requestId`
（`RUNTIME_EVIDENCE_CONTRACT.md` §9）。跨 scope（主子代理）join 走 `native`，
因为子代理会话是另一个编号空间——`dsh-client` 的 `skillAttribution` 已经手工
守过这条（`source_agent_id === null` 才 join seq）。

**时间戳永不参与排序**：会缺失、会乱序（时钟漂移 / resume 续写 / backfill 补录）。
它只在「按时间分桶」（小时/天）时当键，且那个键是**派生的北京时间**（`codex_hour_of`
/ `hour_buckets` 都显式写「北京时间 UTC+8 固定、无夏令时，不是 UTC」），不是原始
epoch。错一个时区，peak/off-peak 成本就错——这是成本领域规则，不是 vitals-core 的
确定性约束（见 §6）。

### 3.3 粒度层（「一个点」是什么）

四层，可用度天差地别，来自 `RUNTIME_EVIDENCE_CONTRACT.md` §13 信号矩阵：

| 层 | DSH | Codex | Claude Code | WorkBuddy |
|---|---|---|---|---|
| TurnBoundaries | measured | measured（`task_started`/`task_complete`） | **derived**（`system/turn_duration`） | **derived**（一个 trace = 一个 run） |
| StepBoundaries | measured | unavailable | derived | unavailable |
| SubagentSpawns | measured | measured（**+parent→child**） | measured（`isSidechain`/`Task`） | measured（`parentId` 树） |
| task/goal | 无 | task=turn（`task_started`/`task_complete` 带 `turn_id`） | `/goal` 命令（文本）+ `TaskCreate/Update/List`（结构化） | `tasks/<session>/<id>.json`（结构化） |

「goal / task」**不是一码事，而是三个不同东西**，之前全被混成一个"空"：

1. **`/goal` 斜杠命令**（用户设会话目标）→ **文本**，不是结构化字段。本机实测 Claude
   Code 把一次 `/goal` 存成两条 `user` 记录：命令体是
   `<command-name>/goal</command-name>` + `<command-args>…</command-args>`，结果是
   `<local-command-stdout>Goal set: …</local-command-stdout>`。它跟 `/model`、`/effort`
   用同一套 `<command-name>` 文本包装，没有专属字段——要提取得去 parse `<command-args>`
   文本。用户报告 Codex/WorkBuddy/DSH 也有 `/goal` 入口，但本文档只对 Claude Code
   做了本机验证，其余待逐执行环境核。
2. **结构化 task 跟踪**（todo 列表，与 `/goal` 是两回事）→ **真·结构化数据，且两执行环境
   几乎同构**：
   - Claude Code `TaskCreate`/`TaskUpdate`/`TaskList` → `{ taskId, subject, description, status }`（status ∈ pending/in_progress/completed）
   - WorkBuddy `~/.workbuddy/tasks/<session-id>/<id>.json` → `{ id, subject, description, activeForm, status, createdAt, updatedAt }`（本机实测 14/15 个 task 目录的 uuid 命中 SQLite session id）
   - 两者都有 `id + subject + description + status`，只是 WorkBuddy 多 `activeForm` 和时间戳。
3. **Codex 的 "task" = "turn"**：`task_started`/`task_complete` 事件的 payload 带
   `turn_id`，是 turn 边界，不是独立 goal。

所以 vitals-core 的 `goal_id` 槽**不是"无执行环境喂"**，是**把两个概念（`/goal` 文本 +
task 跟踪结构化）合并成了一个字段，且两个都没映射**——adapter `canonical_session.rs:77`
的 `goal_id: None` 是写死，不是"挖了没挖到"。契约应区分：`task_id`（= turn，数据现成）
与 `goal`（`/goal` 文本，需 parse；task 跟踪结构化，可映射但语义是"待办列表"不是"会话
目标"）。

### 3.4 序列（y 轴值）

token 桶分执行环境：DSH 4 桶、Codex 6 桶（`codex_usage.rs` 读 `last_token_usage` 增量 +
按 `total_token_usage` 签名去重）、Claude Code 4 桶 + `thinking_tokens` + ephemeral
cache（`message.usage`，按 `message.id` 去重）、WorkBuddy 计量 **credits 不是 token**。

成本**不是一条序列**，是不可通约的四种（`RUNTIME_EVIDENCE_CONTRACT.md` §8）：

```rust
enum Cost { Money { currency }, Credits(f64), Quota(Vec<QuotaWindow>), Unavailable }
```

不同币种 / credits / token **绝不互加、绝不排名**。时间线的「cost 轴」因此是
执行环境专属的（DSH/Codex/Claude Code 是 Money，WorkBuddy 是 Credits），几何函数
不关心——它只画「一个命名序列的值」，值是什么单位由适配器决定。

### 3.5 事件标记（与线正交的第二图层）

`risk / waste / compaction / model / subagent / skill / slow`。两条不变量来自
CLAUDE.md 的 timeline 纪律：

1. **事件点一个不丢**：曲线可以按显示宽度聚合抽稀，但事件标记不参与聚合
   （`eventsIn === eventsOut`）。抽掉一次 `rm -rf` 不行。
2. **缺数据留缺口不连直线**：整桶无测量值就断开，不把 null 当 0，不跨未测量的
   缺口插值。

WorkBuddy 还揭示**第二根轴**：audit-log 只有 `commandPreview`+`commandHash`
没有命令本体（`RUNTIME_EVIDENCE_CONTRACT.md` §14.6）——能定罪、不能脱罪。这是
独立于「有没有」的「是否 lossy」，事件标记必须带 `provenance`（measured/derived/
lossy），不把 lossy 的标记和 measured 的标记画成同一种置信度。

---

## 4. canonical `timeline_series` 契约

```jsonc
{
  "linearization": "leaf",              // "leaf" | "all"，在 series 级别声明
  "scope_units": ["main", "sub"],        // 可选：本 series 涉及的编号空间
  "points": [
    {
      "scope": "main",
      "ordinal": 42,                     // scope 内严格递增；跨 scope 不可比
      "native": "call_00_AbCdEf",        // Seq|Uuid|CallId|TurnId，跨 scope join 用
      "ts": 1786895978589,               // 可选；展示/分桶副属性
      "task_id": "turn-71",              // 可选；映射到 turn
      // 无 goal_id：goal/task 见 §3.3 的三分法，不塞进 per-point
      "values": {                        // 按执行环境有的填，缺了不编
        "context": 1813,
        "input": 8238,
        "output": 9112,
        "cache_read": 1380864,
        "cost": 0.02                     // 单位由执行环境定（Money/Credits），不跨执行环境比
      }
    }
  ],
  "events": [
    {
      "ordinal": 42, "native": "…", "kind": "risk",
      "label": "rm -rf /tmp", "severity": "critical", "targetId": "f-123"
    }
  ]
}
```

约束：

- `points` 按 `(scope, ordinal)` 升序；**同 scope 内 ordinal 唯一**，跨 scope 靠
  `native` 关联。
- `values` 的键集合由执行环境声明，缺的键**不出现**（不是填 0 / null）——「这个执行环境
  没测这个维度」与「测了是 0」必须可区分。
- `events` 与 `points` 正交，**永不参与聚合**；每个 event 必带 `provenance`
  （measured/derived/lossy）。
- 不设 `goal_id`：goal/task 是三分法（§3.3），per-point 只带 `task_id`（turn）。
  结构化 task 跟踪（Claude Code `TaskCreate`、WorkBuddy `tasks/*.json`）作为独立的
  列表维度（与 subagent 同层），不在 points 里混。

---

## 5. 通用不变量

1. **树要显式选线性化**；废弃分叉进 `unmetered`，不归零、不静默合并。
2. **序 = `(scope, ordinal)`，跨 scope 走 `native`**；时间戳永不参与排序。
3. **每个字段只用执行环境真暴露的证据**；`unavailable ≠ 零`，lossy 单独标记。
4. **用量/成本不可通约**，不跨执行环境相加、不跨币种排名。
5. **事件点一个不丢**（`eventsIn === eventsOut`）；缺数据留缺口不连直线。
6. **父子 agent 关系是半成品**，不塞进线性的 x 轴，放独立的树视图。

其中 5 的两条（事件不丢、缺数据断开）是几何层的硬约束，必须由纯函数 + 测试钉住
——这正是 CLAUDE.md 说「时间线几何要隔离」的原因。

---

## 6. 归属分层（谁在哪算）

| 层 | 干什么 | 归属 | 理由 |
|---|---|---|---|
| **数据准备**：原始事件 → `timeline_series.points` | 折 token 快照、按小时/turn 分桶、选叶路径、映射 ordinal/native | **agent-vitals-core 的执行环境适配器 + envelope** | 执行环境专属的测量派生，不该在浏览器重算 |
| **几何**：`points+events` → SVG path/柱/点 | 比例尺、聚合、缺口断开 | **共享 client `.js`（纯函数）** | 呈现，不是测量；「错比例尺不报错」要靠测试钉，不是靠位置 |
| **渲染壳** | SVG 字符串 → DOM/React/模板 | 每前端一份 | 三个前端构建链不同 |

- **vitals-core 不碰时间线**：domain-free 的测量层（finding/cost/replay），不含
  呈现、不含「小时」「北京时间」这类词。`dependency_boundary.rs` 已守这条。
- **几何只写一份**：无依赖 `.js`，三种消费方式——工作台 `<script src>`、
  dsh-client `import`（副本 `timeline-shared.cjs`，`.cjs` 后缀是因为 dsh-client
  是 `"type": "module"`，esbuild 按 ESM 解析 `.js` 会让 UMD 的 `module.exports`
  变死代码）、`codex_session.html` Python 内联。一条 node 验证脚本
  （现 `verify-timeline.mjs` / `verify-codex-session-timeline.mjs` 的模式）断言
  纯几何，跑在 CI 和本地 unittest 里，风险钉一次不是三次。
- **数据准备收口到 envelope**：Codex 现在已把 `cost_report.hours` 在执行环境侧折好，
  DSH 却把原始 `requests[]` 丢给客户端自己折——这份不一致正是要消灭的。每个执行环境
  适配器产同一个 `timeline_series`，客户端几何函数只消费这个形状。

---

## 7. 每执行环境证据现状

本机实测 + `RUNTIME_EVIDENCE_CONTRACT.md` §14 汇总。四个执行环境都读了原始数据，不是
adapter 产出：Claude Code `~/.claude/projects/.../*.jsonl` 5739 行；Codex rollout
`~/.codex/sessions/.../rollout-*.jsonl` 4707 行；DSH `~/.dsh/sessions/.../
session.jsonl.zstd` 解压后 9807 行；WorkBuddy SQLite（`sessions`/`session_usage`
22 会话）+ `tasks/<session-id>/<id>.json`（15 目录，14 命中 session id）+ `traces/`
670 个 span 树。

| 执行环境 | 存储 | 树/线 | 序 | 一个点的粒度 | y 轴值 | 备注 |
|---|---|---|---|---|---|---|
| DSH | JSONL | 线（`seedLength` 分支） | `seq` | request / turn / step | 4 桶 token + cost(CNY) | 唯一有 StepBoundaries |
| Codex | JSONL | 线 + `thread_rolled_back` | `turn_id`/`call_id` | turn（`task_started`/`task_complete`）/ 快照 | 6 桶 token（`last_token_usage` 增量）+ Money | history_mode Legacy/Paginated 两套词汇 |
| Claude Code | JSONL | **树**（`uuid`/`parentUuid`/`leafUuid`/`isSidechain`） | 无 seq；`uuid`/`requestId` | turn（`turn_duration` 推导） | 4+thinking+ephemeral token | 无审批/沙箱记录；denial 靠字符串标记（lossy） |
| WorkBuddy | SQLite + JSONL + span 树 + blobs | **树**（`parentId`） | `toolCallId`/`requestId` | 一个 trace = 一个 run | **credits**（`session_usage.credit_json`） | 无 transcript；audit-log 只有 preview+hash |

**task/goal 数据结构**（本机实测，是这次调研的核心纠正项）：

| 执行环境 | task/goal 形态 | 结构化？ | 字段 |
|---|---|---|---|
| Claude Code | `/goal` 斜杠命令 | ❌ 文本 | `user` 消息里 `<command-name>/goal</command-name>` + `<command-args>` + `<local-command-stdout>Goal set: …` |
| Claude Code | `TaskCreate`/`TaskUpdate`/`TaskList` 工具 | ✅ 结构化 | `{ taskId, subject, description, status }` |
| WorkBuddy | `tasks/<session-id>/<id>.json` | ✅ 结构化 | `{ id, subject, description, activeForm, status, createdAt, updatedAt }` |
| Codex | `task_started`/`task_complete` 事件 | ⚠️ task=turn | `{ turn_id, last_agent_message, … }` |
| DSH | 无 | ❌ | turn/step 只有序号，无 task/goal |

两条要单独记的：

- **Claude Code 的树是显式的**：`leafUuid`（在 `last-prompt` 上）标叶、`isSidechain`
  标旁支，线性化信号执行环境自给。
- **WorkBuddy 的轨迹证据曾被漏掉一轮**：最富的 `traces/`（670 个 span 树、652MB）
  在第一轮调研里没被发现，文档据此立规矩「adapter 报 unavailable 必须枚举它试过
  哪些 store」。时间线同理：停在 2 个 store 就报「无 transcript」，画出来必错。

---

## 8. 已知缺口与诚实空

| 缺口 | 现状 | 处置 |
|---|---|---|
| task/goal 未映射 | vitals-core `goal_id` 把「`/goal` 文本命令」与「task 跟踪结构化列表」合并成一个字段，且两者都没映射；adapter `canonical_session.rs:77` 写死 `None` | **待接的映射缺口，不是删除对象**。`/goal` 需 parse `<command-args>` 文本（lossy）；task 跟踪（Claude Code `TaskCreate`、WorkBuddy `tasks/*.json`）是可映射的结构化数据，语义是"待办列表"不是"会话目标"，宜作独立列表维度 |
| 父子 agent 关系 | DSH 扁平列表（`parentSession` 5/19 不可靠）；Codex `agent_thread_id` 只数覆盖率未提取；Claude Code `isSidechain`；WorkBuddy `parentId` 树 | 不进 `timeline_series` 的线性轴；留给独立的子代理树视图 |
| 成本轴 | Money/Credits/Quota 不可通约 | 不做跨执行环境 cost 轴；每执行环境画自己的 |
| WorkBuddy 全貌 | traces 仅抽样 schema，未对全 corpus 校准 | 标 `※`，未校准前按 provisional 处理 |

「诚实空」是本仓库一贯的纪律（`references/harnesses.md`：unavailable 不是 0；报告缺
一列比编一列有用）。时间线契约继承它：`values` 缺键不出现、lossy 单独标——都是同一
原则的呈现侧镜像。task/goal 这一条**不是**"诚实空"，是"**未映射**"：数据在执行环境原始
日志里真实存在（本机已验证），是 adapter 没接，两者不能混为一谈。

---

## 9. 测试与验收

几何是唯一「错了不红」的地方，所以验收重点在几何：

1. **纯几何单测**（node 脚本，同 `verify-timeline.mjs`）：0/1/N 桶下的 SVG 形状；
   1 桶不退化成零长线；缺数据断开不插值；`eventsIn === eventsOut`。
2. **契约形状测试**：`timeline_series` 逐字段对账 `CanonicalSession`（同
   `test_canonical_schema.py` 的做法），`ordinal` 同 scope 唯一、跨 scope 走
   `native`。
3. **每执行环境 adapter 的 parity**：同一 session 的 `timeline_series` 与现有
   `cost_report.hours` / `requests[]` 数字一致（守恒：分桶求和 = 总量）。
4. **退化诚实**：某个执行环境缺 turn/step 时，对应字段不出现、图上留缺口，不拿
   unavailable 冒充 measured-zero（`evidence.rs`「adapter 不得用读不到的东西刷
   覆盖」的呈现侧同款）。

验收的靶子不是「图画得好看」，是「同一份数据画两次画得一样、缺的数据诚实留白、
跨执行环境不把不可通约的数画进同一条线」。
