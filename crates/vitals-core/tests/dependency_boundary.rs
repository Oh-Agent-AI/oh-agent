//! §5.2 单向依赖 + §4.1 Domain-free 的边界测试——M0 验收项之一（spec §19）。
//!
//! 三条检查都在源码/清单文本层面做静态断言，不引入 `cargo metadata` 之类的
//! 额外依赖——vitals-core 的依赖预算本来就很小（§5.3），文本扫描对现在这几
//! 个类型文件已经足够可靠。
//!
//! `src-tauri` 是从根 workspace opt-out 的独立 workspace（空 `[workspace]`），
//! 不会出现在这个 crate 自己的 `Cargo.toml` 里，`cargo test`（本 workspace）
//! 因此天然扫不到它的 `Cargo.toml`——第一版这里只写了一句"留给 M2 的兼容桥
//! 测试"就没有真的补上，spec §19 M0 的验收要求"覆盖独立 Tauri workspace"
//! 因此一直没兑现。`src_tauri_does_not_depend_on_vitals_core_directly` 补上
//! 这条：读 `../../src-tauri/Cargo.toml`（相对本 crate 的 `CARGO_MANIFEST_
//! DIR` 向上两级到仓库根），断言它不直接依赖 `vitals-core`——`src-tauri` 现
//! 在唯一允许的依赖路径是 `src-tauri → agent-vitals-domain → vitals-core`
//! （§5.2 单向依赖，跨两层 crate 都要守住，不是只守 `vitals-core` 自己这一
//! 层）。

use std::fs;
use std::path::Path;

/// §5.2：`vitals-core` 禁止依赖的对象——反过来的方向是允许的（binary/wasm
/// 依赖它），这条只测这一个 crate 自己的 `[dependencies]`。
const FORBIDDEN_DEPS: &[&str] =
    &["agent-vitals-domain", "agent-vitals-harnesses", "agent-vitals-wasm", "agent-vitals", "tauri"];

/// §4.1：出现在公开类型/模块名字里通常意味着领域语义泄漏进了通用层。只扫
/// 「名字」，不扫注释/文档字符串——注释里解释"为什么不叫 ToolCalls"完全合
/// 法，不是这条测试要挡的东西。
const FORBIDDEN_TERMS: &[&str] =
    &["codex", "dsh", "agent", "skill", "llm", "toolcall", "token", "budget", "investment", "ibkr"];

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn cargo_toml_does_not_depend_on_forbidden_crates() {
    let manifest = fs::read_to_string(manifest_dir().join("Cargo.toml")).expect("read Cargo.toml");
    for forbidden in FORBIDDEN_DEPS {
        assert!(
            !deps_section_contains(&manifest, forbidden),
            "§5.2 violated: vitals-core/Cargo.toml [dependencies] must not reference `{forbidden}`"
        );
    }
}

/// 判断某个依赖**名**是否作为 TOML key 出现在 `[dependencies]` 段——只看
/// `[dependencies]`，避免误伤 `package.description`/`repository` 里出现的
/// `"agent-vitals"` 字样，也避免注释里解释性的文字（比如"同
/// agent-vitals-domain 的理由"）被误判成一条依赖声明。**必须逐行按 key 精确
/// 匹配，不能整段做子串包含**——`src-tauri` 的检查第一版就是子串匹配，查
/// `"vitals-core"` 时把 `agent-vitals-domain = {...}` 这一行也算命中了（后者
/// 的名字本来就包含前者的字面量），一个真实依赖都没有也会假阳性报违规；
/// 现在按 `=`/`.`（兼容 `name.path = "..."` 这种点号表形式）切出 key、trim
/// 后精确比较。`src-tauri` 的检查复用同一份，不重写一份。
fn deps_section_contains(manifest: &str, name: &str) -> bool {
    let deps_section = manifest
        .split("[dependencies]")
        .nth(1)
        .map(|rest| rest.split("[dev-dependencies]").next().unwrap_or(rest))
        .unwrap_or_default();
    for line in deps_section.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let key = line.split(['=', '.']).next().unwrap_or("").trim();
        if key == name {
            return true;
        }
    }
    false
}

#[test]
fn src_tauri_does_not_depend_on_vitals_core_directly() {
    // `src-tauri` 是独立 workspace（见本文件顶部文档），本 crate 自己的
    // `Cargo.toml` 扫不到它——这里显式跨仓库路径去读它的清单，把 spec §19
    // M0 承诺过、第一版没兑现的这条边界补上。跳过而不是失败：这个 crate
    // 完全可能被单独打包/发布（比如未来真的拆出独立仓库，见 v1.0 §71），
    // 那时旁边不会有 `src-tauri` 目录，"读不到就当没这回事"比"读不到就崩"
    // 更符合"这个 crate 不该依赖仓库内部布局"的精神——只是这条测试本身活在
    // 这个仓库里，跳过要显式打印出来，不能悄悄过。
    let src_tauri_manifest_path = manifest_dir().join("../../apps/desktop/src-tauri/Cargo.toml");
    let Ok(manifest) = fs::read_to_string(&src_tauri_manifest_path) else {
        eprintln!("skipped: {} not found (fine if vitals-core is checked out standalone)", src_tauri_manifest_path.display());
        return;
    };
    assert!(
        !deps_section_contains(&manifest, "vitals-core"),
        "§5.2 violated: src-tauri/Cargo.toml must not depend on vitals-core directly — the only allowed path is src-tauri → agent-vitals-domain → vitals-core"
    );
    // 反过来确认它确实走 agent-vitals-domain——不然上面那条断言测的是个假问题
    // （比如 src-tauri 干脆没接 agent-vitals-domain 了，两条依赖都不存在，
    // "不直接依赖 vitals-core" 会假阳性地通过）。
    assert!(
        deps_section_contains(&manifest, "agent-vitals-domain"),
        "sanity: src-tauri should depend on agent-vitals-domain (the allowed indirection path) — if this changed on purpose, the assertion above needs re-checking too"
    );
}

fn each_src_file(mut visit: impl FnMut(&Path, &str)) {
    let src_dir = manifest_dir().join("src");
    let mut entries: Vec<_> = fs::read_dir(&src_dir).expect("read src/").flatten().collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let content = fs::read_to_string(&path).expect("read src file");
        visit(&path, &content);
    }
}

#[test]
fn module_file_names_are_domain_free() {
    each_src_file(|path, _content| {
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_lowercase();
        for term in FORBIDDEN_TERMS {
            assert!(!name.contains(term), "§4.1 violated: module file name `{name}.rs` contains domain term `{term}`");
        }
    });
}

/// 从一行 `pub struct Foo { ... }` / `pub fn bar(...)` 里取出被声明的标识符
/// 本身，不看它后面跟的字段/参数——足够在 M0 这几个类型文件上工作，逐 token
/// 而不逐 AST 是有意的简化：真正的语义审查在 code review，这里只挡"名字里
/// 直接写了 Codex"这种一眼假的情况。
fn extract_declared_identifier(trimmed: &str) -> Option<&str> {
    let after_keyword = trimmed
        .strip_prefix("pub struct ")
        .or_else(|| trimmed.strip_prefix("pub enum "))
        .or_else(|| trimmed.strip_prefix("pub fn "))
        .or_else(|| trimmed.strip_prefix("pub type "))?;
    let end = after_keyword
        .find(|c: char| c == '(' || c == '<' || c == '{' || c.is_whitespace() || c == ';')
        .unwrap_or(after_keyword.len());
    Some(&after_keyword[..end])
}

#[test]
fn public_item_identifiers_are_domain_free() {
    each_src_file(|path, content| {
        for line in content.lines() {
            let trimmed = line.trim_start();
            let Some(ident) = extract_declared_identifier(trimmed) else {
                continue;
            };
            let lower = ident.to_lowercase();
            for term in FORBIDDEN_TERMS {
                assert!(
                    !lower.contains(term),
                    "§4.1 violated in {}: public item `{ident}` contains domain term `{term}`",
                    path.display()
                );
            }
        }
    });
}

/// §4.1 补强，spec §20 DoD 第一条（"`crates/vitals-core` 不含执行环境或 Agent
/// 专属类型"）打勾之前需要的那一半：`public_item_identifiers_are_domain_free`
/// 只扫声明行本身（`pub struct Foo {` 这一行的 `Foo`），扫不进花括号内部——
/// `pub struct Foo { pub codex_session_id: String }` 会被那条测试放过，因为
/// 违规词出现在字段名，不在类型名。这里从遇到 `pub struct X {` / `pub enum
/// X {` 开始按花括号深度跟踪 body，对 body 内每一行取行首标识符（字段名，
/// 或 enum variant 名），同样过一遍 FORBIDDEN_TERMS。
///
/// 不是真的做 AST 解析——和 `extract_declared_identifier` 同样的简化取舍
/// （见其文档注释）：跳过注释/属性宏行（`//`/`///`/`#[...]`），因为
/// `#[error("... {field} ...")]` 这类属性行里的花括号是 `thiserror` 的插值
/// 占位符，不是标识符声明；深度计数仍然处理这些行（`#[error("{a}...{b}")]`
/// 天然成对，不会打乱计数），只是不从里面提取标识符。单行 tuple
/// struct（`pub struct SignalId(pub String);`）没有 `{`，从不进入 body，
/// 天然被跳过——本来就没有字段名要查，交给 `public_item_identifiers_are_
/// domain_free` 查类型名本身就够了。
fn each_struct_or_enum_body_identifier(content: &str, mut visit: impl FnMut(&str)) {
    let mut in_body = false;
    let mut depth: i32 = 0;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if !in_body {
            let is_decl = line.starts_with("pub struct ")
                || line.starts_with("struct ")
                || line.starts_with("pub enum ")
                || line.starts_with("enum ");
            if is_decl && line.contains('{') {
                depth = line.matches('{').count() as i32 - line.matches('}').count() as i32;
                in_body = depth > 0;
            }
            continue;
        }
        let is_noise = line.is_empty() || line.starts_with("//") || line.starts_with('#');
        // 深度计数不管这行是不是注释/属性——闭合当前 body 的那个 `}` 本身
        // 从来不是注释，但保守起见两者都数，免得漏掉一个把 depth 算错的边角。
        depth += line.matches('{').count() as i32;
        depth -= line.matches('}').count() as i32;
        if depth <= 0 {
            in_body = false;
            continue;
        }
        if is_noise {
            continue;
        }
        let field_line = line.trim_start_matches("pub ");
        let ident: String = field_line.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if !ident.is_empty() {
            visit(&ident);
        }
    }
}

/// 证明上面那条扫描器不是摆设：`struct_field_and_enum_variant_names_are_
/// domain_free` 现在全绿，光看这个结果分不清是"真的没有违规词"还是"扫描器
/// 压根没扫到任何东西"。这里喂一段只存在于这个测试里、从不进 `src/` 的合成
/// 片段——故意混了 struct 字段、tuple 风格 enum variant、普通字段——断言
/// 提取出的标识符列表精确匹配。如果这条测试本身挂了，上面那条测试的"全绿"
/// 就不能信。
#[test]
fn struct_and_enum_body_scanner_actually_finds_identifiers() {
    let synthetic = r#"
#[derive(Clone)]
pub struct Foo {
    pub codex_session_id: String,
    pub normal_field: u16,
}

pub enum Bar {
    Codex,
    Dsh { detail: String },
    Neutral,
}
"#;
    let mut found = Vec::new();
    each_struct_or_enum_body_identifier(synthetic, |ident| found.push(ident.to_string()));
    assert_eq!(found, vec!["codex_session_id", "normal_field", "Codex", "Dsh", "Neutral"]);
}

#[test]
fn struct_field_and_enum_variant_names_are_domain_free() {
    each_src_file(|path, content| {
        each_struct_or_enum_body_identifier(content, |ident| {
            let lower = ident.to_lowercase();
            for term in FORBIDDEN_TERMS {
                assert!(
                    !lower.contains(term),
                    "§4.1 violated in {}: field/variant `{ident}` contains domain term `{term}`",
                    path.display()
                );
            }
        });
    });
}
