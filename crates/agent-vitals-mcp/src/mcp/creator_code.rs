//! Code Game 状态面（MCP 只读）。
//!
//! 两个生产者写、一个消费者读：
//! - 构建器（`packages/city-game-sdk/scripts/buildGame.ts`）在成功的构建上写
//!   `<data_home>/state/creator/code-games/{index.json,builds/<buildId>.json}`；
//! - City 预览（Tauri `code_game_preview_state`）写 `preview.json`；
//! - 这里的工具只做**有界读取**，不执行构建、不打开工作区、不返回物理路径。
//!
//! 构建身份永远是内容摘要 `buildId`；本模块的索引只是状态投影，不能当作
//! 构建权威——删除索引不会改变任何一个已构建 bundle 的身份。
use std::path::Path;

use serde_json::{json, Value};

use super::{ToolError, ToolSpec};

const MAX_LIMIT: u64 = 50;
const PREVIEW_STALE_MS: u64 = 120_000;
const BUILD_ID_HEX: usize = 64;

fn spec(name: &'static str, description: &'static str, properties: Value, required: &[&str]) -> ToolSpec {
    ToolSpec {
        name,
        description,
        input_schema: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        output_schema: json!({"type":"object","properties":{"ok":{"type":"boolean"},"data":{"type":"object"}}}),
    }
}

pub fn specs() -> Vec<ToolSpec> {
    vec![
        spec(
            "creator_code_builds_list",
            "List recent Code Game builds recorded by the local build service (newest first, at most 50). Read-only: the list is a status projection keyed by content buildId, not a build trigger and not a filesystem listing.",
            json!({"limit":{"type":"integer","minimum":1,"maximum":50}}),
            &[],
        ),
        spec(
            "creator_code_build_status",
            "Read one Code Game build record by its 64-hex content buildId: game id, entry, bundle size, SDK/bundler versions and creation time. Never returns a filesystem path; not_found means the local build service has no such record.",
            json!({"buildId":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"}}),
            &["buildId"],
        ),
        spec(
            "creator_code_preview_status",
            "Read the last Code Game preview state published by the running City (gameId, buildId, runId, status, outcome, tick, entities, reason, updatedAtMs). available=false means no preview has run since the state file was last cleared; stale=true means the writer stopped updating over two minutes ago (crash or closed window), not that the game is still running.",
            json!({}),
            &[],
        ),
    ]
}

pub fn run(name: &str, args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let root = data_home.join("state/creator/code-games");
    match name {
        "creator_code_builds_list" => builds_list(&root, args),
        "creator_code_build_status" => build_status(&root, args),
        "creator_code_preview_status" => preview_status(&root),
        other => Err(ToolError::new("internal_error", format!("tool `{other}` registered but not wired"))),
    }
}

fn builds_list(root: &Path, args: &Value) -> Result<Value, ToolError> {
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20);
    if limit == 0 || limit > MAX_LIMIT {
        return Err(ToolError::new("invalid_argument", format!("`limit` must be from 1 to {MAX_LIMIT}")));
    }
    let index = read_json(&root.join("index.json")).unwrap_or(Value::Null);
    let empty = Vec::new();
    let items = index.as_array().unwrap_or(&empty);
    let mut builds = Vec::new();
    for item in items.iter().take(limit as usize) {
        if let Some(record) = build_record(item) {
            builds.push(record);
        }
    }
    Ok(json!({"ok":true,"data":{"builds":builds,"total":builds.len()}}))
}

fn build_status(root: &Path, args: &Value) -> Result<Value, ToolError> {
    let build_id = args.get("buildId").and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("invalid_argument", "`buildId` is required"))?;
    if build_id.len() != BUILD_ID_HEX || !build_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(ToolError::new("invalid_argument", "`buildId` must be a 64-character lower-case hex digest"));
    }
    let value = read_json(&root.join("builds").join(format!("{build_id}.json")))
        .ok_or_else(|| ToolError::new("not_found", "No local build record for that buildId."))?;
    let record = build_record(&value)
        .ok_or_else(|| ToolError::new("data_unavailable", "The build record is malformed."))?;
    Ok(json!({"ok":true,"data":record}))
}

fn preview_status(root: &Path) -> Result<Value, ToolError> {
    let Some(value) = read_json(&root.join("preview.json")) else {
        return Ok(json!({"ok":true,"data":{"available":false,"status":"unavailable","reason":"no_preview"}}));
    };
    let updated_at = value.get("updatedAtMs").and_then(Value::as_u64).unwrap_or(0);
    let now = now_ms();
    let data = json!({
        "available": true,
        "status": text(&value, "status", 32).unwrap_or_else(|| "unknown".to_string()),
        "gameId": text(&value, "gameId", 128),
        "previewId": text(&value, "previewId", 128),
        "buildId": text(&value, "buildId", 64),
        "runId": text(&value, "runId", 64),
        "reason": text(&value, "reason", 120),
        "outcome": text(&value, "outcome", 16),
        "tick": value.get("tick").and_then(Value::as_u64),
        "entities": value.get("entities").and_then(Value::as_u64),
        "updatedAtMs": if updated_at == 0 { Value::Null } else { json!(updated_at) },
        "stale": updated_at == 0 || now.saturating_sub(updated_at) > PREVIEW_STALE_MS,
    });
    Ok(json!({"ok":true,"data":data}))
}

/// Whitelist projection: a record may carry extra internal fields later, but the
/// MCP face never forwards them. No paths, no asset list, no prompt content.
fn build_record(value: &Value) -> Option<Value> {
    let build_id = text(value, "buildId", 64)?;
    if build_id.len() != BUILD_ID_HEX {
        return None;
    }
    Some(json!({
        "buildId": build_id,
        "gameId": text(value, "gameId", 128)?,
        "gameVersion": text(value, "gameVersion", 32),
        "entry": text(value, "entry", 200),
        "bundle": text(value, "bundle", 128),
        "byteLength": value.get("byteLength").and_then(Value::as_u64),
        "sdkVersion": text(value, "sdkVersion", 32),
        "bundler": text(value, "bundler", 64),
        "createdAtMs": value.get("createdAtMs").and_then(Value::as_u64),
    }))
}

fn text(value: &Value, key: &str, max: usize) -> Option<String> {
    value.get(key).and_then(Value::as_str)
        .filter(|item| !item.is_empty() && item.len() <= max)
        .map(ToString::to_string)
}

fn read_json(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 256 * 1024 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_home(tag: &str) -> PathBuf {
        let nanos = now_ms();
        let home = std::env::temp_dir().join(format!("code-game-mcp-{tag}-{nanos}"));
        std::fs::create_dir_all(home.join("state/creator/code-games/builds")).expect("temp dir");
        home
    }

    fn write(path: &Path, value: Value) {
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[test]
    fn builds_list_is_bounded_and_projects_only_whitelisted_fields() {
        let home = temp_home("list");
        let root = home.join("state/creator/code-games");
        write(&root.join("index.json"), json!([
            {"buildId": "a".repeat(64), "gameId": "community.hello-city", "byteLength": 10,
             "internalPath": "/Users/secret/game.js"},
            {"buildId": "not-hex", "gameId": "bad"},
        ]));
        let result = run("creator_code_builds_list", &json!({"limit": 5}), &home).unwrap();
        let builds = result["data"]["builds"].as_array().unwrap();
        assert_eq!(builds.len(), 1);
        assert_eq!(builds[0]["gameId"], "community.hello-city");
        assert!(builds[0].get("internalPath").is_none());
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn build_status_reads_one_record_and_rejects_malformed_ids() {
        let home = temp_home("status");
        let root = home.join("state/creator/code-games");
        let id = "b".repeat(64);
        write(&root.join("builds").join(format!("{id}.json")),
            json!({"buildId": id, "gameId": "community.hello-city", "byteLength": 42, "entry": "src/index.ts"}));
        let found = run("creator_code_build_status", &json!({"buildId": id}), &home).unwrap();
        assert_eq!(found["data"]["byteLength"], 42);
        assert!(run("creator_code_build_status", &json!({"buildId": "../../etc/passwd"}), &home).is_err());
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn preview_status_is_absent_until_a_preview_publishes_one() {
        let home = temp_home("preview-empty");
        let result = run("creator_code_preview_status", &json!({}), &home).unwrap();
        assert_eq!(result["data"]["available"], false);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn preview_status_reports_staleness_from_updated_at() {
        let home = temp_home("preview");
        let root = home.join("state/creator/code-games");
        write(&root.join("preview.json"), json!({
            "status": "running", "gameId": "community.hello-city", "runId": "run-7",
            "tick": 12, "entities": 1, "updatedAtMs": now_ms(),
        }));
        let fresh = run("creator_code_preview_status", &json!({}), &home).unwrap();
        assert_eq!(fresh["data"]["status"], "running");
        assert_eq!(fresh["data"]["stale"], false);

        write(&root.join("preview.json"), json!({
            "status": "running", "updatedAtMs": now_ms().saturating_sub(PREVIEW_STALE_MS + 1),
        }));
        let stale = run("creator_code_preview_status", &json!({}), &home).unwrap();
        assert_eq!(stale["data"]["stale"], true);
        std::fs::remove_dir_all(home).ok();
    }
}
