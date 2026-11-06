//! 成本计算 —— 把 usage 报告变成结构化费用，以及把日桶变成精确/部分计价的一天。
//!
//! 这里是 cost 计算在 core crate 里的单一实现（原来住在二进制
//! `apps/cli/src/agent/cost.rs`，preflight Phase 0-1 搬迁过来）：CLI 的
//! `cost_report`/`cost_block`、未来的 Tauri
//! 菜单栏的 `priced_day`、逐请求费用序列 `cost_series`、以及任何"按月查钱"的
//! surface 都从这里取数，**不长第四份拷贝**（CLAUDE.md「token_by_date_model/
//! priced_day 在 core 里正是为了让 Tauri 菜单栏复用」的落点）。与
//! `packages/agent-vitals-python/agent_vitals/agent/cost.py` 逐字节一致，由
//! `tests/test_cli_matrix.py` 的 `both()` 差分看守。
//!
//! 模块尾部另有一张**独立的第二计价面**（`catalog_2026_09`，Claude Code 语料
//! 官方卡折算）：服务 claude 会话账/托盘第三执行环境列，不参与 DSH 账。它只进新
//! 函数，`cost_report`/`priced_day` 等 DSH 路径字节不变——两条面不许互相改价。
//!
//! 价格表权威源是 `catalog/pricing/pricing.json`；`assets/pricing.json` 是 CI 校验的
//! 逐字节兼容镜像（v0.8 Phase E5 从 Python 包内搬到
//! 仓库根——三方共读，不是 Python 包私有数据；这里 `include_str!` 内嵌、Python 侧
//! 爬回仓库根读同一份文件；`integrations/dsh-client/pricing.json` 是 build 时复制
//! 出的运行时份，lockstep 测试对齐）。缓存写入报价表没有行 → 按 0 计（不臆造价格）。高峰时段为
//! 北京时间**周一至周五** 9–12、14–18 点，周末全天空闲；空闲价 = 高峰价的一半。

use serde_json::{json, Value};

// v0.8 Phase D2：Claude Code 语料计价（`catalog_2026_09` 第二面）切进子模块，
// 语义零改。扁平 re-export 保 `agent_vitals_domain::cost::claude_*` 路径不变。
mod claude;
mod codex;
/// 每日同步价卡叠加层与底表的合并规则（覆盖 / 只补缺卡两种，见模块文档）。
pub mod sync_overlay;
pub use claude::{
    claude_day_cost, claude_day_cost_preferring, claude_day_total_tokens, claude_session_cost,
    declared_card_covers, official_card_body, official_card_for,
    claude_subscription_uncovered_estimate,
};
pub use codex::{codex_price_bucket, codex_resolve_entry, load_codex_pricing};

/// Price one already-aggregated metered usage projection from the immutable
/// combined snapshot used by SQL, MCP, CLI, and Tauri. Callers own fact
/// selection and windowing; this function owns harness dispatch, price matching,
/// unpriced rejection, currency precision, and the single minor-unit round.
///
/// `usage` must contain a `by_model` object. For Codex, the caller passes only
/// non-subscription/unknown-route facts; explicit OpenAI subscription facts do
/// not become a token bill through this function.
pub fn metered_estimate_minor(
    harness: &str,
    usage: &Value,
    snapshot: &Value,
) -> Option<crate::domain::data_contract::MoneyMinor> {
    use crate::domain::data_contract::{BillingBasis, MoneyMinor};

    let mut total = 0.0f64;
    let currency: String;
    if harness == "codex" {
        let codex = snapshot.get("codex_pricing").unwrap_or(snapshot);
        let entries = codex.get("entries").and_then(Value::as_array)?;
        for (model, buckets) in usage.get("by_model")?.as_object()? {
            let entry = codex_resolve_entry(model, "standard", entries)?;
            total += codex_price_bucket(buckets, entry, None);
        }
        currency = "USD".to_string();
    } else {
        let pricing = snapshot.get("pricing").unwrap_or(snapshot);
        if harness == "claude-code" {
            let report = claude_day_cost(usage, pricing)?;
            if report.get("unpriced_tokens").and_then(Value::as_i64).unwrap_or(0) > 0 {
                return None;
            }
            let totals = report.get("currency_totals")?;
            let cny = totals.get("CNY").and_then(Value::as_f64).unwrap_or(0.0);
            let usd = totals.get("USD").and_then(Value::as_f64).unwrap_or(0.0);
            if cny > 0.0 && usd > 0.0 {
                return None;
            }
            total = if usd > 0.0 { usd } else { cny };
            currency = if usd > 0.0 { "USD".to_string() } else { "CNY".to_string() };
        } else {
            let report = cost_report(usage, pricing)?;
            if report
                .get("unpriced_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                > 0
            {
                return None;
            }
            total = report.get("total").and_then(Value::as_f64)?;
            currency = report
                .get("currency")
                .and_then(Value::as_str)
                .unwrap_or("CNY")
                .to_string();
        }
    }
    if !total.is_finite() || total <= 0.0 {
        return None;
    }
    let digits = match currency.to_ascii_uppercase().as_str() {
        "JPY" | "KRW" => 0,
        "KWD" | "BHD" | "OMR" => 3,
        "CNY" | "USD" | "EUR" | "GBP" | "HKD" | "SGD" | "AUD" | "CAD" | "CHF" | "NZD" => 2,
        _ => return None,
    };
    let rounded = crate::util::pyround(total, digits);
    Some(MoneyMinor {
        amount_minor: (rounded * 10f64.powi(digits as i32)).round() as i64,
        currency,
        basis: BillingBasis::MeteredEstimate,
    })
}

// v0.9 计费模式声明层（billing_modes）——「钱付给谁、按什么方式付」的判定，
// 与计价面解耦（无价卡模型 glm-* 也能归属）。2026-09-05。
mod billing;
pub use billing::{
    billing_mode_of, billing_route_of, cache_hit_ratio, canonical_provider_id,
    declared_subscriptions, provider_quote_currency, subscription_fee_of, BillingMode,
};

const PRICING_JSON: &str = include_str!("../../../../../assets/pricing.json");

pub fn load_pricing() -> Value {
    serde_json::from_str(PRICING_JSON).unwrap_or_else(|_| Value::Object(Default::default()))
}

fn strip_zero(x: f64) -> String {
    let s = format!("{:.1}", x);
    if s.ends_with(".0") {
        s[..s.len() - 2].to_string()
    } else {
        s
    }
}

/// token 数 → 人类可读：226423948 → 226.4M。与 tab 的 formatNumber 同 spec。
fn format_number(n: i64) -> String {
    if n >= 1_000_000_000 {
        return strip_zero(n as f64 / 1e9) + "B";
    }
    if n >= 1_000_000 {
        return strip_zero(n as f64 / 1e6) + "M";
    }
    if n >= 1_000 {
        return strip_zero(n as f64 / 1e3) + "K";
    }
    n.to_string()
}

/// 金额 → `¥774.7` / `¥22.38` / `¥6.73`。≥100 一位小数否则两位，去尾零。
fn format_money(x: f64) -> String {
    let s = if x >= 100.0 { format!("{:.1}", x) } else { format!("{:.2}", x) };
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    format!("¥{}", s)
}

/// 某个供应商的模型表。找不到该供应商返回 None。
fn models_of<'a>(pricing: &'a Value, provider: &str) -> Option<&'a serde_json::Map<String, Value>> {
    pricing
        .pointer(&format!("/providers/{provider}/models"))
        .and_then(|v| v.as_object())
}

/// `deepseek/deepseek-v4-pro-0813` → 价格卡键 `deepseek-v4-pro`，在**指定供应商
/// 的表里**匹配；匹配不上返回 None（不臆造）。
fn norm_model_in(model: &str, cards: &serde_json::Map<String, Value>) -> Option<String> {
    let seg = model.rsplit('/').next().unwrap_or(model);
    if cards.contains_key(seg) {
        return Some(seg.to_string());
    }
    // 最长前缀，而非「第一个命中」：旧写法按键序取第一个，`claude-opus-5-5`
    // 被 `claude-opus-5` 的卡吃掉（2026-09-29 真机：6.3 亿 token 按 Opus 5 的
    // $5/$25 计，官方是 $4/$20、缓存读取贵了 2.5 倍），而且因为「有卡」，缺价
    // 信号永远不会出现，没人知道要补卡。
    cards
        .keys()
        .filter(|key| seg.starts_with(key.as_str()) && suffix_is_same_model(&seg[key.len()..]))
        .max_by_key(|key| key.len())
        .cloned()
}

/// 前缀匹配后剩下的部分是否仍指同一个模型。日期快照（`-0731`、`-20251001`）、
/// 发布标记（`-ga-260813`）、模式标注（`-thinking`、`[1m]`）是同一模型；新的
/// 版本号（`-5`、`.1`）、档位（`-pro`、`-mini`、`-flash`…）或紧贴的字母数字
/// （`glm-5` → `glm-5v-turbo`）是另一个模型——宁可未计价，也不借别的模型的卡。
/// 与 Python `cost.py::_suffix_is_same_model` 逐条对应。
fn suffix_is_same_model(rest: &str) -> bool {
    const TIERS: [&str; 15] = [
        "pro", "mini", "nano", "max", "lite", "flash", "flashx", "air", "turbo", "plus", "ultra",
        "prime", "fast", "code", "codex",
    ];
    let mut chars = rest.chars();
    let Some(first) = chars.next() else { return true };
    if first.is_ascii_alphanumeric() {
        return false;
    }
    if first == '.' {
        return !chars.next().is_some_and(|c| c.is_ascii_digit());
    }
    if first == '-' || first == '_' {
        let token: String = rest[1..]
            .chars()
            .take_while(|c| *c != '-' && *c != '_' && *c != '.')
            .collect::<String>()
            .to_ascii_lowercase();
        if !token.is_empty() && token.len() <= 2 && token.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        if TIERS.contains(&token.as_str()) {
            return false;
        }
    }
    true
}

/// 计价依据：用了这个供应商自己的报价，还是回落到原厂报价。
/// **必须透出到展示层**——按别家的价估出来的数字，不说清楚就是在冒充实价。
#[derive(Clone, Copy, PartialEq)]
enum Basis {
    Provider,
    Fallback,
    /// 同一模型在本会话里被多家供应商服务过，无法判断哪些 token 属于哪家。
    /// 仍按原厂报价给一个估算（用户要的是"有个数"而不是一片空白），但**依据
    /// 与 Fallback 不同**：那边是"这家没报价"，这边是"报价有、归属不明"，
    /// 文案不能共用一句。
    Ambiguous,
}

/// 解析出该 (供应商, 模型) 实际适用的价格卡。
///
/// 顺序：该供应商自己的表 → 回落到 `fallback_provider`（原厂）的同名模型 →
/// 都没有才算未计价。**回落是有意的默认行为**：供应商没报价时给一个标注了
/// 来源的估算，比什么都不给有用；但它必须带着 `Basis::Fallback` 一路传到
/// 展示层，由展示层写明「按原厂报价估算」。
fn resolve_card(model: &str, provider: Option<&str>, pricing: &Value) -> Option<(String, String, Basis)> {
    // 归属不明：哨兵不是真实供应商名，查不到它的表，会一路掉到回落分支。
    // 单独认出来是为了让展示层说对话——也顺带保证这个内部哨兵**永远不会**
    // 被当成供应商名渲染给用户看。
    let ambiguous = provider == Some(crate::usage::AMBIGUOUS_PROVIDER);
    if let Some(p) = provider.filter(|_| !ambiguous) {
        if let Some(cards) = models_of(pricing, p) {
            if let Some(key) = norm_model_in(model, cards) {
                return Some((key, p.to_string(), Basis::Provider));
            }
        }
    }
    let fb = pricing.get("fallback_provider").and_then(|v| v.as_str())?;
    let cards = models_of(pricing, fb)?;
    let key = norm_model_in(model, cards)?;
    Some((key, fb.to_string(), if ambiguous { Basis::Ambiguous } else { Basis::Fallback }))
}

fn model_short(model: &str, pricing: &Value) -> String {
    let fb = pricing.get("fallback_provider").and_then(|v| v.as_str()).unwrap_or("");
    if let Some(cards) = models_of(pricing, fb) {
        if let Some(key) = norm_model_in(model, cards) {
            return key;
        }
    }
    model.rsplit('/').next().unwrap_or(model).chars().take(24).collect()
}

fn get_i64(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// 一个模型桶算出来的三个数：真实总价、其中高峰份额的价、其中缓存命中
/// （cache_read）那部分单独的价——三者不是三个独立的桶，`cache_read_cost`
/// 已经算在 `total` 里，是 `total` 内部的一个可见切面（想知道"缓存命中帮我
/// 省了多少钱"得靠它，不是靠 total 单独一个数能看出来的）。
#[derive(Clone, Copy)]
struct Price {
    total: f64,
    peak: f64,
    cache_read_cost: f64,
}

/// 把每种 token 类型拆成高峰份额（`peak_*`）和空闲份额（全量 − `peak_*`），
/// 各按各自单价计价再相加——不是「全量按空闲价」和「全量按高峰价」两个
/// 假设性区间。
fn bucket_price(buckets: &Value, model_key: &str, provider_key: &str, pricing: &Value) -> Option<Price> {
    let card = pricing.pointer(&format!("/providers/{provider_key}/models/{model_key}"))?;
    let get = |key: &str| get_i64(buckets, key) as f64 / 1e6;
    let u_peak = get("peak_uncached_input_tokens");
    let c_peak = get("peak_cache_read_tokens");
    let o_peak = get("peak_output_tokens");
    let u_off = get("uncached_input_tokens") - u_peak;
    let c_off = get("cache_read_tokens") - c_peak;
    let o_off = get("output_tokens") - o_peak;
    let rate = |path: &str| card.pointer(path).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let cache_read_cost = rate("/input_cached/off_peak") * c_off + rate("/input_cached/peak") * c_peak;
    let off = rate("/input_uncached/off_peak") * u_off + rate("/input_cached/off_peak") * c_off
        + rate("/output/off_peak") * o_off;
    let peak = rate("/input_uncached/peak") * u_peak + rate("/input_cached/peak") * c_peak
        + rate("/output/peak") * o_peak;
    Some(Price { total: off + peak, peak, cache_read_cost })
}

/// 反事实基线：把缓存命中份额（`cache_read`）也按 `uncached` 单价折——
/// 「假装没发生缓存」的无缓存反事实单价，用来算缓存节约。`cache_write`/
/// `output` 与真实计价一致，只有 input 侧的 cached/uncached 二分被抹平。
/// （原 `nominal_bucket_price`：`nominal` 一词 2026-09-05 让位给
/// ATTRIBUTABLE_WASTE §6.7 的市场标价口径，两者实测差 8~10 倍。）
fn nominal_bucket_price(buckets: &Value, model_key: &str, provider_key: &str, pricing: &Value) -> Option<f64> {
    let card = pricing.pointer(&format!("/providers/{provider_key}/models/{model_key}"))?;
    let get = |key: &str| get_i64(buckets, key) as f64 / 1e6;
    let u_peak = get("peak_uncached_input_tokens");
    let c_peak = get("peak_cache_read_tokens");
    let o_peak = get("peak_output_tokens");
    let u_off = get("uncached_input_tokens") - u_peak;
    let c_off = get("cache_read_tokens") - c_peak;
    let o_off = get("output_tokens") - o_peak;
    let rate = |path: &str| card.pointer(path).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let off = rate("/input_uncached/off_peak") * (u_off + c_off) + rate("/output/off_peak") * o_off;
    let peak = rate("/input_uncached/peak") * (u_peak + c_peak) + rate("/output/peak") * o_peak;
    Some(off + peak)
}

/// 无缓存反事实 vs 实际单位成本（节约因子）——v0.7 spec §3 交付矩阵第三行。
/// `actual` = `cost_report` 的真实计价 `total`（当前定价引擎能表达的"实际"，
/// 尚未建模订阅覆盖/路由折扣，见下）；`no_cache_counterfactual` = 假设所有
/// input（含缓存命中部分）都按 uncached 单价算的反事实总价，逐模型用
/// `nominal_bucket_price` 求和。`ratio = actual / no_cache_counterfactual`，
/// <1 表示节约。
///
/// **改名记录（2026-09-05）**：原 `nominal_vs_actual_cost`，输出键 `nominal` →
/// `no_cache_counterfactual`。`nominal` 一词让位给 ATTRIBUTABLE_WASTE §6.7 的
/// 市场标价口径（官方价、不扣套餐/折扣——那是"名义 GDP"式客观基准）；本函数
/// 的反事实是"要是没缓存会花多少"，与市场标价无关，实测两者差 8~10 倍
/// （claude 语料 $10,187 vs $1,269），共用一词迟早在同一张报表里打架。
/// 函数名随之改 `cache_counterfactual_cost`——它本来就叫这个。
///
/// **当前唯一建模的节约信号是缓存折扣**（cached 0.05 vs uncached 1.5 = 1/30）；
/// 订阅覆盖、路由折扣、模型替代尚未接入计价引擎，故没有缓存命中的语料下
/// ratio 恒为 1.00（2026-09-02 实测值）——这不是本函数的 bug，是"当前能表达
/// 的节约来源只有缓存"这一事实的忠实反映，未来接入订阅/路由信号后 ratio 才会
/// 承载更多信号（v0.7 spec §3 原文）。
///
/// usage 为空/无可计价模型 → `None`。
pub fn cache_counterfactual_cost(usage: &Value, pricing: &Value) -> Option<Value> {
    let report = cost_report(usage, pricing)?;
    let by_model = usage.get("by_model").and_then(Value::as_object);
    let providers = usage.get("providers").and_then(Value::as_object);
    let mut no_cache = 0.0f64;
    if let Some(by_model) = by_model {
        for (model, buckets) in by_model {
            let provider = providers.and_then(|m| m.get(model)).and_then(Value::as_str);
            if let Some((key, provider_key, _basis)) = resolve_card(model, provider, pricing) {
                if let Some(p) = nominal_bucket_price(buckets, &key, &provider_key, pricing) {
                    no_cache += p;
                }
            }
        }
    }
    let actual = report["total"].as_f64().unwrap_or(0.0);
    let ratio = if no_cache > 0.0 { Value::from(actual / no_cache) } else { Value::Null };
    Some(json!({
        "currency": "CNY",
        "actual": actual,
        "no_cache_counterfactual": no_cache,
        "ratio": ratio,
        "estimate_disclaimer": "actual 是当前定价引擎的真实计价（未建模订阅覆盖/路由折扣），\
no_cache_counterfactual 是假设无缓存命中的反事实基线（不是市场标价的\"名义成本\"，\
见 ATTRIBUTABLE_WASTE §6.7）；ratio<1 表示节约，当前唯一建模的节约来源是缓存折扣",
    }))
}

/// usage 报告 × 价格表 → 结构化成本数据。**这是唯一算价格的地方**——
/// `cost_block`（人读文本）与 `--json` 的 `cost` 键都从这里取数，不是两处
/// 各算一遍再凑成两种格式。之前 `cost` 完全没有 JSON 出口：想拿这份数字只能
/// 手写脚本重新调 `_price`/`load_pricing`，算一次就要重新验证一次是否用对了
/// 价格表——现在报告数据里的 `cost` 字段和人读文本走的是同一次计算。
///
/// 无任何可分桶的桶、没有未计价 token、也没有 by_source 时返回 `None`（与
/// `cost_block` 的空列表同一语义：没有数据就是没有，不摆一个全零的结构出来）。
/// 金额是未四舍五入的原始浮点——舍入是格式化文本时才做的展示决定，结构化数据
/// 不预先舍。
///
/// `by_source`（`{source: {model: 8桶}}`，调用方已折平，见 `rollup_by_source`）
/// 单独折成 `by_source_cost` 插在**最后**——按来源拆账是诊断「同一批被喂了几次」
/// 的眼睛，但它不是主账单的一部分，插在中间会破坏已有读方的键序。by_source 为
/// 空/缺场时 `by_source_cost` 键整个不出现，输出与没有该功能的版本逐字节一致。
pub fn cost_report(usage: &Value, pricing: &Value) -> Option<Value> {
    let by_model = usage.get("by_model").and_then(|v| v.as_object());
    let providers = usage.get("providers").and_then(|v| v.as_object());
    let mut total: f64 = 0.0;
    let mut peak_total: f64 = 0.0;
    let mut unpriced: i64 = 0;
    let mut per_model = serde_json::Map::new();
    // 没有 by_model（例如 `state by-source` 只带 by_source 的 usage）时循环
    // 整体跳过——per_model 恒空、主账单是 0，但 by_source 仍要计价（下面共享
    // 的收尾只认「全空」才返回 None，不会因为主账单空就放弃 by_source）。
    if let Some(by_model) = by_model {
        for (model, buckets) in by_model {
            // 价目表**按供应商分层**，不是按模型名一张表打天下。真实日志里
            // provider=shengsuanyun 的 pro 和 provider=deepseek-official 的 flash
            // 并存，两家报价不同（胜算云 DeepSeek 线路缓存读 0.15、Ali 线路 0.45）。
            //
            // 解析顺序见 resolve_card：该供应商自己的表 → 回落原厂 → 未计价。
            // **回落是有意的默认**：供应商没报价时给一个标注了来源的估算，比什么
            // 都不给有用；但依据必须一路传到展示层写明「按原厂报价估算」，否则就是
            // 拿别家的价冒充实价。
            //
            // provider 为 Null（老日志没上报）或该模型没留下 header 时按 None 处理，
            // resolve_card 自然回落到原厂——与老日志的既有行为一致。
            let provider = providers
                .and_then(|m| m.get(model))
                .and_then(|v| v.as_str());
            match resolve_card(model, provider, pricing) {
                Some((key, provider_key, basis)) => {
                    if let Some(p) = bucket_price(buckets, &key, &provider_key, pricing) {
                        total += p.total;
                        peak_total += p.peak;
                        per_model.insert(
                            model.clone(),
                            serde_json::json!({
                                "short_name": model_short(model, pricing),
                                // 供应商随每一行一起给出：同一会话可能横跨两家，
                                // 只给模型名的话这张表跟任何一家的账单都对不上。
                                // 归属不明时 provider 落 Null——`__ambiguous__` 是
                                // 内部哨兵，绝不能作为供应商名渲染给用户看。
                                "provider": if basis == Basis::Ambiguous {
                                    Value::Null
                                } else {
                                    provider.map(Value::from).unwrap_or(Value::Null)
                                },
                                // 这一行是按谁的报价算的。非 provider 时展示层必须说明依据。
                                "pricing_basis": match basis {
                                    Basis::Provider => "provider",
                                    Basis::Fallback => "fallback",
                                    Basis::Ambiguous => "ambiguous",
                                },
                                "priced_with": provider_key,
                                "total": p.total,
                                "peak": p.peak,
                                "cache_read_cost": p.cache_read_cost,
                            }),
                        );
                    }
                }
                None => {
                    unpriced += get_i64(buckets, "uncached_input_tokens")
                        + get_i64(buckets, "cache_read_tokens")
                        + get_i64(buckets, "cache_write_tokens");
                }
            }
        }
    }
    let bsc = build_by_source_cost(usage, pricing);
    if per_model.is_empty() && unpriced == 0 && bsc.is_none() {
        // by_source 也没有才真的一无所有；有 by_source 就继续（by_source_cost 会
        // 单独判断「该来源有无可分桶」，不会摆全零行）。
        return None;
    }
    let mut out = serde_json::json!({
        "currency": "CNY",
        "estimate_disclaimer": "估算值，不是账单",
        "total": total,
        "peak_total": peak_total,
        "per_model": Value::Object(per_model),
        "unpriced_tokens": unpriced,
    });
    if let Some(bsc) = bsc {
        out["by_source_cost"] = bsc;
    }
    Some(out)
}

/// 逐请求费用序列（FR-04 的「费用」纵轴，工作台单会话图与 dsh-client 审计 tab 共用）。
///
/// 语义逐行照搬 dsh-client 执行环境 `costSeriesFrom`（`integrations/dsh-client/src/harness/index.ts`）——
/// 这里、`scripts/agent_vitals/agent/cost.py::cost_series`、以及那段 TS 是**同一规则的
/// 三个镜像**，锁步一致（cost 是四路锁步的第 N 面：见 CLAUDE.md「cost 计算本身也是
/// 一层锁步」）。
///
/// - 每笔 request 用 `resolve_card(model, providers[model], pricing)` 定价格卡；
///   `is_peak` 为 null（执行环境没上报时间戳）时**这一笔不计价**——累计值保持、`priced`
///   不增，而不是按空闲价猜一档（猜出来的单价就是编数字）。累计曲线因此可能低估，
///   `priced/total` 一并透出，展示层照实说。
/// - 单笔费用 = (uncached/1e6)×input_uncached[tier] + (cache_read/1e6)×input_cached[tier] +
///   (output/1e6)×output[tier]，`tier = is_peak ? "peak" : "off_peak"`。**不含 cache_write**——与 `bucket_price` 的计价成分一致，曲线的终值必须和 `cost` 键对得上。
/// - 返回 `{series: [{request_seq, cumulative}], priced, total}`，`series` 与 `requests`
///   同序（request_seq 1..n 连续，去重后回填），浏览器逐项 zip 即可——它只在
///   `usage.rs::request_metrics` 出的数组上做乘加，展示层不再重算价（规则留在 core，
///   是 `is_peak` 注释那条纪律的延伸）。
pub fn cost_series(requests: &[Value], providers: &Value, pricing: &Value) -> Value {
    let mut series = Vec::with_capacity(requests.len());
    let mut acc: f64 = 0.0;
    let mut priced = 0i64;
    for r in requests {
        let model = r.get("model").and_then(|v| v.as_str()).unwrap_or("unknown");
        let provider = providers.get(model).and_then(|v| v.as_str());
        // 与 `cost_report` 走同一个解析器——逐请求曲线的单价必须和汇总金额同源，
        // 否则曲线终值跟 `cost` 键对不上。
        if let Some((key, provider_key, _)) = resolve_card(model, provider, pricing) {
            // is_peak 为 null（执行环境没上报时间戳）时这笔不计价——累计保持（carry），
            // 不是 false（「没测到」≠「不在高峰」），也不按空闲价猜一档。
            if let Some(peak) = r.get("is_peak").and_then(|v| v.as_bool()) {
                let tier = if peak { "peak" } else { "off_peak" };
                if let Some(card) = pricing.pointer(&format!("/providers/{provider_key}/models/{key}")) {
                    let rate = |path: &str| {
                        card.pointer(path).and_then(|v| v.as_f64()).unwrap_or(0.0)
                    };
                    acc += (get_i64(r, "uncached_input_tokens") as f64 / 1e6)
                        * rate(&format!("/input_uncached/{tier}"))
                        + (get_i64(r, "cache_read_tokens") as f64 / 1e6)
                            * rate(&format!("/input_cached/{tier}"))
                        + (get_i64(r, "output_tokens") as f64 / 1e6)
                            * rate(&format!("/output/{tier}"));
                    priced += 1;
                }
            }
        }
        series.push(json!({
            "request_seq": get_i64(r, "request_seq"),
            "cumulative": acc,
        }));
    }
    json!({
        "series": Value::Array(series),
        "priced": priced,
        "total": requests.len() as i64,
    })
}

/// `usage["by_source"]`（`{source: {model: 8桶}}`，调用方已折平，见
/// `rollup_by_source`）→ `{source: {total, peak_total, unpriced_tokens}}`。
///
/// 每个来源复用 `cost_report` 的主计价循环（把该来源的 `{model: 桶}` 当作
/// by_model 传进去），**不在这里长第二份计价规则**。月级数据没有供应商表
/// （month.json 不存 providers），所以各来源一律回落原厂价——与 `priced_day`
/// 对同一份 month.json 的处理一致，同一个来源的钱在两种 surface 上不会算岔。
///
/// 来源里全是未知模型 → 该来源只贡献 `unpriced_tokens`，不臆造价格。来源为空
/// 或缺场 → `None`（调用方据此决定要不要插 `by_source_cost` 键）。
fn build_by_source_cost(usage: &Value, pricing: &Value) -> Option<Value> {
    let by_source = usage.get("by_source").and_then(|v| v.as_object())?;
    if by_source.is_empty() {
        return None;
    }
    let mut out = serde_json::Map::new();
    for (source, models) in by_source {
        let Some(models) = models.as_object() else {
            continue;
        };
        let report = cost_report(&json!({"by_model": models}), pricing);
        out.insert(
            source.clone(),
            match report {
                Some(r) => json!({
                    "total": r["total"],
                    "peak_total": r["peak_total"],
                    "unpriced_tokens": r["unpriced_tokens"],
                }),
                // 该来源没有任何可分桶的桶（例如空 models）→ 一个真实的零行，
                // 不是编造——来源行存在本身就说明「这个来源喂过但没贡献可分桶」。
                None => json!({"total": 0.0, "peak_total": 0.0, "unpriced_tokens": 0}),
            },
        );
    }
    if out.is_empty() {
        return None;
    }
    Some(Value::Object(out))
}

/// 日桶的 8 个基础字段（`state.py` month.json/today.json 的顶层形状）——
/// 覆盖率对账与 remainder 计算都按这 8 个字段，一个不差。
const DAY_BUCKET_FIELDS: [&str; 8] = [
    "uncached_input_tokens", "output_tokens",
    "cache_read_tokens", "cache_write_tokens",
    "peak_uncached_input_tokens", "peak_output_tokens",
    "peak_cache_read_tokens", "peak_cache_write_tokens",
];

/// `by_model` 里每个模型的 8 桶按字段相加，折成一份跟 day/today 顶层
/// 同形状的 8 桶——用来跟顶层的「真实总量」对账覆盖率。
fn sum_by_model(by_model: &serde_json::Map<String, Value>) -> Value {
    let mut total = serde_json::Map::new();
    for f in DAY_BUCKET_FIELDS {
        let mut sum: i64 = 0;
        for buckets in by_model.values() {
            sum += get_i64(buckets, f);
        }
        total.insert(f.to_string(), json!(sum));
    }
    Value::Object(total)
}

/// 给一份**没有模型归属**的原始 8 桶按 fallback 模型估个价——`cost_report`
/// 需要知道"这些 token 是哪个模型"，这里是它唯一的退路，不是另一条计价规则。
///
/// Python 侧（`cost.py::fallback_price`）实现里 `_price` 用
/// `pricing["providers"][fb]["models"]["deepseek-v4-flash"]` 下标直取，缺卡直接
/// KeyError 崩——真实 pricing.json 恒有这张卡，是「按约定存在」。Rust 侧沿用
/// 本模块「缓存写入报价表没有行 → 按 0 计」的原则，缺卡返回全零价，不 panic。
fn fallback_price(buckets: &Value, pricing: &Value) -> Price {
    let fb = pricing.get("fallback_provider").and_then(|v| v.as_str()).unwrap_or("");
    bucket_price(buckets, "deepseek-v4-flash", fb, pricing)
        .unwrap_or(Price { total: 0.0, peak: 0.0, cache_read_cost: 0.0 })
}

/// 一份「日桶」（`state.py` month.json/today.json 里那种 8 基础字段 + 可选
/// `by_model`）→ `{total, peak_total, pricing_basis, coverage}`，或 `None`
/// （没有 by_model——调用方自己决定退回哪种近似）。
///
/// **唯一的覆盖率校验入口**——`cli.py` 的日历、`budget.py` 的 month/7d-average
/// 三处过去各写一份「有没有 by_model 就……」，日历那份修过覆盖率之后，budget.py
/// 那两份还在裸用 `by_model`，同一份 `month.json` 因此在两个投影上报出不同的钱
/// （¥4.50 vs ¥18.00）。三处都改调这一个函数，覆盖率的判断只写一次，不会有第
/// 四个地方重新引入同一个 bug。
///
/// **必须校验覆盖率，不能只看「有没有 by_model」**（真实回归：8 月账目一度因为
/// 从不校验覆盖率，把只覆盖当天 0.7%~32.5% token 的 by_model 当成"精算"直接
/// 报出去，剩下 67%~99% 的 token 静默消失）。做法：把 `by_model` 折成跟 `day`
/// 同形状的一份总量，与 `day` 做减法算出"没有模型归属的剩余 token"——不是 0
/// 就说明这一天的 `by_model` 只覆盖了部分时段（例如一个跨零点的会话只把某一天
/// 的切片记了下来），剩余部分按 `fallback_price` 补齐，标 `pricing_basis:
/// "partial"`，不假装是 `"exact"`。
///
/// Python 平行实现见 `cost.py::priced_day`——这里是同一函数的 Rust 锁步，
/// 供 Tauri 菜单栏等 Rust surface 复用，不许在应用里长第二份。
pub fn priced_day(day: &Value, pricing: &Value) -> Option<Value> {
    let by_model = day.get("by_model").and_then(|v| v.as_object())?;
    if by_model.is_empty() {
        return None;
    }
    let report = cost_report(&json!({"by_model": by_model}), pricing)?;
    let covered = sum_by_model(by_model);
    let day_total: i64 = DAY_BUCKET_FIELDS.iter().map(|f| get_i64(day, f)).sum();
    let covered_total: i64 = DAY_BUCKET_FIELDS.iter().map(|f| get_i64(&covered, f)).sum();
    let remainder_total = (day_total - covered_total).max(0);
    if remainder_total == 0 {
        return Some(json!({
            "total": report["total"],
            "peak_total": report["peak_total"],
            "pricing_basis": "exact",
            "coverage": 1.0,
        }));
    }
    let remainder = serde_json::json!({
        "uncached_input_tokens": (get_i64(day, "uncached_input_tokens") - get_i64(&covered, "uncached_input_tokens")).max(0),
        "output_tokens": (get_i64(day, "output_tokens") - get_i64(&covered, "output_tokens")).max(0),
        "cache_read_tokens": (get_i64(day, "cache_read_tokens") - get_i64(&covered, "cache_read_tokens")).max(0),
        "cache_write_tokens": (get_i64(day, "cache_write_tokens") - get_i64(&covered, "cache_write_tokens")).max(0),
        "peak_uncached_input_tokens": (get_i64(day, "peak_uncached_input_tokens") - get_i64(&covered, "peak_uncached_input_tokens")).max(0),
        "peak_output_tokens": (get_i64(day, "peak_output_tokens") - get_i64(&covered, "peak_output_tokens")).max(0),
        "peak_cache_read_tokens": (get_i64(day, "peak_cache_read_tokens") - get_i64(&covered, "peak_cache_read_tokens")).max(0),
        "peak_cache_write_tokens": (get_i64(day, "peak_cache_write_tokens") - get_i64(&covered, "peak_cache_write_tokens")).max(0),
    });
    let top_up = fallback_price(&remainder, pricing);
    // day_total 为 0 时 remainder_total 必是 0，已被上面的分支短路——到这里
    // day_total 必然 > 0，除法安全（与 cost.py 同一条推理）。
    Some(json!({
        "total": report["total"].as_f64().unwrap_or(0.0) + top_up.total,
        "peak_total": report["peak_total"].as_f64().unwrap_or(0.0) + top_up.peak,
        "pricing_basis": "partial",
        "coverage": covered_total as f64 / day_total as f64,
    }))
}

/// 单条 hour/day 桶 → 总价 + 高峰份额价。**legacy 兜底路径**——只在
/// today.json/month.json 没有 `by_model` 字段（这个功能上线前写的旧数据）时
/// 才用。真实路径见 `cost_report`，按实际模型精确定价。
///
/// 这条桶不带模型信息 —— 这里走 pricing.json 里默认 fallback 模型（通常是
/// flash）按桶内 4 桶 + 4 peak_* 字段算总价，pro 模型的日子会被系统性低估
/// （pro 是 flash 的 3 倍价）。peak 占比 = peak_total / total。与
/// `budget.py::_bucket_cost` 逐字节一致（Tauri 菜单栏的月/日成本聚合要它在
/// Rust 侧的同构实现，不然无 by_model 的旧日子在两套 surface 上报出两个数）。
pub fn bucket_cost(buckets: &Value, pricing: &Value) -> Value {
    // 取 fallback 模型：flash 优先（pro 比 flash 贵，预算按 flash 算更宽松，
    // 留缓冲）；没有 flash 就取该供应商第一张卡；都没有 → 全零（不臆造价格）。
    let Some(fb) = pricing.get("fallback_provider").and_then(|v| v.as_str()) else {
        return json!({"total": 0.0, "peak_total": 0.0});
    };
    let Some(models) = models_of(pricing, fb) else {
        return json!({"total": 0.0, "peak_total": 0.0});
    };
    let model_key = if models.contains_key("deepseek-v4-flash") {
        "deepseek-v4-flash"
    } else {
        let Some(first) = models.keys().next() else {
            return json!({"total": 0.0, "peak_total": 0.0});
        };
        first.as_str()
    };
    let Some(card) = pricing.pointer(&format!("/providers/{fb}/models/{model_key}")) else {
        return json!({"total": 0.0, "peak_total": 0.0});
    };
    let peak_tokens = |bk: &str| get_i64(buckets, bk) as f64 / 1e6;
    let rate = |ck: &str, rk: &str| {
        card.pointer(&format!("/{ck}/{rk}")).and_then(|v| v.as_f64()).unwrap_or(0.0)
    };
    // 一个 token 类型的总成本 = 高峰份额×高峰价 + 空闲份额×空闲价。两套命名
    // 不同（pricing 是简写、state 是 _tokens 后缀），分开传。
    let cost_of = |card_key: &str, bucket_key: &str, peak_bucket_key: &str| {
        let peak_rate = rate(card_key, "peak");
        let off_rate = rate(card_key, "off_peak");
        let peak = peak_tokens(peak_bucket_key);
        let total = peak_tokens(bucket_key);
        let off = total - peak;
        peak * peak_rate + off * off_rate
    };
    let total = cost_of("input_uncached", "uncached_input_tokens", "peak_uncached_input_tokens")
        + cost_of("input_cached", "cache_read_tokens", "peak_cache_read_tokens")
        + cost_of("output", "output_tokens", "peak_output_tokens");
    let peak = peak_tokens("peak_uncached_input_tokens") * rate("input_uncached", "peak")
        + peak_tokens("peak_cache_read_tokens") * rate("input_cached", "peak")
        + peak_tokens("peak_output_tokens") * rate("output", "peak");
    json!({"total": total, "peak_total": peak})
}

/// 某个自然月的成本 —— `month.json`/归档里的 `days` map → `{total, peak_total}`。
///
/// 与 `budget.py::compute_month_cost` 的定价段逐字节一致（那边还负责读文件 +
/// 月/归档边界，这里是纯计算）：逐日 `priced_day`（唯一覆盖率校验入口），它
/// 返回 None 说明这天没有 `by_model`，退回 `bucket_cost` 的 fallback 近似——
/// 同一个月里新旧两种精度的日子并存是预期行为，不是 bug。
pub fn month_cost(days: &Value, pricing: &Value) -> Value {
    let mut total = 0.0;
    let mut peak = 0.0;
    if let Some(map) = days.as_object() {
        for day in map.values() {
            if let Some(c) = priced_day(day, pricing) {
                total += c["total"].as_f64().unwrap_or(0.0);
                peak += c["peak_total"].as_f64().unwrap_or(0.0);
            } else {
                let c = bucket_cost(day, pricing);
                total += c["total"].as_f64().unwrap_or(0.0);
                peak += c["peak_total"].as_f64().unwrap_or(0.0);
            }
        }
    }
    json!({"total": total, "peak_total": peak})
}

/// today.json 的 data → 当日成本（元）+ peak 拆分，或 None（缺列不编列）。
///
/// 与 `budget.py::compute_today_cost` 的定价段逐字节一致（那边还负责读文件 +
/// 北京日期键）。关键校验：**today.json 里的 date 必须真的是今天**——`rotate_today`
/// 只在今天真的跑过一次审计时才翻页，否则 today.json 会原封不动停在最后有会话
/// 的那天，不校验 date 就会把昨天的花费当今天的报出去（真机回归：2026-08-27
/// 没用过 DSH，菜单栏/alert.json 仍报 ¥3.09 = 08-26 的账）。date 不符/缺场时
/// 返回 None 而不是 0：没有今天的数据，不是"今天花了 0 元"。
pub fn today_cost(data: &Value, pricing: &Value, today: &str) -> Option<Value> {
    // today.json 里的 date 必须真的是今天（见上）；date 缺场的老数据不拦（继续走
    // by_model/bucket 路径，与 Python 行为一致——`compute_today_cost` 只对"有 date
    // 且不等于今天"返回 None）。
    if let Some(d) = data.get("date").and_then(|v| v.as_str()) {
        if d != today {
            return None;
        }
    }
    let by_model = data.get("by_model").and_then(|v| v.as_object());
    let buckets = data.get("buckets").and_then(|v| v.as_object());
    if by_model.map_or(true, |m| m.is_empty()) && buckets.map_or(true, |m| m.is_empty()) {
        return None;
    }
    if let Some(bm) = by_model.filter(|m| !m.is_empty()) {
        // 新数据：顶层 by_model 按实际模型精确定价。与 Python 一致——cost_report
        // 对"全未计价"返回 None 时仍给 {0,0}（那边 `_price_by_model` 同样兜 0）。
        let tokens = bm.values().map(base_token_total).sum::<i64>();
        return Some(match cost_report(&json!({"by_model": bm}), pricing) {
            Some(r) => json!({
                "total": r["total"], "peak_total": r["peak_total"], "tokens": tokens
            }),
            None => json!({"total": 0.0, "peak_total": 0.0, "tokens": tokens}),
        });
    }
    // 老数据：无 by_model，退回 _bucket_cost 逐桶求和。
    let mut total = 0.0;
    let mut peak = 0.0;
    let mut tokens = 0i64;
    if let Some(bs) = buckets {
        for b in bs.values() {
            let c = bucket_cost(b, pricing);
            total += c["total"].as_f64().unwrap_or(0.0);
            peak += c["peak_total"].as_f64().unwrap_or(0.0);
            tokens += base_token_total(b);
        }
    }
    Some(json!({"total": total, "peak_total": peak, "tokens": tokens}))
}

/// 日 JSON 的 4 个基础 token 桶求和（uncached_input + output + cache_read +
/// cache_write）。peak_* 是高峰子集、已含在基础桶里（`bucket_cost` 的
/// off = base - peak），不重复计。词表与 `DAY_BUCKET_FIELDS` 同源——菜单栏标题的
/// 「今日已消耗 token」读这份，不是另立的第五份字段清单。
fn base_token_total(day: &Value) -> i64 {
    [
        "uncached_input_tokens", "output_tokens",
        "cache_read_tokens", "cache_write_tokens",
    ]
    .iter()
    .map(|f| get_i64(day, f))
    .sum()
}

/// usage 报告 → 成本行列表；无任何可分桶的桶时返回空列表（与 tab 空态同构，
/// 不打印假的 ¥0 行）。纯格式化——数字来自 `cost_report`，这里不重算。
pub fn cost_block(usage: &Value, pricing: &Value) -> Vec<String> {
    let Some(report) = cost_report(usage, pricing) else { return vec![] };
    let total = report["total"].as_f64().unwrap_or(0.0);
    let peak_total = report["peak_total"].as_f64().unwrap_or(0.0);
    let unpriced = report["unpriced_tokens"].as_i64().unwrap_or(0);
    let per_model_map = report["per_model"].as_object().cloned().unwrap_or_default();

    let seq: Vec<Value> = usage.get("sequence").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut line = format!("费用（估算）≈ {}", format_money(total));
    if peak_total > 0.0 {
        line += &format!("（其中高峰时段 {}）", format_money(peak_total));
    }
    if seq.len() == 1 {
        if let Some(m) = seq[0].as_str() {
            line += &format!(" · {}", model_short(m, pricing));
        }
    } else if seq.len() > 1 {
        let names: Vec<String> = seq
            .iter()
            .filter_map(|v| v.as_str())
            .map(|m| model_short(m, pricing))
            .collect();
        line += &format!(" · 中途切换模型（{}）", names.join(" → "));
    }
    let mut rows = vec![line];
    // per_model 的展示顺序必须跟 by_model 的原始遍历顺序一致——serde_json 开了
    // preserve_order，Map 迭代序即插入序，与 Python dict 的插入序天然对齐。
    if per_model_map.len() > 1 {
        if let Some(by_model) = usage.get("by_model").and_then(|v| v.as_object()) {
            for model in by_model.keys() {
                if let Some(entry) = per_model_map.get(model) {
                    let label = entry["short_name"].as_str().unwrap_or(model);
                    let t = entry["total"].as_f64().unwrap_or(0.0);
                    rows.push(format!("  {}  {}", label, format_money(t)));
                }
            }
        }
    }
    if unpriced > 0 {
        rows.push(format!("另有 {} tokens 模型未知未计价", format_number(unpriced)));
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::data_contract::BillingBasis;
    // Phase D2：Claude 面切进 `claude` 子模块——测试用的私有项（`pub(crate)`）显式引。
    use super::claude::resolve_card_catalog;

    #[test]
    fn metered_estimate_minor_prices_codex_unknown_route_from_snapshot() {
        let snapshot = serde_json::json!({
            "codex_pricing": load_codex_pricing(),
        });
        let usage = serde_json::json!({"by_model": {"openai/gpt-5.6-luna": {
            "uncached_input_tokens": 1_000_000,
            "cached_input_tokens": 1_000_000,
            "cache_write_input_tokens": 1_000_000,
            "output_tokens": 1_000_000,
        }}});
        let money = metered_estimate_minor("codex", &usage, &snapshot)
            .expect("all Codex buckets should use the snapshot card");
        assert_eq!(money.amount_minor, 167);
        assert_eq!(money.currency, "USD");
        assert_eq!(money.basis, BillingBasis::MeteredEstimate);
    }

    #[test]
    fn metered_estimate_minor_prices_dsh_from_same_snapshot() {
        let snapshot = serde_json::json!({"pricing": load_pricing()});
        let usage = serde_json::json!({"by_model": {"deepseek-v4-flash": {
            "uncached_input_tokens": 1_000_000,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "output_tokens": 0,
        }}});
        let money = metered_estimate_minor("dsh", &usage, &snapshot)
            .expect("DeepSeek model should use the DSH snapshot card");
        assert_eq!(money.amount_minor, 150);
        assert_eq!(money.currency, "CNY");
        assert_eq!(money.basis, BillingBasis::MeteredEstimate);
    }

    #[test]
    fn metered_estimate_minor_rejects_unpriced_models() {
        let snapshot = serde_json::json!({"pricing": load_pricing()});
        let usage = serde_json::json!({"by_model": {"unknown/model": {
            "uncached_input_tokens": 1_000_000,
        }}});
        assert_eq!(metered_estimate_minor("dsh", &usage, &snapshot), None);
    }

    /// v0.7 spec §3 交付矩阵第二行：deepseek-official 没有 catalog_2026_09
    /// 订阅登记 → 全部落进"未落入已声明订阅覆盖范围"视图；与 cost.py 同名
    /// 测试同数（1M uncached × off_peak 4.5/M... 实为 flash 1.5/M = ¥1.5）。
    #[test]
    fn claude_subscription_uncovered_estimate_flags_unsubscribed_provider() {
        let pricing = load_pricing();
        let models = serde_json::json!({
            "deepseek-v4-flash": {"input_tokens": 1_000_000, "output_tokens": 0,
                "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        });
        let out = claude_subscription_uncovered_estimate(models.as_object().unwrap(), &pricing)
            .unwrap();
        assert_eq!(out["pricing_basis"], "estimated-subscription-exclusion");
        assert_eq!(
            out["per_model"]["deepseek-v4-flash"]["pricing_basis"],
            "estimated-subscription-exclusion"
        );
        assert!((out["currency_totals"]["CNY"].as_f64().unwrap() - 1.5).abs() < 1e-9);
    }

    /// 公共目录不含用户套餐声明：claude-opus-5 仍进入按量参考估算视图。
    #[test]
    fn claude_subscription_uncovered_estimate_keeps_unconfirmed_provider() {
        let pricing = load_pricing();
        let models = serde_json::json!({
            "claude-opus-5": {"input_tokens": 1_000_000, "output_tokens": 0,
                "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        });
        let out = claude_subscription_uncovered_estimate(models.as_object().unwrap(), &pricing)
            .expect("known-price model must remain estimated before user confirmation");
        assert!(out["per_model"].get("claude-opus-5").is_some());
    }

    /// v0.7 spec §3 交付矩阵第三行：无缓存命中的语料下 ratio 恒为 1.00
    /// （2026-09-02 实测值，spec 原文引用）——不是本函数的 bug。
    #[test]
    fn cache_counterfactual_cost_ratio_is_one_without_cache_hits() {
        let pricing = load_pricing();
        let usage = serde_json::json!({"by_model": {"deepseek-v4-flash": {
            "uncached_input_tokens": 1_000_000, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        }}});
        let out = cache_counterfactual_cost(&usage, &pricing).unwrap();
        assert!((out["ratio"].as_f64().unwrap() - 1.0).abs() < 1e-9);
        assert!((out["actual"].as_f64().unwrap() - out["no_cache_counterfactual"].as_f64().unwrap()).abs() < 1e-9);
    }

    /// 全部落在缓存命中：实测缓存节约 1/30（cached 0.05 vs uncached 1.5）——
    /// spec §3 原文引用的具体信号，ratio 必须显著偏离 1。
    #[test]
    fn cache_counterfactual_cost_ratio_reflects_cache_savings() {
        let pricing = load_pricing();
        let usage = serde_json::json!({"by_model": {"deepseek-v4-flash": {
            "uncached_input_tokens": 0, "output_tokens": 0,
            "cache_read_tokens": 1_000_000, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        }}});
        let out = cache_counterfactual_cost(&usage, &pricing).unwrap();
        let ratio = out["ratio"].as_f64().unwrap();
        assert!((ratio - (1.0 / 30.0)).abs() < 1e-9, "ratio={ratio}");
    }

    /// 与 cost.py 对同一份真实 usage 报告的输出逐字节一致（差分由 cli_matrix 补）。
    /// 桶里没有 peak_* 键（老形状/手写夹具）→ 缺省 0，全部按空闲价计——真实总价
    /// 正好等于旧版本的「空闲」栏数字，高峰栏直接消失（peak_total == 0）。
    #[test]
    fn cost_block_real_session_report() {
        let usage = serde_json::from_str(
            r#"{"by_model":{"deepseek/deepseek-v4-pro-0813":{"uncached_input_tokens":165754353,"output_tokens":467981,"cache_read_tokens":642944,"cache_write_tokens":0},"deepseek/deepseek-v4-flash":{"uncached_input_tokens":14823001,"output_tokens":30754,"cache_read_tokens":69376,"cache_write_tokens":0}},"sequence":["deepseek/deepseek-v4-pro-0813","deepseek/deepseek-v4-flash","deepseek/deepseek-v4-pro-0813"]}"#,
        ).unwrap();
        let pricing = load_pricing();
        let rows = cost_block(&usage, &pricing);
        let expected: Vec<String> = [
            "费用（估算）≈ ¥774.7 · 中途切换模型（deepseek-v4-pro → deepseek-v4-flash → deepseek-v4-pro）",
            "  deepseek-v4-pro  ¥752.3",
            "  deepseek-v4-flash  ¥22.38",
        ].iter().map(|s| s.to_string()).collect();
        assert_eq!(rows, expected);
    }

    /// 桶里带 peak_* 且非零：真实总价是「空闲份额×空闲价 + 高峰份额×高峰价」，
    /// 不是全量分别乘两个价。全部输入都在高峰（peak_uncached_input_tokens ==
    /// uncached_input_tokens）时，总价应等于全量按高峰价计——不多不少。
    #[test]
    fn cost_block_splits_peak_and_off_peak_shares() {
        let usage = serde_json::from_str(
            r#"{"by_model":{"deepseek-v4-pro":{"uncached_input_tokens":1000000,"output_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0,"peak_uncached_input_tokens":1000000,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}},"sequence":["deepseek-v4-pro"]}"#,
        ).unwrap();
        let pricing = load_pricing();
        let rows = cost_block(&usage, &pricing);
        // 100 万输入 tokens 全落峰值 → 9.0 元/百万 tokens 高峰价，整份按高峰算。
        assert_eq!(rows[0], "费用（估算）≈ ¥9（其中高峰时段 ¥9） · deepseek-v4-pro");
    }

    /// `cost_report` 是 `cost_block` 现在唯一的数字来源——这条钉住结构化输出
    /// 本身，跟 `cost_block_real_session_report` 用同一份 usage，两条测试的
    /// 数字必须能对上（¥774.7 = 752.3+22.38 四舍五入误差内）。
    #[test]
    fn cost_report_structured_shape() {
        let usage = serde_json::from_str(
            r#"{"by_model":{"deepseek/deepseek-v4-pro-0813":{"uncached_input_tokens":165754353,"output_tokens":467981,"cache_read_tokens":642944,"cache_write_tokens":0},"deepseek/deepseek-v4-flash":{"uncached_input_tokens":14823001,"output_tokens":30754,"cache_read_tokens":69376,"cache_write_tokens":0}},"sequence":["deepseek/deepseek-v4-pro-0813","deepseek/deepseek-v4-flash","deepseek/deepseek-v4-pro-0813"]}"#,
        ).unwrap();
        let pricing = load_pricing();
        let report = cost_report(&usage, &pricing).expect("should have priceable data");
        assert_eq!(report["currency"], "CNY");
        assert_eq!(report["unpriced_tokens"], 0);
        let total = report["total"].as_f64().unwrap();
        assert!((total - 774.7).abs() < 0.05, "total should be ~774.7, got {total}");
        let pro = &report["per_model"]["deepseek/deepseek-v4-pro-0813"];
        assert_eq!(pro["short_name"], "deepseek-v4-pro");
        assert!((pro["total"].as_f64().unwrap() - 752.3).abs() < 0.05);
        // 642944 cache_read tokens，无 peak_* 键（老形状）→ 全部按空闲价
        // 0.15/百万计：642944/1e6 * 0.15 ≈ 0.0964。
        assert!((pro["cache_read_cost"].as_f64().unwrap() - 0.0964).abs() < 0.001);
    }

    /// cache_read_cost 是 total 内部的一个切面，不是另一个独立的桶——精确输入
    /// （100 万 cache_read tokens，其余为 0）下，cache_read_cost 应该等于 total。
    #[test]
    fn cost_report_cache_read_cost_is_isolated_from_other_token_types() {
        let usage = serde_json::json!({
            "by_model": {"deepseek-v4-pro": {
                "uncached_input_tokens": 0, "output_tokens": 0,
                "cache_read_tokens": 1000000, "cache_write_tokens": 0,
            }},
            "sequence": ["deepseek-v4-pro"],
        });
        let pricing = load_pricing();
        let report = cost_report(&usage, &pricing).unwrap();
        let pro = &report["per_model"]["deepseek-v4-pro"];
        // 100 万 cache_read tokens 全部空闲价：0.15 元/百万。
        assert_eq!(pro["cache_read_cost"].as_f64().unwrap(), 0.15);
        assert_eq!(pro["total"].as_f64().unwrap(), 0.15);
    }

    /// 没有任何可分桶的桶、也没有未计价 token → None，不是一个全零的结构。
    #[test]
    fn cost_report_none_when_nothing_to_price() {
        let usage = serde_json::json!({"by_model": {}, "sequence": []});
        let pricing = load_pricing();
        assert_eq!(cost_report(&usage, &pricing), None);
    }

    /// 未知模型：不进 per_model，token 数进 unpriced_tokens，不臆造价格。
    #[test]
    fn cost_report_unknown_model_is_unpriced_not_zero_priced() {
        let usage = serde_json::json!({
            "by_model": {"some/unknown-model": {"uncached_input_tokens": 1000, "output_tokens": 10, "cache_read_tokens": 0, "cache_write_tokens": 0}},
            "sequence": ["some/unknown-model"],
        });
        let pricing = load_pricing();
        let report = cost_report(&usage, &pricing).unwrap();
        assert_eq!(report["per_model"].as_object().unwrap().len(), 0);
        assert_eq!(report["unpriced_tokens"], 1000);
    }

    #[test]
    fn metered_estimate_minor_uses_claude_native_token_fields() {
        let snapshot = json!({"pricing": load_pricing()});
        let usage = json!({"by_model": {"claude-sonnet-5": {
            "input_tokens": 1_000_000,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "output_tokens": 0,
            "peak_input_tokens": 0,
            "peak_cache_read_input_tokens": 0,
            "peak_output_tokens": 0,
        }}});
        let cost = metered_estimate_minor("claude-code", &usage, &snapshot)
            .expect("known Claude model should be priceable");
        assert!(cost.amount_minor > 0);
        assert_eq!(cost.basis, BillingBasis::MeteredEstimate);
    }

    /// `cost_series` 的逐请求累计，终值必须和 `cost_report` 的 `total` 对得上——
    /// 曲线画到最后一笔时显示的费用，和会话成本块的金额是同一笔钱。三笔请求：
    /// flash 空闲价（1.5）、pro 高峰价（uncached 9 + output 27）、flash 高峰价
    /// （uncached 3 + output 9），累计 1.5 → 46.5 → 58.5。
    #[test]
    fn cost_series_prices_per_request_and_matches_cost_report_total() {
        let pricing = load_pricing();
        let requests = serde_json::json!([
            {"request_seq": 1, "model": "deepseek/deepseek-v4-flash",
             "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
             "output_tokens": 0, "is_peak": false},
            {"request_seq": 2, "model": "deepseek/deepseek-v4-pro-0813",
             "uncached_input_tokens": 2000000, "cache_read_tokens": 0,
             "output_tokens": 1000000, "is_peak": true},
            {"request_seq": 3, "model": "deepseek/deepseek-v4-flash",
             "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
             "output_tokens": 1000000, "is_peak": true},
        ]);
        let providers = serde_json::json!({
            "deepseek/deepseek-v4-flash": "deepseek-official",
            "deepseek/deepseek-v4-pro-0813": "deepseek-official",
        });
        let out = cost_series(requests.as_array().unwrap(), &providers, &pricing);
        let series = out["series"].as_array().unwrap();
        assert_eq!(out["priced"], 3);
        assert_eq!(out["total"], 3);
        let cum: Vec<f64> = series.iter().map(|s| s["cumulative"].as_f64().unwrap()).collect();
        assert!((cum[0] - 1.5).abs() < 1e-9, "r1 flash 空闲 uncached 1.5, got {}", cum[0]);
        assert!((cum[1] - 46.5).abs() < 1e-9, "r2 pro 高峰 18+27, got {}", cum[1]);
        assert!((cum[2] - 58.5).abs() < 1e-9, "r3 flash 高峰 3+9, got {}", cum[2]);
        // 同一批 token 折成 by_model 后，cost_report 的 total 就是曲线终值。
        let usage = serde_json::json!({
            "by_model": {
                "deepseek/deepseek-v4-flash": {
                    "uncached_input_tokens": 2000000, "cache_read_tokens": 0,
                    "output_tokens": 1000000, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 1000000, "peak_output_tokens": 1000000,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                "deepseek/deepseek-v4-pro-0813": {
                    "uncached_input_tokens": 2000000, "cache_read_tokens": 0,
                    "output_tokens": 1000000, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 2000000, "peak_output_tokens": 1000000,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            },
            "providers": providers,
            "sequence": [],
        });
        let report = cost_report(&usage, &pricing).unwrap();
        assert!((report["total"].as_f64().unwrap() - cum[2]).abs() < 1e-9,
                "曲线终值 {} 必须等于 cost_report.total {}", cum[2], report["total"]);
    }

    /// `is_peak` 为 null（执行环境没上报时间戳）→ 这笔不计价：累计保持、priced 不增，
    /// 而不是按空闲价猜一档。缺省 is_peak 也要 carry——测过没有 is_peak 键的行。
    #[test]
    fn cost_series_carries_unpriced_on_null_peak() {
        let pricing = load_pricing();
        let requests = serde_json::json!([
            {"request_seq": 1, "model": "deepseek-v4-flash",
             "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
             "output_tokens": 0, "is_peak": false},
            {"request_seq": 2, "model": "deepseek-v4-flash",
             "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
             "output_tokens": 0, "is_peak": null},
            {"request_seq": 3, "model": "deepseek-v4-flash",
             "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
             "output_tokens": 0}, // 没有 is_peak 键 = null，同第二条
        ]);
        let out = cost_series(requests.as_array().unwrap(), &serde_json::json!({}), &pricing);
        assert_eq!(out["priced"], 1, "只有第一条计了价");
        assert_eq!(out["total"], 3);
        let series = out["series"].as_array().unwrap();
        let cum: Vec<f64> = series.iter().map(|s| s["cumulative"].as_f64().unwrap()).collect();
        assert!((cum[0] - 1.5).abs() < 1e-9);
        assert!((cum[1] - 1.5).abs() < 1e-9, "is_peak=null 必须 carry 而非归零");
        assert!((cum[2] - 1.5).abs() < 1e-9, "缺 is_peak 键同 null");
    }

    /// 未知模型（`norm_model_in` 在回落表里也匹配不上）→ 不计价、priced 不增、
    /// 累计保持 0——不是「查不到价按 0 元计」然后把 priced 算进去。
    #[test]
    fn cost_series_unknown_model_is_unpriced_not_zero() {
        let pricing = load_pricing();
        let requests = serde_json::json!([
            {"request_seq": 1, "model": "some/unknown-model",
             "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
             "output_tokens": 0, "is_peak": false},
        ]);
        let out = cost_series(requests.as_array().unwrap(), &serde_json::json!({}), &pricing);
        assert_eq!(out["priced"], 0);
        assert_eq!(out["total"], 1);
        assert_eq!(out["series"][0]["cumulative"], 0.0);
    }

    #[test]
    fn format_number_and_money_spec() {
        assert_eq!(format_number(226423948), "226.4M");
        assert_eq!(format_number(685754), "685.8K");
        assert_eq!(format_number(50073856), "50.1M");
        assert_eq!(format_number(999), "999");
        assert_eq!(format_money(774.7), "¥774.7");
        assert_eq!(format_money(1638.88), "¥1638.9");
        assert_eq!(format_money(22.38), "¥22.38");
        assert_eq!(format_money(12.0), "¥12");
    }

    /// `priced_day` 三态锁步：by_model 覆盖完整 → `exact` + coverage 1.0；
    /// 覆盖不全 → `partial` + coverage <1（剩余按 fallback 价补齐）；无 by_model
    /// → None。数字与 `cost.py::priced_day` 对同一份日桶的输出逐字节一致
    /// （Python 侧 `tests/test_cost_priced_day.py` 用同一份夹具断言同一组数，
    /// 交叉引用互守）。
    #[test]
    fn priced_day_exact_when_by_model_covers_all() {
        let day = serde_json::json!({
            "uncached_input_tokens": 1000000, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            "by_model": {"deepseek-v4-flash": {
                "uncached_input_tokens": 1000000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            }},
        });
        let pricing = load_pricing();
        let out = priced_day(&day, &pricing).expect("by_model present");
        assert_eq!(out["pricing_basis"], "exact");
        assert_eq!(out["coverage"], 1.0);
        // 100 万 uncached 全空闲：flash 空闲价 1.5 元/百万 → total 1.5。
        assert!((out["total"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        assert_eq!(out["peak_total"], 0.0);
    }

    /// 覆盖不全的那条真实回归：by_model 只覆盖了当天 100 万 token 里的 30 万，
    /// 剩余 70 万按 fallback 价补齐、标 `partial`——不许把部分覆盖当成精算报出去。
    #[test]
    fn priced_day_partial_when_by_model_covers_only_part() {
        let day = serde_json::json!({
            "uncached_input_tokens": 1000000, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            "by_model": {"deepseek-v4-flash": {
                "uncached_input_tokens": 300000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            }},
        });
        let pricing = load_pricing();
        let out = priced_day(&day, &pricing).expect("by_model present");
        assert_eq!(out["pricing_basis"], "partial");
        assert!((out["coverage"].as_f64().unwrap() - 0.3).abs() < 1e-9);
        // 30 万按 flash 1.5 + 剩余 70 万按 fallback（deepseek-official 的 flash）
        // 1.5 = 全量 1.5 元——fallback 落的就是 flash 这张卡，这里两个价相同。
        assert!((out["total"].as_f64().unwrap() - 1.5).abs() < 1e-9);
    }

    /// 无 by_model → None：调用方自己决定退回哪种近似，本函数不摆全零结构。
    #[test]
    fn priced_day_none_without_by_model() {
        let day = serde_json::json!({
            "uncached_input_tokens": 1000000, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        });
        let pricing = load_pricing();
        assert_eq!(priced_day(&day, &pricing), None);
    }

    /// `bucket_cost`（legacy 兜底，无 by_model 的日子）：100 万 uncached 全空闲
    /// 按 fallback flash 1.5 元/百万 → total 1.5。与 `budget.py::_bucket_cost`
    /// 对同一份桶的输出一致。
    #[test]
    fn bucket_cost_prices_legacy_day_via_fallback_flash() {
        let buckets = serde_json::json!({
            "uncached_input_tokens": 1000000, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        });
        let pricing = load_pricing();
        let out = bucket_cost(&buckets, &pricing);
        assert!((out["total"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        assert_eq!(out["peak_total"], 0.0);
    }

    /// `month_cost` 混合日：exact 日（by_model 覆盖完整，1M → 1.5）+ legacy 日
    /// （无 by_model，2M → bucket_cost 3.0）→ total 4.5。逐日定价与
    /// `budget.py::compute_month_cost` 同一套判断（priced_day or bucket_cost）。
    #[test]
    fn month_cost_sums_exact_and_legacy_days() {
        let days = serde_json::json!({
            "2026-08-01": {
                "uncached_input_tokens": 1000000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
                "by_model": {"deepseek-v4-flash": {
                    "uncached_input_tokens": 1000000, "output_tokens": 0,
                    "cache_read_tokens": 0, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
                }},
            },
            "2026-08-02": {
                "uncached_input_tokens": 2000000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            },
        });
        let pricing = load_pricing();
        let out = month_cost(&days, &pricing);
        // exact 日 1.5 + legacy 日 3.0。
        assert!((out["total"].as_f64().unwrap() - 4.5).abs() < 1e-9);
        assert_eq!(out["peak_total"], 0.0);
    }

    /// `today_cost` 的 date 校验：today.json 停在昨天（真机回归：2026-08-27 没用
    /// 过 DSH，仍报 08-26 的账）→ None，不是把昨天的花费当今天的报出去。
    #[test]
    fn today_cost_stale_date_is_none_not_wrong_number() {
        let data = serde_json::json!({
            "date": "2026-08-26",
            "by_model": {"deepseek-v4-flash": {
                "uncached_input_tokens": 1000000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            }},
        });
        let pricing = load_pricing();
        assert_eq!(today_cost(&data, &pricing, "2026-08-27"), None);
    }

    /// `today_cost` 新数据路径：顶层 by_model 按实际模型定价（1M flash 全空闲
    /// → 1.5）。
    #[test]
    fn today_cost_prices_by_model_when_present() {
        let data = serde_json::json!({
            "date": "2026-08-27",
            "by_model": {"deepseek-v4-flash": {
                "uncached_input_tokens": 1000000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            }},
        });
        let pricing = load_pricing();
        let out = today_cost(&data, &pricing, "2026-08-27").expect("today data present");
        assert!((out["total"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        assert_eq!(out["tokens"], serde_json::json!(1000000),
                   "by_model 路径要带今日 token 总量（菜单栏标题用）");
    }

    /// per-source 拆账计价：同一批 100 万 uncached 喂两次（dsh-live + cli），
    /// `by_source_cost` 必须各来源一行、各 1.5 元（flash 空闲价），而不是把总量
    /// 翻倍后塞进一个来源——诊断「同一批被喂了几次」靠的就是两行并存。
    #[test]
    fn cost_report_by_source_prices_each_source_separately() {
        let usage = serde_json::json!({
            "by_model": {"deepseek-v4-flash": {
                "uncached_input_tokens": 2000000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            }},
            "by_source": {
                "dsh-live": {"deepseek-v4-flash": {
                    "uncached_input_tokens": 1000000, "output_tokens": 0,
                    "cache_read_tokens": 0, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
                }},
                "cli": {"deepseek-v4-flash": {
                    "uncached_input_tokens": 1000000, "output_tokens": 0,
                    "cache_read_tokens": 0, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
                }},
            },
        });
        let pricing = load_pricing();
        let report = cost_report(&usage, &pricing).expect("by_source present");
        assert!((report["total"].as_f64().unwrap() - 3.0).abs() < 1e-9, "主账单 = 两来源之和");
        let bsc = &report["by_source_cost"];
        assert_eq!(bsc.as_object().unwrap().len(), 2, "两个来源 → 两行");
        assert!((bsc["dsh-live"]["total"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        assert!((bsc["cli"]["total"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        assert_eq!(bsc["dsh-live"]["unpriced_tokens"], 0);
    }

    /// by_source_cost 插在**最后**：by_source 缺场时输出与老版本逐字节一致
    /// （键序：currency/disclaimer/total/peak_total/per_model/unpriced_tokens，
    /// 且没有 by_source_cost 键）。
    #[test]
    fn cost_report_omits_by_source_cost_when_source_absent() {
        let usage = serde_json::json!({
            "by_model": {"deepseek-v4-flash": {
                "uncached_input_tokens": 1000000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            }},
        });
        let pricing = load_pricing();
        let report = cost_report(&usage, &pricing).unwrap();
        assert!(report.get("by_source_cost").is_none());
        let keys: Vec<_> = report.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            vec![
                "currency", "estimate_disclaimer", "total",
                "peak_total", "per_model", "unpriced_tokens",
            ],
            "无 by_source 时键序必须保持老版（by_source_cost 插最后的前提）"
        );
    }

    /// 只有 by_source、没有 by_model（`state by-source` 的 usage 形状）→ 主账单
    /// 为 0、by_source_cost 照常给——不能因为主账单空就整体返回 None。
    #[test]
    fn cost_report_by_source_only_still_prices_sources() {
        let usage = serde_json::json!({
            "by_source": {"codex": {"deepseek-v4-flash": {
                "uncached_input_tokens": 1000000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            }}},
        });
        let pricing = load_pricing();
        let report = cost_report(&usage, &pricing).expect("by_source-only must not be None");
        assert_eq!(report["total"], 0.0);
        assert!((report["by_source_cost"]["codex"]["total"].as_f64().unwrap() - 1.5).abs() < 1e-9);
    }

    /// `today_cost` 老数据路径：无 by_model 的 buckets 逐桶 `bucket_cost` 求和。
    #[test]
    fn today_cost_falls_back_to_bucket_cost_without_by_model() {
        let data = serde_json::json!({
            "date": "2026-08-27",
            "buckets": {"h:07": {
                "uncached_input_tokens": 1000000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            }},
        });
        let pricing = load_pricing();
        let out = today_cost(&data, &pricing, "2026-08-27").expect("today data present");
        assert!((out["total"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        assert_eq!(out["tokens"], serde_json::json!(1000000),
                   "buckets 路径同样带 token 总量");
    }

    // ── catalog_2026_09（Claude Code 语料计价）钉测 ──────────────────────
    // 夹具与 `tests/test_catalog_pricing.py` 同数——两侧各自钉同一组数字互守
    // （与 test_cost_priced_day.py 同款交叉引用模式）；命令级差分等 claude-sync
    // 落地后由 `both()` 补。

    /// 目录解析命中面：catalog 平费率卡（claude-opus-5 → anthropic/USD）、
    /// 顶层 deepseek 卡（`[1M]`/`-0813` 变体 → deepseek-official/CNY——前缀
    /// 匹配键是短的、模型是长的，无需剥离代码）、moonshot 斜杠模型；
    /// 模型名 → 价卡键的匹配表。与 Python `tests/test_cost_model_match.py` 的
    /// `CASES` 逐行相同——两边任何一行漂移，就会出现同一会话两种语言两个价。
    #[test]
    fn norm_model_in_prefers_exact_then_longest_same_model_prefix() {
        let cases: [(&str, &[&str], Option<&str>); 12] = [
            ("claude-opus-5-5", &["claude-opus-5"], None),
            ("claude-opus-5-5", &["claude-opus-5", "claude-opus-5-5"], Some("claude-opus-5-5")),
            ("claude-opus-5-20260401", &["claude-opus-5"], Some("claude-opus-5")),
            ("deepseek-v4-flash-0731", &["deepseek-v4-flash"], Some("deepseek-v4-flash")),
            ("deepseek-v4-pro-ga-260813", &["deepseek-v4-pro"], Some("deepseek-v4-pro")),
            ("deepseek/deepseek-v4-pro-0813", &["deepseek-v4-pro"], Some("deepseek-v4-pro")),
            ("gpt-5.1", &["gpt-5"], None),
            ("gpt-6-luna-pro", &["gpt-6-luna"], None),
            ("glm-5v-turbo", &["glm-5"], None),
            ("claude-sonnet-5[1m]", &["claude-sonnet-5"], Some("claude-sonnet-5")),
            ("MiniMax-M3", &["MiniMax-M", "MiniMax-M3"], Some("MiniMax-M3")),
            ("deepseek-v4-flash-0731", &["deepseek-v4", "deepseek-v4-flash"], Some("deepseek-v4-flash")),
        ];
        for (model, keys, want) in cases {
            let cards: serde_json::Map<String, Value> =
                keys.iter().map(|k| (k.to_string(), json!({"output": 1}))).collect();
            assert_eq!(norm_model_in(model, &cards).as_deref(), want, "{model} in {keys:?}");
        }
    }

    /// `<synthetic>` 与任意未知模型 → None。
    #[test]
    fn resolve_card_catalog_hits_and_misses() {
        let pricing = load_pricing();
        let (provider, key, currency) =
            resolve_card_catalog("claude-opus-5", &pricing).unwrap();
        assert_eq!((provider.as_str(), key.as_str(), currency.as_str()),
                   ("anthropic", "claude-opus-5", "USD"));
        let (provider, key, currency) =
            resolve_card_catalog("deepseek-v4-pro[1M]", &pricing).unwrap();
        assert_eq!((provider.as_str(), key.as_str(), currency.as_str()),
                   ("deepseek-official", "deepseek-v4-pro", "CNY"));
        let (provider, _, currency) =
            resolve_card_catalog("deepseek/deepseek-v4-pro-0813", &pricing).unwrap();
        assert_eq!((provider.as_str(), currency.as_str()),
                   ("deepseek-official", "CNY"));
        let (provider, _, currency) =
            resolve_card_catalog("moonshot/kimi-k3", &pricing).unwrap();
        assert_eq!((provider.as_str(), currency.as_str()), ("moonshot", "USD"));
        assert_eq!(resolve_card_catalog("<synthetic>", &pricing), None);
        assert_eq!(resolve_card_catalog("some/unknown-model", &pricing), None);
    }

    /// `[1M]` 变体按 pro 官方 ¥ 卡折（近似已注释）——1M uncached × off_peak
    /// 4.5 → ¥4.5 进 CNY 桶，USD 桶保持 0（键序 CNY/USD 稳定）。deepseek-v4-pro
    /// 是时变卡，`claude_session_cost` 走的是 cost-state 累计口径、没有逐行
    /// ts 给不了峰谷分辨率，v0.6.x 前置热修后这里如实报 "partial"（全按
    /// off_peak 4.5 算，不再假装是账单级精确的 "catalog"）——数值不变，改的
    /// 只是诚实性标注。
    #[test]
    fn claude_session_cost_prices_deepseek_variant_at_official_cny_card() {
        let pricing = load_pricing();
        let usage = serde_json::json!({
            "deepseek-v4-pro[1M]": {"inputTokens": 1000000, "outputTokens": 0,
                "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0},
        });
        let out = claude_session_cost(&usage, &pricing).unwrap();
        assert_eq!(out["currency_totals"]["CNY"].as_f64().unwrap(), 4.5);
        assert_eq!(out["currency_totals"]["USD"].as_f64().unwrap(), 0.0);
        let pm = &out["per_model"]["deepseek-v4-pro[1M]"];
        assert_eq!(pm["pricing_basis"], "partial");
        assert_eq!(out["pricing_basis"], "partial");
        assert_eq!(pm["priced_with"], "deepseek-official");
        assert_eq!(pm["currency"], "CNY");
        assert!(pm.get("tier").is_none(), "平费率卡不带 tier 键");
    }

    /// anthropic 卡四型齐计：opus-5 1M uncached ×5 + 1M cached-read ×0.5 +
    /// 1M cache-creation ×1h 档 10 + 0.5M output ×25 → 5+0.5+10+12.5 = 28.0 USD。
    /// 缓存写走 1h 档——harness_costusd_note：Claude Code 自报 costUSD 按 1h 计，
    /// 照它走才能与 cost-state 互相当差分 oracle。
    #[test]
    fn claude_session_cost_prices_anthropic_all_four_token_types() {
        let pricing = load_pricing();
        let usage = serde_json::json!({
            "claude-opus-5": {"inputTokens": 1000000, "outputTokens": 500000,
                "cacheReadInputTokens": 1000000, "cacheCreationInputTokens": 1000000},
        });
        let out = claude_session_cost(&usage, &pricing).unwrap();
        let usd = out["currency_totals"]["USD"].as_f64().unwrap();
        assert!((usd - 28.0).abs() < 1e-9, "got {usd}");
        assert_eq!(out["unpriced_tokens"], 0);
        assert_eq!(out["currency_totals"]["CNY"].as_f64().unwrap(), 0.0);
    }

    /// MiniMax-M3 走 tiers 首档（会话聚合分不出单请求长度，v1 一律首档 + 档位
    /// 标签透出）：1M input ×2.10 + 0.1M output ×8.40 = 2.94 CNY。
    #[test]
    fn claude_session_cost_picks_first_tier_and_labels_it() {
        let pricing = load_pricing();
        let usage = serde_json::json!({
            "MiniMax-M3": {"inputTokens": 1000000, "outputTokens": 100000,
                "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0},
        });
        let out = claude_session_cost(&usage, &pricing).unwrap();
        let pm = &out["per_model"]["MiniMax-M3"];
        assert_eq!(pm["tier"], "≤512K input");
        let cny = out["currency_totals"]["CNY"].as_f64().unwrap();
        assert!((cny - 2.94).abs() < 1e-9, "got {cny}");
    }

    /// M2.7 无 1h 档 → 缓存写走平费率 `cache_write` 2.625：1M cc → ¥2.625。
    #[test]
    fn claude_session_cost_m27_cache_write_uses_cache_write_rate() {
        let pricing = load_pricing();
        let usage = serde_json::json!({
            "MiniMax-M2.7": {"inputTokens": 0, "outputTokens": 0,
                "cacheReadInputTokens": 0, "cacheCreationInputTokens": 1000000},
        });
        let out = claude_session_cost(&usage, &pricing).unwrap();
        let cny = out["currency_totals"]["CNY"].as_f64().unwrap();
        assert!((cny - 2.625).abs() < 1e-9, "got {cny}");
    }

    /// 同一会话跨两家（网关现实）：claude-sonnet-5 + deepseek-v4-flash → 两币
    /// 各行、per_model 键序 = 输入序。sonnet 2M uncached ×3 = 6 USD；flash
    /// 2M ×off_peak 1.5 = 3 CNY。
    #[test]
    fn claude_session_cost_splits_two_currencies() {
        let pricing = load_pricing();
        let usage = serde_json::json!({
            "claude-sonnet-5": {"inputTokens": 2000000, "outputTokens": 0,
                "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0},
            "deepseek-v4-flash": {"inputTokens": 2000000, "outputTokens": 0,
                "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0},
        });
        let out = claude_session_cost(&usage, &pricing).unwrap();
        let cny = out["currency_totals"]["CNY"].as_f64().unwrap();
        let usd = out["currency_totals"]["USD"].as_f64().unwrap();
        assert!((cny - 3.0).abs() < 1e-9, "got {cny}");
        assert!((usd - 6.0).abs() < 1e-9, "got {usd}");
        let keys: Vec<_> = out["per_model"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["claude-sonnet-5", "deepseek-v4-flash"]);
    }

    /// 未知模型 `<synthetic>` → 四型全进 unpriced（**含 output**——与
    /// `cost_report` 的 unpriced 词表不同是有意的：claude 侧只有这 4 型、output
    /// 同属真实消费，未知就该全数报出，见 price_claude_map 注释）。
    #[test]
    fn claude_session_cost_unknown_model_unpriced_all_four_types() {
        let pricing = load_pricing();
        let usage = serde_json::json!({
            "<synthetic>": {"inputTokens": 1000, "outputTokens": 40,
                "cacheReadInputTokens": 10, "cacheCreationInputTokens": 5},
        });
        let out = claude_session_cost(&usage, &pricing).unwrap();
        assert_eq!(out["per_model"].as_object().unwrap().len(), 0);
        assert_eq!(out["unpriced_tokens"], 1055);
        assert_eq!(out["currency_totals"]["CNY"].as_f64().unwrap(), 0.0);
        assert_eq!(out["currency_totals"]["USD"].as_f64().unwrap(), 0.0);
    }

    /// modelUsage 空/缺场 → None，不摆全零结构（与 cost_report 同一条语义）。
    #[test]
    fn claude_session_cost_none_when_no_usage() {
        let pricing = load_pricing();
        assert_eq!(claude_session_cost(&serde_json::json!({}), &pricing), None);
        assert_eq!(claude_session_cost(&serde_json::json!(null), &pricing), None);
    }

    /// ledger 日面与 cost-state 面同源：同一模型同 tokens → 输出逐字节相同
    /// （claude_day_cost 直通 price_claude_map，claude_session_cost 只做
    /// camel→snake 键名转换，价格计算是同一个 price_claude_map——两面金额必须
    /// 一致）。日面再验证 by_model 包一层与 flat 直图两种形状同 tokens 同价——
    /// 真机 ledger（rebuild_days）写的是 flat，这层是接入钉测。
    #[test]
    fn claude_day_and_session_costs_agree() {
        let pricing = load_pricing();
        let wrapped = serde_json::json!({"by_model": {"claude-sonnet-5": {
            "input_tokens": 2000000, "cache_read_input_tokens": 1000000,
            "cache_creation_input_tokens": 0, "output_tokens": 100000}}});
        let flat = serde_json::json!({"claude-sonnet-5": {
            "input_tokens": 2000000, "cache_read_input_tokens": 1000000,
            "cache_creation_input_tokens": 0, "output_tokens": 100000}});
        let sess = serde_json::json!({"claude-sonnet-5": {
            "inputTokens": 2000000, "cacheReadInputTokens": 1000000,
            "cacheCreationInputTokens": 0, "outputTokens": 100000}});
        let session_report = claude_session_cost(&sess, &pricing)
            .expect("cost-state 面必须可计价");
        assert_eq!(
            claude_day_cost(&wrapped, &pricing),
            Some(session_report.clone()),
            "by_model 包一层日面与 cost-state 面对同一批 token 必须报同一个数"
        );
        assert_eq!(
            claude_day_cost(&flat, &pricing),
            Some(session_report),
            "flat 直图日面（rebuild_days 真实形状）与 cost-state 面必须报同一个数"
        );
    }

    /// 用户补的中转卡可带第四维 `cache_write {off_peak, peak}`（2026-09-17：胜算云把所有
    /// 非命中输入记作"写入"，gpt-5.6-sol 一天 8.9M 写入是那笔钱的 43%）。带这一维 → 与其他
    /// 三维同一峰谷读法；不带 → 沿用 catalog 平费率（这里的覆盖卡没有 → 0），钉住"半张卡
    /// 把写入算成 0"这个静默低估正是第四维要堵的洞。数字来自真机账单拟合：
    /// sol 命中 2.343 / 写入 29.310 / 输出 140.885 元/百万。
    #[test]
    fn override_card_cache_write_dimension_prices_cache_creation_tokens() {
        let mut pricing = load_pricing();
        let day = serde_json::json!({"openai/gpt-5.6-sol": {
            "input_tokens": 0, "cache_read_input_tokens": 1_000_000,
            "cache_creation_input_tokens": 1_000_000, "output_tokens": 100_000}});
        let mut card = serde_json::json!({
            "input_uncached": { "off_peak": 29.310, "peak": 29.310 },
            "input_cached": { "off_peak": 2.343, "peak": 2.343 },
            "output": { "off_peak": 140.885, "peak": 140.885 },
        });
        pricing["providers"]["shengsuanyun"]["models"]["gpt-5.6-sol"] = card.clone();
        let without = claude_day_cost(&day, &pricing).expect("priced");
        let total = |r: &serde_json::Value| r["per_model"]["openai/gpt-5.6-sol"]["total"].as_f64().unwrap();
        assert!((total(&without) - (2.343 + 14.0885)).abs() < 1e-9, "no cache_write dimension → writes priced at 0: {without}");
        card["cache_write"] = serde_json::json!({ "off_peak": 29.310, "peak": 29.310 });
        pricing["providers"]["shengsuanyun"]["models"]["gpt-5.6-sol"] = card;
        let with = claude_day_cost(&day, &pricing).expect("priced");
        assert!((total(&with) - (2.343 + 29.310 + 14.0885)).abs() < 1e-9, "{with}");
        assert_eq!(with["per_model"]["openai/gpt-5.6-sol"]["currency"], serde_json::json!("CNY"));
    }

    /// claude_day_cost 对没有任何模型可计价的日子 → None（调用方自己决定
    /// 退回哪种近似，本函数不摆全零结构）。两种空形状（flat {} / by_model 空
    /// 壳）与 null 一律 None——flat 空对象不该因为「变成 flat 了」就报全零账。
    #[test]
    fn claude_day_cost_none_without_models() {
        let pricing = load_pricing();
        assert_eq!(claude_day_cost(&serde_json::json!({}), &pricing), None);
        assert_eq!(
            claude_day_cost(&serde_json::json!({"by_model": {}}), &pricing),
            None
        );
        assert_eq!(claude_day_cost(&serde_json::json!(null), &pricing), None);
    }

    /// `claude_day_total_tokens` 数与 `claude_day_cost` 是同一种日形状（flat /
    /// by_model 包一层都认），但**计价认不出的模型也计入**——消耗量与价目卡无关。
    /// flat 真机形状 + by_model 壳 + `<synthetic>` 全零桶 + 坏值各钉一格。
    #[test]
    fn claude_day_total_tokens_counts_all_models_regardless_of_priceability() {
        // flat 直图（rebuild_days 真机形状）：flash 3 型 + synthetic 全零 + 无关装饰键。
        let flat = serde_json::json!({
            "deepseek-v4-flash": {
                "input_tokens": 1000, "cache_read_input_tokens": 2000,
                "cache_creation_input_tokens": 3000, "output_tokens": 4000},
            "<synthetic>": {
                "input_tokens": 0, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 0},
            "decor": "ignored",
        });
        assert_eq!(claude_day_total_tokens(&flat), 10000);
        // by_model 包一层（早期设计形状）→ 同数；与 claude_day_cost 同一个嗅探。
        let wrapped = serde_json::json!({"by_model": flat});
        assert_eq!(claude_day_total_tokens(&wrapped), 10000);
        // 未知模型（目录没有的卡）token 照计：消耗量不因"没价"而消失。
        let unknown = serde_json::json!({"some-future-model": {
            "input_tokens": 500000, "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0, "output_tokens": 70000}});
        assert_eq!(claude_day_total_tokens(&unknown), 570000);
        // 坏日（null / 空对象）→ 0，不 panic。
        assert_eq!(claude_day_total_tokens(&serde_json::json!(null)), 0);
        assert_eq!(claude_day_total_tokens(&serde_json::json!({})), 0);
    }

    #[test]
    fn missing_quote_currency_is_not_guessed_from_provider() {
        let pricing = serde_json::json!({"providers": {"legacy": {"models": {
            "legacy-model": {"input_uncached": 1, "input_cached": 0, "output": 1}
        }}}});
        assert!(super::claude::resolve_card_catalog("legacy-model", &pricing).is_none());
    }
}
