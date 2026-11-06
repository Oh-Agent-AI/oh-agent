# agent-vitals 架构优化建议书

> 评估对象：`agent-vitals` v1.3.0（仓库根 workspace 名为 `skill-vitals`，package 与 crate 均为 `agent-vitals`）
> 评估时间：2026-09-04
> 评估分支：`docs/cost-attribution-and-hour-axis-spec`（领先 origin 29 commits，工作区 dirty）
> 评估范围：当前已落地的实现 + 在飞的重构（v0.8 Phase D5）+ 计划中的 R1d / R3
> 评估方法：源码静态扫描 + git log / status + CLAUDE.md 与 40+ spec 文档交叉对账 + 1094 项 Python 测试 + 144 项 Rust 测试的实跑结果

---

## 0. 摘要（TL;DR）

**5 项必须改 · 4 项应该改 · 5 项值得改**

| 类别 | 数量 | 关键词 | 最严重项预计落地时间 |
|---|---|---|---|
| **必须改（数据正确性）** | 2 | ledger 写序 / 跨进程锁 | **3-5 天** |
| **应该改（能力扩展）** | 3 | 持久化 CanonicalSession / 双层 tick / R3 watcher | 1-2 周 |
| **值得改（卫生债）** | 5 | CLAUDE.md 数据 / 拆大文件 / 补 Python 边界守卫 / 建 runtime crate | 1-2 月 |
| **长期方向** | 2 | dual-impl 决策 / 文档主从 | 季度级 |

**最关键的一句话**：

> 当前架构在"5min 单写者 xbar tick + 用户几乎不并发"的现实负载下**能跑**。
> 但 **R1d 的 ledger-first 写序 + flock 跨进程锁** 这两件事不补，**任何一次 oneline 在写完 state 后、写完 ledger 前的崩溃 = 永久双倍累加**。这条 race 已经被代码注释**自己写明**（`src/agent/takeover.rs`），但**至今未修**。

---

## 1. 现状摘要（独立可读）

### 1.1 项目是什么

`agent-vitals` 是装在执行环境内的 **Skills 体检 + 会话行为审计 + Token 成本计价** 三合一工具，跨 6 个 Agent 执行环境（Claude Code / Codex / DSH / WorkBuddy / OpenClaw / Hermes）。它本身就是一个 Agent Skill（`SKILL.md` 在根目录）。

### 1.2 架构拓扑

```
crates/
├── vitals-core/                  v0.5.0   执行环境无关审计 runtime（Event→Trajectory→Detector→Finding）
├── agent-vitals-domain/          v1.3.0   contracts/ + domain/ + compatibility/
├── agent-vitals-harnesses/           v1.3.0   harnesses/<h>/{sessions,skills,sources}/
├── agent-vitals-runtime/         v1.3.0   空骨架：只有 HomeResolver
└── agent-vitals-wasm/            v1.3.0   wasm-pack cdylib
src/                                       binary (agent-vitals CLI) —— 正在变薄
src-tauri/                                 独立 workspace（Tauri 菜单栏）
scripts/agent_vitals/                      Python 并行实现
dsh-client/                                DSH 审计 tab（harness projection + client）
```

**关键事实**：
- `agent-vitals-core` 这个名字 CLAUDE.md 写过，但**当前工作区不存在**——已被 Phase C 合并进 `agent-vitals-domain`。**CLAUDE.md 在这件事上过期**。
- `agent-vitals-runtime` crate **存在但只 144 行**（`home.rs`），watcher 是 R3 计划。
- 4 个独立空间通过 Rust + Python + wasm + DSH-TS 锁步维护，靠 differential gate 守门。

### 1.3 真实测试规模

| 项 | 实际 | CLAUDE.md 声称 | 偏差 |
|---|---|---|---|
| Python 测试 | **1094**（215 skip，**1 red**） | 352 | **3.1× 过期** |
| Rust 测试 | 144 | 144 | OK |
| crates/agent-vitals-domain | ~10k 行 | — | — |
| crates/agent-vitals-harnesses | ~9.4k 行 | — | — |
| scripts/agent_vitals | ~17k 行 | — | — |
| dsh-client/src | ~2.7k 行 | — | — |
| spec 文档 | 49 个 md | — | — |

**红测试**：`test_rust_session_agent_family_in_agent`（`tests/test_classification.py`）——分类守卫挂了，**CLAUDE.md 把这个清单当"绝对不可改"红线，但红线本身在退化**。

### 1.4 当前活跃线

v0.8 Phase D5 迁移中：
- D1 wire/fold 分离 ✅
- D2 cost.rs 切出 cost/claude.rs ✅
- D3 agent-vitals-adapters → agent-vitals-harnesses 改名 ✅
- D4 DSH 会话 I/O 迁进 harnesses/dsh/sources/ ✅
- **D5 Claude/Codex/WorkBuddy session reader 迁移中**（工作区 dirty）
- D6 state/takeover/discovery 迁入 runtime crate **未启**
- D7 HomeResolver 迁入 runtime ✅
- E / F 规划中

---

## 2. Tier 1 — 必须改（数据正确性）

### 2.1 R1d ledger-first 写序

**文件位置**：`src/agent/takeover.rs::fold_session`

**现状**（注释原文）：

> 写序是「**state 文件先折 → ledger 记 key → manifest 提交**」：manifest 是提交点，ledger 是去重依据。崩溃窗口（state 文件已写、ledger 未记 → 下个 tick 重折翻倍）是 §4.2 约束 6 的 generation-manifest 协议（R1e/R3）才收口的事，R1d 的最小子集先保证「无崩溃的连续多 tick」不重复累加

**问题**：

```
T1: 写 state/today.json (delta 加进去)
T2: 写 state/month.json (delta 加进去)
T3: 写 state/oneline.json
T4: <-- 进程被杀（kill / OOM / power loss / panic）
T5: ledger 没写 → "这条 session 没折过"
T6: 下次 tick → 读 ledger → 没折 → 重 fold
T7: 写 state/today.json → delta 第二次加进去 → 双倍
```

**这个错会永久保留**。下个 tick 不会愈合（ledger 没记），再下个 tick ledger 终于记了，但 state 早就双倍了。

**方案**：把写序反转：

```
T1: 写 ledger (mark "折中，待提交")
T2: 写 state/today.json
T3: 写 state/month.json
T4: 写 state/oneline.json
T5: 写 manifest (commit)
```

崩溃窗口从"双倍"变成"少计一次"——这正是项目自己的格言：

> "宁可少计也不翻倍"（`src/agent/oneline.rs:105` 注释原话）

**代价**：
- 代码：~80 行（`takeover.rs::fold_session` 改写序 + 5-6 个状态迁移 case）
- 测试：`tests/test_oneline_lockstep.py` 锁步测试更新（Python 侧也要改）+ 加 3-5 条崩溃恢复单测
- 锁步对账：Python `cli.py:1149-1305` 的 oneline handler 要同步反转

**收益**：
- 关掉 **Window 2（双倍累加）**——Tier 1 唯一一条"理论 0 概率，实际取决于 SIGKILL" 的 race
- 任何崩溃恢复 = 少一次会话账，**而不是双倍**——账目上限可预测

**落地时间**：2-3 天

**优先级**：🔴 **最高**。这条不修，**任何一次 oneline 撞 SIGKILL/OOM/电源 = 永久双倍 token**。

### 2.2 跨进程 flock

**文件位置**：`src/agent/state.rs::atomic_write_json`（已有），`takeover.rs::fold_session`（缺）

**现状**：

> flock 已知限制（2026-08 决定，不是 bug）：`std::fs::File::lock` 是 Rust 1.89 才进 std，本 crate MSRV 1.74。Python 用 `fcntl.flock` 防并发 read-modify-write 互相覆盖；这里靠「写 tmp → rename」的原子性

**问题**：

`atomic_write_json`（tmp → fsync → rename）保证**单文件原子**，但**多文件 R-M-W 不原子**：

- 进程 A 读 today.json = `{tokens: 100}`
- 进程 B 读 today.json = `{tokens: 100}`
- A 算 100 + 50 = 150，B 算 100 + 30 = 130
- A 先写 150，B 后写 130 → **A 的 50 丢了**
- 反之 B 先写 130，A 后写 150 → **B 的 30 丢了**

**触发场景**：
- 用户手动 `oneline` 撞 xbar tick 尾巴（< 1s 窗口 × 极低频率）
- Tauri 菜单栏触发某条 on-demand 审计（如果将来加）
- 多个 `oneline` 并行（如果将来加 `--parallel` flag）

**方案**：用 `libc::flock` 加跨进程文件锁。POSIX 1980s 稳定，`libc` 已经是 cargo 间接依赖（通过 `nix` 或 rustix）。**不需要 MSRV 1.89**。

```rust
// crates/agent-vitals-runtime/src/lock.rs (新文件, ~40 行)
pub struct StateFlock(File);
impl StateFlock {
    pub fn acquire_exclusive(state_dir: &Path) -> Result<Self, LockError> {
        let path = state_dir.join(".lock");
        let f = OpenOptions::new().create(true).write(true).open(&path)?;
        // libc::flock(LOCK_EX | LOCK_NB) 拿不到直接报 Busy
        // （不要无限等待 —— 5min tick 应该立刻知道有别人在写）
        unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        Ok(Self(f))
    }
}
impl Drop for StateFlock {
    fn drop(&mut self) { unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) }; }
}
```

**约束**：
- 加进 `agent-vitals-runtime`，**不加** `harnesses` 或 `domain`（`dependency_budget.rs` 否定清单要更新）
- `libc` 进 runtime 的 `[dependencies]`，**不进** harnesses/domain
- `LOCK_NB` 非阻塞——5min tick 拿不到锁就 skip 本次（**已有人写就让他写完**）
- Python 端 `fcntl.flock` 同步加（CLI 兼容）

**代价**：
- 代码：~50 行 runtime 新增 + 30 行 takeover 集成
- 测试：加 4-6 条并发测试（两个进程同时 oneline，验证只有 1 个成功 + 1 个报 Busy）
- CI：加 `--features runtime-flock` 编译矩阵（macOS / Linux）

**收益**：
- 关掉 **Window 1（R-M-W 丢 update）** + **Window 3（manifest epoch 冲突）**
- 任何 R-M-W 文件（today.json / month.json / session-ledger.json / writer-manifest.json）成为串行
- 真正的"单写者"——不再靠运气

**落地时间**：1-2 天（含 CI 矩阵）

**优先级**：🔴 **高**。flock 1 天能搞定，但**没 ledger-first 修之前**，flock 单独上**不解决双倍**——它俩必须一起上。

---

## 3. Tier 2 — 应该改（能力扩展）

### 3.1 持久化 CanonicalSession + 轻量 index

**问题**：r2a envelope 存**摘要**（cost_series、by_model、hour_buckets），**不存证据**。要回答"这次会话里哪条 bash 触发 SV601 / approval 拒了几次 / sandbox 何时切到 danger-full-access"——必须重 fold。**重 fold 需要 raw jsonl 还在**，而 **DSH retention 是 DSH 自己管的**，agent-vitals 不持有。

**方案**（不要 SQLite）：

```
data_home()/
├── state/                    ← 已有，今天/本月账 + ledger + manifest
├── cache/r2a/                ← 已有，per-session envelope 摘要
└── canonical/                ← 新增
    ├── index.jsonl           ← 一行一 session: (session_id, harness, date, signals[], finding_codes[], duration)
    └── <session_id>.json     ← CanonicalSession 完整序列化
```

- `canonical/<id>.json`：直接 `serde_json::to_string_pretty(&canonical_session)`，值类型已是 Serialize
- `index.jsonl`：append-only，POSIX 原子 append，跨会话 grep 用
- 写时序：fold 完算完 → 写 canonical → append index（**canonical 写成功才 append**）
- schema 迁移：和 r2a 一样，**抬版本号一次冷启动**，不做就地迁移

**新增 CLI**：
- `agent-vitals query <filter>` —— 按 harness / date / finding_code 过滤 + 列 session_id
- `agent-vitals show <session_id>` —— 打印 CanonicalSession 摘要
- `agent-vitals trace <session_id> <signal>` —— 打印某条 signal 的 timeline

**代价**：
- 代码：~200 行新模块（`crates/agent-vitals-runtime/src/canonical_store.rs`）+ 3 个新 CLI 子命令
- 存储：~10-100KB / session × 58 session = ~1-5MB（量级 OK）
- 测试：index 写入锁步 + 跨会话 grep 单测 + schema 迁移冷启动测试
- 文档：补 `docs/CANONICAL_PERSISTENCE.md`

**收益**：
- 调查任何历史会话 instant lookup（不再依赖执行环境 retention）
- 跨会话 finding 模式分析（"SV612 在 2026 Q3 比 Q2 多 30%"）
- DSH 审计 tab 可以展示历史会话 instant（不再每次 open tab 重 fold）
- **不动 SQLite**——保持 xbar `cat state/*.json` 的简单性

**落地时间**：1-2 周

**优先级**：🟡 **中-高**。**真要 1s 实时 + 跨会话查询 = 必须做**。**只做 1s 实时而不做 = 实时也只能查当前 session**。

### 3.2 Smart poll 双层 tick

**问题**：当前 xbar 5min tick。要"1s 内看到新数据"有两条路：
- 把 tick 降到 1s → 5-7 个 atomic_write × fsync × 60 = 满载 fsync，浪费严重
- 加 FS events watcher → `notify` 被 `dependency_budget.rs` 禁止，加进来要改架构（要等 R3）

**方案**：拆成两层 tick，**不同职责**：

```
fast tick (1s, 独立 loop)  → smart poll session.jsonl (mtime check)
                              → re-fold delta
                              → 推到 DSH 审计 tab / stdout JSON
                              → 完全不写 state/*.json
                              
slow tick (5min, xbar)     → fold 完整新 session
                              → 写 state/today.json + month.json + ledger + manifest
                              → 这是 R1d 写序的承担者
```

**实施要点**：
- fast tick 是**只读消费**——它**不参与 state 写链**，`require_rust_owner` 跳过
- 5min tick 仍守 fencing + 写序（修了 2.1 之后）
- mtime stat 是 1 syscall ≈ 1μs，**idle 0% CPU**
- 有新数据才读 + fold（单次 < 100ms）

**代码骨架**：

```rust
// src/agent/live_fold.rs (新文件, ~80 行)
pub fn live_fold_once(
    session_log: &Path,
    last_offset: &mut u64,
    cached_mtime: &mut Option<SystemTime>,
) -> Vec<Finding> {
    let mtime = fs::metadata(session_log).ok().and_then(|m| m.modified().ok());
    if mtime == *cached_mtime { return vec![]; }
    let new_bytes = read_from_offset(session_log, *last_offset)?;
    *last_offset += new_bytes.len() as u64;
    *cached_mtime = mtime;
    let new_events: Vec<Value> = parse_jsonl_or_degraded(&new_bytes);
    audit_events(&new_events, workspace_root)
}
```

**CLI**：
- `agent-vitals live <session_log>` —— 1s smart-poll loop，stdout 推 findings JSON
- `agent-vitals live --push <harness>` —— 接到 DSH 审计 tab 的 projection

**代价**：
- 代码：~120 行（live_fold.rs + 1 个新 CLI 子命令 + Tauri projection hook）
- 测试：mtime 变化触发 fold 单测 + 不变化不触发的反向单测
- 锁步：Python 不需要镜像（live_fold 是 Rust-only 的实时路径，Python 端 5min tick 仍用 oneline）

**收益**：
- 用户感知延迟：从 5min 降到 < 1s
- **不破**现有 5min state 写链（state 写是 fsync-bound，不该更频繁）
- **不破**架构（不动 dependency_budget，不加 notify）
- **修好这条之后，2.1 ledger-first 写序的"双倍累加" window 在 fast tick 路径下也关上**——因为 fast tick 不写 state

**落地时间**：1 周

**优先级**：🟡 **中**。**1s 实时是用户体感问题**。如果用户主要在 DSH 审计 tab 看，**DSH 的 in-process 事件流方案**（§3.4）比这个更直接。

### 3.3 R3 watcher（FS events）

**现状**：`agent-vitals-runtime` 是空骨架，注释明说"**不加 notify/watcher/tokio——那是 feature"**。R3 计划在 runtime 加 `notify` 作为 feature。

**建议**：

```toml
# crates/agent-vitals-runtime/Cargo.toml
[features]
watcher = ["dep:notify", "dep:notify-debouncer-mini"]
```

监听目标：
- `<DSH_HOME>/sessions/**/*.jsonl[.zstd]` —— 新文件 + append
- `~/.claude/projects/*/*.jsonl` —— 新文件 + append
- `<CODEX_HOME>/sessions/**/*.jsonl` —— 新文件 + append
- `~/.workbuddy/workbuddy.db` —— **SQLite 没有 FS 通知**，**只能 mtime poll**

**已知限制**：
- macOS FSEvents 默认 1-3s coalescing window——**真实延迟是 1-3s 不是 1s**。**别宣传"亚秒实时"**
- Linux inotify 真亚秒，但每个原子 rename（write tmp → rename）触发多事件——需要 debouncer
- Windows ReadDirectoryChangesW 同 FSEvents coalescing

**代价**：
- 代码：~300 行（`runtime/src/watcher.rs` + debouncer + 4 个 harness 路径配置）
- 测试：FS 事件注入测试（inotify fake events）+ 跨平台 CI 矩阵
- macOS / Linux / Windows 行为差异需要 separate test

**收益**：
- 取代 1s smart poll 的 IO polling 部分——push 触发 fold，更省 CPU
- 多 session 并行 fold 场景下天然
- 与 3.2 的 fast tick 配合：watcher 检测变化 → 触发 fast fold

**落地时间**：1-2 周（含三平台 CI）

**优先级**：🟢 **低-中**。**3.2 的 smart poll 已经在用户量级够用**。R3 是"session 量涨到几千/月 + 多终端"才迫切。

### 3.4 DSH 审计 tab live subscription 模式

**现状**：`dsh-client/src/harness/index.ts` 的 `sessionProjections` 框架是 query-driven（每次 tab 打开 re-fold）。DSH 是 in-process 的，**架构上支持 push**——但当前没实现。

**建议**：在 DSH harness 加一个 "audit-stream" subscription：

```
DSH 内部事件流 ──► sessionProjections.auditStream subscription
                       │
                       ▼
                    wasm audit_events (增量, 不重 fold)
                       │
                       ▼
                    审计 tab 实时追加 findings
```

**关键**：
- **不重 fold**——只 fold 增量事件，用 `UsageFoldState` 的 checkpoint 机制（已有，详见 `crates/agent-vitals-domain/src/domain/usage.rs`）
- audit_stream 订阅 = DSH harness 自己加的活（**这是 dsh 项目的事，不是 agent-vitals 单独能做的**）
- agent-vitals 这一侧提供：增量 fold 入口 + 增量 findings 推送协议

**代价**：
- DSH 侧：~100 行 JS（subscription 注册 + 事件过滤）
- agent-vitals 侧：~50 行（增量 fold 入口 + checkpoint serialize/deserialize）
- 锁步：wasm 增量 fold 也要更新，**wasm build 要重跑 + 重 copy 到 dsh-client**

**收益**：
- DSH 审计 tab 真实时（< 100ms 延迟，因为 in-process 推送）
- **不依赖文件系统**——纯 in-process event stream
- **不破**任何现有架构（live 是新模式，query 模式保留兼容）

**落地时间**：2-3 周（含 DSH 协调 + wasm 重 build）

**优先级**：🟢 **低**。**这条是 dsh 团队的事**——agent-vitals 单方面做不了。

---

## 4. Tier 3 — 值得改（卫生债）

### 4.1 刷新 CLAUDE.md 过期数字

**问题**：
- "352 tests" → 实测 **1094**，差 3.1×
- `crates/agent-vitals-core` crate **已不存在**（合并进 domain）
- 红测试 `test_rust_session_agent_family_in_agent` 仍被引用为"绝对不可改"
- "agent-vitals-core 是 single source of truth" 这句话现在不准确——是 `agent-vitals-domain`

**方案**：
- 把所有数字段落实跑一次重新填
- 把 `agent-vitals-core` 引用全部替换为 `agent-vitals-domain`
- 红测试要么修、要么标 known_failing（**标 known_failing 比假装它绿更诚实**）

**代价**：半天（grep + 改）

**收益**：
- 新进开发者拿到的事实基线是真的
- **CLAUDE.md 自己开始守自己立的原则**（"scan me first"）

**优先级**：🟡 **中**。**任何新加入的 agent 都会读 CLAUDE.md**——错的事实比没有事实更危险。

### 4.2 拆大文件

**现状**：

| 文件 | 行数 | 占比 |
|---|---|---|
| `crates/agent-vitals-domain/src/domain/usage.rs` | **3159** | domain 31% |
| `src/agent/claude_cost.rs` | 1342 | binary 8% |
| `crates/agent-vitals-domain/src/domain/behavior.rs` | 1204 | domain 12% |
| `crates/agent-vitals-domain/src/domain/trajectory.rs` | 854 | domain 8% |

**建议**：
- `usage.rs` 按职责拆：`token_fold.rs` / `token_by_date_model.rs` / `codex_fold.rs` / `usage_fact.rs`（已经有文件，但可能没有完全切干净）
- `claude_cost.rs` 迁进 `harnesses/claude_code/sessions/`（纯）+ `sources/`（I/O），对应 Phase D5 已开始的迁移模式
- `behavior.rs` 已是 detector 迁移的"旧入口"——legacy 路径**全部删掉**（`detect_svNNN_legacy` 全部删除，**Phase E 应该做的事**）

**代价**：
- 1-2 周
- 锁步测试要全跑（golden parity 不能漂）
- 边界守卫要加（拆出来的子文件必须还守 `domain_production_code_has_no_harness_adapter_dependency`）

**收益**：
- 单一文件不再成为认知瓶颈
- 新规则进来不再长在"上帝文件"里
- detector 迁移可以收尾（`detect_svNNN_legacy` 删掉，行为/轨迹代码各砍一半）

**优先级**：🟡 **中**。**v0.8 收口时必须做**——D 阶段结束就拆，否则 Phase E/F 推不动。

### 4.3 补 Python 侧 boundary guard

**现状**：
- `crates/agent-vitals-domain/tests/dependency_budget.rs` 钉死 Rust 不破边界
- Python 侧**只有一个 `test_classification.py`**——靠 grep 钉模块归属
- **没有禁止 Python `import requests` 这种事**——"no network at scan time" 纪律靠人

**建议**：

```python
# tests/test_python_boundary.py (新文件, ~50 行)
FORBIDDEN_IMPORTS = [
    "requests", "urllib3", "httpx", "aiohttp",  # network
    "sqlalchemy", "peewee", "django.db",         # ORM (declared discipline)
    "redis", "pymongo",                          # stateful storage
]
def test_python_no_network_imports():
    for py_file in Path("scripts").rglob("*.py"):
        tree = ast.parse(py_file.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for n in node.names:
                    assert n.name.split(".")[0] not in FORBIDDEN_IMPORTS
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    assert node.module.split(".")[0] not in FORBIDDEN_IMPORTS
```

**代价**：半天

**收益**：
- "no network at scan time" 纪律有自动化兜底
- Python 端增长时不会被静默引入 ORM / HTTP client

**优先级**：🟡 **中**。**纪律类守卫，落地简单，价值长期**。

### 4.4 把 state/takeover/discovery 迁进 `agent-vitals-runtime`

**现状**：

```rust
// crates/agent-vitals-runtime/Cargo.toml 注释：
// v0.8 Phase D6/D7：agent-vitals-runtime 装非执行环境的本机机器
// 唯一 HomeResolver、state/ledger 存储、Skill/Session service 编排
```

但当前 `src/agent/` 还有 18 个 .rs 文件是"非执行环境本机"：

```
behavior.rs, budget.rs, claude_cost.rs, claude_usage_fact.rs, codex_cost.rs,
codex_session_audit.rs, codex_usage_fact.rs, cost.rs, dsh_usage_fact.rs,
discovery.rs, harness_runtime_registration.rs, oneline.rs, plan.rs, r2a_store.rs,
session_sources.rs, state.rs, takeover.rs
```

CLAUDE.md 写 D6 是这件事，**D6 未启**。

**建议**：按"是否纯函数 / 是否 IO / 是否编排"三档分：
- 纯函数 → `agent-vitals-domain`（behavior / plan）
- IO → `agent-vitals-runtime`（state / takeover / r2a_store / discovery / session_sources）
- 编排 → `agent-vitals-runtime`（oneline / budget / claude_cost / codex_cost / *_usage_fact / harness_runtime_registration）

**代价**：D6 整阶段，2-4 周

**收益**：
- `src/agent/` 变薄到 ~500 行（基本是 cli handler）
- `agent-vitals-runtime` 长出"非执行环境本机机器"这层
- §3.1 / §3.2 / §3.3 的实施有明确的归处

**优先级**：🟡 **中**。**v0.8 收口时必须做**。

### 4.5 把 detector legacy 路径删掉

**现状**：`crates/agent-vitals-domain/src/domain/detectors/` 14 个文件全部实现 `vitals_core::Detector`，但 `behavior.rs` 和 `trajectory.rs` 仍保留 `detect_svNNN_legacy` 作为回退。

`compatibility/mod.rs` 注释说：

> §14.4 第 7 步"旧入口改为兼容 shim"的落点
> 原判定逻辑没有删，改名 `detect_svNNN_legacy` 留作回退

**建议**：
- v0.9 时，**所有 legacy 路径删除**
- 旧的 `behavior.rs` 入口删，留下 `compatibility::findings::vitals_report_to_legacy_findings` 一个统一 shim
- behavior.rs / trajectory.rs 各砍一半

**代价**：1-2 周（含 parity 测试再跑一轮 + 锁步 Python 路径同步）

**收益**：
- "14 个 detector + 14 个 legacy" 的双倍存在期结束
- 行为/轨迹规则引擎代码体量减半
- parity 测试从"新旧都要对"变"新对就行"

**优先级**：🟡 **中**。**v0.8 → v0.9 的过渡期决定**。

---

## 5. Tier 4 — 长期方向

### 5.1 dual-impl 是不是真"永久并行"

**现状**：`docs/ENGINEERING.md` §6.8 在 2026-08 修订：

> 永久并行，差分护栏从「移植期的临时脚手架」升级成**永久契约**

**问题**：
- "永久" 是个**不可验证的承诺**——只要 Python 实现存在，每个规则得写两遍 + 锁步测试 + golden
- 已经被 §3 各项碰到的"Python 镜像同名字段"反复维护
- differential gate 守**字节**不守**语义**——`token_by_date_model` 已经掉出去过一次（¥2386 vs ¥1733）

**建议**：做个**显式决策**而不是"默认永久"：

| 路径 | 触发条件 |
|---|---|
| **退役 Python 端 oneline/behavior** | DSH 审计 tab 完全用 wasm；ClawHub 形态不需要 Python 镜像 |
| **保留 Python 但只保留 skills 静态扫描** | ClawHub in-harness skill 形态只要 `scripts/scan.py`（CLAUDE.md 的"Python 端 stdlib-only"） |
| **真永久并行** | 接受每年 X 个新规则 × 2 倍维护成本；X > 5 时退役 Python |

**现在不决策的代价**：每个新规则加进来都得回答"Python 端要不要镜像"——这是隐性税。

**优先级**：🟢 **季度级**。**不阻塞 v0.8 收口**。

### 5.2 文档主从关系图

**现状**：49 个 spec md 文件。CLAUDE.md 自己说"read this before..." 之后指 4-5 个 spec，但**spec 之间没有显式主从**——遇到"定价"问题时，可能相关的是 `docs/COST_BASELINE.md` / `docs/VITALS_CORE_V0_7_DATA_PLANE_SPEC.md` / `docs/UNIFIED_COST_VIEW.md` / `docs/COST_CALENDAR_BUDGET.md` / `docs/CLAUDE_COST_DAY_ATTRIBUTION_ANALYSIS.md` 之一，**新人不知道先读哪个**。

**建议**：在 `docs/README.md` 加一张主从关系图：

```markdown
# 文档主从图

规格类（spec）──┬─ R1 状态机（R1a, R1b, R1c, R1d, R1e）
                ├─ R2 数据面
                ├─ R3 实时
                └─ 跨切面（engine / product / winglet）

设计类（design）── 算法决策记录
数据契约（contract）── 词表 / 接口
```

**代价**：半天

**收益**：新人 5 分钟知道"这个问题归哪个 spec"。

**优先级**：🟢 **季度级**。

---

## 6. 实施路线图

### 4 周计划（按优先级）

```
第 1 周：
  - 修红测试 test_rust_session_agent_family_in_agent
  - 实施 2.1 ledger-first 写序（2-3 天）
  - 实施 2.2 flock 跨进程锁（1-2 天）
  → 跑完 1094 + 144 测试 + Python↔Rust 锁步 + 三平台 CI

第 2 周：
  - 实施 4.1 刷新 CLAUDE.md
  - 实施 4.3 Python 侧 boundary guard
  - 启动 3.2 smart poll（1 周内收口）
  - 启动 3.1 canonical 持久化骨架（schema 设计 + index 设计）

第 3 周：
  - 收口 3.1 canonical 持久化（写 + index + 3 个新 CLI）
  - 启动 4.2 拆大文件（usage.rs 优先）

第 4 周：
  - 继续 4.2
  - 启动 4.4 D6 state/takeover 迁入 runtime
  - 评估 3.3 R3 watcher 是否启动
```

### 季度路线图

```
2026 Q3 末：
  - Tier 1 全部完成（数据正确性关闭）
  - Tier 2 #1 / #2 完成（canonical 持久化 + smart poll）

2026 Q4：
  - v0.8 收口（Phase D 全部完成）
  - Tier 3 全部完成
  - 评估 5.1 dual-impl 决策

2027 Q1：
  - v0.9 启动
  - 4.5 detector legacy 路径删除
  - 5.2 文档主从图
  - 评估 3.3 R3 watcher 启动条件
```

---

## 7. 风险登记

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| Tier 1 不修 = 永久双倍风险 | oneline 撞 SIGKILL | **必须修** |
| Tier 1 不修 = R-M-W 丢 update | 任意并发 | 修 |
| Tier 3 文档过期 = 新人读错 CLAUDE.md | 任何新人 onboarding | 修 |
| Tier 3 usage.rs 持续涨 | v0.8 / v0.9 新规则 | 拆 |
| Tier 4 dual-impl 永续 = 隐性税 | 每加 1 个规则 × 2 维护 | 季度评估 |
| 整体 5min tick + 单写者假设 | 用户量涨到 1000+ session/月 | Tier 2 #1 + #2 提前 |

---

## 8. 不在本次建议里的事

- **ORM / 数据库**：用户问过"为什么没 ORM"——已确认是有意为之（见 §1.2 单一真源 + §1.3 测试规模）。**不建议引入 SQLite**。
- **workspace 命名（skill-vitals vs agent-vitals）**：纯 cosmetic，**不动**。
- **Python ↔ Rust 锁步是否继续**：见 §5.1，季度级评估。
- **src-tauri 独立 workspace**：见 §1.2 注释"独立 workspace 是有意的反同步"，**不合并**。

---

## 附录 A：所有 race window 速查

| Window | 触发 | 现状 | 修复 |
|---|---|---|---|
| **W1 R-M-W 丢 update** | 多进程并发 oneline | 无 | §2.2 flock |
| **W2 双倍累加** | oneline 写完 state 后崩 | **理论 100% 触发** | §2.1 ledger-first |
| **W3 manifest epoch 冲突** | 多进程并发 fold | 无 | §2.2 flock |
| **W4 跨文件读不一致** | tick 写 + 菜单读多文件 | 无（仅展示） | §3.2 fast/slow tick 分离 |
| **W5 半行 jsonl** | DSH 写到一半 oneline 读 | parse-fail-degraded | 已有效；**prefix 合法时漏**（待补 schema 校验） |
| **W6 WorkBuddy SQLite** | 执行环境写时我们读 | SQLite WAL | 执行环境兜底，不算 race |

## 附录 B：文件位置速查

| 引用 | 路径 |
|---|---|
| 主要写链 | `src/agent/oneline.rs`, `src/agent/takeover.rs`, `src/agent/state.rs` |
| 原子写 | `src/agent/state.rs:109` |
| 写序问题注释 | `src/agent/takeover.rs` 顶部 + `src/agent/oneline.rs:105` |
| flock 决定注释 | `src/agent/state.rs:14-22` |
| 降级铁律 | `crates/agent-vitals-harnesses/src/harnesses/dsh/sources.rs` 顶部 |
| 依赖预算守卫 | `crates/agent-vitals-domain/tests/dependency_budget.rs`, `crates/agent-vitals-harnesses/tests/dependency_budget.rs` |
| Detector 迁移 | `crates/agent-vitals-domain/src/domain/detectors/svNNN.rs` |
| 兼容 shim | `crates/agent-vitals-domain/src/compatibility/mod.rs` |
| Runtime 空骨架 | `crates/agent-vitals-runtime/src/home.rs` (144 行) |
| 双实现永久并行 | `docs/ENGINEERING.md` §6.8 |
| 当前活跃线 | git log: v0.8 Phase D1-D5 |

---

> 文档版本：1.0
> 评估者：Mavis（基于源码静态扫描 + 文档交叉对账 + 实跑测试结果）
> 下次回顾：建议在 4 周后（Tier 1 + Tier 2 #1/#2 完成后）做一次复评
