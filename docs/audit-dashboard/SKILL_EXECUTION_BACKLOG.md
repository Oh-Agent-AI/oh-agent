# Skill 执行审计 — 开发任务清单

> 来源：`SKILL_EXECUTION_AUDIT_PRD.md`（V0.1，2026-08-23）+ v3 交互原型
> 本文档写的是**按依赖排序的可执行任务**，不是需求。需求以 PRD 为准。
> 每条都标注了改哪些文件、lockstep 义务、测试义务。

---

## 0. 前提更正（做之前必须先看）

PRD §9.1 声称「现有数据已经能够提供」五项。逐条查过代码，**四项要打折扣**：

| §9.1 声称 | 实际 | 位置 |
|---|---|---|
| 最近一次 catalog 名单 | binary 有，**审计 tab 没有** | `src/dsh.rs:209` 出名单；`crates/agent-vitals-core/src/domain/usage.rs:471` 只出 `list.len()` |
| 用户显式调用名称集合 | **只有名字，位置全丢** | `src/dsh.rs:183` `invoked.push(name)` |
| 模型选择名称集合 | 同上，但**原始事件还在** | `tool/call` 在 `execution_events`，`data` 整个保留 |
| `invoked_counts`/`selected_counts` | **binary 独有，core 里没有** | `src/analysis.rs:577` |
| `tool/call`/`tool/result`/Turn/Step | ✅ 真的有 | `EXECUTION_EVENT_TYPES` 18 类，含 turn/step 四个边界 |

**一句话结论：审计 tab 目前能看到的 skill 数据是一个整数。** 数据不是不存在，是全在 wasm
边界的另一侧（CLI 侧），或者在抽取时被压扁成了名字列表。

### 好消息：主体逻辑有现成模板

`crates/agent-vitals-core/src/domain/subagent.rs` 已经实现了 skill.rs 需要的**同一套 callId 配对**：
按 `data.callId` 建索引 → 在结果侧用 `/data/message/source/callId` 回连 → 输出
`{seq, time, turn, step, call_id, agent_id, description}`。turn/step 顺延也有现成的
`trajectory.rs::coord_map` / `fill_coords`。T3 是照着抄，不是从零写。

---

## 1. 任务清单

### P0 — 打通数据通路（不做这些，UI 一行都写不了）

#### T1 · catalog 名单出到 core 输出
**性质：加一行。** `usage.rs` 为了算 `catalog_tokens` 本来就在遍历 `entries[].name +
description`，只是最后只输出了 `len()`。

- 改：`crates/agent-vitals-core/src/domain/usage.rs:471` 附近，新增 `catalog_names`
- **隐私决策（必须先定）**：只出 `[{name, tokens}]`，**不出 description 原文**。
  理由：FR-SK-09 要求导出不含未脱敏内容；description 是内容，一旦进投影就会
  进导出。逐 skill「目录 Token」用 `tokens` 就够，不需要原文。
- lockstep：`scripts/agent_vitals/agent/usage.py`
- 测试：core `#[cfg(test)]` + `tests/test_characterization.py`
- ⚠️ **动 golden**：`--update` 前逐字确认 diff
- 解锁：FR-SK-02 摘要可下钻、AC-SK-01 目录 vs 触发、逐 skill 目录 Token

#### T2 · `skill-invocation` 进执行事件流
显式调用事件现在**既不在** `EXECUTION_EVENT_TYPES`（18 类里没有）**也不在** usage 事件里
（`is_usage_event` 只认 `skill-catalog`），唯一去处是 `invoked.push(name)`——
turn/step/seq/time/session 全部蒸发。

- 改：`src/dsh.rs`
- ⚠️ **实现细节，别踩**：`skill-invocation` 挂在 `user/message` 的 `data.source.kind`
  上，**不是独立事件类型**。必须照 `is_usage_event` 对 `skill-catalog` 的做法按
  `source.kind` 判断。把 `user/message` 加进 type 白名单会把**所有用户消息**
  收进事件流——体积爆炸 + 把用户 prompt 原文带进投影和导出。
- lockstep：`scripts/agent_vitals/dsh.py`
- ⚠️ **动 golden**
- 解锁：FR-SK-05 B 组（每次调用的 Turn/Step/seq/时间）

#### T3 · 新建 `crates/agent-vitals-core/src/domain/skill.rs`
**主体工作量。** 照 `subagent.rs` 的 callId 配对写。

产出 `SkillInvocationEvent[]`（PRD §9 契约）：

| 字段 | 来源 | 缺失时 |
|---|---|---|
| `triggerMode` | `skill-invocation` → explicit；`tool/call name="skill"` → model_selected | unknown |
| `loadStatus` | callId 配对到 `tool/result`，看 `isError` / `data.error` | 有 call 无 result → `incomplete` |
| `durationMs` | `tool/result.time − tool/call.time` | **`null`，绝不填 0**（§8） |
| `turn`/`step` | 复用 `trajectory.rs::coord_map` | null |
| `seq`/`requestSeq` | 事件自带 / 就近 `request/header` | null |

- 纪律：缺失字段进 `missingFields` 数组输出，不填默认值
- lockstep：`scripts/agent_vitals/agent/skill.py`
- 测试：core 单测 + `tests/test_degradation.py`（残缺日志不能崩、缺的要浮出来）
- 参考真实量级：唯一实测样本 `turn:5 step:3`，**Δt = 18ms**（原型写的 1.2s/3.4s 差两个数量级）

#### T4 · wasm 导出 `skill_audit`
- 改：`crates/agent-vitals-wasm/src/lib.rs` 加 `pub fn skill_audit(events_json: &str) -> String`
- `wasm-pack build --target web`，把 `pkg/*.js` + `*_bg.wasm` 拷进 `dsh-client/`
- 改：`dsh-client/agent_vitals_wasm.d.ts` 补声明
- ⚠️ wasm↔CLI 漂移**没有自动测试守**，必须手工拿同一份 fixture 两边对一遍

#### T5 · 执行环境 `skillAudit` 投影
- 改：`dsh-client/src/harness/index.ts`
- ⚠️ **`stateVersion` 必填**（非负整数）。漏了会让**整个插件树加载失败**，不是这一个投影失败——踩过
- ⚠️ `apply()` 必须展开前态（`{...state, …}`）。返回裸字面量会静默丢掉 `seed`/`cwd`/`sessionId`——踩过
- ⚠️ 分叉过滤：skill 触发是**流量**，不继承上游。走 `withSeed` + `seeded`，和
  `tokenByModel` 同一套
- 测试：`dsh-client/scripts/verify-harness.mjs`

#### T6 · 子 Agent 聚合与覆盖率（FR-SK-01）
能力都在（执行环境 `readZstdFrames` 已能读兄弟会话，`subagent.rs` 在 core），缺组装。

- 输出 `sessionsDiscovered` / `sessionsCovered` / 缺失清单
- ⚠️ AC-SK-05：**同名 skill 跨 Agent 不能错误去重**。去重键是 `(sessionId, skillName)`，
  不是 `skillName`——这和仓库里插件去重用 `(namespace, name)` 是同一条教训
- 子 Agent 日志缺失时**不得**把全会话树结果显示为完整

---

### P1 — UI（依赖 P0 全部完成）

#### T7 · 修 v3 原型已复现的 6 个 bug
搬进 React 前必须修，否则会变成难查的状态竞争。

| # | 问题 | 根因 |
|---|---|---|
| ① | 筛「已验证」把「未验证」也显示 | `data-kind.includes('verified')`，`"unverified".includes("verified")` 为真 |
| ② | 点页面任意处清空 Tweaks 选中态 | `querySelectorAll('[data-state]')` 匹配到了 `<body data-state>`，给 body 绑了监听 |
| ③ | 筛选与搜索互相覆盖，chip 仍显示选中 | 两个 filter 各写各的 `hidden` |
| ④ | 声明 4 条 Finding 只渲染 3 条 | 原型数据自身不一致 |
| ⑤ | 关抽屉后焦点留在 `aria-hidden` 容器内 | 未归还触发元素；抽屉收起时内有 3 个可聚焦元素 |
| ⑥ | 窄屏 4 列定义 vs 3 个可见子元素 | 780px 断点 `nth-child` 隐藏数算错 |

①②③ 同一根因：**用 DOM 属性当状态存储，选择器再回头查**。
修法：**单一求值点**——`{筛选条件, 搜索词} → 计算可见集`，其余只读。

#### T8 · Skill 摘要 + 列表 + 抽屉（FR-SK-02/04/05）
- 摘要一行紧凑统计，**不新增 KPI 卡**（PRD 明确）
- 列表默认排序：失败 → 有 Finding → 关联费用高 → 最近触发 → 名称
- 「未触发」文案必须限定当前范围，不得暗示「无用」
- ⚠️ 补回原型丢掉的三条已上线披露：**总额下限口径 / 供应商与报价来源 / 分叉继承**
  （这三条现在都有 `verify-render` 断言守着，别改回去）

#### T9 · 时间线 Skill 事件层（FR-SK-03）
- ⚠️ 不变量：**聚合只影响绘制，底层事件一条不丢**。已有 `eventsIn === eventsOut`
  断言，扩展到 skill 事件
- 显式调用 vs 模型选择用**形状**区分，不能只靠颜色
- 风险事件与 skill 同位置时两者都要可达

---

### P2 — 收尾

- **T10** 导出（FR-SK-09）：走现有 redact 管道，含覆盖率/调用/估算假设
- **T11** CLI 对齐：`src/analysis.rs` 的 `invoked_counts`/`selected_counts` 改成从 core
  `skill.rs` 取，消除第二份实现；考虑加 `skill-audit` 子命令（对标现有 `behavior`）；
  接进 `test_cli_matrix.py` 双实现差分
- **T12** 主题 token 化：原型 **16 处硬编码 hex vs 11 处走 `var(--dsw-alias-*)`，零暗色适配**。
  等 `brand-spec.md`

---

## 2. 明确推迟 —— 数据不支持，不是排期问题

| PRD 要求 | 为什么做不了 |
|---|---|
| FR-SK-05 A：version / source / path / contentHash | **会话日志完全没有**。这是 §15 待确认第 8 条的答案：没有唯一来源。要么跨源关联磁盘扫描侧（`inventory.rs` 有 hash），要么砍掉 |
| FR-SK-06：`verified` / `partially_verified` | DSH **没有统一的测试/验收事件**（§15 第 5 条）。日志里只有 `tool/result` 的 `isError` 和 `data.error`（实测 6766 条结果里 200 次 error）。**V2 现实上只能做出 `verification_failed` / `unverified` / `unavailable` 三态** |
| FR-SK-04：关联费用列 | core 的成本只出聚合；逐请求定价需要每笔自己的高峰/空闲判定，那条规则在 core 且只经聚合暴露。要么 core 补出逐请求成本（**第五处 lockstep**），要么这列不上 |

**效果验证这条要特别说清楚**：PRD 把 `verified` 写进了 FR-SK-02 摘要（「2 个结果已验证」）
和 FR-SK-04 状态列。数据不支持的情况下，摘要那一格只能是「N 个验证失败 · M 个未验证」。
原型里绿色的「已验证」徽章 + 抽屉里「参与了已验证任务，不代表单一因果」的免责声明，
是**克制的话在抽屉里、会计感的结论在表格里**——用户记住的是表格。

---

## 3. §15 待确认项的已验证答案

查代码 + 真实日志验证过的：

| # | 问题 | 答案 |
|---|---|---|
| 2 | `tool/call` 与结果能否总用 `callId` 关联 | ✅ 能。`subagent.rs` 已在生产中这么做 |
| 4 | 子 Agent 的 sessionId / 父 sessionId / 启动 Turn 是否完整 | ✅ 可读。执行环境已能读兄弟会话 |
| 5 | 是否有统一的测试/验收结果事件 | ❌ 没有 |
| 8 | Skill 版本与内容哈希的唯一来源 | ❌ 会话日志里没有 |

其余（1、3、6、7、9、10）仍需确认。

---

## 4. 建议的 V2 范围

砍成这样全部有真实证据支撑，且不需要改 DSH：

> catalog 名单（含逐条 token）· 显式/模型选择分别计数且带 Turn/Step/seq 位置 ·
> callId 配对出的加载成功/失败/证据不完整 · 加载耗时 · 子 Agent 覆盖率 · 关联 Finding

关键路径：**T1 → T2 → T3 → T4 → T5 → T6**，之后 UI 才能动。

---

## 5. 全程纪律

1. **四方 lockstep**：core（Rust）↔ `scripts/agent_vitals/`（Python）↔ wasm（重编译并拷贝）
   ↔ 执行环境 TS。差分 golden 守 Python↔Rust；**wasm↔CLI 漂移没有自动测试，必须手工验**
2. **golden `--update` 前逐字确认**。反射性 `--update` 会把 golden 变成「当前行为的记录」，
   测试就不再有意义
3. **缺数据一律 `null` + `missingFields`，绝不填 0**。PRD §8 和仓库既有纪律一致：
   报表缺一列有用，缺一列却编个数出来没用
4. **前端不得用推测值填补**（PRD §739）

---

## 6. 完成状态（2026-08-24）与遗留项

**T1–T6、T8–T12 已实现并验证**：Python 426 / Rust 137+90 全绿，`cargo clippy`、
golden 双实现差分、TS 类型门、`verify`/`verify:harness`/`verify:render`/`verify:export`/
`verify:timeline` 五个脚本、CLI `skill-audit` 子命令实测均通过。

**T7 自然作废**：那 6 个 bug 是 v3 原型「用 DOM 属性当状态存储、选择器再回头查」
特有的，重写成 React 后（单一求值点）没有对应物，不是跳过。

**验收时发现并已修的三个真问题**（都不是 T1–T12 的设计问题，是实现/协同缺口）：
1. `SkillSection.tsx` 多一个右括号 → 整个文件语法解析失败，`npm run check` 直接红
2. core `skill_invocations_enriched` 的 `agent_id` 只在配对成功时写 key，
   explicit 调用那条 key 整个不存在 → JS 侧读出 `undefined` 而非 `null`，过不了
   执行环境 zod 的 `.nullable()`。Python 侧一直是对的（两分支都显式 `None`），
   Rust 单测测不出是因为 `serde_json::Value` 索引缺失 key 也返回 `Value::Null`——
   已把断言改成 `contains_key("agent_id")`
3. `verify-export.mjs` 硬编码「导出十个键」，T10 加 `skill` 键后没跟着改

**两项遗留已补完**（2026-08-24 追加）：

- `data-audit-skills` 加进了 `verify-render.mjs` 的 `REGIONS`，另加两条独立
  断言（projection 未就绪时整段不渲染；invocations 为空数组时是"未触发"文案
  不是伪造统计）。三份 fixture 首次带上有实质差异的 `skillAudit` 数据后，
  炸出两处此前从未被这批测试真实跑过的隐藏耦合并顺手修正：时间线的事件标记数
  （T9 会把 skill invocation 也推成 timelineEvent，6→8）、P1-06 的
  `.sv-subcard` 计数（SkillSection 也被包进 subcard，3→4）——这两处都不是新
  行为，是断言此前标着及格、实际没测到这条路径。
- `SkillSection.tsx` 的 `TriggerBadge`/`LoadBadge`/`InvocationDrawer` 三处
  硬编码中文改成复用已有的 `skillExplicit`/`skillModel`/`skillLoaded`/
  `skillFailed`/`skillIncomplete` 这几个 key（T8 的摘要行本来就在用，只是
  徽章和抽屉没接上），未新增词表。

`DURATION_AUDIT_BACKLOG.md` D7 那条"新区块要登记 REGIONS"的提醒仍然有效——
是给以后新加区块的通用纪律，不是这两项遗留本身。
