//! OpenClaw 与 Hermes 的根目录发现。
//!
//! OpenClaw 是**多实例**的：`~/.open*` 下每个带 `openclaw.json` 的目录都是一个
//! 独立运行时，同一个 skill 名在两个实例里不是同一个东西。实例身份因此必须
//! 一路带到每条记录上（`SourceMeta`），否则冲突判定会把两个实例的同名 skill
//! 报成冲突。
//!
//! 运行时验证走 `openclaw skills list --eligible --json`：这是唯一能回答
//! 「模型这一轮真的看得见哪些 skill」的官方接口，故其结论覆盖磁盘推断。
//! 探测不到时 skill 保持 `runtime_verified=false` 且理由写明未经证实。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::skill_discovery::SourceMeta;
use agent_vitals_domain::util::norm;

fn read_lossy(p: &Path) -> Option<String> {
    let bytes = std::fs::read(p).ok()?;
    Some(agent_vitals_domain::util::bytes_to_lossy_normalized(&bytes))
}

fn expand(p: &str, home: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        return PathBuf::from(home).join(rest);
    }
    if p == "~" {
        return PathBuf::from(home);
    }
    PathBuf::from(p)
}

/// 读 Hermes 的 `skills.external_dirs`。
///
/// 只支持其文档里的 YAML 列表形式，**不引入 YAML 依赖** —— 这个仓库的
/// 零依赖约束是刻意的（一个审计供应链风险的工具不该自己拉第三方解析器）。
/// 解析不了的形式就当没有，而不是猜。
pub fn read_hermes_external_dirs(home: &str) -> Vec<PathBuf> {
    let cfg = PathBuf::from(home).join(".hermes/config.yaml");
    let text = match read_lossy(&cfg) {
        Some(t) => t,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    let (mut in_skills, mut in_external) = (false, false);
    for raw_line in text.lines() {
        let clean = raw_line.split('#').next().unwrap_or("");
        let trimmed = clean.trim_end();
        if trimmed.trim_start() == "skills:" && !clean.starts_with(char::is_whitespace) {
            in_skills = true;
            in_external = false;
            continue;
        }
        // 回到顶格 = 离开 skills 块
        if in_skills && !clean.is_empty() && !clean.starts_with(char::is_whitespace) {
            in_skills = false;
            in_external = false;
        }
        if in_skills && clean.trim() == "external_dirs:" {
            in_external = true;
            continue;
        }
        if in_external {
            let t = clean.trim();
            if let Some(item) = t.strip_prefix('-') {
                let v = item.trim().trim_matches(|c| c == '\'' || c == '"');
                if !v.is_empty() {
                    out.push(expand(v, home));
                }
            } else if !t.is_empty() {
                in_external = false;
            }
        }
    }
    out
}

/// 在 PATH 上找 openclaw 自带的 skills 目录（npm shim / 直装 / pnpm 都要覆盖）。
///
/// `AGENT_VITALS_DISABLE_OPENCLAW_BUNDLED=1` 关掉这条发现——golden/CI 用，
/// 挡住「开发机上真装了全局 openclaw」泄漏进快照。Python 侧
/// （adapters/openclaw.py::find_openclaw_bundled_skills）一直有这道闸，
/// Rust 移植时漏了，golden_runner 在没装 openclaw 的机器上永远测不出来。
fn find_openclaw_bundled_skills() -> Option<PathBuf> {
    if std::env::var("AGENT_VITALS_DISABLE_OPENCLAW_BUNDLED").as_deref() == Ok("1") {
        return None;
    }
    let path = std::env::var_os("PATH")?;
    let exe = std::env::split_paths(&path)
        .map(|d| d.join("openclaw"))
        .find(|p| p.is_file())?;
    let resolved = exe.canonicalize().unwrap_or_else(|_| exe.clone());

    let mut anchors: Vec<PathBuf> = Vec::new();
    if let Some(p) = exe.parent() {
        anchors.push(p.to_path_buf());
    }
    if let Some(p) = resolved.parent() {
        anchors.push(p.to_path_buf());
        anchors.extend(p.ancestors().map(|a| a.to_path_buf()));
    }

    let mut seen: Vec<String> = Vec::new();
    for anchor in anchors {
        let mut candidates = vec![
            anchor.join("node_modules/openclaw/skills"),
            anchor.join("openclaw/skills"),
        ];
        if anchor.file_name().and_then(|s| s.to_str()) == Some("openclaw") {
            candidates.push(anchor.join("skills"));
        }
        for c in candidates {
            let key = norm(&c);
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            if c.is_dir() && has_skill_child(&c) {
                return c.canonicalize().ok().or(Some(c));
            }
        }
    }
    None
}

fn has_skill_child(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries
            .filter_map(|e| e.ok())
            .any(|e| e.path().join("SKILL.md").is_file())
    })
}

fn get_obj<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Map<String, Value>> {
    let mut cur = v;
    for k in path {
        cur = cur.get(k)?;
    }
    cur.as_object()
}

/// 发现 OpenClaw 的多实例根目录，并保留实例与配置证据。
pub fn read_openclaw_roots(home: &str) -> Vec<(String, SourceMeta)> {
    let mut roots = Vec::new();
    let entries = match std::fs::read_dir(home) {
        Ok(e) => e,
        Err(_) => return roots,
    };
    // 排序：目录枚举顺序会传导到 scanned_roots 与别名编号
    let mut instances: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|n| n.starts_with(".open"))
        })
        .collect();
    instances.sort_by_key(|p| norm(p));

    for instance in instances {
        let cfg = instance.join("openclaw.json");
        if !cfg.is_file() {
            continue;
        }
        let data: Value = read_lossy(&cfg)
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null);

        let meta = SourceMeta {
            instance_id: instance
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string()),
            instance_root: Some(norm(&instance.canonicalize().unwrap_or_else(|_| instance.clone()))),
            config_path: Some(norm(&cfg.canonicalize().unwrap_or_else(|_| cfg.clone()))),
            root_kind: None,
            skill_entries: get_obj(&data, &["skills", "entries"]).cloned().unwrap_or_default(),
            skills_prompt_budget_chars: data
                .get("skills")
                .and_then(|s| s.get("limits"))
                .and_then(|l| l.get("maxSkillsPromptChars"))
                .and_then(|v| v.as_i64()),
            ..SourceMeta::default()
        };

        let with_kind = |kind: &str| SourceMeta {
            root_kind: Some(kind.to_string()),
            ..meta.clone()
        };

        for (name, kind) in [("skills", "managed"), ("plugin-skills", "plugin")] {
            roots.push((norm(&instance.join(name)), with_kind(kind)));
        }
        if let Some(ws) = data
            .get("agents")
            .and_then(|a| a.get("defaults"))
            .and_then(|d| d.get("workspace"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            roots.push((
                norm(&expand(ws, home).join("skills")),
                with_kind("workspace"),
            ));
        }
        roots.push((
            norm(&PathBuf::from(home).join(".agents/skills")),
            with_kind("shared-user"),
        ));
        if let Some(bundled) = find_openclaw_bundled_skills() {
            roots.push((norm(&bundled), with_kind("bundled")));
        }
    }
    roots
}


// ── 运行时目录 ───────────────────────────────────────────

pub struct OpenClawRuntime {
    pub available: bool,
    pub instance_id: Option<String>,
    pub skills: Vec<Value>,
    pub errors: Vec<String>,
}

/// 向 OpenClaw 本体询问某个实例的权威清单。
///
/// `OPENCLAW_STATE_DIR` 是选实例的开关 —— 多实例场景下不设它就会问错实例，
/// 拿回来的是另一个运行时的清单，比问不到更糟。
pub fn read_openclaw_runtime(instance_root: &Path, timeout: Duration) -> OpenClawRuntime {
    let fail = |e: String| OpenClawRuntime {
        available: false,
        instance_id: instance_root
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string()),
        skills: Vec::new(),
        errors: vec![e],
    };

    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return fail("openclaw executable not found".into()),
    };
    let exe = match std::env::split_paths(&path)
        .map(|d| d.join("openclaw"))
        .find(|p| p.is_file())
    {
        Some(e) => e,
        None => return fail("openclaw executable not found".into()),
    };

    let workspace = instance_root.join("workspace");
    let cwd = if workspace.is_dir() { workspace } else { instance_root.to_path_buf() };

    // std::process 没有超时。用线程 + 通道兜住：探测卡死比探测失败糟糕得多。
    let (tx, rx) = std::sync::mpsc::channel();
    let exe2 = exe.clone();
    let root2 = instance_root.to_path_buf();
    std::thread::spawn(move || {
        let out = Command::new(&exe2)
            .args(["skills", "list", "--eligible", "--json", "--agent", "main"])
            .current_dir(&cwd)
            .env("OPENCLAW_STATE_DIR", &root2)
            .output();
        let _ = tx.send(out);
    });
    let output = match rx.recv_timeout(timeout) {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return fail(e.to_string()),
        Err(_) => return fail(format!("timed out after {}s", timeout.as_secs())),
    };

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let tail: String = if err.is_empty() {
            format!("exit={:?}", output.status.code())
        } else {
            err.chars().rev().take(500).collect::<Vec<_>>().into_iter().rev().collect()
        };
        return fail(tail);
    }
    let payload: Value = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(e) => return fail(format!("invalid JSON: {}", e)),
    };
    OpenClawRuntime {
        available: true,
        instance_id: instance_root
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string()),
        skills: payload
            .get("skills")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        errors: Vec::new(),
    }
}

/// 用 OpenClaw 自己给出的 eligible / modelVisible 状态覆盖磁盘推断。
///
/// **清单里没有 = 这一轮模型看不见它。**这条必须显式写成
/// `openclaw-cli-not-eligible` 而不是留着磁盘推断的乐观结论 ——
/// 拿到了权威答案却不用，比没拿到更糟。
pub fn apply_openclaw_runtime(skills: &mut [Value], runtimes: &[OpenClawRuntime]) {
    for runtime in runtimes {
        if !runtime.available {
            continue;
        }
        for rec in skills.iter_mut() {
            if rec.get("harness_family").and_then(|v| v.as_str()) != Some("openclaw") {
                continue;
            }
            if rec.get("instance_id").and_then(|v| v.as_str())
                != runtime.instance_id.as_deref()
            {
                continue;
            }
            let name = rec.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let meta = runtime
                .skills
                .iter()
                .find(|m| m.get("name").and_then(|v| v.as_str()) == Some(name.as_str()));

            match meta {
                None => {
                    rec["loaded"] = json!(false);
                    rec["discoverable"] = json!(false);
                    rec["loaded_state"] = json!(false);
                    rec["runtime_verified"] = json!(true);
                    rec["loaded_reason"] = json!("openclaw-cli-not-eligible");
                }
                Some(m) => {
                    let visible = m.get("modelVisible").and_then(|v| v.as_bool()).unwrap_or(true);
                    let disabled = m.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
                    rec["loaded"] = json!(visible);
                    rec["discoverable"] = json!(true);
                    rec["enabled_state"] = json!(!disabled);
                    rec["loaded_state"] = json!(visible);
                    rec["runtime_verified"] = json!(true);
                    rec["loaded_reason"] = json!("openclaw-cli-eligible-model-visible");
                    rec["runtime_status"] = json!("eligible-model-visible");
                    rec["body_loaded_state"] = Value::Null;
                    rec["openclaw_runtime"] = m.clone();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hermes_config_absent_is_empty_not_panic() {
        assert!(read_hermes_external_dirs("/nonexistent-xyz").is_empty());
    }

    #[test]
    fn openclaw_home_without_instances_is_empty() {
        assert!(read_openclaw_roots("/nonexistent-xyz").is_empty());
    }

    #[test]
    fn hermes_parses_the_documented_list_form() {
        let dir = std::env::temp_dir().join(format!("sv-hermes-{}", std::process::id()));
        let _ = std::fs::create_dir_all(dir.join(".hermes"));
        std::fs::write(
            dir.join(".hermes/config.yaml"),
            "other: 1\nskills:\n  external_dirs:\n    - '/a/b'\n    - \"/c/d\"\n    - ~/e\nnext: 2\n",
        )
        .unwrap();
        let home = dir.to_string_lossy().to_string();
        let got: Vec<String> = read_hermes_external_dirs(&home)
            .iter()
            .map(|p| norm(p))
            .collect();
        assert_eq!(got, vec!["/a/b".to_string(), "/c/d".to_string(),
                             format!("{}/e", norm(&dir))]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hermes_stops_at_the_end_of_the_block() {
        // 顶格的下一个键必须终止解析，否则会把无关列表当成 external_dirs
        let dir = std::env::temp_dir().join(format!("sv-hermes2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(dir.join(".hermes"));
        std::fs::write(
            dir.join(".hermes/config.yaml"),
            "skills:\n  external_dirs:\n    - /a\nplugins:\n  dirs:\n    - /should-not-appear\n",
        )
        .unwrap();
        let got: Vec<String> = read_hermes_external_dirs(&dir.to_string_lossy())
            .iter()
            .map(|p| norm(p))
            .collect();
        assert_eq!(got, vec!["/a".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
