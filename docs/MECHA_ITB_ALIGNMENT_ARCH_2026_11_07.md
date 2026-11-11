# 机甲战棋：对齐《陷阵之志》体验的架构与代码优化建议

状态：建议稿，未实施。本文只提方案与验收口径，不代表任何一项已完成。
日期：2026-11-07
范围：`apps/agent-city/ui/src/game/**` 的机甲战棋（v1.4 经典模式 / v1.5 逐台行动）。

关联文档：

- `MECHA_ARCHITECTURE_UPGRADE_PLAN_2026_11_02.md`：分层与契约目标、已知压力点
- `MECHA_CITY_FIGHT_ARCHITECTURE_SPEC.md`：组件模型、单向依赖、表现层边界
- `MECHA_V15_SEQUENTIAL_TURN_SPEC_2026_11_06.md`：逐台命令流
- `MECHA_V15_STATUS_EFFECTS_SPEC_2026_11_06.md`：状态账本与事件顺序
- 外部输入：《陷阵之志（Into the Breach）》UX 设计调研（2026-10-29，14 页）

## 0. 结论

体验差距**不在规则数值**。v1.5 的回合契约（移动一次 + 行动一次、开火即锁、无限撤销移动、每局一次重置、显式结束回合）已经和《陷阵之志》（下称 ItB）同构；差距集中在三处：

1. **两个页面壳**各自组装 HUD，1.5 丢掉了 1.4 那套按 ItB 单屏布局做出来的信息层级；重构只抽出了面板外壳，没有定义 HUD 契约。
2. **发布开关写在渲染路径里**，v1.5 静态进包，正式入口是否开放取决于一行 `import.meta.env.PROD` 拼出来的表达式。
3. **缺 Attack Order 叠层**：玩家能看到“打哪”，但看不到“谁先打”，确定性体验少最后一格。

因此建议：**不重写规则、不改数值、不动远程协议**；用 M0–M3 四步把“一个内核、两种驱动、一套 HUD、一个开关”收敛出来，再用 M4 补 Attack Order。

## 1. 目标与非目标

### 1.1 目标（可验收）

| 编号 | 目标 | 验收口径 |
| --- | --- | --- |
| G1 | 1.5 与经典模式使用同一套 HUD 布局 | 同一城市、同一阶段，1100×700 / 1440×900 / 390×844 三档截图，区域一一对应 |
| G2 | 打开现有“顺序”能力时能看到逐敌结算序号 | 固定 3 敌人以上 fixture，序号与规则结算序一致 |
| G3 | 模式与发布开关可单测 | `resolveMechaMode` 覆盖 dev/prod/探针/远程/参数矩阵 |
| G4 | 预览与渲染不再随对局长度线性变慢 | 100 条命令后，`preview` p95 < 8ms，无 >100ms 长任务 |
| G5 | 两个页面不再各自实现同一套 view model | 页面代码行数下降 ≥30%，HUD 组件不含战斗判定 |

### 1.2 非目标

- 不改战斗数值、胜负条件、状态语义、命中与位移规则。
- 不改远程协议 `mecha-net:v1`、v1.4 回放格式、v1.5 检查点格式的字段含义。
- 不复制 ItB 的 Roguelike 局外循环（岛屿、驾驶员继承、商店）。
- 不为“像”而保留两套并行 UI 实现。

## 2. 现状评估

### 2.1 已经接近 ItB 的部分（不要动）

| ItB 原则 | 现状 | 证据 |
| --- | --- | --- |
| 完全预知：敌方意图摊开 | 有宣告、射线、悬停归属 | `enemyIntentPresentation.ts`、`declaredEnemyIntents` |
| 移动一次 + 行动一次 | v1.5 用 `rights` 强制 | `sequentialTurn.ts` 的 `rights[mech].move/action` |
| 开火即锁、移动可撤 | v1.5 `undo` 仅在该机甲未行动时可用 | `sequentialTurn.ts` 的 `undo` 分支 |
| 每局一次整回合重置 | 两版都有 | `resetTurn` / `reset` 命令 |
| 显式结束回合 + 未用行动确认 | v1.5 `confirmUnused` | `sequentialTurn.ts` 的 `end` 分支 |
| 确定性结算 | 规则纯函数、无随机 | `rules.ts` / `sequentialTurn.ts` |

### 2.2 与 ItB 的差距

| 差距 | 现状 | 影响 | 对应动作 |
| --- | --- | --- | --- |
| 单屏 HUD 布局 | 1.4 有；1.5 另一套 | “玩法像、看起来不像” | M1 |
| Attack Order 叠层 | 两版都只有阶段顺序 | 算不出整回合 | M4 |
| 环境/状态也参与顺序 | 状态 tick 在回合边界，未标注 | 伤害归属不清 | M4 |
| 动画 Tooltip 教技能 | 有快速指南，无动画演示 | 新机制学习成本 | P2 |
| 胜利条件“撑满回合” | 两版都是清场 | 防守张力弱于 ItB | 待决策（第 8 节） |
| 电网式“真生命” | 防守建筑血量 + 预测 | 接近，但视觉不突出 | P2 |

### 2.3 代码层面的四个结构性问题

**S1 双轨：两套回合前端 + 两套持久化。**
`rules.ts::runTurn` 与 `sequentialTurn.ts` 的 `end` 分支各自走一遍敌方阶段（`bossExecute` → `prepareEnemy`），冷却语义、阶段推进、演出快照各写一份；回放/检查点也是两套（`replayArchive`/`replayRepository` 对 `sequentialCheckpoint`/`Replay`/`Bundle`/`Durable`）。

**S2 两个 god view，没有 HUD 契约。**
`MechaBoard.tsx` 1673 行、39 处 `useState`；`SequentialMechaMatch.tsx` 382 行、22 处 `useState`，单行 JSX 最长 1567 字符。`MechaHudPanels.tsx` 只是 14 个容器组件，页面仍各自推导 view model。

**S3 发布开关在渲染路径。**
`MechaBoard.tsx` 用 `import.meta.env.PROD` + 探针标志 + query 拼出 `v15Requested`，`SequentialMechaMatch` 又是静态 import，v1.5 必然进正式包。

**S4 预览在渲染期全量重放。**
`SequentialMechaMatch.tsx` 在 render 中调用 `controller.preview(...)`；`preview` 内部 `SequentialTurn.replay(initial, authority.records())`，而 `records()` 每次都 `structuredClone` 整个历史。只要选中了行动，每次渲染都要付一次 O(n) 深拷贝 + O(n) 重放；`immediateEnd` 的 `useMemo` 在每次状态变化时再付一次。

## 3. 目标架构

```text
City snapshot → board / combat / enemy / skillEffects（已有，纯函数）
                        │
        ┌───────────────┴────────────────┐
        │ PlanDriver (v1.4)              │ CommandDriver (v1.5)
        │ 整包提交 · 远程 · 回放          │ 逐条命令 · 本地 · 检查点
        └───────────────┬────────────────┘
                        │  MatchState + TurnEvent + PresentationStages
                capturePresentation（共享）
                        │
              MechaHudModel + MechaHudActions（新增契约）
                        │
        MechaHud：经典布局，1.4 / 1.5 共用（1.4 的 DOM 为基准）
```

### 3.1 HUD 契约（M1 核心）

新增 `game/mecha/hud/model.ts`：

```ts
export type MechaHudModel = {
  phase: "deployment" | "planning" | "resolving" | "finished";
  round: number;
  objective: { goal: string; buildings: { hp: number; maxHp: number }[]; forecast: string | null };
  threats: { actor: string; cells: Cell[]; order?: number }[];
  roster: { id: MechId; hp: number; maxHp: number; selected: boolean; statuses: StatusBadge[]; rights: { move: boolean; action: boolean } }[];
  selected: { id: MechId; actions: ActionRow[]; targets: TargetOption[]; preview: PreviewModel | null };
  replay: ReplayModel | null;
  notices: { kind: "error" | "status" | "info"; text: string }[];
};

export type MechaHudActions = {
  select(id: MechId): void;
  moveTo(cell: Cell): void;
  chooseAction(kind: Action["kind"]): void;
  pickTarget(index: number): void;
  confirmAction(): void;
  undoMove(): void;
  resetTurn(): void;
  endTurn(): void;
  confirmEndTurn(unused: boolean): void;
};
```

- `buildClassicHud(state, controller)` / `buildSequentialHud(state, controller)` 是**纯函数**，放 `game/mecha/hud/`，不 import React。
- `MechaHud` 只做布局与无障碍，不读 `MatchState`、不算合法行动、不判胜负。
- 两个页面退化成：订阅控制器 → `buildXHud` → `<MechaHud model actions />` + `<CityMechaWorld>`。

验收：`MechaHud` 不得 import `mecha/combat`、`mecha/rules`、`mecha/enemy` 等运行时规则模块（`board` 的 type-only 导入允许）；新增 `verify-mecha-layers` 断言。

### 3.2 模式解析（M2）

新增 `game/mecha/mode.ts`：

```ts
export type MechaModeInput = {
  dev: boolean; prod: boolean; debug: boolean;
  query: URLSearchParams; remoteStatus: RemoteStatus;
  nativeProbe: boolean; localTest: boolean; releaseChoice: "" | "classic" | "sequential" | "status";
};
export type MechaMode =
  | { kind: "picker" }
  | { kind: "classic" | "sequential" | "status"; reason: string }
  | { kind: "closed"; reason: string };
export function resolveMechaMode(input: MechaModeInput): MechaMode;
```

- 页面只做 `switch (mode.kind)`，不再出现 `import.meta.env` 与 query 解析。
- 远程对局强制 `classic`（协议只接受 `mecha-v1.4`），这条要成为单测，而不是运行时的偶然。
- 纯函数，表驱动用例覆盖：dev 默认、`?mechaV15=1`、探针、正式 picker、远程进行中、参数非法。

### 3.3 回合驱动（M3）

不要求合并两个驱动，只**抽出重复段**：

```ts
// game/mecha/execution/enemyPhase.ts
export function resolveEnemyPhase(state: MatchState, planner: EnemyPlanner): {
  afterEnemy: PresentationSnapshot;
  afterPrepare: PresentationSnapshot;
  hits: Record<MechId, number>;
};
```

- `runTurn` 与 `sequentialTurn` 的 `end` 分支都调用它；状态 tick、冷却递减、阶段推进只在里面写一次。
- 事件顺序不变是硬约束：用现有 `verify-mecha-presentation-changes.ts` 与回放 golden 钉住 `TurnEvent` 序列，任何顺序变化都必须显式改 golden。

### 3.4 持久化信封（P1）

只统一**外壳**，不动两种编码：

```ts
type ReplayEnvelope =
  | { schema: "mecha-replay:v1"; kind: "turn"; ruleset: "mecha-v1.4"; ... }
  | { schema: "mecha-replay:v1"; kind: "command"; ruleset: "mecha-v1.5"; ... };
```

`replayStore.ts` 提供 `save/load/list/remove`，两种 codec 实现 `encode/decode`。收益是 UI 只面对一个“保存/读取/删除”接口，减少 1.5 的四个模块在页面里各自接线。

### 3.5 预览性能（P0，先做）

给 `SequentialTurn` 加一个**从当前快照分叉**的试算入口：

```ts
trial(command: SequentialCommand): SequentialResult; // clone(current) 后执行，不写 journal/history
```

`SequentialController.preview` 改为 `this.authority.trial(...)`，不再 `replay(initial, records())`。成本从 O(n) 深拷贝 + O(n) 重放降到 O(1) 克隆 + 一条命令。

### 3.6 Attack Order 叠层（M4）

参考实现的做法不是“给宣告意图编号”，而是**把整段敌方阶段按序预演一遍**（见附录 A）：环境/状态 → 每个敌人按存储的 order → 每步结果基于前一步的棋盘，并标注该步为什么不会发生。

```ts
// game/mecha/enemyPhasePreview.ts
export type ThreatStep = {
  actor: string;                                  // boss / raider id / "status"
  order: number;
  cancel: "" | "dead" | "frozen" | "stunned" | "no_target";
  outcome: { hp: Record<string, number>; buildings: Record<string, number> };
};
export function previewEnemyPhase(state: MatchState): ThreatStep[];
```

- 实现：克隆 `MatchState`，按结算序跑一遍敌方阶段并逐步 diff 血量与建筑；`order` 来自结算序，不由 UI 排序。逐步 outcome 需要把 `bossExecute` 与 raider 循环拆成可按 actor 调用的形式——正好和 M3 的 `resolveEnemyPhase` 一起做。
- UI 只读 `ThreatStep[]`：按住 Alt 或点“顺序”按钮显示序号；悬停敌人只高亮该 actor；`cancel` 用图标说明“这次不会发生”。
- 只读：预演在克隆上跑，不写 `MatchState`、不产生对外事件；回放中可用同一函数。
- 状态 tick 也编号，因为 v1.5 的毒/烧伤害发生在敌方阶段之前，玩家需要知道它插在哪一步。

## 4. 优化项清单

| ID | 优先级 | 内容 | 主要文件 | 风险 |
| --- | --- | --- | --- | --- |
| P0-1 | P0 | `preview` 改分叉试算，去掉渲染期全量重放 | `sequentialTurn.ts`、`sequentialController.ts` | 低；行为等价需用现有测试钉住 |
| P0-2 | P0 | 新增 HUD 契约，1.5 收敛到经典布局，删除 `SequentialMechaHud` 重复实现 | `MechaHudPanels.tsx`、`MechaBoard.tsx`、`SequentialMechaMatch.tsx` | 中；移动端布局可能回归 |
| P0-3 | P0 | 模式解析器 + 开关移出渲染路径 | `MechaBoard.tsx`、新增 `mode.ts` | 低；需产品确认正式入口 |
| P0-4 | P0 | Attack Order：敌方阶段预演（order + cancel + 逐步 outcome） | 新增 `enemyPhasePreview.ts`、`CityMechaWorld.tsx` | 中；依赖 M3 的 actor 级拆分 |
| P1-1 | P1 | 抽出共享敌方阶段 | `rules.ts`、`sequentialTurn.ts`、新增 `enemyPhase.ts` | 中；事件顺序 |
| P1-2 | P1 | 回放/检查点统一信封 | 5 个 sequential 模块 + `replayRepository.ts` | 中；存档兼容 |
| P1-3 | P1 | 守卫补洞：`sequentialController`、`sequentialDurable` 纳入纯层检查 | `scripts/verify-mecha-layers.ts` | 低 |
| P1-4 | P1 | `canMove`/`canAct`/`blockedReason` 由 controller 提供，视图不再调 `statusBlocks` | `sequentialController.ts`、`SequentialMechaMatch.tsx` | 低 |
| P2-1 | P2 | `board.ts` 拆分（常量/类型/寻路/表现快照） | `board.ts` | 低收益，改动面大，缓做 |
| P2-2 | P2 | 内联 `t()` 收敛回 `gameCopy.ts` | 两个页面 | 低 |
| P2-3 | P2 | 胜利条件“撑满回合”作为 mission 类型 | `mission` 机制、`rules/pve.ts` | 产品决策 |

## 5. 里程碑

| 里程碑 | 内容 | 产出 | 粗估 |
| --- | --- | --- | --- |
| M0 | 盘点 + P0-1 性能修复 + 守卫补洞 | 预览 p95 达标；`verify-mecha-layers` 覆盖 v1.5 | 1 天 |
| M1 | HUD 契约 + 1.5 收敛 + 删除重复面板 | 两版同一布局；截图矩阵 | 2–3 天 |
| M2 | 模式解析器 + 开关外移 | `mode.ts` + 用例；页面无 `import.meta.env` | 0.5–1 天 |
| M3 | 共享敌方阶段 | `enemyPhase.ts`；事件序列 golden 不变 | 1–2 天 |
| M4 | Attack Order：敌方阶段预演 + 叠层 | 序号、取消原因、逐步结果 | 1–2 天 |
| M5 | 验收 | 截图矩阵、浏览器回归、桌面探针 | 1–2 天 |

顺序建议：**M0 → M3 → M4 → M1 → M2 → M5**。M3 只搬不改，做完它 M4 才能拿到 actor 级的逐步结果；M1 不依赖 M3，可以与 M4 并行，但它是最大的一块，做完再谈发布。

合计约 6–10 人日，不含第 8 节产品决策的等待时间。

## 6. 验收

### 6.1 视觉矩阵

同一城市、同一战斗阶段，各截一张，两版并排：

| 视口 | 语言 | 必须检查 |
| --- | --- | --- |
| 1100×700 | zh / en | 战斗栏、队伍区、目标区、操作区、回放区 |
| 1440×900 | zh | 同左，检查留白与信息密度 |
| 390×844 | en | 窄屏堆叠、触控目标、遮挡 |

判定不是“好看”，是**区域一一对应**：ItB 的左轨队伍 / 左上资源与结束回合 / 左下单位面板，在 mecha 里必须能找到对应位置。

### 6.2 交互回归

两版都要过：部署 → 移动 → 撤销 → 行动确认 → 结束回合 → 保存 → 恢复 → 回放 → 退出。

### 6.3 自动化与性能

| 检查 | 口径 |
| --- | --- |
| `npm run typecheck` / `npm run build` | 通过；无新增 chunk 警告 |
| `npm run verify:mecha` | 全绿 |
| `scripts/verify-mecha-layers.ts` | 新增 v1.5 文件纳入检查 |
| 预览耗时 | 100 条命令后 p95 < 8ms |
| 主线程 | 无 >100ms 长任务（沿用既有验收口径） |

### 6.4 Attack Order 验收

- 单元：固定 3 敌人 + 状态 tick 的 fixture，`previewEnemyPhase` 的 order 必须等于规则实际结算序（玩家状态 tick → boss → raiders → 腐蚀），逐步 outcome 与真实执行后的 diff 一致。
- 取消：先击杀/冻结一个敌人，再预演，对应步骤必须给出 `cancel` 而不是照常算出伤害。
- 交互：按住 Alt 显示、松开隐藏；悬停敌人只高亮该条；不改变任何规则状态。
- 视觉：截图确认序号不遮挡血条与目标标记。

## 7. 风险与回退

| 风险 | 缓解 |
| --- | --- |
| 删 `SequentialMechaHud` 导致移动端布局回归 | 先做截图基线，再删；保留一个 commit 可回退 |
| 共享敌方阶段改变事件顺序 | 事件序列 golden；先只搬不改 |
| 正式入口开放后 1.5 仍有未验收项 | M2 的开关默认关闭，产品确认后再开 |
| Attack Order 增加渲染负担 | DOM 叠层而非 Three 文本；默认隐藏 |
| 存档格式统一破坏旧回放 | 信封只加不改；旧格式按 `schema` 分支读取 |

## 8. 待决策

1. **v1.5 是否进正式包**：当前 WIP 的 `releasePicker` 会在 PROD 弹“机甲战棋 1.5 · 本地 PvE”。这是产品决策，必须先于 M2 定。
2. **胜利条件**：ItB 是“撑满回合”，mecha 是“清场 + 保一栋”。建议作为 `mission` 类型新增，而不是改默认胜负。
3. **v1.4 的最终定位**：远程与旧回放的兼容层，还是继续作为默认本地模式。

## 9. 与既有文档的关系

- 本文不替代 `MECHA_ARCHITECTURE_UPGRADE_PLAN_2026_11_02.md` 的分层目标，只把其中“controller 规模、规则重复”两条落到 v1.4/v1.5 的具体收敛步骤。
- 状态语义、事件版本、检查点字段以 `MECHA_V15_STATUS_EFFECTS_SPEC_2026_11_06.md` 为准，本文不改。
- 视觉验收沿用 `MECHA_BATTLE_UX_ACCEPTANCE.md` 的口径：浏览器观察不等于设备验收，截图矩阵不能由单张截图代替。
- 本文的 M1/M2 是平台层的前身：HUD 契约对应 `CITY_ACTIVITY_PLATFORM_ARCH_2026_11_07.md` 的 HUD 插槽，`resolveMechaMode` 对应 Activity Router；平台化时上提，不要各写一套。

## 附录 A：外部实现对照（2026-11-07 检索）

### A.1 来源与可信度

ITB 没有公开源码，能直接观察的是社区 Mod Loader 暴露的 vanilla API（Lua 绑定到游戏内部类）——它描述的是游戏对象的**对外形状**，不是实现。另有若干开源克隆可作结构参考，但它们不是 ITB 的实现，质量也参差。

| 来源 | 形态 | 用途 | 可信度 |
| --- | --- | --- | --- |
| itb-community/ITB-ModLoader wiki（Vanilla API） | 文档 | `Board`/`Pawn`/`SpaceDamage`/`SkillEffect` 的真实字段与函数 | 高（对 API 形状） |
| serge-sotnyk/into-the-breach-vibe | TypeScript + Canvas，2026-10，自述 "vibecoding experiment" | `battle/{board,attacks,effects,turn,preview}.ts` 的结构 | 中（结构参考，代码量小） |
| CodyEthanJordan/OutOfTheDungeon | C#，2020 | 另一个独立克隆 | 低（未细读） |
| morgan0128/SeniorDesign-Spring2026 | C++/Godot，2026 | 可继续阅读的第三人实现 | 低（未细读） |

### A.2 概念映射

| ITB（vanilla API） | 含义 | mecha 对应 |
| --- | --- | --- |
| `Board` | 棋盘 + 单位 + 动画 + 忙闲状态 | `MatchState` + `CityMechaWorld` |
| `Pawn`（机甲固定 id 0/1/2） | 单位 | `MechId` / raider / boss |
| `SpaceDamage` | **单格效果描述**：伤害、推动方向、火/酸/冰/盾/烟、地形、生成、音效、延迟 | `Action` + `TurnEvent` |
| `SkillEffect` | 有序的 `SpaceDamage` 序列 | 一次行动的 `TurnEvent[]` |
| `Board:IsDeadly` | 用同一份描述预测“会不会死” | `previewPlan` / `preview` |
| `Board:GetTurn` | 回合 | `MatchState.turn` |

结论：概念是一一对应的。我们的 `MatchState` + `TurnEvent` 与 ITB 的 `Board` + `SpaceDamage` 是同一个问题的两种表达。

### A.3 克隆实现里值得学的三点

**1）整段敌方阶段预演，才是 Attack Order 的完整形态。**

`into-the-breach-vibe` 的 `computeThreats(s)`（`src/game/battle/preview.ts`）先跑环境阶段，再按每个敌人的 `plan.order` 顺序模拟攻击；**每一步的 outcome 建立在前一步留下的棋盘上**（护盾被打掉、敌人先被冻或先死、同一目标被多次命中都会体现），并给出 `cancel: 'dead' | 'frozen' | 'smoke' | 'water' | 'edge'`。

这比“给宣告意图编号”强一个量级：它回答的是“如果我现在结束回合，按顺序会发生什么”。本文 §3.6 / M4 已按这个形态改写。

**2）预览 = 克隆 + 施加效果 + diff。**

`simulate()` 克隆 `BattleState`，`applyEffects()`，再由 `diffOutcome()` 算出 `hpAfter/deaths/buildingLoss/gridLoss/tiles`。同一个 `applyEffects` 在真实执行和预览里共用，靠 `withoutRecording()` 关掉动画录制。

对我们的意义：预览应当是“当前快照 + 一条命令”，而不是“从头重放历史”——这正是 P0-1 的 `trial()`；`withoutRecording` 这种“同一套函数两种模式”也值得借鉴（我们已有 `swapEventSink`）。

**3）`canMove` / `canAct` 留在规则层。**

克隆把 `canMove`、`canAct`、`weaponBlock` 都放在 `turn.ts` 里，UI 只读结果；`Unit` 上的 `moved`/`acted` 是权威字段。我们的 `SequentialMechaMatch` 在组件里自己算 `canAct` 和 `restrictions`（调 `statusBlocks`），等于把一条规则搬回了视图。建议 controller 直接暴露 `canMove/canAct/blockedReason`，HUD 不再判规则。

### A.4 不要学的地方

1. **`Board` 同时是规则状态和演出总线。** ITB 的 `Board` 上有 `AddAnimation`/`SetWeather`/`IsBusy`，`SpaceDamage` 里塞 `sSound`/`fDelay`/`sAnimation`。这是 Mod API 的形状，但对我们是反面教材：`TurnEvent` 与 `PresentationStages` 分离更利于回放、远程与测试。
2. **把 `vfx` 放进效果联合类型。** 克隆的 `Effect` 里有 `{ k: 'vfx' }`，规则数组里混演出指令；我们不要。
3. **单个 battle UI 文件 50 KB。** 克隆的 `src/ui/screens/battle.ts` 也是 god view——说明这是品类通病，M1 的 HUD 契约不是过度设计。

### A.5 对本文结论的影响

- M4 升级：从“序号码”改为“敌方阶段预演”，顺带得到“若立即结束，逐步会发生什么”的预测；依赖 M3 把敌方阶段拆到 actor 级。
- P0-1 加强：预览改为克隆 + 单条命令（`trial`），并考虑把 targeting 结果物化为效果列表。
- 新增 P1 建议：`canMove`/`canAct`/`blockedReason` 由 controller 提供，视图不再调 `statusBlocks` 判规则。
- 不变：`TurnEvent`/`PresentationStages` 分离、单内核双驱动、HUD 契约、发布开关外移。

### A.6 链接

- Vanilla API 索引：https://github.com/itb-community/ITB-ModLoader/wiki/Vanilla-API
- SpaceDamage：https://github.com/itb-community/ITB-ModLoader/wiki/%5BVanilla%5D-SpaceDamage
- Board：https://github.com/itb-community/ITB-ModLoader/wiki/%5BVanilla%5D-Board
- TypeScript 克隆：https://github.com/serge-sotnyk/into-the-breach-vibe（`src/game/battle/preview.ts`、`turn.ts`、`types.ts`）
- C# 克隆：https://github.com/CodyEthanJordan/OutOfTheDungeon
- C++/Godot 克隆：https://github.com/morgan0128/SeniorDesign-Spring2026
