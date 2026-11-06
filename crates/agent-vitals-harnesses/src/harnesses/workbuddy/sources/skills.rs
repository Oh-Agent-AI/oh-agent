//! WorkBuddy 的内置 marketplace 解析。
//!
//! 与其他执行环境不同，WorkBuddy 的「装了哪些 skill」不在某个目录里直接可见 ——
//! 它由 `marketplace.json` 这份**清单**选出顶层包，再到 cache 里取实际版本。
//! 所以这里的证据链是「清单 → 包 → 版本目录」，不是「扫一个目录」。
//!
//! 另一处特殊：WorkBuddy 按 welcomeMode（work / design / code）过滤注入，
//! 同一个 skill 在不同模式下未必进上下文。模式只能从本地日志里读到，
//! **读不到时必须报 unknown 而不是假设某个模式**（不变量 12）。

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::skill_discovery::SourceMeta;
use agent_vitals_domain::util::norm;

fn read_lossy(p: &Path) -> Option<String> {
    let bytes = std::fs::read(p).ok()?;
    Some(agent_vitals_domain::util::bytes_to_lossy_normalized(&bytes))
}

/// 从 `marketplace.json` 解析出顶层安装的 Skill 包及其根目录。
///
/// 路径片段是否可安全拼接。
///
/// 只接受**单一层级**的普通名字：不含分隔符、不是 `.` / `..`、不为空。
///
/// 白名单而非黑名单 —— 黑名单会漏掉平台特有的写法（Windows 的反斜杠、
/// 前导盘符等），而 `Path::join` 遇到绝对路径还会**整段替换**。
fn is_safe_path_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains('\0')
        && Path::new(s).components().count() == 1
}

/// 拼接后的路径是否仍在允许的根之下。符号链接也算数，故比较 canonicalize
/// 之后的结果；取不到就退回前缀比较，**绝不放行**。
fn within(candidate: &Path, root: &Path) -> bool {
    match (candidate.canonicalize(), root.canonicalize()) {
        (Ok(c), Ok(r)) => c.starts_with(r),
        _ => candidate.starts_with(root),
    }
}

/// 发现结果：根目录 + 附带证据。
///
/// `.orphaned_at` 标记过的包**是证据不是判决** —— 契约明确它不等于
/// 「已禁用」（builtin 种子包常年带着这个标记）。采集出来报给人看，
/// 但不参与任何加载判定。曾经这个值算出来后直接丢掉，等于没采集。
pub struct BuiltinDiscovery {
    pub roots: Vec<(String, SourceMeta)>,
    pub orphaned_packages: Vec<String>,
}

/// 从 `marketplace.json` 解析出顶层安装的 Skill 包及其根目录。
///
/// 三条防线：
///
/// 1. `source` 必须解析在 marketplace 目录**之内**。
/// 2. `package` / `version` 同样是清单里的数据，必须先过 `is_safe_path_segment`
///    再拼接，拼完再用 `within` 复核一次边界。
/// 3. 优先用 cache 里的版本目录，且要求它**内容可用**（有 SKILL.md 或
///    `skills/`），否则回退 marketplace 源，并把区别记进 root_kind。
pub fn discover_builtin(home: &str) -> BuiltinDiscovery {
    let marketplace = PathBuf::from(home).join(".workbuddy/plugins/marketplaces/workbuddy-builtin");
    let manifest = marketplace.join(".codebuddy-plugin/marketplace.json");
    let data: Value = match read_lossy(&manifest).and_then(|t| serde_json::from_str(&t).ok()) {
        Some(v) => v,
        None => return BuiltinDiscovery { roots: Vec::new(), orphaned_packages: Vec::new() },
    };
    let base = marketplace
        .canonicalize()
        .unwrap_or_else(|_| marketplace.clone());
    let cache = PathBuf::from(home).join(".workbuddy/plugins/cache/workbuddy-builtin");

    let mut roots = Vec::new();
    let mut orphaned: Vec<String> = Vec::new();
    // manifest 可能把同一个包声明多次（写错、或同包多版本）。取**第一条**、
    // 忽略其余：否则同一个 skill 会按不同版本被收录多次，而清单本身没有
    // 表达「哪一份才算数」的机制 —— 由扫描器凭顺序猜是唯一可解释的做法。
    let mut seen_packages: Vec<String> = Vec::new();
    let plugins = match data.get("plugins").and_then(|v| v.as_array()) {
        Some(p) => p,
        None => return BuiltinDiscovery { roots, orphaned_packages: orphaned },
    };
    for plugin in plugins {
        let category = plugin.get("category").and_then(|v| v.as_str()).unwrap_or("");
        // `skill` 是顶层安装的 Skill 包；`builtin-plugin` 是随客户端打包的插件，
        // **它也会带 skill**（腾讯文档/PPTX/Docx、微信支付、表格代理等）。
        //
        // 曾经只取 `skill`，把 builtin-plugin 整包排除，于是 WorkBuddy 运行时
        // 能调用的 18 个 skill 一个都没进报告。规则是拿运行时的 available
        // skills 名单与磁盘逐条对照推出来的，不是猜的。
        if category != "skill" && category != "builtin-plugin" {
            continue;
        }
        let source = match plugin.get("source").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => continue,
        };
        let manifest_source = marketplace.join(source);
        let manifest_source = manifest_source
            .canonicalize()
            .unwrap_or_else(|_| manifest_source.clone());
        // 越界的 source 直接丢弃：清单是数据，不该决定扫描器去哪儿看
        if !manifest_source.starts_with(&base) {
            continue;
        }
        let package = plugin.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let version = plugin.get("version").and_then(|v| v.as_str()).unwrap_or("");
        // **package 与 version 同样是清单里的数据，不能直接拼进路径。**
        //
        // 我们对 `source` 做了边界检查，却让这两个字段直连 join —— 实测
        // `"name": "../../../../secret"` 能让扫描器读到 marketplace 之外的
        // 任意目录。`join` 遇到绝对路径还会**整段替换**，`"version": "/etc"`
        // 直接跳出缓存根。
        //
        // 一个审计供应链风险的工具，不该信任一份数据文件里的路径片段。
        if !is_safe_path_segment(package) || !is_safe_path_segment(version) {
            continue;
        }
        if seen_packages.iter().any(|p| p == package) {
            continue;
        }
        seen_packages.push(package.to_string());
        // 版本必须钉 manifest 的那个：cache 里会同时留着旧版本
        // （实测 weixinpay 1.5.111 与 1.6.107 并存），否则会数两遍。
        let cached = cache.join(package).join(version);
        // 双保险：拼完再核一次边界。上面的字符检查挡住已知形态，这一条
        // 挡住没想到的形态（符号链接、平台特有的路径语义）。
        if !within(&cached, &cache) {
            continue;
        }

        if cached.join(".orphaned_at").is_file() && !orphaned.iter().any(|p| p == package) {
            orphaned.push(package.to_string());
        }
        let meta = |kind: &str, only_direct: bool| SourceMeta {
            root_kind: Some(kind.to_string()),
            workbuddy_package: Some(package.to_string()),
            workbuddy_legacy_name: manifest_source
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string()),
            workbuddy_only_direct: only_direct,
            ..SourceMeta::default()
        };

        if category == "skill" {
            let use_cache = cached.join("SKILL.md").is_file();
            let candidate = if use_cache { cached.clone() } else { manifest_source.clone() };
            if candidate.is_dir() {
                roots.push((
                    norm(&candidate),
                    meta(
                        if use_cache {
                            "builtin-skill-cache"
                        } else {
                            "builtin-skill-marketplace-fallback"
                        },
                        false,
                    ),
                ));
            }
            continue;
        }

        // builtin-plugin：**正向白名单**，只有两处算顶层 skill ——
        //   <包>/<版本>/SKILL.md          包自身（tencent-docx 就是这种）
        //   <包>/<版本>/skills/*/SKILL.md  它带的 skill
        // 其余（tencent-docx 的 experts/ 等）是包内部的角色定义，运行时也不
        // 把它们当 skill 列出。**用白名单而不是排除 experts/**：只有一个包有
        // experts 目录，据此立全局规则是从单一样本推规则。
        // 缓存「存在」不等于「可用」。category=skill 那条要求 cached/SKILL.md
        // 存在才用缓存，这里曾经只判 is_dir —— 缓存目录存在但内容不完整时
        // 不会回退 marketplace source，扫出来的是一个空壳。两处口径统一。
        let cache_usable = cached.is_dir()
            && (cached.join("SKILL.md").is_file() || cached.join("skills").is_dir());
        let pkg_root = if cache_usable { cached.clone() } else { manifest_source.clone() };
        if !pkg_root.is_dir() {
            continue;
        }
        if pkg_root.join("SKILL.md").is_file() {
            roots.push((norm(&pkg_root), meta("builtin-plugin-package", true)));
        }
        let skills_dir = pkg_root.join("skills");
        if skills_dir.is_dir() {
            let mut children: Vec<PathBuf> = std::fs::read_dir(&skills_dir)
                .map(|it| it.filter_map(|e| e.ok()).map(|e| e.path()).collect())
                .unwrap_or_default();
            children.sort_by_key(|p| norm(p));
            for child in children {
                if child.join("SKILL.md").is_file() {
                    roots.push((norm(&child), meta("builtin-plugin-skill", false)));
                }
            }
        }
    }
    BuiltinDiscovery { roots, orphaned_packages: orphaned }
}

/// 从本地日志里读最近一次会话的 welcomeMode。
///
/// 这是个**取证式**读取，不是配置读取：WorkBuddy 没有公开接口告诉我们
/// 当前模式。读不到就返回 None，调用方必须把它当「未知」处理 ——
/// 假设一个模式会让整批 skill 的 loaded 判定跟着错。
pub fn read_welcome_mode(home: &str) -> Option<String> {
    let logs = PathBuf::from(home).join(".workbuddy/logs");
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = walk_logs(&logs)
        .into_iter()
        .filter_map(|p| {
            let m = std::fs::metadata(&p).ok()?.modified().ok()?;
            Some((m, p))
        })
        .collect();
    files.sort_by_key(|x| std::cmp::Reverse(x.0)); // 最近的在前

    for (_, path) in files.into_iter().take(20) {
        let text = match read_lossy(&path) {
            Some(t) => t,
            None => continue,
        };
        if let Some(mode) = last_mode_in(&text) {
            return Some(mode);
        }
    }
    None
}

fn walk_logs(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.is_dir() {
            out.extend(walk_logs(&p));
        } else if p.extension().and_then(|s| s.to_str()) == Some("log") {
            out.push(p);
        }
    }
    out
}

/// 取文本里**最后一次**出现的模式。日志是追加的，最后一条才是当前状态。
fn last_mode_in(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let mut found: Option<(usize, String)> = None;
    for marker in ["welcomemode=", "welcomemode:", "x-workbuddy-welcome-mode"] {
        let mut from = 0usize;
        while let Some(rel) = lower[from..].find(marker) {
            let at = from + rel + marker.len();
            let rest = &lower[at..];
            let cleaned = rest.trim_start_matches(['\\', '"', ':', '=', ' ']);
            for mode in ["work", "design", "code"] {
                if cleaned.starts_with(mode) {
                    if found.as_ref().map_or(true, |(pos, _)| at > *pos) {
                        found = Some((at, mode.to_string()));
                    }
                    break;
                }
            }
            from = at;
        }
    }
    found.map(|(_, m)| m)
}

/// Ardot 系列的包只在 design 模式下注入。
///
/// 模式未知时**不过滤** —— 宁可多报一个「可能在」，也不要因为读不到日志
/// 就把 skill 从报告里抹掉。
pub fn skill_active(legacy_name: Option<&str>, welcome_mode: Option<&str>) -> bool {
    match (legacy_name, welcome_mode) {
        (Some(name), Some(mode)) if name.starts_with("ardot-") => mode == "design",
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_marketplace_is_empty_not_panic() {
        assert!(discover_builtin("/nonexistent-xyz").roots.is_empty());
        assert_eq!(read_welcome_mode("/nonexistent-xyz"), None);
    }

    #[test]
    fn last_occurrence_wins() {
        // 日志是追加的：最后一条才是当前状态
        let text = "welcomeMode=work\nsome noise\nwelcomeMode=design\n";
        assert_eq!(last_mode_in(text), Some("design".into()));
    }

    #[test]
    fn header_form_is_recognised() {
        let text = r#"{"X-WorkBuddy-Welcome-Mode":"code"}"#;
        assert_eq!(last_mode_in(text), Some("code".into()));
    }

    #[test]
    fn unrelated_text_yields_none() {
        assert_eq!(last_mode_in("welcomeMode=banana"), None);
        assert_eq!(last_mode_in("nothing here"), None);
    }

    #[test]
    fn ardot_only_active_in_design() {
        assert!(!skill_active(Some("ardot-x"), Some("work")));
        assert!(skill_active(Some("ardot-x"), Some("design")));
        assert!(skill_active(Some("other"), Some("work")));
    }

    #[test]
    fn unknown_mode_does_not_filter() {
        // 读不到模式就把 skill 抹掉，等于用「不知道」当「不在」
        assert!(skill_active(Some("ardot-x"), None));
    }

    #[test]
    fn manifest_source_outside_marketplace_is_rejected() {
        let dir = std::env::temp_dir().join(format!("sv-wb-{}", std::process::id()));
        let mp = dir.join(".workbuddy/plugins/marketplaces/workbuddy-builtin");
        std::fs::create_dir_all(mp.join(".codebuddy-plugin")).unwrap();
        std::fs::create_dir_all(dir.join("outside")).unwrap();
        std::fs::write(dir.join("outside/SKILL.md"), "---\nname: x\n---\n").unwrap();
        std::fs::write(
            mp.join(".codebuddy-plugin/marketplace.json"),
            r#"{"plugins":[{"category":"skill","source":"../../../../outside",
                            "name":"p","version":"1"}]}"#,
        )
        .unwrap();
        // 清单是数据，不该决定扫描器去哪儿看
        assert!(discover_builtin(&dir.to_string_lossy()).roots.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
