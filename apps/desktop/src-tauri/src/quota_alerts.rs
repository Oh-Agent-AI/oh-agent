//! Claude Pro 的额度窗口提醒：把 runtime 算好的窗口状态投递到系统通知。
//!
//! **只报"已耗尽 + 什么时候重置"**。Claude 的本地日志里不存在正向余量
//! （42/42 条 `quotaLimits` 全是 `status:"rejected"`，无 `used_percent`），所以
//! 通知正文里**不能有百分比**——那是编的（`ROUTE_UNIT_COST_DECISION_SPEC`
//! §8.3.2）。同理不暴露任何金额或路径（REQ-113 的系统通知纪律）。
//!
//! 投递账本与预算提醒共用（`budget_notifications::claim_delivery`），但**键按窗口取**：
//! `claude-quota-window:<resets_at>`。同一个窗口只提醒一次；窗口重置后再撞窗是
//! 一条新的键，因此会再提醒一次——正是"每周期最多一次"的语义。
//!
//! 发送失败**不消耗**投递许可（`claim_delivery_with` 的既有语义），所以通知
//! 权限还没授予时不会被记成"已提醒过"，用户之后开启权限仍会收到。

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::{native_label, native_ui_language, overview, NativeUiLanguage};

fn quota_window_label(window: &str, language: NativeUiLanguage) -> &'static str {
    match window {
        "five_hour" => native_label(language, "5-hour window", "5 小时窗口"),
        "seven_day" => native_label(language, "7-day window", "7 天窗口"),
        _ => native_label(language, "quota window", "额度窗口"),
    }
}

fn quota_notification_body(window: &str, reset_hhmm: &str, language: NativeUiLanguage) -> String {
    let label = quota_window_label(window, language);
    match language {
        NativeUiLanguage::English => format!("Claude Pro {label} exhausted; resets at {reset_hhmm}. This alert does not stop the tool."),
        NativeUiLanguage::Chinese => format!("Claude Pro 的{label}已耗尽，{reset_hhmm} 重置。提醒不会阻止工具继续使用。"),
    }
}

/// `ov` 由调用方（`sync_tick_inner`）算好传进来——同一份重 SQL 聚合
/// `refresh()`/`budget_alerts::maybe_notify()` 都要用，不在这里再查一次
/// （2026-09-23 真机验收：一个 tick 里独立查三遍是当时最大的单项浪费）。
pub fn maybe_notify(app: &AppHandle, ov: &overview::Overview) {
    let data_home = overview::data_home();
    // 默认关、且读不出开关也当关（用户没明确同意过就不打扰）。
    if !agent_vitals_runtime::quota_reminder::enabled_or_default(&data_home) {
        return;
    }
    // 与预算共用「本周期静默」：用户按下静默就是不想被打扰，换个提醒再烦一次
    // 就违背了那个动作的意图。
    if ov.budget.snoozed_until.is_some() {
        return;
    }
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    let Some(status) = agent_vitals_runtime::summary::claude_quota_status(now_ms / 1_000) else {
        return;
    };
    if status.get("state").and_then(serde_json::Value::as_str) != Some("exhausted") {
        return;
    }
    let Some(resets_at) = status.get("resets_at").and_then(serde_json::Value::as_i64) else {
        return;
    };
    let window = status
        .get("window")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("five_hour");
    // 重置时刻按统计时区展示（与工作台同一套时区语义）；只取 HH:MM，通知里不必
    // 报日期——窗口最长 7 天，正文说清"什么时候"就够了。
    let reset_text = agent_vitals_runtime::clock::local_timestamp_text(resets_at);
    let reset_hhmm = reset_text.get(11..16).unwrap_or(reset_text.as_str());
    let language = native_ui_language();
    let body = quota_notification_body(window, reset_hhmm, language);
    let key = agent_vitals_runtime::budget_notifications::quota_window_delivery_key(
        "claude-code", window, resets_at,
    );
    let app_for_notification = app.clone();
    let _ = agent_vitals_runtime::budget_notifications::claim_delivery_key_with(
        &data_home,
        &key,
        now_ms,
        || {
            app_for_notification
                .notification()
                .builder()
                .title(native_label(language, "Oh Agent: Claude Pro quota", "Oh Agent：Claude Pro 额度"))
                .body(body)
                .show()
                .map_err(|error| error.to_string())
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_notification_localizes_without_exposing_usage() {
        let english = quota_notification_body("five_hour", "09:30", NativeUiLanguage::English);
        assert!(english.contains("5-hour window exhausted"));
        assert!(english.contains("09:30"));
        assert!(!english.contains('%'));
        let chinese = quota_notification_body("seven_day", "09:30", NativeUiLanguage::Chinese);
        assert!(chinese.contains("7 天窗口已耗尽"));
        assert!(!chinese.contains('¥'));
    }
}
