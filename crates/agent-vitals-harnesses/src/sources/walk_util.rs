//! F7b 单趟 walk 的共享骨架（REFRESH_STORM R5 推广）：一次遍历同时产出
//! 「过滤后的文件清单」与「遍历错误」。执行环境专属部分（哪个根、什么过滤、
//! 什么排序）由调用方声明——harness-specific I/O 留在适配器、通用骨架在此
//! 共享的分层即此。
//!
//! **为什么在 harnesses 而不是 domain/vitals-core**：这是文件系统 I/O——domain
//! 按章程零 I/O（依赖预算测试强制），core 的依赖边界同样不放 walkdir；
//! runtime→harnesses 是既有允许方向，dsh 的发现面（住在 runtime）照样复用。

use std::path::{Path, PathBuf};

/// 单根单趟。`keep` 只声明「这个文件要不要」——`is_file` 判断内置；
/// **不跟符号链接**（WalkDir 默认；dsh 原实现显式声明的即此默认）。
/// 错误语义与各执行环境原 `*_walk_errors` 一致：遍历错误逐条带路径上报；
/// 根元数据非 NotFound 错误上报；缺失根/非目录静默。
/// **不排序**——排序策略（全局 lossy 字符串序等）属执行环境契约，由调用方施加。
pub fn walk_files_with_errors(
    root: &Path,
    keep: impl Fn(&walkdir::DirEntry) -> bool,
) -> (Vec<PathBuf>, Vec<String>) {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    match std::fs::metadata(root) {
        Ok(metadata) if metadata.is_dir() => {
            for entry in walkdir::WalkDir::new(root).into_iter() {
                match entry {
                    Ok(e) => {
                        if e.file_type().is_file() && keep(&e) {
                            files.push(e.into_path());
                        }
                    }
                    Err(error) => {
                        let path = error.path().unwrap_or(root);
                        errors.push(format!("{}: {error}", path.display()));
                    }
                }
            }
        }
        Ok(_) => {}
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            errors.push(format!("{}: {error}", root.display()));
        }
        Err(_) => {}
    }
    (files, errors)
}

/// 执行环境清单的既定排序：全局路径 lossy 字符串序（codex/claude 的折叠序契约，
/// Python 侧 `sorted(..., key=str)` 锁步）。
pub fn sort_by_path_string(files: &mut [PathBuf]) {
    files.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
}
