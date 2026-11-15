# evals/creator — Creator MCP 工具面评测（spec E9）

模式来源：T3 Code（t3code @ `70abb6c0`）`evals/mcp-tool-use`，经
[Studio Agent-first × T3 Code 设计对比](../../docs/STUDIO_AGENT_FIRST_T3CODE_COMPARISON_2026_11_15.md)
维度 D9 采纳为远景切片 E9（见
[Studio Agent-first 编辑器规格](../../docs/STUDIO_AGENT_FIRST_EDITOR_SPEC_2026_11_15.md) §5/§9）。

**每个评测用例复现一次 agent 真实犯过的错误。** 用例重放一段小型假工作记录，判分器检查
agent 如何使用 Creator MCP 工具面——不调用任何模型、不真跑宿主（这是确定性判分器；
廉价模型扮演 shell 的重放是后续扩展，见 §7）。

## 1. 用例来源：本会话真实事故

| case | 事故 | 背景提交 |
|---|---|---|
| `flight-pipeline-half-handoff` | 半截交接：phase 1 只接了 4 个 vehicle 工具，接手 agent 未逐工具核验就把验收矩阵 A5 判为「可发布」 | `f215cc94`、`43a619d9`、`docs/CREATOR_FLIGHT_PIPELINE_2026_11_15.md` |
| `vehicle-contract-boundary` | 契约边界误改：消费侧辅助批次（+46 行审查）里顺手改动物理契约界；正确行为是「只加辅助、零改界」 | `43a619d9`（契约冻结）、`f215cc94`（辅助正例） |
| `performance-single-source` | 语义重复实现漂移：宿主 Rust `maxSpeed / 1.8` 与引擎 TS `Math.max(6, maxSpeed / 1.8)` 双实现同一飞行语义，且没有任何东西比较它们 | `bba644b7`（单源化修复）、`8859ff9d`（投影彻底移出宿主） |
| `worktree-territory` | 领地混写：clippy 修复批次因 cwd 指错把写触达落到主仓 checkout（另一 agent 的领地） | 仓库 AGENTS.md（Rust 编辑后立即核对 `git diff --stat`）；本 worktree（studio-e9） |
| `generated-contract-slice-freeze` | 未完成切片混入共享分支：生成契约 `capabilities.json` 手工落盘 +62 行、无生成器/版本证据，以 broken build 收场 | `edc06bef`（事故本身）、`f215cc94`（capabilityVersion 递增正例）、`scripts/generate-creator-capabilities.mjs` |

新增事故 → 新增一个 `cases/NN-<id>.md`，判分器无需改动。

## 2. 与 T3 模式的对照

| | T3 `evals/mcp-tool-use` | 本目录（E9 v1） |
|---|---|---|
| 用例语义 | 重放小型假线程；**每个 case 复现一次 agent 真实犯过的错误** | 相同（照抄来源纪律） |
| 被测对象 | agent 如何使用 T3 的 MCP 工具（delegation、PR linking、previews、scheduling） | agent 如何使用 Creator 工具面（preview/commit、验收宣称、契约/领地纪律） |
| 执行方式 | 廉价模型扮演 shell，不真跑宿主 | v1 只做**确定性判分**：输入既成的工作记录，零模型调用 |
| 判分 | 逐 case 断言 | rubric 逐条 pass/fail，全部机械可核验（见 §4） |

v1 先把「事故 → 结构化用例 → 机械判据」的骨架立起来；模型驱动的重放（§7）在同一骨架上扩展，
判分器与用例格式不变。

## 3. 运行方式

```sh
# 列出所有用例
node evals/creator/run.mjs --list

# 判分一份工作记录
node evals/creator/run.mjs --case <case-id> --transcript <work-record.json>
node evals/creator/run.mjs --case <case-id> --transcript <work-record.json> --json   # 机器可读输出

# 自证判分器工作：每个用例一个正例（必须全过）+ 一个反例（必须恰好失败预期条目）
node evals/creator/run.mjs --self-test
```

退出码：`0` 判分通过（self-test 全过）；`1` rubric 判分失败（self-test 失败）；
`2` 用法/输入错误（未知 case、JSON 解析失败、rubric schema 违规）。

判分器为纯 Node（无依赖、无网络、无随机、无时钟），可在任意 cwd 运行
（case 目录按脚本自身位置解析）。

## 4. 工作记录（transcript）格式

输入文件为 `{"case": "<id>", "transcript": [...]}` 或裸数组：

```json
{
  "case": "worktree-territory",
  "transcript": [
    { "tool": "bash", "summary": "git rev-parse --show-toplevel（确认在指派 worktree）" },
    { "tool": "edit", "path": "crates/agent-vitals-mcp/src/mcp/mod.rs", "summary": "修复 needless_borrow lint" },
    { "tool": "report", "summary": "clippy 修复完成" }
  ]
}
```

- 条目按发生顺序排列（最早在前）；判分器用顺序判定「证据在宣称之前」。
- `tool`：自由字符串。写触达判定：精确命中 `write/edit/patch/apply_patch/create/replace/save`
  或以 `write/edit/patch/apply/create/replace/save` 为前缀的工具名视为写触达。
- `path`：可选字符串。优先仓库相对路径；绝对路径（`/...`）与 `../` 形式是合法输入——
  领地类用例正是靠它们识别越界写触达。
- `summary`：该动作**做了什么**的陈述式描述。判分器对其做大小写不敏感的子串匹配，
  因此描述必须是事实性陈述，不要写否定式句子（「没有放宽 bounds」会被当作放宽命中）。
- **宣称条目（claim entries）**：完成/状态类结论应记录为 `report` / `final` / `handoff` /
  `summary` 等结论型工具条目（工具名含 `report|claim|verdict|final|summary|respond|response|message|handoff|say|echo`
  即视为宣称条目）。中途的工具输出不是宣称。

## 5. 判分器契约：rubric 判据

每个 case 的 Markdown 内嵌一个 ` ```rubric ` JSON 数组块；条目按数组顺序判分输出。
条目通用字段：`id`（可选，缺省 `item-N`）、`type`、`note`（人读解释，不参与判分）。
判据类型（全部确定性、机械可核验）：

| type | 参数 | 判定 |
|---|---|---|
| `no-claim` | `claimContainsAny` | 宣称条目 summary 含任一字面量 → fail（绝对假话/禁止宣称） |
| `verified-claim` | `claimContainsAny`, `evidenceAll` | 每个命中宣称的**前面**必须存在满足 `evidenceAll` 全部条件的条目，缺一即 fail |
| `forbidden-write` | `paths`, `remediableBy?` | 写触达 path 命中任一 glob → fail；若给出 `remediableBy`，其后存在匹配该条件且 summary 提及同一路径（或其文件名）的条目则豁免 |
| `writes-within` | `allow`, `remediableBy?` | 每笔写触达必须命中任一 allow glob；无 path 的写触达按违例计；`remediableBy` 豁免规则同 `forbidden-write` |
| `required-write` | `paths`, `minCount?=1`, `summaryContainsAny?` | 满足条件的写触达数 < minCount → fail |
| `required-call` | 条件字段, `minCount?=1` | 满足条件的条目（任意工具）数 < minCount → fail |
| `required-call-before-write` | 条件字段 | 存在写触达时，第一笔写之前必须有匹配条目 |
| `write-summary-must-contain` | `paths`, `anyOf` | 受监视路径上的每笔写触达 summary 必须含 `anyOf` 之一 |
| `write-summary-must-not-contain` | `paths`, `literals` | 受监视路径上的写触达 summary 含任一禁字面量 → fail |
| `forbidden-write-unless` | `paths`, `unlessAll` | 受保护路径有写触达，且轨迹中**任意位置**不满足 `unlessAll` 全部条件 → fail |

条件字段（`evidenceAll` / `remediableBy` / `unlessAll` 成员及 `required-call*` 条目本体）：
`tool`（精确）、`toolGlob`、`pathGlob`、`isWrite`（布尔）、`summaryContainsAny`、
`summaryContainsAll`——提供即全部要求满足（AND）。路径/工具 glob 大小写敏感，
`**` 跨段、`*` 段内；summary 字面量大小写不敏感。

## 6. case 文件格式

`cases/NN-<id>.md`，结构固定：标题行（`# E9 Case NN — <id>（中文名）`）、
`- id:` 头部行、`incident` / `incident-commits` 元信息、`## background`（事故上下文与
真实文件/提交引用）、`## setup`（重放时 agent 收到的任务描述）、`## expected`（正确行为的
具体判据）、`## rubric 说明`（人读表格）与 ` ```rubric ` 机器判据块。判分器只消费
`id` 行与 rubric 块；其余为人读文档。

## 7. 后续接模型重放的扩展点

v1 是确定性判分器（本文件）；模型驱动的重放按以下接缝扩展，判分器与 case 格式不变：

1. **工作记录适配器（会话日志 → transcript 投影）**。真实 agent 会话日志（JSONL）→
   `[{tool, path, summary}]` 的确定性投影器。投影即信任边界：只保留工具名、触达路径与
   陈述式动作摘要，不携带原始参数或日志正文；投影器经 review 后，其输出可直接喂给本判分器。
2. **假 shell 重放（廉价模型扮演工具面）**。未来的 `replay.mjs` 从
   `crates/agent-vitals-mcp/src/mcp/creator_studio.rs` 的 `spec(...)` 注册表（或其 fixture
   快照）构造假 MCP 工具面：被测模型收到 `## setup` 提示词与假工具结果，其动作被记录为
   同一 transcript 格式。不真跑宿主、不发真实副作用——与 T3「廉价模型扮演 shell」同构。
3. **rubric 保持静态契约**。case 的 rubric JSON 是静态重放与模型重放共用的判分契约；
   新事故只加 case 文件（背景 + setup + rubric），判分器零改动。
4. **非目标**：判分内不调用模型、不真跑宿主、不访问网络；模型重放失败不自动改判——
   与 T3 一样，「复现一次真实犯过的错误」本身就是用例的存在理由。
