//! 权威 revision 的可执行守卫（`docs/RUNTIME_INVALIDATION_AND_READ_BACKPRESSURE_SPEC.md`
//! §1.3 / §10 / 验收 9.17）。
//!
//! revision 只在 `commit_advancing_revision` 里推进，而它只能配对
//! `begin_immediate` 使用。任何绕过 helper 的手写 `BEGIN IMMEDIATE` 都是「写了
//! 业务状态却不推进 revision」的漏洞面——读侧 memo 会静默返回陈旧数据，失效信号
//! 不会发。所以手写站点是**闭集**：schema 迁移（版本戳本身不是业务状态）与一次性
//! 修复扫描。新增站点要么改走 `with_immediate_txn` / `begin_immediate`，要么进
//! 清单并在这里写明为什么它不推进 revision。

use std::fs;
use std::path::{Path, PathBuf};

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

/// 去掉文件尾部的 `#[cfg(test)] mod tests`（本仓库内联测试模块都在文件末尾）。
fn production_source(path: &Path) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    match text.find("\n#[cfg(test)]") {
        Some(idx) => text[..idx].to_string(),
        None => text,
    }
}

fn rs_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(rs_files(&path));
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    out.sort();
    out
}

/// 一行所在的最近 `fn` 名（向上扫描）。
fn enclosing_fn(lines: &[&str], idx: usize) -> String {
    for line in lines[..=idx].iter().rev() {
        let trimmed = line.trim_start();
        let trimmed = trimmed.strip_prefix("pub ").unwrap_or(trimmed);
        let trimmed = trimmed.strip_prefix("pub(crate) ").unwrap_or(trimmed);
        if let Some(rest) = trimmed.strip_prefix("fn ") {
            return rest.split(['(', '<']).next().unwrap_or("").to_string();
        }
    }
    String::from("<module>")
}

#[test]
fn begin_immediate_sites_are_enumerated() {
    // (文件名, 函数名) 闭集。迁移分支与一次性修复不推进 revision 的理由见模块头。
    const ALLOWED: &[(&str, &str)] = &[
        ("authority.rs", "begin_immediate"),   // helper 本体
        ("authority.rs", "ensure_schema"),     // 版本迁移分支（版本戳不是业务状态）
        ("issues.rs", "repair_issue_timestamp_units"), // 一次性时间戳单位修复
    ];
    let data_src = manifest_dir().join("src");
    let runtime_src = manifest_dir().join("../agent-vitals-runtime/src");
    let mut violations = Vec::new();
    let mut seen = Vec::new();
    for file in rs_files(&data_src).into_iter().chain(rs_files(&runtime_src)) {
        let source = production_source(&file);
        let lines: Vec<&str> = source.lines().collect();
        for (idx, line) in lines.iter().enumerate() {
            if !line.contains("BEGIN IMMEDIATE") || line.trim_start().starts_with("//") {
                continue;
            }
            let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let func = enclosing_fn(&lines, idx);
            let key = (name.clone(), func.clone());
            if ALLOWED.iter().any(|(f, g)| *f == name && *g == func) {
                if !seen.contains(&key) {
                    seen.push(key);
                }
            } else {
                violations.push(format!("{}:{} in fn {func}", file.display(), idx + 1));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "hand-rolled BEGIN IMMEDIATE outside the allow-list — route through \
         `AuthorityDb::with_immediate_txn` or `begin_immediate` + `commit_advancing_revision`, \
         or add the site to ALLOWED with a reason:\n{}",
        violations.join("\n")
    );
    // 清单不能长出没人用的项（防清单腐烂）。
    for (f, g) in ALLOWED {
        assert!(
            seen.iter().any(|(sf, sg)| sf == f && sg == g),
            "ALLOWED entry ({f}, {g}) no longer matches any site — remove it"
        );
    }
}

#[test]
fn commit_advancing_revision_is_the_only_writer_of_the_revision_row() {
    let data_src = manifest_dir().join("src");
    let runtime_src = manifest_dir().join("../agent-vitals-runtime/src");
    let mut writers = Vec::new();
    for file in rs_files(&data_src).into_iter().chain(rs_files(&runtime_src)) {
        let source = production_source(&file);
        let lines: Vec<&str> = source.lines().collect();
        for (idx, line) in lines.iter().enumerate() {
            let is_update = line.contains("UPDATE schema_meta") && line.contains("+ 1");
            if is_update {
                writers.push((file.clone(), enclosing_fn(&lines, idx)));
            }
        }
    }
    assert_eq!(
        writers.len(),
        1,
        "the revision counter must have exactly one writer: {writers:?}"
    );
    assert_eq!(writers[0].1, "commit_advancing_revision");
}
