# Agent Vitals Runtime Event Bus Architecture Spec

> 状态：**Draft v1.5（2026-09-21）**（v1.4 基础上：迭代 4 落地 TrustMonitorEvent——快照传感已在写入事务内发射，correlate 保持同事务内联的裁决与理由，载荷勘正为运行级摘要）；（v1.3 基础上：迭代 3 落地 retention——deliveries 独立 TTL 勘正为随事件走、HourTicked/DayRolled 降为保留位、v18 孤儿函数 retention_trust_observations 接线进每日 maintenance）；——v1 收敛、v1.1 并入 apalis-sqlite 研究（§12）、v1.2 为 P0 实施修订（v23 迁移/反连接/两段式 drain/尾部保序）；v1.3 为 **迭代 2 实施修订**：`McpToolInvoked` 的生产者定为 **CLI serve 传输层**而非 `mcp::dispatch`（桌面/CLI 内部自用调用不是审计对象——只有外部 agent 的 `tools/call` 是）；审计批次按**进程×库**一条（`trigger='mcp-audit'`，沿 trust-audit 的 per-invocation run 先例但按进程聚合）；未同步机器无库则跳过且**不建库**；参数只入 fnv1a64 指纹（原始参数禁令 §4.1）；
> 前置：v0.9.1 SQL 权威库已冻结（单一事实源 + 幂等重放）；trust P1（`FINDINGS_TRUST_EGRESS_MONITORING_SPEC`）已合入，P2 实时传感器未实施；
> 目标：为 runtime 引入**最小事件驱动层**——事务性 outbox + 单管道类型化事件——收编既有的内联反应链与缓存失效土办法，并为 trust P2 传感器预留唯一接入通道。

---

## 0. 一句话结论

事件总线只做一件事：**把"权威库已前进"这一事实可靠地告诉所有想知道的人**。它不承载写路径编排（tick 流水线保持显式）、不承载 RPC（MCP dispatch 保持请求-响应）、不承载事务（billing 写入保持原地事务）。可靠性住在 SQLite 的 outbox 表里（与状态变更同事务），速度住在进程内 `mpsc` 里（丢了由 tailer 补投）——与既有 `sync_runs` + 幂等重放是同一哲学的延伸，不是第二套机制。

## 1. 不可变决策（实施期间不重开）

1. **事件是事实的过去时陈述**。词表一律过去时命名（`FactsIngested`，不是 `IngestFacts`）；事件不携带指令、不携带期望回报。
2. **outbox 事务性是唯一可靠性来源**。事件必须与它描述的状态变更在**同一 SQLite 事务**内落 `event_outbox` 行；进程内通道只优化延迟，永不承担可靠性。禁止"先写库再发事件"的双写。
3. **单一 UI 出口**。对 webview 只有 `app.emit("app-event", typed_event)` 一个出口；`FOLD_EVENT` / `SYNC_STATUS_EVENT` 收编进该出口，去抖收敛到分发层一份。
4. **旁路面永不上总线**：tick 流水线编排、MCP `tools/call`、CLI 查询子进程、billing 事实写入（golden 逐字节面）、`doctor::diagnose` 纯函数。见 §8。
5. **trust 传感器独立于被审计者**。trust P2 的进程外传感器（FSEvents / fd 采样 / 连接轮询）经 `TrustMonitorEvent` 接入总线；**执行环境 agentic-loop hook 永不作为 trust 面信号源**（被审计者控制传感器 = 信任面失守），hook 仅可作为 canonical 面的增强源（§9）。
6. **每条事件带 `schema_version` 与 correlation id**（复用 `ingested_run_id` / `sync_runs.run_id`），事件词表按 authority schema 的兼容纪律演进：只增不删不改语义。
7. **at-least-once 投递，消费者幂等**。补投意味着同一条事件可能到达两次；幂等键 = `(event_id, consumer_id)`，由消费侧维护。

## 2. 现状与动机（代码证据）

| 现状 | 证据 | 事件化后 |
|---|---|---|
| 入库后的反应是内联调用链 | `sync_service.rs:499` 尾部内联 `price_discovery::reconcile_unpriced_models`；配额窗口扫描由 tick 顺序编排 | `FactsIngested` 扇出，消费者各自异步 |
| issue 评估是查询时惰性 | `store.rs::sessions_issues` 注释自认"先刷 legacy evaluator 再读表"——消费者（用户点开 tab）替生产者付计算 | 入库后后台评价，查询面只读 |
| 缓存失效是三套土办法 | `calendarLoadedMonth` 月份比对、`FoldEventDebounce` 去抖、skills 扫描时间戳缓存 | `AuthorityRevisionAdvanced` 统一驱动 |
| UI 事件是裸字符串各自去抖 | `lib.rs:1207/1219` 的 `FOLD_EVENT` / `SYNC_STATUS_EVENT` | 收编单一类型化出口 |
| trust observation 过期无人清理 | `expires_at_ms` 靠查询时惰性过滤，无删除动作 | `DayRolled` 时间事件驱动维护 |
| MCP 访问无审计流 | `data_status` 的查询面无时序数据；agents 查了什么无处可查 | `McpToolInvoked` 审计旁路（fire-and-forget） |

**动机排序**：①消灭"加一个反应就要改一次生产者"的扇出耦合（`FactsIngested` 五消费者）；②缓存失效统一（替换三套土办法）；③为 trust P2 预留唯一接入点，防止届时用裸 `app.emit` 拼装。

## 3. 架构总图

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  ① 写路径（显式编排，不上总线——顺序与失败语义必须可判定）                          │
│                                                                                 │
│  tick / 手动同步                                                                 │
│    discover ──► oneline fold ──► claude-sync ──► sync-facts ──► plugin_ingest   │
│                                          │                                      │
│                                          ▼                                      │
│                    ┌──────────────────────────────────────┐                     │
│                    │   authority SQLite（唯一事实源）        │                     │
│                    │   usage_facts / workflow_events /      │                    │
│                    │   issue_instances / trust_observations │                     │
│                    │   … + event_outbox（新） ◄─────────────┼─── 同一事务         │
│                    └──────────────────────────────────────┘                     │
│                                          │ 事务提交                              │
│                                          ▼                                      │
│  ┌──────────────────────────── ② 事件总线核心（双通道）────────────────────────┐ │
│  │   快通道：tokio::sync::mpsc<AppEvent>（有界，过载丢低优先级，只管低延迟）      │ │
│  │   慢通道：outbox tailer（读 event_outbox，崩溃后补投，与幂等重放同构）         │ │
│  │                                                                             │ │
│  │   事件词表（过去时，全部带 schema_version + ingested_run_id 作 correlation）   │ │
│  │   ├─ FactsIngested{harness, run_id, revision}                                   │ │
│  │   ├─ AuthorityRevisionAdvanced{revision}                                     │ │
│  │   ├─ DeclarationSaved / PriceCardSaved                                        │ │
│  │   ├─ HarnessSourceFailed{harness,error} / SourceRecovered{harness}                     │ │
│  │   ├─ McpToolInvoked{tool, args_fingerprint, latency_ms, ok}   ◄── 审计旁路    │ │
│  │   ├─ TrustMonitorEvent{run_id, observations, inserted…}        ◄── P2 传感器   │ │
│  │   └─ HourTicked / DayRolled（statistics_timezone 口径）                       │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                          ▼                                      │
│  ┌────────────────────────── ③ 消费者（各自异步反应，互不阻塞）──────────────────┐ │
│  │  派生重算扇出                  缓存失效                    审计流              │ │
│  │  ├─ price reconcile           ├─ webview tab 缓存重验      ├─ MCP 访问日志    │ │
│  │  ├─ 配额窗口扫描               ├─ 托盘标题重算             └─ 慢查询/失败率    │ │
│  │  ├─ 预算状态重估               └─ codex_merged 等进程内缓存                     │ │
│  │  ├─ issue 评估器              通知（去重窗口内）          时间性维护             │ │
│  │  └─ trust correlate           ├─ 预算/配额提醒            ├─ expires_at 清理   │ │
│  │                                └─ trust 报警（§7.2 门槛） └─ 价格快照 stale   │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                          ▼                                      │
│                    单一 UI 出口：app.emit("app-event", typed_event)               │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│  旁路（永不上总线）：MCP dispatch═══RPC═══>直接返回（完成后发审计事件）              │
│                      billing 写入 / golden 面 ── 事务一致性红线                    │
│                      doctor::diagnose 纯函数 ── 确定性 + 差分门                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

事务边界（outbox 可靠性来源）：

```
   sync_service 事务（既有）                          消费端
  ┌────────────────────────┐
  │ BEGIN IMMEDIATE        │
  │  INSERT usage_facts    │      ┌──────────────┐
  │  INSERT workflow_evts  │      │ dispatcher   │   快通道命中 → ms 级投递
  │  INSERT event_outbox ──┼─────►│ mpsc + tailer│   崩溃/丢件 → tailer 从
  │ COMMIT                 │      └──────────────┘   outbox 补投（幂等键 =
  └────────────────────────┘                          event_id + consumer_id）
```

## 4. 数据契约

### 4.1 `AppEvent` 信封（runtime 层冻结 DTO）

```text
event_id            稳定哈希 ID（幂等键成分）
event_type          §5 词表的闭集值
schema_version      事件契约版本（与 authority schema 演进纪律同款：只增不删）
occurred_at_ms      事实发生时刻（非投递时刻）
correlation_id      可空；来源批次（sync_runs.run_id / IPC 序列）
producer            模块标识（sync_service / mcp::dispatch / trust_monitor / timer）
payload_json        仅枚举值、计数、哈希与时间戳
```

禁止字段：与 `TrustObservation` 同一禁令——原始路径、文件内容、prompt/messages、tool 参数/结果原文、请求体、凭据。审计旁路（`McpToolInvoked`）只带参数**指纹**。

### 4.2 `event_outbox` 表（下一 authority schema 版本追加）

```sql
CREATE TABLE event_outbox (
  event_id        TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  occurred_at_ms  INTEGER NOT NULL,
  correlation_id  TEXT,
  producer        TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  created_at_ms   INTEGER NOT NULL
);
-- 投递进度按 (event_id, consumer_id) 反连接（见下方实施修订），索引只管扫描序。
CREATE INDEX event_outbox_pending ON event_outbox(created_at_ms, event_id);
```

**实施修订（v1.2）**：投递进度不用 outbox 行上的单一 `delivered` 位，而按 `(event_id, consumer_id)` **反连接**计算——消费者注册面随进程不同（CLI 一组、桌面一组），一个进程置位会让另一个进程的消费者永远看不到。因此索引为普通的 `(created_at_ms, event_id)`（终态行靠 retention 清理离开热区），`event_deliveries(event_id, consumer_id, delivered_at_ms, last_error, PRIMARY KEY(event_id, consumer_id))` 记录消费进度。

**retention（v1.4 勘正）**：事件体保留 7 天；**投递记录随事件走**——deliveries 是反连接的去重账本，事件存活期间删它的 delivery 会让反连接重新发现该事件 = 重投递（本稿 v1.1 写的「deliveries 独立保留 30 天」是重投递陷阱，作废）。清理顺序固定：扫孤儿 delivery（事件已亡）→ 删到期事件的 delivery → 删事件本体，一事务。清理挂在每日 maintenance run（`retention_event_outbox`，与 usage_facts/session_excerpts 同一趟），陷阱判别由 `retention_event_outbox_never_deletes_delivery_of_live_event` 钉住。`delete_imported_harness_data(harness)` 先删该执行环境事件的 deliveries 再删 outbox 行（harness 为列，全局事件 NULL 不受影响），已由级联测试钉住。

### 4.3 投递语义

- 快通道（**hook 叫醒，不带货**）：rusqlite `Connection::update_hook` 过滤 `Insert ∧ table=event_outbox` 后只向 dispatcher 发一个**唤醒信号**（不带事件体）——投递仍是一次批量 SQL 扫描。单一数据路径避免"hook 读一行 + fetch 再读一遍"的双读与形状分叉（apalis-sqlite `callback.rs` 的生产验证，见 §12）。**注意 SQLite 语义**：update_hook 只对**本连接**的写入触发——多进程（CLI 写、桌面投递）下跨连接唤醒靠「事务提交后显式 drain」；P0 即此形态（同步尾部一次 drain，新事件与崩溃残留同轮补投，且保住「价卡快照先行于 price-reconcile 消费者」的原有顺序）；常驻 dispatcher + 同连接 hook 是 P1 桌面接线；
- 慢通道（轮询兜底）：tailer 每 5 秒或进程启动时扫 outbox 补投；hook 失效（跨进程写入、回调丢失）时轮询保证最终投递；
- 扫描采用**原子认领形状**（apalis-sqlite `fetch_next.sql` 同款思路）：单语句完成认领与状态迁移，无 SELECT-then-UPDATE 竞态。**实施修订（v1.2）**：P0 的 drain 为**自动提交两段式**——反连接查（单语句）→ 调 handler（**自持连接**，drain 不持事务）→ 记账（`INSERT OR REPLACE` deliveries）。消费者可能写库（price-reconcile 建 issue），drain 若持事务会与自己锁死；「先处理、后记账」的崩溃语义（处理成功才记账，崩溃于两者之间=未投递，下轮重扫）不依赖事务包裹；
- `mpsc::channel(1024)` 有界；满时按 `event_type` 优先级丢弃（audit < maintenance < derived < notification），并计数 `dropped_count`（沿 trust 规格 §6.2 的过载纪律）；
- **不保证顺序跨事件类型**；同类事件按 `occurred_at_ms` 有序。消费者不得假设跨类型顺序。

## 5. 事件词表（首批冻结）

| 事件 | 生产者 | 触发时机 | 首批消费者 |
|---|---|---|---|
| `FactsIngested{harness, run_id, revision}` | sync_service / plugin_ingest | 某执行环境事实批次事务提交 | price reconcile、配额窗口扫描、issue 评估器、（P2）trust correlate |
| `AuthorityRevisionAdvanced{revision}` | **保留位（无生产者，2026-09-22 修订）**——`RUNTIME_INVALIDATION_AND_READ_BACKPRESSURE_SPEC.md` §4.1/§4.4 裁定：revision 的逐次推进是**派生投影**，不逐条落 outbox（那会把写放大带回总线）；UI 失效走 `ChangePublisher` 直发 `Invalidated{revision, harnesses}`（仅 revision 严格前进时），词表仍登记本行以维持闭集稳定 | —（经直发 `Invalidated` 信号服务 webview/tray） |
| `DeclarationSaved{scope}` | 桌面 IPC（计费声明保存） | 声明/修订落库 | billing 重算入队、（预留）影响预览 |
| `PriceCardSaved{provider, model_fingerprint}` | 桌面 IPC（补卡保存） | 价卡落库 | 未计价重算 |
| `HarnessSourceFailed{harness, error_code}` / `SourceRecovered{harness}` | sync_service | 源读取失败/恢复 | 通知、MTTR 时序（审计流） |
| `McpToolInvoked{tool, args_fingerprint, latency_ms, ok}` | CLI serve 传输层（`handle_tools_call`） | 外部 MCP `tools/call` 返回后（旁路） | MCP 访问日志、慢查询/失败率 |
| `HourTicked` / `DayRolled` | **保留位（未发射）** | — | 迭代 3 分析裁决：所列消费（清理/去重窗口/stale 检查）都是幂等自愈的维护动作——按 now 全量清比按事件滚动更简单可靠，没有消费者需要顺序信号之前不发射（发射无人消费的事件只填 outbox）。有第一个真实消费者时再接线并撤本标注 |
| `TrustMonitorEvent{run_id, observations, inserted, findings_upserted}` | trust 传感（快照模式已接线；P2 常驻复用同通道） | 传感运行事务内、有新观察时（迭代 4 勘正：载荷为**运行级批次摘要**，单观察明细在 trust_observations；correlate 保持同事务内联——事件是通知不是指令，拆出去会丢失 correlate 对自身写入的原子可见性） | 桌面 UI 刷新（webview 类型分发）；P2 起通知消费者（§7.2 门槛） |

| `WatcherHealthChanged{mode, topology_revision, pending_roots, reason_code}` | 桌面健康巡检线程（2026-09-22，HARDENING spec §5.6） | watcher 模式/修订号/挂载数/pending/原因码变化时（2s 巡检，**绝不按文件事件频率**） | React 设置页（Sources 状态行，`aria-live`） |

> 范围说明：`WatcherHealthChanged` 与 `SyncStatusChanged`/`FoldCompleted`/`SourceDataDeleted`/
> `TrustMonitorInvalidated` 同属**直发 UI 的 app-event 类型**（桌面进程内经单一
> `app-event` 通道，不落 outbox）——本表登记其词表以维持「先登记后写 emitter」的
> 完整性；outbox 侧的闭集校验（`EVENT_TYPES`）不涉及其一。

新增事件类型必须先在本表登记（与分类图谱"先登记后写 emitter"同纪律）。

## 6. 消费者纪律

1. 消费者**只读权威库 + 各自既有写入面**，不直接回写 `event_outbox`；
2. 幂等：处理前查 `event_deliveries`，处理后登记——重复到达为 no-op；
3. 消费者崩溃不影响投递（tailer 下轮补投），投递失败不阻塞生产者；
4. 派生重算类消费者产出仍走各自的事务写入（如 issue upsert 的既有幂等键），事件层不新增第二种写路径；
5. 通知类消费者实现去重窗口（trust 规格 §7.2：24h 内同 Finding 去重，除非阶段/严重度/证据等级升级）；
6. **展示层消费者刷新必须经 revision 单调门**（2026-09-22 增补，CPU 风暴教训）：Presentation 角色不得逐事件触发重取——`CoalescingConsumer` 整轮合并 + webview 侧 `Invalidated` revision 门面是强制形状；新增页面接入必须走 `makeInvalidationGate()` 同款门，禁止回到「任意事件→立即全量刷新」的直推路径（`RUNTIME_INVALIDATION_AND_READ_BACKPRESSURE_SPEC.md` §6）。

## 7. 明确不上总线的面（负面清单）

| 面 | 理由 |
|---|---|
| tick 流水线（discover → fold → claude-sync → facts） | 有顺序与失败语义的 pipeline，编排保持显式（2026-09-05 卡顿事故的排查依赖显式阶段）；事件只挂反应，不挂步骤 |
| MCP `tools/call` | 请求-响应，客户端在等；事件只是完成后的审计旁路 |
| billing 事实写入 / golden 逐字节面 | 事务一致性 + Python/Rust parity 红线，事件化引入双写 |
| `doctor::diagnose` / `report` | 纯函数 + 差分门的价值在确定性 |
| CLI 查询子进程 | stdout + 退出码契约（CI 语义） |

## 8. trust 传感器接入（P2 对接点）

```
FSEvents watcher（执行环境根目录写事件，无归属）─┐
fd 表采样（libproc，同 uid，类别化后即丢）───┼─► 聚合窗口(10–60s，削峰) ─► TrustMonitorEvent ─► 总线
连接/字节轮询 ──────────────────────────────┘
```

- 传感器是 `TrustMonitorEvent` 的**唯一**生产者；correlator 与通知是普通消费者；
- 采样缺口写入事件 payload（`sample_interval_ms`），消费者据此知道"未见 ≠ 未发生"的置信边界；
- **执行环境 agentic-loop hook 不接**：hook 配置在执行环境 settings 内，被审计者可摘除传感器——trust 面的传感器必须住在被审计进程之外。hook 仅可作为 canonical 面（SV601–614）的增强源，带 `collector_id` provenance 与双源指纹去重。该边界同时登记进 `AGENT_EXECUTION_PROBLEM_TAXONOMY.md`。

## 9. 分期

- **P0（基础设施 + 第一个扇出）**：`AppEvent` DTO + authority v23 迁移（`event_outbox`/`event_deliveries` + 删除级联）+ `Dispatcher`（自动提交两段式 drain，闭集词表双侧校验）+ `FactsIngested` 在 `write_flat_facts_with_sources` 事务内发射 + **price-reconcile 消费者**（原 `sync_service.rs` 内联调用删除，尾部 drain 保序：价卡快照先行）。配额扫描、issue 评估器两消费者随 P1 桌面常驻 dispatcher 接入（P0 的 CLI 单进程形态下它们没有独立运行时机）。验收 = 内联调用链删除后行为等价（golden 不变）+ 崩溃恢复/双投递幂等/词表拒绝单测。
- **P1（缓存统一 + 审计旁路）**：`AuthorityRevisionAdvanced` 收编三套缓存失效；`McpToolInvoked` 落访问日志；`app-event` 单一 UI 出口收编 `FOLD_EVENT`/`SYNC_STATUS_EVENT`。
- **P2（时间事件 + trust 接入）**：timer 事件 + expires 清理；trust P2 传感器接入（本规格是其唯一通道）。
- **P3（可选）**：FSEvents 写事件作为 sync 差量的低延迟触发（指纹差量兜底自愈）。

## 10. 验收标准

1. 事件与状态变更同事务：kill -9 于事务后、投递前，重启后 tailer 补投成功；
2. 同一事件投递两次，所有消费者 no-op（幂等键生效）；
3. 快通道满载丢弃只影响 audit/maintenance 级事件，`dropped_count` 可查；
4. P0 完成后 `sync_service.rs:499` 的内联 reconcile 调用消失，price reconcile 由事件驱动，golden 15/16 全绿（行为等价）；
5. webview 侧只存在 `app-event` 一个 listen 入口；
6. `delete_imported_harness_data` 后无悬空 outbox 行；
7. 词表外事件类型在 dispatcher 层被拒绝并计数（闭集校验）；
8. update_hook 回调被禁用（模拟失效）时，轮询兜底在 5 秒内完成同等投递（§4.3 双通道等价性）。

## 11. 风险与守卫

| 风险 | 守卫 |
|---|---|
| 双写分叉（事件与库不一致） | §1.2 outbox 同事务；代码评审检查项：凡 INSERT 事实处必有同事务 outbox 行 |
| 隐式流难调试 | 事件带 correlation_id；`--build-info` 同款诊断面（`event-outbox status` CLI 子命令） |
| 总线蠕变（万物互联） | §7 负面清单 + 词表闭集 + "新事件先登记"纪律 |
| 消费者拖垮投递 | 有界通道 + 消费者独立任务 + 超时丢弃计数 |
| 与 Python twin 的关系 | 事件层是 Rust-only 的进程内管道，无 Python twin 需求（parity 边界按 AGENTS.md 计费/skills 核心划定） |

## 12. 参考实现研究：apalis-sqlite（2026-09-20，源码级）

对 [apalis-sqlite v1.0.0-rc.9](https://github.com/apalis-dev/apalis-sqlite)（+ apalis core）做了源码研究。**结论不变：学习参考、不引依赖**（事务所有权在其 storage、sqlx 与 rusqlite 双驱动栈同库、job 竞争消费 ≠ 事实扇出三项硬错配）——但五项技术直接采纳，一项明确不采纳。

### 12.1 采纳（已并入 §4）

| # | 技术 | 出处 | 采纳方式 |
|---|---|---|---|
| 1 | **hook 叫醒不带货**：update_hook 回调只发唤醒信号（`Stream<()>`），事件获取恒为批量 SQL——单一数据路径，无双读 | `callback.rs`（`update_hook_callback` 过滤 `Insert ∧ jobs 表` → unbounded mpsc → `HookCallbackListener`） | §4.3 快通道；rusqlite 同款 `update_hook` API，**零新依赖** |
| 2 | **原子认领**：`UPDATE … WHERE ROWID IN (排序候选子查询) RETURNING *`，认领=状态迁移+锁定一步完成；排序键 `priority DESC, run_at ASC, id ASC` 保证确定性无饥饿 | `queries/backend/fetch_next.sql` | §4.3 tailer 扫描形状 |
| 3 | **部分索引圈定可认领集**：`… WHERE status='Pending' AND lock_by IS NULL`（另有 Failed 可重试的独立部分索引）——终态行不进索引 | migrations `add_fetch_next_indices` / `add_lock_indices` | §4.2 `event_outbox_pending WHERE delivered = 0` |
| 4 | **幂等由 DB 约束强制**：`UNIQUE (job_type, idempotency_key)`，生产者侧去重在 schema 层而非应用代码 | migration `idempotency_key` | `event_outbox` 主键 + `event_deliveries` 复合主键（既有设计的同型强化） |
| 5 | **回收原因留痕**：孤儿任务重置时 `last_result = 'Re-enqueued due to worker heartbeat timeout'`——恢复动作写进数据，可审计 | `reenqueue_orphaned.sql` | 消费失败/补投的 `event_deliveries` 记 `last_error`，验收 6 的诊断面读它 |

### 12.2 不采纳（及其理由）

| 机制 | 理由 |
|---|---|
| Workers 心跳表 + 双层孤儿回收（优雅退出精确重置 / `now - last_seen >= N` 超时重置） | 面向多 worker 进程的锁语义；本设计是**单进程 dispatcher + 进程内消费者**，崩溃恢复 = `event_deliveries` 缺行重扫（tailer 下一轮），无需锁与心跳。若未来 dispatcher 多实例化，回来看 `reenqueue_orphaned.sql` |
| 其周期 `VACUUM` | outbox 保留期 7 天量级小；清理用普通 DELETE，VACUUM 交给既有维护窗口 |

### 12.3 研究修正的一条认知

此前以为 sqlx 不暴露 update hook——**sqlx 0.9 已原生支持**（`sqlx::sqlite::{SqliteOperation, UpdateHookResult}` + pool `lock_handle.set_update_hook`）。这不改变"不引 sqlx"的结论（权威库全栈 rusqlite），但说明该技术路线在两个主流驱动里都是一等公民，长期可用性无虞。

---

**关联文档**：`AGENT_VITALS_V0_9_1_SQL_AUTHORITY_MIGRATION_SPEC.md`（权威库哲学）、`FINDINGS_TRUST_EGRESS_MONITORING_SPEC.md` §6.2（P2 传感器的窗口与过载纪律）、`AGENT_EXECUTION_PROBLEM_TAXONOMY.md`（canonical/trust 证据等级分界）。
