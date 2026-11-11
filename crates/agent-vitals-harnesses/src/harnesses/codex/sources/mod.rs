//! Codex 会话日志（rollout JSONL）读取器 —— P4 适配器的 "locate → shape →
//! extract" 三段（五段式流水线 locate → shape → extract → derive → coverage，
//! 见 `docs/RUNTIME_EVIDENCE_CONTRACT.md` §4.2）。"derive → coverage" 两段在
//! core 的 `crates/agent-vitals-harnesses/src/harnesses/codex/sessions/evidence.rs`，I/O 不进去。
//!
//! Codex 的 rollout 落盘在 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`
//! 或 Zstandard 压缩的 `rollout-*.jsonl.zst`，每行一个 `{type, timestamp, payload}`
//! 包络。**命名冲突
//! 警告**：`src/codex.rs`（和 `scripts/agent_vitals/adapters/codex.py`）是安装时
//! 的运行时探针适配器，跟这里完全无关；本模块是会话日志审计，叫 `codex_session`，
//! 不要互相复用。
//!
//! **没有版本闸。** DSH 的 `SESSION_FORMAT_VERSION` 是 adapter-private（`dsh.rs`
//! 里那个 `EXPECTED_SESSION_FORMAT_VERSION`），§14.4 明确说 Codex 格式无版本、
//! 靠兼容 shim 演进——照搬版本闸会把「新 cli 多写了一种记录类型」误判成「日志
//! 损坏」。这里只靠存在性探测降级：空文件 → `missing-header`，读到非 JSON 行 →
//! `non-json`，文件不可读 → `file-missing`。**绝不假装读到了 0 条**（同
//! `dsh.rs` 的降级铁律——报 0 会直接伪造出假的覆盖结论）。
//!
//! 未知的记录类型**原样保留进 `items`**，不在这里判「损坏」也不丢——认识不认识
//! 是 core `codex_evidence::derive_coverage` 的职责（它把未知类型记进
//! `attempts`，§14.4 "skipped and recorded in attempts, never treated as
//! corruption"）。解析器只负责「把 JSONL 逐行读进来 + 抽出 provenance 字段」。
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use agent_vitals_domain::util::split_lines;

// v0.8 Phase E7.6：Skill 配置 I/O（app-server 子进程探测）与本文件的会话 I/O
// 是两条独立证据线，分文件放。
pub mod skills;
pub mod route_evidence;
// v1.0.0-beta.1 自动归因 A5：账户级证据（只读 auth.json 的 auth_mode）。
pub mod account;
/// W3：Codex 计价 + 人读渲染（原 runtime `sessions/codex_cost.rs`）。
pub mod cost;
/// W3：Codex 单会话审计组合（原 runtime `sessions/codex_session_audit.rs`）。
pub mod session_audit;
/// W3：会话级行为 findings 评估（注册表 `sources::session_harnesses` 的 Codex 条目）。
pub mod findings;

// v0.9 Stage A emitter 归位（R4 §5.2）：UsageFact emitter 从二进制
// apps/cli/src/agent/ 迁来——读文件 → 读内存，仍属 I/O 层。
pub mod usage_fact;
pub mod workflow;

fn empty_result() -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("items".to_string(), Value::Null);
    map.insert("session_id".to_string(), Value::Null);
    map.insert("history_mode".to_string(), Value::Null);
    map.insert("cli_version".to_string(), Value::Null);
    map.insert("model".to_string(), Value::Null);
    map.insert("workspace_roots".to_string(), Value::Array(Vec::new()));
    map.insert("degraded".to_string(), Value::Bool(false));
    map
}

fn degraded(reason: &str) -> Value {
    let mut map = empty_result();
    map.insert("degraded".to_string(), json!(reason));
    // 降级时 items 必须保持 null，**绝不改成空数组**——空数组会被上层当成
    // 「读全了但确实 0 条」，那是编造。
    map.insert("items".to_string(), Value::Null);
    Value::Object(map)
}

/// 纯解析：把整个 rollout JSONL 文本折成 provenance 字段 + 原始条目数组。
/// 与 Python `scripts/agent_vitals/adapters/codex_session.py::parse_codex_session_log`
/// 逐字节对齐。
///
/// 抽取的 provenance 字段（实测 field path，见 `codex-corpus-facts` 记忆与
/// `fixtures/codex/README.md`）：
///
/// | 输出字段 | 来源 | 说明 |
/// |---|---|---|
/// | `session_id` | `session_meta.payload.session_id`（缺时退回 `.id`） | §14.4 back-fill |
/// | `history_mode` | `session_meta.payload.history_mode` | 形状探针，只作 provenance |
/// | `cli_version` | `session_meta.payload.cli_version` | 同上 |
/// | `model` | `turn_context.payload.model`（**最新**一条） | session_meta.payload.model 实测恒为 null |
/// | `workspace_roots` | `turn_context.payload.workspace_roots`（**最新**非空一条） | 与 dsh 的 last_catalog_wins 同一「当前状态」惯例 |
///
/// 其余所有行（event_msg / response_item / world_state / compacted / …）原样收进
/// `items`，解析器不挑拣。
pub fn parse_codex_session_log(text: &str) -> Value {
    let lines = split_lines(text);
    if lines.is_empty() {
        return degraded("missing-header");
    }

    let mut items: Vec<Value> = Vec::new();
    let mut session_id: Option<String> = None;
    let mut history_mode: Option<String> = None;
    let mut cli_version: Option<String> = None;
    let mut model: Option<String> = None;
    let mut workspace_roots: Vec<String> = Vec::new();

    for line in &lines {
        if line.trim().is_empty() {
            // 空白行不是事件（真实 writer 只在文件尾补一个换行），跳过。
            continue;
        }
        let item: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return degraded("non-json"),
        };
        let ttype = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match ttype {
            "session_meta" => {
                if let Some(p) = item.get("payload").and_then(|v| v.as_object()) {
                    session_id = p
                        .get("session_id")
                        .or_else(|| p.get("id"))
                        .and_then(|v| v.as_str())
                        .map(str::to_owned);
                    history_mode = p.get("history_mode").and_then(|v| v.as_str()).map(str::to_owned);
                    cli_version = p.get("cli_version").and_then(|v| v.as_str()).map(str::to_owned);
                }
            }
            "turn_context" => {
                if let Some(p) = item.get("payload").and_then(|v| v.as_object()) {
                    // 模型：取最新一条 turn_context 的非空值。真实语料里
                    // session_meta.payload.model 恒为 null，model 只在
                    // turn_context 里（实测 `gpt-5.6-sol`）。
                    if let Some(m) = p.get("model").and_then(|v| v.as_str()) {
                        model = Some(m.to_string());
                    }
                    // workspace_roots：最新一条非空列表覆盖成「当前」。
                    let names: Vec<String> = p
                        .get("workspace_roots")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter().filter_map(|r| r.as_str()).map(str::to_owned).collect()
                        })
                        .unwrap_or_default();
                    if !names.is_empty() {
                        workspace_roots = names;
                    }
                }
            }
            _ => {} // 其它记录类型只进 items，provenance 不从这里取
        }
        items.push(item);
    }

    let mut map = empty_result();
    map.insert("items".to_string(), json!(items));
    map.insert("session_id".to_string(), json!(session_id));
    map.insert("history_mode".to_string(), json!(history_mode));
    map.insert("cli_version".to_string(), json!(cli_version));
    map.insert("model".to_string(), json!(model));
    map.insert("workspace_roots".to_string(), json!(workspace_roots));
    Value::Object(map)
}

/// 读文件（非 UTF-8 字节替换为 U+FFFD，与 Python `errors="replace"` 对齐），再交给
/// 纯解析。文件缺失/不可读时降级为 `file-missing`。
pub fn read_codex_session_log(path: &Path) -> Value {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return degraded("file-missing"),
    };
    let decoded;
    let bytes = if path.to_string_lossy().ends_with(".jsonl.zst") {
        decoded = match crate::harnesses::dsh::sources::decode_zstd_multi_frame(&bytes) {
            Some(out) => out,
            None => return degraded("zstd-decode-error"),
        };
        decoded.as_slice()
    } else {
        bytes.as_slice()
    };
    let text = String::from_utf8_lossy(bytes).into_owned();
    parse_codex_session_log(&text)
}

/// 列出 Codex 会话根集合的确定性状形：每个根是否存在、rollout 数量、字节总量。
/// 与 Python `scripts/agent_vitals/adapters/codex_session.py::codex_session_roots_report`
/// 逐字节对齐。
///
/// **存在性探测，绝不报错**：根目录不存在 → `exists=false` 且 file_count/
/// total_bytes 归零，不猜路径、也不把缺席当成 0 条真数据。`home` 由调用方从
/// `HOME`/`USERPROFILE` 解析（测试用 `isolated_home_env` 注入同一路径）。
///
/// 键序是字节一致的一部分，不能重排：根对象 kind → path → exists →
/// file_count → total_bytes；外层 harness → roots。
pub fn codex_session_roots_report(home: &Path) -> Value {
    let entries: [(&str, &str); 2] = [("live", "sessions"), ("archived", "archived_sessions")];
    let mut roots = Vec::new();
    for (kind, rel) in entries {
        let root = home.join(".codex").join(rel);
        let exists = root.is_dir();
        let mut file_count = 0usize;
        let mut total_bytes = 0u64;
        if exists {
            let mut files: Vec<std::path::PathBuf> = walkdir::WalkDir::new(&root)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file())
                .filter(|e| is_codex_session_log_name(&e.file_name().to_string_lossy()))
                .map(|e| e.into_path())
                .collect();
            files.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
            file_count = files.len();
            for f in &files {
                // 与 Python `_file_bytes` 同款：文件在枚举与 stat 之间消失时按
                // 0 字节计，不 abort 整个报告；文件仍算进 file_count。
                total_bytes += std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
            }
        }
        roots.push(json!({
            "kind": kind,
            "path": root.to_string_lossy().to_string(),
            "exists": exists,
            "file_count": file_count,
            "total_bytes": total_bytes,
        }));
    }
    json!({ "harness": "codex", "roots": roots })
}

fn is_codex_session_log_name(name: &str) -> bool {
    name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")
}

fn is_codex_rollout_name(name: &str) -> bool {
    name.starts_with("rollout-") && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
}

/// `codex-cost` 的输入枚举：两个会话根下所有未压缩及 Zstandard 压缩 rollout
/// （live + archived）。
///
/// 与 `codex_session_roots_report` 同一套根集合，但那是存在性报告（统计数量/
/// 字节），这里给出**实际要折叠的文件**。**全局按路径字符串排序**（不是按根
/// 分开排）：`archived_sessions/…` 按字母序排在 `sessions/…` 前——Python 侧
/// `codex_rollout_files` 用 `sorted(..., key=str)` 也是全局排，两侧一致，折叠的
/// merge 顺序（决定模型/速度首现序）才不会漂移。缺失的根 → 跳过（存在性探测，
/// 绝不报错）。
pub fn codex_rollout_files(home: &Path) -> Vec<PathBuf> {
    let entries: [(&str, &str); 2] = [("live", "sessions"), ("archived", "archived_sessions")];
    let mut files: Vec<PathBuf> = Vec::new();
    for (_kind, rel) in entries {
        let root = home.join(".codex").join(rel);
        if root.is_dir() {
            files.extend(
                walkdir::WalkDir::new(&root)
                    .into_iter()
                    .filter_map(Result::ok)
                    .filter(|e| e.file_type().is_file())
                    .filter(|e| {
                        is_codex_rollout_name(&e.file_name().to_string_lossy())
                    })
                    .map(|e| e.into_path()),
            );
        }
    }
    files.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
    files
}

/// Return traversal failures for both Codex rollout roots. Missing roots remain
/// normal absence; permission and other I/O failures are explicit.
pub fn codex_rollout_walk_errors(home: &Path) -> Vec<String> {
    let entries: [(&str, &str); 2] = [("live", "sessions"), ("archived", "archived_sessions")];
    let mut errors = Vec::new();
    for (_kind, rel) in entries {
        let root = home.join(".codex").join(rel);
        match std::fs::metadata(&root) {
            Ok(metadata) if metadata.is_dir() => {
                for entry in walkdir::WalkDir::new(&root).into_iter() {
                    if let Err(error) = entry {
                        let path = error.path().unwrap_or(&root);
                        errors.push(format!("{}: {error}", path.display()));
                    }
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                errors.push(format!("{}: {error}", root.display()));
            }
            Err(_) => {}
        }
    }
    errors
}

/// 单趟版本（REFRESH_STORM R5-F7b）：一次 walk 同时产出文件清单与遍历错误。
/// `codex_rollout_files` 与 `codex_rollout_walk_errors` 各自走一遍 `~/.codex`
/// （真机 2.96 万文件 × 2 趟/轻 tick）；清单与错误来自同一次遍历时天然一致
/// （不会出现「清单轮看到了、错误轮没看到」的中间态）。排序/过滤语义与
/// `codex_rollout_files` 逐字节一致（全局路径字符串序、rollout-*.jsonl[.zst]）；
/// 缺失根不报错、根元数据不可读时报错——错误语义与
/// `codex_rollout_walk_errors` 一致。
pub fn codex_rollout_files_with_errors(home: &Path) -> (Vec<PathBuf>, Vec<String>) {
    let entries: [(&str, &str); 2] = [("live", "sessions"), ("archived", "archived_sessions")];
    let mut files: Vec<PathBuf> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for (_kind, rel) in entries {
        let (mut part, part_errors) = crate::sources::walk_util::walk_files_with_errors(
            &home.join(".codex").join(rel),
            |e| {
                is_codex_rollout_name(&e.file_name().to_string_lossy())
            },
        );
        files.append(&mut part);
        errors.extend(part_errors);
    }
    crate::sources::walk_util::sort_by_path_string(&mut files);
    (files, errors)
}

/// 纯解析：把 `session_index.jsonl` 折成 `{id: thread_name}` 映射。与 Python
/// `scripts/agent_vitals/adapters/codex_session.py::parse_session_index` 对齐。
///
/// 索引的 `id` 键 = **逻辑 `payload.session_id`**（不是 rollout 文件名 UUID
/// `payload.id`）——实测本机 51 份 rollout：`payload.session_id` 命中索引
/// 47/51，`payload.id` 只命中 21/51（恰是「主会话 id==session_id」那 21 份）。
/// `parse_codex_session_log` 抽出的 `session_id` 字段就是标题 join 键。
///
/// **只读、单行失败跳过、升级失败不报错**（cc-trace 的 `title_index.rs` 同款）：
/// malformed / 缺 id 或 thread_name / 非 string / trim 后为空的标题行直接跳过，
/// **绝不 abort 整个索引**。同一 id 可有多条（rename 后带 `(2)` 后缀），
/// 后写覆盖前写（last-write-wins）——append-only，后写=更新。
pub fn parse_session_index(text: &str) -> HashMap<String, String> {
    let mut index = HashMap::new();
    for line in split_lines(text) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let (Some(id), Some(title)) = (
            entry.get("id").and_then(|v| v.as_str()),
            entry.get("thread_name").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let title = title.trim();
        if title.is_empty() {
            continue;
        }
        index.insert(id.to_string(), title.to_string());
    }
    index
}

/// 读 `home/.codex/session_index.jsonl`，交给纯解析。文件缺失/不可读 → 空映射
/// （**存在性探测，绝不报错**——标题是加分项，不是准入项，同
/// `codex_session_roots_report` 的缺席铁律）。`home` 由 main.rs 从
/// `HOME`/`USERPROFILE` 解析传入（Python 侧 `read_session_index(home=None)`
/// 默认 `Path.home()`，同一路径）。
pub fn read_session_index(home: &Path) -> HashMap<String, String> {
    let bytes = match std::fs::read(home.join(".codex").join("session_index.jsonl")) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    parse_session_index(&text)
}

/// `codex-evidence` 子命令直接收路径参数（与 behavior/duration-audit 同款），不
/// 走环境变量注入——`AGENT_VITALS_CODEX_SESSION_LOG` 的机制（DSH 那个
/// `AGENT_VITALS_DSH_SESSION_LOG` 的对称物）等未来真有「按执行环境自动发现会话日志」
/// 的扫描入口时再加，现在加就是死代码。
#[cfg(test)]
mod tests {
    use super::*;

    /// R5-F7b 对拍：单趟版本的文件清单与 `codex_rollout_files` 逐字节一致
    /// （同全局路径序）、错误集与 `codex_rollout_walk_errors` 一致；缺失根
    /// 不报错。
    #[test]
    fn codex_rollout_files_with_errors_matches_the_two_walk_functions() {
        let home = std::env::temp_dir().join(format!(
            "av-f7b-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for rel in ["sessions", "archived_sessions"] {
            std::fs::create_dir_all(home.join(".codex").join(rel)).unwrap();
        }
        // 两个根各放一个合法 rollout + 一个非 rollout 文件（应被过滤）+ 一个
        // 嵌套目录里的合法文件（walk 深度语义）。
        for (rel, id) in [("sessions", "aaa"), ("archived_sessions", "zzz")] {
            let root = home.join(".codex").join(rel);
            std::fs::write(root.join(format!("rollout-{id}.jsonl")), "x").unwrap();
            std::fs::write(root.join("notes.txt"), "x").unwrap();
            let nested = root.join("sub");
            std::fs::create_dir_all(&nested).unwrap();
            std::fs::write(nested.join("rollout-nested.jsonl"), "x").unwrap();
        }
        let (files, errors) = codex_rollout_files_with_errors(&home);
        assert_eq!(files, codex_rollout_files(&home), "单趟清单必须与清单函数逐字节一致");
        assert_eq!(errors, codex_rollout_walk_errors(&home), "单趟错误必须与错误函数一致");
        assert_eq!(files.len(), 4, "两个 rollout + 一个嵌套 × 两个根；非 rollout 过滤");
        // 全局路径序：archived 在 sessions 前。
        assert!(files[0].to_string_lossy().contains("archived_sessions"));

        // 缺失根：清单空、零错误。
        let missing = home.join("no-such-home");
        let (files, errors) = codex_rollout_files_with_errors(&missing);
        assert!(files.is_empty());
        assert!(errors.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    fn meta_line(id: &str, mode: &str, cli: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-07-25T11:19:35.404Z","type":"session_meta","payload":{{"session_id":"{id}","id":"{id}","history_mode":"{mode}","cli_version":"{cli}","cwd":"/repo"}}}}"#
        )
    }

    fn turn_context_line(model: &str, roots: &[&str]) -> String {
        let roots_json = serde_json::to_string(&roots).unwrap();
        format!(
            r#"{{"timestamp":"2026-07-25T11:20:00Z","type":"turn_context","payload":{{"turn_id":"t1","cwd":"/repo","workspace_roots":{roots_json},"model":"{model}","approval_policy":"on-request"}}}}"#
        )
    }

    #[test]
    fn parses_provenance_and_keeps_all_items() {
        let text = format!(
            "{}\n{}\n{}\n{}\n",
            meta_line("s1", "legacy", "0.146.0-alpha.3.1"),
            turn_context_line("gpt-5.6-sol", &["/repo"]),
            r#"{"timestamp":"2026-07-25T11:21:00Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            r#"{"timestamp":"2026-07-25T11:21:01Z","type":"future_record_type","payload":{"n":1}}"#,
        );
        let v = parse_codex_session_log(&text);
        assert_eq!(v["session_id"], json!("s1"));
        assert_eq!(v["history_mode"], json!("legacy"));
        assert_eq!(v["cli_version"], json!("0.146.0-alpha.3.1"));
        assert_eq!(v["model"], json!("gpt-5.6-sol"));
        assert_eq!(v["workspace_roots"], json!(["/repo"]));
        // 未知记录类型原样保留，解析器不判损坏（core 的 derive_coverage 才负责
        // 把不认识的分型记进 attempts）。
        assert_eq!(v["items"].as_array().unwrap().len(), 4);
        assert_eq!(v["items"][3]["type"], json!("future_record_type"));
        assert_eq!(v["degraded"], json!(false));
    }

    #[test]
    fn empty_text_is_missing_header() {
        assert_eq!(parse_codex_session_log("")["degraded"], json!("missing-header"));
        assert_eq!(parse_codex_session_log("")["items"], Value::Null);
    }

    #[test]
    fn non_json_first_line_degrades() {
        assert_eq!(parse_codex_session_log("not json\n")["degraded"], json!("non-json"));
    }

    #[test]
    fn non_json_mid_file_degrades_not_zero() {
        // 读到一半遇到垃圾行：必须报 degraded，不能拿着半截结果说「读了 N 条」。
        let text = format!(
            "{}\n{}\ngarbage line\n",
            meta_line("s1", "legacy", "0.146"),
            r#"{"timestamp":"2026-07-25T11:21:00Z","type":"event_msg","payload":{"type":"task_started"}}"#,
        );
        let v = parse_codex_session_log(&text);
        assert_eq!(v["degraded"], json!("non-json"));
        assert_eq!(v["items"], Value::Null);
    }

    #[test]
    fn no_session_meta_degrades_not_but_leaves_provenance_null() {
        // §14.4：只靠存在性探测降级。有行、可解析、但没有 session_meta 不算损坏
        // ——provenance 如实给 null（诚实缺失，不编造），items 照常收。
        let text = r#"{"timestamp":"2026-07-25T11:21:00Z","type":"event_msg","payload":{"type":"task_started"}}
"#;
        let v = parse_codex_session_log(text);
        assert_eq!(v["degraded"], json!(false));
        assert_eq!(v["session_id"], Value::Null);
        assert_eq!(v["history_mode"], Value::Null);
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn model_and_workspace_roots_take_latest_turn_context() {
        // 「当前状态」惯例：最新一条非空 turn_context 覆盖（与 dsh 的
        // last_catalog_wins 同款）。模型中途切换后，报告里是最后的那个。
        let text = format!(
            "{}\n{}\n{}\n",
            meta_line("s1", "paginated", "0.149.0-alpha.4"),
            turn_context_line("gpt-5.6-sol", &["/old"]),
            turn_context_line("gpt-5.6-pro", &["/repo", "/data"]),
        );
        let v = parse_codex_session_log(&text);
        assert_eq!(v["model"], json!("gpt-5.6-pro"));
        assert_eq!(v["workspace_roots"], json!(["/repo", "/data"]));
        assert_eq!(v["history_mode"], json!("paginated"));
    }

    #[test]
    fn session_id_backfills_from_id_when_session_id_missing() {
        let text = r#"{"type":"session_meta","payload":{"id":"uuid-1","history_mode":"legacy","cli_version":"0.146"}}
"#;
        let v = parse_codex_session_log(text);
        assert_eq!(v["session_id"], json!("uuid-1"));
    }

    #[test]
    fn missing_file_degrades() {
        let v = read_codex_session_log(Path::new("/nonexistent-xyz/rollout.jsonl"));
        assert_eq!(v["degraded"], json!("file-missing"));
        assert_eq!(v["items"], Value::Null);
    }

    #[test]
    fn compressed_rollout_is_discovered_and_decoded() {
        let home = temp_home("compressed");
        let sessions = home.join(".codex").join("sessions").join("2026").join("10");
        std::fs::create_dir_all(&sessions).unwrap();
        let path = sessions.join("rollout-compressed.jsonl.zst");
        let text = format!("{}\n", meta_line("compressed-session", "legacy", "1.0"));
        let mut compressed = Vec::new();
        ruzstd::encoding::compress(
            text.as_bytes(),
            &mut compressed,
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        std::fs::write(&path, &compressed).unwrap();

        assert_eq!(codex_rollout_files(&home), vec![path.clone()]);
        let report = codex_session_roots_report(&home);
        assert_eq!(report["roots"][0]["file_count"], json!(1));
        assert_eq!(report["roots"][0]["total_bytes"], json!(compressed.len()));
        let parsed = read_codex_session_log(&path);
        assert_eq!(parsed["degraded"], json!(false));
        assert_eq!(parsed["session_id"], json!("compressed-session"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn malformed_compressed_rollout_degrades_explicitly() {
        let home = temp_home("bad-compressed");
        let root = home.join(".codex").join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-bad.jsonl.zst");
        std::fs::write(&path, b"not zstandard").unwrap();
        let parsed = read_codex_session_log(&path);
        assert_eq!(parsed["degraded"], json!("zstd-decode-error"));
        assert_eq!(parsed["items"], Value::Null);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 每个测试独占一个临时目录，互不污染；用进程 id + 用例名保证唯一。
    fn temp_home(tag: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "sv-codex-roots-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&base);
        base
    }

    #[test]
    fn roots_report_enumerates_live_and_archived() {
        let home = temp_home("both");
        let live = home.join(".codex").join("sessions").join("2026").join("08");
        let arch = home.join(".codex").join("archived_sessions");
        std::fs::create_dir_all(&live).unwrap();
        std::fs::create_dir_all(&arch).unwrap();
        // 日期分层：rglob 递归必须穿过多层子目录（live 里就是 YYYY/MM/DD）。
        std::fs::write(live.join("rollout-a.jsonl"), "{}").unwrap();
        std::fs::write(live.join("rollout-b.jsonl"), "{}").unwrap();
        std::fs::write(arch.join("rollout-c.jsonl"), "abc").unwrap();

        let v = codex_session_roots_report(&home);
        assert_eq!(v["harness"], json!("codex"));
        let roots = v["roots"].as_array().unwrap();
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0]["kind"], json!("live"));
        assert_eq!(roots[0]["exists"], json!(true));
        assert_eq!(roots[0]["file_count"], json!(2));
        assert_eq!(roots[0]["total_bytes"], json!(4)); // "{}" × 2
        assert_eq!(roots[1]["kind"], json!("archived"));
        assert_eq!(roots[1]["exists"], json!(true));
        assert_eq!(roots[1]["file_count"], json!(1));
        assert_eq!(roots[1]["total_bytes"], json!(3)); // "abc"
        // 键序（字节一致的一部分）：kind → path → exists → file_count →
        // total_bytes。
        assert_eq!(roots[0].as_object().unwrap().keys().collect::<Vec<_>>(),
                   vec!["kind", "path", "exists", "file_count", "total_bytes"]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn roots_report_absent_archive_zero_fills() {
        // archived_sessions 缺席：存在性探测，绝不报错、不猜路径、也不把缺席
        // 当成 0 条真数据（同 parse 的降级铁律）。
        let home = temp_home("absent");
        let live = home.join(".codex").join("sessions");
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join("rollout-a.jsonl"), "{}").unwrap();

        let v = codex_session_roots_report(&home);
        let roots = v["roots"].as_array().unwrap();
        assert_eq!(roots[0]["exists"], json!(true));
        assert_eq!(roots[0]["file_count"], json!(1));
        assert_eq!(roots[1]["kind"], json!("archived"));
        assert_eq!(roots[1]["exists"], json!(false));
        assert_eq!(roots[1]["file_count"], json!(0));
        assert_eq!(roots[1]["total_bytes"], json!(0));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn roots_report_empty_live_is_exists_not_error() {
        // live 根存在但没有任何 rollout：exists=true + 0 文件，不是错误。
        let home = temp_home("empty");
        std::fs::create_dir_all(home.join(".codex").join("sessions")).unwrap();
        let v = codex_session_roots_report(&home);
        let roots = v["roots"].as_array().unwrap();
        assert_eq!(roots[0]["exists"], json!(true));
        assert_eq!(roots[0]["file_count"], json!(0));
        assert_eq!(roots[0]["total_bytes"], json!(0));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn roots_report_ignores_non_jsonl_files() {
        // 根下的非 .jsonl 文件（.json、.txt 等）不计数。注意 `*.jsonl` 是后缀
        // 匹配，session_index.jsonl 这种也会被算进去——但标题索引在 sessions/
        // 之外，不在任何根里，所以不会误计（标题索引由
        // `parse_session_index`/`read_session_index` 单独读，不是根的一部分）。
        let home = temp_home("nonrollout");
        let live = home.join(".codex").join("sessions");
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join("rollout-a.jsonl"), "{}").unwrap();
        std::fs::write(live.join("meta.json"), "{}").unwrap();
        std::fs::write(live.join("notes.txt"), "x").unwrap();

        let v = codex_session_roots_report(&home);
        let roots = v["roots"].as_array().unwrap();
        assert_eq!(roots[0]["file_count"], json!(1));
        assert_eq!(roots[0]["total_bytes"], json!(2));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_index_maps_id_to_trimmed_title() {
        // 基础映射：id → 标题，标题 trim 掉首尾空白（cc-trace clean_title 同款）。
        let text = "{\"id\":\"a\",\"thread_name\":\"  修复登录 模块  \"}\n\
                    {\"id\":\"b\",\"thread_name\":\"分析项目\"}\n";
        let index = parse_session_index(text);
        assert_eq!(index.get("a").map(String::as_str), Some("修复登录 模块"));
        assert_eq!(index.get("b").map(String::as_str), Some("分析项目"));
        assert_eq!(index.len(), 2);
    }

    #[test]
    fn session_index_last_write_wins_for_duplicate_id() {
        // 同一 id 可有多条（rename 后带 `(2)` 后缀）；append-only，后写=更新。
        let text = "{\"id\":\"a\",\"thread_name\":\"旧标题\"}\n\
                    {\"id\":\"a\",\"thread_name\":\"新标题 (2)\"}\n";
        let index = parse_session_index(text);
        assert_eq!(index.get("a").map(String::as_str), Some("新标题 (2)"));
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn session_index_skips_bad_lines_never_aborts() {
        // 单行失败跳过、升级失败不报错（cc-trace title_index 同款）：malformed /
        // 非 dict / 缺 id / 非 string / trim 后为空的标题行都不能 abort 整个索引。
        let text = "not json\n\
                    \"just a string\"\n\
                    {\"thread_name\":\"没有 id\"}\n\
                    {\"id\":42,\"thread_name\":\"id 非 string\"}\n\
                    {\"id\":\"c\",\"thread_name\":42}\n\
                    {\"id\":\"d\",\"thread_name\":\"   \"}\n\
                    {\"id\":\"e\",\"thread_name\":\"有效\"}\n";
        let index = parse_session_index(text);
        assert_eq!(index.get("e").map(String::as_str), Some("有效"));
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn read_session_index_missing_file_returns_empty_map() {
        // 索引缺失是常态（本机曾不存在）——存在性探测，绝不报错。
        let home = temp_home("noindex");
        let index = read_session_index(&home);
        assert!(index.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn read_session_index_reads_file_under_dot_codex() {
        let home = temp_home("readindex");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(
            home.join(".codex").join("session_index.jsonl"),
            "{\"id\":\"x\",\"thread_name\":\"标题\"}\n",
        )
        .unwrap();
        let index = read_session_index(&home);
        assert_eq!(index.get("x").map(String::as_str), Some("标题"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
