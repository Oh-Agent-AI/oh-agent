//! 用户对单个执行环境读取范围的显式控制。排除只停止后续读取，不触及原始日志或
//! 已导入事实；删除本 App 数据是另一个需要单独确认的动作。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const SOURCE_CONTROLS_FILE: &str = "source-controls.json";
const SOURCE_DATA_REVISION_FILE: &str = "source-data-revision.json";
// Harnesses with a first-class local ingest/source-control adapter.  This registry is
// intentionally shared by stop-reading and delete-imported-data operations; a
// harness must not appear as controllable in one surface and fail in another.
const HARNESSES: [&str; 4] = ["claude-code", "codex", "dsh", "workbuddy"];

pub fn supported_harnesses() -> &'static [&'static str] {
    &HARNESSES
}

/// Runtime registry: built-in adapters plus validated hot-plugged manifests.
/// Manifest slugs are returned in the `harness:<slug>` namespace used by the
/// authority and findings projections (spec v0.4.2 §13).
pub fn supported_harnesses_for(data_home: &Path) -> Vec<String> {
    let mut harnesses = HARNESSES.iter().map(|harness| (*harness).to_string()).collect::<Vec<_>>();
    let (plugins, _) = crate::harness_registry::scan_plugin_harnesses(data_home);
    harnesses.extend(plugins.into_iter().map(|plugin| format!("harness:{}", plugin.slug)));
    // Installed history remains controllable when input disappears or activation
    // changes during a pinned ingest. Never drop its stop-reading rule.
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    if let Ok(db) = agent_vitals_data::authority::AuthorityDb::open_readonly(&path) {
        if let Ok(mut statement) = db.conn().prepare(
            "SELECT DISTINCT slot_id FROM extension_revisions WHERE slot_type='harness_manifest'"
        ) {
            if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
                harnesses.extend(rows.flatten().filter(|slug| crate::harness_registry::plugin_slug_ok(slug))
                    .map(|slug| format!("harness:{slug}")));
            }
        }
    }
    harnesses.sort();
    harnesses.dedup();
    harnesses
}

/// 迁移期规范化：旧 `plugin:<slug>` 折算到新 `harness:<slug>`（slug 合法时）。
/// 锁路径与 authority 操作统一走规范化后的值，避免新旧前缀各拿各的锁。
fn canonical_harness(harness: &str) -> String {
    match harness.strip_prefix("plugin:") {
        Some(slug) if crate::harness_registry::plugin_slug_ok(slug) => format!("harness:{slug}"),
        _ => harness.to_string(),
    }
}

/// Per-harness coordination path used by ingest and destructive projection cleanup.
/// Keeping the path construction here prevents the Tauri command and the runtime
/// from accidentally using different locks for the same harness.
pub fn harness_data_lock_path(data_home: &Path, harness: &str) -> Result<PathBuf, String> {
    validate_harness_for(data_home, harness)?;
    Ok(encoded_harness_data_lock_path(data_home, &canonical_harness(harness)))
}

fn encoded_harness_data_lock_path(data_home: &Path, harness: &str) -> PathBuf {
    // Encode the harness bytes instead of embedding `plugin:<slug>` directly:
    // Windows rejects `:` in file names, and byte-hex keeps the mapping
    // collision-free across built-in and hot-plugged harnesses.
    let encoded = harness.bytes().map(|byte| format!("{byte:02x}")).collect::<String>();
    data_home.join("facts").join(format!(".source-{encoded}.lock"))
}

/// Shared destructive projection cleanup used by both Tauri and MCP.  The
/// harness lease covers exclusion + authority deletion as one operation, so an
/// in-flight sync cannot re-import rows between those two steps.
pub fn delete_imported_source_data(
    data_home: &Path,
    harness: &str,
) -> Result<agent_vitals_data::authority::HarnessImportedDataDeletion, String> {
    let canonical = canonical_harness(harness);
    let registered = supported_harnesses_for(data_home).contains(&canonical);
    let valid_orphan = canonical.strip_prefix("harness:").is_some_and(crate::harness_registry::plugin_slug_ok);
    if !registered && !valid_orphan {
        return Err("source harness is not supported by the local source registry".to_string());
    }
    let _lease = crate::lease::acquire_blocking(
        &encoded_harness_data_lock_path(data_home, &canonical),
        "delete-imported-source",
        600_000,
        10_000,
    )
    .map_err(|error| format!("source deletion is busy: {error}"))?;
    // A valid but currently uninstalled manifest harness may leave orphaned
    // authority rows. It cannot be excluded (there is no importer to stop),
    // but its projection remains safely deletable under the same harness lease.
    if registered {
        set_harness_excluded(data_home, &canonical, true)?;
    }
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(data_home),
        crate::clock::now_ms(),
    )
    .map_err(|error| format!("authority database unavailable: {error}"))?;
    let deleted = db.delete_imported_harness_data(&canonical, crate::clock::now_ms())
        .map_err(|error| format!("delete imported data failed: {error}"))?;
    // Best-effort cross-process invalidation marker.  The Tauri event is the
    // fast path; this marker lets an already-open desktop notice an MCP delete.
    if let Err(error) = bump_source_data_revision(data_home) {
        // The authority deletion remains successful; the desktop's direct
        // event path still refreshes Tauri callers. MCP callers get an
        // observable stderr diagnostic instead of a silent lost invalidation.
        eprintln!("source-data invalidation marker unavailable: {error}");
    }
    Ok(deleted)
}

pub fn source_data_revision(data_home: &Path) -> u64 {
    std::fs::read_to_string(data_home.join("state").join(SOURCE_DATA_REVISION_FILE))
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

fn bump_source_data_revision(data_home: &Path) -> Result<(), String> {
    let _lease = crate::lease::acquire_blocking(
        &data_home.join("facts").join(".source-data-revision.lock"),
        "source-data-revision",
        60_000,
        10_000,
    )
    .map_err(|error| error.to_string())?;
    let directory = data_home.join("state");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let next = source_data_revision(data_home).saturating_add(1);
    let temporary = directory.join(format!("{SOURCE_DATA_REVISION_FILE}.tmp"));
    std::fs::write(&temporary, next.to_string()).map_err(|error| error.to_string())?;
    std::fs::rename(temporary, directory.join(SOURCE_DATA_REVISION_FILE))
        .map_err(|error| error.to_string())
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct SourceControls {
    excluded_harnesses: BTreeSet<String>,
}

fn validate_harness_for(data_home: &Path, harness: &str) -> Result<(), String> {
    let canonical = canonical_harness(harness);
    if HARNESSES.contains(&canonical.as_str()) {
        Ok(())
    } else if canonical.strip_prefix("harness:").is_some_and(crate::harness_registry::plugin_slug_ok) {
        if !supported_harnesses_for(data_home).contains(&canonical) {
            return Err("source manifest harness is not registered".to_string());
        }
        Ok(())
    } else {
        Err("source harness is not supported".to_string())
    }
}

fn path(data_home: &Path) -> std::path::PathBuf {
    data_home.join("state").join(SOURCE_CONTROLS_FILE)
}

fn read(data_home: &Path) -> Result<SourceControls, String> {
    let value = match std::fs::read_to_string(path(data_home)) {
        Ok(text) => serde_json::from_str::<SourceControls>(&text)
            .map_err(|error| format!("source controls are invalid: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => SourceControls::default(),
        Err(error) => return Err(format!("source controls are unreadable: {error}")),
    };
    let mut value = value;
    // 迁移：旧 plugin: 值折算到 harness: 命名空间（原地、幂等）。
    let legacy: Vec<String> = value.excluded_harnesses.iter().filter(|harness| harness.starts_with("plugin:")).cloned().collect();
    for harness in legacy {
        let canonical = canonical_harness(&harness);
        value.excluded_harnesses.remove(&harness);
        value.excluded_harnesses.insert(canonical);
    }
    let registered = supported_harnesses_for(data_home);
    let mut stale = Vec::new();
    for harness in &value.excluded_harnesses {
        if HARNESSES.contains(&harness.as_str()) || registered.iter().any(|item| item == harness) {
            continue;
        }
        if harness.strip_prefix("harness:").is_some_and(crate::harness_registry::plugin_slug_ok) {
            stale.push(harness.clone());
        } else {
            return Err("source harness is not supported".to_string());
        }
    }
    for harness in stale { value.excluded_harnesses.remove(&harness); }
    Ok(value)
}

pub fn excluded_harnesses(data_home: &Path) -> Result<BTreeSet<String>, String> {
    Ok(read(data_home)?.excluded_harnesses)
}

pub fn set_harness_excluded(data_home: &Path, harness: &str, excluded: bool) -> Result<bool, String> {
    validate_harness_for(data_home, harness)?;
    let canonical = canonical_harness(harness);
    let mut controls = read(data_home)?;
    let changed = if excluded {
        controls.excluded_harnesses.insert(canonical)
    } else {
        controls.excluded_harnesses.remove(&canonical)
    };
    if !changed { return Ok(false); }
    let directory = data_home.join("state");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let temporary = directory.join("source-controls.json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(&controls).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    std::fs::rename(temporary, path(data_home)).map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusion_round_trip_and_harness_validation() {
        let home = std::env::temp_dir().join(format!("agent-vitals-controls-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        assert!(set_harness_excluded(&home, "codex", true).unwrap());
        assert_eq!(excluded_harnesses(&home).unwrap(), BTreeSet::from(["codex".to_string()]));
        assert!(set_harness_excluded(&home, "codex", false).unwrap());
        assert!(excluded_harnesses(&home).unwrap().is_empty());
        assert!(set_harness_excluded(&home, "zcode", true).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn harness_lease_is_shared_and_windows_safe() {
        let home = std::env::temp_dir().join(format!("agent-vitals-controls-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let path = harness_data_lock_path(&home, "harness:zcode").unwrap_err();
        assert_eq!(path, "source manifest harness is not registered");
        // 迁移期：旧 plugin: 输入规范化到新命名空间后同样报「未注册」，
        // 已注册官方执行环境不受影响。
        assert_eq!(harness_data_lock_path(&home, "plugin:zcode").unwrap_err(), "source manifest harness is not registered");
        let path = harness_data_lock_path(&home, "codex").unwrap();
        assert!(!path.to_string_lossy().contains(':'));
        let first = crate::lease::acquire(&path, "test-first", 60_000).unwrap();
        assert!(matches!(crate::lease::acquire(&path, "test-second", 60_000), Err(crate::lease::LeaseError::Held { .. })));
        drop(first);
        assert!(crate::lease::acquire(&path, "test-second", 60_000).is_ok());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn legacy_excluded_harnesses_are_normalized_in_place() {
        let home = std::env::temp_dir().join(format!("agent-vitals-controls-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        // 注册 zcode（否则未注册 manifest 执行环境按既有语义被 stale 清扫）。
        let manifest_dir = home.join("harnesses.d").join("zcode");
        std::fs::create_dir_all(&manifest_dir).unwrap();
        std::fs::create_dir_all(home.join("state")).unwrap();
        std::fs::write(manifest_dir.join("manifest.json"), r#"{"manifest_version":1,"slug":"zcode","display":{"name":"ZCode"},
            "discovery":{"roots":["~/r"],"include":["*.jsonl"]},
            "source":{"format":"jsonl"},
            "session":{"from":"filename","pattern":"^s_(?P<id>.+)\\.jsonl$"},
            "recipe":"request-usage-anthropic-v1",
            "event_key":{"paths":["requestId"]}}"#).unwrap();
        std::fs::write(home.join("state").join(SOURCE_CONTROLS_FILE), r#"{"excluded_harnesses":["codex","plugin:zcode"]}"#).unwrap();
        // 旧 plugin: 值折算到 harness: 并保留（已注册）；官方执行环境不动。
        let excluded = excluded_harnesses(&home).unwrap();
        assert_eq!(excluded, BTreeSet::from(["codex".to_string(), "harness:zcode".to_string()]));
        // 未注册的旧 plugin: 值：折算后按 stale 语义清扫（与卸载执行环境一致）。
        std::fs::remove_dir_all(&manifest_dir).unwrap();
        std::fs::write(home.join("state").join(SOURCE_CONTROLS_FILE), r#"{"excluded_harnesses":["codex","plugin:zcode"]}"#).unwrap();
        let excluded = excluded_harnesses(&home).unwrap();
        assert_eq!(excluded, BTreeSet::from(["codex".to_string()]));
        let _ = std::fs::remove_dir_all(&home);
    }
}
