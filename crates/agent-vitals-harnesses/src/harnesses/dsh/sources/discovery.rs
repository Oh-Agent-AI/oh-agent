//! DSH 会话文件发现与 workspace 索引（W3 从 runtime `sessions/discovery.rs` 拆来）。
//!
//! 只做「给定 DSH_HOME 目录」的纯枚举与解析：`session.jsonl` / `.zstd` 两种形式、
//! sessions 根 + `storages/workspace.json` 的存在性报告、workspace 索引
//! （会话 → 工作区路径 / 标题 + 归档集）。DSH_HOME 的解析（env → `~/.dsh`）与
//! legacy `discover()`（读 takeover 账本去重）留在 runtime——本 crate 不读环境变量。
//!
//! 真实机上的会话几乎全是 `session.jsonl.zstd`，两种形式都浮出；解压交给
//! `read_session_text`。

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// 枚举 `$DSH_HOME/sessions/**/session.jsonl[.zstd]` —— R2a population 的目录扫描。
/// 全局按路径字符串排序（确定性）；sessions 根缺席 → 空（存在性探测，绝不报错）。
/// 只收 `session.jsonl` / `session.jsonl.zstd` 两个文件名，其它文件不掺进会话集。
pub fn dsh_session_files(dsh_home: &Path) -> Vec<PathBuf> {
    let root = dsh_home.join("sessions");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut files: Vec<PathBuf> = walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            let n = e.file_name().to_string_lossy();
            n == "session.jsonl" || n == "session.jsonl.zstd"
        })
        .map(|e| e.into_path())
        .collect();
    files.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
    files
}
/// Return traversal failures for the DSH sessions root. A missing root is
/// normal absence; an unreadable root/subdirectory is a source failure.
pub fn dsh_session_walk_errors(dsh_home: &Path) -> Vec<String> {
    let root = dsh_home.join("sessions");
    let mut errors = Vec::new();
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
    errors
}
/// 单趟版本（REFRESH_STORM R5-F7b 推广）：一次 walk 同时产出文件清单与遍历
/// 错误。`dsh_session_files` 与 `dsh_session_walk_errors` 各自走一遍
/// `<DSH_HOME>/sessions`；清单与错误来自同一次遍历时天然一致。排序/过滤语义
/// 与 `dsh_session_files` 逐字节一致（全局路径字符串序、只收 session.jsonl /
/// session.jsonl.zstd 两个文件名、follow_links(false)）；缺失根不报错、根
/// 元数据不可读时报错——错误语义与 `dsh_session_walk_errors` 一致。
pub fn dsh_session_files_with_errors(dsh_home: &Path) -> (Vec<PathBuf>, Vec<String>) {
    let (mut files, errors) = crate::sources::walk_util::walk_files_with_errors(
        &dsh_home.join("sessions"),
        |e| {
            let n = e.file_name().to_string_lossy();
            n == "session.jsonl" || n == "session.jsonl.zstd"
        },
    );
    crate::sources::walk_util::sort_by_path_string(&mut files);
    (files, errors)
}
/// DSH 会话根集合的存在性报告 —— 与 `codex_session_roots_report` 同级：
/// 存在性 + 计数 + 字节量，**绝不报错**（根缺席 → `exists=false` 零填充，不猜
/// 路径、不把缺席当 0 条真数据）。
///
/// 两个根：`sessions/`（会话日志，计数 = `session.jsonl[.zstd]` 文件数）与
/// `storages/`（索引层；R2a 消费其中 `workspace.json` 一个文件，故只数它——
/// 不把 379MB `session_projcache.json` 拖进报告，那只是可删 cache，§4.5）。
///
/// 键序是字节一致的一部分，不能重排：根对象 kind → path → exists →
/// file_count → total_bytes；外层 harness → roots。
pub fn dsh_session_roots_report(dsh_home: &Path) -> Value {
    let roots = [
        ("sessions", dsh_home.join("sessions"), dsh_session_files(dsh_home)),
        (
            "storages",
            dsh_home.join("storages"),
            {
                let wp = dsh_home.join("storages").join("workspace.json");
                if wp.is_file() {
                    vec![wp]
                } else {
                    Vec::new()
                }
            },
        ),
    ];
    let mut out = Vec::new();
    for (kind, root, files) in roots {
        // exists = 根目录存在（与 codex 同义：目录级存在性探测）。
        let exists = root.is_dir();
        let mut total_bytes = 0u64;
        for f in &files {
            // 与 codex `_file_bytes` 同款：文件在枚举与 stat 之间消失时按 0 字节
            // 计，不 abort 整个报告；文件仍算进 file_count。
            total_bytes += std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
        }
        out.push(json!({
            "kind": kind,
            "path": root.to_string_lossy().to_string(),
            "exists": exists,
            "file_count": files.len(),
            "total_bytes": total_bytes,
        }));
    }
    json!({ "harness": "dsh", "roots": out })
}
/// workspace.json 折出的会话索引：session id → (工作区路径, 标题)，外加归档集。
#[derive(Debug, Clone, Default)]
pub struct WorkspaceIndex {
    /// session id（= 会话日志头 `id`，`session-<uuid>`）→ (workspace.path, workspace.title)
    pub by_session: HashMap<String, (String, String)>,
    /// 归档 session id 集合（`global.archivedSessionIds`）。
    pub archived: HashSet<String>,
}
/// 解析 `storages/workspace.json` → 会话索引。**只读、宽容、绝不报错**：
/// JSON 解析失败 / `tables.workspaces` 缺位 / 单条 workspace 字段缺 string 值
/// → 该部分跳过，返回能折多少折多少。缺席整个索引 = 空索引（标题是加分项，
/// 不是准入项，同 `parse_session_index` 对 session_index.jsonl 的纪律）。
///
/// 真实形状（实测 2026-08-30）：`tables.workspaces.{wsid}` = `{path, title,
/// sessionIds[], createdAt, updatedAt}`；归档在 `global.archivedSessionIds[]`
/// （**全局**，不在单条 workspace 里）。
pub fn parse_workspace_index(text: &str) -> WorkspaceIndex {
    let mut idx = WorkspaceIndex::default();
    let Ok(doc) = serde_json::from_str::<Value>(text) else {
        return idx;
    };
    // 归档集（全局）。
    if let Some(archived) = doc.get("global").and_then(|g| g.get("archivedSessionIds"))
        .and_then(|v| v.as_array())
    {
        for id in archived {
            if let Some(s) = id.as_str() {
                idx.archived.insert(s.to_string());
            }
        }
    }
    let Some(workspaces) = doc.pointer("/tables/workspaces").and_then(|v| v.as_object())
    else {
        return idx;
    };
    for ws in workspaces.values() {
        let (Some(path), Some(title)) = (
            ws.get("path").and_then(|v| v.as_str()),
            ws.get("title").and_then(|v| v.as_str()),
        ) else {
            continue; // 单条 workspace 畸形 → 跳过，不 abort 整个索引
        };
        let Some(ids) = ws.get("sessionIds").and_then(|v| v.as_array()) else {
            continue;
        };
        for sid in ids {
            if let Some(s) = sid.as_str() {
                idx.by_session
                    .insert(s.to_string(), (path.to_string(), title.to_string()));
            }
        }
    }
    idx
}
/// 读 `$DSH_HOME/storages/workspace.json` → 会话索引。文件缺失/不可读 → 空索引
/// （存在性探测，绝不报错——标题是加分项，不是准入项）。
pub fn read_workspace_index(dsh_home: &Path) -> WorkspaceIndex {
    let wp = dsh_home.join("storages").join("workspace.json");
    let bytes = match std::fs::read(&wp) {
        Ok(b) => b,
        Err(_) => return WorkspaceIndex::default(),
    };
    let text = String::from_utf8_lossy(&bytes);
    parse_workspace_index(&text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    /// 每个用例一个 pid 键根的独立子目录 —— 换进程重跑不捡上一轮的残留
    /// （`disc-{SEQ}` 每进程从 0 重数，`temp_dir()` 又不清，残留 session.jsonl
    /// 会把 bare_jsonl 数多）。用后 remove_dir_all 收掉。
    fn tmp_case() -> PathBuf {
        let t = std::env::temp_dir().join(format!(
            "av-discovery-{}-case-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&t);
        t
    }

    /// 建一个 `fake` 根：`fake/sessions/<workspace>/<agentId>/session.jsonl`。
    /// 返回 (fake_root, av_home)：DSH_HOME 指 fake_root，AGENT_VITALS_HOME 指
    /// av_home（空 takeover 状态，ledger 里没折过任何 key）。
    fn fake_root(t: &Path) -> (PathBuf, PathBuf) {
        let fake = t.join(format!("dsh-{}", SEQ.fetch_add(1, Ordering::Relaxed)));
        let av = t.join(format!("av-{}", SEQ.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&fake).unwrap();
        std::fs::create_dir_all(&av).unwrap();
        (fake, av)
    }

    #[test]
    fn dsh_session_files_enumerates_both_forms_sorted() {
        let t = tmp_case();
        let (fake, _av) = fake_root(&t);
        // 两个 workspace 目录 + 两个会话目录；同时放裸 jsonl 与 zstd，外加一个
        // 不相关的 junk 文件（不该进会话集）。
        let s1 = fake.join("sessions").join("--proj-a--").join("session-uuid-1");
        let s2 = fake.join("sessions").join("--proj-b--").join("session-uuid-2");
        let s3 = fake.join("sessions").join("--proj-a--").join("session-uuid-3");
        for (dir, name) in [
            (&s1, "session.jsonl"),
            (&s2, "session.jsonl.zstd"),
            (&s3, "session.jsonl"),
        ] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(name), "{}").unwrap();
        }
        std::fs::create_dir_all(&s1).unwrap();
        std::fs::write(s1.join("junk.txt"), "x").unwrap();

        let files = dsh_session_files(&fake);
        assert_eq!(files.len(), 3);
        // 全局按路径字符串排序（确定性）。
        let names: Vec<String> = files
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }
    #[test]
    fn dsh_session_files_absent_root_is_empty() {
        let t = tmp_case();
        let (fake, _av) = fake_root(&t);
        assert_eq!(dsh_session_files(&fake), Vec::<PathBuf>::new());
        assert_eq!(dsh_session_files(&fake.join("no-sessions-root")), Vec::<PathBuf>::new());
    }
    /// R5-F7b 对拍：单趟版本的文件清单与 `dsh_session_files` 逐字节一致（同
    /// 全局路径序）、错误集与 `dsh_session_walk_errors` 一致；缺失根不报错。
    #[test]
    fn dsh_session_files_with_errors_matches_the_two_walk_functions() {
        let t = tmp_case();
        let (fake, _av) = fake_root(&t);
        let s1 = fake.join("sessions").join("--proj-a--").join("session-uuid-1");
        let s2 = fake.join("sessions").join("--proj-b--").join("session-uuid-2");
        std::fs::create_dir_all(&s1).unwrap();
        std::fs::create_dir_all(&s2).unwrap();
        std::fs::write(s1.join("session.jsonl"), "{}").unwrap();
        std::fs::write(s1.join("junk.txt"), "x").unwrap();
        // 嵌套深一层（walk 深度语义）+ zstd 形式也要收。
        let deep = s2.join("nested").join("session-uuid-3");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("session.jsonl.zstd"), b"\x28\xb5\x2f\xfd").unwrap();

        let (files, errors) = dsh_session_files_with_errors(&fake);
        assert_eq!(files, dsh_session_files(&fake), "单趟清单必须与清单函数逐字节一致");
        assert_eq!(errors, dsh_session_walk_errors(&fake), "单趟错误必须与错误函数一致");
        assert_eq!(files.len(), 2, "裸 jsonl + zstd 各一；junk 过滤");
        // 全局路径字符串序：--proj-a-- 在 --proj-b-- 前。
        assert!(files[0].to_string_lossy().contains("--proj-a--"));

        // 缺失根：清单空、零错误。
        let (files, errors) = dsh_session_files_with_errors(&fake.join("no-such-root"));
        assert!(files.is_empty());
        assert!(errors.is_empty());
        let _ = std::fs::remove_dir_all(&t);
    }
    #[test]
    fn dsh_session_roots_report_shape_and_bytes() {
        let t = tmp_case();
        let (fake, _av) = fake_root(&t);
        let s1 = fake.join("sessions").join("--proj--").join("session-uuid-1");
        std::fs::create_dir_all(&s1).unwrap();
        std::fs::write(
            s1.join("session.jsonl"),
            "{\"type\":\"session\",\"id\":\"session-uuid-1\"}\n{}\n",
        )
        .unwrap();
        // storages/workspace.json
        let storages = fake.join("storages");
        std::fs::create_dir_all(&storages).unwrap();
        std::fs::write(
            storages.join("workspace.json"),
            r#"{"tables":{"workspaces":{}}}"#,
        )
        .unwrap();

        let v = dsh_session_roots_report(&fake);
        assert_eq!(v["harness"], json!("dsh"));
        let roots = v["roots"].as_array().unwrap();
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0]["kind"], json!("sessions"));
        assert_eq!(roots[0]["exists"], json!(true));
        assert_eq!(roots[0]["file_count"], json!(1));
        assert!(roots[0]["total_bytes"].as_u64().unwrap() > 0);
        assert_eq!(roots[1]["kind"], json!("storages"));
        assert_eq!(roots[1]["file_count"], json!(1));
    }
    #[test]
    fn dsh_session_roots_report_absent_roots_zero_fill() {
        let t = tmp_case();
        let (fake, _av) = fake_root(&t);
        let v = dsh_session_roots_report(&fake);
        let roots = v["roots"].as_array().unwrap();
        // 根缺席 → exists=false 零填充，不报错。
        assert_eq!(roots[0]["exists"], json!(false));
        assert_eq!(roots[0]["file_count"], json!(0));
        assert_eq!(roots[0]["total_bytes"], json!(0));
        assert_eq!(roots[1]["exists"], json!(false));
    }
    #[test]
    fn parse_workspace_index_full_shape() {
        let text = r#"{
          "unit": {"name": "dsh-storage", "version": 1},
          "global": {"initialized": true, "archivedSessionIds": ["session-old-1", "session-old-2"]},
          "tables": {"workspaces": {
            "w1": {"path": "/Users/a/proj", "title": "proj",
                    "sessionIds": ["session-aaa", "session-bbb"]},
            "w2": {"path": "/Users/a/other", "title": "other",
                    "sessionIds": ["session-ccc"]}
          }}
        }"#;
        let idx = parse_workspace_index(text);
        assert_eq!(idx.by_session.len(), 3);
        assert_eq!(idx.by_session.get("session-aaa").unwrap().0, "/Users/a/proj");
        assert_eq!(idx.by_session.get("session-aaa").unwrap().1, "proj");
        assert_eq!(idx.by_session.get("session-ccc").unwrap().1, "other");
        assert!(idx.archived.contains("session-old-1"));
        assert!(!idx.archived.contains("session-aaa"));
    }
    #[test]
    fn parse_workspace_index_malformed_is_empty_not_error() {
        // 标题是加分项不是准入项：整份 JSON 坏了 → 空索引，绝不 abort。
        let idx = parse_workspace_index("not json at all");
        assert!(idx.by_session.is_empty());
        assert!(idx.archived.is_empty());
        let idx = parse_workspace_index("{\"tables\":{\"workspaces\":\"not an object\"}}");
        assert!(idx.by_session.is_empty());
    }
    #[test]
    fn parse_workspace_index_skips_single_bad_workspace_row() {
        // 一条 workspace 缺 title / sessionIds → 跳过它，别条照常进。
        let text = r#"{
          "global": {"archivedSessionIds": []},
          "tables": {"workspaces": {
            "bad": {"path": "/x", "sessionIds": ["session-bad"]},
            "good": {"path": "/y", "title": "good", "sessionIds": ["session-good"]}
          }}
        }"#;
        let idx = parse_workspace_index(text);
        assert_eq!(idx.by_session.len(), 1);
        assert!(idx.by_session.contains_key("session-good"));
        assert!(!idx.by_session.contains_key("session-bad"));
    }
    #[test]
    fn read_workspace_index_missing_is_empty() {
        let t = tmp_case();
        let (fake, _av) = fake_root(&t);
        let idx = read_workspace_index(&fake);
        assert!(idx.by_session.is_empty());
    }
}
