//! v0.9 Data Foundation 的 Query API 契约类型
//! （`docs/AGENT_VITALS_V0_9_DATA_VALUE_ARCHITECTURE_SPEC.md` §3.1/§4/§0.1）。
//!
//! 这里冻结的是**形状与不变式**，不是计算：谁来产出一份 `MonthlySummary`
//! （Stage 0 的 JSON 读 adapter，还是 Stage B 的 SQLite repository）是
//! `agent-vitals-data` crate 的事——本模块只回答"一份 MonthlySummary 必须长
//! 什么样、字段之间不允许违反哪些约束"，两边都要构造同一批类型，任何一边
//! 想抄近路（比如把 unresolved 悄悄记成 0，或者把排除的执行环境又塞回
//! by_harness）在这里就会被 `contract_violations` 抓到。domain crate 不读文件、
//! 不连 SQLite（`tests/dependency_budget.rs` 钉住），本文件全程只是
//! 结构体/枚举 + 纯函数。
//!
//! 三条硬性不变式，来自 spec 原文，不是本文件发明的：
//! 1. spec §0.1「诚实展示」：`excluded_harnesses` 里的执行环境不能同时出现在
//!    `by_harness` 里——排除是显式声明的事实，不是"恰好没数据"的沉默现象。
//! 2. spec §4「unresolved：不得归零」：`BillingBasis::Unresolved` 从不作为
//!    金额出现在 `amounts_by_basis` 里，只能通过 `has_unresolved` 标记存在
//!    性；对称地，`total_summable()` 永远不会把它算进去伪装成确定数字。
//! 3. spec §3.1「数据源状态可见」：`FreshnessState::Unavailable` 是「这个
//!    范围从未被观测到」，不能同时带一个 `last_observed_at`——那是自相矛盾
//!    的"没数据但有时间戳"。
//!
//! **序列化不用 `serde` derive**：本 crate 现有类型
//! （`contracts::harness_capability::HarnessProfile` 等）一律手写 `as_str()`/
//! `to_json()` 落 `serde_json::Value`，`serde` 派生宏从未是这个 crate 的
//! 依赖；这里延续同一习惯，不为本文件单开第二套序列化路径。

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

/// spec §4 表：一笔金额的账单口径，禁止互相冒充。
///
/// `Unresolved` 刻意不参与任何"能否汇总"的判断——它根本不是一个金额，是
/// "模型或价格不可确认"这件事本身；持有 `Unresolved` 的地方只应该记
/// 存在性（`has_unresolved: bool`），不应该出现在按 basis 分桶的金额表里。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum BillingBasis {
    /// 用户声明的固定订阅费用——spec §4："只能按周期单列"。
    FixedSubscription,
    /// 可观测到的按量实际费用——spec §4："可以按口径汇总"。
    MeteredActual,
    /// 依据价格表的估算——spec §4："不可以"冒充真实账单。
    MeteredEstimate,
    /// **已归因**的按量估算（2026-09-16 计费三级口径）：用户在计费声明里答过
    /// 「这批用量经 X 按量付费」，金额仍是价卡 × token 的估算，区别只在**价卡是
    /// 谁选的**——目录猜的进 `MeteredEstimate`，用户归因的进这一档。它照样不
    /// summable（估算不冒充实付），但 [`MeteredView`] 里它取代默认估算、被
    /// `MeteredActual`（账单）取代：`账单 > 归因估算 > 默认估算`。
    MeteredDeclared,
    /// 执行环境提供的账单/credits 消耗，无逐请求 token 归因——spec §4：
    /// "可以按执行环境账单口径汇总，不能重标为模型 API 成本"（WorkBuddy 的
    /// credit_json 落在这一档，不是 metered_actual）。
    HarnessBilled,
    /// 套餐消耗的等价 API 标价——spec §4："只作诊断"，不计入用户账单总额。
    ApiEquivalent,
}

impl BillingBasis {
    /// spec §4"能否冒充真实账单"列里明确写"可以汇总"的三档。`MeteredEstimate`
    /// 与 `ApiEquivalent` 都不参与——它们分别是"估算"与"仅供诊断的等价值"，
    /// 混进用户看到的月度总额就是把不确定的数字伪装成确定的数字。
    pub fn summable_into_total(self) -> bool {
        matches!(self, Self::FixedSubscription | Self::MeteredActual | Self::HarnessBilled)
    }

    /// `harnesses --json`/`data coverage --json` 一贯的 snake_case 词汇。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FixedSubscription => "fixed_subscription",
            Self::MeteredActual => "metered_actual",
            Self::MeteredEstimate => "metered_estimate",
            Self::MeteredDeclared => "metered_declared",
            Self::HarnessBilled => "harness_billed",
            Self::ApiEquivalent => "api_equivalent",
        }
    }

    /// `as_str` 的逆——从持久化/CLI 读回来的 snake_case 还原成 basis。不认识
    /// 的字符串返回 `None`（`harness_bills` 表里的 basis 由 `harness_bill_put` 校验
    /// 过五档词表，理论上不会命中，但读侧不做"猜一个默认"这种事）。名字不用
    /// `from_str`——那会和 `std::str::FromStr` 撞（clippy::should_implement_trait），
    /// 而我们要的是 `Option` 而非 `Result<_, ()>`。
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "fixed_subscription" => Self::FixedSubscription,
            "metered_actual" => Self::MeteredActual,
            "metered_declared" => Self::MeteredDeclared,
            "metered_estimate" => Self::MeteredEstimate,
            "harness_billed" => Self::HarnessBilled,
            "api_equivalent" => Self::ApiEquivalent,
            _ => return None,
        })
    }

    /// 5 档的硬常量——给 schema enum 用，避免误增新档悄无声息。
    pub const fn variant_count() -> usize { 5 }
}

/// spec §5.1.1 + §13 M0 D2：MCP、CLI、Tauri 三消费面同源读的最小货币单位
/// 整数三元组。**不**存展示层 `f64`（spec §5.1 规则 5）；生产者只在该做
/// 一次 `pyround` 的最细上报粒度 round 一次，父层金额 = 子项整数和
///（守恒由构造）。
///
/// 这是一个**纯数据类型**——不读时钟、不引第三方、不认识执行环境 wire 格式。
/// `from_f64` / `sum_minor` / `minor_digits_for` 在 runtime crate 实现
///（它们有浮点舍入 / IO 状态），domain 这层只暴露数据形状。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyMinor {
    pub amount_minor: i64,
    pub currency: String,
    pub basis: BillingBasis,
}

impl MoneyMinor {
    /// spec §5.1.1 JSON 形状——`amount_minor` 是 i64（最小货币单位整数）、
    /// `currency` ISO 4217 字符串（"CNY" / "USD" / …）、`basis` 来自
    /// `BillingBasis::as_str()` 的 snake_case。
    pub fn to_json(&self) -> Value {
        json!({
            "amount_minor": self.amount_minor,
            "currency": self.currency,
            "basis": self.basis.as_str(),
        })
    }

    /// `to_json` 的逆——读侧把 envelope 里的 `MoneyMinor` 还原成结构体。
    /// `amount_minor` 必须是非负整数（金钱不出现负值；负值 → `None`，由
    /// 调用方报业务错误）；`basis` 必须在 `BillingBasis::from_wire` 词表里。
    pub fn from_json(v: &Value) -> Option<Self> {
        let amount = v.get("amount_minor")?.as_i64()?;
        if amount < 0 {
            return None;
        }
        let currency = v.get("currency")?.as_str()?.to_string();
        let basis_str = v.get("basis")?.as_str()?;
        let basis = BillingBasis::from_wire(basis_str)?;
        Some(Self { amount_minor: amount, currency, basis })
    }
}

/// spec §0.1：每一项成本必须可见的口径，比 `BillingBasis` 粗一档——回答
/// "这个数字有多可信"，而不是"这个数字属于哪种账单"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CostBasis {
    /// 直接从执行环境证据读到的数字。
    Measured,
    /// 从其他 measured 字段推导出来的数字（例如按价格表折算）。
    Derived,
    /// 缺少直接证据时的估算。
    Estimated,
    /// 模型、价格或归属都不可确认——spec §4："不得归零"，调用方必须显式
    /// 处理这个变体，不能落进任何数值字段。
    Unresolved,
}

impl CostBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Measured => "measured",
            Self::Derived => "derived",
            Self::Estimated => "estimated",
            Self::Unresolved => "unresolved",
        }
    }
}

/// spec §3.1/§0.1：一个范围（某执行环境、某天、某月）的新鲜度状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreshnessState {
    /// 已在预期窗口内观测到最新数据。
    Fresh,
    /// 曾经观测到，但已超出预期新鲜窗口（执行环境停更、同步滞后）。
    Stale,
    /// 只观测到部分维度/部分时间段，不是完整覆盖。
    Partial,
    /// 该执行环境/范围从未被观测——不是"测量结果是零"，是"没有测量"
    /// （spec §0.1："不得渲染为 ¥0、正常或看似完整的总额"）。
    Unavailable,
}

impl FreshnessState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Stale => "stale",
            Self::Partial => "partial",
            Self::Unavailable => "unavailable",
        }
    }
}

/// 一个范围的新鲜度：状态 + 最后一次真正观测到数据的时间。
///
/// `Unavailable` 状态下 `last_observed_at` 必须是 `None`——见模块头不变式 3；
/// 用 [`Freshness::contract_violations`] 校验，不在构造时 panic（domain 只
/// 报告矛盾，不代替调用方决定怎么处理，一贯做法见 `usage.rs` 的
/// `unaccounted_usage` 哨兵）。
#[derive(Debug, Clone, PartialEq)]
pub struct Freshness {
    pub state: FreshnessState,
    /// RFC3339。`None` 当且仅当 `state == Unavailable`。
    pub last_observed_at: Option<String>,
}

impl Freshness {
    pub fn unavailable() -> Self {
        Self { state: FreshnessState::Unavailable, last_observed_at: None }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "state": self.state.as_str(),
            "last_observed_at": self.last_observed_at,
        })
    }

    fn contract_violations(&self, into: &mut Vec<String>, where_: &str) {
        if self.state == FreshnessState::Unavailable && self.last_observed_at.is_some() {
            into.push(format!(
                "{where_}: freshness=Unavailable 但带了 last_observed_at——\
                 「从未观测到」不能同时有一个观测时间戳"
            ));
        }
    }
}

/// spec §0 DoD #5："coverage 不把未知伪装成零，所有分母有版本化定义"。
///
/// `denominator_version` 存在的理由：分母的定义本身会随规则演进而变化
/// （新增一个可观测字段，分母就变大）——旧快照的覆盖率与新快照的覆盖率
/// 不能被无声地当成同一把尺子比较，这是 `usage_fact` 系列已经踩过的教训
/// （`fact_id`/`source_event_id` 的身份哈希同样带版本化前提）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoverageStatus {
    pub measured_fields: u64,
    pub total_fields: u64,
    pub denominator_version: u32,
}

impl CoverageStatus {
    pub fn to_json(&self) -> Value {
        json!({
            "measured_fields": self.measured_fields,
            "total_fields": self.total_fields,
            "denominator_version": self.denominator_version,
        })
    }

    fn contract_violations(&self, into: &mut Vec<String>, where_: &str) {
        if self.measured_fields > self.total_fields {
            into.push(format!(
                "{where_}: measured_fields ({}) > total_fields ({})——分子不能超过分母",
                self.measured_fields, self.total_fields
            ));
        }
    }
}

/// 一个执行环境（或 billing_source 条目）在某个范围内的金额，按 [`BillingBasis`]
/// 分桶——绝不是脱离来源的 scalar（spec §3.1："任何 UI 若只消费金额而丢弃
/// 这些字段，视为契约违规"）。
#[derive(Debug, Clone, PartialEq)]
pub struct HarnessAmount {
    pub harness_id: String,
    /// `BillingBasis::Unresolved` 意义上没有金额，故 key 类型本身就排除了
    /// unresolved——见 `has_unresolved` 字段。
    pub amounts_by_basis: BTreeMap<BillingBasis, f64>,
    /// 条目级币种。**为什么现在才加**（Stage C 逼出的缺口）：订阅费摊入后
    /// `FixedSubscription` 的 20/114/118 是裸数字——UI 没法知道是 $20 还是
    /// ¥20，渲染出来就是编造币种。`by_provider` 条目天然单币（一个
    /// billing_source 一张价卡）→ `Some`；`by_harness` 条目可能混币
    /// （claude-code 的 CNY 估 + USD 折）→ `None`（币种仍由旧约定承载，
    /// 不假装声明）。`None` 不代表"没有币种"，代表"本条目未声明单币"。
    pub currency: Option<String>,
    pub has_unresolved: bool,
    /// Provider route evidence used by the read model. Kept separate from
    /// `harness_id`/billing basis so an estimate is never rendered as a real bill.
    pub evidence_basis: Option<String>,
    pub pricing_method: Option<String>,
    pub unresolved_reason: Option<String>,
    pub freshness: Freshness,
}

impl HarnessAmount {
    /// spec §4"能否汇总"列为真的几档之和——用户会看到的、这个执行环境贡献的
    /// 可信总额。**不存字段，每次算**：存字段会重蹈 `month.json` 三倍计数
    /// 事故的覆辙（同一个数字有两个来源，迟早对不上）。
    ///
    /// 显式 `fold(0.0, …)` 而不是 `.sum()`：实测（rustc，2026-09）对空迭代器
    /// `Sum<&f64>` 产出 **-0.0**，`serde_json` 会把它原样序列化成 "-0.0"——
    /// 无数据执行环境的 summable_total 在 `--json` 里显示成负零，读起来像"欠
    /// 0 元"（Stage 0.5 的 `data coverage --json` 首次把这个形状暴露出来）。
    /// fold 的恒等元是显式的 +0.0，空表恒得 +0.0。
    pub fn summable_total(&self) -> f64 {
        self.amounts_by_basis
            .iter()
            .filter(|(basis, _)| basis.summable_into_total())
            .fold(0.0, |acc, (_, amount)| acc + amount)
    }

    pub fn to_json(&self) -> Value {
        let by_basis: serde_json::Map<String, Value> = self
            .amounts_by_basis
            .iter()
            .map(|(basis, amount)| (basis.as_str().to_string(), json!(amount)))
            .collect();
        json!({
            "harness_id": self.harness_id,
            "amounts_by_basis": Value::Object(by_basis),
            "summable_total": self.summable_total(),
            "currency": self.currency,
            "has_unresolved": self.has_unresolved,
            "evidence_basis": self.evidence_basis,
            "pricing_method": self.pricing_method,
            "unresolved_reason": self.unresolved_reason,
            "freshness": self.freshness.to_json(),
        })
    }

    fn contract_violations(&self, into: &mut Vec<String>) {
        let where_ = format!("by_harness[{}]", self.harness_id);
        self.freshness.contract_violations(into, &where_);
    }
}

/// 一个范围（执行环境 × 窗口）的 token 计量——感知层的 L0（ATTRIBUTABLE_WASTE
/// §6：`processed_tokens` 是 cost/M 的分母，「这份钱换来多少处理量」的回答）。
/// 桶维度统一到四轴（uncached/cache_read/cache_write/output）：执行环境词表不同
/// （DSH 四桶 / Claude 4 型 / Codex 5 桶），由各自 adapter 归一，父子字段有
/// 包含关系的先去重再进（§6 原话）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HarnessTokens {
    /// 四桶之和 = processed_tokens。
    pub total: i64,
    pub uncached_input: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub output: i64,
    /// 缓存命中率 = cache_read / (uncached + cache_read + cache_write)；
    /// 输入侧全零 → None（MeasuredZero ≠ Unavailable）。codex 的命中语义
    /// 弱一档（cached_input_tokens 是响应自报、无 TTL 语义），由展示层决定
    /// 是否并排——数值本身照报，不在这里装差异。
    pub cache_hit_ratio: Option<f64>,
}

impl HarnessTokens {
    pub fn to_json(&self) -> Value {
        json!({
            "total": self.total,
            "uncached_input": self.uncached_input,
            "cache_read": self.cache_read,
            "cache_write": self.cache_write,
            "output": self.output,
            "cache_hit_ratio": self.cache_hit_ratio,
        })
    }
}

/// spec §3.1：`daily_summary`/`monthly_summary` 查询的返回形状。字段齐全性
/// 本身就是契约的一部分——少一个字段就是丢失一条业务语义，不是"精简"。
#[derive(Debug, Clone, PartialEq)]
pub struct MonthlySummary {
    /// "YYYY-MM"。
    pub month: String,
    pub by_harness: BTreeMap<String, HarnessAmount>,
    /// 各执行环境的 token 计量（L0 感知层分母）——与 `by_harness` 同键。金额进不
    /// 去的（无价卡 glm-*）token 照常在这：unpriced 不进金额分母（§6.2），
    /// 但处理量本身必须可见，否则"这份钱换来多少处理量"对无价部分失明。
    pub tokens_by_harness: BTreeMap<String, HarnessTokens>,
    /// **billing_source 视角**（ATTRIBUTABLE_WASTE §6.3「Harness ≠
    /// BillingSource」的 DTO 落地）：键 `"harness/provider"`，每个实际收费方
    /// 一条。为什么 by_harness 装不下这个视角：`HarnessAmount.amounts_by_basis`
    /// 是 `BTreeMap<BillingBasis, f64>`，一个 basis 只有一个数——claude-code
    /// 的订阅桶里 anthropic 折 USD、minimax 折 CNY，同桶跨币相加就是编造
    /// （2026-09-05 实测逼出的结构缺陷，此前只能用"币种当 basis"的权协，
    /// 把有订阅的 MiniMax 判成 MeteredEstimate、没订阅的 moonshot 判成
    /// ApiEquivalent）。per-provider 条目币种天然单一，basis 就是真计费
    /// 模式（经 `billing_modes` 声明解析）。**权威归属看这里**；`by_harness`
    /// 保留执行环境视角的币种分栏（既有冻结口径，托盘/数据源 panel 在读）。
    pub by_provider: BTreeMap<String, HarnessAmount>,
    pub coverage: CoverageStatus,
    pub freshness: Freshness,
    /// 已知存在但本版本不产出数据的执行环境（例如 WorkBuddy 在 v0.9 Stage 0
    /// 之前）——这是显式声明，见 `apps/cli/src/agent/
    /// harness_runtime_registration.rs` 里 `workbuddy_has_neither_session_store_
    /// nor_fold_registration` 已经钉住的现状，本类型只是把同一个事实抬到
    /// 跨执行环境查询层。
    pub excluded_harnesses: BTreeSet<String>,
    pub last_observed_at: Option<String>,
}

/// `total_actual_spend` 的按 basis 分栏版（月/日共用）：只收
/// [`BillingBasis::summable_into_total`] 的三档，零金额不撑出币桶。
fn actual_spend_by_basis(
    by_provider: &BTreeMap<String, HarnessAmount>,
) -> BTreeMap<BillingBasis, BTreeMap<String, f64>> {
    let mut out: BTreeMap<BillingBasis, BTreeMap<String, f64>> = BTreeMap::new();
    for h in by_provider.values() {
        let key = h.currency.clone().unwrap_or_default();
        for (basis, amount) in &h.amounts_by_basis {
            if !basis.summable_into_total() || *amount == 0.0 {
                continue;
            }
            *out.entry(*basis).or_default().entry(key.clone()).or_insert(0.0) += amount;
        }
    }
    out
}

/// 「按量费用」KPI 的口径标签：全部来自账单 → `Actual`；全部是估算 →
/// `Estimate`；两者都有 → `Mixed`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeteredLabel {
    Actual,
    Estimate,
    Mixed,
}

impl MeteredLabel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Actual => "actual",
            Self::Estimate => "estimate",
            Self::Mixed => "mixed",
        }
    }
}

/// 一个币种的「按量费用」视图（2026-09-16 产品定向：账单 > 归因估算 > 默认估算，
/// **同 provider 内取代、跨 provider 同币相加、跨币分栏**）。
///
/// 为什么不是把 `MeteredDeclared` 加进 `summable_into_total`：`total_actual_spend`
/// 的语义是「真实支出」，估算混进去就是编造；KPI 要的是「按量这条线该显示什么
/// 数」——一个带口径标签的视图，取舍在 domain 做、JS 只格式化。
#[derive(Debug, Clone, PartialEq)]
pub struct MeteredView {
    /// 该币种按量行要显示的数（三级取代后的和）。
    pub amount: f64,
    /// 其中来自账单（`MeteredActual` + `HarnessBilled`）的部分。
    pub actual: f64,
    /// 其中来自已归因估算（`MeteredDeclared`）的部分。
    pub declared_estimate: f64,
    /// 其中来自默认估算（`MeteredEstimate`，目录猜的路由）的部分。
    pub default_estimate: f64,
    pub label: MeteredLabel,
    /// 仍停留在默认估算（未归因）的 `harness/provider` 条目——「待归因」提示用。
    pub unattributed_providers: Vec<String>,
}

impl MeteredView {
    pub fn to_json(&self) -> Value {
        json!({
            "amount": self.amount,
            "actual": self.actual,
            "declared_estimate": self.declared_estimate,
            "default_estimate": self.default_estimate,
            "label": self.label.as_str(),
            "unattributed_providers": self.unattributed_providers,
        })
    }
}

/// 三级取代的实现（月/日共用）。取代在 **provider 条目级**：一个条目同时有
/// 账单与估算时只取账单（估算两档只进明细）；没有账单时归因估算与默认估算
/// **不互斥**——同一 provider 可能一部分事实已归因、一部分没有（例如作用域
/// 只盖了部分模型），两者相加、条目记为「有未归因部分」。零金额不撑桶。
fn metered_view(by_provider: &BTreeMap<String, HarnessAmount>) -> BTreeMap<String, MeteredView> {
    let mut out: BTreeMap<String, MeteredView> = BTreeMap::new();
    for (key, h) in by_provider {
        let get = |b: BillingBasis| h.amounts_by_basis.get(&b).copied().unwrap_or(0.0);
        let actual = get(BillingBasis::MeteredActual) + get(BillingBasis::HarnessBilled);
        let declared = get(BillingBasis::MeteredDeclared);
        let default = get(BillingBasis::MeteredEstimate);
        if actual == 0.0 && declared == 0.0 && default == 0.0 {
            continue;
        }
        let currency = h.currency.clone().unwrap_or_default();
        let view = out.entry(currency).or_insert_with(|| MeteredView {
            amount: 0.0,
            actual: 0.0,
            declared_estimate: 0.0,
            default_estimate: 0.0,
            label: MeteredLabel::Estimate,
            unattributed_providers: Vec::new(),
        });
        if actual > 0.0 {
            view.actual += actual;
            view.amount += actual;
        } else {
            view.declared_estimate += declared;
            view.default_estimate += default;
            view.amount += declared + default;
            if default > 0.0 {
                view.unattributed_providers.push(key.clone());
            }
        }
    }
    for view in out.values_mut() {
        let has_estimate = view.declared_estimate > 0.0 || view.default_estimate > 0.0;
        view.label = match (view.actual > 0.0, has_estimate) {
            (true, false) => MeteredLabel::Actual,
            (true, true) => MeteredLabel::Mixed,
            _ => MeteredLabel::Estimate,
        };
    }
    out
}

fn metered_view_json(m: &BTreeMap<String, MeteredView>) -> Value {
    Value::Object(m.iter().map(|(c, v)| (c.clone(), v.to_json())).collect())
}

fn actual_spend_by_basis_json(m: &BTreeMap<BillingBasis, BTreeMap<String, f64>>) -> Value {
    Value::Object(m.iter().map(|(b, cur)| (b.as_str().to_string(), json!(cur))).collect())
}

impl MonthlySummary {
    /// 所有执行环境可汇总金额之和——见 [`HarnessAmount::summable_total`] 的同一条
    /// "不存字段、每次算"纪律（空负零的 fold 理由也在那边）。
    pub fn total_summable(&self) -> f64 {
        self.by_harness
            .values()
            .map(HarnessAmount::summable_total)
            .fold(0.0, |a, b| a + b)
    }

    pub fn has_unresolved(&self) -> bool {
        self.by_harness.values().any(|h| h.has_unresolved)
    }

    /// **真实总支出，按币种分栏**（Stage C）：`by_provider` 条目的 summable
    /// 档（FixedSubscription 月费 + MeteredActual + HarnessBilled）之和。与
    /// [`Self::total_summable`]（by_harness 视角、冻结语义）并存的原因：订阅
    /// 费摊在 by_provider 条目上——只算 by_harness 会把"这个月真实花了多少"
    /// 谎报成 0（2026-09 真机：total_summable=0 而订阅费 252 已在付）。
    /// 跨币**分桶不相加**；键空串 = 条目未声明币种（`HarnessAmount.currency
    /// == None`）的金额，不得冒充任何币。空 map = 没有任何真实支出条目。
    pub fn total_actual_spend(&self) -> BTreeMap<String, f64> {
        let mut out: BTreeMap<String, f64> = BTreeMap::new();
        for h in self.by_provider.values() {
            let amount = h.summable_total();
            // 零金额不撑出币桶：`{"": 0.0}` 读起来像"有一笔未知币的 0 支出"，
            // 实际是"没有真实支出条目"——空 map 才是「无数据」的诚实形状
            // （fold(0.0) 正零纪律的同一条， negative-zero 教训的镜像面）。
            if amount == 0.0 {
                continue;
            }
            let key = h.currency.clone().unwrap_or_default();
            *out.entry(key).or_insert(0.0) += amount;
        }
        out
    }

    /// [`Self::total_actual_spend`] 的按 basis 拆栏：同一条 summable 过滤、同一
    /// 条零金额不撑桶纪律，只是把「按量实付 / 执行环境账单 / 订阅月费」分开——
    /// 工作台「本月支出」卡要分行显示这三档而不是一个"含"字句，拆分逻辑放
    /// 在这里而不是 JS 里，`by_basis` 各栏之和恒等于 `total_actual_spend`
    /// （单测钉住）。
    pub fn actual_spend_by_basis(&self) -> BTreeMap<BillingBasis, BTreeMap<String, f64>> {
        actual_spend_by_basis(&self.by_provider)
    }

    /// 「按量费用」KPI 视图：账单 > 归因估算 > 默认估算（见 [`MeteredView`]）。
    pub fn metered_view(&self) -> BTreeMap<String, MeteredView> {
        metered_view(&self.by_provider)
    }

    /// 校验模块头三条不变式，返回违反描述；空 vec = 合规。
    ///
    /// 这是给 `agent-vitals-data` 的构建函数用的安全网，不是运行时会 panic
    /// 的断言——诚实原则是"报告矛盾"而不是"代替调用方决定"，参见
    /// `usage.rs` 的 `unaccounted_usage` 哨兵与本仓库一贯做法。
    pub fn contract_violations(&self) -> Vec<String> {
        let mut violations = Vec::new();

        for harness in &self.excluded_harnesses {
            if self.by_harness.contains_key(harness) {
                violations.push(format!(
                    "excluded_harnesses 包含 {harness}，但 by_harness 里也有它——排除的执行环境\
                     不能同时贡献数据，那不是排除，是遗漏"
                ));
            }
            // by_provider 键形如 "harness/provider"：执行环境部分被排除却仍有
            // provider 条目，同一条排除语义的漏网面。
            if self
                .by_provider
                .keys()
                .any(|k| k.split('/').next() == Some(harness.as_str()))
            {
                violations.push(format!(
                    "excluded_harnesses 包含 {harness}，但 by_provider 里仍有它的条目——\
                     排除的执行环境不能同时贡献数据，那不是排除，是遗漏"
                ));
            }
        }

        self.coverage.contract_violations(&mut violations, "coverage");
        self.freshness.contract_violations(&mut violations, "freshness");
        for harness_amount in self.by_harness.values() {
            harness_amount.contract_violations(&mut violations);
        }
        for provider_amount in self.by_provider.values() {
            provider_amount.contract_violations(&mut violations);
        }

        violations
    }

    pub fn to_json(&self) -> Value {
        let by_harness: serde_json::Map<String, Value> =
            self.by_harness.iter().map(|(id, amount)| (id.clone(), amount.to_json())).collect();
        let by_provider: serde_json::Map<String, Value> = self
            .by_provider
            .iter()
            .map(|(id, amount)| (id.clone(), amount.to_json()))
            .collect();
        json!({
            "month": self.month,
            "by_harness": Value::Object(by_harness),
            "tokens_by_harness": Value::Object(self.tokens_by_harness.iter()
                .map(|(id, t)| (id.clone(), t.to_json())).collect()),
            "by_provider": Value::Object(by_provider),
            "total_summable": self.total_summable(),
            "total_actual_spend": self.total_actual_spend(),
            "actual_spend_by_basis": actual_spend_by_basis_json(&self.actual_spend_by_basis()),
            "metered_view": metered_view_json(&self.metered_view()),
            "has_unresolved": self.has_unresolved(),
            "coverage": self.coverage.to_json(),
            "freshness": self.freshness.to_json(),
            "excluded_harnesses": self.excluded_harnesses.iter().cloned().collect::<Vec<_>>(),
            "last_observed_at": self.last_observed_at,
        })
    }
}

/// spec §3.1 的日粒度对应物——字段集与 `MonthlySummary` 一致（含
/// `excluded_harnesses`），因为"今天这个执行环境没接"跟"今天这个执行环境接了但没数据"
/// 必须能区分，道理与月度相同。
#[derive(Debug, Clone, PartialEq)]
pub struct DailySummary {
    /// "YYYY-MM-DD"。
    pub date: String,
    pub by_harness: BTreeMap<String, HarnessAmount>,
    /// 各执行环境的 token 计量，与 [`MonthlySummary::tokens_by_harness`] 同构。
    pub tokens_by_harness: BTreeMap<String, HarnessTokens>,
    /// billing_source 视角，键 `"harness/provider"`——与 [`MonthlySummary::
    /// by_provider`] 同一结构同一理由（执行环境内多提供方多币种，per-provider
    /// 条目才是干净归属）。月费摊销**不进日粒度**（订阅费不是日发生额），
    /// 这里只装按量/等价折算流。
    pub by_provider: BTreeMap<String, HarnessAmount>,
    pub coverage: CoverageStatus,
    pub freshness: Freshness,
    pub excluded_harnesses: BTreeSet<String>,
    pub last_observed_at: Option<String>,
}

impl DailySummary {
    /// 同 [`MonthlySummary::total_summable`]（fold 理由见
    /// [`HarnessAmount::summable_total`]——空负零）。
    pub fn total_summable(&self) -> f64 {
        self.by_harness
            .values()
            .map(HarnessAmount::summable_total)
            .fold(0.0, |a, b| a + b)
    }

    /// 真实总支出，按币种分栏——见 [`MonthlySummary::total_actual_spend`]。
    /// **日粒度的 summable 档只有按量流**（订阅费不摊进日账），所以这里的
    /// 值恒不包含 FixedSubscription——与月度同名方法对比时不得误读。
    pub fn total_actual_spend(&self) -> BTreeMap<String, f64> {
        let mut out: BTreeMap<String, f64> = BTreeMap::new();
        for h in self.by_provider.values() {
            let amount = h.summable_total();
            // 零金额不撑出币桶：`{"": 0.0}` 读起来像"有一笔未知币的 0 支出"，
            // 实际是"没有真实支出条目"——空 map 才是「无数据」的诚实形状
            // （fold(0.0) 正零纪律的同一条， negative-zero 教训的镜像面）。
            if amount == 0.0 {
                continue;
            }
            let key = h.currency.clone().unwrap_or_default();
            *out.entry(key).or_insert(0.0) += amount;
        }
        out
    }

    /// 同 [`MonthlySummary::actual_spend_by_basis`]；日粒度里恒无
    /// `FixedSubscription` 栏（订阅费不摊进日账）。
    pub fn actual_spend_by_basis(&self) -> BTreeMap<BillingBasis, BTreeMap<String, f64>> {
        actual_spend_by_basis(&self.by_provider)
    }

    /// 同 [`MonthlySummary::metered_view`]；日粒度没有月账单，所以永远不会出现
    /// `Actual`——账单按月，不摊到天。
    pub fn metered_view(&self) -> BTreeMap<String, MeteredView> {
        metered_view(&self.by_provider)
    }

    pub fn contract_violations(&self) -> Vec<String> {
        let mut violations = Vec::new();
        for harness in &self.excluded_harnesses {
            if self.by_harness.contains_key(harness) {
                violations.push(format!(
                    "excluded_harnesses 包含 {harness}，但 by_harness 里也有它——排除的执行环境\
                     不能同时贡献数据，那不是排除，是遗漏"
                ));
            }
            if self
                .by_provider
                .keys()
                .any(|k| k.split('/').next() == Some(harness.as_str()))
            {
                violations.push(format!(
                    "excluded_harnesses 包含 {harness}，但 by_provider 里仍有它的条目——\
                     排除的执行环境不能同时贡献数据，那不是排除，是遗漏"
                ));
            }
        }
        self.coverage.contract_violations(&mut violations, "coverage");
        self.freshness.contract_violations(&mut violations, "freshness");
        for harness_amount in self.by_harness.values() {
            harness_amount.contract_violations(&mut violations);
        }
        for provider_amount in self.by_provider.values() {
            provider_amount.contract_violations(&mut violations);
        }
        violations
    }

    pub fn to_json(&self) -> Value {
        let by_harness: serde_json::Map<String, Value> =
            self.by_harness.iter().map(|(id, amount)| (id.clone(), amount.to_json())).collect();
        let by_provider: serde_json::Map<String, Value> = self
            .by_provider
            .iter()
            .map(|(id, amount)| (id.clone(), amount.to_json()))
            .collect();
        json!({
            "date": self.date,
            "by_harness": Value::Object(by_harness),
            "tokens_by_harness": Value::Object(self.tokens_by_harness.iter()
                .map(|(id, t)| (id.clone(), t.to_json())).collect()),
            "by_provider": Value::Object(by_provider),
            "total_summable": self.total_summable(),
            "total_actual_spend": self.total_actual_spend(),
            "actual_spend_by_basis": actual_spend_by_basis_json(&self.actual_spend_by_basis()),
            "metered_view": metered_view_json(&self.metered_view()),
            "coverage": self.coverage.to_json(),
            "freshness": self.freshness.to_json(),
            "excluded_harnesses": self.excluded_harnesses.iter().cloned().collect::<Vec<_>>(),
            "last_observed_at": self.last_observed_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(at: &str) -> Freshness {
        Freshness { state: FreshnessState::Fresh, last_observed_at: Some(at.to_string()) }
    }

    fn coverage_ok() -> CoverageStatus {
        CoverageStatus { measured_fields: 3, total_fields: 5, denominator_version: 1 }
    }

    fn harness_amount(harness: &str, basis: BillingBasis, amount: f64) -> HarnessAmount {
        let mut amounts_by_basis = BTreeMap::new();
        amounts_by_basis.insert(basis, amount);
        HarnessAmount {
            harness_id: harness.to_string(),
            amounts_by_basis,
            currency: None,
            has_unresolved: false,
            evidence_basis: None,
            pricing_method: None,
            unresolved_reason: None,
            freshness: fresh("2026-09-01T00:00:00Z"),
        }
    }

    #[test]
    fn empty_summable_is_positive_zero_never_negative_zero() {
        // Stage 0.5 的 `data coverage --json` 暴露：空 `.sum()` 实测产出
        // -0.0，serde_json 原样序列化成 "-0.0"——无数据执行环境在冻结 DTO 里
        // 显示负零，读起来像"欠 0 元"。fold(0.0, …) 钉住正零；序列化面
        // 一起断言（修算术不修序列化会漏另一半）。
        let empty = HarnessAmount {
            harness_id: "dsh".to_string(),
            amounts_by_basis: BTreeMap::new(),
            currency: None,
            has_unresolved: false,
            evidence_basis: None,
            pricing_method: None,
            unresolved_reason: None,
            freshness: Freshness::unavailable(),
        };
        assert_eq!(empty.summable_total(), 0.0);
        assert!(empty.summable_total().is_sign_positive());
        let text = empty.to_json().to_string();
        assert!(!text.contains("-0.0"), "{text}");

        let summary = MonthlySummary {
            month: "2026-09".to_string(),
            by_harness: BTreeMap::from([("dsh".to_string(), empty)]),
            by_provider: BTreeMap::new(),
            tokens_by_harness: BTreeMap::new(),
            coverage: coverage_ok(),
            freshness: Freshness::unavailable(),
            excluded_harnesses: BTreeSet::new(),
            last_observed_at: None,
        };
        assert_eq!(summary.total_summable(), 0.0);
        assert!(summary.total_summable().is_sign_positive());
    }

    /// 2026-09-16 产品定向：「按量费用」= 账单 > 归因估算 > 默认估算，同 provider 内
    /// 取代（账单在就不看估算）、跨 provider 同币相加、跨币分栏；归因估算不进
    /// `total_actual_spend`（估算不冒充实付）。
    #[test]
    fn metered_view_prefers_bill_over_declared_over_default_estimate() {
        // 有账单的 provider：估算只进明细，不进 amount。
        let mut billed = harness_amount("claude-code/shengsuanyun", BillingBasis::MeteredActual, 452.0);
        billed.currency = Some("CNY".to_string());
        billed.amounts_by_basis.insert(BillingBasis::MeteredDeclared, 467.16);
        // 已归因、无账单：按归因估算显示。
        let mut declared = harness_amount("codex/shengsuanyun", BillingBasis::MeteredDeclared, 132.67);
        declared.currency = Some("USD".to_string());
        // 未归因：默认估算，且要点名。
        let mut unknown = harness_amount("claude-code/deepseek-official", BillingBasis::MeteredEstimate, 216.57);
        unknown.currency = Some("CNY".to_string());
        // 订阅条目：与按量视图无关。
        let mut sub = harness_amount("claude-code/anthropic", BillingBasis::FixedSubscription, 20.0);
        sub.currency = Some("USD".to_string());
        sub.amounts_by_basis.insert(BillingBasis::ApiEquivalent, 114.6);
        let summary = MonthlySummary {
            month: "2026-09".to_string(),
            by_harness: BTreeMap::new(),
            by_provider: BTreeMap::from([
                ("claude-code/shengsuanyun".to_string(), billed),
                ("codex/shengsuanyun".to_string(), declared),
                ("claude-code/deepseek-official".to_string(), unknown),
                ("claude-code/anthropic".to_string(), sub),
            ]),
            tokens_by_harness: BTreeMap::new(),
            coverage: coverage_ok(),
            freshness: Freshness::unavailable(),
            excluded_harnesses: BTreeSet::new(),
            last_observed_at: None,
        };
        let view = summary.metered_view();
        let cny = &view["CNY"];
        assert_eq!((cny.actual, cny.declared_estimate, cny.default_estimate), (452.0, 0.0, 216.57));
        assert!((cny.amount - 668.57).abs() < 1e-9, "账单取代该 provider 的估算，再与别家默认估算同币相加");
        assert_eq!(cny.label, MeteredLabel::Mixed);
        assert_eq!(cny.unattributed_providers, vec!["claude-code/deepseek-official".to_string()]);
        let usd = &view["USD"];
        assert_eq!((usd.amount, usd.declared_estimate), (132.67, 132.67));
        assert_eq!(usd.label, MeteredLabel::Estimate);
        assert!(usd.unattributed_providers.is_empty());
        // 归因估算不 summable：真实支出只有账单 + 月费。
        assert_eq!(summary.total_actual_spend(), BTreeMap::from([("CNY".to_string(), 452.0), ("USD".to_string(), 20.0)]));
        assert!(!BillingBasis::MeteredDeclared.summable_into_total());
        assert_eq!(BillingBasis::from_wire("metered_declared"), Some(BillingBasis::MeteredDeclared));
        let json = summary.to_json();
        assert_eq!(json["metered_view"]["CNY"]["label"], "mixed");
        assert_eq!(json["metered_view"]["USD"]["amount"], 132.67);
    }

    #[test]
    fn actual_spend_by_basis_partitions_total_actual_spend() {
        // 工作台「本月支出」卡分行显示按量实付 / 订阅月费——拆栏之和必须
        // 严格等于 total_actual_spend（分币），否则卡面与结论句两处会各说
        // 各话。非 summable 档（api_equivalent / metered_estimate）不得出现；
        // 零金额不撑桶（与 total_actual_spend 同一纪律）。
        let mut claude = harness_amount("claude-code/anthropic", BillingBasis::FixedSubscription, 20.0);
        claude.currency = Some("USD".to_string());
        claude.amounts_by_basis.insert(BillingBasis::ApiEquivalent, 114.6);
        let mut dsh = harness_amount("dsh/deepseek", BillingBasis::MeteredActual, 8.64);
        dsh.currency = Some("CNY".to_string());
        dsh.amounts_by_basis.insert(BillingBasis::MeteredEstimate, 9.0);
        let mut zero = harness_amount("codex/openai", BillingBasis::HarnessBilled, 0.0);
        zero.currency = Some("USD".to_string());
        let summary = MonthlySummary {
            month: "2026-09".to_string(),
            by_harness: BTreeMap::new(),
            by_provider: BTreeMap::from([
                ("claude-code/anthropic".to_string(), claude),
                ("dsh/deepseek".to_string(), dsh),
                ("codex/openai".to_string(), zero),
            ]),
            tokens_by_harness: BTreeMap::new(),
            coverage: coverage_ok(),
            freshness: Freshness::unavailable(),
            excluded_harnesses: BTreeSet::new(),
            last_observed_at: None,
        };
        let split = summary.actual_spend_by_basis();
        assert_eq!(
            split.get(&BillingBasis::MeteredActual),
            Some(&BTreeMap::from([("CNY".to_string(), 8.64)]))
        );
        assert_eq!(
            split.get(&BillingBasis::FixedSubscription),
            Some(&BTreeMap::from([("USD".to_string(), 20.0)]))
        );
        assert!(!split.contains_key(&BillingBasis::HarnessBilled), "零金额不撑桶");
        assert!(!split.contains_key(&BillingBasis::ApiEquivalent));
        assert!(!split.contains_key(&BillingBasis::MeteredEstimate));
        let mut recomposed: BTreeMap<String, f64> = BTreeMap::new();
        for cur in split.values() {
            for (c, v) in cur {
                *recomposed.entry(c.clone()).or_insert(0.0) += v;
            }
        }
        assert_eq!(recomposed, summary.total_actual_spend());
        let json = summary.to_json();
        assert_eq!(json["actual_spend_by_basis"]["metered_actual"]["CNY"], 8.64);
        assert_eq!(json["actual_spend_by_basis"]["fixed_subscription"]["USD"], 20.0);
        assert!(json["actual_spend_by_basis"].get("harness_billed").is_none());
    }

    #[test]
    fn billing_basis_from_str_roundtrips_as_str() {
        for b in [
            BillingBasis::FixedSubscription,
            BillingBasis::MeteredActual,
            BillingBasis::MeteredEstimate,
            BillingBasis::HarnessBilled,
            BillingBasis::ApiEquivalent,
        ] {
            assert_eq!(BillingBasis::from_wire(b.as_str()), Some(b));
        }
        assert_eq!(BillingBasis::from_wire("credits"), None);
        assert_eq!(BillingBasis::from_wire(""), None);
    }

    #[test]
    fn summable_basis_matches_spec_table_exactly() {
        // spec §4 的"能否冒充真实账单"列——这条测试就是把那张表翻成代码，
        // 表格改了这条测试必须跟着改，不能各说各话。
        assert!(BillingBasis::FixedSubscription.summable_into_total());
        assert!(BillingBasis::MeteredActual.summable_into_total());
        assert!(BillingBasis::HarnessBilled.summable_into_total());
        assert!(!BillingBasis::MeteredEstimate.summable_into_total());
        assert!(!BillingBasis::ApiEquivalent.summable_into_total());
    }

    #[test]
    fn harness_amount_total_sums_only_summable_basis() {
        let mut amounts_by_basis = BTreeMap::new();
        amounts_by_basis.insert(BillingBasis::MeteredActual, 10.0);
        amounts_by_basis.insert(BillingBasis::ApiEquivalent, 999.0); // 诊断用，不计入
        let h = HarnessAmount {
            harness_id: "codex".to_string(),
            amounts_by_basis,
            currency: None,
            has_unresolved: false,
            evidence_basis: None,
            pricing_method: None,
            unresolved_reason: None,
            freshness: fresh("2026-09-01T00:00:00Z"),
        };
        assert_eq!(h.summable_total(), 10.0);
    }

    #[test]
    fn workbuddy_credit_billing_is_harness_billed_not_metered_actual() {
        // memory: workbuddy-data-facts——WorkBuddy 按执行环境 credit_json 积分账单，
        // 不是逐请求 token 计价；混进 metered_actual 会让"这笔钱有没有 token
        // 证据支撑"这件事在下游变得不可判断。
        let h = harness_amount("workbuddy", BillingBasis::HarnessBilled, 215.0);
        assert_eq!(h.summable_total(), 215.0); // harness_billed 仍可汇总进总额
        assert!(!h.amounts_by_basis.contains_key(&BillingBasis::MeteredActual));
    }

    #[test]
    fn monthly_summary_totals_only_the_summable_bases() {
        let mut by_harness = BTreeMap::new();
        by_harness.insert("codex".to_string(), harness_amount("codex", BillingBasis::MeteredActual, 10.0));
        by_harness.insert(
            "claude-code".to_string(),
            harness_amount("claude-code", BillingBasis::MeteredEstimate, 999.0),
        );
        let summary = MonthlySummary {
            month: "2026-09".to_string(),
            by_harness,
            by_provider: BTreeMap::new(),
            tokens_by_harness: BTreeMap::new(),
            coverage: coverage_ok(),
            freshness: fresh("2026-09-04T00:00:00Z"),
            excluded_harnesses: BTreeSet::new(),
            last_observed_at: Some("2026-09-04T00:00:00Z".to_string()),
        };
        assert_eq!(summary.total_summable(), 10.0);
        assert!(summary.contract_violations().is_empty());
    }

    #[test]
    fn excluded_harness_present_in_by_harness_is_a_contract_violation() {
        let mut by_harness = BTreeMap::new();
        by_harness.insert("workbuddy".to_string(), harness_amount("workbuddy", BillingBasis::HarnessBilled, 1.0));
        let mut excluded_harnesses = BTreeSet::new();
        excluded_harnesses.insert("workbuddy".to_string());
        let summary = MonthlySummary {
            month: "2026-09".to_string(),
            by_harness,
            by_provider: BTreeMap::new(),
            tokens_by_harness: BTreeMap::new(),
            coverage: coverage_ok(),
            freshness: fresh("2026-09-04T00:00:00Z"),
            excluded_harnesses,
            last_observed_at: None,
        };
        let violations = summary.contract_violations();
        assert_eq!(violations.len(), 1, "{violations:?}");
        assert!(violations[0].contains("workbuddy"));
    }

    #[test]
    fn unavailable_freshness_with_a_timestamp_is_a_contract_violation() {
        let bad = Freshness {
            state: FreshnessState::Unavailable,
            last_observed_at: Some("2026-09-01T00:00:00Z".to_string()),
        };
        let summary = MonthlySummary {
            month: "2026-09".to_string(),
            by_harness: BTreeMap::new(),
            by_provider: BTreeMap::new(),
            tokens_by_harness: BTreeMap::new(),
            coverage: coverage_ok(),
            freshness: bad,
            excluded_harnesses: BTreeSet::new(),
            last_observed_at: None,
        };
        let violations = summary.contract_violations();
        assert_eq!(violations.len(), 1, "{violations:?}");
        assert!(violations[0].contains("Unavailable"));
    }

    #[test]
    fn freshness_unavailable_helper_has_no_timestamp() {
        // tests 是 data_contract 的子模块，可以直接摸私有方法——不用为了测
        // 一个私有校验器专门开一条 pub 后门。
        assert_eq!(Freshness::unavailable().last_observed_at, None);
        let mut v = Vec::new();
        Freshness::unavailable().contract_violations(&mut v, "test");
        assert!(v.is_empty());
    }

    #[test]
    fn coverage_measured_exceeding_total_is_a_contract_violation() {
        let bad = CoverageStatus { measured_fields: 9, total_fields: 5, denominator_version: 1 };
        let summary = MonthlySummary {
            month: "2026-09".to_string(),
            by_harness: BTreeMap::new(),
            tokens_by_harness: BTreeMap::new(),
            by_provider: BTreeMap::new(),
            coverage: bad,
            freshness: Freshness::unavailable(),
            excluded_harnesses: BTreeSet::new(),
            last_observed_at: None,
        };
        let violations = summary.contract_violations();
        assert!(violations.iter().any(|v| v.contains("measured_fields")), "{violations:?}");
    }

    #[test]
    fn daily_summary_mirrors_the_same_invariants() {
        let mut by_harness = BTreeMap::new();
        by_harness.insert("dsh".to_string(), harness_amount("dsh", BillingBasis::MeteredActual, 3.5));
        let summary = DailySummary {
            date: "2026-09-04".to_string(),
            by_harness,
            by_provider: BTreeMap::new(),
            tokens_by_harness: BTreeMap::new(),
            coverage: coverage_ok(),
            freshness: fresh("2026-09-04T12:00:00Z"),
            excluded_harnesses: BTreeSet::new(),
            last_observed_at: Some("2026-09-04T12:00:00Z".to_string()),
        };
        assert_eq!(summary.total_summable(), 3.5);
        assert!(summary.contract_violations().is_empty());
    }

    #[test]
    fn to_json_carries_summable_total_and_freshness_not_a_bare_scalar() {
        // spec §3.1："任何 UI 若只消费金额而丢弃这些字段，视为契约违规"——
        // 这条测试钉住 to_json() 的输出形状本身带着 freshness/coverage，
        // 不是一个裸 number。
        let mut by_harness = BTreeMap::new();
        by_harness.insert("codex".to_string(), harness_amount("codex", BillingBasis::MeteredActual, 10.0));
        let mut excluded_harnesses = BTreeSet::new();
        excluded_harnesses.insert("workbuddy".to_string());
        let summary = MonthlySummary {
            month: "2026-09".to_string(),
            by_harness,
            by_provider: BTreeMap::new(),
            tokens_by_harness: BTreeMap::new(),
            coverage: coverage_ok(),
            freshness: fresh("2026-09-04T00:00:00Z"),
            excluded_harnesses,
            last_observed_at: Some("2026-09-04T00:00:00Z".to_string()),
        };
        let v = summary.to_json();
        assert_eq!(v["total_summable"], json!(10.0));
        assert_eq!(v["excluded_harnesses"], json!(["workbuddy"]));
        assert_eq!(v["by_harness"]["codex"]["freshness"]["state"], json!("fresh"));
        assert_eq!(v["by_harness"]["codex"]["amounts_by_basis"]["metered_actual"], json!(10.0));
    }
}
