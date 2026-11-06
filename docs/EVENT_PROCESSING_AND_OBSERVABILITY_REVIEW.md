# 事件处理与可观测性：问题分析与调研说明

> 状态：**调研与整改建议（2026-09-22）**——由当日真机验收发现的 CPU 风暴事故触发
> （持续 ~3 核自旋，`feat/watcher-hardening` 分支 `e4a27fa` 修复后复验干净）。
> 本文回答三个问题：**其他产品如何处理事件风暴？我们的架构有缺陷吗？
> 我们有日志系统吗？** 并给出分期整改建议。
>
> 关联：`RUNTIME_REFACTOR_WATCHER_HOTPLUG_HARDENING_SPEC.md` §11.8（本次事故的
> as-built 记录）、`AGENT_VITALS_EVENT_BUS_ARCHITECTURE_SPEC.md`（事件总线契约）、
> `AGENT_VITALS_SOURCE_GRAPH_INFRASTRUCTURE_SPEC.md`（watcher 架构）、
> `RUNTIME_INVALIDATION_AND_READ_BACKPRESSURE_SPEC.md`（本文 §5 P2/P3 对应的
> G1/G2 治理已在那份 spec 落地）。
>
> **2026-09-22 增补**：§5 P1（日志系统）已落地——不是原文建议的 `tracing`，
> 是一个手写的最小文件日志（`core/logging.rs`），细节见 §5 P1 段落更新；
> §0/§2.2 下面的「日志系统事实上不存在」「42 个 stderr 打点」是当时的快照，
> 不再是现状，保留原文供事故复盘的时间线完整，不回填改写。

---

## 0. 一句话结论

**架构有一个真实缺陷（事件→UI 是「直推全量刷新」而非「失效化+调度拉取」，
风暴时无背压），日志系统事实上不存在**（无日志框架、42 个 stderr 打点在
GUI 语境下全部落入 launchd 空洞、诊断包只含配置状态不含任何运行时数据）。
前者是本次事故的放大器，后者是把定位时间从几分钟拉长到几小时的根因。

---

## 1. 事故复盘摘要（证据链）

2026-09-22 真机验收发现托盘主进程持续 ~284% CPU（六线程各自 ~75%）。
定位过程与证据：

| 步骤 | 手段 | 发现 |
|---|---|---|
| 1 | `ps`/`top` 差分 | 烧的是主进程自身线程，非子进程 |
| 2 | `sample` + `ps -M` | 六个 `tokio-rt-worker` 在跑**我们的 async IPC 命令** |
| 3 | 符号化（临时关 `strip` 重建诊断版） | 热栈 = `InvokeResolver::respond_async_serialized_inner` → `calendar_month` / `day_freshness` / `claude_provider_amounts` / `billing_declarations` → `sqlite3VdbeExec`，混有 `env_read_lock` + stderr 写 |
| 4 | 行为二分 | 空闲（含 watcher 全开）= 0.0%；开窗+受控写入流 = ~8%；**风暴只在验收会话开窗交互时出现** |
| 5 | 修复后复验 | 30s 冷却版：空闲 0.0%、压测 ~8% |

**因果链**：活动 agent 会话持续追加被监听目录 → 每个去抖窗（1.2s）合法唤醒
sync tick → 每 tick 发射多个 app-event（SyncStatusChanged + 每执行环境
FactsIngested + FoldCompleted）→ **每个挂载页面的监听器收到任何事件都
立即全量刷新**（Settings 一轮 = 7 个重 SQL invoke；多页并存则相乘）→
重 SQL 在 tokio worker 上排队执行 → 多核钉死。

已落的修复（`e4a27fa`，HARDENING spec §11.8）：watcher 唤醒→tick 执行率
加 30s 冷却下限（睡满不丢弃，尾批仍被服务）。这砍掉了**输入端**速率；
但「事件→页面」的放大回路本身仍在（见 §4 G1/G2）。

---

## 2. 现状盘点

### 2.1 事件处理链路（as-built）

```
FS 事件（FSEvents）
  └─ watcher worker：去抖 1.2s 合并 ──▶ TickWaker（单槽，Phase A）
        └─ sync_tick（冷却 ≥30s，e4a27fa）
              ├─ 子进程：discover / oneline / sync-facts
              ├─ 进程内：overview/tray 的 SQLite 聚合
              └─ app-event 发射：SyncStatusChanged（每 tick）、
                 FactsIngested（每执行环境每批）、FoldCompleted、
                 TrustMonitorEvent/Invalidated、WatcherHealthChanged(仅变化时)
                      └─ webview 每页监听器
                            └─ 【缺陷在此】收到事件 → 立即 invoke 重 SQL 全量刷新
```

### 2.2 可观测性现状（事实）

| 项 | 现状 | 证据 |
|---|---|---|
| 日志框架 | **无**（无 tracing/log/os_log/任何 crate） | 全仓 grep 零命中 |
| 生产日志通道 | `eprintln!`/`println!` 共 ~42 处 | GUI 经 `open`/launchd 启动，stderr 落入系统空洞——**生产环境一条也看不到** |
| 文件日志 | **无** | `~/.agent-vitals/` 无 logs 目录 |
| 运行时计数 | 部分：watcher health（coalesced/last_event/last_wake）、outbox 的 `last_error`/`retry_count`（DB 落盘，这点是对的） | 仅经 IPC/SQL 可查，无时间序列 |
| 诊断包（`export_diagnostic_package`） | 版本/配置/源状态快照 | **不含**运行时日志、事件计数、watcher 健康、CPU/资源信息 |
| 结构化 trace（span） | 无 | 本次事故靠 `sample` + 手工去 strip 符号化，耗时 ~2 小时 |

**结论：出问题时，我们在生产机器上几乎是盲的。** 这次能定位，靠的是
macOS 系统工具（`sample`/`ps -M`）+ 临时重建带符号二进制——不可复制到
用户场景。

---

## 3. 业界调研

### 3.1 文件事件风暴的防护（与我们同层的产品）

| 产品/系统 | 做法 | 对我们的启示 |
|---|---|---|
| **Vite dev server**（chokidar） | watcher 可插拔（NoopWatcher）；事件只标脏 ModuleGraph，转换按需（pull）；full-reload 永远在场兜底 | 我们 P2 已抄「失效化」，但 UI 面抄漏了：事件应当**只失效**，不应当触发立即重取 |
| **VS Code 文件监听** | 严格去抖 + 事件在处理期间到达则合并；递归监听有目录数上限与降级 | 「处理期间的到达合并」正是我们缺的：刷新在途时新事件应并入而非叠发 |
| **watchexec / 编译守护** | grace-period 去抖（安静 N 毫秒才动）+ 单飞（上一轮没跑完不启动下一轮） | 单飞我们已有（SyncLock）；grace 去抖我们有（1.2s 窗）；缺的是下游 |
| **Telegraf / node_exporter 等监控代理** | **按固定间隔采样，不做事件驱动**——明知道事件会带来不可控成本 | 我们的周期 tick（5min）就是这类基线；watcher 是加速器。方向正确，但加速器必须带速率预算（我们补了 30s 冷却） |
| **Dropbox 同步引擎** | journal+checkpoint、批量提交、变更合并 | 与 SourceGraph 检查点同型；无新启示 |
| **macOS Spotlight** | 事件驱动索引但系统级预算限流，worker 低优先级 | 「预算限流」思想 = 我们的冷却；「低优先级」我们没有（QoS 可作后续优化） |

### 3.2 UI 数据刷新模式（放大回路的行业解法）

React Query / SWR / RTK Query 已把这套变成事实标准，核心三条：

1. **失效化而非直推（invalidate, don't fetch）**：事件只把对应投影标记为
   stale，**不**立即发请求；
2. **在途去重（in-flight dedup）**：同一 key 的请求在途时，后续触发**合并
   进同一个 promise**，不叠加新请求；
3. **每 key 最小刷新间隔（TTL/min-refetch interval）**：无论事件多密，
   同一投影的取数频率有下限（典型 5-15s）。

对照我们：三条全缺。React 面收到 app-event 直接调 fetch 函数，Settings
一个 else 分支连刷 7 个命令，多页并存相乘——事件率 × 页面数 × 每页命令数
= 无界放大。

### 3.3 桌面应用的可观测性

| 层 | 业界标准 | 我们 |
|---|---|---|
| 结构化日志 | Rust: `tracing` + `tracing-subscriber`（分级、span、字段）；Apple 生态: `os_log`/Unified Logging（`log show` 可查、支持隐私标注） | 无 |
| 日志落盘 | 滚动文件（size/time），固定保留期 | 无 |
| 运行时指标 | 进程内计数器 + 周期快照；桌面常做本地环形缓冲（如 Chromium net-log：环形 + 导出按钮） | 仅 3 组孤立计数 |
| 诊断包 | 崩溃报告 + 近期日志尾 + 指标快照（本地生成、用户主动分享） | 只有配置快照，无运行时数据 |
| 自看护 | 守护进程普遍有资源自监控（CPU/内存超阈值降级或告警） | 无 |

隐私约束下的行业标准做法（与我们 2026-09-19 数据政策完全兼容）：
**本地日志可以含路径与细节（不出机器）；任何导出面（诊断包/复制）做
脱敏投影。** Apple 的 `%{public}`/`%{private}` 标注就是这个纪律。

---

## 4. 架构缺陷判定

| # | 缺陷 | 严重度 | 证据 | 业界对应 |
|---|---|---|---|---|
| **G1** | **事件→UI 是直推全量刷新，无失效化/在途去重/每投影最小间隔**——放大倍数 = 事件率 × 挂载页数 × 每页命令数，无上界 | **高**（本次事故的放大器；冷却只是砍了输入端） | 热栈全是刷新命令的 SQL；SettingsPage else 分支连刷 7 命令 | §3.2 三件套全缺 |
| **G2** | **发射侧无变化去重**：SyncStatusChanged 每 tick 必发（内容可能完全没变）；FactsIngested 每执行环境每批发（无变化时也发） | 中 | lib.rs sync_tick 尾部无条件 emit；对照 WatcherHealthChanged 已实现「仅变化时发」——正确模式已存在，未推广 | UI 框架的状态推送普遍带 equality 去重 |
| **G3** | 全链路无统一速率预算：输入端（wake→tick）现在有了 30s 冷却，但 tick→events→pages 无预算 | 中 | G1+G2 的合成表述 | 令牌桶/预算是守护进程标配 |
| **G4** | **无日志系统**：无框架、无落盘、生产 stderr 不可见 | **高**（把 G1-G3 的发现成本从分钟级抬到小时级） | §2.2 全表 | §3.3 |
| **G5** | 无自看护：进程烧 6 核自己不知道，UI 也看不到 | 中 | 事故持续到人工发现 | 守护进程资源自监控 |
| G6 | 采样考古成本高（发布版 strip、无 span） | 低（诊断手段，非缺陷） | 本次需重建符号版定位 | symbol server / debug builds |

**判定「不是缺陷」的部分（避免过度整改）**：outbox 的
last_error/retry_count 落库、watcher 单槽合并 + 冷却、SyncLock 单飞、
WatcherHealthChanged 的变化才发——这些模式正确，问题是**没有推广成
全链路的统一纪律**。

---

## 5. 整改建议（分期，含验收判据）

### P1：日志系统（先做——它是发现其余一切问题的前提）

**已落地（2026-09-22，`crates/agent-vitals-runtime/src/core/logging.rs`），但不是
`tracing`。** 这批调用点是 tick 级频率，不是热路径，评审原文自己的取舍
（「不为日志引入 tokio/async，std 线程 + 环形缓冲足够」）推到底就是：连线程
都不需要，一把 `Mutex` 同步写足够——与仓库其余「手写而不是拉包」的纪律
（civil 日期数学、FNV 哈希）同款，没有引入 `tracing`/`tracing-subscriber`。

- **落盘**：`~/.agent-vitals/logs/app.log`，滚动 5×2MB（`rotation_plan` 纯函数
  钉住改名序列，`format_line` 钉住换行转义与超长截断）——本地文件允许路径与
  细节（不出机器）；**导出面脱敏仍未做**（诊断包 v2 见下）；
- **双出口**：`log_warn`/`log_error` 同时 `eprintln!`（CLI 终端用户不因这次
  改动失去现在能看到的东西）+ 落文件；`log_info` 只落文件，不给 CLI 终端添
  之前没有的噪音；
- **接入点**（本轮全部转换，`grep eprintln!` 在这些文件里归零）：
  `ingest/watch.rs` 4 处（watcher 后端初始化/线程启动/事件错误/watch 单根
  失败——本次 CPU 事故唯一的过程证据来源，此前完全不落盘）；
  `ingest/sync_service.rs` 11 处（retention/candidate/pricing/event
  dispatch/billing declarations 的 warn 与 info）；
  `apps/cli/src/agent/oneline.rs` 1 处；`apps/cli/src/mcp.rs`（Data MCP
  server，2026-09-22 补）5 处（stdin 读错误/tool 错误/审计三处），生命周期
  横幅两处保留原样直出 stderr、同时补一条 `log_info`（外部 MCP harness 靠这两行
  文本判活；这是本文当初没写进 P1 清单的一处，MCP server 的 stderr 能否被
  harness 留存不可控，本地这份文件是唯一能保证留下来的副本）；
  桌面 `lib.rs` 10 处原生 `eprintln!`（event-bus/watch 拓扑/timezone/issue
  时间戳迁移）+ **`run_discover`/`run_navigation` 两处此前用 `.output().ok()?`
  /只读 stdout、子进程 stderr 从未读过一次的盲区**（现在 spawn 失败/非零
  退出/JSON 解析失败/超时四条路径都落一条 warn，带 stderr 尾）+
  **`run_claude_sync`/`run_facts_sync`/oneline 三处「子进程整体成功但 stderr
  非空」的盲区**（`log_stderr_tail_on_success` 兜底：子进程内部的 warn 已经
  经同一个 logging 模块落过库，这里只补它没兜住的部分，不重复）+ watcher
  健康巡检的状态跳变（顺着已有的 `ChangePublisher.publish_if_changed` 判定
  记一条，2s 轮询本身不落日志）。
- **`RUST_LOG` 等价开关（2026-09-22 补）**：`log_info` 默认只落文件；设
  `RUST_LOG=info`/`debug`/`trace`（大小写不敏感子串匹配，不是真正的
  `EnvFilter`——没有 per-target/per-module 级别）时也打到 stderr。
  `log_warn`/`log_error` 不受这个开关影响，双出口是不因这次改动倒退的既有
  承诺，不是可选项。每次调用现读 env，不缓存（换可测试性——缓存在
  `OnceLock` 里的话第一个用到它的测试会把值锁死）。
- **细粒度链路埋点（2026-09-22 补）**：`sync_tick` 包一层计时壳
  （`sync_tick_inner`，三条内部 return 路径都自动继承，不用在每个分支里
  记得插日志）记 tick 耗时；全部 5 处 `app.emit(APP_EVENT, ..)`
  （Invalidated/SyncStatusChanged/WatcherHealthChanged/TrustMonitorInvalidated/
  SourceDataDeleted）emit 前都有一条 `log_info`，类型与目标字段都在，component
  统一是 `"emit"`（2026-09-22 真机验收补：WatcherHealthChanged 那处此前落在
  独立的 `"watcher_health"` component 下，按 `component=="emit"` 检索/计数时
  会漏掉这一类事件——功能不受影响，纯粹是可观测性上的盲区，跟这份文档整体
  在治的问题同一类）；watcher
  触发的 5 类子进程 spawn（discover/oneline/claude-sync/sync-facts/sessions
  navigation）成功路径统一经 `log_spawn_success` 记「用时 + 是否有兜底输出」
  （此前只有失败路径留痕，成功路径的耗时完全不可见）；watcher 健康日志顺带
  带上 `coalesced_wake_count`（不进「变了才发」的 key——涨得太勤，进 key 等于
  废掉这条纪律——只是搭在真实状态跳变那条日志里免费带出来）。**2026-09-23
  补第二层**：真机验收持续跑了半小时后，`tick finished in` 从基线的几十
  毫秒稳定涨到 7-13s（27 次 tick，均值 13.1s，占墙钟时间 22%），但 4 个子
  进程 spawn 的耗时加起来只占 2-5s——缺口在 `sync_tick_inner` 尾部那串进程内
  直调（`refresh`/`budget_alerts::maybe_notify`/`quota_alerts::maybe_notify`/
  `drain_event_bus`/`publish_invalidation`），当时全都没有单独计时，只能盯
  着总数猜。补了个 `timed(label, f)` 单步计时包装（三条 `refresh` 调用点——
  paused/控制态不可读/正常流程——都补齐，不只是主路径），`refresh` 正是原
  始事故热栈那批函数（`calendar_month`/`day_freshness`/`claude_provider_
  amounts`/`billing_declarations`）,是头号嫌疑，但补埋点当时还没等到下一次
  真机复验证实具体是哪一步——留给下一次真机验收核对。**同日复验+定位+修复**：
  下一轮真机复验先把 `refresh` 内部再拆一层（`read_overview()` 查询 vs
  `set_title`/`build_menu`/`set_menu` 托盘更新），随即发现真正的大头根本不在
  `refresh` 内部——是 `refresh`/`budget_alerts::maybe_notify`/`quota_alerts::
  maybe_notify` 三处各自独立调用同一份 `overview::read_overview()`，一个 tick
  里白算两三遍（`budget_alerts` 单独一项测得 3.4-3.9s）。修复：`sync_tick_
  inner` 只查一次，三个消费者改成收 `&Overview` 参数而不是自己再查（两条
  paused/控制态不可读的提前 return 分支各自单独算，不影响主路径去重）。独立
  general-purpose agent 复核签名等价性、全仓库调用点扫描、`read_overview()`
  纯读无副作用（安全共享）、build/test/clippy 全绿，判定 PASS。真机复验效果：
  `budget_alerts` 3.4-3.9s → 0.94-1.14s，`refresh` 2-4s → 1.6-22ms，稳态 tick
  总耗时从均值 13.1s 降到约 4.4s（约 3 倍）。剩下一个记录但未修的次要发现：
  `budget_alerts` 去掉 `read_overview()` 后还剩约 1s，是它自己的
  `budget_profiles_status_sql_at` 查询，不在这次修复范围内。
- **诊断包 v2（2026-09-22 补，`export_diagnostic_package` → `agent-vitals-
  diagnostic/v2`）**：新增 `observability` 段——日志尾（`read_redacted_tail`，
  最多 200 行，经 `redact_path_like` 脱敏投影，不是原始文件）、watcher 健康
  快照（闭集词表 + 计数，本就无路径无原始错误串）、自看护节流态（当前冷却
  值 + 是否已拉长）、`ReadGate`/`ReadMemo` 命中率快照、事件总线积压（outbox
  总行数/deliveries 总行数/带 `last_error` 的行数——**只数不读内容**，
  `last_error` 的具体文本不进诊断包）。`privacy` 块新增
  `log_tail_is_redacted_projection: true`，明说这段是投影不是原文，
  `contains_absolute_paths: false` 的既有承诺没有降级。
  `event_bus_backlog_snapshot(data_home: &Path)` 特意收窄成参数注入而非读
  `overview::data_home()` 全局——这个文件里其余测试一直读真机数据、互相之间
  没上锁，新函数选择不加入那个赌注，直接可测。
- **脱敏纪律**：`redact_path_like` 不是通用路径检测，是「已知最常见敏感子串
  替换」——精确替换 `home`（本仓库几乎所有路径的前缀）+ 兜底扫
  `/Users/<name>`/`/home/<name>`/`C:\Users\<name>` 前缀（覆盖用户手选的
  自定义 source root 或引用了别的账户路径的消息），与 Python 扫描器
  `--redact-names`（先收集姓名、最长优先替换）同一纪律：宁可保守多删，
  不可能查全。
- **验收**：单测钉住格式化/滚动/写入链路 + `RUST_LOG` 开关 + 脱敏两道（精确
  home 前缀、兜底跨用户前缀）+ 尾行截取（`core::logging::tests` 11 条）；
  `event_bus_backlog_snapshot` 单测钉住库缺席报 `unavailable`（不编造零）、
  三个计数互不相同、`last_error` 原文不进快照；真机 smoke 用仓库内
  `fixtures/dsh/complete.jsonl` 跑 `agent-vitals oneline --shadow` 触发一次
  真实 warn，确认同时出现在 stderr 与 `<data_home>/logs/app.log`（人工验证，
  未固化为脚本）。`export_diagnostic_package` 整体因原生文件对话框
  （`rfd::FileDialog`）无法无头运行——组成它的每个聚合函数已单独测过，
  整体走查靠真机手动导出一次核对（留待真机验收）。

### P2：刷新语义改造（治 G1）

- React 侧引入最小化的 invalidate+schedule 层（不必引 React Query 全家
  桶，但抄它的三件套）：事件 → `invalidate(key)`；每 key 有
  `minRefetchInterval`（建议 10s）与在途去重；页面卸载即停；
- 桌面侧配合：高频事件（FactsIngested/FoldCompleted/SyncStatusChanged）
  的载荷只带「什么变了」，不带全量状态。
- **验收**：1s/次的受控写入 + 全页挂载，稳态 CPU < 15%、每投影 SQL
  频率 ≤ 1/10s；事件风暴单测（合成 1000 事件/秒）不放大到任何 invoke。

### P3：发射侧去重（治 G2，小改动）

- SyncStatusChanged 仅在状态实质变化（ok/stage/message 变更）时发射
  ——照抄 WatcherHealthChanged 发布器的 key-compare 模式；
- FactsIngested 载荷已有增量语义，保留；评估空批不发射。
- **验收**：空转 5 分钟（无变化 tick）不产生任何 app-event。

### P4：自看护（治 G5）

**已落地（2026-09-22，`crates/agent-vitals-runtime/src/ingest/self_monitor.rs`）**，
一处偏离原文：读 CPU 用 POSIX `getrusage(RUSAGE_SELF)`，不是 macOS 专属的
`proc_pidinfo`——两者都能拿到本进程累计 CPU 时间，前者是标准 API、Linux
也覆盖，`libc` crate 已有现成绑定，没有理由多绑一层 mach 层代码换同一个数字。

- `SelfMonitor`（纯状态机，`step(cpu_pct, now: Instant)`）：阈值 50%（真机基线
  空闲 0%/活跃 ~8%/事故峰值 284%，50% 留够余量不误报又远低于事故量级）持续
  30s → 冷却翻倍，同一个 30s 窗口内不重复翻倍，封顶 5 分钟；跌破阈值持续 30s
  → 冷却收回 30s 基线。状态跳变（`Transition::Escalated`/`Recovered`）才记
  日志，2s 轮询本身不落盘（复用 `start_watcher_health_publisher` 已有的骨架，
  没起新线程）。
- 冷却窗口从 `watch::WATCHER_SYNC_COOLDOWN` 常量改为运行期共享值
  （`WatcherCooldownOverride`，desktop `AtomicU64`，health-publisher 写、
  refresh-tick 读）；`watch.rs` 新增 `cooldown_remaining_with(cooldown, ..)`，
  原 `watcher_cooldown_remaining` 收窄成它在固定基线上的薄封装，两者用同一
  测试钉住等价。
- `WatcherHealth` 的 `reason_code` 闭集从 8 个扩到 9 个（`throttled`，
  HARDENING spec §5.5 + React `watcherReasonCodes` 同步更新）——**只在
  watcher 自己没有更具体原因码时才顶上**（`snapshot.reason_code.or_else(||
  throttled…)`），一次真实的 backend 故障不会被「CPU 高」盖过去；`throttled`
  可以与 `mode: "active"` 共存（watcher 后端没坏，只是同步被节流），
  `watcherStatusLabel` 据此在文案里加一句「本机 CPU 较高，同步节流中」，
  不让它消失在「实时监听已启用」这句话里。
- **验收**：`self_monitor` 8 条单测（注入 CPU 序列：低位不动、短暂尖峰不升级、
  持续升级两档、封顶不再升级、二次跌落打断恢复计时器、`cpu_percent` 的两个
  边界）+ 1 条真实 `getrusage` 调用测试（只断言单调不减，不断言具体数值）；
  `cooldown_remaining_with` 与固定基线封装的等价性测试。**真机写入风暴下稳态
  CPU 有硬顶未验证**——需要真机跑一次真实的持续高 CPU 场景，确认冷却确实被
  拉长、恢复后确实收回，单测只能验证状态机本身，不能验证它接进真实进程后
  的端到端行为。

### 明确不做（纪律）

- 不上传任何日志/指标（离线政策红线，2026-09-19）；
- 不为日志引入 tokio/async（std 线程 + 环形缓冲足够，依赖纪律不变）；
- 不做崩溃报告外发；诊断包永远本地生成、用户主动分享。

---

## 6. 与既有 spec 的关系

- HARDENING spec §11.8 已记录本次事故与冷却修复；本文的 P2-P4 落地时
  应在其 §11 追加对应条目（或另立 spec）；
- 事件总线 spec 的「消费者纪律」§6 增补第 6 条：**消费者刷新必须带
  在途去重与最小间隔**（把 P2 的纪律写进总线契约）；
- 诊断包契约 `agent-vitals-diagnostic/v1` → v2（增补项见 P1），走
  reviewed 契约变更流程。

---

**结论重申**：事件总线的**骨干**（outbox、闭集词表、单槽唤醒、冷却、
监督式 watcher）是健康的；缺陷集中在**末端放大**（G1/G2）与**盲飞**
（G4/G5）。P1 立即做，P2/P3 随下个迭代，P4 可缓。
