//! v0.8 `agent-vitals-harnesses` 的可执行边界守卫（arch §4.3）。
//!
//! - `[dependencies]`：允许 `agent-vitals-domain` / `regex` / `serde_json` /
//!   `vitals-core` + feature-gated 的 I/O 读取器依赖（`ruzstd`/`rusqlite`/`walkdir`，
//!   `optional = true`，只在 `sources` feature 下链入）。禁 `agent-vitals`（binary）
//!   / `tauri` / `notify` / `tokio` 等编排/watcher。
//! - I/O token（`std::fs`/`std::process`/`std::env::`/`ruzstd`/`rusqlite`/…）**只许**
//!   出现在路径含 `/sources` 或 `mcp/probe.rs` 的文件；`sessions/`/`skills/`/
//!   `shared/`/`lib.rs`/`registry.rs`/`capability.rs` 命中即红（§4.3 第 2 条）。

use std::fs;
use std::path::{Path, PathBuf};

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn dependency_keys(manifest: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut in_deps = false;
    for raw in manifest.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            in_deps = line == "[dependencies]";
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
fn adapters_dependency_budget_is_pure_and_one_way() {
    let manifest = fs::read_to_string(manifest_dir().join("Cargo.toml")).unwrap();
    let actual: std::collections::BTreeSet<String> = dependency_keys(&manifest).into_iter().collect();
    // 纯依赖 —— 恒在。
    for req in [
        "agent-vitals-domain",
        "agent-vitals-provider",
        "regex",
        "serde",
        "serde_json",
        "vitals-core",
    ] {
        assert!(actual.contains(req), "harnesses 必须依赖 `{req}`");
    }
    // feature-gated I/O 读取器依赖：允许，但必须 `optional`（`[features] sources`
    // 才链入）——`[dependencies]` 里带 `optional = true` 的行 `dependency_keys`
    // 照常切出 key，这里只把它们从「未知依赖」白名单里放行。
    // `jiff`（W3）：Codex 额度重置时间的时区换算（`codex/sources/cost.rs`）。不是 I/O，
    // 但同样只在 `sources` 下链入——时区由调用方传入，本 crate 仍不读系统时区。
    let io_optional = ["ruzstd", "rusqlite", "walkdir", "jiff"];
    let forbidden_deps = ["agent-vitals", "agent-vitals-wasm", "tauri", "notify", "tokio", "reqwest"];
    for key in &actual {
        assert!(
            !forbidden_deps.contains(&key.as_str()),
            "harnesses/Cargo.toml [dependencies] 不许有 `{key}`（编排/watcher/binary 属 runtime/app）"
        );
        let known = [
            "agent-vitals-domain",
            "agent-vitals-provider",
            "regex",
            // serde（derive，纯）：R5-F7a 的 quota 贡献缓存需要 QuotaSnapshot/
            // QuotaFileContribution 过 JSON 往返——无 I/O、无新外部 crate
            // （serde 已在工作区树内），按纯依赖登记。
            "serde",
            "serde_json",
            "vitals-core",
        ]
            .contains(&key.as_str())
            || io_optional.contains(&key.as_str());
        assert!(known, "harnesses 出现未登记依赖 `{key}`——若是新 I/O 读取器，标 optional 并加进 io_optional");
    }

    // `adapters → domain` 是唯一允许的**生产**方向。`domain → adapters` 只以
    // `[dev-dependencies]` 存在（`domain/usage.rs::tests` 经它调 `canonical_tokens`，
    // 只换 `serde_json::Value`），Cargo 允许 dev-dep 成环。这里只断言 domain 的
    // `[dependencies]`（`dependency_keys` 在 `[dev-dependencies]` 处停）不含 adapters。
    let domain_manifest =
        fs::read_to_string(manifest_dir().join("../agent-vitals-domain/Cargo.toml")).unwrap();
    assert!(
        !dependency_keys(&domain_manifest)
            .iter()
            .any(|v| v == "agent-vitals-harnesses"),
        "domain's [dependencies] must not reference adapters (only the dev-dep back-edge is allowed)"
    );
}

fn each_src_file(mut visit: impl FnMut(&Path, &str)) {
    fn walk(dir: &Path, visit: &mut impl FnMut(&Path, &str)) {
        let mut entries: Vec<PathBuf> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                walk(&path, visit);
            } else if path.extension().and_then(|v| v.to_str()) == Some("rs") {
                visit(&path, &fs::read_to_string(&path).unwrap());
            }
        }
    }
    walk(&manifest_dir().join("src"), &mut visit);
}

/// §4.3 第 2 条：I/O token 只许出现在 `/sources` 或 `mcp/probe.rs`；`sessions/`/
/// `skills/`/`shared/`/`lib.rs`/`registry.rs`/`capability.rs` 命中即红。
#[test]
fn io_tokens_only_appear_under_sources() {
    let forbidden = [
        "std::fs",
        "std::process",
        "std::env::",
        "File::open",
        "File::create",
        "SystemTime::now",
        "Instant::now",
        "rusqlite",
        "ruzstd",
        "walkdir",
        "notify::",
        "tauri::",
    ];
    each_src_file(|path, content| {
        let rel = path.strip_prefix(manifest_dir()).unwrap_or(path);
        let s = rel.to_string_lossy();
        // `sources.rs` / `sources/**` / `mcp/probe.rs` 是允许 I/O 的层。
        let is_io_layer = s.contains("/sources") || s.ends_with("/sources.rs") || s.ends_with("mcp/probe.rs");
        if is_io_layer {
            return;
        }
        let before_tests = content.split("#[cfg(test)]").next().unwrap_or(content);
        // 去行注释——`mod.rs` 的模块文档里会提到 `ruzstd` 之类，那是说明不是代码。
        let production: String = before_tests
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        for needle in forbidden {
            assert!(
                !production.contains(needle),
                "pure harness layer {} contains I/O token `{needle}` —— 移进 harnesses/<h>/sources/",
                rel.display()
            );
        }
    });
}

#[test]
fn harness_namespace_is_complete_and_surface_explicit() {
    let harnesses = manifest_dir().join("src/harnesses");
    let mut actual: Vec<String> = fs::read_dir(&harnesses)
        .unwrap()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    actual.sort();
    assert_eq!(
        actual,
        vec!["claude_code", "codex", "dsh", "generic", "openclaw", "workbuddy"]
    );
    // v0.8 Phase E7.6：openclaw 是 Skill-Surface-only 执行环境——它没有 Session
    // Surface 证据面（不在 harness_capability.rs 的 RUNTIME_HARNESS_IDS 四个"运行时
    // 执行环境"里），只有 `sources/skills.rs`（目录发现 + `openclaw skills list`
    // 探测），没有、也不该有 `sessions/`。其余四个执行环境都是运行时执行环境，
    // `sessions/mod.rs` 仍然强制存在。
    for harness in actual {
        if harness == "generic" {
            // HARNESS_MANIFEST_DSL_SPEC：generic 是自描述插件执行环境——没有 wire 会话
            // 证据面（行为面不开放，spec §1），只有 `manifest.rs`（纯）与
            // `sources/discover.rs`（文件发现）。账面喉咙在 runtime，不入本 crate。
            assert!(
                !harnesses.join(&harness).join("sessions").exists(),
                "generic 没有 Session Surface 证据面，不该凭空长出 sessions/"
            );
            continue;
        }
        if harness == "openclaw" {
            assert!(
                !harnesses.join(&harness).join("sessions").exists(),
                "openclaw 没有 Session Surface 证据面，不该凭空长出 sessions/"
            );
            continue;
        }
        assert!(harnesses.join(harness).join("sessions/mod.rs").is_file());
    }
}

#[test]
fn flat_facade_and_harness_namespaces_resolve_to_the_same_items() {
    assert_eq!(
        agent_vitals_harnesses::codex_usage::CODEX_TOKEN_FIELDS,
        agent_vitals_harnesses::harnesses::codex::sessions::usage::CODEX_TOKEN_FIELDS
    );
    let _: Option<agent_vitals_harnesses::claude_code_evidence::ClaudeEvidence> = None;
    let _: Option<agent_vitals_harnesses::harnesses::codex::sessions::evidence::CodexEvidence> = None;
    let _: Option<agent_vitals_harnesses::dsh_evidence::DshEvidence> = None;
    let _: Option<agent_vitals_harnesses::workbuddy_evidence::WorkbuddyEvidence> = None;
}
