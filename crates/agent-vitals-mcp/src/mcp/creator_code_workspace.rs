//! Code Game 创作控制面（MCP）。
//!
//! 这是 Agent 闭环的写入侧：创建受控工作区、读写源码、触发构建、跑无头验收。
//! 设计边界（PRD §8.1 / §11）：
//!
//! - 调用方永远给 `workspaceId`，**不给路径**；路径由 `data_home` 下的注册表解析。
//! - 文件路径必须工作区相对、无 `..`/盘符/反斜杠，读写有字节预算；写入用
//!   `expectedRevision` 做内容 CAS，避免覆盖 Agent 没读过的版本。
//! - 构建不是任意 shell：固定 Node 脚本 + 固定参数，工作区由 ID 解析。Node 或
//!   仓库脚本不存在时**失败关闭**（`data_unavailable`），绝不回退到别的命令。
//! - 构建失败是**正常结果**：返回结构化 diagnostics 让 Agent 修复，而不是 ToolError。
//!
//! 当前是 P0 本机受控构建进程；打包产物如何携带 Node/构建器是后续架构决定。
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{ToolError, ToolSpec};

const MAX_TITLE: usize = 80;
const MAX_FILES: usize = 128;
const MAX_FILE_BYTES: usize = 64 * 1024;
const MAX_WRITE_BYTES: usize = 256 * 1024;
const MAX_PATH: usize = 200;
const MAX_TICKS: u64 = 3_600;
const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;
const TEMPLATE: &str = "hello-city";
const META_FILE: &str = "workspace.json";

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
            "creator_code_project_create",
            "Create a controlled Code Game workspace from a trusted template (only `hello-city` in P0). Returns workspaceId/projectId/gameId and the content revision; the caller never supplies a filesystem path. Requires `--allow-local-writes`.",
            json!({
                "title":{"type":"string","minLength":1,"maxLength":80},
                "template":{"type":"string","enum":["hello-city"]},
                "operationId":{"type":"string","minLength":1,"maxLength":128},
            }),
            &["title", "operationId"],
        ),
        spec(
            "creator_code_workspace_info",
            "Read a Code Game workspace's identity, content revision and bounded file list (workspace-relative paths and byte sizes only; no absolute paths).",
            json!({"workspaceId":{"type":"string","minLength":20,"maxLength":32}}),
            &["workspaceId"],
        ),
        spec(
            "creator_code_file_read",
            "Read one UTF-8 file from a Code Game workspace by workspace-relative path (at most 64 KiB). Returns the content, its sha256 and the workspace revision the caller must pass back to a write.",
            json!({
                "workspaceId":{"type":"string","minLength":20,"maxLength":32},
                "relativePath":{"type":"string","minLength":1,"maxLength":200},
            }),
            &["workspaceId", "relativePath"],
        ),
        spec(
            "creator_code_file_write",
            "Write one UTF-8 file in a Code Game workspace (at most 256 KiB, text extensions only). `expectedRevision` is a content CAS: a stale value is rejected with workspace_revision_conflict instead of clobbering the Agent's unread edits. Requires `--allow-local-writes`.",
            json!({
                "workspaceId":{"type":"string","minLength":20,"maxLength":32},
                "relativePath":{"type":"string","minLength":1,"maxLength":200},
                "content":{"type":"string","maxLength":262144},
                "expectedRevision":{"type":"string","minLength":16,"maxLength":64},
            }),
            &["workspaceId", "relativePath", "content"],
        ),
        spec(
            "creator_code_preview",
            "Queue an immutable Code Game build for an independent Preview window. The desktop host verifies and serves sealed bytes by buildId without opening or replacing the current City. Optional cityId selects a saved source City; absence uses a clearly marked synthetic fixture. Requires `--allow-local-writes`.",
            json!({
                "workspaceId":{"type":"string","minLength":20,"maxLength":32},
                "buildId":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},
                "seed":{"type":"integer","minimum":0,"maximum":4294967295u32},
                "cityId":{"type":"string","minLength":1,"maxLength":128},
            }),
            &["workspaceId", "buildId"],
        ),
        spec(
            "creator_code_build",
            "Build a Code Game workspace with the pinned local toolchain. Success returns buildId + byte length; a compile failure returns status=failed with bounded diagnostics (code, stage, relative path, line, column) for the Agent to repair. Requires `--allow-local-writes`.",
            json!({
                "workspaceId":{"type":"string","minLength":20,"maxLength":32},
                "expectedRevision":{"type":"string","minLength":16,"maxLength":64},
            }),
            &["workspaceId"],
        ),
        spec(
            "creator_code_test",
            "Run a built Code Game headlessly for a bounded number of fixed ticks with a seeded world and return telemetry (status, outcome, tick, entities, HUD). This is the automated feedback loop; it does not replace the visual City acceptance. Requires `--allow-local-writes`.",
            json!({
                "workspaceId":{"type":"string","minLength":20,"maxLength":32},
                "buildId":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},
                "seed":{"type":"integer","minimum":0,"maximum":4294967295u32},
                "ticks":{"type":"integer","minimum":1,"maximum":3600},
            }),
            &["workspaceId", "buildId"],
        ),
    ]
}

pub fn run(name: &str, args: &Value, data_home: &Path, allow_local_writes: bool) -> Result<Value, ToolError> {
    match name {
        "creator_code_workspace_info" => workspace_info(args, data_home),
        "creator_code_file_read" => file_read(args, data_home),
        "creator_code_project_create" => {
            require_writes(allow_local_writes, "Creating a Code Game workspace")?;
            project_create(args, data_home)
        }
        "creator_code_file_write" => {
            require_writes(allow_local_writes, "Writing a Code Game file")?;
            file_write(args, data_home)
        }
        "creator_code_preview" => {
            require_writes(allow_local_writes, "Staging a Code Game preview")?;
            stage_preview(args, data_home)
        }
        "creator_code_build" => {
            require_writes(allow_local_writes, "Building a Code Game workspace")?;
            build(args, data_home)
        }
        "creator_code_test" => {
            require_writes(allow_local_writes, "Running a Code Game headlessly")?;
            code_test(args, data_home)
        }
        other => Err(ToolError::new("internal_error", format!("tool `{other}` registered but not wired"))),
    }
}

fn require_writes(allowed: bool, action: &str) -> Result<(), ToolError> {
    if allowed {
        Ok(())
    } else {
        Err(ToolError::new(
            "permission_denied",
            format!("{action} requires `data-mcp serve --allow-local-writes`."),
        ))
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct WorkspaceMeta {
    #[serde(rename = "workspaceId")]
    pub(crate) workspace_id: String,
    #[serde(rename = "projectId")]
    pub(crate) project_id: String,
    #[serde(rename = "gameId")]
    pub(crate) game_id: String,
    pub(crate) title: String,
    pub(crate) template: String,
    #[serde(rename = "createdAtMs")]
    pub(crate) created_at_ms: u64,
    pub(crate) revision: String,
    #[serde(rename = "operationId", default, skip_serializing_if = "Option::is_none")]
    pub(crate) operation_id: Option<String>,
}

/// `creator_code_project_create` 的幂等回执：同一 `operationId` 的重试按
/// requestHash 重放原结果或拒绝（`operation_id_conflict`）。落盘在
/// `<data_home>/state/creator/code-games/operations/<operationId>.json`，
/// 与 creator_session 的任务回据同思路，只是这里用文件而不是宿主 SQLite。
#[derive(Debug, Serialize, Deserialize)]
struct OperationReceipt {
    #[serde(rename = "operationId")]
    operation_id: String,
    #[serde(rename = "requestHash")]
    request_hash: String,
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "gameId")]
    game_id: String,
    #[serde(rename = "gameRevision")]
    game_revision: String,
    #[serde(rename = "createdAtMs")]
    created_at_ms: u64,
    template: String,
}

fn project_create(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let title = required_str(args, "title", MAX_TITLE)?;
    let template = args.get("template").and_then(Value::as_str).unwrap_or(TEMPLATE);
    if template != TEMPLATE {
        return Err(ToolError::new("invalid_argument", "Only the `hello-city` template is available in P0."));
    }
    let operation_id = required_str(args, "operationId", 128)?;
    if !valid_operation_id(&operation_id) {
        return Err(ToolError::new(
            "invalid_argument",
            "`operationId` must be 1-128 characters: ASCII letters/digits (plus `_`/`-` after the first)",
        ));
    }
    let request_hash = create_request_hash(&title, template);
    let operations = operations_dir(data_home)?;
    // Idempotent replay: a retried create with the same operationId and payload
    // returns the original result without creating anything.
    if let Some(receipt) = read_receipt(&operations, &operation_id)? {
        if receipt.request_hash == request_hash {
            return Ok(receipt_result(&receipt));
        }
        return Err(ToolError::new(
            "operation_id_conflict",
            "operationId was already used for a different workspace create request.",
        ));
    }
    // Crash recovery: workspace.json is committed before the receipt, so a meta
    // carrying this operationId means a previous attempt died in between; finish
    // it idempotently instead of creating a second workspace.
    if let Some(meta) = find_workspace_by_operation(data_home, &operation_id)? {
        if meta.title != title || meta.template != template {
            return Err(ToolError::new(
                "operation_id_conflict",
                "operationId was already used for a different workspace create request.",
            ));
        }
        let receipt = OperationReceipt {
            operation_id,
            request_hash,
            workspace_id: meta.workspace_id,
            project_id: meta.project_id,
            game_id: meta.game_id,
            game_revision: meta.revision,
            created_at_ms: meta.created_at_ms,
            template: meta.template,
        };
        write_receipt(&operations, &receipt)?;
        return Ok(receipt_result(&receipt));
    }

    let repo = repo_root()?;
    let template_dir = repo.join("games").join(TEMPLATE);
    if !template_dir.join("game.manifest.json").is_file() {
        return Err(ToolError::new("data_unavailable", "The trusted Code Game template is not available in this installation."));
    }

    let workspace_id = format!("gws-{}", random_hex(16));
    let project_id = format!("project-{}", random_hex(12));
    let game_id = game_id_for(&title);
    let directory = workspace_path(data_home, &workspace_id)?;
    std::fs::create_dir_all(&directory)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot create the Code Game workspace directory."))?;
    copy_template(&template_dir, &directory)?;
    rewrite_manifest(&directory, &game_id, &title)?;

    let revision = digest_workspace(&directory)?;
    let meta = WorkspaceMeta {
        workspace_id: workspace_id.clone(),
        project_id: project_id.clone(),
        game_id: game_id.clone(),
        title,
        template: TEMPLATE.to_string(),
        created_at_ms: now_ms(),
        revision: revision.clone(),
        operation_id: Some(operation_id.clone()),
    };
    // Order matters for crash recovery: the workspace identity is durable
    // before the receipt that vouches for the completed operation.
    write_meta(&directory, &meta)?;
    let receipt = OperationReceipt {
        operation_id,
        request_hash,
        workspace_id,
        project_id,
        game_id,
        game_revision: revision,
        created_at_ms: meta.created_at_ms,
        template: meta.template.clone(),
    };
    write_receipt(&operations, &receipt)?;
    Ok(receipt_result(&receipt))
}

// ── create idempotency (operationId receipts) ─────────────────────

/// 与宿主 `valid_preview_id`（creator_code.rs）同规则的 operationId 约束：
/// 回执以 operationId 命名落盘，先挡掉路径注入（`../`、绝对路径、`.`）。
fn valid_operation_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.starts_with(|c: char| c.is_ascii_alphanumeric())
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// 与 creator_session 的任务回执同思路：请求先折成键排序的 canonical JSON
/// 再取 sha256，网络重试与首次请求得到同一 requestHash。只覆盖影响结果的
/// 请求字段（operationId 本身是回据的键，不进哈希）。
fn canonical_json(value: &Value) -> String {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Object(object) => {
                out.push('{');
                let mut keys: Vec<&String> = object.keys().collect();
                keys.sort();
                for (index, key) in keys.iter().enumerate() {
                    if index > 0 { out.push(','); }
                    out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into()));
                    out.push(':');
                    write(&object[*key], out);
                }
                out.push('}');
            }
            Value::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 { out.push(','); }
                    write(item, out);
                }
                out.push(']');
            }
            _ => out.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "null".into())),
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn create_request_hash(title: &str, template: &str) -> String {
    sha256_hex(canonical_json(&json!({"title": title, "template": template})).as_bytes())
}

fn operations_dir(data_home: &Path) -> Result<PathBuf, ToolError> {
    let root = data_home.join("state/creator/code-games").join("operations");
    std::fs::create_dir_all(&root)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot create the operation receipt directory."))?;
    Ok(root)
}

fn read_receipt(root: &Path, operation_id: &str) -> Result<Option<OperationReceipt>, ToolError> {
    let bytes = match std::fs::read(root.join(format!("{operation_id}.json"))) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let receipt: OperationReceipt = serde_json::from_slice(&bytes)
        .map_err(|_| ToolError::new("storage_unavailable", "The operation receipt is damaged."))?;
    if receipt.operation_id != operation_id {
        return Err(ToolError::new("storage_unavailable", "The operation receipt is damaged."));
    }
    Ok(Some(receipt))
}

fn write_receipt(root: &Path, receipt: &OperationReceipt) -> Result<(), ToolError> {
    let bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|_| ToolError::new("internal_error", "Cannot encode the operation receipt."))?;
    let temporary = root.join(format!("{}.json.tmp", receipt.operation_id));
    std::fs::write(&temporary, bytes)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot write the operation receipt."))?;
    std::fs::rename(&temporary, root.join(format!("{}.json", receipt.operation_id)))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot publish the operation receipt."))
}

/// 重放载荷必须与全新创建完全同形（同一组字段、同一来源）。
fn receipt_result(receipt: &OperationReceipt) -> Value {
    json!({"ok":true,"data":{
        "workspaceId": receipt.workspace_id,
        "projectId": receipt.project_id,
        "gameId": receipt.game_id,
        "gameRevision": receipt.game_revision,
        "template": receipt.template,
    }})
}

/// Crash recovery 扫描：每个 data home 的工作区数量很少，有界目录扫描足够；
/// 损坏或不带该 operationId 的条目直接跳过。read_meta 会重算 revision，
/// 因此回执拿到的是工作区的真实内容摘要。
fn find_workspace_by_operation(data_home: &Path, operation_id: &str) -> Result<Option<WorkspaceMeta>, ToolError> {
    let root = data_home.join("code-games").join("workspaces");
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return Ok(None),
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(meta) = read_meta(&entry.path()) else { continue; };
        if meta.operation_id.as_deref() == Some(operation_id) {
            return Ok(Some(meta));
        }
    }
    Ok(None)
}

fn workspace_info(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let workspace_id = workspace_id_arg(args)?;
    let directory = workspace_dir(data_home, &workspace_id)?;
    let meta = read_meta(&directory)?;
    let files = list_files(&directory)?;
    Ok(json!({"ok":true,"data":{
        "workspaceId": meta.workspace_id,
        "projectId": meta.project_id,
        "gameId": meta.game_id,
        "title": meta.title,
        "template": meta.template,
        "gameRevision": meta.revision,
        "files": files.into_iter().map(|(path, bytes)| json!({"path":path,"bytes":bytes})).collect::<Vec<_>>(),
    }}))
}

fn file_read(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let workspace_id = workspace_id_arg(args)?;
    let relative = safe_relative_path(args)?;
    let directory = workspace_dir(data_home, &workspace_id)?;
    let meta = read_meta(&directory)?;
    let path = resolve_inside(&directory, &relative)?;
    let bytes = std::fs::read(&path).map_err(|_| ToolError::new("not_found", "No such file in this workspace."))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(ToolError::new("invalid_argument", "File exceeds the 64 KiB read budget."));
    }
    let content = String::from_utf8(bytes).map_err(|_| ToolError::new("invalid_argument", "Only UTF-8 text files can be read."))?;
    Ok(json!({"ok":true,"data":{
        "workspaceId": meta.workspace_id,
        "relativePath": relative,
        "gameRevision": meta.revision,
        "sha256": sha256_hex(content.as_bytes()),
        "content": content,
    }}))
}

fn file_write(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let workspace_id = workspace_id_arg(args)?;
    let relative = safe_relative_path(args)?;
    if !is_writable_text_path(&relative) {
        return Err(ToolError::new("invalid_argument", "Only .ts/.tsx/.js/.mjs/.json/.md/.txt/.css/.html files can be written."));
    }
    let content = args.get("content").and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("invalid_argument", "`content` must be a string"))?;
    if content.len() > MAX_WRITE_BYTES {
        return Err(ToolError::new("invalid_argument", "Content exceeds the 256 KiB write budget."));
    }
    if relative.split('/').any(|part| matches!(part, "dist" | "node_modules" | ".git" | META_FILE | ".code-game-tsconfig.json")) {
        return Err(ToolError::new("invalid_argument", "Workspace metadata is host-owned and cannot be written."));
    }
    let directory = workspace_dir(data_home, &workspace_id)?;
    // Serialize the compare-and-write across independent MCP processes.
    let locks = data_home.join("code-games").join("workspace-write-locks");
    std::fs::create_dir_all(&locks).map_err(|_| ToolError::new("storage_unavailable", "Cannot open the workspace write lock."))?;
    let mut lock = rusqlite::Connection::open(locks.join(format!("{workspace_id}.sqlite")))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot open the workspace write lock."))?;
    let _write_lock = lock.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| ToolError::new("busy", "Another write is in progress for this workspace."))?;
    let mut meta = read_meta(&directory)?;
    if let Some(expected) = args.get("expectedRevision").and_then(Value::as_str) {
        if expected != meta.revision {
            return Err(ToolError::new(
                "workspace_revision_conflict",
                "The workspace changed since you read it; re-read workspace info or the file and retry.",
            ));
        }
    }
    let path = resolve_inside(&directory, &relative)?;
    let files = list_files(&directory)?;
    let existing_size = files.iter().find(|(name, _)| name == &relative).map(|(_, size)| *size);
    if existing_size.is_none() && files.len() >= MAX_FILES {
        return Err(ToolError::new("invalid_argument", "The Code Game workspace exceeds the file count budget."));
    }
    let new_size = files.iter().map(|(_, size)| *size).sum::<u64>() - existing_size.unwrap_or(0) + content.len() as u64;
    if new_size > MAX_SNAPSHOT_BYTES {
        return Err(ToolError::new("invalid_argument", "The Code Game workspace exceeds the build input byte budget."));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| ToolError::new("storage_unavailable", "Cannot create the target directory."))?;
    }
    let staged_file = locks.join(format!("{workspace_id}.pending"));
    std::fs::write(&staged_file, content.as_bytes())
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot stage the workspace file."))?;
    std::fs::rename(&staged_file, &path)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot write the workspace file."))?;
    meta.revision = digest_workspace(&directory)?;
    write_meta(&directory, &meta)?;
    Ok(json!({"ok":true,"data":{
        "workspaceId": meta.workspace_id,
        "relativePath": relative,
        "gameRevision": meta.revision,
        "sha256": sha256_hex(content.as_bytes()),
    }}))
}

fn build(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let workspace_id = workspace_id_arg(args)?;
    let directory = workspace_dir(data_home, &workspace_id)?;
    let meta = read_meta(&directory)?;
    if let Some(expected) = args.get("expectedRevision").and_then(Value::as_str) {
        if expected != meta.revision {
            return Err(ToolError::new(
                "workspace_revision_conflict",
                "The workspace changed since you read it; build the revision you actually inspected.",
            ));
        }
    }
    let snapshot = WorkspaceBuildSnapshot::capture(&directory, &meta.revision)?;
    let repo = repo_root()?;
    let out_dir = data_home.join("code-games").join("builds");
    let output = run_node(
        &repo,
        "packages/city-game-sdk/scripts/buildGame.ts",
        &[
            "--workspace".to_string(),
            snapshot.path.to_string_lossy().to_string(),
            "--workspace-id".to_string(),
            meta.workspace_id.clone(),
            "--source-revision".to_string(),
            meta.revision.clone(),
            "--out".to_string(),
            out_dir.to_string_lossy().to_string(),
            "--data-home".to_string(),
            data_home.to_string_lossy().to_string(),
        ],
    )?;
    let parsed: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| ToolError::new("data_unavailable", "The build runner returned no JSON result."))?;
    let data = if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
        let build_id = build_id_arg(&parsed)?;
        let revision = build_workspace_revision(data_home, &build_id, &meta)?;
        if revision != meta.revision {
            return Err(ToolError::new("workspace_revision_conflict", "The sealed build does not match the requested source revision."));
        }
        json!({
            "status": "succeeded",
            "workspaceId": workspace_id,
            "gameRevision": meta.revision,
            "buildId": build_id,
            "byteLength": parsed.get("byteLength").cloned().unwrap_or(Value::Null),
            "diagnostics": parsed.get("warnings").cloned().unwrap_or_else(|| json!([])),
        })
    } else {
        json!({
            "status": "failed",
            "workspaceId": workspace_id,
            "gameRevision": meta.revision,
            "buildId": Value::Null,
            "diagnostics": parsed.get("diagnostics").cloned().unwrap_or_else(|| json!([])),
        })
    };
    Ok(json!({"ok":true,"data":data}))
}

/// The MCP process and City WebView share only a bounded request document.
/// Frozen build bytes stay in the data home and are verified by the desktop host.
fn stage_preview(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let workspace_id = workspace_id_arg(args)?;
    let build_id = build_id_arg(args)?;
    let seed = args.get("seed").and_then(Value::as_u64).unwrap_or(7);
    let directory = workspace_dir(data_home, &workspace_id)?;
    let meta = read_meta(&directory)?;
    let revision = build_workspace_revision(data_home, &build_id, &meta)?;
    let root = data_home.join("state/creator/code-games");
    let previews = root.join("previews");
    std::fs::create_dir_all(&previews).map_err(|_| ToolError::new("storage_unavailable", "Cannot create the preview request directory."))?;
    let created = now_ms();
    let request_id = format!("preview-{build_id}-{created}");
    let preview_id = format!("preview-{}", random_hex(16));
    let mut request = json!({"requestId":request_id,"previewId":preview_id,"buildId":build_id,"seed":seed,
        "source":{"cityId":"city:preview-fixture","seed":7,"synthetic":true},"status":"queued","createdAtMs":created});
    if let Some(city_id) = args.get("cityId").and_then(Value::as_str) {
        if city_id.is_empty() || city_id.len() > 128 { return Err(ToolError::new("invalid_argument", "cityId is invalid")); }
        request["source"] = json!({"cityId":city_id});
    }
    let directory = previews.join(&preview_id);
    std::fs::create_dir(&directory).map_err(|_| ToolError::new("storage_unavailable", "Cannot allocate an independent preview request."))?;
    let temporary = directory.join("request.json.tmp");
    let target = directory.join("request.json");
    std::fs::write(&temporary, serde_json::to_vec(&request).map_err(|_| ToolError::new("internal_error", "Cannot encode the preview request."))?)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot write the preview request."))?;
    std::fs::rename(&temporary, &target).map_err(|_| ToolError::new("storage_unavailable", "Cannot publish the preview request."))?;
    Ok(json!({"ok":true,"data":{"workspaceId":workspace_id,"gameId":meta.game_id,"buildId":build_id,"seed":seed,
        "requestId":request_id,"previewId":preview_id,"gameRevision":revision,"status":"queued"}}))
}

fn build_id_arg(args: &Value) -> Result<String, ToolError> {
    let value = required_str(args, "buildId", 64)?;
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(ToolError::new("invalid_argument", "`buildId` must be a 64-character lower-case hex digest"));
    }
    Ok(value)
}

/// The builder seals sourceRevision into the immutable build ID. Workspace-scoped
/// consumers accept an older revision of the same workspace for reproducible tests.
pub(crate) fn build_workspace_revision(data_home: &Path, build_id: &str, meta: &WorkspaceMeta) -> Result<String, ToolError> {
    use std::io::Read;
    let directory = data_home.join("code-games").join("builds").join(build_id);
    if !directory.join("game.js").is_file() || !directory.join("manifest.json").is_file() {
        return Err(ToolError::new("not_found", "No sealed build for that buildId in this data home."));
    }
    let file = std::fs::File::open(directory.join("build.json"))
        .map_err(|_| ToolError::new("not_found", "The sealed build record is unavailable."))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut bytes)
        .map_err(|_| ToolError::new("game_build_failed", "Cannot read the sealed build record."))?;
    let record: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ToolError::new("game_build_failed", "The sealed build record is malformed."))?;
    let prefix = format!("workspace:{}:", meta.workspace_id);
    let revision = record["sourceRevision"].as_str()
        .and_then(|source| source.strip_prefix(&prefix))
        .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    if let Some(revision) = revision {
        if bytes.len() <= MAX_FILE_BYTES && record["buildId"] == build_id && record["gameId"] == meta.game_id {
            return Ok(revision.to_owned());
        }
    }
    Err(ToolError::new("workspace_build_mismatch", "This build is not attributed to this workspace. Build the workspace again and use the returned buildId."))
}

struct WorkspaceBuildSnapshot {
    path: PathBuf,
}

impl WorkspaceBuildSnapshot {
    fn capture(directory: &Path, revision: &str) -> Result<Self, ToolError> {
        let files = list_files(directory)?;
        let total_bytes = files.iter().map(|(_, bytes)| *bytes).sum::<u64>();
        if total_bytes > MAX_SNAPSHOT_BYTES {
            return Err(ToolError::new("invalid_argument", "The Code Game workspace exceeds the build input byte budget."));
        }
        let path = std::env::temp_dir().join(format!("oh-code-build-{}", random_hex(32)));
        let mut directory_builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory_builder.mode(0o700);
        }
        directory_builder.create(&path)
            .map_err(|_| ToolError::new("storage_unavailable", "Cannot create the Code Game build input."))?;
        let snapshot = Self { path };
        for (relative, _) in files {
            let source = resolve_inside(directory, &relative)?;
            let target = snapshot.path.join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|_| ToolError::new("storage_unavailable", "Cannot stage a Code Game build input."))?;
            }
            std::fs::copy(source, target)
                .map_err(|_| ToolError::new("storage_unavailable", "Cannot stage a Code Game build input."))?;
        }
        if digest_workspace(&snapshot.path)? != revision {
            return Err(ToolError::new("workspace_revision_conflict", "Code Game source changed before the build. Refresh the workspace revision and retry."));
        }
        Ok(snapshot)
    }
}

impl Drop for WorkspaceBuildSnapshot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn code_test(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let workspace_id = workspace_id_arg(args)?;
    let build_id = build_id_arg(args)?;
    let seed = args.get("seed").and_then(Value::as_u64).unwrap_or(7);
    let ticks = args.get("ticks").and_then(Value::as_u64).unwrap_or(600);
    if ticks == 0 || ticks > MAX_TICKS {
        return Err(ToolError::new("invalid_argument", format!("`ticks` must be from 1 to {MAX_TICKS}")));
    }
    let directory = workspace_dir(data_home, &workspace_id)?;
    let meta = read_meta(&directory)?;
    let revision = build_workspace_revision(data_home, &build_id, &meta)?;
    let repo = repo_root()?;
    let output = run_node(
        &repo,
        "packages/city-game-sdk/scripts/previewGame.ts",
        &[
            "--build".to_string(),
            build_id.to_string(),
            "--builds-dir".to_string(),
            data_home.join("code-games").join("builds").to_string_lossy().to_string(),
            "--seed".to_string(),
            seed.to_string(),
            "--ticks".to_string(),
            ticks.to_string(),
        ],
    )?;
    let parsed: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| ToolError::new("data_unavailable", "The headless runner returned no JSON result."))?;
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let code: &'static str = match parsed.get("error").and_then(|error| error.get("code")).and_then(Value::as_str) {
            Some("game_entry_invalid") => "game_entry_invalid",
            Some("game_asset_invalid") => "game_asset_invalid",
            Some("game_permission_denied") => "game_permission_denied",
            Some("game_argument_invalid") => "game_argument_invalid",
            Some("game_world_object_missing") => "game_world_object_missing",
            _ => "game_runtime_fault",
        };
        let message = parsed.get("error").and_then(|error| error.get("message")).and_then(Value::as_str).unwrap_or("The headless run failed.");
        return Err(ToolError::new(code, message.to_string()));
    }
    Ok(json!({"ok":true,"data":{
        "workspaceId": workspace_id,
        "gameId": meta.game_id,
        "buildId": build_id,
        "gameRevision": revision,
        "synthetic": true,
        "telemetry": parsed.get("telemetry").cloned().unwrap_or(Value::Null),
    }}))
}

// ── filesystem helpers ─────────────────────────────────────────────

fn workspace_path(data_home: &Path, workspace_id: &str) -> Result<PathBuf, ToolError> {
    if workspace_id.len() != 20 || !workspace_id.starts_with("gws-") {
        return Err(ToolError::new("invalid_argument", "`workspaceId` must look like gws-<16 hex>."));
    }
    if !workspace_id[4..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(ToolError::new("invalid_argument", "`workspaceId` must look like gws-<16 hex>."));
    }
    Ok(data_home.join("code-games").join("workspaces").join(workspace_id))
}

pub(crate) fn workspace_dir(data_home: &Path, workspace_id: &str) -> Result<PathBuf, ToolError> {
    let directory = workspace_path(data_home, workspace_id)?;
    if !directory.is_dir() {
        return Err(ToolError::new("not_found", "No such Code Game workspace."));
    }
    Ok(directory)
}

fn workspace_id_arg(args: &Value) -> Result<String, ToolError> {
    required_str(args, "workspaceId", 32)
}

fn safe_relative_path(args: &Value) -> Result<String, ToolError> {
    let value = required_str(args, "relativePath", MAX_PATH)?;
    if value.starts_with('/') || value.contains('\\') || value.contains(':') || value.chars().any(|c| c.is_control()) {
        return Err(ToolError::new("invalid_argument", "`relativePath` must be workspace-relative with no drive or scheme."));
    }
    if value.split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..") {
        return Err(ToolError::new("invalid_argument", "`relativePath` must not contain empty, '.' or '..' segments."));
    }
    Ok(value)
}

fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf, ToolError> {
    let path = root.join(relative);
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|_| ToolError::new("storage_unavailable", "Workspace root is unavailable."))?;
    let target = if path.exists() {
        std::fs::canonicalize(&path).map_err(|_| ToolError::new("storage_unavailable", "File is unavailable."))?
    } else {
        // A new file: canonicalize the deepest existing ancestor and compare.
        let mut ancestor = path.parent().unwrap_or(root).to_path_buf();
        while !ancestor.exists() && ancestor != root {
            ancestor = ancestor.parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf());
        }
        let resolved = std::fs::canonicalize(&ancestor).map_err(|_| ToolError::new("storage_unavailable", "Workspace is unavailable."))?;
        resolved.join(path.strip_prefix(&ancestor).unwrap_or(Path::new("")))
    };
    if !target.starts_with(&canonical_root) {
        return Err(ToolError::new("invalid_argument", "`relativePath` escapes the workspace."));
    }
    Ok(target)
}

fn is_writable_text_path(path: &str) -> bool {
    let extension = Path::new(path).extension().and_then(|value| value.to_str()).unwrap_or("");
    matches!(extension, "ts" | "tsx" | "js" | "mjs" | "json" | "md" | "txt" | "css" | "html")
}

pub(crate) fn read_meta(directory: &Path) -> Result<WorkspaceMeta, ToolError> {
    let bytes = std::fs::read(directory.join(META_FILE))
        .map_err(|_| ToolError::new("not_found", "No such Code Game workspace."))?;
    let mut meta: WorkspaceMeta = serde_json::from_slice(&bytes)
        .map_err(|_| ToolError::new("data_unavailable", "Workspace metadata is malformed."))?;
    meta.revision = digest_workspace(directory)?;
    Ok(meta)
}

fn write_meta(directory: &Path, meta: &WorkspaceMeta) -> Result<(), ToolError> {
    let bytes = serde_json::to_vec_pretty(meta).map_err(|_| ToolError::new("internal_error", "Cannot encode workspace metadata."))?;
    let temporary = directory.join(format!("{META_FILE}.tmp"));
    std::fs::write(&temporary, bytes).map_err(|_| ToolError::new("storage_unavailable", "Cannot write workspace metadata."))?;
    std::fs::rename(&temporary, directory.join(META_FILE))
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot commit workspace metadata."))
}

fn list_files(directory: &Path) -> Result<Vec<(String, u64)>, ToolError> {
    let mut files = Vec::new();
    collect_files(directory, directory, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn collect_files(root: &Path, current: &Path, out: &mut Vec<(String, u64)>) -> Result<(), ToolError> {
    let entries = std::fs::read_dir(current).map_err(|_| ToolError::new("storage_unavailable", "Cannot read the workspace."))?;
    for entry in entries {
        let entry = entry.map_err(|_| ToolError::new("storage_unavailable", "Cannot read a workspace entry."))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if matches!(name.as_str(), "dist" | "node_modules" | ".git" | "workspace.json.tmp" | ".code-game-tsconfig.json") {
            continue;
        }
        let path = entry.path();
        let kind = entry.file_type().map_err(|_| ToolError::new("storage_unavailable", "Cannot inspect a workspace entry."))?;
        if kind.is_symlink() {
            return Err(ToolError::new("invalid_argument", "Symbolic links are not supported in Code Game workspaces."));
        }
        if kind.is_dir() {
            collect_files(root, &path, out)?;
        } else if kind.is_file() && name != META_FILE {
            if out.len() >= MAX_FILES {
                return Err(ToolError::new("invalid_argument", "The Code Game workspace exceeds the file count budget."));
            }
            if let Ok(relative) = path.strip_prefix(root) {
                let size = entry.metadata().map_err(|_| ToolError::new("storage_unavailable", "Cannot inspect a workspace file."))?.len();
                out.push((relative.to_string_lossy().replace('\\', "/"), size));
            }
        }
    }
    Ok(())
}

fn digest_workspace(directory: &Path) -> Result<String, ToolError> {
    let files = list_files(directory)?;
    if files.iter().map(|(_, bytes)| *bytes).sum::<u64>() > MAX_SNAPSHOT_BYTES {
        return Err(ToolError::new("invalid_argument", "The Code Game workspace exceeds the build input byte budget."));
    }
    let mut hasher = Sha256::new();
    hasher.update(b"oh-agent-code-workspace-v2");
    for (relative, _) in files {
        let bytes = std::fs::read(directory.join(&relative))
            .map_err(|_| ToolError::new("storage_unavailable", "Cannot read a workspace file."))?;
        hasher.update((relative.len() as u64).to_be_bytes());
        hasher.update(relative.as_bytes());
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(&bytes);
    }
    Ok(hex(&hasher.finalize()))
}

fn copy_template(source: &Path, target: &Path) -> Result<(), ToolError> {
    let mut copied = 0usize;
    copy_template_entry(source, target, &mut copied)
}

fn copy_template_entry(source: &Path, target: &Path, copied: &mut usize) -> Result<(), ToolError> {
    if *copied >= MAX_FILES {
        return Err(ToolError::new("data_unavailable", "The template exceeds the bounded file count."));
    }
    let entries = std::fs::read_dir(source).map_err(|_| ToolError::new("data_unavailable", "Cannot read the trusted template."))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if matches!(name.as_str(), "dist" | "node_modules" | ".git" | "tests" | "package.json" | "README.md" | ".gitignore") {
            continue;
        }
        let from = entry.path();
        let to = target.join(&name);
        if from.is_dir() {
            std::fs::create_dir_all(&to).map_err(|_| ToolError::new("storage_unavailable", "Cannot create the workspace."))?;
            copy_template_entry(&from, &to, copied)?;
        } else if from.is_file() {
            std::fs::copy(&from, &to).map_err(|_| ToolError::new("storage_unavailable", "Cannot copy the trusted template."))?;
            *copied += 1;
        }
    }
    Ok(())
}

fn rewrite_manifest(directory: &Path, game_id: &str, title: &str) -> Result<(), ToolError> {
    let path = directory.join("game.manifest.json");
    let bytes = std::fs::read(&path).map_err(|_| ToolError::new("data_unavailable", "The template manifest is missing."))?;
    let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| ToolError::new("data_unavailable", "The template manifest is malformed."))?;
    value["gameId"] = json!(game_id);
    value["displayName"] = json!(title);
    std::fs::write(&path, serde_json::to_vec_pretty(&value).map_err(|_| ToolError::new("internal_error", "Cannot encode the manifest."))?)
        .map_err(|_| ToolError::new("storage_unavailable", "Cannot write the workspace manifest."))?;
    // The bundle's defineGame() id must equal the manifest gameId; the host
    // rejects a mismatch (game_entry_invalid). Rewriting the template literal
    // is P0-appropriate; a real generator would emit the id from one source.
    let entry = directory.join("src").join("index.ts");
    if let Ok(source) = std::fs::read_to_string(&entry) {
        let rewritten = source.replace("community.hello-city", game_id);
        if rewritten != source {
            std::fs::write(&entry, rewritten)
                .map_err(|_| ToolError::new("storage_unavailable", "Cannot write the workspace entry."))?;
        }
    }
    Ok(())
}

// ── process / identity helpers ─────────────────────────────────────

fn repo_root() -> Result<PathBuf, ToolError> {
    repo_root_from(std::env::current_exe().ok())
}

fn repo_root_from(current_exe: Option<PathBuf>) -> Result<PathBuf, ToolError> {
    let packaged = current_exe.and_then(|exe| exe.parent().and_then(Path::parent).map(Path::to_path_buf))
        .map(|resources| resources.join("code-game"))
        .filter(|root| root.join("packages/city-game-sdk/scripts/buildGame.ts").is_file());
    let root = if let Ok(override_path) = std::env::var("AGENT_VITALS_REPO") {
        PathBuf::from(override_path)
    } else if let Ok(bundled) = std::env::var("AGENT_VITALS_CODE_GAME_HOME") {
        PathBuf::from(bundled)
    } else if let Some(packaged) = packaged {
        packaged
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    };
    let root = std::fs::canonicalize(root)
        .map_err(|_| ToolError::new("data_unavailable", "The Code Game build workspace is not available in this installation."))?;
    if !root.join("packages/city-game-sdk/scripts/buildGame.ts").is_file() {
        return Err(ToolError::new("data_unavailable", "The trusted Code Game build script is not available."));
    }
    Ok(root)
}

fn run_node(repo: &Path, script: &str, args: &[String]) -> Result<std::process::Output, ToolError> {
    let node = std::env::var("AGENT_VITALS_NODE").ok().unwrap_or_else(|| {
        let bundled = std::env::var("AGENT_VITALS_CODE_GAME_HOME").ok().map(PathBuf::from).unwrap_or_else(|| repo.to_path_buf())
            .join("bin").join(if cfg!(windows) { "node.exe" } else { "node" });
        if bundled.is_file() { bundled.to_string_lossy().to_string() } else { "node".to_string() }
    });
    let output = Command::new(node)
        .arg("--experimental-transform-types")
        .arg("--import")
        .arg(repo.join("scripts/mecha-ts-register.mjs"))
        .arg(repo.join(script))
        .args(args)
        .output()
        .map_err(|_| ToolError::new("data_unavailable", "Node is unavailable; the local Code Game build runner cannot start."))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(ToolError::new(
            "game_build_failed",
            format!("The build runner exited with {}: {}", output.status, String::from_utf8_lossy(&output.stderr).chars().take(200).collect::<String>()),
        ));
    }
    Ok(output)
}

fn game_id_for(title: &str) -> String {
    let mut slug = String::new();
    for character in title.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 24 {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "game" } else { slug };
    format!("community.{slug}-{}", random_hex(6))
}

fn random_hex(length: usize) -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    let salt = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let digest = Sha256::digest(format!("{nanos}:{salt}:{}", std::process::id()));
    hex(&digest)[..length].to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn required_str(args: &Value, key: &str, max: usize) -> Result<String, ToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= max)
        .map(ToString::to_string)
        .ok_or_else(|| ToolError::new("invalid_argument", format!("`{key}` is required and must be at most {max} bytes")))
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

    /// 进程级串行锁：repo_root() 读取环境变量，需要触碰环境的测试共享这把
    /// 锁，避免并发的 set_var/remove_var 让别的测试读到中间状态。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn args(path: &str) -> Value {
        json!({"workspaceId": "gws-0000000000000000", "relativePath": path})
    }

    #[test]
    fn file_paths_cannot_escape_the_workspace() {
        for path in ["../secret.ts", "/etc/passwd", "a/../../b.ts", "C:/x.ts", "a\\b.ts", ""] {
            assert!(safe_relative_path(&args(path)).is_err(), "accepted {path}");
        }
        assert!(safe_relative_path(&args("src/index.ts")).is_ok());
        assert!(is_writable_text_path("src/index.ts"));
        assert!(!is_writable_text_path("assets/cube.glb"));
    }

    #[test]
    fn generated_game_ids_follow_the_manifest_contract() {
        for title in ["Tower Defense", "塔防", "", "!!!"] {
            let id = game_id_for(title);
            assert!(id.starts_with("community."), "{id}");
            assert!(id.len() <= 128, "{id}");
            assert!(id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-')), "{id}");
        }
        assert_eq!(game_id_for("Tower Defense").split('-').next(), Some("community.tower"));
    }

    #[test]
    fn revision_tracks_file_content_and_ignores_metadata() {
        let dir = std::env::temp_dir().join(format!("code-game-digest-{}-{}", now_ms(), std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/index.ts"), "export default 1;\n").unwrap();
        let first = digest_workspace(&dir).unwrap();
        std::fs::write(dir.join("workspace.json"), "{\"ignored\":true}").unwrap();
        assert_eq!(first, digest_workspace(&dir).unwrap(), "metadata must not enter the revision");
        std::fs::write(dir.join("src/index.ts"), "export default 2;\n").unwrap();
        assert_ne!(first, digest_workspace(&dir).unwrap());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn concurrent_writes_from_one_revision_do_not_overwrite_each_other() {
        let home = std::env::temp_dir().join(format!("code-game-write-test-{}", random_hex(16)));
        let workspace_id = "gws-0000000000000000";
        let workspace = home.join("code-games/workspaces").join(workspace_id);
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::write(workspace.join("src/index.ts"), "export default 0;").unwrap();
        let revision = digest_workspace(&workspace).unwrap();
        write_meta(&workspace, &WorkspaceMeta {
            workspace_id: workspace_id.into(), project_id: "project-test".into(), game_id: "community.test".into(),
            title: "Test".into(), template: "hello-city".into(), created_at_ms: 1, revision: revision.clone(),
            operation_id: None,
        }).unwrap();

        let results = std::thread::scope(|scope| {
            let write = |content: &str| file_write(&json!({
                "workspaceId":workspace_id,"relativePath":"src/index.ts","expectedRevision":revision,"content":content,
            }), &home);
            let first = scope.spawn(move || write("export default 1;"));
            let second = scope.spawn(move || write("export default 2;"));
            [first.join().unwrap(), second.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let failure = results.iter().find_map(|result| result.as_ref().err()).unwrap();
        assert_eq!(failure.code, "workspace_revision_conflict");
        let winner = results.iter().find_map(|result| result.as_ref().ok()).unwrap();
        let actual = std::fs::read(workspace.join("src/index.ts")).unwrap();
        assert_eq!(winner["data"]["sha256"], sha256_hex(&actual));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn consecutive_preview_requests_have_independent_immutable_queue_entries() {
        let home = std::env::temp_dir().join(format!("code-game-preview-queue-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-0000000000000000";
        let workspace = home.join("code-games/workspaces").join(workspace_id);
        std::fs::create_dir_all(&workspace).unwrap();
        write_meta(&workspace, &WorkspaceMeta {
            workspace_id: workspace_id.to_string(), project_id: "project-test".to_string(), game_id: "community.test".to_string(),
            title: "Test".to_string(), template: "hello-city".to_string(), created_at_ms: 1, revision: "sha256:test".to_string(),
            operation_id: None,
        }).unwrap();
        let build_id = "a".repeat(64);
        let build = home.join("code-games/builds").join(&build_id);
        std::fs::create_dir_all(&build).unwrap();
        for file in ["game.js", "manifest.json"] { std::fs::write(build.join(file), b"{}").unwrap(); }
        let source_revision = "b".repeat(64);
        std::fs::write(build.join("build.json"), json!({
            "buildId":build_id,"gameId":"community.test","sourceRevision":format!("workspace:{workspace_id}:{source_revision}"),
        }).to_string()).unwrap();
        let request = json!({"workspaceId":workspace_id,"buildId":build_id,"seed":7});
        let first = stage_preview(&request, &home).unwrap();
        let second = stage_preview(&request, &home).unwrap();
        let first_id = first["data"]["previewId"].as_str().unwrap();
        let second_id = second["data"]["previewId"].as_str().unwrap();
        assert_ne!(first_id, second_id);
        assert_eq!(first["data"]["gameRevision"], source_revision);
        let meta = read_meta(&workspace).unwrap();
        let another_workspace = WorkspaceMeta { workspace_id: "gws-1111111111111111".into(), ..meta };
        assert_eq!(build_workspace_revision(&home, &build_id, &another_workspace).unwrap_err().code, "workspace_build_mismatch");
        for preview_id in [first_id, second_id] {
            let queued: Value = serde_json::from_slice(&std::fs::read(home.join("state/creator/code-games/previews").join(preview_id).join("request.json")).unwrap()).unwrap();
            assert_eq!(queued["status"], "queued");
            assert_eq!(queued["previewId"], preview_id);
            assert_eq!(queued["source"]["synthetic"], true);
        }
        assert!(!home.join("state/creator/code-games/preview-request.json").exists());
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn bundled_builder_root_precedes_the_compile_time_repo() {
        let _guard = ENV_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(format!("code-game-bundled-{}-{}", now_ms(), std::process::id()));
        std::fs::create_dir_all(root.join("packages/city-game-sdk/scripts")).unwrap();
        std::fs::write(root.join("packages/city-game-sdk/scripts/buildGame.ts"), "// builder").unwrap();
        std::env::remove_var("AGENT_VITALS_REPO");
        std::env::set_var("AGENT_VITALS_CODE_GAME_HOME", &root);
        assert_eq!(repo_root().unwrap(), std::fs::canonicalize(&root).unwrap());
        std::env::remove_var("AGENT_VITALS_CODE_GAME_HOME");
        let packaged = root.join("Oh Agent.app/Contents/Resources/code-game");
        std::fs::create_dir_all(packaged.join("packages/city-game-sdk/scripts")).unwrap();
        std::fs::write(packaged.join("packages/city-game-sdk/scripts/buildGame.ts"), "// packaged builder").unwrap();
        let exe = root.join("Oh Agent.app/Contents/Resources/bin/agent-vitals");
        assert_eq!(repo_root_from(Some(exe)).unwrap(), std::fs::canonicalize(&packaged).unwrap());
        std::fs::remove_dir_all(root).ok();
    }

    fn create_args(title: &str, operation_id: &str) -> Value {
        json!({"title": title, "template": "hello-city", "operationId": operation_id})
    }

    /// operationId 会成为回执文件名：沿用宿主 valid_preview_id 规则挡路径注入。
    #[test]
    fn operation_ids_reject_path_injection() {
        for id in ["../escape", "a/b", "", ".", "..", ".hidden", "a b", "op with-dash_1"] {
            assert!(!valid_operation_id(id), "accepted {id}");
        }
        for id in ["op-1", "a", "01890b2e-d47c-7c40-b4d1-bc6f65342d3f"] {
            assert!(valid_operation_id(id), "rejected {id}");
        }
    }

    /// 同 operationId + 同载荷的重试返回同一工作区身份，且只创建一个工作区目录。
    #[test]
    fn retried_project_create_replays_the_same_workspace() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = std::env::temp_dir().join(format!("code-game-create-replay-{}-{}", now_ms(), std::process::id()));
        let first = project_create(&create_args("Tower Defense", "op-replay-1"), &home).unwrap();
        let second = project_create(&create_args("Tower Defense", "op-replay-1"), &home).unwrap();
        assert_eq!(first, second);
        assert_eq!(first["data"]["template"], "hello-city");
        let workspaces = home.join("code-games/workspaces");
        assert_eq!(std::fs::read_dir(&workspaces).unwrap().count(), 1);
        let workspace_id = first["data"]["workspaceId"].as_str().unwrap();
        let meta = read_meta(&workspaces.join(workspace_id)).unwrap();
        assert_eq!(meta.operation_id.as_deref(), Some("op-replay-1"));
        let receipt: Value = serde_json::from_slice(&std::fs::read(home.join("state/creator/code-games/operations/op-replay-1.json")).unwrap()).unwrap();
        assert_eq!(receipt["requestHash"], create_request_hash("Tower Defense", "hello-city"));
        std::fs::remove_dir_all(home).ok();
    }

    /// 同 operationId 但载荷不同 → operation_id_conflict，且不新建工作区。
    #[test]
    fn reused_operation_id_with_a_different_payload_conflicts() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = std::env::temp_dir().join(format!("code-game-create-conflict-{}-{}", now_ms(), std::process::id()));
        project_create(&create_args("Tower Defense", "op-conflict-1"), &home).unwrap();
        let error = project_create(&create_args("Tower Defense II", "op-conflict-1"), &home).unwrap_err();
        assert_eq!(error.code, "operation_id_conflict");
        assert_eq!(std::fs::read_dir(home.join("code-games/workspaces")).unwrap().count(), 1);
        std::fs::remove_dir_all(home).ok();
    }

    /// 崩溃恢复：workspace.json 已带 operationId 但回执缺失 → 补写回执并返回
    /// 既有工作区，不产生第二个工作区；不同载荷仍按 conflict 拒绝。
    #[test]
    fn project_create_recovers_a_partially_created_operation() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = std::env::temp_dir().join(format!("code-game-create-crash-{}-{}", now_ms(), std::process::id()));
        let workspace_id = "gws-deadbeefdeadbeef";
        let workspace = home.join("code-games/workspaces").join(workspace_id);
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::write(workspace.join("src/index.ts"), "export default 0;\n").unwrap();
        write_meta(&workspace, &WorkspaceMeta {
            workspace_id: workspace_id.into(), project_id: "project-crash".into(), game_id: "community.crash".into(),
            title: "Tower Defense".into(), template: "hello-city".into(), created_at_ms: 42, revision: "sha256:test".into(),
            operation_id: Some("op-crash-1".into()),
        }).unwrap();
        let recovered = project_create(&create_args("Tower Defense", "op-crash-1"), &home).unwrap();
        assert_eq!(recovered["data"]["workspaceId"], workspace_id);
        assert_eq!(recovered["data"]["projectId"], "project-crash");
        assert_eq!(recovered["data"]["gameId"], "community.crash");
        assert_eq!(recovered["data"]["gameRevision"], digest_workspace(&workspace).unwrap());
        assert!(home.join("state/creator/code-games/operations/op-crash-1.json").is_file());
        assert_eq!(std::fs::read_dir(home.join("code-games/workspaces")).unwrap().count(), 1);
        assert_eq!(project_create(&create_args("Tower Defense", "op-crash-1"), &home).unwrap(), recovered);
        let conflict = project_create(&create_args("Other Title", "op-crash-1"), &home).unwrap_err();
        assert_eq!(conflict.code, "operation_id_conflict");
        std::fs::remove_dir_all(home).ok();
    }

    /// 旧版 workspace.json 没有 operationId 字段仍可解析（缺省 None）。
    #[test]
    fn workspace_meta_without_operation_id_still_parses() {
        let dir = std::env::temp_dir().join(format!("code-game-meta-compat-{}-{}", now_ms(), std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(META_FILE), r#"{"workspaceId":"gws-0000000000000000","projectId":"project-old","gameId":"community.old","title":"Old","template":"hello-city","createdAtMs":1,"revision":"sha256:test"}"#).unwrap();
        let meta = read_meta(&dir).unwrap();
        assert_eq!(meta.workspace_id, "gws-0000000000000000");
        assert_eq!(meta.project_id, "project-old");
        assert_eq!(meta.operation_id, None);
        std::fs::remove_dir_all(dir).ok();
    }
}
