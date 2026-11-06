//! 汇率 V2 核心（纯计算，不读文件、不联网、不取时钟）。
//!
//! 设计取舍（docs/PRICING_CURRENCY_AND_FX_V2_SPEC.md §6）：账单层永远按**原币种**记账；
//! 应用层想用一个「报告币种」看汇总时，才经本模块做**带出处的折算**。因此折算结果不是
//! 一个裸数字，而是 [`Conversion`]：原始金额与币种、目标金额与币种、汇率值、汇率来源、
//! 适用日期。调用方必须把「≈」和出处展示出来，**不得**把折算结果写回费用事实或封账历史。
//!
//! 硬规则：
//! - 未知币种、汇率缺失 / 非法（非有限、≤0）→ `None`。**绝不回退到默认常量**——
//!   曾经的 `fx_estimate.USD_CNY = 7.15` 就是这样把一个无日期常量传播到了预算和归因里。
//! - 用户手动汇率优先于内置快照，来源标 `UserAssumption`，且必须是正的有限数。
//! - 内置快照是公开参考汇率（欧央行参考价，两源交叉核对），不是银行结算汇率。

use std::collections::BTreeMap;

use serde_json::Value;

const BUNDLED_SNAPSHOT_JSON: &str = include_str!("../../../../assets/fx-reference-rates.json");

/// 汇率来源。展示层据此写「公开参考汇率」或「手动假设」。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RateSource {
    /// 内置快照（公开参考汇率）。
    BundledSnapshot,
    /// 用户手动输入的假设，不是任何官方或结算汇率。
    UserAssumption,
    /// 同币种，无需折算（汇率恒为 1）。
    Identity,
}

/// 一次折算及其全部出处。`approximate` 恒为 true（Identity 除外）——折算值永远是约数。
#[derive(Clone, Debug, PartialEq)]
pub struct Conversion {
    pub source_amount: f64,
    pub source_currency: String,
    pub target_amount: f64,
    pub target_currency: String,
    /// 1 个 `source_currency` = `rate` 个 `target_currency`。
    pub rate: f64,
    pub rate_source: RateSource,
    /// 汇率适用日期（`YYYY-MM-DD`）；用户假设没有声明日期时为 `None`。
    pub rate_date: Option<String>,
    pub approximate: bool,
}

/// 用户手动汇率：1 `from` = `rate` `to`。
#[derive(Clone, Debug, PartialEq)]
pub struct UserRate {
    pub from: String,
    pub to: String,
    pub rate: f64,
    pub as_of: Option<String>,
}

/// 内置快照：以 USD 为基准，`rates_per_usd[X]` = 1 USD 兑 X 的数量。
#[derive(Clone, Debug, PartialEq)]
pub struct FxSnapshot {
    pub rate_date: String,
    pub captured_at: String,
    pub rates_per_usd: BTreeMap<String, f64>,
}

#[derive(Clone, Debug)]
pub struct FxPolicy {
    snapshot: FxSnapshot,
    user_rates: Vec<UserRate>,
}

fn valid_rate(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

impl FxSnapshot {
    pub fn parse(json: &str) -> Result<Self, String> {
        let root: Value = serde_json::from_str(json).map_err(|error| format!("fx snapshot is not JSON: {error}"))?;
        if root.get("base").and_then(Value::as_str) != Some("USD") {
            return Err("fx snapshot base must be USD".into());
        }
        let rate_date = root.get("rate_date").and_then(Value::as_str).filter(|d| days_from_ymd(d).is_some())
            .ok_or("fx snapshot rate_date missing or malformed")?.to_string();
        let captured_at = root.get("captured_at").and_then(Value::as_str).unwrap_or_default().to_string();
        let rates = root.get("rates").and_then(Value::as_object).ok_or("fx snapshot has no rates")?;
        let mut rates_per_usd = BTreeMap::new();
        for (currency, entry) in rates {
            // 大小写不同的重复键（`cny` 与 `CNY`）会静默互相覆盖，快照被改过时无法判断哪个对 → 拒绝。
            if rates_per_usd.contains_key(&currency.to_uppercase()) { return Err(format!("fx snapshot has duplicate currency {currency}")); }
            // 值是十进制字符串（避免浮点文本漂移）；非法条目直接丢弃，不猜。
            let parsed = entry.get("rate").and_then(Value::as_str).and_then(|text| text.parse::<f64>().ok());
            if let Some(rate) = parsed.filter(|r| valid_rate(*r)) {
                rates_per_usd.insert(currency.to_uppercase(), rate);
            }
        }
        match rates_per_usd.get("USD") {
            None => return Err("fx snapshot lacks USD".into()),
            // 基准币种对自己恒为 1；否则 USD→X 与 USD→USD 会互相矛盾。
            Some(rate) if (*rate - 1.0).abs() > 1e-12 => return Err("fx snapshot USD rate must be 1".into()),
            Some(_) => {}
        }
        Ok(Self { rate_date, captured_at, rates_per_usd })
    }
}

impl FxSnapshot {
    /// 校验一份**联网拿到**的更新快照能否取代 `baseline`（已有的更新快照或内置快照）。
    /// 任何一条不满足就整份拒收——不逐条放行：一份被污染或出错的文件里，没出问题的条目也不可信。
    /// - 日期不能早于 `baseline`（回退）、不能在 `today` 之后（未来）；
    /// - 与 `baseline` 共有的币种，相对偏差不得超过 25%（一天内主要货币不会这样动，超过就是数据有问题）；
    /// - 不能少掉 `baseline` 里的核心币种（USD 必有，其余缺失超过一半视为残缺文件）。
    ///
    /// 时钟由调用方供给（`today` 为 `YYYY-MM-DD`）。
    pub fn validate_update(&self, baseline: &FxSnapshot, today: &str) -> Result<(), String> {
        let age_vs_baseline = FxPolicy::age_days(&baseline.rate_date, &self.rate_date).ok_or("update rate_date is not a valid date")?;
        if age_vs_baseline < 0 {
            return Err(format!("update rate date {} is older than the current {}", self.rate_date, baseline.rate_date));
        }
        let age_vs_today = FxPolicy::age_days(&self.rate_date, today).ok_or("today is not a valid date")?;
        if age_vs_today < 0 {
            return Err(format!("update rate date {} is in the future", self.rate_date));
        }
        let mut shared = 0usize;
        for (currency, old) in &baseline.rates_per_usd {
            let Some(new) = self.rates_per_usd.get(currency) else { continue };
            shared += 1;
            if (new - old).abs() / old > 0.25 {
                return Err(format!("{currency} moved more than 25% against the current snapshot; refusing the whole update"));
            }
        }
        if shared * 2 < baseline.rates_per_usd.len() {
            return Err("update covers fewer than half of the current currencies".into());
        }
        Ok(())
    }
}

impl FxPolicy {
    /// 内置快照（`assets/fx-reference-rates.json`，编译进二进制）。
    pub fn bundled() -> Result<Self, String> {
        Ok(Self { snapshot: FxSnapshot::parse(BUNDLED_SNAPSHOT_JSON)?, user_rates: Vec::new() })
    }

    pub fn from_snapshot(snapshot: FxSnapshot) -> Self {
        Self { snapshot, user_rates: Vec::new() }
    }

    /// 追加用户手动汇率；非正 / 非有限 / 同币对 → 拒绝（返回 Err，不静默吞掉）。
    pub fn with_user_rate(mut self, rate: UserRate) -> Result<Self, String> {
        if !valid_rate(rate.rate) { return Err(format!("manual rate for {}→{} must be a positive finite number", rate.from, rate.to)); }
        if rate.from.trim().is_empty() || rate.to.trim().is_empty() { return Err("manual rate needs both currencies".into()); }
        if rate.from.trim().eq_ignore_ascii_case(rate.to.trim()) { return Err("manual rate needs two different currencies".into()); }
        if let Some(date) = rate.as_of.as_deref() {
            if days_from_ymd(date).is_none() { return Err(format!("manual rate date {date:?} is not YYYY-MM-DD")); }
        }
        self.user_rates.push(UserRate { from: rate.from.trim().to_uppercase(), to: rate.to.trim().to_uppercase(), ..rate });
        Ok(self)
    }

    pub fn snapshot(&self) -> &FxSnapshot { &self.snapshot }

    pub fn supports(&self, currency: &str) -> bool {
        self.snapshot.rates_per_usd.contains_key(&currency.to_uppercase())
    }

    /// 1 `from` = ? `to`，以及它的来源。用户手动值优先（正向或反向）；否则经 USD 交叉。
    fn rate(&self, from: &str, to: &str) -> Option<(f64, RateSource, Option<String>)> {
        if from == to { return Some((1.0, RateSource::Identity, None)); }
        // 后加的手动值覆盖先加的。
        for user in self.user_rates.iter().rev() {
            if user.from == from && user.to == to { return Some((user.rate, RateSource::UserAssumption, user.as_of.clone())); }
            if user.from == to && user.to == from { return Some((1.0 / user.rate, RateSource::UserAssumption, user.as_of.clone())); }
        }
        let per_usd = &self.snapshot.rates_per_usd;
        let (from_rate, to_rate) = (per_usd.get(from)?, per_usd.get(to)?);
        // 1 from = (1 / from_rate) USD = (to_rate / from_rate) to
        Some((to_rate / from_rate, RateSource::BundledSnapshot, Some(self.snapshot.rate_date.clone())))
    }

    /// 折算。金额非有限、币种未知、汇率缺失 → `None`（调用方回退到原币种，标「折算不可用」）。
    pub fn convert(&self, amount: f64, from: &str, to: &str) -> Option<Conversion> {
        if !amount.is_finite() { return None; }
        let (from, to) = (from.to_uppercase(), to.to_uppercase());
        let (rate, rate_source, rate_date) = self.rate(&from, &to)?;
        if !valid_rate(rate) { return None; }
        // 金额与汇率都有限，乘积仍可能溢出成 inf（1e308 × 17891）——不能把 inf 当结果返回。
        if !(amount * rate).is_finite() { return None; }
        Some(Conversion {
            source_amount: amount,
            target_amount: amount * rate,
            source_currency: from,
            target_currency: to,
            rate,
            approximate: rate_source != RateSource::Identity,
            rate_source,
            rate_date,
        })
    }

    /// 汇率距 `today`（`YYYY-MM-DD`）已过去几天；日期不可解析 → `None`。
    /// 时钟由调用方供给（本模块不取时钟）。内置快照与带日期的手动汇率都适用。
    pub fn age_days(rate_date: &str, today: &str) -> Option<i64> {
        Some(days_from_ymd(today)? - days_from_ymd(rate_date)?)
    }
}

/// 系统区域 → 默认报告币种：美区 USD、中国 CNY，**其他一律 USD**（用户决策 2026-10-01）。
/// 区域取标识符里最后一个两位字母段（`en_US` / `zh-Hans-CN` / `zh_CN@collation=pinyin`）；
/// 取不到区域也是 USD。语言不是币种：`zh` 不推出 CNY，`en-GB` 不推出 GBP。
pub fn default_reporting_currency(locale: &str) -> &'static str {
    let base = locale.split('@').next().unwrap_or(locale);
    let region = base
        .split(['_', '-', '.'])
        .rfind(|part| part.len() == 2 && part.chars().all(|c| c.is_ascii_alphabetic()))
        .map(|part| part.to_ascii_uppercase());
    match region.as_deref() {
        Some("CN") => "CNY",
        _ => "USD",
    }
}

/// `YYYY-MM-DD` → 自 1970-01-01 起的天数（公历，Howard Hinnant 算法）。
fn days_from_ymd(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' { return None; }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: i64 = text.get(5..7)?.parse().ok()?;
    let day: i64 = text.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) { return None; }
    // 日必须存在于该月（`2026-02-31` 不是日期）；闰年按公历规则。
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month { 1 | 3 | 5 | 7 | 8 | 10 | 12 => 31, 4 | 6 | 9 | 11 => 30, _ => if leap { 29 } else { 28 } };
    if !(1..=days_in_month).contains(&day) { return None; }
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> FxPolicy { FxPolicy::bundled().expect("bundled snapshot must parse") }

    #[test]
    fn bundled_snapshot_parses_and_covers_the_common_currencies() {
        let p = policy();
        for currency in ["USD", "CNY", "EUR", "JPY", "GBP", "HKD", "KRW", "SGD", "CAD", "AUD", "INR"] {
            assert!(p.supports(currency), "{currency} missing from the bundled snapshot");
        }
        assert!(FxPolicy::age_days(&p.snapshot().rate_date, &p.snapshot().rate_date) == Some(0));
    }

    #[test]
    fn usd_to_cny_uses_the_snapshot_rate_and_carries_provenance() {
        let p = policy();
        let c = p.convert(100.0, "usd", "cny").unwrap();
        assert_eq!(c.source_currency, "USD");
        assert_eq!(c.target_currency, "CNY");
        assert_eq!(c.rate_source, RateSource::BundledSnapshot);
        assert!(c.approximate);
        assert_eq!(c.rate_date.as_deref(), Some(p.snapshot().rate_date.as_str()));
        assert!((c.target_amount - 100.0 * c.rate).abs() < 1e-9);
        assert!(c.rate > 5.0 && c.rate < 9.0, "USD/CNY looks wrong: {}", c.rate);
    }

    #[test]
    fn cross_rates_go_through_usd_and_invert_consistently() {
        let p = policy();
        let eur_cny = p.convert(1.0, "EUR", "CNY").unwrap().rate;
        let usd_eur = p.convert(1.0, "USD", "EUR").unwrap().rate;
        let usd_cny = p.convert(1.0, "USD", "CNY").unwrap().rate;
        assert!((eur_cny - usd_cny / usd_eur).abs() < 1e-9);
        let there = p.convert(7.0, "USD", "JPY").unwrap();
        let back = p.convert(there.target_amount, "JPY", "USD").unwrap();
        assert!((back.target_amount - 7.0).abs() < 1e-9, "round trip drifted: {}", back.target_amount);
    }

    #[test]
    fn same_currency_is_identity_and_not_approximate() {
        let c = policy().convert(12.5, "CNY", "CNY").unwrap();
        assert_eq!((c.rate, c.target_amount, c.approximate, c.rate_source), (1.0, 12.5, false, RateSource::Identity));
    }

    #[test]
    fn unknown_currency_or_bad_amount_never_falls_back_to_a_default() {
        let p = policy();
        assert!(p.convert(1.0, "USD", "XXX").is_none());
        assert!(p.convert(1.0, "ZZZ", "CNY").is_none());
        assert!(p.convert(f64::NAN, "USD", "CNY").is_none());
        assert!(p.convert(f64::INFINITY, "USD", "CNY").is_none());
    }

    #[test]
    fn user_rate_wins_over_the_snapshot_and_is_labelled_an_assumption() {
        let p = policy().with_user_rate(UserRate { from: "usd".into(), to: "cny".into(), rate: 6.8, as_of: Some("2026-09-01".into()) }).unwrap();
        let c = p.convert(100.0, "USD", "CNY").unwrap();
        assert_eq!((c.rate, c.target_amount, c.rate_source.clone()), (6.8, 680.0, RateSource::UserAssumption));
        assert_eq!(c.rate_date.as_deref(), Some("2026-09-01"));
        // 反向也用手动值（1/6.8），不回落到快照
        let back = p.convert(680.0, "CNY", "USD").unwrap();
        assert_eq!(back.rate_source, RateSource::UserAssumption);
        assert!((back.target_amount - 100.0).abs() < 1e-9);
        // 其他币对不受影响
        assert_eq!(p.convert(1.0, "EUR", "JPY").unwrap().rate_source, RateSource::BundledSnapshot);
    }

    #[test]
    fn invalid_user_rates_are_rejected_not_swallowed() {
        let bad = |rate: f64, from: &str, to: &str, as_of: Option<&str>| policy().with_user_rate(UserRate { from: from.into(), to: to.into(), rate, as_of: as_of.map(String::from) }).is_err();
        assert!(bad(0.0, "USD", "CNY", None));
        assert!(bad(-1.0, "USD", "CNY", None));
        assert!(bad(f64::NAN, "USD", "CNY", None));
        assert!(bad(6.8, "USD", "USD", None));
        assert!(bad(6.8, "USD", "CNY", Some("2026/09/01")));
        assert!(bad(6.8, "USD", "CNY", Some("2026-02-31")), "不存在的日期不能当手动汇率的适用日期");
        // 无日期的手动汇率合法（即时 what-if），rate_date 为 None
        let p = policy().with_user_rate(UserRate { from: "USD".into(), to: "CNY".into(), rate: 6.8, as_of: None }).unwrap();
        assert_eq!(p.convert(1.0, "USD", "CNY").unwrap().rate_date, None);
    }

    #[test]
    fn default_reporting_currency_follows_the_region_not_the_language() {
        assert_eq!(default_reporting_currency("en_US"), "USD");
        assert_eq!(default_reporting_currency("en-US"), "USD");
        assert_eq!(default_reporting_currency("zh_CN"), "CNY");
        assert_eq!(default_reporting_currency("zh-Hans-CN"), "CNY");
        assert_eq!(default_reporting_currency("zh_CN@collation=pinyin"), "CNY");
        // 其他一律 USD：语言是中文但区域是台湾/香港，也不是 CNY；英国不推出 GBP
        assert_eq!(default_reporting_currency("zh_TW"), "USD");
        assert_eq!(default_reporting_currency("zh_HK"), "USD");
        assert_eq!(default_reporting_currency("en_GB"), "USD");
        assert_eq!(default_reporting_currency("ja_JP"), "USD");
        assert_eq!(default_reporting_currency("zh"), "USD");
        assert_eq!(default_reporting_currency(""), "USD");
    }

    #[test]
    fn age_is_computed_from_the_callers_clock() {
        assert_eq!(FxPolicy::age_days("2026-09-30", "2026-10-01"), Some(1));
        assert_eq!(FxPolicy::age_days("2026-02-28", "2026-03-01"), Some(1));
        assert_eq!(FxPolicy::age_days("2024-02-28", "2024-03-01"), Some(2), "闰年");
        assert_eq!(FxPolicy::age_days("garbage", "2026-10-01"), None);
        assert_eq!(FxPolicy::age_days("2026-02-31", "2026-10-01"), None, "不存在的日期");
        assert_eq!(FxPolicy::age_days("2026-02-29", "2026-10-01"), None, "2026 不是闰年");
        assert!(FxPolicy::age_days("2024-02-29", "2024-03-01").is_some(), "2024 是闰年");
        assert_eq!(FxPolicy::age_days("2026-04-31", "2026-10-01"), None);
    }

    #[test]
    fn a_downloaded_update_is_validated_as_a_whole_before_it_can_replace_a_snapshot() {
        let baseline = FxPolicy::bundled().unwrap().snapshot().clone();
        let today = "2026-10-02";
        let with = |mutate: &dyn Fn(&mut FxSnapshot)| { let mut s = baseline.clone(); s.rate_date = "2026-10-01".into(); mutate(&mut s); s };
        assert!(with(&|_| {}).validate_update(&baseline, today).is_ok(), "same rates, newer date");
        // 日期：不能回退、不能是未来
        assert!(with(&|s| s.rate_date = "2026-09-29".into()).validate_update(&baseline, today).is_err());
        assert!(with(&|s| s.rate_date = "2026-10-03".into()).validate_update(&baseline, today).is_err());
        assert!(with(&|s| s.rate_date = "2026-02-31".into()).validate_update(&baseline, today).is_err());
        // 一个币种偏差 >25% → 整份拒收，而不是只丢这一条
        let jumped = with(&|s| { let cny = s.rates_per_usd["CNY"]; s.rates_per_usd.insert("CNY".into(), cny * 1.3); });
        assert!(jumped.validate_update(&baseline, today).unwrap_err().contains("CNY"));
        // 24% 以内的正常波动放行
        assert!(with(&|s| { let cny = s.rates_per_usd["CNY"]; s.rates_per_usd.insert("CNY".into(), cny * 1.02); }).validate_update(&baseline, today).is_ok());
        // 残缺文件：只剩 USD
        let mut stub = baseline.clone(); stub.rate_date = "2026-10-01".into();
        stub.rates_per_usd.retain(|k, _| k == "USD");
        assert!(stub.validate_update(&baseline, today).is_err());
    }

    #[test]
    fn overflowing_products_are_not_results() {
        assert!(policy().convert(1e308, "USD", "IDR").is_none(), "有限 × 有限 仍可能溢出成 inf");
    }

    #[test]
    fn snapshot_must_be_self_consistent() {
        assert!(FxSnapshot::parse(r#"{"base":"USD","rate_date":"2026-09-30","rates":{"USD":{"rate":"2"},"CNY":{"rate":"7"}}}"#).is_err(), "USD 必须是 1");
        assert!(FxSnapshot::parse(r#"{"base":"USD","rate_date":"2026-09-30","rates":{"USD":{"rate":"1"},"CNY":{"rate":"7"},"cny":{"rate":"6"}}}"#).is_err(), "大小写重复键拒绝");
    }

    #[test]
    fn manual_rate_currency_codes_are_trimmed_and_non_empty() {
        let p = policy().with_user_rate(UserRate { from: " usd ".into(), to: "cny".into(), rate: 6.8, as_of: None }).unwrap();
        assert_eq!(p.convert(1.0, "USD", "CNY").unwrap().rate, 6.8);
        assert!(policy().with_user_rate(UserRate { from: "".into(), to: "CNY".into(), rate: 6.8, as_of: None }).is_err());
    }

    #[test]
    fn malformed_snapshots_are_rejected() {
        assert!(FxSnapshot::parse("not json").is_err());
        assert!(FxSnapshot::parse(r#"{"base":"EUR","rate_date":"2026-09-30","rates":{"USD":{"rate":"1"}}}"#).is_err());
        assert!(FxSnapshot::parse(r#"{"base":"USD","rate_date":"2026-9-30","rates":{"USD":{"rate":"1"}}}"#).is_err());
        assert!(FxSnapshot::parse(r#"{"base":"USD","rate_date":"2026-09-30","rates":{"CNY":{"rate":"6.7"}}}"#).is_err(), "必须含 USD");
        // 非法条目被丢弃而不是当 0
        let s = FxSnapshot::parse(r#"{"base":"USD","rate_date":"2026-09-30","rates":{"USD":{"rate":"1"},"CNY":{"rate":"-3"},"EUR":{"rate":"abc"},"JPY":{"rate":"157"}}}"#).unwrap();
        assert!(s.rates_per_usd.contains_key("JPY") && !s.rates_per_usd.contains_key("CNY") && !s.rates_per_usd.contains_key("EUR"));
    }
}
