//! Shared persisted control for automatic fact synchronization.
//!
//! The desktop app and the local MCP must read and write the same file so a
//! pause made through one control plane is observed by the other.

use std::path::Path;

use serde::{Deserialize, Serialize};

const CONFIG_FILE: &str = "sync-control.json";

#[derive(Debug, Deserialize, Serialize)]
struct SyncControl {
    paused: bool,
}

pub fn is_paused(data_home: &Path) -> Result<bool, String> {
    let path = data_home.join("state").join(CONFIG_FILE);
    if !path.exists() {
        return Ok(false);
    }
    let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str::<SyncControl>(&text)
        .map(|control| control.paused)
        .map_err(|error| format!("sync control is unreadable: {error}"))
}

pub fn set_paused(data_home: &Path, paused: bool) -> Result<(), String> {
    let directory = data_home.join("state");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let target = directory.join(CONFIG_FILE);
    let temporary = directory.join("sync-control.json.tmp");
    let contents = serde_json::to_vec(&SyncControl { paused })
        .map_err(|error| error.to_string())?;
    std::fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, target).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_defaults_to_running_and_round_trips() {
        let home = std::env::temp_dir().join(format!(
            "agent-vitals-sync-control-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&home);
        assert!(!is_paused(&home).unwrap());
        set_paused(&home, true).unwrap();
        assert!(is_paused(&home).unwrap());
        set_paused(&home, false).unwrap();
        assert!(!is_paused(&home).unwrap());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn malformed_file_fails_closed() {
        let home = std::env::temp_dir().join(format!(
            "agent-vitals-sync-control-invalid-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("state")).unwrap();
        std::fs::write(home.join("state").join(CONFIG_FILE), b"not json").unwrap();
        assert!(is_paused(&home).is_err());
        let _ = std::fs::remove_dir_all(home);
    }
}
