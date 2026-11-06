//! v0.12 billing catalog contracts.
//!
//! This module owns the vocabulary and immutable identity rules for billing
//! templates and pricing snapshots. It deliberately does not fetch prices or
//! decide whether a historical fact is covered by a subscription.

use super::source_identity::{canonical_json, fnv1a64_hex};
use serde_json::{json, Value};

/// The contract used to price a usage fact. A template name is not evidence
/// that the corresponding account actually covered a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BillingTemplateKind {
    MeteredApi,
    TokenPlan,
    OfficialSubscription,
    BalanceAccount,
    RelayMultiplier,
    Custom,
}

impl BillingTemplateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MeteredApi => "metered_api",
            Self::TokenPlan => "token_plan",
            Self::OfficialSubscription => "official_subscription",
            Self::BalanceAccount => "balance_account",
            Self::RelayMultiplier => "relay_multiplier",
            Self::Custom => "custom",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "metered_api" => Self::MeteredApi,
            "token_plan" => Self::TokenPlan,
            "official_subscription" => Self::OfficialSubscription,
            "balance_account" => Self::BalanceAccount,
            "relay_multiplier" => Self::RelayMultiplier,
            "custom" => Self::Custom,
            _ => return None,
        })
    }
}

/// Where a pricing policy came from. User-provided values remain estimates
/// unless an invoice or provider response confirms them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PricingSource {
    Official,
    ReviewedImport,
    UserConfigured,
    ProviderReported,
    Observed,
}

/// A billing contract attached to one provider/account scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BillingTemplate {
    pub provider_id: String,
    pub kind: BillingTemplateKind,
    pub pricing_source: PricingSource,
    pub account_id: Option<String>,
    pub effective_from_ms: i64,
    pub effective_to_ms: Option<i64>,
}

impl BillingTemplate {
    pub fn new(
        provider_id: &str,
        kind: BillingTemplateKind,
        pricing_source: PricingSource,
        account_id: Option<String>,
        effective_from_ms: i64,
        effective_to_ms: Option<i64>,
    ) -> Result<Self, &'static str> {
        if provider_id.trim().is_empty() {
            return Err("provider_id must not be empty");
        }
        if effective_to_ms.is_some_and(|end| end < effective_from_ms) {
            return Err("effective_to_ms must not precede effective_from_ms");
        }
        Ok(Self {
            provider_id: provider_id.to_string(),
            kind,
            pricing_source,
            account_id,
            effective_from_ms,
            effective_to_ms,
        })
    }
}

/// Per-million-token price policy. Integer minor units avoid floating point
/// drift; the pricing source remains part of the policy identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PricingPolicy {
    pub currency: String,
    pub input_minor_per_million: u64,
    pub cache_read_minor_per_million: u64,
    pub cache_write_minor_per_million: u64,
    pub output_minor_per_million: u64,
    pub source: PricingSource,
}

impl PricingPolicy {
    pub fn new(
        currency: &str,
        input_minor_per_million: u64,
        cache_read_minor_per_million: u64,
        cache_write_minor_per_million: u64,
        output_minor_per_million: u64,
        source: PricingSource,
    ) -> Result<Self, &'static str> {
        if currency.trim().is_empty() {
            return Err("currency must not be empty");
        }
        Ok(Self {
            currency: currency.to_string(),
            input_minor_per_million,
            cache_read_minor_per_million,
            cache_write_minor_per_million,
            output_minor_per_million,
            source,
        })
    }
}

impl PricingSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Official => "official",
            Self::ReviewedImport => "reviewed_import",
            Self::UserConfigured => "user_configured",
            Self::ProviderReported => "provider_reported",
            Self::Observed => "observed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "official" => Self::Official,
            "reviewed_import" => Self::ReviewedImport,
            "user_configured" => Self::UserConfigured,
            "provider_reported" => Self::ProviderReported,
            "observed" => Self::Observed,
            _ => return None,
        })
    }
}

/// A validated, canonical billing snapshot. The payload is retained as JSON
/// because the catalog is intentionally extensible, while its identity is
/// derived from canonical payload bytes and cannot be overwritten.
#[derive(Clone, Debug, PartialEq)]
pub struct BillingCatalogSnapshot {
    catalog_version: String,
    payload: Value,
    identity: String,
}

impl BillingCatalogSnapshot {
    pub fn new(catalog_version: &str, payload: Value) -> Result<Self, &'static str> {
        if catalog_version.trim().is_empty() {
            return Err("catalog_version must not be empty");
        }
        if !payload.is_object() {
            return Err("billing catalog payload must be an object");
        }
        let mut canonical = String::new();
        canonical_json(&payload, &mut canonical);
        let identity = format!("bc1-{}", fnv1a64_hex(canonical.as_bytes()));
        Ok(Self {
            catalog_version: catalog_version.to_string(),
            payload,
            identity,
        })
    }

    pub fn to_json(&self) -> Value {
        json!({
            "catalog_version": self.catalog_version,
            "snapshot_id": self.identity,
            "payload": self.payload,
        })
    }

    pub fn catalog_version(&self) -> &str {
        &self.catalog_version
    }

    pub fn payload(&self) -> &Value {
        &self.payload
    }

    pub fn identity(&self) -> &str {
        &self.identity
    }
}

/// Validate the small stable contract shared by catalog/template consumers.
/// Unknown values degrade to an error instead of silently becoming metered.
pub fn validate_billing_template(value: &Value) -> Result<(), &'static str> {
    let object = value.as_object().ok_or("billing template must be an object")?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("billing template kind is required")?;
    BillingTemplateKind::parse(kind).ok_or("unknown billing template kind")?;
    let source = object
        .get("pricing_source")
        .and_then(Value::as_str)
        .ok_or("billing template pricing_source is required")?;
    PricingSource::parse(source).ok_or("unknown pricing source")?;
    if object.get("provider_id").and_then(Value::as_str).is_none() {
        return Err("billing template provider_id is required");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_template_kinds_round_trip() {
        for kind in [
            BillingTemplateKind::MeteredApi,
            BillingTemplateKind::TokenPlan,
            BillingTemplateKind::OfficialSubscription,
            BillingTemplateKind::BalanceAccount,
            BillingTemplateKind::RelayMultiplier,
            BillingTemplateKind::Custom,
        ] {
            assert_eq!(BillingTemplateKind::parse(kind.as_str()), Some(kind));
        }
    }

    #[test]
    fn invalid_template_degrades_explicitly() {
        let value = json!({"kind": "subscription", "pricing_source": "official"});
        assert_eq!(validate_billing_template(&value), Err("unknown billing template kind"));
    }

    #[test]
    fn snapshot_identity_is_order_independent_and_payload_immutable() {
        let a = BillingCatalogSnapshot::new("2026-09-10", json!({"b": 2, "a": 1})).unwrap();
        let b = BillingCatalogSnapshot::new("2026-09-10", json!({"a": 1, "b": 2})).unwrap();
        assert_eq!(a.identity(), b.identity());
        assert_eq!(a.to_json()["snapshot_id"], a.identity());
        assert_ne!(a.identity(), BillingCatalogSnapshot::new("2026-09-10", json!({"a": 2})).unwrap().identity());
    }

    #[test]
    fn template_and_policy_reject_invalid_windows_and_currency() {
        assert!(BillingTemplate::new("openai", BillingTemplateKind::MeteredApi, PricingSource::Official, None, 10, Some(9)).is_err());
        assert!(PricingPolicy::new("", 1, 1, 1, 1, PricingSource::Official).is_err());
    }

    #[test]
    fn valid_template_accepts_every_source() {
        for source in ["official", "reviewed_import", "user_configured", "provider_reported", "observed"] {
            let value = json!({"kind": "metered_api", "pricing_source": source, "provider_id": "openai"});
            assert_eq!(validate_billing_template(&value), Ok(()));
        }
    }
}
