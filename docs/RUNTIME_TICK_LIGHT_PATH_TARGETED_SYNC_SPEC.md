# Tick Light-Path & Harness-Targeted Sync Spec

> 状态：**Draft for implementation**（2026-09-23）
> 负责人：runtime、desktop
> 依赖：`RUNTIME_REFACTOR_WATCHER_HOTPLUG_HARDENING_SPEC.md`（单槽唤醒、
> `WatcherSupervisor`、`WatchRootClass`）、`AGENT_VITALS_SOURCE_GRAPH_
> INFRASTRUCTURE_SPEC.md`（指纹对账是正确性机制）、
> `AGENT_VITALS_EVENT_BUS_ARCHITECTURE_SPEC.md`（app-event 出口）

## 0. Decision summary

昨夜（2026-09-22 16:04–16:28 UTC）的 CPU 风暴复盘定位了负载形状：**唤醒是
全局的，同步管线也是全局的**——任一执行环境的写入都唤醒跨全部执行环境的完整
tick。执行环境越多、写入越频繁，负载按「活跃执行环境数 × 全执行环境管线成本」相乘。
本 spec 把这个乘性关系拆成加性：

1. **唤醒携带执行环境身份**：单槽唤醒从"有事件"升级为"哪些执行环境有事件"（合并语义不变）；
2. **tick 分轻重**：唤醒驱动的轻 tick 只同步被唤醒的执行环境 + drain 事件总线；
   重 tick 保留 5 分钟周期、跑全管线（字节兼容现状），仍是正确性权威；
3. **read_overview 按 revision 备忘**：IPC 侧同 revision 直接复用；
4. **refresh 拆子计时 + 软预算**：给上轮 33.5s 爆炸一个可归因的观测面。

不做：事件直达解析（watcher 线程仍不碰 DB）、tokio、schema 变更、golden
契约变更、per-file UI 事件。

## 1. Baseline（全部来自 `~/.agent-vitals/logs/app.log` 真机实测）

### 1.1 tick 解剖（`66db5c3` 后每步有独立计时）

```text
sync_tick（重，现状唯一形态）
├─ claude-sync / discover        ~40–330ms（walk + stat 全执行环境全文件）
├─ sync-facts                    1–3.4s（每执行环境批：stat 对账 + 脏文件解析 + 计价）
├─ refresh_harnesses                 0.3–0.7s（spawn `sessions navigation` 子进程，20s 硬超时）
├─ read_overview                 0.5–29.8s（重 SQL 聚合；e0b9f07 起每 tick 一次；
│                                冷启动/大量积压时单条即可到 30s 量级，见 §1.2 更新）
├─ refresh                       1.7–22ms（`e0b9f07` 后只剩托盘三数字重建，吃 ov）
├─ budget_alerts / quota_alerts  0.94–1.14s / µs（`e0b9f07` 后的现状值；修复前
│                                单独一项是 3.4–3.9s，两者不是同一批次，不可比大小）
├─ drain_event_bus               5–12ms（outbox → price-reconcile + app-event）
└─ publish_invalidation          ~1ms
```

### 1.2 风暴复盘结论（2026-09-22 16:00–16:28 UTC）

- 单执行环境（claude-code）持续写 transcript → tick 从 5 分钟周期被压到
  **约 1 次/分钟**，每次 7–10s 多线程；
- `refresh` 两次爆炸到 **33.5s**（正常 21ms，~1000 倍）——当时 `refresh`
  内部还直接调 `read_overview()`，`e0b9f07` 拆分之前二者是同一个数字；
  **另一条 32.5s 是修复后某轮 `tick finished in` 的总耗时，不是 `refresh`
  自己**（同一轮里 `refresh` 已经只有 7.3ms，大头在 `read_overview` 单条
  就吃了 29.8s——冷重启后首次聚合追平积压，量级符合预期，不是新的异常）；
- `self_monitor` 按设计介入，**本次实测到的冷却拉长止步 60s**（三次真实
  escalate 全部是 30s→60s，都在下一轮恢复到 30s 基线，没有一次连续到
  120s——冷却翻倍上限 300s 是设计能力，不是这次观测到的数值，两者不要混）；
  零 ERROR，无失控；
- 单槽唤醒当时已在位——排除积压假设，负载是真实工作量；
- **2026-09-23 更新**：`e0b9f07`（三倍 `read_overview` 归一）已合入且已
  真机复测——稳态下 `refresh` 1.6–22ms、`budget_alerts` 0.94–1.14s、
  tick 总耗时均值 13.1s → ~4.4s（约 3 倍），独立 general-purpose agent
  复核 PASS。**但复测是在正常活跃负载下做的，不是在昨晚同等量级的持续
  写入风暴场景下**——Phase D 的验收项 2（"重度会话下 `refresh` 全程
  ms 级、无预算告警"）严格说仍待一次真正的风暴场景复验才算关闭。

### 1.3 规模化论证

设执行环境数 H、活跃（持续写入）执行环境数 A：

- 现状负载 ≈ **A 驱动的唤醒频率 × 全执行环境管线成本(H)**——乘性；
- 每条维度各自也涨：discover/stat 对账 O(总文件数)，投影 O(全部派生状态)。

目标形状：轻 tick ≈ **A × 各自增量同步**；全执行环境对账与投影留在重 tick 的
5 分钟周期里。新增一个被监听执行环境的边际成本 ≈ 它自己的文件 stat。

## 2. Problem statement

**P0（乘性放大）**：任一执行环境的写入唤醒全执行环境管线。执行环境越多，唤醒源越多、
单次 tick 越重，两者相乘。昨晚单执行环境活跃已把进程推到 3.5 核。

**P1（管线固定形态）**：tick 无论唤醒来自谁、增量多小，都跑全部步骤——
包括 `refresh_harnesses` 的**子进程 spawn**（每 tick 一次，0.3–0.7s + 进程
churn）和 `read_overview` 重聚合（每 tick 一次，最大常规单步）。

**P2（refresh 不透明）**：`refresh` 是单个不透明耗时数字。33.5s 爆炸的
内部构成不可归因；`e0b9f07` 是否完整解释爆炸未验证。

**P3（read_overview 重复计算面在 IPC 侧）**：风暴期间 React 按 Invalidated
事件懒刷新，每次 IPC `read_overview` 都重算 2.2s 级聚合——同一 revision
的连续刷新没有备忘。**2026-09-23 复核发现范围比这里写的更宽**：
`overview::read_overview()` 除了 IPC 命令 `read_overview`（`lib.rs:2059-
2062`）之外，还有 `data_source_status()`（`lib.rs:3792`）也独立整份重算
只为取 `.sync` 一个字段——同一份重聚合至少两个 IPC 命令各自触发一次。
`lib.rs:4472`（app 启动建初始托盘）也调用它，但那是一次性的，不算重复
计算面，不需要收编。

## 3. Goals / Non-goals

### Goals

1. 唤醒驱动的同步只覆盖被唤醒的执行环境；未唤醒执行环境的对账留给重 tick。
2. 轻 tick 不 spawn 子进程、不跑全量投影重聚合；端到端（写 → UI 可见）
   时延保持秒级。
3. 同一 authority revision 的 `read_overview` IPC 命中备忘缓存。
4. `refresh` 具备子步骤计时与软预算告警（预算只观测，不改变行为）。
5. 重 tick 行为与现状**字节兼容**（同样的步骤、同样的顺序、同样的输出）。
6. 所有现有降级链不变：watcher 失效/节流时重 tick 兜底，行为等同今天。

### Non-goals

- 事件直达解析 / watcher 线程碰权威库（HARDENING spec 不变量 1 沿用）；
- tokio / 常驻 daemon / 第二个 DB 写者；
- golden 输出、事实 schema、计费语义、Python/Rust 字节镜像的任何变更；
- per-file 粒度的 UI 事件（UI 事件仍按执行环境批次粒度）；
- trust 传感的采样模型（独立循环，不在本 spec 范围）。

## 4. Invariants（发布门，不是建议）

1. **重 tick 是正确性权威**：轻 tick 丢失、重复、乱序只影响时延，不影响
   最终事实。重 tick 的 5 分钟周期不可被轻 tick 饥饿（见 §5.2 排序规则）。
2. **一个权威库写者**：轻 tick 的执行环境同步仍走 `sync_harness` 既有路径
   （lease + 事务），watcher 线程依旧不碰 DB。
3. **codex 批原子性**：定向同步按执行环境过滤批，codex 命中时仍整批喂入
   （`sync_harness` 本就是按执行环境批调用——过滤发生在批级别，不拆批）。
4. **CacheOnly 根永不唤醒事实同步**（HARDENING §5.2 语义沿用）。
5. **轻路径失败回落重路径**：轻 tick 任一步 Err → 立即降级执行重 tick
   （本轮），并记 WARN。不允许「轻路径失败 = 本轮没有对账」。
6. **golden / 字节镜像零变化**：`sync_harness`、`sync_facts`、事实写入路径
   一行不动——本 spec 只动「哪些步骤在哪个 tick 跑」与「IPC 读侧缓存」。
7. **无新依赖**：tokio/chrono 仍禁；唤醒槽继续手写（Mutex + Condvar）。

## 5. Target architecture

### 5.1 唤醒槽：从"有事件"到"哪些执行环境有事件"

替换单槽 `sync_channel(1)`（HARDENING §5.1）为**带身份的合并槽**：

```rust
pub struct WakeSlot {
    inner: Mutex<SlotInner>,   // BTreeSet<HarnessId> pending + bool periodic_due
    signal: Condvar,
}
pub enum WakeOutcome { Queued, Merged, Shutdown }
impl WakeSlot {
    pub fn wake_harnesses(&self, harnesses: impl IntoIterator<Item = HarnessId>) -> WakeOutcome;
    /// tick 循环独占：取走全部待同步执行环境；`timeout` 到期返回周期到期标记。
    pub fn wait(&self, timeout: Duration) -> WakeBatch;   // WakeBatch { harnesses, periodic }
}
```

- `wake_harnesses` **永不阻塞、永不丢语义**：执行环境并入 set（BTreeSet 保证去重
  与稳定序），容量上界 = 注册的 FactsSource 执行环境数（天然有界）；
- `Shutdown`（所有 watcher 发送端消失）不 panic，退化为纯周期；
- `self_monitor` 的冷却语义不变：节流期间 watcher 线程照旧按冷却推迟
  `wake_harnesses` 的调用时机（冷却在 watcher 侧，不在槽侧）；
- 槽是 **feature 无关**的（NoopWatcher 编译下无人 `wake_harnesses`，
  `wait(timeout)` 就是今天的 `sleep(TICK_PERIOD)`）。

### 5.2 tick 分类与步骤路由

| 步骤 | 轻 tick（唤醒驱动） | 重 tick（5 分钟周期） |
|---|---|---|
| discover + stat 对账 | 仅被唤醒执行环境的批 | **全执行环境**（正确性权威） |
| `sync_harness`（解析+计价+写入） | 仅被唤醒执行环境 | 全执行环境 |
| `refresh_harnesses`（navigation 子进程） | 跳过 | 跑 |
| `read_overview` | 跳过（托盘节流到期时才跑，§5.3） | 跑 |
| `refresh`（托盘） | 仅当距上次刷新 ≥300s（节流，§5.3 As-built + 收敛调查 P2 修正） | 跑（吃全量 ov） |
| `budget_alerts` / `quota_alerts` | 跳过 | 跑 |
| `drain_event_bus` | **跑**（事实落库 → 价格对账/UI 失效必须即时） | 跑 |
| `publish_invalidation` | 跑（按被唤醒执行环境的集合） | 跑 |

排序规则（防饥饿）：轻 tick 连续计数达到 `LIGHT_TICKS_PER_HEAVY`（缺省
16）**或** 距上次重 tick ≥ `TICK_PERIOD`，下一个 tick 升级为重——两条
谁先到算谁。参数进 desktop 设置不暴露，常量 + 单测钉住。

轻 tick 失败（任一步 Err）→ 本轮立即升级重 tick（Invariant 5）。

### 5.3 托盘捷径与 read_overview 备忘

**As-built 修订（2026-09-23 实施时）**：托盘三数字依赖 claude 月度天数
（`merged_claude_days`）——砍掉它预算水位就不对了，「窄 SQL」省不出
预期量级，反而多一条同值漂移面。改为**托盘节流 + revision 备忘**：轻
tick 的托盘刷新限频 `TRAY_REFRESH_INTERVAL=300s`（重 tick 无条件刷；初始
取 60s，2026-09-23 收敛调查 §3.3/P2 修正为 300s——60s 与轻 tick 涌现间隔
失配，实测 17/20 节流失效，关系由常量断言测试钉死），配合 §5.3 的 IPC
revision 备忘，同一 revision 只算一次。
窄 SQL 查询留作 Phase D 观测数据证明 read_overview 内部分布后再议。

**revision 备忘的挂点：`overview::read_overview()` 函数本身，不是某一个
IPC 命令**（2026-09-23 调整——原方案挂在 `read_overview` 这一个 Tauri
命令外面，但 §3 P3 已更新为至少两个 IPC 命令+`sync_tick_inner` 共三类
调用方独立触发同一份聚合；缓存挂在函数入口，`read_overview` 命令、
`data_source_status()`、`sync_tick_inner` 的共享 `ov` 全部透明受益，
以后新增调用方也自动覆盖，不用每加一个命令就手动接一次缓存）：按
authority revision 键控单条缓存——revision 未变直接返回上次结果。缓存
进程内存、单条（最新覆盖）、无持久化。轻 tick 不算全量 ov 意味着轻 tick
后 UI 刷新会miss 备忘（revision 变了）→ 按 §5.2 轻 tick 本就不产全量
Invalidated；UI 的执行环境区数据走 FactsIngested 驱动的既有刷新路径。

### 5.4 refresh 子计时与软预算

`refresh` 拆为子步骤计时（托盘重建、menu 更新、状态落盘——以实际代码块
为准），每子步骤沿用 `timed()` 手法进 `log_info`；整段超过
`REFRESH_BUDGET`（缺省 5s）记 `log_warn` 并附**最慢子步骤名**。预算只
观测不改行为——根因处置等观测数据回来再立项（`e0b9f07` 是否完整解释
33.5s 由这次观测回答）。

### 5.5 与既有机制的关系

- **`WatcherSupervisor`**：拓扑替换不感知 tick 分类（唤醒槽收执行环境集合，
  与根的 attach 状态解耦）；
- **`self_monitor`**：冷却仍作用于 watcher 侧 `wake_harnesses` 调用时机；
  轻 tick 本身成本低，不新增节流面；
- **`WatchRootClass::CacheOnly`**（skills 根）：维持现状——只触发缓存
  失效回调，不进唤醒槽；
- **CLI / wasm**：零变化（`sync_facts` 不动，本 spec 的 tick 分类只住
  desktop 的 `sync_tick`）。

## 6. Implementation plan

### Phase A — 唤醒槽带身份

1. `WakeSlot` 替换 `sync_channel(1)`；`WakeOutcome::{Queued,Merged,Shutdown}`；
2. desktop watcher 线程按路由命中的执行环境集合调用 `wake_harnesses`；
3. tick 循环改 `wait(TICK_PERIOD)`；`periodic` 与轻/重升级规则落地。

**Exit**：10k 次并发 `wake_harnesses` 单测——槽内集合有界（≤执行环境数）、合并
语义正确、无 panic；注入式时钟下轻/重升级排序可穷举。

### Phase B — 轻重 tick 路由

1. `sync_tick` 按 §5.2 表路由；`sync_facts` 增加执行环境过滤参数（默认全集，
   CLI 不变）；
2. 轻 tick 失败升级重 tick + WARN；
3. 托盘节流（300s，2026-09-23 P2 修正）——窄 SQL 查询经 As-built 修订改为节流 + revision 备忘（§5.3）。

**Exit**：注入式 step-recorder 测试——轻 tick 的步骤集合恰为表定义务；
重 tick 步骤序列与现状**逐项相等**（字节兼容的机械证明）。

### Phase C — read_overview revision 备忘

1. 缓存挂在 `overview::read_overview()` 函数入口（见 §5.3 2026-09-23
   调整），不是包在 `read_overview` 这一个 IPC 命令外面——`data_source_
   status()` 与 `sync_tick_inner` 的共享 `ov` 计算走同一个函数，自动
   一起受益；
2. 缓存正确性测试（revision 变更必 miss、同 revision 必 hit、进程内无
   持久化）。

**Exit**：风暴重放测试（连续 N 个同 revision Invalidated）只算一次；
额外钉一条——`data_source_status()` 与 `read_overview` 命令在同一
revision 内连续调用只触发一次真实聚合（跨命令命中，不只是同命令内）。

### Phase D — refresh 可观测

1. 子步骤计时 + 软预算 WARN；
2. 真机验收：重度 Claude 会话（本 spec 的作者会话就是天然负载）下
   `refresh` 全程 ms 级、无预算告警 → 关闭上轮 33.5s 的未决项。

## 7. Test matrix

| 领域 | 测试 | 期望 |
|---|---|---|
| 唤醒槽 | 并发 `wake_harnesses` 压力 | 集合有界、合并正确、`Shutdown` 不 panic |
| 升级规则 | 注入时钟穷举轻/重切换 | 轻连发 16 次或 5 分钟到 → 重 |
| 路由 | step-recorder 轻/重 tick | 轻集合 = §5.2 义务；重序列 = 现状逐项 |
| 执行环境过滤 | `sync_facts(harnesses=["claude-code"])` | 只跑该执行环境批；codex 批完整（既有 fixture 差分） |
| 托盘节流 | 轻 tick 步骤集合 step-recorder | 与 §5.2 义务一致；300s 内至多一次 read_overview（常量关系断言已落地） |
| 备忘 | 同 revision 连续 IPC | 一次计算 |
| 回落 | 轻 tick 注入 Err | 本轮升级重 tick + WARN |
| 原生后端 | macOS FSEvents 写测试（`--ignored`） | 秒级唤醒不变 |
| 依赖 | runtime 默认/CLI/wasm 树 | 无 notify、无 tokio（沿用） |
| 回归 | golden 双世界 + Python 套件 | 逐字节不变 |

合并前命令：沿用 HARDENING §7 清单，另加
`cargo test -p agent-vitals-runtime watch::`（唤醒槽新套件）。

## 8. Observability / privacy

- tick 分类（light/heavy）进 tick 完成日志行；轻 tick 记被同步执行环境集合；
- `read_overview` 托盘节流与备忘命中/未命中计数：进程内存 + 日志，不进
  authority DB、不进导出面、不上传；
- 唤醒槽内执行环境集合只在进程内存（执行环境 slug 本就不是敏感面，但同样不进
  IPC DTO——UI 已有的执行环境标签来自既有 surface）。

## 9. Rollout / rollback

1. Phase A 行为兼容（单槽 → 身份槽，无 wake 时逐字节等价）先行；
2. Phase B 默认启用轻路径——回滚开关 = 轻路径直接升级重（一个布尔），
   行为退回现状；
3. Phase C 独立可回滚（关备忘 = 每次重算，现状行为）；
4. Phase D 纯观测。

## 10. Release decision

Phase A+B 是「多执行环境热插拔宣称」的规模化前置：没有它们，执行环境数增长会
按乘性放大 CPU（昨晚已实证）。Phase C/D 独立估值。全部四阶段完成前，
产品措辞维持「固定根、尽力低时延加速器」（HARDENING §10 的既有判定）。

---

**关联**：`P2_WATCHER_PRODUCT_REVIEW.md` §7（watcher 形态决议）、
`docs/EVENT_PROCESSING_AND_OBSERVABILITY_REVIEW.md`（self_monitor 与
日志纪律的出处）。
