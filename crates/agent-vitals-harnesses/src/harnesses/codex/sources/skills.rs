//! Codex Skill Surface 的 I/O 层——v0.8 Phase E7.6 从 `apps/cli/src/skills/
//! codex.rs` 拆出。子进程 spawn + JSON-RPC 握手在这里；协议报文构造、响应
//! 解析、用运行时元数据覆盖磁盘推断的纯逻辑在
//! `harnesses::codex::skills`（re-export 出来，`inventory.rs` 一个 `use … as
//! codex;` 就能同时拿到两边，call site 零改动）。
//!
//! `codex app-server` 的 `skills/list` 是唯一一个能给出「执行环境真的看见了哪些
//! skill」的官方接口，因此它的结果覆盖磁盘推断（`runtime_verified: true`）。
//! 失败路径（找不到可执行文件、超时、非法 JSON）一律降级为 errors 里的一条，
//! **绝不 panic、绝不无限等待**。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::Value;

use agent_vitals_domain::util::norm;

pub use crate::harnesses::codex::skills::{apply_codex_runtime, parse_skills_list, protocol_messages, CodexRuntime};

/// 在 PATH 上找 codex。优先原生二进制：npm 的 `.cmd` shim 在重定向 stdio 下
/// 可能脱离父进程，导致读不到任何输出。
fn find_codex_executable() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names: &[&str] = if cfg!(windows) {
        &["codex.exe", "codex.cmd", "codex"]
    } else {
        &["codex"]
    };
    for name in names {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn write_message(stdin: &mut impl Write, message: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, message)
        .map_err(|e| format!("app-server request serialization failed: {}", e))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("app-server stdin write failed: {}", e))
}

/// 等待指定 JSON-RPC 请求的响应。Codex 要求 initialize 完成后才能接收
/// initialized/skills/list，因此不能只等待最终的 id=2。
fn wait_for_response(
    rx: &mpsc::Receiver<String>,
    id: i64,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(format!("app-server request {} timed out", id));
        }
        match rx.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(line) => {
                let msg = match serde_json::from_str::<Value>(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if msg.get("id").and_then(|v| v.as_i64()) != Some(id) {
                    continue;
                }
                if let Some(error) = msg.get("error").filter(|v| !v.is_null()) {
                    return Err(format!("app-server request {} failed: {}", id, error));
                }
                return Ok(());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!("app-server closed before response {}", id));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
        }
    }
}

pub fn read_codex_runtime(cwd: &Path, timeout: Duration) -> CodexRuntime {
    let cwd_abs = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let cwd_n = norm(&cwd_abs);

    let exe = match find_codex_executable() {
        Some(e) => e,
        None => return CodexRuntime::failed(cwd_n, "codex executable not found"),
    };

    let mut child = match Command::new(&exe)
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(&cwd_abs)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return CodexRuntime::failed(cwd_n, format!("app-server failed: {}", e)),
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            return CodexRuntime::failed(cwd_n, "app-server produced no stdout");
        }
    };

    // 读取放在独立线程里，主线程只等信号 —— 否则 app-server 不退出就永远读不完。
    let (tx, rx) = mpsc::channel::<String>();
    let reader = std::thread::spawn(move || {
        let mut collected = Vec::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let is_response_2 = serde_json::from_str::<Value>(&line)
                .ok()
                .and_then(|v| v.get("id").and_then(|x| x.as_i64()))
                == Some(2);
            collected.push(line.clone());
            let _ = tx.send(line);
            if is_response_2 {
                break;
            }
        }
        collected
    });

    let messages = protocol_messages(&cwd_n);
    let protocol_result = match child.stdin.take() {
        Some(mut stdin) => {
            // app-server 是有状态协议：必须先完成 initialize 握手。
            let result = write_message(&mut stdin, &messages[0])
                .and_then(|_| wait_for_response(&rx, 1, timeout.min(Duration::from_secs(5))))
                .and_then(|_| write_message(&mut stdin, &messages[1]))
                .and_then(|_| write_message(&mut stdin, &messages[2]))
                .and_then(|_| wait_for_response(&rx, 2, timeout));
            // 请求完成或失败后再关闭；提前 EOF 会让部分版本的 app-server 收尾。
            drop(stdin);
            result
        }
        None => Err("app-server produced no stdin".to_string()),
    };

    let _ = child.kill();
    let _ = child.wait();
    let lines = reader.join().unwrap_or_default();

    if let Err(e) = protocol_result {
        return CodexRuntime::failed(cwd_n, e);
    }

    match parse_skills_list(&lines, &cwd_n) {
        Ok((skills, errors)) => CodexRuntime {
            available: true,
            cwd: cwd_n,
            skills,
            errors,
            executable: Some(norm(&exe)),
        },
        Err(e) => CodexRuntime::failed(cwd_n, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_executable_degrades_without_panic() {
        // 失败路径必须是 errors 里的一条，不是 panic，也不是挂起
        let rt = read_codex_runtime(Path::new("/nonexistent-xyz"), Duration::from_millis(200));
        assert!(!rt.available);
        assert!(!rt.errors.is_empty());
    }
}
