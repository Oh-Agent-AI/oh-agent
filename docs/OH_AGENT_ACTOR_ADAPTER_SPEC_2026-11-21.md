# Oh Agent Actor Adapter Spec — 会话首提示词、预算闸与剧情触发裁决

> 日期：2026-11-21
> 状态：Proposed → 实施中（本文档即实施依据）
> 上游：City SDK V3 Integration RFC（r3）§2 `/actors`、§3.2、§4.1、§5.1、§12.2、ADR-03
> 前置已落地：`actor_intent.rs`（submit_intent 管线：校验→租约→CAS→信封→闭环）、
> `story_registry.rs`（story_projects/story_runs + project_content_digest）、
> `story_store.rs`（StateScopeV1 + story 键 + 信封字段 + write_resident_state）、
> `city.story.intent.submit` dispatch 臂 + creator_city_host 分类器
> 实施仓库：`skill-vitals-wt/city-sdk-v3`（feature/city-sdk-v3）

## 1. 定位与核心决策

**Actor = 会话第一句话的提示词 + 预算闸 + 事实落地。** 外部 coding agent（Codex/Claude Code 会话）自带目标管理、任务管理与会话记忆；宿主不做其中任何一项。宿主只保证三件事：

1. **身份不被冒充**：宿主铸造 `actor-` 身份；`session_identifier` 唯一键防重注册刷预算；
2. **预算刷不掉**：每 actor 每窗口 Intent 上限，耗尽零写入；
3. **事实不漂移**：新 thread 冷启动经 `turn.context` 对齐宿主权威事实（Canon/已提交事件）；LLM 声称 ≠ 事实（V3-04），提交时宿主确定性重验。

**宿主零模型调用**：不做任何 LLM 调用、不存 Prompt、不存对话历史、不存 LLM 输出原文、不建 actor 目标/任务表。外部 Agent 宿主自持：会话记忆、目标管理、任务拆解、多轮上下文。

### 1.1 与 V3 RFC 的关系（有意收缩）

- §2 `/actors` 的"预算与会话管理"**收窄为**"预算 + 身份铸造"；会话管理完全让位给外部宿主；
- §6 `actor.turn.trace` **收窄为**：submit 响应返回 traceId + actors 行单列覆盖更新（`last_decision/last_code/last_trace_id/last_decided_at_ms`），**不落日志表**；
- §5.1 "恢复新 Codex Thread 后一致" 的实现 = `turn.context` 事实投影（新 thread 冷启动读面），不依赖外部会话记忆。

## 2. 数据边界（宿主侧 actor 数据 = 仅此而已）

### 2.1 `actors` 表（actor_adapter.rs migrate）

```sql
CREATE TABLE actors (
    actor_id TEXT PRIMARY KEY,          -- 宿主铸造 "actor-"+hex
    story_id TEXT NOT NULL,             -- 绑定 Story（注册时校验存在）
    character_id TEXT NOT NULL,         -- 绑定 Canon 角色（canon 缺角色拒绝）
    session_identifier TEXT NOT NULL,   -- 外部会话唯一标识（见 §3）
    allowed_kinds TEXT NOT NULL,        -- JSON 数组：词表子集 ≤6（speak/move/interact/invite/give/quest.action）
    max_intents_per_window INTEGER NOT NULL,  -- 1..=200
    window_started_ms INTEGER NOT NULL, -- 1h 固定窗口起点
    intents_used INTEGER NOT NULL,      -- 窗口内已用
    session_label TEXT,                 -- 可选自由标注 ≤128（禁路径）
    last_decision TEXT, last_code TEXT, last_trace_id TEXT, last_decided_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    UNIQUE(story_id, session_identifier, character_id)
);
```

**禁止项（写进模块头注释）**：不存对话历史、Prompt、LLM 输出原文、模型/API 凭据、会话路径、actor 目标表、actor 任务表。宿主侧 actor 数据 = 身份行 + 预算计数 + last-decision 四列 + 合成时临时字符串。

### 2.2 `actor_turn` 不建表

submit 的响应本身就是 trace（返回 traceId + decision + 预算余量）；持久化面 = actors 行四列覆盖更新。

## 3. session_identifier（身份稳定 + 防刷预算）

- **必填**，≤128，字符白名单 `A-Za-z0-9._:-`——**`/` 与 `\` 不在白名单，文件系统路径天然被拒**（AGENTS.md 分发面不携带本机路径）；
- `UNIQUE(story_id, session_identifier, character_id)`：一个外部会话可驱动同 story 多个角色，各 actor 独立预算；
- **注册双幂等**：
  1. `operationId` 幂等（同请求重放返回原回执）；
  2. **身份幂等**：同 `(storyId, sessionIdentifier, characterId)` 重注册 → 返回既有 actor 行，**预算/窗口延续**（不铸造新 ID、不重置计数）——堵"刷注册 = 刷预算"；
- `turn.context` 响应回显 session_identifier（opaque，供外部会话自校）。

## 4. 三工具契约（MCP：creator_actor_*，headless 臂直达宿主）

### 4.1 `creator_actor_register`（写，`--allow-local-writes`）

入参：`storyId`、`characterId`、`sessionIdentifier`、`allowedKinds`（数组 ≤6，词表子集）、`maxIntentsPerWindow`（1..=200）、`sessionLabel?`（≤128 禁路径）、`operationId`。
校验：story 存在；story_projects.canon_json 含该 characterId（**Canon 先行**——没有 Canon 不能注册 actor）；session_identifier 白名单。
响应：`{actorId, sessionIdentifier, budget:{max,windowResetsAtMs}, sessionPrompt}`——注册即返回首句提示词（§5）。

### 4.2 `creator_actor_turn_context`（只读）

入参：`actorId`。
响应 DTO（= 外部会话组装 Prompt 的全部授权输入）：

```ts
{
  actorId, storyId, characterId, sessionIdentifier,
  budget: { used, max, windowResetsAtMs },
  canon: { … },                       // 该角色 Canon 节选 ≤4KiB
  runs: [ { storyRunId, status, lastViewedAtMs } ],   // 该 story 活跃/暂停 Run ≤32
  recentEvents: [ WorldEventEnvelopeV1 ],             // ≤16，已提交事实
  eligibleBeats: [ { beatId, edgeId, preconditions, eventDependencies, reachable } ],
  sessionPrompt: string,              // §5 确定性合成，≤8KiB，不落盘
}
```

**定位**：事实落地读面——新 thread 冷启动对齐 Canon/已提交事件/预算；**不是对话记忆**（续着的会话不需要它）。`eligibleBeats` 见 §6。

### 4.3 `creator_actor_intent_submit`（写）

入参：`actorId` + AgentIntentV1 形状 intent（intentId/actorId/scope/kind/args/expectedRevision/sourceEventIds?）。
前置闸（顺序）：actor 存在 → session/预算（§7）→ kind ∈ allowedKinds（`intent_kind_not_allowed`）→ **scope 分派（§6 双面语义）** → 因果/前置重验（§6.3）→ 委托 `actor_intent::submit_intent` 管线。
响应：CommitDecision `{accepted, code?, newRevision?, traceId}` + actors 行 last-decision 覆盖 + `intents_used` 扣减。

## 5. sessionPrompt 合成规范（Actor = 会话第一句话的提示词）

确定性纯函数：同一 actor 在相同 canon/预算/事实下，每次合成逐字节一致（测试钉住 deepEqual）。≤8KiB（超限按 canon 截断降级并标注）。组成：

1. 身份卡：characterId、displayName、canon 背景/成长轨迹（Persona 部分，来自 canon_json）；
2. 能力边界：allowedKinds 词表 + 各 kind 提交所需的 args 字段说明；
3. 事实摘要：runs（活跃 Run 的 storyRunId/status）、recentEvents 计数与最近因果、eligibleBeats 菜单（§6.2）；
4. 工具用法：`creator_actor_intent_submit` 的调用契约、何时重读 `creator_actor_turn_context`；
5. 边界声明：会话内目标/任务/多轮记忆由外部 agent 宿主自持；本提示词只是身份/规则卡。

**不落盘、不缓存**——每次从 canon/事实现算；canon 更新后下次合成自然反映（稳定性由事实层保证，不由提示词缓存）。

## 6. 剧情触发三层模型（每轮会话如何判断触发特定剧情）

**提示词不判断。判断分两半：语义匹配归 LLM 会话（第一、二层），资格裁决归宿主（第三层）。**

### 6.1 第一层——资格菜单（宿主·确定性，每轮 turn.context 刷新）

从 story_projects.graph_json（StoryGraphV1）计算当前已提交事实下的可触发剧情边：

```
reachable(graph, start)                       // 图可达（narrative-sdk 同语义的宿主最小实现）
∧ preconditions 与已提交事件/计数器一致        // ConditionRef 求值：本切片先支持
   eventDependencies ⊆ committedEventIds      //   因果存在性（V3-04 语义，轻量）
   其余 ConditionRef 标注 "unevaluated"        //   ADR-01 求值器落地后接入
∧ 因果依赖缺失的边 → 不可达并给出缺失清单
→ eligibleBeats 菜单（含每个 beat 的前置文本，LLM 可读）
```

状态变了菜单就变——同 sessionPrompt 下第 1 轮与第 10 轮菜单不同；**特定剧情只在设计者定义的条件满足时出现在菜单里，LLM 无法绕过**。

### 6.2 第二层——语义匹配提案（LLM·外部会话）

会话中，玩家的话是否指向菜单内的某个 beat？这是语义判断——外部 agent 会话的强项。LLM 提案 `quest.action` intent（args 携带 beatId + sourceEventIds 引用因果）。菜单里每个 beat 附前置文本，LLM 据此自检后再提案（自检只是礼貌，不是闸门）。

### 6.3 第三层——提交裁决（宿主·确定性，commit 时）

宿主对 quest.action/beatId 提案**重验**：

- beat 存在于 graph_json（未知 beatId → `story_beat_not_found`）；
- `eventDependencies ⊆ committedEventIds`（缺失 → `story_beat_dependency_missing` + 缺失清单，V3-04）；
- preconditions 的可确定子集（因果/计数器）重验；语义级（对话意图匹配度）**不验**——那是 LLM 层的职责，宿主只裁决事实；
- 通过 → CAS 提交剧情事件（信封齐），菜单随之刷新（该边消费、新边解锁）；
- 不通过 → decision `{accepted:false, code, traceId}` 零写入。

### 6.4 其他触发源不经 LLM

时间型剧情（city_scheduler 到点触发 `city_story_rules`）、玩家动作型（zone.entered 进 RuleGraphV1）保持确定性触发——LLM 只负责**对话型**剧情的语义提案层。

## 7. 预算语义

- 窗口：1h 固定窗（`window_started_ms` 起）；`now ≥ window_started+3600_000` → 重置 `intents_used=0`、`window_started=now`；
- 耗尽：decision `{accepted:false, code:"actor_budget_exhausted", traceId}` 零写入（预算计数不动）；
- 重注册**不重置**预算（身份幂等，§3）——预算只随窗口滚动恢复。

## 8. 租约 actor 持有扩展（ADR-03 输入）

租约 acquire 增可选 `holderActorId`：持有方记录 `{"kind":"actor","actorId":...}`——这是**租约持有方标记**，不是 StateScopeV1 扩展（状态 scope 仍只允许私有子集）。释放/过期/审计逻辑不变。ADR-03 的 L2/L3 自主动作持有方语义待正式裁决时，以本扩展为输入。

## 9. 实施计划

| # | 内容 | 文件 | 状态 |
|---|---|---|---|
| I-1 | actors 表 + migrate | actor_adapter.rs 新建 | 待实施 |
| I-2 | register（双幂等 + canon 校验 + sessionPrompt 合成） | actor_adapter.rs | 待实施 |
| I-3 | turn.context（canon/runs/recentEvents/eligibleBeats/sessionPrompt） | actor_adapter.rs + story_registry 读取 | 待实施 |
| I-4 | intent.submit 闸（预算/kind/scope 分派/因果重验）→ 委托 actor_intent | actor_adapter.rs | 待实施 |
| I-5 | 租约 holderActorId 扩展 | actor_intent.rs 最小增量 | 待实施 |
| I-6 | dispatch 臂 `city.actor.register/turn.context/intent.submit` + creator_city_host 分类器 | creator_projects.rs / creator_city_host.rs | 待实施 |
| I-7 | MCP 3 工具 + mod.rs + plugins.json + headless 臂 | creator_studio.rs / mod.rs / plugin_host.rs / plugins.json | 待实施 |
| I-8 | 测试：register 双幂等/白名单拒路径/canon 缺角色；context 投影/eligibleBeats因果；submit 预算耗尽/kind 拒/私有落玩家 scope/公共 move 租约+resident_state/换 story 拒绝；sessionPrompt 确定性 deepEqual | 各文件 tests | 待实施 |

## 10. 验收标准

| ID | 场景 | 必须成立 |
|---|---|---|
| AA-01 | 注册 | actor_id 宿主铸造；canon 缺角色拒绝；含路径 identifier 拒绝 |
| AA-02 | 身份幂等 | 同 (story,session,character) 重注册返回同 actorId，预算延续 |
| AA-03 | turn.context | canon/runs/recentEvents/eligibleBeats/sessionPrompt 全投影且只读 |
| AA-04 | sessionPrompt | 确定性（两次 deepEqual）；≤8KiB；含身份卡/能力/事实/工具用法 |
| AA-05 | 私有 Intent | 落目标玩家 Run scope；信封字段齐；扣预算 |
| AA-06 | 公共 move | 租约 actor 持有 → resident_state → 审计；无剧情事件（边界如实） |
| AA-07 | 预算耗尽 | accepted:false + actor_budget_exhausted，零写入；窗口滚动后恢复 |
| AA-08 | 剧情触发 | 菜单只含前置满足的 beat；缺因果提案被拒并列缺失清单（V3-04） |
| AA-09 | 绑定隔离 | actor 向未绑定 story 提交 → 拒绝 |
| AA-10 | 数据最小化 | 全库无对话/Prompt/LLM 原文/会话路径残留（测试断言字段封闭） |

## 11. 非目标

- Actor 适配器不做：模型调用、Prompt 存储、对话记忆、目标/任务持久化、多 actor 编排、远程 Actor 数据面（RFC §7.2 边界不变）；
- quest.action 的规则效果执行（RuleSetV2 AST）属 S-6 后续；
- Ink adapter、playtest.run 重工具、Top5-④ 另行切片。
