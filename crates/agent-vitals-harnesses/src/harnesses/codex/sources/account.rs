//! Codex 账户级证据（自动归因规格 §1.3 / §2 L2 / §7 P1）。
//!
//! 只读 `~/.codex/auth.json` 的 **`auth_mode`** 一个键，以及「是否存在
//! `OPENAI_API_KEY` 键」这一布尔（不读值）。`tokens` 对象整段不碰。
//! `chatgpt` = ChatGPT 订阅登录（请求走 ChatGPT 后端，按套餐计）；`apikey` =
//! 按 API 计费；其余 → Unknown。套餐等级由既有的配额快照（`plan_type`）提供，
//! 不在这里重复读。

use std::path::Path;

use agent_vitals_provider::{AccountEvidence, EvidenceBasis, PlanKind};
use serde_json::Value;

pub fn read_codex_account(home: &Path) -> Option<AccountEvidence> {
    let text = std::fs::read_to_string(home.join(".codex").join("auth.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let object = value.as_object()?;
    let auth_mode = object.get("auth_mode").and_then(Value::as_str).map(str::to_string);
    let has_api_key = object.get("OPENAI_API_KEY").and_then(Value::as_str).is_some_and(|k| !k.is_empty());
    account_evidence_from(auth_mode.as_deref(), has_api_key)
}

pub fn account_evidence_from(auth_mode: Option<&str>, has_api_key: bool) -> Option<AccountEvidence> {
    let mode = auth_mode.map(|m| m.trim().to_ascii_lowercase());
    let (plan_kind, plan_label) = match mode.as_deref() {
        Some("chatgpt") => (PlanKind::Subscription, Some("ChatGPT")),
        Some("apikey") | Some("api_key") => (PlanKind::ApiKey, None),
        None if has_api_key => (PlanKind::ApiKey, None),
        None => return None,
        Some(_) => (PlanKind::Unknown, None),
    };
    Some(AccountEvidence {
        harness: "codex".to_string(),
        vendor: "openai".to_string(),
        plan_kind,
        plan_label: plan_label.map(str::to_string),
        billing_channel: None,
        anchor_date: None,
        evidence_basis: EvidenceBasis::AccountTimeBound,
        source: "~/.codex/auth.json auth_mode".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chatgpt_login_is_a_subscription_and_apikey_is_metered() {
        assert_eq!(account_evidence_from(Some("chatgpt"), false).unwrap().plan_kind, PlanKind::Subscription);
        assert_eq!(account_evidence_from(Some("apikey"), true).unwrap().plan_kind, PlanKind::ApiKey);
        assert_eq!(account_evidence_from(None, true).unwrap().plan_kind, PlanKind::ApiKey);
        assert_eq!(account_evidence_from(None, false), None);
        assert_eq!(account_evidence_from(Some("device"), false).unwrap().plan_kind, PlanKind::Unknown);
    }

    #[test]
    fn tokens_never_leak() {
        let dir = std::env::temp_dir().join(format!("av-codex-account-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".codex")).unwrap();
        std::fs::write(dir.join(".codex").join("auth.json"), serde_json::json!({
            "OPENAI_API_KEY": null, "auth_mode": "chatgpt", "last_refresh": "2026-09-16T00:00:00Z",
            "tokens": {"access_token": "eyJ-should-never-appear", "account_id": "acct-secret", "id_token": "x", "refresh_token": "y"}
        }).to_string()).unwrap();
        let e = read_codex_account(&dir).unwrap();
        let json = serde_json::to_string(&e).unwrap();
        for forbidden in ["eyJ", "acct-secret", "refresh_token", "access_token"] {
            assert!(!json.contains(forbidden), "{forbidden} leaked");
        }
        assert_eq!(e.plan_label.as_deref(), Some("ChatGPT"));
    }
}
