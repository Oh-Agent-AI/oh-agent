//! 预算阈值与告警等级 —— M6 落地的**纯计算侧**。
//!
//! 镜像 `scripts/agent_vitals/agent/budget.py::evaluate` 的决策段：读文件、
//! TOML 解析、北京日期/now 生成都是 I/O，留在二进制侧（`src/agent/budget.rs`）；
//! 这里只持有「给定已测数据 + 配置 → 告警 dict」的纯函数。与 `cost.rs` 同款
//! 边界：`cost.rs` 拿 usage/pricing，这里拿 today/month 数据 + config + pricing。
//!
//! 设计纪律（Python 侧 tests/test_budget.py 每条都有锚点）：
//! - 「启发式只排序不裁决」——自适应阈值只决定*什么时候*告警，不自动调用户设值。
//! - 「缺列不编列」——today.json 缺场 → today_cost=None，不编 0。
//! - 「peak_share 反博弈」——peak/total > 阈值 → 告警，即使总额在预算内。
//! - 「snooze 到期自动失效」——now >= snoozed_until → 不压制。
//! - 「月预算参与 level，只升级不降级」——今天花得少不该把已超支的月压回去。
//!
//! 逐字节一致性由差分测试（`tests/test_cli_matrix.py` 的 `budget show --json`）
//! 钉住：Python 与 Rust 在同一夹具 HOME 下跑同一条命令，stdout 逐字节相等。
//! 差异点只在数字类型：Python `_parse_scalar` 对 `30` 返回 int、对 `30.0` 返回
//! float，Rust 侧 serde_json 同样保留 int/float 之别（`merged_config` 逐 key
//! 保留解析结果），文本输出的 `str()` 语义才一致。

use serde_json::{json, Value};

use crate::cost;

/// 默认预算 —— 与 Python `DEFAULT_BUDGET` 逐字段一致（tests/test_budget.py
/// `test_defaults_match_spec` 把 spec §5.1 当契约钉死）。key 顺序即插入顺序，
/// serde_json 开着 `preserve_order`，文本/JSON 输出的 key 序与 Python dict 相同。
pub fn default_budget() -> Value {
    json!({
        "enabled": true,
        "daily_cny": 30.0,
        "weekly_cny": 180.0,
        "monthly_cny": 600.0,
        "peak_share_max": 0.5,
        "warn_at_ratio": 0.8,
        "adaptive_floor": true,
        "adaptive_window_days": 7,
        "adaptive_multiplier": 1.5,
    })
}

/// 用解析出的 [budget] 节覆盖默认值 —— 缺字段保留默认。
///
/// 镜像 `budget.py::load_config` 的 merge 段（TOML 解析段在二进制侧）。只认
/// `default_budget` 里的 8 个 key，未知 key 丢弃 —— 与 Python `if key in cfg`
/// 一致。解析出的 int/float 类型原样保留（`30` 是整数、`30.0` 是浮点），这样
/// `budget show` 文本输出的 `str()` 语义（`30` vs `30.0`）两侧一致。
pub fn merged_config(parsed: &Value) -> Value {
    let mut out = default_budget();
    if let Some(obj) = parsed.as_object() {
        let map = out.as_object_mut().expect("default_budget 返回对象");
        for (k, v) in obj {
            if map.contains_key(k) {
                map.insert(k.clone(), v.clone());
            }
        }
    }
    out
}

/// 近 7 天日均 cost —— 自适应 floor 的输入。
///
/// 镜像 `budget.py::compute_7d_avg_daily`：**硬编码 7 天窗口**（`adaptive_window_days`
/// 配置在 `effective_daily_budget` 里被读取但从未使用 —— Python 侧同款死代码，
/// 这里同样不读，保持镜像），只查当前自然月（`month_days` 已过滤到当前月）。
/// 窗口不足按现有天数平均，n==0 → None（不编 0 —— 断言 0 得先证明跑过审计）。
fn avg_daily_cost(days: &Value, pricing: &Value, today: &str) -> Option<f64> {
    let map = days.as_object()?;
    let today_days = parse_date_days(today)?;
    let mut total = 0.0;
    let mut n = 0i64;
    for offset in 0..7i64 {
        let (y, m, d) = civil_from_days(today_days - offset);
        let key = format!("{y:04}-{m:02}-{d:02}");
        if let Some(day) = map.get(&key) {
            let c = cost::priced_day(day, pricing)
                .unwrap_or_else(|| cost::bucket_cost(day, pricing));
            total += c["total"].as_f64().unwrap_or(0.0);
            n += 1;
        }
    }
    if n == 0 {
        None
    } else {
        Some(total / n as f64)
    }
}

/// `max(user_set, 7日均 × adaptive_multiplier)` —— spec §5.2。
///
/// 缺数据（avg7d None）**不**应用自适应 floor，直接返回 user_set ——
/// 「窗口不足时降级」纪律，与 Python `effective_daily_budget` 逐字节一致。
fn effective_daily_budget(cfg: &Value, avg7d: Option<f64>) -> (f64, bool) {
    let user_set = cfg.get("daily_cny").and_then(Value::as_f64).unwrap_or(30.0);
    let adaptive = cfg
        .get("adaptive_floor")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !adaptive {
        return (user_set, false);
    }
    let avg = match avg7d {
        Some(a) => a,
        None => return (user_set, false),
    };
    let multiplier = cfg
        .get("adaptive_multiplier")
        .and_then(Value::as_f64)
        .unwrap_or(1.5);
    let floor = avg * multiplier;
    if floor > user_set {
        (floor, true)
    } else {
        (user_set, false)
    }
}

/// ratio → 'ok' / 'near' / 'warn' / 'over'。
///
/// 阈值：< 0.7 ok；0.7–0.9 near；0.9–1.0 warn；≥ 1.0 over。`warn_at` 默认 0.8，
/// 允许用户调（当前实现把 warn_at 当作 near/warn 的分界：0.7 / warn_at / 1.0
/// 三段）。镜像 `budget.py::_alert_level`。
pub fn alert_level(ratio: f64, warn_at: f64) -> &'static str {
    if ratio >= 1.0 {
        "over"
    } else if ratio >= warn_at {
        "warn"
    } else if ratio >= 0.7 {
        "near"
    } else {
        "ok"
    }
}

/// level 严重度序 —— 月预算只升级不降级时比较用（见 evaluate_alert）。
fn severity(l: &str) -> i64 {
    match l {
        "ok" => 0,
        "near" => 1,
        "warn" => 2,
        "over" => 3,
        _ => 0,
    }
}

/// 今日 / 本月 / peak_share 三维度 → alert dict（spec §5.3）。
///
/// `level` 由三路输入取最严重的一个：today ratio、peak_share 反博弈、month
/// ratio —— 之前只有前两路参与判定，月预算配了却从不影响 level（`monthly_cny`
/// 只用来算 xbar 显示的百分比），会出现「本月超支 200%，今天花得少，菜单栏
/// 还是绿的」这种误导。
///
/// 参数都是**已测数据**（二进制读好文件传进来）：
/// - `cfg`：merged 后的 [budget] 配置（8 字段齐全）
/// - `today_data`：today.json 的 Value（None = 文件缺失/不可解析）
/// - `month_days`：month.json 里**已过滤到当前自然月**的 `days` map
/// - `pricing`：pricing.json（core `cost::load_pricing`）
/// - `today_key`：北京 "YYYY-MM-DD"
/// - `snoozed_until`：budget.json 里的裸 ISO 串（None = 无 snooze）
/// - `now_unix`：unix 秒 —— 只在 snooze 存在且未过期时参与比较
///
/// 返回值与 Python `evaluate()` 的 dict 逐 key 同序、逐值同形（差分钉死）。
pub fn evaluate_alert(
    cfg: &Value,
    today_data: Option<&Value>,
    month_days: Option<&Value>,
    pricing: &Value,
    today_key: &str,
    snoozed_until: Option<&str>,
    now_unix: i64,
) -> Value {
    let f = |k: &str, def: f64| cfg.get(k).and_then(Value::as_f64).unwrap_or(def);
    let daily_cny = f("daily_cny", 30.0);
    let monthly_cny = f("monthly_cny", 600.0);
    let enabled = cfg.get("enabled").and_then(Value::as_bool).unwrap_or(true);

    if !enabled {
        return json!({
            "level": "disabled",
            "ratio": None::<f64>,
            "peak_share": None::<f64>,
            "peak_over": false,
            "reasons": Vec::<String>::new(),
            "snoozed_until": None::<String>,
            "effective_daily_budget": daily_cny,
            "monthly_cny": monthly_cny,
            "month_ratio": None::<f64>,
            "adaptive_floor_applied": false,
            "today_cost": None::<f64>,
            "today_peak_cost": None::<f64>,
            "month_cost": None::<f64>,
        });
    }

    // snooze 检查：now >= snoozed_until → 到期自动失效（不需要 cron / event）。
    // 输出 `snoozed_until` = 未过期时 Python `dt.isoformat()` 的结果 —— 裸
    // 时间戳被 Python 按北京时间解释后输出带 `+08:00`（`_read_snooze` 的
    // `dt.replace(tzinfo=_BEIJING)`），这里对无显式 offset 的串补上同一后缀。
    // 解析失败的串 Python 直接判无 snooze，这里同样丢弃。
    let mut snooze_out: Option<String> = None;
    if let Some(raw) = snoozed_until {
        if let Some((epoch, explicit)) = parse_iso(raw) {
            if now_unix < epoch {
                snooze_out = Some(if explicit {
                    raw.to_string()
                } else {
                    format!("{raw}+08:00")
                });
            }
        }
    }

    let today = today_data.and_then(|d| cost::today_cost(d, pricing, today_key));
    let month = month_days.map(|m| cost::month_cost(m, pricing));
    let avg7d = month_days.and_then(|m| avg_daily_cost(m, pricing, today_key));
    let (eff, floor_applied) = effective_daily_budget(cfg, avg7d);

    let mut reasons: Vec<String> = Vec::new();
    let mut ratio: Option<f64> = None;
    let mut peak_share: Option<f64> = None;
    let mut peak_over = false;
    let mut month_ratio: Option<f64> = None;

    if let Some(today) = &today {
        let total = today["total"].as_f64().unwrap_or(0.0);
        if total > 0.0 {
            ratio = if eff > 0.0 { Some(total / eff) } else { None };
            let peak = today["peak_total"].as_f64().unwrap_or(0.0);
            peak_share = Some(peak / total);
            let peak_max = f("peak_share_max", 0.5);
            peak_over = peak_share.unwrap_or(0.0) > peak_max;

            if let Some(r) = ratio {
                reasons.push(format!(
                    "today at {}% of daily budget (¥{:.2} / ¥{:.2})",
                    crate::util::pyround(r * 100.0, 0) as i64,
                    total,
                    eff
                ));
            }
            if peak_over {
                reasons.push(format!(
                    "peak share {}% exceeds max {}%",
                    crate::util::pyround(peak_share.unwrap_or(0.0) * 100.0, 0) as i64,
                    crate::util::pyround(peak_max * 100.0, 0) as i64
                ));
            }
        }
    } else {
        reasons.push("no metered spend recorded for today yet (budget counts cross-harness metered spend only)".to_string());
    }

    // 月预算：之前只把 month_cost/monthly_cny 算出来给 xbar 显示，从没真的参与过
    // level 判定 —— 用户月预算超了几倍，只要今天花得少，菜单栏照样显示绿色。
    // 这里用跟 today 同一套 `alert_level` 阈值算一遍月度的，下面取更严重的那个。
    if let Some(month) = &month {
        let total = month["total"].as_f64().unwrap_or(0.0);
        if total > 0.0 && monthly_cny > 0.0 {
            month_ratio = Some(total / monthly_cny);
            reasons.push(format!(
                "month at {}% of monthly budget (¥{:.2} / ¥{:.2})",
                crate::util::pyround(month_ratio.unwrap_or(0.0) * 100.0, 0) as i64,
                total,
                monthly_cny
            ));
        }
    }

    let warn_at = f("warn_at_ratio", 0.8);
    let mut level: &str = match ratio {
        None => "ok", // 无当日数据 = 当日无告警，缺列不编列
        Some(r) => {
            let mut lvl = alert_level(r, warn_at);
            if peak_over && lvl != "over" {
                // peak 超标强制升级一档（spec §5.4）
                lvl = if lvl == "near" { "warn" } else { "over" };
            }
            lvl
        }
    };
    if let Some(mr) = month_ratio {
        // 只升级不降级 —— today 那边已判出的 warn/over 不会被「月预算还好」压回去。
        let ml = alert_level(mr, warn_at);
        if severity(ml) > severity(level) {
            level = ml;
        }
    }
    if snooze_out.is_some() && (level == "warn" || level == "over") {
        // 只压制 warn/over —— near 仍可见（snooze 习惯用法）。
        level = "snoozed";
    }

    json!({
        "level": level,
        "ratio": ratio,
        "peak_share": peak_share,
        "peak_over": peak_over,
        "reasons": reasons,
        "snoozed_until": snooze_out,
        "effective_daily_budget": eff,
        "monthly_cny": monthly_cny,
        "month_ratio": month_ratio,
        "adaptive_floor_applied": floor_applied,
        "today_cost": today.as_ref().map(|t| t["total"].clone()),
        "today_peak_cost": today.as_ref().map(|t| t["peak_total"].clone()),
        "month_cost": month.as_ref().map(|t| t["total"].clone()),
    })
}

// ────────────────────────── 日期/时间（纯，不引 chrono） ──────────────────────────

/// 儒略日 → 公历（Howard Hinnant 算法）。`days_from_civil(1970,1,1) == 0`，
/// 与 `src/agent/codex_cost.rs::civil_from_unix_secs` 同一算法族（那里从 unix
/// 秒出发，这里从「1970 起的绝对天数」出发，供 7 日均窗口往前数天用）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

/// 公历 → 1970 起的天数（`civil_from_days` 的逆）。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// "YYYY-MM-DD" → 1970 起的天数；格式不符返回 None。
fn parse_date_days(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 10 {
        return None;
    }
    let n = |r: &[u8]| std::str::from_utf8(r).ok()?.parse::<i64>().ok();
    let y = n(&b[0..4])?;
    let m = n(&b[5..7])?;
    let d = n(&b[8..10])?;
    Some(days_from_civil(y, m, d))
}

/// 解析 Python `datetime.isoformat()` 形状 → (unix 秒, 是否有显式 offset)。
///
/// 裸时间戳（无 offset）按北京时间解释 —— 与 `budget.py::_read_snooze` 的
/// `dt.replace(tzinfo=_BEIJING)` 同一约定。fraction 部分跳过不解析（比较只需
/// 到秒；Python 存的都是 isoformat 产物，微秒只影响严格等于边界的亚秒差异）。
///
/// 公开给纯 adapter crate：Claude Code 适配器复用同一套 ISO-8601 解析（Claude 的
/// `"2026-08-20T14:27:08.827Z"` 带 fraction + Z 后缀，本函数已处理）——不
/// 复制第四份时间戳解析。
pub fn parse_iso(s: &str) -> Option<(i64, bool)> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |r: &[u8]| std::str::from_utf8(r).ok()?.parse::<i64>().ok();
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let y = n(&b[0..4])?;
    let m = n(&b[5..7])?;
    let d = n(&b[8..10])?;
    let hh = n(&b[11..13])?;
    let mm = n(&b[14..16])?;
    let ss = n(&b[17..19])?;
    let mut rest = &b[19..];
    if rest.first() == Some(&b'.') {
        let mut i = 1;
        while i < rest.len() && rest[i].is_ascii_digit() {
            i += 1;
        }
        rest = &rest[i..];
    }
    let (offset, explicit) = if rest.is_empty() {
        (8 * 3600, false)
    } else if rest[0] == b'Z' || rest[0] == b'z' {
        (0, true)
    } else if rest[0] == b'+' || rest[0] == b'-' {
        if rest.len() < 6 {
            return None;
        }
        let oh = n(&rest[1..3])?;
        if rest[3] != b':' {
            return None;
        }
        let om = n(&rest[4..6])?;
        let sign = if rest[0] == b'-' { -1 } else { 1 };
        (sign * (oh * 3600 + om * 60), true)
    } else {
        return None;
    };
    let days = days_from_civil(y, m, d);
    Some((days * 86400 + hh * 3600 + mm * 60 + ss - offset, explicit))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_bucket(uncached: i64) -> Value {
        json!({
            "uncached_input_tokens": uncached,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0,
            "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0,
            "peak_cache_write_tokens": 0,
        })
    }

    fn cfg() -> Value {
        merged_config(&json!({}))
    }

    fn now_unix() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    fn today_key() -> String {
        // 北京今天 —— 复用二进制 codex_cost 的算法；这里为了测试自包含，
        // 用同一套 civil 算法现算。
        let now = now_unix();
        let days = (now + 8 * 3600).div_euclid(86400);
        let (y, m, d) = civil_from_days(days);
        format!("{y:04}-{m:02}-{d:02}")
    }

    /// spec §5.1 的 8 个字段默认值必须与文档一致 —— 文档是契约。
    #[test]
    fn default_budget_matches_spec() {
        let d = default_budget();
        assert_eq!(d["enabled"], true);
        assert_eq!(d["daily_cny"], 30.0);
        assert_eq!(d["weekly_cny"], 180.0);
        assert_eq!(d["monthly_cny"], 600.0);
        assert_eq!(d["peak_share_max"], 0.5);
        assert_eq!(d["warn_at_ratio"], 0.8);
        assert_eq!(d["adaptive_floor"], true);
        assert_eq!(d["adaptive_window_days"], 7);
        assert_eq!(d["adaptive_multiplier"], 1.5);
    }

    /// 部分配置 → 缺的字段用默认填。
    #[test]
    fn partial_config_merged_with_defaults() {
        let c = merged_config(&json!({"daily_cny": 50.0}));
        assert_eq!(c["daily_cny"], 50.0);
        assert_eq!(c["peak_share_max"], 0.5);
        assert_eq!(c["enabled"], true);
        // int/float 类型保留 —— 文本输出 str() 语义依赖它
        let c2 = merged_config(&json!({"adaptive_window_days": 7, "daily_cny": 30.0}));
        assert_eq!(c2["adaptive_window_days"].as_i64(), Some(7));
        assert!(c2["daily_cny"].as_f64().is_some());
    }

    /// ratio → level 的阈值映射必须与 spec §5.2 一致。
    #[test]
    fn alert_level_thresholds_match_spec() {
        assert_eq!(alert_level(0.5, 0.8), "ok");
        assert_eq!(alert_level(0.7, 0.8), "near");
        assert_eq!(alert_level(0.85, 0.8), "warn");
        assert_eq!(alert_level(1.0, 0.8), "over");
        assert_eq!(alert_level(1.5, 0.8), "over");
    }

    /// enabled = false → level = 'disabled'，不报任何告警。
    #[test]
    fn disabled_budget_returns_disabled_level() {
        let c = merged_config(&json!({"enabled": false}));
        let r = evaluate_alert(&c, None, None, &cost::load_pricing(), &today_key(), None, now_unix());
        assert_eq!(r["level"], "disabled");
        assert_eq!(r["reasons"].as_array().unwrap().len(), 0);
        assert_eq!(r["today_cost"], Value::Null);
    }

    /// 当日无按量实付 → level='ok' + 一条 reason 说明（不告警但要解释）。
    ///
    /// 措辞 2026-09-14 改过一次：原文引用已退役的 `today.json` 与 `behavior` 命令
    /// （Phase 4.3 后当日数据来自权威库事实），照着做的用户会白跑一趟。
    #[test]
    fn missing_today_data_returns_ok_with_explanation() {
        let r = evaluate_alert(&cfg(), None, None, &cost::load_pricing(), &today_key(), None, now_unix());
        assert_eq!(r["level"], "ok");
        assert_eq!(r["today_cost"], Value::Null);
        let reasons = r["reasons"].as_array().unwrap();
        assert!(reasons.iter().any(|x| x.as_str().unwrap().contains("no metered spend recorded for today")));
        assert_eq!(r["effective_daily_budget"], 30.0);
        assert_eq!(r["monthly_cny"], 600.0);
    }

    /// 月预算超支必须真的影响 level —— 之前 monthly_cny 只用来算 xbar 显示的
    /// 百分比，从不参与 level 判定。today 无数据 → ratio=None level 起点 ok；
    /// month 超支必须把它升到 over。
    #[test]
    fn month_over_budget_escalates_level_even_when_today_is_fine() {
        let days = json!({
            "2026-08-01": flat_bucket(500_000_000),
        });
        // today_key 随意 —— 窗口里的日期不命中月数据也无妨（month 聚合看全月）
        let r = evaluate_alert(&cfg(), None, Some(&days), &cost::load_pricing(), "2026-08-30", None, now_unix());
        assert!(r["month_ratio"].as_f64().unwrap() > 1.0);
        assert_eq!(r["level"], "over");
        assert!(r["reasons"].as_array().unwrap().iter().any(|x| x.as_str().unwrap().contains("month at")));
    }

    /// 月预算正常时，不该把 today 那边已判出的 over 压回去（升级只单向）。
    #[test]
    fn today_over_budget_not_downgraded_by_fine_month() {
        let tk = today_key();
        let mk: String = tk[..7].to_string();
        let today = json!({
            "date": tk,
            "buckets": {"14": flat_bucket(30_000_000)},
            "schema_version": "1.0.0",
        });
        // 当月一天小花费 → month_ratio < 0.1
        let day = format!("{mk}-01");
        let days = json!({ day.clone(): flat_bucket(1_000) });
        let r = evaluate_alert(&cfg(), Some(&today), Some(&days), &cost::load_pricing(), &tk, None, now_unix());
        assert!(r["month_ratio"].as_f64().unwrap() < 0.1);
        assert_eq!(r["level"], "over");
    }

    /// 反博弈条款：总费用低但 peak 占比 100% > 50% → peak_over，即使总额在预算内。
    #[test]
    fn peak_over_triggers_even_if_total_under_budget() {
        let tk = today_key();
        let today = json!({
            "date": tk,
            "buckets": {"14": {
                "uncached_input_tokens": 1_000_000,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 1_000_000,
                "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0,
                "peak_cache_write_tokens": 0,
            }},
            "schema_version": "1.0.0",
        });
        let r = evaluate_alert(&cfg(), Some(&today), None, &cost::load_pricing(), &tk, None, now_unix());
        assert!(r["today_cost"].as_f64().is_some(), "today_cost 必须有数");
        assert_eq!(r["peak_over"], true);
    }

    /// 过期 snooze 自动失效 —— 不需要 cron / event 触发。
    #[test]
    fn snooze_clears_on_overdue() {
        let tk = today_key();
        let today = json!({
            "date": tk,
            "buckets": {"14": flat_bucket(30_000_000)},
            "schema_version": "1.0.0",
        });
        let past = "2020-01-01T00:00:00+08:00";
        let r = evaluate_alert(&cfg(), Some(&today), None, &cost::load_pricing(), &tk, Some(past), now_unix());
        assert_eq!(r["snoozed_until"], Value::Null);
        assert_eq!(r["level"], "over");
    }

    /// 未来 snooze → 输出原串（snoozed_until 透出），warn/over 被压成 snoozed。
    #[test]
    fn future_snooze_suppresses_warn_over() {
        let tk = today_key();
        let today = json!({
            "date": tk,
            "buckets": {"14": flat_bucket(30_000_000)},
            "schema_version": "1.0.0",
        });
        let future = "2999-12-31T23:59:59+08:00";
        let r = evaluate_alert(&cfg(), Some(&today), None, &cost::load_pricing(), &tk, Some(future), now_unix());
        assert_eq!(r["snoozed_until"], future);
        assert_eq!(r["level"], "snoozed");
    }

    /// 裸 ISO 串（无 tzinfo）不应炸 —— Python 侧把它按北京时间解释后比较。
    #[test]
    fn naive_snooze_is_accepted() {
        let tk = today_key();
        let future = "2999-12-31T23:59:59"; // 裸，无 +08:00
        let r = evaluate_alert(&cfg(), None, None, &cost::load_pricing(), &tk, Some(future), now_unix());
        // 输出补 +08:00 —— 与 Python `dt.replace(tzinfo=BEIJING).isoformat()` 同构
        assert_eq!(r["snoozed_until"], "2999-12-31T23:59:59+08:00");
    }

    /// 自适应 floor：7 日均 × 1.5 > user_set → 用 floor（spec §5.2）。
    #[test]
    fn adaptive_floor_raises_threshold_when_avg_high() {
        let tk = today_key();
        let mut days = serde_json::Map::new();
        for offset in 0..7i64 {
            let (y, m, d) = civil_from_days(parse_date_days(&tk).unwrap() - offset);
            let key = format!("{y:04}-{m:02}-{d:02}");
            days.insert(key, flat_bucket(50_000_000)); // ¥100/天 ×1.5 = ¥150 > ¥30
        }
        let days = Value::Object(days);
        let r = evaluate_alert(&cfg(), None, Some(&days), &cost::load_pricing(), &tk, None, now_unix());
        assert_eq!(r["adaptive_floor_applied"], true);
        assert!(r["effective_daily_budget"].as_f64().unwrap() > 30.0);
    }

    /// parse_iso 的已知 oracle：`datetime.fromtimestamp(secs, UTC+8)`。
    #[test]
    fn parse_iso_matches_known_epoch() {
        // 2026-08-28 14:53:00 UTC+8 == epoch 1787899980（python3 oracle 验算：
        // 1787900000 是 14:53:20，手推会偏 20s）。
        let (epoch, explicit) = parse_iso("2026-08-28T14:53:00+08:00").unwrap();
        assert_eq!(epoch, 1787899980);
        assert!(explicit);
        // 裸串按 +08:00 解释 → 同一时刻
        let (epoch2, explicit2) = parse_iso("2026-08-28T14:53:00").unwrap();
        assert_eq!(epoch2, 1787899980);
        assert!(!explicit2);
        // 带微秒 fraction
        let (epoch3, _) = parse_iso("2026-08-28T14:53:00.123456+08:00").unwrap();
        assert_eq!(epoch3, 1787899980);
    }
}
