//! 并列报价：同一服务商官方给了不同币种的两套价（`providers.<p>.quote_variants.<币种>`）。
//!
//! 两套是**各自的官方报价，不是互相换算**——这里只决定「这一刻用哪一套」，选中后整套替换
//! （币种与模型价格一起换），绝不拿汇率合成第三套。替换发生在读价卡的唯一入口
//! （`price_overrides::apply_to_main`），所以 DSH / Claude / Codex / MCP 各条金额路径
//! 自动一致，不需要逐路径传「选哪套」。
//!
//! 选择顺序（`quote_selection.source` 如实记录，界面据此标注）：
//! 1. `user_choice`：用户在设置里明确选了某个币种；
//! 2. `default_assumption`：没选过，按**报告币种**挑——这是一个**假设**，不是账户证据
//!    （规格 §6 反对用地区推断结算币种；产品决定接受它，条件是必须标成默认假设）；
//! 3. `base_quote`：没有可用的依据（没记过区域/报告币种，或报告币种没有对应的变体）→
//!    保持基础卡，不猜；
//! 4. `pinned_by_user_cards`：用户给该服务商补过自己的价卡。那些卡是按某个币种填的，
//!    换套报价会让它们悄悄变币种，所以此时不换。

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::core::fx_settings::{read_json, reporting_currency_if_known, state_path, write_atomic};

const CHOICE_FILE: &str = "pricing-quote-choice.json";

pub const USER_CHOICE: &str = "user_choice";
pub const DEFAULT_ASSUMPTION: &str = "default_assumption";
pub const BASE_QUOTE: &str = "base_quote";
pub const PINNED_BY_USER_CARDS: &str = "pinned_by_user_cards";

fn variants_of(entry: &Value) -> BTreeMap<String, Value> {
    entry.get("quote_variants").and_then(Value::as_object).map(|map| {
        map.iter()
            // `_doc` 之类的说明键不是币种；变体必须带 models 对象。
            .filter(|(code, v)| !code.starts_with('_') && v.get("models").is_some_and(Value::is_object))
            .map(|(code, v)| (code.to_ascii_uppercase(), v.clone()))
            .collect()
    }).unwrap_or_default()
}

/// 该服务商同时提供的报价币种（基础卡币种 + 各变体）。没有并列报价 → None。
pub fn offered_currencies(main: &Value, provider: &str) -> Option<Vec<String>> {
    let entry = main.pointer(&format!("/providers/{provider}"))?;
    let variants = variants_of(entry);
    if variants.is_empty() { return None; }
    let base = entry.get("currency").and_then(Value::as_str)?.to_ascii_uppercase();
    Some(std::iter::once(base).chain(variants.keys().cloned()).collect())
}

/// 用户的明确选择：`{provider: currency}`。
pub fn choices(data_home: &Path) -> BTreeMap<String, String> {
    read_json(&state_path(data_home, CHOICE_FILE)).ok().flatten()
        .and_then(|v| v.get("choices").and_then(Value::as_object).cloned())
        .map(|m| m.into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_ascii_uppercase()))).collect())
        .unwrap_or_default()
}

/// 保存（`Some`）或清除（`None`，回到默认假设）用户对某服务商的报价币种选择。
/// 只接受该服务商真实提供的币种（基础卡币种或某个变体）。
pub fn save_choice(data_home: &Path, provider: &str, currency: Option<&str>) -> Result<(), String> {
    let main = agent_vitals_domain::cost::load_pricing();
    let entry = main.pointer(&format!("/providers/{provider}")).ok_or_else(|| format!("unknown provider {provider}"))?;
    let variants = variants_of(entry);
    if variants.is_empty() { return Err(format!("{provider} has a single quote currency; nothing to choose")); }
    let mut all = choices(data_home);
    match currency {
        Some(code) => {
            let code = code.trim().to_ascii_uppercase();
            let base = entry.get("currency").and_then(Value::as_str).unwrap_or("").to_ascii_uppercase();
            if code != base && !variants.contains_key(&code) {
                return Err(format!("{provider} is not quoted in {code}"));
            }
            all.insert(provider.to_string(), code);
        }
        None => { all.remove(provider); }
    }
    write_atomic(&state_path(data_home, CHOICE_FILE), &json!({ "choices": all }))
}

/// 把并列报价的选择落到一份 `main` 上。幂等：已处理过的服务商（带 `quote_selection`）跳过。
pub fn apply(main: &mut Value, data_home: &Path) {
    let chosen = choices(data_home);
    let known_default = reporting_currency_if_known(data_home);
    let user_cards = crate::pricing::price_overrides::cards(data_home);
    let Some(providers) = main.get_mut("providers").and_then(Value::as_object_mut) else { return };
    for (provider, entry) in providers.iter_mut() {
        if entry.get("quote_selection").is_some() { continue; }
        let variants = variants_of(entry);
        if variants.is_empty() { continue; }
        let base = entry.get("currency").and_then(Value::as_str).unwrap_or("").to_ascii_uppercase();
        if base.is_empty() { continue; } // 基础卡没币种：不替换（缺币种的卡不得猜价）
        let mut available: Vec<String> = std::iter::once(base.clone()).chain(variants.keys().cloned()).collect();
        available.dedup();
        let has_user_cards = user_cards.get(provider).and_then(Value::as_object).is_some_and(|m| !m.is_empty());
        let (active, source) = if has_user_cards {
            // 用户卡是按某个币种填的：钉在那个币种（记录在覆盖层 currencies，没有记录 → 基础卡币种）。
            let pinned = crate::pricing::price_overrides::currencies(data_home).get(provider).and_then(Value::as_str)
                .map(str::to_ascii_uppercase).filter(|c| available.contains(c)).unwrap_or_else(|| base.clone());
            (pinned, PINNED_BY_USER_CARDS)
        } else if let Some(code) = chosen.get(provider).filter(|c| available.contains(c)) {
            (code.clone(), USER_CHOICE)
        } else if let Some(code) = known_default.as_ref().filter(|c| available.contains(c)) {
            (code.clone(), DEFAULT_ASSUMPTION)
        } else {
            (base.clone(), BASE_QUOTE)
        };
        if active != base {
            if let Some(variant) = variants.get(&active) {
                entry["currency"] = json!(active);
                entry["models"] = variant["models"].clone();
            }
        }
        entry["quote_selection"] = json!({
            "currency": active, "source": source, "base_currency": base, "available": available,
        });
    }
}

/// 设置页要的状态：每个有并列报价的服务商当前用哪套、为什么、能选什么。
pub fn status(data_home: &Path) -> Vec<Value> {
    let main = crate::pricing::price_overrides::merged_main(data_home);
    let chosen = choices(data_home);
    main.get("providers").and_then(Value::as_object).map(|providers| {
        providers.iter().filter_map(|(id, entry)| {
            let selection = entry.get("quote_selection")?;
            Some(json!({
                "provider": id,
                "label": entry.get("label").and_then(Value::as_str).unwrap_or(id),
                "active_currency": selection["currency"],
                "source": selection["source"],
                "available": selection["available"],
                "chosen_currency": chosen.get(id),
            }))
        }).collect()
    }).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fx_settings::{save_locale_hint, save_reporting_currency};

    fn home(tag: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("quote-variants-{tag}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    fn deepseek(main: &Value) -> (String, String, f64) {
        let entry = &main["providers"]["deepseek-official"];
        (
            entry["currency"].as_str().unwrap().into(),
            entry["quote_selection"]["source"].as_str().unwrap().into(),
            entry["models"]["deepseek-v4-pro"]["output"]["off_peak"].as_f64().unwrap(),
        )
    }

    #[test]
    fn the_shipped_variant_covers_exactly_the_base_models() {
        // 变体与基础卡模型集合不一致 → 切换币种时一部分用量凭空变成无价卡。
        let main = agent_vitals_domain::cost::load_pricing();
        let entry = &main["providers"]["deepseek-official"];
        let base: Vec<_> = entry["models"].as_object().unwrap().keys().cloned().collect();
        let variants = variants_of(entry);
        assert!(!variants.is_empty());
        for (code, variant) in variants {
            let keys: Vec<_> = variant["models"].as_object().unwrap().keys().cloned().collect();
            assert_eq!(keys, base, "{code} variant must price the same models as the base card");
        }
    }

    #[test]
    fn with_no_basis_the_base_card_is_kept_not_guessed() {
        let h = home("nobasis");
        let mut main = agent_vitals_domain::cost::load_pricing();
        apply(&mut main, &h);
        assert_eq!(deepseek(&main), ("CNY".into(), BASE_QUOTE.into(), 13.5), "no locale, no saved currency => no assumption");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn the_default_follows_the_reporting_currency_and_is_labelled_an_assumption() {
        let h = home("default");
        save_locale_hint(&h, "en-US").unwrap();
        let mut main = agent_vitals_domain::cost::load_pricing();
        apply(&mut main, &h);
        assert_eq!(deepseek(&main), ("USD".into(), DEFAULT_ASSUMPTION.into(), 1.98), "US locale => the USD quote, whole-card swap");
        // 没有换算：美元价就是官方美元价，不是 13.5 / 汇率
        assert!(main["providers"]["deepseek-official"]["quote_selection"]["available"].as_array().unwrap().iter().any(|c| c == "CNY"));
        // 中国区域 → 基础 CNY 卡，但仍标「默认假设」（这是依据区域做出的选择）
        let c = home("default-cn");
        save_locale_hint(&c, "zh-Hans-CN").unwrap();
        let mut cn = agent_vitals_domain::cost::load_pricing();
        apply(&mut cn, &c);
        assert_eq!(deepseek(&cn), ("CNY".into(), DEFAULT_ASSUMPTION.into(), 13.5));
        // 报告币种换成 EUR（两套报价都没有）→ 不猜，保持基础卡
        let e = home("default-eur");
        save_reporting_currency(&e, "EUR").unwrap();
        let mut eur = agent_vitals_domain::cost::load_pricing();
        apply(&mut eur, &e);
        assert_eq!(deepseek(&eur), ("CNY".into(), BASE_QUOTE.into(), 13.5));
        for d in [&h, &c, &e] { let _ = std::fs::remove_dir_all(d); }
    }

    #[test]
    fn an_explicit_choice_beats_the_default_and_clearing_it_returns_to_the_default() {
        let h = home("choice");
        save_locale_hint(&h, "zh-Hans-CN").unwrap();
        save_choice(&h, "deepseek-official", Some("usd")).unwrap();
        let mut main = agent_vitals_domain::cost::load_pricing();
        apply(&mut main, &h);
        assert_eq!(deepseek(&main), ("USD".into(), USER_CHOICE.into(), 1.98));
        save_choice(&h, "deepseek-official", None).unwrap();
        let mut again = agent_vitals_domain::cost::load_pricing();
        apply(&mut again, &h);
        assert_eq!(deepseek(&again).1, DEFAULT_ASSUMPTION);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn a_choice_the_provider_does_not_offer_is_rejected() {
        let h = home("reject");
        assert!(save_choice(&h, "deepseek-official", Some("EUR")).is_err());
        assert!(save_choice(&h, "no-such-provider", Some("USD")).is_err());
        assert!(save_choice(&h, "shengsuanyun", Some("USD")).is_err(), "a single-quote provider has nothing to choose");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn a_stale_saved_choice_falls_back_instead_of_breaking() {
        let h = home("stale");
        write_atomic(&state_path(&h, CHOICE_FILE), &json!({ "choices": { "deepseek-official": "EUR", "gone": "USD" } })).unwrap();
        save_locale_hint(&h, "en-US").unwrap();
        let mut main = agent_vitals_domain::cost::load_pricing();
        apply(&mut main, &h);
        assert_eq!(deepseek(&main).1, DEFAULT_ASSUMPTION, "an unavailable saved choice is ignored");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn the_user_s_own_cards_pin_the_base_quote() {
        let h = home("pinned");
        save_locale_hint(&h, "en-US").unwrap();
        crate::pricing::price_overrides::save_card_checked(&h, "deepseek-official", "my-model", &json!({
            "input_uncached": {"off_peak": 1.0, "peak": 1.0}, "input_cached": {"off_peak": 0.1, "peak": 0.1}, "output": {"off_peak": 2.0, "peak": 2.0}
        }), "CNY").unwrap();
        let main = crate::pricing::price_overrides::merged_main(&h);
        assert_eq!(main["providers"]["deepseek-official"]["currency"], "CNY");
        assert_eq!(main["providers"]["deepseek-official"]["quote_selection"]["source"], PINNED_BY_USER_CARDS);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn a_user_card_in_the_other_currency_pins_the_provider_there_and_no_mixing() {
        let h = home("pin-usd");
        save_locale_hint(&h, "zh-Hans-CN").unwrap(); // 默认假设本来是 CNY
        let card = json!({ "input_uncached": {"off_peak": 0.2, "peak": 0.2}, "input_cached": {"off_peak": 0.01, "peak": 0.01}, "output": {"off_peak": 0.8, "peak": 0.8} });
        let p = crate::pricing::price_overrides::save_card_checked;
        assert!(p(&h, "deepseek-official", "x-model", &card, "EUR").is_err(), "not an offered currency");
        p(&h, "deepseek-official", "x-model", &card, "USD").unwrap();
        assert!(p(&h, "deepseek-official", "y-model", &card, "CNY").is_err(), "no mixing under one provider once pinned");
        assert!(p(&h, "deepseek-official", "y-model", &card, "USD").is_ok());
        let main = crate::pricing::price_overrides::merged_main(&h);
        let entry = &main["providers"]["deepseek-official"];
        assert_eq!(entry["currency"], "USD");
        assert_eq!(entry["quote_selection"]["source"], PINNED_BY_USER_CARDS);
        assert_eq!(entry["models"]["deepseek-v4-pro"]["output"]["off_peak"], 1.98, "official USD quote underneath the user's USD cards");
        assert!(entry["models"]["x-model"].is_object());
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn apply_is_idempotent() {
        let h = home("idem");
        save_locale_hint(&h, "en-US").unwrap();
        let mut main = agent_vitals_domain::cost::load_pricing();
        apply(&mut main, &h);
        let once = main.clone();
        apply(&mut main, &h);
        assert_eq!(main, once);
        let _ = std::fs::remove_dir_all(&h);
    }
}
