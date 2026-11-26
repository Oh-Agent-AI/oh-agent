# Studio Agent-first 设计 × T3 Code 设计思路对比（引用级，2026-11-15；增量更新 2026-11-17 见 §5、2026-11-26 见 §7）

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
- 判定：**Studio 方向的独有深化**。它把「SDK verdict 只来自活动官方 Studio」从信任声明推进到可承载的技术路线（宿主控制的 WASM 运行时执行校验器），而不引入 T3 式的外部 agent 信任。落点：SPEC §11「W1 spike」——**spike 已完成**（2026-11-16，quickjs-emscripten/Javy 双路径 6/6 向量逐字节一致，结论有条件可行，见 [SPIKE_REPORT](../evals/wasm-spike/SPIKE_REPORT.md) 与 SPEC §11.4）；全量项目（宿主自签发信封）尚未立项。

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

## 6. 源码级复刻完成度与优化空间（2026-11-17）

方法：以 T3 源码子系统清单（`apps/server/src` 1454 文件、`packages` 1302 文件）为基准，逐模块映射 dev 实现物；只回答两个问题——核心设计是否已复刻、还有什么可吸收。

### 6.1 复刻完成度矩阵

| T3 子系统（源码位置） | dev 对应物 | 状态 |
|---|---|---|
| `orchestration-v2/`（85 个域文件：EventStore、ProjectionStore、Orchestrator、EffectOutbox） | creator dispatch（CAS + Immediate 事务）+ E2 统一 Job 面 | **形态等价，刻意不抄**：事件溯源为多线程编排服务；世界是单城状态机，CAS + revision 链是同语义的更小形态 |
| `CommandReceiptStore.ts` + 幂等重试 | `creator_operations` + `creator_operation_status`（P2 起带 capabilityVersion 审计） | ✅ 已复刻（真机验证：重发逐字节相同） |
| turn/settle 分离（overview「Turn completion and checkpoints」） | E2 Job 面 + preview TTL + `job_wait` | ✅ 已复刻（a1a74ac8） |
| `checkpointing/`（hidden refs、Capture/Restore/Rollback 三服务） | preview TTL 隔离区 → commit CAS；`creator_changes` 全量审计 | ✅ 语义等价：隔离+审计有；Restore/Rollback 安全检查器无（见 6.2-O3） |
| `packages/contracts`（2335 行 RPC 边界） | city-sdk（生成链 + include_str! + 跨语言向量） | ✅ 已复刻（同思想领域化） |
| `provider-*` 13 包（ACP 适配、capability 诚实） | 唯一宿主；能力目录只列已实现 + E5 降级码 | ✅ 纪律已复刻；多 provider **刻意拒绝**（D7） |
| `policy/`（per-thread 四模式 + ManagedPolicy 封顶） | `--allow-local-writes` + exact_payload + 逐请求授权 | 🟡 部分：数据边界等价；per-session 档在 E7 |
| `relay/`、`peer/`、`ssh/`、`tailscale/`、`guest/`、`cloud/` | 无 | ⛔ **刻意不做**：数据政策「所有数据留本机」；多端在 E7 且只做瘦客户端 |
| `worktreesDirectory.ts`、`git/`、`vcs/`、`source-control-*` 8 包 | preview 隔离区（世界非 git 仓库） | ✅ 形态等价（D4）；SCM 集成不适用 |
| `evals/`（mcp-tool-use 12 个可重放 ndjson 域 + 分域 grading） | `evals/creator/`（5 个 markdown 事故用例 + run.mjs 判分） | 🟡 部分：用例=真实事故纪律已吸收；重放自动化差距见 6.2-O2 |
| `mcp/`（T3 自暴露工具面：delegate_task 等 + McpToolAccess 竞态防护） | agent-vitals-mcp 50 工具 + mailbox 预算 + 宿主闸门 | ✅ 已复刻且更严（宿主闸门 + 描述符预算是 dev 独有加固） |
| `ContextHandoffService.ts`（240/237 字符摘要 + delta） | E8 远景（纪律已照抄进 SPEC） | 🟡 远景未实现 |
| `IdleCompactionService.ts`、`NotificationMailbox.ts`、`LiveStreamBudget.ts`、`DispatchModeLimit.ts` | 无对应（见 6.2） | ⛔ 未覆盖——优化空间主要来源 |

**总结：控制平面的 8 个核心机制（receipt、settle 分离、隔离/审计、契约边界、能力诚实、授权粒度、工具面防护、evals 纪律）已全部在 dev 有对应实现或明确远景归属；未复刻的部分全部是「刻意拒绝」（多 provider、多端 relay、云、SCM）而非遗漏。**

### 6.2 优化空间（T3 已解、dev 未解，按价值排序）

- ~~O1 长期记录保留治理~~ **已落地（2026-11-26 复核修正）**：`b5761d1b`（2026-11-17，提交信息直接引用本条）——`prune_creator_history`：每项目保留 8 份全量 `document_json`（旧行置 `"{}"`，revision/digest/actor 审计列保留），`creator_operations` 每 (project,actor) 保留 64 条后 DELETE；在 commit 事务内联执行、零调度器，与「保留审计列、丢弃全量文档」的建议语义一致。
- ~~O2 evals 判分自动化~~ **已落地（2026-11-17 复核修正）**：`evals/creator/run.mjs` 是 1049 行确定性判分器，5 个 case 各嵌入结构化 rubric（25 个判分项，rubric 类型闭集），`--self-test` 正反例全过；`verify.yml` 新增 `creator_evals` job 把 self-test 挂进 CI。剩余缺口只是 run.mjs 自述的「model-driven replay 为后续扩展」——判分自动化本身不再是缺口。
- ~~O3 restore/rollback 安全检查器~~ **已覆盖（2026-11-17 复核修正）**：存档恢复路径的完整性验证已四层存在——`coerceStore`/`coercePlanPatch` 逐条验证、坏条目丢弃而非恢复进引擎（这正是 CheckpointRestoreSafety 的领域语义）；`readLocal` 全包 catch（曾修复"存档损坏带崩挂载"的真实事故）；`session.load` 空库诚实降级 + saveFailed 显式信号；viewport 受控失败态（world_scene_load_failed / engine_initialization_failed）。本轮补上的唯一残留是 `CityViewport` 对 `session.load()` 的防御性 `.catch`（恢复路径不允许 unhandled rejection 逃出挂载）。Rust 权威层 commit 本身事务性（全或无 + CAS），无需额外回滚服务。
- ~~O4 agent 活动卡的持久通知~~ **已落地（2026-11-26 复核修正，路线不同）**：`6f50fafd`——活动卡经 `plugin.state.write` 写插件私有状态 `creator-agent-activity:v1`（revision CAS），启动时重放，`slice(0, 6)` 上限保留。未走原建议的 `plugin_events` 尾页重建，持久化与重启重放语义等价。
- ~~O5 流式输出预算~~ **不适用（2026-11-17 复核修正）**：dev 的 E2 Job 面是轮询拉取模型（`creator_job_wait` 阻塞至终态/30s 超时，返回有界 running 快照），不存在流式推送通道——T3 `LiveStreamBudget` 解决的是推送模型的 backpressure，在拉取模型下无此问题。等价防护已存在：progress_json 有界 + 响应预算。若未来引入推送订阅（E7 多端监视），届时再按 LiveStreamBudget 的窗口语义补。

### 6.3 结论

核心设计**已复刻完成**：T3 控制平面的 8 个核心机制全部在 dev 有落地或明确远景归属，且 dev 在宿主闸门（描述符预算、commit 语义闸门、WASM 验证器承载方向）上做了 T3 没有的领域加固。未复刻部分均为有据可查的刻意拒绝。优化空间集中在**运维耐久性**（O1 保留治理最实质）与**判分自动化**（O2），均不触碰既有边界。

## 7. 增量对比（2026-11-26）

基线更新：T3 `70abb6c0 → origin/main`（`ca432d7e`；上游 50 个提交全部为 fix/refactor/CI/mobile/voice，`docs/internals` 仅 `mobile-navigation.md` 7 行微调，`packages/contracts` 62 行特性级增量——**D1–D11 的 T3 侧判定基线不动**）；dev `51738b08（§5/§6 落盘时基线）→ 66b0d9cb`（134 个提交：City SDK V3 与叙事引擎 N1–N3、Actor 适配器 W6、宿主交付总线 W7、Studio Agent 集成面（codex/ACP 双执行器）、ST-02–13 与会话中心工作区）。§6.2 的 O1/O4 于落盘当日即已修复（`b5761d1b`、`6f50fafd`，提交信息直接引用本文件条目号），条目已就地标注；本节记录其余判定变化。

### D7 可插拔 agent 协议：判定修订——从「拒绝多 provider」到「领域化吸收执行器可插拔」

- 原判定（11-15）：拒绝多 provider 化，宿主唯一；agentId 是声明式标识（SPEC §6/§9.2）。
- dev 侧实证：`5f1b7562`（ST-08 codex preview executor）与 `a7f994da`（ACP push executor）——`creator_task_execute` 新增 `executor` 字段：默认 `codex`，或 `acp`/`acp:<agentId>`，来自 `acp-agents.json` 注册表（已登记 kimi-code、deepseek-harness；`crates/agent-vitals-mcp/src/mcp/creator_agent_executor.rs`）。宿主自行实现 Agent Client Protocol v1（stdio JSON-RPC：`initialize`/`authenticate`/`session/new`/`session/prompt`），并在 `session/new` 时把 creator MCP server 注入外部 agent。
- 信任边界**反向收紧**（与 T3 的关键差异保持）：外部 agent 只提案 `{summary, operations}`，两个执行器共用 `finish_with_host_preview` 由宿主独立校验并签发 revision 绑定预览；`session/request_permission` 一律 reject；client capabilities 声明无 fs/terminal（越权请求返回 `-32601`），结构性 analyze-only；`session/new` 默认 `restricted`。
- 判定修订：**宿主仍是唯一权威，执行器可插拔**。T3「drive the agents you are already signed in to」的核心模式被领域化吸收，「授权按宿主规则」不变；SPEC §6/§9.2 已按此修订（2026-11-26）。Actor 适配器（`e4adfbe7`）同向：外部 coding agent（Codex/Claude Code 会话）驱动剧情角色，宿主零模型调用，只管身份铸造/预算闸/事实复算（V3-04）——与 T3「不转售 token、驱动已登录的 agent」同一立场。

### D5 权限模式：从「E7 远景」到「部分落地（per-call 两档）」

- `creator_task_execute` 带 `mode ∈ {restricted, full-access}`，默认 restricted 且默认值钉死（`crates/agent-vitals-mcp/src/mcp/creator_session.rs`）；codex 执行器因自带 `--dangerously-bypass-approvals-and-sandbox` 被拒入 restricted——「权限档只调节执行面、永不解锁新能力面」以执行器闸门形式落地。
- 与 T3 的 per-thread 四模式（Supervised/Auto-accept/Auto/Full access + 管理员封顶）相比：粒度更细（每次调用）、档位更少（两档）。**per-session 持久权限档（Supervised 逐步批准）仍不存在**，维持 E7 远景。

### D1 会话持久性：实质达成

- `creator_sessions` 表落宿主 sessions.sqlite；共享任务账本接受多 agent 并发连接（transports：`mcp-stdio`/`acp-stdio`/`studio-webview`），per-agent 开放会话限额——会话不再依赖任何单一 agent 进程存活，T3「Thread survives provider process exits」的领域形态成立。
- UI 侧 `66b0d9cb` 重建为 session-centric 三栏（Sessions｜Agent Chat｜Live Preview；设计见 [工作区信息架构](CREATOR_STUDIO_WORKSPACE_INFORMATION_ARCHITECTURE_2026-11-25.md)）；goal drafts 跨路由保留（`3335ff01`）。
- 残余：设计稿自述「现有 Task ledger 不等于可恢复的用户会话」——切换 Session 时完整恢复 Agent/harness、对话、当前 Task、草稿输入与预览指向的验收未闭环（剩余差距 R3）。

### D3 receipt / outbox：投递原语落地（事件溯源维持刻意不抄）

- `773c7490`（W7 D-1/D-2/D-3/D-5）宿主交付总线：`host_deliveries` 表（`dedupe_key` 使重放跨 pending/in_flight/confirmed 幂等、TTL 惰性过期、fetch-and-ack 单事务）+ `claim_wait` 长轮询 + 10 分钟 `REPLY_TTL` 的 in_flight/confirm 重投语义（`crates/agent-vitals-mcp/src/mcp/host_delivery.rs`）。Outbox 与 wait 两个 T3 编排原语有了领域承载。
- 全仓库无 `EventStore`/`ProjectionStore`/`Orchestrator` 类型——§6.1「CAS + 事务，刻意不抄事件溯源」判定维持：交付总线是**有界收件箱队列**，不是事件溯源编排器，时间线仍为拉取可恢复模型。

### D12 验证器承载：从 spike 到落地，路线变更（WASM → 嵌入式 JS）

- WASM spike（quickjs-emscripten/Javy，有条件可行）的宿主侧路线被**候选 B 取代**：`rquickjs = "0.14"` 嵌入式 JS（`apps/desktop/src-tauri/Cargo.toml`，决策记录见 `embedded_city_sdk.rs`）。`7ee328ab`（N2-b）起叙事评估器以 IIFE 形式 `include_str!` 进宿主（`apps/desktop/src-tauri/src/narrative_engine.rs`）：每次调用独立 Runtime（64MB 内存/1MB 栈限额），64-bit nonce 宿主铸造、结果不匹配即拒，语义与 `narrative-sdk runtime/evaluate.ts` lockstep。
- `ea00848e`（S-6b/V3-16）宿主规则复算输出 `host-verified` / `hostDisagreement` 双向诚实标记——「SDK verdict 只来自宿主可验证执行」从信任声明变成运行机制。
- 判定升级：**Studio 独有方向已从 spike 进入生产承载（叙事域）**。city-sdk 校验器全量进宿主（SPEC §11 原目标）仍未立项；立项时载体决策从「WASM 或放弃」扩展为「按域选 rquickjs 嵌入式 JS 或 WASM」，§11.2 的独立性弱化声明同样适用。

### D6 多端监视与审批：多 agent 端落地，多 UI 端未动

- 已落地的是**多 agent 端**：外部 Codex/ACP agent 经 stdio headless 驱动宿主（capability matrix 明列 headless 臂）；交付总线经 WAL 由桌面与 MCP 进程共享。E5 headless（`a6f47866`/`1691ca77`）之上，外部 agent 成为与桌面 webview 平级的会话主体。
- 未落地：第二 UI 瘦客户端——无 HTTP 服务器（仅测试用 loopback `TcpListener`）。T3 hero 场景「手机批准下一步」对应的**多 UI 端维持 E7 远景**，其前提（宿主本地服务 + durable sessions + headless 臂）已全部就位。

### 维持不变的判定

- D2（settle 诚实）、D4（隔离与 diff 审阅）、D10/D11（授权粒度、contracts 边界）：实现物继续在位，无变化。
- D8（E8 交接摘要）：仍不存在。最接近的 `creator_actor_turn_context` 是外部会话冷启动的**事实投影**，自述「不是对话记忆；会话上下文归外部 agent 宿主自持」——领域变体有了，agent-to-agent 摘要（240/237 字符纪律）仍是远景。
- D9（E9 evals）：仍 5 个 case + `run.mjs` 确定性判分 + CI job；model-driven replay 未实现（`run.mjs` 自述后续扩展），且基线后 ST/ACP/N 系列开发事故尚未沉淀为新 case——「每个 case 复现一次真实错误」的用例增长停滞。

### 增量汇总

| 维度 | 11-17 判定 | 11-26 判定 | 变化来源 |
|---|---|---|---|
| D7 多 provider | 拒绝（宿主唯一） | **修订：宿主唯一权威 + 执行器可插拔** | 5f1b7562、a7f994da、e4adfbe7 |
| D5 权限档 | 采纳（E7 远景） | **部分落地**（per-call 两档；per-session 档仍 E7） | creator_task_execute mode |
| D1 会话持久对称化 | 采纳（语义补句） | **实质达成**（durable sessions + 多 agent 并发；恢复完整性待验收） | creator_sessions、66b0d9cb |
| D3 receipt/outbox | 已一致（形态等价） | 已一致（outbox/wait 原语落地；事件溯源维持刻意不抄） | 773c7490 |
| D12 验证器承载 | spike 有条件可行 | **落地（叙事域，rquickjs 路线）** | 7ee328ab、ea00848e |
| D6 多端监视 | 采纳（E7；E5 可运行） | 多 agent 端落地；多 UI 端维持 E7 | 5f1b7562、a7f994da |
| O1 保留治理 | 缺口 | ✅ 落地（就地标注） | b5761d1b |
| O4 活动卡持久 | 缺口 | ✅ 落地（plugin state 路线，就地标注） | 6f50fafd |
| D2/D4/D8/D9/D10/D11 | — | 不变 | — |

### 剩余差距（按价值排序）

1. **R1 SPEC 漂移**——本次已闭合：D7 修订与 D5 per-call mode 已回写 SPEC §3.6/§5/§6/§9/§11；后续实现漂移按本节模式随增量收口。
2. **R2 E9 evals 持续运营**：近两周事故未入册（ST 系列半截实现、ACP 会话生命周期、N 系列裁决链）；model-driven replay（T3 `evals/mcp-tool-use` 的廉价模型扮演 shell 重放）仍是 E9 全量化的唯一手段缺口。
3. **R3 会话恢复完整性**：durable sessions 已有；「切换 Session 恢复 Agent/harness、对话、当前 Task、草稿输入与预览指向」（工作区信息架构 2026-11-25 的设计承诺）待实现与验收——D1 的最后一公里。
4. **R4 E8 交接摘要**：维持远景；`turn.context` 事实投影可作起点，240/237 字符纪律照抄。
5. **R5 多 UI 瘦客户端（E7）**：仍无；宿主服务形态（WAL 共享 + headless 臂 + durable sessions）已具备前提。
6. **R6 预览批注能力**：批注点/冻结帧拾取/随图对象引用均为待实现（现有能力仅视口截图附件，StudioTaskPanel）——T3 无此需求，dev 独有方向。

净结论：§6「8 项核心机制已复刻」升级为「9 项」（新增 outbox/wait 投递原语承载）；唯一被否定的判定（D7 拒绝）翻转为领域化吸收且信任边界不放宽；剩余差距集中在 evals 持续运营（R2）、会话恢复最后一公里（R3）与两个远景切片（R4/R5），无新架构缺口。
