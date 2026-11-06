//! 预算告警的 **I/O + 渲染侧**（CLI `budget show`）。
//!
//! 决策段在 core（`agent_vitals_domain::budget::evaluate_alert`），本模块只做：
//! 读 SQL 预算配置、北京日期/now 生成、文本与 JSON 渲染。与 `cost.rs` 同款边界 —— 计算本体
//! 单一真相源在 core，这里不重写任何算术（连 7 日均、自适应 floor 都在 core）。
//!
//! 逐字节一致性由 `tests/test_cli_matrix.py::CliMatrix` 的
//! `budget show` / `budget show --json` / `budget show --month M [--json]`
//! 差分钉住：Python 与 Rust 在同一夹具 HOME 下跑同一条命令，stdout 逐字节相等。
//!
//! R1b 只实现只读路径（show）；`set`/`enable`/`disable`/`snooze`/`unsnooze`
//! 是写路径，随 R1c 的 Rust 状态写链落地（那时 Python 写链退休，R1d）。

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::clock::{current_month_beijing, today_beijing};
#[cfg(test)]
use crate::home::data_home;

/// `config.toml` 位置，库根显式传入（Tier B 预算卡参数化：Tauri
/// `read_overview_at(dh)` 组装入口不走进程 `AGENT_VITALS_HOME`）。生产路径
/// 的调用方各自传 `data_home()`。
fn config_path_at(dh: &Path) -> PathBuf {
    dh.join("config.toml")
}

const BUDGET_ORIGIN_FILE: &str = "budget-origin.json";

/// 双预算的金额口径选择。
///
/// - `estimate`（观察预算，总览预算卡读它）= 「按量费用」三级口径（账单 > 归因估算 >
///   默认估算，`data_contract::metered_view` 的同一条取代规则）——2026-09-17 之前只
///   读 `MeteredEstimate`，归因把估算搬进 `MeteredDeclared` 后卡片直接归零，用户看到
///   「¥0 / ¥500」以为没消耗。
/// - `confirmed`（已确认支出预算）只看真实按量/执行环境账单。
///
/// 固定订阅和 API 等价值都不在这里——订阅月费按天摊进
/// [`budget_profiles_status_sql_at`] 的 `subscription_*` 字段，与按量分开报。
pub fn budget_profile_spent_minor<'a, I>(
    amounts: I,
    profile_id: &str,
    currency: &str,
) -> i64
where
    I: IntoIterator<Item = &'a agent_vitals_data::projection::HarnessAmount>,
{
    use agent_vitals_data::projection::BillingBasis;
    let mut total = 0.0f64;
    for amount in amounts.into_iter().filter(|a| a.currency.as_deref() == Some(currency)) {
        let get = |b: BillingBasis| amount.amounts_by_basis.get(&b).copied().unwrap_or(0.0);
        let actual = get(BillingBasis::MeteredActual) + get(BillingBasis::HarnessBilled);
        total += match profile_id {
            // 同 provider 内账单取代估算，与 metered_view 一致。
            "estimate" => if actual > 0.0 { actual } else { get(BillingBasis::MeteredDeclared) + get(BillingBasis::MeteredEstimate) },
            "confirmed" => actual,
            _ => return 0,
        };
    }
    agent_vitals_domain::util::pyround(total * 100.0, 0) as i64
}

/// 预算币种之外仍有可计入口径的金额时，已知金额只是下界，不能报安全。
fn budget_profile_has_unconverted<'a, I>(amounts: I, profile_id: &str, currency: &str) -> bool
where
    I: IntoIterator<Item = &'a agent_vitals_data::projection::HarnessAmount>,
{
    use agent_vitals_data::projection::BillingBasis;
    amounts.into_iter().any(|amount| {
        if amount.currency.as_deref() == Some(currency) { return false; }
        let get = |b: BillingBasis| amount.amounts_by_basis.get(&b).copied().unwrap_or(0.0);
        let actual = get(BillingBasis::MeteredActual) + get(BillingBasis::HarnessBilled);
        (match profile_id {
            "estimate" => if actual > 0.0 { actual } else { get(BillingBasis::MeteredDeclared) + get(BillingBasis::MeteredEstimate) },
            "confirmed" => actual,
            _ => 0.0,
        }) > 0.0
    })
}

/// 订阅月费在 `currency` 口径下的合计（分）：仅同币相加。
/// 异币跳过并计入 `skipped`；不能用当前汇率重新计算历史预算消耗。
pub fn subscription_fees_minor<'a, I>(
    amounts: I,
    currency: &str,
    _pricing: &serde_json::Value,
) -> (i64, bool, Vec<String>)
where
    I: IntoIterator<Item = &'a agent_vitals_data::projection::HarnessAmount>,
{
    use agent_vitals_data::projection::BillingBasis;
    let mut total = 0.0f64;
    let mut skipped = Vec::new();
    for amount in amounts {
        let Some(fee) = amount.amounts_by_basis.get(&BillingBasis::FixedSubscription).copied() else { continue };
        if fee <= 0.0 { continue; }
        let Some(cur) = amount.currency.as_deref() else { skipped.push(amount.harness_id.clone()); continue };
        if cur == currency {
            total += fee;
        } else {
            skipped.push(amount.harness_id.clone());
        }
    }
    (agent_vitals_domain::util::pyround(total * 100.0, 0) as i64, false, skipped)
}

/// 跨币订阅月费折成预算币种（汇率 V2，参见 `domain/fx.rs`）。
///
/// 只折「同币相加之外」的订阅：每笔经 [`agent_vitals_domain::fx::FxPolicy::convert`]，
/// 汇率缺失 / 币种未知 → 仍记入 `still_skipped`（预算继续报部分覆盖，不用默认常量顶）。
/// 返回 (折算后的分, 每笔折算的出处, 仍未折算的执行环境)。折算值永远是约数——调用方必须把
/// 出处写进预算 JSON 并在界面标 ≈；折算部分**不触发支出警报**（只提示）。
pub fn subscription_fees_converted<'a, I>(
    amounts: I,
    currency: &str,
    policy: &agent_vitals_domain::fx::FxPolicy,
) -> (i64, Vec<Value>, Vec<String>)
where
    I: IntoIterator<Item = &'a agent_vitals_data::projection::HarnessAmount>,
{
    use agent_vitals_data::projection::BillingBasis;
    use agent_vitals_domain::fx::RateSource;
    let mut total = 0.0f64;
    let mut notes = Vec::new();
    let mut skipped = Vec::new();
    for amount in amounts {
        let Some(fee) = amount.amounts_by_basis.get(&BillingBasis::FixedSubscription).copied() else { continue };
        if fee <= 0.0 { continue; }
        let Some(cur) = amount.currency.as_deref() else { skipped.push(amount.harness_id.clone()); continue };
        if cur == currency { continue; } // 同币已由 subscription_fees_minor 计入
        match policy.convert(fee, cur, currency) {
            Some(c) => {
                total += c.target_amount;
                notes.push(json!({
                    "harness": amount.harness_id,
                    "from": c.source_currency,
                    "source_amount_minor": agent_vitals_domain::util::pyround(fee * 100.0, 0) as i64,
                    "rate": c.rate,
                    "rate_source": match c.rate_source { RateSource::BundledSnapshot => "bundled_snapshot", RateSource::UserAssumption => "user_assumption", RateSource::Identity => "identity" },
                    "rate_date": c.rate_date,
                }));
            }
            None => skipped.push(amount.harness_id.clone()),
        }
    }
    (agent_vitals_domain::util::pyround(total * 100.0, 0) as i64, notes, skipped)
}

/// 当月天数 / 今天是第几天（北京日期）——订阅月费按天摊派用。
fn month_day_progress(today: &str) -> (i64, i64) {
    let y: i64 = today.get(0..4).and_then(|v| v.parse().ok()).unwrap_or(1970);
    let m: i64 = today.get(5..7).and_then(|v| v.parse().ok()).unwrap_or(1);
    let d: i64 = today.get(8..10).and_then(|v| v.parse().ok()).unwrap_or(1);
    let days_in_month = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 29 } else { 28 },
    };
    (days_in_month, d.clamp(1, days_in_month))
}

pub fn budget_profile_has_unresolved<'a, I>(
    amounts: I,
    profile_id: &str,
    currency: &str,
) -> bool
where
    I: IntoIterator<Item = &'a agent_vitals_data::projection::HarnessAmount>,
{
    let relevant = match profile_id {
        "estimate" => &[
            agent_vitals_data::projection::BillingBasis::MeteredEstimate,
            agent_vitals_data::projection::BillingBasis::MeteredDeclared,
        ][..],
        "confirmed" => &[
            agent_vitals_data::projection::BillingBasis::MeteredActual,
            agent_vitals_data::projection::BillingBasis::HarnessBilled,
        ][..],
        _ => return false,
    };
    amounts.into_iter().any(|amount| {
        amount.currency.as_deref() == Some(currency)
            && amount.has_unresolved
            && amount.amounts_by_basis.keys().any(|basis| relevant.contains(basis))
    })
}

/// 读取双预算 profile 的统一状态 DTO。金额按 profile 的币种和口径独立计算，
/// 不做汇率折算；覆盖/新鲜度沿用同一份月度摘要，供桌面、CLI、MCP 对拍。
pub fn budget_profiles_status_sql_at(data_home: &Path, month: &str) -> Option<Value> {
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(data_home),
        crate::clock::now_ms(),
    ).ok()?;
    let profiles = db.budget_profiles_get().ok()?;
    let summary = {
        use agent_vitals_data::repository::SummaryRepository;
        crate::summary::SqlSummaryRepository::at(data_home).monthly_summary(
            &agent_vitals_data::repository::MonthlySummaryQuery { month: month.to_string() },
        )
    };
    let daily = {
        use agent_vitals_data::repository::SummaryRepository;
        crate::summary::SqlSummaryRepository::at(data_home).daily_summary(
            &agent_vitals_data::repository::DailySummaryQuery {
                date: crate::clock::today_beijing(),
            },
        )
    };
    budget_profiles_status_from_parts(data_home, month, profiles, &summary, &daily)
}

/// [`budget_profiles_status_sql_at`] 的纯计算部分（REFRESH_STORM R2-F3 拆分）：
/// profiles / summary / daily 由调用方供。桌面 assembly 路径复用本段已算好的
/// memoized monthly 与 shared_daily——此前 sql_at 在 assembly 里第二次全量现算
/// 一整份 monthly + daily（月窗 SQL × ~11 条 ×2），是 assembly 段最大的单点
/// 重复计算；CLI / MCP / 独立调用仍走 sql_at 的全量现算。两条路输出**逐字节
/// 等价**（tests `budget_profiles_from_parts_matches_sql_at` 钉住）。
pub fn budget_profiles_status_from_parts(
    data_home: &Path,
    month: &str,
    profiles: Vec<agent_vitals_data::authority::BudgetProfile>,
    summary: &agent_vitals_data::projection::MonthlySummary,
    daily: &agent_vitals_data::projection::DailySummary,
) -> Option<Value> {
    let values = summary.by_provider.values().collect::<Vec<_>>();
    let daily_values = daily.by_provider.values().collect::<Vec<_>>();
    // 订阅月费按天摊进观察预算（2026-09-17 产品定向：预算消耗 = 订阅 + 按量的总体，
    // 否则只有订阅、没有按量的用户预算卡永远 ¥0，看不到自己的消耗）。摊派 =
    // 月费 × 已过天数 / 当月天数；只进 `estimate` 口径，`confirmed` 仍只认账单。
    let pricing = crate::price_overrides::merged_main(data_home);
    let today = crate::clock::today_beijing();
    let (days_in_month, day_of_month) = month_day_progress(&today);
    let is_current_month = today.starts_with(month);
    let fx_policy = crate::core::fx_settings::policy(data_home);
    let elapsed_days = if is_current_month { day_of_month } else { days_in_month };
    let rows = profiles.into_iter().map(|profile| {
        let spent_minor = budget_profile_spent_minor(
            values.iter().copied(), &profile.profile_id, &profile.currency,
        );
        let (same_currency_minor, _, skipped_other_currency) =
            subscription_fees_minor(values.iter().copied(), &profile.currency, &pricing);
        // 汇率 V2：只对**当月**折算其他币种订阅（历史月不用今天的快照改写——封账冻结尚未实现，
        // 宁可保持「未覆盖」也不静默改写旧账）。折不了的（缺汇率/未知币种）仍记入 skipped。
        let (converted_minor, subscription_fx, subscription_skipped) = if is_current_month && !skipped_other_currency.is_empty() {
            subscription_fees_converted(values.iter().copied(), &profile.currency, &fx_policy)
        } else {
            (0, Vec::new(), skipped_other_currency)
        };
        let subscription_fx_applied = converted_minor > 0;
        let subscription_minor = same_currency_minor + converted_minor;
        let amortize = profile.profile_id == "estimate" && subscription_minor > 0;
        let subscription_amortized_minor = if amortize {
            subscription_minor * elapsed_days / days_in_month
        } else { 0 };
        let subscription_daily_minor = if amortize { subscription_minor / days_in_month } else { 0 };
        let total_spent_minor = spent_minor + subscription_amortized_minor;
        // 告警口径：不含折算部分（折算是约数，只提示、不触发支出警报；规格 §6.1）。
        let same_amortized_minor = if amortize { same_currency_minor * elapsed_days / days_in_month } else { 0 };
        let same_daily_minor = if amortize { same_currency_minor / days_in_month } else { 0 };
        let daily_spent_minor = budget_profile_spent_minor(
            daily_values.iter().copied(), &profile.profile_id, &profile.currency,
        );
        let subscription_incomplete = profile.profile_id == "estimate" && !subscription_skipped.is_empty();
        let has_unresolved = subscription_incomplete || budget_profile_has_unconverted(
            values.iter().copied(), &profile.profile_id, &profile.currency,
        ) || budget_profile_has_unresolved(
            values.iter().copied(), &profile.profile_id, &profile.currency,
        );
        let daily_has_unresolved = subscription_incomplete || budget_profile_has_unconverted(
            daily_values.iter().copied(), &profile.profile_id, &profile.currency,
        ) || budget_profile_has_unresolved(
            daily_values.iter().copied(), &profile.profile_id, &profile.currency,
        );
        let daily_total_minor = daily_spent_minor + subscription_daily_minor;
        let ratio_bp = (!has_unresolved && total_spent_minor > 0)
            .then(|| total_spent_minor * 10_000 / profile.monthly_minor);
        let alert_total_minor = spent_minor + same_amortized_minor;
        let alert_ratio_bp = (!has_unresolved && alert_total_minor > 0)
            .then(|| alert_total_minor * 10_000 / profile.monthly_minor);
        let daily_alert_total_minor = daily_spent_minor + same_daily_minor;
        let daily_alert_ratio_bp = profile.daily_minor.and_then(|limit| {
            (!daily_has_unresolved && daily_alert_total_minor > 0).then(|| daily_alert_total_minor * 10_000 / limit)
        });
        let daily_ratio_bp = profile.daily_minor.and_then(|limit| {
            (!daily_has_unresolved && daily_total_minor > 0)
                .then(|| daily_total_minor * 10_000 / limit)
        });
        let level = match (has_unresolved, ratio_bp) {
            (true, _) => "incomplete",
            (false, Some(r)) if r >= 10_000 => "exceeded",
            (false, Some(r)) if r >= profile.warning_ratio_bp => "warn",
            (false, Some(_)) => "ok",
            (false, None) => "no_data",
        };
        let daily_level = match (daily_has_unresolved, daily_ratio_bp) {
            (true, _) => "incomplete",
            (false, Some(r)) if r >= 10_000 => "exceeded",
            (false, Some(r)) if r >= profile.warning_ratio_bp => "warn",
            (false, Some(_)) => "ok",
            (false, None) if profile.daily_minor.is_some() => "no_data",
            (false, None) => "disabled",
        };
        json!({
            "profile_id": profile.profile_id,
            "currency": profile.currency,
            "monthly_minor": profile.monthly_minor,
            "daily_minor": profile.daily_minor,
            "warning_ratio_bp": profile.warning_ratio_bp,
            "updated_at_ms": profile.updated_at_ms,
            // 按量部分（三级口径）；`total_spent_minor` = 按量 + 订阅摊派，ratio 按它算。
            "spent_minor": spent_minor,
            "metered_spent_minor": spent_minor,
            "subscription_minor": subscription_minor,
            "subscription_amortized_minor": subscription_amortized_minor,
            "subscription_days_elapsed": if amortize { elapsed_days } else { 0 },
            "days_in_month": days_in_month,
            "subscription_fx_applied": subscription_fx_applied,
            "subscription_converted_minor": converted_minor,
            "subscription_fx": subscription_fx,
            "alert_ratio_bp": alert_ratio_bp,
            "daily_alert_ratio_bp": daily_alert_ratio_bp,
            "subscription_skipped": subscription_skipped,
            "total_spent_minor": total_spent_minor,
            "ratio_bp": ratio_bp,
            "level": level,
            "has_unresolved": has_unresolved,
            "daily_spent_minor": daily_spent_minor,
            "daily_subscription_minor": subscription_daily_minor,
            "daily_total_minor": daily_total_minor,
            "daily_ratio_bp": daily_ratio_bp,
            "daily_level": daily_level,
            "daily_has_unresolved": daily_has_unresolved,
        })
    }).collect::<Vec<_>>();
    Some(json!({
        "status": "ok", "month": month, "profiles": rows,
        "coverage": summary.coverage.to_json(),
        "freshness": summary.freshness.to_json(),
    }))
}

/// 预算金额的来源是展示证据，不参与算术或计费。旧版 seed 成功时记录
/// `legacy_import`；用户后来显式保存则覆盖为 `user`。缺失表示历史版本没有
/// 留下来源，消费方必须显示未知而非猜测。
pub fn budget_config_origin(data_home: &Path) -> Option<String> {
    let path = data_home.join("state").join(BUDGET_ORIGIN_FILE);
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("origin")
        .and_then(Value::as_str)
        .map(String::from)
}

pub fn mark_budget_config_user_owned(data_home: &Path) -> Result<(), String> {
    write_budget_config_origin(data_home, "user")
}

fn write_budget_config_origin(data_home: &Path, origin: &str) -> Result<(), String> {
    let dir = data_home.join("state");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(BUDGET_ORIGIN_FILE);
    let temporary = dir.join("budget-origin.json.tmp");
    let content = serde_json::to_vec(&json!({ "origin": origin }))
        .map_err(|error| error.to_string())?;
    std::fs::write(&temporary, content).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 复刻 Python `str()` 对 bool/int/float/str 的渲染 —— `budget show` 的文本
/// 输出要逐字节一致。
///
/// serde_json 的 `Number` Display 走 ryu（最短可往返表示），与 Python 的
/// `str(float)` / `str(int)` 同算法：`30` 整数给 "30"、`30.0` 浮点给 "30.0"。
/// Bool 需要 Python 风格的大写 `True`/`False`。
fn py_str(v: &Value) -> String {
    match v {
        Value::Bool(b) => {
            if *b {
                "True".to_string()
            } else {
                "False".to_string()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => v.to_string(),
    }
}

/// 复刻 `budget.py::_parse_scalar`：`'30.0'` → 30.0、`'true'` → True、
/// `'"foo"'` → 'foo'。
///
/// int/float 类型原样保留（`30` 整数、`30.0` 浮点）—— `budget show` 文本输出
/// 的 `%s` 语义（"30" vs "30.0"）依赖它。已知分叉：Python `int()` 吃 `"1_0"`
/// 这类下划线字面量，Rust `parse::<i64>()` 不吃 → 退回字符串；不在任何夹具里。
fn parse_scalar(text: &str) -> Value {
    let s = text.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        return Value::String(s[1..s.len() - 1].to_string());
    }
    match s {
        "true" => return json!(true),
        "false" => return json!(false),
        _ => {}
    }
    if s.contains('.') {
        if let Ok(v) = s.parse::<f64>() {
            return json!(v);
        }
    } else if let Ok(v) = s.parse::<i64>() {
        return json!(v);
    }
    Value::String(s.to_string())
}

/// 读 config.toml 的 `[budget]` 节并与默认值深合并 —— 镜像
/// `budget.py::load_config`（极简 TOML 解析，不引 toml 依赖；merge 段在 core
/// `merged_config`）。缺文件 / 缺节 / 缺字段一律走默认 —— 配置缺失降级而非
/// 崩溃，与「harness 能力缺失时不臆造」同一纪律。
#[cfg(test)]
fn load_config() -> Value {
    load_config_at(&data_home())
}

/// `load_config` 的参数化体：库根显式传入。
fn load_config_at(dh: &Path) -> Value {
    let defaults = agent_vitals_domain::budget::default_budget();
    let Ok(text) = std::fs::read_to_string(config_path_at(dh)) else {
        return defaults;
    };
    let mut parsed = Map::new();
    let mut in_budget = false;
    // Python 用 `text.splitlines()`；`util::split_lines` 是它的逐字节镜像
    // （CRLF 算一个终止符、末尾终止符不产空元素）。
    for line in agent_vitals_domain::util::split_lines(&text) {
        let s = line.trim();
        if s.is_empty() || s.starts_with('#') {
            continue;
        }
        if s.starts_with('[') && s.ends_with(']') {
            in_budget = s == "[budget]";
            continue;
        }
        if !in_budget {
            continue;
        }
        // `_TOML_KV_RE = ^\s*([a-z_]+)\s*=\s*(.+?)\s*$` —— key 只认 ASCII
        // 小写 + 下划线；`\s` 是 Unicode 空白（Rust 的 trim 家族同语义）。
        // 先剥行首空白，`trim_start` 只整字符地剥，字节偏移必然是字符边界。
        let rest_of_line = line.trim_start();
        let mut key = String::new();
        for c in rest_of_line.chars() {
            if c.is_ascii_lowercase() || c == '_' {
                key.push(c);
            } else {
                break;
            }
        }
        if key.is_empty() {
            continue;
        }
        let rest = rest_of_line[key.len()..].trim_start(); // key 是 ASCII，字节==字符
        if !rest.starts_with('=') {
            continue;
        }
        let val = rest[1..].trim_start().trim_end();
        if val.is_empty() {
            continue; // `.+?` 至少一个字符
        }
        // Python 的 `if key in cfg` 检查的是「默认值 dict 里的已知 key」，
        // 不是「已解析的 key」—— unknown key 交给 `merged_config` 丢弃（它
        // 只认 default_budget 的 8 个 key），这里一律插入，语义与 Python 相同。
        parsed.insert(key, parse_scalar(val));
    }
    agent_vitals_domain::budget::merged_config(&Value::Object(parsed))
}

/// `budget show` 文本输出 —— 逐字节镜像 `cli.py` 的 show handler（不含
/// `--month`，那走 `render_budget_month`）。
fn render_budget_show(cfg: &Value, alert: &Value) -> String {
    let mut w = String::new();
    let p = |v: &Value| py_str(v);
    w.push_str(&format!("enabled:           {}\n", p(&cfg["enabled"])));
    w.push_str(&format!("daily_cny:         {}\n", p(&cfg["daily_cny"])));
    w.push_str(&format!("weekly_cny:        {}\n", p(&cfg["weekly_cny"])));
    w.push_str(&format!("monthly_cny:       {}\n", p(&cfg["monthly_cny"])));
    w.push_str(&format!(
        "peak_share_max:    {}\n",
        p(&cfg["peak_share_max"])
    ));
    w.push_str(&format!(
        "adaptive_floor:    {}\n",
        p(&cfg["adaptive_floor"])
    ));
    w.push_str(&format!(
        "adaptive_window:   {} days\n",
        p(&cfg["adaptive_window_days"])
    ));
    w.push_str(&format!(
        "adaptive_multiplier: {}\n",
        p(&cfg["adaptive_multiplier"])
    ));
    w.push('\n');
    w.push_str("─── today ───\n");
    w.push_str(&format!(
        "today_cost:        {}\n",
        match alert["today_cost"].clone() {
            Value::Null => "(no data)".to_string(),
            v => format!("¥{:.2}", v.as_f64().unwrap_or(0.0)),
        }
    ));
    let eff = alert["effective_daily_budget"].as_f64().unwrap_or(0.0);
    let floor_applied = alert["adaptive_floor_applied"].clone();
    w.push_str(&format!(
        "effective_daily:   ¥{:.2} (adaptive_floor_applied={})\n",
        eff,
        p(&floor_applied)
    ));
    w.push_str(&format!(
        "ratio:             {}\n",
        match alert["ratio"].clone() {
            Value::Null => "(no data)".to_string(),
            v => format!("{:.1}%", v.as_f64().unwrap_or(0.0) * 100.0),
        }
    ));
    w.push_str(&format!(
        "peak_share:        {}\n",
        match alert["peak_share"].clone() {
            Value::Null => "(no data)".to_string(),
            v => format!("{:.1}%", v.as_f64().unwrap_or(0.0) * 100.0),
        }
    ));
    w.push('\n');
    w.push_str("─── month ───\n");
    w.push_str(&format!(
        "month_cost:        {}\n",
        match alert["month_cost"].clone() {
            Value::Null => "(no data)".to_string(),
            v => format!("¥{:.2}", v.as_f64().unwrap_or(0.0)),
        }
    ));
    w.push_str(&format!(
        "month_ratio:       {}\n",
        match alert["month_ratio"].clone() {
            Value::Null => "(no data)".to_string(),
            v => format!("{:.1}%", v.as_f64().unwrap_or(0.0) * 100.0),
        }
    ));
    w.push('\n');
    w.push_str(&format!(
        "alert level:       {}\n",
        alert["level"].as_str().unwrap_or("")
    ));
    if let Some(snooze) = alert["snoozed_until"].as_str() {
        w.push_str(&format!("snoozed_until:     {snooze}\n"));
    }
    if let Some(reasons) = alert["reasons"].as_array() {
        if !reasons.is_empty() {
            w.push('\n');
            w.push_str("reasons:\n");
            for r in reasons {
                w.push_str(&format!("  • {}\n", r.as_str().unwrap_or("")));
            }
        }
    }
    w
}

/// `budget show --month M` 文本输出 —— 逐字节镜像 `cli.py` 的 month handler。
fn render_budget_month(month: &str, result: Option<&Value>) -> String {
    match result {
        None => format!("(no data for {month})"),
        Some(r) => format!(
            "month:      {month}\ncost:       ¥{:.2} (peak ¥{:.2})",
            r["total"].as_f64().unwrap_or(0.0),
            r["peak_total"].as_f64().unwrap_or(0.0)
        ),
    }
}

/// 指定月的 DSH 成本 `{total, peak_total}` —— Phase 4.3 起读 SQL 权威库
/// （`peaked_days_map("dsh", 月窗)` → core `cost::month_cost`），不再读
/// month.json / month-archive.json。无该月 DSH 事实 → None（不是「花了 0」）。
pub fn month_cost_sql(month: &str) -> Option<Value> {
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(&crate::home::data_home()),
        crate::clock::now_ms(),
    )
    .ok()?;
    let (start, end) = agent_vitals_data::authority_query::beijing_month_bounds_ms(month)?;
    let days =
        agent_vitals_data::authority_query::peaked_days_map(db.conn(), "dsh", start, end).ok()?;
    if days.as_object().is_some_and(|m| m.is_empty()) {
        return None;
    }
    let pricing = crate::price_overrides::merged_main(&crate::home::data_home());
    Some(agent_vitals_domain::cost::month_cost(&days, &pricing))
}

/// SQL 权威库里的预算配置（`budget_config` 单行表；首用时从旧 config.toml
/// 一次性 seed），merge 成 `render_budget_show` 认的 8-key 形状。库打不开 /
/// 无行 → `default_budget`。`evaluate_alert_from_sql` 内部同款推导，这里只是
/// 把它暴露给渲染面（那边不返回 cfg）。
pub fn budget_config_sql(data_home: &Path) -> Value {
    match agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(data_home),
        crate::clock::now_ms(),
    ) {
        Ok(db) => {
            seed_budget_config_from_legacy(data_home, &db);
            match db.budget_config_get().ok().flatten() {
                Some(c) => sql_budget_config_value(&c),
                None => agent_vitals_domain::budget::default_budget(),
            }
        }
        Err(_) => agent_vitals_domain::budget::default_budget(),
    }
}

/// `budget show` —— Phase 4.3 起读 SQL 权威库（`evaluate_alert_from_sql`），
/// 不再读 today.json / month.json / budget.json（spec §5.2 禁读清单）。
/// 输出形状与 legacy 逐 key 相同（`evaluate_alert` 的 dict / `render_budget_
/// show` 的文本），只换数据源。
pub fn budget_show(json_out: bool) {
    let dh = crate::home::data_home();
    let alert = evaluate_alert_from_sql(&dh);
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&alert).unwrap_or_default()
        );
    } else {
        print!("{}", render_budget_show(&budget_config_sql(&dh), &alert));
    }
}

/// `budget show --month M` 主入口：DSH 该月成本，跟阈值/告警无关。
pub fn budget_show_month(month: &str, json_out: bool) {
    let result = month_cost_sql(month);
    if json_out {
        match &result {
            // None 用 Python 的**紧凑**形式（`json.dumps` 无 indent 时 separators
            // 是 `(", ", ": ")`，带空格）；serde_json 的 `to_string` 是无空格紧凑
            // 形式，逐字节不一致 —— 就两个键，手拼。
            None => println!(
                r#"{{"month": {}, "cost": null}}"#,
                serde_json::to_string(month).unwrap_or_default()
            ),
            Some(r) => println!(
                "{}",
                serde_json::to_string_pretty(&json!({"month": month, "cost": r}))
                    .unwrap_or_default()
            ),
        }
    } else {
        print!("{}", render_budget_month(month, result.as_ref()));
    }
}

// ────────────────── v0.9.1 Phase 3.4：budget_status_sql ──────────────────
// 预算/告警从 `budget_config` + `usage_facts` 聚合计算（spec §7 Phase 3）。
// 与上面的 `budget_show`（Python 差分看守的 legacy 链）是**并行新面**：
// 配置源自权威库 `budget_config` 单行表（首次使用时从旧 config.toml 一次性
// seed），支出源自 `SqlSummaryRepository::monthly_summary` 的 by_provider
// CNY 列——但**只取按量档**（`MeteredActual + HarnessBilled`），排除
// `FixedSubscription`。**判断全部 minor 整数比较**（纪律 2「金额不落浮点」
// ——pyround 一次之后不再回浮点）。
//
// 口径 = **跨执行环境「按量实付」的成本闸门**（PM 决策 2026-09-07）：预算告警
// 的职责是对「越用越多、且用户当下能干预」的花钱设闸门——那就是按量实付。
// 订阅月费月初已付、不因用户行为而变，摊进每 5 分钟刷新的告警分子只会让
// 月初那天数字凭空涨一截然后整月杵着。订阅在完整面板单列「本月订阅
// ¥X（已付）」，不进这条。跨币分栏不相加——USD 按量流由未来 USD 预算行
// 承载。token 是下钻单位不是预算口径（单价非常数，Opus 与 Flash 差数十倍）。

/// 旧配置一次性 seed（Phase 3.4 设计定稿）：`budget_config` 行缺失且旧
/// `config.toml` 存在 → 读 `[budget]` 节映射 seed（monthly_cny/daily_cny/
/// warn_at_ratio×10000→bp），幂等——行存在后不再读旧文件。spec §6.2.4
/// 「today/alert 不迁移」不适用于**配置**：配置是用户输入，不是派生数据。
/// 返回是否执行了 seed（供 CLI 输出提示）。库根显式传入——`budget_status_
/// sql_at` 的组装入口（Tauri 预算卡）不走进程 `AGENT_VITALS_HOME`。
fn seed_budget_config_from_legacy(
    data_home: &Path,
    db: &agent_vitals_data::authority::AuthorityDb,
) -> bool {
    match db.budget_config_get() {
        Ok(Some(_)) => return false, // 已配置，旧文件永远退役
        Ok(None) => {}
        Err(_) => return false,
    }
    // 只有**旧文件真实存在**才 seed——`load_config()` 对缺文件返回默认值
    // （差分链需要），拿默认值当 seed 源会给从未配置过的机器凭空装上
    // ¥600 预算（no_budget 测试抓出的第一版缺陷：defaults ≠ 用户输入）。
    let cfg_path = config_path_at(data_home);
    if !cfg_path.exists() {
        return false;
    }
    // 审查收口（F2）：`load_config()` 的 merged 产物里 monthly_cny/daily_cny
    // 恒有默认值（600/30），「残缺不 seed」的守卫对 merged 永不可达——
    // config.toml 存在但不含 [budget] 节的机器仍会被装上 ¥600。改为看
    // **原始 TOML 文本**里这两个键是否真实出现；键不齐 = 用户没配过预算，
    // 报 no_budget 比替用户编一份诚实。
    let text = std::fs::read_to_string(&cfg_path).unwrap_or_default();
    let mut in_budget = false;
    let mut has_monthly = false;
    let mut has_daily = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_budget = line == "[budget]";
            continue;
        }
        if !in_budget { continue; }
        let key = line.split_once('=').map(|(key, _)| key.trim());
        has_monthly |= key == Some("monthly_cny");
        has_daily |= key == Some("daily_cny");
    }
    if !has_monthly || !has_daily {
        return false;
    }
    let cfg = load_config_at(data_home);
    let monthly = cfg.get("monthly_cny").and_then(Value::as_f64);
    let daily = cfg.get("daily_cny").and_then(Value::as_f64);
    let warn_ratio = cfg.get("warn_at_ratio").and_then(Value::as_f64);
    let (Some(m), Some(d)) = (monthly, daily) else {
        return false; // 防御性（上面 has 门后理论不可达）
    };
    // pyround(×100)：银行家舍入与全仓一致（util::pyround 的同一理由——预算
    // 百分比恰好落在半分点是真实场景）。
    let m_minor = agent_vitals_domain::util::pyround(m * 100.0, 0) as i64;
    let d_minor = agent_vitals_domain::util::pyround(d * 100.0, 0) as i64;
    let bp = agent_vitals_domain::util::pyround(warn_ratio.unwrap_or(0.8) * 10_000.0, 0) as i64;
    let saved = db.budget_config_set(m_minor, d_minor, bp, crate::clock::now_ms())
        .is_ok();
    if saved {
        let _ = write_budget_config_origin(data_home, "legacy_import");
    }
    saved
}

/// ISO 日期时间串 → epoch **毫秒**（snooze 的 `until_ms` 列，`budget_snoozes`
/// 契约单位）。**复用 domain `budget::parse_iso`**（2026-09-07 审查收口：第一版
/// 自制解析只看前 19 字节并一律按北京时间减 8h，对 `Z`/`+08:00` 后缀静默错位
/// 8 小时）。parse_iso 语义已完整：无后缀按**北京挂钟**解释（offset 已内扣）、
/// Z=0、显式 ±HH:MM 原样。**`parse_iso` 返回 epoch 秒**——本函数 ×1000 转毫秒
/// （3.4 首版漏了这一步，CLI `budget-sql snooze-set` 把秒写进 `until_ms` 毫秒
/// 列、读回来一律早于 `now_ms()` → snooze 永远显示已过期；回归测试
/// `iso_to_ms_beijing_returns_milliseconds` 钉住）。
fn iso_to_ms_beijing(s: &str) -> Option<i64> {
    agent_vitals_domain::budget::parse_iso(s).map(|(secs, _)| secs * 1000)
}

/// 预算状态（Phase 3.4）：SQL 权威面。`None` 输出仅当库打不开（诊断走
/// `data status`，这条查询路径不做损坏恢复）。返回 shape 见模块头：
/// `level ∈ no_budget | ok | warn | exceeded`（词表与 legacy 链 ok/warn/over
/// 对齐但 exceeded 用全称——新面自有一份词表，不与差分看守的旧链混）。
pub fn budget_status_sql(month: &str) -> Option<Value> {
    budget_status_sql_at(&crate::home::data_home(), month)
}

/// `budget_status_sql` 的**参数化体**（Tier B 预算卡收尾）：库根显式传入，
/// 不碰进程 `AGENT_VITALS_HOME`。Tauri `read_overview_at(dh)` 组装入口与
/// 临时库单测据此对指定库跑预算判定，无需持 `ENV_LOCK`。失败历史：ZST
/// `SqlSummaryRepository` 只认 `crate::home::data_home()`，组装入口传进来的
/// `dh` 被内部忽略，预算卡永远在真机库上跑（本次会话连续 4 次实现失败的
/// 直接原因）。
pub fn budget_status_sql_at(data_home: &Path, month: &str) -> Option<Value> {
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(data_home),
        crate::clock::now_ms(),
    )
    .ok()?;
    seed_budget_config_from_legacy(data_home, &db);
    let cfg = db.budget_config_get().ok().flatten();

    let summary = {
        use agent_vitals_data::repository::SummaryRepository;
        crate::summary::SqlSummaryRepository::at(data_home).monthly_summary(
            &agent_vitals_data::repository::MonthlySummaryQuery {
                month: month.to_string(),
            },
        )
    };
    // 预算 = **跨执行环境「按量实付」的成本闸门**（PM 决策 2026-09-07，见
    // docs/AGENT_VITALS_V0_9_1_IMPLEMENTATION_PLAN.md「预算口径」）：
    // by_provider 的 CNY 列里取 `MeteredActual + HarnessBilled`——**排除
    // FixedSubscription**。理由：订阅月费月初已付、不因用户当下行为而变，
    // 摊进每 5 分钟刷新的告警分子 = 拿一个拧不动的常数挤占闸门的判断空间
    // （月初那天数字凭空涨一截然后整月杵着）。订阅在完整面板单列一行
    // 「本月订阅 ¥X（已付）」，不进这条。跨币仍分栏不相加——USD 按量流
    // 由未来的 USD 预算行承载，不冒充 CNY 消耗。零条目 → 0（不编造币桶）。
    let metered_cny_f64: f64 = summary
        .by_provider
        .values()
        .filter(|h| h.currency.as_deref() == Some("CNY"))
        .map(|h| {
            h.summable_total()
                - h.amounts_by_basis
                    .get(&agent_vitals_data::projection::BillingBasis::FixedSubscription)
                    .copied()
                    .unwrap_or(0.0)
        })
        .sum();
    let spent_minor = agent_vitals_domain::util::pyround(metered_cny_f64 * 100.0, 0) as i64;

    // snooze：snoozes 行存在且 until_ms > now → 抑制告警输出标记。
    let now_ms = crate::clock::now_ms();
    let snooze_until = db
        .budget_snooze_get()
        .ok()
        .flatten()
        .filter(|&until| until > now_ms);

    let (level, ratio_bp) = match &cfg {
        None => ("no_budget", None),
        Some(c) => {
            if c.monthly_cny_minor <= 0 {
                // 配置了 0/负预算 = 语法上合法但无判断意义，同 no_budget
                // 语义但 config 字段照报（消费方能区分「没配」和「配了 0」）。
                ("no_budget", None)
            } else {
                let r = spent_minor * 10_000 / c.monthly_cny_minor;
                let lvl = if r >= 10_000 {
                    "exceeded"
                } else if r >= c.warning_ratio_bp {
                    "warn"
                } else {
                    "ok"
                };
                (lvl, Some(r))
            }
        }
    };

    Some(json!({
        "month": month,
        "level": level,
        "monthly_cny_minor": cfg.as_ref().map(|c| c.monthly_cny_minor),
        "daily_cny_minor": cfg.as_ref().map(|c| c.daily_cny_minor),
        "warning_ratio_bp": cfg.as_ref().map(|c| c.warning_ratio_bp),
        "metered_cny_minor": spent_minor,
        "ratio_bp": ratio_bp,
        "snoozed_until_ms": snooze_until,
        "coverage": summary.coverage.to_json(),
        "freshness": summary.freshness.to_json(),
        "data_source": "sql_authority",
    }))
}

// ───────────── v0.9.1 Tier B：evaluate_alert 切 SQL（alert / 托盘预算卡） ─────────────

/// SQL `budget_config` → `evaluate_alert` 期待的 config Value（与 config.toml
/// `[budget]` merged 后同形）。3 个核心字段（monthly/daily/warn）来自权威库单
/// 行表；`adaptive_*` / `peak_share_max` / `enabled` 从 `default_budget` 补——
/// 这几项 `budget_config` 表还没有列（db714f0 的 seed 与 spec §3.4 只搬了这 3
/// 个），自定义 `adaptive_multiplier` 的用户暂时走默认，补列是后续项。
fn sql_budget_config_value(c: &agent_vitals_data::authority::BudgetConfig) -> Value {
    agent_vitals_domain::budget::merged_config(&json!({
        "monthly_cny": c.monthly_cny_minor as f64 / 100.0,
        "daily_cny": c.daily_cny_minor as f64 / 100.0,
        "warn_at_ratio": c.warning_ratio_bp as f64 / 10_000.0,
    }))
}

/// epoch ms → ISO UTC 串（`evaluate_alert` 的 snooze 参数按串收，内部
/// `parse_iso` 认显式 `+00:00` 后缀）。镜像 `state::now_iso_utc` 的格式段。
fn ms_to_iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = agent_vitals_domain::util::civil_from_unix_secs(secs, 0);
    let sod = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}+00:00")
}

/// 预算/告警的 **SQL 权威面**（Tier B 收尾）：从
/// SQL 权威库算，不读 `today.json` / `month.json` / `alert.json` / `budget.json`
/// （spec §5.2 禁读清单）。返回形状 = `domain::budget::evaluate_alert` 逐 key
/// 相同（`level`/`ratio`/`month_ratio`/`effective_daily_budget`/`reasons`/
/// `snoozed_until`/`today_cost`/`month_cost`/`monthly_cny`/`peak_over`/
/// `adaptive_floor_applied`），托盘/CLI 直接消费。
///
/// **口径 = 跨执行环境「按量实付」CNY**（PM 决策 2026-09-07）。当前 CNY
/// MeteredActual 的唯一来源是 DSH（deepseek-official / shengsuanyun），与
/// `budget_status_sql` 的 `metered_cny_minor` 同一条 by_provider CNY-summable
/// 边界——claude relay 的 CNY 是 MeteredEstimate（`summable_into_total` 为
/// false）、codex 是 ApiEquivalent、minimax/glm 是 FixedSubscription，都不进
/// 按量预算。第二个 CNY MeteredActual 源出现时这里扩成多执行环境 days 合并（届时
/// 两侧背离即「有新按量源」信号）。
///
/// `month_days` = DSH `peaked_days_map`（当月北京毫秒窗），与 `month.json` 的
/// `days` 同形——直接喂**不改一行**的 `evaluate_alert`（今日 = 该 map 里今天
/// 那条 entry；`today_cost` 对无 `date` 键的 entry 直接按 by_model 计价）。
/// 无配置仍计算可观测成本，但预算字段与比例必须为空、level=no_budget；默认
/// ¥30/¥600 只属于旧 CLI 模板，不能替首次安装用户作出预算声明。
pub fn evaluate_alert_from_sql(data_home: &Path) -> Value {
    let pricing = crate::price_overrides::merged_main(&crate::home::data_home());
    let today_key = today_beijing();
    let now = now_unix();

    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(data_home),
        crate::clock::now_ms(),
    ) else {
        // 库打不开时既没有成本证据也没有预算证据；用默认配置只借用稳定输出
        // shape，随后清空全部预算判断字段。
        let mut alert = agent_vitals_domain::budget::evaluate_alert(
            &agent_vitals_domain::budget::default_budget(),
            None,
            None,
            &pricing,
            &today_key,
            None,
            now,
        );
        clear_unconfigured_budget(&mut alert, "authority_unavailable");
        return alert;
    };
    seed_budget_config_from_legacy(data_home, &db);
    let cfg = db.budget_config_get().ok().flatten().map(|c| sql_budget_config_value(&c));

    let month = current_month_beijing();
    let dsh_days = agent_vitals_data::authority_query::beijing_month_bounds_ms(&month)
        .map(|(s, e)| {
            agent_vitals_data::authority_query::peaked_days_map(db.conn(), "dsh", s, e)
                .unwrap_or_else(|_| json!({}))
        })
        .unwrap_or_else(|| json!({}));
    // 空 map → None（`read_month` 的「缺列 None」语义：None → month_cost None，
    // 空壳 → 0 元，evaluate 里两者不同）。
    let month_days = match dsh_days.as_object() {
        Some(m) if !m.is_empty() => Some(dsh_days.clone()),
        _ => None,
    };
    let today_data = month_days.as_ref().and_then(|m| m.get(&today_key).cloned());

    // snooze：表里存的是 until_ms；过期与否交给 evaluate_alert（它按 now_unix
    // 重判，过期串 → snoozed_until=None）。无行 → None。
    let snooze_iso = db.budget_snooze_get().ok().flatten().map(ms_to_iso_utc);

    let mut alert = agent_vitals_domain::budget::evaluate_alert(
        cfg.as_ref().unwrap_or(&agent_vitals_domain::budget::default_budget()),
        today_data.as_ref(),
        month_days.as_ref(),
        &pricing,
        &today_key,
        snooze_iso.as_deref(),
        now,
    );
    if cfg.is_none() { clear_unconfigured_budget(&mut alert, "budget_not_configured"); }
    alert
}

fn clear_unconfigured_budget(alert: &mut Value, reason: &str) {
    alert["level"] = json!("no_budget");
    for key in ["ratio", "month_ratio", "effective_daily_budget", "monthly_cny",
                "peak_over", "adaptive_floor_applied"] {
        alert[key] = Value::Null;
    }
    alert["reasons"] = json!([reason]);
}

/// snooze 写入口（CLI `budget-sql snooze-set` 用）：解析 ISO 串 → 落库。
/// 解析失败 = `Err(串)`（CLI 报错 exit 2，不猜时区不编默认）。
pub fn budget_snooze_set_sql(until_iso: &str) -> Result<i64, String> {
    let until_ms = iso_to_ms_beijing(until_iso)
        .ok_or_else(|| format!("unparseable --until `{until_iso}` (want YYYY-MM-DDTHH:MM:SS)"))?;
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(&crate::home::data_home()),
        crate::clock::now_ms(),
    )
    .map_err(|e| e.to_string())?;
    let now = crate::clock::now_ms();
    db.budget_snooze_set(until_ms, now)
        .map_err(|e| e.to_string())?;
    Ok(until_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn foreign_currency_subscriptions_convert_with_provenance_and_unknown_currencies_stay_skipped() {
        use agent_vitals_data::projection::{BillingBasis, Freshness, HarnessAmount};
        use agent_vitals_domain::fx::{FxPolicy, UserRate};
        let harness = |id: &str, currency: Option<&str>, fee: f64| {
            let mut by = BTreeMap::new();
            by.insert(BillingBasis::FixedSubscription, fee);
            HarnessAmount { harness_id: id.into(), amounts_by_basis: by, currency: currency.map(String::from), has_unresolved: false,
                evidence_basis: None, pricing_method: None, unresolved_reason: None, freshness: Freshness::unavailable() }
        };
        let amounts = [harness("minimax", Some("CNY"), 162.0), harness("anthropic", Some("USD"), 40.0), harness("odd", Some("XXX"), 9.0), harness("nocur", None, 5.0)];
        // 手动汇率 6.8：USD 40 → CNY 272
        let policy = FxPolicy::bundled().unwrap().with_user_rate(UserRate { from: "USD".into(), to: "CNY".into(), rate: 6.8, as_of: None }).unwrap();
        let (converted, notes, skipped) = subscription_fees_converted(amounts.iter(), "CNY", &policy);
        assert_eq!(converted, 27_200, "USD 40 × 6.8 = CNY 272.00（同币的 162 不在这里计）");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["from"], "USD");
        assert_eq!(notes[0]["rate"], 6.8);
        assert_eq!(notes[0]["rate_source"], "user_assumption");
        assert_eq!(skipped, vec!["odd".to_string(), "nocur".to_string()], "未知币种 / 无币种：不猜，仍未覆盖");
        // 用内置快照时来源标 bundled_snapshot 并带日期
        let bundled = FxPolicy::bundled().unwrap();
        let (_, notes, _) = subscription_fees_converted(amounts.iter(), "CNY", &bundled);
        assert_eq!(notes[0]["rate_source"], "bundled_snapshot");
        assert!(notes[0]["rate_date"].as_str().is_some());
        // 同币种订阅不被重复计入
        let (converted, _, _) = subscription_fees_converted([harness("a", Some("CNY"), 100.0)].iter(), "CNY", &bundled);
        assert_eq!(converted, 0);
    }

    #[test]
    fn budget_profiles_sum_only_matching_currency_and_basis() {
        use agent_vitals_data::projection::{BillingBasis, Freshness, HarnessAmount};
        let mut estimate = BTreeMap::new();
        estimate.insert(BillingBasis::MeteredEstimate, 123.45);
        estimate.insert(BillingBasis::FixedSubscription, 999.0);
        let mut actual = BTreeMap::new();
        actual.insert(BillingBasis::MeteredActual, 200.0);
        actual.insert(BillingBasis::HarnessBilled, 1.5);
        let mut usd = BTreeMap::new();
        usd.insert(BillingBasis::MeteredEstimate, 77.0);
        let mut amounts = [
            HarnessAmount {
                harness_id: "claude-code".into(), amounts_by_basis: estimate,
                currency: Some("CNY".into()), has_unresolved: false,
                evidence_basis: None, pricing_method: None, unresolved_reason: None,
                freshness: Freshness::unavailable(),
            },
            HarnessAmount {
                harness_id: "dsh".into(), amounts_by_basis: actual,
                currency: Some("CNY".into()), has_unresolved: false,
                evidence_basis: None, pricing_method: None, unresolved_reason: None,
                freshness: Freshness::unavailable(),
            },
            HarnessAmount {
                harness_id: "codex".into(), amounts_by_basis: usd,
                currency: Some("USD".into()), has_unresolved: false,
                evidence_basis: None, pricing_method: None, unresolved_reason: None,
                freshness: Freshness::unavailable(),
            },
        ];
        // estimate = 「按量费用」三级口径：claude 的估算 123.45 + dsh 的账单 201.5
        // （账单条目按账单计，不再按估算）；订阅 999 不进；USD 不跨币。
        assert_eq!(budget_profile_spent_minor(&amounts, "estimate", "CNY"), 32_495);
        assert_eq!(budget_profile_spent_minor(&amounts, "confirmed", "CNY"), 20_150);
        assert_eq!(budget_profile_spent_minor(&amounts, "estimate", "USD"), 7_700);
        assert!(budget_profile_has_unconverted(amounts.iter(), "estimate", "CNY"), "USD 按量估算不能被 CNY 预算忽略后仍报安全");
        assert!(!budget_profile_has_unconverted(amounts.iter(), "confirmed", "CNY"), "仅 USD 估算不能影响已确认支出口径");
        // 归因估算（MeteredDeclared）同样进 estimate；同条目有账单时被账单取代。
        amounts[0].amounts_by_basis.insert(BillingBasis::MeteredDeclared, 10.0);
        assert_eq!(budget_profile_spent_minor(&amounts, "estimate", "CNY"), 33_495);
        amounts[0].amounts_by_basis.insert(BillingBasis::MeteredActual, 50.0);
        assert_eq!(budget_profile_spent_minor(&amounts, "estimate", "CNY"), 25_150, "账单取代该条目的两档估算");
        amounts[0].amounts_by_basis.remove(&BillingBasis::MeteredActual);
        amounts[0].amounts_by_basis.remove(&BillingBasis::MeteredDeclared);
        // 订阅月费口径：同币直加；跨币保留为未覆盖，不用当前 FX 改写历史。
        let pricing = agent_vitals_domain::cost::load_pricing();
        let (fees, fx, skipped) = subscription_fees_minor(amounts.iter(), "CNY", &pricing);
        assert_eq!((fees, fx, skipped.len()), (99_900, false, 0));
        amounts[2].amounts_by_basis.insert(BillingBasis::FixedSubscription, 20.0);
        let (fees, fx, skipped) = subscription_fees_minor(amounts.iter(), "CNY", &pricing);
        assert_eq!((fees, fx, skipped), (99_900, false, vec!["codex".to_string()]));
        let mut changed_rate = pricing.clone();
        changed_rate["fx_estimate"]["USD_CNY"] = serde_json::json!(20.0);
        assert_eq!(
            subscription_fees_minor(amounts.iter(), "CNY", &changed_rate),
            (fees, fx, vec!["codex".to_string()]),
            "历史预算订阅分摊不能随当前汇率变化",
        );
        assert_eq!(month_day_progress("2026-09-17"), (30, 17));
        assert_eq!(month_day_progress("2028-02-29"), (29, 29));
        assert!(!budget_profile_has_unresolved(amounts.iter(), "estimate", "CNY"));
        amounts[0].has_unresolved = true;
        assert!(budget_profile_has_unresolved(amounts.iter(), "estimate", "CNY"));
        assert!(!budget_profile_has_unresolved(amounts.iter(), "confirmed", "CNY"));
    }

    /// 环境锁是进程级的（util::ENV_LOCK），不是本模块局部的 —— state 的测试
    /// 也改 AGENT_VITALS_HOME，各自一把锁就互相踩踏（见 util.rs 注释）。
    ///
    /// 把 AGENT_VITALS_HOME 指到夹具根，Drop 时恢复原值。
    ///
    /// `data_home()` 走同一套环境解析（AGENT_VITALS_HOME → …），测试夹具
    /// 用临时根隔离，跑完不污染调用方环境。
    struct TestEnvGuard {
        prev: Option<String>,
    }
    impl TestEnvGuard {
        fn set(home: &Path) -> Self {
            let prev = std::env::var("AGENT_VITALS_HOME").ok();
            std::env::set_var("AGENT_VITALS_HOME", home);
            TestEnvGuard { prev }
        }
    }
    impl Drop for TestEnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(p) => std::env::set_var("AGENT_VITALS_HOME", p),
                None => std::env::remove_var("AGENT_VITALS_HOME"),
            }
        }
    }

    fn tmp_home(t: &std::path::Path) -> PathBuf {
        let home = t.join("home");
        std::fs::create_dir_all(home.join("state")).unwrap();
        home
    }

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// `_parse_scalar` 的类型保留是 `budget show` 文本 `%s` 语义的根：`30` 是
    /// int（"30"）、`30.0` 是 float（"30.0"）、`true` 是 bool（"True"）。
    #[test]
    fn parse_scalar_keeps_types() {
        assert_eq!(parse_scalar("30"), json!(30));
        assert_eq!(parse_scalar("30.0"), json!(30.0));
        assert_eq!(parse_scalar("true"), json!(true));
        assert_eq!(parse_scalar("\"foo\""), json!("foo"));
        assert_eq!(parse_scalar("abc"), json!("abc")); // 解析失败 → 字符串
        assert_eq!(parse_scalar("30."), json!(30.0)); // float("30.") → 30.0
    }

    /// TOML 极简解析只认 `[budget]` 节里已知 key；缺文件走默认。
    #[test]
    fn load_config_mirrors_python() {
        let _env = crate::ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("av-budget-test-{}", std::process::id()));
        let home = tmp_home(&dir);
        let _guard = TestEnvGuard::set(&home);
        write(
            &home.join("config.toml"),
            "[budget]\ndaily_cny = 50\npeak_share_max = 0.6\n",
        );
        let cfg = load_config();
        assert_eq!(cfg["daily_cny"], 50); // int 保留
        assert_eq!(cfg["peak_share_max"], 0.6);
        assert_eq!(cfg["enabled"], true); // 缺字段走默认
        assert_eq!(cfg["monthly_cny"], 600.0);
        // 非 [budget] 节的 key 忽略
        write(&home.join("config.toml"), "[scan]\nmax_depth = 5\n");
        let cfg2 = load_config();
        assert_eq!(cfg2["daily_cny"], 30.0); // 默认回来
        drop(_guard);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文本输出是纯渲染 —— 给一个手工 alert，断言关键行。
    #[test]
    fn render_show_text_matches_shape() {
        let cfg = agent_vitals_domain::budget::default_budget();
        let alert = json!({
            "level": "warn",
            "ratio": 0.85,
            "peak_share": 0.6,
            "peak_over": true,
            "reasons": [
                "today at 85% of daily budget (¥25.50 / ¥30.00)",
                "peak share 60% exceeds max 50%"
            ],
            "snoozed_until": Value::Null,
            "effective_daily_budget": 30.0,
            "monthly_cny": 600.0,
            "month_ratio": 0.2,
            "adaptive_floor_applied": false,
            "today_cost": 25.5,
            "today_peak_cost": 15.3,
            "month_cost": 120.0,
        });
        let text = render_budget_show(&cfg, &alert);
        assert!(text.contains("enabled:           True\n"));
        assert!(text.contains("daily_cny:         30.0\n"));
        assert!(text.contains("adaptive_window:   7 days\n"));
        assert!(text.contains("today_cost:        ¥25.50\n"));
        assert!(text.contains("effective_daily:   ¥30.00 (adaptive_floor_applied=False)\n"));
        assert!(text.contains("ratio:             85.0%\n"));
        assert!(text.contains("peak_share:        60.0%\n"));
        assert!(text.contains("alert level:       warn\n"));
        assert!(text.contains("  • today at 85% of daily budget (¥25.50 / ¥30.00)\n"));
    }

    /// snoozed 状态下的文本：snoozed_until 行 + 无 reasons 段落。
    #[test]
    fn render_show_text_with_snooze() {
        let cfg = agent_vitals_domain::budget::default_budget();
        let alert = json!({
            "level": "snoozed",
            "ratio": 1.2,
            "peak_share": Value::Null,
            "peak_over": false,
            "reasons": ["today at 120% of daily budget (¥36.00 / ¥30.00)"],
            "snoozed_until": "2999-12-31T23:59:59+08:00",
            "effective_daily_budget": 30.0,
            "monthly_cny": 600.0,
            "month_ratio": Value::Null,
            "adaptive_floor_applied": false,
            "today_cost": 36.0,
            "today_peak_cost": 0.0,
            "month_cost": Value::Null,
        });
        let text = render_budget_show(&cfg, &alert);
        assert!(text.contains("snoozed_until:     2999-12-31T23:59:59+08:00\n"));
        assert!(text.contains("alert level:       snoozed\n"));
    }

    /// 紧凑 month-None JSON 必须带空格（Python `json.dumps` 无 indent 的
    /// separators 是 `(", ", ": ")`）—— 与 serde_json 的无空格紧凑形式逐字节
    /// 不同，`budget show --month M --json` 的 None 分支必须手拼这个形状。
    #[test]
    fn month_none_json_is_compact_with_spaces() {
        let _env = crate::ENV_LOCK.lock().unwrap();
        let month = "1999-01";
        let s = format!(
            r#"{{"month": {}, "cost": null}}"#,
            serde_json::to_string(month).unwrap_or_default()
        );
        assert_eq!(s, r#"{"month": "1999-01", "cost": null}"#);
        // 无数据月 → None（`month_cost_sql` 空库直接给 None，不是空壳）
        let dir = std::env::temp_dir().join(format!("av-budget-mn-{}", std::process::id()));
        let home = tmp_home(&dir);
        let _guard = TestEnvGuard::set(&home);
        assert!(month_cost_sql("1999-01").is_none());
        drop(_guard);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Phase 3.4：budget_status_sql ────────────────────────────────────

    /// env guard + ENV_LOCK 的合并持有：TestEnvGuard 改的是进程 env，并发
    /// 测试各拿各的 guard 会互相踩；锁必须**与 guard 同生命周期**——放进
    /// 同一个 RAII 结构（曾试过 `mem::forget(lock)` 把锁永久钉死，整个测试
    /// 进程所有用 env 的测试全部挂起——错误解法留此存照）。guard 必须活到
    /// 断言结束：`AGENT_VITALS_HOME` 是进程级 env，提前 drop 就回到真机
    /// HOME，`budget_status_sql` 会在真机库上跑（第一版红的三连）。
    struct BudgetEnvGuard {
        // **Drop 顺序 = 声明顺序**：`_env` 声明在前 → 先恢复 AGENT_VITALS_
        // HOME，之后才放进程级 ENV_LOCK。反过来的话，并发测试线程会在
        // 「锁已放、env 未恢复」的子窗口抢到锁读到上一个测试的临时 home
        // （审查 F4 的真实竞态）。
        _env: TestEnvGuard,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    /// 每 case 都从一个**保证干净**的权威库开始（`seed_authority_db` 同款
    /// 纪律——with_home 的目录清理是尽力而为，残留库会让 config seed 幂等
    /// 语义失效）。
    fn fresh_budget_env(
        tag: &str,
    ) -> (
        BudgetEnvGuard,
        agent_vitals_data::authority::AuthorityDb,
        String,
    ) {
        let lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("av-budget-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let env = TestEnvGuard::set(&dir);
        let month = crate::clock::current_month_beijing();
        let path = agent_vitals_data::authority::default_authority_path(&crate::home::data_home());
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let db = agent_vitals_data::authority::AuthorityDb::open(&path, 1).unwrap();
        (
            BudgetEnvGuard {
                _env: env,
                _lock: lock,
            },
            db,
            month,
        )
    }

    fn seed_fact_min(
        db: &agent_vitals_data::authority::AuthorityDb,
        fact_id: &str,
        harness: &str,
        model: &str,
        ts_ms: i64,
        u: i64,
        o: i64,
    ) {
        db.conn()
            .execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('run', 1, 'cli', 'succeeded', 1) ON CONFLICT(run_id) DO NOTHING",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                     event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                     output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'm', 's', ?1, 'turn', NULL, ?3, ?4, 0, ?5, 0, 0, ?6, 'run', 1, 1)",
                rusqlite::params![fact_id, harness, model, ts_ms, u, o],
            )
            .unwrap();
    }

    #[test]
    fn budget_status_no_budget_without_config_or_legacy() {
        let (_guard, _db, month) = fresh_budget_env("nobudget");
        let v = budget_status_sql(&month).expect("库可开");
        assert_eq!(v["level"], "no_budget");
        assert_eq!(v["monthly_cny_minor"], Value::Null);
        assert_eq!(v["data_source"], "sql_authority");
    }

    #[test]
    fn legacy_budget_seed_ignores_same_named_keys_outside_budget_section() {
        let (_guard, db, month) = fresh_budget_env("wrong-section");
        std::fs::write(
            crate::home::data_home().join("config.toml"),
            "[other]\nmonthly_cny = 999\ndaily_cny = 99\n",
        ).unwrap();
        let v = budget_status_sql(&month).unwrap();
        assert_eq!(v["level"], "no_budget");
        assert!(db.budget_config_get().unwrap().is_none());
    }

    #[test]
    fn budget_status_seeds_once_from_legacy_config_and_is_idempotent() {
        let (_guard, _db, month) = fresh_budget_env("seed");
        // 旧 config.toml：monthly ¥600.00 / daily ¥30.00 / warn 0.8。
        let cfg = crate::home::data_home().join("config.toml");
        std::fs::write(
            &cfg,
            "[budget]\nmonthly_cny = 600.0\ndaily_cny = 30.0\nwarn_at_ratio = 0.8\n",
        )
        .unwrap();
        // 第一次 status：seed 发生（600.00 → 60000 minor；0.8 → 8000 bp）。
        let v1 = budget_status_sql(&month).unwrap();
        assert_eq!(v1["monthly_cny_minor"], json!(60_000));
        assert_eq!(v1["daily_cny_minor"], json!(3_000));
        assert_eq!(v1["warning_ratio_bp"], json!(8_000));
        assert_eq!(
            budget_config_origin(&crate::home::data_home()).as_deref(),
            Some("legacy_import"),
        );
        // 改旧文件再查：行已存在 → 不再读旧文件（幂等 seed 的语义）。
        std::fs::write(&cfg, "[budget]\nmonthly_cny = 1.0\ndaily_cny = 1.0\n").unwrap();
        let v2 = budget_status_sql(&month).unwrap();
        assert_eq!(v2["monthly_cny_minor"], json!(60_000), "行存在后旧文件退役");
    }

    #[test]
    fn explicit_budget_save_replaces_legacy_origin_marker() {
        let (_guard, _db, _month) = fresh_budget_env("origin-user");
        write_budget_config_origin(&crate::home::data_home(), "legacy_import").unwrap();
        mark_budget_config_user_owned(&crate::home::data_home()).unwrap();
        assert_eq!(budget_config_origin(&crate::home::data_home()).as_deref(), Some("user"));
    }

    #[test]
    fn budget_status_levels_cross_warn_and_exceeded_on_minor_integers() {
        // CNY 按量桶 = DSH（deepseek-official 声明 metered → MeteredActual）。
        // 订阅月费（GLM/MiniMax/anthropic）是 `FixedSubscription` 档，按量
        // 口径切换后**不进预算分子**（PM 决策 2026-09-07）——分子干净等于
        // 事实折算，档位断言仍用「随事实增长跨档」的相对断言。
        let (_guard, db, month) = fresh_budget_env("levels");
        // 预算 ¥600 → dsh MeteredActual ≈ 事实折算（订阅不垫底）。
        let (start, _) =
            agent_vitals_data::authority_query::beijing_month_bounds_ms(&month).unwrap();
        seed_fact_min(
            &db,
            "f1",
            "dsh",
            "deepseek-v4-flash",
            start + 1_000,
            100_000_000,
            10_000_000,
        );
        db.budget_config_set(60_000, 3_000, 8_000, 1).unwrap();
        let v_low = budget_status_sql(&month).unwrap();
        // 事实量大到把 DSH 支出顶过 warn（≥80%）与 exceeded（≥100%）：
        // flash 卡便宜，直接 seed 巨量 cache_read（峰值单价不参与，这里走
        // priced_day 需要 by_model 形状——直接给足量级即可跨档）。
        for i in 0..40 {
            seed_fact_min(
                &db,
                &format!("bulk{i}"),
                "dsh",
                "deepseek-v4-flash",
                start + 2_000 + i,
                900_000_000,
                90_000_000,
            );
        }
        let v_high = budget_status_sql(&month).unwrap();
        let spent_low = v_low["metered_cny_minor"].as_i64().unwrap();
        let spent_high = v_high["metered_cny_minor"].as_i64().unwrap();
        assert!(spent_high > spent_low, "更多事实 → 更多支出");
        assert!(
            v_high["level"].as_str() == Some("exceeded")
                || v_high["level"].as_str() == Some("warn"),
            "大额支出必须落 warn/exceeded 档，got {}",
            v_high["level"]
        );
        assert!(v_low["level"].as_str() == Some("ok") || v_low["level"].as_str() == Some("warn"));
        // minor 判断链：ratio_bp 与 spent/monthly 的整数关系自洽。
        if let (Some(sp), Some(rb)) = (
            v_high["metered_cny_minor"].as_i64(),
            v_high["ratio_bp"].as_i64(),
        ) {
            assert_eq!(
                rb,
                sp * 10_000 / 60_000,
                "ratio_bp = spent*10000/monthly 整数除法"
            );
        }
        let _ = std::fs::remove_dir_all(
            std::env::temp_dir().join(format!("av-budget-levels-{}", std::process::id())),
        );
    }

    /// 档位阈值**精确钉界**（审查 F3：levels 的 OR 断言连 2000bp 的错误
    /// warn 阈值都能过——直接调 `budget_config_set` 配一个极小月预算，用
    /// 实测 spent 反推三个精确边界：恰 warn 阈值下/上、恰 100% 下/上）。
    #[test]
    fn budget_status_level_thresholds_are_exact() {
        let (_guard, _db, month) = fresh_budget_env("exact");
        // 不 seed 事实（spent=0），用**月预算本身**控制 spent/monthly 比例：
        // spent 恒 0 → ratio_bp 恒 0 → level 恒 ok——不够。反过来：spent
        // 来自 facts，这里 seed 一笔**已知折算价**的事实再调 budget_config
        // _set 把 monthly 拨到 spent 的边界倍数上，四次查询钉四个档位。
        let (start, _) =
            agent_vitals_data::authority_query::beijing_month_bounds_ms(&month).unwrap();
        // seed 量要**足够大**：四个边界都靠 `monthly = spent*10000/bp` 反推，
        // 整数除法在 spent 小时不可逆（spent≈195 时量化误差把 warn 下界推过
        // 阈值）——按量口径切换后订阅 ¥232 不再垫底，必须自己把 spent 顶到
        // 数千分（¥数十）级别，`/7999` 与 `/8000` 才区分得开。
        seed_fact_min(
            &_db,
            "e1",
            "dsh",
            "deepseek-v4-flash",
            start + 1_000,
            1_000_000_000,
            100_000_000,
        );
        drop(_db);
        let v = budget_status_sql(&month).unwrap();
        let spent = v["metered_cny_minor"].as_i64().unwrap();
        assert!(
            spent > 10_000,
            "seed 事实必须折出足量正支出（否则边界反推不可逆），got {spent}"
        );
        // 四次配置 × 查询：spent/warn 下（ok）、恰 warn 上（warn）、
        // spent 恰 100% 下（warn）、恰 100% 上（exceeded）。monthly 取值
        // 让 spent*10000/monthly 落在每档边界两侧各一次。
        let cases = [
            (spent * 10_000 / 7_999, "warn 以下（ratio < 8000bp）", "ok"),
            (
                spent * 10_000 / 8_000,
                "恰 warn 阈值（ratio == 8000bp）",
                "warn",
            ),
            (spent * 10_000 / 9_999, "超 warn 未满额", "warn"),
            (spent * 10_000 / 10_000, "恰 100%", "exceeded"),
        ];
        for (monthly_minor, label, want) in cases {
            if monthly_minor <= 0 {
                continue;
            }
            let db = agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(&crate::home::data_home()),
                crate::clock::now_ms(),
            )
            .unwrap();
            db.budget_config_set(monthly_minor, 3_000, 8_000, 1)
                .unwrap();
            drop(db);
            let v = budget_status_sql(&month).unwrap();
            assert_eq!(
                v["level"].as_str(),
                Some(want),
                "{label}: monthly={monthly_minor} spent={spent} got {}",
                v["level"]
            );
        }
    }

    #[test]
    fn budget_status_snooze_suppresses_but_reports() {
        // 两段 env 必须**串行**（先整体 drop 第一组的 guard 再进第二组）：
        // fresh_budget_env 拿进程级 ENV_LOCK，_guard 活着时再调就是自己锁
        // 自己（本测试第一版挂死的直接原因，sample 栈钉在
        // pthread_mutex_lock_wait 上）。
        let far = crate::clock::now_ms() + 86_400_000;
        {
            let (_guard, db, month) = fresh_budget_env("snooze");
            db.budget_config_set(60_000, 3_000, 8_000, 1).unwrap();
            // snooze 到远未来：status 报 snoozed_until_ms；snooze 行优先于
            // 超支判断的呈现（level 仍如实，抑制由消费方决定）。
            db.budget_snooze_set(far, 1).unwrap();
            drop(db);
            // guard 还活着：budget_status_sql 在同一 env 内重开库。
            let v = budget_status_sql(&month).unwrap();
            assert_eq!(v["snoozed_until_ms"], json!(far));
        }
        // 过期 snooze（过去时刻）不抑制：独立 env。
        {
            let (_guard, db, month) = fresh_budget_env("snooze2");
            db.budget_config_set(60_000, 3_000, 8_000, 1).unwrap();
            db.budget_snooze_set(crate::clock::now_ms() - 1_000, 1)
                .unwrap();
            drop(db);
            let v = budget_status_sql(&month).unwrap();
            assert_eq!(v["snoozed_until_ms"], Value::Null, "过期 snooze 视同无");
        }
    }

    /// 参数化入口（Tier B 预算卡收尾）：`budget_status_sql_at` 显式收
    /// `data_home`，**不碰进程 env**——Tauri `read_overview_at(dh)` 组装入口和
    /// 临时库单测据此对指定库跑预算判定，不必持 `ENV_LOCK`、不受并发测试改
    /// `AGENT_VITALS_HOME` 影响。失败历史：ZST `SqlSummaryRepository` 只认
    /// `crate::home::data_home()`，组装入口传进来的 `dh` 被内部忽略，预算卡
    /// 永远在真机库上跑（本次会话连续 4 次实现失败的直接原因）。
    ///
    /// **本用例故意不取 `ENV_LOCK`**：若 `budget_status_sql_at` 真的只读传入
    /// 的 `dir`，并发测试改不改 `AGENT_VITALS_HOME` 都不影响它——能无锁跑通
    /// 本身就是「参数化到位」的证明。
    #[test]
    fn budget_status_sql_at_reads_the_passed_data_home_without_touching_env() {
        let month = crate::clock::current_month_beijing();
        let (start, _) =
            agent_vitals_data::authority_query::beijing_month_bounds_ms(&month).unwrap();

        // 两个独立库、同一份预算配置——只有 `spender` 库里 seed 了 DSH 事实。
        let fresh = |tag: &str| -> std::path::PathBuf {
            let d = std::env::temp_dir()
                .join(format!("av-budget-status-at-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            let db = agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(&d),
                1,
            )
            .unwrap();
            db.budget_config_set(60_000, 3_000, 8_000, 1).unwrap(); // ¥600 / ¥30 / 80%
            if tag == "spender" {
                seed_fact_min(
                    &db,
                    "at1",
                    "dsh",
                    "deepseek-v4-flash",
                    start + 1_000,
                    1_000_000,
                    100_000,
                );
            }
            d
        };
        let dir_spender = fresh("spender");
        let dir_empty = fresh("empty");

        // **本用例故意不取 `ENV_LOCK`**：若两次调用都只读各自传入的 dir，并发
        // 测试改不改 `AGENT_VITALS_HOME` 都不影响结果。若 `SqlSummaryRepository
        // ::at()` 有 bug、内部退回 env 库，则两次调用读同一个（真机）库、spent
        // 必然相等，`>` 断言当场翻红——与真机本月有无 DSH 消费无关。
        let v_spender = budget_status_sql_at(&dir_spender, &month).expect("库可开");
        let v_empty = budget_status_sql_at(&dir_empty, &month).expect("库可开");
        assert_eq!(v_spender["data_source"], "sql_authority");
        assert_eq!(
            v_spender["monthly_cny_minor"],
            json!(60_000),
            "配置读自传入的 dir"
        );
        let spent_spender = v_spender["metered_cny_minor"].as_i64().unwrap();
        let spent_empty = v_empty["metered_cny_minor"].as_i64().unwrap();
        // 按量口径（PM 决策 2026-09-07）：无事实的库 metered = 0——`apply_
        // subscription_fees` 摊进的 CNY 订阅月费（GLM/MiniMax，实测 ¥232）
        // 是 `FixedSubscription` 档，**被排除**在预算分子外。改这条前它是
        // 23200（订阅摊销冒充按量消耗）。
        assert_eq!(
            spent_empty, 0,
            "无按量事实 → metered 分子必须为 0，订阅月费不算"
        );
        assert!(
            spent_spender > spent_empty,
            "seed 了 DSH 按量事实的库 metered 必须严格更大——传入的 data_home 被真正\
             使用（spender={spent_spender} empty={spent_empty}）"
        );
        let _ = std::fs::remove_dir_all(&dir_spender);
        let _ = std::fs::remove_dir_all(&dir_empty);
    }

    // ── Tier B：evaluate_alert_from_sql（alert / 托盘预算卡 切 SQL）─────────

    fn fresh_sql_home(
        tag: &str,
    ) -> (
        std::path::PathBuf,
        agent_vitals_data::authority::AuthorityDb,
    ) {
        let d = std::env::temp_dir().join(format!("av-alert-sql-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&d),
            1,
        )
        .unwrap();
        (d, db)
    }

    /// 空库且无用户配置 → no_budget；成本缺数据仍为null，不制造默认分母。
    #[test]
    fn evaluate_alert_from_sql_empty_db_degrades_honestly() {
        let (dir, _db) = fresh_sql_home("empty");
        let a = evaluate_alert_from_sql(&dir);
        assert_eq!(a["level"], "no_budget");
        assert_eq!(a["today_cost"], Value::Null);
        assert_eq!(a["month_cost"], Value::Null);
        assert_eq!(a["monthly_cny"], Value::Null);
        assert_eq!(a["effective_daily_budget"], Value::Null);
        assert_eq!(a["month_ratio"], Value::Null);
        assert_eq!(a["reasons"], json!(["budget_not_configured"]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// seed 大额 DSH 今日按量事实 + 极小月/日预算 → 跨过 over 档；`month_cost` /
    /// `today_cost` 是 DSH `peaked_days_map` 经 `evaluate_alert` 内部计价的结果
    /// （不是 by_provider 聚合，但同一条 priced_day 管线，数值同源）。
    #[test]
    fn evaluate_alert_from_sql_prices_dsh_today_and_month_from_facts() {
        let (dir, db) = fresh_sql_home("spender");
        let today = crate::clock::today_beijing();
        let (start, _) = agent_vitals_data::authority_query::beijing_day_bounds_ms(&today).unwrap();
        // 今天的一笔大额按量事实（flash 卡便宜，量给足跨档）。
        seed_fact_min(
            &db,
            "t1",
            "dsh",
            "deepseek-v4-flash",
            start + 1_000,
            500_000_000,
            50_000_000,
        );
        // 极小预算：monthly ¥1 / daily ¥0.5 → 必然 over。
        db.budget_config_set(100, 50, 8_000, 1).unwrap();
        drop(db);

        let a = evaluate_alert_from_sql(&dir);
        let today_cost = a["today_cost"].as_f64().unwrap();
        assert!(
            today_cost > 0.0,
            "今日按量事实必须折出正成本，got {today_cost}"
        );
        assert_eq!(
            a["month_cost"].as_f64().unwrap(),
            today_cost,
            "本月只有今天一笔 → 相等"
        );
        assert_eq!(a["level"], "over", "支出远超 ¥1 月预算");
        assert!(a["month_ratio"].as_f64().unwrap() >= 1.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn evaluate_alert_keeps_cost_visible_when_budget_is_unset() {
        let (dir, db) = fresh_sql_home("unconfigured-spender");
        let today = crate::clock::today_beijing();
        let (start, _) = agent_vitals_data::authority_query::beijing_day_bounds_ms(&today).unwrap();
        seed_fact_min(&db, "u1", "dsh", "deepseek-v4-flash", start + 1_000,
                      10_000_000, 1_000_000);
        drop(db);
        let a = evaluate_alert_from_sql(&dir);
        assert!(a["today_cost"].as_f64().unwrap() > 0.0);
        assert!(a["month_cost"].as_f64().unwrap() > 0.0);
        assert_eq!(a["level"], "no_budget");
        for key in ["monthly_cny", "effective_daily_budget", "ratio", "month_ratio"] {
            assert!(a[key].is_null(), "{key} must stay unset: {a}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// snooze 到远未来 → warn/over 被压成 `snoozed`（near 仍可见）；过期 snooze
    /// 不压制。表里存 until_ms，`evaluate_alert` 按 now 重判。
    #[test]
    fn evaluate_alert_from_sql_snooze_suppresses_then_expires() {
        let (dir, db) = fresh_sql_home("snooze");
        let today = crate::clock::today_beijing();
        let (start, _) = agent_vitals_data::authority_query::beijing_day_bounds_ms(&today).unwrap();
        seed_fact_min(
            &db,
            "s1",
            "dsh",
            "deepseek-v4-flash",
            start + 1_000,
            500_000_000,
            50_000_000,
        );
        db.budget_config_set(100, 50, 8_000, 1).unwrap();
        // 远未来 snooze（now + 1 天）。
        db.budget_snooze_set(crate::clock::now_ms() + 86_400_000, 1)
            .unwrap();
        drop(db);
        let a = evaluate_alert_from_sql(&dir);
        assert_eq!(a["level"], "snoozed", "warn/over 被 snooze 压制");
        assert!(a["snoozed_until"].is_string());

        // 过期 snooze：重开库改 until 到过去。
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&dir),
            1,
        )
        .unwrap();
        db.budget_snooze_set(crate::clock::now_ms() - 1_000, 1)
            .unwrap();
        drop(db);
        let a = evaluate_alert_from_sql(&dir);
        assert_eq!(a["level"], "over", "过期 snooze 不压制");
        assert_eq!(a["snoozed_until"], Value::Null);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Phase 4.3：`budget show --month M`（`month_cost_sql`）从 SQL 权威库
    /// 折 DSH 该月成本，`{total, peak_total}` 形状不变；无该月事实 → None。
    #[test]
    fn month_cost_sql_prices_dsh_month_from_facts() {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (dir, db) = fresh_sql_home("monthcost");
        let month = crate::clock::current_month_beijing();
        let (start, _) =
            agent_vitals_data::authority_query::beijing_month_bounds_ms(&month).unwrap();
        seed_fact_min(
            &db,
            "m1",
            "dsh",
            "deepseek-v4-flash",
            start + 3_600_000,
            100_000_000,
            10_000_000,
        );
        drop(db);
        let _guard = TestEnvGuard::set(&dir);
        let cost = month_cost_sql(&month).expect("有 DSH 事实 → Some");
        assert!(cost["total"].as_f64().unwrap() > 0.0);
        assert!(cost.get("peak_total").is_some(), "形状含 peak_total");
        assert!(month_cost_sql("1999-01").is_none(), "无该月事实 → None");
        drop(_guard);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ms_to_iso_utc_round_trips_through_parse_iso() {
        // 2026-09-08T04:05:06Z = 1788840306 秒 = 1788840306000 ms
        let ms = 1_788_840_306_000i64;
        let iso = ms_to_iso_utc(ms);
        assert_eq!(iso, "2026-09-08T04:05:06+00:00");
        let (back_secs, explicit) =
            agent_vitals_domain::budget::parse_iso(&iso).expect("parse_iso 认显式 offset");
        assert!(explicit);
        assert_eq!(back_secs, ms / 1000, "parse_iso 返回秒");
    }

    /// 回归（3.4 附带 bug）：`iso_to_ms_beijing` 必须返回**毫秒**——`parse_iso`
    /// 出的是秒，漏了 ×1000 会把秒写进 `budget_snoozes.until_ms` 毫秒列，
    /// `budget_status_sql` / `evaluate_alert_from_sql` 读回来恒早于 now_ms、
    /// snooze 永远显示已过期。
    #[test]
    fn iso_to_ms_beijing_returns_milliseconds() {
        // 2026-09-08T04:05:06+00:00 → 1788840306 秒 → ×1000 毫秒
        let ms = iso_to_ms_beijing("2026-09-08T04:05:06+00:00").unwrap();
        assert_eq!(ms, 1_788_840_306_000);
        // 与 now_ms() 同量级：>1e12 而非 ~1.7e9（漏 ×1000 就是后者）。
        assert!(ms > 1_000_000_000_000, "毫秒量级，got {ms}");
    }
}
