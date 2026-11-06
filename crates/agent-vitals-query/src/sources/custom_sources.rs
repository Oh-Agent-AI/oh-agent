//! 用户显式添加的执行环境根目录。这里只保存“哪个执行环境的哪一个根”；实际日志枚举
//! 仍复用各执行环境 adapter，避免 UI 另写一套格式解释或绕过事实去重。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const CUSTOM_SOURCES_FILE: &str = "custom-sources.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomSourceRoot {
    pub harness: String,
    pub root: String,
}

fn valid_harness(harness: &str) -> bool {
    matches!(harness, "claude-code" | "codex" | "dsh")
}

pub fn custom_source_roots(data_home: &Path) -> Result<Vec<CustomSourceRoot>, String> {
    let path = data_home.join("state").join(CUSTOM_SOURCES_FILE);
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("custom source configuration unreadable: {error}")),
    };
    let mut sources: Vec<CustomSourceRoot> = serde_json::from_str(&text)
        .map_err(|error| format!("custom source configuration is invalid: {error}"))?;
    for source in &sources {
        validate_source(source)?;
    }
    sources.sort_by(|left, right| left.harness.cmp(&right.harness).then(left.root.cmp(&right.root)));
    sources.dedup();
    Ok(sources)
}

pub fn add_custom_source_root(
    data_home: &Path, harness: &str, root: &Path,
) -> Result<bool, String> {
    let source = CustomSourceRoot {
        harness: harness.to_string(),
        root: root.to_string_lossy().into_owned(),
    };
    validate_source(&source)?;
    if !root.is_dir() {
        return Err("custom source root must be an existing directory".to_string());
    }
    let mut sources = custom_source_roots(data_home)?;
    if sources.contains(&source) {
        return Ok(false);
    }
    sources.push(source);
    write_sources(data_home, &sources)?;
    Ok(true)
}

pub fn remove_custom_source_root(data_home: &Path, harness: &str, root: &Path) -> Result<bool, String> {
    let root = root.to_string_lossy();
    let mut sources = custom_source_roots(data_home)?;
    let before = sources.len();
    sources.retain(|source| !(source.harness == harness && source.root == root));
    if sources.len() == before {
        return Ok(false);
    }
    write_sources(data_home, &sources)?;
    Ok(true)
}

fn validate_source(source: &CustomSourceRoot) -> Result<(), String> {
    if !valid_harness(&source.harness) {
        return Err("custom source harness is not supported".to_string());
    }
    let root = PathBuf::from(&source.root);
    if source.root.trim().is_empty() || !root.is_absolute() {
        return Err("custom source root must be an absolute path".to_string());
    }
    Ok(())
}

fn write_sources(data_home: &Path, sources: &[CustomSourceRoot]) -> Result<(), String> {
    let directory = data_home.join("state");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let temporary = directory.join("custom-sources.json.tmp");
    let target = directory.join(CUSTOM_SOURCES_FILE);
    let contents = serde_json::to_vec(sources).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, target).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_home(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("agent-vitals-custom-source-{name}-{}", std::process::id()))
    }

    #[test]
    fn add_list_and_remove_round_trip() {
        let home = temporary_home("round-trip");
        let root = home.join("custom");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&root).unwrap();
        assert!(add_custom_source_root(&home, "codex", &root).unwrap());
        assert!(!add_custom_source_root(&home, "codex", &root).unwrap());
        assert_eq!(custom_source_roots(&home).unwrap(), vec![CustomSourceRoot {
            harness: "codex".to_string(), root: root.to_string_lossy().into_owned(),
        }]);
        assert!(remove_custom_source_root(&home, "codex", &root).unwrap());
        assert!(custom_source_roots(&home).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn rejects_unsupported_or_relative_roots() {
        let home = temporary_home("invalid");
        let _ = std::fs::remove_dir_all(&home);
        let absolute = std::env::temp_dir();
        assert!(add_custom_source_root(&home, "workbuddy", &absolute).is_err());
        assert!(add_custom_source_root(&home, "codex", Path::new("relative")).is_err());
    }
}
