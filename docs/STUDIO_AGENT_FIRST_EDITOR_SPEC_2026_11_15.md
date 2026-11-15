# Studio：Agent 优先的 Agent 编辑器规格（2026-11-15）

状态：设计提案，待实施与验收；2026-11-15。本文定义 Creator Studio 向「Agent 是第一公民创作者」演进的目标形态、差距与切片。文中「现状」以 dev（fc2734d7，42 个 creator MCP 工具）实测为准，标注为目标的条目不代表已实现。

关联：[自定义 City MCP 设计](CREATOR_STUDIO_CUSTOM_CITY_MCP_DESIGN_2026_11_14.md)、[City SDK 内容 MVP](AGENT_CITY_SDK_CONTENT_MVP_SPEC_2026_11_11.md)、[运行时 SDK 架构](CITY_GAME_RUNTIME_SDK_2026_11_15.md)、[世界多样化规格](CITY_WORLD_DIVERSIFICATION_SDK_SPEC_2026_11_15.md)、[资产管理规格](CITY_ASSET_MANAGEMENT_SPEC_2026_11_15.md)、[Creator MCP 接入指南](AGENT_CREATOR_MCP_CLIENT_SETUP.md)、仓库 `AGENTS.md` 数据政策。

## 1. 定位

Creator Studio 有三个用户面，目标态把它们显式分开：

| 用户面 | 角色 | 接口 |
|---|---|---|
| **Agent** | 第一公民创作者：自主完成「世界 → 场景 → 玩法 → 飞行器 → 锚点 → 绑定 → 发布 → 试玩 → 读结果 → 迭代」全闭环 | MCP 工具面（42+ 工具，本规格扩展） |
| **人** | 监督者与审批者：看画面、看诊断、批准数据边界内的敏感动作；随时可接管编辑 | Studio UI |
| **宿主（Rust）** | 权威：身份授权、结构/预算硬闸、revision CAS、原子事务、试玩生命周期 | creator_* 服务 |

原则：

1. **Agent 能做的，人在 UI 也能做；人能做的创作操作，Agent 经 MCP 也能做**——两面共用同一宿主服务与同一校验（UI 不再有 Agent 不可达的私有能力）。
2. **失败必须可诊断、可修复**：每个稳定错误码伴随可执行的下一步建议（由能力目录驱动，不是自由文本发挥）。
3. **任何长作业有状态面**：提交成功 ≠ 完成；生成/渲染/试玩以 `pending/ready/failed` 独立报告，Agent 可轮询，永不需要「等待后重试碰运气」。
4. **创作面 Agent 自主**：本地数据边界内的创建/编辑/发布不需要人逐步批准；人的审批集中在既有数据政策规定的边界（安装、下载、数据授权）——本规格不扩大也不缩小该边界。
5. **边界纪律沿用**：Rust 结构/预算/事务，city-sdk 语义校验，可信 TS 适配器业务语义；性能与启发式推导单源 city-sdk（见边界修正记录：宿主不再推导 vehicle performance）。
6. **能力目录只列已实现**：缺失能力明确报错，不静默替换，不用 schema 测试冒充端到端。

## 2. 现状（实测）与差距

42 个 MCP 工具已覆盖全创作闭环的**指令面**：城市/世界（`creator_city_*` 全套含 `world.set` 能力投影）、项目/场景/玩法（preview→commit 两段式）、飞行器（`creator_vehicle_list/preview/define/inspect`）、空域锚点（`creator_city_anchor_list/upsert/remove`，布局快照 v3 序列化锚点几何）、类型化绑定（`creator_mount_bind/unbind/list` + `creator_game_bind_preview`）、发布（冻结 `gameType`，`gameType` 断言式校验、mismatch fail-closed）、试玩（`creator_playtest_start/result/cancel/history`，按 gameType 分派，flight HUD 进度面）、能力发现（`creator_capabilities_list` 含 gameTypes/worlds/预算/范围）。

按「Agent 自主闭环」标准，七个差距：

| # | 差距 | 影响 |
|---|---|---|
| G1 | **宿主前台依赖**：mailbox 机制要求 Studio 插件打开、City 插件前台才能试玩 | Agent 无法独立开始工作；夜间/无人值守场景不可用 |
| G2 | **单活动试玩槽 + 串行 revision 链** | 多 Agent/多任务并行不可能；一次只能推进一条创作线 |
| G3 | **诊断不闭环**：有界诊断有错误码，但无「下一步该调哪个工具、传什么」的结构化建议 | Agent 遇错后只能盲试或交给人 |
| G4 | **可玩性判别缺失**：capabilities 的 gameTypes 无 `playtestSupported/runtimeStatus` 字段，Agent 分不清「模板存在」与「可试玩」 | 会定义不可玩的类型并卡死 |
| G5 | **端到端验收未记录**：全链路（双飞行器轨迹分叉）从未以 MCP 记录形式跑通并留证 | 「工具都在」≠「闭环可用」 |
| G6 | **会话无状态**：Agent 断线重连后，活跃预览/作业/上下文需要自己重新发现（`operation_status` 是孤立的点查询） | 长任务中断即上下文丢失 |
| G7 | **长作业无统一作业面**：布局生成、世界重建、试玩各有孤立的状态查询（view_status/playtest_result），无统一「我的作业」视图 | Agent 需要记住每个作业的查询方式 |

## 3. 核心设计

### 3.1 Creator 会话（CreatorSessionV1）——Agent 上下文成为一等对象

```ts
type CreatorSessionV1 = Readonly<{
  sessionId: string;                     // "csession-…"
  agentId: string;                       // 调用方声明；同 id 重连恢复
  openedAtMs: number;
  scope: Readonly<{ projectId?: string; cityId?: string }>;   // 意图聚焦，可空
  operations: readonly SessionOperationV1[];                  // 本会话发起的预览/提交/作业（有界，≤200，FIFO 淘汰）
}>;
type SessionOperationV1 = Readonly<{
  kind: "preview" | "commit" | "job";
  ref: string;                           // previewId / operationId / jobId
  status: "pending" | "ready" | "failed" | "expired";
  summary: string;                       // 一行人类可读摘要
}>;
```

- 新工具 `creator_session_open`（operationId 幂等）/ `creator_session_status` / `creator_session_close`：打开时返回未决操作列表（活跃预览、进行中作业），Agent 断线重连**一次调用恢复全部上下文**。
- 会话是**有界的视图记录**，不是权限容器：能力与授权仍按既有规则逐请求核对。会话不持久化任何用户数据新增面（摘要与 ID 仅此而已）。
- 关闭语义：显式 close 淘汰未决预览（沿用 preview TTL 兜底）；宿主重启后会话按 agentId 重放未决引用。

### 3.2 统一作业面（Job）——消灭 G2/G7 的孤立查询

```ts
type CreatorJobV1 = Readonly<{
  jobId: string; kind: "layout-build" | "world-apply" | "playtest" | "capture";
  status: "queued" | "running" | "ready" | "failed";
  subject: Readonly<{ cityId?: string; projectId?: string; releaseId?: string }>;
  progress: Readonly<{ tick?: number; total?: number; stage: string }>;
  failure?: Readonly<{ code: string; message: string; next?: string }>;
}>;
```

- 布局生成/世界重建/试玩/捕获统一注册为作业；`creator_job_list { sessionId? }` / `creator_job_status { jobId }` / `creator_job_wait { jobId, timeoutMs? }`（阻塞等待完成，替代盲目轮询）。
- 单活动试玩槽**维持不变**（City 是单实例状态机，这是既有设计）；并行的意义改为：**不同项目/城市的创作线可并行**（世界编辑作业与另一项目的试玩互不占用），同一城市的写入仍走串行 revision 链。
- 长作业可取消（沿用试玩 cancel 的既有语义），取消是协作式——引擎在安全点检查取消位。

### 3.3 诊断闭环——每个错误码带「下一步」

- 能力投影新增 `recoveries` 段：`{ code → next: { tool, args 模板, 说明 } }`，由生成链单一来源产出（与 worlds/gameTypes 同模式），Rust include_str! 消费并在错误响应的 `next` 字段返回。
- 例：`creator_layout_not_ready` → next = `creator_city_view_status {cityId}`；`creator_playtest_not_claimed` → next = `creator_playtest_start`；`revision_conflict` → next = `creator_project_read {projectId}` 后重开预览。
- Studio UI 同源展示（人与 Agent 看到同一份建议），诊断不再只有错误码。
- `creator_city_diagnostics` 保留（历史事件查询），与 recoveries 互补：一个看过去，一个指下一步。

### 3.4 可玩性判别与运行时状态——消灭 G4

- `creator_capabilities_list` 的 `gameTypes` 段增加 `playtestSupported: boolean` 与 `runtimeStatus: "ready" | "prototype" | "planned"`（数据源：app 侧 registry 的真实注册状态经生成链投影，锁步测试钉住）。
- `creator_game_type_list { status? }` 作为独立只读工具（过滤视图），Agent 一目了然「模板存在 ≠ 可试玩」。

### 3.5 运行形态：headless 优先（消灭 G1 的主路径）

- 已有起点：`6502871b` headless game-control MCP（Agent playtesting 的执行面）。
- 目标态分三档：
  1. **headless 宿主**：`data-mcp serve` 模式下宿主服务（城市/项目/试玩生命周期）无需 Studio UI 打开即可工作；City 渲染/视口/capture 等**需要画面**的能力明确降级为 `creator_capture_unavailable` 类错误并指向替代（结构校验、无头规则运行、headless game-control）。
  2. **有头可选**：UI 打开时全部能力可用（现状不变）。
  3. **试玩分档**：headless 规则试玩（固定事件序列、无画面）与可视试玩（真实输入、HUD）分别标注 `playtestSupported` 的两个维度；Agent 按需选择。
- 隔离要求沿用：headless 不放宽任何数据授权；`AGENTS.md` 数据政策不变。

### 3.6 人在环

- 人的 UI 增加的不是「批准按钮墙」，而是**会话监视器**：看 Agent 会话的操作流、作业状态、诊断与建议；接管 = 用 UI 做同样的编辑操作（同一服务）。
- 需要人审批的仍只有数据政策边界内的动作（安装/下载/数据授权）——创作闭环内 Agent 自主。

## 4. 与通用 Agent 环境（ZCode 类）的关系——借用模式，不做通用化

| 通用环境模式 | Studio 对应物 | 取舍 |
|---|---|---|
| worktrees（并行工作线） | 多 City/多项目天然隔离 + 单城串行 revision（维持） | 不做创作线分支——世界是单实例状态机 |
| 后台 subagents | 统一作业面（§3.2）+ 会话内多作业 | 同城写入仍串行 |
| 自由 shell 迭代 | 结构化诊断 + recoveries + 无头试玩 | 通用 shell 永不开放 |
| 断线恢复（WIP 提交） | 会话重放 + 预览 TTL + operation_status | 已大半具备，补会话视图 |
| 全文件读写 | typed 接口面 | 永不开放（数据政策） |

结论：完整性目标**不是**向通用 agent 环境看齐，而是「Agent 在领域接口内自主闭环率 → 100%」。

## 5. 实施切片与验收

| 切片 | 交付 | 验收 |
|---|---|---|
| E1 | 会话三工具 + 未决操作视图 | 断线重连一次调用恢复全部上下文；宿主重启重放；会话数据零用户数据新增面 |
| E2 | 统一作业面（布局/世界/试玩/捕获注册为 Job）+ wait/取消 | Agent 用 job_wait 完成「提交→新布局 ready→试玩」无轮询盲等；取消在安全点生效 |
| E3 | recoveries 段进能力生成链 + 错误响应 `next` 字段 | 抽样错误码全带可执行建议；Studio UI 同源展示；锁步守卫 |
| E4 | gameTypes 增 playtestSupported/runtimeStatus + `creator_game_type_list` | 数据源为 app registry 真实注册状态（锁步）；planned 类型明确不可试玩 |
| E5 | headless 档：宿主服务无 UI 可用 + 能力降级报告 | 无 UI 下完成「创建→编辑→发布→headless 规则试玩→读结果」全闭环；需画面的能力报稳定降级码 |
| E6 | **最小 MCP 端到端验收记录**（消灭 G5） | 按既有 7 步：flight-checkpoint 项目 + 双 vehicle + 3 fly gates + bind + publish + playtest，产出两架飞行器同输入轨迹分叉、重放逐位一致的证据文件 |

每切片记录构建版本、工具数量与验收证据；真机桌面验收与无头验收分别记录。E1–E4 纯接口/投影层可先行；E5 需要宿主服务改造；E6 在 E1–E5 之上执行。

## 6. 明确不做

- 不开放任意文件写入、shell、脚本执行、任意 geometry/坐标（维持全部既有禁令）。
- 不做同一 City 的并发写入或多写者（单写者权威 + 串行 revision 是正确性边界）。
- 不做云同步、遥测、payload 上报（数据政策不变）。
- 不做第三方 Agent 身份体系（agentId 是声明式标识，不是认证）——授权仍按既有宿主规则。
- 不承诺跨 Agent 的冲突合并（同城并发写入以 CAS 拒绝并要求重读，不做 OTA 合并）。

## 7. 完成定义

「Agent 优先的 Agent 编辑器」完成 = Agent 仅凭 MCP（无人在场、UI 关闭）完成一次完整创作闭环并把全部证据留在会话/作业记录中；人在 UI 上看到的是同一场工作的只读监视视图；每一步失败都有指向下一步的结构化建议。E1–E6 全部通过时达成。
