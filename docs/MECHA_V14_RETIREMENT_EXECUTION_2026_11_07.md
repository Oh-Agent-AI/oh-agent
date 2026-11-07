# v1.4 完全退役：代码现状与 Codex 执行计划

状态：执行建议；基于 `mecha/itb-alignment` 当前工作树（2026-11-07）。
日期：2026-11-07
关联：`MECHA_V15_CONSOLIDATION_PLAN_2026_11_07.md`、`MECHA_ITB_ALIGNMENT_ARCH_2026_11_07.md`、`MECHA_ITB_ALIGNMENT_HANDOFF_2026_11_07.md`。

## 0. 现状快照

- 分支 `mecha/itb-alignment`，基线 checkpoint 为 `d80307cfc`。A 阶段收口包含后续撤销、目标绑定、地块检查和机甲状态显示修复。
- 已完成：M0（`trial`）、M2（`mode.ts` + `MechaModeRuntime`）、M3（`execution/enemyPhase`）、M4（`enemyPhasePreview` + 顺序叠层）、M1 大部分（`MechaHud` 契约、删除 `SequentialMechaHud` 与 `sequentialMecha.css`）。
- **退役本身还没开始。**

三个必须先处理的隐性耦合：

1. `mecha/mode.ts` 的 `remote_requires_v14`：`if (remoteStatus !== "idle") return { kind: "classic", ... }`——远程一开，v1.5 就被锁死。
2. `mecha/sequentialReplayRepository.ts:3`：从 `replayRepository.ts`（v1.4 模块）导入 `ReplayBackend` 和 `sequentialReplayBackend()`——v1.5 存档依赖 v1.4 文件。
3. `SequentialMechaMatch.tsx:19`：从 `controller.ts` 导入 `cuesFromLog`——v1.5 视图依赖 v1.4 控制器。

另外 `rules.ts` 是混合体：`createMatch`（共享，`matchFromSite` 在用）和 `playTurn` / `previewPlan`（v1.4 专用）在同一个文件里，不能整文件删。

## 1. 退役的定义

**删**：`controller.ts`、`ai.ts`、`planning.ts` 与草稿/评估 UI、`replayArchive` / `replayRepository`（v1.4 部分）、`rules/pvp.ts`、远程 v1.4 会话、`mecha-v1.4` 的运行时分支。
**留**：`board`、`combat`、`enemy`、`skill*`、`deployment`、`citySite`、`matchFromSite`、`presentation`、HUD。

完成标准：src 里 `mecha-v1.4` 只作为历史字符串存在；`MechaBoard` 不再创建 `MechaController`；远程 handoff 跑在 v1.5 上。

## 2. 阶段与任务

### A. 先收口当前分支（0.5 天）

- 把现有改动拆成 3 个 commit：① M1 HUD 契约及交互修复；② M2 mode resolver；③ M3/M4、回合状态及文档/测试。共享文件存在跨里程碑依赖，三项作为一个 checkpoint 验收。
- 跑 `typecheck` + `verify:mecha` + v15 浏览器流程，打 tag `itb-alignment-checkpoint-2`。
- **不要**把退役改动混进这批 commit，否则回退粒度会丢失。

### B. 纯删除（2–3 天，无移植）

#### B1 PvP

- 删 `mecha/rules/pvp.ts`、`contracts/match.ts` 的 PvP 类型、`contracts/transport.ts` 的 `mode: "pvp"`。
- 删 `session/MatchSession.ts` 的 pvp 分支、`client/RemoteMatchSynchronizer.ts` 的 pvp 检查、`presentation/BattleScenePort.ts` / `RemoteBattleScene.ts` 的 `PvpState` 分支。
- 删 `RemoteMechaControls.tsx` 的“邀请好友/批准/拒绝”，保留开启、链接、停止。
- 删原生 `remote_gateway_projection.rs` 的 `PVP = "mecha-pvp:v1"` 与相关测试。
- 删测试：`pvp-rule-target-binding`、`pvp-session`。

#### B2 旧存档 / 旧回放

- 先把 `ReplayBackend` 与 `sequentialReplayBackend` 从 `replayRepository.ts` 抽到 `replayBackend.ts`，改 `sequentialReplayRepository` 的 import。
- 再删 `replayArchive.ts`、`replayRepository.ts` 的 v1.4 部分、`MechaBoard` 的经典回放入口/回放栏/自动存档。
- `plugin_state.rs`：删 `mecha-local-replay-entry:v1` 校验与测试，保留 `plugin.state`。
- **核对容量**：通用插件文件有 32 KiB 限制；机甲回放和检查点的专用 SQLite 路径使用 40,000 字节 archive 和 41,024 字节记录限制。检查前后端实际序列化边界，并覆盖 31/33 KiB、40,000/41,024 字节及超限行为。
- 旧数据：按未知 schema 忽略或清理，不能阻塞启动。

#### B3 测试/脚本清扫

- 删以旧格式为 fixture 的用例：`mecha-local-replay`、`mecha-replay-playback`、`mecha-replay-archive`、`mecha-replay-persistence-guard`、`mecha-replay-auto-save`、`mecha-rescue-replay`、`mecha-neural-replay-guard`。
- 同步 `verify-*.mjs` 里对 `.mecha-replay-*` 的选择器。

### C. 移植（1.5–2 周）

#### C1 怪物内容（先做，解锁练习/状态挑战）

- `monsters/registry.ts`：把 `MONSTER_RULESET_V1` 换成 catalog，每个物种带 `supportedRulesets`、`practice`、`statusKind`、`skillId`、`visualKey`。
- `board.ts::MONSTER_SKILLS` 与 `contracts.ts::PLANNED_SIGNATURE_SKILLS` 合并成一份 skill 表。
- `SequentialController` 的 4 物种白名单改成 catalog 查询；`MechaMonsterPractice` 的 `PLAYABLE_PRACTICE_SPECIES` 从 catalog 派生。
- 视觉：`createMonsterSpeciesOrnament` 的 id 分支收敛到 `visualRegistry`（可后置）。
- 验收：catalog 每项都能解析到 skill + visual；v1.5 能跑全部 `practice: true` 的物种。

#### C2 AI / 自动对战

- 先抽共享：`cuesFromLog`、`MechaControllerState` 中被 HUD 使用的类型 → `presentation/cues.ts` / `hud/`。
- 新增 `mecha/ai/commandPolicy.ts`：`next(view) → SequentialCommand | null`，用 `SequentialTurn.trial()` 在 v1.5 语义下评估。
- `SequentialController` 暴露 `suggest()` / `autoStep()`；`MechaBoard` 的打法/自动按钮改走 v1.5。
- 验收：同一局面 AI 命令序列可复现；自动对战浏览器流程通过。

#### C3 远程 PvE handoff

- `contracts/transport.ts`：新增 `command.submit`；`match.snapshot` 返回 `{ ruleset, opening, commands, revision, activeDevice }`。
- `MatchClient` 增加 `submitCommand`；`MatchSession` 增加命令流会话（或新建 `SequentialMatchSession`）。
- `RemoteMatchClient` 的 `ruleset !== "mecha-v1.4"` 校验改成 v1.5；`RemoteMatchSynchronizer` 按命令列表重放。
- `mecha/mode.ts`：删除 `remote_requires_v14`，远程 idle→非 idle 时路由到 `sequential`；保留“单活动设备”锁定。
- 原生网关：`PVE` 常量改 v1.5，按命令流投影；删除 PVP 相关结构。
- 验收：桌面开链接 → 手机中途接手 → 停止远程回桌面；重复命令/陈旧 revision 被拒。

### D. 删 v1.4（2–3 天）

1. **拆 `rules.ts`**：保留 `createMatch` / `spawnsAreOpenGround` / `collectTelegraphs`，删除 `playTurn` / `previewPlan` / `runTurn`（等 controller 和测试都改完）。
2. 删 `controller.ts`（`cuesFromLog` 已迁走）、`ai.ts`、`planning.ts`、草稿评估 UI（`MechaCandidateConsequences`、`MechaPlanEvaluation`）、`MechaBoard` 的经典分支。
3. `board.ts` 去掉 `GDD_RULESET` / `PveRuleset` 的 v1.4；`matchFromSite` 只接受 v1.5；清掉 `rules/pve.ts` 适配器。
4. 删 v1.4 的测试/脚本；更新 `verify-mecha-*.ts` 与浏览器脚本。
5. 最终验收见 §3。

## 3. 验收

| 阶段 | 命令/检查 | 通过标准 |
| --- | --- | --- |
| A | `typecheck`、`verify:mecha`、v15 浏览器 | 全绿，tag 已打 |
| B | `grep -rn "pvp\|mecha-local-replay" src` | 只命中 docs/历史注释 |
| B | v1.5 存/读/删 + 31/33/40KB 边界 | 原生与 IndexedDB 一致 |
| C1 | 怪物 catalog 测试 + v1.5 练习流程 | 全部 practice 物种可跑 |
| C2 | AI 命令序列复现 + 自动对战 | 浏览器流程通过 |
| C3 | 手机 handoff 真机、重复/陈旧命令 | 拒绝且不丢状态 |
| D | `grep -rn "mecha-v1.4" src` | 无运行时分支 |
| D | `typecheck`、`verify:mecha`、全部浏览器流程 | 全绿 |

## 4. 风险

| 风险 | 缓解 |
| --- | --- |
| 先删 `replayRepository` 导致 v1.5 存档断 | 先抽 `replayBackend.ts`，再删 |
| 先删 `controller` 导致 `cuesFromLog` 缺失 | 先抽共享 helper |
| `rules.ts` 整文件删掉 `createMatch` | 明确拆分，不整删 |
| 远程 handoff 是用户在用 | 先在分支做，真机验证后再合 |
| AI 复用 `ArenaPlan` 评估导致语义错 | 只复用评分因子，模拟必须走 `trial()` |
| 存档序列化上限 | 对照专用 SQLite 路径与前端限制，加边界测试 |

## 5. 给 Codex 的提示

```text
按 docs/MECHA_V14_RETIREMENT_EXECUTION_2026_11_07.md 执行。

先做 A：把当前工作树拆成 3 个 commit，跑 typecheck + verify:mecha + v15 浏览器，打 checkpoint tag，然后停下汇报。

之后按 B → C1 → C2 → C3 → D，一次一个阶段，每阶段结束停下汇报：改了什么、验证命令与原始输出、没做什么、下一步。
不要跨阶段；不要先删 replayRepository 或 controller；不要在 C3 之前把远程切到 v1.5。
```
