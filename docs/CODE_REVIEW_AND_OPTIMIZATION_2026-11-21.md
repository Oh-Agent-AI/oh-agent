# 近期改版代码审核与优化建议

> 日期：2026-11-21  
> 审核基线：当前工作区 `e4f3229c2a636f75be07458e98d8bfdae22fc6cf`（`merge city-sdk-v3 into dev`）  
> 需求依据：`OH_AGENT_CREATOR_STUDIO_V2_PRD_RFC_2026-11-20.md`、`OH_AGENT_CITY_SDK_V3_INTEGRATION_RFC_2026-11-19.md`、`CITY_BUILTIN_GAMES_SDK_MIGRATION_SPEC_2026-11-19.md`、`CITY_REPO_SPLIT_PRIORITY_SPEC_2026-11-19.md`、`V3_IMPLEMENTATION_REPORT_2026-11-21.md`  
> 性质：静态代码与需求对照；未修改实现，未运行测试或打包。

## 1. 执行摘要

近期改版的总体方向合理：Studio 正从资源管理页面转为作品工作台；City/Game/Story 的生命周期开始显式化；V3 将共享协议、宿主权威状态和可选 Narrative 能力分层；桌面 Rust Host 开始承担 Story Registry 与规则复算。

当前主要风险不是“缺少更多抽象”，而是**设计目标、代码模块和可验收链路尚未完全对齐**：

1. Creator Studio 新入口已经组件化，但入口文件仍约 1,102 行，并继续直接导入 `apps/agent-city` 源码，与 Creator Studio 解耦及 City 拆仓前置目标冲突。
2. TS 与 Rust 的规则语义需要双端一致；目前 Rust `rule_replay` 是 TS runtime 的手工镜像子集，存在语义漂移风险，且实施报告承认 TS trace 生产端仍未完成。
3. Story Registry 已有项目、安装、Run 和 Resident 租约实现入口，但其 1,073 行文件承载多个生命周期；Story 创作、安装、运行是否在 Studio UI 完成端到端闭环，需要与 RFC 验收逐项对齐。
4. 当前代码保留多个 `legacy` 兼容路径。兼容本身并非问题，问题在于每条路径应有明确的数据迁移完成条件、调用面收敛和删除时点。
5. 硬编码默认项仍可见，例如 Studio 默认皮肤 `miami-vice`。这与“内容与平台解耦、Miami 主题外置为数据”的目标存在直接张力，应区分暂时的模板默认值和平台层内容耦合。

建议按“合同与证据 → 主链路闭环 → 依赖方向 → 模块拆分 → 兼容清理”的顺序推进。不要先大规模改名或机械拆文件。

## 2. 审核范围与判定口径

### 2.1 本次覆盖

- 当前提交与近期设计文档的差异概览。
- Creator Studio V2 的 UI、Host Bridge、项目/候选/Agent 工作流边界。
- City SDK V3 的 Story 生命周期、规则 AST/Replay 和 Host 权威性。
- City 拆仓前置约束，特别是跨应用源码引用。
- 代表性大文件、硬编码默认值、legacy 兼容入口与职责归属。

### 2.2 未覆盖

- 未逐函数审完全仓，也未进行重复代码 AST/语义相似度扫描。
- 未验证所有 UI 页面在打包应用中的实际行为。
- 未运行单测、类型检查、Clippy、CI 或 bundle build。
- 行数是代码规模信号，不直接等于缺陷；建议拆分前必须确认职责和调用边界。

### 2.3 严重度

- **P0**：阻断近期改版核心承诺或会造成错误可信度/跨作用域数据行为。
- **P1**：形成明确架构债务，影响关键路径演进、回归风险或拆仓前置。
- **P2**：可维护性、可读性、迁移治理问题，宜按迭代处理。
- **观察项**：现有材料不足以认定缺陷，需补运行或全链路证据。

## 3. 需求到实现的对照

| 需求 | 当前证据 | 审核判断 |
|---|---|---|
| Studio 以 Project 为中心，Candidate/Release/Installation/Run 分离 | 新增 `contracts/`、`features/project/`、`features/city/`；Host 增加 City archive/draft 与 Candidate API | 方向已进入代码；应继续验证 UI 是否始终区分可编辑项目与不可变构建、安装关系和运行事实 |
| Agent 是持续协作者，任务有持久化和审批证据 | 新增 `useStudioTasks`、Agent 面板；Host bridge 捕获 Agent 调用；MCP creator 域新增 Studio/Story 方法 | 不能仅凭面板和调用方法确认任务恢复、状态权威和审批闭环；实施报告指出 task ledger 需扩展现有 job/session 系统而非平行建设 |
| Story Project/Installation/Run/ViewSession 分开 | `story_registry.rs` 建立项目、安装、运行和租约表；`story_store.rs` 保持事实状态 | 结构方向与 RFC 一致；ViewSession 不单独持久化是当前设计选择，应验证崩溃时只关闭视图、不终止 Run 的真实调用路径 |
| Host 对规则裁决有权威性 | `rule_replay.rs` 在 Host 侧复算受限规则子集；`creator_playtest.rs` 负责结算集成 | 存在 Host 复算实现，但接受范围受子集限制；任何不支持形状必须保持 fail-closed，证据必须区分 client-reported / host-verified |
| ReplayEvent/trace 来源可信、可复算 | V3 实施报告明确记载 TS 侧 trace 生产未实现 | P0 闭环缺口：复算器存在不等于客户端证据生产与端到端链路完成 |
| Narrative SDK 为纯算法与合同，不成为第二个权威 Runtime | `packages/agent-vitals-narrative-sdk` 新增图校验库；未发现其拥有 Host DB 的证据 | 当前方向符合 RFC；仍需以依赖图/包导入检查确保 SDK 不反向依赖应用或 Host |
| Creator Studio 不直接依赖 City 源码，支撑 City 拆仓 | `CreatorStudioApp.tsx`、`useCreatorHostBridge.ts` 仍以 `../../../../agent-city/ui/src/...` 深路径导入 | P1 明确违背拆仓优先级 spec 的前置目标，迁移后会断链或延续跨仓源码耦合 |
| Miami 内容不进入平台层；主题应走数据/skin pack | Studio 仍有 `miami-vice` 默认；其他 City/game SDK 文件尚有 legacy/主题兼容引用 | 先定位所有生产代码引用与资源归属，不能仅靠全局字符串清零掩盖仍有效的旧数据迁移需求 |

## 4. 具体审核发现

### 4.1 P0：Host 复算和 Replay 证据链尚未端到端闭环

**证据**

- `docs/V3_IMPLEMENTATION_REPORT_2026-11-21.md` 的“已知边界”明确写出 TS 侧 trace 产出（按 `ReplayEventV1` 记录 `zone.entered`）未实现。
- `apps/desktop/src-tauri/src/rule_replay.rs` 明确将语义权威指向 `packages/agent-vitals-city-sdk/src/runtime.ts`，并逐语义镜像 TS evaluator 的一个有限子集；目前只接受 `run.started`、`zone.entered`、`timer.expired` 等规定事件，部分 TS 支持事件在 Host 侧直接拒绝。
- 文件注释要求无法复算时返回错误而非猜测，这是正确的安全降级方向，但必须保证调用链没有把失败降级成成功证据。

**风险**

- TS 与 Rust 是两份规则语义实现；规则升级时可能只改一端，导致相同输入产生不同结果。
- 如果缺 trace、无效 trace 或不支持规则形状仍能写入“已验证”表述，会高估结算证据可信度。
- 若 `host-verified` 只表示“复算了客户端提供的有限输入”，而输入本身并非 Host 观测，则命名和用户展示可能过度表达证据强度。

**优化建议**

1. 在 API/存储中把 `evidenceSource` 做成封闭枚举，并定义 `client-reported`、`host-replayed`（或经产品确认的 `host-verified`）的精确定义、输入来源与覆盖范围。
2. TS trace 生成应绑定 `runId/buildDigest/ruleSetDigest/seed/parameterOverrides`，并以不可变结算载荷传给 Host；Host 必须对这些字段做一致性检查。
3. 为两端共享建立版本化 fixture：输入包、trace、期望事件序列、计数器、outcome、拒绝码。每次规则变更要求 TS 与 Rust 对同一 fixture lockstep。
4. 缺失 trace、事件乱序、跨 Run 重放、digest 不匹配、不支持事件或超预算，一律保持未验证/拒绝，不得以空 trace 默认通过。
5. 将报告里“TS trace 生产未实现”列为验收阻塞；补端到端测试后再宣称 V3-16 完成。

### 4.2 P1：Studio 尚未完成拆仓前置解耦

**证据**

- `apps/creator-studio/ui/src/app/CreatorStudioApp.tsx:37-39` 直接导入 City Engine 源码，包括主题偏好、`CityEngine` 类型与 `planPatch`。
- `apps/creator-studio/ui/src/app/useCreatorHostBridge.ts:15-17` 直接导入 `cityLayoutAdapter`、`CityEngine`、`planPatch`。
- City repo split priority spec 把 Creator Studio 相对路径导入 City 源码列为拆仓阻塞项，目标是改为 workspace 包依赖。

**风险**

- Creator Studio 的构建依赖 `apps/agent-city` 的目录布局，City 内容拆仓或目录迁移会破坏 Studio 构建。
- 当前边界允许 Studio 调用 City Engine 类型与适配器，难以区分“需要共享的通用引擎 API”与“应用私有实现”。

**优化建议**

1. 将 Studio 真正需要的 `CityViewport`、layout snapshot adapter、生成器版本及 appearance contract 收敛到稳定 workspace package；平台包只暴露公共类型与明确 API。
2. Studio 不应创建或持有 Engine 实例；引擎/viewport 的装配由 City 应用或预览 Host 提供，Studio 通过能力接口请求显示与快照。
3. 加 CI 静态边界规则，禁止 `apps/creator-studio` 导入 `apps/agent-city/**` 源路径；同时禁止 SDK 包反向导入 apps/crates。
4. 迁移期间先建立公共 package 并保持行为等价，再移除深路径导入；避免一次性“改路径+改协议+改 UI”。

### 4.3 P1：Studio 顶层协调器仍过大，职责拆分尚未结束

**证据**

- `CreatorStudioApp.tsx` 约 1,102 行；模块顶部同时导入合同、各 feature panel、City Engine、内容解析器、Host adapter 等多域依赖。
- 同文件包含项目/City/候选/预览/安装/Agent 多类状态与 Host 请求，例如城市列表加载、存档列表加载、项目 City 读取与场景读取。
- `useCreatorHostBridge.ts` 约 401 行，注册并处理大量不同领域 Host method；虽然集中桥接有利于统一安全入口，但目前仍是一处跨域变更汇聚点。

**风险**

- 新需求容易增加全局状态和 effect 依赖，导致“切页时状态是否保留”“异步请求是否过期”等行为难以局部推理。
- Feature 面板拆分后，业务编排仍聚集在 App，可能只是把 JSX 移出而非把职责移出。
- Bridge 聚合项目、城市、Candidate、Story 等方法，合同变化会导致互相无关的功能一起回归。

**优化建议**

- `CreatorStudioApp` 只保留路由/布局装配；各 feature 提供自己的 controller/hook 和显式状态合同。
- 以用户用例拆 TS 应用层：`projectWorkflow`、`candidateWorkflow`、`cityLifecycleWorkflow`、`storyWorkflow`、`agentTaskWorkflow`。用例编排通过领域 API，不在 React effect 内直接铺开多步事务。
- Bridge 按领域拆模块（projects/city/candidate/story/playtest），共享 transport、错误映射、调用超时与 correlation metadata。
- 将跨页面共享的状态限定到 session/store；表单草稿由对应 feature 所有，离开页面时有明确保留/丢弃语义。
- 拆分时保持行为和命令协议不变，避免同一提交中同时改变状态机与文件结构。

### 4.4 P1：Rust Story Registry 体量与事务边界需要继续收敛

**证据**

- `apps/desktop/src-tauri/src/story_registry.rs` 约 1,073 行，创建 Story 项目、digest 校验、安装预检/提交、Run 生命周期、Resident 活动租约集中在一个模块。
- 模块头注释明确声明其只管理元数据/生命周期，Story 状态事实由 `story_store` 持有。这是有价值的边界，应继续维护。
- `creator_projects.rs` 仍承担命令 dispatch 行与跨域 creator 用例入口，Story wrapper 函数也在其中。

**风险**

- 安装 CAS、包 digest、Run scope 和租约的事务不变量交织，后续改动会增加事务顺序与错误映射回归风险。
- 若 Story Registry 开始直接承载规则执行、Story 事实事件或 Narrative 图推理，会突破当前正确边界并形成第二权威层。

**优化建议**

按稳定领域拆分，而非按 CRUD 函数拆分：

- `story_projects`: 项目 schema、revision CAS、digest。
- `story_installations`: preview/commit/receipt、City revision CAS、更新确认。
- `story_runs`: Run 身份、恢复/停止/重置；与 `story_store` scope 的绑定。
- `resident_leases`: 获取/释放/惰性过期及审计事件。
- `story_registry` facade 只协调公共接口，不包含 SQL 细节。

将 DB transaction 封装在拥有对应不变量的模块内；禁止用跨模块“先写一张表再补写另一张表”的非原子流程。迁移脚本和运行时请求路径分离，避免每次业务读取隐式执行大规模 schema rebuild。

### 4.5 P1：同一规则语义跨 TS/Rust 镜像，缺少自动化单一合同

**证据**

- `rule_replay.rs` 头部说明是对 City SDK `runtime.ts` 的逐语义镜像；它自行定义事件、守卫、动作和预算边界。
- 同一仓库有 `packages/city-game-sdk/src/protocol/ruleAstV2.ts` 新增规则 AST，另有 City SDK V1 runtime 和 Host replay。V1 与 V2 的所有权/采用路径必须明确，避免多套规则协议同时被误认为生产权威。

**优化建议**

1. 建立一份 Rule contract matrix：版本、规范 schema 所在包、TS producer/evaluator、Rust validator/evaluator、适用游戏、兼容适配器、失败降级。
2. 用共享 JSON fixtures 锁住交叉语言语义。避免只用 TS 单测验证 TS、Rust 单测验证 Rust 而没有 parity 检查。
3. 对 schema 解析优先生成 Rust DTO 或从版本化合同生成校验器；即使执行器必须双写，也尽量避免手工重复定义字段和边界。
4. 明确 V1 legacy adapter 到 RuleSetV2 的转换只有一个纯函数，且由 golden fixture 覆盖；不得让业务 UI、Host、SDK 各自做隐式转换。

### 4.6 P1/P2：硬编码默认值需按“平台耦合”与“产品默认”分类治理

**确认的例子**

- `CreatorStudioApp.tsx` 中初始皮肤与表单回退值使用 `miami-vice`（搜索证据；当前代码明确仍有 Miami 命名）。
- 同文件初始模板为 `checkpoint-race`。它可能是合理的新建默认模板，不应自动视为缺陷。
- `story_registry.rs` 中图/Canon 预算、租约 TTL 等常量，是资源安全边界，属于有意策略，不应为了“消除 magic number”改成可被任意调用方调大。

**优化建议**

- 平台层不得选择 Miami 专属 skin 或游戏模板作为隐式唯一默认。将默认 profile 放在 City app 的配置/skin pack，或通过 Host 提供可用模板目录和默认项。
- 所有默认值集中定义在有明确所有权的配置模块，并写明适用范围、版本、是否影响既有数据。
- 安全预算保留为可信端常量或受控配置；前端只能显示，不得成为权威限额。
- 对默认行为建立测试：空配置、新安装、旧配置缺字段各自得到确定结果；未知模板/skin 明确诊断，不静默回退到 Miami。

### 4.7 P2：Legacy 兼容代码需要有生命周期，不可只按关键字清理

**确认的遗留类型**

- `story_store.rs` 将旧 game-keyed 行映射为合成 `storyId/storyRunId`，并继续保留 legacy 读写兼容路径。
- `creator_code_game.rs` 迁移旧 `preview-request.json`，旧状态响应显式标记 `legacyScope`。
- `creator_cities.rs` / `creator_projects.rs` 对旧布局、seed、revision 和旧 envelope 保留兼容/拒绝分支。
- `city-game-sdk` 仍包含 `legacy-runtime` / `legacy` trust 型别；这是历史模型/协议兼容点，是否还在生产路径要另查调用关系。

这些代码可能是升级用户数据所必需，不能仅凭 `legacy` 字样删除。

**优化建议：每条兼容路径登记**

| 字段 | 内容 |
|---|---|
| 旧来源 | schema/API/文件格式与出现版本 |
| 读/写状态 | 只读兼容、一次性迁移、双写、旧 API 接受或拒绝 |
| 迁移动作 | 何时触发、事务性、幂等性、损坏数据处理 |
| 完成条件 | 可通过的计数/观测/版本门槛；离线桌面应用要考虑用户长期不启动 |
| 删除版本 | 最早删除版本及升级/回滚兼容要求 |
| 所属团队/模块 | 谁负责维护及测试 |

优先收敛“旧写入口”，保留安全的旧数据读取/显式迁移更久。若没有可靠迁移完成信号，继续读兼容并明确标记往往比删除旧行更安全。

### 4.8 P2：错误处理与结果状态需按 Host DTO 明确化

Studio RFC r1 已记录安装预检载荷没有 `ok` 字段，UI 不应擅自要求 `preview.ok === true`。这说明 UI/Host 合同需要从真实响应定义，而非由前端猜字段。

建议每类 Host 结果使用版本化、穷尽的 DTO：状态枚举 + 诊断数组 + 稳定错误码 + 关联 ID。未知字段可按协议策略扩展，未知状态必须 fail-closed。`null`/缺失值不应被当作可提交成功；同时也不能以不存在的字段禁用全部有效操作。

## 5. 推荐目标架构

```text
Creator Studio React UI
  展示、用户输入、局部视图状态
          │
          ▼
Studio TS 应用层 / feature workflows
  Project / Candidate / City / Story / Agent task 用例编排
          │  版本化 command + DTO
          ▼
Desktop Rust Host（唯一权威边界）
  授权、校验、CAS、幂等、事务、生命周期状态转换
       │              │
       ▼              ▼
领域服务           SQLite repositories/migrations
Story install/run   schema 版本演进、查询、原子持久化
Rule replay
       │
       ├── City SDK：City 公共合同与纯计算
       ├── Game SDK：Game/Rule 合同与兼容适配器
       └── Narrative SDK：Story graph/静态分析算法
```

### 5.1 单一事实权威原则

- React state 是临时编辑/展示态，不是持久化作品或安装状态权威。
- TS 应用层决定何时调用用例，不自行授权或推断 Host 成功。
- Rust Host 是本地授权、持久化与状态转换权威；数据库写必须事务化并绑定 revision/operation ID。
- SDK 拥有跨语言/跨进程合同与纯计算，不拥有本地数据库或宿主授权。
- City Engine 拥有场景、渲染、时钟与租约实现，不知道 Miami 或具体游戏玩法。
- Game/Story 内容包提供内容和受限规则，不持有任意 Host IPC/SQL 能力。

### 5.2 作品生命周期统一模型

```text
Project（可编辑、revision CAS）
  → Candidate Build（不可变、digest）
  → Release（不可变发布版本）
  → Installation（City 与内容的关系）
  → Run / Save（运行事实与玩家状态）
```

StudioTask 记录目标、计划、执行步骤与证据，并引用项目 ID/revision、Candidate digest、Preview ID 或 Run ID。Task 状态不得替代以上对象状态；任务失败也不应隐式回滚已经提交的作品变更。

## 6. 重复实现与硬编码审查方法

本轮未做语义重复检测，因此不把同名 DTO/SQL 直接判为重复。后续专项审查应对以下高价值区域做对照：

1. `city_game_install.rs` 与 `story_registry.rs`：preview/receipt/CAS/digest/更新确认是否复制了通用安装事务模板；可抽取基础设施，但领域校验与 DTO 不应泛化成无约束大框架。
2. `runtime.ts` 与 `rule_replay.rs`：规则解释、边界值、触发顺序及资源预算是否一致；这是语义重复，不是普通代码重复。
3. `CreatorStudioApp.tsx`、Host bridge 与 `creator_projects.rs`：状态校验是否在 UI、TS adapter、Rust dispatcher 多处复制；客户端可做即时反馈，但 Host 应保留最终校验权。
4. SDK 合同与前端 contracts：识别重复声明字段/枚举。对于 UI-only view model 可以转换，但不要复制权威 wire DTO 定义。

硬编码扫描应分三类审阅：

- **内容值**：Miami skin、具体游戏 ID、主题文案——应从平台移出。
- **协议值**：schemaVersion、方法名、错误码——需要集中合同/代码生成/兼容策略。
- **安全策略**：payload budget、TTL、条数上限——通常必须由可信端固定，需命名、注释和测试，而非简单配置化。

## 7. 优化路线图

### 阶段 A：先锁合同与验收（P0）

1. 建立 V3 端到端验收追踪表：V3-15 到 V3-23 每项映射到入口、状态表、测试与当前证据等级。
2. 冻结 Rule AST、ReplayEvent、evidenceSource 的版本化字段、可信含义和失败降级。
3. 完成 TS trace producer → Host replay → evidence persistence → UI inspection 的一条纵向链路。
4. 加入 TS/Rust parity fixtures；无 trace/跨 digest/不支持节点必须负向测试。
5. 明确 Story Registry UI 的真实状态：能创建/读取/安装/开始 Run 的路径分别验证；没有接通的页面诚实标注，不以 Story Runtime 数据伪装 Project。

### 阶段 B：解耦拆仓前置（P1）

1. 把 Studio 对 City 深路径依赖替换为 workspace package API。
2. 增加 CI 边界扫描，禁止 creator-studio 深路径 import `apps/agent-city`。
3. 逐步把 `CreatorStudioApp` 收敛成路由与布局装配器；拆出 feature controller/use case。
4. Host bridge 按 domain 拆模块，保留统一 transport/correlation/error mapping。
5. 确保 Creator Studio Task Ledger 复用既有 creator session/job ledger；新增字段必须说明兼容读写方式。

### 阶段 C：Rust 领域模块化（P1/P2）

1. 先将 Story Registry 按 project/install/run/lease 拆分，SQL transaction 仍保留在单个领域操作边界内。
2. 为 Story 安装/Run/Lease 定义清晰状态转换表与不可变不变量。
3. 迁移和业务请求处理分离；启动迁移需幂等、有版本号、有损坏降级策略。
4. `creator_projects.rs` 保留路由/命令适配，领域逻辑移入独立 service，不再继续扩容为全功能 Creator 模块。

### 阶段 D：兼容与默认值收敛（P2）

1. 建立 Legacy Compatibility Register，先停止不必要的旧格式写入。
2. 对 Miami skin 默认做 app 层配置迁移，保留老用户已选择的偏好。
3. 清理无消费者的协议类型/方法前，先用静态搜索、测试 fixture 和存量数据路径确认无调用。
4. 为每次删除兼容路径写明最早版本、升级回滚影响及数据处理方式。

## 8. 拆分准则与验收标准

### 文件拆分准则

- 文件按“一个领域不变量/一组协作事务”组织，不按每个函数建一个文件。
- 每个模块应有清晰输入、输出、持久化边界及错误语义。
- 路由层不得拥有领域状态机；Repository 不得拥有 UI 展示规则；SDK 不得依赖 Host 数据库。
- 拆分前记录旧调用路径与事务边界；拆分后确保 operationId/CAS/错误码语义不变。

### 架构验收

- `creator-studio` 无 `apps/agent-city` 源码 import。
- Story 项目、安装、Run、Story state、ViewSession 的身份与生命周期不存在互相替代。
- 规则协议只有一个版本化 schema source；TS/Rust 对共享 fixture 结果一致。
- Replay 未验证时不会写入或展示为 host-verified。
- Story/City 写操作具备授权、revision/operation 绑定、幂等与原子失败语义。
- 每条 legacy 路径有来源、迁移动作、退出条件和回归用例。
- Miami 内容仅由 City app/config/skin/game package 引用，平台层无内容专属默认分支。
- 新增文件和架构整理后，按仓库约定运行相关 Python/Rust/TS 测试、CI 与目标 bundle 验证；golden 变更必须逐项审阅。

## 9. 建议的首批工作项

| 优先级 | 工作项 | 交付物 |
|---|---|---|
| P0 | Replay/证据链闭环 | TS trace 生产、Host 绑定校验、parity fixtures、证据 UI 与负向验收 |
| P0 | V3 Story 验收映射 | V3-15~23 状态矩阵，标注实现/单测/端到端/缺失 |
| P1 | Studio 移除 City 源码深路径依赖 | workspace package API、迁移提交、CI 边界扫描 |
| P1 | Story Registry 分域 | projects/installations/runs/leases 模块及事务不变量文档 |
| P1 | Creator Studio 应用层拆分 | App 装配层 + feature workflows + 分域 Host APIs |
| P2 | 兼容矩阵 | legacy 路径清单、数据升级与删除门槛 |
| P2 | 默认值治理 | Miami 默认来源调整、版本兼容与回归用例 |

## 10. 审核结论

近期改版已经有可复用的 Host/SDK 基础，适合继续增量整合，不建议推翻重建。最先应解决的是**可验证性和边界确定性**：让 Host 复算拿到可追溯且绑定正确对象的输入，让 Story 生命周期状态可在真实 Studio 流程中观察，再完成拆仓所需的应用依赖解耦。

模块过大、legacy 代码和默认值是应治理的问题，但它们的处理顺序应服从合同与数据安全：先锁住行为，再拆职责；先停旧写入，再考虑删除旧读取；先确认皮肤/模板的产品所有权，再从平台移除默认值。

本文件是审查和优化建议，不表示所有发现都已由运行态复现。实施前应为每项 P0/P1 建立具体代码路径、测试证据和验收责任人。
