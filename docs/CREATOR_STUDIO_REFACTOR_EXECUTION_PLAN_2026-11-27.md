# Oh Agent Creator Studio：改造执行计划（对应审查规范 V1.1）

**依据：** [CREATOR_STUDIO_CODE_REVIEW_AND_REFACTOR_PLAN_2026-11-27.md](CREATOR_STUDIO_CODE_REVIEW_AND_REFACTOR_PLAN_2026-11-27.md)（V1.1）
**执行基线：** `dev` HEAD `193efa93`，与审查基线完全一致，无基线漂移。
**计划创建时间：** 2026-11-27
**执行方式：** 分波执行（每波结束汇报验收，经确认进入下一波）；波内按"文件不相交"分组用子代理并发，同文件 PR 串行；每个 PR 在 dev 上以 scoped Conventional Commit 提交。

## 0. 基线核实结论（2026-11-27，主会话 + 3 个探查代理逐文件核实）

| 发现 | 核实结论 | 关键位置 |
|---|---|---|
| P0-1 Preview 状态串线 | **部分成立（仅 UI 层）**：Host `studio_status_for`/`studio_stop` 已按 previewId 权威读写；MCP 状态工具双分支；UI `CodeGamePreviewPanel.tsx` 轮询不带 previewId（:40）、不持久化创建返回的 ID（:79-82）、stop 用 legacy 全局状态里的 ID（:90） | `creator_code_game.rs:443-505`、`creator_code.rs:99-108` |
| P0-2 Workspace 幂等 | 成立：`operationId` 读入即丢弃；无外层幂等 | `creator_code_workspace.rs:174`（`project_create` 168-208） |
| P0-3 targetRefs 仅形状校验 | 成立：max 8 条、字段有界，无归属/版本校验；TS `parseStudioTask` 丢弃 targetRefs | `creator_session.rs:1159-1179`、`studioTask.ts:11-26` |
| P0-4 Runner 无资源边界 | 成立：阻塞 `.output()`、无超时/输出上限/env 清理；Tick 上限仅步数 | `creator_code_workspace.rs:734-755`（`run_node`） |
| P0-5 code_test 无 City 绑定 | 成立：无 city/snapshot 入参，响应硬编码 `synthetic:true`；`previewGame.ts` 已支持 `--snapshot/--snapshot-digest` 且带 digest 校验（未被 MCP 使用） | `creator_code_workspace.rs:100-110,476-524`；`previewGame.ts:30-38,151-159` |
| P0-6 无 executionOk/verdict 区分 | 成立：全仓无 `executionOk/verdict/TestScenario/scenarioId` 概念；现仅 `GameTelemetryV1` + `rule_replay::ReplayVerdict` | `city-game-sdk/src/host/types.ts:62`、`rule_replay.rs` |
| P0-7 门禁不一致 | 成立：Host accept 不拒绝 hostDisagreement、不要求 host-verified；`publish_project_release` 无证据门禁；MCP code publish/install 仅查权限与摘要；前端 `city-client-reported` 可过 `canAcceptCandidate` | 桌面 `creator_projects.rs:926-964,858-866`；`creator_code_experience.rs`；`candidate.ts:53-60` |
| P0-8 无自动试玩 | 成立：无输入注入/Playwright；可复用隔离预览窗口（label↔previewId 配对 + 三层方法白名单）、`creator.city.capture` 截图、`creator_playtest_*` 生命周期 | `code_preview_window.rs`、`creator_playtest.rs` |
| P0-9 证据词表混合 | 成立：4 套混用词表（city-client-reported/host-verified/creator-declared/host-observed），无 Source×Verification×Verdict 模型，无按 candidateDigest 的持久化 Review Record | `creator_playtest.rs:442-445`、`creator_session.rs:1281`、`candidate.ts:6` |

**对规范 §10.1 文件索引的勘误：**

1. 候选/发布门禁与模板/挂载 Host 实现在 `apps/desktop/src-tauri/src/creator_projects.rs`；`crates/agent-vitals-mcp/src/mcp/creator_projects.rs` **不存在**。
2. `ProjectsPage.tsx` 实际路径为 `apps/creator-studio/ui/src/features/project/ProjectsPage.tsx`（`features/library/` 下无此文件）。
3. `EvidenceCenterPanel.tsx` 路径确认无误：`features/evidence/EvidenceCenterPanel.tsx`。

## 1. 逐 PR 跟踪表

| PR | 范围 | 状态 | 提交 | 实施记录 |
|---|---|---|---|---|
| 01 · Preview 身份隔离 | UI 绑定 previewId | ✅ 完成（2026-11-27） | `3f2136ba` | 见 §4.1 |
| 02 · Workspace 幂等 | operationId 回执 | ✅ 完成（2026-11-27） | `c4847bc0` | 见 §4.2 |
| 03 · TargetRefs 权威校验 | Host 创建/执行/提交校验 | ✅ 完成（2026-11-27） | `e5293bed` | 见 §4.3 |
| 04 · Runner 资源边界 | 超时/预算/环境清理/进程回收 | ✅ 完成（2026-11-27） | `cbdbf670` | 见 §4.4 |
| 05 · City Snapshot Test | MCP→Host→SDK 冻结快照 | ✅ MCP+桌面臂完成（渲染器导出待 PR08 接线） | `ed3eb4b7` + `4f5cfb90` | 见 §4.6 |
| 06 · Scenario/Evidence | verdict 拆分与断言 | ✅ 完成（2026-11-27） | `3b5ca9eb` | 见 §4.8 |
| 07 · Candidate/Release 门禁 | Host 统一证据检查 | ✅ 完成（2026-11-27） | `d4e14d02` | 见 §4.7 |
| 08 · Automated Visual Playtest | 隔离 Preview 自动试玩 | ✅ 完成（2026-11-28） | `0ab0b7b4` | 见 §4.9 |
| 09 · Candidate Workspace | 基线隔离 + CAS 接受 | 未开始 | — | — |
| 10 · Code Game Task Adapter | StudioArtifactRef 统一 | 未开始 | — | — |
| 11 · 有预算的自动修复 | 冻结验收标准 | 未开始 | — | — |
| 12 · Template Registry | 统一模板元数据 | 未开始 | — | — |
| 13 · Binding Resolver/Migration | 绑定提案与迁移 | 未开始 | — | — |
| 14 · Gallery/Remix/E2E | 纵向闭环 | 未开始 | — | — |

**波次与并发分组：**

- Wave 1（PR 01–04）：`[PR01 UI] ∥ [PR03 creator_session.rs+studioTask.ts] ∥ [PR02 → PR04（同文件 creator_code_workspace.rs，串行）]`
- Wave 2（PR 05–08）：初定 `[PR05] ∥ [PR07]`，随后 `[PR06 → PR08]`（`creator_playtest.rs` 重叠）；启动时按实际文件重叠复核。
- Wave 3（PR 09–11）：基本串行 09 → 10 → 11。
- Wave 4（PR 12–14）：12 → 13（同触 MCP 工具注册），14 最后。

## 2. 每 PR 实施记录模板（按规范 §10.2）

每个 PR 合入时在本文件对应行补记：

- 修改文件与复用的 Host/SDK/API 合同；新增合同需说明为何现有合同不能覆盖。
- 是否涉及 SQLite schema/迁移、MCP schema、TS/Rust 生成资产、golden 更新。
- 新增/修改的测试与实际执行命令（含输出摘要）。
- Preview/Run/Build/Candidate 身份贯通说明；可复核日志/截图路径。
- 故障恢复、回滚、降级行为；真机才能验证的项明确标注"待真机验证"。
- Rust 改动：`git diff --check` 结果与 diff stat。

## 3. 检查命令（规范 §10.3）

| 改动范围 | 命令 |
|---|---|
| Studio UI | `npm run typecheck --prefix apps/creator-studio/ui`；`npm test --prefix apps/creator-studio/ui` |
| Creator MCP | `cargo test -p agent-vitals-mcp` |
| Desktop Host | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` |
| city-game-sdk | `npm test && npm run typecheck`（必要时 `npm run build`） |
| agent-vitals-city-sdk | `npm test && npm run typecheck`（嵌入式校验变更另跑 `node apps/desktop/src-tauri/embedded_city_sdk/build.mjs --check`） |
| 全部 Rust 改动 | `git diff --check` + 人工核对完整 diff/diff stat；**禁止运行重写 Rust 的格式化器** |

Tool spec 变更必须通过 `crates/agent-vitals-mcp/src/mcp/mod.rs` 的注册一致性测试（`tool_specs_and_dispatch_agree` 等）。Golden（`golden/`，vitals 数据面）仅在审查过的合同变更时刷新，本改造预计不触及。

## 4. Wave 1 设计要点（已批准）与实施记录（已完成）

**设计要点：**

- **PR01**：`start()` 保存 `previewId`（组件态 + localStorage 按 build 持久化，支持重开恢复）；轮询/停止均带已存 ID；ID 失效显示未运行，不回退 legacy 全局状态；Host 双写保持兼容。
- **PR02**：`state/creator/code-games/operations/<operationId>.json` 回执（请求 sha256 + 结果快照）；同 ID 同 hash 重放返回原结果，同 ID 异载荷报 `operation_id_conflict`；`WorkspaceMeta` 戳记 `operationId` 覆盖"已建未写回执"崩溃窗口。移植 `task_receipt` 模式。
- **PR03**：task_create 校验 ref 归属（preview 属于任务 artifact scope、revision 一致，复用 `task_check_artifact` scope 表模式）；执行前复检；submit 校验 base revision + scope；错误码 `creator_target_ref_not_found/_stale/_scope_conflict`；TS 定义 `StudioTargetRef` tagged union 并保留 targetRefs。
- **PR04**：`run_node` 移植 `creator_agent_executor.rs` 模式（env 白名单、墙钟超时轮询 + 进程回收、有界输出 + 截断标记、结构化超时诊断），build/test 分别设预算；SDK `previewGame.ts`/`headless.ts` 加自身 ticks 上界与墙钟保护。

### 4.1 PR01 实施记录（`3f2136ba`）

- **修改**：`src/codeGamePreview.ts`（新增 `CodePreviewCreatedV1`/`parseCodePreviewCreated`、previewId 校验、localStorage 绑定助手 `read/remember/clearCodePreviewId`、`boundCodePreviewRequest`、`isTerminalCodePreviewStatus`）；`features/preview/CodeGamePreviewPanel.tsx`（start 保存 previewId、轮询/停止仅走绑定身份、未绑定不发请求、终态解绑）；`tests/code-game-preview.test.ts`（+5 测试）。
- **复用合同**：Host `studio_preview`/`studio_status_for`/`studio_stop`（均已有 per-previewId 权威面）；legacy 响应形状解析保持兼容。**无新合同**。
- **Schema/golden**：无。localStorage 键 `oh-agent.studio.code-preview.v1:<buildId>`。
- **检查**：UI typecheck 干净；`npm test` 131 通过（含 5 个新测试）。身份贯通：create 响应 previewId → localStorage → 轮询/停止载荷。
- **残留**：绑定键为面板选中 buildId（组件无 workspaceId prop）；同一 build 的两个并行 Preview 共享一键（后 start 者获胜）；真实窗口级并行隔离**待真机验证**。

### 4.2 PR02 实施记录（`c4847bc0`）

- **修改**：仅 `creator_code_workspace.rs`。`OperationReceipt`（`state/creator/code-games/operations/<operationId>.json`，请求 sha256 覆盖 `{template,title}`）；重放同 hash 返回原结果，异载荷 `operation_id_conflict`；`WorkspaceMeta.operationId`（Option，向后兼容）先于回执落盘，崩溃扫描按 meta 补写回执；operationId 增加宿主 preview-id 同款字符集规则（回执文件名防路径注入）。
- **复用**：creator_session `task_receipt`/`task_canonical_json` 模式与 `operation_id_conflict` 错误码；无新表（MCP 文件态，不经宿主 SQLite）。
- **检查**：`cargo test -p agent-vitals-mcp` 173 通过（+5 新测试：重放/冲突/崩溃恢复/meta 兼容/字符集）。
- **残留**：回执重放不复查工作区目录仍存在（回执即完成凭证）；幂等仅覆盖 project_create，工作区删除/改名不在合同内。

### 4.3 PR03 实施记录（`e5293bed`）

- **修改**：`creator_session.rs`（新 `task_check_target_refs`：projectRevision 对照 artifact 权威 revision；entityId 成员资格对照 project scene 文档 / story graph+canon；entityKind 域检查；cityRevision/worldRevision 对照绑定 City 快照；previewId 经 `creator.task.preview.verify` broker 核对台账。接入 create / execute 启动前 / submit 三段式复核（事务外，不持写锁））；`contracts/studioTask.ts`（类型化 `StudioTargetRef` union，线上扁平形状不变，`parseStudioTask` 保留 targetRefs）；`StudioTaskPanel.tsx`（仅带 previewId 的引用构造结构化绑定）；`useStudioTasks.ts`（签名类型化）；`tests/studio-task.test.ts`（+1）。
- **新错误码**：`creator_target_ref_not_found / _stale / _scope_conflict`；宿主缺席 fail-closed `plugin_unavailable`。
- **Schema/MCP spec**：无（`target_refs_json` 列已存在；tool spec 不变）。
- **检查**：`cargo test -p agent-vitals-mcp` 179 通过（+3 新测试矩阵：伪造/过期/跨项目/scope 冲突 × 三种 artifact、fail-closed、全链路）；UI typecheck + 132 测试。
- **残留（如实）**：① creator-city 的 city-building/city-decor 成员库在 City 运行时，本层只做 kind 域检查；② city/story preview 无 project 场景台账面，不做台账核对（scope+revision 仍强制）；③ 旧 City 文档无 worldRevision 时跳过该项（cityRevision 仍核对）；④ task_claim 不复检（拉取任务可超出 preview TTL，submit 是裁决闸）。
- **UI 行为说明**：从 live 视口选取（无 previewId）不再发送结构化 ref（以前会 create 失败），人读名称保留在目标文本。

### 4.4 PR04 实施记录（`cbdbf670`）

- **修改**：`creator_code_workspace.rs`（`run_node` → `run_node_with_limits`：墙钟预算 build 120s / test 60s 常量、`env_clear` + `PATH/HOME/TMPDIR/TEMP/TMP/AGENT_VITALS_HOME` 白名单（NODE_OPTIONS 永不透传）、单流 256KiB 有界采集+截断标记、unix `process_group(0)`、超时 kill+wait、读取线程 2s 有界 join；build 超时 → `status=failed` + `game_execution_timeout` 结构化 diagnostics；test 超时 → 同码 ToolError 并入脚本错误码映射）；`previewGame.ts`（本地 3600 ticks 上限 + 50s 墙钟 deadline，双循环检查）；`headless.ts`（`TickGuardV1` 注入时钟，`advanceTicks` 可选守卫，默认行为不变）；`tests/runner-boundary.test.ts`（新）。
- **偏差说明**：复用封闭诊断词表既有 `game_execution_timeout`，未新造 `runner_timeout`（诊断 union 不在本次范围）。
- **Schema/MCP spec**：无（输入 schema 不变）。
- **检查**：`cargo test -p agent-vitals-mcp` 179 通过（+3：死循环脚本预算内被杀、300KB 输出截断标记、env 泄漏探针）；city-game-sdk 79 通过 + typecheck 干净。
- **残留（如实）**：未实现 CPU/内存 rlimit（需 libc/wait4，未引入新依赖）；孙进程（esbuild/tsc）不随进程组被信号终止，靠管道关闭退出、2s 有界 join 保证 MCP 不挂死。

### 4.5 Wave 1 边界全套检查（2026-11-27，全部通过）

| 检查 | 结果 |
|---|---|
| `cargo test -p agent-vitals-mcp` | 179 passed / 0 failed |
| `npm run typecheck --prefix apps/creator-studio/ui` | 干净 |
| `npm test --prefix apps/creator-studio/ui` | 132 passed / 0 failed |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` | 566 passed / 0 failed |
| `packages/city-game-sdk` npm test + typecheck | 79 passed / typecheck 干净 |
| `cargo clippy -p agent-vitals-mcp --all-targets -- -D warnings` | 干净（修一处 PR03 测试 `single_match` lint：match→if let） |
| `git diff --check`（每次 Rust 提交前后） | 干净；未运行任何 Rust 格式化器 |

### 4.6 PR05 实施记录（MCP 侧 `ed3eb4b7`；桌面服务臂进行中）

- **解析机制（已核实三选一）**：`creator_cities.document_json` 是配方（name/seed/profile/planPatch）而非 `CityWorldSnapshotV4`；唯一快照生产者是 live 渲染器（`citySnapshot.ts::createCitySnapshotV4`，需活体 terrain sampler）。选择 **broker 模式**：MCP 本地权威 revision 复核（`creator_cities.revision`，PR03 同源）→ broker `creator-studio`/`creator.code.test.city_snapshot`（3s fail-closed）→ 回执自洽复核（声明的 digest/cityId/cityRevision 必须等于快照 header）→ 有界暂存（`MAX_SNAPSHOT_BYTES`，tmp+rename）→ runner `--snapshot/--snapshot-digest`（runner 侧 `validateCityWorldSnapshot` + header digest 对照是密码学校验执行点，不匹配经 `game_package_integrity_failed` 透出）。
- **响应**：移除硬编码 `synthetic:true`，改为 `source:{source:"synthetic"}` 或 `{source:"city",cityId,cityRevision,snapshotDigest}`（优先回显 runner telemetry 报告的世界身份）。
- **新错误码**：`creator_city_revision_stale`、`creator_city_snapshot_unavailable`、`creator_city_snapshot_too_large`、`creator_city_snapshot_invalid`；cityId/cityRevision 必须成对；无任何静默回退合成。
- **测试记录**：`state/creator/code-games/tests/<buildId>.json`（{buildId, workspaceRevision, ok, seed, ticks, source, atMs}），每次真正跑到 runner 的测试都落一条（含失败），供 PR07 发布门消费；PR06 扩展 verdict/scenario/assertions。
- **检查**：`cargo test -p agent-vitals-mcp` 188（+9）；clippy 干净。
- **残留/缺口**：① 桌面宿主尚未提供 `creator.code.test.city_snapshot` 服务臂（本 PR 范围内 MCO 侧 fail-closed 诚实报错；宿主臂另行补全，见跟踪表）；② broker 默认 64KiB 响应预算，真实快照超限会以 `creator_city_snapshot_unavailable` 报错直到宿主提高每方法预算；③ 单测覆盖解析/暂存/参数/记录 seam，真实端到端 runner 运行待宿主臂落地后验证。

### 4.7 PR07 实施记录（`d4e14d02`）

- **门禁矩阵**：桌面 accept 拒绝 `hostDisagreement`（`creator_candidate_host_disagreement`，本地接受仍容忍 city-client-reported）；桌面直接发布强闸（仅新建 Release 过闸，幂等重发布与 `creator_release_conflict` 保持原行为）要求同 (project, revision) 候选 + 快照摘要一致 + 最新 run completed + 证据一致 + `evidenceSource=host-verified` + 无 hostDisagreement（`creator_release_evidence_required`）；MCP `creator_code_publish` 要求同 buildId 的通过测试记录且 workspaceRevision 现势（`creator_code_test_evidence_required/_stale`）；install 不设冗余闸（只登记已发布包，发布闸不可绕过）。
- **流程盘点**：`publish_project_release`/`insert_project_release` 无模板引导/迁移导入等生产旁路（全仓检索确认）；全部非测试调用点已审计。
- **UI**：`canAcceptCandidate` 增加 hostDisagreement 拒绝；新增 `canReleaseCandidate`（host-verified 档）；`CandidatePanel` 直接发布按钮按发布档禁用并给出解释文案（仅呈现，宿主仍为裁决者）。
- **测试种子**：`seed_host_verified_candidate` 助手（return_consumed=1、created_at_ms=1，不进 return_context、历史排序恒最旧）；`plugin_host.rs` headless 臂测试按协调者批准做仅测试代码最小修改（保持"无特例"性质，走同一道闸）。
- **检查**：桌面 lib 567（+1 门禁矩阵测试）、MCP 188、UI 133、`git diff --check` 干净。
- **残留（如实）**：人工评审记录（Review Record）未建模（PR06/PR09 落地时扩展）；MCP 门绑定 workspaceRevision，PR05 记录带 snapshotDigest 后可加强为摘要相等；桌面门禁错误码为 `&'static str`，面板展示宿主拒绝码需要新的状态线（范围外）。

### 4.8 PR06 实施记录（`3b5ca9eb`；含 digest 对齐）与 PR05 桌面服务臂（`4f5cfb90`）

**PR06（执行成功 ≠ 测试通过）：**
- **SDK**：`src/testing/scenario.ts` 定义 `GameTestScenarioV1`（封闭断言词表 7 种：outcome / entityCountAtLeast / entityCountAtMost / hudFlag / counterAtLeast / counterEquals / finishedWithinTicks，全部 end-of-run 确定性求值；不可评定的断言报 `unknown`，verdict 降级 `inconclusive`，绝不静默通过；`entityPresent` 因 telemetry 无实体清单而明确不设）。evaluator 取结构化 `GameTestRunObservationV1`，`src/` 保持边界干净（无墙钟）。verdict 决策表：断言有 unknown → inconclusive；有 failed → failed（即使预算截断）；全过但游戏仍在 running → inconclusive/tick_budget_exhausted；全过且游戏自达终态 → passed。
- **MCP**：`creator_code_test` 接受 ≤8KiB inline `scenario`（MCP 小形状检查，深度校验在 runner），响应恒有 `executionOk + verdict`（无场景 → inconclusive/no_scenario）；MCP 交叉复核 runner 的 verdict（不可信的 passed 降级 inconclusive）；失败路径记录 executionOk=false + verdict=failed。测试记录扩展同字段；PR07 发布门收紧为 `verdict==="passed"`（pre-PR06 无 verdict 记录 → stale）。新增只读 `creator_code_test_record` 工具（仅 buildId 入参，64KiB 界）。
- **UI**：Evidence Center fail-closed 解析记录并渲染 executionOk/verdict/scenarioId/来源身份与逐断言结果（折叠）。
- **digest 对齐（同提交）**：真实 SDK 快照 `snapshotDigest` 为 `sha256:<64hex>` 前缀格式——回执声明必须与 header 逐字相等（新增 verbatim 测试），原样传给 runner `--snapshot-digest`，接受前缀或裸 64-hex（兼容）。
- **检查**：SDK 87（+7，含真实 sealed-build 无头运行）、MCP 192、UI 135、clippy 干净。
- **残留**：无逐 tick 断言（runner 无历史）；场景仅请求级，无持久化库（PR09/PR11）；UI 经桌面路由回读记录（路由见下）。

**PR05 桌面服务臂（`4f5cfb90`）：**
- **事实链（已核实）**：`CityWorldSnapshotV4` 唯一生产者是 live 渲染器（`createCitySnapshotV4`，需活体 terrain sampler + generator identity digests）；宿主此前只持久化 layout 快照（`CityLayoutSnapshotV3`），渲染器从不向宿主发送世界快照。
- **实现**：预览窗口新增窄白名单 `plugin_message` 通道 `city.snapshot.export`（label↔previewId 配对守卫）；宿主缓存 `state/creator/code-games/city-snapshots/<cityId>-<revision>.json`（原子写，≤1MiB−4KiB，每城保留最新 2 版），入库三重绑定（preview source 非合成且同城 + 权威 revision 现势 + header 身份自洽）；broker 服务 `creator.code.test.city_snapshot`（`creator_row` 管线 + Studio 在场 poll 拦截 + headless 臂三面同答），描述符响应预算提至 1MiB（§5.5 IPC 钳制上限），超限 `plugin_call_too_large` → MCP `creator_city_snapshot_unavailable`；同时新增 `creator.code.test.record` 桌面路由（UI 证据中心回读记录）。
- **检查**：桌面 lib 576（+8，含 1MiB 满预算真实 respond_with_budget 回旋）。
- **残留**：① 渲染器导出发射端（`startCodeGamePreviewV2` 物化快照后发一条 `city.snapshot.export`）**待 PR08 接线**——未接线前 City 路径诚实 fail-closed（PR08 已接线，见 §4.9）；② >1MiB 快照按策略钳制拒绝（调高需改 §5.5 钳制，桌面策略决定，本波不动）；③ 宿主校验为结构/身份一致性，密码学校验仍在 runner。

### 4.9 PR08 实施记录（`0ab0b7b4`）

- **渲染器/SDK**：`CodeGameHostV2.setInput()`（≤32 个有界标量键、run 域、dispose 清空，游戏仅经 `ctx.input.actions()` 读取）；`CodeGameRunV2.setInput` 透传；`codeGamePreviewV2` 在真实城市快照物化后发射一次 `city.snapshot.export`（**PR05 导出环闭合**，仅带 `__AV_CODE_PREVIEW_ID__` 且非合成源）；playtest 控制信封并入既有 `city.code.preview.next` 拉取联合（`playtest.input/capture/end`）；`useCodeGamePreview` 防御性形状复核 + 应用到本窗口自己的 run + ack 发布（V1 run 诚实回 `game_run_not_found`）+ 经 `CityEngine.captureFrame` 截图 + `playtest.end` 释放按住键。
- **桌面宿主**：每 preview 的会话层（`playtest.json`/`capture-request.json`/`screenshot.json`）；封闭动作词表（1..8 键、`[A-Za-z0-9_.-]`、bool 或有限数 ≤1e6）+ 常量上限（64 动作、120s 窗口、4 批队列、5s 按住、64 steps，预算计入排队动作）；每 preview 单活跃会话；run `finished/error` 时会话终态化并撤销截屏请求；serve 臂搭既有 `city.code.preview.next` 拉取（优先级 end→capture→input）；按 sessionId+seq 记录 ack；有界截屏存储（350K dataUrl 字符/512KiB 文件，绑 previewId/buildId/tick）；`studio_status_for` 增加 `playtest` 投影（lastInputAcceptedAtMs/lastError/acceptedActions）。**永不自动断言 passed**（结论留给 PR06 场景机制）。`code_preview_window.rs` 新增两个白名单 `plugin_message` 类型（`playtest.input.result`/`playtest.screenshot`，置于既有 label↔previewId 配对之后）。
- **MCP**：新模块 `creator_code_playtest.rs`——`creator_code_playtest_input`（词表+上限，需 `--allow-local-writes`，preview 缺失/未运行 → `not_found`/`failed_precondition`）、`creator_code_playtest_screenshot`（有界，复用 `capture_result_envelope` 图像块纪律，诚实 `creator_capture_unavailable`）、`creator_code_playtest_stop`（幂等）、`creator_code_playtest_result`（只读，绑 previewId/buildId + 缓存时的城市快照摘要；**verdict-safe，无 passed/failed 字段**，断言指向 `creator_code_test`）；`mod.rs` 注册+权限闸；`creator_code_preview_status` 增加可选 playtest 投影。MCP 写侧与宿主 serve 侧独立执行同一封闭词表（篡改队列文件无法夹带越权动作）。
- **关键设计**：无新宿主→webview 通道（控制搭既有轮询拉取；焦点隔离是结构性的——只有配对窗口的轮询能认领，setInput 只达本窗口的 run）；MCP 会话文件直写 `previews/<previewId>/`（`stage_preview` 先例，Studio 关闭时可用，不占 creator-studio 信箱）。
- **检查**：桌面 lib 580（+4）、MCP 196（+5）、SDK 87 + typecheck、agent-city typecheck、UI 135（未触及）+ typecheck、clippy、`git diff --check` 全部干净。
- **残留/待真机验证**：① webview 跳跃无法在宿主单元测试运行——input→serve→setInput→ack 全链按宿主侧测试（队列/serve/ack/预算/终态清理）+ 渲染器逻辑 typecheck 验证；**input/截屏往返、预览窗口截图、渲染器导出发射均待真机验证**；② 主 City 窗口导出接线按计划暂缓（合成与主窗口路径有意跳过导出，宿主无 previewId 无法配对）；③ apps/agent-city 对此 hook 无单元测试 harness（window/DOM 依赖），如实记为缺口；④ 自动试玩的输入/断言预算尚未与 PR11 的修复轮次预算挂钩（Wave 3 工作）。

### 4.10 Wave 2 边界全套检查（2026-11-28，全部通过）

| 检查 | 结果 |
|---|---|
| `cargo test -p agent-vitals-mcp` | 196 passed / 0 failed |
| `npm run typecheck --prefix apps/creator-studio/ui` | 干净 |
| `npm test --prefix apps/creator-studio/ui` | 135 passed / 0 failed |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` | 580 passed / 0 failed |
| `packages/city-game-sdk` npm test + typecheck | 87 passed / typecheck 干净 |
| `npm run typecheck --prefix apps/agent-city/ui` | 干净（exit 0） |
| `cargo clippy -p agent-vitals-mcp --all-targets -- -D warnings` | 干净 |
| `git diff --check`（每次 Rust 提交前后） | 干净；未运行任何 Rust 格式化器 |

## 5. 待真机验证项（自动化覆盖不到，最终 MVP 验收由用户在桌面构建执行）

- 并行 A/B Preview 双开的真实窗口隔离、Studio 关闭重开后的 Preview 身份恢复（PR01）。
- Tower Defense 纵向闭环十步（规范 §11）与 §11.1 非功能基准首测（PR14 之后）。
