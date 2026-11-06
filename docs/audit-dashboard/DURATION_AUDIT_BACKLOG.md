# 执行时长与延迟审计 — 开发任务清单

> 起因：`GOVERNANCE_BACKLOG.md` 分析"task 超时"这类痛点时发现，DSH 日志里除了
> `tool/result.error.code=TOOL_TIMEOUT`（单次工具调用、harness 自报，SV608 已覆盖）
> 之外，**没有任何原生"耗时"字段**——turn 花了多久、step 花了多久、审批等了多久、
> hook 执行了多久，这些全部要靠 `seq`/`time` 配对自己算，而且现状是**一个都没算**
> （`skill.rs` 的 `duration_ms` 是唯一例外，还只做了 `name="skill"` 这一个工具）。
> 本文档没有独立 PRD——`GOVERNANCE_BACKLOG.md` 是它的需求来源，本文档本身兼任
> 实施规格。按依赖排序，格式仿 `SKILL_EXECUTION_BACKLOG.md`。

---

## 0. 前提说明（做之前必须先看）

**1. 这是一个新的、独立的数据产品，不塞进 `skillAudit` 或 `behaviorFindings`。**
`skillAudit` 只管 `name="skill"` 这一个工具的调用；`behaviorFindings`（SV601–614）
是"结构性异常"的固定规则（签名重复 ≥3 次这种），不是连续量的时长。本 backlog 做的
是"抽取所有工具调用/turn/step/审批的时长数字"，命名为 **Duration Audit**，与前两者
平行，复用同一批底层事件（`execution_events`）但产出独立的投影/wasm 导出。

**2. 阈值判断留在客户端，不进 core 规则引擎，不生成新的 SV 规则码。**
理由两条：
- DSH 不提供任何"这个 turn 正常应该多久"的基线（`GOVERNANCE_BACKLOG.md` 已经论证
  过），core 里硬编码一个固定阈值（像 SV611 那样"≥3 次"）没有事实依据，纯属拍脑袋；
- `PRD.md` §3.2 明确要求"不得设计任何看起来会暂停 Agent/阻止工具的控件，除非该
  能力已经真实存在"——如果把阈值判断做成 core 规则、客户端只是展示"命中/未命中"，
  容易演变成看起来像治理判决的东西。**只做纯展示：core/wasm 只出数字，客户端按用户
  自己设的阈值（本地存储，不需要后端）高亮，与 `GOVERNANCE_BACKLOG.md` G1 预算阈值
  同一模式**——这条边界要写进每个改动点的注释，不然容易在 UI 迭代时不小心滑成"建议
  拦截"的措辞。

**3. 主体逻辑已经有三份现成模板，照抄不是从零写：**
- `crates/agent-vitals-core/src/domain/skill.rs` 的 `callId` 配对 + `missing_fields` 纪律
  （T3 抄的是 `subagent.rs`，这次抄 `skill.rs` 更近，字段形状几乎一样）；
- `crates/agent-vitals-core/src/domain/subagent.rs:57` `subagent_spawns()`——同款 `callId`
  索引 → 结果侧按 `/data/message/source/callId` 回连；
- `crates/agent-vitals-core/src/domain/trajectory.rs:77` `coord_map()`（`pub(crate)`）——
  turn/step 坐标查表，直接复用，不要重新扫一遍 `turn/start`/`step/start`。

**4. 一个真实存在的坑，`fixtures/dsh/README.md` 已经踩过、写进了文档：**
`approval/asked`/`approval/decided` 的关联键是事件的 **`id`**，**不是 `callId`**
（`approval/asked.data.callId` 是可选字段）。照 `callId` 配对会把大量审批错误地
标成"孤立"或配对到错误的调用上。

---

## 1. 任务清单

### P0 — 数据通路（core → wasm → 执行环境投影）

#### D1 · 新建 `crates/agent-vitals-core/src/domain/duration.rs`：通用工具调用耗时
把 `skill.rs` 里"`callId` 配对 `tool/call`↔`tool/result`、算 `duration_ms`"这段逻辑
**推广到所有工具**，不再局限于 `name="skill"`。

产出 `ToolCallDuration[]`：

| 字段 | 来源 | 缺失时 |
|---|---|---|
| `call_id` | `tool/call.data.callId` | 没有 `callId` 的调用整条跳过（无法配对，不是"耗时未知"，是"这条数据结构上就配不了对"，两者不同，进 `missing_fields` 用不同的词区分） |
| `tool_name` | `tool/call.data.name` | null |
| `duration_ms` | `tool/result.time − tool/call.time` | 找不到匹配的 `tool/result` → `null`，**绝不填 0**；`load_status` 标 `incomplete`（照抄 `skill.rs` 三态：`loaded`/`failed`/`incomplete`，`failed` 判定复用 `tool/result` 的 `data.error` 或 `content[].isError`） |
| `turn`/`step` | 复用 `trajectory::coord_map`（`pub(crate)`，直接调） | null |
| `seq` | `tool/call` 自带 | — |

- 纪律：和 `skill.rs` 一样，缺失字段进 `missing_fields`，不填默认值。
- lockstep：`scripts/agent_vitals/agent/duration.py`
- 测试：core `#[cfg(test)]` + `tests/test_degradation.py` 新增一类（残缺日志不能崩）
- ⚠️ **新 Python 模块要登记两处白名单，漏一处 CI 才报错**（T3 建 `skill.py` 时踩过，
  commit 原话："两处都漏一个都会在真实 CI 里报 'Unexpected file'"）：
  1. `tests/test_clawhub_packaging.py` 的 `ALLOWED_PACKAGE_FILES`
  2. `.github/workflows/package-clawhub.yml` 里那个 `case` 分支的文件名列表
  这两处**已经漂移过一次**：`model.py` 在 ①里、不在 ②里，而 `scripts/agent_vitals/`
  下根本没有这个文件——白名单留了个永不匹配的条目没人发现。说明这不是"照着改一处
  就顺手改另一处"的机械工作，两处都要自己核一遍。
- ⚠️ 规模提醒：一个真实会话可能有几百次工具调用，输出数组会比 `skillAudit` 大一个
  数量级——客户端渲染（D7）默认只显示 Top N（按 `duration_ms` 降序），不是全量平铺，
  这条决策现在就定，不要留到 D7 才发现列表爆炸。

#### D2 · Turn / Step 时长
同一个 `duration.rs` 模块加两个函数（或者三个数据流合一个函数出三个数组，具体看
实现时哪个更省重复扫描——**这是实现细节，不是设计决策**，两种写法都要满足下面的
契约）：

- `turn/start`↔`turn/end`，按 `data.turn` 配对 → `TurnDuration[]`
  `{turn, duration_ms, seq_start, seq_end, ended_reason}`（`ended_reason` 抄
  `trajectory.rs` 已经在用的 `reason.kind`，方便客户端把"慢"和"以 error 结束"两个
  维度一起看，不需要去 `behaviorFindings` 里反查）
- `step/start`↔`step/end`，按 `(turn, step)` 配对 → `StepDuration[]`
  `{turn, step, duration_ms, seq_start, seq_end}`
- 缺失配对（只有 start 没有 end，会话在这个 turn/step 中途结束/被截断）→
  `duration_ms: null`，标 `incomplete`，**不是**"这个 turn 没有发生"。

#### D3 · 审批等待延迟
按 **`id`** 配对 `approval/asked`↔`approval/decided`（§0 第 4 条的坑，配对键写错
这一个函数就全废）→ `ApprovalLatency[]`：
`{id, tool_name, wait_ms, outcome, turn, step, seq}`
- `tool_name` 来自 `approval/asked.data.toolName`（注意字段名是 `toolName`，
  不是靠 `callId` 反查工具名——`asked` 事件自己就带了）。
- `outcome` 来自 `approval/decided.data.outcome`
  （`allowed-once`/`rejected`/`cancelled`/`unavailable`）。
- 只有 `asked` 没有 `decided`（人一直没处理，或会话在等待中结束）→
  `wait_ms: null`，标 `pending`（这是第三种状态，不是 `incomplete`——`incomplete`
  暗示"本该有结果但配对失败"，`pending` 是"确实还没决定"，两者对用户的含义不同，
  UI 措辞也要分开，不能都显示成"—"）。

#### D4 · Hook 消费抽取（core 已完成，执行环境前提仍未验证）

`crates/agent-vitals-core/src/domain/duration.rs::hook_executions` /
`scripts/agent_vitals/agent/duration.py::hook_executions` 已实现——直接抽取
`hook/result`（不需要跟 `hook/invoked` 配对减时间戳，`durationMs` 已经是
harness 算好的值），带 `decision` 分布计数。CLI 侧（`src/dsh.rs` 的
`EXECUTION_EVENT_TYPES` 已收 `hook/*`）立即可用，测试齐全（core 8 个 +
Python characterization 6 个 + degradation 5 个，含双侧手工逐字节钉同一串）。

**但 D6 的执行环境接线（把 `hook/*` 加进 `dsh-client/src/harness/index.ts` 的
`RELEVANT_TYPES`）故意没做**——下面这段原始的"开工前必须先验证"依然成立，
本次开发环境里没有真实 DSH 执行环境可以跑一遍实测，无法诚实地把这一项标记为
"已验证"。不做的选择本身就是在执行下面这条纪律：验证不通过（或验证不了）
就不能把成本估进"只是加个过滤条件"。等有人拿真实会话跑通验证之后，再补
D6 那一侧的接线——`hook_executions` 本身已经就绪，届时只是把它接进执行环境投影，
不需要再动 core。

> ⚠️ **开工前必须先验证一件事，否则这一项可能整个落空。**
> `hook/invoked`/`hook/result` 在 CLI 侧确实进了 `EXECUTION_EVENT_TYPES`
> （`src/dsh.rs`，读的是落盘 JSONL），但**执行环境侧从来没有收集过它们**：
> `dsh-client/src/harness/index.ts` 的 `RELEVANT_TYPES` 只有 `tool/*`、`approval/*`、
> `sandbox/mode` 和四个 turn/step 边界 + `session/end-seed`，`hook/*` 一个都不在。
> 也就是说「执行环境能不能看到 hook 事件」目前**没有任何证据**——它可能像 approval 一样
> 照常推送（只是没人订阅），也可能压根不进执行环境的实时事件流。
> **验证方法**：在执行环境 `apply()` 里临时放行 `hook/*` 并打一条日志，拿真实会话跑一遍
> （或直接问 DSH 侧的事件流契约）。**验证不通过就把 D4 从本 backlog 划掉**，别按
> "只是加个过滤条件"的成本估进排期——这正是 `SKILL_EXECUTION_BACKLOG.md` §0 那张
> "声称 vs 实际"表要防的同一类误判。
> 另外：D4 是 §3 建议优先级里**最低**的一项（多数会话压根没配自定义 hook），
> 验证成本如果偏高，直接后移比硬做划算。

`hook/result.durationMs` 是 harness **自己算好写进日志的**，不需要配对，直接抽取
即可 → `HookExecution[]`：`{handler_id, point, decision, duration_ms, turn, seq}`。
- `duration_ms` 直接取 `hook/result.data.durationMs`（如果这个字段本身缺失才是
  `null` + `missing_fields`，多数情况下应该是齐的，因为是 harness 自己写的）。
- 顺带把 `decision` 分布（`pass`/`deny`/其他）在同一份输出里给出计数——这是
  `GOVERNANCE_BACKLOG.md` 提到的"不需要基线就能用"的信号，`hook/invoked`↔
  `hook/result` 按 `handlerId` 配对（`fixtures/dsh/README.md` 已写明关联键），
  取 `hook/result` 那一条即可，不需要真的拿 `hook/invoked` 的时间去减——
  `durationMs` 已经是 harness 算好的排队+执行总时长，自己再减一次时间戳算出的
  是"两条日志之间的墙钟差"，两个数字含义不同，不要混用，注释里写清楚。

#### D5 · wasm 导出
- 改：`crates/agent-vitals-wasm/src/lib.rs` 加
  `pub fn duration_audit(events_json: &str) -> String`
- `wasm-pack build --target web`，拷贝 `pkg/*.js` + `*_bg.wasm` 进 `dsh-client/`
- 改：`dsh-client/agent_vitals_wasm.d.ts` 补声明
- ⚠️ wasm↔CLI 漂移没有自动测试守，手工拿同一份 fixture 两边对一遍（`behavior.jsonl`
  就有 turn 9–14 的轨迹级案例，够用来对拍）

#### D6 · 执行环境 `durationAudit` 投影
- 改：`dsh-client/src/harness/index.ts`
- ⚠️ `stateVersion` 必填非负整数——这次是全新投影，从 `1` 起（不是延续
  `skillAudit` 的版本号，两个投影独立计数）
- ⚠️ `apply()` 必须展开前态（`{...state, …}`），返回裸字面量会静默丢
  `seed`/`cwd`/`sessionId`（T5 踩过、`skillAudit` 也这么写的，这次照抄不要犯同样的
  错）
- ⚠️ 分叉过滤：走 `withSeed`+`seeded`，和 `tokenByModel`/`skillAudit` 同一套——
  分叉前的调用/turn/审批不算进本会话
- 事件收集范围：新投影自己的过滤集合 = `skillAudit` 的 `SKILL_EXEC_TYPES`
  （`tool/call`/`tool/result`/`turn/*`/`step/*`）**加上** `approval/asked`/
  `approval/decided`（D3 要）和 `hook/invoked`/`hook/result`（D4 要）。
  三者在执行环境侧的现状**各不相同**，别当成一类：
  | 事件 | CLI（`src/dsh.rs`） | 执行环境（`harness/index.ts`） |
  |---|---|---|
  | `tool/*`·`turn/*`·`step/*` | ✅ 在 `EXECUTION_EVENT_TYPES` | ✅ `skillAudit` 与 `behaviorFindings` 都在收 |
  | `approval/asked`·`approval/decided` | ✅ | ✅ 已在 `behaviorFindings` 的 `RELEVANT_TYPES`（SV609/610/614 靠它）——**已验证执行环境拿得到**，新投影照抄即可 |
  | `hook/invoked`·`hook/result` | ✅ | ❌ **任何投影都没收过**，执行环境能否拿到未经验证（见 D4 的前置验证） |
- 测试：`dsh-client/scripts/verify-harness.mjs`

---

### P1 — UI（依赖 P0 全部完成）

#### D7 · DurationSection 组件：慢工具调用 / 慢 Turn / 慢 Step
- 新组件 `dsh-client/src/client/components/audit/DurationSection.tsx`，结构仿
  `SkillSection.tsx`（摘要行 + 列表 + 展开抽屉）
- 默认只显示 **Top N**（建议 N=20，和 `FindingGroup` 的 `GROUP_PAGE_SIZE` 一致
  口径）按 `duration_ms` 降序，"查看全部"按钮展开——D1 已经提醒过量级问题，这里
  落地
- 阈值：用户可设一个"多久算慢"的数字（毫秒），本地存储（`localStorage`，不需要
  后端，和 `GOVERNANCE_BACKLOG.md` G1 同一模式），超过阈值的行视觉高亮（颜色/
  标记），**没有任何"暂停"/"拦截"按钮**——纯展示，§0 第 2 条边界
- `incomplete`/`pending` 状态明确用不同文案（不能都显示"—"，那样用户分不清是
  "还没轮到"还是"数据缺失"）
- ⚠️ **i18n 中英双语 key 全套补齐**（`dsh-client/src/client/i18n.ts` 的
  `STRINGS['zh-CN']` 与 `STRINGS['en']` 两份都要有）。这条整个 backlog 原来漏了，
  但它是硬性的：`scripts/verify.mjs` 断言 tab 标签在两种 locale 下分别解析成
  「审计」/「Audit」，`verify-render.mjs` 也有整组英文渲染断言。
  **顺带修一处已有的不一致**：`SkillSection.tsx`（T8）里 `TriggerBadge` 的
  '显式'/'模型'、`LoadBadge` 的 '已加载'/'失败'/'未完成' 是**硬编码中文**、没走
  `t()`，英文 locale 下会漏出中文。新组件别照抄这个写法。
- ⚠️ **新区块要挂 `data-audit-*` 标记并登记进 `verify-render.mjs`**：
  `REGIONS` 数组（该文件 §T2 跨会话差异断言）目前是 verdict/summary/tokens/
  tokenbar/cost/subagents/timeline/composition/findings 九项。
  **`data-audit-skills` 不在里面**——T8 的 SkillSection 至今没有任何 render 侧
  断言覆盖（既不在 REGIONS，也没有独立断言）。新区块别重蹈：加 `data-audit-duration`
  的同时把它加进 `REGIONS`，并补一条"数据缺失时不渲染假数字"的独立断言。

#### D8 · 审批延迟 + Hook 消费面板（审批延迟已完成，Hook 面板未做）

**审批延迟列表已实现**：`DurationSection.tsx` 加了第 4 个子列表（复用同一套
`DurationList`/`StatusBadge`，`wait_ms`/`status` 字段别名成 `duration_ms`/
`load_status` 接进去，不另开一套渲染逻辑）。`decided`/`pending` 两态文案分开
（`durationStatusDecided`/`durationStatusPending`），不共用"—"。

**与 SV609/610 finding 的交叉引用没做**，理由是查过 `behavior.rs` 之后发现
原文的前提不成立：Finding 结构上**没有 approval 的 `id` 字段**——
`call_id` 对审批类 finding 通常是 `null`（`approval/asked.data.callId` 本来
就是可选字段），`evidence` 里放的是 `reason`（SV609）/`outcome`（SV610）文本，
不是 `id`。逐字实现"同一个 approval id 交叉引用"在当前数据结构下做不到；
退一步做"同 turn 共现"（`xrefRules` 那种模式）又是凭空引入一个新的猜测关联
维度，不如不做。这条同 `SKILL_EXECUTION_AUDIT_PRD.md` §9.1"对现有数据能力
的判断有几项要打折扣"是同一类问题——原文的假设值得先核实，不是照单实现。

**Hook 面板没做**——D4/D6 已经决定 `durationAudit` 投影不携带 `hook/*`
数据（执行环境前提未验证），渲染一个永远拿不到数据的面板不是"占位"，是假装
有一个从没生效过的功能。`verify-render.mjs` 专门断言了"审计 tab 里不出现
Hook 相关文案"这条边界，防止以后有人顺手把它加回来又忘了检查前提。

- 归入 PRD §6.1 现有的"归因与优化线索"区块（`P1-06` 已经把常驻前缀/结构性浪费/
  子代理/Skill 四者放进同一区块各自一张 `.sv-subcard`），审批延迟加进 D7 已有
  的 `DurationSection` 这张 `.sv-subcard` 里，不新开一级区块、也不新开一张
  `.sv-subcard`——保持 `AUDIT_TAB_DESIGN.md` P1-06 定的"概览→时间线→
  归因与优化线索→Finding 队列"四段式不变。

#### D9 · 时间线接入（可选，视 P0/D7 完成后的余量决定）
- 慢工具调用/慢 turn 在时间线上加标记，用**形状**区分（同 T9 的纪律：显式调用是
  菱形、模型选中是圆点——"慢"这个新维度也不能只靠颜色，颜色已经被严重度占用了）
- 不是本 backlog 的阻塞项，D1–D8 已经能独立交付一个可用的"时长审计"面块

---

### P2 — 收尾

- **D10** 导出：走 `export.ts` 的 `buildExportPayload`，仿 T10 加一个 `duration`
  键——**别忘了同步更新 `verify-export.mjs` 的键数契约**（T10 当时就漏了这步，
  `GOVERNANCE_BACKLOG.md` 前置的排查已经修过一次，这次提前打个预防针）
- **D11**（已完成）CLI 对齐：两样都做了，不是"或者"二选一——`behavior --json`
  加了 `duration` 键，也仿 `skill-audit` 加了独立的 `duration-audit` 子命令
  （Rust `src/main.rs::Cmd::DurationAudit` + Python `cli.py` 的
  `duration-audit` 子解析器），`--json` 输出两处逐字节相同（同一次
  `audit_session_log` 调用）。`hooks` 是 CLI 独有的一项——CLI 直接读盘上的
  原始 JSONL，`hook/*` 本来就在 `EXECUTION_EVENT_TYPES` 里；浏览器的
  `durationAudit` 投影不携带它（D4/D6 的决定）。
  过程中顺手发现并修了一个更早、更大的 Python CLI 缺口：`behavior.py::
  audit_session_log` 一直没有返回 `skill`（T11 的技能触发记录）——Rust 侧
  早就有、Python 侧从来没接，`behavior --json` 的 Python 输出因此比 Rust 少
  一个键，只是没有测试盯住这个键的存在性所以一直没被发现。这次加 `duration`
  时顺手一起补上（Python 侧仍然没有独立的 `skill-audit` 子命令——那是更早
  的 T11 遗留项，不在本 backlog 范围内，只修了 `audit_session_log` 返回值
  和 `behavior --json` 的输出）。
  `test_cli_matrix.py` 新增四个差分测试（`duration` 键结构 + hooks 非空、
  `duration-audit --json` 与 `behavior --json` 的 `duration` 键完全一致、
  人读格式、空数据文案），另修了两处被这次改动波及的**已有**测试（硬编码
  的 `behavior --json` 键列表断言，从 10 键改成 12 键）。
- **D12**（已完成）主题 token 化：D9 的"慢"时间线标记本来就直接用了
  `T.warn`（现成的 alias token），没有另写一个新的 hex——这条在 D9 提交时
  就已经满足。真正需要补的是另一处：D7 的 `DurationSection.tsx::StatusBadge`
  为了跟 `SkillSection.tsx::LoadBadge`（T8）视觉一致，直接抄了它的
  `'#f87171'`（failed 状态色），是 D7 自己新写死的一份 hex。提成
  `--sv-status-failed`（`styles/index.ts`，同 T12 的 `--sv-skill-explicit`/
  `--sv-skill-model` 一个模式），两个文件的 badge 都改用这个变量。
  顺带修了一个因此浮出水面的真实 bug：两处 badge 原来都用
  `color + '40'`（十六进制字符串拼接 alpha 后缀）算边框色——这个技巧只对
  纯 hex 字符串有效，对 `T.success`/`T.warn`/`--sv-status-failed` 这类
  `var()` 引用会拼出无效 CSS 值，边框颜色因此静默失效（`loaded`/
  `incomplete`/`decided`/`pending` 四态本来就都是这样，只是 `failed` 原来
  恰好还是裸 hex 所以"看起来没坏"；这次把 `failed` 也换成变量后，如果不
  一起修，四态就全坏了）。两处的 `bg`/`border` 统一改用已有的 `tint()`
  （`color-mix(in srgb, ...)`），不再用字符串拼接。

---

## 2. 明确不做 / 推迟到别的 backlog

| 想法 | 为什么不在本 backlog |
|---|---|
| 把"慢"做成新的 SV 规则码（比如 SV615）| §0 第 2 条已经论证：没有基线，硬编码阈值等于拍脑袋，且容易滑向"看起来能拦截"的边界。阈值留客户端可配置 |
| 历史基线（"这个 turn 比过去 30 次平均慢 3 倍"）| 这是 `GOVERNANCE_BACKLOG.md` G4 的范围（依赖 PRD V2.1"缓存命中历史基线"排期），本 backlog 只做单会话内的绝对数字，不做跨会话对比 |
| 真正的超时熔断（执行到一半就掐断）| `GOVERNANCE_BACKLOG.md` §3 已经论证过：`dsh-client` 插件是纯读投影，没有执行前拦截钩子，结构性做不到 |

---

## 3. 建议范围（V1 最小可用集）

关键路径：**D1 → D2 → D3 → D4 → D5 → D6**，之后 UI 才能动（D7/D8）。D9/D10/D11/D12
都是独立收尾项，互相没有依赖，可以并行或按余量取舍。如果要进一步收窄 V1，优先级
D1（通用工具调用耗时，用户最直接能感知"这次卡在哪一步"）> D3（审批延迟，人机
协同的真实瓶颈）> D2（turn/step 时长，判断"整体是不是变慢了"）> D4（hook 消费，
分布最小众，多数会话可能压根没有自定义 hook）。

---

## 4. 全程纪律（与 `SKILL_EXECUTION_BACKLOG.md` 一致，不重复造轮子）

1. **四方 lockstep**：core（Rust）↔ `scripts/agent_vitals/`（Python）↔ wasm（重编译
   并拷贝）↔ 执行环境 TS。差分 golden 守 Python↔Rust；wasm↔CLI 漂移没有自动测试，必须
   手工验
2. **golden `--update` 前逐字确认**——不过本 backlog 的改动大概率不touch
   `scan.py` 的 `context_composition` 路径（`duration.rs` 走的是 `execution_events`，
   和 `skill.rs` 当初"未动 golden"是同一个理由），实现时第一件事就是跑一遍
   `python3 tests/golden_runner.py` 确认这个判断没错，不要假设
3. **缺数据一律 `null` + `missing_fields`，绝不填 0**——尤其注意 `incomplete`（配对
   失败）和 `pending`（确实还没发生）不是同一个语义，不能共用一个"缺失"标签
4. **前端不得用推测值填补**——没有阈值就不高亮，不能因为"多数请求在 2 秒内"就
   悄悄假设 2 秒是阈值
