//! Codex 计价的 runtime 薄封装。
//!
//! W3（2026-09-24）：计价与人读渲染本体搬到 `agent_vitals_harnesses::harnesses::codex::sources::cost`
//! ——它解释的是 Codex 的折叠形状与价卡，属执行环境适配层。本体不读时钟、不读系统时区；
//! 这里只做两件事：保留 `agent_vitals_runtime::sessions::codex_cost::*` 旧路径，
//! 并为 `render_codex_cost` 供给「统计时区下的今天」与时区（额度重置时间的人读文本）。

use serde_json::Value;

pub use agent_vitals_harnesses::harnesses::codex::sources::cost::{codex_cost_report, load_codex_pricing};
pub use crate::clock::{current_month_beijing, today_beijing};

pub fn render_codex_cost(out: &Value) -> String {
    agent_vitals_harnesses::harnesses::codex::sources::cost::render_codex_cost(
        out,
        &today_beijing(),
        &crate::clock::statistics_timezone(),
    )
}
