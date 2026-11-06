//! Codex Skill Surface 的纯计算——v0.8 Phase E7.6 从 `apps/cli/src/skills/
//! codex.rs` 拆出。该文件自己的模块头早就说清了这条边界（"把能测的部分抽成
//! 纯函数：消息构造与响应解析都不碰进程"）——本次只是把这个设计意图真的落进
//! crate 边界：I/O（子进程 spawn/管道读写）留在
//! `…::sources::skills::read_codex_runtime`，这里只有协议报文构造、响应
//! 解析、用运行时元数据覆盖磁盘推断三件事。
//!
//! **可测性说明（原文件的话，仍然成立）**：子进程 + JSON-RPC 的成功路径依赖
//! 本机装着 Codex，无法在 CI 或没装 Codex 的开发机上验证。故这里的函数全部
//! 由录制的报文覆盖，不需要真的启动 Codex。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use agent_vitals_domain::util::norm;

pub struct CodexRuntime {
    pub available: bool,
    pub cwd: String,
    pub skills: Vec<Value>,
    pub errors: Vec<String>,
    /// 实际跑的那个可执行文件。不进 JSON 输出（Python 侧同样不进），
    /// 但排查「装了两个 codex，跑的是哪个」时是唯一线索，故保留。
    #[allow(dead_code)]
    pub executable: Option<String>,
}

impl CodexRuntime {
    pub fn failed(cwd: String, err: impl Into<String>) -> Self {
        CodexRuntime {
            available: false,
            cwd,
            skills: Vec::new(),
            errors: vec![err.into()],
            executable: None,
        }
    }
}

/// 构造三条 app-server 报文。抽出来是为了能单独测。
pub fn protocol_messages(cwd: &str) -> Vec<Value> {
    vec![
        json!({"method": "initialize", "id": 1, "params": {"clientInfo": {
            "name": "agent-vitals", "title": "Agent Vitals", "version": "0.1.0"}}}),
        json!({"method": "initialized", "params": {}}),
        json!({"method": "skills/list", "id": 2, "params": {
            "cwds": [cwd], "forceReload": true}}),
    ]
}

/// 从 app-server 的输出行里取出 skills/list 的结果。**纯函数，可测。**
///
/// 只收 `cwd` 与请求一致的那些条目 —— app-server 可以一次返回多个工作目录，
/// 混进来的会让清点数字凭空变大。
pub fn parse_skills_list(lines: &[String], cwd_n: &str) -> Result<(Vec<Value>, Vec<String>), String> {
    let mut response: Option<Value> = None;
    for line in lines {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue, // 非 JSON 行（日志等）跳过，不是错误
        };
        if msg.get("id").and_then(|v| v.as_i64()) == Some(2) {
            response = Some(msg);
            break;
        }
    }
    let response = response.ok_or_else(|| "no skills/list response".to_string())?;
    if let Some(err) = response.get("error") {
        if !err.is_null() {
            return Err(err.to_string());
        }
    }
    let mut skills = Vec::new();
    let mut errors = Vec::new();
    if let Some(entries) = response
        .get("result")
        .and_then(|r| r.get("data"))
        .and_then(|d| d.as_array())
    {
        for entry in entries {
            let entry_cwd = entry.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
            if norm(Path::new(entry_cwd)) != cwd_n {
                continue;
            }
            if let Some(list) = entry.get("skills").and_then(|v| v.as_array()) {
                skills.extend(list.iter().cloned());
            }
            if let Some(list) = entry.get("errors").and_then(|v| v.as_array()) {
                errors.extend(list.iter().map(|e| match e.as_str() {
                    Some(s) => s.to_string(),
                    None => e.to_string(),
                }));
            }
        }
    }
    Ok((skills, errors))
}

/// 用运行时元数据覆盖磁盘推断，并补上只在运行时可见的 skill。
pub fn apply_codex_runtime(
    skills: &mut Vec<Value>,
    runtime: &CodexRuntime,
    scan_one: impl Fn(&Path) -> Option<Value>,
) {
    for meta in &runtime.skills {
        let md = match meta.get("path").and_then(|v| v.as_str()) {
            Some(p) if Path::new(p).is_file() => PathBuf::from(p),
            _ => continue,
        };
        let dir = match md.parent() {
            Some(d) => d.to_path_buf(),
            None => continue,
        };
        let dir_n = norm(&dir.canonicalize().unwrap_or_else(|_| dir.clone()));

        let idx = skills.iter().position(|s| {
            s.get("harness_family").and_then(|v| v.as_str()) == Some("codex")
                && s.get("path")
                    .and_then(|v| v.as_str())
                    .map(|p| norm(&Path::new(p).canonicalize().unwrap_or_else(|_| PathBuf::from(p))))
                    .as_deref()
                    == Some(dir_n.as_str())
        });
        let idx = match idx {
            Some(i) => i,
            None => match scan_one(&dir) {
                Some(rec) => {
                    skills.push(rec);
                    skills.len() - 1
                }
                None => continue,
            },
        };

        let rec = &mut skills[idx];
        let enabled = meta.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        if let Some(v) = meta.get("name").cloned() {
            rec["name"] = v;
        }
        if let Some(v) = meta.get("description").and_then(|v| v.as_str()) {
            rec["description"] = json!(v);
            rec["description_chars"] = json!(v.chars().count());
        }
        rec["loaded"] = json!(enabled);
        rec["loaded_reason"] = json!(if enabled {
            "codex-app-server-enabled"
        } else {
            "codex-app-server-disabled"
        });
        if let Some(v) = meta.get("scope").cloned() {
            rec["level"] = v;
        }
        rec["codex_scope"] = meta.get("scope").cloned().unwrap_or(Value::Null);
        rec["codex_interface"] = meta.get("interface").cloned().unwrap_or(Value::Null);
        rec["codex_dependencies"] = meta.get("dependencies").cloned().unwrap_or(Value::Null);
        rec["runtime_verified"] = json!(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn protocol_shape() {
        let m = protocol_messages("/w");
        assert_eq!(m.len(), 3);
        assert_eq!(m[0]["method"], "initialize");
        assert_eq!(m[2]["method"], "skills/list");
        assert_eq!(m[2]["params"]["cwds"][0], "/w");
        assert_eq!(m[2]["params"]["forceReload"], true);
    }

    #[test]
    fn picks_the_matching_cwd_only() {
        // app-server 可以一次返回多个工作目录；混进来的会让清点数字凭空变大
        let l = lines(&[
            r#"{"id":1,"result":{}}"#,
            r#"{"id":2,"result":{"data":[
                {"cwd":"/other","skills":[{"name":"nope"}],"errors":[]},
                {"cwd":"/w","skills":[{"name":"yes"}],"errors":["boom"]}]}}"#,
        ]);
        let (skills, errors) = parse_skills_list(&l, "/w").unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0]["name"], "yes");
        assert_eq!(errors, vec!["boom".to_string()]);
    }

    #[test]
    fn non_json_lines_are_skipped_not_fatal() {
        let l = lines(&[
            "starting app-server...",
            "",
            r#"{"id":2,"result":{"data":[{"cwd":"/w","skills":[]}]}}"#,
        ]);
        assert!(parse_skills_list(&l, "/w").is_ok());
    }

    #[test]
    fn missing_response_is_an_error_not_an_empty_success() {
        // 「没拿到响应」必须报错，绝不能当成「拿到了，是空的」——
        // 后者会让报告说「Codex 一个 skill 都没有」，那是编造证据。
        let l = lines(&[r#"{"id":1,"result":{}}"#]);
        assert!(parse_skills_list(&l, "/w").is_err());
    }

    #[test]
    fn protocol_error_is_propagated() {
        let l = lines(&[r#"{"id":2,"error":{"code":-1,"message":"nope"}}"#]);
        assert!(parse_skills_list(&l, "/w").is_err());
    }

    #[test]
    fn empty_result_for_matching_cwd_is_a_real_empty() {
        let l = lines(&[r#"{"id":2,"result":{"data":[{"cwd":"/w","skills":[],"errors":[]}]}}"#]);
        let (skills, errors) = parse_skills_list(&l, "/w").unwrap();
        assert!(skills.is_empty() && errors.is_empty());
    }
}
