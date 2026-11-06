# agent-vitals 跨执行环境诊断引擎 + Pet 表现层 — 需求文档

> 本文档面向我自己。聚焦决策与取舍，跳过背景解释。读者应当熟悉 agent-vitals 现状与 Codex Pet 生态。

> **2026-08-27 修订**：新增 §3.0/§6 的 **Phase 0 前置整备**（2 天）、
> §4.3 的 `UsageSampled` 事件变体、§10.2 的两条守恒律（残差哨兵、跨投影
> 相等），并订正 §8.1 中"复用 `src/cost::cost_report`"这一条 —— 实测它在
> binary crate 里，`src-tauri` 依赖不上。修订依据是同日修复的一个真实
> 缺陷：`compaction/summary` 的 token 从未被计价，根因是"哪些事件带
> usage"这条判断被硬编码在 **12 处**、分四层生效，导致只修最内层完全
> 无效、且折叠层的哨兵报出假阴性。相关提交：`8a8193b`、`5d0b8d5`。

---

## 0. 一句话目标

**核心**：把 agent-vitals 现有的"DSH-centric 诊断能力"扩展成"harness-agnostic 跨执行环境诊断引擎" —— 能监听 DSH / Codex / Claude Code / Gemini 的实时事件，归一化后做问题检测（SV 码 + 异常模式 + 成本/时长折叠）。

**表现层**：在诊断引擎之上，加一个 Tauri Pet app 作为可视化消费者，**让用户养一只跨执行环境的 pet**，pet 的状态由诊断引擎实时驱动。

**Pet 是奖励，不是目标。** 没有诊断引擎，pet 只是装饰；有了诊断引擎，pet 是真实的"工作状态活体报告"。

---

## 1. 背景与定位

### 1.1 agent-vitals 当前的真实分层

```
┌──────────────────────────────────────────────────────────┐
│ L1: Skill 静态发现（多 harness）                            │
│   discovery.rs → 6 harness skills 目录扫描                  │
│   claude-code / codex / dsh / openclaw / workbuddy / gemini│
│   子命令：scan / doctor / list / overlap / diff / explain│
├──────────────────────────────────────────────────────────┤
│ L2: Harness 运行时接口（单 harness）                            │
│   harness.rs   → ~/.claude.json（enabled + usage）            │
│   codex.rs  → codex app-server JSON-RPC                   │
├──────────────────────────────────────────────────────────┤
│ L3: 行为事件审计（仅 DSH）                                │
│   dsh.rs          → session.jsonl 解析                    │
│   behavior.rs     → SV601–SV614 规则                      │
│   usage(core)     → token / 模型折叠 ✅ 可复用            │
│   cost.rs(binary) → 价格折叠 ⚠️ 不在 core，见 8.1         │
│   子命令：behavior / skill-audit / duration-audit          │
├──────────────────────────────────────────────────────────┤
│ L4: DSH 浏览器集成（仅 DSH）                              │
│   dsh-client/ → sessionProjections + wasm audit           │
└──────────────────────────────────────────────────────────┘
```

**关键观察**：

- **L1 跨执行环境**：扫描 skills 目录不挑 harness
- **L2-L4 全部 DSH-centric**：历史驱动力（DeepSeek 团队自家项目）
- **"跨执行环境"是表面的**：L1 的局部跨执行环境遮盖了 L2-L4 的 DSH 偏置
- **CLAUDE.md 已埋下伏笔**："menu bar work (Rust-Tauri)" 提示了实时消费者方向

### 1.2 这次要解决的问题

**L3 是 agent-vitals 最有价值的部分**（SV 码审计 + 成本折叠），但被 DSH 锁死了。我们要：

1. **抽取事件层**：让 harness 事件变成 harness-agnostic 流
2. **扩展诊断能力**：SV 码从 DSH 专属变成跨执行环境通用（或按 harness 分别命名）
3. **加长驻进程能力**：当前 CLI 是一次性的，未来要支持 `watch` / 后台守护
4. **多消费者**：诊断引擎输出是统一的，CLI / Tauri Pet / menu bar / IDE 插件都可以消费

### 1.3 Pet 项目在这个上下文里的真实定位

Pet 不是新产品 —— **它是诊断引擎的"可视化前端之一"**，跟 `agent-vitals watch` CLI 是同一层的消费者。

```
诊断引擎（核心）                  消费者层
──────────────                  ────────
harness-agnostic event stream  ──→ agent-vitals watch（CLI）
                              ──→ Tauri Pet（桌面悬浮）
                              ──→ 未来：menu bar / IDE插件 / Webhook
```

**这个区分非常重要**：Pet 项目不能独立做，它必须在诊断引擎先建立之后才有意义。

---

## 2. 用户故事

### 2.1 诊断引擎层（核心）

> 小明同时用 Codex 跑任务、Claude Code 改代码、DSH 跑 agent。他跑 `agent-vitals watch --harness all`，终端持续输出三只 agent 的实时诊断 —— 哪个在跑、哪个等审批、哪个检测到危险命令、token 累计多少。诊断引擎在后台跑，他不必再切到三个 harness 的不同日志去看。

> 小明今天收到一条告警："Claude Code session 检测到 3 次 SV603-like 模式（`rm -rf` 模式）" —— 这条告警来自诊断引擎在 Claude Code transcript 上跑 harness-agnostic 规则，**而不是 DSH 专属规则**。

### 2.2 Pet 层（消费者）

> 小明同时跑三只 agent，桌面悬浮窗上的 boba（小熊猫）在三种状态间切换：Codex 在跑 → `running`，Claude 等审批 → `review`，DSH 失败 → `failed`。boba 的表情真实反映三个 harness 的工作状态。

> 小明本月 token 预算 80% 用完，boba 当天持续 `tired` 状态（自定义）。安装 pet 30 天后，boba 累计 5 个 `happy` 天 + 3 个 `angry` 天 —— 后者来自诊断引擎检测到 9 次 SV603-like 模式。

---

## 3. 范围

**迭代策略：先跑通 DSH PET（端到端验证架构），再复刻到其他 harness。** 每个 Phase 都是"完整端到端 + 真实可用"，不是半成品等下一 harness。

**复刻路径**：DSH Pet 跑通后，**复用 0a 的整套架构**（harness-events crate 抽象、Event enum、Diagnoser、Tauri state machine、symlink 接管），**只新增每个 harness 自己的 JSONL 解析器**。如果哪个 harness 的解析器写不下去（字段对不上、概念不对应），**回到 core/pet/normalize.rs 扩展 Event enum**，但保证 DSH 现有路径 byte-for-byte 不变。

### 3.0 Phase 0 — 前置整备（**2 天**）★ 必须先做

**目标**：清掉三个会让 Phase 0a"做不成/白做"的结构性障碍。全部是在
2026-08 那次真实事故上学到的教训做的预防，不是投机性设计。

| # | 内容 | 工作量 | 不做的后果 |
|---|---|---|---|
| **0-1** | `src/cost.rs` → `crates/agent-vitals-core/src/domain/cost.rs`，根 crate 改 re-export，`include_str!` 路径跟着改 | 半天 | `src-tauri` 依赖不上计价，0a 的"复用 cost"是空话，只能再抄一份 |
| **0-2** | `Event` enum 补 `UsageSampled` + `UsageIdentity`（见 4.3） | 半天 | pet 心情里"预算"那一项无从实现；compaction 的钱在归一化就丢 |
| **0-3** | `harness-events` 的 source 层**调 core 谓词**，残差哨兵下沉到 tail 层 | 1 天 | 每写一个新 harness 解析器就新增一个静默漏算面（0b/0c 各一次） |

**0-1 的额外收益**：CLAUDE.md 记的"cost 计算四方锁步"
（`src/cost.rs` ↔ `cost.py` ↔ `dsh-client TS`）会降成三方 —— wasm 也能
直接用同一份，不必再绕 binary crate。

**0-3 的背景（务必读）**：2026-08 发现 `compaction/summary` 的 token 从未
被计价，根因不是某一处 bug，而是"哪些事件带 usage"这条判断被硬编码在
**12 个地方**（adapter 2 份 + 折叠 2 份 + dsh-client 8 份），且分四层依次
生效。**修最里面那层完全无效** —— 事件在 adapter 就被丢了，折叠层的哨兵
永远看不到它，于是哨兵报出"0 处漏算"这个**假阴性**。

Tauri/harness-events 是**第 13 个消费者**。如果 source 层再写一份自己的
"哪些事件要 tail"，同一个 bug 会以同一个形状复现。

**Phase 0 成功标准**：
1. `cargo test` + `test_cli_matrix.py` 30 条差分在 `cost.rs` 搬迁后全绿
   （byte-for-byte，证明搬迁是纯机械的）
2. `crates/agent-vitals-wasm` 能直接 `use agent_vitals_core::cost`
3. 有一条测试断言 source 层与 core 用的是同一个谓词（不是各写一份）

---

### 3.1 Phase 0a — DSH Pet（**2 周**）★ 第一步

**目标**：DSH 单 harness 的端到端 Pet 跑通。**这一阶段是架构验证 + UX 验证** —— 跑通后才有资格扩到其他 harness。

- `crates/agent-vitals-harness-events/` 新 crate（I/O 边界，独立于 core）
- **只**实现 `sources/dsh.rs`：wrap `core::dsh::read_session_log`，加增量监听
- `crates/agent-vitals-core/src/pet/normalize.rs`：harness-agnostic `Event` enum（先只装 DSH 一个变体）
- `crates/agent-vitals-core/src/pet/diagnose.rs`：复用现有 SV601–SV614（DSH 路径不变）
- `tail-offsets.json` 持久化：DSH session offset 重启续传
- 新子命令：`agent-vitals watch dsh` —— 长驻监听 DSH
- **Pet 表现层**（3.2 全部内容）：Tauri 浮窗、pet.json 渲染、状态机、symlink 接管、持久化
- **不做**：Codex、Claude Code、Gemini

**Phase 0a 成功标准**：
1. `agent-vitals watch dsh` 在真实 DSH session 上输出实时事件
2. Tauri Pet app 启动后，DSH agent 一执行 tool/call，pet 立刻变 `running` 状态
3. SV603 检测到时 pet 变 `failed`，肉眼可观察
4. 关闭 Tauri 再开，offset 续传不丢事件
5. 接管已有 `~/.codex/pets/` 的 pet 包（虽然 DSH pet 包现在没有，但 symlink 逻辑必须测）

### 3.2 Phase 0b — Codex Pet（**2 周**）★ 第二步

**目标**：复用 0a 架构，加 Codex rollout 解析器。**这一步验证 `harness-events` crate 抽象足够通用。**

- `sources/codex.rs`：**从零写** rollout JSONL 解析器
  - 解析 `session_meta` / `turn_context` / `response_item` / `event_msg`
  - 归一化到 `Event` enum（**应与 DSH 路径产生相同结构的 Event**）
- `Event` enum 加 Codex 变体字段（如有 DSH 没有的）
- `Diagnoser` 验证跨 harness 同一规则对 DSH/Codex 同样工作
- Tauri Pet app 加 DSH+Codex 双 harness 并发
- 黄金测试覆盖 Codex rollout fixture

**Phase 0b 成功标准**：
1. Codex CLI 跑任务时，pet 跟着状态切换（与 DSH 一致）
2. DSH + Codex 同时活跃时，pet 状态聚合策略工作正常（最新胜出 + 去抖）
3. 同一逻辑事件（"工具调用 + 失败"）在 DSH 和 Codex 产生**等价 Event**

### 3.3 Phase 0c — Claude Code Pet（**2 周**）★ 第三步

**目标**：复用 0a/0b 架构，加 Claude Code transcript 解析。

- `sources/claude.rs`：**从零写** transcript JSONL 解析器
  - 解析 10 种 hook event（UserPromptSubmit / PreToolUse / PostToolUse / Notification / Stop / SessionStart / ...）
  - 归一化到 `Event` enum
- `Diagnoser` 验证 Claude Code 上 SV 规则也工作
- Tauri Pet app 三 harness 并发
- 黄金测试覆盖 Claude transcript fixture

**Phase 0c 成功标准**：
1. Claude Code 跑任务时 pet 状态正确切换
2. 三 harness 同时活跃时聚合策略不闪动
3. 三个 harness 的同一逻辑事件产生等价 Event（核心抽象验证完成）

### 3.4 Phase 1 — Gemini 补充（**3 天，可选**）

- 用户 onboarding 弹窗
- `~/.gemini/settings.json` 幂等注入 hook
- 卸载 pet 时清理
- 不引入新诊断能力，只补一个无 JSONL 的 harness

### 3.5 Pet 持久化与养成 — P2（Phase 0a 内同步）

- `pet-state.json` 每日 append
- 心情系统（mood = f(SV 数, 预算, 运行时长)）
- 历史查询接口

### 3.6 不做（明确边界）

| 不做 | 原因 |
|---|---|
| ❌ Gemini CLI 在 v1 | 协议未公开，等官方稳定；hook 模式侵入性大 |
| ❌ OpenClaw / WorkBuddy | 协议未公开 |
| ❌ 云端注册表 / 商店 | Petdex 已有 |
| ❌ 多 pet 同养（多窗口） | 复杂度爆炸 |
| ❌ 跨设备同步 | 本地 app |
| ❌ Web 版 | Tauri 桌面是终态 |
| ❌ pet 互动动画（摸头、喂食）| v1.1 后再说 |
| ❌ 自定义 sprite 编辑器 | 用户用 Codex Pet 包 |
| ❌ 复用 dsh-client sessionProjections | 浏览器执行环境专属路径 |

---

## 4. 架构

### 4.1 总图

```
┌────────────────────────────────────────────────────────────────────┐
│                        消费者层（多种）                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ agent-vitals │  │ Tauri Pet    │  │ 未来：         │         │
│  │ watch CLI    │  │ (悬浮窗)      │  │ menu bar      │         │
│  │              │  │              │  │ IDE插件       │         │
│  │              │  │              │  │ Webhook       │         │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘         │
│         │                  │                  │                  │
│         └──────────────────┼──────────────────┘                  │
│                            ▼                                       │
├────────────────────────────────────────────────────────────────┐
│                   诊断引擎（核心）                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ EventBus: tokio::sync::broadcast<Event>              │  │
│  └────────────────────┬───────────────────────────────────┘  │
│                       │                                          │
│  ┌────────────────────▼───────────────────────────────────┐  │
│  │ 诊断器：跨执行环境问题检测                              │  │
│  │  - SV 码扩展（harness-agnostic 命名空间）              │  │
│  │  - 异常模式匹配（危险命令、审批超时、长 hook）│  │
│  │  - 成本/时长折叠（复用现有 cost/duration）      │  │
│  └────────────────────────────────────────────────────────┘  │
│                            ↑ 事件流                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ normalize.rs（core crate）：harness-agnostic Event enum  │  │
│  └────────────────────┬───────────────────────────────────┘  │
│                       │ 归一化                                   │
├────────────────────────────────────────────────────────────────┤
│                   事件源层（I/O）                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ crates/agent-vitals-harness-events/                     │  │
│  │  - tail.rs：notify crate 文件 append 监听           │  │
│  │  - sources/dsh.rs       (wrap core::dsh)              │  │
│  │  - sources/codex.rs     (从零写)                       │  │
│  │  - sources/claude.rs    (从零写)                       │  │
│  └────────────────────────────────────────────────────────┘  │
│                            ↓ 文件系统                            │
│  ~/.dsh/sessions/  ~/.codex/sessions/  ~/.claude/projects/        │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 crates 结构

```
agent-vitals/
├── crates/
│   ├── agent-vitals-core/           # 现有：纯计算（不动结构）
│   │   ├── src/...
│   │   └── pet/                     # ← 新增：诊断引擎核心
│   │       ├── normalize.rs         # harness-agnostic Event enum
│   │       └── diagnose.rs          # 跨执行环境问题检测
│   │
│   ├── agent-vitals-harness-events/    # ← 新增：I/O 边界
│   │   ├── src/
│   │   │   ├── lib.rs               # trait EventSource
│   │   │   ├── tail.rs              # notify 文件监听
│   │   │   ├── sources/
│   │   │   │   ├── dsh.rs           # wrap core::dsh
│   │   │   │   ├── codex.rs         # 从零写
│   │   │   │   └── claude.rs        # 从零写
│   │   │   └── offset_store.rs      # tail-offsets.json
│   │   └── tests/
│   │       ├── fixtures/dsh/*.jsonl
│   │       ├── fixtures/codex/*.jsonl
│   │       └── fixtures/claude/*.jsonl
│   │
│   ├── agent-vitals-wasm/           # 现有：不动
│   └── agent-vitals-tui/            # （可选）TUI 长驻进程
│
├── src/                              # CLI binary：薄 wrapper
│   ├── ...
│   └── watch.rs                      # ← 新增：watch 子命令
│
└── src-tauri/                        # ← 新增：Pet 表现层
    ├── src/
    │   ├── main.rs
    │   ├── commands.rs               # #[tauri::command]
    │   ├── state_machine.rs          # Event → Pet 状态聚合
    │   ├── persistence.rs            # pet-state.json
    │   └── bootstrap.rs              # 接管 symlink
    ├── ui/
    │   ├── index.html
    │   ├── pet-canvas.ts             # sprite 渲染
    │   └── gesture.ts                # 拖动 / 气泡
    └── tauri.conf.json
```

### 4.3 核心抽象

**Event enum（core::pet::normalize）：**

```rust
pub enum Harness { Dsh, Codex, ClaudeCode }

pub enum Event {
    SessionStarted { harness: Harness, session_id: String, ts: Instant },
    ToolCalled { harness: Harness, tool: String, ts: Instant },
    ToolFinished { harness: Harness, tool: String, error: Option<ErrorCode>, ts: Instant },
    ApprovalAsked { harness: Harness, approval_id: String, ts: Instant },
    ApprovalDecided { harness: Harness, approval_id: String, allowed: bool, ts: Instant },
    TurnEnded { harness: Harness, reason: TurnEndReason, ts: Instant },
    CompactionStarted { harness: Harness, ts: Instant },
    CompactionEnded { harness: Harness, ts: Instant },

    /// **用量样本 —— pet 心情里"预算"那一项的唯一来源。**
    ///
    /// 没有这个变体，`mood = f(SV 数, 预算, 运行时长)` 的第二项无从实现，
    /// 用户故事里的"本月 token 预算 80% 用完 → tired"和"token 累计多少"
    /// 也都落空。
    ///
    /// 三个字段是有实测理由的，不是照抄现有结构：
    ///
    /// - `identity`：compaction **不属于任何 turn**（`compaction/start` 里
    ///   `turn: null`，由 `sourceCommandId` 触发），而 usage 去重语义建立在
    ///   `(turn, step)` 上。所以身份必须是两态的，不能只有 `Step`。
    /// - `model` / `provider`：**必须自带，不能沿用"当前激活模型"**。实测
    ///   2026-08-27 那次 compaction 走的是 `deepseek-v4-flash` /
    ///   `deepseek-official`，而会话主体是 pro/shengsuanyun —— 两家价目表
    ///   不同，沿用 active 会按错误单价计费。
    ///
    /// **注意 `CompactionStarted/Ended` 这个切分本身是个陷阱**：真正带
    /// usage 的是夹在中间的 `compaction/summary`（实测
    /// `{inputTokens:462, outputTokens:3520, cacheReadTokens:245760}`）。
    /// 只归一化两个边界事件，这笔钱在归一化那一步就丢了 —— 与 2026-08
    /// 那次"日历显示 0"是同一个形状的错误。
    UsageSampled {
        harness: Harness,
        identity: UsageIdentity,
        buckets: [i64; 4],            // uncached_input / output / cache_read / cache_write
        model: Option<String>,
        provider: Option<String>,
        ts: Instant,
    },
}

/// usage 样本的去重身份。**两态，不是一态。**
pub enum UsageIdentity {
    /// 属于某一轮对话的样本（`assistant/chunk` 先到、`assistant/message`
    /// 后到是同一 step 的两份，后到者替换先到者）。
    Step { turn: i64, step: i64 },
    /// 独立事件，自带唯一 id（compaction 用 `compactionId`）。实测撞见过
    /// 同一次 compaction 被 fork 复制进 4 个会话文件，靠这个 id 去重。
    Standalone(String),
}

pub enum TurnEndReason {
    Completed,
    Error,
    Aborted,
    UserCancel,
}
```

**诊断器接口（core::pet::diagnose）：**

```rust
pub trait Diagnoser {
    /// 喂一个 Event，输出 0..N 个 Finding
    fn feed(&mut self, event: &Event) -> Vec<Finding>;
}

pub struct Finding {
    pub code: DiagnosticCode,    // SV601 / SV603 / new...
    pub harness: Harness,
    pub severity: Severity,
    pub message: String,
    pub ts: Instant,
}
```

**事件源接口（harness-events crate）：**

```rust
#[async_trait]
pub trait EventSource: Send + Sync {
    fn harness(&self) -> Harness;
    /// 从 offset 开始监听，产出 Event 流
    fn tail(&self, from: u64) -> BoxStream<'static, Result<Event, ParseError>>;
}
```

---

## 5. 关键决策（ADR）

### ADR-001：诊断引擎与 Pet 表现层解耦

**决策**：先建诊断引擎，Pet 是后续消费者之一
**理由**：
- 诊断引擎本身就有价值（`agent-vitals watch` 即可独立使用）
- Pet 依赖诊断引擎，不能反过来
- 投资先打核心，可视化后做

### ADR-002：新建 `agent-vitals-harness-events` crate 隔离 I/O

**决策**：事件监听和 JSONL 解析放新 crate
**理由**：
- CLAUDE.md 铁律：`agent-vitals-core` 必须保持"无 I/O"（wasm build 用）
- 文件监听（notify crate）、hook 注入都是 I/O，不能进 core
- 新 crate 是 I/O 边界，core 仍是纯函数

### ADR-003：SV 码扩展策略 —— 通用码 + harness-specific 后缀

**决策**：
- 跨 harness 通用的问题用**通用码**（如 SV601 "高危 shell 命令" 在三个 harness 都适用）
- 仅特定 harness 才有问题用**后缀码**（如 `SV611.DSH` 仅 DSH 有的事件类型）
**理由**：
- 完全独立命名会丢语义（如 DSH 的"工具调用 + 失败"和 Claude Code 的同名事件本质是同一种问题）
- 完全统一命名会丢失 harness 上下文（同一码在不同 harness 含义微妙不同）

### ADR-004：Pull 优先于 Hook

**决策**：DSH / Codex / Claude Code 全用 JSONL tail；Hook 仅作 Gemini 补充
**理由**：
- 零侵入：装 pet 不改用户 `~/.claude/settings.json`
- 卸载干净：删目录，无残留
- JSONL 是 source of truth，数据比 hook 全
**代价**：1-3s 延迟，肉眼无感

### ADR-005：Tauri 而非 Native SDK（petdex 同款）

**决策**：Tauri
**理由**：
- agent-vitals 已是 Rust 栈，零新依赖
- agent-vitals-core 直接 `use`，无需 IPC 序列化
- Tauri 浮窗已被 koi-pond 等生产验证
**代价**：~5MB binary

### ADR-006：单一权威 pet 目录 + symlink 接管

**决策**：`~/.agent-vitals/pets/` 权威，其他 harness 目录全部 symlink
**理由**：
- 单一来源真相，避免状态不一致
- 现有 harness 客户端无需修改（只读不在意 symlink）
- 用户只装一次，UX 简单

### ADR-007：状态聚合先用"最新胜出"

**决策**：Phase 2 先用 last-write-wins + 去抖
**理由**：
- 实现最简，验证基本 UX
- 多 harness 并发场景少见（用户大多数时间只跑一个 agent）
- 升级到"最严重胜出"只需替换聚合函数

### ADR-008：Pet 状态机放 Tauri，不放 core

**决策**：诊断引擎输出 EventBus；Pet 状态聚合在 Tauri 后端
**理由**：
- core 保持"无 UI 关注点"
- 状态聚合涉及多源并发 + IPC，是 Tauri-specific
- core 只提供 `PetState` enum 定义

### ADR-009：Tauri 2（不是 1）

**决策**：Tauri 2
**理由**：
- 新项目没理由用 1（koi-pond / EcoPaste 等参考实现是 1，petdex 不用 Tauri）
- agent-vitals 长期维护，跟新版更省事
- 权限模型差异 1-2 天能上手；系统托盘、浮窗能力两者内置、无差距
**代价**：API 文档覆盖略薄于 1；`cargo tauri init` 生成的工程独立于 workspace
  default-members（preflight §5.3）
**验证**：`cargo tauri --version` 输出 2.x + 最小 hello-world 跑通

### ADR-010：前端栈 = 纯 HTML/CSS/JS（不是框架）

**决策**：前端零框架、零构建链，手写 HTML/CSS/JS
**理由**：
- Pet UI 只渲染一个 sprite + 状态气泡 + 偶尔拖动，框架优势用不上
- 体积最小——对 menu bar app 和 Pet 浮窗都关键（petdex 自己也嫌 React 大）
- 零依赖 = 无额外构建链 = 打包产物干净
**2026-08 修订（TS→JS）**：原定「TypeScript」，但 Tauri 应用侧没有 tsc，而
加一条 `tsc` 构建链恰好违背本条「无额外构建链」的核心理由；前端只渲染
`read_overview` 返回的 JSON，TS 的类型安全在这里不换任何东西。类型边界由
Rust 侧的 `#[derive(Serialize)]` 结构与 JS 侧显式字段对齐（lockstep 测试把
形状钉死）。
**代价**：状态管理靠手写（Pet 状态机本来就在 Tauri 后端，前端只是投影）

### ADR-011：EventBus = `tokio::sync::broadcast(1024)`

**决策**：`broadcast::channel(1024)` + 慢消费者 `RecvError::Lagged` 告警日志
**理由**：
- Tauri 本身基于 tokio runtime，零额外引入
- 多消费者（Pet Tauri、watch CLI、未来 menu bar）天然支持
- 1024 个未消费 Event 占内存可忽略；堆满意味着消费者卡死 1s+，应告警而非丢事件

### ADR-012：去抖窗口默认 500ms

**决策**：默认 500ms，`PET_DEBOUNCE_MS` env var 可调
**理由**：
- 用户肉眼难感知 <500ms 延迟
- 抑制状态"闪动"足够，IPC 频率降一档（100ms 下高频事件 IPC 过多）

### ADR-013：Event 时间戳双字段（`observed_at` + `at`）

**决策**：`observed_at: SystemTime`（挂钟，持久化/跨调用比对）+ `at: Instant`
（单调，去抖/状态机）
**理由**：
- `Instant` 不能持久化为绝对时间；`SystemTime` 不可靠做相对计时
- 两个用途各取所长，避免为持久化硬塞单调时间戳

### ADR-014：tail offset 5s 写盘

**决策**：默认 5s 写盘间隔，`PET_OFFSET_FLUSH_MS` 可调
**理由**：
- 每次 append 立即写盘高频 IO；优雅退出写盘崩溃会丢事件
- 5s 折中：崩溃最多丢 5 秒事件，对 Pet UX 无影响，IO 频率可接受

---

## 6. 实施分阶段

**核心原则：一次只搞一个 harness，每个阶段都是端到端可演示的完整产品。**

```
P0a (2 周): DSH Pet 端到端      → 架构验证 + UX 验证
P0b (2 周): + Codex rollout     → harness-events crate 抽象验证
P0c (2 周): + Claude transcript → Event 归一化三层验证
P1 (3 天):  + Gemini hook       → push 模式补充
```

### Phase 0 — 前置整备（**2 天**）★ 必须先做

- [ ] **0-1** `src/cost.rs` → core（394 行纯函数），根 crate re-export
  - [ ] `include_str!("../scripts/agent_vitals/pricing.json")` 路径改成
        core 相对路径（`../../../scripts/...`），别忘了
        `tests/test_pricing_lockstep.py` 也在校验这份表
  - [ ] `cargo test` + `AGENT_VITALS_BIN=<rust> test_cli_matrix.py` 全绿
        （byte-for-byte 证明是纯搬迁）
  - [ ] `crates/agent-vitals-wasm` 验证能 `use agent_vitals_core::cost`
- [ ] **0-2** `core::pet::normalize` 的 `Event` 补 `UsageSampled` +
      `UsageIdentity`（两态：`Step{turn,step}` / `Standalone(id)`）
- [ ] **0-3** `harness-events` source 层调 core 谓词；残差哨兵下沉到 tail 层
  - [ ] 一条测试断言 source 与 core 用同一谓词（防第 13 份拷贝）

**验收**：三条成功标准（见 3.0）全绿，且现有 645 Python / 143+192 Rust /
15 golden / 30 CLI 差分 / dsh-client 5 套 verify **无一变红**。

---

### Phase 0a — DSH Pet 端到端（**2 周**）★ 第一步

**目标**：从架构到 UX 全跑通 DSH 一条线

**诊断引擎侧**：
- [ ] `crates/agent-vitals-harness-events/` 新 crate
  - [ ] `tail.rs`：notify crate 文件 append 监听，offset-based
  - [ ] `offset_store.rs`：tail-offsets.json 持久化
- [ ] `sources/dsh.rs`：wrap `core::dsh::read_session_log`，加增量
- [ ] `core/pet/normalize.rs`：harness-agnostic Event enum（先只装 DSH 变体）
- [ ] `core/pet/diagnose.rs`：复用现有 SV601–SV614，**不改现有路径**
- [ ] CLI 子命令 `watch dsh` —— 长驻监听 + JSON to stdout

**Pet 表现层**：
- [ ] `src-tauri/` Tauri 工程脚手架
- [ ] 浮窗配置（chromeless transparent 231×250）
- [ ] `commands.rs`：`#[tauri::command]` 暴露
- [ ] `state_machine.rs`：Event → Pet 9 状态聚合 + 去抖（单 harness 版本）
- [ ] `bootstrap.rs`：symlink 接管
- [ ] 前端：sprite 渲染（CSS background-position）+ 状态气泡
- [ ] pet.json schema 验证 + spritesheet 解码
- [ ] `~/.agent-vitals/pets/` 权威目录管理
- [ ] `pet-state.json` 读写（先只记 DSH 数据）

**Phase 0a 成功标准**（硬性）：
1. ✅ `agent-vitals watch dsh` 在真实 DSH session 上输出实时事件流
2. ✅ Tauri Pet app 启动后，DSH agent 一执行 tool/call，pet 立刻变 `running` 状态
3. ✅ SV603 检测到时 pet 变 `failed`，肉眼可观察
4. ✅ 关闭 Tauri 再开，offset 续传不丢事件
5. ✅ 接管已有 pet 包逻辑跑通（即使 DSH pet 包当前没有，symlink 逻辑必须自测）

### Phase 0b — + Codex Pet（**2 周**）★ 第二步

**目标**：复用 0a 架构，扩展到 Codex。**这一步验证抽象是否足够通用。**

- [ ] `sources/codex.rs`：**从零写** rollout JSONL 解析器
  - 解析 `session_meta` / `turn_context` / `response_item` / `event_msg`
  - 归一化到 `Event` enum
- [ ] `Event` enum 加 Codex 变体字段（如有 DSH 没有的）
- [ ] `Diagnoser` 验证同一规则对 DSH/Codex 同样工作
- [ ] Tauri Pet app 加 DSH+Codex 双 harness 并发
- [ ] `state_machine.rs` 升级到多 harness 聚合（最新胜出 + 去抖）
- [ ] `tail-offsets.json` 按 harness 分别记录
- [ ] 黄金测试覆盖 Codex rollout fixture

**Phase 0b 成功标准**：
1. ✅ Codex CLI 跑任务时，pet 状态正确切换（与 DSH 一致）
2. ✅ DSH + Codex 同时活跃时，聚合策略工作正常（500ms 去抖）
3. ✅ 同一逻辑事件（"工具调用 + 失败"）在 DSH 和 Codex 产生**等价 Event**
4. ✅ 黄金测试：3 个 Codex fixture vs DSH 黄金结果对齐

**风险验证点**：如果 Codex rollout 字段 DSH 完全没对应（比如 rollout 有"subagent 嵌套"概念），回到 `core/pet/normalize.rs` 扩展 Event enum；如果扩展后影响 wasm build 或现有 DSH 路径，**优先保证 DSH 现有路径 byte-for-byte 不变**。

### Phase 0c — + Claude Code Pet（**2 周**）★ 第三步

**目标**：复用 0a/0b 架构，扩展到 Claude Code

- [ ] `sources/claude.rs`：**从零写** transcript JSONL 解析器
  - 解析 10 种 hook event
  - 归一化到 `Event` enum
- [ ] `Diagnoser` 验证 Claude Code 上 SV 规则同样工作
- [ ] Tauri Pet app 三 harness 并发
- [ ] 黄金测试覆盖 Claude transcript fixture

**Phase 0c 成功标准**：
1. ✅ Claude Code 跑任务时 pet 状态正确切换
2. ✅ 三 harness 同时活跃时聚合不闪动
3. ✅ 三个 harness 同一逻辑事件产生等价 Event（核心抽象三层验证完成）

### Phase 1 — + Gemini hook（**可选，3 天**）

- [ ] 用户 onboarding 弹窗
- [ ] `~/.gemini/settings.json` 幂等注入 hook
- [ ] 卸载 pet 时清理
- [ ] 不引入新诊断能力，只补一个无 JSONL 的 harness

### Phase 2 — 跨 harness 一次性诊断（**1 周**）

**目标**：现有 `behavior` / `duration-audit` 子命令支持跨 harness

- [ ] `behavior --harness codex <rollout>` 复用诊断器
- [ ] `behavior --harness claude <transcript>` 复用诊断器
- [ ] `duration-audit --harness all` 跨 harness 聚合
- [ ] 黄金测试覆盖三个 harness 的 fixture

### Phase 3 — Pet 养成与心情系统（**1 周**）

- [ ] 心情系统（mood = f(SV 数, 预算, 运行时长)）
- [ ] 历史查询接口
- [ ] 每日 0:00 自动归档

---

## 7. 数据流

### 7.1 诊断引擎流（单向）

```
磁盘事件（JSONL append）
   │
   ▼
harness-events crate（notify + 解析）
   │
   ▼
归一化（core::pet::normalize）
   │
   ▼
EventBus（tokio::broadcast）
   │
   ├─→ Diagnoser → Finding → CLI 输出 / Pet 状态
   ├─→ Cost/Duration 折叠（复用现有 core）
   └─→ 持久化层（pet-state.json）
```

### 7.2 Pet 表现层（订阅诊断引擎）

```
EventBus ──→ Tauri 后端 state_machine
                │
                ├─→ Pet 状态机（9 状态 + 去抖）
                │
                └─→ Tauri IPC emit('pet-state-changed')
                       │
                       └─→ 前端 sprite 切换
```

---

## 8. 与 agent-vitals 现有能力的关系

### 8.1 复用（必须）

| 现有 | 新用途 |
|---|---|
| `core::dsh::parse_session_log` | `sources/dsh.rs` 的基础 |
| `core::behavior::audit` | `diagnose.rs` 的现有规则集 |
| `core::usage::token_by_model` | 跨 harness 成本折叠 |
| `core::usage::token_by_date_model` | 按 (日期, 模型) 折 —— 预算/日历口径 |
| `core::duration::*` | 时长折叠，已在 core，可直接用 |
| ~~`src/cost::cost_report`~~ | ⚠️ **当前复用不了，见下** |
| `src/harness.rs`（~/.claude.json 读取）| harness 检测 |
| `src/discovery.rs`（harness 路径枚举）| 扩展为 EventSource 注册表 |

> **⚠️ `cost_report` 现在在 binary crate 里，`src-tauri` depend 不上。**
>
> 实测：根 `Cargo.toml` 只有 `[[bin]]`、**没有 `[lib]`**，纯 binary crate
> 无法被别的 crate 依赖。而 `src/cost.rs`（394 行，纯函数无 I/O）里
> `const PRICING_JSON: &str = include_str!("../scripts/agent_vitals/pricing.json")`
> 的路径也是相对根 crate 的。
>
> 所以架构图里"成本/时长折叠（复用现有 cost/duration）"这句话目前只有
> **duration 成立**，cost 不成立。修法见 **Phase 0（前置）** —— 半天的
> 机械搬迁，且顺带把 CLAUDE.md 记的"cost 四方锁步"降成三方（wasm 也能
> 直接用同一份，不必再走 binary）。
>
> **这一步必须在 Phase 0a 之前做完**，否则 0a 的"复用 cost"是空话，届时
> 只会临时在 src-tauri 里再抄一份计价 —— 那就是第 N 份拷贝，正是 2026-08
> 那次事故的根因。

### 8.2 不复用（避免污染）

| 现有 | 不复用原因 |
|---|---|
| `dsh-client/src/harness/index.ts::sessionProjections` | DSH 浏览器执行环境专属路径，Pet 走独立路径 |
| `dsh-client` 的 8 个投影 `apply()` 过滤器 | 浏览器专属；但**判据必须共用**，见下 |
| `src/cli.rs::oneline/calendar` | Python 状态层 —— **v1 先不重写**，见下 |
| `scripts/agent_vitals/agent/state.py` | 同上 |

> **⚠️ "Pet 用 Rust 重写状态层"这条要推迟，不是取消。**
>
> M3 状态层（`state.py` 638 行 + `budget.py` 597 行）的不变量**不是
> 输入→输出，而是跨调用**：每个 token 在 `month.json` 里只能记一次、
> 回填的日志要归属它自己的日期、by_model 覆盖不全的天必须标 `partial`
> 而不能当精算报。2026-08 在这一层连续踩了三个 bug，全都**在绿测试下
> 存活**——因为原测试都从空状态目录起步，而真实系统是"从已有状态开始、
> 跑很多次、跨很多天"。
>
> 这些不变量刚刚才被 645 条测试钉稳（含"菜单栏与日历对同一份 month.json
> 必须算出同一个数"的跨投影对账）。**现在重写等于把刚钉稳的东西重新翻
> 一遍，且新实现没有那批跨调用测试保护。**
>
> **v1 的做法**：Tauri 需要"本月已用多少"时，`subprocess` 调
> `agent-vitals budget show --json`（进程启动约 50ms，对菜单栏刷新完全
> 够用）。等这一层真正下沉到 core 时，**测试要跟着一起搬**，而且必须
> 保留"从已填充状态起步"这个前提。

### 8.3 演进（关键）

| 现状 | 应该演进为 |
|---|---|
| `behavior <DSH log>` 专属 | `behavior --harness all` 或 `behavior --harness codex/claude/dsh` |
| `duration-audit <DSH log>` 专属 | 同上 |
| `cost` 是 DSH 数据驱动 | 跨 harness 聚合（harness-agnostic Event → token_by_model）|
| L4 dsh-client 仅 DSH 浏览器 | 未来扩展到其他 harness 的浏览器执行环境 |

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Codex rollout JSONL 格式频繁变更 | Phase 0 解析器失效 | 锁定测试 fixture；版本断言（schema_version 字段）|
| Claude Code transcript 路径 hash 算法变化 | 找不到文件 | 只用 glob 扫描 `~/.claude/projects/*/*.jsonl` |
| 多 harness tail 同时启动时 CPU 峰值 | CLI 卡顿 | 串行启动，每 200ms 一个 |
| symlink 在 Windows 上权限问题 | Pet 接管失败 | 检测 OS + 退化为复制 |
| Tauri 浮窗在 Wayland 上不稳 | Linux 演示失败 | fallback 到 menu bar tray icon |
| Pet dex URL scheme 注册冲突 | 不能用 `petdex://<slug>` | 改用 `agent-vitals-pet://<slug>` |
| 跨 harness SV 码命名冲突 | 现有 DSH SV601 含义被覆盖 | 用 ADR-003 通用码 + 后缀命名空间 |
| core crate 变 I/O 依赖 | wasm build 失效 | 严格 ADR-002，harness-events 独立 crate |
| **新 harness 的新事件类型带 token 但没被解析** | **静默少算钱，无人发现** | **残差哨兵（守恒律 3.5）+ source 层宽进** |
| **source 层自写一份"哪些事件要 tail"** | 修 core 无效，bug 以旧形状复现 | Phase 0-3：source 调 core 谓词 + 测试断言 |
| **Pet 与 CLI 数字不一致** | 用户不知道信哪个 | 跨投影相等测试（守恒律 3.6）|
| **状态层过早重写成 Rust** | 丢掉刚钉稳的跨调用不变量 | v1 走 subprocess，见 8.2 |

---

## 10. 测试策略

**Fixture 按 phase 渐进引入**：Phase 0a 只引入 DSH fixture；Phase 0b 加 Codex；Phase 0c 加 Claude。**每个 phase 验收标准里包含对应的 fixture 抓取要求。**

### 10.1 测试层次

| 层次 | 文件 | 引入时机 | 验证内容 |
|---|---|---|---|
| **单元** | `core/pet/diagnose.rs` | Phase 0a | 诊断规则、harness-agnostic 命名 |
| **Fixture** | `harness-events/tests/fixtures/dsh/*.jsonl` | **Phase 0a（先有）** | DSH 解析器不退化 |
| **Fixture** | `harness-events/tests/fixtures/codex/*.jsonl` | Phase 0b | Codex rollout 解析（**需在本机装 Codex 后跑真实样本抓取**）|
| **Fixture** | `harness-events/tests/fixtures/claude/*.jsonl` | Phase 0c | Claude Code transcript 解析（**需在本机装 Claude Code 后跑真实样本**）|
| **黄金** | `tests/golden/watch_dsh.json` | Phase 0a | watch CLI byte-for-byte |
| **黄金** | `tests/golden/watch_codex.json` | Phase 0b | 同上 |
| **黄金** | `tests/golden/watch_claude.json` | Phase 0c | 同上 |
| **端到端** | `tests/test_pet_takeover.py` | Phase 0a | symlink 创建/清理幂等 |

**Fixture 抓取约束**：
- DSH fixture：项目里已有（`fixtures/dsh/complete.jsonl` 等），Phase 0a 直接复用
- Codex / Claude fixture：必须从**本机真实跑过的 session** 抓取，不允许人工构造；每抓一个 schema_version 锁版本

### 10.2 守恒律（必须测试）

按 phase 验证：

| 守恒律 | 引入 phase |
|---|---|
| 0. `cost.rs` 搬进 core 后 CLI 输出 byte-for-byte 不变 | **Phase 0** |
| 1. DSH 路径与现有实现 byte-for-byte 一致 | **Phase 0a**（黄金测试，**最高优先级**）|
| 2. tail 续传（中断 + 重启）| Phase 0a |
| 3. Pet 状态去抖 | Phase 0a |
| **3.5. 残差哨兵在真实语料上为空** | **Phase 0a**（每个 harness 各测一次）|
| **3.6. Pet 与 CLI 对同一份数据算出同一个数** | **Phase 0a** |
| 4. DSH + Codex 同事件等价 | Phase 0b |
| 5. 三 harness 聚合不闪动 | Phase 0c |
| 6. 三 harness 同逻辑事件等价 | Phase 0c |

**第 3.5 条（残差哨兵）** —— 每个 harness 的 fixture 上断言
`unaccounted_usage == []`。这是"新事件类型出现时不会静默漏算"的唯一
自动化保障：执行环境改格式、新增带 token 的事件类型时，这条直接变红，而不是
等用户在菜单栏上肉眼发现数字不对（2026-08 就是这么发现的）。

> **哨兵有个反直觉的前提：它上面每一层都必须是"宽进"的。** 哨兵最初
> 报"0 处漏算"是**假阴性** —— 它在折叠层，而 adapter 在它上面先把事件
> 丢了。所以 tail/source 层的过滤必须保留任何 **usage 形状**的事件
> （`usage_shaped_tokens`），而计价仍只认显式白名单（`usage_sample`）。
> **宽进、严出 —— 机器负责发现，人负责归类。** 两条路径绝不能合并：
> 纯结构识别会双计，因为同一笔用量会在多个事件里重复出现（这正是
> `(turn, step)` 替换去重存在的理由）。

**第 3.6 条（跨投影相等）** —— Pet 显示的"本月已用 80%"与
`agent-vitals budget show` 的数字，是**同一能力的两个投影**，必须有一条
测试断言它们相等，不能靠"两边各自正确"。

> 2026-08 的教训：日历（按天投影）报 ¥2386，按 session 重算是 ¥1733，
> 两个投影分家了半个月没人发现 —— 因为**没有任何东西强制它们相等**。
> 更糟的是，修复日历那一侧之后，反而把它和菜单栏投影拉开了（¥18.00 vs
> ¥4.50），因为覆盖率校验只加在一处。**单点修复会持续制造新的不一致，
> 直到有一条对账不变量为止。**

**Phase 0a 第一条最重要** —— 一旦新诊断引擎路径让现有 DSH SV 审计输出有任何 byte 级差异，整个 dsh-client 黄金测试也会挂。所以 0a 阶段必须**完全 wrap `core::dsh::parse_session_log`，不改一行现有逻辑**。

---

## 11. 开放问题

1. **SV 码命名空间**：完全保留 DSH 数字命名 vs 引入 harness 前缀（推荐后者）？

2. ~~**watch 长驻进程的进程模型**~~ → **已定：CLI 进程内，不上 launchd**

   理由：launchd 引入"用户看不见的后台进程"这个新的产品面（怎么停、怎么
   看日志、升级时怎么办），而 v1 的收益只是"关掉终端还在跑"。先做 CLI
   进程内长驻；真需要开机自启时，用户自己配 launchd 跑同一个命令即可 ——
   不必为此改架构。

3. ~~**诊断引擎是否独立二进制**~~ → **已定：CLI 子命令 + NDJSON stdout**

   `agent-vitals watch <harness>` 一行一个诊断事件输出到 stdout，**它是诊断
   引擎唯一稳定、可脚本化的出口**。Tauri / menu bar / 未来的 IDE 插件全都
   `spawn` 这个 CLI 读 stdout，**不各自 link core**。

   - **好处是进程隔离**：pet 崩了不影响 watch；watch 崩了 pet 显示"失联"
     而不是跟着崩。
   - 代价是多一次序列化 —— 相对文件 tail 的 I/O 完全可忽略。
   - **更重要的是它约束了 CLI 的演进方向**：CLI 不该增长"能力"，只该增长
     "出口"。每多一个消费者直接 link core，就多一份可能漂移的判断逻辑
     （见 8.2 那条"第 13 份拷贝"的警告）。

4. **Pet 浮窗 vs menu bar 双形态**：v1 只做浮窗，还是一起出？

   补充一条约束：两者若同时出，**必须是同一个 watch 进程的两个订阅者**，
   不能各起一个 tail —— 否则 offset 文件会被两个进程互相覆盖，且两个
   界面会显示不一致的数字（守恒律 3.6）。

5. **harness-agnostic Event 的 EventMsg 字段取舍**：DSH event_msg 字段很多，哪些保留？

   已知的一条硬约束：**带 token 的事件一个都不能省**。DSH 全量扫 38 个
   真实会话，带 token 的只有三种（`assistant/chunk`、`assistant/message`、
   `compaction/summary`），但第三种正是被漏掉半个月的那个。取舍时用
   `usage_shaped_tokens` 扫一遍语料再决定，别凭字段名猜。

---

## 附录 A：术语

| 术语 | 含义 |
|---|---|
| **诊断引擎** | 跨 harness 事件归一化 + 问题检测的核心能力 |
| **Harness** | coding agent 客户端（Codex / Claude Code / DSH / Gemini / OpenClaw / WorkBuddy）|
| **Event** | harness-agnostic 事件（core::pet::normalize 定义）|
| **Finding** | 诊断引擎输出的问题（含 SV 码）|
| **EventBus** | tokio broadcast<Event>，多消费者订阅 |
| **诊断器** | Event → Finding 的纯函数集（可插拔）|
| **Pet** | 一个 sprite 包（pet.json + spritesheet），表现层概念 |
| **9 状态** | pet 的 idle / running / running-right / running-left / waving / jumping / failed / waiting / review |
| **Pull** | tail harness 写入的 JSONL 日志 |
| **Push** | 注册 hook 让 harness 主动调用我们 |
| **权威位置** | `~/.agent-vitals/pets/`，pet 包数据的单一来源 |
| **接管** | 把 pet 包从 harness 自己的目录移到权威位置，用 symlink 兼容 |

## 附录 B：关键文件路径

### 新增（按 phase 渐进引入）

| 路径 | 引入 phase | 用途 |
|---|---|---|
| `crates/agent-vitals-harness-events/src/lib.rs` | 0a | EventSource trait |
| `crates/agent-vitals-harness-events/src/tail.rs` | 0a | notify 文件监听 |
| `crates/agent-vitals-harness-events/src/offset_store.rs` | 0a | tail 续传 |
| `crates/agent-vitals-harness-events/src/sources/dsh.rs` | 0a | DSH 适配（wrap 现有） |
| `crates/agent-vitals-core/src/pet/normalize.rs` | 0a | harness-agnostic Event enum |
| `crates/agent-vitals-core/src/pet/diagnose.rs` | 0a | 诊断器 |
| `src/watch.rs` | 0a | CLI `watch dsh` 子命令 |
| `src-tauri/src/commands.rs` | 0a | Pet Tauri command handlers |
| `src-tauri/src/state_machine.rs` | 0a | Pet 状态聚合（先单 harness）|
| `src-tauri/src/persistence.rs` | 0a | pet-state.json |
| `src-tauri/src/bootstrap.rs` | 0a | symlink 接管 |
| `crates/agent-vitals-harness-events/src/sources/codex.rs` | **0b** | Codex rollout 适配（从零写）|
| `crates/agent-vitals-harness-events/src/sources/claude.rs` | **0c** | Claude Code 适配（从零写）|
| `docs/PET_REQUIREMENTS.md` | 0a | 本文档 |

**Phase 0（前置）涉及的文件**：

| 文件 | 动作 |
|---|---|
| `src/cost.rs` → `crates/agent-vitals-core/src/domain/cost.rs` | 移动（394 行纯函数） |
| `src/cost.rs` | 改为 `pub use agent_vitals_core::cost::*;` |
| `crates/agent-vitals-core/src/lib.rs` | 加 `pub mod cost;` |
| `crates/agent-vitals-core/src/domain/cost.rs` 里的 `include_str!` | 路径改成 core 相对 |
| `tests/test_pricing_lockstep.py` | 确认仍指向同一份 pricing.json |

### 不动（明确边界）

| 路径 | 现状 |
|---|---|
| `crates/agent-vitals-core/src/dsh.rs` | 不动；只被 sources/dsh.rs wrap |
| `crates/agent-vitals-core/src/domain/behavior.rs` | 演进（扩展 SV 命名空间）|
| `dsh-client/src/harness/index.ts` | 不动；Pet 走独立路径 |
| `scripts/agent_vitals/agent/state.py` | 不动；Pet 用 Rust 重写 |
| `src/main.rs` CLI 子命令 | 增量加 `watch`，其他不动 |