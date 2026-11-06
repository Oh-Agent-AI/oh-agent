//! 按执行环境的金额折叠、provider 归因与 unresolved 下钻（dsh/codex/claude/workbuddy）。

use super::*;

/// 一份「日期 → 最新观测」的月度 `days` map → `HarnessAmount`。
///
/// `None`（`compute_month`/`read_month` 都诚实报 None——本月没有任何记录）
/// → 空 `amounts_by_basis` + `Freshness::unavailable()`：不是「花了 ¥0」，
/// 是「没有测到」（`data_contract.rs` 模块头不变式 3 的同一条纪律）。
pub(crate) fn dsh_harness_amount(cost: Option<serde_json::Value>, latest_day: Option<&str>) -> HarnessAmount {
    let mut amounts_by_basis = BTreeMap::new();
    // DeepSeek 官方逐 token 价表是 DSH 的真实计费费率（不是第三方猜测价），
    // `month_cost` 只是把「用了多少 token」按「官方多少钱一个 token」相乘——
    // 这是可观测的真实费用，定为 MeteredActual，不是 MeteredEstimate（§8.4）。
    //
    // **`compute_month` 对"本月有 day 但 day 里 token 全 0"返回 `Some({total:
    // 0, ...})`** —— 之前直接走 `MeteredActual=0 + Stale(latest_day)` 分支，
    // 前端渲染成「实测 0.00 + ⚠ 过期 · 观测 YYYY-MM-DD」，数字看着像"测到
    // 零"、实则是"本月没真实 token 入账"——违反 spec §0.1「不得渲染为 ¥0、
    // 正常或看似完整的总额」。修：先看 cost 的 total 是否为 0、为 0 → 不入
    // MeteredActual，只报 freshness（与 codex 无数据/claude 全 unknown 的
    // 纪律一致）；`has_unresolved=false` 是因为 DSH 的价表里所有模型都计价，
    // total=0 是 token 全 0 而不是"看见了、没价目"。
    let freshness = match (&cost, latest_day) {
        (Some(c), Some(day)) => {
            let total = c
                .get("total")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            if total > 0.0 {
                amounts_by_basis.insert(BillingBasis::MeteredActual, total);
            }
            day_freshness(day)
        }
        _ => Freshness::unavailable(),
    };
    HarnessAmount {
        harness_id: "dsh".to_string(),
        amounts_by_basis,
        currency: None,
        has_unresolved: false,
        // This summary is built from aggregated cost data; it does not itself
        // prove that every contributing row carried session-native evidence.
        evidence_basis: None,
        pricing_method: Some("provider-card".to_string()),
        unresolved_reason: None,
        freshness,
    }
}

/// Codex 用量 `by_hour_model` → `HarnessAmount`（§8.4 的 Codex 栏）。喂进来的
/// `by_hour_model` 从 SQL `usage_facts` 聚合（`SqlSummaryRepository`，
/// `agent_vitals_data::authority_query::codex_by_hour_model`）——Phase 4.3
/// 起 `SummaryRepository` 侧不再折 codex rollout。`unaccounted`/`plan` SQL
/// 事实里没有（无原始 fold 状态），传 `Value::Null` 安全：`codex_cost_report`
/// 只把它们原样透传
/// 进输出（`out.insert("unaccounted_usage", …)`/`out.insert("plan", …)`），
/// 从不参与 `total_cost_usd`/`days`/`unpriced_tokens` 的计算，而本函数只读
/// 这三个字段。
pub(crate) fn codex_harness_amount_with_tokens_from_hours(
    by_hour_model: &serde_json::Value,
    unaccounted: &serde_json::Value,
    plan: &serde_json::Value,
    day: Option<&str>,
    cards: &PricingCards,
) -> (HarnessAmount, HarnessTokens) {
    let codex_no_data = || HarnessAmount {
        harness_id: "codex".to_string(),
        amounts_by_basis: BTreeMap::new(),
        currency: None,
        has_unresolved: false,
        evidence_basis: None,
        pricing_method: None,
        unresolved_reason: None,
        freshness: Freshness::unavailable(),
    };

    let by_model = agent_vitals_harnesses::codex_usage::codex_by_model_from_hours(by_hour_model, None);
    let Some(report) = crate::sessions::codex_cost::codex_cost_report(
        by_hour_model,
        &by_model,
        unaccounted,
        plan,
        &cards.codex,
        false,
    ) else {
        return (codex_no_data(), HarnessTokens::default());
    };
    let days = report
        .get("days")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if days.is_empty() {
        return (codex_no_data(), HarnessTokens::default());
    }
    let total = match day {
        Some(d) => {
            let row = days
                .iter()
                .find(|x| x.get("date").and_then(|v| v.as_str()) == Some(d));
            match row {
                // 结构上不可达（过滤键 == 日期，days 必含该日）——但宁可再走
                // 一次 Unavailable 也不编 0。
                None => return (codex_no_data(), HarnessTokens::default()),
                Some(r) => r.get("cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0),
            }
        }
        None => report
            .get("total_cost_usd")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
    };
    let unpriced = report
        .get("unpriced_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let freshness = days
        .iter()
        .filter_map(|x| x.get("date").and_then(|v| v.as_str()))
        .max()
        .map(day_freshness)
        .unwrap_or_else(Freshness::unavailable);
    // basis 由 billing_modes 声明决定（Stage B），不再硬编码 ApiEquivalent。
    // 公共目录不会替用户声明订阅，因此缺少本地明确证据时落
    // MeteredEstimate，并保持 unresolved。plan 快照（plan_type/credits）
    // **不参与**判定：
    // 它是"当前状态"的单快照、不按日期分桶（harnesses/codex/sessions/usage.rs
    // 的 doc），拿它判历史窗口本身就是错的——快照与声明的冲突检测留给
    // Stage E 的证据链。
    let (basis, mode_unknown) =
        match agent_vitals_domain::cost::billing_mode_of("openai", &cards.main) {
            BillingMode::Subscription => (BillingBasis::ApiEquivalent, false),
            BillingMode::Metered => (BillingBasis::MeteredActual, false),
            BillingMode::Unknown => (BillingBasis::MeteredEstimate, true),
        };
    let mut amounts_by_basis = BTreeMap::new();
    amounts_by_basis.insert(basis, total);
    // tokens：过滤后重算的 by_model（model → speed → 5 桶）——merge 的
    // by_model 不读小时轴（函数体上方 defect 注释），必须用重算产物。
    let mut tk = HarnessTokens::default();
    if let Some(models) = by_model.as_object() {
        for (_model, speeds) in models {
            if let Some(speeds) = speeds.as_object() {
                for (_speed, b) in speeds {
                    let g = |k: &str| b.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
                    tk.uncached_input += g("uncached_input_tokens");
                    tk.cache_read += g("cached_input_tokens");
                    tk.cache_write += g("cache_write_input_tokens");
                    tk.output += g("output_tokens") + g("reasoning_output_tokens");
                }
            }
        }
    }
    tk.total = tk.uncached_input + tk.cache_read + tk.cache_write + tk.output;
    tk.cache_hit_ratio = agent_vitals_domain::cost::cache_hit_ratio(&json!({
        "uncached_input_tokens": tk.uncached_input,
        "cached_input_tokens": tk.cache_read,
        "cache_write_input_tokens": tk.cache_write,
    }));
    (
        HarnessAmount {
            harness_id: "codex".to_string(),
            amounts_by_basis,
            currency: None,
            has_unresolved: unpriced > 0 || mode_unknown,
            evidence_basis: None,
            pricing_method: Some("provider-card".to_string()),
            unresolved_reason: (unpriced > 0 || mode_unknown)
                .then(|| "missing-or-unpriced-route-evidence".to_string()),
            freshness,
        },
        tk,
    )
}

/// Claude Code 用量「窗口内账日 → `{model: 4 桶}`」map → `HarnessAmount`。
/// map 从 SQL `usage_facts` 聚合（`SqlSummaryRepository`，`authority_query::
/// {claude_days,claude_legacy_days}` 合并）——Phase 4.3 起不再读 ledger JSON。
/// `BTreeMap` 天然按日期升序迭代（同币求和的浮点顺序确定，跨平台字节一致）。
pub(crate) fn claude_harness_amount_with_tokens_from_days(
    days: &BTreeMap<String, serde_json::Value>,
    cards: &PricingCards,
) -> (HarnessAmount, HarnessTokens) {
    let claude_no_data = || {
        (
            HarnessAmount {
                harness_id: "claude-code".to_string(),
                amounts_by_basis: BTreeMap::new(),
                currency: None,
                has_unresolved: false,
                evidence_basis: Some("missing".to_string()),
                pricing_method: Some("fair-market-fallback".to_string()),
                unresolved_reason: None,
                freshness: Freshness::unavailable(),
            },
            HarnessTokens::default(),
        )
    };
    if days.is_empty() {
        return claude_no_data();
    }
    let mut tk = HarnessTokens::default();
    let pricing = cards.main.clone();
    let mut cny = 0.0f64;
    let mut usd = 0.0f64;
    let mut unpriced = 0i64;
    let mut any_partial = false;
    for day in days.values() {
        // tokens：四桶直读（claude snake 键 = 归一目标词表），跨模型累计。
        if let Some(models) = day.as_object() {
            for (_m, b) in models {
                let g = |k: &str| b.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
                tk.uncached_input += g("input_tokens");
                tk.cache_read += g("cache_read_input_tokens");
                tk.cache_write += g("cache_creation_input_tokens");
                tk.output += g("output_tokens");
            }
        }
        if let Some(report) = agent_vitals_domain::cost::claude_day_cost(day, &pricing) {
            let totals = report.get("currency_totals");
            cny += totals
                .and_then(|t| t.get("CNY"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            usd += totals
                .and_then(|t| t.get("USD"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            unpriced += report
                .get("unpriced_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            any_partial |= report.get("pricing_basis").and_then(|v| v.as_str()) == Some("partial");
        }
    }
    // freshness 的观测日 = 窗口内**最晚的账日**（含全 unknown 日——观测到
    // token 就是观测，与有没有折出钱无关）。
    let latest = days.keys().next_back().map(|k| k.as_str());
    let mut amounts_by_basis = BTreeMap::new();
    if cny > 0.0 {
        amounts_by_basis.insert(BillingBasis::MeteredEstimate, cny);
    }
    if usd > 0.0 {
        amounts_by_basis.insert(BillingBasis::MeteredEstimate, usd);
    }
    tk.total = tk.uncached_input + tk.cache_read + tk.cache_write + tk.output;
    tk.cache_hit_ratio = agent_vitals_domain::cost::cache_hit_ratio(&json!({
        "input_tokens": tk.uncached_input,
        "cache_read_input_tokens": tk.cache_read,
        "cache_creation_input_tokens": tk.cache_write,
    }));
    (
        HarnessAmount {
            harness_id: "claude-code".to_string(),
            amounts_by_basis,
            currency: None,
            has_unresolved: unpriced > 0 || any_partial,
            evidence_basis: Some("missing".to_string()),
            pricing_method: Some("fair-market-fallback".to_string()),
            unresolved_reason: (unpriced > 0 || any_partial)
                .then(|| "missing-provider-route-evidence".to_string()),
            freshness: latest
                .map(day_freshness)
                .unwrap_or_else(Freshness::unavailable),
        },
        tk,
    )
}

/// billing_source 视角的单条目聚合（`by_provider` 的值）：basis → 币种 → 金额
/// 三层。中间那层币种是跨币防线的落点——同一 provider 条目内若出现两种币
/// （当前价表不存在：目录卡币种按 provider 固定），金额表整体留空 +
/// `has_unresolved`，绝不跨币相加。
struct ProviderAcc {
    by_basis_currency: BTreeMap<BillingBasis, BTreeMap<String, f64>>,
    /// 条目级币种（HarnessAmount.currency）：per-provider 条目天然单币，出现第
    /// 二种币时置 None 并标 unresolved（finish 里金额表整体留空）。
    currency: Option<String>,
    /// 币种冲突已发生：冻结 currency=None，后续 add 不再重新认领。
    currency_conflicted: bool,
    unresolved: bool,
    latest: Option<String>,
}

impl ProviderAcc {
    fn new() -> Self {
        Self {
            by_basis_currency: BTreeMap::new(),
            currency: None,
            currency_conflicted: false,
            unresolved: false,
            latest: None,
        }
    }

    fn observe(&mut self, day: &str) {
        if self.latest.as_deref().map_or(true, |d| d < day) {
            self.latest = Some(day.to_string());
        }
    }

    fn add(&mut self, basis: BillingBasis, currency: &str, amount: f64) {
        // 条目币种一致性：per-provider 天然单币，出现第二种币 → 撤销声明
        // （currency=None）+ unresolved——finish 的单币判定靠它，不在这里
        // 对齐就会把 USD 和 CNY 静默装进同一条目冒充单币。
        match &self.currency {
            None if !self.currency_conflicted => self.currency = Some(currency.to_string()),
            Some(c) if c == currency => {}
            _ => {
                // 冲突后冻结：currency=None 且不再认领——否则后续同币种 add
                // 会走 None 分支重新认领，条目带着单一 currency 收尾，另一币
                // 金额在 total_actual_spend 里被按该币桶吞掉（审查 #8）。
                self.currency = None;
                self.currency_conflicted = true;
                self.unresolved = true;
            }
        }
        *self
            .by_basis_currency
            .entry(basis)
            .or_default()
            .entry(currency.to_string())
            .or_insert(0.0) += amount;
    }

    fn finish(mut self, key: &str) -> HarnessAmount {
        let mut amounts_by_basis = BTreeMap::new();
        let mut multi_currency = false;
        for (basis, cur_map) in self.by_basis_currency {
            if cur_map.len() > 1 {
                multi_currency = true;
                break;
            }
            if let Some((_, amount)) = cur_map.iter().next() {
                if *amount > 0.0 {
                    amounts_by_basis.insert(basis, *amount);
                }
            }
        }
        if multi_currency {
            amounts_by_basis.clear();
            self.currency = None;
            self.unresolved = true;
        }
        HarnessAmount {
            harness_id: key.to_string(),
            amounts_by_basis,
            currency: self.currency,
            has_unresolved: self.unresolved || multi_currency,
            // Aggregation preserves provider/pricing buckets but not a proof
            // that all rows had the same route-evidence basis.
            evidence_basis: (self.unresolved || multi_currency)
                .then(|| "missing".to_string()),
            pricing_method: Some("fair-market".to_string()),
            unresolved_reason: (self.unresolved || multi_currency)
                .then(|| "provider-or-currency-unresolved".to_string()),
            freshness: self
                .latest
                .as_deref()
                .map(day_freshness)
                .unwrap_or_else(Freshness::unavailable),
        }
    }
}

/// claude-code 窗口 → `by_provider`（键 `"claude-code/<provider>"`）。
/// 输入「窗口内账日 → `{model: 4 桶}`」map 从 SQL 聚合（Phase 4.3 起）。
fn claude_provider_amounts_from_days(
    days: &BTreeMap<String, serde_json::Value>,
    cards: &PricingCards,
) -> BTreeMap<String, HarnessAmount> {
    let mut accs: BTreeMap<String, ProviderAcc> = BTreeMap::new();
    if days.is_empty() {
        return accs
            .into_iter()
            .map(|(k, a)| {
                let harness = a.finish(&k);
                (k, harness)
            })
            .collect();
    }
    let pricing = cards.main.clone();
    for (date, day) in days {
        let Some(models) = day.as_object() else {
            continue;
        };
        let report = agent_vitals_domain::cost::claude_day_cost(day, &pricing);
        let per_model = report
            .as_ref()
            .and_then(|r| r.get("per_model"))
            .and_then(|v| v.as_object());
        // 有卡模型的归属与计价：per_model 的每条都是 {currency, total,
        // pricing_basis, priced_with}。
        if let Some(per_model) = per_model {
            for (model, entry) in per_model {
                // 用户尚未声明套餐/路由时，公共价卡仍能给出原厂供应商与
                // 名义金额。此时必须按量估算并标记待确认，不能因为
                // billing_modes 没有个人声明就把已有价卡金额丢掉。
                let card_provider = entry
                    .get("priced_with")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let (prov, mode, route_unresolved) =
                    match agent_vitals_domain::cost::billing_route_of(model, &pricing) {
                        Some((provider, mode)) => (provider, mode, mode == BillingMode::Unknown),
                        None => (card_provider.to_string(), BillingMode::Metered, true),
                    };
                let key = format!("claude-code/{prov}");
                let acc = accs.entry(key.clone()).or_insert_with(ProviderAcc::new);
                acc.observe(date);
                let total = entry.get("total").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let currency = entry
                    .get("currency")
                    .and_then(|v| v.as_str())
                    .unwrap_or("CNY");
                let basis = match mode {
                    BillingMode::Subscription => Some(BillingBasis::ApiEquivalent),
                    BillingMode::Metered => Some(BillingBasis::MeteredEstimate),
                    BillingMode::Unknown => None,
                };
                match basis {
                    Some(b) => acc.add(b, currency, total),
                    // 声明表不认识的模型有钱也无处归——不冒充任何档。
                    None => acc.unresolved = true,
                }
                if route_unresolved {
                    acc.unresolved = true;
                }
                if entry.get("pricing_basis").and_then(|v| v.as_str()) == Some("partial") {
                    acc.unresolved = true;
                }
            }
        }
        // 无卡模型（不在 per_model 里）：glm-*（有声明无价卡）、moonshot
        // （无声明）、<synthetic> 等。token 非零才算观测——全零模型不是
        // 消耗（MeasuredZero ≠ Unavailable 的镜像面）。
        for (model, tokens) in models {
            if per_model.map(|pm| pm.contains_key(model)).unwrap_or(false) {
                continue;
            }
            let total_tok: f64 = [
                "input_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
                "output_tokens",
            ]
            .iter()
            .map(|k| tokens.get(*k).and_then(|v| v.as_f64()).unwrap_or(0.0))
            .sum();
            if total_tok <= 0.0 {
                continue;
            }
            let (prov, _) = agent_vitals_domain::cost::billing_route_of(model, &pricing)
                .unwrap_or(("unknown".to_string(), BillingMode::Unknown));
            let key = format!("claude-code/{prov}");
            let acc = accs.entry(key).or_insert_with(ProviderAcc::new);
            acc.observe(date);
            acc.unresolved = true;
        }
    }
    accs.into_iter()
        .map(|(k, a)| {
            let harness = a.finish(&k);
            (k, harness)
        })
        .collect()
}

/// claude-code `by_provider` 的归因版（2026-09-16「归因以后按照归因的来计算」）：
/// 用户在计费声明里答过「经 X 按量付费」的事实（`user_declared`）从默认估算里
/// 拿出来，按 X 计 `MeteredDeclared`——X 的价卡收录该模型就用 X 的价，否则退回
/// 目录路由的官方价（`pricing_method` 如实标 fallback）。没答过的照旧走
/// [`claude_provider_amounts_from_days`]（`MeteredEstimate` + unresolved）。
/// 两部分之和 == 原先的全量估算：declared ⊆ realtime，从合并后的 days 里逐
/// (日, 模型) 减掉 declared 桶就是 undeclared，不需要第二条 SQL。
pub(crate) fn claude_provider_amounts_from_sql(
    db: &Option<agent_vitals_data::authority::AuthorityDb>,
    bounds: Option<(i64, i64)>,
    merged_days: &BTreeMap<String, serde_json::Value>,
    cards: &PricingCards,
) -> BTreeMap<String, HarnessAmount> {
    let declared = match (db, bounds) {
        (Some(db), Some((start, end))) => {
            agent_vitals_data::authority_query::claude_declared_days(db.conn(), start, end)
                .unwrap_or_default()
        }
        _ => BTreeMap::new(),
    };
    if declared.is_empty() {
        return claude_provider_amounts_from_days(merged_days, cards);
    }
    let mut undeclared = merged_days.clone();
    for days in declared.values() {
        subtract_claude_days(&mut undeclared, days);
    }
    let settlement = db.as_ref().and_then(|db| db.declared_settlement_currencies().ok()).unwrap_or_default();
    let mut out = claude_provider_amounts_from_days(&undeclared, cards);
    for (provider, days) in &declared {
        let declared_currency = settlement.get(provider.as_str()).map(String::as_str);
        for (key, amount) in declared_provider_amounts("claude-code", provider, days, cards, declared_currency) {
            match out.remove(&key) {
                Some(existing) => { out.insert(key, merge_harness_amounts(existing, amount)); }
                None => { out.insert(key, amount); }
            }
        }
    }
    out
}

/// `days -= declared`，逐 (日, 模型) 四桶相减；减到全零的模型/日整个移除
/// （空桶会让 `claude_day_cost` 报一个 0 元条目，看起来像"有用量但免费"）。
fn subtract_claude_days(days: &mut BTreeMap<String, serde_json::Value>, declared: &BTreeMap<String, serde_json::Value>) {
    for (day, models) in declared {
        let Some(target) = days.get_mut(day).and_then(|v| v.as_object_mut()) else { continue };
        let Some(models) = models.as_object() else { continue };
        for (model, buckets) in models {
            let Some(slot) = target.get_mut(model).and_then(|v| v.as_object_mut()) else { continue };
            let mut all_zero = true;
            for (k, v) in buckets.as_object().into_iter().flatten() {
                let cur = slot.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
                let next = (cur - v.as_i64().unwrap_or(0)).max(0);
                slot.insert(k.clone(), json!(next));
            }
            for v in slot.values() {
                if v.as_i64().unwrap_or(0) != 0 { all_zero = false; }
            }
            if all_zero { target.remove(model); }
        }
        if target.is_empty() { days.remove(day); }
    }
}

/// 一个已归因计费方的 claude 条目：逐日 `claude_day_cost_preferring` 计价，金额
/// 进 `MeteredDeclared`。`priced_with != provider` 的模型走了官方价 fallback，整条
/// 目标 `fair-market-fallback`；无价卡 / partial 的模型仍标 unresolved。
///
/// **按币分条目**：中转一次可能转多家（胜算云同时转 DeepSeek（CNY 卡）与
/// Anthropic（USD 卡）），fallback 价卡币种不一，而 `HarnessAmount` 单币——混进一
/// 条会触发多币冲突、金额整体清空（2026-09-16 真机：`claude-code/shengsuanyun`
/// 空条目 + no-price-card）。所以计费方卡片币种（无卡默认 CNY）的那份用基础键
/// `harness/provider`，其他币种追加第三段 `harness/provider/USD`——消费方只解析前两段
/// （JS `key.split("/")` 取 harness/provider；`apply_harness_bills` 等按基础键找）。
/// 执行环境无关的归因计价主体（claude 4 桶日 map 形状）；codex 的归因事实先转成同一
/// 形状再进来（`codex_declared_provider_amounts`）。
///
/// 结算币种仅来自用户声明；目录价卡只证明报价币种，不证明用户付款币种。
/// 退回原厂价卡时保留其报价原币种，并按币拆成 `harness/provider/CUR` 条目。
/// 历史估算不得在查询时按可变的 `fx_estimate` 折算。
fn declared_provider_amounts(
    harness: &str,
    provider: &str,
    days: &BTreeMap<String, serde_json::Value>,
    cards: &PricingCards,
    declared_currency: Option<&str>,
) -> Vec<(String, HarnessAmount)> {
    let pricing = cards.main.clone();
    // 基础键沿用 provider 价卡币种以兼容下游键匹配；这不是结算币种证据。
    let primary_currency = declared_currency
        .map(str::to_string)
        .or_else(|| agent_vitals_domain::cost::provider_quote_currency(provider, &pricing))
        .unwrap_or_else(|| "unknown".to_string());
    let mut accs: BTreeMap<String, ProviderAcc> = BTreeMap::new();
    let mut fallback: BTreeMap<String, bool> = BTreeMap::new();
    for (date, day) in days {
        let report = agent_vitals_domain::cost::claude_day_cost_preferring(day, &pricing, Some(provider));
        let per_model = report.as_ref().and_then(|r| r.get("per_model")).and_then(|v| v.as_object());
        let unpriced = report.as_ref().and_then(|r| r.get("unpriced_tokens")).and_then(|v| v.as_i64()).unwrap_or(0);
        let Some(per_model) = per_model else {
            // 没有任何模型可计价：有 token 但无价卡 → 挂在主币条目上标 unresolved（不冒充 0）。
            if agent_vitals_domain::cost::claude_day_total_tokens(day) > 0 {
                let acc = accs.entry(primary_currency.clone()).or_insert_with(ProviderAcc::new);
                acc.observe(date);
                acc.unresolved = true;
            }
            continue;
        };
        for entry in per_model.values() {
            let total = entry.get("total").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let currency = entry.get("currency").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
            let is_fallback = entry.get("priced_with").and_then(|v| v.as_str()) != Some(provider);
            let acc = accs.entry(currency.clone()).or_insert_with(ProviderAcc::new);
            acc.observe(date);
            acc.add(BillingBasis::MeteredDeclared, &currency, total);
            if is_fallback {
                fallback.insert(currency.clone(), true);
            }
            if entry.get("pricing_basis").and_then(|v| v.as_str()) == Some("partial") { acc.unresolved = true; }
        }
        if unpriced > 0 {
            let acc = accs.entry(primary_currency.clone()).or_insert_with(ProviderAcc::new);
            acc.observe(date);
            acc.unresolved = true;
        }
    }
    accs.into_iter().map(|(currency, acc)| {
        let key = if currency == primary_currency {
            format!("{harness}/{provider}")
        } else {
            format!("{harness}/{provider}/{currency}")
        };
        let mut h = acc.finish(&key);
        let is_fallback = fallback.get(&currency).copied().unwrap_or(false);
        h.pricing_method = Some(if is_fallback { "fair-market-fallback" } else { "provider-card" }.to_string());
        // 归因本身就是用户给的路由证据；unresolved 只剩价卡缺口。
        h.evidence_basis = Some("user-declared".to_string());
        h.unresolved_reason = h.has_unresolved.then(|| "no-price-card".to_string());
        (key, h)
    }).collect()
}

/// 同一 `harness/provider` 键上两条来源（默认估算 + 归因估算）合并：同币相加各
/// basis；币种不一致 → 金额表清空 + unresolved（HarnessAmount 单币纪律）。
fn merge_harness_amounts(mut a: HarnessAmount, b: HarnessAmount) -> HarnessAmount {
    match (&a.currency, &b.currency) {
        (Some(x), Some(y)) if x != y => {
            a.amounts_by_basis.clear();
            a.currency = None;
            a.has_unresolved = true;
            a.unresolved_reason = Some("provider-or-currency-unresolved".to_string());
            return a;
        }
        (None, Some(_)) => a.currency = b.currency.clone(),
        _ => {}
    }
    for (basis, amount) in b.amounts_by_basis {
        *a.amounts_by_basis.entry(basis).or_insert(0.0) += amount;
    }
    a.has_unresolved |= b.has_unresolved;
    if a.unresolved_reason.is_none() { a.unresolved_reason = b.unresolved_reason; }
    if matches!(a.freshness.state, FreshnessState::Unavailable) { a.freshness = b.freshness; }
    a
}

/// by_provider 的 DSH 条目：声明表里 deepseek-official = metered，官方逐
/// token 价是真实费率——与 `dsh_harness_amount` 的 MeteredActual 判定一致，
/// 条目即执行环境条目的镜像（Harness = BillingSource 的执行环境，键换名片）。
pub(crate) fn dsh_provider_amount(cost: Option<serde_json::Value>, latest_day: Option<&str>) -> HarnessAmount {
    let mut h = dsh_harness_amount(cost, latest_day);
    h.harness_id = "dsh/deepseek-official".to_string();
    h.currency = Some("CNY".to_string());
    h
}

/// Stage B（DoD #4 收口）：`has_unresolved` 的**逐模型下钻**——`data-unresolved`
/// 的服务面。各执行环境的 by_model 桶，逐模型判定 unresolved 原因：
///
/// - `billing-route-unknown`：`billing_route_of` 认不出归属（DSH/claude 词表；
///   codex 执行环境是 openai 订阅、路由是执行环境级的，不做模型级判定）；
/// - `billing-mode-unknown`：路由命中但模式声明为 unknown（合法状态，不猜）；
/// - `no-price-card`：模型在本执行环境价表里没有卡（unpriced_tokens 的逐模型
///   展开——聚合数说"有多少看不清"，这里说"是谁看不清"）；
/// - `partial-price-basis`：卡是时变价、日粒度无峰谷分辨率（`pricing_basis`
///   = "partial"，与 `has_unresolved` 的既有判定同源）。
///
/// - workbuddy（E4b）：整执行环境 `billing-route-unknown`——事实 provider 一律
///   null（三轨请求级不可判，WORKBUDDY_ONBOARDING §2.1），逐模型列出 token
///   量让「谁看不清」可见，键 `workbuddy/unknown`（与 claude 的 unknown 同约定）。
///
/// 报告键与 `by_provider` 同词表（`harness/provider`），消费方可以直接对上。
pub fn unresolved_detail(month: &str) -> serde_json::Value {
    use agent_vitals_domain::cost::BillingMode;
    let mut out: BTreeMap<String, Vec<serde_json::Value>> = BTreeMap::new();
    let db = SqlSummaryRepository::new().open_db();
    let bounds = agent_vitals_data::authority_query::beijing_month_bounds_ms(month);
    let cards = PricingCards::asof(&db, bounds.map(|(_, end)| end));
    let pricing = cards.main.clone();
    let (dsh_days, by_hour, claude_days) = fetch_windowed(&db, bounds);

    // ── claude-code：SQL 的实时事实优先 + 深历史聚合兜底，逐模型汇总 ────
    let mut claude_models: BTreeMap<String, [i64; 4]> = BTreeMap::new();
    let mut claude_priced: std::collections::HashSet<String> = Default::default();
    let mut claude_partial: std::collections::HashSet<String> = Default::default();
    for day in claude_days.values() {
        let Some(models) = day.as_object() else {
            continue;
        };
        for (model, buckets) in models {
            let g = |k: &str| buckets.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
            let entry = claude_models.entry(model.clone()).or_insert([0, 0, 0, 0]);
            entry[0] += g("input_tokens");
            entry[1] += g("cache_read_input_tokens");
            entry[2] += g("cache_creation_input_tokens");
            entry[3] += g("output_tokens");
        }
        // per_model = 有卡模型（claude_day_cost 的报告）；partial 基础逐模型
        // 记名（时变卡的日粒度近似，has_unresolved 同源）。
        if let Some(report) = agent_vitals_domain::cost::claude_day_cost(day, &pricing) {
            if let Some(per_model) = report.get("per_model").and_then(|v| v.as_object()) {
                for (model, entry) in per_model {
                    claude_priced.insert(model.clone());
                    if entry.get("pricing_basis").and_then(|v| v.as_str()) == Some("partial") {
                        claude_partial.insert(model.clone());
                    }
                }
            }
        }
    }
    for (model, tokens) in &claude_models {
        // 0-token 行不进下钻：没有可计价的用量，「unresolved」无从谈起。
        if tokens.iter().all(|&v| v == 0) {
            continue;
        }
        let reason = match agent_vitals_domain::cost::billing_route_of(model, &pricing) {
            None => Some("billing-route-unknown"),
            Some((_, BillingMode::Unknown)) => Some("billing-mode-unknown"),
            Some(_) if !claude_priced.contains(model) => Some("no-price-card"),
            Some(_) if claude_partial.contains(model) => Some("partial-price-basis"),
            _ => None,
        };
        if let Some(reason) = reason {
            let provider = agent_vitals_domain::cost::billing_route_of(model, &pricing)
                .map(|(provider, _)| provider)
                .unwrap_or_else(|| "unknown".to_string());
            out.entry(format!("claude-code/{provider}"))
                .or_default()
                .push(serde_json::json!({
                    "model": model,
                    "reason": reason,
                    "tokens": tokens[0] + tokens[1] + tokens[2] + tokens[3],
                }));
        }
    }

    // ── codex/openai：SQL 小时桶 vs 同一份 codex 价表 ──────────────────
    let codex_by_model = agent_vitals_harnesses::codex_usage::codex_by_model_from_hours(&by_hour, None);
    let codex_report = crate::sessions::codex_cost::codex_cost_report(
        &by_hour,
        &codex_by_model,
        &serde_json::Value::Null,
        &serde_json::Value::Null,
        &cards.codex,
        false,
    );
    let codex_priced: std::collections::HashSet<String> = codex_report
        .as_ref()
        .and_then(|report| report.get("per_model"))
        .and_then(|value| value.as_object())
        .map(|models| models.keys().cloned().collect())
        .unwrap_or_default();
    let codex_rows = codex_unresolved_rows(&codex_by_model, &codex_priced);
    if !codex_rows.is_empty() {
        out.entry("codex/openai".to_string())
            .or_default()
            .extend(codex_rows);
    }

    // ── dsh/deepseek-official：SQL 日桶逐模型聚合 ──────────────────────
    let mut dsh_by_model: serde_json::Map<String, serde_json::Value> = Default::default();
    for day in dsh_days
        .as_object()
        .map(|days| days.values())
        .into_iter()
        .flatten()
    {
        if let Some(models) = day.get("by_model").and_then(|value| value.as_object()) {
            for (model, buckets) in models {
                let entry = dsh_by_model
                    .entry(model.clone())
                    .or_insert(serde_json::json!({
                        "uncached_input_tokens": 0, "cache_read_tokens": 0,
                        "cache_write_tokens": 0, "output_tokens": 0,
                    }));
                for key in [
                    "uncached_input_tokens",
                    "cache_read_tokens",
                    "cache_write_tokens",
                    "output_tokens",
                ] {
                    let current = entry.get(key).and_then(|value| value.as_i64()).unwrap_or(0);
                    let added = buckets
                        .get(key)
                        .and_then(|value| value.as_i64())
                        .unwrap_or(0);
                    entry[key] = serde_json::json!(current + added);
                }
            }
        }
    }
    let dsh_usage = serde_json::json!({"by_model": dsh_by_model, "providers": {}});
    let dsh_priced: std::collections::HashSet<String> =
        agent_vitals_domain::cost::cost_report(&dsh_usage, &pricing)
            .as_ref()
            .and_then(|report| report.get("per_model"))
            .and_then(|value| value.as_object())
            .map(|models| models.keys().cloned().collect())
            .unwrap_or_default();
    for (model, buckets) in &dsh_by_model {
        if dsh_priced.contains(model) {
            continue;
        }
        let tokens = |key: &str| {
            buckets
                .get(key)
                .and_then(|value| value.as_i64())
                .unwrap_or(0)
        };
        let total = tokens("uncached_input_tokens")
            + tokens("cache_read_tokens")
            + tokens("cache_write_tokens")
            + tokens("output_tokens");
        if total == 0 {
            continue;
        }
        let reason = match agent_vitals_domain::cost::billing_route_of(model, &pricing) {
            None => "billing-route-unknown",
            Some((_, BillingMode::Unknown)) => "billing-mode-unknown",
            Some(_) => "no-price-card",
        };
        out.entry("dsh/deepseek-official".to_string())
            .or_default()
            .push(serde_json::json!({
                "model": model,
                "reason": reason,
                "tokens": total,
            }));
    }

    // ── workbuddy/unknown：SQL 逐模型直读，整执行环境 billing-route-unknown ────
    if let (Some(db), Some((start, end))) = (&db, bounds) {
        if let Ok(by_model) = agent_vitals_data::authority_query::hourly_by_harness_model(
            db.conn(),
            start,
            end,
            &["workbuddy".to_string()],
        ) {
            for ((_harness, model), hours) in by_model {
                let total: i64 = hours.values().map(|c| c.total()).sum();
                if total == 0 {
                    continue;
                }
                out.entry("workbuddy/unknown".to_string())
                    .or_default()
                    .push(serde_json::json!({
                        "model": model,
                        "reason": "billing-route-unknown",
                        "tokens": total,
                    }));
            }
        }
    }

    let mut obj = serde_json::Map::new();
    for (k, rows) in out {
        obj.insert(k, serde_json::Value::Array(rows));
    }
    serde_json::Value::Object(obj)
}

/// 为「确认计费方式」提供的权威事实分组。它不猜测付款方式，也不把无法
/// 安全相加的币种金额塞成一个数字；金额由后续会话级历史价卡投影补充。
/// 此处先保证交互入口拿到真实的作用范围、执行环境、模型、证据与会话规模。
pub fn unresolved_billing_groups(month: &str) -> serde_json::Value {
    let Some(db) = SqlSummaryRepository::new().open_db() else {
        return json!({"month": month, "groups": [], "status": "unavailable"});
    };
    unresolved_billing_groups_in(&db, month)
}

/// 组的定义只有一份：`authority_query::SQL_UNRESOLVED_BILLING_GROUPS`。这里只做
/// 月窗与序列化；金额由 `billing_preview::confirmation_groups` 用同一条计价路径补。
pub fn unresolved_billing_groups_in(
    db: &agent_vitals_data::authority::AuthorityDb, month: &str,
) -> serde_json::Value {
    let Some((start, end)) = agent_vitals_data::authority_query::beijing_month_bounds_ms(month) else {
        return json!({"month": month, "groups": [], "status": "invalid_month"});
    };
    let rows = match agent_vitals_data::authority_query::unresolved_billing_group_rows(db.conn(), start, end) {
        Ok(rows) => rows,
        Err(_) => return json!({"month": month, "groups": [], "status": "unavailable"}),
    };
    let groups = rows.into_iter().map(|row| json!({
        "group_id": format!("{}|{}|{}|{}|{}|{month}", row.harness, row.provider_id, row.model_id,
            row.evidence_basis, row.pricing_basis),
        "harness": row.harness, "provider_id": row.provider_id, "model_id": row.model_id,
        "evidence_basis": row.evidence_basis, "pricing_basis": row.pricing_basis,
        "tokens": row.tokens, "first_event_at_ms": row.first_event_at_ms,
        "last_event_at_ms": row.last_event_at_ms, "session_count": row.session_count,
        "effective_start": month, "effective_end": month,
        "estimated_cost_minor": serde_json::Value::Null,
    })).collect::<Vec<_>>();
    json!({"month": month, "groups": groups, "status": "ok"})
}

/// codex 下钻的纯分类核（可注入真实两层形状做钉测）：`by_model` 是
/// `model → speed → 桶对象`，桶键 = `CODEX_TOKEN_FIELDS` 5 键（形状来源：
/// `harnesses/codex/sessions/usage.rs::codex_by_model_from_hours`——审查 P1-1
/// 之前这段直读单层 + 错键名，codex 行永远被 0-token 过滤吞掉）。
/// 单日按小时分布（北京小时）——旧 calendar.html「小时格热力」组件的
/// 工作台接入（用户 2026-09-06 指出该组件从未接进控制面板）。
///
/// **数据源的诚实边界**（决定各执行环境什么时候缺席）：
/// - **DSH**：逐小时轴只存在于 `today.json` 的 `buckets`（`domain/state.rs`
///   merge_today 折叠产物）——month.json 的 day 对象没有 by_hour，历史日的
///   小时数据从未持久化。所以仅当请求日 == today.json 的 `date` 时可用。
/// - **Codex**：fold 的 `by_hour_model` 全量保留（`harnesses/codex/sessions/
///   usage.rs::codex_hour_of`，北京小时键 `YYYY-MM-DDTHH`），按 `date` 前缀
///   过滤即可得任意历史日。
/// - **Claude**：ledger 只有日轴（by_model 无小时）——小时只能来自事实
///   索引（ingest 过的会话）。
///
/// **来源矩阵**（`harnesses_available` 值即来源标注，消费方如实渲染）：
/// codex → `fold`（生产权威全量）；dsh → `today-json`（今日）/
/// `facts-index`（历史日，需该日会话被 ingest）；claude → `facts-index`。
/// 索引是「已 ingest 会话」的小时来源——只 ingest 了一部分时小时图是
/// 部分覆盖，来源标注让这一点在 UI 上可见。
///
/// 每小时值 = `null`（该执行环境该小时没有测量）≠ `0`（测到了零）——两态在
/// DTO 上都落 null，区分交给执行环境级 `harnesses_available`；「无小时轴」与
/// 「有轴没用量」不在小时粒度上区分（无诚实收益，徒增形状复杂度）。
pub(crate) fn codex_unresolved_rows(
    by_model: &serde_json::Value,
    priced: &std::collections::HashSet<String>,
) -> Vec<serde_json::Value> {
    const CODEX_TOKEN_FIELDS: [&str; 5] = [
        "uncached_input_tokens",
        "output_tokens",
        "cached_input_tokens",
        "cache_write_input_tokens",
        "reasoning_output_tokens",
    ];
    let mut rows = Vec::new();
    let Some(bm) = by_model.as_object() else {
        return rows;
    };
    for (model, speeds) in bm {
        if priced.contains(model) {
            continue;
        }
        // codex 执行环境路由是执行环境级（openai 订阅）——只判价卡。
        let mut total: i64 = 0;
        if let Some(sp) = speeds.as_object() {
            for bucket in sp.values() {
                for f in CODEX_TOKEN_FIELDS {
                    total += bucket.get(f).and_then(|v| v.as_i64()).unwrap_or(0);
                }
            }
        }
        if total == 0 {
            continue; // 0-token 行无可计价用量，不进下钻
        }
        rows.push(serde_json::json!({
            "model": model,
            "reason": "no-price-card",
            "tokens": total,
        }));
    }
    rows
}

/// `by_provider` 的 Codex 条目：`billing_mode_of("openai") = subscription`
/// → 等价标价口径。`codex_harness_amount_with_tokens_from_hours` 换个 harness_id。
fn codex_provider_amount_from_hours(
    by_hour_model: &serde_json::Value,
    day: Option<&str>,
    cards: &PricingCards,
) -> (HarnessAmount, HarnessTokens) {
    let (mut h, tk) = codex_harness_amount_with_tokens_from_hours(
        by_hour_model,
        &serde_json::Value::Null,
        &serde_json::Value::Null,
        day,
        cards,
    );
    h.harness_id = "codex/openai".to_string();
    h.currency = Some("USD".to_string());
    (h, tk)
}

/// Provider-aware Codex projection. OpenAI keeps the subscription/nominal
/// pricing path; custom or unknown routes are isolated and remain unresolved
/// instead of being silently priced as OpenAI.
pub(crate) fn codex_provider_amounts_from_sql(
    db: &Option<agent_vitals_data::authority::AuthorityDb>,
    bounds: Option<(i64, i64)>,
    day: Option<&str>,
    fallback: &serde_json::Value,
    cards: &PricingCards,
) -> BTreeMap<String, HarnessAmount> {
    let Some((start, end)) = bounds else {
        return BTreeMap::from([(String::from("codex/openai"), codex_provider_amount_from_hours(fallback, day, cards).0)]);
    };
    let Some(db) = db else { return BTreeMap::new(); };
    let grouped = agent_vitals_data::authority_query::codex_by_hour_provider_model(db.conn(), start, end).unwrap_or_default();
    let settlement = db.declared_settlement_currencies().unwrap_or_default();
    let mut out: BTreeMap<String, HarnessAmount> = BTreeMap::new();
    for ((provider, declared), hours) in grouped {
        let key = format!("codex/{provider}");
        if declared {
            let declared_currency = settlement.get(provider.as_str()).map(String::as_str);
            for (k, amount) in codex_declared_provider_amounts(&provider, &hours, day, cards, declared_currency) {
                match out.remove(&k) {
                    Some(existing) => { out.insert(k, merge_harness_amounts(existing, amount)); }
                    None => { out.insert(k, amount); }
                }
            }
        } else if provider == "openai" {
            let amount = codex_provider_amount_from_hours(&hours, day, cards).0;
            match out.remove(&key) {
                Some(existing) => { out.insert(key, merge_harness_amounts(existing, amount)); }
                None => { out.insert(key, amount); }
            }
        } else {
            // Custom/third-party routes are not OpenAI subscription usage, but
            // they still receive a fair-market estimate from the model card.
            // Keep it in the non-summable estimate bucket and mark unresolved;
            // never silently drop the tokens or label the estimate as actual.
            let model = agent_vitals_harnesses::codex_usage::codex_by_model_from_hours(&hours, None);
            if model.to_string().contains("uncached_input_tokens") {
                let (priced, _tokens) = codex_harness_amount_with_tokens_from_hours(
                    &hours,
                    &serde_json::Value::Null,
                    &serde_json::Value::Null,
                    day,
                    cards,
                );
                // The helper returns a non-summable model-card estimate. Read
                // whichever estimate basis applies and keep the custom route
                // in MeteredEstimate rather than treating it as an actual bill.
                let estimate = priced
                    .amounts_by_basis
                    .get(&BillingBasis::MeteredEstimate)
                    .or_else(|| priced.amounts_by_basis.get(&BillingBasis::ApiEquivalent))
                    .copied()
                    .unwrap_or(0.0);
                let mut amounts_by_basis = BTreeMap::new();
                if estimate > 0.0 {
                    amounts_by_basis.insert(BillingBasis::MeteredEstimate, estimate);
                }
                out.insert(key.clone(), HarnessAmount {
                    harness_id: key,
                    amounts_by_basis,
                    currency: Some("USD".to_string()),
                    has_unresolved: true,
                    // The SQL summary cannot establish session-native route
                    // evidence for the whole aggregate.
                    evidence_basis: Some("missing".to_string()),
                    pricing_method: Some("fair-market-fallback".to_string()),
                    unresolved_reason: Some("provider-specific-card-unavailable".to_string()),
                    freshness: day.map(day_freshness).unwrap_or_else(|| partial_freshness_of(&priced.freshness)),
                });
            }
        }
    }
    out
}

/// Codex 归因到某计费方的小时事实 → by_provider 条目（可能按币拆成两条）。
///
/// 该计费方价卡**收录**的模型按它的价、它的币种算（胜算云的 CNY 卡收录了就是
/// 人民币）；未收录的模型退回 Codex 唯一的官方价卡（OpenAI，USD），标
/// `fair-market-fallback`——「中转按量却显示美元」的来源就是这一支：不是币种
/// 填错了，是胜算云卡没收录 gpt-* 模型，只能按 OpenAI 标价估（2026-09-16）。
fn codex_declared_provider_amounts(
    provider: &str,
    hours: &serde_json::Value,
    day: Option<&str>,
    cards: &PricingCards,
    declared_currency: Option<&str>,
) -> Vec<(String, HarnessAmount)> {
    let pricing = cards.main.clone();
    // 这里只决定基础键的币种，不以目录卡币种证明用户结算币种。
    let primary_currency = declared_currency
        .map(str::to_string)
        .or_else(|| agent_vitals_domain::cost::provider_quote_currency(provider, &pricing))
        .unwrap_or_else(|| "unknown".to_string());
    // 按「声明卡是否收录」把小时桶拆成两份：收录的转成 claude 4 桶日 map 走归因
    // 计价；未收录的留在 codex 小时形状走 OpenAI 卡。
    let mut covered_days: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    let mut fallback_hours = serde_json::Map::new();
    for (hour, models) in hours.as_object().into_iter().flatten() {
        let Some(models) = models.as_object() else { continue };
        let date: String = hour.chars().take(10).collect();
        for (model, speeds) in models {
            // 声明卡收录 → 按它；否则目录里原厂官方卡（DeepSeek / MiniMax 的 CNY 卡）
            // → 「按原厂官方价估算」（用户定向 2026-09-17：默认用官方计价模板，不逼人
            // 手抄）；两者都没有（gpt-*）才退回 Codex 的 OpenAI 卡。
            if agent_vitals_domain::cost::official_card_for(model, &pricing, Some(provider)).is_some() {
                let day = covered_days.entry(date.clone()).or_insert_with(|| json!({}));
                let obj = day.as_object_mut().expect("day map is object");
                let bucket = obj.entry(model.clone()).or_insert_with(|| json!({
                    "input_tokens": 0, "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0, "output_tokens": 0}));
                for b in speeds.as_object().into_iter().flatten().map(|(_, b)| b) {
                    let g = |k: &str| b.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
                    for (dst, add) in [
                        ("input_tokens", g("uncached_input_tokens")),
                        ("cache_read_input_tokens", g("cached_input_tokens")),
                        ("cache_creation_input_tokens", g("cache_write_input_tokens")),
                        ("output_tokens", g("output_tokens") + g("reasoning_output_tokens")),
                    ] {
                        let cur = bucket.get(dst).and_then(|v| v.as_i64()).unwrap_or(0);
                        bucket[dst] = json!(cur + add);
                    }
                }
            } else {
                fallback_hours.entry(hour.clone()).or_insert_with(|| json!({}))
                    .as_object_mut().expect("hour map is object")
                    .insert(model.clone(), speeds.clone());
            }
        }
    }
    let mut out = if covered_days.is_empty() {
        Vec::new()
    } else {
        declared_provider_amounts("codex", provider, &covered_days, cards, Some(primary_currency.as_str()))
    };
    if !fallback_hours.is_empty() {
        let (priced, _tokens) = codex_harness_amount_with_tokens_from_hours(
            &serde_json::Value::Object(fallback_hours), &serde_json::Value::Null,
            &serde_json::Value::Null, day, cards,
        );
        let usd = priced.amounts_by_basis.values().copied().fold(0.0, |a, b| a + b);
        // OpenAI 卡是 USD；结算币不同或未知也不能用当前汇率改写历史估算。
        let (estimate, currency, method) = (usd, "USD".to_string(), "fair-market-fallback");
        let mut amounts_by_basis = BTreeMap::new();
        if estimate > 0.0 {
            amounts_by_basis.insert(BillingBasis::MeteredDeclared, estimate);
        }
        let base_key = format!("codex/{provider}");
        let amount = HarnessAmount {
            harness_id: base_key.clone(),
            amounts_by_basis,
            currency: Some(currency.clone()),
            has_unresolved: false,
            evidence_basis: Some("user-declared".to_string()),
            pricing_method: Some(method.to_string()),
            unresolved_reason: None,
            freshness: day.map(day_freshness).unwrap_or_else(|| priced.freshness.clone()),
        };
        // 同币并入主条目；异币另起第三段键，不跨币相加。
        match out.iter().position(|(k, _)| k == &base_key) {
            Some(i) if out[i].1.currency.as_deref() == Some(currency.as_str()) => {
                let (k, existing) = out.remove(i);
                out.push((k, merge_harness_amounts(existing, amount)));
            }
            Some(_) => {
                let key = format!("{base_key}/{currency}");
                let mut a = amount;
                a.harness_id = key.clone();
                out.push((key, a));
            }
            None if currency != primary_currency => {
                let key = format!("{base_key}/{currency}");
                let mut a = amount;
                a.harness_id = key.clone();
                out.push((key, a));
            }
            None => out.push((base_key, amount)),
        }
    }
    out
}

pub(crate) fn codex_harness_amount_provider_safe(
    db: &Option<agent_vitals_data::authority::AuthorityDb>,
    bounds: Option<(i64, i64)>,
    by_hour_model: &serde_json::Value,
    day: Option<&str>,
    cards: &PricingCards,
) -> (HarnessAmount, HarnessTokens) {
    let mixed = bounds.and_then(|(start, end)| db.as_ref().and_then(|db| {
        agent_vitals_data::authority_query::codex_by_hour_provider_model(db.conn(), start, end).ok()
    // 「混合路由」只算**没人认领**的非 openai 组：用户已归因到中转的那部分（declared）
    // 不再是未知路由，不该让 Codex 整执行环境降级成 Partial——否则费用明细里 OpenAI 订阅
    // 那行挂着「数据不完整」，用户以为归因没生效（2026-09-17）。
    })).map(|m| m.keys().any(|(p, declared)| p != "openai" && !declared)).unwrap_or(false);
    let (mut amount, tokens) = codex_harness_amount_with_tokens_from_hours(
        by_hour_model, &serde_json::Value::Null, &serde_json::Value::Null, day, cards,
    );
    if mixed {
        amount.amounts_by_basis.clear();
        amount.has_unresolved = true;
        amount.freshness = day.map(day_freshness).unwrap_or_else(|| partial_freshness_of(&amount.freshness));
    }
    (amount, tokens)
}

/// 混合/第三方路由的 Codex 条目：状态降为 Partial，但 `last_observed_at` 沿用
/// 从同一批小时事实算出的真实时间戳。此前这里写死 `"sql-facts"`——把来源
/// 标签塞进 RFC3339 字段（契约 `Freshness::last_observed_at` 注释），工作台
/// 费用明细按日期切片后显示成「最后更新 acts」（2026-09-15 真机截图）。
fn partial_freshness_of(base: &Freshness) -> Freshness {
    match &base.last_observed_at {
        Some(at) => Freshness { state: FreshnessState::Partial, last_observed_at: Some(at.clone()) },
        None => Freshness::unavailable(),
    }
}

/// WorkBuddy 栏（E4b）：**只有 token、没有金额**。四桶从 SQL `usage_facts` 直接
/// 聚合（`harness_window_tokens`）；金额一律不填——每条事实 `provider_id: null`、
/// `pricing_basis: metered_estimate`、`evidence_basis: missing`（§2.1 三轨不可判），
/// 没有可归属的价卡，`amounts_by_basis` 空 + `has_unresolved: true` +
/// `unresolved_reason: billing-route-unknown`（`data-unresolved` 同一词表）。
/// 窗口内无事实 → Unavailable（不是 0）。**不进 `by_provider`**：provider 为
/// null 的事实没有 `harness/provider` 键可挂。
pub(crate) fn workbuddy_harness_amount_with_tokens(
    db: &Option<agent_vitals_data::authority::AuthorityDb>,
    bounds: Option<(i64, i64)>,
) -> (HarnessAmount, HarnessTokens) {
    let window = match (db, bounds) {
        (Some(db), Some((start, end))) => {
            agent_vitals_data::authority_query::harness_window_tokens(
                db.conn(),
                "workbuddy",
                start,
                end,
            )
            .ok()
            .flatten()
        }
        _ => None,
    };
    let mut amount = HarnessAmount {
        harness_id: "workbuddy".to_string(),
        amounts_by_basis: BTreeMap::new(),
        currency: None,
        has_unresolved: false,
        evidence_basis: None,
        pricing_method: None,
        unresolved_reason: None,
        freshness: Freshness::unavailable(),
    };
    let Some(w) = window else {
        return (amount, HarnessTokens::default());
    };
    amount.has_unresolved = true;
    amount.evidence_basis = Some("missing".to_string());
    amount.unresolved_reason = Some("billing-route-unknown".to_string());
    amount.freshness = day_freshness(&w.latest_day);
    let mut tk = HarnessTokens {
        uncached_input: w.uncached_input,
        cache_read: w.cache_read,
        cache_write: w.cache_write,
        output: w.output,
        ..HarnessTokens::default()
    };
    tk.total = tk.uncached_input + tk.cache_read + tk.cache_write + tk.output;
    tk.cache_hit_ratio = agent_vitals_domain::cost::cache_hit_ratio(&json!({
        "uncached_input_tokens": tk.uncached_input,
        "cache_read_tokens": tk.cache_read,
        "cache_write_tokens": tk.cache_write,
    }));
    (amount, tk)
}

/// DSH 窗口（`days` map 或单日值）的 token 计量：DSH 四桶词表直读
/// （`uncached_input_tokens` 词表，与 claude/codex 不同——见 fixtures/v09
/// 的 _doc）。`window` 是月份前缀或完整日期。
/// 单个 DSH day 对象 → token 计量。**两种形状都认**（镜像 `priced_day` 的
/// 双形状处理）：正常管线的 day 顶层有 `merge_buckets` 折叠出的四桶字段；
/// 只有 `by_model` 有量、顶层零桶的变形日（跨零点切片等）走 `by_model`
/// 逐模型累加回退——审查 #2：此前日度路径把单日对象塞进按 {date: day} map
/// 设计的过滤，字段名键永远不命中窗口前缀 → DSH 的「今日 tokens」恒零
/// （假零，MeasuredZero≠Unavailable 纪律的违例）。
pub(crate) fn dsh_day_tokens(day: &serde_json::Value) -> HarnessTokens {
    let mut tk = HarnessTokens::default();
    let g =
        |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0) as i64;
    tk.uncached_input = g(day, "uncached_input_tokens");
    tk.cache_read = g(day, "cache_read_tokens");
    tk.cache_write = g(day, "cache_write_tokens");
    tk.output = g(day, "output_tokens");
    if tk.uncached_input + tk.cache_read + tk.cache_write + tk.output == 0 {
        // 顶层零桶：by_model 回退（逐模型同词表四桶）。
        if let Some(models) = day.get("by_model").and_then(|v| v.as_object()) {
            for (_m, b) in models {
                tk.uncached_input += g(b, "uncached_input_tokens");
                tk.cache_read += g(b, "cache_read_tokens");
                tk.cache_write += g(b, "cache_write_tokens");
                tk.output += g(b, "output_tokens");
            }
        }
    }
    tk.total = tk.uncached_input + tk.cache_read + tk.cache_write + tk.output;
    tk.cache_hit_ratio = agent_vitals_domain::cost::cache_hit_ratio(&json!({
        "uncached_input_tokens": tk.uncached_input,
        "cache_read_tokens": tk.cache_read,
        "cache_write_tokens": tk.cache_write,
    }));
    tk
}

/// DSH 窗口（`days` map 或单日值）的 token 计量：逐日过 [`dsh_day_tokens`]。
pub(crate) fn dsh_tokens(days: Option<&serde_json::Value>, window: &str) -> HarnessTokens {
    let mut tk = HarnessTokens::default();
    if let Some(days) = days.and_then(|d| d.as_object()) {
        for (date, day) in days {
            if !date.starts_with(window) {
                continue;
            }
            let day_tk = dsh_day_tokens(day);
            tk.uncached_input += day_tk.uncached_input;
            tk.cache_read += day_tk.cache_read;
            tk.cache_write += day_tk.cache_write;
            tk.output += day_tk.output;
        }
    }
    tk.total = tk.uncached_input + tk.cache_read + tk.cache_write + tk.output;
    tk.cache_hit_ratio = agent_vitals_domain::cost::cache_hit_ratio(&json!({
        "uncached_input_tokens": tk.uncached_input,
        "cache_read_tokens": tk.cache_read,
        "cache_write_tokens": tk.cache_write,
    }));
    tk
}

/// claude 窗口内的账日：实时行级事实优先，`legacy_aggregate` 深历史只填
/// 实时缺席的日期——先铺 legacy 再用实时 `extend` 覆盖同键，`BTreeMap::
/// extend` 后写赢，天然实现"有实时用实时、没有才退回 ledger 深历史"
/// （spec §6.2.3：ledger 是现文件重放不到的那部分账的 store of record，
/// 不是与实时并列的第二份真相——两者本就不该在同一天都有数据）。
pub(crate) fn merged_claude_days(
    conn: &rusqlite::Connection,
    start_ms: i64,
    end_ms: i64,
) -> BTreeMap<String, serde_json::Value> {
    // **模型级合并**（2026-09-07 审查收口）：旧实现 `days.extend(realtime)`
    // 是整日替换——同日只要任一模型有实时行，该日全部 legacy 聚合（含其他
    // 模型的桶）被整体丢弃，「A 实时 + B legacy」表达不了，B 无标记消失。
    // 改为按 (日, 模型) 选源：legacy 铺底，实时按模型键覆盖——同键不双计
    // （每 (日,模型) 只有一个来源），异键互补（轮转掉 B 的会话文件时 B 的
    // 聚合仍可见）。真机核验：ledger days 与 SQL 行级只差 ~1.7%，当前损失
    // 趋近于零，但结构上必须正确——轮转发生时这里就是唯一防线。
    let mut days = agent_vitals_data::authority_query::claude_legacy_days(conn, start_ms, end_ms)
        .unwrap_or_default();
    let realtime =
        agent_vitals_data::authority_query::claude_days(conn, start_ms, end_ms).unwrap_or_default();
    for (day, models) in realtime {
        let entry = days.entry(day).or_insert_with(|| serde_json::json!({}));
        let obj = entry.as_object_mut().expect("claude day entry is object");
        if let Some(models) = models.as_object() {
            for (model, buckets) in models {
                obj.insert(model.clone(), buckets.clone());
            }
        }
    }
    days
}

/// 测试穿透（integration 测试 `q_acceptance.rs` 的分离纪律用例）。
#[doc(hidden)]
pub fn merged_claude_days_for_tests(
    conn: &rusqlite::Connection,
    start_ms: i64,
    end_ms: i64,
) -> BTreeMap<String, serde_json::Value> {
    merged_claude_days(conn, start_ms, end_ms)
}

/// 该月（或该日所属月）的 claude 数据是否带 legacy_aggregate 兜底标记
/// （`data_quality_issues` 里未解决的 `code='legacy_aggregate'` 行，
/// scope_key = 具体月份或 'all'）。命中 → 摘要侧 claude 的 freshness 降为
/// `Partial`——「这个月有聚合兜底的成分」必须在 UI 可见（审查收口：标记
/// 此前只写不读，spec §6.2.3「查询方据此降级」没有消费方，legacy 月份照常
/// 渲染 Fresh）。
fn claude_legacy_backed(conn: &rusqlite::Connection, month: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM data_quality_issues
         WHERE resolved_at_ms IS NULL AND code = 'legacy_aggregate'
           AND scope_type = 'month'
           AND (scope_key = ?1 OR scope_key = 'all')",
        rusqlite::params![month],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// claude 执行环境条目的 freshness 按 legacy 兜底标记降级（Fresh/Stale →
/// Partial；Unavailable 保持——「从没观测到」不因标记变成「部分观测到」）。
pub(crate) fn degrade_claude_freshness_if_legacy_backed(
    conn: &rusqlite::Connection,
    month: &str,
    amount: &mut HarnessAmount,
) {
    if amount.freshness.state == FreshnessState::Unavailable {
        return;
    }
    if claude_legacy_backed(conn, month) {
        amount.freshness.state = FreshnessState::Partial;
    }
}

/// 打开库 + 算好窗口边界后，三执行环境共用的原始数据抓取——月/日两条路径都是
/// 「先拿这三份，再喂各自计价函数」，抽出来避免 monthly/daily 各写一份
/// 一模一样的 `match (&db, bounds) { … }`。库打不开或窗口非法（无效
/// 月份/日期字符串）一律退化成空输入，见结构体文档。
pub(crate) fn fetch_windowed(
    db: &Option<agent_vitals_data::authority::AuthorityDb>,
    bounds: Option<(i64, i64)>,
) -> (
    serde_json::Value,
    serde_json::Value,
    BTreeMap<String, serde_json::Value>,
) {
    match (db, bounds) {
        (Some(db), Some((start, end))) => {
            let conn = db.conn();
            (
                agent_vitals_data::authority_query::peaked_days_map(conn, "dsh", start, end)
                    .unwrap_or_else(|_| json!({})),
                agent_vitals_data::authority_query::codex_by_hour_model(conn, start, end)
                    .unwrap_or_else(|_| json!({})),
                merged_claude_days(conn, start, end),
            )
        }
        _ => (json!({}), json!({}), BTreeMap::new()),
    }
}

/// `tokens_by_harness` 必须是**全量**处理量：金额面的三条聚合（claude_days /
/// codex_by_hour_model / peaked_days_map）都排除了订阅覆盖的事实——那是「钱归谁」
/// 的口径；token 是「处理了多少」的口径，订阅内的 token 同样发生过。此前两者
/// 共用一份聚合，codex 订阅声明一生效，本月用量从 2.8B 缩成 569M（2026-09-16
/// 真机）。这里用 `harness_tokens_all` 把三执行环境的 4 桶换回全量；命中率照 domain
/// 的同一条公式重算。SQL 读不到时保留金额面的数（比冒充 0 诚实）。WorkBuddy
/// 不在这里：它的 4 桶来自 `workbuddy_harness_amount_with_tokens` 自己的全量查询。
/// manifest 执行环境（`harness:<slug>`）的 tokens 行。
/// **只有处理量、没有金额**——与 workbuddy 上线时同一条 L0 纪律（§9E.5：
/// 处理量必须可见，金额等 billing 声明面）；`harness_tokens_all` 是 harness 参数化
/// 的通用查询，天然覆盖任意 harness 值。执行环境集合来自窗口内有效事实，而非
/// 可变候选或当前激活集合；卸载不抹掉历史处理量。
pub(crate) fn plugin_tokens_by_harness(
    _data_home: &std::path::Path,
    db: &Option<agent_vitals_data::authority::AuthorityDb>,
    bounds: Option<(i64, i64)>,
) -> Vec<(String, HarnessTokens)> {
    let (Some(db), Some((start, end))) = (db, bounds) else {
        return Vec::new();
    };
    let harnesses = match agent_vitals_data::authority_query::token_totals_by_harness(db.conn(), start, end) {
        Ok(harnesses) => harnesses,
        Err(error) => {
            crate::core::logging::log_warn("summary", &format!("manifest usage query failed: {error}"));
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for harness_label in harnesses.into_keys().filter(|harness| harness.strip_prefix("harness:")
        .is_some_and(crate::harness_registry::plugin_slug_ok)) {
        let Ok(Some((u, cr, cw, o))) =
            agent_vitals_data::authority_query::harness_tokens_all(db.conn(), &harness_label, start, end)
        else {
            continue;
        };
        let cache_hit_ratio = agent_vitals_domain::cost::cache_hit_ratio(&json!({
            "uncached_input_tokens": u,
            "cached_input_tokens": cr,
            "cache_write_input_tokens": cw,
        }));
        out.push((harness_label, HarnessTokens {
            total: u + cr + cw + o,
            uncached_input: u,
            cache_read: cr,
            cache_write: cw,
            output: o,
            cache_hit_ratio,
        }));
    }
    out
}

pub(crate) fn restore_full_harness_tokens(
    db: &Option<agent_vitals_data::authority::AuthorityDb>,
    bounds: Option<(i64, i64)>,
    tokens_by_harness: &mut BTreeMap<String, HarnessTokens>,
) {
    let (Some(db), Some((start, end))) = (db, bounds) else { return };
    for harness in ["dsh", "codex", "claude-code"] {
        let Ok(Some((u, cr, cw, o))) =
            agent_vitals_data::authority_query::harness_tokens_all(db.conn(), harness, start, end)
        else {
            continue;
        };
        let cache_hit_ratio = agent_vitals_domain::cost::cache_hit_ratio(&json!({
            "uncached_input_tokens": u,
            "cached_input_tokens": cr,
            "cache_write_input_tokens": cw,
        }));
        tokens_by_harness.insert(harness.to_string(), HarnessTokens {
            total: u + cr + cw + o,
            uncached_input: u,
            cache_read: cr,
            cache_write: cw,
            output: o,
            cache_hit_ratio,
        });
    }
}

#[cfg(test)]
mod fx_regression_tests {
    use super::*;

    #[test]
    fn declared_fallback_estimate_does_not_follow_current_fx() {
        let mut cards = PricingCards {
            main: agent_vitals_domain::cost::load_pricing(),
            codex: crate::sessions::codex_cost::load_codex_pricing(),
        };
        let days = BTreeMap::from([(
            "2026-09-24".to_string(),
            json!({"anthropic/claude-sonnet-5": {
                "input_tokens": 1_000_000,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
                "output_tokens": 100_000
            }}),
        )]);
        cards.main["fx_estimate"]["USD_CNY"] = json!(6.8);
        let first = declared_provider_amounts("claude-code", "shengsuanyun", &days, &cards, Some("CNY"));
        cards.main["fx_estimate"]["USD_CNY"] = json!(7.5);
        let later = declared_provider_amounts("claude-code", "shengsuanyun", &days, &cards, Some("CNY"));
        assert_eq!(first, later);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].0, "claude-code/shengsuanyun/USD");
        assert_eq!(first[0].1.currency.as_deref(), Some("USD"));
    }
}

#[cfg(test)]
mod manifest_history_tests {
    use super::plugin_tokens_by_harness;
    use serde_json::json;
    use std::collections::BTreeMap;
    use agent_vitals_data::authority::AuthorityDb;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture { home: PathBuf, db: Option<AuthorityDb> }
    impl Fixture {
        fn new() -> Self {
            let home = std::env::temp_dir().join(format!("vitals-manifest-history-{}-{}",
                std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            let db = AuthorityDb::open(&agent_vitals_data::authority::default_authority_path(&home), 1).unwrap();
            db.begin_run("history", "cli", 1).unwrap();
            Self { home, db: Some(db) }
        }
        fn insert(&self, id: &str, harness: &str, time: i64, deleted: Option<i64>, tokens: [i64; 4]) {
            self.db.as_ref().unwrap().conn().execute(
                "INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,
                 source_event_id,observation_kind,event_ts_ms,deleted_at_ms,
                 uncached_input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,
                 ingested_run_id,created_at_ms,updated_at_ms)
                 VALUES(?1,?2,'machine','session',?1,'token_count',?3,?4,?5,?6,?7,?8,'history',1,1)",
                rusqlite::params![id, harness, time, deleted, tokens[0], tokens[1], tokens[2], tokens[3]]).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            drop(self.db.take());
            let _ = std::fs::remove_dir_all(&self.home);
        }
    }

    #[test]
    fn historical_facts_survive_missing_candidate_and_empty_activation() {
        use agent_vitals_data::extension_authority::*;
        let fixture = Fixture::new();
        fixture.insert("retained", "harness:zcode", 1000, None, [100, 50, 10, 5]);
        let conn = fixture.db.as_ref().unwrap().conn();
        let revision = ExtensionRevision { revision_id:"removed-harness".into(),
            slot_type:"harness_manifest".into(), slot_id:"zcode".into(), content_sha256:"a".repeat(64),
            origin:RevisionOrigin::Local, schema_version:1, capabilities:json!({}), installed_at_ms:1 };
        let slots = BTreeMap::from([(("harness_manifest".into(), "zcode".into()), "removed-harness".into())]);
        activate(conn, 0, &[revision], &slots, &"b".repeat(64), ActivationAction::Activate, 1).unwrap();
        activate(conn, 1, &[], &BTreeMap::new(), &"c".repeat(64), ActivationAction::Uninstall, 2).unwrap();
        assert!(!fixture.home.join("harnesses.d").exists());
        let generation: i64 = fixture.db.as_ref().unwrap().conn().query_row(
            "SELECT generation FROM extension_active", [], |row| row.get(0)).unwrap();
        assert_eq!(generation, 2);
        assert!(generation_slots(conn, generation).unwrap().is_empty());
        let rows = plugin_tokens_by_harness(&fixture.home, &fixture.db, Some((1000, 2000)));
        assert_eq!(rows.len(), 1); assert_eq!(rows[0].0, "harness:zcode");
        assert_eq!(rows[0].1.total, 165);
        assert_eq!((rows[0].1.uncached_input, rows[0].1.cache_read,
            rows[0].1.cache_write, rows[0].1.output), (100, 50, 10, 5));
    }

    #[test]
    fn deleted_outside_window_and_invalid_harnesses_are_not_displayed() {
        let fixture = Fixture::new();
        fixture.insert("deleted", "harness:deleted", 1500, Some(1600), [10, 0, 0, 0]);
        fixture.insert("before", "harness:before", 999, None, [10, 0, 0, 0]);
        fixture.insert("after", "harness:after", 2000, None, [10, 0, 0, 0]);
        fixture.insert("official", "codex", 1500, None, [10, 0, 0, 0]);
        fixture.insert("invalid", "harness:../escape", 1500, None, [10, 0, 0, 0]);
        assert!(plugin_tokens_by_harness(&fixture.home, &fixture.db, Some((1000, 2000))).is_empty());
    }

    #[test]
    fn observed_zero_token_harness_remains_visible() {
        let fixture = Fixture::new();
        fixture.insert("zero", "harness:zero", 1000, None, [0, 0, 0, 0]);
        let rows = plugin_tokens_by_harness(&fixture.home, &fixture.db, Some((1000, 2000)));
        assert_eq!(rows.len(), 1); assert_eq!(rows[0].0, "harness:zero");
        assert_eq!(rows[0].1.total, 0);
    }

    #[test]
    fn valid_candidate_without_facts_does_not_create_usage_row() {
        let fixture = Fixture::new();
        let candidate = fixture.home.join("harnesses.d/zcode/manifest.json");
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        std::fs::write(&candidate, serde_json::json!({"manifest_version":1,"slug":"zcode",
            "display":{"name":"ZCode"},"discovery":{"roots":["~/r"],"include":["*.jsonl"]},
            "source":{"format":"jsonl"},"session":{"from":"filename","pattern":r"^s_(?P<id>.+)\.jsonl$"},
            "recipe":"request-usage-anthropic-v1","event_key":{"paths":["requestId"]}}).to_string()).unwrap();
        assert_eq!(crate::harness_registry::scan_plugin_harnesses(&fixture.home).0.len(), 1);
        assert!(plugin_tokens_by_harness(&fixture.home, &fixture.db, Some((1000, 2000))).is_empty());
    }
}
