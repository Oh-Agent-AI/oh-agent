use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::{ToolError};

const MAX_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_SUMMARY_CHARS: usize = 4_000;

#[derive(Clone, Debug)]
pub struct AgentExecutionRequest {
    pub data_home: PathBuf,
    pub goal: String,
    pub human_request: String,
    pub artifact: Value,
    pub plan_revision: u64,
    pub timeout: Duration,
    pub include_viewport: bool,
}

#[derive(Clone, Debug)]
pub struct AgentExecutionSuccess {
    pub summary: String,
    pub preview: Value,
}

#[derive(Clone, Debug)]
pub struct AgentExecutionProgress {
    pub kind: String,
    pub summary: String,
    pub data: Value,
}

pub type AgentProgressCallback = Arc<dyn Fn(AgentExecutionProgress) + Send + Sync>;

fn progress(callback: &AgentProgressCallback, kind: &str, summary: &str, data: Value) {
    callback(AgentExecutionProgress { kind: kind.into(), summary: summary.into(), data });
}

fn noop_progress_callback() -> AgentProgressCallback { Arc::new(|_| {}) }

pub trait CreatorAgentExecutor: Send + Sync {
    fn execute(&self, request: AgentExecutionRequest, cancelled: &AtomicBool) -> Result<AgentExecutionSuccess, ToolError>;
    fn execute_with_progress(&self, request: AgentExecutionRequest, cancelled: &AtomicBool, _callback: &AgentProgressCallback) -> Result<AgentExecutionSuccess, ToolError> {
        self.execute(request,cancelled)
    }
}

pub fn execution_prompt(request: &AgentExecutionRequest) -> String {
    let artifact_kind = request.artifact["kind"].as_str().unwrap_or("creator-project");
    let artifact_id = match artifact_kind {
        "creator-city" => request.artifact["cityId"].as_str().unwrap_or("unknown"),
        "creator-story" => request.artifact["storyId"].as_str().unwrap_or("unknown"),
        _ => request.artifact["projectId"].as_str().unwrap_or("unknown"),
    };
    let proposal_contract = match artifact_kind {
        "creator-city" => "Return exactly one JSON object with this shape: {\"summary\":\"bounded outcome\",\"operations\":[{\"op\":\"world.set\",\"preset\":\"...\",\"params\":{...}}]}.\noperations must contain 1..=16 world.set steps; capability keys, ranges and presets come from creator_capabilities_list category `worlds`.",
        "creator-story" => "Return exactly one JSON object with this shape: {\"summary\":\"bounded outcome\",\"document\":{\"title\":\"...\",\"schemaVersion\":1,\"storyVersion\":\"...\",\"graph\":{...},\"canon\":{...}}}.\ndocument must be one complete story document: graph carries nodes and canon carries established facts.",
        _ => "Return exactly one JSON object with this shape: {\"summary\":\"bounded outcome\",\"operations\":[...]}.\n\
           For a gameplay or rules change, return {\"summary\":\"bounded outcome\",\"game\":{...}} instead, with one complete game definition based on creator_project_read. For a scene change use 1..=128 operations:\n\
           - add/update one object: {\"op\":\"scene.object.upsert\",\"object\":{\"id\":\"<stable-id>\",\"kind\":\"model\",\"asset\":{\"package\":{\"kind\":\"city-minigame\",\"id\":\"<package-id>\",\"version\":\"<version>\",\"digest\":\"sha256:<64hex>\"},\"assetId\":\"<assetId>\",\"digest\":\"sha256:<64hex>\"},\"transform\":{\"positionMeters\":{\"x\":0,\"y\":0,\"z\":0},\"rotationRadians\":{\"x\":0,\"y\":0,\"z\":0},\"scale\":{\"x\":1,\"y\":1,\"z\":1}}}}.\n\
           - add a box collision obstacle as a scene object, not a game rules change: {\"op\":\"scene.object.upsert\",\"object\":{\"id\":\"<stable-id>\",\"kind\":\"collider\",\"shape\":\"box\",\"sizeMeters\":{\"x\":4,\"y\":2,\"z\":3},\"transform\":{\"positionMeters\":{\"x\":0,\"y\":1,\"z\":0},\"rotationRadians\":{\"x\":0,\"y\":0,\"z\":0},\"scale\":{\"x\":1,\"y\":1,\"z\":1}}}}. This kind needs no model asset. Use the requested size and a grounded position based on available scene context; the example transform is illustrative.\n\
           - remove one object: {\"op\":\"scene.object.remove\",\"objectId\":\"<id>\"}.\n\
           Before proposing, call creator_project_read to inspect the current revision. For model objects, reuse EXACT asset entries already registered on the project (assets/assetRefs carry package id/version/digest and assetId) — never invent digests. Call creator_scene_describe to inspect the current scene first. Adding a new visible object is a justified change: return at least one operation whenever the goal asks for one.",
    };
    format!(
        "You are assisting with one Creator Studio task. Analyze only and propose content operations.\n\
         Do not commit, publish, install, write files, or claim that changes were saved.\n\
         Use only these Creator tools: creator_project_read, creator_scene_preview, creator_game_preview, creator_scene_describe, creator_scene_validate, creator_city_view, creator_city_view_status, creator_city_read, creator_city_capture, creator_layout_list, creator_capabilities_list, creator_project_list, creator_story_project_read, creator_story_graph_inspect, creator_operation_status. Do not call any other tool.\n\
         The host will independently create and validate any Preview.\n\
         {proposal_contract}\n\
         Use no operations and no document only when no change is justified; a Preview is required for a successful task.\n\
         Goal: {}\nHuman request: {}\nArtifact: {} {} at expected revision {}.\nPlan revision: {}.",
        request.goal, request.human_request, artifact_kind, artifact_id,
        request.artifact["expectedRevision"].as_u64().unwrap_or(0), request.plan_revision,
    )
}

fn mcp_config_args(creator_binary: &std::path::Path, data_home: &Path) -> Vec<OsString> {
    let executable = creator_binary.to_string_lossy().into_owned();
    vec![
        "--config".into(), format!("mcp_servers.creator.command={}", json!(executable)).into(),
        "--config".into(), "mcp_servers.creator.args=[\"data-mcp\",\"serve\"]".into(),
        "--config".into(), "mcp_servers.creator.startup_timeout_sec=15".into(),
        "--config".into(), "mcp_servers.creator.tool_timeout_sec=30".into(),
        "--config".into(), format!("mcp_servers.creator.env.AGENT_VITALS_HOME={}", json!(data_home.to_string_lossy())).into(),
    ]
}

pub struct CodexCliAgentExecutor {
    program: OsString,
    /// creator MCP 二进制：宿主显式传入（resolve_binary），缺省回退自身。
    creator_binary: std::path::PathBuf,
}

impl Default for CodexCliAgentExecutor {
    fn default() -> Self { Self::new() }
}

impl CodexCliAgentExecutor {
    pub fn new() -> Self {
        Self { program: OsString::from("codex"),
            creator_binary: std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("agent-vitals")) }
    }

    pub fn with_creator_binary(creator_binary: Option<&std::path::Path>) -> Self {
        let mut executor = Self::new();
        if let Some(path) = creator_binary { executor.creator_binary = path.to_path_buf(); }
        executor
    }

    fn run_codex_with_progress(&self, request: &AgentExecutionRequest, cancelled: &AtomicBool, callback: &AgentProgressCallback) -> Result<Value, ToolError> {
        // 模型方差（叙述文结尾而非 JSON 提案）在单发 exec 上并不罕见：解析失败自动
        // 重试一次，重试前上报进度；第二次仍失败才返回 codex_output_invalid。
        let mut attempt = 0u32;
        loop {
        let mut command = Command::new(&self.program);
        // bypass 审批与沙箱：exec 模式下 MCP 工具调用一律要求审批且无从批准（never=拒答），
        // 只读沙箱会把 creator MCP 全部拒掉，Agent 只能交空提案。写路径的诚实闸不在
        // Codex 沙箱上，而在宿主 creator MCP（不带 --allow-local-writes，写一律拒绝）
        // 与宿主 Preview→人工确认→commit 链；与用户桌面 Codex 的默认权限形态一致。
        command.arg("exec").arg("--dangerously-bypass-approvals-and-sandbox").arg("--ephemeral").arg("--json").arg("--skip-git-repo-check")
            .args(mcp_config_args(&self.creator_binary, &request.data_home))
            .arg(execution_prompt(request))
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.env_clear();
        for key in ["PATH", "HOME", "USER", "TMPDIR", "CODEX_HOME"] {
            if let Some(value) = std::env::var_os(key) { command.env(key, value); }
        }
        command.env("AGENT_VITALS_HOME", &request.data_home);
        let mut child = command.spawn().map_err(|_| ToolError::new("codex_unavailable", "Codex CLI is unavailable."))?;
        progress(callback,"plan","Codex 已接收执行请求",json!({"transport":"codex-jsonl"}));
        let stdout = child.stdout.take().ok_or_else(|| ToolError::new("codex_output_invalid", "Codex stdout is unavailable."))?;
        let stderr = child.stderr.take().ok_or_else(|| ToolError::new("codex_output_invalid", "Codex stderr is unavailable."))?;
        let output_callback = callback.clone();
        let stdout_thread = std::thread::spawn(move || read_codex_output(std::io::BufReader::new(stdout),&output_callback));
        let stderr_thread = std::thread::spawn(move || read_bounded(stderr));
        let started = Instant::now();
        let status = loop {
            if cancelled.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(ToolError::new("codex_cancelled", "Codex execution was cancelled."));
            }
            if started.elapsed() >= request.timeout {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(ToolError::new("codex_timeout", "Codex execution timed out."));
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ToolError::new("codex_failed", "Codex process failed."));
                }
            }
        };
        let stdout = stdout_thread.join().unwrap_or_default();
        let stderr_tail = stderr_thread.join().unwrap_or_default();
        // stderr/stdout 观察进进度事件（有界）：MCP server 启动失败只见于 stderr
        //（figma 噪音可忽略），stdout 的 error 项携带 creator server 的真实失败。
        let stdout_text = String::from_utf8_lossy(&stdout);
        let tool_call_events = stdout_text.matches("mcp_tool_call").count();
        let first_error = stdout_text.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|value| value["type"].as_str() == Some("item.completed") && value["item"]["type"].as_str() == Some("error"))
            .and_then(|value| value["item"]["message"].as_str().map(str::to_owned));
        progress(callback,"executor-output","Codex 会话观察",json!({
            "toolCallEvents": tool_call_events,
            "stderrTail": bounded_error_tail(&stderr_tail),
            "firstErrorItem": first_error.map(|text| text.chars().take(300).collect::<String>()),
        }));
        if !status.success() {
            let (code, message) = classify_codex_failure(&stdout, &stderr_tail);
            return Err(ToolError::new(code, message));
        }
        let candidates = extract_candidate_texts(&stdout);
        if candidates.is_empty() {
            if attempt == 0 {
                attempt += 1;
                progress(callback,"progress","Codex 提案解析失败，自动重试一次",json!({"attempt":2}));
                continue;
            }
            return Err(ToolError::new("codex_output_invalid", "Codex returned no usable agent text."));
        }
        // 从最后一条往前逐个尝试：模型可能「提案 → 叙述」或「叙述 → 提案」。
        let mut last_error: Option<ToolError> = None;
        for candidate in candidates.iter().rev() {
            match parse_proposal(candidate) {
                Ok(value) => return Ok(value),
                Err(error) => last_error = Some(error),
            }
        }
        let error = last_error.unwrap_or_else(|| ToolError::new("codex_output_invalid", "Agent response is not valid JSON."));
        if attempt == 0 && error.code == "codex_output_invalid" {
            attempt += 1;
            progress(callback,"progress","Codex 提案解析失败，自动重试一次",json!({"attempt":2}));
            continue;
        }
        return Err(error);
    }
}
}

/// 失败分类（纯函数，可单测）：配额耗尽是可恢复且有替代路径的失败（换 Agent 重试），
/// 单独成码，让 UI 能给出行动建议；其余失败统一 codex_failed + stderr 尾部。
fn classify_codex_failure(stdout: &[u8], stderr: &[u8]) -> (&'static str, String) {
    let combined = format!("{}{}", String::from_utf8_lossy(stdout), String::from_utf8_lossy(stderr));
    let lowered = combined.to_lowercase();
    if lowered.contains("usage limit") || lowered.contains("usage has been exhausted") {
        let recovery = combined.lines().rev().find(|line| line.to_lowercase().contains("try again"))
            .map(|line| line.trim().chars().take(160).collect::<String>())
            .unwrap_or_default();
        return ("codex_quota_exhausted", format!("Codex usage limit reached; wait for the quota window or retry with another executor.{recovery}"));
    }
    if lowered.contains("unauthorized") || lowered.contains("not logged in") || lowered.contains("please log in") {
        return ("codex_auth_expired", format!("Codex authentication is missing or expired; sign in again or retry with another executor.{}", bounded_error_tail(stderr)));
    }
    ("codex_failed", format!("Codex returned a failure status. {}", bounded_error_tail(stderr)))
}

impl CreatorAgentExecutor for CodexCliAgentExecutor {
    fn execute(&self, request: AgentExecutionRequest, cancelled: &AtomicBool) -> Result<AgentExecutionSuccess, ToolError> {
        self.execute_with_progress(request,cancelled,&noop_progress_callback())
    }
    fn execute_with_progress(&self, request: AgentExecutionRequest, cancelled: &AtomicBool, callback: &AgentProgressCallback) -> Result<AgentExecutionSuccess, ToolError> {
        if request.include_viewport {
            return Err(ToolError::new("acp_image_unsupported", "Use an ACP connection that supports image prompts."));
        }
        let proposal = self.run_codex_with_progress(&request, cancelled, callback)?;
        progress(callback,"progress","Codex 提案已完成，等待 Host Preview",json!({"stage":"host-preview"}));
        finish_with_host_preview(request, proposal)
    }
}

fn acp_prompt(request: &AgentExecutionRequest, initialized: &Value) -> Result<Vec<Value>, ToolError> {
    let mut blocks = vec![json!({"type":"text","text":execution_prompt(request)})];
    if !request.include_viewport { return Ok(blocks); }
    if initialized.pointer("/agentCapabilities/promptCapabilities/image").and_then(Value::as_bool) != Some(true) {
        return Err(ToolError::new("acp_image_unsupported", "This ACP agent does not accept image prompts."));
    }
    let (tool, id_key) = match request.artifact["kind"].as_str() {
        Some("creator-project") => ("creator_scene_capture", "projectId"),
        Some("creator-city") => ("creator_city_capture", "cityId"),
        _ => return Err(ToolError::new("creator_capture_unavailable", "This task has no game viewport.")),
    };
    let id = &request.artifact[id_key];
    let revision = &request.artifact["expectedRevision"];
    let capture = super::creator_studio::run(tool, &json!({(id_key):id,"revision":revision}), &request.data_home, false)?;
    if id_key == "projectId" && capture["data"]["isolatedViewport"] != true {
        return Err(ToolError::new("creator_capture_unavailable", "Open a ready, isolated project viewport to attach an image."));
    }
    if capture["data"][id_key] != *id || capture["data"]["revision"] != *revision
        || (id_key == "projectId" && capture["data"]["viewportRevision"] != *revision) {
        return Err(ToolError::new("creator_capture_unavailable", "The viewport no longer matches the task revision."));
    }
    let image = &capture["content"][0];
    if image["type"] != "image" || image["mimeType"] != "image/jpeg" || image["data"].as_str().map_or(true, str::is_empty) {
        return Err(ToolError::new("creator_capture_unavailable", "The viewport did not return an image."));
    }
    blocks.push(json!({"type":"text","text":"The attached JPEG is the current editor viewport for the task revision. Use it as a visual reference and verify scene object IDs and coordinates with the Creator tools."}));
    blocks.push(image.clone());
    Ok(blocks)
}

/// 提案 → 宿主独立校验的 Preview（push 执行器共用收尾）。Agent 永远不落库；
/// preview 由宿主面（scene/city/story preview）生成并绑定 baseRevision，
/// 提交仍在人工确认后由 Studio 发起。
fn finish_with_host_preview(request: AgentExecutionRequest, proposal: Value) -> Result<AgentExecutionSuccess, ToolError> {
    let response = match request.artifact["kind"].as_str().unwrap_or("creator-project") {
        "creator-city" => finish_city_preview(&request, &proposal)?,
        "creator-story" => finish_story_preview(&request, &proposal)?,
        _ => finish_project_preview(&request, &proposal)?,
    };
    let preview = validated_host_preview(response, request.artifact["expectedRevision"].as_u64())?;
    Ok(AgentExecutionSuccess { summary: proposal["summary"].as_str().unwrap_or("Agent proposal received.").chars().take(MAX_SUMMARY_CHARS).collect(), preview })
}

/// 失败诊断用：提案概要（操作数与前几个 op 类型），不携带完整内容。
fn proposal_outline(proposal: &Value) -> String {
    match proposal["operations"].as_array() {
        Some(items) if !items.is_empty() => format!(
            "proposal has {} operations ({})",
            items.len(),
            items.iter().take(4).map(|op| op.get("op").and_then(Value::as_str)
                .map(str::to_owned).unwrap_or_else(|| "unknown".into())).collect::<Vec<_>>().join(", "))
        ,
        Some(_) => "proposal has an empty operations array".into(),
        None => {
            "proposal has no operations field".into()
        }
    }
}

fn finish_project_preview(request: &AgentExecutionRequest, proposal: &Value) -> Result<Value, ToolError> {
    if let Some(game) = proposal.get("game").filter(|value| value.is_object()) {
        if proposal.get("operations").is_some() {
            return Err(ToolError::new("preview_required", "Choose one proposal: game rules or scene operations."));
        }
        return super::creator_studio::run("creator_game_preview", &json!({
            "projectId": request.artifact["projectId"], "baseRevision": request.artifact["expectedRevision"], "game": game,
        }), &request.data_home, false);
    }
    if proposal["operations"].as_array().map_or(true, |operations| operations.is_empty()) {
        let summary = proposal["summary"].as_str()
            .map(|text| format!(" Agent summary: {}", text.chars().take(300).collect::<String>()))
            .unwrap_or_default();
        return Err(ToolError::new("preview_required", format!("Agent did not produce previewable operations ({}).{summary}", proposal_outline(proposal))));
    }
    super::creator_studio::run("creator_scene_preview", &json!({
        "projectId": request.artifact["projectId"], "baseRevision": request.artifact["expectedRevision"],
        "operations": proposal["operations"],
    }), &request.data_home, false).map_err(|error| ToolError::new(error.code, format!("{} ({})", error.message, proposal_outline(proposal))))
}

fn finish_city_preview(request: &AgentExecutionRequest, proposal: &Value) -> Result<Value, ToolError> {
    let operations = proposal["operations"].as_array().filter(|items| !items.is_empty() && items.len() <= 16)
        .ok_or_else(|| ToolError::new("preview_required", "City proposals need 1..=16 world.set operations; see creator_capabilities_list category `worlds`."))?;
    super::creator_studio::run("creator_city_edit_preview", &json!({
        "cityId": request.artifact["cityId"], "baseRevision": request.artifact["expectedRevision"],
        "operations": operations,
    }), &request.data_home, false)
}

fn finish_story_preview(request: &AgentExecutionRequest, proposal: &Value) -> Result<Value, ToolError> {
    let document = proposal.get("document").filter(|value| value.is_object())
        .ok_or_else(|| ToolError::new("preview_required", "Story proposals need a complete document object (title, schemaVersion, storyVersion, graph, canon)."))?;
    super::creator_studio::run("creator_story_preview", &json!({
        "storyId": request.artifact["storyId"],
        "title": document["title"], "schemaVersion": document["schemaVersion"], "storyVersion": document["storyVersion"],
        "graph": document["graph"], "canon": document["canon"],
    }), &request.data_home, false)
}

fn validated_host_preview(response: Value, expected_revision: Option<u64>) -> Result<Value, ToolError> {
    let envelope_keys = format!("{:?}", response.as_object().map(|object| object.keys().cloned().collect::<Vec<_>>()).unwrap_or_default());
    let preview = response.get("data").cloned().ok_or_else(|| ToolError::new("preview_required", format!("Host returned no Preview data ({envelope_keys}).")))?;
    if preview["previewId"].as_str().map_or(true, |id| id.is_empty())
        || expected_revision.is_none() || preview["baseRevision"].as_u64() != expected_revision {
        let actual_revision = preview["baseRevision"].as_u64().map(|value| value.to_string()).unwrap_or_else(|| "missing".into());
        return Err(ToolError::new("preview_required", format!("Host did not return a valid revision-bound Preview (baseRevision {actual_revision}, expected {}).", expected_revision.map(|value| value.to_string()).unwrap_or_else(|| "unknown".into()))));
    }
    Ok(preview)
}

/// 执行器选择：push 模式的 transport 通用化入口。默认 Codex CLI（既有路径不变）；
/// "acp" 走 Agent Client Protocol（JSON-RPC over stdio），任何 ACP agent 零适配接入。
/// mode 门控（R3）：restricted 是默认档；codex exec 单发通道没有审批处理者，
/// 只能跑 full-access，受限请求在这里如实拒绝而不是静默放行。
pub fn select_executor(payload: &Value, data_home: &Path, creator_binary: Option<&std::path::Path>, mode: &str) -> Result<Box<dyn CreatorAgentExecutor>, ToolError> {
    match payload.get("executor").and_then(Value::as_str) {
        None | Some("codex") => {
            if mode != "full-access" {
                return Err(ToolError::new("executor_mode_unsupported",
                    "codex exec 不支持受限模式（exec 无审批处理者）；请选择受限 ACP，或显式请求 full-access。"));
            }
            Ok(Box::new(CodexCliAgentExecutor::with_creator_binary(creator_binary)))
        }
        Some(name) if name == "acp" || name.starts_with("acp:") => {
            let id = name.strip_prefix("acp:").unwrap_or("default");
            Ok(Box::new(AcpAgentExecutor::select(id, data_home, mode, creator_binary)?))
        }
        Some(other) => Err(ToolError::new("invalid_argument", format!("Unknown executor `{other}`; supported: codex, acp[:<agentId>]."))),
    }
}

/// ACP 执行器注册表条目（acp-agents.json）：{id,name,command,args}。无文件时
/// 退回 AGENT_VITALS_ACP_BIN（id=default），保持既有单通道配置可用。
pub struct AcpRegistryEntry { pub id: String, pub name: String, pub program: OsString, pub args: Vec<OsString> }

fn agent_search_paths() -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::env::var_os("PATH").iter()
        .flat_map(|value| std::env::split_paths(value))
        .filter(|path| path.is_absolute()).collect();
    #[cfg(target_os = "macos")]
    {
        // Finder and login items can start the Host without the shell's PATH.
        if let Some(user_dir) = std::env::var_os("HOME").map(PathBuf::from).filter(|dir| dir.is_absolute()) {
            paths.push(user_dir.join(".local/bin"));
        }
        paths.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    }
    paths
}

pub fn acp_registry(data_home: &Path) -> Vec<AcpRegistryEntry> {
    let mut entries = Vec::new();
    let path = data_home.join("acp-agents.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            for item in value.get("agents").and_then(Value::as_array).unwrap_or(&Vec::new()) {
                let id = item.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                let command = item.get("command").and_then(Value::as_str).unwrap_or_default().to_owned();
                if id.is_empty() || command.is_empty() { continue; }
                entries.push(AcpRegistryEntry {
                    id, name: item.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
                    program: OsString::from(command),
                    args: item.get("args").and_then(Value::as_array).map(|args|
                        args.iter().filter_map(Value::as_str).map(OsString::from).collect()).unwrap_or_default(),
                });
            }
        }
    }
    if entries.is_empty() {
        if let Some(program) = std::env::var_os("AGENT_VITALS_ACP_BIN") {
            entries.push(AcpRegistryEntry { id: "default".into(), name: "已配置的 ACP Agent".into(), program,
                args: std::env::var("AGENT_VITALS_ACP_ARGS").unwrap_or_default().split_whitespace().map(OsString::from).collect() });
        }
    }
    // Explicit configurations take precedence over local executable discovery.
    let search_paths = agent_search_paths();
    for (id, name, candidates, args) in [
        ("codex", "Codex", &["codex-acp"][..], &[][..]),
        ("claude-code", "Claude Code", &["claude-code-acp", "acp-claude"][..], &[][..]),
        ("zcode", "ZCode", &["zcode-acp"][..], &[][..]),
        ("kimi-code", "Kimi Code", &["kimi"][..], &["acp"][..]),
        ("deepseek-harness", "DeepSeek Harness", &["dsh"][..], &["acp"][..]),
    ] {
        if entries.iter().any(|entry| entry.id == id) { continue; }
        let program = candidates.iter().find_map(|candidate| {
            search_paths.iter().map(|path| path.join(candidate)).find(|path| path.is_file())
        });
        entries.push(AcpRegistryEntry { id: id.into(), name: name.into(),
            program: program.map(|path| path.into_os_string()).unwrap_or_default(),
            args: args.iter().map(OsString::from).collect() });
    }
    entries
}

/// 注册表已配置的 ACP agent 摘要（供 capabilities 面渲染执行器下拉）。
pub fn acp_registry_summary(data_home: &Path) -> Value {
    Value::Array(acp_registry(data_home).into_iter().map(|entry| json!({
        "id": entry.id, "name": if entry.name.is_empty() { entry.id.clone() } else { entry.name },
    })).collect())
}

/// 执行器能力探测（R3 真实能力探测）：每个执行器报告可用性与支持的权限模式。
/// codex exec 单发通道没有审批处理者（MCP 工具一律拒答，实测 trusted/tool_approval
/// 配置均不被识别），只有完全访问一种形态；ACP 经 session/new 的 modes 报告受限档。
/// 探测会 spawn 子进程，结果缓存 60s（capabilities.status 被 UI 心跳轮询）。
pub fn probe_executors(data_home: &Path) -> Value {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<(std::path::PathBuf, std::time::Instant, Value)>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((home, at, value)) = guard.as_ref() {
            if home == data_home && at.elapsed() < Duration::from_secs(60) { return value.clone(); }
        }
    }
    let fresh = probe_executors_uncached(data_home);
    if let Ok(mut guard) = cache.lock() { *guard = Some((data_home.to_path_buf(), std::time::Instant::now(), fresh.clone())); }
    fresh
}

fn probe_executors_uncached(data_home: &Path) -> Value {
    let mut executors = Vec::new();
    // Codex CLI：二进制可达性 + 固定形态说明。
    let codex_available = Command::new("codex").arg("--version")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .output().map(|output| output.status.success()).unwrap_or(false);
    executors.push(json!({
        "id": "codex", "name": "Codex CLI", "available": codex_available,
        "modes": [{"id": "full-access", "restricted": false, "label": "完全访问"}],
        "detail": if codex_available { String::from("exec 单发无审批处理者；写闸在宿主 MCP 只读 + 确认保存。受限执行待 app-server 适配（上线阻塞项）。") } else { String::from("codex CLI 不在 PATH") },
    }));
    // ACP 注册表条目：探测 = initialize + session/new，读取 modes；8s 有界。
    // authMethods 非空不再判死（与正式执行一致：authenticate 未实现/既有登录都继续）。
    for entry in acp_registry(data_home) {
        if entry.program.is_empty() {
            let detail = if entry.id == "deepseek-harness" {
                "请配置 DeepSeek Harness 的 ACP 连接命令。"
            } else { "未找到 ACP 程序，请安装或配置连接。" };
            executors.push(acp_probe_entry(&entry, false, false, Vec::new(), detail.into()));
            continue;
        }
        let needs_login;
        let probe = probe_acp_modes(&entry.program, &entry.args);
        let (available, modes, detail) = match probe {
            Ok(modes) => { needs_login = false; (true, modes, "会话能力来自 agent 实测".into()) }
            Err(error) if error.contains("需要先完成自身登录") => { needs_login = true; (false, Vec::new(), error) }
            Err(error) => { needs_login = false; (false, Vec::new(), error) }
        };
        let probe_entry = acp_probe_entry(&entry, available, needs_login, modes, detail);
        executors.push(probe_entry);
    }
    Value::Array(executors)
}

/// ACP 探测条目组装（字段按 R3 审查要求分列：协议连通、登录状态、权限档位；
/// Creator 工具连通在探测路径不验证，如实标记 false）。
fn acp_probe_entry(entry: &AcpRegistryEntry, available: bool, needs_login: bool,
    modes: Vec<Value>, detail: String) -> Value {
    let display_name = if entry.name.is_empty() { entry.id.clone() } else { entry.name.clone() };
    json!({
        "id": format!("acp:{}", entry.id), "name": display_name,
        "available": available,
        "protocolReachable": available,
        "needsLogin": needs_login,
        "modes": modes,
        "creatorToolsVerified": false,
        "detail": detail,
    })
}

/// 从 ACP session/new 结果提取模式档位（纯函数，可单测）。
fn acp_modes_from_session(result: &Value) -> Vec<Value> {
    let modes = result.get("modes")
        .and_then(|modes| modes.get("availableModes"))
        .and_then(Value::as_array).cloned().unwrap_or_default();
    let current = result.get("modes").and_then(|modes| modes.get("currentModeId"))
        .and_then(Value::as_str).unwrap_or_default().to_owned();
    // 受限档启发：plan 模式（只分析不执行）标记为受限提案；bypass/全权类标记为完全访问。
    modes.iter().filter_map(|mode| {
        let id = mode.get("id").and_then(Value::as_str)?;
        let restricted = matches!(id, "plan" | "read-only" | "restricted");
        let label = mode.get("name").and_then(Value::as_str).unwrap_or(id).to_owned();
        Some(json!({"id": id, "restricted": restricted, "label": label,
            "current": current == id}))
    }).collect()
}

fn probe_acp_modes(program: &OsString, args: &[OsString]) -> Result<Vec<Value>, String> {
    use std::io::Write as _;
    let mut child = Command::new(program).args(args)
        .env("PATH", std::env::join_paths(agent_search_paths()).map_err(|error| error.to_string())?)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|error| format!("spawn 失败：{error}"))?;
    let mut stdin = child.stdin.take().ok_or("stdin 不可用")?;
    let stdout = child.stdout.take().ok_or("stdout 不可用")?;
    let _ = stdin.write_all(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}).to_string().as_bytes());
    let _ = stdin.write_all(b"\n");
    let _ = stdin.flush();
    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => { let _ = sender.send(String::new()); break; }
                Ok(_) => { if sender.send(String::from_utf8_lossy(&line).to_string()).is_err() { break; } }
                Err(_) => break,
            }
        }
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut session_result: Option<Value> = None;
    let mut sent_session = false;
    let mut needs_login = false;
    // 探测会话按需创建：需登录的 agent 不建会话。
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() { break; }
        let line = match receiver.recv_timeout(remaining.min(Duration::from_millis(300))) {
            Ok(line) => line,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => { if session_result.is_some() { break; } continue; }
            Err(_) => break,
        };
        if line.trim().is_empty() { if session_result.is_some() { break; } continue; }
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        if message["id"].as_u64() == Some(1) && message.get("result").is_some() {
            let has_auth = message["result"]["authMethods"].as_array().is_some_and(|methods| !methods.is_empty());
            if has_auth {
                // 与正式执行一致：authenticate 未实现/失败都继续建会话（agent 可用既有登录）。
                let _ = writeln!(stdin, "{}", json!({"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":message["result"]["authMethods"][0]["id"]}}));
                let _ = stdin.flush();
                sent_session = false;
            } else {
                let _ = writeln!(stdin, "{}", json!({"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":std::env::temp_dir().to_string_lossy(),"mcpServers":[]}}));
                let _ = stdin.flush();
                sent_session = true;
            }
        } else if message["id"].as_u64() == Some(2) && !sent_session {
            // authenticate 应答：错误也继续（如 Method not implemented）；结果同样继续。
            let _ = writeln!(stdin, "{}", json!({"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":std::env::temp_dir().to_string_lossy(),"mcpServers":[]}}));
            let _ = stdin.flush();
            sent_session = true;
        } else if sent_session && message["id"].as_u64() == Some(3) {
            if message.get("result").is_some() {
                session_result = Some(message["result"].clone());
            } else {
                // session/new 失败：真正的登录/权限问题在这里暴露。
                needs_login = true;
            }
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    if needs_login { return Err("agent 需要先完成自身登录".into()); }
    session_result.map(|result| acp_modes_from_session(&result))
        .ok_or_else(|| "探测超时或 agent 需要登录".into())
}

impl AcpAgentExecutor {
    /// 按 id 选择注册表条目；id=default 时退回 AGENT_VITALS_ACP_BIN 环境配置。
    /// restricted（R3 门控）：mode != "full-access" 一律按受限会话驱动，缺省受限。
    pub fn select(id: &str, data_home: &Path, mode: &str, creator_binary: Option<&Path>) -> Result<Self, ToolError> {
        let restricted = mode != "full-access";
        let creator_binary = creator_binary.map(Path::to_path_buf)
            .or_else(|| std::env::var_os("AGENT_VITALS_BIN").map(PathBuf::from))
            .unwrap_or_else(Self::default_creator_binary);
        if id == "default" {
            let mut executor = Self::from_env();
            executor.restricted = restricted;
            executor.creator_binary = creator_binary;
            return Ok(executor);
        }
        let entry = acp_registry(data_home).into_iter().find(|entry| entry.id == id)
            .ok_or_else(|| ToolError::new("invalid_argument", format!("Unknown ACP agent `{id}`; configure it in acp-agents.json.")))?;
        if entry.program.is_empty() { return Err(ToolError::new("acp_unavailable", "ACP connection is not installed or configured.")); }
        Ok(Self { program: entry.program, args: entry.args, restricted, creator_binary })
    }
}

const ACP_PROTOCOL_VERSION: u64 = 1;
const ACP_LINE_BYTES: usize = 4 * 1024 * 1024;

/// Agent Client Protocol (v1, JSON-RPC over stdio, newline-delimited) transport。
/// 宿主是 ACP client：spawn 任意 ACP agent 子进程，注入 creator MCP（data-mcp
/// serve），发送 analyze-only 提示，收集最终文本提案。复用与 Codex 路径相同的
/// 提案解析与宿主 Preview 收尾；Agent 的工具面同样受 MCP 只读策略约束。
/// restricted（R3 门控）：true 时建会话后必须真的切到受限模式（等应答，失败即拒）。
pub struct AcpAgentExecutor { program: OsString, args: Vec<OsString>, restricted: bool, creator_binary: PathBuf }

impl AcpAgentExecutor {
    /// 命令来源：AGENT_VITALS_ACP_BIN（默认 `claude-code-acp`）+ AGENT_VITALS_ACP_ARGS
    /// （空白切分）。凭据由 Agent 自管（宿主不经手任何 token）。默认受限档。
    pub fn from_env() -> Self {
        let program = std::env::var_os("AGENT_VITALS_ACP_BIN").unwrap_or_else(|| OsString::from("claude-code-acp"));
        let args = std::env::var("AGENT_VITALS_ACP_ARGS").unwrap_or_default().split_whitespace().map(OsString::from).collect();
        Self { program, args, restricted: true, creator_binary: Self::default_creator_binary() }
    }

    fn default_creator_binary() -> PathBuf {
        std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-vitals"))
    }

    fn send(stdin: &mut impl std::io::Write, message: &Value) -> Result<(), ToolError> {
        let mut line = serde_json::to_string(message).map_err(|_| ToolError::new("acp_failed", "ACP message serialization failed."))?;
        line.push('\n');
        stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush())
            .map_err(|_| ToolError::new("acp_failed", "ACP agent stdin closed."))
    }

    /// 驱动一次 ACP 会话：initialize → (authenticate) → session/new → session/prompt，
    /// 期间应答 `session/request_permission`（一律拒绝/取消——analyze-only 策略），
    /// 拒绝 fs/terminal/elicitation 客户端方法（Agent 应回退到 MCP 只读工具），
    /// 收集 `agent_message_chunk` 文本作为最终提案。
    fn run_acp_with_progress(&self, request: &AgentExecutionRequest, cancelled: &AtomicBool, callback: &AgentProgressCallback) -> Result<Value, ToolError> {
        self.with_acp_process(|stdin, receiver| {
            self.drive(stdin, receiver, request, cancelled, Instant::now() + request.timeout, callback)
        })
    }

    fn with_acp_process<T>(&self, work: impl FnOnce(&mut std::process::ChildStdin, &std::sync::mpsc::Receiver<String>) -> Result<T, ToolError>) -> Result<T, ToolError> {
        let mut command = Command::new(&self.program);
        command.args(&self.args)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.env_clear();
        for key in ["HOME", "USER", "TMPDIR"] {
            if let Some(value) = std::env::var_os(key) { command.env(key, value); }
        }
        command.env("PATH", std::env::join_paths(agent_search_paths())
            .map_err(|_| ToolError::new("acp_unavailable", "Invalid ACP executable search path."))?);
        command.current_dir(std::env::temp_dir());
        let mut child = command.spawn().map_err(|_| ToolError::new("acp_unavailable", "ACP agent is unavailable (set AGENT_VITALS_ACP_BIN)."))?;
        let mut stdin = child.stdin.take().ok_or_else(|| ToolError::new("acp_failed", "ACP agent stdin unavailable."))?;
        let stdout = child.stdout.take().ok_or_else(|| ToolError::new("acp_failed", "ACP agent stdout unavailable."))?;
        let stderr = child.stderr.take().ok_or_else(|| ToolError::new("acp_failed", "ACP agent stderr unavailable."))?;
        let stderr_thread = std::thread::spawn(move || read_bounded(stderr));
        let (sender, receiver) = std::sync::mpsc::channel::<String>();
        let reader = std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if line.last() == Some(&b'\n') { line.pop(); }
                        if line.len() > ACP_LINE_BYTES { line.clear(); continue; }
                        if sender.send(String::from_utf8_lossy(&line).into_owned()).is_err() { break; }
                    }
                    Err(_) => break,
                }
            }
        });
        let result = work(&mut stdin, &receiver);
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader.join();
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                let stderr_tail = stderr_thread.join().unwrap_or_default();
                let stderr_tail = String::from_utf8_lossy(&stderr_tail);
                if stderr_tail.trim().is_empty() { Err(error) }
                else { Err(ToolError::new(error.code, format!("{} | agent stderr: {}", error.message, stderr_tail.trim().chars().take(400).collect::<String>()))) }
            }
        }
    }

    fn request(stdin: &mut impl std::io::Write, receiver: &std::sync::mpsc::Receiver<String>, next_id: &mut u64,
        method: &str, params: Value, cancelled: &AtomicBool, deadline: Instant) -> Result<Value, ToolError> {
        *next_id += 1;
        let id = *next_id;
        Self::send(stdin, &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        loop {
            if cancelled.load(Ordering::Relaxed) { return Err(ToolError::new("acp_cancelled", "ACP execution was cancelled.")); }
            if Instant::now() >= deadline { return Err(ToolError::new("acp_timeout", "ACP execution timed out.")); }
            let line = match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => line,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err(ToolError::new("acp_failed", "ACP agent closed its output.")),
            };
            // Some launchers print startup diagnostics on stdout before their
            // JSON-RPC response. Ignore those lines and keep the same deadline.
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            if message["id"].as_u64() != Some(id) { continue; }
            if let Some(error) = message.get("error") {
                return Err(ToolError::new("acp_failed", format!("{method} failed: {}", error["message"].as_str().unwrap_or("unknown"))));
            }
            return Ok(message["result"].clone());
        }
    }

    fn drive(&self, stdin: &mut impl std::io::Write, receiver: &std::sync::mpsc::Receiver<String>,
        request: &AgentExecutionRequest, cancelled: &AtomicBool, deadline: Instant, callback: &AgentProgressCallback) -> Result<Value, ToolError> {
        let executable = self.creator_binary.to_string_lossy();
        let mcp = json!([{"name":"creator","command":executable,"args":["data-mcp","serve"],
            "env":[{"name":"AGENT_VITALS_HOME","value":request.data_home.to_string_lossy()}]}]);
        let (initialized, session_id, mut next_id) = self.connect(stdin, receiver, mcp, cancelled, deadline, callback)?;
        let prompt = acp_prompt(request, &initialized)?;
        let response = Self::prompt(stdin, receiver, &session_id, &mut next_id, prompt, cancelled, deadline, callback)?;
        if let Ok(proposal) = parse_proposal(&response) {
            if !proposal["operations"].as_array().is_some_and(Vec::is_empty) {
                return Ok(proposal);
            }
        }
        progress(callback, "progress", "正在请 Agent 补齐可预览的提案", json!({"stage":"proposal-repair"}));
        let correction = vec![json!({"type":"text","text":
            "Your previous reply did not provide a usable proposal. Using the original goal and artifact, return only one JSON object with summary and exactly one of operations (non-empty), game, or document, as specified for this artifact. If you called a preview tool, return the proposal content you sent to it, not the preview receipt. A box collider uses scene.object.upsert with kind collider, shape box, sizeMeters and transform. Do not save or publish."})];
        let response = Self::prompt(stdin, receiver, &session_id, &mut next_id, correction, cancelled, deadline, callback)?;
        parse_proposal(&response).map_err(|error| ToolError::new("acp_output_invalid", error.message))
    }

    /// Run an Actor session with a minimal prompt surface and no injected MCP servers.
    pub fn run_actor_session(entry: AcpRegistryEntry, cancelled: &AtomicBool,
        work: impl FnOnce(&mut dyn FnMut(String) -> Result<String, ToolError>) -> Result<(), ToolError>,
    ) -> Result<(), ToolError> {
        let executor = Self { program: entry.program, args: entry.args, restricted: true, creator_binary: Self::default_creator_binary() };
        let callback = noop_progress_callback();
        executor.with_acp_process(|stdin, receiver| {
            let (_, session_id, mut next_id) = executor.connect(stdin, receiver, json!([]), cancelled,
                Instant::now() + Duration::from_secs(20), &callback)?;
            work(&mut |text| Self::prompt(stdin, receiver, &session_id, &mut next_id,
                vec![json!({"type":"text","text":text})], cancelled, Instant::now() + Duration::from_secs(30), &callback))
        })
    }

    fn connect(&self, stdin: &mut impl std::io::Write, receiver: &std::sync::mpsc::Receiver<String>,
        mcp: Value, cancelled: &AtomicBool, deadline: Instant, callback: &AgentProgressCallback,
    ) -> Result<(Value, String, u64), ToolError> {
        let mut next_id = 0u64;
        let initialized = Self::request(stdin, receiver, &mut next_id, "initialize", json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
            "clientInfo": {"name": "oh-agent-creator", "title": "Oh Agent Creator", "version": "1.0.0"},
        }), cancelled, deadline)?;
        progress(callback,"plan","ACP initialize 已完成",json!({"protocolVersion":ACP_PROTOCOL_VERSION}));
        let auth_methods = initialized["authMethods"].as_array().cloned().unwrap_or_default();
        if let Some(method) = auth_methods.first().and_then(|entry| entry["id"].as_str().map(str::to_owned)) {
            // 部分 ACP agent（如 claude-code-acp）声明 authMethods 但不实现 authenticate
            //（错误细节在 data.details，不进 message）：认证由底层 CLI 会话自管。失败一律
            // 继续建会话；真正的认证问题在 session/new 处按错误消息分类暴露。
            if let Err(error) = Self::request(stdin, receiver, &mut next_id, "authenticate", json!({"methodId": method}), cancelled, deadline) {
                progress(callback,"progress","ACP authenticate 未通过；继续用该 agent 的既有登录建会话",json!({"authMethod":method,"detail":error.message}));
            }
        }
        let session = Self::request(stdin, receiver, &mut next_id, "session/new", json!({
            "cwd": std::env::temp_dir().to_string_lossy(), "mcpServers": mcp,
        }), cancelled, deadline).map_err(|error| {
            let lowered = error.message.to_lowercase();
            if lowered.contains("auth") || lowered.contains("login") || lowered.contains("permission") {
                ToolError::new("acp_auth_required", format!("ACP agent session requires login: {}", error.message))
            } else { error }
        })?;
        let session_id = session["sessionId"].as_str().ok_or_else(|| ToolError::new("acp_failed", "ACP agent returned no sessionId."))?.to_owned();
        progress(callback,"plan","ACP 会话已建立",json!({"transport":"acp-stdio"}));
        // R3 门控：受限会话必须真的切到受限档并等到 set_mode 应答（Self::request 内部
        // 递增并按该 id 匹配）；失败（error 应答 / 超时 / 连接断）即整体失败且不发送
        // prompt——宣称受限就要真的受限。full-access 会话跳过 set_mode。
        let restricted_mode = session["modes"]["availableModes"].as_array().and_then(|modes|
            modes.iter().find(|mode| {
                let id = mode.get("id").and_then(Value::as_str).unwrap_or_default();
                matches!(id, "plan" | "read-only" | "restricted")
            }).and_then(|mode| mode.get("id").and_then(Value::as_str)).map(str::to_owned));
        if self.restricted {
            let mode_id = restricted_mode.ok_or_else(|| ToolError::new("acp_mode_unsupported",
                "The ACP agent does not advertise a supported restricted mode."))?;
            if session["modes"]["currentModeId"].as_str() != Some(mode_id.as_str()) {
                Self::request(stdin, receiver, &mut next_id, "session/set_mode",
                    json!({"sessionId":session_id,"modeId":mode_id}), cancelled, deadline)?;
            }
            progress(callback,"plan","ACP 已启用受限提案模式",json!({"modeId":mode_id}));
        }
        Ok((initialized, session_id, next_id))
    }

    #[allow(clippy::too_many_arguments)]
    fn prompt(stdin: &mut impl std::io::Write, receiver: &std::sync::mpsc::Receiver<String>,
        session_id: &str, next_id: &mut u64, prompt: Vec<Value>, cancelled: &AtomicBool, deadline: Instant,
        callback: &AgentProgressCallback,
    ) -> Result<String, ToolError> {
        if cancelled.load(Ordering::Relaxed) {
            return Err(ToolError::new("acp_cancelled", "ACP execution was cancelled."));
        }
        if Instant::now() >= deadline {
            return Err(ToolError::new("acp_timeout", "ACP execution timed out before sending the prompt."));
        }
        *next_id += 1;
        let prompt_id = *next_id;
        Self::send(stdin, &json!({"jsonrpc":"2.0","id":prompt_id,"method":"session/prompt",
            "params":{"sessionId":session_id,"prompt":prompt}}))?;
        progress(callback,"progress","ACP prompt 已发送，等待流式更新",json!({"stage":"prompt-sent"}));
        let mut message_text = String::new();
        let mut update_counts = std::collections::HashMap::<String,u64>::new();
        loop {
            if cancelled.load(Ordering::Relaxed) {
                let _ = Self::send(stdin, &json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session_id}}));
                return Err(ToolError::new("acp_cancelled", "ACP execution was cancelled."));
            }
            if Instant::now() >= deadline { return Err(ToolError::new("acp_timeout", "ACP execution timed out.")); }
            let line = match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => line,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err(ToolError::new("acp_failed", "ACP agent closed its output.")),
            };
            let message: Value = match serde_json::from_str(&line) { Ok(value) => value, Err(_) => continue };
            if message["method"] == json!("session/update") {
                if message["params"]["sessionId"].as_str() != Some(session_id) { continue; }
                let update = &message["params"]["update"];
                let update_kind = update["sessionUpdate"].as_str().unwrap_or("unknown").to_owned();
                let count = update_counts.entry(update_kind.clone()).or_default();
                *count += 1;
                if *count == 1 || *count % 10 == 0 {
                    match update_kind.as_str() {
                        "agent_message_chunk" => progress(callback,"executor-output","ACP 已返回 Agent 消息片段",json!({"channel":"agent-message","chunkCount":*count})),
                        "agent_thought_chunk" => progress(callback,"progress","ACP 已返回推理进度片段",json!({"channel":"agent-thought","chunkCount":*count})),
                        "plan" => progress(callback,"plan","ACP 已更新执行计划",json!({"update":"plan","updateCount":*count})),
                        "tool_call" | "tool_call_update" => progress(callback,"executor-output","ACP 工具调用状态已更新",json!({"update":"tool-call","updateCount":*count})),
                        _ => {}
                    }
                }
                if update["sessionUpdate"] == json!("agent_message_chunk") {
                    if let Some(text) = update["content"]["text"].as_str() {
                        for character in text.chars() {
                            if message_text.len() + character.len_utf8() > MAX_OUTPUT_BYTES { break; }
                            message_text.push(character);
                        }
                    }
                }
            } else if message["method"] == json!("session/request_permission") {
                let request_id = message["id"].as_u64().unwrap_or(0);
                let reject = message["params"]["options"].as_array().and_then(|options|
                    options.iter().find(|option| option["kind"].as_str().is_some_and(|kind| kind.starts_with("reject")))
                        .and_then(|option| option["optionId"].as_str().map(str::to_owned)));
                let outcome = reject.map(|option_id| json!({"outcome":"selected","optionId":option_id}))
                    .unwrap_or_else(|| json!({"outcome":"cancelled"}));
                Self::send(stdin, &json!({"jsonrpc":"2.0","id":request_id,"result":{"outcome":outcome}}))?;
            } else if message["method"].as_str().is_some_and(|method| method.starts_with("fs/") || method.starts_with("terminal/") || method == "elicitation/create") {
                let request_id = message["id"].as_u64().unwrap_or(0);
                Self::send(stdin, &json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"Client capabilities not enabled; use the creator MCP tools."}}))?;
            } else if message["id"].as_u64() == Some(prompt_id) && message.get("error").is_some() {
                // 上游错误（如路由 402 余额不足）必须立即透传，不能干等超时。
                let detail = error_tail_text(message["error"]["message"].as_str().unwrap_or("unknown ACP error"));
                return Err(classify_acp_prompt_error(&detail));
            } else if message["id"].as_u64() == Some(prompt_id) && message.get("result").is_some() {
                let stop_reason = message["result"]["stopReason"].as_str().unwrap_or_default().to_owned();
                return match stop_reason.as_str() {
                    "end_turn" => Ok(message_text),
                    "cancelled" => Err(ToolError::new("acp_cancelled", "ACP turn was cancelled by the agent.")),
                    other => Err(ToolError::new("acp_failed", format!("ACP turn stopped early ({other}); no proposal produced."))),
                };
            }
        }
    }
}

impl CreatorAgentExecutor for AcpAgentExecutor {
    fn execute(&self, request: AgentExecutionRequest, cancelled: &AtomicBool) -> Result<AgentExecutionSuccess, ToolError> {
        self.execute_with_progress(request,cancelled,&noop_progress_callback())
    }
    fn execute_with_progress(&self, request: AgentExecutionRequest, cancelled: &AtomicBool, callback: &AgentProgressCallback) -> Result<AgentExecutionSuccess, ToolError> {
        let proposal = self.run_acp_with_progress(&request, cancelled, callback)?;
        progress(callback,"progress","ACP 提案已完成，等待 Host Preview",json!({"stage":"host-preview"}));
        finish_with_host_preview(request, proposal)
    }
}

/// 失败细节透传：取 stderr 末尾一小段（先按行截断到 240 字符），让
/// codex_failed / preview_required 的错误码能说明真实原因（如用量限额）。
fn bounded_error_tail(bytes: &[u8]) -> String {
    error_tail_text(&String::from_utf8_lossy(bytes))
}

fn error_tail_text(text: &str) -> String {
    let tail = text.lines().rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("").trim();
    let mut bounded: String = tail.chars().take(240).collect();
    bounded.push('…');
    bounded
}

/// ACP prompt 的上游错误分类（纯函数，可单测）：计费/配额类单独成码，
/// 提示换通道或充值；其余按 acp_failed 带细节。
fn classify_acp_prompt_error(detail: &str) -> ToolError {
    let lowered = detail.to_lowercase();
    if lowered.contains("insufficient_balance") || lowered.contains("billing") || lowered.contains("402") || lowered.contains("quota") {
        return ToolError::new("acp_quota_exhausted", format!("ACP agent upstream quota/billing failed: {detail}"));
    }
    if lowered.contains("unauthorized") || lowered.contains("api key") || lowered.contains("login") {
        return ToolError::new("acp_auth_required", format!("ACP agent upstream authentication failed: {detail}"));
    }
    ToolError::new("acp_failed", format!("ACP prompt failed: {detail}"))
}

fn read_bounded<R: Read>(mut reader: R) -> Vec<u8> {    let mut bytes = Vec::new();
    let mut buffer = [0u8; 2048];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if bytes.len() < MAX_OUTPUT_BYTES {
                    let remaining = MAX_OUTPUT_BYTES - bytes.len();
                    bytes.extend_from_slice(&buffer[..count.min(remaining)]);
                }
            }
            Err(_) => break,
        }
    }
    bytes
}

fn read_codex_output<R: BufRead>(mut reader: R, callback: &AgentProgressCallback) -> Vec<u8> {
    let mut output = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n',&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if output.len() < MAX_OUTPUT_BYTES {
                    let remaining = MAX_OUTPUT_BYTES-output.len();
                    output.extend_from_slice(&line[..line.len().min(remaining)]);
                }
                if line.len() > 64 * 1024 { continue; }
                let Ok(value) = serde_json::from_slice::<Value>(&line) else { continue };
                let event_type = value["type"].as_str().unwrap_or_default();
                let item_type = value["item"]["type"].as_str().unwrap_or_default();
                match (event_type,item_type) {
                    ("turn.started",_) => progress(callback,"progress","Codex turn 已开始",json!({"eventType":"turn-started"})),
                    ("item.started","reasoning") => progress(callback,"progress","Codex 正在分析任务",json!({"itemType":"reasoning","state":"started"})),
                    ("item.completed","reasoning") => progress(callback,"progress","Codex 分析阶段已更新",json!({"itemType":"reasoning","state":"completed"})),
                    ("item.started","mcp_tool_call") | ("item.completed","mcp_tool_call") | ("item.started","command_execution") | ("item.completed","command_execution") => {
                        let state = if event_type == "item.started" { "started" } else { "completed" };
                        let kind = if item_type == "mcp_tool_call" { "mcp-tool-call" } else { "command-execution" };
                        progress(callback,"executor-output","Codex 工具调用状态已更新",json!({"itemType":kind,"state":state}));
                    }
                    ("agent_message",_) | ("item.completed","agent_message") | ("response.completed",_) => {
                        progress(callback,"executor-output","Codex 已返回最终 Agent 消息",json!({"channel":"agent-message"}));
                    }
                    ("turn.completed",_) => progress(callback,"progress","Codex turn 已结束",json!({"eventType":"turn-completed"})),
                    _ => {}
                }
            }
            Err(_) => break,
        }
    }
    output
}

/// 收集全部 agent 文本候选（按出现顺序）。模型可能先叙述后给提案，或反之；
/// 解析方从后往前逐个尝试，任何一条能解析成提案即成功。
fn extract_candidate_texts(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut candidates: Vec<String> = Vec::new();
    for line in text.lines().filter(|line| line.trim_start().starts_with('{')) {
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        let kind = value["type"].as_str().unwrap_or_default();
        let extracted = if kind == "agent_message" {
            value["text"].as_str().or_else(|| value["message"]["text"].as_str()).or_else(|| value["item"]["text"].as_str()).map(str::to_owned)
        } else if kind == "item.completed" && value["item"]["type"].as_str() == Some("agent_message") {
            value["item"]["text"].as_str().map(str::to_owned)
        } else if kind == "response.completed" {
            value["output_text"].as_str().map(str::to_owned).or_else(|| {
                value["output"].as_array().and_then(|output| output.iter().find_map(|item| item["content"].as_array()
                    .and_then(|content| content.iter().find_map(|entry| entry["text"].as_str())))).map(str::to_owned)
            })
        } else { None };
        if let Some(text) = extracted.filter(|text| !text.trim().is_empty()) {
            candidates.push(text);
        }
    }
    candidates
}

#[cfg(test)]
fn extract_agent_text(bytes: &[u8]) -> Result<String, ToolError> {
    let candidates = extract_candidate_texts(bytes);
    let last = candidates.last().ok_or_else(|| ToolError::new("codex_output_invalid", "Codex returned no usable agent text."))?;
    Ok(last.clone())
}

fn parse_proposal(text: &str) -> Result<Value, ToolError> {
    // ACP concatenates prose and final answer chunks. Parse whole JSON objects
    // individually, skipping over nested objects and unrelated tool receipts.
    let mut remaining = text;
    let mut proposal = None;
    while let Some(start) = remaining.find('{') {
        let candidate = &remaining[start..];
        let mut stream = serde_json::Deserializer::from_str(candidate).into_iter::<Value>();
        let Some(Ok(value)) = stream.next() else {
            remaining = &candidate[1..];
            continue;
        };
        remaining = &candidate[stream.byte_offset()..];
        if !is_proposal(&value) { continue; }
        if proposal.is_some() {
            return Err(ToolError::new("codex_output_invalid", "Agent returned multiple proposals; one is required."));
        }
        proposal = Some(value);
    }
    proposal.ok_or_else(|| ToolError::new("codex_output_invalid", "Agent response needs a bounded summary and one proposal."))
}

fn is_proposal(value: &Value) -> bool {
    let Some(object) = value.as_object().filter(|object| object.len() == 2) else { return false; };
    let summary_ok = object.get("summary").and_then(Value::as_str)
        .is_some_and(|summary| !summary.trim().is_empty() && summary.chars().count() <= MAX_SUMMARY_CHARS);
    let has_payload = object.get("operations").is_some_and(Value::is_array)
        || object.get("game").is_some_and(Value::is_object)
        || object.get("document").is_some_and(Value::is_object);
    summary_ok && has_payload
}

#[cfg(test)]
pub mod tests {
    #[test]
    fn built_in_agents_preserve_explicit_configurations() {
        let home = std::env::temp_dir().join(format!("acp-catalog-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("acp-agents.json"), r#"{"agents":[{"id":"codex","name":"Custom Codex","command":"custom-codex","args":["--acp"]},{"id":"custom","command":"custom-agent"}]}"#).unwrap();
        let entries = super::acp_registry(&home);
        for id in ["codex", "claude-code", "zcode", "kimi-code", "deepseek-harness", "custom"] {
            assert_eq!(entries.iter().filter(|entry| entry.id == id).count(), 1, "{id}");
        }
        let codex = entries.iter().find(|entry| entry.id == "codex").unwrap();
        assert_eq!(codex.program, std::ffi::OsString::from("custom-codex"));
        assert_eq!(codex.args, vec![std::ffi::OsString::from("--acp")]);
        std::fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn host_preview_envelope_is_bound_to_revision() {
        let response = serde_json::json!({"ok":true,"data":{"previewId":"preview-1","baseRevision":4}});
        assert_eq!(super::validated_host_preview(response.clone(), Some(4)).unwrap()["previewId"], "preview-1");
        assert!(super::validated_host_preview(response.clone(), Some(5)).is_err());
        assert!(super::validated_host_preview(response, None).is_err());
        assert!(super::validated_host_preview(serde_json::json!({"ok":true}), Some(4)).is_err());
    }
    use super::*;
    use std::sync::Mutex;

    /// 最小 ACP agent 桩（POSIX sh）：initialize/session/new 应答，prompt 后发一条
    /// agent_message_chunk 再以 end_turn 结束。用于验证 transport 驱动而不依赖真 Agent。
    fn write_stub_agent(home: &Path, proposal_text: &str) -> PathBuf {
        let script = home.join("stub-acp-agent.sh");
        std::fs::write(&script, format!(r#"#!/bin/sh
PROPOSAL='{proposal}'
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"protocolVersion":1,"agentCapabilities":{{}},"authMethods":[]}}}}\n' "$id"
      ;;
    *'"method":"session/new"'*)
      id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"sess_stub","modes":{{"currentModeId":"plan","availableModes":[{{"id":"plan"}}]}}}}}}\n' "$id"
      ;;
    *'"method":"session/prompt"'*)
      id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
      RESPONSE="$PROPOSAL"
      if [ "$PROPOSAL" = "repair-fixture" ]; then
        RESPONSE="I inspected the scene but did not provide a proposal."
        case "$line" in
          *'Your previous reply'*) RESPONSE='{{"summary":"Corrected","operations":[{{"op":"skin.select","skinId":"miami-vice"}}]}}' ;;
        esac
      fi
      WIRE=$(printf '%s' "$RESPONSE" | sed 's/"/\\"/g')
      printf '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"sess_stub","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"%s"}}}}}}}}\n' "$WIRE"
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"stopReason":"end_turn"}}}}\n' "$id"
      ;;
  esac
done
"#, proposal = proposal_text)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        script
    }

    fn acp_request(home: &Path) -> AgentExecutionRequest {
        AgentExecutionRequest { data_home: home.to_path_buf(), goal: "Small goal".into(), human_request: "Review only".into(),
            artifact: json!({"projectId":"project-1","expectedRevision":3}), plan_revision: 1, timeout: Duration::from_secs(15), include_viewport: false }
    }

    #[test]
    fn acp_viewport_requires_image_capability() {
        let mut request = acp_request(Path::new("unused"));
        assert_eq!(super::acp_prompt(&request, &json!({})).unwrap().len(), 1);
        request.include_viewport = true;
        assert_eq!(super::acp_prompt(&request, &json!({})).unwrap_err().code, "acp_image_unsupported");
        request.artifact["kind"] = json!("creator-story");
        let capabilities = json!({"agentCapabilities":{"promptCapabilities":{"image":true}}});
        assert_eq!(super::acp_prompt(&request, &capabilities).unwrap_err().code, "creator_capture_unavailable");
    }

    #[test]
    #[cfg(unix)]
    fn capability_probe_completes_line_delimited_session_handshake() {
        let home = std::env::temp_dir().join(format!("acp-probe-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&home).unwrap();
        let stub = write_stub_agent(&home, "{}");
        let modes = probe_acp_modes(&stub.into_os_string(), &[]).unwrap();
        assert!(modes.iter().any(|mode| mode["restricted"] == true));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn acp_transport_drives_canned_agent_to_a_proposal() {
        let home = std::env::temp_dir().join(format!("acp-stub-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&home).unwrap();
        let stub = write_stub_agent(&home, r#"{"summary":"Stub proposal","operations":[{"op":"skin.select","skinId":"miami-vice"}]}"#);
        let executor = AcpAgentExecutor { program: stub.into_os_string(), args: Vec::new(), restricted: true, creator_binary: AcpAgentExecutor::default_creator_binary() };
        let proposal = executor.run_acp_with_progress(&acp_request(&home), &AtomicBool::new(false), &noop_progress_callback()).unwrap();
        assert_eq!(proposal["summary"], "Stub proposal");
        assert_eq!(proposal["operations"].as_array().unwrap().len(), 1);
    }

    #[test]
    #[cfg(unix)]
    fn acp_transport_repairs_output_in_the_same_session() {
        let home = std::env::temp_dir().join(format!("acp-repair-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&home).unwrap();
        let stub = write_stub_agent(&home, "repair-fixture");
        let executor = AcpAgentExecutor { program: stub.into_os_string(), args: Vec::new(), restricted: true, creator_binary: AcpAgentExecutor::default_creator_binary() };
        let result = executor.run_acp_with_progress(&acp_request(&home), &AtomicBool::new(false), &noop_progress_callback());
        std::fs::remove_dir_all(home).unwrap();
        assert_eq!(result.unwrap()["summary"], "Corrected");
    }

    #[test]
    #[cfg(unix)]
    fn acp_transport_reports_non_json_output_honestly() {
        let home = std::env::temp_dir().join(format!("acp-stub-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&home).unwrap();
        let stub = write_stub_agent(&home, "plain prose without a proposal");
        let executor = AcpAgentExecutor { program: stub.into_os_string(), args: Vec::new(), restricted: true, creator_binary: AcpAgentExecutor::default_creator_binary() };
        let error = executor.run_acp_with_progress(&acp_request(&home), &AtomicBool::new(false), &noop_progress_callback()).unwrap_err();
        assert_eq!(error.code, "acp_output_invalid");
    }

    #[test]
    #[cfg(unix)]
    fn acp_stdio_streams_bounded_typed_progress_without_agent_text() {
        let home = std::env::temp_dir().join(format!("acp-progress-{}-{}",std::process::id(),line!()));
        std::fs::create_dir_all(&home).unwrap();
        let stub = write_stub_agent(&home,r#"{"summary":"private proposal /tmp/secret","operations":[{"op":"skin.select","skinId":"miami-vice"}]}"#);
        let executor = AcpAgentExecutor { program:stub.into_os_string(),args:Vec::new(),restricted:true,creator_binary:AcpAgentExecutor::default_creator_binary() };
        let updates = Arc::new(Mutex::new(Vec::new()));
        let captured = updates.clone();
        let callback: AgentProgressCallback = Arc::new(move |update| captured.lock().unwrap().push(update));
        let proposal = executor.run_acp_with_progress(&acp_request(&home),&AtomicBool::new(false),&callback).unwrap();
        assert_eq!(proposal["summary"],"private proposal /tmp/secret");
        let updates = updates.lock().unwrap();
        assert!(updates.iter().any(|update| update.kind == "plan"));
        assert!(updates.iter().any(|update| update.kind == "progress"));
        assert!(updates.iter().any(|update| update.kind == "executor-output"));
        let serialized = serde_json::to_string(&updates.iter().map(|update| json!({"kind":update.kind,"summary":update.summary,"data":update.data})).collect::<Vec<_>>()).unwrap();
        assert!(!serialized.contains("private proposal"));
        assert!(!serialized.contains("/tmp/secret"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn codex_jsonl_progress_is_typed_and_excludes_message_content() {
        let updates = Arc::new(Mutex::new(Vec::new()));
        let captured = updates.clone();
        let callback: AgentProgressCallback = Arc::new(move |update| captured.lock().unwrap().push(update));
        let input = concat!(
            "{\"type\":\"turn.started\"}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"mcp_tool_call\",\"arguments\":\"/private/path\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"summary\\\":\\\"private\\\",\\\"operations\\\":[]}\"}}\n"
        );
        let output = read_codex_output(std::io::BufReader::new(input.as_bytes()),&callback);
        assert!(extract_agent_text(&output).unwrap().contains("private"));
        let serialized = serde_json::to_string(&updates.lock().unwrap().iter().map(|update| json!({"kind":update.kind,"summary":update.summary,"data":update.data})).collect::<Vec<_>>()).unwrap();
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("/private/path"));
        assert!(serialized.contains("mcp-tool-call"));
    }

    #[test]
    fn prompt_and_config_never_expose_paths_or_write_capabilities() {
        let home = std::env::temp_dir().join("private-creator-home");
        let request = AgentExecutionRequest { data_home: home.clone(), goal: "Small goal".into(), human_request: "Review only".into(),
            artifact: json!({"projectId":"project-1","expectedRevision":3}), plan_revision: 1, timeout: Duration::from_secs(1), include_viewport: false };
        let prompt = execution_prompt(&request);
        assert!(!prompt.contains(home.to_string_lossy().as_ref()));
        assert!(prompt.contains("Do not commit, publish, install, write files"));
        let config = mcp_config_args(&std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("agent-vitals")), &home).join(&OsString::from(" "));
        let config = config.to_string_lossy();
        assert!(!config.contains("allow-local-writes"));
        assert!(config.contains("data-mcp"));
    }

    #[test]
    fn acp_prompt_errors_classify_billing_and_auth_upstream() {
        let billing = super::classify_acp_prompt_error(r#"Internal error: API Error: 402 {"error":{"message":"billing checked pre-consume quota: 余额不足","type":"insufficient_balance"}}"#);
        assert_eq!(billing.code, "acp_quota_exhausted");
        let auth = super::classify_acp_prompt_error("Internal error: API Error: 401 invalid api key");
        assert_eq!(auth.code, "acp_auth_required");
        let plain = super::classify_acp_prompt_error("upstream blew up");
        assert_eq!(plain.code, "acp_failed");
        assert!(plain.message.contains("upstream blew up"));
    }

    #[test]
    fn codex_failure_classification_types_quota_and_auth_separately() {
        let (quota_code, quota_message) = super::classify_codex_failure(
            br#"{"type":"turn.failed","error":{"message":"You've hit your usage limit. Upgrade or try again at Nov 23rd, 2026 1:07 AM."}}"#,
            b"",
        );
        assert_eq!(quota_code, "codex_quota_exhausted");
        assert!(quota_message.contains("Nov 23rd, 2026"), "recovery time should surface: {quota_message}");
        let (auth_code, _) = super::classify_codex_failure(b"", b"error: Not logged in");
        assert_eq!(auth_code, "codex_auth_expired");
        let (plain_code, plain_message) = super::classify_codex_failure(b"", b"boom\nsegfault");
        assert_eq!(plain_code, "codex_failed");
        assert!(plain_message.contains("segfault"), "stderr tail should surface: {plain_message}");
    }

    #[test]
    fn codex_jsonl_requires_nonempty_json_proposal() {
        let proposal = json!({"summary":"Preview proposed","operations":[{"op":"skin.select","skinId":"miami-vice"}]});
        let event = json!({"type":"item.completed","item":{"type":"agent_message","text":proposal.to_string()}});
        let text = extract_agent_text(event.to_string().as_bytes()).unwrap();
        let surrounding = format!("Preview tool returned {{\"previewId\":\"receipt\"}}.\n```json\n{text}\n```");
        let proposal = parse_proposal(&surrounding).unwrap();
        assert!(parse_proposal(&format!("{text}\n{text}")).is_err());
        assert_eq!(proposal["summary"], "Preview proposed");
        assert!(parse_proposal("not json").is_err());
        assert!(extract_agent_text(b"{}").is_err());
    }

    #[test]
    fn acp_modes_probe_reads_plan_and_full_access_tiers() {
        let modes = super::acp_modes_from_session(&json!({"modes":{"currentModeId":"plan",
            "availableModes":[{"id":"plan","name":"Plan Mode"},{"id":"bypassPermissions","name":"Bypass"}]}}));
        assert_eq!(modes.len(), 2);
        assert_eq!(modes[0]["id"], "plan");
        assert_eq!(modes[0]["restricted"], true);
        assert_eq!(modes[0]["current"], true);
        assert_eq!(modes[1]["id"], "bypassPermissions");
        assert_eq!(modes[1]["restricted"], false);
        assert_eq!(modes[1]["current"], false);
        let empty = super::acp_modes_from_session(&json!({}));
        assert!(empty.is_empty());
    }

    /// R3 执行模式门控：codex exec 没有审批处理者，restricted 请求必须被如实拒绝
    /// （executor_mode_unsupported），full-access 才放行。
    #[test]
    fn executor_mode_gate_blocks_codex_restricted() {
        let home = std::env::temp_dir().join(format!("executor-mode-gate-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&home).unwrap();
        let payload = json!({"executor":"codex","mode":"restricted"});
        let error = match super::select_executor(&payload, &home, None, "restricted") {
            Err(error) => error,
            Ok(_) => panic!("codex restricted request must be rejected by the mode gate"),
        };
        assert_eq!(error.code, "executor_mode_unsupported");
        assert!(error.message.contains("受限模式"), "rejection should explain the gate: {}", error.message);
        // 门控只挡受限档；显式 full-access 仍可走 codex。
        let full_access = super::select_executor(&payload, &home, None, "full-access").unwrap();
        let _ = full_access;
        let _ = std::fs::remove_dir_all(home);
    }

    pub struct FakeExecutor {
        pub response: Mutex<Option<Result<AgentExecutionSuccess, ToolError>>>,
    }
    impl FakeExecutor {
        pub fn success() -> Self {
            Self { response: Mutex::new(Some(Ok(AgentExecutionSuccess { summary: "Fake preview".into(), preview: json!({"previewId":"preview-fake","baseRevision":3,"diff":[]}) }))) }
        }
        pub fn failure(code: &'static str) -> Self {
            Self { response: Mutex::new(Some(Err(ToolError::new(code, "Fake executor failure.")))) }
        }
    }
    impl CreatorAgentExecutor for FakeExecutor {
        fn execute(&self, request: AgentExecutionRequest, cancelled: &AtomicBool) -> Result<AgentExecutionSuccess, ToolError> {
            assert_eq!(request.artifact["expectedRevision"], 3);
            if cancelled.load(Ordering::Relaxed) { return Err(ToolError::new("codex_cancelled", "Cancelled by test.")); }
            self.response.lock().unwrap().take().unwrap()
        }
        fn execute_with_progress(&self, request: AgentExecutionRequest, cancelled: &AtomicBool, callback: &AgentProgressCallback) -> Result<AgentExecutionSuccess, ToolError> {
            progress(callback,"progress","Fake executor 已报告进度",json!({"code":"other","percent":50}));
            self.execute(request,cancelled)
        }
    }
}
