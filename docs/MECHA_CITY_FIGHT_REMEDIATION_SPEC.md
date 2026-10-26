# 机甲战棋整改：整包结算语义、城市站点转换、控制器拆分

版本：草稿 1 · 日期：2026-10-26 · 状态：待评审（第 4 节两个决策点需要拍板后才能进入阶段 3）

English: this spec fixes the defects found in the 2026-10-26 audit of the mecha tactics code. The pack-resolution rules are made explicit and the UI previews them, the city-site-to-match conversion is unified and stops dropping blocked cells, and the turn sequence plus the controller are pulled out of the React component. Ruleset `mecha-v1.3` stays unchanged until a reviewed decision in §4 says otherwise.

上游文档：`docs/MECHA_CITY_FIGHT_ARCHITECTURE_SPEC.md`（组件模型、4.3 控制器、4.4 整包语义）、`docs/MECHA_CITY_FIGHT_NEXT_SPEC.md`（当前玩法）。本文不改动它们已冻结的数值（`strike`、生命、攻击、防御、楼血、回合上限、半步公式、`TERRAIN_MOD`）。

## 0. 审计方法与可信度

| 手段 | 范围 | 结果 |
| --- | --- | --- |
| 通读源码 | `rules.ts`、`ai.ts`、`citySite.ts`、`fightSearchRunner.ts`、`fightWorker.ts`、`MechaBoard.tsx`、`CityMechaWorld.tsx`、`MechaLineup.tsx`、`animation.ts` | 见第 1 节 |
| 随机对局不变量 | 250 局、约 3000 个被接受的计划，4 种脚本，随机地形与高度，随机行动顺序 | 单位重叠、越界、站水、血量越界、冷却越界、胜负矛盾、回滚破坏：**均为 0** |
| 定向探测 | 第 1 节标"已复现"的条目 | 已落成 `todo` 测试，见第 6 节 |
| 未覆盖 | `models.ts` 内部、`scripts/mecha-ts-*`、`mecha-mechanism.ts` 全文、浏览器交互、平衡性 | 不作结论 |

随机对局的结论是：**规则层的状态机本身稳固**，问题集中在"整包语义的可预期性"和"层与层之间的接缝"。

## 1. 问题清单

严重度：P1 玩家直接遇到；P2 数据或表现错误但有绕行；P3 可维护性。

### 1.1 规则层

| ID | 严重度 | 问题 | 证据 | 现有测试 |
| --- | --- | --- | --- | --- |
| RULE-1 | P1 | 整包按条目顺序逐台结算，合法的计划被整包拒绝。三种表现：跟随走位（`destination occupied`）、同一目标补刀（`shot blocked or out of range`）、击退后后面机甲不再相邻（`not adjacent to an enemy`） | 已复现。`rules.ts:785-800` | `verify-mecha-tactics.ts` 三条 `todo` |
| RULE-2 | P1 | 击退碰撞友伤杀死低血量队友后，后面的条目全部报 `mech is not alive`，包括只待机的队友 | 已复现。`rules.ts:535-540`、`:798` | `todo` |
| RULE-3 | P2 | 玩家近战推动大怪后，预告按相对偏移跟着位移（实测 (3,1)→(4,1)），界面的"受击"预览用推动前的预告 | 已复现。`rules.ts:501-507`；界面 `MechaBoard.tsx:571` | 现状已钉死（通过） |
| RULE-4 | P2 | 大怪被推时只处理脚印顺序里第一个障碍：同时有墙和机甲，机甲受不受伤取决于遍历顺序 | 已复现。`rules.ts:514-533` | `todo` |
| RULE-5 | P3 | 掩体和建筑的 `threat` 权重 2 高于空地 1，没有机甲时大怪和小怪优先砸掩体；废墟永久阻挡且无文案 | 读码。`rules.ts:812-817` | 无 |

### 1.2 城市站点

| ID | 严重度 | 问题 | 证据 | 现有测试 |
| --- | --- | --- | --- | --- |
| SITE-1 | P2 | 选址把"场景楼/斜放楼"标成阻挡格，`toSite()` 不导出，规则里仍是平地，机甲能走进、射穿 | 已复现（斜放楼落在 (9,9)，`pathDistance` 可达）。`citySite.ts:713-731` | `todo`（city-site） |
| SITE-2 | P2 | `fresh()` 只给 `siege`、`raid_ssw` 传楼；选"砸砸扫"、"站桩砸击"时城里的楼对规则不存在 | 读码。`MechaBoard.tsx:244` | 无 |
| SITE-3 | P3 | worker 异步加载失败走 `onerror`，不回退主线程，界面报"战场选择失败"，重试同样失败 | 读码。`fightSearchRunner.ts:29-33,50-54` | 无 |

### 1.3 架构

| ID | 问题 | 证据 |
| --- | --- | --- |
| ARCH-1 | 规格 4.3 的"控制器"没有落地：`MechaMatch` 约 360 行同时承担状态机、草稿、预检、自动对战、渲染，无法脱离 React 测试 | `MechaBoard.tsx:298-660` |
| ARCH-2 | 回合编排泄漏给调用方：`validateAndApplyPlan → bossExecute → bossPrepare` 的顺序在 UI 两处、`ai.ts` 的 `scorePlan`/`peelScore`、脚本里各写一遍 | `MechaBoard.tsx:420-431,516-524`；`ai.ts:99-120,287-307` |
| ARCH-3 | `rules.ts` 1211 行：数值、寻路、战斗、敌方脚本、计划校验、胜负混在一起；`BOARD=10` 在 `CityMechaWorld.tsx` 以字面量重复多处 | `rules.ts`；`CityMechaWorld.tsx:113,279-280` |
| ARCH-4 | 站点→对局的转换没有单一入口：`fresh()` 与测试里的 `open()` 各写一份，且都会丢信息（SITE-1、SITE-2 的根因） | `MechaBoard.tsx:236-253`；`verify-mecha-city-site.ts:10-39` |
| ARCH-5 | 引擎反向依赖游戏：`engine/render/playableVehicles.ts` import `game/mecha/models` | `playableVehicles.ts:15` |
| ARCH-6 | 数据模型对规模封死：小怪 id 固定 `raider-w/e`，渲染按数组下标配两个网格，目标是字符串 `"boss"`/小怪 id | `rules.ts:115-118`；`CityMechaWorld.tsx:136-137,327-350`；`MechaBoard.tsx:206-211` |
| ARCH-7 | 重复实现：`squadPlan`/`peelPlan` 约 100 行近似复制；`pathDistance`/`stepBossTowardObjectives`/`stepRaider` 三份 Dijkstra，堆都是线性扫描 | `ai.ts:126-156,310-340`；`rules.ts:609-648,859-896,1017-1057` |
| PERF-1 | AI 规划同步跑在主线程：平地约 90–160 ms，有路 230–420 ms；自动对战每回合算两次 | 已实测 |

## 2. 目标与非目标

目标：

1. 玩家提交前就能知道整包会不会被拒、为什么、是哪一台（消除 RULE-1、RULE-2 的"莫名其妙被拒"）。
2. 站点到对局只有一份转换，城里画着的楼在规则里就挡路（SITE-1、SITE-2）。
3. 回合推进只有一个入口，UI、AI、脚本、测试共用（ARCH-2）。
4. 控制器可脱离 React 测试（ARCH-1）。
5. 随机对局不变量成为常驻的 CI 守卫。

非目标：不改数值与平衡；不改地形/半步公式；不引入第二份规则实现（沿用架构规格 9.2）；不重做渲染。

## 3. 设计

### 3.1 回合入口 `playTurn`（ARCH-2）

在规则层新增：

```ts
type PlanFault = {
  code: PlanReject["code"];
  mechId?: MechId;          // 出错的是哪一台
  index?: number;           // 在提交顺序中的位置
  reason: string;           // 保持现有英文串，供旧测试断言
  cause?: "occupied" | "target_gone" | "out_of_reach" | "not_adjacent" | "mech_dead" | "cooldown" | "other";
};
type TurnResult =
  | { ok: true; state: MatchState; log: TurnEvent[] }   // 已走完 结算 + 下一回合准备
  | { ok: false; fault: PlanFault };                    // state 未改动
export function playTurn(state: MatchState, plan: ArenaPlan): TurnResult;
export function previewPlan(state: MatchState, plan: ArenaPlan): { ok: true; telegraphAfter: Cell[]; hitsAfter: Record<MechId, number> } | { ok: false; fault: PlanFault };
```

要求：

- `playTurn` 内部完成 `validateAndApplyPlan`、`bossExecute`、`bossPrepare`，调用方不再检查 `phase`。`validateAndApplyPlan` 等旧函数保留导出（脚本与测试在用），内部由 `playTurn` 复用。
- `phase` 的 `resolving_boss`、`enemy_prepare` 退为内部步骤，不再被外部观察到（保留类型以兼容）。
- `previewPlan` 在副本上做与提交相同的逐台试算，返回**推动之后**的预告（RULE-3）与每台的受击预测，供界面显示。
- 旧的 `PLAN_PACK_REJECTED` 等 `code` 与 `reason` 文本不变；`fault` 是附加信息。

### 3.2 整包语义（RULE-1、RULE-2、RULE-4）

分两步，第一步**不改规则版本**：

阶段 A（保持 `mecha-v1.3`）：结算顺序固定为**提交顺序**，并在规则文档中写成契约。界面按同一顺序预检，`fault` 指出具体机甲与原因。界面的行动列表、可达格、目标高亮改为基于"前面已提交条目之后的状态"计算，而不是只看当前一台。

阶段 B（需要决策 D1，见第 4 节，通过则规则串升为 `mecha-v1.4`）：

- 移动先于行动，且同一整包内所有移动一起校验终点互不重叠并各自在预算内（允许跟随与互换），路径仍按出发时的占位计算。
- "目标已被前面条目消灭"、"执行者已被友伤击杀"不再拒绝整包：该条行动落空（fizzle），写入 `log`。真正在提交时就不合法的条目（越界、超预算、冷却中、目标从一开始就不存在）仍然整包拒绝。
- 击退后相邻/对齐失效同样按落空处理。

### 3.3 碰撞结算（RULE-4）

`tryTranslateBoss` 改为先收集脚印目标格上的全部障碍（墙、水、山、小怪、机甲），再一次结算：大怪只受一次 2 点碰撞伤害；每个被撞到的单位各受 2 点；不再因遍历顺序放过其中一个。属于规则行为变化，随 D1 一并决定；若 D1 不通过，则保持现状并把"第一个障碍"写入规则文档。

### 3.4 站点转换 `matchFromSite`（ARCH-4、SITE-1、SITE-2）

新增 `matchFromSite(site, { script, stake, preset })`，放在 `game/mecha/` 下，是 `CityMechaSite` → `MatchState` 的唯一入口：

- `CityMechaSite` 增加 `blocked: Cell[]`（选址阶段 `kind === "blocked"` 且地形为 land 的格子，即场景楼、斜放楼）。`toSite()` 导出它；指纹与缓存键纳入该字段。
- 转换时 `blocked` 进入 `covers`，使其挡路、挡射击、挡大怪。它们不是胜负目标。
- 所有脚本都带上站点里被认领的楼。非 siege 脚本下楼仍是掩体型障碍（`hp` 可被砸，但不参与 `defeat_buildings` 之外的目标选择）——具体取舍见 D2。
- `MechaBoard.fresh()` 与测试的 `open()` 改为调用它。

### 3.5 控制器 `createMechaController`（ARCH-1）

把 `MechaMatch` 里的状态与逻辑抽成纯 TypeScript 模块（无 React、无 Three）：

```ts
type Controller = {
  getState(): ControllerState;           // match、draft、selected、auto、paused、notice、fault
  subscribe(fn: () => void): () => void;
  selectMech(id): void;  setMove(id, cell | null): void;  setAction(id, action): void;
  applyDoctrine(id: DoctrineId): void;   submit(): void;  restart(opts): void;
  startAuto(): void; stopAuto(): void; tick(): void;     // tick 由外部定时器驱动，便于测试
};
```

组件只做订阅与渲染。命令按 `match.revision` 校验。自动对战的"展示→结算"两拍合并为一次规划结果缓存，避免同一回合算两次 AI。

### 3.6 其余整改

| ID | 做法 |
| --- | --- |
| ARCH-3 | `rules.ts` 拆为 `board.ts`（棋盘、地形、寻路）、`combat.ts`（战斗与整包）、`enemy.ts`（大怪与小怪脚本）、`rules.ts`（再导出，路径不变）。`BOARD` 由站点与渲染共用，渲染层不再写字面量 10。拆分前后 `mecha-mechanism.ts` 与现有四个 verify 脚本全部不变地通过 |
| ARCH-5 | `models.ts`/`animation.ts` 移到不依赖 `game/` 的位置（例如 `render/mecha/`），`game/mecha` 与 `engine` 都从那里 import；加依赖方向测试 |
| ARCH-6 | 小怪 id 与数量由 `site.raiders` 决定；渲染网格按 id 建立映射；目标改为带类型的 `{ kind: "boss" } \| { kind: "raider"; id }`，兼容旧字符串 |
| ARCH-7 | 抽一个 `search(state, { evaluate, options })`，`squadPlan`、`peelPlan` 只提供评分与选项；三份 Dijkstra 合并为带二叉堆的通用实现（结果与平局规则不变，由现有 golden/测试钉住） |
| PERF-1 | AI 规划放进现有选址 worker 的同一套机制（请求带 revision，过期丢弃）；主线程路径保留为回退 |
| SITE-3 | worker 的 `onerror` 与加载超时都回退到主线程分片搜索，并保留一次性的控制台提示 |
| RULE-5 | `threat` 对"没有机甲可打"的情形改为优先空地中离机甲最近的格；废墟阻挡写进规则帮助文案。属于行为变化，随 D1 决定 |

## 4. 需要拍板的决策

**D1 整包语义是否升到 `mecha-v1.4`（落空而不是整包拒绝）。**
推荐：升。理由：玩家的直觉是"三台同时行动"，现状的拒绝既不可预期，也无法由界面提前提示干净；落空语义让 AI 与人用同一套规则，并且不再依赖数组顺序。代价：规则串变化，`golden`、`mecha-mechanism.ts` 与分布探针需要重跑并复核。若不升：只做阶段 A，把顺序契约写进文档与界面提示。

**D2 非 siege 脚本下城里的楼的角色。**
选项 a：只作障碍（挡路挡射击，可被砸但不参与胜负）；选项 b：与 siege 一致，参与胜负。推荐 a，改动面最小，也和"站桩砸击/砸砸扫"不带守楼目标的定位一致。

## 5. 阶段与交付

| 阶段 | 内容 | 是否改规则版本 | 退出条件 |
| --- | --- | --- | --- |
| 1 | `playTurn`/`previewPlan`；`matchFromSite` + `blocked` 导出；界面改用二者；错误指出具体机甲 | 否 | SITE-1 的 `todo` 转正；界面预览与提交一致；`verify:mecha` 全绿 |
| 2 | 控制器抽取；自动对战每回合只算一次 AI；worker 回退（SITE-3） | 否 | 控制器有不依赖 React 的单测；auto 循环有测试 |
| 3 | D1 通过后：移动先于行动、落空语义、碰撞一次结算、`threat` 调整 | 是（v1.4） | RULE-1/2/4 的 `todo` 转正；golden 与分布探针复核 |
| 4 | `rules.ts` 拆分、依赖方向整理、AI 与寻路去重、AI 入 worker | 否 | 现有全部测试不变地通过；规划耗时下降到有路地形 < 100 ms（主线程不再阻塞） |

阶段之间互相独立，阶段 1、2 可立即开工；阶段 3 等 D1；阶段 4 在 1–2 之后进行以降低冲突。

## 6. 验收

1. 去掉下列 `todo` 后全部通过：
   - `verify-mecha-tactics.ts`：跟随走位、补刀、击退后相邻（RULE-1）；友伤杀死队友（RULE-2）；碰撞顺序（RULE-4）。
   - `verify-mecha-city-site.ts`：斜放的楼不可通行（SITE-1）。
2. 新增并常驻 CI 的 `scripts/verify-mecha-invariants.ts`：固定种子的随机对局（本次审计脚本整理而成），断言第 0 节列出的全部不变量；AI 生成的计划不得被拒；被拒的整包不得改动状态。
3. `playTurn` 的拒绝结果带 `mechId` 与 `cause`；界面在提交前对会被拒的整包给出同样的提示。
4. `matchFromSite` 是唯一转换入口：`MechaBoard` 与测试不再各自手写 `createMatch` 参数。
5. 控制器测试覆盖：切换战场/脚本/打法后的草稿重填、自动对战的暂停与恢复、结局后命令被忽略。
6. 分布探针（`mecha-balance-distribution.mjs`）在阶段 3 前后各跑一次，差异写入评审记录；阶段 1、2、4 的结果必须字节一致。
7. 依赖方向测试：`engine/**` 不 import `game/**`。

## 7. 风险

- 阶段 3 改变规则行为，可能移动胜率分布。缓解：先在分支上跑探针，对比基线（见 NEXT_SPEC 第 1 节），超出预期则回到 D1 重议。
- 站点指纹加入 `blocked` 会使旧缓存失效，仅影响首次进入时的重新选址。
- 控制器抽取期间，`MechaBoard` 与新控制器短暂并存。缓解：先让组件只读控制器状态，再删除旧状态。

## 8. 本轮不做

平衡调整；新兵种或新脚本；渲染风格；把规则搬到 wasm 或 Rust；`models.ts` 的内部整理（本次未审计）。
