//! 统计时区偏好：默认使用 OS IANA 时区，用户设置后持久化到数据根。
//!
//! 供应商价格规则不读取这里的值；它只定义统计日/月/小时窗口以及本地展示。

use std::path::Path;

use jiff::tz::TimeZone;
use serde_json::{json, Value};

const CONFIG_FILE: &str = "statistics-timezone.json";

/// 「跟随系统」的保存哨兵。**不写时区名**：曾把当时读到的系统时区名写进文件，
/// 于是「跟随系统」其实是「固定成保存那刻的值」，换时区后不跟、读错时还会把 UTC 固化。
/// 现在选它就删配置文件——没有文件即跟随系统（`timezone_name` 早就是这个语义）。
pub const FOLLOW_SYSTEM: &str = "system";

/// 进程启动时的原始 `TZ`（apply 第一次调用前抓一次）。切回跟随系统时据此还原，
/// 否则 `TZ` 会残留上一次选的自定义时区。
static ORIGINAL_TZ: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// 当前是否跟随系统（没有偏好文件）。文件损坏按错误上报，不静默当作跟随。
pub fn follows_system(data_home: &Path) -> Result<bool, String> {
    let path = data_home.join("state").join(CONFIG_FILE);
    match std::fs::metadata(&path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!("statistics timezone unreadable: {error}")),
    }
}

/// 读取用户统计时区；缺少配置时回退到系统 IANA 时区。
pub fn timezone_name(data_home: &Path) -> Result<String, String> {
    let path = data_home.join("state").join(CONFIG_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(crate::clock::system_timezone_name());
        }
        Err(error) => return Err(format!("statistics timezone unreadable: {error}")),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("statistics timezone is invalid: {error}"))?;
    let name = value.get("timezone").and_then(Value::as_str)
        .ok_or_else(|| "statistics timezone has no timezone value".to_string())?;
    validate_timezone(name)?;
    Ok(name.to_string())
}

/// 校验并原子保存用户统计时区。
pub fn save_timezone(data_home: &Path, name: &str) -> Result<String, String> {
    if name == FOLLOW_SYSTEM {
        match std::fs::remove_file(data_home.join("state").join(CONFIG_FILE)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        return Ok(FOLLOW_SYSTEM.to_string());
    }
    validate_timezone(name)?;
    let directory = data_home.join("state");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let temporary = directory.join("statistics-timezone.json.tmp");
    let target = directory.join(CONFIG_FILE);
    let contents = serde_json::to_vec(&json!({ "timezone": name }))
        .map_err(|error| error.to_string())?;
    std::fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, target).map_err(|error| error.to_string())?;
    Ok(name.to_string())
}

/// 将已保存的偏好应用到当前进程，使 SQLite `localtime` 与 Jiff 使用同一时区。
/// 未配置时保持 OS 环境不变；配置损坏不会静默切换到另一个时区。
pub fn apply(data_home: &Path) -> Result<String, String> {
    let original = ORIGINAL_TZ.get_or_init(|| std::env::var("TZ").ok());
    let name = timezone_name(data_home)?;
    if follows_system(data_home)? {
        match original { Some(value) => std::env::set_var("TZ", value), None => std::env::remove_var("TZ") }
    } else {
        std::env::set_var("TZ", &name);
    }
    Ok(name)
}

pub fn validate_timezone(name: &str) -> Result<(), String> {
    if name.trim() != name || name.is_empty() || name.contains('\0') {
        return Err("statistics timezone must be a non-empty IANA name".to_string());
    }
    TimeZone::get(name)
        .map(|_| ())
        .map_err(|error| format!("unknown IANA statistics timezone {name:?}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_home(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("agent-vitals-statistics-timezone-{name}-{}", std::process::id()))
    }

    #[test]
    fn follow_system_removes_the_file_instead_of_pinning_a_zone() {
        // 回归：「跟随系统」曾保存当时读到的时区名（UTC 一旦读错就被固化）。
        let home = temporary_home("follow");
        let _ = std::fs::remove_dir_all(&home);
        assert!(follows_system(&home).unwrap());
        save_timezone(&home, "America/Los_Angeles").unwrap();
        assert!(!follows_system(&home).unwrap());
        assert_eq!(timezone_name(&home).unwrap(), "America/Los_Angeles");
        assert_eq!(save_timezone(&home, FOLLOW_SYSTEM).unwrap(), FOLLOW_SYSTEM);
        assert!(follows_system(&home).unwrap());
        assert_eq!(timezone_name(&home).unwrap(), crate::clock::system_timezone_name());
        // 幂等：已经跟随时再选一次不报错
        assert_eq!(save_timezone(&home, FOLLOW_SYSTEM).unwrap(), FOLLOW_SYSTEM);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn absent_config_uses_system_timezone() {
        let home = temporary_home("default");
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(timezone_name(&home).unwrap(), crate::clock::system_timezone_name());
    }

    #[test]
    fn save_round_trips_and_rejects_unknown_zone() {
        let home = temporary_home("save");
        let _ = std::fs::remove_dir_all(&home);
        assert!(save_timezone(&home, "not/a-zone").is_err());
        assert_eq!(save_timezone(&home, "America/Los_Angeles").unwrap(), "America/Los_Angeles");
        assert_eq!(timezone_name(&home).unwrap(), "America/Los_Angeles");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn malformed_config_fails_closed() {
        let home = temporary_home("invalid");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("state")).unwrap();
        std::fs::write(home.join("state").join(CONFIG_FILE), b"not json").unwrap();
        assert!(timezone_name(&home).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }
}
