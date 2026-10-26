# 机甲战棋整改：整包结算语义、城市站点转换、控制器拆分

版本：草稿 3 · 日期：2026-10-26 · 状态：D1 已决定升级 v1.4（契约见 3.2 阶段 B）；D2 已决定选 b（所有城市脚本都守楼）

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
| ARCH-8 | 两套渲染、两种视图类型：`MechaLineup` 用 `MechaBoardView`、`CityMechaWorld` 用 `CityMechaView`，由组件各自从 `MatchState` 拼；小怪模型不一致（缩小的 `createBoss` vs `createRaider`）；城市场景整个装在一个约 300 行的 `useEffect` 里 | `MechaBoard.tsx:479-507`；`MechaLineup.tsx:87-90`；`CityMechaWorld.tsx:77-385` |
| ARCH-9 | 战斗动画由**提交的计划**推出，而不是由**实际结算结果**推出：被拒、落空、被击退打断的行动照样播攻击动画 | `MechaBoard.tsx:286-296` |
| PERF-1 | AI 规划同步跑在主线程：平地约 90–160 ms，有路 230–420 ms；自动对战每回合算两次。「按打法填入」、换打法、新开一局都在点击回调里同步调用。**直接违反上游规格 §8.1**（"No … plan enumeration … in a synchronous input handler"）与 §8.2 的 50 ms 主线程任务上限 | 已实测；`MechaBoard.tsx:330,639,642` |

## 2. 目标与非目标

目标：

1. 玩家提交前就能知道整包会不会被拒、为什么、是哪一台（消除 RULE-1、RULE-2 的"莫名其妙被拒"）。
2. 站点到对局只有一份转换，城里画着的楼在规则里就挡路（SITE-1、SITE-2）。
3. 回合推进只有一个入口，UI、AI、脚本、测试共用（ARCH-2）。
4. 控制器可脱离 React 测试（ARCH-1）。
5. 随机对局不变量成为常驻的 CI 守卫。

非目标：不改数值与平衡；不改地形/半步公式；不引入第二份规则实现（沿用架构规格 9.2）；不重做渲染。

## 3. 设计

### 3.0 目标架构

```text
 ┌──────────────────────── engine（CityEngine，不 import game/**）────────────────────────┐
 │  layout / terrain / roadEdges            camera + frame hook + scene（mode lease）       │
 └───────┬──────────────────────────────────────────────────────▲──────────────────────────┘
         │ 只读                                                   │ attach / release
         ▼                                                        │
 City Snapshot Adapter ─► FightTerrainSnapshot（纯数据，带 revision + fingerprint）
         │
         ▼
 ┌──────────── Compute host（一套 worker 协议；主线程分片回退；请求带 revision，过期丢弃）────────────┐
 │  battlefield search: searchPrepared ─► FightCatalog                                              │
 │  squad search:       planForDoctrine(MatchState, doctrine) ─► ArenaPlan                          │
 └───────┬───────────────────────────────────────────────────────────────▲──────────┬───────────────┘
         │ CityMechaSite（含 blocked）                                    │ 请求     │ ArenaPlan
         ▼                                                                │          ▼
 matchFromSite ─► MatchState ─► Mecha Controller（纯 TS 状态机）──────────┘
                                  draft · selection · auto · fault · preview
                                  │ playTurn / previewPlan / legalActions
                                  ▼
                       Rules core（纯，零依赖）
                       board · combat · enemy · turn  ◄── AI search 也只读它
                                  │
 Controller ─► MechaViewModel（唯一视图类型，含 TurnEvent 日志）
                    │
                    ▼
 Presentation：React HUD · CityMechaWorld（Three）· 方格回退棋盘
                    │
                    ▼
 render/mecha：models + animation（engine/playableVehicles 也从这里取，不再穿过 game/）
```

依赖规则（由依赖方向测试钉住）：

| 层 | 可以 import | 不可以 import |
| --- | --- | --- |
| Rules core | 无 | 一切 |
| AI search、matchFromSite | Rules core | React、Three、engine 运行时对象 |
| City Snapshot Adapter、battlefield search | Rules core 的类型与常量、engine 的纯函数（`roadClearance`、`worldScale`） | engine 运行时对象、React、Three |
| Compute host | 上两行 | React、Three |
| Mecha Controller | Rules core、AI 的接口类型、matchFromSite、Compute host 的客户端 | React、Three、engine |
| Presentation | Controller、render/mecha、engine 的 lease 接口 | Rules core 的结算函数（只能经 Controller） |
| render/mecha | Three | game/**、engine/** |
| engine | render/mecha | game/** |

和规格 4 节的差别：AI 搜索与选址并入同一个 compute host；新增 `matchFromSite` 与 `MechaViewModel` 两个接缝；模型与动画从 `game/` 移出。

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
- `TurnEvent` 至少包含：`move`（谁、从、到）、`act`（谁、行动、目标、伤害、是否落空）、`shove`（谁被推、方向、碰撞对象与伤害）、`enemy`（大怪/小怪的技能、命中格、伤害）、`outcome`。事件按发生顺序排列，平局规则与结算一致，可用于回放。
- 战斗动画改为从 `TurnEvent` 生成（ARCH-9），不再从提交的计划推断。
- 草稿不完整时也要能预览：`previewPlan` 对未规划的机甲按待机处理，返回值标明哪些是假设。
- 拒绝原因进入 `gameCopy.ts`，中英两种语言都给出"哪一台、为什么"的句子；`cause` 是翻译的键，不直接显示英文 `reason`。

### 3.2 整包语义（RULE-1、RULE-2、RULE-4）

分两步，第一步**不改规则版本**：

阶段 A（保持 `mecha-v1.3`）：结算顺序固定为**提交顺序**，并在规则文档中写成契约。界面按同一顺序预检，`fault` 指出具体机甲与原因。界面的行动列表、可达格、目标高亮改为基于"前面已提交条目之后的状态"计算，而不是只看当前一台。

阶段 A 还要定下三件现在没人决定的事：

- **顺序由谁定。** 现在界面按 `living()` 的固定顺序（突击→射手→支援）组包，玩家无法调整，AI 也按这个顺序搜索。阶段 A 把它写成规范顺序，界面显示序号；是否允许玩家调整顺序留到 D1 之后（落空语义下顺序只影响平局，可以不开放）。
- **草稿失效规则。** 修改排在前面的机甲后，排在后面的机甲的草稿可能变得不合法。规则：重新预检后面的每一台，不合法的行动退回"未选择"并标注原因，合法的保留；移动目的地被占时一并退回。
- **预告位移是规则还是缺陷（RULE-3）。** 本文认定"推动大怪后预告随之平移"是 v1.3 的规则，不改；只修预览。若要改成"预告钉在地面格"，并入 D1 一起评审。

阶段 B（D1 已通过，2026-10-26：规则串升为 `mecha-v1.4`）。整包结算契约：

1. **规范顺序。** 结算顺序固定为 `MECH_IDS`（突击→射手→支援），与 `plan.items` 的排列无关。同一整包换一种排列，结果字节相同。
2. **移动阶段（同时）。** 所有移动一起校验：
   - 每台的路径按**出发时**的局面计算，但**队友互不阻挡**（三台同时移动）；敌人、掩体、楼、废墟、障碍、水照常阻挡。
   - 各自不超预算。
   - 所有终点（不动的机甲终点即原位）两两不同。允许跟随、互换。
   - 任何一条不满足 → 整包拒绝，`fault` 指出机甲与 `cause`。
3. **行动校验（同时）。** 在"全部移动完成、尚未有任何行动"的局面上，每台的行动必须出现在 `legalActions(该局面, id)` 里，否则整包拒绝。这一步与顺序无关，所以界面的单台预检与提交结果一致。
4. **行动结算（按规范顺序）。** 轮到某台时重新检查它的行动：执行者已死、目标已死、因前面的击退不再相邻或不再对齐 → **落空**：没有效果，**不消耗冷却**，记一条 `act` 事件（`fizzled: true`，带 `cause`）。整包不因落空而被拒。
5. **冷却。** 与 v1.3 相同，只对真正生效的技能计入。
6. **碰撞（RULE-4）。** 见 3.3，脚印目标格上的全部障碍一次结算。
7. **威胁评分（RULE-5）。** `threat()`：机甲 3，楼 2，其余（空地、掩体、障碍）1；平分时按离机甲的距离取近者。大怪和小怪不再优先砸掩体。
8. **预告位移（RULE-3）。** 维持 v1.3：推动大怪后预告随之平移；预览显示平移后的格子（`previewPlan.telegraphAfter`）。
9. 除以上各条外，数值与 v1.3 完全相同。

因为第 1–3 条，阶段 A 里"顺序由谁定"和"草稿失效规则"在 v1.4 下简化为：界面不显示序号，改一台的草稿只需要重新检查**同一终点冲突**。

### 3.3 碰撞结算（RULE-4）

`tryTranslateBoss` 改为先收集脚印目标格上的全部障碍（墙、水、山、小怪、机甲），再一次结算：大怪只受一次 2 点碰撞伤害；每个被撞到的单位各受 2 点；不再因遍历顺序放过其中一个。属于规则行为变化，随 D1 一并决定；若 D1 不通过，则保持现状并把"第一个障碍"写入规则文档。

### 3.4 站点转换 `matchFromSite`（ARCH-4、SITE-1、SITE-2）

新增 `matchFromSite(site, { script, stake, preset })`，放在 `game/mecha/` 下，是 `CityMechaSite` → `MatchState` 的唯一入口：

- `CityMechaSite` 增加 `blocked: Cell[]`（选址阶段 `kind === "blocked"` 且地形为 land 的格子，即场景楼、斜放楼）。`toSite()` 导出它；指纹与缓存键纳入该字段。
- `blocked` **不能直接塞进 `covers`**。掩体在现规则里有三个副作用，都不适用于场景楼：穿射可以无视一格掩体（`los` 的 `ignoreCovers`）；`threat()` 给掩体 2 分，大怪和小怪会去砸它；方格棋盘把它画成掩体。因此新增占位类型 `obstacle`：挡路、挡大怪、挡射击且不能被穿射、不可被攻击、不参与 `threat`。`MatchState` 增加 `obstacles: Cell[]`，`spawnsAreOpenGround` 把它算作不可出生，`CityMechaWorld` 增加对应的地面颜色。
- 所有脚本都带上站点里被认领的楼（D2 = b）。`refresh()` 只要存在楼就启用 `defeat_buildings`（`rules.ts:493`），正是 D2 要的行为，不需要新增 `stake` 取值。站桩砸击与砸砸扫的大怪不移动，楼只有在它的攻击范围内才会被打到；楼在 `threat()` 里是 2 分，所以大怪身边没有机甲时会去砸楼——玩家需要站位挡在楼前。
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
| ARCH-8 | Controller 产出唯一的 `MechaViewModel`；方格回退与城市视图都只读它。小怪统一用 `createRaider`。`CityMechaWorld` 按"场景构建 / 每帧同步 / 输入"拆成三个函数，`useEffect` 只负责生命周期 |
| PERF-1 | AI 规划放进 compute host（与选址同一套协议：请求带 revision，过期丢弃）；主线程回退必须分片，单片不超过 50 ms。规划变成异步后，界面要有"正在规划"状态：「按打法填入」按钮在结果回来前禁用，期间玩家的手动修改优先、迟到的结果丢弃。worker 与主线程两条路径对同一局面必须给出字节相同的计划（加测试） |
| SITE-3 | worker 的 `onerror` 与加载超时都回退到主线程分片搜索。**陷阱：** 现在 `postMessage` 用 transfer 列表把地形 patch 的缓冲区转给 worker（`fightSearchRunner.ts:56-62`），转出后主线程那份已被分离，长度为 0，直接拿来回退会读到空数据。回退前必须重新采样，或改为发送副本、只在确认 worker 启动后才 transfer |
| RULE-5 | `threat` 对"没有机甲可打"的情形改为优先空地中离机甲最近的格；废墟阻挡写进规则帮助文案。属于行为变化，随 D1 决定 |

## 4. 需要拍板的决策

**D1 整包语义是否升到 `mecha-v1.4`（落空而不是整包拒绝）。** **已决定：升（2026-10-26）。** 契约见 3.2 阶段 B。
推荐：升。理由：玩家的直觉是"三台同时行动"，现状的拒绝既不可预期，也无法由界面提前提示干净；落空语义让 AI 与人用同一套规则，并且不再依赖数组顺序。代价：规则串变化，`golden`、`mecha-mechanism.ts` 与分布探针需要重跑并复核。若不升：只做阶段 A，把顺序契约写进文档与界面提示。

**D2 非 siege 脚本下城里的楼的角色。** **已决定：选 b（2026-10-26）**——城市战场上所有脚本都带楼，楼会被敌方攻击打坏，楼注（`stake`）全毁即 `defeat_buildings`，玩家必须守楼。巷战仍只守临街楼。没有城市的方格回退棋盘不变（只有 siege 带楼）。下文推荐 a 的理由作废，保留作记录。
选项 a：只作障碍（挡路挡射击，可被砸但不参与胜负）；选项 b：与 siege 一致，参与胜负。推荐 a，改动面最小，也和"站桩砸击/砸砸扫"不带守楼目标的定位一致。

## 5. 阶段与交付

| 阶段 | 内容 | 是否改规则版本 | 退出条件 |
| --- | --- | --- | --- |
| 1 | `playTurn`/`previewPlan`；`matchFromSite` + `blocked` 导出；界面改用二者；错误指出具体机甲 | 否 | SITE-1 的 `todo` 转正；界面预览与提交一致；`verify:mecha` 全绿 |
| 2 | 控制器抽取；自动对战每回合只算一次 AI；worker 回退（SITE-3） | 否 | 控制器有不依赖 React 的单测；auto 循环有测试 |
| 3 | D1 通过后：移动先于行动、落空语义、碰撞一次结算、`threat` 调整 | 是（v1.4） | RULE-1/2/4 的 `todo` 转正；golden 与分布探针复核 |
| 4 | `rules.ts` 拆分、依赖方向整理、AI 与寻路去重、AI 入 worker、视图模型统一 | 否 | 现有全部测试不变地通过；没有归因于机甲的主线程任务超过 50 ms（上游规格 §8.2） |

阶段 1、2 可立即开工；阶段 3 等 D1；阶段 4 在 1–2 之后进行以降低冲突。

每个阶段收尾时同步更新上游文档：`MECHA_CITY_FIGHT_ARCHITECTURE_SPEC.md` 的 4.3（控制器命令集）、4.4（整包语义）与组件图；`MECHA_CITY_FIGHT_NEXT_SPEC.md` 里涉及规则串与规则帮助文案的段落。阶段 3 若升到 v1.4，`GDD_RULESET` 与 `MatchState.ruleset` 的字面量类型一起改，旧版本不保留并行实现（回退靠 revert）。

## 6. 验收

1. 去掉下列 `todo` 后全部通过：
   - `verify-mecha-city-site.ts`：斜放的楼不可通行（SITE-1）——阶段 1。
   - `verify-mecha-tactics.ts`：跟随走位、补刀、击退后相邻（RULE-1）；友伤杀死队友（RULE-2）；碰撞顺序（RULE-4）——阶段 3。**这几条断言的是 D1 通过后的行为。** 若 D1 不通过，它们要改写为"整包被拒，且 `fault` 指出正确的机甲与 `cause`"，而不是保持 `todo`。
2. 新增并常驻 CI 的 `scripts/verify-mecha-invariants.ts`：固定种子的随机对局（本次审计脚本整理而成），断言第 0 节列出的全部不变量；AI 生成的计划不得被拒；被拒的整包不得改动状态。
   - **时间预算。** 审计时 250 局跑了约 4 分 20 秒，主要耗在 AI 规划上，不适合 CI。CI 版本：随机计划的对局约 200 局 + AI 计划的对局约 10 局，总时长不超过 60 秒；完整规模的跑法保留为手动脚本。
   - **接线。** 加进 `apps/agent-city/ui/package.json` 的 `verify:mecha`，以及 `.github/workflows/verify.yml` 的 `mecha_guards` 任务（现在逐个列出四个脚本）。
3. `playTurn` 的拒绝结果带 `mechId` 与 `cause`；界面在提交前对会被拒的整包给出同样的提示。
4. `matchFromSite` 是唯一转换入口：`MechaBoard` 与测试不再各自手写 `createMatch` 参数。
5. 控制器测试覆盖：切换战场/脚本/打法后的草稿重填、自动对战的暂停与恢复、结局后命令被忽略。
6. 分布探针（`mecha-balance-distribution.mjs`）在阶段 3 前后各跑一次，差异写入评审记录；阶段 1、2、4 的结果必须字节一致。
7. 依赖方向测试：按 3.0 的表逐层检查，至少覆盖"`engine/**` 不 import `game/**`"、"Rules core 零依赖"、"Presentation 不直接调用结算函数"。
8. SITE-3 回退有测试：模拟 worker 异步失败，回退得到的 catalog 与同步搜索字节一致（覆盖 transfer 后缓冲区被分离的情形）。
9. 战斗动画只来自 `TurnEvent`：被拒的整包不产生任何动画提示；落空的行动不播命中。
10. 新的拒绝提示在中英两种语言下都有文案，并有测试确保每个 `cause` 都有翻译。

## 7. 风险

- 阶段 3 改变规则行为，可能移动胜率分布。缓解：先在分支上跑探针，对比基线（见 NEXT_SPEC 第 1 节），超出预期则回到 D1 重议。
- 站点指纹加入 `blocked` 会使旧缓存失效，仅影响首次进入时的重新选址。
- 控制器抽取期间，`MechaBoard` 与新控制器短暂并存。缓解：先让组件只读控制器状态，再删除旧状态。

## 8. 本轮不做

平衡调整；新兵种或新脚本；渲染风格；把规则搬到 wasm 或 Rust；`models.ts` 的内部整理（本次未审计）。
