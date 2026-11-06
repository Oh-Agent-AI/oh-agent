//! 插件执行环境的文件发现（HARNESS_MANIFEST_DSL_SPEC §3.1 discovery 语义）。
//!
//! **I/O 模块**（`sources` feature，路径含 `/sources` 落进
//! `io_tokens_only_appear_under_sources` 守卫）：walkdir 枚举。glob 匹配是
//! 纯函数，语义 fixtures 由 Rust/Python 双侧共用。
//!
//! 语义（spec §3.1）：
//! - roots 展开 `~/`，canonicalize 后按（相对路径字节序）排序去重；
//! - glob 匹配目标是**相对 root 的路径**（`/` 分隔）：`**` 跨目录、`*` 不跨、
//!   `?` 恰一字符；
//! - 默认不跟随符号链接；指向 root 外的 symlink 一律跳过（canonicalize 校验）；
//! - 重复 root / 重叠 glob 命中的同一文件只处理一次（canonical path 去重）。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use super::super::manifest::PluginManifest;

/// 一个被发现且 session id 提取成功的文件。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct DiscoveredFile {
    /// 相对 root 的路径（`/` 分隔，排序键）。
    pub rel_path: String,
    /// 绝对路径（canonicalize 后）。
    pub abs_path: PathBuf,
    /// 文件名经 `session.pattern` 提取的 `(?P<id>)` 捕获。
    pub session_id: String,
}

/// 纯函数：受限 glob 匹配。`path` 必须是 `/` 分隔的相对路径。
/// `**` 匹配零层或多层目录；`*`/`?` 不跨 `/`。
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let pat: Vec<&str> = pattern.split('/').collect();
    let seg: Vec<&str> = path.split('/').collect();
    match_segments(&pat, &seg)
}

fn match_segments(pat: &[&str], seg: &[&str]) -> bool {
    match pat.first() {
        None => seg.is_empty(),
        Some(&"**") => {
            // `**` 吸收零层或多层：从吃掉 0 层开始逐一尝试。
            (0..=seg.len()).any(|skip| match_segments(&pat[1..], &seg[skip..]))
        }
        Some(p0) => match seg.first() {
            Some(s0) if glob_star(p0, s0) => match_segments(&pat[1..], &seg[1..]),
            _ => false,
        },
    }
}

/// 单层匹配：`*` = 零或多字符、`?` = 恰一字符（层内无 `/`）。
pub fn glob_star(pattern: &str, text: &str) -> bool {
    let (Some(pc), Some(tc)) = (pattern.chars().next(), text.chars().next()) else {
        return pattern.is_empty() && text.is_empty();
    };
    match pc {
        '*' => {
            let rest = &pattern[pc.len_utf8()..];
            (0..=text.len()).any(|i| text.is_char_boundary(i) && glob_star(rest, &text[i..]))
        }
        '?' => glob_star(&pattern[pc.len_utf8()..], &text[tc.len_utf8()..]),
        c if c == tc => glob_star(&pattern[pc.len_utf8()..], &text[tc.len_utf8()..]),
        _ => false,
    }
}

/// 展开 `~/` 前缀（生产路径，读进程 HOME）。
pub fn expand_tilde(path: &str) -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        return expand_tilde_home(path, Path::new(&home));
    }
    PathBuf::from(path)
}

/// 测试可注入 HOME 的 `~/` 展开。
pub fn expand_tilde_home(path: &str, home: &Path) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        return home.join(rest);
    }
    if path == "~" {
        return home.to_path_buf();
    }
    PathBuf::from(path)
}

/// 发现结果：成功列表 + 如实计数（文件名不匹配 session pattern 的数量）。
#[derive(Debug, Default)]
pub struct DiscoveryReport {
    pub files: Vec<DiscoveredFile>,
    /// glob 命中、但文件名不匹配 session pattern 的文件数。
    pub session_unmatched: usize,
    /// 被跳过的指向 root 外的 symlink 数。
    pub symlink_outside: usize,
}

/// 主入口：按 manifest 的 roots/include 枚举文件并提取 session id。
/// 顺序确定（相对路径字节序），同一文件只出现一次。
pub fn discover_files(manifest: &PluginManifest, home: &Path) -> Result<DiscoveryReport, String> {
    let mut report = DiscoveryReport::default();
    let mut seen = BTreeSet::new();
    let mut seen_outside = BTreeSet::new();
    let mut seen_unmatched = BTreeSet::new();
    for root_raw in &manifest.roots {
        let root = expand_tilde_home(root_raw, home);
        let root_canon = root
            .canonicalize()
            .map_err(|e| format!("discovery.roots `{root_raw}` 不可访问：{e}"))?;
        for entry in WalkDir::new(&root_canon).follow_links(false) {
            let entry = entry.map_err(|e| format!("walkdir 失败：{e}"))?;
            let abs = entry.path();
            // symlink 解析后判内外：指向 root 外 → 跳过并计数（含 symlink 目录，
            // walkdir follow_links(false) 不下钻，但条目本身要数）。
            let canon = abs.canonicalize().unwrap_or_else(|_| abs.to_path_buf());
            if !canon.starts_with(&root_canon) {
                // 重复 root 会重走同一 symlink 条目：按绝对路径去重计数。
                if entry.file_type().is_symlink() && seen_outside.insert(abs.to_path_buf()) {
                    report.symlink_outside += 1;
                }
                continue;
            }
            if !canon.is_file() {
                continue;
            }
            let rel = abs
                .strip_prefix(&root_canon)
                .unwrap_or(abs)
                .to_string_lossy()
                .replace('\\', "/");
            if !manifest.include.iter().any(|g| glob_match(g, &rel)) {
                continue;
            }
            let Some(file_name) = abs.file_name().map(|n| n.to_string_lossy().to_string()) else {
                continue;
            };
            let Some(caps) = manifest.session_pattern.captures(&file_name) else {
                // 重复 root 会重走同一文件：按绝对路径去重，计数不翻倍。
                if seen_unmatched.insert(abs.to_path_buf()) {
                    report.session_unmatched += 1;
                }
                continue;
            };
            let Some(session_id) = caps.name("id") else {
                if seen_unmatched.insert(abs.to_path_buf()) {
                    report.session_unmatched += 1;
                }
                continue;
            };
            if seen.insert(canon) {
                report.files.push(DiscoveredFile {
                    rel_path: rel,
                    abs_path: abs.to_path_buf(),
                    session_id: session_id.as_str().to_string(),
                });
            }
        }
    }
    report.files.sort();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harnesses::generic::manifest::parse_manifest;
    use serde_json::json;
    use std::fs;
    use std::process;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn tmp_tree(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "av-generic-disc-{}-{}-{}",
            process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed),
            tag
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("rollout/sub")).unwrap();
        dir
    }

    fn manifest_for(roots: &[&str]) -> PluginManifest {
        let v = json!({
            "manifest_version": 1,
            "slug": "zcode",
            "display": { "name": "ZCode" },
            "discovery": { "roots": roots, "include": ["model-io-sess_*.jsonl"] },
            "source": { "format": "jsonl" },
            "session": {
                "from": "filename",
                "pattern": "^model-io-sess_(?P<id>.+)\\.jsonl$"
            },
            "recipe": "request-usage-anthropic-v1",
            "session_title_adapter": "zcode_sqlite_session_v1",
            "event_key": { "paths": ["requestId"] }
        });
        parse_manifest(v).unwrap()
    }

    #[test]
    fn glob_semantics_star_question_and_doublestar() {
        assert!(glob_match("model-io-sess_*.jsonl", "model-io-sess_a.jsonl"));
        assert!(!glob_match("model-io-sess_*.jsonl", "sub/model-io-sess_a.jsonl"),
            "`*` 不跨 `/`");
        assert!(glob_match("**/model-io-sess_*.jsonl", "sub/deep/sess.jsonl".replace("sess.jsonl", "model-io-sess_a.jsonl").as_str()));
        assert!(glob_match("**/model-io-sess_a.jsonl", "model-io-sess_a.jsonl"),
            "`**` 吸收零层");
        assert!(glob_match("sess_?.jsonl", "sess_a.jsonl"));
        assert!(!glob_match("sess_?.jsonl", "sess_ab.jsonl"));
        assert!(!glob_match("*.jsonl", "a/b.jsonl"));
        assert!(glob_match("a/b.jsonl", "a/b.jsonl"));
    }

    #[test]
    fn discovery_is_sorted_deduped_and_counts_unmatched() {
        let home = tmp_tree("home");
        let rollout = home.join("rollout");
        fs::write(rollout.join("model-io-sess_b.jsonl"), "{}").unwrap();
        fs::write(rollout.join("sub/model-io-sess_a.jsonl"), "{}").unwrap();
        fs::write(rollout.join("model-io-sess_subagent_x.jsonl"), "{}").unwrap();
        fs::write(rollout.join("other.jsonl"), "{}").unwrap();
        fs::write(rollout.join("notes.txt"), "x").unwrap();

        let m = manifest_for(&["~/rollout"]);
        let report = discover_files(&m, &home).unwrap();
        let rels: Vec<&str> = report
            .files
            .iter()
            .map(|f| f.rel_path.as_str())
            .collect();
        assert_eq!(
            rels,
            ["model-io-sess_b.jsonl", "model-io-sess_subagent_x.jsonl"],
            "zcode 真实 glob 不跨 `/`，子目录文件不命中；按相对路径字节序"
        );
        assert_eq!(report.session_unmatched, 0);
        assert_eq!(report.symlink_outside, 0);

        // `**` include 跨层：子目录文件命中；other.jsonl glob 命中但文件名
        // 不匹配 pattern → 如实计数。
        let mut m2 = manifest_for(&["~/rollout"]);
        m2.include = vec!["**/*.jsonl".to_string()];
        let report2 = discover_files(&m2, &home).unwrap();
        let rels2: Vec<&str> =
            report2.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(
            rels2,
            ["model-io-sess_b.jsonl", "model-io-sess_subagent_x.jsonl",
             "sub/model-io-sess_a.jsonl"]
        );
        assert_eq!(report2.files[2].session_id, "a");
        assert_eq!(report2.session_unmatched, 1, "other.jsonl glob 命中但无 id");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn duplicate_roots_dedupe_and_outside_symlinks_are_skipped() {
        let home = tmp_tree("dedupe");
        let rollout = home.join("rollout");
        let outside = home.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(rollout.join("model-io-sess_a.jsonl"), "{}").unwrap();
        fs::write(outside.join("model-io-sess_b.jsonl"), "{}").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                outside.join("model-io-sess_b.jsonl"),
                rollout.join("model-io-sess_link.jsonl"),
            )
            .unwrap();
        }

        let m = manifest_for(&["~/rollout", "~/rollout"]);
        let report = discover_files(&m, &home).unwrap();
        assert_eq!(report.files.len(), 1, "重复 root 去重");
        assert_eq!(report.files[0].session_id, "a");
        #[cfg(unix)]
        assert_eq!(report.symlink_outside, 1, "指向 root 外的 symlink 跳过并计数");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_root_is_a_actionable_error() {
        let home = tmp_tree("missing");
        let m = manifest_for(&["~/nope"]);
        let e = discover_files(&m, &home).unwrap_err();
        assert!(e.contains("不可访问"), "{e}");
        let _ = fs::remove_dir_all(&home);
    }
}
