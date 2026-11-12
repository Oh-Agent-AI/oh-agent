# Creator Studio Agent 接入代码设计

日期：2026-11-12  
状态：设计方案，需结合 MVP 范围评审  
关联文档：[Creator Studio PRD](AGENT_CITY_CREATOR_STUDIO_PRD_2026_11_11.md)、[Creator Studio 代码架构](AGENT_CITY_CREATOR_STUDIO_CODE_ARCHITECTURE_2026_11_11.md)、[Oh Agent MCP 交互设计](OH_AGENT_MCP_DESIGN.md)

## 1. 目标

让用户选择自己常用的第三方 Agent，通过统一、受限的 Creator 能力修改当前 City 项目，并在 Creator Studio 的 3D 视口看到预览、确认修改、试玩和查看结果。第一阶段面向支持 MCP 的客户端，例如 Codex 和 Claude Code。

设计目标：

- Creator Studio 不绑定某一家模型或 Agent SDK。
- 不同 MCP 客户端复用相同的 Creator 工具和项目版本契约。
- Agent 只能访问获准的 Creator 项目，不能访问任意文件、数据库或通用宿主 IPC。
- 预览与提交分离，所有修改经过项目 revision、校验和用户可见的结果反馈。
- Agent 接入不得扩大既有 Agent Vitals 数据访问范围。

本方案将“外部 Agent 调用 Creator MCP”作为 MVP 主路径。由 Oh Agent 启动和管理各家 Agent 运行时属于另一种集成形态，不纳入 MVP。

## 2. 当前代码基线

仓库已有 Creator MCP 垂直链路，不应另起一套平行协议：

    外部 MCP 客户端
        │ 本地 stdio: agent-vitals data-mcp serve
        ▼
    crates/agent-vitals-mcp/src/mcp/creator_studio.rs
        │ 类型化 creator.* 请求
        ▼
    agent_vitals_query::query::plugin_calls
        │ 已登记插件、活动实例路由
        ▼
    Creator Studio WebView → Rust Creator 项目服务
        │ SQLite revision / preview / operation 记录
        ▼
    Creator Studio 3D 视口

当前工具包含项目列表与分块读取、城市布局列表、项目创建、游戏预览、场景预览、提交、发布、操作状态查询和试玩历史。写入工具要求 data-mcp serve --allow-local-writes，并经活动的官方 Creator Studio 插件路由；项目服务在 apps/desktop/src-tauri/src/creator_projects.rs 处理 revision、预览和持久化。

目前 MCP 工具已覆盖完整试玩接口：creator_playtest_history 之外，start / result / cancel 已接入（2026-11-12）。宿主侧 creator.project.playtest.start 校验 release 归属（projectId/expectedRevision 提供即校验），cancel 释放活动租约并保证唯一终态。

当前实现入口：

- [Creator Studio MCP 工具](../crates/agent-vitals-mcp/src/mcp/creator_studio.rs)
- [MCP 工具注册与分发](../crates/agent-vitals-mcp/src/mcp/mod.rs)
- [MCP stdio 服务](../apps/cli/src/mcp.rs)
- [Rust Creator 项目服务](../apps/desktop/src-tauri/src/creator_projects.rs)
- [Creator Studio 插件宿主路由](../apps/desktop/src-tauri/src/plugin_host.rs)
- [App SDK Plugin RPC 契约](../packages/agent-vitals-app-sdk/src/plugin-rpc.ts)

## 3. 架构决策

### 3.1 先接入外部 Agent，不先实现 Provider Adapter

外部 MCP 接入让 Agent 调用 Creator 工具；Provider Adapter 则由 Oh Agent 启动和管理 Agent 进程、会话、模型和账号。两者职责不同。

MVP 维护一套 Creator MCP 工具。用户在 Codex、Claude Code 或其他 MCP 客户端配置本地 stdio server，Agent 通过该工具集创作。若未来要求从 Oh Agent 内直接选择并启动不同 Agent，再以独立的 CreatorAgentAdapter 接入 ACP 或各家原生 SDK，不让 Provider 特例进入 Creator 项目服务。

### 3.2 统一 Creator 工具协议

不为 Codex、Claude、ChatGPT 分别复制一套业务 API。Agent 客户端差异由 MCP 协议和连接配置承接；项目语义统一使用版本化 Creator DTO、操作和稳定错误码。

### 3.3 MCP 是工具面，不是场景控制面

MCP 返回受限的结构化结果和预览标识。它不直接操作 Three.js、DOM、键鼠，也不通过截图模拟场景编辑。Rust 项目服务承载写入权威；活动 Studio 根据项目变更更新 3D 视口并呈现 Agent 的预览与校验反馈。

### 3.4 默认沿用本地 stdio

当前服务入口是本地 stdio MCP，不引入远程监听、OAuth 服务或账户系统。远程 Agent 访问本机 Creator 项目，需要另外设计远程传输、认证、撤销、联网策略和数据共享界面，不能只把 stdio 换成 HTTP。

## 4. 进程和模块职责

| 模块 | 责任 | 不负责 |
|---|---|---|
| MCP 客户端 | 发送用户意图、选择 MCP 工具、展示 Agent 回复 | 定义 Creator 项目真值 |
| creator_studio.rs | 声明 MCP tool schema；验证入参边界；映射到内部 Creator 方法；格式化稳定错误 | 读写 SQLite、解析任意 IPC、执行场景操作 |
| apps/cli/src/mcp.rs | MCP 握手、工具发现和调用；传递启动时的写入开关 | 项目级授权和 City 语义校验 |
| PluginHost | 校验官方插件登记、活动 WebView 实例、方法 allowlist；路由到 Creator 服务 | 接受插件自行注册 Creator handler |
| creator_projects.rs | 项目 revision、短期预览、事务提交、幂等记录、发布快照和试玩交接 | Agent 提示词和 MCP 工具命名 |
| agent-vitals-city-sdk | City 内容模型、操作语义、TS 侧领域校验和运行时适配 | 持久化 authority 和权限决定 |
| Creator Studio UI | 3D 预览、编辑器状态、Agent 变更卡片、提交反馈和试玩界面 | 绕过项目服务直接保存 |

推荐依赖关系：

    MCP Tool Adapter → Creator Domain / Service API → Creator Store
                              ↑                            │
                              │                            └→ revision / change notification
    Creator Studio UI → trusted City SDK adapter ←─────────┘

落地时保持现有 Rust PluginHost/RPC 边界。若拆分 creator_projects.rs，按项目领域、存储事务、资产服务和宿主命令拆分；不要把 Agent/Provider 特例塞进项目存储模块。

## 5. 身份、授权和数据范围

### 5.1 身份层级

MVP 有三个不同身份，不应混成一个 Agent token：

1. MCP 进程连接：本机启动 MCP server 的客户端进程。stdio 管道提供进程级连接，不等同于远程用户认证。
2. Creator Studio 活动实例：PluginHost 确认的官方 Studio WebView 实例。只有该实例有效时，现有路由才接受 Creator 请求。
3. Creator 项目范围：请求中的 projectId 和 baseRevision / expectedRevision。每次访问都验证项目存在、操作允许、版本一致。

项目 ID 本身不是凭据。请求不得通过猜测 ID 访问未经选择的其他项目。MVP 可将本地 MCP 服务进程视为用户明确配置的本机 Agent；更细粒度的客户端身份授权需在支持多用户或远程连接前补充。

### 5.2 写入权限

当前 --allow-local-writes 是 MCP 服务启动时的粗粒度写入开关。它是必要条件，但不代表单项目授权、每次提交确认或远程授权。

写入链路仍要求：

- MCP 写入开关已开启；
- 官方 Creator Studio 当前活动且方法已登记；
- 项目及 revision 有效；
- 提交使用此前签发的短期、单次、实例绑定 previewId；
- 写入携带稳定 operationId，重复请求返回原结果；
- 发布、开始试玩等操作有独立工具及明确用户可见反馈。

预览不等同于提交授权。Agent 操作应在 UI 显示变更内容、Agent 来源和应用状态。应用前的确认策略需与产品交互一致：不能让 UI 表示“等待确认”，而 MCP 调用实际上已经完成持久化。

### 5.3 数据边界

- MCP 只返回创作所需的项目字段、对象引用、校验错误和试玩摘要。
- 不暴露 authority DB、任意 SQL、任意文件路径、原始会话日志、用户提示词、凭证或不相关的 Agent Vitals 分析数据。
- 大型项目继续采用有界分块和摘要校验；不要把完整场景、GLB 字节或资源文件放进 Agent 上下文。
- 工具调用不授予上传或后台网络能力。所选 Agent 服务可能收到用户主动提交给它的项目上下文，连接和 UI 应说明这一点。
- 外部包、未验证插件和浏览器预览不得获得真实本机数据或 Creator 写权限。

## 6. MCP 工具 API

### 6.1 当前工具集

以下工具由 creator_studio.rs 声明。实现以代码为准，API 文档同步更新：

| MCP 工具 | 类别 | 说明 |
|---|---|---|
| creator_layout_list | 只读 | 读取有限数量的宿主捕获 City 布局快照 |
| creator_project_list | 只读 | 列出本地 Creator 项目 |
| creator_project_read | 只读 | 按偏移分块读取 UTF-8 项目文档 |
| creator_operation_status | 只读 | 按项目和 operationId 查提交结果 |
| creator_playtest_history | 只读 | 读取有界本地试玩摘要 |
| creator_playtest_start | 写入 | 请求活动 Studio 启动一次已发布 release 的可视试玩；提供 projectId/expectedRevision 时校验归属 |
| creator_playtest_result | 只读 | 按 runId 读取单次试玩状态、结束原因和有界证据摘要 |
| creator_playtest_cancel | 写入 | 取消 pending/claimed 的试玩并释放活动租约；已终态的 run 幂等返回原状态 |
| creator_project_create | 写入 | 从模板和锁定的 City world revision 创建项目 |
| creator_game_preview | 预览 | 校验小游戏 JSON 草稿并签发短期 preview |
| creator_scene_preview | 预览 | 对有界场景操作做校验并返回 preview |
| creator_project_commit | 写入 | 消费单次 preview 并提交新 revision |
| creator_project_publish | 写入 | 将已保存 revision 发布为不可变本地 release |

工具 schema 继续使用 additionalProperties=false、字段长度/数量上限、稳定对象 ID、版本字段和小型结构化结果。不要新增 execute_script、通用 plugin_request、shell、任意文件访问或 SQL 工具。

### 6.2 推荐调用流程

    creator_project_list
        ↓ 用户或 Agent 选择项目
    creator_project_read(projectId, offset, maxBytes)
        ↓ 读取必要上下文和 revision
    creator_scene_preview(projectId, baseRevision, operations)
        ↓ Studio 展示结构化差异、诊断和 3D 预览
    creator_project_commit(projectId, previewId, expectedRevision, operationId)
        ↓ Studio 刷新场景并显示保存结果
    creator_project_read / creator_operation_status
        ↓ 验证提交版本和处理超时重试

创作修改保持 preview → 用户可见预览 → commit。若响应超时，Agent 先调用 creator_operation_status，或使用相同 operationId 重试，不应生成新 ID 后盲目重复提交。

### 6.3 试玩工具

试玩工具已实现，工具名和输入以 creator_studio.rs 为准。启动以 releaseId 为必需参数，projectId、expectedRevision 和 requestId 可选，用于归属校验或关联调用；结果与取消按 runId 操作。

| 工具提案 | 输入 | 结果 |
|---|---|---|
| creator_playtest_start | projectId、releaseId、expectedRevision、requestId | runId、状态、releaseId、固定项目 revision |
| creator_playtest_result | runId | 状态、结束原因和有界试玩摘要 |
| creator_playtest_cancel | runId | 取消结果和最终状态 |

约束：

- MCP 只能请求活动 Studio/City 宿主启动试玩；不得模拟鼠标、键盘或直接注入玩家输入。
- 试玩固定不可变 release 快照。结果通过 runId 读取，不写回旧快照。
- Agent 可读取已完成的结构化摘要；启动、取消和失败状态明确区分。
- 玩家手动操作视口是 MVP 的可视试玩路径。未来若允许 Agent 驱动可视输入，需增加有时限、绑定 runId 的输入能力和用户接管机制。
- 插件未活动、City 无法 claim run、交接失败或用户取消时，返回明确终态并释放活动租约。

当前结果是 City 客户端报告的有限试玩证据，不是防作弊或排行榜证明。

### 6.4 对照 Blender / Unity MCP 后建议补充的接口

以下接口来自 Blender / Unity MCP 的对照调研。**`creator_scene_describe`、`creator_scene_capture`、`creator_capabilities_list`、`creator_scene_inspect`、`creator_scene_validate` 均已在 `creator_studio.rs` 注册并接入**（见 §11.1；inspect/validate 为 2026-11-12 第二批）。保持 City 领域操作，不暴露通用 Python、JavaScript 或脚本执行。

| 接口 | 主要输入 | 返回 | 优先级 | 状态 |
|---|---|---|---|---|
| creator_scene_describe | projectId；可选 revision、selectedObjectId | 城市/项目摘要、revision、对象类别计数、选中对象摘要、挂载/皮肤摘要、可用编辑类别 | P0 | 已实现 |
| creator_scene_capture | projectId；可选 revision | 有界 JPEG 数据 URL、revision、镜头信息 | P0 | 已实现（输入窄于设计） |
| creator_scene_inspect | projectId、revision、objectId | 指定对象/锚点/挂载的白名单字段、引用关系和编辑限制；布局锚点标记为只读引用 | P1 | 已实现（2026-11-12 第二批） |
| creator_capabilities_list | 无参数 | 操作类别、对象类别、预算和能力版本（schemaVersion 1） | P1 | 已实现（含 category/schemaVersion 过滤，2026-11-12 第二批） |
| creator_scene_validate | projectId、可选 revision、validationProfile（仅 static） | 静态 schema/资产存储检查逐项报告；City 运行时检查如实列为未运行（releaseId 变体未做） | P1 | 已实现（2026-11-12 第二批） |

接口语义：

- describe 返回面向 Agent 的紧凑摘要，不代替 creator_project_read；对象较多时按类别摘要或分页。
- capture 只能由活动官方 Studio 在本地渲染器中生成，不接受任意文件路径或 URL。当前只接受 projectId/revision：cameraPreset、targetObjectId、imageFormat 尚未实现；编码后字节超预算或视口不可用时返回受控错误，图片绑定捕获时的 revision。不支持图像内容的 MCP 客户端改用 describe。
- inspect 仅允许白名单字段，不返回本机路径、GLB 字节、authority DB 内容或无关分析数据。
- capabilities_list 提供稳定契约发现，不返回可执行代码；最终写入仍经 preview/commit 权威校验。
- validate 明确区分静态 schema 校验和 City 运行时校验。没有真实执行道路可达、净空、物理或视觉检查时，不得报告这些检查通过。
- describe、capture、inspect 结果均带 projectId、revision 和生成时间；revision 漂移后 Agent 应重新读取。

应同时完善 creator_game_preview 和 creator_scene_preview 的结构化差异结果，不另造平行的 edit diff 工具。结果至少包含 changedObjects（稳定 ID、变更字段和前后摘要）、diagnostics（级别、稳定 code、对象 ID、用户可读信息）、baseRevision、previewId、expiresAt 及可视预览关联信息。Studio 使用同一结果呈现变更卡片和场景 overlay。

### 6.5 资产接口边界

Blender MCP 常覆盖导入/导出、材质、网格、渲染等资产工作流。Creator Studio 逐步增加与 City 项目直接相关的资产能力：

- 保留现有桌面原生文件选择器 creator.asset.import；MCP 不接收本机路径或任意二进制。
- 可后续增加 creator_asset_list，返回项目内已导入资源的 ID、摘要、预算和允许引用位置。
- 资源下载和 Shop 安装属于受信任 package 流程，不由通用 MCP URL 工具代替。
- 材质节点、任意网格编辑、物理脚本和着色器图不属于当前 City SDK 的 MCP P0。

## 7. 预览、提交和并发

### 7.1 预览凭据

previewId 至少绑定 projectId、baseRevision、规范化操作摘要、Creator Studio 活动实例、创建/过期时间、操作类型和预算。MCP commit 不能更改 preview 中的操作。预览短期有效、单次消费、实例绑定；过期后重新预览。

### 7.2 Revision 和幂等

- 预览读取 baseRevision；提交提供 expectedRevision。
- revision 不一致返回 revision_conflict，不覆盖新修改；Agent 需重读、合并意图并重新预览。
- 每次提交使用稳定 operationId。超时后 operation_status 查询结果。
- operationId 不得跨项目或不同负载复用；服务端记录并校验负载摘要。
- 提交事务同时写项目文档、增加 revision、记录操作回执和所需变更通知。

### 7.3 3D 视口同步

项目服务提交成功后，Studio 收到 revision 变化并刷新场景。MCP 响应的 revision 与 operationId 用于对齐 Agent 消息和 3D 变更卡片。通知丢失时，Studio 按项目当前 revision 重读，不能把通知作为唯一持久化记录。

## 8. 多 Agent 客户端兼容

### 8.1 第一阶段：MCP stdio

提供客户端配置说明和连接自检：

- 可执行文件路径、data-mcp serve 参数和写入开关；
- MCP 初始化和工具发现状态；
- Creator Studio 是否活动；
- 项目服务是否可用；
- 一次只读 creator_project_list 自检。

Codex、Claude Code 和其他支持本地 MCP stdio 的客户端使用同一 server 和工具 schema。客户端配置文档可以不同，但不能改变工具的业务含义。

接入步骤、工具清单、连接自检与 §11 场景覆盖映射见 [Creator MCP 多客户端接入指南](AGENT_CREATOR_MCP_CLIENT_SETUP.md)。

### 8.2 远程 Agent

云端 Agent 通常不能直接启动用户机器上的 stdio 进程。若未来需要支持，必须增加远程 MCP transport 和独立授权设计，包括 TLS、用户身份、短期 token/OAuth、项目级 scope、撤销、限流、审计元数据、内容共享披露及断线恢复。不能将本地 stdio 暴露到 LAN 或公网后就认为远程接入完成。

### 8.3 客户端差异处理

- 工具描述说明动作、前置条件、副作用和错误码，避免依赖客户端私有提示词。
- 工具调用使用标准 JSON Schema；可选能力通过工具发现和版本字段判断。
- structuredContent 为机器可读权威结果，同时提供可读文本摘要。
- MCP 连接或 Studio 关闭时返回 plugin_unavailable，提示用户打开 Studio 后重试。
- 客户端不支持 OAuth 不影响本地 stdio；未来远程模式需满足服务端身份协议要求。

## 9. 错误处理与诊断

| 错误码 | 建议处理 |
|---|---|
| permission_denied | 提示需要写入授权或有效 Studio 实例，不泄漏授权内部状态 |
| plugin_unavailable | 提示打开或恢复 Creator Studio 后重试 |
| revision_conflict | 重读当前项目并重新生成预览 |
| preview_expired | 重新预览；旧 preview 不续期 |
| not_found | 重新列出项目、布局或试玩 |
| invalid_argument | 返回可修正的字段级诊断，不回显超大原始负载 |
| busy | 退避后重试并保留原 operationId |
| data_unavailable | 显示本地服务不可用，不用合成数据伪装成功 |

日志可记录工具名、耗时、错误分类、项目 opaque ID、revision 和 operationId 摘要。不得在普通日志中持久化完整 Creator 文档、Agent prompt、原始工具参数、文件路径或凭证。

## 10. 版本化与兼容

- MCP 工具名保持稳定；输入输出通过 schemaVersion 或显式版本 DTO 演进。
- 兼容性字段使用可选字段或新增工具名；改变提交语义、revision、授权要求或结果身份时升级契约版本。
- Rust tool schema、Plugin RPC payload、Creator project schema 和 TS SDK 使用共享契约 fixture，覆盖合法、无效、过期和越权输入。
- 未知字段默认拒绝；未知 schema 版本返回 unsupported_version，不静默降级后写入。
- 接入新的 MCP 客户端只增加连接文档和配置，不增加 Provider 特定业务分支。

## 11. 测试与验收

验收需证明工具经过真实 Rust MCP 分发、PluginHost 活动实例校验和 Creator 服务校验。当前已实现接口按“现有”行验收；第 6.4 节建议接口的验收标准是实现该接口时的准入条件，不代表接口已经存在。

### 11.1 当前已实现接口

| 接口 | 验收标准 |
|---|---|
| creator_layout_list | 返回数量不超过 limit 的布局快照；每项含稳定布局 ID、worldRevision 和允许创建项目使用的锚点摘要；不含场景几何、分析数据或本机路径。非法 limit 和无可用 City 时返回明确错误。 |
| creator_project_list | 仅列出本地 Creator 项目，条数受 limit 限制；列表字段不含项目完整文档或资产字节；Studio 不可用时返回 plugin_unavailable。 |
| creator_project_read | 按 UTF-8 字节边界返回有界 chunk、nextOffset、complete 和一致的 documentDigest；chunk 拼接结果与同 revision 的完整文档一致；偏移越界、项目不存在和文档变更均可诊断。 |
| creator_operation_status | 对已提交 operationId 返回与原提交相同的持久结果；未找到返回 not_found；不能因查询而重复执行操作。 |
| creator_playtest_history | 返回 limit 范围内、绑定项目的有限历史摘要；不返回输入轨迹、原始日志或未验证的防作弊结论。 |
| creator_project_create | 写入开关关闭时拒绝且不创建项目；开启时需引用有效 worldRevision 和支持的模板；相同 operationId 重试不创建重复项目；结果包含 projectId 和初始 revision。 |
| creator_game_preview | 有效 JSON 返回绑定 projectId/baseRevision 的短期 preview 和结构化诊断；非法规则、超限 payload、版本冲突被拒绝且不改变项目 revision。 |
| creator_scene_preview | 接受范围内的操作并返回诊断、对象差异和单次 preview；未知操作、未知字段、非法对象引用、数量/字节/变换超限均拒绝；预览不持久化草稿、不增加 revision。 |
| creator_project_commit | 写入开关关闭时拒绝；有效 preview 仅能消费一次，expectedRevision 一致时原子提交并推进一次 revision；旧 revision、过期 preview、跨实例 preview 均拒绝且不部分写入；operationId 重试返回原结果。 |
| creator_project_publish | 写入开关关闭时拒绝；仅发布指定且当前保存的 revision；release 内容摘要固定，重复发布或超时查询不会改变既有 release；项目无有效挂载时返回具体诊断。 |
| creator_playtest_start | 写入开关关闭时拒绝；release 存在且可由当前 City 运行时认领；提供 projectId/expectedRevision 时必须匹配 release 归属；重复请求不能启动重复 run；返回 runId 和固定 release/revision。 |
| creator_playtest_result | 对 pending、claimed、completed、cancelled、failed、expired 等状态返回正确的唯一 run；终态不被后续查询改变；仅返回有界结果摘要和稳定失败码。 |
| creator_playtest_cancel | 可取消 pending/claimed run 并释放活动租约；终态 run 幂等返回原终态；未知 runId 返回 not_found；取消后不能再写入完成证据。 |
| creator_scene_describe | 对指定项目和 revision 返回项目摘要、对象类别计数、可选选中对象摘要、挂载/皮肤概况和可编辑类别；响应有界且不包含完整项目文档；revision 不匹配返回 revision_conflict；结果带 generatedAtMs，改变项目后旧摘要能被识别为旧 revision。 |
| creator_scene_capture | 仅从活动官方 Studio 的本地 WebView 渲染器捕获；输出绑定捕获时的 projectId/revision 和镜头信息；编码后字节超预算、视口不可用或 Studio 未活动时返回可诊断错误；不接受任意路径、URL、远程读取或文件写入。当前输入只接受 projectId/revision。 |
| creator_capabilities_list | 返回 schemaVersion 1 的类别登记表：操作名、对象类别、预算和 preview 约束；不含可执行代码；生成的操作仍需经 preview 做权威校验；支持可选 category（未知类别返回 creator_capability_unknown）与 schemaVersion=1 过滤。 |
| creator_scene_inspect | 只接受 projectId、revision 和稳定 objectId（三者必需）；只返回该对象允许的白名单属性、引用关系、编辑通道与约束；场景对象、挂载与只读 City 布局锚点三类来源可区分，布局锚点标记不可编辑；未知 objectId 返回 creator_object_not_found，过时 revision 返回 revision_conflict；不得返回源文件路径、GLB 字节、数据库字段或未授权的关联对象数据。当前验证：creator_projects.rs `scene_inspect_validate_and_capabilities_cover_whitelisted_views`。 |
| creator_scene_validate | projectId 必需，revision 与 validationProfile（仅 `"static"`）可选；逐项诊断含稳定 code、severity、source 与 objectId（若适用）；需要 City 运行时的检查（drive 可达、碰撞、视觉评审等）如实列入 unchecked 并注明原因，未运行的检查不得显示通过；同一输入/revision 的确定性检查结果稳定且不消耗任何资源。当前验证：creator_projects.rs `scene_inspect_validate_and_capabilities_cover_whitelisted_views`、`scene_describe_capabilities_and_preview_diff_are_bounded`。 |

### 11.2 尚未实现的候选接口

以下候选接口尚未注册。实现时须逐条通过对应验收，并加入工具发现、权限、负载预算和契约测试。（creator_scene_inspect 与 creator_scene_validate 已于 2026-11-12 实现并通过 §11.1 验收行，移出本表。）

| 接口 | 验收标准 |
|---|---|
| creator_asset_list | 仅列出指定项目已导入资源的稳定 ID、摘要、受限元数据及允许引用位置；分页/数量受限；不返回原始文件路径或二进制；资源缺失或摘要不匹配返回诊断，不伪装成可用资源。 |

### 11.3 预览差异与端到端验收

creator_game_preview 和 creator_scene_preview 的差异结果满足以下条件：

- 含 projectId、baseRevision、previewId、expiresInMs 和规范化操作摘要（preview 在服务端已绑定操作摘要，不在响应中回显）。
- changedObjects 使用稳定 ID 和规范路径，带 kind 与 action（added/updated/removed）；game 预览另带 fields 与前后摘要，scene 预览的前后摘要由 diff.beforeDigest/afterDigest 提供；不得只返回“成功”。
- diagnostics 当前恒为空数组：校验失败以稳定错误码返回。后续切片若要填充逐项诊断，必须使用稳定 code 和 severity，并能定位对象，与 Studio 变更卡片一致。
- 每个 preview 绑定当前 Creator Studio 实例、基线 revision 和操作；超时、跨实例、改 payload 或重复消费时不能提交。
- Studio 收到同一 preview 后能在 City 视口定位或高亮受影响对象；提交后视口、项目 revision 和 MCP 响应结果一致。

端到端最少验收：

1. MCP 初始化后可发现所有当前工具；无 --allow-local-writes 时所有写入操作被拒绝，项目和 run 状态不变。
2. Studio 未打开、被替换或实例过期时调用失败，不发生写入；Studio 重开后可重新读取已提交项目。
3. Agent 创建项目、读取 chunk、预览有效修改、用户确认、提交成功，Studio 视口显示新 revision。
4. 无效对象、越界操作、超预算请求和额外 schema 字段被拒绝，项目 revision 不变。
5. preview 过期、并发编辑推进 revision、preview 重复消费均按预期拒绝；重新读取和预览后可继续。
6. 提交响应丢失后，使用原 operationId 查询或重试只产生一次 revision。
7. 两个不同 MCP 客户端调用相同工具时，工具发现、项目行为和错误语义一致；差异限于客户端安装/连接方式。
8. 试玩取消、启动失败、完成和返回 Studio 都形成唯一终态，固定 release 快照不被后续编辑改变。
9. 所有 MCP 响应不含本机路径、原始日志、会话提示词、凭证或超出该工具必要范围的数据。

一个 Agent 成功调用工具不足以证明多客户端兼容。至少用两个不同 MCP 客户端验证工具发现、预览、提交和错误反馈。

## 12. 实施阶段

| 阶段 | 工作 | 交付结果 |
|---|---|---|
| A. 稳定现有工具 | 对齐 schema 与项目服务契约；检查 revision 和 operation 结果 | Agent 稳定读取、预览、确认和提交 |
| B. Studio 变更反馈 | 把 preview/commit 结果映射为 Agent 变更卡片和 3D 视口状态 | 用户看到 Agent 改了什么，可确认/取消并继续手调 |
| C. 试玩闭环 | 决定是否开放 MCP 启动试玩；增加 start/result/cancel 和唯一 runId | Agent 能请求试玩并读取结果，玩家正常操控 |
| D. 多客户端验证 | 增加 Codex、Claude Code 配置示例和端到端验收 | 证明 MCP 合约跨客户端稳定 |
| E. 远程接入评估 | 单独评审 OAuth、数据流披露、项目 scope 和撤销 | 决定是否让云端 Agent 连接本机项目 |

A 至 D 不要求多个 Provider 进程、不要求云端服务，也不要求社区插件动态执行代码。GitHub 内容分发和 Shop 安装沿各自 release/package 设计推进。

## 13. 不在本方案范围内

- 在 Studio 内实现多个 Agent 提供方的账号登录和模型选择；
- 由 Oh Agent 托管或代理第三方模型 API；
- 多 Agent 同时写入一个项目；
- Agent 自由执行 JavaScript、WASM 或任意脚本；
- MCP 访问 Agent Vitals 原始数据、用户会话日志或任意 SQLite；
- 公网 MCP server、云端项目同步或无用户确认的后台操作；
- 以 MCP 工具替代 Creator SDK、PluginHost 或城市运行时。

## 14. 结论

Creator Studio 已有本地 MCP 工具、活动插件路由、Rust 项目服务和版本化预览/提交基础。下一步应收敛并验收这条既有链路：外部 Agent 通过同一套 MCP 契约创作，Studio 提供可见的 3D 预览与确认，再补齐有明确终态的试玩 MCP 能力。只有需要 Oh Agent 自己启动多种 Agent 或接入云端 Agent 时，才扩展 Provider Adapter 或远程 OAuth MCP。
