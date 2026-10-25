# 机甲战棋下一轮：守楼、城市地形、道路可读

版本：迭代 2 · 日期：2026-10-25 · 状态：待实现

规则串保持 `mecha-v1.3`。本轮不改 `strike`、生命、攻击、防御、楼血、回合上限、半步公式和 `TERRAIN_MOD`。改的是自动对战看向谁、城市窗口是否肯留下水和山，以及道路格子是否和画面上的路面一致、步数是否写在面板上。

English: the next iteration keeps the v1.3 numbers. Auto-battle focuses the raider nearest a living building (the measured peel search). City windows prefer a real shoreline or ridge when spawns still fit. Road cells include junction fillets, and the panel shows the half-step cost. No HP or attack retune.

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

只改权重不够。`reweight` 仍是 24/32。本轮把已经测过的 `peel` 搜法升成自动对战，不另发明一套未测的混合焦点。

## 2. 冻结

| 项 | 保持 |
| --- | --- |
| 规则串 | `mecha-v1.3`（TS `GDD_RULESET` 与 Rust `crates/mecha-tactics` 都保持） |
| 生命 / 攻击 / 防御 | Assault 14/5/2，Gunner 11/4/1，Support 12/2/2；Boss 40/6/3；袭扰者 8/3/1；楼 16/0 |
| 移动力 | Assault 4，Gunner 3，Support 3，Boss 3，袭扰者 4。预算 = 移动力 × `MOVE_QUANTUM`（2） |
| `TERRAIN_MOD` | Assault 路 2；Gunner 路 2、山 2；Support 路 2、陆 2；袭扰者路 2；Boss 三栏 0 |
| 半步 | 平地与道路基础 2，山地与超过 `FLAT_SPAWN_MAX_DELTA` 的上坡基础 4，增益后最低 1。水不可进入，射击穿过水，山地挡射击。推入水或山地撞墙 |
| Boss 步价 | 脚印四格取最贵的一格 |
| 搜索宽度 | 原地 + 朝焦点最近的 3 格；每台机甲最多 5 个行动，另保留原地跳过 |
| 伤害式 | `strike(atk, def) = max(1, atk - def)` |
| 结局 | 敌人清掉为胜；机甲全灭、楼全毁、满 15 回合为三种负 |
| Rust | `path_distance` 仍是教科书整数步，没有城市格子。本轮不改这个 crate |

袭扰者继续吃道路增益，Boss 继续不吃。街上是突击和袭扰者一起变快。本轮把这件事显示出来，不靠改表制造单方面的路。

## 3. 自动对战改为守楼焦点

`apps/agent-city/ui/src/game/mecha/ai.ts` 的 `squadPlan` 改为下面这套。`MechaBoard` 的自动对战继续只调 `squadPlan`。不新增脚本下拉。

参考实现就是分布脚本里的 `threatFocus`、`localScore`、`optionsFor(..., "threat")`、`searchPlan(..., "threat", PEEL_WEIGHTS)`。升入 `ai.ts` 之后，分布脚本改为调用 `squadPlan`，不再留第二份搜法。

焦点：

1. 还活着的袭扰者按「到最近一栋活楼的曼哈顿距离」排序，距离相同则 `y`、`x`、`id`。
2. 有袭扰者时，焦点格是第一名的格子，焦点 id 是这只袭扰者。
3. 没有袭扰者时，焦点格是 Boss 脚印中心 `anchor + (1, 1)`，焦点 id 是 `"boss"`。

候选：

- 可达格用 `pathDistance <= moveBudget`。
- 除原地外，取得分最高以前，先按到焦点格的曼哈顿距离取最近 3 格。
- 本地分只给打中焦点 id 的攻击加价：冲锋 100、近战 80、穿刺 60、射击 50；修理 20；打向别人的攻击 8。再减去到焦点格的距离。站上预告格减 8。
- 取本地分前 5，并保证「原地且跳过」在候选里。

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

现役的朝 Boss 搜法改名为 `bossTunnelPlan`，留在 `ai.ts`，自动对战不调用它。分布脚本用它做对照列 `tunnel`。它的候选格、本地分和整包权重保持今天的 `squadPlan`（Boss 掉血 ×20、袭扰者 ×12、楼剩余 ×4、楼毁或全灭 −3000、超时 −100）。

## 4. 城市窗口留下水和山

选窗仍在 `siteMechaWindow`。出生规则不变：出生采样高差不超过 `FLAT_SPAWN_MAX_DELTA`（1 个世界单位），Boss、三台机甲、两只袭扰者、至少两栋楼都落在平地格子上，水与山不能出生。道路仍在窗口选定之后再涂，不参与打分。

今天非平地超过 18 格就整窗作废，打分还惩罚非平地和高差，所以海岸城也会选出一块内陆平地。第二遍只在第一遍的最优窗水和山都是 0 时跑。

第二遍接受的窗：

- 出生规则与现在相同，包含高差上限 `hi - lo ≤ 12`。
- 水格 ≥ 8，或山格 ≥ 4。少于这个只是噪点，不当作地形。
- 水格 ≤ 30，山格 ≤ 20，涂路之前的平地格 ≥ 50。
- 通过的窗之间仍用现有的 `better()`，不另加一项与出生平整度打架的分。

有第二遍结果就用它，否则用第一遍，并记下 `terrainFeature: "shore" | "ridge" | "none"`（水优先于山，两者都够则 `"shore"`）。不生成假的水或山。城市计划本身不改。

上坡格（相邻平地高差大于 `FLAT_SPAWN_MAX_DELTA`）只计数，不设最低配额。

## 5. 道路格子与步数

### 5.1 路口算进道路

`paintRoads` 把平地格涂成 `road` 的条件改为：格子中心的 `groundRoadClearance(roads, x, z) < 0`。这一个谓词已经包含车行道矩形带、路口转角扇面和换宽渐变段，并且排除桥面与 `structure === "deck"`。水和山不改涂。

`scripts/mecha-ts-hook.mjs` 会给无后缀的相对导入补 `.ts`。城市站点测试沿用 `--import ./scripts/mecha-ts-register.mjs`。若 `groundRoadClearance` 的传递依赖在这个加载器下仍失败，把点在路面内的判断抽到不拉 `three` 的模块，`roadClearance.ts` 与 `paintRoads` 都调它。不手写第二套圆角半径。

### 5.2 面板写出半步

选中一台活着的机甲并且草稿里有目的地时（含原地），这台的行内显示：

- 中文：`这一步 {cost} 半步，预算 {budget}`
- 英文：`{cost} of {budget} half-steps`

`cost` 是 `pathDistance(当前位置, 目的地, 机甲 id)`，原地为 0。`budget` 是 `moveBudget(id)`。走不到的格子仍然不能点成草稿。城市叠层和方格回退共用这一行。本轮不在三维格子上写数字。

已有的中文说明补上英文，使英文界面不再出现 `Translation unavailable`：

> Roads halve a step. Assault likes roads, the Gunner climbs for the same cost as flat ground, and Support pays nothing extra uphill. Water is impassable. A push into water or a mountain stops on the wall.

键就是 `MechaBoard` 里现有的那句中文。两条新句子也进 `gameCopy.ts`。

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
- 同加载器跑 `scripts/verify-mecha-city-site.ts`，新增：
  - 格子中心落在路口扇面、落在所有边带之外时，该格是 `road`；两格以外的平地仍是 `land`；水格不被涂成路；桥面不把下面的格子涂成路。
  - 合成地形里同时有一块内陆平地窗和一块能出生的海岸窗（水 ≥ 8）时，`siteMechaWindow` 返回海岸窗。
  - 海岸窗无法出生时退回内陆窗，`terrainFeature` 为 `"none"`。
- 手摆平地：Boss 锚点 `(6,6)`，楼在 `(0,0)` 与 `(0,1)`，袭扰者在 `(1,1)`，三台机甲在 `(4,4)`、`(4,5)`、`(5,4)`。`squadPlan` 里突击的目的地到 `(1,1)` 的曼哈顿距离小于 `bossTunnelPlan` 的对应距离。

分布（手动，不进 CI），同一条命令：

```
node scripts/mecha-balance-distribution.mjs
```

默认仍是 16 种子 × `{80,380}`、背景关、迈阿密、随机 5 次。在**同一批新窗口**上：

| 检查 | 线 |
| --- | --- |
| `squad` 胜 | ≥ 30/32 |
| `squad` 失败且 Boss 已经死于该场（`defeat_buildings` 或 `defeat_timeout`） | ≤ 2 |
| `squad` 对 `tunnel` 的配对 | `squad` 胜而 `tunnel` 负 ≥ 8 |
| `squad` 胜场余量 | 报告均值和标准差；标准差 > 0 |
| `hold` | 0/32 |
| `random` | 胜场 ≤ 2/160 |
| 教科书平地 `tunnel` | 胜，第 8 回合（锁住旧搜法没被改写） |
| 教科书平地 `squad` | 胜，回合落在 7–12 |
| 水 ≥ 8 或山 ≥ 4 的窗口 | ≥ 8/32 |

迈阿密若到不了 8/32：每个种子打印被拒海岸或山脊窗的失败谓词（出生、高差、楼数、水上限、山上限、平地下限）。谓词日志随 PR 贴出。不得为此涂假地形，也不得放宽出生高差。选择器和合成地形测试仍然要落地。上限是否过紧，等日志证明拒绝来自上限而不是出生规则，再单独立项。

界面：`?demo=1` 打开机甲战棋。面板规则串仍是 `mecha-v1.3`，英文没有 `Translation unavailable`。选中机甲并点一格后，该行出现半步和预算。未选中时机动格在街道上呈 `#f2c14b`。这一轮的截图取城市实地，不取 `engine={null}` 的方格回退。

## 7. 改动面

- `apps/agent-city/ui/src/game/mecha/ai.ts`
- `apps/agent-city/ui/src/game/mecha/citySite.ts`
- `apps/agent-city/ui/src/game/MechaBoard.tsx`
- `apps/agent-city/ui/src/game/CityMechaWorld.tsx`
- `apps/agent-city/ui/src/game/game.css`
- `apps/agent-city/ui/src/game/gameCopy.ts`
- `scripts/verify-mecha-city-site.ts`
- `scripts/mecha-balance-distribution.mjs`
- 仅当路面谓词拆模块时，动 `apps/agent-city/ui/src/engine/surface/roadClearance.ts` 与新模块

`rules.ts` 的数值、`crates/mecha-tactics`、方格回退的存在条件都不在本轮。城市没有够平的窗时，仍显示方格棋盘。

## 8. 本轮不做

- 不改生命、攻击、防御、楼血、回合上限。
- 不给 Rust crate 加城市格子或半步。
- 不加「攻坚 / 守楼」切换。手动操作仍然是玩家自己点格子。
- 不放宽搜索宽度。
- 不把袭扰者的道路增益拿掉，也不给 Boss 加道路增益。
- 不在三维格子上写伤害数字或步数。
- 不重排城市外壳（小队条、设置对话框）。
- 不翻译整个游戏，只补本轮出现在战棋面板上的句子。
