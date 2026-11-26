# Creator Studio 发布验收矩阵（2026-11-14）

状态：**未通过发布验收**。本文件把「自动化通过」「桌面真机通过」「可安装/可试玩」分开记录，
不再用测试绿灯替代发布结论。

## 2026-11-15 合并后 P0 跟进（源码，未真机验收）

- 新增 `creator_city_create_from_world`：从本机已安装的 `city-world` 包创建独立 City 草稿；宿主重新读取并校验已安装包，在单个 SQLite 事务中写入 City、revision、幂等记录和固定的 package digest 引用。
- City 草稿重新打开时按固定引用加载包内场景和资产目录；City 自身 profile/seed 可按 revision 编辑，试玩使用冻结 City revision 的生成参数和固定来源包的场景资产。被引用包仍受卸载保护。已加载城市的引擎可捕获其布局，Studio 项目创建可选择 `cityLayouts` 并附带 `cityId`，项目视口恢复包场景。Studio 面板和 MCP 都有创建入口。
- Studio TypeScript typecheck、桌面 Tauri `cargo check`（包含 MCP crate 依赖编译）已通过；未跑测试、未重新打包、未做桌面真机验收。
- 随后补入 City 试玩的 pending-run 世界包快照通道：宿主从 release 冻结的 City 身份解析包引用，按 City 插件实例和 pending run 授权分块读取；City 在 SDK 校验、模型加载和挂载完成前不 claim。只覆盖 Studio 发起的试玩，不实现通用 City 活动切换或安装包自动启动。
- 新增的 City/Creator Studio typecheck、production build、`verify:world-scene-models`、`creator-playtest-pending`、`checkpoint-race` 定向用例、Tauri `cargo check`、`verify-plugin-architecture`、Creator Studio production build，以及 Rust `routes_only_declared_builtin_city_calls` / `release_snapshot_carries_independent_city_identity` 定向回归通过。未重新打包或做桌面真机验收。整体仍不能宣称可发布：A5/A6/A7、包导出/可信分发、签名信任、通用城市切换和真实场景验收仍有缺口。
- 本轮补齐独立 City 源码目录的固定 world package 闭包：导出 scene、catalog、package patch 和摘要校验后的 GLB；City 显式 patch 优先。Creator Studio typecheck、production build、Tauri `creator_source_export` 定向测试（5 项）通过。测试证明目录复制与摘要拒绝，不证明 bundle/真机行为或正式安装能力；不改变 CS-11 历史项目源码导出的真机记录，也不改变整体发布状态。

## 2026-11-15 接管验收记录

### 环境重置

- 杀掉两个旧实例（`/Applications` 11-11 旧包与 repo 23:19 包），只启动 **07:15:53 重建的 repo bundle**，避免双实例争抢插件调用。
- 最新构建包含：Agent 提交确认/3D 城市补丁预览、计划修复持久化、源码导出、City 启动门控。

### 真机通过

1. **源码导出**：Studio → 项目 → `project-91ae…`（独立沙城、单挂载、revision 1）→「导出源码目录…」→ 选择 `/tmp/codex-source-export`。生成 `city-source-17e653c4…/`：
   - `README.md`、`.gitignore`、`world/world.json`、`games/game/{game,layout,mount,scene}.json`、`games/game/assets/catalog.json`；
   - 导出物再跑 `validate-world` 通过，`pack-world --seed 42 --generator-version 6` 与 `verify-world` 通过（`installation` 仍为 unchecked）。
2. **Agent 提交确认/拒绝**：对同一项目经 MCP 发起 `creator_scene_preview`（skin.select）→ `creator_project_commit` 返回 `creator_confirmation_required`；Studio 弹出「等待确认的 Agent 修改」卡：
   - 点「确认保存」后项目 revision 1→2，`skinId=miami-vice`，界面显示“Agent 修改已确认并保存（版本 2）”；
   - 再次发起 skin.select → 点「取消」，revision 与 skin 都不变，界面显示“已取消待处理的 Agent 请求”。
3. **试玩驾驶**：独立沙城 release 能启动并领取，点击开始后 CGEvent 驾驶输入有效（约 74–82 km/h），HUD 到达 **1/3** 检查点。

### 真机未通过 / 测试环境阻断

- **完整竞速 3/3 与成功结算仍未通过**：三次真机运行的最终证据都是 `failed / creator_minigame_failed / tick=2400 / next=0或1`；最好一次只到 1/3。
- City 驾驶 HUD 现在显示下一检查点相对方向箭头与距离，定向规则测试通过；但当前测试环境仍无 `screencapture`/ScreenCaptureKit 屏幕录制权限，无法取得新的视觉闭环证据。
- 代码侧成功结算“成功却带 failureCode”的协议 bug 已修并有契约测试；A5 仍需真机完成 3/3 并记录成功结算。
- 3D 建筑移动确认：真机只验证了 skin.select 的确认/拒绝；城市补丁 3D 预览仍是合成浏览器测试，未做真实建筑移动。

## 后续修复记录：试玩启动门控

City 在创建引擎前确认 pending 试玩；独立城市使用 Studio 相同的空城市模型、冻结种子和项目补丁，试玩不发布到旧城市补丁存储。领取时携带并校验 runId，避免并发替换后领取错误的试玩。服务不可用时保持阻断并允许重试；结果提交失败时保留重试入口。

这些修改尚未提供桌面真机的「启动独立城市 → 领取 → 完成驾驶 → 结果持久化 → 返回」证据，也不改变下方 A3、A5、A6、A7 等验收结论。

后续真机复测：独立城市试玩已进入驾驶准备界面，开始后方向键加速可见约 89 km/h；退出后返回原项目，界面显示 `cancelled`、tick 1342、0/3，数据库也保存了取消状态和证据。此轮没有通过检查点或完成竞速，不代表成功结算通过。此前 `creator_spawn_distance_exceeded` 通过优先搜索入口附近道路候选后不再复现于该次测试；这不证明所有道路形状和城市都已覆盖。

再次真机驾驶期间未能从当前画面明确识别下一检查点方向，退出结果为 `cancelled`、tick 2050、0/3。代码审查另发现成功结算此前错误附带失败码、会被宿主拒绝；现已修正并增加契约测试，仍需真实完成竞速来验收结果和持久化。

## 1. 基线

- 基线：`dev @ 8969d0d4`（接管后切分提交：`4adecf91` Agent 确认/3D 预览、`eeeb3f49` 计划修复持久化、`8969d0d4` 源码导出细化；连同 5 个 City 提交）。
- 验收基线：[PRD](AGENT_CITY_CREATOR_STUDIO_PRD_2026_11_11.md) A1–A7 与 CS-01…CS-10。

## 2. 自动化与构建证据

| 检查 | 结果 |
|---|---|
| desktop `cargo test` | 382 passed |
| MCP `cargo test` | 85 passed |
| city-sdk `npm test` | 107 passed |
| Creator Studio `npm test` / typecheck | 19 passed / 通过 |
| Agent City 计划修复持久化 + 隔离 | 12 passed |
| Agent City boot/spawn/outcome/claim | 6 passed |
| 合成浏览器 City 导航 + Agent 确认 | `verify-creator-city-navigation.mjs` 通过 |
| Tauri `.app` bundle | 通过（07:15:53，接管后唯一运行实例） |

自动化只能证明这些模块自洽；下面的 A1–A7 以桌面 `.app` + 真实项目为准。

## 3. A1–A7 验收状态

| 编号 | 需求 | 状态 | 证据/缺口 |
|---|---|---|---|
| A1 | 打开现有 City 草稿，建筑/道路/修复正确呈现 | **部分** | 桌面包能加载 City 与道路；独立 City 只读视口能 ready。重启后完整恢复未验收；City↔Studio 切换曾出现 `plugin_instance_mismatch`。 |
| A2 | 玩家移动建筑，预览/校验/保存，重启后保持 | **未通过** | 引擎补丁回归通过；移动后保存、重启恢复的桌面端到端未跑完。 |
| A3 | Agent 提议移动，3D 预览，用户确认后保存 | **部分** | 真机已跑通 Agent 提交确认/拒绝（skin.select：确认 revision 1→2，拒绝不变）；单个城市补丁使用独立只读视口，基准路网不匹配或失效项时禁止确认，合成浏览器覆盖道路宽度调整与取消不提交。**尚无真实建筑移动的三维桌面验收**；混合操作暂不能确认。 |
| A4 | Agent 与玩家连续编辑，旧 revision 被拒且不覆盖 | **通过（自动化）** | CAS/revision 冲突拒绝；冲突后不再重试旧补丁；有回归测试。真机并发未复测。 |
| A5 | 调整入口/检查点后完成一场竞速，取消/失败可返回 | **未通过** | 真机试玩能启动/领取/驾驶（约 74–82 km/h）并到达 1/3 检查点；取消返回与结果持久化已有证据。新增 HUD 导航尚未真机验收；完整 3/3 与成功结算仍未通过（三次均 tick=2400 failed）。 |
| A6 | 保存/无效位置/断连/试玩失败有可理解状态；崩溃后恢复完整 revision | **未通过** | 修复会话关闭会立即排队尚未写出的补丁，同一 WebView 内写入串行、合并其他种子并拒绝同种子冲突；存储读取或写入失败不会误报成功，可重试临时失败。关闭后写入失败的内存草稿尚无持久恢复，跨 WebView/进程仍无原子 CAS；冲突恢复和强杀恢复未验收，实例切换也需继续复测。 |
| A7 | 旧 City 修复继续可用，旧补丁迁移；撤销栈仅本次会话 | **部分** | 旧补丁导入保留；撤销/重做写入项目未实现，旧修复会话历史未做迁移验收。 |

## 4. CS 用例状态

| 用例 | 状态 | 说明 |
|---|---|---|
| CS-01 City→Studio 同一城市/布局 | 部分 | 曾出现实例切换错误，重启后恢复；重复切换稳定性未过。 |
| CS-02 创建项目并绑定 City 布局 | 通过 | 桌面创建、保存、revision 前进已验证；独立 City 绑定/发布也有 MCP 证据。 |
| CS-03 重启恢复项目/布局/完整 revision | 未测 | 无桌面重启恢复证据。 |
| CS-04 发布后试玩启动/取消/返回 | 部分 | 后续真机复测已启动、取消并返回项目；成功和失败终态仍需验收。 |
| CS-05 发布摘要与 City 游戏引用一致 | 通过 | 修复 `creator_release_game_reference_mismatch` 后桌面实测通过。 |
| CS-06 Agent 提案确认 | 部分 | 真机确认/拒绝已通过（skin.select）；城市补丁 3D 预览与道路宽度修改仍只有合成浏览器证据，真实建筑移动未验收。 |
| CS-07 并发编辑冲突 | 通过（自动化） | 同 A4。 |
| CS-08 故障恢复/半写 | 未测 | 无强杀/崩溃恢复证据。 |
| CS-09 独立沙丘 City 创建/预览/绑定/发布 | 部分 | 创建、只读视口、截图、布局保存、绑定项目和发布 release 已验证；真机试玩可驾驶到 1/3、取消返回可用；完整竞速与常驻城市切换仍不可用。 |
| CS-11 源码目录导出 | 通过（真机） | 导出到 `/tmp/codex-source-export` 的完整目录，`validate-world` + `pack-world` + `verify-world` 回环通过；安装/运行仍不可用。 |
| CS-12 Agent 提交确认/拒绝 | 通过（真机） | MCP 提交返回 `creator_confirmation_required`；Studio 确认后 revision 前进、取消后不变；操作状态可查询。 |
| CS-10 世界内容包预检/本机安装 | 通过（仅本机安装） | 桌面真机已验证：原生选择器选包 → 完整性预检通过 → 安装 `arid-dunes@1` → 文件落 `state/creator/content/world/arid-dunes/1/package.json`、DB `creator_content_packages` 有行 → 列表显示 → 两段式卸载删除文件与行 → 重新安装成功。安装后仍未作为活动 City 运行/不可信分发；从包创建 City 草稿是源码新路径，尚未真机验收。 |

## 5. 未通过发布验收的阻塞项

1. **独立 City 试玩闭环进行中（未验收）**：历史上的 reload 启动失败已改为引擎启动前门控，后续真机已进入驾驶并在取消后返回项目，取消结果已持久化。完整竞速成功、失败终态与恢复仍缺真机证据，A5 不能判通过。
2. **内容包不可运行/可信分发**：本机安装与卸载已实现，但安装的包不会执行或加载为 City；仍无签名/来源/运行时兼容校验，也没有分发/依赖/版本升级。
3. **A3/A5/A6/A7 未闭环**：真实建筑移动的三维确认、完整竞速 3/3 成功结算、实例切换/崩溃恢复、
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
  已安装列表/卸载；桌面真机已走通预检、安装、列表、两段式卸载、重新安装。
  设计见 [CREATOR_CONTENT_INSTALL_2026_11_14.md](CREATOR_CONTENT_INSTALL_2026_11_14.md)。
- 本矩阵替代「测试通过=发布通过」的口头结论。

## 7. 发布结论

**不通过。** 可以发布的候选范围只有「legacy City + Creator Studio 的有限编辑/发布/试玩」
且 A5/A6/A7 仍需真机闭环；独立 City 运行时、内容包运行/可信分发、沙丘视觉均属于未完成能力，应继续标
experimental，不得作为已验收功能对外宣称。

签署：无。下一次验收必须附 `.app` 构建号、项目 ID、revision、release ID、截图/录屏与
A1–A7 逐项结果。
