use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
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
}

#[derive(Clone, Debug)]
pub struct AgentExecutionSuccess {
    pub summary: String,
    pub preview: Value,
}

pub trait CreatorAgentExecutor: Send + Sync {
    fn execute(&self, request: AgentExecutionRequest, cancelled: &AtomicBool) -> Result<AgentExecutionSuccess, ToolError>;
}

pub fn execution_prompt(request: &AgentExecutionRequest) -> String {
    format!(
        "You are assisting with one Creator Studio task. Analyze only and propose scene operations.\n\
         Do not commit, publish, install, write files, or claim that changes were saved.\n\
         Use only these Creator tools: creator_project_read, creator_scene_preview, creator_game_preview, creator_scene_describe, creator_scene_validate, creator_city_view, creator_city_view_status, creator_layout_list, creator_project_list, creator_capabilities_list, creator_operation_status. Do not call any other tool.\n\
         The host will independently create and validate any Preview.\n\
         Return exactly one JSON object with this shape: {{\"summary\":\"bounded outcome\",\"operations\":[...]}}.\n\
         Use an empty operations array only when no change is justified; a Preview is required for a successful task.\n\
         Goal: {}\nHuman request: {}\nArtifact: creator-project {} at expected revision {}.\nPlan revision: {}.",
        request.goal, request.human_request,
        request.artifact["projectId"].as_str().unwrap_or("unknown"), request.artifact["expectedRevision"].as_u64().unwrap_or(0), request.plan_revision,
    )
}

fn mcp_config_args(data_home: &Path) -> Vec<OsString> {
    let executable = std::env::var_os("AGENT_VITALS_BIN").map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-vitals"))).to_string_lossy().into_owned();
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
}

impl Default for CodexCliAgentExecutor {
    fn default() -> Self { Self::new() }
}

impl CodexCliAgentExecutor {
    pub fn new() -> Self { Self { program: OsString::from("codex") } }

    fn run_codex(&self, request: &AgentExecutionRequest, cancelled: &AtomicBool) -> Result<Value, ToolError> {
        let mut command = Command::new(&self.program);
        command.arg("exec").arg("--sandbox").arg("read-only").arg("--ephemeral").arg("--json")
            .args(mcp_config_args(&request.data_home))
            .arg(execution_prompt(request))
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.env_clear();
        for key in ["PATH", "HOME", "USER", "TMPDIR", "CODEX_HOME"] {
            if let Some(value) = std::env::var_os(key) { command.env(key, value); }
        }
        command.env("AGENT_VITALS_HOME", &request.data_home);
        let mut child = command.spawn().map_err(|_| ToolError::new("codex_unavailable", "Codex CLI is unavailable."))?;
        let stdout = child.stdout.take().ok_or_else(|| ToolError::new("codex_output_invalid", "Codex stdout is unavailable."))?;
        let stderr = child.stderr.take().ok_or_else(|| ToolError::new("codex_output_invalid", "Codex stderr is unavailable."))?;
        let stdout_thread = std::thread::spawn(move || read_bounded(stdout));
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
        let _stderr = stderr_thread.join().unwrap_or_default();
        if !status.success() { return Err(ToolError::new("codex_failed", "Codex returned a failure status.")); }
        let text = extract_agent_text(&stdout)?;
        parse_proposal(&text)
    }
}

impl CreatorAgentExecutor for CodexCliAgentExecutor {
    fn execute(&self, request: AgentExecutionRequest, cancelled: &AtomicBool) -> Result<AgentExecutionSuccess, ToolError> {
        let proposal = self.run_codex(&request, cancelled)?;
        finish_with_host_preview(request, proposal)
    }
}

/// 提案 → 宿主独立校验的 Preview（push 执行器共用收尾）。Agent 永远不落库；
/// preview 由宿主面（creator_scene_preview）生成并绑定 baseRevision。
fn finish_with_host_preview(request: AgentExecutionRequest, proposal: Value) -> Result<AgentExecutionSuccess, ToolError> {
    if proposal["operations"].as_array().map_or(true, |operations| operations.is_empty()) {
        return Err(ToolError::new("preview_required", "Agent did not produce previewable operations."));
    }
    let preview = super::creator_studio::run("creator_scene_preview", &json!({
        "projectId": request.artifact["projectId"], "baseRevision": request.artifact["expectedRevision"],
        "operations": proposal["operations"],
    }), &request.data_home, false)?;
    if preview["previewId"].as_str().map_or(true, |id| id.is_empty())
        || preview["baseRevision"].as_u64() != request.artifact["expectedRevision"].as_u64() {
        return Err(ToolError::new("preview_required", "Host did not return a valid revision-bound Preview."));
    }
    Ok(AgentExecutionSuccess { summary: proposal["summary"].as_str().unwrap_or("Agent proposal received.").chars().take(MAX_SUMMARY_CHARS).collect(), preview })
}

/// 执行器选择：push 模式的 transport 通用化入口。默认 Codex CLI（既有路径不变）；
/// "acp" 走 Agent Client Protocol（JSON-RPC over stdio），任何 ACP agent 零适配接入。
pub fn select_executor(payload: &Value) -> Result<Box<dyn CreatorAgentExecutor>, ToolError> {
    match payload.get("executor").and_then(Value::as_str) {
        None | Some("codex") => Ok(Box::new(CodexCliAgentExecutor::new())),
        Some("acp") => Ok(Box::new(AcpAgentExecutor::from_env())),
        Some(other) => Err(ToolError::new("invalid_argument", format!("Unknown executor `{other}`; supported: codex, acp."))),
    }
}

const ACP_PROTOCOL_VERSION: u64 = 1;
const ACP_LINE_BYTES: usize = 4 * 1024 * 1024;

/// Agent Client Protocol (v1, JSON-RPC over stdio, newline-delimited) transport。
/// 宿主是 ACP client：spawn 任意 ACP agent 子进程，注入 creator MCP（data-mcp
/// serve），发送 analyze-only 提示，收集最终文本提案。复用与 Codex 路径相同的
/// 提案解析与宿主 Preview 收尾；Agent 的工具面同样受 MCP 只读策略约束。
pub struct AcpAgentExecutor { program: OsString, args: Vec<OsString> }

impl AcpAgentExecutor {
    /// 命令来源：AGENT_VITALS_ACP_BIN（默认 `claude-code-acp`）+ AGENT_VITALS_ACP_ARGS
    /// （空白切分）。凭据由 Agent 自管（宿主不经手任何 token）。
    pub fn from_env() -> Self {
        let program = std::env::var_os("AGENT_VITALS_ACP_BIN").unwrap_or_else(|| OsString::from("claude-code-acp"));
        let args = std::env::var("AGENT_VITALS_ACP_ARGS").unwrap_or_default().split_whitespace().map(OsString::from).collect();
        Self { program, args }
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
    fn run_acp(&self, request: &AgentExecutionRequest, cancelled: &AtomicBool) -> Result<Value, ToolError> {
        let mut command = Command::new(&self.program);
        command.args(&self.args)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.env_clear();
        for key in ["PATH", "HOME", "USER", "TMPDIR"] {
            if let Some(value) = std::env::var_os(key) { command.env(key, value); }
        }
        command.env("AGENT_VITALS_HOME", &request.data_home);
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
        let deadline = Instant::now() + request.timeout;
        let result = self.drive(&mut stdin, &receiver, request, cancelled, deadline);
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
            let message: Value = serde_json::from_str(&line).map_err(|_| ToolError::new("acp_failed", "ACP agent sent a malformed message."))?;
            if message["id"].as_u64() != Some(id) { continue; }
            if let Some(error) = message.get("error") {
                return Err(ToolError::new("acp_failed", format!("{method} failed: {}", error["message"].as_str().unwrap_or("unknown"))));
            }
            return Ok(message["result"].clone());
        }
    }

    fn drive(&self, stdin: &mut impl std::io::Write, receiver: &std::sync::mpsc::Receiver<String>,
        request: &AgentExecutionRequest, cancelled: &AtomicBool, deadline: Instant) -> Result<Value, ToolError> {
        let mut next_id = 0u64;
        let initialized = Self::request(stdin, receiver, &mut next_id, "initialize", json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
            "clientInfo": {"name": "oh-agent-creator", "title": "Oh Agent Creator", "version": "1.0.0"},
        }), cancelled, deadline)?;
        let auth_methods = initialized["authMethods"].as_array().cloned().unwrap_or_default();
        if let Some(method) = auth_methods.first().and_then(|entry| entry["id"].as_str().map(str::to_owned)) {
            Self::request(stdin, receiver, &mut next_id, "authenticate", json!({"methodId": method}), cancelled, deadline)
                .map_err(|error| ToolError::new("acp_auth_required", format!("ACP agent requires authentication: {}", error.message)))?;
        }
        let executable = std::env::var_os("AGENT_VITALS_BIN").map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-vitals"))).to_string_lossy().into_owned();
        let session = Self::request(stdin, receiver, &mut next_id, "session/new", json!({
            "cwd": request.data_home.to_string_lossy(),
            "mcpServers": [{"name": "creator", "command": executable, "args": ["data-mcp", "serve"],
                "env": [{"name": "AGENT_VITALS_HOME", "value": request.data_home.to_string_lossy()}]}],
        }), cancelled, deadline)?;
        let session_id = session["sessionId"].as_str().ok_or_else(|| ToolError::new("acp_failed", "ACP agent returned no sessionId."))?.to_owned();
        next_id += 1;
        let prompt_id = next_id;
        Self::send(stdin, &json!({"jsonrpc":"2.0","id":prompt_id,"method":"session/prompt",
            "params":{"sessionId":session_id,"prompt":[{"type":"text","text":execution_prompt(request)}]}}))?;
        let mut message_text = String::new();
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
                let update = &message["params"]["update"];
                if update["sessionUpdate"] == json!("agent_message_chunk") {
                    if let Some(text) = update["content"]["text"].as_str() { message_text.push_str(text); }
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
            } else if message["id"].as_u64() == Some(prompt_id) && message.get("result").is_some() {
                let stop_reason = message["result"]["stopReason"].as_str().unwrap_or_default().to_owned();
                return match stop_reason.as_str() {
                    "end_turn" => parse_proposal(&message_text).map_err(|error| ToolError::new("acp_output_invalid", error.message)),
                    "cancelled" => Err(ToolError::new("acp_cancelled", "ACP turn was cancelled by the agent.")),
                    other => Err(ToolError::new("acp_failed", format!("ACP turn stopped early ({other}); no proposal produced."))),
                };
            }
        }
    }
}

impl CreatorAgentExecutor for AcpAgentExecutor {
    fn execute(&self, request: AgentExecutionRequest, cancelled: &AtomicBool) -> Result<AgentExecutionSuccess, ToolError> {
        let proposal = self.run_acp(&request, cancelled)?;
        finish_with_host_preview(request, proposal)
    }
}

fn read_bounded<R: Read>(mut reader: R) -> Vec<u8> {
    let mut bytes = Vec::new();
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

fn extract_agent_text(bytes: &[u8]) -> Result<String, ToolError> {
    let text = String::from_utf8_lossy(bytes);
    let mut candidate = None;
    for line in text.lines().filter(|line| line.trim_start().starts_with('{')) {
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        let kind = value["type"].as_str().unwrap_or_default();
        if kind == "agent_message" {
            candidate = value["text"].as_str().or_else(|| value["message"]["text"].as_str()).or_else(|| value["item"]["text"].as_str()).map(str::to_owned);
        } else if kind == "item.completed" && value["item"]["type"].as_str() == Some("agent_message") {
            candidate = value["item"]["text"].as_str().map(str::to_owned);
        } else if kind == "response.completed" {
            candidate = value["output_text"].as_str().map(str::to_owned).or_else(|| {
                value["output"].as_array().and_then(|output| output.iter().find_map(|item| item["content"].as_array()
                    .and_then(|content| content.iter().find_map(|entry| entry["text"].as_str())))).map(str::to_owned)
            });
        }
    }
    candidate.filter(|text| !text.trim().is_empty()).ok_or_else(|| ToolError::new("codex_output_invalid", "Codex returned no usable agent text."))
}

fn parse_proposal(text: &str) -> Result<Value, ToolError> {
    let value: Value = serde_json::from_str(text).map_err(|_| ToolError::new("codex_output_invalid", "Agent response is not valid JSON."))?;
    let object = value.as_object().filter(|object| object.len() == 2 && object.contains_key("summary") && object.contains_key("operations"))
        .ok_or_else(|| ToolError::new("codex_output_invalid", "Agent response must contain only summary and operations."))?;
    if object["summary"].as_str().map_or(true, |summary| summary.trim().is_empty() || summary.chars().count() > MAX_SUMMARY_CHARS)
        || !object["operations"].is_array() {
        return Err(ToolError::new("codex_output_invalid", "Agent response has invalid summary or operations."));
    }
    Ok(value)
}

#[cfg(test)]
pub mod tests {
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
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"sess_stub"}}}}\n' "$id"
      ;;
    *'"method":"session/prompt"'*)
      id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
      WIRE=$(printf '%s' "$PROPOSAL" | sed 's/"/\\"/g')
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
            artifact: json!({"projectId":"project-1","expectedRevision":3}), plan_revision: 1, timeout: Duration::from_secs(15) }
    }

    #[test]
    #[cfg(unix)]
    fn acp_transport_drives_canned_agent_to_a_proposal() {
        let home = std::env::temp_dir().join(format!("acp-stub-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&home).unwrap();
        let stub = write_stub_agent(&home, r#"{"summary":"Stub proposal","operations":[{"op":"skin.select","skinId":"miami-vice"}]}"#);
        let executor = AcpAgentExecutor { program: stub.into_os_string(), args: Vec::new() };
        let proposal = executor.run_acp(&acp_request(&home), &AtomicBool::new(false)).unwrap();
        assert_eq!(proposal["summary"], "Stub proposal");
        assert_eq!(proposal["operations"].as_array().unwrap().len(), 1);
    }

    #[test]
    #[cfg(unix)]
    fn acp_transport_reports_non_json_output_honestly() {
        let home = std::env::temp_dir().join(format!("acp-stub-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&home).unwrap();
        let stub = write_stub_agent(&home, "plain prose without a proposal");
        let executor = AcpAgentExecutor { program: stub.into_os_string(), args: Vec::new() };
        let error = executor.run_acp(&acp_request(&home), &AtomicBool::new(false)).unwrap_err();
        assert_eq!(error.code, "acp_output_invalid");
    }

    #[test]
    fn prompt_and_config_never_expose_paths_or_write_capabilities() {
        let home = std::env::temp_dir().join("private-creator-home");
        let request = AgentExecutionRequest { data_home: home.clone(), goal: "Small goal".into(), human_request: "Review only".into(),
            artifact: json!({"projectId":"project-1","expectedRevision":3}), plan_revision: 1, timeout: Duration::from_secs(1) };
        let prompt = execution_prompt(&request);
        assert!(!prompt.contains(home.to_string_lossy().as_ref()));
        assert!(prompt.contains("Do not commit, publish, install, write files"));
        let config = mcp_config_args(&home).join(&OsString::from(" "));
        let config = config.to_string_lossy();
        assert!(!config.contains("allow-local-writes"));
        assert!(config.contains("data-mcp"));
    }

    #[test]
    fn codex_jsonl_requires_nonempty_json_proposal() {
        let proposal = json!({"summary":"Preview proposed","operations":[{"op":"skin.select","skinId":"miami-vice"}]});
        let event = json!({"type":"item.completed","item":{"type":"agent_message","text":proposal.to_string()}});
        let text = extract_agent_text(event.to_string().as_bytes()).unwrap();
        let proposal = parse_proposal(&text).unwrap();
        assert_eq!(proposal["summary"], "Preview proposed");
        assert!(parse_proposal("not json").is_err());
        assert!(extract_agent_text(b"{}").is_err());
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
    }
}
