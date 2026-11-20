# ADR-01 Spike：checkpoint-race 字面量 → ConditionV2/GameEffectV2 最小子集（headless 对照）

- 日期：2026-11-20
- 状态：spike 完成，待评审（ADR-01 裁决输入，RFC §10-1 / §8 [r1]）
- worktree：`feature/city-sdk-v3`
- 语义权威：`packages/agent-vitals-city-sdk/src/runtime.ts`（对照真 import，未复制语义）
- 样本：`assets/creator/templates/checkpoint-race.json`（下称 [checkpoint-race]）

## 1. 交付物与验证

| 文件 | 内容 |
|---|---|
| `packages/city-game-sdk/src/protocol/ruleAstV2.ts` | `ConditionV2` / `GameEffectV2` / `RuleV2` 类型草案 + 两个纯函数：`fromLegacyRuleGraphV1(graph)`（映射，未知 op 产出诊断不抛异常）与 `evaluateRuleAstV2(rules, steps, context)`（镜像 runtime.ts 同一子集的 headless 评估器）。全部 readonly、产出 deep-frozen。**提案态：未进任何 index 桶导出** |
| `packages/city-game-sdk/tests/rule-ast-v2.test.ts` | 13 个测试：映射深等手写 AST、冻结断言、3 条轨迹对照（全过 / 超时 / 乱序门）、createRun 事件级 emitted 对照、hud.hint 保留上限对照、不识别 op 诊断（V3-12）、白名单外节点 fail-closed |

验证结果（本 worktree 实测）：

- `cd packages/city-game-sdk && npm test`：**76/76 全绿**（63 个既有测试无回归 + 13 个新测试）。
- `npm run typecheck`（tsc -p tsconfig.build.json）：src 含新文件零错误。
- 对照方式：测试直接 `import { compileRules, createRun, runHeadless } from "../../agent-vitals-city-sdk/src/runtime"`（经 `scripts/mecha-ts-hook.mjs` 解析 runtime.ts 源文件），同一轨迹喂给 `runHeadless`/`createRun` 与 `evaluateRuleAstV2`，逐项比较 `outcome` / `counters` / `tick` / `hints` / `emitted`。

## 2. 映射表（每个 V2 节点的来源字面量）

checkpoint-race 规则图 4 个节点，全部落在最小子集内：

| Legacy 字面量 | V2 表达 | 说明 |
|---|---|---|
| `on:{type:"run.started"}` | `on:["run.started"]`，`when: all([])` | 空 guard 数组 → 空真 `all([])`（镜像 `guards.every` 对空数组的语义） |
| `on:{type:"zone.entered",slot:"points"}` | `on:["zone.entered"]` + `when: all([eq(event.slot, "points"), …])` | 订阅路由键降级为守卫条件（缺口 G-1） |
| `on:{type:"timer.expired",timerId:"timeout"}` | `on:["timer.expired"]` + `eq(event.timerId, "timeout")` | 同上（缺口 G-1） |
| `when:[{op:"counter.eqEventIndex",counter:"next"}]` | `counter.eqEventIndex("next")` | 在 run.started/timer.expired 上为 false（runtime 语义，缺口 G-8） |
| `when:[{op:"counter.eq",counter:"next",value:{parameter:"gateTarget"}}]` | `counter.eq("next", {parameter:"gateTarget"})` | 解析序 overrides → pack default，未解析 → false（缺口 G-6） |
| `actions:[{op:"counter.add",counter:"next",amount:1}]` | `effects:[{op:"inc",counter:"next",amount:1}]` | 预算：`counters[c].max`（字面量或参数引用），越界回滚整个 step |
| `actions:[{op:"timer.start",timerId:"timeout",durationTicks:{parameter:"timeLimitTicks"}}]` | `effects:[{op:"timer.start",…}]` | 派生语义（due=tick+duration、timerId 字典序触发、先删后派发）在评估器内镜像 |
| `actions:[{op:"run.finish",outcome:"success"/"failure"}]` | `effects:[{op:"run.finish",…}]` | 终止后同 step 其余输入与后续规则全部跳过 |
| `actions:[{op:"hud.hint",text}]`（legacy op 集，模板未用） | `effects:[{op:"hud.hint",text}]` | 截断 160 / 保留 32（缺口 G-4） |
| `counters:{next:{initial:0,max:{parameter:"gateTarget"}}}` | **不在 RuleV2 内**，经 `RuleEvalContextV2.counters` 传入 | 图级状态声明（缺口 G-2） |

`eq/gte/all/any/not`、`at-place`、`has-item`、`set`、`emit` 在两个模板中**均无字面量来源**：前者是 RFC §3.3 点名的组合/比较子集，后两者是 City Guard / Game→City 的候选面，全部标注为「未认证」。

## 3. Guard/Effect 分界建议（ADR-01 裁决核心）

**一句话版：Condition 是共享谓词层——组合器（all/any/not）与值比较（eq/gte/counter.*）由 Game/Story 复用、语义归 City SDK 统一定义；`at-place`/`has-item` 属 City Guard（依赖 City 侧 actor/库存事实，Game 模板零需求）；Effect 全部属 Game SDK（inc/timer.start/run.finish/hud.hint 的语义权威就是 runtime.ts），唯一值得为跨界单独立项的是 `emit`（Game→City WorldEvent，需独立授权与 ADR），`set` 在状态寻址定案前不应进任何共享面。**

展开：

- **进 City SDK 共享 Guard 子集**：`all/any/not`、`eq`、`gte`、`counter.eq`、`counter.eqEventIndex`。它们是纯谓词，操作「已提交的 State/Event 事实」，无副作用、无调度、无 UI，满足 RFC §3.3「有限 AST」约束；Game Rule 与 City Interaction Guard（乃至 StoryEdgeV2.preconditions，§4.2）可以共用同一求值器。
- **只属 City Guard（不进 Game RuleV2 认证集）**：`at-place`、`has-item`。它们需要 City 侧的 actor 位置与库存状态源，Game run 的 counters/hints 状态模型里根本没有这些事实——spike 评估器对它们 fail-closed（诊断 `v2_ast_unsupported_node`，不产出 verdict），避免用猜测语义伪造结果。
- **只属 Game SDK（Effect 全集）**：`inc`、`timer.start`、`run.finish`、`hud.hint`（+ 未来 `schedule`/`grant-item`）。它们改写 run 内状态、产生调度与呈现，City 世界不需要也不应该执行它们。
- **待裁界的灰区**：`emit`（Game→City 事件出口，建议单独 ADR + 授权门）与 `set`（需先定状态寻址/权限，否则 `target` 字符串就是任意写入口）。

## 4. 语义缺口清单（映射中发现，建议进入 ADR-01 裁决正文）

- **G-1 订阅路由键无处安放**：legacy `on.slot` / `on.timerId` 在 RFC §3.3 的 `on: readonly string[]` 里没有表达位。spike 把它们降级为 `when` 内 `eq(event.slot, …)` / `eq(event.timerId, …)` 条件——行为对照完全一致，但语义等级变了：从「订阅过滤器」变成「守卫谓词」。若未来引入「按订阅去重的调度/预算」或事件信封层绑定，这个降级会变成坑。建议：要么允许 `on` 携带受控的 slot/timerId 限定，要么明确路由归属事件信封。
- **G-2 状态表缺位**：`counters`（initial/max，max 可为参数引用）是图级声明，不是任何单条 RuleV2 的属性。RuleSetV2 需要一个显式的状态声明层（counters/timers 初始与预算），否则 `inc` 的预算与 `counter.eq` 的参数解析没有归属。spike 用 `RuleEvalContextV2` 临时承载。
- **G-3 per-node version 无来源**：legacy 图没有节点版本；spike 合成 `"1"`。版本身份应落在 rule / ruleset / package digest 哪一层，需裁决。
- **G-4 hud.hint 双重约束不一致**：编译期 `validateMiniGamePack` 直接拒绝 >160 字符文本（"HUD hint must be text no longer than 160 characters"），runtime 的 `slice(0,160)` 只是对 legacy 数据的纵深防御。V2 若保留编译期约束即可删 slice；两者只能留一个口径。
- **G-5 未知 op 的 else 陷阱**：runtime.ts dispatch 的 `else` 分支把任何未知 action 当 `run.finish(undefined)` 终止——仅靠 compileRules 前置拒绝兜底。spike 评估器改为显式 fail-closed。LegacyRuleAdapter 迁移时必须保留这个区别，否则 V1 数据的未知 op 会静默假终止。
- **G-6 参数解析的静默 false**：`counter.eq`/`timer.start` 的参数引用按 overrides → pack default 解析，两层都缺时 guard 为 false（不是错误）。一个 default 的差异会静默改变 verdict——这条「解析失败=条件不满足」必须写进 V2 契约。关联已知缺口：mount parameterOverrides 未对照 integerParameters min/max（§1.1-5，PR-2 修复项；本 spike 的 `timeLimitTicks:2400` override 即走此路径）。
- **G-7 mount 绑定校验不在 AST 内**：`rule_input_invalid` / `rule_input_out_of_range` 依赖 mount.bindings 的 slot 绑定长度，属宿主校验层。spike 评估器未镜像；PR-3 的宿主侧裁决必须保留这层。
- **G-8 静默 false 的 eqEventIndex**：`counter.eqEventIndex` 在 run.started/timer.expired 上为 false（非错误）。行为正确但反直觉，进契约注释即可。
- **G-9 事件词汇未命名空间化**：spike 保留 `run.started`/`zone.entered`/`item.collected`/`timer.expired` 原名以保证对照事件对象逐字相同；V3 命名空间化（如 `city.world.zone.entered`）应是一次不改语义的重命名，单独做。

## 5. 结论：最小子集是否覆盖两类纵向切片

**覆盖，且是平凡覆盖。** `flight-checkpoint.json` 与 `checkpoint-race.json` 的 `rules` 图**逐字相同**（仅 slot 名 `gates` ↔ `points`），四个节点、两条 guard、三种 effect 完全一致。因此 checkpoint-race 的映射表对飞行切片按结构成立：`fromLegacyRuleGraphV1` + `evaluateRuleAstV2` 与 runtime.ts 在两条切片上产出一致的 outcome/counters/tick。

对 ADR-01 的建议结论：

1. **可以冻结的最小子集**（PR-2/PR-3 输入）：Condition = `all/any/not + eq/gte + counter.eq/counter.eqEventIndex`（City Guard 额外认领 `at-place/has-item`，但语义源在 City 侧）；Effect = `inc/timer.start/run.finish/hud.hint`（runtime.ts 已认证）+ 白名单暂留 `set/emit`（不认证、不进 verdict）。
2. **不要现在冻结的**：`set`/`emit` 的语义、状态声明层（G-2）、订阅路由（G-1）、版本归属（G-3）——这些缺样本支撑，按「样本先行」原则等恋爱/侦探切片或第一个真实 City Guard 用例再定。
3. **PR-3 宿主侧裁决（S-6）的最小对照基线已经存在**：`evaluateRuleAstV2` 与 runtime.ts 在 3 条轨迹（全过 / 2400-tick 超时 / 乱序门）上的逐项相等，可以作为 host-verified 复算（V3-16）的第一组回归 fixture。

复现方式：

```bash
cd packages/city-game-sdk
npm test          # 76/76（含 tests/rule-ast-v2.test.ts 的 13 个对照测试）
npm run typecheck # 零错误
```
