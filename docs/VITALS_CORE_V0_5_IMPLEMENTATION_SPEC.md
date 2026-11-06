# Vitals Core v0.5 Implementation Spec

> 状态：**已交付（2026-09-01）**——M0–M4 全部完成，§20 Definition of Done
> 22 项中 21 项打勾；剩 1 项（`AuditContext.coverage` 未按 trajectory 隔离）
> 是记录在案的已知限制，不是缺口，见该条目文字与 §21 止损线判断。
> 目标版本：0.5  
> 适用仓库：当前 `agent-vitals` monorepo  
> 上位设计：《Vitals Core 设计文档 v0.1》  
> 决策主题：从现有 Agent Vitals 中建立可运行的通用行为审计最小闭环

---

## 0. 结论

Vitals Core v0.5 不重写 Agent Vitals，也不立即拆成独立仓库。

本阶段在现有 workspace 内新增通用 crate：

```text
crates/vitals-core
```

并形成以下最小闭环：

```text
Canonical Event
      ↓
Trajectory Reconstruction
      ↓
Detector Evaluation
      ↓
Evidence-backed Finding
      ↓
Deterministic Replay
```

现有 `agent-vitals-core` 保留，逐步转为 Agent 领域层：

```text
vitals-core                 通用机制，不知道 Codex / DSH / Agent
      ↑
agent-vitals-core           Agent 领域模型、规则与兼容层
      ↑
agent-vitals CLI / WASM     适配器、I/O、命令与交付
      ↑
Tauri / dsh-client          展示与执行环境集成
```

v0.5 的成功标准不是“完成所有通用 Runtime 能力”，而是：

> 现有 DSH 与 Codex 的规范化事件，可以不向 `vitals-core` 引入任何执行环境专属字段，经过同一个 Engine 生成可解释、可回放、三态诚实的 Finding；至少三条 Agent 规则迁移后与现有结果保持一致。

---

## 1. 背景

当前项目已经具备一批可复用资产：

- `CanonicalSession` 与执行环境中立 timeline；
- `Signal`、`Coverage`、`CoverageCounts`；
- `Provenance` 与 measured / derived / estimated / lossy 区分；
- `RuleOutcome` 的 findings / measured-zero / unavailable 三态；
- DSH、Codex 的适配与证据抽取；
- 行为规则、轨迹规则、跨会话 Finding 汇总；
- Rust / Python 差分测试、golden、property tests；
- CLI、WASM、Tauri 的消费链路。

但当前 `agent-vitals-core` 仍包含大量领域与产品语义：

```text
codex_evidence
codex_usage
dsh_evidence
skill
budget
cost
subagent
takeover
waste
```

它是 Agent Vitals 的纯计算核心，不是可被 Investment Vitals 等项目直接依赖的通用行为 Runtime。

v0.5 的任务是建立明确的通用边界，并用现有产品验证该边界，而不是一次性完成整个 Vitals Framework。

---

## 2. 用户与场景

### 2.1 直接用户

v0.5 的直接用户是领域包开发者，而不是最终桌面用户。

典型开发者需要完成：

1. 将某种日志或事件源转换为 Canonical Event；
2. 指定事件如何归入 Trajectory；
3. 注册领域 Detector；
4. 得到带 Evidence、Coverage 和 Replay 的 Audit Report；
5. 在 CLI、WASM、桌面应用或其他执行环境中渲染结果。

### 2.2 首个验证场景

```text
DSH / Codex session log
        ↓ Adapter（Agent 层）
Canonical Event
        ↓ Vitals Core
Trajectory + RuleOutcome + Finding + Replay
        ↓ Agent 层兼容投影
现有 CLI / HTML / Tauri 输出
```

### 2.3 非本阶段用户场景

以下场景不作为 v0.5 交付目标：

- 用户在线安装第三方动态插件；
- Core 主动停止或修改 Agent；
- 云端分布式事件流；
- 多租户 SaaS；
- LLM 对完整 session 做语义判断；
- Investment Vitals 正式产品化。

---

## 3. 目标与非目标

### 3.1 必须实现

v0.5 必须提供：

1. 稳定、可序列化的 Canonical Event；
2. 确定性的事件校验、排序与去重；
3. 最小 Trajectory 生命周期：open、append、close；
4. 编译期 Detector 注册；
5. Coverage-aware 的 Detector 前置门控；
6. 三态 RuleOutcome；
7. Evidence-backed Finding；
8. 确定性 Finding fingerprint 与去重；
9. ReplayFrame 与完整 ReplayReport；
10. In-memory、sync-first 的 VitalsEngine；
11. Agent Vitals 兼容桥；
12. 至少三条现有 Agent 规则迁移验证；
13. 现有 CLI / JSON / HTML / Tauri 无破坏性变化。

### 3.2 明确不实现

v0.5 不实现：

```text
通用 StateReducer Runtime
通用 ProgressProvider
Validator DSL
Recommendation Provider
Intervention 执行
Hook Runtime
SemanticJudge / LLM
HistoryProvider
Behavior Profile
动态库 / WASM 插件加载
SQLite / PostgreSQL EventStore
异步 Runtime
分布式流处理
trajectory reopen / merge / split
独立 vitals-core 仓库发布
Detector requirement 的 enhances / min_fidelity 分级（见 §9.1.1）
```

这些能力可以在模型中保留扩展位置，但不得为了未来能力提前引入不可验证的复杂度。

---

## 4. 核心设计原则

### 4.1 Domain-free

`vitals-core` 的公开类型、模块名、测试夹具中不得出现：

```text
Codex
DSH
Agent
Skill
LLM
Tool Call
Token
Budget
Investment
IBKR
```

通用事件可以通过 `kind` 和 `attributes` 承载领域内容，但 Core 不解释这些值。

### 4.2 Evidence-first

任何 Finding 必须至少引用一个 Evidence；没有可定位证据的 Detector 输出视为契约错误。

### 4.3 Coverage-aware

Core 必须保留当前项目已经验证过的事实边界：

```text
有 Finding
实测为零
无法测量
```

`Unavailable` 不得被序列化为零，不得被统计为“健康”。

### 4.4 Provenance-preserving

任何从原始事件派生出的观察值必须保留来源：

```text
Measured
Derived
Estimated
Lossy
```

聚合后不能把混合来源伪装成单一 measured 值。

### 4.5 Deterministic-first

相同的：

```text
输入事件
Core 版本
Detector ID + 版本
配置
```

必须产生字节级可稳定比较的结构化结果。时间、随机数、文件系统和网络不得在 Core 内部隐式读取。

### 4.6 Batch-first, streaming-compatible

v0.5 的主要场景是本地 session log 审计，因此以批处理审计为主。

Engine 可以逐条 `ingest`，但 Finding 的权威结果在 `finalize` 后产生。v0.5 不承诺晚到事件触发实时撤回或重算通知。

### 4.7 Compatibility-first

新 Core 首先通过兼容桥服务现有产品。迁移过程中：

- 现有 JSON key 不删除、不改义；
- 现有规则码不变；
- **Python 侧在 v0.5 期间一行不改**；
- Tauri 与 dsh-client 不直接依赖新 Core API；
- 新模型通过 Agent 层投影为现有输出。

Python 不动这一条不是"暂时没顾上"，而是本次迁移的**外层守卫**。规则迁进
`vitals-core` 之后，golden 差分从「Python == Rust」变成：

```text
Python 旧实现  ==  Rust 新路径（兼容桥投影）
```

这比原来更强：新路径必须同时对上另一门语言的独立实现，而不是对上同语言里
它自己刚重构出来的那份。所以 §14.4 的 parity 有两层——Rust 旧/新逐字节，以及
Python/Rust 新逐字节——**任何一层红都视为切口不成立**（§21）。

Python 的退役按 `docs/TAURI_RUNTIME_WORKBENCH_SPEC.md` §7.1 的能力门推进，
不在 v0.5 范围内，也不因本次迁移提前。

---

## 5. Crate 与依赖方向

### 5.1 Workspace 结构

```text
crates/
├── vitals-core/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs
│   │   ├── id.rs
│   │   ├── event.rs
│   │   ├── signal.rs
│   │   ├── coverage.rs
│   │   ├── provenance.rs
│   │   ├── trajectory.rs
│   │   ├── detector.rs
│   │   ├── evidence.rs
│   │   ├── finding.rs
│   │   ├── replay.rs
│   │   ├── engine.rs
│   │   ├── report.rs
│   │   └── error.rs
│   └── tests/
│       ├── fixtures/
│       ├── golden_replay.rs
│       ├── detector_contract.rs
│       └── properties.rs
│
├── agent-vitals-core/
│   ├── src/
│   │   ├── compatibility/
│   │   │   ├── canonical_session.rs
│   │   │   └── findings.rs
│   │   ├── detectors/
│   │   └── ...现有模块
│   └── Cargo.toml
│
└── agent-vitals-wasm/
```

### 5.2 单向依赖

允许：

```text
agent-vitals-core → vitals-core
agent-vitals-wasm → agent-vitals-core
agent-vitals CLI  → agent-vitals-core
```

禁止：

```text
vitals-core → agent-vitals-core
vitals-core → CLI / Tauri / WASM
vitals-core → 任意执行环境 Adapter
```

### 5.3 依赖预算

v0.5 建议只使用：

```toml
serde
serde_json
thiserror
sha2
```

`sha2` 不是可选项：§10.3 的 Finding fingerprint 与 §11.2 的 input fingerprint
都要求确定性哈希，没有它这两节无法实现。选 `sha2` 而不是别的，是因为现有
binary crate 已经依赖它（根 `Cargo.toml`），不引入新的供应链面。注意
`agent-vitals-core` 目前**没有**这个依赖——它住在 binary 侧，M0 需要为
`vitals-core` 显式加上。

时间使用整数毫秒，ID 使用 newtype string，避免为了基础模型引入异步 Runtime、数据库、UUID 或完整时间库。

`rust-version` 与现有 workspace 保持一致，不低于 Rust 1.74。

---

## 6. Canonical Event

### 6.1 数据结构

```rust
pub struct EventId(pub String);
pub struct ActorId(pub String);
pub struct GoalId(pub String);
pub struct TrajectoryId(pub String);

pub struct CanonicalEvent {
    pub schema_version: u16,
    pub id: EventId,
    pub actor_id: ActorId,
    pub goal_id: Option<GoalId>,
    pub kind: String,
    pub ordinal: u64,
    pub occurred_at_ms: Option<i64>,
    pub attributes: serde_json::Value,
    pub outcome: Option<serde_json::Value>,
    pub source: SourceRef,
    pub provenance: Provenance,
}

pub struct SourceRef {
    pub source_type: String,
    pub source_id: String,
    pub raw_reference: Option<String>,
    pub raw_ordinal: Option<u64>,
}
```

### 6.2 字段纪律

- `id`：在同一来源内稳定、可重建；不能使用本次进程随机值；
- `actor_id`：行为主体；来源无法提供时由 Adapter 生成稳定匿名 ID；
- `kind`：领域定义的事件类型，Core 只做非空校验；
- `ordinal`：Adapter 对当前审计输入分配的严格递增顺序；
- `occurred_at_ms`：允许缺失；缺失不等于 `0`；
- `attributes`：必须为 JSON object；
- `outcome`：事件的可选结果，不强制所有行为都有反馈；
- `raw_reference`：文件路径、blob ID 或其他可追溯引用，允许脱敏；
- `provenance`：描述 Canonical Event 本身如何获得。

### 6.3 排序规则

v0.5 的权威顺序为：

```text
ordinal ASC
→ id ASC 作为病态输入的稳定 tie-breaker
```

`occurred_at_ms` 只用于展示和时间窗口，不参与主排序。原因是现有 DSH/Codex 日志可能缺时间或时间精度不足，而 Adapter 已拥有最可靠的日志顺序。

### 6.4 去重规则

同一 AuditInput 中：

- `EventId` 首次出现保留；
- 再次出现且规范化内容相同：记为 diagnostic，不重复进入轨迹；
- 再次出现但内容不同：返回 `ConflictingDuplicate`，本次审计失败；
- 不允许按时间、kind 或 attributes 猜测去重。

「规范化内容相同」里的**规范化指 §15.3 定义的 canonical JSON 形态**，不是
`serde_json::Value` 的默认相等。两个 attributes 只是键序不同、或同一个整数
一边是 `3` 一边是 `3.0`，必须判为相同——否则重复事件会被误判成
`ConflictingDuplicate`，整次审计失败。去重比较和 §10.3 的 fingerprint 哈希
**共用同一个规范化实现**，不允许各写一份。

### 6.5 校验失败

以下情况为硬错误：

- 空 ID；
- 空 actor；
- 空 kind；
- attributes 不是 object；
- 相同 ID 对应不同内容；
- schema major 不支持。

ordinal 重复但 ID 不同属于 diagnostic；排序继续按 ID 稳定完成。

---

## 7. Signal、Coverage 与 Provenance

### 7.1 Signal

通用 Core 不内置 `ToolCalls` 等 Agent 专属枚举，改为稳定字符串 newtype：

```rust
pub struct SignalId(pub String);
```

命名规范：

```text
<domain>.<signal>
```

示例仅存在于 Agent 领域层：

```text
agent.action
agent.feedback
agent.turn_boundary
agent.approval_decision
agent.sandbox_mode
```

Core 自身只保留少量保留前缀：

```text
vitals.event
vitals.trajectory
vitals.diagnostic
```

**开放字符串的代价必须用构建期校验补回来。** 现有 `Signal` 是闭合的 20 变体
enum（`crates/agent-vitals-core/src/contracts/evidence.rs`），配 `SignalSet(u32)` 位集，
拼写错误是编译错误。换成 `SignalId(String)` 之后，把 `agent.tool_calls` 写成
`agent.toolcalls` 不会报任何错——它只会让该规则**静默变成 Unavailable**，
报告看上去完全正常。这是三态契约最难发现的一种破坏方式。

因此 v0.5 要求：

- Domain 在 builder 阶段注册自己的**信号词表**（`with_signal_vocabulary`）；
- `build()` 时校验每个已注册 Detector 的 `requirement()` 与 `enhances` 中出现的
  每一个 `SignalId` 都在词表内；
- 不在词表内 → 返回 `UnknownSignal { detector_id, signal_id }` **硬错误**，
  与 `DuplicateDetector` 同级，**绝不降级为运行期 Unavailable**；
- `vitals.*` 前缀由 Core 预置，Domain 不得注册。

`SignalId` 本身的格式约束：非空、仅 `[a-z0-9_.]`、至少一个 `.`、不以 `.` 起止。
违反同样是构建期错误。

### 7.2 Provenance

沿用现有语义，改造成可序列化公开模型：

```rust
pub enum Provenance {
    Measured,
    Derived { from: Vec<SignalId> },
    Estimated { estimator: String },
    Lossy { kind: LossKind },
}
```

### 7.3 Coverage

沿用当前 `CoverageCounts`：

```rust
pub struct CoverageCounts {
    pub measured: u64,
    pub derived: u64,
    pub lossy: u64,
    pub unmetered: u64,
}
```

`total == 0` 时 coverage ratio 必须是 `None`，不得输出 `0.0`。

### 7.4 Detector Requirement

为替代当前按规则码硬编码 OR 语义的方式，Core 正式提供：

```rust
pub enum SignalRequirement {
    All(Vec<SignalId>),
    Any(Vec<SignalId>),
}
```

Engine 在调用 Detector 之前完成门控：

- `All`：任一要求无可消费证据则 unavailable；
- `Any`：全部要求无可消费证据才 unavailable；
- requirement 为空：允许执行；
- Detector 不得自行把缺失证据解释成零。

#### 7.4.1 「无可消费证据」的判据：不是 coverage 计数

这一节是整份 spec 里最容易实现错、且错了不会有任何测试变红的地方。

**判据是「该信号在本次输入的事件流里有几个可消费事件」，不是 `CoverageCounts`
的计数是否为零。**

理由是仓库已经付过学费的一次真机事故（见
`crates/agent-vitals-core/src/contracts/evidence.rs` 的 `CanonicalSession::timeline_is_empty`
注释）：Codex 适配器的 `derive_coverage` 会把 `task_started` / `task_complete`
数成非零 measured，而对应的证据通道当时是空的。读计数 → 门控放行 → 检测器在
空证据上空转 → 产出 **MeasuredZero**，而正确答案是 **Unavailable**。这正是
§4.3 禁止的那种「把无法测量伪装成实测为零」。

现有实现靠"五条类型化 timeline 非空"躲开了这个坑。通用化之后 timeline 没了，
Engine 手里只剩计数——**结构上退回了产生该 bug 的那个版本**。所以判据必须被
显式重建：

```rust
/// Domain 声明：哪些 event kind 构成哪条信号的可消费证据。
pub struct SignalVocabulary {
    /// signal_id → 该信号接受的 event kind 集合
    kinds: BTreeMap<SignalId, BTreeSet<String>>,
}

/// Engine 在门控前，对本次输入按 trajectory 计算一次。
pub struct SignalEvidence {
    /// kind 映射到该信号、且通过 §6.5 校验的事件数。
    pub consumable_events: u64,
    /// 仅用于报告，不参与门控。
    pub counts: CoverageCounts,
}
```

门控读 `consumable_events == 0`，**不读 `counts`**。

两者的分工是固定的：

```text
consumable_events   这条信号有没有东西可读        → 决定跑不跑（门控）
CoverageCounts      读到的东西有多可信、漏了多少  → 决定报告怎么说（provenance）
```

`unmetered` 尤其不能参与门控：它的定义就是"已知发生过、但除此之外一无所知"，
把它算进"有证据"会让检测器在读不到内容的事件上空转，再次产出 MeasuredZero。

必须有一条测试直接钉住这个分叉（§16.1）：

> 构造一份输入，使某信号 `CoverageCounts.total() > 0` 而 `consumable_events == 0`，
> 断言该规则输出 `Unavailable` 而不是 `MeasuredZero`，且 Detector 未被调用。

这条测试是现有
`empty_timeline_with_nonzero_coverage_is_unavailable_not_measured_zero`
在通用模型下的对应物。它红了就说明门控接错了轴。

---

## 8. Trajectory

### 8.1 最小模型

```rust
pub enum TrajectoryStatus {
    Open,
    Closed,
}

pub struct Trajectory {
    pub schema_version: u16,
    pub id: TrajectoryId,
    pub actor_id: ActorId,
    pub goal_id: Option<GoalId>,
    pub event_ids: Vec<EventId>,
    pub status: TrajectoryStatus,
    pub started_at_ms: Option<i64>,
    pub ended_at_ms: Option<i64>,
    pub attributes: serde_json::Value,
}
```

### 8.2 Assignment

v0.5 不实现通用 Builder 组合器，只提供一个明确接口：

```rust
pub trait TrajectoryAssigner: Send + Sync {
    fn assign(&self, event: &CanonicalEvent) -> Result<TrajectoryId, VitalsError>;
}
```

内置：

```text
BySourceSession
ByActor
```

Agent 兼容桥默认使用 `BySourceSession`，保证一份现有 session 对应一条 trajectory。

### 8.3 生命周期

v0.5 仅允许：

```text
不存在 → open
open → append
open → close
```

不允许：

```text
closed → append
closed → reopen
merge
split
```

违规操作返回类型化错误，不做隐式修复。

### 8.4 多轨迹

一个 Event 在 v0.5 只能属于一条 Trajectory。多重归属、父子轨迹和跨轨迹引用推迟到后续版本。

#### 8.4.1 turn 坐标不是父子轨迹，是事件属性（提前说明，避免 §14.4 卡住）

一份 session 是一条扁平 trajectory，但 SV612 需要按 turn 分组比较、SV613 需要
锚定"第一个 error turn/end"。这两个坐标现在由适配器的状态机算好、写进
`TimelineEntry` 的 `turn` / `step` / `end_reason_kind` 等字段——不是靠把
turn 建成子 trajectory 得到的。

v0.5 不引入 `parent_id` / 子轨迹（那是留给 v1.0 §12 的），而是要求兼容桥的
输入侧（§14.2）把这些已算好的坐标**原样放进 `CanonicalEvent.attributes`**，
例如：

```json
{ "vitals.turn": 3, "vitals.turn_sig": [...], "vitals.turn_end_reason": "error" }
```

Detector 读 `attributes` 里的这些键做分组/锚定，**不在 Core 内重新实现
turn 状态机**——状态机是"翻译"的产物，不是"规则"的产物，这条纪律从
`agent-vitals-core/src/contracts/evidence.rs` 平移过来，不能因为通用化就丢掉。
`vitals.*` 前缀在这里是**建议**惯例，供 attributes 内部命名去重之用，不是
Core 保留字段（Core 不解释 attributes 内容，见 §4.1）。

---

## 9. Detector 与 RuleOutcome

### 9.1 Detector Trait

```rust
pub trait Detector: Send + Sync {
    fn id(&self) -> &str;
    fn version(&self) -> &str;
    fn requirement(&self) -> SignalRequirement;

    fn detect(
        &self,
        ctx: &AuditContext,
    ) -> Result<Vec<FindingDraft>, VitalsError>;
}
```

`id + version` 是 Replay 确定性的一部分。相同 ID 不允许注册多个版本。

#### 9.1.1 已知缺口：`enhances` 与 `min_fidelity` 不在 v0.5 范围

现有 `RuleSpec`（`agent-vitals-core/src/contracts/evidence.rs`）比 §7.4 的
`SignalRequirement` 多两个维度：

- `enhances`：缺了这个信号规则**仍然跑**，只是可信度降级（不是 `requires`
  那种"缺了就不跑"）——SV610 正是这样：`requires: [SandboxModes]`，
  `enhances: [ApprovalDecisions]`；
- `min_fidelity: Fidelity{Inferred, Partial, Full}`：低于这个档位的 Finding
  只能是"possible"，不能是"confirmed"。

v0.5 **明确不实现**这两项（§3.2 补一条），`SignalRequirement` 只有
`All`/`Any`。这是有意的范围收窄，不是遗漏——`enhances` 需要 Finding 携带
分级 confidence 的展示语义，属于 §3.2 已经排除的 Validator/Recommendation
族问题。

**更新（迁移完成后）**：SV610 最初因为这个缺口被排除在首批之外，但实现到
后续批次时发现——迁移 SV610 根本不需要正式的 `enhances` 机制。`Signal
Requirement::All` 只控制"门控卡哪个信号"，不控制"Detector 能看见哪些事
件"：`AuditContext.events` 是投影阶段就已经放进去的全部数据，不按
`requirement()` 过滤。`Sv610Detector::requirement()` 只声明
`SignalRequirement::All([SIGNAL_SANDBOX_MODES])`（对应旧 `requires`），
`detect()` 内部照样从 `ctx.events` 里读 `agent.approval` kind 的事件（对应
旧 `enhances`）——"门控只卡一个信号，detect 内部多读一个"这件事本来就不需
要额外的类型系统支持。SV610 因此和其余十三条一起完成了迁移；`enhances`/
`min_fidelity` 作为**分级 confidence 展示语义**的正式支持仍然不在 v0.5 范
围，这条缺口本身没有变化，只是它从未真正阻碍过任何一条规则的迁移——见
`crates/agent-vitals-core/src/domain/detectors/sv610.rs` 模块文档。

Finding 的 `confidence: Option<f32>` 字段保留位置，v0.5 里只由 Detector
自行决定填不填，Core 不对它做任何门控或排序语义。

### 9.2 AuditContext

```rust
pub struct AuditContext<'a> {
    pub trajectory: &'a Trajectory,
    pub events: &'a [CanonicalEvent],
    pub coverage: &'a Coverage,
    pub config: &'a serde_json::Value,
}
```

Context 不提供文件系统、网络、时钟或随机数。

### 9.3 RuleOutcome

```rust
pub enum RuleOutcome {
    Findings(Vec<Finding>),
    MeasuredZero,
    Unavailable {
        missing: Vec<SignalId>,
        reason: String,
    },
}
```

语义：

- `Findings`：有足够证据且命中；
- `MeasuredZero`：有足够证据、Detector 已执行、零命中；
- `Unavailable`：Engine 前置门控未通过，Detector 不得执行。

Detector 抛错不属于第四种健康状态，而是 Audit Error / Partial Failure。

### 9.4 注册方式

v0.5 只支持编译期注册：

```rust
VitalsEngine::builder()
    .with_detector(detector)
    .build()
```

“Plugin”在 v0.5 仅表示 crate 内组合，不承诺动态加载、稳定 ABI 或第三方代码隔离。

---

## 10. Evidence 与 Finding

### 10.1 Evidence

```rust
pub struct Evidence {
    pub event_ids: Vec<EventId>,
    pub description: String,
    pub source_refs: Vec<SourceRef>,
    pub attributes: serde_json::Value,
}
```

要求：

- `event_ids` 不能为空；
- 引用的 Event 必须属于当前 Trajectory；
- `description` 是短说明，不承担结构化事实；
- 原始大段日志不得复制进 Evidence；
- SourceRef 应允许消费者定位或请求原文。

### 10.2 Finding

```rust
pub struct Finding {
    pub schema_version: u16,
    pub id: FindingId,
    pub detector_id: String,
    pub detector_version: String,
    pub kind: String,
    pub severity: Severity,
    pub confidence: Option<f32>,
    pub trajectory_id: TrajectoryId,
    pub evidence: Vec<Evidence>,
    pub summary: String,
    pub attributes: serde_json::Value,
    pub fingerprint: String,
}
```

v0.5 不包含 Finding lifecycle。`Acknowledged / Resolved / Ignored` 属于上层产品状态，不属于纯审计结果。

`attributes` 里保留一个键供兼容桥使用：`vitals.source_ordinal`（u64，来自
产生该 Finding 的最后一个 Event 的执行流下标）。这不是 Core 定义的语义
字段——Core 不读它、不基于它做任何判断——只是 §12.4 排序规则与 §14.3 逐字节
兼容之间的接口，理由见 §14.3。

### 10.3 Fingerprint

Fingerprint 必须由以下规范化内容生成：

```text
detector_id
detector_version
kind
trajectory_id
排序后的 evidence.event_ids
影响判定的 detector config
```

不得包含：

```text
生成时间
随机 ID
summary 文案
展示顺序
本机绝对路径
```

同一 fingerprint 在一份 AuditReport 中只保留一条 Finding；occurrence 信息放入 attributes。

---

## 11. Replay

### 11.1 ReplayFrame

```rust
pub struct ReplayFrame {
    pub index: u64,
    /// 引用，不持有整份 Event——见下方内存说明。
    pub event_id: EventId,
    pub trajectory_id: TrajectoryId,
    pub findings_opened: Vec<FindingId>,
    pub diagnostics: Vec<Diagnostic>,
}
```

`ReplayFrame` 存 `EventId` 而不是内嵌整个 `CanonicalEvent`：一帧一份全量拷贝
会让 Replay 的内存占用变成输入的整数倍，直接顶到 §17 的「内存峰值不超过
规范化输入 8 倍」红线。`ReplayReport` 已经在 `AuditReport` 里能查到
`CanonicalEvent` 全量（Engine 保留输入），消费者按 `event_id` 查表即可。

### 11.2 ReplayReport

```rust
pub struct ReplayReport {
    pub schema_version: u16,
    pub engine_version: String,
    pub detector_versions: Vec<DetectorVersion>,
    pub input_fingerprint: InputFingerprint,
    pub frames: Vec<ReplayFrame>,
    pub outcomes: Vec<NamedRuleOutcome>,
    pub findings: Vec<Finding>,
    pub diagnostics: Vec<Diagnostic>,
}

pub struct InputFingerprint {
    pub events_hash: String,
    pub config_hash: String,
    pub detector_versions_hash: String,
    pub engine_version: String,
}
```

`input_fingerprint` 拆成四段而不是一个不透明串：§17 要求「相同数据运行 20
次完全一致」，一旦某次不一致，读者需要知道**是哪一段变了**——事件变了、
config 变了、还是有人 bump 了某个 detector 版本忘了说。单个哈希把这三种
情况压成同一个"不一样"，调试时只能盲猜。合成后的整体指纹（供 §14.3 兼容层
比较用）由四段拼接哈希得到，四段各自仍然可比较。

### 11.3 确定性要求

Replay 结果不得隐式依赖：

- 当前时间；
- 当前工作目录；
- 环境变量；
- 外部价格表；
- 网络；
- 文件系统扫描顺序；
- HashMap 非确定性迭代顺序。

如 Detector 需要配置、价表或阈值，调用方必须将其作为显式 config 输入，并纳入 input fingerprint。

### 11.4 Replay 语义

v0.5 的 Detector 是 trajectory-level。为了避免伪造“实时首次触发点”：

- Engine 在 finalize 后计算权威 Finding；
- `findings_opened` 只有 Detector 能通过 Evidence 明确定位锚点时才写入对应 frame；
- 无明确锚点的 Finding 只出现在 report 顶层；
- 不得默认把所有 Finding 放到最后一帧。

---

## 12. Engine API

### 12.1 Builder

```rust
let mut engine = VitalsEngine::builder()
    .with_assigner(BySourceSession)
    .with_detector(detector)
    .with_config(config)
    .build()?;
```

### 12.2 执行 API

```rust
engine.ingest(event)?;
engine.ingest(event)?;

let report = engine.finalize()?;
```

批处理便捷入口：

```rust
let report = audit(AuditInput {
    events,
    coverage,
    config,
    detectors,
})?;
```

### 12.3 Pipeline

```text
Input
  ↓
Schema Validation
  ↓
ID Deduplication
  ↓
Deterministic Ordering
  ↓
Trajectory Assignment
  ↓
Trajectory Close
  ↓
Signal Requirement Gate
  ↓
Detector Evaluation
  ↓
Finding Validation
  ↓
Fingerprint / Dedup
  ↓
Replay Assembly
  ↓
AuditReport
```

### 12.4 AuditReport

```rust
pub struct AuditReport {
    pub schema_version: u16,
    pub engine_version: String,
    pub input_fingerprint: String,
    pub trajectories: Vec<Trajectory>,
    pub outcomes: Vec<NamedRuleOutcome>,
    pub findings: Vec<Finding>,
    pub replay: ReplayReport,
    pub diagnostics: Vec<Diagnostic>,
}
```

输出数组必须定义稳定顺序：

- trajectories：`id ASC`；
- outcomes：`detector_id ASC`；
- findings：severity rank、trajectory ID、fingerprint；
- evidence event IDs：ordinal、event ID；
- diagnostics：event ordinal、code。

`Finding` 本身不带执行流下标（§10.2 之前的模型没有这个概念），但兼容桥要
在 §14.3 里重建旧输出的字节序，这个排序规则给不出旧序——`severity rank →
trajectory ID → fingerprint` 是 vitals-core 的权威序，不承诺等于任何执行环境
迁移前的展示序。旧序完全由 §10.2 定义的 `attributes["vitals.source_ordinal"]`
在兼容桥内部重建，Core 的排序规则和兼容桥的重排是两件事，互不覆盖。

---

## 13. Error 与 Diagnostic

### 13.1 硬错误

```rust
pub enum VitalsError {
    UnsupportedSchema { found: u16, supported: u16 },
    InvalidEvent { event_id: Option<EventId>, reason: String },
    ConflictingDuplicate { event_id: EventId },
    InvalidTrajectory { trajectory_id: TrajectoryId, reason: String },
    InvalidFinding { detector_id: String, reason: String },
    DuplicateDetector { detector_id: String },
    DetectorFailed { detector_id: String, reason: String },
    Serialization { reason: String },
}
```

### 13.2 Diagnostic

可恢复问题进入 report：

```text
DUPLICATE_EVENT_IGNORED
DUPLICATE_ORDINAL
MISSING_TIMESTAMP
LOSSY_SOURCE
EMPTY_TRAJECTORY
FINDING_DEDUPLICATED
```

Diagnostic 必须包含 code、message、相关 event / trajectory 引用，不能只写 stderr。

### 13.3 Partial Failure

v0.5 默认 fail-closed：任一 Detector 返回错误，整个 `finalize` 返回 `DetectorFailed`。

原因：现阶段 CLI 和回归测试需要明确失败，不能静默漏规则。未来如支持 partial report，必须显式增加执行策略，不能改变默认语义。

---

## 14. Agent Vitals 兼容桥

### 14.1 位置

兼容逻辑属于 `agent-vitals-core`：

```text
agent-vitals-core/src/compatibility/
├── canonical_session.rs
└── findings.rs
```

### 14.2 输入桥

提供纯函数：

```rust
pub fn canonical_session_to_vitals(
    session: &CanonicalSession,
) -> Result<AgentVitalsInput, CompatibilityError>;
```

职责：

- 将五条现有 timeline 投影为 Canonical Event；
- 使用现有 timeline 坐标生成稳定 `ordinal`；
- 将现有 `Signal` 映射为 `agent.*` SignalId；
- 原样保留 CoverageCounts；
- 原样保留 provenance；
- 一份 session 生成一条 source-session trajectory；
- 不重新读取原始日志。

### 14.3 输出桥

提供纯函数：

```rust
pub fn vitals_report_to_legacy_findings(
    report: &AuditReport,
) -> Result<Vec<serde_json::Value>, CompatibilityError>;
```

职责：

- 映射回现有 `rule / severity / category / evidence / seq / time / turn / step / call_id / run_end_seq`；
- 保持旧 JSON key 和 key 顺序；
- 无法无损映射的字段不得猜测；
- **迁移期 Finding attributes 必须保存旧坐标**（`vitals.source_ordinal`，见
  §10.2）——不是"允许"：没有这个键，输出桥拿不到旧执行流下标，§12.4 的权威
  排序序与旧 golden 的字节序不保证一致，§14.4 第 5 步的逐字节 parity 无法
  通过；
- 兼容输出与现有 golden 逐字节对比。

### 14.4 第一批迁移规则

建议选择的三条，按**依赖复杂度递增**排列，而不是按"看起来都用 timeline、
泄漏都少"一次性并列迁移——那样会把"管线通不通"和"抽象够不够表达"两个风险
绑在一次验证里，一旦失败无法定位是哪一层的问题：

```text
SV601 危险 shell 命令（事件局部、纯正则，无跨事件状态）
SV611 重复动作（只依赖 ToolCalls，无 turn 结构）
SV612 重复序列（引入 turn 结构，§8.4.1 的坐标透传要在这条上第一次接受检验）
```

SV601 先证明"管线能把最简单的东西端到端跑通且逐字节一致"；SV611 证明
"跨事件比较在新模型下可行"；SV612 才是真正考验 §8.4.1 turn 坐标透传方案
的一条——如果它需要修改 Core 才能落地，按 §21 第 1 条止损。

SV613 与 SV614 一起推迟：SV613 和 SV614 结构相同（一个规则码、多个子判定读
不同信号，实测**两条都是** `Any` 语义——原稿此处曾误记成"SV613 是 `All`、
SV614 是 `Any`"，核对 `trajectory.rs::OR_REQUIRES_CODES` 后订正：
`["SV613", "SV614"]` 两个都在 OR 门控集合里）；两条一起等 §7.4 的
requirement 模型在 SV612 上跑稳之后再做。SV610 因 §9.1.1 的 `enhances` 缺
口也不在首批（该节后续更新记录了这条缺口最终为什么没有真正拦住 SV610 的
迁移）。

**这三条止损线都没有被真正触发**：SV601/611/612 三条打样验证完管线、跨事
件状态、turn 坐标透传三层风险后，续迁 SV602–610、613、614 也全部完成，没
有一条规则需要修改 `vitals-core` 本体才能落地（§21 第 1/2/3/7 条止损线均
未触发）——见 §19 M3 的更新记录。

迁移方式：

1. 在 Agent 层实现三个 `Detector`；
2. Detector 依赖 `agent.*` 信号和事件 attributes；
3. `vitals-core` 不出现 SV 规则码解释；
4. 同一 fixture 同时跑旧路径和新路径；
5. 结果规范化后逐字节一致；
6. parity 通过前不删除旧实现；
7. parity 稳定后，旧入口改为兼容 shim。

SV614 暂缓：其 `Any(approval_decision, sandbox_mode)` 适合在 requirement 模型稳定后作为第四条验证。

---

## 15. 版本与序列化契约

### 15.1 两类版本

```text
schema_version   数据结构兼容性
engine_version   执行语义兼容性
```

Detector 另带：

```text
detector_id
detector_version
```

### 15.2 v0.5 兼容规则

- schema major 不同：拒绝读取；
- schema minor 新增可选字段：旧消费者应忽略；
- 字段改义：必须升级 major；
- Detector 阈值或算法变化：升级 detector version；
- 排序、去重或 fingerprint 算法变化：升级 engine version；
- 旧 Agent Vitals JSON contract version 不因内部迁移自动升级。

### 15.3 JSON 是正式调试面

所有公开模型必须 `Serialize + Deserialize + Debug + Clone + PartialEq`，必要时增加 `Eq`。

Rust struct 是主 API；JSON 用于 fixture、Replay、CLI 和跨语言验证。不得让内部 HashMap 顺序泄漏为 API 契约。

#### 15.3.1 Canonical JSON 形态

§6.4 的重复内容比较与 §10.3 的 fingerprint 哈希都要求"两份 JSON 是否代表
同一个事实"，这个判断只能有一个实现。canonical 形态：

- object 的键按 UTF-8 字节序排序后再序列化；
- 整数与浮点不互相退化——`3` 与 `3.0` 是两个不同的值，不做数值归一化；
- 不允许 `NaN` / `Infinity`（校验期拒绝，见 §6.5）；
- 字符串不做 Unicode 归一化（NFC/NFD 保持输入原样）；
- 序列化不插入多余空白。

`§6.4` 去重比较与 `§10.3` fingerprint 哈希都对这个 canonical 形态的字节串
取值，不允许各自实现一份等价判断——两份实现分岔是历史上真实出现过的一类
bug（`r2a.rs` 曾为字节对账专门固定过一次键序）。

---

## 16. 测试策略

### 16.1 vitals-core 单元测试

必须覆盖：

- Event 校验；
- 相同重复与冲突重复；
- ordinal 稳定排序；
- trajectory open / append / close；
- closed trajectory 拒绝 append；
- SignalRequirement All / Any；
- unavailable 时 Detector 未被调用；
- measured-zero 与 unavailable 区分；
- **coverage 计数非零但可消费事件数为零时，门控读后者、判定 Unavailable**
  （§7.4.1；对应现有 `empty_timeline_with_nonzero_coverage_is_unavailable_not_measured_zero`
  在通用模型下的等价用例，缺这条测试 = 门控可能悄悄接错轴）；
- 未注册进 `SignalVocabulary` 的 `SignalId` 在 `build()` 阶段报错，不在运行期
  静默降级为 Unavailable（§7.1）；
- Finding 无 Evidence 被拒绝；
- fingerprint 稳定；
- Finding 去重；
- Replay 稳定排序；
- 相同输入得到相同 input fingerprint。

### 16.2 Property Tests

至少建立：

1. 任意打乱输入 Vec，只要 ordinal 不变，最终 report 相同；
2. 重复插入相同 Event 不改变 Finding；
3. 冲突 Event ID 必定失败；
4. Replay 中每个 Evidence 引用都能找到 Event；
5. 每个 Event 最多属于一条 Trajectory；
6. serialize → deserialize → serialize 结构相同。

### 16.3 Golden Replay Fixtures

通用 Core fixture 不使用 Agent 术语：

```text
tests/fixtures/
├── repetition.json
├── alternating_sequence.json
├── missing_feedback.json
├── duplicate_event.json
└── unavailable_signal.json
```

### 16.4 Agent 迁移 Parity

对 SV611–613：

```text
现有 CanonicalSession
  ├── old detector path → legacy findings
  └── compatibility → vitals-core → legacy projection

normalize(dynamic fields)
              ↓
        byte-for-byte equal
```

### 16.5 全仓回归 Gate

合并前至少通过：

```bash
cargo test
cargo clippy --release --all-targets -- -D warnings
(cd src-tauri && cargo test)
python3 -m unittest discover tests
python3 tests/golden_runner.py
AGENT_VITALS_BIN=target/release/agent-vitals python3 tests/golden_runner.py
git diff --check
```

本仓没有 `pytest`（stdlib-only，见 CLAUDE.md），`python -m pytest -q` 在这里
不存在，是笔误——正确入口是 `python3 -m unittest discover tests`。`clippy`
补进来是因为它是既有 CI gate（扫描路径不得 `unwrap`），不是新增要求。两条
`golden_runner.py`（默认跑 Python 实现、`AGENT_VITALS_BIN` 指向 Rust 二进制
再跑一次）合起来才是 verify.yml 里真正的 `differential` job——单跑
`cargo test` + `unittest` 不会触发这一层，而这层正是 §4.7 承诺的双重
parity 守卫。

WASM 包装层有 API 变化时额外执行：

```bash
(cd crates/agent-vitals-wasm && wasm-pack build --target web)
```

---

## 17. 性能与资源指标

v0.5 不以极限性能为目标，但必须记录基线。

基准数据集：

```text
1,000 events
10,000 events
100,000 events
```

最低验收指标（release build、开发机基线，记录机器型号）：

- 10,000 events 完整 audit：目标小于 100 ms；
- 100,000 events 完整 audit：目标小于 1 s；
- 内存峰值不超过规范化输入 JSON 大小的 8 倍；
- 相同数据运行 20 次，report fingerprint 完全一致。

这些指标是回归基线，不作为对外性能承诺。若未达到，应记录 profile 结果；不得为达标牺牲证据完整性或确定性。

---

## 18. 安全与隐私

### 18.1 Core 的权限边界

`vitals-core`：

- 不读文件；
- 不读环境变量；
- 不访问网络；
- 不启动子进程；
- 不执行 Intervention；
- 不持久化用户原始日志。

### 18.2 Evidence 最小化

- Finding 只保存定位所需的 Event ID、SourceRef 和短说明；
- 不默认复制 prompt、代码、命令输出；
- `raw_reference` 可被 Adapter 哈希或打码；
- Lossy / Redacted 必须通过 provenance 显式标记；
- Core fixture 不包含真实用户路径、用户名、代码和凭据。

---

## 19. 交付阶段

### M0：骨架与契约

交付：

- 新建 `crates/vitals-core`；
- 完成 Event、Signal、Coverage、Provenance、Trajectory 类型；
- 建立 schema、error、serde round-trip；
- 加入 workspace default-members；
- 不接入现有 CLI。

验收：类型测试、序列化测试、dependency boundary test 通过——`dependency
boundary test` 需要覆盖 `src-tauri/`：它是从根 workspace 用空 `[workspace]`
显式 opt-out 的独立工作区（`src-tauri/Cargo.toml`），以 path 依赖引用
`agent-vitals-core`，不在根 `cargo test` 的默认成员里。§5.2 的单向依赖规则
如果只在根 workspace 里检查，这条跨 workspace 的引用不会被测到。

### M1：Engine 最小闭环

交付：

- ingest / finalize / audit；
- 排序、去重、trajectory assignment；
- Detector 注册与 requirement gate；
- RuleOutcome、Finding、Evidence；
- ReplayReport。

验收：通用 fixture、property tests、golden replay 通过。

### M2：Agent 兼容桥

交付：

- CanonicalSession → CanonicalEvent；
- AuditReport → legacy findings；
- Coverage / Provenance 无损映射；
- 不修改上层 JSON contract。

验收：桥接单元测试和现有 fixtures 通过。

### M3：规则迁移

原计划交付（按 §14.4 patch 的重排：SV601 → SV611 → SV612 三条打样，验证管线
本身、跨事件状态、turn 坐标透传三层递增的风险后再决定要不要继续）：

- SV601、SV611、SV612 的 Agent Detector；
- old/new 双路径 parity；
- 旧公开入口改为兼容 shim；
- 新 Replay 可定位到现有 seq / turn / call_id。

**实际交付超出原计划**：三条打样全部通过、且门控/证据模型没有触发 §21 任何
一条止损线之后，续迁完成了 SV602–SV610（family①剩余部分）与 SV613/614
（family④剩余部分，含 §9.1.1 最初标记"暂缓"的 SV610——见该节更新，
`enhances` 缺口在实现阶段被证明不是阻碍）。SV601–SV614 全部十四条规则现在
都有对应的 `vitals_core::Detector` 实现、独立 parity 测试
（`agent-vitals-core/tests/svNNN_parity.rs`）与生产切换（`detect_svNNN` 委
托新引擎，`detect_svNNN_legacy` 保留作自动回退）。

验收：逐字节 parity（Rust 内部 + Python/Rust 全量 CLI matrix 差分）、全仓测
试、WASM 构建通过——十四条规则均已满足。

### M4：稳定与文档

交付：

- API docs；
- 一个无 Agent 术语的 30 秒 example；
- 性能基线；
- 迁移说明；
- v0.5 known limitations。

验收：新开发者仅阅读 README 即可实现一个自定义 Detector，并用 fixture 得到 ReplayReport。

---

## 20. Definition of Done

只有同时满足以下条件，Vitals Core v0.5 才算完成：

- [x] `crates/vitals-core` 不含执行环境或 Agent 专属类型——`module_file_names_are_
  domain_free` / `public_item_identifiers_are_domain_free`
  （`dependency_boundary.rs`）本来就存在，但只扫声明行本身（`pub struct
  Foo {` 这一行的 `Foo`），扫不进花括号内部：一个 `pub struct Foo { pub
  codex_session_id: String }` 会被两条测试都放过，因为违规词出现在字段
  名，不在类型名，这条 DoD 之前一直空着就是因为没有测试真正堵上这个缝。
  2026-09-01 补上 `struct_field_and_enum_variant_names_are_domain_free`
  （按花括号深度扫 struct 字段名和 enum variant 名）+
  `struct_and_enum_body_scanner_actually_finds_identifiers`（合成片段自测
  —— 证明扫描器真的会命中 `codex_session_id`/`Codex`/`Dsh` 这类名字，不是
  因为没扫到任何东西才全绿）；
- [x] Core 无文件、网络、时钟、环境变量和子进程 I/O（`dependency_boundary.rs`）；
- [x] Canonical Event 有稳定 ID、ordinal、SourceRef 和 provenance；
- [x] 相同输入可稳定重放（`same_input_run_repeatedly_yields_identical_fingerprint`）；
- [x] All / Any requirement 前置门控通过测试；
- [x] findings / measured-zero / unavailable 三态完整保留；
- [x] 每条 Finding 至少包含一个有效 Evidence；
- [x] Finding fingerprint 和去重稳定；
- [x] **SV601–SV614 全部十四条规则**新旧路径逐字节一致——不再是原计划的
  "SV601/611/612 打样、SV613/614 推迟"：三条打样验证完管线/跨事件状态/
  turn 坐标透传三层风险、确认没有触发 §21 任一止损线之后，续迁了
  SV602–610、613、614；`agent-vitals-core/tests/svNNN_parity.rs` 十四份、
  Python/Rust 全量 CLI matrix 差分（`test_cli_matrix.py`）均通过。此前一次
  回归——`vitals_report_to_legacy_findings` 按 Replay 帧时间序而非 Detector
  push 序输出，family④ 规则（`flatten_trajectory` 不重排）在多个子判定组合
  命中时顺序与旧路径不符——已修复并补了专门的组合命中回归测试
  （SV613/SV614 各一条）；
- [x] 现有 CLI JSON contract 未变化（15/15 golden 逐字节一致）；
- [x] 现有 HTML、Tauri、dsh-client **源码**不需要同步重写——`dsh-client/
  agent_vitals_wasm_bg.wasm` 构建产物需要每次随 core 改动重新 `wasm-pack
  build` 并拷贝（本来就是既定流程，不是意外的返工），已重新生成并跑通
  `verify-harness.mjs` 等六个 verify 脚本；
- [x] Rust、Python、Tauri、WASM 相关 gate 全部通过；
- [x] 性能与确定性基线已记录（`vitals-core/PERFORMANCE.md`）——记录基线过
  程中发现并修复了一个真实 O(n²) 复杂度 bug（Finding Validation 对
  `trajectory.event_ids` 做线性 `Vec::contains`），100k 事件从 6.3s 降到
  810ms；
- [x] 未提前引入 State、Progress、LLM、动态插件和 Intervention 执行；
- [x] 门控判据读**信号的可消费事件数**，不读 `CoverageCounts`——`覆盖非零
  但可消费事件为零 → Unavailable` 有测试钉住（§7.4.1、§16.1）；
- [x] `enhances` / `min_fidelity` 作为**正式类型系统支持**（分级 confidence
  展示语义）仍然未实现，这条缺口本身没有变化；但 SV610 已完成迁移——见
  §9.1.1 更新，`enhances` 从未真正阻碍过它；
- [x] canonical JSON 形态（§15.3.1）只有一处实现，去重比较与 fingerprint
  哈希共用；
- [x] 未在 `SignalVocabulary` 中注册的 `SignalId` 在 `build()` 阶段报错，
  不会在运行期静默退化为 Unavailable（§7.1）；
- [x] `input_fingerprint` 覆盖 `TrajectoryAssigner` 身份与 `SignalVocabulary`
  内容，`detector_versions_hash` 按 Detector **注册顺序**（不是排序后的展
  示顺序）哈希——发布前审查发现原实现三者均未覆盖：换 assigner、换
  signal-kind 映射、只改变 Detector 注册顺序都会改变报告内容（后者通过改
  变 `FindingId` 分配顺序），但指纹三种情况下都不变，已修复并补测试
  （`changing_detector_registration_order_changes_the_fingerprint`、
  `changing_the_trajectory_assigner_changes_the_fingerprint`）；
- [x] `audit()` 批量调用中途失败时不污染引擎已有状态——发布前审查发现原实
  现里，批中间某条事件校验失败时，之前已经 `ingest()` 成功的事件仍留在
  `buffered_events` 里，会污染这个引擎实例下一次调用，`finalize()` 的失败
  路径已经用 `take()` 清空、`audit()` 的失败路径没有，两者事务语义不一
  致，已修复（回退到调用前的 baseline 长度）并补测试；
- [x] `BySourceSession` 按 `source_type` + `source_id` 分组（不是单独
  `source_id`），且 Engine 在组装 Trajectory 时校验同一条 Trajectory 内事
  件 `actor_id` 必须一致——发布前审查发现原实现只用 `source_id`，两个不同
  来源的会话如果碰巧用了同一个 `source_id`（跨来源合并审计时可能发生）会
  被静默并成一条 Trajectory、内容却混了不同 Actor 的证据，已修复为硬错误
  并补测试；
- [ ] `AuditContext.coverage` 仍然是整次 `audit()` 调用共享的同一份引用，
  不是 trajectory-scoped 的——多 trajectory 输入下每条 trajectory 的
  Detector 看到的是"整个输入的证据密度"而不是"这条 trajectory 自己的"。
  发布前审查指出这条，但当前所有产线调用（`agent-vitals-core`）都是单
  trajectory 输入，不会暴露；修复需要 `AuditInput`/`Coverage` 的 API 形状
  变更，v0.5 范围内**未修**，只在 `AuditContext` 文档里写清楚了这条边界
  （见 `detector.rs`），留给下一个真正需要多 trajectory 输入的调用方触发
  时再解决。

---

## 21. 失败条件与止损线

出现以下任一情况，应暂停抽象并回到契约评审：

1. 为迁移某条 Agent 规则，需要在 `vitals-core` 新增 Codex / DSH / Tool 等专属字段；
2. 新路径无法表达现有 Coverage 或 Provenance；
3. 新路径把 unavailable 转成 measured-zero；
4. 同一输入无法稳定生成相同 Finding fingerprint；
5. 兼容桥需要重新读取原始日志；
6. 为兼容旧 JSON，Core 本体被迫持有 SV 规则码或旧展示字段；
7. 三条首批规则仍需修改 Core 才能各自落地；
8. 上层 CLI / Tauri 必须同时大改才能接入。

这说明抽象边界或迁移切口不成立，不能通过继续堆条件分支解决。

---

## 22. v0.5 之后

v0.5 完成后，下一步应由真实需求决定，而不是按原始大设计顺序机械实现。

候选方向：

```text
v0.6  通用 State / deterministic diff
v0.7  Progress / cost-per-progress
v0.8  第二领域包验证（Investment 或通用 workflow fixture）
v0.9  Validator / Recommendation
v1.0  稳定 Plugin API 与独立 crate 发布
```

Intervention、SemanticJudge 和动态插件必须在至少两个领域包验证 Core 抽象之后再进入正式范围。

---

## 23. 最终架构判断

v0.5 不是把现有 `agent-vitals-core` 改名为 `vitals-core`。

它是在现有产品内部建立一道新的、可验证的边界：

```text
执行环境事实与 Agent 语义
          │
          ▼
  Agent Vitals Domain Layer
          │ Canonical Event / Detector
          ▼
      Vitals Core
          │ AuditReport / Replay
          ▼
  Agent Vitals Compatibility Layer
          │
          ▼
现有 CLI / WASM / Tauri / HTML
```

只有当 Agent Vitals 能依赖这道边界而不损失现有证据纪律，并且第二个领域能够不修改 Core 直接接入时，`vitals-core` 才具备独立仓库和 1.0 API 的条件。
