//! 公共价格目录的边界校验。
//!
//! 目录是公共输入，不应直接当作计价配置使用。这个模块只做无副作用的
//! 解析、规范化和校验；下载、状态展示和落库由桌面适配层负责。

use agent_vitals_domain::source_identity::{canonical_json, fnv1a64_hex};
use serde_json::Value;
use std::collections::HashSet;

const MAX_CATALOG_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedCatalog {
    pub canonical_json: String,
    pub version: String,
    pub model_count: usize,
}

/// 规范化并校验公共目录。
///
/// 允许当前内置价卡的两种形状：顶层 `providers`，以及历史 Claude 目录中
/// 的 `catalog_2026_09.providers`。价格值必须是有限非负数；`tiers` 的
/// `max_input_tokens` 可以为 null。来源链接若存在必须是 HTTPS，避免把
/// 未验证的本地/明文地址写成公共来源。
pub fn validate(raw: &[u8]) -> Result<ValidatedCatalog, String> {
    if raw.len() > MAX_CATALOG_BYTES {
        return Err(format!("catalog exceeds {} byte limit", MAX_CATALOG_BYTES));
    }
    let value: Value = serde_json::from_slice(raw).map_err(|e| format!("invalid JSON: {e}"))?;
    reject_duplicate_keys(raw)?;
    let root = value
        .as_object()
        .ok_or_else(|| "catalog root must be an object".to_string())?;

    validate_non_negative(&value, "root")?;
    validate_sources(root)?;

    let mut model_count = 0;
    let mut found_provider_models = false;
    if let Some(providers) = root.get("providers") {
        model_count += validate_providers(providers, "providers")?;
        found_provider_models = true;
    }
    if let Some(catalog) = root.get("catalog_2026_09") {
        if let Some(providers) = catalog.get("providers") {
            model_count += validate_providers(providers, "catalog_2026_09.providers")?;
            found_provider_models = true;
        }
    }
    if !found_provider_models || model_count == 0 {
        return Err("catalog must contain at least one provider model".to_string());
    }

    let mut canonical = String::new();
    canonical_json(&value, &mut canonical);
    let version = format!("public-{}", fnv1a64_hex(canonical.as_bytes()));
    Ok(ValidatedCatalog {
        canonical_json: canonical,
        version,
        model_count,
    })
}

/// 每日同步叠加层的 schema 标识（`scripts/pricing_sync.py` 的 `SCHEMA`）。
pub const SYNC_OVERLAY_SCHEMA: &str = "agent-vitals-pricing-sync/v1";

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedSyncOverlay {
    pub overlay: Value,
    pub canonical_json: String,
    /// `sync-<fnv>`：内容指纹，同一份叠加层重复拉取得到同一个版本（幂等）。
    pub version: String,
    pub card_count: usize,
}

/// 校验每日同步叠加层（`assets/pricing-sync.json`）。与 [`validate`] 同样把公共
/// 输入当不可信数据：大小、重复键、非负价格都查。叠加层可以一张卡都没有
/// （三源与底表完全一致的那天），这不是错误——但 schema 标识必须对得上，
/// 防止把完整目录或别的 JSON 误当叠加层合并进去。
pub fn validate_sync_overlay(raw: &[u8]) -> Result<ValidatedSyncOverlay, String> {
    if raw.len() > MAX_CATALOG_BYTES {
        return Err(format!("sync overlay exceeds {} byte limit", MAX_CATALOG_BYTES));
    }
    let value: Value = serde_json::from_slice(raw).map_err(|e| format!("invalid JSON: {e}"))?;
    reject_duplicate_keys(raw)?;
    let root = value
        .as_object()
        .ok_or_else(|| "sync overlay root must be an object".to_string())?;
    if root.get("schema").and_then(Value::as_str) != Some(SYNC_OVERLAY_SCHEMA) {
        return Err(format!("sync overlay schema must be {SYNC_OVERLAY_SCHEMA}"));
    }
    validate_non_negative(&value, "root")?;
    if let Some(sources) = root.get("sources") {
        let sources = sources.as_object().ok_or_else(|| "sources must be an object".to_string())?;
        for (name, url) in sources {
            if !url.as_str().is_some_and(|u| u.starts_with("https://")) {
                return Err(format!("source {name} is not HTTPS"));
            }
        }
    }
    let mut card_count = 0;
    if let Some(catalog) = root.get("catalog") {
        card_count += validate_providers(catalog, "catalog")?;
    }
    if let Some(entries) = root.get("codex_entries") {
        let entries = entries
            .as_array()
            .ok_or_else(|| "codex_entries must be an array".to_string())?;
        for (index, entry) in entries.iter().enumerate() {
            validate_codex_entry(entry, &format!("codex_entries[{index}]"))?;
            card_count += 1;
        }
    }
    let mut canonical = String::new();
    canonical_json(&value, &mut canonical);
    let version = format!("sync-{}", fnv1a64_hex(canonical.as_bytes()));
    Ok(ValidatedSyncOverlay { overlay: value, canonical_json: canonical, version, card_count })
}

/// codex 价表条目：价格是字符串形式的非负小数（与 `assets/codex_pricing.json` 同形）。
fn validate_codex_entry(entry: &Value, path: &str) -> Result<(), String> {
    let entry = entry.as_object().ok_or_else(|| format!("{path} must be an object"))?;
    let prefix = entry.get("modelPrefix").and_then(Value::as_str).unwrap_or("");
    if prefix.trim().is_empty() {
        return Err(format!("{path}.modelPrefix is required"));
    }
    if entry.get("speed").and_then(Value::as_str).map_or(true, str::is_empty) {
        return Err(format!("{path}.speed is required"));
    }
    for required in ["uncachedInputUsdPerMTok", "outputUsdPerMTok"] {
        if !entry.contains_key(required) {
            return Err(format!("{path}.{required} is required"));
        }
    }
    for (key, value) in entry {
        if !key.ends_with("UsdPerMTok") {
            continue;
        }
        let ok = value
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .is_some_and(|v| v.is_finite() && v >= 0.0);
        if !ok {
            return Err(format!("{path}.{key} must be a non-negative decimal string"));
        }
    }
    Ok(())
}

fn reject_duplicate_keys(raw: &[u8]) -> Result<(), String> {
    let mut scanner = JsonKeyScanner { raw, pos: 0 };
    scanner.parse_value("root")?;
    scanner.skip_whitespace();
    if scanner.pos != raw.len() {
        return Err("catalog contains trailing JSON data".to_string());
    }
    Ok(())
}

struct JsonKeyScanner<'a> {
    raw: &'a [u8],
    pos: usize,
}

impl<'a> JsonKeyScanner<'a> {
    fn skip_whitespace(&mut self) {
        while self.pos < self.raw.len() && self.raw[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn parse_value(&mut self, path: &str) -> Result<(), String> {
        self.skip_whitespace();
        match self.raw.get(self.pos).copied() {
            Some(b'{') => self.parse_object(path),
            Some(b'[') => self.parse_array(path),
            Some(b'"') => {
                self.parse_string()?;
                Ok(())
            }
            Some(_) => {
                while self.pos < self.raw.len()
                    && !matches!(self.raw[self.pos], b',' | b']' | b'}')
                    && !self.raw[self.pos].is_ascii_whitespace()
                {
                    self.pos += 1;
                }
                Ok(())
            }
            None => Err(format!("catalog ended while reading {path}")),
        }
    }

    fn parse_object(&mut self, path: &str) -> Result<(), String> {
        self.pos += 1; // {
        let mut keys = HashSet::new();
        self.skip_whitespace();
        if self.raw.get(self.pos) == Some(&b'}') {
            self.pos += 1;
            return Ok(());
        }
        loop {
            self.skip_whitespace();
            let key = self.parse_string()?;
            if !keys.insert(key.clone()) {
                return Err(format!("duplicate catalog key at {path}.{key}"));
            }
            self.skip_whitespace();
            if self.raw.get(self.pos) != Some(&b':') {
                return Err(format!("catalog object key {path}.{key} is missing ':'"));
            }
            self.pos += 1;
            self.parse_value(&format!("{path}.{key}"))?;
            self.skip_whitespace();
            match self.raw.get(self.pos) {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(());
                }
                _ => return Err(format!("catalog object {path} is missing ',' or '}}'")),
            }
        }
    }

    fn parse_array(&mut self, path: &str) -> Result<(), String> {
        self.pos += 1; // [
        self.skip_whitespace();
        if self.raw.get(self.pos) == Some(&b']') {
            self.pos += 1;
            return Ok(());
        }
        let mut index = 0;
        loop {
            self.parse_value(&format!("{path}[{index}]"))?;
            index += 1;
            self.skip_whitespace();
            match self.raw.get(self.pos) {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    return Ok(());
                }
                _ => return Err(format!("catalog array {path} is missing ',' or ']'")),
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        let start = self.pos;
        if self.raw.get(self.pos) != Some(&b'"') {
            return Err(format!("catalog key at byte {} is not a string", self.pos));
        }
        self.pos += 1;
        let mut escaped = false;
        while self.pos < self.raw.len() {
            let byte = self.raw[self.pos];
            self.pos += 1;
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                return serde_json::from_slice(&self.raw[start..self.pos])
                    .map_err(|e| format!("invalid catalog string: {e}"));
            }
        }
        Err("catalog string is unterminated".to_string())
    }
}

fn validate_providers(value: &Value, path: &str) -> Result<usize, String> {
    let providers = value
        .as_object()
        .ok_or_else(|| format!("{path} must be an object"))?;
    let mut count = 0;
    for (provider_id, provider) in providers {
        if provider_id.trim().is_empty() {
            return Err(format!("{path} contains an empty provider id"));
        }
        let object = provider
            .as_object()
            .ok_or_else(|| format!("{path}.{provider_id} must be an object"))?;
        if let Some(currency) = object.get("currency") {
            let currency = currency
                .as_str()
                .ok_or_else(|| format!("{path}.{provider_id}.currency must be text"))?;
            if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_uppercase()) {
                return Err(format!("{path}.{provider_id}.currency is not ISO-like uppercase currency"));
            }
        }
        let models = object
            .get("models")
            .ok_or_else(|| format!("{path}.{provider_id}.models is missing"))?
            .as_object()
            .ok_or_else(|| format!("{path}.{provider_id}.models must be an object"))?;
        for (model_id, model) in models {
            if model_id.trim().is_empty() {
                return Err(format!("{path}.{provider_id} contains an empty model id"));
            }
            let model = model
                .as_object()
                .ok_or_else(|| format!("{path}.{provider_id}.models.{model_id} must be an object"))?;
            let has_dimension = ["input_uncached", "input_cached", "output", "tiers"]
                .iter()
                .any(|key| model.contains_key(*key));
            if !has_dimension {
                return Err(format!("{path}.{provider_id}.models.{model_id} has no billing dimension"));
            }
            for dimension in ["input_uncached", "input_cached", "output"] {
                if let Some(value) = model.get(dimension) {
                    validate_rate(value, &format!("{path}.{provider_id}.models.{model_id}.{dimension}"))?;
                }
            }
            if let Some(tiers) = model.get("tiers") {
                let tiers = tiers
                    .as_array()
                    .ok_or_else(|| format!("{path}.{provider_id}.models.{model_id}.tiers must be an array"))?;
                if tiers.is_empty() {
                    return Err(format!("{path}.{provider_id}.models.{model_id}.tiers must not be empty"));
                }
                for tier in tiers {
                    let tier = tier.as_object().ok_or_else(|| {
                        format!("{path}.{provider_id}.models.{model_id}.tiers item must be an object")
                    })?;
                    if !tier.keys().any(|key| {
                        matches!(key.as_str(), "input_uncached" | "input_cached" | "output")
                    }) {
                        return Err(format!("{path}.{provider_id}.models.{model_id}.tier has no billing dimension"));
                    }
                    for dimension in ["input_uncached", "input_cached", "output"] {
                        if let Some(value) = tier.get(dimension) {
                            validate_rate(
                                value,
                                &format!("{path}.{provider_id}.models.{model_id}.tiers.{dimension}"),
                            )?;
                        }
                    }
                    if let Some(max_input_tokens) = tier.get("max_input_tokens") {
                        if !max_input_tokens.is_null()
                            && (!max_input_tokens.is_u64() || max_input_tokens.as_u64() == Some(0))
                        {
                            return Err(format!(
                                "{path}.{provider_id}.models.{model_id}.tiers.max_input_tokens must be a positive integer or null"
                            ));
                        }
                    }
                }
            }
            count += 1;
        }
    }
    Ok(count)
}

fn validate_rate(value: &Value, path: &str) -> Result<(), String> {
    match value {
        Value::Number(number) if number.as_f64().is_some_and(|number| number >= 0.0) => Ok(()),
        Value::Object(values) if !values.is_empty() => {
            for (key, value) in values {
                if !value.is_number()
                    || value.as_f64().map_or(true, |number| number < 0.0)
                {
                    return Err(format!("{path}.{key} must be a finite non-negative number"));
                }
            }
            Ok(())
        }
        _ => Err(format!("{path} must be a finite non-negative number or rate object")),
    }
}

fn validate_sources(root: &serde_json::Map<String, Value>) -> Result<(), String> {
    let Some(catalog) = root.get("catalog_2026_09") else { return Ok(()); };
    let Some(sources) = catalog.get("sources") else { return Ok(()); };
    let sources = sources
        .as_object()
        .ok_or_else(|| "catalog_2026_09.sources must be an object".to_string())?;
    for (name, source) in sources {
        let source = source
            .as_str()
            .ok_or_else(|| format!("source {name} must be text"))?;
        for link in source.split(';') {
            let link = link.trim();
            if !link.is_empty() && !link.starts_with("https://") {
                return Err(format!("source {name} is not HTTPS"));
            }
        }
    }
    Ok(())
}

fn validate_non_negative(value: &Value, path: &str) -> Result<(), String> {
    match value {
        Value::Number(number) => {
            if number.as_f64().is_some_and(|number| number < 0.0) {
                return Err(format!("negative numeric value at {path}"));
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                validate_non_negative(item, &format!("{path}[{index}]"))?;
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                validate_non_negative(item, &format!("{path}.{key}"))?;
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> &'static [u8] {
        br#"{"providers":{"p":{"currency":"USD","models":{"m":{"input_uncached":1.2,"output":3}}}}}"#
    }

    #[test]
    fn normalizes_and_fingerprints_catalog() {
        let result = validate(good()).unwrap();
        assert_eq!(result.model_count, 1);
        assert!(result.version.starts_with("public-"));
        assert_eq!(result.canonical_json, "{\"providers\":{\"p\":{\"currency\":\"USD\",\"models\":{\"m\":{\"input_uncached\":1.2,\"output\":3}}}}}");
    }

    #[test]
    fn rejects_negative_and_bad_source() {
        assert!(validate(br#"{"providers":{"p":{"models":{"m":{"output":-1}}}}}"#).is_err());
        assert!(validate(br#"{"catalog_2026_09":{"sources":{"p":"http://bad"},"providers":{"p":{"models":{"m":{"output":1}}}}}}"#).is_err());
    }

    #[test]
    fn rejects_missing_dimension_and_empty_tiers() {
        assert!(validate(br#"{"providers":{"p":{"models":{"m":{}}}}}"#).is_err());
        assert!(validate(br#"{"providers":{"p":{"models":{"m":{"tiers":[]}}}}}"#).is_err());
    }

    #[test]
    fn rejects_malformed_rates_and_tier_limits() {
        assert!(validate(br#"{"providers":{"p":{"models":{"m":{"output":null}}}}}"#).is_err());
        assert!(validate(br#"{"providers":{"p":{"models":{"m":{"output":{"peak":"unknown"}}}}}}"#).is_err());
        assert!(validate(br#"{"providers":{"p":{"models":{"m":{"tiers":[{"output":1,"max_input_tokens":"512k"}]}}}}}"#).is_err());
        assert!(validate(br#"{"providers":{"p":{"models":{"m":{"tiers":[{"output":1,"max_input_tokens":0}]}}}}}"#).is_err());
    }

    #[test]
    fn rejects_duplicate_object_keys_including_escaped_keys() {
        assert!(validate(br#"{"providers":{"p":{"models":{"m":{"output":1,"output":2}}}}}"#).is_err());
        assert!(validate(br#"{"providers":{"p":{"models":{"m":{"output":1,"\u006futput":2}}}}}"#).is_err());
    }

    #[test]
    fn embedded_catalog_is_a_valid_update_candidate() {
        let result = validate(include_bytes!("../../../../assets/pricing.json")).unwrap();
        assert!(result.model_count >= 5);
        assert!(result.version.starts_with("public-"));
    }

    /// CI（.github/workflows/pricing-sync.yml）提交前跑这条：每日同步能发布的
    /// 文件，app 一定收得下。否则用户每天拉到的都是被拒收的叠加层，等于没同步。
    #[test]
    fn committed_sync_overlay_is_accepted_by_the_app() {
        let result = validate_sync_overlay(include_bytes!("../../../../assets/pricing-sync.json")).unwrap();
        assert!(result.version.starts_with("sync-"));
        let again = validate_sync_overlay(include_bytes!("../../../../assets/pricing-sync.json")).unwrap();
        assert_eq!(result.version, again.version, "同一份叠加层版本必须稳定（幂等写入依赖它）");
    }

    #[test]
    fn sync_overlay_requires_its_schema_marker() {
        // 完整目录不能被当成叠加层合并进来
        assert!(validate_sync_overlay(include_bytes!("../../../../assets/pricing.json")).is_err());
        assert!(validate_sync_overlay(br#"{"schema":"agent-vitals-pricing-sync/v1"}"#).is_ok());
    }

    #[test]
    fn sync_overlay_rejects_bad_codex_entries() {
        let ok = br#"{"schema":"agent-vitals-pricing-sync/v1","codex_entries":[{"modelPrefix":"gpt-6-luna","speed":"standard","uncachedInputUsdPerMTok":"0.1","outputUsdPerMTok":"0.5"}]}"#;
        assert_eq!(validate_sync_overlay(ok).unwrap().card_count, 1);
        for bad in [
            br#"{"schema":"agent-vitals-pricing-sync/v1","codex_entries":[{"modelPrefix":"","speed":"standard","uncachedInputUsdPerMTok":"1","outputUsdPerMTok":"1"}]}"#.as_slice(),
            br#"{"schema":"agent-vitals-pricing-sync/v1","codex_entries":[{"modelPrefix":"m","speed":"standard","uncachedInputUsdPerMTok":"-1","outputUsdPerMTok":"1"}]}"#.as_slice(),
            br#"{"schema":"agent-vitals-pricing-sync/v1","codex_entries":[{"modelPrefix":"m","speed":"standard","uncachedInputUsdPerMTok":"abc","outputUsdPerMTok":"1"}]}"#.as_slice(),
            br#"{"schema":"agent-vitals-pricing-sync/v1","codex_entries":[{"modelPrefix":"m","speed":"standard","uncachedInputUsdPerMTok":"1"}]}"#.as_slice(),
            br#"{"schema":"agent-vitals-pricing-sync/v1","sources":{"x":"http://insecure"}}"#.as_slice(),
        ] {
            assert!(validate_sync_overlay(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
    }
}
