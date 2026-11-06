//! 读进程时钟的日期 helper——runtime 允许读时钟，domain 不许。
//!
//! v0.8 Phase D6：从二进制 `src/agent/codex_cost.rs` 迁进来。Python 镜像
//! `codex_cost.py` 通过同一系统时区规则保持差分对拍一致。

use jiff::{tz::TimeZone, Timestamp, ToSpan};

/// 北京时区当前自然月 → `YYYY-MM`。
pub fn current_month_beijing() -> String {
    current_month_system()
}

/// 北京时区今天 → `YYYY-MM-DD`。`--today` 的过滤键与输出契约的 `today` 字段。
pub fn today_beijing() -> String {
    today_system()
}

/// 北京时区昨天 → `YYYY-MM-DD`。v0.9 Stage 0.4 起给 `MonthlySummary`/
/// `DailySummary` 的新鲜度判断用（`rotate_today` 还没跑之前，最新一条真实
/// 记录可能停在昨天，不算"过期"）——直接减一天的秒数再走同一套 civil
/// 数学，不新引入日期库。
pub fn yesterday_beijing() -> String {
    yesterday_system()
}

/// 统计使用的系统 IANA 时区。Jiff 读取 macOS/Linux 的系统设置，并处理
/// `TZ` 覆盖、夏令时和历史偏移；供应商价格规则不得调用这个值来改写价卡。
pub fn system_timezone_name() -> String {
    os_timezone_name().unwrap_or_else(|| "UTC".to_string())
}

/// True when the OS timezone cannot be represented by an IANA identifier.
/// Callers may show the UTC fallback rather than silently presenting it as a user choice.
pub fn system_timezone_fallback() -> bool {
    os_timezone_name().is_none()
}

/// 操作系统真实时区，**不受进程内 `TZ` 影响**。`statistics_timezone::apply`
/// 启动时会把用户偏好写进 `TZ`，而 jiff 的 `TimeZone::system()` 优先读 `TZ`——
/// 曾因此「跟随系统」显示的是已保存的偏好（存过一次 UTC 就永远显示 UTC，
/// 系统实为 Asia/Shanghai），循环取值。unix 上直接解析 `/etc/localtime`
/// 软链；读不到再退回 jiff。
fn os_timezone_name() -> Option<String> {
    #[cfg(unix)]
    {
        if let Ok(target) = std::fs::read_link("/etc/localtime") {
            let text = target.to_string_lossy();
            if let Some(idx) = text.find("zoneinfo/") {
                let name = &text[idx + "zoneinfo/".len()..];
                if TimeZone::get(name).is_ok() {
                    return Some(name.to_string());
                }
            }
        }
    }
    TimeZone::system().iana_name().map(str::to_string)
}

/// 统计时区：优先使用启动时由 statistics_timezone::apply 写入的 IANA
/// `TZ`，否则回退到 OS 时区。macOS 的系统时区对象不会因为进程内修改
/// `TZ` 而自动改变，因此统计计算不能只调用 `TimeZone::system()`。
pub fn statistics_timezone() -> TimeZone {
    let configured = std::env::var("TZ").ok().map(|value| value.trim_start_matches(':').to_string());
    configured
        .as_deref()
        .and_then(|name| TimeZone::get(name).ok())
        .unwrap_or_else(|| {
            // 跟随系统（没有 TZ 覆盖）：直接按 OS 真实 IANA 名取，不依赖 jiff 的 system() 缓存。
            if let Some(name) = os_timezone_name() {
                if let Ok(zone) = TimeZone::get(&name) { return zone; }
            }
            let system = TimeZone::system();
            if system.iana_name().is_some() { system } else { TimeZone::UTC }
        })
}

/// 当前统计口径实际使用的 IANA 时区名称。与 [`statistics_timezone`] 同源，
/// 包括启动时应用的持久化用户偏好；不要用 [`system_timezone_name`] 表示
/// 统计结果，因为用户可以在系统时区之外选择统计时区。
pub fn statistics_timezone_name() -> String {
    statistics_timezone().iana_name().unwrap_or("UTC").to_string()
}

fn system_now() -> jiff::Zoned {
    Timestamp::now().to_zoned(statistics_timezone())
}

fn format_zoned_date(date: jiff::civil::Date) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// 将一个绝对时间按指定 IANA 时区投影为统计日期。该函数只改变展示/统计
/// 边界，不改变输入的 epoch 时间，也不参与供应商价格时区判断。
pub fn date_for_unix_secs_in_timezone(unix_secs: i64, timezone: &str) -> Option<String> {
    let zone = TimeZone::get(timezone).ok()?;
    let timestamp = Timestamp::from_second(unix_secs).ok()?;
    Some(format_zoned_date(timestamp.to_zoned(zone).date()))
}

/// 返回指定绝对时间在 IANA 时区中的实际偏移，用于统计边界计算和 DST 回归测试。
pub fn offset_seconds_for_unix_secs_in_timezone(unix_secs: i64, timezone: &str) -> Option<i32> {
    let zone = TimeZone::get(timezone).ok()?;
    let timestamp = Timestamp::from_second(unix_secs).ok()?;
    Some(timestamp.to_zoned(zone).offset().seconds())
}

/// 将 Unix 秒按系统 IANA 时区格式化为菜单栏使用的本地时间文本。
/// 输入仍是绝对时间；只有展示时区变化，供应商价格规则不读取此值。
pub fn local_timestamp_text(unix_secs: i64) -> String {
    let timestamp = Timestamp::from_second(unix_secs)
        .unwrap_or_else(|_| Timestamp::from_second(0).expect("Unix epoch is valid"));
    timestamp
        .to_zoned(statistics_timezone())
        .strftime("%Y-%m-%d %H:%M:%S")
        .to_string()
}

/// 系统统计时区的当前自然月 → `YYYY-MM`。
pub fn current_month_system() -> String {
    let date = system_now().date();
    format!("{:04}-{:02}", date.year(), date.month())
}

/// 系统统计时区的今天 → `YYYY-MM-DD`。
pub fn today_system() -> String {
    format_zoned_date(system_now().date())
}

/// 系统统计时区的昨天。使用 civil date 运算而不是减去 24 小时，避免夏令时
/// 切换日把“昨天”错算成同一天或跳过一天。
pub fn yesterday_system() -> String {
    let date = system_now().date().checked_sub(1.days()).unwrap_or_else(|_| system_now().date());
    format_zoned_date(date)
}

/// 注入时钟（Phase 1.5）：runtime 是唯一读时钟层。W3 从 `ingest::sql_sync`
/// 下沉到这里——它是全 crate 最底层的依赖，不能挂在写入侧模块上。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_month_and_today_are_well_formed() {
        let m = current_month_beijing();
        assert!(m.len() == 7 && m.as_bytes()[4] == b'-' && m[..4].parse::<i32>().is_ok());
        let d = today_beijing();
        assert!(d.len() == 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-');
        assert!(d.starts_with(&m));
    }

    #[test]
    fn yesterday_is_strictly_before_today() {
        let y = yesterday_beijing();
        let t = today_beijing();
        assert!(y.len() == 10 && y.as_bytes()[4] == b'-' && y.as_bytes()[7] == b'-');
        assert!(y < t, "yesterday {y} should sort strictly before today {t}");
    }

    #[test]
    #[cfg(unix)]
    fn system_timezone_comes_from_os_link_not_process_tz() {
        // 回归：apply() 把已保存偏好写进 TZ 后，「跟随系统」曾回显该偏好而非 OS 时区。
        // 不改 TZ（全局状态会让并行测试互相污染）：断言有 /etc/localtime 时以它为准。
        if let Ok(target) = std::fs::read_link("/etc/localtime") {
            let text = target.to_string_lossy().to_string();
            if let Some(idx) = text.find("zoneinfo/") {
                assert_eq!(system_timezone_name(), &text[idx + "zoneinfo/".len()..]);
            }
        }
    }

    #[test]
    fn system_timezone_is_an_iana_name_and_dates_are_well_formed() {
        let tz = system_timezone_name();
        assert!(!tz.is_empty());
        assert_eq!(today_system().len(), 10);
        assert_eq!(current_month_system().len(), 7);
        assert!(yesterday_system() < today_system());
    }

    #[test]
    fn named_timezone_projection_respects_dst_without_changing_epoch() {
        // 2026-03-08 09:30Z is before the Los Angeles spring transition;
        // 10:30Z is after it. The epoch remains unchanged, only the local offset moves.
        assert_eq!(date_for_unix_secs_in_timezone(1_772_955_000, "America/Los_Angeles"), Some("2026-03-07".into()));
        assert_eq!(date_for_unix_secs_in_timezone(1_772_958_600, "America/Los_Angeles"), Some("2026-03-08".into()));
        assert_eq!(offset_seconds_for_unix_secs_in_timezone(1_772_962_200, "America/Los_Angeles"), Some(-28_800));
        assert_eq!(offset_seconds_for_unix_secs_in_timezone(1_772_965_800, "America/Los_Angeles"), Some(-25_200));
        assert_eq!(date_for_unix_secs_in_timezone(1_772_955_000, "not/a-zone"), None);
    }

    #[test]
    fn los_angeles_civil_days_have_23_and_25_hours_at_dst_boundaries() {
        // The same local midnight-to-midnight interval is not always 86,400 seconds.
        let spring_start = 1_772_956_800;
        let spring_end = 1_773_039_600;
        let autumn_start = 1_793_516_400;
        let autumn_end = 1_793_606_400;
        assert_eq!(spring_end - spring_start, 23 * 60 * 60);
        assert_eq!(autumn_end - autumn_start, 25 * 60 * 60);
        assert_eq!(date_for_unix_secs_in_timezone(spring_start, "America/Los_Angeles"), Some("2026-03-08".into()));
        assert_eq!(date_for_unix_secs_in_timezone(spring_end - 1, "America/Los_Angeles"), Some("2026-03-08".into()));
        assert_eq!(date_for_unix_secs_in_timezone(spring_end, "America/Los_Angeles"), Some("2026-03-09".into()));
        assert_eq!(date_for_unix_secs_in_timezone(autumn_start, "America/Los_Angeles"), Some("2026-11-01".into()));
        assert_eq!(date_for_unix_secs_in_timezone(autumn_end - 1, "America/Los_Angeles"), Some("2026-11-01".into()));
        assert_eq!(date_for_unix_secs_in_timezone(autumn_end, "America/Los_Angeles"), Some("2026-11-02".into()));
    }

    #[test]
    fn same_epoch_may_belong_to_different_statistical_months() {
        let epoch = 1_788_244_200; // 2026-09-01 06:30Z
        assert_eq!(date_for_unix_secs_in_timezone(epoch, "Asia/Shanghai"), Some("2026-09-01".into()));
        assert_eq!(date_for_unix_secs_in_timezone(epoch, "America/Los_Angeles"), Some("2026-08-31".into()));
    }
}
