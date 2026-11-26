//! Code Game 状态面（MCP 只读）。
//!
//! 两个生产者写、一个消费者读：
//! - 构建器（`packages/city-game-sdk/scripts/buildGame.ts`）在成功的构建上写
//!   `<data_home>/state/creator/code-games/{index.json,builds/<buildId>.json}`；
//! - City 预览（宿主 `creator_code_game::record_preview_state`）写有界白名单记录到
//!   每个 Preview 自己的 `previews/<previewId>/state.json`（权威面），同时把同一
//!   记录写到 legacy `preview.json`（"最近写者"投影，隔离 Spec §5.2 兼容面）；
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
const MAX_PREVIEW_ID: usize = 128;

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
            "Read a Code Game preview state (gameId, buildId, runId, status, outcome, tick, entities, reason, updatedAtMs). Without `previewId` this is the legacy projection: whatever preview published most recently (last writer wins). With `previewId` it reads exactly that preview's own authoritative record, safe when several previews exist side by side. available=false means the requested preview has no published state (legacy mode: no preview has run since the state file was last cleared); stale=true means that preview's writer stopped updating over two minutes ago (crash or closed window), not that the game is still running. Read-only: previews are started, stopped and installed through the City UI, not here.",
            json!({"previewId":{"type":"string","minLength":1,"maxLength":128}}),
            &[],
        ),
    ]
}

pub fn run(name: &str, args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let root = data_home.join("state/creator/code-games");
    match name {
        "creator_code_builds_list" => builds_list(&root, args),
        "creator_code_build_status" => build_status(&root, args),
        "creator_code_preview_status" => preview_status(&root, args),
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

/// 与宿主 dispatch（`creator.code.preview.status`，creator_projects.rs
/// `run_code_status`）对齐的双读法分支：带 `previewId` 读该 Preview 自己的
/// 权威记录，不带则维持 legacy `preview.json` 读法不变。
fn preview_status(root: &Path, args: &Value) -> Result<Value, ToolError> {
    let preview_id = match args.get("previewId") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_str().ok_or_else(|| ToolError::new("invalid_argument", "`previewId` must be a string"))?),
    };
    match preview_id {
        Some(preview_id) => preview_status_for(root, preview_id),
        None => preview_status_legacy(root),
    }
}

/// 同宿主 `valid_preview_id`：非空、≤128、首字符 ASCII 字母数字、其余只允许
/// 字母数字/`_`/`-`——同时挡掉路径注入（`../`、绝对路径、`.`）。
fn valid_preview_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_PREVIEW_ID
        && value.starts_with(|c: char| c.is_ascii_alphanumeric())
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// 按 previewId 的权威读法：`previews/<previewId>/state.json`（宿主
/// `studio_status_for` 同源数据）。previewId 字段回显请求值，记录缺失时
/// 返回结构化 absent，而不是错误。
fn preview_status_for(root: &Path, preview_id: &str) -> Result<Value, ToolError> {
    if !valid_preview_id(preview_id) {
        return Err(ToolError::new("invalid_argument",
            "`previewId` must be 1-128 characters: ASCII letters/digits (plus `_`/`-` after the first)"));
    }
    let Some(value) = read_json(&root.join("previews").join(preview_id).join("state.json")) else {
        return Ok(json!({"ok":true,"data":{"available":false,"status":"unavailable","previewId":preview_id,"reason":"no_preview"}}));
    };
    Ok(json!({"ok":true,"data":preview_record(&value, Some(preview_id))}))
}

/// Legacy 读法（隔离 Spec §5.2 兼容面）：只反映最近一个 Preview（最后写者）。
fn preview_status_legacy(root: &Path) -> Result<Value, ToolError> {
    let Some(value) = read_json(&root.join("preview.json")) else {
        return Ok(json!({"ok":true,"data":{"available":false,"status":"unavailable","reason":"no_preview"}}));
    };
    Ok(json!({"ok":true,"data":preview_record(&value, None)}))
}

/// 白名单投影：两个字段全集与 legacy 读法一致，只有 previewId 的取值不同
/// （per-preview 读法回显请求值，legacy 读法取记录里的最后写者值）。
fn preview_record(value: &Value, requested_preview_id: Option<&str>) -> Value {
    let updated_at = value.get("updatedAtMs").and_then(Value::as_u64).unwrap_or(0);
    let now = now_ms();
    json!({
        "available": true,
        "status": text(value, "status", 32).unwrap_or_else(|| "unknown".to_string()),
        "gameId": text(value, "gameId", 128),
        "previewId": requested_preview_id.map(String::from).or_else(|| text(value, "previewId", 128)),
        "buildId": text(value, "buildId", 64),
        "runId": text(value, "runId", 64),
        "reason": text(value, "reason", 120),
        "outcome": text(value, "outcome", 16),
        "tick": value.get("tick").and_then(Value::as_u64),
        "entities": value.get("entities").and_then(Value::as_u64),
        "updatedAtMs": if updated_at == 0 { Value::Null } else { json!(updated_at) },
        "stale": updated_at == 0 || now.saturating_sub(updated_at) > PREVIEW_STALE_MS,
    })
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

    /// P1-5a：带 previewId 的读法必须命中该 Preview 自己的
    /// `previews/<previewId>/state.json`（宿主 `studio_status_for` 同源数据），
    /// 不带则维持 legacy `preview.json`（最近写者）。多 Preview 并存时两条
    /// previewId 读法互不覆盖，legacy 只能看到最后写者——这正是隔离
    /// Spec §5.2 的 per-previewId 权威面契约。
    #[test]
    fn preview_status_accepts_an_optional_preview_id_and_reads_both_ways() {
        let home = temp_home("preview-id");
        let root = home.join("state/creator/code-games");
        std::fs::create_dir_all(root.join("previews/preview-A")).expect("preview dir");
        std::fs::create_dir_all(root.join("previews/preview-B")).expect("preview dir");
        let now = now_ms();
        write(&root.join("previews/preview-A/state.json"), json!({
            "status": "running", "gameId": "community.hello-city", "previewId": "preview-A",
            "buildId": "c".repeat(64), "runId": "run-A",
            "tick": 12, "entities": 2, "outcome": "success", "updatedAtMs": now,
        }));
        write(&root.join("previews/preview-B/state.json"), json!({
            "status": "paused", "gameId": "community.traffic-lane", "previewId": "preview-B",
            "buildId": "d".repeat(64), "runId": "run-B",
            "tick": 30, "entities": 5, "updatedAtMs": now,
        }));
        // 宿主 record_preview_state 同时把最后写者投影进 legacy preview.json。
        write(&root.join("preview.json"), json!({
            "status": "paused", "gameId": "community.traffic-lane", "previewId": "preview-B",
            "buildId": "d".repeat(64), "runId": "run-B",
            "tick": 30, "entities": 5, "updatedAtMs": now,
        }));

        // 无 previewId：维持现状，读 legacy preview.json（最后写者 preview-B）。
        let legacy = run("creator_code_preview_status", &json!({}), &home).unwrap();
        assert_eq!(legacy["data"]["available"], true);
        assert_eq!(legacy["data"]["previewId"], "preview-B");
        assert_eq!(legacy["data"]["tick"], 30);

        // 带 previewId：精确读各自的权威记录，两条读法不互相覆盖。
        let per_a = run("creator_code_preview_status", &json!({"previewId": "preview-A"}), &home).unwrap();
        assert_eq!(per_a["data"]["available"], true);
        assert_eq!(per_a["data"]["previewId"], "preview-A");
        assert_eq!(per_a["data"]["gameId"], "community.hello-city");
        assert_eq!(per_a["data"]["tick"], 12);
        assert_eq!(per_a["data"]["stale"], false);
        let per_b = run("creator_code_preview_status", &json!({"previewId": "preview-B"}), &home).unwrap();
        assert_eq!(per_b["data"]["previewId"], "preview-B");
        assert_eq!(per_b["data"]["tick"], 30);

        // 白名单投影不因新读法引入额外字段（与 legacy 字段全集一致）。
        let keys: Vec<&str> = per_a["data"].as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["available", "status", "gameId", "previewId", "buildId", "runId",
            "reason", "outcome", "tick", "entities", "updatedAtMs", "stale"]);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn preview_status_rejects_malformed_preview_ids_and_reports_absence_structurally() {
        let home = temp_home("preview-id-bad");
        // 路径注入 / 空串 / 超长 / 非 ASCII / 类型错误都在参数校验阶段拒绝，
        // 不发生任何文件读取。
        for bad in ["../../etc/passwd", "", "preview/../escape", "/abs/path", "preview*",
                    "a".repeat(MAX_PREVIEW_ID + 1).as_str(), "预览-1"] {
            let error = run("creator_code_preview_status", &json!({"previewId": bad}), &home).unwrap_err();
            assert_eq!(error.code, "invalid_argument", "previewId {bad:?} must be rejected");
        }
        let error = run("creator_code_preview_status", &json!({"previewId": 7}), &home).unwrap_err();
        assert_eq!(error.code, "invalid_argument", "mistyped previewId must be rejected, not silently treated as legacy");
        // 合法格式但无记录：结构化 absent + 回显请求的 previewId（非错误）。
        let absent = run("creator_code_preview_status", &json!({"previewId": "preview-missing"}), &home).unwrap();
        assert_eq!(absent["data"]["available"], false);
        assert_eq!(absent["data"]["status"], "unavailable");
        assert_eq!(absent["data"]["previewId"], "preview-missing");
        assert_eq!(absent["data"]["reason"], "no_preview");
        std::fs::remove_dir_all(home).ok();
    }

    /// P2-5b 负向清单：`creator.code.install.{preview,commit,list}` 只存在于
    /// 宿主 desktop dispatch（安装经 Studio UI 授权链，RFC 隔离 Spec §4.2），
    /// **刻意缺席**于网络面 MCP。这三个名字（及其 snake_case MCP 命名空间）
    /// 永远不得出现在 `tool_specs()`——防止未来误把安装事务暴露给 MCP。
    #[test]
    fn code_game_install_transaction_names_stay_off_the_mcp_tool_face() {
        let names: Vec<_> = crate::mcp::tool_specs().iter().map(|tool| tool.name).collect();
        for name in ["creator_code_install_preview", "creator_code_install_commit", "creator_code_install_list"] {
            assert!(!names.contains(&name), "code game install transaction must never be an MCP tool: {name}");
        }
        assert!(!names.iter().any(|name| name.starts_with("creator_code_install")),
            "no creator_code_install* tool may be registered (install goes through the Studio UI authorization chain)");
        // 宿主侧方法名（dotted）也不是 MCP 工具名。
        for method in ["creator.code.install.preview", "creator.code.install.commit", "creator.code.install.list"] {
            assert!(!names.contains(&method), "host dispatch method `{method}` must not leak onto the MCP tool face");
        }
    }

    /// P2-5b：对缺席的安装方法直接 tools/call 必须得到稳定错误（spec §11 的
    /// `not_found`/`invalid_argument` 类）而不是 panic——传输层会把未注册名字
    /// 先挡成 JSON-RPC -32602（invalid params），库内 dispatch 兜底同样必须
    /// 是稳定码而非 internal_error/panic。
    #[test]
    fn calling_install_transaction_names_returns_a_stable_unregistered_tool_error() {
        for name in ["creator.code.install.preview", "creator.code.install.commit", "creator.code.install.list",
                     "creator_code_install_preview", "creator_code_install_commit", "creator_code_install_list"] {
            let error = crate::mcp::dispatch(name, &json!({}), Path::new("/unused"))
                .expect_err("unregistered install names must fail, not dispatch");
            assert!(matches!(error.code, "not_found" | "invalid_argument"),
                "unregistered tool `{name}` must map to not_found/invalid_argument, got {}", error.code);
            assert_ne!(error.code, "internal_error");
        }
    }
}
