# Worktree 归并到 main 的策略

日期：2026-10-04。目标：把有价值的最新提交及未提交工作归并到 `main`，完成验证后归档多余 worktree，让主工作区成为日常开发入口。

本文件保留执行前盘点和策略；2026-10-04 已获授权执行。实际结果及验证边界见 `WORKTREE_MAIN_CONSOLIDATION_REPORT.md`，以下提交计数为盘点时数据。

## 1. 实际盘点

当前共有 **20 个 worktree**。本地 `main` 为 `443e2c3a`，远端 `main` 实查为 `55f8de0e`，与 `origin/main` 相同；远端是本地祖先，本地领先 418 个提交、落后 0 个。

| 工作区 | 提交关系 | 本地改动与处置 |
|---|---|---|
| 主工作区：`feat/agent-city` | HEAD 与本地 main 相同 | 35 个 tracked 修改、23 个 untracked 条目；包含 E08 重复工作、桌面 catalog 接线、价卡/CI、官网及文档，必须分主题核对 |
| `codex/app-layer-city-wip` | 2 个提交未在 main，已完整包含于 E08 分支 | 10 个 tracked 修改、2 个 untracked 条目；多数内容已经移入 E08，仍有 2 个 engine 文件及 resize UAT 文档尚未移入 |
| `codex/e08-city-closeout` | 包含当前 main 及最新 City；比 main 多 6 个提交 | HEAD `544237ff`，工作树干净，作为归并基线 |
| 17 个旧 City/Trend worktree | 所有 HEAD 已是 main 的祖先，无独有提交 | 5 个干净；11 个只有共享 node_modules 链接；city-wildlife 有一个未跟踪检查脚本，需要保留/比对后归档 |

17 个旧 worktree：

- `city-assets`、`city-cinematic`、`city-cinematic-pace`、`city-civic`、`city-crane`、`city-fixes`。
- `city-iter2`、`city-iter3`、`city-lighting`、`city-seed`、`city-spec`、`city-sun`。
- `city-viaduct-lamps`、`city-water-mipfade`、`city-water-sparkle`、`city-wildlife`、`trend-range-chart`。

其中 11 个 `apps/desktop/ui-dev/node_modules` 都是符号链接，目标为主工作区的 `apps/desktop/ui-dev/node_modules`。不能沿着链接删除共享依赖。

## 2. 合并原则

1. **以 E08 整合结果为代码基线。** 当前 main 已在其历史中，未来归并分支验证通过后，main 可以 fast-forward，保留原提交和合并记录。
2. **提交祖先与工作区内容分别检查。** 已合并 HEAD 不代表未提交/未跟踪内容已经保留。
3. **按主题移植唯一差异。** 新基线采用 `harness` 命名及 `apps/agent-city/ui` 插件目录；旧工作区整个文件不能覆盖新版本。
4. **先保存，再归并，最后归档。** 保存 dirty 工作区中的源文件、未跟踪文件、HEAD、diff 和需要保留的本地产物；缓存、符号链接和生成物分别登记。
5. **只把现有工作收齐。** 本次不扩展为实施 E00/E09–E15 等尚未开始的功能；台账明确保留未完成目标。
6. **保留产品决策。** City 为 Agent Vitals 内与 Overview 平级的官方前端插件；Rust 查询与通用 projection 仍在本体，宿主插件概念与 agent harness 区分。

## 3. 执行次序

### 第一步：建立可恢复的归并起点

- 确认相关 worktree 没有仍在写入的开发/构建任务，记录 HEAD 和工作树清单。
- 为当前 main、E08、City WIP 和主工作区建立带时间的备份引用。
- 为两个 dirty 工作区保存源码检查点；未跟踪目录展开核对，不能只保存 tracked diff。
- 主工作区的 `website/landing/city3d`、构建 bundle 等产物按现有发布方式决定是否纳入源码，必要证据单独保留；不要把 node_modules、target 或本地用户数据库打入源码提交。
- 复用现有 E08 worktree，从 `544237ff` 建立 `codex/main-consolidation`，无需另建一个 worktree。

### 第二步：收齐 City 的剩余变化

City WIP 与 E08 对比后的唯一源码差异是：

- `apps/agent-city/ui/src/engine/cityPlan.ts`：空间索引查询范围、高架出口落地及连接地面道路。
- `apps/agent-city/ui/src/engine/cityParts.ts`：闭合高架高度、桥面标线、行道树避让道路/建筑。
- `docs/CITY_RESIZE_BLACK_FLASH_UAT_2026-10-04.md`：保存观察证据和捕捉盲区。

其余 CSS、WebView 布局同步、TypeScript 配置、构建脚本与 `verify-plugin-layout-sync.mjs` 已与 E08 文件逐字节一致，不重复移植。

主工作区的 `scripts/verify-react-city-infrastructure.mjs` 比 wildlife worktree 的版本增加了道路出口/空间索引断言，但仍指向旧 `react/src/features/city/engine`；应把有价值的断言移入新插件路径下的检查脚本。wildlife 版本单独保留来源记录，不用旧版本替换较完整的检查。

验证 City typecheck、专项地理/布局/基础设施检查，以及原生 WebView 和浏览器 iframe 两种运行场景。Resize UAT 目前只说明捕获样本未复现闪黑，不能用它声称单帧闪黑已修复；新代码按实际测试补充结论。

### 第三步：归并主工作区的扩展工作

- E08 ingest、fact writer、CLI 和 source controls 等工作多数已移入 `fe09acfe`；通过 rename-aware diff 核对剩余独有差异。
- 主工作区 `apps/desktop/src-tauri/src/lib.rs` 仍有官方 catalog 下载/安装确认、序号下限恢复、流式大小限制和对应测试；这些接线没有包含在 E08 桌面代码中，需要单独移植。
- 保留相应 Tokio `sync` 依赖；把旧 `host_slot_support`、`host_dependency_group`、安装命令等接到新 harness API，核对真实调用入口。
- schema、计费/来源和历史事实的变化单独审核；不把旧 authority 文件覆盖到当前 v31。
- 更新实施台账时区分本次新增的桌面安装链与已经通过的 E08，避免把历史日志当当前状态。

### 第四步：归并 catalog、CI、官网和文档

按独立提交处理，便于测试和回退：

1. **catalog/价卡发布**：`catalog/pricing`、兼容镜像脚本、catalog 发布验证与测试、pricing sync、release/verify workflows、相关说明。旧文件中的 `host_manifest`、`catalog/hosts` 等必须与当前 harness index 契约对齐；保持旧 assets 价卡 URL 和 schema 的兼容镜像。
2. **官网 City 展示**：landing HTML/CSS/i18n、fixture iframe 通信、mock fallback、`tools/build-city3d.mjs`。使用当前插件构建；官网数据保持确定性示例。检查生成目录的源码/发布归属。
3. **文档与原型**：对照当前插件实现合并 AGENTS、架构规格、实施计划和审计记录。旧工作区中同名 untracked 文档可能已经在新基线跟踪，逐文件比较；保留用户已确定的插件架构与未完成事项。

官网和目录内容不得把旧 City 源码重新接回桌面宿主 bundle。`endpoint_host`、合法插件 host 等名称按语义核对，不能全局替换所有 host 字面量。

### 第五步：验证归并后的完整版本

上轮 E08 通过的验证只覆盖 `544237ff`，不自动覆盖新增归并内容。先生成需要的 bundle，再跑读取这些产物的测试，避免边打包边检查造成不一致。

- Rust：workspace release tests、release clippy、CLI release build；新增桌面 catalog 接线的测试及 Tauri 构建。
- Python/catalog：全量 unittest、发布契约/兼容镜像检查、Python 与新 Rust CLI golden parity；不靠刷新 golden 消除差异。
- UI：宿主 React build/typecheck、City 独立 typecheck/build、City/插件架构/隔离/布局同步检查。
- 运行验收：通过 `.app` bundle 启动，检查 Overview↔City、resize、插件故障降级与恢复；浏览器检查 iframe preview 和官网 fallback。
- 最终 `git diff --check`、工作树清单、文档状态一致性检查。

构建失败、数据/计费契约回归或宿主重新静态依赖 City 属于合并阻断。未闭合的视觉观察按实际证据登记，不能写为已修复或影响范围已被证明。

### 第六步：提升 main 并同步远端

- 将所有待保留的主工作区改动保存到检查点并完成移植，确认切换分支不会覆盖文件。
- 在主工作区切到 `main`，通过 `git merge --ff-only codex/main-consolidation` 提升 main。
- 核对主工作区 HEAD、插件描述符、关键目录和验证记录，确认它就是已验收版本。
- 同步远端前重新获取/核对 origin/main；如远端有新提交，先整合和复验。远端仍是祖先时使用普通 push，不 force push。
- 当前领先的 418 个提交会随正常 main 推送一并同步，不能把它误认为只发布 E08 的几条提交。

### 第七步：归档多余 worktree

- main 已包含目标代码且验证完成后，才能移除对应 worktree。
- 两个当前任务附属的 Codex worktree 使用可恢复归档机制；按需另存其忽略的 bundle、日志或测试证据。
- 17 个 `.claude/worktrees` 逐个确认 HEAD 可达 main，保留唯一未跟踪源码；只解除缓存符号链接本身，然后对已核对的准确路径执行正常 worktree remove。
- 第一轮保留历史 branch/备份引用，先减少 checkout 数量。分支引用的后续清理只针对已合并分支。
- 不使用 `reset --hard`、checkout 覆盖、工作区根递归删除或未检查 dirty 内容的强制清理。

## 4. 完成条件

- 主工作区位于 main，工作树干净，包含最新 City、E08 和已确认保留的所有唯一源码变化。
- 本次移植主题各有独立提交及验证证据；每个源 worktree 的改动有目标提交或明确保留记录。
- 主工作区可运行最新 bundle；远端 main 若执行同步，HEAD 与本地一致。
- 默认只保留主工作区；确有持续独立开发需求时再保留一个活动 worktree，其余可恢复归档。
- E00/E09–E15 等后续需求与 resize UAT 的证据限制继续如实记录，不因归并标成完成。
