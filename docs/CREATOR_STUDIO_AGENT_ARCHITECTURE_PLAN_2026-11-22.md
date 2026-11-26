# Creator Studio Agent 架构优化方案

本文取代架构优化方案中的里程碑排序：以**用户体验统一**为主线。最新方向与批次见 [Creator Studio Agent 体验重设计](CREATOR_STUDIO_AGENT_EXPERIENCE_REDESIGN_2026-11-23.md)（R1 统一确认接口 / R2 账本术语下沉 / R3 权限显式化优先于协议改造）。

2026-11-22 · 依据 [T3 Code](https://github.com/pingdotgg/t3code) 源码分析（本地 clone 审读 provider-core / effect-acp / server 持久层）与本轮真机创作测试。上游关联：[编辑器重构实施说明](CREATOR_STUDIO_EDITOR_REFACTOR_IMPLEMENTATION_2026-11-22.md)、[Studio V2 PRD](OH_AGENT_CREATOR_STUDIO_V2_PRD_RFC_2026-11-20.md)。

## 一、诊断：优势没发挥在哪，体验差在哪

我们相对 T3 Code 有两样它没有的东西，但都没被体验兑现：

| 已有优势 | 现状问题 |
| --- | --- |
| **诚实闸**：宿主生成 Preview、revision CAS、证据分信任级（host-observed / creator-declared） | 证据折叠在「已有活动与证据」里；失败只给 `codex_failed` 裸码；用户看不到"为什么不能确认" |
| **任务账本**：阶段机 + 事件 + operationId 幂等 + pull 模式认领 | 只有 Studio 一个消费者；事件是粗粒度列表，没有实时输出；pull 模式没有真实接入方 |

体验层面的四个痛点（全部来自本轮真机测试）：

1. **仪式闸**：批准计划批的是常量模板（`defaultStudioPlanSteps` 三步套话），一次创作 4 次点击，真实决策只有 2 个（开始花配额、确认落盘）。
2. **单通道死锁**：`codex exec` 一次性回合、stdin 关闭，无 steer、无续跑；Codex 用量限额时任务直接失败，用户只能等（本轮实测复现）。
3. **干预分散**：计划批准、验收意见、确认保存三套表单形态各异，无统一的"待决事项"入口。
4. **失败无路可走**：没有换 Agent 重试；ACP 执行器是桩，`executor: acp` 选项名存实亡。

## 二、目标架构：ACP 为主通道，T3 的合同、我们的闸

```
┌─ Studio UI（React）──────────────────────────────┐
│  决策收件箱（RuntimeRequest 队列）                  │
│  实时任务输出流（turn_item + delta 分层）           │
│  语义 diff 验收卡（按构件类型）                     │
└──────────────┬───────────────────────────────────┘
               │ creator.task.*（现有 MCP 面，追加不破坏）
┌──────────────▼───────────────────────────────────┐
│  宿主编排（creator_session.rs）                    │
│  阶段机保留为账本 · RuntimeRequest 审批队列         │
│  证据信任级 · Preview 校验 · revision CAS（不动）   │
└──────────────┬───────────────────────────────────┘
               │ Executor trait v2（会话化）
┌──────────────▼───────────────────────────────────┐
│  执行器注册表                                      │
│  ├─ ACP 适配器（主通道，任何 ACP agent 零适配）      │
│  ├─ Codex CLI 适配器（降级为兼容路径）              │
│  └─ （可选）codex app-server 原生适配器             │
└───────────────────────────────────────────────────┘
```

**立场**：依赖 ACP 协议作为战略主通道。理由：T3 用 8.4k 行的 `effect-acp` 证明 ACP 足以承载完整 turn 流（session/prompt、session/update 流、permission request、steer）；我们自研的 Codex JSONL 解析是单供应商专用路径。Codex 本体走它自己的协议（CLI 兼容路径保留，app-server 原生适配可选），**第三方 agent 一律 ACP 注册表接入，零适配**。

**不可妥协的底线**（区别于 T3 的地方，不能学掉）：Agent 永不落库，写路径只有宿主 Preview→人工确认→commit；证据信任级不松动；能力之外的 ACP agent 如实降级（`plugin_unavailable`），不冒充能力。

## 三、五项核心改造

### A. RuntimeRequest 统一审批队列（替代三套干预表单）

学 T3 的 `OrchestrationV2RuntimeRequest`，收敛为单一形态：

```
RuntimeRequest {
  requestId, taskId, nodeId?, kind: plan_approval | preview_confirm | user_input | permission,
  status: pending → resolved / expired / cancelled,
  decision: accept | accept_for_session | decline,
  payload: 随 kind 变化（plan_steps / preview 摘要 / 提问）
}
```

- 计划批准保留在合同里，但**默认模板自动通过**（账本照记三次操作），只有 agent 或外部 agent 提交了**非默认计划**才停在 pending——闸必须展示能改变决策的信息。
- `accept_for_session` 记住本项目本次会话的选择（如"场景对象改动不再逐个确认"），减少重复点击。
- `expired` 对接 Preview TTL。
- UI 变成一个决策收件箱：任务卡片上有几个待决事项，逐个 resolve。

### B. Executor trait v2：会话化传输

```rust
trait CreatorAgentExecutorV2 {
    fn open_session(&self, ctx) -> SessionHandle;
    fn run_turn(&self, session, message) -> TurnStream;   // 事件流，非阻塞
    fn steer(&self, session, message);                    // T3 语义：pending 直到 agent 读取
    fn interrupt(&self, session);
    fn respond_runtime_request(&self, session, requestId, decision);
}
```

- ACP 实现完整版（session 多回合天然支持 steer/continuation）。
- Codex CLI 实现降级子集：`run_turn` 保留现有一次性路径，`steer` 如实返回 `steer_unsupported`（不假装支持）。
- 任务时长上限从 90s 放宽到可配置（会话化后长任务才有意义）。

### C. 执行器注册表 + 健康探针 + 交接

- 启动时探测可用执行器（Codex CLI 在不在、ACP agent 能否 initialize），任务表单只列**真实可用**的通道。
- 失败类型化：`codex_quota_exhausted`（解析 "usage limit" 输出）、`codex_auth_expired`、`acp_handshake_failed`——配额类失败自动建议「换 Agent 重试」。
- 交接 = 账本已有语义（failed → revise → ready）+ `executeTask(executor)` 换参数，UI 补一个按钮。

### D. 实时输出流（T3 的 turn_item / delta 分层）

- `creator_task_events` 增加 `chunk` 类事件（agent_message 增量），终项仍以完整 turn_item 落库；订阅端（`creator.events.subscribe` 长轮询已有）加 `include_delta` 参数。
- UI：任务执行中显示实时输出区，完成后折叠为摘要。证据信任级不变（agent-reported 增量 + host-observed 终项）。

### E. 语义 diff 验收卡

确认保存卡按构件类型展示结构化摘要，不再展示原始 JSON：
- **Game/场景**：`+1 场景对象（树）`、`+2 检查点`、`入口锚点未变`。
- **Story**：`节点 +2 / 边 -1 / canon 角色 +1`，入口节点变化标红。
- **City**：`world.set：shape.family → lobed`，3D 预览沿用现有 `agentCityPreview`。

## 四、里程碑与验收

| 里程碑 | 范围 | 验收 |
| --- | --- | --- |
| **M1 决策收敛**（纯 UI + 少量 MCP，可先行） | 快速通道（目标→自动链→执行）、确认卡语义 diff、失败码透传完善 | 一次创作 2 次点击；三构件验收卡各有结构化摘要；桌面截图 |
| **M2 注册表与交接** | 执行器健康探针、失败类型化、「换 Agent 重试」、模型透传（任务级） | Codex 限额（或人为断开）时切换 ACP agent 完成同一任务；账本证据连续 |
| **M3 ACP 执行器补全** | ACP v1 完整回合（initialize/new/prompt/update 流/permission request）、Executor trait v2、steer（ACP only） | 用任一注册表 ACP agent 走通 Game 三闭环；steer 插话被回合采纳；Codex CLI 路径回归不破 |
| **M4 实时流 + 收尾**（可选） | chunk 事件、实时输出区、codex app-server 原生适配评估 | 长任务执行中有实时输出；steer 在 30s 内被采纳 |

每个里程碑按仓库惯例：相关包 checks 全绿 + 原生桌面截图验收 + golden 契约仅在评审过的变更时刷新。

## 五、明确不做

- 不引入 Effect 或类似框架全家桶；Stay in Tauri + rusqlite + React。
- 不做多端同步（手机批准桌面执行），单机单窗口优先。
- 不做 10 家 provider 矩阵：ACP 注册表即覆盖，注册表没有的 agent 不适配。
- 不放松诚实闸换体验：任何"看起来更快"的路径若绕过宿主校验，一律不做。

## 六、风险与对策

| 风险 | 对策 |
| --- | --- |
| ACP agent 能力参差（工具/文件/MCP 支持不一） | initialize 时能力协商，缺什么如实显示"该 agent 不支持 X"；Creator MCP 只读策略对所有执行器一致 |
| Codex 无官方 ACP 端点 | 保留 CLI 兼容路径；app-server 适配放 M4 评估，不阻塞主线 |
| `accept_for_session` 弱化人工审查 | 作用域只到"本项目 + 本次任务会话"，跨项目/重启失效；preview_confirm 不纳入可记忆范围（落盘闸永不免检） |
| 阶段机变更破坏 pull 模式合同 | RuntimeRequest 是新增面，阶段机原样保留；golden 契约按仓库规则评审后刷新 |
| 范围蔓延到 T3 体量 | 里程碑各有独立合并条件；M4 起每步先讨论再动手（T3 的治理规则值得学） |
