use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::Read;
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
