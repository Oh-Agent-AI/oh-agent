//! Claude Pro 额度窗口提醒的开关（默认关）。
//!
//! **为什么单独一个开关，而不是复用预算提醒的权限**：系统通知权限在 macOS 上
//! 必须由一次**用户动作**触发申请（本仓既有的做法是"保存预算时申请"，
//! REQ-039）。但额度窗口提醒与预算提醒是两件事——一个从不用预算的用户，不该
//! 因为没设过预算就永远收不到窗口提醒，也不该在没同意的情况下被动收到。
//! 所以它有自己显式的开关：**默认关**，打开的那一刻才申请权限。
//!
//! 文件损坏时 [`is_enabled`] 返回 `Err`，调用方按"关"处理（fail-closed：
//! 提醒类功能读不出开关就不提醒，绝不因为读不到而假定用户同意过）。

use std::path::Path;

use serde::{Deserialize, Serialize};

const CONFIG_FILE: &str = "quota-reminder.json";

#[derive(Debug, Deserialize, Serialize)]
struct QuotaReminder {
    enabled: bool,
}

/// 读开关。**文件缺场 = 关**（默认关，不是默认开）。
pub fn is_enabled(data_home: &Path) -> Result<bool, String> {
    let path = data_home.join("state").join(CONFIG_FILE);
    if !path.exists() {
        return Ok(false);
    }
    let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str::<QuotaReminder>(&text)
        .map(|config| config.enabled)
        .map_err(|error| format!("quota reminder config is unreadable: {error}"))
}

pub fn set_enabled(data_home: &Path, enabled: bool) -> Result<(), String> {
    let directory = data_home.join("state");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let target = directory.join(CONFIG_FILE);
    let temporary = directory.join("quota-reminder.json.tmp");
    let contents = serde_json::to_vec(&QuotaReminder { enabled })
        .map_err(|error| error.to_string())?;
    std::fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, target).map_err(|error| error.to_string())
}

/// 投递前判定：缺场/损坏/显式关，一律"不提醒"。
pub fn enabled_or_default(data_home: &Path) -> bool {
    is_enabled(data_home).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!(
            "av-quota-reminder-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&home);
        home
    }

    #[test]
    fn defaults_to_off_and_round_trips() {
        // 默认关是这条功能的要害：提醒类能力不能默认开。
        let home = tmp("roundtrip");
        assert!(!is_enabled(&home).unwrap(), "文件缺场必须是关");
        assert!(!enabled_or_default(&home));
        set_enabled(&home, true).unwrap();
        assert!(is_enabled(&home).unwrap());
        assert!(enabled_or_default(&home));
        set_enabled(&home, false).unwrap();
        assert!(!is_enabled(&home).unwrap());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn malformed_config_fails_closed() {
        // 读不出开关就不提醒——绝不因为读不到而假定用户同意过。
        let home = tmp("malformed");
        std::fs::create_dir_all(home.join("state")).unwrap();
        std::fs::write(home.join("state").join(CONFIG_FILE), b"not json").unwrap();
        assert!(is_enabled(&home).is_err());
        assert!(!enabled_or_default(&home), "损坏时必须按关处理");
        let _ = std::fs::remove_dir_all(home);
    }
}
