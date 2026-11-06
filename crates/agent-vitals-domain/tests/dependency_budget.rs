//! v0.8 目标架构（`docs/AGENT_VITALS_V0_8_ARCHITECTURE_SPEC.md` §3.3 依赖预算 /
//! §14.2 / §15 DoD）的**可执行守卫**。Phase C 把 `agent-vitals-core` 拆解，最终
//! 收进单个 **`agent-vitals-domain`**：`contracts/`（执行环境无关词表）+ `domain/`
//! （纯计算）+ `compatibility/`（vitals-core 桥）。中途的 `agent-vitals-contracts`
//! 独立 crate 与 `agent-vitals-core` facade 都已撤销（见
//! `AGENT_VITALS_V0_8_PHASE_C_RESEARCH.md` §6sexies）。本文件钉住
//! **`agent-vitals-domain` 必须保持纯计算**：不许 I/O / 原生 / 运行时依赖悄悄
//! 进来，方向只能 `adapters → domain`（domain 不许回依赖 adapter）；`contracts/`
//! 子模块不许糊进 domain 计算（`contracts_module_stays_vocabulary_only`）。
//!
//! 实测基线：`agent-vitals-domain/src` 的非 test 代码对
//! `std::fs`/`std::process`/`std::env`/`SystemTime::now` 命中数是 0，
//! `[dependencies]` 只有 `regex`/`serde_json`/`vitals-core`。守卫是防回归，不是修 bug。
//!
//! 做法与 `crates/vitals-core/tests/dependency_boundary.rs` 同源：源码/清单
//! 文本层面的静态断言，不引 `cargo metadata`。测试范围仅本 crate 自己
//! （`CARGO_MANIFEST_DIR`），不跨仓。

use std::fs;
use std::path::{Path, PathBuf};

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

// ─────────────────────── §3.3 / §14.2：依赖预算 ───────────────────────

/// §3.3「`agent-vitals-domain` 可依赖 vitals-core、serde、纯算法库，不能依赖
/// SQLite/watcher」+ §14.2「domain 的 Cargo 依赖禁止 runtime/Tauri/SQLite/zstd」。
/// 用**否定清单**而不是允许清单：新增一个合法的纯算法库（`itertools` 之类）不
/// 该让守卫变红，但下面这些类别一旦作为**直接依赖**出现，就是边界破了。
const FORBIDDEN_DEP_KEYS: &[&str] = &[
    // SQLite / 关系型存储 —— 属 runtime
    "rusqlite",
    "libsqlite3-sys",
    "sqlx",
    "diesel",
    "sled",
    // 压缩 / 编解码 —— I/O 相邻，属 runtime source
    "ruzstd",
    "zstd",
    "zstd-sys",
    "flate2",
    "brotli",
    "xz2",
    // 异步运行时 —— domain 是纯函数，不持有 executor
    "tokio",
    "async-std",
    "smol",
    // 文件监听 —— 属 runtime watcher
    "notify",
    "notify-debouncer-mini",
    "notify-debouncer-full",
    // 网络 —— domain 不出网（Catalog 远端拉取是 runtime 的事）
    "reqwest",
    "hyper",
    "ureq",
    "isahc",
    "curl",
    // 桌面外壳 —— 属 apps/desktop
    "tauri",
    "wry",
    "tao",
    // wasm 胶水 —— 属 agent-vitals-wasm，不进被它依赖的 core
    "wasm-bindgen",
    "js-sys",
    "web-sys",
    // CLI / 目录遍历 / home 解析 —— 属 apps 与 runtime
    "clap",
    "walkdir",
    "dirs",
    "directories",
    "home",
    "etcetera",
    // 时间库 —— CLAUDE.md 纪律：core 的日期用手写 civil 数学，chrono 不是依赖
    "chrono",
    "time",
    // §3.2 禁止方向：`[dependencies]` 不许反依赖二进制 / wasm / adapter
    // （`adapters → domain` 是唯一允许的**生产**方向）。`domain → adapters`
    //  只以 `[dev-dependencies]` 存在——`domain/usage.rs::tests` 经它调
    //  `canonical_tokens`（只换 `serde_json::Value`），`tests/behavior_rules.rs`
    //  经它调 `build_dsh_evidence` 造 `CanonicalSession` fixture（integration test，
    //  domain 只编一遍，无成环）。`agent-vitals-core` 已删除（Phase C Step 4 收尾）
    //  ——列在这里挡它复活。
    "agent-vitals",
    "agent-vitals-core",
    "agent-vitals-harnesses",
    "agent-vitals-wasm",
];

/// 从 `[dependencies]` 段逐行按 TOML key 精确切出依赖名——与
/// `dependency_boundary.rs::deps_section_contains` 同一套解析（按 `=`/`.` 切
/// key、trim、精确比较），不做整段子串包含（否则 `agent-vitals-core` 会把
/// `agent-vitals` 也算命中）。`[dependencies.foo]` 的 table 形式也认。
fn dependency_keys(manifest: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut in_deps = false;
    for raw in manifest.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            // `[dependencies]` 或 `[dependencies.<name>]`；其余 section 关掉。
            if line == "[dependencies]" {
                in_deps = true;
            } else if let Some(rest) = line.strip_prefix("[dependencies.") {
                if let Some(name) = rest.strip_suffix(']') {
                    keys.push(name.trim().to_string());
                }
                in_deps = false;
            } else {
                in_deps = false;
            }
            continue;
        }
        if in_deps {
            let key = line.split(['=', '.']).next().unwrap_or("").trim();
            if !key.is_empty() {
                keys.push(key.to_string());
            }
        }
    }
    keys
}

#[test]
fn cargo_toml_has_no_io_or_runtime_dependency() {
    let manifest = fs::read_to_string(manifest_dir().join("Cargo.toml")).expect("read Cargo.toml");
    let keys = dependency_keys(&manifest);
    for key in &keys {
        assert!(
            !FORBIDDEN_DEP_KEYS.contains(&key.as_str()),
            "v0.8 §3.3/§14.2 violated: agent-vitals-domain/Cargo.toml [dependencies] must not \
             pull in `{key}` — I/O / native / runtime deps belong in agent-vitals-runtime or \
             an app crate, never in the pure computation domain crate."
        );
    }
    // 正向 sanity：确实走 vitals-core 这条允许路径——否则上面的否定断言可能
    // 是在测一个假问题（比如 domain 干脆没接 vitals-core 了）。
    assert!(keys.iter().any(|k| k == "vitals-core"), "domain 必须依赖 vitals-core（M2 桥）");
}

/// 证明上面那条不是摆设：喂一段只存在于本测试里的合成清单，断言解析器**确实**
/// 切出了每个依赖名（含 table 形式）。解析器一旦坏掉、切不出 key，
/// `cargo_toml_has_no_io_or_runtime_dependency` 的"全绿"就不可信。
#[test]
fn dependency_key_parser_actually_extracts_names() {
    let synthetic = r#"
[package]
name = "x"

[dependencies]
regex = "1"
serde_json = { version = "1", features = ["preserve_order"] }
vitals-core = { path = "../vitals-core" }
rusqlite = { version = "0.31", features = ["bundled"] }  # 违规样例

[dependencies.tokio]
version = "1"

[dev-dependencies]
proptest = "1"
"#;
    let keys = dependency_keys(synthetic);
    assert_eq!(
        keys,
        vec!["regex", "serde_json", "vitals-core", "rusqlite", "tokio"],
        "解析器必须切出全部 [dependencies] key（含 table 形式），且不越界抓 [dev-dependencies]"
    );
}

// ─────────────────── §15 DoD：domain 不碰文件/环境/时钟 ───────────────────

/// §15「domain 不读取文件、环境变量、数据库或系统时间」+ §14.3「adapters 禁止
/// `std::fs`、`std::process`、环境变量和 state 写入」。扫描非 test 源码——
/// `#[cfg(test)] mod ...` 块整段跳过（那里为了自包含算北京日会用
/// `SystemTime::now`，是合法的，`budget.rs` 现状即如此）。
const FORBIDDEN_IO_PATTERNS: &[&str] = &[
    "std::fs",
    "std::process",
    "std::env::",
    "SystemTime::now",
    "Instant::now",
    "File::open",
    "File::create",
];

fn each_src_file(mut visit: impl FnMut(&Path, &str)) {
    fn walk(dir: &Path, visit: &mut impl FnMut(&Path, &str)) {
        let mut entries: Vec<PathBuf> = fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()))
            .flatten()
            .map(|e| e.path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                walk(&path, visit);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                let content = fs::read_to_string(&path).expect("read src file");
                visit(&path, &content);
            }
        }
    }
    walk(&manifest_dir().join("src"), &mut visit);
}

/// 去掉 `#[cfg(test)]` 紧跟的 `mod <name> { ... }` 整块（按花括号深度配平），
/// 再去掉行注释——剩下的就是"生产代码"。逐 token 而非逐 AST 是有意的简化
/// （同 `dependency_boundary.rs` 的取舍）：真正的语义审查在 code review，这里
/// 只挡"生产代码里直接写了 std::fs"这种一眼假的回归。
fn strip_test_modules_and_comments(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut lines = content.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("#[cfg(test)]") {
            // 下一行若是 `mod xxx {`（或本行内联到 `{`），吃掉整个 body。
            let opens_here = trimmed.contains('{');
            let mut depth: i32 = if opens_here {
                trimmed.matches('{').count() as i32 - trimmed.matches('}').count() as i32
            } else {
                match lines.peek() {
                    Some(next) if next.trim_start().starts_with("mod ") && next.contains('{') => {
                        let n = lines.next().unwrap();
                        n.matches('{').count() as i32 - n.matches('}').count() as i32
                    }
                    _ => 0, // `#[cfg(test)]` 修饰的是单个 fn/use，不是 mod —— 不整段跳，
                            // 让它下面的行照常被扫（test 辅助函数读 fs 也是这个 crate 的味道问题）
                }
            };
            if depth > 0 {
                for inner in lines.by_ref() {
                    depth += inner.matches('{').count() as i32;
                    depth -= inner.matches('}').count() as i32;
                    if depth <= 0 {
                        break;
                    }
                }
                continue;
            }
            continue;
        }
        // 去行注释（`//` 之后到行尾）——不处理块注释 `/* */`，本 crate 不用它。
        let code = line.split("//").next().unwrap_or("");
        out.push_str(code);
        out.push('\n');
    }
    out
}

#[test]
fn production_source_does_not_touch_files_env_or_clock() {
    each_src_file(|path, content| {
        let prod = strip_test_modules_and_comments(content);
        for pat in FORBIDDEN_IO_PATTERNS {
            assert!(
                !prod.contains(pat),
                "v0.8 §15 DoD violated in {}: production code contains `{pat}` — the pure core \
                 (future agent-vitals-domain / -adapters) must receive files/env/clock as typed \
                 inputs, never read them itself. If this is genuinely test-only code, move it \
                 into a `#[cfg(test)] mod tests {{ ... }}` block.",
                path.strip_prefix(manifest_dir()).unwrap_or(path).display()
            );
        }
    });
}

/// 同样证明扫描器不是空跑：合成一段带 `#[cfg(test)] mod tests` 的片段，断言
/// test 块里的 `std::fs` 被剥掉、生产行里的被保留。
#[test]
fn io_scanner_strips_test_modules_but_keeps_production_lines() {
    let synthetic = "\
pub fn pure() -> i32 { 1 + 1 }

#[cfg(test)]
mod tests {
    use std::fs;
    #[test]
    fn t() { let _ = fs::read_to_string(\"/etc/harnesses\"); assert!(std::env::var(\"X\").is_err()); }
}
";
    let stripped = strip_test_modules_and_comments(synthetic);
    assert!(stripped.contains("pub fn pure"), "生产行必须保留");
    assert!(!stripped.contains("std::fs"), "test 块里的 std::fs 必须被剥掉");
    assert!(!stripped.contains("std::env"), "test 块里的 std::env 必须被剥掉");

    let leaky = "use std::fs;\npub fn bad() { let _ = std::fs::read(\"x\"); }\n";
    assert!(
        strip_test_modules_and_comments(leaky).contains("std::fs"),
        "生产代码里的 std::fs 不能被误剥"
    );
}

// ─────────────────────── Phase C：crate 边界 ───────────────────────

#[test]
fn source_root_is_an_explicit_facade_not_a_flat_module_dump() {
    let src = manifest_dir().join("src");
    let mut entries: Vec<String> = fs::read_dir(&src)
        .expect("read src")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        // 忽略 `.`-前缀的非模块项（`.DS_Store` 之类 OS/工具产物，`.gitignore`
        // 已排除）——本测试钉的是**模块**布局，不是目录里有没有 Finder 落过灰。
        .filter(|name| !name.starts_with('.'))
        .collect();
    entries.sort();
    // Phase C Step 4：`domain/` 计算 + `contracts/` 词表 + `compatibility/`
    // （vitals-core 桥）整体成 `agent-vitals-domain` crate；`agent-vitals-core`
    // facade 与独立的 `agent-vitals-contracts` crate 都已撤销，调用方直接
    // `use agent_vitals_domain::*`。harness `adapters/` 早在 Step 3 迁出。
    assert_eq!(
        entries,
        vec!["compatibility", "contracts", "domain", "lib.rs"],
        "agent-vitals-domain/src may only expose contracts/ + domain/ + compatibility/ + lib.rs"
    );
}

/// 所有 harness wire 适配（`claude_code`/`codex`/`workbuddy` evidence + Codex fold +
/// canonical 归一层 + Phase D1 起的 DSH `evidence`/`audit`/`compaction`/`waste`）
/// 都在 `agent-vitals-harnesses`，不在本 crate。
#[test]
fn domain_crate_holds_no_harness_adapter_directory() {
    assert!(
        !manifest_dir().join("src/adapters").exists(),
        "harness wire adapters belong in agent-vitals-harnesses"
    );
    assert!(
        !manifest_dir().join("src/harnesses").exists(),
        "no per-harness folder in the domain crate — that is agent-vitals-harnesses' shape"
    );
}

/// `contracts/` 是**执行环境无关词表**：只碰 `serde_json`，不 `use regex` /
/// `vitals_core` / `crate::domain` / `crate::compatibility` / adapter。这条
/// 钉住「adapters 与未来 runtime 能只依赖词表而不拉进 domain 计算」——即使
/// 词表和计算现在同 crate，模块边界也不许糊。
#[test]
fn contracts_module_stays_vocabulary_only() {
    let contracts = manifest_dir().join("src/contracts");
    each_src_file(|path, content| {
        if !path.starts_with(&contracts) {
            return;
        }
        let prod = strip_test_modules_and_comments(content);
        for needle in [
            "use regex",
            "regex::",
            "vitals_core",
            "crate::domain",
            "crate::compatibility",
            "agent_vitals_harnesses",
        ] {
            assert!(
                !prod.contains(needle),
                "contracts/{} references `{needle}` — the vocabulary layer stays serde_json-only \
                 and never reaches into domain computation",
                path.strip_prefix(&contracts).unwrap_or(path).display()
            );
        }
    });
}

/// v0.8 Phase D1：`domain/dsh/` 整个迁进 `agent-vitals-harnesses/harnesses/dsh/sessions/`。
/// domain 里不再有任何 DSH-wire 解析模块——这条断言钉死它不复活。
#[test]
fn domain_holds_no_dsh_wire_module() {
    assert!(
        !manifest_dir().join("src/domain/dsh").exists(),
        "Phase D1: DSH wire 解析（evidence/audit/compaction/waste）已迁进 \
         agent-vitals-harnesses/harnesses/dsh/sessions/——domain/dsh/ 不该再出现"
    );
}

#[test]
fn nested_paths_and_legacy_facade_resolve_to_the_same_items() {
    assert_eq!(
        agent_vitals_domain::contracts::usage_fact::USAGE_FACT_FIELDS,
        agent_vitals_domain::usage_fact::USAGE_FACT_FIELDS
    );
    assert_eq!(
        agent_vitals_domain::domain::usage::AMBIGUOUS_PROVIDER,
        agent_vitals_domain::usage::AMBIGUOUS_PROVIDER
    );
}

/// v0.8 Phase D1 起 `domain/` 的**生产**代码对任何执行环境 wire 解析零依赖——DSH
/// wire 已迁出。`#[cfg(test)]` 里经 `[dev-dependencies]` 调 `canonical_tokens`
/// （只换 `Value`）或 `agent_vitals_harnesses::dsh_evidence::build_dsh_evidence`
/// 造 fixture（`tests/behavior_rules.rs` 是 integration test，无成环）是允许的。
#[test]
fn domain_production_code_has_no_harness_adapter_dependency() {
    each_src_file(|path, content| {
        if !path.starts_with(manifest_dir().join("src/domain")) {
            return;
        }
        let prod = strip_test_modules_and_comments(content);
        for needle in [
            "agent_vitals_harnesses",
            "crate::adapters",
            "crate::claude_code_evidence",
            "crate::codex_evidence",
            "crate::codex_usage",
            "crate::dsh_evidence",
            "crate::workbuddy_evidence",
        ] {
            assert!(
                !prod.contains(needle),
                "v0.8 Phase D1: production code in {} references `{needle}` — 执行环境 wire \
                 解释归 agent-vitals-harnesses，domain 只算不解析",
                path.strip_prefix(manifest_dir()).unwrap_or(path).display()
            );
        }
    });
}
