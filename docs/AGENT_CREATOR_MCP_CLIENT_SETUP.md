# Creator MCP 多客户端接入指南（阶段 D）

日期：2026-11-12  
状态：接入文档；工具面与启动命令以代码为准  
关联文档：[Creator Agent 接入代码设计](AGENT_CREATOR_AGENT_INTEGRATION_CODE_DESIGN_2026_11_12.md)、[Data MCP 规格](AGENT_VITALS_DATA_MCP_SPEC.md)、[Data MCP 冒烟规格](AGENT_VITALS_DATA_MCP_SMOKE_TEST_SPEC.md)

结论先行：外部 MCP 客户端经本地 stdio（`agent-vitals data-mcp serve`）访问统一 Creator 工具。只读与预览工具不需要任何开关；写入工具需要 `--allow-local-writes`；所有 creator 工具都经活动的官方 Creator Studio WebView 路由，Studio 未打开返回 `plugin_unavailable`。本文给出前置条件、客户端配置示例、连接自检清单、设计 §11 验收场景的当前覆盖映射和数据边界提醒。

## 1. 前置条件

1. **桌面应用已安装并运行。** Creator 请求由桌面应用的 PluginHost 路由到 Creator Studio WebView；纯 CLI 进程不承载 Studio。桌面包按仓库规约经 bundle 构建：`cd apps/desktop/src-tauri && cargo tauri build --bundles app`，然后打开 `target/release/bundle/macos/Oh Agent.app`。
2. **官方 Creator Studio 插件已打开。** 这是每一次 creator 工具调用的前置条件；Studio 关闭时调用等待约 15 秒后返回 `plugin_unavailable`（crates/agent-vitals-mcp/src/mcp/creator_studio.rs 的 `call_error` 映射）。
3. **CLI 二进制可用。** `cargo build --release` 产出 `target/release/agent-vitals`（仓库根目录相对）。
4. **同一数据根。** 数据根解析为 `AGENT_VITALS_HOME` → `SKILL_VITALS_HOME` → `~/.agent-vitals`（存在旧 `~/.skill-vitals` 时兼容沿用，见 crates/agent-vitals-runtime-core/src/core/home.rs）。CLI 与桌面应用按进程各自解析；若设置 `AGENT_VITALS_HOME`，两边进程都要一致设置，否则插件调用信箱（`state/plugin-calls`）对不上。

### 1.1 服务启动命令（以 apps/cli/src/main.rs 为准）

```
agent-vitals data-mcp serve [--allow-local-writes]
```

- 子命令形式为 `data-mcp serve`；`--allow-local-writes` 是 `serve` 的唯一参数（`DataMcpAction::Serve`，apps/cli/src/main.rs）。
- 服务阻塞到 stdin 关闭，随后以退出码 0 结束；stdout 只出 JSON-RPC 帧，日志走 stderr（apps/cli/src/mcp.rs）。
- 不带开关时：只读与预览工具可用，写入工具返回 `permission_denied`。

## 2. MCP 客户端配置示例

**以客户端官方文档为准。** 以下只钉 server 侧事实：`command` 指向 `target/release/agent-vitals`，`args` 为 `["data-mcp", "serve", "--allow-local-writes"]`。不需要网络端口、token 或 OAuth；stdio 由客户端自行托管进程。

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
- 不同客户端对 stdio MCP 的安装/连接方式可以不同，但不改变工具的业务含义（设计 §8.1）。

## 3. 工具面（与 creator_studio.rs specs() 一致）

默认暴露 42 个工具；启动时加 `--enable-city-tools` 会再暴露 12 个独立 City 草稿实验工具（共 54 个）。以下工具名逐一核对自 crates/agent-vitals-mcp/src/mcp/creator_studio.rs 的 `specs()` 与 `run()`。协议为 JSON-RPC 2.0 行分隔帧；`initialize` 协议版本 `2025-06-18`，`serverInfo.name` 为 `Oh Agent MCP`。

| MCP 工具 | 必需入参 | 可选入参 | 类别 |
|---|---|---|---|
| creator_layout_list | — | limit（1..=16，默认 8）；返回 legacy `layouts` 与独立 City 的 `cityLayouts`（含 cityId/cityRevision） | 只读 |
| creator_project_list | limit（1..=100） | — | 只读 |
| creator_project_read | projectId | offset（默认 0）、maxBytes（1..=32768，默认 32768） | 只读 |
| creator_operation_status | projectId、operationId | — | 只读 |
| creator_playtest_history | projectId、limit（1..=32） | — | 只读 |
| creator_playtest_start | releaseId（ASCII 字母数字与 `.` `_` `:` `-`） | projectId、expectedRevision、requestId | 写入 |
| creator_playtest_result | runId | — | 只读 |
| creator_playtest_cancel | runId | — | 写入 |
| creator_project_create | template（模板 id 经 `creator_capabilities_list`（category `project`）发现）、operationId、worldRevision | cityId（绑定独立 City 草稿布局；省略则走 legacy 布局） | 写入 |
| creator_game_preview | projectId、baseRevision、game（≤384KiB；内容预算 gameBytes 由宿主执行） | — | 预览（不落盘） |
| creator_scene_preview | projectId、baseRevision、operations（1..=128 条，≤384KiB） | — | 预览（不落盘） |
| creator_project_commit | projectId、previewId、expectedRevision、operationId | — | 写入 |
| creator_project_publish | projectId、expectedRevision | — | 写入 |
| creator_scene_describe | projectId | revision、selectedObjectId | 只读 |
| creator_scene_capture | projectId | revision | 只读（WebView 本地出帧） |
| creator_capabilities_list | — | category（1..=64 字符；未知类别返回 `creator_capability_unknown`）、schemaVersion（仅支持 1） | 只读 |
| creator_scene_inspect | projectId、revision、objectId（三者必需） | — | 只读 |
| creator_scene_validate | projectId | revision、validationProfile（仅 `"static"`）；由 Studio 合并 city-sdk 语义诊断与宿主结构/资产事实 | 只读 |
| creator_city_create | name、seed、profile、operationId | — | 写入 |
| creator_city_edit_preview | cityId、baseRevision、name、seed、profile | — | 预览（不落盘） |
| creator_city_patch_preview | cityId、baseRevision、patch（对象或 null 清除） | — | 预览（不落盘；运行时几何未检查） |
| creator_city_edit_commit | cityId、previewId、expectedRevision、operationId | — | 写入 |
| creator_city_list | limit（1..=50） | cursor | 只读 |
| creator_city_read | cityId | revision（已保留的历史版本） | 只读 |
| creator_city_diagnostics | cityId、limit（1..=100） | — | 只读 |
| creator_city_view | cityId、revision | — | 只读（只读视口，需 Studio） |
| creator_city_view_status | cityId、revision | — | 只读 |
| creator_city_capture | cityId、revision | — | 只读（WebView 本地出帧） |
| creator_city_layout_read | cityId、revision | — | 只读 |
| creator_city_layout_save | cityId、revision | — | 写入 |

默认暴露的工具里需要 `--allow-local-writes` 的写入工具共 5 个：creator_playtest_start、creator_playtest_cancel、creator_project_create、creator_project_commit、creator_project_publish。开启 `--enable-city-tools` 后另有 3 个写入工具：creator_city_create、creator_city_edit_commit、creator_city_layout_save。除 `creator_capabilities_list` 外仍然要求 Studio 活动。

> **实验性边界（2026-11-14）**：`creator_city_*` 默认隐藏，需 `--enable-city-tools`。已覆盖：草稿创建/读取/列表、配置替换预览与提交、只读视口/截图、布局读取/保存；布局可通过 `creator_project_create` 的 `cityId` 绑定项目，发布快照会冻结 cityId/cityRevision/cityLayoutId。仍**未实现**：`creator_city_open`（切换活动 City）、`creator_city_operation_status`、按 `operations[]` 的编辑预览、完整城市隔离与旧迈阿密迁移；活动 City 的跨 generator 世界切换已被拒绝（`city_world_profile_city_mismatch`）。设计见 [自定义城市与 MCP 接口设计](CREATOR_STUDIO_CUSTOM_CITY_MCP_DESIGN_2026_11_14.md)。`creator_capabilities_list` 是静态契约，Studio 关闭时也可用；其余工具在 Studio 缺席时返回 `plugin_unavailable`。

### 3.1 分发表状态

所有工具（含 12 个 creator_city_* 实验工具）都已在 crates/agent-vitals-mcp/src/mcp/mod.rs 的 dispatch match 中路由；`mcp::tests::tool_specs_and_dispatch_agree` 逐工具断言不存在 “registered but not wired”。

## 4. 连接自检清单（设计 §8.1）

按顺序执行；每步都有明确预期。业务错误以 `tools/call` 结果的 `isError: true` + envelope 内 `error.code` 呈现，不是 JSON-RPC error。

1. **进程握手。** 启动 serve 后 stderr 出现 `data-mcp: serving on stdio (protocol 2025-06-18, data_home …)` 横幅。
2. **initialize。** 返回 `protocolVersion: "2025-06-18"`、`capabilities.tools`、`serverInfo.name: "Oh Agent MCP"`。initialize 之前的请求被拒（JSON-RPC error `-32002`）。
3. **tools/list。** 默认共 42 个工具，其中 `creator_*` 18 个：
   creator_layout_list、creator_project_list、creator_project_read、creator_operation_status、creator_playtest_history、creator_playtest_start、creator_playtest_result、creator_playtest_cancel、creator_project_create、creator_game_preview、creator_scene_preview、creator_project_commit、creator_project_publish、creator_scene_describe、creator_scene_capture、creator_capabilities_list、creator_scene_inspect、creator_scene_validate。
   加 `--enable-city-tools` 后共 54 个，额外包含 12 个：
   creator_city_create、creator_city_edit_preview、creator_city_patch_preview、creator_city_edit_commit、creator_city_list、creator_city_read、creator_city_diagnostics、creator_city_view、creator_city_view_status、creator_city_capture、creator_city_layout_read、creator_city_layout_save。
   `creator.scene.structure_check` 是内部只读依赖，不暴露为 MCP 工具。
4. **只读自检：creator_project_list。** 参数 `{"limit": 10}`。预期分两种：
   - Studio 已打开：返回 `ok: true` 与有界项目列表（没有项目时为空列表）。
   - Studio 未打开：等待约 15 秒后返回 `plugin_unavailable`，提示打开官方 Creator Studio 插件后重试。
5. **写入开关自检（开关未开启时）。** 对 creator_project_create（或任一写入工具）发起调用，预期返回 `permission_denied`，消息明确要求 `data-mcp serve --allow-local-writes`。
6. **Studio 缺席自检。** 关闭 Creator Studio 后调用任一 creator 工具（例如 creator_project_list），预期 `plugin_unavailable`，项目不发生任何写入。
7. **项目服务可用性。** 创建项目或预览失败时按设计 §9 错误码处理：`revision_conflict` 重读重预览、`preview_expired` 重新预览、`not_found` 重新列项目、`busy` 保留原 operationId 退避重试、`invalid_argument` 修正字段后重试。

自检通过后，创作流程按设计 §6.2：list → read → preview → 用户在 Studio 确认 → commit；超时先查 creator_operation_status 或用同一 operationId 重试。

## 5. 设计 §11 验收场景 → 当前验证方式映射

测试名均引用 `#[test]` 函数，逐个 grep 核实过。

| # | 场景（设计 §11） | Rust 自动化覆盖 | 需真实客户端 | 需桌面 bundle |
|---|---|---|---|---|
| 1 | 工具发现 + 无开关拒绝写入 | `tool_specs_and_dispatch_agree`、`creator_publish_tool_requires_explicit_local_write_permission`、`tool_schemas_are_closed_objects`（crates/agent-vitals-mcp/src/mcp/mod.rs）。开关拒绝测试目前只钉了 publish，create/commit/playtest 的开关拒绝在 creator_studio.rs `run()` 内实现但无独立测试 | 用真实客户端验证默认 42 / 开启后 53 个工具 | — |
| 2 | Studio 未打开/被替换/过期时失败不写入 | `committed_operation_survives_studio_instance_replacement_but_preview_does_not`（apps/desktop/src-tauri/src/creator_projects.rs）、`typed_object_response_is_dropped_after_owner_instance_replacement_or_failure`（apps/desktop/src-tauri/src/plugin_host.rs） | 验证 Studio 关闭 → `plugin_unavailable` | Studio 完全未打开的 15 秒超时路径依赖活动 WebView 缺席，自动化测试未覆盖 |
| 3 | 创建→读 chunk→预览→UI 确认→提交→视口新 revision | 宿主侧：`project_preview_commit_revision_and_idempotency`（creator_projects.rs） | 端到端走通一次 | UI 确认卡片与 3D 视口刷新只能人工在 bundle 里确认 |
| 4 | 无效对象/越界/超预算/额外字段被拒绝，revision 不变 | `dispatch_rejects_unknown_arguments`、`dispatch_rejects_non_object_arguments`（mod.rs）；`creator_scene_accepts_only_bounded_explicit_box_colliders`、`creator_mount_rejects_anchors_disconnected_in_the_pinned_city_topology`、`mount_skin_operations_preview_commit_and_enforce_game_bindings`、`creator_playtest_history_is_registered_and_limits_are_bounded`（creator_projects.rs） | — | — |
| 5 | 预览过期/revision 推进/重复消费拒绝，重预览成功 | `project_preview_commit_revision_and_idempotency`（creator_projects.rs） | — | — |
| 6 | 提交响应丢失后原 operationId 只产生一次 revision | `project_preview_commit_revision_and_idempotency`、`failed_commit_keeps_preview_available_for_retry`（creator_projects.rs） | 用真实客户端模拟响应丢失后查 creator_operation_status | — |
| 7 | 两个不同 MCP 客户端行为与错误语义一致 | 无直接自动化；间接依赖所有客户端共用同一 dispatch（mod.rs 单一入口） | **尚未执行——阶段 D 的核心待办** | — |
| 8 | 试玩取消/失败/完成形成唯一终态，release 快照不可变 | `playtest_start_result_cancel_reach_unique_terminal_states`、`playtest_handoff_is_release_pinned_city_bound_and_returns_once`、`city_release_is_immutable_revision_bound_and_filtered_by_current_layout`（creator_projects.rs） | 验证试玩闭环 | City 插件 claim/finish 与返回 Studio 需 bundle 实测 |
| 9 | MCP 输出不含路径/原始日志/提示词/凭证 | 工具面按构造只回有界 DTO（creator_studio.rs 无路径字段）；审计不带原始参数：`tools_call_emits_mcp_audit_event_without_raw_args`（apps/cli/src/mcp.rs） | 对真实客户端可见输出做最终检查 | — |

待客户端实测清单（阶段 D 收口条件）：场景 1 的真实 tools/list、场景 2 的 Studio 缺席路径、场景 3 的 UI 确认与视口、场景 6 的响应丢失演练、场景 7 全部、场景 8 端到端、场景 9 的输出终检。

## 6. 数据边界提醒（设计 §5.3 摘要）

- MCP 只返回创作所需字段：项目字段、对象引用、校验错误、试玩摘要。不暴露 authority DB、任意 SQL、任意文件路径、原始会话日志、用户提示词或凭证。
- 大文档有界分块：creator_project_read 单块 ≤32768 字节，按 `nextOffset` 拼接到 `complete=true`，用 `documentDigest` 校验。
- 预览负载有上限：creator_game_preview / creator_scene_preview 的 MCP 侧载荷各 ≤384 KiB，scene 操作仍限 1..=128 条；插件信箱默认单条 64 KiB，仅上述两个预览方法按方法放宽（请求 384 KiB、响应 64 KiB，见 creator_studio.rs 的 `creator_budgets` 常量）。
- 传输预算分层提案（边界优化文档 §5.5 的描述符声明式按方法 `localCallBudgets` requestBytes/responseBytes，宿主校验后对全部 creator 方法生效）**是设计提案，尚未实现**。当前实现仅有 `plugin_calls` 的预算参数（`call_with_budgets` / `respond_with_budget`）与上述两个预览方法的固定常量；creator_project_read、creator_scene_capture 等方法仍走默认 64 KiB 信箱。
- 工具调用不授予上传或后台网络能力。所选 Agent 服务会收到用户主动提交给它的项目上下文；连接与 UI 应说明这一点。
- 外部包、未验证插件和浏览器预览不得获得真实本机数据或 Creator 写权限。

## 7. 排错速查

| 现象 | 判断 | 处理 |
|---|---|---|
| 工具列表里没有 creator_* | 连的不是本仓库构建的 agent-vitals | 核对 `command` 指向 `target/release/agent-vitals` 并重连 |
| 调用约 15 秒后 `plugin_unavailable` | Studio 未打开或 WebView 实例已失效 | 打开官方 Creator Studio 插件后重试 |
| `permission_denied` 且消息要求写入开关 | serve 未带 `--allow-local-writes` | 用 §1.1 的完整命令重启 MCP |
| `internal_error`（registered but not wired） | specs() 注册的工具未进入 mod.rs 分发 match；当前代码所有工具均已路由（默认隐藏的 city 工具在开启后同样已路由），正常构建不应出现 | 重新 `cargo build --release` 后重连（`tool_specs_and_dispatch_agree` 已逐工具守卫） |
| `revision_conflict` / `preview_expired` | 项目已被推进或预览过期/已消费 | 重读 → 重新预览 → 重新提交 |
| 请求在 initialize 前被拒（-32002） | 客户端未按 MCP 握手顺序发送 | 走标准 initialize → notifications/initialized 流程 |
