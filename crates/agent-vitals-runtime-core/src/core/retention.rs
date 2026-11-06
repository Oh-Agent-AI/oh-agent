//! 本地导入数据的保留窗口。配置与事实库分开保存：改窗口不会在设置页立即
//! 删除数据，例行同步中的 maintenance run 才会应用它并留下审计记录。

use std::path::Path;

use serde_json::{json, Value};

pub const DEFAULT_RETENTION_MONTHS: u32 = 13;
pub const MIN_RETENTION_MONTHS: u32 = 1;
pub const MAX_RETENTION_MONTHS: u32 = 60;

const RETENTION_CONFIG_FILE: &str = "retention-config.json";

pub fn retention_months(data_home: &Path) -> Result<u32, String> {
    let path = data_home.join("state").join(RETENTION_CONFIG_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DEFAULT_RETENTION_MONTHS);
        }
        Err(error) => return Err(format!("retention configuration unreadable: {error}")),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("retention configuration is invalid: {error}"))?;
    let months = value.get("months").and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "retention configuration has no valid months value".to_string())?;
    validate_retention_months(months)?;
    Ok(months)
}

pub fn save_retention_months(data_home: &Path, months: u32) -> Result<(), String> {
    validate_retention_months(months)?;
    let directory = data_home.join("state");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let target = directory.join(RETENTION_CONFIG_FILE);
    let temporary = directory.join("retention-config.json.tmp");
    let contents = serde_json::to_vec(&json!({ "months": months }))
        .map_err(|error| error.to_string())?;
    std::fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, target).map_err(|error| error.to_string())
}

pub fn validate_retention_months(months: u32) -> Result<(), String> {
    if !(MIN_RETENTION_MONTHS..=MAX_RETENTION_MONTHS).contains(&months) {
        return Err(format!(
            "retention months must be between {MIN_RETENTION_MONTHS} and {MAX_RETENTION_MONTHS}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_home(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("agent-vitals-retention-{name}-{}", std::process::id()))
    }

    #[test]
    fn absent_config_defaults_to_thirteen_months() {
        let home = temporary_home("default");
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(retention_months(&home).unwrap(), DEFAULT_RETENTION_MONTHS);
    }

    #[test]
    fn save_round_trips_and_validates_range() {
        let home = temporary_home("save");
        let _ = std::fs::remove_dir_all(&home);
        save_retention_months(&home, 24).unwrap();
        assert_eq!(retention_months(&home).unwrap(), 24);
        assert!(save_retention_months(&home, 0).is_err());
        assert!(save_retention_months(&home, 61).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn malformed_config_fails_closed() {
        let home = temporary_home("invalid");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("state")).unwrap();
        std::fs::write(home.join("state").join(RETENTION_CONFIG_FILE), b"not json").unwrap();
        assert!(retention_months(&home).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }
}
