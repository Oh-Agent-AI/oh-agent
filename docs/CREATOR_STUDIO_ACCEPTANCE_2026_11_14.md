# Creator Studio 发布验收矩阵（2026-11-14）

状态：**未通过发布验收**。本文件把「自动化通过」「桌面真机通过」「可安装/可试玩」分开记录，
不再用测试绿灯替代发布结论。

## 1. 基线

- 已推送代码：`dev @ 18d27cdd`。
- 本文件对应的未提交产出：Codex 会话「审查 dev 并验收 Creator Studio」的收尾工作
  （内容包 v2、城市补丁/revision、项目城市作用域、试玩隔离）＋ 本轮收口
  （世界内容包预检 UI、CLI 重复键对齐、本矩阵）。
- 验收基线：[PRD](AGENT_CITY_CREATOR_STUDIO_PRD_2026_11_11.md) A1–A7 与 CS-01…CS-10。

## 2. 自动化与构建证据

| 检查 | 结果 |
|---|---|
| desktop `cargo test` | 377 passed（含 4 项内容包本机安装测试） |
| MCP `cargo test` | 84 passed |
| city-sdk `npm test` | 106 passed |
| Creator Studio `npm test` | 15 passed |
| Agent City 新增 patch 测试 | 3 passed |
| Agent City 全量测试 | 980/995 passed；14 项失败在 `dev@18d27cdd` 基线同样存在（基线 15/988），不属于本轮回归 |
| Studio / Agent City typecheck | 通过 |
| `cargo build --release -p agent-vitals` | 通过（16:09 版本） |
| Tauri `.app` bundle | 通过（21:42，包含内容包预检与本机安装 UI） |

自动化只能证明这些模块自洽；下面的 A1–A7 以桌面 `.app` + 真实项目为准。

## 3. A1–A7 验收状态

| 编号 | 需求 | 状态 | 证据/缺口 |
|---|---|---|---|
| A1 | 打开现有 City 草稿，建筑/道路/修复正确呈现 | **部分** | 桌面包能加载 City 与道路；独立 City 只读视口能 ready。重启后完整恢复未验收；City↔Studio 切换曾出现 `plugin_instance_mismatch`。 |
| A2 | 玩家移动建筑，预览/校验/保存，重启后保持 | **未通过** | 引擎补丁回归通过；移动后保存、重启恢复的桌面端到端未跑完。 |
| A3 | Agent 提议移动，3D 预览，用户确认后保存 | **未实现** | Agent 提案确认卡仍是设计原型，未接真实预览/确认/提交。 |
| A4 | Agent 与玩家连续编辑，旧 revision 被拒且不覆盖 | **通过（自动化）** | CAS/revision 冲突拒绝；冲突后不再重试旧补丁；有回归测试。真机并发未复测。 |
| A5 | 调整入口/检查点后完成一场竞速，取消/失败可返回 | **未通过** | 发布与试玩 ready 已走通；完整竞速结算未验收；取消试玩返回 Studio 失败（实例切换）。 |
| A6 | 保存/无效位置/断连/试玩失败有可理解状态；崩溃后恢复完整 revision | **未通过** | 部分错误码已可读；`plugin_instance_mismatch` 未修；崩溃/强杀恢复未验收。 |
| A7 | 旧 City 修复继续可用，旧补丁迁移；撤销栈仅本次会话 | **部分** | 旧补丁导入保留；撤销/重做写入项目未实现，旧修复会话历史未做迁移验收。 |

## 4. CS 用例状态

| 用例 | 状态 | 说明 |
|---|---|---|
| CS-01 City→Studio 同一城市/布局 | 部分 | 曾出现实例切换错误，重启后恢复；重复切换稳定性未过。 |
| CS-02 创建项目并绑定 City 布局 | 通过 | 桌面创建、保存、revision 前进已验证；独立 City 绑定/发布也有 MCP 证据。 |
| CS-03 重启恢复项目/布局/完整 revision | 未测 | 无桌面重启恢复证据。 |
| CS-04 发布后试玩启动/取消/返回 | 部分 | 发布与 ready 通过；取消返回失败。 |
| CS-05 发布摘要与 City 游戏引用一致 | 通过 | 修复 `creator_release_game_reference_mismatch` 后桌面实测通过。 |
| CS-06 Agent 提案确认 | 未实现 | 同 A3。 |
| CS-07 并发编辑冲突 | 通过（自动化） | 同 A4。 |
| CS-08 故障恢复/半写 | 未测 | 无强杀/崩溃恢复证据。 |
| CS-09 独立沙丘 City 创建/预览/绑定/发布 | 部分 | 创建、只读视口、截图、布局保存、绑定项目、发布 release 已验证；不能切换为运行城市，不能试玩。 |
| CS-10 世界内容包预检/本机安装 | 部分 | 预检、一次性 inspectionId、本机安装、列表/卸载已实现；Rust/Studio 自动化通过。原生文件选择器与安装按钮的桌面人工点击尚未完成，且安装后仍不能运行，不能标真机通过。 |

## 5. 未通过发布验收的阻塞项

1. **独立 City 不可试玩**：`creator_playtest_start/claim` 对 `cityId` release 返回
   `creator_independent_city_runtime_unavailable`；没有 city-scoped 运行时。沙丘 release
   只能看/截屏。
2. **内容包不可运行/可信分发**：本机安装与卸载已实现，但安装的包不会执行或加载为 City；仍无签名/来源/运行时兼容校验，也没有分发/依赖/版本升级。
3. **A3/A5/A6/A7 未闭环**：Agent 提案确认、完整竞速结算与返回、实例切换/崩溃恢复、
   撤销/重做与旧补丁迁移。
4. **视觉未交付**：无巨门/砂岩建筑/沙脊/沙尘/光照资产；截图仍是 `arid-dunes-v1` + `desert`
   基底，不能作为「沙海之门」视觉验收。
5. **真实桌面证据不完整**：多次锁屏中断，冷启动、重启恢复、重复切换没有全部跑完。

## 6. 本轮收口内容

- Studio「项目」面板顶部新增**世界内容包预检**：原生选择器 → 宿主 Rust 完整性检查 →
  UI 只展示 packageId/version/fileCount/digest 与「语义/兼容/来源未检查、不可安装」。
  路径和字节不进入 UI/Agent/MCP。
- CLI `verify-world` 增加原始字节**重复键拒绝**，与 Rust `inspect_world_integrity_v2`
  对齐；`JSON.parse` 折叠重复键不再能绕过。
- Rust `inspect_selected_world_file` 增加文件边界测试（普通文件通过；缺失/目录拒绝）。
- 本机安装：预检 token → 重新校验同一文件 → 临时目录/原子 rename/DB 记录 →
  已安装列表/卸载；设计见 [CREATOR_CONTENT_INSTALL_2026_11_14.md](CREATOR_CONTENT_INSTALL_2026_11_14.md)。
- 本矩阵替代「测试通过=发布通过」的口头结论。

## 7. 发布结论

**不通过。** 可以发布的候选范围只有「legacy City + Creator Studio 的有限编辑/发布/试玩」
且 A5/A6/A7 仍需真机闭环；独立 City 运行时、内容包运行/可信分发、沙丘视觉均属于未完成能力，应继续标
experimental，不得作为已验收功能对外宣称。

签署：无。下一次验收必须附 `.app` 构建号、项目 ID、revision、release ID、截图/录屏与
A1–A7 逐项结果。
