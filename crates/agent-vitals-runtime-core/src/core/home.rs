//! **唯一 `HomeResolver`** —— 所有「数据根 / 执行环境 home 目录」解析收敛于此。
//!
//! v0.8 Phase D7：`data_home` / `snapshot_dir` 从二进制 `src/skills/snapshot.rs`、
//! `DSH_HOME` 从 `src/agent/discovery.rs` 迁进来。Python 侧镜像
//! `scripts/agent_vitals/paths.py`（`tests/test_paths.py` 跨实现契约测试）。
//! 二进制 `src/main.rs` 里散落的 `std::env::var("HOME")` 逐步收敛到这里。
//!
//! 选择语义（品牌改名后的兼容）：`~/.agent-vitals` 是新默认，但既有用户的
//! `~/.skill-vitals` 预算/日历/快照不能凭空消失——`AGENT_VITALS_HOME` →
//! `SKILL_VITALS_HOME` → （新默认存在 or 旧默认不存在 ? 新 : 旧）。

use std::path::PathBuf;

/// 注入式 env 读取：空字符串视为未设置（与 Python `paths._env_path` 一致）。
fn configured_path<F>(get_env: &F, name: &str) -> Option<PathBuf>
where
    F: Fn(&str) -> Option<String>,
{
    get_env(name).filter(|value| !value.is_empty()).map(PathBuf::from)
}

/// 数据根目录选择（纯：注入 env 读取 + home 目录）。Python 镜像 `paths.py::data_home`。
pub fn data_home_from<F>(get_env: &F, home: PathBuf) -> PathBuf
where
    F: Fn(&str) -> Option<String>,
{
    if let Some(path) = configured_path(get_env, "AGENT_VITALS_HOME") {
        return path;
    }
    if let Some(path) = configured_path(get_env, "SKILL_VITALS_HOME") {
        return path;
    }
    let current = home.join(".agent-vitals");
    let legacy = home.join(".skill-vitals");
    if current.exists() || !legacy.exists() {
        current
    } else {
        legacy
    }
}

/// 快照目录选择（纯）。`AGENT_VITALS_SNAPSHOT_DIR` → `SKILL_VITALS_SNAPSHOT_DIR`
/// → `data_home_from(..) / "snapshots"`。
pub fn snapshot_dir_from<F>(get_env: &F, home: PathBuf) -> PathBuf
where
    F: Fn(&str) -> Option<String>,
{
    if let Some(path) = configured_path(get_env, "AGENT_VITALS_SNAPSHOT_DIR") {
        return path;
    }
    if let Some(path) = configured_path(get_env, "SKILL_VITALS_SNAPSHOT_DIR") {
        return path;
    }
    data_home_from(get_env, home).join("snapshots")
}

/// `pub(crate)`——诊断包导出（`core::logging::redact_path_like`）需要「用户
/// 真实 home 目录字符串」来脱敏日志尾，不是 `data_home()`（那是
/// `~/.agent-vitals`，一个子目录，不是要擦掉的那个前缀本身）。仍然是唯一
/// 一处读 `HOME`/`USERPROFILE`——不许诊断包那边再长一份。
pub(crate) fn harness_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home)
}

/// 数据根目录（读进程 env）。`budget` / `state` / R2a store 共用，不许再长一份
/// 「选哪个根」的逻辑。
pub fn data_home() -> PathBuf {
    data_home_from(&|name| std::env::var(name).ok(), harness_dir())
}

/// 快照目录（读进程 env）。
pub fn snapshot_dir() -> PathBuf {
    snapshot_dir_from(&|name| std::env::var(name).ok(), harness_dir())
}

/// `<DSH_HOME>` 根：`DSH_HOME` env → `~/.dsh` 缺省（与 `integrations/dsh-client/src/harness/
/// index.ts::sessionsRoot()` 同默认）。`DSH_HOME` 未设且 `HOME` 也未知 → `None`。
/// `codex_home()`：rollout 根的解析与 CLI `codex-cost` handler 同一条
/// （`HOME` → `USERPROFILE` → 空串；空串 join 出的相对路径不存在 → 枚举为
/// 空 → Unavailable，绝不报错）。pub：src-tauri 的 `data_codex_quota`/
/// `read_calendar_month` 复用同一条解析（审查 #4——此前 lib.rs 各自手写
/// HOME-only，漏 USERPROFILE 回落，Windows 桌面端静默假 Unavailable）。
pub fn codex_home() -> std::path::PathBuf {
    std::path::PathBuf::from(
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default(),
    )
}

pub fn dsh_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("DSH_HOME") {
        return Some(PathBuf::from(h));
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".dsh"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_overrides_win_everywhere() {
        let home = PathBuf::from("/home/tester");
        let get_env = |name: &str| match name {
            "AGENT_VITALS_HOME" => Some("/state/current".to_string()),
            "SKILL_VITALS_HOME" => Some("/state/legacy".to_string()),
            "AGENT_VITALS_SNAPSHOT_DIR" => Some("/snaps/current".to_string()),
            "SKILL_VITALS_SNAPSHOT_DIR" => Some("/snaps/legacy".to_string()),
            _ => None,
        };
        assert_eq!(data_home_from(&get_env, home.clone()), PathBuf::from("/state/current"));
        assert_eq!(snapshot_dir_from(&get_env, home), PathBuf::from("/snaps/current"));
    }

    #[test]
    fn legacy_overrides_remain_supported() {
        let home = PathBuf::from("/home/tester");
        let get_env = |name: &str| match name {
            "SKILL_VITALS_HOME" => Some("/state/legacy".to_string()),
            "SKILL_VITALS_SNAPSHOT_DIR" => Some("/snaps/legacy".to_string()),
            _ => None,
        };
        assert_eq!(data_home_from(&get_env, home.clone()), PathBuf::from("/state/legacy"));
        assert_eq!(snapshot_dir_from(&get_env, home), PathBuf::from("/snaps/legacy"));
    }

    #[test]
    fn fresh_default_uses_agent_vitals_home() {
        let home = std::env::temp_dir().join("agent-vitals-home-no-defaults");
        let get_env = |_name: &str| None;
        assert_eq!(data_home_from(&get_env, home.clone()), home.join(".agent-vitals"));
        assert_eq!(
            snapshot_dir_from(&get_env, home.clone()),
            home.join(".agent-vitals").join("snapshots")
        );
    }

    #[test]
    fn only_existing_legacy_directory_is_preserved() {
        let home = std::env::temp_dir().join("agent-vitals-home-legacy-only");
        let _ = std::fs::create_dir_all(home.join(".skill-vitals"));
        let get_env = |_name: &str| None;
        assert_eq!(data_home_from(&get_env, home.clone()), home.join(".skill-vitals"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn current_directory_wins_when_both_defaults_exist() {
        let home = std::env::temp_dir().join("agent-vitals-home-both");
        let _ = std::fs::create_dir_all(home.join(".agent-vitals"));
        let _ = std::fs::create_dir_all(home.join(".skill-vitals"));
        let get_env = |_name: &str| None;
        assert_eq!(data_home_from(&get_env, home.clone()), home.join(".agent-vitals"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
