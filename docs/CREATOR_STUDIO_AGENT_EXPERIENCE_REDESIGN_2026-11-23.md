# Creator Studio Agent 体验重设计

2026-11-23 · 依据 [T3 Code](https://github.com/pingdotgg/t3code) 源码审读（[权限模式](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md) · [ACP 接入](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-acp.md) · [安全模型](https://github.com/pingdotgg/t3code/blob/main/SECURITY.md)）、本仓库既有对比文档 [STUDIO_AGENT_FIRST_T3CODE_COMPARISON_2026_11_15](STUDIO_AGENT_FIRST_T3CODE_COMPARISON_2026_11_15.md)，以及 2026-11-22/23 两日真机创作测试的工程发现。上游关联：[架构优化方案](CREATOR_STUDIO_AGENT_ARCHITECTURE_PLAN_2026-11-22.md)、[编辑器重构实施说明](CREATOR_STUDIO_EDITOR_REFACTOR_IMPLEMENTATION_2026-11-22.md)、[数据策略](DATA_HANDLING_POLICY.md)。

本文细化架构优化方案的实施顺序。先恢复可验证的执行边界和保存流程，再统一创作界面，最后接入持续会话与实时画布反馈。下文的新增接口、字段及验收均为实施规格。

## 一、核心判断

**我们把内部治理流程做成了用户流程，因此每一步出问题都让用户觉得创作很复杂。** 复杂度有两个来源：City/Game/Story 的领域需求（不可消除），和当前实现（可以精简）。T3 Code 围绕项目、线程和 Agent 执行组织体验：选 Agent、发消息、在线程里看过程、在变更处确认。我们的目标更进一步——修改要落到 City Runtime、保存到作品版本、支持试玩发布——**这些能力需要各自的事实和边界，但普通用户不应先理解它们。**

| 方面 | T3 Code | 当前 Studio 的问题 |
| --- | --- | --- |
| 开始工作 | 选 Agent，发消息 | 目标被包装为 Goal/Plan/Task/Evidence，界面暴露账本与事件术语 |
| Agent 执行 | 线程与回合持续呈现过程 | push 执行偏一次性任务，完成后解析固定 JSON；连续对话与追问不足 |
| 修改反馈 | 文件变化 + 检查点 | Agent 提案、宿主预览、画布渲染、作品保存多处状态不统一 |
| 用户确认 | 在操作或变更处确认 | 「确认保存」「追加证据」「接受任务」彼此分开，保存后 revision 变化导致验收冲突 |
| 多 Agent | Provider/ACP 统一会话体验 | 先有任务状态机再分别接 Codex/ACP/外部会话，选择与执行模型不统一 |

## 二、我们自己增加的复杂度（四个 + 一个）

**1. 内部治理流程变成了用户流程。** `startTask` 一次输入依次创建任务、提交默认计划、批准计划、执行。按钮已叫「开始创作」，底层多次状态转换对用户不可见也不必可见。默认计划不提供新决策信息，应留在内部任务记录；用户只看消息、执行状态、待确认修改和结果。（[useStudioTasks.ts:128](../apps/creator-studio/ui/src/features/agent/useStudioTasks.ts#L128)）

**2. 一次确认拆成了多次独立写入。** UI 先保存预览、再追加证据、再接受任务，三次调用之间作品 revision 已变，出现「作品已保存，任务仍不能接受」。这是操作边界不一致，不是领域必然。Host 应提供**面向用户动作的确认接口**：一次完成预览核对、保存、回执与任务状态更新，并支持中断恢复。（[StudioTaskPanel.tsx:23](../apps/creator-studio/ui/src/features/agent/StudioTaskPanel.tsx#L23)）

**3. Agent 会话与作品编辑分成两套体验。** 当前执行器从单次回复提取 JSON 提案，再请宿主生成 Preview。持续会话需要保留作品上下文，并把每轮的提案和预览作为结构化事件展示，例如选中出租车、追问原因、调整方案并重新查看效果。[执行器](../crates/agent-vitals-mcp/src/mcp/creator_agent_executor.rs#L51)

**4. 作品类型各自加分支，缺统一编辑接口。** Game/City/Story 在执行器与前端提交函数里分别判断类型；随建筑、道路、NPC、剧情、玩法增加分支继续扩张。应定义统一操作流：读取 → 提议修改 → 预览，各领域实现自己的校验与应用：

```text
用户消息 → Agent 会话 → 作品编辑能力（读取→提议→预览）
→ Studio 展示画布变化与差异 → 用户确认 → Host 提交并返回新版本
```

City 道路重建、Story 图校验、Game 规则校验各自存在，但聊天组件不维护三套流程。

**5. 权限边界在代码里，不在界面上。** 当前执行器直接使用 `--dangerously-bypass-approvals-and-sandbox`，把只读 MCP 与提示词当作执行边界。T3 Code 同样提供 Full access（并明示其风险），但它是**用户可选、可理解的权限模式**，由线程设置和管理策略控制。问题不是不能给高权限，而是用户无法看到、选择、理解当前模式。Oh Agent 的本地数据授权、正式 City 写入与远程能力仍受 [数据策略](DATA_HANDLING_POLICY.md) 约束。

## 三、目标体验：五个统一

| # | 统一项 | 内容 | 对应改造 |
| --- | --- | --- | --- |
| 1 | **统一会话** | 选 Agent、输入目标、追问、切换作品，围绕作品保留线程、消息与执行状态 | 会话化传输（Executor trait v2 / ACP 多回合），M3 |
| 2 | **统一编辑协议** | Agent 经有类型能力读取对象、提交提案、请求预览；City/Game/Story 各自实现，聊天组件无类型分支 | 编辑能力协议（§四），M2/M3 |
| 3 | **统一变更卡** | 「正在修改」「可查看变更」「已保存」及失败原因。确认动作调用同一个 Host 提交入口。 | 统一确认接口 R1 |
| 4 | **统一画布反馈** | TS Runtime 呈现可预览变更。规则、碰撞及不可变 Build 的修改按影响准备新的试玩。 | 编辑能力协议 R4 |
| 5 | **账本与证据下沉** | 账本支撑恢复、重试与验收。界面展示用户做决定所需的信息。 | 界面调整 R2 |

## 四、改造项（按批次）

### R1 统一确认接口（立即）

可信 Studio 变更卡调用一个 Host 命令 `creator.task.confirm_save`。Host 验证调用者、读取任务账本和当前预览，并协调作品保存与任务终态。界面使用真实回执显示版本。

| 项目 | 草案 |
| --- | --- |
| 请求 | `taskId`、`planRevision`、`previewId`、`expectedArtifactRevision`、`operationId`，以及可选的 `reviewerNote`。 |
| 校验 | 任务在待确认阶段，所选 preview 对应当前计划的 host-observed 证据。核对作品类型、ID、基线 revision 和有效期。当前版本冲突时返回重新预览所需状态。 |
| 回执 | 返回 taskId、作品类型及 ID、previewId、保存后的 revision、operationId 与任务状态。保存完成而账本尚待收尾时，返回可恢复状态。 |
| 确认和重试 | UI 只提交标识，作品内容从 Host 持有的预览读取。同一 operationId 和相同参数重复调用时返回同一结果，参数变化返回冲突。 |

作品库与任务账本使用不同数据库。推荐使用可恢复的三步写入，复用各领域现有的版本比较和提交回执。

1. 在任务账本登记确认意图。锁定当前任务、计划、作品和预览。相同 operationId 并发请求合并到同一条意图。
2. 在作品库事务中校验并应用 Host 预览，同时写入绑定该意图的提交回执。Story 需要接入由 Host 持有的有界预览，保存时核对 previewId、基线和内容摘要。
3. 根据作品提交回执在账本中完成复核记录和任务终态。若进程在第 2 步后退出，重试先读取已落库的回执，再完成账本收尾。此时旧基线已被正常推进，收尾以原提交回执为依据。

冲突、预览过期和保存成功但任务待收尾分别返回，界面展示可执行的下一步。任务手动退回沿用现有接口。验收覆盖「作品已保存后进程退出」「重复点击」「旧预览」「切换作品后才收到响应」。[现有确认流程](../apps/creator-studio/ui/src/features/agent/StudioTaskPanel.tsx#L23) · [当前 Story 保存入口](../apps/creator-studio/ui/src/features/agent/taskCommit.ts#L59)

### R2 界面账本术语下沉（立即）

- 状态列改为用户语言：创作中 / 等待确认 / 已保存 / 失败（内部 phase 保留在账本）
- `Goal / Plan / Evidence`、连接状态 facts、事件 `#seq · kind · trustLevel · source · eventId` 代码行全部收进「详情」折叠
- 失败状态旁显示经筛选的原因及重试入口，使用稳定错误码映射用户文案。原始进程输出留在仓库政策规定的本地诊断通道。
- 过程事件保留最近若干条作为「正在做什么」的实时反馈（T3 的 turn 流体验），完整历史下沉

### R3 权限模式显式化（立即）

- Studio 的首版创作模式采用受限提案。执行器适配层负责实际隔离、工具范围及权限请求。编辑器展示当前已验证的能力，选择不可用时给出具体原因。
- 将当前无条件关闭审批与沙箱的启动参数列为上线阻塞项。Creator MCP 只读控制覆盖它自己的调用，进程的文件、网络和其他工具权限需要由运行环境另行约束。
- Codex 和 ACP 分别通过真实能力探测确定支持的模式。使用可处理权限请求的协议时，在会话内呈现必要请求。扩大权限需要单独定义产品模式和数据边界。

### R4 编辑能力协议（M2/M3）

- 定义 `creator.edit` 能力族：`read(scope) → propose(operations) → preview → commit`
- City（world.set/patch/anchor）、Game（规则 JSON）、Story（graph/canon）各自实现；校验走各自闸（city-sdk 嵌入式闸 / narrative SDK）
- 聊天组件与执行器不出现构件类型 if 分支（当前 finish_* 三分支下沉为能力注册表）

### R5 会话化（M3）

- Executor trait v2：`open_session / run_turn / steer / interrupt / respond_runtime_request`
- ACP 多回合为首选通道；Codex CLI 保留一次性兼容路径并如实报 `steer_unsupported`
- 会话持久：任务账本继续支撑恢复与重试，会话线程支持追问

### R6 统一 Agent 目录与选择器

界面按 Agent 名称列出 Codex、Claude Code 和 Kimi Code 等条目。接入方式留在条目详情。同一 Agent 有多条经过验证的连接时，保留一个品牌入口，展开可选连接。首次配置或连接失效时由用户选择，任务执行时使用所选连接。

| 来源 | 给选择器的作用 |
| --- | --- |
| Vitals harness 清单 | 复用 harness ID、品牌名和本机观测信号。只有历史日志的条目可出现在「发现的 Agent」，并显示当前连接状态。 |
| Host 执行器注册表 | 提供真实可启动的连接，包括已配置的 ACP 实例与现有 Codex 适配器。UI 接收连接 ID、品牌、协议与可用性摘要。 |
| ACP Registry | 提供可添加的候选。用户添加经认可的入口后，Host 才进行协议探测并加入选项。可验证的自定义 ACP 连接使用同一套状态。 |

当前 `creator.capabilities.status` 已返回 `executors` 和 `acpAgents`，TS 只解析后者，组件另写了 Codex 选项。迁移从现有 `executors` 开始，补齐通用执行器 DTO。每条记录包含 `agentId`、稳定的 `executorId`、可选的 `harnessId`、显示名、连接方式、就绪状态和已验证能力。Host 保存命令、参数和授权，Studio 提交 `executorId`。是否支持读取 Creator 上下文、生成提案、继续会话及接收权限请求按具体连接确认。握手成功和实际任务成功分别记证。

| Agent | 可核对的接入方式 |
| --- | --- |
| Codex | Studio 已有单次 `codex exec`。持续会话可评估官方 app-server 或 ACP Registry 的 Codex 适配器。三条连接统一显示为 Codex。 |
| Claude Code | 可通过 ACP 适配入口接入。 |
| Kimi Code | 官方 CLI 提供 `kimi acp`。 |
| Gemini CLI、OpenCode、GitHub Copilot CLI | ACP Registry 中已有对应入口，按各自版本验收 Creator 工作流。 |
| ZCode、DeepSeek Harness、WorkBuddy 等 | 从 Vitals 清单呈现发现状态。只有用户配置具体连接并通过能力验证后才开启创作。 |

界面按「可用于创作」「待连接」显示，错误状态区分程序不可达、协议不兼容、需要登录及权限不足。每个任务绑定选中的连接；失败后允许用户换连接重试。接入验收包括同一品牌去重、选择确实传到 Host、切换执行器不串任务，以及握手成功但 Creator 工具不可用时的反馈。 [当前 Host 能力响应](../crates/agent-vitals-mcp/src/mcp/creator_session.rs#L300) · [当前 UI 能力解析](../apps/creator-studio/ui/src/contracts/studioTask.ts#L140) · [OpenAI Codex 集成方式](https://developers.openai.com/blog/codex-as-a-platform) · [ACP Registry 发布说明](https://zed.dev/blog/acp-registry) · [Kimi ACP 文档](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-acp.md)

## 五、2026-11-22/23 通道层工程记录

下表记录迭代中观察到的问题和当时的处理。当前版本的通过条件见后文。

| 发现 | 根因 | 修复 |
| --- | --- | --- |
| Codex 曾返回空提案 | 需按运行时能力验证 Creator 工具连通性与审批处理 | 当前工作树使用 bypass 参数。正式实现按 R3 验收受限执行与 Creator 工具连通性 |
| 宿主调用中 creator MCP「工具不可见」，Agent 自述无工具 | `run_shared_task` 用 `std::env::set_var` 传递 creator 二进制，多线程宿主不保证可见；exec 子进程回退 `current_exe()` = menubar GUI 二进制（ps argv 实证） | `resolve_binary()` 结果经参数显式传入 `task_dispatch → select_executor → mcp_config_args`（[creator_projects.rs:1296](../apps/desktop/src-tauri/src/creator_projects.rs#L1296)） |
| 失败只有裸码（codex_failed / preview_required） | 诊断缺少可定位的阶段与错误分类 | 工作树已加入诊断字段。合并前按 R2 检查持久事件的字段范围 |
| Codex 用量限额 / 认证过期不可辨识 | 错误未分类 | `codex_quota_exhausted`（含恢复时间）/ `acp_quota_exhausted` / `acp_auth_required` / `acp_failed`+尾部 |
| ACP authenticate 未实现即判死 | claude-code-acp 声明 authMethods 但不实现该方法 | authenticate 失败继续建会话；真实认证失败在 session/new 处按消息分类 |
| 任务时长 90s 掐断多工具回合 | 会话化前按一次性任务设定 | 上限放宽至 600s（spec + clamp），任务可随时取消 |
| Agent 场景提案无语义校验（无信封被拒） | 嵌入式闸缺 scene 入口接线 | headless 臂接入 `scene.draft.validate`（单对象校验与 webview buildSceneValidation 同语义），`creator.scene.preview` 经嵌入式校验签发信封 |
| ACP/Codex 单通道死锁（限额即停） | 执行器注册表缺失 | `acp-agents.json` 注册表（claude-code / zcode），capabilities 面暴露 acpAgents，UI 下拉动态渲染，executor 参数 `acp:<agentId>` |
| capabilities 为 null 时面板崩溃（plugin_runtime_error） | 下拉直接读 `capabilities.acpAgents` | 空安全 + 折叠回退选项 |
| 新建项目默认进场地配置 | 与「右栏默认 Agent」设计冲突 | 新建直达 Agent 面板；`开始创作` 快速通道（内部链式受理→提交→批准→执行，账本照记） |

已有测试和打包记录对应历史快照。复核基线为 `dev@3335ff01` 加当前未提交改动。11 月 23 日复核时，`cargo test -p agent-vitals-mcp --no-run` 已通过；执行隔离、确认保存和跨作品响应仍待修复。

## 六、待验收与未决

- **creator_binary 显式传参修复已实现、尚未真机验证**（今日最后一批构建完成后被中断）；验证方式：真机 Codex 闭环应观察到 `toolCallEvents > 0` 且提案非空
- 真机三闭环（Game 预览→确认→保存、City、Story）在 R1/R2 落地后统一复测
- 宿主重启后 `executing` 任务惰性收尾（`executor_lost`）未实现
- 历史测试观察到供应商限流或资源不足。真机记录标明所选执行器、实际错误阶段及结果。
- 「下一条创作目标」（回合边界 steer）已存在；真 steer 等 R5

## 七、开发顺序与验收

| 批次 | 交付 | 进入下一批的条件 |
| --- | --- | --- |
| 1 · 执行基础 | 按 R3 接入受限执行与可用性状态，验证失败诊断字段。 | Creator MCP 测试通过。真实 Agent 可以读取被允许的作品上下文并产生有界提案。 |
| 2 · 确认保存 | 按 R1 实现 Host 确认和恢复。先通过 Game，在同一个确认接口上接 City、Story。 | 三类作品各有保存回执。故障注入证明作品已保存后可恢复任务终态。 |
| 3 · 编辑器体验 | 合并为消息区和变更卡，使用 R2 的文案和详情结构。会话和任务响应按作品类型、ID 及请求代次隔离。 | 正常路径为「发送目标 → 查看变更 → 确认保存」。失败可处理，切换作品后无旧结果串入。 |
| 4 · 连续创作 | 接 R4 的预览呈现与 R5 的会话能力。适配器声明是否支持追加消息、停止和重连。 | 两轮消息可以围绕同一个作品继续。第二轮可引用第一轮的变更；保存后按新基线发起下一次提案。 |

在构建好的 macOS `Oh Agent.app` 中用独立测试作品执行下表。记录应用构建标识、Agent 和权限模式、任务及预览 ID、保存回执和重新打开后的 revision。画布截图与实际运行记录共同作为验收证据。

| 作品 | 真机目标 | 通过标准 |
| --- | --- | --- |
| Game | 修改已挂载模板的竞速时限并试玩。 | Studio 展示规则变化。确认保存产生新修订，重新打开能读到时限，新候选使用该修订并得到真实 Run 结果。 |
| City | 修改独立测试 City 的一个受支持地貌参数。 | Studio 显示候选及布局重建状态。确认后重新打开同一 City 可看到新 revision 和对应场景，主 City 身份保持正确。 |
| Story | 增加一段剧情和一条可触发的分支。 | 预览展示图差异，确认后重新打开可读到新节点和分支。使用独立测试 Run 触发该分支，记录实际结果。 |

各类型还应核对旧 revision 拒绝、弃用预览、同一操作回执重放与跨作品响应隔离。自动检查命令与打包入口见[开发指南](DEVELOPMENT.md#checks)。浏览器夹具用于验证布局与交互，真实执行、落盘和 Run 以原生证据为准。
