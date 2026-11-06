//! P1 of the runtime evidence model (`docs/RUNTIME_EVIDENCE_CONTRACT.md` §17).
//!
//! **零行为变更**：这个模块目前没有任何调用方。`behavior.rs` / `usage.rs` /
//! `trajectory.rs` 等现有规则引擎完全不受影响，继续按 DSH-only 的老路径跑，
//! goldens 不会变。这里先把契约里定义的类型落地，让 P2（`DshSource` 适配器 +
//! 反向投影）有类型可用；P3 才开始把规则一条条迁过来读 `Signal` 而不是直接
//! 读 DSH 的 JSON 事件形状。
//!
//! 每个小节的类型对应契约文档的同名小节，删掉这个模块 = 回到 P0。

use std::collections::BTreeMap;

// ────────────────────────── §2 Three axes / Provenance ──────────────────────────

/// 一个值 + 它的来源标注。`value` 缺席（比如 `Observed<Option<T>>` 里的
/// `None`）本身是有意义的事实——"这里发生过 N 次调用，但我们对它们的 token
/// 一无所知"是一条陈述，不是"没有数据"。
pub struct Observed<T> {
    pub value: T,
    pub prov: Provenance,
}

/// 一个数字是执行环境measured出来的、适配器derive出来的、还是像 `est_tokens`
/// 那样纯estimate的——`src/harness.rs` 已经用 `Option` 把"能不能读到"变成编译期
/// 的事，这里把"读到的东西有多可信"也变成编译期的事，理由相同。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provenance {
    /// 执行环境自己记录的数字。
    Measured,
    /// 适配器从别的信号推出来的（例如 Claude Code 的 turn 边界）。
    Derived { from: &'static str },
    /// `est_tokens` 这类纯估算。
    Estimated { estimator: &'static str },
    /// 存在，但降级过（截断 / 哈希 / 打码）。
    Lossy { kind: LossKind },
}

/// `Lossy` 具体降级成了什么形状——展示层需要知道是"看不全"还是"看不清"。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LossKind {
    Truncated { hint: Option<usize> },
    Hashed,
    Redacted,
}

// ────────────────────────── §3 Signals ──────────────────────────

/// 一个具名、类型化的证据通道，独立于其它任何通道存在或缺席——这条独立性是
/// 整个模型能撑过四个执行环境的原因（§4 的 harness coverage matrix 逐格都不同）。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum Signal {
    ToolCalls,
    ToolResults,
    TurnBoundaries,
    StepBoundaries,
    /// 逐请求时间序列。
    Usage,
    /// 只有总量，没有逐请求分辨率。
    UsageAggregate,
    ContextWindow,
    /// 执行环境报告的额度/配额使用快照。
    QuotaConsumption,
    ApprovalDecisions,
    ApprovalPolicy,
    SandboxModes,
    SandboxPolicy,
    NetworkAccess,
    Compaction,
    SubagentSpawns,
    SkillInvocations,
    Hooks,
    FileMutations,
    /// 真人发起的 turn（与 agent 自己续写的 turn 相对）。
    UserPrompts,
    /// §3.2：永远是 `Estimated`，从不是 `Measured`——没有执行环境会把"用户不满意
    /// 上一步的输出"这件事直接记下来，只能从后续行为里猜。
    UserCorrections,
}

impl Signal {
    /// 20 个变体的声明序——`signals` 数组 / `coverage` 字典的输出顺序、以及
    /// 各证据适配器过去各自维护的 `ALL_SIGNALS` 都靠这份序对齐。v0.6
    /// harness-contract spec §6（复制点 B）把它上收成这一份共享 Canonical
    /// Schema：适配器不再各自声明完整信号表，统一用它遍历（M2a）。与 Python
    /// 镜像 `claude_evidence.py`/`codex_evidence.py`/`workbuddy_evidence.py`
    /// 的 `ALL_SIGNALS` 元组同表同序。
    pub const ALL: [Signal; 20] = [
        Signal::ToolCalls,
        Signal::ToolResults,
        Signal::TurnBoundaries,
        Signal::StepBoundaries,
        Signal::Usage,
        Signal::UsageAggregate,
        Signal::ContextWindow,
        Signal::QuotaConsumption,
        Signal::ApprovalDecisions,
        Signal::ApprovalPolicy,
        Signal::SandboxModes,
        Signal::SandboxPolicy,
        Signal::NetworkAccess,
        Signal::Compaction,
        Signal::SubagentSpawns,
        Signal::SkillInvocations,
        Signal::Hooks,
        Signal::FileMutations,
        Signal::UserPrompts,
        Signal::UserCorrections,
    ];
}

/// `Signal` 的位集合——20 个变体放一个 `u32` 里正好，比 `HashSet<Signal>`
/// 便宜（`Copy`，不分配），适配器每处理一个事件就可能查询/更新一次。
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct SignalSet(u32);

impl SignalSet {
    pub const EMPTY: Self = Self(0);

    pub fn insert(&mut self, signal: Signal) {
        self.0 |= 1 << (signal as u32);
    }

    pub fn contains(&self, signal: Signal) -> bool {
        self.0 & (1 << (signal as u32)) != 0
    }

    pub fn from_signals(signals: impl IntoIterator<Item = Signal>) -> Self {
        let mut set = Self::EMPTY;
        for s in signals {
            set.insert(s);
        }
        set
    }
}

// ────────────────────────── §4 Coverage ──────────────────────────

/// 一个信号在一份会话里的覆盖情况：不是"available/degraded/unavailable"三选
/// 一，而是四个互斥计数——缺一类就拉低分母，而不是从报告里消失。
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct CoverageCounts {
    pub measured: u64,
    pub derived: u64,
    pub lossy: u64,
    /// 已知发生过、但除此之外一无所知——这是分母里"承重"的一项：适配器不能
    /// 靠"读不到就不算"来偷偷刷高自己的覆盖率。
    pub unmetered: u64,
}

impl CoverageCounts {
    pub fn total(&self) -> u64 {
        self.measured + self.derived + self.lossy + self.unmetered
    }

    /// `(measured + derived) / total`；`total == 0` 时是 `None`，不是 `0.0`——
    /// "这个信号在这份日志里从没出现过"与"出现过但覆盖率是零"是两回事。
    pub fn ratio(&self) -> Option<f64> {
        let total = self.total();
        if total == 0 {
            None
        } else {
            Some((self.measured + self.derived) as f64 / total as f64)
        }
    }
}

/// 一份会话里每个 `Signal` 各自的覆盖计数。§4：覆盖率是**逐会话算出来的**，
/// 不是按执行环境 id 查表——Codex 的 `ThreadHistoryMode` 就是反例：同一个执行环境 id
/// 下有两种互不兼容的事件词表，只能靠探测内容判断，不能靠"这是 Codex 所以
/// 覆盖率是 X"这种静态查表。
#[derive(Clone, Default, Debug)]
pub struct Coverage(BTreeMap<Signal, CoverageCounts>);

impl Coverage {
    pub fn new() -> Self {
        Self(BTreeMap::new())
    }

    pub fn set(&mut self, signal: Signal, counts: CoverageCounts) {
        self.0.insert(signal, counts);
    }

    /// 缺席的信号视为全零覆盖，而不是 panic——调用方不需要先判断"这个信号
    /// 有没有被记录过"。
    pub fn get(&self, signal: Signal) -> CoverageCounts {
        self.0.get(&signal).copied().unwrap_or_default()
    }

    /// 跨所有信号汇总后的覆盖率。
    pub fn overall_ratio(&self) -> Option<f64> {
        let total: CoverageCounts = self.0.values().fold(CoverageCounts::default(), |acc, c| {
            CoverageCounts {
                measured: acc.measured + c.measured,
                derived: acc.derived + c.derived,
                lossy: acc.lossy + c.lossy,
                unmetered: acc.unmetered + c.unmetered,
            }
        });
        total.ratio()
    }
}

// ────────────────────────── §5 Provenance under aggregation ──────────────────────────

/// 一批不同 provenance 的行相加之后，"这个总数算测量还是估算"本身需要算，
/// 不能直接沿用某一行的标注。`Mixed` 是一等公民——不能因为凑不出单一答案
/// 就悄悄吞掉这条信息。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AggregateProvenance {
    Measured,
    Derived,
    Estimated,
    Lossy,
    Mixed,
    Unknown,
}

/// 一个窗口内**实际出现过**哪几类 provenance——`AggregateProvenance::for_window`
/// 用它来判断能不能把 set 级别的分类收窄成纯值。
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct ProvenanceSet {
    pub measured: bool,
    pub derived: bool,
    pub estimated: bool,
    pub lossy: bool,
}

impl ProvenanceSet {
    fn count(&self) -> u32 {
        self.measured as u32 + self.derived as u32 + self.estimated as u32 + self.lossy as u32
    }

    fn only(&self) -> Option<AggregateProvenance> {
        if self.measured {
            Some(AggregateProvenance::Measured)
        } else if self.derived {
            Some(AggregateProvenance::Derived)
        } else if self.estimated {
            Some(AggregateProvenance::Estimated)
        } else if self.lossy {
            Some(AggregateProvenance::Lossy)
        } else {
            None
        }
    }
}

impl AggregateProvenance {
    /// 把 set 级别的分类收窄成某个具体窗口实际含有的分类。
    ///
    /// 窗口里一种 provenance 都没出现（`present` 全 false）时**沿用外层
    /// `set`**，不是 `Unknown`——空窗口不等于"不知道"，可能只是这个窗口
    /// 本来就没有任何行（比如某个小时完全没有请求），外层的分类依然成立。
    /// 只有一种出现时收窄成那个纯值；出现不止一种时是 `Mixed`。
    pub fn for_window(set: Self, present: &ProvenanceSet) -> Self {
        match present.count() {
            0 => set,
            1 => present.only().expect("count()==1 时 only() 必有值"),
            _ => AggregateProvenance::Mixed,
        }
    }
}

// ────────────────────────── §6 Linearization ──────────────────────────

/// Claude Code 的 transcript 是一棵树（`uuid`/`parentUuid`）、Codex 记
/// `thread_rolled_back`、DSH 的分叉带 `seedLength` 前缀——三者的日志里都留着
/// 用户放弃掉的路径，选哪条路径去计数会改变报告里的每一个数字。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Linearization {
    /// 默认：用户最终走到的那条路径。
    #[default]
    LeafPath,
    AllRecorded,
}

// ────────────────────────── §8 Cost ──────────────────────────

/// ISO 4217 三字母货币码（如 `*b"CNY"`）。不用 `String`——三字节定长，
/// `Copy`，比较不用分配。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CurrencyCode(pub [u8; 3]);

/// 货币精确金额：整数分值 + 精度位数（例如 `scale = 2` 时 `minor_units = 1234`
/// 表示 12.34）。不用 `f64`——金额相加会有舍入误差；P1 还没有消费者，先用
/// 这个最小可行的定点表示，等 cost 模块真正迁过来（P3 之后）时再评估要不要
/// 换一个成熟的定点数 crate。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DecimalAmount {
    pub minor_units: i64,
    pub scale: u8,
}

/// 订阅配额消耗的一个窗口——一个订阅套餐可能同时挂多个互不重叠的窗口
/// （例如一个 7 天滚动窗口叠一个更短的突发窗口），§14.10 cc-switch 的
/// `tiers[]` 就是因为拍扁成一个数字而丢了"到底哪个窗口先撞线"，所以这里
/// 用 `Vec<QuotaWindow>` 而不是单个百分比。
#[derive(Clone, Debug, PartialEq)]
pub struct QuotaWindow {
    /// 套餐档位的原始字符串（如某执行环境上会读到 `"plus"`）——不同执行环境的叫法
    /// 互不通用，不结构化成枚举。
    pub plan: String,
    pub used_percent: f64,
    pub window_minutes: u32,
    pub resets_at_ms: i64,
}

/// 执行环境无关的当前配额快照。
///
/// 各执行环境的 wire 字段（例如 Codex 的 `rate_limits`、未来其他执行环境的
/// `limits`）由 adapter 映射到这里。`plan` 只保留人可见的执行环境原始档位，
/// 不把它误当成跨执行环境通用枚举；执行环境特有的 credits/balance 扩展不进入该
/// 类型，也不能被统一换算成金额。
#[derive(Clone, Debug, PartialEq)]
pub struct QuotaSnapshot {
    pub plan: Option<String>,
    pub windows: Vec<QuotaWindow>,
    pub observed_at: String,
}

impl QuotaSnapshot {
    /// 仅检查跨执行环境不变量；具体 wire 字段和缺失字段策略由 adapter 决定。
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.observed_at.is_empty() {
            return Err("quota snapshot observed_at is empty");
        }
        if self.plan.as_deref().is_some_and(str::is_empty) {
            return Err("quota snapshot plan is empty");
        }
        for window in &self.windows {
            if !window.used_percent.is_finite()
                || !(0.0..=100.0).contains(&window.used_percent)
                || window.window_minutes == 0
                || window.resets_at_ms < 0
                || window.plan.is_empty()
            {
                return Err("quota snapshot window is invalid");
            }
        }
        Ok(())
    }
}

/// 不同单位的花费**不可比较**——不同币种不相加不排名；WorkBuddy 计的是
/// credits，不是 token，不能先换算成 token 再定价。
///
/// `Quota` 是第三种、既不是 `Money` 也不是 `Credits` 的花费：某些执行环境的
/// 订阅账户按请求返回一个"这次用了多少配额"的百分比，相对一个会清零的
/// 滚动窗口，从头到尾没有美元单价，也不是可攒可花的余额（`has_credits`
/// 恒为 false）。把它硬塞进 `Money` 是编造一个不存在的单价；塞进 `Credits`
/// 则混淆了"计量单位是余额"和"计量单位是配额百分比"这两件事——两者都会让
/// `Cost` 的读者误判"这次请求值多少钱"这个问题其实无法回答。
#[derive(Clone, Debug)]
pub enum Cost {
    Money { amount: DecimalAmount, currency: CurrencyCode },
    Credits(f64),
    Quota(Vec<QuotaWindow>),
    Unavailable(Reason),
}

/// 人读的降级原因。目前就是字符串——契约里没有要求结构化到枚举的地步，
/// 结构化的部分是 `SourceAttempt.error` / `RuleOutcome::Unavailable.missing`。
pub type Reason = String;

// ────────────────────────── §9 Identity and join keys ──────────────────────────

/// 一个执行环境内部的编号空间——主会话是一个，每个子代理会话各自另开一个。
/// 不同 scope 下的 `ordinal` 互不可比，这也是为什么 `EventId` 强制要求
/// 跨 scope 的 join 必须走 `native` 字段。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct ScopeId(pub u32);

/// 各执行环境自己的原生标识：DSH 用 `seq`，Codex 用 `turn_id`/`call_id`，
/// Claude Code 用 `uuid`，WorkBuddy 用 `toolCallId`/`requestId`。
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum NativeId {
    Seq(u64),
    Uuid(String),
    CallId(String),
    TurnId(String),
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct EventId {
    pub harness_scope: ScopeId,
    /// 适配器内部合成的序号，**只在同一个 scope 内**保证有序——Claude Code
    /// 完全没有原生 `seq`，跨 scope 或跨适配器比较这个字段没有意义。
    pub ordinal: u64,
    pub native: NativeId,
}

// ────────────────────────── §10 Rules declare what they need ──────────────────────────

/// 一条 finding 的可信程度。派生自 `Ord`：`Full > Partial > Inferred`——
/// 声明顺序从低到高，`derive(Ord)` 按声明顺序排，所以 `Inferred` 必须写在
/// 最前面。`min_fidelity` 卡的是"低于这个档位只能是 possible，永远不能是
/// confirmed"，需要能比大小。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Fidelity {
    Inferred,
    Partial,
    Full,
}

pub struct RuleSpec {
    /// "SV601" 这样的规则编号。
    pub code: &'static str,
    /// 缺一个就整条规则报 `Unavailable`，规则不跑。
    pub requires: &'static [Signal],
    /// 缺一个规则仍然跑，只是降级（比如从 confirmed 掉到 possible）。
    pub enhances: &'static [Signal],
    pub min_fidelity: Fidelity,
}

/// 引擎对每条规则、在每个执行环境上，必须产出且只能产出这三种之一——这是整份
/// 契约里唯一"不可谈判"的属性。"把执行环境翻译成 DSH 事件再跑老引擎"这条路
/// 天生做不到这件事：没有 approval 事件可翻译时，这类适配器只会报告"零条
/// 审批异常"，而报告本身就是错的（该说 unavailable 却说成了 measured-zero）。
pub enum RuleOutcome {
    /// N 条 finding——复用现有 `behavior.rs` 系列已经在用的 JSON 表示，
    /// P1 阶段不新造一个 `Finding` 结构体，避免出现两份不一致的 finding 形状。
    Findings(Vec<serde_json::Value>),
    /// 规则确实跑了，测量到零条。
    MeasuredZero,
    Unavailable { missing: Vec<Signal>, reason: Reason },
}

// ────────────────────────── §11 Adapter result and the attempt trail ──────────────────────────

/// 报告说某个信号 unavailable 时，读者的下一个问题是"到底试过什么"——
/// 自由文本回答不了这个问题，必须是结构化的。
pub struct SourceAttempt {
    /// 例如 `"codex.rollout.jsonl"` / `"workbuddy.audit-log"`。
    pub source_id: &'static str,
    pub kind: SourceKind,
    pub surface: Surface,
    pub available: bool,
    pub error: Option<String>,
    /// 这个来源**实际**覆盖到的时间跨度。不能假设它等于报告请求的窗口——
    /// surface 2/3（钩子 / 遥测）只从配置那一刻开始才有数据（§14.8.6）。
    pub observed_span: Option<TimeSpan>,
}

/// §14.8.3 的证据面对应的存储形态。`Directory` 是目录型表面——会话匿名的
/// traces 目录同样值得留一条 attempt 痕迹（§14.4：skipped and recorded,
/// never treated as corruption），它不落进 LogFile/Sqlite 任何一格。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SourceKind {
    LogFile,
    Sqlite,
    BlobStore,
    RuntimeProbe,
    HookStream,
    TelemetryExport,
    Directory,
}

/// 证据来自哪一类观察位置——会话日志本身、旁路遥测、钩子，还是目录型表面。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Surface {
    SessionLog,
    Telemetry,
    Hook,
    Traces,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TimeSpan {
    pub start_ms: i64,
    pub end_ms: i64,
}

/// 自由文本的补充说明——与 `attempts` 的结构化数据互补，不是替代。
pub struct AdapterNote {
    pub message: String,
}

/// 一份会话跑完五段式适配器流水线（locate → shape → extract → derive →
/// coverage，§4）之后的产物。**不是 trait**——理由见
/// `ARCHITECTURE.md` §4.2：执行环境之间差的是"哪些阶段存在"，trait 会强迫每个
/// 执行环境实现一堆空方法，反而把这个差异藏起来。
///
/// §12：这个类型（以及它引用的每一个类型）里不允许出现任何执行环境专属字段——
/// 执行环境专属数据必须放进一个由执行环境 id 索引的不透明 payload，本模块自己不
/// 持有那个 payload（避免"通用层"迟早变成"每个执行环境怪癖的并集"）。
pub struct CanonicalSession {
    pub meta: SessionMeta,
    pub signals: SignalSet,
    pub coverage: Coverage,
    pub attempts: Vec<SourceAttempt>,
    pub notes: Vec<AdapterNote>,
    // §11.5 timeline：逐事件观测的 harness-neutral 投影——phase B 的规则引擎直接读
    // 这五个字段，不再读裸执行环境事件。适配器在「derive」段填充（见 dsh_evidence.rs
    // 的 populate_timelines）。
    pub tool_calls: Timeline<ToolCallObservation>,
    pub tool_results: Timeline<ToolResultObservation>,
    pub approvals: Timeline<ApprovalObservation>,
    pub sandbox_modes: Timeline<SandboxModeObservation>,
    /// turn 生命周期（SV612 死循环 / SV613(a) 连续 error turn 的输入）——
    /// 见 `TurnObservation` 的字段语义。entry 坐标 = turn/start 的坐标。
    pub turns: Timeline<TurnObservation>,
}

impl CanonicalSession {
    /// 门控的证据判定：某规则 `requires` 的信号，它要消费的证据到底在不在？
    ///
    /// 判定从「coverage 计数非零」改为「对应 timeline 非空」——两者对 DSH 恒
    /// 等价（`dsh_evidence.rs` 里 `derive_coverage` 与 `populate_timelines` 由
    /// 同一份 execution_events 派生，well-formed 下「覆盖非零 ⟺ timeline 非空」），
    /// 但 Codex 上会分叉：`derive_coverage` 把 task_started/task_complete 数成
    /// 非零 measured，timeline 却为空（2026-08 前 Codex 恒为空；现在原生填满 4
    /// 条、只余 approvals 空——approvals 就是本判定的活例子）。读计数会让门控
    /// 放行、检测器在空时间线上空转产出 `MeasuredZero`；读 timeline 才诚实出
    /// `Unavailable`。
    ///
    /// 五条 require-able 信号各对应一条 timeline；其余信号没有可消费的
    /// timeline，视为空（诚实 Unavailable——没有证据可读的规则不该跑，与
    /// Codex 同理）。被 require 的信号落在这里的分支之外，属于契约违约，
    /// 宁可太严（Unavailable）也不许太松（MeasuredZero）。
    pub fn timeline_is_empty(&self, sig: Signal) -> bool {
        match sig {
            Signal::ToolCalls => self.tool_calls.entries.is_empty(),
            Signal::ToolResults => self.tool_results.entries.is_empty(),
            Signal::TurnBoundaries => self.turns.entries.is_empty(),
            Signal::ApprovalDecisions => self.approvals.entries.is_empty(),
            Signal::SandboxModes => self.sandbox_modes.entries.is_empty(),
            _ => true,
        }
    }
}

pub struct SessionMeta {
    pub session_id: String,
    /// 通用的执行环境标识符**值**（比如运行时取到的 `"codex"`）——存的是数据，
    /// 不是类型名，所以不违反 §12："不能有执行环境专属字段"针对的是字段/类型
    /// 名字本身携带执行环境专属含义，不是字段里能装什么字符串。
    pub harness_id: &'static str,
    pub workspace_roots: Vec<String>,
    pub model: Option<String>,
    /// 这份会话**实际覆盖**的时间跨度——喂进本证据的原生记录时间的 min/max。
    ///
    /// - **不是**会话头声明的范围：头部可能被轮转/截断，实测值才是"日志里真的有什么"。
    /// - **空值语义**：0 条原生记录 → `None`。**绝不用 `(0,0)` 表示缺失**——那会被
    ///   日桶/时间窗读成 1970-01-01（本仓在 `issue_instances.opened_at_ms` 上栽过
    ///   同一个形态）。单条记录 → `start_ms == end_ms`，那是合法的"这一刻有记录"。
    /// - **单位恒为毫秒**：由 `agent_vitals_domain::util::to_epoch_ms` 归一
    ///   （Claude/WorkBuddy 的 `parse_iso` 出秒，DSH/Codex 出毫秒）。
    /// - 只取原生记录的时间，不含合成的 `ordinal` 序数（序数不是时间）。
    ///
    /// 与 `SourceAttempt.observed_span` 的分工：那个是**逐来源**的覆盖跨度，为
    /// §14.8.6「surface 2/3 的参差左沿」预留（当前无执行环境实现那些表面）；
    /// 本字段是**整个会话**的跨度，四执行环境都已接线。
    /// 方案见 `docs/v1.0.0/OBSERVED_SPAN_IMPLEMENTATION_PLAN.md`。
    pub span: Option<TimeSpan>,
}

// ────────────────────────── §11.5 Timeline: harness-neutral observations ──────────────────────────

/// 规则引擎直接消费的逐事件投影——phase B 把 `detect_svNNN` 从读裸 DSH JSON
/// 事件改读这里的窄 payload 后，规则不再依赖任何执行环境事件形状（§12 的「不持有
/// 执行环境专属 payload」约束就落在这里：payload 字段名不含执行环境名，DSH / Codex /
/// WorkBuddy 各自适配器把自家事件翻译成这五个观察类型）。
///
/// 事件坐标（turn/step/call_id）在抽取时用 `Coords` 顺延定死、随 entry 存下来，
/// 检测器不再需要自己跑坐标状态机——坐标是「翻译」的产物，不是「规则」的产物。
#[derive(Clone, Debug)]
pub struct ToolCallObservation {
    pub name: String,
    pub args_text: String,
}

#[derive(Clone, Debug)]
pub struct ToolResultObservation {
    /// 通用失败信号（是/否），不解释原因——执行环境只证明「失败了」、不给码时用它
    /// （Claude Code 的 `is_error` 就是这种）。`None` = 源没有失败信号，不是
    /// "没失败"。原因级检测（SV607/608）读 `error_code`，不读它。
    pub failed: Option<bool>,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ApprovalAsked {
    pub tool_name: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ApprovalDecided {
    pub outcome: String,
}

/// 一条审批事件只会是 asked 或 decided 的一端——放成两个 `Option` 而不是
/// 两个独立 timeline，是为了让"审批生命周期"作为一个整体遍历（phase B 的
/// SV610 同时读 sandbox/mode 与 approval/decided，保持同一时间轴）。
#[derive(Clone, Debug)]
pub struct ApprovalObservation {
    pub asked: Option<ApprovalAsked>,
    pub decided: Option<ApprovalDecided>,
}

#[derive(Clone, Debug)]
pub struct SandboxModeObservation {
    pub mode: String,
}

/// 一个 turn 的投影——turn/start 开启、turn 内累积、turn/end 收尾、EOF 兜底
/// 关闭（填充逻辑在 dsh_evidence.rs 的状态化 pass，见那里的注释）。
///
/// `sig` / `last_seq` / `end_*` 三个维度各自回答一个问题，**不可互相替代**：
/// - `sig`：turn 内 tool/call（含 code-dispatch）的 (name, args_text) 有序表——
///   SV612 把连续两个相同 `sig` 的 turn 判成死循环。turn 外的 tool/call 不归任何
///   turn（事件流在 turn 之外的工具调用不属于这个 turn 的"动作序列"）。
/// - `last_seq`：下一个 turn/start 前**最后出现的事件** seq——SV612 的
///   `run_end_seq`。turn 内任何事件（tool/result、approval、turn/end 自身）都
///   推进它，不止工具调用——这样它才是这个 turn 在事件流里真实占到的位置。
/// - `end_seq` / `end_time` / `end_reason_kind` / `end_error_code`：turn/end 自身
///   的坐标与收尾原因——SV613(a) 把连续以 error 收尾的 turn 段判成进度停滞，
///   锚点是**第一个 error turn/end** 的 seq/time，不是 turn/start。
///
/// `last_seq` 与 `end_seq` 在 fixture 里恒相等（turn/end 总是紧邻下一个
/// turn/start），但语义上不可合并：前者是"这个 turn 烧到哪个 seq"（任何事件
/// 都算），后者是"turn/end 这条边界事件自己的 seq"。夹一个事件在 turn/end 与
/// 下一个 turn/start 之间，两者就分开了。
#[derive(Clone, Debug)]
pub struct TurnObservation {
    /// turn/start 的 `data.turn`，缺失时 0（与 `detect_loop` 的 unwrap_or(0) 同）。
    pub turn: i64,
    /// turn 内 tool/call 的 (name, args_text) 有序表。
    pub sig: Vec<(String, String)>,
    /// 下一个 turn/start 前最后事件 seq（SV612 的 run_end_seq）。
    pub last_seq: Option<i64>,
    /// turn/end 的 `data.reason.kind`（如 "error"）。
    pub end_reason_kind: Option<String>,
    /// turn/end 的 `data.reason.error.code`（如 "TIMEOUT"）。
    pub end_error_code: Option<String>,
    /// turn/end 自身的 seq（SV613(a) 锚点）。
    pub end_seq: Option<i64>,
    /// turn/end 自身的 time。
    pub end_time: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct TimelineEntry<T> {
    pub observation: T,
    /// 这条 entry 是执行环境原生记的、适配器 derive 的，还是降级过的——兼容桥
    /// （canonical_session.rs）原样透传给 `CanonicalEvent.provenance`。缺它，
    /// 推导 turn / 模糊错误会被下游当成原生测量（Codex 输入过桥被标成 dsh 来源、
    /// Derived 变 Measured 是同一类洞）。
    pub provenance: Provenance,
    pub seq: Option<i64>,
    pub time: Option<i64>,
    pub turn: Option<i64>,
    pub step: Option<i64>,
    pub call_id: Option<String>,
    /// 在 post_fork 执行流里的下标——只为 `flatten` 稳定排序重建 (event, rule)
    /// 字节序，**不**进 finding JSON。
    pub ordinal: usize,
}

#[derive(Clone, Default, Debug)]
pub struct Timeline<T> {
    pub entries: Vec<TimelineEntry<T>>,
}

impl<T> Timeline<T> {
    /// 空时间线。`derive(Default)` 会给 `Timeline<T>` 额外加一个 `T: Default`
    /// 约束（`Default` 的派生对泛型参数是这么要求的），payload 类型不是
    /// `Default` 的，所以适配器一律用这个构造器而不是 `Timeline::default()`。
    pub fn new() -> Self {
        Timeline { entries: Vec::new() }
    }
}

// ────────────────────────── §12 acceptance test ──────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_all_has_every_variant_exactly_once_in_declaration_order() {
        // 用位集合断言"一个不多一个不少"，不手写第二份 20 项清单去比对
        // `Signal::ALL`——那样只是把同一份表抄两遍，抓不出遗漏。
        let mut seen = SignalSet::EMPTY;
        for s in Signal::ALL {
            assert!(!seen.contains(s), "{s:?} 在 Signal::ALL 里出现了不止一次");
            seen.insert(s);
        }
        for s in Signal::ALL {
            assert!(seen.contains(s));
        }
        assert_eq!(Signal::ALL.len(), 20);
    }

    #[test]
    fn coverage_counts_ratio_is_none_when_total_is_zero() {
        assert_eq!(CoverageCounts::default().ratio(), None);
    }

    #[test]
    fn coverage_counts_ratio_counts_measured_and_derived_only() {
        let c = CoverageCounts { measured: 3, derived: 1, lossy: 1, unmetered: 5 };
        // (3+1) / (3+1+1+5) = 4/10
        assert_eq!(c.ratio(), Some(0.4));
    }

    #[test]
    fn coverage_overall_ratio_sums_across_signals() {
        let mut cov = Coverage::new();
        cov.set(Signal::ToolCalls, CoverageCounts { measured: 10, ..Default::default() });
        cov.set(Signal::Hooks, CoverageCounts { unmetered: 10, ..Default::default() });
        // 10 measured / (10 measured + 10 unmetered) = 0.5
        assert_eq!(cov.overall_ratio(), Some(0.5));
    }

    #[test]
    fn coverage_get_missing_signal_is_zero_not_panic() {
        let cov = Coverage::new();
        assert_eq!(cov.get(Signal::NetworkAccess), CoverageCounts::default());
    }

    #[test]
    fn signal_set_insert_and_contains() {
        let mut set = SignalSet::EMPTY;
        assert!(!set.contains(Signal::Hooks));
        set.insert(Signal::Hooks);
        assert!(set.contains(Signal::Hooks));
        assert!(!set.contains(Signal::ToolCalls));
    }

    #[test]
    fn signal_set_from_signals_builds_the_same_set_as_manual_insert() {
        let a = SignalSet::from_signals([Signal::ToolCalls, Signal::Hooks]);
        let mut b = SignalSet::EMPTY;
        b.insert(Signal::ToolCalls);
        b.insert(Signal::Hooks);
        assert_eq!(a, b);
    }

    #[test]
    fn aggregate_provenance_narrows_to_the_single_kind_present() {
        let present = ProvenanceSet { measured: true, ..Default::default() };
        let narrowed = AggregateProvenance::for_window(AggregateProvenance::Mixed, &present);
        assert_eq!(narrowed, AggregateProvenance::Measured);
    }

    #[test]
    fn aggregate_provenance_is_mixed_when_more_than_one_kind_present() {
        let present = ProvenanceSet { measured: true, estimated: true, ..Default::default() };
        let narrowed = AggregateProvenance::for_window(AggregateProvenance::Measured, &present);
        assert_eq!(narrowed, AggregateProvenance::Mixed);
    }

    #[test]
    fn aggregate_provenance_empty_window_falls_back_to_outer_set() {
        // 窗口内一行都没有 ≠ Unknown——沿用外层分类（比如某个小时完全没有
        // 请求，不代表这份会话整体的 provenance 变得"不知道"）。
        let present = ProvenanceSet::default();
        let narrowed = AggregateProvenance::for_window(AggregateProvenance::Estimated, &present);
        assert_eq!(narrowed, AggregateProvenance::Estimated);
    }

    #[test]
    fn fidelity_orders_full_above_partial_above_inferred() {
        assert!(Fidelity::Full > Fidelity::Partial);
        assert!(Fidelity::Partial > Fidelity::Inferred);
    }

    #[test]
    fn linearization_default_is_leaf_path() {
        assert_eq!(Linearization::default(), Linearization::LeafPath);
    }

    #[test]
    fn cost_quota_holds_multiple_windows_not_one_flattened_number() {
        let cost = Cost::Quota(vec![
            QuotaWindow { plan: "plus".into(), used_percent: 19.0, window_minutes: 10080, resets_at_ms: 1_787_846_539_000 },
            QuotaWindow { plan: "plus".into(), used_percent: 42.0, window_minutes: 300, resets_at_ms: 1_787_800_000_000 },
        ]);
        let Cost::Quota(windows) = cost else { panic!("expected Cost::Quota") };
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[1].window_minutes, 300);
    }

    #[test]
    fn quota_snapshot_validates_cross_harness_invariants() {
        let snapshot = QuotaSnapshot {
            plan: Some("plus".into()),
            windows: vec![QuotaWindow {
                plan: "plus".into(),
                used_percent: 42.0,
                window_minutes: 300,
                resets_at_ms: 1_787_800_000_000,
            }],
            observed_at: "2026-09-13T00:00:00Z".into(),
        };
        assert_eq!(snapshot.validate(), Ok(()));

        let mut invalid = snapshot.clone();
        invalid.windows[0].used_percent = 101.0;
        assert_eq!(invalid.validate(), Err("quota snapshot window is invalid"));
    }

    /// §12："这条规则有一个测试：断言共享类型层里没有任何标识符含执行环境名。"
    /// 用源码文本自检而不是逐类型反射——本文件的说明性注释里会大量提到
    /// Codex / Claude Code / WorkBuddy / DSH（解释为什么要这么设计），所以
    /// 必须先把 `//` / `///` 注释行剥掉，只检查真正的代码文本；否则这条
    /// 测试自己先假红。
    #[test]
    fn shared_type_layer_has_no_harness_identifiers_in_code() {
        let src = include_str!("evidence.rs");
        // 只扫 `#[cfg(test)]` 之前的部分——测试模块自己就得把执行环境名列成
        // 字符串字面量才能拿它们去查（正下面这份 harness 列表），不这样切一刀
        // 这条测试会先把自己判红。
        let production_src = src.split("#[cfg(test)]").next().unwrap_or(src);
        let code_only: String = production_src
            .lines()
            .map(|line| {
                let trimmed = line.trim_start();
                if trimmed.starts_with("//") {
                    return String::new();
                }
                match line.find("//") {
                    Some(i) => line[..i].to_string(),
                    None => line.to_string(),
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        for harness in ["codex", "claude_code", "claudecode", "workbuddy", "dsh"] {
            assert!(
                !code_only.contains(harness),
                "shared evidence type layer must not name harness {harness:?} in code (see contract §12)"
            );
        }
    }
}
