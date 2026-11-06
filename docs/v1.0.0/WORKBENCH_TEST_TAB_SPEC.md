# 工作台「测试」tab 规格：模型降智/中转注水的主动取证

**状态：** Draft v1（2026-09-19）。V17 五表已落库（authority schema v17，SQL 权威库
spec §3.9）；runner 与 UI 属本规格驱动的后续迭代。
**目标版本：** v1.0.0-beta.3 起，P1 见 §11 分期。
**关联文档：** [V16/V17 schema 规格](SCHEMA_V16_V17_ENRICHMENT_PROBE_SPEC.md)（数据层权威，
本规格的 §6/§7 派生自其 §4 表定义与 2026-09-19 政策节）· [数据留存与出口政策](../../AGENTS.md)（2026-09-19 节：
凭据/金丝雀红线、出口收口）· [发现 tab 规格](WORKBENCH_FINDINGS_TAB_SPEC.md)（探针结论
回流其②对比面）· [问题分类图谱](../AGENT_EXECUTION_PROBLEM_TAXONOMY.md) §5（模型降级
fallback / 请求被改写两类已登记）· [路由归因 spec](../PROVIDER_ROUTE_ATTRIBUTION_SPEC.md)
（判定层的证据纪律前身）。

---

## 0. 一句话结论

**2026-09-20 转向（v1.1）**：实机验证证明主动探针的路线隔离在 cc-switch 型机器上
**不成立**——`~/.claude/settings.json` 的 `env` 块由 claude CLI 启动时自注入，优先级
高于我们注入的进程 env（实测：注入无效主机名仍请求胜算云并 402）；能压住它的
`--settings` 显式键又要求凭据离开「仅经子进程 env 传递」的红线。**默认面改为被动
路线质量分析**（`routes-quality`：`usage_facts.model_id` 的实际模型族分布——协议
响应原样，anthropic 官方不可能返回 deepseek/glm，是硬证据），主动 L0 探针降级为
「高级」折叠区。用户语言也从「路线 A/B」改为「执行环境 × 路线 × 实际模型」：用户关心
"我用 claude-code 跑的请求，实际拿到的是什么模型、失败了多少"。词表与判定在
`domain::route_quality`（Rust/Python 对拍 `fixtures/route_quality/vectors.json`）；
`<synthetic>`（claude 请求失败的本地占位）单列 API 错误、不计任何模型族用量，
也不得当作 resolved 身份判 mismatch（2026-09-20 误报修复）。原 §1-§12 的主动
取证设计继续约束折叠区内的探针面。

---

「测试」tab 是仓库第一块**主动取证**能力：用成对对照实验（官方直连 vs 中转路线）+
证据分级判定，回答"我的模型被降智了吗 / 中转商注水了吗"。两条总纪律：**没有硬证据
不出「确认」级结论、功效不足如实说**（判定三级见 §4，与 `metered_estimate` 不当账单
同一条血统）；**每一次测试都花真金白银**——跑前估价、预算熔断、配额感知是首屏的第一
公民，不是附加项。

## 1. 定位与判据

1. 补图谱 §5 的最后缺口：被动日志永远不会告诉你"被换了模型"（中转不会承认）；
   「模型降级 fallback / 请求被改写」两类的信号源就是本 tab 的 probe 面。
2. 官方路线不预设无辜：Anthropic 2026-04 复盘证明官方也曾静默调低 effort、清空
   thinking——对照是双向的（A/B 都可能是异常方）。
3. 判据（可验收）：
   - 判定输出永远带证据等级与「什么证据会改变结论」；
   - `underpowered` 是一等判定，不是失败态；
   - 凭据不落库不落盘（内存直传子进程 env）、金丝雀题面不进任何 agent 可读面；
   - probe 会话（探针自身的执行环境会话）在成本/用量视图默认排除、可显式筛入；
   - 探针流量不污染既有 golden/对拍面（runner 是新面，不改任何既有输出）。

## 2. 现状与前置

- **已落库**：V17 五表（schema v17）——路线档案/题库引用/job 行/逐次结果/判定；
  四桶记账与 `usage_facts` 同名同义（对账验收 V16/V17 spec §10-7）。
- **未落地**（本规格驱动）：runner（`agent-vitals-probe` crate + CLI）、判定统计、
  tab UI、cc-switch 凭据的 consent 流。
- **前置依赖**：无——V17 已合，runner 可独立开发；tab UI 依赖 runner 的 job 轮询面。

## 3. 测试内容分层（进产品的只有 L0/L1）

| 层 | 内容 | 成本量级 | 产品面 |
|---|---|---|---|
| L0 快速体检 | 身份探针（协议字段：stream-json 的 resolved model）、thinking 预算→出现率（2026-04 复盘同款失效模式）、上下文窗口阶梯（声明 200k 实际 ~100k = 经典注水指纹）、温度 0 稳定性、input_tokens 指纹、TTFT/吞吐（仅辅助证据，网络混杂标注） | 分钟级、≈$0.05 | 首屏默认档 |
| L1 金丝雀对照 | 自带隐藏测例的小任务仓库（CCBench 模式），N 次重复**交错执行**（A/B/A/B 消除时段波动），记录通过率/四桶 token/轮数/墙钟 | $1–3 级（3 题 × 3 次） | 显式触发档 |
| L2 公开榜 | Terminal-Bench 切片等 | — | **不进产品 UI**（流水线自验，留 CLI/CI；公开榜不当降智主证据——污染与坏题风险见 Epoch 审查） |

**不问"你是谁"**：模型自我报告被 system prompt 污染且不可靠，L0 身份证据只取协议字段。

## 4. 判定哲学（三级 + 诚实降级）

| 判定 | 触发条件 |
|---|---|
| `confirmed_mismatch` | 协议级硬证据：resolved ≠ requested、thinking 请求了但出现率 0、usage 数学不自洽、上下文窗口与声明不符 |
| `suspected_degradation` | 行为统计显著（配对检验）但无身份证据 |
| `no_signal` / `underpowered` / `inconclusive_confounded` | 重复次数不够；或混杂未排除（RTT、时段、缓存冷热）——如实呈现 |

规则逐条对应路由归因 spec 的句式（`has_unresolved` / 不得静默归因 / 原始字段不动）。
判定由**冻结的统计规则**产生（`probe_suites.rule_version` 可归因；判据变更走评审，
golden 纪律的判定层对应物——绝不为让某次跑通过而改阈值）。

## 5. 成对对照的调度语义（runner 的核心，不是"跑两次"）

1. 同题、同镜像/工作区快照、同参数；A/B **交错并行**消除时段性服务端波动
   （`interleave_seed` 可复现）。
2. 混杂变量如实记录（`confounders_json`）：网络 RTT 独立测量、缓存冷态声明、
   沙箱/环境差异（Boundary-Bench 证明策略差异本身就能造成大幅能力差——对照两侧
   环境必须严格同构）。
3. "模型换了"与"请求被改了"要区分开（`reasoning_effort_requested vs reported`、
   thinking_blocks、温度 0 稳定性是后者的证据位）。
4. 断点续跑与预算熔断：`budget_stopped` 是合法终态，已花费如实入 `evidence_json`。

## 6. 架构落点（全部踩既有模式）

| 层 | 落点 | 先例 |
|---|---|---|
| runner 逻辑 | 新 crate `agent-vitals-probe` + CLI `agent-vitals probe run/status/report`；统计/判定纯逻辑进 `agent-vitals-domain` | AGENTS.md：harness I/O 在 adapter、确定性策略在 core/domain |
| 长任务 | DB job 行（`probe_runs.status` + `lease_owner` 文件锁）+ `probe_run_status` 轮询命令 | `billing_recalculation_jobs` 全套先例 |
| 子进程 | spawn `claude -p --output-format stream-json` / `codex exec --json`；超时 kill + 输出完整性校验（claude -p 有偶发空输出/resume 挂起的已知 bug） | `run_navigation` 的 try_wait 轮询先例 |
| 桌面端 | 像 sessions/findings 一样 spawn CLI 拿 JSON；tab 注册（`workbench.html` nav + `switchTab` 分支）；tray 深链走 `tab_for_menu_id` | 五 tab 既有骨架 |
| 题库资产 | `data_home/probe/suites/<suite>/<version>/`（manifest + 快照 + 隐藏测例），库只存引用 + sha256 | assets/ 共享运行时数据 |

## 7. 凭据与安全（政策的凭据红线具体化）

1. **不落库不落盘**：凭据只在发起瞬间从 cc-switch DB / 环境读入内存，作为子进程
   env 传给 CLI；`probe_routes.credential_ref` 只存位置引用。
2. **显式授权**：每路线一次性 consent（`consent_granted_at_ms`；NULL = runner 拒绝
   发起），UI 明示"请求将经过该中转商——题面对其可见（这正是检测目的）"。
3. **金丝雀题面 = 机密**：不进 MCP、不进导出、不进任何 agent 可读面；per-run
   canary 串留在 manifest。
4. 对抗性规避是本质局限，判定卡诚实标注：中转商可识别探针流量专门供好模型——
   L1 任务长得像真实工作、交错随机化是缓解不是消除。

## 8. 成本与配额（第二条边界，但这是本仓库舒适区）

跑前估价（任务数 × 重复 × 价卡单价——定价目录现成）、硬预算熔断（`cost_budget_minor`）、
启动前配额感知（`quota.rs` 窗口数据：临近限流拒绝启动）。首屏把**预计花费与预算上限**
放在 CTA 旁边（设置页"一屏一个主 CTA + 预填 + 回执"纪律的移植）。

## 9. UI 骨架（tab 结构）

- **首屏**：路线对选择（A/B 各选 cc-switch 档案或官方直连）+ 模型 + 套件档位
  （L0 快速 / L1 标准）+ 重复次数（带统计功效提示）+ 预计花费与预算上限 → 主 CTA。
- **运行卡**：job 轮询、交错顺序可见、实时花费对熔断线。
- **结果页：判定卡先行**（一句话结论 + 证据等级 + 「什么证据会升级/推翻此结论」）
  → 指标表（通过率 A/B/Δ/CI、四桶 token、TTFT、thinking 出现率、requested vs
  resolved）→ 单任务下钻 → probe 会话详情（`session_key` 直连既有会话链）。
- **历史趋势行**（"上次 09-15 无异常"）；首屏只读 SQL 聚合（发现 tab §1.6 同款性能纪律）。
- 单路体检模式（用户没有官方 key 时）：判定上限明确标注只到 `suspected`。

## 10. 明确不做

- 不维护"模型指纹库"当真理（对抗性脆弱；指纹只作辅助证据）。
- 不做后台常驻探测（费钱）；按需 + 可选定期。
- L2 公开榜分数不进产品 UI；无硬证据不出"确认注水"。
- 不把探针会话计入正常成本聚合（默认排除 + 专属筛选，见 §1 判据）。

## 11. 分期

- **P1（runner 骨架）**：`agent-vitals-probe` crate + CLI（run/status/report）+ L0
  身份探针（claude-code 首执行环境：spawn `claude -p`、resolved model）+ 判定合并
  （worst-of）+ job 模式 + 预算熔断 + consent 流。**显式延后（评审记录）**：
  thinking 出现率与上下文窗口阶梯不进 P1——前者依赖 claude CLI 的 thinking
  预算旗面（未核实的旗子不发明），后者单次成本高（阶梯要发大上下文请求），
  两者随 P2 的价卡/预算货币化一起落地；§3 表格中的条目是层定义，不是 P1
  交付承诺。
- **P2（tab + L1）**：工作台 tab 上线（本规格 §9）；L1 金丝雀 3 题 × 交错执行 +
  统计判定（配对置换检验、效应量 + CI）；判定回流发现 tab ②对比面（`source_kind='probe'`）。
- **P3**：codex 路线、直连 HTTP 探针（绕过 CLI 拿协议级原文证据）、题库轮换、
  ATIF 导入（映射表已在 V16/V17 spec §9 冻结）。

## 12. 待拍板清单

1. P1 是否把"成对对照"列为必选路径（单路体检模式照 §9 提供、判定上限只到
   `suspected`；待定的是 P1 默认入口落在哪一侧）。
2. L1 题库来源（自建 3 题起步 vs 改造 CCBench）与两档预算的具体数字。
3. probe 会话**默认排除 + 显式筛入**已定为判据（§1/§10）；待拍板的残余是
   呈现形态——总览是否加一行「探针花费」单独列示（不混入日常成本）。
4. 统计判据 v1 的具体阈值（检验选择、显著性水平、equivalence 边界）——冻结评审
   流程随 P2 定。
5. tab 定名（「测试」/「检测」/「验真」）及与发现 tab ②对比面的交叉链接方式
   （两边规格都还在 Draft，宜同期拍板避免改两次）。
