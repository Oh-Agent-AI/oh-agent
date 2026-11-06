//! 进程内同步引擎：跑一轮同步（W3 第 2 步）。
//!
//! 此前桌面每个 tick 顺序 spawn 最多四个 CLI 子进程（`discover` → `oneline` →
//! `claude-sync` → `sync-facts`），每个都冷启动、重开权威库；其中三个是 v0.9.1 之前
//! JSON 数据面的遗留，产物已无读取方（W3 第 3 步移除，见 CLAUDE.md 同名节）。剩下的
//! `sync-facts` 只是 `sync_service::sync_facts_filtered` 的 CLI 外壳——桌面本就链接
//! runtime，这里直接进程内调用，并补上子进程天然有、进程内要自己给的两样东西：
//! 暂停开关的判定、panic 隔离（一轮同步出错不能把 tick 线程带走）。
//!
//! CLI `sync-facts` 仍是同一个函数的另一个外壳，两边不会各自长一份流程。

use std::collections::BTreeSet;
use std::path::Path;

use super::sync_service::{sync_facts_filtered, SyncReport};

/// 一轮同步的结果。
#[derive(Debug)]
pub enum SyncRun {
    /// 用户暂停了本机解析（`sync_control`）：什么都没跑。
    Paused,
    /// 暂停开关本身读不了：不猜，不跑。
    ControlUnreadable(String),
    /// 同步跑完（执行环境级读失败在 `report.harnesses[].errors` 里，不算整轮失败——与 CLI
    /// 退出码 0 的语义一致）。
    Completed(SyncReport),
    /// 整轮失败（权威库打不开、锁拿不到、或 panic）。
    Failed(String),
}

/// 跑一轮同步。`harnesses` 为定向同步的执行环境集合；`None` 或空集合 = 全执行环境（空集合
/// 按全执行环境处理，与 CLI `--harnesses ""` 的守卫一致——否则就是一轮什么都不做的同步）。
pub fn run_sync(data_home: &Path, harnesses: Option<&BTreeSet<String>>) -> SyncRun {
    match super::sync_control::is_paused(data_home) {
        Ok(true) => return SyncRun::Paused,
        Ok(false) => {}
        Err(error) => return SyncRun::ControlUnreadable(error),
    }
    let only = harnesses.filter(|set| !set.is_empty());
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sync_facts_filtered(data_home, only))) {
        Ok(Ok(report)) => SyncRun::Completed(report),
        Ok(Err(error)) => SyncRun::Failed(error),
        Err(panic) => {
            let message = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            crate::core::logging::log_warn("sync", &format!("sync panicked: {message}"));
            SyncRun::Failed(format!("同步崩溃：{message}"))
        }
    }
}

/// 同步报告的一行人话摘要（托盘 / 工作台状态面用）。执行环境级错误如实计数，不吞。
pub fn summarize(report: &SyncReport) -> String {
    let errors: usize = report.harnesses.iter().filter(|h| !h.harness.starts_with("harness:")).map(|h| h.errors.len()).sum();
    let dynamic_errors: usize = report.harnesses.iter().filter(|h| h.harness.starts_with("harness:")).map(|h| h.errors.len()).sum();
    let mut text = format!("新增 {} 条", report.total_appended);
    if dynamic_errors > 0 {
        text.push_str(&format!("，{dynamic_errors} 个动态 harness 接入失败"));
    }
    if errors > 0 {
        text.push_str(&format!("，{errors} 个文件读取失败（下轮重试）"));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("av-engine-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn paused_runs_nothing() {
        let home = tmp("paused");
        super::super::sync_control::set_paused(&home, true).unwrap();
        assert!(matches!(run_sync(&home, None), SyncRun::Paused));
        assert!(
            !agent_vitals_data::authority::default_authority_path(&home).exists(),
            "暂停时不得碰权威库"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn summary_counts_file_errors_honestly() {
        let mut report = SyncReport { total_appended: 3, ..Default::default() };
        assert_eq!(summarize(&report), "新增 3 条");
        report.harnesses.push(super::super::sync_service::HarnessSyncReport {
            harness: "codex".into(),
            errors: vec!["a".into(), "b".into()],
            ..Default::default()
        });
        assert_eq!(summarize(&report), "新增 3 条，2 个文件读取失败（下轮重试）");
    }

    #[test]
    fn summary_distinguishes_dynamic_manifest_failures_from_file_errors() {
        let mut report = SyncReport::default();
        report.harnesses.push(super::super::sync_service::HarnessSyncReport {
            harness: "harness:zcode".into(), errors: vec!["manifest parse failed".into()], ..Default::default()
        });
        assert_eq!(summarize(&report), "新增 0 条，1 个动态 harness 接入失败");
    }
}
