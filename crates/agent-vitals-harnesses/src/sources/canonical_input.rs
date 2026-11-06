//! 多执行环境 `原始会话文件路径 -> CanonicalSession` 入口——v0.10.0 新建的基础设施
//! （spec §7 门槛 1「三执行环境从 CanonicalSession 派生确定性图」的前提）。
//!
//! **这条能力此前不存在**：`agent-vitals-runtime::sessions::behavior::
//! audit_session_log` 是唯一现存的「路径 → CanonicalSession」生产入口，且
//! **硬编码只认 DSH**（直接调 `dsh_evidence::build_dsh_evidence`）。
//! Claude Code / Codex 的 `evidence.rs` 构建函数（`build_claude_evidence` /
//! `build_codex_evidence`）本身早就存在，但目前**只有测试代码**调用它们——
//! 生产路径上没有任何东西从真实文件读出 `Vec<Value>` 喂给它们。本模块补上
//! 这一段：一个按 `harness_id` 分派的读取器 + 调度层，三执行环境统一走
//! `canonical_session_for_path`。
//!
//! I/O（`std::fs`），所以整份文件挂 `sources` feature（与
//! `harnesses::dsh::sources::read_session_log` 同一条边界）。

use std::fs;
use std::path::{Path, PathBuf};

use agent_vitals_domain::contracts::evidence::CanonicalSession;
use serde_json::Value;

use crate::{claude_code_evidence, codex_evidence, dsh_evidence, dsh_sources};

/// 三执行环境里唯一需要 I/O 的读取步骤失败的原因——诚实分类，不是笼统的
/// `String` 错误袋（呼应 `dsh_sources::read_session_log` 的 `degraded` 字符串
/// 分类，但做成类型而不是裸字符串，供上层按错误种类分支）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalInputError {
    /// `harness` 不在封闭词表里（claude-code / codex / dsh，E4b 起 + workbuddy）。
    UnknownHarness(String),
    /// 文件不存在 / 无法读取（权限、损坏等）。
    FileUnavailable(String),
    /// 读到了，但一行都解析不出合法 JSON——不是「空文件」（那是合法的零事件
    /// 会话），是「读到的内容不是这个执行环境认识的形状」。
    NoParsableRecords,
}

impl std::fmt::Display for CanonicalInputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CanonicalInputError::UnknownHarness(h) => {
                write!(f, "unknown harness `{h}` (trace harnesses: claude-code/codex/dsh/workbuddy)")
            }
            CanonicalInputError::FileUnavailable(e) => write!(f, "file unavailable: {e}"),
            CanonicalInputError::NoParsableRecords => {
                write!(
                    f,
                    "no parsable records — the file is not in this harness's wire format"
                )
            }
        }
    }
}

/// 逐行 JSONL 读取，跳过空行；解析失败的行**计数但不中止**——诚实报告
/// 「这个文件有多少行读不出来」，而不是让一行坏数据吞掉整个会话（同
/// `read_degradation` 系列纪律：损坏的语料要浮出来，不能被吃掉）。返回
/// `(记录, 坏行数)`。
fn read_jsonl_lines(text: &str) -> (Vec<Value>, usize) {
    let mut records = Vec::new();
    let mut bad = 0usize;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(v) => records.push(v),
            Err(_) => bad += 1,
        }
    }
    (records, bad)
}

/// 会话 id：优先文件名 stem（执行环境惯例——DSH/Claude Code 都用会话 id 命名文件
/// 或所在目录），读不出 stem 时退化成整段路径字符串（诚实兜底，不是 panic）。
fn session_id_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_owned)
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// DSH 的日志文件名固定为 `session.jsonl[.zstd]`，并不携带逻辑会话 id；真实
/// id 在其父目录名（与 DSH discovery 的 zstd 回退规则一致）。其他路径仍保留
/// stem 兜底，方便诊断工具读取临时 fixture。
fn dsh_session_id_from_path(path: &Path) -> String {
    if let Ok(text) = dsh_sources::read_session_text(path) {
        if let Some((id, _)) = crate::harnesses::dsh::sessions::header::dsh_header(&text) {
            if !id.is_empty() {
                return id;
            }
        }
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if matches!(name, "session.jsonl" | "session.jsonl.zstd") {
        if let Some(id) = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
        {
            return id.to_string();
        }
    }
    session_id_from_path(path)
}

/// DSH 的 native session id 以日志头为权威；路径目录名只是日志损坏或不可读时
/// 的诊断兜底。供 runtime 的受控源定位使用，避免目录移动后 session_ref 无法
/// 下钻。返回错误时上层会明确报 source unavailable，不把路径名猜测成身份。
pub fn dsh_native_session_id_for_path(path: &Path) -> Result<String, CanonicalInputError> {
    let text = dsh_sources::read_session_text(path)
        .map_err(|code| CanonicalInputError::FileUnavailable(code.to_string()))?;
    let Some((id, _)) = crate::harnesses::dsh::sessions::header::dsh_header(&text) else {
        return Err(CanonicalInputError::NoParsableRecords);
    };
    if id.is_empty() {
        return Err(CanonicalInputError::NoParsableRecords);
    }
    Ok(id)
}

/// 多个同一逻辑会话的源文件 → 一份 CanonicalSession。
///
/// Codex 可以把一个逻辑 session 续写到多个 `rollout-*.jsonl`；只读第一份会
/// 让 TraceGraph 与 SQL 中按逻辑 session 归属的 usage facts 不一致。这里在
/// **确认这些文件都属于同一 native session 后**由上层传入，按稳定路径序合并
/// 记录，再只做一次 canonical projection。它不会将路径或原始内容泄漏给调用方。
pub fn canonical_session_for_paths(
    paths: &[PathBuf],
    harness: &str,
    session_id: String,
) -> Result<CanonicalSession, CanonicalInputError> {
    if paths.is_empty() {
        return Err(CanonicalInputError::FileUnavailable(
            "no source files".to_string(),
        ));
    }
    match harness {
        "dsh" => {
            let mut execution_events = Vec::new();
            let mut usage_events = Vec::new();
            let mut cwd = None;
            for path in paths {
                let session = dsh_sources::read_session_log(path);
                if let Some(code) = session.get("degraded").and_then(|v| v.as_str()) {
                    return Err(CanonicalInputError::FileUnavailable(code.to_string()));
                }
                execution_events.extend(
                    session
                        .get("execution_events")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default(),
                );
                usage_events.extend(
                    session
                        .get("usage_events")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default(),
                );
                if cwd.is_none() {
                    cwd = session
                        .get("cwd")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned);
                }
            }
            Ok(
                dsh_evidence::build_dsh_evidence(execution_events, usage_events, cwd, session_id)
                    .canonical,
            )
        }
        "claude-code" | "codex" => {
            let mut records = Vec::new();
            for path in paths {
                let text = fs::read_to_string(path)
                    .map_err(|e| CanonicalInputError::FileUnavailable(e.to_string()))?;
                let (file_records, _bad) = read_jsonl_lines(&text);
                records.extend(file_records);
            }
            if records.is_empty() {
                return Err(CanonicalInputError::NoParsableRecords);
            }
            if harness == "claude-code" {
                Ok(claude_code_evidence::build_claude_evidence(records, session_id).canonical)
            } else {
                Ok(codex_evidence::build_codex_evidence(
                    records,
                    session_id,
                    None,
                    None,
                    None,
                    Vec::new(),
                    None,
                )
                .canonical)
            }
        }
        // WorkBuddy（E4b）不是单文件会话：证据散在 `~/.workbuddy/` 的 db /
        // audit-log / traces 三面，按 session_id join。`paths[0]` 是**用户 HOME**
        // （`workbuddy_root(home)` 在里面解析），不是某个文件——上层
        // `trace_service::source_paths_for_session` 就按这个约定传。多传的路径
        // 忽略（一个 HOME 只有一个 WorkBuddy 根）。
        "workbuddy" => crate::workbuddy_session::workbuddy_canonical_session(&paths[0], &session_id)
            .ok_or_else(|| {
                CanonicalInputError::FileUnavailable(format!(
                    "workbuddy session `{session_id}` has neither a db row nor audit-log records"
                ))
            }),
        other => Err(CanonicalInputError::UnknownHarness(other.to_string())),
    }
}

/// 给定执行环境 id + 会话文件路径，产出 `CanonicalSession`（spec §7 门槛 1 的入口）。
///
/// 三执行环境分派：
/// - `dsh`：复用 `dsh_sources::read_session_log`（已处理 zstd 解压 + 降级分类），
///   再喂 `build_dsh_evidence`；
/// - `claude-code` / `codex`：本模块新增的逐行 JSONL 读取 + 对应 `build_*_evidence`；
///   Codex 的 `history_mode`/`cli_version`/`title` 三个字段是纯 provenance
///   （`codex/sessions/evidence.rs` 头注：「只进报告不参与计数」），此处统一传
///   `None`——不影响 canonical 时间线的解析正确性。
/// - `workbuddy`：**不走本函数**（没有「会话文件」这回事；`trace <file>` 子命令
///   对它无意义）——只经 `canonical_session_for_paths(&[home], "workbuddy", sid)`
///   由 `trace-ref` 进入。
/// - 其余 harness 字符串 → `UnknownHarness`（封闭词表 = `FACT_HARNESSES`，见 spec §2.5.1）。
pub fn canonical_session_for_path(
    path: &Path,
    harness: &str,
) -> Result<CanonicalSession, CanonicalInputError> {
    let session_id = if harness == "dsh" {
        dsh_session_id_from_path(path)
    } else {
        session_id_from_path(path)
    };
    canonical_session_for_paths(&[path.to_path_buf()], harness, session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_file(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agent-vitals-canonical-input-test-{}-{}-{}",
            std::process::id(),
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }

    // `CanonicalSession` 没有 `Debug`（domain 契约类型没有派生它），所以
    // `.unwrap_err()` 用不了——手写这个小 helper 代替。
    fn expect_err(r: Result<CanonicalSession, CanonicalInputError>) -> CanonicalInputError {
        match r {
            Ok(_) => panic!("expected an error, got Ok(CanonicalSession)"),
            Err(e) => e,
        }
    }

    #[test]
    fn unknown_harness_is_rejected_not_silently_guessed() {
        let p = tmp_file("x.jsonl", "");
        let err = expect_err(canonical_session_for_path(&p, "not-a-real-harness"));
        assert_eq!(
            err,
            CanonicalInputError::UnknownHarness("not-a-real-harness".to_string())
        );
    }

    #[test]
    fn missing_file_is_file_unavailable_not_a_panic() {
        let p = std::path::Path::new("/nonexistent/does/not/exist.jsonl");
        let err = expect_err(canonical_session_for_path(p, "claude-code"));
        assert!(matches!(err, CanonicalInputError::FileUnavailable(_)));
    }

    #[test]
    fn claude_code_jsonl_produces_a_canonical_session_with_a_tool_call() {
        let lines = [
            r#"{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-08-20T14:27:08.827Z","message":{"id":"m1","content":"hi"}}"#,
            r#"{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-08-20T14:27:09.000Z","message":{"id":"m2","model":"claude-sonnet-5","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}}]}}"#,
        ];
        let p = tmp_file("session.jsonl", &lines.join("\n"));
        let session = canonical_session_for_path(&p, "claude-code").unwrap();
        assert_eq!(session.meta.harness_id, "claude-code");
        assert!(
            !session.tool_calls.entries.is_empty(),
            "Bash tool_use 应该抽出一条 tool_call"
        );
    }

    #[test]
    fn codex_rollout_produces_a_canonical_session() {
        let lines = [
            r#"{"type":"session_meta","payload":{"session_id":"ses-abc"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#,
        ];
        let p = tmp_file("rollout.jsonl", &lines.join("\n"));
        let session = canonical_session_for_path(&p, "codex").unwrap();
        assert_eq!(session.meta.harness_id, "codex");
    }

    #[test]
    fn dsh_fixed_filename_uses_parent_directory_as_logical_session_id() {
        let p = tmp_file(
            "session.jsonl",
            "{\"type\":\"session\",\"version\":0,\"id\":\"sess-real\",\"cwd\":\"/tmp\"}\n",
        );
        let session = canonical_session_for_path(&p, "dsh").unwrap();
        assert_eq!(
            session.meta.session_id, "sess-real",
            "DSH header id, not the fixed filename or directory, is the logical session key"
        );
    }

    #[test]
    fn empty_claude_code_file_is_no_parsable_records_not_a_fake_empty_session() {
        let p = tmp_file("empty.jsonl", "");
        let err = expect_err(canonical_session_for_path(&p, "claude-code"));
        assert_eq!(err, CanonicalInputError::NoParsableRecords);
    }

    #[test]
    fn jsonl_reader_counts_bad_lines_without_aborting() {
        let text = "not json\n{\"a\":1}\n\nalso not json\n";
        let (records, bad) = read_jsonl_lines(text);
        assert_eq!(records.len(), 1);
        assert_eq!(bad, 2);
    }
}
