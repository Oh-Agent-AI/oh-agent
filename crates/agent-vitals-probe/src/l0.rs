//! L0 身份探针：spawn `claude -p --output-format stream-json`，从协议事件里
//! 抽 resolved model / usage 四桶 / 会话 id。解析是纯函数（单测钉住），
//! spawn 沿用 `run_navigation` 的 try_wait 轮询 + 超时 kill 模式。

use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use agent_vitals_domain::probe::L0Observation;

/// `claude -p --output-format stream-json --verbose` 事件流 → 观察 + 发起期
/// 错误摘要。纯函数：逐行 JSON，取 init 事件的 `model`/`session_id`、
/// assistant 事件的 `model`、result 事件的 usage 四桶与 `model`。resolved 取
/// **最后一次出现的** model 字段（result 事件最权威；缺失则如实 None）。
///
/// **`<synthetic>` 不是身份**（2026-09-19 实机教训）：请求在网关被拒（如中转
/// 402 余额不足）时 claude CLI 以退出码 0 收场，并把错误写成
/// `model:"<synthetic>"` 的**本地合成** assistant 消息。把它当 resolved 会产出
/// confirmed_mismatch 误报——这里一律按「模型字段缺席」处理，并把错误首行
/// （≤120 chars，无凭据）提为 `api_error_excerpt` 交 runner 记 error outcome。
#[derive(Debug)]
pub struct ParsedStream {
    pub observation: L0Observation,
    /// claude 本地合成的 `API Error: …` 首行摘要（截断）。出现即代表没有
    /// 真实模型响应。
    pub api_error_excerpt: Option<String>,
}

/// 合成消息文本是否 claude 的本地 API 错误占位。
fn api_error_excerpt_of(message: &serde_json::Value) -> Option<String> {
    let text = message.get("content")?.as_array()?.iter().find_map(|block| {
        if block.get("type").and_then(serde_json::Value::as_str) != Some("text") {
            return None;
        }
        block.get("text").and_then(serde_json::Value::as_str)
    })?;
    let first_line = text.lines().next()?.trim();
    if first_line.starts_with("API Error") {
        Some(first_line.chars().take(120).collect())
    } else {
        None
    }
}

pub fn parse_stream_events(stdout: &str) -> ParsedStream {
    let mut requested_placeholder_model: Option<String> = None;
    let mut resolved: Option<String> = None;
    let mut session_id: Option<String> = None;
    let mut usage: Option<(i64, i64, i64, i64)> = None;
    let mut api_error_excerpt: Option<String> = None;
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // 非 JSON 行（CLI 横幅等）跳过——事件流里混排是常态
        };
        let event_type = value.get("type").and_then(serde_json::Value::as_str);
        match event_type {
            Some("system") => {
                if value.get("subtype").and_then(serde_json::Value::as_str) == Some("init") {
                    session_id = value
                        .get("session_id")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string);
                }
            }
            Some("assistant") => {
                let message = value.get("message");
                let model = message
                    .and_then(|m| m.get("model"))
                    .and_then(serde_json::Value::as_str)
                    .filter(|m| *m != "<synthetic>");
                if let Some(model) = model {
                    if requested_placeholder_model.is_none() {
                        requested_placeholder_model = Some(model.to_string());
                    }
                    resolved = Some(model.to_string());
                }
                if api_error_excerpt.is_none() {
                    if let Some(message) = message {
                        api_error_excerpt = api_error_excerpt_of(message);
                    }
                }
            }
            Some("result") => {
                if let Some(model) = value.get("model").and_then(serde_json::Value::as_str) {
                    resolved = Some(model.to_string());
                }
                if let Some(u) = value.get("usage") {
                    let number = |key: &str| {
                        u.get(key).and_then(serde_json::Value::as_i64).unwrap_or(0)
                    };
                    let input = number("input_tokens");
                    let cache_read = number("cache_read_input_tokens");
                    let cache_write = number("cache_creation_input_tokens");
                    let output = number("output_tokens");
                    usage = Some((input, cache_read, cache_write, output));
                }
            }
            _ => {}
        }
    }
    ParsedStream {
        observation: L0Observation {
            // 解析层拿不到路线档案的 requested（调用方负责覆盖）——先以协议里首见
            // model 占位，避免结构体半初始化；runner 一律显式赋 requested_model。
            requested_model: resolved
                .clone()
                .or(requested_placeholder_model)
                .unwrap_or_default(),
            resolved_model: resolved,
            usage,
            native_session_id: session_id,
        },
        api_error_excerpt,
    }
}

/// 一次探针的产物（含观察 + 墙钟 + 合成错误摘要）。观察内部的模型串是
/// 公开字段，无凭据——Debug 可派生。
#[derive(Debug)]
pub struct L0Outcome {
    pub observation: L0Observation,
    /// `<synthetic>` 路径提出的 `API Error: …` 首行（见 `parse_stream_events`）。
    pub api_error_excerpt: Option<String>,
    pub wall_ms: i64,
}

#[derive(Debug)]
pub enum ProbeError {
    Spawn(String),
    Timeout,
    Incomplete(String),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeError::Spawn(message) => write!(f, "spawn failed: {message}"),
            ProbeError::Timeout => write!(f, "probe timed out"),
            // 错误文本不得携带凭据：只有 stderr 摘要，且 env 里本就没有回显。
            ProbeError::Incomplete(message) => write!(f, "incomplete output: {message}"),
        }
    }
}

fn try_wait_with_timeout(child: &mut Child, timeout: Duration) -> Result<bool, ProbeError> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(true),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ProbeError::Timeout);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(ProbeError::Spawn(error.to_string())),
        }
    }
}

/// 执行一次 L0 身份探针（echo 任务）。凭据以 env 直传子进程后立即 Drop。
pub fn run_identity_probe(
    claude_bin: &Path,
    base_url: Option<&str>,
    auth_token: Option<&str>,
    model_requested: &str,
    timeout: Duration,
) -> Result<L0Outcome, ProbeError> {
    let started = Instant::now();
    let mut command = Command::new(claude_bin);
    command
        .arg("-p")
        .arg("--output-format").arg("stream-json")
        .arg("--verbose")
        .arg("--max-turns").arg("1")
        .arg("--model").arg(model_requested)
        .arg("Reply with exactly: ok")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 路线隔离（验收 e2e 实锤）：先摘掉**继承**的 ANTHROPIC_*——否则"官方
    // 直连"臂会静默走父 shell 的中转 env（cc-switch 三件套），对照就废了。
    // ANTHROPIC_MODEL 一律摘（模型经 --model 显式传，继承值只会干扰）。
    for inherited in ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"] {
        command.env_remove(inherited);
    }
    if let Some(url) = base_url {
        command.env("ANTHROPIC_BASE_URL", url);
    }
    if let Some(token) = auth_token {
        command.env("ANTHROPIC_AUTH_TOKEN", token);
    }
    let mut child = command.spawn().map_err(|error| ProbeError::Spawn(error.to_string()))?;
    // 凭据值到此为止不再被引用（env 已拷贝进子进程）。
    let exited = try_wait_with_timeout(&mut child, timeout)?;
    if !exited {
        return Err(ProbeError::Timeout);
    }
    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if stdout.trim().is_empty() {
        // claude -p 有已知偶发空输出 bug（对拍分析时核实）——空输出按
        // Incomplete 报错，不猜。
        let summary: String = stderr.lines().take(3).collect::<Vec<_>>().join(" | ");
        return Err(ProbeError::Incomplete(if summary.is_empty() {
            "empty stdout".to_string()
        } else {
            summary
        }));
    }
    let mut parsed = parse_stream_events(&stdout);
    parsed.observation.requested_model = model_requested.to_string();
    Ok(L0Outcome {
        observation: parsed.observation,
        api_error_excerpt: parsed.api_error_excerpt,
        wall_ms: started.elapsed().as_millis() as i64,
    })
}

/// 测试与假 claude 脚本共享的样例事件流（runner 集成测试用它造可执行桩）。
#[cfg(test)]
pub(crate) const STREAM: &str = concat!(
        r#"{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-sonnet-5"}"#, "\n",
        r#"{"type":"assistant","message":{"model":"claude-sonnet-5-20260815","content":[{"type":"text","text":"ok"}]}}"#, "\n",
        r#"{"type":"result","subtype":"success","model":"claude-sonnet-5-20260815","usage":{"input_tokens":12,"cache_read_input_tokens":0,"cache_creation_input_tokens":34,"output_tokens":5}}"#, "\n",
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_takes_result_model_and_four_buckets() {
        let parsed = parse_stream_events(STREAM);
        assert_eq!(
            parsed.observation.resolved_model.as_deref(),
            Some("claude-sonnet-5-20260815"),
            "result 事件的 model 最权威"
        );
        assert_eq!(parsed.observation.native_session_id.as_deref(), Some("sess-1"));
        assert_eq!(parsed.observation.usage, Some((12, 0, 34, 5)));
        assert!(parsed.api_error_excerpt.is_none());
    }

    #[test]
    fn parser_survives_banner_noise_and_missing_fields() {
        let noisy = "claude-cli v1.2.3\nnot json at all\n{\"type\":\"result\",\"usage\":{}}\n";
        let parsed = parse_stream_events(noisy);
        assert!(parsed.observation.resolved_model.is_none(), "无 model 字段 = None，不猜");
        assert_eq!(parsed.observation.usage, Some((0, 0, 0, 0)), "usage 对象在但缺键 → 0 桶");
        assert!(parsed.api_error_excerpt.is_none());
    }

    /// 实机回归（2026-09-19，胜算云 402）：请求在网关被拒时 claude 以退出码 0
    /// 写下 `model:"<synthetic>"` 的本地合成错误消息——resolved 必须是 None
    /// （否则 confirmed_mismatch 误报），错误首行必须被提出给 runner 记 error。
    #[test]
    fn parser_treats_synthetic_model_as_absent_and_lifts_api_error() {
        let stream = concat!(
            r#"{"type":"system","subtype":"init","session_id":"sess-402"}"#, "\n",
            r#"{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"API Error: 402 insufficient balance: available balance: -1.1190. Please recharge at: https://console.shengsuanyun.com/user/recharge"}]}}"#, "\n",
            r#"{"type":"result","subtype":"success","usage":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0}}"#, "\n",
        );
        let parsed = parse_stream_events(stream);
        assert!(parsed.observation.resolved_model.is_none(), "<synthetic> 不是身份：{parsed:?}");
        assert_eq!(parsed.observation.requested_model, "", "合成消息也不进 requested 占位");
        assert!(parsed.api_error_excerpt.as_deref().unwrap_or("").starts_with("API Error: 402"));
        assert!(parsed.api_error_excerpt.as_deref().is_some_and(|s| s.chars().count() <= 120), "摘要截断到 120 chars");
        // 同流里若还有真实 assistant 事件，synthetic 不得覆盖它之后的 resolved。
        let mixed = concat!(
            r#"{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"API Error: 402 nope"}]}}"#, "\n",
            r#"{"type":"assistant","message":{"model":"claude-sonnet-5-20260815","content":[{"type":"text","text":"ok"}]}}"#, "\n",
        );
        let mixed_parsed = parse_stream_events(mixed);
        assert_eq!(mixed_parsed.observation.resolved_model.as_deref(), Some("claude-sonnet-5-20260815"));
        assert!(mixed_parsed.api_error_excerpt.is_some(), "错误摘要仍保留（供 evidence）");
    }

    #[test]
    fn identity_probe_runs_a_fake_claude_end_to_end() {
        // 临时可执行脚本当假 claude：无视参数，打印固定事件流——全链路
        // （spawn/env/超时/解析）无真花费。
        let dir = std::env::temp_dir().join(format!("av-fakeclaude-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("claude");
        std::fs::write(&script, format!("#!/bin/sh\ncat <<'EOF'\n{STREAM}EOF\n")).unwrap();
        make_executable(&script);
        let outcome = run_identity_probe(
            &script,
            Some("https://router.example/api"),
            Some("sk-launch-token"),
            "claude-sonnet-5",
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(outcome.observation.resolved_model.as_deref(), Some("claude-sonnet-5-20260815"));
        assert_eq!(outcome.observation.requested_model, "claude-sonnet-5");
        assert_eq!(outcome.observation.usage, Some((12, 0, 34, 5)));
        let _ = std::fs::remove_file(&script);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn identity_probe_times_out_and_kills() {
        let dir = std::env::temp_dir().join(format!("av-slowclaude-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("claude");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        make_executable(&script);
        let started = Instant::now();
        let error = run_identity_probe(&script, None, None, "m", Duration::from_millis(300))
            .expect_err("必须超时");
        assert!(matches!(error, ProbeError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(5), "超时后必须 kill 而非等待");
        let _ = std::fs::remove_file(&script);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn direct_arm_scrubs_inherited_relay_env() {
        // 验收 finding 4 的回归钉（复审定稿版）：脚本把子进程实际看到的
        // ANTHROPIC_* 计数写**侧文件**——断言的是 run_identity_probe 真实
        // 调用路径的摘除行为，删掉 env_remove 循环这里必须炸。
        let dir = std::env::temp_dir().join(format!("av-envclaude-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("claude");
        let counter = dir.join("anthropic_env_count");
        let counter_path = counter.display().to_string();
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nenv | grep -c '^ANTHROPIC_' > '{counter_path}' || echo 0 > '{counter_path}'\nprintf '%s\n' '{{\"type\":\"result\",\"model\":\"m\"}}'\n"
            ),
        )
        .unwrap();
        make_executable(&script);
        std::env::set_var("ANTHROPIC_BASE_URL", "https://router.inherited/api");
        std::env::set_var("ANTHROPIC_AUTH_TOKEN", "sk-inherited");
        let outcome = run_identity_probe(&script, None, None, "m", Duration::from_secs(10)).unwrap();
        std::env::remove_var("ANTHROPIC_BASE_URL");
        std::env::remove_var("ANTHROPIC_AUTH_TOKEN");
        assert_eq!(outcome.observation.resolved_model.as_deref(), Some("m"), "脚本必须完整执行");
        let count = std::fs::read_to_string(&counter).unwrap_or_default().trim().to_string();
        assert_eq!(count, "0", "直连臂子进程必须看不到任何继承的 ANTHROPIC_*（实际 {count} 个）");
        let _ = std::fs::remove_file(&script);
        let _ = std::fs::remove_file(&counter);
        let _ = std::fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}
}
