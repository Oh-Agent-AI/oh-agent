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
| 01 · Preview 身份隔离 | UI 绑定 previewId | 未开始 | — | — |
| 02 · Workspace 幂等 | operationId 回执 | 未开始 | — | — |
| 03 · TargetRefs 权威校验 | Host 创建/执行/提交校验 | 未开始 | — | — |
| 04 · Runner 资源边界 | 超时/预算/环境清理/进程树回收 | 未开始 | — | — |
| 05 · City Snapshot Test | MCP→Host→SDK 冻结快照 | 未开始 | — | — |
| 06 · Scenario/Evidence | verdict 拆分与断言 | 未开始 | — | — |
| 07 · Candidate/Release 门禁 | Host 统一证据检查 | 未开始 | — | — |
| 08 · Automated Visual Playtest | 隔离 Preview 自动试玩 | 未开始 | — | — |
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

## 4. Wave 1 设计要点（已批准）

- **PR01**：`start()` 保存 `previewId`（组件态 + sessionStorage 按 workspace 持久化，支持重开恢复）；轮询/停止均带已存 ID；ID 失效显示未运行，不回退 legacy 全局状态；Host 双写保持兼容。测试：轮询带 ID、并行 A/B 不串线（`tests/code-game-preview.test.ts`）。
- **PR02**：`state/creator/code-games/operations/<operationId>.json` 回执（请求 sha256 + 结果快照）；同 ID 同 hash 重放返回原结果，同 ID 异载荷报 `operation_id_conflict`；`WorkspaceMeta` 戳记 `operationId` 覆盖"已建未写回执"崩溃窗口。移植 `task_receipt` 模式。
- **PR03**：task_create 校验 ref 归属（preview 属于任务 artifact scope、revision 一致，复用 `task_check_artifact` scope 表模式）；执行前复检；submit/confirm 校验 base revision + scope；错误码 `creator_target_ref_not_found/_stale/_scope_conflict`；TS 定义 `StudioTargetRef` tagged union 并保留 targetRefs。
- **PR04**：`run_node` 移植 `creator_agent_executor.rs` 模式（env 白名单、墙钟超时轮询 + 进程组 kill、有界输出 + 截断标记、结构化超时诊断），build/test 分别设预算；SDK `previewGame.ts`/`headless.ts` 加自身 ticks 上界与墙钟保护。

## 5. 待真机验证项（自动化覆盖不到，最终 MVP 验收由用户在桌面构建执行）

- 并行 A/B Preview 双开的真实窗口隔离、Studio 关闭重开后的 Preview 身份恢复（PR01）。
- Tower Defense 纵向闭环十步（规范 §11）与 §11.1 非功能基准首测（PR14 之后）。
