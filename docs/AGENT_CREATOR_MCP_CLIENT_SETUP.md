# Creator MCP 多客户端接入指南

日期：2026-11-16（全量同步到当前工具面：creator 域 50 个工具）
状态：接入文档；工具面、预算与错误码以代码为准
关联文档：[Creator Agent 接入代码设计](AGENT_CREATOR_AGENT_INTEGRATION_CODE_DESIGN_2026_11_12.md)、[Studio Agent First 编辑器规格](STUDIO_AGENT_FIRST_EDITOR_SPEC_2026_11_15.md)、[自定义城市与 MCP 接口设计](CREATOR_STUDIO_CUSTOM_CITY_MCP_DESIGN_2026_11_14.md)、[Data MCP 规格](AGENT_VITALS_DATA_MCP_SPEC.md)

结论先行：外部 MCP 客户端经本地 stdio（`agent-vitals data-mcp serve`）访问统一 Creator 工具面。creator 域共 **50 个工具**（creator_studio.rs 42 个 + creator_session.rs 8 个），其中 16 个 `creator_city_*` 实验工具默认隐藏、需 `--enable-city-tools`。只读与预览工具不需要任何开关；14 个写入工具需要 `--allow-local-writes`。Studio 路由类工具要求活动的官方 Creator Studio WebView，Studio 未打开约 15 秒后返回 `plugin_unavailable`；会话/作业/判别 8 个工具与两个静态契约工具（`creator_capabilities_list`、`creator_vehicle_list`）天然离线可用。creator 域错误响应自动附带 `next` 恢复建议（§4，与 Studio UI 同一来源）。

## 1. 前置条件

1. **桌面应用已安装并运行。** Creator 请求由桌面应用的 PluginHost 路由到 Creator Studio WebView；纯 CLI 进程不承载 Studio。桌面包按仓库规约经 bundle 构建：`cd apps/desktop/src-tauri && cargo tauri build --bundles app`，然后打开 `target/release/bundle/macos/Oh Agent.app`。会话/作业/判别 8 个工具（§3.7、§3.8）不依赖 Studio。
2. **官方 Creator Studio 插件已打开。** 这是全部 Studio 路由类 creator 工具的前置条件；Studio 关闭时调用等待约 15 秒后返回 `plugin_unavailable`（crates/agent-vitals-mcp/src/mcp/creator_studio.rs 的 `call_error` 映射）。
3. **CLI 二进制可用。** `cargo build --release` 产出 `target/release/agent-vitals`（仓库根目录相对）。
4. **同一数据根。** 数据根解析为 `AGENT_VITALS_HOME` → `SKILL_VITALS_HOME` → `~/.agent-vitals`（存在旧 `~/.skill-vitals` 时兼容沿用，见 crates/agent-vitals-runtime-core/src/core/home.rs）。CLI 与桌面应用按进程各自解析；若设置 `AGENT_VITALS_HOME`，两边进程都要一致设置，否则插件调用信箱（`state/plugin-calls`）对不上。

### 1.1 服务启动命令（以 apps/cli/src/main.rs 为准）

```
agent-vitals data-mcp serve [--allow-local-writes] [--enable-city-tools]
```

- 子命令形式为 `data-mcp serve`；`--allow-local-writes` 与 `--enable-city-tools` 是 `serve` 仅有的两个参数（`DataMcpAction::Serve`，apps/cli/src/main.rs）。
- 服务阻塞到 stdin 关闭，随后以退出码 0 结束；stdout 只出 JSON-RPC 帧，日志走 stderr（apps/cli/src/mcp.rs）。启动横幅：`data-mcp: serving on stdio (protocol 2025-06-18, data_home …)`。
- 不带 `--allow-local-writes` 时：只读与预览工具可用，14 个写入工具返回 `permission_denied`。
- 不带 `--enable-city-tools` 时：16 个 `creator_city_*` 工具不出现在 `tools/list`，直接调用返回 `invalid_argument`（§6.2）。

## 2. MCP 客户端配置示例

**以客户端官方文档为准。** 以下只钉 server 侧事实：`command` 指向 `target/release/agent-vitals`，`args` 为 `["data-mcp", "serve", "--allow-local-writes"]`（需要城市草稿域再加 `"--enable-city-tools"`）。不需要网络端口、token 或 OAuth；stdio 由客户端自行托管进程。

Codex CLI（`~/.codex/config.toml`，字段名以 Codex 官方文档为准）：

```toml
[mcp_servers.agent-vitals]
command = "/absolute/path/to/skill-vitals/target/release/agent-vitals"
args = ["data-mcp", "serve", "--allow-local-writes"]
```

Claude Code（`claude mcp add` 或项目 `.mcp.json`，字段名以 Claude Code 官方文档为准）：

```json
{
  "mcpServers": {
    "agent-vitals": {
      "command": "/absolute/path/to/skill-vitals/target/release/agent-vitals",
      "args": ["data-mcp", "serve", "--allow-local-writes"]
    }
  }
}
```

提示：

- 不做写入验证的客户端可去掉 `--allow-local-writes`，只保留 `["data-mcp", "serve"]`。
- 若客户端支持 per-server 环境变量，需要非默认数据根时设置 `AGENT_VITALS_HOME`，并与桌面应用一致。
- 不同客户端对 stdio MCP 的安装/连接方式可以不同，但不改变工具的业务含义。

> 想**直接操控一局游戏做测试**（喂输入、逐帧推进、读确定性与 trace），那不是这套
> creator 面：另起一个 stdio MCP `city-game-control`
> （`apps/agent-city/mcp/city-game-mcp.mjs`，见 `docs/CITY_GAME_MCP.md`）。两者可以同时接。

## 3. 工具面（与 creator_studio.rs / creator_session.rs 的 specs() 一致）

### 3.0 总量与协议事实

- 协议：JSON-RPC 2.0 行分隔帧；`initialize` 协议版本 `2025-06-18`，`serverInfo.name` 为 `Oh Agent MCP`（apps/cli/src/mcp.rs）。
- `tools/list` 默认共 **58 个工具**，其中 creator 域 **34 个**（26 个 Studio 域 + 8 个会话/作业/判别）；其余 24 个为数据/信任/城内工具（22 个基线 + 2 个 `city_world_*`）。
- 加 `--enable-city-tools` 后共 **74 个工具**，creator 域凑满 **50 个**（补入 16 个 `creator_city_*`）。
- `mcp-internal` cargo feature（默认不编译）会再追加 query_sql_readonly / billing_workflow / authority_audit 3 个工具，与本指南无关。
- 工具名逐一核对自 crates/agent-vitals-mcp/src/mcp/creator_studio.rs 与 creator_session.rs 的 `specs()`；`mcp::tests::tool_specs_and_dispatch_agree` 逐工具断言「注册即可分发」。宿主插件方法（`creator.city.*` 等点号命名）是内部路由面，不作为 MCP 工具暴露。

### 3.1 项目与场景（preview→commit 两段式，13 个）

| MCP 工具 | 必需入参 | 可选入参 | 类别 |
|---|---|---|---|
| creator_project_list | limit（1..=100） | — | 只读（需 Studio） |
| creator_project_read | projectId | offset（默认 0）、maxBytes（1..=32768，默认 32768） | 只读；按 `nextOffset` 分块拼到 `complete=true`，用 `documentDigest` 校验 |
| creator_operation_status | projectId、operationId | — | 只读；`awaiting_confirmation`=等用户确认，`committed`=已落库，`not_found`=无已提交结果 |
| creator_project_create | template（经 `creator_capabilities_list` category `project` 的 `templates` 发现）、operationId、worldRevision | cityId（绑定独立 City 草稿布局；省略走 legacy 布局） | 写入 |
| creator_game_preview | projectId、baseRevision、game（对象） | — | 预览（不落盘）；宿主内容预算 gameBytes=262144 |
| creator_scene_preview | projectId、baseRevision、operations（1..=128 条） | — | 预览（不落盘）；操作词汇见 `creator_capabilities_list` 的 `operations` 段 |
| creator_project_commit | projectId、previewId、expectedRevision、operationId | — | 写入；确认两段式的第二段（§6.3） |
| creator_scene_describe | projectId | revision（漂移即 `revision_conflict`）、selectedObjectId | 只读（需 Studio）；有界摘要，不回完整文档 |
| creator_scene_capture | projectId | revision | 只读（WebView 本地出帧）；MCP image content 块，编码 ≤256 KiB（350_000 字符硬顶） |
| creator_scene_inspect | projectId、revision、objectId | — | 只读（需 Studio）；只回白名单字段，`creator_object_not_found`=非本项目的对象/挂载/布局锚点 |
| creator_scene_validate | projectId | revision、validationProfile（仅 `"static"`） | 只读（需 Studio）；Studio 合并 city-sdk 语义诊断与宿主结构/资产事实，需 City runtime 的项显式 `unchecked` |
| creator_capabilities_list | — | category（≤64 字符；未知类别返回 `creator_capability_unknown`）、schemaVersion（仅支持 1） | 只读；**静态契约，离线可用**（DoD §10） |
| creator_layout_list | — | limit（1..=16，默认 8） | 只读；返回 legacy `layouts` 与独立 City 的 `cityLayouts`（含 cityId/cityRevision） |

**preview→commit 语义**：所有写操作先经 preview 得到 `previewId`——预览是实例绑定、revision 绑定、短生命周期、**一次性**的；`creator_project_commit` 用同一 `operationId` 提交，Studio 侧用户确认期间返回 `creator_confirmation_required`（不是错误重试信号，见 §6.3）。SDK 语义否决的预览不可能被提交：宿主在 commit 时复核预览附带的校验信封。

### 3.2 发布与试玩（5 个）

| MCP 工具 | 必需入参 | 可选入参 | 类别 |
|---|---|---|---|
| creator_project_publish | projectId、expectedRevision | — | 写入；发布为不可变本地 City release；项目须含有效 City mount |
| creator_playtest_start | releaseId（ASCII 字母数字与 `.` `_` `:` `-`） | projectId、expectedRevision（release 归属预检）、requestId（原样回传）、gameType | 写入；成功后自动注册为 playtest 作业（§3.7） |
| creator_playtest_result | runId | — | 只读；状态 pending/claimed/completed/cancelled/failed/expired + 失败码 + 有界证据摘要 |
| creator_playtest_cancel | runId | — | 写入；取消 pending/claimed 并释放活动租约；对已终态 run 返回原终态（cancelled=false）；未知 runId 返回 not_found |
| creator_playtest_history | projectId、limit（1..=32） | — | 只读；证据是客户端自报的玩法状态，不是反作弊/排行榜证明 |

**gameType 断言语义**：游戏类型在发布时冻结进 release；`gameType`（`"driving" | "flight"`）是调用方的可选断言，与 release 冻结值不一致时**显式失败**（fail closed），不会静默按 release 的类型试玩。用 `creator_capabilities_list`（category `playtest`/`project`）或 §3.8 的 `creator_game_type_list` 查类型词汇。

### 3.3 城市与世界（16 个中的 13 个，全部需 `--enable-city-tools`）

| MCP 工具 | 必需入参 | 可选入参 | 类别 |
|---|---|---|---|
| creator_city_create | name（≤120）、seed（0..=u32::MAX）、profile（≤16 KiB 对象）、operationId | — | 写入；建独立 City 草稿，不改活动 City |
| creator_city_create_from_world | name、packageId、version、operationId | — | 写入；从已安装 city-world 包建草稿并钉住包摘要；不启动独立 runtime |
| creator_city_list | limit（1..=50） | cursor（≤128） | 只读；不含 legacy City |
| creator_city_read | cityId | revision（已保留的历史版本） | 只读；不加载 City runtime |
| creator_city_diagnostics | cityId、limit（1..=100） | — | 只读；跨重启保留的脱敏预览诊断 |
| creator_city_edit_preview | cityId、baseRevision | name/seed/profile（配方形态）**或** operations（world.set 形态） | 预览（不落盘）；两种形态互斥，见下 |
| creator_city_patch_preview | cityId、baseRevision、patch（对象，或 null 清除） | — | 预览（不落盘；patch ≤256 KiB；运行时几何未检查） |
| creator_city_edit_commit | cityId、previewId、expectedRevision、operationId | — | 写入；只保存草稿，不加载/渲染 City |
| creator_city_view | cityId、revision | — | 只读视口；返回 loading，不代表已出帧 |
| creator_city_view_status | cityId、revision | — | 只读；loading / ready / failed |
| creator_city_capture | cityId、revision | — | 只读；对 ready 视口出有界 JPEG，绑定当前已保存 revision |
| creator_city_layout_read | cityId、revision | — | 只读；读当前渲染草稿的有界道路锚点快照（按 cityId+revision+seed 定界） |
| creator_city_layout_save | cityId、revision | — | 写入；快照从活动 Studio 视口捕获（布局不可由调用方提供），见下 |

**`world.set` 能力投影用法**（`creator_city_edit_preview` 的 operations 形态）：

- 形态 B：`operations` 为 1..=16 条 `{op:"world.set", preset?, params?}`（每条必须有 `op`）；`preset` ≤64 字符，`params` 是能力键控参数对象（如 `{"shape.family":"lobed"}`）。
- 键/范围/预设的**唯一来源**是 `creator_capabilities_list` category `worlds`：`budgets`（maxOperationsPerPreview=16、maxParametersPerSet=32、maxRequestBytes=8192，即 16 ops / 32 params / 8 KiB）、`generators`（如 `arid-dunes-v1`、`coastal-islands-v1`，各带 contractVersion、参数表与 `presets`）、`operation` 字段（当前仅 `world.set`）。
- `style.set` 未编目，显式拒绝（`world_style_unsupported`）；两种编辑形态混发返回 `world_profile_invalid_parameters`。
- `world.set` 必然使布局失效（世界进入新 revision）：已保存的布局快照仍绑定旧 revision，提交后需在当前 revision 上重新 `creator_city_layout_save`；跨 revision 读旧布局得 `creator_layout_scope_invalid`。布局内容变化或降版保存返回 `creator_layout_revision_conflict`。

**`creator_city_layout_save` 补充**：快照格式 v3（锚点 + 关联 + 锚点引用的几何）。对同一 City revision 重存时，若布局内容未变，会把既有 v2 快照就地升级为 v3——已发布 release 引用该 revision，因此无需重发布即获得几何；布局内容变化或降版则失败（`creator_layout_revision_conflict`）。保存布局不绑定游戏项目。

### 3.4 飞行器（creator_vehicle_*，4 个）

| MCP 工具 | 必需入参 | 可选入参 | 类别 |
|---|---|---|---|
| creator_vehicle_list | — | limit（1..=50，超量截断并标 `truncated`） | 只读；**静态契约，离线可用** |
| creator_vehicle_preview | projectId、baseRevision、vehicle（对象） | operationId | 预览（不落盘）；≤16 KiB MCP 载荷预检 |
| creator_vehicle_define | projectId、baseRevision、vehicleId、label、flightModel（`fixed-wing`/`flapping`/`vtol`）、physics、bounds（halfLengthM/halfWidthM/halfHeightM，封闭对象）、operationId | modelAssetId（null=程序化占位模型，或项目 assetId） | 写入 |
| creator_vehicle_inspect | projectId、vehicleId | revision（漂移校验） | 只读；宿主只回事实，不回推导性能 |

**契约与边界**：

- 物理键集合按 flightModel 分档（fixed-wing 8 键、flapping 另加 flapFrequencyHz/flapAmplitudeRad、vtol 另加 hoverClimbRateMps），键/范围/跨字段比值全部来自 `creator_vehicle_list`（`physicsKeys`/`physicsBounds`/`physicsRatios`/`boundsLimits`/`cameraBounds`）。预设两份：`vehicle.ornithopter`（扑翼机）、`vehicle.fixed-wing-light`（固定翼轻型机）；复制预设后只调有界参数。项目车辆上限 16 台、单画像 8 KiB（宿主执行；`creator_vehicle_budget_exceeded`）。
- define 面不接收 camera（按 bounds 确定性派生）；`modelAssetId` 只接受项目资产引用或 null，不接受本地路径或文件字节。
- `creator_vehicle_preview` 的 `estimatedPerformance` 投影由 Studio 用 city-sdk 的 `estimateVehiclePerformanceV1` 计算后注入（宿主不自推导）；返回 previewId，可用 `creator_project_commit` 提交或直接 `creator_vehicle_define`。`vehicle` 接受 define 形状对象或带 camera 的完整画像。
- `creator_vehicle_inspect` 只回白名单 VehicleProfileV1 事实；需要投影时调用方用同一 SDK 函数自行计算。

**headless 分档现状（E5 首片已落地）**：`creator_vehicle_preview` 与 `creator_city_edit_preview`（operations 形态）在 Studio 信箱不可用（`plugin_unavailable`）时，退化为**本地结构子集校验**——数据源是嵌入产物 vehicles.json / worlds.json（键集合/范围/枚举/比值），通过后返回 `validation:"structural"` 并标记 `commitBlocked:"deferred-semantic"`，**绝不签发 previewId**（commit 必须等 Studio 补验信封）；vehicle 预估按 vehicles.json 的 `performanceDerivation`/`performanceVectors` 声明式计算。`creator.vehicle.define` 与 scene/game 语义校验**不在结构子集内**——仍需 Studio（维持 `plugin_unavailable` + §4 recoveries 建议）。本组离线/无头可用的还有 `creator_vehicle_list`、`creator_capabilities_list`、§3.7/§3.8 全部工具。实现见 creator_studio.rs 的 `headless_vehicle_structural` / `headless_world_operations`（E5 首片提交 `401bf6b8`）；city-sdk WASM 嵌入（完整语义进宿主）是后续单独立项。

### 3.5 锚点（creator_city_anchor_*，3 个，需 `--enable-city-tools`）

| MCP 工具 | 必需入参 | 可选入参 | 类别 |
|---|---|---|---|
| creator_city_anchor_list | cityId | revision、capability（`drive`/`walk`/`fly`）、kind（`spawn`/`route`/`zone`/`object`）、limit（1..=256） | 只读（Studio 打开时可用） |
| creator_city_anchor_upsert | cityId、baseRevision、anchors（1..=64 个对象）、operationId | — | 写入；产生新的不可变 City revision |
| creator_city_anchor_remove | cityId、baseRevision、anchorIds（1..=64）、operationId | — | 写入；产生新的不可变 City revision |

**锚点几何规则**（upsert）：每个锚点要么复用 City 既有 `geometryRef`，要么自带空域几何 `{id, kind, capabilities, position:{x,y,z}, radiusMeters}`（米；zone/route 必须带 radius，spawn 可省略），以 `creator-air:<id>` 几何条目入快照——飞行航线不再必须落在道路节点上。capabilities 必须含 `fly` 且去重。编写显式几何需要 v3 布局快照（先跑 `creator_city_layout_save`）。

### 3.6 绑定（creator_mount_* + creator_game_bind_preview，4 个）

| MCP 工具 | 必需入参 | 可选入参 | 类别 |
|---|---|---|---|
| creator_mount_list | projectId | revision | 只读；回项目绑定的类型化挂载与冻结的 gameType/vehicleId |
| creator_mount_bind | projectId、baseRevision、mountId、entryAnchorId、bindings（对象）、operationId | vehicleId、parameterOverrides | 写入；槽位数与锚点能力（含 fly）被检查；**调用方永不出示摘要（digest）** |
| creator_mount_unbind | projectId、baseRevision、mountId、operationId | — | 写入 |
| creator_game_bind_preview | projectId、baseRevision、mountId、entryAnchorId、bindings | vehicleId、parameterOverrides | 预览（不落盘）；槽位数、锚点存在性与必需能力（含 fly）；依赖 City runtime 的可达性/视觉检查一律报 `unchecked`，绝不报 passed |

### 3.7 会话与作业（creator_session_* / creator_job_*，7 个，全部离线、无需任何开关）

| MCP 工具 | 必需入参 | 可选入参 | 类别 |
|---|---|---|---|
| creator_session_open | agentId（≤128） | projectId、cityId（各 ≤128，共同构成 scope） | 本地簿记（写 sessions.sqlite，不属本地写权限面） |
| creator_session_status | sessionId | — | 本地簿记 |
| creator_session_close | sessionId | — | 本地簿记 |
| creator_job_list | sessionId | kind（`layout-build`/`world-apply`/`playtest`/`capture`） | 本地簿记 |
| creator_job_status | jobId | — | 本地簿记 |
| creator_job_wait | jobId | timeoutMs（100..=30000，默认 30000） | 本地簿记；阻塞轮询（500ms 步长） |
| creator_job_cancel | jobId | — | 本地簿记；协作式取消位 |

**断线重连 = 一次 open/status 恢复全部上下文**：

- `creator_session_open` 以 `agentId + scope(projectId, cityId)` 为身份：对已 open 的同身份会话**幂等重放**——返回同一 `sessionId` 加全部未决操作与作业。Agent 进程崩溃或断线后，重新 open 一次即恢复完整现场；也可以用 `creator_session_status` 按 sessionId 读取同一份视图（状态、有界操作时间线、开放作业）。
- 时间线聚合宿主编排库（只读）：commits 来自 `creator_operations`、试玩来自 `creator_playtest_runs`（各限 20 条、时间线合计 50 行），宿主库缺席时如实标注 `hostLedgerAvailable:false` 而不是失败。
- 每 agent 最多 4 个 open 会话（同 scope 重放不占名额），超限返回 `creator_session_limit_exceeded`（附 next → `creator_session_status`）。关闭的会话保留 7 天供审计，之后清理；关闭后 `creator_session_status` 仍可读（state=closed）。
- **作业统一面**：`creator_playtest_start` 成功即注册为 playtest 作业（kind=`playtest`，注册时不归属会话，对所有会话可见）；playtest 作业的活状态从宿主试玩账本实时解析（pending/claimed→running、completed→ready、failed/cancelled/expired 原样）。其余 kind（layout-build / world-apply / capture）为宿主长作业预留。
- **`creator_job_wait` 30 秒上限**：阻塞至作业终态（ready/failed/cancelled/expired）或超时；超时**不是错误**——返回 `ok:true` + 运行中快照 + `waitTimedOut:true`，调用方稍后重试 wait 或改用 `creator_job_status`。
- 取消是协作式的（置 `cancelRequested`，引擎在下个安全点生效）；对 playtest 作业调用 `creator_job_cancel` 返回 `creator_job_not_cancellable` 并附 next → `creator_playtest_cancel`（携带 runId）——试玩取消走宿主试玩生命周期。

### 3.8 判别（creator_game_type_list，1 个，离线）

| MCP 工具 | 必需入参 | 可选入参 | 类别 |
|---|---|---|---|
| creator_game_type_list | — | status（`builtin-adapter`/`prototype`/`planned`） | 只读；离线 |

- 数据源 = `creator_capabilities_list` 产物里的 `gameTypes` 投影（app 适配器真实注册状态经生成链进入目录）；当前 6 个类型：4 个 `builtin-adapter`（miami.flight-v1 驾驶飞机、miami.driving-v1 驾车、miami.mecha-v1 机甲战棋、miami.cinema-v1 航拍）、1 个 `prototype`（creator.flight-ornithopter-prototype-v1 扑翼飞行·飞行原型）、1 个 `planned`（creator.flight-ornithopter-v1 扑翼飞行）。
- **playtestSupported 只认 `builtin-adapter`**——「模板存在 ≠ 可玩」：模板存在于 project 类别的 templates 列表，不代表该类型注册了可试玩的运行时适配器；非可玩类型在返回里带 `note` 说明。

## 4. 恢复建议（recoveries）机制与 `next` 字段

- creator 域错误经 `mcp::attach_creator_recovery`（crates/agent-vitals-mcp/src/mcp/mod.rs）附加 `next` 字段：查 `creator_studio::recovery_for(error.code)`，命中则把建议对象挂到错误上（字段结构见 crates/agent-vitals-runtime-core/src/envelope.rs 的 `with_next`）。
- 建议内容来自生成产物 **`assets/creator/capabilities.json` 的 `recoveries` 段**——这是能力目录的单一来源：Agent（MCP `next`）与 Studio UI 的错误恢复建议**同源同文**，由 `scripts/generate-creator-capabilities.mjs` 生成，不散落两处。
- 每条建议形如 `{code, tool, args, note}`；当前 10 条的 `args` 均为 `{}`（调用建议工具时无需参数）。未命中的错误码不带 `next`。
- 速查表（逐条自 `assets/creator/capabilities.json` recoveries 段复制）：

| 错误码 | 建议下一步（tool） | 说明（note） |
|---|---|---|
| creator_layout_not_ready | creator_city_view_status | 布局尚未生成完毕；轮询状态直到 ready 后再读取布局。 |
| creator_layout_not_found | creator_city_layout_save | 该版本尚无布局；先让城市视口 ready 再保存布局。 |
| revision_conflict | creator_project_read | 项目已被他人推进；重读最新 revision 后以新基线重开预览。 |
| creator_city_revision_unavailable | creator_city_read | 请求的历史版本已被覆盖；改读当前 revision。 |
| preview_expired | creator_scene_preview | 预览已过期；以当前 revision 重新发起预览后再提交。 |
| operation_id_conflict | creator_operation_status | 同一 operationId 被用于不同请求；换新 operationId，或先查询既有结果。 |
| creator_playtest_not_claimed | creator_playtest_start | 尚无活跃试玩；先 start 一次试玩再读取结果。 |
| creator_playtest_instance_mismatch | creator_playtest_start | 试玩被其他实例领取；重新 start 开启新的试玩。 |
| creator_capture_unavailable | creator_city_view_status | 视口不可用（未打开/无头）；等待视口 ready，或改用结构校验与无头规则试玩。 |
| creator_validation_scope_mismatch | creator_project_read | 信封作用域与请求不符；重读项目后让 Studio 重新附发信封。 |

## 5. 稳定错误码表

creator 域错误以 `tools/call` 结果的 `isError:true` + envelope 内稳定 `error.code` 呈现，**不是** JSON-RPC error。宿主侧错误码在 `creator_studio.rs` 的 `call_error` 统一映射为 MCP 稳定码；会话/作业工具直接返回自己的稳定码。

### 5.1 会话与作业（creator_session.rs）

| 稳定码 | 含义 | 处理 |
|---|---|---|
| creator_session_not_found | sessionId 未知 | 先 creator_session_open 建会话 |
| creator_session_limit_exceeded | 该 agentId 已有 4 个 open 会话 | next → creator_session_status，关闭一个后重开 |
| creator_job_not_found | jobId 未知 | creator_job_list 后重试 |
| creator_job_not_cancellable | 作业已终态；或目标是 playtest 作业 | 终态作业读 status 即可；playtest 走 creator_playtest_cancel（附 next） |
| storage_unavailable | 本地会话库（state/creator/sessions.sqlite）不可读写 | 检查数据根写权限后重试 |
| invalid_argument | 参数缺失/类型错误 | 修正后重试 |

### 5.2 Studio 域（creator_studio.rs `call_error` 映射）

**传输与插件**

| 宿主码 | MCP 稳定码 | 含义 |
|---|---|---|
| plugin_call_timeout / plugin_call_expired / plugin_call_method_unavailable / plugin_unavailable / creator_method_unavailable / plugin_call_invalid | plugin_unavailable | Studio 未打开、WebView 实例失效或当前构建不提供该方法；打开官方 Creator Studio 插件后重试 |
| plugin_call_capacity | busy | Studio 本地请求容量已满 |
| plugin_call_too_large | invalid_argument | 超出本地 IPC 载荷上限 |

**项目与草稿**

| 宿主码 | MCP 稳定码 | 含义 |
|---|---|---|
| creator_project_not_found / creator_city_not_found / creator_city_revision_unavailable / creator_release_not_found / creator_playtest_not_found / creator_object_not_found / creator_layout_not_found / creator_vehicle_not_found | not_found | 目标不存在或历史 revision 已不保留；重新列表/重读后重试 |
| creator_city_invalid / operation_id_conflict | invalid_argument | City 请求非法；或同一 operationId 被用于不同输入（换新 operationId，或先查 creator_operation_status） |
| revision_conflict | revision_conflict | 项目 revision 已推进；重读后以新基线重新预览 |
| creator_independent_city_runtime_unavailable | data_unavailable | 独立 City runtime 尚未可用；该 release 不能在活动 legacy City 里试玩 |

**world.set 参数（`creator_city_edit_preview` operations 形态）**

| 宿主码 | MCP 稳定码 | 含义 |
|---|---|---|
| world_params_unknown | invalid_argument | 生成器不认识该参数键；用 creator_capabilities_list category `worlds` 列有效键 |
| world_params_out_of_range | invalid_argument | 值类型错误或超出声明范围；核对能力描述符 |
| world_params_invalid | invalid_argument | 结构非法；每条操作需 op=world.set 加 preset 和/或 params |
| world_params_budget_exceeded | invalid_argument | 超出预算（≤16 ops、≤32 params、8 KiB） |
| world_preset_unknown | invalid_argument | 未知预设 id；预设列在 creator_capabilities_list category `worlds` |
| world_style_unsupported | invalid_argument | style.set 未编目，本构建不可调用（仅接受 world.set） |
| world_profile_invalid_parameters | invalid_argument | operations 与 name/seed/profile 两形态互斥；每次预览只发一种 |

**预览与确认**

| 宿主码 | MCP 稳定码 | 含义 |
|---|---|---|
| creator_confirmation_required | creator_confirmation_required | 编辑在 Studio Agent 面板等用户确认；**不要**换 operationId 重试，用同一 operationId 轮询 creator_operation_status |
| creator_approval_busy | busy | 已有另一条 Agent 编辑在等确认 |
| creator_approval_preview_unavailable / preview_expired | preview_expired | 预览不可用/过期/已消费；重新预览 |
| creator_approval_scope_mismatch | revision_conflict | 确认与预览的项目/revision/编辑类型不匹配 |
| creator_preview_budget_exceeded | busy | 活动预览过多；等过期后重试 |
| creator_preview_invalid | invalid_argument | SDK 语义校验否决；按预览返回的诊断修复后重新预览 |
| creator_validation_required / creator_validation_invalid / creator_validation_scope_mismatch / creator_capability_version_mismatch | invalid_argument | 校验信封缺失/畸形/作用域或能力版本不符；对当前 Studio 重新预览 |
| creator_validation_profile_unsupported | invalid_argument | validationProfile 仅支持 "static"；runtime 检查以 unchecked 报告 |
| creator_capability_unknown / creator_capability_version_unsupported | invalid_argument | 未知能力类别（去掉 category 列出支持类别）；schemaVersion 仅支持 1 |
| creator_template_not_found / creator_template_asset_invalid | invalid_argument / data_unavailable | 模板 id 不存在（category `project` 的 templates 里找）；模板资产校验失败需重装桌面 bundle |
| creator_scene_* / creator_mount_* / creator_skin_not_found / creator_game_invalid / creator_game_operation_unsupported | invalid_argument | 场景/挂载/皮肤/玩法载荷未过 schema 或预算校验 |

**试玩**

| 宿主码 | MCP 稳定码 | 含义 |
|---|---|---|
| creator_playtest_active | busy | 已有试玩在跑；creator_playtest_cancel 或等它结束 |
| creator_playtest_instance_mismatch | permission_denied | 该试玩属于其他 Studio 会话实例 |
| creator_playtest_expired | preview_expired | 试玩在完成前过期；重新 start |
| creator_playtest_terminal / creator_playtest_not_claimed / creator_playtest_evidence_required | invalid_argument | 试玩已终态或状态迁移非法；先 start 再读结果 |
| creator_release_project_mismatch / creator_release_revision_mismatch | invalid_argument | releaseId 与声明的项目/revision 不符 |
| creator_city_patch_seed_mismatch / creator_city_patch_invalid / creator_city_patch_incompatible | invalid_argument | patch 种子与 City 不符/含不允许数据/与生成器不兼容 |

**捕获、布局与存储**

| 宿主码 | MCP 稳定码 | 含义 |
|---|---|---|
| creator_capture_unavailable | data_unavailable | 视口不可用；打开 Studio 并加载 3D 视口后重试，或改用 creator_scene_describe |
| creator_capture_budget_exceeded | invalid_argument | 编码帧超出有界图像预算；拉近镜头或缩小视口重试 |
| creator_layout_not_ready / creator_layout_scope_invalid | data_unavailable | 道路布局未就绪 / 与当前 City revision 不匹配 |
| creator_store_unavailable / plugin_call_store_unavailable / creator_store_corrupt / creator_store_migration_failed / creator_store_unwritable | data_unavailable | 本地 Creator 存储不可用/损坏/迁移失败/不可写；按提示修权限或按事实重建 state/creator |
| creator_store_locked | busy | 存储被其他进程锁定；当前写完成后重试 |
| permission_denied | permission_denied | 当前插件实例未授权该请求（或写入开关未开，见 §6.1） |
| （其余未映射宿主码，如 creator_layout_revision_conflict） | data_unavailable | 消息携带原始码；按工具语义处理 |

**车辆**

| 宿主码 | MCP 稳定码 | 含义 |
|---|---|---|
| creator_vehicle_invalid | invalid_argument | 画像结构校验失败；physics 键须匹配 flightModel（见 creator_vehicle_list），define 不接收 camera |
| creator_vehicle_out_of_bounds | invalid_argument | 物理/相机/边界值超出 v1 契约范围；核对 physicsBounds/cameraBounds/boundsLimits |
| creator_vehicle_unphysical | invalid_argument | 翼载（质量/翼面积）或推重比（推力/质量）超出物理可行比值；调 massKg、wingAreaM2、thrustN |
| creator_vehicle_budget_exceeded | invalid_argument | 项目已有 16 台车辆或画像超 8 KiB 预算 |
| creator_vehicle_asset_not_found | invalid_argument | modelAssetId 不是已注册项目资产；用 Studio 资产选择器导入或传 null 占位 |
| creator_vehicle_not_found | not_found | vehicleId 不是本项目的车辆；用 creator_vehicle_inspect 核对 |

### 5.3 模块级（mod.rs / 传输层）

| 稳定码 | 含义 |
|---|---|
| invalid_argument | 未知参数字段、参数不是对象；或城市域未开启（`--enable-city-tools`，文案明确指引） |
| internal_error | `tool registered but not wired`——specs() 注册的工具未进分发 match；`tool_specs_and_dispatch_agree` 已逐工具守卫，正常构建不应出现 |

## 6. 权限与开关

### 6.1 `--allow-local-writes`（写操作门）

强制点在 `creator_studio.rs` 的 `run()` 内（每个写入工具入口先查 `allow_local_writes`，消息统一要求 `data-mcp serve --allow-local-writes`），共 **14 个**：

- Studio 域 8 个：creator_playtest_start、creator_playtest_cancel、creator_project_create、creator_project_commit、creator_project_publish、creator_mount_bind、creator_mount_unbind、creator_vehicle_define。
- 城市域 6 个（另需 `--enable-city-tools`）：creator_city_create、creator_city_create_from_world、creator_city_edit_commit、creator_city_layout_save、creator_city_anchor_upsert、creator_city_anchor_remove。

未带开关时默认 dispatch 恒只读：即使编译了 `mcp-internal` feature，客户端也只会因缺开关被拒，不会获得写权限。`creator_session_*`/`creator_job_*`/`creator_game_type_list` 是本地只读簿记/判别（`creator_job_cancel` 只置协作取消位、`creator_session_open` 只写本地 sessions.sqlite），不在这 14 个之列，也不需要开关。

参数校验先于授权门：可选字段类型错误（如字符串形式的 revision）会得到 `invalid_argument` 而不是 `permission_denied`——调用方先修参数再看授权。

### 6.2 `--enable-city-tools`（实验域门）

16 个 `creator_city_*` 工具默认从 `tools/list` 隐藏；开启后全部进入分发（`independent_city_tools_are_hidden_unless_explicitly_enabled` 守卫）。未开启时直接调用返回 `invalid_argument`，文案："Independent City tools are experimental and disabled. Start `data-mcp serve --enable-city-tools` to use them."

### 6.3 写操作纪律（preview / 摘要 / CAS）

1. **先预览后提交**：所有写操作经 preview 得到 `previewId`——实例绑定、revision 绑定、短生命周期、一次性。重复消费返回 `preview_expired`。
2. **operationId 幂等**：超时/响应丢失后用**同一** operationId 重试或查 `creator_operation_status`；同一 operationId 换内容返回 `operation_id_conflict`。`creator_confirmation_required` 期间不要另起 operationId。
3. **revision CAS**：project_commit / project_publish / city_edit_commit 用 `expectedRevision`，mount/anchor/vehicle 写入用 `baseRevision`；不匹配返回 `revision_conflict`。
4. **语义校验绑定**：game/scene/vehicle 预览由官方 Studio 经 city-sdk 校验，宿主复核校验信封后绑定结论——SDK 否决的预览不可能被提交；Rust 侧独立复核结构、预算、引用与资产字节。
5. **不经 MCP 进入的内容**：mount 绑定不接受调用方摘要；vehicle define 不接受 camera、本地路径、原始文件字节；City 布局快照只能从活动视口捕获，不接受调用方提供。

## 7. 端到端示例

### 7.1 会话恢复流（断线重连）

```text
1) creator_session_open {"agentId":"codex-main"}
   → {"sessionId":"csession-…","state":"open","operations":[…],"jobs":[…]}

2) 日常操作（节选）：
   creator_game_preview {projectId, baseRevision, game}      → previewId
   creator_project_commit {projectId, previewId, expectedRevision, operationId}
   → creator_confirmation_required（用户在 Studio 确认中）
   creator_operation_status {projectId, operationId}         → 确认后 committed

3) —— 客户端进程被杀/断线 ——

4) 重连后**一次调用恢复全部上下文**：
   creator_session_open {"agentId":"codex-main"}
   → 同一 sessionId + 未决 operations（含上一步的 commit）+ 全部 jobs
   （若已知 sessionId，也可以 creator_session_status {sessionId} 读取同一视图）

5) 等长作业（30s 上限，超时不是错误）：
   creator_job_wait {"jobId":"cjob-…","timeoutMs":30000}
   → {"job":{…,"status":"running"},"waitTimedOut":true}       # 稍后再 wait
   → {"job":{…,"status":"ready"}}                             # 或直接终态

6) 收尾：creator_session_close {"sessionId":"csession-…"} → {"cleared":N,"state":"closed"}
```

### 7.2 飞行器定义 → 预览 → define → commit

```text
0) 查契约（离线可用）：
   creator_vehicle_list {"limit":16}
   → presets[0] = vehicle.ornithopter（扑翼机, flapping），
     physicsKeys.flapping = [massKg, wingAreaM2, thrustN, maxSpeedMps, dragCoefficient,
                             turnRateRps, climbRateMps, sinkRateMps,
                             flapFrequencyHz, flapAmplitudeRad]

1) 定义（复制预设，只调有界参数；camera 不接受；modelAssetId=null 用程序化占位）：
   creator_vehicle_define {
     "projectId":"proj-…", "baseRevision":7,
     "vehicleId":"vehicle.scout", "label":"侦察扑翼机",
     "flightModel":"flapping",
     "physics":{"massKg":340,"wingAreaM2":18,"thrustN":10000,"maxSpeedMps":120,
                "dragCoefficient":0.1,"turnRateRps":0.9,"climbRateMps":34,
                "sinkRateMps":26,"flapFrequencyHz":2.4,"flapAmplitudeRad":1.1},
     "bounds":{"halfLengthM":3.6,"halfWidthM":4.8,"halfHeightM":1.4},
     "modelAssetId":null,
     "operationId":"op-veh-1"}

2) 有 Studio 时，先干跑看投影与诊断（不落盘）：
   creator_vehicle_preview {projectId, baseRevision, vehicle:{…define 形状…}}
   → estimatedPerformance（Studio 用 city-sdk estimateVehiclePerformanceV1 计算：
     cruiseSpeedMps ≈ 66.7、thrustAccelMs2 ≈ 29.4、wingLoadingKgPerM2 ≈ 18.9 …）
   → 需要'先给用户看再写'时：creator_project_commit {previewId,…}；否则跳到第 1 步直接 define

3) 常见拒绝：
   - physics 混入 camera 字段 / 本地路径 modelAssetId → creator_vehicle_invalid
   - 值越界（如 thrustN 超出 physicsBounds） → creator_vehicle_out_of_bounds
   - 翼载/推重比不可行 → creator_vehicle_unphysical（调 massKg/wingAreaM2/thrustN）
   - 第 17 台车或画像超 8 KiB → creator_vehicle_budget_exceeded
```

### 7.3 world.set 编辑流（operations 形态）

```text
0) 能力投影（离线可用）：
   creator_capabilities_list {"category":"worlds"}
   → budgets:{maxOperationsPerPreview:16, maxParametersPerSet:32, maxRequestBytes:8192}
     generators:{"arid-dunes-v1":{contractVersion:2, presets:[disc,lobed,dumbbell,coastal], …},
                 "coastal-islands-v1":{contractVersion:1, presets:[vice-bay], …}}
     operation:"world.set"        # style.set 未编目，不可调用

1) 预览（不落盘；两形态互斥，这里用 operations 形态）：
   creator_city_edit_preview {"cityId":"city-…","baseRevision":12,
     "operations":[{"op":"world.set","preset":"lobed"}]}
   # 或 {"op":"world.set","params":{"shape.family":"lobed"}}（键/范围来自 generators 参数表）
   → previewId（实例 + revision 绑定、一次性、短生命周期）
   # 1..=16 条；超 16 ops / 8 KiB / 32 params / 未知键或预设 → 对应 world_* 稳定码

2) 提交（CAS + 幂等）：
   creator_city_edit_commit {"cityId":"city-…","previewId":"…",
     "expectedRevision":12,"operationId":"op-world-1"}
   → 草稿进入新 revision（只保存，不加载/渲染 City）

3) 解读布局失效（layout invalidation）：world.set 必然产生新的世界 revision——
   - 旧布局快照仍绑定旧 revision：creator_city_layout_read 在**当前** revision 上
     读取的是新布局（revision 必填，按 cityId+revision+seed 定界）；
   - 新 revision 需重新捕获：creator_city_layout_save（Studio 视口必须加载该草稿；
     布局不可由调用方提供）；
   - 跨 revision 用旧布局 → creator_layout_scope_invalid（布局与当前 City revision 不匹配）；
   - 同 revision 重存且布局未变 → v2 快照就地升级 v3，已发布 release 免重发布获得几何；
     布局内容变化或降版 → creator_layout_revision_conflict。
   注：world.set 的 headless 结构响应带 `commitBlocked:"deferred-semantic"` 与 `checks.layoutInvalidation:"new-world-revision"`；宿主签发的完整预览响应中没有 `layoutInvalidation`/`commitBlocked` 字段；布局失效
   是上面这套「revision 定界 + 重新捕获」的可观察语义（§3.4 的无头分档同样未实现）。

4) 绑定到项目（可选）：creator_project_create {"template":"flight-checkpoint",
   "worldRevision":"…","cityId":"city-…","operationId":"op-proj-1"}
   → 项目冻结 cityId/cityRevision/layoutId，发布与试玩都按这套绑定走。
```

## 8. 连接自检清单

按顺序执行；每步都有明确预期。业务错误以 `tools/call` 结果的 `isError: true` + envelope 内 `error.code` 呈现，不是 JSON-RPC error。

1. **进程握手。** 启动 serve 后 stderr 出现 `data-mcp: serving on stdio (protocol 2025-06-18, data_home …)` 横幅。
2. **initialize。** 返回 `protocolVersion: "2025-06-18"`、`capabilities.tools`、`serverInfo.name: "Oh Agent MCP"`。initialize 之前的请求被拒（JSON-RPC error `-32002`）。
3. **tools/list。** 默认共 58 个工具，其中 creator_* 34 个（26 个 Studio 域：creator_layout_list、creator_project_list、creator_project_read、creator_operation_status、creator_playtest_history、creator_playtest_start、creator_playtest_result、creator_playtest_cancel、creator_project_create、creator_game_preview、creator_scene_preview、creator_project_commit、creator_project_publish、creator_scene_describe、creator_scene_capture、creator_capabilities_list、creator_scene_inspect、creator_scene_validate、creator_mount_list、creator_mount_bind、creator_mount_unbind、creator_game_bind_preview、creator_vehicle_list、creator_vehicle_preview、creator_vehicle_define、creator_vehicle_inspect；8 个会话域：creator_session_open、creator_session_status、creator_session_close、creator_job_list、creator_job_status、creator_job_wait、creator_job_cancel、creator_game_type_list）。加 `--enable-city-tools` 后共 74 个，creator_* 凑满 50 个，额外包含 16 个：creator_city_create、creator_city_create_from_world、creator_city_edit_preview、creator_city_patch_preview、creator_city_edit_commit、creator_city_list、creator_city_read、creator_city_diagnostics、creator_city_view、creator_city_view_status、creator_city_capture、creator_city_layout_read、creator_city_layout_save、creator_city_anchor_list、creator_city_anchor_upsert、creator_city_anchor_remove。
4. **只读自检：creator_project_list。** 参数 `{"limit": 10}`。Studio 已打开：`ok:true` 与有界项目列表（没有项目时为空列表）；Studio 未打开：约 15 秒后 `plugin_unavailable`。
5. **离线自检（无需 Studio）：creator_capabilities_list `{}`。** 预期 `ok:true`，schemaVersion=1，含 project/scene/worlds/gameTypes 等类别；再试 `creator_game_type_list {}`（6 个类型，builtin-adapter 4 个 playtestSupported=true）与 `creator_session_open {"agentId":"smoke"}`（返回 sessionId）。
6. **写入开关自检（开关未开启时）。** 对 creator_project_create（或任一写入工具）发起调用，预期 `permission_denied`，消息明确要求 `data-mcp serve --allow-local-writes`。
7. **城市域开关自检（开关未开启时）。** 调 creator_city_list，预期不在 tools/list 且调用返回 `invalid_argument`（文案指引用 `--enable-city-tools`）。
8. **Studio 缺席自检。** 关闭 Creator Studio 后调用任一 Studio 路由工具（例如 creator_project_list），预期 `plugin_unavailable`，项目不发生任何写入。
9. **recoveries 自检。** 制造一次 `revision_conflict`（用过期 expectedRevision 提交），预期错误 envelope 携带 `next`：`{"tool":"creator_project_read","args":{},"note":…}`（§4）。
10. **项目服务可用性。** 创建项目或预览失败时按 §5 错误码处理：`revision_conflict` 重读重预览、`preview_expired` 重新预览、`not_found` 重新列项目、`busy` 保留原 operationId 退避重试、`invalid_argument` 修正字段后重试。

自检通过后，创作流程：list → read → preview → 用户在 Studio 确认 → commit；超时先查 creator_operation_status 或用同一 operationId 重试。多轮编辑建议全程挂一个 `creator_session_open` 会话，断线后按 §7.1 恢复。

## 9. 设计验收场景 → 当前验证方式映射

测试名均引用 `#[test]` 函数，逐个 grep 核实过。

| # | 场景 | Rust 自动化覆盖 | 需真实客户端 | 需桌面 bundle |
|---|---|---|---|---|
| 1 | 工具发现 + 无开关拒绝写入 | `tool_specs_and_dispatch_agree`、`creator_publish_tool_requires_explicit_local_write_permission`、`tool_schemas_are_closed_objects`（crates/agent-vitals-mcp/src/mcp/mod.rs）。开关拒绝测试目前只钉了 publish，其余写入工具的开关拒绝在 creator_studio.rs `run()` 内实现但无独立测试 | 用真实客户端验证默认 58 / 开启后 74 个工具 | — |
| 2 | Studio 未打开/被替换/过期时失败不写入 | `committed_operation_survives_studio_instance_replacement_but_preview_does_not`（apps/desktop/src-tauri/src/creator_projects.rs）、`typed_object_response_is_dropped_after_owner_instance_replacement_or_failure`（apps/desktop/src-tauri/src/plugin_host.rs） | 验证 Studio 关闭 → `plugin_unavailable` | Studio 完全未打开的 15 秒超时路径依赖活动 WebView 缺席，自动化测试未覆盖 |
| 3 | 创建→读 chunk→预览→UI 确认→提交→视口新 revision | 宿主侧：`project_preview_commit_revision_and_idempotency`（creator_projects.rs） | 端到端走通一次 | UI 确认卡片与 3D 视口刷新只能人工在 bundle 里确认 |
| 4 | 无效对象/越界/超预算/额外字段被拒绝，revision 不变 | `dispatch_rejects_unknown_arguments`、`dispatch_rejects_non_object_arguments`（mod.rs）；`creator_scene_accepts_only_bounded_explicit_box_colliders`、`creator_mount_rejects_anchors_disconnected_in_the_pinned_city_topology`、`mount_skin_operations_preview_commit_and_enforce_game_bindings`、`creator_playtest_history_is_registered_and_limits_are_bounded`（creator_projects.rs） | — | — |
| 5 | 预览过期/revision 推进/重复消费拒绝，重预览成功 | `project_preview_commit_revision_and_idempotency`（creator_projects.rs） | — | — |
| 6 | 提交响应丢失后原 operationId 只产生一次 revision | `project_preview_commit_revision_and_idempotency`、`failed_commit_keeps_preview_available_for_retry`（creator_projects.rs） | 用真实客户端模拟响应丢失后查 creator_operation_status | — |
| 7 | 两个不同 MCP 客户端行为与错误语义一致 | 无直接自动化；间接依赖所有客户端共用同一 dispatch（mod.rs 单一入口） | **尚未执行——本指南的核心待办** | — |
| 8 | 试玩取消/失败/完成形成唯一终态，release 快照不可变 | `playtest_start_result_cancel_reach_unique_terminal_states`、`playtest_handoff_is_release_pinned_city_bound_and_returns_once`、`city_release_is_immutable_revision_bound_and_filtered_by_current_layout`（creator_projects.rs） | 验证试玩闭环 | City 插件 claim/finish 与返回 Studio 需 bundle 实测 |
| 9 | MCP 输出不含路径/原始日志/提示词/凭证 | 工具面按构造只回有界 DTO（creator_studio.rs 无路径字段）；审计不带原始参数：`tools_call_emits_mcp_audit_event_without_raw_args`（apps/cli/src/mcp.rs） | 对真实客户端可见输出做最终检查 | — |

会话/作业域（E1/E2/E4）另有 creator_session.rs 内置测试：`sessions_replay_and_close`（同 agentId 重放、4 会话上限、关闭后审计窗口）、`playtest_jobs_resolve_from_the_host_ledger`、`unknown_session_fails_closed`。

待客户端实测清单（收口条件）：场景 1 的真实 tools/list、场景 2 的 Studio 缺席路径、场景 3 的 UI 确认与视口、场景 6 的响应丢失演练、场景 7 全部、场景 8 端到端、场景 9 的输出终检，以及 §7 三个示例在真实客户端各走通一次。

## 10. 数据边界提醒

- MCP 只返回创作所需字段：项目字段、对象引用、校验错误、试玩摘要。不暴露 authority DB、任意 SQL、任意文件路径、原始会话日志、用户提示词或凭证。
- 大文档有界分块：creator_project_read 单块 ≤32768 字节，按 `nextOffset` 拼接到 `complete=true`，用 `documentDigest` 校验。
- 预览负载有上限：creator_game_preview / creator_scene_preview 的 MCP 侧载荷各 ≤384 KiB（scene 操作仍限 1..=128 条），宿主业务预算 gameBytes=262144；creator_city_patch_preview 的 patch ≤256 KiB（cityPatchBytes）。插件信箱默认单条 64 KiB，仅上述三个预览方法按方法放宽（请求 384 KiB、响应 64 KiB，见 creator_studio.rs 的 `creator_budgets` 常量）。
- 图像出帧是有界预览：creator_scene_capture / creator_city_capture 编码帧 ≤256 KiB（350_000 base64 字符硬顶），超限显式拒绝（`creator_capture_budget_exceeded`），不做静默降档。
- 传输预算分层提案（边界优化文档 §5.5 的描述符声明式按方法 `localCallBudgets` requestBytes/responseBytes，宿主校验后对全部 creator 方法生效）**是设计提案，尚未实现**。当前实现仅有 `plugin_calls` 的预算参数（`call_with_budgets` / `respond_with_budget`）与上述预览方法的固定常量；creator_project_read、creator_scene_capture 等方法仍走默认 64 KiB 信箱。
- 工具调用不授予上传或后台网络能力。所选 Agent 服务会收到用户主动提交给它的项目上下文；连接与 UI 应说明这一点。
- 外部包、未验证插件和浏览器预览不得获得真实本机数据或 Creator 写权限。

## 11. 排错速查

| 现象 | 判断 | 处理 |
|---|---|---|
| 工具列表里没有 creator_* | 连的不是本仓库构建的 agent-vitals | 核对 `command` 指向 `target/release/agent-vitals` 并重连 |
| 工具列表里没有 creator_city_* | serve 未带 `--enable-city-tools` | 用 §1.1 完整命令重启 MCP；直接调用会得到带指引文案的 `invalid_argument` |
| 调用约 15 秒后 `plugin_unavailable` | Studio 未打开或 WebView 实例已失效 | 打开官方 Creator Studio 插件后重试 |
| `permission_denied` 且消息要求写入开关 | serve 未带 `--allow-local-writes` | 用 §1.1 的完整命令重启 MCP |
| `creator_confirmation_required` 反复出现 | 编辑在等用户确认，不是失败 | 用同一 operationId 轮询 creator_operation_status；确认后状态变 committed |
| `creator_session_limit_exceeded` | 该 agentId 已有 4 个 open 会话 | 按 next 用 creator_session_status 列出 open 会话，creator_session_close 一个后重开 |
| `creator_job_wait` 超时返回 waitTimedOut | 30s 上限到，作业仍在跑 | 这是正常返回不是错误；稍后再 wait 或用 creator_job_status |
| `creator_job_not_cancellable` 且目标是 playtest | 试玩取消走宿主生命周期 | 按 next 用 creator_playtest_cancel（带 runId） |
| gameType 断言失败（invalid_argument） | 断言值与 release 冻结类型不符 | 用 creator_capabilities_list/creator_game_type_list 核对类型词汇后重试 |
| `internal_error`（registered but not wired） | specs() 注册的工具未进 mod.rs 分发 match；当前代码所有工具均已路由（默认隐藏的 city 工具在开启后同样已路由），正常构建不应出现 | 重新 `cargo build --release` 后重连（`tool_specs_and_dispatch_agree` 已逐工具守卫） |
| `revision_conflict` / `preview_expired` | 项目已被推进或预览过期/已消费 | 按 §4 的 next 建议：重读 → 重新预览 → 重新提交 |
| 请求在 initialize 前被拒（-32002） | 客户端未按 MCP 握手顺序发送 | 走标准 initialize → notifications/initialized 流程 |
