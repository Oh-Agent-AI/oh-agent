//! WorkBuddy traces 读取层（spec §9E.5 E1：locate → shape → extract）。
//!
//! `~/.workbuddy/traces/<pid>/trace_<id>.json`，每文件一个 `{trace: {...}, spans: [...]}`。
//! 归属键是 **`trace.sessionId`**（字符串相等，不猜——spec §9E.4 纪律 1）；没有这个键
//! 的 trace 进 `unattributed`（真实用量，不是另一类、不是损坏——纪律 2）。
//!
//! **三个只能踩一次的坑**（2026-09-11 分析步，§9E.1；09-02 的分析全踩了）：
//! - `toolInput` / `toolOutput` 是**二次 JSON 编码的字符串**，必须解一层。解不开 →
//!   计入 `decode_failures`，该 span 对应字段为 None，**不 panic 不猜**（纪律 3）。
//! - `trace.totalTokens` 不可信（302/675 为 0 但 span 有 usage）——**不读**（纪律 4）。
//!   token 只从 generation span 解码后的 `usage` 取。
//! - 时间戳是 ISO 毫秒串（`2026-08-14T23:49:18.442Z`），与 db/audit-log 的 epoch-ms
//!   整数不同——原样保留字符串，归一化留给消费方（A2 的字符串路径）。
//!
//! **只提取、不保留正文**（spec §4：不要 prompt 正文）：generation 的 `toolOutput`
//! 解码后只取每个响应项的 `model` 与 `usage`；function 的 `toolInput` 只取 `file_path`
//! （Edit/Write 的 SV604/605 源）。响应正文、messages、命令输出一律丢弃。
//!
//! **全量读**：每次调用读全部文件（真机 675 文件 / 686MB，Python 2.0s，Rust 更快）。
//! sessionId 在文件里、键序无保证，做不了廉价预筛。文件按路径字符串排序，输出
//! deterministic。**增量在同步管线那一层**（E4b）：`workbuddy_trace_files` 是
//! locate 面、`read_workbuddy_trace_file` 是单文件 shape 面——`sync_service` 用
//! 前者枚举、按 `(size, mtime)` 指纹只把 dirty 文件喂给后者，一个 trace 文件 =
//! 一个 source_id，纪律 7 的「mtime + 已见 traceId」索引由 `source_files` 表免费
//! 得到，本模块不另建索引。
//!
//! Python 镜像 `adapters/workbuddy_traces.py`，逐字节对齐。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// 一次 generation 响应项里的用量（OpenAI 兼容格式，与 Codex 五桶同形：
/// `uncached = prompt − cached`，cache_write 该格式没有）。字段缺失 → 0（真机
/// `usage` 有则四个 int 都在；`reasoning` 在 `completion_tokens_details` 里，常缺）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpanUsage {
    pub model: Option<String>,
    pub prompt_tokens: i64,
    pub cached_tokens: i64,
    pub completion_tokens: i64,
    pub reasoning_tokens: i64,
}

/// 一个 span 的提取结果。只留适配器会消费的字段。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpanSummary {
    pub span_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    /// `type`：custom / generation / function / agent。
    pub kind: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub status: Option<String>,
    pub error: Option<String>,
    /// function span 的 `toolName`。
    pub tool_name: Option<String>,
    /// function span `toolInput` 解码后的 `file_path`（Edit/Write）。
    pub file_path: Option<String>,
    /// generation span `toolOutput` 解码后各响应项的 usage（可多项）。
    pub usages: Vec<SpanUsage>,
    /// agent span 的 `agentName`。
    pub agent_name: Option<String>,
    /// 该 span 的 toolInput/toolOutput 二次解码失败（E4a：emitter 据此计 unreadable
    /// 而非 skip——一个 span 只落一个桶，`total = fact + skip + unreadable + unattributed`
    /// 才成立）。
    pub decode_failed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraceSummary {
    pub trace_id: String,
    pub path: PathBuf,
    pub name: Option<String>,
    pub session_id: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub spans: Vec<SpanSummary>,
    /// 本 trace 内 toolInput/toolOutput 解码失败的 span 数。
    pub decode_failures: u64,
}

/// 读取结果。`by_session` 键 = `trace.sessionId` 原串；`degraded` = 读不了/不是
/// trace 形状的文件（路径 + 原因），照 §14.4 记录不吞。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TracesRead {
    pub files: u64,
    pub by_session: BTreeMap<String, Vec<TraceSummary>>,
    pub unattributed: Vec<TraceSummary>,
    pub degraded: Vec<(PathBuf, String)>,
}

pub fn workbuddy_traces_root(root: &Path) -> PathBuf {
    root.join("traces")
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn opt_i64(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(Value::as_i64)
}

/// 二次编码解一层：字符串 → `serde_json::from_str`；`null`/缺失 → `Ok(None)`（真机
/// 取消/进行中的 generation 就是 `toolOutput: null`，不是失败）；其他类型（真机不
/// 出现）→ 视为解码失败（纪律 3：不猜「已经是对象了」）。
fn decode_layer(v: Option<&Value>) -> Result<Option<Value>, ()> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).map(Some).map_err(|_| ()),
        Some(_) => Err(()),
    }
}

fn usage_of(item: &Value) -> Option<SpanUsage> {
    let u = item.get("usage")?.as_object()?;
    let g = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
    let cached = u
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let reasoning = u
        .get("completion_tokens_details")
        .and_then(|d| d.get("reasoning_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Some(SpanUsage {
        model: item.get("model").and_then(Value::as_str).map(str::to_owned),
        prompt_tokens: g("prompt_tokens"),
        cached_tokens: cached,
        completion_tokens: g("completion_tokens"),
        reasoning_tokens: reasoning,
    })
}

/// 单个 span → `SpanSummary`；返回 `(summary, decode_failed)`。
fn shape_span(s: &Value) -> (SpanSummary, bool) {
    let kind = opt_str(s, "type").unwrap_or_default();
    let mut failed = false;
    let mut file_path = None;
    let mut usages = Vec::new();
    if kind == "function" {
        match decode_layer(s.get("toolInput")) {
            Ok(Some(inp)) => file_path = opt_str(&inp, "file_path"),
            Ok(None) => {}
            Err(()) => failed = true,
        }
    } else if kind == "generation" {
        match decode_layer(s.get("toolOutput")) {
            Ok(Some(Value::Array(items))) => {
                usages = items.iter().filter_map(usage_of).collect();
            }
            Ok(Some(ref obj @ Value::Object(_))) => {
                if let Some(u) = usage_of(obj) {
                    usages.push(u);
                }
            }
            Ok(Some(_)) | Ok(None) => {}
            Err(()) => failed = true,
        }
    }
    (
        SpanSummary {
            span_id: opt_str(s, "spanId").unwrap_or_default(),
            parent_id: opt_str(s, "parentId"),
            name: opt_str(s, "name").unwrap_or_default(),
            kind,
            started_at: opt_str(s, "startedAt"),
            ended_at: opt_str(s, "endedAt"),
            duration_ms: opt_i64(s, "duration"),
            status: opt_str(s, "status"),
            error: opt_str(s, "error"),
            tool_name: opt_str(s, "toolName"),
            file_path,
            usages,
            agent_name: opt_str(s, "agentName"),
            decode_failed: failed,
        },
        failed,
    )
}

fn shape_trace(path: &Path, doc: &Value) -> Result<TraceSummary, String> {
    let tr = doc
        .get("trace")
        .and_then(Value::as_object)
        .ok_or_else(|| "malformed: no `trace` object".to_string())?;
    let tr = Value::Object(tr.clone());
    let trace_id = opt_str(&tr, "traceId").ok_or_else(|| "malformed: no traceId".to_string())?;
    let session_id = opt_str(&tr, "sessionId").filter(|s| !s.is_empty());
    let mut decode_failures = 0_u64;
    let spans: Vec<SpanSummary> = doc
        .get("spans")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|s| s.is_object())
                .map(|s| {
                    let (sum, failed) = shape_span(s);
                    if failed {
                        decode_failures += 1;
                    }
                    sum
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(TraceSummary {
        trace_id,
        path: path.to_path_buf(),
        name: opt_str(&tr, "name"),
        session_id,
        started_at: opt_str(&tr, "startedAt"),
        ended_at: opt_str(&tr, "endedAt"),
        spans,
        decode_failures,
    })
}

/// locate 面：`<root>/traces/*/trace_*.json` 全部文件，按路径字符串排序（Python
/// `sorted(..., key=str)` 同款）。目录缺失 → 空 Vec。同步管线（E4b）的 dirty-file
/// 枚举也是这一个函数——一个 trace 文件就是一个 source_id。
pub fn workbuddy_trace_files(root: &Path) -> Vec<PathBuf> {
    let tdir = workbuddy_traces_root(root);
    let mut files: Vec<PathBuf> = Vec::new();
    if !tdir.is_dir() {
        return files;
    }
    if let Ok(rd) = std::fs::read_dir(&tdir) {
        for pid in rd.filter_map(Result::ok) {
            let p = pid.path();
            if !p.is_dir() {
                continue;
            }
            if let Ok(inner) = std::fs::read_dir(&p) {
                for f in inner.filter_map(Result::ok) {
                    let fp = f.path();
                    let name = fp.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    if fp.is_file() && name.starts_with("trace_") && name.ends_with(".json") {
                        files.push(fp);
                    }
                }
            }
        }
    }
    files.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
    files
}

/// Return traversal failures for WorkBuddy's trace tree. The file-list API is
/// kept best-effort for existing callers, while sync-facts uses this companion
/// report so directory failures cannot become a false empty source.
pub fn workbuddy_trace_walk_errors(root: &Path) -> Vec<String> {
    let tdir = workbuddy_traces_root(root);
    let mut errors = Vec::new();
    match std::fs::metadata(&tdir) {
        Ok(metadata) if metadata.is_dir() => {
            match std::fs::read_dir(&tdir) {
                Ok(entries) => {
                    for entry in entries {
                        let entry = match entry {
                            Ok(entry) => entry,
                            Err(error) => {
                                errors.push(format!("{}: {error}", tdir.display()));
                                continue;
                            }
                        };
                        let path = entry.path();
                        if !path.is_dir() { continue; }
                        match std::fs::read_dir(&path) {
                            Ok(files) => {
                                for file in files {
                                    if let Err(error) = file {
                                        errors.push(format!("{}: {error}", path.display()));
                                    }
                                }
                            }
                            Err(error) => errors.push(format!("{}: {error}", path.display())),
                        }
                    }
                }
                Err(error) => errors.push(format!("{}: {error}", tdir.display())),
            }
        }
        Ok(_) => {}
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            errors.push(format!("{}: {error}", tdir.display()));
        }
        Err(_) => {}
    }
    errors
}

/// 单趟版本（REFRESH_STORM R5-F7b 推广）：一次两层 read_dir 同时产出文件清单
/// 与遍历错误。`workbuddy_trace_files` 与 `workbuddy_trace_walk_errors` 各自扫
/// 一遍 `<root>/traces`；清单与错误来自同一次遍历时天然一致。排序/过滤语义与
/// `workbuddy_trace_files` 逐字节一致（全局路径字符串序、trace_*.json、pid 目
/// 录级）；错误文案与 `workbuddy_trace_walk_errors` 逐字节一致（外层条目错误
/// 记 tdir、内层错误记 pid 目录）；缺失根不报错、根元数据不可读时报错。
pub fn workbuddy_trace_files_with_errors(root: &Path) -> (Vec<PathBuf>, Vec<String>) {
    let tdir = workbuddy_traces_root(root);
    let mut files: Vec<PathBuf> = Vec::new();
    let mut errors = Vec::new();
    match std::fs::metadata(&tdir) {
        Ok(metadata) if metadata.is_dir() => {
            match std::fs::read_dir(&tdir) {
                Ok(entries) => {
                    for entry in entries {
                        let entry = match entry {
                            Ok(entry) => entry,
                            Err(error) => {
                                errors.push(format!("{}: {error}", tdir.display()));
                                continue;
                            }
                        };
                        let path = entry.path();
                        if !path.is_dir() { continue; }
                        match std::fs::read_dir(&path) {
                            Ok(inner) => {
                                for f in inner {
                                    match f {
                                        Ok(f) => {
                                            let fp = f.path();
                                            let name = fp.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                                            if fp.is_file() && name.starts_with("trace_") && name.ends_with(".json") {
                                                files.push(fp);
                                            }
                                        }
                                        Err(error) => {
                                            errors.push(format!("{}: {error}", path.display()));
                                        }
                                    }
                                }
                            }
                            Err(error) => errors.push(format!("{}: {error}", path.display())),
                        }
                    }
                }
                Err(error) => errors.push(format!("{}: {error}", tdir.display())),
            }
        }
        Ok(_) => {}
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            errors.push(format!("{}: {error}", tdir.display()));
        }
        Err(_) => {}
    }
    files.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
    (files, errors)
}

/// shape 面：读一个 trace 文件。Err 的三种文案与 `TracesRead::degraded` 的原因串
/// 同一词表（`unreadable` / `malformed: not JSON` / `malformed: no …`）——全量读
/// 把它们收进 degraded，逐文件同步把它们当该文件的错误上呈并留待下次重试。
pub fn read_workbuddy_trace_file(path: &Path) -> Result<TraceSummary, String> {
    let bytes = std::fs::read(path).map_err(|_| "unreadable".to_string())?;
    let doc: Value =
        serde_json::from_slice(&bytes).map_err(|_| "malformed: not JSON".to_string())?;
    shape_trace(path, &doc)
}

/// 读 `<root>/traces/*/trace_*.json` 全部文件。目录缺失 → 空结果（存在性探测，
/// 与 audit-log 同款）。= `workbuddy_trace_files` ∘ `read_workbuddy_trace_file`。
pub fn read_workbuddy_traces(root: &Path) -> TracesRead {
    let mut out = TracesRead::default();
    for path in workbuddy_trace_files(root) {
        out.files += 1;
        match read_workbuddy_trace_file(&path) {
            Ok(tr) => match tr.session_id.clone() {
                Some(sid) => out.by_session.entry(sid).or_default().push(tr),
                None => out.unattributed.push(tr),
            },
            Err(reason) => out.degraded.push((path, reason)),
        }
    }
    out
}

/// 一个 span 的提取结果 → 纯层（`sessions/evidence.rs`，wasm 可链，不能依赖本
/// feature-gated 模块的类型）消费的 JSON 形状。键名 = 字段名；`usages` 是对象数组。
/// Python 镜像的 dict 天然就是这个形状。
pub fn span_summary_json(s: &SpanSummary) -> Value {
    serde_json::json!({
        "span_id": s.span_id,
        "parent_id": s.parent_id,
        "name": s.name,
        "kind": s.kind,
        "started_at": s.started_at,
        "ended_at": s.ended_at,
        "duration_ms": s.duration_ms,
        "status": s.status,
        "error": s.error,
        "tool_name": s.tool_name,
        "file_path": s.file_path,
        "usages": s.usages.iter().map(|u| serde_json::json!({
            "model": u.model,
            "prompt_tokens": u.prompt_tokens,
            "cached_tokens": u.cached_tokens,
            "completion_tokens": u.completion_tokens,
            "reasoning_tokens": u.reasoning_tokens,
        })).collect::<Vec<_>>(),
        "agent_name": s.agent_name,
        "decode_failed": s.decode_failed,
    })
}

/// 本会话全部 trace 的 span，按 trace 文件路径序再 span 原序拼接（纯层再按
/// `(started_at, span_id)` 定序）。无 trace → 空。
pub fn session_spans_json(read: &TracesRead, session_id: &str) -> Vec<Value> {
    read.by_session
        .get(session_id)
        .map(|traces| traces.iter().flat_map(|t| t.spans.iter().map(span_summary_json)).collect())
        .unwrap_or_default()
}

/// spec §9E.5 E1 的 `traces_probe` 块（单会话审计 JSON 的末位键）：语料级计数 +
/// 本会话明细。键序是差分契约的一部分。`this_session` 为该会话无 trace 时给
/// 零值对象（不是 null——"读了、确实没有"是真测量；null 留给 traces 目录不存在）。
pub fn traces_probe_json(read: &TracesRead, session_id: &str) -> Value {
    let mine: Vec<&TraceSummary> = read
        .by_session
        .get(session_id)
        .map(|v| v.iter().collect())
        .unwrap_or_default();
    let mut by_type: BTreeMap<String, u64> = BTreeMap::new();
    let mut gen_with_usage = 0_u64;
    let mut edit_write_with_path = 0_u64;
    let mut decode_failures_mine = 0_u64;
    for tr in &mine {
        decode_failures_mine += tr.decode_failures;
        for s in &tr.spans {
            *by_type.entry(s.kind.clone()).or_default() += 1;
            if s.kind == "generation" && !s.usages.is_empty() {
                gen_with_usage += 1;
            }
            if s.kind == "function"
                && matches!(s.tool_name.as_deref(), Some("Edit") | Some("Write"))
                && s.file_path.is_some()
            {
                edit_write_with_path += 1;
            }
        }
    }
    let total_decode_failures: u64 = read
        .by_session
        .values()
        .flatten()
        .chain(read.unattributed.iter())
        .map(|t| t.decode_failures)
        .sum();
    serde_json::json!({
        "files": read.files,
        "attributed_traces": read.by_session.values().map(|v| v.len() as u64).sum::<u64>(),
        "unattributed_traces": read.unattributed.len() as u64,
        "degraded_files": read.degraded.len() as u64,
        "decode_failures": total_decode_failures,
        "this_session": {
            "traces": mine.len() as u64,
            "spans_by_type": by_type,
            "generation_with_usage": gen_with_usage,
            "edit_write_with_path": edit_write_with_path,
            "decode_failures": decode_failures_mine,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R5-F7b 对拍：单趟版本的文件清单与 `workbuddy_trace_files` 逐字节一致
    /// （同全局路径序）、错误集与 `workbuddy_trace_walk_errors` 一致；缺失根
    /// 不报错。
    #[test]
    fn workbuddy_trace_files_with_errors_matches_the_two_walk_functions() {
        let root = std::env::temp_dir().join(format!(
            "av-f7b-wb-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let tdir = workbuddy_traces_root(&root);
        let p1 = tdir.join("pid-1");
        let p2 = tdir.join("pid-2");
        std::fs::create_dir_all(&p1).unwrap();
        std::fs::create_dir_all(&p2).unwrap();
        std::fs::write(p1.join("trace_a.json"), "x").unwrap();
        std::fs::write(p1.join("notes.txt"), "x").unwrap();
        // pid 目录层的一个游离 json 文件（不在 pid 目录里的不收）。
        std::fs::write(tdir.join("trace_stray.json"), "x").unwrap();
        std::fs::write(p2.join("trace_b.json"), "x").unwrap();

        let (files, errors) = workbuddy_trace_files_with_errors(&root);
        assert_eq!(files, workbuddy_trace_files(&root), "单趟清单必须与清单函数逐字节一致");
        assert_eq!(errors, workbuddy_trace_walk_errors(&root), "单趟错误必须与错误函数一致");
        assert_eq!(files.len(), 2, "pid-1 与 pid-2 各一个 trace；txt 与游离 json 过滤");
        // 全局路径字符串序：pid-1 在 pid-2 前。
        assert!(files[0].to_string_lossy().contains("pid-1"));

        // 缺失根：清单空、零错误。
        let missing = root.join("no-such-root");
        let (files, errors) = workbuddy_trace_files_with_errors(&missing);
        assert!(files.is_empty());
        assert!(errors.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
