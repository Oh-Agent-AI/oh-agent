//! Claude Code 账户级证据（自动归因规格 §1.3 / §2 L2 / §7 P1）。
//!
//! 只读 `~/.claude.json` → `oauthAccount` 的**三个属性字段**：`organizationType`
//! （套餐类型）、`billingType`（付款渠道）、`subscriptionCreatedAt`（账期锚点）。
//! 同一对象里的 `emailAddress` / `accountUuid` / `organizationUuid` 是身份，令牌
//! 在别的文件——这里连读都不读，`AccountEvidence` 类型上也没有它们的位置。
//! 文件缺失 / 损坏 / 字段缺失一律 `None`，不猜。

use std::path::Path;

use agent_vitals_provider::{AccountEvidence, EvidenceBasis, PlanKind};
use serde_json::Value;

const ALLOWED_KEYS: [&str; 3] = ["organizationType", "billingType", "subscriptionCreatedAt"];

pub fn read_claude_account(home: &Path) -> Option<AccountEvidence> {
    let text = std::fs::read_to_string(home.join(".claude.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let account = value.get("oauthAccount")?.as_object()?;
    // 白名单投影：先把三个键抄出来，之后的逻辑再也碰不到原对象。
    let pick = |key: &str| {
        debug_assert!(ALLOWED_KEYS.contains(&key));
        account.get(key).and_then(Value::as_str).map(str::to_string)
    };
    account_evidence_from(
        pick("organizationType").as_deref(),
        pick("billingType").as_deref(),
        pick("subscriptionCreatedAt").as_deref(),
    )
}

/// 纯映射（可测）：账户属性 → 证据。`organizationType` 的已知值：
/// `claude_pro` / `claude_max` / `claude_team` / `claude_enterprise` 是订阅；
/// `api` / `developer` / `console` 是按 API 计费；其余 → Unknown（标签不上卡面）。
pub fn account_evidence_from(
    organization_type: Option<&str>, billing_type: Option<&str>, subscription_created_at: Option<&str>,
) -> Option<AccountEvidence> {
    let organization_type = organization_type?.trim().to_ascii_lowercase();
    let (plan_kind, plan_label) = match organization_type.as_str() {
        "claude_pro" => (PlanKind::Subscription, Some("Claude Pro")),
        "claude_max" => (PlanKind::Subscription, Some("Claude Max")),
        "claude_team" => (PlanKind::Subscription, Some("Claude Team")),
        "claude_enterprise" => (PlanKind::Subscription, Some("Claude Enterprise")),
        "api" | "developer" | "console" => (PlanKind::ApiKey, None),
        _ => (PlanKind::Unknown, None),
    };
    let anchor_date = subscription_created_at
        .map(str::trim)
        .filter(|s| s.len() >= 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-')
        .map(|s| s[..10].to_string());
    Some(AccountEvidence {
        harness: "claude-code".to_string(),
        vendor: "anthropic".to_string(),
        plan_kind,
        plan_label: plan_label.map(str::to_string),
        billing_channel: billing_type.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        anchor_date,
        evidence_basis: EvidenceBasis::AccountTimeBound,
        source: "~/.claude.json oauthAccount.{organizationType,billingType,subscriptionCreatedAt}".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_claude_pro_with_anchor_day() {
        let e = account_evidence_from(Some("claude_pro"), Some("apple_subscription"), Some("2025-07-20T22:26:59.566771Z")).unwrap();
        assert_eq!(e.plan_kind, PlanKind::Subscription);
        assert_eq!(e.plan_label.as_deref(), Some("Claude Pro"));
        assert_eq!(e.anchor_date.as_deref(), Some("2025-07-20"));
        assert_eq!(e.billing_channel.as_deref(), Some("apple_subscription"));
        assert_eq!(e.evidence_basis, EvidenceBasis::AccountTimeBound);
    }

    #[test]
    fn unknown_types_stay_unknown_and_missing_file_is_none() {
        let e = account_evidence_from(Some("something_new"), None, Some("bad")).unwrap();
        assert_eq!(e.plan_kind, PlanKind::Unknown);
        assert_eq!(e.plan_label, None);
        assert_eq!(e.anchor_date, None);
        assert_eq!(account_evidence_from(None, Some("x"), None), None);
        let dir = std::env::temp_dir().join(format!("av-claude-account-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_claude_account(&dir), None);
        std::fs::write(dir.join(".claude.json"), "{not json").unwrap();
        assert_eq!(read_claude_account(&dir), None);
    }

    /// 规格 §7 P1：即使文件里有邮箱/UUID/令牌，证据里也不可能出现——类型上没有
    /// 位置，序列化后的键集合是固定的。
    #[test]
    fn evidence_never_carries_identity_fields() {
        let dir = std::env::temp_dir().join(format!("av-claude-account-p1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".claude.json"), serde_json::json!({"oauthAccount": {
            "accountUuid": "11111111-2222-3333-4444-555555555555", "emailAddress": "someone@example.com",
            "organizationUuid": "66666666-7777-8888-9999-000000000000", "organizationType": "claude_pro",
            "billingType": "apple_subscription", "subscriptionCreatedAt": "2025-07-20T22:26:59Z",
            "accessToken": "sk-ant-should-never-appear"
        }}).to_string()).unwrap();
        let e = read_claude_account(&dir).unwrap();
        let json = serde_json::to_string(&e).unwrap();
        for forbidden in ["someone@example.com", "11111111", "66666666", "sk-ant", "accountUuid", "emailAddress"] {
            assert!(!json.contains(forbidden), "{forbidden} leaked into {json}");
        }
        let keys: Vec<&str> = serde_json::from_str::<serde_json::Map<String, Value>>(&json).unwrap()
            .keys().map(String::as_str).map(|k| Box::leak(k.to_string().into_boxed_str()) as &str).collect();
        assert_eq!(keys, ["harness", "vendor", "plan_kind", "plan_label", "billing_channel", "anchor_date", "evidence_basis", "source"]);
    }
}
