//! DSH 行为审计的 runtime 薄封装。
//!
//! W3（2026-09-24）：本体搬到 `agent_vitals_harnesses::harnesses::dsh::sources::behavior`
//! （读会话日志 + 喂规则，属执行环境适配层）。本体不读 data_home；这里负责加载「内置价卡
//! + 用户覆盖」（`price_overrides::merged_main`）后传进去，并保留旧路径。

use std::path::Path;

use serde_json::Value;

pub use agent_vitals_harnesses::harnesses::dsh::sources::behavior::*;

/// `behavior --json` 的 20 键载荷，价卡取当前 data_home 下的「内置 + 用户覆盖」。
pub fn audit_payload(path: &Path) -> Option<Value> {
    let pricing = crate::price_overrides::merged_main(&crate::home::data_home());
    agent_vitals_harnesses::harnesses::dsh::sources::behavior::audit_payload(path, &pricing)
}
