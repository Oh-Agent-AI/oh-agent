# 菜单栏能力迁移：SwiftBar → Tauri —— 可行性方案

状态：**已落地（2026-08-31），SwiftBar 插件已彻底删除（2026-09-01）**。
Phase 1/2/4 由 R1a–R1d（任务 #97–#100）完成，Tauri 菜单栏 app
（`/Applications/agent-vitals.app`）是**唯一形态**：自带 5 分钟 tick、spawn
Rust `oneline` 折 DSH 会话、预算权威读 `alert.json`，完全脱离
SwiftBar/xbar。原计划把 SwiftBar 插件与 `install_swiftbar.sh` 标记为
**legacy 降级通道**永久保留（见下方「Phase 5」一节），但用户后来判断
Tauri 已完全替代、不再需要降级通道，`contrib/xbar/`、
`scripts/install_swiftbar.sh`、`scripts/dsh_autosync.py` 连同各自的测试
一并删除——下面「Phase 5 —— SwiftBar 退役判定」及其后的更新记录了
「决定保留」到「实际删除」这两步决策，**均保留作历史**，不因后一步而回改
前一步的文字。以 §9 末尾的「2026-08-31 更新」为准了解写链迁移本身；本节
「删除」是在那之后的又一步。
范围：把 `contrib/xbar/agent-vitals.5m.sh`（SwiftBar 插件）的菜单栏能力迁进
`src-tauri/`（Tauri 2 菜单栏 app），并借机修复一个既有架构偏差（预算权威源被
绕开）。本文所有论断都有证据来源（`文件:行号` 或实测），不写无依据的结论。

## 0. TL;DR

- 现状：SwiftBar 插件 13 项能力，Tauri 已覆盖约 40%；**缺口集中在三处**——
  ① 无自动 tick（菜单栏数字不自己更新）；② 预算显示绕开 `alert.json` 权威
  （adaptive floor / snooze / 日预算全丢）；③ 本次会话 / 最近审计列表 /
  dsh_autosync 调度未迁。
- Python 包**不能移出项目**：它是 ClawHub 发行形态（`package-clawhub.yml`）、
  差分守卫的执行环境。~~状态层唯一写者~~ —— R1d 后状态写链迁到 Rust
  （`src/agent/oneline.rs` 折账 + `core/state.rs` 落盘），Python 写链退休
  （§9「2026-08-31 更新」）。
- 推荐路径：**分五阶段**推进，核心动作是「预算规则迁进 core crate」（cost.rs
  先例），Tauri 与 Python 从此共用一份预算评估；SwiftBar 在 Tauri 覆盖全部
  能力后退役（保留为降级通道）。
- 每阶段都有验收标准（§9），其中 Phase 1 可在 1 次迭代内落地。

## 1. 背景与目标

`contrib/xbar/agent-vitals.5m.sh`（v1.2.0）是唯一的菜单栏消费者：每 5 分钟被
SwiftBar 触发一次，读 `~/.agent-vitals/state/` 下四个文件渲染托盘文案，并在
每次 tick 顺带跑 `dsh_autosync.py`（会话结束检测，v1.2.0 引入，见脚本头注释）。

`src-tauri/`（Tauri 2，独立 workspace）是 2026-08 新建的替代者
（`docs/PET_REQUIREMENTS.md` ADR-010 定前端栈；任务 #83 已落地「消费 cost
fold」）。当前能力：托盘菜单（今日/本月/预算）+ 弹出面板（逐日列表、预算条），
数据经 `overview.rs` → `agent_vitals_core::cost` 折叠，**计价不长第四份拷贝**
（`src-tauri/src/overview.rs:1-11`）。

**目标**：Tauri 完整接管 SwiftBar 的能力（显示、调度、副作用），SwiftBar 退役；
过程中不破坏三条铁律（§5）。

## 2. 现状盘点：代码资产

| 资产 | 内容 | 角色 | 证据 |
|---|---|---|---|
| core crate | 13 模块（cost/behavior/trajectory/usage/evidence/codex_*/…） | **纯规则单一事实源** | `crates/agent-vitals-core/src/lib.rs:9-22` |
| Rust 二进制 | `src/skills/*` + `src/agent/*` + `main.rs` | 二进制通道（npm/brew/cargo） | — |
| Python 包 | `scripts/agent_vitals/`（skills/ agent/ adapters/ + cli.py） | **ClawHub 技能形态 + 状态层唯一写者** | `package-clawhub.yml:39-43` |
| wasm crate | `audit_events` / `token_by_model` | DSH 审计 tab 的规则载体 | — |
| dsh-client | harness 投影 + client 渲染 + verify 脚本 | DSH 审计 tab | — |
| src-tauri | `overview.rs` + `lib.rs` + `ui/` | **新菜单栏消费者** | — |
| contrib/xbar | `agent-vitals.5m.sh` | **旧菜单栏消费者** | — |
| 状态层 | `~/.agent-vitals/state/` 8 个文件 | 跨消费者共享数据 | §3 |

## 3. 架构总览

```
                 ┌──────────────────────────────────────────────┐
                 │          数据源（只读，执行环境）                   │
                 │  DSH 会话 JSONL · Codex 会话 JSONL             │
                 │  ~/.claude.json · 磁盘 skills 目录             │
                 └──────────────┬───────────────────────────────┘
                                │
                 ┌──────────────▼───────────────────────────────┐
                 │        计算层：双实现字节锁步                   │
                 │  Python 包（skills/ agent/ adapters/ cli.py） │
                 │      ↕ 差分守卫（golden 15 + both() 111）      │
                 │  Rust core crate（13 模块，单一事实源）         │
                 │      ├ cost.rs（priced_day/month_cost/…）     │
                 │      ├ behavior.rs + trajectory.rs（SV 规则）  │
                 │      └ usage.rs / evidence.rs / codex_*.rs     │
                 │  Rust 二进制（薄封装）· wasm crate             │
                 └──────┬──────────────┬──────────────┬──────────┘
                        │              │              │
                 写状态层          audit_events    token_by_model
                        │              │              │
     ┌──────────────────▼──┐   ┌───────▼────────┐   ┌▼──────────────┐
     │ ~/.agent-vitals/state│   │ dsh-client     │   │ CLI（双实现）  │
     │ oneline/today/month │   │ harness 投影→wasm │   │ doctor/oneline│
     │ alert★/sessions/    │   │ client 渲染     │   │ codex-session │
     │ calendar/dsh_auto…  │   └────────────────┘   └───────────────┘
     └────┬────────────┬───┘
          │            │
 ┌────────▼───┐  ┌─────▼───────────────────────────────────┐
 │ SwiftBar   │  │ Tauri 菜单栏（src-tauri，独立 workspace）  │
 │（旧，5min  │  │  overview.rs → core::cost → 托盘+面板      │
 │ tick +     │  │  ✗ 无 tick  ✗ 绕开 alert.json             │
 │ autosync） │  │  ✗ 无会话/审计列表                          │
 └────────────┘  └──────────────────────────────────────────┘

── 已实现 ──    ★ 预算权威（只在 Python budget.py，见 §5）
```

状态层文件与读写关系（真机实测 2026-08-30，`~/.agent-vitals/state/`）：

| 文件 | 写者 | 读者 |
|---|---|---|
| oneline.json | Python `oneline`（`state.py::write_oneline`） | SwiftBar |
| today.json / month.json(+archive) | Python `oneline`（`merge_today`/`merge_month`/`rotate_today`） | SwiftBar、Tauri |
| **alert.json** | Python `oneline` 调 `budget.evaluate()` 落盘（`cli.py:1251-1256`） | SwiftBar（**唯一权威**）、**Tauri 未读** |
| sessions.jsonl | Python `oneline`（`append_session_history`） | SwiftBar |
| calendar.html | Python `oneline` 渲染 | SwiftBar 打开 |
| dsh_autosync.json | Python `dsh_autosync.py` | dsh_autosync 自身 |

**写者只有一个**（Python oneline + autosync），消费者只读——这是设计铁律，迁移
不得制造第二个写者。

## 4. 能力差距对照（SwiftBar 13 项 vs Tauri 现状）

| # | SwiftBar 能力 | Tauri 现状 | 状态 |
|---|---|---|---|
| 1 | 预算状态 emoji 前缀（🚨over/⚠️warn/🔕snoozed/💰ok）+ 今日成本 | 托盘三项纯文本，无状态前缀 | ⚠️ 部分 |
| 2 | **alert.json 唯一权威**（level/ratio/日预算/snooze/reasons） | **完全不读 alert.json**，自算 remaining% | ❌ 架构缺口 |
| 3 | 本次会话 cost+peak+duration+model（oneline.json） | 无 | ❌ |
| 4 | 今日累计 / **日预算**（effective_daily_budget ¥30 + 百分比） | 无日预算维度 | ❌ |
| 5 | 告警静默提示（🔕 至 …） | 无 | ❌ |
| 6 | budget disabled 提示 | 「预算：未配置」（语义不同） | ⚠️ |
| 7 | 最近 5 次审计列表（sessions.jsonl） | 无 | ❌ |
| 8 | 打开日历（calendar.html） | 面板有逐日列表 | ⚠️ 够用 |
| 9 | **每 5 分钟自动 tick** | 只有手动「刷新」 | ❌ 核心缺口 |
| 10 | **每次 tick 跑 dsh_autosync.py** | 无 | ❌ |
| 11 | 打开 state 目录 | 无 | ❌ |
| 12 | 打开 docs | 无 | ❌ |
| 13 | 空态诚实、降级不抛错 | 空态诚实 ✅ | ✅ |

## 5. 硬约束（为什么不能简单搬运）

1. **计算在 core，不落第四份拷贝**：CLAUDE.md「Cost accounting」节。Tauri 已
   遵守（overview.rs 只做 I/O + 组装）；**预算评估目前违反**——Tauri 在
   `main.rs:31-41` 自己算 remaining%，与 `budget.py` 的规则无关。
2. **alert.json 是预算颜色与百分比的唯一权威**（SwiftBar 脚本头注释 :17 钉死，
   v1.1.0 的 bug 史）：budget.evaluate() 含 adaptive floor / snooze /
   peak_share_max / 日预算，菜单栏不得重算。**Tauri 当前正是重算的**——与
   v1.1.0 之前 SwiftBar 的 bug 同构（`docs/COST_CALENDAR_BUDGET.md` 有同案）。
3. **状态层单一写者**（§3 表）：迁移不得新增写者；Tauri 若接管 tick 仍只读。
4. **Python 与 Rust 永久平行，无 exit point**（CLAUDE.md「Dual implementation,
   differential guard」）：Python 是 ClawHub 技能形态（`package-clawhub.yml`）、
   状态写者、差分守卫执行环境。**结论：Python 包不移出**；但「规则」必须向 core
   收敛（§7）。
5. **空态诚实**：缺数据显示「—」/「尚无」，不摆全零冒充零花费
   （`src-tauri/README.md`「空态是诚实的」）。

## 6. 问题诊断：Tauri 侧三个缺陷

| 缺陷 | 症状 | 根因 |
|---|---|---|
| D1 无自动刷新 | 菜单栏数字停在启动时，会话花费不更新 | `src-tauri/src/lib.rs` 只有手动 refresh；无定时器（grep 无 interval/sleep） |
| D2 预算显示绕开权威 | 缺日预算、adaptive floor、snooze、level 颜色；未来 budget 规则变更菜单栏静默漂移 | `main.rs:31-41` 自算 remaining%+超支；不读 alert.json；`overview.rs` 只读 monthly_cny 裸值（:107-131） |
| D3 缺 SwiftBar 的会话/审计/调度能力 | 本次会话、最近审计、autosync 全部缺失 | 迁移未完成（#3/#7/#10） |

## 7. Python 包边界：移出？重划？

**结论：不能移出，但边界重划。** 依据（核实于 2026-08-30）：

- ClawHub 打包的就是 Python 包（`package-clawhub.yml:39-43`，冒烟测试
  `python -I scripts/scan.py --version`）；SKILL.md 驱动面全为
  `python3 scripts/scan.py`。技能形态=Python 是发行约束，不是历史包袱。
- 状态层写者 `oneline`/`calendar`/`state`/`budget` 四子命令**仅 Python 有**
  （Rust 二进制无对应实现）；alert.json 唯一产出者是 `budget.evaluate()`
  （`cli.py:1251-1256`）。Tauri/SwiftBar 有数可显的前提是 Python 写者活着。
- 差分守卫（golden + both()）本身就是 Python unittest（`tests/`，
  `AGENT_VITALS_BIN` 指向 Rust 二进制做字节对比）——移出即拆掉防腐剂。
- 定价表权威 `scripts/agent_vitals/pricing.json`、日历/会话模板都在 Python 包。

**可重划的边界**：把「规则」从 Python 收进 core——首当其冲是 `budget.evaluate()`
（§8 Phase 2）。Python 退化为「薄入口 + 状态写者 + 发行形态」，Rust 为主实现。

## 8. 方案选型

| 方案 | 做法 | 代价 | 结论 |
|---|---|---|---|
| A 维持现状 | 只给 Tauri 补 tick | 预算权威单点留在 Python，D2 不修 | ✗ |
| **B 分阶段收敛（推荐）** | 预算规则迁 core；Tauri 全量接管 | 一次规则迁移 + 锁步测试 | ✓ |
| C 移出 Python 包 | 状态写者 Rust 化 + ClawHub 改 binary 发行 + 测试重写 | 大工程，与约束 4 直接冲突 | ✗ |

选 B。理由：cost.rs 已有完整先例（定价 2026-08 迁进 core，二进制退成
`pub use` 薄封装，Tauri 直接消费）；预算同构迁移风险可测（golden + both()
锁步）；B 同时服务两个目标——Tauri 吃到正确预算权威，Python 包瘦身。

## 9. 分阶段实施计划

### Phase 0 —— 已就位（2026-08 完成）
overview.rs 数据管道、core::cost 折叠、托盘+面板骨架、空态诚实。验收：现有
单测 + Tauri 构建产物（任务 #83/#84 已过）。

### Phase 1 —— tick + alert.json 权威（推荐先做）
- 后端：`lib.rs` 启动 tokio interval（5 分钟，SwiftBar 同节奏），每次 tick
  重跑 `read_overview` + 重建托盘菜单（复用 `refresh()` 骨架）；tick 期间
  读取 `alert.json`（level/ratio/today_cost/month_cost/effective_daily_budget/
  snoozed_until/reasons），托盘与面板统一显示**权威数值**，不重算百分比。
- 面板：预算区块加日预算行 + snooze 徽标 + level 颜色（复用 SwiftBar 的
  emoji 语义做颜色而非 emoji）。
- 降级：alert.json 缺场 → 显示本次会话成本（同 SwiftBar 退化路径），不臆造。
- 验收：托盘数字 5 分钟内自更新；预算百分比与 `budget show`（同一 alert.json）
  逐字一致；alert.json 缺失时面板诚实降级。**不改 budget 规则，不动 Python。**

### Phase 2 —— budget.evaluate() 迁进 core
- core 新增 `budget.rs`（纯函数 `evaluate_budget(month_cost, today_cost, config)`
  → 与 Python `budget.py::evaluate` 逐字段一致：level/ratio/peak_share/
  snoozed_until/effective_daily_budget/adaptive_floor_applied/reasons…）；
  `budget.py` 退成薄封装；`alert.json` 由 core 规则产出（CLI 两侧同源）。
- 锁步：`both()` 差分覆盖 `budget show --json`；golden 若漂移先确认 diff 意图
  再 `--update`（CLAUDE.md 铁律）。
- 验收：Python/Rust `budget show --json` 字节一致；真机 alert.json 与迁移前
  同语义；Tauri 继续只读 alert.json（此时其权威已来自 core）。

### Phase 3 —— 面板能力补齐
- 面板加「最近审计」区块（sessions.jsonl 尾部 5 条：时间/成本/findings/model，
  SwiftBar 3c 同款）；「本次会话」一行（oneline.json 的 cost/peak/duration/
  model）。
- 验收：真机数据渲染与 SwiftBar 下拉菜单同数值；sessions.jsonl 缺场显示
  「尚无审计」。

### Phase 4 —— dsh_autosync 调度（先决策后实施）
- 选项：① bundle 内嵌 `dsh_autosync.py`，tick 时 `python3` 子进程调用
  （SwiftBar 同款，依赖执行环境 python3+zstandard）；② Rust 重写检测逻辑
  （zstd-rs 解压 + mtime 静止窗口，零 Python 依赖，但 zstd 进 core 引入
  第三方依赖，需评估「被审计技能不得拉第三方」约束是否适用于菜单栏 app）。
- 决策依据：菜单栏 app 不在 ClawHub 分发路径（`src-tauri/` 独立 workspace，
  `package-clawhub.yml` 不打包它），故 ② 不违反供应链约束；倾向 ②。
- 验收：会话结束后 ≤10 分钟内状态数据更新；重复 tick 不重复同步。

### Phase 5 —— SwiftBar 退役判定
- 条件：Phase 1-4 验收全过，Tauri 覆盖 13 项能力表中 ≥11 项（#8 日历保持
  「打开 calendar.html」或面板内嵌逐日列表均可）。
- 动作：`docs/PRODUCT.md` 菜单栏章节改为 Tauri 优先；`install_swiftbar.sh`
  标注 legacy；**不删除** SwiftBar 插件（降级通道，零维护成本）。

### 2026-08-31 更新（R1a–R1d 落地后的状态）

- **Phase 1（tick + alert.json 权威）✅**：`lib.rs::start_refresh_tick` 每
  5 分钟一轮，启动即跑；托盘/面板统一读 `overview.rs::read_budget_alert` 的
  权威字段，不再自算百分比（#97）。
- **Phase 2（budget 迁 core）✅**：`core/state.rs::budget.evaluate` 落盘
  alert.json（#98），CLI 两侧同源。
- **Phase 4（会话结束自同步）✅ 换实现**：原选项 ② 的 Rust 化不必引入独立
  autosync —— R1d 直接把 tick 的发现链换成 **`agent-vitals discover` → spawn
  `oneline`**（#100/#104/#105/#116）：discover 浮出 `.zstd` 会话（目录名即
  id），oneline 多帧解压折账，exactly-once 去重。会话停止增长后下一次 tick
  自然折入，无需 `dsh_autosync.py`。
- **Phase 3（面板最近审计列表）部分 ✅**：`store::sessions_list/read` IPC 已
  在 invoke_handler（面板可读 sessions.jsonl），逐日列表已内嵌。
- **Phase 5（SwiftBar 退役）✅ 判定**：Tauri 已覆盖显示/调度/自同步三条主线，
  真机折入 59 条会话后自更新验证通过；本文标题状态、`contrib/xbar/README.md`、
  `install_swiftbar.sh` 均已标注 Tauri 为主 / SwiftBar legacy。
- **真机运行形态（2026-08-31）**：`agent-vitals` 二进制装到 `~/.local/bin/`
  （PATH 内），app tick 经 `resolve_binary` 找到它；`state takeover rust`
  后写链 owner=rust，真机 59 条 DSH 会话全部折入，month ¥1752.45（预算
  ¥600 → alert `over`）。SwiftBar 已脱离。

### 2026-09-01 更新：SwiftBar 插件实际删除（推翻上面「不删除」的决定）

上面「Phase 5」一节判定"不删除 SwiftBar 插件（降级通道，零维护成本）"——
用户后来判断这条"零维护成本"的前提站不住：`contrib/xbar/`、
`scripts/install_swiftbar.sh` 仍然是要跟着 `state.py`/`state.rs` 字段变化
保持同步的活代码（`agent-vitals.5m.sh` 直接解析 `alert.json`/`oneline.json`
的字段名），"零维护"只是"目前没人主动去维护"，不是"不需要维护"。删除内容：

- `contrib/xbar/`（`agent-vitals.5m.sh` + `README.md`）
- `scripts/install_swiftbar.sh`
- `scripts/dsh_autosync.py`——Phase 4 更新已经说明"无需 dsh_autosync.py"
  （discover→oneline 由 Tauri tick 原生做），它当时没删是因为还有 xbar 这
  一个调用方在用它做 zstd 解压；xbar 删除后，它的另一项职责（多帧 zstd
  解压）也已被 `src/dsh.rs` 内置的 `ruzstd`（R2a §6.3-1）取代，两项职责都
  没有调用方了，一并删除。
- 对应测试：`tests/test_dsh_autosync.py` 整个删除；
  `tests/test_xbar_integration.py` 里真正测 xbar 脚本本身的两个测试类
  （`TestXbarSmokeOutput`/`TestXbarBudgetWiring`）删除，测 `state.py`
  `sessions.jsonl`/`rotate_today` invariant 的两个测试类（与 xbar 无关，
  只是历史上先被 xbar 暴露）保留，改名进
  `tests/test_state_history_rotate.py`。

`docs/PRODUCT.md` §5.8.4、本文件顶部状态行同步更新；`docs/COST_CALENDAR_
BUDGET.md`（原始需求文档）、`docs/R2A_SOURCE_CAPABILITY.md`/`docs/
R2A_CONTRACT_DESIGN.md`（写作时 `dsh_autosync.py` 确实是唯一的 zstd 解压
实现，这个事实描述在写作当时是对的）等历史文档**不做追溯性重写**——它们
记录的是各自当时的真实状态，与本仓库"注释解释为什么之前的实现是错的"的
编辑惯例一致，不为了让旧文档"看起来"一直正确而回改。

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Phase 2 预算规则迁移导致真机数字漂移 | 用户看到的金额变化 | both() 差分 + 真机 alert.json 前后对比（§9 Phase 2 验收）；golden --update 必须先确认 |
| tick 期间文件被 Python oneline 写者并发改写 | 读到半写状态 | 复用 state.py 的 `.lock` 文件约定（真机已有 today.json.lock 等）；读失败即降级为「数据更新中」 |
| alert.json 长期缺场（oneline 未跑） | 预算区空 | Phase 1 降级路径：显示本次会话成本 + 「等预算数据」文案（SwiftBar 同款） |
| dsh_autosync 迁 Rust 后与 Python 版行为分叉 | 会话重复/漏同步 | Phase 4 决策时用真实日志做差分验证（fixtures/dsh + 真机） |
| Tauri 面板 HTML/JS 与 SwiftBar 语义歧义 | 同一份数据两个说法 | 所有金额走 core `format_money` 同 spec 的 `fmt_money`（已实现，`lib.rs:17-22`） |

## 11. Out of scope（明确不做）

- **Tauri Pet**（`docs/PET_REQUIREMENTS.md` ADR-009..014 的宠物形态）——另一条
  产品线，架构可复用（harness-events + Diagnoser），但不在本迁移内。
- 面板内嵌完整日历视图（保留逐日列表；calendar.html 继续由 oneline 产出）。
- 多 harness / 跨执行环境菜单栏聚合。
- `budget.evaluate()` 之外的其他 Python 规则迁 core（如 state 合并逻辑——暂
  无消费者需要）。

## 附：本次核实的事实清单（2026-08-30）

- 真机 alert.json：`level:"ok"`、`effective_daily_budget:30.0`、
  `month_cost:12.79`、`monthly_cny:600.0`、`ratio:null`（今日无数据）、
  `adaptive_floor_applied:false`、`reasons:[…]`。
- `budget.py::evaluate` 产出字段（:409-449）：level/ratio/peak_share/peak_over/
  reasons/snoozed_until/effective_daily_budget/adaptive_floor_applied/today_cost/
  month_cost/monthly_cny。
- state.py 写者（:169-597）：write_oneline/write_alert/rotate_today/merge_today/
  merge_month/append_session_history。
- src-tauri 无定时器（grep interval/sleep/tick 零命中）。
- Python 独有子命令：oneline/calendar/state/budget（Rust 二进制无对应实现）。
