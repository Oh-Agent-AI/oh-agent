//! W3 模块分层守卫（docs/ARCHITECTURE_OPTIMIZATION_GUIDE.md §W3）。
//!
//! 为什么需要它：拆 crate 之前，`agent-vitals-runtime` 的 11 个顶层模块之间有
//! 十几条双向依赖（`billing ↔ query`、`query ↔ mcp`、`sources ↔ ingest`、
//! `events → ingest`……）。其中大半只是为读一个时钟（`sql_sync::now_ms`）、拿一把
//! 锁（`lease`）或一个错误类型（`mcp::ToolError`）就把整个上层模块拖了进来。
//! Cargo 不允许 crate 成环，所以这些边不先解开，W3 的拆分根本无从下手；解开之后
//! 若没有守卫，下一次「顺手 `crate::sql_sync::now_ms()`」就会悄悄把环接回去——
//! 编译器不会报，只有拆 crate 那天才炸。
//!
//! 规则：**生产代码**里的 `crate::X` 只能指向严格更低层的模块。兼容 re-export
//! （`sql_sync::now_ms`、`ingest::lease`、`mcp::session_ref`……）按其**所在**模块
//! 计层——内部代码必须写下沉后的真实路径（`crate::clock::now_ms` 等），旧路径只
//! 留给 crate 外部调用方。`#[cfg(test)]` 之后的代码不在本守卫范围（测试侧依赖
//! 在拆 crate 时按 dev-dependency 单独处理）。

use std::collections::BTreeMap;
use std::path::Path;

/// 层号：只能依赖严格更小的层。
const LAYERS: &[(&str, u8)] = &[
    ("core", 0),
    // pricing 读报告币种等设置（core::fx_settings）来选并列报价，方向是 core → pricing，所以在 core 之上；
    // core 不得反向依赖 pricing（本守卫的 L0 规则会拦）。
    ("pricing", 1),
    ("source_graph", 0),
    ("envelope", 1),
    ("skills", 1),
    ("events", 1),
    ("sources", 2),
    ("sessions", 2),
    ("query", 3),
    ("billing", 4),
    ("ingest", 5),
    ("trust", 5),
    ("mcp", 6),
];

fn layer_of(module: &str) -> Option<u8> {
    LAYERS.iter().find(|(m, _)| *m == module).map(|(_, l)| *l)
}

/// lib.rs 的扁平 re-export（`pub use billing::budget;`）→ 真实顶层模块。
fn flat_aliases(lib_rs: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in lib_rs.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("pub use ") else { continue };
        let Some(rest) = rest.strip_suffix(';') else { continue };
        let mut parts = rest.split("::");
        if let (Some(top), Some(leaf), None) = (parts.next(), parts.next(), parts.next()) {
            // `pub use agent_vitals_runtime_core::envelope;` 是跨 crate 的原样
            // re-export，不是别名——名字本身就是那个模块。
            if top.starts_with("agent_vitals") {
                continue;
            }
            out.insert(leaf.to_string(), top.to_string());
        }
    }
    out
}

/// 去掉 `//` 行注释，再剔除每个 `#[cfg(test)]` 标注的**那一个条目**（到它的
/// `;` 或配平的 `{…}` 为止）。
///
/// 不能「截掉第一个 `#[cfg(test)]` 之后的全部」：`envelope.rs` 的
/// `error_envelope_tests` 在文件中段，后面还有生产代码——第一版守卫就是这么
/// 写的，往 `trust_audit.rs` 测试模块之后注入违规时守卫照样全绿（自测抓到）。
fn production_code(src: &str) -> String {
    let stripped: String = src
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = String::new();
    let mut rest = stripped.as_str();
    while let Some(i) = rest.find("#[cfg(test)]") {
        out.push_str(&rest[..i]);
        let after = &rest[i + "#[cfg(test)]".len()..];
        let brace = after.find('{');
        let semi = after.find(';');
        let skip_to = match (brace, semi) {
            (Some(b), Some(s)) if s < b => s + 1,
            (Some(b), _) => {
                let mut depth = 0usize;
                let mut end = after.len();
                for (j, c) in after[b..].char_indices() {
                    match c {
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                end = b + j + 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                end
            }
            (None, Some(s)) => s + 1,
            (None, None) => after.len(),
        };
        rest = &after[skip_to..];
    }
    out.push_str(rest);
    out
}

fn ident_at(s: &str) -> &str {
    let end = s
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(s.len());
    &s[..end]
}

/// 代码里所有 `crate::X` 与 `crate::{X, Y::…}` 的首段标识符。
fn crate_refs(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = code;
    while let Some(i) = rest.find("crate::") {
        rest = &rest[i + "crate::".len()..];
        if let Some(group) = rest.strip_prefix('{') {
            let close = group.find('}').unwrap_or(group.len());
            for item in group[..close].split(',') {
                let id = ident_at(item.trim());
                if !id.is_empty() {
                    out.push(id.to_string());
                }
            }
        } else {
            let id = ident_at(rest);
            if !id.is_empty() {
                out.push(id.to_string());
            }
        }
    }
    out
}

/// 本守卫覆盖的 crate：runtime 门面 + W3 拆出的各层 crate。crate 之间的方向由 Cargo
/// 保证；**crate 内部**的层（如 runtime-core 里 L0 `core` 不许依赖 L1 `envelope`，
/// query crate 里 L2 `sources` 不许依赖 L3 `query`）只有这个守卫管。
const RUNTIME_FAMILY: &[&str] = &[
    "agent-vitals-runtime",
    "agent-vitals-runtime-core",
    "agent-vitals-query",
    "agent-vitals-billing",
    "agent-vitals-ingest",
    "agent-vitals-trust",
    "agent-vitals-mcp",
];

fn src_dirs() -> Vec<std::path::PathBuf> {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    RUNTIME_FAMILY
        .iter()
        .map(|name| crates.join(name).join("src"))
        .filter(|dir| dir.join("lib.rs").is_file())
        .collect()
}

#[test]
fn runtime_modules_depend_only_on_lower_layers() {
    for src_dir in src_dirs() {
        check_layering(&src_dir);
    }
}

fn check_layering(src_dir: &Path) {
    let lib_rs = std::fs::read_to_string(src_dir.join("lib.rs")).unwrap();
    let aliases = flat_aliases(&lib_rs);

    let mut violations = Vec::new();
    for entry in walkdir::WalkDir::new(src_dir) {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let rel = path.strip_prefix(src_dir).unwrap();
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str == "lib.rs" || rel_str.ends_with("/tests.rs") {
            continue;
        }
        let top = rel_str.split('/').next().unwrap().trim_end_matches(".rs").to_string();
        let Some(own_layer) = layer_of(&top) else {
            violations.push(format!("{rel_str}: 顶层模块 `{top}` 未登记层号（加进 LAYERS）"));
            continue;
        };
        let code = production_code(&std::fs::read_to_string(path).unwrap());
        for id in crate_refs(&code) {
            let target = aliases.get(&id).cloned().unwrap_or(id.clone());
            if target == top {
                continue;
            }
            let Some(target_layer) = layer_of(&target) else { continue };
            if target_layer >= own_layer {
                violations.push(format!(
                    "{rel_str}: `{top}`(L{own_layer}) → `crate::{id}` 落在 `{target}`(L{target_layer})"
                ));
            }
        }
    }
    violations.sort();
    violations.dedup();
    assert!(
        violations.is_empty(),
        "runtime 模块分层被破坏（只能依赖严格更低层；时钟请用 `crate::clock::now_ms`，\
         锁用 `crate::lease`，工具协议类型用 `crate::envelope`）：\n  {}",
        violations.join("\n  ")
    );
}

#[test]
fn layer_table_covers_every_top_level_module() {
    for src_dir in src_dirs() {
        let lib_rs = std::fs::read_to_string(src_dir.join("lib.rs")).unwrap();
        assert_modules_registered(&lib_rs);
    }
}

fn assert_modules_registered(lib_rs: &str) {
    for line in lib_rs.lines() {
        let Some(rest) = line.trim().strip_prefix("pub mod ") else { continue };
        let module = rest.trim_end_matches(';').trim();
        assert!(layer_of(module).is_some(), "lib.rs 新增顶层模块 `{module}` 未登记层号");
    }
}
