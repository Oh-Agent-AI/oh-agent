//! 用户本地的价目覆盖层：**归属声明（routes）** + **补价卡（cards）**。
//!
//! **为什么需要一层覆盖**：价目表 `assets/pricing.json` 是 `include_str!` **编进
//! 二进制**的——运行时改不了。而下面两件事都必然反复发生：
//!
//! 1. **归属定不下来**：`billing_route_of` 只读 `catalog_2026_09.billing_modes`
//!    （模型名前缀 → 服务商），公共目录只声明了少数几条（2026-09 只有
//!    `deepseek-v4*`）。厂商出新型号、或走网关/中转时，型号名对不上任何前缀 →
//!    整批用量 `billing-route-unknown`。**这不是"怎么付"的问题，是"算谁的"**——
//!    所以计费声明（`billing_declarations`）解决不了它，必须补一条路由。
//! 2. **有归属但没价卡**：路由命中、价卡缺失 → `no-price-card`。
//!
//! 两件事在同一层，所以放在同一个文件里，形成一条链：
//! `路由未确认 → 声明归属 → （可能）缺价卡 → 补价卡`。
//!
//! 存放在 `state/pricing-overrides.json`（与既有的几个偏好文件同规格），形状就是
//! 价目表里对应的那两小片，合并时直接盖上去——**不加任何新概念**。
//!
//! **只覆盖 `providers`（CNY 官方列表）与 `catalog_2026_09.billing_modes`。**
//! 不碰 `codex_pricing`（USD）——币种混了会直接算错钱。
//!
//! **诚实边界**：用户声明的是**用户提供的证据**，不是官方结论。它让"算不出来"
//! 变成"按他说的算得出来"，但展示层不该把它当官方归属/标价——目前只在设置页的
//! 列表里标注，费用明细的定价依据还没区分出"用户声明"这一档（待办）。

use std::path::Path;

use serde_json::{json, Value};

const FILE: &str = "pricing-overrides.json";

fn path_of(data_home: &Path) -> std::path::PathBuf {
    data_home.join("state").join(FILE)
}

/// 读覆盖层。**缺场或损坏一律当"没有覆盖"**（返回空对象）——补卡是增强信息，
/// 一个坏文件不该让计价整体失败，更不该让金额变成读不出来的状态。
pub fn load(data_home: &Path) -> Value {
    // 两个键都要在：`cards` 与 `routes` 各自独立，缺任一个都会让另一半的写入
    // 报"文件畸形"（实测踩过：只补了 cards 的默认值，save_route 直接失败）。
    let empty = || json!({ "version": 1, "cards": {}, "routes": {} });
    let Ok(text) = std::fs::read_to_string(path_of(data_home)) else {
        return empty();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return empty();
    };
    if !value.is_object() {
        return empty();
    }
    let mut value = value;
    if !value.get("cards").is_some_and(Value::is_object) {
        value["cards"] = json!({});
    }
    if !value.get("routes").is_some_and(Value::is_object) {
        value["routes"] = json!({});
    }
    if !value.get("currencies").is_some_and(Value::is_object) {
        value["currencies"] = json!({});
    }
    value
}

/// 用户新建的服务商（目录里没有的）所声明的报价币种：`provider → ISO 币种`。
pub fn currencies(data_home: &Path) -> serde_json::Map<String, Value> {
    load(data_home).get("currencies").and_then(Value::as_object).cloned().unwrap_or_default()
}

/// 保存价卡并**校验币种**。价卡本身没有币种字段，币种是服务商级的（目录里的
/// `providers.<p>.currency`）；如果表单让用户以 USD 填数、计价却按服务商的 CNY 解释，
/// 就会出现「美元数字被标成人民币」的错误金额——比直接拒绝更糟。所以：
/// - 服务商的报价币种已知（目录，或此前用户为新服务商声明过）→ 卡币种必须与之一致，否则拒绝，
///   并明确说明不做任何换算；
/// - 服务商是新的（币种未知）→ 以这次声明的币种为准并记下来，之后同一服务商的卡必须同币种。
///
/// 同一服务商同时有两套官方报价（如 DeepSeek USD / CNY，`quote_variants`）：第一张用户卡可选其中任一币种，
/// 并把该服务商钉在这个币种上（见 `quote_variants`）；之后的卡必须同币种。卡本身仍没有卡级币种。
pub fn save_card_checked(
    data_home: &Path,
    provider: &str,
    model: &str,
    card: &Value,
    currency: &str,
) -> Result<(), String> {
    let currency = currency.trim();
    if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_uppercase()) {
        return Err(format!("currency {currency:?} must be a 3-letter ISO code such as USD or CNY"));
    }
    let provider_key = provider.trim();
    if provider_key.is_empty() {
        return Err("服务商与型号都不能为空".to_string());
    }
    let catalog = agent_vitals_domain::cost::load_pricing();
    let offered = crate::pricing::quote_variants::offered_currencies(&catalog, provider_key);
    let has_cards = cards(data_home).get(provider_key).and_then(Value::as_object).is_some_and(|m| !m.is_empty());
    let recorded = currencies(data_home).get(provider_key).and_then(Value::as_str).map(str::to_string);
    let known = match &offered {
        // 并列报价的服务商：还没有用户卡 → 可从它提供的几个币种里任选一个（这张卡会把该服务商钉在这个币种上）；
        // 已经有用户卡 → 必须与那些卡同币种，不能在同一服务商下混币种。
        Some(options) => {
            if !options.iter().any(|c| c == currency) {
                return Err(format!("provider {provider_key} is quoted in {}; a {currency} card cannot be saved under it", options.join(" / ")));
            }
            if has_cards { recorded.clone().or_else(|| agent_vitals_domain::cost::provider_quote_currency(provider_key, &catalog)) } else { None }
        }
        None => agent_vitals_domain::cost::provider_quote_currency(provider_key, &catalog).or_else(|| recorded.clone()),
    };
    if let Some(quote) = known {
        if quote != currency {
            return Err(format!(
                "provider {provider_key} quotes in {quote}; a {currency} card cannot be saved under it (no currency conversion is done)"
            ));
        }
    }
    // 先校验卡本身（半张卡拒绝），再落币种，避免卡非法时留下一个孤立的币种声明。
    sanitize_card(card)?;
    save_card(data_home, provider, model, card)?;
    if offered.is_some() || known_is_none_in_catalog(provider_key, &catalog) {
        let mut root = load(data_home);
        root["currencies"][provider_key] = json!(currency);
        write(data_home, &root)?;
    }
    Ok(())
}

fn known_is_none_in_catalog(provider: &str, catalog: &Value) -> bool {
    agent_vitals_domain::cost::provider_quote_currency(provider, catalog).is_none()
}

/// 覆盖层里全部卡片：`provider → model → 卡片`。
pub fn cards(data_home: &Path) -> serde_json::Map<String, Value> {
    load(data_home)
        .get("cards")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// 覆盖层里全部归属声明：`型号前缀 → {provider, mode}`。
pub fn routes(data_home: &Path) -> serde_json::Map<String, Value> {
    load(data_home)
        .get("routes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// 声明一条归属：型号前缀 → 服务商 + 计费模式（`metered` / `subscription`）。
///
/// 用**前缀**而不是全名，与价目表 `billing_modes` 的既有语义一致
/// （`model_matches` 是全等或前缀匹配，`glm-5.3-flash` 靠 `glm-5.3` 命中）。
pub fn save_route(
    data_home: &Path,
    model_prefix: &str,
    provider: &str,
    mode: &str,
) -> Result<(), String> {
    let model_prefix = model_prefix.trim();
    let provider = provider.trim();
    if model_prefix.is_empty() || provider.is_empty() {
        return Err("型号与服务商都不能为空".to_string());
    }
    if !matches!(mode, "metered" | "subscription") {
        return Err("计费模式只能是 metered 或 subscription".to_string());
    }
    let mut root = load(data_home);
    let routes = root
        .get_mut("routes")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "pricing overrides file is malformed".to_string())?;
    routes.insert(
        model_prefix.to_string(),
        json!({ "provider": provider, "mode": mode }),
    );
    root["version"] = json!(1);
    write(data_home, &root)
}

pub fn remove_route(data_home: &Path, model_prefix: &str) -> Result<(), String> {
    let mut root = load(data_home);
    if let Some(routes) = root.get_mut("routes").and_then(Value::as_object_mut) {
        routes.remove(model_prefix);
    }
    write(data_home, &root)
}

/// 写入/替换一张卡。`card` 只保留计价认得的那三个维度（峰谷各两档），多余字段
/// 一律丢弃——覆盖层的形状必须与价目表的卡**同形**，否则读价路径读到半截卡会
/// 静默按缺档算钱。
pub fn save_card(
    data_home: &Path,
    provider: &str,
    model: &str,
    card: &Value,
) -> Result<(), String> {
    let provider = provider.trim();
    let model = model.trim();
    if provider.is_empty() || model.is_empty() {
        return Err("服务商与型号都不能为空".to_string());
    }
    let sanitized = sanitize_card(card)?;
    let mut root = load(data_home);
    let cards = root
        .get_mut("cards")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "pricing overrides file is malformed".to_string())?;
    let entry = cards
        .entry(provider.to_string())
        .or_insert_with(|| json!({}));
    let models = entry
        .as_object_mut()
        .ok_or_else(|| format!("provider {provider} entry is malformed"))?;
    models.insert(model.to_string(), sanitized);
    root["version"] = json!(1);
    write(data_home, &root)
}

pub fn remove_card(data_home: &Path, provider: &str, model: &str) -> Result<(), String> {
    let mut root = load(data_home);
    if let Some(models) = root
        .get_mut("cards")
        .and_then(Value::as_object_mut)
        .and_then(|cards| cards.get_mut(provider))
        .and_then(Value::as_object_mut)
    {
        models.remove(model);
    }
    write(data_home, &root)
}

fn write(data_home: &Path, root: &Value) -> Result<(), String> {
    let directory = data_home.join("state");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let target = directory.join(FILE);
    let temporary = directory.join("pricing-overrides.json.tmp");
    let contents = serde_json::to_vec_pretty(root).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, target).map_err(|error| error.to_string())
}

/// 只保留计价认得的维度、每个维度只保留 `off_peak`/`peak` 两个非负有限数。
/// 三个必填维度任一缺失或非法 → 整张卡拒绝（**不做部分接受**：半张卡会让计价按缺档静默
/// 算出一个看似正常的错数字，比没有卡更糟——没有卡至少会诚实地报"未计价"）。
/// 第四维 `cache_write` **可选**（2026-09-17：胜算云把非命中输入都记作"写入"，中转卡
/// 没有这一档就把缓存写入算成 0）；给了就必须合法，给了半截同样整卡拒绝。
fn sanitize_card(card: &Value) -> Result<Value, String> {
    let dimensions = ["input_uncached", "input_cached", "output", "cache_write"];
    let mut out = serde_json::Map::new();
    for dimension in dimensions {
        if dimension == "cache_write" && card.get(dimension).is_none() {
            continue;
        }
        let entry = card
            .get(dimension)
            .and_then(Value::as_object)
            .ok_or_else(|| format!("{dimension} 缺失"))?;
        let mut rates = serde_json::Map::new();
        for tariff in ["off_peak", "peak"] {
            let value = entry
                .get(tariff)
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v >= 0.0)
                .ok_or_else(|| format!("{dimension}.{tariff} 必须是非负数字"))?;
            rates.insert(tariff.to_string(), json!(value));
        }
        out.insert(dimension.to_string(), Value::Object(rates));
    }
    Ok(Value::Object(out))
}

/// 主价目表 = 嵌入表 + 用户补的卡。**所有要计价的调用方都该走这里**。
///
/// 只改 `summary` 那一处是不够的：预算比例（`budget::evaluate_alert_from_sql`）、
/// 行为审计成本（`behavior::audit_payload`）与 DSH 月成本各自也算钱，它们若读
/// 未合并的表，同一个模型会在一个面上"有价"、另一个面上"没价"——2026-09-14 实测
/// 就出现过 `data-unresolved` 归零而 `data-status` 仍报同一批 token 无价卡。
pub fn merged_main(data_home: &Path) -> Value {
    let mut main = agent_vitals_domain::cost::load_pricing();
    apply_to_main(&mut main, data_home);
    main
}

/// 把覆盖层盖到一份 `main` 价目表上（`providers.<p>.models.<m>`）。
///
/// **在读取时合并，而不是写进快照**：价目表本体随版本更新会被换掉（`asof` 按
/// 快照时点选卡），如果只在某一刻把用户卡烤进某份快照，下一次价目表更新就会
/// 把用户补的卡冲掉。读取时合并则**永远盖在最上面**。
pub fn apply_to_main(main: &mut Value, data_home: &Path) {
    // 并列报价先于用户卡：用户给某服务商补过卡 → 那个服务商保持基础卡（见 quote_variants 的 pinned 规则）。
    crate::pricing::quote_variants::apply(main, data_home);
    apply_routes(main, data_home);
    let overlay = cards(data_home);
    if overlay.is_empty() {
        return;
    }
    let Some(providers) = main.get_mut("providers").and_then(Value::as_object_mut) else {
        return;
    };
    for (provider, models) in overlay {
        let Some(models) = models.as_object() else { continue };
        let declared_currency = currencies(data_home).get(provider.as_str()).and_then(Value::as_str).map(str::to_string);
        let entry = providers
            .entry(provider.clone())
            .or_insert_with(|| match &declared_currency {
                Some(currency) => json!({ "label": provider, "currency": currency, "models": {} }),
                None => json!({ "label": provider, "models": {} }),
            });
        let Some(entry_models) = entry
            .as_object_mut()
            .and_then(|e| e.entry("models".to_string()).or_insert_with(|| json!({})).as_object_mut())
        else {
            continue;
        };
        for (model, card) in models {
            entry_models.insert(model.clone(), card.clone());
        }
    }
}

/// 把用户声明的归属塞进 `catalog_2026_09.billing_modes`。
///
/// 追加前缀而不是替换整节：公共目录里已有的声明（如 `deepseek-v4`）不该被用户的
/// 一条声明抹掉。同名前缀已存在则跳过（幂等）。
fn apply_routes(main: &mut Value, data_home: &Path) {
    let declared = routes(data_home);
    if declared.is_empty() {
        return;
    }
    let Some(modes) = main
        .pointer_mut("/catalog_2026_09/billing_modes")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    for (prefix, route) in declared {
        let Some(provider) = route.get("provider").and_then(Value::as_str) else {
            continue;
        };
        let mode = route
            .get("mode")
            .and_then(Value::as_str)
            .filter(|m| matches!(*m, "metered" | "subscription"))
            .unwrap_or("metered");
        let entry = modes
            .entry(provider.to_string())
            .or_insert_with(|| json!({ "mode": mode, "models": [] }));
        if let Some(models) = entry.get_mut("models").and_then(Value::as_array_mut) {
            if !models.iter().any(|m| m.as_str() == Some(prefix.as_str())) {
                models.push(json!(prefix));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!(
            "av-price-override-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&home);
        home
    }

    /// 2026-10-01：卡没有币种字段，币种是服务商级的。USD 数字存进 CNY 服务商、再被当人民币计价
    /// 会得到「美元被标成人民币」的错误金额——保存时必须校验币种。
    #[test]
    fn saving_a_card_checks_its_currency_against_the_providers_quote_currency() {
        let home = tmp("currency-guard");
        // shengsuanyun 在目录里是 CNY；anthropic 是 USD
        assert!(save_card_checked(&home, "shengsuanyun", "gpt-x", &card(1.0), "CNY").is_ok());
        let err = save_card_checked(&home, "shengsuanyun", "gpt-y", &card(1.0), "USD").unwrap_err();
        assert!(err.contains("quotes in CNY") && err.contains("no currency conversion"), "{err}");
        assert!(save_card_checked(&home, "anthropic", "claude-x", &card(1.0), "USD").is_ok());
        let err = save_card_checked(&home, "anthropic", "claude-y", &card(1.0), "CNY").unwrap_err();
        assert!(err.contains("quotes in USD"), "{err}");
        // 币种格式
        for bad in ["", "usd", "US", "USDX", "U5D"] {
            assert!(save_card_checked(&home, "anthropic", "m", &card(1.0), bad).is_err(), "{bad:?}");
        }
        // 非法卡不会留下孤立的币种声明
        assert!(save_card_checked(&home, "brand-new", "m", &json!({"output": {}}), "EUR").is_err());
        assert!(currencies(&home).get("brand-new").is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_new_provider_gets_its_currency_from_the_first_card_and_later_cards_must_match() {
        let home = tmp("currency-new-provider");
        assert!(save_card_checked(&home, "us-relay", "m1", &card(2.0), "USD").is_ok());
        assert_eq!(currencies(&home).get("us-relay").and_then(Value::as_str), Some("USD"));
        assert!(save_card_checked(&home, "us-relay", "m2", &card(2.0), "USD").is_ok());
        assert!(save_card_checked(&home, "us-relay", "m3", &card(2.0), "CNY").is_err(), "同一服务商后续的卡必须同币种");
        // 计价读的价目表里，新服务商条目带着这个币种（否则会被当成「未知币种」）
        let mut main = agent_vitals_domain::cost::load_pricing();
        apply_to_main(&mut main, &home);
        assert_eq!(agent_vitals_domain::cost::provider_quote_currency("us-relay", &main).as_deref(), Some("USD"));
        // 目录里已有币种的服务商，覆盖层不能改写它
        assert_eq!(agent_vitals_domain::cost::provider_quote_currency("anthropic", &main).as_deref(), Some("USD"));
        let _ = std::fs::remove_dir_all(&home);
    }

    fn card(off: f64) -> Value {
        json!({
            "input_uncached": { "off_peak": off, "peak": off * 2.0 },
            "input_cached": { "off_peak": off / 10.0, "peak": off / 5.0 },
            "output": { "off_peak": off * 4.0, "peak": off * 8.0 },
        })
    }

    #[test]
    fn save_overrides_the_card_without_touching_the_base_table() {
        let home = tmp("merge");
        let mut main = json!({
            "providers": {
                "deepseek-official": {
                    "label": "DeepSeek 原厂",
                    "models": { "deepseek-v4-pro": card(4.5) }
                }
            }
        });
        // 没有覆盖时不动。
        apply_to_main(&mut main, &home);
        assert!(main["providers"]["deepseek-official"]["models"].get("deepseek-v4.9-ultra").is_none());

        save_card(&home, "deepseek-official", "deepseek-v4.9-ultra", &card(1.0)).unwrap();
        apply_to_main(&mut main, &home);
        let added = &main["providers"]["deepseek-official"]["models"]["deepseek-v4.9-ultra"];
        assert_eq!(added["input_uncached"]["off_peak"], 1.0);
        // 原有的卡一个都不能动。
        assert_eq!(
            main["providers"]["deepseek-official"]["models"]["deepseek-v4-pro"]["input_uncached"]["off_peak"],
            4.5
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn route_declaration_extends_billing_modes_without_clobbering_the_public_ones() {
        // 归属与价卡是同一层的两件事，但**互不替代**：只声明归属还不够（那只会让
        // 状态从 route-unknown 变成 no-price-card），所以两者要能独立存在。
        let home = tmp("route");
        let mut main = json!({
            "catalog_2026_09": { "billing_modes": {
                "deepseek-official": { "mode": "metered", "models": ["deepseek-v4"] }
            }}
        });
        save_route(&home, "acme-model", "acme", "metered").unwrap();
        apply_to_main(&mut main, &home);
        let modes = &main["catalog_2026_09"]["billing_modes"];
        assert_eq!(modes["acme"]["models"][0], "acme-model");
        assert_eq!(modes["acme"]["mode"], "metered");
        // 公共目录里已有的声明一个字都不能动。
        assert_eq!(modes["deepseek-official"]["models"][0], "deepseek-v4");

        // 幂等：重复声明不追加第二次。
        save_route(&home, "acme-model", "acme", "metered").unwrap();
        apply_to_main(&mut main, &home);
        assert_eq!(main["catalog_2026_09"]["billing_modes"]["acme"]["models"].as_array().unwrap().len(), 1);

        // 追加到**已有**服务商上：前缀进同一个数组。
        save_route(&home, "deepseek-v5", "deepseek-official", "metered").unwrap();
        apply_to_main(&mut main, &home);
        let ds = &main["catalog_2026_09"]["billing_modes"]["deepseek-official"]["models"];
        assert_eq!(ds.as_array().unwrap().len(), 2, "应追加到同一服务商");

        // 非法模式拒绝（拼错的 mode 会让归属层静默变 Unknown）。
        assert!(save_route(&home, "x", "y", "monthly").is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_half_card_is_rejected_rather_than_silently_mispricing() {
        // 半张卡会让计价按缺档算出一个看似正常的错数字——比"没有卡"更糟。
        let home = tmp("half");
        let half = json!({ "input_uncached": { "off_peak": 1.0, "peak": 2.0 } });
        assert!(save_card(&home, "p", "m", &half).is_err(), "缺维度必须拒绝");
        let negative = json!({
            "input_uncached": { "off_peak": -1.0, "peak": 2.0 },
            "input_cached": { "off_peak": 0.1, "peak": 0.2 },
            "output": { "off_peak": 4.0, "peak": 8.0 },
        });
        assert!(save_card(&home, "p", "m", &negative).is_err(), "负数必须拒绝");
        assert!(save_card(&home, "p", "m", &card(1.0)).is_ok());
        // 覆盖层里落的一定是"同形"的卡（只有三个维度）。
        let stored = cards(&home);
        let got = &stored["p"]["m"];
        assert_eq!(got.as_object().unwrap().len(), 3, "多余字段必须被丢掉");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn corrupted_overlay_degrades_to_no_overrides_instead_of_failing_pricing() {
        let home = tmp("corrupt");
        std::fs::create_dir_all(home.join("state")).unwrap();
        std::fs::write(home.join("state").join(FILE), b"not json").unwrap();
        assert!(cards(&home).is_empty(), "坏文件必须降级成没有覆盖");
        let mut main = json!({ "providers": {} });
        apply_to_main(&mut main, &home); // 不 panic、不写坏形状
        assert!(main["providers"].as_object().unwrap().is_empty());
        // 坏文件之后仍能正常写入（不被坏内容卡住）。
        save_card(&home, "p", "m", &card(1.0)).unwrap();
        assert!(!cards(&home).is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    /// 第四维 `cache_write` 可选：不给 → 卡里没有；给合法 → 原样保留；给半截 → 整卡拒绝
    /// （与三个必填维一样不做部分接受）。
    #[test]
    fn save_card_keeps_optional_cache_write_and_rejects_a_broken_one() {
        let home = tmp("cache-write");
        save_card(&home, "p", "plain", &card(1.0)).unwrap();
        assert!(cards(&home)["p"]["plain"].get("cache_write").is_none());
        let mut full = card(1.0);
        full["cache_write"] = json!({ "off_peak": 3.0, "peak": 4.0 });
        save_card(&home, "p", "full", &full).unwrap();
        assert_eq!(cards(&home)["p"]["full"]["cache_write"], json!({ "off_peak": 3.0, "peak": 4.0 }));
        let mut broken = card(1.0);
        broken["cache_write"] = json!({ "off_peak": 3.0 });
        assert!(save_card(&home, "p", "broken", &broken).is_err(), "half a cache_write must reject the whole card");
        assert!(cards(&home)["p"].get("broken").is_none());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn remove_card_drops_only_that_model() {
        let home = tmp("remove");
        save_card(&home, "p", "a", &card(1.0)).unwrap();
        save_card(&home, "p", "b", &card(2.0)).unwrap();
        remove_card(&home, "p", "a").unwrap();
        let stored = cards(&home);
        assert!(stored["p"].get("a").is_none());
        assert!(stored["p"].get("b").is_some());
        let _ = std::fs::remove_dir_all(home);
    }
}
