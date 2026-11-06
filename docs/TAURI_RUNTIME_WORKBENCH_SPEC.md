# Tauri Runtime Workbench 规格

> 状态：**讨论稿，待产品/架构确认**（2026-08-30 · Round 1 修订后）
>
> 本文把菜单栏迁移、跨执行环境审计工作台、实时数据和 Python/Rust 边界收敛为一条
> 可实施路线。它不替代既有的规则/证据规格；它定义这些计算结果在常驻客户端如何
> 被获取、更新和呈现。
>
> 本版根据 `reviews/TAURI_RUNTIME_WORKBENCH_SPEC-review.md` Round 1（19 条，
> NEEDS_REVISION）修订：补齐数据产出责任链、把 Python/Rust 边界改为**渐进弱化
> Python 的 RFC**（CLAUDE.md「永久双实现」条款转为待修订项）、把 R3 前置契约提前
> 为 R2a、明确 checkpoint 缓存与权威 state 的写权分界、统一会话身份/去重，并收紧
> IPC/导出/币种/验收矩阵。逐条对照见 §12。
>
> 关联：[MENUBAR_MIGRATION.md](./MENUBAR_MIGRATION.md)、
> [DELIVERY_ARCHITECTURE.md](./DELIVERY_ARCHITECTURE.md)、
> [RUNTIME_EVIDENCE_CONVERGENCE_SPEC.md](./RUNTIME_EVIDENCE_CONVERGENCE_SPEC.md)、
> [VITE_DESIGN_LESSONS.md](./VITE_DESIGN_LESSONS.md)、
> [PET_PREFLIGHT.md](./PET_PREFLIGHT.md)。

---

## 0. 结论

Agent Vitals 的 Tauri 应用应成为一个**常驻的 Agent 健康入口与跨执行环境审计工作台**，
而不是 SwiftBar 菜单的一比一复刻，也不是把现有 HTML 页面塞进一个小浮层。

产品分为三个互补投递面：

```text
状态栏（高频一瞥 / 快速操作）
        ↓
Tauri 主窗口（常驻工作台 / 历史 / 跨执行环境）
        ↓
单文件 HTML（导出 / 分享 / 无客户端降级）
```

Tauri 的 Rust 主进程在第一阶段就是后台：它通过 Tauri IPC 服务 WebView、读取
state 文件并按需运行 Session Monitor。**不引入 Node.js 服务，不开 HTTP 端口，
也不在当前阶段拆独立 daemon。**

**Python 与 Rust 的边界：渐进弱化 Python。** CLAUDE.md 的「永久平行、无 exit
point」条款**已按本规格修订**为「差分门禁下的平行实现，按 §7.1 分档弱化」（见
CLAUDE.md §Dual implementation）——方向是桌面与常驻能力由 Rust 承载，Python
逐步退化为明确范围内的便携兼容层，长期在发行条件成熟后退役 Python 分发形态
（按能力的四态生命周期与能力门见 §7.1）。

- **编排 / IO 层**——Tauri 窗口、IPC、watcher、app 自有 cache、菜单栏渲染、
  Session Monitor 的调度——**全程 Rust-only**，Python 不镜像。这是档 1 就能立即
  做的事，与弱化方向一致。
- **纯规则与公开语义层**——`CanonicalSession`、Coverage、Finding、Cost、budget、
  date/model fold、导出 JSON——在**仍存 Python 实现期间**保持 Python↔Rust 字节锁步；
  wasm/DSH 锁步链（`audit_events`/`token_by_model`）同理。每一档的推进都以
  「先证明 Rust 侧可承担，再删 Python 侧」为门槛，不静默放弃正确性。

Python 不从仓库删除（短期）。它是 ClawHub/OpenClaw 零安装 Skill 的便携运行时、
当前持久 state 的唯一写者与差分守卫执行环境；「逐步弱化」不等于一步删干净——见 §7.1
四态生命周期与能力门转移条件。

---

## 1. 背景与问题

当前已有三类资产：

| 资产 | 已有能力 | 缺口 |
|---|---|---|
| SwiftBar/xbar | 5 分钟 tick、预算摘要、最近审计、打开日历 | 小、静态、依赖 Python 脚本 |
| Tauri demo | 托盘、弹窗、今日/本月/预算、Rust core 计价 | 不自动刷新、未读 alert/oneline、没有会话工作台 |
| DSH client | 执行环境内实时审计 tab、投影、React 审计组件 | 只能运行在 DSH 的 Cordis/Node 执行环境内 |
| 单文件 HTML | Codex 会话审计、日历、可离线打开 | 静态快照，无法自行刷新 |

用户在实际使用中有三个不同频率的场景：

1. **一瞥**：正在跑的 Agent 是否正常、是否接近额度或预算、是否出现重要异常。
2. **决策**：这一次会话为何昂贵、是否有 Finding、下一步要处理什么。
3. **复盘/分享**：比较多个会话或日期，并把报告发给他人或留存。

把三种场景都放进状态栏会拥挤；只保留静态 HTML 又失去常驻价值。本规格定义三层
产品面各自的职责和共享数据边界。

---

## 2. 用户、目标与非目标

### 2.1 用户分层

| 用户 | 高频问题 | 首选入口 |
|---|---|---|
| 日常 Agent 使用者 | 现在是否异常、额度还剩多少 | 状态栏 |
| 重度使用者 / 开发者 | 哪个会话、模型或工具造成消耗/风险 | Tauri 主窗口 |
| 审计/协作者 | 如何复盘或分享一个确定时点 | 单文件 HTML / JSON 导出 |

### 2.2 目标

- 在状态栏中用一个可信主信号表达当前健康状态。
- 让用户从状态栏一跳进入 Codex、DSH 审计和 Token 日历。
- 主窗口可在运行时更新，不要求重新打开 HTML。
- 同一份会话在 DSH、Tauri、HTML 中不出现互相矛盾的 token、费用或 Finding。
- 保留无 Tauri、无二进制安装时的 Python Skill 使用路径。

### 2.3 非目标

- 不在状态栏浮层内复刻完整审计 Dashboard。
- 不在第一阶段重写 `dsh_autosync.py` 或整组 Python state 写者；`budget.evaluate()` 的
  纯规则按 §8 R1b 迁 core（Python 保留 mirror，diff 钉死），不复制出第四份实现。
- 不以文件监听冒充 Codex App Server 的正式实时协议。
- 不为 Tauri 新增 HTTP/Node App Server。
- 不在本规格内实现 Pet、团队云端同步或远程多机管理。
- 本规格是 CLAUDE.md「永久双实现」条款的**修订 RFC**（渐进弱化 Python）；修订本身
  是独立、可审查的变更，不在本规格内静默完成——但不再把它当作不可动的铁律。

---

## 3. 产品信息架构

### 3.1 状态栏：高频入口

状态栏标题只展示**一个主信号**。数据新鲜度与业务健康是两个**正交维度**，
不放在同一条优先级里竞争：

- **health（业务结论）**，固定顺序：
  `严重 Finding > 预算超限 > 配额紧张 > Agent 运行中 > 正常空闲`
- **freshness / availability（可信度前提）**：数据过期或来源未知时，用**全局徽标
  或覆盖主标题**的显式提示，而不是排在第六位的“正常态”。stale 时**不得**显示
  “正常”或“正在运行”；所有业务结论必须带“截至某时”。

示例：`🚨 2 个异常 · 截至 09:41`、`⚠️ 今日 ¥26 / ¥30 · 截至 09:41`、
`⚡ Codex 运行中 · $1.54`、`✓ 今日 ¥6.20`。当 state 5 分钟未更新时主标题降级为
`🕓 数据过期（截至 09:36）`，具体告警进下拉面板。

**freshness 规则**（需在 R1 写成可验收真值表）：阈值（默认 5 分钟）、不同来源
各自的时钟（oneline 的 `generated_at` / alert 的 `generated_at` / sessions 的
末条时间）、以及 snoozed alert 与 stale 同时出现时的组合显示。

状态栏下拉/小面板应提供：

- 当前或最近一次会话：执行环境、模型、时长、token、成本估算、更新时间；
- 健康摘要：严重/警告数量与最高优先级 Finding（同样带“截至”时间）；
- 配额与预算：订阅配额、日/月预算、snooze 和告警原因；
- 最近 3–5 次会话；
- 快捷操作：刷新、打开工作台、打开最近报告、打开日历、打开 state 目录、退出；
- 数据可信度：估算/账单区别、未计价 token、残差、数据过期状态。

状态栏**不承载**完整时间线、全部 Finding 证据、复杂筛选或配置编辑。

### 3.2 Tauri 主窗口：工作台

从状态栏选择“打开 Agent Vitals”后打开独立主窗口，而不是继续扩大菜单栏浮层。
第一版的导航为：

```text
总览
├── 当前状态
├── 会话
│   ├── Codex 审计
│   └── DSH 审计
├── Token 日历
├── Findings
└── 数据源状态（只读）
```

主窗口应支持：

- 按执行环境、日期、模型和会话筛选；
- 从 Finding 跳到对应会话和证据位置；
- 显示数据更新时间、覆盖率与 unavailable；
- 以客户端页面展示实时/近实时数据；
- “在浏览器打开”“导出 HTML/JSON”作为固定出口。

**页面状态矩阵（R1/R2 验收项）**：为总览、会话列表、会话详情、日历、Findings、
数据源状态页分别定义：initial loading、refreshing-with-stale-data、honest empty、
partial coverage、source offline / permission denied、schema mismatch、fatal error
七种状态，每种给出保留数据、文案、CTA（重试 / 打开设置 / 查看来源）与无障碍通知
方式。**“Unavailable 不显示为零”只解决数值，不解决用户下一步做什么。**

“数据源状态”在 R2 是**只读诊断页**：显示根目录、权限、最后成功、schema 版本与
修复指引，不暗示可编辑。若未来要编辑（预算、源路径、刷新频率、脱敏选项），必须
单独里程碑定义 app-owned preferences 与 Python-owned `config.toml`/执行环境配置的边界、
写入 API、锁/原子替换、校验与回滚，不在本规格内暗含。

### 3.3 单文件 HTML：可移植报告

`calendar.html` 与 session HTML 不废弃。它们是：

- 无 Tauri 的降级入口；
- 可归档和分享的静态快照；
- CLI/Python Skill 的产物；
- 客户端故障时的可验证回退。

HTML 不要求自动更新。会话结束或用户点击导出时重新生成；Tauri 内置页面则从
Session Store 获取最新数据。导出文件必须携带 source revision 与
`final / provisional` 标志（见 §13 会话状态机）。

---

## 4. 运行时架构

### 4.1 Tauri IPC 不是 Node/HTTP 服务

```text
Tauri WebView（HTML / React）
       │ invoke / listen
       ▼
Tauri Rust 主进程（命令、状态、监控）
       │
       ├── agent-vitals-core
       ├── state 文件读取
       └── Session Monitor（后续）
```

`invoke("read_session")` 和 `emit("session-updated")` 是进程内桥接；生产应用
不启动 Node.js、Vite 开发服务器或 HTTP API。若主窗口后续使用 React/Vite，Node 只在
开发和构建阶段出现，发布产物仍是静态 JS/CSS 加 Rust 进程。

### 4.2 数据模型与读写权

管线按“单一职责”重画——adapter 只做词汇/schema 转换，**不产出计算**：

```text
SourceReader（执行环境日志 / App Server / DSH 投影 / 落盘会话）
        ↓
HarnessNormalizer（词汇/schema 转换 → NormalizedEvidence 观测账本；不计算、不判 Coverage）
        ↓
agent-vitals-core（唯一纯规则计算：CanonicalSession + cost + coverage + findings）
        ↓
versioned SessionReport（schema_version / engine_version / source_revision）
        ↓
SessionStore（Tauri 内存中的只读查询模型）
   ├── Tauri IPC / events
   ├── HTML 导出
   └── 状态栏摘要
```

**coverage 的归属只有一处**：`Measured / Unmetered / Unavailable` 是 core 规则语义，
adapter 不得直接声明结果——否则 normalizer 会把「读不到」提前翻成 0，再让 core 对
假 0 忠实地算。HarnessNormalizer 只产出**观测账本**：

```text
NormalizedEvidence {
  events,                          # 规范化后的事件
  observed_signals,                # 我实际观察到了哪些原始信号
  unsupported_signals,             # 哪些信号形态不支持（不视为 0）
  usage_shaped_unparsed,           # 带了 token 字段名但没解析成用法的事件
}
```

core 才是把这份账本转为 Measured/Unmetered/Unavailable 及 residual sentinel
（`unaccounted_usage`）的唯一地方。用「无原生 turn 边界但有非零事件计数」的 fixture
断言不会落成 MeasuredZero（对应 `evidence.rs` 的门控语义）。

对 DSH 明确两种合法路径（优先级前者）：
1. **信任**带 `contract_version`/`engine_version` 的 wasm 投影（DSH 原生 live 面）；
2. 读原始事件后用**同一 core** 重算。

**DSH 投影的版本兼容矩阵**：`contract_version`（wire 形态）、`engine_version`（规则
版本）、`pricing_version`（价表版本）各自定义语义与最低/最高支持范围；字段进化规则
为「只增不改，删除需新 major」。不兼容时只能：有原始事件 → 用本地 core 重算；无原始
事件 → 显示 `schema-mismatch / Unavailable`，**不得默认为空或沿用旧语义**。R2a 用
N-1/N/N+1 投影 fixture 与独立升级顺序测试钉住。

**不得**在 adapter / SessionStore / UI 内再计价或再判定 finding——那是“第四份计算”
入口。

约束：

1. `CanonicalSession`、Coverage、Finding、Cost 的语义由 core 契约定义；客户端不重算。
2. Tauri 前端只渲染 Rust 命令返回的数据，不读取任意执行环境路径。
3. **数据产出责任矩阵**（下表）是 R1 的先行契约：Python `oneline` / state 层继续是
   当前持久 state 的唯一写者；Tauri 第一阶段只读，Session Monitor 进入后也不得成为
   第二 state 写者。
4. 所有路径访问在 Rust 侧限定为已注册执行环境根目录，前端不能传入任意本机路径。
5. 金额以不可脱离的 **Money DTO** 表示：`{amount, currency, pricing_basis,
   estimated}`；聚合 API 一律返回 `by_currency` map，**禁止默认跨币种求和**；状态栏
   预算只与同币种预算比较；跨币种筛选显示分组数字与“未汇率换算”注记。
6. 同一次 `oneline` 产生多文件快照，用**可提交 generation** 而不是共享 id：
   共享 `snapshot_id` 能检出新旧混用，但 writer 在替换第三个文件时崩溃，磁盘上就
   只剩混合 generation，重启后“最后有效”已丢失。协议改为：先在临时名/子目录写全部
   文件并各自计算 hash，最后**原子替换一个 `current-snapshot.json` manifest/指针**
   （列出各文件 hash）；读者只读 manifest 指向且 hash 完整的 generation，忽略未提交
   临时代，崩溃重启后回到最后完整快照，可清理孤儿临时代。为 SwiftBar/旧 CLI 定义
   双读兼容期，并测试每个文件写入点崩溃、重启、清理孤儿后仍能回到最后完整快照。
   若暂不改 schema，至少采用 read-before/read-after 的 fingerprint 稳定性检查——
   但这只证明“读取期间文件没变”，不证明它们来自同一次产出，不能替代 manifest。

**数据产出责任矩阵**：

| 文件 | 唯一写者 | 触发者 | 频率 | Tauri 角色 |
|---|---|---|---|---|
| oneline.json / today.json / month.json(+archive) / alert.json / sessions.jsonl / calendar.html | Python `oneline`（state.py / budget.py / cli.py） | 外部调度（SwiftBar / 用户 / R1 起可由 Tauri tick 子进程调度） | 每 tick / 每次调用 | 只读 |
| dsh_autosync.json | Python `dsh_autosync.py` | 外部调度 | 每 tick | 只读 |
| Tauri app cache（cursor / checkpoint / index） | **Tauri 自有** | Tauri 内部 | 增量 | 可删除，非权威 |

**状态写链 Rust 化是「弱化 Python」能力门 G1 的前置**（§7.1）：只有 Rust 侧对
`oneline/calendar/state/budget` 四写者有稳定实现后，本表「唯一写者」列才可迁移；
迁移时仍须保持与 Python 的字节锁步直至 Python 侧对应实现删除。

**R1 的 writer/调度已定稿（决策 13）**：**选 A —— Rust 产出链**。Tauri 不复制规则、
不以子进程回退到 Python 计算，而是按 §8 R1 的子步骤把「生产者」逐段 Rust 化：
R1a 读侧 tick（已完成）→ R1b `budget.evaluate()` 迁 core → R1c Rust 状态写链（字节
一致，diff-guard 钉死）→ R1d tick 切到 Rust 产出、Python 写链退休为 mirror。端到端
验收：**禁用 SwiftBar 后连续运行一个会话，5 分钟内 state 和 UI 都确实变化**——这条
由 Tauri 自身满足，不依赖外部调度者。

**唯一写者接管协议（能力门 G1 前强制）**：文件锁只能防同时写损坏，防不了同一会话
被两个 writer 依次累加两次。接管必须带：

1. **shadow mode**：Rust writer 先在非权威 generation 上重放真实、已填充 state，
   连续多次调用逐文件对比字节；
2. **writer fencing**：权威文件带 `writer_epoch`/`owner` manifest，Python 与 Rust
   **都拒绝**非当前 owner 写入（防迁移期双写）；
3. **原子 cutover**：停写 → 备份 → schema 迁移 → 原子切换 → 启动新 writer；
4. **可测 rollback**：接管失败可回退 Python 且不丢/不重记已由 Rust 写入的证据——
   会话 ledger 保证回滚后不重放已接管记录。

验收必须包含：切换中崩溃、旧 Python CLI 误写（fencing 拒绝）、回滚、跨月回填。
会话重复运行的 exactly-once 语义：R1 的 Rust 生产者按 §4.3 的会话身份/dedup ledger
记账，同一 `session_log` 连续多 tick 不重复累加——用已填充 state + 同一 session
多 tick 的 fixture 断言。

### 4.3 DSH、Codex 与 HTML 的适配边界

| 来源 | Live 最佳路径 | Tauri 第一阶段 | 长期路径 |
|---|---|---|---|
| DSH | 原生 `dsh-client` session projection | 读已落盘 state/会话做 post-hoc | 保持 DSH 原生 live；Tauri 提供历史/跨执行环境视图 |
| Codex | `codex app-server`（尚未实现） | `~/.codex/sessions` 事后/近实时读取 | App Server 作为实时 source，日志为回放降级 |
| 其他 CLI | 各自可验证的运行时源 | 已有日志/状态适配 | 新 adapter 进入同一契约 |
| HTML | 不适用 | 由已知 JSON 生成 | 导出/分享，不承担 live |

因此不能把“监听两个目录”称为完整统一方案：DSH 有执行环境 projection，且其 zstd 日志
并不天然适合简单 offset tail；Codex App Server 才是 Codex 正式 live 路线。

**会话身份、去重与接管（跨来源合约）**：

- 定义不变的 **`SessionKey`** = harness kind + harness-native id + source profile /
  machine namespace（只用执行环境 `session_id` 会在不同执行环境/机器上碰撞，也会让
  App Server 回退 rollout、重连接管时把同一逻辑会话数成两笔成本）。
- **machine namespace 是可重放派生的、持久在 app 自有 config 的随机 UUID**（可备份/
  迁移，默认不导出）：每次安装随机生成会让重装/恢复 cache 后同一日志变新会话；
  直接 hash 用户名/路径会把可识别信息稳定泄漏到导出。重装丢失时明示为「新 profile」，
  不静默重排历史。
- **按 source 的 identity 表**逐个给 native id 字段、规范化、alias join key、缺场
  行为和碰撞处理；alias 只在有可验证 join key（如 `call_id`↔item `id`）时归一，否则
  显示「可能重复」也不按时间/路径猜测合并（对应 Codex 双影子 exec 的教训）。
- **强类型 revision，不复用一个字段**：
  - `SourceFingerprint`：不透明、仅相等比较的源文件指纹；
  - `SessionRevision`：每会话单调，`session-updated`/`read_session`/export 只用它；
  - `StoreRevision`：每 Store 查询快照单调，分页 cursor 绑定它 + filter hash；
  - `SchemaVersion`/`EngineVersion`/`PricingVersion`：语义见 §4.2 兼容矩阵。
  说明重启后 revision 是持久还是换 epoch，并测试「分页期间其他会话更新」不误拒。
- 源优先级与接管状态机：**App Server live 优先，rollout 只用于回放/补洞，不按总量
  盲合并**；DSH projection 与落盘日志必须通过可验证的 alias 关系归一。
- 验收 fixture：断线→回退→重连**无重复**（token/成本不翻倍，事件不逆序覆盖）。

---

## 5. Session Monitor（后续能力）

### 5.1 是否需要独立 daemon

第一阶段**不需要**。菜单栏应用隐藏窗口后仍常驻，Tauri Rust 主进程即可同时承载：

- 状态栏；
- state 文件刷新；
- IPC 命令与事件；
- Session Monitor。

只有满足以下任一条件才评估拆分 `agent-vitals-daemon`：用户退出 Tauri 后仍要监控、
多个独立客户端订阅同一事件流、GUI 崩溃不能影响监控、需要开机无 UI 启动或远程消费。

### 5.2 监控管线

```text
文件事件 / App Server 事件
        ↓
source adapter
        ↓
去重 + cursor/fingerprint + 稳定性判定
        ↓
增量 fold（turn 边界 checkpoint）或幂等全量 fold
        ↓
SessionStore 更新
        ↓
emit("session-updated")
        ↓
状态栏 / 会话页 / 日历局部刷新
```

监控器放在 Tauri app/adaptor 层，**不进入 `agent-vitals-core`**。core 只接收
已规范化的数据并做纯计算。

**checkpoint 只能位于 turn 边界（现有 core 合约）**。CLAUDE.md 明确 `UsageFoldState`
只保证 turn 边界恢复，同一 `(turn, step)` 的 `last` 去重槽不序列化；中途 checkpoint
会重复计费。watcher 的任意文件 append 并不等于 turn 已结束，所以：
- 只在**已验证的 turn 边界**持久 checkpoint；
- 活跃 turn 保留可重放尾部，每次 append 从最后边界重 fold；
- 无法识别边界则全量回退。

若确需中途 checkpoint，必须**先**扩展 checkpoint 序列化覆盖所有去重状态，并在
Python↔Rust 字节差分及 wasm 回放中通过后才改本规格——不能反过来。

**app cache 与权威 state 的写权分界**：
- cursor / checkpoint / index 存 **Tauri 自有、可删除**的 cache 目录（带 schema /
  engine / source-fingerprint 版本），**严禁写入 `~/.agent-vitals/state` 的权威文件**。
- 规定原子写、损坏回退、版本失效、源文件截断/替换时的重建规则。
- R3 验收：**删除 cache 只影响性能，不改变最终字节输出**。

### 5.3 刷新等级

| 等级 | 内容 | 目标频率 | 备注 |
|---|---|---|---|
| 摘要 | 活跃会话、最近 token、最新状态 | 日志变更后约 0.5–2 秒 | 合并事件，避免 UI 抖动 |
| 审计 | Finding、时间线、成本分解 | 2–5 秒或显著变化后 | 计算可被合并/取消 |
| 完结 | 最终 HTML、历史归档、日历 | 明确 run end 或稳定窗口后 | 防重复记账 |
| 兜底 | 目录重扫 | 1–5 分钟 | 修复漏掉的文件事件 |

文件事件只是“可能变化”的提示。实现顺序必须遵守
`VITE_DESIGN_LESSONS.md` 的纪律：先证明
`fold_resume(checkpoint, appended) == fold(all)`，再加 cursor/字节门卫，最后才接 watcher。

**调度 / 背压 / 资源预算**：这些频率在多个活跃会话、大型 Codex rollout 或 DSH
zstd 全量解压时可能同时触发多份重计算。因此：
- 每会话 single-flight、只保留最新 revision；有界 worker pool；指数退避；
- 全量 rescan **不与**同源增量 fold 并发；
- 窗口隐藏 / 电池模式下降频。

**可验收预算（R3 开发前钉死，测量基线 = 本地 M 系 Mac，参考 fixture = 普通
单会话 5MB / 大型 50 会话共 200MB，冷热 cache 各 ≥5 次取 P95）**：

| 指标 | 普通 fixture | 大型 fixture | 隐藏窗口/电池模式 |
|---|---|---|---|
| 闲置 CPU | ≤ 0.2% 单核（空闲近似 0） | 同左 | 同左 |
| 摘要更新 P95 | ≤ 300ms | ≤ 1s | 降频至 30–60s |
| 审计（finding/cost fold）P95 | ≤ 500ms | ≤ 5s | 降频至 60s+ |
| 全量 rescan 上限 | — | ≤ 10s | 不跑 |
| 常驻内存（基线/峰值） | ≤ 120MB / ≤ 200MB | ≤ 200MB / ≤ 400MB | 同左 |
| 降级策略 | 超预算时降频/合并/暂停后台 fold，不只记录指标 | 同左 | 同左 |

### 5.4 Tauri IPC 合约（修订稿）

```text
invoke("read_overview")                                        -> Overview
invoke("list_sessions", filter, cursor)                        -> Page<SessionSummary[]>
invoke("read_session", session_key, revision)                  -> SessionReport
invoke("export_session_html", session_key, expected_revision, options) -> ExportResult
invoke("refresh_sources")                                       -> RefreshResult

listen("overview-updated")               -> OverviewSummary
listen("session-updated")                -> { session_key, revision }   // 只带 key + 单调 revision
listen("monitor-status")                 -> MonitorStatus
```

- 所有 DTO 包 **versioned envelope**：`schema_version`、`store_revision`、
  `generated_at`、`source_statuses`；稳定排序 + **cursor 分页**（会话列表可无界增长，
  一次返回整数组会撑爆 IPC 和 WebView 内存）。
- **类型化错误码**：`not-found` / `permission` / `stale-revision` /
  `schema-mismatch` / `source-unavailable` / `cancelled`——禁止用“空数组/空字符串”
  同时表达“无会话”与“源无权限/协议不兼容”。
- **并发顺序**：事件只携带 key + 单调 revision；前端忽略低于当前 revision 的响应，
  并能取消被新筛选替代的请求（旧请求晚于新请求返回不得覆盖新 UI）。
- **导出不信任前端传入的整份 session**（HTML 可能由被篡改/过期/版本不符的数据生成，
  破坏单一事实源）：改为 `export_session_html(session_key, expected_revision,
  options)`，后端从 SessionStore 取对应**冻结版本**并拒绝 revision 冲突。导出目标
  必须经 Tauri 原生 save dialog，后端校验规范化路径/符号链接；默认启用既有 redact
  管线，确认页列出未脱敏字段、缺失的 cwd/provenance 与“非账单”假设。补充带路径、
  密钥形态文本、无 cwd 和导出失败的验收。
- **导出两态显式定义，不做“默认脱敏”这种无保证承诺**：
  - **`safe-share`（默认）**：字段 allowlist + 结构化递归 redact + 敏感形态扫描
    （key/token/路径），命中敏感形态即阻止或二次确认；为每个导出字段定义
    keep/drop/transform 表；cwd 未知时默认**不能**声称已安全脱敏。
  - **`raw-local`**：明示警告、不默认、不参与分享。
  - 安全写入用 save-dialog 授权后的文件句柄或 no-follow/create-new + 同目录原子
    替换，而不是“先校验路径再重新打开”（校验到打开之间存在替换窗口）。

事件是增量提示；前端收到后按 session key 调命令拉取完整状态，避免把大报告在每次
变更时穿过 IPC。

---

## 6. DSH Client 的复用策略

`dsh-client` 不能整体嵌入 Tauri：

- harness 半份依赖 DSH Node/Cordis/sessionProjection；
- client 入口依赖 DSH 的 module loader、slot 和 `useProjection()`；
- Tauri 使用 `invoke()`，没有 DSH 的 `ConvViewProps`。

但其 React 审计组件、类型、timeline、格式化、i18n 和 export 能力应复用。目标结构：

```text
DSH useProjection ── DshAdapter ───┐
Tauri invoke       ── TauriAdapter ├── AuditReportView（纯展示）
HTML 内联 JSON     ── HtmlAdapter ─┘
```

实施时把现有 `AuditView({ useProjection })` 拆成：

1. `AuditReportView(props: AuditData)`：不认识 DSH、Tauri 或文件路径，只渲染；
2. `DshAuditView`：把投影转换为 `AuditData`；
3. `TauriAuditView`：把 IPC 返回值转换为 `AuditData`；
4. HTML 渲染器：消费相同 JSON 契约，允许视觉实现不同。

主窗口的复杂审计页面可以采用 React/TypeScript；状态栏浮层保持现有轻量 HTML/JS。

**i18n 是新工作台的产品合约，不是“复用旧 i18n.ts 就完事”**：R2b 新增的 tray 文案、
source/error 状态、日期时区、货币格式、复数和无障碍通知不会随旧模块自动完整。R2b
范围须含：首发 locale（至少 zh-CN / en）、locale 选择与回退规则、UTC 事件时间与显示
时区的分离、`Intl` 货币/数字/日期格式、复数与参数化错误消息、ARIA live 翻译；CI
检查语言 key 集合对称与缺键，并对两个 locale 的 loading/empty/error、CNY/USD 和
跨日边界做渲染验收。

---

## 7. Python / Rust 产品边界

### 7.1 决策：渐进弱化 Python（Phased Python Diminishment）

方向已定：**桌面与常驻能力由 Rust 承载；Python 逐步退化为明确范围内的便携兼容层，
长期目标是在发行条件成熟后退役 Python 分发形态。** 本规格即修订 CLAUDE.md
「永久双实现」条款的 RFC；该修订**已落库**（CLAUDE.md §Dual implementation 已改为
「差分门禁下的平行实现，按 §7.1 分档弱化」），不再是不可动的铁律。但弱化是
**分档、带转移条件**的，不是一步删干净：

**每个能力走独立的四态生命周期**，同一时刻不同能力可处于不同状态：

1. **Python authority**：该能力的唯一实现是 Python（现状）。
2. **Rust authority + Python mirror**：规则迁入 Rust core，Python 保留镜像，由
   both()/golden 差分钉死字节一致；**mirror 仍可独立运行**（零安装 Skill 不依赖
   Rust binary）。
3. **Python wrapper over shipped Rust artifact**：Python 只剩薄壳调用已发行的
   Rust binary（ClawHub 已支持声明/校验 binary 依赖后才进入）。
4. **Python entry removed**：分发形态退役，Python 该能力入口删除。

**能力门（按能力，不用预测性 R 编号定义档位）**：

| 能力门 | 覆盖 | 转移条件（未满足不得推进） |
|---|---|---|
| **G1 桌面运行时去 Python** | Tauri 自包含：不依赖 repo checkout / `python3` / `zstandard` | 状态写链（oneline/calendar/state/budget）在 Rust 有稳定实现且与 Python 字节锁步；每迁移一项规则先过 both()/golden + wasm 重建；「唯一写者接管协议」（§4.2）通过 shadow/fencing/cutover/rollback 验收；编排/IO 早已 Rust-only |
| **G2 便携 Python 分发退役** | ClawHub/OpenClaw 零安装 Skill 不再需要 Python 计算 | ClawHub/OpenClaw 支持声明并校验 binary 依赖；G1 完成；§7.2 出口条件全满足；差分守卫改造为**不依赖生产 Python 的独立 oracle**（见下） |

档位是这两个门的时间投影，不是独立编号：**档 1** = 现状 + 规则向 core 收敛
（`budget.evaluate()` 首当其冲，见 MENUBAR_MIGRATION Phase 2 / §8 R1b）；**档 2** =
G1 达成，Python 仅存便携 Skill 入口与写链镜像（四态第 2 态，**不删 mirror**）；
**档 3** = G2 达成，Python 入口删除（四态第 4 态）。

**为什么锁步测试在档 1/2 不撤**：差分守卫（golden + both()）防的是 Python↔Rust
漂移。只要某规则的 Python 实现还存在（四态 1/2），守卫就保留；真正删除该 Python
实现之后（四态 4），对应差分点才移除。wasm/DSH 锁步同理——`audit_events` /
`token_by_model` 由 core 编译、DSH 审计 tab 依赖它，这条链在 G1 前不松动。
**「保留零安装 Python 却删 Python 规则」是矛盾态**：零安装入口还要独立计算，
mirror 就不得删；mirror 要能删，必须先让入口调用已发行 Rust artifact（四态 3）。

**Python 退役后仍需独立 oracle**：差分守卫若整体退役，Rust 会成为自己唯一的判卷
人——写断言的那方与实现是同一个人，防不了共错。保留一套不依赖生产 Python 的独立
基准：签名/审核过的 raw fixtures + 非当前 Rust 运行时现场生成的 byte goldens +
JSON Schema/语义不变量 + 历史 Python 最终版本的只读参考输出；规则变更必须人工确认
oracle diff，并加反例/变异测试。可以不在用户机器跑 Python，但不能让 Rust 自证。

**编排/IO 层全程 Rust-only**（Tauri 窗口、IPC、watcher、app 自有 cache、菜单栏
渲染、Session Monitor 调度）——Python 从不镜像，这是档 1 就能立即做的事，也是
「弱化」里最先落地、风险最低的部分。

### 7.2 档 3 出口条件：何时才可退役 Python 分发形态

以下条件全部满足前，不考虑删除 Python 分发形态（即档 3 / 能力门 G2 的转移条件，
比档 1/2 严）：

1. Rust binary 能在目标 macOS/Linux/Windows 架构可靠安装和升级；
2. ClawHub/OpenClaw 支持声明并校验 binary 依赖；
3. Skill 的零安装/离线使用体验不退化；
4. state 写入、预算、导出与迁移已在 Rust 有稳定实现（且仍与 Python 字节锁步）；
5. 发布产物而非 checkout 能完成跨执行环境端到端验证；
6. **artifact provenance**——一个审计供应链的工具，其 binary 供应链需要比普通
   CLI 更强的保证：每 OS/arch 受支持矩阵、不可变版本 pin、发行签名/校验和、SBOM/
   构建 provenance、下载前验证、离线缓存/手动安装路径、升级失败回滚与最低/最高
   兼容版本；在取消 Python 零安装路径前，用发布产物在断网、签名错误、部分下载、
   旧架构和回滚场景做端到端验收；
7. 差分守卫已改造为**不依赖生产 Python 的独立 oracle**（§7.1：签名 fixtures +
   非现场 byte goldens + JSON Schema + 历史 Python 参考输出），且规则变更走人工
   oracle diff。

建议先在仓库内将 Python 提升为清晰的 `packages/agent-vitals-python/` 子项目；仍与
Rust core、Tauri、fixtures、contracts 同仓，以避免多仓协议漂移。

---

## 8. 分阶段路线与验收

阶段顺序按“**先契约、后 UI**”重排：SessionStore 与版本化 IPC 是工作台的前置，
不再放在 R3 之后。原 R0–R6 编号与本版的映射见 §12 表格。

### R0：现有 Tauri demo（已完成）

- 托盘 + 轻量面板；
- Rust core 计价；
- `read_overview` IPC；
- 基础 state 读取和空态。

### R1：可靠状态栏（下一步）

> **平台**：R1–R4 均为 **macOS-only**（状态栏、隐藏窗口常驻、主屏定位是 macOS 语义）；
> Windows/Linux UI 是独立里程碑，不在本版范围。§7.2 的“三平台”只指 Rust CLI binary。

范围（writer/调度已定稿为 §4.2 决策 13 的 **A：Rust 产出链**，子步骤）：

- **R1a（已完成）**：5 分钟 tick + 手动刷新；读取 `alert.json` 作为预算状态唯一权威
  （level/ratio/日预算/snooze/reasons，**只读不重算百分比**）；`oneline.json` 作为
  alert 缺场的最近会话降级；显示日/月预算、snooze、最近更新时间与数据过期
  （freshness 徽标，§3.1）；alert 缺场诚实降级，不推测预算百分比。
- **R1b**：`budget.evaluate()` 的纯规则迁入 core（`budget.rs`），Python 侧保留
  mirror，`budget show --json` 走 both() 差分钉死字节一致（四态第 2 态）。
- **R1c**：Rust 状态写链（`oneline/today/month(+archive)/alert/sessions.jsonl/
  calendar.html`）按 §4.2 唯一写者接管协议实现，diff-guard 钉死与 Python 字节一致。
- **R1d**：tick 切到 Rust 产出，Python 写链退休为 mirror；「唯一写者接管协议」验收
  （shadow / fencing / cutover / rollback）通过。
- 打开主窗口、日历、最近报告、state 目录；
- 保留最后一次可解析快照（§4.2 约束 6 的 manifest），读失败显示“数据更新中”，不显示
  假零。

验收：

- Tauri 与 `budget show` 对同一 `alert.json` 的 level/ratio/金额语义一致；
- **禁用 SwiftBar 后连续运行一个会话，5 分钟内 state 和 UI 都确实变化**——由 Tauri
  自身满足，不依赖外部调度者；
- **exactly-once**：同一 `session_log` 连续多 tick，`month/today/history` 不重复累加
  （已填充 state + 多 tick fixture 断言）；
- 接管期旧 Python CLI 误写被 writer fencing 拒绝；切换中崩溃可回退且不丢/不重记；
- alert/oneline 缺场不会崩溃或自行推测预算百分比；
- 数据过期（stale）时主标题**不显示“正常/运行中”**，业务结论带“截至”时间；
- 页面状态矩阵（loading / stale-refresh / honest-empty / partial / offline /
  schema-mismatch / fatal）各态文案与 CTA 符合 §3.2；
- state 写入并发时不出现损坏 JSON 或假 ¥0；
- 现有 SwiftBar 的核心“看状态”能力在 Tauri 可用。

### R2a：最小可查询 SessionStore + 版本化契约（由原 R3 前置）

> 这是 R2b 的前置。先立数据来源、查询模型与版本化 IPC，再谈 UI。

范围：

- **initial population 子阶段**：R2a 不能让 Store 只装 fixture——R3 才引入发现就太晚。
  按 source 给 capability 表：每个源的根目录发现、支持格式、是否全量读、无权限/损坏
  行为、输出 coverage 与资源上限；`list_sessions`/`read_session` 首次就能被真实数据
  填充（Codex `~/.codex/sessions` 根扫描、DSH 历史发现、zstd 降级）。R3 只加
  watcher/增量调度，不再首次引入数据发现。
- `SessionStore` 查询模型（内存只读 + 可删除的 app cache，写权分界见 §5.2）；
- source adapter 接口与**会话身份/去重（§4.3 SessionKey + 强类型 revision）**；
- versioned `SessionReport` / DTO envelope（§5.4）；
- IPC `list_sessions`（分页）、`read_session`、类型化错误码；
- checkpoint/cursor/fingerprint（**仅 turn 边界**）；
- 冻结 fixture：同一 raw fixture 分别经 Python、Rust core/CLI、wasm+DSH 投影生成
  报告，对 token buckets、cost、coverage 三态、findings、residuals 做字节或逐字段
  对账（§8 全局门禁矩阵）；
- 断线→回退→重连无重复 fixture。

验收：

- 重启 Tauri 不重复累加 token 或成本；
- 同一 append 重放幂等；
- cursor 失效时安全回退全量 fold；
- 删除 cache 只影响性能，不改变最终字节输出；
- 跨来源同一逻辑会话不被数成两笔成本；
- 隔离的仿真 HOME 中用 Codex + DSH **真实格式语料**重建索引后，重启能从空 cache
  得到稳定、相同的会话列表（initial population 验收）。

### R2b：工作台与可移植报告接入（原 R2）

范围：

- 主窗口会话列表、Codex 审计入口、DSH 历史入口、Token 日历；
- 复用或抽取 `AuditReportView`；
- 打开 HTML / 导出 HTML / 导出 JSON（save dialog + redact + 冻结版本）；
- “数据源状态”只读页；
- 明确静态报告与客户端实时页的差异。

验收：

- 从状态栏到指定会话不超过两次点击；
- Tauri、DSH UI、HTML **消费同一 versioned DTO** 做渲染断言，主 KPI、Finding 数、
  token 与成本一致；
- 未计价、残差、Unavailable 在任一界面都不被显示为零；
- **Token 日历轴与会话轴对账**：同一已填充 state 上，
  `token_by_date_model`（日历）与 `token_by_model`（会话）按币种/模型相等，差异只能
  落入明示的 untimed/unaccounted 桶；`month.json` 只含当月，历史走
  `month-archive.json`，覆盖不全的日子标 `partial` 不按精确计价。覆盖跨月、回填与
  partial `by_model` 的既有缺陷场景（§12 引用缺陷）。

### R3：近实时来源（原 R4）

范围：

- Codex 文件来源的受控监控；
- DSH post-hoc 来源；
- `SessionMonitor` 与周期性 rescan；
- **会话状态机**：`Discovered → Active → Quiescent → Finalized → Reopened/Error`，
  每个 source adapter 指明什么证据触发转移；稳定窗口可配置/可测，且**只决定调度、
  不写入纯 fold 输出**；
- **背压 / 降频 / 资源预算**（§5.3）；
- 状态栏/主窗口 `session-updated` 热更新。

验收：

- 日志变更后摘要在目标延迟（P95）内更新；
- 文件事件丢失后 rescan 可恢复；
- DSH zstd / 非 append-only 来源不使用未经证明的 offset tail；
- monitor 不写入用户执行环境配置，不制造第二个 state 写者；
- “安静后又 append”与“结束事件重复”不重复记账；
- 压力 fixture 下闲置 CPU / P95 延迟 / 峰值内存达到 §5.3 预算。

### R4：Codex App Server（独立决策门，原 R5）

范围：

- 调研并实现 `codex app-server` source；
- stdio 进程生命周期、重连、协议版本、权限与降级；
- 将 `item/*`、`turn/*` 等事件适配到公共契约。

验收：

- 活跃 Codex 会话的状态、token、turn 在 Tauri 中更新；
- App Server 不可用时干净降级到 rollout 回放（**不重复记账**，§4.3 接管状态机）；
- 不把 App Server 的私有字段污染 `CanonicalSession`。

### R5：桌面运行时去 Python 依赖（能力门 G1，原 R6）

仅在 R1–R4 稳定且档 2 锁步转移完成后评估。目标是 Tauri bundle 自包含，不依赖
repo checkout、`python3` 或 `zstandard`；对应 §7.1 能力门 **G1**（桌面运行时去
Python）——状态写链 Rust 化（R1b–R1d 完成）+ 唯一写者接管协议验收 + §7.2 出口
条件（不含 G2 的 binary 依赖与分发退役）。**G1 达成不删除 Python Skill 包**
（便携分发退役是独立的能力门 **G2**，等 ClawHub binary 依赖与独立 oracle 到位）。

---

## 9. 风险与护栏

| 风险 | 护栏 |
|---|---|
| 文件事件合并/遗漏 | debounce 仅作体验优化；cursor、字节谓词、幂等 fold、周期 rescan 才是正确性来源 |
| 文件正在原子写入 | Rust 读取失败时保留最后有效快照并重试；不把 advisory lock 当跨语言协议 |
| **多文件快照逻辑不一致**（新 oneline.json + 旧 alert.json 组合成假一致数字） | 共享 `snapshot_id`/`generated_at` 才组合；否则按区块显示各自时间戳与“部分更新”，禁跨快照拼接 |
| DSH zstd 多帧 | 先走执行环境 projection 或全量可信读取；未经测试不得 offset resume |
| 成本口径分裂 | core/公共 JSON 为唯一来源；前端不计价；同一 versioned DTO 喂 Tauri/DSH/HTML，并对冻结 fixture 对账；规则变更 DoD 含 wasm 重建 + 拷贝 + 真实 fixture 验证 |
| **跨来源会话重复 / 成本翻倍** | `SessionKey` + `SourceRevision` + 源优先级/接管状态机；断线→回退→重连无重复 fixture |
| **跨币种混加** | Money DTO 带 currency；聚合返回 `by_currency`；菜单栏预算只与同币种比较 |
| 状态栏信息过载 | 固定为一条主信号 + 摘要；深挖进入主窗口 |
| **数据过期被当成“正常”** | freshness 与 health 正交；stale 全局徽标，业务结论带“截至”时间 |
| Python/Rust 漂移 | 公开契约与关键规则永久字节差分；编排/IO 才可 Rust-only；Python 退役后换成独立 oracle（签名 fixtures + 非现场 goldens + JSON Schema + 历史 Python 参考输出） |
| **状态接管期双写重复记账** | §4.2 唯一写者接管协议：shadow mode 重放 + `writer_epoch`/`owner` fencing + 原子 cutover + 可测 rollback + session ledger |
| **同一 session 多 tick 重复累加** | §4.3 session 身份/dedup ledger；已填充 state + 多 tick exactly-once fixture |
| **旧 DSH 投影与新版 core 并存误判** | §4.2 版本兼容矩阵（contract/engine/pricing 各自语义与 min/max）；不兼容时本地重算或 `schema-mismatch/Unavailable`，不沿用旧语义 |
| 本地隐私暴露 | 前端不接收任意路径权限；导出经原生 save dialog + safe-share/raw-local 两态 + 冻结版本 |

---

## 10. 成功指标

**R1/R2 默认为“仅本地、不上传”**。诊断指标默认只落本机，写明存储路径、保留期、
大小上限，并在 UI 提供查看/清空入口。**“匿名”不能代替方案**——会话时间、source 数、
错误频率与使用路径的组合可以成为指纹，且匿名不意味着不上传。若未来需要遥测，作为
独立决策门：要求明确 opt-in、字段 allowlist、端侧聚合与可审计 payload。

本地指标：

- 状态更新延迟：日志变化到摘要刷新 P95；
- 数据新鲜度：状态栏超过 5 分钟未更新的比例；
- 对账正确性：Tauri / DSH / CLI 在 fixture 上的 KPI 差异数；
- 可用性：JSON 解析失败、source 不可读、monitor 重启次数；
- 使用价值：从状态栏打开工作台、从工作台打开报告、查看 Finding 的次数；
- 性能：常驻内存、CPU、监控目录数量和单次 fold 耗时（对照 §5.3 预算）。

产品验收优先级为：**可信数字 > 数据新鲜 > 深度交互 > 视觉统一**。

---

## 11. 需要确认的决策

本规格建议确认以下决策后再进入 R1：

1. Tauri 第一版定位为“状态栏 + 常驻工作台”，而非 SwiftBar 菜单复刻。
2. `alert.json` 是预算展示权威；R1 的 R1b 把 `budget.evaluate()` 纯规则迁入 core
   （Python 保留 mirror，both() 钉死），不再“R1 不迁 budget 规则”。
3. Tauri 首先只读 state；Session Monitor 进入后也不得擅自成为第二 state 写者。
   数据产出责任矩阵（§4.2）是 R1 先行契约。
4. DSH 原生 tab 保留为 DSH 的最佳 live 面；Tauri 首先做 DSH post-hoc/跨执行环境视图。
5. Codex live 以 App Server 为后续独立项目；文件读取是回放和近实时降级。
6. **渐进弱化 Python**：编排/IO 立即 Rust-only；纯规则按 §7.1 分档迁 core，每档
   「先锁步再删 Python 侧」；档 3（可选退役）以状态写链 Rust 化 + 差分守卫改造 +
   ClawHub binary 依赖支持为出口。**本规格即 CLAUDE.md「永久双实现」条款的修订 RFC。**
7. 本仓库维持 monorepo，Python 先重构为逻辑独立子项目，不拆独立仓库。
8. **状态 = health 与 freshness 正交**；数据过期是全局徽标而非第六种业务状态。
9. **金额不默认跨币种换算**；聚合返回 `by_currency`。
10. **checkpoint 只能位于 turn 边界**；Tauri 的 cursor/checkpoint 存自有可删除
    cache，严禁写 `~/.agent-vitals/state` 权威文件。
11. **导出不信任前端整份 session**；后端按 session key + revision 从 SessionStore
    取冻结版本。
12. **会话身份用 `SessionKey`（harness kind + native id + namespace）**，不用裸
    `session_id`。
13. **R1 的 writer/调度定稿为 A：Rust 产出链**（§4.2 决策 13）——Tauri 不从子进程
    调 Python 计算，而是 R1b/R1c/R1d 逐段 Rust 化生产者；exactly-once 由 §4.3
    session 身份/dedup ledger 保证；唯一写者接管走 shadow/fencing/cutover/rollback。
14. **R1–R4 仅 macOS**；Windows/Linux UI 是独立里程碑；§7.2 三平台只指 Rust CLI
    binary。

---

## 12. Round 1 修订对照

| Codex 问题 | 严重度 | 修订位置 |
|---|---|---|
| 1. R1 只刷新读者，无新鲜 state 产出链 | Critical | §4.2 数据产出责任矩阵 + R1 二选一；R1 端到端验收 |
| 2. “收缩后平行”违反 CLAUDE.md 永久差分锁步硬限 | Critical | **方向修正（用户）**：不撤回，升级为「渐进弱化 Python」RFC——§0/§2.3/§7.1/决策 6 重写；CLAUDE.md「永久双实现」条款**已修订**为分档弱化；锁步在仍有 Python 实现期间保留，每档转移以「先证明 Rust 可承担」为门槛 |
| 3. R2 在 SessionStore 契约前承诺工作台 | Critical | §8 重排为 R2a（契约先行）+ R2b（UI/导出）；§12 映射表 |
| 4. adapter/core/Store 单一职责混淆 | High | §4.2 管线重画为 SourceReader→HarnessNormalizer→core→SessionReport→Store；DSH 两种合法路径 |
| 5. checkpoint 持久化与单一写者无边界 | High | §5.2 app cache 写权分界；R3 验收“删 cache 只影响性能” |
| 6. 增量管线忽略 checkpoint 仅限 turn 边界 | High | §5.2 边界算法；决策 10 |
| 7. 跨来源会话身份/去重/接管缺失 | High | §4.3 SessionKey/SourceRevision/接管状态机；R2a fixture |
| 8. R1 多文件快照逻辑一致性 | High | §4.2 约束 6（snapshot_id / fingerprint）；R1 范围与验收；§9 |
| 9. 数据过期被排最后，旧数据出高置信结论 | High | §3.1 health/freshness 正交；R1 验收；决策 8 |
| 10. 导出 IPC 信任前端整份 session + 无隐私合约 | High | §5.4 导出签名改为 session_key+revision；save dialog/redact；决策 11 |
| 11. 验收矩阵未覆盖 wasm/DSH/TS 执行环境锁步 | High | §8 全局门禁矩阵（同一 raw fixture 走 Python/Rust/wasm+DSH 对账）；§9 DoD |
| 12. Token 日历缺对账合约 | High | §8 R2b 日历轴↔会话轴对账；`list_months`/`read_month`/partial 规则 |
| 13. 会话完结/稳定窗口/导出时机无状态机 | Medium | §8 R3 状态机 Discovered→…→Finalized→Reopened/Error |
| 14. IPC 无版本/分页/类型化错误/并发顺序 | Medium | §5.4 versioned envelope、cursor 分页、错误码、revision 忽略规则 |
| 15. 实时目标未绑大日志成本/背压/资源上限 | Medium | §5.3 背压/降频/预算；R3 验收 |
| 16. 主窗口无异常/加载流程 | Medium | §3.2 页面状态矩阵（七态） |
| 17. “设置/数据来源”暗示可编辑 | Medium | §3.2 改名“数据源状态”并明确只读 |
| 18. 跨执行环境聚合未防币种相加 | Medium | §4.2 约束 5 Money DTO + by_currency；§9；决策 9 |
| 19. “本地、匿名或用户可见”混淆存储与上报 | Low | §10 默认仅本地不上传；未来遥测独立决策门 |

阶段映射（原 → 本版）：R0=R0 · R1=R1 · R2=R2b · R3=R2a（前置）· R4=R3 ·
R5=R4 · R6=R5。

---

## Round 2 修订对照（2026-08-30，评审见 `reviews/TAURI_RUNTIME_WORKBENCH_SPEC-review.md` R2）

| Codex 问题 | 严重度 | 修订位置 |
|---|---|---|
| 1. R1 A/B 生产链未决，B 与验收矛盾 | Critical | §4.2 决策 13 定稿 **A（Rust 产出链）** + exactly-once；§8 R1 拆 R1a–d；§11 决策 13 |
| 2. 档 2「保留零安装 Python 却删 Python 规则」矛盾 | Critical | §7.1 四态生命周期（Python authority → Rust authority+mirror → wrapper → removed）；档 2 不删 mirror |
| 3. 唯一 state 写者接管缺 shadow/fencing/cutover/rollback | Critical | §4.2「唯一写者接管协议」四步；§9 风险行；§8 R1c/R1d 验收 |
| 4. 三档范围与 R 编号冲突 | High | §7.1 改**能力门 G1（桌面去 Python）/ G2（便携分发退役）**，不用预测性 R 编号；§8 R5 对齐 |
| 5. 差分守卫随 Python 退役失去独立 oracle | High | §7.1「Python 退役后仍需独立 oracle」；§7.2 条件 7；§9 风险行 |
| 6. R2a 只定义 adapter 接口，无首次真实数据填充 | High | §8 R2a 加 initial population 子阶段 + per-source capability 表 + 真实语料验收 |
| 7. HarnessNormalizer 与 core 同争 coverage/unmetered 所有权 | High | §4.2 管线改 `NormalizedEvidence { events, observed_signals, unsupported_signals, usage_shaped_unparsed }`；core 独占三态判定 |
| 8. snapshot_id 多文件不构成可恢复原子 generation | High | §4.2 约束 6 改可提交 generation（`current-snapshot.json` manifest + 原子替换 + 崩溃/孤儿清理测试） |
| 9. 「信任带版本的 DSH wasm 投影」无兼容/降级规则 | High | §4.2 版本兼容矩阵（contract/engine/pricing 各 min/max + 字段进化规则 + 不兼容行为）；R2a N±1 fixture |
| 10. SessionKey machine namespace/alias 无可重放派生算法 | High | §4.3 machine namespace = 持久 app-config 随机 UUID；按 source identity 表；alias 无证据显示「可能重复」 |
| 11. SourceRevision/session/store revision 混用 | High | §4.3 强类型 `SourceFingerprint`/`SessionRevision`/`StoreRevision`/`Schema/Engine/PricingVersion` |
| 12. 导出「默认既有 redact」无保证范围 | High | §5.4 safe-share/raw-local 两态 + 每字段 keep/drop/transform 表 + 授权句柄/no-follow 写入 |
| 13. 档 3 只要求可靠安装，无 binary 供应链保证 | High | §7.2 条件 6 artifact provenance（签名/校验和/SBOM/离线/回滚/兼容版本） |
| 14. 性能「预算」是占位符 | Medium | §5.3 数值预算表（闲置 CPU/P95/内存/rescan + 普通/大型 fixture + 降级策略） |
| 15. i18n 当可复用代码非产品合约 | Medium | §6 i18n 合约（locale 选择/回退、UTC vs 显示时区、Intl、复数/ARIA、CI key 对称） |
| 16. 各阶段目标 OS 不明 | Medium | §8 R1「R1–R4 均 macOS-only」；§11 决策 14 |
