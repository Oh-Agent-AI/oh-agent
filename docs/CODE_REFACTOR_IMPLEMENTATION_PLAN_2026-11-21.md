# Creator Studio V2 / City SDK V3 代码重构实施说明

> 日期：2026-11-21
> 依据：[近期改版代码审核与优化建议](CODE_REVIEW_AND_OPTIMIZATION_2026-11-21.md)、Studio V2 RFC、City SDK V3 RFC r3、City 拆仓优先级 SPEC。
> 基线：`e4f3229c2a636f75be07458e98d8bfdae22fc6cf`。
> 本文是实施计划，不代表以下改动已经完成。本轮未修改实现、未运行测试。

> **范围决策补充**：用户允许忽略历史兼容性。本文第 10 节定义“只支持当前目标合同”的简化实施方案，并优先于正文中 PR-8 的“兼容登记/等待退出条件”流程。该决定不自动授权静默删除当前用户数据库；是否重置存量数据仍应在发布说明中明确。

编辑器的入口迁移、试玩状态和分阶段截图验收由 [Creator Studio 编辑器重构实施说明](CREATOR_STUDIO_EDITOR_REFACTOR_IMPLEMENTATION_2026-11-22.md) 定义，对应本文 PR-3 至 PR-5。

## 1. 实施目标

按小步、可回滚的 PR 完成四个结果：

1. Creator Studio 的 Project / Candidate / Release / Installation / Run 与 StudioTask 边界在代码和 UI 一致。
2. Story 证据从 TS trace 生产到 Rust Host 复算再到持久化/展示可追溯；证据等级不会被前端或缺省值提升。
3. Studio 不再导入 `apps/agent-city` 源码，满足 City 拆仓前置条件。
4. 大模块按领域不变量拆分，事务与兼容语义保持不变；内容默认值、旧协议均有明确所有权与退出条件。

## 2. 非目标与实施约束

- 不重写 City Engine、Creator Studio 或 Game Host。
- 不在一次 PR 中同时更改 wire contract、数据库 schema、UI 流程和模块结构。
- 不为消除重复而抽象出可任意执行 SQL/IPC/业务回调的通用框架。
- 不删除仍承载存量数据迁移的 legacy 读路径；先确认写入口、升级路径与退出条件。
- Rust 代码遵从仓库约定：不运行 `rustfmt`，手工保持周边格式；每次编辑后检查 diff stat 和完整 diff。
- 安全和授权的最终裁决必须留在 Rust Host。UI 的禁用态只是交互提示，不能作为权限边界。

## 3. 目标目录与依赖方向

目录名可在实现 PR 前按仓库惯例微调，但依赖方向应固定：

```text
apps/creator-studio/ui/src/
  app/                         # 路由和布局装配
  features/<domain>/           # UI + feature controller
  application/<use-case>/      # 不依赖 React 的用例编排
  host-api/<domain>/            # Host DTO 解析、command API
  adapters/hostTransport.ts    # transport、关联 ID、错误映射
  contracts/                   # UI view model；wire contract 从 SDK/生成源导入

packages/agent-vitals-city-sdk/src/
  contracts/                   # City 公共 DTO、scope、world/clock 协议
  validate/                    # 纯校验、规范化
  testing/fixtures/             # 跨 TS/Rust parity fixtures 的 TS 消费端

packages/city-game-sdk/src/
  protocol/                     # Game manifest、Rule AST、Replay DTO
  adapters/                    # V1 -> V2 等显式纯转换

packages/agent-vitals-narrative-sdk/src/
  contracts/graph/              # Narrative 包格式和纯图算法

apps/desktop/src-tauri/src/
  creator_projects.rs           # 只保留 dispatch/command 适配
  story_registry.rs             # 稳定 facade
  story_projects.rs             # Story Project CAS/digest
  story_installations.rs        # Installation preview/commit/receipt
  story_runs.rs                 # StoryRun 生命周期和 story_store scope 绑定
  resident_leases.rs            # 公共 Resident 租约及审计
  rule_replay.rs                # Host 复算，不含 MCP/UI 协议适配
  story_store.rs                # Story State/Event/Outbox 事实存储
```

依赖必须单向：

```text
React UI → Studio application → Host API/transport → Rust command → domain service → repository
                                         SDK contracts ↗
City/Game/Narrative SDK → 纯类型与纯计算
City app → City Engine package + SDK
```

禁止：SDK 导入 `apps/**` 或 `crates/**`；Studio 导入 City app 源码；Rust Host 依赖 Studio UI；Narrative SDK 访问 Host DB；插件以 `plugin_request` 或任意 IPC 规避 typed API。

## 4. PR 顺序与验收门槛

### PR-0：冻结基线与验收追踪表

**目的**：建立实施前事实清单，避免重构过程中把已存在行为误删或把报告待办误判为完成。

**交付**

- 新增或更新 V3 验收追踪表：V3-15~23、Studio V2 P0 task、拆仓 AC 各列“代码入口 / Host 状态 / 测试 / 端到端证据 / 缺口”。
- 为以下对象画出 ID、状态、持久化 owner、revision/digest、终止语义：Project、Candidate、Release、Installation、StoryRun、ViewSession、StudioTask。
- 把当前 Host DTO 快照作为合同基线，特别记录安装 preview 的真实字段和 evidence source 的现有枚举/兼容值。

**不可变条件**

- 不改生产逻辑和数据库。
- “有方法/有单测”与“完整链路已验收”分开标记。

**完成门槛**：每个后续 PR 都能指向至少一个明确验收 ID，且没有靠 UI 假数据填补缺失 Host 能力。

### PR-1：Replay 合同与证据等级先行

**目的**：先统一 TS 与 Rust 的 wire contract 和证据可信含义，再实现 trace producer。

**建议改动位置**

- `packages/city-game-sdk/src/protocol/`：定义版本化 `ReplayTraceV1`、`ReplayBindingV1`、`EvidenceSourceV1` 或从现有合同集中扩展。
- `packages/agent-vitals-city-sdk/src/contracts.ts`：只放确属 City 公共身份/时钟的引用，不放 Playtest 的业务 projection。
- Rust DTO 所在的 playtest/replay 模块：镜像 wire schema，并提供严格解析；必要时放共享 fixture 于 `fixtures/`。

**合同字段建议**

```ts
type ReplayBindingV1 = {
  runId: string;
  buildDigest: string;
  ruleSetDigest: string;
  seed: number;
  parameterOverrides: Readonly<Record<string, number>>;
};

type ReplayTraceV1 = {
  schemaVersion: 1;
  binding: ReplayBindingV1;
  events: readonly {
    kind: "zone.entered";
    slot: string;
    eventIndex: number;
    atTick: number;
  }[];
};
```

字段只是建议草案；应复用已有 `runId/buildDigest/seed` 字段，避免第二套命名。`host-verified` 只有在 Host 能验证事件来源及绑定关系时使用；若 Host 只能重放客户端提供的轨迹，应命名为 `host-replayed`，并保留“轨迹由客户端提供”的证据说明。

**步骤**

1. 从 `creator_playtest.rs` 现有落盘结构提取真实字段，形成 schema，不先改字段名。
2. 固定 unknown field、缺字段、错误版本、超预算、digest 不一致的策略：拒绝或保留 client-reported，禁止成功升级。
3. 为 TS/Rust 共用 fixture 定义目录和 runner 消费接口。第一批覆盖 run.started、合法 zone、重复 eventIndex、tick 乱序、未知 slot、参数越界、trace 缺失。
4. 先让现有 TS runtime 与 Rust replay 都通过/拒绝相同 fixture；再接入真实 trace 生产。

**完成门槛**：共享 fixture 的 TS/Rust 结果一致；任一端不支持该 fixture 时失败，不得跳过或默认为成功。

### PR-2：TS Trace Producer 与 Host 复算串联

**目的**：完成 V3-16 的纵向链路，不扩大当前 Rust 支持的事件子集。

**修改位置与职责**

- `packages/city-game-sdk/src/host/` 或 City Game runtime 的现有 input/event 适配层：在权威 Host 事件产生点记录 trace；不在 UI 点击处理器拼接轨迹。
- `apps/desktop/src-tauri/src/creator_playtest.rs`：结算时读取 Run 的冻结 Build、seed、mount overrides 与 trace，形成不可变复算输入。
- `apps/desktop/src-tauri/src/rule_replay.rs`：纯解析与复算，不能访问文件、网络、React DTO 或时间源。

**处理流程**

```text
Host 创建 Run 并冻结 build/digest/seed/overrides
  → Game Host 产生受限输入事件与 ReplayTraceV1
  → finish command 绑定 runId + trace + digest
  → Rust 从 Host 保存的 Run 上下文取期望值并比较请求绑定
  → Rust 复算支持子集
  → 结果写入不可变 evidence（source + verdict + diagnostics）
  → UI 只读展示证据等级和限制
```

**强制规则**

- 不从请求体接受未经核对的 build/rule digest、seed 或参数覆盖值。
- Host 复算失败不能把 outcome 改写成成功；保留客户端结果时标注为 `client-reported` 并记录拒绝原因。
- 相同 `runId` 的重复结算必须幂等；请求内容不同则返回冲突。
- trace 与 Run/Build 不匹配、事件超过上限、tick 超预算、任何不支持节点均不生成 Host 验证结论。
- Host replay 与 TS evaluator 之间的差异只能是有文档记录的 fail-closed 子集，不能存在默默不同的成功语义。

**完成门槛**：至少一个真实 playtest 从事件生产到 evidence 展示走通；负例覆盖缺 trace、跨 Run、digest 替换、Rust 不支持规则、不一致 outcome。

### PR-3：Studio API transport 与领域 API 拆分（纯结构 PR）

**目的**：给后续状态迁移建立可测、稳定的调用边界，不先改变 UI 行为。

**目录建议**

```text
src/adapters/hostTransport.ts
src/host-api/projects.ts
src/host-api/candidates.ts
src/host-api/cities.ts
src/host-api/playtests.ts
src/host-api/stories.ts
src/host-api/agentTasks.ts
```

`hostTransport` 负责 `creatorRequest(method,payload)`、超时/取消、统一错误解析、correlation ID；领域 API 负责 method 名、请求 DTO、响应 parser。feature code 不得散落原始字符串 method 调用。

**迁移顺序**

1. 把现有 `creatorHost.ts` transport 抽成单一实现，保持公开函数签名兼容。
2. 按领域把 method 与 parser 移入 api 模块；不复制 parser。
3. 在 `CreatorStudioApp` 中逐个替换调用，保持请求 payload 与错误展示完全一致。
4. 所有调用切换后，才删除旧 facade 或让 facade 成为重导出层。

**错误/DTO 约定**

- success DTO 要有明确 discriminator 或字段完整性校验；不存在的 `ok` 字段不得由前端臆造。
- 诊断至少区分 blocking/error 与 warning/info；未知错误码展示安全通用文案，并保留可审计 code。
- UI `canSubmit` 只依赖已解析的明确状态；未知/加载中/解析失败均不可提交。

**完成门槛**：命令名、参数、错误码、调用次数和页面行为不变；所有领域 API 可独立 mock，且不依赖 React。

### PR-4：抽离 Creator Studio 用例层与状态 owner

**目的**：将 `CreatorStudioApp` 从业务状态机迁成装配层。

**目标拆分**

- `application/projectWorkflow.ts`：读取/保存/切换 Project、revision 冲突和草稿保留决策。
- `application/candidateWorkflow.ts`：创建 Candidate、预览、接受、正式发布；Candidate 不可变。
- `application/cityLifecycleWorkflow.ts`：City draft、archive preview/commit/restore。
- `application/playtestWorkflow.ts`：start/result/cancel/history、证据读取。
- `application/storyWorkflow.ts`：Story project/install/run 调用与状态解析（未接 UI 的调用保持独立，不伪造页面能力）。
- `application/agentTaskWorkflow.ts`：Task 与既有 job/session ledger 适配；禁止私自另建持久化真相。
- `features/<domain>/use<Domain>Controller.ts`：React hook 将 UI action 映射到用例、管理局部 loading/error state。

**状态归属**

| 状态 | Owner |
|---|---|
| route / 当前工作区 | `app` |
| 项目表单草稿、dirty regions | project feature |
| Candidate 与 Preview 状态 | candidate/playtest feature；Host 持有最终回执 |
| City archive/draft 状态 | city lifecycle feature |
| Story Installation/Run | Host 数据为权威；Story feature 仅缓存展示 |
| Agent Task 持久状态 | 现有 job/session ledger；feature 负责查询与命令 |
| viewport Engine instance | City/preview adapter；不得由 Studio 全局状态创建或销毁 |

**实施技巧**

- 每次只迁一个 feature；先移动纯 parser/model，再移动异步用例，最后收缩 JSX。
- 多步事务用显式 workflow 函数顺序表达，接收依赖对象，不通过全局单例读取状态。
- React effect 仅做订阅/首次读取；用户触发的写操作放在 action handler/workflow。
- 对请求竞态使用 request token 或 AbortSignal，确保旧响应不能覆盖新选择。
- 草稿切换行为要维持当前 `preserve/replace` 语义，拆分中增加显式表单状态测试。

**完成门槛**：`CreatorStudioApp` 不直接调用领域 method、无跨 feature 数据加载逻辑，主要负责 route/布局；各 feature 有独立加载、错误、dirty 和取消语义。

### PR-5：City Engine/SDK 边界包化，清除 Studio 深路径导入

**目的**：完成 City 拆仓前置 S1，并保证平台与 City 内容所有权正确。

**先做消费清单**

从 Studio 源码归类引用：

- `CityEngine` 类型与实例：是否仅需要 preview adapter 的 opaque handle；如需要类型，抽 interface，不向 Studio 暴露 Engine 实现。
- `createCreatorLayoutSnapshot` / `createScopedCreatorLayoutSnapshot`：纯 DTO 适配器归 City SDK 或 city-engine package，确认没有依赖 UI/THREE。
- `CITY_GENERATOR_VERSION` / `PlanPatchV1`：合同/生成器能力版本归 SDK，不从 City app 文件 import。
- `readCityAppearancePreference`：偏好归属 City UI；Studio 通过 app-sdk 能力请求当前展示偏好，或不读取它。

**包边界选择**

- 纯 City schema、确定性适配和 validator → `@oh-agent/city-sdk`。
- Three.js、Canvas、Engine 生命周期与 viewport → `@oh-agent/city-engine`（可信实现包）。
- Miami skin、纹理、flora、模板列表 → City app/skin pack 内容包。
- Host 权限与本地持久化 → Rust Host；SDK 不得代替授权。

**迁移步骤**

1. 建立 package 公共入口与 exports，仅导出必要 API；禁止 deep package imports。
2. 迁移纯 DTO/适配器并为旧调用保留 facade re-export 一个过渡版本。
3. 把 Engine 类型依赖变成 interface 或由 Host 返回的 viewport handle。
4. Studio 全部改为 package import。
5. 增 CI 规则扫描 `apps/creator-studio/**` 中指向 `apps/agent-city/**` 的相对路径，并在包发布 build 中验证无源码目录可用。
6. 移除 facade 中的旧导出，前提是全仓 import 和打包验证通过。

**完成门槛**：Creator Studio UI workspace 的源码与 Vite 配置不需要 `apps/agent-city`；City repo split spec 的其余路径/打包 AC 另行逐项验收。

### PR-6：Story Registry 按事务不变量拆分

**目的**：把 1,073 行模块分成可局部审阅的领域操作，同时保持数据库事务边界。

**建议模块职责**

#### `story_projects.rs`

- `project_create/read/projects_list`。
- graph/canon schema budget、canonical JSON 与 package digest。
- revision CAS 与同内容幂等策略。
- 不直接创建 Installation 或 Run。

#### `story_installations.rs`

- `install_preview/commit/list`。
- 内容 digest、City compatibility/revision、preview TTL、operation receipt、update confirmation。
- 一次 commit 的所有更新在同一 SQLite transaction 内完成。
- 不更改 Story State/Event/Outbox。

#### `story_runs.rs`

- `run_start/stop/reset`。
- 玩家 principal 来源必须 Host 注入，不接受客户端自报 player ID。
- Run 创建与 `StoryStateScopeV1` 初始化/查找要保持一致；若跨表需同库同事务或有可恢复 outbox。
- 关闭/崩溃 StoryViewSession 不等价于 stop Run。

#### `resident_leases.rs`

- acquire/release/expire/list (若确有消费需要)。
- key `(cityId,residentId)` 唯一；owner scope、intent、trace、expiresAt 一致校验。
- 正常完成的事件提交与租约释放同事务；崩溃后惰性过期产生审计事件；释放幂等。
- 不实现 NPC 业务规则或跨 Story 私有记忆读取。

#### `story_registry.rs`

- facade/re-export，仅保留调用兼容；可由 `creator_projects` 调用子模块。
- 不再直接包含 SQL schema、解析 helper 或跨域业务逻辑。

**拆分顺序**

1. 把纯 parser/digest/helper 移出，保留同一个文件模块可见性并跑现有 tests。
2. 按 project、installation、run、lease 顺序迁函数和 SQL；每次只迁一个事务族。
3. 集中 schema migration 到 `story_migrations.rs` 或 repository migration 模块。所有入口调用版本化迁移函数，不在每个业务函数重复建表。
4. 收窄 `pub(crate)`，避免 app modules 直接访问内部 SQL/helper。
5. 最后删 facade 中搬走的实现，不更改 dispatch method 或 MCP schema。

**数据库注意事项**

- schema migration 需要明确版本，不能只依赖 `CREATE TABLE IF NOT EXISTS`；变更有数据搬运时须事务执行。
- SQLite 外键是否开启、约束错误如何映射，要与现有 `creator_store` 一致并显式验证。
- 安装状态与 StoryRun 的生命周期定义需遵守 RFC：disable/uninstall 不删除内容与历史 Run；删除 Project 的策略需另有引用预检。

### PR-7：Creator command dispatch 与领域服务分离

**目的**：阻止 `creator_projects.rs` 继续成为所有 Creator 功能的集中实现文件。

**目标形态**

- dispatch row：method 名、必需/可选字段、handler 引用。
- command adapter：payload parsing、Host principal 注入、DTO 输出。
- domain service：用例与事务规则。
- repository：SQL/文件访问。

dispatch row 仍可集中注册以便审计，但业务函数实现归属相应模块。Story handler 直接调用 `story_projects/installations/runs/resident_leases` facade，不绕回大型项目模块。

**边界验证**

- 任意写方法在统一 Host 授权检查后执行；不能因拆模块形成未保护的新 command。
- 必需字段缺失、未知字段、owner/plugin instance mismatch、权限拒绝都保持现有错误码和 fail-closed 行为。
- method 列表测试覆盖新增和移除操作；参数契约测试不只测 happy path。

### PR-8：Miami 默认与 legacy 清理

**目的**：去除平台对特定 City 内容的隐式依赖，同时保留用户存量偏好与数据。

**Miami 默认迁移**

1. 找到 `skinId` 的新建、保存、读取和 fallback 全链路；确认 `miami-vice` 是用户偏好、City profile 默认还是 Studio 临时默认。
2. 对新项目从 City 配置/已安装 skin catalog 读取默认；无有效 skin 时使用明确的中性默认或要求选择。
3. 对旧项目读取原 `skinId`，不得升级时静默覆盖；未知 skin 显示不可用诊断。
4. 删除 Studio 的 Miami 字面量仅在新旧路径覆盖测试后进行。

**Legacy 清理**

对每条旧路径按以下顺序操作：

1. 登记路径和用户数据来源。
2. 将兼容写入口改为拒绝或明确迁移；先减少新旧数据增长。
3. 运行/离线兼容 fixture 验证迁移可重入、部分损坏时不丢失数据。
4. 等待符合产品升级策略的退出条件；桌面用户可能长时间离线，不能以“线上未观察到”作为唯一依据。
5. 删除代码并保留迁移回滚/备份说明。

不得用全仓 `miami`/`legacy` 字符串零命中作为唯一验收；历史文档、迁移映射、被拒旧输入和测试 fixture 合法包含这些词。

## 5. 横切合同与实现检查清单

### 5.1 DTO 与错误合同

- 每个跨 TS/Rust DTO 有唯一 schema owner 和版本号。
- 可选字段缺失与 `null` 语义明确；unknown enum fail-closed。
- Rust 是权威校验方；TS parser 用于安全展示和交互，不替代 Host 校验。
- 所有持久化写操作包含 operation ID 或可证明的幂等键，以及必要的 expected revision。
- 错误响应包含稳定 code；不能把存储损坏、权限拒绝和 transient unavailable 合并成成功空结果。

### 5.2 事务与对象生命周期

- `CandidateBuild` 不可变；接受后生成/绑定 Release 的行为有明确 digest。
- Installation 是内容与 City 的关系，不把安装当 Project 修改。
- StoryViewSession 的关闭不停止 StoryRun。
- StoryRun reset 创建新 `storyRunId`，旧历史不串入新 scope。
- 同一 Resident 的公共租约冲突有确定排序、trace 和过期回收。
- Preview Fork 不触及正式 City Clock、Story revision、Outbox 或 Run。

### 5.3 安全边界

- grant、player scope、plugin instance、字段范围与预算每次在 Host 校验。
- Agent 工具不接受任意 SQL、路径或调用方提供的通用 IPC method。
- UI 的预检结果仅作展示；commit 在 Host 重新验证 revision、digest、授权与 preview TTL。
- client-reported evidence 永不因字段缺失或 Host 暂不可用自动升为 Host-verified。

## 6. 每个 PR 的工程操作模板

```text
1. 记录起始 commit、工作区状态与本 PR 对应验收 ID。
2. 只修改一个领域边界；合同改动与纯结构移动分开提交。
3. 先新增/调整针对性回归，再迁移实现；不要刷新 golden 来压掉失败。
4. Rust 手工格式；检查 git diff --stat 和完整 diff，确认无无关格式变化。
5. 运行受影响模块的类型检查/单测；整合 PR 跑仓库规定的 parity/CI。
6. 检查调用方、DTO 快照、migration 重入和旧版本数据路径。
7. 更新验收追踪表、兼容登记表和实施报告，标记测试证据级别。
8. PR 描述写明行为/合同变化、回滚方法、数据影响和未覆盖项。
```

此模板描述后续实施应执行的验证，本次撰写文档没有运行这些命令。

## 7. 回滚策略

| PR 类型 | 回滚原则 |
|---|---|
| 纯文件移动/TS API facade | 回滚单个提交即可；在移除旧 facade 前保持兼容 |
| DTO/Rule contract | 新字段先可选并版本化；旧版本继续显式解析；发布后不得复用 schemaVersion 改语义 |
| SQLite migration | 迁移要幂等并支持前向恢复；破坏性 schema 变更需备份/重建策略，不能假定 git 回滚能恢复用户 DB |
| Trace/evidence 行为 | 保留原始 client-reported 事实；新复算列/记录可追加，不覆盖来源事实 |
| Skin/default | 保留用户存储值；只改变新建项目默认；未知旧值显示诊断 |

## 8. 发布顺序建议

推荐先合并 PR-0 至 PR-2，完成证据链 P0；再并行推进 PR-3/PR-5（Studio 调用边界和 package 解耦），随后 PR-4 和 PR-6/7（UI 与 Rust 模块化），最后执行 PR-8 兼容收敛。

如业务上必须先交付 UI 导航，可以先做 PR-3 的 API facade，但不得把 Story/Miami 占位视图表现为已具备独立创作生命周期；未接入时应展示真实状态和明确后续路径。

## 9. 实施完成定义

本轮重构只有同时满足以下条件才算完成：

1. P0 Replay 链路有真实生产 trace、Host 绑定复核、Rust 复算和 UI 证据展示；负向用例证明失败不升级证据。
2. V3 Story 生命周期验收追踪表中每项都标记实现状态和证据，任何未实现能力不以占位成功呈现。
3. Studio 不再导入 City 应用源码，CI 能持续阻止回归。
4. 大模块已按领域事务边界拆开，SQL 不变量和授权顺序可从单一 owner 模块审阅。
5. TS/Rust 合同具备共享 parity fixture；规则版本/失败降级明确。
6. legacy/default 所有路径有迁移和退出策略；Miami 内容不再由平台层隐式选定。
7. 受影响测试、类型检查、Rust lint、相关 golden parity 与目标 bundle 均通过；报告标注实际运行命令与结果。

在上述条件完成前，准确状态应写作“分阶段重构中”，不写“City SDK V3 全链路完成”。

## 10. 无历史兼容性方案：可直接简化的部分与实施边界

### 10.1 决策含义

本方案将“不考虑历史兼容性”解释为：

- 不支持旧版 app 写入的旧 DTO、旧文件布局或旧 SQLite schema。
- 不保留仅供旧 API/旧 SDK 消费者使用的兼容响应、合成身份或双路径读取。
- 当前目标版本的合同和数据库 schema 成为唯一受支持格式。
- 旧版本数据可被拒绝；产品可选择要求用户重置本地数据库。

它**不**表示可以移除当前版本内需要的安全、授权、隔离和事务语义；也不代表可以无提示地删除用户数据。若产品接受重置，应使用可识别的 schema version，在 UI/日志中给出明确恢复或重置指引；不得把旧 schema 当作空数据库继续写入，以免产生部分覆盖和不可诊断损坏。

### 10.2 当前代码中可移除的历史兼容实现

以下候选均有明确代码证据，实际删除前仍须检查目标分支上的全部调用点。

| 代码位置 | 可简化项 | 目标形态 | 不能误删的部分 |
|---|---|---|---|
| `apps/desktop/src-tauri/src/story_store.rs` | `legacy_story_scope()`、`legacy_story_schema()`、`rebuild_legacy_story_tables()`；`StoryCommitCommandV1.story_scope: Option<_>` 与 `None` 合成映射；旧 game-keyed state/read 路径 | `story_scope` 必填；使用显式 `storyId + storyRunId`；数据库 schema 只创建目标列，发现旧 schema 时返回 `schema_version_unsupported` 或要求重置 | CAS、State/Event/Outbox/operation receipt 同一 immediate transaction；四元组 scope 隔离；revision 冲突和幂等检查 |
| `apps/desktop/src-tauri/src/city_runtime.rs` | 生产构造 `StoryCommitCommandV1` 仍传 `story_scope: None` 的桥接 | 从权威 StoryRun/Installation 上下文传入显式 scope；无法确定 scope 时拒绝提交 | Preview Fork、Clock revision 校验、正式状态与 Preview 隔离 |
| `apps/desktop/src-tauri/src/creator_code_game.rs` | `migrate_legacy_preview_request()` 与调用点；旧 `preview-request.json` 单文件队列；`studio_status()` 的无 previewId “最近状态”响应及 `legacyScope`；`take_preview_control()` 的旧全局 control 文件 fallback | Preview request/control/state 全部按 `previewId` 存放；status 必须按 previewId 查询；启动时不扫描/搬运旧文件 | 原子写、preview 容量上限、TTL/终态清理、previewId 隔离、构建完整性与 stop 授权 |
| `apps/desktop/src-tauri/src/creator_projects.rs` | `creator.code.preview.status`/story evidence 的可选 `previewId` 分支与 legacy status fallback（如果调用面确认不再需要） | 要求明确 previewId；无 ID 返回参数错误，不猜测最近 Preview | Host 仍需验证 preview 所属 instance、状态和权限；不得仅依赖 UI 当前选中项 |
| `packages/city-game-sdk/src/protocol/installedGame.ts` | `kind: "legacy-runtime"`、`trustLevel: "legacy"` 旧枚举值（仅当产品决定不再启动这类安装项） | 当前支持的 kind/trust enum 封闭；旧值解析失败并给迁移/卸载诊断 | `local-trusted` 等当前信任等级判定、manifest 权限、签名与 Host grant 校验 |
| `packages/agent-vitals-city-game-runtime/src/interaction.ts` 与 City interaction adapter | 仅为 `legacy-runtime` 保留的注册/launch adapter 和 stub（但需先确认真实 runtime 是否还用该通道） | 只保留真实 code/declarative manifest 支持的启动通道；无实现的 stub 不作为成功路径 | 当前 code-game preview/launch adapter 若仍使用同一类型，必须独立保留其真实通道，不可因名称含 legacy 一并删除 |
| `apps/creator-studio/ui/src/app/CreatorStudioApp.tsx` | `miami-vice` 作为平台 UI 新建表单默认与 fallback | 新项目从 City skin catalog/config 取默认；空 catalog 明确要求选择或中性无主题状态 | 对当前用户已保存的 skin 值，如果“无历史兼容”也包括用户配置，可删除读取；若只放弃旧协议，则仍保留当前格式用户偏好 |

### 10.3 需要区分的“legacy”关键词

搜索命中不能直接等于兼容代码。以下内容不属于旧版本兼容层，不应因本决策自动删除：

- `ruleAstV2.ts` 中 `legacy_rule_operation_unsupported` 等错误码可能描述输入转换拒绝；若仍支持 V1-to-V2 conversion，应作为明确协议边界保留。若全面只支持 V2，则应一次性删掉整个 V1 adapter 和对应错误类型，不留半套转换器。
- `apps/agent-city/ui/src/game/**` 中名为 `legacy` 的碰撞/怪物表现状态，可能是当前游戏资产或行为降级，不是 app schema 兼容。逐个判断生产调用和游戏验收后再处置。
- 资源预算、租约 TTL、最大 trace 条数等常量是当前安全/资源边界，不是历史兼容参数。
- SQL receipts、CAS、幂等键、明确的 Host error DTO 是当前一致性与授权所需，不属于旧版本兼容。
- 测试里“旧格式必须被拒绝”的负向 fixture 可保留；它验证新边界拒绝旧输入，不是运行时继续兼容旧格式。

### 10.4 Story Store 简化步骤

1. 将 `StoryCommitCommandV1.story_scope` 改为必填 `StoryStateScopeV1`，同步所有生产构造器与单测 fixture。
2. 删除 `legacy_story_scope()`，将 `commit_story`、读取、排程读取等旧 API 统一改成显式 `(player, city, story, story_run)` 寻址；移除只接受 `gameId` 的查询函数或改为要求调用者给出显式 scope。
3. 删除 `legacy_story_schema()` 与 `rebuild_legacy_story_tables()`；迁移只接受当前 schema version。若无版本表，先加唯一 `schema_meta` 版本记录；不要用“缺列就猜旧格式并搬表”。
4. 选择发布策略：
   - **保留当前 DB 数据但不兼容旧 schema**：发现版本不符即拒绝启动写入，提供用户备份/重置提示；这需要最小的版本探测，不是旧格式迁移。
   - **接受本地数据清空**：版本不符时提示显式 reset，再创建目标 schema；不得自动删除后静默继续。
5. 将旧数据迁移测试替换为旧 schema 拒绝/重置流程测试；保留目标 schema 下 CAS、重试幂等、跨 Story 隔离、Outbox 原子性测试。
6. 验收 `city_runtime` 所有调用均由当前 StoryRun 提供 scope，不从 `gameId` 推导 story 身份。

### 10.5 Preview IPC 简化步骤

1. 把 request/control/status 的唯一键统一为 `previewId`；将全局队列文件读写移除。
2. `next_preview` 只遍历受限 preview directory 中的 request；无目录/无请求时返回 `None`，损坏 request 作为错误而非回退到旧文件。
3. stop control 只从对应 Preview 的 control 文件读取；同时继续检查 previewId、buildId、runId、requestId 与当前 Host instance。
4. 删除 `studio_status(home)`，命令层要求 `previewId`；MCP/Studio caller 同步更新，任何依赖“最近 Preview”的调用需显式传递其启动回执中的 ID。
5. 删除迁移专用测试，新增“旧全局文件不会被消费”的负向测试，防止旧格式被隐式重新启用。

### 10.6 安装信任级与 interaction runtime 简化步骤

1. 全仓枚举 `InstalledGameV1` 的生产构造和解析点，确认 `legacy-runtime` 是否有非测试消费者。
2. 若 `cityInteractionRuntime.ts` 的 Miami 入口已整体退役，则删除它对应的 legacy catalog、stub adapter 和由 stub 返回成功的 `InteractionRouter.launch` 空壳。
3. 若还有一般性 `legacy-runtime` 用户，不能只删 SDK enum：先迁移这些内容到有真实实现的 code/declarative 通道，或明确停止支持并输出拒绝诊断。
4. 对旧安装记录选择拒绝、卸载提示或显式 reset。`trustLevel: legacy` 绝不能被自动映射为 official/local-trusted；信任不能升级。
5. 测试 unknown/legacy trust 值拒绝，verified current package 正常预置/安装，越权权限仍被 Host 拒绝。

### 10.7 不兼容 schema 的发布与开发策略

无历史兼容的 schema 不应依赖“运行时自动 CREATE IF NOT EXISTS”来掩盖不匹配。推荐每个本地 DB 有当前 schema version：

- 新 DB：一次创建当前 schema 并写入版本。
- 当前版本 DB：正常打开。
- 旧版本/未来版本 DB：返回稳定错误；不进行隐式搬迁或部分写入。
- 显式 reset：备份选项/清楚告知数据范围后删除并重建；该动作应由用户确认或产品明确设置的开发模式策略触发。

若产品决定发布时完全清空本地 DB，可把 reset 设为一次性升级操作，但必须标注会清除哪些数据（项目、City、Story、安装和运行记录等），且不能影响用户外部 harness logs。测试环境可使用临时 DB 自动重建，生产环境不得复用测试策略。

### 10.8 简化后的 PR 顺序

建议将正文 PR-8 提前，并把兼容清理与目标合同收敛合并为以下顺序：

1. **PR-A 合同切换**：Replay/Story scope/Preview ID/InstalledGame enum 统一为当前格式；编译失败点可作为尚存调用的清单。
2. **PR-B Host current-only 实现**：删除 Story scope 合成、旧 Preview 文件迁移、status 无 ID fallback；旧 schema 明确拒绝或显式 reset。
3. **PR-C 调用面更新**：更新 Studio、MCP、City runtime 所有 caller；旧 method/旧 DTO 移除，不留兼容 facade。
4. **PR-D 负向拒绝验证**：验证旧 schema、旧文件、legacy trust 值和旧 DTO 全部明确失败；当前合同的功能测试通过。
5. **PR-E 结构重构**：再进行 Host API 分域、Creator Studio 用例层拆分和 Story Registry 文件拆分。
6. **PR-F 产品默认清理**：移出 Miami skin 默认，并确定是否保留当前格式的用户偏好。

这样先把系统收敛成一种有效输入，再拆分模块，减少兼容分支与新结构同时变化造成的调试成本。Replay 纵向闭环仍是首要验收，但合同收敛不应提前宣称证据已经端到端可信。

### 10.9 省掉的成本与新增风险

**可省成本**

- Story Store 不再需要读取旧列布局、重建表、合成 story identity。
- Preview 不再维护全局文件与按 previewId 目录的双队列、迁移时序及并行状态查询。
- 不必维持旧 DTO/方法的 `Option` 字段、fallback parser、兼容 adapter 和双份测试。
- schema 变更路径更短，模块可直接围绕目标 contract 实现。

**接受的风险/代价**

- 旧版本数据库和旧 Preview 请求不能继续使用；如果无重置入口，用户可能需要手工删除 app data。
- 当前存量 Story data 若 scope 尚未具备，不会被自动映射；数据可能丢失或无法读取。
- 旧安装记录可能不能启动，需要重新安装当前包。
- 删除 fallback 会暴露所有尚未迁移的 caller；这是预期的 compile/test failure 清单，不能用新 fallback 再补回去。

### 10.10 无历史兼容模式验收清单

- [ ] `StoryCommitCommandV1` 所有生产调用显式提供 Story/Run scope。
- [ ] Story Store 不含旧 game-keyed 合成寻址或旧表 rebuild。
- [ ] 不兼容 DB schema 在首次写入前被拒绝或走显式 reset 流程。
- [ ] Preview request/control/status 全部按 previewId 寻址；旧全局文件不会被读取。
- [ ] 所有调用方使用带 previewId 的状态命令；无“最近状态”隐式语义。
- [ ] Legacy trust/type 不会自动映射到更高信任级。
- [ ] 当前版本 CAS、幂等、授权、scope 隔离、事务、Replay fail-closed 与 Preview 隔离测试仍存在。
- [ ] 新版本发布说明明确列出不兼容的数据类别和重置方式。
- [ ] 兼容清理后再执行模块拆分，避免重构过程中重新引入 fallback。
