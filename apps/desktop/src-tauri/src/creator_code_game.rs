//! Code Game 预览状态的唯一写入口。
//!
//! City WebView 持有实时状态（tick/实体数/结束原因），但 MCP 是另一个进程；两边
//! 只共享 `<data_home>/state/creator/code-games/preview.json`。这里把 WebView
//! 上报的 DTO 收敛成**有界白名单**再落盘：状态词表、id 长度、计数值范围都在宿主
//! 侧校验，MCP 读取时不需要信任调用方。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MAX_ID: usize = 128;
const MAX_REASON: usize = 120;
const MAX_TICK: u64 = 100_000_000;
const MAX_ENTITIES: u64 = 4_096;

fn code_games_root(home: &Path) -> PathBuf {
    home.join("state/creator/code-games")
}

fn bounded(state: &Value, key: &str, max: usize) -> Option<String> {
    state
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= max)
        .map(ToString::to_string)
}

fn bounded_count(state: &Value, key: &str, max: u64) -> Option<u64> {
    state.get(key).and_then(Value::as_u64).filter(|value| *value <= max)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Persist one preview state snapshot. Idempotent and atomic (tmp + rename), so
/// a crash mid-write cannot leave a truncated record for MCP to parse.
///
/// Two entry points share it: the City plugin message (`plugin_message` is the
/// only channel a plugin webview may use — custom commands are rejected for
/// `plugin-*` webviews) and, for local tooling, the Tauri command below.
#[tauri::command]
pub fn code_game_preview_state(state: Value) -> Result<Value, String> {
    record_preview_state(&crate::overview::data_home(), &state)?;
    Ok(json!({"ok": true}))
}

pub(crate) fn record_preview_state(home: &Path, state: &Value) -> Result<(), String> {
    let status = match state.get("status").and_then(Value::as_str) {
        Some("starting") => "starting",
        Some("running") => "running",
        Some("finished") => "finished",
        Some("error") => "error",
        _ => return Err("code_game_state_invalid: unknown status".to_string()),
    };
    let record = json!({
        "status": status,
        "gameId": bounded(&state, "gameId", MAX_ID),
        "buildId": bounded(&state, "buildId", 64),
        "runId": bounded(&state, "runId", 64),
        "reason": bounded(&state, "reason", MAX_REASON),
        "tick": bounded_count(&state, "tick", MAX_TICK),
        "entities": bounded_count(&state, "entities", MAX_ENTITIES),
        "updatedAtMs": now_ms(),
    });
    let root = code_games_root(home);
    std::fs::create_dir_all(&root).map_err(|error| format!("code_game_state_unavailable: {error}"))?;
    let target = root.join("preview.json");
    let temporary = root.join("preview.json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(&record).map_err(|error| format!("code_game_state_invalid: {error}"))?)
        .map_err(|error| format!("code_game_state_unavailable: {error}"))?;
    std::fs::rename(&temporary, &target).map_err(|error| format!("code_game_state_unavailable: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_is_bounded_atomic_and_whitelisted() {
        let home = std::env::temp_dir().join(format!("code-game-state-{}-{}", now_ms(), std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        record_preview_state(
            &home,
            &json!({
                "status": "running",
                "gameId": "community.hello-city",
                "runId": "run-7",
                "tick": 12,
                "entities": 1,
                "secret": "/Users/someone/private",
                "tickTooLarge": 999_999_999_999_u64,
            }),
        )
        .unwrap();
        let path = home.join("state/creator/code-games/preview.json");
        let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["status"], "running");
        assert_eq!(value["tick"], 12);
        assert!(value.get("secret").is_none(), "unknown fields must not be persisted");
        assert!(record_preview_state(&home, &json!({"status": "nope"})).is_err());
        std::fs::remove_dir_all(&home).ok();
    }
}
