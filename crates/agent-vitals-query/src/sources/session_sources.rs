//! Session surface 的输入边界。
//!
//! 本模块负责定位、读取执行环境 Session 证据；静态 Skill scanner 只接收已经读取的
//! 数据，不直接扫描 Session 日志。后续拆出 `agent-vitals-runtime` 时，这里就是
//! 可机械迁移的 source/service 接线点。

use serde_json::Value;

/// 读取用于 Skill 关联分析的 DSH Session 证据。
///
/// 返回值保持既有语义：未配置来源时两项均为 `None`；解析和降级策略仍由 DSH
/// source 持有。本函数只建立明确的 surface 边界，不改变证据内容。
pub fn read_dsh_skill_correlation() -> (Option<String>, Option<Value>) {
    agent_vitals_harnesses::dsh_sources::read_session_evidence()
}
