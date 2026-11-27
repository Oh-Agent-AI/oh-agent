//! Code Game 自动化视觉试玩面（MCP，PR08）。
//!
//! 在「无头模拟（creator_code_test）」与「人工试玩」之间补上真实渲染的自动
//! 试玩：操作**独立的 Code Game Preview 窗口**（绝不触碰用户 live City/run），
//! 发送有界脚本输入、观察真实渲染态（`creator_code_preview_status`）、抓取
//! 有界截图并产出绑定 previewId/buildId 的结构化报告。
//!
//! 架构（与宿主 `creator_code_game` 的 PR08 节共用同一文件面，规则镜像）：
//! - 本模块按 `creator_code_workspace::stage_preview` 的既有先例对
//!   `state/creator/code-games/previews/<previewId>/` 做有界直写（不占用
//!   creator-studio 邮箱，Studio 在场与否都可用）；
//! - 桌面宿主在 `city.code.preview.next` 的既有 pull 轮询里消费队列（与
//!   stop control 同通道），渲染端把输入应用到**它自己的** game host
//!   （`ctx.input.actions()`），焦点隔离由窗口配对保证；
//! - 动作词表是封闭形状（1..8 键、键 1..64 个 [A-Za-z0-9_.-]、值 bool 或
//!   有限数 ≤1e6），每会话 ≤64 动作、≤120s 窗口、单 Preview 单活跃会话，
//!   全部上限是常量，两侧（MCP 写入 + 宿主 serve）独立执行同一判定；
//! - 截图是**渲染证据**：只有像素。几何/物理断言必须来自运行时/宿主可观测
//!   数据（tick/entities、`creator_code_test` 的场景机制），绝不来自像素；
//! - 报告永不自动断言“passed”：会话结果只报告发生了什么（verdict-safe）。
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{ToolError, ToolSpec};

const MAX_PLAYTEST_ACTIONS: u64 = 64;
const MAX_PLAYTEST_WINDOW_MS: u64 = 120_000;
const MAX_PLAYTEST_BATCH_KEYS: usize = 8;
const MAX_PLAYTEST_HOLD_MS: u64 = 5_000;
const MAX_PLAYTEST_INPUT_VALUE: f64 = 1_000_000.0;
const MAX_PREVIEW_ID: usize = 128;
/// 截图回读预算：宿主侧落盘上限（512 KiB）+ 解析余量。
const MAX_SCREENSHOT_FILE_BYTES: u64 = 512 * 1024;
/// 截图等待预算：preview 轮询周期 1s + captureFrame 编码，默认 6s 足够。
const DEFAULT_SCREENSHOT_WAIT_MS: u64 = 6_000;
const MAX_SCREENSHOT_WAIT_MS: u64 = 15_000;
const SCREENSHOT_POLL_MS: u64 = 100;

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
            "creator_code_playtest_input",
            "Queue one bounded scripted input batch for the isolated Code Game preview window (real-render automated playtest; never the user's live City). `actions` is a closed-shape map of 1..8 named actions with boolean or finite-number values (|v|<=1e6); the desktop host validates the per-session budget (<=64 actions, <=120s window, one active session per preview) and the preview webview applies it to its own game host only. Observed acceptance is read back via creator_code_preview_status / creator_code_playtest_result; this call reports queuing, not application. Requires `--allow-local-writes` and a starting/running preview.",
            json!({
                "previewId":{"type":"string","minLength":1,"maxLength":128},
                "actions":{"type":"object","minProperties":1,"maxProperties":8,
                    "description":"named actions, e.g. {\"forward\":true} or {\"steer\":-0.5}; keys are 1..64 chars of [A-Za-z0-9_.-]"},
                "holdMs":{"type":"integer","minimum":0,"maximum":5000},
            }),
            &["previewId", "actions"],
        ),
        spec(
            "creator_code_playtest_screenshot",
            "Capture a bounded JPEG render frame of the isolated Code Game preview window as visual evidence (≤350K base64 chars, returned as an MCP image content block, tagged with previewId/buildId/tick). Screenshots are render evidence only — never a source of geometry/physics assertions. The desktop host relays the request through the preview's existing poll channel; waits up to `waitMs` (default 6000, max 15000) for the frame, then fails with creator_capture_unavailable. Requires `--allow-local-writes` and an open preview window.",
            json!({
                "previewId":{"type":"string","minLength":1,"maxLength":128},
                "waitMs":{"type":"integer","minimum":100,"maximum":15000},
            }),
            &["previewId"],
        ),
        spec(
            "creator_code_playtest_stop",
            "Finish the preview's active playtest session (idempotent): clears queued input and the preview webview releases still-held actions on its next poll. The preview run itself is stopped separately via the preview lifecycle. Requires `--allow-local-writes`.",
            json!({"previewId":{"type":"string","minLength":1,"maxLength":128}}),
            &["previewId"],
        ),
        spec(
            "creator_code_playtest_result",
            "Read one preview's playtest session report, bound to previewId/buildId (+ cityId/snapshotDigest when the preview serves a real saved City): budget state, per-step outcomes {seq, keys, deliveredAtMs, observed tick/entities, applied ok, errorCode} and the terminal reason. Verdict-safe: this reports what HAPPENED — it never asserts passed/failed; assertions stay with the headless creator_code_test scenario machinery. Read-only.",
            json!({"previewId":{"type":"string","minLength":1,"maxLength":128}}),
            &["previewId"],
        ),
    ]
}

pub fn run(name: &str, args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    match name {
        "creator_code_playtest_input" => {
            require_writes(allow_local_writes, "Queuing a playtest input batch")?;
            playtest_input(args, data_home)
        }
        "creator_code_playtest_screenshot" => {
            require_writes(allow_local_writes, "Capturing a preview screenshot")?;
            playtest_screenshot(args, data_home)
        }
        "creator_code_playtest_stop" => {
            require_writes(allow_local_writes, "Stopping a playtest session")?;
            playtest_stop(args, data_home)
        }
        "creator_code_playtest_result" => playtest_result(args, data_home),
        other => Err(ToolError::new("internal_error", format!("tool `{other}` registered but not wired"))),
    }
}

fn require_writes(allowed: bool, action: &str) -> Result<(), ToolError> {
    if allowed {
        Ok(())
    } else {
        Err(ToolError::new("permission_denied", format!("{action} requires `data-mcp serve --allow-local-writes`.")))
    }
}

/// 与宿主 `valid_preview_id` 同规则：非空、≤128、首字符 ASCII 字母数字、其余
/// 只允许字母数字/`_`/`-`——同时挡掉路径注入。
fn valid_preview_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_PREVIEW_ID
        && value.starts_with(|c: char| c.is_ascii_alphanumeric())
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn preview_id_arg(args: &Value) -> Result<String, ToolError> {
    let value = args.get("previewId").and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("invalid_argument", "`previewId` is required"))?;
    if !valid_preview_id(value) {
        return Err(ToolError::new("invalid_argument",
            "`previewId` must be 1-128 characters: ASCII letters/digits (plus `_`/`-` after the first)"));
    }
    Ok(value.to_owned())
}

fn previews_root(data_home: &Path) -> PathBuf {
    data_home.join("state/creator/code-games/previews")
}

fn read_json(path: &Path, max_bytes: u64) -> Result<Option<Value>, ToolError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ToolError::new("data_unavailable", "The preview record is unreadable.")),
    };
    if bytes.len() as u64 > max_bytes {
        return Err(ToolError::new("data_unavailable", "The preview record exceeds its read budget."));
    }
    serde_json::from_slice(&bytes).map(Some)
        .map_err(|_| ToolError::new("data_unavailable", "The preview record is malformed."))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), ToolError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| ToolError::new("internal_error", "Cannot encode the playtest record."))?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes)
        .map_err(|_| ToolError::new("data_unavailable", "Cannot write the playtest record."))?;
    std::fs::rename(&temporary, path)
        .map_err(|_| ToolError::new("data_unavailable", "Cannot publish the playtest record."))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64).unwrap_or(0)
}

/// 与宿主 `validate_playtest_actions` 镜像的封闭动作词表。
fn validate_actions(actions: &Value) -> Result<usize, ToolError> {
    let object = actions.as_object()
        .ok_or_else(|| ToolError::new("invalid_argument", "`actions` must be an object of named actions"))?;
    if object.is_empty() || object.len() > MAX_PLAYTEST_BATCH_KEYS {
        return Err(ToolError::new("invalid_argument", format!("`actions` must contain 1..={MAX_PLAYTEST_BATCH_KEYS} named actions")));
    }
    for (key, value) in object {
        let valid_key = !key.is_empty() && key.len() <= 64
            && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'));
        let valid_value = match value {
            Value::Bool(_) => true,
            Value::Number(number) => number.as_f64().is_some_and(|raw| raw.is_finite() && raw.abs() <= MAX_PLAYTEST_INPUT_VALUE),
            _ => false,
        };
        if !valid_key {
            return Err(ToolError::new("invalid_argument",
                "each `actions` key must be 1..64 characters of [A-Za-z0-9_.-]"));
        }
        if !valid_value {
            return Err(ToolError::new("invalid_argument",
                "each `actions` value must be a boolean or a finite number within ±1e6"));
        }
    }
    Ok(object.len())
}

fn playtest_input(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let preview_id = preview_id_arg(args)?;
    let actions = args.get("actions").ok_or_else(|| ToolError::new("invalid_argument", "`actions` is required"))?;
    let count = validate_actions(actions)?;
    let hold_ms = match args.get("holdMs") {
        None | Some(Value::Null) => 0,
        Some(value) => value.as_u64()
            .filter(|hold| *hold <= MAX_PLAYTEST_HOLD_MS)
            .ok_or_else(|| ToolError::new("invalid_argument", format!("`holdMs` must be 0..={MAX_PLAYTEST_HOLD_MS}")))?,
    };
    // 预览必须存在且 run 处于 starting/running（与宿主 playtest_input 同判定）。
    let directory = previews_root(data_home).join(&preview_id);
    if !directory.join("request.json").is_file() {
        return Err(ToolError::new("not_found", "No queued Code Game preview with that previewId."));
    }
    let state = read_json(&directory.join("state.json"), 16 * 1024)?;
    let status = state.as_ref().and_then(|value| value.get("status")).and_then(Value::as_str);
    if !matches!(status, Some("starting" | "running")) {
        return Err(ToolError::new("failed_precondition",
            "The preview is not running a game run; start it via the preview lifecycle first."));
    }
    let request = read_json(&directory.join("request.json"), 4_096)?;
    let path = directory.join("playtest.json");
    let now = now_ms();
    let mut session = read_json(&path, 256 * 1024)?.unwrap_or_else(|| json!({}));
    let expired = session.get("expiresAtMs").and_then(Value::as_u64).is_some_and(|expiry| now >= expiry);
    let active = session.is_object() && session.get("status").and_then(Value::as_str) == Some("active") && !expired;
    let object = session.as_object_mut().ok_or_else(|| ToolError::new("data_unavailable", "The playtest record is malformed."))?;
    if !active {
        object.clear();
        // 与宿主新建会话同一身份绑定：buildId / city 源从 preview 请求取。
        let source = request.as_ref().and_then(|request| request.get("source")).cloned().unwrap_or_else(|| json!({}));
        object.insert("sessionId".into(), json!(format!("playtest-{}", crate::mcp::creator_code_workspace::random_hex(16))));
        object.insert("status".into(), json!("active"));
        object.insert("previewId".into(), json!(preview_id));
        object.insert("buildId".into(), request.as_ref().and_then(|request| request.get("buildId")).cloned().unwrap_or(Value::Null));
        object.insert("cityId".into(), source.get("cityId").cloned().unwrap_or(Value::Null));
        object.insert("cityRevision".into(), source.get("cityRevision").cloned().unwrap_or(Value::Null));
        object.insert("startedAtMs".into(), json!(now));
        object.insert("maxActions".into(), json!(MAX_PLAYTEST_ACTIONS));
        object.insert("expiresAtMs".into(), json!(now.saturating_add(MAX_PLAYTEST_WINDOW_MS)));
        object.insert("acceptedActions".into(), json!(0));
        object.insert("deliveredBatches".into(), json!(0));
        object.insert("lastInputAcceptedAtMs".into(), Value::Null);
        object.insert("lastError".into(), Value::Null);
        object.insert("pending".into(), json!([]));
        object.insert("steps".into(), json!([]));
        object.insert("nextSeq".into(), json!(1));
    }
    let delivered = object.get("acceptedActions").and_then(Value::as_u64).unwrap_or(0);
    let pending_actions: u64 = object.get("pending").and_then(Value::as_array).map(|items| items.iter()
        .filter_map(|batch| batch.get("actions").and_then(Value::as_object).map(|actions| actions.len() as u64))
        .sum()).unwrap_or(0);
    if delivered.saturating_add(pending_actions).saturating_add(count as u64) > MAX_PLAYTEST_ACTIONS {
        return Err(ToolError::new("resource_exhausted",
            format!("The playtest session budget is {MAX_PLAYTEST_ACTIONS} actions; stop or wait for the current session.")));
    }
    let pending_len = object.get("pending").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    if pending_len >= 4 {
        return Err(ToolError::new("busy", "The playtest input queue is full; wait for the preview to consume pending batches."));
    }
    let seq = object.get("nextSeq").and_then(Value::as_u64).unwrap_or(1);
    object.insert("nextSeq".into(), json!(seq + 1));
    let queued_batches = pending_len + 1;
    if let Some(pending) = object.get_mut("pending").and_then(Value::as_array_mut) {
        pending.push(json!({"seq":seq,"actions":actions,"holdMs":hold_ms}));
    }
    object.insert("updatedAtMs".into(), json!(now));
    write_json_atomic(&path, &Value::Object(object.clone()))?;
    Ok(json!({"ok":true,"data":{"sessionId":object["sessionId"],"seq":seq,"queued":true,"holdMs":hold_ms,
        "budget":{"maxActions":MAX_PLAYTEST_ACTIONS,"acceptedActions":delivered,
            "expiresAtMs":object["expiresAtMs"],"queuedBatches":queued_batches}}}))
}

fn playtest_stop(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let preview_id = preview_id_arg(args)?;
    let path = previews_root(data_home).join(&preview_id).join("playtest.json");
    let now = now_ms();
    let Some(mut session) = read_json(&path, 256 * 1024)? else {
        return Ok(json!({"ok":true,"data":{"stopped":false,"reason":"no_session"}}));
    };
    if session.get("status").and_then(Value::as_str) != Some("active") {
        return Ok(json!({"ok":true,"data":{"stopped":false,"reason":"already_finished"}}));
    }
    let object = session.as_object_mut().ok_or_else(|| ToolError::new("data_unavailable", "The playtest record is malformed."))?;
    object.insert("status".into(), json!("finished"));
    object.insert("reason".into(), json!("stopped"));
    object.insert("pending".into(), json!([]));
    object.insert("updatedAtMs".into(), json!(now));
    write_json_atomic(&path, &Value::Object(object.clone()))?;
    Ok(json!({"ok":true,"data":{"stopped":true,"sessionId":object["sessionId"].clone(),"reason":"stopped"}}))
}

fn playtest_screenshot(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let preview_id = preview_id_arg(args)?;
    let wait_ms = match args.get("waitMs") {
        None | Some(Value::Null) => DEFAULT_SCREENSHOT_WAIT_MS,
        Some(value) => value.as_u64()
            .filter(|wait| (100..=MAX_SCREENSHOT_WAIT_MS).contains(wait))
            .ok_or_else(|| ToolError::new("invalid_argument", format!("`waitMs` must be 100..={MAX_SCREENSHOT_WAIT_MS}")))?,
    };
    let directory = previews_root(data_home).join(&preview_id);
    if !directory.join("request.json").is_file() {
        return Err(ToolError::new("not_found", "No queued Code Game preview with that previewId."));
    }
    // 请求面与宿主 serve 同词表：captureId 是 [A-Za-z0-9_-] 的有界 id。
    let capture_id = format!("cap-{}", crate::mcp::creator_code_workspace::random_hex(16));
    write_json_atomic(&directory.join("capture-request.json"),
        &json!({"captureId":capture_id,"requestedAtMs":now_ms()}))?;
    let screenshot_path = directory.join("screenshot.json");
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
    while std::time::Instant::now() < deadline {
        if let Some(record) = read_json(&screenshot_path, MAX_SCREENSHOT_FILE_BYTES)? {
            if record.get("captureId").and_then(Value::as_str) == Some(capture_id.as_str()) {
                return super::creator_studio::capture_result_envelope(&record);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(SCREENSHOT_POLL_MS));
    }
    Err(ToolError::new("creator_capture_unavailable",
        "The preview window did not return a frame in time; the screenshot request expired. Check that the preview window is open and retry."))
}

fn playtest_result(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let preview_id = preview_id_arg(args)?;
    let directory = previews_root(data_home).join(&preview_id);
    let Some(session) = read_active_session_or_any(data_home, &preview_id)? else {
        return Ok(json!({"ok":true,"data":{"available":false,"previewId":preview_id,"reason":"no_session"}}));
    };
    // City 身份绑定：请求源声明（真实 City 预览），缓存里同一 (cityId, revision)
    // 的冻结快照 digest 作为世界身份回执（渲染端导出过才有；缺席是明确缺席）。
    let request = read_json(&directory.join("request.json"), 4_096)?;
    let source = request.as_ref().and_then(|request| request.get("source")).cloned().unwrap_or_else(|| json!({}));
    let mut city = json!({"cityId":source.get("cityId").cloned().unwrap_or(Value::Null),"snapshotDigest":Value::Null});
    if let (Some(city_id), Some(city_revision)) = (
        source.get("cityId").and_then(Value::as_str),
        source.get("cityRevision").and_then(Value::as_u64),
    ) {
        let cache = data_home.join("state/creator/code-games/city-snapshots")
            .join(format!("{city_id}-{city_revision}.json"));
        if let Some(snapshot) = read_json(&cache, 1024 * 1024)? {
            if let Some(digest) = snapshot.get("header").and_then(|header| header.get("snapshotDigest")).cloned() {
                city["snapshotDigest"] = digest;
            }
        }
    }
    let steps = session.get("steps").and_then(Value::as_array).map(|items| items.iter().take(64).cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    Ok(json!({"ok":true,"data":{
        "available":true,
        "sessionId":session.get("sessionId").cloned().unwrap_or(Value::Null),
        "previewId":preview_id,
        "buildId":session.get("buildId").cloned().unwrap_or(Value::Null),
        "city":city,
        "status":session.get("status").cloned().unwrap_or(Value::Null),
        "reason":session.get("reason").cloned().unwrap_or(Value::Null),
        "budget":{"maxActions":session.get("maxActions").cloned().unwrap_or(Value::Null),
            "acceptedActions":session.get("acceptedActions").cloned().unwrap_or(Value::Null),
            "deliveredBatches":session.get("deliveredBatches").cloned().unwrap_or(Value::Null),
            "startedAtMs":session.get("startedAtMs").cloned().unwrap_or(Value::Null),
            "expiresAtMs":session.get("expiresAtMs").cloned().unwrap_or(Value::Null)},
        "lastInputAcceptedAtMs":session.get("lastInputAcceptedAtMs").cloned().unwrap_or(Value::Null),
        "lastError":session.get("lastError").cloned().unwrap_or(Value::Null),
        "steps":steps,
        // verdict-safe：本报告只描述发生的事实；不携带 passed/failed 结论字段。
        "note":"observations only; assertions stay with creator_code_test scenarios",
    }}))
}

/// result 读法接受活跃**与终态**会话（报告发生在终态后仍可读）。
fn read_active_session_or_any(data_home: &Path, preview_id: &str) -> Result<Option<Value>, ToolError> {
    let path = previews_root(data_home).join(preview_id).join("playtest.json");
    read_json(&path, 256 * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("code-playtest-mcp-{tag}-{}", now_ms()));
        std::fs::create_dir_all(home.join("state/creator/code-games/previews")).expect("temp dir");
        home
    }

    fn write(path: &Path, value: Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    fn running_preview(home: &Path, preview_id: &str) {
        let directory = home.join("state/creator/code-games/previews").join(preview_id);
        std::fs::create_dir_all(&directory).unwrap();
        write(&directory.join("request.json"), json!({"previewId":preview_id,"buildId":"a".repeat(64),
            "source":{"cityId":"city:pr08","cityRevision":3}}));
        write(&directory.join("state.json"), json!({"status":"running","previewId":preview_id,
            "gameId":"game.pr08","buildId":"a".repeat(64),"runId":"run-1","tick":4,"entities":1,"updatedAtMs":now_ms()}));
    }

    #[test]
    fn playtest_input_enforces_whitelist_budget_and_running_state() {
        let home = temp_home("input");
        // 未授权 / 缺 preview / 非运行态先被拒绝。
        let error = crate::mcp::dispatch("creator_code_playtest_input", &json!({"previewId":"preview-1","actions":{"forward":true}}), &home).unwrap_err();
        assert_eq!(error.code, "permission_denied");
        let error = crate::mcp::dispatch_with_permissions("creator_code_playtest_input",
            &json!({"previewId":"preview-1","actions":{"forward":true}}), &home, true).unwrap_err();
        assert_eq!(error.code, "not_found");
        running_preview(&home, "preview-pt");
        write(&home.join("state/creator/code-games/previews/preview-pt/state.json"),
            json!({"status":"finished","previewId":"preview-pt","updatedAtMs":now_ms()}));
        let error = crate::mcp::dispatch_with_permissions("creator_code_playtest_input",
            &json!({"previewId":"preview-pt","actions":{"forward":true}}), &home, true).unwrap_err();
        assert_eq!(error.code, "failed_precondition");
        write(&home.join("state/creator/code-games/previews/preview-pt/state.json"),
            json!({"status":"running","previewId":"preview-pt","tick":4,"updatedAtMs":now_ms()}));
        // 词表与 hold 上限。
        for bad in [
            json!({}),
            json!({"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9}),
            json!({"bad key!":true}),
            json!({"forward":"yes"}),
            json!({"steer":2.0e6}),
        ] {
            let error = run("creator_code_playtest_input", &json!({"previewId":"preview-pt","actions":bad}), &home, true).unwrap_err();
            assert_eq!(error.code, "invalid_argument", "{bad}");
        }
        let error = run("creator_code_playtest_input", &json!({"previewId":"preview-pt","actions":{"forward":true},"holdMs":5001}), &home, true).unwrap_err();
        assert_eq!(error.code, "invalid_argument");
        // 合法入队：回执带预算；预算把队列内动作也计入。
        let first = run("creator_code_playtest_input", &json!({"previewId":"preview-pt","actions":{"forward":true},"holdMs":400}), &home, true).unwrap();
        assert_eq!(first["data"]["seq"], 1);
        assert_eq!(first["data"]["queued"], true);
        let session_id = first["data"]["sessionId"].as_str().unwrap().to_string();
        let second = run("creator_code_playtest_input", &json!({"previewId":"preview-pt","actions":{"s":1.5}}), &home, true).unwrap();
        assert_eq!(second["data"]["seq"], 2);
        assert_eq!(second["data"]["sessionId"], json!(session_id));
        // 形状校验：previewId 词表挡路径注入与非法形状（合法形状但无记录的
        // id 由 not_found 负责，见上方缺 preview 分支）。
        for bad_id in ["../escape", "", "preview/x", "预览"] {
            let error = run("creator_code_playtest_input", &json!({"previewId":bad_id,"actions":{"forward":true}}), &home, true).unwrap_err();
            assert_eq!(error.code, "invalid_argument", "{bad_id}");
        }
        std::fs::remove_dir_all(home).ok();
    }

    /// 终态会话：stop 幂等；result 只读且 verdict-safe（没有 passed/failed 字段）。
    #[test]
    fn playtest_stop_is_idempotent_and_result_is_verdict_safe() {
        let home = temp_home("result");
        running_preview(&home, "preview-pt");
        // 无会话：stop 与 result 都是结构化缺席，不是错误。
        let stopped = run("creator_code_playtest_stop", &json!({"previewId":"preview-pt"}), &home, true).unwrap();
        assert_eq!(stopped["data"]["stopped"], false);
        let result = run("creator_code_playtest_result", &json!({"previewId":"preview-pt"}), &home, false).unwrap();
        assert_eq!(result["data"]["available"], false);
        // 活跃会话 → stop → 终态 + pending 清空。
        run("creator_code_playtest_input", &json!({"previewId":"preview-pt","actions":{"forward":true}}), &home, true).unwrap();
        run("creator_code_playtest_input", &json!({"previewId":"preview-pt","actions":{"forward":true}}), &home, true).unwrap();
        let stopped = run("creator_code_playtest_stop", &json!({"previewId":"preview-pt"}), &home, true).unwrap();
        assert_eq!(stopped["data"]["stopped"], true);
        assert_eq!(stopped["data"]["reason"], "stopped");
        let again = run("creator_code_playtest_stop", &json!({"previewId":"preview-pt"}), &home, true).unwrap();
        assert_eq!(again["data"]["stopped"], false);
        let session = read_json(&home.join("state/creator/code-games/previews/preview-pt/playtest.json"), 256 * 1024).unwrap().unwrap();
        assert_eq!(session["status"], "finished");
        assert_eq!(session["pending"].as_array().unwrap().len(), 0);
        // 终态后 result 仍可读（报告发生在会话结束后保留）；白名单投影无结论字段。
        let result = run("creator_code_playtest_result", &json!({"previewId":"preview-pt"}), &home, false).unwrap();
        assert_eq!(result["data"]["available"], true);
        assert_eq!(result["data"]["city"]["cityId"], "city:pr08");
        assert_eq!(result["data"]["steps"].as_array().unwrap().len(), 0, "queued batches were cleared by stop");
        let keys: Vec<&str> = result["data"].as_object().unwrap().keys().map(String::as_str).collect();
        assert!(!keys.iter().any(|key| *key == "verdict" || *key == "passed"), "playtest results must stay verdict-safe: {keys:?}");
        std::fs::remove_dir_all(home).ok();
    }

    /// 截图：请求写入 → 宿主 serve 投递（这里用伪造的 screenshot.json 模拟
    /// 渲染端回执）→ 同一 captureId 命中 → 走 creator_scene_capture 的同一
    /// 信封（MCP image content 块，dataUrl 不进结构化上下文）。
    #[test]
    fn playtest_screenshot_round_trips_through_the_capture_envelope() {
        let home = temp_home("shot");
        running_preview(&home, "preview-pt");
        // 真实链路分两半：这里发起请求，然后扮演宿主+渲染端把回执落盘。
        let responder_home = home.clone();
        let screenshot_thread = std::thread::spawn(move || {
            // 等待请求文件出现（宿主 serve 由桌面进程完成；单测里直接伪造回执）。
            let request = responder_home.join("state/creator/code-games/previews/preview-pt/capture-request.json");
            for _ in 0..100 {
                if request.exists() { break; }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            let requested: Value = serde_json::from_slice(&std::fs::read(&request).unwrap()).unwrap();
            let capture_id = requested["captureId"].as_str().unwrap().to_string();
            let data_url = format!("data:image/jpeg;base64,{}", "A".repeat(128));
            write(&responder_home.join("state/creator/code-games/previews/preview-pt/screenshot.json"),
                json!({"captureId":capture_id,"previewId":"preview-pt","buildId":"a".repeat(64),
                    "dataUrl":data_url,"width":1100,"height":760,"downscaled":false,"bytes":data_url.len(),
                    "tick":4,"capturedAtMs":now_ms()}));
        });
        let captured = run("creator_code_playtest_screenshot", &json!({"previewId":"preview-pt","waitMs":8_000}), &home, true).unwrap();
        screenshot_thread.join().unwrap();
        assert_eq!(captured["ok"], true);
        assert!(captured["content"].as_array().unwrap().iter().any(|block| block["type"] == "image"));
        assert_eq!(captured["data"]["imageOmittedFromStructuredContent"], true);
        assert_eq!(captured["data"]["previewId"], "preview-pt");
        assert_eq!(captured["data"]["tick"], 4);
        // 超时：无渲染端应答 → creator_capture_unavailable（诚实失败，不降级）。
        let error = run("creator_code_playtest_screenshot", &json!({"previewId":"preview-pt","waitMs":100}), &home, true).unwrap_err();
        assert_eq!(error.code, "creator_capture_unavailable");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn screenshot_requires_writes_and_valid_wait() {
        let home = temp_home("shot-guard");
        let error = crate::mcp::dispatch("creator_code_playtest_screenshot", &json!({"previewId":"preview-1"}), &home).unwrap_err();
        assert_eq!(error.code, "permission_denied");
        running_preview(&home, "preview-pt");
        let error = run("creator_code_playtest_screenshot", &json!({"previewId":"preview-pt","waitMs":16_000}), &home, true).unwrap_err();
        assert_eq!(error.code, "invalid_argument");
        std::fs::remove_dir_all(home).ok();
    }
}
