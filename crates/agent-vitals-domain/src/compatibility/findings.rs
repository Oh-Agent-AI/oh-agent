//! §14.3 输出桥——`vitals_core::report::AuditReport` → 现有 12 键 legacy
//! finding JSON。
//!
//! # 排序：走 `report.outcomes` 里每条 `RuleOutcome::Findings` 自己的顺序，
//! # 不走 `replay.frames`
//!
//! 第一版走的是 `replay.frames`（按 `(ordinal, id)` 排好序，逐帧读
//! `findings_opened`）——这个决定原先记的理由是"对 SV601 这种一个 evidence
//! 事件对一条 Finding 的规则，frame 顺序正好等于旧 `__ord` 顺序"，这对
//! family①（`behavior.rs::flatten()`）是对的，但**只是巧合**：`flatten()`
//! 自己会在拿到 findings 之后再按 `__ord` 重新排一遍序，所以不管这里给出什
//! 么顺序，family① 最终看到的都是"时间顺序"，走 frame 顺序自然对得上。
//!
//! family④（`trajectory.rs::flatten_trajectory()`）**不做**这次重排——它
//! 原样透传 detect 函数的 push 顺序。SV613 这类"一个 Detector 内部有多个独
//! 立子扫描"的规则（先扫完全部 error-turn、再扫全部 tool-failure）push 顺
//! 序不是时间顺序：如果一次会话里 tool-failure 的锚点事件在时间上早于
//! error-turn 的锚点事件，旧路径仍然按"error-turn 组先、tool-failure 组
//! 后"的固定顺序输出，走 frame（时间序）会把顺序反过来——这是发布前 Python/
//! Rust 全量矩阵测试抓到的真实回归（6 个 SV613 组合命中用例失败），专项
//! parity 测试测的是"两个子判定分别触发"，从没测过"两个子判定在同一份输入
//! 里都触发、且触发顺序与时间顺序相反"，所以没抓到。
//!
//! 修法：不猜"该按什么顺序重排"，直接不重排——用
//! `report.outcomes[i].outcome` 里 `Findings(Vec<Finding>)` 自身的顺序，那
//! 就是 Detector 调用 `push` 的原始顺序，逐字节等价于旧
//! `detect_svNNN_legacy` 会返回的顺序。“该不该再排一次序”这个决定完全交回
//! 给各自的 `flatten`/`flatten_trajectory`——它们本来就知道自己那个 family
//! 的语义，兼容投影不该替它们做这个决定（§10.2 的
//! `vitals.source_ordinal` 保留键因此依然没用上：这次真正需要的不是"按什
//! 么排序"，是"根本不排序"）。

use serde_json::{json, Value};
use vitals_core::detector::RuleOutcome;
use vitals_core::error::VitalsError;
use vitals_core::finding::Finding;
use vitals_core::report::AuditReport;

use super::CompatibilityError;

/// §14.3：把一次 `finalize` 的权威结果投影回现有 12 键 finding 形状。
/// "无法无损映射的字段不得猜测"——`rule`/`category`/`tool_name` 等 legacy
/// 专属字段不在 `vitals_core::Finding` 里，约定由产出该 Finding 的 Detector
/// 写进 `attributes`（见 `crate::detectors::sv601::Sv601Detector`），这里只
/// 负责原样取出，取不到就是 `null`，不猜。
pub fn vitals_report_to_legacy_findings(report: &AuditReport) -> Result<Vec<Value>, CompatibilityError> {
    let mut out = Vec::new();
    for named_outcome in &report.outcomes {
        if let RuleOutcome::Findings(findings) = &named_outcome.outcome {
            for finding in findings {
                out.push(legacy_finding_json(finding)?);
            }
        }
    }
    Ok(out)
}

fn legacy_finding_json(finding: &Finding) -> Result<Value, CompatibilityError> {
    let attrs = finding.attributes.as_object().ok_or_else(|| {
        CompatibilityError::from(VitalsError::Serialization {
            reason: "finding attributes must be a JSON object to project to legacy shape".to_string(),
        })
    })?;
    let get = |key: &str| attrs.get(key).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "rule": get("rule"),
        "severity": get("severity"),
        "category": get("category"),
        "tool_name": get("tool_name"),
        "evidence": get("evidence"),
        "seq": get("seq"),
        "time": get("time"),
        "turn": get("turn"),
        "step": get("step"),
        "call_id": get("call_id"),
        "evidence_recency": get("evidence_recency"),
        "run_end_seq": get("run_end_seq"),
    }))
}
