//! `MoneyMinor` 投影辅助（spec §5.1.1 + §13 M0 D2）——纯数据形状在
//! `agent_vitals_domain::data_contract::MoneyMinor`，本模块做：
//! - ISO 4217 最小货币位数（`minor_digits_for`）
//! - `f64` → `MoneyMinor` 的舍入（`from_f64`，一次 `pyround`，银行家舍入）
//! - 同 `currency` + `basis` 求和（`sum_minor`，跨币返 `None` + warn）
//!
//! **规则（spec §5.1.1）**：每 `(provider, basis, currency)` 桶只 round 一次，
//! 父层金额 = 子项整数之和（守恒由构造）。NaN / Inf 输入 → `None`（由
//! 调用方报业务错误，不静默转 0）。

use agent_vitals_domain::data_contract::{BillingBasis, MoneyMinor};
use serde_json::{json, Value};

/// ISO 4217 最小货币位数（最小货币单位 = 10^-N 主币）。
///
/// 真机关心的币种先硬编码；未知币种 fallback 2（大多数的「元/分」体系），
/// 同时打 stderr 警告——这是业务口子的扩展点，不是死规矩。
pub fn minor_digits_for(currency: &str) -> u32 {
    match currency.to_ascii_uppercase().as_str() {
        "CNY" | "USD" | "EUR" | "GBP" | "HKD" | "SGD" | "AUD" | "CAD" | "CHF" | "NZD" => 2,
        "JPY" | "KRW" => 0,
        "KWD" | "BHD" | "OMR" => 3,
        other => {
            eprintln!(
                "money::minor_digits_for: unknown currency `{other}`, falling back to 2"
            );
            2
        }
    }
}

/// `f64` 浮点金额 → `MoneyMinor`（一次 `pyround`，银行家舍入）。
///
/// NaN / Inf / 负数返回 `None`——调用方报业务错误，不静默。
pub fn from_f64(value: f64, currency: &str, basis: BillingBasis) -> Option<MoneyMinor> {
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    let n = minor_digits_for(currency) as usize;
    let rounded = agent_vitals_domain::util::pyround(value, n);
    // `pyround` 借助字符串往返实现银行家舍入；f64 转 i64 在安全范围内精确。
    let amount_minor = (rounded * 10f64.powi(n as i32)).round() as i64;
    Some(MoneyMinor { amount_minor, currency: currency.to_string(), basis })
}

/// 同 `(currency, basis)` 的 `MoneyMinor` 求和。**跨币返回 `None`**——
/// spec §5.1 规则 5 「不可跨币种相加」；调用方把 `None` 变成
/// `warnings:[{code:"cross_currency_sum_unsupported", ...}]`，**不**伪造总金额。
///
/// 空切片返回 `None`（无项目不可求和；不返回 `amount_minor=0`，那会
/// 被误读成「真实 0 元」）。
pub fn sum_minor(items: &[MoneyMinor]) -> Option<MoneyMinor> {
    let first = items.first()?;
    let total = items[1..]
        .iter()
        .try_fold(first.amount_minor, |acc, m| {
            if m.currency != first.currency || m.basis != first.basis {
                None
            } else {
                acc.checked_add(m.amount_minor)
            }
        })?;
    Some(MoneyMinor {
        amount_minor: total,
        currency: first.currency.clone(),
        basis: first.basis,
    })
}

/// `to_json` 的便捷 wrapper——批量返回 `{ amount_minor, currency, basis }`
/// 数组（与 spec §5.1.1 形状一致）。
pub fn to_json_array(items: &[MoneyMinor]) -> Vec<Value> {
    items.iter().map(|m| json!({
        "amount_minor": m.amount_minor,
        "currency": m.currency,
        "basis": m.basis.as_str(),
    })).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minor_digits_for_known_currencies() {
        assert_eq!(minor_digits_for("CNY"), 2);
        assert_eq!(minor_digits_for("USD"), 2);
        assert_eq!(minor_digits_for("EUR"), 2);
        assert_eq!(minor_digits_for("JPY"), 0);
        assert_eq!(minor_digits_for("KRW"), 0);
        assert_eq!(minor_digits_for("KWD"), 3);
        assert_eq!(minor_digits_for("cny"), 2, "case-insensitive");
    }

    #[test]
    fn minor_digits_unknown_falls_back_to_2() {
        // fallback + stderr warn，逻辑不抛。
        assert_eq!(minor_digits_for("XYZ"), 2);
        assert_eq!(minor_digits_for(""), 2);
    }

    #[test]
    fn from_f64_rounds_half_to_even_bankers() {
        // 0.125 CNY：12.5 分 → 银行家舍入到 12（偶数）；不是 13。
        // 实测银行家舍入：`format!("{:.2}", 0.125).parse::<f64>() == 0.12`。
        let m = from_f64(0.125, "CNY", BillingBasis::MeteredActual).unwrap();
        assert_eq!(m.amount_minor, 12);
        assert_eq!(m.currency, "CNY");
        assert_eq!(m.basis, BillingBasis::MeteredActual);

        // 0.135 CNY：13.5 分 → 银行家舍入到 14（偶数）。
        let m = from_f64(0.135, "CNY", BillingBasis::MeteredActual).unwrap();
        assert_eq!(m.amount_minor, 14);
    }

    #[test]
    fn from_f64_jpy_has_no_minor_units() {
        // JPY = 0 minor digits，1.5 JPY 直接整数化。
        let m = from_f64(1.5, "JPY", BillingBasis::MeteredActual).unwrap();
        assert_eq!(m.amount_minor, 2); // 银行家舍入 1.5 → 2
    }

    #[test]
    fn from_f64_rejects_nan_and_negative() {
        assert!(from_f64(f64::NAN, "CNY", BillingBasis::MeteredActual).is_none());
        assert!(from_f64(f64::INFINITY, "CNY", BillingBasis::MeteredActual).is_none());
        assert!(from_f64(-0.01, "CNY", BillingBasis::MeteredActual).is_none());
    }

    #[test]
    fn sum_minor_aggregates_same_currency_and_basis() {
        let items = vec![
            MoneyMinor { amount_minor: 100, currency: "CNY".into(), basis: BillingBasis::MeteredActual },
            MoneyMinor { amount_minor: 250, currency: "CNY".into(), basis: BillingBasis::MeteredActual },
            MoneyMinor { amount_minor: 50,  currency: "CNY".into(), basis: BillingBasis::MeteredActual },
        ];
        let s = sum_minor(&items).unwrap();
        assert_eq!(s.amount_minor, 400);
    }

    #[test]
    fn sum_minor_refuses_cross_currency() {
        let items = vec![
            MoneyMinor { amount_minor: 100, currency: "CNY".into(), basis: BillingBasis::MeteredActual },
            MoneyMinor { amount_minor: 50,  currency: "USD".into(), basis: BillingBasis::MeteredActual },
        ];
        assert!(sum_minor(&items).is_none(),
            "跨币求和返回 None，调用方把 None 转 warnings 而非伪造总金额");
    }

    #[test]
    fn sum_minor_refuses_mixed_basis() {
        let items = vec![
            MoneyMinor { amount_minor: 100, currency: "CNY".into(), basis: BillingBasis::MeteredActual },
            MoneyMinor { amount_minor: 50,  currency: "CNY".into(), basis: BillingBasis::MeteredEstimate },
        ];
        assert!(sum_minor(&items).is_none());
    }

    #[test]
    fn sum_minor_empty_returns_none() {
        // 无项目不返回 0——会被误读成「真实 0 元」而不是「无数据」。
        assert!(sum_minor(&[]).is_none());
    }

    #[test]
    fn to_json_array_serializes_three_tuples() {
        let items = vec![
            MoneyMinor { amount_minor: 100, currency: "CNY".into(), basis: BillingBasis::MeteredActual },
        ];
        let arr = to_json_array(&items);
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["amount_minor"], 100);
        assert_eq!(arr[0]["currency"], "CNY");
        assert_eq!(arr[0]["basis"], "metered_actual");
    }

    #[test]
    fn domain_money_minor_round_trip_via_json() {
        let original = MoneyMinor { amount_minor: 173347, currency: "CNY".into(), basis: BillingBasis::MeteredActual };
        let restored = MoneyMinor::from_json(&original.to_json()).unwrap();
        assert_eq!(original, restored);
    }
}