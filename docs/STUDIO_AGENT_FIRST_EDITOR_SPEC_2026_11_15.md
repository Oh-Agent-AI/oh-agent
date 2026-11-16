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
- 操作记录采用 **Activity 时间线语义**（借 T3 Code：工具动作、审批、失败都是时间线条目，不止消息）——Agent 与人在 UI 看到同一条时间线；`status: pending` 的条目允许「接受 ≠ 副作用完成」的异步 settle（对应 T3 的 turn/checkpoint 分离）。
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
- 命名对齐 T3 Code 的 command receipt 模式：`operationId` 回执即「命令接受 ≠ 副作用完成」的持久凭据，`creator_operation_status`/`creator_job_status` 是 receipt 查询面——既有实现已具备，本规格只是显式命名。

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

远景切片（借 T3 Code 模式，见 §9）：E7 多端监视与审批（桌面/手机/网页同为宿主瘦客户端，从手机批准一次 fly 试玩断点）；E8 Agent 交接摘要（结构化创作线交接，含 delta 语义）；E9 Creator MCP 工具面 evals（Agent 行为回归评测集，随工具演进）。

## 6. 明确不做

- 不开放任意文件写入、shell、脚本执行、任意 geometry/坐标（维持全部既有禁令）。
- 不做同一 City 的并发写入或多写者（单写者权威 + 串行 revision 是正确性边界）。
- 不做云同步、遥测、payload 上报（数据政策不变）。
- 不做第三方 Agent 身份体系（agentId 是声明式标识，不是认证）——授权仍按既有宿主规则。
- 不承诺跨 Agent 的冲突合并（同城并发写入以 CAS 拒绝并要求重读，不做 OTA 合并）。

## 7. 完成定义

「Agent 优先的 Agent 编辑器」完成 = Agent 仅凭 MCP（无人在场、UI 关闭）完成一次完整创作闭环并把全部证据留在会话/作业记录中；人在 UI 上看到的是同一场工作的只读监视视图；每一步失败都有指向下一步的结构化建议。E1–E6 全部通过时达成。

## 8. 代码设计

### 8.1 持久化（creator_store.rs 迁移链，CREATE TABLE IF NOT EXISTS + PRAGMA table_info 列探测）

```sql
CREATE TABLE IF NOT EXISTS creator_sessions (
  session_id TEXT PRIMARY KEY,          -- "csession-<hex>"
  agent_id TEXT NOT NULL,               -- 声明式标识（非认证）
  scope_project_id TEXT, scope_city_id TEXT,
  state TEXT NOT NULL,                  -- open | closed
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS creator_session_operations (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL,                   -- preview | commit | job
  ref TEXT NOT NULL,                    -- previewId / operationId / jobId
  status TEXT NOT NULL,                 -- pending | ready | failed | expired
  summary TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS creator_jobs (
  job_id TEXT PRIMARY KEY,              -- "cjob-<hex>"
  kind TEXT NOT NULL,                   -- layout-build | world-apply | playtest | capture
  status TEXT NOT NULL,                 -- queued | running | ready | failed | cancelled
  subject_json TEXT NOT NULL,           -- {cityId?, projectId?, releaseId?}
  progress_json TEXT NOT NULL,          -- {tick?, total?, stage}
  failure_json TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
  session_id TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
```

保留策略：`closed` 会话 7 天后清理；终态作业 24 小时后清理（沿 creator_city_diagnostics 的淘汰模式）；活跃预览/试玩的既有 TTL 不变——会话表只引用，不接管它们的过期语义。

### 8.2 city-sdk 契约（新文件 `src/creatorSession.ts`，index 导出）

- 类型与校验器：`validateCreatorSessionV1`（exact-keys、sessionId/agentId 标识符、operations ≤200）、`validateCreatorJobV1`（kind 白名单、status 状态机合法迁移）、`validateRecoverySuggestionsV1`（≤8 条、tool 必须在已注册工具集内——由生成产物核对）。
- 预算常量：`CREATOR_SESSION_LIMITS_V1 = { maxOperations: 200, maxRecoveries: 8, maxSessionsPerAgent: 4 }`。
- gameTypes 投影扩展：`playtestSupported` 与 `runtimeStatus` 的**数据源约定**——app 侧 registry 的真实注册状态（city-game-runtime registry + app adapter 就绪位）经生成链写入 capabilities.json；生成脚本从 app 导出的注册清单读取，SDK 不自行推断。

### 8.3 Rust 模块布局

| 模块 | 职责 |
|---|---|
| `creator_sessions.rs`（新） | 会话生命周期（open/status/close，agentId 维度重放）、未决操作登记（预览签发/提交/作业创建时同步登记）、FIFO 淘汰 |
| `creator_jobs.rs`（新） | 作业注册表 + 状态机 + 取消位；把既有孤立状态源接入：layout-build→view_status、world-apply→edit_commit 后的布局重建、playtest→playtest_runs、capture→capture 链 |
| `creator_cities.rs` | 阶段 2 锚点宿主逻辑（沿用 S2b/S4 模式：结构闸 + CAS + 幂等） |
| `creator_projects.rs` | 阶段 1 vehicle（已就位）+ 阶段 4 发布冻结（release 快照携带 gameType/vehicleId/runtimeContractVersion/mountCount/playtestReady；发布闸：无 vehicle/无 mount/覆盖缺失/运行时缺失 → 拒绝） |
| `creator_playtest.rs` | `start_playtest_with_game_type` 已就位；接上 dispatch 行后生效 |
| `plugin_host.rs` | 新方法的白名单/预算/实例绑定（沿 creator.vehicle.* 模式） |
| dispatch | `dispatch_city_runtime` 新增 session/job/anchor 分支（exact_payload 模式） |

### 8.4 语义校验的 headless 三分法（E5 关键决策）

现状：语义校验信封来自 Studio webview（TS）；无 webview 时宿主只有结构硬闸。三条路径：

1. **结构完备子集（首选首片）**：vehicle/world/anchor 的语义已完全可由生成产物表达（键/范围/枚举）——这些方法 headless 直接可用（`validation: "structural"` 标记）。scene/game（SceneDraft/MiniGamePack 语义）不在此列。
2. **city-sdk WASM 嵌入（目标态）**：仓库已有 `crates/agent-vitals-wasm`（wasm-pack 产物就绪）。把 city-sdk 校验器编译进宿主可执行 WASM，headless 下运行完整语义校验——校验逻辑仍单源 city-sdk，宿主只是新运行时载体。需先验证 wasm 产物的确定性与体积预算。
3. **延迟语义校验（过渡）**：headless 接受载荷但标记 `semantic: "deferred"`，**不可 commit**；Studio 打开后补验通过才放行 commit。仅作为 1→2 的过渡桥，不得长期存在。

### 8.5 MCP 工具 schema（冻结草案，7 个新工具；additionalProperties:false 全程）

```jsonc
creator_session_open   { agentId, projectId?, cityId? } → { sessionId, pending: SessionOperationV1[] }
creator_session_status { sessionId } → { state, operations[], jobs[] }
creator_session_close  { sessionId } → { cleared: n }
creator_job_list       { sessionId?, kind? } → { jobs: CreatorJobV1[] }
creator_job_status     { jobId } → CreatorJobV1 + failure.next?
creator_job_wait       { jobId, timeoutMs? } → CreatorJobV1（阻塞至终态或超时）
creator_game_type_list { status? } → { gameTypes: [{ id, template, runtime, contractVersion, playtestSupported, runtimeStatus }] }
```

只读工具（list/status/game_type_list）离线可用（与 capabilities 同策略）；`job_wait` 阻塞上限 30 s（超时返回 running 快照，非错误）。

### 8.6 新错误码

`creator_session_not_found`、`creator_session_closed`、`creator_session_limit_exceeded`、`creator_job_not_found`、`creator_job_not_cancellable`、`creator_job_wait_timeout`、`creator_publish_blocked_no_vehicle`、`creator_publish_blocked_no_mount`、`creator_publish_blocked_slot_coverage`、`creator_publish_blocked_runtime_missing`（全部带 recoveries 建议，见 §3.3）。

### 8.7 测试映射

| 切片 | 测试位置 |
|---|---|
| E1 | creator_sessions.rs tests（open/replay/close/淘汰/多 agent 隔离）+ MCP 注册守卫 + sdk creatorSession 校验测试 |
| E2 | creator_jobs.rs tests（状态机迁移/取消安全点/wait 超时/跨项目并行）+ 与既有 view_status/playtest_runs 的对账测试 |
| E3 | capabilities 生成锁步（recoveries 段）+ 抽样错误码 `next` 断言（Rust）+ Studio UI 同源展示测试 |
| E4 | gameTypes 投影锁步（app registry 状态 → capabilities.json）+ planned 类型拒试玩断言 |
| E5 | headless 三分法：结构子集放行矩阵 + WASM 语义对齐测试（与 TS 侧同输入同诊断）+ deferred 不可 commit 断言 |
| E6 | 端到端脚本 `scripts/verify-creator-flight-e2e.mjs`（7 步 MCP 调用 → 证据 JSON：projectId/releaseId/调用记录/两份轨迹摘要与差异） |

### 8.8 作业状态机

```text
queued → running → ready | failed | cancelled
        running → queued（仅 layout-build：radius 校准重试既有语义）
取消：queued/running 置 cancel_requested → 引擎安全点确认 → cancelled；终态不可迁移
```


## 9. 参考实现研究：T3 Code（pingdotgg/t3code，MIT）

> 引用级逐维对比（含行号出处与判定汇总）见 [T3 Code 对比研究](STUDIO_AGENT_FIRST_T3CODE_COMPARISON_2026_11_15.md)；本节保留结论性映射。

T3 Code 的定位是「coding agents 的开源控制平面」：不内嵌 agent，而是把机器上已有的多个 coding agent（Claude Code/Codex/Cursor/…，经 ACP 可插拔协议）统一驱动，一个 server、桌面/手机/网页三端同线程。它与 Studio 的方向同构——**agent 是主要工作者，编辑器是控制平面**——其开源架构是本规格最直接的外部参照。

### 9.1 模式映射（借用 → Studio 落点）

| T3 Code 模式 | Studio 落点 | 取舍 |
|---|---|---|
| 「执行留在拥有 workspace 的环境；客户端永不替代环境的文件系统/凭据/机器状态」 | §1 宿主权威三面分离——既有 mailbox 架构正是此原则 | ✅ 已一致，引用为佐证 |
| Thread 持久化（**agent 进程退出后线程仍在**） | §3.1 CreatorSessionV1 宿主重启重放 | ✅ E1 采纳，语义对齐 |
| Turn / Checkpoint / Activity 时间线（接受 ≠ settle） | §3.1 Activity 语义 + `operation_status` receipt | ✅ 已吸收 |
| Command receipt + Outbox effect（副作用随事件提交） | `operationId` 幂等回执（既有）；`creator_job_status` receipt 查询面 | ✅ E2 显式命名 |
| 权限四模式（Supervised/Auto-accept/Auto/Full access，**per-thread**，管理员可封顶） | §3.6 候选：per-session 权限档——创作面默认自主，人可选 Supervised 逐步批准 | 🟡 远景（E7 一并） |
| 每线程独立 git worktree + diff 审阅 + 一键 PR | preview→commit 两段式 + diff 报告已是同一语义（世界是单实例状态机，无 worktree 可开） | ✅ 已等价，无需新增 |
| 桌面/手机/网页三端同线程 + 手机批准 | E7 多端监视与审批（远景） | 🟡 E7 |
| ACP 可插拔 agent 协议；「Capabilities must describe what the provider can actually do」（能力边界拒绝越权操作，如 checkpoint 拒绝 revert 碰文件） | 能力目录只列已实现 + 缺失能力明确报错——同一原则，引用为外部先例 | ✅ 已一致 |
| 订阅按需推送（看一个线程不付全部线程历史；socket 认证 ≠ 全方法授权） | 会话/作业查询有界返回（既有 exact_payload/预算模式） | ✅ 已一致 |
| Context handoffs（provider 间/fork 交接的可移植文本摘要，240 字符压缩 + delta 语义） | E8 Agent 交接摘要（远景）：多 agent 接手同一条创作线时传递结构化摘要 | 🟡 E8 |
| `evals/` 目录（agent 产品自带行为评测） | E9 Creator MCP 工具面 evals | 🟡 E9 |

### 9.2 拒绝的模式（与既有边界冲突）

- **多 provider 通用化**：T3 的价值在统一任意 agent；Studio 的权威宿主唯一（City 宿主服务），不存在「换一个 provider」的语义。agentId 保持声明式标识，不引入 provider 认证体系。
- **通用 shell/文件系统暴露**：T3 的 Full access 模式允许任意命令与文件编辑；Studio 的全部写接口保持 typed/CAS/预算——数据政策与单写者边界不因控制平面化而放宽。
- **客户端自带凭据/状态**：T3 明确禁止，Studio 同——引用为佐证。

### 9.3 对既有切片的修正

- §3.1 的 operations 语义升级为 Activity 时间线（已并入上文）。
- §5 新增远景 E7/E8/E9（见上）；E1–E6 不变。
- 参照 T3 的纪律：性能被视为产品特性（掉帧即 bug）——Studio 的 capture/视口预算分层（边界收口记录 §4）同理，预算数字变更必须走守卫测试。

## 10. Agent-friendliness 度量与演进（2026-11-16，吸收外部评审）

### 10.1 度量表（目标指标，非当前实测）

E9 evals 提供**事故回归用例**（防劣化）；本表提供**目标度量**（测成功）——两者共用同一判分脚手架（`evals/creator/run.mjs`），metric 模式按 E6 闭环脚本的 `evidence.json` 聚合统计。

| 指标 | 建议验收目标 |
|---|---|
| Agent 自主完成率 | 目标任务中 ≥90% 无需人工补操作 |
| 错误自动恢复率 | 常见可恢复错误 ≥80% 经 recoveries 建议自主修复 |
| 工具调用成功率 | 合法输入下 ≥95% |
| 断线恢复 | 重连后一次调用找回全部未决任务 |
| Headless 测试覆盖 | 全部声明可无头运行的游戏类型 |
| 确定性重放 | 固定版本、输入与 seed，结果逐位一致 |
| 人工审批次数 | 只在真实授权与敏感操作边界出现 |

### 10.2 语义化世界模型与模块拆分（P1 演进项）

- 建筑/道路/检查点/车辆/游戏实例应是带**稳定 ID、引用与 revision** 的语义实体——锚点/挂载/飞行器已类型化；会话建筑目前是渲染器内部对象 + descriptor 授权的 typed DTO 投影，语义化是下一层（沿用锚点接口的「可查询合法集合」模式，例如「列出合法 fly 检查点锚点」）。
- CityEngine.ts（~145 KB）与 Studio main.tsx（~114 KB）按状态、命令处理、领域规则、UI 组合、生命周期分层拆分；每个模块配套 AGENTS.md 说明、最小运行示例与针对性验证命令。

### 10.3 单一 Schema 派生补全

生成链已覆盖 capabilities/worlds/vehicles/templates 四类产物 + 锁步守卫；**错误码表与 MCP 文档仍是手动同步**（已人工核对一次）。演进为从同一描述符生成错误码文档与 recoveries 速查表，消除第三处手动同步点。

## 11. W1 spike：city-sdk WASM 语义闸进宿主（工具链验证）

### 11.1 机制

语义闸（city-sdk 纯校验器）目前物理运行在 Studio webview；headless 档只能走结构子集 + 延迟桥。WASM 嵌入把**同一份 TS 校验器**编译为 WASM 模块在宿主进程内执行：TS 源 → 打包（只含校验入口）→ JS-in-WASM 工具链（Javy 式：内嵌 QuickJS 编译为 .wasm，宿主经 wasmtime/wasmer 调用，JSON 进出）→ 宿主自签发与 Studio 同源的语义信封。

### 11.2 信任模型声明（如实）

- 语义**权威**是 city-sdk 的版本化产物（digest 钉进构建锁文件、可审计），不是 Studio 这个 app——把载体从 webview 换成宿主内 WASM 不改变校验逻辑本身。
- 双门独立性从「跨进程」弱化为「同进程内两个独立校验器」；缓解 = 产物锁步（同一输入 TS 与 WASM 必须逐位同诊断）+ 产物 digest 钉住 + 宿主结构闸独立保留。

### 11.3 spike 范围与验收

- 只编 `validateVehicleProfileV1` 单校验器（preset/越界/非物理比值至少各一例）跑通「TS 与 WASM 同输入同诊断」；通过后另立全量项目。
- 产物体积与冷启动延迟如实记录；网络不可用时以 `quickjs-emscripten`（Node 侧 WASM QuickJS）证明「同一诊断在 WASM 承载的 JS 运行时中成立」，宿主侧 wasmtime 集成留作后续。
