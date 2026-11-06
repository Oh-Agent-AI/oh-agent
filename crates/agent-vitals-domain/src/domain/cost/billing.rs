//! 计费模式声明层（公共目录只含官方按量声明；用户套餐由本地快照合并）——回答
//! 「这个模型的钱付给谁、按什么方式付」的单一判定点。
//!
//! 与计价面彻底解耦：计价（`claude.rs` 的 catalog 卡、`super` 的 DSH
//! providers 段）回答「一个 token 按官方标价值多少钱」，本模块回答「这笔钱
//! 是套餐里的还是逐 token 付的」。归属**不能靠价卡反查**——
//! `resolve_card_catalog` 只认有卡模型，价表没录的 glm-* 因此完全落在系统
//! 视野外（真实缺陷，2026-09-05 实测 77.3M token 无归属）；billing_modes 的
//! `models` 前缀清单是独立于价卡的声明，无卡模型照样归属。声明序即优先级
//! （先专后泛：shengsuanyun 的 `deepseek-v4-pro-0813` 专属行必须排在
//! deepseek-official 的 `deepseek-v4` 泛行前，否则 0813 永远轮不到专行）。
//!
//! **「名义成本」不在这里，也不需要新函数**：claude 面的 `price_claude_map`
//! （catalog 卡折算）、DSH 面的 `month_cost`（官方价 × token）、Codex 面的
//! `codex_cost_report`（等价 API 标价）三者本身就是「官方标价、不扣套餐/
//! 中转折扣/促销」的名义口径（ATTRIBUTABLE_WASTE §6.7）。再写一份
//! `nominal_cost` 就是第二份计价规则，违反「两面同源」纪律——2026-09-05
//! 审阅修正：原计划的三件套计价函数砍掉，只补计价面没有的两样：计费模式
//! 判定与缓存命中率。
//!
//! 注意词表让位：本仓库 `nominal` 一词现指 §6.7 市场标价口径；「假设全部
//! 输入按 uncached 价算」的无缓存反事实已改名 `cache_counterfactual_cost`
//! （原 `nominal_vs_actual_cost`，两者实测差 8~10 倍，不得混用）。

use serde_json::Value;

/// 计费模式。`Unknown` 是合法状态——「不知道」必须显式存在，不得默认成
/// 订阅或按量（`data_contract.rs`「不得冒充」纪律在本层的镜像）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BillingMode {
    Subscription,
    Metered,
    Unknown,
}

impl BillingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Subscription => "subscription",
            Self::Metered => "metered",
            Self::Unknown => "unknown",
        }
    }
}

/// 模型名是否命中声明键：剥 `/` 供应商前缀后全等或前缀匹配——与计价面
/// `norm_model_in` 同一条规则（键是短的、模型是长的，`glm-5.3-flash` 落
/// `glm-5.3`），不写第二套匹配语义。
fn model_matches(model: &str, key: &str) -> bool {
    let seg = model.rsplit('/').next().unwrap_or(model);
    seg == key || seg.starts_with(key)
}

/// 模型 → (provider, BillingMode)。billing_modes 声明序线性扫描，第一个
/// `models` 前缀命中者胜；整节缺场 / 无命中 → `None`（unknown，由调用方
/// 决定呈现——与 `resolve_card_catalog` 返回 None 同款约定，不臆造）。
pub fn billing_route_of(model: &str, pricing: &Value) -> Option<(String, BillingMode)> {
    let modes = pricing
        .pointer("/catalog_2026_09/billing_modes")
        .and_then(|v| v.as_object())?;
    for (provider, pv) in modes {
        // `_doc`/`_note` 等元数据键不是提供方——下划线前缀跳过（价表既有
        // 约定，见 catalog providers 的 `_note`）。
        if provider.starts_with('_') {
            continue;
        }
        let Some(models) = pv.get("models").and_then(|v| v.as_array()) else {
            continue;
        };
        let hit = models
            .iter()
            .any(|m| m.as_str().map(|k| model_matches(model, k)).unwrap_or(false));
        if hit {
            let mode = match pv.get("mode").and_then(|v| v.as_str()) {
                Some("subscription") => BillingMode::Subscription,
                Some("metered") => BillingMode::Metered,
                // mode 值拼错 / 缺场 → Unknown 而不是 panic 或猜：声明层
                // 的脏数据必须显式可见，不得静默归入某一侧。
                _ => BillingMode::Unknown,
            };
            return Some((provider.clone(), mode));
        }
    }
    None
}

/// 用户在归因表单里填/程序从端点主机名推出来的计费方 → 目录里的 provider id。
///
/// 端点证据给的是主机名（`router.shengsuanyun.com` → 自动判定写成
/// `shengsuanyun.com`），目录 id 是 `shengsuanyun`；两种写法在库里各存一份就是
/// 两个 provider（2026-09-16 真机：`shengsuanyun` / `shengsuanyun.com` 混存，
/// 价卡永远对不上后者）。规则：已经是目录 id 原样返回；否则去掉 `www.`/`api.`/
/// `router.` 这类主机前缀与 `.com`/`.cn`/`.ai`/`.io`/`.net` 后缀，剩下的主干若是
/// 目录 id 就归一；都不是就原样保留（不猜——未知计费方本来就该照用户写的存）。
/// 目录 = 顶层 `providers` + `catalog_2026_09.providers` + `billing_modes`。
pub fn canonical_provider_id(raw: &str, pricing: &Value) -> String {
    let raw = raw.trim();
    let known = |id: &str| -> bool {
        id != "_doc" && [
            "/providers", "/catalog_2026_09/providers", "/catalog_2026_09/billing_modes",
        ].iter().any(|base| pricing.pointer(&format!("{base}/{id}")).is_some())
    };
    if raw.is_empty() || known(raw) {
        return raw.to_string();
    }
    let lower = raw.to_ascii_lowercase();
    let mut stem = lower.as_str();
    for prefix in ["www.", "api.", "router.", "gateway."] {
        if let Some(rest) = stem.strip_prefix(prefix) { stem = rest; }
    }
    for suffix in [".com.cn", ".com", ".cn", ".ai", ".io", ".net", ".org"] {
        if let Some(rest) = stem.strip_suffix(suffix) { stem = rest; break; }
    }
    if stem != lower && known(stem) {
        stem.to_string()
    } else {
        raw.to_string()
    }
}

/// 目录价卡的**报价币种**，只用于价卡分组，不能推断用户结算币种。
/// 缺显式币种的旧卡返回 None，不能因供应商或模型地区默认 CNY。
pub fn provider_quote_currency(provider: &str, pricing: &Value) -> Option<String> {
    if let Some(pv) = pricing.pointer(&format!("/catalog_2026_09/providers/{provider}")) {
        return pv.get("currency").and_then(|v| v.as_str()).map(str::to_string);
    }
    if let Some(pv) = pricing.pointer(&format!("/providers/{provider}")) {
        return pv.get("currency").and_then(|v| v.as_str()).map(str::to_string);
    }
    None
}

/// 给定 provider 的计费模式——调用方已从 `billing_route_of` 拿到 provider
/// 时用，不再重复前缀扫描。provider 不在声明表 → Unknown。
pub fn billing_mode_of(provider: &str, pricing: &Value) -> BillingMode {
    let Some(pv) = pricing
        .pointer("/catalog_2026_09/billing_modes")
        .and_then(|v| v.get(provider))
    else {
        return BillingMode::Unknown;
    };
    match pv.get("mode").and_then(|v| v.as_str()) {
        Some("subscription") => BillingMode::Subscription,
        Some("metered") => BillingMode::Metered,
        _ => BillingMode::Unknown,
    }
}

/// 已声明订阅的月费：subscriptions 节里 `provider` 命中的第一条
/// `(currency, amount_per_month)`。金额未声明（openai 现状）→ `None`——
/// 不得拿挂牌价猜（billing_modes.openai._note 钉死）。同一 provider 多条
/// 声明只取第一条：JSON 对象序即声明序，重复声明是数据错误，静默取首条
/// 并由调用方的去重测试兜底（Stage C）。
pub fn subscription_fee_of(provider: &str, pricing: &Value) -> Option<(String, f64)> {
    let subs = pricing
        .pointer("/catalog_2026_09/subscriptions")
        .and_then(|v| v.as_object())?;
    for (key, sv) in subs {
        if key.starts_with('_') {
            continue;
        }
        if sv.get("provider").and_then(|v| v.as_str()) == Some(provider) {
            let amount = sv.get("amount_per_month").and_then(|v| v.as_f64())?;
            let currency = sv
                .get("currency")
                .and_then(|v| v.as_str())
                .unwrap_or("CNY");
            return Some((currency.to_string(), amount));
        }
    }
    None
}

/// 全部已声明订阅 `(provider, currency, amount_per_month, period_start)`——
/// FixedSubscription 摊入方的扫描入口（Stage C）。
///
/// **为什么要全量枚举而不是只给已有用量条目补费**：订阅费不付用量也在付
/// ——claude-code 这个月没用 anthropic 流量，Claude Pro 的 $20 照扣。只给
/// 有数据的条目加 FixedSubscription 会把"零用量但已付费"的月份谎报成
/// "零支出"，与 Unavailable≠0 同一条纪律的镜像面。
///
/// `period_start`：`billing_period_start` 字段，缺省回落 `reported_at`——
/// 查询账期早于它的月份**不该摊**这笔费（用户还没买；claude-pro 填了真机
/// `oauthAccount.subscriptionCreatedAt`，minimax/glm 只有口述确认日）。调用
/// 方按账期过滤；这里只忠实带出，不做日期判断（domain 不读时钟，也不解析
/// 月份语义——比较规则属于接线层）。
pub fn declared_subscriptions(pricing: &Value) -> Vec<(String, String, f64, Option<String>)> {
    let Some(subs) = pricing
        .pointer("/catalog_2026_09/subscriptions")
        .and_then(|v| v.as_object())
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (key, sv) in subs {
        if key.starts_with('_') {
            continue;
        }
        let Some(provider) = sv.get("provider").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(amount) = sv.get("amount_per_month").and_then(|v| v.as_f64()) else {
            continue; // 金额未声明（openai）——枚举跳过，不产出待摊条目
        };
        let currency = sv
            .get("currency")
            .and_then(|v| v.as_str())
            .unwrap_or("CNY");
        let period_start = sv
            .get("billing_period_start")
            .and_then(|v| v.as_str())
            .or_else(|| sv.get("reported_at").and_then(|v| v.as_str()))
            .map(String::from);
        out.push((provider.to_string(), currency.to_string(), amount, period_start));
    }
    out
}

/// 四套键面下的同一个桶：claude snake（ledger/cost-state 转换后）、DSH 四桶
/// （`uncached_input_tokens` 词表，见 fixtures/v09/dsh/month-day.json 的
/// _doc——与 claude 词表不通用、混用会让 priced_day 静默算 0）、camel
/// （cost-state modelUsage 原始形状）、codex（fold 派生词表，`uncached_
/// input_tokens` 由 fold 从 input−cached 算好，`cached_input_tokens` 是
/// cache_read 的 codex 键名）。取第一个存在的键，全缺 → 0。
fn bucket(tokens: &Value, keys: &[&str]) -> f64 {
    for k in keys {
        if let Some(v) = tokens.get(k).and_then(|v| v.as_f64()) {
            return v;
        }
    }
    0.0
}

/// 缓存命中率 = cache_read / (uncached + cache_read + cache_write)。
/// 分母**刻意不含 output**——命中率是输入侧结构指标（ATTRIBUTABLE_WASTE §7
/// 诊断语义），把 output 混进分母会稀释成另一个不可比的数。全零输入 →
/// `None`（没有输入就没有命中率可言，0% 是"全未命中"，不是"没输入"——
/// 「MeasuredZero ≠ Unavailable」纪律在本函数的落点）。
///
/// 实测锚点：claude 语料 09-01→09-05 命中率 99.18%，名义成本的 92.8% 由
/// 缓存两桶贡献——这是它升为一级 KPI 的依据，也是本函数存在的理由。
pub fn cache_hit_ratio(tokens: &Value) -> Option<f64> {
    let uncached = bucket(
        tokens,
        &["input_tokens", "uncached_input_tokens", "inputTokens"],
    );
    let read = bucket(
        tokens,
        &[
            "cache_read_input_tokens",
            "cache_read_tokens",
            "cacheReadInputTokens",
            "cached_input_tokens",
        ],
    );
    let write = bucket(
        tokens,
        &[
            "cache_creation_input_tokens",
            "cache_write_tokens",
            "cacheCreationInputTokens",
            "cache_write_input_tokens",
        ],
    );
    let denom = uncached + read + write;
    if denom <= 0.0 {
        return None;
    }
    Some(read / denom)
}

#[cfg(test)]
mod tests {
    #[test]
    fn quote_currency_requires_explicit_catalog_currency() {
        let pricing = crate::cost::load_pricing();
        assert_eq!(super::provider_quote_currency("shengsuanyun", &pricing).as_deref(), Some("CNY"));
        assert_eq!(super::provider_quote_currency("anthropic", &pricing).as_deref(), Some("USD"));
        assert_eq!(super::provider_quote_currency("nobody", &pricing), None);
        assert_eq!(super::provider_quote_currency("legacy", &serde_json::json!({"providers": {"legacy": {"models": {}}}})), None);
    }

    #[test]
    fn canonical_provider_id_folds_endpoint_hostnames_onto_catalog_ids() {
        let pricing = crate::cost::load_pricing();
        assert_eq!(super::canonical_provider_id("shengsuanyun.com", &pricing), "shengsuanyun");
        assert_eq!(super::canonical_provider_id("router.shengsuanyun.com", &pricing), "shengsuanyun");
        assert_eq!(super::canonical_provider_id("shengsuanyun", &pricing), "shengsuanyun");
        assert_eq!(super::canonical_provider_id("anthropic", &pricing), "anthropic");
        // 目录不认识的照原样存，不猜。
        assert_eq!(super::canonical_provider_id("openrouter.ai", &pricing), "openrouter.ai");
        assert_eq!(super::canonical_provider_id("  ", &pricing), "");
    }

    use super::*;
    use serde_json::json;

    // 生产价表的只读快照——billing_modes 的声明序（先专后泛）是字节契约，
    // 测试钉生产文件而不是自造 fixture，声明序被无意调整时这里当场红。
    fn pricing() -> Value {
        crate::cost::load_pricing()
    }

    fn user_declarations() -> Value {
        json!({"catalog_2026_09": {
            "billing_modes": {
                "anthropic": {"mode":"subscription", "models":["claude-"]}
            },
            "subscriptions": {
                "claude-pro": {"provider":"anthropic", "currency":"USD",
                    "amount_per_month":20.0, "billing_period_start":"2025-07-20"},
                "glm": {"provider":"zhipu-glm", "currency":"CNY",
                    "amount_per_month":118.0, "reported_at":"2026-09-05"}
            }
        }})
    }

    #[test]
    fn billing_route_resolves_every_declared_provider() {
        let p = pricing();
        for (model, provider, mode) in [
            ("deepseek-v4-flash", "deepseek-official", BillingMode::Metered),
            ("deepseek/deepseek-v4-pro", "deepseek-official", BillingMode::Metered),
        ] {
            let (got_p, got_m) =
                billing_route_of(model, &p).unwrap_or_else(|| panic!("{model} 必须能归属"));
            assert_eq!(got_p, provider, "{model} provider 归属错");
            assert_eq!(got_m, mode, "{model} 计费模式错");
        }
    }

    #[test]
    fn billing_route_specific_declaration_wins_over_generic() {
        // 0813 是 shengsuanyun 转售型号：声明序先专后泛，必须截在
        // shengsuanyun，不能落 deepseek-official 泛行——两家中转/官方价同、
        // 但账归属不同（Harness ≠ BillingSource，§6.3）。
        let (p, m) = billing_route_of("deepseek-v4-pro-0813", &pricing()).unwrap();
        assert_eq!(p, "shengsuanyun");
        assert_eq!(m, BillingMode::Metered);
    }

    #[test]
    fn billing_route_none_for_unattributable_model() {
        // <synthetic> 与完全陌生的模型 → None：调用方报 unknown，不编。
        assert_eq!(billing_route_of("<synthetic>", &pricing()), None);
        assert_eq!(billing_route_of("totally-unknown-model", &pricing()), None);
    }

    #[test]
    fn billing_route_unknown_when_mode_value_is_dirty() {
        // mode 值拼错 → Unknown（不 panic、不猜）——声明层脏数据显式可见。
        let mut p = user_declarations();
        *p.pointer_mut("/catalog_2026_09/billing_modes/anthropic/mode")
            .unwrap() = json!("subscrption"); // 真实打错形状
        let (_, m) = billing_route_of("claude-sonnet-5", &p).unwrap();
        assert_eq!(m, BillingMode::Unknown);
    }

    #[test]
    fn subscription_fee_hits_declared_and_none_for_undeclared() {
        let p = user_declarations();
        assert_eq!(
            subscription_fee_of("anthropic", &p),
            Some(("USD".into(), 20.0))
        );
        assert_eq!(
            subscription_fee_of("zhipu-glm", &p),
            Some(("CNY".into(), 118.0))
        );
        // openai 声明了 subscription 但金额未录——None，不得拿挂牌价猜
        // （billing_modes.openai._note 钉死）。
        assert_eq!(subscription_fee_of("openai", &p), None);
        // 完全没声明的 provider 同样 None。
        assert_eq!(subscription_fee_of("moonshot", &p), None);
    }

    #[test]
    fn declared_subscriptions_enumerates_amounts_with_period_fallback() {
        let p = user_declarations();
        let subs = declared_subscriptions(&p);
        let providers: Vec<&str> = subs.iter().map(|(pr, ..)| pr.as_str()).collect();
        // openai 金额未声明：不进待摊清单（枚举的调用方是要摊钱的，产出一条
        // 金额缺失的条目只会逼调用方再猜一次）。
        assert!(!providers.contains(&"openai"), "{providers:?}");
        // claude-pro 带真机账期起点（oauthAccount.subscriptionCreatedAt），
        // minimax/glm 只有口述确认日 → 回落 reported_at。
        let claude = subs.iter().find(|(pr, ..)| pr == "anthropic").unwrap();
        assert_eq!(claude.3.as_deref(), Some("2025-07-20"));
        let glm = subs.iter().find(|(pr, ..)| pr == "zhipu-glm").unwrap();
        assert_eq!(glm.3.as_deref(), Some("2026-09-05"));
        // 去重前提：同一 provider 只出现一次（当前价表无重复声明；将来误配
        // 两条同名 provider 时，摊入方按这条钉住的语义只摊首条）。
        let mut seen = std::collections::BTreeSet::new();
        for (pr, ..) in &subs {
            assert!(seen.insert(pr.as_str()), "重复声明 {pr}");
        }
    }

    #[test]
    fn cache_hit_ratio_reads_all_three_key_faces() {
        // claude snake（ledger 直通形状）：99.18% 实测形状的缩小版。
        let snake = json!({
            "input_tokens": 14336,
            "cache_read_input_tokens": 3_298_003_796i64,
            "cache_creation_input_tokens": 27_294_939i64,
            "output_tokens": 5_751_205i64, // 不进分母
        });
        let r = cache_hit_ratio(&snake).unwrap();
        assert!((r - 3_298_003_796f64 / 3_325_313_071f64).abs() < 1e-12);

        // DSH 四桶词表：同一谓词，不同键面（fixtures/v09 的真实形状）。
        let dsh = json!({
            "uncached_input_tokens": 1_000_000.0,
            "cache_read_tokens": 250_000.0,
            "cache_write_tokens": 0.0,
            "output_tokens": 100_000.0,
        });
        assert!((cache_hit_ratio(&dsh).unwrap() - 0.2).abs() < 1e-12);

        // camel（cost-state modelUsage 原始形状）。
        let camel = json!({
            "inputTokens": 10.0,
            "cacheReadInputTokens": 90.0,
            "cacheCreationInputTokens": 0.0,
        });
        assert!((cache_hit_ratio(&camel).unwrap() - 0.9).abs() < 1e-12);
    }

    #[test]
    fn cache_hit_ratio_none_without_input_not_zero() {
        // 全零输入 → None（Unavailable），不是 0%（MeasuredZero）——
        // 「没输入」与「全未命中」是两件事，混写就是撒谎。
        assert_eq!(cache_hit_ratio(&json!({})), None);
        assert_eq!(
            cache_hit_ratio(&json!({"input_tokens": 0, "cache_read_input_tokens": 0})),
            None
        );
        // output 独大也不参与：输入侧全零照样 None。
        assert_eq!(cache_hit_ratio(&json!({"output_tokens": 999.0})), None);
    }
}
