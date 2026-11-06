# Workbench 刷新风暴与读路径过载系统性修复 Spec

> 状态：**Draft v1.0（2026-09-23）**。
> 触发：2026-09-23 晚间（21:05–21:33 本地）第二次 CPU 过载，agent-vitals 进程 268.9% CPU、
> 27 分钟烧 9.9 分钟 CPU 时间。前次调查与修复见
> `docs/CPU_HIGH_LOAD_CONVERGED_INVESTIGATION_2026-09-23.md`（托盘 300s 节流等已落地）；
> 本次证明该轮修复只管住了托盘一条腿，事件驱动的 UI 刷新与读路径重复计算未被覆盖。
> 前置：`RUNTIME_INVALIDATION_AND_READ_BACKPRESSURE_SPEC.md`（下称「背压 spec」）P0/P1 已绿
> ——revision 标量、词表分类、`CoalescingConsumer`、`ChangePublisher`、`ReadMemo` 五入口、
> `ReadGate` 均已落地；`TRUST_SENSOR_OPTIMIZATION_SPEC.md`（下称「trust spec」）Draft 未实施。
> 关联：`RUNTIME_TICK_LIGHT_PATH_TARGETED_SYNC_SPEC.md`（LIGHT-PATH）、
> `AGENT_VITALS_EVENT_BUS_ARCHITECTURE_SPEC.md`。
> **出货 UI 事实：`tauri.conf.json:7 frontendDist:"ui"`——线上跑的是 legacy workbench
> （`apps/desktop/src-tauri/ui/workbench.js`），React workbench（`ui-dev/react/`）迁移中未出货。**
> 证据：① 出货目录 `src-tauri/ui/` 只有 legacy 四件套，无任何 React 构建产物；② React 构建
> 输出到 `src-tauri/ui-react-dist`（`vite.react.config.js:34`），该目录**不被 frontendDist
> 引用**——即使构建也不会出货，切换还需改 tauri.conf；③ `V1_0_0_LOOP_LOG.md` 的既定裁决：
> Vite 仅作开发壳提供 HMR，生产构建继续读取静态 `ui/`，React 按页面逐步迁移，无切换日期
> （Loop 98/1247/187 三处明示「不为样式迭代引入一次性 React 迁移」）；④ workbench.js 仍在
> 收特性提交（`566a76d` overview token 条）。
> 本文 UI 侧修复以 workbench.js 为主战场，React 侧做同口径对齐（防止迁移完成日风暴回归）；
> R1 的 legacy 改动刻意保持约 20 行量级（触发集收窄 + 锁存），切换日弃之不可惜，durable
> 修复在 R2–R5（后端，UI 无关）与 React 对齐项里。

---

## 0. 一句话结论

**风暴是三层缺陷的乘积，逐层拆掉：** ① UI 触发面——legacy workbench 把两类 trust 瞬态信号
当失效信号全量刷新（背压 spec §6 早已规定不许，只落在未出货的 React 侧），且无按 revision
锁存，一次 revision 前进最多被三个事件各刷一遍；② 读路径——`read_overview` IPC 不在
`ReadGate` 四个接线点里，跑在 tokio worker 上、并发 miss 各自全量重算，assembly 段里
`budget_profiles` 又无缓存地重跑一整份 monthly+daily summary；③ 发射侧——纯簿记事务
（零新事实仍 UPDATE last_seen/checkpoint/snapshot）推进 revision，trust 传感每轮无条件
emit。修复后：同 revision 突发的全量计算 ≤ `HEAVY_READ_PERMITS`，UI 每 revision 至多刷
一次，assembly 段 SQL 量减半，活跃会话场景 revision 前进率与真实增量对齐。

---

## 1. 不可变决策（实施期间不重开）

1. **UI 收敛用 revision 锁存，不引入时间去抖。** 背压 spec §1.5 已裁决：「时间去抖不确定、
   不可测；revision 比较是确定的」。本文全部 UI 侧机制都是 revision/类型比较：订阅者保存
   `seenRevision`，`Invalidated` 携带的 revision ≤ 已渲染值即跳过；trust 瞬态信号按
   背压 spec §6 的既定纪律移出页面级刷新触发集（它们是传感面信号，不是数据失效信号）。
   不新增任何 `setTimeout`/`setInterval` 节流窗。
2. **读路径并发用 `ReadGate` 排队 + 双检查，不引入 per-key single-flight 锁。** 背压 spec
   §5.1 已裁决 ReadMemo「并发 miss 允许重复计算……不引入 per-key 条件变量——简单优先」。
   本文遵守：`read_overview` 接入 `run_heavy_read`（spawn_blocking + 2 permits）后，并发
   突发天然排队；排队者在**拿到 permit 后先复查 memo**（double-checked read），首个完成者
   已写回同 revision 结果，后续者直接命中。不写 Condvar、不写 in-flight map。
3. **revision 语义收窄为「事实性变更」：零新事实的事务不推进 revision。** 背压 spec P0 已
   落地「全重复重放不落 `FactsIngested` outbox 行」（`sql_sync.rs:636-643`）；本文把同一
   判据延伸到 revision：`inserted==0 && rejected==0 && 无 excerpts/workflow 行` 的事务是
   **簿记事务**（仅 `last_seen_at_ms`/checkpoint/snapshot `observed_at_ms` 刷新），走静默
   提交，revision 不动。含任何事实行或 outbox 行的事务照旧走 `commit_advancing_revision`。
   offset/checkpoint **必须照常持久化**（否则重复解析），只是不再因此推进 revision。
4. **IPC 输出契约零变更。** `read_overview`/`data_monthly_summary` 等命令的 JSON 字段、
   字段顺序、降级行为一字不动；本文不触碰 golden 输出（read_overview 不在 golden 契约内，
   亦无 golden 需要刷新）。计费诚实纪律（`metered_estimate`/`has_unresolved`）不受影响。
5. **trust 修复沿用 trust spec 的裁决，不重开。** 分期 A = P0 活动门控 + P3 六段子计时；
   §10 已推翻名字白名单，两级采样走 `lsof -i` 连接预筛且仅在 A.5 实测决策门之后。
   本文只追加两条 trust spec 之外的小修：`interval_seconds` 的 UI 允许域（5..=3600）与
   代码硬顶（`min(interval, 60)`，`lib.rs:1989-1995`）矛盾收敛；`TrustMonitorInvalidated`
   从「每轮心跳」改为「有新观察才发」。
6. **依赖纪律不变。** 全部落在本仓既有 crate（data/runtime/desktop/ui JS），不引入新依赖；
   Python 侧与 golden 不受影响（预期 Python 套件全绿零改动）。
7. **不跑 rustfmt / 不做自动格式化**；Rust 编辑后立即 `git diff --stat` 与全量 diff 自检
   （AGENTS.md 既有纪律）。
8. **trust 默认开启只对全新权威库生效；存量库一律不静默翻转。** `trust_monitor_state` 增加
   `enabled_source` 标记列（`default` = 全新库出厂开 / `legacy_default` = 迁移前存量、待询问 /
   `user` = 用户显式选择过 / `dismissed` = 询问被关掉、永不再问且保持关）。任何显式保存即置
   `user`，后续迁移永不覆写 `user`/`dismissed`。`notifications_enabled` 保持默认 0
   （通知永远 opt-in，不随 sensing 翻默认）。fail-closed 语义不变（库不可用 = 视为关闭）。

---

## 2. 现状与缺陷（代码证据 + 实测）

### 2.1 实测（2026-09-23 13:00–13:33 UTC，app.log）

| 指标 | 值 |
|---|---|
| 进程 CPU（截图峰值） | 268.9%，全表第一；同刻 StorageManagementService 长期抢磁盘（IO 竞争放大 IO-bound 段） |
| assembly 段（P3 计时，13 点后） | n=31，p50=5.09s，max=40.06s（上次收敛调查暖态基线 4.4s，退化） |
| 超预算 WARN（≥5s） | 188 次/2h |
| `Invalidated` 发射 | 88 次/h，revision 320→329 连续前进 |
| `TrustMonitorInvalidated` | 今天 1462 次，节奏 31s（`[31,33,61,31,31,61,31]`） |
| 轻 tick 用时 | 全部 7.1–9.3s（LIGHT-PATH 目标是秒级以内的定向同步） |
| assembly 触发来源拆分 | 105 次中仅 13 次来自 sync tick（托盘/定时），**92 次来自 UI 事件刷新** |

### 2.2 UI 触发面缺陷（legacy workbench.js，出货 UI）

| 缺陷 | 证据 |
|---|---|
| trust 瞬态信号触发页面级全量刷新 | `workbench.js:292-293`：`Invalidated / SyncStatusChanged / TrustMonitorEvent / TrustMonitorInvalidated` 四类全部 `refreshActiveTab()`。背压 spec §6 明文：「`WatcherHealthChanged`/`TrustMonitor*` 交给已按类型过滤的局部订阅者」——该纪律只落在 React 侧，legacy 从未跟进 |
| 无 per-revision 锁存 | `refreshActiveTab`（`workbench.js:273-280`）只有 `wbPull`（`makePullMerger`，:266）在飞合并——它合并**同一时刻**的并发事件，不拦**先后到达**的同频事件。revision 每 ~41s 前进一次，每个新事件都是上一次拉取完成之后到达的，必然再拉一遍 |
| trust 传感活跃时同轮双触发 | trust 有新观察 → 写事务推进 revision → drain 发 `Invalidated`；同一轮 `trust_monitor_record_report` 又无条件发 `TrustMonitorInvalidated`（`lib.rs:2055-2058`）。两者都命中 ：292 的触发集 → 同一轮数据刷两遍 |
| 一次 overview 刷新 = 一整批 IPC | `renderOverview`（:1344）→ `loadOverviewData` 批量表驱动 invoke：`read_overview` + quality + sources + billing groups/candidates/declarations/jobs + monthly/daily/calendar 等十余条 |

### 2.3 读路径缺陷（desktop IPC 层）

| 缺陷 | 证据 |
|---|---|
| `read_overview` 不在 ReadGate 接线点 | 背压 spec §5.3 四个接线点是 `data_monthly_summary`/`data_daily_summary`/`read_calendar_month`/`read_hourly_distribution`（`lib.rs:4061-4063`）；`read_overview`（`lib.rs:2229-2247`）标了 `#[tauri::command(async)]` 但函数体同步，按 `read_gate.rs:3-9` 事故复盘它被内联进 tokio worker 执行——不受 2-permit 约束、N 个并发钉死 N 个 worker |
| 并发 miss 各自全量重算 | `OverviewMemo`（`lib.rs:2227`，单条槽 `Option<(u64, Value)>`）锁内只查/写槽，`overview::read_overview()` 在锁外；日志可见同秒两路 bundle/assembly 交错（13:31:26、13:32:20） |
| revision 键控在活跃会话下必然失效 | 活跃会话每 ~30-40s 真有增量 → revision 前进 → 单条槽必 miss → memo 退化为「每 41s 清空的缓存」 |
| `budget_profiles` 无缓存重跑整份 summary | `budget_profiles_status_sql_at`（`budget.rs:136-155`）内部再跑一次全量 monthly_summary + 一次全量 daily_summary + `AuthorityDb::open`；而 assembly 已经算过 shared_daily 和 memoized monthly（`overview.rs:775-802`）。**即使两个 memo 全命中，assembly 最少也要付 2 份完整 summary 的 SQL**。`monthly_summary_json_memoized`（ReadMemo）现成可用却没用在这条路上 |
| 每次 read_overview 新开 ≥6 条连接 | bundle/budget/subscription 各 `AuthorityDb::open`（写模式全套 DDL churn + repair），revision 探测、shared_daily、monthly memo 各 `open_readonly`；`busy_timeout(5s)`（`authority.rs:1422`）——并发叠 trust 写事务时排队，40s max 与多语句 × busy 等待叠加一致 |
| 托盘/tick 路径绕过 OverviewMemo | `lib.rs:1464、1518、1526、1549` 与 `merge_source_sync_failure`（:3977）直调 `overview::read_overview()`，无 memo 无闸门 |

### 2.4 发射侧缺陷

| 缺陷 | 证据 |
|---|---|
| 纯簿记事务推进 revision | 零脏文件不开写事务（`sync_service.rs:328` 门）没错；但「文件有 mtime 变化、解析后零新事实」时仍开事务：`upsert_source_file` 无条件 UPDATE `last_seen_at_ms`（`fact_writer_sql.rs:159-193`）+ checkpoint 推进（`source_graph.rs:60-78`）+ snapshot upsert（`sql_sync.rs:531-556`）→ `commit_advancing_revision` 判定事务非空照常 +1（`authority.rs:1304-1313`）。outbox 已按 `inserted>0‖rejected>0` 压制（`sql_sync.rs:644-664`），revision 没有 |
| trust 每轮无条件 emit | `trust_monitor_record_report`（`lib.rs:2037-2070`）即使 `inserted=0` 甚至快照 Err 也 emit `TrustMonitorInvalidated`；`trust_monitor_record_result` 每轮 UPDATE state。与 core 层「无变化零发射」纪律（`authority.rs:1300-1303` REVIEW G2）不一致 |
| trust 传感自身全量开销 | 全系统 `lsof -n -P -Fpcfn`（`trust_runtime_monitor.rs:149-161`，5 万行级解析）+ 相关器无 WHERE 全表载入（`trust_correlator.rs:230-247`）——trust spec P0/P2 未实施 |
| `interval_seconds` UI/代码矛盾 | 设置界面允许 5..=3600（`lib.rs:4180`），运行时 `min(interval, 60)` 硬顶（:1989-1995）——用户以为调大了，实际最多 60s |

### 2.5 轻 tick 7-9s 的构成（阶段 R5 处理，排序）

1. tray_due 轮（每 300s）内联的 `read_overview`/assembly：4-6s（§2.3 修完后自然下降）；
2. 被唤醒执行环境为 codex 时 `~/.codex`（8.2GB/2.96 万文件）清单 walk 与 `walk_errors` 二趟
   （`sync_service.rs:551-567`、`harnesses/codex/sources/mod.rs:215-262`）；
3. `scan_claude_quota` 每 tick 对 7 天窗内全部会话文件逐行 JSON 重解析，与脏文件无关
   （`sync_service.rs:295-326`、`quota.rs:30,222-259`）；
4. 每 tick 无条件收尾：`migrate_legacy_subscription_snapshots`（遍历全部 pricing 快照 JSON，
   `sql_sync.rs:85-133`）、`snapshot_current_pricing`、`reconcile_candidate_claims`、
   `billing_apply_active_declarations`（`sync_service.rs:696-758`）；
5. dsh 被唤醒时 oneline zstd 多帧解压（`discovery.rs:27,500`）。

---

## 3. 架构总图（修复点标注）

```
写入面（sync-facts 子进程 / 桌面 IPC / trust 传感）
  └─ AuthorityDb 写事务 ──▶ commit_advancing_revision          [R3·F4 簿记事务静默提交]
        │
        ▼
   schema_meta.authority_revision（唯一推进源）
        │
        ▼
   drain 末尾 publish_invalidation ──▶ app.emit("app-event")
   trust 轮末尾 trust_monitor_record_report ──▶ emit TrustMonitorInvalidated
                                                          [R3·F5 有新观察才发]
        │                                       │
        ▼                                       ▼
   ┌── UI 触发面（workbench.js:292 出货 UI）──────────────────────┐
   │  Invalidated          → refreshActiveTab                    │
   │  SyncStatusChanged    → refreshActiveTab                    │
   │  TrustMonitorEvent    → refreshActiveTab   ←✗ 违背背压§6    │
   │  TrustMonitorInvalidated → refreshActiveTab ←✗ 违背背压§6    │
   │  [R1·F1] trust 两类移出触发集 + per-revision 锁存            │
   └──────────────────────────────────────────────────────────┘
        │  每 revision ≤ 1 次刷新
        ▼
   IPC read_overview（lib.rs:2229）
     ├─ OverviewMemo 单条槽（revision 键）     ← 活跃期必 miss
     ├─ ✗ 不在 ReadGate 接线点，跑在 tokio worker
     └─ 并发 N 路 → N 次全量重算
        [R2·F2] async + run_heavy_read + permit 后复查 memo
        [R2·F3] budget_profiles 改走 memoized summary（砍重复 SQL）
```

---

## 4. 修复设计

### 4.1 R1 · F1 —— UI 触发面收敛（legacy workbench.js 一文件，当天可落）

**契约：** 页面级全量刷新只由两类信号触发——`Invalidated`（revision 严格前进）与
`SyncStatusChanged`（变了才发，背压 spec §6 允许）。trust 瞬态信号不再触发任何页面刷新。

改动（`apps/desktop/src-tauri/ui/workbench.js`）：

1. `subscribeFoldEvent`（:286-296）触发集从四类收窄为 `Invalidated` + `SyncStatusChanged`；
   trust 两类删除（overview 的 trust 行数据来自 quality/monthly 投影，其新鲜度由 revision
   覆盖；trust 传感活跃时写事务推进 revision，`Invalidated` 本来就会来——双覆盖删一不丢）。
2. `refreshActiveTab` 增加 per-revision 锁存：模块级 `let renderedRevision = -1` 与
   `let pendingRevision = -1`。dispatch 层：`Invalidated` 载荷携带 revision
   （`workbench.js:225-226` 注释已声明 `{type, revision, harnesses}`），
   `pendingRevision = Math.max(pendingRevision, revision)`，仅当
   `revision > renderedRevision` 才调 `refreshActiveTab()`（`SyncStatusChanged` 不带
   revision，不参与锁存，保持现状）。**锁存必须下沉进 wbPull 的尾随循环**：
   `while (wbPull.done() && pendingRevision > renderedRevision)`，每次拉取成功后
   `renderedRevision = pendingRevision`（取最新，不取当次参数）。没有这步，在飞拉取
   revision R 期间到达的同 revision 事件会在完成后触发一次多余的尾随重拉（done() 只知
   「有请求到达」，不知「该请求是否已被本次拉取覆盖」）。稳态界：刷新率
   ≤ max(revision 前进率, 1/拉取耗时)——事件只置脏、不排队，风暴下无积压。
3. `wbPull` 在飞合并保持不动（它是对的）；锁存语义与它正交（锁存拦「同 revision 重复」，
   wbPull 拦「在飞重复」）。

React 侧对齐（防迁移回归，小改）：

4. `App.tsx:137` 的 5s 轮询把 revision 前进合成为 `SourceDataDeleted` 窗口事件，而
   `makeInvalidationGate` 对 `SourceDataDeleted` 无条件放行（`tauri.ts:22`）——同一 revision
   前进最多两轮全量刷新。改法：合成事件改带 `detail.revision` 的 CustomEvent，
   `listenAppEvents` 转换时透传，gate 对 `SourceDataDeleted` 也按 revision 比较
   （仍满足背压 spec §6「只对 Invalidated 与 SourceDataDeleted 刷新」的字面，只是补上
   「同 revision 只刷一次」）。
5. `SettingsPage` 主 effect 的 7 连发 refresh（`SettingsPage.tsx:969-989`，含 2 次
   `read_overview`）合并为一次微任务批调度（单次事件 → 每个 refresh 函数至多执行一次）。

**测试：** legacy UI 无自动化基建，验收走手测清单（§7）+ devtools 注入事件断言
（`window.__wbTestHooks` 若无则顺手暴露 `renderedRevision` 只读钩子）。

### 4.2 R2 · F2 —— `read_overview` 接入 ReadGate + 双检查（读路径硬保护）

**契约：** 同 revision 突发 N 个并发 `read_overview` → 实际全量计算 ≤ `HEAVY_READ_PERMITS`(2)
次（通常 1），其余在 permit 队列上等待后命中 memo；任何调用不跑在 tokio worker 上。

改动（`apps/desktop/src-tauri/src/lib.rs`）：

1. `read_overview` 改 `async fn`，照 `data_monthly_summary` 的样子（:4076-4092）：
   入口读 revision（readonly 单语句）→ 查 OverviewMemo → miss 则
   `run_heavy_read(move || ...)` 内**先复查 memo**（排队期间首个完成者可能已写回）→
   仍 miss 才 `overview::read_overview()` → 写回（写回时 revision 已前进则不写，沿用
   `read_memo.rs:159-164` 的防陈旧语义）。
2. 托盘/tick 直调点（`lib.rs:1464、1518、1526、1549`）与 `merge_source_sync_failure`
   （:3977）收口到同一个带 memo 的辅助函数（如 `overview_snapshot_memoized()`），消灭
   「绕过 memo 的第二入口」。tick 路径在锁内调用需保持非 async——辅助函数提供同步版本，
   内部同样走 ReadGate 的 `try_run_heavy_read_sync` 语义（若 runtime 无此变体，允许 tick
   路径直调计算但**必须**读写 OverviewMemo，保证并发去重收益）。
3. `MemoStats` 式可观测性：INFO 日志记录 `memo_hit / gate_queued / computed` 计数
   （每 5 分钟聚合一行），P3 五段计时与 ≥5s WARN 保留不动（回归哨兵）。

**测试（Rust，desktop crate）：** 并发同 revision N=8 调用 → 计算计数 ≤2 且结果一致；
revision 前进后 miss 且不写回旧值；tokio worker 占用断言（计算发生在 blocking 线程，
用计算线程 id ≠ tokio worker id 断言，参照 read_gate 既有测试）。

### 4.3 R2 · F3 —— assembly 段去重：`budget_profiles` 复用 memoized summary

**契约：** 输出逐字节不变（同输入同输出，budget 判定输入相同），只是计算来源换成
ReadMemo 缓存；assembly 段 SQL 量从「≥2 份完整 summary + 1 份 daily」降到
「1 份 memoized monthly + 1 份 daily」。

改动：

1. `budget_profiles_status_sql_at`（`budget.rs:136-155`）：内部的全量
   `monthly_summary`/`daily_summary` 改调 `SqlSummaryRepository::{monthly,daily}_summary_json_memoized`
   （`repository.rs:73-87`，ReadMemo 五入口同款，键含 `ReadVersion{revision, config}`——
   价卡覆盖文件内容哈希 + 时区，正是 budget 判定的真实输入）。
2. `overview.rs` assembly 段（:773-818）的 `monthly_memo()` 单条槽 `MonthlySummaryMemo`
   统一并入 ReadMemo（改调 `monthly_summary_arc` 的 memoized 变体），删除独立单条槽——
   三套缓存（OverviewMemo / MonthlySummaryMemo / ReadMemo）收敛为两套，且消除
   MonthlySummaryMemo 键不含价卡指纹的不一致（explorer 取证 ：353-356 vs `read_memo.rs:63-71`）。
3. 注意：F3 不改变 `budget_profiles` 的计费判定语义，不触碰 `not_subscription_covered`
   谓词与任何计费字段（AGENTS.md 计费诚实纪律）。

**测试：** budget_profiles 输出等价测试（同一权威库快照上，新旧路径 JSON 逐字节相等）；
ReadMemo 参数变异测试覆盖 budget 路径（价卡覆盖文件变更 → config 指纹变化 → miss）；
golden 15 条 + Python 套件全绿零改动。

### 4.4 R3 · F4 —— 簿记事务静默提交（revision 语义收窄）

**契约：** revision 只在事实性变更时前进。「簿记事务」的判据复用 outbox 压制的现成谓词
（`sql_sync.rs:636-643`）：`outcome.inserted==0 && outcome.rejected==0 && excerpts 空 &&
workflow 空`。此类事务：offset/checkpoint/`last_seen_at_ms`/snapshot `observed_at_ms`
**照常持久化**（防重复解析、防文件消失误判），但不调 `commit_advancing_revision`，
改用普通提交（`TxnMark` 增加静默变体，或提交 helper 加 `advance: bool` 参数）。

改动：

1. `authority.rs`：`commit_advancing_revision` 旁增 `commit_bookkeeping`（同一 helper
   家族，进 `tests/revision_guard.rs` 的 BEGIN IMMEDIATE 站点闭集登记）。
2. `sql_sync.rs` 写事务收尾按判据选择提交方式；判据与 outbox 压制共用一个函数，杜绝两份
   判据漂移。
3. 守卫测试先行枚举「读簿记列但不经 revision 的读方」闭集：`source_files.last_seen_at_ms`、
   runtime snapshot 表的消费者逐个确认不依赖 revision 缓存新鲜度（当前取证：这些列不进
   overview/monthly/daily/MCP 任何一个 memoized 读面）。闭集外新增读方必须过 revision。

**效果与诚实预期：** 活跃会话**真有增量**时 revision 照常前进（这是合法失效信号，本 spec
不压制它）；收益来自零增量的唤醒（混合执行环境、无关执行环境活动、快照-only 轮）不再制造假失效。
风暴主力削减在 R1/R2，F4 是发射侧卫生。

**测试：** 重复 ingest 同批文件第二轮 revision 不变（且第二轮 offset/checkpoint 已持久化、
第三轮不再 open 写事务——沿用 source_graph checkpoint 判定）；注入一条新事实 → revision
+1 且 `FactsIngested` 照发；`revision_guard` 闭集测试更新后全绿。

### 4.5 R3 · F5 —— `TrustMonitorInvalidated` 改为有变化才发

**契约：** 事件语义从「每轮心跳」变为「本轮有新观察落库」（与 outbox `TrustMonitorEvent`
的 `inserted>0` 判据一致，与 `authority.rs:1300-1303` 零发射纪律对齐）。

改动（`lib.rs:2037-2058`）：`trust_monitor_record_report` 仅当本轮 `inserted>0` 时
emit + INFO 日志；`trust_monitor_record_result` 的每轮无条件 UPDATE state（
`authority.rs:2334-2373`）改为值变化才写（ChangePublisher 同款比较）。通知面
（notification_keys 冷却，:2062-2069）不受影响。

消费者影响清单：legacy workbench 在 R1 后已不消费该事件；React `TrustPage.tsx:134` 用它
重读 monitor 配置——配置变更本就经 `saveMonitor` 本地刷新，事件只服务「他处改配置」场景，
低频可接受；`save_trust_monitor_config` 保存成功后追加一条本地事件即可覆盖该场景。

**测试：** inserted=0 轮不 emit（desktop 层把判定抽成纯函数测）；插入观察轮 emit 一次。

### 4.6 R4 · F6 —— trust 传感分期 A（按 trust spec，不重抄设计）

实施 trust spec 的 P0 活动门控 + P3 六段子计时（§4.1/§4.4）：watcher 唤醒槽（`watch.rs:117`
`wake_harnesses`）暴露执行环境最近活动时刻，trust tick 到点若冷却窗内无活跃执行环境则整轮跳过
（不 lsof、不开库、不 emit）；跳过轮按小时聚合记录。手动快照不走门控。
本 spec 追加两小项：

1. `interval_seconds` 语义收敛：UI 允许域与代码硬顶对齐（选择：把硬顶从 60 放宽到 3600
   并在 P0 门控下安全——门控已保证空闲零开销；UI 文案同步 `workbench.js` trust 设置区与
   `TrustPage.tsx`）。
2. trust tick 与 sync 共用 `SyncLock`（`lib.rs:1979-1988`）：门控跳过轮天然减少锁竞争，
   无需额外改动，验收时观察 `sync_runs` 表 trust 行密度下降即可。

**测试：** trust spec §6 测试矩阵的阶段 A 行 + 门控跳过轮零副作用（无 lsof spawn、无
authority 连接、无 emit）断言。

### 4.7 R5 · F7 —— 轻 tick 减负（三项独立，可按序落地）

1. **F7a quota 扫描指纹跳过**：`scan_claude_quota`（`sync_service.rs:295-326`）改为只扫
   `(mtime, size)` 相对 source_graph checkpoint 已存状态发生变化的文件（checkpoint 表
   已有全部所需字段，`sync_service.rs:121-151` 读侧现成）；全量兜底重扫挂到重 tick
   （每 16 次轻 tick / 300s，`lib.rs:1613-1614`）。注意 sync-facts 是每 tick 新 spawn 的
   CLI 子进程，**进程内存缓存无效**，指纹必须落在权威库（checkpoint 即是）。
2. **F7b codex 单趟 walk**：清单收集与 `walk_errors` 合并为一趟（`sync_service.rs:551-567`
   、`harnesses/codex/sources/mod.rs:215-262`），错误清单在遍历时顺带收集。
3. **F7c 每 tick 收尾节流**：`migrate_legacy_subscription_snapshots`（幂等，`sql_sync.rs:85-133`）
   与 `snapshot_current_pricing` 移到重 tick 专属（或 24h 节流戳存 `schema_meta`）；
   `reconcile_candidate_claims`/`billing_apply_active_declarations` 保持每 tick（它们是
   计费正确性链路，见下「风险」）。

**测试：** F7a 脏文件判定不变式（mtime/size 变化必重扫；未变文件跳过且结果与全量扫一致
——对拍测试）；F7c 幂等性（任意中断后重跑收敛）。三项均不触碰计费判定输入。

### 4.8 R6 · F8 —— trust 默认开启 rollout（门控在 R1+R3+R4 与相关器成本钉住之后）

**产品目标与诚实的成本前提。** 默认开启让 trust/findings 价值环开箱即用；它今天不可行的
唯一原因是空闲轮全成本（§2.4）。R4（活动门控）落地后空闲轮零 lsof、零开库、零 emit，
R3-F5 后无心跳事件，R1 后无 UI 放大——默认开启从「每用户每 30s 永久付费」变成
「活跃开发时付费、空闲免费」的形状，才具备出厂默认的资格。

**契约（落实不可变决策 #8）：**

1. 全新权威库：schema 默认 `enabled=1, interval_seconds=30, notifications_enabled=0,
   enabled_source='default'`。
2. 存量权威库：迁移只加列（`enabled_source='legacy_default'`，enabled 保持 0），**不 UPDATE
   enabled**。桌面启动检测到 `legacy_default` 时，在 Trust/Findings 页出一次性条幅：
   「信任传感可默认开启——本机进程活动观察、仅本地存储 7 天、零网络外发」，动作三选：
   开启 / 保持关闭 / 稍后（`dismissed`，永不再问，可在设置随时打开）。绝不后台静默置 1。
3. 任何经 `save_trust_monitor_config` 的保存（含从条幅进入的）一律置 `enabled_source='user'`；
   `user`/`dismissed` 状态后续所有迁移不可覆写。
4. 通知保持 opt-in；`interval_seconds` 语义按 R4-F6 的 cap 收敛执行（默认 30s，门控下可调大）。
5. fail-closed 不变（`lib.rs:2003-2015`，库不可用即视为关闭）。

**前置门（三条全满足才进 R6c 翻默认）：**

- R1、R3-F5、R4 打勾（含 interval cap 收敛）；
- 相关器成本钉住：trust spec P2 开窗落地，**或**按 trust spec A.5 同款决策门哲学实测——
  7 天稳态表规模下 `correlate_selected` ≤ 50ms/轮（表 7 天保留有界，但默认开启后逐日爬升，
  必须实测钉住而不是假设）；
- §7.5 soak 量化门通过。

**改动清单：**

1. schema：`SCHEMA_VERSION` +1，`ensure_schema_vN`：`ALTER TABLE trust_monitor_state
   ADD COLUMN enabled_source TEXT NOT NULL DEFAULT 'legacy_default'`；全新库的
   `INSERT OR IGNORE` 初值行改 `enabled=1` + `enabled_source='default'`
   （`authority.rs:1136-1150` 处）。若 Python 侧镜像该表则锁步更新（预期不需要：
   `trust_monitor_state` 是 runtime/desktop 侧表，不在 golden 契约内）。
2. 写路径：`trust_monitor_state_set`（`authority.rs:2334`）与 `save_trust_monitor_config`
   （`lib.rs:4173-4202`）置 `enabled_source='user'`；条幅的「稍后」走独立的 dismiss 写入。
3. 询问面：legacy workbench trust 设置区（`workbench.js:8248-8300` 一带）+ React
   `TrustPage.tsx` 各加一次性条幅；文案含三要素（观察范围/本地 7 天/零外发）。
4. 可选卫生：disabled 态 2s 轮询每 2s 开一条只读连接（`lib.rs:1968,2001-2003`）改为
   保存时事件驱动刷新 + 进程内缓存；默认开启后走这条路径的用户变少，属顺手清理，不阻塞 R6。

**测试：** 迁移三态（全新库 `enabled=1`+`default`；存量库 `enabled=0`+`legacy_default`
保持；显式保存 → `user` 且再跑迁移不覆写）；dismiss 后不再询问；通知默认 0 不变；
fail-closed 不变；golden/Python 零漂移。

---

## 5. 明确不做

- **不引入前端时间去抖/节流定时器**（背压 spec §1.5）；FindingsPage 既有的 150ms 合并窗
  保留但不推广。
- **不引入 per-key single-flight / Condvar / in-flight map**（背压 spec §5.1）。
- **不做前端 per-harness 定向刷新**（`Invalidated.harnesses` 已携带，React 已解析，但第一期只用
  revision 整体锁存；定向刷新等 React 迁移完成后再议）。
- **不改变任何 IPC 命令的输出契约、字段顺序、降级行为**；不刷新任何 golden。
- **不合并「每次调用新开连接」的模式**（`AuthorityDb` 非 Sync、每线程自开是既有架构裁决，
  连接池超出本 spec 范围；R2 的收益不依赖它）。
- **不动 MCP 脱敏面、data-export 双路、canary 纪律**（数据保留与 serving-face 政策照旧）。
- **不重写 React 状态管理 / 不引入 React Query**（背压 spec §6 既有裁决）。
- **不压制活跃会话的真实 revision 前进**——那是对用户有意义的数据变化信号。
- **不静默翻转存量用户的 trust 开关**（决策 #8；任何「迁移直接 UPDATE enabled=1」的实现
  一律打回——存量行无法区分显式 opt-out 与默认未动，静默翻转必然踩掉前者）。
- **不做增量聚合（delta 累积代替 revision 前进时的全量重算）**。全量 + memo 的瞬间突发
  被 ReadGate 串行化、memo 共享与 R1 触发收敛夹住上限（占空比 ≤6%），是当前正确的
  复杂度。**重开条件（tripwire）**：R3 落地后 P3 实测 assembly 暖态 p95 > 4s，或月窗
  SQL 单段 > 5s，才立项增量月汇总；届时全量路径仍保留作对账与重建。

## 6. 分期与进度（每阶段测试绿后打勾）

打勾规则：该阶段全部条目落地 + 对应验收测试绿 + `cargo test --release` 工作区全绿 +
`cargo clippy --release --all-targets -- -D warnings` 干净 + `golden_runner --diff` 与
Python 套件零漂移，才打勾。R1 无 Rust 改动，另需真机 bundle 验证
（`cargo tauri build --bundles app` + `open .app`，**绝不裸跑二进制**）。

- [ ] **R1（UI 触发面收敛，止血主力）** — F1
  - [x] workbench.js 触发集收窄 + per-revision 锁存 + 测试钩子（2026-09-23，
    `feat/refresh-storm-fix` 4faec8b + 验收修复 02c3f15；vm 沙箱实测评审发现的
    P1 死锁/P1 越权认领/P2 force 吞掉已修；fold-bridge 契约更新到收窄触发集）
  - [x] React：SourceDataDeleted 带 revision 进 gate（gate 契约测试扩展钉住
    「只比较不推进水位」）；SettingsPage 按类型分发在 HEAD 已就位，SourceDataDeleted
    分支接入 gate
  - [ ] 真机手测清单（§7.4）通过
- [ ] **R2（读路径硬保护）** — F2 + F3
  - [x] read_overview async + run_heavy_read + 双检查 + memo 收口（93256dc；
    并发 ≤2/防陈旧/跨 home 隔离测试钉住；desktop 141 绿 + clippy -D 干净）
  - [x] budget_profiles 复用 memoized 输入（from_parts 拆分 + assembly 共享
    monthly Arc/shared_daily；逐字节等价测试钉住——按等价落法未做 Value 往返，
    ReadMemo 保持 Value 型，typed 部件由 desktop 侧 MonthlySummaryMemo 供给）
  - [x] budget_profiles 输出等价测试；并发 ≤2 计算测试（93256dc + 本提交；
    workspace 43 套件 + desktop 141 + golden 16 + Python 1233 全绿）
- [x] **R3（发射侧纪律）** — F4 + F5（2026-09-23 全部落地，全门禁绿）
  - [x] 簿记静默提交（with_immediate_txn_decided + 三出口事实性裁决；判据与
    outbox 压制同源；快照/backfill/路由证据保守视为事实性——配额滚动窗口
    载荷是用户可见状态；revision_guard 唯一写者测试原样保持全绿）
  - [x] 读方闭集枚举（实施期完成）：harness_runtime_snapshots 载荷喂配额面
    （无 memo 的即时读，不受影响）；source_files.last_seen 喂覆盖度余量——
    经 revision-memo 的 summary 面在「仅无实效扫描」角落可能滞后一个真实
    revision，属外观性、可接受；机械守卫由「唯一写者」测试 + 静默契约测试
    共同覆盖（未另建独立读方闭集测试文件，如实记录）
  - [x] TrustMonitorInvalidated 有变化才发（inserted>0 门控 + save 路径本地
    事件兜 TrustPage；record_result 单行心跳 UPDATE 保留——不推 revision、
    是 last_success 活性信号，偏差已在提交说明注明；desktop 141 绿）
- [x] **R4（trust 传感分期 A）** — F6（acb4a86，2026-09-24）：P0 活动门控
  （HarnessActivityTable 由 watcher 唤醒槽刷新；冷却窗 120s + 空闲确认窗 10min；
  跳过轮零 lsof/零库/零事件/零锁 + 小时聚合日志）+ P3 六段子计时
  （lsof_spawn/parse/open/txn_insert/correlate/outbox_emit 单行 INFO）+
  interval 上限收敛（60s 硬顶移除，5..=3600 全域）；门控三行测试钉住
- [ ] **R5（轻 tick 减负）** — F7a → F7b → F7c（各自独立打勾）
  - [x] F7a quota 指纹缓存（09c8533 + 2074b7b）：贡献粒度拆分 + (size,mtime)
    指纹缓存 + floor 在合并处按当前时间施加（不随缓存冻结）；对拍测试钉住
    冷/暖/变更/floor 滑动四腿（滑动腿经评审修复后真实非空）；缓存写 best-effort
  - [x] F7b codex 单趟 walk（09c8533）：`codex_rollout_files_with_errors` 单趟
    产出清单+错误，主路径与自定义源换用，错误面按唤醒裁剪（codex 未唤醒零
    walk）；等价测试钉住。claude/dsh/workbuddy 的双 walk 遗留（评审 P3-7）
  - [x] F7c 收尾日节流（99e2c86）：legacy 订阅迁移 + 价格快照改为
    `.daily-bookkeeping.json` 日戳节流（retention 同款范式，失败不盖戳）；
    候选/声明一致性保持每 tick（计费正确性链路）
- [ ] **R6（trust 默认开启 rollout）** — F8；**前置：R1–R4 全部打勾 + 相关器成本钉住
  （P2 落地或 ≤50ms/轮实测）+ §7.5 soak 通过**
  - [x] R6a（2a2856a，2026-09-24）：schema v27 enabled_source 四态 + save 置
    user + dismiss 命令 + React TrustPage 三选条幅（三要素文案）；重开库
    迁移不覆写 user/dismissed 的三态测试钉住；**未翻任何默认**（R6c 仍以
    §7.5 soak 为前置）
  - [ ] R6b：§7.5 soak 量化门在发布候选上通过
  - [ ] R6c：全新库 schema 默认翻转 `enabled=1`（存量库仅询问，永不静默）

## 7. 验收标准

### 7.1 量化门（真机，trust 开启 + 单活跃会话 + overview 停留 30 分钟）

| 指标 | 现状 | R1+R2 后门 |
|---|---|---|
| UI 触发的 read_overview 全量计算次数 | 92 次/h | ≤ revision 前进次数，且 ≤2×/突发 |
| assembly 段 p50 / max（暖态） | 5.09s / 40.06s | ≤2.5s / ≤8s |
| 超预算 WARN（≥5s） | 188 次/2h | ≈0（仅系统级磁盘竞争残留） |
| `TrustMonitorInvalidated` 频率 | 每 ~31s 恒定 | 与 trust 观察产生率一致（空闲 ≈0） |
| 进程 CPU 均值（30min 窗） | ~37%（峰值 269%） | trust 关 <15%；trust 开按 trust spec 门 |

### 7.2 事件/revision 卫生门

- 零增量重复 ingest：revision 不变、无 `Invalidated`、无 outbox 行（扩展现有全重复测试）。
- 有事实增量：revision +1、单条 `Invalidated`（每 drain ≤1，既有 CoalescingConsumer 保证）。

### 7.3 回归哨兵（保留不删）

- P3 五段计时与 ≥5s WARN 点名（`overview.rs:650,820-829`）；
- `memo_hit / gate_queued / computed` 聚合 INFO（R2 新增）；
- `revision_guard` 站点闭集测试（新增静默提交站点必须登记）。

### 7.4 R1 真机手测清单

1. trust 开启 + 活跃会话写 transcript，overview 停留 5 分钟：日志中 UI 触发 assembly 次数
   ≤ Invalidated 次数（trust 事件不再各自触发）；`renderedRevision` 单调。
2. trust 传感活跃轮（有新观察）只刷一次（由 revision 前进驱动），非每轮双刷。
3. 手动「立即同步」与事件同刻到达不双拉（`manualSyncPolling` 抑制保持）。
4. 托盘菜单各入口、settings 各分区手动刷新路径不回归（wbPull 之外的显式刷新入口逐个点一遍）。
5. 日历 tab 事件刷新同口径（revision 锁存生效）。
6. 风暴注入（devtools 连发）：一次拉取进行中连发 20 条同 revision `Invalidated` → 总拉取
   恰好 1 次（尾随循环被锁存拦截）；拉取中到达 3 个不同 revision → 总拉取 2 次
   （在飞 1 + 尾随 1，渲染最新 revision），无第三次。
7. bundle 校验安装：`cargo tauri build --bundles app` → `open target/release/bundle/macos/agent-vitals.app`，
   确认菜单栏图标出现（System Settings › Menu Bar 下自有条目，无 adhoc ghost）。

### 7.5 R6 soak 量化门（默认开启的发布候选，24h 真机：活跃会话数小时 + 空闲数小时）

| 门 | 标准 |
|---|---|
| 空闲窗（无活跃执行环境 ≥10min） | lsof spawn = 0；`TrustMonitorInvalidated` = 0；authority 写事务 = 0（P0 跳过轮零副作用，对拍 R4 门控测试） |
| 活跃小时 | trust 六段子计时（R4-P3）合计 ≤1.5s / 30s 轮预算（≤5% 占空比）；进程 CPU 均值 <15% |
| 第 7 天稳态 | `correlate_selected` ≤50ms/轮（开窗或实测）；trust 相关内存无增长趋势 |
| 通知零打扰 | `notifications_enabled=0` 默认下 `trust_monitor_alerts` 零新行 |
| 升级路径 | 存量显式 opt-out 用户升级后 enabled 仍为 0，条幅按「稍后」语义不重复弹出 |

产品无遥测（数据保留政策），这道 soak 是默认开启前**唯一**的回归防线——不允许以
「发出去再看」替代。

### 7.6 真机验收记录（2026-09-24 00:28–00:37 本地，feat/refresh-storm-fix bundle）

环境：worktree bundle `open` 启动（AGENTS.md 纪律，未裸跑）；trust 本机处于
关闭态（enabled=0）——门控/六段路径未在真机触发，由单元测试钉住，留待
R6 前置的 §7.5 soak（trust 开启）验证。观测 ~9 分钟（含本会话自身负载）：

| 指标 | 旧基线（2026-09-23 风暴） | 本次实测 | 判定 |
|---|---|---|---|
| 轻 tick 用时 | 7.1–9.3s | **386–405ms** | ✅ ~20× |
| budget_sql 段 | 574ms–2.2s | **4.4–20ms** | ✅ F3 复用生效 |
| assembly 段 | p50 5.09s / max 40s | 暖态 824ms；冷态首几轮 3.8–5.5s | ✅ 趋势达标（样本少，p50 待长测） |
| Invalidated | 88/h（任意活动期） | **0**（多轮 tick 零推进） | ✅ F4 直接可见 |
| 超 5s WARN | 188 次/2h | 1 次（暖机期） | ✅ |
| 备忘计数 | — | 每 revision computed≈1（并发去重生效） | ✅ R2 可观测 |

§7.1 完整 30 分钟量化门（trust 开启 + overview 停留）与 §7.4 手测清单
（含托盘图标目视确认）留待用户下一次带 trust 的常规使用中完成；本次
bundle 进程稳定运行 9+ 分钟无 ERROR。

### 7.7 trust 开启 soak（2026-09-24 00:25–00:35，F7a/F7b bundle + 评审修复前）

| 门 | 实测 | 判定 |
|---|---|---|
| correlate ≤50ms/轮（R6 前置） | **13–57µs**（千倍余量） | ✅ R6 前置「相关器成本实测钉住」满足 |
| 六段基线（P1 决策门数据） | lsof_spawn 385–760ms 占比 >95%，其余全部 µs–ms 级 | 分期 B（lsof -i 预筛）价值确认 |
| 轻 tick | 365–698ms | ✅ |
| Invalidated | 0（revision 6 分钟仅 488→489 一次） | ✅ F4/F7c 生效 |
| assembly 暖态（trust 开启） | p50 ≈5–7s | ⚠️ 超 §7.1 门（≤2.5s）——**§5 增量月汇总 tripwire（p95>4s）在真机数据上触发**，是下一级杠杆 |
| 启动扇出 | 1.4s 内同 revision 5 次计算 | ✅ 已修（2074b7b 串行锁），运行中 bundle 未含此修复 |

## 8. 风险与守卫

| 风险 | 守卫 |
|---|---|
| F4 改变 revision 推进语义，可能有读方隐式依赖「每 tick revision 必进」 | §4.4-3 读方闭集守卫测试（先枚举后落地）；tray 5 分钟兜底刷新（workbench.js:297 注释）与 300s tick 不依赖 revision，天然覆盖漏发场景 |
| F2 把 read_overview 搬上 blocking 线程池，2 permits 可能让托盘 tick 排队等 IPC | ReadGate 本就为保护 SQLite 而设（`read_gate.rs:3-9` 事故复盘）；排队是期望行为。观测：gate_queued 计数进日志，若托盘路径延迟超预算由 WARN 哨兵暴露再调 |
| F1 移除 trust 触发后 overview 的 trust 行更新变慢 | trust 行数据源（quality/monthly）由 revision 覆盖刷新；trust 传感活跃时每轮推进 revision（有观察时），无观察时数据本无变化。手测清单 1/2 钉住 |
| F3 换缓存来源引入行为漂移（价卡覆盖文件在两次读之间变更） | ReadMemo 键含价卡内容哈希 + 时区（`read_memo.rs:63-71`），变异测试逐参数钉住；budget 输出等价测试逐字节对拍 |
| F7c 把 pricing snapshot 迁移挪出轻 tick 后，首日升级用户的旧快照迁移延迟 | 迁移幂等且在重 tick（≤300s）内必跑；`schema_meta` 节流戳在迁移完成时才写 |
| 出货 UI 是 legacy，React 侧改了但没被验证 | R1 的 React 条目只做同口径对齐（gate/批合并），验收以 legacy 真机为准；React 迁移完成时的回归由 7.4 清单复用 |
| 格式化事故（历史已发生） | 不跑 rustfmt；编辑后立即 `git diff --stat` + 全量 diff 自检 |
| R6 默认开启把传感成本摊到全体用户，且无遥测可发现回归 | 三重前置门（R1–R4 打勾 + 相关器成本钉住 + §7.5 soak）缺一不翻默认；条幅三要素文案 + 一键退出常在；P3 子计时与 WARN 哨兵长期保留 |

## 9. 测试矩阵汇总

| 层 | 新增/变更测试 | 阶段 |
|---|---|---|
| desktop Rust | 并发同 revision 计算 ≤2；写回防陈旧；blocking 线程断言 | R2 |
| runtime/data Rust | budget_profiles 输出等价（JSON 逐字节）；ReadMemo budget 路径参数变异 | R2 |
| data Rust | 零增量 revision 不变 + 持久化不变式；有增量 revision +1 + outbox 照发；revision_guard 闭集更新 | R3 |
| desktop Rust | trust emit 判定纯函数：inserted=0 不发 / >0 发一次 | R3 |
| runtime Rust | trust 门控跳过轮零副作用（对拍 trust spec §6 阶段 A 行） | R4 |
| runtime Rust | quota 指纹跳过对拍全量扫；walk 合并等价；收尾节流幂等 | R5 |
| 全局 | golden 15 条零漂移；Python 套件 1233+ 全绿零改动；clippy -D warnings | 每阶段 |
| 真机 | §7.4 手测清单 + §7.1 量化门 | R1 / 收尾 |
| data Rust | 迁移三态：全新库 `enabled=1`+`default`；存量库保持 `enabled=0`+`legacy_default`；显式保存 → `user` 再迁移不覆写；dismiss 不再询问 | R6a |
| 真机 | §7.5 soak 门：空闲零 lsof/零 emit/零写事务；活跃占空比 ≤5%；day-7 correlate ≤50ms；opt-out 升级保持关 | R6b/c |
