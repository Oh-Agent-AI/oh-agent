# 桌面 App 持续高 CPU 事故调查报告

> ⚠️ **已被 `CPU_HIGH_LOAD_CONVERGED_INVESTIGATION_2026-09-23.md` 取代**
> （2026-09-23 02:30）。本文保留作为「同一事故被两条独立路径各查到一半」的记录，
> 不再单独维护。**本文有一条量级结论已被实测修正，见下方订正**。
>
> **订正（§3/§7，量级）**：发现 #1「fsevents 线程 churn」的**定性完全正确**，
> 线程 ID 生灭已被独立复现（跨采样交集为空）。但**量级被高估**：纯空闲 18s 窗口
> （零日志活动）实测仅 **0.06s CPU = 0.3% 一核**，不是「持续本底」级别；引为证据的
> `_pthread_mutex_firstfit_lock_wait × 350` 在两次独立采样中**均为 0，未能复现**。
> 该项应从 **P0 下调**——修它的理由是「零收益的纯浪费」，不是「省 CPU」。
>
> **另一处需细化（§0/§1.2）**：本文称「托盘节流把 read_overview 限到 60s 一次」，
> 描述的是设计意图。实测 n=20：17 次刷新 / 3 次挡住，抑制率**随 tick 节奏在 0–50%
> 之间变化**——在本文观测的那个窗口（间隔 63–82s）它实际抑制率为 **0**。
>
> **本文最有价值且被后续实验完全证实的发现**：trust 传感归因。用户 A/B 实验
> 实测 ~120% → 2.8%。

> 日期：2026-09-23（调查窗口 09:59–10:20 本地）
> 对象：`agent-vitals-menubar`（/Applications/agent-vitals.app，构建自 main@`a8a26d3`，含 tick 轻路径）
> 症状：用户截图显示进程 CPU **613%**；进程自启动 8 分钟墙钟累计 **10 分钟 CPU 时间**（平均 ≈1.2 核）
> 状态：**根因已定位（多因素叠加），修复建议待排期**
> 数据源：`~/.agent-vitals/logs/app.log`（带 `66db5c3` 精细计时）、`sample` 进程采样 ×4、真机 DB 隔离实测、源码走读

---

## 0. TL;DR

高 CPU 不是单一 bug，是**四个独立来源的叠加**，其中两个是近期新代码引入/放大的：

| # | 来源 | 归属 | 量级 | 证据强度 |
|---|---|---|---|---|
| 1 | **fsevents 线程 churn**：不存在的执行环境目录每 1.2s 被重试挂载，每次重试创建又销毁 FSEventStream 线程 | watcher hardening 引入（`retry_pending`） | 持续本底 + 锁自旋 | 高（线程 ID 生灭实录 + 卡在 `FSEventStreamStart` 的栈 + mutex 自旋） |
| 2 | **trust 传感 30s 突发**：lsof 采样 + 观察落库 + 相关器 | 既有面，opt-in，本机开启 | 峰值 170–263% | 高（峰值与事件时间戳逐个对齐） |
| 3 | **read_overview 2–21s**：托盘节流刷新路径的重聚合慢在并发争用，不在 SQL | 既有的重查询路径（轻路径把它限到 60s 一次） | 每次 1 核 × 2–21s，每 60s 一次 | 中（组件全快、组合慢；内因未定位） |
| 4 | **持续写入源本身**：多 agent 会话（本调查会话 + codex worktree 会话）高频追加被监听日志，watcher 每 30s（冷却下限）合法唤醒 | 环境负载 | 每 30s 一次轻 tick（~1–3s） | 高（日志时序） |

截图的 613% 是**多峰瞬时叠加**；稳态实测峰值 170–263%，其余时间 0–30%。

**先说清楚什么没有被打破**：tick 轻路径（LIGHT-PATH spec 四阶段，`a8a26d3`）按设计工作——日志可见轻 tick 只同步被唤醒的执行环境、sync-facts 624ms、防饥饿与冷却全部生效。本次问题在轻路径的**周边**，不在其上。

---

## 1. 背景与时间线

### 1.1 触发

用户在活动监视器截图（多进程高负载），报告 `agent-vitals-menubar` CPU 613.7%。该构建含最近三次性能迭代：

- `66db5c3` sync_tick 步骤精细计时
- `e0b9f07` read_overview 每 tick 只算一次
- `a8a26d3`（= 0510770 + 04ceca1）tick 轻路径（执行环境键唤醒槽 + 定向同步 + revision 备忘 + refresh 预算）

### 1.2 关键时间线（app.log，UTC+8=本地）

```
09:59  新实例启动（/Applications，a8a26d3 构建）
09:59:51  冷启动重 tick 34.9s（全量回填，一次性，预期内）
10:00–10:07  轻 tick 每 ~30–60s 触发（watcher 冷却下限 + 托盘 60s 节流）
10:00:59  read_overview 8.2s
10:02:02  read_overview 2.1s
10:03:05  read_overview 2.2s
10:04:27  read_overview 21.0s   ← 用户截图大概率在此窗口
10:05:32  read_overview 3.5s（重 tick）
10:06:53  read_overview 19.9s
```

CPU 时间核算：进程 8 分钟墙钟累计 10:02.73 CPU 分钟 ≈ **平均 1.2 核**，与用户感受一致。

---

## 2. 调查方法

1. **日志重建**：`read_overview 完成，用时 X` 逐条提取，建立耗时分布（正常 2–3.5s，峰值 21.0/19.9/31.9s）。
2. **组件隔离实测**（真机 245MB 权威库）：
   - claude_days SQL（含 GROUP BY）：**45ms**（索引 `usage_facts_harness_time` 命中，186 分组）
   - DB 打开序列复刻（busy_timeout + journal_mode + user_version + repair 查询）：**12–22ms**
   - 每次 open 的 DDL churn（DROP/CREATE VIEW 写事务）：**5–20ms**
   - `load_pricing`：内嵌常量解析，微秒级
3. **进程采样**：`sample` ×4（3s/5s/8s 窗口），对比线程 ID 演化。
4. **连续 CPU 监测**：75s 窗口每 2s 采样 `ps pcpu`，与日志时间戳对齐。
5. **细粒度 CPU 周期**：1.5s 间隔读累计 CPU 时间，测突发周期。

---

## 3. 发现 #1：fsevents 线程 churn（新引入，最高优先修复）

### 3.1 证据

- 两次采样间隔仅 10 秒，全部 8–12 个 `notify-rs fsevents loop` 线程的 ID **从 15000xxx 换成 15003xxx**——线程集合整体生灭，不是稳定驻留。
- 采样抓到线程栈顶在 **`FSEventStreamStart`**（in FSEvents）——挂载尝试正在进行。
- 采样出现 **`_pthread_mutex_firstfit_lock_wait` × 350**——锁争用自旋在烧 CPU。
- 某时刻 `ps -M` 数 fsevents 线程为 0，数秒后 sample 又见 8 个——瞬态线程。

### 3.2 机制

worker 循环的空闲分支：

```rust
Err(RecvTimeoutError::Timeout) => {
    state.retry_pending();        // ← 每 1.2s（DEBOUNCE）空闲触发
    ...
}
```

`retry_pending` 对 4 个 pending 根（不存在的执行环境目录：hermes/cursor/gemini-cli/opencode 的 skills 根）逐个 `try_attach`。macOS 后端上，notify 的 `watch()` 对不存在路径的每次尝试都会**启动 FSEventStream（含 runloop 线程）**，再以 PathNotFound 失败销毁。结果：

- 空闲时每 1.2s 制造 4 次线程创建/销毁循环（伴随内核锁争用）；
- 持续写入期间超时分支虽少触发，但 supervisor/派发路径的线程生灭仍在采样窗口可见；
- 这是**纯浪费**：目录不存在时重试的合理节奏是分钟级，不是秒级。

### 3.3 修复建议（P0，一行级）

给 pending 重试加指数退避：首个 30s，翻倍至 300s 封顶；挂载成功或拓扑替换时重置。附带把 `WatchBatch` 派发循环里任何隐式重建路径一并审一遍（确认只有 retry_pending 触发 watch）。

---

## 4. 发现 #2：trust 传感 30s 突发（既有面）

### 4.1 证据（对齐表）

| TrustMonitorInvalidated 时间戳 | 2s 后 CPU 采样 |
|---|---|
| 02:13:31.485 | 02:13:41 **243.0%** |
| 02:14:02.183 | （周期内）|
| 02:14:32.892 | 02:14:33 **262.7%** |

75s 监测窗口内全部 CPU 峰值与 trust 事件时间戳精确同步；两次事件之间 CPU 回落 <30%。

### 4.2 机制

trust 传感（opt-in，本机开启）每 30s：spawn lsof 子进程采样 → 解析 → 观察写入权威库（写事务）→ `correlate_selected` 相关器 → 发射事件。突发为多线程（170–263%），主要成本在观察落库 + 相关器。**这是按设计工作的安全功能**，不是 bug——但它是当前稳态负载的最大单一贡献者。

### 4.3 建议（P1：先实验后优化）

1. **免费验证实验**：用户关闭 trust 传感观察 30 分钟——既验证本归因，也量化其真实占比。
2. 若确认占比大，优化方向：相关器增量输入（只喂新观察而非重扫窗口）、lsof 输出解析降频。
3. 产品面：Findings/Trust 设置里给出「传感开启时的资源预期」说明（透明，不禁用）。

---

## 5. 发现 #3：read_overview 2–21s（未解，观测面已就位）

### 5.1 矛盾的实测结果

| 组件 | 隔离实测 | 真实运行 |
|---|---|---|
| claude_days + peaked_days SQL | 45ms | — |
| DB 打开序列（含 DDL churn） | 12–22ms | — |
| load_pricing / 折叠 / harnesses.json | 微秒–毫秒 | — |
| **read_overview 整体** | — | **基线 2s，峰值 21.0/19.9/31.9s** |

单组件全快、整体慢 40–400 倍 → 慢在**组合场景**：与同步子进程的写入事务、其他线程的 DB 打开（每次 open 都带 DDL 写事务）、WAL checkpoint 的争用。21s 峰值与 `busy_timeout(5s)` × 多语句等待的量级吻合（未证实）。

### 5.2 建议（P2：需要数据再动刀）

1. **先把 Phase D 式子计时伸进 read_overview 内部**（open#1 / SQL / open#2 / budget SQL / 组装 五段）——一次迭代内的小改动，让下一次发生时直接看到段级分布。
2. 候选修复（按证据到位后择一）：
   - 打开只读化：`overview_bundle` 改 `open_readonly`（跳过 DDL churn 与写锁），前提确认版本门逻辑可绕；
   - 进程内共享一个长连接（消除每 60s 两次 open）；
   - WAL checkpoint 主动调度（挪到重 tick 尾部，避免读者吸收）。
3. 在此之前**不做投机优化**——组件全快的实测结果说明任何"优化 SQL"的直觉都会扑空。

---

## 6. 已排除的假设（附否证证据）

| 假设 | 否证 |
|---|---|
| 轻路径路由失效，仍在跑全量 tick | 日志：轻 tick 只含被唤醒执行环境；重 tick 与轻 tick 步骤集清晰分离 |
| SQL 聚合慢（表大无索引） | 245MB 库 / usage_facts 91,315 行，EXPLAIN 命中 `usage_facts_harness_time`，实测 45ms |
| 单槽唤醒积压（HARDENING 前 P0） | 单槽+执行环境键合并在位；日志无陈旧唤醒排队形态 |
| notify fsevents 线程持续烧 CPU | 栈顶在 `mach_msg2_trap`（runloop 阻塞等待）——线程存在≠在烧；真正的成本是它们的**生灭**（发现 #1） |
| load_pricing 网络阻塞 | 实现为内嵌 `include_str!` 常量解析，零网络 |
| 冷启动 34.9s 是回归 | 一次性全量回填，历史行为，完成后不再出现 |

---

## 7. 修复路线图

| 优先级 | 项 | 改动量 | 预期收益 | 验证标准 |
|---|---|---|---|---|
| **P0** | pending 重试指数退避（30s→300s） | ~20 行 | 消灭空闲线程 churn 与锁自旋 | 采样中 fsevents 线程 ID 稳定；空闲 CPU ≈0 |
| **P1** | trust 传感关闭实验（用户操作） | 0 | 验证归因 + 量化占比 | 30 分钟窗口 CPU 曲线对比 |
| **P1.5** | trust 相关器增量输入（若实验证实） | 中 | 削 30s 突发峰值 | TrustMonitorInvalidated 后 1s 内 CPU <100% |
| **P2** | read_overview 内部子计时（观测先行） | ~30 行 | 下次 21s 发生时直接看到段级分布 | 新增 5 段计时进日志 |
| **P2.5** | 按子计时数据择一：readonly open / 长连接 / checkpoint 调度 | 中 | read_overview 回到亚秒 | 持续写入期间 read_overview P95 <500ms |

## 8. 监控与防回归

- 既有 `self_monitor`（50% 阈值 + 冷却指数）继续作为最后一道防线——本次它未触发说明平均负载未持续超阈，符合"多个 <50% 来源叠加"的画像；
- 建议给 `refresh 超预算` WARN（Phase D）增加同款 `read_overview 超预算`（>5s 记 WARN）——把本报告的发现 #3 纳入常态观测；
- 线程数巡检：健康发布器里加 `thread_count`，超过基线 +10 时记 INFO——churn 类问题以后 30 秒内可见。

---

## 附录 A：关键命令与输出摘录

```
# read_overview 耗时分布（当天，秒）
10.6 / 10.8 / 11.1 / 11.1 / 21.0 / 29.8 / 30.5 / 31.9

# SQL 实测
sqlite3 "$DB" "…claude_days GROUP BY…"   → 0.045s total（186 组）

# 打开序列实测
PRAGMA busy_timeout=5000; journal_mode=WAL; user_version; repair SELECT
                                        → 0.012–0.022s total

# 线程 churn 实录
sample#1（02:15）：fsevents 线程 149948xx–149949xx（8 个活跃计数）
sample#2（02:17）：fsevents 线程 150033xx–150034xx（6 个，ID 全换）
ps -M 某时刻：fsevents 线程 = 0（瞬态生灭）

# CPU-事件对齐
02:14:32.892 TrustMonitorInvalidated → 02:14:33 ps 262.7%
02:13:31.485 TrustMonitorInvalidated → 02:13:41 ps 243.0%（周期内峰）
```

## 附录 B：本报告未覆盖

- 截图 613% 的精确构成无法事后复原（采样未覆盖到该瞬时）；按多峰叠加解释，与 170–263% 的实测稳态峰值自洽。
- `busy_timeout` 等待假设（5.3）未直接证实——需 P2 子计时数据。
