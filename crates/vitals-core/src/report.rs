//! §12.4 AuditReport——Engine 一次 `finalize` 的权威产出。

use serde::{Deserialize, Serialize};

use crate::diagnostic::Diagnostic;
use crate::finding::Finding;
use crate::replay::{InputFingerprint, NamedRuleOutcome, ReplayReport};
use crate::trajectory::Trajectory;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuditReport {
    pub schema_version: u16,
    pub engine_version: String,
    pub input_fingerprint: InputFingerprint,
    /// `id ASC`（§12.4）。
    pub trajectories: Vec<Trajectory>,
    /// `detector_id ASC`，同 detector 多条 trajectory 再按 `trajectory_id
    /// ASC` 消歧（§12.4 只写了 `detector_id ASC`；这是唯一能让"同一个
    /// detector 在多条 trajectory 上跑"仍然确定性排序的补充键，spec 没有
    /// 明确写但没有它无法满足 §4.5）。
    pub outcomes: Vec<NamedRuleOutcome>,
    /// `severity rank、trajectory ID、fingerprint`（§12.4）。
    pub findings: Vec<Finding>,
    pub replay: ReplayReport,
    /// `event ordinal、code`（§12.4）；没有 `event_id` 的 diagnostic 排在
    /// 有 ordinal 的后面（用 `u64::MAX` 占位，见 `engine.rs`）。
    pub diagnostics: Vec<Diagnostic>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_fingerprint() -> InputFingerprint {
        InputFingerprint {
            events_hash: "a".to_string(),
            config_hash: "b".to_string(),
            detector_versions_hash: "c".to_string(),
            assigner_id: "by_source_session".to_string(),
            signal_vocabulary_hash: "d".to_string(),
            engine_version: "0.5.0".to_string(),
        }
    }

    #[test]
    fn round_trips_through_json() {
        let report = AuditReport {
            schema_version: 1,
            engine_version: "0.5.0".to_string(),
            input_fingerprint: empty_fingerprint(),
            trajectories: vec![],
            outcomes: vec![],
            findings: vec![],
            replay: ReplayReport {
                schema_version: 1,
                engine_version: "0.5.0".to_string(),
                detector_versions: vec![],
                input_fingerprint: empty_fingerprint(),
                frames: vec![],
                outcomes: vec![],
                findings: vec![],
                diagnostics: vec![],
            },
            diagnostics: vec![],
        };
        let json = serde_json::to_value(&report).unwrap();
        let back: AuditReport = serde_json::from_value(json).unwrap();
        assert_eq!(back, report);
    }
}
