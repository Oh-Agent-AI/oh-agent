//! 预算提醒的本地投递去重账本。
//!
//! 它只决定「这一次跨越是否允许投递」，不负责发送系统通知，也不重新计算
//! 预算。调用方必须先用权威预算结果判定具体的日/月阈值；静默期间不得调用
//! `claim_delivery`，从而不会吞掉静默结束后应当出现的首次提醒。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

const DELIVERY_FILE: &str = "budget-alert-deliveries.json";
const LOCK_FILE: &str = ".budget-alert-deliveries.lock";

/// 一条提醒的稳定身份。`budget_revision` 应来自预算配置的更新时间；用户修改
/// 预算后，用新阈值重新判断，不被旧配置下的投递记录抑制。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetAlertDeliveryKey {
    /// 日预算使用 `YYYY-MM-DD`，月预算使用 `YYYY-MM`。
    pub period: String,
    pub scope: BudgetAlertScope,
    pub threshold: BudgetAlertThreshold,
    pub budget_revision: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetAlertScope {
    Daily,
    Monthly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetAlertThreshold {
    Warn,
    Over,
}

impl BudgetAlertDeliveryKey {
    fn encoded(&self) -> Result<String, String> {
        let period_is_valid = match self.scope {
            BudgetAlertScope::Daily => valid_day(&self.period),
            BudgetAlertScope::Monthly => valid_month(&self.period),
        };
        if !period_is_valid {
            return Err("budget alert period is invalid for its scope".to_string());
        }
        if self.budget_revision < 0 {
            return Err("budget alert revision must be non-negative".to_string());
        }
        let scope = match self.scope { BudgetAlertScope::Daily => "daily", BudgetAlertScope::Monthly => "monthly" };
        let threshold = match self.threshold { BudgetAlertThreshold::Warn => "warn", BudgetAlertThreshold::Over => "over" };
        Ok(format!("{}|{scope}|{threshold}|{}", self.period, self.budget_revision))
    }
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct DeliveryState {
    deliveries: BTreeMap<String, i64>,
}

/// 原子地领取一次投递许可。返回 true 表示调用方现在应发送提醒；false 表示
/// 相同周期、阈值和预算版本已经发送过。读写/锁失败一律返回错误，调用方应
/// fail-closed 而不是发送可能重复的通知。
pub fn claim_delivery(
    data_home: &Path,
    key: &BudgetAlertDeliveryKey,
    now_ms: i64,
) -> Result<bool, String> {
    claim_delivery_with(data_home, key, now_ms, || Ok(()))
}

/// 在同一把跨进程 lease 内完成“发送尝试 + 成功落账”。发送失败不会写入
/// 去重账本，下一轮仍可重试；发送闭包应只做快速的系统通知调用。
pub fn claim_delivery_with<F>(
    data_home: &Path,
    key: &BudgetAlertDeliveryKey,
    now_ms: i64,
    send: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let encoded = key.encoded()?;
    claim_encoded_with(data_home, &encoded, now_ms, send)
}

/// 额度窗口提醒的键：`quota-window|<harness>|<window>|<resets_at>`。
///
/// 键里带 `resets_at` 是刻意的：同一个窗口只提醒一次，**窗口重置后再撞窗是一条
/// 新键**，因此会再提醒一次——正是"每周期最多一次"的语义。
pub fn quota_window_delivery_key(harness: &str, window: &str, resets_at: i64) -> String {
    format!("quota-window|{harness}|{window}|{resets_at}")
}

/// 通用投递许可：键由调用方给出（如 [`quota_window_delivery_key`]）。
///
/// 这个账本本来就是**投递去重**用的，预算只是它的第一个消费方；2026-09-14 起
/// Claude 的额度窗口也用同一份账本 —— 所以键的构造与校验留在这里，语义留在
/// 调用方。发送失败不写账本（与预算那条同一语义：通知没发出去就不算提醒过）。
pub fn claim_delivery_key_with<F>(
    data_home: &Path,
    key: &str,
    now_ms: i64,
    send: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Result<(), String>,
{
    if key.is_empty() || key.contains('\n') {
        return Err("delivery key must be a non-empty single line".to_string());
    }
    claim_encoded_with(data_home, key, now_ms, send)
}

fn claim_encoded_with<F>(
    data_home: &Path,
    encoded: &str,
    now_ms: i64,
    send: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Result<(), String>,
{
    if now_ms < 0 { return Err("budget alert timestamp must be non-negative".to_string()); }
    let directory = data_home.join("state");
    let lock = crate::lease::acquire_blocking(
        &directory.join(LOCK_FILE), "budget-alert-delivery", 2_000, 2_000,
    ).map_err(|error| format!("budget alert delivery lock unavailable: {error}"))?;
    let mut state = read_state(&directory)?;
    if state.deliveries.contains_key(encoded) {
        return Ok(false);
    }
    send()?;
    state.deliveries.insert(encoded.to_string(), now_ms);
    write_state(&directory, &state)?;
    lock.release().map_err(|error| format!("budget alert delivery lock release failed: {error}"))?;
    Ok(true)
}

fn read_state(directory: &Path) -> Result<DeliveryState, String> {
    let path = directory.join(DELIVERY_FILE);
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("budget alert delivery state is invalid: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DeliveryState::default()),
        Err(error) => Err(format!("budget alert delivery state is unreadable: {error}")),
    }
}

fn write_state(directory: &Path, state: &DeliveryState) -> Result<(), String> {
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let temporary = directory.join("budget-alert-deliveries.json.tmp");
    let target = directory.join(DELIVERY_FILE);
    let text = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, text).map_err(|error| error.to_string())?;
    std::fs::rename(temporary, target).map_err(|error| error.to_string())
}

fn valid_month(period: &str) -> bool {
    period.is_ascii()
        && period.len() == 7
        && period.as_bytes().get(4) == Some(&b'-')
        && period[..4].parse::<u16>().is_ok()
        && period[5..].parse::<u8>().is_ok_and(|month| (1..=12).contains(&month))
}

fn valid_day(period: &str) -> bool {
    period.is_ascii()
        && period.len() == 10
        && period.as_bytes().get(4) == Some(&b'-')
        && period.as_bytes().get(7) == Some(&b'-')
        && valid_month(&period[..7])
        && period[8..].parse::<u8>().is_ok_and(|day| (1..=31).contains(&day))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_home(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("agent-vitals-budget-notifications-{name}-{}", std::process::id()))
    }

    fn daily(threshold: BudgetAlertThreshold, revision: i64) -> BudgetAlertDeliveryKey {
        BudgetAlertDeliveryKey {
            period: "2026-09-12".to_string(), scope: BudgetAlertScope::Daily,
            threshold, budget_revision: revision,
        }
    }

    #[test]
    fn quota_window_keys_dedupe_per_window_and_reopen_after_reset() {
        // 契约：同一窗口只提醒一次；窗口重置（resets_at 变了 = 新键）后再撞窗
        // 会再提醒一次 —— 这就是"每周期最多一次"。
        let home = std::env::temp_dir().join(format!("av-quota-delivery-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let window = quota_window_delivery_key("claude-code", "five_hour", 1_000);
        assert!(claim_delivery_key_with(&home, &window, 1, || Ok(())).unwrap());
        assert!(!claim_delivery_key_with(&home, &window, 2, || Ok(())).unwrap(),
            "同一个窗口第二次不得再提醒");
        let next = quota_window_delivery_key("claude-code", "five_hour", 2_000);
        assert!(claim_delivery_key_with(&home, &next, 3, || Ok(())).unwrap(),
            "窗口重置后再撞窗是新键，应重新提醒");
        // 发送失败不消耗许可（与预算那条同一语义）。
        let failing = quota_window_delivery_key("claude-code", "seven_day", 5_000);
        assert!(claim_delivery_key_with(&home, &failing, 4, || Err("denied".into())).is_err());
        assert!(claim_delivery_key_with(&home, &failing, 5, || Ok(())).unwrap(),
            "上一次没发出去，这次仍应允许投递");
        // 空键/换行键直接拒绝，别把畸形键写进账本。
        assert!(claim_delivery_key_with(&home, "", 6, || Ok(())).is_err());
        assert!(claim_delivery_key_with(&home, "a\nb", 7, || Ok(())).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn same_period_threshold_and_budget_revision_only_claims_once() {
        let home = temporary_home("dedupe");
        let _ = std::fs::remove_dir_all(&home);
        let key = daily(BudgetAlertThreshold::Warn, 7);
        assert!(claim_delivery(&home, &key, 100).unwrap());
        assert!(!claim_delivery(&home, &key, 200).unwrap());
        assert!(claim_delivery(&home, &daily(BudgetAlertThreshold::Over, 7), 300).unwrap());
        assert!(claim_delivery(&home, &daily(BudgetAlertThreshold::Warn, 8), 400).unwrap());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn malformed_state_fails_closed() {
        let home = temporary_home("invalid");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("state")).unwrap();
        std::fs::write(home.join("state").join(DELIVERY_FILE), b"not json").unwrap();
        assert!(claim_delivery(&home, &daily(BudgetAlertThreshold::Warn, 1), 100).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn failed_send_does_not_consume_delivery() {
        let home = temporary_home("send-failure");
        let _ = std::fs::remove_dir_all(&home);
        let key = daily(BudgetAlertThreshold::Warn, 1);
        assert!(claim_delivery_with(&home, &key, 100, || Err("permission denied".to_string())).is_err());
        assert!(claim_delivery_with(&home, &key, 200, || Ok(())).unwrap());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn invalid_period_is_rejected_before_writing() {
        let home = temporary_home("invalid-period");
        let _ = std::fs::remove_dir_all(&home);
        let key = BudgetAlertDeliveryKey {
            period: "2026-13".to_string(), scope: BudgetAlertScope::Monthly,
            threshold: BudgetAlertThreshold::Warn, budget_revision: 1,
        };
        assert!(claim_delivery(&home, &key, 100).is_err());
        assert!(!home.join("state").join(DELIVERY_FILE).exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn non_ascii_period_is_rejected_without_panicking() {
        let home = temporary_home("unicode-period");
        let _ = std::fs::remove_dir_all(&home);
        let key = BudgetAlertDeliveryKey {
            period: "预算周期".to_string(), scope: BudgetAlertScope::Monthly,
            threshold: BudgetAlertThreshold::Warn, budget_revision: 1,
        };
        assert!(claim_delivery(&home, &key, 100).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }
}
