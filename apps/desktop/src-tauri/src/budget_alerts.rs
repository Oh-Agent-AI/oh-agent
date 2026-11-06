//! 桌面预算提醒：只负责把 runtime 的权威预算结果投递到系统通知。
//!
//! 金额、阈值和静默状态都来自 `overview::read_overview` 的 SQL 投影；本模块
//! 不重算预算。投递前先领取 runtime 的持久化许可，通知失败也不会被重试成
//! 第二条提醒（下一轮仍可从账本语义继续判断）。

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::{native_label, native_ui_language, overview, NativeUiLanguage};

const ACTION_TYPE: &str = "budget-alert";
const FOCUS_TAB: &str = "budget";

/// `overview` 由调用方（`sync_tick_inner`）算好传进来——2026-09-23 真机验收
/// 抓到这里曾经自己再调一次 `overview::read_overview()`，跟 `refresh()`
/// 算的是同一份重 SQL 聚合，一个 tick 里白算两遍（budget_alerts 单独一项
/// 就要 3.4-3.9s）。这里只读，不重新查。
pub fn maybe_notify(app: &AppHandle, overview: &overview::Overview) {
    let budget = &overview.budget;
    if budget.source != "sql" || budget.snoozed_until.is_some() {
        return;
    }
    let data_home = overview::data_home();
    if let Some(status) = agent_vitals_runtime::budget::budget_profiles_status_sql_at(
        &data_home, &overview::current_month_beijing(),
    ) {
        if let Some(profiles) = status.get("profiles").and_then(serde_json::Value::as_array) {
            if !profiles.is_empty() {
                notify_profiles(app, &data_home, profiles);
                return;
            }
        }
    }
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(&data_home),
        agent_vitals_runtime::sql_sync::now_ms(),
    ) else {
        return;
    };
    let Ok(Some(config)) = db.budget_config_get() else {
        return;
    };
    let revision = config.updated_at_ms.max(0);
    let warn_ratio = config.warning_ratio_bp as f64 / 10_000.0;
    if !(0.0..=1.0).contains(&warn_ratio) {
        return;
    }
    let day = overview::today_beijing();
    let month = overview::current_month_beijing();

    let mut candidates = Vec::new();
    if let Some(threshold) = threshold_for(budget.ratio, warn_ratio) {
        candidates.push((
            agent_vitals_runtime::budget_notifications::BudgetAlertDeliveryKey {
                period: day,
                scope: agent_vitals_runtime::budget_notifications::BudgetAlertScope::Daily,
                threshold,
                budget_revision: revision,
            },
            budget.ratio,
        ));
    }
    if let Some(threshold) = threshold_for(budget.month_ratio, warn_ratio) {
        candidates.push((
            agent_vitals_runtime::budget_notifications::BudgetAlertDeliveryKey {
                period: month,
                scope: agent_vitals_runtime::budget_notifications::BudgetAlertScope::Monthly,
                threshold,
                budget_revision: revision,
            },
            budget.month_ratio,
        ));
    }

    for (key, ratio) in candidates {
        let threshold_kind = key.threshold;
        let language = native_ui_language();
        let threshold = threshold_label(threshold_kind, language);
        // 系统通知默认不暴露金额、路径或任务内容（REQ-113）。完整金额和
        // 组成只在用户点击后进入预算页查看；这里保留阈值上下文即可。
        let body = budget_notification_body(key.scope, threshold_kind, ratio, language, false);
        let app_for_notification = app.clone();
        let Ok(true) = agent_vitals_runtime::budget_notifications::claim_delivery_with(
            &data_home,
            &key,
            agent_vitals_runtime::sql_sync::now_ms(),
            || app_for_notification.notification().builder()
                .title(format!("Oh Agent{}{threshold}", native_label(language, ": ", "：")))
                .body(body)
                .action_type_id(ACTION_TYPE)
                .extra("focusTab", FOCUS_TAB)
                .show()
                .map_err(|error| error.to_string()),
        ) else {
            continue;
        };
    }
}

fn notify_profiles(app: &AppHandle, data_home: &std::path::Path, profiles: &[serde_json::Value]) {
    for profile in profiles {
        let profile_id = profile.get("profile_id").and_then(serde_json::Value::as_str).unwrap_or("budget");
        let currency = profile.get("currency").and_then(serde_json::Value::as_str).unwrap_or("");
        let warn_ratio = profile.get("warning_ratio_bp").and_then(serde_json::Value::as_i64)
            .map(|bp| bp as f64 / 10_000.0).unwrap_or(-1.0);
        if !(0.0..=1.0).contains(&warn_ratio) || profile.get("has_unresolved").and_then(serde_json::Value::as_bool).unwrap_or(true) {
            continue;
        }
        let revision = profile.get("updated_at_ms").and_then(serde_json::Value::as_i64).unwrap_or(0)
            .saturating_add(profile_id.bytes().fold(0_i64, |sum, b| sum.saturating_mul(31).saturating_add(b as i64)))
            .saturating_add(currency.bytes().fold(0_i64, |sum, b| sum.saturating_mul(31).saturating_add(b as i64)));
        let month = overview::current_month_beijing();
        let day = overview::today_beijing();
        let mut candidates = Vec::new();
        if let Some(threshold) = threshold_for(
            // 告警读「不含汇率折算部分」的比例：折算是约数，只提示、不触发支出警报（规格 §6.1）。
            // 旧载荷没有该键时退回 daily_ratio_bp。
            profile.get("daily_alert_ratio_bp").or_else(|| profile.get("daily_ratio_bp")).and_then(serde_json::Value::as_i64).map(|bp| bp as f64 / 10_000.0),
            warn_ratio,
        ) {
            candidates.push((day, agent_vitals_runtime::budget_notifications::BudgetAlertScope::Daily,
                threshold, profile.get("daily_total_minor").or_else(|| profile.get("daily_spent_minor")).and_then(serde_json::Value::as_i64),
                profile.get("daily_minor").and_then(serde_json::Value::as_i64)));
        }
        if let Some(threshold) = threshold_for(
            profile.get("alert_ratio_bp").or_else(|| profile.get("ratio_bp")).and_then(serde_json::Value::as_i64).map(|bp| bp as f64 / 10_000.0),
            warn_ratio,
        ) {
            candidates.push((month, agent_vitals_runtime::budget_notifications::BudgetAlertScope::Monthly,
                // 已用 = 订阅摊派 + 按量（total_spent_minor，与总览卡/托盘同口径）；旧载荷退回 spent。
                threshold, profile.get("total_spent_minor").or_else(|| profile.get("spent_minor")).and_then(serde_json::Value::as_i64),
                profile.get("monthly_minor").and_then(serde_json::Value::as_i64)));
        }
        for (period, scope, threshold, _spent, _limit) in candidates {
            let language = native_ui_language();
            let threshold_text = threshold_label(threshold, language);
            // profile 名称、金额和币种也属于预算详情，默认不放入系统通知。
            // 点击通知后预算页会展示对应 profile 的完整证据。
            let body = budget_notification_body(scope, threshold, None, language, true);
            let key = agent_vitals_runtime::budget_notifications::BudgetAlertDeliveryKey {
                period, scope, threshold, budget_revision: revision,
            };
            let app_for_notification = app.clone();
            let _ = agent_vitals_runtime::budget_notifications::claim_delivery_with(
                data_home, &key, agent_vitals_runtime::sql_sync::now_ms(), || app_for_notification.notification().builder()
                    .title(format!("Oh Agent{}{threshold_text}", native_label(language, ": ", "：")))
                    .body(body).action_type_id(ACTION_TYPE).extra("focusTab", FOCUS_TAB)
                    .show().map_err(|error| error.to_string()),
            );
        }
    }
}

fn threshold_label(
    threshold: agent_vitals_runtime::budget_notifications::BudgetAlertThreshold,
    language: NativeUiLanguage,
) -> &'static str {
    match threshold {
        agent_vitals_runtime::budget_notifications::BudgetAlertThreshold::Warn => native_label(language, "Approaching budget", "接近预算"),
        agent_vitals_runtime::budget_notifications::BudgetAlertThreshold::Over => native_label(language, "Budget exceeded", "已超预算"),
    }
}

fn budget_notification_body(
    scope: agent_vitals_runtime::budget_notifications::BudgetAlertScope,
    threshold: agent_vitals_runtime::budget_notifications::BudgetAlertThreshold,
    ratio: Option<f64>,
    language: NativeUiLanguage,
    profile: bool,
) -> String {
    let threshold_text = threshold_label(threshold, language);
    let scope_text = match (scope, profile) {
        (agent_vitals_runtime::budget_notifications::BudgetAlertScope::Daily, true) => native_label(language, "Today", "今日"),
        (agent_vitals_runtime::budget_notifications::BudgetAlertScope::Monthly, true) => native_label(language, "This month", "本月"),
        (agent_vitals_runtime::budget_notifications::BudgetAlertScope::Daily, false) => native_label(language, "Today's metered budget", "今日按量预算"),
        (agent_vitals_runtime::budget_notifications::BudgetAlertScope::Monthly, false) => native_label(language, "This month's metered budget", "本月按量预算"),
    };
    let ratio_text = ratio
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| match language {
            NativeUiLanguage::English => format!(" ({:.0}% reached)", value * 100.0),
            NativeUiLanguage::Chinese => format!("（达到 {:.0}%）", value * 100.0),
        })
        .unwrap_or_default();
    match language {
        NativeUiLanguage::English => format!("{scope_text}: {threshold_text}{ratio_text}. Open Budget to review details."),
        NativeUiLanguage::Chinese => format!("{scope_text}{threshold_text}{ratio_text}，点击查看原因与明细。"),
    }
}

fn threshold_for(ratio: Option<f64>, warn_ratio: f64) -> Option<agent_vitals_runtime::budget_notifications::BudgetAlertThreshold> {
    let ratio = ratio?;
    if ratio >= 1.0 {
        Some(agent_vitals_runtime::budget_notifications::BudgetAlertThreshold::Over)
    } else if ratio >= warn_ratio {
        Some(agent_vitals_runtime::budget_notifications::BudgetAlertThreshold::Warn)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_is_first_crossing_aware() {
        assert_eq!(threshold_for(Some(0.79), 0.8), None);
        assert_eq!(threshold_for(Some(0.8), 0.8), Some(agent_vitals_runtime::budget_notifications::BudgetAlertThreshold::Warn));
        assert_eq!(threshold_for(Some(1.0), 0.8), Some(agent_vitals_runtime::budget_notifications::BudgetAlertThreshold::Over));
        assert_eq!(threshold_for(None, 0.8), None);
    }

    #[test]
    fn malformed_warning_ratio_does_not_create_a_threshold() {
        assert_eq!(threshold_for(Some(0.8), 1.2), None);
    }

    #[test]
    fn notification_body_keeps_budget_details_out_of_system_notification() {
        let body = budget_notification_body(
            agent_vitals_runtime::budget_notifications::BudgetAlertScope::Daily,
            agent_vitals_runtime::budget_notifications::BudgetAlertThreshold::Warn,
            Some(0.8),
            NativeUiLanguage::Chinese,
            true,
        );
        assert!(body.contains("达到 80%"));
        assert!(body.contains("查看原因"));
        assert!(!body.contains('¥'));
        assert!(!body.contains("CNY"));
        assert!(!body.contains("USD"));
        let english = budget_notification_body(
            agent_vitals_runtime::budget_notifications::BudgetAlertScope::Daily,
            agent_vitals_runtime::budget_notifications::BudgetAlertThreshold::Warn,
            Some(0.8),
            NativeUiLanguage::English,
            true,
        );
        assert_eq!(english, "Today: Approaching budget (80% reached). Open Budget to review details.");
        assert!(!english.contains('¥'));
    }
}
