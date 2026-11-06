//! 旧根 facade import 的回归预算（RUNTIME_REFACTOR_WATCHER_HOTPLUG_HARDENING
//! Phase E.3——**非阻塞**架构检查：基线是 2026-09-22 实测值 + 宽裕余量，
//! 只在**新增**旧路径依赖时报警；存量迁移按「顺路改」机会主义推进，
//! 归零后再计划大版本移除 facade（spec Phase E.4）。
//!
//! 计数口径：仓库 Rust 源里 `agent_vitals_runtime::<legacy-module>::` 的
//! use/路径引用（排除 runtime 自身与构建产物）。`events`/`source_graph` 在
//! crate 根就是家，不算旧路径。

use std::path::PathBuf;

/// 已迁入领域目录、根上只剩兼容 re-export 的模块名。
const LEGACY_MODULES: &[&str] = &[
    // ingest/
    "sync_service", "sql_sync", "ingest_service", "lease", "plugin_ingest",
    "reimport_verify", "sql_authority", "sync_control",
    // query/
    "summary", "decision_matrix", "trace_service", "export",
    // billing/
    "billing_preview", "budget", "budget_notifications", "money",
    "price_discovery", "price_overrides", "pricing_catalog", "quota_reminder",
    // core/
    "clock", "home", "state", "takeover", "statistics_timezone", "retention",
    // trust/
    "trust_audit", "trust_identity", "trust_runtime_monitor",
    // sources/
    "custom_sources", "harness_registry", "session_sources", "source_controls",
];

/// 2026-09-22 实测 274 处（完整 LEGACY_MODULES 口径；spec 原文估 220 与
/// 评审快 grep 的 151 都是子集口径）。天花板取实测 + 10：允许零星顺路
/// 挪动造成的口径波动，拦截整段新代码走旧路径。
const BUDGET: usize = 284;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

fn count_legacy_imports() -> usize {
    let root = repo_root();
    let mut count = 0usize;
    let mut stack = vec![root.join("crates"), root.join("apps")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if name == "target" || name == "node_modules" || name.starts_with('.') {
                    continue;
                }
                // runtime 自身内部的旧路径用法是迁移候选但不是「外部消费者」，
                // 不计（facade 的存在意义就是服务外部调用方）。
                if path.ends_with("crates/agent-vitals-runtime/src") {
                    continue;
                }
                stack.push(path);
            } else if name.ends_with(".rs") {
                let Ok(text) = std::fs::read_to_string(&path) else { continue };
                for module in LEGACY_MODULES {
                    count += text
                        .matches(&format!("agent_vitals_runtime::{module}::"))
                        .count();
                }
            }
        }
    }
    count
}

#[test]
fn legacy_root_facade_imports_stay_within_budget() {
    let count = count_legacy_imports();
    assert!(
        count <= BUDGET,
        "旧根 facade import 计数 {count} 超过预算 {BUDGET}——新代码请 import \
         领域路径（runtime::ingest::* / runtime::query::* / runtime::core::* / …），\
         旧路径只服务存量消费者（HARDENING spec Phase E）"
    );
}
