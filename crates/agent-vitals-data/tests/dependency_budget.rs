//! `agent-vitals-data` 的可执行边界守卫
//! （`docs/AGENT_VITALS_V0_9_DATA_VALUE_ARCHITECTURE_SPEC.md` §3.1/§5.1）。
//!
//! Stage 0.2 现状——这条测试钉的是**当前阶段**的收紧，不是永久上限：
//! - 不依赖 `agent-vitals-harnesses`：Stage 0.3 起会加只读 JSON adapter，那时
//!   仍不需要 harnesses（读的是执行环境已经写好的 state JSON，不是执行环境 wire），
//!   真正需要 harnesses 的时机待 Stage 0.3 具体设计时再评估；
//! - `rusqlite` 已按计划引入（spec §5.1，v0.9.1 SQL 权威库 `authority.rs`）
//!   ——从禁用清单移除是按计划推进，不是"悄悄长出第二权威源"；
//! - 不反依赖二进制/wasm/runtime：依赖方向是
//!   `apps/{cli,desktop} → agent-vitals-runtime → agent-vitals-data →
//!   agent-vitals-domain`，且 `runtime → harnesses → domain` 并行成边——
//!   **data 不依赖 harnesses**（本测试钉死），harnesses 的 wire 解释经 runtime 或
//!   上层到达 data，不是反过来。

use std::fs;
use std::path::Path;

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
            if let Some(rest) = line.strip_prefix("[dependencies.") {
                if let Some(name) = rest.strip_suffix(']') {
                    keys.push(name.trim().to_string());
                }
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
fn data_dependencies_stay_within_domain_serde_and_sqlite() {
    let manifest = fs::read_to_string(manifest_dir().join("Cargo.toml")).expect("read Cargo.toml");
    let keys = dependency_keys(&manifest);
    for forbidden in [
        "agent-vitals-harnesses",
        "agent-vitals",
        "agent-vitals-wasm",
        "agent-vitals-runtime",
        "tauri",
        "chrono",
        "time",
        // ORM 禁令（spec §5.1）：手写参数化 SQL，不引 Diesel/SeaORM/SQLx。
        "diesel",
        "sea-orm",
        "sqlx",
    ] {
        assert!(
            !keys.iter().any(|k| k == forbidden),
            "agent-vitals-data/Cargo.toml [dependencies] must not reference `{forbidden}` — \
             见本文件头部注释：data 只许 domain + serde_json + rusqlite；放开\
             任何一项都要同步改这条测试与 Cargo.toml 的注释，不能悄悄放开"
        );
    }
    // rusqlite 必须在场——v0.9.1 SQL 权威库 `authority.rs` 是本 crate 的核心。
    assert!(
        keys.iter().any(|k| k == "rusqlite"),
        "agent-vitals-data 必须显式依赖 rusqlite（authority.rs SQL 权威库）"
    );
}

/// projection 模块目前只是 domain 契约类型的重新导出——签名稳定即可，还没有
/// 组装逻辑可测。
#[test]
fn projection_reexports_the_domain_contract_types() {
    let m = agent_vitals_data::projection::MonthlySummary {
        month: "2026-09".to_string(),
        by_harness: Default::default(),
        tokens_by_harness: Default::default(),
        by_provider: Default::default(),
        coverage: agent_vitals_data::projection::CoverageStatus {
            measured_fields: 0,
            total_fields: 0,
            denominator_version: 1,
        },
        freshness: agent_vitals_data::projection::Freshness::unavailable(),
        excluded_harnesses: Default::default(),
        last_observed_at: None,
    };
    assert!(m.contract_violations().is_empty());
}
