//! 每日同步价卡叠加层（`assets/pricing-sync.json`，由 `scripts/pricing_sync.py`
//! 生成）与内置底表的合并规则。纯函数，只碰 `serde_json::Value`。
//!
//! 两种合并，语义不同，不能共用一个开关：
//!
//! - [`merge_sync_overlay`]：拉到新叠加层时生成**新快照**用。叠加层的卡**覆盖**
//!   底表同名卡——这就是改价（2026-09-29：Sonnet 5 底表按过期公告写成 $3/$15，
//!   三源一致为 $2/$10）。新快照只对它之后的用量生效，历史仍按旧快照计价，
//!   厂商调价不会改写历史金额。
//! - [`fill_missing_from_sync_overlay`]：读**历史快照**时用。只补当时根本没有的卡
//!   （新模型发布当天到价卡上线之间的用量），**已有的卡一个都不动**——用户
//!   2026-09-29 定的「缺卡的回补，已有价的不动」。
//!
//! 叠加层形状：`{catalog: {provider: {currency, models: {id: card}}}, codex_entries: [entry]}`；
//! 底表形状：`pricing.catalog_2026_09.providers.<p>.models.<id>` 与 `codex_pricing.entries[]`。

use serde_json::{Map, Value};

/// 覆盖式合并（生成新快照）。币种与底表不一致的服务商整段跳过：同一服务商
/// 美元卡与人民币卡混放会直接算错钱，宁可不叠加。
/// 历史快照里**缺币种标签**的顶层服务商，按同一服务商 id 用内置价卡写明的报价币种补上。
///
/// 为什么需要：2026-09-14 及更早的快照里 `providers.deepseek-official` 没有 `currency`
/// （当时的规则是「顶层段默认 CNY」，后来改成显式币种、缺币种的卡不得猜价）。规则收紧后，
/// 用量查询一落到那些快照，DeepSeek 整体被判 `no-price-card`——真机 9 月约 19 亿 token 全部未计价，
/// 而价格数字本身就是那份人民币表，只是缺了标签。
///
/// 边界（不是「猜币种」）：只补**缺失**的标签，已有的不改；只按**同一服务商 id** 取内置价卡的显式
/// `currency`，内置里没有该服务商或它也没写币种 → 保持缺失（仍然不得计价）。不借别家的卡、不按国籍推断，
/// 也不动任何价格数字。
pub fn backfill_provider_currency(snapshot: &mut Value, embedded: &Value) {
    let Some(providers) = snapshot.get_mut("providers").and_then(Value::as_object_mut) else { return };
    for (id, entry) in providers.iter_mut() {
        let Some(map) = entry.as_object_mut() else { continue };
        if map.get("currency").and_then(Value::as_str).is_some_and(|c| !c.is_empty()) { continue; }
        let Some(currency) = embedded.pointer(&format!("/providers/{id}/currency")).and_then(Value::as_str) else { continue };
        map.insert("currency".to_string(), Value::String(currency.to_string()));
    }
}

pub fn merge_sync_overlay(pricing: &mut Value, codex: &mut Value, overlay: &Value) {
    apply(pricing, codex, overlay, true);
}

/// 只补缺卡（读历史快照）。已存在的模型卡 / codex 条目保持快照当时的价格。
pub fn fill_missing_from_sync_overlay(pricing: &mut Value, codex: &mut Value, overlay: &Value) {
    apply(pricing, codex, overlay, false);
}

/// [`fill_missing_from_sync_overlay`] 的完整快照版本：`pricing_snapshots.payload_json`
/// 形如 `{pricing, codex_pricing}`。老快照只存了其中一半（或根本不是这个形状）
/// 时原样不动——半边回补会让同一时点两个执行环境用上不同来源的价卡。
pub fn fill_missing_in_snapshot(snapshot: &mut Value, overlay: &Value) {
    let Some(obj) = snapshot.as_object_mut() else { return };
    if !(obj.contains_key("pricing") && obj.contains_key("codex_pricing")) {
        return;
    }
    let mut pricing = obj.remove("pricing").unwrap_or(Value::Null);
    let mut codex = obj.remove("codex_pricing").unwrap_or(Value::Null);
    fill_missing_from_sync_overlay(&mut pricing, &mut codex, overlay);
    obj.insert("pricing".into(), pricing);
    obj.insert("codex_pricing".into(), codex);
}

fn apply(pricing: &mut Value, codex: &mut Value, overlay: &Value, replace: bool) {
    if let Some(catalog) = overlay.get("catalog").and_then(Value::as_object) {
        if let Some(providers) = catalog_providers_mut(pricing) {
            for (provider, block) in catalog {
                let Some(models) = block.get("models").and_then(Value::as_object) else { continue };
                let currency = block.get("currency").and_then(Value::as_str).unwrap_or("USD");
                let entry = providers.entry(provider.clone()).or_insert_with(|| {
                    let mut p = Map::new();
                    p.insert("currency".into(), Value::String(currency.to_string()));
                    p.insert("models".into(), Value::Object(Map::new()));
                    Value::Object(p)
                });
                let base_currency = entry.get("currency").and_then(Value::as_str).unwrap_or("CNY");
                if base_currency != currency {
                    continue;
                }
                let Some(target) = entry
                    .as_object_mut()
                    .map(|p| p.entry("models").or_insert_with(|| Value::Object(Map::new())))
                    .and_then(Value::as_object_mut)
                else {
                    continue;
                };
                for (model, card) in models {
                    if replace || !target.contains_key(model) {
                        target.insert(model.clone(), card.clone());
                    }
                }
            }
        }
    }
    if let Some(entries) = overlay.get("codex_entries").and_then(Value::as_array) {
        let Some(target) = codex
            .as_object_mut()
            .map(|c| c.entry("entries").or_insert_with(|| Value::Array(Vec::new())))
            .and_then(Value::as_array_mut)
        else {
            return;
        };
        for entry in entries {
            let key = codex_key(entry);
            match target.iter().position(|e| codex_key(e) == key) {
                Some(i) if replace => target[i] = entry.clone(),
                Some(_) => {}
                None => target.push(entry.clone()),
            }
        }
    }
}

fn catalog_providers_mut(pricing: &mut Value) -> Option<&mut Map<String, Value>> {
    pricing
        .as_object_mut()?
        .entry("catalog_2026_09")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()?
        .entry("providers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
}

fn codex_key(entry: &Value) -> (Option<&str>, Option<&str>) {
    (
        entry.get("modelPrefix").and_then(Value::as_str),
        entry.get("speed").and_then(Value::as_str),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_snapshot_provider_missing_its_currency_label_gets_the_embedded_one_and_nothing_else_changes() {
        use serde_json::json;
        let embedded = json!({ "providers": { "deepseek-official": { "currency": "CNY" }, "other": {}, "nocur": {} } });
        let mut snapshot = json!({ "providers": {
            "deepseek-official": { "models": { "m": { "output": 1.0 } } },
            "other": { "currency": "USD", "models": {} },
            "unknown-to-embedded": { "models": {} },
            "nocur": { "models": {} },
        }});
        let before = snapshot.clone();
        super::backfill_provider_currency(&mut snapshot, &embedded);
        assert_eq!(snapshot["providers"]["deepseek-official"]["currency"], "CNY");
        assert_eq!(snapshot["providers"]["deepseek-official"]["models"], before["providers"]["deepseek-official"]["models"], "prices untouched");
        assert_eq!(snapshot["providers"]["other"]["currency"], "USD", "an existing label is never changed");
        assert!(snapshot["providers"]["unknown-to-embedded"].get("currency").is_none(), "not in the embedded table => stays unlabeled (still not priced)");
        assert!(snapshot["providers"]["nocur"].get("currency").is_none(), "embedded has no explicit currency either => no guess");
    }

    use super::*;
    use serde_json::json;

    fn base() -> (Value, Value) {
        (
            json!({"catalog_2026_09": {"providers": {
                "anthropic": {"currency": "USD", "models": {
                    "claude-sonnet-5": {"input_uncached": 3.0, "input_cached": 0.3, "output": 15.0}}},
                "minimax": {"currency": "CNY", "models": {"MiniMax-M3": {"output": 8.4}}}
            }}}),
            json!({"currency": "USD", "entries": [
                {"modelPrefix": "gpt-5.2", "speed": "standard", "uncachedInputUsdPerMTok": "1.25", "outputUsdPerMTok": "10"}]}),
        )
    }

    fn overlay() -> Value {
        json!({
            "catalog": {
                "anthropic": {"currency": "USD", "models": {
                    "claude-sonnet-5": {"input_uncached": 2.0, "input_cached": 0.2, "output": 10.0},
                    "claude-opus-5-5": {"input_uncached": 4.0, "input_cached": 0.2, "output": 20.0}}},
                "minimax": {"currency": "USD", "models": {"MiniMax-M3": {"output": 1.2}}},
                "zai": {"currency": "USD", "models": {"glm-5.3": {"input_uncached": 1.4, "output": 4.4}}}
            },
            "codex_entries": [
                {"modelPrefix": "gpt-5.2", "speed": "standard", "uncachedInputUsdPerMTok": "1.75", "outputUsdPerMTok": "14"},
                {"modelPrefix": "gpt-6-luna", "speed": "standard", "uncachedInputUsdPerMTok": "0.1", "outputUsdPerMTok": "0.5"}
            ]
        })
    }

    #[test]
    fn merge_overrides_existing_cards_and_adds_new_ones() {
        let (mut p, mut c) = base();
        merge_sync_overlay(&mut p, &mut c, &overlay());
        let a = &p["catalog_2026_09"]["providers"]["anthropic"]["models"];
        assert_eq!(a["claude-sonnet-5"]["output"], json!(10.0), "改价要覆盖底表");
        assert_eq!(a["claude-opus-5-5"]["output"], json!(20.0));
        assert_eq!(p["catalog_2026_09"]["providers"]["zai"]["currency"], json!("USD"), "新服务商带上币种");
        let e = c["entries"].as_array().unwrap();
        assert_eq!(e.len(), 2);
        assert_eq!(e[0]["uncachedInputUsdPerMTok"], json!("1.75"));
    }

    #[test]
    fn fill_missing_never_touches_existing_cards() {
        // 历史快照里 Sonnet 5 当时是 $3/$15：回补不改写它，只补 Opus 5.5 与 gpt-6。
        let (mut p, mut c) = base();
        fill_missing_from_sync_overlay(&mut p, &mut c, &overlay());
        let a = &p["catalog_2026_09"]["providers"]["anthropic"]["models"];
        assert_eq!(a["claude-sonnet-5"]["output"], json!(15.0));
        assert_eq!(a["claude-opus-5-5"]["output"], json!(20.0));
        let e = c["entries"].as_array().unwrap();
        assert_eq!(e[0]["uncachedInputUsdPerMTok"], json!("1.25"));
        assert_eq!(e[1]["modelPrefix"], json!("gpt-6-luna"));
    }

    #[test]
    fn currency_mismatch_skips_the_whole_provider() {
        // 底表 MiniMax 是人民币卡：美元叠加层不能混进来，否则同一服务商两种币种
        let (mut p, mut c) = base();
        merge_sync_overlay(&mut p, &mut c, &overlay());
        assert_eq!(p["catalog_2026_09"]["providers"]["minimax"]["models"]["MiniMax-M3"]["output"], json!(8.4));
    }

    #[test]
    fn snapshot_fill_handles_full_shape_and_leaves_half_snapshots_alone() {
        let (p, c) = base();
        let mut full = json!({"pricing": p.clone(), "codex_pricing": c.clone()});
        fill_missing_in_snapshot(&mut full, &overlay());
        assert_eq!(full["pricing"]["catalog_2026_09"]["providers"]["anthropic"]["models"]["claude-sonnet-5"]["output"], json!(15.0));
        assert!(full["pricing"]["catalog_2026_09"]["providers"]["anthropic"]["models"]["claude-opus-5-5"].is_object());
        let mut half = json!({"pricing": p});
        let before = half.clone();
        fill_missing_in_snapshot(&mut half, &overlay());
        assert_eq!(half, before);
    }

    #[test]
    fn empty_or_malformed_overlay_is_a_no_op() {
        let (mut p, mut c) = base();
        let before = (p.clone(), c.clone());
        merge_sync_overlay(&mut p, &mut c, &json!({}));
        merge_sync_overlay(&mut p, &mut c, &json!({"catalog": [], "codex_entries": {}}));
        assert_eq!((p, c), before);
    }
}
