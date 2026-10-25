# 机甲战棋下一轮：守楼、城市地形、道路可读

版本：迭代 3 · 日期：2026-10-25 · 状态：换场重填草稿、打法焦点可见、巷战只守临街楼；第 3–6 节仍是迭代 2 的搜索与选窗

换战场、换脚本、新开一局都会按当前打法重填草稿。面板写明攻坚盯着大怪，或守楼盯着哪一只小怪、哪一栋楼，地面用绿色焦点格标出。巷战的楼注是临街楼：贴着路的楼拆光即 `defeat_buildings`，不临街的楼不决定胜负，敌方和大怪也朝临街楼走。没有临街楼时退回全部楼。平地、靠岸、翻山仍守全部楼。分布探针按四种场地各自打攻坚和守楼。

English: switching field, script, or starting over refills the draft from the current doctrine. The panel names the boss, or the raider and the building Hold is aimed at, and those cells are marked on the ground. An alley stakes only buildings orthogonal to a road. Losing those is `defeat_buildings`. Buildings off the street do not decide the match, and the enemies walk toward the street buildings. A board with no street building falls back to every building. Flat, shore, and ridge still stake every building. The distribution probe fights boss-first and hold on each shape that exists.

规则串保持 `mecha-v1.3`。不改 `strike`、生命、攻击、防御、楼血、回合上限、半步公式和 `TERRAIN_MOD`。玩家选打法和战场。默认仍是攻坚，平地仍是原来的内陆窗。有路、水、山或上坡时，候选的 3 格按半步接近花费排序。面板写出「这一步 N 半步，预算 M」。换打法会重填草稿。Boss 已经倒下之后如果楼先没了或回合用尽，结局写明这一点。巷战包含单侧临街。

English: v1.3 numbers stay. The player chooses doctrine and field shape. Boss-first remains the default, and the flat window stays inland. When the board has a road, water, a mountain, or an uphill step, the three candidate cells are the cheapest half-step approaches. The panel reads “N of M half-steps”. Switching doctrine refills the draft. A loss after the boss is already down says so. Alley includes a one-sided frontage.

## 0. 这一轮补上的两件事

先前的验收只要求水格或山格出现、自动对战改成守楼、半步数看得见。那覆盖不了玩法种类，也把唯一测出的策略收进了脚本。本轮改成玩家能选：

| 选择 | 选项 | 不同在哪里 |
| --- | --- | --- |
| 打法 | 攻坚 `tunnel`、守楼 `peel` | 同一局面，突击迈出的格子到「离楼最近的袭扰者」的距离，守楼更近。两套整包的 JSON 不相同 |
| 战场 | 平地、靠岸、翻山、巷战 | 平地保持严格选窗。靠岸水格 8–30 且平地 ≥ 50。翻山山格 4–20 且平地 ≥ 50。巷战是贴着楼的空格（单侧临街也算）里至少 4 格被涂成路，取这样的路最多的一窗。这座城没有的形状是禁用项，不造格子 |

攻坚仍是 `squadPlan` / `bossTunnelPlan`，自动对战的默认打法。守楼是 `peelPlan`，权重和焦点与第 3 节相同，但是玩家选了才用。面板上的「按打法填入」把当前打法写进草稿，玩家还可以改。切换战场会换一块地并重开这一局，草稿按当前打法重新填上。

## 1. 已测量的基线

样本：16 个种子 × 会话数 80 与 380，背景关，迈阿密海岸，32/32 扇区被接受。随机策略每扇区 5 次（160 场）。探针在 `scripts/mecha-balance-distribution.mjs`，不进 CI。

| 策略 | 结果 | 说明 |
| --- | --- | --- |
| `squad`（现役 `squadPlan`） | 21/32，Wilson 0.483–0.796 | 候选格朝 Boss，Boss 掉血权重 20、袭扰者 12、楼 4 |
| 其中失败 | 11 场，Boss 都已死 | 5 场 `defeat_buildings`，6 场 `defeat_timeout` |
| `reweight` | 24/32 | 只改权重，候选格仍朝 Boss |
| `peel` | 32/32，回合 7–11，均值 8.7 | 候选格和权重都朝「离活楼最近的袭扰者」 |
| `hold` | 0/32 | 三机待机 |
| `random` | 0/160 | 合法步里均匀抽 |
| 道路格 | 最少 0，中位 16，最多 27 | 路少 5/7、中等 10/14、路多 6/11，路多少分不开胜负 |
| 水、山 | 32 个窗口都是 0 | 炮手爬山、支援上坡在这些局里没有格子可用 |

教科书平地围城（无城市地形）：`squad` 第 8 回合胜，`peel` 第 9 回合胜，`hold` 楼被拆光，随机 0/24。

只改权重不够。`reweight` 仍是 24/32。守楼升成玩家可选的打法，不替换攻坚，也不另发明一套未测的混合焦点。上面这 32 扇是曼哈顿选格时的平地窗。

## 2. 冻结

| 项 | 保持 |
| --- | --- |
| 规则串 | `mecha-v1.3`（唯一运行时是 TS `GDD_RULESET`；重复的 Rust 规则实现已删除） |
| 生命 / 攻击 / 防御 | Assault 14/5/2，Gunner 11/4/1，Support 12/2/2；Boss 40/6/3；袭扰者 8/3/1；楼 16/0 |
| 移动力 | Assault 4，Gunner 3，Support 3，Boss 3，袭扰者 4。预算 = 移动力 × `MOVE_QUANTUM`（2） |
| `TERRAIN_MOD` | Assault 路 2；Gunner 路 2、山 2；Support 路 2、陆 2；袭扰者路 2；Boss 三栏 0 |
| 半步 | 平地与道路基础 2，山地与超过 `FLAT_SPAWN_MAX_DELTA` 的上坡基础 4，增益后最低 1。水不可进入，射击穿过水，山地挡射击。推入水或山地撞墙 |
| Boss 步价 | 脚印四格取最贵的一格 |
| 搜索宽度 | 原地 + 朝焦点最近的 3 格；每台机甲最多 5 个行动，另保留原地跳过 |
| 伤害式 | `strike(atk, def) = max(1, atk - def)` |
| 结局 | 敌人清掉为胜；机甲全灭、楼全毁、满 15 回合为三种负 |

袭扰者继续吃道路增益，Boss 继续不吃。街上是突击和袭扰者一起变快。本轮把这件事显示出来，不靠改表制造单方面的路。

## 3. 守楼搜法

守楼是 `peelPlan`。攻坚保持今天的 `squadPlan`，并另导出为 `bossTunnelPlan`。自动对战调用 `planForDoctrine`：默认攻坚，玩家改成守楼后才走本节。分布脚本的 `squad` 列调 `bossTunnelPlan`，`peel` 列调 `peelPlan`，不再各写一份。

参考实现就是分布脚本里原来的 `threatFocus`、`localScore`、`optionsFor(..., "threat")`、`searchPlan(..., "threat", PEEL_WEIGHTS)`。

焦点：

1. 还活着的袭扰者按「到最近一栋活楼的曼哈顿距离」排序，距离相同则 `y`、`x`、`id`。
2. 有袭扰者时，焦点格是第一名的格子，焦点 id 是这只袭扰者。
3. 没有袭扰者时，焦点格是 Boss 脚印中心 `anchor + (1, 1)`，焦点 id 是 `"boss"`。

候选：

- 可达格用 `pathDistance <= moveBudget`。
- 除原地外，取得分最高以前先留 3 格。平地按到焦点的曼哈顿距离。板上有路、水、山，或相邻高差超过 `FLAT_SPAWN_MAX_DELTA` 时，改按走到焦点的半步花费；焦点格被占就走到它四周还能落脚的格子。半步相同再用原来的曼哈顿打破平局。教科书平地没有这些格子，排序与改之前相同。
- 本地分只给打中焦点 id 的攻击加价：冲锋 100、近战 80、穿刺 60、射击 50；修理 20；打向别人的攻击 8。再减去到焦点格的距离。站上预告格减 8。
- 取本地分前 5，并保证「原地且跳过」在候选里。宽度不放大。

整包分，模拟到本回合 Boss 结算之后：

| 项 | 权重 |
| --- | --- |
| Boss 已损失生命 | × 8 |
| 每只袭扰者已损失生命 | × 24 |
| 每栋楼剩余生命 | × 16 |
| 每台机甲剩余生命 | × 3 |
| 活着的机甲到焦点格的曼哈顿距离 | 每格 −1 |
| `victory` | +5000 |
| `defeat_wipe` | −3000 |
| `defeat_buildings` | −4000 |
| `defeat_timeout` | −150 |

整包非法就丢掉。同分取 `JSON.stringify(items)` 字典序较小的一份。三台都待机的包仍然参与比较。

`squadPlan` 另导出为 `bossTunnelPlan`。自动对战调用 `planForDoctrine`，默认攻坚。分布脚本的 `squad` 列调 `bossTunnelPlan`，`peel` 列调 `peelPlan`。攻坚的候选格、本地分和整包权重保持 `squadPlan`（Boss 掉血 ×20、袭扰者 ×12、楼剩余 ×4、楼毁或全灭 −3000、超时 −100）。半步选格的规则两套打法相同。

## 4. 城市窗口留下水和山

`siteMechaWindow` 仍是严格平地窗：水加山超过 18 格就整窗作废。打开战棋时的默认战场就是它。靠岸、翻山、巷战由 `siteFightShapes` 另选，缺的键是 `null`。出生规则：严格窗要求出生采样高差不超过 `FLAT_SPAWN_MAX_DELTA`（1 个世界单位）；Boss、三台机甲、两只袭扰者、至少两栋楼都落在平地格子上，水与山不能出生。整座城没有严格窗时，按 `RELAXED_SPAWN_MAX_DELTA`（2）再选一次——这是文档化的放宽，面板在 `spawnSpread > 1` 时写「出生高差 X · 标准 1，已放宽」，上限就是 2，不再扩大。道路仍在窗口选定之后再涂，不参与打分。

English: the strict window requires spawn relief ≤ 1. When the whole city has no strict window, the search retries once at ≤ 2. That relaxation is documented, surfaced as “spawn relief X · standard 1, relaxed”, and never grows past 2.

靠岸和翻山接受的窗：

- 出生规则与平地相同，包含高差上限 `hi - lo ≤ 12`。
- 靠岸水格 8–30，翻山山格 4–20。少于下限只是噪点。
- 涂路之前的平地格 ≥ 50。
- 通过的窗之间仍用现有的 `better()`。

巷战只在严格平地窗里找。贴着楼的空格（对望或单侧临街）至少 4 格，按这个数量先留 8 个窗；涂路之后其中至少 4 格是路，取路最多的一窗。

不生成假的水或山。城市计划本身不改。上坡格只进入半步花费，不设最低配额。

## 5. 道路格子与步数

### 5.1 路口算进道路

`paintRoads` 把平地格涂成 `road` 的条件改为：格子中心的 `groundRoadClearance(roads, x, z) < 0`。这一个谓词已经包含车行道矩形带、路口转角扇面和换宽渐变段，并且排除桥面与 `structure === "deck"`。水和山不改涂。

`scripts/mecha-ts-hook.mjs` 会给无后缀的相对导入补 `.ts`。城市站点测试沿用 `--import ./scripts/mecha-ts-register.mjs`。若 `groundRoadClearance` 的传递依赖在这个加载器下仍失败，把点在路面内的判断抽到不拉 `three` 的模块，`roadClearance.ts` 与 `paintRoads` 都调它。不手写第二套圆角半径。

### 5.2 面板写出半步

每台活着的机甲一行，含原地。显示：

- 中文：`这一步 {cost} 半步，预算 {budget}`
- 英文：`{cost} of {budget} half-steps`

`cost` 是 `pathDistance(当前位置, 目的地, 机甲 id)`，原地为 0。`budget` 是 `moveBudget(id)`。走不到的格子仍然不能点成草稿。城市叠层和方格回退共用这一行。本轮不在三维格子上写数字。

已有的中文说明补上英文，使英文界面不再出现 `Translation unavailable`：

> Roads halve a step. Assault likes roads, the Gunner climbs for the same cost as flat ground, and Support pays nothing extra uphill. Water is impassable. A push into water or a mountain stops on the wall.

键就是 `MechaBoard` 里现有的那句中文。两条新句子也进 `gameCopy.ts`。半步那一行由 `stepBudgetLine` 按语言整句生成，避免中英词序拼错。

换「打法」时，若还在玩家回合且没有结局，草稿按新打法重填。结局若是楼被拆光或回合用尽，并且 Boss 生命已经是 0，面板写「大怪已倒，楼先没了」或「大怪已倒，回合用尽」。

### 5.3 路面颜色

未选中时，道路格子要在沥青上能被认出来。

| 表面 | 颜色 | 不透明度 |
| --- | --- | --- |
| 城市道路垫 | `#f2c14b` | 0.75 |
| 方格回退 `.mecha-cell.is-road` | `#c4a15a` | 不透明底 |

预告、楼、可达、移动目的地的颜色层次保持现在的覆盖顺序。格子既是路又在可达范围内时仍画成可达色，半步数由面板承担。空地、水、山的颜色不动。

## 6. 验收

单元：

- `node --experimental-strip-types --import ./scripts/mecha-ts-register.mjs --test scripts/verify-mecha-tactics.ts` 现有水、山、上坡、道路断言保持通过。
- 同加载器跑 `scripts/verify-mecha-city-site.ts`：
  - 格子中心落在路口扇面、落在所有边带之外时，该格是 `road`。
  - 水格上有车行道时仍是 `water`。桥面（`bridge` 且 `structure === "deck"`）不把下面的平地涂成 `road`。
  - 合成地形里同时有内陆平地、靠岸和翻山时，`siteMechaWindow` 与 `shapes.flat` 同原点，水格和山格是 0；`shapes.shore` 与 `shapes.ridge` 各自满足配额。
  - 两排楼对望的路，以及单侧临街的路，都能选出巷战。
- 同加载器跑 `scripts/verify-mecha-doctrine.ts`：
  - 手摆平地：Boss 锚点 `(6,6)`，楼在 `(0,0)` 与 `(0,1)`，袭扰者在 `(1,1)` 与 `(8,8)`，三台机甲在 `(4,4)`、`(4,5)`、`(5,4)`。`peelPlan` 里突击的目的地到 `(1,1)` 的曼哈顿距离小于 `bossTunnelPlan`。两套整包的 JSON 不相同。
  - 山墙挡住直线、路边能绕时，守楼的突击落在道路那一行。
  - `stepBudgetLine` 的中文是「这一步 8 半步，预算 8」，英文是 “8 of 8 half-steps”。

分布（手动，不进 CI）：

```
node scripts/mecha-balance-distribution.mjs
```

默认仍是 12 种子 × `{80,380}`、背景关、迈阿密。探针打印每个种子有哪些战场，并在结束时合计平地、靠岸、翻山、巷战各出现多少次。战斗仍打平地窗。教科书平地没有路、水、山，攻坚保持第 8 回合胜，守楼第 9 回合胜。不把「攻坚 ≥ 30/32」当成验收：那条线假设守楼替换了攻坚。

界面：`?demo=1` 打开机甲战棋。面板规则串仍是 `mecha-v1.3`，英文没有 `Translation unavailable`。选中机甲并点一格后，该行出现半步和预算。未选中时机动格在街道上呈 `#f2c14b`。这一轮的截图取城市实地，不取 `engine={null}` 的方格回退。

## 7. 改动面

- `apps/agent-city/ui/src/game/mecha/ai.ts`
- `apps/agent-city/ui/src/game/mecha/citySite.ts`
- `apps/agent-city/ui/src/game/MechaBoard.tsx`
- `apps/agent-city/ui/src/game/CityMechaWorld.tsx`
- `apps/agent-city/ui/src/game/game.css`
- `apps/agent-city/ui/src/game/gameCopy.ts`
- `scripts/verify-mecha-city-site.ts`
- `scripts/verify-mecha-doctrine.ts`
- `scripts/mecha-balance-distribution.mjs`
- 仅当路面谓词拆模块时，动 `apps/agent-city/ui/src/engine/surface/roadClearance.ts` 与新模块

`rules.ts` 的数值与方格回退的存在条件都不在本轮。城市没有够平的窗时，仍显示方格棋盘。

## 8. 本轮不做

- 不改生命、攻击、防御、楼血、回合上限。
- 不把守楼写成自动对战的唯一打法。攻坚和守楼都留在「打法」里，默认仍是攻坚。
- 不放宽搜索宽度。
- 不把袭扰者的道路增益拿掉，也不给 Boss 加道路增益。
- 不在三维格子上写伤害数字或步数。
- 不重排城市外壳（小队条、设置对话框）。
- 不翻译整个游戏，只补本轮出现在战棋面板上的句子。
