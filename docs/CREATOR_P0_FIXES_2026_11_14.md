# Creator P0 修复记录（2026-11-14）

状态：代码已修复并验证；桌面 bundle 重建与运行实例重启见 §6。  
关联：[边界收口记录](CREATOR_BOUNDARY_CLOSEOUT_2026_11_14.md)、[自定义 City 设计](CREATOR_STUDIO_CUSTOM_CITY_MCP_DESIGN_2026_11_14.md)。

## 1. P0-1 禁止跨 City 应用世界 profile

**问题**：`city.world.profile.apply` 只校验实例/基线/空闲，没有 city 身份；任意
Agent 可把 `arid-dunes-v1` 写到现有迈阿密的单份世界偏好，违反沙漠 City 的隔离要求。

**修复**：

- [cityWorldProfileCalls.ts](../apps/agent-city/ui/src/engine/cityWorldProfileCalls.ts) 在 apply 前比较
  `preview.profile.geography.generator` 与当前 `readCityWorldProfilePreference().geography.generator`；
  不同即抛 `city_world_profile_city_mismatch`，不写偏好。
- MCP `city_world_profile_apply` 映射为 `invalid_argument`（提示改用独立 City 草稿）。
- 同 generator 的主题/参数调整仍允许。

**测试**：`city-world-profile-calls.test.ts`

- 新增“拒绝把沙漠 profile 应用到迈阿密”用例：抛错且 `readCityWorldProfilePreference()` 仍是迈阿密。
- 原 apply/busy/instance/expiry 用例改为同 generator，分别覆盖原语义。

## 2. P0-2 City 草稿绑定项目并发布

**问题**：`creator_city_layout_save` 写入 `creator_city_layouts_v2`，但
`creator_layout_list` 只读 legacy 表，`creator_project_create` 只接受裸 `worldRevision`，
项目/发布没有城市身份——草稿无法成为可玩内容。

**修复**：

- `creator.layout.list` 新增 `cityLayouts` 数组（`cityId/cityRevision/worldRevision/layoutId/seed/anchorCount/source:"cityDraft"`），
  legacy `layouts` 保留并标 `source:"legacy"`。
- `creator_project_create` 新增可选 `cityId`：
  - 有 `cityId`：按 `cityId + worldRevision` 取该城最新 `cityRevision` 的 v2 布局，校验
    `schemaVersion=2`、`cityId`、`worldRevision`；归一化为 legacy `cityLayout` 形状写入项目，
    同时写入 `cityId/cityRevision/layoutId`。
  - 无 `cityId`：保持 legacy 行为。
  - `operationId` 幂等摘要包含城市绑定；跨城市/跨世界复用同一 operation 会冲突。
- `publish_project_release` 接受 v2 布局摘要；release snapshot 增加
  `cityId/cityRevision/cityLayoutId`，试玩/发布可核对城市身份。
- MCP `creator_project_create` 暴露 `cityId`；接入指南已同步。

**测试**：`independent_city_layout_binds_project_identity_and_rejects_scope_drift`、
`release_snapshot_carries_independent_city_identity`（desktop crate）。

## 3. P0-3 Creator 存储失败可诊断

**问题**：`database()` 把建目录、打开、WAL、建表、迁移的所有失败都映射成
`creator_store_unavailable`；没有启动自检，用户无法区分权限、锁定、损坏或迁移失败。

**修复**：

- `creator_store.rs` 新增失败分类：
  - `creator_store_unwritable`（PermissionDenied / ReadOnly / CannotOpen）
  - `creator_store_locked`（Busy / Locked）
  - `creator_store_corrupt`（NotADatabase / Corrupt）
  - `creator_store_migration_failed`（建表/ALTER 阶段的其他失败）
  - 兜底 `creator_store_unavailable`
  日志只记“阶段 + 稳定码”，不写路径或原始 SQLite 消息。
- 新增 `creator_store::health()`：打开库 + `PRAGMA quick_check`，返回 `{status, code}`；
  应用启动时执行并记录失败原因。
- MCP `creator_studio.rs` 为每个新码提供可执行错误消息（检查目录权限/重试/备份重建/看日志）。

**测试**：`creator_store_reports_unwritable_directory_and_recovers`
（chmod 只读临时目录 → `creator_store_unwritable`；恢复权限后可重试成功）。

## 4. P0-4 实验 City 工具默认隐藏

**问题**：11 个 `creator_city_*` 默认出现在 `tools/list`，但流程未完整；客户端会
发现并使用半成品工具。

**修复**：

- 新增 `data-mcp serve --enable-city-tools`：
  - 默认 `tools/list` 为 42 个工具（不含 `creator_city_*`）；开启后 53 个。
  - `dispatch_with_permissions_options` 在未开启时拒绝 City 工具，返回
    `invalid_argument` 并提示启动参数。
  - `mcp::tool_specs()` 保持全量（测试/内部使用），CLI 走
    `tool_specs_with_city(flag)`。
- 接入指南已改为默认 42 / 开启 53，并标注 City 工具实验边界。

**测试**：`independent_city_tools_are_hidden_unless_explicitly_enabled`（MCP crate）。

## 5. 验证（源码）

| 检查 | 结果 |
|---|---|
| desktop `cargo test` | 361 passed |
| MCP `cargo test` | 83 passed |
| Agent City world-profile 测试 | 15 passed |
| Creator Studio `typecheck` | 通过 |
| CLI `cargo check -p agent-vitals` | 通过 |
| `cargo build --release -p agent-vitals` | 通过 |
| `cargo tauri build --bundles app` | 通过（16:09 新 bundle） |

MCP 工具面实测：默认 `tools/list` = 42，city 工具 0 个；
`--enable-city-tools` = 53，city 工具 11 个；`creator_capabilities_list` 在 Studio 关闭时
返回 `schemaVersion 1`（离线可用）。

## 6. 构建与运行（P0-0）

- 已完成：重建 release CLI 与 `Oh Agent.app`，退出旧实例（pid 62451）并用
  LaunchServices 打开新 bundle（pid 73913）。
- 启动日志没有 `creator_store` 告警，说明新实例的 Creator 存储自检通过。
- 从当前 agent shell 调用 MCP 时，`~/.agent-vitals/state/plugin-calls` 在 workspace
  之外，普通沙箱下 MCP 连 mailbox 都打不开（先表现为 storage unavailable，实际是
  mailbox 写入被拒）；用完整文件权限复测后，mailbox 正常，返回 `plugin_unavailable`。
- 结论：**存储与 mailbox 已恢复，但重启后 Creator Studio 插件未打开**。需要用户在
  应用里打开 Creator Studio，之后才能执行 `creator_city_create` 等草稿冒烟。
- 冒烟顺序（待 Studio 打开后）：`creator_project_list` → `creator_city_create`
  （`egypt-desert-world.profile.json`）→ `creator_city_list` → `creator_city_view`
  → `creator_city_capture`。

## 7. 仍未完成（非本轮 P0 代码范围）

1. `creator_city_open`（切换活动 City）、`creator_city_operation_status`、
   按 `operations[]` 的 world/style/scene 编辑。
2. 完整城市隔离（多 City 偏好、运行实例并存、旧迈阿密迁移）。
3. 沙海之门专属资产（巨门、砂岩建筑、山脊、沙尘、光照）与桌面视口真机验收。
4. `city.world.profile` 偏好仍单份；P0-1 只阻止跨 generator 覆盖，未实现按 cityId 分仓。
