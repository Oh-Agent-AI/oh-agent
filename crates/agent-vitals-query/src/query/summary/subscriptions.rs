//! 订阅费/声明费/harness bills 的计费政策应用（「月费两条来源、声明优先」）。

use super::*;

/// Stage C：把已声明订阅的月费摊进 `by_provider` 的 `FixedSubscription` 档。
///
/// **这是「实际支出」缺失的另一半**：此前系统里订阅的钱根本不存在
/// （`FixedSubscription` 零写入方）——用户每月真金白银付的 $20 + ¥114 +
/// ¥118 不在任何账面，总额只收 DSH 按量。摊入后 `total_summable()`（它对
/// FixedSubscription 本来就返回 true，spec §4「固定订阅可以按口径汇总」）
/// 首次等于真实的月度总支出。
///
/// 三条纪律：
/// 1. **不付用量也在付**——用 `declared_subscriptions` 全量枚举，给没有用
///    量条目的 provider 补建条目（零用量的月份不能谎报成零支出）。执行环境归
///    属查 [`HARNESS_PROVIDER_MAP`]；映射不到的声明落 `unattributed/<provider>`
///    条目可见，不静默丢钱。
/// 2. **账期过滤**——查询月早于 `billing_period_start`（缺省 `reported_at`）
///    的月份不摊：GLM 2026-09-05 才买，摊进 8 月就是编造历史支出（claude-pro
///    填了真机 `oauthAccount.subscriptionCreatedAt=2025-07-20`，所以 8 月照摊）。
///    `YYYY-MM` 前缀字符串比较即时间序。
/// 3. **只进月、不进日**——本函数只在 `monthly_summary` 组装路径调用；
///    月费不是日发生额，按日摊会造出「今天花了 ¥3.93」这种不存在的事实。
///
/// 同一 provider 声明重复时 `declared_subscriptions` 的首条语义保证只摊一次。
pub(crate) fn apply_subscription_fees(
    by_provider: &mut BTreeMap<String, HarnessAmount>,
    month: &str,
    cards: &PricingCards,
    declared: &[DeclaredSubscriptionFee],
) {
    let pricing = cards.main.clone();
    for (provider, currency, amount, period_start) in
        agent_vitals_domain::cost::declared_subscriptions(&pricing)
    {
        // 声明优先：同一 provider 上用户已经在弹窗里声明过月费时，价目表这条让位，
        // 否则同一笔月费会被两条来源各摊一次（声明的落地见
        // `apply_declared_subscription_fees`）。
        if declared.iter().any(|fee| fee.provider == provider) {
            continue;
        }
        // 账期未开始不摊（None 理论不可达——declared_subscriptions 已回落
        // reported_at；防御性跳过而不是摊进所有历史）。
        let Some(start) = period_start.as_deref() else {
            continue;
        };
        // chars 而非字节切片：声明混入非 ASCII 时 [..7] 会 panic（billing 的
        // 脏数据纪律是显式可见，不是 panic）。
        let start_month: String = start.chars().take(7).collect();
        if month < start_month.as_str() {
            continue;
        }
        let harness = HARNESS_PROVIDER_MAP
            .iter()
            .find(|(_, providers)| providers.contains(&provider.as_str()))
            .map(|(harness, _)| harness.to_string())
            .unwrap_or_else(|| "unattributed".to_string());
        add_fixed_subscription_fee(by_provider, &format!("{harness}/{provider}"), &currency, amount);
    }
}

/// 一条**已声明订阅**的月费（`billing_declarations` 当前态的一行）。
pub(crate) struct DeclaredSubscriptionFee {
    /// **展示落点**，不是归属：订阅属于服务商账号，`by_provider` 的键是 `执行环境/服务商`，
    /// 所以给它挑一个执行环境放（见 [`fee_display_harness`]）。
    pub(crate) harness: String,
    pub(crate) provider: String,
    pub(crate) currency: String,
    pub(crate) amount: f64,
    pub(crate) start_month: String,
    pub(crate) end_month: Option<String>,
}

/// `created_at_ms` → 北京时间月份 `YYYY-MM`（与声明边界的时区纪律一致）。
fn beijing_month_of_ms(ms: i64) -> String {
    let (y, m, _d) = agent_vitals_domain::domain::util::civil_from_unix_secs(ms / 1000, 8 * 3600);
    format!("{y:04}-{m:02}")
}

fn month_prefix(value: &str) -> String {
    value.chars().take(7).collect()
}

/// 一条声明在**某个查询月**的适用月费（按修订链解析，改价不追溯）。
///
/// 规则（规格 §3.4）：
/// - 最新修订是 `revoked` → 整条作废，任何月份都不摊（撤销＝写错了）；
/// - 流水区间 = 首修订的 `effective_start` .. 最新 saved 修订的 `effective_end`（可空＝开放）；
/// - 对区间内的月份 M，适用修订 = 满足「区间覆盖 M」且「修订号 = 1 **或** 声明月 ≤ M」
///   的**最大修订号**。首修订允许回溯（订阅费自始就在付）；后续修订只从**声明那个月**起
///   改价——10 月改 ¥49，7–9 月仍是 ¥44，改价不重写历史。
///   退订不是撤销：补一条带 `effective_end` 的修订，过去的月照摊、到期的月停。
fn declared_fee_for_month(
    db: &agent_vitals_data::authority::AuthorityDb,
    declaration_id: &str,
    month: &str,
) -> Option<(f64, String, String, Option<String>)> {
    let revisions = db.billing_declaration_revisions(declaration_id).ok()?;
    let first = revisions.first()?;
    let latest = revisions.last()?;
    if latest.3 != "saved" { return None; } // revoked = 全链作废
    let stream_start = month_prefix(&first.11);
    let stream_end = latest.12.as_deref().map(month_prefix);
    if month < stream_start.as_str() { return None; }
    if stream_end.as_deref().is_some_and(|end| month > end) { return None; }
    let applicable = revisions.iter()
        .filter(|r| r.3 == "saved")
        .filter(|r| month_prefix(&r.11).as_str() <= month)
        .filter(|r| r.12.as_deref().map(month_prefix).map_or(true, |end| month <= end.as_str()))
        .filter(|r| r.2 == 1 || beijing_month_of_ms(r.15).as_str() <= month)
        .max_by_key(|r| r.2)?;
    let amount_minor = applicable.9?;
    let currency = applicable.10.clone()?;
    if amount_minor <= 0 || currency.trim().is_empty() { return None; }
    Some((amount_minor as f64 / 100.0, currency, stream_start, stream_end))
}

/// 把一笔月费落进 `by_provider` 的 `FixedSubscription` 档。
///
/// `HarnessAmount` 只有一个币种位：零用量纯月费条目（如 glm 无 token 的月份）此前
/// currency 为 None，月费会掉进 `total_actual_spend` 的无币桶——用声明币种补齐；
/// 与条目既有币种冲突（理论形状：同一 provider 两张币种不同的卡）时撤销币种 +
/// unresolved，绝不冒充单币。价目表与用户声明两条来源共用这一份，落地方式必须
/// 完全一致。
fn add_fixed_subscription_fee(
    by_provider: &mut BTreeMap<String, HarnessAmount>,
    key: &str,
    currency: &str,
    amount: f64,
) {
    let entry = by_provider
        .entry(key.to_string())
        .or_insert_with(|| HarnessAmount {
            harness_id: key.to_string(),
            amounts_by_basis: BTreeMap::new(),
            currency: None,
            has_unresolved: false,
            evidence_basis: None,
            pricing_method: None,
            unresolved_reason: None,
            freshness: Freshness::unavailable(),
        });
    *entry
        .amounts_by_basis
        .entry(BillingBasis::FixedSubscription)
        .or_insert(0.0) += amount;
    match &entry.currency {
        None => entry.currency = Some(currency.to_string()),
        Some(c) if c == currency => {}
        Some(_) => {
            entry.currency = None;
            entry.has_unresolved = true;
        }
    }
}

/// 账号级月费在 `by_provider`（键 `执行环境/服务商`）里的落点执行环境：服务商自家的执行环境优先
/// （anthropic → claude-code），其次是它用量最集中的执行环境，都没有才是 `unattributed`。
fn fee_display_harness(db: &agent_vitals_data::authority::AuthorityDb, provider: &str) -> String {
    HARNESS_PROVIDER_MAP
        .iter()
        .find(|(_, providers)| providers.contains(&provider))
        .map(|(harness, _)| harness.to_string())
        .or_else(|| db.dominant_harness_of_provider(provider).ok().flatten())
        .unwrap_or_else(|| "unattributed".to_string())
}

/// 当前有效的 `official_subscription` 声明 → 月费行。
///
/// 只认「当前态」表 `billing_declarations`：撤销会把它软删（`deleted_at_ms`），
/// 所以**撤销即停止扣**，不需要第二条撤销路径。`relationship_kind` 只认
/// `official_subscription`——其余四种按规格只记录关系、不改金额（§3 事实 1）。
/// 金额或币种缺失（用户在弹窗里勾了「金额暂不清楚」）跳过、不记 0，与
/// `declared_subscriptions` 对未声明金额的 openai 同一处理。
pub(crate) fn declared_subscription_fees(
    db: &agent_vitals_data::authority::AuthorityDb,
    month: &str,
) -> Vec<DeclaredSubscriptionFee> {
    let Ok(rows) = db.billing_declarations() else { return Vec::new() };
    let mut out = Vec::new();
    // **一个服务商只摊一次**：待确认组按"模型组"切，用户对同一订阅常会分
    // 两次声明（MiniMax-M3 一组、MiniMax-M2.7 一组），两条声明各带 ¥44——不去重就
    // 是 ¥88/月的双计。订阅是服务商账号的套餐，与执行环境无关，所以键是服务商本身；读取方 ORDER BY
    // （provider_id, effective_start, declaration_id）保证留下的第一条是**最早生效**的那条。占坑放在**产出月费之后**：
    // 「金额暂不清楚」的声明不产出月费，不能把后来带金额的声明挡掉。多账户同服务商
    // 的订阅当前模型表达不了，属规格 §3.4 的修订范围，不用去重冒充支持。
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (declaration_id, provider, kind, _name, _amount, _currency, _start, _end, _candidate) in rows
    {
        if kind != "official_subscription" { continue; }
        if provider.trim().is_empty() { continue; }
        // 月费按修订链对**查询月**解析（改价不追溯，见 `declared_fee_for_month`）。
        let Some((amount, currency, start_month, end_month)) =
            declared_fee_for_month(db, &declaration_id, month)
        else { continue; };
        if !seen.insert(provider.clone()) { continue; }
        out.push(DeclaredSubscriptionFee {
            harness: fee_display_harness(db, &provider),
            provider,
            currency,
            amount,
            start_month,
            end_month,
        });
    }
    out
}

/// 把**用户声明**的订阅月费摊进 `by_provider` 的 `FixedSubscription` 档。
///
/// **为什么必须走这里**：`apply_subscription_fees` 只枚举价目表里的
/// `catalog_2026_09.subscriptions`，而内置价目表没有这一节、设置页也只能写价卡与
/// 归属——于是用户在「明确计费方式」里填的月费在**任何一个数字上**都不出现
/// （2026-09-16 真机：声明了 anthropic 20 USD/月，概况「订阅月费」仍写
/// 「尚未设置套餐或账单」）。`BillingBasis::FixedSubscription` 的定义原话就是
/// 「**用户声明的**固定订阅费用」，这里把那个来源接上。
///
/// 账期纪律与 `apply_subscription_fees` 一致（早于生效月不摊，不凭空造出订阅前的
/// 支出），**多一条**：有结束月且查询月晚于它就不摊——订阅到期后继续收月费是编造。
/// 同样只进月、不进日（调用点只在 `monthly_summary`）。
pub(crate) fn apply_declared_subscription_fees(
    by_provider: &mut BTreeMap<String, HarnessAmount>,
    month: &str,
    declared: &[DeclaredSubscriptionFee],
) {
    for fee in declared {
        if month < fee.start_month.as_str() { continue; }
        if fee.end_month.as_deref().is_some_and(|end| month > end) { continue; }
        add_fixed_subscription_fee(
            by_provider,
            &format!("{}/{}", fee.harness, fee.provider),
            &fee.currency,
            fee.amount,
        );
    }
}

/// Phase 2.8（spec §5.3）：用户显式录入的 `harness_bills` 行 → `by_provider` 对应
/// 条目的 basis 桶。键 `{harness}/{provider}`，与 `apply_subscription_fees` 同款
/// 「找不到条目就新建、有就叠加」。跨币不相加——同 provider 同 basis 出现
/// 第二币种（理论上不该）→ 撤 currency + unresolved。`data harness-bill set` 的
/// 唯一消费面。
///
/// **在 `apply_subscription_fees` 之后跑**：主用途是 `harness_billed`（WorkBuddy
/// credit_json、中转对账单——价卡派生不出来的），不与订阅声明重叠。若用户
/// 又把已在 `pricing.json` 声明的订阅重复录成 `fixed_subscription` harness_bill，
/// 两者会叠进同一桶——那是录入责任（spec §5.3：这条路径专给非价卡来源），
/// 不在这里去重。
pub(crate) fn apply_harness_bills(
    by_provider: &mut BTreeMap<String, HarnessAmount>,
    db: &agent_vitals_data::authority::AuthorityDb,
    month: &str,
) {
    let rows = match db.harness_bills_for_period(month) {
        Ok(r) => r,
        Err(_) => return,
    };
    // `HarnessAmount` deliberately has one currency slot. Once a provider entry
    // has received two currencies, retain neither amounts nor a currency label;
    // otherwise a later row could re-claim one currency and make mixed money
    // look like a valid single-currency total.
    let mut currency_conflicted = BTreeSet::new();
    for (harness, provider, basis_str, amount_minor, currency) in rows {
        let Some(basis) = agent_vitals_domain::data_contract::BillingBasis::from_wire(&basis_str)
        else {
            continue;
        };
        let key = format!("{harness}/{provider}");
        let entry = by_provider
            .entry(key.clone())
            .or_insert_with(|| HarnessAmount {
                harness_id: key.clone(),
                amounts_by_basis: BTreeMap::new(),
                currency: None,
                has_unresolved: false,
                evidence_basis: None,
                pricing_method: None,
                unresolved_reason: None,
                freshness: Freshness::unavailable(),
            });
        if currency_conflicted.contains(&key) {
            continue;
        }
        let mut accepts_amount = false;
        match &entry.currency {
            None if !entry.has_unresolved => {
                entry.currency = Some(currency);
                accepts_amount = true;
            }
            Some(c) if *c == currency => accepts_amount = true,
            Some(_) => {
                entry.currency = None;
                entry.has_unresolved = true;
                entry.amounts_by_basis.clear();
                currency_conflicted.insert(key);
            }
            None => {}
        }
        if accepts_amount {
            *entry.amounts_by_basis.entry(basis).or_insert(0.0) += amount_minor as f64 / 100.0;
        }
    }
}

