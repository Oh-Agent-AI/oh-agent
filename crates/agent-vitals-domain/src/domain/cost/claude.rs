//! Claude Code 语料计价（`pricing.json::catalog_2026_09`）—— **独立的第二计价面**。
//!
//! 服务 claude 会话账 / 托盘第三执行环境列，不参与 DSH 账。按提供商分栏、currency
//! 各异、平费率（无 off_peak 兜底）。与 DSH 路径（`super` 里的 `cost_report`/
//! `priced_day`）字节隔离——两面的钱不许互相改价（`price_claude_map` doc 自钉
//! 「两面的钱必须同源」）。v0.8 Phase D2 从 `cost.rs` 切出，语义零改。

use serde_json::{json, Value};

// DSH 计价面（`super` = `cost/mod.rs`）的共享 helper —— 子模块可见父模块私有项。
use super::{get_i64, model_short, norm_model_in};

//
// 上面所有函数服务 DSH 运行时账（providers 段，CNY，高峰/空闲拆分）。Claude
// Code 会话文件没有 provider 路由证据（message.model 是唯一计价键），价目表在
// `pricing.json::catalog_2026_09`（按提供商分栏、currency 各异、平费率——没有
// peak/off_peak）。这一段是**独立的第二计价面**：输出全量标
// `pricing_basis: "catalog"`，每个数都是「按官方卡折算的估算」，不许与 DSH 的
// 账单数混加（¥/$ 分桶由调用方分开渲染）。为什么不复用 `Basis` 枚举：新面与
// 老面的依据轴不同（老面是「哪家报价被用了」，新面恒是 catalog 折算），给枚举
// 加 Catalog 变体要动 DSH 路径的 match——新面直接写字面量，老路径零改动、
// 字节稳定（审阅裁定：函数名与 Basis 分离是对的）。
//
// 计价输入统一用 claude 4 型 snake 键名：input_tokens（uncached，不含缓存写/
// 读——Anthropic API 语义）/cache_read_input_tokens/cache_creation_input_tokens/
// output_tokens；与 claude 行 usage 及 cost-state modelUsage 的语义一一对应。
// Python 平行实现见 `cost.py::claude_session_cost`/`claude_day_cost`，数值由
// 两侧同夹具钉测互守（core inline + tests/test_catalog_pricing.py 同数）。

/// 目录卡解析：在 `catalog_2026_09.providers.*` 找模型卡 → 找不到再在顶层
/// `providers.*`（deepseek 官方 ¥ 卡；catalog 的 _doc 明说 deepseek 不重复收）
/// 找。返回 (供应商键, 模型卡键, 币种)——两层都必须有显式 `currency`；
/// 缺币种的卡不得按 CNY 猜价。前缀匹配与 `norm_model_in` 同一条规则：
/// `deepseek-v4-pro[1M]`/`deepseek-v4-pro-0813` 都落 `deepseek-v4-pro`——键是
/// 短的、模型是长的，**无需为 `[1M]` 变体写剥离代码**（审阅复核）。但注意：
/// `[1M]` 档的官方价不在任何价表里，按 pro 卡折是记录在案的近似（ee969d0c 有
/// 3.5M in / 47M cr 走它，不是角落），不是想当然的精确。
pub(crate) fn resolve_card_catalog(model: &str, pricing: &Value) -> Option<(String, String, String)> {
    let catalog = pricing
        .pointer("/catalog_2026_09/providers")
        .and_then(|v| v.as_object());
    if let Some(catalog) = catalog {
        for (provider, pv) in catalog {
            let Some(models) = pv.get("models").and_then(|v| v.as_object()) else {
                continue;
            };
            if let Some(key) = norm_model_in(model, models) {
                let Some(currency) = pv.get("currency").and_then(|v| v.as_str()) else { continue };
                return Some((provider.clone(), key, currency.to_string()));
            }
        }
    }
    // deepseek 官方卡（顶层 providers 段）：目录不收 deepseek。缓存写入报价表
    // 没有行 → 按 0 计，与 DSH 同一条规矩。
    let top = pricing.get("providers").and_then(|v| v.as_object());
    if let Some(top) = top {
        for (provider, pv) in top {
            let Some(models) = pv.get("models").and_then(|v| v.as_object()) else {
                continue;
            };
            if let Some(key) = norm_model_in(model, models) {
                let Some(currency) = pv.get("currency").and_then(|v| v.as_str()) else { continue };
                return Some((provider.clone(), key, currency.to_string()));
            }
        }
    }
    None
}

/// 目录卡的平费率主体：先 `catalog_2026_09.providers` 再顶层 `providers`
/// （deepseek 官方卡）——与 `resolve_card_catalog` 的两段搜索一一对应。
fn catalog_card<'a>(pricing: &'a Value, provider: &str, key: &str) -> Option<&'a Value> {
    pricing
        .pointer(&format!("/catalog_2026_09/providers/{provider}/models/{key}"))
        .or_else(|| pricing.pointer(&format!("/providers/{provider}/models/{key}")))
}

/// 平费率读取：`card[key]` 是数字（catalog 平费率/M3 档位）就取它。
///
/// **不再对 `{off_peak, peak}` 时变卡取 off_peak**（v0.6.x 前置热修，
/// 2026-09-03 撤销）：旧版本在这里把时变卡的 off_peak 单价当"保守估算"
/// 直接用，实际是拿时间维下界冒充精确——真机对账证明它不是保守而是系统性
/// 低估（托盘 claude 今日 ¥45.40 vs 官方账单 ¥74.3797，89% 差额来自这一步；
/// 见 `docs/CLAUDE_COST_DAY_ATTRIBUTION_ANALYSIS.md`，v0.6 spec §5.3 条款 7 /
/// §8 G10）。时变卡字段一律经 `priced_field` 做峰谷拆分计价；这个函数收窄
/// 成只服务真正平费率的字段（catalog anthropic/moonshot USD 卡、MiniMax
/// 档位卡），命中 dict 形状时诚实返回 0.0 而不是猜一个方向。
fn flat_rate(card: &Value, key: &str) -> f64 {
    card.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

/// 一个 token 字段（如 `input_uncached`）的计价：`card[key]` 是数字（平
/// 费率）→ `total × 该价`；是 `{off_peak, peak}` 对象（时变卡）→
/// `(total-peak) × off_peak + peak × peak_rate` 分别计价（v0.6 spec §5.3
/// 条款 7 的峰谷读法）。`peak` 由调用方给出，钳制在 `[0, total]` 防御倒挂；
/// 调用方对"压根不知道峰谷切分"的输入传 `peak=0.0`——这时时变卡会算出与旧
/// 下界读法数值相同的结果，但**不是同一件事**：这里的 0 只是"没有更多
/// 信息"，`pricing_basis` 必须由调用方另行标注为非 catalog（见
/// `price_claude_model` 的 `unresolved`），不能靠这个函数自己判断"该不该
/// 报精确"——它只管算数，不管诚实性标注。
fn priced_field(card: &Value, key: &str, total: f64, peak: f64) -> f64 {
    match card.get(key) {
        Some(v) if v.is_number() => total * v.as_f64().unwrap_or(0.0),
        Some(v) if v.is_object() => {
            let peak = peak.max(0.0).min(total);
            let off = total - peak;
            let off_rate = v.get("off_peak").and_then(|x| x.as_f64()).unwrap_or(0.0);
            let peak_rate = v.get("peak").and_then(|x| x.as_f64()).unwrap_or(0.0);
            off * off_rate + peak * peak_rate
        }
        _ => 0.0,
    }
}

/// 时变卡判定：`input_uncached` 字段是 `{off_peak, peak}` 形状——与 v0.6
/// spec §8 G10 的机械判据同一条规则（今天命中 deepseek-official 的
/// flash/pro、shengsuanyun 的 pro 三张卡；catalog 的平费率/档位卡这个字段
/// 恒是数字）。
fn card_is_time_varying(card: &Value) -> bool {
    card.get("input_uncached")
        .map(|v| v.is_object())
        .unwrap_or(false)
}

/// 缓存写入（cache_creation）单价：catalog 卡按 1h 档（5min 是 1.25×输入、
/// 1h 是 2×——Claude Code 自报 costUSD 按 1h 计，harness_costusd_note 说它与
/// catalog 逐分吻合的前提就是 1h，照它走才能拿 cost-state 当差分 oracle）；
/// 没有 1h 档的卡（M2.7 的 `cache_write`、deepseek 无行 → 0）各取各的。
fn cache_write_rate(card: &Value) -> f64 {
    let r = flat_rate(card, "cache_write_1hr");
    if r > 0.0 {
        return r;
    }
    flat_rate(card, "cache_write")
}

/// tiers 卡（MiniMax-M3）：整请求按输入长度 cliff 分档；cost-state/日账只有
/// 会话聚合、分不出单请求长度 → 一律取首档（≤512K），档位标签随行透出——
/// 超长请求会话会被低估，靠标签露馅而不是假装精确。
fn first_tier(card: &Value) -> Option<(&str, &Value)> {
    let tiers = card.get("tiers").and_then(|v| v.as_array())?;
    let first = tiers.first()?;
    let label = first.get("label").and_then(|v| v.as_str()).unwrap_or("");
    Some((label, first))
}

/// 单模型 tokens（claude snake 键名，见模块注释）→ 计价。`peak_resolved=true`
/// 时额外读 `peak_` 前缀的峰值子桶（`claude_cost.rs::PEAK_KEYS`），对时变卡
/// 做峰谷拆分；`false` 时全部按 off_peak 计价（cost-state 累计口径没有逐行
/// ts，压根没有峰谷可分）。返回 (供应商, 币种, 总价, 档位标签, unresolved)——
/// `unresolved=true` 表示命中了时变卡但没给峰谷分辨率，`price_claude_map`
/// 据此把 `pricing_basis` 标成非 catalog，不能让下游误读成账单级精确。
/// 模型/卡都匹配不上 → None（不臆造）。
/// [`resolve_card_catalog`] 的「优先用户归因的计费方」版：用户在计费声明里说
/// 这批用量经 `preferred` 按量付费，若该计费方的价卡收录了这个模型就用它的价
/// （胜算云对 DeepSeek-V4-Pro 的报价 ≠ DeepSeek 官方价），否则退回目录路由
/// ——「归因以后按照归因的来计算」，价卡缺失时退回官方价是已知近似，调用方
/// 通过返回的 provider 是否等于 `preferred` 判断走了哪条。
pub(crate) fn resolve_card_catalog_preferring(
    model: &str,
    pricing: &Value,
    preferred: Option<&str>,
) -> Option<(String, String, String)> {
    if let Some(pref) = preferred {
        for base in ["/catalog_2026_09/providers", "/providers"] {
            let Some(pv) = pricing.pointer(&format!("{base}/{pref}")) else { continue };
            let Some(models) = pv.get("models").and_then(|v| v.as_object()) else { continue };
            if let Some(key) = norm_model_in(model, models) {
                let Some(currency) = pv.get("currency").and_then(|v| v.as_str()) else { continue };
                return Some((pref.to_string(), key, currency.to_string()));
            }
        }
    }
    resolve_card_catalog(model, pricing)
}

/// 用户归因的计费方 `provider` 的价卡是否收录了 `model`（收录 → 该模型按它的价、
/// 它的币种算；未收录 → 调用方退回执行环境自己的官方价卡）。
pub fn declared_card_covers(provider: &str, model: &str, pricing: &Value) -> bool {
    resolve_card_catalog_preferring(model, pricing, Some(provider))
        .is_some_and(|(p, _, _)| p == provider)
}

/// 「原厂官方计价模板」：目录里（优先 `preferred` 计费方的卡，其次按模型名归属到
/// 原厂的官方卡）能否给 `model` 找到任何一张卡。用户 2026-09-17 的定向——中转转
/// 的 DeepSeek / MiniMax 型号，没有中转自己的价就**默认按原厂官方价**估，不要
/// 逼用户手抄六个数；只有目录里哪家都没有的型号（gpt-6-astra）才算真无价。
/// 返回 `(provider, card_key, currency)`，供调用方标「按 X 官方价估算」。
pub fn official_card_for(model: &str, pricing: &Value, preferred: Option<&str>) -> Option<(String, String, String)> {
    resolve_card_catalog_preferring(model, pricing, preferred)
}

/// [`official_card_for`] 找到的那张卡，折成补卡表单的六个价：
/// `{input_uncached: {off_peak, peak}, input_cached: {…}, output: {…}}`——平费率卡两格
/// 同值，峰谷卡原样，档位卡（MiniMax-M3 tiers）取首档（与计价同一条 `first_tier`
/// 规则）。返回 `(provider, card_key, currency, six_rates)`；找不到 → None。
/// 给设置页「按原厂官方价预填」用：用户不用手抄，改一下再存就是中转的卡。
pub fn official_card_body(model: &str, pricing: &Value, preferred: Option<&str>) -> Option<(String, String, String, Value)> {
    let (provider, key, currency) = resolve_card_catalog_preferring(model, pricing, preferred)?;
    let card = catalog_card(pricing, &provider, &key)?;
    let card = match first_tier(card) {
        Some((_, tier)) => tier,
        None => card,
    };
    let dim = |k: &str| -> Option<Value> {
        match card.get(k) {
            Some(v) if v.is_number() => Some(json!({ "off_peak": v, "peak": v })),
            Some(v) if v.is_object() => Some(json!({
                "off_peak": v.get("off_peak").and_then(|x| x.as_f64()).unwrap_or(0.0),
                "peak": v.get("peak").and_then(|x| x.as_f64()).unwrap_or(0.0),
            })),
            _ => None,
        }
    };
    let six = json!({
        "input_uncached": dim("input_uncached")?,
        "input_cached": dim("input_cached").unwrap_or_else(|| json!({ "off_peak": 0.0, "peak": 0.0 })),
        "output": dim("output")?,
    });
    Some((provider, key, currency, six))
}

fn price_claude_model_preferring(
    model: &str,
    tokens: &Value,
    pricing: &Value,
    peak_resolved: bool,
    preferred: Option<&str>,
) -> Option<(String, String, f64, Option<String>, bool)> {
    let (provider, key, currency) = resolve_card_catalog_preferring(model, pricing, preferred)?;
    let card = catalog_card(pricing, &provider, &key)?;
    let (label, card) = match first_tier(card) {
        Some((label, tier)) => (Some(label.to_string()), tier),
        None => (None, card),
    };
    let m = |k: &str| get_i64(tokens, k) as f64 / 1e6;
    let mp = |k: &str| {
        if peak_resolved {
            get_i64(tokens, &format!("peak_{k}")) as f64 / 1e6
        } else {
            0.0
        }
    };
    let input_t = m("input_tokens");
    let input_p = mp("input_tokens");
    let cread_t = m("cache_read_input_tokens");
    let cread_p = mp("cache_read_input_tokens");
    let ccreate_t = m("cache_creation_input_tokens");
    let ccreate_p = mp("cache_creation_input_tokens");
    let output_t = m("output_tokens");
    let output_p = mp("output_tokens");
    // 缓存写入：卡上 `cache_write` 是 `{off_peak, peak}` 对象（用户补的中转卡——2026-09-17
    // 胜算云把所有非命中输入都记作"写入"，sol 的 8.9M 写入是那笔钱的 43%，没有这一档
    // 的覆盖卡会把它静默算成 0）→ 与其他三维同一峰谷读法；否则走 catalog 的平费率
    // （`cache_write_1hr` / `cache_write`）。
    let cache_write_cost = match card.get("cache_write") {
        Some(v) if v.is_object() => priced_field(card, "cache_write", ccreate_t, ccreate_p),
        _ => ccreate_t * cache_write_rate(card),
    };
    let total = priced_field(card, "input_uncached", input_t, input_p)
        + priced_field(card, "input_cached", cread_t, cread_p)
        + cache_write_cost
        + priced_field(card, "output", output_t, output_p);
    let unresolved = !peak_resolved && card_is_time_varying(card);
    Some((provider, currency, total, label, unresolved))
}

/// `{模型: 4 型 snake tokens}` → 价目报告。`claude_session_cost`（cost-state
/// camel 转换后，`peak_resolved=false`）与 `claude_day_cost`（ledger
/// by_model 直通，`peak_resolved=true`）共用——两面的钱必须同源，不在这里
/// 为日面长第二份计价规则（DSH 侧 token_by_date_model==token_by_model 那条
/// 纪律的 claude 镜像）；`peak_resolved` 只影响时变卡是否能做峰谷拆分，不
/// 影响这条"同源"纪律本身——两个调用方过的是同一个函数、同一套读法分界。
///
/// 未知模型（`<synthetic>` 等）→ token 四型全进 unpriced。注意与 `cost_report`
/// 的 unpriced 词表不同：那边不含 output（DSH 钉测形状），claude cost-state
/// 只有这 4 型、output 同样是真实消费，未知就该全数报出来，别悄悄吞掉 output。
fn price_claude_map(
    models: &serde_json::Map<String, Value>,
    pricing: &Value,
    peak_resolved: bool,
) -> Option<Value> {
    price_claude_map_preferring(models, pricing, peak_resolved, None)
}

fn price_claude_map_preferring(
    models: &serde_json::Map<String, Value>,
    pricing: &Value,
    peak_resolved: bool,
    preferred: Option<&str>,
) -> Option<Value> {
    let mut cny = 0.0f64;
    let mut usd = 0.0f64;
    let mut unpriced = 0i64;
    let mut per_model = serde_json::Map::new();
    let mut any_unresolved = false;
    for (model, tokens) in models {
        if tokens.as_object().is_none() {
            continue;
        }
        match price_claude_model_preferring(model, tokens, pricing, peak_resolved, preferred) {
            Some((provider, currency, total, tier, unresolved)) => {
                if unresolved {
                    any_unresolved = true;
                }
                if currency == "USD" {
                    usd += total;
                } else {
                    // 币种只可能是目录卡显式写的 USD/CNY 或顶层段默认 CNY；
                    // 真有第三种币种落进来会静默混进 CNY——加新币种时改这里。
                    cny += total;
                }
                let mut entry = json!({
                    "short_name": model_short(model, pricing),
                    "currency": currency,
                    "pricing_basis": if unresolved { "partial" } else { "catalog" },
                    "priced_with": provider,
                    "total": total,
                });
                if let Some(label) = tier {
                    entry["tier"] = json!(label);
                }
                per_model.insert(model.clone(), entry);
            }
            None => {
                unpriced += get_i64(tokens, "input_tokens")
                    + get_i64(tokens, "cache_read_input_tokens")
                    + get_i64(tokens, "cache_creation_input_tokens")
                    + get_i64(tokens, "output_tokens");
            }
        }
    }
    if per_model.is_empty() && unpriced == 0 {
        return None;
    }
    Some(json!({
        "pricing_basis": if any_unresolved { "partial" } else { "catalog" },
        "currency_totals": {"CNY": cny, "USD": usd},
        "per_model": Value::Object(per_model),
        "unpriced_tokens": unpriced,
        "estimate_disclaimer": "按模型族官方卡折算的估算，不是账单",
    }))
}

/// cost-state 的 modelUsage（camelCase：inputTokens/outputTokens/
/// cacheReadInputTokens/cacheCreationInputTokens/costUSD）→ 会话账金额。
/// 键名转 claude snake 后走 `price_claude_map`——转换只有键名映射，不重算。
/// `webSearchRequests`/`costUSD` 不参与计价（web search 没有 token 单价；
/// costUSD 对网关模型按默认卡 $5/$0.5/$25 计、高估 20–70×——harness_costusd_note
/// 说清了，绝不能当账单数字）。modelUsage 为空/缺场 → None。
///
/// `peak_resolved=false`：cost-state 的累计口径没有逐行 ts，压根不知道这些
/// token 里有多少落在高峰时段——时变卡这里恒报 `pricing_basis="partial"`
/// （v0.6.x 前置热修，2026-09-03；此前这里悄悄按 off_peak 下界算出一个
/// 看似精确的数字，是被撤销的旧行为）。与 `claude_day_cost` 共用
/// `price_claude_map`，两面同源。
pub fn claude_session_cost(model_usage: &Value, pricing: &Value) -> Option<Value> {
    let mu = model_usage.as_object()?;
    let mut models = serde_json::Map::new();
    for (model, ms) in mu {
        if ms.as_object().is_none() {
            continue;
        }
        models.insert(
            model.clone(),
            json!({
                "input_tokens": get_i64(ms, "inputTokens"),
                "cache_read_input_tokens": get_i64(ms, "cacheReadInputTokens"),
                "cache_creation_input_tokens": get_i64(ms, "cacheCreationInputTokens"),
                "output_tokens": get_i64(ms, "outputTokens"),
            }),
        );
    }
    if models.is_empty() {
        return None;
    }
    price_claude_map(&models, pricing, false)
}

/// claude-ledger 的一天 → 当日金额。两种形状都认：
/// - **by_model 包一层** `{by_model: {模型: 4 型 snake}}`——本函数早期设计
///   （无生产调用方）；
/// - **flat 直图** `{模型: 4 型 snake}`——claude_cost.rs `rebuild_days` 的真实
///   形状：逐日账只有 token、模型直作键。
///
/// 真实账本没有模型叫 `by_model`，嗅 `by_model` 键无歧义；哪天日面想再挂
/// `cny_total` 之类日级元数据，by_model 包一层也只是 flat 的直接超集。
///
/// 结构与 `claude_session_cost` 完全相同（同一个 `price_claude_map`），只是输入
/// 已 4 型 snake、无需转换。没有任何模型可计价的日子（空 map / 全是零 token 的
/// 未知模型 → price_claude_map 返回 None）→ None：调用方自己决定退回哪种近似，
/// 不摆全零结构。
///
/// `peak_resolved=true`：v0.6.x 前置热修后（2026-09-03），ledger 日桶的每个
/// 模型都带 `peak_` 前缀的峰值子桶（`claude_cost.rs::PEAK_KEYS`，来自
/// `tail_days` 逐行真实 ts，精确不是估算），时变卡走峰谷拆分计价，
/// `pricing_basis="catalog"`——不再是 v0.6 spec §8 G10 登记过的
/// `pending v0.7`/`pending v0.6.x` 缺口。
pub fn claude_day_cost(day: &Value, pricing: &Value) -> Option<Value> {
    claude_day_cost_preferring(day, pricing, None)
}

/// [`claude_day_cost`] 的归因版：`preferred` 是用户在计费声明里指定的计费方，
/// 其价卡收录的模型按它的价算（`per_model[].priced_with == preferred`），
/// 其余退回目录路由的官方价。
pub fn claude_day_cost_preferring(day: &Value, pricing: &Value, preferred: Option<&str>) -> Option<Value> {
    let models = match day.get("by_model") {
        Some(wrapped) => wrapped.as_object()?,
        None => day.as_object()?,
    };
    if models.is_empty() {
        return None;
    }
    price_claude_map_preferring(models, pricing, true, preferred)
}

/// 未落入已声明订阅覆盖范围（估算）——v0.7 spec §3 交付矩阵第二行，**provider
/// 粒度**版本（澄清后的选择：模型粒度需要新增结构化字段，与"零新数据"矛盾；
/// provider 粒度复用 `pricing.json` 现有 `catalog_2026_09.subscriptions.*`
/// 字段即可判定，代价是这个视图判的是 provider 整体有没有已声明订阅，不是
/// 逐模型——因此叫"未落入已声明订阅覆盖范围"而不是"模型集排除"）。
///
/// `models` 是 claude 4 型 snake 键 tokens（ledger 的 `by_model` 或 cost-state
/// 转换后的形状，与 `claude_day_cost`/`claude_session_cost` 同型）。provider
/// 在 `catalog_2026_09.subscriptions.*.provider` 出现过 → 该 provider 全部
/// 用量视为已订阅覆盖，不进本视图；没出现过 → 全部 token 进本视图的 catalog
/// 反事实金额，标 `pricing_basis="estimated-subscription-exclusion"`——不得
/// 据此断言这是真实按量现金成本（可能仍是企业套餐、免费额度、代理路由或
/// 未知来源，v0.7 spec §3 原文措辞）。`models` 为空/无可归属 provider 的模型
/// → `None`。
pub fn claude_subscription_uncovered_estimate(
    models: &serde_json::Map<String, Value>,
    pricing: &Value,
) -> Option<Value> {
    let covered: std::collections::HashSet<String> = pricing
        .pointer("/catalog_2026_09/subscriptions")
        .and_then(Value::as_object)
        .map(|subs| {
            subs.iter()
                .filter(|(k, _)| k.as_str() != "_doc")
                .filter_map(|(_, v)| v.get("provider").and_then(Value::as_str).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let mut uncovered = serde_json::Map::new();
    for (model, tokens) in models {
        if tokens.as_object().is_none() {
            continue;
        }
        let Some((provider, _key, _currency)) = resolve_card_catalog(model, pricing) else {
            continue; // 未知模型：本视图只处理"能定位到 provider 才能判是否覆盖"的模型
        };
        if covered.contains(&provider) {
            continue;
        }
        uncovered.insert(model.clone(), tokens.clone());
    }
    if uncovered.is_empty() {
        return None;
    }
    let mut report = price_claude_map(&uncovered, pricing, true)?;
    report["pricing_basis"] = json!("estimated-subscription-exclusion");
    if let Some(per_model) = report["per_model"].as_object_mut() {
        for pm in per_model.values_mut() {
            pm["pricing_basis"] = json!("estimated-subscription-exclusion");
        }
    }
    report["estimate_disclaimer"] = json!(
        "未落入已声明订阅覆盖范围的估算；可能仍属企业套餐、免费额度、代理路由或未知来源，不构成按量现金成本的确认"
    );
    Some(report)
}

/// claude-ledger 一天 → 4 型 token 总量。形状嗅探与 `claude_day_cost` 是同一对
/// （by_model 包一层 / flat 直图都认）——两个函数必须认同同一种日形状，不然
/// 「消耗量」和「折算钱」会是两张对不齐的账（token_by_date_model == token_by_model
/// 那条纪律的 claude 镜像：托盘合并行要 `· N tokens`，就得由驱动 claude_day_cost
/// 的同一个日结构算出来）。
///
/// 与 `price_claude_map` 的未知模型路径**不同**：这里所有模型都计入——计价只认
/// 得上目录卡的模型，消耗量跟认不认识价目卡无关（全 unknown 的日 token 依旧在
/// 账；`price_claude_map` 里 `<synthetic>` 的空 map 日在此处自然计 0）。坏日
/// （非对象值）→ 0；空日不落 ledger，正常路径不会出现 0。
pub fn claude_day_total_tokens(day: &Value) -> i64 {
    let models = match day.get("by_model") {
        Some(wrapped) => match wrapped.as_object() {
            Some(o) => o,
            None => return 0,
        },
        None => match day.as_object() {
            Some(o) => o,
            None => return 0,
        },
    };
    let mut total = 0i64;
    for tokens in models.values() {
        total += get_i64(tokens, "input_tokens")
            + get_i64(tokens, "cache_read_input_tokens")
            + get_i64(tokens, "cache_creation_input_tokens")
            + get_i64(tokens, "output_tokens");
    }
    total
}
