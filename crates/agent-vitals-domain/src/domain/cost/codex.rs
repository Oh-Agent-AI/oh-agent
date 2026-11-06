//! Codex 公允价卡计算。
//!
//! 该模块只处理执行环境无关的价格卡匹配与 token bucket 公式；session wire
//! 解析仍由 `agent-vitals-harnesses` 负责，runtime 仅保留历史 CLI 兼容包装。

use serde_json::Value;

const CODEX_PRICING_JSON: &str = include_str!("../../../../../assets/codex_pricing.json");

pub fn load_codex_pricing() -> Value {
    serde_json::from_str(CODEX_PRICING_JSON).unwrap_or_else(|_| Value::Object(Default::default()))
}

/// `(model, speed)` → catalog entry，按最长 modelPrefix 匹配。
pub fn codex_resolve_entry<'a>(
    model: &str,
    speed: &str,
    entries: &'a [Value],
) -> Option<&'a Value> {
    let model = model.rsplit('/').next().unwrap_or(model);
    let mut best = None;
    let mut best_len = 0usize;
    for entry in entries {
        if entry.get("speed").and_then(Value::as_str) != Some(speed) {
            continue;
        }
        let prefix = entry
            .get("modelPrefix")
            .and_then(Value::as_str)
            .unwrap_or("");
        if prefix.len() > best_len && model.starts_with(prefix) {
            best_len = prefix.len();
            best = Some(entry);
        }
    }
    best
}

fn get_i64(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn rate(entry: &Value, key: &str) -> f64 {
    entry
        .get(key)
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn long_context_multipliers(bucket: &Value, entry: &Value) -> Option<(f64, f64)> {
    if entry
        .get("perRequestLongContextEvidence")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return None;
    }
    let threshold = entry
        .get("longContextThresholdTokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let priced = entry
        .get("longContextPriced")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let total = [
        "uncached_input_tokens",
        "cached_input_tokens",
        "cache_write_input_tokens",
    ]
    .iter()
    .map(|key| get_i64(bucket, key))
    .sum::<i64>();
    if threshold > 0 && total > threshold && priced {
        Some((
            entry
                .get("longContextInputMultiplierBps")
                .and_then(Value::as_i64)
                .unwrap_or(20_000) as f64
                / 10_000.0,
            entry
                .get("longContextOutputMultiplierBps")
                .and_then(Value::as_i64)
                .unwrap_or(15_000) as f64
                / 10_000.0,
        ))
    } else {
        None
    }
}

/// 5 桶 Codex 用量 × 价格卡 → USD；reasoning 已包含在 output 中。
pub fn codex_price_bucket(
    bucket: &Value,
    entry: &Value,
    explicit_long_context: Option<(f64, f64)>,
) -> f64 {
    let uncached = get_i64(bucket, "uncached_input_tokens") as f64;
    let cached = get_i64(bucket, "cached_input_tokens") as f64;
    let cache_write = get_i64(bucket, "cache_write_input_tokens") as f64;
    let output = get_i64(bucket, "output_tokens") as f64;
    let mut input = uncached * rate(entry, "uncachedInputUsdPerMTok")
        + cached * rate(entry, "cacheReadUsdPerMTok")
        + cache_write * rate(entry, "cacheWrite5mUsdPerMTok");
    let mut output_cost = output * rate(entry, "outputUsdPerMTok");
    if let Some((input_multiplier, output_multiplier)) =
        explicit_long_context.or_else(|| long_context_multipliers(bucket, entry))
    {
        input *= input_multiplier;
        output_cost *= output_multiplier;
    }
    (input + output_cost) / 1e6
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_longest_model_prefix_and_strips_route_prefix() {
        let pricing = load_codex_pricing();
        let entries = pricing["entries"].as_array();
        if let Some(entries) = entries {
            assert!(codex_resolve_entry("openai/gpt-5.6-sol", "standard", entries).is_some());
        }
    }

    #[test]
    fn prices_all_four_token_buckets() {
        let entry = json!({
            "uncachedInputUsdPerMTok": "1",
            "cacheReadUsdPerMTok": "0.1",
            "cacheWrite5mUsdPerMTok": "2",
            "outputUsdPerMTok": "3"
        });
        let bucket = json!({
            "uncached_input_tokens": 1_000_000,
            "cached_input_tokens": 1_000_000,
            "cache_write_input_tokens": 1_000_000,
            "output_tokens": 1_000_000
        });
        assert!((codex_price_bucket(&bucket, &entry, None) - 6.1).abs() < 1e-9);
    }
}
