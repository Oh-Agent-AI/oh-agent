# 机甲战棋对齐 ItB：Codex 执行单

用途：把 `MECHA_ITB_ALIGNMENT_ARCH_2026_11_07.md`（下称"方案"）交给 Codex 时的配套约束。方案回答"改什么"，本文件回答"按什么顺序、在哪停、怎么算完成"。

状态：执行单，未实施。

## 1. 基线（开工前必须确认）

- 分支：从 `dev`（`0636802b`）拉 `mecha/itb-alignment`，不要直接在 `dev` 上改。
- 工作区当前有上一轮未提交的 WIP（14 个修改 + 6 个新增，含 `releasePicker`、`MechaHudPanels`、`SequentialMechaHud` 等）。**先把它作为一个 checkpoint commit 提交到新分支**，不要丢弃、不要混进后续里程碑的 diff。
- 第一条命令必须是 `git status --short` + `git log -1 --oneline`，把结果原样贴出来。
- 禁止 push。需要 push 时先问。

## 2. 执行顺序与闸门

一次只做一个里程碑，做完停下汇报，不要连续跨里程碑。

| 顺序 | 里程碑 | 完成条件 | 停下等确认 |
| --- | --- | --- | --- |
| 1 | 基线 | checkpoint commit；`npm run typecheck` 通过 | 是 |
| 2 | M0 | `preview` 改 `trial`；守卫覆盖 v1.5；记录改前/改后的 preview p95 | 是 |
| 3 | M3 | 抽出 `resolveEnemyPhase`，`runTurn` 与 `sequentialTurn` 共用；`npm run verify:mecha` 全绿且事件序列 golden 不变 | 是 |
| 4 | M4 | `previewEnemyPhase` + 序号叠层；单测覆盖 order/cancel；截图 | 是 |
| 5 | M1 | HUD 契约 + 1.5 收敛；截图矩阵通过后才允许删 `SequentialMechaHud` | 是 |
| — | 决策门 | 回答"v1.5 是否进正式包"（方案第 8 节） | **必须停下问** |
| 6 | M2 | `resolveMechaMode` + 用例；页面无 `import.meta.env` | 是 |
| 7 | M5 | 截图矩阵、浏览器回归、桌面探针 | 是 |

M1 与 M4 可并行，但同一个人做时按上表顺序。

## 3. 硬约束

- 不改战斗数值、胜负条件、状态语义、命中/位移规则。
- 不改 `mecha-net:v1`、v1.4 回放格式、v1.5 检查点字段含义。
- 不新增第三套 UI 实现；改 1.5 时以 1.4 的 DOM 结构为基准。
- 删除 `SequentialMechaHud` / `sequentialMecha.css` 的前置条件：M1 的截图矩阵已通过，且删除前后各有一张同场景截图。
- 每次改完必须跑：`npm run typecheck`、`npm run verify:mecha`；涉及浏览器行为时加跑对应的 `scripts/verify-mecha-v15-*.mjs`。
- 不允许用"类型检查通过"代替视觉验收；不允许用"流程跑通"代替布局一致。

## 4. 每轮汇报格式

1. 改了什么（文件 + 一句话）。
2. 验证命令与**原始结果**（通过/失败数、截图路径）。
3. 没做什么、为什么。
4. 下一步与需要决策的问题。

禁止只写"已完成"。方案 §6 的口径就是验收口径。

## 5. 已知坑（上一轮踩过）

- 把"共用容器/样式"当成"复用 1.4 UI"——必须用同场景截图对比。
- 发布开关写在渲染路径（`MechaBoard.tsx` 的 `releasePicker`），改它之前先确认产品意图。
- `preview` 在 render 里做全量 replay（`records()` 每次深拷贝），先修这个再做 HUD，否则重构期间会更卡。
- `SequentialMechaMatch` 里用 `statusBlocks` 自行判 `canAct`，属于规则漏进视图；按 P1-4 收回 controller。

## 6. 环境与命令

```bash
cd apps/agent-city/ui
npm run typecheck
npm run verify:mecha
npm run build

# 浏览器回归（需先起 dev server）
npm run dev -- --port 5187
node scripts/verify-mecha-v15-browser.mjs http://127.0.0.1:5187
MECHA_V15_LOCALE=en node scripts/verify-mecha-v15-browser.mjs http://127.0.0.1:5187

# 层守卫
node --experimental-strip-types --import ./scripts/mecha-ts-register.mjs \
  ../../../scripts/verify-mecha-layers.ts
```

Playwright 走 `apps/desktop/ui-dev` 的依赖；不要另装浏览器。

## 7. 回退点

- 基线 checkpoint commit。
- M1 删除重复面板前的截图与 commit。
- 任何 golden/事件序列改动都单独一个 commit，便于回退。

## 8. 不在本执行单内

- 方案第 8 节三个待决策（v1.5 正式入口、胜利条件、v1.4 定位）。
- 视觉审美判断：截图给用户看，由用户拍板"像不像"。
- 发布（merge main / beta.4 打包）。
