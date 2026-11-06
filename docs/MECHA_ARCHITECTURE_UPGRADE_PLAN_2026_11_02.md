# Mecha Architecture Upgrade Plan — 2026-11-02

状态：设计提案  
基线：`dev` / `feature/mecha`，commit `4896b0d4 feat(mecha): refine assault movement and city encounters`  
范围：City 内置 Mecha 战斗的规则、AI、会话、远程同步与表现层演进  
性质：增量架构升级，不是重写，也不是 Into the Breach 复刻

---

## 1. 结论

当前 `feature/mecha` 的主干架构方向是正确的，不应推倒重来：

- `MatchState`、`ArenaPlan`、`TurnEvent`、`PresentationStages` 已经构成较清晰的战斗契约。
- `MatchRuleAdapter` 已经能把 PvE/PvP 规则权威与会话执行解耦。
- `mecha-net:v1`、`RemoteArenaV1`、revision、commandId、完整快照回放，已经为远端对战打下基础。
- UI 不应直接改写权威状态；规则权威负责校验与结算，这个边界应继续保持。

下一步的重点不是“重构成更像某个外部项目的架构”，而是把三条已经存在但还不够正式的边界补齐：

1. **规则核心边界**：把 PvE/PvP 共同需要的棋盘、行动、结算、事件能力抽成更稳定的领域接口，模式差异显式策略化。
2. **AI Planner 边界**：AI 只消费 `MatchState`，只输出 `ArenaPlan` 和可解释评分；候选生成、模拟、评分、选择分层。
3. **表现投影边界**：权威状态和事件永远是事实源；表现阶段是投影，不能反向影响规则结果。

---

## 2. 目标

升级后系统应满足：

- 本地 PvE、远程 PvE、好友 PvP 使用同一套可测试的规则执行模型。
- 规则输入、计划提交、事件输出、表现投影都有版本化契约。
- AI 决策可复现、可解释、可单独测试。
- 新技能、敌人、地形、模式策略可以增量加入，不需要复制整条规则流程。
- 远程对战继续满足最小数据边界：只传比赛数据，不传日志、提示词、本地路径、凭证或任意宿主数据。
- UI 断线、慢设备、worker 不可用时能显式降级，而不是破坏权威状态。

---

## 3. 非目标

本计划不承诺以下事项：

- 不引入通用插件数据访问。
- 不把远程比赛通道扩展为任意数据同步通道。
- 不实现云存档、遥测、崩溃上报或用户数据上传。
- 不一次性统一 PvE 和 PvP 数值。
- 不复制无 license 的外部项目代码。
- 不为当前三机甲、小棋盘规模提前引入复杂 ECS、分布式模拟或通用战斗 DSL。

---

## 4. 当前基线评估

### 4.1 已经良好的部分

| 能力 | 当前锚点 | 判定 |
| --- | --- | --- |
| 战斗状态 | `MatchState` | 结构完整，适合继续作为核心状态契约。 |
| 整队计划 | `ArenaPlan` | “整包提交”优于逐键上报，远程同步也更稳定。 |
| 规则结果 | `TurnEvent[]` | 已具备语义事件，适合测试、回放和 UI 投影。 |
| 表现数据 | `PresentationStages` | 已把“发生了什么”和“怎么演”分开，方向正确。 |
| 规则适配 | `MatchRuleAdapter` | PvE/PvP 可通过统一 adapter 接入会话。 |
| 远程协议 | `mecha-net:v1` | 已有 revision、commandId、错误码和完整快照。 |
| 远程战场 | `RemoteArenaV1` | 战场渲染数据与规则状态分离。 |
| 草稿/计划 | `planning.ts` | 本地和远程可共享草稿、投影和预检封装。 |

### 4.2 主要压力点

| 风险 | 说明 |
| --- | --- |
| `combat.ts` 承担过多规则细节 | 移动、行动、伤害、击退、碰撞、事件生成等能力集中度偏高，继续加内容会增加回归风险。 |
| AI 权重和候选逻辑分散 | `ai.ts` 内已有 doctrine、局部候选评分、整包计划评分，但评分因子尚未成为稳定契约。 |
| PvE/PvP 存在规则重复 | 已有共享查询，但双方结算循环仍各有细节；继续复制会扩大语义漂移。 |
| 规则能力缺少统一能力描述 | 新技能若继续分散实现，目标选择、AOE、位移、状态和事件会越来越难组合。 |
| controller 规模较大 | `controller.ts` 同时承担交互编排、状态推进、展示协调等职责，后续功能增长会降低可测性。 |

---

## 5. 目标架构

### 5.1 分层总览

```text
UI / Controller
  编辑草稿、显示焦点、触发确认
  不直接修改权威 MatchState
        │
        ▼
Plan Facade
  ArenaPlan 组装、revision 绑定、预检请求、提交请求
        │
        ▼
Match Session / Match Client
  权限、revision、commandId、本地或远程路由
        │
        ▼
Match Rule Adapter
  PvE / PvP 模式策略入口
        │
        ▼
Battle Rule Core
  棋盘查询、目标绑定、效果执行、事件生成、阶段推进
        │
        ▼
Deterministic Snapshot
  MatchState + TurnEvent + PresentationStages
```

### 5.2 建议目录演进

以下目录名是演进目标，不是要求一次性搬文件：

```text
apps/agent-city/ui/src/game/mecha/
  contracts/
    arena.ts
    match.ts
    transport.ts

  core/
    board.ts          # 棋盘、占位、路径、脚印查询
    entities.ts       # 稳定实体引用、阵营、生命、能力只读视图
    actions.ts        # 行动校验与目标绑定
    effects.ts        # 后续技能效果原语
    events.ts         # TurnEvent 构造与不变量
    resolve.ts        # 计划结算编排

  rules/
    pve.ts
    pvp.ts
    policy.ts         # 模式策略注入点

  ai/
    candidates.ts     # 候选移动/行动生成
    simulate.ts       # 只读/隔离试算
    score.ts          # 评分因子、权重、解释
    planner.ts        # 组合候选、调用评分、选择 ArenaPlan

  session/
    MatchSession.ts
    journal.ts        # commandId / revision / result journal

  presentation/
    ...
```

迁移时保留现有公共 import 路径或提供 re-export，避免一次大范围改动 UI。

---

## 6. 核心契约升级

### 6.1 `MatchState` 保持权威状态

`MatchState` 仍然是规则权威的唯一输入/输出状态。第一轮升级不改变字段语义，只收紧访问方式：

- UI 只读。
- planner 只读或使用隔离副本。
- 只有 `MatchRuleAdapter.playTurn()` 的成功路径产生新的权威状态。
- 远程端永远以权威快照为准，本地预览只是乐观视图。

### 6.2 `ArenaPlan` 保持整包计划

继续坚持：

- 一次提交整队计划。
- `plan.revision` 必须等于提交时已知 `state.revision`。
- 重复 commandId 返回首次结果，不重复结算。
- 非法计划原子拒绝，不产出半套状态。

### 6.3 新增 `PlanEvaluation` 契约

当前 AI 已经有评分，但建议把评分结果显式化：

```ts
export type ScoreFactorId =
  | "boss_damage"
  | "raider_damage"
  | "building_damage"
  | "mech_damage"
  | "kill"
  | "repair"
  | "victory"
  | "defeat"
  | "position"
  | "threat"
  | "cooldown"
  | "tie_break";

export type ScoreFactor = {
  id: ScoreFactorId;
  value: number;
  weight: number;
  score: number;
  note?: string;
};

export type PlanEvaluation = {
  plan: ArenaPlan;
  score: number;
  factors: ScoreFactor[];
  deterministicKey: string;
};
```

要求：

- `PlanEvaluation` 不进入远程协议，仅用于本地 AI、调试、测试和面板解释。
- 同一 `MatchState`、同一 doctrine、同一权重版本必须产生相同 `PlanEvaluation`。
- `factors` 必须足以解释为什么 A 计划胜过 B 计划。
- 修改默认权重需要新增版本号，例如 `ai-weights:v1`，并更新确定性测试。

### 6.4 新增 `CandidateSource` 契约

```ts
export type CandidateAction = {
  mechId: MechId;
  moveTo: Cell | null;
  action: Action;
};

export interface CandidateSource {
  readonly id: string;
  candidates(state: MatchState): CandidateAction[];
}
```

职责：

- 只生成候选，不评分。
- 不修改输入状态。
- 可以按 doctrine 裁剪候选宽度。
- 输出顺序必须稳定，用于测试和可复现搜索。

### 6.5 新增 `PlanSimulator` 契约

```ts
export interface PlanSimulator {
  apply(state: MatchState, plan: ArenaPlan): MatchState | null;
}
```

要求：

- 输入状态不被修改。
- 非法计划返回 `null` 或结构化失败，不允许半更新状态。
- PvE 模拟可以选择是否执行 Boss 阶段；该选择必须显式命名，不能靠隐式全局开关。
- PvP 模拟只预演本方计划能确定的部分，不伪造对方未来行动。

### 6.6 新增 `PlanScorer` 契约

```ts
export interface PlanScorer {
  readonly weightVersion: string;
  score(state: MatchState, plan: ArenaPlan): PlanEvaluation | null;
}
```

要求：

- 评分只依赖状态、计划、权重与 doctrine。
- 不访问 UI store、网络、日志或机器数据。
- 分数必须能拆成 `ScoreFactor[]`。
- 同分必须使用稳定 tie-break，当前 JSON 字典序方向可保留，但应成为契约测试的一部分。

### 6.7 Planner 组合接口

```ts
export type PlannerDoctrine = "tunnel" | "peel";

export interface MatchPlanner {
  readonly doctrine: PlannerDoctrine;
  plan(state: MatchState): ArenaPlan;
  evaluate(state: MatchState): PlanEvaluation[];
}
```

约束：

- planner 不直接调用 React setState。
- planner 不持有可变 `MatchState`。
- planner 不直接写 `TurnEvent`。
- planner 输出的计划仍必须交给规则权威校验。

---

## 7. 规则核心演进

### 7.1 先抽 `BattleBoardView`

不要一开始抽统一实体继承树。第一步只抽只读查询：

- 坐标和棋盘边界
- 2×2 脚印
- 占位和阻挡
- 地形/高度查询
- 可达格
- 射线和对齐
- 相邻/环绕格

这些是 PvE 和 PvP 都需要的能力，也最不容易改变玩法语义。

### 7.2 显式模式策略

避免核心逻辑里散落 `if (mode === "pvp")`。建议引入策略描述：

```ts
export type ModePolicy<S> = {
  ruleset: string;
  activeSide(state: S): MatchSide | null;
  targets(state: S, actor: EntityRef): TargetGroup[];
  canTarget(state: S, actor: EntityRef, action: PlannedAction, target: EntityRef): boolean;
  applyDamage(state: S, context: DamageContext): DamageResult;
  applyPush(state: S, context: PushContext): PushResult;
  advancePhase(state: S): S;
  outcome(state: S): MatchOutcome | null;
};
```

第一版不需要完整实现上述接口，只要 PvE/PvP 中重复的判断逐步移入策略即可。

### 7.3 效果原语

只有当技能数量继续增长时，再引入通用效果描述。建议优先级：

1. **damage**
2. **push / pull**
3. **move target**
4. **terrain effect**
5. **status**
6. **persistent object**
7. **multi-stage effect**

每个原语必须输出事件，不能只在状态上静默修改字段。

示例：

```text
skill =
  targeting
+ optional move
+ effect chain
+ event projection
```

不要过早追求完全数据驱动。当前规则量还不值得引入完整脚本运行时。

### 7.4 结算不变量

规则核心必须保证：

- 输入状态不可变。
- 一个计划要么完整成功，要么原子拒绝。
- 结算顺序稳定，并与文档一致。
- 目标死亡、位移后失配、行动落空必须产生事件。
- `TurnEvent[]` 与 `PresentationStages` 不冲突。
- revision 只由权威成功结算递增。

---

## 8. AI 升级路径

### 8.1 当前问题

当前 `ai.ts` 已经支持 tunnel 和 peel 两种 doctrine，并采用“局部候选评分 + 笛卡尔组合 + 整包计划评分”的方案。这个方案适合当前规模。

问题是：

- 局部启发式和整包评分混在同一文件。
- 权重没有统一版本和解释输出。
- 候选裁剪、模拟、评分、选择耦合。
- 后续加入更多技能或敌人时，难以独立测试。

### 8.2 阶段一：行为锁定

先不改变 AI 结果：

- 为现有 `squadPlan()`、`peelPlan()` 增加固定局面 golden 测试。
- 记录每个 doctrine 选中的 `ArenaPlan` 和关键评分因子。
- 锁定同分 tie-break。
- 确保同一输入永远输出同一计划。

### 8.3 阶段二：抽取 scorer

把现有 `scorePlan()`、`peelScore()` 的因子拆到 `ai/score.ts`：

- boss 伤害
- raider 伤害
- 建筑血量
- 机甲血量
- 胜利/失败
- 位置代价
- 威胁暴露
- 冷却
- tie-break

初期可以允许输出总分仍与旧逻辑一致；等测试稳定后再调参。

### 8.4 阶段三：抽取 candidate source

把可达格裁剪、目标偏好、动作排序抽到 `ai/candidates.ts`。

约束：

- 当前搜索规模不大，不需要追求完全穷举。
- 候选裁剪规则必须显式记录，例如“每机甲最多 N 个移动点 + M 个动作”。
- 不能因为裁剪导致明显次优的守楼行为。

### 8.5 阶段四：引入 search budget

当前不需要 minimax。未来如引入多回合预测或更强敌方脚本，再增加：

- `nodeBudget`
- `timeBudgetMs`
- `maxDepth`
- `maxCandidatesPerMech`
- `deterministicSeed`

搜索结果应包含：

- 被评估节点数
- 剪枝原因
- 最佳计划
- 最佳 `PlanEvaluation`

所有预算只影响搜索深度，不影响规则结果。

---

## 9. PvE / Pv P 共享策略

### 9.1 共享内容

应共享：

- 坐标、脚印、路径、占位
- 射线、对齐、AOE 形状
- 整队移动校验
- 行动合法性和目标绑定
- 事件结构
- revision/commandId 语义
- presentation stage 投影方式

### 9.2 不强行共享的部分

不应急于统一：

- PvE Boss 行为
- PvE 建筑失败条件
- PvP 阵营目标
- PvP 胜负判定
- 双方平衡数值
- 回合时限和断线判负

这些属于模式策略，应显式注入。

### 9.3 迁移原则

- 先写行为锁定测试。
- 再移动代码，不先改语义。
- 每次迁移一个能力，例如“共同移动校验”或“射线查询”。
- 迁移后运行 `verify:mecha`、`verify:mecha-remote`、`verify:mecha-clarity`。
- 禁止通过共享层静默修改 PvE 数值。

---

## 10. 会话与远程架构

### 10.1 权威模型

继续采用：

- 桌面权威会话持有 `MatchState`。
- 客户端提交完整 `ArenaPlan`。
- 权威端复验规则。
- 成功后广播完整快照、事件和表现投影。
- 远程端不基于本地预览继续推理权威状态。

### 10.2 `MatchSession` 职责

`MatchSession` 继续作为唯一会话状态机：

- 验证玩家。
- 验证回合权限。
- 验证 revision。
- 按 commandId 去重。
- 调用对应 `MatchRuleAdapter`。
- 保存最近 journal。
- 生成快照和事件。
- 管理认输、关闭、结束。

### 10.3 远程 v1.1 增强项

在现有 `mecha-net:v1` 稳定后，才考虑 v1.1：

| 能力 | 建议 |
| --- | --- |
| 重连 | 已有完整快照优先；不引入增量 patch，直到比赛状态规模变大。 |
| 观战 | 增加 read-only role，不授予提交计划权限。 |
| 回合时限 | 必须先做规则契约，再影响 UI。 |
| 掉线裁定 | 单独评审，不默认自动判负。 |
| 复盘 | 以快照 + `TurnEvent[]` 为事实源，不依赖 UI 日志。 |
| AI 托管 | 只允许对当前回合生成一次 `ArenaPlan`，仍走权威校验。 |

### 10.4 数据边界

远程比赛数据只允许：

- `RemoteArenaV1`
- `MatchState`
- `ArenaPlan`
- `TurnEvent[]`
- `PresentationStages`
- 比赛 room / player / revision / commandId 元数据

禁止：

- 本地日志
- prompt、会话分析、agent 数据
- 机器标识
- 本地路径
- 凭证或 token
- 任意插件数据
- City 全量工程数据
- 遥测或崩溃上报

通道仍必须限定在用户发起或明确接受邀请的 match scope 内。

---

## 11. 表现层升级

### 11.1 原则

表现层是投影，不是规则权威：

- 权威状态决定比赛事实。
- `TurnEvent[]` 描述语义变化。
- `PresentationStages` 描述播放顺序。
- UI 动画慢或中断时，不允许影响下一回合权限。
- 动画完成后 UI 才进入下一交互阶段。

### 11.2 建议增强

- 将 remote 和 local 的计划播放统一到一个 projection coordinator。
- 每个 stage 附带因果事件 ID 或事件索引，避免动画和规则日志脱节。
- 对跳过、失败、落空、位移后目标失效提供明确视觉语言。
- 保留“跳到结果”的能力，尤其对慢设备或长动画。
- presentation snapshot 必须可从 state + events 重建，不依赖临时 DOM 状态。

---

## 12. Worker 与性能

当前 worker/主线程 fallback 思路应保留：

- 搜索和重资源计算放 worker。
- worker 不可用时降级为主线程分片。
- 每个 worker request 有 requestId。
- 取消请求时终止 worker，避免旧结果污染新局面。
- 主线程单次任务保持短分片，避免阻塞输入。

AI planner 的第一优先级是正确和可解释，不是极限性能。只有当候选搜索造成可感知卡顿时，再引入 worker 化或更复杂缓存。

---

## 13. 测试与验收

### 13.1 必测不变量

每个阶段都应保持：

- 同一 `MatchState + ArenaPlan` 产生同一 `MatchState + TurnEvent[] + PresentationStages`。
- 非法计划不修改状态。
- 重复 commandId 不重复结算。
- stale revision 被拒绝。
- PvE/PvP adapter 的 ruleset mismatch 被拒绝。
- UI 收到非法、迟到、重复消息后仍能恢复到最新权威快照。
- AI 同一输入、同一权重版本输出同一计划。

### 13.2 新增测试矩阵

| 测试 | 目标 |
| --- | --- |
| AI golden tests | 锁定 `squadPlan()`、`peelPlan()` 的固定局面输出。 |
| `PlanEvaluation` tests | 验证因子、权重、总分、tie-break。 |
| candidate determinism tests | 候选顺序稳定，裁剪规则明确。 |
| simulator isolation tests | 输入状态不被修改，非法计划原子失败。 |
| PvE/PvP shared query tests | 同一棋盘查询在两种模式下结果一致。 |
| remote replay tests | 快照 + 事件能重建表现流程。 |
| protocol negative tests | 错误协议、错误 ruleset、错误 revision、错误 commandId 均被拒绝。 |
| degradation tests | worker 不可用、远程断线、presentation 中断不破坏状态。 |

### 13.3 命令

在 `apps/agent-city/ui` 下运行：

```bash
npm run typecheck
npm run verify:mecha
npm run verify:mecha-remote
npm run verify:mecha-clarity
npm run verify:mecha-models
```

涉及 UI 集成时，再按当前验收流程执行 browser/native 走查。

---

## 14. 实施阶段

### Phase 0 — 冻结基线

目标：不改行为，建立安全网。

- 记录当前 `feature/mecha` 的关键局面。
- 为 PvE、PvP、AI、remote session 增加行为锁定测试。
- 输出当前模块依赖图。
- 禁止在无测试保护时移动规则代码。

完成标准：

- 现有 verify 命令全绿。
- AI 在固定局面下输出可复现计划。

### Phase 1 — Planner 契约

目标：抽出 AI 评分，不改变规则和协议。

- 新增 `CandidateSource`。
- 新增 `PlanSimulator`。
- 新增 `PlanScorer`。
- 新增 `PlanEvaluation`。
- `squadPlan()` / `peelPlan()` 改为组合这些接口。
- 保持外部 API 不变。

完成标准：

- `ai.ts` 不再直接包含所有候选与评分细节。
- 同一输入输出与 Phase 0 golden 保持一致。
- AI 决策能列出主要评分因子。

### Phase 2 — Rule Core 只读查询

目标：抽共享棋盘查询。

- 新增 `core/board.ts` 或等价模块。
- 移动 footprint、占位、路径、射线、可达查询。
- PvE/PvP 调用同一实现。
- 不改伤害、击退和胜负规则。

完成标准：

- PvE/PvP 对同一棋盘查询输出一致。
- `verify:mecha` 全绿。
- 没有新增 `if (pvp)` 分支。

### Phase 3 — 结算编排稳定化

目标：让 `validateAndApplyPlan()` 的内部流程更清晰。

- 拆成显式阶段：
  1. 校验 revision/参与者
  2. 校验移动
  3. 应用移动
  4. 校验行动和目标绑定
  5. 按规范顺序结算
  6. 生成事件
  7. 推进阶段
  8. 生成 presentation projection
- 保持外部契约不变。
- 引入内部 invariant checks。

完成标准：

- 非法计划零状态变化。
- 事件与状态变化一一对应。
- PvP/PvE 的差异集中到 adapter/policy。

### Phase 4 — Controller 瘦身

目标：降低 UI 编排复杂度。

- 将纯状态选择、焦点计算、可用动作查询从 controller 抽出。
- controller 只保留输入事件、会话调用、状态装载和错误呈现。
- 本地和 remote 复用同一 plan projection hook。

完成标准：

- controller 不直接实现规则判断。
- 本地和远程 UI 使用同一计划预检/展示路径。
- UI 回归通过。

### Phase 5 — Skill Effect Registry

目标：支持后续内容增长。

- 引入小规模 effect registry。
- 每个效果必须声明 target policy、state mutation、events、presentation hints。
- 新技能先写规则测试和表现测试，再接 UI。
- 不引入脚本执行器或热加载。

完成标准：

- 新增一个代表性技能只需注册效果与策略，不修改整条结算循环。
- 事件和表现投影可测试。
- 旧技能行为 golden 不变。

### Phase 6 — Remote v1.1

目标：在 v1 稳定后增强远程能力。

- 观战或 AI 托管二选一先行。
- 明确重连、超时、裁判规则。
- 增加端到端断线测试。
- 保持最小比赛数据边界。

完成标准：

- 断线、迟到消息、重复消息、ruleset mismatch 场景全部有测试。
- 远程端不会因本地预览与权威结果不同而破坏状态。
- 无新增用户数据上传路径。

---

## 15. 外部参考与取舍

### 15.1 ITB solver Gist

该 Gist 是单文件 D 语言回合求解器，不是完整游戏源码。其可借鉴点有限：

- 全局加权评分函数。
- 确定性模拟。
- 行动来源与模拟器分离。
- 搜索切片思想。

不建议采用：

- 单文件架构。
- verbose 字符串日志替代事件。
- 非法行动粗粒度失败。
- 固定尺寸和静态内容表。
- 复制其实现代码。

该项目没有 license，本计划只吸收设计思想，不复制代码。

### 15.2 ITB ModLoader

可学习 target area、skill effect queue、Board/Pawn 抽象和 hook 语义，但不应照搬 Lua mod runtime。  
当前项目需要强类型、版本化、权威校验和最小数据边界，通用插件式 hook 不适合作为第一优先级。

### 15.3 小型课程项目类实现

可以参考 skill composition、terrain polymorphism、AI strategy 的教学式拆分，但不采用其 GUI 耦合、无确定性回放和无权威会话的结构。

---

## 16. 决策记录

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 是否重写 | 不重写 | 现有契约和远程模型已经正确。 |
| 是否采用通用 ECS | 暂不 | 当前实体规模小，收益不抵迁移风险。 |
| 是否引入规则脚本语言 | 暂不 | 会增加安全、版本和调试成本。 |
| 是否统一 PvE/PvP 实体 | 渐进 | 先共享只读查询和结算编排，不强行统一玩法。 |
| 是否 AI 走复杂搜索 | 暂不 | 当前三机甲小棋盘更适合候选裁剪 + 整包评分。 |
| 是否远程增量同步 | 暂不 | 回合制完整快照更可靠，规模尚未要求 patch。 |
| 是否允许 AI 直改状态 | 禁止 | AI 只产出计划，规则权威结算。 |

---

## 17. 最小执行清单

如果要立即开始，第一周建议只做：

1. 增加 AI golden 局面测试。
2. 增加 PvE/PvP 棋盘查询回归测试。
3. 新增 `PlanEvaluation` 类型和 `PlanScorer` 接口。
4. 将现有 doctrine 权重迁入显式 `ScoreFactor`。
5. 保持所有公共导出和外部协议不变。
6. 跑完整 mecha verify。

这一步完成后，系统就具备继续抽 rule core、effect registry 和更强 AI 的安全基础。


## 18. 2026-11-05 效果边界增量

近战与冲撞此前在同一函数中直接编排伤害、事件和大怪推移，预览与播放又独立计算 `shove` 的终点，容易出现技能语义和展示口径漂移。本次只迁移现有本地 PvE 近战：`skillEffects.ts` 显式描述伤害加成及存活大怪推移的顺序，规则适配仍负责原来的伤害、护盾、碰撞和事件；近战/冲撞对小怪没有推移，死亡大怪不再推移，均维持 v1.4 原行为。

同一模块的 `projectShove` 从既有权威事件与已知起点投影 moved/blocked/unknown，供候选预览和表现播放复用；未知起点不猜测，受阻不伪造位移。协议、规则版本及事件字段没有改变。回归覆盖冲撞成功和障碍受阻下的预览、实际事件及播放路径一致。

这不是完整效果注册表：怪物特殊技能、状态/地形的统一执行及事件因果关系尚未迁移；现有 UI 仅保留现有推移提示。冲撞是否推小怪、普通近战是否推大怪及数值变化仍需产品决定，并在规则版本和回放兼容策略确定后单独实施。


## 19. 2026-11-05 生命值原语复用

`skillEffects.ts` 提供伤害下限和治疗上限的数值原语，供本地 PvE 机甲/大怪/小怪伤害、守护建筑受击、维修及 PvP 伤害和维修复用。PvP 近战使用同一伤害加成编排，但仍按原 PvP 规则不推移。护盾吸收、持续伤害的护盾例外、建筑去重和事件时间顺序仍由各自权威规则负责；不因此把不同伤害类型的语义合并。

相位/引力、蚀格、召唤、护盾、神经链接仍通过各自规则和已有事件/严格表现证据处理，尚未接入通用效果执行器或统一因果接口；仅通过既有回归不代表已完成统一。后续需逐项设计因果关联与版本兼容后迁移，不得通过改写旧回放或放宽远程协议实现兼容。


### 后续增量：特殊技能建筑伤害

环轨穿刺和孢子弹跳的建筑伤害也使用共享 `applyDamage` 原语；去重、命中次序、健康事件和状态变更依然由对应技能适配器负责。该步骤不等于特殊位移、状态或实体生命周期已统一接入效果执行器。


### 后续增量：特殊敌方技能分发入口

`resolveRegisteredUnitEffect` 为现有八种已注册敌方技能提供一个解析和分发入口；未知技能返回 `unregistered`，调用方仍走既有旧规则分支。相位交换、引力井、护盾、腐蚀、召唤、神经链接以及孢子弹跳、环轨穿刺继续由原适配器校验和结算，事件格式与顺序保持不变。此步骤只统一特殊敌方技能的入口，不是统一效果原语或事件因果接口的完成证明。


### 后续增量：位移表现投影

`projectMovementEffect` 为普通推挤、相位交换和引力井提供共同的表现读取接口。相位交换的多个目标作为一个效果组保留；一般推挤的受阻或未知起点不伪造位移。特殊位移仍必须先通过既有 `PresentationChanges` 证据校验；事件、规则及网络契约不变。此步骤统一的是表现投影，特殊位移的权威结算、其他效果类型及效果因果接口仍未统一。


## 20. 2026-11-06 异常状态基础（独立规则，尚未实战接入）

`statusEffects.ts` 提供可组合、无状态副作用的 poison/burn/freeze/stun 基础。每条状态携带 source、target、可配置强度和剩余目标回合数；同目标/类型/来源重复施加取较大强度和较长持续时间，不同来源独立。目标回合结束由宿主显式调用：poison/burn 提出伤害事件、递减持续时间并在到期时输出事件；freeze 限制移动，stun 限制移动与行动；解除按目标和类型清除各来源。顺序沿输入顺序确定，非法/重复记录整批拒绝，不更改输入。以上均为初始设计假设，不是已确认的技能数值或玩法平衡。

该模块不修改 MatchState 或 HP，不连接预览、AI、行动校验、回合驱动、技能、状态图标、表现、回放或 PvP/远程协议；也不自行保证每目标每回合恰好调用一次。接入前必须明确 PvE/PvP 单位回合、首次触发时间、相互作用与伤害/护盾关系、死亡清理和幂等，设计版本化状态与事件、旧回放和网络兼容，并覆盖状态预测和实战展示。不得宣称当前玩家已可使用这些状态。


## 21. 2026-11-06 建筑碰撞 v1.5 规则内核（未启用）

新增仅由 `createMatch({ruleset: "mecha-v1.5", ...})` 显式选取的规则内核：被推机甲或大怪撞上活建筑时，被推对象按既有规则受 2 点碰撞伤害，受撞建筑受 2 点伤害；大怪 2×2 目标脚印仅检查新进入格，同一栋多格建筑去重，多个建筑分别结算。碰撞阻止位移，不做连锁推挤。大怪护盾仍按既有规则处理，事件通过原 `shove.effects` 记录，胜负仍由既有 refresh 处理。v1.4 默认行为不变。引擎单测验证不同版本、碰撞去重、护盾、建筑摧毁和胜负。

**未完成或启用**：`matchFromSite`、本地工作台与 Web 测试入口仍创建 v1.4 对局；当前 `pveRules`、本地回放存储/重建、挑战码、怪物目录、远程 host/client 和 Rust 网关仍只支持 v1.4。`MatchSession` 新增状态与适配器/arena 的版本一致性检查，避免将 staged v1.5 状态冒充 v1.4。v1.5 不得用于正式存档/远程/用户可见对局，直至完成各入口、版本化回放/挑战码、远程协商及兼容性测试。当前阶段不应声称产品功能已上线。
