# TraceGraph ↔ timeline_series 对账

> 日期：2026-09-08
> 对账双方：`docs/AGENT_VITALS_V0_10_VALUE_LOOP_ARCHITECTURE_SPEC.md` §2.1 `TraceGraph`（R2.1，未实现）
> ↔ `docs/TRAJECTORY_TIMELINE_SPEC.md` §4 `timeline_series`（标称 2026-09-01 已落地）
> 代码基线：main @ d9fe06e

## 0. 结论

**两者不是竞争关系，是同一棵树的两个面**：

```text
TraceGraph（树本体，分析用）
   │
   │  project(linearization)   ← 纯函数，v0.10 新增
   ▼
timeline_series（线性投影，绘图用）
   │
   │  buildGeometry(spec, opts) ← 已落地，勿新写
   ▼
SVG
```

所以 **TraceGraph 是 timeline_series 的原像**，timeline_series 应当**从 TraceGraph 派生**，
而不是各自从 wire 事件重建。

但对账发现两件事，都比「两份契约重叠」更要紧：

1. **`timeline_series` 这个数据契约其实没落地**——落地的是它下游的**几何层**。
   代码里 `timeline_series` 的引用数为 **0**（跨 .rs/.py/.ts/.js/.cjs 全仓库搜索）。
2. **契约 §4 里承载诚实性语义的 5 个字段，实现侧一个都没有**；而 v0.10 的 `TraceGraph`
   **同样一个都没有**。两份文档独立地把同一层漏掉了。

---

## 1. 实测：哪些落了，哪些没落

### 1.1 落了的（几何层，且守得很好）

| 资产 | 位置 |
|---|---|
| 几何纯函数（唯一一份） | `apps/desktop/src-tauri/ui/timeline.js` |
| 字节锁步副本 | `integrations/dsh-client/src/client/timeline-shared.cjs`（+ `.d.cts`） |
| 数据准备适配器 | `integrations/dsh-client/src/client/timeline.ts` |
| 几何断言 | `scripts/verify-timeline-geometry.mjs` · `scripts/verify-codex-session-timeline.mjs` · `integrations/dsh-client/scripts/verify-timeline.mjs` |
| 锁步测试 | `tests/test_timeline_lockstep.py` |
| ordinal 唯一性契约 | `tests/test_timeline_ordinals.py`（镜像 Rust `ordinals_are_unique...`） |

`timeline.js` 文件头自述即「`docs/TRAJECTORY_TIMELINE_SPEC.md` §4/§5 的纯函数实现」，
§5 不变量 5 的两条（`eventsIn === eventsOut`、缺数据断开不插值）有断言。**这一层是本次
对账里唯一不需要动的东西。**

### 1.2 没落的（数据契约层）

`buildGeometry(spec, opts)` 的实际入参（`timeline.js:126-138` 的 docstring）：

```js
spec = {
  points: [{ ordinal, task_id?, values: { name: number|null } }],   // 已按 ordinal 升序
  events: [{ ordinal, kind, label?, severity?, targetId?, turn?, skillMode? }],
  series: [{ name, label?, cumulative? }],
}
```

与 `TRAJECTORY_TIMELINE_SPEC` §4 声明的 `timeline_series` 逐字段对账：

| §4 契约字段 | 几何实现 | 状态 |
|---|---|---|
| `linearization: "leaf" \| "all"` | ❌ 无 | **未落地** |
| `scope_units` | ❌ 无 | **未落地** |
| `points[].scope` | ❌ 无 | **未落地** |
| `points[].ordinal` | ✅ 有，且已有唯一性测试 | 落地 |
| `points[].native` | ❌ 无 | **未落地** |
| `points[].ts` | ❌ 无 | **未落地** |
| `points[].task_id` | ✅ 有 | 落地 |
| `points[].values`（缺键不出现） | ✅ 有，`values[name]` 可为 null | 落地 |
| `events[].provenance`（measured/derived/lossy） | ❌ 无 | **未落地** |
| `events[]` 其余字段 | ✅ 有（多了 `turn`/`skillMode`） | 落地 |

**未落地的正好是承载诚实性语义的 5 个字段**：

- `linearization` —— 画的是哪条路径（§5 不变量 1）；
- `scope` + `native` —— 跨编号空间 join 的唯一合法键（§3.2「跨 scope join 绝不走 ordinal」）；
- `ts` —— 与 `ordinal` 分离，「时间戳永不参与排序」（§3.2）；
- `provenance` —— lossy 与 measured 不能画成同一置信度（§3.5）。

> `TRAJECTORY_TIMELINE_SPEC.md` 的状态头写「**已全部落地（2026-09-01）**」，按本次实测
> 应订正为「**§4 几何消费面 + §5 不变量已落地；§4 数据契约本身（linearization/scope/
> native/ts/provenance）未落地**」。这不是笔误级别的问题——它会让读者以为 `timeline_series`
> 是个现成可用的类型。

### 1.3 澄清一个撞名

代码里搜 `native` 会命中 `harnesses/*/sources/usage_fact.rs` 的 `time_basis: "native"` /
`identity_basis: "native"`。**那是 basis 取值（「时间戳来自执行环境原生字段」），与
`timeline_series.points[].native`（执行环境原生事件 id，Seq/Uuid/CallId/TurnId）是两个概念。**
v0.10 若引入 `native` 字段，必须在 doc 里点明这个撞名，否则会被当成同一个东西。

---

## 2. TraceGraph 缺了 timeline 契约已经论证过的东西

逐条对 R2.1 §2.1 的 `TraceNode` / `TraceCoverage`：

### F-T1（P0）序：TraceGraph 没有排序键，只有可选时间戳

`TraceNode` 现有 `node_id`（哈希）、`started_at_ms: Option<i64>`、`ended_at_ms`。**没有
`ordinal`。** 后果：任何消费者要给节点排序，唯一可用的就是时间戳——而
`TRAJECTORY_TIMELINE_SPEC` §3.2 与 `vitals-core/src/event.rs` 已经把这条否掉了：

```rust
pub ordinal: u64,                  // 权威执行顺序
pub occurred_at_ms: Option<i64>,   // 只用于展示和时间窗口，不参与排序
```

理由是时钟漂移 / resume 续写 / backfill 补录会让时间戳缺失或乱序。`vitals-core` 有单测
`occurred_at_ms_missing_is_not_zero` 钉着。

**修**：`TraceNode` 增 `scope` / `ordinal` / `native` 三字段，与 `CanonicalEvent` 同义；
`started_at_ms` 明确标注「仅展示与分桶，不参与排序」。

### F-T2（P0）线性化未声明，废弃分叉没有去处

Claude Code 的 transcript 是**消息树**（`uuid`/`parentUuid`），三个执行环境日志里都躺着
**用户放弃过的路径**。§5 不变量 1：树要显式选线性化，废弃分叉 → `unmetered`，
**不归零、不静默合并**。

`TraceGraph` 是图，本身不需要选线性化——但它**必须记录哪些分支是废弃的**，否则下游投影
无从判断，且 `TraceCoverage` 会把废弃分叉算成正常节点。R2.1 的 `TraceCoverage` 只有
`missing_parent` / `missing_time` / `missing_status`，**没有 `unmetered`**。

**修**：`TraceNode` 增 `branch_state`（`live` / `abandoned` / `unknown`）；`TraceCoverage`
增 `unmetered_nodes`。线性化在**投影函数**上声明，不在图上。

> 附带一条好消息：**线性化有执行环境信号可循，不用猜**。Claude Code 实测 281 条 `last-prompt`
> 都带 `leafUuid` 指向当时的叶节点、`isSidechain` 标旁支；Codex 有 `thread_rolled_back`；
> DSH 有 `seedLength` 前缀。adapter 是去**读**它，不是发明它。

### F-T3（P1）`node_id` 是自造哈希，丢掉了执行环境原生 id

R2.1 写「图节点/边**不得自造 ID**」，然后定义 `node_id = fnv1a64_hex(canonical_json(...))`
——哈希恰恰就是自造 id。真正的意思应该是「不得自造**join 键**」：§3.2 明确跨 scope join
**只走 `native`**（执行环境自己的 Seq/Uuid/CallId/TurnId），绝不走我们合成的 ordinal 或哈希。

**修**：`node_id` 保留作稳定主键（幂等用），但**必须同时保留 `native`**，并写明 join 只
走 `native`。

### F-T4（P1）`metadata: serde_json::Value` 无约束，丢了「缺键不出现」

§4 约束：`values` 的键集合由执行环境声明，**缺的键不出现**（不是填 0 / null）——「这个执行环境没测
这个维度」与「测了是 0」必须可区分。这正是本仓库 `Unavailable ≠ MeasuredZero` 纪律的呈现侧
镜像。R2.1 的 `metadata` 是个自由 JSON，没有这条约束。

**修**：把量值从 `metadata` 拆出为 `values: Map<String, f64>`，并写明缺键不出现。

### F-T5（P1）事件/节点没有 provenance，lossy 与 measured 同置信度

§3.5：事件标记必须带 `provenance`（measured/derived/lossy）。WorkBuddy 的 audit-log 只有
`commandPreview` + `commandHash`、没有命令本体——**能定罪、不能脱罪**，这是独立于「有没有」
的第二根轴。

R2.1 §2.4.1 刚加的 basis 三元组是 **issue 级**的；这里要的是 **node/edge 级**的。两者不能
互相代替：一个 issue 的 attribution_basis 说不了它引用的某条 trace 边是不是 lossy。

**修**：`TraceNode` / `TraceEdge` 各增 `provenance`（`measured` / `derived` / `lossy`）。

### F-T6（P1）父子 agent 关系的可靠性没有传导

§5 不变量 6 + §8：父子 agent 关系是**半成品**——DSH 扁平列表 `parentSession` **5/19 不可靠**；
Codex `agent_thread_id` 只数覆盖率未提取；Claude Code 靠 `isSidechain`；WorkBuddy 有
`parentId` 树。契约的处置是「不进线性轴，留给独立的子代理树视图」。

`TraceGraph` 的 `node_type` 含 `subagent`、且有 `parent_node_id`——图不是线性轴，建模父子
本身没问题，**但 5/19 的可靠性必须以 provenance 形式传导**，否则 v0.10 会把一个 26% 可靠的
关系画成确定的因果边。

**修**：subagent 边的 `provenance` 按执行环境填；不可解析的父子进 `TraceCoverage.missing_parent`。

### F-T7（P2）成本轴：Credits / Quota 不在 v0.10 模型里

§3.4：成本不是一条序列，是四种不可通约的量：

```rust
enum Cost { Money { currency }, Credits(f64), Quota(Vec<QuotaWindow>), Unavailable }
```

R2.1 §2.2.1 / §10 只建模了 `Money`（minor units + currency）与跨币护栏。`Credits`
（WorkBuddy）按既有决定不在范围内（WorkBuddy 已从 UsageFact 线整体排除，用户决定
2026-09-03），但 **`Quota` 是相关的**——R2.1 §2.2.1 硬规则 2 刚说「订阅型收益体现为配额/
限流余量」，那正是 `Quota`，而 spec 没有承载它的类型。

**修**：§2.2.1 的 token 档 potential 明确落到 `Quota` 语义上，或显式声明 v0.10 只做
Money + tokens 两档、Quota 延后。

---

## 3. 最要紧的一条：Traces tab 不能自己画时间线

R2.1 §5 给 Traces tab 写的是「**轨迹、节点图、时间线**、覆盖与缺失说明」。

`TRAJECTORY_TIMELINE_SPEC` 的整个存在理由，就是 2026-09-01 之前仓库里有**两份各画各的
折线图**（dsh-client 的 `TimelinePanel.tsx` per-request 三轴 ↔ `codex_session.html` 的
`svTimelineSvg` per-hour 单轴），语义还不同。那次收敛把几何压成一份 + 一个 node 验证脚本。

**如果 v0.10 的 Traces tab 自己写时间线，就是第四份**，而且会复刻同一个风险：
CLAUDE.md 已写死「比例尺算错了不报错、只有人眼看出来」。

**硬约束（应写进 §7 v0.10-A 门槛）**：Traces tab 的时间线**必须调用既有
`buildGeometry` / `buildTimeline`**（`apps/desktop/src-tauri/ui/timeline.js`），
新增的只能是「TraceGraph → geometry spec」的数据准备函数。**不得新增第二份几何。**

`TRAJECTORY_TIMELINE_SPEC` §6 的归属分层表直接给了 v0.10 的分工，照抄即可：

| 层 | 干什么 | 归属 |
|---|---|---|
| 数据准备 | 原始事件 → points/events（折 token、分桶、选叶路径、映射 ordinal/native） | 执行环境适配器 + envelope（Rust 侧） |
| 几何 | points+events → SVG path/柱/点（比例尺、聚合、缺口断开） | 共享 client `.js` 纯函数（**已存在**） |
| 渲染壳 | SVG → DOM/React/模板 | 每前端一份 |

R2.1 §6.2 把 `trace_service.rs` 放 runtime、`harnesses/<h>/sessions/trace.rs` 放 harnesses，
与「数据准备归执行环境适配器」一致 ✅。

**但 §6.2 列的 `vitals-core/graph.rs` 有边界风险**：`TRAJECTORY_TIMELINE_SPEC` §6 明写
「**vitals-core 不碰时间线**」，且 `crates/vitals-core/tests/dependency_boundary.rs` 有
`module_file_names_are_domain_free` / `public_item_identifiers_are_domain_free` 两条断言在守
——`graph.rs` 里只要出现 domain/呈现词汇就会红。建议 `graph.rs` 只放无语义的图原语
（节点/边/可达性），**任何 trace 语义留在 domain**。

---

## 4. 建议的落地顺序

| # | 动作 | 阶段 |
|---|---|---|
| 1 | §2.1 `TraceNode` 增 `scope` / `ordinal` / `native` / `provenance` / `branch_state`；`values` 拆出 `metadata`；`TraceCoverage` 增 `unmetered_nodes`（F-T1~F-T6） | v0.10-A 首个 PR |
| 2 | §7 v0.10-A 门槛加一条：Traces 时间线必须复用既有 `buildGeometry`，不得新增几何（§3） | v0.10-A 首个 PR |
| 3 | 把 `timeline_series` 定义为 `project(TraceGraph, linearization)` 的**输出类型**，在 domain 实现该纯函数；下游喂 `buildGeometry` | v0.10-A |
| 4 | 订正 `TRAJECTORY_TIMELINE_SPEC.md` 状态头（§1.2） | 随手 |
| 5 | Quota 语义：要么接进 §2.2.1，要么显式声明延后（F-T7） | v0.10-B |

> 顺带：`TRAJECTORY_TIMELINE_SPEC` §8 的「task/goal 未映射」缺口（`goal_id` 把 `/goal`
> 文本命令与 task 跟踪结构化列表合并成一个字段，两者都没映射，`canonical_session.rs`
> 写死 `None`）与 v0.10 §2.1 的 `task_id: Option<String>` 直接相关。该文档已给出三分法
> （`/goal` 文本 / 结构化 task 跟踪 / Codex 的 task=turn），v0.10 应照它区分，
> **不要再引入一个含糊的 `task_id`**。
