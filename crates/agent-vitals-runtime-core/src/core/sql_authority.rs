//! v0.9.1 Phase 4.2（spec §6.1 状态机「freeze legacy writes」/ §6.3 切换门槛）：
//! `sql_authority_enabled` 标记。
//!
//! 语义：标记**存在** ⟺ SQL 权威库是运行时唯一权威、旧 state JSON 写入已冻结。
//! - `oneline`/`fold_session` 的 `merge_today`/`merge_month`/`write_alert` 跳过；
//! - `claude-sync` 的 `claude-ledger.json` / `-archive.json` 写入跳过；
//! - `oneline.json` / `sessions.jsonl` / `claude-fold.json`（checkpoint / 导航
//!   快照，非 §5.2 业务读源）照常写。
//!
//! 标记落 `<data_home>/.sql-authority-enabled`（JSON：`{enabled_at, note,
//! reconcile}`）。**不删旧文件**（spec §6.1：备份确认窗口内旧文件保留）——
//! 只是不再更新它们。`disable` 删标记即回退到双写。
//!
//! 门槛（Phase 4.3 起）：没有 legacy 第二实现可对账——`data authority enable`
//! 改成检查**权威库自身健康**：可打开 + `PRAGMA integrity_check = ok` + 有
//! 事实行 + 最近一次 sync run `succeeded`（`--force` 越过）。空/损坏/从没同步
//! 的库不许翻开关——翻了 = 旧 JSON 冻结 + 权威库空 = 静默零花销。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

fn marker_path(data_home: &Path) -> PathBuf {
    data_home.join(".sql-authority-enabled")
}

/// SQL 权威库是否已成为唯一权威（旧 state JSON 写入冻结）。
pub fn is_enabled(data_home: &Path) -> bool {
    marker_path(data_home).is_file()
}

/// 进程默认 data_home 版（写入方调用点用——不参数化）。
pub fn is_enabled_default() -> bool {
    is_enabled(&crate::home::data_home())
}

/// 设标记。`detail` 原样写进标记文件（调用方放 reconcile 摘要 + note）。
pub fn enable(data_home: &Path, detail: Value) -> Result<(), String> {
    let payload = json!({
        "enabled_at": crate::state::now_iso_utc(),
        "detail": detail,
        "note": "SQL 权威库是运行时唯一权威；旧 state JSON 写入已冻结（spec §6.1/§6.3）。旧文件保留，不再更新。",
    });
    crate::state::atomic_write_json(&marker_path(data_home), &payload);
    Ok(())
}

/// 删标记 → 回退到双写。
pub fn disable(data_home: &Path) -> Result<(), String> {
    let p = marker_path(data_home);
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", p.display())),
    }
}

pub fn status(data_home: &Path) -> Value {
    let enabled = is_enabled(data_home);
    let marker = if enabled {
        crate::state::read_json(&marker_path(data_home))
    } else {
        None
    };
    json!({
        "sql_authority_enabled": enabled,
        "marker": marker,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enable_disable_roundtrip() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("av-sqlauth-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert!(!is_enabled(&dir), "初始未启用");
        enable(&dir, json!({"reconcile": "ok"})).unwrap();
        assert!(is_enabled(&dir), "enable 后启用");
        let st = status(&dir);
        assert_eq!(st["sql_authority_enabled"], json!(true));
        assert_eq!(st["marker"]["detail"]["reconcile"], "ok");
        assert!(st["marker"]["enabled_at"].is_string());

        disable(&dir).unwrap();
        assert!(!is_enabled(&dir), "disable 后回退");
        disable(&dir).unwrap(); // 幂等
        let _ = std::fs::remove_dir_all(&dir);
    }
}
