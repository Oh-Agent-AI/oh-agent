# v1.4 → v1.5 统一计划：把剩余能力迁到 command stream

状态：建议稿，未实施。
日期：2026-11-07
目标：让 v1.5 成为唯一可玩引擎；旧录像直接删除，v1.4 不保留兼容层。
关联：`MECHA_ITB_ALIGNMENT_ARCH_2026_11_07.md`、`MECHA_ITB_ALIGNMENT_HANDOFF_2026_11_07.md`、`CITY_ACTIVITY_PLATFORM_ARCH_2026_11_07.md`。

## 0. 结论

“剩下的”不是一个东西，分三类，做法完全不同：

| 类别 | 内容 | 做法 |
| --- | --- | --- |
| **可迁** | AI/打法/自动对战、状态怪之外的怪物内容 | 在 v1.5 执行器上重写适配层，逐个迁 |
| **要重设计** | 远程 PvE（跨设备续玩） | 保留 handoff；快照从“整局状态”改成“opening + 命令列表” |
| **直接删** | 旧录像（v1/v2/v3）、v1.4 独占存档路径、PvP | 只保留 v1.5 的 `plugin.state` 路径；PvP 整段移除 |

还有一类**不建议迁**：草稿评估、候选后果、落空预测。它们是为“整包计划”设计的工具，v1.5 的即时结算用“命令预览”替代更自然，硬搬会做出两套半成品。

## 1. 剩余能力清单

| 能力 | v1.4 现状 | v1.5 目标 | 迁法 | 难度 |
| --- | --- | --- | --- | --- |
| 存档路径 | v1.4 bespoke 回放库 + v1.5 `plugin.state` 两条 | 只留 v1.5 `plugin.state` | 删 v1.4 命令/校验/客户端；对齐 32KB 与 40KB 上限 | 低 |
| 怪物内容 | 注册表 ruleset 固定 v1.4；练习模式只走 v1.4 | 除 4 种状态怪外的物种也能在 v1.5 跑 | 解除 `SequentialController` 的物种白名单，逐物种过 `end` 阶段 | 中 |
| AI / 打法 / 自动对战 | `ai.ts` 只被 `controller.ts` 引用 | `CommandPolicy` 产命令序列，`trial()` 评估 | 用 v1.5 语义重写评估，不能直接套 `ArenaPlan` 评分 | 中 |
| 远程 PvE | 手机链接 + 快照/计划提交；桌面锁定 | 同样的 handoff，快照 = opening + commands | 换协议字段，不换 UX | 中 |

## 2. 各工作流

### 2.1 存档：只保留 v1.5 路径（先做）

- v1.5 已经走通用插件状态：`plugin.state.read/write`，key `mecha-replays:v1`，format `sequential-checkpoint-v1`，浏览器回退 IndexedDB（`sequentialCheckpoint.ts`）。
- v1.4 的 bespoke 路径（`plugin_state.rs` 的 `mecha-local-replay-entry:v1` 校验 + 独立回放库命令）整段删除，不保留分支、不写新 schema。
- **先对齐容量**：原生 `plugin.state` 单文档上限 32KB（`MAX_DOCUMENT_BYTES`），而 v1.5 bundle 自身上限 40KB、raw 上限 41KB（`sequentialReplayBundle.ts` / `sequentialCheckpoint.ts`）。要么把原生上限提到 ≥48KB，要么把 bundle 压到 32KB 以下；否则 32–40KB 的检查点会“能生成、存不进原生”。必须加边界测试。
- 旧 key 下的 v1.4 条目：升级时忽略/清理，不能因解析失败阻塞。

### 2.2 怪物内容

- 现状：`SequentialController` 只在“状态遭遇”分支放行 4 种物种（`spore_leaper / flux_lancer / prism_warden / gravity_core`）；其他物种在 v1.5 里没有创建入口，练习 UI 也只接 v1.4。
- 迁法：把 `matchFromSite` 的 `monsterContent` 入口接进 v1.5，并让每个物种的 `declare/project/resolve`（已在共享模块里）走 `resolveEnemyPhase` 的 actor 轨迹。
- 验收：同一物种在 v1.5 下的预告、命中、伤害与技能规格一致；与 v1.4 的差异只允许是已声明的 ruleset 差异（建筑碰撞、逐条结算），**不要**要求两版 `TurnEvent` 序列相同。

### 2.3 AI / 自动对战

- 新接口 `CommandPolicy`：

```ts
type CommandPolicy = {
  next(view: SequentialControllerView): SequentialCommand | null; // null = end
  evaluate(view: SequentialControllerView, plan: SequentialCommand[]): number;
};
```

- 评估必须用 `SequentialTurn.trial()` 在 **v1.5 语义**下跑，不能把 `ArenaPlan` 直接喂给 v1.5；v1.4 的“整包同时结算”和 v1.5 的“逐条即时”会给出不同结果。
- 可复用 `ai/score.ts` 的评分因子（boss/raider/mech/building/position/outcome），但输入换成 v1.5 模拟后的 `MatchState`。
- 自动对战：把策略产出的命令按节奏 `execute`，演出复用现有 `presentationStages`。

### 2.4 远程 PvE：跨设备续玩（handoff）

用途不是联机对战，是“桌面没打完，手机接着打”。现有实现已经支持：桌面开启远程 → 生成手机链接 → 手机继续 → 桌面锁定；停止远程后恢复本地（`RemoteMechaControls`）。

迁到 v1.5 时**保持这套 UX**，只换传输内容：

- `match.snapshot` 返回 `{ ruleset: "mecha-v1.5", opening, commands[], revision, activeDevice }`；手机用 `SequentialTurn.replay(opening, commands)` 重建当前局面，不需要整局快照。
- `command.submit` 追加命令；服务端校验 `baseRevision` / `commandId` 幂等；桌面按同一命令列表重放。
- **同一时刻只有一个活动设备**：开启远程 = 桌面让出写权限（现有锁定逻辑保留）；“停止远程并恢复本地” = 拉回命令列表、replay、桌面重新持有。
- 部署和中途都能交接：opening 带 placements，中途命令在 commands 里，不再要求“从未部署开始”。
- 协议仍是 `mecha-net:v2`，但 `mode` 固定 `pve`；没有第二玩家、没有 guest、没有批准。

### 2.5 PvP：直接删除

没有用户，不迁、不保留。

删除范围：

- 规则/会话：`rules/pvp.ts`、`session/MatchSession.ts` 的 pvp 模式、`contracts/match.ts` 的 PvP 类型、`contracts/transport.ts` 的 `mode: "pvp"`。
- 远程表现：`presentation/BattleScenePort.ts`、`presentation/RemoteBattleScene.ts` 的 `PvpState` 分支；`RemoteMatchSynchronizer` 的 pvp 检查；`RemoteMechaControls` 里的“邀请好友/批准/拒绝”整块（保留开启、链接、停止三件）。
- 原生：`remote_gateway_projection.rs` 的 `PVP = "mecha-pvp:v1"` 与相关结构、测试。
- 用例：`pvp-rule-target-binding`、`pvp-session`、`remote-state-coordination` 等 PvP 专用测试。

结果：远程只剩 PvE，协议里的 `mode` 固定 `pve`；`RemoteArenaV1` 若只服务 PvP 可一并删除（先确认 PvE 是否复用）。

## 3. 关键设计决策

1. **协议版本化**：远程升级用 v2，不在 v1 上做兼容分支。
2. **服务端重算**：命令流是确定性的，服务端重放是唯一可信来源；客户端只上传命令。
3. **AI 用 v1.5 语义评估**：任何复用 `ArenaPlan` 评估器的捷径都会在“行动落空/连锁位移”上出错。
4. **Rust 严格校验**：v1.5 信封也要逐字段校验，不能因为“新格式”放宽。
5. **旧录像直接删**：产品已确认放弃旧档；不要为了“兼容”保留 v1.4 规则读取器，否则 v1.4 永远退不掉。

## 4. 阶段与验收

| 阶段 | 内容 | 验收 | 粗估 |
| --- | --- | --- | --- |
| S0 | 删 v1.4 存档路径，v1.5 `plugin.state` 唯一 | 旧条目忽略；32–40KB 边界有测试；原生与 IndexedDB 行为一致 | 1–2 天 |
| S1 | 怪物内容迁 v1.5 | 每物种在 v1.5 下按规格预告/命中/伤害；与 v1.4 只对照已声明的 ruleset 差异 | 3–5 天 |
| S2 | AI / 自动对战 | 同一局面下 AI 命令序列可复现；评分与 v1.4 对照 | 3–5 天 |
| S3 | 远程 PvE 换 v1.5 | 断线重连、重复命令、陈旧 revision 全部拒绝；旧协议明确拒绝 | 1 周 |
| S4 | 删 PvP | 代码无 PvP 引用；远程 PvE 回归通过 | 2–3 天 |
| S5 | 删 v1.4 入口/控制器/旧录像栈 | v1.4 代码与旧档读取器全部移除；无回归 | 3–5 天 |

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| v1.4/v1.5 结算语义漂移 | 同一 ruleset 的 golden 固定；跨版本只对照“已声明的规则差异”，不追求事件序列相同 |
| 删 PvP 牵动远程表现层 | 顺序：规则/会话 → `PvpState` 分支 → Rust 常量/测试；保留 handoff 三件套 |
| 两端同时操作导致命令分叉 | 单活动设备租约 + revision 拒绝 + 停止远程时强制 replay |
| 远程服务端与客户端规则版本不一致 | 协议里带 ruleset + 规则版本哈希，服务端拒绝不匹配 |
| 删除旧录像引发用户数据投诉 | 升级说明写清楚；可选提供“导出旧档”窗口期，但不保证可播 |
| AI 在 v1.5 下质量下降 | 评分因子复用，但阈值/权重按 v1.5 重新校准 |
| 原生 32KB 上限 < v1.5 bundle 40KB | 统一上限或压缩 bundle；加边界测试，别让存档“偶尔失败” |

## 6. 不迁移清单

- 草稿评估、候选后果、落空预测：v1.5 用命令预览替代。
- PvP：整段删除（`rules/pvp.ts`、`PvpState`、`PVP` 常量、相关测试），不迁。
- `MatchRuleAdapter` 的整包提交语义：远程 v2 用 `command.submit`，不再扩展 plan 协议。
- `mecha-local-replay:v1/v2/v3` 的读写路径：整栈删除；v1.4 原生回放库命令一并删除。现行已保存回放走 descriptor 授权的通用 object/scope；checkpoint 走通用 `plugin.state`（key `mecha-checkpoint:v1`）。旧 `mecha-replays:v1` 仅用于 SQLite 旧归档和旧 checkpoint 的只读 copy-forward，迁移后应移除该兼容读取键。

## 7. 完成标准

- v1.5 支持：本地 PvE、状态挑战、全部怪物、AI/自动对战、远程 PvE（手机续玩）；**无 PvP**。
- 存档只有通用端口路径：saved replay 使用 object/scope，checkpoint 使用 `plugin.state`（key `mecha-checkpoint:v1`）；旧 SQLite 只读迁移后删除 `mecha-replays:v1` 路由。
- v1.4 代码（入口、控制器、AI、旧录像读取器、远程适配）全部移除；`mecha-v1.4` 字符串只作为历史数据标记存在。
- 没有任何“v1.5 因缺功能而回退到 v1.4”的入口。
