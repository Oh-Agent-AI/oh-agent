//! 报告币种与手动汇率的持久化（`<data_home>/state/` 下两个小 JSON）。
//!
//! 账单层始终按原币种记账；这里只保存**展示偏好**：应用层用哪个币种汇总，以及用户手动
//! 输入的汇率假设。两者都不改任何费用事实，删掉文件即恢复默认。

use std::path::Path;

use agent_vitals_domain::fx::{default_reporting_currency, FxPolicy, FxSnapshot, UserRate};
use serde_json::{json, Value};

const CURRENCY_FILE: &str = "reporting-currency.json";
const MANUAL_RATES_FILE: &str = "fx-manual-rates.json";

/// 保存哨兵：选「按系统区域默认」就删文件，之后随区域走（同「跟随系统」时区的做法）。
pub const DEFAULT_SENTINEL: &str = "default";

pub(crate) fn state_path(data_home: &Path, file: &str) -> std::path::PathBuf { data_home.join("state").join(file) }

pub(crate) fn write_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let directory = path.parent().ok_or("state path has no parent")?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    // 临时文件名带进程号与纳秒：两个并发保存不再抢同一个固定的 *.json.tmp。
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let temporary = path.with_extension(format!("json.{}.{nonce}.tmp", std::process::id()));
    std::fs::write(&temporary, serde_json::to_vec(value).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

/// 文件损坏（不是合法 JSON）= 应用自己无法修复的状态：这是设置文件，不是用户账单。
/// 把坏文件改名为 `.bad` 留作证据，之后当作「没有文件」继续；否则保存、移除都会一直报错，
/// 而界面又把错误吞掉，用户只能手动删文件。
pub(crate) fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(value) => Ok(Some(value)),
            Err(_) => {
                let _ = std::fs::rename(path, path.with_extension("json.bad"));
                Ok(None)
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{} unreadable: {error}", path.display())),
    }
}

const LOCALE_FILE: &str = "system-locale.json";

/// 记下 app 读到的系统区域，让 CLI / MCP 这些不读系统偏好的面也能算出同一个默认报告币种。
/// 只在变化时写盘；空串不写。
pub fn save_locale_hint(data_home: &Path, locale: &str) -> Result<(), String> {
    let locale = locale.trim();
    if locale.is_empty() || locale_hint(data_home) == locale { return Ok(()); }
    write_atomic(&state_path(data_home, LOCALE_FILE), &json!({ "locale": locale }))
}

/// 上次记下的系统区域（没有 → 空串）。
pub fn locale_hint(data_home: &Path) -> String {
    read_json(&state_path(data_home, LOCALE_FILE)).ok().flatten()
        .and_then(|v| v.get("locale").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

/// 报告币种，但**只在有依据时**才给：用户保存过 → 它；否则有区域提示 → 区域默认；两者都没有
/// → None。给「并列报价默认假设」用——没有任何依据时不能凭空猜一个币种去换价卡
/// （纯 CLI 用户在没跑过 app 前，应继续按基础卡计价，而不是被默认成 USD）。
pub fn reporting_currency_if_known(data_home: &Path) -> Option<String> {
    let hint = locale_hint(data_home);
    let (currency, is_default) = reporting_currency(data_home, &hint).ok()?;
    if is_default && hint.is_empty() { None } else { Some(currency) }
}

/// 当前报告币种与是否是默认值。`system_locale` 由调用方供给（本模块不读环境）。
/// 已保存的币种若不在快照里（快照更新后被移除）→ 退回默认，不用一个无法折算的币种。
pub fn reporting_currency(data_home: &Path, system_locale: &str) -> Result<(String, bool), String> {
    let fallback = default_reporting_currency(system_locale).to_string();
    let Some(saved) = read_json(&state_path(data_home, CURRENCY_FILE))? else { return Ok((fallback, true)) };
    let code = saved.get("currency").and_then(Value::as_str).map(str::to_ascii_uppercase);
    let policy = FxPolicy::bundled()?;
    match code {
        Some(code) if policy.supports(&code) => Ok((code, false)),
        _ => Ok((fallback, true)),
    }
}

pub fn save_reporting_currency(data_home: &Path, code: &str) -> Result<String, String> {
    let path = state_path(data_home, CURRENCY_FILE);
    if code.trim().eq_ignore_ascii_case(DEFAULT_SENTINEL) {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        return Ok(DEFAULT_SENTINEL.to_string());
    }
    let upper = code.trim().to_ascii_uppercase();
    if !FxPolicy::bundled()?.supports(&upper) { return Err(format!("currency {code:?} has no reference rate")); }
    write_atomic(&path, &json!({ "currency": upper }))?;
    Ok(upper)
}

/// 读手动汇率，同时报告有没有读不懂而被跳过的行（调用方据此在改写前先备份，不静默丢行）。
fn read_manual(data_home: &Path) -> Result<(Vec<UserRate>, bool), String> {
    let Some(root) = read_json(&state_path(data_home, MANUAL_RATES_FILE))? else { return Ok((Vec::new(), false)) };
    let Some(rows) = root.get("rates").and_then(Value::as_array) else { return Ok((Vec::new(), true)) };
    let mut out = Vec::new();
    let mut lossy = false;
    for row in rows {
        let (Some(from), Some(to), Some(rate)) = (row.get("from").and_then(Value::as_str), row.get("to").and_then(Value::as_str), row.get("rate").and_then(Value::as_f64)) else { lossy = true; continue };
        out.push(UserRate { from: from.into(), to: to.into(), rate, as_of: row.get("as_of").and_then(Value::as_str).map(String::from) });
    }
    Ok((out, lossy))
}

pub fn manual_rates(data_home: &Path) -> Result<Vec<UserRate>, String> {
    read_manual(data_home).map(|(rates, _)| rates)
}

/// 改写之前：若原文件里有读不懂的行，先整份备份成 `.bak`，再写。
fn backup_if_lossy(data_home: &Path, lossy: bool) {
    if lossy {
        let path = state_path(data_home, MANUAL_RATES_FILE);
        let _ = std::fs::copy(&path, path.with_extension("json.bak"));
    }
}

fn write_manual(data_home: &Path, rates: &[UserRate]) -> Result<(), String> {
    let rows: Vec<Value> = rates.iter().map(|r| json!({ "from": r.from, "to": r.to, "rate": r.rate, "as_of": r.as_of })).collect();
    write_atomic(&state_path(data_home, MANUAL_RATES_FILE), &json!({ "rates": rows }))
}

/// 设置（或覆盖）一个币对的手动汇率。校验交给 `FxPolicy::with_user_rate`。
pub fn save_manual_rate(data_home: &Path, rate: UserRate) -> Result<(), String> {
    FxPolicy::bundled()?.with_user_rate(rate.clone())?; // 只为校验
    let (from, to) = (rate.from.to_ascii_uppercase(), rate.to.to_ascii_uppercase());
    let (existing, lossy) = read_manual(data_home)?;
    backup_if_lossy(data_home, lossy);
    let mut rates: Vec<UserRate> = existing.into_iter()
        .filter(|r| !(r.from.eq_ignore_ascii_case(&from) && r.to.eq_ignore_ascii_case(&to)) && !(r.from.eq_ignore_ascii_case(&to) && r.to.eq_ignore_ascii_case(&from)))
        .collect();
    rates.push(UserRate { from, to, ..rate });
    write_manual(data_home, &rates)
}

pub fn remove_manual_rate(data_home: &Path, from: &str, to: &str) -> Result<(), String> {
    let (existing, lossy) = read_manual(data_home)?;
    backup_if_lossy(data_home, lossy);
    let rates: Vec<UserRate> = existing.into_iter()
        .filter(|r| !(r.from.eq_ignore_ascii_case(from) && r.to.eq_ignore_ascii_case(to)) && !(r.from.eq_ignore_ascii_case(to) && r.to.eq_ignore_ascii_case(from)))
        .collect();
    write_manual(data_home, &rates)
}

const SYNCED_FILE: &str = "fx-synced-rates.json";

/// 联网同步下来的更新快照（若有且仍然有效）。每次读取都按「相对内置快照」重新校验：
/// 文件被改坏、或内置快照随版本更新后它已经落后，都自动退回内置，不会用一份不可信的汇率。
pub fn synced_snapshot(data_home: &Path) -> Option<(FxSnapshot, Option<i64>)> {
    let text = std::fs::read_to_string(state_path(data_home, SYNCED_FILE)).ok()?;
    let root: Value = serde_json::from_str(&text).ok()?;
    let snapshot = FxSnapshot::parse(&text).ok()?;
    let baseline = FxPolicy::bundled().ok()?.snapshot().clone();
    // 读取时不再卡「未来」（时钟可能被调回）：只要不早于内置且不离谱即可。
    snapshot.validate_update(&baseline, "9999-12-31").ok()?;
    Some((snapshot, root.get("fetched_at_ms").and_then(Value::as_i64)))
}

/// 保存联网拿到的快照（调用方已按固定公开地址取回字节）。`today` 为 `YYYY-MM-DD`、`fetched_at_ms` 为取回时刻。
/// 校验失败返回 Err，**不动**当前正在用的汇率；通过后原子写入。基线 = 已有的更新快照，其次是内置快照，
/// 所以一份比已同步的更旧的文件也会被拒。
pub fn save_synced(data_home: &Path, bytes: &[u8], today: &str, fetched_at_ms: i64) -> Result<FxSnapshot, String> {
    if bytes.len() > 256 * 1024 { return Err("fx update exceeds the 256 KiB limit".into()); }
    let text = std::str::from_utf8(bytes).map_err(|_| "fx update is not UTF-8".to_string())?;
    let candidate = FxSnapshot::parse(text)?;
    let bundled = FxPolicy::bundled()?.snapshot().clone();
    let baseline = synced_snapshot(data_home).map(|(s, _)| s).filter(|s| s.rate_date >= bundled.rate_date).unwrap_or(bundled);
    candidate.validate_update(&baseline, today)?;
    let mut root: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    root["fetched_at_ms"] = json!(fetched_at_ms);
    write_atomic(&state_path(data_home, SYNCED_FILE), &root)?;
    Ok(candidate)
}

/// 当前生效的参考快照：已同步的更新快照（更新或同日）优先，否则内置。返回 (快照, 是否来自同步, 取回时刻)。
pub fn effective_snapshot(data_home: &Path) -> (FxSnapshot, bool, Option<i64>) {
    let bundled = FxPolicy::bundled().expect("bundled FX snapshot is validated by tests").snapshot().clone();
    match synced_snapshot(data_home) {
        Some((synced, fetched)) if synced.rate_date >= bundled.rate_date => (synced, true, fetched),
        _ => (bundled, false, None),
    }
}

/// 生效的汇率策略：参考快照（同步的或内置的）+ 用户手动汇率（坏条目被丢弃而不是让整个策略失败）。
pub fn policy(data_home: &Path) -> FxPolicy {
    let mut policy = FxPolicy::from_snapshot(effective_snapshot(data_home).0);
    for rate in manual_rates(data_home).unwrap_or_default() {
        if let Ok(next) = policy.clone().with_user_rate(rate) { policy = next; }
    }
    policy
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("av-fx-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn reporting_currency_defaults_by_region_and_can_be_overridden_then_reset() {
        let h = home("currency");
        assert_eq!(reporting_currency(&h, "en_US").unwrap(), ("USD".into(), true));
        assert_eq!(reporting_currency(&h, "zh_CN").unwrap(), ("CNY".into(), true));
        assert_eq!(reporting_currency(&h, "fr_FR").unwrap(), ("USD".into(), true), "其他一律 USD");
        assert_eq!(save_reporting_currency(&h, "eur").unwrap(), "EUR");
        assert_eq!(reporting_currency(&h, "zh_CN").unwrap(), ("EUR".into(), false), "显式选择优先于区域");
        assert!(save_reporting_currency(&h, "XXX").is_err(), "没有汇率的币种不能当报告币种");
        assert_eq!(save_reporting_currency(&h, DEFAULT_SENTINEL).unwrap(), DEFAULT_SENTINEL);
        assert_eq!(reporting_currency(&h, "zh_CN").unwrap(), ("CNY".into(), true), "选默认 = 删文件，随区域走");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn a_corrupt_manual_rates_file_is_set_aside_and_the_user_can_save_again() {
        let h = home("corrupt");
        std::fs::create_dir_all(h.join("state")).unwrap();
        let path = h.join("state").join(MANUAL_RATES_FILE);
        std::fs::write(&path, "{garbage").unwrap();
        assert!(manual_rates(&h).unwrap().is_empty(), "损坏文件当作没有，而不是一直报错");
        assert!(path.with_extension("json.bad").exists(), "坏文件留作证据");
        save_manual_rate(&h, UserRate { from: "USD".into(), to: "CNY".into(), rate: 6.8, as_of: None }).unwrap();
        assert_eq!(manual_rates(&h).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn rows_that_cannot_be_read_are_backed_up_before_the_file_is_rewritten() {
        let h = home("lossy");
        std::fs::create_dir_all(h.join("state")).unwrap();
        let path = h.join("state").join(MANUAL_RATES_FILE);
        std::fs::write(&path, r#"{"rates":[{"from":"USD","to":"CNY","rate":"7.1"},{"from":"EUR","to":"JPY","rate":160.0}]}"#).unwrap();
        save_manual_rate(&h, UserRate { from: "GBP".into(), to: "USD".into(), rate: 1.3, as_of: None }).unwrap();
        let backup = std::fs::read_to_string(path.with_extension("json.bak")).unwrap();
        assert!(backup.contains("\"7.1\""), "读不懂的行（字符串汇率）没有被静默丢掉：{backup}");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn the_default_sentinel_is_forgiving_about_case_and_spaces() {
        let h = home("sentinel");
        save_reporting_currency(&h, "EUR").unwrap();
        assert_eq!(save_reporting_currency(&h, " Default ").unwrap(), DEFAULT_SENTINEL);
        assert_eq!(reporting_currency(&h, "en_US").unwrap(), ("USD".into(), true));
        let _ = std::fs::remove_dir_all(&h);
    }

    fn doc(date: &str, cny: &str) -> String {
        let bundled = FxPolicy::bundled().unwrap();
        let mut rates = serde_json::Map::new();
        for (currency, rate) in &bundled.snapshot().rates_per_usd {
            let text = if currency == "CNY" { cny.to_string() } else { rate.to_string() };
            rates.insert(currency.clone(), json!({ "rate": text }));
        }
        json!({ "base": "USD", "rate_date": date, "captured_at": "x", "rates": rates }).to_string()
    }

    #[test]
    fn a_synced_snapshot_replaces_the_bundled_one_only_when_valid_and_never_goes_backwards() {
        let h = home("synced");
        let bundled_date = FxPolicy::bundled().unwrap().snapshot().rate_date.clone();
        assert!(!effective_snapshot(&h).1, "no synced file => bundled");
        // 合法的更新（更新日期、CNY 6.9）→ 生效，且被策略使用
        save_synced(&h, doc("2026-10-02", "6.9").as_bytes(), "2026-10-02", 1_000).unwrap();
        let (snapshot, synced, fetched) = effective_snapshot(&h);
        assert!(synced && snapshot.rate_date == "2026-10-02" && fetched == Some(1_000));
        assert_eq!(policy(&h).convert(1.0, "USD", "CNY").unwrap().rate, 6.9);
        // 比已同步更旧 → 拒绝，当前汇率不变
        assert!(save_synced(&h, doc("2026-10-01", "6.7").as_bytes(), "2026-10-02", 2_000).is_err());
        assert_eq!(policy(&h).convert(1.0, "USD", "CNY").unwrap().rate, 6.9);
        // 离谱的值（+40%）→ 整份拒绝
        assert!(save_synced(&h, doc("2026-10-02", "9.8").as_bytes(), "2026-10-02", 3_000).is_err());
        // 未来日期 → 拒绝
        assert!(save_synced(&h, doc("2099-01-01", "6.9").as_bytes(), "2026-10-02", 3_000).is_err());
        // 垃圾 / 超大
        assert!(save_synced(&h, b"not json", "2026-10-02", 1).is_err());
        assert!(save_synced(&h, &vec![b' '; 300 * 1024], "2026-10-02", 1).is_err());
        assert!(!bundled_date.is_empty());
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn the_published_fx_sync_file_is_accepted_by_the_app_validator() {
        // CI 能发布的文件，app 一定收得下——否则用户每天拉到的都是被拒收的汇率，等于没同步。
        let h = home("published");
        let bytes = include_bytes!("../../../../assets/fx-sync.json");
        let bundled = FxPolicy::bundled().unwrap().snapshot().clone();
        let candidate = FxSnapshot::parse(std::str::from_utf8(bytes).unwrap()).unwrap();
        assert!(candidate.rate_date >= bundled.rate_date, "published file must not be older than the bundled snapshot");
        save_synced(&h, bytes, "9999-12-31", 1).expect("published fx-sync.json must pass save_synced");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn a_corrupt_or_stale_synced_file_falls_back_to_the_bundled_snapshot() {
        let h = home("synced-bad");
        std::fs::create_dir_all(h.join("state")).unwrap();
        std::fs::write(h.join("state").join(SYNCED_FILE), "{garbage").unwrap();
        assert!(!effective_snapshot(&h).1);
        // 早于内置快照（内置随版本更新后同步文件落后）→ 忽略
        std::fs::write(h.join("state").join(SYNCED_FILE), doc("2020-01-01", "6.7")).unwrap();
        assert!(!effective_snapshot(&h).1);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn a_saved_currency_missing_from_the_snapshot_falls_back_instead_of_breaking() {
        let h = home("stale");
        std::fs::create_dir_all(h.join("state")).unwrap();
        std::fs::write(h.join("state").join(CURRENCY_FILE), r#"{"currency":"ZZZ"}"#).unwrap();
        assert_eq!(reporting_currency(&h, "en_US").unwrap(), ("USD".into(), true));
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn manual_rates_round_trip_replace_the_same_pair_and_feed_the_policy() {
        let h = home("manual");
        assert!(manual_rates(&h).unwrap().is_empty());
        save_manual_rate(&h, UserRate { from: "usd".into(), to: "cny".into(), rate: 6.8, as_of: Some("2026-09-01".into()) }).unwrap();
        // 同一币对（含反向）再存 = 覆盖，不并存
        save_manual_rate(&h, UserRate { from: "CNY".into(), to: "USD".into(), rate: 0.15, as_of: None }).unwrap();
        let rates = manual_rates(&h).unwrap();
        assert_eq!(rates.len(), 1);
        assert_eq!((rates[0].from.as_str(), rates[0].to.as_str()), ("CNY", "USD"));
        let c = policy(&h).convert(100.0, "CNY", "USD").unwrap();
        assert_eq!((c.rate, c.rate_source), (0.15, agent_vitals_domain::fx::RateSource::UserAssumption));
        assert!(save_manual_rate(&h, UserRate { from: "USD".into(), to: "CNY".into(), rate: 0.0, as_of: None }).is_err());
        remove_manual_rate(&h, "USD", "CNY").unwrap();
        assert!(manual_rates(&h).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&h);
    }
}
