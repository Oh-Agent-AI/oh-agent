# Oh Agent City SDK V3 — 统一规则、动态剧情与 Agent 世界集成 RFC

> 日期：2026-11-19（初稿）· 2026-11-20 r1 代码对齐修订 · 2026-11-20 r2 Story 契约修订 · **2026-11-20 r3 复审收紧**（见 §0.2~§0.4 与各 [r1]/[r2]/[r3] 标记）
> 状态：**Proposed / Design Only；复审结论：架构评审通过，可进入 S-0/S-1；API 冻结前完成 r3 三项收紧**（Scope 联合类型、租约生命周期、更新摘要绑定）。r1 基于 `dev@5e0a7d84` 代码实证，实施门槛见 §8
> 基线：`Oh-Agent-AI/oh-agent` dev（静态源码审查 + 2026-11-20 打包闭环实测）；`MixLabPro/avg-maker@38c0844`
> 上游设计：City SDK v2.2、City Game SDK v2.2、Shared Contracts RFC v1、World Engine RFC v1、Narrative Engine RFC v1、
> City Code Game Preview Isolation Spec 2026-11-19（r1 新增互链，见 §13）
> 目标：保留已经工作的 City 与 Code Game 能力，以兼容方式加入规则统一、长期 NPC、动态剧情和自动走查。

## 0. 决策摘要

**V3 是现有 City SDK + Game SDK 的协同升级，不是第三套重复的 SDK。** 需要复用现有世界生成、WorldPlanPatch、City 快照、CodeGameHost、游戏规则执行和 Creator MCP；动态剧情作为可选扩展，权威状态由宿主负责。

1. **维持物理分包**：`@oh-agent/city-sdk` 拥有世界与公共身份，`@oh-agent/city-game-sdk` 拥有游戏、Run 和规则协议。Game → City 单向类型依赖，City 禁止反向依赖。
2. **新增一个可选扩展**：`@oh-agent/narrative-sdk` 负责 Story Graph、Canon/知识/因果校验与 Playtest 协议；不拥有真实数据库或 City 写权限。
3. **不新造 Rule Runtime**：既有 `compileRules/createRun/runHeadless` 作为 V1 MiniGame 兼容执行器；新 RuleSetV2 进入可信 World Engine / Game Host，并复用单一 Conditions/Effects Registry。
4. **不将 AI 输出当事实**：Actor 只提出 Intent；规则确定性校验；同一事务提交 Event、State、Outbox；然后才展示事实支持的对白。
5. **共享 City 时钟但隔离用途**：真实 UTC 锚定的 Simulation Clock 决定剧情事件，固定步 `gameTick` 决定物理游戏，Replay Cursor 只能读，Studio 快进仅作用于独立 Fork。
6. **AVG Maker 只抽算法**：保留可达性、Tarjan SCC、死胡同和图视图思路；Ink 是适配器，Electron/Python/Ink 的执行环境不进入基础包。
7. **以两类游戏同时验收**：City Romance 验证 NPC/时间/记忆；飞机穿环验证几何、物理、计分与可回放。任何通用接口不得只服务于剧情游戏。
8. **[r1] 规则裁决权归宿主**：当前试玩结算证据为 `city-client-reported`（客户端自报）。V3 的规则权威化不是"加一个 evaluator"，而是把规则裁决从 City WebView 的进程内 TS runtime 迁入宿主侧可信执行链；在此之前，宿主侧证据只能标注为客户端自报，不得宣称服务端裁决。详见 §1.1 与 §8 PR-3/PR-4。

### 0.1 非目标

- 不在第一阶段重写 Three.js、Creator Studio、World Generator 或既有 CodeGameHostV1。
- 不把 City、Game、Narrative 重新封装成一个有独立数据库的超级运行时。
- 不让 Codex/Claude Code 的 Thread 成为时间源、角色真相或存档。
- 不让第三方 UGC 在权威 Runtime 里运行任意 JS、Shell、网络和文件系统操作。
- 不承诺规则检查能保证所有自然语言叙事的语义一致性；强制不变量与语义风险评分明确分级。

### 0.2 [r1] 修订范围与代码实证方法

r1 修订只做三类事：修正过时基线（§1/§7）、补现状审计与复用决定（§1.1）、给 PR 拆分加实施门槛（§8）并新增验收项（§9 V3-15/16）。所有 [r1] 断言均可在 `dev@5e0a7d84` 上 grep 复核；未标注 [r1] 的内容为 2026-11-19 原稿。

### 0.3 [r2] Story 契约修订（评审结论落稿）

评审结论：架构方向通过，暂不冻结 API。r2 落实五项修订，全部经代码复核确认必要：

1. **Story 事实主键去 gameId 化**（§3.5）：story_store 现主键 `player×city×game`（story_store.rs:36/44/55 实证）——§12 的"Story 独立于 GameRun"与之直接冲突，`gameId` 必须降级为呈现适配引用。
2. **三对象生命周期**（§12.1）：StoryInstallation / StoryRun / StoryViewSession 分离；关闭视图≠终止长期剧情。
3. **多 Story NPC 仲裁契约**（§12.2）：公共动作租约与确定性排序，替代孤立的验收句。
4. **Preview Fork 契约化**（§13）：从原则层落到可实现的绑定/基线/命名空间/清理条款。
5. **基线重排**（§8）：manifestV2/defineGameV2/GameContextV2/PlayerScope(preview) 已落地（§1 [r2] 行），PR 顺序按剩余缺口重排。

[r2] 悬空引用处理：§12 原引用的 `OH_AGENT_MULTI_STORY_COMPOSITION_INSTALLATION_RFC_V1_2026-11-20.md` **当前不在仓库**（docs/ 无此文件）。本 r2 已把其被依赖的关键契约（三对象模型、安装事务形态）并入 §12 主文；该文档入库后须建立单向引用或删除本句内的重复定义，不得长期双源。

### 0.4 [r3] 复审收紧（API 冻结前的三处契约缝隙）

复审结论：五项 r2 修订全部有效，**架构评审通过，可进入 S-0/S-1**。冻结 Story API 前完成以下三项（均已落稿）：

1. **Scope 类型统一**（§3.5.1）：`StateScopeV1` 定义为 Shared Contracts 拥有的判别联合（Game/Story/CityResidentPublic 三子集），消除与 `StoryStateScopeV1`、§12 表格 `StateScopeV2` 的版本混用；所有信封/Intent/StoryEdge 引用统一到该联合。
2. **NPC 公共活动租约生命周期**（§12.2）：租约记录补最小字段（holderStoryRunId/traceId/acquiredAt/expiresAt），明确完成/取消/崩溃/超时四条释放路径，杜绝永久 `resident_activity_busy`。
3. **Story 更新确认绑定内容摘要**（§12.3）：`updateConfirmation` 除版本号外必须绑定 `currentPackageDigest → targetPackageDigest`（版本供展示、摘要防同版本换内容与确认后目标替换，对齐 Game 的 digest 冲突先例）。

## 1. 实际代码基线与复用结论

| 现有代码 | 确认存在的行为 | V3 处理 |
|---|---|---|
| `packages/agent-vitals-city-sdk/src/runtime.ts` | `compileRules/createRun/runHeadless`；计数器、timer、zone/item 事件、规则预算、连续 tick、回放断言 | **保留并适配**为 LegacyMiniGameRuleAdapter；不得直接替换生产规则 |
| `packages/agent-vitals-city-sdk/src/types.ts`、`validate.ts` | WorldProfile/SkinPack/LayoutSnapshotV3 等 V1 结构与验证 | 保留 V1 解析，新增显式版本化 V2/V4 DTO |
| `packages/agent-vitals-city-sdk/src/worldPlanPatch.ts` | 有界世界计划编辑检查 | 继续由 City SDK 拥有，不交给 Story Engine |
| `packages/city-game-sdk/src/api/defineGame.ts` | `defineGame({id,setup})` 并冻结入口对象 | 保留 V1 入口；显式新增 `defineGameV2` 或版本化可选字段 |
| `packages/city-game-sdk/src/api/types.ts` | `GameContextV1` world/entities/events/input/ui/audio/clock/random；存在自有 Route/Terrain DTO | V2 只读世界类型转而引用 City Contract，旧类型经适配保留 |
| `packages/city-game-sdk/src/host/codeGameHost.ts` | One Host/Run，固定步，seeded RNG，owned Entity，权限，生命周期清理；`nowMs()` 默认 0 且为诊断用途 | 保留 HostV1，不把它当 City Calendar；V2 增添可选授权服务端口 |
| `packages/city-game-sdk/src/protocol/manifest.ts` | ManifestV1 封闭字段和权限验证 | 新增 ManifestV2，不修改旧验证语义 |
| `MixLabPro/avg-maker/src/utils/deadEndDetector.ts` | BFS、反向 BFS、SCC、dead-end、island 检测 | 抽取无 Ink 依赖的 Graph Core，补有条件边与测试 |
| `MixLabPro/avg-maker/src/utils/storyGraph.ts` | 从编译 Ink JSON 推导节点和跳转；部分分支提取带启发式限制 | 独立作为 `ink-adapter` 输入，不能直接担任新规则源 |

[r1] 修订与新增行：

| 现有代码 | 确认存在的行为（实证） | V3 处理 |
|---|---|---|
| `packages/agent-vitals-city-sdk/package.json` | 包名已是 `@oh-agent/city-sdk`；`city-game-sdk` 同理已 `@oh-agent/city-game-sdk` | §7 迁移矩阵首行"迁移包名"**已完成**；剩余工作只是旧引用清理 |
| `apps/desktop/src-tauri/src/story_store.rs` | `story_states`(CAS revision) / `story_events`(UNIQUE(player,city,game,event)+幂等键) / `story_outbox`(UNIQUE(event_id,operation_id)) / `story_operations`(operationId 回执) 四表共享一个 Immediate 事务；提交命令携带 `expected_story_revision`+`expected_clock_revision` | **PR-4 的 State/Event/Outbox/CAS/幂等已在此落地**（scope 为 player×city×game）。PR-4 只做扩展（公共 City 级 scope、ruleSetDigest 字段、WorldEventEnvelope 对齐），**禁止并行的第二套事件库** |
| `apps/desktop/src-tauri/src/city_scheduler.rs` | `city_story_rules`：due_at_utc_ms、last_processed_tick、schedule/cancel/list(list_scope) | 已具备 §3.1 的"模拟时间调度"雏形；PR-4 复用而非重建 |
| `apps/desktop/src-tauri/src/city_game_install.rs` | Installation/Preview/Receipt 三表、CAS(`expectedCityRevision`)+operationId、显式更新确认（updateConfirmation 绑定 currentBuild→build）、越权三开关 fail-closed | **§12 StoryInstallation Registry 的模板**：Story 安装必须复用该事务模式，不另起一套 |
| `apps/desktop/src-tauri/src/city_runtime.rs` | `city_clocks`(UTC 锚定读时推进) 与 `city_preview_clocks`(previewId 主键、base_clock_revision 派生、终态即忘) 双表 | §3.1"快进仅作用于独立 Fork"已有宿主实现雏形；与 §13 收敛 |
| `packages/agent-vitals-city-sdk/src/contracts.ts` | `CityPlaceV1/CityResidentV1` 存在；**`StateScopeV1` 全仓 0 命中**；PlayerScope kind 已含 `"preview"` | StateScope 是 PR-1 的第一块砖，先于 WorldPlan/Clock schema；preview 身份先例已立 |
| [r2] `packages/city-game-sdk/src/protocol/manifestV2.ts`、`src/api/v2.ts` | **ManifestV2 已存在**（sealed build 校验即用它）；**`defineGameV2/GameContextV2` 已存在**（api/v2.ts:136-156，V2 Context 冻结入口已在预览链路使用） | 原 PR-2 的 ManifestV2/ContextV2 主体**已落地**；剩余工作是 Capability/Permission/Grant 判定与 §3.5 Story 作用域注入，不是从零建 V2 |
| [r2] `apps/desktop/src-tauri/src/story_store.rs` 主键 | 四表主键均为 `player×city×game`，**无 storyId/storyRunId 维度** | §12"Story 独立于 GameRun"与现键直接冲突——§3.5 修订的实证依据 |
| `crates/agent-vitals-mcp` creator 工具面 | `creator_city_view/capture/layout_save`、playtest history、session/job 等 50+ 工具已在 | §6 工具面按"扩展现有 creator 域"实现，不新开命名空间 |

**现实约束**：以上"已存在"只代表源码证据；[r1] 行另经 2026-11-20 打包 App 全链路实测（创建→修改→发布→试玩成功结算→越界拒绝）。下面所有 V3 API 都是新提案。

## 1.1 [r1] 现状审计结论（PR-0 的输入）

1. **证据信任缺口是 V3 的第一动因**。`creator_playtest.rs:416/435` 硬编码 `evidenceSource:"city-client-reported"`；规则真实执行点在 City WebView 内（CodeGameHost in-process 的 TS evaluator）。宿主目前只做 run 记账与证据落盘。V3-04/V3-09 要的"确定性裁决"在服务侧尚不存在。
2. **故事事务层已半成型**。story_store 的表结构就是 PR-4 目标形态的玩家私有 scope 版；缺的是公共 City scope、`ruleSetDigest` 关联与 WorldEventEnvelopeV1 的信封化。扩展路径清晰。
3. **安装事务模式可平移**。city_game_install 的 CAS+回执+显式更新确认+越权 fail-closed 已带 9 项回归测试（含过期重放、冲突回滚、跨 City 隔离）；Story 安装（§12）与 ADR-04 的资源 Grant 直接套用。
4. **模板规则即 V2 AST 的现成样本**。checkpoint-race 的 `when:{counter,op:"counter.eq|counter.eqEventIndex",value:{parameter}}` 与 `actions:[{op:"counter.add"|…}]` 已是声明式有限 AST 的子集；ADR-01 的 Guard/Effect 划分应从它反推，而不是先写抽象语法再适配。
5. **已知校验缺口（P2，来自闭环实测）**：`creator.mount.bind` 的 parameterOverrides 未对照 game.integerParameters 的 min/max——`timeLimitTicks:59`（声明 min 60）被接受。这正是 §3.3"规则包发布时静态类型/范围检查"要补的现实漏洞，应作为 PR-2/PR-3 的第一个红->绿测试。

## 2. 包关系与所有权

```text
@oh-agent/city-sdk                    # [r1] 包名迁移已完成，物理位置仍 packages/agent-vitals-city-sdk
  /contracts     EntityRef、StateScope、ClockSnapshot、Place、Resident、Interaction、World DTO
  /authoring     defineWorld / Generator / WorldPlan
  /validate      World/City/Interaction/DTO 验证
  /testing       World Determinism / Geometry / Legacy Fixtures

@oh-agent/city-game-sdk               # 保留已有包；物理分包
  /api           defineGame(V1)、defineGameV2、GameContext
  /protocol      Game Manifest、RuleSet、Intent、Effect、Game Run
  /host          Host Port（可信实现），Run-owned 实体
  /testing       Input Trace、Headless、Rule Fixtures

@oh-agent/narrative-sdk               # 新增、可选；纯算法 + 创作者契约
  /graph         StoryNode、Edge、Reachability、SCC、Causal DAG
  /contracts     Character Canon、Knowledge/Belief、Story Beat、Story Validation
  /testing       Agent Playtest Scenario、Coverage、Drift Report
  /adapters/ink  AVG Maker 图/Ink 导入导出（独立依赖）

City Runtime / Game Host              # **唯一权威写入与事务实现**
  /clock         Simulation Clock + Scheduler；Replay 只读
  /rules         Deterministic Rule Evaluator
  /store         SQL State/Event/Outbox + CAS + idempotency   # [r1] = story_store 既有四表扩展
  /actors        Codex/Claude Adapter，预算与会话管理
  /memory        Scoped Canon/State/Event/Summary Retrieval

Creator Studio / MCP                  # 控制平面、预览 Fork、调试与发布
```

**不得新增独立的 `@oh-agent/sdk` 核心真相层。** 如果以后需要易用的 `@oh-agent/sdk` 入口，它只能是重导出和开发体验 facade，不复制类型、数据和权限校验。

### 2.1 类型所有权硬约束

- City World/Actor Public Identity、Place、Location、CityClock、Interaction 与公共 EntityRef：City SDK 唯一来源。
- Game Manifest、Requested Permission、GameRun、RuleSet/Effect、Game Intent：Game SDK 唯一来源；可引用 City 共享 Guard Expression 类型。
- Story Graph、Persona Guidelines、Knowledge Claim、Playtest Metrics：Narrative SDK 唯一来源；引用 City/Game 类型，绝不反向依赖。
- Runtime 负责权限 Grant、校验、提交；SDK 中的 DTO/Helper 不代表用户获得 Host 写能力。
- [r1] 旧引用清理：`@agent-vitals/city-sdk` 命名仅存在于历史文档与个别注释，代码内 import 均为新名；迁移矩阵该行关闭。

## 3. 核心协议（V3 增量，示意）

### 3.1 稳定身份、时间与状态范围

复用 Shared Contracts RFC：`WorldPlanV1 → WorldCompiler → CityWorldSnapshotV4`、`CityResidentV1`、`CityPlaceV1`、`StateScopeV1`、`CityTemporalSnapshotV1`。所有引用必须附版本和稳定 ID，不得把 Three Object UUID、数组序号或 NPC Thread ID 作为持久实体身份。

[r1] `StateScopeV1` 目前不存在于任何包（全仓 0 命中）——它是 §3.2 `WorldEventEnvelopeV1.scope` 的前置类型，PR-1 第一个交付。

四个时间概念不可混淆：

| 时间 | 写入权威 | 用途 | 禁止用途 |
|---|---|---|---|
| `wallUtcMs` | 真实时钟 | 默认 1:1 的 Simulation 锚点 | 直接决定固定步物理碰撞 |
| `simulationUtcMs` | City Clock Controller | 日历、NPC 日程、持久事件 | 被游戏/Actor 私自修改 |
| `gameTick` | 当前 Game Host | 飞行、战棋、计分、输入轨迹 | 充当公共 City 日历 |
| `replayCursorMs` | 只读回放视图 | 浏览既有 Session/Event | 调用真实调度、发奖或写 Story State |

[r1] 宿主已有对应实现的两个事实：`city_clocks`（simulationUtcMs 读时推进、回拨标记 uncertainty）；Preview 隔离的 `city_preview_clocks`（previewId 派生 fork，终态即忘）——§13 规定其与 PreviewForkV1 的收敛关系。

### 3.2 通用事件信封与行动提案

```ts
// 类型名称和字段以最终 Shared Contracts 评审为准。
interface WorldEventEnvelopeV1 {
  eventId: string;
  type: string;
  scope: StateScopeV1;
  actorId: string;
  simulationUtcMs: number;
  causationId?: string;
  correlationId?: string;
  expectedRevision: string;
  ruleSetDigest: string;
  payload: Readonly<Record<string, unknown>>;
}

interface AgentIntentV1 {
  intentId: string;
  actorId: string;
  scope: StateScopeV1;
  kind: "speak" | "move" | "interact" | "invite" | "give" | "quest.action";
  args: Readonly<Record<string, unknown>>;
  expectedRevision: string;
  sourceEventIds?: readonly string[];
}

interface CommitDecisionV1 {
  accepted: boolean;
  code?: string;
  committedEventIds?: readonly string[];
  newRevision?: string;
  traceId: string;
}
```

**统一执行链**：接收 Intent → 校验 Schema/Grant/Scope → 读取权威 Snapshot → 解释声明式规则 → CAS 提交 State+Event+Outbox → 生成/验证对白 → 广播已提交事实。

`validate` 与 `commit` 必须以同一 Revision 为前提。冲突需要重新读取重评或返回 Conflict。所有完成奖励带 Idempotency Key；重试不得双倍领取。LLM 永远不直接更新 SQL。

[r1] 该执行链与既有实现的映射：`StoryCommitCommandV1`（operationId/eventId/expected_story_revision/expected_clock_revision/intent/runId）就是 AgentIntentV1+信封字段的宿主侧前身；PR-4 的工作是信封化与 scope 泛化，语义不变。

### 3.3 RuleSetV2 不复制旧引擎

旧 `RuleGraphV1` 的 `run.started / zone.entered / item.collected / timer.expired` 和 `counter.add / timer.start / hud.hint / outcome` 仍有效，并通过 `LegacyMiniGameRuleAdapter` 映射到标准事件/规则决策。

V2 新增有限 Condition/Effect AST（不执行 UGC JS）：

```ts
interface RuleV2 {
  schemaVersion: 2;
  id: string;
  version: string;
  on: readonly string[];             // namespaced event type
  when: ConditionV2;                // finite AST: all/any/not, eq/gte, at-place, has-item...
  effects: readonly GameEffectV2[]; // set/inc/emit/schedule/grant-item 等白名单
  onFailure: "reject" | "skip";
}
```

规则包发布时进行静态类型、引用、依赖环、预算检查；运行时执行状态和权限检查。Rules Engine 必须有稳定优先级、固定随机 seed、有限递归与最大调度事件数量。

[r1] 两个补充：
- **范围检查纳入静态检查**：integerParameters 声明的 min/max 必须约束 mount parameterOverrides（现状缺口，见 §1.1-5），红->绿测试先行。
- **AST 起点用现有模板反推**：checkpoint-race 的 `when:{counter,op:"counter.eq"|"counter.eqEventIndex",value:{parameter}}` 与 effect `counter.add/timer.start/run.finish` 已构成最小子集；ADR-01 的裁决以它为兼容样本。

### 3.4 GameContextV2 是增量扩展

保留 `GameContextV1` 和 `defineGame({ id, setup })` 原样运行。新游戏通过 ManifestV2 显式选择 API major 2，获得受权的：

```ts
interface GameContextV2 extends GameContextV1 {
  readonly time: CityTimeReadV1;       // scoped read-only City Simulation Time
  readonly interactions: InteractionReadV1;
  readonly rules: RuleQueryV1;         // 查询规则，不自己调用特权 commit
  readonly story?: ScopedStoryAPI;     // 有权限且显式申请才出现
  readonly actors?: ActorIntentAPI;    // 有权限才可提交 Intent Proposal
}
```

Game Host 保持 **One Host / One Run** 的现有模型，不直接导出 CityEngine、Three、Shell、未经校验的 SQL 或 Agent 工具对象。`story` 可选，所以飞机穿环游戏无需引入叙事成本。

[r1] Code Game 预览隔离已为 `story?` 的可选授权提供现成先例：独立 Preview 窗口的 run.start 走 `start_preview_run`（preview playerScope），`city.time.read` 走 Preview 私有 Clock；V2 的受权端口应沿用同一"权限出现即受限"的形态。

### 3.5 [r2] Story 身份与作用域（评审修订 1：去 gameId 主键）

主文其余部分按 `playerId × cityId × gameId` 组织 Story State/Storage/Scheduler/Memory（story_store 现键即此）。§12 一旦成立（Story 为可复用内容、独立于 GameRun 长期存在、多 Story 共 City、Game 仅呈现适配），`gameId` 即不能再承担 Story 事实主身份。V3 契约修订如下，**冻结 API 前必须先落此节**：

```ts
interface StoryStateScopeV1 {
  playerId: string;        // 玩家私有命名空间（不变）
  cityId: string;          // 所属 City（不变）
  storyId: string;         // 内容身份（不可变 Story 包的稳定 ID）
  storyRunId: string;      // 玩家长期进度身份（一周目=一个 run）
  residentId?: string;     // 仅 NPC 私有关系/记忆条目携带
}
```

规则：

- **`gameId` 降级为呈现适配引用**：Story 事实表（states/events/outbox/operations/scheduler 规则）的主键与外键一律换用 StoryStateScopeV1；`gameId` 只出现在 GameLaunch/呈现绑定层，不进入 Story 主键。
- **公共 NPC 状态归 `cityId + residentId`**（City Runtime 仲裁，§12.2），永不进入玩家私有命名空间；`residentId` 仅修饰 NPC×玩家 的私有关系。
- **宿主迁移**：story_store 四表为玩家私有 scope 的已落地实现，键迁移 = 新增 `story_id/story_run_id` 列并按 `(player,city,story,run)` 重建主键；旧 `game_id` 键数据走一次性迁移脚本映射到"每 gameId 一个合成 storyId"或显式归档，不静默改写（对齐 §12 更新语义：旧 Run 明确迁移或拒绝）。
- **多周目**：重置剧情 = 新 `storyRunId`；旧 run 的事件/记忆对新 run 不可见（除非 Story 显式声明继承规则并在 Canon 层声明来源）。

#### 3.5.1 [r3] StateScope 统一为判别联合（Shared Contracts 拥有）

消除 `StateScopeV1 / StoryStateScopeV1 / StateScopeV2` 三名并存的混用：`StateScopeV1` 定义为 **Shared Contracts 拥有的判别联合类型**，§3.2 `WorldEventEnvelopeV1.scope`、`AgentIntentV1.scope`、§4.2 `StoryEdgeV2.scope` 的既有引用全部指此联合，不再各自造子类型：

```ts
type StateScopeV1 =
  | GameStateScopeV1            // playerId × cityId × gameId × gameRunId（过渡期兼容：story_store 现键的正式表达；S-1 迁移的旧数据落此子集）
  | StoryStateScopeV1           // §3.5 四元组（playerId × cityId × storyId × storyRunId [, residentId]）
  | CityResidentPublicScopeV1;  // cityId × residentId（公共 NPC 状态；仅 City Runtime 仲裁可写，见 §12.2）
```

规则：

- 每个 DTO 携带联合判别字段（如 `scope.kind`）；Runtime 按子集分派权限与仲裁路径，未知子集 fail-closed。
- 私有子集（Game/Story）之间默认互不可见；公共子集只读呈现，写入必须经 §12.2 Intent 队列。
- 原 §12 表格中的 `StateScopeV2` 字样由本联合取代（该行已更正）；若未来确需 V2，V2 = 本联合的版本化演进，不另起炉灶。

## 4. 动态剧情扩展与 AVG Maker 迁移

### 4.1 设计者约束与运行时事实分离

| 资产层 | 来源 | 权威等级 | 作用 |
|---|---|---|---|
| Character Canon | 游戏作者版本化定义 | 高；需受控迁移 | 姓名、背景、相对稳定的边界和成长可变更范围 |
| World/Story State | Runtime 事务 | **最高动态事实** | 地点、库存、任务、关系、约会结果 |
| Event Log | Runtime 原子追加 | 历史凭证 | 已发生的事件、因果和撤销/更正 |
| NPC Belief/Knowledge | 带来源与可见性 | 角色认知，不等于世界事实 | 秘密、误会、谎言、观察到的事件 |
| Narrative Summary/RAG | 派生索引 | 低于 State/Event | 减少上下文，提供相关记忆 |
| Dialogue | Agent 自然语言 | **不是状态提交** | 展示人格与演绎 |

必须允许 NPC *主观错误*，但不可由未经提交的文本改写客观世界。角色性格变化应有 Story Event 支撑，且受设计者允许的成长轨迹约束。

### 4.2 Story Graph V2

```ts
interface StoryEdgeV2 {
  id: string;
  from: string;
  to: string;
  preconditions: ConditionV2;
  effects: readonly GameEffectV2[];
  eventDependencies: readonly string[];
  scope: StateScopeV1;
}
```

AVG Maker 的 BFS/SCC/dead-end 算法用于结构图分析，但新增两类检查：

1. **Conditional Reachability**：有图边 ≠ 条件可达；在给定 State 和受限符号/场景状态下检查任务是否能够完成。
2. **Causal / Knowledge Validation**：新事件需要引用既有因果；NPC 不能无来源知道私人事件；过期的摘要不覆盖当前 State。

不要求每条普通对白都转 Ink。只有重大 Story Beat 形成有界节点/事件，生成文本可按需抽取 Claims 进行语义检查。语义 Judge 的结果是警告/改写建议；库存、关系、奖励的最终裁决始终由确定性规则完成。

### 4.3 抽取清单

| AVG Maker 源码 | 动作 | 验收 |
|---|---|---|
| `src/utils/deadEndDetector.ts` | 抽出纯图遍历模块，不依赖 inkjs Story | 原图 fixtures 与 SCC/孤岛/死胡同结果一致 |
| `story/story_deadend_detector.py` | 保留为离线对照实现和样本 | TS/Python 对同一有向图给出同义结果（注明启发式差异） |
| `src/utils/storyGraph.ts` | 拆到 `narrative-sdk/adapters/ink`；修复嵌套/条件边覆盖 | 多分支 Ink Fixtures 可复原完整候选边 |
| `src/components/preview/NodeGraph.tsx` | 移植图层交互思想，不直接依赖 Electron Context | Studio 显示规则边、失败原因、状态 Revision |
| `DeadEndDetectorTool.js` | 统一错误契约；失败不能返回空成功报告 | `validator_error` 严格区别 `passed` |
| `GameDevelopmentAgent.ts` | 不搬入 SDK；保留编排/测试思路 | 隔离 Playtest 不触及正式 World |

## 5. 两个纵向切片（防止对单一玩法过拟合）

### 5.1 City Romance（长期）

- 使用已有 `CityResidentV1/CityPlaceV1` 和 InteractionRouter 点击居民。
- 玩家在 Overlay 与"小夏"互动；Actor 产生 `invite` 提案；好感度、地点、时间和 Scene/Canon 校验通过后提交 `date.invited`。
- City Scheduler 在模拟时间周六 18:00 触发约会；恢复新 Codex Thread 后 Canon、已发生事件与授权记忆一致。
- 两名玩家的私有好感度、对话与日期安排严格分 Scope；公共 NPC 位置由 City Runtime 统一仲裁。
- 在 Preview Fork 快进到周六，不影响正式玩家与公开城市。

[r1] 实现锚点：宿主已有 `city_story_rules.due_at_utc_ms`（模拟时间调度）与 story_store 玩家私有 scope；本切片缺的是公共 City scope 的 NPC 位置仲裁（§8 PR-5）与 Canon/Knowledge 层（PR-6）。

### 5.2 飞机穿环（实时）

- 使用 City SDK 的 World Volume、Anchor、坐标/几何合同及 Game Host 的固定步。
- 物理引擎产生 `volume.crossed` 候选事件；Host 验证轨迹与顺序，Rule Adapter 更新环计数和赛时。
- 切换 RenderProfile 不影响得分；回放 Input Trace + seed 得到相同机械结果。
- 不加载 Narrative Memory、Agent LLM 和 Story Graph，证明它们是可选扩展。

[r1] 本切片已具备可运行底座：flight playtest（airspace anchors → bind → publish → playtest）与 checkpoint-race 的全链路在 2026-11-20 打包实测中通过（含真实结算证据）；V3 侧待做的是把裁决迁入宿主并回放一致（V3-10）。

## 6. Creator Studio、调试与可观测性

建议增加以下 *受权* Creator MCP/Studio 工具，API 名称仅为设计示意：

- `game.rules.inspect`：查看 Game Manifest、规则版本、禁用/允许事件与字段引用。
- `game.intent.simulate`：在 Preview Fork 上给出可解释的 `allowed/denied` 与诊断，不提交正式状态。
- `story.graph.inspect`：节点、条件边、未满足条件、死胡同、因果来源。
- `story.timeline.inspect`：已提交事件和 Simulation Clock 对齐，按 scope 掩码私人内容。
- `actor.turn.trace`：模型/Prompt 版本、Intent、Validator Verdict、State Revision、成本。
- `playtest.run`：使用固定 seed、初始 State、测试 Agent、预算做 100/300 轮隔离测试。

[r1] 落地形态约束：以上一律作为**现有 creator 域工具的扩展**（creator_* 命名、`--allow-local-writes`/`--enable-city-tools` 开关体系、信箱预算与错误码 `next` 建议机制全部沿用），不新开 MCP 命名空间；`game.intent.simulate` 的隔离执行环境直接用 Preview Fork（§13）。

测试错误应输出 `traceId, stateRevision, ruleSetDigest, clockRevision, actorId, scope, diagnosticCode`，便于与 Oh Agent Vitals 的 Agent 工具执行审计关联。

## 7. 兼容与版本迁移矩阵

| 旧资产/API | V3 处理 | 兼容门槛 |
|---|---|---|
| `WorldProfileV1 / LayoutSnapshotV3 / SkinPackV1` | 旧 Validator 保留；显式 Compile/Adapter 到新读模型 | 旧包、旧 City 不改变坐标、标识和布局 |
| ~~`@agent-vitals/city-sdk` 迁移包名~~ [r1] | **已完成**：两包均已 `@oh-agent/*`；剩余为文档级清理 | 关闭 |
| `MiniGamePackV1 / RuleGraphV1` | LegacyRuleAdapter，继续支持已有 zone/item/timer | 原 Headless/规则 fixtures 字节语义不变 |
| `GameDefinitionV1 / CodeGameHostV1` | 原样保留；另建 V2 Context 和 Manifest | 原 `hello-city`、游戏输入/结束/清理测试仍通过 |
| `CitySnapshotV1 / RouteV1 / TerrainSampleV1`（Game 自有） | 抽出 City Shared DTO，保留旧 Game 适配器 | V1 应用无需一次性迁移 |
| Session Time Replay | 只读浏览；不可触发 Story 事件 | Replay 无任何真实经济/剧情写入 |
| AVG Ink/图分析 | Narrative 可选 adapter | 没有 Ink 的飞行游戏正常打包与运行 |
| [r1] `story_store` 四表 / `city_story_rules` | 原样保留；PR-4 在其上扩展公共 scope 与信封字段 | 现有 story 提交语义与测试不变 |
| [r1] `city_game_installations` 事务族 | 作为 StoryInstallation Registry 的实现模板平移 | 既有 9 项安装回归测试保持全绿 |

**规则版本原则**：`schemaVersion`、`contractVersion`、`sdk.apiMajor`、Game BuildId、City Revision、RuleSet Digest 分开管理。V3 是本次架构工作代号，不表示现有 npm 包已经发布 major 3。

## 8. 开发顺序与 PR 拆分

[r1] 总门槛：**PR-4/PR-5 动工前必须先产出 §1.1 审计清单并获评审通过**；任何"新建平行 store/registry"的 PR 直接拒绝（§0.2 禁令的执行条款）。

| 顺序 | 主要代码变更 | 完成标准 |
|---|---|---|
| PR-0 | 冻结 Shared Contracts 与兼容基线；补当前 CI 快照；**[r1] 产出 §1.1 现状审计清单（story_store/scheduler/install/clock 的表结构与测试映射）** | 现有 City/Game Legacy 测试全绿；审计清单评审通过 |
| PR-1 | City SDK 增加 `/contracts`、**[r1] 先 `StateScopeV1`** 再 WorldPlan/Clock/Scope 的单一 schema | Game 不再复制世界 DTO，兼容类型可用 |
| PR-2 | Game SDK 新增 ManifestV2、GameContextV2、Capability/Permission/Grant 判定；**[r1] 修复 mount parameterOverrides 范围校验（§1.1-5 红->绿）** | 原 HostV1 不变，非法授权被拒；越界 override 被拒 |
| PR-3 | LegacyRuleAdapter 与 RuleSetV2 有限 AST / Headless Evaluator；**[r1] 评估器落在宿主侧（Rust）或经 Host Port 的可信进程，先于任何 WebView 裁决路径** | 旧规则结果一致、V2 deterministic/replay；**[r1] 宿主可复算 playtest 结算（evidenceSource 升级为 host-verified 的最小路径）** |
| PR-4 | **[r1] 扩展 story_store**：WorldEventEnvelopeV1 信封化（eventId/causation/correlation/ruleSetDigest）、公共 City scope 表、Outbox 对齐；City Simulation Clock + Scheduler 复用 city_story_rules | 重试不双发奖，Replay 无写入；既有 story 提交测试不回归；**不出现第二套事件库** |
| PR-5 | NPC Actor Intent Adapter、Canon、Scoped Memory；公共 NPC 位置仲裁（City scope） | 100/300 轮硬不变量零违规 |
| PR-6 | `@oh-agent/narrative-sdk` + AVG Graph Algorithm Extraction | 条件死链、事件因果、知识边界诊断可解释 |
| PR-7 | Creator Studio Inspect/PreviewFork/Playtest + 飞行/恋爱两切片 | 两类游戏跨 City、切画风、恢复/回放验收 |

优先顺序不能颠倒：在 PR-1~4 之前，直接增加多个会话驱动 NPC 会积累更多漂移数据，而不是解决一致性。

[r1] ADR-01 的裁决时点：PR-2 开始前完成一个 spike——把 checkpoint-race 的 when/effect 字面量映射为 ConditionV2/GameEffectV2 最小子集并跑通 headless 对照；以该样本定 Guard（City）与 Effect（Game）的分界，避免抽象先于样本。

### 8.1 [r2] 基线重排（评审修订 5）

原 PR-1~4 的相当部分已在 dev 落地（Shared Contracts 骨干、ManifestV2、defineGameV2/GameContextV2、sealed build、story CAS/Outbox、City Clock、PlayerScope(preview)、Scheduler 基础、独立 Preview、安装事务）。**不按原表从 PR-1 起步**，剩余缺口按以下顺序补齐：

| 顺序 | 剩余缺口 | 完成标准 |
|---|---|---|
| S-0 | CI 对 Desktop/Studio/V2 新增面补回归（golden/lockstep 覆盖） | 新面无裸奔路径 |
| S-1 | StateScopeV1 + §3.5 storyId/storyRunId 键迁移（含一次性迁移脚本） | story_store 新键全绿、旧数据显式迁移/归档 |
| S-2 | Story Project Registry（§12 表格行的"创作项目"注册表，Story 三类资源平级） | Studio Story 库非占位、来源不推断 |
| S-3 | StoryInstallation / StoryRun / StoryViewSession 三对象（§12.1） | V3-17~19 通过 |
| S-4 | Story Preview Fork（§13 扩展到 StoryRun） | V3-21 通过 |
| S-5 | Narrative Graph、Canon/Knowledge、Actor Adapter（原 PR-5/6） | V3-14 / V3-22~23 通过 |
| S-6 | 宿主侧规则裁决与复算（原 PR-3 核心，V3-16） | evidenceSource 可 host-verified |

S-1~S-4 属"冻结 Story API 前"的硬门槛；S-5/S-6 可与 S-4 并行评估但不得阻塞门槛项。

## 9. 验收测试（必须有自动化证据）

| ID | 场景 | 验收条件 |
|---|---|---|
| V3-01 | 旧 City 世界包/旧 mini-game/旧 CodeGameHost | 兼容回归通过 |
| V3-02 | Game 引入 City DTO | 唯一 Schema Source，无复制 Route/Terrain Token |
| V3-03 | 同输入 seed、规则、状态、版本重放 | 机械 State/Event Hash 相同 |
| V3-04 | Actor 声称已约会但缺已提交事件 | Story State 不改变、对白要求修正或解释 |
| V3-05 | NPC 在两个地点同时行动 | 公共 Location 一致性拒绝 |
| V3-06 | 旧摘要与当前 State 矛盾 | State 优先，摘要标记 stale |
| V3-07 | 两玩家与同 NPC 互动 | 私人记忆隔离；公共动作有序 |
| V3-08 | 星期六约会 + Studio 快进与 Replay | 只在授权模拟时间触发，Fork 不改正式 State |
| V3-09 | 重复 Intent、崩溃恢复、CAS 冲突 | 效果至多一次提交；可恢复/可审计 |
| V3-10 | 飞机穿环切画风 | World/Score/Time 不改变，固定步可回放 |
| V3-11 | 条件剧情边物理连通但状态不可达 | 标记条件不可达，不误判可行 |
| V3-12 | 图检测器故障 | 明确 `error`，不得报告 `passed` |
| V3-13 | UGC 构造过深规则、循环 schedule、敏感 Scope | 资源预算与权限校验拒绝 |
| V3-14 | Agent 100/300 轮模拟 | 硬状态违规提交 0；软漂移报告带证据 |
| V3-15 | [r1] Story 安装/更新/卸载事务 | 复用 city_game_install 模式：CAS+operationId 幂等、过期/重放/冲突回滚零部分安装、更新需显式确认（对齐既有 9 项安装回归） |
| V3-16 | [r1] 宿主复算结算 | 同一 run 的输入轨迹+规则+seed 在宿主侧重放得到相同 outcome/counters；`evidenceSource` 可区分 client-reported 与 host-verified |
| V3-17 | [r2] 同 City 双 Story（侦探+恋爱） | 私人关系/记忆/对话零串线；共享 NPC 公共动作经 §12.2 仲裁有序 |
| V3-18 | [r2] 关闭 Dialogue/StoryViewSession | StoryRun 与未来 Scheduler 事件继续存在；重开恢复原 Run，不新建 |
| V3-19 | [r2] 两 Story 同时驱动同一 NPC 去不同地点 | City Runtime 按确定性排序接受其一、拒绝另一（可解释诊断），非"后到覆盖"；[r3] 持有方崩溃/超时后租约按 §12.2 惰性过期回收，不产生永久 `resident_activity_busy` |
| V3-20 | [r2] 两玩家运行同一 Story | 事件、记忆、进度完全隔离（scope 四元组缺一即隔离失败） |
| V3-21 | [r2] Preview 快进并提交剧情 | 正式 StoryRevision、City Clock、Outbox 均不变；Fork 退出即弃 |
| V3-22 | [r2] Story 更新到新版本 | 旧 StoryRun 显式迁移或拒绝（带诊断），不静默重绑定到新内容；[r3] 确认绑定 `currentPackageDigest→targetPackageDigest`，同版本换内容/确认后目标被替换均拒绝（对齐 digest 冲突先例） |
| V3-23 | [r2] 重置剧情（新周目） | 生成新 storyRunId；旧事件/记忆不被新周目误用（除非声明继承） |

## 10. 开放 ADR（实施前明确）

1. **ADR-01 Rule AST 的最低公共子集**：City Interaction Guard 与 Game Rule 共享哪些 Condition，哪些 Effect 只属于 Game？本 RFC 推荐 City SDK 定义 Guard AST 子集，Game SDK 定义可提交的 Game Effects。[r1] 裁决方式：PR-2 前 spike，以 checkpoint-race 字面量为兼容样本（§8）。
2. **ADR-02 SQL 运行地点**：本地 SQLite 与多用户 PostgreSQL 的 Event Schema、Scope 和 Transaction API 必须同构；第一阶段优先本地 SQLite。[r1] 起点=story_store 既有四表扩展。
3. **ADR-03 NPC 公共自治等级**：L0/L1 被动与事件驱动先落地；L2/L3 自主调度需预算与公共动作仲裁。
4. **ADR-04 多游戏安装与资源交易**：Game Run 私有资源能否转换为公开经济资产必须有独立 Grant，不能复用 `storage.game`。[r1] Grant 事务形态=city_game_install 的 receipts 模式。
5. **ADR-05 SDK Facade 名称**：是否额外发布 `@oh-agent/sdk` 便捷入口；若发布仅重导出，不改变所有权和依赖方向。

## 11. 对团队的最终建议

**先做整合，不做重建。** 当前最有价值的资产是 City SDK 的世界验证/MiniGame Rule Runtime、Game SDK 的确定性 Host/Headless 测试、AVG Maker 的 Story Graph 算法。V3 应把它们收敛为一个可信执行链，而不是另起一套 SDK 并让两个引擎并行竞争事实权威。

成功定义：创作者可在同一座 City 安装飞机穿环和 Agent 恋爱两款游戏；两者共享稳定的世界身份、时间、规则审计与权限机制，但只在需要时引入 Narrative 扩展；Agent 即使更换模型/会话或长期交互，也不能绕过硬规则直接改写世界。

[r1] 一句话现状：世界/时钟/安装/玩家私有故事事务四块地基已在宿主落地，缺的是公共 City scope 的信封化、宿主侧规则裁决与 Narrative 层——按 §8 顺序补齐即可，无需推翻任何已落地机制。

## 12. 2026-11-20 V3 增量：Multi-Story Composer（Proposed）

统一依据：OH_AGENT_MULTI_STORY_COMPOSITION_INSTALLATION_RFC_V1_2026-11-20.md。V3 保留 §2 物理分包和类型所有权原则，**不**另建第四套 SDK 或独立特权 Story Engine。

| 层 | 新增职责 | 严禁扩张 |
| --- | --- | --- |
| City SDK /contracts | 稳定 Resident/Place Target、City/Clock 引用、共享 StateScope 联合（[r3] §3.5.1） | 不存每玩家 Story State |
| Game SDK /protocol | StoryRun 的受控运行/呈现桥接、GameLaunch 兼容、Rule/Intent 引用 | 不复制 Narrative Graph，不给游戏直接 DB |
| Narrative SDK /graph | StoryDefinition、Story Graph、Canon/Knowledge、Install 静态预检、AVG Maker 分析 | 不导出特权 Host/SQL/City Patch |
| City Runtime /store | StoryInstallation Registry、StoryRun Registry、CAS、NPC 公共位置仲裁 | 不建第二套规则与事件数据库 |
| Studio / Creator MCP | 安装预览、Bindings、版本、Story Inspector、测试/诊断 | 不无权限注入 City 公共实体 |

**V3 兼容决定**：故事属于可复用内容并可独立于 GameRun 长期持续；已有 Code Game 可以以 Story Presentation Adapter 提供 UI。P0 不变更旧 defineGame/InstalledGameRegistry 语义，采用版本化 StoryInstall/StoryRun Port。StoryPackage 的打包/签名/商店归 Content/Marketplace 层，不能混入 WorldSnapshot。

[r1] StoryInstallation Registry 的实现基座：`city_game_install.rs` 三表事务（见 §1.1-3）；排期必须在 PR-4 之后（依赖 StateScope 联合 [r3 §3.5.1] 与信封），且以 V3-15 为验收。

### 12.1 [r2] 三对象生命周期（评审修订 2）

§12 原文只有"交替启动、停止、重进"一句验收，缺生命周期契约。V3 显式拆分三个对象，**职责不得互相兼职**：

| 对象 | 身份 | 职责 | 终止语义 |
|---|---|---|---|
| `StoryInstallation` | installationId（`cityId × storyId` 逻辑键） | Story 安装到哪个 City、绑定哪个不可变版本；安装/更新/停用/卸载事务 | 仅由显式安装操作改变（V3-15/22） |
| `StoryRun` | storyRunId（玩家一周目） | 长期剧情状态、Scheduler 规则、事件与进度；scope 见 §3.5 | 仅由显式停止/完成/删除/重置改变（V3-18/23） |
| `StoryViewSession` | viewSessionId（短命） | 当前 Overlay/独立窗口、输入焦点、Dialogue Promise | 关闭即弃，**不触碰 StoryRun 生命周期** |

规则：

- **关闭 StoryViewSession ≠ 停止 StoryRun**。窗口关闭/崩溃只释放输入、Dialogue 与呈现资源；Scheduler 与未来事件继续存在（V3-18）。
- StoryRun 暂停（如玩家休眠模式，若引入）= Scheduler 停止推进但保留 due 事件；恢复从暂停点继续，不重放已处理事件。
- 重开默认**恢复原 StoryRun**（按 §3.5 scope 定位）；只有显式"新周目"才新建 storyRunId。
- WebView 崩溃清理走 Preview Isolation Spec §8 的同一清理路径（拒绝输入→abort→释放→标记终态），但终态标记的是 ViewSession 而非 StoryRun。

### 12.2 [r2] 多 Story 共享 NPC 的公共仲裁（评审修订 3）

多 Story 同时操作同一 Resident（如"侦探"与"恋爱"都要移动小夏）时的权威契约：

1. **公共动作统一入队**：任何影响 `cityId + residentId` 公共状态（位置/可见活动）的 Intent 进入 City Runtime 的**单一 Intent 队列**，按 `(simulationUtcMs, intentId)` 确定性排序——同刻冲突时按 stable intentId 字典序，不接受"后到覆盖"（V3-19）。
2. **公共活动租约**：NPC 公共位置变更持有短租约（类比 City Runtime 既有 `game_activity_busy` 单活动槽语义）；租约持有期间其他 Story 对同一 Resident 的公共动作 Intent 返回可解释诊断（`resident_activity_busy` + 持有方 traceId），可退避重试。
   **[r3] 租约生命周期**（防永久占用）：

   ```text
   ResidentActivityLeaseV1 {
     cityId, residentId,            // 租约对象（每 Resident 至多一个活跃租约）
     holderScope: StateScopeV1,     // 持有方（Story 或 Game 子集；公共子集不可持有）
     holderIntentId, traceId,       // 申请来源与审计追踪
     acquiredAtMs, expiresAtMs      // 有界时长；续期 = 显式重取（新 traceId），不隐式顺延
   }
   ```

   释放路径四条，全部幂等：
   - **正常完成**：Intent 提交事务内同事务释放（State/Event/Outbox 与租约删除原子）；
   - **取消/拒绝**：Intent 终态（rejected/cancelled/failed）即刻释放；
   - **持有方崩溃**：不做进程内清理假设——下次仲裁读到 `expiresAtMs` 已过的租约按惰性过期回收（同 `expire_runs` 模式），回收产生 `resident_activity_busy_expired` 审计事件，不静默顶替；
   - **超时**：同惰性过期；持有方仍在工作需在过期前显式重取，重取排队于当刻 Intent 序（可能被抢先，属预期竞争语义）。
3. **私有默认隔离**：私人关系、记忆、对话按 §3.5 四元组 scope 隔离，**默认不跨 Story 可读**；跨 Story 读取必须由目标 Story 显式声明共享声明（Canon 层版本化）并经 Grant。
4. **一致性硬规则**：同一 NPC 在同一权威事件序列中不得同时处于两个地点——Runtime 校验失败即拒绝后到 Intent（V3-05 在多 Story 场景的推广）。
5. **不阻塞**：一个 Story 的公共动作被拒不影响其私有剧情继续；同样不阻塞其他 Story。

[r2] 悬空引用处理（并入实现）：§12 原引用的 `OH_AGENT_MULTI_STORY_COMPOSITION_INSTALLATION_RFC_V1_2026-11-20.md` 不在仓库；其被依赖的关键契约已由 §12.1/§12.3 与本节并入主文。该文档入库后建立单向引用并删除重复定义，不得长期双源。

### 12.3 [r2] Story 安装与更新契约（对齐既有安装事务）

StoryInstallation 直接平移 `city_game_install.rs` 事务族：preview（预检：内容 digest、City 兼容、版本）→ commit（CAS `expectedCityRevision` + operationId 幂等回执 + 更新需显式确认）→ list/disable/uninstall（只改关系，不删内容与历史 Run）。

**[r3] 更新确认绑定内容摘要**（版本供展示、摘要防篡改）：

```text
updateConfirmation {
  currentStoryVersion, targetStoryVersion,      // 展示用
  currentPackageDigest, targetPackageDigest     // 绑定用：commit 时宿主复验当前安装与目标包摘要
}
```

- 同版本号不同内容、或确认后目标包被替换（digest 不匹配）：commit 拒绝并要求重新预检（对齐 Game 侧 `experience_digest_conflict` 先例）；
- 与 Game 安装的差异仅两点：内容身份从 buildId 换 storyId+不可变版本；更新对**旧 StoryRun** 的处理按 V3-22（显式迁移或拒绝）。

**新增 V3 纵向测试**：同一 City 安装"侦探+恋爱"，共享同一 NPC/City Clock，交替启动、停止、重进，长期剧情和私有关系不串线；原飞机穿环与战棋无回归。

## 13. [r1] 与 City Code Game Preview Isolation Spec 的收敛

Preview Isolation Spec（`docs/CITY_CODE_GAME_PREVIEW_ISOLATION_SPEC_2026-11-19.md`）已定义 `PreviewForkV1`（forkId/previewId/baseClockRevision/baseStoryRevision/parentCityId，退出默认丢弃）并有宿主实现（`city_preview_clocks`）。V3 直接采纳并补充：

1. **Fork 语义唯一来源**：Clock/Story Fork 的生命周期（派生→私有推进→终态即忘）以 Isolation Spec §7.3 为准；V3 的 §3.1 表与 §6 `game.intent.simulate` 引用它，不重定义。
2. **快进=只作用于 Fork**：Studio 快进（§5.1）实现为 Preview Fork 的 simulationUtcMs 倍速，正式 Clock 的 `city_clocks` 行不被触碰——现有 `read_preview_clock_at` 已满足，V3 仅补 Story Fork 的对应实现（PR-4）。
3. **两份文档的互斥点已消除**：Isolation Spec 的"Preview Story 写入失败关闭（PR-04 前）"与 V3 PR-4 的信封化是同一条时间线——V3 PR-4 落地前，Preview 中的 ScopedStoryAPI 必须保持不可用；落地后也仅经授权 Grant 开放（§4.1 的设计者约束继续生效）。

### 13.1 [r2] Story Fork 契约化（评审修订 4）

原则层落到可实现条款。Story Preview Fork 在 Clock Fork（已落地）之上增加：

- **绑定**：`forkId ↔ previewId ↔ storyRunId` 三元绑定（对齐 Isolation Spec `PreviewForkV1` 的 forkId/previewId，新增 storyRunId 维度）；Fork 元组带 `baseStoryRevision`（copy-on-read 基线）与 §3.5 的完整 scope。
- **copy-on-read 基线**：首次读 Story State/事件时以 `baseStoryRevision` 快照派生到 Fork 私有命名空间（`fork:` 前缀的 states/events/outbox 行或独立 fork 表，PR 评审定）；此后正式侧推进不进入 Fork，Fork 侧推进不回写。
- **私有 Scheduler**：Fork 内快进 = Fork 私有 simulationUtcMs 倍速 + 只评估 Fork 命名空间的 due 规则；正式 `city_story_rules` 行不被触碰。
- **暂停/恢复**：Fork 可暂停（冻结私有时钟）；恢复继续，不重放已处理 Fork 事件。
- **退出语义**：默认丢弃（删 Fork 命名空间 + 私有 Clock 行——复用 `forget_preview_clock` 路径）；显式保留调试证据是独立、可删除的本地操作。
- **崩溃清理**：WebView 崩溃/宿主退出走 Isolation Spec §8 清理路径，终态时同步丢弃 Fork；残留行只占空间不参与任何正式读路径（幂等清理，失败静默——与 Clock Fork 现行为一致）。
- **验收**：V3-21（快进+提交剧情后正式 StoryRevision/Clock/Outbox 不变）。
