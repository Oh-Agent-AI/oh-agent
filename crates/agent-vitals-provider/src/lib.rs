//! Pure provider identity and attribution logic for v0.11.
//! This crate performs no I/O, SQL, network access, or harness-log parsing.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteEvidence {
    pub provider_raw: Option<String>,
    pub endpoint_host: Option<String>,
    pub evidence_basis: EvidenceBasis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvidenceBasis {
    SessionNative,
    AccountTimeBound,
    ConfigTimeBound,
    ConfigCurrent,
    EnvCurrent,
    Inferred,
    Missing,
    Conflict,
}

impl EvidenceBasis {
    pub fn strength(self) -> u8 {
        match self {
            Self::SessionNative => 7,
            Self::AccountTimeBound => 6,
            Self::ConfigTimeBound => 5,
            Self::ConfigCurrent | Self::EnvCurrent => 4,
            Self::Inferred => 2,
            Self::Missing => 0,
            Self::Conflict => 0,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionNative => "session-native",
            Self::AccountTimeBound => "account-time-bound",
            Self::ConfigTimeBound => "config-time-bound",
            Self::ConfigCurrent => "config-current",
            Self::EnvCurrent => "env-current",
            Self::Inferred => "inferred",
            Self::Missing => "missing",
            Self::Conflict => "conflict",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

/// 账户级证据的付费形态（自动归因规格 §2 L2）。跨执行环境抽象一致：Claude 的
/// `oauthAccount.organizationType`、Codex 的 `auth.json auth_mode`、WorkBuddy 的
/// 积分，都只落到这四个值之一。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlanKind {
    Subscription,
    ApiKey,
    Credits,
    Unknown,
}

impl PlanKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Subscription => "subscription",
            Self::ApiKey => "api_key",
            Self::Credits => "credits",
            Self::Unknown => "unknown",
        }
    }
}

/// 账户级证据——**只有这些字段**。执行环境读取器只允许把白名单里的账户属性映射到
/// 这里（套餐类型、付款渠道、账期锚点）；邮箱、账户/组织 UUID、令牌在类型上就
/// 没有位置，不可能被序列化进任何 DTO / 导出（规格 §7 P1）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountEvidence {
    pub harness: String,
    /// 该账户对应的模型厂商 / 计费方（anthropic、openai …）。
    pub vendor: String,
    pub plan_kind: PlanKind,
    /// 用户可读的套餐名（"Claude Pro" / "ChatGPT"），来自账户属性的固定映射。
    pub plan_label: Option<String>,
    /// 付款渠道（`apple_subscription` 等），只用于提示"月费可能与挂牌价不同"。
    pub billing_channel: Option<String>,
    /// 账期锚点 `YYYY-MM-DD`（订阅开始/首次扣款日；每月同一天续费）。
    pub anchor_date: Option<String>,
    pub evidence_basis: EvidenceBasis,
    /// 读了哪个文件的哪些键，供回执展示依据（不含值）。
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BillingAttribution {
    pub provider_id: Option<String>,
    pub provider_raw: Option<String>,
    pub billing_mode: BillingMode,
    pub pricing_basis: String,
    pub evidence_basis: EvidenceBasis,
    pub has_unresolved: bool,
}

/// Normalizes a raw provider marker or endpoint hostname to a stable provider id.
pub fn normalize_provider(
    provider_raw: Option<&str>,
    endpoint_host: Option<&str>,
) -> Option<String> {
    let endpoint = normalize_host(endpoint_host.unwrap_or_default());
    if is_cogfoundry_host(&endpoint) {
        return Some("cogfoundry.ai".to_string());
    }
    if is_openai_host(&endpoint) {
        return Some("openai".to_string());
    }
    match provider_raw
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("openai") => Some("openai".to_string()),
        Some(raw) => Some(raw.to_string()),
        None => None,
    }
}

/// Hostname matching is deliberately boundary-aware: a URL/hostname may carry a port,
/// trailing dot, or a subdomain, but an unrelated hostname containing the provider
/// name must never be classified as that provider.
fn normalize_host(raw: &str) -> String {
    let mut value = raw.trim().to_ascii_lowercase();
    if let Some((_, rest)) = value.split_once("://") {
        value = rest.to_string();
    }
    value = value.split('/').next().unwrap_or(&value).to_string();
    if let Some((host, port)) = value.rsplit_once(':') {
        if port.chars().all(|c| c.is_ascii_digit()) {
            value = host.to_string();
        }
    }
    value.trim_end_matches('.').to_string()
}

fn is_cogfoundry_host(host: &str) -> bool {
    host == "cogfoundry.ai" || host.ends_with(".cogfoundry.ai")
}

fn is_openai_host(host: &str) -> bool {
    host == "api.openai.com" || host.ends_with(".api.openai.com")
}

/// Resolves identity first, then applies v0.11's conservative billing semantics.
/// A current custom route is never treated as an official subscription.
pub fn resolve_billing_attribution(
    model_provider: Option<&str>,
    route: Option<&RouteEvidence>,
) -> BillingAttribution {
    let raw = model_provider.map(str::to_string);
    let route_provider = route
        .and_then(|r| normalize_provider(r.provider_raw.as_deref(), r.endpoint_host.as_deref()));
    let route_basis = route
        .map(|r| r.evidence_basis)
        .unwrap_or(EvidenceBasis::Missing);
    let provider_id = match model_provider.map(str::trim).filter(|v| !v.is_empty()) {
        Some("openai") => Some("openai".to_string()),
        Some("custom") | None => route_provider.clone(),
        Some(other) => Some(other.to_string()),
    };
    // The session's explicit provider wins over a current-config hint. A
    // stronger conflicting route evidence is unresolved instead of silently
    // being called subscription.
    // 执行环境没有自报 provider（Claude Code：`model_provider = None`，路由证据来自
    // 请求 ID 形状）时，会话级路由证据就是唯一真值，不与任何人冲突（自动归因
    // A4）。执行环境自报了 provider 的旧口径原样保留——DSH 自报 deepseek 也会落
    // 「冲突/metered_estimate」，那是 provider-v0.11 的既有语义，Python
    // `dsh_usage_fact.py` 与已入库事实都按它对齐；收紧要连同 attribution_version
    // 一起升版，不在这一步顺手改。
    let route_conflicts = matches!(route_basis, EvidenceBasis::Conflict)
        || (model_provider.is_some()
            && route_basis.strength() >= EvidenceBasis::SessionNative.strength()
            && route_provider.as_deref().is_some_and(|p| p != "openai"));
    let is_official_subscription = model_provider == Some("openai")
        && route.and_then(|r| r.endpoint_host.as_deref()).is_some()
        && route_provider.as_deref() == Some("openai")
        && matches!(route_basis, EvidenceBasis::SessionNative)
        && !route_conflicts;
    if is_official_subscription {
        return BillingAttribution {
            provider_id,
            provider_raw: raw,
            billing_mode: BillingMode::Subscription,
            pricing_basis: "session-provider".to_string(),
            evidence_basis: route_basis,
            has_unresolved: false,
        };
    }
    let official_route_missing = model_provider == Some("openai")
        && route.and_then(|r| r.endpoint_host.as_deref()).is_none();
    let unresolved = route_conflicts
        || official_route_missing
        || provider_id.is_none()
        || matches!(
            route_basis,
            EvidenceBasis::ConfigCurrent
                | EvidenceBasis::EnvCurrent
                | EvidenceBasis::Conflict
                | EvidenceBasis::Missing
        )
        || (model_provider == Some("custom"));
    BillingAttribution {
        provider_id,
        provider_raw: raw,
        // Missing/conflicting provider evidence is still a metered estimate;
        // Unknown is reserved for presentation of absent identity, not a free
        // or unpriced billing mode.
        billing_mode: BillingMode::Metered,
        pricing_basis: if unresolved {
            "metered_estimate"
        } else {
            "route-observed"
        }
        .to_string(),
        evidence_basis: route_basis,
        has_unresolved: unresolved,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cog(basis: EvidenceBasis) -> RouteEvidence {
        RouteEvidence {
            provider_raw: Some("custom".into()),
            endpoint_host: Some("router.cogfoundry.ai".into()),
            evidence_basis: basis,
        }
    }

    #[test]
    fn custom_cogfoundry_is_metered_estimate() {
        let a =
            resolve_billing_attribution(Some("custom"), Some(&cog(EvidenceBasis::ConfigCurrent)));
        assert_eq!(a.provider_id.as_deref(), Some("cogfoundry.ai"));
        assert_eq!(a.billing_mode, BillingMode::Metered);
        assert_eq!(a.pricing_basis, "metered_estimate");
        assert!(a.has_unresolved);
    }

    #[test]
    fn explicit_openai_wins_over_current_custom_hint() {
        let a =
            resolve_billing_attribution(Some("openai"), Some(&cog(EvidenceBasis::ConfigCurrent)));
        assert_eq!(a.provider_id.as_deref(), Some("openai"));
        assert_eq!(a.billing_mode, BillingMode::Metered);
        assert!(a.has_unresolved);
        assert_eq!(a.evidence_basis, EvidenceBasis::ConfigCurrent);
    }

    #[test]
    fn openai_marker_with_custom_session_endpoint_is_unresolved() {
        let route = RouteEvidence {
            provider_raw: None,
            endpoint_host: Some("router.cogfoundry.ai".into()),
            evidence_basis: EvidenceBasis::SessionNative,
        };
        let a = resolve_billing_attribution(Some("openai"), Some(&route));
        assert_eq!(a.billing_mode, BillingMode::Metered);
        assert_eq!(a.pricing_basis, "metered_estimate");
        assert!(a.has_unresolved);
    }

    #[test]
    fn provider_only_openai_route_is_not_subscription() {
        let route = RouteEvidence {
            provider_raw: Some("openai".into()),
            endpoint_host: None,
            evidence_basis: EvidenceBasis::SessionNative,
        };
        let a = resolve_billing_attribution(Some("openai"), Some(&route));
        assert_eq!(a.billing_mode, BillingMode::Metered);
        assert_eq!(a.pricing_basis, "metered_estimate");
        assert!(a.has_unresolved);
    }

    #[test]
    fn openai_without_route_is_unresolved_metered() {
        let a = resolve_billing_attribution(Some("openai"), None);
        assert_eq!(a.billing_mode, BillingMode::Metered);
        assert_eq!(a.pricing_basis, "metered_estimate");
        assert!(a.has_unresolved);
    }

    #[test]
    fn custom_without_route_is_unresolved_metered() {
        let a = resolve_billing_attribution(Some("custom"), None);
        assert_eq!(a.billing_mode, BillingMode::Metered);
        assert_eq!(a.pricing_basis, "metered_estimate");
        assert!(a.has_unresolved);
    }

    #[test]
    fn missing_provider_is_unresolved_metered_not_free() {
        let a = resolve_billing_attribution(None, None);
        assert_eq!(a.billing_mode, BillingMode::Metered);
        assert_eq!(a.pricing_basis, "metered_estimate");
        assert!(a.has_unresolved);
    }

    #[test]
    fn session_native_openai_is_subscription() {
        let a = resolve_billing_attribution(
            Some("openai"),
            Some(&RouteEvidence {
                provider_raw: Some("openai".into()),
                endpoint_host: Some("api.openai.com".into()),
                evidence_basis: EvidenceBasis::SessionNative,
            }),
        );
        assert_eq!(a.billing_mode, BillingMode::Subscription);
        assert!(!a.has_unresolved);
    }

    #[test]
    fn normalizes_provider_hosts_without_false_positive() {
        assert_eq!(
            normalize_provider(None, Some("https://beta-router.cogfoundry.ai:443/v1")),
            Some("cogfoundry.ai".to_string())
        );
        assert_eq!(
            normalize_provider(None, Some("api.openai.com.")),
            Some("openai".to_string())
        );
        assert_eq!(
            normalize_provider(None, Some("cogfoundry.ai.example.com")),
            None
        );
    }
    /// 自动归因 A4：Claude Code 没有执行环境自报 provider，会话级路由证据（请求 ID
    /// 形状 → anthropic / api.anthropic.com / session-native）是唯一真值——
    /// 计费方 anthropic、按量、route-observed、无未决；不能被当成与 openai 冲突。
    #[test]
    fn anthropic_session_native_route_is_resolved_not_conflicting() {
        let route = RouteEvidence {
            provider_raw: Some("anthropic".to_string()),
            endpoint_host: Some("api.anthropic.com".to_string()),
            evidence_basis: EvidenceBasis::SessionNative,
        };
        let a = resolve_billing_attribution(None, Some(&route));
        assert_eq!(a.provider_id.as_deref(), Some("anthropic"));
        assert_eq!(a.billing_mode, BillingMode::Metered);
        assert_eq!(a.pricing_basis, "route-observed");
        assert_eq!(a.evidence_basis, EvidenceBasis::SessionNative);
        assert!(!a.has_unresolved);
        // 执行环境自报 openai 但会话路由指向别家 → 仍是冲突（既有语义不变）。
        let b = resolve_billing_attribution(Some("openai"), Some(&route));
        assert!(b.has_unresolved);
    }

}
