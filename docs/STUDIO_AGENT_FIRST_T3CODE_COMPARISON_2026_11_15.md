# Studio Agent-first 设计 × T3 Code 设计思路对比（引用级，2026-11-15；增量更新 2026-11-17 见 §5）

出处约定：

- **T3** = pingdotgg/t3code @ `70abb6c002c093ddb44beb0ccba4424f446e3f71`（2026-11-15，浅克隆于 `/Users/Admin/projects/project/refs/t3code`）；引用格式 `T3: <文件>:<行>`。
- **SPEC** = [STUDIO_AGENT_FIRST_EDITOR_SPEC_2026_11_15](STUDIO_AGENT_FIRST_EDITOR_SPEC_2026_11_15.md)；引用格式 `SPEC §x`。
- **dev** = 本仓库 dev 分支（`95f1f20e` 之后，含 S1/S2/S2b/S4/基线收口/阶段 1 vehicle MCP 与 Codex 的锚点 v3、air gate、game-control MCP 系列）。

## 1. 总体立场

| | T3 Code | Studio |
|---|---|---|
| 定位 | 通用 coding agents 的**控制平面**：驱动机器上已有的多个 agent（Claude Code/Codex/Cursor/…经 ACP），不内嵌 agent、不转售 token（T3: README.md「The open-source control plane for coding agents」「T3 Code does not resell tokens. It drives the agents you are already signed in to」） | **领域创作编辑器**：City/游戏创作的类型化接口面，Agent 为第一公民创作者 |
| 执行所有权 | 「T3 Code keeps execution in the environment that owns the workspace. … A remote client must never substitute its own filesystem, provider credentials, or machine state for the environment's.」（T3: docs/internals/overview.md:3-5） | 同一原则：宿主（Rust）拥有城市/项目/试玩权威，UI 与 Agent 是受限入口（SPEC §1；自定义 City 设计 §2） |
| 完整性标准 | 任意 agent 的可驱动性 | 领域闭环率：Agent 仅凭 MCP 完成创作全流程（SPEC §7） |

结论：两者是**同构不同域**的控制平面。T3 的域是「任意 agent × 任意代码库」；Studio 的域是「City 创作 × 固定宿主」。以下逐维比较，判定分四档：已一致 / 采纳（进 SPEC 切片）/ 改造（有条件采纳）/ 拒绝。

## 2. 逐维对比

### D1 会话持久性：Thread vs CreatorSession

- T3: 「Thread — The durable conversation and work history for a project. **It survives provider process exits.**」（T3: docs/internals/glossary.md:15）——agent 进程死亡，线程存活。
- Studio 现状：会话/预览依赖宿主进程与 Studio webview 存活；SPEC §3.1/E1 已含「宿主重启重放」，但**未覆盖「agent 侧进程死亡后重连」**的对称语义。
- 判定：**采纳对称化**——E1 的重放语义补一句：agent 重连（同 agentId）恢复全部未决引用，与宿主重启同等级。

### D2 异步 settle 的诚实状态：Turn / Checkpoint 分离

- T3: 「A provider turn ending and its follow-up work settling are separate milestones. … A late checkpoint or diff must not extend the recorded provider duration or keep the client showing provider work as active.」（T3: docs/internals/overview.md「Turn completion and checkpoints」节）——turn 结束与 checkpoint/diff settle 是两个里程碑，UI 不得把 settle 中的工作显示为「agent 仍在工作」。
- Studio: SPEC §3.2 的 Job 状态机已有 `running → ready` 分离与「提交成功 ≠ 完成」（SPEC §1 原则 3）；dev 的 flight HUD 进度（3d6df04f）已实践。
- 判定：**已一致**。补一条 SPEC 纪律引用 T3 作为外部先例：settle 不得伪造成活跃工作。

### D3 幂等回执：Command receipt / Outbox

- T3: 「Command receipt — A durable record of a command's result, used to make retries idempotent.」「Outbox effect — Side-effect intent committed with the events, such as starting a provider turn or capturing a checkpoint.」（T3: docs/internals/glossary.md:28-29）；Orchestrator 串行化命令、从当前状态决定事件、无 I/O；投影与事件同事务提交。
- Studio: `operationId` 幂等 + `creator_operation_status`/`creator_job_status` receipt 查询面（SPEC §3.2 已显式命名对齐）；预览/提交同事务（creator_cities.rs preview 记录）。
- 判定：**已一致**。差异在实现形态：T3 是事件溯源编排器，Studio 是 CAS + 原子事务——规模不同（单城状态机 vs 多线程编排），不需要引入事件溯源。

### D4 隔离与 diff 审阅：每线程 worktree vs preview→commit

- T3: 「Worktree — A separate Git checkout a thread can use instead of the project's main checkout.」（T3: docs/internals/glossary.md:14）；checkpoint「use hidden Git refs to capture workspace state without adding commits to the user's branch」（T3: docs/internals/overview.md:88-89，实现在 `apps/server/src/checkpointing/CheckpointStore.ts`）。
- Studio: preview（TTL 隔离区）→ commit 两段式；world.set 强制 `layoutInvalidation: "new-world-revision"`。
- 判定：**已等价**。世界是单实例状态机，没有 worktree 可开；preview+CAS 就是同一语义的领域形态。T3 的 hidden-ref checkpoint 提示一个可选增强：世界重建失败时保留「可回滚的上一布局」——SPEC §3.2 已含「失败保留可恢复的已保存版本」，引用佐证即可。

### D5 权限模式与人在环

- T3: 四模式 per-thread（Supervised / Auto-accept edits / Auto / **Full access**），初始默认 Full access，管理员可经 managed policy 封顶；子 agent 的审批请求出现在父会话（T3: docs/user/permission-modes.md:15-25）。
- Studio: 创作面 Agent 自主（SPEC §1 原则 4），人审批集中在数据政策边界；无 per-session 权限档。
- 判定：**改造采纳（远景 E7）**——per-session 权限档（Supervised/自主）让新用户/敏感项目可逐步批准；managed policy 封顶对应企业部署。注意范围差异：T3 的 Full access 含任意命令/文件，Studio 的上限永远是 typed 接口面——权限档只调节「预览确认频率」，永不解锁新能力面。

### D6 多端监视与审批

- T3: 一个 server，桌面/手机/网页同线程；hero 场景「Start a thread at your desk, then approve the next step from your phone」（T3: README.md）；远端经 Tailscale/SSH/T3 Connect 只改变到达方式、不改变 server 语义（T3: docs/internals/remote.md:5）。
- Studio: 仅桌面单端。
- 判定：**采纳（远景 E7）**——宿主服务是本地 HTTP/RPC 服务，多客户端天然可行；有画面能力（capture/视口）仍绑定桌面 bundle。

### D7 可插拔 agent 协议：ACP vs 唯一宿主

- T3: provider-* 包逐 agent 适配；「Capabilities must describe what the provider can actually do. Antigravity can capture workspace checkpoints but cannot roll back its conversation.」（T3: docs/internals/providers.md:141）——能力描述必须真实，边界拒绝越权操作。
- Studio: 宿主唯一，agentId 是声明式标识（SPEC §6 明确不做 provider 身份体系）。
- 判定：**拒绝多 provider 化，采纳能力归一化纪律**。SPEC「能力目录只列已实现、缺失能力明确报错」与 T3 的 capability 诚实原则同构；T3: providers.md:171「T3 derives diffs from checkpoints」亦是「从真实能力源派生而非另行声明」的先例。

### D8 上下文交接

- T3: 可移植交接是文本摘要——「240 characters. A truncated value contains the first 237 characters followed by `...`」+「the delta since that provider last participated」（T3: docs/internals/context-handoffs.md:9-12）；明确「不得把迁移预算当作交接规则」（同文件:19）。
- Studio: SPEC E8（远景）Agent 交接摘要。T3 的纪律值得照抄：**交接预算与迁移预算分开声明**，摘要压缩规则精确到字符。
- 判定：**采纳（E8）**，含两条实现纪律。

### D9 诊断与评测：evals

- T3: `evals/mcp-tool-use` ——「Replays small fake threads … checks how they use T3's MCP tools: delegation, PR linking, previews, scheduling … **Each case reproduces a real mistake an agent made in T3 Code.**」（T3: evals/mcp-tool-use/README.md）——评测用例来自真实事故；廉价模型扮演 shell，不真跑。
- Studio: 无工具面 evals；本会话已积累的真实事故清单：阶段 2/3/4 半截实现、vehicleProfile 契约边界误改（+46 行审查）、world.set 语义漂移风险、锚点 DDL 混入未完成切片——**每一个都是 E9 的现成评测用例**。
- 判定：**采纳（E9）**，用例来源纪律照抄：「每个 case 复现一次 agent 真实犯过的错误」。

### D10 订阅与授权粒度

- T3: 「Subscriptions send the state a client needs, so a client viewing one thread does not pay for every thread's history. Authentication of a socket does not authorize every method on it.」（T3: docs/internals/overview.md:17-19）。
- Studio: exact_payload + 逐请求授权 + 有界返回（既有）。
- 判定：**已一致**。会话/作业查询的有界返回延续该粒度。

### D11 契约即边界：RPC contracts 包

- T3: `packages/contracts/src/rpc.ts`（2335 行）是「the boundary between independently versioned clients and servers」（T3: docs/internals/overview.md:11-13）。
- Studio: city-sdk 是同等地位（独立版本化、Rust include_str! 消费生成产物、跨语言共享测试向量）。
- 判定：**已一致**——且本会话的跨语言向量模式（performanceVectors）与 T3 的 contracts 包是同一思想在领域层的落地。

## 3. 汇总

| 维度 | 判定 | 去向 |
|---|---|---|
| D1 会话持久对称化 | 采纳 | E1 补 agent 重连语义 |
| D2 异步 settle 诚实状态 | 已一致 | SPEC 纪律引用 T3 先例 |
| D3 receipt 幂等 | 已一致 | §3.2 显式命名 |
| D4 隔离/diff 审阅 | 已等价 | 引用佐证 |
| D5 per-session 权限档 | 改造采纳 | E7（上限永为 typed 接口面） |
| D6 多端监视/审批 | 采纳 | E7 |
| D7 多 provider | 拒绝 | §6 维持唯一宿主 |
| D8 交接摘要 | 采纳 | E8（240/237 字符纪律照抄） |
| D9 工具面 evals（用例=真实事故） | 采纳 | E9（本会话事故清单为首批用例） |
| D10 订阅/授权粒度 | 已一致 | — |
| D11 contracts 包边界 | 已一致 | — |

净结果：**4 项已一致可直接引用外部先例，3 项采纳进 E7/E8/E9 远景切片，1 项改造采纳（D5，上限受 typed 面约束），1 项拒绝**。无推翻既有设计之处。

## 4. 对 SPEC 的修订

- §3.1：operations 语义升级为 Activity 时间线（已并入）。
- §3.2：显式命名 command receipt 对齐（已并入）。
- §5：新增远景 E7/E8/E9（已并入）。
- 本文件作为 §9 的引用级展开；两文档互链。

## 5. 增量对比（2026-11-17）

基线更新：T3 `70abb6c0 → origin/main`（两天，20+ 提交全部为 fix/refactor/ci，`docs/internals/*` 架构文档与 `packages/contracts` 零变化——**D1–D11 的 T3 侧判定基线不动**）；dev `f36d6e67（本文件落盘）→ 51738b08`（E2/E5/E6 落地、playtest 生命周期修复、host experience tools、50 工具面、wasm-spike）。以下只记录判定发生变化的维度。

### D2 异步 settle 诚实状态：判定升级——统一 Job 面已落地

- 原判定「已一致（纪律引用）」升级为「已一致且有实现承载」：`a1a74ac8 feat(mcp): world-apply jobs complete the E2 unified job surface` 把布局/世界/试玩/捕获统一注册为 Job，`6301c5cf` 让专用 playtest-start 臂注册会话作业——「提交成功 ≠ settle 完成」从原则变成了 Agent 可 `job_wait` 的类型化面。
- 配套的实例替换语义同时落地：`c8c0d036`（City/Studio 被替换后恢复试玩 handoff）、`be44e2fc`（City 接管前 ack playtest start）、`35ef1c70`（handoff receipt 保留 + health-fault 显式关闭）——这组修复正是 D1「agent/宿主进程生命周期不对称」在试玩链路上的对称化实践。

### D6 多端监视与审批：可行性证据增强

- `1691ca77`/`a6f47866`：E5 headless 档第一切片——宿主服务在无 UI 下可用（能力降级报告）。D6 的前提「宿主是本地服务，多客户端天然可行」从论证变成了可运行形态；E7 多端监视的距离缩短为「瘦客户端 + 有画面能力的桌面绑定」。

### D9 工具面 evals：从远景（E9）到部分落地

- `evals/creator/`（`run.mjs` + `cases/`）与 `bbed235f` 的 E6 flight-pipeline 端到端验证脚本已存在；SPEC §10.1 把 E9 事故回归用例与 agent-friendliness 度量表挂到同一判分脚手架（按 E6 闭环脚本的 `evidence.json` 聚合）。
- 「每个 case 复现一次 agent 真实犯过的错误」纪律已吸收进 SPEC §10；T3 侧对应物 `evals/mcp-tool-use` 的结构（fake thread 重放、廉价模型扮演 shell）仍是 E9 全量化的参照。

### D12（新增维度）验证器执行的宿主侧可验证承载：Studio 独有，T3 无对应物

- 背景：本文件 D2/§9 的信任模型缺口——「WebView 返回值仍是宿主输入……语义校验需移到宿主可验证的进程/签名执行环境，或保留 Rust 权威校验；普通哈希不能证明验证器执行过」。T3 不需要解决这个问题：它驱动外部 agent，验证器在 agent 进程内跑，T3 靠 checkpoint diff 事后审计。
- dev 侧实证：`88fd5122 spike(city-sdk): validate validators inside a WASM QuickJS runtime`（evals/wasm-spike/SPIKE_REPORT.md）——同一份 city-sdk TS 校验器经 quickjs-emscripten 与 Javy 两条 WASM 路径执行，6/6 验收向量与 Node 原生**逐字节相同**，唯一不兼容点（QuickJS 在 `u` 模式拒绝字符类内 `\-` 转义）以语法等价改写绕过并给出上游修复建议。spike 结论「有条件可行」。
- 判定：**Studio 方向的独有深化**。它把「SDK verdict 只来自活动官方 Studio」从信任声明推进到可承载的技术路线（宿主控制的 WASM 运行时执行校验器），而不引入 T3 式的外部 agent 信任。若采纳，归属 SPEC §9 信任模型的后续切片（非远景 E7/E8/E9 之一，独立立项）。

### D10/D11/D7 在 50 工具面上延续

- `0346c5bb`（host experience tools + 共享 content-library install）、`d17e2c20`（MCP 客户端指南同步 50 工具面）、`51738b08`（city-sdk 错误消息带 next 建议——E3 纪律实例）：新工具维持 exact_payload/有界返回/错误带可执行建议，D7 能力诚实、D10 粒度、D11 contracts 边界的判定不变。

### 增量汇总

| 维度 | 11-15 判定 | 11-17 判定 | 变化来源 |
|---|---|---|---|
| D2 settle 诚实 | 已一致（纪律） | 已一致（E2 Job 面落地） | a1a74ac8、6301c5cf |
| D6 多端监视 | 采纳（E7） | 采纳（E7；E5 headless 已可运行） | a6f47866、1691ca77 |
| D9 evals | 采纳（E9） | **部分落地**（evals/creator + E6） | bbed235f、SPEC §10 |
| D12 验证器承载 | （未识别） | **新增：Studio 独有方向，spike 有条件可行** | 88fd5122 |
| 其余 D1/D3/D4/D5/D7/D8/D10/D11 | — | 不变 | T3 与 dev 两侧均无架构级变化 |
