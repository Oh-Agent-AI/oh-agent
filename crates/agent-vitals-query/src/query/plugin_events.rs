//! Bounded, plugin-scoped local notification queue.
//!
//! Event bodies are opaque JSON objects. This module does not interpret app
//! schemas, and plugin WebViews cannot publish through this internal Rust API.
use std::path::Path;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;

const MAX_EVENT_BYTES: usize = 64 * 1024;
const MAX_RETAINED_EVENTS: usize = 256;
const MAX_PAGE_SIZE: usize = 128;

#[derive(Debug, Clone, PartialEq)]
pub struct PluginEvent {
    pub sequence: i64,
    pub event_id: String,
    pub payload: Value,
}
fn valid_plugin_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64
        && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_event_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn open(home: &Path) -> Result<Connection, &'static str> {
    let dir = home.join("state/plugin-events");
    std::fs::create_dir_all(&dir).map_err(|_| "plugin_event_store_unavailable")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "plugin_event_store_unavailable")?;
    }
    let path = dir.join("events.sqlite");
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_| "plugin_event_store_unavailable")?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_| "plugin_event_store_unavailable")?;
    db.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS plugin_events(
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            plugin_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            payload TEXT NOT NULL,
            UNIQUE(plugin_id,event_id)
        );
        CREATE INDEX IF NOT EXISTS plugin_events_page ON plugin_events(plugin_id,sequence);")
        .map_err(|_| "plugin_event_store_unavailable")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "plugin_event_store_unavailable")?;
    }
    Ok(db)
}

/// Append an event idempotently, retaining only the newest bounded page for
/// this plugin. The caller is trusted Rust code; no plugin IPC routes here.
pub fn publish(home: &Path, plugin_id: &str, event_id: &str, payload: &Value) -> Result<(), &'static str> {
    if !valid_plugin_id(plugin_id) || !valid_event_id(event_id) || !payload.is_object() {
        return Err("plugin_event_invalid");
    }
    let body = serde_json::to_string(payload).map_err(|_| "plugin_event_invalid")?;
    if body.len() > MAX_EVENT_BYTES { return Err("plugin_event_too_large"); }
    let db = open(home)?;
    db.execute("INSERT OR IGNORE INTO plugin_events(plugin_id,event_id,created_at_ms,payload) VALUES(?1,?2,?3,?4)",
        params![plugin_id, event_id, crate::clock::now_ms(), body]).map_err(|_| "plugin_event_store_unavailable")?;
    db.execute("DELETE FROM plugin_events WHERE plugin_id=?1 AND sequence NOT IN
        (SELECT sequence FROM plugin_events WHERE plugin_id=?1 ORDER BY sequence DESC LIMIT ?2)",
        params![plugin_id, MAX_RETAINED_EVENTS as i64]).map_err(|_| "plugin_event_store_unavailable")?;
    Ok(())
}

/// Current high-water mark. A new host subscriber starts here, so stale local
/// notifications are not replayed across app restarts.
pub fn latest_cursor(home: &Path, plugin_id: &str) -> Result<i64, &'static str> {
    if !valid_plugin_id(plugin_id) { return Err("plugin_event_invalid"); }
    let db = open(home)?;
    db.query_row("SELECT COALESCE(MAX(sequence),0) FROM plugin_events WHERE plugin_id=?1", [plugin_id], |row| row.get(0))
        .map_err(|_| "plugin_event_store_unavailable")
}

/// Return the next bounded ordered page after a host-owned opaque sequence.
pub fn page_after(home: &Path, plugin_id: &str, after: i64, limit: usize) -> Result<Vec<PluginEvent>, &'static str> {
    if !valid_plugin_id(plugin_id) || after < 0 || !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err("plugin_event_query_invalid");
    }
    let db = open(home)?;
    let mut statement = db.prepare("SELECT sequence,event_id,payload FROM plugin_events
        WHERE plugin_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")
        .map_err(|_| "plugin_event_store_unavailable")?;
    let rows = statement.query_map(params![plugin_id, after, limit as i64], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    }).map_err(|_| "plugin_event_store_unavailable")?;
    rows.map(|row| {
        let (sequence, event_id, body) = row.map_err(|_| "plugin_event_store_unavailable")?;
        let payload = serde_json::from_str(&body).map_err(|_| "plugin_event_store_unavailable")?;
        Ok(PluginEvent { sequence, event_id, payload })
    }).collect()
}
